// Short fire probe for the GIF recording: relax thresholds → let the engine fire
// paper trades on any market/side (watch the UI: LEDs, signals, blotter, hedges,
// capture counters) → restore the original spec settings.
import { io } from 'socket.io-client'

const sock = io('http://localhost:3011', { transports: ['websocket'], timeout: 8000 })

let orig: any = null
let fires = 0
let firstFireAt = 0
const started = Date.now()
const log = (m: string) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${m}`)

sock.on('init', (d: any) => {
  if (orig) return
  orig = d.settings
  log('applying RELAXED thresholds (probe) …')
  sock.emit('control', {
    type: 'settings',
    settings: {
      jumpThreshC: 5,
      fvFloorC: 52,
      edgeThreshC: 2,
      minNetEdgeC: 0,
      minSecsLeft: 15,
      maxBookAgeMs: 12000,
      maxTradesPerWindow: 1,
      stakeUsd: 25,
      sideDown: true,
    },
  })
})

sock.on('signal', (sig: any) => {
  if (sig.action === 'EXECUTED') {
    fires++
    if (!firstFireAt) firstFireAt = Date.now()
    log(
      `FIRE ${sig.marketLabel} ${sig.side} fv=${sig.fv?.toFixed(1)} ask=${sig.ask?.toFixed(1)} edge=${sig.edge?.toFixed(1)} net=${sig.netEdgeC?.toFixed(1)} jump=${sig.jump5s?.toFixed(1)} ${Math.round(sig.shares ?? 0)}sh @ ${sig.fillPrice?.toFixed(1)}c`
    )
  } else if (sig.action === 'EXIT') {
    log(`EXIT ${sig.marketLabel} ${sig.side} ${sig.reason}`)
  } else if (sig.action === 'SKIPPED' && Math.random() < 0.12) {
    log(`skip ${sig.marketLabel} ${sig.side}: ${sig.reason}`)
  }
})

sock.on('hedge', (e: any) => {
  log(`HEDGE ${e.marketLabel} ${e.qtyBtc < 0 ? 'SHORT' : 'BUY'} ${e.qtyBtc} ${e.asset} (${e.reason})`)
})

sock.on('settle', (t: any) => {
  log(`SETTLE ${t.marketLabel} ${t.side} ${t.status} pnl=${t.pnlUsd?.toFixed(2)} (hedge ${t.hedgePnlUsd?.toFixed(2)})`)
})

const MAX_MS = 115 * 1000
const timer = setInterval(() => {
  const el = Date.now() - started
  const done = (fires >= 1 && firstFireAt && Date.now() - firstFireAt >= 48000) || fires >= 4
  if (done || el > MAX_MS) {
    clearInterval(timer)
    log(`done (fires=${fires}) — restoring original settings …`)
    if (orig) {
      const { markets, focusMarket, sideDown, autoTrade, stakeUsd, jumpThreshC, fvFloorC, edgeThreshC, minSecsLeft, maxBookAgeMs, maxTradesPerWindow, minNetEdgeC } = orig
      sock.emit('control', {
        type: 'settings',
        settings: { autoTrade, stakeUsd, jumpThreshC, fvFloorC, edgeThreshC, minSecsLeft, maxBookAgeMs, maxTradesPerWindow, minNetEdgeC, markets, focusMarket, sideDown },
      })
    }
    setTimeout(() => process.exit(0), 1500)
  }
}, 2000)
