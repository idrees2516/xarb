# Worklog

---
Task ID: 1
Agent: main (Super Z)
Task: Build working live-preview UI for the Binance→Polymarket 5m BTC latency-arb bot (XARB)

Work Log:
- Loaded fullstack-dev skill; initialized project env; verified socket.io-client install
- Connectivity tests: Binance WS/REST reachable (~30ms lag), Polymarket gamma API + CLOB WS + CLOB book REST all reachable from sandbox
- Discovered Polymarket 5m BTC market slug pattern: `btc-updown-5m-{floor(epoch/300)*300}` (chainlink TWAP resolution); reverse-engineered CLOB WS message schema empirically: book events use `bids`/`asks` arrays; updates are single objects `{price_changes:[{asset_id,price,size,side:BUY|SELL,best_bid,best_ask}]}`; `last_trade_price` carries live `fee_rate_bps`
- Built engine mini-service `mini-services/xarb-engine` (Bun + socket.io, port 3001):
  - `src/binance.ts`: combined WS (bookTicker+aggTrade), feed-latency ring (p50/p99), 1s-sampled realized vol, auto-reconnect + REST degradation fallback
  - `src/polymarket.ts`: gamma window discovery, CLOB WS book maintenance (Map-based ladder), PING/PONG keepalive + idle detection, REST book fallback, full socket roll on token change (fix: re-subscribing on an open socket does not deliver the new book)
  - `src/fairvalue.ts`: linear spec-calibrated model (52 + 0.19·sqrt(120/T)·(S−K); matches user's 55¢@+15pts / 77¢@+130pts) + normal-CDF model
  - `src/engine.ts`: 100ms tick loop + event-driven hot path on every market tick; 3-trigger AND (5s FV jump ≥20¢ ∧ FV>60¢ ∧ edge ≥10¢); guards (cooldown, max/window, min secs left, book freshness/depth); paper fills walk the live ask ladder; window rollover (settle → discover → resubscribe → strike at open); P&L/mark-to-model; latency rings
  - `index.ts`: socket.io server on path '/' (Caddy XTransformPort routing)
- Frontend (Next.js 16, port 3000):
  - `src/lib/xarb.ts`: types mirror, zustand store, socket singleton, module-level chart ring buffer
  - `src/components/xarb/charts.tsx`: two rAF canvas charts (BTC price w/ strike+markers; FV vs PM ask w/ edge shading + floor line), crosshairs, DPR-aware
  - `stat-cards.tsx` (6 live cards), `header.tsx` (feed badges, start/stop, settings), `panels.tsx` (trigger LEDs w/ progress, CLOB book ladder, measured latency panel), `feeds.tsx` (signal feed, trade blotter), `settings-sheet.tsx` (live params over socket)
  - `src/app/page.tsx` + layout + globals (dark terminal theme, custom scrollbars, sonner toasts)
- Bugs found & fixed:
  - zustand infinite loop: `?? []` in selector created new refs each call during null snapshot → stable EMPTY_LEVELS constant
  - strike sampled before first Binance price (strike=0) → wait-for-price loop in loadWindow
  - WS subscribe race on CONNECTING socket (InvalidStateError) → guarded send
  - vol EWMA stuck at floor (per-trade noise) → 1s-sampled log-return std
  - CLOB book empty after rollover (re-subscribe unreliable) → full socket roll on setToken + stale-socket onclose guard
- Verified via agent-browser through the Caddy gateway (port 81 — port 3000 direct bypasses XTransformPort routing):
  - page renders, live data flows (BTC ~83,000, FV, PM ask/bid, book ladder, latency: decision p50 0.8µs / p99 28µs, feed ~29ms)
  - settings sheet round-trips to engine (autoTrade toggle, engine start/stop logged)
  - VLM screenshot checks: desktop + mobile (390px) clean, charts drawn, no defects
  - engine survives window rollovers + idle-socket reconnects

Stage Summary:
- Deliverable: live XARB trading terminal preview (paper mode) — Next.js dashboard + Bun engine service, both running
- Engine: `mini-services/xarb-engine` (bun run dev, port 3001); dashboard on Next dev (port 3000) behind Caddy gateway
- All three live feeds working: Binance WS, Polymarket gamma discovery, Polymarket CLOB WS book
- Strategy engine implements the exact 3-condition spec with tunable parameters; paper fills walk the real live book

---
Task ID: 2
Agent: main (Super Z)
Task: End-to-end verification + resilience fixes + final QA

Work Log:
- Exercised full trade cycle with temporarily relaxed thresholds: EXECUTED signal (fv 54.4, ask 51, edge 3.4¢, filled 49 sh @ 51.0¢) → window settlement at rollover → LOST −$25.00 (final 82,951.99 vs strike 83,092.11) → stats/win-rate updated → client toast + blotter row
- Verified guards: max-trades-per-window, cooldown, momentum-but-repriced skip logging, watch near-miss logging
- Fixed idle-socket detection: split lastAliveAt (any msg incl PONG, 30s dead-socket threshold) from lastBookAt (book-affecting events → quote freshness / bookAgeMs / entry gating) — eliminates reconnect churn in quiet markets
- Hard-restarted engine (single clean instance); default spec thresholds auto-restored (jump 20¢ / floor 60¢ / edge 10¢ / minSecs 45)
- Verified browser socket.io auto-reconnect to restarted engine; live values resume (FV, PM ask/bid, book age 48ms)
- Final VLM QA on full-page screenshot: all 7 checks pass (branding/badges, 6 stat cards, 2 charts with drawn lines, trigger/book/latency panels, feeds/blotter, footer, no defects)
- lint clean; dev.log error line is historical (pre-fix Fast Refresh reload)

Stage Summary:
- XARB terminal fully verified end-to-end: live feeds → fair value → triggers → paper fill (book-walking) → settlement → P&L, with live tunable parameters
- Engine: mini-services/xarb-engine (bun, :3001) · UI: Next.js (:3000) · gateway: Caddy (:81)
- Ready for preview; paper mode only — real execution requires user's Polymarket CLOB credentials
