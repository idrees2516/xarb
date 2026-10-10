'use client'

import { useXarb, fmtCents, fmtPnl, fmtClock } from '@/lib/xarb'
import { ListTree, ReceiptText } from 'lucide-react'

const ACTION_STYLE: Record<string, string> = {
  EXECUTED: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
  SKIPPED: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  WATCH: 'border-zinc-600/50 bg-zinc-500/10 text-zinc-400',
}

export function SignalFeed() {
  const signals = useXarb((s) => s.signals)

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-[#22262e] bg-[#101318]">
      <div className="flex items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5">
        <ListTree className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">Signal feed</span>
        <span className="ms-auto font-mono text-[9px] tabular-nums text-zinc-600">{signals.length} events</span>
      </div>
      <div className="xarb-scroll max-h-[340px] min-h-0 flex-1 overflow-y-auto p-2">
        {signals.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-zinc-600">
            scanning · waiting for the first trigger event…
          </div>
        ) : (
          <div className="space-y-1">
            {signals.map((s) => (
              <div
                key={s.id}
                className="rounded border border-[#1c2027] bg-[#12151b] px-2.5 py-2 transition-colors hover:border-[#2a3038]"
              >
                <div className="flex items-center gap-2">
                  <span className={`rounded border px-1.5 py-px text-[9px] font-bold tracking-wider ${ACTION_STYLE[s.action]}`}>
                    {s.action}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-zinc-500">{fmtClock(s.ts)}</span>
                  <span className="ms-auto font-mono text-[10px] tabular-nums text-zinc-500">
                    t−{Math.max(0, s.secondsLeft).toFixed(0)}s
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums">
                  <span className="text-zinc-300">FV {fmtCents(s.fv)}</span>
                  <span className="text-amber-300/80">ask {fmtCents(s.ask)}</span>
                  <span className={s.edge != null && s.edge > 0 ? 'text-emerald-400' : 'text-zinc-500'}>
                    edge {s.edge != null ? `${s.edge >= 0 ? '+' : ''}${s.edge.toFixed(1)}¢` : '—'}
                  </span>
                  <span className="text-zinc-500">jump {s.jump5s >= 0 ? '+' : ''}{s.jump5s.toFixed(1)}¢</span>
                  {s.action === 'EXECUTED' && s.fillPrice != null ? (
                    <span className="text-emerald-300">
                      filled {s.fillPrice.toFixed(1)}¢ × {Math.round(s.shares ?? 0)}sh
                    </span>
                  ) : null}
                </div>
                {s.reason ? <div className="mt-0.5 text-[10px] text-zinc-600">{s.reason}</div> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function TradeBlotter() {
  const trades = useXarb((s) => s.trades)
  const staked = useXarb((s) => s.snapshot?.stats.stakedUsd ?? 0)
  const open = useXarb((s) => s.snapshot?.stats.open ?? 0)

  const STATUS_STYLE: Record<string, string> = {
    OPEN: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300',
    WON: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    LOST: 'border-red-500/50 bg-red-500/15 text-red-300',
  }

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-[#22262e] bg-[#101318]">
      <div className="flex items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5">
        <ReceiptText className="h-3.5 w-3.5 text-amber-400" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">Trade blotter</span>
        <span className="ms-auto font-mono text-[9px] tabular-nums text-zinc-600">
          {trades.length} fills · {open} open · ${staked.toFixed(0)} staked
        </span>
      </div>
      <div className="xarb-scroll max-h-[340px] min-h-0 flex-1 overflow-auto">
        {trades.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-zinc-600">
            no fills yet · entries appear when all 3 triggers fire
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-[#101318]">
              <tr className="text-[9px] uppercase tracking-wider text-zinc-600">
                <th className="px-3 py-1.5 font-medium">time</th>
                <th className="px-2 py-1.5 font-medium">fill</th>
                <th className="px-2 py-1.5 text-right font-medium">shares</th>
                <th className="px-2 py-1.5 text-right font-medium">cost</th>
                <th className="px-2 py-1.5 text-center font-medium">status</th>
                <th className="px-3 py-1.5 text-right font-medium">p&amp;l</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-[#181c22] font-mono text-[11px] tabular-nums hover:bg-[#141821]">
                  <td className="px-3 py-1.5 text-zinc-500">{fmtClock(t.ts)}</td>
                  <td className="px-2 py-1.5 text-zinc-200">{t.priceC.toFixed(1)}¢</td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">{Math.round(t.shares)}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">${t.costUsd.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-center">
                    <span
                      className={`rounded border px-1.5 py-px text-[9px] font-bold tracking-wider ${STATUS_STYLE[t.status]} ${
                        t.status === 'OPEN' ? 'animate-pulse' : ''
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right ${
                      t.pnlUsd == null ? 'text-zinc-600' : t.pnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {t.pnlUsd == null ? 'open' : fmtPnl(t.pnlUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
