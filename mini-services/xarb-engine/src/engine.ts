// ─── XARB engine core (v0.5 — market-universe edition) ────────────────────────
// Binance spot → fair value → 3-trigger AND → paper-fill by walking the live
// Polymarket CLOB ask ladder → δ-hedge on Binance → settle at window close.
//
// v0.5 GENERALIZATION — the engine is market-agnostic:
//   • EVERY series in the universe (7×5m + 4×15m) is independently discovered,
//     priced, triggered, hedged and settled — enable/disable live.
//   • BOTH sides (UP and DOWN) of every market get the FULL trigger set
//     evaluated on every tick: DOWN fires when FV jumps DOWN ≥ threshold,
//     FV_DOWN > floor and the DOWN ask is under FV_DOWN − edge.
//   • Per-market σ auto-calibration (UP + DOWN mids), per-market δ-hedge leg
//     on the market's own Binance symbol, per-market capture accounting —
//     summed into the global zero-miss proof.
//   • The dashboard selects a FOCUS market; the snapshot carries the full
//     universe grid plus the focus market's deep detail.

import { BinanceFeed } from './binance'
import { PolymarketFeed, type Side } from './polymarket'
import {
  fvLinear,
  fvCdfEff,
  percentile,
  digitalDeltaPerShare,
} from './fairvalue'
import { SigmaCalib, DEFAULT_SIGMA_CFG } from './sigma'
import {
  applyHedgeFill,
  estHedgeCostC,
  hedgeIsFlat,
  hedgePnlAt,
  hedgeStep,
  newHedgePos,
  pmFeeCPerShare,
  SIDE_UP,
  SIDE_DOWN,
  DEFAULT_HEDGE_CFG,
  type HedgeCfg,
  type HedgePos,
} from './hedger'
import { UNIVERSE, specById, scaleSigmaPts, type MarketSpec } from './universe'
import {
  DEFAULT_SETTINGS,
  type ChartPoint,
  type ControlMsg,
  type HedgeEvent,
  type InitPayload,
  type MarketView,
  type Settings,
  type SideName,
  type SignalLog,
  type Snapshot,
  type Trade,
  type WindowInfo,
} from './types'

const FV_PUSH_MS = 50
const FV_KEEP_MS = 20000
const CHART_PUSH_MS = 250
const CHART_CAP = 1440
const SIGNAL_COOLDOWN_MS = 5000
const SKIP_LOG_MS = 8000
const WATCH_LOG_MS = 10000
/** Built-in σ hard cap (BTC-anchored pts/√s) — scaled per asset. */
const SIGMA_CAP_PTS = 90
/** Legacy-mode σ floor (BTC-anchored pts/√s) — scaled per asset. */
const SIGMA_LEGACY_PTS = 15.5

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Date.now() / 1000
const localMidnight = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const uid = () => Math.random().toString(36).slice(2, 9)
const r1 = (v: number): number => Math.round(v * 10) / 10
const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

interface SideTrig {
  jump: boolean
  above60: boolean
  gap: boolean
  all: boolean
  net: boolean
}

const EMPTY_TRIG: SideTrig = { jump: false, above60: false, gap: false, all: false, net: false }

/** Per-market runtime state. */
interface Mkt {
  spec: MarketSpec
  feed: PolymarketFeed
  cal: SigmaCalib
  lastCalVer: number
  sigmaEffNow: number
  /** σ-scale price anchor (own points ↔ BTC-anchored settings). */
  priceRef: number
  win: WindowInfo | null
  fvRing: { t: number; v: number }[]
  chart: ChartPoint[]
  lastChartPush: number
  lastFv: number
  lastFvAt: number
  trig: SideTrig
  dnTrig: SideTrig
  lastNet: { feeC: number | null; hedgeCostC: number; netC: number | null; dnFeeC: number | null; dnNetC: number | null; dnFvAsk: number | null }
  armedPrev: boolean
  episodeFired: boolean
  dnArmedPrev: boolean
  dnEpisodeFired: boolean
  capture: { opportunities: number; fired: number; missed: number; edgeSeenC: number }
  hedge: HedgePos | null
  lastSignalTs: number
  lastSkipLog: Record<string, number>
  lastWatchLog: number
  lastDnWatchLog: number
  loadTask: Promise<void> | null
  /** 5s price-change anchor for the universe view (per market). */
  lastPrice5s: number
  lastPrice5sAt: number
}

export class Engine {
  settings: Settings = { ...DEFAULT_SETTINGS, markets: { ...DEFAULT_SETTINGS.markets } }
  running = true

  bin = new BinanceFeed()

  onSnap?: (s: Snapshot) => void
  onSignal?: (s: SignalLog) => void
  onSettle?: (t: Trade) => void
  onHedge?: (e: HedgeEvent) => void

  /** Every series (enabled or not) keyed by spec id. */
  private mkts = new Map<string, Mkt>()

  // ── global state ────────────────────────────────────────────────────────
  private signals: SignalLog[] = []
  private trades: Trade[] = []
  private capture = {
    opportunities: 0,
    fired: 0,
    missed: 0,
    edgeSeenC: 0,
    earlyExits: 0,
    netEdgeSum: 0,
    netEdgeN: 0,
  }
  private stats = {
    pnlRealized: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    stakedUsd: 0,
    edgeSum: 0,
    edgeN: 0,
    triggersToday: 0,
    dayStart: localMidnight(),
  }
  private signalSeq = 0

  // latency rings
  private feedLagRing: number[] = []
  private tickUsRing: number[] = []
  private decisionUsRing: number[] = []

  start(): void {
    this.applyUniverse()
    this.bin.onTick = (sym) => this.onBinanceTick(sym)
    this.bin.connect()
    this.ensureLoop()
    console.log(
      `[engine] started v0.5 (universe: ${UNIVERSE.length} series · ${this.enabledIds().length} live · both sides · paper mode)`
    )
  }

  enabledIds(): string[] {
    return UNIVERSE.filter((s) => this.settings.markets[s.id]).map((s) => s.id)
  }

  // ── universe management ──────────────────────────────────────────────────

  /** Create/remove market runtimes to match settings.markets. Markets with
   *  open trades keep running (settle + hedge) until flat, then tear down. */
  private applyUniverse(): void {
    for (const spec of UNIVERSE) {
      const enabled = !!this.settings.markets[spec.id]
      let m = this.mkts.get(spec.id)
      if (enabled && !m) {
        m = this.createMkt(spec)
        this.mkts.set(spec.id, m)
        const epoch = Math.floor(nowSec() / spec.windowSec) * spec.windowSec
        void this.loadWindow(m, epoch, true)
      }
      if (!enabled && m) {
        const open = this.trades.some((t) => t.market === spec.id && t.status === 'OPEN')
        if (!open && !m.hedge) {
          m.feed.close()
          this.mkts.delete(spec.id)
          console.log(`[universe] ${spec.id} disabled — feed torn down`)
        } else {
          console.log(`[universe] ${spec.id} disabled — settling open position first`)
        }
      }
    }
    this.syncSymbols()
  }

  private createMkt(spec: MarketSpec): Mkt {
    const feed = new PolymarketFeed()
    const m: Mkt = {
      spec,
      feed,
      cal: new SigmaCalib(),
      lastCalVer: -1,
      sigmaEffNow: 0,
      priceRef: 0,
      win: null,
      fvRing: [],
      chart: [],
      lastChartPush: 0,
      lastFv: 50,
      lastFvAt: 0,
      trig: { ...EMPTY_TRIG },
      dnTrig: { ...EMPTY_TRIG },
      lastNet: { feeC: null, hedgeCostC: 0, netC: null, dnFeeC: null, dnNetC: null, dnFvAsk: null },
      armedPrev: false,
      episodeFired: false,
      dnArmedPrev: false,
      dnEpisodeFired: false,
      capture: { opportunities: 0, fired: 0, missed: 0, edgeSeenC: 0 },
      hedge: null,
      lastSignalTs: 0,
      lastSkipLog: {},
      lastWatchLog: 0,
      lastDnWatchLog: 0,
      loadTask: null,
      lastPrice5s: 0,
      lastPrice5sAt: 0,
    }
    feed.onBook = () => {
      this.ensureLoop()
      if (!this.running) return
      if (this.settings.markets[spec.id]) this.evaluate(m)
    }
    feed.start()
    this.syncSigmaCfg(m)
    console.log(`[universe] ${spec.id} enabled — discovering window`)
    return m
  }

  /** Binance symbol set = enabled markets ∪ markets with open trades. */
  private syncSymbols(): void {
    const syms = new Set<string>()
    for (const spec of UNIVERSE) {
      if (this.settings.markets[spec.id]) syms.add(spec.binanceSym)
    }
    for (const t of this.trades) {
      if (t.status === 'OPEN') {
        const spec = specById(t.market)
        if (spec) syms.add(spec.binanceSym)
      }
    }
    this.bin.setSymbols([...syms])
  }

  /** σ cfg in the market's own points (BTC-anchored settings scaled by price). */
  private syncSigmaCfg(m: Mkt): void {
    const s = this.settings
    const price = m.priceRef > 0 ? m.priceRef : 1
    m.cal.setCfg({
      auto: s.sigmaAuto,
      wImp: s.sigmaWImp,
      zGate: s.sigmaZGate,
      kappa: DEFAULT_SIGMA_CFG.kappa,
      floorK: s.sigmaFloorK,
      absFloor: scaleSigmaPts(s.sigmaAbsFloor, price),
      legacyFloor: scaleSigmaPts(SIGMA_LEGACY_PTS, price),
      cap: scaleSigmaPts(SIGMA_CAP_PTS, price),
      histCap: DEFAULT_SIGMA_CFG.histCap,
    })
  }

  /** Hedge policy config for a market (its own LOT_SIZE + USD→asset band). */
  private hedgeCfg(m: Mkt): HedgeCfg {
    const s = this.settings
    const q = this.bin.quote(m.spec.binanceSym)
    const price = q ? (q.bestAsk || q.lastPrice || m.priceRef || 1) : m.priceRef || 1
    return {
      on: s.hedgeOn,
      ratio: s.hedgeRatio,
      feeBps: s.hedgeFeeBps,
      cWw: DEFAULT_HEDGE_CFG.cWw,
      minBandBtc: s.hedgeMinBandUsd / Math.max(price, 1e-9),
      winddownS: s.hedgeWinddownS,
      flattenS: DEFAULT_HEDGE_CFG.flattenS,
      minQtyBtc: m.spec.minQty,
      qtyStepBtc: m.spec.qtyStep,
      costTurnoverMult: DEFAULT_HEDGE_CFG.costTurnoverMult,
    }
  }

  /** 10Hz loop handle + staleness watchdog (bun --hot discards eval-time
   *  timers; WS handlers keep firing from the live event loop, so every
   *  market event re-arms a stale loop within ~100ms). */
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private lastTickAt = 0

  ensureLoop(): void {
    const now = Date.now()
    if (this.tickTimer && now - this.lastTickAt < 2000) return // healthy
    const wasStale = this.lastTickAt > 0 && now - this.lastTickAt > 2000
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = setInterval(() => this.tick(), 100)
    this.lastTickAt = now
    if (wasStale) console.log('[engine] tick loop re-armed (was discarded by hot reload)')
  }

  // ── window lifecycle (per market) ────────────────────────────────────────

  private loadWindow(m: Mkt, epoch: number, estimated: boolean): void {
    if (m.loadTask) return
    const spec = m.spec
    m.loadTask = (async () => {
      // wait for the symbol's first Binance price so the strike sample is valid
      let strike = this.symMid(spec.binanceSym)
      for (let i = 0; i < 60 && strike <= 0; i++) {
        await sleep(100)
        strike = this.symMid(spec.binanceSym)
      }
      // superseded while waiting (a newer rollover already ran)
      if (m.win && m.win.startEpoch !== epoch && m.win.startEpoch > epoch) return
      m.win = {
        startEpoch: epoch,
        endEpoch: epoch + spec.windowSec,
        slug: `${spec.series}-${epoch}`,
        question: '',
        upTokenId: '',
        downTokenId: '',
        conditionId: '',
        strike: strike > 0 ? strike : null,
        strikeEstimated: estimated,
        tokensLoaded: false,
        accepting: true,
      }
      m.fvRing = []
      m.priceRef = strike > 0 ? strike : m.priceRef
      if (m.priceRef > 0) this.syncSigmaCfg(m)
      for (let i = 0; i < 12; i++) {
        if (!m.win || m.win.startEpoch !== epoch) return // superseded
        const ev = await m.feed.discoverWindow(spec, epoch)
        if (ev) {
          if (!m.win || m.win.startEpoch !== epoch) return
          m.win.upTokenId = ev.upTokenId
          m.win.downTokenId = ev.downTokenId
          m.win.conditionId = ev.conditionId
          m.win.question = ev.question
          m.win.accepting = ev.accepting
          m.win.tokensLoaded = true
          m.feed.setTokens(ev.upTokenId, ev.downTokenId)
          console.log(`[window] ${spec.id} loaded ${m.win.slug} strike=${strike}`)
          return
        }
        await sleep(2000)
      }
      console.log(`[window] ${spec.id} NOT found after retries: ${spec.series}-${epoch}`)
    })().finally(() => {
      m.loadTask = null
    }) as Promise<void>
  }

  private symMid(sym: string): number {
    const q = this.bin.quote(sym)
    if (!q) return 0
    if (q.bestBid > 0 && q.bestAsk > 0) return (q.bestBid + q.bestAsk) / 2
    return q.lastPrice
  }

  /** Settle open trades of a market at window close, then roll the window. */
  private settleMarket(m: Mkt): void {
    const win = m.win
    if (!win) return
    const finalPrice = this.symMid(m.spec.binanceSym)
    for (const t of this.trades) {
      if (t.status !== 'OPEN' || t.windowEnd !== win.endEpoch || t.market !== m.spec.id) continue
      // flatten any residual hedge at settlement; fold exact cash-flow P&L
      let hedgePnl = 0
      const h = m.hedge
      if (h && h.tradeId === t.id) {
        if (!hedgeIsFlat(h)) {
          this.fillHedge(m, h, -h.qtyBtc, 'flatten (settlement)', Date.now(), finalPrice, finalPrice)
        }
        hedgePnl = hedgePnlAt(h, finalPrice)
        t.hedgeFills = h.fills
        t.hedgeFeesUsd = h.fees
        m.hedge = null
      }
      t.hedgePnlUsd = hedgePnl
      const won = t.side === 'UP' ? finalPrice >= t.strike : finalPrice < t.strike
      t.status = won ? 'WON' : 'LOST'
      t.finalPrice = finalPrice
      const binaryPnl = won ? t.shares * 1 - t.costUsd - t.feeUsd : -t.costUsd - t.feeUsd
      t.pnlUsd = binaryPnl + hedgePnl
      this.stats.pnlRealized += t.pnlUsd
      if (won) this.stats.wins++
      else this.stats.losses++
      console.log(
        `[settle] ${m.spec.id} ${t.side} ${t.id} ${t.status} final=${finalPrice} strike=${t.strike} binary=${binaryPnl.toFixed(2)} hedge=${hedgePnl.toFixed(2)} pnl=${t.pnlUsd.toFixed(2)}`
      )
      this.onSettle?.(t)
    }
    // roll the window: the next window starts at this end; new strike is
    // sampled from the settlement price (clock-aligned, per market)
    m.armedPrev = false
    m.dnArmedPrev = false
    void this.loadWindow(m, win.endEpoch, false)
  }

  // ── hot path: evaluate one market (every Binance/PM event) ────────────────

  private onBinanceTick(sym: string): void {
    this.ensureLoop()
    if (!this.running) return
    for (const m of this.mkts.values()) {
      if (m.spec.binanceSym !== sym) continue
      if (!this.settings.markets[m.spec.id]) continue
      const t0 = performance.now()
      this.evaluate(m)
      const us = (performance.now() - t0) * 1000
      this.decisionUsRing.push(us)
      if (this.decisionUsRing.length > 400) this.decisionUsRing.shift()
    }
  }

  private evaluate(m: Mkt): void {
    const win = m.win
    if (!win || win.strike == null || win.strike <= 0) return
    const now = Date.now()
    const tSec = (win.endEpoch * 1000 - now) / 1000
    if (tSec <= 0) return
    const q = this.bin.quote(m.spec.binanceSym)
    if (!q) return
    const price = q.bestBid > 0 && q.bestAsk > 0 ? (q.bestBid + q.bestAsk) / 2 : q.lastPrice
    if (price <= 0) return
    if (m.priceRef <= 0 || Math.abs(price / m.priceRef - 1) > 0.1) {
      const first = m.priceRef <= 0
      m.priceRef = price
      this.syncSigmaCfg(m)
      // warm-start σ_imp on the market's own scale (15.5 BTC-anchored pts)
      if (first && m.cal.accepted === 0) m.cal.setImpForTest(scaleSigmaPts(15.5, price))
    }

    const bookUp = m.feed.getBook('up')
    const bookDn = m.feed.getBook('dn')

    // ── σ auto-calibration (both sides' mids fold in) ─────────────────────
    m.cal.observeReal(q.volPts)
    if (m.feed.bookVer !== m.lastCalVer) {
      m.lastCalVer = m.feed.bookVer
      const midUp = bookUp.bid != null && bookUp.ask != null ? (bookUp.bid + bookUp.ask) / 2 : null
      const midDn = bookDn.bid != null && bookDn.ask != null ? (bookDn.bid + bookDn.ask) / 2 : null
      m.cal.observePm(
        midUp,
        midDn,
        price,
        win.strike,
        tSec,
        now,
        Math.min(bookUp.bookAgeMs, bookDn.bookAgeMs) < this.settings.maxBookAgeMs
      )
    }
    const sigmaAuto = this.settings.sigmaAuto
    m.sigmaEffNow = sigmaAuto
      ? m.cal.effective(now)
      : Math.min(
          Math.max(q.volPts, scaleSigmaPts(SIGMA_LEGACY_PTS, price)),
          scaleSigmaPts(SIGMA_CAP_PTS, price)
        )

    // fair value (UP; DOWN is the mirror)
    let fv: number
    if (this.settings.model === 'cdf') {
      fv = fvCdfEff(price, win.strike, tSec, m.sigmaEffNow).value
    } else {
      fv = fvLinear(price, win.strike, tSec).value
    }
    m.lastFv = fv
    m.lastFvAt = now
    const fvDn = 100 - fv

    // fv ring (UP) → 5s jump for BOTH sides
    const last = m.fvRing[m.fvRing.length - 1]
    if (!last || now - last.t >= FV_PUSH_MS) {
      m.fvRing.push({ t: now, v: fv })
      while (m.fvRing.length && now - m.fvRing[0].t > FV_KEEP_MS) m.fvRing.shift()
    }
    let ref: number | undefined
    for (let i = m.fvRing.length - 1; i >= 0; i--) {
      if (m.fvRing[i].t <= now - 5000) {
        ref = m.fvRing[i].v
        break
      }
    }
    const jump = ref == null ? 0 : fv - ref
    const jumpDn = -jump

    // v0.4 net-edge decomposition — per side (the profit gate preview)
    const askC = bookUp.ask
    const gapC = askC != null ? fv - askC : null
    const askDnC = bookDn.ask
    const gapDnC = askDnC != null ? fvDn - askDnC : null
    const freshUp = bookUp.bookAgeMs < this.settings.maxBookAgeMs
    const freshDn = bookDn.bookAgeMs < this.settings.maxBookAgeMs
    const pmFeeBps = m.feed.feeRateBps ?? this.settings.takerFeeBps
    const feeC = askC != null ? pmFeeCPerShare(Math.min(Math.max(askC / 100, 0.01), 0.99), pmFeeBps) : null
    const feeDnC = askDnC != null ? pmFeeCPerShare(Math.min(Math.max(askDnC / 100, 0.01), 0.99), pmFeeBps) : null
    const hedgeCostC = estHedgeCostC(price, win.strike, tSec, m.sigmaEffNow, this.hedgeCfg(m))
    const netC = gapC != null && feeC != null ? gapC - feeC - hedgeCostC : null
    const netDnC = gapDnC != null && feeDnC != null ? gapDnC - feeDnC - hedgeCostC : null
    m.lastNet = { feeC, hedgeCostC, netC, dnFeeC: feeDnC, dnNetC: netDnC, dnFvAsk: gapDnC }

    // ── trigger sets — UP and DOWN evaluated on EVERY tick ────────────────
    const jumpOK = jump >= this.settings.jumpThreshC
    const floorOK = fv > this.settings.fvFloorC
    const gapOK = gapC != null && freshUp && gapC >= this.settings.edgeThreshC
    const netOK = netC != null && netC >= this.settings.minNetEdgeC
    m.trig = { jump: jumpOK, above60: floorOK, gap: gapOK, all: jumpOK && floorOK && gapOK, net: netOK }

    const dnJumpOK = jumpDn >= this.settings.jumpThreshC
    const dnFloorOK = fvDn > this.settings.fvFloorC
    const dnGapOK = gapDnC != null && freshDn && gapDnC >= this.settings.edgeThreshC
    const dnNetOK = netDnC != null && netDnC >= this.settings.minNetEdgeC
    m.dnTrig = {
      jump: dnJumpOK,
      above60: dnFloorOK,
      gap: dnGapOK,
      all: dnJumpOK && dnFloorOK && dnGapOK,
      net: dnNetOK,
    }

    // ── capture accounting (per side; zero-miss proof) ────────────────────
    if (m.trig.all && !m.armedPrev) {
      m.armedPrev = true
      m.episodeFired = false
      m.capture.opportunities++
      this.capture.opportunities++
      if (gapC != null) {
        m.capture.edgeSeenC += gapC
        this.capture.edgeSeenC += gapC
      }
      console.log(
        `[opportunity] ${m.spec.id} UP #${m.capture.opportunities} edge=${gapC?.toFixed(1)}¢ net=${netC?.toFixed(1)}¢ (fee ${feeC?.toFixed(1)} + hedge ${hedgeCostC.toFixed(1)})`
      )
    } else if (!m.trig.all && m.armedPrev) {
      m.armedPrev = false
      if (!m.episodeFired) {
        m.capture.missed++
        this.capture.missed++
      }
    }
    if (this.settings.sideDown) {
      if (m.dnTrig.all && !m.dnArmedPrev) {
        m.dnArmedPrev = true
        m.dnEpisodeFired = false
        m.capture.opportunities++
        this.capture.opportunities++
        if (gapDnC != null) {
          m.capture.edgeSeenC += gapDnC
          this.capture.edgeSeenC += gapDnC
        }
        console.log(
          `[opportunity] ${m.spec.id} DOWN #${m.capture.opportunities} edge=${gapDnC?.toFixed(1)}¢ net=${netDnC?.toFixed(1)}¢`
        )
      } else if (!m.dnTrig.all && m.dnArmedPrev) {
        m.dnArmedPrev = false
        if (!m.dnEpisodeFired) {
          m.capture.missed++
          this.capture.missed++
        }
      }
    }

    // ── fire (UP always; DOWN when side capture is on) ────────────────────
    if (m.trig.all) {
      this.tryFire(m, 'UP', fv, jump, askC!, gapC!, tSec, bookUp.askSize, netC, feeC, hedgeCostC)
    } else {
      this.logWatchOrSkip(m, 'UP', fv, jump, gapC, jumpOK, floorOK, tSec)
    }
    if (m.dnTrig.all && this.settings.sideDown) {
      this.tryFire(m, 'DOWN', fvDn, jumpDn, askDnC!, gapDnC!, tSec, bookDn.askSize, netDnC, feeDnC, hedgeCostC)
    } else if (this.settings.sideDown) {
      this.logWatchOrSkip(m, 'DOWN', fvDn, jumpDn, gapDnC, dnJumpOK, dnFloorOK, tSec)
    }
  }

  /** Fire a paper buy on one side of a market (all guards re-checked here). */
  private tryFire(
    m: Mkt,
    side: SideName,
    fv: number,
    jump: number,
    askC: number,
    gapC: number,
    tSec: number,
    askSize: number,
    netEdgeC: number | null,
    feeC: number | null,
    hedgeCostC: number
  ): void {
    const now = Date.now()
    const win = m.win!
    const bookSide: Side = side === 'UP' ? 'up' : 'dn'
    if (!this.settings.autoTrade) {
      this.logSkip(m, side, 'auto-trade off', fv, jump, gapC, tSec)
      return
    }
    if (tSec < this.settings.minSecsLeft) {
      this.logSkip(m, side, `too close to close (${Math.max(0, tSec).toFixed(0)}s left)`, fv, jump, gapC, tSec)
      return
    }
    if (now - m.lastSignalTs < SIGNAL_COOLDOWN_MS) return
    const windowTrades = this.trades.filter((t) => t.market === m.spec.id && t.windowEnd === win.endEpoch)
    if (windowTrades.length >= this.settings.maxTradesPerWindow) {
      this.logSkip(m, side, 'max trades for window', fv, jump, gapC, tSec)
      return
    }
    if (windowTrades.some((t) => t.status === 'OPEN')) {
      this.logSkip(m, side, 'position already open', fv, jump, gapC, tSec)
      return
    }
    if (!win.tokensLoaded) {
      this.logSkip(m, side, 'window book not loaded', fv, jump, gapC, tSec)
      return
    }

    // ── net-edge profitability gate: edge − PM fee − est. hedge cost ──────
    if (netEdgeC == null || netEdgeC < this.settings.minNetEdgeC) {
      this.logSkip(
        m,
        side,
        `net edge ${netEdgeC?.toFixed(1) ?? '—'}¢ below ${this.settings.minNetEdgeC}¢ floor (PM fee ${feeC?.toFixed(1) ?? '—'}¢ + hedge ${hedgeCostC.toFixed(1)}¢)`,
        fv,
        jump,
        gapC,
        tSec
      )
      return
    }

    // walk the live ask ladder of THIS side ($ prices, share sizes)
    const ladder = m.feed.askLadderUsd(bookSide)
    if (!ladder.length) {
      this.logSkip(m, side, 'no asks on book', fv, jump, gapC, tSec)
      return
    }
    const stake = this.settings.stakeUsd
    const depthUsd = ladder.reduce((a, l) => a + l.p * l.s, 0)
    if (depthUsd < stake * 0.4) {
      this.logSkip(m, side, `thin book ($${depthUsd.toFixed(0)} depth)`, fv, jump, gapC, tSec)
      return
    }

    let cost = 0
    let shares = 0
    for (const lvl of ladder) {
      if (cost >= stake) break
      const lvlUsd = lvl.p * lvl.s
      const takeUsd = Math.min(lvlUsd, stake - cost)
      const takeShares = takeUsd / lvl.p
      shares += takeShares
      cost += takeUsd
    }
    if (shares <= 0) {
      this.logSkip(m, side, 'empty fill', fv, jump, gapC, tSec)
      return
    }
    const avgC = (cost / shares) * 100
    const feeBps = m.feed.feeRateBps ?? this.settings.takerFeeBps
    const fee = (shares * pmFeeCPerShare(avgC / 100, feeBps)) / 100

    const id = `S${++this.signalSeq}-${uid()}`
    const signal: SignalLog = {
      id,
      ts: now,
      market: m.spec.id,
      marketLabel: m.spec.label,
      side,
      windowEnd: win.endEpoch,
      fv,
      ask: askC,
      edge: gapC,
      jump5s: jump,
      secondsLeft: tSec,
      action: 'EXECUTED',
      fillPrice: avgC,
      shares: Math.round(shares * 100) / 100,
      stake,
      reason: `edge ${gapC.toFixed(1)}¢ · net ${netEdgeC.toFixed(1)}¢ (−fee ${(gapC - netEdgeC - hedgeCostC).toFixed(1)} −hedge ${hedgeCostC.toFixed(1)}) · filled ${Math.round(shares)} sh @ ${avgC.toFixed(1)}¢`,
      netEdgeC,
      sigmaEffPts: m.sigmaEffNow,
    }
    const trade: Trade = {
      id: `T${this.signalSeq}-${uid()}`,
      signalId: id,
      ts: now,
      market: m.spec.id,
      marketLabel: m.spec.label,
      side,
      windowEnd: win.endEpoch,
      strike: win.strike!,
      priceC: avgC,
      shares,
      costUsd: cost,
      feeUsd: fee,
      status: 'OPEN',
      pnlUsd: null,
      finalPrice: null,
      fvAtEntry: fv,
      edgeAtEntry: gapC,
      netEdgeC,
      sigmaEffPts: m.sigmaEffNow,
      hedgeAsset: m.spec.asset,
    }
    m.lastSignalTs = now
    this.signals.unshift(signal)
    if (this.signals.length > 120) this.signals.pop()
    this.trades.unshift(trade)
    if (this.trades.length > 200) this.trades.pop()
    this.stats.trades++
    this.stats.stakedUsd += cost
    this.stats.edgeSum += gapC
    this.stats.edgeN++
    this.stats.triggersToday++
    this.capture.fired++
    m.capture.fired++
    if (side === 'UP') m.episodeFired = true
    else m.dnEpisodeFired = true
    this.capture.netEdgeSum += netEdgeC
    this.capture.netEdgeN++
    console.log(
      `[SIGNAL] ${m.spec.label} ${side} ${id} fv=${fv.toFixed(1)}¢ ask=${askC.toFixed(1)}¢ edge=${gapC.toFixed(1)}¢ net=${netEdgeC.toFixed(1)}¢ jump=${jump.toFixed(1)}¢ fill=${avgC.toFixed(1)}¢`
    )
    this.onSignal?.(signal)

    // ── open the Binance delta hedge immediately on the market's symbol ──
    if (this.settings.hedgeOn) {
      m.hedge = newHedgePos(trade.id, side === 'UP' ? SIDE_UP : SIDE_DOWN, shares, win.strike!)
      this.runHedgePolicy(m, tSec)
    }
  }

  private logSkip(
    m: Mkt,
    side: SideName,
    reason: string,
    fv: number,
    jump: number,
    gapC: number | null,
    tSec: number
  ): void {
    const now = Date.now()
    if (now - (m.lastSkipLog[reason] ?? 0) < SKIP_LOG_MS) return
    m.lastSkipLog[reason] = now
    this.stats.triggersToday++
    const signal: SignalLog = {
      id: `K${++this.signalSeq}-${uid()}`,
      ts: now,
      market: m.spec.id,
      marketLabel: m.spec.label,
      side,
      windowEnd: m.win?.endEpoch ?? 0,
      fv,
      ask: side === 'UP' ? m.feed.getBook('up').ask : m.feed.getBook('dn').ask,
      edge: gapC,
      jump5s: jump,
      secondsLeft: tSec,
      action: 'SKIPPED',
      reason,
    }
    this.signals.unshift(signal)
    if (this.signals.length > 120) this.signals.pop()
    this.onSignal?.(signal)
  }

  private logWatchOrSkip(
    m: Mkt,
    side: SideName,
    fv: number,
    jump: number,
    gapC: number | null,
    jumpOK: boolean,
    floorOK: boolean,
    tSec: number
  ): void {
    const now = Date.now()
    const lastWatch = side === 'UP' ? m.lastWatchLog : m.lastDnWatchLog
    // near-miss watch: gap approaching the threshold on this side
    if (
      gapC != null &&
      gapC >= this.settings.edgeThreshC - 3 &&
      gapC < this.settings.edgeThreshC &&
      now - lastWatch > WATCH_LOG_MS
    ) {
      if (side === 'UP') m.lastWatchLog = now
      else m.lastDnWatchLog = now
      const signal: SignalLog = {
        id: `W${++this.signalSeq}-${uid()}`,
        ts: now,
        market: m.spec.id,
        marketLabel: m.spec.label,
        side,
        windowEnd: m.win?.endEpoch ?? 0,
        fv,
        ask: side === 'UP' ? m.feed.getBook('up').ask : m.feed.getBook('dn').ask,
        edge: gapC,
        jump5s: jump,
        secondsLeft: tSec,
        action: 'WATCH',
        reason: `gap ${gapC.toFixed(1)}¢ (needs ${this.settings.edgeThreshC}¢)`,
      }
      this.signals.unshift(signal)
      if (this.signals.length > 120) this.signals.pop()
      this.onSignal?.(signal)
    }
    // trigger partially met: momentum is there, PM already repriced
    if (jumpOK && floorOK && gapC != null && gapC < this.settings.edgeThreshC) {
      this.logSkip(m, side, 'momentum, but PM already repriced', fv, jump, gapC, tSec)
    }
  }

  // ── Binance δ-hedge policy + early-exit engine (per market) ────────────────

  /** One hedge policy step (100ms cadence): W–W band re-hedge, wind-down
   *  risk-reduction, force-flatten at expiry. Paper fills cross the live
   *  Binance top-of-book of the MARKET'S SYMBOL. */
  private runHedgePolicy(m: Mkt, tSecOverride?: number): void {
    const h = m.hedge
    if (!h) return
    const win = m.win
    if (!win) return
    const q = this.bin.quote(m.spec.binanceSym)
    if (!q) return
    const price = q.bestBid > 0 && q.bestAsk > 0 ? (q.bestBid + q.bestAsk) / 2 : q.lastPrice
    if (price <= 0) return
    const now = Date.now()
    const tSec = tSecOverride ?? (win.endEpoch * 1000 - now) / 1000
    if (tSec <= 0) return
    const act = hedgeStep(h, price, m.sigmaEffNow, tSec, this.hedgeCfg(m))
    if (!act) return
    this.fillHedge(m, h, act.qty, act.reason, now, price)
  }

  /** Paper hedge fill at the live top-of-book (shorts cross the bid, covers
   *  lift the ask). Exact cash-flow accounting. */
  private fillHedge(
    m: Mkt,
    h: HedgePos,
    qty: number,
    reason: string,
    now: number,
    mark: number,
    fallbackPx = 0
  ): void {
    const q = this.bin.quote(m.spec.binanceSym)
    let px = qty < 0 ? (q?.bestBid ?? 0) : (q?.bestAsk ?? 0)
    if (!px || px <= 0) px = fallbackPx
    if (!px || px <= 0) return // no live book — the next policy tick retries
    const cfg = this.hedgeCfg(m)
    const fee = (Math.abs(qty) * px * cfg.feeBps) / 10000
    applyHedgeFill(h, qty, px, fee)
    console.log(
      `[hedge] ${m.spec.id} ${h.tradeId} ${qty < 0 ? 'SHORT' : 'COVER'} ${qty} ${m.spec.asset} @ ${px.toFixed(px > 100 ? 1 : 4)} (${reason}) fee=$${fee.toFixed(3)} pos=${h.qtyBtc}`
    )
    this.onHedge?.({
      ts: now,
      tradeId: h.tradeId,
      market: m.spec.id,
      marketLabel: m.spec.label,
      asset: m.spec.asset,
      qtyBtc: qty,
      px,
      feeUsd: fee,
      reason,
      posQtyBtc: h.qtyBtc,
      pnlUsd: hedgePnlAt(h, mark),
      sigmaEffPts: m.sigmaEffNow,
    })
    // mirror onto the trade row
    const t = this.trades.find((x) => x.id === h.tradeId)
    if (t) {
      if (h.fills === 1) t.hedgeQtyBtc = Math.abs(h.qtyBtc) // initial delta hedged
      t.hedgeFills = h.fills
      t.hedgeFeesUsd = h.fees
    }
  }

  /** 100ms early-exit tick (per open trade): bank the mispricing when PM
   *  re-converges on the trade's own side. */
  private exitTick(m: Mkt, now: number, t: Trade): void {
    const s = this.settings
    if (s.minCaptureC < 0) return // exits disabled via negative capture
    const win = m.win
    if (!win || win.strike == null) return
    const tSec = (win.endEpoch * 1000 - now) / 1000
    if (tSec <= 0) return
    const bookSide: Side = t.side === 'UP' ? 'up' : 'dn'
    const book = m.feed.getBook(bookSide)
    const bid = book.bid
    if (bid == null) return
    const fvRef = t.side === 'UP' ? m.lastFv : 100 - m.lastFv
    const captured = bid - t.priceC
    const feeBps = m.feed.feeRateBps ?? s.takerFeeBps
    const exitFeeC = pmFeeCPerShare(bid / 100, feeBps)
    if (bid + s.exitBandC >= fvRef && captured >= s.minCaptureC && captured - exitFeeC >= 1.0) {
      this.executeExit(m, t, bid, feeBps, 'reprice-exit', now, bookSide)
    }
  }

  /** Sell the binary back at the bid and flatten the hedge. */
  private executeExit(
    m: Mkt,
    t: Trade,
    bidC: number,
    feeBps: number,
    reason: string,
    now: number,
    bookSide: Side
  ): void {
    const book = m.feed.getBook(bookSide)
    const fillShares = Math.min(t.shares, Math.max(book.bidSize, 0))
    if (fillShares < 5) return // below the 5-share order minimum — hold to settlement
    const proceeds = (fillShares * bidC) / 100
    const exitFee = (fillShares * pmFeeCPerShare(bidC / 100, feeBps)) / 100
    const q = this.bin.quote(m.spec.binanceSym)
    const mark = q && q.bestBid > 0 && q.bestAsk > 0 ? (q.bestBid + q.bestAsk) / 2 : (q?.lastPrice ?? 0)
    // flatten the hedge at market
    let hedgePnl = 0
    const h = m.hedge
    if (h && h.tradeId === t.id) {
      if (!hedgeIsFlat(h)) {
        const qty = -h.qtyBtc
        this.fillHedge(m, h, qty, 'flatten (early exit)', now, mark, mark)
      }
      hedgePnl = hedgePnlAt(h, mark)
      t.hedgeFills = h.fills
      t.hedgeFeesUsd = h.fees
    }
    const binaryPnl = proceeds - t.costUsd - t.feeUsd - exitFee
    const total = binaryPnl + hedgePnl
    t.status = 'EXITED'
    t.exitPxC = bidC
    t.exitReason = reason
    t.hedgePnlUsd = hedgePnl
    t.pnlUsd = total
    t.finalPrice = mark
    this.stats.pnlRealized += total
    this.capture.earlyExits++
    m.hedge = null
    console.log(
      `[exit] ${m.spec.id} ${t.side} ${t.id} EXITED @ ${bidC.toFixed(1)}¢ (entry ${t.priceC.toFixed(1)}¢) binary=${binaryPnl.toFixed(2)} hedge=${hedgePnl.toFixed(2)} net=${total.toFixed(2)}`
    )
    const fvRef = t.side === 'UP' ? m.lastFv : 100 - m.lastFv
    const sig: SignalLog = {
      id: `X${++this.signalSeq}-${uid()}`,
      ts: now,
      market: m.spec.id,
      marketLabel: m.spec.label,
      side: t.side,
      windowEnd: t.windowEnd,
      fv: fvRef,
      ask: bidC,
      edge: null,
      jump5s: this.jump5sNow(m),
      secondsLeft: Math.max(0, (t.windowEnd * 1000 - now) / 1000),
      action: 'EXIT',
      reason: `banked +${(bidC - t.priceC).toFixed(1)}¢/sh early · binary ${binaryPnl.toFixed(2)} + hedge ${hedgePnl.toFixed(2)}`,
      fillPrice: bidC,
      shares: Math.round(fillShares * 100) / 100,
    }
    this.signals.unshift(sig)
    if (this.signals.length > 120) this.signals.pop()
    this.onSignal?.(sig)
    this.onSettle?.(t)
  }

  // ── 10Hz loop: rollovers, hedge policy, chart, snapshot ────────────────────

  private tick(): void {
    const t0 = performance.now()
    const now = Date.now()
    this.lastTickAt = now

    this.bin.sampleRate()

    for (const m of this.mkts.values()) {
      const win = m.win
      // window rollover (per market, at its own cadence)
      if (win && now >= win.endEpoch * 1000 + 200) {
        this.settleMarket(m)
        this.syncSymbols() // a disabled market's symbol may no longer be needed
      }
      // hedge policy + early-exit ticks for the market's open trades
      if (this.running) {
        if (m.hedge) {
          const t = this.trades.find((x) => x.id === m.hedge!.tradeId && x.status === 'OPEN')
          if (t) {
            this.runHedgePolicy(m)
            this.exitTick(m, now, t)
          } else {
            m.hedge = null // trade closed (settled/exited) — drop the hedge
          }
        } else {
          for (const t of this.trades) {
            if (t.status === 'OPEN' && t.market === m.spec.id) this.exitTick(m, now, t)
          }
        }
      }
      // chart point (250ms cadence, per market)
      if (now - m.lastChartPush >= CHART_PUSH_MS && m.win?.strike != null) {
        m.lastChartPush = now
        const q = this.bin.quote(m.spec.binanceSym)
        const price = q ? (q.bestBid > 0 && q.bestAsk > 0 ? (q.bestBid + q.bestAsk) / 2 : q.lastPrice) : 0
        if (price > 0) {
          const bookUp = m.feed.getBook('up')
          const prevPt = m.chart[m.chart.length - 1]
          const pt: ChartPoint = {
            t: now,
            price,
            bid: q?.bestBid ?? 0,
            ask: q?.bestAsk ?? 0,
            fv: m.lastFv,
            pmAsk: bookUp.ask ?? prevPt?.pmAsk ?? 0,
            pmBid: bookUp.bid ?? prevPt?.pmBid ?? 0,
            edge: bookUp.ask != null ? m.lastFv - bookUp.ask : (prevPt?.edge ?? 0),
          }
          m.chart.push(pt)
          if (m.chart.length > CHART_CAP) m.chart.shift()
        }
      }
      // 5s price-change anchor for the universe view
      if (now - m.lastPrice5sAt >= 1000) {
        const q = this.bin.quote(m.spec.binanceSym)
        if (q) {
          m.lastPrice5sAt = now
          m.lastPrice5s = q.lastPrice || (q.bestBid + q.bestAsk) / 2
        }
      }
    }

    // feed lag mirror (worst symbol)
    const lag = this.bin.worstLag()
    if (lag > 0) {
      this.feedLagRing.push(lag)
      if (this.feedLagRing.length > 400) this.feedLagRing.shift()
    }

    // emit
    this.onSnap?.(this.buildSnapshot(now))

    const us = (performance.now() - t0) * 1000
    this.tickUsRing.push(us)
    if (this.tickUsRing.length > 400) this.tickUsRing.shift()

    // day rollover for counters
    if (now - this.stats.dayStart > 86400000) {
      this.stats.dayStart = localMidnight()
      this.stats.triggersToday = 0
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  private pct(ring: number[], q: number): number {
    if (!ring.length) return 0
    return percentile([...ring].sort((a, b) => a - b), q)
  }

  /** The market the detail panels follow (focus, or first enabled). */
  private focusMkt(): Mkt | null {
    const focusId = this.settings.focusMarket
    let m = this.mkts.get(focusId) ?? null
    if (m) return m
    for (const spec of UNIVERSE) {
      if (this.settings.markets[spec.id]) {
        m = this.mkts.get(spec.id) ?? null
        if (m) return m
      }
    }
    return this.mkts.size ? this.mkts.values().next().value ?? null : null
  }

  /** Compact per-market view for the universe grid. */
  private marketView(m: Mkt | undefined, spec: MarketSpec, now: number): MarketView {
    const enabled = !!this.settings.markets[spec.id]
    if (!m || !enabled) {
      const openPos = this.trades.filter((t) => t.market === spec.id && t.status === 'OPEN').length
      return {
        id: spec.id,
        label: spec.label,
        asset: spec.asset,
        binanceSym: spec.binanceSym,
        windowSec: spec.windowSec,
        priceDp: spec.priceDp,
        enabled,
        status: enabled && !m ? 'loading' : 'off',
        window: { startEpoch: 0, endEpoch: 0, secondsLeft: 0, strike: null, strikeEstimated: true, slug: '', question: '', tokensLoaded: false, accepting: false },
        binance: { price: 0, bid: 0, ask: 0, spread: 0, change5s: 0, ticksPerMin: 0 },
        fv: { value: 50, valueDown: 50, jump5s: 0, jump5sDown: 0, model: this.settings.model, sigmaPts: 0, sigmaEffPts: 0, sigmaEffBps: 0, z: 0, slope: 0, distFromStrike: 0 },
        sigma: { auto: this.settings.sigmaAuto, imp: 0, real: 0, floor: 0, eff: 0, snap: null, snapAgeMs: null, effIsSnap: false, accepted: 0, rejected: 0 },
        hedge: { active: false, qtyBtc: 0, targetBtc: 0, bandBtc: 0, pnlUsd: 0, winddown: false, asset: spec.asset },
        pm: { bid: null, ask: null, askSize: 0, bidSize: 0, bookAgeMs: 999999, dnBid: null, dnAsk: null, dnAskSize: 0, dnBidSize: 0, dnBookAgeMs: 999999 },
        edge: { fvAsk: null, feeC: null, hedgeCostC: 0, net: null, dnFvAsk: null, dnFeeC: null, dnNet: null },
        triggers: { ...EMPTY_TRIG },
        dnTriggers: { ...EMPTY_TRIG },
        capture: { opportunities: 0, fired: 0, missed: 0, edgeSeenC: 0 },
        openPos,
        feedStatus: m ? m.feed.status : 'off',
      }
    }
    const q = this.bin.quote(spec.binanceSym)
    const price = q ? (q.bestBid > 0 && q.bestAsk > 0 ? (q.bestBid + q.bestAsk) / 2 : q.lastPrice) : 0
    const win = m.win
    const tSec = win ? Math.max(0, (win.endEpoch * 1000 - now) / 1000) : 0
    const bookUp = m.feed.getBook('up')
    const bookDn = m.feed.getBook('dn')
    const dist = win?.strike != null ? price - win.strike : 0
    // FV detail at the effective σ in use
    let slope = 0.19
    let z = 0
    if (win?.strike != null) {
      const t = Math.max(tSec, 1)
      if (this.settings.model === 'cdf') {
        const d = fvCdfEff(price, win.strike, t, m.sigmaEffNow)
        slope = d.slope
        z = d.z
      } else {
        slope = fvLinear(price, win.strike, t).slope
        z = dist / Math.max(m.sigmaEffNow * Math.sqrt(t), 1e-9)
      }
    }
    const gapUp = bookUp.ask != null ? m.lastFv - bookUp.ask : null
    const gapDn = bookDn.ask != null ? 100 - m.lastFv - bookDn.ask : null
    const change5s = m.lastPrice5s > 0 && price > 0 ? price - m.lastPrice5s : 0
    const status: MarketView['status'] =
      m.feed.status === 'live' && win?.tokensLoaded ? 'live' : m.feed.status === 'down' ? 'down' : 'loading'
    return {
      id: spec.id,
      label: spec.label,
      asset: spec.asset,
      binanceSym: spec.binanceSym,
      windowSec: spec.windowSec,
      priceDp: spec.priceDp,
      enabled,
      status,
      window: {
        startEpoch: win?.startEpoch ?? 0,
        endEpoch: win?.endEpoch ?? 0,
        secondsLeft: tSec,
        strike: win?.strike ?? null,
        strikeEstimated: win?.strikeEstimated ?? true,
        slug: win?.slug ?? '',
        question: win?.question ?? '',
        tokensLoaded: win?.tokensLoaded ?? false,
        accepting: win?.accepting ?? false,
      },
      binance: {
        price,
        bid: q?.bestBid ?? 0,
        ask: q?.bestAsk ?? 0,
        spread: q && q.bestAsk > 0 ? q.bestAsk - q.bestBid : 0,
        change5s,
        ticksPerMin: q?.ticksPerMin ?? 0,
      },
      fv: {
        value: m.lastFv,
        valueDown: 100 - m.lastFv,
        jump5s: this.jump5sNow(m),
        jump5sDown: -this.jump5sNow(m),
        model: this.settings.model,
        sigmaPts: q?.volPts ?? 0,
        sigmaEffPts: m.sigmaEffNow,
        sigmaEffBps: price > 0 ? (m.sigmaEffNow / price) * 1e4 : 0,
        z,
        slope,
        distFromStrike: dist,
      },
      sigma: {
        auto: this.settings.sigmaAuto,
        imp: r1(m.cal.impVal()),
        real: r1(m.cal.realVal()),
        floor: r1(m.cal.floorVal()),
        eff: r1(m.sigmaEffNow),
        snap: m.cal.snapVal(),
        snapAgeMs: m.cal.snapAgeMs(now),
        effIsSnap: m.cal.snapped(),
        accepted: m.cal.accepted,
        rejected: m.cal.rejected,
      },
      hedge: {
        active: !!m.hedge,
        qtyBtc: m.hedge?.qtyBtc ?? 0,
        targetBtc: m.hedge?.targetBtc ?? 0,
        bandBtc: m.hedge?.bandBtc ?? 0,
        pnlUsd: m.hedge && price > 0 ? hedgePnlAt(m.hedge, price) : 0,
        winddown: !!m.hedge && tSec <= this.settings.hedgeWinddownS,
        asset: spec.asset,
      },
      pm: {
        bid: bookUp.bid,
        ask: bookUp.ask,
        askSize: bookUp.askSize,
        bidSize: bookUp.bidSize,
        bookAgeMs: Number.isFinite(bookUp.bookAgeMs) ? bookUp.bookAgeMs : 999999,
        dnBid: bookDn.bid,
        dnAsk: bookDn.ask,
        dnAskSize: bookDn.askSize,
        dnBidSize: bookDn.bidSize,
        dnBookAgeMs: Number.isFinite(bookDn.bookAgeMs) ? bookDn.bookAgeMs : 999999,
      },
      edge: {
        fvAsk: gapUp,
        feeC: m.lastNet.feeC,
        hedgeCostC: r1(m.lastNet.hedgeCostC),
        net: m.lastNet.netC,
        dnFvAsk: gapDn,
        dnFeeC: m.lastNet.dnFeeC,
        dnNet: m.lastNet.dnNetC,
      },
      triggers: { ...m.trig },
      dnTriggers: { ...m.dnTrig },
      capture: { ...m.capture },
      openPos: this.trades.filter((t) => t.market === spec.id && t.status === 'OPEN').length,
      feedStatus: m.feed.status,
    }
  }

  buildSnapshot(now = Date.now()): Snapshot {
    const focus = this.focusMkt()
    const focusSpec = focus?.spec ?? UNIVERSE[0]
    const view = this.marketView(focus ?? undefined, focusSpec, now)
    const universe = UNIVERSE.map((spec) => this.marketView(this.mkts.get(spec.id), spec, now))
    const marketsLive = universe.filter((u) => u.status === 'live').length
    const open = this.trades.filter((t) => t.status === 'OPEN')
    const focusBook = focus ? focus.feed.getBook('up') : null

    // unrealized across the whole universe (binary MTM at each market's FV)
    let unreal = 0
    for (const t of open) {
      const m = this.mkts.get(t.market)
      if (!m) continue
      const fvRef = t.side === 'UP' ? m.lastFv : 100 - m.lastFv
      unreal += (t.shares * fvRef) / 100 - t.costUsd - t.feeUsd
    }
    // live hedges marked at their own symbol's price
    for (const m of this.mkts.values()) {
      if (m.hedge) {
        const q = this.bin.quote(m.spec.binanceSym)
        const price = q ? (q.bestBid > 0 && q.bestAsk > 0 ? (q.bestBid + q.bestAsk) / 2 : q.lastPrice) : 0
        if (price > 0) unreal += hedgePnlAt(m.hedge, price)
      }
    }
    const settled = this.stats.wins + this.stats.losses

    // aggregate feed stats
    let pmUpdates = 0
    let pmSockets = 0
    let pmWorst: string = 'live'
    for (const m of this.mkts.values()) {
      pmUpdates += m.feed.updates
      pmSockets++
      if (m.feed.status === 'down') pmWorst = 'down'
      else if (m.feed.status === 'connecting' && pmWorst !== 'down') pmWorst = 'connecting'
    }

    return {
      ts: now,
      running: this.running,
      focusId: focusSpec.id,
      focus: {
        id: focusSpec.id,
        label: focusSpec.label,
        asset: focusSpec.asset,
        binanceSym: focusSpec.binanceSym,
        windowSec: focusSpec.windowSec,
        priceDp: focusSpec.priceDp,
      },
      universe,
      marketsLive,
      marketsTotal: UNIVERSE.length,
      sideDown: this.settings.sideDown,
      feeds: {
        binance: {
          status: this.bin.status,
          latencyMs: this.bin.worstLag(),
          ticksPerMin: this.bin.totalTpm(),
          symbols: this.bin.symbols().length,
        },
        polymarket: {
          status: pmSockets ? pmWorst : 'connecting',
          updates: pmUpdates,
          lastTradePx: focus ? focus.feed.lastTradePx : null,
          feeRateBps: focus ? focus.feed.feeRateBps : null,
          sockets: pmSockets,
        },
      },
      binance: view.binance,
      window: view.window,
      fv: {
        value: view.fv.value,
        valueDown: view.fv.valueDown,
        jump5s: view.fv.jump5s,
        jump5sDown: view.fv.jump5sDown,
        model: view.fv.model,
        sigmaPts: view.fv.sigmaPts,
        sigmaEffPts: view.fv.sigmaEffPts,
        z: view.fv.z,
        slope: view.fv.slope,
        distFromStrike: view.fv.distFromStrike,
      },
      sigma: view.sigma,
      hedge: {
        on: this.settings.hedgeOn,
        ratio: this.settings.hedgeRatio,
        feeBps: this.settings.hedgeFeeBps,
        active: view.hedge.active,
        qtyBtc: view.hedge.qtyBtc,
        targetBtc: view.hedge.targetBtc,
        bandBtc: view.hedge.bandBtc,
        deltaPerShare:
          focus && focus.win?.strike != null && view.binance.price > 0 && view.window.secondsLeft > 0
            ? digitalDeltaPerShare(view.binance.price, focus.win.strike, Math.max(view.window.secondsLeft, 1), focus.sigmaEffNow)
            : 0,
        shares: focus?.hedge?.shares ?? 0,
        pnlUsd: view.hedge.pnlUsd,
        feesUsd: focus?.hedge?.fees ?? 0,
        fills: focus?.hedge?.fills ?? 0,
        winddown: view.hedge.winddown,
        asset: focusSpec.asset,
      },
      capture: {
        opportunities: this.capture.opportunities,
        fired: this.capture.fired,
        missed: this.capture.missed,
        edgeSeenC: r1(this.capture.edgeSeenC),
        earlyExits: this.capture.earlyExits,
        avgNetEdgeC: this.capture.netEdgeN ? this.capture.netEdgeSum / this.capture.netEdgeN : 0,
      },
      pm: {
        ...view.pm,
        asks: focusBook?.asks ?? [],
        bids: focusBook?.bids ?? [],
      },
      edge: {
        ...view.edge,
        fvMid:
          view.pm.bid != null && view.pm.ask != null
            ? view.fv.value - (view.pm.ask + view.pm.bid) / 2
            : null,
      },
      triggers: view.triggers,
      dnTriggers: view.dnTriggers,
      stats: {
        pnlRealized: this.stats.pnlRealized,
        pnlUnrealized: unreal,
        pnlTotal: this.stats.pnlRealized + unreal,
        trades: this.stats.trades,
        open: open.length,
        wins: this.stats.wins,
        losses: this.stats.losses,
        winRate: settled ? (this.stats.wins / settled) * 100 : 0,
        avgEdgeC: this.stats.edgeN ? this.stats.edgeSum / this.stats.edgeN : 0,
        triggersToday: this.stats.triggersToday,
        stakedUsd: this.stats.stakedUsd,
      },
      latency: {
        feedP50: this.pct(this.feedLagRing, 0.5),
        feedP99: this.pct(this.feedLagRing, 0.99),
        engineUsP50: this.pct(this.tickUsRing, 0.5),
        engineUsP99: this.pct(this.tickUsRing, 0.99),
        decisionUsP50: this.pct(this.decisionUsRing, 0.5),
        decisionUsP99: this.pct(this.decisionUsRing, 0.99),
      },
      chart: focus ? this.lastChartPoint(focus, view) : ({} as ChartPoint),
    }
  }

  private lastChartPoint(m: Mkt, view: MarketView): ChartPoint {
    const p = m.chart[m.chart.length - 1]
    if (p) return p
    return {
      t: Date.now(),
      price: view.binance.price,
      bid: view.binance.bid,
      ask: view.binance.ask,
      fv: view.fv.value,
      pmAsk: view.pm.ask ?? 0,
      pmBid: view.pm.bid ?? 0,
      edge: view.edge.fvAsk ?? 0,
    }
  }

  /** 5s jump recomputed from a market's fv ring. */
  private jump5sNow(m: Mkt): number {
    const now = Date.now()
    const cur = m.fvRing[m.fvRing.length - 1]
    if (!cur) return 0
    let ref: number | undefined
    for (let i = m.fvRing.length - 1; i >= 0; i--) {
      if (m.fvRing[i].t <= now - 5000) {
        ref = m.fvRing[i].v
        break
      }
    }
    return ref == null ? 0 : cur.v - ref
  }

  buildInit(): InitPayload {
    const snap = this.buildSnapshot()
    const focus = this.focusMkt()
    const hist = focus ? focus.chart : []
    const step = Math.max(1, Math.ceil(hist.length / 720))
    const history = step === 1 ? [...hist] : hist.filter((_, i) => i % step === 0)
    return {
      snapshot: snap,
      history,
      signals: this.signals.slice(0, 40),
      trades: this.trades.slice(0, 50),
      settings: { ...this.settings, markets: { ...this.settings.markets } },
    }
  }

  // ── control ─────────────────────────────────────────────────────────────────

  control(msg: ControlMsg): void {
    if (msg.type === 'start') {
      this.running = true
      console.log('[engine] running=true')
    } else if (msg.type === 'stop') {
      this.running = false
      console.log('[engine] running=false')
    } else if (msg.type === 'reset') {
      this.signals = []
      this.trades = []
      this.capture = {
        opportunities: 0,
        fired: 0,
        missed: 0,
        edgeSeenC: 0,
        earlyExits: 0,
        netEdgeSum: 0,
        netEdgeN: 0,
      }
      this.stats = {
        pnlRealized: 0,
        trades: 0,
        wins: 0,
        losses: 0,
        stakedUsd: 0,
        edgeSum: 0,
        edgeN: 0,
        triggersToday: 0,
        dayStart: localMidnight(),
      }
      for (const m of this.mkts.values()) {
        m.hedge = null
        m.armedPrev = false
        m.episodeFired = false
        m.dnArmedPrev = false
        m.dnEpisodeFired = false
        m.capture = { opportunities: 0, fired: 0, missed: 0, edgeSeenC: 0 }
        m.chart = []
      }
      console.log('[engine] stats reset')
    } else if (msg.type === 'settings' && msg.settings) {
      // sanitize: drop null / non-finite numerics so a bad patch can't NaN the hot path
      const patch: Partial<Settings> = {}
      for (const [k, v] of Object.entries(msg.settings)) {
        if (v == null) continue
        if (typeof v === 'number' && !Number.isFinite(v)) continue
        ;(patch as Record<string, unknown>)[k] = v
      }
      // validate the universe map (known ids, booleans only)
      if (patch.markets && typeof patch.markets === 'object') {
        const clean: Record<string, boolean> = { ...this.settings.markets }
        for (const spec of UNIVERSE) {
          const v = (patch.markets as Record<string, unknown>)[spec.id]
          if (typeof v === 'boolean') clean[spec.id] = v
        }
        patch.markets = clean
      }
      if (patch.focusMarket != null && !UNIVERSE.some((s) => s.id === patch.focusMarket)) {
        delete patch.focusMarket
      }
      this.settings = { ...this.settings, ...patch }
      // clamp knobs to sane ranges
      const s = this.settings
      s.stakeUsd = clampN(s.stakeUsd, 1, 5000)
      s.jumpThreshC = clampN(s.jumpThreshC, 1, 60)
      s.fvFloorC = clampN(s.fvFloorC, 40, 90)
      s.edgeThreshC = clampN(s.edgeThreshC, 1, 60)
      s.minSecsLeft = clampN(s.minSecsLeft, 5, 600)
      s.maxTradesPerWindow = clampN(Math.round(s.maxTradesPerWindow), 1, 20)
      s.takerFeeBps = clampN(s.takerFeeBps, 0, 3000)
      s.maxBookAgeMs = clampN(s.maxBookAgeMs, 500, 30000)
      s.sigmaWImp = clampN(s.sigmaWImp, 0, 1)
      s.sigmaZGate = clampN(s.sigmaZGate, 0.05, 1.5)
      s.sigmaFloorK = clampN(s.sigmaFloorK, 0.1, 2)
      s.sigmaAbsFloor = clampN(s.sigmaAbsFloor, 1, 40)
      s.hedgeRatio = clampN(s.hedgeRatio, 0, 1)
      s.hedgeFeeBps = clampN(s.hedgeFeeBps, 0, 200)
      s.hedgeMinBandUsd = clampN(s.hedgeMinBandUsd, 10, 5000)
      s.hedgeWinddownS = clampN(s.hedgeWinddownS, 3, 120)
      s.minNetEdgeC = clampN(s.minNetEdgeC, 0, 50)
      s.exitBandC = clampN(s.exitBandC, 0, 30)
      s.minCaptureC = clampN(s.minCaptureC, -1, 90)
      // apply universe changes (enable/disable live) + re-sync per-market cfg
      this.applyUniverse()
      for (const m of this.mkts.values()) this.syncSigmaCfg(m)
      console.log('[engine] settings updated', JSON.stringify(patch).slice(0, 400))
    }
  }
}
