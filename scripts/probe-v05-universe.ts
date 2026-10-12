// Probe the v0.5 engine: universe state, σ calibration, triggers, feeds
import { io } from 'socket.io-client'

const sock = io('http://localhost:3011', { transports: ['websocket'], timeout: 8000 })
let n = 0

sock.on('init', (d: any) => {
  console.log('=== INIT ===')
  console.log('settings:', JSON.stringify({ focus: d.settings?.focusMarket, sideDown: d.settings?.sideDown, markets: d.settings?.markets }))
  showSnap(d.snapshot)
})

sock.on('snap', (s: any) => {
  if (++n % 40 !== 0) return // ~4s at 10Hz
  showSnap(s)
})

function showSnap(s: any) {
  const f = s.focus
  console.log(`\n== snap @ ${new Date(s.ts).toISOString().slice(11, 19)} · live ${s.marketsLive}/${s.marketsTotal} · bin ${s.feeds.binance.status} (${s.feeds.binance.symbols} syms, ${s.feeds.binance.ticksPerMin} tpm) · pm ${s.feeds.polymarket.status} (${s.feeds.polymarket.sockets} sockets) ==`)
  console.log(`focus ${f.label} · FV ${s.fv.value.toFixed(1)}¢ UP / ${s.fv.valueDown.toFixed(1)}¢ DOWN · jump5s ${s.fv.jump5s.toFixed(1)}/${s.fv.jump5sDown.toFixed(1)} · σ eff ${s.sigma.eff.toFixed(2)} (imp ${s.sigma.imp.toFixed(2)} real ${s.sigma.real.toFixed(2)} floor ${s.sigma.floor.toFixed(2)} snap ${s.sigma.effIsSnap}) · acc/rej ${s.sigma.accepted}/${s.sigma.rejected}`)
  console.log(`triggers UP ${JSON.stringify(s.triggers)} · DOWN ${JSON.stringify(s.dnTriggers)} · capture ${JSON.stringify(s.capture)}`)
  for (const u of s.universe ?? []) {
    console.log(
      `  ${u.label.padEnd(9)} ${u.status.padEnd(7)} τ=${String(Math.floor(u.window.secondsLeft)).padStart(3)}s K=${u.window.strike ?? '—'} S=${u.binance.price || '—'} FV=${u.fv.value.toFixed(1)}/${u.fv.valueDown.toFixed(1)} ask=${u.pm.ask ?? '—'}/${u.pm.dnAsk ?? '—'} edge=${u.edge.fvAsk?.toFixed(1) ?? '—'}/${u.edge.dnFvAsk?.toFixed(1) ?? '—'} σ=${u.fv.sigmaEffBps.toFixed(1)}bp T=${led(u.triggers)}/${led(u.dnTriggers)} pos=${u.openPos}`
    )
  }
}

function led(t: any): string {
  return `${t?.jump ? '●' : '○'}${t?.above60 ? '●' : '○'}${t?.gap ? '●' : '○'}${t?.net ? '●' : '○'}`
}

sock.on('signal', (sig: any) => {
  if (sig.action === 'EXECUTED' || sig.action === 'EXIT') console.log(`!! [${sig.marketLabel} ${sig.side}] ${sig.action} ${sig.reason ?? ''}`)
})

setTimeout(() => {
  console.log('\nprobe done')
  process.exit(0)
}, 15000)
