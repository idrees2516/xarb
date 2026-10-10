// ─── Binance live feed: combined WS (bookTicker + aggTrade), latency stats, ───
//    auto-reconnect with REST degradation fallback. Zero intermediary layers.

const WS_URL =
  'wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@aggTrade'
const REST_BOOK = 'https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT'
const REST_PRICE = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'

export type FeedStatus = 'connecting' | 'live' | 'degraded' | 'down'

export class BinanceFeed {
  status: FeedStatus = 'connecting'
  bestBid = 0
  bestAsk = 0
  lastPrice = 0
  ticks = 0
  ticksPerMin = 0
  /** Realized vol in BTC points per √second (1s-sampled returns) */
  volPts = 7.5

  onPrice?: () => void
  onTrade?: () => void

  private ws: WebSocket | null = null
  private retries = 0
  private closed = false
  private lagRing: number[] = []
  private tickCounter = 0
  private tickWindowStart = Date.now()
  private lastTradeTs = 0
  private restTimer: any = null
  private lastPrice5s = 0
  private lastPrice5sAt = 0
  private samples: { t: number; p: number }[] = []

  connect(): void {
    if (this.closed) return
    this.status = 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(WS_URL)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.status = 'live'
      this.retries = 0
      this.stopRestFallback()
      console.log('[binance] WS live')
    }
    ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(ev.data as string)
    }
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onclose = () => {
      if (this.closed) return
      this.status = 'down'
      console.log('[binance] WS closed, reconnecting…')
      this.scheduleReconnect()
    }
  }

  private handleMessage(raw: string): void {
    let m: any
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    const d = m.data ?? m
    if (!d) return

    // bookTicker: best bid/ask (no event time on spot stream)
    if (m.stream?.includes('bookTicker') || d.b !== undefined) {
      this.bestBid = +d.b
      this.bestAsk = +d.a
      this.ticks++
      this.tickCounter++
      this.onPrice?.()
      return
    }

    // aggTrade: last trade price + event time → feed latency + realized vol
    if (d.e === 'aggTrade') {
      const p = +d.p
      const t = +d.T
      const lag = Date.now() - t
      if (lag > 0 && lag < 5000) {
        this.lagRing.push(lag)
        if (this.lagRing.length > 400) this.lagRing.shift()
      }
      this.lastPrice = p
      this.lastTradeTs = t
      this.pushSample(t, p)
      this.ticks++
      this.tickCounter++
      this.onTrade?.()
    }
  }

  /** 1-second price sampling for realized vol (robust vs microstructure noise). */
  private pushSample(t: number, p: number): void {
    const lastS = this.samples[this.samples.length - 1]
    if (!lastS || t - lastS.t >= 1000) {
      this.samples.push({ t, p })
      if (this.samples.length > 121) this.samples.shift()
      this.recomputeVol()
    }
  }

  private recomputeVol(): void {
    if (this.samples.length < 30) return
    let sum = 0
    let sum2 = 0
    let n = 0
    for (let i = 1; i < this.samples.length; i++) {
      const r = Math.log(this.samples[i].p / this.samples[i - 1].p)
      sum += r
      sum2 += r * r
      n++
    }
    const variance = Math.max(sum2 / n - (sum / n) * (sum / n), 0)
    const pts = Math.sqrt(variance) * this.samples[this.samples.length - 1].p
    this.volPts = Math.min(60, Math.max(1.5, 0.7 * this.volPts + 0.3 * pts))
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.retries++), 15000)
    setTimeout(() => this.connect(), delay)
    this.startRestFallback()
  }

  private startRestFallback(): void {
    if (this.restTimer) return
    this.restTimer = setInterval(async () => {
      if (this.status === 'live' || this.closed) {
        this.stopRestFallback()
        return
      }
      try {
        const r = await fetch(REST_BOOK, { signal: AbortSignal.timeout(1500) })
        const d = await r.json()
        if (d.bidPrice) {
          this.bestBid = +d.bidPrice
          this.bestAsk = +d.askPrice
          this.lastPrice = (this.bestBid + this.bestAsk) / 2
          if (this.status !== 'live') this.status = 'degraded'
          this.onPrice?.()
        }
      } catch {
        try {
          const r = await fetch(REST_PRICE, { signal: AbortSignal.timeout(1500) })
          const d = await r.json()
          if (d.price) {
            this.lastPrice = +d.price
            if (this.status !== 'live') this.status = 'degraded'
            this.onPrice?.()
          }
        } catch {
          /* keep retrying */
        }
      }
    }, 500)
  }

  private stopRestFallback(): void {
    if (this.restTimer) {
      clearInterval(this.restTimer)
      this.restTimer = null
    }
  }

  mid(): number {
    if (this.bestBid > 0 && this.bestAsk > 0) return (this.bestBid + this.bestAsk) / 2
    return this.lastPrice
  }

  spread(): number {
    return this.bestAsk > 0 ? this.bestAsk - this.bestBid : 0
  }

  /** Price change over the trailing 5 seconds (points). */
  change5s(): number {
    const now = Date.now()
    if (now - this.lastPrice5sAt >= 1000) {
      this.lastPrice5s = this.mid()
      this.lastPrice5sAt = now
    }
    return this.mid() - this.lastPrice5s
  }

  lastLag(): number {
    return this.lagRing.length ? this.lagRing[this.lagRing.length - 1] : 0
  }

  lagStats(): { p50: number; p99: number } {
    if (!this.lagRing.length) return { p50: 0, p99: 0 }
    const sorted = [...this.lagRing].sort((a, b) => a - b)
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    return { p50: pick(0.5), p99: pick(0.99) }
  }

  /** Rolling ticks/min, sampled by the engine tick loop. */
  sampleRate(): void {
    const now = Date.now()
    const dt = (now - this.tickWindowStart) / 1000
    if (dt >= 5) {
      this.ticksPerMin = Math.round((this.tickCounter / dt) * 60)
      this.tickCounter = 0
      this.tickWindowStart = now
    }
  }

  close(): void {
    this.closed = true
    this.stopRestFallback()
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
