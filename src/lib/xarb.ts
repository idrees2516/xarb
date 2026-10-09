'use client'

// ─── XARB client library: types, live buffers, store, socket ──────────────────

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

export interface SignalLog {
  id: string
  ts: number
  windowEnd: number
  fv: number
  ask: number | null
  edge: number | null
  jump5s: number
  secondsLeft: number
  action: 'EXECUTED' | 'SKIPPED' | 'WATCH'
  reason?: string
  fillPrice?: number
  shares?: number
  stake?: number
}

export interface Trade {
  id: string
  signalId: string
  ts: number
  windowEnd: number
  strike: number
  priceC: number
  shares: number
  costUsd: number
  feeUsd: number
  status: 'OPEN' | 'WON' | 'LOST'
  pnlUsd: number | null
  finalPrice: number | null
  fvAtEntry: number
  edgeAtEntry: number
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
}

export const DEFAULT_SETTINGS: Settings = {
  autoTrade: true,
  stakeUsd: 25,
  jumpThreshC: 20,
  fvFloorC: 60,
  edgeThreshC: 10,
  minSecsLeft: 45,
  maxTradesPerWindow: 1,
  model: 'linear',
  takerFeeBps: 0,
  maxBookAgeMs: 3000,
}

export interface Snapshot {
  ts: number
  running: boolean
  feeds: {
    binance: { status: string; latencyMs: number; ticksPerMin: number }
    polymarket: { status: string; updates: number; lastTradePx: number | null; feeRateBps: number | null }
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
    jump5s: number
    model: string
    sigmaPts: number
    slope: number
    distFromStrike: number
  }
  pm: {
    bid: number | null
    ask: number | null
    askSize: number
    bidSize: number
    bookAgeMs: number
    asks: LevelC[]
    bids: LevelC[]
  }
  edge: { fvAsk: number | null; fvMid: number | null }
  triggers: { jump: boolean; above60: boolean; gap: boolean; all: boolean }
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
  settings: { ...DEFAULT_SETTINGS },
}))

// ── socket ───────────────────────────────────────────────────────────────────

let socket: Socket | null = null

export function connectEngine(): Socket {
  if (socket) return socket
  socket = io('/?XTransformPort=3001', {
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 1000,
    timeout: 10000,
  })

  socket.on('connect', () => useXarb.setState({ connected: true }))
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
      toast.success(`BUY UP filled @ ${sig.fillPrice.toFixed(1)}¢`, {
        description: `edge +${(sig.edge ?? 0).toFixed(1)}¢ · jump ${sig.jump5s.toFixed(1)}¢ · ${Math.round(sig.shares ?? 0)} sh · $${sig.stake ?? 0}`,
      })
    }
  })

  socket.on('settle', (t: Trade) => {
    useXarb.setState((st) => ({ trades: st.trades.map((x) => (x.id === t.id ? t : x)) }))
    if (t.status === 'WON') {
      toast.success(`Window settled UP · WON +$${(t.pnlUsd ?? 0).toFixed(2)}`, {
        description: `final ${t.finalPrice?.toFixed(1)} vs strike ${t.strike.toFixed(1)}`,
      })
    } else if (t.status === 'LOST') {
      toast.error(`Window settled DOWN · LOST $${Math.abs(t.pnlUsd ?? 0).toFixed(2)}`, {
        description: `final ${t.finalPrice?.toFixed(1)} vs strike ${t.strike.toFixed(1)}`,
      })
    }
  })

  return socket
}

export function sendControl(msg: ControlMsg): void {
  socket?.emit('control', msg)
}

export function updateSettings(patch: Partial<Settings>): void {
  useXarb.setState((st) => ({ settings: { ...st.settings, ...patch } }))
  sendControl({ type: 'settings', settings: patch })
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
