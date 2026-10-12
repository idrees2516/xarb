//! Deterministic scenario tests: the user's spec example, replayed through
//! the pure FvCore state machine + hot-word fire check — no network, no
//! threads, no flakiness.
//!
//! Spec example: strike 83,200 · BTC jumps 83,215→83,330 in 5s with ~2min
//! left · UP FV 55¢→77¢ · PM ask 56¢ (edge 21¢) → ALL THREE triggers fire.

use xarb_engine::hotcore::FvCore;
use xarb_engine::state::Settings;
use xarb_hft::hot::{QF_ALIVE, QF_VALID};
use xarb_hft::{FireHit, QuoteCell};

fn core_at(strike: f64, t0: u64, secs_left: u64) -> FvCore {
    let mut c = FvCore::new(t0);
    c.reload_settings(&Settings::default(), 1);
    c.set_window(strike, t0 + secs_left * 1000);
    c
}

fn up_cell(ask_c: u16, t: u64, valid: bool) -> QuoteCell {
    let flags = if valid { QF_VALID | QF_ALIVE } else { 0 };
    QuoteCell::pack(ask_c, ask_c.saturating_sub(2), (t & 0xFFFF) as u16, flags)
}

fn down_cell(ask_c: u16, t: u64, valid: bool) -> QuoteCell {
    up_cell(ask_c, t, valid)
}

/// Warm the FV history for ≥5s at `price` (recompute every 50ms).
/// PM cells are re-stamped at each step so the book stays fresh.
fn warm(c: &mut FvCore, price: f64, t_start: u64, ms: u64, up_ask: u16, dn_ask: u16) {
    let mut t = t_start;
    while t < t_start + ms {
        c.on_ev(xarb_feed::Ev::Quote { bid: price, ask: price }, t);
        c.fold_pm(up_cell(up_ask, t, true), down_cell(dn_ask, t, true), t);
        let _ = c.recompute(t, true, false);
        t += 50;
    }
}

#[test]
fn spec_example_fires_all_three_triggers() {
    let t0 = 1_700_000_000_000u64;
    let mut c = core_at(83_200.0, t0, 130);

    // 10s of calm at 83,215 → FV ≈ 53.5¢ (σ-floor 15.5, τ≈120s)
    warm(&mut c, 83_215.0, t0, 10_000, 56, 95);

    // …then the 5-second jump: 83,215 → 83,330 (PM ask still 56¢, fresh)
    let t_jump = t0 + 10_200;
    let mut fired_at = None;
    let mut t = t_jump;
    while t < t_jump + 5_000 {
        let frac = (t - t_jump) as f64 / 5_000.0;
        let price = 83_215.0 + frac * 115.0; // 83,215 → 83,330
        c.on_ev(xarb_feed::Ev::Quote { bid: price, ask: price }, t);
        c.fold_pm(up_cell(56, t, true), down_cell(95, t, true), t);
        let (word, full) = c.recompute(t, true, false);
        if fired_at.is_none() && word.fire_check() == FireHit::Up {
            fired_at = Some((t, full));
        }
        t += 50;
    }

    let (t, full) = fired_at.expect("UP fire expected in the jump window");
    // The three trigger conditions, asserted individually:
    assert!(full.jump_up >= 20.0, "jump {} < 20", full.jump_up);
    assert!(full.fv_up > 60.0, "fv {} ≤ 60", full.fv_up);
    let edge = full.edge_up.expect("edge");
    assert!(edge >= 10.0, "edge {} < 10", edge);
    // fire happens the moment jump crosses 20¢ (fv ≈ 73.5+), before the
    // full 78¢ peak — assert spec-scale magnitudes with that tolerance
    assert!(full.fv_up >= 73.0 && full.fv_up <= 79.0, "fv {}", full.fv_up);
    assert!(edge >= 17.0 && edge <= 23.0, "edge {edge}");
    // DOWN side does NOT fire (FV_DOWN ≈ 22 < 60). NOTE: recompute must use
    // a monotonically non-decreasing `now` (the engine's coarse clock is);
    // reusing the fire-time t here would move the jump pointer backwards.
    let t_end = t_jump + 5_000;
    let (word_end, _) = {
        c.on_ev(xarb_feed::Ev::Quote { bid: 83_330.0, ask: 83_330.0 }, t_end);
        c.fold_pm(up_cell(56, t_end, true), down_cell(95, t_end, true), t_end);
        c.recompute(t_end, true, false)
    };
    assert_eq!(word_end.fire_check(), FireHit::Up);
    assert!(word_end.fv_down_c() < 60);
}

#[test]
fn repriced_pm_blocks_fire() {
    let t0 = 1_700_000_000_000u64;
    let mut c = core_at(83_200.0, t0, 130);
    // PM reprices to 70¢ along the way — edge collapses below 10¢
    warm(&mut c, 83_215.0, t0, 10_000, 70, 95);

    let t_jump = t0 + 10_200;
    let mut t = t_jump;
    let mut ever_fired = false;
    while t < t_jump + 5_000 {
        let frac = (t - t_jump) as f64 / 5_000.0;
        let price = 83_215.0 + frac * 115.0;
        c.on_ev(xarb_feed::Ev::Quote { bid: price, ask: price }, t);
        c.fold_pm(up_cell(70, t, true), down_cell(95, t, true), t);
        let (word, full) = c.recompute(t, true, false);
        if word.fire_check() != FireHit::None {
            ever_fired = true;
        }
        // momentum + floor hold through the late jump; only the edge fails
        if frac > 0.5 {
            assert!(full.fv_up > 60.0);
        }
        t += 50;
    }
    assert!(!ever_fired, "repriced ask must block the fire");
}

#[test]
fn down_side_fires_symmetrically() {
    let t0 = 1_700_000_000_000u64;
    let mut c = core_at(83_200.0, t0, 130);
    // DOWN asks 55¢, UP asks 99
    // calm at 83,400 → FV_UP ≈ 88¢
    warm(&mut c, 83_400.0, t0, 10_000, 99, 55);

    // 5s crash: 83,400 → 83,100 → FV_UP ≈ 27.8¢, FV_DOWN ≈ 72.2¢
    let t_jump = t0 + 10_200;
    let mut fired = false;
    let mut t = t_jump;
    while t < t_jump + 5_000 {
        let frac = (t - t_jump) as f64 / 5_000.0;
        let price = 83_400.0 - frac * 300.0;
        c.on_ev(xarb_feed::Ev::Quote { bid: price, ask: price }, t);
        c.fold_pm(up_cell(99, t, true), down_cell(55, t, true), t);
        let (word, full) = c.recompute(t, true, false);
        if word.fire_check() == FireHit::Down {
            fired = true;
            assert!(full.fv_down > 60.0, "fv_down {}", full.fv_down);
            assert!(full.jump_up <= -20.0, "jump {}", full.jump_up);
            let edge_dn = full.edge_down.expect("edge down");
            assert!(edge_dn >= 10.0, "edge_dn {edge_dn}");
        }
        t += 50;
    }
    assert!(fired, "DOWN fire expected on the crash");
}

#[test]
fn stale_book_blocks_edge_trigger() {
    let t0 = 1_700_000_000_000u64;
    let mut c = core_at(83_200.0, t0, 130);
    // book stamped 60s ago (beyond any freshness budget) → PM_ALIVE/edge off
    let stale = up_cell(56, t0 - 60_000, true);
    let dn = down_cell(95, t0 - 60_000, true);
    // custom warm with FROZEN (stale) cells — freshness must decay
    let mut t = t0;
    while t < t0 + 10_000 {
        c.on_ev(xarb_feed::Ev::Quote { bid: 83_215.0, ask: 83_215.0 }, t);
        c.fold_pm(stale, dn, t);
        let _ = c.recompute(t, true, false);
        t += 50;
    }

    let t_jump = t0 + 10_200;
    let mut t = t_jump;
    let mut ever_fired = false;
    while t < t_jump + 5_000 {
        let frac = (t - t_jump) as f64 / 5_000.0;
        let price = 83_215.0 + frac * 115.0;
        c.on_ev(xarb_feed::Ev::Quote { bid: price, ask: price }, t);
        c.fold_pm(stale, dn, t);
        let (word, _) = c.recompute(t, true, false);
        if word.fire_check() != FireHit::None {
            ever_fired = true;
        }
        t += 50;
    }
    assert!(!ever_fired, "stale book must block trigger ③");
}

#[test]
fn closed_window_and_kill_flags() {
    let t0 = 1_700_000_000_000u64;
    let mut c = core_at(0.0, t0, 300);
    warm(&mut c, 83_215.0, t0, 10_000, 56, 40);
    let (word, _) = c.recompute(t0 + 10_000, true, false);
    assert_eq!(word.fire_check(), FireHit::None);
    assert!(!word.has(xarb_hft::hot::FLAG_WIN_OPEN));

    // window open but kill latched → FLAG_KILL set (strategy refuses to fire)
    let mut c2 = core_at(83_200.0, t0, 300);
    warm(&mut c2, 83_215.0, t0, 10_000, 56, 40);
    let (word2, _) = c2.recompute(t0 + 10_000, true, true);
    assert!(word2.has(xarb_hft::hot::FLAG_KILL));
}

#[test]
fn jump_reference_is_exactly_5s_old() {
    // two-point history: value at t0, then value 5.2s later — jump = Δ
    let t0 = 1_700_000_000_000u64;
    let mut c = core_at(83_200.0, t0, 130);
    c.on_ev(xarb_feed::Ev::Quote { bid: 83_215.0, ask: 83_215.0 }, t0);
    c.fold_pm(up_cell(56, t0, true), down_cell(40, t0, true), t0);
    let (w0, f0) = c.recompute(t0, true, false);
    // <5s of history → zero jump
    assert_eq!(f0.jump_up, 0.0);
    // 5.2s later, same PM, new price
    let t1 = t0 + 5_200;
    c.on_ev(xarb_feed::Ev::Quote { bid: 83_330.0, ask: 83_330.0 }, t1);
    c.fold_pm(up_cell(56, t1, true), down_cell(40, t1, true), t1);
    let (_, f1) = c.recompute(t1, true, false);
    // reference = the t0 sample (newest ≤ t1−5000) → jump ≈ 77.8−53.5
    assert!(f1.jump_up >= 20.0, "jump {}", f1.jump_up);
    assert!((f1.jump_up - (f1.fv_up - f0.fv_up)).abs() < 1.0);
    assert!(w0.fv_up_c() > 0);
}
