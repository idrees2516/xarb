//! σ auto-calibration from live Polymarket prices — the "σ-floor
//! auto-calibration" engine.
//!
//! The FV model needs σ (BTC points per √second). Two live estimates are
//! blended, floored, and — when Polymarket prints a fresh IDENTIFIABLE
//! quote — snapped to the market's own implied σ:
//!
//! 1. **Implied σ (`σ_imp`)** — inverted from the live PM mid quote on
//!    every fresh book print: the market's mid `m` implies
//!    `z = Φ⁻¹(m)` and hence `σ = (S−K)/(z·√τ)` (UP side; symmetric with
//!    (K−S) for the DOWN side). Near the money the quote is unidentifiable
//!    (|z| → 0 with S→K), so samples with |z| below a gate are rejected —
//!    the classic ill-conditioning trap. Surviving samples are
//!    robust-clamped and EWMA-smoothed.
//! 2. **Realized σ (`σ_real`)** — the 1s-sampled EWMA variance from the
//!    Binance trade stream (computed in `FvCore`).
//!
//! **Snap**: whenever a fresh print contains an identifiable mid, the
//! exact σ that makes FV equal that mid is latched. While the book keeps
//! printing, FV therefore tracks the market's own price (no phantom edge).
//! The snap is frozen at PRINT time — while the book is silent (the
//! reaction-lag window the strategy monetises) the snap is not recomputed,
//! so FV floats with Binance and the edge vs the stale quote appears. The
//! snap expires after 2s of book silence.
//!
//! **Floor**: `max(abs_floor, floor_k · median(σ_imp history))` —
//! auto-calibrated to the live PM regime. A market where PM prices wide
//! (high implied σ) raises the floor and keeps FV from claiming more
//! certainty than the market itself; a calm market lowers it. The floor is
//! the honesty bound: σ too low snaps FV to 0/100 and fires false triggers.
//!
//! `σ_eff = clamp(max(blend(σ_imp, σ_real), floor, snap_fresh), …, cap)`.

/// Knobs for the calibrator. All are patchable from the dashboard.
#[derive(Debug, Clone, PartialEq)]
pub struct SigmaCfg {
    /// Auto-calibration on (false → legacy fixed-floor clamp of realized σ).
    pub auto: bool,
    /// Weight of implied σ in the blend (0..1). Default 0.65.
    pub w_imp: f64,
    /// Minimum |Φ⁻¹(mid)| for a quote to identify σ (identifiability gate).
    /// 0.35 ⇔ mids outside (36.3¢, 63.7¢) are identifiable.
    pub z_gate: f64,
    /// EWMA step for σ_imp updates (0..1). Default 0.30.
    pub kappa: f64,
    /// Dynamic floor = floor_k × median(σ_imp history). Default 0.75.
    pub floor_k: f64,
    /// Absolute sanity floor (points/√s) — never trust σ below this.
    pub abs_floor: f64,
    /// Hard cap (points/√s).
    pub cap: f64,
    /// σ_imp history length for the median floor (decimated ≥250ms).
    pub hist_cap: usize,
}

impl Default for SigmaCfg {
    fn default() -> Self {
        SigmaCfg {
            auto: true,
            w_imp: 0.65,
            z_gate: 0.35,
            kappa: 0.30,
            floor_k: 0.75,
            abs_floor: 6.0,
            cap: 90.0,
            hist_cap: 240,
        }
    }
}

/// A fresh book print's snap survives this long without another print.
pub const SNAP_FRESH_MS: u64 = 2_000;

/// Pure σ calibrator — deterministic, fully unit-testable.
pub struct SigmaCalib {
    cfg: SigmaCfg,
    /// Implied σ (EWMA, points/√s). Initialised at the spec-calibrated 15.5.
    imp: f64,
    /// Realized σ mirror (pushed by FvCore's EWMA, points/√s).
    real: f64,
    /// Decimated σ_imp history for the median floor.
    hist: Vec<f64>,
    last_sample_ms: u64,
    /// Cached dynamic floor (recomputed on history push only).
    floor_cache: f64,
    /// Snap latched at the last identifiable fresh print (points/√s).
    snap: Option<f64>,
    /// Print time of the last fresh book observation.
    last_print_ms: u64,
    /// Last computed σ_eff.
    eff: f64,
    /// Samples accepted by the identifiability gate (stats).
    pub accepted: u64,
    /// Samples rejected by the gates (stats).
    pub rejected: u64,
}

impl SigmaCalib {
    pub fn new(cfg: SigmaCfg) -> SigmaCalib {
        let floor_cache = cfg.abs_floor;
        SigmaCalib {
            cfg,
            imp: 15.5,
            real: 7.5,
            hist: vec![15.5],
            last_sample_ms: 0,
            floor_cache,
            snap: None,
            last_print_ms: 0,
            eff: 15.5,
            accepted: 0,
            rejected: 0,
        }
    }

    pub fn cfg(&self) -> &SigmaCfg {
        &self.cfg
    }

    pub fn set_cfg(&mut self, cfg: SigmaCfg) {
        self.cfg = cfg;
    }

    /// Current implied σ (EWMA).
    pub fn imp(&self) -> f64 {
        self.imp
    }

    /// Realized σ mirror.
    pub fn real(&self) -> f64 {
        self.real
    }

    /// Current dynamic floor (points/√s).
    pub fn floor(&self) -> f64 {
        self.floor_cache
    }

    /// Latched snap, if any.
    pub fn snap(&self) -> Option<f64> {
        self.snap
    }

    /// Fold the FV engine's realized-vol EWMA into the calibrator.
    pub fn observe_real(&mut self, vol_pts: f64) {
        if vol_pts.is_finite() && vol_pts > 0.0 {
            self.real = vol_pts;
        }
    }

    /// One fresh book print. `mid_up_c`/`mid_dn_c` are UP/DOWN mids in
    /// cents (None when the side is empty). `fresh` = the cells passed the
    /// age budget. Returns true when σ_imp moved.
    #[allow(clippy::too_many_arguments)]
    pub fn observe_pm(
        &mut self,
        mid_up_c: Option<f64>,
        mid_dn_c: Option<f64>,
        s: f64,
        k: f64,
        t_sec: f64,
        now_ms: u64,
        fresh: bool,
    ) -> bool {
        if !fresh || !self.cfg.auto {
            return false;
        }
        self.last_print_ms = now_ms;
        if k <= 0.0 || s <= 0.0 || t_sec < 3.0 {
            // window not live: a print still clears any stale snap
            self.snap = None;
            self.rejected += 1;
            return false;
        }
        let sqrt_t = t_sec.sqrt();
        let mut cands: Vec<f64> = Vec::with_capacity(2);
        // UP side: m = Φ((S−K)/(σ√τ)) → σ = (S−K)/(z·√τ)
        if let Some(m) = usable_mid(mid_up_c) {
            let z = norm_inv(m / 100.0);
            if z.abs() >= self.cfg.z_gate {
                let raw = (s - k) / (z * sqrt_t);
                if raw.is_finite() && raw > 0.0 {
                    cands.push(raw);
                }
            }
        }
        // DOWN side: m = Φ((K−S)/(σ√τ)) → σ = (K−S)/(z·√τ)
        if let Some(m) = usable_mid(mid_dn_c) {
            let z = norm_inv(m / 100.0);
            if z.abs() >= self.cfg.z_gate {
                let raw = (k - s) / (z * sqrt_t);
                if raw.is_finite() && raw > 0.0 {
                    cands.push(raw);
                }
            }
        }
        // Latch/clear the snap at print time (frozen at print, see module
        // docs — the snap is never recomputed with a moved S).
        self.snap = cands
            .iter()
            .cloned()
            .fold(None::<f64>, |acc, c| Some(acc.map_or(c, |a: f64| a.max(c))))
            .map(|c| c.clamp(self.cfg.abs_floor, self.cfg.cap));
        if cands.is_empty() {
            self.rejected += 1;
            return false;
        }
        // EWMA update (robust clamp: one quote can only move σ_imp so far)
        let raw = cands.iter().sum::<f64>() / cands.len() as f64;
        let lo = self.imp * 0.25;
        let hi = self.imp * 4.0;
        let raw = raw.clamp(lo, hi);
        let delta = self.cfg.kappa * (raw - self.imp);
        self.imp = (self.imp + delta).clamp(0.5, self.cfg.cap);
        self.accepted += 1;

        // history push (decimated ≥250ms) → recompute the median floor
        if now_ms.saturating_sub(self.last_sample_ms) >= 250 {
            self.last_sample_ms = now_ms;
            self.hist.push(self.imp);
            if self.hist.len() > self.cfg.hist_cap {
                let excess = self.hist.len() - self.cfg.hist_cap;
                self.hist.drain(0..excess);
            }
            self.floor_cache = self.recompute_floor();
        }
        true
    }

    /// Dynamic floor: `max(abs_floor, floor_k · median(history))`.
    fn recompute_floor(&self) -> f64 {
        let mut v = self.hist.clone();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = v.len();
        let median = if n == 0 {
            15.5
        } else if n % 2 == 1 {
            v[n / 2]
        } else {
            (v[n / 2 - 1] + v[n / 2]) * 0.5
        };
        let dyn_floor = self.cfg.floor_k * median;
        dyn_floor.max(self.cfg.abs_floor)
    }

    /// Effective σ at `now_ms`.
    /// `auto` off → legacy fixed-floor clamp of realized σ.
    /// `auto` on  → `clamp(max(blend, floor, snap_fresh), floor, cap)`.
    pub fn effective(&mut self, now_ms: u64) -> f64 {
        if !self.cfg.auto {
            self.eff = self.real.max(15.5).min(self.cfg.cap);
            return self.eff;
        }
        let w = self.cfg.w_imp.clamp(0.0, 1.0);
        let blend = w * self.imp + (1.0 - w) * self.real;
        let mut v = blend.max(self.floor_cache);
        if let Some(snap) = self.snap {
            if now_ms.saturating_sub(self.last_print_ms) <= SNAP_FRESH_MS {
                v = v.max(snap);
            }
        }
        self.eff = v.clamp(self.cfg.abs_floor, self.cfg.cap);
        self.eff
    }

    /// Force σ_imp (tests / warm start).
    pub fn set_imp_for_test(&mut self, v: f64) {
        self.imp = v;
        self.hist.clear();
        self.hist.push(v);
        self.floor_cache = self.recompute_floor();
    }
}

/// A mid usable for inversion: present, inside (5, 95)¢.
fn usable_mid(m: Option<f64>) -> Option<f64> {
    let m = m?;
    if !(5.0..=95.0).contains(&m) {
        return None;
    }
    Some(m)
}

/// Acklam's inverse normal CDF — |relative error| < 1.15e-9 over the full
/// (0,1) domain (tails saturate at ±8 where Φ is < 1e-15 anyway).
pub fn norm_inv(p: f64) -> f64 {
    if !(0.0..=1.0).contains(&p) || p.is_nan() {
        return 0.0;
    }
    if p <= 0.0 {
        return -8.0;
    }
    if p >= 1.0 {
        return 8.0;
    }
    const A: [f64; 6] = [
        -3.969_683_028_665_376e+01,
        2.209_460_984_245_205e+02,
        -2.759_285_104_469_687e+02,
        1.383_577_518_627_690e+02,
        -3.066_479_806_614_716e+01,
        2.506_628_277_459_239e+00,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e+01,
        1.615_858_368_580_409e+02,
        -1.556_989_798_598_866e+02,
        6.680_131_188_771_972e+01,
        -1.328_068_155_288_572e+01,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_293e-03,
        -3.223_964_580_411_365e-01,
        -2.400_758_277_161_838e+00,
        -2.549_732_539_343_734e+00,
        4.374_664_141_464_968e+00,
        2.938_163_982_698_783e+00,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-03,
        3.224_671_290_700_398e-01,
        2.445_134_137_142_996e+00,
        3.754_408_661_907_416e+00,
    ];
    const P_LOW: f64 = 0.024_25;
    let p_high = 1.0 - P_LOW;

    if p < P_LOW {
        let q = (-2.0 * p.ln()).sqrt();
        let num = ((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5];
        let den = (((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0;
        num / den
    } else if p <= p_high {
        let q = p - 0.5;
        let r = q * q;
        let num = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q;
        let den = ((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0;
        num / den
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        let num = ((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5];
        let den = (((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0;
        -(num / den)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fv::norm_cdf;

    #[test]
    fn norm_inv_known_values() {
        assert!((norm_inv(0.5) - 0.0).abs() < 1e-9);
        assert!((norm_inv(0.55) - 0.125_661).abs() < 1e-5);
        assert!((norm_inv(0.77) - 0.738_847).abs() < 1e-5);
        assert!((norm_inv(0.8413) - 0.999_8).abs() < 5e-4);
        assert!((norm_inv(0.05) - (-1.644_854)).abs() < 1e-5);
    }

    #[test]
    fn norm_inv_symmetry_and_roundtrip() {
        for p in [0.01, 0.05, 0.25, 0.4, 0.5, 0.6, 0.75, 0.95, 0.99] {
            assert!((norm_inv(p) + norm_inv(1.0 - p)).abs() < 1e-9, "symmetry at {p}");
            // A&S cdf has 7.5e-8 absolute error → roundtrip within 3e-7
            assert!((norm_cdf(norm_inv(p)) - p).abs() < 3e-7, "roundtrip at {p}");
        }
        assert_eq!(norm_inv(0.0), -8.0);
        assert_eq!(norm_inv(1.0), 8.0);
        assert_eq!(norm_inv(f64::NAN), 0.0);
    }

    /// The core property: inverting a synthetic PM mid recovers the σ it
    /// was generated with (the whole auto-calibration premise).
    #[test]
    fn implied_inversion_recovers_sigma() {
        let mut cal = SigmaCalib::new(SigmaCfg { kappa: 1.0, ..SigmaCfg::default() });
        let (k, t): (f64, f64) = (83_200.0, 120.0);
        let sigma: f64 = 20.0;
        let s = 83_400.0;
        let d = (s - k) / (sigma * t.sqrt());
        let mid_up = norm_cdf(d) * 100.0;
        cal.observe_pm(Some(mid_up), None, s, k, t, 1_000, true);
        assert!((cal.imp() - sigma).abs() < 0.5, "recovered {}", cal.imp());
        // DOWN side consistency: mid_down = 100 − mid_up
        let mut cal2 = SigmaCalib::new(SigmaCfg { kappa: 1.0, ..SigmaCfg::default() });
        cal2.observe_pm(None, Some(100.0 - mid_up), s, k, t, 1_000, true);
        assert!((cal2.imp() - sigma).abs() < 0.5, "DOWN recovery {}", cal2.imp());
        // snap latched & effective honors it immediately
        let snapped = cal.snap().unwrap_or(0.0);
        assert!((snapped - sigma).abs() < 0.05, "snap {snapped}");
        assert!((cal.effective(1_000) - sigma).abs() < 0.5, "eff {}", cal.effective(1_000));
    }

    /// Near the money the quote cannot identify σ — the gate must reject.
    #[test]
    fn identifiability_gate_rejects_atm() {
        let mut cal = SigmaCalib::new(SigmaCfg::default());
        let moved = cal.observe_pm(Some(50.0), Some(50.0), 83_200.0, 83_200.0, 120.0, 1_000, true);
        assert!(!moved);
        assert_eq!(cal.rejected, 1);
        assert_eq!(cal.accepted, 0);
        assert_eq!(cal.snap(), None);
        // mid 50.5¢ with S−K = 3 pts: |z| = 0.0125 < gate → rejected
        let moved = cal.observe_pm(Some(50.5), Some(49.5), 83_203.0, 83_200.0, 120.0, 2_000, true);
        assert!(!moved);
        assert_eq!(cal.rejected, 2);
        // mid 64¢ (z = 0.358 ≥ 0.35) with S−K = 15 → σ ≈ 15/3.93 = 3.8
        let moved = cal.observe_pm(Some(64.0), Some(36.0), 83_215.0, 83_200.0, 120.0, 3_000, true);
        assert!(moved);
        assert_eq!(cal.accepted, 1);
    }

    /// Snap semantics: frozen at print time, expires after 2s of silence.
    /// This is what lets FV float with Binance during the PM reaction-lag
    /// window (the arbitrage) while tracking PM the rest of the time.
    #[test]
    fn snap_frozen_at_print_and_expires() {
        let mut cal = SigmaCalib::new(SigmaCfg::default());
        let (k, t, s) = (83_200.0, 120.0, 83_330.0);
        // mid 77¢ → z = 0.739, S−K = 130 → σ_cons = 130/(0.739·10.954) = 16.06
        cal.observe_pm(Some(77.0), None, s, k, t, 10_000, true);
        let snapped = cal.snap().unwrap_or(0.0);
        assert!((snapped - 16.06).abs() < 0.15, "snap {snapped}");
        // 1s later, still fresh → snap applies
        let eff = cal.effective(11_000);
        assert!(eff >= 16.0, "snap should bind: {eff}");
        // 2.1s later (silence) → snap expired, blend/floor rule
        let eff_late = cal.effective(12_100);
        assert!(eff_late < 16.0, "snap expiry: {eff_late}");
        // a fresh print with an unidentifiable mid CLEARS the snap
        cal.observe_pm(Some(55.0), Some(50.0), s, k, t, 13_000, true);
        assert_eq!(cal.snap(), None);
    }

    /// The dynamic floor tracks the live implied regime.
    #[test]
    fn dynamic_floor_tracks_implied_regime() {
        let mut cal = SigmaCalib::new(SigmaCfg {
            kappa: 1.0,
            abs_floor: 6.0,
            floor_k: 0.75,
            ..SigmaCfg::default()
        });
        for i in 0..20 {
            let (k, t, s): (f64, f64, f64) = (83_200.0, 120.0, 83_260.0);
            let d = (s - k) / (8.0 * t.sqrt());
            cal.observe_pm(Some(norm_cdf(d) * 100.0), None, s, k, t, 1_000 + i * 300, true);
        }
        assert!((cal.imp() - 8.0).abs() < 1.2, "imp {}", cal.imp());
        assert!((cal.floor() - 6.0).abs() < 0.5, "floor {}", cal.floor());
        cal.observe_real(7.5);
        let eff = cal.effective(7_000);
        assert!((eff - 8.0).abs() < 1.0, "eff {eff}");

        for i in 0..30 {
            let (k, t, s): (f64, f64, f64) = (83_200.0, 120.0, 83_500.0);
            let d = (s - k) / (40.0 * t.sqrt());
            cal.observe_pm(Some(norm_cdf(d) * 100.0), None, s, k, t, 10_000 + i * 300, true);
        }
        assert!(cal.imp() > 20.0, "imp spiked {}", cal.imp());
        assert!(cal.floor() >= 10.0, "floor spiked {}", cal.floor());
        cal.observe_real(5.0);
        let eff = cal.effective(20_000);
        assert!(eff >= cal.floor() - 1e-9, "eff {eff} below floor {}", cal.floor());
    }

    /// Legacy mode: auto off → the old fixed-floor clamp behaviour.
    #[test]
    fn legacy_mode_fixed_floor() {
        let mut cal = SigmaCalib::new(SigmaCfg { auto: false, ..SigmaCfg::default() });
        cal.observe_real(7.5);
        assert_eq!(cal.effective(0), 15.5);
        cal.observe_real(40.0);
        assert_eq!(cal.effective(0), 40.0);
    }

    /// Robust clamp: a single insane quote cannot teleport σ_imp.
    #[test]
    fn robust_clamp_bounds_single_quotes() {
        let mut cal = SigmaCalib::new(SigmaCfg { kappa: 1.0, ..SigmaCfg::default() });
        cal.observe_pm(Some(90.0), None, 88_200.0, 83_200.0, 120.0, 1_000, true);
        assert!(cal.imp() <= 15.5 * 4.0 + 1e-9, "clamped imp {}", cal.imp());
    }

    /// Stale prints are ignored entirely (fresh=false).
    #[test]
    fn stale_prints_ignored() {
        let mut cal = SigmaCalib::new(SigmaCfg::default());
        let moved = cal.observe_pm(Some(77.0), None, 83_330.0, 83_200.0, 120.0, 1_000, false);
        assert!(!moved);
        assert_eq!(cal.snap(), None);
        assert_eq!(cal.accepted, 0);
    }
}
