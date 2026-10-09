//! xarb-feed — direct Binance BTCUSDT WebSocket feed.
//!
//! Combined stream (bookTicker + aggTrade) with zero intermediary layers:
//! one task owns the socket, parses frames inline, and updates shared state
//! behind a mutex whose critical sections are tens of nanoseconds. aggTrade
//! event timestamps give true feed latency; 1-second price sampling drives an
//! EWMA realized-vol estimate in BTC points per √second.

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;
use xarb_core::{now_ms, Ring};

pub const WS_URL: &str =
    "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@aggTrade";
const REST_BOOK: &str = "https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT";
const REST_PRICE: &str = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedStatus {
    Connecting,
    Live,
    Degraded,
    Down,
}

impl FeedStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            FeedStatus::Connecting => "connecting",
            FeedStatus::Live => "live",
            FeedStatus::Degraded => "degraded",
            FeedStatus::Down => "down",
        }
    }
}

/// Shared Binance state. All fields updated by the feed task; read by the
/// engine hot path.
pub struct BinState {
    pub status: FeedStatus,
    pub best_bid: f64,
    pub best_ask: f64,
    pub last_price: f64,
    pub ticks: u64,
    pub ticks_per_min: u64,
    /// Realized vol, BTC points per √second (1s-sampled EWMA).
    pub vol_pts: f64,
    pub(crate) lag_ring: Ring,
    samples: VecDeque<(u64, f64)>,
    tick_counter: u64,
    tick_window_start: u64,
    last_price5s: f64,
    last_price5s_at: u64,
}

impl Default for BinState {
    fn default() -> Self {
        BinState {
            status: FeedStatus::Connecting,
            best_bid: 0.0,
            best_ask: 0.0,
            last_price: 0.0,
            ticks: 0,
            ticks_per_min: 0,
            vol_pts: 7.5,
            lag_ring: Ring::new(400),
            samples: VecDeque::with_capacity(128),
            tick_counter: 0,
            tick_window_start: now_ms(),
            last_price5s: 0.0,
            last_price5s_at: 0,
        }
    }
}

impl BinState {
    pub fn mid(&self) -> f64 {
        if self.best_bid > 0.0 && self.best_ask > 0.0 {
            (self.best_bid + self.best_ask) / 2.0
        } else {
            self.last_price
        }
    }

    pub fn spread(&self) -> f64 {
        if self.best_ask > 0.0 {
            self.best_ask - self.best_bid
        } else {
            0.0
        }
    }

    /// Price change over the trailing ~5 seconds (points). Callers poll this
    /// from the engine tick; the reference refreshes at most once per second.
    pub fn change5s(&mut self) -> f64 {
        let now = now_ms();
        if now - self.last_price5s_at >= 1_000 {
            self.last_price5s = self.mid();
            self.last_price5s_at = now;
        }
        self.mid() - self.last_price5s
    }

    pub fn last_lag_ms(&self) -> f64 {
        self.lag_ring.last()
    }

    /// Rolling ticks/min — sampled by the engine tick loop.
    pub fn sample_rate(&mut self) {
        let now = now_ms();
        let dt = (now.saturating_sub(self.tick_window_start)) as f64 / 1000.0;
        if dt >= 5.0 {
            self.ticks_per_min = (self.tick_counter as f64 / dt * 60.0).round() as u64;
            self.tick_counter = 0;
            self.tick_window_start = now;
        }
    }

    fn push_sample(&mut self, t_ms: u64, p: f64) {
        if let Some(&(last_t, _)) = self.samples.back() {
            if t_ms < last_t.saturating_add(1_000) {
                return;
            }
        }
        self.samples.push_back((t_ms, p));
        if self.samples.len() > 121 {
            self.samples.pop_front();
        }
        self.recompute_vol();
    }

    /// Variance of 1s log returns → points per √second (EWMA-smoothed).
    fn recompute_vol(&mut self) {
        let n = self.samples.len();
        if n < 30 {
            return;
        }
        let mut sum = 0.0;
        let mut sum2 = 0.0;
        for i in 1..n {
            let (t0, p0) = self.samples[i - 1];
            let (t1, p1) = self.samples[i];
            if p0 <= 0.0 || t1 <= t0 {
                continue;
            }
            let r = (p1 / p0).ln();
            sum += r;
            sum2 += r * r;
        }
        let variance = (sum2 / n as f64 - (sum / n as f64).powi(2)).max(0.0);
        let pts = variance.sqrt() * self.samples.back().map(|s| s.1).unwrap_or(0.0);
        self.vol_pts = (0.7 * self.vol_pts + 0.3 * pts).clamp(1.5, 60.0);
    }
}

pub type SharedBin = Arc<Mutex<BinState>>;

/// Spawn the Binance feed task + REST fallback watchdog. Sends an event
/// notification on every price/book-impacting message.
pub fn spawn(state: SharedBin, ev_tx: UnboundedSender<()>) {
    tokio::spawn(run_socket(state.clone(), ev_tx.clone()));
    tokio::spawn(run_rest_fallback(state, ev_tx));
}

async fn run_socket(state: SharedBin, ev_tx: UnboundedSender<()>) {
    let mut retries: u32 = 0;
    loop {
        {
            let mut s = state.lock().unwrap();
            s.status = FeedStatus::Connecting;
        }
        match tokio_tungstenite::connect_async(WS_URL).await {
            Ok((ws, _)) => {
                retries = 0;
                {
                    let mut s = state.lock().unwrap();
                    s.status = FeedStatus::Live;
                }
                log("WS live");
                let (mut write, mut read) = ws.split();
                loop {
                    match read.next().await {
                        Some(Ok(msg)) => match msg {
                            tokio_tungstenite::tungstenite::Message::Text(txt) => {
                                handle_frame(&state, &txt, &ev_tx);
                            }
                            tokio_tungstenite::tungstenite::Message::Ping(p) => {
                                let _ = write
                                    .send(tokio_tungstenite::tungstenite::Message::Pong(p))
                                    .await;
                            }
                            _ => {}
                        },
                        Some(Err(e)) => {
                            log(&format!("read error: {e}"));
                            break;
                        }
                        None => break,
                    }
                }
            }
            Err(e) => log(&format!("connect failed: {e}")),
        }
        {
            let mut s = state.lock().unwrap();
            s.status = FeedStatus::Down;
        }
        let delay = std::time::Duration::from_millis((1000u64 << retries.min(4)).min(15_000));
        retries += 1;
        log("WS closed, reconnecting…");
        tokio::time::sleep(delay).await;
    }
}

/// Inline frame parse + state update — the whole hot path.
fn handle_frame(state: &SharedBin, txt: &str, ev_tx: &UnboundedSender<()>) {
    let v: serde_json::Value = match serde_json::from_str(txt) {
        Ok(v) => v,
        Err(_) => return,
    };
    let d = v.get("data").unwrap_or(&v);
    let t0 = std::time::Instant::now();

    // bookTicker: {"u":..,"s":"BTCUSDT","b":"83000.01","B":..,"a":..,"A":..}
    if d.get("b").is_some() {
        let b = d["b"].as_str().and_then(|s| s.parse::<f64>().ok());
        let a = d["a"].as_str().and_then(|s| s.parse::<f64>().ok());
        let mut s = state.lock().unwrap();
        if let Some(b) = b {
            s.best_bid = b;
        }
        if let Some(a) = a {
            s.best_ask = a;
        }
        s.ticks += 1;
        s.tick_counter += 1;
        drop(s);
        let _ = ev_tx.send(());
    }

    // aggTrade: {"e":"aggTrade","p":"83000.10","T":1699..}
    if d.get("e").and_then(|e| e.as_str()) == Some("aggTrade") {
        let p = d["p"].as_str().and_then(|s| s.parse::<f64>().ok());
        let t = d["T"].as_u64().unwrap_or(0);
        let now = now_ms();
        let mut s = state.lock().unwrap();
        if let Some(p) = p {
            s.last_price = p;
            s.ticks += 1;
            s.tick_counter += 1;
            if t > 0 && now > t && now - t < 5_000 {
                s.lag_ring.push((now - t) as f64);
            }
            if t > 0 {
                s.push_sample(t, p);
            }
        }
        drop(s);
        let _ = ev_tx.send(());
    }

    LAST_FRAME_US.with(|c| *c.borrow_mut() = t0.elapsed().as_secs_f64() * 1e6);
}

/// REST degradation fallback: polls bookTicker while the socket is down.
async fn run_rest_fallback(state: SharedBin, ev_tx: UnboundedSender<()>) {
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        let live = { state.lock().unwrap().status == FeedStatus::Live };
        if live {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            continue;
        }
        let updated = fetch_rest(&http, &state).await;
        if updated {
            let _ = ev_tx.send(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

async fn fetch_rest(http: &reqwest::Client, state: &SharedBin) -> bool {
    if let Ok(r) = http.get(REST_BOOK).send().await {
        if let Ok(j) = r.json::<serde_json::Value>().await {
            let b = j["bidPrice"].as_str().and_then(|s| s.parse::<f64>().ok());
            let a = j["askPrice"].as_str().and_then(|s| s.parse::<f64>().ok());
            if let (Some(b), Some(a)) = (b, a) {
                let mut s = state.lock().unwrap();
                s.best_bid = b;
                s.best_ask = a;
                s.last_price = (b + a) / 2.0;
                if s.status != FeedStatus::Live {
                    s.status = FeedStatus::Degraded;
                }
                return true;
            }
        }
    }
    if let Ok(r) = http.get(REST_PRICE).send().await {
        if let Ok(j) = r.json::<serde_json::Value>().await {
            if let Some(p) = j["price"].as_str().and_then(|s| s.parse::<f64>().ok()) {
                let mut s = state.lock().unwrap();
                s.last_price = p;
                if s.status != FeedStatus::Live {
                    s.status = FeedStatus::Degraded;
                }
                return true;
            }
        }
    }
    false
}

// ── frame-latency instrumentation ───────────────────────────────────────────────
thread_local! {
    static LAST_FRAME_US: std::cell::RefCell<f64> = const { std::cell::RefCell::new(0.0) };
}

/// µs spent parsing+applying the last frame on this thread.
pub fn last_frame_us() -> f64 {
    LAST_FRAME_US.with(|c| *c.borrow())
}

fn log(msg: &str) {
    println!("[binance] {msg}");
}
