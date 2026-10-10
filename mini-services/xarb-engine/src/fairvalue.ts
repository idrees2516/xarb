// ─── Fair value models for Polymarket 5m BTC UP token ─────────────────────────
// Strategy spec (user example, T=120s remaining):
//   strike 83,200 · BTC 83,215 → UP ≈ 55¢ · BTC 83,330 → UP ≈ 77¢
//   ⇒ Linear:   FV = 52 + 0.19·(S−K) at T=120 (baseline 52, slope 0.19¢/pt)
//   ⇒ NormalCDF calibrated: Φ((S−K)/(σ·√T)) with σ ≈ 15.5 pts/√s
//      (+130 pts, T=120 → Φ(130/170)=77.8¢ ✓ · +15 pts → 53.5¢ ≈ 55 ✓)
//   The CDF is the honest model: bounded 1–99¢, never extrapolates past
//   certainty, and deep-OTM/ITM keep real time value near expiry (the linear
//   spec blows through 0/100 and treats a 300-pt lead with 1 min left the
//   same as a 30-pt lead).

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Linear model calibrated to the strategy spec. Slope grows as the window ages. */
export function fvLinear(s: number, k: number, tSec: number): { value: number; slope: number } {
  const slope = clamp(0.19 * Math.sqrt(120 / Math.max(tSec, 1)), 0.1, 1.4)
  const value = clamp(52 + slope * (s - k), 1, 99)
  return { value, slope }
}

/** Normal-CDF probability density φ(z). */
export function normPdf(z: number): number {
  return 0.3989422804014327 * Math.exp((-z * z) / 2)
}

/** σ floor calibrated to the user's spec example (see header).
 *  Realized σ below this floor would claim more certainty than the spec —
 *  deep-OTM quotes would collapse to 0¢ dishonestly. Vol spikes widen σ
 *  (momentum bursts), so tails stay honest in both directions. */
export const SIGMA_FLOOR_PTS = 15.5
export const SIGMA_CAP_PTS = 90

export function sigmaEff(sigmaPts: number): number {
  return clamp(sigmaPts, SIGMA_FLOOR_PTS, SIGMA_CAP_PTS)
}

/** Normal-CDF fair value with full detail: value (¢), z-score, sd (pts),
 *  local slope (¢/pt = φ(z)·100/sd). */
export function fvCdfDetail(
  s: number,
  k: number,
  tSec: number,
  sigmaPts: number
): { value: number; z: number; sd: number; slope: number } {
  const sd = Math.max(sigmaEff(sigmaPts) * Math.sqrt(Math.max(tSec, 1)), 5)
  const z = (s - k) / sd
  const value = clamp(normCdf(z) * 100, 1, 99)
  const slope = (normPdf(z) * 100) / sd
  return { value, z, sd, slope }
}

/** Normal-CDF model: P(UP) = Φ((S−K)/(σ_eff·√T)), σ from realized Binance ticks
 *  with a spec-calibrated floor. Prices deep OTM honestly (bounded, tailed). */
export function fvCdf(s: number, k: number, tSec: number, sigmaPts: number): number {
  return fvCdfDetail(s, k, tSec, sigmaPts).value
}

/** Abramowitz & Stegun 7.1.26 (fixed: Q = φ·t·(b1 + b2·t + …), no double-t) */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p =
    d *
    t *
    (0.31938153 -
      0.356563782 * t +
      1.781477937 * t * t -
      1.821255978 * t * t * t +
      1.330274429 * t * t * t * t)
  return z > 0 ? 1 - p : p
}

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const idx = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1)
  return sorted[idx]
}

export function fmtUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}µs`
  return `${(us / 1000).toFixed(2)}ms`
}
