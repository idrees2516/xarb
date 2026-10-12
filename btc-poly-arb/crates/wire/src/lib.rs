//! wire — shared, dependency-free types crossing process boundaries.
//!
//! This crate is the single source of truth for every struct that travels:
//!   feed task  --SPSC ring-->  engine thread  (FeedEvent)
//!   control    --SPSC ring-->  engine thread  (CtlEvent / WindowCtx)
//!   engine     --SPSC ring-->  executor task  (OrderReq)
//!   engine     --SeqLock-->    telemetry task  (DashState)
//!   telemetry  --WebSocket-->  WASM dashboard  (Frame, binary little-endian)
//!
//! Everything is `Copy` and fixed-size: the hot path never allocates.
//! The same crate compiles natively (server/engine) and to wasm32 (UI).

#![forbid(unsafe_code)]

pub mod codec;

/// u256 as four little-endian limbs (Polymarket outcome token ids are u256).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Hash)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0, 0, 0, 0]);

    /// Parse from a decimal string (Gamma `clobTokenIds` are decimal strings).
    pub fn from_dec(s: &str) -> Option<U256> {
        let mut limbs = [0u64; 4];
        if s.is_empty() || s.len() > 78 {
            return None;
        }
        for ch in s.bytes() {
            let d = (ch as char).to_digit(10)? as u64;
            // limbs *= 10
            let mut carry: u128 = 0;
            for limb in limbs.iter_mut() {
                let v = (*limb as u128) * 10 + carry;
                *limb = v as u64;
                carry = v >> 64;
            }
            if carry != 0 {
                return None; // overflow
            }
            // limbs += d
            let mut carry: u128 = d as u128;
            for limb in limbs.iter_mut() {
                let v = (*limb as u128) + carry;
                *limb = v as u64;
                carry = v >> 64;
                if carry == 0 {
                    break;
                }
            }
            if carry != 0 {
                return None;
            }
        }
        Some(U256(limbs))
    }

    /// Decimal string (used by the CLOB REST payloads).
    pub fn to_dec(self) -> String {
        if self.0 == [0, 0, 0, 0] {
            return "0".to_string();
        }
        let mut digits = Vec::with_capacity(78);
        let mut limbs = self.0;
        while limbs != [0, 0, 0, 0] {
            // divide by 10, collect remainders
            let mut rem: u128 = 0;
            for limb in limbs.iter_mut().rev() {
                let cur = (rem << 64) | (*limb as u128);
                *limb = (cur / 10) as u64;
                rem = cur % 10;
            }
            digits.push(b'0' + rem as u8);
        }
        digits.reverse();
        String::from_utf8(digits).unwrap()
    }

    /// Big-endian 32 bytes (EIP-712 word encoding).
    pub fn to_be_bytes(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..4 {
            out[i * 8..i * 8 + 8].copy_from_slice(&self.0[3 - i].to_be_bytes());
        }
        out
    }

    pub fn from_be_bytes(b: &[u8; 32]) -> U256 {
        let mut limbs = [0u64; 4];
        for i in 0..4 {
            let mut w = [0u8; 8];
            w.copy_from_slice(&b[i * 8..i * 8 + 8]);
            limbs[3 - i] = u64::from_be_bytes(w);
        }
        U256(limbs)
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0, 0, 0, 0]
    }
}

/// Token slots inside the Polymarket books we maintain.
pub const TOK_UP: u8 = 0;
pub const TOK_DOWN: u8 = 1;
/// Book sides. Polymarket WS "side" strings map: BUY => bid, SELL => ask.
pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

pub const DIR_UP: u8 = 0;
pub const DIR_DOWN: u8 = 1;

/// Events pushed by feed tasks into the engine ring. All fixed-size Copy.
#[derive(Clone, Copy, Debug)]
pub enum FeedEvent {
    /// Binance aggTrade / trade print.
    BinanceTrade {
        t_ns: i64,
        ex_ms: i64,
        price: f64,
        qty: f64,
        aggressor_buy: bool,
        id: u64,
    },
    /// Binance bookTicker update (best bid/ask with sizes).
    BinanceBook {
        t_ns: i64,
        bid: f64,
        bid_sz: f64,
        ask: f64,
        ask_sz: f64,
        u: u64,
    },
    /// Polymarket book reset (full snapshot follows as a burst of PmLevel).
    PmReset { t_ns: i64, token: u8 },
    /// Polymarket book level delta (price in cents, size in shares; 0 size removes).
    PmLevel {
        t_ns: i64,
        token: u8,
        side: u8,
        price_c: i64,
        size_sh: f64,
    },
    /// Polymarket stream gap detected — books marked suspect.
    PmGap { t_ns: i64, token: u8 },
}

/// WindowCtx: the currently traded 5-minute market (Copy, hot-path safe).
#[derive(Clone, Copy, Debug, Default)]
pub struct WindowCtx {
    pub seq: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub condition: [u8; 32],
    pub token_up: U256,
    pub token_down: U256,
    /// tick size in cents (0.01 -> 1)
    pub tick_c: i64,
    pub min_size: f64,
    pub neg_risk: bool,
    /// strike (window open price); 0.0 until captured from the feed
    pub strike: f64,
}

impl WindowCtx {
    pub fn is_live(&self) -> bool {
        !self.token_up.is_zero()
    }
}

/// Executor -> engine control events (acks, fills).
#[derive(Clone, Copy, Debug)]
pub enum CtlEvent {
    InstallWindow(WindowCtx),
    ClearWindow { reason: u8 },
    /// Order accepted by CLOB (or paper book). order_id is truncated to u64.
    OrderAck { seq: u64, status: u8, ts_ns: i64, order_id: u64 },
    /// Order rejected/failed. code semantics in `ORD_REJ_*`.
    OrderRejected { seq: u64, code: u8, ts_ns: i64 },
    /// Fill (live from user stream).
    Fill { seq: u64, dir: u8, sh: f64, px_c: f64, ts_ns: i64, live: bool },
    /// Paper fill attempt arriving after simulated latency — the engine
    /// validates it against the CURRENT book (the level may be gone).
    FillAttempt { seq: u64, dir: u8, sh: f64, limit_c: i64, ts_ns: i64 },
    /// Latency sample from the executor thread (stage 4 = order_build).
    LatencySample { stage: u8, ns: u64 },
    Shutdown,
}

pub const ORD_REJ_NET: u8 = 1;
pub const ORD_REJ_AUTH: u8 = 2;
pub const ORD_REJ_MARKET: u8 = 3;
pub const ORD_REJ_TIMEOUT: u8 = 4;
pub const ORD_REJ_UNKNOWN: u8 = 5;

/// Order request: engine -> executor ring.
#[derive(Clone, Copy, Debug)]
pub struct OrderReq {
    pub seq: u64,
    pub ts_ns: i64,
    pub token: U256,
    pub dir: u8,
    /// limit price in integer cents
    pub limit_c: i64,
    pub size_sh: f64,
    pub ask_at_signal_c: i64,
    pub ask_sz_at_signal: f64,
    pub live: bool,
    pub tick_c: i64,
    pub neg_risk: bool,
    /// FV at signal time (dollars)
    pub sig_fv: f64,
    /// edge at signal time (dollars)
    pub sig_edge: f64,
}

/// Strategy signal record (telemetry ring element).
#[derive(Clone, Copy, Debug, Default)]
pub struct SigRec {
    pub t_ns: i64,
    pub seq: u64,
    pub dir: u8,
    /// fv at signal (dollars)
    pub fv: f64,
    /// best ask at signal (dollars)
    pub ask: f64,
    /// fv - ask (dollars)
    pub edge: f64,
    /// 5s fv jump (dollars)
    pub jump: f64,
}

/// Order lifecycle record (telemetry ring element).
#[derive(Clone, Copy, Debug, Default)]
pub struct OrdRec {
    pub t_ns: i64,
    pub seq: u64,
    pub dir: u8,
    pub limit_c: i64,
    pub sh: f64,
    /// 0=sent,1=acked,2=filled,3=partial,4=rejected,5=timeout
    pub status: u8,
    pub fill_sh: f64,
    pub avg_px_c: f64,
}

/// Per-window stats record.
#[derive(Clone, Copy, Debug, Default)]
pub struct WinRec {
    pub start_ms: i64,
    /// realized pnl in cents
    pub pnl_c: f64,
    pub trades: u32,
    pub sigs: u32,
}

/// Single latency stage stats.
#[derive(Clone, Copy, Debug, Default)]
pub struct LatStats {
    pub p50_ns: u64,
    pub p99_ns: u64,
    pub max_ns: u64,
    pub n: u64,
}

/// Engine mode.
pub const MODE_PAPER: u8 = 0;
pub const MODE_LIVE: u8 = 1;
pub const MODE_SIM: u8 = 2;

/// Window phase from the engine's point of view.
pub const PHASE_NONE: u8 = 0;
pub const PHASE_PRE: u8 = 1;
pub const PHASE_TRADE: u8 = 2;
pub const PHASE_SETTLE: u8 = 3;

pub const CHART_N: usize = 256;
pub const SIG_RING: usize = 64;
pub const ORD_RING: usize = 64;
pub const WIN_RING: usize = 32;
pub const LAT_STAGES: usize = 6;

/// Stage names for LAT_STAGES slots.
pub const LAT_STAGE_NAMES: [&str; LAT_STAGES] = [
    "ws_recv->ring",   // feed: message received to event pushed
    "ring->engine",    // engine: pop to first touch
    "fv_compute",      // pricing: mark -> fv
    "strategy_eval",   // full strategy evaluation
    "order_build",     // exec: pop to bytes-ready (incl. ECDSA in live)
    "tick->signal",    // end-to-end binance tick arrival to signal emitted
];

/// Full dashboard state — published by the engine via SeqLock at ~10 Hz,
/// encoded by the telemetry task, decoded inside the WASM UI.
#[derive(Clone, Copy, Debug)]
pub struct DashState {
    pub t_ns: i64,
    pub wall_ms: i64,
    pub mode: u8,
    pub kill: bool,
    pub window_phase: u8,
    pub window_seq: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub tau_s: f64,
    pub strike: f64,

    pub mark: f64,
    pub bb_bid: f64,
    pub bb_ask: f64,
    pub bb_sz_bid: f64,
    pub bb_sz_ask: f64,

    pub fv: f64,
    pub fv_5s_ago: f64,
    pub jump: f64,
    pub sigma: f64,
    pub delta: f64,

    /// Polymarket UP/DOWN books (dollars).
    pub up_bid: f64,
    pub up_bid_sz: f64,
    pub up_ask: f64,
    pub up_ask_sz: f64,
    pub dn_bid: f64,
    pub dn_bid_sz: f64,
    pub dn_ask: f64,
    pub dn_ask_sz: f64,
    /// implied UP ask from DOWN bid (1 - dn_bid) — staleness cross-check
    pub up_ask_impl: f64,

    /// fv - best_ask (dollars)
    pub edge_up: f64,
    pub edge_dn: f64,
    /// fv - pm mid (dollars)
    pub spread_up: f64,

    pub pos_up_sh: f64,
    pub pos_dn_sh: f64,
    pub avg_up: f64,
    pub avg_dn: f64,
    /// cents
    pub realized_c: f64,
    pub unrealized_c: f64,
    pub equity_c: f64,

    pub trades_today: u32,
    pub windows_done: u32,
    pub signals_today: u32,
    pub in_flight: u8,
    pub cooldown_left_s: f64,

    pub feed_bin_age_ms: i64,
    pub feed_bin_msgs: u64,
    pub feed_bin_gaps: u64,
    pub feed_pm_age_ms: i64,
    pub feed_pm_msgs: u64,
    pub evals: u64,
    /// reject counters indexed by reject reason (see strategy crate)
    pub rejects: [u64; 8],

    pub lat: [LatStats; LAT_STAGES],

    // effective config echo
    pub cfg_jump: f64,
    pub cfg_gate: f64,
    pub cfg_edge: f64,
    pub cfg_size_sh: f64,
    pub cfg_max_pos: f64,
    pub cfg_min_tau: f64,
    pub cfg_cooldown: f64,
    pub cfg_model: u8,
    pub cfg_exit: u8,
    pub cfg_trade_down: bool,

    // rings (newest last, head = number of valid entries)
    pub sigs: [SigRec; SIG_RING],
    pub sig_head: u32,
    pub ords: [OrdRec; ORD_RING],
    pub ord_head: u32,
    pub wins: [WinRec; WIN_RING],
    pub win_head: u32,

    // chart ring: mark / fv / pm up_ask, shared time axis implied
    pub chart_mark: [f64; CHART_N],
    pub chart_fv: [f64; CHART_N],
    pub chart_ask: [f64; CHART_N],
    pub chart_head: u32,
}

impl Default for DashState {
    fn default() -> Self {
        DashState {
            t_ns: 0,
            wall_ms: 0,
            mode: MODE_PAPER,
            kill: false,
            window_phase: PHASE_NONE,
            window_seq: 0,
            start_ms: 0,
            end_ms: 0,
            tau_s: 0.0,
            strike: 0.0,
            mark: 0.0,
            bb_bid: 0.0,
            bb_ask: 0.0,
            bb_sz_bid: 0.0,
            bb_sz_ask: 0.0,
            fv: 0.5,
            fv_5s_ago: 0.5,
            jump: 0.0,
            sigma: 0.0,
            delta: 0.0,
            up_bid: 0.0,
            up_bid_sz: 0.0,
            up_ask: 0.0,
            up_ask_sz: 0.0,
            dn_bid: 0.0,
            dn_bid_sz: 0.0,
            dn_ask: 0.0,
            dn_ask_sz: 0.0,
            up_ask_impl: 0.0,
            edge_up: f64::NAN,
            edge_dn: f64::NAN,
            spread_up: f64::NAN,
            pos_up_sh: 0.0,
            pos_dn_sh: 0.0,
            avg_up: 0.0,
            avg_dn: 0.0,
            realized_c: 0.0,
            unrealized_c: 0.0,
            equity_c: 0.0,
            trades_today: 0,
            windows_done: 0,
            signals_today: 0,
            in_flight: 0,
            cooldown_left_s: 0.0,
            feed_bin_age_ms: 0,
            feed_bin_msgs: 0,
            feed_bin_gaps: 0,
            feed_pm_age_ms: 0,
            feed_pm_msgs: 0,
            evals: 0,
            rejects: [0; 8],
            lat: [LatStats::default(); LAT_STAGES],
            cfg_jump: 0.20,
            cfg_gate: 0.60,
            cfg_edge: 0.10,
            cfg_size_sh: 50.0,
            cfg_max_pos: 200.0,
            cfg_min_tau: 10.0,
            cfg_cooldown: 8.0,
            cfg_model: 0,
            cfg_exit: 0,
            cfg_trade_down: true,
            sigs: [SigRec::default(); SIG_RING],
            sig_head: 0,
            ords: [OrdRec::default(); ORD_RING],
            ord_head: 0,
            wins: [WinRec::default(); WIN_RING],
            win_head: 0,
            chart_mark: [0.0; CHART_N],
            chart_fv: [0.5; CHART_N],
            chart_ask: [0.5; CHART_N],
            chart_head: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u256_roundtrip() {
        // Polymarket live token id observed on the wire
        let tok = "64221595004315031085680510369561676046136972168397533565696485641727857977847";
        let v = U256::from_dec(tok).unwrap();
        assert_eq!(v.to_dec(), tok);
        let be = v.to_be_bytes();
        assert_eq!(U256::from_be_bytes(&be), v);
    }

    #[test]
    fn u256_zero() {
        assert_eq!(U256::from_dec("0").unwrap().to_dec(), "0");
        assert!(U256::from_dec("").is_none());
        assert!(U256::from_dec(&"1".repeat(79)).is_none());
    }
}
