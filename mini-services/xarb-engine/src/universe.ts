// ─── XARB market universe (v0.5) ───────────────────────────────────────────────
// Generalized registry of EVERY Polymarket short-window up/down series that
// resolves against a live Binance spot feed. The engine is market-agnostic:
// any (series × window) pair below is discovered, priced, triggered, hedged
// and settled independently — enabling/disabling live from the dashboard.
//
// Discovered live (gamma API probe, all accepting orders):
//   5m : btc, eth, sol, xrp, doge, bnb, hype   → slug {asset}-updown-5m-{epoch}
//   15m: btc, eth, sol, xrp                    → slug {asset}-updown-15m-{epoch}
//
// σ UNITS — BTC-anchored points: settings express σ in "BTC points" where
// 1 pt = price/ANCHOR of the market's own asset (a *relative* unit). This
// keeps every existing knob (floor 6.0, cap 90, legacy 15.5) meaningful on
// every asset: ETH σ 0.15 pts ≈ BTC σ 6 pts ≈ 7.2 bp/√s.

/** Price anchor for BTC-anchored σ points (≈ BTC price at spec calibration). */
export const SIGMA_ANCHOR = 83200

/** Convert a BTC-anchored σ setting into the market's own points. */
export function scaleSigmaPts(ptsBtc: number, price: number): number {
  return (ptsBtc * price) / SIGMA_ANCHOR
}

/** Convert a market's own points σ into comparable bp/√s (for display). */
export function sigmaPtsToBps(pts: number, price: number): number {
  return price > 0 ? (pts / price) * 1e4 : 0
}

export interface MarketSpec {
  /** Stable id, e.g. 'btc-5m'. */
  id: string
  /** Short label, e.g. 'BTC 5m'. */
  label: string
  /** Underlying asset symbol, e.g. 'BTC'. */
  asset: string
  /** Gamma series slug prefix, e.g. 'btc-updown-5m'. */
  series: string
  /** Binance spot symbol (price feed + hedge leg). */
  binanceSym: string
  /** Window length in seconds (300 = 5m, 900 = 15m). */
  windowSec: number
  /** Binance LOT_SIZE step for the hedge leg (asset units). */
  qtyStep: number
  /** Binance LOT_SIZE min order qty (asset units). */
  minQty: number
  /** Display price decimals. */
  priceDp: number
  /** Warm-start realized vol (bp/√s, relative). */
  volBps: number
}

/** The full tradable universe — every series is independently switchable. */
export const UNIVERSE: MarketSpec[] = [
  // ── 5-minute series ────────────────────────────────────────────────────
  { id: 'btc-5m', label: 'BTC 5m', asset: 'BTC', series: 'btc-updown-5m', binanceSym: 'BTCUSDT', windowSec: 300, qtyStep: 0.00001, minQty: 0.00001, priceDp: 1, volBps: 9 },
  { id: 'eth-5m', label: 'ETH 5m', asset: 'ETH', series: 'eth-updown-5m', binanceSym: 'ETHUSDT', windowSec: 300, qtyStep: 0.0001, minQty: 0.0001, priceDp: 2, volBps: 11 },
  { id: 'sol-5m', label: 'SOL 5m', asset: 'SOL', series: 'sol-updown-5m', binanceSym: 'SOLUSDT', windowSec: 300, qtyStep: 0.001, minQty: 0.001, priceDp: 2, volBps: 14 },
  { id: 'xrp-5m', label: 'XRP 5m', asset: 'XRP', series: 'xrp-updown-5m', binanceSym: 'XRPUSDT', windowSec: 300, qtyStep: 0.1, minQty: 0.1, priceDp: 4, volBps: 16 },
  { id: 'doge-5m', label: 'DOGE 5m', asset: 'DOGE', series: 'doge-updown-5m', binanceSym: 'DOGEUSDT', windowSec: 300, qtyStep: 1, minQty: 1, priceDp: 5, volBps: 17 },
  { id: 'bnb-5m', label: 'BNB 5m', asset: 'BNB', series: 'bnb-updown-5m', binanceSym: 'BNBUSDT', windowSec: 300, qtyStep: 0.001, minQty: 0.001, priceDp: 2, volBps: 10 },
  { id: 'hype-5m', label: 'HYPE 5m', asset: 'HYPE', series: 'hype-updown-5m', binanceSym: 'HYPEUSDT', windowSec: 300, qtyStep: 0.001, minQty: 0.001, priceDp: 2, volBps: 19 },
  // ── 15-minute series ───────────────────────────────────────────────────
  { id: 'btc-15m', label: 'BTC 15m', asset: 'BTC', series: 'btc-updown-15m', binanceSym: 'BTCUSDT', windowSec: 900, qtyStep: 0.00001, minQty: 0.00001, priceDp: 1, volBps: 9 },
  { id: 'eth-15m', label: 'ETH 15m', asset: 'ETH', series: 'eth-updown-15m', binanceSym: 'ETHUSDT', windowSec: 900, qtyStep: 0.0001, minQty: 0.0001, priceDp: 2, volBps: 11 },
  { id: 'sol-15m', label: 'SOL 15m', asset: 'SOL', series: 'sol-updown-15m', binanceSym: 'SOLUSDT', windowSec: 900, qtyStep: 0.001, minQty: 0.001, priceDp: 2, volBps: 14 },
  { id: 'xrp-15m', label: 'XRP 15m', asset: 'XRP', series: 'xrp-updown-15m', binanceSym: 'XRPUSDT', windowSec: 900, qtyStep: 0.1, minQty: 0.1, priceDp: 4, volBps: 16 },
]

/** Stable spec lookup. */
export function specById(id: string): MarketSpec | undefined {
  return UNIVERSE.find((s) => s.id === id)
}

/** Gamma event slug for a series at a window-start epoch. */
export function slugFor(spec: MarketSpec, epoch: number): string {
  return `${spec.series}-${epoch}`
}

/** All Binance symbols the universe can require (deduped). */
export function allBinanceSyms(): string[] {
  return [...new Set(UNIVERSE.map((s) => s.binanceSym))]
}
