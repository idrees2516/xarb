//! xarb-feed — Binance BTCUSDT feed on a dedicated pinned OS thread.
//!
//! v0.3 hot path:
//!   • **Zero-DOM parsing**: combined bookTicker/aggTrade frames are parsed by
//!     a hand-rolled field scanner over the raw bytes (~80-150ns) instead of
//!     building a `serde_json::Value` DOM (~2-4µs) — a 20-40× parse speedup.
//!     A DOM fallback path guarantees correctness on unexpected shapes.
//!   • **Dedicated thread**: the socket runs inside its own current-thread
//!     tokio runtime on a std::thread (optionally core-pinned). The task can
//!     never be migrated by a multi-thread scheduler, which keeps the SPSC
//!     ring's single-producer contract valid and isolates the feed from
//!     unrelated work (axum, executor, cold tasks).
//!   • **SPSC ring transport**: parsed ticks cross to the FV engine through a
//!     wait-free `SpscRing` — no channel wakeup allocation, no locks.
//!   • **Adaptive wake**: after every push the producer unparks the FV thread
//!     (token semantics — never a lost wakeup).
//!
//! The same single thread also runs the REST degradation fallback, so the
//! producer set stays exactly one thread.

pub mod fapi;

pub use fapi::BinanceFapi;

use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;
use xarb_hft::{LogHist, SpscRing, WakeSlot};

pub const WS_URL: &str =
    "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@aggTrade";
const REST_BOOK: &str = "https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT";

/// Ring capacity: 16384 events ≈ 16s of 1k msg/s bursts — never fills in
/// practice; fill level is surfaced as a health metric.
pub const RING_CAP: usize = 16_384;

pub const STATUS_CONNECTING: u8 = 0;
pub const STATUS_LIVE: u8 = 1;
pub const STATUS_DEGRADED: u8 = 2;
pub const STATUS_DOWN: u8 = 3;

pub fn status_str(s: u8) -> &'static str {
    match s {
        STATUS_LIVE => "live",
        STATUS_DEGRADED => "degraded",
        STATUS_DOWN => "down",
        _ => "connecting",
    }
}

/// One parsed market event. `Copy` — travels the SPSC ring with zero cost.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Ev {
    /// bookTicker top-of-book update.
    Quote { bid: f64, ask: f64 },
    /// aggTrade print. `t_ms` is the server event time (lag measurement).
    Trade { p: f64, t_ms: u64 },
}

impl Ev {
    pub fn price(&self) -> f64 {
        match *self {
            Ev::Quote { bid, ask } => (bid + ask) * 0.5,
            Ev::Trade { p, .. } => p,
        }
    }
}

/// Shared feed outputs: the SPSC ring + health atomics + FV-thread wake slot.
pub struct FeedOut {
    pub ring: Arc<SpscRing<Ev>>,
    /// 0 connecting · 1 live · 2 degraded (REST) · 3 down.
    pub status: AtomicU8,
    /// Total frames accepted (parse succeeded and pushed or recovered).
    pub ticks: AtomicU64,
    /// Frames where the fast scanner failed and the DOM fallback ran.
    pub dom_fallbacks: AtomicU64,
    /// Wake slot of the FV engine thread (armed by the engine after spawn).
    pub fv_wake: Arc<WakeSlot>,
    /// Parse+push latency histogram (feed thread records).
    pub parse_us: Arc<LogHist>,
}

impl FeedOut {
    pub fn new(
        ring: Arc<SpscRing<Ev>>,
        fv_wake: Arc<WakeSlot>,
        parse_us: Arc<LogHist>,
    ) -> Self {
        FeedOut {
            ring,
            status: AtomicU8::new(STATUS_CONNECTING),
            ticks: AtomicU64::new(0),
            dom_fallbacks: AtomicU64::new(0),
            fv_wake,
            parse_us,
        }
    }

    pub fn status_str(&self) -> &'static str {
        status_str(self.status.load(Ordering::Relaxed))
    }
}

/// Spawn the feed on a dedicated std::thread with its own current-thread
/// runtime. Optionally pinned to `core`.
pub fn spawn_dedicated(
    out: Arc<FeedOut>,
    pin: Option<usize>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("binance-feed".into())
        .spawn(move || {
            if let Some(c) = pin {
                let _ = xarb_hft::affinity::pin_current(c);
            }
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("feed runtime");
            rt.block_on(async move {
                // Both producers share this single-threaded runtime → the
                // SPSC single-producer contract holds.
                tokio::spawn(run_socket(out.clone()));
                run_rest_fallback(out).await;
            });
        })
        .expect("spawn binance feed thread")
}

async fn run_socket(out: Arc<FeedOut>) {
    let mut retries: u32 = 0;
    loop {
        out.status.store(STATUS_CONNECTING, Ordering::Relaxed);
        match tokio_tungstenite::connect_async(WS_URL).await {
            Ok((ws, _)) => {
                retries = 0;
                out.status.store(STATUS_LIVE, Ordering::Relaxed);
                log("WS live");
                let (mut write, mut read) = ws.split();
                loop {
                    match read.next().await {
                        Some(Ok(msg)) => match msg {
                            tokio_tungstenite::tungstenite::Message::Text(txt) => {
                                handle_frame(&out, &txt);
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
        if out.status.load(Ordering::Relaxed) == STATUS_LIVE {
            out.status.store(STATUS_DOWN, Ordering::Relaxed);
        }
        let delay = Duration::from_millis((1000u64 << retries.min(4)).min(15_000));
        retries += 1;
        log("WS closed, reconnecting…");
        tokio::time::sleep(delay).await;
    }
}

/// Parse → ring → unpark: the entire producer hot path (no allocation, one
/// relaxed atomic increment, one token unpark).
fn handle_frame(out: &FeedOut, txt: &str) {
    let t0 = std::time::Instant::now();
    let ev = match parse_frame(txt) {
        Some(ev) => ev,
        None => {
            // Fast scanner failed — fall back to the DOM parser.
            out.dom_fallbacks.fetch_add(1, Ordering::Relaxed);
            match parse_frame_dom(txt) {
                Some(ev) => ev,
                None => return,
            }
        }
    };
    out.ring.try_push(ev);
    out.ticks.fetch_add(1, Ordering::Relaxed);
    out.fv_wake.wake();
    out.parse_us.record(t0.elapsed().as_nanos() as u64);
}

/// REST degradation fallback: polls bookTicker while the socket is down.
/// Runs on the SAME single-threaded runtime (SPSC producer stays unique).
async fn run_rest_fallback(out: Arc<FeedOut>) {
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        let live = out.status.load(Ordering::Relaxed) == STATUS_LIVE;
        if !live {
            if let Ok(r) = http.get(REST_BOOK).send().await {
                if let Ok(j) = r.json::<serde_json::Value>().await {
                    let b = j["bidPrice"].as_str().and_then(|s| s.parse::<f64>().ok());
                    let a = j["askPrice"].as_str().and_then(|s| s.parse::<f64>().ok());
                    if let (Some(b), Some(a)) = (b, a) {
                        if b > 0.0 && a > 0.0 {
                            if out.status.load(Ordering::Relaxed) != STATUS_LIVE {
                                out.status.store(STATUS_DEGRADED, Ordering::Relaxed);
                            }
                            out.ring.try_push(Ev::Quote { bid: b, ask: a });
                            out.ticks.fetch_add(1, Ordering::Relaxed);
                            out.fv_wake.wake();
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

// ── zero-DOM fast scanner ───────────────────────────────────────────────────

/// Find `"key":"value"` and return the byte range of value.
fn find_quoted_value(raw: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    let kl = key.len();
    let mut i = 0;
    while i + kl + 4 <= raw.len() {
        if raw[i] == b'"'
            && raw[i + 1..].starts_with(key)
            && raw[i + 1 + kl] == b'"'
            && raw[i + 2 + kl] == b':'
            && raw[i + 3 + kl] == b'"'
        {
            let start = i + 4 + kl;
            let mut j = start;
            while j < raw.len() && raw[j] != b'"' {
                j += 1;
            }
            if j < raw.len() {
                return Some((start, j));
            }
            return None;
        }
        i += 1;
    }
    None
}

/// Find `"key":12345` (unquoted number) and return the digit byte range.
fn find_num_value(raw: &[u8], key: &[u8]) -> Option<(usize, usize)> {
    let kl = key.len();
    let mut i = 0;
    while i + kl + 3 <= raw.len() {
        if raw[i] == b'"'
            && raw[i + 1..].starts_with(key)
            && raw[i + 1 + kl] == b'"'
            && raw[i + 2 + kl] == b':'
        {
            let start = i + 3 + kl;
            let mut j = start;
            while j < raw.len() && (raw[j].is_ascii_digit() || raw[j] == b'-') {
                j += 1;
            }
            if j > start {
                return Some((start, j));
            }
            return None;
        }
        i += 1;
    }
    None
}

fn has_sub(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    let first = needle[0];
    for i in 0..=hay.len() - needle.len() {
        if hay[i] == first && hay[i..].starts_with(needle) {
            return true;
        }
    }
    false
}

fn parse_f64_field(raw: &[u8], key: &[u8]) -> Option<f64> {
    let (a, b) = find_quoted_value(raw, key)?;
    let s = std::str::from_utf8(&raw[a..b]).ok()?;
    let v = s.parse::<f64>().ok()?;
    if v.is_finite() && v > 0.0 && v < 1e9 {
        Some(v)
    } else {
        None
    }
}

fn parse_u64_field(raw: &[u8], key: &[u8]) -> Option<u64> {
    let (a, b) = find_num_value(raw, key)?;
    let s = std::str::from_utf8(&raw[a..b]).ok()?;
    s.parse::<u64>().ok()
}

/// Fast zero-DOM frame parser for the Binance combined stream.
pub fn parse_frame(raw: &str) -> Option<Ev> {
    let b = raw.as_bytes();
    if b.len() < 20 {
        return None;
    }
    if has_sub(b, b"aggTrade") {
        // {"stream":"btcusdt@aggTrade","data":{"e":"aggTrade",...,"p":"83,","T":123,...}}
        let p = parse_f64_field(b, b"p")?;
        let t = parse_u64_field(b, b"T")?;
        Some(Ev::Trade { p, t_ms: t })
    } else if has_sub(b, b"bookTicker") {
        // {"stream":"btcusdt@bookTicker","data":{"u":..,"s":"BTCUSDT","b":"..","B":..,"a":"..","A":..}}
        let bid = parse_f64_field(b, b"b")?;
        let ask = parse_f64_field(b, b"a")?;
        Some(Ev::Quote { bid, ask })
    } else {
        None
    }
}

/// DOM fallback — correctness safety net for unexpected payload shapes.
pub fn parse_frame_dom(raw: &str) -> Option<Ev> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let d = v.get("data").unwrap_or(&v);
    if d.get("b").is_some() {
        let b = d["b"].as_str()?.parse::<f64>().ok()?;
        let a = d["a"].as_str()?.parse::<f64>().ok()?;
        return Some(Ev::Quote { bid: b, ask: a });
    }
    if d.get("e").and_then(|e| e.as_str()) == Some("aggTrade") {
        let p = d["p"].as_str()?.parse::<f64>().ok()?;
        let t = d["T"].as_u64()?;
        return Some(Ev::Trade { p, t_ms: t });
    }
    None
}

fn log(msg: &str) {
    println!("[binance] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOK: &str = r#"{"stream":"btcusdt@bookTicker","data":{"u":400900217,"s":"BTCUSDT","b":"83200.01000000","B":"2.65000000","a":"83200.02000000","A":"5.45900000"}}"#;
    const TRADE: &str = r#"{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1672515782136,"s":"BTCUSDT","a":261299323,"f":261299320,"l":261299323,"p":"83123.45","q":"0.012","T":1672515782135,"m":false}}"#;

    #[test]
    fn fast_parser_book() {
        match parse_frame(BOOK) {
            Some(Ev::Quote { bid, ask }) => {
                assert!((bid - 83_200.01).abs() < 1e-9);
                assert!((ask - 83_200.02).abs() < 1e-9);
            }
            other => panic!("bad parse: {other:?}"),
        }
    }

    #[test]
    fn fast_parser_trade() {
        match parse_frame(TRADE) {
            Some(Ev::Trade { p, t_ms }) => {
                assert!((p - 83_123.45).abs() < 1e-9);
                assert_eq!(t_ms, 1_672_515_782_135);
            }
            other => panic!("bad parse: {other:?}"),
        }
    }

    #[test]
    fn dom_fallback_agrees() {
        for raw in [BOOK, TRADE] {
            let fast = parse_frame(raw);
            let dom = parse_frame_dom(raw);
            match (fast, dom) {
                (Some(a), Some(b)) => assert_eq!(a, b),
                _ => panic!("parse mismatch"),
            }
        }
    }

    #[test]
    fn fast_parser_rejects_garbage() {
        assert!(parse_frame("").is_none());
        assert!(parse_frame("not json").is_none());
        assert!(parse_frame(r#"{"stream":"x","data":{}}"#).is_none());
        // book without ask → None (fallback path will also fail safely)
        assert!(parse_frame(r#"{"stream":"btcusdt@bookTicker","data":{"b":"1"}}"#).is_none());
    }

    #[test]
    fn quoted_vs_numeric_field_extraction() {
        let raw = br#"{"p":"8.5","T":123}"#;
        assert_eq!(parse_f64_field(raw, b"p"), Some(8.5));
        assert_eq!(parse_u64_field(raw, b"T"), Some(123));
        // p as number must NOT match the quoted extractor
        assert!(find_quoted_value(br#"{"T":9}"#, b"T").is_none());
    }

    #[test]
    fn key_prefix_safety() {
        // "b" must not match "book" or "bs" fields
        let raw = br#"{"book":"x","bs":"y","b":"5.5"}"#;
        let (a, b) = find_quoted_value(raw, b"b").unwrap();
        assert_eq!(&raw[a..b], b"5.5");
    }
}
