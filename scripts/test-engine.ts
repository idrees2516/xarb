// Verify engine socket.io stream on :3001
import { io } from 'socket.io-client'

const socket = io('http://localhost:3001', { path: '/', transports: ['websocket'] })

let snaps = 0
let t0 = Date.now()

socket.on('connect', () => {
  console.log('[test] connected:', socket.id)
})

socket.on('init', (d: any) => {
  console.log('[test] INIT received')
  console.log('  history pts:', d.history?.length)
  console.log('  signals:', d.signals?.length, ' trades:', d.trades?.length)
  console.log('  settings:', JSON.stringify(d.settings))
  const s = d.snapshot
  console.log('  window:', s.window.slug, 'strike:', s.window.strike, 'estimated:', s.window.strikeEstimated, 'tokensLoaded:', s.window.tokensLoaded)
  console.log('  question:', s.window.question)
})

socket.on('snap', (s: any) => {
  snaps++
  if (snaps === 20 || snaps === 60) {
    console.log(`[test] snap #${snaps} t+${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log('  binance:', s.binance.price?.toFixed(2), 'bid/ask:', s.binance.bid?.toFixed(2), s.binance.ask?.toFixed(2), '5sΔ:', s.binance.change5s?.toFixed(1))
    console.log('  window secsLeft:', s.window.secondsLeft?.toFixed(0), 'strike:', s.window.strike?.toFixed(1))
    console.log('  fv:', s.fv.value?.toFixed(1), '¢ jump5s:', s.fv.jump5s?.toFixed(1), 'slope:', s.fv.slope?.toFixed(3), 'σ:', s.fv.sigmaPts?.toFixed(1))
    console.log('  pm ask:', s.pm.ask, 'bid:', s.pm.bid, 'askSize:', s.pm.askSize, 'bookAge:', s.pm.bookAgeMs, 'asks[0..2]:', JSON.stringify(s.pm.asks?.slice(0, 3)))
    console.log('  edge fv-ask:', s.edge.fvAsk?.toFixed(1), 'triggers:', JSON.stringify(s.triggers))
    console.log('  feeds:', s.feeds.binance.status, s.feeds.binance.latencyMs + 'ms', s.feeds.binance.ticksPerMin + 'tpm', '|', s.feeds.polymarket.status, s.feeds.polymarket.updates + 'upd')
    console.log('  latency: feed p50/p99:', s.latency.feedP50, s.latency.feedP99, 'ms; engine tick p50:', s.latency.engineUsP50, 'µs; decision p50:', s.latency.decisionUsP50, 'µs')
    console.log('  stats:', JSON.stringify(s.stats))
  }
})

socket.on('signal', (sig: any) => {
  console.log('[test] SIGNAL:', sig.action, 'fv', sig.fv?.toFixed(1), 'ask', sig.ask, 'edge', sig.edge?.toFixed(1), 'jump', sig.jump5s?.toFixed(1), sig.reason ?? '')
})

socket.on('settle', (t: any) => {
  console.log('[test] SETTLE:', t.status, 'pnl', t.pnlUsd, 'final', t.finalPrice)
})

setTimeout(() => {
  console.log(`[test] total snaps in 12s: ${snaps} (${(snaps / 12).toFixed(1)}/s)`)
  // test a control round-trip
  socket.emit('control', { type: 'settings', settings: { stakeUsd: 30 } })
  setTimeout(() => {
    console.log('[test] control sent, done')
    process.exit(0)
  }, 1500)
}, 12000)
