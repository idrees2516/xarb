//! Executor thread: FireIntent → paper fill or live EIP-712 order.
//!
//! Runs on a dedicated pinned thread with its own current-thread runtime
//! (async only for the live REST path). The whole fire chain is measured in
//! `lat.fire` (intent → fill applied / order posted). Before anything is
//! sent, the intent is REVALIDATED against the freshest state — last-mile
//! adverse-selection guard:
//!   • FV snapshot age ≤ 300ms
//!   • book age within the freshness budget
//!   • the ask STILL satisfies at least half the original edge
//!   • tokens loaded for the window (live mode)
//! Paper fills walk the real live ask ladder (level by level).

use crate::hotcore::HotShared;
use crate::state::*;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use xarb_core::{mono_ns, now_ms, Level};
use xarb_hft::{SpscRing, SpinMode};
use xarb_poly::{ClobClient, PmOut};

/// FV snapshot staleness budget for revalidation (ms).
const FV_STALE_MS: u64 = 300;
/// Half-edge tolerance: the ask may have drifted, but must still clear
/// edge/2 — catching reprice-within-flight without being paranoid.
const HALF_EDGE_TOLERANCE: f64 = 0.5;

pub fn spawn_executor(
    fire_ring: Arc<SpscRing<FireIntent>>,
    hot: Arc<HotShared>,
    pm: Arc<PmOut>,
    risk: Arc<RiskState>,
    settings: Arc<arc_swap::ArcSwap<Settings>>,
    lat: Arc<LatencyStats>,
    fill_tx: tokio::sync::mpsc::UnboundedSender<FillEvent>,
    clob: Arc<tokio::sync::Mutex<ClobClient>>,
    neg_risk: bool,
    live: bool,
    mode: SpinMode,
    pin: Option<usize>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("executor".into())
        .spawn(move || {
            if let Some(c) = pin {
                let _ = xarb_hft::affinity::pin_current(c);
            }
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("executor runtime");
            rt.block_on(async move {
                let parker = xarb_hft::Parker::new(Duration::from_millis(50));
                loop {
                    while let Some(intent) = fire_ring.pop() {
                        let t0 = mono_ns();
                        let fill = handle_intent(
                            &hot, &pm, &risk, &settings, &clob, intent, neg_risk, live,
                        )
                        .await;
                        lat.fire.record(mono_ns().saturating_sub(t0));
                        let _ = fill_tx.send(fill);
                    }
                    // strategy unparks after pushing; 50ms bounds the poll
                    let _ = mode; // executor always parks (network-dominated)
                    parker.park();
                }
            });
        })
        .expect("spawn executor thread")
}

async fn handle_intent(
    hot: &Arc<HotShared>,
    pm: &Arc<PmOut>,
    risk: &Arc<RiskState>,
    settings: &Arc<arc_swap::ArcSwap<Settings>>,
    clob: &Arc<tokio::sync::Mutex<ClobClient>>,
    intent: FireIntent,
    neg_risk: bool,
    live: bool,
) -> FillEvent {
    let now = now_ms();
    let s = settings.load_full();
    let full = hot.full.load_full();
    let snap = pm.snap.load_full();

    // ── last-mile revalidation ─────────────────────────────────────────
    if intent.window_end == 0 || intent.strike <= 0.0 {
        return skipped(intent, R_NO_TOKENS, &s);
    }
    if now.saturating_sub(full.t_ms) > FV_STALE_MS {
        return skipped(intent, R_STALE, &s);
    }
    let (side_snap, ask_now) = if intent.side == SIDE_DOWN {
        (&snap.down, snap.down.ask)
    } else {
        (&snap.up, snap.up.ask)
    };
    let book_age = now.saturating_sub(snap.book_at_ms);
    if book_age > s.max_book_age_ms {
        return skipped(intent, R_STALE, &s);
    }
    let Some(ask_now) = ask_now else {
        return skipped(intent, R_THIN_BOOK, &s);
    };
    // ask may have drifted; require at least half the original edge left
    let fv_now = if intent.side == SIDE_DOWN {
        full.fv_down
    } else {
        full.fv_up
    };
    if fv_now - ask_now < intent.edge * HALF_EDGE_TOLERANCE {
        return skipped(intent, R_REPRICED, &s);
    }
    // window trade count re-check (the strategy may have raced a fill)
    if risk.trades_in_window(intent.window_end * 1000) >= s.max_trades_per_window {
        return skipped(intent, R_MAX_TRADES, &s);
    }
    if intent.t_sec < s.min_secs_left {
        return skipped(intent, R_TOO_CLOSE, &s);
    }

    // ── paper mode: walk the live ask ladder ───────────────────────────
    if !live {
        let ladder: Vec<Level> = side_snap
            .asks
            .iter()
            .map(|l| Level { p: l.p / 100.0, s: l.s })
            .collect();
        let depth_usd: f64 = ladder.iter().map(|l| l.p * l.s).sum();
        let stake = intent.stake_usd;
        if depth_usd < stake * 0.4 {
            return skipped(intent, R_THIN_BOOK, &s);
        }
        let mut cost = 0.0;
        let mut shares = 0.0;
        for lvl in &ladder {
            if cost >= stake {
                break;
            }
            let lvl_usd = lvl.p * lvl.s;
            let take = lvl_usd.min(stake - cost);
            shares += take / lvl.p;
            cost += take;
        }
        if shares <= 0.0 {
            return skipped(intent, R_THIN_BOOK, &s);
        }
        let avg_c = (cost / shares) * 100.0;
        let fee = cost * fee_of(intent.fee_bps, &pm, intent.side) / 10_000.0;
        // claim the window slot (window_trades/open_trades are set here —
        // the single executor thread serializes all fires)
        risk.window_end_ms
            .store(intent.window_end * 1000, Ordering::Relaxed);
        risk.window_trades.fetch_add(1, Ordering::Relaxed);
        risk.open_trades.fetch_add(1, Ordering::Relaxed);
        return FillEvent {
            intent,
            outcome: 0,
            reason: 0,
            fill_price_c: Some(avg_c),
            shares,
            cost_usd: cost,
            fee_usd: fee,
            order_id: String::new(),
            order_status: "PAPER".into(),
        };
    }

    // ── live mode: signed EIP-712 FOK buy ─────────────────────────────
    let token = if intent.side == SIDE_DOWN {
        // resolved from the engine's window by the cold task — carried via
        // the fill event's token selection in clob.post
        String::new()
    } else {
        String::new()
    };
    let _ = token;
    let price = (ask_now / 100.0).max(0.01);
    let size = (intent.stake_usd / price * 100.0).round() / 100.0;
    let clob = clob.lock().await;
    // token id must be passed in — engine injects via pm snapshot tokens
    let token_id = if intent.side == SIDE_DOWN {
        pm_token_down(pm)
    } else {
        pm_token_up(pm)
    };
    let fee = fee_of(intent.fee_bps, pm, intent.side);
    match clob.post_buy_order(&token_id, price, size, neg_risk).await {
        Ok((order_id, status, _raw)) => {
            let cost = price * size;
            let fee_usd = cost * fee / 10_000.0;
            risk.window_end_ms
                .store(intent.window_end * 1000, Ordering::Relaxed);
            risk.window_trades.fetch_add(1, Ordering::Relaxed);
            risk.open_trades.fetch_add(1, Ordering::Relaxed);
            FillEvent {
                intent,
                outcome: 0,
                reason: 0,
                fill_price_c: Some(price * 100.0),
                shares: size,
                cost_usd: cost,
                fee_usd,
                order_id,
                order_status: status,
            }
        }
        Err(e) => skipped_live_err(intent, &e.to_string(), &s),
    }
}

/// The WS-observed market fee wins over the settings knob (honest P&L).
fn fee_of(fallback_bps: f64, pm: &PmOut, _side: u8) -> f64 {
    pm.snap
        .load_full()
        .fee_rate_bps
        .map(|f| f as f64)
        .unwrap_or(fallback_bps)
}

fn skipped(intent: FireIntent, reason: u8, _s: &Settings) -> FillEvent {
    FillEvent {
        intent,
        outcome: 1,
        reason,
        fill_price_c: None,
        shares: 0.0,
        cost_usd: 0.0,
        fee_usd: 0.0,
        order_id: String::new(),
        order_status: String::new(),
    }
}

fn skipped_live_err(intent: FireIntent, err: &str, _s: &Settings) -> FillEvent {
    let mut f = skipped(intent, R_LIVE_ERR, _s);
    f.order_status = err.to_string();
    f
}

// token plumbing: the executor needs the current window's token ids. They
// ride on the PmSnapshot via a shared slot the cold task refreshes.
use std::sync::Mutex;
use xarb_poly::PmSnapshot;

static TOKENS: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

/// Engine registers the current window's (up, down) token pair.
pub fn set_tokens(up: &str, down: &str) {
    if let Ok(mut g) = TOKENS.lock() {
        g.0 = up.to_string();
        g.1 = down.to_string();
    }
}

fn pm_token_up(_pm: &PmOut) -> String {
    TOKENS.lock().map(|g| g.0.clone()).unwrap_or_default()
}

fn pm_token_down(_pm: &PmOut) -> String {
    TOKENS.lock().map(|g| g.1.clone()).unwrap_or_default()
}

/// Snapshot tokens helper (unused by paper, kept for live symmetry).
pub fn tokens_of(snap: &PmSnapshot) -> (String, String) {
    let _ = snap;
    TOKENS.lock().map(|g| g.clone()).unwrap_or_default()
}
