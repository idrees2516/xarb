//! Runtime configuration.

use std::path::Path;

use pricing::Model;
use strategy::StrategyCfg;

/// Everything the engine + executor need at runtime. `Copy` so it can be
/// published to the hot thread through a SeqLock.
#[derive(Clone, Debug)]
pub struct AppConfig {
    // ---- strategy (tweet defaults) ----
    pub strategy: StrategyCfg,

    // ---- pricing model ----
    pub sigma_fallback: f64,
    pub vol_half_life_s: f64,
    pub sigma_floor: f64,
    pub sigma_cap: f64,
    pub use_empirical_model: bool,
    /// 0 = fixed fallback sigma (tweet semantics: fixed cents-per-point),
    /// 1 = live EWMA sigma, 2 = 50/50 blend
    pub sigma_mode: u8,

    // ---- execution ----
    pub mode: u8, // wire::MODE_*
    pub size_sh: f64,
    pub order_type: String, // "FAK"
    pub max_chase_c: i64,
    pub use_ladder: bool,
    pub ladder_refresh_s: f64,
    pub paper_latency_ms: u64,
    pub paper_slippage_c: i64,

    // ---- risk ----
    pub max_pos_sh: f64,
    pub max_trades_per_window: u32,
    pub cooldown_s: f64,
    pub daily_loss_stop_c: f64,
    pub max_notional_per_trade_c: i64,
    pub stale_binance_ms: i64,
    pub stale_pm_ms: i64,
    pub min_balance_c: i64,

    // ---- engine ----
    pub pin_core: Option<usize>,
    pub spin: bool,
    pub dash_fps: u32,
    pub mark_source: u8, // 0 mid, 1 last, 2 micro

    // ---- endpoints ----
    pub binance_ws: String,
    pub pm_ws: String,
    pub clob_rest: String,
    pub gamma_rest: String,

    // ---- dashboard ----
    pub bind: String,

    // ---- logging ----
    pub jsonl_path: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            strategy: StrategyCfg::default(),
            sigma_fallback: 1.3e-4,
            vol_half_life_s: 120.0,
            sigma_floor: 5e-5,
            sigma_cap: 1e-3,
            use_empirical_model: false,
            sigma_mode: 0,
            mode: wire::MODE_PAPER,
            size_sh: 50.0,
            order_type: "FAK".into(),
            max_chase_c: 3,
            use_ladder: false,
            ladder_refresh_s: 20.0,
            paper_latency_ms: 250,
            paper_slippage_c: 0,
            max_pos_sh: 200.0,
            max_trades_per_window: 2,
            cooldown_s: 8.0,
            daily_loss_stop_c: 10_000.0,
            max_notional_per_trade_c: 20_000,
            stale_binance_ms: 400,
            stale_pm_ms: 2_000,
            min_balance_c: 0,
            pin_core: None,
            spin: true,
            dash_fps: 10,
            mark_source: 2,
            binance_ws: feeds::BINANCE_WS_DEFAULT.into(),
            pm_ws: feeds::PM_MARKET_WS_DEFAULT.into(),
            clob_rest: feeds::CLOB_REST_DEFAULT.into(),
            gamma_rest: feeds::GAMMA_REST_DEFAULT.into(),
            bind: "0.0.0.0:8080".into(),
            jsonl_path: "logs/events.jsonl".into(),
        }
    }
}

impl AppConfig {
    pub fn model(&self) -> Model {
        if self.use_empirical_model {
            Model::Empirical(pricing::EmpiricalLinear::default())
        } else {
            Model::BsDigital {
                sigma_fallback: self.sigma_fallback,
            }
        }
    }

    pub fn load_toml(path: &Path) -> anyhow::Result<AppConfig> {
        let text = std::fs::read_to_string(path)?;
        let v: toml::Value = toml::from_str(&text)?;
        let mut cfg = AppConfig::default();
        let g = |k: &str| v.get(k).cloned();
        if let Some(s) = g("strategy") {
            if let Some(x) = s.get("jump_c").and_then(|x| x.as_float()) {
                cfg.strategy.jump_c = x;
            }
            if let Some(x) = s.get("fv_gate").and_then(|x| x.as_float()) {
                cfg.strategy.fv_gate = x;
            }
            if let Some(x) = s.get("edge_c").and_then(|x| x.as_float()) {
                cfg.strategy.edge_c = x;
            }
            if let Some(x) = s.get("jump_window_s").and_then(|x| x.as_float()) {
                cfg.strategy.jump_window_s = x;
            }
            if let Some(x) = s.get("trade_down").and_then(|x| x.as_bool()) {
                cfg.strategy.trade_down = x;
            }
            if let Some(x) = s.get("min_tau_s").and_then(|x| x.as_float()) {
                cfg.strategy.min_tau_s = x;
            }
        }
        if let Some(s) = g("pricing") {
            if let Some(x) = s.get("sigma_fallback").and_then(|x| x.as_float()) {
                cfg.sigma_fallback = x;
            }
            if let Some(x) = s.get("vol_half_life_s").and_then(|x| x.as_float()) {
                cfg.vol_half_life_s = x;
            }
            if let Some(x) = s.get("model").and_then(|x| x.as_str()) {
                cfg.use_empirical_model = x == "linear" || x == "empirical";
            }
            if let Some(x) = s.get("sigma_mode").and_then(|x| x.as_str()) {
                cfg.sigma_mode = match x {
                    "live" => 1,
                    "blend" => 2,
                    _ => 0,
                };
            }
        }
        if let Some(s) = g("exec") {
            if let Some(x) = s.get("size_shares").and_then(|x| x.as_float()) {
                cfg.size_sh = x;
            }
            if let Some(x) = s.get("order_type").and_then(|x| x.as_str()) {
                cfg.order_type = x.into();
            }
            if let Some(x) = s.get("use_ladder").and_then(|x| x.as_bool()) {
                cfg.use_ladder = x;
            }
            if let Some(x) = s.get("paper_latency_ms").and_then(|x| x.as_integer()) {
                cfg.paper_latency_ms = x as u64;
            }
            if let Some(x) = s.get("paper_slippage_c").and_then(|x| x.as_integer()) {
                cfg.paper_slippage_c = x as i64;
            }
        }
        if let Some(s) = g("risk") {
            if let Some(x) = s.get("max_pos_shares").and_then(|x| x.as_float()) {
                cfg.max_pos_sh = x;
            }
            if let Some(x) = s.get("cooldown_s").and_then(|x| x.as_float()) {
                cfg.cooldown_s = x;
            }
            if let Some(x) = s.get("daily_loss_stop_usd").and_then(|x| x.as_float()) {
                cfg.daily_loss_stop_c = x * 100.0;
            }
        }
        if let Some(s) = g("engine") {
            if let Some(x) = s.get("spin").and_then(|x| x.as_bool()) {
                cfg.spin = x;
            }
            if let Some(x) = s.get("dash_fps").and_then(|x| x.as_integer()) {
                cfg.dash_fps = x as u32;
            }
            if let Some(x) = s.get("mark_source").and_then(|x| x.as_str()) {
                cfg.mark_source = match x {
                    "mid" => 0,
                    "last" => 1,
                    _ => 2,
                };
            }
        }
        if let Some(s) = g("endpoints") {
            if let Some(x) = s.get("binance_ws").and_then(|x| x.as_str()) {
                cfg.binance_ws = x.into();
            }
            if let Some(x) = s.get("polymarket_ws").and_then(|x| x.as_str()) {
                cfg.pm_ws = x.into();
            }
            if let Some(x) = s.get("clob_rest").and_then(|x| x.as_str()) {
                cfg.clob_rest = x.into();
            }
            if let Some(x) = s.get("gamma_rest").and_then(|x| x.as_str()) {
                cfg.gamma_rest = x.into();
            }
        }
        if let Some(s) = g("dashboard") {
            if let Some(x) = s.get("bind").and_then(|x| x.as_str()) {
                cfg.bind = x.into();
            }
        }
        Ok(cfg)
    }
}
