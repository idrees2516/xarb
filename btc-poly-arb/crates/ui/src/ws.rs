//! WebSocket feed + control API calls.

use leptos::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{BinaryType, MessageEvent, WebSocket};

use wire::codec::{decode, Frame};
use wire::DashState;

/// Reactive dashboard state bundle.
#[derive(Clone)]
pub struct Dash {
    pub state: RwSignal<DashState>,
    pub connected: RwSignal<bool>,
    pub frames: RwSignal<u64>,
}

/// Connect to `<location>/ws` and keep `Dash` updated. Reconnects by page
/// reload expectation (F5); a bot restart re-establishes naturally.
pub fn connect() -> Dash {
    let state = RwSignal::new(DashState::default());
    let connected = RwSignal::new(false);
    let frames = RwSignal::new(0u64);
    let dash = Dash {
        state: state.clone(),
        connected: connected.clone(),
        frames: frames.clone(),
    };

    let (url, api) = urls();
    let ws = WebSocket::new(&url).expect("websocket connect");
    ws.set_binary_type(BinaryType::Arraybuffer);

    let on_open = {
        let connected = connected.clone();
        Closure::<dyn FnMut()>::new(move || {
            connected.set(true);
        })
    };
    ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    on_open.forget();

    let on_close = {
        let connected = connected.clone();
        Closure::<dyn FnMut()>::new(move || {
            connected.set(false);
        })
    };
    ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));
    on_close.forget();

    let on_msg = {
        let state = state.clone();
        let frames = frames.clone();
        Closure::<dyn FnMut(MessageEvent)>::new(move |ev: MessageEvent| {
            if let Ok(buf) = ev.data().dyn_into::<js_sys::ArrayBuffer>() {
                let bytes = js_sys::Uint8Array::new(&buf).to_vec();
                if let Some(Frame::Dash(d)) = decode(&bytes) {
                    state.set(*d);
                    frames.update(|n| *n += 1);
                }
            }
        })
    };
    ws.set_onmessage(Some(on_msg.as_ref().unchecked_ref()));
    on_msg.forget();

    // keep the socket referenced forever
    std::mem::forget(ws);
    let _ = api;
    dash
}

/// POST /api/kill {kill: !current}
pub async fn set_kill(current: bool) -> Result<(), String> {
    let (_, api) = urls();
    let win = web_sys::window().ok_or("no window")?;
    let opts = web_sys::RequestInit::new();
    opts.set_method("POST");
    opts.set_body(&JsValue::from_str(&format!("{{\"kill\":{}}}", !current)));
    let req = web_sys::Request::new_with_str_and_init(
        &format!("{}/api/kill", api),
        &opts,
    )
    .map_err(|e| format!("request build: {e:?}"))?;
    req.headers().set("Content-Type", "application/json").ok();
    let resp = JsFuture::from(win.fetch_with_request(&req))
        .await
        .map_err(|e| format!("fetch: {e:?}"))?;
    let resp: web_sys::Response = resp.dyn_into().map_err(|e| format!("{e:?}"))?;
    if !resp.ok() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

fn urls() -> (String, String) {
    let loc = web_sys::window().expect("window").location();
    let host = loc.host().unwrap_or_else(|_| "localhost:8080".into());
    let proto = if loc.protocol().unwrap_or_default() == "https:" {
        "wss"
    } else {
        "ws"
    };
    (
        format!("{}://{}/ws", proto, host),
        format!("{}://{}", proto, host),
    )
}
