// ─── Delta-hedging of the binary (digital-option) exposure on Binance ────────
// Port of xarb-rs/xarb-engine/src/hedger.rs (v0.4).
//
// A long UP share is a digital call: its value Φ(d) moves with BTC spot.
// Buying the discounted share leaves a directional position whose P&L is
// dominated by BTC drift between entry and window close. The hedger
// neutralises it by shorting Δ = φ(d)/sd BTC per share on Binance (USDT-M
// perp in live mode; the live Binance book in paper mode), so the combined
// (binary + hedge) position isolates the entry mispricing.
//
// Policy (all pure functions, time-injected, fully unit-testable):
//   • **Target**: target = −dir · shares · φ(d)/sd · ratio BTC
//     (dir = +1 for UP shares, −1 for DOWN shares).
//   • **Whalley–Wilmott no-trade band**: re-hedge only when the hedge error
//     leaves the band max(min_qty, c_ww·(κ·S²·Γ_pos)^⅓) — the asymptotically
//     optimal band under proportional transaction costs (band grows with fee
//     κ and position gamma Γ, shrinks with size).
//   • **Wind-down**: in the last winddown_s seconds, if |d| > 1.2 the digital
//     is effectively decided — delta collapses toward 0 on its own,
//     re-hedging would only pay fees into the gamma explosion.
//   • **Force-flatten**: at flatten_s before close the hedge is closed
//     (reduce-only) so settlement is clean.
//   • **Cost model**: estHedgeCostC predicts the per-share hedge turnover
//     cost (initial + rebalances + flatten) that the net-edge profitability
//     gate subtracts from the trigger edge.

import { digitalDeltaPerShare, digitalGammaPerShare } from './fairvalue'

export const SIDE_UP = 1
export const SIDE_DOWN = -1

/** Hedge policy knobs (dashboard-tunable). */
export interface HedgeCfg {
  /** Delta-hedging master switch. */
  on: boolean
  /** Fraction of delta hedged (1.0 = fully neutral). Fractional (0.5)
   *  default: full replication of a 5-minute digital costs ~the entire
   *  entry edge; a half-delta fence insures the hold at half the cost. */
  ratio: number
  /** Binance taker fee in bps (4.5 = 0.045%, the USDT-M perp VIP0 taker). */
  feeBps: number
  /** Whalley–Wilmott constant (band calibration; 20 ≈ $200 notional band
   *  for a 50-share ATM position). */
  cWw: number
  /** Minimum band (BTC) — never tighter than the exchange min order. */
  minBandBtc: number
  /** Stop re-hedging this close to expiry when the digital is decided
   *  (|d| > 1.2). */
  winddownS: number
  /** Force-flatten the hedge this close to expiry (reduce-only). */
  flattenS: number
  /** Binance minimum order quantity (BTC). */
  minQtyBtc: number
  /** Quantity step (BTC) — Binance BTCUSDT perp stepSize. */
  qtyStepBtc: number
  /** Turnover multiplier for the cost model (initial + ~2 rebalances +
   *  flatten ≈ 2.5 round trips of the entry delta). */
  costTurnoverMult: number
}

export const DEFAULT_HEDGE_CFG: HedgeCfg = {
  on: true,
  ratio: 0.5,
  feeBps: 4.5,
  cWw: 20.0,
  minBandBtc: 0.002,
  winddownS: 20.0,
  flattenS: 3.0,
  minQtyBtc: 0.001,
  qtyStepBtc: 0.001,
  costTurnoverMult: 2.5,
}

export function hedgeFeeFrac(cfg: HedgeCfg): number {
  return cfg.feeBps / 10000
}

/** Live hedge position (cash-flow accounting — exact by construction). */
export interface HedgePos {
  /** Trade (binary position) this hedge belongs to. */
  tradeId: string
  /** Binary side held (SIDE_UP / SIDE_DOWN). */
  side: number
  /** Binary shares held. */
  shares: number
  /** Binary strike. */
  strike: number
  /** Signed hedge quantity in BTC (negative = short BTC, i.e. hedging a
   *  long UP position). */
  qtyBtc: number
  /** Average hedge entry price (reporting/mark only; cash is exact). */
  avgPx: number
  /** Cumulative hedge cash flow: fills add −qty·px (buy costs, sells
   *  credit). Realized P&L when flat = cash − fees. */
  cash: number
  /** Cumulative hedge fees (USD). */
  fees: number
  /** Number of hedge fills (stats). */
  fills: number
  /** Last computed target (BTC, signed). */
  targetBtc: number
  /** Last computed band (BTC). */
  bandBtc: number
}

export function newHedgePos(
  tradeId: string,
  side: number,
  shares: number,
  strike: number
): HedgePos {
  return {
    tradeId,
    side,
    shares,
    strike,
    qtyBtc: 0,
    avgPx: 0,
    cash: 0,
    fees: 0,
    fills: 0,
    targetBtc: 0,
    bandBtc: 0,
  }
}

/** Mark-to-market hedge P&L at price s (USD): cash − fees + qty·s. */
export function hedgePnlAt(pos: HedgePos, s: number): number {
  return pos.cash - pos.fees + pos.qtyBtc * s
}

export function hedgeIsFlat(pos: HedgePos): boolean {
  return Math.abs(pos.qtyBtc) < 1e-9
}

/** Apply a hedge fill to the position (exact cash-flow accounting). */
export function applyHedgeFill(pos: HedgePos, qty: number, px: number, feeUsd: number): void {
  if (qty === 0) return
  // weighted average entry price for reporting
  const newQty = pos.qtyBtc + qty
  if (pos.avgPx > 0 && Math.abs(newQty) > 1e-9 && Math.sign(qty) === Math.sign(pos.qtyBtc)) {
    const w = Math.abs(pos.qtyBtc) / Math.abs(newQty)
    pos.avgPx = w * pos.avgPx + (1 - w) * px
  } else {
    pos.avgPx = px
  }
  pos.qtyBtc = roundStep(Math.abs(newQty), 1e-7) * Math.sign(newQty)
  pos.cash += -qty * px
  pos.fees += feeUsd
  pos.fills++
}

/** One hedge decision. qty = signed order quantity (BTC): negative = SELL
 *  (short more), positive = BUY (cover). Already step-rounded. */
export interface HedgeAction {
  qty: number
  reason: string
}

/** Round to the Binance quantity step (avoids precision-noise rejects). */
export function roundStep(q: number, step: number): number {
  if (step <= 0) return q
  return Math.round(q / step) * step
}

/** Pure hedge policy step. s = Binance mark, sigmaEff = effective σ
 *  (points/√s), tau = seconds to window close. */
export function hedgeStep(
  pos: HedgePos,
  s: number,
  sigmaEff: number,
  tau: number,
  cfg: HedgeCfg
): HedgeAction | null {
  if (!cfg.on || pos.shares <= 0 || pos.strike <= 0 || s <= 0 || tau <= 0) return null
  // force-flatten: clean settlement, no expiry gamma roulette
  if (tau <= cfg.flattenS) {
    if (Math.abs(pos.qtyBtc) >= cfg.minQtyBtc) {
      const qty = roundStep(-pos.qtyBtc, cfg.qtyStepBtc)
      if (Math.abs(qty) >= cfg.minQtyBtc) {
        return { qty, reason: 'force-flatten (expiry)' }
      }
    }
    return null
  }

  // target hedge quantity
  const dlt = digitalDeltaPerShare(s, pos.strike, tau, sigmaEff)
  const dir = pos.side === SIDE_DOWN ? -1 : 1
  const target = -dir * pos.shares * dlt * cfg.ratio

  // wind-down: digital decided (|d| > 1.2) and near expiry → delta is
  // collapsing on its own; trading now only pays into the gamma explosion
  const sd = Math.max(sigmaEff * Math.sqrt(Math.max(tau, 1)), 5)
  const d = ((s - pos.strike) / sd) * dir
  if (tau <= cfg.winddownS && Math.abs(d) > 1.2) {
    // still bound to the band against the collapsing target, but never
    // ADD fresh hedge exposure in the wind-down zone
    const drift = pos.qtyBtc - target
    if (Math.abs(drift) < Math.max(cfg.minBandBtc, pos.bandBtc)) return null
    // allow only risk-REDUCing moves (toward flat)
    const towardFlat = Math.abs(target - pos.qtyBtc) < Math.abs(pos.qtyBtc)
    if (!towardFlat) return null
  }

  // Whalley–Wilmott band: max(min_qty, c_ww·(κ·S²·Γ)^⅓), capped at 30% of
  // the target so a huge gamma reading can't disable hedging entirely.
  const g = digitalGammaPerShare(s, pos.strike, tau, sigmaEff) * pos.shares
  const ww = Math.cbrt(Math.max(hedgeFeeFrac(cfg) * s * s * g, 0)) * (cfg.cWw / Math.max(s, 1))
  const band = Math.min(
    Math.max(cfg.minBandBtc, ww),
    Math.max(Math.abs(target) * 0.3, cfg.minBandBtc)
  )
  pos.targetBtc = target
  pos.bandBtc = band

  const err = pos.qtyBtc - target
  if (Math.abs(err) < band) return null
  const qty = roundStep(-err, cfg.qtyStepBtc)
  if (Math.abs(qty) < cfg.minQtyBtc) return null
  return { qty, reason: 're-hedge (band breach)' }
}

/** Predicted hedge cost in CENTS PER SHARE at entry — the number the
 *  net-edge profitability gate subtracts. Turnover ≈ costTurnoverMult
 *  round trips of the entry delta notional. */
export function estHedgeCostC(
  s: number,
  k: number,
  tau: number,
  sigmaEff: number,
  cfg: HedgeCfg
): number {
  if (!cfg.on || cfg.ratio <= 0) return 0
  const dlt = digitalDeltaPerShare(s, k, tau, sigmaEff)
  const notionalPerShare = dlt * cfg.ratio * s // USD of BTC traded per share, one way
  const costUsd = cfg.costTurnoverMult * notionalPerShare * hedgeFeeFrac(cfg)
  return costUsd * 100 // USD → cents per share
}

/** Polymarket CLOB taker fee in CENTS PER SHARE for a fill at price p
 *  (dollars 0..1) with bps base fee: bps/10⁴ · min(p, 1−p) · 100.
 *  The min(p,1−p) shape is the exchange's fee-on-proceeds formula (fees
 *  vanish as the price approaches the decided extremes). */
export function pmFeeCPerShare(p: number, bps: number): number {
  if (p <= 0 || p >= 1) return 0
  return (bps / 10000) * Math.min(p, 1 - p) * 100
}
