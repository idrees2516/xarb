// ─── Binance multi-symbol live feed (v0.5) ────────────────────────────────────
// One combined WS (bookTicker + aggTrade per symbol) for EVERY symbol the
// enabled universe requires. Per-symbol state: top-of-book, realized vol
// (1s-sampled EWMA), feed latency, tick rate. setSymbols() re-subscribes with
// the exact symbol set (fresh socket — combined streams cannot be amended).
// Auto-reconnect with per-symbol REST degradation fallback.

const WS_BASE = 'wss://stream.binance.com:9443/stream?streams='
const REST_BOOK = 'https://api.binance.com/api/v3/ticker/bookTicker?symbol='

export type FeedStatus = 'connecting' | 'live' | 'degraded' | 'down'

export interface SymQuote {
  bestBid: number
  bestAsk: number
  lastPrice: number
  /** Realized vol in the symbol's own points per √second (1s-sampled). */
  volPts: number
  ticksPerMin: number
  lagMs: number
}

export class BinanceFeed {
  status: FeedStatus = 'connecting'
  ticks = 0
  /** Fired on every book/trade tick with the symbol — the engine evaluates
   *  exactly the markets keyed to that symbol (event-driven hot path). */
  onTick?: (sym: string) => void

  private syms: string[] = []
  private ws: WebSocket | null = null
  private retries = 0
  private closed = false
  private lastStreamUrl = ''
  private books = new Map<string, { bid: number; ask: number; last: number; rest: boolean }>()
  private vols = new Map<string, { volPts: number; samples: { t: number; p: number }[]; init: number }>()
  private lagRings = new Map<string, number[]>()
  private counters = new Map<string, { n: number; tpm: number; winStart: number }>()
  private restTimer: any = null
  private restIdx = 0

  /** (Re)connect with exactly this symbol set (deduped + sorted). */
  setSymbols(syms: string[]): void {
    const next = [...new Set(syms)].filter(Boolean).sort()
    if (next.length === this.syms.length && next.every((s, i) => s === this.syms[i])) return
    this.syms = next
    if (this.closed) return
    // drop state for symbols no longer required (keeps others warm)
    for (const s of [...this.books.keys()]) if (!next.includes(s)) this.books.delete(s)
    this.connect()
  }

  symbols(): string[] {
    return [...this.syms]
  }

  connect(): void {
    if (this.closed || this.syms.length === 0) return
    const url = WS_BASE + this.syms.map((s) => `${s.toLowerCase()}@bookTicker/${s.toLowerCase()}@aggTrade`).join('/')
    if (url === this.lastStreamUrl && this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return
    this.lastStreamUrl = url
    this.status = this.status === 'live' ? 'live' : 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* noop */
      }
    }
    this.ws = ws
    ws.onopen = () => {
      this.status = 'live'
      this.retries = 0
      this.stopRestFallback()
      console.log(`[binance] combined WS live · ${this.syms.length} symbols`)
    }
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data as string)
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return
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
    // combined stream frame: { stream, data } — stream carries the symbol
    const streamSym = typeof m.stream === 'string' ? m.stream.split('@')[0].toUpperCase() : null

    if (d.b !== undefined) {
      // bookTicker
      const sym = streamSym ?? d.s
      if (!sym) return
      const b = this.ensureBook(sym)
      b.bid = +d.b
      b.ask = +d.a
      if (!b.rest) b.last = (b.bid + b.ask) / 2
      this.tick(sym)
      return
    }
    if (d.e === 'aggTrade') {
      const sym = streamSym ?? d.s
      if (!sym) return
      const p = +d.p
      const t = +d.T
      const lag = Date.now() - t
      if (lag > 0 && lag < 5000) {
        const ring = this.ensureRing(sym)
        ring.push(lag)
        if (ring.length > 300) ring.shift()
      }
      const b = this.ensureBook(sym)
      b.last = p
      this.pushSample(sym, t, p)
      this.tick(sym)
    }
  }

  private tick(sym: string): void {
    this.ticks++
    const c = this.ensureCounter(sym)
    c.n++
    this.onTick?.(sym)
  }

  private ensureBook(sym: string) {
    let b = this.books.get(sym)
    if (!b) {
      b = { bid: 0, ask: 0, last: 0, rest: false }
      this.books.set(sym, b)
    }
    return b
  }

  private ensureRing(sym: string): number[] {
    let r = this.lagRings.get(sym)
    if (!r) {
      r = []
      this.lagRings.set(sym, r)
    }
    return r
  }

  private ensureCounter(sym: string) {
    let c = this.counters.get(sym)
    if (!c) {
      c = { n: 0, tpm: 0, winStart: Date.now() }
      this.counters.set(sym, c)
    }
    return c
  }

  /** 1-second price sampling → realized vol EWMA (per symbol, own points). */
  private pushSample(sym: string, t: number, p: number): void {
    let v = this.vols.get(sym)
    if (!v) {
      // warm start from the first price (≈ volBps handled by caller override)
      v = { volPts: p * 0.0009, samples: [{ t, p }], init: p * 0.0009 }
      this.vols.set(sym, v)
      return
    }
    const lastS = v.samples[v.samples.length - 1]
    if (!lastS || t - lastS.t >= 1000) {
      v.samples.push({ t, p })
      if (v.samples.length > 121) v.samples.shift()
      this.recomputeVol(sym)
    }
  }

  private recomputeVol(sym: string): void {
    const v = this.vols.get(sym)
    if (!v || v.samples.length < 30) return
    let sum = 0
    let sum2 = 0
    let n = 0
    for (let i = 1; i < v.samples.length; i++) {
      const r = Math.log(v.samples[i].p / v.samples[i - 1].p)
      sum += r
      sum2 += r * r
      n++
    }
    const variance = Math.max(sum2 / n - (sum / n) * (sum / n), 0)
    const pts = Math.sqrt(variance) * v.samples[v.samples.length - 1].p
    // keep σ within 8× of the warm start until the window fills (honest cold start)
    const lo = v.init / 8
    const hi = v.init * 8
    v.volPts = Math.min(hi, Math.max(lo, 0.7 * v.volPts + 0.3 * pts))
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.retries++), 15000)
    setTimeout(() => this.connect(), delay)
    this.startRestFallback()
  }

  /** Staggered REST fallback while the WS is down: one symbol per 500ms. */
  private startRestFallback(): void {
    if (this.restTimer || this.closed || !this.syms.length) return
    this.restTimer = setInterval(async () => {
      if ((this.status as string) === 'live' || this.closed) {
        this.stopRestFallback()
        return
      }
      const sym = this.syms[this.restIdx % this.syms.length]
      this.restIdx++
      try {
        const r = await fetch(REST_BOOK + sym, { signal: AbortSignal.timeout(1500) })
        const d = await r.json()
        if (d.bidPrice) {
          const b = this.ensureBook(sym)
          b.bid = +d.bidPrice
          b.ask = +d.askPrice
          b.last = (b.bid + b.ask) / 2
          b.rest = true
          if (this.status !== 'live') this.status = 'degraded'
          this.tick(sym)
        }
      } catch {
        /* next symbol retries */
      }
    }, 500)
  }

  private stopRestFallback(): void {
    if (this.restTimer) {
      clearInterval(this.restTimer)
      this.restTimer = null
    }
  }

  /** Per-symbol quote view (null when the symbol is not subscribed). */
  quote(sym: string): SymQuote | null {
    const b = this.books.get(sym)
    if (!b) return null
    const v = this.vols.get(sym)
    const ring = this.lagRings.get(sym)
    const c = this.counters.get(sym)
    return {
      bestBid: b.bid,
      bestAsk: b.ask,
      lastPrice: b.last,
      volPts: v ? v.volPts : 0,
      ticksPerMin: c ? c.tpm : 0,
      lagMs: ring && ring.length ? ring[ring.length - 1] : 0,
    }
  }

  /** Rolling ticks/min per symbol, sampled by the engine tick loop. */
  sampleRate(): void {
    const now = Date.now()
    for (const c of this.counters.values()) {
      const dt = (now - c.winStart) / 1000
      if (dt >= 5) {
        c.tpm = Math.round((c.n / dt) * 60)
        c.n = 0
        c.winStart = now
      }
    }
  }

  /** Aggregate ticks/min across all symbols. */
  totalTpm(): number {
    let t = 0
    for (const c of this.counters.values()) t += c.tpm
    return t
  }

  /** Worst (max) recent feed lag across symbols — the honest header number. */
  worstLag(): number {
    let w = 0
    for (const ring of this.lagRings.values()) {
      if (ring.length) w = Math.max(w, ring[ring.length - 1])
    }
    return w
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
