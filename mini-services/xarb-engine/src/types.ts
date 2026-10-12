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
  action: 'EXECUTED' | 'SKIPPED' | 'WATCH' | 'EXIT'
  reason?: string
  fillPrice?: number // ¢ avg
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
  priceC: number // avg fill ¢
  shares: number
  costUsd: number
  feeUsd: number
  status: 'OPEN' | 'WON' | 'LOST' | 'EXITED'
  pnlUsd: number | null
  finalPrice: number | null
  fvAtEntry: number
  edgeAtEntry: number
  /** Net edge (edge − PM fee − est. hedge cost) at entry, ¢/share. */
  netEdgeC?: number | null
  /** σ_eff at entry (pts/√s) — the auto-calibrated value used. */
  sigmaEffPts?: number
  /** Initial hedge size (BTC, abs) — the delta shorted/bought on fill. */
  hedgeQtyBtc?: number
  /** Realized hedge P&L folded into pnlUsd (USD). */
  hedgePnlUsd?: number | null
  hedgeFeesUsd?: number
  hedgeFills?: number
  /** Early-exit fields (status EXITED). */
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
  // ── v0.4: σ auto-calibration from live PM prices ───────────────────
  /** Auto-calibrate σ (implied inversion + blend + dynamic floor + snap). */
  sigmaAuto: boolean
  /** Weight of implied σ in the blend (0..1). */
  sigmaWImp: number
  /** Minimum |Φ⁻¹(mid)| for an identifiable implied-σ sample. */
  sigmaZGate: number
  /** Dynamic floor = sigmaFloorK × median(implied-σ history). */
  sigmaFloorK: number
  /** Absolute σ sanity floor (pts/√s). */
  sigmaAbsFloor: number
  // ── v0.4: δ-hedging on Binance ─────────────────────────────────────
  hedgeOn: boolean
  /** Fraction of delta hedged (1.0 = fully neutral). */
  hedgeRatio: number
  /** Binance taker fee (bps) in the cost model & paper P&L. */
  hedgeFeeBps: number
  /** Minimum hedge band (BTC). */
  hedgeMinBandBtc: number
  /** Hedge wind-down horizon (s before close). */
  hedgeWinddownS: number
  // ── v0.4: profitability & value capture ─────────────────────────────
  /** Minimum net edge (edge − PM fee − est. hedge cost) in ¢/share to fire. */
  minNetEdgeC: number
  /** Early-exit: sell the binary back when the PM bid re-converges to
   *  within exitBandC of FV AND the locked edge ≥ minCaptureC. */
  exitBandC: number
  /** Minimum captured edge (¢/share over entry) for an early exit. */
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
  // v0.4 defaults: PM-calibrated σ, fractional delta-hedge, profitable-only
  sigmaAuto: true,
  sigmaWImp: 0.65,
  sigmaZGate: 0.35, // mids outside (36.3, 63.7) identify σ; inside is noise
  sigmaFloorK: 0.75,
  sigmaAbsFloor: 6.0,
  hedgeOn: true,
  // fractional delta hedge: full replication of a 5-minute digital costs
  // ~the entire entry edge (notional-delta ≈ $170/share); a half-delta
  // fence insures the hold at half the cost
  hedgeRatio: 0.5,
  hedgeFeeBps: 4.5,
  hedgeMinBandBtc: 0.002,
  hedgeWinddownS: 20,
  minNetEdgeC: 1.5,
  exitBandC: 2.0,
  minCaptureC: 5.0,
}

/** A Binance hedge fill event (initial short / re-hedge / cover / flatten). */
export interface HedgeEvent {
  ts: number
  tradeId: string
  /** Signed fill quantity (BTC): negative = short more, positive = cover. */
  qtyBtc: number
  px: number
  feeUsd: number
  reason: string
  /** Position after the fill. */
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
    /** Implied σ (EWMA, pts/√s). */
    imp: number
    /** Realized σ (Binance 1s EWMA, pts/√s). */
    real: number
    /** Dynamic floor max(abs, k·median(imp)) (pts/√s). */
    floor: number
    /** Effective σ in use (pts/√s). */
    eff: number
    /** Print-time snap value (pts/√s) — null when no identifiable print. */
    snap: number | null
    /** Age of the snap in ms — fresh (≤2s) means FV tracks PM's own quote. */
    snapAgeMs: number | null
    /** σ_eff currently equals the fresh snap. */
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
    /** Digital delta per share (BTC) at the current mark. */
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
    /** Episodes that ended without a fill (gated/refused) — every one has
     *  an explicit logged decision; engine-side silent misses are 0. */
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
    /** Live PM taker fee (¢/share) at the current ask. */
    feeC: number | null
    /** Estimated hedge turnover cost (¢/share) at the current mark. */
    hedgeCostC: number
    /** Net edge = edge − feeC − hedgeCostC (¢/share) — the profit gate. */
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
