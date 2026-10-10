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

---
Task ID: 3
Agent: main (Super Z)
Task: ① Tune FV model to Normal CDF (honest deep-OTM pricing) ② deliver Rust core + real EIP-712 CLOB order-signing for local deployment

Work Log:
- FV tune (TS engine + UI): Normal CDF now the default model; σ-floor 15.5 pts/√s calibrated to the user's spec example (+130pts/T=120s → 77.8¢, +15pts → 53.5¢); snapshot gains sigmaEffPts/z; FV card shows z·σ_eff·slope; settings sheet reorders cdf-first
- CRITICAL bug found via new Rust unit tests: A&S 7.1.26 normCdf had a double-`t` multiplier (Φ(1)=0.871 vs 0.841) — biased the CDF model up everywhere. Fixed in BOTH fairvalue.ts (TS) and xarb-core/src/fv.rs; engine restarted
- Rust core (xarb-rs, 5-crate workspace):
  - xarb-core: FV models (Linear/NormalCdf), BTreeMap CLOB book, 5s FV-jump ring, percentiles, 11 tests
  - xarb-feed: Binance combined WS (bookTicker+aggTrade), 1s EWMA realized vol, REST degradation, feed-lag rings
  - xarb-poly: gamma discovery (btc-updown-5m-{epoch}), CLOB WS (PING/PONG, dead-socket, socket roll, REST fallback), EIP-712 order signing (CTF Exchange domain, keccak/k256, EIP-2 low-s, recovery), ClobAuth L1 derive-key, L2 HMAC headers, marketable BUY builder (6-dec raw amounts)
  - xarb-engine: event-driven hot path (inline decision, zero hops), guards, paper book-walking fills, live order router (spawned task), 5m window lifecycle (settle→discover→resubscribe), 10Hz snapshot broadcast
  - xarb-server: axum on :3002, embedded web/dashboard.html (dark terminal: charts, trigger LEDs, book, signals, blotter, settings over plain WS)
- rustup toolchain installed; cargo check → fixed 6 compile errors; cargo test → 17/17 pass; cargo build --release OK (8.4 MB binary)
- Runtime verified: Binance WS live (8.5k ticks/min, 31 ms lag), CLOB WS live, window rollover + socket roll + auto-reconnect after protocol error all exercised; decision p50 0.5µs / p99 6.9µs
- dashboard.html WS client forwards XTransformPort → Rust core also reachable through the preview gateway at /?XTransformPort=3002; VLM QA on screenshot: 4/4 checks clean
- GitHub: repo created (private) idrees2516/xarb; secrets scrubbed (token not committed, upload/tests/.zskills internal dirs untracked); 3 commits pushed; remote URL token scrubbed

Stage Summary:
- Normal-CDF FV is the default everywhere with honest bounded tails; normCdf math bug fixed in both engines
- Rust core delivered and RUNNING on :3002 (paper mode, live feeds, EIP-712 signing ready); local deployment = cp .env.example, set POLY_PRIVATE_KEY + XARB_MODE=live, cargo run --release
- Full stack live: Next.js terminal (:3000) + TS engine (:3001) + Rust core (:3002) behind Caddy gateway (:81); repo pushed to github.com/idrees2516/xarb (private)

---
Task ID: 4
Agent: main (Super Z)
Task: Session restart — verify xarb-rs integrity, re-validate EIP-712 against the official client, fix signing bugs, rebuild, re-push, restore live preview

Work Log:
- Sandbox reset wiped ~/.cargo, ~/.rustup and xarb-rs/target (rustup reinstalled; release rebuilt in 2m03s); repo intact with 1 unpushed commit (fed117a)
- Shallow-cloned Polymarket/clob-client (TS) + ctf-exchange; verified signing constants field-by-field:
  - ORDER_STRUCTURE = 12 fields ending `uint8 side, uint8 signatureType` — xarb-rs typehash was MISSING signatureType (orders could never verify on-chain) → FIXED
  - ClobAuth L1: 3-field domain (name/version/chainId, NO verifyingContract), message "This message attests that I control the given wallet", GET /auth/derive-api-key → FIXED domain + message + verb/path
  - L2 HMAC: URL-safe base64 with padding (was hex); POLY_PASSPHRASE = passphrase (was secret); base64url secret sanitization → FIXED
  - POST /order payload: official shape {deferExec, order:{salt JSON number, big uints as strings, side "BUY"}, owner, orderType:"FOK"} → FIXED
  - neg-risk exchange 0xC5d563A36AE78145C45a50134d48A1215220f80a CONFIRMED correct (matches official client config)
- Live-probed the CLOB from sandbox: gamma slug pattern still live (btc-updown-5m-1791606700), tick = 0.01, **base_fee = 1000 bps (10% taker fee)** on the 5m BTC series
- New ClobClient::tick_size()/fee_rate_bps() with 60s cache (public endpoints); post_buy_order resolves both and carries the exact market feeRateBps (mismatch = CLOB rejection); build_buy_order: tick-grid price CEIL (float-noise-safe: 0.56/0.01 = 56.000000000000005 → tolerance −1e-6), size floor 2dp, JSON-safe salt < 2^53
- Engine: hotpath passes WS-observed market fee (PmState.fee_rate_bps) into try_fire, overriding the settings knob for honest paper P&L; takerFeeBps clamp 500→2000; removed dead PmState.last_alive_at + unused imports → build warning-free
- New tests: signed_body_payload_shape (parses the exact REST JSON), tick-ceil rounding cases, base64url roundtrip, ClobAuth determinism → cargo test 19/19 green
- Rust server dies when spawned from tool calls (sandbox reaps process trees). Fix: bun engine (platform-supervised, PID 1203) now supervises the xarb-server binary as its child (mini-services/xarb-engine/index.ts, globalThis guard + stale-pid kill, hot-reload safe) → Rust core survives across tool calls on :3002
- Live verification: Binance WS 540 ticks/min (feed p50 29ms), window rollover btc-updown-5m-1791606600→…6900 worked (settle→discover→resubscribe), PM book age 12ms, FV 50–52¢ CDF ATM, decision latency p50 0.7µs / p99 4.4µs, no false triggers on negative edge
- Hygiene: untracked .env (was tracked; only DATABASE_URL ever committed, history swept clean of tokens) + .zscripts/ platform scripts; .gitignore expanded (.env, target/, *.pid, db/, upload/, …)
- Committed 312140f (10 files, +390/−93) and pushed to idrees2516/xarb (private) — verified via API; token used in push URL only, never stored
- Packaged download/xarb-rs-v0.2.1-src.tar.gz (60KB, target excluded)

Stage Summary:
- EIP-712 order signing now matches the official clob-client byte-for-byte in scheme (12-field typehash, ClobAuth L1, base64url L2 HMAC, official POST shape, per-token tick+fee)
- CRITICAL fee reality surfaced: 1000 bps taker fee on the 5m BTC series — README "Fee reality" section spells out the net-edge math; engine carries the live market fee on orders and in paper P&L
- Full preview stack healthy: Next.js :3000 · TS engine :3001 · Rust core :3002 (bun-supervised, survives reaping) · Caddy :81 (?XTransformPort=3002 → Rust terminal)
- Repo up to date at github.com/idrees2516/xarb (private, 5 commits); tests 19/19, release build warning-free
