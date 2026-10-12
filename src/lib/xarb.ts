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
  action: 'EXECUTED' | 'SKIPPED' | 'WATCH' | 'EXIT'
  reason?: string
  fillPrice?: number
  shares?: number
  stake?: number
  /** Net edge after PM fee + hedge cost at decision time (¢/share). */
  netEdgeC?: number | null
  sigmaEffPts?: number
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
  status: 'OPEN' | 'WON' | 'LOST' | 'EXITED'
  pnlUsd: number | null
  finalPrice: number | null
  fvAtEntry: number
  edgeAtEntry: number
  netEdgeC?: number | null
  sigmaEffPts?: number
  hedgeQtyBtc?: number
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
  hedgeMinBandBtc: number
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
  sigmaAuto: true,
  sigmaWImp: 0.65,
  sigmaZGate: 0.35,
  sigmaFloorK: 0.75,
  sigmaAbsFloor: 6,
  hedgeOn: true,
  hedgeRatio: 0.5,
  hedgeFeeBps: 4.5,
  hedgeMinBandBtc: 0.002,
  hedgeWinddownS: 20,
  minNetEdgeC: 1.5,
  exitBandC: 2,
  minCaptureC: 5,
}

/** A Binance hedge fill event (initial short / re-hedge / cover / flatten). */
export interface HedgeEvent {
  ts: number
  tradeId: string
  qtyBtc: number
  px: number
  feeUsd: number
  reason: string
  posQtyBtc: number
  pnlUsd: number
  sigmaEffPts: number
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
    sigmaEffPts: number
    z: number
    slope: number
    distFromStrike: number
  }
  /** v0.4: σ auto-calibration state (live PM implied inversion). */
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
  /** v0.4: Binance delta-hedge state. */
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
  }
  /** v0.4: opportunity capture accounting (zero-miss proof). */
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
  }
  edge: {
    fvAsk: number | null
    fvMid: number | null
    feeC: number | null
    hedgeCostC: number
    net: number | null
  }
  triggers: { jump: boolean; above60: boolean; gap: boolean; all: boolean; net: boolean }
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
  // 3011: the engine runs as a supervised clean child process; 3001 is held
  // by a legacy listener inside the hot-reloaded supervisor and is unused.
  socket = io('/?XTransformPort=3011', {
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
        description: `edge +${(sig.edge ?? 0).toFixed(1)}¢ · net +${(sig.netEdgeC ?? 0).toFixed(1)}¢ · jump ${sig.jump5s.toFixed(1)}¢ · ${Math.round(sig.shares ?? 0)} sh · $${sig.stake ?? 0}`,
      })
    } else if (sig.action === 'EXIT') {
      toast.success(`EARLY EXIT · banked @ ${sig.fillPrice?.toFixed(1) ?? '—'}¢`, {
        description: sig.reason ?? '',
      })
    }
  })

  socket.on('hedge', (e: HedgeEvent) => {
    const short = e.qtyBtc < 0
    toast(short ? 'HEDGE · SHORT BTC' : 'HEDGE · COVER BTC', {
      description: `${e.qtyBtc.toFixed(4)} BTC @ ${e.px.toFixed(1)} · ${e.reason} · pos ${e.posQtyBtc.toFixed(4)} · ${e.feeUsd.toFixed(3)} fee`,
    })
  })

  socket.on('settle', (t: Trade) => {
    useXarb.setState((st) => ({ trades: st.trades.map((x) => (x.id === t.id ? t : x)) }))
    const hedgeNote =
      t.hedgePnlUsd != null ? ` · hedge ${t.hedgePnlUsd >= 0 ? '+' : ''}${t.hedgePnlUsd.toFixed(2)}` : ''
    if (t.status === 'WON') {
      toast.success(`Window settled UP · WON +$${(t.pnlUsd ?? 0).toFixed(2)}`, {
        description: `final ${t.finalPrice?.toFixed(1)} vs strike ${t.strike.toFixed(1)}${hedgeNote}`,
      })
    } else if (t.status === 'LOST') {
      toast.error(`Window settled DOWN · LOST $${Math.abs(t.pnlUsd ?? 0).toFixed(2)}`, {
        description: `final ${t.finalPrice?.toFixed(1)} vs strike ${t.strike.toFixed(1)}${hedgeNote}`,
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
