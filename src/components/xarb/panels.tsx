'use client'

import { useXarb, fmtCents, fmtUs } from '@/lib/xarb'
import { Activity, BookOpen, Gauge } from 'lucide-react'

function PanelShell({
  icon,
  title,
  hint,
  children,
  className,
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-col rounded-lg border border-[#22262e] bg-[#101318] ${className ?? ''}`}>
      <div className="flex items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">{title}</span>
        {hint ? <span className="ms-auto text-[9px] text-zinc-600">{hint}</span> : null}
      </div>
      <div className="flex-1 p-3.5">{children}</div>
    </div>
  )
}

// ─── trigger conditions ──────────────────────────────────────────────────────

function TriggerRow({
  label,
  value,
  threshold,
  unit,
  armed,
  progress,
}: {
  label: string
  value: string
  threshold: string
  unit: string
  armed: boolean
  progress: number
}) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full border ${
            armed ? 'border-emerald-400 bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse' : 'border-zinc-600 bg-transparent'
          }`}
        />
        <span className={`text-xs font-medium ${armed ? 'text-emerald-300' : 'text-zinc-400'}`}>{label}</span>
        <span className={`ms-auto font-mono text-sm tabular-nums ${armed ? 'text-emerald-300' : 'text-zinc-300'}`}>{value}</span>
        <span className="w-16 text-right font-mono text-[10px] tabular-nums text-zinc-600">
          need {threshold}
          {unit}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded bg-[#171b21]">
        <div
          className={`h-full rounded transition-[width] duration-150 ${armed ? 'bg-emerald-400' : 'bg-zinc-500/50'}`}
          style={{ width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }}
        />
      </div>
    </div>
  )
}

export function TriggerPanel() {
  const jump = useXarb((s) => s.snapshot?.fv.jump5s ?? 0)
  const fv = useXarb((s) => s.snapshot?.fv.value ?? 50)
  const edge = useXarb((s) => s.snapshot?.edge.fvAsk ?? null)
  const trig = useXarb((s) => s.snapshot?.triggers)
  const jumpT = useXarb((s) => s.settings.jumpThreshC)
  const floorT = useXarb((s) => s.settings.fvFloorC)
  const edgeT = useXarb((s) => s.settings.edgeThreshC)
  const running = useXarb((s) => s.snapshot?.running ?? false)

  const armedCount = trig ? [trig.jump, trig.above60, trig.gap].filter(Boolean).length : 0

  return (
    <PanelShell
      icon={<Activity className="h-3.5 w-3.5 text-emerald-400" />}
      title="Trigger conditions"
      hint={running ? 'evaluated on every tick' : 'engine stopped'}
    >
      <div className="divide-y divide-[#181c22]">
        <TriggerRow
          label="① FV jump in 5s"
          value={`${jump >= 0 ? '+' : ''}${jump.toFixed(1)}¢`}
          threshold={`${jumpT}`}
          unit="¢"
          armed={!!trig?.jump}
          progress={jump / jumpT}
        />
        <TriggerRow
          label="② FV above floor"
          value={fmtCents(fv)}
          threshold={`${floorT}`}
          unit="¢"
          armed={!!trig?.above60}
          progress={fv / floorT}
        />
        <TriggerRow
          label="③ Edge vs PM ask"
          value={edge == null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(1)}¢`}
          threshold={`${edgeT}`}
          unit="¢"
          armed={!!trig?.gap}
          progress={(edge ?? 0) / edgeT}
        />
      </div>
      <div
        className={`mt-3 rounded-md border px-3 py-2 text-center text-[11px] font-semibold tracking-wide ${
          trig?.all
            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.15)]'
            : 'border-[#262b33] bg-[#141821] text-zinc-500'
        }`}
      >
        {trig?.all ? (
          <span className="animate-pulse">⚡ ALL 3 TRUE — BUY SIGNAL</span>
        ) : (
          <span>
            waiting · {armedCount}/3 armed
          </span>
        )}
      </div>
    </PanelShell>
  )
}

// ─── order book ladder ───────────────────────────────────────────────────────

const EMPTY_LEVELS: { p: number; s: number }[] = []

export function BookLadder() {
  const asks = useXarb((s) => s.snapshot?.pm.asks ?? EMPTY_LEVELS)
  const bids = useXarb((s) => s.snapshot?.pm.bids ?? EMPTY_LEVELS)
  const ask = useXarb((s) => s.snapshot?.pm.ask ?? null)
  const bid = useXarb((s) => s.snapshot?.pm.bid ?? null)
  const lastPx = useXarb((s) => s.snapshot?.feeds.polymarket.lastTradePx ?? null)
  const status = useXarb((s) => s.snapshot?.feeds.polymarket.status ?? 'connecting')
  const question = useXarb((s) => s.snapshot?.window.tokensLoaded ?? false)

  const maxSize = Math.max(1, ...asks.map((l) => l.s), ...bids.map((l) => l.s))
  const spread = ask != null && bid != null ? ask - bid : null
  const depthUsd = asks.reduce((a, l) => a + (l.p / 100) * l.s, 0)

  const Row = ({ p, s, side }: { p: number; s: number; side: 'ask' | 'bid' }) => (
    <div className="relative flex items-center justify-between px-2 py-[3px] font-mono text-[11px] tabular-nums">
      <div
        className={`absolute inset-y-0 ${side === 'ask' ? 'right-0 bg-red-500/10' : 'right-0 bg-emerald-500/10'}`}
        style={{ width: `${(s / maxSize) * 100}%` }}
      />
      <span className={`relative ${side === 'ask' ? 'text-red-300' : 'text-emerald-300'}`}>{p.toFixed(1)}¢</span>
      <span className="relative text-zinc-500">{s >= 1000 ? `${(s / 1000).toFixed(1)}k` : s.toFixed(0)}</span>
    </div>
  )

  return (
    <PanelShell
      icon={<BookOpen className="h-3.5 w-3.5 text-amber-400" />}
      title="Polymarket CLOB · UP"
      hint={status === 'live' && question ? 'live book' : status}
    >
      {asks.length + bids.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-zinc-600">
          {question ? 'waiting for book events…' : 'discovering window tokens…'}
        </div>
      ) : (
        <div>
          <div className="flex flex-col-reverse gap-0">
            {asks.slice(0, 6).map((l) => (
              <Row key={`a${l.p}`} p={l.p} s={l.s} side="ask" />
            ))}
          </div>
          <div className="my-1.5 flex items-center justify-between rounded border border-[#262b33] bg-[#141821] px-2 py-1.5 font-mono text-[11px] tabular-nums">
            <span className="text-zinc-500">spread {spread != null ? `${spread.toFixed(1)}¢` : '—'}</span>
            <span className="text-zinc-300">{lastPx != null ? `last ${(lastPx * 100).toFixed(1)}¢` : '—'}</span>
          </div>
          <div className="flex flex-col gap-0">
            {bids.slice(0, 6).map((l) => (
              <Row key={`b${l.p}`} p={l.p} s={l.s} side="bid" />
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[9px] text-zinc-600">
            <span>ask depth ≈ ${depthUsd.toFixed(0)}</span>
            <span>fills walk this ladder</span>
          </div>
        </div>
      )}
    </PanelShell>
  )
}

// ─── latency / performance ───────────────────────────────────────────────────

function LatRow({ label, value, note, ok }: { label: string; value: string; note?: string; ok?: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-[#181c22] py-1.5 last:border-0">
      <span className="w-[105px] shrink-0 text-[10px] text-zinc-500">{label}</span>
      <span className="font-mono text-xs tabular-nums text-zinc-200">{value}</span>
      {ok ? (
        <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px font-mono text-[9px] font-bold text-emerald-400">
          sub-ms
        </span>
      ) : null}
      {note ? <span className="ms-auto text-[9px] text-zinc-600">{note}</span> : null}
    </div>
  )
}

export function LatencyPanel() {
  const lat = useXarb((s) => s.snapshot?.latency)
  const bin = useXarb((s) => s.snapshot?.feeds.binance)
  const pm = useXarb((s) => s.snapshot?.feeds.polymarket)
  const decisionSubMs = (lat?.decisionUsP99 ?? 0) > 0 && (lat?.decisionUsP99 ?? 0) < 1000

  return (
    <PanelShell icon={<Gauge className="h-3.5 w-3.5 text-emerald-400" />} title="Latency · measured live">
      <div>
        <LatRow label="binance feed" value={`${bin?.latencyMs ?? 0}ms`} note={`p50 ${lat?.feedP50 ?? 0} · p99 ${lat?.feedP99 ?? 0}ms`} />
        <LatRow label="binance rate" value={`${bin?.ticksPerMin ?? 0} tpm`} note="bookTicker+aggTrade" />
        <LatRow label="engine tick" value={fmtUs(lat?.engineUsP50 ?? 0)} note={`p99 ${fmtUs(lat?.engineUsP99 ?? 0)}`} />
        <LatRow label="decision path" value={fmtUs(lat?.decisionUsP50 ?? 0)} note={`p99 ${fmtUs(lat?.decisionUsP99 ?? 0)}`} ok={decisionSubMs} />
        <LatRow label="pm book updates" value={`${pm?.updates ?? 0}`} note={`status ${pm?.status ?? '—'}`} />
      </div>
      <p className="mt-2.5 text-[9px] leading-relaxed text-zinc-600">
        Local compute (event → signal) runs in microseconds. The network leg to exchanges (~30ms here) is the physical floor —
        latency is spent in fiber, not in this engine.
      </p>
    </PanelShell>
  )
}
