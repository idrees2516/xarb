// ─── XARB engine core ─────────────────────────────────────────────────────────
// Binance mid → UP fair value → trigger (5s jump ≥20¢ ∧ FV>60¢ ∧ gap ≥10¢)
// → paper-fill by walking the live Polymarket CLOB ask ladder → settle at close.

import { BinanceFeed } from './binance'
import { PolymarketFeed } from './polymarket'
import { fvLinear, fvCdf, fvCdfDetail, sigmaEff, percentile } from './fairvalue'
import {
  DEFAULT_SETTINGS,
  type ChartPoint,
  type ControlMsg,
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

  start(): void {
    this.bin.onPrice = () => this.onMarketEvent()
    this.bin.onTrade = () => this.onMarketEvent()
    this.pm.onBook = () => this.onMarketEvent()
    this.bin.connect()
    this.pm.start()
    this.initWindow()
    setInterval(() => this.tick(), 100)
    console.log('[engine] started (paper mode, auto-trade ON)')
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
        const won = finalPrice >= t.strike
        t.status = won ? 'WON' : 'LOST'
        t.finalPrice = finalPrice
        t.pnlUsd = won ? t.shares * 1 - t.costUsd - t.feeUsd : -t.costUsd - t.feeUsd
        this.stats.pnlRealized += t.pnlUsd
        if (won) this.stats.wins++
        else this.stats.losses++
        console.log(
          `[settle] ${t.id} ${t.status} final=${finalPrice.toFixed(1)} strike=${t.strike.toFixed(1)} pnl=${t.pnlUsd.toFixed(2)}`
        )
        this.onSettle?.(t)
      }
    }
  }

  // ── hot path: recompute on every Binance/Polymarket event ──────────────────

  private onMarketEvent(): void {
    if (!this.running) return
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

    // fair value
    let fv: number
    if (this.settings.model === 'cdf') {
      fv = fvCdf(price, win.strike, tSec, this.bin.volPts)
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
    const book = this.pm.getBook()
    const askC = book.ask
    const gapC = askC != null ? fv - askC : null
    const fresh = book.bookAgeMs < this.settings.maxBookAgeMs

    const jumpOK = jump >= this.settings.jumpThreshC
    const floorOK = fv > this.settings.fvFloorC
    const gapOK = gapC != null && fresh && gapC >= this.settings.edgeThreshC
    const all = jumpOK && floorOK && gapOK
    this.trig = { jump: jumpOK, above60: floorOK, gap: gapOK, all }

    if (all) {
      this.tryFire(fv, jump, askC!, gapC!, tSec, book.askSize)
    } else {
      this.logWatchOrSkip(fv, jump, gapC, jumpOK, floorOK, tSec)
    }
  }

  private tryFire(
    fv: number,
    jump: number,
    askC: number,
    gapC: number,
    tSec: number,
    askSize: number
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
    const fee = (cost * this.settings.takerFeeBps) / 10000

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
      reason: `edge ${gapC.toFixed(1)}¢ · filled ${Math.round(shares)} sh @ ${avgC.toFixed(1)}¢`,
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
    console.log(
      `[SIGNAL] ${id} fv=${fv.toFixed(1)}¢ ask=${askC.toFixed(1)}¢ edge=${gapC.toFixed(1)}¢ jump=${jump.toFixed(1)}¢ fill=${avgC.toFixed(1)}¢`
    )
    this.onSignal?.(signal)
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

  // ── 10Hz loop: rollover, chart, snapshot ────────────────────────────────────

  private tick(): void {
    const t0 = performance.now()
    const now = Date.now()

    this.bin.sampleRate()

    // window rollover
    const win = this.win
    if (win && now >= win.endEpoch * 1000 + 200) {
      this.settleWindow()
      void this.loadWindow(win.endEpoch, false)
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
    // FV detail: slope is the ACTIVE model's local slope (¢/pt); z/sd from the CDF.
    let slope = 0.19
    let z = 0
    if (win?.strike != null) {
      const t = Math.max(tSec, 1)
      if (this.settings.model === 'cdf') {
        const d = fvCdfDetail(price, win.strike, t, this.bin.volPts)
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
    const settled = this.stats.wins + this.stats.losses
    const edgeFvAsk = book.ask != null ? this.lastFv - book.ask : null

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
        sigmaEffPts: sigmaEff(this.bin.volPts),
        z,
        slope,
        distFromStrike: dist,
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
      edge: { fvAsk: edgeFvAsk, fvMid: book.bid != null ? this.lastFv - (book.ask! + book.bid) / 2 : null },
      triggers: { ...this.trig },
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
      this.settings = { ...this.settings, ...msg.settings }
      console.log('[engine] settings updated', JSON.stringify(msg.settings))
    }
  }
}
