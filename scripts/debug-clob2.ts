// Debug 2: full structure of price_changes update messages
const W = Math.floor(Date.now() / 1000 / 300) * 300
const r = await fetch(`https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${W}`)
const j = await r.json()
const ids = JSON.parse(j[0].markets[0].clobTokenIds)

const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market')
let fullBook = 0
let pc = 0
let ltp = 0
ws.onopen = () => ws.send(JSON.stringify({ assets_ids: [ids[0]], type: 'market' }))
ws.onmessage = (ev) => {
  const raw = ev.data as string
  if (raw === 'PONG') return
  let d: any
  try {
    d = JSON.parse(raw)
  } catch {
    return
  }
  if (Array.isArray(d)) {
    for (const e of d) {
      if (e.event_type === 'book' && fullBook < 1) {
        fullBook++
        console.log('=== BOOK: bids[0..2]:', JSON.stringify((e.bids ?? []).slice(0, 3)))
        console.log('    asks[0..2]:', JSON.stringify((e.asks ?? []).slice(0, 3)))
        console.log('    tick_size:', e.tick_size, 'ts:', e.timestamp, 'ltp field:', e.last_trade_price)
      }
    }
  } else if (d.price_changes && pc < 2) {
    pc++
    console.log('=== PC MSG keys:', Object.keys(d))
    console.log(JSON.stringify(d).slice(0, 600))
  } else if (d.event_type === 'last_trade_price' && ltp < 2) {
    ltp++
    console.log('=== LTP:', JSON.stringify(d).slice(0, 300))
  }
}
const ping = setInterval(() => ws.readyState === 1 && ws.send('PING'), 4000)
setTimeout(() => { clearInterval(ping); ws.close(); process.exit(0) }, 9000)
