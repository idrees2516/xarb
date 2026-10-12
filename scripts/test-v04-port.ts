// ─── v0.4 TS port verification — ports the Rust unit tests ──────────────────
// sigma.rs + hedger.rs test suites, exercised against the TS port that now
// drives the live dashboard. Run: bun scripts/test-v04-port.ts

import { SigmaCalib, DEFAULT_SIGMA_CFG, normInv, SNAP_FRESH_MS } from '../mini-services/xarb-engine/src/sigma'
import { normCdf, normPdf, fvCdfEff, digitalDeltaPerShare, digitalGammaPerShare } from '../mini-services/xarb-engine/src/fairvalue'
import {
  applyHedgeFill,
  estHedgeCostC,
  hedgeIsFlat,
  hedgePnlAt,
  hedgeStep,
  newHedgePos,
  pmFeeCPerShare,
  roundStep,
  SIDE_UP,
  SIDE_DOWN,
  DEFAULT_HEDGE_CFG,
  type HedgeCfg,
} from '../mini-services/xarb-engine/src/hedger'

let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label} ${extra}`)
  }
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) < eps

// ── normInv ──────────────────────────────────────────────────────────────────
console.log('normInv (Acklam Φ⁻¹):')
ok(near(normInv(0.5), 0, 1e-9), 'Φ⁻¹(0.5)=0')
ok(near(normInv(0.55), 0.125661, 1e-5), 'Φ⁻¹(0.55)=0.1257')
ok(near(normInv(0.77), 0.738847, 1e-5), 'Φ⁻¹(0.77)=0.7388')
ok(near(normInv(0.8413), 0.9998, 5e-4), 'Φ⁻¹(0.8413)≈1')
ok(near(normInv(0.05), -1.644854, 1e-5), 'Φ⁻¹(0.05)=−1.6449')
for (const p of [0.01, 0.05, 0.25, 0.4, 0.5, 0.6, 0.75, 0.95, 0.99]) {
  ok(near(normInv(p) + normInv(1 - p), 0, 1e-9), `symmetry @${p}`)
  ok(near(normCdf(normInv(p)), p, 3e-7), `roundtrip @${p}`)
}
ok(normInv(0) === -8 && normInv(1) === 8 && normInv(NaN) === 0, 'saturation/NaN')

// ── σ inversion recovery ─────────────────────────────────────────────────────
console.log('σ implied inversion:')
{
  const cal = new SigmaCalib({ ...DEFAULT_SIGMA_CFG, kappa: 1 })
  const [k, t, sigma, s] = [83200, 120, 20, 83400]
  const d = (s - k) / (sigma * Math.sqrt(t))
  const midUp = normCdf(d) * 100
  cal.observePm(midUp, null, s, k, t, 1000, true)
  ok(near(cal.impVal(), sigma, 0.5), `UP recovers σ (${cal.impVal().toFixed(2)})`)
  const cal2 = new SigmaCalib({ ...DEFAULT_SIGMA_CFG, kappa: 1 })
  cal2.observePm(null, 100 - midUp, s, k, t, 1000, true)
  ok(near(cal2.impVal(), sigma, 0.5), `DOWN recovers σ (${cal2.impVal().toFixed(2)})`)
  ok(near(cal.snapVal() ?? 0, sigma, 0.05), 'snap latched')
  ok(near(cal.effective(1000), sigma, 0.5), 'effective honors snap')
}
console.log('identifiability gate:')
{
  const cal = new SigmaCalib(DEFAULT_SIGMA_CFG)
  let moved = cal.observePm(50.0, 50.0, 83200, 83200, 120, 1000, true)
  ok(!moved && cal.rejected === 1 && cal.accepted === 0 && cal.snapVal() == null, 'ATM rejected')
  moved = cal.observePm(50.5, 49.5, 83203, 83200, 120, 2000, true)
  ok(!moved && cal.rejected === 2, 'near-ATM (|z|=0.0125) rejected')
  moved = cal.observePm(64.0, 36.0, 83215, 83200, 120, 3000, true)
  ok(moved && cal.accepted === 1, 'z=0.358 ≥ gate accepted')
}
console.log('snap frozen at print, expires after 2s silence:')
{
  const cal = new SigmaCalib(DEFAULT_SIGMA_CFG)
  const [k, t, s] = [83200, 120, 83330]
  cal.observePm(77.0, null, s, k, t, 10000, true)
  ok(near(cal.snapVal() ?? 0, 16.06, 0.15), `snap 16.06 (${cal.snapVal()?.toFixed(2)})`)
  ok(cal.effective(11000) >= 16.0, 'snap binds while fresh')
  ok(cal.effective(12100) < 16.0, `snap expired after silence (${cal.effective(12100).toFixed(2)})`)
  cal.observePm(55.0, 50.0, s, k, t, 13000, true)
  ok(cal.snapVal() == null, 'unidentifiable fresh print clears snap')
}
console.log('dynamic floor + regime tracking + robust clamp + stale + legacy:')
{
  const cal = new SigmaCalib({ ...DEFAULT_SIGMA_CFG, kappa: 1, absFloor: 6, floorK: 0.75 })
  for (let i = 0; i < 20; i++) {
    const [k, t, s] = [83200, 120, 83260]
    const d = (s - k) / (8 * Math.sqrt(t))
    cal.observePm(normCdf(d) * 100, null, s, k, t, 1000 + i * 300, true)
  }
  ok(near(cal.impVal(), 8, 1.2), `imp tracks calm regime (${cal.impVal().toFixed(2)})`)
  ok(near(cal.floorVal(), 6, 0.5), `floor at abs in calm (${cal.floorVal().toFixed(2)})`)
  for (let i = 0; i < 30; i++) {
    const [k, t, s] = [83200, 120, 83500]
    const d = (s - k) / (40 * Math.sqrt(t))
    cal.observePm(normCdf(d) * 100, null, s, k, t, 10000 + i * 300, true)
  }
  ok(cal.impVal() > 20, `imp spikes wide regime (${cal.impVal().toFixed(2)})`)
  ok(cal.floorVal() >= 10, `floor follows regime (${cal.floorVal().toFixed(2)})`)
  cal.observeReal(5)
  ok(cal.effective(20000) >= cal.floorVal() - 1e-9, 'eff ≥ floor')

  const rc = new SigmaCalib({ ...DEFAULT_SIGMA_CFG, kappa: 1 })
  rc.observePm(90, null, 88200, 83200, 120, 1000, true)
  ok(rc.impVal() <= 15.5 * 4 + 1e-9, `robust clamp (${rc.impVal().toFixed(2)})`)

  const st = new SigmaCalib(DEFAULT_SIGMA_CFG)
  ok(!st.observePm(77, null, 83330, 83200, 120, 1000, false) && st.snapVal() == null, 'stale print ignored')

  const lg = new SigmaCalib({ ...DEFAULT_SIGMA_CFG, auto: false })
  lg.observeReal(7.5)
  ok(lg.effective(0) === 15.5, 'legacy floor 15.5')
  lg.observeReal(40)
  ok(lg.effective(0) === 40, 'legacy passes high realized')
}
ok(SNAP_FRESH_MS === 2000, 'SNAP_FRESH_MS=2000')

// ── hedger ───────────────────────────────────────────────────────────────────
console.log('δ-hedger (Whalley–Wilmott):')
// hedger.rs unit tests run at the MODULE default ratio 1.0; the engine-level
// default is the fractional 0.5 (cost-aware) — both are exercised below.
const R1: HedgeCfg = { ...DEFAULT_HEDGE_CFG, ratio: 1 }
{
  const cfg = R1
  const p = newHedgePos('T1', SIDE_UP, 100, 83200)
  const a = hedgeStep(p, 83300, 15.5, 120, cfg)
  ok(a != null && a.qty < 0, 'long UP shorts BTC')
  const pd = newHedgePos('T1', SIDE_DOWN, 100, 83200)
  const ad = hedgeStep(pd, 83100, 15.5, 120, cfg)
  ok(ad != null && ad.qty > 0, 'long DOWN buys BTC')
}
{
  const cfg = R1
  const p = newHedgePos('T1', SIDE_UP, 100, 83200)
  p.qtyBtc = -0.196
  ok(hedgeStep(p, 83302, 15.5, 119, cfg) == null, 'band suppresses tiny drift')
  ok(hedgeStep(p, 84100, 15.5, 60, cfg) != null, 'big move re-hedges')
}
{
  const cheap: HedgeCfg = { ...R1, feeBps: 2 }
  const dear: HedgeCfg = { ...R1, feeBps: 200 }
  const p = newHedgePos('T1', SIDE_UP, 100, 83200)
  p.qtyBtc = -0.278
  ok(hedgeStep(p, 83280, 15.5, 40, cheap) != null, 'cheap fee still re-hedges')
  ok(hedgeStep(p, 83280, 15.5, 40, dear) == null, 'dear fee suppresses (wider band)')
  const ww = (shares: number, s: number, tau: number, cfg: HedgeCfg) => {
    const g = digitalGammaPerShare(s, 83200, tau, 15.5) * shares
    return Math.cbrt(Math.max((cfg.feeBps / 10000) * s * s * g, 0)) * (cfg.cWw / Math.max(s, 1))
  }
  const bandPeak = ww(100, 83200 + 15.5 * 10.954, 120, cheap)
  const bandOtm = ww(100, 83600, 120, cheap)
  const bandAtm = ww(100, 83200, 120, cheap)
  ok(bandPeak > bandOtm && bandPeak > bandAtm, 'gamma peak widens band')
}
{
  const cfg = R1
  const p = newHedgePos('T1', SIDE_UP, 100, 83200)
  p.qtyBtc = -0.19
  ok(hedgeStep(p, 83500, 15.5, 2, cfg)?.reason === 'force-flatten (expiry)', 'force-flatten at τ≤3s')
  const flat = newHedgePos('T1', SIDE_UP, 100, 83200)
  ok(hedgeStep(flat, 83500, 15.5, 2, cfg) == null, 'flat stays flat')
}
{
  const cfg = R1
  const p = newHedgePos('T1', SIDE_UP, 100, 83200)
  ok(hedgeStep(p, 83700, 15.5, 15, cfg) == null, 'wind-down never opens fresh exposure')
  p.qtyBtc = -0.25
  const a = hedgeStep(p, 83700, 15.5, 15, cfg)
  ok(a != null && a.qty > 0, 'wind-down still risk-reduces')
}
{
  const p = newHedgePos('T1', SIDE_UP, 100, 83200)
  applyHedgeFill(p, -0.19, 83300, 0.709)
  ok(p.qtyBtc === -0.19, 'qty exact')
  ok(near(p.cash, 0.19 * 83300, 1e-9), 'cash exact (short credits)')
  ok(near(hedgePnlAt(p, 83200), 19 - 0.709, 1e-6), 'mark P&L exact')
  applyHedgeFill(p, 0.19, 83200, 0.709)
  ok(hedgeIsFlat(p), 'flat after cover')
  ok(near(p.cash, 19, 1e-9), 'realized cash exact')
  ok(near(hedgePnlAt(p, 83200), 19 - 1.418, 1e-6), 'realized P&L = cash − fees')
}
{
  const c = estHedgeCostC(83330, 83200, 120, 15.5, DEFAULT_HEDGE_CFG)
  ok(c > 4 && c < 12, `cost model @ratio 0.5 (${c.toFixed(1)}¢/sh)`)
  ok(estHedgeCostC(83330, 83200, 120, 15.5, { ...DEFAULT_HEDGE_CFG, on: false }) === 0, 'hedge off → 0 cost')
}
{
  ok(near(pmFeeCPerShare(0.56, 1000), 4.4, 1e-9), 'PM fee p=.56 @1000bps = 4.4¢')
  ok(near(pmFeeCPerShare(0.5, 1000), 5.0, 1e-9), 'PM fee p=.5 @1000bps = 5.0¢')
  ok(pmFeeCPerShare(1, 1000) === 0 && pmFeeCPerShare(0, 1000) === 0 && pmFeeCPerShare(0.56, 0) === 0, 'extremes/zero-fee free')
  ok(roundStep(0.0019049, 0.001) === 0.002 && roundStep(0.0014999, 0.001) === 0.001 && roundStep(-0.0016, 0.001) === -0.002, 'step rounding')
}

// ── user's spec example end-to-end (hedge_scenario.rs port) ──────────────────
console.log("user's spec example (K=83,200 · S→83,330 · T=120s · ask 56¢ · 1000bps):")
{
  const k = 83200
  const s = 83330
  const t = 120
  const sigma = 16 // spec-calibrated
  const fv = fvCdfEff(s, k, t, sigma)
  ok(near(fv.value, 77, 0.6), `FV ≈ 77¢ (${fv.value.toFixed(1)}¢)`)
  const fvStart = fvCdfEff(83215, k, 135, sigma)
  ok(near(fvStart.value, 55, 2.5), `FV@+15pts ≈ 55¢ (${fvStart.value.toFixed(1)}¢)`)
  const ask = 56
  const edge = fv.value - ask
  ok(near(edge, 21, 0.6), `edge ≈ 21¢ (${edge.toFixed(1)}¢)`)
  const feeBps = 1000
  const feeC = pmFeeCPerShare(ask / 100, feeBps)
  const netHalf = edge - feeC - estHedgeCostC(s, k, t, sigma, DEFAULT_HEDGE_CFG)
  ok(netHalf >= 1.5, `fractional ratio 0.5 FIRES (net ${netHalf.toFixed(1)}¢ ≥ 1.5¢)`)
  const fullCfg: HedgeCfg = { ...DEFAULT_HEDGE_CFG, ratio: 1 }
  const netFull = edge - feeC - estHedgeCostC(s, k, t, sigma, fullCfg)
  ok(netFull < 1.5, `full-ratio mid-gamma REJECTED by gate (net ${netFull.toFixed(1)}¢ < 1.5¢)`)
  const delta = digitalDeltaPerShare(s, k, t, sigma)
  const shares = 50
  const shortQty = -shares * delta * 0.5
  ok(shortQty < 0 && Math.abs(shortQty) > 0.02, `initial hedge ≈ ${shortQty.toFixed(4)} BTC for 50 sh`)
}

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail ? 1 : 0)
