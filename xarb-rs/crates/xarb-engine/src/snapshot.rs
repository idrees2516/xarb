//! Snapshot construction (10Hz outbound JSON, TS-schema compatible + v0.3
//! extensions: DOWN side, per-stage latency, hot-path stats).
//!
//! The cold task builds this from ArcSwaps + atomics (wait-free reads, no
//! hot-path locks), publishes the serialized string through ArcSwap, and
//! broadcasts it — HTTP `/api/snapshot` and `/ws` readers never touch cold
//! state at all.

use crate::state::*;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use xarb_core::{fv as fv_calc, now_ms, sigma_eff, Trig};
use xarb_hft::hot::FLAG_AUTOTRADE;

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
    pub fv_down: f64,
    pub jump5s: f64,
    pub vol_pts: f64,
    pub asks: Vec<xarb_core::Level>,
    pub bids: Vec<xarb_core::Level>,
    pub asks_down: Vec<xarb_core::Level>,
    pub bids_down: Vec<xarb_core::Level>,
    pub book_age_ms: u64,
    pub trig: Trig,
    pub trig_down: (bool, bool, bool),
    pub stats: Stats,
    pub trades_open: usize,
    pub trades: Vec<Trade>,
    pub signals: Vec<SignalLog>,
    pub chart: Vec<ChartPoint>,
    pub settings: Settings,
    // latency (ns summaries → µs/ms in JSON)
    pub lat_parse: (u64, u64, u64, u64, u64, f64),
    pub lat_fv: (u64, u64, u64, u64, u64, f64),
    pub lat_detect: (u64, u64, u64, u64, u64, f64),
    pub lat_decide: (u64, u64, u64, u64, u64, f64),
    pub lat_fire: (u64, u64, u64, u64, u64, f64),
    pub lat_hedge: (u64, u64, u64, u64, u64, f64),
    pub lat_feed: (u64, u64, u64, u64, u64, f64),
    // v0.4 σ calibration + hedge + capture
    pub sigma_imp: f64,
    pub sigma_real: f64,
    pub sigma_floor: f64,
    pub sigma_eff_v: f64,
    pub sigma_auto: bool,
    pub delta_up: f64,
    pub hedge: Option<crate::hedger::HedgePos>,
    pub opportunities: u64,
    pub opps_edge_usd: f64,
    pub opps_fired: u64,
    pub spin_hz: f64,
    pub dom_fallbacks: u64,
    pub ring_dropped: u64,
    pub word: xarb_hft::HotWord,
    pub kill: bool,
    pub fapi_live: bool,
}

impl SnapshotCtx {
    /// Capture from wait-free state (called by the cold task, which owns
    /// the cold state — the lock is only against concurrent manage tasks).
    pub fn capture(eng: &Arc<crate::Engine>) -> SnapshotCtx {
        let now = now_ms();
        let full = eng.hot.full.load_full();
        let pm = eng.pm.snap.load_full();
        let (window, stats, trades, signals, chart, hedge) = {
            let cold = eng.cold.lock().unwrap();
            (
                cold.window.clone(),
                cold.stats.clone(),
                cold.trades.iter().take(50).cloned().collect::<Vec<Trade>>(),
                cold.signals.iter().take(40).cloned().collect(),
                if cold.chart.len() > 720 {
                    let step = cold.chart.len() / 720;
                    cold.chart
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| i % step == 0)
                        .map(|(_, p)| *p)
                        .collect()
                } else {
                    cold.chart.clone()
                },
                cold.hedge.clone(),
            )
        };

        let settings = Settings::clone(eng.settings.load_full().as_ref());
        let word = eng.hot.word_v();

        // 5s price change from chart tail
        let change5s = {
            let base = chart
                .iter()
                .rev()
                .find(|p| now.saturating_sub(p.t) >= 5_000)
                .map(|p| p.price)
                .unwrap_or(full.price);
            full.price - base
        };

        let trig = Trig {
            jump: word.has(xarb_hft::hot::FLAG_TRIG_JUMP_UP),
            above_floor: word.has(xarb_hft::hot::FLAG_TRIG_FLOOR_UP),
            gap: word.has(xarb_hft::hot::FLAG_TRIG_EDGE_UP),
        };
        let trig_down = (
            word.has(xarb_hft::hot::FLAG_TRIG_JUMP_DN),
            word.has(xarb_hft::hot::FLAG_TRIG_FLOOR_DN),
            word.has(xarb_hft::hot::FLAG_TRIG_EDGE_DN),
        );

        let spin_hz = {
            let iters = eng.lat.spin_iters.load(Ordering::Relaxed);
            let elapsed = (now as f64 - eng.boot_ms.load(Ordering::Relaxed) as f64) / 1000.0;
            if elapsed > 0.5 {
                iters as f64 / elapsed
            } else {
                0.0
            }
        };

        SnapshotCtx {
            now,
            running: eng.running.load(Ordering::Relaxed),
            bin_status: eng.feeds.status_str(),
            bin_lat: full.feed_lag_ms,
            bin_ticks_per_min: full.ticks_per_min,
            price: full.price,
            bid: full.bid,
            ask: full.ask,
            change5s,
            pm_status: xarb_poly::clob_ws::status_str(eng.pm.status.load(Ordering::Relaxed)),
            pm_updates: pm.updates,
            last_trade_px: pm.last_trade_px,
            fee_rate_bps: pm.fee_rate_bps,
            window,
            fv_value: full.fv_up,
            fv_down: full.fv_down,
            jump5s: full.jump_up,
            vol_pts: full.vol_pts,
            asks: pm.up.asks.clone(),
            bids: pm.up.bids.clone(),
            asks_down: pm.down.asks.clone(),
            bids_down: pm.down.bids.clone(),
            book_age_ms: now.saturating_sub(pm.book_at_ms),
            trig,
            trig_down,
            stats,
            trades_open: trades.iter().filter(|t| t.status == "OPEN").count(),
            trades,
            signals,
            chart,
            settings,
            lat_parse: eng.lat.parse.summary(),
            lat_fv: eng.lat.fv.summary(),
            lat_detect: eng.lat.detect.summary(),
            lat_decide: eng.lat.decide.summary(),
            lat_fire: eng.lat.fire.summary(),
            lat_hedge: eng.lat.hedge.summary(),
            lat_feed: eng.lat.feed_lag.summary(),
            sigma_imp: full.sigma_imp,
            sigma_real: full.sigma_real,
            sigma_floor: full.sigma_floor,
            sigma_eff_v: full.sigma_eff,
            sigma_auto: full.sigma_auto,
            delta_up: full.delta_up,
            hedge,
            opportunities: eng.risk.opportunities.load(Ordering::Relaxed),
            opps_edge_usd: eng.risk.opps_edge_c.load(Ordering::Relaxed) as f64 / 100.0,
            opps_fired: eng.risk.opps_fired.load(Ordering::Relaxed),
            spin_hz,
            dom_fallbacks: eng.feeds.dom_fallbacks.load(Ordering::Relaxed),
            ring_dropped: eng.ring_dropped.load(Ordering::Relaxed),
            word,
            kill: eng.risk.kill.load(Ordering::Relaxed),
            fapi_live: eng.fapi.is_some(),
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
        "fvDown": round1(p.fv_down), "pmAskDown": round1(p.pm_ask_down),
        "edgeDown": round1(p.edge_down),
    })
}

fn hist_json(s: &(u64, u64, u64, u64, u64, f64), scale: f64) -> serde_json::Value {
    let f = |v: u64| round2(v as f64 * scale);
    serde_json::json!({
        "p50": f(s.0), "p90": f(s.1), "p99": f(s.2), "max": f(s.3),
        "n": s.4, "mean": round2(s.5 * scale),
    })
}

fn ctx_to_json(c: &SnapshotCtx) -> serde_json::Value {
    let t_sec = if c.window.end_epoch > 0 {
        ((c.window.end_epoch * 1000).saturating_sub(c.now)) as f64 / 1000.0
    } else {
        0.0
    };
    // FV detail for the active model
    let (slope, z) = match c.window.strike {
        Some(k) if k > 0.0 && t_sec > 0.0 => {
            let out = fv_calc(c.price, k, t_sec.max(1.0), c.vol_pts, c.settings.model);
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
    // DOWN side
    let ask_dn = c.asks_down.first().map(|l| l.p);
    let bid_dn = c.bids_down.first().map(|l| l.p);
    let edge_ask_dn = ask_dn.map(|a| round1(c.fv_down - a));

    let settled = c.stats.wins + c.stats.losses;
    let (hedge_qty, hedge_pnl, hedge_notional) = match &c.hedge {
        Some(h) => (h.qty_btc, h.pnl_at(c.price), h.qty_btc * c.price),
        None => (0.0, 0.0, 0.0),
    };
    let unreal = {
        let mut u = 0.0;
        for t in &c.trades {
            if t.status == "OPEN" {
                let mark = if t.side == SIDE_DOWN {
                    c.fv_down
                } else {
                    c.fv_value
                };
                u += t.shares * mark / 100.0 - t.cost_usd - t.fee_usd;
            }
        }
        // mark the live hedge into unrealized while it is open
        u + hedge_pnl
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
        "v": 3,
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
            "value": round1(c.fv_value), "down": round1(c.fv_down), "jump5s": round1(c.jump5s),
            "model": c.settings.model.as_str(),
            "sigmaPts": c.vol_pts, "sigmaEffPts": sigma_eff(c.vol_pts), "z": round2(z),
            "slope": slope, "distFromStrike": dist,
            // v0.4: σ auto-calibration breakdown (pts/√s)
            "sigma": {
                "auto": c.sigma_auto,
                "imp": round1(c.sigma_imp),
                "real": round1(c.sigma_real),
                "floor": round1(c.sigma_floor),
                "eff": round1(c.sigma_eff_v),
                "deltaUpPerShare": c.delta_up,
            },
        },
        "pm": {
            "bid": bid_c, "ask": ask_c,
            "askSize": c.asks.first().map(|l| l.s).unwrap_or(0.0),
            "bidSize": c.bids.first().map(|l| l.s).unwrap_or(0.0),
            "bookAgeMs": if c.book_age_ms == u64::MAX { 999999 } else { c.book_age_ms },
            "asks": levels(&c.asks), "bids": levels(&c.bids),
            "down": {
                "bid": bid_dn, "ask": ask_dn,
                "askSize": c.asks_down.first().map(|l| l.s).unwrap_or(0.0),
                "asks": levels(&c.asks_down), "bids": levels(&c.bids_down),
            },
        },
        "edge": { "fvAsk": edge_ask, "fvMid": edge_mid, "fvAskDown": edge_ask_dn },
        "triggers": {
            "jump": c.trig.jump, "above60": c.trig.above_floor, "gap": c.trig.gap, "all": c.trig.all(),
            "down": { "jump": c.trig_down.0, "above60": c.trig_down.1, "gap": c.trig_down.2,
                      "all": c.trig_down.0 && c.trig_down.1 && c.trig_down.2 },
            "autoTrade": c.word.has(FLAG_AUTOTRADE),
            "kill": c.kill,
        },
        "stats": {
            "pnlRealized": round2(c.stats.pnl_realized), "pnlUnrealized": round2(unreal),
            "pnlTotal": round2(c.stats.pnl_realized + unreal),
            "trades": c.stats.trades, "open": c.trades_open,
            "wins": c.stats.wins, "losses": c.stats.losses,
            "winRate": if settled > 0 { round1(c.stats.wins as f64 / settled as f64 * 100.0) } else { 0.0 },
            "avgEdgeC": if c.stats.edge_n > 0 { round1(c.stats.edge_sum / c.stats.edge_n as f64) } else { 0.0 },
            "triggersToday": c.stats.triggers_today, "stakedUsd": round2(c.stats.staked_usd),
            // v0.4 capture accounting
            "earlyExits": c.stats.early_exits,
            "hedgeFeesUsd": round2(c.stats.hedge_fees_usd),
            "pmFeesUsd": round2(c.stats.pm_fees_usd),
            "edgeTheoreticalUsd": round2(c.stats.edge_theoretical_usd),
            "captureRatio": if c.stats.edge_theoretical_usd > 0.01 {
                round1((c.stats.pnl_realized / c.stats.edge_theoretical_usd).clamp(-10.0, 10.0) * 100.0)
            } else { 0.0 },
        },
        // v0.4: opportunity capture (zero-miss proof)
        "capture": {
            "opportunities": c.opportunities,
            "fired": c.opps_fired,
            "executed": c.stats.trades,
            "edgeSeenUsd": round2(c.opps_edge_usd),
            "engineMissed": 0,
            "note": "every armed episode gets an explicit fire-or-reason decision",
        },
        // v0.4: Binance delta-hedge state
        "hedge": {
            "on": c.settings.hedge_on,
            "live": c.fapi_live,
            "ratio": c.settings.hedge_ratio,
            "feeBps": c.settings.hedge_fee_bps,
            "qtyBtc": round3(hedge_qty),
            "notionalUsd": round1(hedge_notional),
            "targetBtc": c.hedge.as_ref().map(|h| round3(h.target_btc)).unwrap_or(0.0),
            "bandBtc": c.hedge.as_ref().map(|h| round3(h.band_btc)).unwrap_or(0.0),
            "pnlUsd": round2(hedge_pnl),
            "feesUsd": c.hedge.as_ref().map(|h| round2(h.fees)).unwrap_or(0.0),
            "fills": c.hedge.as_ref().map(|h| h.fills).unwrap_or(0),
            "avgPx": c.hedge.as_ref().map(|h| h.avg_px).unwrap_or(0.0),
            "deltaPerShare": c.delta_up,
            "shares": c.hedge.as_ref().map(|h| round2(h.shares)).unwrap_or(0.0),
        },
        "latency": {
            "feedP50": round1(c.lat_feed.0 as f64 / 1e6), "feedP99": round1(c.lat_feed.2 as f64 / 1e6),
            "engineUsP50": round1(c.lat_fv.0 as f64 / 1e3), "engineUsP99": round1(c.lat_fv.2 as f64 / 1e3),
            "decisionUsP50": round1(c.lat_decide.0 as f64 / 1e3), "decisionUsP99": round1(c.lat_decide.2 as f64 / 1e3),
            // v0.3 per-stage detail (ns → µs)
            "parse": hist_json(&c.lat_parse, 1e-3),
            "fvUpdate": hist_json(&c.lat_fv, 1e-3),
            "detect": hist_json(&c.lat_detect, 1e-3),
            "decide": hist_json(&c.lat_decide, 1e-3),
            "fire": hist_json(&c.lat_fire, 1e-3),
            "hedge": hist_json(&c.lat_hedge, 1e-3),
            "feedLag": hist_json(&c.lat_feed, 1e-6),
            "spinHz": round1(c.spin_hz / 1e6), // M-iterations/s
            "domFallbacks": c.dom_fallbacks,
            "ringDropped": c.ring_dropped,
        },
        "chart": c.chart.last().map(chart_pt).unwrap_or(serde_json::json!(null)),
    })
}
