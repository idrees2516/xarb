// ─── XARB engine service ──────────────────────────────────────────────────────
// socket.io server on :3001. Frontend connects via io('/?XTransformPort=3001').

import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { Engine } from './src/engine'
import type { ControlMsg, InitPayload } from './src/types'

const PORT = 3001

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
