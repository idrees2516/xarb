// ─── Polymarket live feed (v0.5: dual-token books) ────────────────────────────
// Direct CLOB WebSocket market channel (no middle layers) + gamma API for
// discovery of the current up/down window of ANY series in the universe.
// Each market feed subscribes to BOTH tokens (UP + DOWN) on one socket:
//   • real DOWN-side quotes (not the 100−UP complement approximation)
//   • DOWN mids feed the σ auto-calibrator (identifiable either side)
// Windows are clock aligned: slug = {series}-{floor(epoch/windowSec)*windowSec}.

import type { MarketSpec } from './universe'
import { slugFor } from './universe'

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
export type Side = 'up' | 'dn'

interface Book {
  buys: Map<number, number> // price$ → size (shares)
  sells: Map<number, number>
  lastBookAt: number
}

export class PolymarketFeed {
  status: PMStatus = 'connecting'
  updates = 0
  /** Book version — bumped on every book-affecting event (either side). The
   *  engine's σ auto-calibrator folds one sample per version. */
  bookVer = 0
  lastTradePx: number | null = null
  feeRateBps: number | null = null

  onBook?: () => void

  private ws: WebSocket | null = null
  private upToken: string | null = null
  private dnToken: string | null = null
  private up: Book = this.newBook()
  private dn: Book = this.newBook()
  private lastAliveAt = 0
  private pingTimer: any = null
  private restTimer: any = null
  private closed = false
  private reconnectTimer: any = null

  private newBook(): Book {
    return { buys: new Map(), sells: new Map(), lastBookAt: 0 }
  }

  /** Discover the current window event of a series at an epoch. */
  async discoverWindow(spec: MarketSpec, epoch: number): Promise<EventInfo | null> {
    try {
      const r = await fetch(`${GAMMA}/events?slug=${slugFor(spec, epoch)}`, {
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
      console.log(`[polymarket] discover failed (${spec.id})`, String(e).slice(0, 60))
    }
    return null
  }

  /**
   * Subscribe to a window's token pair (window rollover). Always opens a
   * FRESH socket: re-subscribing on an existing connection does not reliably
   * deliver the new tokens' book snapshots, while a new connection does.
   */
  setTokens(up: string, dn: string): void {
    if (this.upToken === up && this.dnToken === dn) return
    this.upToken = up
    this.dnToken = dn
    this.up = this.newBook()
    this.dn = this.newBook()
    this.lastAliveAt = 0
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
      console.log('[polymarket] rolling socket for new window tokens')
    }
    this.connect()
  }

  tokens(): { up: string | null; dn: string | null } {
    return { up: this.upToken, dn: this.dnToken }
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
      if (this.upToken && this.dnToken) this.subscribe()
      this.startPing()
      this.stopRestFallback()
    }
    ws.onmessage = (ev: MessageEvent) => this.handleRaw(ev.data as string)
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return // stale socket (rollover)
      this.status = 'down'
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

  private subscribe(): void {
    if (this.ws && this.ws.readyState === 1 && this.upToken && this.dnToken) {
      this.ws.send(JSON.stringify({ assets_ids: [this.upToken, this.dnToken], type: 'market' }))
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send('PING')
        // dead-socket detection: no traffic of ANY kind (incl PONG) for 30s
        if (this.lastAliveAt && Date.now() - this.lastAliveAt > 30000) {
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

  /** Route a message to the book owning this asset (UP or DOWN token). */
  private bookFor(assetId: string | undefined): Book | null {
    if (assetId && assetId === this.upToken) return this.up
    if (assetId && assetId === this.dnToken) return this.dn
    if (!assetId) return this.upToken ? this.up : null
    return null
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
    const events: any[] = Array.isArray(msg) ? msg : [msg]
    let changed = false
    for (const d of events) {
      if (!d || !d.event_type) continue
      if (d.event_type === 'book') {
        const b = this.bookFor(d.asset_id)
        if (!b) continue
        b.buys = new Map<number, number>()
        b.sells = new Map<number, number>()
        for (const l of d.bids ?? []) b.buys.set(+l.price, +l.size)
        for (const l of d.asks ?? []) b.sells.set(+l.price, +l.size)
        if (d.last_trade_price) this.lastTradePx = +d.last_trade_price
        b.lastBookAt = now
        changed = true
      } else if (d.event_type === 'price_change') {
        // a single message may carry updates for BOTH tokens
        for (const ch of d.price_changes ?? []) {
          const b = this.bookFor(ch.asset_id)
          if (!b) continue
          const side = String(ch.side ?? '').toUpperCase() === 'BUY' ? b.buys : b.sells
          const p = +ch.price
          const s = +ch.size
          if (!p || Number.isNaN(p)) continue
          if (!s || s <= 0) side.delete(p)
          else side.set(p, s)
          b.lastBookAt = now
          changed = true
        }
      } else if (d.event_type === 'last_trade_price') {
        const b = this.bookFor(d.asset_id)
        if (!b) continue
        const p = +(d.price ?? 0)
        if (p > 0) this.lastTradePx = p
        if (d.fee_rate_bps != null) this.feeRateBps = +d.fee_rate_bps
      }
    }
    if (changed) {
      this.updates++
      this.bookVer++
      this.onBook?.()
    }
  }

  /** Top-of-book + ladders for one side, prices in cents. */
  getBook(side: Side): {
    bid: number | null
    ask: number | null
    bidSize: number
    askSize: number
    asks: { p: number; s: number }[]
    bids: { p: number; s: number }[]
    bookAgeMs: number
  } {
    const b = side === 'up' ? this.up : this.dn
    const asks = [...b.sells.entries()]
      .map(([p, s]) => ({ p: +(p * 100).toFixed(1), s }))
      .sort((x, y) => x.p - y.p)
      .slice(0, 6)
    const bids = [...b.buys.entries()]
      .map(([p, s]) => ({ p: +(p * 100).toFixed(1), s }))
      .sort((x, y) => y.p - x.p)
      .slice(0, 6)
    const age = b.lastBookAt ? Date.now() - b.lastBookAt : Infinity
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

  /** Full ask ladder in $ (for book-walking fills) for one side. */
  askLadderUsd(side: Side): { p: number; s: number }[] {
    const b = side === 'up' ? this.up : this.dn
    return [...b.sells.entries()]
      .map(([p, s]) => ({ p, s }))
      .sort((x, y) => x.p - y.p)
  }

  /** Full bid ladder in $ (for early-exit sells) for one side. */
  bidLadderUsd(side: Side): { p: number; s: number }[] {
    const b = side === 'up' ? this.up : this.dn
    return [...b.buys.entries()]
      .map(([p, s]) => ({ p, s }))
      .sort((x, y) => y.p - x.p)
  }

  private startRestFallback(): void {
    if (this.restTimer || this.closed || !this.upToken) return
    const up = this.upToken
    const dn = this.dnToken
    this.restTimer = setInterval(async () => {
      if ((this.status === 'live' && this.up.lastBookAt && Date.now() - this.up.lastBookAt < 5000) || this.closed) {
        this.stopRestFallback()
        return
      }
      for (const [token, book] of [
        [up, this.up],
        [dn ?? '', this.dn],
      ] as [string, Book][]) {
        if (!token) continue
        try {
          const r = await fetch(CLOB_BOOK + token, { signal: AbortSignal.timeout(3000) })
          const d = await r.json()
          if (d.bids || d.asks) {
            book.buys = new Map<number, number>()
            book.sells = new Map<number, number>()
            for (const l of d.bids ?? []) book.buys.set(+l.price, +l.size)
            for (const l of d.asks ?? []) book.sells.set(+l.price, +l.size)
            book.lastBookAt = Date.now()
            this.lastAliveAt = Date.now()
            this.updates++
            this.bookVer++
            if (this.status !== 'live') this.status = 'down'
            this.onBook?.()
          }
        } catch {
          /* keep retrying */
        }
      }
    }, 2500)
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
