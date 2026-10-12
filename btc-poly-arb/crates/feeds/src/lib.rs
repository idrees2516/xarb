//! feeds — market data ingestion.
//!
//! Two tokio tasks, one per venue, normalize their venue formats into
//! fixed-size `wire::FeedEvent`s and push them into SPSC rings that the
//! engine thread drains. All JSON parsing, TLS, and reconnection live on
//! these tasks; the hot path never sees a string.
//!
//! * `binance`   — combined stream (trade + bookTicker) for BTCUSDT
//! * `polymarket` — CLOB market channel (book + price_change) for the
//!   active window's UP/DOWN outcome tokens, with REST book bootstrap
//! * `gamma`     — REST discovery of the current 5-minute market
//! * `health`    — lock-free status shared with the dashboard

pub mod binance;
pub mod gamma;
pub mod health;
pub mod polymarket;

pub use binance::run_binance;
pub use gamma::GammaClient;
pub use health::FeedHealth;
pub use polymarket::{run_polymarket, WindowTokens};

/// Default endpoints (overridable via config).
pub const BINANCE_WS_DEFAULT: &str = "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@bookTicker";
pub const PM_MARKET_WS_DEFAULT: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
pub const PM_USER_WS_DEFAULT: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
pub const CLOB_REST_DEFAULT: &str = "https://clob.polymarket.com";
pub const GAMMA_REST_DEFAULT: &str = "https://gamma-api.polymarket.com";

/// Seconds in one 5-minute window.
pub const WINDOW_S: i64 = 300;
/// Slug for the live series: `btc-updown-5m-<window-start-epoch>`.
pub fn window_slug(start_epoch: i64) -> String {
    format!("btc-updown-5m-{}", start_epoch)
}

/// Current and next aligned window start epochs (UTC).
pub fn current_window_epoch(unix_ms: i64) -> i64 {
    (unix_ms / 1000 / WINDOW_S) * WINDOW_S
}

pub fn next_window_epoch(unix_ms: i64) -> i64 {
    current_window_epoch(unix_ms) + WINDOW_S
}
