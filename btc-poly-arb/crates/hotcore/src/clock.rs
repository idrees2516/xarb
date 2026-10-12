//! Cycle-accurate clock.
//!
//! `rdtscp` gives sub-nanosecond resolution (~0.3 ns per tick on typical cloud
//! hardware). We calibrate cycles->nanoseconds against `Instant` once, at
//! startup, and thereafter timestamps cost a single instruction + arithmetic.
//!
//! The wall-clock anchor (`SystemTime` at calibration) is exposed for
//! exchange-event timestamp comparisons; monotonic nanoseconds since origin
//! drive all latency math.

use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct Clock {
    /// nanoseconds per cycle
    ns_per_cycle: f64,
    origin_mono: Instant,
    /// cycles at origin (approximately; see `calibrate`)
    origin_cycles: u64,
    /// unix nanoseconds at origin
    origin_unix_ns: i64,
}

static CLOCK: OnceLock<Clock> = OnceLock::new();

#[cfg(target_arch = "x86_64")]
#[inline(always)]
pub fn rdtscp() -> u64 {
    // SAFETY: rdtscp exists on all x86_64 CPUs with SSE2 (baseline for Rust).
    // The aux value is written by the CPU (TSC_AUX); we only need the cycle count.
    unsafe {
        let mut aux: u32 = 0;
        std::arch::x86_64::__rdtscp(&mut aux)
    }
}

#[cfg(not(target_arch = "x86_64"))]
#[inline(always)]
pub fn rdtscp() -> u64 {
    // software fallback: ~20-40ns, still monotonic
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    CTR.fetch_add(1, Ordering::Relaxed)
}

/// Calibrate and install the global clock. Safe to call multiple times.
pub fn init() -> &'static Clock {
    CLOCK.get_or_init(|| {
        let t0 = Instant::now();
        let c0 = rdtscp();
        // spin ~50ms for a stable ratio
        let spin_target = Duration::from_millis(50);
        let mut now = t0;
        while now.duration_since(t0) < spin_target {
            now = Instant::now();
        }
        let c1 = rdtscp();
        let dt = now.duration_since(t0).as_secs_f64() * 1e9;
        let dc = (c1 - c0) as f64;
        let ns_per_cycle = if dc > 0.0 { dt / dc } else { 1.0 };
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        Clock {
            ns_per_cycle,
            origin_mono: t0,
            origin_cycles: c0,
            origin_unix_ns: unix,
        }
    })
}

impl Clock {
    pub fn global() -> &'static Clock {
        CLOCK.get().unwrap_or_else(|| init())
    }

    /// Monotonic nanoseconds since process clock origin.
    #[inline(always)]
    pub fn mono_ns(&self) -> i64 {
        self.cycles_to_ns(rdtscp().wrapping_sub(self.origin_cycles)) as i64
    }

    /// Cycles -> nanoseconds since origin.
    #[inline(always)]
    pub fn cycles_to_ns(&self, cycles: u64) -> f64 {
        cycles as f64 * self.ns_per_cycle
    }

    /// Cycle count now.
    #[inline(always)]
    pub fn cycles(&self) -> u64 {
        rdtscp()
    }

    /// Unix epoch milliseconds (for exchange timestamps).
    #[inline]
    pub fn unix_ms(&self) -> i64 {
        self.mono_ns() / 1_000_000 + self.origin_unix_ns / 1_000_000
    }

    #[inline]
    pub fn unix_ns(&self) -> i64 {
        self.mono_ns() + self.origin_unix_ns
    }

    /// Nominal CPU GHz (for reporting).
    pub fn ghz(&self) -> f64 {
        if self.ns_per_cycle > 0.0 {
            1.0 / (self.ns_per_cycle * 1.0)
        } else {
            0.0
        }
    }
}

/// Convenience: monotonic ns since global clock origin.
#[inline(always)]
pub fn mono_ns() -> i64 {
    Clock::global().mono_ns()
}

#[inline(always)]
pub fn cycles() -> u64 {
    rdtscp()
}

/// Measure the duration of a closure in cycles.
#[inline]
pub fn measure_cycles<F: FnOnce() -> R, R>(f: F) -> (R, u64) {
    let a = rdtscp();
    let r = f();
    let d = rdtscp().wrapping_sub(a);
    (r, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_ns_advances() {
        init();
        let a = mono_ns();
        std::thread::sleep(Duration::from_millis(2));
        let b = mono_ns();
        assert!(b > a, "clock must advance: {} -> {}", a, b);
        assert!(b - a > 1_000_000, "sleep 2ms must measure >=1ms, got {} ns", b - a);
    }

    #[test]
    fn cycle_resolution() {
        init();
        let c = Clock::global();
        let (v, cyc) = measure_cycles(|| {
            let mut x = 0u64;
            for i in 0..100u64 {
                x = x.wrapping_add(i);
            }
            x
        });
        assert_eq!(v, 4950);
        let ns = c.cycles_to_ns(cyc);
        // 100 adds of unrolled arithmetic should be far below 10us
        assert!(ns < 10_000.0, "100 adds took {}ns?!", ns);
    }
}
