//! Cold task: 10Hz snapshot publish, fill application, signal formatting,
//! control, and housekeeping — the ONLY writer of cold state. Everything it
//! produces is published wait-free (ArcSwap<String> for snapshots, broadcast
//! for streams), so API readers never contend.

use crate::state::*;
use crate::window::cold_tick;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use xarb_core::now_ms;

pub struct ColdTask {
    pub eng: Arc<crate::Engine>,
    pub signal_rx: tokio::sync::mpsc::UnboundedReceiver<SignalEvt>,
    pub fill_rx: tokio::sync::mpsc::UnboundedReceiver<FillEvent>,
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
                    cold_tick(&self.eng);
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
                    self.apply_fill(fill, &mut last_signal_id);
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
                    cold.stats = Stats { day_start: local_midnight(), ..Stats::default() };
                    cold.chart.clear();
                }
                self.eng.risk.kill.store(false, Ordering::Relaxed);
                self.eng.risk.daily_pnl_c.store(0, Ordering::Relaxed);
                self.eng.risk.window_trades.store(0, Ordering::Relaxed);
                self.eng.risk.open_trades.store(0, Ordering::Relaxed);
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

    /// Apply an executor fill: trade row + stats + EXECUTED signal.
    fn apply_fill(&self, fill: FillEvent, last_id: &mut u64) {
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
                };
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
                        "edge {}¢ · {} {} sh @ {}¢ [{}]",
                        round1(it.edge),
                        side_str(it.side),
                        fill.shares.round(),
                        round1(fill.fill_price_c.unwrap_or(it.ask)),
                        if fill.order_id.is_empty() { "paper" } else { "live" },
                    ),
                    fill_price: fill.fill_price_c,
                    shares: Some(round2(fill.shares)),
                    stake: Some(round2(it.stake_usd)),
                };
                {
                    let mut cold = self.eng.cold.lock().unwrap();
                    cold.trades.insert(0, trade);
                    cold.trades.truncate(200);
                    cold.stats.trades += 1;
                    cold.stats.staked_usd += fill.cost_usd;
                    cold.stats.edge_sum += it.edge;
                    cold.stats.edge_n += 1;
                    cold.stats.triggers_today += 1;
                }
                println!(
                    "[SIGNAL] {} {} fv={}¢ ask={}¢ edge={}¢ jump={}¢ fill={}¢ [{}]",
                    sig.id,
                    side_str(it.side),
                    round1(it.fv),
                    round1(it.ask),
                    round1(it.edge),
                    round1(it.jump),
                    round1(fill.fill_price_c.unwrap_or(it.ask)),
                    if fill.order_id.is_empty() { "paper" } else { "live" },
                );
                self.push_signal(sig);
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
        _ => "unknown".into(),
    }
}

/// Spin up the cold task on the current (main) runtime.
pub fn spawn(eng: Arc<crate::Engine>, ctrl_rx: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>) {
    let (signal_tx, signal_rx) = tokio::sync::mpsc::unbounded_channel::<SignalEvt>();
    let (fill_tx, fill_rx) = tokio::sync::mpsc::unbounded_channel::<FillEvent>();
    eng.set_channels(signal_tx, fill_tx);

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
    let task = ColdTask { eng, signal_rx, fill_rx, ctrl_rx };
    tokio::spawn(task.run());

    println!(
        "[engine] v0.3 hot path up — spin={:?} pins(fv={:?} strat={:?} exec={:?} feed={:?} pm={:?})",
        mode, pins.fv, pins.strat, pins.exec, pins.feed, pins.pm
    );
}
