// ─── XARB engine core ─────────────────────────────────────────────────────────
// Binance mid → UP fair value → trigger (5s jump ≥20¢ ∧ FV>60¢ ∧ gap ≥10¢)
// → paper-fill by walking the live Polymarket CLOB ask ladder → settle at close.

import { BinanceFeed } from './binance'
import { PolymarketFeed } from './polymarket'
import {
  fvLinear,
  fvCdfEff,
  fvCdfDetail,
  sigmaEff,
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
  DEFAULT_HEDGE_CFG,
  type HedgeCfg,
  type HedgePos,
} from './hedger'
import {
  DEFAULT_SETTINGS,
  type ChartPoint,
  type ControlMsg,
  type HedgeEvent,
  type InitPayload,
  type Settings,
  type SignalLog,
  type Snapshot,
  type Trade,
  type WindowInfo,
} from './types'

const WINDOW_SEC = 300
const FV_PUSH_MS = 50
const FV_KEEP_MS = 20000
const CHART_PUSH_MS = 250
const CHART_CAP = 1440
const SIGNAL_COOLDOWN_MS = 5000
const SKIP_LOG_MS = 8000
const WATCH_LOG_MS = 10000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Date.now() / 1000
const localMidnight = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const uid = () => Math.random().toString(36).slice(2, 9)
const r1 = (v: number): number => Math.round(v * 10) / 10

/** z-score helper for the linear model row (still uses CDF σ for context). */
function d0(sigmaPts: number, tSec: number, price: number, strike: number): number {
  const sd = Math.max(sigmaEff(sigmaPts) * Math.sqrt(Math.max(tSec, 1)), 5)
  return (price - strike) / sd
}

export class Engine {
  settings: Settings = { ...DEFAULT_SETTINGS }
  running = true

  bin = new BinanceFeed()
  pm = new PolymarketFeed()

  onSnap?: (s: Snapshot) => void
  onSignal?: (s: SignalLog) => void
  onSettle?: (t: Trade) => void
  onHedge?: (e: HedgeEvent) => void

  // ── v0.4: σ auto-calibration + δ-hedging + capture ───────────────────
  private cal = new SigmaCalib()
  private lastCalVer = -1
  /** Effective σ actually in use (auto → calibrated; legacy → fixed floor). */
  private sigmaEffNow = 15.5
  /** Live Binance hedge position (null when flat). */
  private hedge: HedgePos | null = null
  private capture = {
    opportunities: 0,
    fired: 0,
    missed: 0,
    edgeSeenC: 0,
    earlyExits: 0,
    netEdgeSum: 0,
    netEdgeN: 0,
  }
  /** Rising-edge tracking of the 3-trigger conjunction (opportunity episodes). */
  private armedPrev = false
  private episodeFired = false

  private win: WindowInfo | null = null
  private fvRing: { t: number; v: number }[] = []
  private chart: ChartPoint[] = []
  private signals: SignalLog[] = []
  private trades: Trade[] = []
  private trig = { jump: false, above60: false, gap: false, all: false }
  private lastFv = 50
  private lastFvAt = 0
  private lastChartPush = 0
  private lastSignalTs = 0
  private lastSkipLog: Record<string, number> = {}
  private lastWatchLog = 0
  private signalSeq = 0
  private loadEpochPromise: Promise<void> | null = null

  // latency rings
  private feedLagRing: number[] = []
  private tickUsRing: number[] = []
  private decisionUsRing: number[] = []

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

  /** Hedge policy config view of the live settings. */
  private hedgeCfg(): HedgeCfg {
    const s = this.settings
    return {
      on: s.hedgeOn,
      ratio: s.hedgeRatio,
      feeBps: s.hedgeFeeBps,
      cWw: DEFAULT_HEDGE_CFG.cWw,
      minBandBtc: s.hedgeMinBandBtc,
      winddownS: s.hedgeWinddownS,
      flattenS: DEFAULT_HEDGE_CFG.flattenS,
      minQtyBtc: DEFAULT_HEDGE_CFG.minQtyBtc,
      qtyStepBtc: DEFAULT_HEDGE_CFG.qtyStepBtc,
      costTurnoverMult: DEFAULT_HEDGE_CFG.costTurnoverMult,
    }
  }

  private syncSigmaCfg(): void {
    const s = this.settings
    this.cal.setCfg({
      auto: s.sigmaAuto,
      wImp: s.sigmaWImp,
      zGate: s.sigmaZGate,
      kappa: DEFAULT_SIGMA_CFG.kappa,
      floorK: s.sigmaFloorK,
      absFloor: s.sigmaAbsFloor,
      cap: DEFAULT_SIGMA_CFG.cap,
      histCap: DEFAULT_SIGMA_CFG.histCap,
    })
  }

  start(): void {
    this.bin.onPrice = () => this.onMarketEvent()
    this.bin.onTrade = () => this.onMarketEvent()
    this.pm.onBook = () => this.onMarketEvent()
    this.syncSigmaCfg()
    this.bin.connect()
    this.pm.start()
    this.initWindow()
    this.ensureLoop()
    console.log('[engine] started v0.4 (paper mode, σ auto-cal + δ-hedge ON)')
  }

  /** 10Hz loop handle + staleness watchdog. bun --hot DISCARDS timers created
   *  during module evaluation (hot reload), while WS handlers keep firing from
   *  the live event loop — so every market event re-arms a stale loop within
   *  ~100ms. Self-healing by construction. */
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

  // ── window lifecycle ────────────────────────────────────────────────────────

  private initWindow(): void {
    const epoch = Math.floor(nowSec() / WINDOW_SEC) * WINDOW_SEC
    void this.loadWindow(epoch, true)
  }

  private async loadWindow(epoch: number, estimated: boolean): Promise<void> {
    if (this.loadEpochPromise) return
    const task = (async () => {
      // wait for the first Binance price so the strike sample is valid
      let strike = this.bin.mid()
      for (let i = 0; i < 60 && strike <= 0; i++) {
        await sleep(100)
        strike = this.bin.mid()
      }
      // superseded while waiting (e.g. another rollover already ran)
      if (this.win && this.win.startEpoch !== epoch && this.win.startEpoch > epoch) return
      this.win = {
        startEpoch: epoch,
        endEpoch: epoch + WINDOW_SEC,
        slug: `btc-updown-5m-${epoch}`,
        question: '',
        upTokenId: '',
        downTokenId: '',
        conditionId: '',
        strike: strike > 0 ? strike : null,
        strikeEstimated: estimated,
        tokensLoaded: false,
        accepting: true,
      }
      this.fvRing = []
      for (let i = 0; i < 12; i++) {
        if (!this.win || this.win.startEpoch !== epoch) return // superseded
        const ev = await this.pm.discoverWindow(epoch)
        if (ev) {
          if (!this.win || this.win.startEpoch !== epoch) return
          this.win.upTokenId = ev.upTokenId
          this.win.downTokenId = ev.downTokenId
          this.win.conditionId = ev.conditionId
          this.win.question = ev.question
          this.win.accepting = ev.accepting
          this.win.tokensLoaded = true
          this.pm.setToken(ev.upTokenId)
          console.log(`[engine] window loaded: ${this.win.slug} strike=${strike}`)
          return
        }
        await sleep(2000)
      }
      console.log(`[engine] window NOT found after retries: btc-updown-5m-${epoch}`)
    })()
    this.loadEpochPromise = task.finally(() => {
      this.loadEpochPromise = null
    })
  }

  private settleWindow(): void {
    const win = this.win
    if (!win) return
    const finalPrice = this.bin.mid() || this.bin.lastPrice
    for (const t of this.trades) {
      if (t.status === 'OPEN' && t.windowEnd === win.endEpoch) {
        // v0.4: flatten any residual hedge at settlement and fold its exact
        // cash-flow P&L into the combined result.
        let hedgePnl = 0
        const h = this.hedge
        if (h && h.tradeId === t.id) {
          if (!hedgeIsFlat(h)) {
            this.fillHedge(h, -h.qtyBtc, 'flatten (settlement)', Date.now(), finalPrice, finalPrice)
          }
          hedgePnl = hedgePnlAt(h, finalPrice)
          t.hedgeFills = h.fills
          t.hedgeFeesUsd = h.fees
          this.hedge = null
        }
        t.hedgePnlUsd = hedgePnl
        const won = finalPrice >= t.strike
        t.status = won ? 'WON' : 'LOST'
        t.finalPrice = finalPrice
        const binaryPnl = won ? t.shares * 1 - t.costUsd - t.feeUsd : -t.costUsd - t.feeUsd
        t.pnlUsd = binaryPnl + hedgePnl
        this.stats.pnlRealized += t.pnlUsd
        if (won) this.stats.wins++
        else this.stats.losses++
        console.log(
          `[settle] ${t.id} ${t.status} final=${finalPrice.toFixed(1)} strike=${t.strike.toFixed(1)} binary=${binaryPnl.toFixed(2)} hedge=${hedgePnl.toFixed(2)} pnl=${t.pnlUsd.toFixed(2)}`
        )
        this.onSettle?.(t)
      }
    }
  }

  // ── hot path: recompute on every Binance/Polymarket event ──────────────────

  private onMarketEvent(): void {
    if (!this.running) return
    this.ensureLoop() // re-arm if a hot reload discarded the tick loop
    const t0 = performance.now()
    this.evaluate()
    const us = (performance.now() - t0) * 1000
    this.decisionUsRing.push(us)
    if (this.decisionUsRing.length > 400) this.decisionUsRing.shift()
  }

  private evaluate(): void {
    const win = this.win
    if (!win || win.strike == null || win.strike <= 0) return
    const now = Date.now()
    const tSec = (win.endEpoch * 1000 - now) / 1000
    if (tSec <= 0) return

    const price = this.bin.mid()
    if (price <= 0) return

    const book = this.pm.getBook()

    // ── v0.4 σ auto-calibration ────────────────────────────────────────
    // Fold every FRESH PM book print into the calibrator (the implied σ is
    // inverted from the market's own mid; a print-time snap latches the σ
    // that makes FV equal that mid). Realized σ mirrors in continuously.
    this.cal.observeReal(this.bin.volPts)
    if (this.pm.bookVer !== this.lastCalVer) {
      this.lastCalVer = this.pm.bookVer
      const midUp = book.bid != null && book.ask != null ? (book.bid + book.ask) / 2 : null
      this.cal.observePm(
        midUp,
        null,
        price,
        win.strike,
        tSec,
        now,
        book.bookAgeMs < this.settings.maxBookAgeMs
      )
    }
    const sigmaAuto = this.settings.sigmaAuto
    this.sigmaEffNow = sigmaAuto ? this.cal.effective(now) : sigmaEff(this.bin.volPts)

    // fair value
    let fv: number
    if (this.settings.model === 'cdf') {
      fv = fvCdfEff(price, win.strike, tSec, this.sigmaEffNow).value
    } else {
      fv = fvLinear(price, win.strike, tSec).value
    }
    this.lastFv = fv
    this.lastFvAt = now

    // fv ring (throttled)
    const last = this.fvRing[this.fvRing.length - 1]
    if (!last || now - last.t >= FV_PUSH_MS) {
      this.fvRing.push({ t: now, v: fv })
      while (this.fvRing.length && now - this.fvRing[0].t > FV_KEEP_MS) this.fvRing.shift()
    }

    // 5-second jump
    let ref: number | undefined
    for (let i = this.fvRing.length - 1; i >= 0; i--) {
      if (this.fvRing[i].t <= now - 5000) {
        ref = this.fvRing[i].v
        break
      }
    }
    const jump = ref == null ? 0 : fv - ref

    // polymarket book
    const askC = book.ask
    const gapC = askC != null ? fv - askC : null
    const fresh = book.bookAgeMs < this.settings.maxBookAgeMs

    // v0.4: net-edge decomposition (the profit gate preview) — PM taker fee
    // (fee-on-proceeds shape, live market rate wins over the knob) + the
    // estimated Binance hedge turnover cost per share.
    const pmFeeBps = this.pm.feeRateBps ?? this.settings.takerFeeBps
    const feeC = askC != null ? pmFeeCPerShare(Math.min(Math.max(askC / 100, 0.01), 0.99), pmFeeBps) : null
    const hedgeCostC = estHedgeCostC(price, win.strike, tSec, this.sigmaEffNow, this.hedgeCfg())
    const netC = gapC != null && feeC != null ? gapC - feeC - hedgeCostC : null
    this.lastNet = { feeC, hedgeCostC, netC }

    const jumpOK = jump >= this.settings.jumpThreshC
    const floorOK = fv > this.settings.fvFloorC
    const gapOK = gapC != null && fresh && gapC >= this.settings.edgeThreshC
    const netOK = netC != null && netC >= this.settings.minNetEdgeC
    const all = jumpOK && floorOK && gapOK
    this.trig = { jump: jumpOK, above60: floorOK, gap: gapOK, all, net: netOK }

    // v0.4 capture accounting: every rising edge of the 3-trigger conjunction
    // is an opportunity; each episode receives an explicit decision (fire or
    // a logged skip reason) — engine-side silent misses are structurally zero.
    if (all && !this.armedPrev) {
      this.armedPrev = true
      this.episodeFired = false
      this.capture.opportunities++
      if (gapC != null) this.capture.edgeSeenC += gapC
      console.log(
        `[opportunity] #${this.capture.opportunities} edge=${gapC?.toFixed(1)}¢ net=${netC?.toFixed(1)}¢ (fee ${feeC?.toFixed(1)} + hedge ${hedgeCostC.toFixed(1)})`
      )
    } else if (!all && this.armedPrev) {
      this.armedPrev = false
      if (!this.episodeFired) this.capture.missed++
    }

    if (all) {
      this.tryFire(fv, jump, askC!, gapC!, tSec, book.askSize, netC, feeC, hedgeCostC)
    } else {
      this.logWatchOrSkip(fv, jump, gapC, jumpOK, floorOK, tSec)
    }
  }

  /** Latest net-edge decomposition (for the snapshot / gate row). */
  private lastNet: { feeC: number | null; hedgeCostC: number; netC: number | null } = {
    feeC: null,
    hedgeCostC: 0,
    netC: null,
  }

  private tryFire(
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
    const win = this.win!
    if (!this.settings.autoTrade) {
      this.logSkip('auto-trade off', fv, jump, gapC, tSec)
      return
    }
    if (tSec < this.settings.minSecsLeft) {
      this.logSkip(`too close to close (${Math.max(0, tSec).toFixed(0)}s left)`, fv, jump, gapC, tSec)
      return
    }
    if (now - this.lastSignalTs < SIGNAL_COOLDOWN_MS) return
    const windowTrades = this.trades.filter((t) => t.windowEnd === win.endEpoch)
    if (windowTrades.length >= this.settings.maxTradesPerWindow) {
      this.logSkip('max trades for window', fv, jump, gapC, tSec)
      return
    }
    if (windowTrades.some((t) => t.status === 'OPEN')) {
      this.logSkip('position already open', fv, jump, gapC, tSec)
      return
    }
    if (!win.tokensLoaded) {
      this.logSkip('window book not loaded', fv, jump, gapC, tSec)
      return
    }

    // ── v0.4 profitability gate ─────────────────────────────────────────
    // Net of the PM taker fee (live market rate, fee-on-proceeds shape) and
    // the estimated Binance hedge turnover cost, the edge must still clear
    // the floor — the strategy only trades profitable opportunities.
    if (netEdgeC == null || netEdgeC < this.settings.minNetEdgeC) {
      this.logSkip(
        `net edge ${netEdgeC?.toFixed(1) ?? '—'}¢ below ${this.settings.minNetEdgeC}¢ floor (PM fee ${feeC?.toFixed(1) ?? '—'}¢ + hedge ${hedgeCostC.toFixed(1)}¢)`,
        fv,
        jump,
        gapC,
        tSec
      )
      return
    }

    // walk the live ask ladder ($ prices, share sizes)
    const ladder = this.pm.askLadderUsd()
    if (!ladder.length) {
      this.logSkip('no asks on book', fv, jump, gapC, tSec)
      return
    }
    const stake = this.settings.stakeUsd
    const depthUsd = ladder.reduce((a, l) => a + l.p * l.s, 0)
    if (depthUsd < stake * 0.4) {
      this.logSkip(`thin book ($${depthUsd.toFixed(0)} depth)`, fv, jump, gapC, tSec)
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
      this.logSkip('empty fill', fv, jump, gapC, tSec)
      return
    }
    const avgC = (cost / shares) * 100
    // v0.4: PM taker fee in the exchange's fee-on-proceeds shape —
    // bps/10⁴ · min(p, 1−p) per share (the live market rate wins over the knob)
    const feeBps = this.pm.feeRateBps ?? this.settings.takerFeeBps
    const fee = (shares * pmFeeCPerShare(avgC / 100, feeBps)) / 100

    const id = `S${++this.signalSeq}-${uid()}`
    const signal: SignalLog = {
      id,
      ts: now,
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
      sigmaEffPts: this.sigmaEffNow,
    }
    const trade: Trade = {
      id: `T${this.signalSeq}-${uid()}`,
      signalId: id,
      ts: now,
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
      sigmaEffPts: this.sigmaEffNow,
    }
    this.lastSignalTs = now
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
    this.episodeFired = true
    this.capture.netEdgeSum += netEdgeC
    this.capture.netEdgeN++
    console.log(
      `[SIGNAL] ${id} fv=${fv.toFixed(1)}¢ ask=${askC.toFixed(1)}¢ edge=${gapC.toFixed(1)}¢ net=${netEdgeC.toFixed(1)}¢ jump=${jump.toFixed(1)}¢ fill=${avgC.toFixed(1)}¢`
    )
    this.onSignal?.(signal)

    // ── v0.4: open the Binance delta hedge immediately ───────────────────
    // The binary's digital delta is shorted on Binance so the combined
    // (binary + hedge) position isolates the entry mispricing. Paper fills
    // cross the live top-of-book (shorts hit the bid, covers lift the ask);
    // if the book is momentarily empty the 100ms policy tick retries.
    if (this.settings.hedgeOn) {
      this.hedge = newHedgePos(trade.id, SIDE_UP, shares, win.strike!)
      this.runHedgePolicy(now, tSec)
    }
  }

  private logSkip(reason: string, fv: number, jump: number, gapC: number | null, tSec: number): void {
    const now = Date.now()
    if (now - (this.lastSkipLog[reason] ?? 0) < SKIP_LOG_MS) return
    this.lastSkipLog[reason] = now
    this.stats.triggersToday++
    const signal: SignalLog = {
      id: `K${++this.signalSeq}-${uid()}`,
      ts: now,
      windowEnd: this.win?.endEpoch ?? 0,
      fv,
      ask: this.pm.getBook().ask,
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
    fv: number,
    jump: number,
    gapC: number | null,
    jumpOK: boolean,
    floorOK: boolean,
    tSec: number
  ): void {
    const now = Date.now()
    // near-miss watch: gap approaching the threshold
    if (
      gapC != null &&
      gapC >= this.settings.edgeThreshC - 3 &&
      gapC < this.settings.edgeThreshC &&
      now - this.lastWatchLog > WATCH_LOG_MS
    ) {
      this.lastWatchLog = now
      const signal: SignalLog = {
        id: `W${++this.signalSeq}-${uid()}`,
        ts: now,
        windowEnd: this.win?.endEpoch ?? 0,
        fv,
        ask: this.pm.getBook().ask,
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
      this.logSkip('momentum, but PM already repriced', fv, jump, gapC, tSec)
    }
  }

  // ── v0.4: Binance δ-hedge policy + early-exit engine ─────────────────────────

  /** One hedge policy step (100ms cadence): W–W band re-hedge, wind-down
   *  risk-reduction, force-flatten at expiry. Paper fills cross the live
   *  Binance top-of-book; live mode sends USDT-M futures MARKET orders. */
  private runHedgePolicy(now: number, tSecOverride?: number): void {
    const h = this.hedge
    if (!h) return
    const win = this.win
    if (!win) return
    const price = this.bin.mid()
    if (price <= 0) return
    const tSec = tSecOverride ?? (win.endEpoch * 1000 - now) / 1000
    if (tSec <= 0) return
    const act = hedgeStep(h, price, this.sigmaEffNow, tSec, this.hedgeCfg())
    if (!act) return
    this.fillHedge(h, act.qty, act.reason, now, price)
  }

  /** Paper hedge fill at the live top-of-book: shorts cross the bid, covers
   *  lift the ask. Exact cash-flow accounting. fallbackPx covers the no-book
   *  edge (settlement/exit flattens at the mark). */
  private fillHedge(
    h: HedgePos,
    qty: number,
    reason: string,
    now: number,
    mark: number,
    fallbackPx = 0
  ): void {
    let px = qty < 0 ? this.bin.bestBid : this.bin.bestAsk
    if (!px || px <= 0) px = fallbackPx
    if (!px || px <= 0) return // no live book — the next policy tick retries
    const cfg = this.hedgeCfg()
    const fee = (Math.abs(qty) * px * cfg.feeBps) / 10000
    applyHedgeFill(h, qty, px, fee)
    console.log(
      `[hedge] ${h.tradeId} ${qty < 0 ? 'SHORT' : 'COVER'} ${qty.toFixed(4)} BTC @ ${px.toFixed(1)} (${reason}) fee=$${fee.toFixed(3)} pos=${h.qtyBtc.toFixed(4)}`
    )
    this.onHedge?.({
      ts: now,
      tradeId: h.tradeId,
      qtyBtc: qty,
      px,
      feeUsd: fee,
      reason,
      posQtyBtc: h.qtyBtc,
      pnlUsd: hedgePnlAt(h, mark),
      sigmaEffPts: this.sigmaEffNow,
    })
    // mirror onto the trade row
    const t = this.trades.find((x) => x.id === h.tradeId)
    if (t) {
      if (h.fills === 1) t.hedgeQtyBtc = Math.abs(h.qtyBtc) // initial delta shorted
      t.hedgeFills = h.fills
      t.hedgeFeesUsd = h.fees
    }
  }

  /** 100ms early-exit tick: bank the mispricing when PM re-converges. Sells
   *  the binary back at the bid (paper: walks the displayed size) and
   *  flattens the hedge — the edge is captured WITHOUT waiting for
   *  settlement and without paying into the expiry gamma explosion. */
  private exitTick(now: number, t: Trade): void {
    const s = this.settings
    if (s.minCaptureC < 0) return // exits disabled via negative capture
    const win = this.win
    if (!win || win.strike == null) return
    const tSec = (win.endEpoch * 1000 - now) / 1000
    if (tSec <= 0) return
    const bid = this.pm.getBook().bid
    if (bid == null) return
    const captured = bid - t.priceC
    const feeBps = this.pm.feeRateBps ?? s.takerFeeBps
    const exitFeeC = pmFeeCPerShare(bid / 100, feeBps)
    // reprice-exit: PM bid back within exit_band of FV AND enough edge locked
    // (≥ min_capture over entry, and ≥ 1¢ over entry after the exit fee)
    if (bid + s.exitBandC >= this.lastFv && captured >= s.minCaptureC && captured - exitFeeC >= 1.0) {
      this.executeExit(t, bid, feeBps, 'reprice-exit', now)
    }
  }

  /** Sell the binary back at the bid and flatten the hedge. */
  private executeExit(t: Trade, bidC: number, feeBps: number, reason: string, now: number): void {
    const bidSize = this.pm.getBook().bidSize
    // paper exit fill: take the displayed size at the bid
    const fillShares = Math.min(t.shares, Math.max(bidSize, 0))
    if (fillShares < 5) return // below the 5-share order minimum — hold to settlement
    const proceeds = (fillShares * bidC) / 100
    const exitFee = (fillShares * pmFeeCPerShare(bidC / 100, feeBps)) / 100
    const mark = this.bin.mid()
    // flatten the hedge at market (paper inline; live reduce-only)
    let hedgePnl = 0
    const h = this.hedge
    if (h && h.tradeId === t.id) {
      if (!hedgeIsFlat(h)) {
        const qty = -h.qtyBtc
        this.fillHedge(h, qty, 'flatten (early exit)', now, mark, mark)
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
    this.hedge = null
    console.log(
      `[exit] ${t.id} EXITED @ ${bidC.toFixed(1)}¢ (entry ${t.priceC.toFixed(1)}¢) binary=${binaryPnl.toFixed(2)} hedge=${hedgePnl.toFixed(2)} net=${total.toFixed(2)}`
    )
    const sig: SignalLog = {
      id: `X${++this.signalSeq}-${uid()}`,
      ts: now,
      windowEnd: t.windowEnd,
      fv: this.lastFv,
      ask: bidC,
      edge: null,
      jump5s: this.jump5sNow(),
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

  // ── 10Hz loop: rollover, chart, snapshot ────────────────────────────────────

  private tick(): void {
    const t0 = performance.now()
    const now = Date.now()
    this.lastTickAt = now

    this.bin.sampleRate()

    // window rollover
    const win = this.win
    if (win && now >= win.endEpoch * 1000 + 200) {
      this.settleWindow()
      void this.loadWindow(win.endEpoch, false)
    }

    // ── v0.4: 100ms hedge policy tick + early-exit engine ──────────────────
    if (this.hedge && this.running) {
      const t = this.trades.find((x) => x.id === this.hedge!.tradeId && x.status === 'OPEN')
      if (t) {
        this.runHedgePolicy(now)
        this.exitTick(now, t)
      } else {
        this.hedge = null // trade closed (settled/exited) — drop the hedge
      }
    }

    // chart point (250ms cadence)
    if (now - this.lastChartPush >= CHART_PUSH_MS && this.win?.strike != null) {
      this.lastChartPush = now
      const book = this.pm.getBook()
      const prevPt = this.chart[this.chart.length - 1]
      const pt: ChartPoint = {
        t: now,
        price: this.bin.mid(),
        bid: this.bin.bestBid,
        ask: this.bin.bestAsk,
        fv: this.lastFv,
        pmAsk: book.ask ?? prevPt?.pmAsk ?? 0,
        pmBid: book.bid ?? prevPt?.pmBid ?? 0,
        edge: book.ask != null ? this.lastFv - book.ask : (prevPt?.edge ?? 0),
      }
      if (pt.price > 0) {
        this.chart.push(pt)
        if (this.chart.length > CHART_CAP) this.chart.shift()
      }
    }

    // feed lag mirror
    const lag = this.bin.lastLag()
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

  buildSnapshot(now = Date.now()): Snapshot {
    const win = this.win
    const book = this.pm.getBook()
    const price = this.bin.mid()
    const last = this.chart[this.chart.length - 1]
    const tSec = win ? Math.max(0, (win.endEpoch * 1000 - now) / 1000) : 0
    const dist = win?.strike != null ? price - win.strike : 0
    // FV detail: slope is the ACTIVE model's local slope (¢/pt); z/sd from the CDF
    // at the effective σ in use (auto-calibrated when σ auto-cal is on).
    let slope = 0.19
    let z = 0
    if (win?.strike != null) {
      const t = Math.max(tSec, 1)
      if (this.settings.model === 'cdf') {
        const d = fvCdfEff(price, win.strike, t, this.sigmaEffNow)
        slope = d.slope
        z = d.z
      } else {
        slope = fvLinear(price, win.strike, t).slope
        z = d0(this.bin.volPts, t, price, win.strike)
      }
    }

    const open = this.trades.filter((t) => t.status === 'OPEN')
    let unreal = 0
    for (const t of open) {
      unreal += (t.shares * this.lastFv) / 100 - t.costUsd - t.feeUsd
    }
    // v0.4: mark the live Binance hedge into unrealized while it is open
    if (this.hedge) unreal += hedgePnlAt(this.hedge, price)
    const settled = this.stats.wins + this.stats.losses
    const edgeFvAsk = book.ask != null ? this.lastFv - book.ask : null

    // v0.4: net-edge decomposition (profit gate preview)
    const pmFeeBps = this.pm.feeRateBps ?? this.settings.takerFeeBps
    const feeC =
      book.ask != null
        ? pmFeeCPerShare(Math.min(Math.max(book.ask / 100, 0.01), 0.99), pmFeeBps)
        : null
    const hedgeCostC =
      win?.strike != null && price > 0
        ? estHedgeCostC(price, win.strike, Math.max(tSec, 1), this.sigmaEffNow, this.hedgeCfg())
        : 0
    const netC = edgeFvAsk != null && feeC != null ? edgeFvAsk - feeC - hedgeCostC : null

    const lastPt: ChartPoint =
      last ?? { t: now, price, bid: this.bin.bestBid, ask: this.bin.bestAsk, fv: this.lastFv, pmAsk: book.ask ?? 0, pmBid: book.bid ?? 0, edge: edgeFvAsk ?? 0 }

    return {
      ts: now,
      running: this.running,
      feeds: {
        binance: {
          status: this.bin.status,
          latencyMs: this.bin.lastLag(),
          ticksPerMin: this.bin.ticksPerMin,
        },
        polymarket: {
          status: this.pm.status,
          updates: this.pm.updates,
          lastTradePx: this.pm.lastTradePx,
          feeRateBps: this.pm.feeRateBps,
        },
      },
      binance: {
        price,
        bid: this.bin.bestBid,
        ask: this.bin.bestAsk,
        spread: this.bin.spread(),
        change5s: this.bin.change5s(),
      },
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
      fv: {
        value: this.lastFv,
        jump5s: this.jump5sNow(),
        model: this.settings.model,
        sigmaPts: this.bin.volPts,
        sigmaEffPts: this.sigmaEffNow,
        z,
        slope,
        distFromStrike: dist,
      },
      sigma: {
        auto: this.settings.sigmaAuto,
        imp: r1(this.cal.impVal()),
        real: r1(this.cal.realVal()),
        floor: r1(this.cal.floorVal()),
        eff: r1(this.sigmaEffNow),
        snap: this.cal.snapVal(),
        snapAgeMs: this.cal.snapAgeMs(now),
        effIsSnap: this.cal.snapped(),
        accepted: this.cal.accepted,
        rejected: this.cal.rejected,
      },
      hedge: {
        on: this.settings.hedgeOn,
        ratio: this.settings.hedgeRatio,
        feeBps: this.settings.hedgeFeeBps,
        active: !!this.hedge,
        qtyBtc: this.hedge?.qtyBtc ?? 0,
        targetBtc: this.hedge?.targetBtc ?? 0,
        bandBtc: this.hedge?.bandBtc ?? 0,
        deltaPerShare:
          win?.strike != null && price > 0 && tSec > 0
            ? digitalDeltaPerShare(price, win.strike, Math.max(tSec, 1), this.sigmaEffNow)
            : 0,
        shares: this.hedge?.shares ?? 0,
        pnlUsd: this.hedge ? hedgePnlAt(this.hedge, price) : 0,
        feesUsd: this.hedge?.fees ?? 0,
        fills: this.hedge?.fills ?? 0,
        winddown: !!this.hedge && tSec <= this.settings.hedgeWinddownS,
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
        bid: book.bid,
        ask: book.ask,
        askSize: book.askSize,
        bidSize: book.bidSize,
        bookAgeMs: Number.isFinite(book.bookAgeMs) ? book.bookAgeMs : 999999,
        asks: book.asks,
        bids: book.bids,
      },
      edge: {
        fvAsk: edgeFvAsk,
        fvMid: book.bid != null ? this.lastFv - (book.ask! + book.bid) / 2 : null,
        feeC,
        hedgeCostC: r1(hedgeCostC),
        net: netC,
      },
      triggers: { ...this.trig, net: netC != null && netC >= this.settings.minNetEdgeC },
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
      chart: lastPt,
    }
  }

  /** 5s jump recomputed for the snapshot from the fv ring. */
  private jump5sNow(): number {
    const now = Date.now()
    const cur = this.fvRing[this.fvRing.length - 1]
    if (!cur) return 0
    let ref: number | undefined
    for (let i = this.fvRing.length - 1; i >= 0; i--) {
      if (this.fvRing[i].t <= now - 5000) {
        ref = this.fvRing[i].v
        break
      }
    }
    return ref == null ? 0 : cur.v - ref
  }

  buildInit(): InitPayload {
    const snap = this.buildSnapshot()
    // decimate history to ≤ 720 pts
    const hist = this.chart
    const step = Math.max(1, Math.ceil(hist.length / 720))
    const history = step === 1 ? [...hist] : hist.filter((_, i) => i % step === 0)
    return {
      snapshot: snap,
      history,
      signals: this.signals.slice(0, 40),
      trades: this.trades.slice(0, 50),
      settings: { ...this.settings },
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
      this.hedge = null
      this.armedPrev = false
      this.episodeFired = false
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
      this.chart = []
      console.log('[engine] stats reset')
    } else if (msg.type === 'settings' && msg.settings) {
      // sanitize: drop null / non-finite numerics so a bad patch can't NaN
      // the hot path
      const patch: Partial<Settings> = {}
      for (const [k, v] of Object.entries(msg.settings)) {
        if (v == null) continue
        if (typeof v === 'number' && !Number.isFinite(v)) continue
        ;(patch as Record<string, unknown>)[k] = v
      }
      this.settings = { ...this.settings, ...patch }
      // clamp the v0.4 knobs to sane ranges
      const s = this.settings
      s.sigmaWImp = Math.min(Math.max(s.sigmaWImp, 0), 1)
      s.sigmaZGate = Math.min(Math.max(s.sigmaZGate, 0.05), 1.5)
      s.sigmaFloorK = Math.min(Math.max(s.sigmaFloorK, 0.1), 2)
      s.sigmaAbsFloor = Math.min(Math.max(s.sigmaAbsFloor, 1), 40)
      s.hedgeRatio = Math.min(Math.max(s.hedgeRatio, 0), 1)
      s.hedgeFeeBps = Math.min(Math.max(s.hedgeFeeBps, 0), 200)
      s.hedgeMinBandBtc = Math.min(Math.max(s.hedgeMinBandBtc, 0.0001), 0.05)
      s.hedgeWinddownS = Math.min(Math.max(s.hedgeWinddownS, 3), 120)
      s.minNetEdgeC = Math.min(Math.max(s.minNetEdgeC, 0), 50)
      s.exitBandC = Math.min(Math.max(s.exitBandC, 0), 30)
      s.minCaptureC = Math.min(Math.max(s.minCaptureC, -1), 90)
      this.syncSigmaCfg()
      console.log('[engine] settings updated', JSON.stringify(patch))
    }
  }
}
