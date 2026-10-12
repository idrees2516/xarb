//! pricing — what should the UP share cost *right now*?
//!
//! The Polymarket 5-minute BTC "Up or Down" market is a digital (binary)
//! option: UP pays $1 if the window's reference price closes >= its open
//! (strike), else $0. With `S` = current BTC price, `K` = strike,
//! `tau` = seconds to window close and `sigma` = per-second volatility, the
//! risk-neutral probability of UP under a log-normal terminal law is
//!
//! ```text
//! FV(UP) = N(d2),   d2 = ( ln(S/K) - 0.5*sigma^2*tau ) / ( sigma*sqrt(tau) )
//! ```
//!
//! (drift is ~0 over 5 minutes). This closed form costs one `ln`, one `sqrt`
//! and one `erf` — tens of nanoseconds.
//!
//! `EwmaVol` estimates `sigma` online from the Binance trade stream (100 ms
//! buckets, exponentially-weighted mean of squared log returns).
//!
//! An `Empirical` linear model is provided for users who want to encode an
//! observed cents-per-point mapping (à la the tweet) instead of the
//! log-normal law.

pub mod vol;

pub use vol::EwmaVol;

/// Abramowitz & Stegun 7.1.26 error function; |err| < 1.5e-7. ~10ns.
#[inline]
pub fn erf(x: f64) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    let s = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    // |x| beyond 4: erf is 1 to double precision
    if x > 4.0 {
        return s;
    }
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t
            + 0.254_829_592)
            * t
            * (-x * x).exp();
    s * y
}

/// Standard normal CDF.
#[inline]
pub fn norm_cdf(x: f64) -> f64 {
    const INV_SQRT2: f64 = core::f64::consts::FRAC_1_SQRT_2;
    0.5 * (1.0 + erf(x * INV_SQRT2))
}

/// Standard normal PDF.
#[inline]
pub fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() * 0.398_942_280_401_432_7
}

/// Inverse standard normal CDF (Acklam's rational approximation, ~1e-9).
/// Only used for calibration/reporting, never in the hot path.
pub fn norm_inv_cdf(p: f64) -> f64 {
    if p <= 0.0 {
        return f64::NEG_INFINITY;
    }
    if p >= 1.0 {
        return f64::INFINITY;
    }
    const A: [f64; 6] = [
        -3.969_683_028_665_376e1,
        2.209_460_984_245_372e2,
        -2.759_285_104_469_687e2,
        1.383_577_518_672_690e2,
        -3.066_479_806_614_716e1,
        2.506_628_277_459_239,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e1,
        1.615_858_368_580_409e2,
        -1.556_989_798_598_866e2,
        6.680_131_188_771_972e1,
        -1.328_068_155_288_572e1,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_993e-3,
        -3.223_964_580_411_365e-1,
        -2.400_758_277_161_838,
        -2.549_732_539_343_734,
        4.374_664_141_464_968,
        2.938_163_982_698_783,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-3,
        3.224_671_290_739_812e-1,
        2.445_134_137_142_996,
        3.754_408_661_907_416,
    ];
    let plow = 0.02425;
    let x;
    if p < plow {
        let q = (-2.0 * p.ln()).sqrt();
        x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0);
    } else if p <= 1.0 - plow {
        let q = p - 0.5;
        let r = q * q;
        x = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0);
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0);
    }
    // one Halley refinement using our own cdf

    let cdf = norm_cdf(x);
    let pdf = norm_pdf(x);
    let err = cdf - p;
    let u = err / pdf;
    x - u / (1.0 + 0.5 * x * u)
}

/// Black-Scholes digital: P(S_T >= K) = N(d2). Sane at every edge.
///
/// * `tau_s <= 0`: resolved (S>K -> 1, S<K -> 0, S==K -> 0.5 per ">= Up" rule)
/// * `sigma` floored to avoid division by zero
#[inline]
pub fn fv_up(s: f64, k: f64, tau_s: f64, sigma_per_sec: f64) -> f64 {
    if !(s > 0.0 && k > 0.0) {
        return 0.5;
    }
    if tau_s <= 0.0 {
        return if s > k {
            1.0
        } else if s < k {
            0.0
        } else {
            0.5
        };
    }
    let sigma = if sigma_per_sec < 1e-7 { 1e-7 } else { sigma_per_sec };
    let vt = sigma * tau_s.sqrt();
    let d = ((s / k).ln() - 0.5 * sigma * sigma * tau_s) / vt;
    norm_cdf(d)
}

/// Sensitivity of the digital to spot (dFV/dS) — for the dashboard and for
/// "how many cents per point of BTC" sanity checks.
#[inline]
pub fn fv_up_delta(s: f64, k: f64, tau_s: f64, sigma_per_sec: f64) -> f64 {
    if !(s > 0.0 && k > 0.0 && tau_s > 0.0) {
        return 0.0;
    }
    let sigma = if sigma_per_sec < 1e-7 { 1e-7 } else { sigma_per_sec };
    let vt = sigma * tau_s.sqrt();
    let d = ((s / k).ln() - 0.5 * sigma * sigma * tau_s) / vt;
    let phi = norm_pdf(d);
    // d(d2)/dS = 1/(S*sigma*sqrt(tau))
    phi / (s * vt)
}

/// Implied per-second sigma from an observed (fv, S, K, tau) — used to
/// sanity-check the vol estimator against what the market is pricing.
pub fn implied_sigma(fv: f64, s: f64, k: f64, tau_s: f64) -> Option<f64> {
    if !(s > 0.0 && k > 0.0 && tau_s > 0.0) || !(0.001..=0.999).contains(&fv) {
        return None;
    }
    // invert N(d) = fv  =>  d = N^-1(fv); solve for sigma from
    // ln(S/K) = d*sigma*sqrt(tau) + 0.5*sigma^2*tau  (quadratic in sigma)
    let d = norm_inv_cdf(fv);
    let l = (s / k).ln();
    // 0.5*tau*x^2 + d*sqrt(tau)*x - l = 0
    let a = 0.5 * tau_s;
    let b = d * tau_s.sqrt();
    let disc = b * b + 4.0 * a * l;
    if disc < 0.0 || a == 0.0 {
        return None;
    }
    let x = (-b + disc.sqrt()) / (2.0 * a);
    if x > 0.0 {
        Some(x)
    } else {
        None
    }
}

/// Empirical linear model: cents-of-FV per point-of-BTC, decaying with time
/// left (steepening as the window closes), as in the tweet's arithmetic.
///
/// `cents_per_point_at_ref` is the slope when `tau == ref_tau_s`;
/// slope(tau) = cents_per_point_at_ref * (ref_tau/tau)^alpha.
#[derive(Clone, Copy, Debug)]
pub struct EmpiricalLinear {
    pub cents_per_point_at_ref: f64,
    pub ref_tau_s: f64,
    pub alpha: f64,
}

impl Default for EmpiricalLinear {
    fn default() -> Self {
        // calibrated from the tweet: 115 BTC points with 2 minutes left
        // moved the share ~22c  =>  ~0.19 cents/point at ref=120s
        EmpiricalLinear {
            cents_per_point_at_ref: 0.19,
            ref_tau_s: 120.0,
            alpha: 0.5,
        }
    }
}

impl EmpiricalLinear {
    #[inline]
    pub fn fv_up(&self, s: f64, k: f64, tau_s: f64) -> f64 {
        if tau_s <= 0.0 {
            return if s > k {
                1.0
            } else if s < k {
                0.0
            } else {
                0.5
            };
        }
        let slope_c = self.cents_per_point_at_ref * (self.ref_tau_s / tau_s).powf(self.alpha);
        let fv = 0.5 + slope_c * (s - k) / 100.0;
        fv.clamp(0.01, 0.99)
    }
}

/// Model selector.
#[derive(Clone, Copy, Debug)]
pub enum Model {
    /// Black-Scholes digital with live (or fallback) sigma.
    BsDigital { sigma_fallback: f64 },
    /// Tweet-style linear mapping.
    Empirical(EmpiricalLinear),
}

/// Result of a fair-value evaluation.
#[derive(Clone, Copy, Debug, Default)]
pub struct Fv {
    /// probability of UP, in dollars [0,1]
    pub up: f64,
    /// dFV/dS (per dollar of BTC)
    pub delta: f64,
    /// per-second sigma actually used
    pub sigma: f64,
}

impl Model {
    /// Evaluate. `sigma_live` comes from `EwmaVol` (None when not warm).
    #[inline]
    pub fn eval(&self, s: f64, k: f64, tau_s: f64, sigma_live: Option<f64>) -> Fv {
        match *self {
            Model::BsDigital { sigma_fallback } => {
                let sigma = sigma_live
                    .filter(|s| *s > 1e-6)
                    .unwrap_or(sigma_fallback);
                Fv {
                    up: fv_up(s, k, tau_s, sigma),
                    delta: fv_up_delta(s, k, tau_s, sigma),
                    sigma,
                }
            }
            Model::Empirical(e) => {
                let up = e.fv_up(s, k, tau_s);
                let tau = tau_s.max(1.0);
                Fv {
                    up,
                    delta: 0.01 * e.cents_per_point_at_ref * (e.ref_tau_s / tau).powf(e.alpha),
                    sigma: 0.0,
                }
            }
        }
    }
}

/// Sanity: constant-per-second vol target helper. BTC realized vol is ~0.05%
/// to 0.3% per sqrt(300s) window; per-second sigma ~ 8e-5 .. 3e-4.
pub fn sigma_from_window_sigma(window_sigma: f64, window_s: f64) -> f64 {
    window_sigma / window_s.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erf_matches_libm() {
        let mut worst = 0.0f64;
        for i in -60..=60 {
            let x = i as f64 * 0.1;
            let a = erf(x);
            let b = libm::erf(x);
            worst = worst.max((a - b).abs());
        }
        assert!(worst < 2e-7, "worst error {} vs libm", worst);
    }

    #[test]
    fn norm_cdf_known_values() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-15);
        assert!((norm_cdf(1.0) - 0.8413).abs() < 2e-4);
        assert!((norm_cdf(-1.0) - 0.1587).abs() < 2e-4);
        assert!((norm_cdf(1.96) - 0.9750).abs() < 2e-4);
        assert!(norm_cdf(-9.0) < 1e-15);
        assert!(norm_cdf(9.0) > 1.0 - 1e-15);
    }

    #[test]
    fn fv_bounds_and_edges() {
        // resolved windows
        assert_eq!(fv_up(83_330.0, 83_200.0, 0.0, 1e-4), 1.0);
        assert_eq!(fv_up(83_100.0, 83_200.0, 0.0, 1e-4), 0.0);
        assert_eq!(fv_up(83_200.0, 83_200.0, 0.0, 1e-4), 0.5);
        // ATM with time left: ~0.5 minus variance drag (-0.5*sigma^2*tau)
        assert!((fv_up(83_200.0, 83_200.0, 120.0, 1.3e-4) - 0.5).abs() < 5e-4);
        // bounds
        assert!(fv_up(100_000.0, 83_200.0, 5.0, 1e-3) <= 1.0);
        assert!(fv_up(1.0, 83_200.0, 5.0, 1e-3) >= 0.0);
    }

    #[test]
    fn fv_monotone_in_spot() {
        let k = 83_200.0;
        let tau = 120.0;
        let sig = 1.3e-4;
        let mut last = -1.0;
        for i in 0..200 {
            let s = 82_800.0 + i as f64 * 10.0;
            let fv = fv_up(s, k, tau, sig);
            assert!(fv >= last, "FV must be non-decreasing in S at s={}", s);
            last = fv;
        }
    }

    #[test]
    fn fv_sharpening_as_window_closes() {
        // a fixed distance from strike must map to a more extreme FV with
        // less time left (the digital converges to a step function)
        let s = 83_300.0;
        let k = 83_200.0;
        let fv_300 = fv_up(s, k, 300.0, 1.3e-4);
        let fv_120 = fv_up(s, k, 120.0, 1.3e-4);
        let fv_30 = fv_up(s, k, 30.0, 1.3e-4);
        assert!(fv_300 < fv_120, "{} vs {}", fv_300, fv_120);
        assert!(fv_120 < fv_30, "{} vs {}", fv_120, fv_30);
    }

    #[test]
    fn tweet_scenario_bs() {
        // window opened at 83,200; with 2 minutes left BTC moves
        // 83,215 -> 83,330 in 5 seconds.
        let k = 83_200.0;
        let tau = 120.0;
        // sigma implied by "55c at 83,215 with 2min left"
        let fv_start = fv_up(83_215.0, k, tau, 1.3e-4);
        let fv_end = fv_up(83_330.0, k, tau, 1.3e-4);
        let jump = fv_end - fv_start;
        // With BS at the tweet's implied sigma the jump comfortably exceeds
        // the 20c trigger and fv clears the 60c gate.
        assert!(jump > 0.20, "jump {} < 0.20", jump);
        assert!(fv_end > 0.60, "fv_end {} <= 0.60", fv_end);
        // and a PM ask of 56c leaves >10c edge
        assert!(fv_end - 0.56 > 0.10);
    }

    #[test]
    fn implied_sigma_roundtrip() {
        let s = 83_215.0;
        let k = 83_200.0;
        let tau = 120.0;
        let sig = 1.43e-4;
        let fv = fv_up(s, k, tau, sig);
        let back = implied_sigma(fv, s, k, tau).unwrap();
        assert!((back - sig).abs() < 1e-6, "roundtrip {} -> {}", sig, back);
    }

    #[test]
    fn empirical_matches_tweet_scale() {
        let e = EmpiricalLinear::default();
        let k = 83_200.0;
        // 83,215 at 2min -> ~53c (tweet says 55c; the tweet's two points
        // are mutually inconsistent by ~2c — documented in README)
        let a = e.fv_up(83_215.0, k, 120.0);
        // 83,330 at 2min -> ~75c (tweet says 77c)
        let b = e.fv_up(83_330.0, k, 120.0);
        assert!((a - 0.55).abs() < 0.04, "a={}", a);
        assert!((b - 0.77).abs() < 0.04, "b={}", b);
        assert!((b - a - 0.22).abs() < 0.03, "jump={}", b - a);
    }

    #[test]
    fn norm_inv_cdf_reasonable() {
        for p in [0.05, 0.25, 0.5, 0.75, 0.95, 0.99] {
            let x = norm_inv_cdf(p);
            let back = norm_cdf(x);
            assert!((back - p).abs() < 1e-6, "p={} back={}", p, back);
        }
    }
}
