//! Signal firing: guards → paper fill (book-walking) or live CLOB order.

use crate::hotpath::{next_id, push_signal};
use crate::state::*;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use xarb_core::{now_ms, Level};

#[allow(clippy::too_many_arguments)]
pub fn try_fire(
    eng: &Arc<crate::Engine>,
    fv: f64,
    jump: f64,
    ask_c: f64,
    edge_c: f64,
    t_sec: f64,
    ladder: &[Level],
    slug: String,
    tokens_loaded: bool,
    window_end: u64,
    auto_trade: bool,
    min_secs_left: f64,
    max_trades: u32,
    fee_bps: f64,
    strike: f64,
) {
    let now = now_ms();

    if !auto_trade {
        skip(eng, "auto-trade off", fv, jump, edge_c, t_sec);
        return;
    }
    if t_sec < min_secs_left {
        skip(
            eng,
            &format!("too close to close ({}s left)", t_sec.max(0.0) as u64),
            fv,
            jump,
            edge_c,
            t_sec,
        );
        return;
    }
    if now - eng.last_signal_ts.load(Ordering::Relaxed) < crate::SIGNAL_COOLDOWN_MS {
        return;
    }
    {
        let trades = eng.trades.lock().unwrap();
        let window_trades: Vec<&Trade> = trades.iter().filter(|t| t.window_end == window_end).collect();
        if window_trades.len() as u32 >= max_trades {
            drop(trades);
            skip(eng, "max trades for window", fv, jump, edge_c, t_sec);
            return;
        }
        if window_trades.iter().any(|t| t.status == "OPEN") {
            drop(trades);
            skip(eng, "position already open", fv, jump, edge_c, t_sec);
            return;
        }
    }
    if !tokens_loaded || slug.is_empty() {
        skip(eng, "window book not loaded", fv, jump, edge_c, t_sec);
        return;
    }
    if ladder.is_empty() {
        skip(eng, "no asks on book", fv, jump, edge_c, t_sec);
        return;
    }

    // live mode → signed EIP-712 order (async, off the hot path)
    if eng.cfg.mode == "live" {
        fire_live(eng, fv, jump, ask_c, edge_c, t_sec, window_end, strike, ladder, fee_bps);
        return;
    }

    // paper mode → walk the live ask ladder
    let stake = eng.settings.lock().unwrap().stake_usd;
    let depth_usd: f64 = ladder.iter().map(|l| l.p * l.s).sum();
    if depth_usd < stake * 0.4 {
        skip(
            eng,
            &format!("thin book (${:.0} depth)", depth_usd),
            fv,
            jump,
            edge_c,
            t_sec,
        );
        return;
    }

    let mut cost = 0.0;
    let mut shares = 0.0;
    for lvl in ladder {
        if cost >= stake {
            break;
        }
        let lvl_usd = lvl.p * lvl.s;
        let take = lvl_usd.min(stake - cost);
        shares += take / lvl.p;
        cost += take;
    }
    if shares <= 0.0 {
        skip(eng, "empty fill", fv, jump, edge_c, t_sec);
        return;
    }
    let avg_c = (cost / shares) * 100.0;
    let fee = cost * fee_bps / 10_000.0;

    let sig_id = next_id(eng, 'S');
    let signal = SignalLog {
        id: sig_id.clone(),
        ts: now,
        window_end,
        fv,
        ask: Some(ask_c),
        edge: Some(edge_c),
        jump5s: jump,
        seconds_left: t_sec,
        action: "EXECUTED",
        reason: format!(
            "edge {}¢ · filled {} sh @ {}¢ [paper]",
            round1(edge_c),
            shares.round(),
            round1(avg_c)
        ),
        fill_price: Some(avg_c),
        shares: Some(round2(shares)),
        stake: Some(round2(stake)),
    };
    let trade = Trade {
        id: format!("T{}", &sig_id[1..]),
        signal_id: sig_id,
        ts: now,
        window_end,
        strike,
        price_c: avg_c,
        shares,
        cost_usd: cost,
        fee_usd: fee,
        status: "OPEN",
        pnl_usd: None,
        final_price: None,
        fv_at_entry: fv,
        edge_at_entry: edge_c,
    };
    eng.last_signal_ts.store(now, Ordering::Relaxed);
    {
        let mut trades = eng.trades.lock().unwrap();
        trades.insert(0, trade);
        trades.truncate(200);
        let mut stats = eng.stats.lock().unwrap();
        stats.trades += 1;
        stats.staked_usd += cost;
        stats.edge_sum += edge_c;
        stats.edge_n += 1;
        stats.triggers_today += 1;
    }
    println!(
        "[SIGNAL] {} fv={}¢ ask={}¢ edge={}¢ jump={}¢ fill={}¢ [paper]",
        signal.id,
        round1(fv),
        round1(ask_c),
        round1(edge_c),
        round1(jump),
        round1(avg_c)
    );
    push_signal(eng, signal);
}

/// Live route: build + sign + POST the EIP-712 order on a detached task.
fn fire_live(
    eng: &Arc<crate::Engine>,
    fv: f64,
    jump: f64,
    ask_c: f64,
    edge_c: f64,
    t_sec: f64,
    window_end: u64,
    strike: f64,
    ladder: &[Level],
    fee_bps: f64,
) {
    let eng = eng.clone();
    let token = {
        let w = eng.window.lock().unwrap();
        w.up_token_id.clone()
    };
    let best = ladder.first().map(|l| l.p).unwrap_or(ask_c / 100.0);
    let stake = eng.settings.lock().unwrap().stake_usd;
    let price = ((best * 100.0).round() / 100.0).max(0.01);
    let size = (stake / price * 100.0).round() / 100.0;
    let now = now_ms();

    let sig_id = next_id(&eng, 'S');
    tokio::spawn(async move {
        let clob = eng.clob.lock().await;
        let neg_risk = eng.cfg.neg_risk;
        match clob
            .post_buy_order(&token, price, size, neg_risk)
            .await
        {
            Ok((order_id, status, raw)) => {
                let cost = price * size;
                let fee = cost * fee_bps / 10_000.0;
                let signal = SignalLog {
                    id: sig_id.clone(),
                    ts: now,
                    window_end,
                    fv,
                    ask: Some(ask_c),
                    edge: Some(edge_c),
                    jump5s: jump,
                    seconds_left: t_sec,
                    action: "EXECUTED",
                    reason: format!(
                        "live order {} · {} · {} sh @ {}¢",
                        if order_id.is_empty() { "—" } else { &order_id },
                        status,
                        size,
                        round1(price * 100.0)
                    ),
                    fill_price: Some(price * 100.0),
                    shares: Some(size),
                    stake: Some(round2(cost)),
                };
                let trade = Trade {
                    id: format!("T{}", &sig_id[1..]),
                    signal_id: sig_id,
                    ts: now,
                    window_end,
                    strike,
                    price_c: price * 100.0,
                    shares: size,
                    cost_usd: cost,
                    fee_usd: fee,
                    status: "OPEN",
                    pnl_usd: None,
                    final_price: None,
                    fv_at_entry: fv,
                    edge_at_entry: edge_c,
                };
                eng.last_signal_ts.store(now, Ordering::Relaxed);
                {
                    let mut trades = eng.trades.lock().unwrap();
                    trades.insert(0, trade);
                    trades.truncate(200);
                    let mut stats = eng.stats.lock().unwrap();
                    stats.trades += 1;
                    stats.staked_usd += cost;
                    stats.edge_sum += edge_c;
                    stats.edge_n += 1;
                    stats.triggers_today += 1;
                }
                println!(
                    "[SIGNAL-LIVE] {raw} — order accepted (status {status})"
                );
                push_signal(&eng, signal);
            }
            Err(e) => {
                println!("[SIGNAL-LIVE] order FAILED: {e}");
                let signal = SignalLog {
                    id: sig_id,
                    ts: now,
                    window_end,
                    fv,
                    ask: Some(ask_c),
                    edge: Some(edge_c),
                    jump5s: jump,
                    seconds_left: t_sec,
                    action: "SKIPPED",
                    reason: format!("live order failed: {e}"),
                    fill_price: None,
                    shares: None,
                    stake: None,
                };
                push_signal(&eng, signal);
            }
        }
    });
}

fn skip(
    eng: &Arc<crate::Engine>,
    reason: &str,
    fv: f64,
    jump: f64,
    edge_c: f64,
    t_sec: f64,
) {
    let now = now_ms();
    let sig = SignalLog {
        id: next_id(eng, 'K'),
        ts: now,
        window_end: eng.window.lock().unwrap().end_epoch,
        fv,
        ask: {
            let pm = eng.pm.lock().unwrap();
            pm.book.best_ask().map(|l| l.p * 100.0)
        },
        edge: Some(edge_c),
        jump5s: jump,
        seconds_left: t_sec,
        action: "SKIPPED",
        reason: reason.to_string(),
        fill_price: None,
        shares: None,
        stake: None,
    };
    push_signal(eng, sig);
}
