// ─── σ auto-calibration from live Polymarket prices ───────────────────────────
// Port of xarb-rs/xarb-core/src/sigma.rs (v0.4). The FV model needs σ (BTC
// points per √second). Two live estimates are blended, floored, and — when
// Polymarket prints a fresh IDENTIFIABLE quote — snapped to the market's own
// implied σ:
//
// 1. **Implied σ (σ_imp)** — inverted from the live PM mid quote on every
//    fresh book print: the market's mid m implies z = Φ⁻¹(m) and hence
//    σ = (S−K)/(z·√τ) (UP side; symmetric with (K−S) for the DOWN side).
//    Near the money the quote is unidentifiable (|z| → 0 with S→K), so
//    samples below the |z| gate are rejected — the classic
//    ill-conditioning trap. Surviving samples are robust-clamped and
//    EWMA-smoothed.
// 2. **Realized σ (σ_real)** — the 1s-sampled EWMA variance from the
//    Binance trade stream (BinanceFeed.volPts).
//
// **Snap**: whenever a fresh print contains an identifiable mid, the exact σ
// that makes FV equal that mid is latched. While the book keeps printing, FV
// therefore tracks the market's own price (no phantom edge). The snap is
// frozen at PRINT time — during book silence (the reaction-lag window the
// strategy monetises) FV floats with Binance and the edge vs the stale quote
// appears. The snap expires after 2s of book silence.
//
// **Floor**: max(abs_floor, floor_k · median(σ_imp history)) —
// auto-calibrated to the live PM regime. A market where PM prices wide
// (high implied σ) raises the floor and keeps FV from claiming more
// certainty than the market itself; a calm market lowers it. The floor is
// the honesty bound: σ too low snaps FV to 0/100 and fires false triggers.
//
// σ_eff = clamp(max(blend(σ_imp, σ_real), floor, snap_fresh), …, cap).

import { normCdf } from './fairvalue'

/** Knobs for the calibrator (dashboard-tunable). */
export interface SigmaCfg {
  /** Auto-calibration on (false → legacy fixed-floor clamp of realized σ). */
  auto: boolean
  /** Weight of implied σ in the blend (0..1). Default 0.65. */
  wImp: number
  /** Minimum |Φ⁻¹(mid)| for a quote to identify σ (identifiability gate).
   *  0.35 ⇔ mids outside (36.3¢, 63.7¢) are identifiable. */
  zGate: number
  /** EWMA step for σ_imp updates (0..1). Default 0.30. */
  kappa: number
  /** Dynamic floor = floorK × median(σ_imp history). Default 0.75. */
  floorK: number
  /** Absolute sanity floor (points/√s) — never trust σ below this. */
  absFloor: number
  /** Hard cap (points/√s). */
  cap: number
  /** σ_imp history length for the median floor (decimated ≥250ms). */
  histCap: number
}

export const DEFAULT_SIGMA_CFG: SigmaCfg = {
  auto: true,
  wImp: 0.65,
  zGate: 0.35,
  kappa: 0.3,
  floorK: 0.75,
  absFloor: 6.0,
  cap: 90.0,
  histCap: 240,
}

/** A fresh book print's snap survives this long without another print. */
export const SNAP_FRESH_MS = 2000

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** A mid usable for inversion: present, inside (5, 95)¢. */
function usableMid(m: number | null): number | null {
  if (m == null || !Number.isFinite(m)) return null
  if (m < 5.0 || m > 95.0) return null
  return m
}

/** Pure σ calibrator — deterministic, fully unit-testable. */
export class SigmaCalib {
  cfg: SigmaCfg
  /** Implied σ (EWMA, points/√s). Initialised at the spec-calibrated 15.5. */
  private imp = 15.5
  /** Realized σ mirror (pushed by the feed's EWMA, points/√s). */
  private real = 7.5
  /** Decimated σ_imp history for the median floor. */
  private hist: number[] = [15.5]
  private lastSampleMs = 0
  /** Cached dynamic floor (recomputed on history push only). */
  private floorCache: number
  /** Snap latched at the last identifiable fresh print (points/√s). */
  private snap: number | null = null
  /** Print time of the last fresh book observation. */
  private lastPrintMs = 0
  /** Last computed σ_eff. */
  private eff = 15.5
  /** True when the last effective() actually took the snap value (the snap
   *  only binds when it RAISES σ above the blend + floor). */
  private snapBound = false
  /** Samples accepted by the identifiability gate (stats). */
  accepted = 0
  /** Samples rejected by the gates (stats). */
  rejected = 0

  constructor(cfg: SigmaCfg = { ...DEFAULT_SIGMA_CFG }) {
    this.cfg = cfg
    this.floorCache = cfg.absFloor
  }

  impVal(): number {
    return this.imp
  }
  realVal(): number {
    return this.real
  }
  floorVal(): number {
    return this.floorCache
  }
  snapVal(): number | null {
    return this.snap
  }
  /** Age of the last book print (ms) — drives the snap-fresh indicator. */
  snapAgeMs(nowMs: number): number | null {
    return this.lastPrintMs ? nowMs - this.lastPrintMs : null
  }
  effVal(): number {
    return this.eff
  }

  setCfg(cfg: SigmaCfg): void {
    this.cfg = cfg
  }

  /** Fold the FV engine's realized-vol EWMA into the calibrator. */
  observeReal(volPts: number): void {
    if (Number.isFinite(volPts) && volPts > 0) this.real = volPts
  }

  /** One fresh book print. midUpC/midDnC are UP/DOWN mids in cents (null
   *  when the side is empty). fresh = the book passed the age budget.
   *  Returns true when σ_imp moved. */
  observePm(
    midUpC: number | null,
    midDnC: number | null,
    s: number,
    k: number,
    tSec: number,
    nowMs: number,
    fresh: boolean
  ): boolean {
    if (!fresh || !this.cfg.auto) return false
    this.lastPrintMs = nowMs
    if (k <= 0 || s <= 0 || tSec < 3) {
      // window not live: a print still clears any stale snap
      this.snap = null
      this.rejected++
      return false
    }
    const sqrtT = Math.sqrt(tSec)
    const cands: number[] = []
    // UP side: m = Φ((S−K)/(σ√τ)) → σ = (S−K)/(z·√τ)
    const mu = usableMid(midUpC)
    if (mu != null) {
      const z = normInv(mu / 100)
      if (Math.abs(z) >= this.cfg.zGate) {
        const raw = (s - k) / (z * sqrtT)
        if (Number.isFinite(raw) && raw > 0) cands.push(raw)
      }
    }
    // DOWN side: m = Φ((K−S)/(σ√τ)) → σ = (K−S)/(z·√τ)
    const md = usableMid(midDnC)
    if (md != null) {
      const z = normInv(md / 100)
      if (Math.abs(z) >= this.cfg.zGate) {
        const raw = (k - s) / (z * sqrtT)
        if (Number.isFinite(raw) && raw > 0) cands.push(raw)
      }
    }
    // Latch/clear the snap at print time (frozen at print, see module docs —
    // the snap is never recomputed with a moved S).
    if (cands.length) {
      this.snap = clamp(Math.max(...cands), this.cfg.absFloor, this.cfg.cap)
    } else {
      this.snap = null
    }
    if (!cands.length) {
      this.rejected++
      return false
    }
    // EWMA update (robust clamp: one quote can only move σ_imp so far)
    let raw = cands.reduce((a, c) => a + c, 0) / cands.length
    const lo = this.imp * 0.25
    const hi = this.imp * 4
    raw = clamp(raw, lo, hi)
    const delta = this.cfg.kappa * (raw - this.imp)
    this.imp = clamp(this.imp + delta, 0.5, this.cfg.cap)
    this.accepted++

    // history push (decimated ≥250ms) → recompute the median floor
    if (nowMs - this.lastSampleMs >= 250) {
      this.lastSampleMs = nowMs
      this.hist.push(this.imp)
      if (this.hist.length > this.cfg.histCap) this.hist.shift()
      this.floorCache = this.recomputeFloor()
    }
    return true
  }

  /** Dynamic floor: max(abs_floor, floorK · median(history)). */
  private recomputeFloor(): number {
    const v = [...this.hist].sort((a, b) => a - b)
    const n = v.length
    const median =
      n === 0 ? 15.5 : n % 2 === 1 ? v[(n - 1) >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2
    const dynFloor = this.cfg.floorK * median
    return Math.max(dynFloor, this.cfg.absFloor)
  }

  /** Effective σ at nowMs.
   *  auto off → legacy fixed-floor clamp of realized σ.
   *  auto on  → clamp(max(blend, floor, snap_fresh), floor, cap). */
  effective(nowMs: number): number {
    if (!this.cfg.auto) {
      this.eff = clamp(this.real, 15.5, this.cfg.cap)
      this.snapBound = false
      return this.eff
    }
    const w = clamp(this.cfg.wImp, 0, 1)
    const blend = w * this.imp + (1 - w) * this.real
    let v = Math.max(blend, this.floorCache)
    this.snapBound = false
    if (this.snap != null && nowMs - this.lastPrintMs <= SNAP_FRESH_MS) {
      if (this.snap > v) {
        v = this.snap
        this.snapBound = true
      }
    }
    this.eff = clamp(v, this.cfg.absFloor, this.cfg.cap)
    return this.eff
  }

  /** Did the last effective() actually take the print-time snap (FV pinned
   *  to PM's own quote — only when the snap raises σ above floor/blend)? */
  snapped(): boolean {
    return this.snapBound
  }

  /** Force σ_imp (tests / warm start). */
  setImpForTest(v: number): void {
    this.imp = v
    this.hist = [v]
    this.floorCache = this.recomputeFloor()
  }
}

/** Acklam's inverse normal CDF — |relative error| < 1.15e-9 over the full
 *  (0,1) domain (tails saturate at ±8 where Φ is < 1e-15 anyway). */
export function normInv(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) return 0
  if (p <= 0) return -8
  if (p >= 1) return 8
  const A = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751862769e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const B = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const C = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134187142996, 3.754408661907416]
  const P_LOW = 0.02425
  const pHigh = 1 - P_LOW

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p))
    const num = ((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]
    const den = (((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1
    return num / den
  } else if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    const num = (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
    const den = ((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1
    return num / den
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    const num = ((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]
    const den = (((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1
    return -(num / den)
  }
}

// re-export for tests that want to cross-check Φ⁻¹ against Φ
export { normCdf }
