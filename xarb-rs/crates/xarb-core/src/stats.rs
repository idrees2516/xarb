//! 5-second FV jump ring + latency rings + percentiles.

use std::collections::VecDeque;

/// Ring of (epoch-ms, value) with retention window.
#[derive(Debug)]
pub struct FvRing {
    pts: VecDeque<(u64, f64)>,
    keep_ms: u64,
}

impl FvRing {
    pub fn new(keep_ms: u64) -> Self {
        FvRing { pts: VecDeque::with_capacity(512), keep_ms }
    }

    /// Throttled push (min 50ms between samples), evicting stale points.
    pub fn push(&mut self, now_ms: u64, v: f64) {
        if let Some(&(t, _)) = self.pts.back() {
            if now_ms - t < 50 {
                return;
            }
        }
        self.pts.push_back((now_ms, v));
        while let Some(&(t, _)) = self.pts.front() {
            if now_ms.saturating_sub(t) > self.keep_ms {
                self.pts.pop_front();
            } else {
                break;
            }
        }
    }

    /// FV change vs the newest sample ≥ 5s old. 0 if history too short.
    pub fn jump5s(&self, now_ms: u64) -> f64 {
        let cur = match self.pts.back() {
            Some(&(_, v)) => v,
            None => return 0.0,
        };
        let mut reference = None;
        for &(t, v) in self.pts.iter().rev() {
            if t <= now_ms.saturating_sub(5_000) {
                reference = Some(v);
                break;
            }
        }
        reference.map_or(0.0, |r| cur - r)
    }

    pub fn len(&self) -> usize {
        self.pts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pts.is_empty()
    }
}

/// Fixed-capacity numeric ring (µs latencies, ms lags, …).
#[derive(Debug)]
pub struct Ring {
    v: VecDeque<f64>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring { v: VecDeque::with_capacity(cap), cap }
    }

    pub fn push(&mut self, x: f64) {
        if self.v.len() == self.cap {
            self.v.pop_front();
        }
        self.v.push_back(x);
    }

    pub fn last(&self) -> f64 {
        self.v.back().copied().unwrap_or(0.0)
    }

    pub fn percentile(&self, q: f64) -> f64 {
        let mut sorted: Vec<f64> = self.v.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        percentile(&sorted, q)
    }

    pub fn len(&self) -> usize {
        self.v.len()
    }
}

/// Quantile of a pre-sorted slice.
pub fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (q * (sorted.len() - 1) as f64).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_uses_5s_reference() {
        let mut r = FvRing::new(20_000);
        r.push(1_000, 50.0);
        r.push(6_100, 72.0);
        assert!((r.jump5s(6_100) - 22.0).abs() < 1e-9);
        assert_eq!(r.jump5s(2_000), 0.0); // no ≥5s-old sample yet
    }

    #[test]
    fn throttle() {
        let mut r = FvRing::new(20_000);
        r.push(1_000, 50.0);
        r.push(1_020, 51.0); // suppressed (<50ms)
        assert_eq!(r.len(), 1);
        r.push(1_060, 52.0);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn ring_percentile() {
        let mut r = Ring::new(100);
        for i in 1..=100 {
            r.push(i as f64);
        }
        assert!((r.percentile(0.5) - 50.0).abs() < 1e-9);
        assert!((r.percentile(0.99) - 99.0).abs() < 1e-9);
    }
}
