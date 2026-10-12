'use client'

import { useEffect } from 'react'
import { connectEngine, useXarb } from '@/lib/xarb'
import { Header } from '@/components/xarb/header'
import { StatCards, V04Cards } from '@/components/xarb/stat-cards'
import { PriceChart, FvChart } from '@/components/xarb/charts'
import { TriggerPanel, BookLadder, LatencyPanel } from '@/components/xarb/panels'
import { SignalFeed, TradeBlotter } from '@/components/xarb/feeds'
import { UniversePanel } from '@/components/xarb/universe'

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500">
      <span className="h-[3px] w-3.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

export default function Page() {
  useEffect(() => {
    connectEngine()
  }, [])
  const focus = useXarb((s) => s.snapshot?.focus)
  const marketsLive = useXarb((s) => s.snapshot?.marketsLive ?? 0)
  const marketsTotal = useXarb((s) => s.snapshot?.marketsTotal ?? 0)
  const sideDown = useXarb((s) => s.snapshot?.sideDown ?? true)

  return (
    <div className="flex min-h-screen flex-col bg-[#0b0d11] text-zinc-100">
      <Header />

      <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-3 px-3 py-3 sm:px-5 sm:py-4">
        {/* market universe — every series, both sides */}
        <UniversePanel />

        {/* live stats (focus market) */}
        <StatCards />

        {/* v0.4/v0.5: σ auto-cal · δ-hedge · value capture */}
        <section aria-label="Sigma calibration, delta hedge and value capture">
          <V04Cards />
        </section>

        {/* charts */}
        <section aria-label="Live charts" className="rounded-lg border border-[#22262e] bg-[#101318] p-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              {focus?.label ?? 'BTC 5m'} · spot · window
            </span>
            <Legend color="#fb923c" label="Binance mid" />
            <Legend color="#8b949e" label="strike K" />
            <Legend color="rgba(245,158,11,0.7)" label="window end" />
            <Legend color="#10b981" label="buy fill ▲" />
            <span className="ms-auto hidden text-[10px] text-zinc-600 sm:block">hover for crosshair · last 3 min</span>
          </div>
          <PriceChart />
          <div className="my-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#1c2027] pt-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              UP fair value vs Polymarket ask
            </span>
            <Legend color="#34d399" label="FV (model)" />
            <Legend color="#fbbf24" label="PM UP ask" />
            <Legend color="#f87171" label="FV floor" />
            <Legend color="rgba(16,185,129,0.25)" label="positive edge" />
          </div>
          <FvChart />
        </section>

        {/* trigger + book + latency */}
        <div className="grid gap-3 lg:grid-cols-3">
          <TriggerPanel />
          <BookLadder />
          <LatencyPanel />
        </div>

        {/* logs */}
        <div className="grid gap-3 lg:grid-cols-2">
          <SignalFeed />
          <TradeBlotter />
        </div>

        {/* footer */}
        <footer className="rounded-lg border border-[#22262e] bg-[#101318] px-4 py-3 text-[10px] leading-relaxed text-zinc-600">
          <p>
            <span className="font-semibold text-zinc-400">Rule:</span> on EVERY tick, for BOTH sides (UP and DOWN) of
            EVERY enabled market ({marketsLive}/{marketsTotal} series live
            {sideDown ? ' · DOWN capture on' : ''}): BUY the side when ① its fair value jumps ≥ 20¢ within 5s{' '}
            <span className="text-zinc-500">AND</span> ② its FV &gt; 60¢ <span className="text-zinc-500">AND</span> ③
            the Polymarket ask on that side is ≥ 10¢ under fair value <span className="text-zinc-500">AND</span> ④ the
            net edge (edge − PM taker fee − estimated Binance hedge cost) clears the floor — all in the same tick. FV =
            Φ((S−K)/(σ_eff·√T)) with σ_eff auto-calibrated from that market&apos;s live PM mids.
          </p>
          <p className="mt-1">
            <span className="font-semibold text-zinc-400">v0.5 universe engine:</span> one combined Binance WS feeds all
            {` ${marketsTotal}`} series&apos; underlyings; each market owns a Polymarket socket subscribed to BOTH
            tokens (real DOWN quotes + both-side σ calibration). Windows roll per series at their own cadence (5m/15m
            clock-aligned, Chainlink resolution). σ auto-calibration inverts the live PM mid (Φ⁻¹) into an implied σ
            per market, EWMA-fuses it with that asset&apos;s realized vol behind a dynamic median floor, and snap-pins
            FV to the market&apos;s own quote while it prints — the edge appears only in the reaction-lag window. Every
            fill is δ-hedged on the market&apos;s own Binance symbol (Whalley–Wilmott band, wind-down, force-flatten);
            early exits bank the mispricing when PM re-converges. Per-market + global capture accounting proves zero
            engine-missed episodes.
          </p>
          <p className="mt-1">
            <span className="font-semibold text-zinc-400">Notes:</span> paper trading for research — no orders are
            sent; hedge fills cross the live Binance top-of-book in paper mode. Windows resolve on Chainlink oracles;
            this terminal settles paper positions on the Binance mid at close as a proxy, and strikes joined
            mid-window are marked EST. Live PM taker fee is folded into the net-edge gate. Not financial advice; check
            Polymarket eligibility &amp; terms before trading real funds.
          </p>
        </footer>
      </main>
    </div>
  )
}
