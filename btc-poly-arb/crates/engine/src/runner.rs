//! Engine runner: the pinned, spinning hot thread and all ring wiring.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use hotcore::ring::SpscRing;
use hotcore::seqlock::SeqLock;
use wire::{CtlEvent, DashState, FeedEvent, OrdRec, OrderReq};

use crate::config::AppConfig;
use crate::state::EngineCore;

/// Shared handles (created once, passed to tasks).
pub struct EngineShared {
    pub cfg: Arc<AppConfig>,
    pub binance_ring: Arc<SpscRing<FeedEvent>>,
    pub pm_ring: Arc<SpscRing<FeedEvent>>,
    pub win_ring: Arc<SpscRing<CtlEvent>>, // window manager -> engine
    pub ctl_ring: Arc<SpscRing<CtlEvent>>, // executor -> engine
    pub order_ring: Arc<SpscRing<OrderReq>>,
    pub dash: Arc<SeqLock<DashState>>,
    pub kill: Arc<AtomicBool>,
}

impl EngineShared {
    pub fn new(cfg: AppConfig) -> EngineShared {
        EngineShared {
            cfg: Arc::new(cfg),
            binance_ring: Arc::new(SpscRing::with_capacity(4096)),
            pm_ring: Arc::new(SpscRing::with_capacity(8192)),
            win_ring: Arc::new(SpscRing::with_capacity(64)),
            ctl_ring: Arc::new(SpscRing::with_capacity(1024)),
            order_ring: Arc::new(SpscRing::with_capacity(256)),
            dash: Arc::new(SeqLock::new(DashState::default())),
            kill: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn kill(&self) -> bool {
        self.kill.load(Ordering::Relaxed)
    }

    pub fn set_kill(&self, v: bool) {
        self.kill.store(v, Ordering::Relaxed);
    }

    pub fn dash_state(&self) -> DashState {
        self.dash.read()
    }
}

/// The hot thread body. Pinned to `cfg.pin_core` (or the last core),
/// optionally SCHED_FIFO, then spins:
///
/// 1. drain control + window rings
/// 2. drain PM book events (may trigger evaluation)
/// 3. drain Binance events (mark -> FV -> strategy)
/// 4. periodic tick (rollover + dash publish)
///
/// Signals push `OrderReq`s to the executor ring and are never allowed to
/// block: a full executor ring rejects the trade (counted).
pub fn engine_main(shared: Arc<EngineShared>) {
    let cfg = shared.cfg.clone();
    let core = EngineCore::new(cfg.as_ref().clone());
    let pin = cfg.pin_core.unwrap_or_else(|| {
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        n.saturating_sub(1)
    });
    drop(cfg);
    if core_affinity::set_for_current(core_affinity::CoreId { id: pin }) {
        tracing::info!(target: "engine", core = pin, "engine thread pinned");
    }
    if cfg_rt_promote() {
        tracing::info!(target: "engine", "SCHED_FIFO acquired");
    }
    let mut core = core;

    let mut bin_buf = [wire::FeedEvent::BinanceTrade {
        t_ns: 0,
        ex_ms: 0,
        price: 0.0,
        qty: 0.0,
        aggressor_buy: false,
        id: 0,
    }; 256];
    let mut pm_buf: [wire::FeedEvent; 256] =
        [wire::FeedEvent::PmLevel { t_ns: 0, token: 0, side: 0, price_c: 0, size_sh: 0.0 }; 256];
    let idle_ns: i64 = 50_000_000; // 50ms park in low-power mode
    let mut last_event_ns = core.clock.mono_ns();

    loop {
        if shared.kill.load(Ordering::Relaxed) {
            // drain remaining events, then stop
            let mut drained = 0usize;
            while let Some(_ev) = shared.binance_ring.try_pop() { drained += 1; }
            while let Some(_ev) = shared.pm_ring.try_pop() { drained += 1; }
            while let Some(_ev) = shared.ctl_ring.try_pop() { drained += 1; }
            while let Some(_ev) = shared.win_ring.try_pop() { drained += 1; }
            core.publish_dash(core.clock.mono_ns());
            shared.dash.store(core.dash);
            tracing::info!(target: "engine", drained, "engine thread stopped");
            break;
        }
        let mut work: usize = 0;

        // 1) control plane
        while let Some(ev) = shared.win_ring.try_pop() {
            work += 1;
            core.on_ctl(ev);
        }
        while let Some(ev) = shared.ctl_ring.try_pop() {
            work += 1;
            core.on_ctl(ev);
        }

        // 2) PM books
        let n = shared.pm_ring.pop_slice(&mut pm_buf);
        work += n;
        for ev in pm_buf.iter().take(n) {
            let t_engine = core.clock.mono_ns();
            if let wire::FeedEvent::PmLevel { t_ns, .. } = ev {
                core.lat[1].record((t_engine - t_ns).max(0) as u64);
            }
            core.on_pm_event(*ev);
        }

        // 3) binance
        let n = shared.binance_ring.pop_slice(&mut bin_buf);
        work += n;
        for ev in bin_buf.iter().take(n) {
            let t_engine = core.clock.mono_ns();
            if let wire::FeedEvent::BinanceTrade { t_ns, .. }
            | wire::FeedEvent::BinanceBook { t_ns, .. } = ev
            {
                core.lat[1].record((t_engine - t_ns).max(0) as u64);
            }
            // config reload?
            let kill = shared.kill.load(Ordering::Relaxed);
            let prev_kill = core.dash.kill;
            core.dash.kill = kill;
            let _ = prev_kill;
            core.on_binance_event(*ev);
            if let Some(req) = core.take_pending_order() {
                push_order(&shared, &mut core, req);
            }
        }

        // 4) tick / rollover / publish
        let t_before = core.dash.t_ns;
        core.tick();
        if core.dash.t_ns != t_before {
            shared.dash.store(core.dash);
        }
        if let Some(req) = core.take_pending_order() {
            push_order(&shared, &mut core, req);
        }

        if work == 0 {
            if core.cfg.spin {
                std::hint::spin_loop();
            } else {
                let now = core.clock.mono_ns();
                if now - last_event_ns > idle_ns {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        } else {
            last_event_ns = core.clock.mono_ns();
        }
    }
}

fn push_order(shared: &Arc<EngineShared>, core: &mut EngineCore, req: OrderReq) {
    core.push_ord(OrdRec {
        t_ns: core.clock.mono_ns(),
        seq: req.seq,
        dir: req.dir,
        limit_c: req.limit_c,
        sh: req.size_sh,
        status: 0,
        fill_sh: 0.0,
        avg_px_c: 0.0,
    });
    if shared.order_ring.try_push(req).is_err() {
        // executor wedged: reject locally
        core.in_flight = core.in_flight.saturating_sub(1);
        let idx = 5;
        core.rejects[idx] += 1;
        tracing::error!(target: "engine", "order ring full; trade dropped");
    }
    // publish dash snapshot with the new signal/order
    core.publish_dash(core.clock.mono_ns());
    shared.dash.store(core.dash);
}

/// Attempt SCHED_FIFO (needs CAP_SYS_NICE; fails harmlessly otherwise).
fn cfg_rt_promote() -> bool {
    unsafe {
        let param = libc::sched_param { sched_priority: 10 };
        libc::sched_setscheduler(0, libc::SCHED_FIFO, &param) == 0
    }
}
