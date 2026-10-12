// Probe Polymarket gamma API for ALL up/down-style short-window series
const G = 'https://gamma-api.polymarket.com'
const now = Math.floor(Date.now() / 1000)
const e300 = Math.floor(now / 300) * 300
const e900 = Math.floor(now / 900) * 900
const e3600 = Math.floor(now / 3600) * 3600

async function ev(slug: string) {
  try {
    const r = await fetch(`${G}/events?slug=${slug}`, { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    if (Array.isArray(j) && j.length > 0) {
      const m = j[0].markets?.[0]
      return { found: true, title: j[0].title, q: m?.question, closed: m?.closed, accepting: m?.acceptingOrders, negRisk: j[0].negRisk }
    }
    return { found: false }
  } catch (e) {
    return { found: false, err: String(e).slice(0, 60) }
  }
}

const candidates: Array<[string, string]> = []
for (const a of ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'link', 'ada', 'avax', 'ltc', 'bch', 'pepe', 'wif', 'hype']) {
  candidates.push([`${a}-updown-5m-${e300}`, `${a} 5m`])
}
for (const a of ['btc', 'eth', 'sol', 'xrp']) {
  candidates.push([`${a}-updown-15m-${e900}`, `${a} 15m`])
  candidates.push([`${a}-updown-1h-${e3600}`, `${a} 1h`])
}

console.log(`epoch=${now} e300=${e300} e900=${e900} e3600=${e3600}`)
console.log('=== SLUG PATTERN PROBE ===')
for (const [slug, label] of candidates) {
  const r = await ev(slug)
  console.log(`${label.padEnd(8)} ${slug.padEnd(28)} → ${r.found ? `FOUND "${r.title}" accepting=${r.accepting} closed=${r.closed}` : 'no'}`)
}
