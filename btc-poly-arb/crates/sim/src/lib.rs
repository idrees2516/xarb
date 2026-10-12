//! sim — synthetic world + benchmarks.
//!
//! `world` models exactly the edge the tweet describes: Polymarket market
//! makers quote the UP share by watching Binance with a reaction lag; when
//! BTC jumps sharply inside a 5-minute window, the FV jumps immediately
//! (our closed form) while the stale PM ask lags — the bot buys the lag.
//!
//! Two regimes prove the thesis:
//! * `--lag-ms 300` (default): stale quotes -> edge captured, PnL > 0
//! * `--lag-ms 0`: instant MM -> no edge, PnL ~= fees(noise)

pub mod bench;
pub mod world;

use std::sync::Arc;
use std::time::Duration;

use engine::{EngineShared, AppConfig};
use hotcore::clock::Clock;
use wire::{CtlEvent, FeedEvent, WindowCtx, SIDE_ASK, SIDE_BID, TOK_DOWN, TOK_UP};

use crate::world::WorldCfg;

/// Result of one simulation run.
#[derive(Clone, Debug, Default)]
pub struct SimReport {
    pub windows: u32,
    pub signals: u32,
    pub trades: u32,
    pub realized_c: f64,
    pub unrealized_c: f64,
    pub equity_c: f64,
    pub lat_p50_tick_to_signal_ns: u64,
    pub lat_p99_tick_to_signal_ns: u64,
    pub lat_p50_ring_ns: u64,
    pub lat_p99_ring_ns: u64,
    pub rejects: [u64; 8],
}

/// Drive the full stack (engine thread + paper executor + telemetry) with
/// synthetic data. Returns the final report.
pub async fn run_sim(
    mut cfg: AppConfig,
    world_cfg: WorldCfg,
    shared: Arc<EngineShared>,
) -> SimReport {
    cfg.mode = wire::MODE_SIM;
    // (wall-clock threshold scaling happens in the CLI before the engine
    // is constructed — see cli run_sim_cmd)
    let speed = world_cfg.speed.max(0.1);
    let clock = Clock::global();
    let window_real_ms = (world_cfg.window_s * 1000.0 / speed) as i64;
    let tick_ms = (100.0 / speed).max(1.0) as i64;
    let n_windows = world_cfg.n_windows.max(1);

    // paper executor
    let exec_deps = engine::exec::ExecDeps {
        cfg: cfg.clone(),
        order_ring: shared.order_ring.clone(),
        ctl_ring: shared.ctl_ring.clone(),
        client: None,
        ladder: None,
    };
    let exec_task = tokio::spawn(engine::exec::run_executor(exec_deps));

    let speed_w = world_cfg.speed;
    let n_windows_w = world_cfg.n_windows;
    let window_s_v = world_cfg.window_s;
    let mut w = world::SyntheticWorld::new(world_cfg);
    let t0 = clock.unix_ms();
    for wi in 0..n_windows_w {
        // install a synthetic window
        let start = t0 + wi as i64 * window_real_ms;
        let end = start + window_real_ms;
        let ctx = WindowCtx {
            seq: wi + 1,
            start_ms: start,
            end_ms: end,
            condition: [0u8; 32],
            token_up: wire::U256([100 + wi as u64, 0, 0, 0]),
            token_down: wire::U256([200 + wi as u64, 0, 0, 0]),
            tick_c: 1,
            min_size: 5.0,
            neg_risk: false,
            strike: 0.0, // engine captures from first mark after start
        };
        // MM learns the window strike (mirrors the engine's capture)
        w.set_strike(w.price());
        let _ = shared.win_ring.try_push(CtlEvent::InstallWindow(ctx));
        // reset books; the MM requotes from his first cadence tick
        let t = clock.mono_ns();
        let _ = shared
            .pm_ring
            .try_push(FeedEvent::PmReset { t_ns: t, token: TOK_UP });
        let _ = shared
            .pm_ring
            .try_push(FeedEvent::PmReset { t_ns: t, token: TOK_DOWN });

        // simulate the window in real time (compressed), deadline-paced so
        // sleep overshoot never accumulates
        let steps = (window_real_ms / tick_ms).max(1);
        let step_ns = (tick_ms as i64) * 1_000_000;
        let w_start_ns = clock.mono_ns();
        let total_steps = steps as f64;
        for s in 0..steps {
            let tau_v = window_s_v * (1.0 - s as f64 / total_steps);
            w.set_tau_remaining(tau_v);
            let t = clock.mono_ns();
            let events = w.step(t, s, tick_ms, speed_w);
            for ev in events {
                match ev {
                    world::SimEvent::Binance(e) => {
                        let _ = shared.binance_ring.try_push(e);
                    }
                    world::SimEvent::Pm(e) => {
                        let _ = shared.pm_ring.try_push(e);
                    }
                }
            }
            let deadline_ns = w_start_ns + (s + 1) as i64 * step_ns;
            let now_ns = clock.mono_ns();
            if deadline_ns > now_ns {
                tokio::time::sleep(Duration::from_nanos((deadline_ns - now_ns) as u64)).await;
            }
        }
    }
    // let the last fills settle
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    exec_task.abort();

    let d = shared.dash_state();
    SimReport {
        windows: d.windows_done,
        signals: d.signals_today,
        trades: d.trades_today,
        realized_c: d.realized_c,
        unrealized_c: d.unrealized_c,
        equity_c: d.equity_c,
        lat_p50_tick_to_signal_ns: d.lat[5].p50_ns,
        lat_p99_tick_to_signal_ns: d.lat[5].p99_ns,
        lat_p50_ring_ns: d.lat[1].p50_ns,
        lat_p99_ring_ns: d.lat[1].p99_ns,
        rejects: d.rejects,
    }
}
