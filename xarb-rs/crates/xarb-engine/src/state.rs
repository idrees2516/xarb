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
    // ── v0.4: σ auto-calibration ─────────────────────────────────────
    /// σ-floor auto-calibration from live PM prices (user spec).
    pub sigma_auto: bool,
    /// Weight of implied σ in the blend (0..1).
    pub sigma_w_imp: f64,
    /// Minimum |Φ⁻¹(mid)| for an identifiable implied-σ sample.
    pub sigma_z_gate: f64,
    /// Dynamic floor = sigma_floor_k × median(implied-σ history).
    pub sigma_floor_k: f64,
    /// Absolute σ sanity floor (pts/√s).
    pub sigma_abs_floor: f64,
    // ── v0.4: delta-hedging on Binance ───────────────────────────────
    /// Delta-hedge the binary exposure on Binance.
    pub hedge_on: bool,
    /// Fraction of delta hedged (1.0 = fully neutral).
    pub hedge_ratio: f64,
    /// Binance taker fee (bps) used in the cost model & paper P&L.
    pub hedge_fee_bps: f64,
    /// Whalley–Wilmott band constant.
    pub hedge_c_ww: f64,
    /// Minimum hedge band (BTC).
    pub hedge_min_band_btc: f64,
    /// Hedge wind-down horizon (s before close).
    pub hedge_winddown_s: f64,
    // ── v0.4: profitability & value capture ───────────────────────────
    /// Minimum net edge (edge − PM fee − est. hedge cost) in ¢/share to
    /// fire. The strategy only trades opportunities that are profitable
    /// AFTER all modeled costs.
    pub min_net_edge_c: f64,
    /// Early-exit: sell the binary back when the PM bid re-converges to
    /// within `exit_band_c` of FV AND the locked edge ≥ min_capture_c.
    /// Ends the hedge early (before the expiry gamma explosion).
    pub exit_band_c: f64,
    /// Minimum captured edge (¢/share over entry) for an early exit.
    pub min_capture_c: f64,
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
            // v0.4 defaults: PM-calibrated σ, full delta-hedge, profitable-only
            sigma_auto: true,
            sigma_w_imp: 0.65,
            sigma_z_gate: 0.35, // mids outside (36.3, 63.7) identify σ; inside is noise
            sigma_floor_k: 0.75,
            sigma_abs_floor: 6.0,
            hedge_on: true,
            // fractional delta hedge: full replication of a 5-minute digital
            // costs ~the entire entry edge (notional-delta ≈ $170/share);
            // a half-delta fence insures the hold at half the cost
            hedge_ratio: 0.5,
            hedge_fee_bps: 4.5,
            hedge_c_ww: 20.0,
            hedge_min_band_btc: 0.002,
            hedge_winddown_s: 20.0,
            min_net_edge_c: 1.5,
            exit_band_c: 2.0,
            min_capture_c: 5.0,
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
        // v0.4 knobs
        if let Some(x) = v["sigmaAuto"].as_bool() {
            self.sigma_auto = x;
        }
        if let Some(x) = v["sigmaWImp"].as_f64() {
            self.sigma_w_imp = x.clamp(0.0, 1.0);
        }
        if let Some(x) = v["sigmaZGate"].as_f64() {
            self.sigma_z_gate = x.clamp(0.05, 1.5);
        }
        if let Some(x) = v["sigmaFloorK"].as_f64() {
            self.sigma_floor_k = x.clamp(0.1, 2.0);
        }
        if let Some(x) = v["sigmaAbsFloor"].as_f64() {
            self.sigma_abs_floor = x.clamp(1.0, 40.0);
        }
        if let Some(x) = v["hedgeOn"].as_bool() {
            self.hedge_on = x;
        }
        if let Some(x) = v["hedgeRatio"].as_f64() {
            self.hedge_ratio = x.clamp(0.0, 1.0);
        }
        if let Some(x) = v["hedgeFeeBps"].as_f64() {
            self.hedge_fee_bps = x.clamp(0.0, 200.0);
        }
        if let Some(x) = v["hedgeMinBandBtc"].as_f64() {
            self.hedge_min_band_btc = x.clamp(0.0001, 0.05);
        }
        if let Some(x) = v["minNetEdgeC"].as_f64() {
            self.min_net_edge_c = x.clamp(0.0, 50.0);
        }
        if let Some(x) = v["exitBandC"].as_f64() {
            self.exit_band_c = x.clamp(0.0, 30.0);
        }
        if let Some(x) = v["minCaptureC"].as_f64() {
            self.min_capture_c = x.clamp(0.0, 90.0);
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
            "sigmaAuto": self.sigma_auto,
            "sigmaWImp": self.sigma_w_imp,
            "sigmaZGate": self.sigma_z_gate,
            "sigmaFloorK": self.sigma_floor_k,
            "sigmaAbsFloor": self.sigma_abs_floor,
            "hedgeOn": self.hedge_on,
            "hedgeRatio": self.hedge_ratio,
            "hedgeFeeBps": self.hedge_fee_bps,
            "hedgeMinBandBtc": self.hedge_min_band_btc,
            "minNetEdgeC": self.min_net_edge_c,
            "exitBandC": self.exit_band_c,
            "minCaptureC": self.min_capture_c,
        })
    }

    /// Effective HedgeCfg view of the settings.
    pub fn hedge_cfg(&self) -> crate::hedger::HedgeCfg {
        crate::hedger::HedgeCfg {
            on: self.hedge_on,
            ratio: self.hedge_ratio,
            fee_bps: self.hedge_fee_bps,
            c_ww: self.hedge_c_ww,
            min_band_btc: self.hedge_min_band_btc,
            winddown_s: self.hedge_winddown_s,
            flatten_s: 3.0,
            min_qty_btc: 0.001,
            qty_step_btc: 0.001,
            cost_turnover_mult: 2.5,
        }
    }

    /// Effective SigmaCfg view of the settings.
    pub fn sigma_cfg(&self) -> xarb_core::SigmaCfg {
        xarb_core::SigmaCfg {
            auto: self.sigma_auto,
            w_imp: self.sigma_w_imp,
            z_gate: self.sigma_z_gate,
            kappa: 0.30,
            floor_k: self.sigma_floor_k,
            abs_floor: self.sigma_abs_floor,
            cap: xarb_core::SIGMA_CAP_PTS,
            hist_cap: 240,
        }
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
    // ── v0.4 capture accounting (proves zero-miss trigger evaluation) ──
    /// Distinct armed episodes (rising edge of the 3-trigger conjunction).
    pub opportunities: AtomicU64,
    /// Sum of edges over those episodes (cents).
    pub opps_edge_c: AtomicI64,
    /// Episodes that produced a FireIntent (rest were suppressed with a
    /// logged reason — every opportunity gets an explicit decision).
    pub opps_fired: AtomicU64,
}

impl Default for RiskState {
    fn default() -> Self {
        RiskState {
            kill: AtomicBool::new(false),
            window_end_ms: AtomicU64::new(0),
            window_trades: AtomicU32::new(0),
            open_trades: AtomicI32::new(0),
            daily_pnl_c: AtomicI64::new(0),
            opportunities: AtomicU64::new(0),
            opps_edge_c: AtomicI64::new(0),
            opps_fired: AtomicU64::new(0),
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
    /// v0.4: hedge policy+fill latency (ns) — re-hedge decision → applied.
    pub hedge: Arc<LogHist>,
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
            hedge: Arc::new(LogHist::default()),
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
/// Net-of-fees+hedge-cost edge below the profitability floor.
pub const R_NET_EDGE: u8 = 12;

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
#[derive(Debug, Clone, Copy, Default)]
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
    // ── v0.4 net-edge decomposition (profitability gate) ──
    /// PM taker fee in ¢/share at the entry price.
    pub fee_c: f64,
    /// Estimated Binance hedge cost in ¢/share.
    pub hedge_c: f64,
    /// edge − fee_c − hedge_c.
    pub net_edge_c: f64,
    /// σ_eff at fire time (pts/√s) — carried for the hedger.
    pub sigma_eff: f64,
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

/// Hedge fill applied on the cold path (paper inline or live callback).
#[derive(Debug, Clone)]
pub struct HedgeFill {
    pub trade_id: String,
    /// Signed fill quantity (BTC): negative = sold/shorted.
    pub qty_btc: f64,
    /// Fill price (USD).
    pub px: f64,
    pub fee_usd: f64,
    pub reason: String,
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
    pub status: &'static str, // OPEN | WON | LOST | EXITED
    pub pnl_usd: Option<f64>,
    pub final_price: Option<f64>,
    pub fv_at_entry: f64,
    pub edge_at_entry: f64,
    // ── v0.4 hedge + capture fields ──
    /// Net edge at entry (¢/share) after PM fee + hedge cost estimate.
    pub net_edge_at_entry: f64,
    /// Hedge quantity at close (BTC, signed).
    pub hedge_qty_btc: f64,
    /// Hedge P&L (USD, realized at close / mark while open).
    pub hedge_pnl_usd: f64,
    /// Hedge fees paid (USD).
    pub hedge_fees_usd: f64,
    /// Early-exit fill price (¢) — None when held to settlement.
    pub exit_px_c: Option<f64>,
    /// Exit reason ("reprice-exit" | "settlement" | "flatten-only").
    pub exit_reason: String,
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
            "netEdgeAtEntry": round1(self.net_edge_at_entry),
            "hedgeQtyBtc": round3(self.hedge_qty_btc),
            "hedgePnlUsd": round2(self.hedge_pnl_usd),
            "hedgeFeesUsd": round2(self.hedge_fees_usd),
            "exitPxC": self.exit_px_c.map(round1),
            "exitReason": self.exit_reason,
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
    // ── v0.4 capture accounting ──
    /// Sum of theoretical net edge over EXECUTED entries (USD).
    pub edge_theoretical_usd: f64,
    /// Hedge fees paid today (USD).
    pub hedge_fees_usd: f64,
    /// Early exits taken today.
    pub early_exits: u64,
    /// Sum of PM fee paid (USD).
    pub pm_fees_usd: f64,
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

pub fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
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
