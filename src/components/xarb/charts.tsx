'use client'

// ─── XARB live canvas charts: BTC price + FV/ask ─────────────────────────────
// rAF-rendered from module-level ring buffers (no React re-renders in the loop)

import { useEffect, useRef } from 'react'
import { chartBuf, useXarb, fmtPrice, fmtClock } from '@/lib/xarb'
import type { Trade } from '@/lib/xarb'

const MONO = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
const VIEW_MS = 180_000 // 3-minute visible window

const C = {
  grid: '#1b2027',
  label: '#5b6572',
  price: '#fb923c',
  fv: '#34d399',
  ask: '#fbbf24',
  strike: '#8b949e',
  floor: '#f87171',
  marker: '#10b981',
  posFill: 'rgba(16,185,129,0.16)',
  negFill: 'rgba(239,68,68,0.07)',
  cross: '#3d434d',
  info: '#9aa4b2',
  winEnd: 'rgba(245,158,11,0.55)',
}

const PAD = { l: 8, r: 58, t: 12, b: 18 }

interface Ctx2D {
  ctx: CanvasRenderingContext2D
  W: number
  H: number
}

function setup(c: HTMLCanvasElement): Ctx2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const W = c.clientWidth
  const H = c.clientHeight
  if (!W || !H) return null
  const pw = Math.floor(W * dpr)
  const ph = Math.floor(H * dpr)
  if (c.width !== pw || c.height !== ph) {
    c.width = pw
    c.height = ph
  }
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  return { ctx, W, H }
}

function drawTimeGrid(g: Ctx2D, t0: number, t1: number): number {
  const { ctx, W, H } = g
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW
  ctx.strokeStyle = C.grid
  ctx.fillStyle = C.label
  ctx.font = MONO
  ctx.lineWidth = 1
  ctx.textAlign = 'center'
  const step = 30_000
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const px = Math.round(x(t)) + 0.5
    ctx.beginPath()
    ctx.moveTo(px, PAD.t)
    ctx.lineTo(px, PAD.t + plotH)
    ctx.stroke()
    ctx.fillText(fmtClock(t), px, H - 5)
  }
  return plotW
}

function priceAt(ts: number): number | null {
  // nearest/interpolated price from the ring buffer
  const buf = chartBuf
  if (!buf.length) return null
  if (ts <= buf[0].t) return buf[0].price
  if (ts >= buf[buf.length - 1].t) return buf[buf.length - 1].price
  for (let i = 1; i < buf.length; i++) {
    if (buf[i].t >= ts) {
      const a = buf[i - 1]
      const b = buf[i]
      const f = (ts - a.t) / (b.t - a.t || 1)
      return a.price + f * (b.price - a.price)
    }
  }
  return null
}

function tag(g: Ctx2D, y: number, text: string, bg: string): void {
  const { ctx, W } = g
  const w = ctx.measureText(text).width + 10
  const x = W - PAD.r + 2
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.roundRect(x, y - 8, w, 15, 3)
  ctx.fill()
  ctx.fillStyle = '#0a0c10'
  ctx.textAlign = 'left'
  ctx.font = 'bold 10px ui-monospace, monospace'
  ctx.fillText(text, x + 5, y + 3)
  ctx.font = MONO
}

function crosshair(
  g: Ctx2D,
  t0: number,
  t1: number,
  mouse: { x: number; on: boolean },
  lines: (v: { t: number; price: number; fv: number; pmAsk: number; edge: number }) => string[]
): void {
  if (!mouse.on) return
  const { ctx, W, H } = g
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b
  if (mouse.x < PAD.l || mouse.x > PAD.l + plotW) return
  const t = t0 + ((mouse.x - PAD.l) / plotW) * (t1 - t0)
  const p = priceAt(t)
  ctx.strokeStyle = C.cross
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(Math.round(mouse.x) + 0.5, PAD.t)
  ctx.lineTo(Math.round(mouse.x) + 0.5, PAD.t + plotH)
  ctx.stroke()
  ctx.setLineDash([])
  if (p == null) return
  // nearest chart point values
  let best: (typeof chartBuf)[number] | null = null
  for (const pt of chartBuf) {
    if (pt.t > t) break
    best = pt
  }
  if (!best) return
  ctx.fillStyle = C.info
  ctx.font = MONO
  ctx.textAlign = 'left'
  const rows = lines({ t, price: p, fv: best.fv, pmAsk: best.pmAsk, edge: best.edge })
  rows.forEach((r, i) => ctx.fillText(r, PAD.l + 6, PAD.t + 12 + i * 13))
}

function markers(g: Ctx2D, t0: number, t1: number, yOf: (t: Trade) => number | null): void {
  const { ctx, W, H } = g
  const plotW = W - PAD.l - PAD.r
  const trades = useXarb.getState().trades
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW
  for (const tr of trades) {
    if (tr.ts < t0 || tr.ts > t1) continue
    const y = yOf(tr)
    if (y == null) continue
    const px = x(tr.ts)
    ctx.fillStyle = tr.status === 'LOST' ? '#ef4444' : C.marker
    ctx.beginPath()
    ctx.moveTo(px, y - 6)
    ctx.lineTo(px - 4.5, y + 4)
    ctx.lineTo(px + 4.5, y + 4)
    ctx.closePath()
    ctx.fill()
    // tick to bottom
    ctx.strokeStyle = 'rgba(16,185,129,0.25)'
    ctx.beginPath()
    ctx.moveTo(px + 0.5, y + 6)
    ctx.lineTo(px + 0.5, H - PAD.b)
    ctx.stroke()
  }
}

// ─── price chart ─────────────────────────────────────────────────────────────

export function PriceChart() {
  const ref = useRef<HTMLCanvasElement>(null)
  const mouse = useRef({ x: 0, on: false })

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const move = (e: MouseEvent) => {
      const r = c.getBoundingClientRect()
      mouse.current = { x: e.clientX - r.left, on: true }
    }
    const leave = () => (mouse.current.on = false)
    c.addEventListener('mousemove', move)
    c.addEventListener('mouseleave', leave)
    let raf = 0
    const loop = () => {
      draw(c, mouse.current)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      c.removeEventListener('mousemove', move)
      c.removeEventListener('mouseleave', leave)
    }
  }, [])

  return <canvas ref={ref} className="block h-[230px] w-full cursor-crosshair sm:h-[250px]" aria-label="BTC price chart" role="img" />
}

function draw(c: HTMLCanvasElement, mouse: { x: number; on: boolean }): void {
  const g = setup(c)
  if (!g) return
  const { ctx, W, H } = g
  const t1 = Date.now()
  const t0 = t1 - VIEW_MS
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b

  const snap = useXarb.getState().snapshot
  const strike = snap?.window.strike ?? null
  const winEnd = snap?.window.endEpoch ?? 0

  const pts = chartBuf.filter((p) => p.t >= t0)
  if (pts.length < 2) {
    ctx.fillStyle = C.label
    ctx.font = MONO
    ctx.textAlign = 'center'
    ctx.fillText('waiting for live data…', W / 2, H / 2)
    return
  }

  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    if (p.price < lo) lo = p.price
    if (p.price > hi) hi = p.price
  }
  if (strike != null) {
    lo = Math.min(lo, strike)
    hi = Math.max(hi, strike)
  }
  const pad = Math.max((hi - lo) * 0.12, 2)
  lo -= pad
  hi += pad
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * plotH
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW

  drawTimeGrid(g, t0, t1)

  // y labels (price)
  ctx.font = MONO
  ctx.textAlign = 'left'
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4
    const py = Math.round(y(v)) + 0.5
    ctx.strokeStyle = C.grid
    ctx.beginPath()
    ctx.moveTo(PAD.l, py)
    ctx.lineTo(PAD.l + plotW, py)
    ctx.stroke()
    ctx.fillStyle = C.label
    ctx.fillText(fmtPrice(v, 0), W - PAD.r + 4, py + 3)
  }

  // window end marker
  if (winEnd * 1000 > t0 && winEnd * 1000 < t1) {
    const px = Math.round(x(winEnd * 1000)) + 0.5
    ctx.strokeStyle = C.winEnd
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(px, PAD.t)
    ctx.lineTo(px, PAD.t + plotH)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = C.winEnd
    ctx.textAlign = 'right'
    ctx.fillText('window end', px - 4, PAD.t + 10)
    ctx.textAlign = 'left'
  }

  // strike line
  if (strike != null && strike > lo && strike < hi) {
    const py = Math.round(y(strike)) + 0.5
    ctx.strokeStyle = C.strike
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(PAD.l, py)
    ctx.lineTo(PAD.l + plotW, py)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = C.strike
    ctx.textAlign = 'left'
    ctx.fillText(`K ${fmtPrice(strike, 1)}`, PAD.l + 4, py - 4)
  }

  // price line
  ctx.strokeStyle = C.price
  ctx.lineWidth = 1.6
  ctx.beginPath()
  pts.forEach((p, i) => {
    const px = x(p.t)
    const py = y(p.price)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()
  ctx.lineWidth = 1

  // current dot
  const lastP = pts[pts.length - 1]
  ctx.fillStyle = C.price
  ctx.beginPath()
  ctx.arc(x(lastP.t), y(lastP.price), 3, 0, Math.PI * 2)
  ctx.fill()
  tag(g, y(lastP.price), fmtPrice(lastP.price, 1), C.price)

  // trade markers
  markers(g, t0, t1, (tr) => {
    const p = priceAt(tr.ts)
    return p == null ? null : y(p)
  })

  crosshair(g, t0, t1, mouse, (v) => [fmtClock(v.t), `BTC ${fmtPrice(v.price, 1)}`])
}

// ─── fair value vs ask chart ─────────────────────────────────────────────────

export function FvChart() {
  const ref = useRef<HTMLCanvasElement>(null)
  const mouse = useRef({ x: 0, on: false })

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const move = (e: MouseEvent) => {
      const r = c.getBoundingClientRect()
      mouse.current = { x: e.clientX - r.left, on: true }
    }
    const leave = () => (mouse.current.on = false)
    c.addEventListener('mousemove', move)
    c.addEventListener('mouseleave', leave)
    let raf = 0
    const loop = () => {
      drawFv(c, mouse.current)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      c.removeEventListener('mousemove', move)
      c.removeEventListener('mouseleave', leave)
    }
  }, [])

  return <canvas ref={ref} className="block h-[180px] w-full cursor-crosshair sm:h-[200px]" aria-label="Fair value versus Polymarket ask chart" role="img" />
}

function drawFv(c: HTMLCanvasElement, mouse: { x: number; on: boolean }): void {
  const g = setup(c)
  if (!g) return
  const { ctx, W, H } = g
  const t1 = Date.now()
  const t0 = t1 - VIEW_MS
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b

  const snap = useXarb.getState().snapshot
  const floor = useXarb.getState().settings.fvFloorC

  const pts = chartBuf.filter((p) => p.t >= t0)
  if (pts.length < 2) {
    ctx.fillStyle = C.label
    ctx.font = MONO
    ctx.textAlign = 'center'
    ctx.fillText('waiting for live data…', W / 2, H / 2)
    return
  }

  const y = (v: number) => PAD.t + (1 - v / 100) * plotH
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW

  drawTimeGrid(g, t0, t1)

  // y grid fixed 0..100
  ctx.font = MONO
  for (let v = 0; v <= 100; v += 25) {
    const py = Math.round(y(v)) + 0.5
    ctx.strokeStyle = C.grid
    ctx.beginPath()
    ctx.moveTo(PAD.l, py)
    ctx.lineTo(PAD.l + plotW, py)
    ctx.stroke()
    ctx.fillStyle = C.label
    ctx.textAlign = 'left'
    ctx.fillText(`${v}¢`, W - PAD.r + 4, py + 3)
  }

  // edge shading: per-column fill between FV and ask lines
  const stepPx = 2
  for (let px = PAD.l; px < PAD.l + plotW; px += stepPx) {
    const tA = t0 + ((px - PAD.l) / plotW) * (t1 - t0)
    const tB = t0 + ((px + stepPx - PAD.l) / plotW) * (t1 - t0)
    let fa: { t: number; fv: number; pmAsk: number } | null = null
    let fb: { t: number; fv: number; pmAsk: number } | null = null
    for (const p of pts) {
      if (p.t <= tA) fa = p
      if (p.t <= tB) fb = p
      if (p.t > tB && fa && fb) break
    }
    if (!fa || !fb || !fa.pmAsk || !fb.pmAsk) continue
    ctx.fillStyle = fa.fv > fa.pmAsk || fb.fv > fb.pmAsk ? C.posFill : C.negFill
    ctx.beginPath()
    ctx.moveTo(px, y(fa.fv))
    ctx.lineTo(px + stepPx, y(fb.fv))
    ctx.lineTo(px + stepPx, y(fb.pmAsk))
    ctx.lineTo(px, y(fa.pmAsk))
    ctx.closePath()
    ctx.fill()
  }

  // FV floor line
  const py = Math.round(y(floor)) + 0.5
  ctx.strokeStyle = C.floor
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(PAD.l, py)
  ctx.lineTo(PAD.l + plotW, py)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = C.floor
  ctx.textAlign = 'left'
  ctx.fillText(`floor ${floor}¢`, PAD.l + 4, py - 4)

  // PM ask line
  ctx.strokeStyle = C.ask
  ctx.lineWidth = 1.4
  ctx.beginPath()
  let drawingAsk = false
  pts.forEach((p) => {
    if (!p.pmAsk) {
      drawingAsk = false
      return
    }
    const px = x(p.t)
    const pyA = y(p.pmAsk)
    if (!drawingAsk) {
      ctx.moveTo(px, pyA)
      drawingAsk = true
    } else ctx.lineTo(px, pyA)
  })
  ctx.stroke()

  // FV line
  ctx.strokeStyle = C.fv
  ctx.lineWidth = 1.6
  ctx.beginPath()
  pts.forEach((p, i) => {
    const px = x(p.t)
    const pyF = y(p.fv)
    if (i === 0) ctx.moveTo(px, pyF)
    else ctx.lineTo(px, pyF)
  })
  ctx.stroke()
  ctx.lineWidth = 1

  // current tags
  const last = pts[pts.length - 1]
  if (last.pmAsk) tag(g, y(last.pmAsk), `${last.pmAsk.toFixed(1)}¢ ask`, C.ask)
  tag(g, Math.min(Math.max(y(last.fv), PAD.t + 8), PAD.t + plotH - 8), `${last.fv.toFixed(1)}¢ fv`, C.fv)

  // trade markers at fill price
  markers(g, t0, t1, (tr) => (tr.priceC > 0 && tr.priceC < 100 ? y(tr.priceC) : null))

  crosshair(g, t0, t1, mouse, (v) => [
    fmtClock(v.t),
    `FV ${v.fv.toFixed(1)}¢ · PM ${v.pmAsk ? v.pmAsk.toFixed(1) + '¢' : '—'}`,
    `edge ${v.edge >= 0 ? '+' : ''}${v.edge.toFixed(1)}¢`,
  ])
}
