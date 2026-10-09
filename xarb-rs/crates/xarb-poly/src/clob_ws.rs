//! Direct Polymarket CLOB WebSocket market channel.
//!
//! Same empirically-reverse-engineered schema as the reference TS feed:
//!   • `book` snapshots carry `bids`/`asks` arrays
//!   • `price_change` events carry `{price_changes: [{asset_id, price, size,
//!     side: BUY|SELL, …}]}`
//!   • `last_trade_price` carries a live `fee_rate_bps`
//!   • PING/PONG text frames for keepalive; no traffic for 30s = dead socket
//! Window rollovers roll the whole socket (re-subscribing on an open socket
//! is unreliable).

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc::UnboundedSender, watch};
use xarb_core::{now_ms, Book};
pub const CLOB_WS: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
pub const CLOB_BOOK: &str = "https://clob.polymarket.com/book?token_id=";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PmStatus {
    Connecting,
    Live,
    Down,
}

impl PmStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            PmStatus::Connecting => "connecting",
            PmStatus::Live => "live",
            PmStatus::Down => "down",
        }
    }
}

/// Shared Polymarket state.
pub struct PmState {
    pub status: PmStatus,
    pub book: Book,
    pub updates: u64,
    pub last_trade_px: Option<f64>,
    pub fee_rate_bps: Option<u64>,
    pub(crate) last_alive_at: u64,
    pub(crate) last_book_at: u64,
}

impl Default for PmState {
    fn default() -> Self {
        PmState {
            status: PmStatus::Connecting,
            book: Book::default(),
            updates: 0,
            last_trade_px: None,
            fee_rate_bps: None,
            last_alive_at: 0,
            last_book_at: 0,
        }
    }
}

pub type SharedPm = Arc<Mutex<PmState>>;

/// Spawn the CLOB feed. `token_rx` is a watch channel carrying the current
/// UP token id (None while a window is being discovered).
pub fn spawn(state: SharedPm, token_rx: watch::Receiver<Option<String>>, ev_tx: UnboundedSender<()>) {
    tokio::spawn(run_feed(state.clone(), token_rx, ev_tx.clone()));
    tokio::spawn(run_rest_fallback(state, ev_tx));
}

async fn run_feed(
    state: SharedPm,
    mut token_rx: watch::Receiver<Option<String>>,
    ev_tx: UnboundedSender<()>,
) {
    loop {
        // wait for a token
        let token = loop {
            let cur = token_rx.borrow_and_update().clone();
            if let Some(t) = cur {
                break t;
            }
            if token_rx.changed().await.is_err() {
                return;
            }
        };

        {
            let mut s = state.lock().unwrap();
            s.book.clear();
            s.status = PmStatus::Connecting;
        }
        log(&format!("rolling socket for new window token …{}", token.chars().rev().take(6).collect::<String>()));

        // socket phase: runs until death or token change
        let outcome = socket_phase(state.clone(), token, &mut token_rx, ev_tx.clone()).await;

        if let Outcome::Died = outcome {
            {
                let mut s = state.lock().unwrap();
                s.status = PmStatus::Down;
            }
            log("WS closed, reconnecting…");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        // Outcome::TokenChanged → loop re-reads the new token immediately
    }
}

enum Outcome {
    Died,
    TokenChanged,
}

async fn socket_phase(
    state: SharedPm,
    token: String,
    token_rx: &mut watch::Receiver<Option<String>>,
    ev_tx: UnboundedSender<()>,
) -> Outcome {
    let ws = match tokio_tungstenite::connect_async(CLOB_WS).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            log(&format!("connect failed: {e}"));
            return Outcome::Died;
        }
    };
    {
        let mut s = state.lock().unwrap();
        s.status = PmStatus::Live;
    }
    log("CLOB WS live");

    let (mut write, mut read) = ws.split();
    let sub = serde_json::json!({ "assets_ids": [token], "type": "market" }).to_string();
    let _ = write
        .send(tokio_tungstenite::tungstenite::Message::Text(sub))
        .await;

    let alive = Arc::new(AtomicU64::new(0));
    let mut ping = tokio::time::interval(std::time::Duration::from_secs(4));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            // token rollover → abandon this socket entirely
            changed = token_rx.changed() => {
                if changed.is_err() { return Outcome::Died; }
                return Outcome::TokenChanged;
            }
            _ = ping.tick() => {
                if write.send(tokio_tungstenite::tungstenite::Message::Text("PING".into())).await.is_err() {
                    return Outcome::Died;
                }
                let last_alive = alive.load(Ordering::Relaxed);
                if last_alive > 0 && now_ms() - last_alive > 30_000 {
                    log("dead socket (no traffic 30s), forcing reconnect");
                    return Outcome::Died;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(txt))) => {
                        alive.store(now_ms(), Ordering::Relaxed);
                        handle_frame(&state, &txt, &token, &ev_tx);
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(p))) => {
                        let _ = write.send(tokio_tungstenite::tungstenite::Message::Pong(p)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { log(&format!("read error: {e}")); return Outcome::Died; }
                    None => return Outcome::Died,
                }
            }
        }
    }
}

/// Inline frame parse + book update.
fn handle_frame(state: &SharedPm, raw: &str, token: &str, ev_tx: &UnboundedSender<()>) {
    if raw == "PONG" || raw == "PING" {
        return;
    }
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let now = now_ms();
    let events: Vec<&serde_json::Value> = match v.as_array() {
        Some(a) => a.iter().collect(),
        None => vec![&v],
    };

    let mut s = state.lock().unwrap();
    let mut changed = false;
    for d in events {
        let et = d.get("event_type").and_then(|t| t.as_str()).unwrap_or("");
        match et {
            "book" => {
                if asset_matches(d.get("asset_id"), token) {
                    let mut bids: Vec<(f64, f64)> = Vec::new();
                    let mut asks: Vec<(f64, f64)> = Vec::new();
                    if let Some(arr) = d.get("bids").and_then(|b| b.as_array()) {
                        for l in arr {
                            let p = l["price"].as_str().and_then(|p| p.parse::<f64>().ok());
                            let sz = l["size"].as_str().and_then(|p| p.parse::<f64>().ok());
                            if let (Some(p), Some(sz)) = (p, sz) {
                                bids.push((p, sz));
                            }
                        }
                    }
                    if let Some(arr) = d.get("asks").and_then(|a| a.as_array()) {
                        for l in arr {
                            let p = l["price"].as_str().and_then(|p| p.parse::<f64>().ok());
                            let sz = l["size"].as_str().and_then(|p| p.parse::<f64>().ok());
                            if let (Some(p), Some(sz)) = (p, sz) {
                                asks.push((p, sz));
                            }
                        }
                    }
                    s.book.replace(&bids, &asks);
                    if let Some(p) = d.get("last_trade_price").and_then(|p| p.as_f64()) {
                        if p > 0.0 {
                            s.last_trade_px = Some(p);
                        }
                    }
                    s.book.touch(now);
                    s.last_book_at = now;
                    changed = true;
                }
            }
            "price_change" => {
                if let Some(chs) = d.get("price_changes").and_then(|c| c.as_array()) {
                    for ch in chs {
                        if !asset_matches(ch.get("asset_id"), token) {
                            continue;
                        }
                        let p = ch["price"].as_str().and_then(|p| p.parse::<f64>().ok());
                        let sz = ch["size"].as_str().and_then(|p| p.parse::<f64>().ok());
                        let is_bid = ch["side"].as_str().map(|x| x.eq_ignore_ascii_case("BUY")).unwrap_or(false);
                        if let Some(p) = p {
                            s.book.set_level(is_bid, p, sz.unwrap_or(0.0));
                            s.book.touch(now);
                            s.last_book_at = now;
                            changed = true;
                        }
                    }
                }
            }
            "last_trade_price" => {
                if asset_matches(d.get("asset_id"), token) {
                    if let Some(p) = d["price"].as_f64() {
                        if p > 0.0 {
                            s.last_trade_px = Some(p);
                        }
                    }
                    if let Some(f) = d.get("fee_rate_bps").and_then(|f| f.as_u64()) {
                        s.fee_rate_bps = Some(f);
                    }
                }
            }
            _ => {}
        }
    }
    if changed {
        s.updates += 1;
        drop(s);
        let _ = ev_tx.send(());
    }
}

fn asset_matches(v: Option<&serde_json::Value>, token: &str) -> bool {
    match v.and_then(|a| a.as_str()) {
        Some(a) => a == token,
        None => true,
    }
}

/// REST fallback: poll /book while the socket is down or the book is stale.
async fn run_rest_fallback(state: SharedPm, ev_tx: UnboundedSender<()>) {
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(3000))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        let healthy = {
            let s = state.lock().unwrap();
            let fresh = s.last_book_at > 0 && now_ms().saturating_sub(s.last_book_at) < 5_000;
            s.status == PmStatus::Live && fresh
        };
        if !healthy {
            if let Some(tok) = rest_token() {
                if let Ok(book) = fetch_book(&http, &tok).await {
                    let mut s = state.lock().unwrap();
                    let now = now_ms();
                    s.book.replace(&book.0, &book.1);
                    s.book.touch(now);
                    s.last_book_at = now;
                    s.updates += 1;
                    if s.status != PmStatus::Live {
                        s.status = PmStatus::Down;
                    }
                    drop(s);
                    let _ = ev_tx.send(());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    }
}

static REST_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// Engine registers the current UP token for the REST fallback poller.
pub fn set_rest_token(token: &str) {
    if let Ok(mut g) = REST_TOKEN.lock() {
        *g = Some(token.to_string());
    }
}

fn rest_token() -> Option<String> {
    REST_TOKEN.lock().ok().and_then(|g| g.clone())
}

async fn fetch_book(http: &reqwest::Client, token: &str) -> Result<(Vec<(f64, f64)>, Vec<(f64, f64)>)> {
    let resp = http
        .get(format!("{CLOB_BOOK}{token}"))
        .send()
        .await?;
    let j: serde_json::Value = resp.json().await?;
    let parse = |key: &str| -> Vec<(f64, f64)> {
        j.get(key)
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| {
                        let p = l["price"].as_str().and_then(|p| p.parse::<f64>().ok());
                        let s = l["size"].as_str().and_then(|s| s.parse::<f64>().ok());
                        p.zip(s)
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok((parse("bids"), parse("asks")))
}

fn log(msg: &str) {
    println!("[polymarket] {msg}");
}
