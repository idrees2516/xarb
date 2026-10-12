//! End-to-end THREAD-CHAIN test: hot word → strategy thread → fire ring →
//! executor thread → paper fill — the real production path, no network.

use arc_swap::ArcSwap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use xarb_core::{mono_ns, now_ms, Level};
use xarb_engine::executor;
use xarb_engine::hotcore::{FvFull, HotShared};
use xarb_engine::state::{LatencyStats, RiskState, Settings, SIDE_UP};
use xarb_engine::strategy;
use xarb_hft::hot::{FIRE_UP_MASK, QF_VALID};
use xarb_hft::{HotWord, QuoteCell, SpscRing, SpinMode, WakeSlot};
use xarb_poly::{PmOut, PmSnapshot, SideSnap};

#[tokio::test]
async fn strategy_to_executor_paper_chain() {
    let hot = Arc::new(HotShared::new());
    let pm = Arc::new(PmOut::new(Arc::new(WakeSlot::new())));
    let risk = Arc::new(RiskState::default());
    let settings = Arc::new(ArcSwap::from_pointee(Settings {
        auto_trade: true,
        stake_usd: 20.0,
        min_secs_left: 10.0,
        taker_fee_bps: 0.0,
        ..Settings::default()
    }));
    let lat = Arc::new(LatencyStats::default());
    let fire_ring = Arc::new(SpscRing::<xarb_engine::state::FireIntent>::with_capacity(64));

    let now = now_ms();
    // rich FV snapshot: fresh, strike loaded, τ = 100s
    hot.full.store(Arc::new(FvFull {
        t_ms: now,
        tau_s: 100.0,
        strike: 83_200.0,
        window_end: 12345,
        fv_up: 77.0,
        fv_down: 23.0,
        ..FvFull::default()
    }));
    // PM UP book: ask 56¢ × 200 shares (paper ladder to walk)
    pm.snap.store(Arc::new(PmSnapshot {
        t_ms: now,
        book_at_ms: now,
        up: SideSnap {
            ask: Some(56.0),
            ask_sz: 200.0,
            bid: Some(54.0),
            bid_sz: 150.0,
            asks: vec![Level { p: 56.0, s: 200.0 }],
            bids: vec![Level { p: 54.0, s: 150.0 }],
            valid: true,
        },
        ..PmSnapshot::default()
    }));
    // quote cell: fresh ask 56
    pm.up_cell
        .store(QuoteCell::pack(56, 54, (now & 0xFFFF) as u16, QF_VALID).0, Ordering::Release);

    // channels + wake slots
    let (signal_tx, _signal_rx) = tokio::sync::mpsc::unbounded_channel();
    let (fill_tx, mut fill_rx) = tokio::sync::mpsc::unbounded_channel();
    let exec_wake = Arc::new(WakeSlot::new());

    // executor thread (paper mode)
    let clob = Arc::new(tokio::sync::Mutex::new(xarb_poly::ClobClient::paper()));
    let exec_jh = executor::spawn_executor(
        fire_ring.clone(),
        hot.clone(),
        pm.clone(),
        risk.clone(),
        settings.clone(),
        lat.clone(),
        fill_tx,
        clob,
        false,   // neg_risk
        false,   // paper
        SpinMode::Eco,
        None,
    );
    exec_wake.set(xarb_hft::Unparker::new(exec_jh.thread().clone()));

    // strategy thread
    let strat_jh = strategy::spawn_strategy(
        hot.clone(),
        pm.clone(),
        risk.clone(),
        settings.clone(),
        lat.clone(),
        signal_tx,
        fire_ring.clone(),
        exec_wake.clone(),
        SpinMode::Eco,
        None,
    );
    // arm the strategy wake so the word store wakes it immediately
    hot_word_wake_arm(&strat_jh);

    // ── publish the FIRE word (all three triggers satisfied) ──────────────
    let word = HotWord::pack(77, 23, 22, FIRE_UP_MASK);
    hot.word_t.store(mono_ns(), Ordering::Release);
    hot.word.store(word.0, Ordering::Release);

    // fill must arrive within 5s (park-wake chain: strategy → executor)
    let fill = tokio::time::timeout(Duration::from_secs(5), fill_rx.recv())
        .await
        .expect("fill timeout")
        .expect("fill channel closed");
    assert_eq!(fill.outcome, 0, "expected paper fill, reason={}", fill.reason);
    assert_eq!(fill.intent.side, SIDE_UP);
    assert!(fill.shares > 30.0, "shares {}", fill.shares);
    assert!((fill.fill_price_c.unwrap() - 56.0).abs() < 0.01, "fill px {:?}", fill.fill_price_c);
    assert!(fill.cost_usd > 0.0 && fill.cost_usd <= 20.0 + 1e-6);
    // risk counters advanced
    assert_eq!(risk.window_trades.load(Ordering::Relaxed), 1);
    assert_eq!(risk.open_trades.load(Ordering::Relaxed), 1);

    // latency chain recorded: detect + decide + fire. The decide record
    // lands AFTER the ring push that produced the fill, so yield first.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(lat.detect.count() >= 1);
    assert!(lat.decide.count() >= 1);
    assert!(lat.fire.count() >= 1);
}

fn hot_word_wake_arm(jh: &std::thread::JoinHandle<()>) {
    // the strategy thread parks; unpark via its handle so the word store
    // wakes it — replicating what the FV thread's WakeSlot does
    let t = jh.thread().clone();
    // fire once now (token) — thread may not be parked yet, token persists
    t.unpark();
}

#[tokio::test]
async fn executor_rejects_repriced_intents() {
    // intent says edge 21¢ but by execution time the ask repriced to 76¢
    // (half-edge tolerance: needs ≥ 10.5¢) → SKIP with R_REPRICED
    let hot = Arc::new(HotShared::new());
    let pm = Arc::new(PmOut::new(Arc::new(WakeSlot::new())));
    let risk = Arc::new(RiskState::default());
    let settings = Arc::new(ArcSwap::from_pointee(Settings {
        stake_usd: 20.0,
        min_secs_left: 10.0,
        edge_thresh_c: 10.0,
        ..Settings::default()
    }));
    let lat = Arc::new(LatencyStats::default());
    let fire_ring = Arc::new(SpscRing::<xarb_engine::state::FireIntent>::with_capacity(8));
    let (fill_tx, mut fill_rx) = tokio::sync::mpsc::unbounded_channel();

    let now = now_ms();
    hot.full.store(Arc::new(FvFull {
        t_ms: now,
        tau_s: 100.0,
        strike: 83_200.0,
        window_end: 12345,
        fv_up: 77.0,
        ..FvFull::default()
    }));
    // book NOW asks 76 — edge at fire time is only 1¢ (needs ≥ 5 by half rule)
    pm.snap.store(Arc::new(PmSnapshot {
        t_ms: now,
        book_at_ms: now,
        up: SideSnap {
            ask: Some(76.0),
            asks: vec![Level { p: 76.0, s: 200.0 }],
            valid: true,
            ..SideSnap::default()
        },
        ..PmSnapshot::default()
    }));

    let intent = xarb_engine::state::FireIntent {
        t_mono_ns: mono_ns(),
        ts_ms: now,
        side: 0,
        fv: 77.0,
        ask: 56.0,
        jump: 22.0,
        edge: 21.0,
        t_sec: 100.0,
        strike: 83_200.0,
        window_end: 12345,
        stake_usd: 20.0,
        fee_bps: 0.0,
        ..Default::default()
    };
    fire_ring.try_push(intent);

    let clob = Arc::new(tokio::sync::Mutex::new(xarb_poly::ClobClient::paper()));
    let jh = executor::spawn_executor(
        fire_ring.clone(),
        hot.clone(),
        pm.clone(),
        risk.clone(),
        settings.clone(),
        lat.clone(),
        fill_tx,
        clob,
        false,
        false, // paper
        SpinMode::Eco,
        None,
    );
    let t = jh.thread().clone();
    t.unpark();

    let fill = tokio::time::timeout(Duration::from_secs(5), fill_rx.recv())
        .await
        .expect("timeout")
        .expect("closed");
    assert_eq!(fill.outcome, 1);
    assert_eq!(fill.reason, xarb_engine::state::R_REPRICED);
    // no trade claimed
    assert_eq!(risk.window_trades.load(Ordering::Relaxed), 0);
}
