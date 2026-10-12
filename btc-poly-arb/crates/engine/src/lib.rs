//! engine — orchestration library.
//!
//! The binary (`cli::polyarb`) assembles:
//!
//! ```text
//! [binance ws] --ring--> +-------------------+
//! [pm ws]      --ring--> |  ENGINE THREAD    | --order ring--> [executor]
//! [window mgr] --ring--> |  pinned, spinning | <--ack/fill ring--+
//!                        +---------+---------+
//!                          SeqLock | DashState
//!                        +---------v---------+
//!                        | telemetry pump    | --broadcast--> [axum /ws]
//!                        +-------------------+
//! ```
//!
//! For tests and benchmarks `EngineCore` runs standalone: feed events in,
//! orders out, no threads required.

pub mod config;
pub mod exec;
pub mod runner;
pub mod state;
pub mod telemetry;
pub mod window;

pub use config::AppConfig;
pub use runner::{engine_main, EngineShared};
pub use state::{EngineCore, LevelBook, Pos};

/// Spawn the engine thread + return the join handle.
pub fn spawn_engine_thread(shared: std::sync::Arc<EngineShared>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("engine".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || engine_main(shared))
        .expect("spawn engine thread")
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::*;

    fn core() -> EngineCore {
        let mut c = EngineCore::new(AppConfig::default());
        // synthetic window: now + 120s, strike 83_200
        let clock = hotcore::clock::init();
        let now_ms = clock.unix_ms();
        let start = now_ms - 180_000;
        let end = now_ms + 120_000;
        c.install_window(WindowCtx {
            seq: 1,
            start_ms: start,
            end_ms: end,
            condition: [0; 32],
            token_up: U256([1, 0, 0, 0]),
            token_down: U256([2, 0, 0, 0]),
            tick_c: 1,
            min_size: 5.0,
            neg_risk: false,
            strike: 83_200.0,
        });
        c
    }

    fn push_mark(c: &mut EngineCore, price: f64, dt_ms: i64) {
        let t = c.clock.mono_ns() + dt_ms * 1_000_000;
        c.on_binance_event(FeedEvent::BinanceBook {
            t_ns: t,
            bid: price - 0.05,
            bid_sz: 1.0,
            ask: price + 0.05,
            ask_sz: 1.0,
            u: 1,
        });
    }

    fn push_ask(c: &mut EngineCore, token: u8, price_c: i64, size: f64, dt_ms: i64) {
        let t = c.clock.mono_ns() + dt_ms * 1_000_000;
        c.on_pm_event(FeedEvent::PmLevel {
            t_ns: t,
            token,
            side: SIDE_ASK,
            price_c,
            size_sh: size,
        });
    }

    /// End-to-end tweet scenario through the whole engine core (paper logic).
    #[test]
    fn tweet_scenario_fires_and_fills() {
        let mut c = core();
        // warm: 6 seconds of flat marks ENDING at t=0 (so the 5s jump
        // window has references), 100ms cadence
        for i in 0..60 {
            push_mark(&mut c, 83_215.0, (i as i64 - 60) * 100);
        }
        // seed an ask at 56c with plenty of size
        push_ask(&mut c, TOK_UP, 56, 500.0, 0);
        // no jump yet: no order
        assert!(c.take_pending_order().is_none());
        // the 5-second jump: 83,215 -> 83,330 (per the tweet)
        let mut k = 0;
        for i in 0..6 {
            push_mark(&mut c, 83_215.0 + (i as f64) * 19.2, i * 1000);
            k += 1;
            if let Some(req) = c.take_pending_order() {
                // fired!
                assert_eq!(req.dir, DIR_UP);
                assert!(req.limit_c >= 56);
                // simulate the executor's ack + fill
                c.in_flight = c.in_flight.saturating_sub(1);
                c.on_ctl(CtlEvent::Fill {
                    seq: req.seq,
                    dir: req.dir,
                    sh: 50.0,
                    px_c: 56.0,
                    ts_ns: c.clock.mono_ns(),
                    live: false,
                });
                assert_eq!(c.pos.up_sh, 50.0);
                assert_eq!(c.pos.avg_up, 56.0);
                return;
            }
        }
        // also drain any pending from the final marks
        for _ in 0..3 {
            push_mark(&mut c, 83_330.0, 220 + k);
            if let Some(req) = c.take_pending_order() {
                assert_eq!(req.dir, DIR_UP);
                return;
            }
        }
        panic!("tweet scenario did not fire");
    }

    #[test]
    fn window_settlement_pays_winner() {
        let mut c = core();
        c.on_ctl(CtlEvent::Fill {
            seq: 1,
            dir: DIR_UP,
            sh: 100.0,
            px_c: 56.0,
            ts_ns: 0,
            live: false,
        });
        assert_eq!(c.pos.up_sh, 100.0);
        // price ends above strike: UP pays 1.00 -> +44c/share
        push_mark(&mut c, 83_400.0, 300);
        // force the window closed (end_ms = now + 120s: fast-forward by
        // faking a shorter window)
        c.window.end_ms = c.clock.unix_ms() - 1;
        c.tick();
        assert_eq!(c.pos.up_sh, 0.0);
        assert!((c.pos.realized_c - 4400.0).abs() < 1e-6, "pnl {}", c.pos.realized_c);
        assert_eq!(c.windows_done, 1);
    }
}
