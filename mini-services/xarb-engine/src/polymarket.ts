// ─── Polymarket live feed ─────────────────────────────────────────────────────
// Direct CLOB WebSocket market channel (no middle layers) + gamma API for
// discovery of the current 5-minute BTC UP/DOWN window. Windows are clock
// aligned: slug = btc-updown-5m-{floor(epoch/300)*300}.

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const CLOB_BOOK = 'https://clob.polymarket.com/book?token_id='

export interface EventInfo {
  upTokenId: string
  downTokenId: string
  conditionId: string
  question: string
  accepting: boolean
}

export type PMStatus = 'connecting' | 'live' | 'down'

export class PolymarketFeed {
  status: PMStatus = 'connecting'
  updates = 0
  lastTradePx: number | null = null
  feeRateBps: number | null = null

  onBook?: () => void

  private ws: WebSocket | null = null
  private token: string | null = null
  private buys = new Map<number, number>() // price$ → size (shares)
  private sells = new Map<number, number>()
  private lastAliveAt = 0 // any message incl PONG → dead-socket detection
  private lastBookAt = 0 // book-affecting events only → quote freshness
  private pingTimer: any = null
  private restTimer: any = null
  private closed = false
  private reconnectTimer: any = null

  async discoverWindow(epoch: number): Promise<EventInfo | null> {
    try {
      const r = await fetch(`${GAMMA}/events?slug=btc-updown-5m-${epoch}`, {
        signal: AbortSignal.timeout(5000),
      })
      const j = await r.json()
      if (Array.isArray(j) && j.length > 0) {
        const ev = j[0]
        const m = ev.markets?.[0]
        if (m) {
          const ids: string[] = JSON.parse(m.clobTokenIds)
          return {
            upTokenId: ids[0],
            downTokenId: ids[1],
            conditionId: m.conditionId,
            question: ev.title ?? m.question ?? '',
            accepting: !!m.acceptingOrders && !m.closed,
          }
        }
      }
    } catch (e) {
      console.log('[polymarket] discover failed', String(e).slice(0, 80))
    }
    return null
  }

  /**
   * Switch the subscribed token (window rollover). Always opens a FRESH socket:
   * re-subscribing on an existing connection does not reliably deliver the new
   * token's book snapshot, while a new connection + subscribe does.
   */
  setToken(token: string): void {
    if (this.token === token) return
    this.token = token
    this.buys.clear()
    this.sells.clear()
    this.lastAliveAt = 0
    this.lastBookAt = 0
    this.lastTradePx = null
    if (this.ws) {
      const old = this.ws
      this.ws = null
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      try {
        old.close()
      } catch {
        /* noop */
      }
      console.log('[polymarket] rolling socket for new window token')
    }
    this.connect()
  }

  currentToken(): string | null {
    return this.token
  }

  private connect(): void {
    if (this.closed) return
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.status = this.status === 'live' ? 'live' : 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(CLOB_WS)
    } catch {
      this.scheduleReconnect(3000)
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.status = 'live'
      console.log('[polymarket] CLOB WS live')
      if (this.token) this.subscribe(this.token)
      this.startPing()
      this.stopRestFallback()
    }
    ws.onmessage = (ev: MessageEvent) => this.handleRaw(ev.data as string)
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return // stale socket (rollover) — ignore
      this.status = 'down'
      console.log('[polymarket] WS closed, reconnecting…')
      this.stopPing()
      this.scheduleReconnect(2000)
      this.startRestFallback()
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer || this.closed) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)
  }

  private subscribe(token: string): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ assets_ids: [token], type: 'market' }))
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send('PING')
        // dead-socket detection: no traffic of ANY kind (incl PONG) for 30s
        if (this.lastAliveAt && Date.now() - this.lastAliveAt > 30000) {
          console.log('[polymarket] dead socket (no traffic 30s), forcing reconnect')
          try {
            this.ws.close()
          } catch {
            /* noop */
          }
        }
      }
    }, 4000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private handleRaw(raw: string): void {
    const now = Date.now()
    if (raw === 'PONG' || raw === 'PING') {
      this.lastAliveAt = now
      return
    }
    this.lastAliveAt = now
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    // messages are either arrays of events (book snapshot) or single objects
    const events: any[] = Array.isArray(msg) ? msg : [msg]
    let changed = false
    for (const d of events) {
      if (!d || !d.event_type) continue
      if (d.event_type === 'book') {
        if (d.asset_id && this.token && d.asset_id !== this.token) continue
        this.buys = new Map<number, number>()
        this.sells = new Map<number, number>()
        for (const l of d.bids ?? []) this.buys.set(+l.price, +l.size)
        for (const l of d.asks ?? []) this.sells.set(+l.price, +l.size)
        if (d.last_trade_price) this.lastTradePx = +d.last_trade_price
        this.lastBookAt = now
        changed = true
      } else if (d.event_type === 'price_change') {
        // single message may carry updates for both UP and DOWN tokens
        for (const ch of d.price_changes ?? []) {
          if (ch.asset_id && this.token && ch.asset_id !== this.token) continue
          const side = String(ch.side ?? '').toUpperCase() === 'BUY' ? this.buys : this.sells
          const p = +ch.price
          const s = +ch.size
          if (!p || Number.isNaN(p)) continue
          if (!s || s <= 0) side.delete(p)
          else side.set(p, s)
          this.lastBookAt = now
          changed = true
        }
      } else if (d.event_type === 'last_trade_price') {
        if (d.asset_id && this.token && d.asset_id !== this.token) continue
        const p = +(d.price ?? 0)
        if (p > 0) this.lastTradePx = p
        if (d.fee_rate_bps != null) this.feeRateBps = +d.fee_rate_bps
      }
    }
    if (changed) {
      this.updates++
      this.onBook?.()
    }
  }

  /** Top-of-book + ladders. Prices converted to cents. */
  getBook(): {
    bid: number | null
    ask: number | null
    bidSize: number
    askSize: number
    asks: { p: number; s: number }[]
    bids: { p: number; s: number }[]
    bookAgeMs: number
  } {
    const asks = [...this.sells.entries()]
      .map(([p, s]) => ({ p: +(p * 100).toFixed(1), s }))
      .sort((a, b) => a.p - b.p)
      .slice(0, 6)
    const bids = [...this.buys.entries()]
      .map(([p, s]) => ({ p: +(p * 100).toFixed(1), s }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 6)
    const age = this.lastBookAt ? Date.now() - this.lastBookAt : Infinity
    return {
      ask: asks.length ? asks[0].p : null,
      bid: bids.length ? bids[0].p : null,
      askSize: asks.length ? asks[0].s : 0,
      bidSize: bids.length ? bids[0].s : 0,
      asks,
      bids,
      bookAgeMs: age,
    }
  }

  /** Full ask ladder in $ (for book-walking fills). Sorted ascending. */
  askLadderUsd(): { p: number; s: number }[] {
    return [...this.sells.entries()]
      .map(([p, s]) => ({ p, s }))
      .sort((a, b) => a.p - b.p)
  }

  private startRestFallback(): void {
    if (this.restTimer || this.closed || !this.token) return
    const token = this.token
    this.restTimer = setInterval(async () => {
      if ((this.status === 'live' && this.lastBookAt && Date.now() - this.lastBookAt < 5000) || this.closed) {
        this.stopRestFallback()
        return
      }
      try {
        const r = await fetch(CLOB_BOOK + token, { signal: AbortSignal.timeout(3000) })
        const d = await r.json()
        if (d.bids || d.asks) {
          this.buys = new Map<number, number>()
          this.sells = new Map<number, number>()
          for (const l of d.bids ?? []) this.buys.set(+l.price, +l.size)
          for (const l of d.asks ?? []) this.sells.set(+l.price, +l.size)
          this.lastBookAt = Date.now()
          this.lastAliveAt = Date.now()
          this.updates++
          if (this.status !== 'live') this.status = 'down'
          this.onBook?.()
        }
      } catch {
        /* keep retrying */
      }
    }, 2000)
  }

  private stopRestFallback(): void {
    if (this.restTimer) {
      clearInterval(this.restTimer)
      this.restTimer = null
    }
  }

  start(): void {
    this.connect()
  }

  close(): void {
    this.closed = true
    this.stopPing()
    this.stopRestFallback()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}
