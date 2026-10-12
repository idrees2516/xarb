'use client'

import { useXarb, fmtCents, fmtUs } from '@/lib/xarb'
import { Activity, BookOpen, Gauge, ArrowUp, ArrowDown } from 'lucide-react'

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

// ─── trigger conditions (both sides of the focus market) ────────────────────

function TriggerRow({
  label,
  value,
  threshold,
  unit,
  armed,
  progress,
  dim,
}: {
  label: string
  value: string
  threshold: string
  unit: string
  armed: boolean
  progress: number
  dim?: boolean
}) {
  return (
    <div className={`py-1.5 ${dim ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full border ${
            armed
              ? 'border-emerald-400 bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse'
              : 'border-zinc-600 bg-transparent'
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

function SideHeader({ side, live }: { side: 'UP' | 'DOWN'; live: boolean }) {
  const up = side === 'UP'
  return (
    <div className="flex items-center gap-1.5 pb-1 pt-1">
      {up ? <ArrowUp className="h-3 w-3 text-emerald-400" /> : <ArrowDown className="h-3 w-3 text-red-400" />}
      <span className={`text-[10px] font-bold tracking-widest ${up ? 'text-emerald-300' : 'text-red-300'}`}>
        {side} SIDE
      </span>
      {up ? null : live ? (
        <span className="rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[8px] font-bold text-red-300">
          MIRRORED TRIGGER SET
        </span>
      ) : (
        <span className="rounded border border-zinc-600/40 bg-zinc-500/10 px-1 py-px text-[8px] font-bold text-zinc-500">
          FIRING OFF (setting)
        </span>
      )}
    </div>
  )
}

export function TriggerPanel() {
  const focus = useXarb((s) => s.snapshot?.focus)
  const fv = useXarb((s) => s.snapshot?.fv)
  const edge = useXarb((s) => s.snapshot?.edge)
  const trig = useXarb((s) => s.snapshot?.triggers)
  const dnTrig = useXarb((s) => s.snapshot?.dnTriggers)
  const jumpT = useXarb((s) => s.settings.jumpThreshC)
  const floorT = useXarb((s) => s.settings.fvFloorC)
  const edgeT = useXarb((s) => s.settings.edgeThreshC)
  const netT = useXarb((s) => s.settings.minNetEdgeC)
  const sideDown = useXarb((s) => s.snapshot?.sideDown ?? true)
  const running = useXarb((s) => s.snapshot?.running ?? false)

  const net = edge?.net ?? null
  const dnNet = edge?.dnNet ?? null
  const jump = fv?.jump5s ?? 0
  const jumpDn = fv?.jump5sDown ?? 0
  const fvUp = fv?.value ?? 50
  const fvDn = fv?.valueDown ?? 50
  const edgeUp = edge?.fvAsk ?? null
  const edgeDn = edge?.dnFvAsk ?? null

  const armedCount = trig ? [trig.jump, trig.above60, trig.gap].filter(Boolean).length : 0
  const dnArmedCount = dnTrig ? [dnTrig.jump, dnTrig.above60, dnTrig.gap].filter(Boolean).length : 0
  const fireUp = !!trig?.all && !!trig?.net
  const fireDn = sideDown && !!dnTrig?.all && !!dnTrig?.net

  return (
    <PanelShell
      icon={<Activity className="h-3.5 w-3.5 text-emerald-400" />}
      title={`Trigger conditions · ${focus?.label ?? '—'}`}
      hint={running ? 'both sides · every tick' : 'engine stopped'}
    >
      <div className="divide-y divide-[#181c22]">
        <SideHeader side="UP" live />
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
          value={fmtCents(fvUp)}
          threshold={`${floorT}`}
          unit="¢"
          armed={!!trig?.above60}
          progress={fvUp / floorT}
        />
        <TriggerRow
          label="③ Edge vs PM ask"
          value={edgeUp == null ? '—' : `${edgeUp >= 0 ? '+' : ''}${edgeUp.toFixed(1)}¢`}
          threshold={`${edgeT}`}
          unit="¢"
          armed={!!trig?.gap}
          progress={(edgeUp ?? 0) / edgeT}
        />
        <TriggerRow
          label="④ Net edge after costs"
          value={net == null ? '—' : `${net >= 0 ? '+' : ''}${net.toFixed(1)}¢`}
          threshold={`${netT}`}
          unit="¢"
          armed={!!trig?.net}
          progress={(net ?? 0) / netT}
        />
        <SideHeader side="DOWN" live={sideDown} />
        <TriggerRow
          label="① FV jump in 5s"
          value={`${jumpDn >= 0 ? '+' : ''}${jumpDn.toFixed(1)}¢`}
          threshold={`${jumpT}`}
          unit="¢"
          armed={!!dnTrig?.jump}
          progress={jumpDn / jumpT}
          dim={!sideDown}
        />
        <TriggerRow
          label="② FV above floor"
          value={fmtCents(fvDn)}
          threshold={`${floorT}`}
          unit="¢"
          armed={!!dnTrig?.above60}
          progress={fvDn / floorT}
          dim={!sideDown}
        />
        <TriggerRow
          label="③ Edge vs PM ask"
          value={edgeDn == null ? '—' : `${edgeDn >= 0 ? '+' : ''}${edgeDn.toFixed(1)}¢`}
          threshold={`${edgeT}`}
          unit="¢"
          armed={!!dnTrig?.gap}
          progress={(edgeDn ?? 0) / edgeT}
          dim={!sideDown}
        />
        <TriggerRow
          label="④ Net edge after costs"
          value={dnNet == null ? '—' : `${dnNet >= 0 ? '+' : ''}${dnNet.toFixed(1)}¢`}
          threshold={`${netT}`}
          unit="¢"
          armed={!!dnTrig?.net}
          progress={(dnNet ?? 0) / netT}
          dim={!sideDown}
        />
        <div className="pb-1 pt-1 font-mono text-[9px] leading-relaxed text-zinc-600">
          ④ = ③ − PM fee {(edge?.feeC ?? 0).toFixed(1)}¢ − hedge cost {(edge?.hedgeCostC ?? 0).toFixed(1)}¢ — fires only
          when the mispricing is profitable AFTER all modeled costs. DOWN rows mirror the same trigger set on the DOWN
          token (FV jump down, FV&gt;floor, ask under FV).
        </div>
      </div>
      <div
        className={`mt-3 rounded-md border px-3 py-2 text-center text-[11px] font-semibold tracking-wide ${
          fireUp || fireDn
            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.15)]'
            : trig?.all || dnTrig?.all
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              : 'border-[#262b33] bg-[#141821] text-zinc-500'
        }`}
      >
        {fireUp || fireDn ? (
          <span className="animate-pulse">
            ⚡ {fireUp ? 'UP' : ''}${fireUp && fireDn ? ' + ' : ''}${fireDn ? 'DOWN' : ''} — PROFITABLE FIRE
          </span>
        ) : trig?.all || dnTrig?.all ? (
          <span className="animate-pulse text-amber-300">
            ⚡ {trig?.all ? 'UP' : ''}${trig?.all && dnTrig?.all ? ' + ' : ''}${dnTrig?.all ? 'DOWN' : ''} armed · gated
            by costs (net {Math.max(net ?? -99, dnNet ?? -99).toFixed(1)}¢ &lt; {netT}¢)
          </span>
        ) : (
          <span>
            waiting · UP {armedCount}/3 armed · DOWN {dnArmedCount}/3 armed
          </span>
        )}
      </div>
    </PanelShell>
  )
}

// ─── order book ladder (focus market · UP ladder + DOWN top) ────────────────

const EMPTY_LEVELS: { p: number; s: number }[] = []

export function BookLadder() {
  const asks = useXarb((s) => s.snapshot?.pm.asks ?? EMPTY_LEVELS)
  const bids = useXarb((s) => s.snapshot?.pm.bids ?? EMPTY_LEVELS)
  const ask = useXarb((s) => s.snapshot?.pm.ask ?? null)
  const bid = useXarb((s) => s.snapshot?.pm.bid ?? null)
  const dnAsk = useXarb((s) => s.snapshot?.pm.dnAsk ?? null)
  const dnBid = useXarb((s) => s.snapshot?.pm.dnBid ?? null)
  const dnAskSize = useXarb((s) => s.snapshot?.pm.dnAskSize ?? 0)
  const focus = useXarb((s) => s.snapshot?.focus)
  const lastPx = useXarb((s) => s.snapshot?.feeds.polymarket.lastTradePx ?? null)
  const status = useXarb((s) => s.snapshot?.feeds.polymarket.status ?? 'connecting')
  const loaded = useXarb((s) => s.snapshot?.window.tokensLoaded ?? false)
  const fvUp = useXarb((s) => s.snapshot?.fv.value ?? 50)

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
      title={`Polymarket CLOB · ${focus?.label ?? ''}`}
      hint={status === 'live' && loaded ? 'UP + DOWN tokens live' : status}
    >
      {asks.length + bids.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-zinc-600">
          {loaded ? 'waiting for book events…' : 'discovering window tokens…'}
        </div>
      ) : (
        <div>
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <div className="rounded border border-emerald-500/25 bg-emerald-500/[0.04] px-2 py-1.5 font-mono text-[10px] tabular-nums">
              <div className="mb-0.5 text-[8px] font-bold tracking-widest text-emerald-400/80">UP TOKEN</div>
              <div className="flex justify-between">
                <span className="text-red-300">{fmtCents(ask)}</span>
                <span className="text-emerald-300">{fmtCents(bid)}</span>
              </div>
              <div className="mt-0.5 text-right text-[8px] text-zinc-600">FV {fmtCents(fvUp)}</div>
            </div>
            <div className="rounded border border-red-500/25 bg-red-500/[0.04] px-2 py-1.5 font-mono text-[10px] tabular-nums">
              <div className="mb-0.5 text-[8px] font-bold tracking-widest text-red-400/80">DOWN TOKEN</div>
              <div className="flex justify-between">
                <span className="text-red-300">{fmtCents(dnAsk)}</span>
                <span className="text-emerald-300">{fmtCents(dnBid)}</span>
              </div>
              <div className="mt-0.5 text-right text-[8px] text-zinc-600">
                sz {Math.round(dnAskSize)} · FV {fmtCents(100 - fvUp)}
              </div>
            </div>
          </div>
          <div className="flex flex-col-reverse gap-0">
            {asks.slice(0, 5).map((l) => (
              <Row key={`a${l.p}`} p={l.p} s={l.s} side="ask" />
            ))}
          </div>
          <div className="my-1.5 flex items-center justify-between rounded border border-[#262b33] bg-[#141821] px-2 py-1.5 font-mono text-[11px] tabular-nums">
            <span className="text-zinc-500">spread {spread != null ? `${spread.toFixed(1)}¢` : '—'}</span>
            <span className="text-zinc-300">{lastPx != null ? `last ${(lastPx * 100).toFixed(1)}¢` : '—'}</span>
          </div>
          <div className="flex flex-col gap-0">
            {bids.slice(0, 5).map((l) => (
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
  const marketsLive = useXarb((s) => s.snapshot?.marketsLive ?? 0)
  const marketsTotal = useXarb((s) => s.snapshot?.marketsTotal ?? 0)
  const decisionSubMs = (lat?.decisionUsP99 ?? 0) > 0 && (lat?.decisionUsP99 ?? 0) < 1000

  return (
    <PanelShell icon={<Gauge className="h-3.5 w-3.5 text-emerald-400" />} title="Latency · measured live">
      <div>
        <LatRow
          label="binance feed"
          value={`${bin?.latencyMs ?? 0}ms`}
          note={`p50 ${lat?.feedP50 ?? 0} · p99 ${lat?.feedP99 ?? 0}ms`}
        />
        <LatRow
          label="binance rate"
          value={`${bin?.ticksPerMin ?? 0} tpm`}
          note={`${bin?.symbols ?? 0} symbols combined WS`}
        />
        <LatRow label="engine tick" value={fmtUs(lat?.engineUsP50 ?? 0)} note={`p99 ${fmtUs(lat?.engineUsP99 ?? 0)}`} />
        <LatRow
          label="decision path"
          value={fmtUs(lat?.decisionUsP50 ?? 0)}
          note={`p99 ${fmtUs(lat?.decisionUsP99 ?? 0)}`}
          ok={decisionSubMs}
        />
        <LatRow
          label="pm sockets"
          value={`${pm?.sockets ?? 0} live`}
          note={`${pm?.updates ?? 0} updates · ${pm?.status ?? '—'}`}
        />
        <LatRow label="universe" value={`${marketsLive}/${marketsTotal} live`} note="both sides evaluated" />
      </div>
      <p className="mt-2.5 text-[9px] leading-relaxed text-zinc-600">
        One combined Binance socket feeds every symbol; each market owns a PM socket with both tokens. Local compute
        (event → signal) runs in microseconds — the network leg (~30ms) is the physical floor.
      </p>
    </PanelShell>
  )
}
