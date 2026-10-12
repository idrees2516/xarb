//! xarb-server — axum HTTP + WebSocket terminal for the XARB Rust core.
//!
//!   GET  /              embedded dashboard (web/dashboard.html)
//!   GET  /ws            live stream: init → 10Hz snapshots, signals, settles;
//!                       inbound control: start/stop/reset/settings
//!   GET  /api/snapshot  one-shot JSON snapshot (wait-free ArcSwap read)
//!   POST /api/control   {"type":"start"|"stop"|"reset"|"settings","settings":{…}}
//!
//! Local deployment:  MODE=paper cargo run --release   (default :3002)
//!
//! v0.3: boots the pinned hot-path topology — FV engine, strategy and
//! executor run on dedicated OS threads (see xarb-engine docs).

use anyhow::{bail, Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};
use xarb_engine::{Engine, EngineConfig, PinPlan};
use xarb_hft::SpinMode;
use xarb_poly::{ClobClient, Creds};

struct AppState {
    engine: Arc<Engine>,
    ctrl_tx: mpsc::UnboundedSender<serde_json::Value>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::var("XARB_MODE").unwrap_or_else(|_| "paper".into());
    let port: u16 = std::env::var("XARB_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3002);

    // ── topology (spin policy + core pinning) ────────────────────────────
    let cores = xarb_hft::affinity::core_count();
    let spin_mode = std::env::var("XARB_SPINMODE")
        .ok()
        .and_then(|s| SpinMode::from_str(&s))
        .unwrap_or_else(|| SpinMode::auto(cores));
    let pins = PinPlan::for_cores(cores);
    println!(
        "[boot] topology: {cores} cores · spin {spin_mode:?} · pins(fv={:?} strat={:?} exec={:?} feed={:?} pm={:?})",
        pins.fv, pins.strat, pins.exec, pins.feed, pins.pm
    );

    // ── CLOB client (paper vs live EIP-712 signing) ─────────────────────
    let (clob, cfg): (ClobClient, EngineConfig) = match mode.as_str() {
        "live" => {
            let confirm = std::env::var("XARB_LIVE_CONFIRM").unwrap_or_default();
            if confirm != "I_UNDERSTAND_THE_RISK" {
                bail!(
                    "live mode requires XARB_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK \
                     (real USDC at risk)"
                );
            }
            let key = std::env::var("POLY_PRIVATE_KEY")
                .context("live mode requires POLY_PRIVATE_KEY (wallet hex key)")?;
            let creds = match (
                std::env::var("POLY_API_KEY"),
                std::env::var("POLY_SECRET"),
                std::env::var("POLY_PASSPHRASE"),
            ) {
                (Ok(k), Ok(s), Ok(p)) => Some(Creds { api_key: k, secret: s, passphrase: p }),
                _ => None,
            };
            let mut c = ClobClient::live(&key, creds)?;
            println!("[boot] live mode — wallet {}", c.address_hex());
            c.ensure_creds().await?;
            let ok = c.verify_auth().await.unwrap_or(false);
            println!(
                "[boot] L2 auth verify: {}",
                if ok { "OK" } else { "FAILED (orders will error)" }
            );
            (c, EngineConfig { mode: "live", neg_risk: env_flag("XARB_NEG_RISK") })
        }
        _ => (ClobClient::paper(), EngineConfig { mode: "paper", neg_risk: false }),
    };

    // ── engine ─────────────────────────────────────────────────────────────
    let (out_tx, _): (broadcast::Sender<String>, broadcast::Receiver<String>) =
        broadcast::channel(2048);
    // Binance USDT-M futures client (live delta-hedge leg; None in paper)
    let fapi = xarb_feed::BinanceFapi::from_env(mode != "live").map(Arc::new);
    if let Some(f) = &fapi {
        println!(
            "[boot] Binance futures hedge leg: {}",
            if f.is_testnet() { "testnet" } else { "MAINNET" }
        );
        if let Ok(bal) = f.ping().await {
            println!("[boot] futures USDT balance: {bal:.2}");
        }
    }
    let engine = Engine::new(cfg, clob, fapi, out_tx, spin_mode, pins);
    apply_env_settings(&engine);
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
    engine.start(ctrl_rx);

    // ── axum ───────────────────────────────────────────────────────────────
    let state = Arc::new(AppState {
        engine: engine.clone(),
        ctrl_tx,
    });
    let app = Router::new()
        .route("/", get(root))
        .route("/ws", get(ws_handler))
        .route("/api/snapshot", get(api_snapshot))
        .route("/api/control", post(api_control))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("bind :{port}"))?;
    println!(
        "[boot] XARB rust core v0.4 (δ-hedge + σ auto-cal) — {} mode — http://127.0.0.1:{port}{}",
        engine.cfg.mode,
        if engine.cfg.neg_risk { " (neg-risk)" } else { "" }
    );
    axum::serve(listener, app).await?;
    Ok(())
}

fn env_flag(k: &str) -> bool {
    let v = std::env::var(k).unwrap_or_default();
    v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
}

fn env_num(k: &str) -> Option<f64> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}

fn apply_env_settings(engine: &Arc<Engine>) {
    let mut j = serde_json::json!({});
    if let Some(v) = env_num("XARB_STAKE_USD") {
        j["stakeUsd"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_JUMP_C") {
        j["jumpThreshC"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_FLOOR_C") {
        j["fvFloorC"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_EDGE_C") {
        j["edgeThreshC"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_MIN_SECS") {
        j["minSecsLeft"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_MAX_TRADES") {
        j["maxTradesPerWindow"] = serde_json::json!(v);
    }
    if let Ok(v) = std::env::var("XARB_MODEL") {
        j["model"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_TAKER_FEE_BPS") {
        j["takerFeeBps"] = serde_json::json!(v);
    }
    if let Ok(v) = std::env::var("XARB_AUTO_TRADE") {
        j["autoTrade"] = serde_json::json!(v != "0" && !v.eq_ignore_ascii_case("false"));
    }
    if let Ok(v) = std::env::var("XARB_TRADE_DOWN") {
        j["tradeDown"] = serde_json::json!(v != "0" && !v.eq_ignore_ascii_case("false"));
    }
    if let Some(v) = env_num("XARB_MAX_DAILY_LOSS") {
        j["maxDailyLossUsd"] = serde_json::json!(v);
    }
    // v0.4 knobs
    if let Ok(v) = std::env::var("XARB_SIGMA_AUTO") {
        j["sigmaAuto"] = serde_json::json!(v != "0" && !v.eq_ignore_ascii_case("false"));
    }
    if let Some(v) = env_num("XARB_SIGMA_W_IMP") {
        j["sigmaWImp"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_SIGMA_ABS_FLOOR") {
        j["sigmaAbsFloor"] = serde_json::json!(v);
    }
    if let Ok(v) = std::env::var("XARB_HEDGE_ON") {
        j["hedgeOn"] = serde_json::json!(v != "0" && !v.eq_ignore_ascii_case("false"));
    }
    if let Some(v) = env_num("XARB_HEDGE_RATIO") {
        j["hedgeRatio"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_HEDGE_FEE_BPS") {
        j["hedgeFeeBps"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_MIN_NET_EDGE_C") {
        j["minNetEdgeC"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_EXIT_BAND_C") {
        j["exitBandC"] = serde_json::json!(v);
    }
    if let Some(v) = env_num("XARB_MIN_CAPTURE_C") {
        j["minCaptureC"] = serde_json::json!(v);
    }
    if j.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        engine.apply_settings(&j);
        println!("[boot] env settings: {j}");
    }
}

async fn root() -> Html<&'static str> {
    Html(include_str!("../../../web/dashboard.html"))
}

/// Wait-free: the cold task prebuilds the 10Hz JSON, readers just load it.
async fn api_snapshot(State(st): State<Arc<AppState>>) -> Response {
    let body = st.engine.snap.load_full();
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        body.as_str().to_owned(),
    )
        .into_response()
}

async fn api_control(
    State(st): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let _ = st.ctrl_tx.send(body);
    Json(serde_json::json!({ "ok": true }))
}

async fn ws_handler(ws: WebSocketUpgrade, State(st): State<Arc<AppState>>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, st))
}

async fn handle_socket(mut socket: WebSocket, st: Arc<AppState>) {
    // initial state: prebuilt init JSON (1Hz refresh by the cold task)
    let init = st.engine.init_snap.load_full();
    if init.is_empty() {
        // cold task hasn't produced one yet — build synchronously
        let v = xarb_engine::snapshot::build_init(&st.engine);
        if socket.send(Message::Text(v.to_string())).await.is_err() {
            return;
        }
    } else if socket.send(Message::Text(init.as_str().to_owned())).await.is_err() {
        return;
    }
    let mut rx = st.engine.out_tx.subscribe();
    loop {
        tokio::select! {
            // inbound control
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(txt))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                            let _ = st.ctrl_tx.send(v);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return,
                }
            }
            // outbound stream (10Hz snaps + signals + settles)
            out = rx.recv() => {
                match out {
                    Ok(s) => {
                        if socket.send(Message::Text(s)).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        let _ = socket.send(Message::Text(
                            serde_json::json!({ "type": "lagged", "missed": n }).to_string(),
                        )).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}
