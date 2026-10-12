//! polyarb WASM dashboard entry (Leptos CSR, pure Rust frontend).

use leptos::prelude::*;
use ui::app::App;

fn main_js() {
    console_error_panic_hook::set_once();
    let body = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.body())
        .expect("document body");
    let _ = mount_to(body, move || {
        view! { <App /> }
    });
}

fn main() {
    main_js();
}

/// Simple panic hook for readable wasm errors.
pub mod console_error_panic_hook {
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
