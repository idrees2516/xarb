// ─── XARB engine service (child of the supervisor) ────────────────────────────
// socket.io server on :3011 (3011, not 3001: a zombie listener from the
// original bun --hot module holds 3001 and cannot be closed — this child owns
// a fresh port instead). The frontend connects via io('/?XTransformPort=3011').
// Runs as a plain bun process (NOT --hot) so every timer — the 10Hz loop, the
// window-load retries, the PM PING keepalive — is fully alive.

import { createServer } from 'node:http'
import { Server } from 'socket.io'

import { Engine } from './src/engine'
import type { ControlMsg, InitPayload } from './src/types'

const PORT = Number(process.env.XARB_ENGINE_PORT || 3011)

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
engine.onHedge = (e) => io.emit('hedge', e)
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
  setTimeout(() => process.exit(0), 1500)
})
process.on('SIGINT', () => {
  console.log('SIGINT, shutting down…')
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
})
