'use client'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { updateSettings, useXarb, sendControl } from '@/lib/xarb'

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs text-zinc-300">{label}</Label>
        {hint ? <span className="text-[10px] text-zinc-600">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

export function SettingsSheet({ trigger }: { trigger: React.ReactNode }) {
  const settings = useXarb((s) => s.settings)

  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="w-[340px] overflow-y-auto border-[#22262e] bg-[#0d1014] sm:w-[400px]">
        <SheetHeader>
          <SheetTitle className="text-zinc-100">Strategy parameters</SheetTitle>
          <SheetDescription className="text-xs text-zinc-500">
            Applied to the engine live over the socket — no restart needed.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-8">
          <SettingRow label="Auto-trade (paper)" hint="fire fills when triggers align">
            <div className="flex items-center gap-3">
              <Switch
                checked={settings.autoTrade}
                onCheckedChange={(v) => updateSettings({ autoTrade: v })}
              />
              <span className={`text-xs ${settings.autoTrade ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {settings.autoTrade ? 'ARMED' : 'observe only'}
              </span>
            </div>
          </SettingRow>

          <SettingRow label="Stake per trade" hint="$ paper">
            <Input
              type="number"
              min={5}
              max={500}
              step={5}
              value={settings.stakeUsd}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 5 && v <= 500) updateSettings({ stakeUsd: v })
              }}
              className="border-[#262b33] bg-[#12151b] font-mono text-zinc-200"
            />
          </SettingRow>

          <SettingRow label="FV model" hint="UP fair-value curve">
            <Select value={settings.model} onValueChange={(v) => updateSettings({ model: v as 'linear' | 'cdf' })}>
              <SelectTrigger className="border-[#262b33] bg-[#12151b] text-zinc-200">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-[#262b33] bg-[#12151b] text-zinc-200">
                <SelectItem value="cdf">Normal CDF — Φ(z) · σ-floor 15.5 · honest tails</SelectItem>
                <SelectItem value="linear">Linear — legacy spec (52 + slope·(S−K))</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <Separator className="bg-[#1e222a]" />

          <SettingRow label="① 5s FV jump trigger" hint={`${settings.jumpThreshC}¢`}>
            <Slider
              value={[settings.jumpThreshC]}
              min={5}
              max={40}
              step={1}
              onValueCommit={(v) => updateSettings({ jumpThreshC: v[0] })}
            />
          </SettingRow>

          <SettingRow label="② FV floor" hint={`${settings.fvFloorC}¢`}>
            <Slider
              value={[settings.fvFloorC]}
              min={40}
              max={80}
              step={1}
              onValueCommit={(v) => updateSettings({ fvFloorC: v[0] })}
            />
          </SettingRow>

          <SettingRow label="③ Minimum edge vs ask" hint={`${settings.edgeThreshC}¢`}>
            <Slider
              value={[settings.edgeThreshC]}
              min={5}
              max={30}
              step={1}
              onValueCommit={(v) => updateSettings({ edgeThreshC: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Min seconds left to enter" hint={`${settings.minSecsLeft}s`}>
            <Slider
              value={[settings.minSecsLeft]}
              min={10}
              max={120}
              step={5}
              onValueCommit={(v) => updateSettings({ minSecsLeft: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Max trades per window" hint={`${settings.maxTradesPerWindow}`}>
            <Slider
              value={[settings.maxTradesPerWindow]}
              min={1}
              max={5}
              step={1}
              onValueCommit={(v) => updateSettings({ maxTradesPerWindow: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Taker fee assumption" hint={`${settings.takerFeeBps} bps`}>
            <Slider
              value={[settings.takerFeeBps]}
              min={0}
              max={300}
              step={10}
              onValueCommit={(v) => updateSettings({ takerFeeBps: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Max book age for entry" hint={`${settings.maxBookAgeMs}ms`}>
            <Slider
              value={[settings.maxBookAgeMs]}
              min={1000}
              max={10000}
              step={500}
              onValueCommit={(v) => updateSettings({ maxBookAgeMs: v[0] })}
            />
          </SettingRow>

          <Separator className="bg-[#1e222a]" />

          {/* ── v0.4: σ auto-calibration ── */}
          <div className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400/80">
            σ auto-calibration (live PM)
          </div>

          <SettingRow label="Auto-calibrate σ" hint="implied inversion from PM mids">
            <div className="flex items-center gap-3">
              <Switch
                checked={settings.sigmaAuto}
                onCheckedChange={(v) => updateSettings({ sigmaAuto: v })}
              />
              <span className={`text-xs ${settings.sigmaAuto ? 'text-cyan-400' : 'text-zinc-500'}`}>
                {settings.sigmaAuto ? 'AUTO — snap tracks PM' : 'legacy fixed floor'}
              </span>
            </div>
          </SettingRow>

          <SettingRow label="Implied weight in blend" hint={`w_imp ${settings.sigmaWImp.toFixed(2)}`}>
            <Slider
              value={[settings.sigmaWImp]}
              min={0}
              max={1}
              step={0.05}
              onValueCommit={(v) => updateSettings({ sigmaWImp: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Identifiability gate |Φ⁻¹(mid)|" hint={settings.sigmaZGate.toFixed(2)}>
            <Slider
              value={[settings.sigmaZGate]}
              min={0.1}
              max={1}
              step={0.05}
              onValueCommit={(v) => updateSettings({ sigmaZGate: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Dynamic floor k × median(σ_imp)" hint={`k ${settings.sigmaFloorK.toFixed(2)}`}>
            <Slider
              value={[settings.sigmaFloorK]}
              min={0.1}
              max={1.5}
              step={0.05}
              onValueCommit={(v) => updateSettings({ sigmaFloorK: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Absolute σ floor" hint={`${settings.sigmaAbsFloor.toFixed(1)} pts/√s`}>
            <Slider
              value={[settings.sigmaAbsFloor]}
              min={3}
              max={30}
              step={0.5}
              onValueCommit={(v) => updateSettings({ sigmaAbsFloor: v[0] })}
            />
          </SettingRow>

          <Separator className="bg-[#1e222a]" />

          {/* ── v0.4: δ-hedging ── */}
          <div className="text-[10px] font-semibold uppercase tracking-widest text-fuchsia-400/80">
            δ-hedging (Binance)
          </div>

          <SettingRow label="Delta-hedge binary exposure" hint="W–W band policy">
            <div className="flex items-center gap-3">
              <Switch checked={settings.hedgeOn} onCheckedChange={(v) => updateSettings({ hedgeOn: v })} />
              <span className={`text-xs ${settings.hedgeOn ? 'text-fuchsia-400' : 'text-zinc-500'}`}>
                {settings.hedgeOn ? 'HEDGED — shorts Δ on Binance' : 'directional (unhedged)'}
              </span>
            </div>
          </SettingRow>

          <SettingRow label="Hedge ratio (Δ fraction)" hint={`${(settings.hedgeRatio * 100).toFixed(0)}% of delta`}>
            <Slider
              value={[settings.hedgeRatio]}
              min={0}
              max={1}
              step={0.05}
              onValueCommit={(v) => updateSettings({ hedgeRatio: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Binance taker fee" hint={`${settings.hedgeFeeBps.toFixed(1)} bps`}>
            <Slider
              value={[settings.hedgeFeeBps]}
              min={0}
              max={100}
              step={0.5}
              onValueCommit={(v) => updateSettings({ hedgeFeeBps: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Wind-down horizon" hint={`${settings.hedgeWinddownS}s before close`}>
            <Slider
              value={[settings.hedgeWinddownS]}
              min={5}
              max={60}
              step={5}
              onValueCommit={(v) => updateSettings({ hedgeWinddownS: v[0] })}
            />
          </SettingRow>

          <Separator className="bg-[#1e222a]" />

          {/* ── v0.4: profitability gate + early exit ── */}
          <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400/80">
            Profitability & capture
          </div>

          <SettingRow label="④ Min net edge to fire" hint={`${settings.minNetEdgeC.toFixed(1)}¢ after fees + hedge`}>
            <Slider
              value={[settings.minNetEdgeC]}
              min={0}
              max={20}
              step={0.5}
              onValueCommit={(v) => updateSettings({ minNetEdgeC: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Early-exit band (PM bid vs FV)" hint={`${settings.exitBandC.toFixed(1)}¢`}>
            <Slider
              value={[settings.exitBandC]}
              min={0}
              max={15}
              step={0.5}
              onValueCommit={(v) => updateSettings({ exitBandC: v[0] })}
            />
          </SettingRow>

          <SettingRow label="Min captured edge to exit" hint={`${settings.minCaptureC.toFixed(1)}¢/sh`}>
            <Slider
              value={[settings.minCaptureC]}
              min={0}
              max={20}
              step={0.5}
              onValueCommit={(v) => updateSettings({ minCaptureC: v[0] })}
            />
          </SettingRow>

          <Separator className="bg-[#1e222a]" />

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300"
              onClick={() => sendControl({ type: 'reset' })}
            >
              Reset stats
            </Button>
            <Button
              variant="outline"
              className="flex-1 border-[#262b33] bg-[#12151b] text-zinc-300 hover:bg-[#1a1e25]"
              onClick={() =>
                sendControl({ type: 'stop' })
              }
            >
              Stop engine
            </Button>
          </div>

          <p className="text-[10px] leading-relaxed text-zinc-600">
            Paper execution fills by walking the live CLOB ask ladder. Real execution requires your own Polymarket
            API credentials (EIP-712 signing) deployed locally next to the matching engine.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
