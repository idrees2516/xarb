//! Snapshot construction (10Hz outbound JSON, mirrors the TS schema).

use crate::state::*;
use std::sync::Arc;
use xarb_core::{now_ms, fv, sigma_eff};

/// One-shot capture of engine state (all read locks taken sequentially).
pub struct SnapshotCtx {
    pub now: u64,
    pub running: bool,
    pub bin_status: &'static str,
    pub bin_lat: f64,
    pub bin_ticks_per_min: u64,
    pub price: f64,
    pub bid: f64,
    pub ask: f64,
    pub change5s: f64,
    pub pm_status: &'static str,
    pub pm_updates: u64,
    pub last_trade_px: Option<f64>,
    pub fee_rate_bps: Option<u64>,
    pub window: Window,
    pub fv_value: f64,
    pub jump5s: f64,
    pub vol_pts: f64,
    pub asks: Vec<xarb_core::Level>,
    pub bids: Vec<xarb_core::Level>,
    pub book_age_ms: u64,
    pub trig: xarb_core::Trig,
    pub stats: Stats,
    pub trades_open: usize,
    pub trades: Vec<Trade>,
    pub signals: Vec<SignalLog>,
    pub chart: Vec<ChartPoint>,
    pub settings: Settings,
    pub feed_p50: f64,
    pub feed_p99: f64,
    pub tick_p50: f64,
    pub tick_p99: f64,
    pub decision_p50: f64,
    pub decision_p99: f64,
}

impl SnapshotCtx {
    pub fn capture(eng: &Arc<crate::Engine>) -> SnapshotCtx {
        let now = now_ms();
        let (bin_status, price, bid, ask, change5s, bin_lat, tpm, vol) = {
            let mut b = eng.bin.lock().unwrap();
            (
                b.status.as_str(),
                b.mid(),
                b.best_bid,
                b.best_ask,
                b.change5s(),
                b.last_lag_ms(),
                b.ticks_per_min,
                b.vol_pts,
            )
        };
        let (pm_status, pm_updates, ltp, fee, asks, bids, age) = {
            let pm = eng.pm.lock().unwrap();
            (
                pm.status.as_str(),
                pm.updates,
                pm.last_trade_px,
                pm.fee_rate_bps,
                pm.book.asks_top(6),
                pm.book.bids_top(6),
                pm.book.age_ms(now),
            )
        };
        let window = eng.window.lock().unwrap().clone();
        let fv_value = *eng.last_fv.lock().unwrap();
        let jump5s = {
            let ring = eng.fv_ring.lock().unwrap();
            ring.jump5s(now)
        };
        let trig = *eng.trig.lock().unwrap();
        let (stats, trades_open) = {
            let stats = eng.stats.lock().unwrap();
            let open = eng
                .trades
                .lock()
                .unwrap()
                .iter()
                .filter(|t| t.status == "OPEN")
                .count();
            (stats.clone(), open)
        };
        let trades = eng.trades.lock().unwrap().iter().take(50).cloned().collect();
        let signals = eng.signals.lock().unwrap().iter().take(40).cloned().collect();
        let chart = {
            let c = eng.chart.lock().unwrap();
            if c.len() > 720 {
                let step = c.len() / 720;
                c.iter().enumerate().filter(|(i, _)| i % step == 0).map(|(_, p)| *p).collect()
            } else {
                c.clone()
            }
        };
        let settings = eng.settings.lock().unwrap().clone();
        let (fp50, fp99, tp50, tp99, dp50, dp99) = {
            let f = eng.feed_lag.lock().unwrap();
            let t = eng.tick_us.lock().unwrap();
            let d = eng.decision_us.lock().unwrap();
            (
                f.percentile(0.5),
                f.percentile(0.99),
                t.percentile(0.5),
                t.percentile(0.99),
                d.percentile(0.5),
                d.percentile(0.99),
            )
        };
        SnapshotCtx {
            now,
            running: eng.running.load(std::sync::atomic::Ordering::Relaxed),
            bin_status,
            bin_lat,
            bin_ticks_per_min: tpm,
            price,
            bid,
            ask,
            change5s,
            pm_status,
            pm_updates,
            last_trade_px: ltp,
            fee_rate_bps: fee,
            window,
            fv_value,
            jump5s,
            vol_pts: vol,
            asks,
            bids,
            book_age_ms: age,
            trig,
            stats,
            trades_open,
            trades,
            signals,
            chart,
            settings,
            feed_p50: fp50,
            feed_p99: fp99,
            tick_p50: tp50,
            tick_p99: tp99,
            decision_p50: dp50,
            decision_p99: dp99,
        }
    }
}

/// Build the full `snap` message.
pub fn build(eng: &Arc<crate::Engine>) -> serde_json::Value {
    let ctx = SnapshotCtx::capture(eng);
    ctx_to_json(&ctx)
}

/// Build the `init` message (snapshot + history + logs + settings + mode).
pub fn build_init(eng: &Arc<crate::Engine>) -> serde_json::Value {
    let ctx = SnapshotCtx::capture(eng);
    let mut snap = ctx_to_json(&ctx);
    let obj = snap.as_object_mut().unwrap();
    obj.insert("type".into(), serde_json::json!("init"));
    obj.insert(
        "history".into(),
        serde_json::Value::Array(ctx.chart.iter().map(chart_pt).collect()),
    );
    obj.insert(
        "signals".into(),
        serde_json::Value::Array(ctx.signals.iter().map(|s| s.to_json()).collect()),
    );
    obj.insert(
        "trades".into(),
        serde_json::Value::Array(ctx.trades.iter().map(|t| t.to_json()).collect()),
    );
    obj.insert("settings".into(), ctx.settings.to_json());
    obj.insert("mode".into(), serde_json::json!(eng.cfg.mode));
    snap
}

fn chart_pt(p: &ChartPoint) -> serde_json::Value {
    serde_json::json!({
        "t": p.t, "price": p.price, "bid": p.bid, "ask": p.ask,
        "fv": round1(p.fv), "pmAsk": round1(p.pm_ask),
        "pmBid": round1(p.pm_bid), "edge": round1(p.edge),
    })
}

fn ctx_to_json(c: &SnapshotCtx) -> serde_json::Value {
    // FV detail for the active model
    let t_sec = if c.window.end_epoch > 0 {
        ((c.window.end_epoch * 1000).saturating_sub(c.now)) as f64 / 1000.0
    } else {
        0.0
    };
    let (slope, z) = match c.window.strike {
        Some(k) if k > 0.0 && t_sec > 0.0 => {
            let out = fv(c.price, k, t_sec.max(1.0), c.vol_pts, c.settings.model);
            (out.slope, out.z)
        }
        _ => (0.19, 0.0),
    };
    let dist = c.window.strike.map(|k| c.price - k).unwrap_or(0.0);

    let ask_c = c.asks.first().map(|l| l.p);
    let bid_c = c.bids.first().map(|l| l.p);
    let edge_ask = ask_c.map(|a| round1(c.fv_value - a));
    let edge_mid = match (ask_c, bid_c) {
        (Some(a), Some(b)) => Some(round1(c.fv_value - (a + b) / 2.0)),
        _ => None,
    };

    let settled = c.stats.wins + c.stats.losses;
    let unreal = {
        let fv_now = c.fv_value;
        let mut u = 0.0;
        for t in &c.trades {
            if t.status == "OPEN" {
                u += t.shares * fv_now / 100.0 - t.cost_usd - t.fee_usd;
            }
        }
        u
    };

    let levels = |v: &[xarb_core::Level]| -> serde_json::Value {
        serde_json::Value::Array(
            v.iter()
                .map(|l| serde_json::json!({ "p": round1(l.p), "s": round1(l.s) }))
                .collect(),
        )
    };

    serde_json::json!({
        "type": "snap",
        "ts": c.now,
        "running": c.running,
        "mode": "snap-only",
        "feeds": {
            "binance": { "status": c.bin_status, "latencyMs": round1(c.bin_lat), "ticksPerMin": c.bin_ticks_per_min },
            "polymarket": { "status": c.pm_status, "updates": c.pm_updates, "lastTradePx": c.last_trade_px, "feeRateBps": c.fee_rate_bps }
        },
        "binance": { "price": c.price, "bid": c.bid, "ask": c.ask, "spread": round2(c.ask - c.bid), "change5s": round1(c.change5s) },
        "window": {
            "startEpoch": c.window.start_epoch, "endEpoch": c.window.end_epoch,
            "secondsLeft": t_sec, "strike": c.window.strike, "strikeEstimated": c.window.strike_estimated,
            "slug": c.window.slug, "question": c.window.question,
            "tokensLoaded": c.window.tokens_loaded, "accepting": c.window.accepting,
        },
        "fv": {
            "value": round1(c.fv_value), "jump5s": round1(c.jump5s), "model": c.settings.model.as_str(),
            "sigmaPts": c.vol_pts, "sigmaEffPts": sigma_eff(c.vol_pts), "z": round2(z),
            "slope": slope, "distFromStrike": dist,
        },
        "pm": {
            "bid": bid_c, "ask": ask_c,
            "askSize": c.asks.first().map(|l| l.s).unwrap_or(0.0),
            "bidSize": c.bids.first().map(|l| l.s).unwrap_or(0.0),
            "bookAgeMs": if c.book_age_ms == u64::MAX { 999999 } else { c.book_age_ms },
            "asks": levels(&c.asks), "bids": levels(&c.bids),
        },
        "edge": { "fvAsk": edge_ask, "fvMid": edge_mid },
        "triggers": { "jump": c.trig.jump, "above60": c.trig.above_floor, "gap": c.trig.gap, "all": c.trig.all() },
        "stats": {
            "pnlRealized": round2(c.stats.pnl_realized), "pnlUnrealized": round2(unreal),
            "pnlTotal": round2(c.stats.pnl_realized + unreal),
            "trades": c.stats.trades, "open": c.trades_open,
            "wins": c.stats.wins, "losses": c.stats.losses,
            "winRate": if settled > 0 { round1(c.stats.wins as f64 / settled as f64 * 100.0) } else { 0.0 },
            "avgEdgeC": if c.stats.edge_n > 0 { round1(c.stats.edge_sum / c.stats.edge_n as f64) } else { 0.0 },
            "triggersToday": c.stats.triggers_today, "stakedUsd": round2(c.stats.staked_usd),
        },
        "latency": {
            "feedP50": round1(c.feed_p50), "feedP99": round1(c.feed_p99),
            "engineUsP50": round1(c.tick_p50), "engineUsP99": round1(c.tick_p99),
            "decisionUsP50": round1(c.decision_p50), "decisionUsP99": round1(c.decision_p99),
        },
        "chart": c.chart.last().map(chart_pt).unwrap_or(serde_json::json!(null)),
    })
}
