// ─── Fair value models for Polymarket 5m BTC UP token ─────────────────────────
// Strategy spec (user example, T=120s remaining):
//   strike 83,200 · BTC 83,215 → UP ≈ 55¢ · BTC 83,330 → UP ≈ 77¢
//   ⇒ FV = 52 + 0.19·(S−K) at T=120 ⇒ baseline 52 at the strike, slope 0.19¢/pt

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Linear model calibrated to the strategy spec. Slope grows as the window ages. */
export function fvLinear(s: number, k: number, tSec: number): { value: number; slope: number } {
  const slope = clamp(0.19 * Math.sqrt(120 / Math.max(tSec, 1)), 0.1, 1.4)
  const value = clamp(52 + slope * (s - k), 1, 99)
  return { value, slope }
}

/** Normal-CDF model: P(UP) = Φ((S−K)/(σ√T)) with σ from realized Binance ticks. */
export function fvCdf(s: number, k: number, tSec: number, sigmaPts: number): number {
  const sd = Math.max(sigmaPts * Math.sqrt(Math.max(tSec, 1)), 4)
  const z = (s - k) / sd
  return clamp(normCdf(z) * 100, 1, 99)
}

/** Abramowitz & Stegun 7.1.26 */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p =
    d *
    t *
    (0.31938153 * t -
      0.356563782 * t * t +
      1.781477937 * t * t * t -
      1.821255978 * t * t * t * t +
      1.330274429 * t * t * t * t * t)
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
