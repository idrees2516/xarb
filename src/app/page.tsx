'use client'

import { useEffect } from 'react'
import { connectEngine } from '@/lib/xarb'
import { Header } from '@/components/xarb/header'
import { StatCards, V04Cards } from '@/components/xarb/stat-cards'
import { PriceChart, FvChart } from '@/components/xarb/charts'
import { TriggerPanel, BookLadder, LatencyPanel } from '@/components/xarb/panels'
import { SignalFeed, TradeBlotter } from '@/components/xarb/feeds'

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

  return (
    <div className="flex min-h-screen flex-col bg-[#0b0d11] text-zinc-100">
      <Header />

      <main className="mx-auto w-full max-w-[1600px] flex-1 space-y-3 px-3 py-3 sm:px-5 sm:py-4">
        {/* live stats */}
        <StatCards />

        {/* v0.4: σ auto-cal · δ-hedge · value capture */}
        <section aria-label="Sigma calibration, delta hedge and value capture">
          <V04Cards />
        </section>

        {/* charts */}
        <section aria-label="Live charts" className="rounded-lg border border-[#22262e] bg-[#101318] p-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              BTC spot · 5m window
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
            <span className="font-semibold text-zinc-400">Rule:</span> BUY UP when ① fair-value jumps ≥ 20¢ within
            5s <span className="text-zinc-500">AND</span> ② FV &gt; 60¢ <span className="text-zinc-500">AND</span> ③
            Polymarket ask is ≥ 10¢ under fair value <span className="text-zinc-500">AND</span> ④ the net edge
            (edge − PM taker fee − estimated Binance hedge cost) clears the floor — all in the same tick. FV =
            Φ((S−K)/(σ_eff·√T)) with σ_eff auto-calibrated from live PM mids.
          </p>
          <p className="mt-1">
            <span className="font-semibold text-zinc-400">v0.4 engine:</span> σ auto-calibration inverts the live
            Polymarket mid (Φ⁻¹) into an implied σ, EWMA-fuses it with Binance realized vol behind a dynamic
            median floor, and snap-pins FV to the market&apos;s own quote while it prints — the edge appears only in
            the reaction-lag window. Every fill is δ-hedged on Binance (Whalley–Wilmott no-trade band, wind-down
            before the expiry gamma explosion, force-flatten at close); early exits bank the mispricing when PM
            re-converges. Opportunity capture accounting proves zero engine-missed episodes.
          </p>
          <p className="mt-1">
            <span className="font-semibold text-zinc-400">Notes:</span> paper trading for research — no orders are
            sent; hedge fills cross the live Binance top-of-book in paper mode. Windows resolve on Chainlink
            BTC/USD TWAP; this terminal settles paper positions on the Binance mid at close as a proxy. Live PM
            taker fee (observed 1000 bps on the 5m series) is folded into the net-edge gate. &quot;EST&quot; strike =
            engine joined mid-window. Not financial advice; check Polymarket eligibility &amp; terms before trading
            real funds.
          </p>
        </footer>
      </main>
    </div>
  )
}
