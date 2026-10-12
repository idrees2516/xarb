// v0.5 fire probe: relax thresholds → verify multi-market fires (both sides),
// per-symbol hedges, settlements, capture accounting → restore spec settings.
import { io } from 'socket.io-client'

const sock = io('http://localhost:3011', { transports: ['websocket'], timeout: 8000 })

let orig: any = null
const fires: any[] = []
const hedges: any[] = []
const settles: any[] = []
const exits: any[] = []
let lastSnap: any = null
let sideFires = { UP: 0, DOWN: 0 }
let started = Date.now()

sock.on('init', (d: any) => {
  if (orig) return
  orig = d.settings
  console.log('[probe] applying RELAXED thresholds for live fire verification…')
  sock.emit('control', {
    type: 'settings',
    settings: {
      jumpThreshC: 6,
      fvFloorC: 52,
      edgeThreshC: 2,
      minNetEdgeC: 0,
      minSecsLeft: 20,
      maxBookAgeMs: 9000,
      maxTradesPerWindow: 1,
      stakeUsd: 10,
      sideDown: true,
    },
  })
})

sock.on('snap', (s: any) => {
  lastSnap = s
})

sock.on('signal', (sig: any) => {
  if (sig.action === 'EXECUTED') {
    fires.push(sig)
    sideFires[sig.side] = (sideFires[sig.side] ?? 0) + 1
    console.log(
      `🔥 FIRE ${sig.marketLabel} ${sig.side} fv=${sig.fv?.toFixed(1)} ask=${sig.ask?.toFixed(1)} edge=${sig.edge?.toFixed(1)} net=${sig.netEdgeC?.toFixed(1)} jump=${sig.jump5s?.toFixed(1)} ${Math.round(sig.shares ?? 0)}sh @ ${sig.fillPrice?.toFixed(1)}¢`
    )
  } else if (sig.action === 'EXIT') {
    exits.push(sig)
    console.log(`💰 EXIT ${sig.marketLabel} ${sig.side} ${sig.reason}`)
  } else if (sig.action === 'SKIPPED' && Math.random() < 0.15) {
    console.log(`   skip ${sig.marketLabel} ${sig.side}: ${sig.reason}`)
  }
})

sock.on('hedge', (e: any) => {
  hedges.push(e)
  console.log(
    `🛡 HEDGE ${e.marketLabel} ${e.qtyBtc < 0 ? 'SHORT' : 'BUY'} ${e.qtyBtc} ${e.asset} @ ${e.px.toFixed(e.px > 100 ? 1 : 5)} (${e.reason}) pos=${e.posQtyBtc}`
  )
})

sock.on('settle', (t: any) => {
  settles.push(t)
  console.log(
    `🏁 SETTLE ${t.marketLabel} ${t.side} ${t.status} pnl=${t.pnlUsd?.toFixed(2)} (hedge ${t.hedgePnlUsd?.toFixed(2)}, ${t.hedgeFills ?? 0} fills) final=${t.finalPrice?.toFixed(2)} K=${t.strike.toFixed(2)}`
  )
})

function summary() {
  const s = lastSnap
  console.log('\n════ PROBE SUMMARY ════')
  console.log(`fires: ${fires.length} (UP ${sideFires.UP} · DOWN ${sideFires.DOWN}) · hedges: ${hedges.length} · settles: ${settles.length} · early exits: ${exits.length}`)
  const byMarket: Record<string, number> = {}
  for (const f of fires) byMarket[f.marketLabel] = (byMarket[f.marketLabel] ?? 0) + 1
  console.log('fires by market:', JSON.stringify(byMarket))
  const hedgeAssets = [...new Set(hedges.map((h) => h.asset))]
  console.log('hedge assets seen:', hedgeAssets.join(', '))
  if (s) {
    console.log(
      `capture: opps=${s.capture.opportunities} fired=${s.capture.fired} gated=${s.capture.missed} edgeSeen=${s.capture.edgeSeenC?.toFixed(0)}¢ earlyExits=${s.capture.earlyExits}`
    )
    console.log(
      `stats: trades=${s.stats.trades} open=${s.stats.open} realized=${s.stats.pnlRealized?.toFixed(2)} total=${s.stats.pnlTotal?.toFixed(2)}`
    )
    console.log(`universe live: ${s.marketsLive}/${s.marketsTotal}`)
  }
}

const MAX_MS = 8 * 60 * 1000 // catch at least one full 5m window settle
const timer = setInterval(() => {
  const have = fires.length >= 3 && settles.length >= 1
  const el = Date.now() - started
  if (have || el > MAX_MS) {
    clearInterval(timer)
    console.log('\n[probe] restoring original settings…')
    if (orig) {
      const { markets, focusMarket, sideDown, autoTrade, stakeUsd, jumpThreshC, fvFloorC, edgeThreshC, minSecsLeft, maxBookAgeMs, maxTradesPerWindow, minNetEdgeC } = orig
      sock.emit('control', {
        type: 'settings',
        settings: { autoTrade, stakeUsd, jumpThreshC, fvFloorC, edgeThreshC, minSecsLeft, maxBookAgeMs, maxTradesPerWindow, minNetEdgeC, markets, focusMarket, sideDown },
      })
    }
    setTimeout(() => {
      summary()
      process.exit(0)
    }, 1500)
  } else if (Math.floor(el / 60000) !== Math.floor((el - 5000) / 60000)) {
    console.log(`… ${Math.floor(el / 60000)}min: fires=${fires.length} settles=${settles.length} opps=${lastSnap?.capture.opportunities ?? 0}`)
  }
}, 5000)
