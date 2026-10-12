//! ui library root (panels shared with main.rs)
pub mod app;
pub mod charts;
pub mod panels;
pub mod ws;

/// WASM entry point: runs automatically on `init()` (wasm-bindgen --target web).
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(move || {
        use leptos::prelude::*;
        view! { <app::App /> }
    });
}

mod console_error_panic_hook {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console)]
        fn error(s: &str);
    }
    pub fn set_once() {
        std::panic::set_hook(Box::new(|info| {
            error(&format!("panic: {info}"));
        }));
    }
}

pub fn fmt_u64(v: u64) -> String {
    if v > 1_000_000 {
        format!("{:.1}M", v as f64 / 1e6)
    } else if v > 1_000 {
        format!("{:.1}k", v as f64 / 1e3)
    } else {
        v.to_string()
    }
}

pub fn fmt_time(ms: i64) -> String {
    let s = (ms / 1000) % 86_400;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    format!("{:02}:{:02}:{:02}", h, m, sec)
}

pub fn fmt_c(c: f64) -> String {
    if c.is_nan() { "—".into() } else { format!("{:+.1}c", c) }
}

pub fn fmt_cents(c: f64) -> String {
    if c.is_nan() { "—".into() } else { format!("{:.0}c", c) }
}

pub fn fmt_d(v: f64) -> String {
    if v.is_nan() { "—".into() } else { format!("{:.3}", v) }
}

pub fn fmt_sz(v: f64) -> String {
    if v >= 1000.0 { format!("{:.1}k", v / 1000.0) } else { format!("{:.0}", v) }
}

pub fn fmt_px(v: f64) -> String {
    if v == 0.0 { "—".into() } else { format!("{:.2}", v) }
}

pub fn fmt_pts(v: f64) -> String {
    if v == 0.0 { "—".into() } else { format!("{:+.1}", v) }
}

pub fn fmt_time_short(t_ns: i64) -> String {
    let ms = t_ns / 1_000_000;
    let s = (ms / 1000) % 86_400;
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}
