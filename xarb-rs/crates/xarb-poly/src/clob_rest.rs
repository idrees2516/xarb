//! Polymarket CLOB REST client: L1 (EIP-712 derive-key) and L2 (HMAC) auth,
//! marketable BUY order posting, and tick-size lookup.

use crate::eip712::{
    addr_to_hex, build_buy_order, clob_auth_signature, l2_headers, Creds, RawOrder,
};
use anyhow::{anyhow, bail, Context, Result};
use k256::ecdsa::SigningKey;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub const CLOB_HOST: &str = "https://clob.polymarket.com";

fn now_sec() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Authenticated CLOB client (paper mode = no creds, order posting disabled).
pub struct ClobClient {
    http: reqwest::Client,
    address: [u8; 20],
    address_hex: String,
    sk: Option<SigningKey>,
    creds: Option<Creds>,
}

impl ClobClient {
    /// Paper-mode client: no credentials, live order posting refused.
    pub fn paper() -> Self {
        ClobClient {
            http: http_client(),
            address: [0u8; 20],
            address_hex: String::new(),
            sk: None,
            creds: None,
        }
    }

    /// Live client from a wallet private key. Derives an API key on first use
    /// unless explicit credentials are provided.
    pub fn live(private_key_hex: &str, creds: Option<Creds>) -> Result<Self> {
        let raw = hex::decode(private_key_hex.trim().trim_start_matches("0x"))
            .context("POLY_PRIVATE_KEY: bad hex")?;
        if raw.len() != 32 {
            bail!("POLY_PRIVATE_KEY must be 32 bytes");
        }
        let sk = SigningKey::from_slice(&raw).context("POLY_PRIVATE_KEY: invalid secp256k1 key")?;
        let address = crate::eip712::address_of(&sk);
        let address_hex = format!("0x{}", addr_to_hex(&address));
        Ok(ClobClient {
            http: http_client(),
            address,
            address_hex,
            sk: Some(sk),
            creds,
        })
    }

    pub fn address_hex(&self) -> &str {
        &self.address_hex
    }

    pub fn is_live(&self) -> bool {
        self.sk.is_some()
    }

    /// L1 auth: POST /auth/derive-key → {apiKey, secret, passphrase}.
    pub async fn derive_api_key(&mut self) -> Result<Creds> {
        let sk = self.sk.as_ref().ok_or_else(|| anyhow!("no private key"))?;
        let ts = now_sec();
        let sig = clob_auth_signature(sk, ts, 0)?;
        let sig_hex = format!("0x{}", hex::encode(sig));
        let resp = self
            .http
            .post(format!("{CLOB_HOST}/auth/derive-key"))
            .header("POLY_ADDRESS", &self.address_hex)
            .header("POLY_TIMESTAMP", ts.to_string())
            .header("POLY_NONCE", "0")
            .header("POLY_SIGNATURE", sig_hex)
            .header("Content-Type", "application/json")
            .body("{}")
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .context("derive-key request failed")?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("derive-key HTTP {status}: {body}");
        }
        let j: Value = serde_json::from_str(&body).context("derive-key: bad json")?;
        let creds = Creds {
            api_key: j["apiKey"]
                .as_str()
                .ok_or_else(|| anyhow!("derive-key: no apiKey"))?
                .to_string(),
            secret: j["secret"]
                .as_str()
                .ok_or_else(|| anyhow!("derive-key: no secret"))?
                .to_string(),
            passphrase: j["passphrase"]
                .as_str()
                .ok_or_else(|| anyhow!("derive-key: no passphrase"))?
                .to_string(),
        };
        Ok(creds)
    }

    /// Ensure credentials exist (derive if needed). Call at startup in live mode.
    pub async fn ensure_creds(&mut self) -> Result<()> {
        if self.creds.is_none() {
            self.creds = Some(self.derive_api_key().await?);
            println!("[clob] api key derived for {}", self.address_hex);
        }
        Ok(())
    }

    /// Submit a signed marketable BUY order. Returns (orderID, status, raw).
    pub async fn post_buy_order(
        &self,
        token_id_dec: &str,
        price_dollars: f64,
        size_shares: f64,
        neg_risk: bool,
    ) -> Result<(String, String, String)> {
        let sk = self.sk.as_ref().ok_or_else(|| anyhow!("paper client"))?;
        let order: RawOrder = build_buy_order(token_id_dec, price_dollars, size_shares, self.address)
            .map_err(|e| anyhow!("order build: {e}"))?;
        let body = order
            .signed_body(sk, neg_risk)
            .map_err(|e| anyhow!("order sign: {e}"))?;

        let creds = self.creds.as_ref().ok_or_else(|| anyhow!("no L2 creds"))?;
        let path = "/order";
        let ts = now_sec();
        let headers = l2_headers(creds, &self.address_hex, "POST", path, &body, ts);

        let mut req = self
            .http
            .post(format!("{CLOB_HOST}{path}"))
            .header("Content-Type", "application/json")
            .body(body.clone());
        for (k, v) in headers {
            req = req.header(&k, &v);
        }
        let resp = req
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .context("order request failed")?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("order HTTP {status}: {text}");
        }
        let j: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let id = j["orderID"].as_str().unwrap_or("").to_string();
        let st = j["status"].as_str().unwrap_or("unknown").to_string();
        Ok((id, st, text))
    }

    /// Sanity probe of L2 auth (GET /auth/api-keys). Returns ok flag.
    pub async fn verify_auth(&self) -> Result<bool> {
        let creds = self
            .creds
            .as_ref()
            .ok_or_else(|| anyhow!("no L2 creds"))?;
        let path = "/auth/api-keys";
        let ts = now_sec();
        let headers = l2_headers(creds, &self.address_hex, "GET", path, "", ts);
        let mut req = self.http.get(format!("{CLOB_HOST}{path}"));
        for (k, v) in headers {
            req = req.header(&k, &v);
        }
        let resp = req
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .context("api-keys request failed")?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            println!("[clob] verify_auth HTTP {status}: {text}");
            return Ok(false);
        }
        Ok(true)
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("xarb-rs/0.2")
        .build()
        .unwrap_or_default()
}
