'use client'

import { useXarb, fmtPrice, fmtCents, fmtPnl, fmtCountdown } from '@/lib/xarb'
import { Sigma, ShieldHalf, Crosshair } from 'lucide-react'

function Card({
  title,
  hint,
  children,
  accent,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  accent?: string
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-[#22262e] bg-[#101318] p-3.5">
      {accent ? <div className={`absolute inset-x-0 top-0 h-[2px] ${accent}`} /> : null}
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{title}</span>
        {hint ? <span className="text-[9px] text-zinc-600">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

const big = 'font-mono text-[26px] leading-none font-semibold tabular-nums tracking-tight'
const sub = 'mt-1.5 flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-zinc-500'

function Delta({ v, suffix = '', digits = 1 }: { v: number; suffix?: string; digits?: number }) {
  if (!Number.isFinite(v)) return <span className="text-zinc-600">—</span>
  const cls = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-500'
  return (
    <span className={cls}>
      {v > 0 ? '+' : ''}
      {v.toFixed(digits)}
      {suffix}
    </span>
  )
}

export function StatCards() {
  const price = useXarb((s) => s.snapshot?.binance.price ?? null)
  const bid = useXarb((s) => s.snapshot?.binance.bid ?? 0)
  const ask = useXarb((s) => s.snapshot?.binance.ask ?? 0)
  const change5s = useXarb((s) => s.snapshot?.binance.change5s ?? 0)
  const strike = useXarb((s) => s.snapshot?.window.strike ?? null)
  const strikeEst = useXarb((s) => s.snapshot?.window.strikeEstimated ?? true)
  const secsLeft = useXarb((s) => s.snapshot?.window.secondsLeft ?? 0)
  const question = useXarb((s) => s.snapshot?.window.question ?? '')
  const fv = useXarb((s) => s.snapshot?.fv.value ?? 50)
  const jump5s = useXarb((s) => s.snapshot?.fv.jump5s ?? 0)
  const model = useXarb((s) => s.snapshot?.fv.model ?? 'cdf')
  const dist = useXarb((s) => s.snapshot?.fv.distFromStrike ?? 0)
  const slope = useXarb((s) => s.snapshot?.fv.slope ?? 0)
  const zScore = useXarb((s) => s.snapshot?.fv.z ?? 0)
  const sigmaEffPts = useXarb((s) => s.snapshot?.fv.sigmaEffPts ?? 15.5)
  const pmAsk = useXarb((s) => s.snapshot?.pm.ask ?? null)
  const pmBid = useXarb((s) => s.snapshot?.pm.bid ?? null)
  const askSize = useXarb((s) => s.snapshot?.pm.askSize ?? 0)
  const bookAge = useXarb((s) => s.snapshot?.pm.bookAgeMs ?? 999999)
  const feeBps = useXarb((s) => s.snapshot?.feeds.polymarket.feeRateBps ?? null)
  const edge = useXarb((s) => s.snapshot?.edge.fvAsk ?? null)
  const edgeThresh = useXarb((s) => s.settings.edgeThreshC)
  const pnlTotal = useXarb((s) => s.snapshot?.stats.pnlTotal ?? 0)
  const pnlReal = useXarb((s) => s.snapshot?.stats.pnlRealized ?? 0)
  const pnlUnreal = useXarb((s) => s.snapshot?.stats.pnlUnrealized ?? 0)
  const trades = useXarb((s) => s.snapshot?.stats.trades ?? 0)
  const winRate = useXarb((s) => s.snapshot?.stats.winRate ?? 0)
  const avgEdge = useXarb((s) => s.snapshot?.stats.avgEdgeC ?? 0)
  const sigmaEffModel =
    model === 'cdf'
      ? `Φ(z) · σ_eff ${sigmaEffPts.toFixed(1)} · slope ${slope.toFixed(3)}¢/pt`
      : `52 + slope·(S−K) · slope ${slope.toFixed(3)}¢/pt`

  const edgeCls =
    edge == null ? 'text-zinc-500' : edge >= edgeThresh ? 'text-emerald-400' : edge > 0 ? 'text-emerald-300/70' : 'text-red-400'
  const pnlCls = pnlTotal > 0 ? 'text-emerald-400' : pnlTotal < 0 ? 'text-red-400' : 'text-zinc-400'
  const progress = Math.min(Math.max(secsLeft / 300, 0), 1)

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Card title="BTC spot" hint="Binance live" accent="bg-orange-500/70">
        <div className={`${big} text-orange-300`}>{fmtPrice(price)}</div>
        <div className={sub}>
          <span>
            {fmtPrice(bid, 1)} / {fmtPrice(ask, 1)}
          </span>
          <Delta v={change5s} suffix=" pts" />
        </div>
      </Card>

      <Card title="5m window" hint="UP resolves ≥ strike">
        <div className={`${big} text-zinc-100`}>
          {strike != null ? fmtPrice(strike, 1) : '—'}
          {strikeEst ? <span className="ms-1.5 align-middle text-[9px] font-bold text-amber-400/80">EST</span> : null}
        </div>
        <div className={sub}>
          <span className="text-amber-300">{fmtCountdown(secsLeft)}</span>
          <div className="h-1 flex-1 overflow-hidden rounded bg-[#1a1e25]">
            <div
              className="h-full rounded bg-gradient-to-r from-amber-500 to-amber-300 transition-[width] duration-300"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>
        <div className="mt-1 truncate text-[9px] text-zinc-600" title={question}>
          {question || 'discovering window…'}
        </div>
      </Card>

      <Card title="UP fair value" hint={model === 'linear' ? 'linear spec model' : 'normal-cdf · σ auto-cal'} accent="bg-emerald-500/70">
        <div className={`${big} text-emerald-300`}>{fmtCents(fv)}</div>
        <div className={sub}>
          <span>5sΔ</span>
          <Delta v={jump5s} suffix="¢" />
          <span className="text-zinc-600">K{dist >= 0 ? '+' : ''}{dist.toFixed(0)}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            z {zScore >= 0 ? '+' : ''}{zScore.toFixed(2)}σ · {sigmaEffModel}
          </span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">{model === 'linear' ? 'legacy spec curve' : 'Φ(z) · bounded 1–99¢ · honest tails'}</span>
        </div>
      </Card>

      <Card title="Polymarket UP" hint="CLOB top of book">
        <div className={`${big} text-amber-300`}>{fmtCents(pmAsk)}</div>
        <div className={sub}>
          <span>bid {fmtCents(pmBid)}</span>
          <span>sz {Math.round(askSize)}</span>
          <span className={bookAge > 3000 ? 'text-red-400' : 'text-zinc-500'}>age {bookAge > 99999 ? '—' : `${Math.round(bookAge)}ms`}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">live taker fee {feeBps != null ? `${feeBps} bps` : '—'}</span>
        </div>
      </Card>

      <Card title="Edge · FV − ask" hint={`fires ≥ ${edgeThresh}¢`}>
        <div className={`${big} ${edgeCls}`}>{edge == null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(1)}¢`}</div>
        <div className={sub}>
          <div className="h-1.5 flex-1 overflow-hidden rounded bg-[#1a1e25]">
            <div
              className={`h-full rounded ${edge != null && edge >= edgeThresh ? 'bg-emerald-400' : 'bg-emerald-400/30'}`}
              style={{ width: `${Math.min(Math.max((edge ?? 0) / edgeThresh, 0), 1) * 100}%` }}
            />
          </div>
          <span className="text-zinc-600">{Math.max(0, edgeThresh - (edge ?? 0)).toFixed(1)}¢ to go</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">gap opens when PM reprices slower than Binance</span>
        </div>
      </Card>

      <Card title="Session P&L" hint="paper · hedged">
        <div className={`${big} ${pnlCls}`}>{fmtPnl(pnlTotal)}</div>
        <div className={sub}>
          <span>real {fmtPnl(pnlReal)}</span>
          <span>open {fmtPnl(pnlUnreal)}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            {trades} trades · {winRate.toFixed(0)}% win · avg {avgEdge.toFixed(1)}¢ edge
          </span>
        </div>
      </Card>
    </div>
  )
}

// ─── v0.4 row: σ auto-calibration · δ-hedge · value capture ───────────────────

export function V04Cards() {
  const sigma = useXarb((s) => s.snapshot?.sigma)
  const hedge = useXarb((s) => s.snapshot?.hedge)
  const capture = useXarb((s) => s.snapshot?.capture)
  const netEdge = useXarb((s) => s.snapshot?.edge.net ?? null)
  const minNetEdge = useXarb((s) => s.settings.minNetEdgeC)

  const snapFresh = !!sigma?.effIsSnap
  const snapAge = sigma?.snapAgeMs
  const capRatio =
    capture && capture.edgeSeenC > 1 && capture.fired > 0
      ? Math.min((capture.avgNetEdgeC * capture.fired) / capture.edgeSeenC, 1.5)
      : null

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {/* σ auto-calibration */}
      <Card
        title="σ auto-calibration"
        hint={sigma?.auto ? 'from live PM mids' : 'legacy fixed floor'}
        accent="bg-cyan-500/70"
      >
        <div className="flex items-baseline gap-2">
          <Sigma className="h-4 w-4 text-cyan-400/70" />
          <div className={`${big} text-cyan-300`}>
            {sigma ? sigma.eff.toFixed(1) : '—'}
            <span className="ms-1 text-[10px] font-normal text-zinc-500">pts/√s</span>
          </div>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">imp</span>
          <span className="text-cyan-200/90">{sigma ? sigma.imp.toFixed(1) : '—'}</span>
          <span className="text-zinc-600">real</span>
          <span>{sigma ? sigma.real.toFixed(1) : '—'}</span>
          <span className="text-zinc-600">floor</span>
          <span>{sigma ? sigma.floor.toFixed(1) : '—'}</span>
        </div>
        <div className={sub}>
          {sigma?.auto ? (
            snapFresh ? (
              <span className="font-semibold text-cyan-300">
                SNAP locked · FV tracks PM ({snapAge != null ? `${Math.round(snapAge)}ms` : '—'})
              </span>
            ) : (
              <span className="text-zinc-500">blend + dynamic floor · PM silent → FV floats with Binance</span>
            )
          ) : (
            <span className="text-zinc-500">auto-cal off · legacy clamp of realized σ</span>
          )}
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            samples {sigma ? sigma.accepted : 0}✓ / {sigma ? sigma.rejected : 0}✗ · |Φ⁻¹(mid)| gate rejects unidentifiable mids
          </span>
        </div>
      </Card>

      {/* δ-hedge on Binance */}
      <Card
        title="δ-hedge · Binance"
        hint={hedge?.on ? `ratio ${(hedge.ratio * 100).toFixed(0)}% · ${(hedge.feeBps ?? 0).toFixed(1)}bps` : 'off'}
        accent="bg-fuchsia-500/70"
      >
        <div className="flex items-baseline gap-2">
          <ShieldHalf className="h-4 w-4 text-fuchsia-400/70" />
          <div className={`${big} ${hedge?.active ? 'text-fuchsia-300' : 'text-zinc-500'}`}>
            {hedge?.active ? `${hedge.qtyBtc.toFixed(4)}` : 'FLAT'}
            {hedge?.active ? <span className="ms-1 text-[10px] font-normal text-zinc-500">BTC</span> : null}
          </div>
          {hedge?.winddown && hedge?.active ? (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-bold text-amber-400">
              WIND-DOWN
            </span>
          ) : null}
        </div>
        <div className={sub}>
          <span className="text-zinc-600">target</span>
          <span className="text-fuchsia-200/90">{hedge ? hedge.targetBtc.toFixed(4) : '—'}</span>
          <span className="text-zinc-600">band ±{hedge ? hedge.bandBtc.toFixed(4) : '—'}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">Δ/sh {hedge ? hedge.deltaPerShare.toFixed(4) : '—'} BTC</span>
          <span className={hedge?.active ? 'text-zinc-400' : 'text-zinc-600'}>
            {hedge?.shares ? `${Math.round(hedge.shares)} sh` : ''}
          </span>
        </div>
        <div className={sub}>
          <Delta v={hedge?.pnlUsd ?? 0} suffix=" pnl" digits={2} />
          <span className="text-zinc-600">fees ${hedge ? hedge.feesUsd.toFixed(3) : '0'} · {hedge?.fills ?? 0} fills · W–W band</span>
        </div>
      </Card>

      {/* value capture */}
      <Card title="Value capture" hint="zero engine-miss" accent="bg-emerald-500/70">
        <div className="flex items-baseline gap-2">
          <Crosshair className="h-4 w-4 text-emerald-400/70" />
          <div className={`${big} ${netEdge != null && netEdge >= minNetEdge ? 'text-emerald-300' : 'text-zinc-200'}`}>
            {netEdge != null ? `${netEdge >= 0 ? '+' : ''}${netEdge.toFixed(1)}` : '—'}
            <span className="ms-1 text-[10px] font-normal text-zinc-500">¢ net edge</span>
          </div>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            edge − PM fee − hedge cost · fires ≥ {minNetEdge}¢ — the profit gate
          </span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">opps</span>
          <span className="text-emerald-200/90">{capture?.opportunities ?? 0}</span>
          <span className="text-zinc-600">fired</span>
          <span>{capture?.fired ?? 0}</span>
          <span className="text-zinc-600">gated</span>
          <span className="text-amber-300/90">{capture?.missed ?? 0}</span>
          <span className="text-zinc-600">early exits</span>
          <span className="text-cyan-300/90">{capture?.earlyExits ?? 0}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            edge seen {(capture?.edgeSeenC ?? 0).toFixed(0)}¢ · avg net {capture && capture.fired > 0 ? `${capture.avgNetEdgeC >= 0 ? '+' : ''}${capture.avgNetEdgeC.toFixed(1)}¢` : '—'}
            {capRatio != null ? ` · capture ${(capRatio * 100).toFixed(0)}%` : ''}
          </span>
        </div>
      </Card>
    </div>
  )
}
