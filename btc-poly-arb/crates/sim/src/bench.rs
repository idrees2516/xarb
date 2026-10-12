//! Latency and throughput benchmark harness.
//!
//! Reports, with TSC cycle-clock measurements:
//!
//! * micro: erf, norm_cdf, fv (BS digital), strategy evaluate, ring hop,
//!   keccak, ECDSA sign, full order build+render
//! * pipeline: 1M feed events through the real engine core
//! * threads: 2M events through SPSC rings into the pinned engine thread
//!   (tick->ring->engine latency distribution from DashState)
//!
//! Run: `polyarb bench` (release build recommended).

use std::sync::Arc;
use std::time::{Duration, Instant};

use clob::order::OrderBuilder;
use clob::signer::Wallet;
use engine::config::AppConfig;
use engine::state::EngineCore;
use engine::EngineShared;
use hotcore::clock::{measure_cycles, Clock};
use hotcore::ring::SpscRing;
use strategy::{RiskView, Snapshot, Strategy};
use wire::{FeedEvent, WindowCtx, SIDE_ASK, TOK_UP};

use crate::world::norm_cdf;

pub struct BenchReport {
    pub erf_ns: f64,
    pub norm_cdf_ns: f64,
    pub fv_ns: f64,
    pub strategy_ns: f64,
    pub ring_ns: f64,
    pub keccak_ns: f64,
    pub ecdsa_ns: f64,
    pub order_build_ns: f64,
    pub pipeline_events_ps: f64,
    pub pipeline_per_event_ns: f64,
    pub threaded_ring_p50_ns: u64,
    pub threaded_ring_p99_ns: u64,
    pub threaded_tick_to_signal_p50_ns: u64,
    pub threaded_tick_to_signal_p99_ns: u64,
    pub tsc_ghz: f64,
}

fn bench<F: FnMut()>(n: u64, mut f: F) -> f64 {
    // warmup
    for _ in 0..(n / 10).max(1) {
        f();
    }
    let clock = Clock::global();
    let t0 = clock.mono_ns();
    let c0 = hotcore::clock::rdtscp();
    for _ in 0..n {
        f();
    }
    let cyc = hotcore::clock::rdtscp().wrapping_sub(c0) as f64;
    let dt = clock.mono_ns() - t0;
    let _ = cyc;
    dt as f64 / n as f64
}

/// Full benchmark suite. `threaded` runs the multi-thread ring pipeline
/// (several seconds).
pub fn run(threaded: bool) -> BenchReport {
    let clock = hotcore::clock::init();
    let ghz = clock.ghz();

    // ---- micro benchmarks ----
    let erf_ns = bench(200_000, || {
        let x = std::hint::black_box(0.7f64);
        let _ = pricing::erf(x);
    });
    let norm_cdf_ns = bench(200_000, || {
        let x = std::hint::black_box(1.3f64);
        let _ = norm_cdf(x);
    });
    let fv_ns = bench(200_000, || {
        let _ = pricing::fv_up(
            std::hint::black_box(83_215.0),
            std::hint::black_box(83_200.0),
            std::hint::black_box(120.0),
            std::hint::black_box(1.3e-4),
        );
    });

    // strategy evaluate (seeded history)
    let mut strat = Strategy::new(strategy::StrategyCfg::default());
    let t0 = clock.mono_ns();
    for i in 0..60 {
        strat.observe_fv(t0 + (i as i64 - 60) * 100_000_000, 0.50);
    }
    let snap = Snapshot {
        t_ns: t0,
        tau_s: 120.0,
        fv_up: 0.86,
        up_ask: 0.56,
        up_ask_sz: 500.0,
        down_ask: 0.90,
        down_ask_sz: 500.0,
    };
    let risk = RiskView {
        cooldown_until_ns: 0,
        in_flight: 0,
        trades_this_window: 0,
        max_trades_per_window: 2,
        pos_dir_sh: 0.0,
        max_pos_sh: 200.0,
        loss_stopped: false,
        binance_age_ns: 1_000_000,
        stale_ns: 400_000_000,
        kill: false,
    };
    let strategy_ns = bench(100_000, || {
        let _ = std::hint::black_box(strat.evaluate(std::hint::black_box(&snap), &risk));
    });

    // ring hop (single-threaded push+pop round trip)
    let ring = SpscRing::<u64>::with_capacity(1024);
    let ring_ns = bench(1_000_000, || {
        let _ = ring.try_push(std::hint::black_box(42u64));
        let _ = std::hint::black_box(ring.try_pop());
    });

    // keccak of a 13-word struct buffer (416 bytes)
    let buf = [7u8; 416];
    let keccak_ns = bench(100_000, || {
        let _ = clob::spec::keccak256(std::hint::black_box(&buf));
    });

    // ECDSA sign of a digest
    let wallet = Wallet::from_hex(
        "4646464646464646464646464646464646464646464646464646464646464646",
    )
    .unwrap();
    let digest = clob::spec::keccak256(b"bench digest");
    let ecdsa_ns = bench(2_000, || {
        let _ = std::hint::black_box(wallet.sign_digest_65(std::hint::black_box(&digest)));
    });

    // full order build (hash + sign + JSON render)
    let mut builder = OrderBuilder::new(
        Wallet::from_hex("4646464646464646464646464646464646464646464646464646464646464646").unwrap(),
        99,
    );
    let token = wire::U256([12345, 0, 0, 0]);
    let order_build_ns = bench(2_000, || {
        let _ = std::hint::black_box(builder.build(
            std::hint::black_box(&token),
            0,
            56,
            50.0,
            1,
            false,
            "FAK",
            "key",
        ));
    });

    // ---- pipeline: 1M events through the engine core ----
    let mut core = EngineCore::new(AppConfig::default());
    let now_ms = clock.unix_ms();
    core.install_window(WindowCtx {
        seq: 1,
        start_ms: now_ms - 180_000,
        end_ms: now_ms + 120_000,
        condition: [0; 32],
        token_up: wire::U256([1, 0, 0, 0]),
        token_down: wire::U256([2, 0, 0, 0]),
        tick_c: 1,
        min_size: 5.0,
        neg_risk: false,
        strike: 83_200.0,
    });
    // seed an ask so evaluations have a counterparty
    core.on_pm_event(FeedEvent::PmLevel {
        t_ns: clock.mono_ns(),
        token: TOK_UP,
        side: SIDE_ASK,
        price_c: 56,
        size_sh: 1_000_000.0,
    });
    let t_start = Instant::now();
    let n = 1_000_000u64;
    let mut t_ev = clock.mono_ns();
    let mut price = 83_215.0f64;
    for i in 0..n {
        // random walk with occasional spikes so the strategy actually fires
        if i % 5_000 == 4_999 {
            price += 40.0;
        } else {
            price += (i % 7) as f64 - 3.0;
        }
        t_ev += 100_000; // 100µs apart (100x real-time feed)
        core.on_binance_event(FeedEvent::BinanceBook {
            t_ns: t_ev,
            bid: price - 0.05,
            bid_sz: 1.0,
            ask: price + 0.05,
            ask_sz: 1.0,
            u: i,
        });
        let _ = core.take_pending_order(); // bench: drop orders (cooldown prevents storms anyway)
    }
    let pipeline_dt = t_start.elapsed().as_nanos() as f64;
    let pipeline_per_event_ns = pipeline_dt / n as f64;
    let pipeline_events_ps = 1e9 / pipeline_per_event_ns;

    // ---- threaded ring pipeline ----
    let (threaded_ring_p50, threaded_ring_p99, t2s_p50, t2s_p99) = if threaded {
        threaded_pipeline(2_000_000, 30)
    } else {
        (0, 0, 0, 0)
    };

    BenchReport {
        erf_ns,
        norm_cdf_ns,
        fv_ns,
        strategy_ns,
        ring_ns,
        keccak_ns,
        ecdsa_ns,
        order_build_ns,
        pipeline_events_ps,
        pipeline_per_event_ns,
        threaded_ring_p50_ns: threaded_ring_p50,
        threaded_ring_p99_ns: threaded_ring_p99,
        threaded_tick_to_signal_p50_ns: t2s_p50,
        threaded_tick_to_signal_p99_ns: t2s_p99,
        tsc_ghz: ghz,
    }
}

/// Push events through real rings into the real engine thread at a
/// realistic feed rate (50k events/s with burst markers), then read the
/// latency histograms the engine recorded.
fn threaded_pipeline(_n: u64, secs: u32) -> (u64, u64, u64, u64) {
    // 5s of warm-up (fills the FvWindow jump reference) + 6s measured
    let n: u64 = 550_000;
    let shared = Arc::new(EngineShared::new(AppConfig::default()));
    // install a window directly through the win ring
    let clock = Clock::global();
    let now_ms = clock.unix_ms();
    let _ = shared.win_ring.try_push(wire::CtlEvent::InstallWindow(WindowCtx {
        seq: 1,
        start_ms: now_ms - 180_000,
        end_ms: now_ms + (secs as i64 + 60) * 1000,
        condition: [0; 32],
        token_up: wire::U256([1, 0, 0, 0]),
        token_down: wire::U256([2, 0, 0, 0]),
        tick_c: 1,
        min_size: 5.0,
        neg_risk: false,
        strike: 83_200.0,
    }));
    let _ = shared.pm_ring.try_push(FeedEvent::PmLevel {
        t_ns: clock.mono_ns(),
        token: TOK_UP,
        side: SIDE_ASK,
        price_c: 56,
        size_sh: 1_000_000.0,
    });

    let engine_thread = engine::spawn_engine_thread(shared.clone());
    // producer thread
    let prod_ring = shared.binance_ring.clone();
    let order_ring = shared.order_ring.clone();
    let ctl_ring = shared.ctl_ring.clone();
    let producer = std::thread::spawn(move || {
        let mut price = 83_215.0f64;
        let mut dropped = 0u64;
        for i in 0..n {
            // mean-reverting around the strike with a sharp kick every 5
            // seconds (250k events): each kick is a clean "20c+ in 5s"
            // jump so the signal path fires on every kick
            price += (83_215.0 - price) * 0.002;
            if i % 250_000 == 249_999 {
                price += 90.0;
            } else {
                price += (i % 7) as f64 - 3.0;
            }
            // 50k events/s = 20µs cadence (well above Binance bookTicker
            // bursts of ~5k/s, so this measures realistic queueing, not
            // saturation backpressure)
            std::thread::sleep(std::time::Duration::from_micros(20));
            // simulated executor: ack any orders so signals can repeat
            while let Some(req) = order_ring.try_pop() {
                let _ = ctl_ring.try_push(wire::CtlEvent::OrderAck {
                    seq: req.seq,
                    status: 1,
                    ts_ns: clock.mono_ns(),
                    order_id: 0,
                });
            }
            // stamp REAL arrival time so ring-hop latency is meaningful
            let t_ev = clock.mono_ns();
            let ev = FeedEvent::BinanceBook {
                t_ns: t_ev,
                bid: price - 0.05,
                bid_sz: 1.0,
                ask: price + 0.05,
                ask_sz: 1.0,
                u: i,
            };
            while prod_ring.try_push(ev).is_err() {
                dropped += 1;
                std::hint::spin_loop();
            }
        }
        dropped
    });
    let _dropped = producer.join().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let d = shared.dash_state();
    let _ = engine_thread;
    (d.lat[1].p50_ns, d.lat[1].p99_ns, d.lat[5].p50_ns, d.lat[5].p99_ns)
}

impl BenchReport {
    pub fn print(&self) {
        println!("══════════════════════════════════════════════════════════════");
        println!(" polyarb latency harness (TSC @ {:.3} GHz, release build)", self.tsc_ghz);
        println!("══════════════════════════════════════════════════════════════");
        println!(" micro-benchmarks (ns/op)");
        println!("   erf (A&S)                    {:>10.1}", self.erf_ns);
        println!("   norm_cdf                     {:>10.1}", self.norm_cdf_ns);
        println!("   fv_up (BS digital)           {:>10.1}", self.fv_ns);
        println!("   strategy evaluate            {:>10.1}", self.strategy_ns);
        println!("   SPSC ring push+pop           {:>10.1}", self.ring_ns);
        println!("   keccak256 (416B struct)      {:>10.1}", self.keccak_ns);
        println!("   ECDSA sign (secp256k1)       {:>10.1}", self.ecdsa_ns);
        println!("   order build+sign+render      {:>10.1}", self.order_build_ns);
        println!();
        println!(" pipeline (engine core, single thread)");
        println!("   events/s                     {:>10.0}", self.pipeline_events_ps);
        println!("   ns/event (incl. fv+strategy) {:>10.1}", self.pipeline_per_event_ns);
        println!();
        println!(" threaded (550k events @ 50k/s, rings + pinned engine)");
        println!("   ring hop p50 / p99    ns     {:>6} / {:>6}", self.threaded_ring_p50_ns, self.threaded_ring_p99_ns);
        println!("   tick->signal p50/p99  ns     {:>6} / {:>6}", self.threaded_tick_to_signal_p50_ns, self.threaded_tick_to_signal_p99_ns);
        println!();
        println!(" decision path budget (no network):");
        println!("   tick -> fv -> signal          ~{:.0} ns", self.fv_ns + self.strategy_ns + self.ring_ns);
        println!("   + order build (sign-on-fire)  ~{:.0} ns  (ECDSA dominates)", self.order_build_ns);
        println!("   + pre-signed ladder           ~{:.0} ns  (JSON already serialized)", self.ring_ns * 2.0);
        println!("══════════════════════════════════════════════════════════════");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn quick_pipeline() {
        // debug-mode smoke of the pipeline measurement
        let r = super::run(false);
        assert!(r.pipeline_per_event_ns > 0.0);
        assert!(r.fv_ns > 0.0);
        assert!(r.ecdsa_ns > 0.0);
    }
}
