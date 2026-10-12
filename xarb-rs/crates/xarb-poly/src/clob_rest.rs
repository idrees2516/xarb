//! Polymarket CLOB REST client: L1 (EIP-712 derive-key) and L2 (HMAC) auth,
//! marketable BUY order posting, and per-token tick-size / fee-rate lookup.

use crate::eip712::{
    addr_to_hex, build_buy_order, build_sell_order, clob_auth_signature, l2_headers, Creds, RawOrder,
};
use anyhow::{anyhow, bail, Context, Result};
use k256::ecdsa::SigningKey;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const CLOB_HOST: &str = "https://clob.polymarket.com";

/// TTL for the public tick-size / fee-rate lookups (seconds).
const TICK_FEE_TTL_SECS: u64 = 60;

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
    /// token_id → (fetched_at, minimum tick in dollars) — public endpoint.
    tick_cache: Mutex<HashMap<String, (Instant, f64)>>,
    /// token_id → (fetched_at, base taker fee in bps) — public endpoint.
    fee_cache: Mutex<HashMap<String, (Instant, u64)>>,
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
            tick_cache: Mutex::new(HashMap::new()),
            fee_cache: Mutex::new(HashMap::new()),
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
            tick_cache: Mutex::new(HashMap::new()),
            fee_cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn address_hex(&self) -> &str {
        &self.address_hex
    }

    pub fn is_live(&self) -> bool {
        self.sk.is_some()
    }

    /// L1 auth: GET /auth/derive-api-key (ClobAuth EIP-712 headers) →
    /// {apiKey, secret, passphrase}.
    pub async fn derive_api_key(&mut self) -> Result<Creds> {
        let sk = self.sk.as_ref().ok_or_else(|| anyhow!("no private key"))?;
        let ts = now_sec();
        let sig = clob_auth_signature(sk, ts, 0)?;
        let sig_hex = format!("0x{}", hex::encode(sig));
        let resp = self
            .http
            .get(format!("{CLOB_HOST}/auth/derive-api-key"))
            .header("POLY_ADDRESS", &self.address_hex)
            .header("POLY_TIMESTAMP", ts.to_string())
            .header("POLY_NONCE", "0")
            .header("POLY_SIGNATURE", sig_hex)
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .context("derive-api-key request failed")?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("derive-api-key HTTP {status}: {body}");
        }
        let j: Value = serde_json::from_str(&body).context("derive-api-key: bad json")?;
        let creds = Creds {
            api_key: j["apiKey"]
                .as_str()
                .ok_or_else(|| anyhow!("derive-api-key: no apiKey"))?
                .to_string(),
            secret: j["secret"]
                .as_str()
                .ok_or_else(|| anyhow!("derive-api-key: no secret"))?
                .to_string(),
            passphrase: j["passphrase"]
                .as_str()
                .ok_or_else(|| anyhow!("derive-api-key: no passphrase"))?
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

    /// Public GET /tick-size?token_id= → minimum tick in dollars (cached 60s).
    /// Falls back to 0.01 (the observed grid on the 5-minute BTC series).
    pub async fn tick_size(&self, token_id: &str) -> Result<f64> {
        if let Some((at, v)) = self.tick_cache.lock().unwrap().get(token_id) {
            if at.elapsed().as_secs() < TICK_FEE_TTL_SECS {
                return Ok(*v);
            }
        }
        let url = format!("{CLOB_HOST}/tick-size?token_id={token_id}");
        let resp = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .context("tick-size request failed")?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("tick-size HTTP {status}: {text}");
        }
        let j: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let v = j["minimum_tick_size"]
            .as_f64()
            .or_else(|| j["minimum_tick_size"].as_str().and_then(|s| s.parse().ok()))
            .or_else(|| j["tick_size"].as_f64())
            .or_else(|| j.as_f64());
        let tick = v.filter(|t| *t > 0.0 && *t <= 0.1).unwrap_or(0.01);
        self.tick_cache
            .lock()
            .unwrap()
            .insert(token_id.to_string(), (Instant::now(), tick));
        Ok(tick)
    }

    /// Public GET /fee-rate?token_id= → base taker fee in bps (cached 60s).
    /// Orders must carry this exact feeRateBps or the CLOB rejects them.
    pub async fn fee_rate_bps(&self, token_id: &str) -> Result<u64> {
        if let Some((at, v)) = self.fee_cache.lock().unwrap().get(token_id) {
            if at.elapsed().as_secs() < TICK_FEE_TTL_SECS {
                return Ok(*v);
            }
        }
        let url = format!("{CLOB_HOST}/fee-rate?token_id={token_id}");
        let resp = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .context("fee-rate request failed")?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!("fee-rate HTTP {status}: {text}");
        }
        let j: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let v = j["base_fee"]
            .as_f64()
            .or_else(|| j["base_fee"].as_str().and_then(|s| s.parse().ok()))
            .or_else(|| j["fee_rate_bps"].as_f64());
        let fee = v.filter(|f| *f >= 0.0 && *f <= 5000.0).unwrap_or(0.0) as u64;
        self.fee_cache
            .lock()
            .unwrap()
            .insert(token_id.to_string(), (Instant::now(), fee));
        Ok(fee)
    }

    /// Submit a signed marketable FOK BUY order. Resolves the market's tick
    /// grid and taker fee (must match exactly), signs EIP-712, POSTs /order.
    /// Returns (orderID, status, raw response).
    pub async fn post_buy_order(
        &self,
        token_id_dec: &str,
        price_dollars: f64,
        size_shares: f64,
        neg_risk: bool,
    ) -> Result<(String, String, String)> {
        let sk = self.sk.as_ref().ok_or_else(|| anyhow!("paper client"))?;
        // resolve market constants — a fee mismatch is a hard error in live mode
        let tick = self.tick_size(token_id_dec).await?;
        let fee = self.fee_rate_bps(token_id_dec).await?;
        let order: RawOrder = build_buy_order(token_id_dec, price_dollars, size_shares, self.address, tick, fee)
            .map_err(|e| anyhow!("order build: {e}"))?;
        let creds = self.creds.as_ref().ok_or_else(|| anyhow!("no L2 creds"))?;
        let body = order
            .signed_body(sk, neg_risk, &creds.api_key, "FOK")
            .map_err(|e| anyhow!("order sign: {e}"))?;

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

    /// Submit a signed marketable FOK SELL order (early exit / flatten).
    /// Same auth path as the BUY; price floors to the tick grid so it
    /// crosses the bid. Returns (orderID, status, raw response).
    pub async fn post_sell_order(
        &self,
        token_id_dec: &str,
        price_dollars: f64,
        size_shares: f64,
        neg_risk: bool,
    ) -> Result<(String, String, String)> {
        let sk = self.sk.as_ref().ok_or_else(|| anyhow!("paper client"))?;
        let tick = self.tick_size(token_id_dec).await?;
        let fee = self.fee_rate_bps(token_id_dec).await?;
        let order: RawOrder = build_sell_order(token_id_dec, price_dollars, size_shares, self.address, tick, fee)
            .map_err(|e| anyhow!("order build: {e}"))?;
        let creds = self.creds.as_ref().ok_or_else(|| anyhow!("no L2 creds"))?;
        let body = order
            .signed_body(sk, neg_risk, &creds.api_key, "FOK")
            .map_err(|e| anyhow!("order sign: {e}"))?;
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
