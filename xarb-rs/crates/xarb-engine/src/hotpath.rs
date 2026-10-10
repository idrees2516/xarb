//! Hot path: evaluate on every feed event (Binance tick or CLOB book change).

use crate::state::*;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedReceiver;
use xarb_core::{now_ms, fv, trigger, FvModel, Trig};

pub async fn run(eng: std::sync::Arc<crate::Engine>, mut ev_rx: UnboundedReceiver<()>) {
    while let Some(()) = ev_rx.recv().await {
        if !eng.running.load(Ordering::Relaxed) {
            continue;
        }
        let t0 = Instant::now();
        evaluate(&eng);
        let us = t0.elapsed().as_secs_f64() * 1e6;
        eng.decision_us.lock().unwrap().push(us);
    }
}

fn evaluate(eng: &std::sync::Arc<crate::Engine>) {
    let now = now_ms();

    // window + binance + pm snapshot under short locks
    let (strike, end_epoch, window_end, tokens_loaded, slug) = {
        let w = eng.window.lock().unwrap();
        (
            w.strike,
            w.end_epoch,
            w.end_epoch,
            w.tokens_loaded,
            w.slug.clone(),
        )
    };
    let strike = match strike {
        Some(k) if k > 0.0 => k,
        _ => return,
    };
    if end_epoch * 1000 <= now {
        return;
    }

    let (price, vol) = {
        let b = eng.bin.lock().unwrap();
        (b.mid(), b.vol_pts)
    };
    if price <= 0.0 {
        return;
    }

    let model;
    let (jump_thresh, floor, edge_thresh, auto_trade, min_secs, max_trades, max_age, fee_bps) = {
        let s = eng.settings.lock().unwrap();
        model = s.model;
        (
            s.jump_thresh_c,
            s.fv_floor_c,
            s.edge_thresh_c,
            s.auto_trade,
            s.min_secs_left,
            s.max_trades_per_window,
            s.max_book_age_ms,
            s.taker_fee_bps,
        )
    };

    let t_sec = (end_epoch * 1000 - now) as f64 / 1000.0;

    // fair value
    let out = fv(price, strike, t_sec, vol, model);
    {
        let mut lf = eng.last_fv.lock().unwrap();
        *lf = out.value;
        let mut ring = eng.fv_ring.lock().unwrap();
        ring.push(now, out.value);
    }

    // polymarket book (+ live market taker fee observed on the WS)
    let (ask_c, _ask_size, book_age_ms, ladder, market_fee) = {
        let pm = eng.pm.lock().unwrap();
        let best = pm.book.best_ask();
        (
            best.map(|l| l.p * 100.0),
            best.map(|l| l.s).unwrap_or(0.0),
            pm.book.age_ms(now),
            pm.book.ask_ladder_usd(),
            pm.fee_rate_bps,
        )
    };
    let fresh = book_age_ms < max_age as u64;

    // triggers
    let jump;
    {
        let ring = eng.fv_ring.lock().unwrap();
        let (trig, j, _edge) =
            trigger::evaluate(out.value, &ring, now, ask_c, fresh, jump_thresh, floor, edge_thresh);
        jump = j;
        *eng.trig.lock().unwrap() = trig;
    }

    let trig: Trig = *eng.trig.lock().unwrap();
    if trig.all() {
        if let Some(ask) = ask_c {
            // market taker fee (observed on the WS) wins over the settings knob
            let effective_fee = market_fee.map(|f| f as f64).unwrap_or(fee_bps);
            crate::fire::try_fire(
                eng,
                out.value,
                jump,
                ask,
                out.value - ask,
                t_sec,
                &ladder,
                slug,
                tokens_loaded,
                window_end,
                auto_trade,
                min_secs,
                max_trades,
                effective_fee,
                strike,
            );
        }
    } else {
        log_watch_or_skip(eng, out.value, jump, ask_c, trig, edge_thresh, t_sec);
    }
}

fn log_watch_or_skip(
    eng: &std::sync::Arc<crate::Engine>,
    fv_v: f64,
    jump: f64,
    ask_c: Option<f64>,
    trig: Trig,
    edge_thresh: f64,
    t_sec: f64,
) {
    let now = now_ms();
    let edge = ask_c.map(|a| fv_v - a);

    // near-miss watch: gap approaching the threshold
    if let Some(e) = edge {
        if e >= edge_thresh - 3.0 && e < edge_thresh && now - last_watch(eng) > 10_000 {
            set_last_watch(eng, now);
            let sig = SignalLog {
                id: next_id(eng, 'W'),
                ts: now,
                window_end: eng.window.lock().unwrap().end_epoch,
                fv: fv_v,
                ask: ask_c,
                edge,
                jump5s: jump,
                seconds_left: t_sec,
                action: "WATCH",
                reason: format!("gap {}¢ (needs {edge_thresh}¢)", round1(e)),
                fill_price: None,
                shares: None,
                stake: None,
            };
            push_signal(eng, sig);
        }
    }

    // momentum is there, but PM already repriced → SKIPPED
    if trig.jump && trig.above_floor {
        if let Some(e) = edge {
            if e < edge_thresh {
                skip_once(eng, "momentum, but PM already repriced", fv_v, jump, edge, t_sec, 8_000);
            }
        }
    }
}

// ── small helpers on shared state ──────────────────────────────────────────

use std::sync::atomic::AtomicU64;

static LAST_WATCH: std::sync::OnceLock<AtomicU64> = std::sync::OnceLock::new();
static LAST_SKIP_MS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    std::sync::OnceLock::new();

fn last_watch(eng: &std::sync::Arc<crate::Engine>) -> u64 {
    let _ = eng;
    LAST_WATCH.get_or_init(|| AtomicU64::new(0)).load(Ordering::Relaxed)
}

fn set_last_watch(eng: &std::sync::Arc<crate::Engine>, t: u64) {
    let _ = eng;
    LAST_WATCH
        .get_or_init(|| AtomicU64::new(0))
        .store(t, Ordering::Relaxed);
}

fn skip_once(
    eng: &std::sync::Arc<crate::Engine>,
    reason: &str,
    fv_v: f64,
    jump: f64,
    edge: Option<f64>,
    t_sec: f64,
    throttle_ms: u64,
) {
    let now = now_ms();
    let map = LAST_SKIP_MS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut g = map.lock().unwrap();
    if let Some(&t) = g.get(reason) {
        if now - t < throttle_ms {
            return;
        }
    }
    g.insert(reason.to_string(), now);
    drop(g);

    eng.stats.lock().unwrap().triggers_today += 1;
    let sig = SignalLog {
        id: next_id(eng, 'K'),
        ts: now,
        window_end: eng.window.lock().unwrap().end_epoch,
        fv: fv_v,
        ask: {
            let pm = eng.pm.lock().unwrap();
            pm.book.best_ask().map(|l| l.p * 100.0)
        },
        edge,
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

pub fn next_id(eng: &std::sync::Arc<crate::Engine>, prefix: char) -> String {
    let n = eng.signal_seq.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{prefix}{n}-{}", uid())
}

pub fn push_signal(eng: &std::sync::Arc<crate::Engine>, sig: SignalLog) {
    let v = sig.to_json();
    {
        let mut signals = eng.signals.lock().unwrap();
        signals.insert(0, sig);
        signals.truncate(120);
    }
    let mut msg = serde_json::json!({ "type": "signal" });
    for (k, val) in v.as_object().unwrap().iter() {
        msg[k.as_str()] = val.clone();
    }
    eng.emit(msg);
}

/// Re-exported for fire.rs symmetry.
pub fn model_of(m: FvModel) -> FvModel {
    m
}
