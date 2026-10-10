//! Trigger evaluation: the three AND conditions of the strategy spec.

use crate::stats::FvRing;

/// Three trigger conditions + combined.
#[derive(Debug, Clone, Copy, Default)]
pub struct Trig {
    /// ① FV jumped ≥ threshold within the trailing 5s.
    pub jump: bool,
    /// ② FV above the floor (default 60¢).
    pub above_floor: bool,
    /// ③ Polymarket ask ≥ threshold cheaper than FV (fresh book only).
    pub gap: bool,
}

impl Trig {
    pub fn all(&self) -> bool {
        self.jump && self.above_floor && self.gap
    }
}

/// Evaluate triggers. Returns (state, fv, jump5s, edge ¢).
pub fn evaluate(
    fv: f64,
    ring: &FvRing,
    now_ms: u64,
    ask_c: Option<f64>,
    book_fresh: bool,
    jump_thresh_c: f64,
    fv_floor_c: f64,
    edge_thresh_c: f64,
) -> (Trig, f64, Option<f64>) {
    let jump = ring.jump5s(now_ms);
    let edge = ask_c.map(|a| fv - a);
    let t = Trig {
        jump: jump >= jump_thresh_c,
        above_floor: fv > fv_floor_c,
        gap: match edge {
            Some(e) => book_fresh && e >= edge_thresh_c,
            None => false,
        },
    };
    (t, jump, edge)
}
