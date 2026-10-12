//! Fair value of the Polymarket 5m BTC UP token.

/// Fair-value model selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FvModel {
    /// Legacy linear spec: FV = 52 + slope·(S−K).
    Linear,
    /// Normal CDF: P(UP) = Φ((S−K)/(σ_eff·√T)). Default — prices deep
    /// OTM/ITM honestly (bounded 1–99¢, keeps real tail time value).
    NormalCdf,
}

impl FvModel {
    pub fn from_str(s: &str) -> FvModel {
        match s {
            "linear" => FvModel::Linear,
            _ => FvModel::NormalCdf,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            FvModel::Linear => "linear",
            FvModel::NormalCdf => "cdf",
        }
    }
}

/// σ floor (BTC points per √second), calibrated to the user's spec example:
/// +130 pts / T=120s → 77¢ implies σ ≈ 16 pts/√s; +15 pts → 55¢ implies
/// σ ≈ 11 pts/√s. The floor (geometric mid) keeps deep-OTM quotes honest —
/// realized σ below this claims more certainty than the spec itself.
pub const SIGMA_FLOOR_PTS: f64 = 15.5;
pub const SIGMA_CAP_PTS: f64 = 90.0;

/// Effective σ: realized σ clamped to [floor, cap].
pub fn sigma_eff(sigma_pts: f64) -> f64 {
    sigma_pts.max(SIGMA_FLOOR_PTS).min(SIGMA_CAP_PTS)
}

/// Full fair-value output.
#[derive(Debug, Clone, Copy)]
pub struct FvOut {
    /// Fair value of UP in cents (1..99).
    pub value: f64,
    /// z-score = (S−K)/sd (CDF context even for linear).
    pub z: f64,
    /// 1-σ price move over the remaining window (points).
    pub sd: f64,
    /// Local slope dFV/dS (¢/pt) of the ACTIVE model.
    pub slope: f64,
}

/// Compute fair value. `sigma_pts` = realized vol in BTC points per √second.
pub fn fv(s: f64, k: f64, t_sec: f64, sigma_pts: f64, model: FvModel) -> FvOut {
    fv_eff(s, k, t_sec, sigma_eff(sigma_pts), model)
}

/// Fair value with an EXPLICIT effective σ (no legacy clamp) — used by the
/// FV thread when σ auto-calibration supplies the blended/floored σ.
pub fn fv_eff(s: f64, k: f64, t_sec: f64, sigma_eff_pts: f64, model: FvModel) -> FvOut {
    let sd = (sigma_eff_pts * t_sec.max(1.0).sqrt()).max(5.0);
    let z = (s - k) / sd;
    let value = match model {
        FvModel::NormalCdf => (norm_cdf(z) * 100.0).clamp(1.0, 99.0),
        FvModel::Linear => {
            let slope = (0.19 * (120.0 / t_sec.max(1.0)).sqrt()).clamp(0.1, 1.4);
            (52.0 + slope * (s - k)).clamp(1.0, 99.0)
        }
    };
    let slope = match model {
        FvModel::NormalCdf => norm_pdf(z) * 100.0 / sd,
        FvModel::Linear => (0.19 * (120.0 / t_sec.max(1.0)).sqrt()).clamp(0.1, 1.4),
    };
    FvOut { value, z, sd, slope }
}

/// Digital-option delta per UP share: BTC to short per $1 of BTC move
/// (hedge qty per share = φ(d)/sd). Positive = long-direction exposure.
/// DOWN shares carry the negated delta (long DOWN = short direction).
#[inline]
pub fn digital_delta_per_share(s: f64, k: f64, t_sec: f64, sigma_eff_pts: f64) -> f64 {
    let sd = (sigma_eff_pts * t_sec.max(1.0).sqrt()).max(5.0);
    norm_pdf((s - k) / sd) / sd
}

/// Digital-option position gamma magnitude per share (hedge-qty curvature,
/// BTC per $): |d|·φ(d)/sd². Drives the Whalley–Wilmott re-hedge band.
#[inline]
pub fn digital_gamma_per_share(s: f64, k: f64, t_sec: f64, sigma_eff_pts: f64) -> f64 {
    let sd = (sigma_eff_pts * t_sec.max(1.0).sqrt()).max(5.0);
    let d = (s - k) / sd;
    d.abs() * norm_pdf(d) / (sd * sd)
}

/// Abramowitz & Stegun 7.1.26 normal CDF (|err| < 7.5e-8).
/// Q(x) = φ(x)·t·(b1 + b2·t + b3·t² + b4·t³ + b5·t⁴), t = 1/(1+0.2316419·|x|).
/// |z| ≥ 8 saturates (Φ < 1e-15) — skips the exp/poly work on deep tails.
#[inline]
pub fn norm_cdf(z: f64) -> f64 {
    if z > 8.0 {
        return 1.0;
    }
    if z < -8.0 {
        return 0.0;
    }
    let t = 1.0 / (1.0 + 0.231_641_9 * z.abs());
    let d = 0.398_942_280_401_432_7 * (-z * z / 2.0).exp();
    let p = d
        * t
        * (0.319_381_53
            - 0.356_563_782 * t
            + 1.781_477_937 * t * t
            - 1.821_255_978 * t * t * t
            + 1.330_274_429 * t * t * t * t);
    if z > 0.0 {
        1.0 - p
    } else {
        p
    }
}

/// Standard normal PDF φ(z).
pub fn norm_pdf(z: f64) -> f64 {
    0.398_942_280_401_432_7 * (-z * z / 2.0).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_cdf_known_values() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-6);
        assert!((norm_cdf(1.0) - 0.8413).abs() < 1e-3);
        assert!((norm_cdf(-1.0) - 0.1587).abs() < 1e-3);
        assert!((norm_cdf(0.739) - 0.7701).abs() < 1e-3); // spec point: Φ⁻¹(0.77)
    }

    #[test]
    fn sigma_floor_applies() {
        assert_eq!(sigma_eff(7.5), SIGMA_FLOOR_PTS);
        assert_eq!(sigma_eff(20.0), 20.0);
        assert_eq!(sigma_eff(500.0), SIGMA_CAP_PTS);
    }

    #[test]
    fn bounded_extremes() {
        let v = fv(90_000.0, 80_000.0, 10.0, 7.5, FvModel::NormalCdf);
        assert_eq!(v.value, 99.0);
        let v = fv(70_000.0, 80_000.0, 10.0, 7.5, FvModel::NormalCdf);
        assert_eq!(v.value, 1.0);
    }

    #[test]
    fn digital_greeks_at_spec_point() {
        // user's example state: S=83,330, K=83,200, τ=120s, σ_eff=15.5
        // → sd ≈ 169.9, d ≈ 0.677, φ(0.677) ≈ 0.3178
        let d = digital_delta_per_share(83_330.0, 83_200.0, 120.0, 15.5);
        let sd = 15.5 * 120.0_f64.sqrt();
        let expect = norm_pdf((83_330.0 - 83_200.0) / sd) / sd;
        assert!((d - expect).abs() < 1e-12);
        assert!(d > 0.0015 && d < 0.0020, "delta/share {d}"); // ≈0.00187 BTC
        // digital gamma (|d|·φ(d)/sd²) peaks at |d| = 1 (the inflection
        // zone), is zero at the money and decays deep OTM — the W-W band
        // widens exactly where re-hedging costs matter most
        let g_atm = digital_gamma_per_share(83_200.0, 83_200.0, 120.0, 15.5);
        let sd120 = 15.5 * 120.0_f64.sqrt();
        let s_peak = 83_200.0 + sd120; // |d| = 1
        let g_peak = digital_gamma_per_share(s_peak, 83_200.0, 120.0, 15.5);
        let g_deep = digital_gamma_per_share(83_600.0, 83_200.0, 120.0, 15.5);
        assert!(g_peak > g_atm, "gamma peak {} vs ATM {}", g_peak, g_atm);
        assert!(g_peak > g_deep * 3.0, "gamma peak {} vs deep {}", g_peak, g_deep);
    }
}
