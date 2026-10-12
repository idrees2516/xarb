//! Window lifecycle: rollover → settle → discover → resubscribe → strike.
//!
//! All cold-path work: runs on tokio tasks. Window hot cells (strike/end/gen)
//! are written LAST-gen so the FV thread picks up rollovers lock-free.

use crate::state::*;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use xarb_core::now_ms;

/// Cold state owned (writes) by the cold task; manage tasks take the lock.
pub struct ColdState {
    pub window: Window,
    pub stats: Stats,
    pub signals: Vec<SignalLog>,
    pub trades: Vec<Trade>,
    pub chart: Vec<ChartPoint>,
    /// v0.4: live delta-hedge position for the open trade (None when flat
       /// / no position). Single-position risk gate keeps this unambiguous.
    pub hedge: Option<crate::hedger::HedgePos>,
}

impl Default for ColdState {
    fn default() -> Self {
        ColdState {
            window: Window::empty(0),
            stats: Stats { day_start: local_midnight(), ..Stats::default() },
            signals: Vec::new(),
            trades: Vec::new(),
            chart: Vec::new(),
            hedge: None,
        }
    }
}

pub type SharedCold = Arc<Mutex<ColdState>>;

/// Set the hot window cells (strike f64-bits, end-ms, gen-bumped-LAST).
pub fn publish_window(hot: &Arc<crate::hotcore::HotShared>, strike: f64, end_ms: u64) {
    hot.win_strike.store(strike.to_bits(), Ordering::Release);
    hot.win_end_ms.store(end_ms, Ordering::Release);
    hot.win_gen.fetch_add(1, Ordering::Release);
}

/// Settle OPEN trades of the closing window (UP wins on final ≥ strike;
/// DOWN wins on final < strike — symmetric payoff) and fold the Binance
/// delta-hedge P&L into the combined trade result. If the hedge is still
/// open at settlement (live order in flight), a reduce-only flatten is
/// issued and the trade row is finalized when the fill lands.
pub async fn settle_window(eng: &Arc<crate::Engine>) {
    let end_epoch = { eng.cold.lock().unwrap().window.end_epoch };
    let full = eng.hot.full.load_full();
    let final_price = full.price;
    if final_price <= 0.0 {
        println!("[settle] no final price — skipping settlement");
        return;
    }

    let mut settled_msgs = Vec::new();
    let mut pnls: Vec<f64> = Vec::new();
    {
        let mut cold = eng.cold.lock().unwrap();
        let ColdState { stats, trades, hedge, .. } = &mut *cold;
        for t in trades.iter_mut() {
            if t.status != "OPEN" || t.window_end != end_epoch {
                continue;
            }
            let won = if t.side == SIDE_DOWN {
                final_price < t.strike
            } else {
                final_price >= t.strike
            };
            t.status = if won { "WON" } else { "LOST" };
            t.final_price = Some(final_price);
            t.exit_reason = "settlement".into();
            let binary_pnl = if won {
                t.shares - t.cost_usd - t.fee_usd
            } else {
                -t.cost_usd - t.fee_usd
            };
            // fold the hedge mark into the combined result (paper: already
            // flat — force-flatten at τ≤3s guarantees it; live: mark now,
            // finalize on the late flatten fill)
            if let Some(h) = hedge.as_ref() {
                if h.trade_id == t.id {
                    t.hedge_qty_btc = h.qty_btc;
                    t.hedge_pnl_usd = h.pnl_at(final_price);
                    t.hedge_fees_usd = h.fees;
                    stats.hedge_fees_usd += h.fees;
                }
            }
            let pnl = binary_pnl + t.hedge_pnl_usd;
            t.pnl_usd = Some(pnl);
            println!(
                "[settle] {} {} {} final={} strike={} binary={:+.2} hedge={:+.2} net={:+.2}",
                t.id,
                side_str(t.side),
                t.status,
                final_price,
                t.strike,
                binary_pnl,
                t.hedge_pnl_usd,
                pnl
            );
            stats.pnl_realized += pnl;
            if won {
                stats.wins += 1;
            } else {
                stats.losses += 1;
            }
            pnls.push(pnl);
            settled_msgs.push(t.to_json());
        }
    }    // risk bookkeeping (atomics — outside the cold lock)
    for pnl in pnls {
        eng.risk
            .daily_pnl_c
            .fetch_add((pnl * 100.0).round() as i64, Ordering::Relaxed);
        eng.risk.open_trades.fetch_sub(1, Ordering::Relaxed);
    }
    // late live flatten: if a hedge is still open for a settled trade,
    // issue a reduce-only flatten now; the fill callback finalizes the row
    if let Some(h) = eng.cold.lock().unwrap().hedge.clone() {
        if !h.is_flat() {
            let eng2 = eng.clone();
            tokio::spawn(async move {
                crate::cold::force_flatten_hedge(&eng2, h.trade_id.clone()).await;
            });
        }
    }
    // daily-loss kill switch
    {
        let max_loss = eng.settings.load_full().max_daily_loss_usd;
        if eng.risk.daily_pnl_usd() <= -max_loss
            && !eng.risk.kill.load(Ordering::Relaxed)
        {
            eng.risk.kill.store(true, Ordering::Relaxed);
            println!(
                "[risk] KILL SWITCH — daily P&L {:.2} ≤ −{max_loss:.2}; fires disabled",
                eng.risk.daily_pnl_usd()
            );
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
/// Publishes the hot window cells the moment the strike is known so the FV
/// engine can start pricing the new window immediately.
pub async fn manage_window(eng: Arc<crate::Engine>, epoch: u64) {
    // close the old window in the hot cells right away (strike 0 → no fire)
    {
        let mut cold = eng.cold.lock().unwrap();
        cold.window = Window::empty(epoch);
    }
    publish_window(&eng.hot, 0.0, (epoch + 300) * 1000);

    // wait for the first Binance price so the strike sample is valid
    let mut strike = eng.hot.full.load_full().price;
    for _ in 0..600 {
        if strike > 0.0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        strike = eng.hot.full.load_full().price;
    }

    // superseded while waiting?
    {
        let w = eng.cold.lock().unwrap();
        if w.window.start_epoch > epoch {
            return;
        }
    }

    // publish strike → FV engine goes live on the new window
    if strike > 0.0 {
        let mut cold = eng.cold.lock().unwrap();
        cold.window.strike = Some(strike);
        cold.window.strike_estimated = true;
    }
    publish_window(&eng.hot, strike.max(0.0), (epoch + 300) * 1000);

    // discover tokens with retries
    for attempt in 0..12 {
        {
            let w = eng.cold.lock().unwrap();
            if w.window.start_epoch != epoch {
                return;
            }
        }
        match xarb_poly::gamma::discover_window(&eng.http, epoch).await {
            Ok(Some(ev)) => {
                {
                    let mut w = eng.cold.lock().unwrap();
                    if w.window.start_epoch != epoch {
                        return;
                    }
                    w.window.up_token_id = ev.up_token_id.clone();
                    w.window.down_token_id = ev.down_token_id.clone();
                    w.window.condition_id = ev.condition_id;
                    w.window.question = ev.question;
                    w.window.accepting = ev.accepting;
                    w.window.tokens_loaded = true;
                }
                // executor token plumbing + PM socket roll
                crate::executor::set_tokens(&ev.up_token_id, &ev.down_token_id);
                let _ = eng
                    .token_tx
                    .send(Some((ev.up_token_id.clone(), ev.down_token_id.clone())));
                println!("[engine] window loaded: btc-updown-5m-{epoch} strike={strike}");
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

/// Cold-tick housekeeping: rollover detection + chart point.
pub async fn cold_tick(eng: &Arc<crate::Engine>) {
    let now = now_ms();

    // window rollover
    {
        let end_epoch = { eng.cold.lock().unwrap().window.end_epoch };
        if end_epoch > 0 && now >= end_epoch * 1000 + 200 {
            settle_window(eng).await;
            eng.risk.reset_window((end_epoch + 300) * 1000);
            let eng2 = eng.clone();
            tokio::spawn(async move {
                manage_window(eng2, end_epoch).await;
            });
        }
    }

    // chart point (250ms cadence)
    {
        let strike_loaded = {
            let w = eng.cold.lock().unwrap();
            w.window.strike_loaded()
        };
        if strike_loaded {
            let mut cold = eng.cold.lock().unwrap();
            let last_t = cold.chart.last().map(|p| p.t).unwrap_or(0);
            if now - last_t >= CHART_PUSH_MS {
                // carry-forward values for absent PM quotes (immutable read
                // BEFORE the mutable push)
                let (prev_pm_ask, prev_pm_bid, prev_edge, prev_ask_dn, prev_edge_dn) =
                    match cold.chart.last() {
                        Some(p) => (p.pm_ask, p.pm_bid, p.edge, p.pm_ask_down, p.edge_down),
                        None => (0.0, 0.0, 0.0, 0.0, 0.0),
                    };
                let full = eng.hot.full.load_full();
                let pm = eng.pm.snap.load_full();
                if full.price > 0.0 {
                    let fv = full.fv_up;
                    let pm_ask = pm.up.ask;
                    let pm_bid = pm.up.bid;
                    let pm_ask_dn = pm.down.ask;
                    cold.chart.push(ChartPoint {
                        t: now,
                        price: full.price,
                        bid: full.bid,
                        ask: full.ask,
                        fv,
                        pm_ask: pm_ask.unwrap_or(prev_pm_ask),
                        pm_bid: pm_bid.unwrap_or(prev_pm_bid),
                        edge: pm_ask.map(|a| fv - a).unwrap_or(prev_edge),
                        fv_down: full.fv_down,
                        pm_ask_down: pm_ask_dn.unwrap_or(prev_ask_dn),
                        edge_down: pm_ask_dn
                            .map(|a| full.fv_down - a)
                            .unwrap_or(prev_edge_dn),
                    });
                    if cold.chart.len() > CHART_CAP {
                        cold.chart.remove(0);
                    }
                }
            }
        }
    }

    // day rollover for counters
    {
        let mut cold = eng.cold.lock().unwrap();
        if now.saturating_sub(cold.stats.day_start) > 86_400_000 {
            cold.stats.day_start = local_midnight();
            cold.stats.triggers_today = 0;
            cold.stats.watches_today = 0;
            eng.risk.kill.store(false, Ordering::Relaxed);
            eng.risk.daily_pnl_c.store(0, Ordering::Relaxed);
            println!("[engine] day rollover — counters + kill-switch reset");
        }
    }
}

impl Window {
    pub fn strike_loaded(&self) -> bool {
        self.strike.map(|k| k > 0.0).unwrap_or(false)
    }
}
