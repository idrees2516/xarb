'use client'

import { Zap, Settings2, Play, Square, Radio } from 'lucide-react'
import { useXarb, fmtCountdown, fmtPrice } from '@/lib/xarb'
import { sendControl } from '@/lib/xarb'
import { SettingsSheet } from './settings-sheet'

function statusColor(s: string): string {
  if (s === 'live') return 'bg-emerald-400'
  if (s === 'connecting') return 'bg-amber-400'
  if (s === 'degraded') return 'bg-amber-400'
  return 'bg-red-500'
}

function FeedBadge({ label, status, extra }: { label: string; status: string; extra?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[#262b33] bg-[#12151b] px-2 py-1 text-[10px] font-medium tracking-wide text-zinc-300">
      <span className={`h-1.5 w-1.5 rounded-full ${statusColor(status)} ${status === 'live' ? 'animate-pulse' : ''}`} />
      {label}
      {extra ? <span className="font-mono text-zinc-500">{extra}</span> : null}
    </span>
  )
}

export function Header() {
  const connected = useXarb((s) => s.connected)
  const binStatus = useXarb((s) => s.snapshot?.feeds.binance.status ?? 'connecting')
  const binLat = useXarb((s) => s.snapshot?.feeds.binance.latencyMs ?? 0)
  const pmStatus = useXarb((s) => s.snapshot?.feeds.polymarket.status ?? 'connecting')
  const running = useXarb((s) => s.snapshot?.running ?? false)
  const secsLeft = useXarb((s) => s.snapshot?.window.secondsLeft ?? 0)
  const strike = useXarb((s) => s.snapshot?.window.strike ?? null)

  return (
    <header className="sticky top-0 z-20 border-b border-[#1e222a] bg-[#0b0d11]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5">
        {/* brand */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_14px_rgba(16,185,129,0.35)]">
            <Zap className="h-4.5 w-4.5 text-black" strokeWidth={2.5} />
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-wider text-zinc-100">XARB</span>
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-amber-400">
                PAPER
              </span>
            </div>
            <div className="hidden text-[10px] text-zinc-500 sm:block">
              Binance BTC → Polymarket 5m UP/DOWN · latency arbitrage terminal
            </div>
          </div>
        </div>

        {/* feed badges */}
        <div className="flex flex-wrap items-center gap-1.5">
          <FeedBadge label="BINANCE" status={binStatus} extra={binLat ? `${binLat}ms` : undefined} />
          <FeedBadge label="POLYMARKET" status={pmStatus} />
          <FeedBadge
            label="ENGINE"
            status={running ? 'live' : 'down'}
            extra={running ? 'running' : 'stopped'}
          />
          <FeedBadge label="WS" status={connected ? 'live' : 'down'} />
        </div>

        <div className="ms-auto flex items-center gap-2">
          {/* window chip */}
          <div className="hidden items-center gap-2 rounded-md border border-[#262b33] bg-[#12151b] px-2.5 py-1 md:flex">
            <Radio className="h-3 w-3 text-amber-400" />
            <span className="font-mono text-xs tabular-nums text-amber-300">{fmtCountdown(secsLeft)}</span>
            <span className="text-[10px] text-zinc-500">to close · K {strike != null ? fmtPrice(strike, 1) : '—'}</span>
          </div>

          <button
            onClick={() => sendControl({ type: running ? 'stop' : 'start' })}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors ${
              running
                ? 'border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
            }`}
          >
            {running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {running ? 'STOP' : 'START'}
          </button>

          <SettingsSheet
            trigger={
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#262b33] bg-[#12151b] px-3 text-xs font-semibold text-zinc-300 hover:bg-[#1a1e25]">
                <Settings2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Settings</span>
              </button>
            }
          />
        </div>
      </div>
    </header>
  )
}
