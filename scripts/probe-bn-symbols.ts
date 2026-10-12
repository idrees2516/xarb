// Verify Binance spot symbol availability + tick metadata for the PM universe
const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','HYPEUSDT']
const r = await fetch('https://api.binance.com/api/v3/exchangeInfo?symbols=' + encodeURIComponent(JSON.stringify(syms)), { signal: AbortSignal.timeout(8000) })
const j = await r.json()
if (j.symbols) {
  for (const s of j.symbols) {
    const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE')
    const tick = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER')
    console.log(`${s.symbol.padEnd(9)} status=${s.status} step=${lot?.stepSize} minQty=${lot?.minQty} tick=${tick?.tickSize}`)
  }
} else {
  console.log('batch failed, trying one-by-one…')
  for (const sym of syms) {
    try {
      const r2 = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${sym}`, { signal: AbortSignal.timeout(8000) })
      const j2 = await r2.json()
      const s = j2.symbols?.[0]
      if (s) {
        const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE')
        const tick = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER')
        console.log(`${s.symbol.padEnd(9)} status=${s.status} step=${lot?.stepSize} minQty=${lot?.minQty} tick=${tick?.tickSize}`)
      } else console.log(`${sym} → NOT LISTED`)
    } catch (e) { console.log(`${sym} → err ${String(e).slice(0,50)}`) }
  }
}
