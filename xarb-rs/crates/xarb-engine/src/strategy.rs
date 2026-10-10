//! Strategy thread: continuous trigger evaluation at spin cadence.
//!
//! The thread spins on the packed HotWord. EVERY iteration evaluates the
//! full 3-condition conjunction for BOTH sides via one atomic load + one
//! AND + one compare per side — so all trigger conditions are checked on
//! every opportunity, with no event queuing, no coalescing losses, and no
//! way for a burst to delay evaluation. When the word changes:
//!   • detect latency = mono_ns() − word_t (the FV thread's store time)
//!   • on FIRE: risk gates → FireIntent pushed to the executor SPSC ring
//!     (Copied, zero allocation) → executor unparked
//!   • on near-miss: compact SignalEvt forwarded to the cold task

use crate::hotcore::HotShared;
use crate::state::*;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use xarb_core::mono_ns;
use xarb_hft::hot::{FLAG_KILL, FLAG_TRIG_EDGE_DN, FLAG_TRIG_EDGE_UP};
use xarb_hft::{FireHit, HotWord, SpscRing, SpinMode, WakeSlot};
use xarb_poly::PmOut;

/// Near-miss / skip log throttles (ms).
const WATCH_THROTTLE_MS: u64 = 10_000;
const SKIP_THROTTLE_MS: u64 = 8_000;

/// Fire intent ring capacity — fires are rare (cooldown-gated); 64 is deep.
pub const FIRE_RING_CAP: usize = 64;

/// Spawn the strategy thread (producer of the fire ring). `signal_tx`
/// forwards compact events to the cold task; `exec_unpark` wakes the
/// executor after a push.
#[allow(clippy::too_many_arguments)]
pub fn spawn_strategy(
    hot: Arc<HotShared>,
    pm: Arc<PmOut>,
    risk: Arc<RiskState>,
    settings: Arc<arc_swap::ArcSwap<Settings>>,
    lat: Arc<LatencyStats>,
    signal_tx: tokio::sync::mpsc::UnboundedSender<SignalEvt>,
    fire_ring: Arc<SpscRing<FireIntent>>,
    exec_wake: Arc<WakeSlot>,
    mode: SpinMode,
    pin: Option<usize>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("strategy".into())
        .spawn(move || {
            if let Some(c) = pin {
                let _ = xarb_hft::affinity::pin_current(c);
            }
            let parker = xarb_hft::Parker::new(Duration::from_millis(250));
            let mut last_word: u64 = 0;
            let mut last_fire_mono: u64 = 0;
            let mut fired_once = false; // cooldown applies only after a first fire
            let mut last_watch_ms: u64 = 0;
            let mut skip_last = [0u64; 16];
            let mut iters: u64 = 0;

            loop {
                iters = iters.wrapping_add(1);
                if iters & 0x3FF == 0 {
                    lat.spin_iters.fetch_add(1024, Ordering::Relaxed);
                }

                let w = hot.word_v();
                let word = w.0;
                let changed = word != last_word;
                if changed {
                    // detect latency: now − the FV thread's store timestamp
                    let t0 = mono_ns();
                    let wt = hot.word_t.load(Ordering::Acquire);
                    if wt > 0 && t0 > wt {
                        lat.detect.record(t0.saturating_sub(wt));
                    }

                    let hit = w.fire_check();
                    match hit {
                        FireHit::Up | FireHit::Down => {
                            let side = if hit == FireHit::Down { SIDE_DOWN } else { SIDE_UP };
                            let t_dec = mono_ns();
                            let intent = build_intent(&hot, &pm, &settings, &w, side, t_dec);
                            let gate = risk_gate(
                                &risk, &settings, intent.t_sec, intent.window_end, t_dec,
                                last_fire_mono, fired_once, w, side,
                            );
                            match gate {
                                Ok(()) => {
                                    fire_ring.try_push(intent);
                                    hot_strat_push(&signal_tx, intent, 2, 0);
                                    last_fire_mono = t_dec;
                                    fired_once = true;
                                    // wake the executor (token — never lost)
                                    exec_wake.wake();
                                }
                                Err(reason) => {
                                    let now_ms = xarb_core::now_ms();
                                    if skip_throttle(&mut skip_last, reason, now_ms) {
                                        hot_strat_push(&signal_tx, intent, 1, reason);
                                    }
                                }
                            }
                            let t1 = mono_ns();
                            lat.decide.record(t1.saturating_sub(t_dec));
                        }
                        FireHit::None => {
                            // near-miss watch: momentum + floor but no edge yet
                            if w.has(FLAG_TRIG_EDGE_UP | FLAG_TRIG_EDGE_DN) {
                                // edge set but other conditions missing — not
                                // interesting; fall through
                            }
                            if w.flags() != 0 {
                                let now_ms = xarb_core::now_ms();
                                if now_ms.saturating_sub(last_watch_ms) > WATCH_THROTTLE_MS
                                    && near_miss(&w, &settings)
                                {
                                    last_watch_ms = now_ms;
                                    let side = if w.fv_up_c() < w.fv_down_c() {
                                        SIDE_DOWN
                                    } else {
                                        SIDE_UP
                                    };
                                    let fv = if side == SIDE_DOWN {
                                        w.fv_down_c() as f64
                                    } else {
                                        w.fv_up_c() as f64
                                    };
                                    let ask = if side == SIDE_DOWN {
                                        pm.down_cell_v().ask_opt()
                                    } else {
                                        pm.up_cell_v().ask_opt()
                                    };
                                    let _ = signal_tx.send(SignalEvt {
                                        kind: 0,
                                        side,
                                        reason: R_WATCH,
                                        ts_ms: now_ms,
                                        window_end: w_window_end(&hot),
                                        fv,
                                        ask: ask.map(|a| a as f64).unwrap_or(0.0),
                                        jump: w.jump_up_c() as f64,
                                        edge: ask.map(|a| fv - a as f64).unwrap_or(0.0),
                                        t_sec: t_sec_of(&hot),
                                    });
                                }
                            }
                        }
                    }
                    last_word = word;
                }

                // power policy
                match mode {
                    SpinMode::Spin => std::hint::spin_loop(),
                    SpinMode::Hybrid | SpinMode::Eco => {
                        // word-change unparks come from the FV thread; the
                        // 250ms timeout bounds cooldown-expiry rechecks.
                        parker.park();
                    }
                }
            }
        })
        .expect("spawn strategy thread")
}

/// Build the FireIntent from current rich state (cold-ish reads, fire only).
fn build_intent(
    hot: &HotShared,
    pm: &PmOut,
    settings: &Arc<arc_swap::ArcSwap<Settings>>,
    w: &HotWord,
    side: u8,
    t_mono: u64,
) -> FireIntent {
    let s = settings.load_full();
    let full = hot.full.load_full();
    let (fv, ask, jump, edge) = if side == SIDE_DOWN {
        let ask = pm.down_cell_v().ask_opt().map(|a| a as f64);
        (
            w.fv_down_c() as f64,
            ask.unwrap_or(0.0),
            w.jump_down_c() as f64,
            ask.map(|a| w.fv_down_c() as f64 - a).unwrap_or(0.0),
        )
    } else {
        let ask = pm.up_cell_v().ask_opt().map(|a| a as f64);
        (
            w.fv_up_c() as f64,
            ask.unwrap_or(0.0),
            w.jump_up_c() as f64,
            ask.map(|a| w.fv_up_c() as f64 - a).unwrap_or(0.0),
        )
    };
    FireIntent {
        t_mono_ns: t_mono,
        ts_ms: xarb_core::now_ms(),
        side,
        fv,
        ask,
        jump,
        edge,
        t_sec: full.tau_s,
        strike: full.strike,
        window_end: full.window_end,
        stake_usd: s.stake_usd,
        fee_bps: s.taker_fee_bps,
    }
}

/// Hot-path risk gates (single relaxed atomic reads each). Returns Err(reason).
#[allow(clippy::too_many_arguments)]
fn risk_gate(
    risk: &Arc<RiskState>,
    settings: &Arc<arc_swap::ArcSwap<Settings>>,
    t_sec: f64,
    window_end: u64,
    now_mono: u64,
    last_fire_mono: u64,
    fired_once: bool,
    w: HotWord,
    _side: u8,
) -> Result<(), u8> {
    if w.has(FLAG_KILL) {
        return Err(R_KILL);
    }
    let s = settings.load_full();
    if t_sec < s.min_secs_left {
        return Err(R_TOO_CLOSE);
    }
    if fired_once
        && now_mono.saturating_sub(last_fire_mono) < SIGNAL_COOLDOWN_MS as u64 * 1_000_000
    {
        return Err(R_COOLDOWN);
    }
    if risk.trades_in_window(window_end * 1000) >= s.max_trades_per_window {
        return Err(R_MAX_TRADES);
    }
    if risk.open_trades.load(Ordering::Relaxed) > 0 {
        return Err(R_POS_OPEN);
    }
    if risk.daily_pnl_usd() <= -s.max_daily_loss_usd {
        return Err(R_KILL);
    }
    Ok(())
}

/// Near-miss detection: 2 of 3 trigger conditions on either side.
fn near_miss(w: &HotWord, settings: &Arc<arc_swap::ArcSwap<Settings>>) -> bool {
    let s = settings.load_full();
    let jump_up = w.jump_up_c() as f64;
    let fv_up = w.fv_up_c() as f64;
    let fv_dn = w.fv_down_c() as f64;
    // UP side: jump+f Floor set?
    let up_score = (jump_up >= s.jump_thresh_c && fv_up > s.fv_floor_c) as u8
        + w.has(FLAG_TRIG_EDGE_UP) as u8;
    let dn_score = (jump_up <= -s.jump_thresh_c && fv_dn > s.fv_floor_c) as u8
        + w.has(FLAG_TRIG_EDGE_DN) as u8;
    up_score >= 2 || dn_score >= 2
}

fn skip_throttle(skip_last: &mut [u64; 16], reason: u8, now_ms: u64) -> bool {
    let slot = (reason as usize) & 15;
    if now_ms.saturating_sub(skip_last[slot]) > SKIP_THROTTLE_MS {
        skip_last[slot] = now_ms;
        true
    } else {
        false
    }
}

fn hot_strat_push(tx: &tokio::sync::mpsc::UnboundedSender<SignalEvt>, intent: FireIntent, kind: u8, reason: u8) {
    let _ = tx.send(SignalEvt {
        kind,
        side: intent.side,
        reason,
        ts_ms: intent.ts_ms,
        window_end: intent.window_end,
        fv: intent.fv,
        ask: intent.ask,
        jump: intent.jump,
        edge: intent.edge,
        t_sec: intent.t_sec,
    });
}

fn w_window_end(hot: &HotShared) -> u64 {
    hot.full.load_full().window_end
}

fn t_sec_of(hot: &HotShared) -> f64 {
    hot.full.load_full().tau_s
}
