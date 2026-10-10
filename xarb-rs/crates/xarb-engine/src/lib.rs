//! Engine orchestration: feeds → hot-path evaluation → paper/live execution
//! → 10Hz snapshot broadcast. All cross-task state sits behind std Mutexes
//! with tens-of-nanoseconds critical sections; the decision path runs inline
//! on the feed event task with zero extra hops.

pub mod fire;
pub mod hotpath;
pub mod snapshot;
pub mod state;
pub mod window;

pub use state::{ChartPoint, EngineConfig, Settings, SignalLog, Stats, Trade, Window};

use crate::state::local_midnight;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};
use xarb_core::{now_ms, FvRing, Ring, Trig};
use xarb_feed::{spawn as spawn_binance, BinState, SharedBin};
use xarb_poly::clob_ws::spawn as spawn_pm;
use xarb_poly::{ClobClient, PmState, SharedPm};

pub const FV_PUSH_MS: u64 = 50;
pub const FV_KEEP_MS: u64 = 20_000;
pub const SIGNAL_COOLDOWN_MS: u64 = 5_000;
pub const CHART_PUSH_MS: u64 = 250;
pub const CHART_CAP: usize = 1440;

pub struct Engine {
    pub cfg: EngineConfig,
    pub bin: SharedBin,
    pub pm: SharedPm,
    pub window: Arc<Mutex<Window>>,
    pub settings: Arc<Mutex<Settings>>,
    pub stats: Arc<Mutex<Stats>>,
    pub signals: Arc<Mutex<Vec<SignalLog>>>,
    pub trades: Arc<Mutex<Vec<Trade>>>,
    pub chart: Arc<Mutex<Vec<ChartPoint>>>,
    pub fv_ring: Arc<Mutex<FvRing>>,
    pub trig: Arc<Mutex<Trig>>,
    pub last_fv: Arc<Mutex<f64>>,
    pub running: Arc<AtomicBool>,
    pub last_signal_ts: Arc<AtomicU64>,
    pub decision_us: Arc<Mutex<Ring>>,
    pub tick_us: Arc<Mutex<Ring>>,
    pub feed_lag: Arc<Mutex<Ring>>,
    pub signal_seq: Arc<AtomicU64>,
    pub token_tx: watch::Sender<Option<String>>,
    pub clob: Arc<tokio::sync::Mutex<ClobClient>>,
    pub out_tx: broadcast::Sender<String>,
    pub http: Arc<reqwest::Client>,
}

impl Engine {
    pub fn new(
        cfg: EngineConfig,
        clob: ClobClient,
        out_tx: broadcast::Sender<String>,
    ) -> Arc<Engine> {
        let (token_tx, _rx) = watch::channel(None::<String>);
        let http = Arc::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(8))
                .build()
                .unwrap_or_default(),
        );
        Arc::new(Engine {
            cfg,
            bin: Arc::new(Mutex::new(BinState::default())),
            pm: Arc::new(Mutex::new(PmState::default())),
            window: Arc::new(Mutex::new(Window::empty(0))),
            settings: Arc::new(Mutex::new(Settings::default())),
            stats: Arc::new(Mutex::new(Stats {
                day_start: local_midnight(),
                ..Stats::default()
            })),
            signals: Arc::new(Mutex::new(Vec::new())),
            trades: Arc::new(Mutex::new(Vec::new())),
            chart: Arc::new(Mutex::new(Vec::new())),
            fv_ring: Arc::new(Mutex::new(FvRing::new(FV_KEEP_MS))),
            trig: Arc::new(Mutex::new(Trig::default())),
            last_fv: Arc::new(Mutex::new(50.0)),
            running: Arc::new(AtomicBool::new(true)),
            last_signal_ts: Arc::new(AtomicU64::new(0)),
            decision_us: Arc::new(Mutex::new(Ring::new(400))),
            tick_us: Arc::new(Mutex::new(Ring::new(400))),
            feed_lag: Arc::new(Mutex::new(Ring::new(400))),
            signal_seq: Arc::new(AtomicU64::new(0)),
            token_tx,
            clob: Arc::new(tokio::sync::Mutex::new(clob)),
            out_tx,
            http,
        })
    }

    /// Boot everything: feeds, hot path, tick loop, window manager, control.
    pub fn start(self: &Arc<Self>, mut ctrl_rx: mpsc::UnboundedReceiver<serde_json::Value>) {
        let (ev_tx, ev_rx) = mpsc::unbounded_channel::<()>();

        // initial window
        let eng = self.clone();
        tokio::spawn(async move {
            let epoch = xarb_core::current_window_epoch(now_ms());
            crate::window::manage_window(eng, epoch).await;
        });

        // feeds
        spawn_binance(self.bin.clone(), ev_tx.clone());
        {
            let token_rx = self.token_tx.subscribe();
            spawn_pm(self.pm.clone(), token_rx, ev_tx);
        }

        // hot path
        {
            let eng = self.clone();
            tokio::spawn(async move {
                crate::hotpath::run(eng, ev_rx).await;
            });
        }

        // 10Hz tick loop
        {
            let eng = self.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
                loop {
                    tick.tick().await;
                    crate::window::tick(&eng).await;
                }
            });
        }

        // control
        {
            let eng = self.clone();
            tokio::spawn(async move {
                while let Some(msg) = ctrl_rx.recv().await {
                    apply_control(&eng, &msg);
                }
            });
        }

        println!(
            "[engine] started ({} mode, auto-trade {})",
            self.cfg.mode,
            self.settings.lock().unwrap().auto_trade
        );
    }

    /// Broadcast an outbound JSON message (ignoring absent receivers).
    pub fn emit(&self, v: serde_json::Value) {
        let _ = self.out_tx.send(v.to_string());
    }
}

fn apply_control(eng: &Arc<Engine>, msg: &serde_json::Value) {
    let kind = msg["type"].as_str().unwrap_or("");
    match kind {
        "start" => {
            eng.running.store(true, Ordering::Relaxed);
            println!("[engine] running=true");
        }
        "stop" => {
            eng.running.store(false, Ordering::Relaxed);
            println!("[engine] running=false");
        }
        "reset" => {
            {
                let mut signals = eng.signals.lock().unwrap();
                signals.clear();
                let mut trades = eng.trades.lock().unwrap();
                trades.clear();
                let mut stats = eng.stats.lock().unwrap();
                *stats = Stats { day_start: local_midnight(), ..Stats::default() };
                let mut chart = eng.chart.lock().unwrap();
                chart.clear();
            }
            println!("[engine] stats reset");
        }
        "settings" => {
            if let Some(s) = msg.get("settings") {
                let mut st = eng.settings.lock().unwrap();
                st.patch(s);
                println!("[engine] settings updated: {s}");
            }
        }
        _ => {}
    }
}
