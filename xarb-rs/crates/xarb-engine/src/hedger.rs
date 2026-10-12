//! Delta-hedging of the binary (digital-option) exposure on Binance.
//!
//! A long UP share is a digital call: its value Φ(d) moves with BTC spot.
//! Buying the discounted share leaves a directional position whose P&L is
//! dominated by BTC drift between entry and window close. The hedger
//! neutralises it by shorting `Δ = φ(d)/sd` BTC per share on Binance
//! (USDT-M perp in live mode; the live Binance book in paper mode), so the
//! combined (binary + hedge) position isolates the entry mispricing.
//!
//! Policy (all pure functions, time-injected, fully unit-testable):
//!   • **Target**: `target = −dir · shares · φ(d)/sd · ratio` BTC
//!     (dir = +1 for UP shares, −1 for DOWN shares).
//!   • **Whalley–Wilmott no-trade band**: re-hedge only when the hedge
//!     error leaves the band `max(min_qty, c_ww·(κ·S²·Γ_pos)^⅓)` — the
//!     asymptotically optimal band under proportional transaction costs
//!     (band grows with fee κ and position gamma Γ, shrinks with size).
//!   • **Wind-down**: in the last `winddown_s` seconds, if |d| > 1.2 the
//!     digital is effectively decided — delta collapses toward 0 on its
//!     own, re-hedging would only pay fees into the gamma explosion.
//!   • **Force-flatten**: at `flatten_s` before close the hedge is closed
//!     (reduce-only) so settlement is clean.
//!   • **Cost model**: `est_hedge_cost_c` predicts the per-share hedge
//!     turnover cost (initial + rebalances + flatten) that the net-edge
//!     profitability gate subtracts from the trigger edge.

use xarb_core::{digital_delta_per_share, digital_gamma_per_share};

/// Hedge policy knobs (dashboard-tunable).
#[derive(Debug, Clone, PartialEq)]
pub struct HedgeCfg {
    /// Delta-hedging master switch.
    pub on: bool,
    /// Fraction of delta hedged (1.0 = fully neutral).
    pub ratio: f64,
    /// Binance taker fee in bps (4.5 = 0.045%, the USDT-M perp VIP0 taker rate).
    pub fee_bps: f64,
    /// Whalley–Wilmott constant (band calibration; 20 ≈ $200 notional band
    /// for a 50-share ATM position).
    pub c_ww: f64,
    /// Minimum band (BTC) — never tighter than the exchange min order.
    pub min_band_btc: f64,
    /// Stop re-hedging this close to expiry when the digital is decided
    /// (|d| > 1.2).
    pub winddown_s: f64,
    /// Force-flatten the hedge this close to expiry (reduce-only).
    pub flatten_s: f64,
    /// Binance minimum order quantity (BTC).
    pub min_qty_btc: f64,
    /// Quantity step (BTC) — Binance BTCUSDT perp stepSize.
    pub qty_step_btc: f64,
    /// Turnover multiplier for the cost model (initial + ~2 rebalances +
    /// flatten ≈ 2.5 round trips of the entry delta).
    pub cost_turnover_mult: f64,
}

impl Default for HedgeCfg {
    fn default() -> Self {
        HedgeCfg {
            on: true,
            ratio: 1.0,
            fee_bps: 4.5,
            c_ww: 20.0,
            min_band_btc: 0.002,
            winddown_s: 20.0,
            flatten_s: 3.0,
            min_qty_btc: 0.001,
            qty_step_btc: 0.001,
            cost_turnover_mult: 2.5,
        }
    }
}

impl HedgeCfg {
    pub fn fee_frac(&self) -> f64 {
        self.fee_bps / 10_000.0
    }
}

/// Live hedge position (cash-flow accounting — exact by construction).
#[derive(Debug, Clone, Default)]
pub struct HedgePos {
    /// Trade (binary position) this hedge belongs to.
    pub trade_id: String,
    /// Binary side held (SIDE_UP / SIDE_DOWN).
    pub side: u8,
    /// Binary shares held.
    pub shares: f64,
    /// Binary strike.
    pub strike: f64,
    /// Signed hedge quantity in BTC (negative = short BTC, i.e. hedging a
    /// long UP position).
    pub qty_btc: f64,
    /// Average hedge entry price (reporting/mark only; cash is exact).
    pub avg_px: f64,
    /// Cumulative hedge cash flow: fills add −qty·px (buy costs, sells
    /// credit). Realized P&L when flat = cash − fees.
    pub cash: f64,
    /// Cumulative hedge fees (USD).
    pub fees: f64,
    /// Number of hedge fills (stats).
    pub fills: u64,
    /// Last computed target (BTC, signed).
    pub target_btc: f64,
    /// Last computed band (BTC).
    pub band_btc: f64,
}

impl HedgePos {
    /// Mark-to-market hedge P&L at price `s` (USD): `cash − fees + qty·s`.
    pub fn pnl_at(&self, s: f64) -> f64 {
        self.cash - self.fees + self.qty_btc * s
    }

    pub fn is_flat(&self) -> bool {
        self.qty_btc.abs() < 1e-9
    }
}

/// Apply a hedge fill to the position (exact cash-flow accounting).
pub fn apply_fill(pos: &mut HedgePos, qty: f64, px: f64, fee_usd: f64) {
    if qty == 0.0 {
        return;
    }
    // weighted average entry price for reporting
    let new_qty = pos.qty_btc + qty;
    if pos.avg_px > 0.0 && new_qty.abs() > 1e-9 && qty.signum() == pos.qty_btc.signum() {
        let w = pos.qty_btc.abs() / new_qty.abs();
        pos.avg_px = w * pos.avg_px + (1.0 - w) * px;
    } else {
        pos.avg_px = px;
    }
    pos.qty_btc = round_step(new_qty.abs(), 0.000_000_1) * new_qty.signum();
    pos.cash += -qty * px;
    pos.fees += fee_usd;
    pos.fills += 1;
}

/// One hedge decision. `s` = Binance mark, `sigma_eff` = effective σ
/// (points/√s), `tau` = seconds to window close.
#[derive(Debug, Clone, PartialEq)]
pub struct HedgeAction {
    /// Signed order quantity (BTC): negative = SELL (short more), positive
    /// = BUY (cover). Already step-rounded.
    pub qty: f64,
    pub reason: &'static str,
}

/// Round to the Binance quantity step (avoids precision-noise rejects).
pub fn round_step(q: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return q;
    }
    (q / step).round() * step
}

/// Pure hedge policy step.
pub fn hedge_step(
    pos: &HedgePos,
    s: f64,
    sigma_eff: f64,
    tau: f64,
    cfg: &HedgeCfg,
) -> Option<HedgeAction> {
    if !cfg.on || pos.shares <= 0.0 || pos.strike <= 0.0 || s <= 0.0 || tau <= 0.0 {
        return None;
    }
    // force-flatten: clean settlement, no expiry gamma roulette
    if tau <= cfg.flatten_s {
        if pos.qty_btc.abs() >= cfg.min_qty_btc {
            let qty = round_step(-pos.qty_btc, cfg.qty_step_btc);
            if qty.abs() >= cfg.min_qty_btc {
                return Some(HedgeAction { qty, reason: "force-flatten (expiry)" });
            }
        }
        return None;
    }

    // target hedge quantity
    let dlt = digital_delta_per_share(s, pos.strike, tau, sigma_eff);
    let dir = if pos.side == crate::state::SIDE_DOWN { -1.0 } else { 1.0 };
    let target = -dir * pos.shares * dlt * cfg.ratio;

    // wind-down: digital decided (|d| > 1.2) and near expiry → delta is
    // collapsing on its own; trading now only pays into the gamma explosion
    let sd = (sigma_eff * tau.max(1.0).sqrt()).max(5.0);
    let d = (s - pos.strike) / sd * dir;
    if tau <= cfg.winddown_s && d.abs() > 1.2 {
        // still bound to the band against the collapsing target, but never
        // ADD fresh hedge exposure in the wind-down zone
        let drift = pos.qty_btc - target;
        if drift.abs() < cfg.min_band_btc.max(pos.band_btc) {
            return None;
        }
        // allow only risk-REDUCing moves (toward flat)
        let toward_flat = (target - pos.qty_btc).abs() < pos.qty_btc.abs();
        if !toward_flat {
            return None;
        }
    }

    // Whalley–Wilmott band: max(min_qty, c_ww·(κ·S²·Γ)^⅓), capped at 30% of
    // the target so a huge gamma reading can't disable hedging entirely.
    let g = digital_gamma_per_share(s, pos.strike, tau, sigma_eff) * pos.shares;
    let ww = (cfg.fee_frac() * s * s * g).max(0.0).powf(1.0 / 3.0) * cfg.c_ww / s.max(1.0);
    let band = cfg
        .min_band_btc
        .max(ww)
        .min((target.abs() * 0.30).max(cfg.min_band_btc));

    let err = pos.qty_btc - target;
    if err.abs() < band {
        return None;
    }
    let qty = round_step(-err, cfg.qty_step_btc);
    if qty.abs() < cfg.min_qty_btc {
        return None;
    }
    Some(HedgeAction { qty, reason: "re-hedge (band breach)" })
}

/// Predicted hedge cost in CENTS PER SHARE at entry — the number the
/// net-edge profitability gate subtracts. Turnover ≈ cost_turnover_mult
/// round trips of the entry delta notional.
pub fn est_hedge_cost_c(s: f64, k: f64, tau: f64, sigma_eff: f64, cfg: &HedgeCfg) -> f64 {
    if !cfg.on || cfg.ratio <= 0.0 {
        return 0.0;
    }
    let dlt = digital_delta_per_share(s, k, tau, sigma_eff);
    let notional_per_share = dlt * cfg.ratio * s; // USD of BTC traded per share, one way
    let cost_usd = cfg.cost_turnover_mult * notional_per_share * cfg.fee_frac();
    cost_usd * 100.0 // USD → cents per share
}

/// Polymarket CLOB taker fee in CENTS PER SHARE for a fill at price `p`
/// (dollars 0..1) with `bps` base fee: `bps/10⁴ · min(p, 1−p) · 100`.
/// The min(p,1−p) shape is the exchange's fee-on-proceeds formula (fees
/// vanish as the price approaches the decided extremes).
pub fn pm_fee_c_per_share(p: f64, bps: f64) -> f64 {
    if p <= 0.0 || p >= 1.0 {
        return 0.0;
    }
    (bps / 10_000.0) * p.min(1.0 - p) * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{SIDE_DOWN, SIDE_UP};

    fn pos_up(shares: f64, qty: f64) -> HedgePos {
        HedgePos {
            trade_id: "T1".into(),
            side: SIDE_UP,
            shares,
            strike: 83_200.0,
            qty_btc: qty,
            ..HedgePos::default()
        }
    }

    #[test]
    fn target_sign_long_up_shorts_btc() {
        // long UP → hedge must SHORT BTC: target negative
        let p = pos_up(100.0, 0.0);
        let a = hedge_step(&p, 83_300.0, 15.5, 120.0, &HedgeCfg::default());
        assert!(a.is_some());
        assert!(a.unwrap().qty < 0.0, "long UP must short BTC");
        // long DOWN → hedge must BUY BTC
        let mut p_dn = pos_up(100.0, 0.0);
        p_dn.side = SIDE_DOWN;
        let a = hedge_step(&p_dn, 83_100.0, 15.5, 120.0, &HedgeCfg::default());
        assert!(a.is_some());
        assert!(a.unwrap().qty > 0.0, "long DOWN must buy BTC");
    }

    #[test]
    fn band_suppresses_small_drift() {
        let cfg = HedgeCfg::default();
        // establish a hedge position of −0.196 BTC (≈ target for 100 sh at
        // S = 83,302: d ≈ 0.60 → target ≈ −0.197)
        let p = pos_up(100.0, -0.196);
        // tiny S move → target shifts a hair → no order inside the band
        // (band ≈ 0.003 BTC: max(min_band, W-W width at this gamma/fee))
        assert!(hedge_step(&p, 83_302.0, 15.5, 119.0, &cfg).is_none());
        // big S move (delta collapsed as we went deep ITM) → re-hedge fires
        let a = hedge_step(&p, 84_100.0, 15.5, 60.0, &cfg);
        assert!(a.is_some());
    }

    #[test]
    fn band_grows_with_fee_and_gamma() {
        // W-W monotonicity: higher fee → wider band (fewer rebalances).
        // Position: 100 shares short-hedged −0.278 BTC, τ = 40s, S = 83,280
        // (d ≈ 0.82 → target ≈ −0.293, drift ≈ 0.015 BTC).
        let cheap = HedgeCfg { fee_bps: 2.0, ..HedgeCfg::default() };
        let dear = HedgeCfg { fee_bps: 200.0, ..HedgeCfg::default() };
        let p = pos_up(100.0, -0.278);
        let s = 83_280.0;
        let tau = 40.0;
        let a_cheap = hedge_step(&p, s, 15.5, tau, &cheap);
        let a_dear = hedge_step(&p, s, 15.5, tau, &dear);
        assert!(a_cheap.is_some(), "cheap fees should still re-hedge");
        assert!(a_dear.is_none(), "dear fees should suppress (wider band)");

        // gamma ↑ (drifting toward |d| = 1, the curvature peak) → band ↑:
        // the same drift at the peak is suppressed where it is cheapest to
        // let it ride
        let band_peak = ww_band(100.0, 83_200.0 + 15.5 * 10.954, 120.0, &cheap); // |d|=1
        let band_otm = ww_band(100.0, 83_600.0, 120.0, &cheap); // deep OTM, |d|=2.35
        let band_atm = ww_band(100.0, 83_200.0, 120.0, &cheap); // d=0, zero curvature
        assert!(band_peak > band_otm, "peak band {} must exceed OTM {}", band_peak, band_otm);
        assert!(band_peak > band_atm, "peak band {} must exceed ATM {}", band_peak, band_atm);
    }

    fn ww_band(shares: f64, s: f64, tau: f64, cfg: &HedgeCfg) -> f64 {
        let g = digital_gamma_per_share(s, 83_200.0, tau, 15.5) * shares;
        (cfg.fee_frac() * s * s * g).max(0.0).powf(1.0 / 3.0) * cfg.c_ww / s.max(1.0)
    }

    #[test]
    fn force_flatten_before_expiry() {
        let cfg = HedgeCfg::default();
        let p = pos_up(100.0, -0.190);
        // τ=2s ≤ flatten_s → flatten regardless of delta
        let a = hedge_step(&p, 83_500.0, 15.5, 2.0, &cfg);
        assert_eq!(a.unwrap().reason, "force-flatten (expiry)");
        // already flat → nothing
        let p = pos_up(100.0, 0.0);
        assert!(hedge_step(&p, 83_500.0, 15.5, 2.0, &cfg).is_none());
    }

    #[test]
    fn winddown_blocks_fresh_exposure_when_decided() {
        let cfg = HedgeCfg::default();
        // deep ITM (d>1.2), 15s left, currently flat: policy must NOT open
        // a new short (delta is collapsing toward 0 on its own)
        let p = pos_up(100.0, 0.0);
        let a = hedge_step(&p, 83_700.0, 15.5, 15.0, &cfg);
        assert!(a.is_none(), "wind-down must not open fresh exposure");
        // but a residual oversized short still gets risk-REDUCed
        let p = pos_up(100.0, -0.250);
        let a = hedge_step(&p, 83_700.0, 15.5, 15.0, &cfg);
        assert!(a.is_some());
        assert!(a.unwrap().qty > 0.0, "must buy back toward flat");
    }

    #[test]
    fn cash_flow_accounting_is_exact() {
        let mut p = pos_up(100.0, 0.0);
        apply_fill(&mut p, -0.190, 83_300.0, 0.709); // short 0.19 @ 83,300
        assert_eq!(p.qty_btc, -0.190);
        assert!((p.cash - 0.190 * 83_300.0).abs() < 1e-9);
        // price drops 100 → short is up 19
        assert!((p.pnl_at(83_200.0) - (19.0 - 0.709)).abs() < 1e-6);
        // cover at 83,200 → realized = 19.0 − fees
        apply_fill(&mut p, 0.190, 83_200.0, 0.709);
        assert!(p.is_flat());
        assert!((p.cash - 19.0).abs() < 1e-9);
        assert!((p.pnl_at(83_200.0) - (19.0 - 1.418)).abs() < 1e-6, "pnl {}", p.pnl_at(83_200.0));
    }

    #[test]
    fn cost_model_scale() {
        let cfg = HedgeCfg::default();
        // spec point: d≈0.68, φ≈0.3178, sd≈170 → ~0.00187 BTC/share →
        // notional ≈ $155/share → 2.5×0.45% ≈ $1.75 ≈ 175¢? — recompute:
        // 2.5 round trips × $155 × 0.00045 = $0.174 = 17.4¢/share
        let c = est_hedge_cost_c(83_330.0, 83_200.0, 120.0, 15.5, &cfg);
        assert!(c > 10.0 && c < 25.0, "hedge cost/share {c}¢");
        // hedging off → zero
        assert_eq!(est_hedge_cost_c(83_330.0, 83_200.0, 120.0, 15.5, &HedgeCfg { on: false, ..cfg }), 0.0);
    }

    #[test]
    fn pm_fee_shape() {
        // 1000 bps observed on the live 5m series
        assert!((pm_fee_c_per_share(0.56, 1000.0) - 4.4).abs() < 1e-9);
        assert!((pm_fee_c_per_share(0.30, 1000.0) - 3.0).abs() < 1e-9);
        assert!((pm_fee_c_per_share(0.50, 1000.0) - 5.0).abs() < 1e-9);
        // decided extremes are free
        assert_eq!(pm_fee_c_per_share(1.0, 1000.0), 0.0);
        assert_eq!(pm_fee_c_per_share(0.0, 1000.0), 0.0);
        // zero-fee market
        assert_eq!(pm_fee_c_per_share(0.56, 0.0), 0.0);
    }

    #[test]
    fn round_step_binance_precision() {
        assert_eq!(round_step(0.0019049, 0.001), 0.002);
        assert_eq!(round_step(0.0014999, 0.001), 0.001);
        assert_eq!(round_step(-0.0016, 0.001), -0.002);
        assert_eq!(round_step(0.5, 0.0), 0.5);
    }
}
