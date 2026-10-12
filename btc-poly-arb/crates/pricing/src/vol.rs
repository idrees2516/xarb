//! Online volatility estimation from the trade stream.
//!
//! 100 ms buckets -> log returns -> exponentially weighted mean of squared
//! returns (zero-filled across quiet buckets) -> per-second sigma.
//!
//! Half-life semantics: `var(t) = lambda*var(t-1) + (1-lambda)*r^2` with
//! `lambda = 0.5^(bucket_s / half_life_s)`.

/// Time-bucketed EWMA volatility.
pub struct EwmaVol {
    bucket_s: f64,
    half_life_s: f64,
    lambda: f64,
    /// EWMA of squared per-bucket returns
    var_bucket: f64,
    warm: bool,
    last_ts_ns: i64,
    last_px: f64,
    /// number of buckets aggregated since last ts
    bucket_acc: f64,
    /// total trade observations
    obs: u64,
    /// floor and ceiling in per-second sigma terms
    sigma_floor: f64,
    sigma_cap: f64,
}

impl EwmaVol {
    pub fn new(half_life_s: f64, sigma_floor: f64, sigma_cap: f64) -> Self {
        let bucket_s = 0.1;
        let lambda = 0.5f64.powf(bucket_s / half_life_s.max(0.1));
        EwmaVol {
            bucket_s,
            half_life_s,
            lambda,
            var_bucket: 0.0,
            warm: false,
            last_ts_ns: 0,
            last_px: 0.0,
            bucket_acc: 0.0,
            obs: 0,
            sigma_floor,
            sigma_cap,
        }
    }

    /// Feed a trade print. `t_ns` monotonic, `price` > 0.
    pub fn on_trade(&mut self, t_ns: i64, price: f64) {
        self.obs += 1;
        if !self.warm {
            self.warm = true;
            self.last_ts_ns = t_ns;
            self.last_px = price;
            return;
        }
        // compute bucket(s) elapsed; collapse multi-bucket gaps as a single
        // (r spread across gaps would understate; a single return across the
        // whole gap is the conservative choice for jump detection)
        let dt_ns = t_ns - self.last_ts_ns;
        if dt_ns <= 0 {
            self.last_px = price;
            return;
        }
        let buckets = (dt_ns as f64 / (self.bucket_s * 1e9)) as i64;
        if buckets >= 1 {
            // close out the current bucket with the realized return
            let r = (price / self.last_px).ln();
            self.var_bucket = self.lambda * self.var_bucket + (1.0 - self.lambda) * r * r;
            // decay across empty buckets (price assumed flat => r=0)
            let extra = (buckets - 1).min(600) as u32; // cap 1 minute of empties
            for _ in 0..extra {
                self.var_bucket *= self.lambda;
            }
        } else {
            // intra-bucket: track price, variance applied at bucket close
            self.last_px = price;
            self.last_ts_ns = t_ns;
            return;
        }
        self.last_px = price;
        self.last_ts_ns = t_ns;
    }

    /// Per-second sigma estimate; `None` until warmed with enough data.
    pub fn sigma_per_sec(&self) -> Option<f64> {
        if !self.warm || self.obs < 8 {
            return None;
        }
        // var_bucket is variance per bucket of bucket_s seconds
        let var_s = self.var_bucket / self.bucket_s;
        if !var_s.is_finite() || var_s <= 0.0 {
            return None;
        }
        let sig = var_s.sqrt();
        Some(sig.clamp(self.sigma_floor, self.sigma_cap))
    }

    pub fn warm(&self) -> bool {
        self.sigma_per_sec().is_some()
    }

    pub fn obs(&self) -> u64 {
        self.obs
    }

    pub fn half_life_s(&self) -> f64 {
        self.half_life_s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_vol_converges() {
        let mut v = EwmaVol::new(30.0, 1e-6, 1e-2);
        // 0.1% per bucket => per-second sigma = 0.001/0.1 = 0.01
        let sigma_bucket = 0.001f64;
        let mut px = 80_000.0f64;
        let mut t = 0i64;
        for i in 0..20_000 {
            t += 100_000_000; // 100ms
            let up = (i % 2) == 0;
            let r = if up { sigma_bucket } else { -sigma_bucket };
            px *= (r as f64).exp();
            v.on_trade(t, px);
        }
        let s = v.sigma_per_sec().unwrap();
        assert!((s - 0.003162).abs() < 0.0008, "sigma {}", s);
    }

    #[test]
    fn spikes_raise_sigma() {
        let mut calm = EwmaVol::new(30.0, 1e-6, 1e-2);
        let mut wild = EwmaVol::new(30.0, 1e-6, 1e-2);
        let mut t = 0i64;
        let mut px_c = 80_000.0f64;
        let mut px_w = 80_000.0f64;
        for i in 0..5_000 {
            t += 100_000_000;
            px_c *= (if i % 2 == 0 { 0.0002f64 } else { -0.0002f64 }).exp();
            px_w *= (if i % 2 == 0 { 0.002f64 } else { -0.002f64 }).exp();
            calm.on_trade(t, px_c);
            wild.on_trade(t, px_w);
        }
        let s_c = calm.sigma_per_sec().unwrap();
        let s_w = wild.sigma_per_sec().unwrap();
        assert!(s_w > s_c * 5.0, "wild {} vs calm {}", s_w, s_c);
    }

    #[test]
    fn gap_decays_variance() {
        let mut v = EwmaVol::new(5.0, 1e-9, 1.0);
        // burn in wild returns
        let mut t = 0i64;
        let mut px = 80_000.0f64;
        for i in 0..2_000 {
            t += 100_000_000;
            px *= (if i % 2 == 0 { 0.003f64 } else { -0.003f64 }).exp();
            v.on_trade(t, px);
        }
        let before = v.sigma_per_sec().unwrap();
        // 5 minutes of silence with one final print
        t += 300_000_000_000;
        v.on_trade(t, px);
        let after = v.sigma_per_sec().unwrap();
        assert!(after < before, "decay expected: {} -> {}", before, after);
    }
}
