// ─── XARB shared types ────────────────────────────────────────────────────────
// Cross-exchange latency arb: Binance BTC spot → Polymarket 5m BTC UP/DOWN

export interface LevelC {
  p: number // price in cents (1..99)
  s: number // size in shares
}

export interface WindowInfo {
  startEpoch: number
  endEpoch: number
  slug: string
  question: string
  upTokenId: string
  downTokenId: string
  conditionId: string
  strike: number | null
  strikeEstimated: boolean
  tokensLoaded: boolean
  accepting: boolean
}

export interface ChartPoint {
  t: number // epoch ms
  price: number // Binance mid ($)
  bid: number
  ask: number
  fv: number // fair value of UP (¢)
  pmAsk: number // Polymarket UP best ask (¢), carry-forward
  pmBid: number
  edge: number // fv - pmAsk (¢)
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
  fillPrice?: number // ¢ avg
  shares?: number
  stake?: number
}

export interface Trade {
  id: string
  signalId: string
  ts: number
  windowEnd: number
  strike: number
  priceC: number // avg fill ¢
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
