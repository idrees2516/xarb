# polyarb — Polymarket × Binance BTC 5-minute UP-share arbitrage

> The whole thing fits in one line: **when to buy, at what price and how fast.**

A latency-arbitrage bot that watches Binance BTCUSDT, computes what the
Polymarket "Bitcoin Up or Down" 5-minute UP share should cost *right now*,
and the moment the fair value **jumps 20c+ within 5 seconds, clears 60c,
while Polymarket still asks 10c+ less** — buys in that same second.

Backend **and** frontend are 100% Rust. The hot path is hand-built
lock-free and busy-spinning on a pinned core; the dashboard is a Leptos
app compiled to WASM (no JavaScript was written in the making of this repo).

---

## The strategy, precisely

For the current 5-minute window with strike `K` (the open price), spot
`S` (Binance), and `τ` seconds left, the UP share is a digital option:

```
FV(UP) = N(d2),   d2 = ( ln(S/K) − ½σ²τ ) / ( σ√τ )
```

The tweet's trigger, verbatim:

| gate                  | default | meaning                                   |
|-----------------------|---------|-------------------------------------------|
| FV jump over 5s       | ≥ 20c   | Binance moved sharply (the "event")       |
| FV level              | ≥ 60c   | momentum confirmation (buy favorites)     |
| PM ask vs FV          | ≤ FV−10c| Polymarket hasn't repriced yet            |
| act                   | same second | FAK limit buy at the ask (+ ≤3c chase) |

Plus the symmetric DOWN leg: a 20c FV *drop* with FV(DOWN) ≥ 60c and a
DOWN ask 10c+ cheap → buy DOWN.

**Why the edge exists (and when it doesn't).** Polymarket's 5-minute books
are quoted by market makers whose bots track Binance with a reaction lag
(hedge refresh cadence, compute, network). A sharp Binance move inside the
window reprices the digital instantly in closed form; the PM book lags for
hundreds of milliseconds. Whoever reprices faster buys the stale quote.
The `sim` command contains the controlled experiment (seed 42, 30 windows,
same price path in both runs):

| market-maker lag | signals | PnL      |
|------------------|---------|----------|
| 500 ms           | 71      | **+$261.50** |
| 0 ms (control)   | 65      | **−$26.00**  |

**The edge is exactly the lag.** Kill the lag and the strategy pays the
spread (adverse-selection residue).

**Honest limits** (see also *Reality check* below): competition shrinks the
lag, fills are subject to adverse selection (the level may vanish), the
5m series resolves on **Chainlink BTC-USD TWAP** while the bot's
observable is Binance BTCUSDT (small basis risk), and a 20c jump that
reverts before the window closes can still lose. This is a latency game
with real opponents, not a money printer.

---

## Architecture

```
┌────────────┐   combined stream    ┌──────────────────────────────────┐
│  Binance    │  (trade+bookTicker) │  FEED TASKS (tokio)              │
│  WebSocket  ├─────────────────────►  serde_json → wire::FeedEvent    │
└────────────┘                      └───────────┬──────────────────────┘
┌────────────┐   book/price_change             │ SPSC rings (no locks,
│ Polymarket  ├────────────────────────────────►│ no allocs, cache-padded)
│ market WS   │  + REST /book bootstrap        │
└────────────┘                      ┌───────────▼──────────────────────┐
┌────────────┐   Gamma discovery    │  ENGINE THREAD                   │
│ Window mgr  ├─────────────────────►  pinned core, busy-spin,          │
│ (5m slug)   │  InstallWindow      │  SCHED_FIFO if allowed            │
└────────────┘                      │  · LevelBook (fixed 64 levels)   │
                                    │  · EwmaVol → FV (BS digital)     │
                                    │  · Strategy: jump/gate/edge      │
                                    │  · Risk: caps, cooldown, kill    │
                                    └───┬───────────────┬──────────────┘
                             OrderReq │ SPSC            │ SeqLock<DashState>
                                    ┌───▼──────┐   ┌────▼───────────┐
                                    │ EXECUTOR │   │ TELEMETRY      │
                                    │ paper:   │   │ 10 Hz frames → │
                                    │  fill vs │   │ broadcast → WS │
                                    │  live:   │   │ + JSONL/CSV log │
                                    │  EIP-712 ├─┐ └────┬───────────┘
                                    │  sign+   │ │      │
                                    │  POST    │ │ ┌────▼───────────┐
                                    └──────────┘ │ │ AXUM SERVER    │
                                 ack/fill ring──┘ │  /ws  /api/*    │
                                                  │  static (WASM)  │
                                                  └────┬───────────┘
                                                  ┌────▼───────────┐
                                                  │ LEPTOS UI      │
                                                  │ pure Rust→WASM │
                                                  └────────────────┘
```

Every hot-path structure is `Copy` and fixed-size: `wire::FeedEvent` (48 B),
`wire::OrderReq`, `wire::DashState` (12 KB, published at 10 Hz through a
seqlock). The engine thread never allocates, never takes a lock, and never
parses JSON — venue parsing happens on the feed tasks.

### Workspace layout

| crate       | role                                                        |
|-------------|-------------------------------------------------------------|
| `wire`      | shared Copy types + binary telemetry codec (native & wasm)  |
| `hotcore`   | SPSC ring, TSC cycle clock, seqlock, log-histogram          |
| `pricing`   | BS digital FV, erf, EWMA vol, implied σ                     |
| `strategy`  | 5s jump window, gates, reject taxonomy (pure functions)     |
| `feeds`     | Binance WS, Polymarket WS/books, Gamma discovery            |
| `clob`      | EIP-712 order signing, L1/L2 auth, HTTP/2 client, ladder    |
| `engine`    | pinned core loop, risk, paper executor, window lifecycle    |
| `sim`       | lagging-MM synthetic world + latency benchmark harness      |
| `server`    | axum: /ws telemetry, /api/kill, embedded UI                 |
| `ui`        | Leptos CSR dashboard (Rust → WASM, zero JS)                 |
| `cli`       | the `polyarb` binary                                        |

---

## Latency: measured, not promised

`polyarb bench` (release build, this repo's 2-vCPU sandbox, TSC @ 3.2 GHz):

```
micro (ns/op)                     pipeline                    threaded (rings + pinned engine)
  erf (A&S)          0.3            1.52M events/s              ring hop  p50    560 ns
  norm_cdf           0.3            657 ns/event                tick->signal p50 1.3 µs
  fv_up (BS digital) 1.1              (fv + strategy +          tick->signal p99 1.3 µs
  strategy evaluate  53               book + dash)
  SPSC ring push+pop 0.8
  keccak256 (416 B)  1.3 µs        order path
  ECDSA sign         38 µs           sign-on-fire   ≈ 42 µs  (ECDSA dominates)
  order build+render 42 µs           pre-signed ladder ≈ 0 ns  (body already serialized)
```

What that means for the tweet's "same second":

| segment                              | budget        |
|--------------------------------------|---------------|
| Binance tick → signal emitted        | **~1.3 µs** (bench) / **4.5 µs p50** (full sim stack) |
| signal → order bytes ready           | ~42 µs sign-on-fire / ~0 with ladder |
| engine → Polymarket ack              | network RTT (~50–200 ms; physics) |

In-process decision latency is **three orders of magnitude under 1 ms**;
"picosecond-level" is marketing, but the TSC clock does resolve 0.31 ns
and the micro-benchmarks are measured at that resolution. The tail
latency on this sandbox (p99 ~15 ms) is cgroup throttling of the spinning
thread in a shared container — on dedicated cores with the engine pinned
away from the feed threads, the tail collapses (p50/p99 in the sim runs:
4.5/12.7 µs end-to-end).

---

## The math, and one honest discrepancy

With σ ≈ 1.3e-4/s (≈0.23% per 5-minute window) the tweet's scenario prices
out as: 83,215 → FV 55c; 83,330 → FV **86c** (not 77c). The tweet's two
anchor numbers are mutually inconsistent by ~9c — with its own slope
(22c/115 points ≈ 0.19c/point) the level would be ~52c at +15. The
`EmpiricalLinear` model (`model = "linear"`) encodes the tweet-style
cents-per-point mapping if you prefer that semantics; Black-Scholes is the
default because it prices time-left correctly (the same 115 points matter
3× more with 30 seconds left than with 4 minutes left).

`sigma_mode`:

- `fixed` (default) — tweet semantics; the mapping is stable during the
  very 5 seconds you act in.
- `live` — EWMA from the trade stream. Caution: a one-directional 5-second
  rally *raises* estimated vol, which *flattens* FV — the opposite of the
  arb's premise. That's why `fixed` is default.
- `blend` — 50/50.

## Quickstart

```bash
# 0) Rust (1.75+)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 1) discover the live market (real Gamma API, no keys needed)
cargo run --release -p cli -- discover
cargo run --release -p cli -- book            # live PM UP order book

# 2) paper trade with the dashboard (http://localhost:8080)
cargo run --release -p cli -- run            # paper mode by default

# 3) the controlled experiment (edge vs no-edge)
cargo run --release -p cli -- sim --windows 30 --lag-ms 500 --speed 100
cargo run --release -p cli -- sim --windows 30 --lag-ms 0   --speed 100

# 4) latency evidence
cargo run --release -p cli -- bench

# 5) (optional) build the WASM dashboard
./scripts/build-ui.sh
```

### Going live (your keys, your risk)

```bash
export POLY_PK=0x...            # Polygon wallet private key
polyarb doctor                  # L2 auth derivation + USDC balance/allowance
polyarb run --mode live --i-understand-live-trading-risks
```

Requirements verified against Polymarket's own clients
(`py-clob-client`, `py-order-utils`, sources vendored in `/reference`):
USDC.e on Polygon, exchange + CTF allowances (set once via the Polymarket
UI), FAK orders via `POST /order` with EIP-712 signatures over the CTF
Exchange domain. The binary defaults to paper mode and refuses live mode
without the explicit confirmation flag.

---

## Reality check (read before trading)

1. **$700/day is not a property of this code.** The tweet's wallet link
   was truncated, so the claim is unverifiable; the strategy class is
   real, but returns depend on how slow the opposition is *today*.
2. **Resolution basis**: the live 5m series resolves on Chainlink
   BTC-USD TWAP (60s streams), not the Binance trade feed the bot
   observes. The difference is usually a few bps of price, but it is a
   real short-term basis. `strike_source` allows capturing the strike
   from the window-open mark (default) — same approximation the market
   makers make.
3. **Adverse selection**: the paper executor validates fills against the
   *live* book after the simulated network latency — stale levels that
   vanished are missed, not magically filled. The sim also models
   other-flow consuming the cheap level before you.
4. **Fees/rebates**: Polymarket CLOB charges zero maker fees; taker fees
   on these markets are 0 bps at the time of writing — verify on their
   fee schedule before sizing up.
5. **Kill switch**: `POST /api/kill` or the dashboard button. Max
   position, per-window trade cap, cooldown, daily loss stop and stale-feed
   guards are all in force.
6. This code is **not financial advice**; it's an engineering artifact.
