# XARB · Rust Core v0.4 — HFT Edition + δ-Hedge + σ Auto-Cal

Cross-exchange latency arbitrage engine — **Binance BTC spot leads, Polymarket 5-minute
BTC UP/DOWN lags**. Rust frontend+backend, zero middle layers, real EIP-712 CLOB
order signing for local deployment.

v0.3 rebuilds the decision path as a **pinned, lock-free, wait-free pipeline**: every
trigger condition is re-evaluated on **every opportunity** — on **both sides (UP and
DOWN)** — at spin cadence, with one atomic load + two AND + two compares.


## What v0.4 added — the strategy became a *hedged, profitability-gated, PM-calibrated* book

| capability | mechanism |
|------------|-----------|
| **σ-floor auto-calibration from live PM prices** | every fresh Polymarket print inverts the market's own mid into an implied σ (`σ = (S−K)/(Φ⁻¹(mid)·√τ)`) with an identifiability gate (|z| ≥ 0.35 — near-the-money mids cannot identify σ), robust-clamped EWMA, and a **dynamic floor** `max(abs_floor, 0.75·median(σ_imp history))`. While the book keeps printing identifiable quotes, a **print-time snap** pins FV to the market's own price — no phantom edge vs a live book. The snap is frozen at print time: during the reaction-lag window (book silent) FV floats with Binance and the edge vs the stale quote appears. |
| **δ-hedging the binary exposure on Binance** | on every fill the digital delta (`φ(d)/sd` BTC per share) is shorted (UP) / bought (DOWN) on the USDT-M perp — paper fills at the live Binance top-of-book, live via signed MARKET orders (`xarb-feed/src/fapi.rs`, HMAC-SHA256, `reduceOnly` flattens, testnet switch). Re-hedging runs the **Whalley–Wilmott no-trade band** `max(min_lot, c·(κ·S²·Γ)^⅓)` — the asymptotically optimal band under proportional transaction costs (widens with fee & gamma, capped at 30% of target). Wind-down at τ≤20s when the digital is decided; force-flatten at τ≤3s for clean settlement. |
| **Fractional hedge (the economically honest default)** | full replication of a 5-minute ATM digital costs ~the entire entry edge (notional-delta ≈ $170/share at σ 15.5). The default `hedgeRatio = 0.5` insures the hold at half the cost — Leland-style cost-aware hedging, tunable 0..1 from the dashboard. |
| **Net-edge profitability gate** | the strategy only fires when `edge − PM taker fee (bps·min(p,1−p)) − estimated hedge turnover cost ≥ minNetEdgeC`. At the live-observed 1000 bps fee, marginal 19¢ mid-gamma entries are REFUSED (honest!); deep discounted entries and 0-fee regimes clear. Every rejection is logged with its reason. |
| **Early-exit value capture** | when the PM bid re-converges to within `exitBandC` of FV and the locked edge ≥ `minCaptureC`, the binary is sold back (paper: bid ladder walk; live: EIP-712 FOK SELL) and the hedge is flattened — the mispricing is banked **without settlement risk and without paying into the expiry gamma explosion**. |
| **Zero-miss capture accounting** | distinct armed episodes of the 3-trigger conjunction are counted (rising edge), each receives an explicit FIRE-or-reason decision; `engineMissed = 0` is structural. The dashboard shows opportunities → fired → executed → capture ratio. |
| **Live combined P&L** | per-trade and aggregate: binary P&L + hedge P&L (exact cash-flow accounting) + PM fees + hedge fees; theoretical-vs-realized capture ratio. |

### The honest economics (why "profitable" is now a gate, not a hope)

Bought at a 20¢ discount with ~2 minutes left, the 5-minute digital sits at peak
gamma: its notional-delta is ~$170/share, so a full hedge round-trip at 4.5 bps
costs ~15¢/share. Add the observed 1000 bps PM taker fee (~4.4¢ at 56¢) and the
honest net edge of a mid-gamma entry is ~0. The engine knows this and refuses —
`R_NET_EDGE`. It fires when the entry is genuinely profitable after all modeled
frictions: deeper discounts, cheaper deltas (|d| > 1), lower fee regimes, or a
fractional hedge ratio. The test suite pins both behaviours
(`tests/hedge_scenario.rs`: profitable deep-edge capture @1000 bps AND
gate-rejection of the full-ratio mid-gamma entry).

```
Binance WS ──parse ~100ns──► SPSC ring ──► FV engine thread ──► HotWord (u64)
(pinned feed thread,          (wait-free,   (pinned, spin/eco,   single Release store
 own runtime, zero-DOM        zero alloc)   1ms decay cadence)        │
 hand-rolled scanner)                                            ┌───────▼────────┐
Polymarket CLOB WS ──► QuoteCells (u64) ──fold──┘                  │ strategy spin  │
(dual-token UP+DOWN,                                          │ 1 load+2×AND+  │
 ts16 reader-side freshness)                                  │ 2 cmp, ns-path │
                                                              └───────┬────────┘
                                                  FireIntent (Copy, zero-alloc)
                                                              ┌───────▼────────┐
                                                              │ executor thread │
                                                              │ revalidate→FOK │
                                                              │ paper ladder-   │
                                                              │ walk / EIP-712  │
                                                              └───────┬────────┘
  Cold task: 10Hz snapshots (ArcSwap<String>, wait-free reads), signals, stats,
  window lifecycle, risk settlement — never touches the hot path.
```

## What v0.3 changed (vs v0.2)

| v0.2 (tokio-tasks + mutexes)          | v0.3 (lock-free kernel)                                        |
|----------------------------------------|----------------------------------------------------------------|
| serde_json DOM parse (~2-4µs)          | zero-DOM hand-rolled scanner (~100ns) + DOM safety fallback     |
| unbounded channel wakeup per event     | wait-free SPSC ring, batched drain (up to 256 ev/iteration)     |
| 5+ mutex locks per evaluation          | zero locks: single-writer hot word + ArcSwap snapshots          |
| FV recompute on events only            | + 1ms time-decay cadence (FV drifts as √τ decays)               |
| VecDeque FV history, linear jump scan  | fixed 8192-slot ring, O(1) two-pointer 5s-jump                  |
| Vec sort for percentiles               | allocation-free log-scale LogHist (O(1) record)                 |
| UP side only                           | UP **and** DOWN (dual-token PM book, symmetric triggers)         |
| scheduler-owned threads                | pinned OS threads + own runtimes, WakeSlot wake bus, SCHED_FIFO  |
| syscall clock per event                | coarse clock: 1ns atomic read                                  |
| last-fire cooldown blocked first fire  | fired_once semantics + daily-loss kill switch + notional gates  |

Measured on the live preview sandbox (2 cores, **eco** park mode, no dedicated cores):
parse p50 3µs · FV recompute p50 **0.3µs** · detect p50 23µs (park-wake; **~50-200ns
in pure-spin mode on a dedicated core**) · decide sub-µs · ring drops 0 · DOM
fallbacks 0. On a 6+ core box the engine pins feed→core1, FV→core2, strategy→core3,
executor→core4 and spins (`XARB_SPINMODE=spin`).

## Layout

| crate            | role |
|------------------|------|
| `xarb-hft`       | **lock-free kernel**: SPSC ring, HotWord/QuoteCell bitpacking, LogHist, CachePadded, WakeSlot/park, CPU affinity, spin policies |
| `xarb-core`      | fair value (Normal CDF, spec-calibrated σ-floor), CLOB book, coarse clock (1ns `now_ms`), percentiles |
| `xarb-feed`      | pinned Binance feed thread, zero-DOM parser, SPSC producer, REST degradation fallback, 1s EWMA realized vol |
| `xarb-poly`      | gamma window discovery (`btc-updown-5m-{epoch}`), **dual-token** CLOB WS (UP+DOWN books, quote cells, ArcSwap snapshots), REST fallback, EIP-712 order signing + L1/L2 auth |
| `xarb-engine`    | FvCore (pure, testable state machine), FV thread, strategy spin thread, executor thread, risk gates, 10Hz lock-free snapshots, 5-min window lifecycle |
| `xarb-server`    | axum HTTP + WebSocket terminal (embedded `web/dashboard.html`, wait-free snapshot reads) |

## The three triggers (both sides)

A fire needs ALL of — evaluated continuously, never queued or coalesced:

1. **① 5s jump**: FV moved ≥ `jumpThreshC` (default 20¢) over the trailing 5s
   (O(1) two-pointer over the fixed history ring, needs ≥5s of window history)
2. **② floor**: FV > `fvFloorC` (default 60¢) — deep-enough moneyness
3. **③ gap**: Polymarket ask ≤ FV − `edgeThreshC` (default 10¢) on a **fresh**
   book (reader-side ts16 freshness, default ≤3s)

DOWN mirrors UP exactly (jump ≤ −thresh, FV_DOWN > floor, ask_DOWN ≤ FV_DOWN − edge).
Disable per side with `tradeDown`.

Guards (strategy thread, branchless): window open, feeds alive, τ ≥ min secs,
cooldown-after-first-fire, max trades/window, single open position, daily-loss
kill switch. The executor then **revalidates** (FV ≤300ms old, book fresh, ask still
clears half the original edge) before anything is sent — the last-mile
adverse-selection guard.

## Fair value model

`P(UP) = Φ((S − K) / (σ_eff·√T))` with `σ_eff = max(σ_realized, 15.5)` BTC pts/√s
(1s-sampled EWMA realized vol, folded into the hot word).

- The **σ-floor is calibrated to the strategy spec**: +130 pts at T=120s → 77.8¢,
  +15 pts → 53.5¢ (user example: 77¢ / 55¢).
- Deep OTM is priced honestly — bounded 1–99¢, genuine tail time value.
- FV is recomputed on every tick **and** every 1ms (time decay) — the two-pointer
  jump history is O(1) per update.
- The FV panel exposes `z`, `σ_eff`, and local slope (¢/pt) live; FV_DOWN = 100−FV_UP.

## Run (paper — default)

```bash
cargo run --release            # http://127.0.0.1:3002
```

Feeds are live (Binance WS + Polymarket gamma + CLOB WS dual-token); fills are
simulated by walking the real ask ladder. Zero risk.

### Thread topology & spin modes

`XARB_SPINMODE=spin|hybrid|eco` (auto: spin ≥4 cores, hybrid 3, eco ≤2).

- `spin` — pure PAUSE spin on dedicated cores: detect latency ~50-200ns. Burn one
  core per hot thread (production).
- `hybrid` — spin 5ms budget then park 1ms on the wake token.
- `eco` — fully event-driven park (producers unpark through `WakeSlot`s, token
  semantics = zero lost wakeups); detect ~5-30µs.

Core assignment (auto): feed→1, FV→2, strategy→3, executor→4, pm→5 (core 0 reserved).
SCHED_FIFO is attempted best-effort at boot.

## Run (live — local deployment)

```bash
cp .env.example .env           # fill POLY_PRIVATE_KEY (+ optional API creds)
XARB_MODE=live cargo run --release
```

Startup then: derives your CLOB API key via EIP-712 `ClobAuth` (L1, GET
/auth/derive-api-key) → verifies L2 HMAC auth → on every full trigger, signs an
EIP-712 `Order` over the CTF Exchange domain (chain 137) and POSTs a **FOK**
(fill-or-kill) marketable BUY on the fired side's token. `XARB_LIVE_CONFIRM=
I_UNDERSTAND_THE_RISK` is mandatory — real USDC moves.

### Signing & execution details (verified against the official `clob-client`)

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
- `GET /api/snapshot` — one-shot JSON (wait-free ArcSwap read)
- `POST /api/control` — `{"type":"settings","settings":{"edgeThreshC":8,"tradeDown":false}}`

## Tests

```bash
cargo test        # 56 tests
```

Covers: the user's spec example replayed deterministically through the pure FvCore
(all three triggers asserted + fired word), DOWN-side symmetry, reprice/stale-book/
closed-window/kill negative cases, 5s jump-reference semantics, the **full thread
chain** (hot word → strategy → fire ring → executor → paper fill → risk counters),
executor reprice rejection, SPSC ring stress (cross-thread, 100k, checksum),
LogHist percentiles, hot-word bitpacking roundtrips, reader-side ts16 freshness,
zero-DOM parser against real payloads (fast path ≡ DOM fallback), EIP-712 digest
determinism + recovery + payload shape, u256 codec, book ladder ops.

## Latency reality

Local pipeline (sandbox, eco mode): parse 3µs → ring hop (ns) → FV recompute 0.3µs
→ hot-word store (ns) → park-wake detect 23µs. In pure-spin on dedicated cores the
detect leg drops to ~50-200ns — the strategy thread sees every state change within
one cacheline transfer. End-to-end reaction is still dominated by network RTTs
(~30ms Binance, ~100-300ms Polymarket) — the engine's own compute is noise at that
scale. "Picoseconds" are physically impossible cross-exchange; the design goal is:
never let *our* code be the bottleneck, and never miss an opportunity because of
queuing, locking, or allocation.

## Risk notes

Paper P&L overstates live edge: real fills race other takers, pay the market's
taker fee (see above), and suffer adverse selection when the Polymarket book is
stale. The `maxBookAgeMs` guard, half-edge revalidation, and depth checks mitigate
but do not eliminate this. Settlement resolves on the Binance price at window close
(Chainlink TWAP on-chain; our strike/open is an approximation of the market's own
open). The kill switch halts fires at `maxDailyLossUsd` realized drawdown.
Nothing here is financial advice; the 3-trigger spec is a hypothesis — validate on
paper first.

---

## v0.4 environment knobs

| env | default | meaning |
|-----|---------|---------|
| `XARB_SIGMA_AUTO` | 1 | σ auto-calibration from live PM mids (0 = legacy fixed floor) |
| `XARB_SIGMA_W_IMP` | 0.65 | weight of implied σ in the blend |
| `XARB_SIGMA_ABS_FLOOR` | 6.0 | absolute σ sanity floor (pts/√s) |
| `XARB_HEDGE_ON` | 1 | δ-hedge the binary exposure on Binance |
| `XARB_HEDGE_RATIO` | 0.5 | fraction of delta hedged (1.0 = full replication) |
| `XARB_HEDGE_FEE_BPS` | 4.5 | Binance USDT-M taker fee used in cost model & paper P&L |
| `XARB_MIN_NET_EDGE_C` | 1.5 | minimum net edge (¢/share) after PM fee + hedge cost |
| `XARB_EXIT_BAND_C` | 2.0 | early-exit when PM bid ≥ FV − this |
| `XARB_MIN_CAPTURE_C` | 5.0 | minimum locked edge (¢ over entry) for an early exit |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | — | live futures hedge leg (paper mode never touches it) |
| `XARB_BINANCE_TESTNET` | 0 | 1 = Binance futures testnet for the hedge leg |

All knobs are also live-tunable from the dashboard (no restart). Run:
`cargo run --release -p xarb-server` (paper mode, :3002).
