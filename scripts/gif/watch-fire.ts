// Fire watcher for the GIF recording:
//   1. applies RELAXED thresholds (legit demo of the same live pipeline)
//   2. streams every signal/hedge/settle/exit to /tmp/xarb-gif/fire-events.jsonl
//   3. drops /tmp/xarb-gif/FIRE-FLAG on the first EXECUTED (recorder reacts)
//   4. restores original spec settings after the recording window
import { io } from 'socket.io-client'
import { writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'

const EVT = '/tmp/xarb-gif/fire-events.jsonl'
const FLAG = '/tmp/xarb-gif/FIRE-FLAG'
if (existsSync(EVT)) rmSync(EVT)
if (existsSync(FLAG)) rmSync(FLAG)

const log = (kind: string, data: any) => {
  appendFileSync(EVT, JSON.stringify({ t: Date.now(), kind, data }) + '\n')
}

const sock = io('http://localhost:3011', { transports: ['websocket'], timeout: 8000 })

let orig: any = null
let fires = 0
let firstFireAt = 0
const started = Date.now()
const MAX_MS = 9 * 60 * 1000
const POST_FIRE_MS = 80 * 1000

sock.on('init', (d: any) => {
  if (orig) return
  orig = d.settings
  console.log(`[probe] relaxed thresholds ON (jump 2 / floor 52 / edge 2 / net 0)`)
  sock.emit('control', {
    type: 'settings',
    settings: {
      jumpThreshC: 2,
      fvFloorC: 52,
      edgeThreshC: 2,
      minNetEdgeC: 0,
      minSecsLeft: 30,
      maxBookAgeMs: 9000,
      maxTradesPerWindow: 1,
      stakeUsd: 25,
      sideDown: true,
    },
  })
})

sock.on('signal', (sig: any) => {
  if (sig.action === 'EXECUTED') {
    fires++
    if (!firstFireAt) {
      firstFireAt = Date.now()
      writeFileSync(FLAG, String(firstFireAt))
      console.log(
        `FIRE ${sig.marketLabel} ${sig.side} fv=${sig.fv?.toFixed(1)} ask=${sig.ask?.toFixed(1)} edge=${sig.edge?.toFixed(1)} net=${sig.netEdgeC?.toFixed(1)} jump=${sig.jump5s?.toFixed(1)} ${Math.round(sig.shares ?? 0)}sh @ ${sig.fillPrice?.toFixed(1)}c`
      )
    } else {
      console.log(`FIRE#2 ${sig.marketLabel} ${sig.side} edge=${sig.edge?.toFixed(1)} net=${sig.netEdgeC?.toFixed(1)}`)
    }
    log('signal', sig)
  } else if (sig.action === 'EXIT') {
    console.log(`EXIT ${sig.marketLabel} ${sig.side} ${sig.reason}`)
    log('signal', sig)
  } else if (sig.action === 'SKIPPED') {
    log('signal', sig)
  }
})

sock.on('hedge', (e: any) => {
  log('hedge', e)
  if (Math.random() < 0.5) console.log(`HEDGE ${e.marketLabel} ${e.qtyBtc < 0 ? 'SHORT' : 'BUY'} ${e.qtyBtc?.toFixed(4)} ${e.asset} (${e.reason})`)
})

sock.on('settle', (t: any) => {
  log('settle', t)
  console.log(`SETTLE ${t.marketLabel} ${t.side} ${t.status} pnl=${t.pnlUsd?.toFixed(2)} (hedge ${t.hedgePnlUsd?.toFixed(2)})`)
})

const timer = setInterval(() => {
  const el = Date.now() - started
  const done = (fires >= 1 && firstFireAt && Date.now() - firstFireAt >= POST_FIRE_MS) || fires >= 4
  if (done || el > MAX_MS) {
    clearInterval(timer)
    console.log(`[probe] done (fires=${fires}) — restoring spec settings`)
    if (orig) {
      const { markets, focusMarket, sideDown, autoTrade, stakeUsd, jumpThreshC, fvFloorC, edgeThreshC, minSecsLeft, maxBookAgeMs, maxTradesPerWindow, minNetEdgeC } = orig
      sock.emit('control', {
        type: 'settings',
        settings: { autoTrade, stakeUsd, jumpThreshC, fvFloorC, edgeThreshC, minSecsLeft, maxBookAgeMs, maxTradesPerWindow, minNetEdgeC, markets, focusMarket, sideDown },
      })
    }
    setTimeout(() => process.exit(0), 1200)
  } else if (Math.floor(el / 60000) !== Math.floor((el - 5000) / 60000)) {
    console.log(`… ${Math.floor(el / 60000)}min: fires=${fires}`)
  }
}, 3000)
