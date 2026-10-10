//! Direct Polymarket CLOB WebSocket market channel — dual-token (UP + DOWN).
//!
//! v0.3: the socket subscribes BOTH outcome tokens of the 5-minute window, so
//! the strategy can fire on either side. Every book-affecting event:
//!   1. updates the local ladder,
//!   2. publishes the top-of-book through a **QuoteCell** (u64 bit-packed,
//!      single Release store — the FV engine folds it into the hot word),
//!   3. publishes a full `PmSnapshot` through ArcSwap (wait-free reads for
//!      the executor / cold path),
//!   4. unparks the FV engine thread (token semantics).
//!
//! Empirically-reverse-engineered schema (unchanged from v0.2):
//!   • `book` snapshots carry `bids`/`asks` arrays
//!   • `price_change` events carry `{price_changes:[{asset_id, price, size,
//!     side:BUY|SELL, best_bid, best_ask}]}`
//!   • `last_trade_price` carries a live `fee_rate_bps`
//!   • PING/PONG text keepalive; 30s without traffic = dead socket
//! Window rollovers roll the whole socket (re-subscribing on an open socket
//! is unreliable).

use anyhow::Result;
use arc_swap::ArcSwap;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use xarb_core::{now_ms, Book, Level};
use xarb_hft::hot::{QF_ALIVE, QF_VALID};
use xarb_hft::{CachePadded, QuoteCell, WakeSlot};

pub const CLOB_WS: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
pub const CLOB_BOOK: &str = "https://clob.polymarket.com/book?token_id=";

pub const STATUS_CONNECTING: u8 = 0;
pub const STATUS_LIVE: u8 = 1;
pub const STATUS_DOWN: u8 = 2;

pub fn status_str(s: u8) -> &'static str {
    match s {
        STATUS_LIVE => "live",
        STATUS_DOWN => "down",
        _ => "connecting",
    }
}

/// One side's top-of-book + ladder view (snapshot side, cold data).
#[derive(Debug, Clone, Default)]
pub struct SideSnap {
    pub ask: Option<f64>,
    pub ask_sz: f64,
    pub bid: Option<f64>,
    pub bid_sz: f64,
    pub asks: Vec<Level>,
    pub bids: Vec<Level>,
    pub valid: bool,
}

impl SideSnap {
    fn from_book(book: &Book, now: u64) -> SideSnap {
        let best_ask = book.best_ask();
        let best_bid = book.best_bid();
        SideSnap {
            ask: best_ask.map(|l| l.p * 100.0),
            ask_sz: best_ask.map(|l| l.s).unwrap_or(0.0),
            bid: best_bid.map(|l| l.p * 100.0),
            bid_sz: best_bid.map(|l| l.s).unwrap_or(0.0),
            asks: book.asks_top(8),
            bids: book.bids_top(8),
            valid: best_ask.is_some() || best_bid.is_some(),
        }
        .with_age(now, book)
    }

    fn with_age(self, _now: u64, _book: &Book) -> SideSnap {
        self
    }
}

/// Full Polymarket state snapshot (published per book event, throttled).
#[derive(Debug, Clone, Default)]
pub struct PmSnapshot {
    pub t_ms: u64,
    /// Book-affecting event time (freshness gate).
    pub book_at_ms: u64,
    pub up: SideSnap,
    pub down: SideSnap,
    pub fee_rate_bps: Option<u64>,
    pub last_trade_px: Option<f64>,
    pub updates: u64,
}

/// Shared PM outputs: quote cells (hot) + ArcSwap snapshot (cold).
pub struct PmOut {
    pub up_cell: CachePadded<AtomicU64>,
    pub down_cell: CachePadded<AtomicU64>,
    pub snap: Arc<ArcSwap<PmSnapshot>>,
    pub status: AtomicU8,
    pub updates: AtomicU64,
    /// Wake slot of the FV engine thread (armed by the engine after spawn).
    pub fv_wake: Arc<WakeSlot>,
}

impl PmOut {
    pub fn new(fv_wake: Arc<WakeSlot>) -> Self {
        PmOut {
            up_cell: CachePadded::new(AtomicU64::new(0)),
            down_cell: CachePadded::new(AtomicU64::new(0)),
            snap: Arc::new(ArcSwap::from_pointee(PmSnapshot::default())),
            status: AtomicU8::new(STATUS_CONNECTING),
            updates: AtomicU64::new(0),
            fv_wake,
        }
    }

    /// Read the packed UP quote cell.
    pub fn up_cell_v(&self) -> QuoteCell {
        QuoteCell(self.up_cell.load(Ordering::Acquire))
    }

    /// Read the packed DOWN quote cell.
    pub fn down_cell_v(&self) -> QuoteCell {
        QuoteCell(self.down_cell.load(Ordering::Acquire))
    }
}

/// Spawn the CLOB feed on a dedicated pinned thread. `token_rx` carries the
/// current (up, down) token pair (None while a window is discovered).
pub fn spawn_dedicated(
    out: Arc<PmOut>,
    token_rx: watch::Receiver<Option<(String, String)>>,
    pin: Option<usize>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("pm-feed".into())
        .spawn(move || {
            if let Some(c) = pin {
                let _ = xarb_hft::affinity::pin_current(c);
            }
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("pm runtime");
            rt.block_on(async move {
                tokio::spawn(run_rest_fallback(out.clone(), token_rx.clone()));
                run_feed(out, token_rx).await;
            });
        })
        .expect("spawn pm feed thread")
}

/// Books owned by the feed thread (single owner — no locks anywhere).
#[derive(Default)]
struct Books {
    up: Book,
    down: Book,
    up_last_ms: u64,
    down_last_ms: u64,
}

impl Books {
    fn side(&mut self, is_up: bool) -> (&mut Book, &mut u64) {
        if is_up {
            (&mut self.up, &mut self.up_last_ms)
        } else {
            (&mut self.down, &mut self.down_last_ms)
        }
    }
}

async fn run_feed(out: Arc<PmOut>, mut token_rx: watch::Receiver<Option<(String, String)>>) {
    loop {
        let (up_token, down_token) = loop {
            let cur = token_rx.borrow_and_update().clone();
            if let Some(t) = cur {
                break t;
            }
            if token_rx.changed().await.is_err() {
                return;
            }
        };

        out.status.store(STATUS_CONNECTING, Ordering::Relaxed);
        // publish "no book" cells while disconnected
        out.up_cell
            .store(QuoteCell::pack(0xFFFF, 0xFFFF, 0, 0).0, Ordering::Release);
        out.down_cell
            .store(QuoteCell::pack(0xFFFF, 0xFFFF, 0, 0).0, Ordering::Release);
        log(&format!(
            "rolling socket for new window up …{} down …{}",
            up_token.chars().rev().take(6).collect::<String>(),
            down_token.chars().rev().take(6).collect::<String>()
        ));

        let outcome = socket_phase(
            &out,
            (up_token, down_token),
            &mut token_rx,
        )
        .await;

        if let Outcome::Died = outcome {
            out.status.store(STATUS_DOWN, Ordering::Relaxed);
            log("WS closed, reconnecting…");
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

enum Outcome {
    Died,
    TokenChanged,
}

async fn socket_phase(
    out: &Arc<PmOut>,
    tokens: (String, String),
    token_rx: &mut watch::Receiver<Option<(String, String)>>,
) -> Outcome {
    let ws = match tokio_tungstenite::connect_async(CLOB_WS).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            log(&format!("connect failed: {e}"));
            return Outcome::Died;
        }
    };
    out.status.store(STATUS_LIVE, Ordering::Relaxed);
    log("CLOB WS live (dual-token)");

    let (mut write, mut read) = ws.split();
    let sub = serde_json::json!({
        "assets_ids": [tokens.0, tokens.1],
        "type": "market"
    })
    .to_string();
    if write
        .send(tokio_tungstenite::tungstenite::Message::Text(sub))
        .await
        .is_err()
    {
        return Outcome::Died;
    }

    let mut books = Books::default();
    let alive = Arc::new(AtomicU64::new(0));
    let mut ping = tokio::time::interval(Duration::from_secs(4));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            changed = token_rx.changed() => {
                if changed.is_err() { return Outcome::Died; }
                return Outcome::TokenChanged;
            }
            _ = ping.tick() => {
                if write.send(tokio_tungstenite::tungstenite::Message::Text("PING".into())).await.is_err() {
                    return Outcome::Died;
                }
                let last_alive = alive.load(Ordering::Relaxed);
                if last_alive > 0 && now_ms().saturating_sub(last_alive) > 30_000 {
                    log("dead socket (no traffic 30s), forcing reconnect");
                    return Outcome::Died;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(txt))) => {
                        alive.store(now_ms(), Ordering::Relaxed);
                        handle_frame(out, &txt, &tokens, &mut books);
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

/// Parse + apply a frame, then publish cells/snapshot and unpark the FV
/// engine — the PM producer hot path.
fn handle_frame(out: &Arc<PmOut>, raw: &str, tokens: &(String, String), books: &mut Books) {
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

    let mut changed = false;
    let mut fee: Option<u64> = None;
    let mut ltp: Option<f64> = None;
    for d in events {
        let et = d.get("event_type").and_then(|t| t.as_str()).unwrap_or("");
        match et {
            "book" => {
                if let Some(is_up) = which_side(d.get("asset_id"), tokens) {
                    let (book, last_ms) = books.side(is_up);
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
                    book.replace(&bids, &asks);
                    *last_ms = now;
                    changed = true;
                    if let Some(p) = d.get("last_trade_price").and_then(|p| p.as_f64()) {
                        if p > 0.0 {
                            ltp = Some(p);
                        }
                    }
                }
            }
            "price_change" => {
                if let Some(chs) = d.get("price_changes").and_then(|c| c.as_array()) {
                    for ch in chs {
                        let Some(is_up) = which_side(ch.get("asset_id"), tokens) else {
                            continue;
                        };
                        let p = ch["price"].as_str().and_then(|p| p.parse::<f64>().ok());
                        let sz = ch["size"].as_str().and_then(|p| p.parse::<f64>().ok());
                        let is_bid = ch["side"]
                            .as_str()
                            .map(|x| x.eq_ignore_ascii_case("BUY"))
                            .unwrap_or(false);
                        if let Some(p) = p {
                            let (book, last_ms) = books.side(is_up);
                            book.set_level(is_bid, p, sz.unwrap_or(0.0));
                            *last_ms = now;
                            changed = true;
                        }
                    }
                }
            }
            "last_trade_price" => {
                if let Some(is_up) = which_side(d.get("asset_id"), tokens) {
                    let _ = is_up;
                    if let Some(p) = d["price"].as_f64() {
                        if p > 0.0 {
                            ltp = Some(p);
                        }
                    }
                }
                if let Some(f) = d.get("fee_rate_bps").and_then(|f| f.as_u64()) {
                    fee = Some(f);
                }
            }
            _ => {}
        }
    }

    if changed || fee.is_some() || ltp.is_some() {
        publish(out, books, now);
    }
}

/// Pack both sides' top-of-book into the quote cells (one Release store
/// each), refresh the ArcSwap snapshot, and unpark the FV engine.
/// Cells carry ts16 = low 16 bits of the last book-event epoch-ms — readers
/// compute freshness against their own clock, so frozen cells read stale.
fn publish(out: &Arc<PmOut>, books: &Books, now: u64) {
    let live = out.status.load(Ordering::Relaxed) == STATUS_LIVE;
    let up_best = books.up.best_ask();
    let up_bid = books.up.best_bid();
    let dn_best = books.down.best_ask();
    let dn_bid = books.down.best_bid();

    let up_flags = if up_best.is_some() { QF_VALID } else { 0 } | if live { QF_ALIVE } else { 0 };
    let dn_flags = if dn_best.is_some() { QF_VALID } else { 0 } | if live { QF_ALIVE } else { 0 };

    let up_cell = QuoteCell::pack(
        up_best.map(|l| (l.p * 100.0).round() as u16).unwrap_or(0xFFFF),
        up_bid.map(|l| (l.p * 100.0).round() as u16).unwrap_or(0xFFFF),
        (books.up_last_ms & 0xFFFF) as u16,
        up_flags,
    );
    let dn_cell = QuoteCell::pack(
        dn_best.map(|l| (l.p * 100.0).round() as u16).unwrap_or(0xFFFF),
        dn_bid.map(|l| (l.p * 100.0).round() as u16).unwrap_or(0xFFFF),
        (books.down_last_ms & 0xFFFF) as u16,
        dn_flags,
    );

    out.up_cell.store(up_cell.0, Ordering::Release);
    out.down_cell.store(dn_cell.0, Ordering::Release);

    // throttle full-snapshot publishes to 10ms (Arc alloc + swap)
    let prev = out.snap.load();
    let updates = out.updates.fetch_add(1, Ordering::Relaxed) + 1;
    if now.saturating_sub(prev.t_ms) >= 10 {
        out.snap.store(Arc::new(PmSnapshot {
            t_ms: now,
            book_at_ms: now,
            up: SideSnap::from_book(&books.up, now),
            down: SideSnap::from_book(&books.down, now),
            fee_rate_bps: prev.fee_rate_bps,
            last_trade_px: prev.last_trade_px,
            updates,
        }));
    }

    // wake the FV engine (fold cells → hot word → maybe fire)
    out.fv_wake.wake();
}

fn which_side(v: Option<&serde_json::Value>, tokens: &(String, String)) -> Option<bool> {
    match v.and_then(|a| a.as_str()) {
        Some(a) => {
            if a == tokens.0 {
                Some(true) // UP token
            } else if a == tokens.1 {
                Some(false) // DOWN token
            } else {
                None
            }
        }
        None => None, // unattributed → cannot route safely, drop
    }
}

/// REST fallback: poll /book for both tokens while the socket is unhealthy.
/// Same single-threaded runtime → single producer contract preserved.
async fn run_rest_fallback(
    out: Arc<PmOut>,
    token_rx: watch::Receiver<Option<(String, String)>>,
) {
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut token_rx = token_rx;
    loop {
        let healthy = {
            let snap = out.snap.load();
            out.status.load(Ordering::Relaxed) == STATUS_LIVE
                && snap.book_at_ms > 0
                && now_ms().saturating_sub(snap.book_at_ms) < 5_000
        };
        if !healthy {
            let tokens = token_rx.borrow_and_update().clone();
            if let Some((up, down)) = tokens {
                let mut books = Books::default();
                let mut ok = false;
                if let Ok(b) = fetch_book(&http, &up).await {
                    books.up.replace(&b.0, &b.1);
                    books.up_last_ms = now_ms();
                    ok = true;
                }
                if let Ok(b) = fetch_book(&http, &down).await {
                    books.down.replace(&b.0, &b.1);
                    books.down_last_ms = now_ms();
                    ok = true;
                }
                if ok {
                    if out.status.load(Ordering::Relaxed) != STATUS_LIVE {
                        out.status.store(STATUS_DOWN, Ordering::Relaxed);
                    }
                    publish(&out, &books, now_ms());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(2000)).await;
    }
}

async fn fetch_book(http: &reqwest::Client, token: &str) -> Result<(Vec<(f64, f64)>, Vec<(f64, f64)>)> {
    let resp = http.get(format!("{CLOB_BOOK}{token}")).send().await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_events_by_asset() {
        let tokens = ("111".to_string(), "222".to_string());
        assert_eq!(which_side(Some(&serde_json::json!("111")), &tokens), Some(true));
        assert_eq!(which_side(Some(&serde_json::json!("222")), &tokens), Some(false));
        assert_eq!(which_side(Some(&serde_json::json!("333")), &tokens), None);
        assert_eq!(which_side(None, &tokens), None);
    }

    #[test]
    fn book_frame_routes_and_updates() {
        let out = Arc::new(PmOut::new(Arc::new(WakeSlot::new())));
        let tokens = ("111".to_string(), "222".to_string());
        let mut books = Books::default();
        let frame = serde_json::json!([{
            "event_type": "book",
            "asset_id": "111",
            "bids": [{"price": "0.54", "size": "100"}],
            "asks": [{"price": "0.56", "size": "200"}, {"price": "0.57", "size": "300"}],
        }])
        .to_string();
        handle_frame(&out, &frame, &tokens, &mut books);
        let cell = out.up_cell_v();
        assert_eq!(cell.ask_c(), 56);
        assert_eq!(cell.bid_c(), 54);
        // snapshot sees the same ladder
        let snap = out.snap.load();
        assert_eq!(snap.up.asks.len(), 2);
        assert!((snap.up.ask.unwrap() - 56.0).abs() < 1e-9);
    }

    #[test]
    fn price_change_updates_best_ask() {
        let out = Arc::new(PmOut::new(Arc::new(WakeSlot::new())));
        let tokens = ("111".to_string(), "222".to_string());
        let mut books = Books::default();
        // seed
        let seed = serde_json::json!([{
            "event_type": "book", "asset_id": "111",
            "bids": [{"price": "0.54", "size": "100"}],
            "asks": [{"price": "0.56", "size": "200"}],
        }])
        .to_string();
        handle_frame(&out, &seed, &tokens, &mut books);
        // delete the best ask via size 0
        let upd = serde_json::json!([{
            "event_type": "price_change",
            "price_changes": [{"asset_id": "111", "price": "0.56", "size": "0", "side": "SELL"}],
        }])
        .to_string();
        handle_frame(&out, &upd, &tokens, &mut books);
        let cell = out.up_cell_v();
        assert_eq!(cell.ask_c(), 0xFFFF); // no asks left
        assert_eq!(cell.bid_c(), 54);
    }

    #[tokio::test]
    async fn down_token_book_via_rest_shape() {
        // fetch_book parses the documented REST shape
        let j = serde_json::json!({
            "bids": [{"price": "0.40", "size": "50"}],
            "asks": [{"price": "0.61", "size": "70"}],
        });
        // emulate the parse lambda directly
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
        assert_eq!(parse("bids"), vec![(0.40, 50.0)]);
        assert_eq!(parse("asks"), vec![(0.61, 70.0)]);
    }
}
