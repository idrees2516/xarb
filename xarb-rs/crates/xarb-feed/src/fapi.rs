//! Binance USDT-M futures REST client — the live delta-hedge execution leg.
//!
//! Signs and posts MARKET orders (`POST /fapi/v1/order`) with HMAC-SHA256
//! over the canonical query string, `X-MBX-APIKEY` auth header,
//! `recvWindow` guard and Binance server-time timestamp. Flattens use
//! `reduceOnly=true` so a hedge unwind can never open fresh exposure.
//!
//! * mainnet:  `https://fapi.binance.com`
//! * testnet:  `https://testnet.binancefuture.com` (`XARB_BINANCE_TESTNET=1`)
//!
//! Paper mode never touches this path — the cold task simulates hedge fills
//! against the live Binance top-of-book (bid for shorts / ask for covers).

use anyhow::{anyhow, Result};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::time::Duration;

const RECV_WINDOW: u64 = 5_000;

/// Signed-market-order result.
#[derive(Debug, Clone)]
pub struct FapiFill {
    pub order_id: u64,
    pub avg_px: f64,
    pub exec_qty: f64,
    pub status: String,
}

#[derive(Clone)]
pub struct BinanceFapi {
    http: reqwest::Client,
    api_key: String,
    secret: String,
    base: String,
}

impl BinanceFapi {
    /// Build from env (`BINANCE_API_KEY`, `BINANCE_API_SECRET`,
    /// optional `XARB_BINANCE_TESTNET=1`). None in paper mode / missing keys.
    pub fn from_env(paper: bool) -> Option<BinanceFapi> {
        if paper {
            return None;
        }
        let key = std::env::var("BINANCE_API_KEY").ok()?;
        let secret = std::env::var("BINANCE_API_SECRET").ok()?;
        if key.is_empty() || secret.is_empty() {
            return None;
        }
        let base = if std::env::var("XARB_BINANCE_TESTNET").ok().as_deref() == Some("1") {
            "https://testnet.binancefuture.com".to_string()
        } else {
            "https://fapi.binance.com".to_string()
        };
        let http = reqwest::Client::builder()
            .tcp_nodelay(true) // latency: no Nagle on the hedge leg
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;
        Some(BinanceFapi { http, api_key: key, secret, base })
    }

    /// HMAC-SHA256 hex signature of the canonical query string.
    fn sign(&self, query: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.secret.as_bytes())
            .expect("hmac accepts any key length");
        mac.update(query.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn ts(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Post a MARKET order. `side` = "BUY" | "SELL". `reduce_only` marks the
    /// unwind-only flatten orders.
    pub async fn market_order(
        &self,
        symbol: &str,
        side: &str,
        qty: f64,
        reduce_only: bool,
    ) -> Result<FapiFill> {
        let qty = crate::fapi::round_qty(qty);
        if qty < 0.001 {
            return Err(anyhow!("qty {qty} below exchange minimum"));
        }
        let mut params = format!(
            "symbol={symbol}&side={side}&type=MARKET&quantity={qty:.3}&recvWindow={RECV_WINDOW}&timestamp={}",
            self.ts()
        );
        if reduce_only {
            params.push_str("&reduceOnly=true");
        }
        let sig = self.sign(&params);
        let url = format!("{}/fapi/v1/order?{params}&signature={sig}", self.base);
        let resp = self
            .http
            .post(&url)
            .header("X-MBX-APIKEY", &self.api_key)
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await?;
        if !status.is_success() {
            let code = body["code"].as_i64().unwrap_or(0);
            let msg = body["msg"].as_str().unwrap_or("unknown").to_string();
            return Err(anyhow!("fapi order rejected ({status}, code {code}): {msg}"));
        }
        let avg = body["avgPrice"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| body["avgPrice"].as_f64())
            .unwrap_or(0.0);
        let eq = body["executedQty"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| body["executedQty"].as_f64())
            .unwrap_or(qty);
        if avg <= 0.0 && eq > 0.0 {
            // market orders can ack before avgPrice is populated — pull the
            // execution report once
            if let Some(p) = self.avg_price(body["orderId"].as_u64().unwrap_or(0), symbol).await {
                return Ok(FapiFill {
                    order_id: body["orderId"].as_u64().unwrap_or(0),
                    avg_px: p,
                    exec_qty: eq,
                    status: body["status"].as_str().unwrap_or("NEW").to_string(),
                });
            }
        }
        Ok(FapiFill {
            order_id: body["orderId"].as_u64().unwrap_or(0),
            avg_px: avg,
            exec_qty: eq,
            status: body["status"].as_str().unwrap_or("NEW").to_string(),
        })
    }

    /// Fetch a single order's average price (fill-report fallback).
    async fn avg_price(&self, order_id: u64, symbol: &str) -> Option<f64> {
        if order_id == 0 {
            return None;
        }
        let query = format!(
            "symbol={symbol}&orderId={order_id}&recvWindow={RECV_WINDOW}&timestamp={}",
            self.ts()
        );
        let sig = self.sign(&query);
        let url = format!("{}/fapi/v1/order?{query}&signature={sig}", self.base);
        let v: Value = self
            .http
            .get(&url)
            .header("X-MBX-APIKEY", &self.api_key)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        v["avgPrice"].as_str().and_then(|s| s.parse::<f64>().ok())
    }

    /// Signed connectivity + balance probe (`polyarb doctor`-style).
    pub async fn ping(&self) -> Result<f64> {
        let query = format!(
            "symbol=BTCUSDT&recvWindow={RECV_WINDOW}&timestamp={}",
            self.ts()
        );
        let sig = self.sign(&query);
        let url = format!("{}/fapi/v2/balance?{query}&signature={sig}", self.base);
        let resp = self
            .http
            .get(&url)
            .header("X-MBX-APIKEY", &self.api_key)
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await?;
        if !status.is_success() {
            return Err(anyhow!("fapi balance probe failed ({status})"));
        }
        let bal = body
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|e| e["asset"].as_str() == Some("USDT"))
                    .and_then(|e| e["balance"].as_str().and_then(|s| s.parse::<f64>().ok()))
            })
            .unwrap_or(0.0);
        Ok(bal)
    }

    pub fn is_testnet(&self) -> bool {
        self.base.contains("testnet")
    }
}

/// Round to the BTCUSDT perp lot step (0.001 BTC), preserving sign.
pub fn round_qty(q: f64) -> f64 {
    (q * 1000.0).trunc() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qty_rounding() {
        assert_eq!(round_qty(0.0019049), 0.001);
        assert_eq!(round_qty(-0.0029), -0.002);
        assert_eq!(round_qty(0.0009), 0.0);
    }

    #[test]
    fn signature_is_deterministic_and_hex() {
        let f = BinanceFapi {
            http: reqwest::Client::new(),
            api_key: "k".into(),
            secret: "s".into(),
            base: "https://fapi.binance.com".into(),
        };
        let q = "symbol=BTCUSDT&side=SELL&type=MARKET&quantity=0.019";
        let a = f.sign(q);
        let b = f.sign(q);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // different query → different signature
        assert_ne!(a, f.sign("symbol=BTCUSDT&side=BUY"));
    }
}
