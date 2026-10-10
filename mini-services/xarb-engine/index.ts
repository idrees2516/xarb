// ─── XARB engine service ──────────────────────────────────────────────────────
// socket.io server on :3001. Frontend connects via io('/?XTransformPort=3001').

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Server } from 'socket.io'
import { Engine } from './src/engine'
import type { ControlMsg, InitPayload } from './src/types'

const PORT = 3001

// ─── Rust core supervisor (preview infra) ─────────────────────────────────────
// The Rust terminal (xarb-server, :3002) runs as a child of this long-lived
// bun process so it survives sandbox process reaping between tool calls.
// No-op when the release binary is absent. Guarded on globalThis so bun --hot
// reloads never double-spawn; a stale pid file kills the previous instance.
const g = globalThis as any
if (!g.__xarbRsSupervisor) {
  g.__xarbRsSupervisor = true
  const BIN = '/home/z/my-project/xarb-rs/target/release/xarb-server'
  const PIDFILE = '/tmp/xarb-rs.pid'
  if (existsSync(BIN)) {
    try {
      const stale = Number(readFileSync(PIDFILE, 'utf8').trim())
      if (stale > 0) process.kill(stale, 'SIGTERM')
    } catch { /* no stale instance */ }
    setTimeout(() => {
      try {
        const child = spawn(BIN, [], {
          env: { ...process.env, XARB_PORT: '3002' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        writeFileSync(PIDFILE, String(child.pid))
        child.stdout?.on('data', (d) => console.log('[xarb-rs]', String(d).trim()))
        child.stderr?.on('data', (d) => console.error('[xarb-rs]', String(d).trim()))
        child.on('exit', (code) => console.log(`[xarb-rs] exited (${code})`))
        console.log(`[supervisor] xarb-rs spawned pid=${child.pid} on :3002`)
      } catch (e) {
        console.log('[supervisor] xarb-rs spawn failed:', String(e))
      }
    }, 1000)
  } else {
    console.log('[supervisor] xarb-rs release binary not found — TS engine only')
  }
}

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

const engine = new Engine()
engine.onSnap = (s) => io.emit('snap', s)
engine.onSignal = (sig) => io.emit('signal', sig)
engine.onSettle = (t) => io.emit('settle', t)
engine.start()

io.on('connection', (socket) => {
  console.log(`[ws] client ${socket.id} connected`)
  const init: InitPayload = engine.buildInit()
  socket.emit('init', init)

  socket.on('control', (msg: ControlMsg) => {
    try {
      engine.control(msg)
      io.emit('init', engine.buildInit())
    } catch (e) {
      console.log('[ws] control error', String(e))
    }
  })

  socket.on('disconnect', () => {
    console.log(`[ws] client ${socket.id} disconnected`)
  })
})

httpServer.listen(PORT, () => {
  console.log(`[xarb-engine] listening on :${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('SIGTERM, shutting down…')
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('SIGINT, shutting down…')
  httpServer.close(() => process.exit(0))
})
