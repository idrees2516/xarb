//! Async CLOB REST client with pre-warmed HTTP/2 connections.
//!
//! The order fire path is `post_order`: the body string is built by
//! `OrderBuilder` (exact bytes are HMAC-signed by the L2 headers), and the
//! request reuses a keep-alive HTTP/2 connection with TCP_NODELAY.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::auth::{level1_headers, level2_headers, ApiCreds};
use crate::spec::*;
use crate::signer::Wallet;

#[derive(Debug, Deserialize, Default)]
pub struct OrderResp {
    #[serde(default)]
    pub success: bool,
    #[serde(default, rename = "errorMsg")]
    pub error_msg: Option<String>,
    #[serde(default, rename = "orderID")]
    pub order_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "takingAmount")]
    pub taking_amount: Option<String>,
    #[serde(default, rename = "makingAmount")]
    pub making_amount: Option<String>,
    #[serde(default)]
    pub transactions_hash: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
pub struct BalanceResp {
    #[serde(default)]
    pub balance: Option<String>,
    #[serde(default)]
    pub allowance: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BookLevel {
    pub price: String,
    pub size: String,
}

#[derive(Debug, Deserialize)]
pub struct BookResp {
    #[serde(default)]
    pub market: Option<String>,
    #[serde(default)]
    pub asset_id: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub tick_size: Option<String>,
    #[serde(default)]
    pub min_order_size: Option<f64>,
    #[serde(default)]
    pub neg_risk: Option<bool>,
    #[serde(default)]
    pub bids: Option<Vec<BookLevel>>,
    #[serde(default)]
    pub asks: Option<Vec<BookLevel>>,
}

#[derive(Clone)]
pub struct ClobClient {
    http: reqwest::Client,
    pub base: String,
    wallet: Arc<Wallet>,
    creds: Arc<tokio::sync::RwLock<Option<ApiCreds>>>,
}

impl ClobClient {
    pub fn new(base: String, wallet: Arc<Wallet>) -> anyhow::Result<ClobClient> {
        let http = reqwest::Client::builder()
            .tcp_nodelay(true)
            .pool_max_idle_per_host(4)
            .pool_idle_timeout(Duration::from_secs(90))
            .timeout(Duration::from_secs(8))
            .gzip(true)
            .build()?;
        Ok(ClobClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            wallet,
            creds: Arc::new(tokio::sync::RwLock::new(None)),
        })
    }

    pub fn wallet(&self) -> &Wallet {
        &self.wallet
    }

    /// GET /time (public) — also pre-warms TLS/H2 connections.
    pub async fn time(&self) -> anyhow::Result<i64> {
        let url = format!("{}{}", self.base, EP_TIME);
        let txt = self.http.get(&url).send().await?.error_for_status()?.text().await?;
        Ok(txt.trim().trim_matches('"').parse().unwrap_or(0))
    }

    /// GET /book?token_id=... (public)
    pub async fn book(&self, token_id: &str) -> anyhow::Result<BookResp> {
        let url = format!("{}{}?token_id={}", self.base, EP_BOOK, token_id);
        let resp = self.http.get(&url).send().await?.error_for_status()?;
        Ok(resp.json().await?)
    }

    /// L1 auth: derive (or create) API credentials. GET /auth/derive-api-key.
    pub async fn derive_api_creds(&self, nonce: u64) -> anyhow::Result<ApiCreds> {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let url = format!("{}{}", self.base, EP_DERIVE_API_KEY);
        let mut req = self.http.get(&url);
        for (k, v) in level1_headers(&self.wallet, ts, nonce) {
            req = req.header(k, v);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let txt = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("derive-api-key HTTP {}: {}", status, txt);
        }
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            apiKey: Option<String>,
            #[serde(default)]
            secret: Option<String>,
            #[serde(default)]
            passphrase: Option<String>,
        }
        let raw: Raw = serde_json::from_str(&txt)?;
        let creds = ApiCreds {
            api_key: raw.apiKey.ok_or_else(|| anyhow::anyhow!("no apiKey in response"))?,
            secret: raw.secret.ok_or_else(|| anyhow::anyhow!("no secret in response"))?,
            passphrase: raw
                .passphrase
                .ok_or_else(|| anyhow::anyhow!("no passphrase in response"))?,
        };
        *self.creds.write().await = Some(creds.clone());
        Ok(creds)
    }

    pub async fn has_creds(&self) -> bool {
        self.creds.read().await.is_some()
    }

    /// Cached api key (for the `owner` field) without network traffic.
    pub async fn api_key_hint(&self) -> String {
        self.creds
            .read()
            .await
            .as_ref()
            .map(|c| c.api_key.clone())
            .unwrap_or_default()
    }

    /// GET /balance-allowance (L2) — USDC balance + exchange allowance.
    pub async fn balance(&self) -> anyhow::Result<(f64, f64)> {
        let creds = self.creds.read().await.clone();
        let creds = creds.ok_or_else(|| anyhow::anyhow!("no L2 creds; derive first"))?;
        let path = format!("{}?asset_type=COLLATERAL&signature_type=0", EP_BALANCE);
        let ts = now_unix();
        let url = format!("{}{}", self.base, path);
        let mut req = self.http.get(&url);
        for (k, v) in level2_headers(&self.wallet, &creds, ts, "GET", &path, None) {
            req = req.header(k, v);
        }
        let resp: BalanceResp = req.send().await?.error_for_status()?.json().await?;
        Ok((
            resp.balance.and_then(|b| b.parse().ok()).unwrap_or(0.0),
            resp.allowance.and_then(|a| a.parse().ok()).unwrap_or(0.0),
        ))
    }

    /// POST /order — the fire path. `body` must be the exact string used in
    /// the HMAC (OrderBuilder::json_body).
    pub async fn post_order(&self, body: &str) -> anyhow::Result<OrderResp> {
        let creds = self.creds.read().await.clone();
        let creds = creds.ok_or_else(|| anyhow::anyhow!("no L2 creds; derive first"))?;
        let ts = now_unix();
        let mut req = self
            .http
            .post(format!("{}{}", self.base, EP_POST_ORDER))
            .header("Content-Type", "application/json")
            .timeout(Duration::from_millis(2_500));
        for (k, v) in level2_headers(&self.wallet, &creds, ts, "POST", EP_POST_ORDER, Some(body)) {
            req = req.header(k, v);
        }
        let resp = req.body(body.to_string()).send().await?;
        let status = resp.status();
        let txt = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("POST /order HTTP {}: {}", status, txt);
        }
        let parsed: OrderResp = serde_json::from_str(&txt)
            .map_err(|e| anyhow::anyhow!("order response parse: {e}; body: {txt}"))?;
        Ok(parsed)
    }

    /// DELETE /cancel-all (L2).
    pub async fn cancel_all(&self) -> anyhow::Result<()> {
        let creds = self.creds.read().await.clone();
        let creds = creds.ok_or_else(|| anyhow::anyhow!("no L2 creds"))?;
        let ts = now_unix();
        let url = format!("{}{}", self.base, EP_CANCEL_ALL);
        let mut req = self.http.delete(&url);
        for (k, v) in level2_headers(&self.wallet, &creds, ts, "DELETE", EP_CANCEL_ALL, None) {
            req = req.header(k, v);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("cancel-all HTTP {}", resp.status());
        }
        Ok(())
    }

    /// Warm N connections (call at startup and periodically).
    pub async fn prewarm(&self, n: usize) {
        for _ in 0..n {
            let _ = self.time().await;
        }
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_endpoints_reachable_shape() {
        // network-optional: skipped when offline
        let w = Wallet::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        let c = ClobClient::new("https://clob.polymarket.com".into(), Arc::new(w)).unwrap();
        match c.time().await {
            Ok(t) => {
                assert!(t > 1_700_000_000, "server time {t}");
            }
            Err(e) => {
                eprintln!("offline, skipping: {e:#}");
            }
        }
    }
}
