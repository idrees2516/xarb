// Debug: dump raw CLOB WS messages to discover exact book event schema
const W = Math.floor(Date.now() / 1000 / 300) * 300
const r = await fetch(`https://gamma-api.polymarket.com/events?slug=btc-updown-5m-${W}`)
const j = await r.json()
const m = j[0]?.markets?.[0]
const ids = JSON.parse(m.clobTokenIds)
console.log('window:', j[0]?.slug, 'UP token:', ids[0].slice(0, 20) + '…')

const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market')
let bookSeen = 0
let pcSeen = 0
ws.onopen = () => {
  console.log('open, subscribing…')
  ws.send(JSON.stringify({ assets_ids: [ids[0]], type: 'market' }))
}
ws.onmessage = (ev) => {
  const raw = ev.data as string
  if (raw === 'PONG') return
  try {
    const arr = JSON.parse(raw)
    for (const d of arr) {
      if (d.event_type === 'book' && bookSeen < 1) {
        bookSeen++
        console.log('=== BOOK EVENT KEYS:', Object.keys(d))
        console.log('buys sample:', JSON.stringify((d.buys ?? []).slice(0, 3)))
        console.log('sells sample:', JSON.stringify((d.sells ?? []).slice(0, 3)))
        console.log('other fields: asset_id?', !!d.asset_id, 'market?', !!d.market, 'ts:', d.timestamp)
      } else if (d.event_type === 'price_change' && pcSeen < 3) {
        pcSeen++
        console.log('=== PRICE_CHANGE:', JSON.stringify(d))
      } else if (d.event_type === 'last_trade_price' && pcSeen < 5) {
        pcSeen++
        console.log('=== LAST_TRADE:', JSON.stringify(d).slice(0, 250))
      }
    }
  } catch {
    console.log('raw non-json:', raw.slice(0, 100))
  }
}
const ping = setInterval(() => ws.readyState === 1 && ws.send('PING'), 4000)
setTimeout(() => { clearInterval(ping); ws.close(); process.exit(0) }, 10000)
