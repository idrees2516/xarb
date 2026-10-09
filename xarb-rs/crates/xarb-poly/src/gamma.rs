//! Gamma API discovery of the current 5-minute BTC UP/DOWN window.
//!
//! Windows are clock-aligned: slug = `btc-updown-5m-{floor(epoch/300)·300}`.

use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;

pub const GAMMA: &str = "https://gamma-api.polymarket.com";

#[derive(Debug, Clone)]
pub struct WindowEvent {
    pub up_token_id: String,
    pub down_token_id: String,
    pub condition_id: String,
    pub question: String,
    pub accepting: bool,
}

/// Discover the window for `epoch` (seconds). Returns None while the market
/// has not been created yet (typical in the first seconds after rollover).
pub async fn discover_window(http: &reqwest::Client, epoch: u64) -> Result<Option<WindowEvent>> {
    let slug = format!("btc-updown-5m-{epoch}");
    let url = format!("{GAMMA}/events?slug={slug}");
    let resp = http
        .get(&url)
        .timeout(std::time::Duration::from_millis(5000))
        .send()
        .await?;
    let j: Value = resp.json().await?;
    let arr = j.as_array().ok_or_else(|| anyhow::anyhow!("gamma: not an array"))?;
    if arr.is_empty() {
        return Ok(None);
    }
    let ev = &arr[0];
    let market = ev
        .get("markets")
        .and_then(|m| m.as_array())
        .and_then(|m| m.first())
        .ok_or_else(|| anyhow::anyhow!("gamma: no market in event"))?;
    let token_ids_raw = market
        .get("clobTokenIds")
        .and_then(|c| c.as_str())
        .unwrap_or("[]");
    let ids: Vec<String> = serde_json::from_str(token_ids_raw).unwrap_or_default();
    if ids.len() < 2 {
        return Ok(None);
    }
    let closed = market.get("closed").and_then(|c| c.as_bool()).unwrap_or(true);
    let accepting = market
        .get("acceptingOrders")
        .and_then(|a| a.as_bool())
        .unwrap_or(false);
    Ok(Some(WindowEvent {
        up_token_id: ids[0].clone(),
        down_token_id: ids[1].clone(),
        condition_id: market
            .get("conditionId")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        question: ev
            .get("title")
            .and_then(|t| t.as_str())
            .or_else(|| market.get("question").and_then(|q| q.as_str()))
            .unwrap_or("")
            .to_string(),
        accepting: accepting && !closed,
    }))
}

/// Convenience: retry discovery for up to `attempts` tries, 2s apart.
pub async fn discover_with_retries(
    http: Arc<reqwest::Client>,
    epoch: u64,
    attempts: u32,
) -> Option<WindowEvent> {
    for i in 0..attempts {
        match discover_window(&http, epoch).await {
            Ok(Some(ev)) => return Some(ev),
            Ok(None) => {}
            Err(e) => println!("[polymarket] discover error: {e}"),
        }
        if i + 1 < attempts {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }
    None
}
