//! Top-level layout.

use leptos::prelude::*;
use leptos::task::spawn_local;

use crate::panels::*;
use crate::ws::{self, Dash};
use crate::{fmt_c, fmt_cents, fmt_d, fmt_u64, fmt_time};

#[component]
pub fn App() -> impl IntoView {
    let dash = ws::connect();
    let kill_busy = RwSignal::new(false);

    let mode_label = move || {
        let m = dash.state.get().mode;
        match m {
            wire::MODE_LIVE => ("LIVE", "live"),
            wire::MODE_SIM => ("SIM", "sim"),
            _ => ("PAPER", "paper"),
        }
    };

    let on_kill = move |_| {
        kill_busy.set(true);
        let current = dash.state.get().kill;
        spawn_local(async move {
            let _ = ws::set_kill(current).await;
            kill_busy.set(false);
        });
    };

    view! {
        <div class="grid">
            <div class="topbar">
                <span class="brand">poly<em>arb</em></span>
                <span class=move || format!("badge {}", mode_label().1)>
                    {move || mode_label().0}
                </span>
                <Show when=move || dash.state.get().kill fallback=|| ()>
                    <span class="badge kill">KILLED</span>
                </Show>
                <span class="stat">
                    <span class="k">Feed Binance</span>
                    <span class="v">
                        {move || {
                            let d = dash.state.get();
                            if d.feed_bin_age_ms > 9_000_000_000 {
                                "—".to_string()
                            } else {
                                format!("{}ms", d.feed_bin_age_ms)
                            }
                        }}
                    </span>
                </span>
                <span class="stat">
                    <span class="k">Feed PM</span>
                    <span class="v">
                        {move || {
                            let d = dash.state.get();
                            if d.feed_pm_age_ms > 9_000_000_000 { "—".to_string() } else { format!("{}ms", d.feed_pm_age_ms) }
                        }}
                    </span>
                </span>
                <span class="stat">
                    <span class="k">Binance msgs</span>
                    <span class="v">{move || fmt_u64(dash.state.get().feed_bin_msgs)}</span>
                </span>
                <span class="stat">
                    <span class="k">Clock</span>
                    <span class="v">{move || fmt_time(dash.state.get().wall_ms)}</span>
                </span>
                <span class="spacer"></span>
                <button class=move || if dash.state.get().kill { "armed" } else { "" } on:click=on_kill>
                    {move || if dash.state.get().kill { "RESUME" } else { "KILL SWITCH" }}
                </button>
                <span class="stat">
                    <span class="k">WS</span>
                    <span class=move || if dash.connected.get() { "v good".to_string() } else { "v bad".to_string() }>
                        {move || if dash.connected.get() { "live" } else { "down" }}
                    </span>
                </span>
            </div>

            <div class="panel pnl-core">
                <h2>"Fair Value vs Polymarket"</h2>
                <EdgePanel dash=dash.clone() />
            </div>

            <div class="panel pnl-edge">
                <h2>"Momentum (5s FV jump)"</h2>
                <JumpPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-window">
                <h2>"Window"</h2>
                <WindowPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-chart">
                <h2>"BTC mark · FV(UP) · PM UP ask"</h2>
                <ChartPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-books">
                <h2>"Polymarket books"</h2>
                <BooksPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-blotter">
                <h2>"Signals & orders"</h2>
                <BlotterPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-lat">
                <h2>"Engine latency (in-process)"</h2>
                <LatencyPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-strat">
                <h2>"Config in force"</h2>
                <ConfigPanel dash=dash.clone() />
            </div>

            <div class="panel pnl-wins">
                <h2>"PnL / per-window"</h2>
                <PnlPanel dash=dash.clone() />
            </div>
        </div>
    }
}
