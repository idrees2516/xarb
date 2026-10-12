'use client'

// ─── XARB client library (v0.5): types, live buffers, store, socket ────────────
// Multi-market universe: every panel follows the FOCUS market; the universe
// grid shows all 11 series. Settings persist to localStorage and re-apply to
// the engine on (re)connect so restarts never lose the operator's config.

import { create } from 'zustand'
import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'

// ── types (mirror of engine types) ──────────────────────────────────────────

export interface LevelC {
  p: number
  s: number
}

export interface ChartPoint {
  t: number
  price: number
  bid: number
  ask: number
  fv: number
  pmAsk: number
  pmBid: number
  edge: number
}

export type SideName = 'UP' | 'DOWN'

export interface SignalLog {
  id: string
  ts: number
  market: string
  marketLabel: string
  side: SideName
  windowEnd: number
  fv: number
  ask: number | null
  edge: number | null
  jump5s: number
  secondsLeft: number
  action: 'EXECUTED' | 'SKIPPED' | 'WATCH' | 'EXIT'
  reason?: string
  fillPrice?: number
  shares?: number
  stake?: number
  netEdgeC?: number | null
  sigmaEffPts?: number
}

export interface Trade {
  id: string
  signalId: string
  ts: number
  market: string
  marketLabel: string
  side: SideName
  windowEnd: number
  strike: number
  priceC: number
  shares: number
  costUsd: number
  feeUsd: number
  status: 'OPEN' | 'WON' | 'LOST' | 'EXITED'
  pnlUsd: number | null
  finalPrice: number | null
  fvAtEntry: number
  edgeAtEntry: number
  netEdgeC?: number | null
  sigmaEffPts?: number
  hedgeQtyBtc?: number
  hedgeAsset?: string
  hedgePnlUsd?: number | null
  hedgeFeesUsd?: number
  hedgeFills?: number
  exitPxC?: number | null
  exitReason?: string | null
}

export interface Settings {
  autoTrade: boolean
  stakeUsd: number
  jumpThreshC: number
  fvFloorC: number
  edgeThreshC: number
  minSecsLeft: number
  maxTradesPerWindow: number
  model: 'linear' | 'cdf'
  takerFeeBps: number
  maxBookAgeMs: number
  // v0.5: market universe
  markets: Record<string, boolean>
  focusMarket: string
  sideDown: boolean
  // v0.4: σ auto-calibration from live PM prices
  sigmaAuto: boolean
  sigmaWImp: number
  sigmaZGate: number
  sigmaFloorK: number
  sigmaAbsFloor: number
  // v0.4: δ-hedging on Binance
  hedgeOn: boolean
  hedgeRatio: number
  hedgeFeeBps: number
  hedgeMinBandUsd: number
  hedgeWinddownS: number
  // v0.4: profitability & value capture
  minNetEdgeC: number
  exitBandC: number
  minCaptureC: number
}

export const DEFAULT_SETTINGS: Settings = {
  autoTrade: true,
  stakeUsd: 25,
  jumpThreshC: 20,
  fvFloorC: 60,
  edgeThreshC: 10,
  minSecsLeft: 45,
  maxTradesPerWindow: 1,
  model: 'cdf',
  takerFeeBps: 0,
  maxBookAgeMs: 3000,
  markets: {
    'btc-5m': true,
    'eth-5m': true,
    'sol-5m': true,
    'xrp-5m': true,
    'doge-5m': true,
    'bnb-5m': true,
    'hype-5m': true,
    'btc-15m': true,
    'eth-15m': true,
    'sol-15m': true,
    'xrp-15m': true,
  },
  focusMarket: 'btc-5m',
  sideDown: true,
  sigmaAuto: true,
  sigmaWImp: 0.65,
  sigmaZGate: 0.35,
  sigmaFloorK: 0.75,
  sigmaAbsFloor: 6,
  hedgeOn: true,
  hedgeRatio: 0.5,
  hedgeFeeBps: 4.5,
  hedgeMinBandUsd: 170,
  hedgeWinddownS: 20,
  minNetEdgeC: 1.5,
  exitBandC: 2,
  minCaptureC: 5,
}

/** A Binance hedge fill event (any market's asset). */
export interface HedgeEvent {
  ts: number
  tradeId: string
  market: string
  marketLabel: string
  asset: string
  qtyBtc: number
  px: number
  feeUsd: number
  reason: string
  posQtyBtc: number
  pnlUsd: number
  sigmaEffPts: number
}

/** Compact per-market state for the universe grid. */
export interface MarketView {
  id: string
  label: string
  asset: string
  binanceSym: string
  windowSec: number
  priceDp: number
  enabled: boolean
  status: 'live' | 'loading' | 'down' | 'off'
  window: {
    startEpoch: number
    endEpoch: number
    secondsLeft: number
    strike: number | null
    strikeEstimated: boolean
    slug: string
    question: string
    tokensLoaded: boolean
    accepting: boolean
  }
  binance: { price: number; bid: number; ask: number; spread: number; change5s: number; ticksPerMin: number }
  fv: {
    value: number
    valueDown: number
    jump5s: number
    jump5sDown: number
    model: string
    sigmaPts: number
    sigmaEffPts: number
    sigmaEffBps: number
    z: number
    slope: number
    distFromStrike: number
  }
  sigma: {
    auto: boolean
    imp: number
    real: number
    floor: number
    eff: number
    snap: number | null
    snapAgeMs: number | null
    effIsSnap: boolean
    accepted: number
    rejected: number
  }
  hedge: { active: boolean; qtyBtc: number; targetBtc: number; bandBtc: number; pnlUsd: number; winddown: boolean; asset: string }
  pm: {
    bid: number | null
    ask: number | null
    askSize: number
    bidSize: number
    bookAgeMs: number
    dnBid: number | null
    dnAsk: number | null
    dnAskSize: number
    dnBidSize: number
    dnBookAgeMs: number
  }
  edge: {
    fvAsk: number | null
    feeC: number | null
    hedgeCostC: number
    net: number | null
    dnFvAsk: number | null
    dnFeeC: number | null
    dnNet: number | null
  }
  triggers: { jump: boolean; above60: boolean; gap: boolean; all: boolean; net: boolean }
  dnTriggers: { jump: boolean; above60: boolean; gap: boolean; all: boolean; net: boolean }
  capture: { opportunities: number; fired: number; missed: number; edgeSeenC: number }
  openPos: number
  feedStatus: string
}

export interface Snapshot {
  ts: number
  running: boolean
  focusId: string
  focus: { id: string; label: string; asset: string; binanceSym: string; windowSec: number; priceDp: number }
  universe: MarketView[]
  marketsLive: number
  marketsTotal: number
  sideDown: boolean
  feeds: {
    binance: { status: string; latencyMs: number; ticksPerMin: number; symbols: number }
    polymarket: { status: string; updates: number; lastTradePx: number | null; feeRateBps: number | null; sockets: number }
  }
  binance: { price: number; bid: number; ask: number; spread: number; change5s: number }
  window: {
    startEpoch: number
    endEpoch: number
    secondsLeft: number
    strike: number | null
    strikeEstimated: boolean
    slug: string
    question: string
    tokensLoaded: boolean
    accepting: boolean
  }
  fv: {
    value: number
    valueDown: number
    jump5s: number
    jump5sDown: number
    model: string
    sigmaPts: number
    sigmaEffPts: number
    z: number
    slope: number
    distFromStrike: number
  }
  sigma: {
    auto: boolean
    imp: number
    real: number
    floor: number
    eff: number
    snap: number | null
    snapAgeMs: number | null
    effIsSnap: boolean
    accepted: number
    rejected: number
  }
  hedge: {
    on: boolean
    ratio: number
    feeBps: number
    active: boolean
    qtyBtc: number
    targetBtc: number
    bandBtc: number
    deltaPerShare: number
    shares: number
    pnlUsd: number
    feesUsd: number
    fills: number
    winddown: boolean
    asset: string
  }
  capture: {
    opportunities: number
    fired: number
    missed: number
    edgeSeenC: number
    earlyExits: number
    avgNetEdgeC: number
  }
  pm: {
    bid: number | null
    ask: number | null
    askSize: number
    bidSize: number
    bookAgeMs: number
    asks: LevelC[]
    bids: LevelC[]
    dnBid: number | null
    dnAsk: number | null
    dnAskSize: number
    dnBidSize: number
    dnBookAgeMs: number
  }
  edge: {
    fvAsk: number | null
    fvMid: number | null
    feeC: number | null
    hedgeCostC: number
    net: number | null
    dnFvAsk: number | null
    dnFeeC: number | null
    dnNet: number | null
  }
  triggers: { jump: boolean; above60: boolean; gap: boolean; all: boolean; net: boolean }
  dnTriggers: { jump: boolean; above60: boolean; gap: boolean; all: boolean; net: boolean }
  stats: {
    pnlRealized: number
    pnlUnrealized: number
    pnlTotal: number
    trades: number
    open: number
    wins: number
    losses: number
    winRate: number
    avgEdgeC: number
    triggersToday: number
    stakedUsd: number
  }
  latency: {
    feedP50: number
    feedP99: number
    engineUsP50: number
    engineUsP99: number
    decisionUsP50: number
    decisionUsP99: number
  }
  chart: ChartPoint
}

export interface InitPayload {
  snapshot: Snapshot
  history: ChartPoint[]
  signals: SignalLog[]
  trades: Trade[]
  settings: Settings
}

export interface ControlMsg {
  type: 'start' | 'stop' | 'reset' | 'settings'
  settings?: Partial<Settings>
}

// ── live data outside React (read by canvas rAF loops) ───────────────────────

export const chartBuf: ChartPoint[] = []
export const liveRef: { snap: Snapshot | null } = { snap: null }

// ── store ────────────────────────────────────────────────────────────────────

interface XarbState {
  connected: boolean
  snapshot: Snapshot | null
  signals: SignalLog[]
  trades: Trade[]
  settings: Settings
}

export const useXarb = create<XarbState>((set) => ({
  connected: false,
  snapshot: null,
  signals: [],
  trades: [],
  settings: { ...DEFAULT_SETTINGS, markets: { ...DEFAULT_SETTINGS.markets } },
}))

// ── settings persistence (survive engine restarts) ───────────────────────────

const LS_KEY = 'xarb.settings.v05'

function loadSaved(): Partial<Settings> | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* best-effort */
  }
}

/** Reset persisted settings to defaults (Settings sheet button). */
export function clearSavedSettings(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* noop */
  }
}

// ── socket ───────────────────────────────────────────────────────────────────

let socket: Socket | null = null
let appliedSaved = false

export function connectEngine(): Socket {
  if (socket) return socket
  // 3011: the engine runs as a supervised clean child process
  socket = io('/?XTransformPort=3011', {
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 1000,
    timeout: 10000,
  })

  socket.on('connect', () => {
    appliedSaved = false
    useXarb.setState({ connected: true })
  })
  socket.on('disconnect', () => useXarb.setState({ connected: false }))

  socket.on('init', (d: InitPayload) => {
    chartBuf.length = 0
    for (const p of d.history ?? []) chartBuf.push(p)
    liveRef.snap = d.snapshot
    useXarb.setState({
      snapshot: d.snapshot,
      signals: d.signals ?? [],
      trades: d.trades ?? [],
      settings: d.settings ?? { ...DEFAULT_SETTINGS },
    })
    // re-apply the operator's persisted settings once per connection so an
    // engine restart never silently reverts the terminal to defaults
    if (!appliedSaved) {
      appliedSaved = true
      const saved = loadSaved()
      if (saved && Object.keys(saved).length) {
        const merged = { ...(d.settings ?? DEFAULT_SETTINGS), ...saved }
        useXarb.setState({ settings: merged })
        saveSettings(merged)
        socket?.emit('control', { type: 'settings', settings: saved })
      }
    }
  })

  socket.on('snap', (s: Snapshot) => {
    liveRef.snap = s
    useXarb.setState({ snapshot: s })
    const pt = s.chart
    if (pt && pt.t > (chartBuf[chartBuf.length - 1]?.t ?? 0)) {
      chartBuf.push(pt)
      if (chartBuf.length > 1600) chartBuf.shift()
    }
  })

  socket.on('signal', (sig: SignalLog) => {
    useXarb.setState((st) => ({ signals: [sig, ...st.signals].slice(0, 60) }))
    if (sig.action === 'EXECUTED' && sig.fillPrice != null) {
      toast.success(`BUY ${sig.marketLabel} ${sig.side} @ ${sig.fillPrice.toFixed(1)}¢`, {
        description: `edge +${(sig.edge ?? 0).toFixed(1)}¢ · net +${(sig.netEdgeC ?? 0).toFixed(1)}¢ · jump ${sig.jump5s.toFixed(1)}¢ · ${Math.round(sig.shares ?? 0)} sh · $${sig.stake ?? 0}`,
      })
    } else if (sig.action === 'EXIT') {
      toast.success(`EARLY EXIT · ${sig.marketLabel} ${sig.side} @ ${sig.fillPrice?.toFixed(1) ?? '—'}¢`, {
        description: sig.reason ?? '',
      })
    }
  })

  socket.on('hedge', (e: HedgeEvent) => {
    const short = e.qtyBtc < 0
    toast(short ? `HEDGE · SHORT ${e.asset} (${e.marketLabel})` : `HEDGE · BUY ${e.asset} (${e.marketLabel})`, {
      description: `${e.qtyBtc} ${e.asset} @ ${e.px.toFixed(e.px > 100 ? 1 : 4)} · ${e.reason} · pos ${e.posQtyBtc} · ${e.feeUsd.toFixed(3)} fee`,
    })
  })

  socket.on('settle', (t: Trade) => {
    useXarb.setState((st) => ({ trades: st.trades.map((x) => (x.id === t.id ? t : x)) }))
    const hedgeNote =
      t.hedgePnlUsd != null ? ` · hedge ${t.hedgePnlUsd >= 0 ? '+' : ''}${t.hedgePnlUsd.toFixed(2)}` : ''
    if (t.status === 'WON') {
      toast.success(`${t.marketLabel} ${t.side} settled WON +$${(t.pnlUsd ?? 0).toFixed(2)}`, {
        description: `final ${t.finalPrice?.toFixed(2)} vs strike ${t.strike.toFixed(2)}${hedgeNote}`,
      })
    } else if (t.status === 'LOST') {
      toast.error(`${t.marketLabel} ${t.side} settled LOST $${Math.abs(t.pnlUsd ?? 0).toFixed(2)}`, {
        description: `final ${t.finalPrice?.toFixed(2)} vs strike ${t.strike.toFixed(2)}${hedgeNote}`,
      })
    }
  })

  return socket
}

export function sendControl(msg: ControlMsg): void {
  socket?.emit('control', msg)
}

export function updateSettings(patch: Partial<Settings>): void {
  useXarb.setState((st) => {
    const merged = { ...st.settings, ...patch }
    saveSettings(merged)
    return { settings: merged }
  })
  sendControl({ type: 'settings', settings: patch })
}

/** Switch the detail panels to a market (also persisted). */
export function setFocusMarket(id: string): void {
  updateSettings({ focusMarket: id })
}

/** Enable/disable a series live (also persisted). */
export function toggleMarket(id: string, on: boolean): void {
  useXarb.setState((st) => {
    const merged = {
      ...st.settings,
      markets: { ...st.settings.markets, [id]: on },
    }
    saveSettings(merged)
    return { settings: merged }
  })
  sendControl({
    type: 'settings',
    settings: { markets: { [id]: on } as Record<string, boolean> },
  })
}

// ── formatting helpers ───────────────────────────────────────────────────────

export function fmtPrice(p: number | null | undefined, d = 2): string {
  if (p == null || !Number.isFinite(p)) return '—'
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function fmtCents(c: number | null | undefined, d = 1): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return `${c.toFixed(d)}¢`
}

export function fmtPnl(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`
}

export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour12: false })
}

export function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtUs(us: number): string {
  if (!Number.isFinite(us) || us <= 0) return '—'
  if (us < 1000) return `${us.toFixed(0)}µs`
  return `${(us / 1000).toFixed(2)}ms`
}

/** Compact signed number for tight table cells. */
export function fmtSigned(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
}
