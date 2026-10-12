//! Polymarket CLOB market-channel feed + REST book bootstrap.
//!
//! Subscribes `{"assets_ids":[up,down],"type":"market"}` on
//! `wss://ws-subscriptions-clob.polymarket.com/ws/market`, normalizes
//! `book` snapshots and `price_change` deltas into `wire::FeedEvent`s,
//! and keeps the text "PING" heartbeat alive (server closes quiet
//! connections).
//!
//! On window rollover (token ids change via the watch channel) the task
//! reconnects with the new subscription.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hotcore::clock::Clock;
use tokio_tungstenite::tungstenite::Message;
use wire::{FeedEvent, SIDE_ASK, SIDE_BID, TOK_DOWN, TOK_UP};

use crate::health::FeedHealth;

/// Tokens for the active window (decimal strings as used on the wire).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WindowTokens {
    pub up: String,
    pub down: String,
    pub seq: u32,
}

fn price_to_cents(p: &str) -> i64 {
    let f: f64 = p.parse().unwrap_or(0.0);
    (f * 100.0).round() as i64
}

fn size_f(s: &str) -> f64 {
    s.parse().unwrap_or(0.0)
}

/// Fetch the REST book for one token and emit (token, side, price_c, size) tuples.
pub async fn fetch_rest_book(
    clob_rest: &str,
    token: &str,
) -> anyhow::Result<Vec<(u8, u8, i64, f64)>> {
    let url = format!("{}/book?token_id={}", clob_rest.trim_end_matches('/'), token);
    let resp = reqwest::get(&url).await?;
    let txt = resp.error_for_status()?.text().await?;
    let v: serde_json::Value = serde_json::from_str(&txt)?;
    let mut out = Vec::with_capacity(128);
    for (side_code, key) in [(SIDE_BID, "bids"), (SIDE_ASK, "asks")] {
        if let Some(levels) = v.get(key).and_then(|l| l.as_array()) {
            for lv in levels {
                let price = lv.get("price").and_then(|p| p.as_str()).unwrap_or("");
                let size = lv.get("size").and_then(|s| s.as_str()).unwrap_or("");
                if price.is_empty() {
                    continue;
                }
                out.push((TOK_UP, side_code, price_to_cents(price), size_f(size)));
            }
        }
    }
    Ok(out)
}

/// Long-running market feed task.
pub async fn run_polymarket(
    ws_url: String,
    clob_rest: String,
    mut tokens: tokio::sync::watch::Receiver<WindowTokens>,
    ring: Arc<hotcore::ring::SpscRing<FeedEvent>>,
    health: Arc<FeedHealth>,
) {
    let clock = Clock::global();
    let mut backoff = 1u64;
    let mut current: Option<WindowTokens> = None;
    loop {
        // latest tokens
        let toks = tokens.borrow().clone();
        if toks.up.is_empty() {
            // no window yet — idle until the window manager publishes one
            health.mark_connected(false);
            tokio::time::sleep(Duration::from_millis(250)).await;
            current = None;
            continue;
        }
        if current.as_ref() != Some(&toks) {
            current = Some(toks.clone());
            tracing::info!(target: "feed", window_seq = toks.seq, "polymarket window switch");
        }
        let up = toks.up.clone();
        let down = toks.down.clone();

        // REST bootstrap (book snapshots; the WS also sends its own on subscribe)
        for (tok_id, tok) in [(TOK_UP, &up), (TOK_DOWN, &down)] {
            match fetch_rest_book(&clob_rest, tok).await {
                Ok(levels) => {
                    let t = clock.mono_ns();
                    let _ = ring.try_push(FeedEvent::PmReset { t_ns: t, token: tok_id });
                    for (_, side, price_c, size) in levels {
                        let _ = ring.try_push(FeedEvent::PmLevel {
                            t_ns: t,
                            token: tok_id,
                            side,
                            price_c,
                            size_sh: size,
                        });
                    }
                    health.on_msg(t);
                }
                Err(e) => {
                    tracing::warn!(target: "feed", "pm rest book failed: {e:#}");
                }
            }
        }

        // WS subscribe
        let sub = serde_json::json!({ "assets_ids": [ up, down ], "type": "market" })
            .to_string();
        match tokio_tungstenite::connect_async(ws_url.as_str()).await {
            Ok((mut ws, _)) => {
                health.mark_connected(true);
                backoff = 1;
                if let Err(e) = ws.send(Message::Text(sub)).await {
                    tracing::warn!(target: "feed", "pm subscribe failed: {e}");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                let _ = ws.flush().await;
                tracing::info!(target: "feed", "polymarket market ws connected");
                let mut ping_at = tokio::time::Instant::now() + Duration::from_secs(8);
                loop {
                    // window changed? drop and resubscribe
                    if tokens.has_changed().unwrap_or(false) {
                        let _ = ws.close(None).await;
                        break;
                    }
                    if tokio::time::Instant::now() >= ping_at {
                        ping_at += Duration::from_secs(8);
                        if let Err(e) = ws.send(Message::Text("PING".to_string())).await {
                            tracing::warn!(target: "feed", "pm ping failed: {e}");
                            break;
                        }
                        continue;
                    }
                    let next = ws.next();
                    let msg = match tokio::time::timeout(Duration::from_secs(30), next).await {
                        Ok(Some(Ok(m))) => m,
                        Ok(Some(Err(e))) => {
                            tracing::warn!(target: "feed", "pm ws error: {e}");
                            break;
                        }
                        Ok(None) => break,
                        Err(_) => {
                            tracing::warn!(target: "feed", "pm ws idle");
                            break;
                        }
                    };
                    let t_recv = clock.mono_ns();
                    match msg {
                        Message::Text(text) => {
                            if text == "PONG" || text == "ping" || text == "pong" {
                                continue;
                            }
                            handle_market_text(&text, &up, &down, t_recv, &ring);
                            health.on_msg(t_recv);
                        }
                        Message::Ping(p) => {
                            let _ = ws.send(Message::Pong(p)).await;
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
            Err(e) => {
                tracing::warn!(target: "feed", "pm ws connect failed: {e}");
            }
        }
        health.mark_connected(false);
        let wait = Duration::from_millis(250 * backoff.min(16));
        tokio::time::sleep(wait).await;
        backoff *= 2;
    }
}

fn handle_market_text(
    text: &str,
    up: &str,
    down: &str,
    t_recv: i64,
    ring: &hotcore::ring::SpscRing<FeedEvent>,
) {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let events: Vec<serde_json::Value> = match v {
        serde_json::Value::Array(a) => a,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => return,
    };
    for ev in events {
        let et = ev.get("event_type").and_then(|t| t.as_str()).unwrap_or("");
        let asset = ev.get("asset_id").and_then(|a| a.as_str()).unwrap_or("");
        let tok = if asset == up {
            TOK_UP
        } else if asset == down {
            TOK_DOWN
        } else {
            continue;
        };
        match et {
            "book" => {
                let _ = ring.try_push(FeedEvent::PmReset { t_ns: t_recv, token: tok });
                for (side_key, side_code) in [("bids", SIDE_BID), ("asks", SIDE_ASK)] {
                    if let Some(levels) = ev.get(side_key).and_then(|l| l.as_array()) {
                        for lv in levels {
                            let price = lv.get("price").and_then(|p| p.as_str()).unwrap_or("");
                            let size = lv.get("size").and_then(|s| s.as_str()).unwrap_or("0");
                            if price.is_empty() {
                                continue;
                            }
                            let _ = ring.try_push(FeedEvent::PmLevel {
                                t_ns: t_recv,
                                token: tok,
                                side: side_code,
                                price_c: price_to_cents(price),
                                size_sh: size_f(size),
                            });
                        }
                    }
                }
            }
            "price_change" => {
                if let Some(changes) = ev.get("price_changes").and_then(|c| c.as_array()) {
                    for ch in changes {
                        let price = ch.get("price").and_then(|p| p.as_str()).unwrap_or("");
                        let side = ch.get("side").and_then(|s| s.as_str()).unwrap_or("");
                        let size = ch.get("size").and_then(|s| s.as_str()).unwrap_or("0");
                        if price.is_empty() {
                            continue;
                        }
                        let side_code = match side {
                            "BUY" => SIDE_BID,
                            _ => SIDE_ASK,
                        };
                        let _ = ring.try_push(FeedEvent::PmLevel {
                            t_ns: t_recv,
                            token: tok,
                            side: side_code,
                            price_c: price_to_cents(price),
                            size_sh: size_f(size),
                        });
                    }
                }
            }
            "tick_size_change" => {
                // tick handled via window metadata; level events unaffected
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring() -> hotcore::ring::SpscRing<FeedEvent> {
        hotcore::ring::SpscRing::<FeedEvent>::with_capacity(1024)
    }

    #[test]
    fn parses_book_snapshot() {
        let r = ring();
        let raw = r#"[{"event_type":"book","market":"0xabc","asset_id":"12345","bids":[{"price":"0.55","size":"120"},{"price":"0.54","size":"80"}],"asks":[{"price":"0.58","size":"90"},{"price":"0.59","size":"150"}],"hash":"x","timestamp":1}]"#;
        handle_market_text(raw, "12345", "99999", 42, &r);
        let mut evs = Vec::new();
        while let Some(e) = r.try_pop() {
            evs.push(e);
        }
        assert_eq!(evs.len(), 5);
        assert!(matches!(evs[0], FeedEvent::PmReset { token: 0, .. }));
        // first bid level
        match evs[1] {
            FeedEvent::PmLevel { side, price_c, size_sh, .. } => {
                assert_eq!(side, SIDE_BID);
                assert_eq!(price_c, 55);
                assert!((size_sh - 120.0).abs() < 1e-9);
            }
            ref other => panic!("bad: {:?}", other),
        }
    }

    #[test]
    fn parses_price_change() {
        let r = ring();
        let raw = r#"{"event_type":"price_change","market":"0xabc","asset_id":"678","price_changes":[{"price":"0.56","side":"SELL","size":"40"}]}"#;
        handle_market_text(raw, "111", "678", 7, &r);
        match r.try_pop().unwrap() {
            FeedEvent::PmLevel { token, side, price_c, size_sh, .. } => {
                assert_eq!(token, TOK_DOWN);
                assert_eq!(side, SIDE_ASK);
                assert_eq!(price_c, 56);
                assert!((size_sh - 40.0).abs() < 1e-9);
            }
            other => panic!("bad: {:?}", other),
        }
    }

    #[test]
    fn cents_conversion() {
        assert_eq!(price_to_cents("0.56"), 56);
        assert_eq!(price_to_cents("0.995"), 100); // rounding to nearest cent
        assert_eq!(price_to_cents("0.005"), 1);
        assert_eq!(price_to_cents("0"), 0);
    }
}
