//! Gamma API market discovery for the 5-minute BTC Up-or-Down series.
//!
//! Slug is fully deterministic: `btc-updown-5m-<window-start-epoch>` with
//! windows aligned to 5-minute UTC boundaries (verified against the live
//! API, see README). `GET /events?slug=<slug>` returns the event with one
//! market whose `clobTokenIds` is a JSON-encoded string array
//! `[up, down]`.

use anyhow::{bail, Context};
use wire::{U256, WindowCtx};

#[derive(Clone)]
pub struct GammaClient {
    pub base: String,
    http: reqwest::Client,
}

#[derive(Clone, Debug)]
pub struct DiscoveredWindow {
    pub slug: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub ctx: WindowCtx,
    pub accepting_orders: bool,
}

impl Default for GammaClient {
    fn default() -> Self {
        Self::new(crate::GAMMA_REST_DEFAULT.to_string())
    }
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

impl GammaClient {
    pub fn new(base: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .gzip(true)
            .build()
            .expect("reqwest client");
        GammaClient { base, http }
    }

    /// Fetch the market for `start_epoch` (must be 5-minute aligned).
    pub async fn fetch_window(&self, start_epoch: i64, seq: u32) -> anyhow::Result<DiscoveredWindow> {
        let slug = crate::window_slug(start_epoch);
        let url = format!("{}/events?slug={}", self.base.trim_end_matches('/'), slug);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("gamma request {slug}"))?;
        let status = resp.status();
        let txt = resp.text().await?;
        if !status.is_success() {
            bail!("gamma {slug} -> HTTP {status}");
        }
        let v: serde_json::Value = serde_json::from_str(&txt).with_context(|| "gamma json")?;
        let arr = v
            .as_array()
            .with_context(|| "expected array of events")?;
        if arr.is_empty() {
            bail!("no event for slug {slug}");
        }
        let ev = &arr[0];
        let markets = ev
            .get("markets")
            .and_then(|m| m.as_array())
            .with_context(|| "event without markets")?;
        if markets.is_empty() {
            bail!("event with empty markets");
        }
        let mk = &markets[0];

        // clobTokenIds is a JSON string containing ["<up>", "<down>"]
        let tokens_raw = mk
            .get("clobTokenIds")
            .and_then(|t| t.as_str())
            .with_context(|| "missing clobTokenIds")?;
        let tokens: Vec<String> = serde_json::from_str(tokens_raw)
            .with_context(|| "clobTokenIds not a JSON array")?;
        if tokens.len() != 2 {
            bail!("expected 2 token ids, got {}", tokens.len());
        }
        let token_up = U256::from_dec(&tokens[0]).context("up token id parse")?;
        let token_down = U256::from_dec(&tokens[1]).context("down token id parse")?;

        // outcomes must be ["Up","Down"] in that order
        let outcomes_raw = mk.get("outcomes").and_then(|o| o.as_str()).unwrap_or("");
        let outcomes: Vec<String> = serde_json::from_str(outcomes_raw).unwrap_or_default();
        let (token_up, token_down) = if outcomes.first().map(|s| s.as_str()) == Some("Down") {
            (token_down, token_up)
        } else {
            (token_up, token_down)
        };

        let condition = mk
            .get("conditionId")
            .and_then(|c| c.as_str())
            .and_then(hex32)
            .unwrap_or([0u8; 32]);

        let end_ms = mk
            .get("endDate")
            .and_then(|e| e.as_str())
            .and_then(parse_iso_ms)
            .or_else(|| ev.get("endDate").and_then(|e| e.as_str()).and_then(parse_iso_ms))
            .unwrap_or(start_epoch * 1000 + 300_000);

        let tick = mk
            .get("orderPriceMinTickSize")
            .and_then(|t| t.as_f64())
            .unwrap_or(0.01);
        let tick_c = (tick * 100.0).round().max(1.0) as i64;

        let min_size = mk
            .get("orderMinSize")
            .and_then(|m| m.as_f64())
            .unwrap_or(5.0);

        let neg_risk = mk.get("negRisk").and_then(|n| n.as_bool()).unwrap_or(false);

        let accepting_orders = mk
            .get("acceptingOrders")
            .and_then(|a| a.as_bool())
            .unwrap_or(true);

        let title = ev
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        let ctx = WindowCtx {
            seq,
            start_ms: start_epoch * 1000,
            end_ms,
            condition,
            token_up,
            token_down,
            tick_c,
            min_size,
            neg_risk,
            strike: 0.0,
        };

        Ok(DiscoveredWindow {
            slug,
            title,
            start_ms: start_epoch * 1000,
            end_ms,
            ctx,
            accepting_orders,
        })
    }
}

/// Parse "2026-10-08T18:05:00Z" (and fractional variants) to unix ms.
fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    // fast path: YYYY-MM-DDTHH:MM:SS(.fff)?Z
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    let mut millis = 0i64;
    if let Some(rest) = s.get(19..) {
        let rest = rest.trim_start_matches('.');
        let frac: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !frac.is_empty() {
            let scaled: f64 = format!("0.{}", frac).parse().unwrap_or(0.0);
            millis = (scaled * 1000.0).round() as i64;
        }
    }
    // days since epoch (civil algorithm)
    let days = days_from_civil(year, month, day);
    Some(((days * 86400) + hour * 3600 + minute * 60 + second) * 1000 + millis)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_ms() {
        assert_eq!(parse_iso_ms("2026-10-08T18:05:00Z"), Some(1791482700000));
        assert_eq!(
            parse_iso_ms("2025-10-06T18:04:08.744011Z"),
            Some(1759773848744)
        );
        assert_eq!(parse_iso_ms("not a date"), None);
    }

    #[test]
    fn slug_format() {
        assert_eq!(crate::window_slug(1791482400), "btc-updown-5m-1791482400");
        assert_eq!(crate::current_window_epoch(1_791_482_642_000), 1_791_482_400);
        assert_eq!(crate::next_window_epoch(1_791_482_642_000), 1_791_482_700);
    }

    #[test]
    fn hex32_roundtrip() {
        let h = "0xb9ee488dc81356d7ce2c0bb7273bc2ab495094cfd5e7be5a3afd64f78a7c9735";
        let b = hex32(h).unwrap();
        assert_eq!(b[0], 0xb9);
        assert_eq!(b[31], 0x35);
        assert!(hex32("0x1234").is_none());
    }
}
