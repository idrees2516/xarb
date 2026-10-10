//! Allocation-free log-scale latency histogram.
//!
//! One relaxed `fetch_add` per record (no locks, no sort, no allocation).
//! Bucket i covers [2^i, 2^(i+1)) ns — 64 buckets span 1ns to ~584 years.
//! Percentiles interpolate geometrically inside a bucket, which is exact
//! enough for ns/µs-scale reporting.

use std::sync::atomic::{AtomicU64, Ordering};

const BUCKETS: usize = 64;

pub struct LogHist {
    buckets: [AtomicU64; BUCKETS],
    count: AtomicU64,
    sum: AtomicU64,
    min: AtomicU64,
    max: AtomicU64,
    /// Reset generation (see `reset_if`).
    gen: AtomicU64,
}

impl Default for LogHist {
    fn default() -> Self {
        LogHist {
            buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            count: AtomicU64::new(0),
            sum: AtomicU64::new(0),
            min: AtomicU64::new(u64::MAX),
            max: AtomicU64::new(0),
            gen: AtomicU64::new(0),
        }
    }
}

impl LogHist {
    /// Record a latency in nanoseconds.
    #[inline]
    pub fn record(&self, ns: u64) {
        if ns == 0 {
            self.buckets[0].fetch_add(1, Ordering::Relaxed);
        } else {
            let b = 63 - ns.leading_zeros() as usize; // ns ∈ [2^b, 2^(b+1))
            self.buckets[b].fetch_add(1, Ordering::Relaxed);
        }
        self.count.fetch_add(1, Ordering::Relaxed);
        // wrapping-add: sums are diagnostics only, a wrap needs exabytes of ns
        self.sum.fetch_add(ns, Ordering::Relaxed);
        self.min.fetch_min(ns, Ordering::Relaxed);
        self.max.fetch_max(ns, Ordering::Relaxed);
    }

    pub fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    pub fn min_ns(&self) -> u64 {
        let m = self.min.load(Ordering::Relaxed);
        if m == u64::MAX {
            0
        } else {
            m
        }
    }

    pub fn max_ns(&self) -> u64 {
        self.max.load(Ordering::Relaxed)
    }

    pub fn mean_ns(&self) -> f64 {
        let n = self.count();
        if n == 0 {
            0.0
        } else {
            self.sum.load(Ordering::Relaxed) as f64 / n as f64
        }
    }

    /// Quantile in nanoseconds (q ∈ [0,1]), geometric interpolation in-bucket.
    pub fn percentile_ns(&self, q: f64) -> u64 {
        let total = self.count();
        if total == 0 {
            return 0;
        }
        let target = ((q.clamp(0.0, 1.0)) * (total - 1) as f64).round() as u64;
        let mut cum = 0u64;
        for b in 0..BUCKETS {
            let c = self.buckets[b].load(Ordering::Relaxed);
            if c == 0 {
                continue;
            }
            if target < cum + c {
                // inside bucket b: interpolate between 2^b and 2^(b+1)
                let frac = if c > 1 {
                    (target - cum) as f64 / c as f64
                } else {
                    0.5
                };
                let lo = if b == 0 { 1.0 } else { (1u64 << b) as f64 };
                let hi = (1u64 << (b + 1)) as f64;
                return (lo * (hi / lo).powf(frac)) as u64;
            }
            cum += c;
        }
        self.max_ns()
    }

    /// Snapshot (p50, p90, p99, max, count, mean) for telemetry.
    pub fn summary(&self) -> (u64, u64, u64, u64, u64, f64) {
        (
            self.percentile_ns(0.50),
            self.percentile_ns(0.90),
            self.percentile_ns(0.99),
            self.max_ns(),
            self.count(),
            self.mean_ns(),
        )
    }

    /// Resets under concurrent readers are approximate: clear buckets, then
    /// bump the generation. Best used from a single telemetry task.
    pub fn reset(&self) {
        for b in &self.buckets {
            b.store(0, Ordering::Relaxed);
        }
        self.count.store(0, Ordering::Relaxed);
        self.sum.store(0, Ordering::Relaxed);
        self.min.store(u64::MAX, Ordering::Relaxed);
        self.max.store(0, Ordering::Relaxed);
        self.gen.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_and_percentiles() {
        let h = LogHist::default();
        for &v in &[100u64, 200, 300, 400, 5_000, 90_000] {
            h.record(v);
        }
        assert_eq!(h.count(), 6);
        assert_eq!(h.min_ns(), 100);
        assert_eq!(h.max_ns(), 90_000);
        // p50 lands among [200,300] → between 128 and 512
        let p50 = h.percentile_ns(0.5);
        assert!(p50 >= 128 && p50 <= 512, "p50={p50}");
        let p99 = h.percentile_ns(0.99);
        assert!(p99 >= 32_768 && p99 <= 131_072, "p99={p99}");
        assert!((h.mean_ns() - 16_000.0).abs() < 1.0, "mean={}", h.mean_ns());
    }

    #[test]
    fn zero_and_empty() {
        let h = LogHist::default();
        assert_eq!(h.percentile_ns(0.5), 0);
        h.record(0);
        assert_eq!(h.count(), 1);
        assert_eq!(h.min_ns(), 0);
    }

    #[test]
    fn reset_clears() {
        let h = LogHist::default();
        h.record(1_000);
        h.record(2_000);
        h.reset();
        assert_eq!(h.count(), 0);
        assert_eq!(h.percentile_ns(0.99), 0);
    }
}
