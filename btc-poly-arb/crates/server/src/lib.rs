//! server — dashboard backend: static UI + WebSocket telemetry + control.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::broadcast;

use engine::EngineShared;
use futures_util::{SinkExt, StreamExt};
use wire::DashState;

#[derive(rust_embed::RustEmbed)]
#[folder = "../ui/dist"]
struct UiAssets;

pub struct ServerCtx {
    pub shared: Arc<EngineShared>,
    pub frames: broadcast::Receiver<Vec<u8>>,
}

pub fn router(ctx: Arc<ServerCtx>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/styles.css", get(asset_css))
        .route("/ui.js", get(asset_js))
        .route("/ui_bg.wasm", get(asset_wasm))
        .route("/ws", get(ws_handler))
        .route("/api/status", get(api_status))
        .route("/api/kill", post(api_kill))
        .route("/api/health", get(api_health))
        .with_state(ctx)
}

async fn asset_css() -> impl IntoResponse {
    serve_asset("styles.css", "text/css; charset=utf-8").await
}
async fn asset_js() -> impl IntoResponse {
    serve_asset("ui.js", "application/javascript; charset=utf-8").await
}
async fn asset_wasm() -> impl IntoResponse {
    serve_asset("ui_bg.wasm", "application/wasm").await
}

async fn serve_asset(name: &str, mime: &str) -> impl IntoResponse {
    match UiAssets::get(name) {
        Some(f) => (
            StatusCode::OK,
            [("Content-Type", mime.to_string()), ("Cache-Control", "no-cache".to_string())],
            f.data.into_owned(),
        ),
        None => (
            StatusCode::NOT_FOUND,
            [("Content-Type", String::from("text/plain")), ("X-Asset", String::from("missing"))],
            Vec::new(),
        ),
    }
}

/// Start serving in the background. Returns after binding.
pub async fn start(shared: Arc<EngineShared>, bind: &str, frames: broadcast::Sender<Vec<u8>>) -> anyhow::Result<()> {
    let ctx = Arc::new(ServerCtx {
        shared,
        frames: frames.subscribe(),
    });
    let app = router(ctx);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(target: "server", %bind, "dashboard listening");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(target: "server", "axum: {e}");
        }
    });
    Ok(())
}

async fn index() -> impl IntoResponse {
    match UiAssets::get("index.html") {
        Some(f) => (
            StatusCode::OK,
            [("Content-Type", "text/html; charset=utf-8")],
            f.data.into_owned(),
        ),
        None => (
            StatusCode::NOT_FOUND,
            [("Content-Type", "text/plain")],
            "ui/dist not built - run scripts/build-ui.sh".as_bytes().to_vec(),
        ),
    }
}

async fn api_health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn api_status(State(ctx): State<Arc<ServerCtx>>) -> Json<serde_json::Value> {
    let d: DashState = ctx.shared.dash_state();
    Json(dash_to_json(&d))
}

async fn api_kill(
    State(ctx): State<Arc<ServerCtx>>,
    body: Option<Json<serde_json::Value>>,
) -> Json<serde_json::Value> {
    let want = body
        .and_then(|Json(v)| v.get("kill").and_then(|k| k.as_bool()))
        .unwrap_or_else(|| !ctx.shared.kill());
    ctx.shared.set_kill(want);
    Json(serde_json::json!({ "kill": want }))
}

async fn ws_handler(
    State(ctx): State<Arc<ServerCtx>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_loop(socket, ctx.frames.resubscribe()))
}

async fn ws_loop(mut socket: WebSocket, mut frames: broadcast::Receiver<Vec<u8>>) {
    // reader half must be polled to catch close frames
    let (mut tx, mut rx) = socket.split();
    let mut ping = tokio::time::interval(std::time::Duration::from_secs(10));
    loop {
        tokio::select! {
            frame = frames.recv() => {
                match frame {
                    Ok(bytes) => {
                        if tx.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping.tick() => {
                if tx.send(Message::Ping(vec![])).await.is_err() {
                    break;
                }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

fn dash_to_json(d: &DashState) -> serde_json::Value {
    serde_json::json!({
        "t_ns": d.t_ns,
        "wall_ms": d.wall_ms,
        "mode": d.mode,
        "kill": d.kill,
        "window": {
            "phase": d.window_phase, "seq": d.window_seq,
            "start_ms": d.start_ms, "end_ms": d.end_ms,
            "tau_s": d.tau_s, "strike": d.strike,
        },
        "binance": {
            "mark": d.mark, "bid": d.bb_bid, "ask": d.bb_ask,
            "age_ms": d.feed_bin_age_ms, "msgs": d.feed_bin_msgs, "gaps": d.feed_bin_gaps,
        },
        "fv": { "up": d.fv, "jump_5s": d.jump, "sigma": d.sigma, "delta": d.delta },
        "pm": {
            "up_bid": d.up_bid, "up_ask": d.up_ask, "up_ask_sz": d.up_ask_sz,
            "dn_bid": d.dn_bid, "dn_ask": d.dn_ask, "dn_ask_sz": d.dn_ask_sz,
            "up_ask_implied": d.up_ask_impl, "age_ms": d.feed_pm_age_ms,
        },
        "edge": { "up": d.edge_up, "down": d.edge_dn, "spread_mid": d.spread_up },
        "pnl": {
            "realized_c": d.realized_c, "unrealized_c": d.unrealized_c,
            "equity_c": d.equity_c, "pos_up_sh": d.pos_up_sh, "pos_dn_sh": d.pos_dn_sh,
            "avg_up": d.avg_up, "avg_dn": d.avg_dn,
            "trades_today": d.trades_today, "windows_done": d.windows_done,
        },
        "latency": d.lat.iter().map(|l| serde_json::json!({
            "p50_ns": l.p50_ns, "p99_ns": l.p99_ns, "max_ns": l.max_ns, "n": l.n,
        })).collect::<Vec<_>>(),
        "rejects": d.rejects,
    })
}
