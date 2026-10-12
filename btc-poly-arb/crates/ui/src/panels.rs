//! Dashboard panels.

use leptos::prelude::*;

use crate::charts::spark_path;
use crate::{fmt_c, fmt_cents, fmt_d, fmt_sz, fmt_px, fmt_pts, fmt_time_short, fmt_u64};
use crate::ws::Dash;

#[component]
pub fn EdgePanel(dash: Dash) -> impl IntoView {
    let edge = move || dash.state.get().edge_up;
    let needle = move || {
        // map edge [-0.5, +0.5] -> [0%, 100%], trigger at +10c
        let e = edge();
        if e.is_nan() {
            50.0
        } else {
            ((e + 0.25) / 0.5 * 100.0).clamp(0.0, 100.0)
        }
    };
    let trigger_pos = 70.0; // +10c of a [-25c, +25c] scale
    view! {
        <div class="row"><span class="k">"FV(UP)"</span><span class="v mid">{move || fmt_d(dash.state.get().fv)}</span></div>
        <div class="row"><span class="k">"PM UP ask / size"</span>
            <span class="v">{move || format!("{} / {}", fmt_cents(dash.state.get().up_ask), fmt_sz(dash.state.get().up_ask_sz))}</span>
        </div>
        <div class="row"><span class="k">"Edge (fv − ask)"</span>
            <span class=move || {
                let e = dash.state.get().edge_up;
                if e.is_nan() { "v".to_string() } else if e >= 0.10 { "v good".to_string() } else if e > 0.0 { "v warn?".to_string() } else { "v bad".to_string() }
            }>
                {move || fmt_c(dash.state.get().edge_up)}
            </span>
        </div>
        <div class="row"><span class="k">"Implied ask (1−dn bid)"</span>
            <span class="v">{move || fmt_d(dash.state.get().up_ask_impl)}</span>
        </div>
        <div class="gauge">
            <div class="track">
                <div class="zero"></div>
                <div class="trigger" style=move || format!("left: {:.1}%", trigger_pos)></div>
                <div class="needle" style=move || format!("left: calc({:.1}% - 1px)", needle())></div>
            </div>
            <div class="scale"><span>"−25c"</span><span>"0"</span><span>"+10c 🔥"</span><span>"+25c"</span></div>
        </div>
        <div class="footnote">"needle: live edge · amber line: 10c trigger"</div>
    }
}

#[component]
pub fn JumpPanel(dash: Dash) -> impl IntoView {
    // jump in cents over the 5s window; scale ±40c
    let pos = move || {
        let j = dash.state.get().jump * 100.0;
        (j / 40.0 * 50.0).clamp(-50.0, 50.0)
    };
    view! {
        <div class="row"><span class="k">"FV now"</span><span class="v">{move || fmt_d(dash.state.get().fv)}</span></div>
        <div class="row"><span class="k">"FV 5s ago"</span><span class="v">{move || fmt_d(dash.state.get().fv_5s_ago)}</span></div>
        <div class="row"><span class="k">"Jump"</span>
            <span class=move || {
                let j = dash.state.get().jump;
                if j >= 0.20 { "v good".to_string() } else { "v".to_string() }
            }>{move || fmt_c(dash.state.get().jump)}</span>
        </div>
        <div class="jumpbar">
            <div class="midline"></div>
            <div class="zone" style="left: 75%; width: 25%"></div>
            <div
                style=move || {
                    let cls = if pos() >= 0.0 { "fill up" } else { "fill dn" };
                    format!("left: calc({:.1}% - 1px);", 50.0 + pos())
                }
                class="fill"
            ></div>
        </div>
        <div class="row"><span class="k">"sigma / delta"</span>
            <span class="v">{move || format!("{:.1e} / {:.4}", dash.state.get().sigma, dash.state.get().delta)}</span>
        </div>
        <div class="footnote">"green zone: ≥ +20c within the 5s window"</div>
    }
}

#[component]
pub fn WindowPanel(dash: Dash) -> impl IntoView {
    view! {
        <div class="row"><span class="k">"phase"</span>
            <span class="v">{move || {
                match dash.state.get().window_phase {
                    1 => "pre-open".to_string(),
                    2 => "trading".to_string(),
                    3 => "settling".to_string(),
                    _ => "none".to_string(),
                }
            }}</span>
        </div>
        <div class="row"><span class="k">"τ remaining"</span>
            <span class=move || {
                let t = dash.state.get().tau_s;
                if dash.state.get().window_phase == 0 { "v".to_string() } else if t < 30.0 { "v warn?".to_string() } else { "v".to_string() }
            }>{move || format!("{:.0}s", dash.state.get().tau_s)}</span>
        </div>
        <div class="row"><span class="k">"strike (open)"</span><span class="v">{move || fmt_px(dash.state.get().strike)}</span></div>
        <div class="row"><span class="k">"BTC mark"</span><span class="v">{move || fmt_px(dash.state.get().mark)}</span></div>
        <div class="row"><span class="k">"mark − strike"</span>
            <span class=move || {
                let d = dash.state.get().mark - dash.state.get().strike;
                if d >= 0.0 { "v good".to_string() } else { "v bad".to_string() }
            }>{move || fmt_pts(dash.state.get().mark - dash.state.get().strike)}</span>
        </div>
        <div class="row"><span class="k">"evals"</span><span class="v">{move || crate::fmt_u64(dash.state.get().evals)}</span></div>
    }
}

#[component]
pub fn BooksPanel(dash: Dash) -> impl IntoView {
    view! {
        <table>
            <thead><tr><th>"side"</th><th>"bid"</th><th>"sz"</th><th>"ask"</th><th>"sz"</th></tr></thead>
            <tbody>
                <tr>
                    <td>"UP"</td>
                    <td class="buy">{move || fmt_cents(dash.state.get().up_bid)}</td>
                    <td class="buy">{move || fmt_sz(dash.state.get().up_bid_sz)}</td>
                    <td class="sell">{move || fmt_cents(dash.state.get().up_ask)}</td>
                    <td class="sell">{move || fmt_sz(dash.state.get().up_ask_sz)}</td>
                </tr>
                <tr>
                    <td>"DOWN"</td>
                    <td class="buy">{move || fmt_cents(dash.state.get().dn_bid)}</td>
                    <td class="buy">{move || fmt_sz(dash.state.get().dn_bid_sz)}</td>
                    <td class="sell">{move || fmt_cents(dash.state.get().dn_ask)}</td>
                    <td class="sell">{move || fmt_sz(dash.state.get().dn_ask_sz)}</td>
                </tr>
            </tbody>
        </table>
        <div class="footnote">
            {move || format!("spread_mid: {} · edge_dn: {}",
                fmt_c(dash.state.get().spread_up), fmt_c(dash.state.get().edge_dn))}
        </div>
        <div class="footnote">
            {move || format!("bids/asks imply: UP mid {} · 1−dn_ask {}", fmt_d(dash.state.get().up_bid + 0.0), fmt_d(1.0 - dash.state.get().dn_ask))}
        </div>
    }
}

#[component]
pub fn ChartPanel(dash: Dash) -> impl IntoView {
    let (mark_path, fv_path, ask_path) = (
        move || dash.state.get().chart_mark,
        move || dash.state.get().chart_fv,
        move || dash.state.get().chart_ask,
    );
    view! {
        <div class="chart">
            <svg viewBox="0 0 800 180" preserveAspectRatio="none">
                // grid
                <line x1="0" y1="45" x2="800" y2="45" stroke="#131a24" stroke-width="1"/>
                <line x1="0" y1="90" x2="800" y2="90" stroke="#131a24" stroke-width="1"/>
                <line x1="0" y1="135" x2="800" y2="135" stroke="#131a24" stroke-width="1"/>
                // FV + ask share price (left-ish scale)
                <path d=move || spark_path(&fv_path(), 800.0, 180.0, 0.0, 1.0) fill="none" stroke="#59c2ff" stroke-width="1.5"/>
                <path d=move || spark_path(&ask_path(), 800.0, 180.0, 0.0, 1.0) fill="none" stroke="#ff5470" stroke-width="1.2" stroke-dasharray="4 2"/>
                <line x1="0" y1=move || (180.0 - dash.state.get().fv * 180.0).to_string() x2="800" y2=move || (180.0 - dash.state.get().fv * 180.0).to_string() stroke="#59c2ff" stroke-width="0.4" stroke-opacity="0.35"/>
            </svg>
        </div>
        <div class="row">
            <span class="k">"cyan = FV(UP) · red dashed = PM UP ask (0..1 scale)"</span>
            <span class="v">{move || fmt_px(dash.state.get().mark)}</span>
        </div>
        <div class="footnote">"BTC mark drives FV; the red line hugging below the cyan line during a jump is the trade."</div>
    }
}

#[component]
pub fn BlotterPanel(dash: Dash) -> impl IntoView {
    view! {
        <div class="blotter">
            <table>
                <thead>
                    <tr><th>"time"</th><th>"seq"</th><th>"dir"</th><th>"fv"</th><th>"ask"</th><th>"edge"</th><th>"jump"</th><th>"limit"</th><th>"sh"</th><th>"status"</th><th>"fill"</th><th>"px"</th></tr>
                </thead>
                <tbody>
                    {move || {
                        let d = dash.state.get();
                        let sigs: Vec<(u64, String, String, String, String, String)> = d.sigs.iter().take(d.sig_head as usize).rev().map(|s| {
                            (
                                s.seq,
                                fmt_time_short(s.t_ns),
                                if s.dir == 0 { "UP".to_string() } else { "DOWN".to_string() },
                                fmt_d(s.fv),
                                fmt_cents(s.ask),
                                fmt_c(s.edge),
                            )
                        }).collect();
                        let ords: Vec<(u64, i64, f64, u8, f64, f64)> = d.ords.iter().take(d.ord_head as usize).map(|o| {
                            (o.seq, o.limit_c, o.sh, o.status, o.fill_sh, o.avg_px_c)
                        }).collect();
                        sigs.into_iter().map(move |(seq, t, dir, fv, ask, edge)| {
                            let dir_is_up = dir == "UP";
                            // find matching order
                            let ord = ords.iter().find(|o| o.0 == seq);
                            let (limit, sh, status, fill, px) = match ord {
                                Some(o) => (o.1.to_string(), format!("{:.0}", o.2), status_word(o.3), format!("{:.0}", o.4), fmt_cents(o.5)),
                                None => ("—".into(), "—".into(), "sent".into(), "—".into(), "—".into()),
                            };
                            view! {
                                <tr>
                                    <td>{t}</td>
                                    <td>{seq}</td>
                                    <td class=if dir_is_up { "buy" } else { "sell" }>{dir.clone()}</td>
                                    <td>{fv}</td>
                                    <td>{ask}</td>
                                    <td>{edge}</td>
                                    <td>{limit}</td>
                                    <td>{sh}</td>
                                    <td>{status}</td>
                                    <td>{fill}</td>
                                    <td>{px}</td>
                                </tr>
                            }
                        }).collect_view()
                    }}
                </tbody>
            </table>
        </div>
    }
}

fn status_word(s: u8) -> String {
    match s {
        0 => "sent".into(),
        1 => "acked".into(),
        2 => "filled".into(),
        3 => "missed".into(),
        4 => "rejected".into(),
        5 => "timeout".into(),
        _ => "?".into(),
    }
}

#[component]
pub fn LatencyPanel(dash: Dash) -> impl IntoView {
    let max_ns = move || {
        let d = dash.state.get();
        d.lat.iter().map(|l| l.p99_ns.max(1)).max().unwrap_or(1) as f64
    };
    view! {
        {move || {
            let d = dash.state.get();
            let max = max_ns();
            d.lat.iter().enumerate().map(|(i, l)| {
                let name = wire::LAT_STAGE_NAMES[i];
                let w = (l.p99_ns as f64 / max * 100.0).clamp(1.0, 100.0);
                let w50 = (l.p50_ns as f64 / max * 100.0).clamp(0.5, 100.0);
                let label = if l.p99_ns >= 1_000_000 {
                    format!("{:.1}ms", l.p99_ns as f64 / 1e6)
                } else if l.p99_ns >= 1_000 {
                    format!("{:.0}µs", l.p99_ns as f64 / 1e3)
                } else {
                    format!("{}ns", l.p99_ns)
                };
                view! {
                    <div class="latrow">
                        <span class="name">{name}</span>
                        <span class="bar">
                            <span class="fill" style= format!("width: {:.1}%", w)></span>
                            <span class="fill" style=format!("width: {:.1}%; opacity: 0.5", w50)></span>
                        </span>
                        <span class="val">{label}</span>
                    </div>
                }
            }).collect_view()
        }}
        <div class="footnote">"bars: p99 (solid) / p50 (faded) per in-process stage — excludes network"</div>
    }
}

#[component]
pub fn ConfigPanel(dash: Dash) -> impl IntoView {
    view! {
        <div class="row"><span class="k">"jump ≥"</span><span class="v">{move || fmt_cents(dash.state.get().cfg_jump * 100.0)}</span></div>
        <div class="row"><span class="k">"fv gate"</span><span class="v">{move || fmt_cents(dash.state.get().cfg_gate * 100.0)}</span></div>
        <div class="row"><span class="k">"edge ≥"</span><span class="v">{move || fmt_cents(dash.state.get().cfg_edge * 100.0)}</span></div>
        <div class="row"><span class="k">"size"</span><span class="v">{move || format!("{:.0} sh", dash.state.get().cfg_size_sh)}</span></div>
        <div class="row"><span class="k">"max pos"</span><span class="v">{move || format!("{:.0} sh", dash.state.get().cfg_max_pos)}</span></div>
        <div class="row"><span class="k">"cooldown"</span><span class="v">{move || format!("{:.0}s", dash.state.get().cfg_cooldown)}</span></div>
        <div class="row"><span class="k">"model"</span><span class="v">{move || if dash.state.get().cfg_model == 1 { "linear".to_string() } else { "bs".to_string() }}</span></div>
        <div class="row"><span class="k">"down leg"</span><span class="v">{move || if dash.state.get().cfg_trade_down { "on".to_string() } else { "off".to_string() }}</span></div>
    }
}

#[component]
pub fn PnlPanel(dash: Dash) -> impl IntoView {
    view! {
        <div class="row"><span class="k">"realized"</span>
            <span class=move || {
                let v = dash.state.get().realized_c;
                if v >= 0.0 { "v good mid".to_string() } else { "v bad mid".to_string() }
            }>{move || fmt_c(dash.state.get().realized_c)}</span>
        </div>
        <div class="row"><span class="k">"unrealized"</span>
            <span class=move || {
                let v = dash.state.get().unrealized_c;
                if v >= 0.0 { "v good".to_string() } else { "v bad".to_string() }
            }>{move || fmt_c(dash.state.get().unrealized_c)}</span>
        </div>
        <div class="row"><span class="k">"equity"</span>
            <span class=move || {
                let v = dash.state.get().equity_c;
                if v >= 0.0 { "v good big".to_string() } else { "v bad big".to_string() }
            }>{move || fmt_c(dash.state.get().equity_c)}</span>
        </div>
        <div class="row"><span class="k">"pos UP/DN"</span>
            <span class="v">{move || format!("{:.0}/{:.0} sh @ {}/{}c",
                dash.state.get().pos_up_sh, dash.state.get().pos_dn_sh,
                dash.state.get().avg_up as i64, dash.state.get().avg_dn as i64)}</span>
        </div>
        <div class="row"><span class="k">"signals/trades"</span>
            <span class="v">{move || format!("{}/{}", dash.state.get().signals_today, dash.state.get().trades_today)}</span>
        </div>
        <div class="row"><span class="k">"windows done"</span><span class="v">{move || dash.state.get().windows_done.to_string()}</span></div>
        <div class="spark">
            <svg viewBox="0 0 300 60" preserveAspectRatio="none">
                <path d=move || {
                    let d = dash.state.get();
                    let pnl: Vec<f64> = d.wins.iter().take(d.win_head as usize).map(|w| w.pnl_c).collect();
                    crate::charts::spark_centered(&pnl, 300.0, 60.0)
                } fill="none" stroke="#2ee6a8" stroke-width="1.5"/>
            </svg>
        </div>
        <div class="footnote">"per-window realized PnL (cents)"</div>
    }
}
