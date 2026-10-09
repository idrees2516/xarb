'use client'

import { useXarb, fmtPrice, fmtCents, fmtPnl, fmtCountdown } from '@/lib/xarb'

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
  const model = useXarb((s) => s.snapshot?.fv.model ?? 'linear')
  const dist = useXarb((s) => s.snapshot?.fv.distFromStrike ?? 0)
  const slope = useXarb((s) => s.snapshot?.fv.slope ?? 0)
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

      <Card title="UP fair value" hint={model === 'linear' ? 'linear spec model' : 'normal-cdf model'} accent="bg-emerald-500/70">
        <div className={`${big} text-emerald-300`}>{fmtCents(fv)}</div>
        <div className={sub}>
          <span>5sΔ</span>
          <Delta v={jump5s} suffix="¢" />
          <span className="text-zinc-600">K{dist >= 0 ? '+' : ''}{dist.toFixed(0)}</span>
        </div>
        <div className={sub}>
          <span className="text-zinc-600">
            slope {slope.toFixed(3)}¢/pt · {model === 'linear' ? '52 + slope·(S−K)' : 'Φ((S−K)/σ√T)'}
          </span>
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

      <Card title="Session P&L" hint="paper">
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
