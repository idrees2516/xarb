// ─── XARB engine service — entry (supervisor mode) ───────────────────────────
// This module runs under `bun --hot` as the BOOT-BLESSED process. Hot reloads
// discard timers created during module evaluation, so this file NEVER runs the
// engine itself — it only supervises children (each survives tool-call
// reaping because they descend from this process):
//   • engine-main.ts (bun, :3001) — the actual engine + socket.io server
//   • xarb-server (Rust core, :3002)
//   • Next.js dev server (:3000, only when the platform's own is down)
// All spawns are synchronous at module level with pidfile:gen ownership
// tokens; exit-respawn runs from the live event loop with backoff.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const ROOT = '/home/z/my-project'
const HERE = `${ROOT}/mini-services/xarb-engine`

type Sup = { child: any; crashes: number }
const g = globalThis as any

// ── shared pidfile helpers ────────────────────────────────────────────────────
function readPid(path: string): { pid: number; gen: string } {
  try {
    const [pid, gen] = readFileSync(path, 'utf8').trim().split(':')
    return { pid: Number(pid) || 0, gen: gen ?? '' }
  } catch {
    return { pid: 0, gen: '' }
  }
}
function writePid(path: string, pid: number, gen: string): void {
  try {
    writeFileSync(path, `${pid}:${gen}`)
  } catch { /* best-effort */ }
}
const newGen = () => Math.random().toString(36).slice(2, 8)

function makeSupervisor(opts: {
  key: string
  pidfile: string
  isAlive?: () => Promise<boolean>
  spawnArgs: () => { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }
  label: string
  /** Always supersede a previous instance on eval (dev iteration: reload
   *  the supervisor → fresh child with the newest code). */
  supersede?: boolean
}) {
  const store: Sup = (g[opts.key] ??= { child: null, crashes: 0 })
  const GEN = newGen()
  const launch = async () => {
    if (store.child && !opts.supersede) return
    if (store.child && opts.supersede && readPid(opts.pidfile).gen === GEN) return
    if (opts.isAlive && (await opts.isAlive())) {
      console.log(`[${opts.label}] already serving — not spawning`)
      return
    }
    const stale = readPid(opts.pidfile)
    if (stale.pid > 0 && stale.gen !== GEN) {
      try {
        // NOTE: no await here — timers scheduled during module evaluation
        // (bun --hot reloads) are DISCARDED, which would silently kill this
        // continuation and leave no replacement child. The old child's
        // graceful 1.5s shutdown overlaps with the new bind; an EADDRINUSE
        // on the new child self-heals via the live-loop respawn backoff.
        process.kill(stale.pid, 'SIGTERM')
      } catch { /* already dead */ }
    }
    try {
      const { cmd, args, cwd, env } = opts.spawnArgs()
      const child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      store.child = child
      writePid(opts.pidfile, child.pid ?? 0, GEN)
      // reload-eval console output is swallowed by bun --hot → tee child
      // output to a file so crashes are diagnosable
      const logPath = `${ROOT}/.zscripts/sup-${opts.label}.log`
      const tee = (d: any) => {
        try {
          appendFileSync(logPath, String(d))
        } catch { /* best-effort */ }
      }
      child.stdout?.on('data', tee)
      child.stderr?.on('data', tee)
      child.on('exit', (code) => {
        store.child = null
        store.crashes++
        const owner = readPid(opts.pidfile).gen
        if (owner && owner !== GEN) {
          console.log(`[${opts.label}] superseded by a newer module — not respawning`)
          return
        }
        const backoff = Math.min(1000 * 2 ** Math.min(store.crashes, 5), 30_000)
        console.log(
          `[${opts.label}] exited (${code}) — respawn in ${backoff}ms (crash #${store.crashes})`
        )
        setTimeout(launch, backoff)
      })
      console.log(`[${opts.label}] spawned pid=${child.pid}`)
    } catch (e) {
      store.child = null
      console.log(`[${opts.label}] spawn failed:`, String(e))
    }
  }
  void launch()
}

// ── 1. The TS engine itself (clean child process — timers fully alive) ────────
// Port 3011 — 3001 is held forever by a zombie listener from the original
// hot-reloaded module; the frontend follows via XTransformPort=3011.
makeSupervisor({
  key: '__xarbEngineChildSup',
  pidfile: '/tmp/xarb-engine-child.pid',
  supersede: true, // reload supervisor → fresh engine with newest code
  spawnArgs: () => ({ cmd: 'bun', args: ['engine-main.ts'], cwd: HERE }),
  label: 'engine',
})

// ── 2. Rust core (xarb-server, :3002) ─────────────────────────────────────────
makeSupervisor({
  key: '__xarbRsSupervisor3',
  pidfile: '/tmp/xarb-rs.pid',
  isAlive: async () => {
    try {
      const r = await fetch('http://localhost:3002/api/snapshot', {
        signal: AbortSignal.timeout(2000),
      })
      return r.ok
    } catch {
      return false
    }
  },
  spawnArgs: () => {
    const BIN = `${ROOT}/xarb-rs/target/release/xarb-server`
    if (!existsSync(BIN)) throw new Error('xarb-rs release binary not found')
    return { cmd: BIN, args: [], cwd: HERE, env: { XARB_PORT: '3002' } }
  },
  label: 'xarb-rs',
})

// ── 3. Next.js dashboard (only when the platform's own dev server is down) ────
makeSupervisor({
  key: '__xarbNextSupervisor',
  pidfile: '/tmp/xarb-next.pid',
  isAlive: async () => {
    try {
      const r = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(2500) })
      return r.ok
    } catch {
      return false
    }
  },
  spawnArgs: () => ({ cmd: 'bun', args: ['run', 'dev'], cwd: ROOT }),
  label: 'next',
})

console.log('[supervisor] xarb engine supervisor up (engine :3001 · rust :3002 · next :3000)')
// supervisor reload marker 1791777201
// kick1 1791777446
// kick3 1791777493
// reload 1791778615
// kick v05-universe 1791780687
// kick2 v05-warmstart 1791780802
