// probe the TS engine's socket.io init payload: verify cdf model + fv detail fields
import { io } from 'socket.io-client'

const socket = io('http://127.0.0.1:3001', { transports: ['websocket'] })
const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 6000)

socket.on('init', (d) => {
  clearTimeout(t)
  console.log('model:', d.settings?.model)
  console.log('fv:', JSON.stringify(d.snapshot?.fv))
  console.log('window:', d.snapshot?.window?.slug, 'strike:', d.snapshot?.window?.strike)
  console.log('binance:', d.snapshot?.binance?.price, 'pm ask:', d.snapshot?.pm?.ask)
  socket.close()
  process.exit(0)
})
