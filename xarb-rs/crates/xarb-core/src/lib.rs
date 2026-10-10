//! xarb-core — fair-value models, order book, trigger state, latency stats.
//!
//! Shared numeric core of the XARB cross-exchange arbitrage engine.
//! Model spec (user example, T=120s): strike 83,200 · BTC 83,215 → UP ≈ 55¢ ·
//! BTC 83,330 → UP ≈ 77¢. Two models:
//!   Linear:    FV = 52 + 0.19·(S−K) — legacy spec calibration
//!   NormalCdf: P(UP) = Φ((S−K)/(σ_eff·√T)) with σ-floor 15.5 pts/√s
//!              (+130 pts, T=120 → 77.8¢ ✓ · +15 pts → 53.5¢ ≈ 55¢)

pub mod book;
pub mod coarse;
pub mod fv;
pub mod stats;
pub mod trigger;
pub mod types;

pub use book::Book;
pub use coarse::{mono_ns, now_ms, start_coarse_clock};
pub use fv::{fv, sigma_eff, FvModel, FvOut, SIGMA_CAP_PTS, SIGMA_FLOOR_PTS};
pub use stats::{percentile, FvRing, Ring};
pub use trigger::Trig;
pub use types::{Level, Side};

/// Unix time in milliseconds — coarse-clock fast path (see `coarse`).
#[inline]
pub fn legacy_wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Window length of the Polymarket 5-minute BTC UP/DOWN series (seconds).
pub const WINDOW_SEC: u64 = 300;

/// Current 5-minute-aligned window epoch (inclusive start, seconds).
pub fn current_window_epoch(now_ms: u64) -> u64 {
    (now_ms / 1000 / WINDOW_SEC) * WINDOW_SEC
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cdf_matches_spec_example() {
        // user's example: +130 pts with T=120 → 77¢
        let out = fv(83_330.0, 83_200.0, 120.0, 7.5, FvModel::NormalCdf);
        assert!((out.value - 77.8).abs() < 0.4, "got {}", out.value);
        // +15 pts → ≈55¢ (spec) — calibrated floor gives 53.5
        let out = fv(83_215.0, 83_200.0, 120.0, 7.5, FvModel::NormalCdf);
        assert!((out.value - 53.5).abs() < 0.3, "got {}", out.value);
    }

    #[test]
    fn cdf_deep_otm_keeps_time_value() {
        // 300 pts OTM (≈2.5σ) with 60s left → true P(UP) ≈ 0.6%, floored at
        // the 1¢ quoting floor. Honest: nonzero tail, bounded — the raw linear
        // spec gives 52 − 0.27·300 = −29 before its own clamp.
        let cdf = fv(82_900.0, 83_200.0, 60.0, 7.5, FvModel::NormalCdf);
        assert!(cdf.value >= 1.0 && cdf.value < 2.0, "cdf deep-OTM {}", cdf.value);
        // 1.25σ OTM → ≈10.6¢ of genuine tail time value
        let mid = fv(83_050.0, 83_200.0, 60.0, 7.5, FvModel::NormalCdf);
        assert!((mid.value - 10.6).abs() < 0.5, "1.25σ OTM {}", mid.value);
    }

    #[test]
    fn window_epoch_aligns() {
        assert_eq!(current_window_epoch(1_791_551_700_000), 1_791_551_700);
        assert_eq!(current_window_epoch(1_791_551_999_000), 1_791_551_700);
    }
}
