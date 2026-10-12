//! Cold task: 10Hz snapshot publish, fill application, delta-hedge
//! orchestration, early-exit engine, signal formatting, control, and
//! housekeeping — the ONLY writer of cold state. Everything it produces is
//! published wait-free (ArcSwap<String> for snapshots, broadcast for
//! streams), so API readers never contend.
//!
//! v0.4 responsibilities:
//!   • **Initial hedge** — the moment a paper/live fill lands, the digital
//!     delta is shorted (UP) / bought (DOWN) on Binance: paper fills at the
//!     live top-of-book, live fills via USDT-M futures MARKET orders.
//!   • **Re-hedge** — every 100ms tick runs the Whalley–Wilmott band policy
//!     (`hedger::hedge_step`) against the live FV snapshot; band breaches
//!     emit hedge orders. Wind-down + force-flatten near expiry.
//!   • **Early exit** — when the PM bid re-converges to within `exit_band_c`
//!     of FV and the locked edge ≥ `min_capture_c`, the binary is sold back
//!     (paper: walks the live bid ladder; live: EIP-712 FOK SELL) and the
//!     hedge is flattened — the mispricing is banked WITHOUT waiting for
//!     settlement and without paying into the expiry gamma explosion.
//!   • **Capture accounting** — theoretical vs realized edge per trade and
//!     in aggregate (the capture-ratio panel).

use crate::state::*;
use crate::window::cold_tick;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use xarb_core::{mono_ns, now_ms};
use crate::window::ColdState;
use crate::hedger::pm_fee_c_per_share;

pub struct ColdTask {
    pub eng: Arc<crate::Engine>,
    pub signal_rx: tokio::sync::mpsc::UnboundedReceiver<SignalEvt>,
    pub fill_rx: tokio::sync::mpsc::UnboundedReceiver<FillEvent>,
    pub hedge_rx: tokio::sync::mpsc::UnboundedReceiver<HedgeFill>,
    pub ctrl_rx: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
}

impl ColdTask {
    pub async fn run(mut self) {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut init_tick = tokio::time::interval(std::time::Duration::from_millis(1000));
        init_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_signal_id: u64 = 0;

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    cold_tick(&self.eng).await;
                    self.hedge_tick().await;
                    self.exit_tick().await;
                    // mirror ring drop counter
                    self.eng.ring_dropped.store(
                        self.eng.feeds_ring.dropped() + self.eng.fire_ring.dropped(),
                        Ordering::Relaxed,
                    );
                    // 10Hz snapshot publish (wait-free for readers)
                    let snap = crate::snapshot::build(&self.eng);
                    self.eng.emit(snap);
                }
                _ = init_tick.tick() => {
                    let init = crate::snapshot::build_init(&self.eng);
                    self.eng.init_snap.store(Arc::new(init.to_string()));
                }
                Some(evt) = self.signal_rx.recv() => {
                    self.apply_signal(evt, &mut last_signal_id);
                }
                Some(fill) = self.fill_rx.recv() => {
                    self.apply_fill(fill, &mut last_signal_id).await;
                }
                Some(fill) = self.hedge_rx.recv() => {
                    self.apply_hedge_fill(fill);
                }
                Some(msg) = self.ctrl_rx.recv() => {
                    self.apply_control(&msg);
                }
            }
        }
    }

    fn apply_control(&self, msg: &serde_json::Value) {
        let kind = msg["type"].as_str().unwrap_or("");
        match kind {
            "start" => {
                self.eng.running.store(true, Ordering::Relaxed);
                println!("[engine] running=true");
            }
            "stop" => {
                self.eng.running.store(false, Ordering::Relaxed);
                println!("[engine] running=false");
            }
            "reset" => {
                {
                    let mut cold = self.eng.cold.lock().unwrap();
                    cold.signals.clear();
                    cold.trades.clear();
                    cold.hedge = None;
                    cold.stats = Stats { day_start: local_midnight(), ..Stats::default() };
                    cold.chart.clear();
                }
                self.eng.risk.kill.store(false, Ordering::Relaxed);
                self.eng.risk.daily_pnl_c.store(0, Ordering::Relaxed);
                self.eng.risk.window_trades.store(0, Ordering::Relaxed);
                self.eng.risk.open_trades.store(0, Ordering::Relaxed);
                self.eng.risk.opportunities.store(0, Ordering::Relaxed);
                self.eng.risk.opps_edge_c.store(0, Ordering::Relaxed);
                self.eng.risk.opps_fired.store(0, Ordering::Relaxed);
                println!("[engine] stats reset");
            }
            "settings" => {
                if let Some(s) = msg.get("settings") {
                    self.eng.apply_settings(s);
                    println!("[engine] settings updated: {s}");
                }
            }
            _ => {}
        }
    }

    /// Format a compact hot-path signal event into the SignalLog.
    fn apply_signal(&self, evt: SignalEvt, last_id: &mut u64) {
        *last_id += 1;
        let id = format!("K{last_id}-{}", uid());
        let sig = SignalLog {
            id,
            ts: evt.ts_ms,
            window_end: evt.window_end,
            side: side_str(evt.side),
            fv: evt.fv,
            ask: (evt.ask > 0.0).then_some(evt.ask),
            edge: (evt.ask > 0.0).then_some(evt.edge),
            jump5s: evt.jump,
            seconds_left: evt.t_sec,
            action: "SKIPPED",
            reason: reason_str(evt.reason),
            fill_price: None,
            shares: None,
            stake: None,
        };
        self.push_signal(sig);
    }

    /// Apply an executor fill: trade row + stats + EXECUTED signal + open
    /// the INITIAL delta-hedge on Binance immediately.
    async fn apply_fill(&self, fill: FillEvent, last_id: &mut u64) {
        let it = &fill.intent;
        *last_id += 1;
        let sig_id = format!("S{last_id}-{}", uid());
        match fill.outcome {
            0 => {
                let trade = Trade {
                    id: format!("T{}", &sig_id[1..]),
                    signal_id: sig_id.clone(),
                    ts: it.ts_ms,
                    window_end: it.window_end,
                    side: it.side,
                    strike: it.strike,
                    price_c: fill.fill_price_c.unwrap_or(it.ask),
                    shares: fill.shares,
                    cost_usd: fill.cost_usd,
                    fee_usd: fill.fee_usd,
                    status: "OPEN",
                    pnl_usd: None,
                    final_price: None,
                    fv_at_entry: it.fv,
                    edge_at_entry: it.edge,
                    net_edge_at_entry: it.net_edge_c,
                    hedge_qty_btc: 0.0,
                    hedge_pnl_usd: 0.0,
                    hedge_fees_usd: 0.0,
                    exit_px_c: None,
                    exit_reason: String::new(),
                };
                let trade_id = trade.id.clone();
                {
                    let mut cold = self.eng.cold.lock().unwrap();
                    cold.trades.insert(0, trade);
                    cold.trades.truncate(200);
                    cold.stats.trades += 1;
                    cold.stats.staked_usd += fill.cost_usd;
                    cold.stats.edge_sum += it.edge;
                    cold.stats.edge_n += 1;
                    cold.stats.triggers_today += 1;
                    cold.stats.pm_fees_usd += fill.fee_usd;
                    cold.stats.edge_theoretical_usd +=
                        it.net_edge_c * fill.shares / 100.0;
                    // open the hedge position book
                    cold.hedge = Some(crate::hedger::HedgePos {
                        trade_id: trade_id.clone(),
                        side: it.side,
                        shares: fill.shares,
                        strike: it.strike,
                        ..Default::default()
                    });
                }
                let sig = SignalLog {
                    id: sig_id,
                    ts: it.ts_ms,
                    window_end: it.window_end,
                    side: side_str(it.side),
                    fv: it.fv,
                    ask: Some(it.ask),
                    edge: Some(it.edge),
                    jump5s: it.jump,
                    seconds_left: it.t_sec,
                    action: "EXECUTED",
                    reason: format!(
                        "edge {}¢ (net {}¢ after {}¢ fee + {}¢ hedge) · {} {} sh @ {}¢ [{}]",
                        round1(it.edge),
                        round1(it.net_edge_c),
                        round1(it.fee_c),
                        round1(it.hedge_c),
                        side_str(it.side),
                        fill.shares.round(),
                        round1(fill.fill_price_c.unwrap_or(it.ask)),
                        if fill.order_id.is_empty() { "paper" } else { "live" },
                    ),
                    fill_price: fill.fill_price_c,
                    shares: Some(round2(fill.shares)),
                    stake: Some(round2(it.stake_usd)),
                };
                println!(
                    "[SIGNAL] {} {} fv={}¢ ask={}¢ edge={}¢ net={}¢ fill={}¢ [{}]",
                    sig.id,
                    side_str(it.side),
                    round1(it.fv),
                    round1(it.ask),
                    round1(it.edge),
                    round1(it.net_edge_c),
                    round1(fill.fill_price_c.unwrap_or(it.ask)),
                    if fill.order_id.is_empty() { "paper" } else { "live" },
                );
                self.push_signal(sig);
                // ── initial delta-hedge (immediate: the entry leaves us
                // long/short ~Δ·shares of BTC direction) ──
                self.run_hedge_policy("initial hedge").await;
            }
            _ => {
                // skipped at the executor (revalidated/repriced) or live error
                let sig = SignalLog {
                    id: sig_id,
                    ts: it.ts_ms,
                    window_end: it.window_end,
                    side: side_str(it.side),
                    fv: it.fv,
                    ask: Some(it.ask),
                    edge: Some(it.edge),
                    jump5s: it.jump,
                    seconds_left: it.t_sec,
                    action: "SKIPPED",
                    reason: if fill.reason == R_LIVE_ERR && !fill.order_status.is_empty() {
                        format!("live order failed: {}", fill.order_status)
                    } else {
                        reason_str(fill.reason)
                    },
                    fill_price: None,
                    shares: None,
                    stake: None,
                };
                self.push_signal(sig);
            }
        }
    }

    /// 100ms hedge policy tick: band check → hedge order (paper inline /
    /// live async futures order). Also refreshes display targets.
    async fn hedge_tick(&self) {
        self.run_hedge_policy("re-hedge").await;
    }

    /// Evaluate the Whalley–Wilmott policy once and execute if breached.
    async fn run_hedge_policy(&self, ctx: &str) {
        let t0 = mono_ns();
        let full = self.eng.hot.full.load_full();
        let s = self.eng.settings.load_full();
        let cfg = s.hedge_cfg();
        let pos = {
            let cold = self.eng.cold.lock().unwrap();
            cold.hedge.clone()
        };
        let Some(pos) = pos else { return };
        if pos.shares <= 0.0 || full.tau_s <= 0.0 || full.price <= 0.0 {
            return;
        }
        // the trade's own τ (window may have rolled under an open live trade)
        let tau = full.tau_s.max(0.0);
        if let Some(action) = crate::hedger::hedge_step(&pos, full.price, full.sigma_eff, tau, &cfg)
        {
            self.execute_hedge(&pos, action.qty, &format!("{ctx}: {}", action.reason))
                .await;
        }
        // refresh display targets
        {
            let (target, band) = hedge_targets(&pos, full.price, full.sigma_eff, tau, &cfg);
            let mut cold = self.eng.cold.lock().unwrap();
            if let Some(h) = cold.hedge.as_mut() {
                if h.trade_id == pos.trade_id {
                    h.target_btc = target;
                    h.band_btc = band;
                }
            }
        }
        self.eng.lat.hedge.record(mono_ns().saturating_sub(t0));
    }

    /// Execute one hedge order. Paper: fill against the live Binance
    /// top-of-book inline. Live: USDT-M futures MARKET order (async, result
    /// returns through hedge_rx).
    async fn execute_hedge(&self, pos: &crate::hedger::HedgePos, qty: f64, reason: &str) {
        if qty == 0.0 || pos.shares <= 0.0 {
            return;
        }
        let full = self.eng.hot.full.load_full();
        let fee_frac = self.eng.settings.load_full().hedge_cfg().fee_frac();
        let reduce_only = reason.contains("flatten");
        match &self.eng.fapi {
            None => {
                // paper: shorts cross the bid, covers lift the ask
                let px = if qty < 0.0 { full.bid } else { full.ask };
                if px <= 0.0 {
                    return;
                }
                let fee = qty.abs() * px * fee_frac;
                let fill = HedgeFill {
                    trade_id: pos.trade_id.clone(),
                    qty_btc: qty,
                    px,
                    fee_usd: fee,
                    reason: reason.to_string(),
                };
                self.apply_hedge_fill(fill);
            }
            Some(fapi) => {
                let side = if qty < 0.0 { "SELL" } else { "BUY" };
                let fapi = fapi.clone();
                let trade_id = pos.trade_id.clone();
                let qty_abs = qty.abs();
                let reason_owned = reason.to_string();
                let hedge_tx = self.eng.hedge_tx_get();
                tokio::spawn(async move {
                    match fapi.market_order("BTCUSDT", side, qty_abs, reduce_only).await {
                        Ok(f) => {
                            let _ = hedge_tx.send(HedgeFill {
                                trade_id,
                                qty_btc: if side == "SELL" { -f.exec_qty } else { f.exec_qty },
                                px: f.avg_px,
                                fee_usd: f.exec_qty * f.avg_px * fee_frac,
                                reason: reason_owned,
                            });
                        }
                        Err(e) => {
                            println!("[hedge] live order failed: {e}");
                        }
                    }
                });
            }
        }
    }

    /// Apply a hedge fill: update HedgePos (exact cash-flow accounting),
    /// mirror into the trade row + stats, emit a HEDGE signal, and
    /// finalize trades whose hedge just went flat.
    fn apply_hedge_fill(&self, fill: HedgeFill) {
        let full = self.eng.hot.full.load_full();
        let mark = full.price;
        let mut emit_settle = None;
        {
            let mut cold = self.eng.cold.lock().unwrap();
            let ColdState { stats, trades, hedge, .. } = &mut *cold;
            if let Some(h) = hedge.as_mut() {
                if h.trade_id == fill.trade_id {
                    crate::hedger::apply_fill(h, fill.qty_btc, fill.px, fill.fee_usd);
                    stats.hedge_fees_usd += fill.fee_usd;
                    let pnl_now = h.pnl_at(mark);
                    let mut prev_pnl = 0.0;
                    for t in trades.iter_mut() {
                        if t.id == fill.trade_id {
                            prev_pnl = t.hedge_pnl_usd;
                            t.hedge_qty_btc = h.qty_btc;
                            t.hedge_pnl_usd = pnl_now;
                            t.hedge_fees_usd = h.fees;
                            break;
                        }
                    }
                    // closed trade + hedge just went flat → finalize the
                    // late live flatten delta into realized PnL
                    if h.is_flat() {
                        if let Some(t) = trades.iter_mut().find(|t| t.id == fill.trade_id) {
                            if t.status == "WON" || t.status == "LOST" || t.status == "EXITED" {
                                let delta = pnl_now - prev_pnl;
                                if delta != 0.0 {
                                    if let Some(p) = t.pnl_usd.as_mut() {
                                        *p += delta;
                                    }
                                    stats.pnl_realized += delta;
                                    self.eng.risk.daily_pnl_c.fetch_add(
                                        (delta * 100.0).round() as i64,
                                        Ordering::Relaxed,
                                    );
                                }
                                emit_settle = Some(t.to_json());
                            }
                        }
                        *hedge = None;
                    }
                }
            }
        }
        // HEDGE signal row (visible hedge action in the feed)
        self.push_signal(SignalLog {
            id: format!("H-{}", uid()),
            ts: now_ms(),
            window_end: 0,
            side: side_str(1),
            fv: 0.0,
            ask: None,
            edge: None,
            jump5s: 0.0,
            seconds_left: 0.0,
            action: "HEDGE",
            reason: format!(
                "{} {} {} BTC @ {} (fee {})",
                fill.reason,
                if fill.qty_btc < 0.0 { "SHORT" } else { "COVER" },
                round3(fill.qty_btc.abs()),
                fill.px,
                round2(fill.fee_usd)
            ),
            fill_price: None,
            shares: None,
            stake: None,
        });
        if let Some(m) = emit_settle {
            let mut msg = serde_json::json!({ "type": "settle" });
            if let Some(obj) = m.as_object() {
                for (k, v) in obj {
                    msg[k.as_str()] = v.clone();
                }
            }
            self.eng.emit(msg);
        }
    }

    /// 100ms early-exit tick: bank the mispricing when PM re-converges.
    async fn exit_tick(&self) {
        let s = self.eng.settings.load_full();
        if s.min_capture_c < 0.0 {
            return; // exits disabled via negative capture
        }
        let full = self.eng.hot.full.load_full();
        let pm = self.eng.pm.snap.load_full();
        let (trade_id, side, shares, entry_c, window_end, fv, bid, bid_sz) = {
            let cold = self.eng.cold.lock().unwrap();
            let Some(h) = cold.hedge.as_ref() else { return };
            let Some(t) = cold.trades.iter().find(|t| t.id == h.trade_id && t.status == "OPEN")
            else {
                return;
            };
            let fv = if t.side == SIDE_DOWN { full.fv_down } else { full.fv_up };
            let side_snap = if t.side == SIDE_DOWN { &pm.down } else { &pm.up };
            (
                t.id.clone(),
                t.side,
                t.shares,
                t.price_c,
                t.window_end,
                fv,
                side_snap.bid,
                side_snap.bid_sz,
            )
        };
        let _ = window_end;
        let Some(bid) = bid else { return };
        let bid_c = bid;
        let captured = bid_c - entry_c;
        // reprice-exit: PM bid back within exit_band of FV AND enough edge
        // locked (≥ min_capture over entry, and ≥ 1¢ over entry after the
        // exit fee — sell side fee is on proceeds)
        let exit_fee_c = pm_fee_c(bid, s.taker_fee_bps.max(0.0), &pm);
        if bid_c + s.exit_band_c >= fv && captured >= s.min_capture_c && captured - exit_fee_c >= 1.0
        {
            let fee_bps = pm.fee_rate_bps.map(|f| f as f64).unwrap_or(s.taker_fee_bps);
            self.execute_exit(&trade_id, side, shares, bid_c, bid_sz, "reprice-exit", fee_bps)
                .await;
        }
    }

    /// Sell the binary back at `bid_c` (paper: walk the live bid ladder) and
    /// flatten the hedge — the edge is banked now, not at settlement.
    #[allow(clippy::too_many_arguments)]
    async fn execute_exit(
        &self,
        trade_id: &str,
        side: u8,
        shares: f64,
        bid_c: f64,
        bid_sz: f64,
        reason: &str,
        fee_bps: f64,
    ) {
        let s = self.eng.settings.load_full();
        // paper exit fill: take the displayed size at the bid
        let fill_shares = shares.min(bid_sz.max(0.0));
        if fill_shares < 5.0 {
            return; // below the 5-share order minimum — hold to settlement
        }
        let proceeds = fill_shares * bid_c / 100.0;
        let exit_fee = pm_fee_c_per_share(bid_c / 100.0, fee_bps) * fill_shares / 100.0;
        // flatten the hedge at market (paper inline; live reduce-only)
        let mark = self.eng.hot.full.load_full().price;
        let mut hedge_pnl = 0.0;
        {
            let mut cold = self.eng.cold.lock().unwrap();
            let mut pos = cold.hedge.clone();
            let mut fee_add = 0.0;
            if let Some(h) = pos.as_mut() {
                if h.trade_id == trade_id {
                    if !h.is_flat() {
                        // paper flatten fill now (bid for shorts, ask for covers)
                        let full = self.eng.hot.full.load_full();
                        let px = if h.qty_btc < 0.0 { full.bid } else { full.ask };
                        if px > 0.0 {
                            let fee = h.qty_btc.abs() * px * s.hedge_cfg().fee_frac();
                            crate::hedger::apply_fill(h, -h.qty_btc, px, fee);
                            fee_add = fee;
                        }
                    }
                    hedge_pnl = h.pnl_at(mark);
                }
            }
            cold.hedge = pos;
            if fee_add > 0.0 {
                cold.stats.hedge_fees_usd += fee_add;
            }
        }
        let mut pnl = None;
        let mut msg = None;
        {
            let mut cold = self.eng.cold.lock().unwrap();
            if let Some(idx) = cold.trades.iter().position(|t| t.id == trade_id && t.status == "OPEN") {
                let t = &mut cold.trades[idx];
                let binary_pnl = proceeds - t.cost_usd - t.fee_usd - exit_fee;
                t.status = "EXITED";
                t.exit_px_c = Some(bid_c);
                t.exit_reason = reason.into();
                t.hedge_pnl_usd = hedge_pnl;
                let total = binary_pnl + hedge_pnl;
                t.pnl_usd = Some(total);
                pnl = Some(total);
                let row = t.to_json();
                let entry_c = round1(t.price_c);
                let id = t.id.clone();
                println!(
                    "[exit] {id} EXITED @ {bid_c}¢ (entry {entry_c}¢) binary={binary_pnl:+.2} hedge={hedge_pnl:+.2} net={total:+.2}"
                );
                // (t's borrow ends here — stats update is a disjoint field)
                cold.stats.pnl_realized += total;
                cold.stats.early_exits += 1;
                cold.stats.pm_fees_usd += exit_fee;
                msg = Some(row);
            }
            cold.hedge = None;
        }
        if let Some(total) = pnl {
            self.eng.risk.open_trades.fetch_sub(1, Ordering::Relaxed);
            self.eng
                .risk
                .daily_pnl_c
                .fetch_add((total * 100.0).round() as i64, Ordering::Relaxed);
        }
        // EXIT signal row
        self.push_signal(SignalLog {
            id: format!("X-{}", uid()),
            ts: now_ms(),
            window_end: 0,
            side: side_str(side),
            fv: 0.0,
            ask: None,
            edge: None,
            jump5s: 0.0,
            seconds_left: 0.0,
            action: "EXIT",
            reason: format!(
                "{reason}: sold {} sh @ {}¢ · hedge pnl {:+.2} — edge banked",
                fill_shares.round(),
                round1(bid_c),
                hedge_pnl
            ),
            fill_price: Some(bid_c),
            shares: Some(round2(fill_shares)),
            stake: None,
        });
        if let Some(m) = msg {
            let mut out = serde_json::json!({ "type": "settle" });
            if let Some(obj) = m.as_object() {
                for (k, v) in obj {
                    out[k.as_str()] = v.clone();
                }
            }
            self.eng.emit(out);
        }
    }

    fn push_signal(&self, sig: SignalLog) {
        let v = sig.to_json();
        {
            let mut cold = self.eng.cold.lock().unwrap();
            cold.signals.insert(0, sig);
            cold.signals.truncate(120);
        }
        let mut msg = serde_json::json!({ "type": "signal" });
        if let Some(obj) = v.as_object() {
            for (k, val) in obj {
                msg[k.as_str()] = val.clone();
            }
        }
        self.eng.emit(msg);
    }
}

// ── live hedge order plumbing ────────────────────────────────────────────────
// The executor/cold tasks spawn async fapi orders; fills return through
// the engine's hedge channel (thread-safe, any runtime worker).

/// Force-flatten a hedge (called at settlement for in-flight live hedges).
pub async fn force_flatten_hedge(eng: &Arc<crate::Engine>, trade_id: String) {
    let pos = {
        let cold = eng.cold.lock().unwrap();
        cold.hedge.clone()
    };
    let Some(pos) = pos else { return };
    if pos.trade_id != trade_id || pos.is_flat() {
        return;
    }
    let cold = ColdTask {
        eng: eng.clone(),
        signal_rx: {
            let (_, rx) = tokio::sync::mpsc::unbounded_channel();
            rx
        },
        fill_rx: {
            let (_, rx) = tokio::sync::mpsc::unbounded_channel();
            rx
        },
        hedge_rx: {
            let (_, rx) = tokio::sync::mpsc::unbounded_channel();
            rx
        },
        ctrl_rx: {
            let (_, rx) = tokio::sync::mpsc::unbounded_channel();
            rx
        },
    };
    let qty = -pos.qty_btc;
    cold.execute_hedge(&pos, qty, "force-flatten (settlement)").await;
}

/// Display targets for the hedge panel.
fn hedge_targets(
    pos: &crate::hedger::HedgePos,
    s: f64,
    sigma_eff: f64,
    tau: f64,
    cfg: &crate::hedger::HedgeCfg,
) -> (f64, f64) {
    use xarb_core::digital_delta_per_share;
    if pos.shares <= 0.0 || s <= 0.0 || tau <= 0.0 {
        return (0.0, 0.0);
    }
    let dlt = digital_delta_per_share(s, pos.strike, tau, sigma_eff);
    let dir = if pos.side == SIDE_DOWN { -1.0 } else { 1.0 };
    let target = -dir * pos.shares * dlt * cfg.ratio;
    let g = xarb_core::digital_gamma_per_share(s, pos.strike, tau, sigma_eff) * pos.shares;
    let ww = (cfg.fee_frac() * s * s * g).max(0.0).powf(1.0 / 3.0) * cfg.c_ww / s.max(1.0);
    let band = cfg
        .min_band_btc
        .max(ww)
        .min((target.abs() * 0.30).max(cfg.min_band_btc));
    (target, band)
}

/// PM taker fee in ¢/share from the WS-observed market fee (fallback bps).
fn pm_fee_c(p_c: f64, fallback_bps: f64, pm: &xarb_poly::PmSnapshot) -> f64 {
    let bps = pm.fee_rate_bps.map(|f| f as f64).unwrap_or(fallback_bps);
    pm_fee_c_per_share(p_c / 100.0, bps)
}

pub fn reason_str(r: u8) -> String {
    match r {
        R_AUTO_OFF => "auto-trade off".into(),
        R_TOO_CLOSE => "too close to close".into(),
        R_COOLDOWN => "signal cooldown".into(),
        R_MAX_TRADES => "max trades for window".into(),
        R_POS_OPEN => "position already open".into(),
        R_NO_TOKENS => "window book not loaded".into(),
        R_THIN_BOOK => "thin book".into(),
        R_REPRICED => "momentum, but PM already repriced".into(),
        R_WATCH => "near-miss watch".into(),
        R_STALE => "stale data at fire time".into(),
        R_LIVE_ERR => "live order failed".into(),
        R_KILL => "kill switch (daily loss)".into(),
        R_NET_EDGE => "net edge below floor (fees + hedge cost)".into(),
        _ => "unknown".into(),
    }
}

/// Spin up the cold task on the current (main) runtime.
pub fn spawn(eng: Arc<crate::Engine>, ctrl_rx: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>) {
    let (signal_tx, signal_rx) = tokio::sync::mpsc::unbounded_channel::<SignalEvt>();
    let (fill_tx, fill_rx) = tokio::sync::mpsc::unbounded_channel::<FillEvent>();
    let (hedge_tx, hedge_rx) = tokio::sync::mpsc::unbounded_channel::<HedgeFill>();
    eng.set_channels(signal_tx, fill_tx, hedge_tx);

    // initial window
    {
        let eng2 = eng.clone();
        tokio::spawn(async move {
            let epoch = xarb_core::current_window_epoch(now_ms());
            crate::window::manage_window(eng2, epoch).await;
        });
    }

    // hot threads (order breaks wake cycles via WakeSlots)
    let mode = eng.spin_mode;
    let pins = eng.pins;
    let lat = eng.lat.clone();

    // 1) FV engine thread (consumer of the Binance ring)
    let fv_jh = crate::hotcore::spawn_fv(
        eng.feeds_ring.clone(),
        eng.hot.clone(),
        eng.pm.clone(),
        eng.risk.clone(),
        eng.settings.clone(),
        eng.settings_gen.clone(),
        eng.running.clone(),
        lat.clone(),
        eng.wake.strat.clone(),
        mode,
        pins.fv,
    );
    eng.wake.fv.set(xarb_hft::Unparker::new(fv_jh.thread().clone()));

    // 2) executor thread (consumer of the fire ring)
    let exec_jh = crate::executor::spawn_executor(
        eng.fire_ring.clone(),
        eng.hot.clone(),
        eng.pm.clone(),
        eng.risk.clone(),
        eng.settings.clone(),
        lat.clone(),
        eng.fill_tx_get(),
        eng.clob.clone(),
        eng.cfg.neg_risk,
        eng.cfg.mode == "live",
        mode,
        pins.exec,
    );
    eng.wake.exec.set(xarb_hft::Unparker::new(exec_jh.thread().clone()));

    // 3) strategy thread (producer of the fire ring)
    let strat_jh = crate::strategy::spawn_strategy(
        eng.hot.clone(),
        eng.pm.clone(),
        eng.risk.clone(),
        eng.settings.clone(),
        lat.clone(),
        eng.signal_tx_get(),
        eng.fire_ring.clone(),
        eng.wake.exec.clone(),
        mode,
        pins.strat,
    );
    eng.wake.strat.set(xarb_hft::Unparker::new(strat_jh.thread().clone()));

    // 4) feeds on dedicated single-producer threads
    xarb_feed::spawn_dedicated(eng.feeds.clone(), pins.feed);
    let token_rx = eng.token_tx.subscribe();
    xarb_poly::clob_ws::spawn_dedicated(eng.pm.clone(), token_rx, pins.pm);

    // 5) cold task on this runtime
    let task = ColdTask { eng, signal_rx, fill_rx, hedge_rx, ctrl_rx };
    tokio::spawn(task.run());

    println!(
        "[engine] v0.4 hot path up — spin={:?} pins(fv={:?} strat={:?} exec={:?} feed={:?} pm={:?}) · δ-hedge on Binance · σ auto-cal from live PM",
        mode, pins.fv, pins.strat, pins.exec, pins.feed, pins.pm
    );
}
