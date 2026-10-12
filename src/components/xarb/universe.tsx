'use client'

// ─── Market universe grid (v0.5) ──────────────────────────────────────────────
// Every Polymarket up/down series the engine tracks: window countdown, strike,
// spot, both FV sides, both asks, both edges, σ_eff (bp/√s), per-side trigger
// LEDs (jump · floor · gap · net), open positions. Click a row → detail panels
// follow that market (focus). Power toggle → enable/disable live.

import { useXarb, fmtPrice, fmtCents, fmtCountdown, fmtSigned, setFocusMarket, toggleMarket } from '@/lib/xarb'
import type { MarketView } from '@/lib/xarb'
import { Globe2, Power, Crosshair } from 'lucide-react'

/** Stable empty fallback (a fresh [] in a zustand selector loops useSyncExternalStore). */
const EMPTY_UNIVERSE: MarketView[] = []

function Led({ on, title }: { on: boolean; title: string }) {
  return (
    <span
      title={title}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full border ${
        on
          ? 'border-emerald-400 bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]'
          : 'border-zinc-700 bg-transparent'
      }`}
    />
  )
}

function SideLeds({ t }: { t: { jump: boolean; above60: boolean; gap: boolean; net: boolean } }) {
  return (
    <span className="inline-flex items-center gap-[3px]" title="jump · floor · gap · net">
      <Led on={t.jump} title="① FV jump ≥ threshold" />
      <Led on={t.above60} title="② FV above floor" />
      <Led on={t.gap} title="③ edge vs ask" />
      <Led on={t.net} title="④ net edge after costs" />
    </span>
  )
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'live'
      ? 'bg-emerald-400 animate-pulse'
      : status === 'loading'
        ? 'bg-amber-400'
        : status === 'down'
          ? 'bg-red-500'
          : 'bg-zinc-700'
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />
}

export function UniversePanel() {
  const universe = useXarb((s) => s.snapshot?.universe ?? EMPTY_UNIVERSE)
  const focusId = useXarb((s) => s.snapshot?.focusId ?? 'btc-5m')
  const marketsLive = useXarb((s) => s.snapshot?.marketsLive ?? 0)
  const marketsTotal = useXarb((s) => s.snapshot?.marketsTotal ?? 0)
  const sideDown = useXarb((s) => s.snapshot?.sideDown ?? true)
  const capture = useXarb((s) => s.snapshot?.capture)
  const running = useXarb((s) => s.snapshot?.running ?? false)

  const opps = capture?.opportunities ?? 0
  const fired = capture?.fired ?? 0
  const gated = capture?.missed ?? 0

  return (
    <section
      aria-label="Market universe"
      className="rounded-lg border border-[#22262e] bg-[#101318]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1c2027] px-3.5 py-2.5">
        <Globe2 className="h-3.5 w-3.5 text-cyan-400" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">
          Market universe
        </span>
        <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-px font-mono text-[9px] font-bold text-cyan-300">
          {marketsLive}/{marketsTotal} LIVE
        </span>
        <span className="font-mono text-[9px] tabular-nums text-zinc-600">
          opps {opps} · fired {fired} · gated {gated}
        </span>
        <span className="ms-auto hidden items-center gap-2 font-mono text-[9px] text-zinc-600 sm:flex">
          <Crosshair className="h-3 w-3" />
          click a row to focus the panels · <Power className="h-3 w-3" /> toggles the series
          {sideDown ? ' · DOWN-side capture ON' : ' · DOWN-side capture OFF'}
          {running ? '' : ' · engine STOPPED'}
        </span>
      </div>

      <div className="xarb-scroll overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-left">
          <thead>
            <tr className="text-[9px] uppercase tracking-wider text-zinc-600">
              <th className="px-2.5 py-2 font-medium">market</th>
              <th className="px-2 py-2 font-medium">window τ</th>
              <th className="px-2 py-2 text-right font-medium">strike K</th>
              <th className="px-2 py-2 text-right font-medium">spot</th>
              <th className="px-2 py-2 text-right font-medium">FV up / dn</th>
              <th className="px-2 py-2 text-right font-medium">ask up / dn</th>
              <th className="px-2 py-2 text-right font-medium">edge up / dn</th>
              <th className="px-2 py-2 text-right font-medium">σ bp/√s</th>
              <th className="px-2 py-2 text-center font-medium">①②③④ up</th>
              <th className="px-2 py-2 text-center font-medium">①②③④ dn</th>
              <th className="px-2.5 py-2 text-center font-medium">pos</th>
            </tr>
          </thead>
          <tbody>
            {universe.map((u) => {
              const isFocus = u.id === focusId
              const prog = Math.min(Math.max(u.window.secondsLeft / u.windowSec, 0), 1)
              const edgeUp = u.edge.fvAsk
              const edgeDn = u.edge.dnFvAsk
              const bestSide = edgeUp ?? -Infinity
              const dnSide = edgeDn ?? -Infinity
              const upHot = edgeUp != null && edgeUp >= 0
              const dnHot = edgeDn != null && edgeDn >= 0
              return (
                <tr
                  key={u.id}
                  onClick={() => setFocusMarket(u.id)}
                  className={`cursor-pointer border-t border-[#181c22] font-mono text-[11px] tabular-nums transition-colors ${
                    isFocus ? 'bg-cyan-500/[0.07] hover:bg-cyan-500/[0.1]' : 'hover:bg-[#141821]'
                  } ${!u.enabled ? 'opacity-40' : ''}`}
                >
                  <td className="px-2.5 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <button
                        aria-label={u.enabled ? `Disable ${u.label}` : `Enable ${u.label}`}
                        title={u.enabled ? 'disable series (live)' : 'enable series (live)'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleMarket(u.id, !u.enabled)
                        }}
                        className={`shrink-0 rounded p-0.5 transition-colors ${
                          u.enabled
                            ? 'text-emerald-400 hover:bg-emerald-500/15'
                            : 'text-zinc-600 hover:bg-zinc-500/15'
                        }`}
                      >
                        <Power className="h-3 w-3" />
                      </button>
                      <StatusDot status={u.status} />
                      <span className={`text-[11px] font-semibold ${isFocus ? 'text-cyan-300' : 'text-zinc-200'}`}>
                        {u.label}
                      </span>
                      {u.hedge.active ? (
                        <span
                          title={`δ-hedge open: ${u.hedge.qtyBtc} ${u.asset}`}
                          className="rounded border border-fuchsia-500/40 bg-fuchsia-500/10 px-1 py-px text-[8px] font-bold text-fuchsia-300"
                        >
                          Δ
                        </span>
                      ) : null}
                      {u.triggers.all ? (
                        <span
                          title="UP-side all-3 armed"
                          className="rounded border border-emerald-500/50 bg-emerald-500/15 px-1 py-px text-[8px] font-bold text-emerald-300"
                        >
                          UP
                        </span>
                      ) : null}
                      {u.dnTriggers.all ? (
                        <span
                          title="DOWN-side all-3 armed"
                          className="rounded border border-red-500/50 bg-red-500/15 px-1 py-px text-[8px] font-bold text-red-300"
                        >
                          DN
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className={`w-8 text-[10px] ${u.window.secondsLeft < 30 ? 'text-red-400' : 'text-amber-300'}`}>
                        {u.enabled ? fmtCountdown(u.window.secondsLeft) : '—'}
                      </span>
                      <span className="hidden h-[3px] w-10 overflow-hidden rounded bg-[#1a1e25] md:block">
                        <span
                          className={`block h-full rounded ${u.window.secondsLeft < 30 ? 'bg-red-400' : 'bg-amber-400/70'}`}
                          style={{ width: `${prog * 100}%` }}
                        />
                      </span>
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">
                    {u.window.strike != null ? (
                      <span>
                        {fmtPrice(u.window.strike, u.priceDp)}
                        {u.window.strikeEstimated ? (
                          <span className="ms-1 align-middle text-[8px] font-bold text-amber-400/80">EST</span>
                        ) : null}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="text-zinc-200">{u.binance.price ? fmtPrice(u.binance.price, u.priceDp) : '—'}</span>
                    {u.binance.change5s !== 0 ? (
                      <span className={`ms-1 text-[9px] ${u.binance.change5s > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmtSigned(u.binance.change5s, u.priceDp)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={u.fv.value >= 60 ? 'text-emerald-300' : 'text-zinc-300'}>
                      {u.enabled ? fmtCents(u.fv.value, 0) : '—'}
                    </span>
                    <span className="mx-1 text-zinc-700">/</span>
                    <span className={u.fv.valueDown >= 60 ? 'text-emerald-300' : 'text-zinc-500'}>
                      {u.enabled ? fmtCents(u.fv.valueDown, 0) : '—'}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="text-amber-300/90">{u.pm.ask != null ? fmtCents(u.pm.ask, 0) : '—'}</span>
                    <span className="mx-1 text-zinc-700">/</span>
                    <span className="text-amber-300/60">{u.pm.dnAsk != null ? fmtCents(u.pm.dnAsk, 0) : '—'}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className={upHot ? (edgeUp! >= 10 ? 'text-emerald-400' : 'text-emerald-300/70') : 'text-zinc-600'}>
                      {edgeUp != null ? fmtSigned(edgeUp, 1) : '—'}
                    </span>
                    <span className="mx-1 text-zinc-700">/</span>
                    <span
                      className={
                        sideDown && dnHot
                          ? dnSide >= 10
                            ? 'text-emerald-400'
                            : 'text-emerald-300/70'
                          : 'text-zinc-600'
                      }
                    >
                      {edgeDn != null ? fmtSigned(edgeDn, 1) : '—'}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-cyan-300/90">{u.fv.sigmaEffBps ? u.fv.sigmaEffBps.toFixed(1) : '—'}</td>
                  <td className="px-2 py-1.5 text-center">
                    <SideLeds t={u.triggers} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <SideLeds t={u.dnTriggers} />
                  </td>
                  <td className="px-2.5 py-1.5 text-center">
                    {u.openPos > 0 ? (
                      <span className="rounded border border-zinc-500/40 bg-zinc-500/10 px-1.5 py-px text-[9px] font-bold text-zinc-200">
                        {u.openPos}
                      </span>
                    ) : (
                      <span className="text-zinc-700">·</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-[#1c2027] px-3.5 py-2 font-mono text-[9px] leading-relaxed text-zinc-600">
        both sides of every series evaluated on every tick — zero-miss trigger capture · σ shown in bp/√s (cross-asset
        comparable) · strike EST = engine joined mid-window
      </div>
    </section>
  )
}
