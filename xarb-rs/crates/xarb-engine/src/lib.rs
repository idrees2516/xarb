//! xarb-engine v0.3 — the HFT core.
//!
//! Topology (one thread per stage, no shared locks on the decision path):
//!
//! ```text
//!  Binance WS ──parse(~100ns)──► SPSC ring ──► FV engine thread ──► HotWord(u64)
//!  (pinned, own runtime)        (wait-free)   (pinned, spin/eco)  │ Release store
//!  PM CLOB WS ──book──► QuoteCells(u64) ──fold─┘                  ▼
//!  (pinned, dual-token)                              Strategy thread (pinned)
//!                                                     1 load + 2 AND + 2 cmp
//!                                                              │ FireIntent (Copy)
//!                                                              ▼ SPSC ring
//!                                                     Executor thread (pinned)
//!                                                   paper ladder-walk / EIP-712 FOK
//!                                                              │ FillEvent
//!                                                              ▼
//!  Cold task (10Hz snapshots, signals, stats, window lifecycle, control)
//!  ── ArcSwap<String> / broadcast ──► axum WS + HTTP (wait-free reads)
//! ```
//!
//! Every trigger condition is evaluated on EVERY opportunity: the strategy
//! thread re-checks the full 3-condition conjunction (both sides) at spin
//! cadence — no event queue, no coalescing, no missed windows.

pub mod cold;
pub mod executor;
pub mod hotcore;
pub mod snapshot;
pub mod state;
pub mod strategy;
pub mod window;

pub use hotcore::{FvCore, FvFull, HotShared};
pub use state::{
    ChartPoint, EngineConfig, FillEvent, FireIntent, LatencyStats, RiskState, Settings,
    SignalEvt, SignalLog, Stats, Trade, Window, SIDE_DOWN, SIDE_UP,
};
pub use window::ColdState;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, watch};
use xarb_hft::{SpscRing, SpinMode, WakeSlot};
use xarb_poly::ClobClient;

/// Cross-thread wake bus (slots armed as handles spawn).
pub struct WakeBus {
    /// Feeds → FV engine.
    pub fv: Arc<WakeSlot>,
    /// FV engine → strategy.
    pub strat: Arc<WakeSlot>,
    /// Strategy → executor.
    pub exec: Arc<WakeSlot>,
}

/// CPU pin plan (None = leave to the scheduler).
#[derive(Debug, Clone, Copy)]
pub struct PinPlan {
    pub feed: Option<usize>,
    pub fv: Option<usize>,
    pub strat: Option<usize>,
    pub exec: Option<usize>,
    pub pm: Option<usize>,
}

impl PinPlan {
    /// Assign cores 1.. skipping core 0 (reserved for the runtime/kernel).
    /// Feed gets the first core (network syscalls), then FV, strategy,
    /// executor, PM. Fewer cores → later stages unpinned.
    pub fn for_cores(n: usize) -> PinPlan {
        let slots = [PinPlan { feed: Some(1), fv: Some(2), strat: Some(3), exec: Some(4), pm: Some(5) },
                     PinPlan { feed: Some(1), fv: Some(2), strat: Some(3), exec: None, pm: Some(4) },
                     PinPlan { feed: Some(1), fv: Some(2), strat: Some(3), exec: None, pm: None },
                     PinPlan { feed: None, fv: Some(1), strat: Some(2), exec: None, pm: None },
                     PinPlan { feed: None, fv: None, strat: Some(1), exec: None, pm: None }];
        let idx = if n >= 6 {
            0
        } else {
            (7 - n).min(4)
        };
        slots[idx]
    }

    pub fn any(&self) -> bool {
        self.feed.is_some() || self.fv.is_some() || self.strat.is_some()
    }
}

struct Channels {
    signal: tokio::sync::mpsc::UnboundedSender<SignalEvt>,
    fill: tokio::sync::mpsc::UnboundedSender<FillEvent>,
}

pub struct Engine {
    pub cfg: EngineConfig,
    // hot path
    pub hot: Arc<HotShared>,
    pub feeds: Arc<xarb_feed::FeedOut>,
    pub feeds_ring: Arc<SpscRing<xarb_feed::Ev>>,
    pub pm: Arc<xarb_poly::PmOut>,
    pub fire_ring: Arc<SpscRing<FireIntent>>,
    pub wake: WakeBus,
    // shared config/state
    pub cold: Arc<Mutex<ColdState>>,
    pub settings: Arc<arc_swap::ArcSwap<Settings>>,
    pub settings_gen: Arc<AtomicU64>,
    pub risk: Arc<RiskState>,
    pub lat: Arc<LatencyStats>,
    pub running: Arc<AtomicBool>,
    // io / external
    pub token_tx: watch::Sender<Option<(String, String)>>,
    pub clob: Arc<tokio::sync::Mutex<ClobClient>>,
    pub http: Arc<reqwest::Client>,
    pub out_tx: broadcast::Sender<String>,
    pub snap: Arc<arc_swap::ArcSwap<String>>,
    pub init_snap: Arc<arc_swap::ArcSwap<String>>,
    // deployment
    pub spin_mode: SpinMode,
    pub pins: PinPlan,
    pub boot_ms: AtomicU64,
    pub ring_dropped: AtomicU64,
    channels: Mutex<Option<Channels>>,
}

impl Engine {
    pub fn new(
        cfg: EngineConfig,
        clob: ClobClient,
        out_tx: broadcast::Sender<String>,
        spin_mode: SpinMode,
        pins: PinPlan,
    ) -> Arc<Engine> {
        let (token_tx, _rx) = watch::channel(None::<(String, String)>);
        let http = Arc::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .build()
                .unwrap_or_default(),
        );
        let ring = Arc::new(SpscRing::<xarb_feed::Ev>::with_capacity(xarb_feed::RING_CAP));
        let fv_wake = Arc::new(WakeSlot::new());
        let lat = Arc::new(LatencyStats::default());
        let feeds = Arc::new(xarb_feed::FeedOut::new(
            ring.clone(),
            fv_wake.clone(),
            lat.parse.clone(),
        ));
        let pm = Arc::new(xarb_poly::PmOut::new(fv_wake.clone()));
        Arc::new(Engine {
            cfg,
            hot: Arc::new(HotShared::new()),
            feeds,
            feeds_ring: ring,
            pm,
            fire_ring: Arc::new(SpscRing::<FireIntent>::with_capacity(
                strategy::FIRE_RING_CAP,
            )),
            wake: WakeBus {
                fv: fv_wake,
                strat: Arc::new(WakeSlot::new()),
                exec: Arc::new(WakeSlot::new()),
            },
            cold: Arc::new(Mutex::new(ColdState::default())),
            settings: Arc::new(arc_swap::ArcSwap::from_pointee(Settings::default())),
            settings_gen: Arc::new(AtomicU64::new(1)),
            risk: Arc::new(RiskState::default()),
            lat,
            running: Arc::new(AtomicBool::new(true)),
            token_tx,
            clob: Arc::new(tokio::sync::Mutex::new(clob)),
            http,
            out_tx,
            snap: Arc::new(arc_swap::ArcSwap::from_pointee(String::new())),
            init_snap: Arc::new(arc_swap::ArcSwap::from_pointee(String::new())),
            spin_mode,
            pins,
            boot_ms: AtomicU64::new(xarb_core::now_ms()),
            ring_dropped: AtomicU64::new(0),
            channels: Mutex::new(None),
        })
    }

    /// Boot the whole hot-path topology + cold task.
    pub fn start(self: &Arc<Self>, ctrl_rx: tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>) {
        // start the coarse clock (1ns now_ms) on its own tiny thread
        xarb_core::start_coarse_clock();
        // best-effort realtime for the hot threads (no-op without CAP_SYS_NICE)
        if self.pins.any() && xarb_hft::affinity::try_realtime() {
            println!("[boot] SCHED_FIFO acquired for hot threads");
        }
        cold::spawn(self.clone(), ctrl_rx);
        let mode = self.spin_mode;
        println!(
            "[engine] started ({} mode, auto-trade {}, spin {:?})",
            self.cfg.mode,
            self.settings.load_full().auto_trade,
            mode
        );
    }

    /// Broadcast an outbound JSON message (ignoring absent receivers).
    pub fn emit(&self, v: serde_json::Value) {
        let s = v.to_string();
        self.snap.store(Arc::new(s.clone()));
        let _ = self.out_tx.send(s);
    }

    /// Patch settings (dashboard control / env) — hot threads pick the
    /// change up within one recompute (≤1ms).
    pub fn apply_settings(&self, v: &serde_json::Value) {
        let mut st = Settings::clone(self.settings.load_full().as_ref());
        st.patch(v);
        self.settings.store(Arc::new(st));
        self.settings_gen.fetch_add(1, Ordering::Release);
    }

    pub(crate) fn set_channels(
        &self,
        signal: tokio::sync::mpsc::UnboundedSender<SignalEvt>,
        fill: tokio::sync::mpsc::UnboundedSender<FillEvent>,
    ) {
        *self.channels.lock().unwrap() = Some(Channels { signal, fill });
    }

    pub(crate) fn signal_tx_get(&self) -> tokio::sync::mpsc::UnboundedSender<SignalEvt> {
        self.channels.lock().unwrap().as_ref().expect("channels set").signal.clone()
    }

    pub(crate) fn fill_tx_get(&self) -> tokio::sync::mpsc::UnboundedSender<FillEvent> {
        self.channels.lock().unwrap().as_ref().expect("channels set").fill.clone()
    }
}
