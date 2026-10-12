//! Binance combined-stream feed (trade + bookTicker).
//!
//! `wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@bookTicker`
//!
//! bookTicker is the fastest best-bid/ask channel Binance offers (no
//! batching); the trade stream feeds the volatility estimator. Trade `id`
//! gaps trigger a health counter so the engine can distrust the vol state.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hotcore::clock::Clock;
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message;
use wire::FeedEvent;

use crate::health::FeedHealth;

#[derive(Deserialize)]
struct TradePayload {
    #[serde(rename = "T")]
    trade_ms: i64,
    #[serde(rename = "t")]
    id: u64,
    p: String,
    q: String,
    #[serde(default)]
    m: bool,
}

#[derive(Deserialize)]
struct BookTickerPayload {
    b: String,
    #[serde(rename = "B")]
    bs: String,
    a: String,
    #[serde(rename = "A")]
    as_: String,
    #[serde(default)]
    u: u64,
}

fn parse_f64(s: &str) -> f64 {
    // Binance emits plain decimal ASCII; fast path avoids locale/format machinery
    s.parse().unwrap_or(0.0)
}

/// Spawn the feed task. Pushes events into `ring`; never blocks the engine
/// (drops + counts on overflow, which would indicate a wedged engine).
pub async fn run_binance(url: String, ring: Arc<hotcore::ring::SpscRing<FeedEvent>>, health: Arc<FeedHealth>) {
    let clock = Clock::global();
    let mut backoff = 1u64;
    loop {
        health.mark_connected(false);
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((mut ws, _resp)) => {
                health.mark_connected(true);
                backoff = 1;
                tracing::info!(target: "feed", binance = url.as_str(), "connected");
                let mut last_trade_id: u64 = 0;
                let mut ping_at = tokio::time::Instant::now() + Duration::from_secs(15);
                loop {
                    let next_msg = ws.next();
                    let ping_due = tokio::time::Instant::now() >= ping_at;
                    if ping_due {
                        ping_at += Duration::from_secs(15);
                        if let Err(e) = ws.send(Message::Ping(vec![0x70])).await {
                            tracing::warn!(target: "feed", "binance ping failed: {e}");
                            break;
                        }
                        continue;
                    }
                    let msg = match tokio::time::timeout(Duration::from_secs(90), next_msg).await {
                        Ok(Some(Ok(m))) => m,
                        Ok(Some(Err(e))) => {
                            tracing::warn!(target: "feed", "binance stream error: {e}");
                            break;
                        }
                        Ok(None) => {
                            tracing::warn!(target: "feed", "binance stream closed");
                            break;
                        }
                        Err(_) => {
                            tracing::warn!(target: "feed", "binance idle timeout");
                            break;
                        }
                    };
                    let t_recv = clock.mono_ns();
                    match msg {
                        Message::Text(text) => {
                            handle_combined(&text, t_recv, &ring, &health, &mut last_trade_id, clock);
                        }
                        Message::Ping(p) => {
                            let _ = ws.send(Message::Pong(p)).await;
                        }
                        Message::Pong(_) => {}
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
            Err(e) => {
                tracing::warn!(target: "feed", "binance connect failed: {e}");
            }
        }
        health.mark_connected(false);
        let wait = Duration::from_millis(250 * backoff.min(32));
        tokio::time::sleep(wait).await;
        backoff *= 2;
    }
}

fn handle_combined(
    text: &str,
    t_recv: i64,
    ring: &hotcore::ring::SpscRing<FeedEvent>,
    health: &FeedHealth,
    last_trade_id: &mut u64,
    clock: &Clock,
) {
    // Combined stream wrapper: {"stream":"btcusdt@trade","data":{...}}
    #[derive(Deserialize)]
    struct Combined {
        stream: String,
        data: serde_json::Value,
    }
    let Ok(combined) = serde_json::from_str::<Combined>(text) else {
        return;
    };
    let t_push = clock.mono_ns();
    if combined.stream.ends_with("@trade") {
        if let Ok(t) = serde_json::from_value::<TradePayload>(combined.data) {
            if *last_trade_id != 0 && t.id > *last_trade_id + 1 {
                health.gaps.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            *last_trade_id = t.id;
            let ev = FeedEvent::BinanceTrade {
                t_ns: t_recv,
                ex_ms: t.trade_ms,
                price: parse_f64(&t.p),
                qty: parse_f64(&t.q),
                aggressor_buy: !t.m, // m = buyer is market maker => aggressor is seller
                id: t.id,
            };
            let _ = ring.try_push(ev);
            health.on_msg(t_push);
        }
    } else if combined.stream.ends_with("@bookTicker") {
        if let Ok(b) = serde_json::from_value::<BookTickerPayload>(combined.data) {
            let ev = FeedEvent::BinanceBook {
                t_ns: t_recv,
                bid: parse_f64(&b.b),
                bid_sz: parse_f64(&b.bs),
                ask: parse_f64(&b.a),
                ask_sz: parse_f64(&b.as_),
                u: b.u,
            };
            let _ = ring.try_push(ev);
            health.on_msg(t_push);
        }
    }
}

/// Test-only helper: normalize a raw combined-stream JSON text.
#[cfg(test)]
pub(crate) fn parse_for_test(text: &str) -> Option<FeedEvent> {
    let ring = hotcore::ring::SpscRing::<FeedEvent>::with_capacity(8);
    let health = FeedHealth::default();
    let clock = hotcore::clock::init();
    let mut last = 0u64;
    handle_combined(text, 0, &ring, &health, &mut last, clock);
    ring.try_pop()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trade() {
        let raw = r#"{"stream":"btcusdt@trade","data":{"e":"trade","E":1766162400123,"s":"BTCUSDT","t":12345,"p":"83215.10","q":"0.012","T":1766162400100,"m":true}}"#;
        match parse_for_test(raw) {
            Some(FeedEvent::BinanceTrade { price, qty, ex_ms, id, aggressor_buy, .. }) => {
                assert!((price - 83215.10).abs() < 1e-6);
                assert!((qty - 0.012).abs() < 1e-9);
                assert_eq!(ex_ms, 1766162400100);
                assert_eq!(id, 12345);
                assert!(!aggressor_buy);
            }
            other => panic!("bad event: {:?}", other),
        }
    }

    #[test]
    fn parses_book_ticker() {
        let raw = r#"{"stream":"btcusdt@bookTicker","data":{"u":400900217,"s":"BTCUSDT","b":"83215.10","B":"0.005","a":"83215.20","A":"0.002"}}"#;
        match parse_for_test(raw) {
            Some(FeedEvent::BinanceBook { bid, ask, bid_sz, ask_sz, .. }) => {
                assert!((bid - 83215.10).abs() < 1e-6);
                assert!((ask - 83215.20).abs() < 1e-6);
                assert!((bid_sz - 0.005).abs() < 1e-9);
                assert!((ask_sz - 0.002).abs() < 1e-9);
            }
            other => panic!("bad event: {:?}", other),
        }
    }
}
