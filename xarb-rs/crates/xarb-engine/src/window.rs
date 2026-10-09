//! Window lifecycle: rollover → settle → discover → resubscribe → strike.

use crate::state::*;
use std::sync::Arc;
use xarb_core::now_ms;

/// Per-tick (10Hz): window rollover, chart point, day rollover.
pub async fn tick(eng: &Arc<crate::Engine>) {
    let t0 = std::time::Instant::now();
    let now = now_ms();

    {
        let mut b = eng.bin.lock().unwrap();
        b.sample_rate();
    }

    // window rollover
    {
        let w = eng.window.lock().unwrap();
        if w.end_epoch > 0 && now >= w.end_epoch * 1000 + 200 {
            let next_epoch = w.end_epoch;
            drop(w);
            settle_window(eng);
            let eng2 = eng.clone();
            tokio::spawn(async move {
                manage_window(eng2, next_epoch).await;
            });
        }
    }

    // chart point (250ms cadence)
    {
        let w = eng.window.lock().unwrap();
        if w.strike.is_some() && w.strike.unwrap() > 0.0 {
            drop(w);
            let mut chart = eng.chart.lock().unwrap();
            let last_t = chart.last().map(|p| p.t).unwrap_or(0);
            if now - last_t >= crate::CHART_PUSH_MS {
                let (price, bid, ask) = {
                    let b = eng.bin.lock().unwrap();
                    (b.mid(), b.best_bid, b.best_ask)
                };
                if price > 0.0 {
                    let (pm_ask, pm_bid) = {
                        let pm = eng.pm.lock().unwrap();
                        (
                            pm.book.best_ask().map(|l| l.p * 100.0),
                            pm.book.best_bid().map(|l| l.p * 100.0),
                        )
                    };
                    let fv_v = *eng.last_fv.lock().unwrap();
                    let edge = pm_ask.map(|a| fv_v - a).unwrap_or(
                        chart.last().map(|p| p.edge).unwrap_or(0.0),
                    );
                    let pm_ask_c = pm_ask.unwrap_or_else(|| {
                        chart.last().map(|p| p.pm_ask).unwrap_or(0.0)
                    });
                    let pm_bid_c = pm_bid.unwrap_or_else(|| {
                        chart.last().map(|p| p.pm_bid).unwrap_or(0.0)
                    });
                    chart.push(ChartPoint {
                        t: now,
                        price,
                        bid,
                        ask,
                        fv: fv_v,
                        pm_ask: pm_ask_c,
                        pm_bid: pm_bid_c,
                        edge,
                    });
                    if chart.len() > crate::CHART_CAP {
                        chart.remove(0);
                    }
                }
            }
        }
    }

    // feed lag mirror
    {
        let lag = {
            let b = eng.bin.lock().unwrap();
            b.last_lag_ms()
        };
        if lag > 0.0 {
            eng.feed_lag.lock().unwrap().push(lag);
        }
    }

    // broadcast snapshot at 10Hz
    {
        let snap = crate::snapshot::build(eng);
        eng.emit(snap);
    }

    // day rollover for counters
    {
        let mut stats = eng.stats.lock().unwrap();
        if now.saturating_sub(stats.day_start) > 86_400_000 {
            stats.day_start = local_midnight();
            stats.triggers_today = 0;
        }
    }

    let us = t0.elapsed().as_secs_f64() * 1e6;
    eng.tick_us.lock().unwrap().push(us);
}

/// Settle OPEN trades of the closing window.
fn settle_window(eng: &Arc<crate::Engine>) {
    let end_epoch = eng.window.lock().unwrap().end_epoch;
    let final_price = {
        let b = eng.bin.lock().unwrap();
        let mid = b.mid();
        if mid > 0.0 { mid } else { b.last_price }
    };
    if final_price <= 0.0 {
        println!("[settle] no final price — skipping settlement");
        return;
    }
    let mut settled_msgs = Vec::new();
    {
        // lock order: trades → stats (same as fire.rs)
        let mut trades = eng.trades.lock().unwrap();
        let mut stats = eng.stats.lock().unwrap();
        for t in trades.iter_mut() {
            if t.status == "OPEN" && t.window_end == end_epoch {
                let won = final_price >= t.strike;
                t.status = if won { "WON" } else { "LOST" };
                t.final_price = Some(final_price);
                let pnl = if won {
                    t.shares - t.cost_usd - t.fee_usd
                } else {
                    -t.cost_usd - t.fee_usd
                };
                t.pnl_usd = Some(pnl);
                println!(
                    "[settle] {} {} final={} strike={} pnl={:.2}",
                    t.id,
                    t.status,
                    final_price,
                    t.strike,
                    pnl
                );
                stats.pnl_realized += pnl;
                if won {
                    stats.wins += 1;
                } else {
                    stats.losses += 1;
                }
                settled_msgs.push(t.to_json());
            }
        }
    }
    for m in settled_msgs {
        let mut msg = serde_json::json!({ "type": "settle" });
        if let Some(obj) = m.as_object() {
            for (k, v) in obj {
                msg[k.as_str()] = v.clone();
            }
        }
        eng.emit(msg);
    }
}

/// Load a window: wait for strike → discover tokens (retry 24s) → subscribe.
pub async fn manage_window(eng: Arc<crate::Engine>, epoch: u64) {
    // wait for the first Binance price so the strike sample is valid
    let mut strike = {
        let b = eng.bin.lock().unwrap();
        b.mid()
    };
    for _ in 0..600 {
        if strike > 0.0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        strike = {
            let b = eng.bin.lock().unwrap();
            b.mid()
        };
    }

    // superseded while waiting?
    {
        let w = eng.window.lock().unwrap();
        if w.start_epoch > epoch {
            return;
        }
    }

    {
        let mut w = eng.window.lock().unwrap();
        *w = Window::empty(epoch);
        w.strike = if strike > 0.0 { Some(strike) } else { None };
        w.strike_estimated = true;
    }
    {
        let mut ring = eng.fv_ring.lock().unwrap();
        *ring = xarb_core::FvRing::new(crate::FV_KEEP_MS);
    }

    // discover tokens with retries
    for attempt in 0..12 {
        // superseded by a newer rollover?
        {
            let w = eng.window.lock().unwrap();
            if w.start_epoch != epoch {
                return;
            }
        }
        match xarb_poly::gamma::discover_window(&eng.http, epoch).await {
            Ok(Some(ev)) => {
                let mut w = eng.window.lock().unwrap();
                if w.start_epoch != epoch {
                    return;
                }
                w.up_token_id = ev.up_token_id.clone();
                w.condition_id = ev.condition_id;
                w.question = ev.question;
                w.accepting = ev.accepting;
                w.tokens_loaded = true;
                drop(w);
                let _ = eng.token_tx.send(Some(ev.up_token_id.clone()));
                xarb_poly::clob_ws::set_rest_token(&ev.up_token_id);
                println!(
                    "[engine] window loaded: btc-updown-5m-{epoch} strike={strike}"
                );
                return;
            }
            Ok(None) => {}
            Err(e) => println!("[polymarket] discover error: {e}"),
        }
        if attempt < 11 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
    println!("[engine] window NOT found after retries: btc-updown-5m-{epoch}");
}
