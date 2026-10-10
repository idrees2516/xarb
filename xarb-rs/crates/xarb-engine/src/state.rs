//! Engine state types.

use xarb_core::FvModel;

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
            self.max_book_age_ms = x.clamp(100, 60_000);
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
            condition_id: String::new(),
            strike: None,
            strike_estimated: true,
            tokens_loaded: false,
            accepting: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SignalLog {
    pub id: String,
    pub ts: u64,
    pub window_end: u64,
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
    // UTC-agnostic day boundary on wall clock of the host
    let now = xarb_core::now_ms();
    now - (now % 86_400_000)
}

pub fn uid() -> String {
    use rand::RngCore;
    let mut b = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}
