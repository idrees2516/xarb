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
        <span className="truncate text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{title}</span>
        {hint ? <span className="shrink-0 text-[9px] text-zinc-600">{hint}</span> : null}
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
  const focus = useXarb((s) => s.snapshot?.focus)
  const bin = useXarb((s) => s.snapshot?.binance)
  const window = useXarb((s) => s.snapshot?.window)
  const fv = useXarb((s) => s.snapshot?.fv)
  const pm = useXarb((s) => s.snapshot?.pm)
  const edge = useXarb((s) => s.snapshot?.edge)
  const stats = useXarb((s) => s.snapshot?.stats)
  const edgeThresh = useXarb((s) => s.settings.edgeThreshC)
  const sideDown = useXarb((s) => s.snapshot?.sideDown ?? true)
  const marketsLive = useXarb((s) => s.snapshot?.marketsLive ?? 0)
  const marketsTotal = useXarb((s) => s.snapshot?.marketsTotal ?? 0)
  const feedBps = useXarb((s) => s.snapshot?.feeds.polymarket.feeRateBps ?? null)

  const dp = focus?.priceDp ?? 1
  const label = focus?.label ?? 'BTC 5m'
  const price = bin?.price ?? null
  const change5s = bin?.change5s ?? 0
  const secsLeft = window?.secondsLeft ?? 0
  const winSec = focus?.windowSec ?? 300
  const model = fv?.model ?? 'cdf'
  const fvVal = fv?.value ?? 50
  const fvDn = fv?.valueDown ?? 50
  const jump5s = fv?.jump5s ?? 0
  const jump5sDn = fv?.jump5sDown ?? 0
  const zScore = fv?.z ?? 0
  const sigmaEffPts = fv?.sigmaEffPts ?? 15.5
  const sigmaEffBps = fv?.sigmaEffBps ?? 0
  const dist = fv?.distFromStrike ?? 0
  const slope = fv?.slope ?? 0
  const edgeUp = edge?.fvAsk ?? null
  const edgeDn = edge?.dnFvAsk ?? null

  const edgeCls =
    edgeUp == null
      ? 'text-zinc-500'
      : edgeUp >= edgeThresh
        ? 'text-emerald-400'
        : edgeUp > 0
          ? 'text-emerald-300/70'
          : 'text-red-400'
  const pnlCls =
    (stats?.pnlTotal ?? 0) > 0 ? 'text-emerald-400' : (stats?.pnlTotal ?? 0) < 0 ? 'text-red-400' : 'text-zinc-400'
  const progress = Math.min(Math.max(secsLeft / winSec, 0), 1)
  const bestEdge = Math.max(edgeUp ?? -Infinity, edgeDn ?? -Infinity)

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Card title={`${focus?.asset ?? 'BTC'} spot`} hint={`${focus?.binanceSym ?? 'BTCUSDT'} · Binance live`} accent="bg-orange-500/70">
        <div className={`${big} text-orange-300`}>{fmtPrice(price, dp)}</div>
        <div className={sub}>
          <span>
            {fmtPrice(bin?.bid ?? 0, dp)} / {fmtPrice(bin?.ask ?? 0, dp)}
          </span>
          <Delta v={change5s} suffix=" pts" digits={dp} />
        </div>
        <div className={sub}>
          <span className="text-zinc-600">focus market: {label}</span>
        </div>
      </Card>

      <Card title="window" hint={`${label} · UP resolves ≥ strike`}>
        <div className={`${big} text-zinc-100`}>
          {window?.strike != null ? fmtPrice(window.strike, dp) : '—'}
          {window?.strikeEstimated ? (
            <span className="ms-1.5 align-middle text-[9px] font-bold text-amber-400/80">EST</span>
          ) : null}
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
        <div className="mt-1 truncate text-[9px] text-zinc-600" title={window?.question ?? ''}>
          {window?.question || 'discovering window…'}
        </div>
      </Card>

      <Card
        title="fair value up / dn"
        hint={model === 'linear' ? 'linear spec model' : 'normal-cdf · σ auto-cal'}
        accent="bg-emerald-500/70"
      >
        <div className="flex items-baseline gap-2">
          <div className={`${big} ${fvVal >= 60 ? 'text-emerald-300' : 'text-emerald-300/80'}`}>{fmtCents(fvVal)}</div>
          <div className={`${big} text-zinc-500`}>{fmtCents(fvDn)}</div>
        </div>
        <div className={sub}>
          <span>5sΔ</span>
          <Delta v={jump5s} suffix="¢" />
          <span className="text-zinc-600">dn</span>
          <Delta v={jump5sDn} suffix="¢" />
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            z {zScore >= 0 ? '+' : ''}
            {zScore.toFixed(2)}σ · σ_eff {sigmaEffBps.toFixed(1)}bp/√s · slope {slope.toFixed(3)}¢/pt
          </span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            {model === 'linear' ? 'legacy spec curve' : 'Φ(z) both sides · bounded 1–99¢'}
          </span>
        </div>
      </Card>

      <Card title="Polymarket up / dn" hint="CLOB top of book">
        <div className="flex items-baseline gap-2">
          <div className={`${big} text-amber-300`}>{fmtCents(pm?.ask)}</div>
          <div className={`${big} text-amber-300/50`}>{fmtCents(pm?.dnAsk)}</div>
        </div>
        <div className={sub}>
          <span>bid {fmtCents(pm?.bid)}</span>
          <span>dn bid {fmtCents(pm?.dnBid)}</span>
          <span>sz {Math.round(pm?.askSize ?? 0)}</span>
          <span className={(pm?.bookAgeMs ?? 9e9) > 3000 ? 'text-red-400' : 'text-zinc-500'}>
            age {pm && pm.bookAgeMs > 99999 ? '—' : `${Math.round(pm?.bookAgeMs ?? 0)}ms`}
          </span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">live taker fee {feedBps != null ? `${feedBps} bps` : '—'} · both tokens subscribed</span>
        </div>
      </Card>

      <Card title="Edge · FV − ask" hint={`fires ≥ ${edgeThresh}¢ · best side`}>
        <div className={`${big} ${bestEdge === edgeDn && sideDown ? 'text-cyan-300' : edgeCls}`}>
          {bestEdge === -Infinity ? '—' : `${bestEdge >= 0 ? '+' : ''}${bestEdge.toFixed(1)}¢`}
        </div>
        <div className={sub}>
          <span>up {edgeUp == null ? '—' : fmtCents(edgeUp)}</span>
          <span className="text-zinc-600">dn</span>
          <span className={sideDown ? 'text-zinc-400' : 'text-zinc-600 line-through'}>
            {edgeDn == null ? '—' : fmtCents(edgeDn)}
          </span>
        </div>
        <div className={sub}>
          <div className="h-1.5 flex-1 overflow-hidden rounded bg-[#1a1e25]">
            <div
              className={`h-full rounded ${bestEdge >= edgeThresh ? 'bg-emerald-400' : 'bg-emerald-400/30'}`}
              style={{ width: `${Math.min(Math.max(bestEdge / edgeThresh, 0), 1) * 100}%` }}
            />
          </div>
          <span className="text-zinc-600">{Math.max(0, edgeThresh - bestEdge).toFixed(1)}¢ to go</span>
        </div>
      </Card>

      <Card title="Session P&L" hint={`paper · all ${marketsLive}/${marketsTotal} markets`}>
        <div className={`${big} ${pnlCls}`}>{fmtPnl(stats?.pnlTotal ?? 0)}</div>
        <div className={sub}>
          <span>real {fmtPnl(stats?.pnlRealized ?? 0)}</span>
          <span>open {fmtPnl(stats?.pnlUnrealized ?? 0)}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            {stats?.trades ?? 0} trades · {(stats?.winRate ?? 0).toFixed(0)}% win · avg {(stats?.avgEdgeC ?? 0).toFixed(1)}¢ edge
          </span>
        </div>
      </Card>
    </div>
  )
}

// ─── v0.4/v0.5 row: σ auto-calibration · δ-hedge · value capture ──────────────

export function V04Cards() {
  const sigma = useXarb((s) => s.snapshot?.sigma)
  const hedge = useXarb((s) => s.snapshot?.hedge)
  const capture = useXarb((s) => s.snapshot?.capture)
  const netEdge = useXarb((s) => s.snapshot?.edge.net ?? null)
  const minNetEdge = useXarb((s) => s.settings.minNetEdgeC)
  const focus = useXarb((s) => s.snapshot?.focus)
  const marketsLive = useXarb((s) => s.snapshot?.marketsLive ?? 0)
  const spot = useXarb((s) => s.snapshot?.binance.price ?? 0)

  const asset = hedge?.asset ?? focus?.asset ?? 'BTC'
  const snapFresh = !!sigma?.effIsSnap
  const snapAge = sigma?.snapAgeMs
  const capRatio =
    capture && capture.edgeSeenC > 1 && capture.fired > 0
      ? Math.min((capture.avgNetEdgeC * capture.fired) / capture.edgeSeenC, 1.5)
      : null
  const sigmaBps = sigma && spot > 0 ? (sigma.eff / spot) * 1e4 : null

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {/* σ auto-calibration */}
      <Card
        title="σ auto-calibration"
        hint={sigma?.auto ? `from live PM mids · ${focus?.label ?? ''}` : 'legacy fixed floor'}
        accent="bg-cyan-500/70"
      >
        <div className="flex items-baseline gap-2">
          <Sigma className="h-4 w-4 text-cyan-400/70" />
          <div className={`${big} text-cyan-300`}>
            {sigma ? sigma.eff.toFixed(2) : '—'}
            <span className="ms-1 text-[10px] font-normal text-zinc-500">pts/√s</span>
          </div>
          {sigmaBps != null ? (
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">{sigmaBps.toFixed(1)} bp/√s</span>
          ) : null}
        </div>
        <div className={sub}>
          <span className="text-zinc-600">imp</span>
          <span className="text-cyan-200/90">{sigma ? sigma.imp.toFixed(2) : '—'}</span>
          <span className="text-zinc-600">real</span>
          <span>{sigma ? sigma.real.toFixed(2) : '—'}</span>
          <span className="text-zinc-600">floor</span>
          <span>{sigma ? sigma.floor.toFixed(2) : '—'}</span>
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
            {hedge?.active ? `${hedge.qtyBtc}` : 'FLAT'}
            {hedge?.active ? <span className="ms-1 text-[10px] font-normal text-zinc-500">{asset}</span> : null}
          </div>
          {hedge?.winddown && hedge?.active ? (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-bold text-amber-400">
              WIND-DOWN
            </span>
          ) : null}
        </div>
        <div className={sub}>
          <span className="text-zinc-600">target</span>
          <span className="text-fuchsia-200/90">{hedge ? hedge.targetBtc : '—'}</span>
          <span className="text-zinc-600">band ±{hedge ? hedge.bandBtc : '—'}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">Δ/sh {hedge ? hedge.deltaPerShare.toFixed(5) : '—'} {asset}</span>
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
      <Card title="Value capture" hint="zero engine-miss · whole universe" accent="bg-emerald-500/70">
        <div className="flex items-baseline gap-2">
          <Crosshair className="h-4 w-4 text-emerald-400/70" />
          <div className={`${big} ${netEdge != null && netEdge >= minNetEdge ? 'text-emerald-300' : 'text-zinc-200'}`}>
            {netEdge != null ? `${netEdge >= 0 ? '+' : ''}${netEdge.toFixed(1)}` : '—'}
            <span className="ms-1 text-[10px] font-normal text-zinc-500">¢ net edge</span>
          </div>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            edge − PM fee − hedge cost · fires ≥ {minNetEdge}¢ — the profit gate ({focus?.label ?? ''})
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
            {marketsLive} markets · edge seen {(capture?.edgeSeenC ?? 0).toFixed(0)}¢ · avg net{' '}
            {capture && capture.fired > 0
              ? `${capture.avgNetEdgeC >= 0 ? '+' : ''}${capture.avgNetEdgeC.toFixed(1)}¢`
              : '—'}
            {capRatio != null ? ` · capture ${(capRatio * 100).toFixed(0)}%` : ''}
          </span>
        </div>
      </Card>
    </div>
  )
}
