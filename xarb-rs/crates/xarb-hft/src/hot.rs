//! Hot-word and quote-cell bit packing.
//!
//! THE core latency trick: every trigger input the strategy needs is packed
//! into a single u64. The strategy thread evaluates the full 3-condition
//! conjunction for BOTH sides with one atomic load, one AND and one compare —
//! no locks, no allocation, no dependent loads. The FV engine thread is the
//! SOLE writer (Release store), so readers need only an Acquire load.
//!
//! HotWord layout (u64):
//! ```text
//!   bits  0..16  fv_up_c      u16   fair value of UP, cents (0 = invalid)
//!   bits 16..32  fv_down_c    u16   100 − fv_up (binary complement)
//!   bits 32..48  jump_up_c    i16   trailing-5s FV jump, cents (signed)
//!   bits 48..64  flags        u16   see FLAG_* below
//! ```
//!
//! QuoteCell layout (u64, written by the Polymarket feed thread):
//! ```text
//!   bits  0..16  ask_c        u16   best ask, cents (0xFFFF = no ask)
//!   bits 16..32  bid_c        u16   best bid, cents (0xFFFF = no bid)
//!   bits 32..48  ts16         u16   epoch-ms & 0xFFFF of the last book event
//!   bits 48..64  flags        u16   QF_VALID | QF_ALIVE
//! ```
//! Freshness is READ-side: the consumer computes age from its own clock via
//! `age_ms(now)` (16-bit wrap window = 65.5s, disambiguated up to 32.7s —
//! far beyond any sane book-staleness budget), so a frozen cell can never
//! masquerade as fresh.

/// Window is open: strike loaded and time remaining > 0.
pub const FLAG_WIN_OPEN: u16 = 1 << 0;
/// Binance feed alive (last event < staleness budget).
pub const FLAG_BIN_ALIVE: u16 = 1 << 1;
/// Polymarket book fresh (age < max_book_age setting).
pub const FLAG_PM_ALIVE: u16 = 1 << 2;
/// τ ≥ min_secs_left guard.
pub const FLAG_MIN_SECS_OK: u16 = 1 << 3;
/// Trigger ① UP: trailing-5s FV jump ≥ jump threshold.
pub const FLAG_TRIG_JUMP_UP: u16 = 1 << 4;
/// Trigger ② UP: FV above floor.
pub const FLAG_TRIG_FLOOR_UP: u16 = 1 << 5;
/// Trigger ③ UP: ask ≤ FV − edge (fresh, valid ask).
pub const FLAG_TRIG_EDGE_UP: u16 = 1 << 6;
/// Trigger ① DOWN: trailing-5s FV drop ≥ threshold.
pub const FLAG_TRIG_JUMP_DN: u16 = 1 << 7;
/// Trigger ② DOWN: FV_DOWN above floor.
pub const FLAG_TRIG_FLOOR_DN: u16 = 1 << 8;
/// Trigger ③ DOWN: ask_down ≤ FV_DOWN − edge.
pub const FLAG_TRIG_EDGE_DN: u16 = 1 << 9;
/// Risk kill-switch latched (daily loss / manual stop).
pub const FLAG_KILL: u16 = 1 << 10;
/// Ask side present (UP).
pub const FLAG_ASK_UP_VALID: u16 = 1 << 11;
/// Ask side present (DOWN).
pub const FLAG_ASK_DN_VALID: u16 = 1 << 12;
/// Auto-trade enabled.
pub const FLAG_AUTOTRADE: u16 = 1 << 13;

/// All preconditions + all three UP triggers.
pub const FIRE_UP_MASK: u16 = FLAG_WIN_OPEN
    | FLAG_BIN_ALIVE
    | FLAG_PM_ALIVE
    | FLAG_MIN_SECS_OK
    | FLAG_TRIG_JUMP_UP
    | FLAG_TRIG_FLOOR_UP
    | FLAG_TRIG_EDGE_UP
    | FLAG_AUTOTRADE;

/// All preconditions + all three DOWN triggers.
pub const FIRE_DN_MASK: u16 = FLAG_WIN_OPEN
    | FLAG_BIN_ALIVE
    | FLAG_PM_ALIVE
    | FLAG_MIN_SECS_OK
    | FLAG_TRIG_JUMP_DN
    | FLAG_TRIG_FLOOR_DN
    | FLAG_TRIG_EDGE_DN
    | FLAG_AUTOTRADE;

pub const NO_ASK: u16 = 0xFFFF;

/// Bit-packed hot state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HotWord(pub u64);

impl HotWord {
    #[inline]
    pub fn pack(fv_up_c: u16, fv_down_c: u16, jump_up_c: i16, flags: u16) -> HotWord {
        HotWord(
            (fv_up_c as u64)
                | ((fv_down_c as u64) << 16)
                | (((jump_up_c as u16) as u64) << 32)
                | ((flags as u64) << 48),
        )
    }

    #[inline]
    pub fn fv_up_c(&self) -> u16 {
        self.0 as u16
    }

    #[inline]
    pub fn fv_down_c(&self) -> u16 {
        (self.0 >> 16) as u16
    }

    #[inline]
    pub fn jump_up_c(&self) -> i16 {
        ((self.0 >> 32) as u16) as i16
    }

    #[inline]
    pub fn jump_down_c(&self) -> i16 {
        -self.jump_up_c()
    }

    #[inline]
    pub fn flags(&self) -> u16 {
        (self.0 >> 48) as u16
    }

    #[inline]
    pub fn has(&self, flags: u16) -> bool {
        self.flags() & flags == flags
    }

    /// Branchless dual-side fire check: (side, fv, jump, ask_side_c) on match.
    #[inline]
    pub fn fire_check(&self) -> FireHit {
        let f = self.flags();
        if f & FIRE_UP_MASK == FIRE_UP_MASK {
            return FireHit::Up;
        }
        if f & FIRE_DN_MASK == FIRE_DN_MASK {
            return FireHit::Down;
        }
        FireHit::None
    }
}

/// Which side fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FireHit {
    None,
    Up,
    Down,
}

// ── QuoteCell ───────────────────────────────────────────────────────────────

pub const QF_VALID: u16 = 1 << 0; // top-of-book present
pub const QF_ALIVE: u16 = 1 << 1; // socket live

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct QuoteCell(pub u64);

impl QuoteCell {
    /// `ts16` = low 16 bits of the epoch-ms timestamp of the last book
    /// event (NOT publish time) — readers derive age against their clock.
    #[inline]
    pub fn pack(ask_c: u16, bid_c: u16, ts16: u16, flags: u16) -> QuoteCell {
        QuoteCell(
            (ask_c as u64)
                | ((bid_c as u64) << 16)
                | ((ts16 as u64) << 32)
                | ((flags as u64) << 48),
        )
    }

    #[inline]
    pub fn ask_c(&self) -> u16 {
        self.0 as u16
    }

    #[inline]
    pub fn bid_c(&self) -> u16 {
        (self.0 >> 16) as u16
    }

    /// Low 16 bits of the last book-event epoch-ms.
    #[inline]
    pub fn ts16(&self) -> u16 {
        (self.0 >> 32) as u16
    }

    /// Age of this book state in ms, computed against the reader's `now_ms`
    /// (wrap-safe to 32.7s; beyond that → stale). Invalid cells report as
    /// ancient so they can never look fresh.
    #[inline]
    pub fn age_ms(&self, now_ms: u64) -> u16 {
        if self.flags() & QF_VALID == 0 {
            return u16::MAX;
        }
        let dt = (now_ms as u16).wrapping_sub(self.ts16());
        if dt >= 0x8000 {
            u16::MAX // ambiguous wrap → stale
        } else {
            dt
        }
    }

    #[inline]
    pub fn flags(&self) -> u16 {
        (self.0 >> 48) as u16
    }

    /// Ask in cents, None when absent.
    #[inline]
    pub fn ask_opt(&self) -> Option<u16> {
        let a = self.ask_c();
        if a == NO_ASK {
            None
        } else {
            Some(a)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotword_roundtrip_all_fields() {
        let w = HotWord::pack(77, 23, -21, FLAG_WIN_OPEN | FLAG_TRIG_JUMP_UP | FLAG_KILL);
        assert_eq!(w.fv_up_c(), 77);
        assert_eq!(w.fv_down_c(), 23);
        assert_eq!(w.jump_up_c(), -21);
        assert_eq!(w.jump_down_c(), 21);
        assert!(w.has(FLAG_WIN_OPEN));
        assert!(w.has(FLAG_TRIG_JUMP_UP));
        assert!(!w.has(FLAG_TRIG_EDGE_UP));
        assert!(w.has(FLAG_KILL));
    }

    #[test]
    fn fire_masks_are_exclusive_per_side() {
        // fire UP but not DOWN
        let up_flags = FIRE_UP_MASK;
        let w = HotWord::pack(77, 23, 22, up_flags);
        assert_eq!(w.fire_check(), FireHit::Up);
        // fire DOWN
        let dn_flags = FIRE_DN_MASK;
        let w = HotWord::pack(23, 77, -22, dn_flags);
        assert_eq!(w.fire_check(), FireHit::Down);
        // nothing when any trigger missing
        let mut f = FIRE_UP_MASK;
        f &= !FLAG_TRIG_EDGE_UP;
        assert_eq!(HotWord::pack(77, 23, 22, f).fire_check(), FireHit::None);
        // kill blocks fire (kill not part of masks; strategy checks it)
        assert!(HotWord::pack(77, 23, 22, FIRE_UP_MASK | FLAG_KILL).has(FLAG_KILL));
    }

    #[test]
    fn quote_cell_roundtrip_and_reader_side_age() {
        let q = QuoteCell::pack(56, 54, 3_000, QF_VALID | QF_ALIVE);
        assert_eq!(q.ask_c(), 56);
        assert_eq!(q.bid_c(), 54);
        assert_eq!(q.ts16(), 3_000);
        assert_eq!(q.flags(), QF_VALID | QF_ALIVE);
        assert_eq!(q.ask_opt(), Some(56));
        let empty = QuoteCell::pack(NO_ASK, NO_ASK, 0, 0);
        assert_eq!(empty.ask_opt(), None);
        // reader-side freshness: same epoch → 0 age
        assert_eq!(q.age_ms(3_000), 0);
        assert_eq!(q.age_ms(3_250), 250);
        // 16-bit wrap: ts 65_500, now 300 → age 300 (wrapped correctly)
        let w = QuoteCell::pack(1, 1, (65_500u64 & 0xFFFF) as u16, QF_VALID);
        assert_eq!(w.age_ms(65_800), 300);
        // beyond the 32.7s disambiguation window → stale
        assert_eq!(w.age_ms(65_500 + 40_000), u16::MAX);
        // invalid cells are always stale, even at matching timestamps
        let inv = QuoteCell::pack(NO_ASK, 1, 100, 0);
        assert_eq!(inv.age_ms(100), u16::MAX);
    }

    #[test]
    fn flags_fit_in_u16() {
        assert!(FLAG_ASK_DN_VALID < (1 << 15)); // highest defined flag fits
        assert_eq!(FIRE_UP_MASK & FLAG_TRIG_JUMP_DN, 0); // sides disjoint
        assert_eq!(FIRE_DN_MASK & FLAG_TRIG_JUMP_UP, 0);
    }
}
