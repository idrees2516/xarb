# XARB · Rust Core

Cross-exchange latency arbitrage engine — **Binance BTC spot leads, Polymarket 5-minute
BTC UP/DOWN lags**. Rust frontend+backend, zero middle layers, real EIP-712 CLOB
order signing for local deployment.

```
Binance WS (bookTicker+aggTrade) ─┐
                                  ├─► hot path: FV → 3-trigger AND → fill
Polymarket CLOB WS (book ladder) ─┘        (inline, µs, zero hops)
                                                  │
                        paper: walk the live ask ladder
                        live:  EIP-712 signed BUY → POST /order (L2 HMAC)
```

## Layout

| crate            | role |
|------------------|------|
| `xarb-core`      | fair value (Normal CDF, spec-calibrated σ-floor), CLOB book, 5s-jump ring, percentiles |
| `xarb-feed`      | direct Binance combined WS, 1s realized vol (EWMA), REST degradation fallback, feed-lag rings |
| `xarb-poly`      | gamma window discovery (`btc-updown-5m-{epoch}`), CLOB WS book maintenance (PING/PONG, dead-socket, socket roll on rollover), REST fallback, **EIP-712 order signing + L1/L2 auth** |
| `xarb-engine`    | orchestration: hot-path evaluation, guards, paper book-walking fills, live order router, 5-min window lifecycle, settlement, 10Hz snapshot broadcast |
| `xarb-server`    | axum HTTP + WebSocket terminal (embedded `web/dashboard.html`) |

## Fair value model (tuned)

`P(UP) = Φ((S − K) / (σ_eff·√T))` with `σ_eff = max(σ_realized, 15.5)` BTC pts/√s.

- The **σ-floor is calibrated to the strategy spec**: +130 pts at T=120s → 77.8¢,
  +15 pts → 53.5¢ (user example: 77¢ / 55¢).
- Deep OTM is priced honestly — bounded 1–99¢, genuine tail time value, unlike the
  legacy linear spec (`52 + 0.19·(S−K)`) which blows through 0/100.
- Realized σ widens the distribution in momentum bursts (exactly when signals fire),
  so the model discounts deep moves instead of chasing them.
- The FV panel exposes `z`, `σ_eff`, and local slope (¢/pt) live.

## Run (paper — default)

```bash
cargo run --release            # http://127.0.0.1:3002
```

Feeds are live (Binance WS + Polymarket gamma + CLOB WS); fills are simulated by
walking the real ask ladder. Zero risk.

## Run (live — local deployment)

```bash
cp .env.example .env           # fill POLY_PRIVATE_KEY (+ optional API creds)
XARB_MODE=live cargo run --release
```

Startup then: derives your CLOB API key via EIP-712 `ClobAuth` (L1, GET
/auth/derive-api-key) → verifies L2 HMAC auth → on every full trigger, signs an
EIP-712 `Order` over the CTF Exchange domain (chain 137) and POSTs a **FOK**
(fill-or-kill) marketable BUY. `XARB_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK` is
mandatory — real USDC moves.

### Signing & execution details (verified against the official `clob-client`)

The EIP-712 scheme was cross-checked field-by-field against Polymarket's
reference TypeScript client (order structure, domains, headers, payload):

- `Order` typed data: 12 fields ending `uint8 side, uint8 signatureType`, signed
  over `Polymarket CTF Exchange/1`, chain 137, verifying contract
  `0x4bFb41d5…982E` (neg-risk markets switch to the Neg-Risk exchange).
- L1 derive-key: `ClobAuth(address, string timestamp, uint256 nonce, string
  message)` over the 3-field `ClobAuthDomain/1` chain-137 domain — the message is
  the fixed `"This message attests that I control the given wallet"` string.
- L2 HMAC: `HMAC-SHA256(base64-decoded secret, ts·method·path·body)` sent as
  URL-safe base64 **with** padding; `POLY_PASSPHRASE` is the passphrase (not the
  secret).
- POST /order body: official shape `{deferExec, order:{… salt as JSON number,
  big uints as strings, side "BUY"}, owner: <api key>, orderType: "FOK"}`.
- **Tick & fee are resolved per token** from the public `/tick-size` and
  `/fee-rate` endpoints (60s cache). The order's `feeRateBps` must equal the
  market's base fee exactly or the CLOB rejects it; the engine enforces this.

### Live-mode prerequisites
1. EOA wallet with USDC on Polygon + CTF Exchange allowance (Polymarket deposit flow).
2. `POLY_PRIVATE_KEY` — 32-byte hex. The engine derives the address and API creds itself.
3. Geographic eligibility for Polymarket; review their terms for automated trading.
4. Start with small `XARB_STAKE_USD`; watch the terminal's trade blotter.

## Fee reality (read before going live)

The 5-minute BTC UP/DOWN series currently carries a **1000 bps (10%) base taker
fee** (live-probed via `/fee-rate`; it also surfaces in the dashboard's Polymarket
feed card). On a BUY this is ≈ 10% of notional, i.e. ≈ 5.6¢ per share at a 56¢
entry. The gross edge trigger (`edgeThreshC`, default 10¢) does **not** net this
out — at the spec's 21¢ example gap the net edge is ≈ 15.4¢/share, but marginal
10–12¢ gaps can end near zero after fees. The engine accounts for the observed
market fee in paper P&L (WS-observed fee overrides the `takerFeeBps` setting) and
always carries the exact market fee on live orders. Size accordingly.

## API

- `GET /` — terminal dashboard
- `GET /ws` — `init` → 10Hz `snap` + `signal` + `settle` (inbound: `start/stop/reset/settings`)
- `GET /api/snapshot` — one-shot JSON
- `POST /api/control` — `{"type":"settings","settings":{"edgeThreshC":8}}`

## Tests

```bash
cargo test
```

Covers: spec-example calibration, deep-OTM tail honesty, A&S CDF reference values,
EIP-712 digest determinism, privkey→address known vector, sign/recover roundtrip
(EIP-2 low-s), u256 decimal codec, book ladder ops, jump ring semantics.

## Latency reality

The decision path (WS frame → parse → FV → trigger → paper fill-walk) runs inline
on the feed task with **zero channel hops**; p50 is single-digit µs, shown live in
the terminal. End-to-end reaction is dominated by network RTTs (~30 ms Binance,
~100–300 ms Polymarket) — the engine's own compute is noise at that scale.
"Picoseconds" are physically impossible cross-exchange; the design goal here is:
never let *our* code be the bottleneck.

## Risk notes

Paper P&L overstates live edge: real fills race other takers, pay the market's
taker fee (see above), and suffer adverse selection when the Polymarket book is
stale. The `maxBookAgeMs` guard and depth checks mitigate but do not eliminate
this. Settlement resolves on the Binance price at window close (Chainlink TWAP
on-chain). Nothing here is financial advice; the 3-trigger spec is a hypothesis —
validate on paper first.
