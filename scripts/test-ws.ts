// Connectivity test: Binance WS + Polymarket CLOB WS from Bun runtime
const UP_TOKEN = "17227529092123882269047339757825499703668873108236839946414338855752653008170";

// --- 1. Binance aggTrade WS ---
try {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@aggTrade");
  const t0 = performance.now();
  let n = 0;
  ws.onopen = () => console.log("[BINANCE] WS OPEN in", (performance.now() - t0).toFixed(0), "ms");
  ws.onmessage = (ev) => {
    if (n < 3) {
      const d = JSON.parse(ev.data as string);
      const feedLatency = Date.now() - d.T;
      console.log("[BINANCE] price:", d.p, "eventTime lag(ms):", feedLatency);
      n++;
    }
  };
  ws.onerror = (e) => console.log("[BINANCE] ERR", e);
  setTimeout(() => ws.close(), 8000);
} catch (e) {
  console.log("[BINANCE] FAIL", e);
}

// --- 2. Binance bookTicker WS ---
try {
  const ws2 = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@bookTicker");
  let m = 0;
  ws2.onmessage = (ev) => {
    if (m < 2) {
      const d = JSON.parse(ev.data as string);
      console.log("[BINANCE-BBT] bid:", d.b, "ask:", d.a);
      m++;
    }
  };
  ws2.onopen = () => console.log("[BINANCE-BBT] WS OPEN");
  setTimeout(() => ws2.close(), 8000);
} catch (e) {
  console.log("[BINANCE-BBT] FAIL", e);
}

// --- 3. Polymarket CLOB market WS ---
try {
  const ws3 = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
  ws3.onopen = () => {
    console.log("[CLOB] WS OPEN, subscribing...");
    ws3.send(JSON.stringify({ assets_ids: [UP_TOKEN], type: "market" }));
  };
  ws3.onmessage = (ev) => {
    const raw = ev.data as string;
    if (raw === "PONG") return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const d of arr.slice(0, 2)) {
          console.log("[CLOB]", d.event_type, "side:", d.side ?? "-", "px:", (d.price_level?.price ?? d.price ?? "-"), "sz:", (d.price_level?.size ?? d.size ?? "-"), "ts:", d.timestamp);
        }
      }
    } catch {
      console.log("[CLOB] raw:", raw.slice(0, 150));
    }
  };
  ws3.onerror = (e) => console.log("[CLOB] ERR", e);
  const ping = setInterval(() => { if (ws3.readyState === 1) ws3.send("PING"); }, 5000);
  setTimeout(() => { clearInterval(ping); ws3.close(); }, 12000);
} catch (e) {
  console.log("[CLOB] FAIL", e);
}

setTimeout(() => process.exit(0), 14000);
