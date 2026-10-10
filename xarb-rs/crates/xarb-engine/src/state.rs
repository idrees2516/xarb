//! Engine state types: settings, window, risk atomics, signals, trades.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64};
use std::sync::Arc;
use xarb_core::FvModel;
use xarb_hft::LogHist;

/// FvFull ArcSwap publish cadence (ms).
pub const FV_PUSH_MS: u64 = 50;
/// Signal cooldown between fires (ms).
pub const SIGNAL_COOLDOWN_MS: u64 = 5_000;
/// Chart cadence (ms).
pub const CHART_PUSH_MS: u64 = 250;
/// Max chart points retained.
pub const CHART_CAP: usize = 1440;

#[derive(Debug, Clone)]
pub struct Settings {
    pub auto_trade: bool,
    pub stake_usd: f64,
    pub jump_thresh_c: f64,
    pub fv_floor_c: f64,
    pub edge_thresh_c: f64,
    pub min_secs_left: f64,
    pub max_trades_per_window: u32,
    pub model: FvModel,
    pub taker_fee_bps: f64,
    pub max_book_age_ms: u64,
    /// Also trade the DOWN side (symmetric 3-condition trigger).
    pub trade_down: bool,
    /// Kill-switch: halt new fires when realized daily P&L ≤ −this (USD).
    pub max_daily_loss_usd: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_trade: true,
            stake_usd: 25.0,
            jump_thresh_c: 20.0,
            fv_floor_c: 60.0,
            edge_thresh_c: 10.0,
            min_secs_left: 45.0,
            max_trades_per_window: 1,
            model: FvModel::NormalCdf,
            taker_fee_bps: 0.0,
            max_book_age_ms: 3000,
            trade_down: true,
            max_daily_loss_usd: 100.0,
        }
    }
}

impl Settings {
    /// Patch from a JSON object (dashboard control).
    pub fn patch(&mut self, v: &serde_json::Value) {
        if let Some(x) = v["autoTrade"].as_bool() {
            self.auto_trade = x;
        }
        if let Some(x) = v["stakeUsd"].as_f64() {
            self.stake_usd = x.clamp(1.0, 1000.0);
        }
        if let Some(x) = v["jumpThreshC"].as_f64() {
            self.jump_thresh_c = x.clamp(1.0, 90.0);
        }
        if let Some(x) = v["fvFloorC"].as_f64() {
            self.fv_floor_c = x.clamp(1.0, 99.0);
        }
        if let Some(x) = v["edgeThreshC"].as_f64() {
            self.edge_thresh_c = x.clamp(0.0, 90.0);
        }
        if let Some(x) = v["minSecsLeft"].as_f64() {
            self.min_secs_left = x.clamp(0.0, 240.0);
        }
        if let Some(x) = v["maxTradesPerWindow"].as_u64() {
            self.max_trades_per_window = x.clamp(1, 10) as u32;
        }
        if let Some(x) = v["model"].as_str() {
            self.model = FvModel::from_str(x);
        }
        if let Some(x) = v["takerFeeBps"].as_f64() {
            // up to 2000 bps: the live 5-minute BTC series has been observed
            // at a 1000 bps base taker fee — let users mirror that honestly
            self.taker_fee_bps = x.clamp(0.0, 2000.0);
        }
        if let Some(x) = v["maxBookAgeMs"].as_u64() {
            self.max_book_age_ms = x.clamp(100, 30_000);
        }
        if let Some(x) = v["tradeDown"].as_bool() {
            self.trade_down = x;
        }
        if let Some(x) = v["maxDailyLossUsd"].as_f64() {
            self.max_daily_loss_usd = x.clamp(1.0, 1_000_000.0);
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "autoTrade": self.auto_trade,
            "stakeUsd": self.stake_usd,
            "jumpThreshC": self.jump_thresh_c,
            "fvFloorC": self.fv_floor_c,
            "edgeThreshC": self.edge_thresh_c,
            "minSecsLeft": self.min_secs_left,
            "maxTradesPerWindow": self.max_trades_per_window,
            "model": self.model.as_str(),
            "takerFeeBps": self.taker_fee_bps,
            "maxBookAgeMs": self.max_book_age_ms,
            "tradeDown": self.trade_down,
            "maxDailyLossUsd": self.max_daily_loss_usd,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Window {
    pub start_epoch: u64,
    pub end_epoch: u64,
    pub slug: String,
    pub question: String,
    pub up_token_id: String,
    pub down_token_id: String,
    pub condition_id: String,
    pub strike: Option<f64>,
    pub strike_estimated: bool,
    pub tokens_loaded: bool,
    pub accepting: bool,
}

impl Window {
    pub fn empty(epoch: u64) -> Self {
        Window {
            start_epoch: epoch,
            end_epoch: epoch + 300,
            slug: format!("btc-updown-5m-{epoch}"),
            question: String::new(),
            up_token_id: String::new(),
            down_token_id: String::new(),
            condition_id: String::new(),
            strike: None,
            strike_estimated: true,
            tokens_loaded: false,
            accepting: true,
        }
    }
}

/// Lock-free risk state — written by the executor/cold task (Relaxed),
/// read by the strategy thread with single relaxed loads.
pub struct RiskState {
    /// Kill-switch (daily loss breach or manual).
    pub kill: AtomicBool,
    /// Guard epoch: window_trades is valid only for this window end (ms).
    pub window_end_ms: AtomicU64,
    /// Trades opened in the current window.
    pub window_trades: AtomicU32,
    /// Currently open positions.
    pub open_trades: AtomicI32,
    /// Realized daily P&L in cents.
    pub daily_pnl_c: AtomicI64,
}

impl Default for RiskState {
    fn default() -> Self {
        RiskState {
            kill: AtomicBool::new(false),
            window_end_ms: AtomicU64::new(0),
            window_trades: AtomicU32::new(0),
            open_trades: AtomicI32::new(0),
            daily_pnl_c: AtomicI64::new(0),
        }
    }
}

impl RiskState {
    /// Trades in the current window (self-healing across window changes).
    pub fn trades_in_window(&self, end_ms: u64) -> u32 {
        let guard = self.window_end_ms.load(std::sync::atomic::Ordering::Relaxed);
        if guard != end_ms {
            return 0;
        }
        self.window_trades.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn reset_window(&self, end_ms: u64) {
        self.window_trades.store(0, std::sync::atomic::Ordering::Relaxed);
        self.window_end_ms.store(end_ms, std::sync::atomic::Ordering::Relaxed);
        self.open_trades.store(0, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn daily_pnl_usd(&self) -> f64 {
        self.daily_pnl_c.load(std::sync::atomic::Ordering::Relaxed) as f64 / 100.0
    }
}

/// Per-stage latency histograms (atomics inside — record from any thread).
pub struct LatencyStats {
    /// Feed: parse + ring push (ns).
    pub parse: Arc<LogHist>,
    /// FV thread: full recompute incl. fold + hot-word pack (ns).
    pub fv: Arc<LogHist>,
    /// Strategy: hot-word change → observed (ns).
    pub detect: Arc<LogHist>,
    /// Strategy: observed → FireIntent pushed (ns).
    pub decide: Arc<LogHist>,
    /// Executor: intent → fill applied / order built (ns).
    pub fire: Arc<LogHist>,
    /// Binance event-time lag (ms × 1e6 into the ns hist).
    pub feed_lag: Arc<LogHist>,
    /// Strategy spin iterations (for the Hz display).
    pub spin_iters: AtomicU64,
}

impl Default for LatencyStats {
    fn default() -> Self {
        LatencyStats {
            parse: Arc::new(LogHist::default()),
            fv: Arc::new(LogHist::default()),
            detect: Arc::new(LogHist::default()),
            decide: Arc::new(LogHist::default()),
            fire: Arc::new(LogHist::default()),
            feed_lag: Arc::new(LogHist::default()),
            spin_iters: AtomicU64::new(0),
        }
    }
}

/// Side marker shared by signals and trades.
pub const SIDE_UP: u8 = 0;
pub const SIDE_DOWN: u8 = 1;

pub fn side_str(s: u8) -> &'static str {
    if s == SIDE_DOWN {
        "DOWN"
    } else {
        "UP"
    }
}

/// Skip/watch reason codes (compact — formatted on the cold task).
pub const R_AUTO_OFF: u8 = 0;
pub const R_TOO_CLOSE: u8 = 1;
pub const R_COOLDOWN: u8 = 2;
pub const R_MAX_TRADES: u8 = 3;
pub const R_POS_OPEN: u8 = 4;
pub const R_NO_TOKENS: u8 = 5;
pub const R_THIN_BOOK: u8 = 6;
pub const R_REPRICED: u8 = 7;
pub const R_WATCH: u8 = 8;
pub const R_STALE: u8 = 9;
pub const R_LIVE_ERR: u8 = 10;
pub const R_KILL: u8 = 11;

/// Compact hot-path signal event — `Copy`, formatted off-path.
#[derive(Debug, Clone, Copy)]
pub struct SignalEvt {
    pub kind: u8, // 0 WATCH · 1 SKIP · 2 FIRE
    pub side: u8,
    pub reason: u8,
    pub ts_ms: u64,
    pub window_end: u64,
    pub fv: f64,
    pub ask: f64,
    pub jump: f64,
    pub edge: f64,
    pub t_sec: f64,
}

/// Fire intent crossing the strategy → executor SPSC ring. `Copy`.
#[derive(Debug, Clone, Copy)]
pub struct FireIntent {
    pub t_mono_ns: u64,
    pub ts_ms: u64,
    pub side: u8,
    pub fv: f64,
    pub ask: f64,
    pub jump: f64,
    pub edge: f64,
    pub t_sec: f64,
    pub strike: f64,
    pub window_end: u64,
    pub stake_usd: f64,
    pub fee_bps: f64,
}

/// Fill result from the executor → cold task (owns strings, cold path).
#[derive(Debug, Clone)]
pub struct FillEvent {
    pub intent: FireIntent,
    pub outcome: u8, // 0 filled · 1 skipped · 2 live error
    pub reason: u8,
    pub fill_price_c: Option<f64>,
    pub shares: f64,
    pub cost_usd: f64,
    pub fee_usd: f64,
    pub order_id: String,
    pub order_status: String,
}

#[derive(Debug, Clone)]
pub struct SignalLog {
    pub id: String,
    pub ts: u64,
    pub window_end: u64,
    pub side: &'static str,
    pub fv: f64,
    pub ask: Option<f64>,
    pub edge: Option<f64>,
    pub jump5s: f64,
    pub seconds_left: f64,
    pub action: &'static str, // EXECUTED | SKIPPED | WATCH
    pub reason: String,
    pub fill_price: Option<f64>,
    pub shares: Option<f64>,
    pub stake: Option<f64>,
}

impl SignalLog {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "ts": self.ts,
            "windowEnd": self.window_end,
            "side": self.side,
            "fv": round1(self.fv),
            "ask": self.ask.map(round1),
            "edge": self.edge.map(round1),
            "jump5s": round1(self.jump5s),
            "secondsLeft": self.seconds_left,
            "action": self.action,
            "reason": self.reason,
            "fillPrice": self.fill_price.map(round1),
            "shares": self.shares,
            "stake": self.stake,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Trade {
    pub id: String,
    pub signal_id: String,
    pub ts: u64,
    pub window_end: u64,
    pub side: u8,
    pub strike: f64,
    pub price_c: f64,
    pub shares: f64,
    pub cost_usd: f64,
    pub fee_usd: f64,
    pub status: &'static str, // OPEN | WON | LOST
    pub pnl_usd: Option<f64>,
    pub final_price: Option<f64>,
    pub fv_at_entry: f64,
    pub edge_at_entry: f64,
}

impl Trade {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "signalId": self.signal_id,
            "ts": self.ts,
            "windowEnd": self.window_end,
            "side": side_str(self.side),
            "strike": self.strike,
            "priceC": round1(self.price_c),
            "shares": round2(self.shares),
            "costUsd": round2(self.cost_usd),
            "feeUsd": round2(self.fee_usd),
            "status": self.status,
            "pnlUsd": self.pnl_usd.map(round2),
            "finalPrice": self.final_price,
            "fvAtEntry": round1(self.fv_at_entry),
            "edgeAtEntry": round1(self.edge_at_entry),
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub pnl_realized: f64,
    pub trades: u64,
    pub wins: u64,
    pub losses: u64,
    pub staked_usd: f64,
    pub edge_sum: f64,
    pub edge_n: u64,
    pub triggers_today: u64,
    pub day_start: u64,
    /// Near-miss watch events logged today.
    pub watches_today: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ChartPoint {
    pub t: u64,
    pub price: f64,
    pub bid: f64,
    pub ask: f64,
    pub fv: f64,
    pub pm_ask: f64,
    pub pm_bid: f64,
    pub edge: f64,
    /// DOWN-side FV (100−fv for the CDF model).
    pub fv_down: f64,
    pub pm_ask_down: f64,
    pub edge_down: f64,
}

/// Engine deployment configuration (from env).
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub mode: &'static str, // "paper" | "live"
    pub neg_risk: bool,
}

pub fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Local midnight (epoch ms).
pub fn local_midnight() -> u64 {
    let now = xarb_core::now_ms();
    now - (now % 86_400_000)
}

pub fn uid() -> String {
    use rand::RngCore;
    let mut b = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}
