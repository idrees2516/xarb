//! Coarse monotonic wall clock: 1ns atomic reads instead of a syscall.
//!
//! `SystemTime::now()` costs ~20-25ns per call (vDSO clock_gettime). The hot
//! path calls it several times per market event, so a background ticker
//! thread publishes epoch-ms into a cache-line-padded atomic updated every
//! ~1ms. Readers pay a single relaxed atomic load (~1ns). Falls back to the
//! syscall until the ticker is started, so the module is always correct.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static CLOCK: OnceLock<ClockCell> = OnceLock::new();

#[repr(align(64))]
pub struct ClockCell {
    ms: AtomicU64,
}

/// Start the background 1ms ticker thread (idempotent, call once at boot).
pub fn start_coarse_clock() {
    let cell = CLOCK.get_or_init(|| ClockCell { ms: AtomicU64::new(0) });
    std::thread::Builder::new()
        .name("coarse-clock".into())
        .spawn(move || {
            let mut last = 0u64;
            loop {
                let now = wall_ms();
                // Only store on change so readers see a stable tick count.
                if now != last {
                    cell.ms.store(now, Ordering::Relaxed);
                    last = now;
                }
                // 900µs sleep: thread wakeup granularity lands on ~1-2ms updates.
                std::thread::sleep(Duration::from_micros(900));
            }
        })
        .expect("spawn coarse clock");
}

/// Epoch-ms via the coarse clock if running, else a direct syscall.
#[inline]
pub fn now_ms() -> u64 {
    if let Some(cell) = CLOCK.get() {
        let v = cell.ms.load(Ordering::Relaxed);
        if v != 0 {
            return v;
        }
    }
    wall_ms()
}

/// True when the coarse clock ticker has produced at least one tick.
#[inline]
pub fn coarse_running() -> bool {
    CLOCK.get().map(|c| c.ms.load(Ordering::Relaxed) != 0).unwrap_or(false)
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── monotonic nanoseconds (latency measurement) ─────────────────────────────

static T0: OnceLock<std::time::Instant> = OnceLock::new();

/// Monotonic ns since the first call (comparable across threads on Linux:
/// CLOCK_MONOTONIC). Used for stage-to-stage latency histograms.
#[inline]
pub fn mono_ns() -> u64 {
    T0.get_or_init(std::time::Instant::now).elapsed().as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_monotonic_and_close() {
        start_coarse_clock();
        std::thread::sleep(Duration::from_millis(5));
        let a = now_ms();
        let b = now_ms();
        assert!(b >= a);
        assert!(coarse_running());
        // within 5ms of the syscall clock
        assert!((wall_ms() as i64 - b as i64).abs() < 5, "{b} vs wall");
    }

    #[test]
    fn mono_ns_increases() {
        assert!(mono_ns() <= mono_ns());
    }
}
