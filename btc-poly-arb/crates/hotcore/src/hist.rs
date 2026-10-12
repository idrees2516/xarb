//! Log-spaced latency histogram.
//!
//! 96 buckets, 4 buckets per octave (each bucket ~1.19x wider than the
//! previous), covering ~1 ns to ~400 ms. `Copy`, single-writer,
//! snapshot-by-value, zero allocation.
//!
//! `record()` is one `clz`-ish arithmetic index computation and an increment —
//! low tens of nanoseconds, suitable for per-tick instrumentation.

pub const HIST_BUCKETS: usize = 96;

/// 4 sub-buckets per octave => log2 index with 2 fractional bits.
const SUB: f64 = 4.0;

#[derive(Clone, Copy, Debug)]
pub struct Hist {
    /// counts per bucket
    pub counts: [u64; HIST_BUCKETS],
    /// minimum exponent bucket that is in range (bucket 0 starts here)
    pub total: u64,
    /// overflow count (beyond top bucket)
    pub overflow: u64,
    pub min_ns: u64,
    pub max_ns: u64,
}

impl Default for Hist {
    fn default() -> Self {
        Hist {
            counts: [0; HIST_BUCKETS],
            total: 0,
            overflow: 0,
            min_ns: u64::MAX,
            max_ns: 0,
        }
    }
}

impl Hist {
    /// Bucket 0 covers [BUCKET0_NS, BUCKET0_NS*2^(1/4)) — with BUCKET0_NS = 1
    /// the top bucket starts at 1 * 2^(95/4) ≈ 2^23.75 ns ≈ 8.9 ms, and we
    /// overflow beyond ~10.5 ms (typical network RTTs are recorded by
    /// wall-clock fields instead, not here).
    pub const BUCKET0_NS: f64 = 1.0;

    #[inline(always)]
    pub fn record(&mut self, ns: u64) {
        if ns == 0 {
            self.counts[0] += 1;
            self.total += 1;
            if self.min_ns > 0 {
                self.min_ns = 0;
            }
            return;
        }
        let idx_f = ((ns as f64).log2()) * SUB;
        let idx = if idx_f >= (HIST_BUCKETS as f64) {
            HIST_BUCKETS - 1
        } else {
            idx_f as usize
        };
        if idx_f >= (HIST_BUCKETS as f64) {
            self.overflow += 1;
        }
        self.counts[idx] += 1;
        self.total += 1;
        if ns < self.min_ns {
            self.min_ns = ns;
        }
        if ns > self.max_ns {
            self.max_ns = ns;
        }
    }

    /// Approximate value of the `q` quantile (0..=1) in nanoseconds.
    pub fn quantile(&self, q: f64) -> u64 {
        if self.total == 0 {
            return 0;
        }
        let target = ((q * self.total as f64).ceil() as u64).clamp(1, self.total);
        let mut acc = 0u64;
        for (i, c) in self.counts.iter().enumerate() {
            acc += *c;
            if acc >= target {
                // reconstruct bucket midpoint
                let lo = Self::BUCKET0_NS * (2.0f64).powf(i as f64 / SUB);
                let hi = Self::BUCKET0_NS * (2.0f64).powf((i + 1) as f64 / SUB);
                let lo = if i == 0 { 1.0 } else { lo };
                return ((lo + hi) / 2.0) as u64;
            }
        }
        self.max_ns
    }

    pub fn p50(&self) -> u64 {
        self.quantile(0.50)
    }
    pub fn p99(&self) -> u64 {
        self.quantile(0.99)
    }
    pub fn p999(&self) -> u64 {
        self.quantile(0.999)
    }

    /// Reset in place (snapshot-then-clear pattern for periodic reporting).
    pub fn reset(&mut self) -> Hist {
        let snap = *self;
        *self = Hist::default();
        snap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_bounds() {
        let mut h = Hist::default();
        h.record(1);
        h.record(2);
        h.record(1_000); // ~1us
        h.record(1_000_000); // ~1ms
        assert_eq!(h.total, 4);
        assert_eq!(h.min_ns, 1);
        assert_eq!(h.max_ns, 1_000_000);
        assert_eq!(h.p50(), 2); // 2nd of 4 sorted values
        // p99 = top bucket; its midpoint is ~0.94ms, max tracks the true value
        assert!(h.p99() >= 800_000);
        assert_eq!(h.max_ns, 1_000_000);
    }

    #[test]
    fn quantile_monotone() {
        let mut h = Hist::default();
        let mut rng: u64 = 0x1234_5678_9abc_def0;
        for _ in 0..10_000 {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            h.record((rng >> 33) % 500_000);
        }
        assert!(h.p50() <= h.p99());
        assert!(h.p99() <= h.p999());
        assert!(h.p999() <= h.max_ns);
        assert_eq!(h.total, 10_000);
    }

    #[test]
    fn overflow_counted() {
        let mut h = Hist::default();
        h.record(u64::MAX / 2);
        assert_eq!(h.overflow, 1);
        assert_eq!(h.total, 1);
    }
}
