// ─── Live fire probe: exercise the full v0.4 trade cycle ──────────────────────
// Relaxes thresholds via the control socket, watches EXECUTED → HEDGE fills →
// re-hedges → settle/exit → capture accounting, then restores spec thresholds.

import { io } from 'socket.io-client'

const s = io('http://localhost:3011', { transports: ['websocket'] })
const log = (...a: unknown[]) => console.log(...a)

const RELAX = {
  jumpThreshC: 0.5,
  fvFloorC: 5,
  edgeThreshC: 3,
  minSecsLeft: 10,
  hedgeRatio: 0.1, // small hedge → net gate passes at the current σ/τ state
}
const RESTORE = {
  jumpThreshC: 20,
  fvFloorC: 60,
  edgeThreshC: 10,
  minSecsLeft: 45,
  hedgeRatio: 0.5,
}

let fired = 0
let hedgeFills = 0
let settled = 0
let done = false

const finish = (label: string) => {
  if (done) return
  done = true
  s.emit('control', { type: 'settings', settings: RESTORE })
  setTimeout(() => {
    log(`\n[probe] ${label}`)
    log(`[probe] fired=${fired} hedgeFills=${hedgeFills} settled=${settled}`)
    process.exit(0)
  }, 1500)
}

s.on('connect', () => {
  log('[probe] connected — relaxing thresholds')
  s.emit('control', { type: 'settings', settings: RELAX })
})

s.on('signal', (sig: any) => {
  if (sig.action === 'EXECUTED') {
    fired++
    log(`[probe] EXECUTED fv=${sig.fv?.toFixed(1)} ask=${sig.ask} edge=${sig.edge?.toFixed(1)} net=${sig.netEdgeC?.toFixed(1)} fill=${sig.fillPrice?.toFixed(1)} sh=${Math.round(sig.shares ?? 0)} σ=${sig.sigmaEffPts?.toFixed(1)}`)
  } else if (sig.action === 'EXIT') {
    log(`[probe] EXIT ${sig.reason}`)
  } else if (fired > 0 && sig.action === 'SKIPPED') {
    log(`[probe] skip: ${sig.reason}`)
  }
})

s.on('hedge', (e: any) => {
  hedgeFills++
  log(`[probe] HEDGE ${e.qtyBtc < 0 ? 'SHORT' : 'COVER'} ${e.qtyBtc.toFixed(4)} @ ${e.px?.toFixed(1)} (${e.reason}) pos=${e.posQtyBtc.toFixed(4)} fee=$${e.feeUsd?.toFixed(3)} pnl=$${e.pnlUsd?.toFixed(2)}`)
})

s.on('settle', (t: any) => {
  settled++
  log(`[probe] SETTLE ${t.status} pnl=${t.pnlUsd?.toFixed(2)} binary=${(t.status === 'WON' ? t.shares - t.costUsd - t.feeUsd : -t.costUsd - t.feeUsd).toFixed(2)} hedge=${t.hedgePnlUsd?.toFixed(2)}(${t.hedgeFills} fills, $${t.hedgeFeesUsd?.toFixed(3)} fees) final=${t.finalPrice?.toFixed(1)} exit=${t.exitPxC ?? '—'}`)
})

// snap: watch capture accounting + hedge state
let snaps = 0
s.on('snap', (x: any) => {
  snaps++
  if (snaps % 100 === 0 && fired > 0) {
    log(`[probe] live: hedge=${x.hedge.qtyBtc.toFixed(4)} target=${x.hedge.targetBtc.toFixed(4)} band=${x.hedge.bandBtc.toFixed(4)} pnl=$${x.hedge.pnlUsd.toFixed(2)} | capture opps=${x.capture.opportunities} fired=${x.capture.fired} gated=${x.capture.missed}`)
  }
})

// stop after 5 minutes or once we've seen a settle with hedge fills
setTimeout(() => finish('timeout'), 300_000)
setInterval(() => {
  if (settled >= 1 && hedgeFills > 0) finish('full cycle observed ✓')
}, 2000)
