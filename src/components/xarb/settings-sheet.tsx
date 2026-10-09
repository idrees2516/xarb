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
