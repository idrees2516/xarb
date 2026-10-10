//! FV engine: pure state machine + dedicated pinned thread.
//!
//! `FvCore` is a fully deterministic, testable state machine (no I/O, no
//! clocks — time is injected). The thread wrapper drains the Binance SPSC
//! ring in batches, folds the PM quote cells, recomputes the Normal-CDF fair
//! value on every event AND on a 1ms time-decay cadence (FV drifts as √τ
//! decays even with a static price), maintains the fixed-size FV history
//! with an O(1) two-pointer 5s-jump, and packs everything into the hot word
//! (single Release store). Rich state is published through ArcSwap at ≥20ms
//! cadence for the cold path.
//!
//! Window/strike updates arrive via three atomics (strike f64-bits, end_ms,
//! gen) — the gen counter is bumped LAST on write and read FIRST, giving a
//! lock-free consistent snapshot without any locks.

use crate::state::{LatencyStats, Settings, FV_PUSH_MS};
use arc_swap::ArcSwap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use xarb_core::{fv as fv_calc, mono_ns, now_ms, FvOut};
use xarb_feed::Ev;
use xarb_hft::hot::{
    FLAG_AUTOTRADE, FLAG_BIN_ALIVE, FLAG_KILL, FLAG_MIN_SECS_OK, FLAG_PM_ALIVE,
    FLAG_TRIG_EDGE_DN, FLAG_TRIG_EDGE_UP, FLAG_TRIG_FLOOR_DN, FLAG_TRIG_FLOOR_UP,
    FLAG_TRIG_JUMP_DN, FLAG_TRIG_JUMP_UP, FLAG_WIN_OPEN,
};
use xarb_hft::{CachePadded, HotWord, QuoteCell, SpinMode, SpscRing, WakeSlot};
use xarb_poly::PmOut;

/// FV history capacity (power of two). At the throttled push cadence
/// (≥10ms, or ≥50ms without a 1¢ move) this holds ≥ 82s of history — far
/// beyond the 5s jump window.
const FV_HIST_CAP: usize = 8192;
const FV_HIST_MASK: u64 = (FV_HIST_CAP - 1) as u64;

/// Vol sampling ring (1s decimated prices for the EWMA realized vol).
const VOL_CAP: usize = 128;

/// Binace staleness budget for the BIN_ALIVE flag.
const BIN_STALE_MS: u64 = 2_000;

/// Rich fair-value state for the cold path (published via ArcSwap).
#[derive(Debug, Clone, Default)]
pub struct FvFull {
    pub t_ms: u64,
    pub price: f64,
    pub bid: f64,
    pub ask: f64,
    pub vol_pts: f64,
    pub fv_up: f64,
    pub fv_down: f64,
    pub z: f64,
    pub sd: f64,
    pub slope: f64,
    pub jump_up: f64,
    pub edge_up: Option<f64>,
    pub edge_down: Option<f64>,
    pub ask_up: Option<f64>,
    pub ask_down: Option<f64>,
    pub tau_s: f64,
    pub strike: f64,
    pub window_end: u64,
    pub ticks: u64,
    pub ticks_per_min: u64,
    pub feed_lag_ms: f64,
}

/// Pure FV state machine. All methods are deterministic given (state, now).
pub struct FvCore {
    // binance
    bid: f64,
    ask: f64,
    last: f64,
    last_ev_ms: u64,
    // realized vol
    vol_pts: f64,
    samples: [(u64, f64); VOL_CAP],
    sn: usize,
    // FV history: circular (t_ms, fv_c)
    fh: Box<[(u64, u16)]>,
    fh_pushed: u64,
    fh_last_t: u64,
    fh_last_v: u16,
    fh_ref: u64,
    // window
    pub strike: f64,
    pub end_ms: u64,
    // settings cache
    s: Settings,
    s_gen: u64,
    // folded PM cells (raw packed values)
    up_cell_v: u64,
    dn_cell_v: u64,
    // last computed
    fv_up: f64,
    jump: f64,
    // stats
    ticks: u64,
    tick_counter: u64,
    tick_window_start: u64,
    ticks_per_min: u64,
    lag_ewma_ms: f64,
}

impl FvCore {
    pub fn new(now: u64) -> FvCore {
        FvCore {
            bid: 0.0,
            ask: 0.0,
            last: 0.0,
            last_ev_ms: 0,
            vol_pts: 7.5,
            samples: [(0, 0.0); VOL_CAP],
            sn: 0,
            fh: vec![(0, 0); FV_HIST_CAP].into_boxed_slice(),
            fh_pushed: 0,
            fh_last_t: 0,
            fh_last_v: 0,
            fh_ref: 0,
            strike: 0.0,
            end_ms: 0,
            s: Settings::default(),
            s_gen: 0,
            up_cell_v: 0,
            dn_cell_v: 0,
            fv_up: 50.0,
            jump: 0.0,
            ticks: 0,
            tick_counter: 0,
            tick_window_start: now,
            ticks_per_min: 0,
            lag_ewma_ms: 0.0,
        }
    }

    pub fn reload_settings(&mut self, s: &Settings, gen: u64) {
        self.s = s.clone();
        self.s_gen = gen;
    }

    pub fn settings_gen(&self) -> u64 {
        self.s_gen
    }

    pub fn fold_pm(&mut self, up: QuoteCell, down: QuoteCell) {
        self.up_cell_v = up.0;
        self.dn_cell_v = down.0;
    }

    /// Window rollover: resets strike/end AND the FV history (jump stats are
    /// per-window). A zero strike closes the window (no fires).
    pub fn set_window(&mut self, strike: f64, end_ms: u64) {
        self.strike = strike;
        self.end_ms = end_ms;
        self.fh_pushed = 0;
        self.fh_last_t = 0;
        self.fh_last_v = 0;
        self.fh_ref = 0;
        self.fv_up = 50.0;
        self.jump = 0.0;
    }

    /// For deterministic scenario tests.
    pub fn set_vol_for_test(&mut self, v: f64) {
        self.vol_pts = v;
    }

    pub fn on_ev(&mut self, ev: Ev, now: u64) {
        match ev {
            Ev::Quote { bid, ask } => {
                self.bid = bid;
                self.ask = ask;
            }
            Ev::Trade { p, t_ms } => {
                self.last = p;
                // event-time lag (wall clock comparable)
                if t_ms > 0 && now > t_ms && now - t_ms < 5_000 {
                    let lag = (now - t_ms) as f64;
                    self.lag_ewma_ms = if self.lag_ewma_ms == 0.0 {
                        lag
                    } else {
                        0.9 * self.lag_ewma_ms + 0.1 * lag
                    };
                }
                self.push_sample(t_ms.max(now), p);
            }
        }
        self.last_ev_ms = now;
        self.ticks += 1;
        self.tick_counter += 1;
        let dt = (now.saturating_sub(self.tick_window_start)) as f64 / 1000.0;
        if dt >= 5.0 {
            self.ticks_per_min = (self.tick_counter as f64 / dt * 60.0).round() as u64;
            self.tick_counter = 0;
            self.tick_window_start = now;
        }
    }

    /// 1s-decimated price sample → EWMA realized vol in BTC pts/√s
    /// (same math as the reference TS engine: variance of 1s log returns,
    /// EWMA-smoothed 0.7/0.3, clamped [1.5, 60]).
    fn push_sample(&mut self, t_ms: u64, p: f64) {
        if p <= 0.0 {
            return;
        }
        if let Some(&(lt, _)) = self.samples.get(self.sn.wrapping_sub(1) % VOL_CAP) {
            if self.sn > 0 && t_ms < lt.saturating_add(1_000) {
                return;
            }
        }
        self.samples[self.sn % VOL_CAP] = (t_ms, p);
        self.sn += 1;
        if self.sn < 30 {
            return;
        }
        let n = self.sn.min(121).min(self.sn);
        let start = self.sn.saturating_sub(n);
        let mut sum = 0.0;
        let mut sum2 = 0.0;
        let mut m = 0.0;
        for i in start..self.sn - 1 {
            let (t0, p0) = self.samples[i % VOL_CAP];
            let (t1, p1) = self.samples[(i + 1) % VOL_CAP];
            if p0 <= 0.0 || t1 <= t0 {
                continue;
            }
            let r = (p1 / p0).ln();
            sum += r;
            sum2 += r * r;
            m += 1.0;
        }
        if m >= 10.0 {
            let variance = (sum2 / m - (sum / m).powi(2)).max(0.0);
            let last = self.samples[(self.sn - 1) % VOL_CAP].1;
            let pts = variance.sqrt() * last;
            self.vol_pts = (0.7 * self.vol_pts + 0.3 * pts).clamp(1.5, 60.0);
        }
    }

    #[inline]
    fn mid(&self) -> f64 {
        if self.bid > 0.0 && self.ask > 0.0 {
            (self.bid + self.ask) * 0.5
        } else {
            self.last
        }
    }

    /// Push into the FV history with the throttling policy:
    /// ≥50ms since last push, OR (≥1¢ move AND ≥10ms).
    fn push_hist(&mut self, t: u64, fv_c: u16) {
        if self.fh_pushed > 0 {
            let dt = t.saturating_sub(self.fh_last_t);
            let dv = (fv_c as i16).wrapping_sub(self.fh_last_v as i16).abs();
            if dt < 50 && !(dv >= 1 && dt >= 10) {
                return;
            }
        }
        self.fh[(self.fh_pushed & FV_HIST_MASK) as usize] = (t, fv_c);
        self.fh_pushed += 1;
        self.fh_last_t = t;
        self.fh_last_v = fv_c;
    }

    /// Trailing-5s jump (cents). Reference = the newest sample with
    /// t ≤ now−5000 (needs ≥5s of history, matching the reference engine's
    /// semantics). Two-pointer: O(1) amortized.
    fn jump5s(&mut self, now: u64) -> f64 {
        if self.fh_pushed == 0 {
            return 0.0;
        }
        // advance the reference past samples older than the 5s window edge
        let cutoff = now.saturating_sub(5_000);
        loop {
            let next = self.fh_ref + 1;
            if next >= self.fh_pushed {
                break;
            }
            if self.fh[(next & FV_HIST_MASK) as usize].0 <= cutoff {
                self.fh_ref = next;
            } else {
                break;
            }
        }
        // guard against overwritten history (ring under extreme bursts):
        // the reference must stay inside the live region
        let oldest = self.fh_pushed.saturating_sub(FV_HIST_CAP as u64);
        if self.fh_ref < oldest {
            self.fh_ref = oldest;
        }
        let (_, ref_v) = self.fh[(self.fh_ref & FV_HIST_MASK) as usize];
        // reference must be a real 5s-old sample, else no jump
        if self.fh[(self.fh_ref & FV_HIST_MASK) as usize].0 > cutoff {
            return 0.0;
        }
        (self.fh_last_v as i16 - ref_v as i16) as f64
    }

    /// One full recompute. Returns (hot_word, fv_full_draft).
    pub fn recompute(&mut self, now: u64, running: bool, kill: bool) -> (HotWord, FvFull) {
        // advance jump BEFORE the new push so it reflects the state 5s ago
        // vs now (push happens after FV calc below).
        let price = self.mid();
        let t_sec = if self.end_ms > now {
            ((self.end_ms - now) as f64) / 1000.0
        } else {
            0.0
        };

        let out = if self.strike > 0.0 && t_sec > 0.0 && price > 0.0 {
            fv_calc(price, self.strike, t_sec, self.vol_pts, self.s.model)
        } else {
            // window closed / no strike: FV undefined → 50¢, no flags
            FvOut { value: 50.0, z: 0.0, sd: 0.0, slope: 0.0 }
        };

        self.fv_up = out.value;
        let fv_up_c = out.value.round().clamp(1.0, 99.0) as u16;
        let fv_dn_c = 100 - fv_up_c;

        // history + jump (per window)
        if self.strike > 0.0 && t_sec > 0.0 && price > 0.0 {
            self.push_hist(now, fv_up_c);
        }
        self.jump = self.jump5s(now);

        // ── fold PM cells → edges & flags ────────────────────────────────
        let up_cell = QuoteCell(self.up_cell_v);
        let dn_cell = QuoteCell(self.dn_cell_v);
        let up_age = up_cell.age_ms(now);
        let dn_age = dn_cell.age_ms(now);
        // freshness budget: 16-bit ts disambiguates to 32.7s; clamp the
        // user setting into that guarantee
        let max_age = self.s.max_book_age_ms.min(30_000) as u16;
        let up_fresh = up_cell.flags() & xarb_hft::hot::QF_VALID != 0 && up_age <= max_age;
        let dn_fresh = dn_cell.flags() & xarb_hft::hot::QF_VALID != 0 && dn_age <= max_age;

        let ask_up = up_cell.ask_opt();
        let ask_dn = dn_cell.ask_opt();
        let edge_up = ask_up.map(|a| out.value - a as f64);
        let edge_dn = ask_dn.map(|a| fv_dn_c as f64 - a as f64);
        let fv_dn_value = fv_dn_c as f64;

        // ── flags ────────────────────────────────────────────────────────
        let mut flags: u16 = 0;
        let win_open = self.strike > 0.0 && t_sec > 0.0;
        if win_open {
            flags |= FLAG_WIN_OPEN;
        }
        if self.last_ev_ms > 0 && now.saturating_sub(self.last_ev_ms) < BIN_STALE_MS {
            flags |= FLAG_BIN_ALIVE;
        }
        if up_fresh || dn_fresh {
            flags |= FLAG_PM_ALIVE;
        }
        if t_sec >= self.s.min_secs_left {
            flags |= FLAG_MIN_SECS_OK;
        }
        let jump_c = self.jump;
        if win_open && jump_c >= self.s.jump_thresh_c {
            flags |= FLAG_TRIG_JUMP_UP;
        }
        if win_open && jump_c <= -self.s.jump_thresh_c {
            flags |= FLAG_TRIG_JUMP_DN;
        }
        if win_open && out.value > self.s.fv_floor_c {
            flags |= FLAG_TRIG_FLOOR_UP;
        }
        if win_open && fv_dn_value > self.s.fv_floor_c {
            flags |= FLAG_TRIG_FLOOR_DN;
        }
        if win_open && up_fresh && edge_up.map(|e| e >= self.s.edge_thresh_c).unwrap_or(false) {
            flags |= FLAG_TRIG_EDGE_UP;
        }
        if win_open && dn_fresh && edge_dn.map(|e| e >= self.s.edge_thresh_c).unwrap_or(false) {
            flags |= FLAG_TRIG_EDGE_DN;
        }
        if kill {
            flags |= FLAG_KILL;
        }
        if self.s.auto_trade && running {
            flags |= FLAG_AUTOTRADE;
        }
        // DOWN side disabled by settings → mask the DOWN fire mask
        if !self.s.trade_down {
            flags &= !FLAG_TRIG_JUMP_DN & !FLAG_TRIG_FLOOR_DN & !FLAG_TRIG_EDGE_DN;
        }

        let jump_i16 = jump_c.clamp(-32_000.0, 32_000.0) as i16;
        let word = HotWord::pack(fv_up_c, fv_dn_c, jump_i16, flags);
        let full = FvFull {
            t_ms: now,
            price,
            bid: self.bid,
            ask: self.ask,
            vol_pts: self.vol_pts,
            fv_up: out.value,
            fv_down: fv_dn_value,
            z: out.z,
            sd: out.sd,
            slope: out.slope,
            jump_up: jump_c,
            edge_up,
            edge_down: edge_dn,
            ask_up: ask_up.map(|a| a as f64),
            ask_down: ask_dn.map(|a| a as f64),
            tau_s: t_sec,
            strike: self.strike,
            window_end: self.end_ms / 1000,
            ticks: self.ticks,
            ticks_per_min: self.ticks_per_min,
            feed_lag_ms: self.lag_ewma_ms,
        };

        (word, full)
    }
}

/// Shared hot state between the FV thread and everyone else.
pub struct HotShared {
    /// Packed HotWord — written by the FV thread (Release), read by the
    /// strategy thread (Acquire) and the cold path.
    pub word: CachePadded<AtomicU64>,
    /// mono-ns timestamp of the last word store (detect-latency base).
    pub word_t: CachePadded<AtomicU64>,
    /// Rich FV state (ArcSwap, ≥20ms publishes).
    pub full: Arc<ArcSwap<FvFull>>,
    /// Window cells: strike f64-bits, end-ms, generation (bumped last).
    pub win_strike: CachePadded<AtomicU64>,
    pub win_end_ms: CachePadded<AtomicU64>,
    pub win_gen: CachePadded<AtomicU64>,
}

impl HotShared {
    pub fn new() -> Self {
        HotShared {
            word: CachePadded::new(AtomicU64::new(0)),
            word_t: CachePadded::new(AtomicU64::new(0)),
            full: Arc::new(ArcSwap::from_pointee(FvFull::default())),
            win_strike: CachePadded::new(AtomicU64::new(0)),
            win_end_ms: CachePadded::new(AtomicU64::new(0)),
            win_gen: CachePadded::new(AtomicU64::new(0)),
        }
    }

    /// Read the packed hot word.
    pub fn word_v(&self) -> HotWord {
        HotWord(self.word.load(Ordering::Acquire))
    }

    /// Read the current window (gen-first lock-free snapshot).
    pub fn window(&self) -> (f64, u64, u64) {
        let gen = self.win_gen.load(Ordering::Acquire);
        let strike = f64::from_bits(self.win_strike.load(Ordering::Acquire));
        let end = self.win_end_ms.load(Ordering::Acquire);
        (strike, end, gen)
    }
}

/// Spawn the FV engine thread. `strat_wake` is armed by the engine after
/// the strategy thread spawns (slot semantics — no spawn-order cycle).
pub fn spawn_fv(
    ring: Arc<SpscRing<Ev>>,
    hot: Arc<HotShared>,
    pm: Arc<PmOut>,
    risk: Arc<crate::state::RiskState>,
    settings: Arc<ArcSwap<Settings>>,
    settings_gen: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
    lat: Arc<LatencyStats>,
    strat_wake: Arc<WakeSlot>,
    mode: SpinMode,
    pin: Option<usize>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("fv-engine".into())
        .spawn(move || {
            if let Some(c) = pin {
                let _ = xarb_hft::affinity::pin_current(c);
            }
            let mut core = FvCore::new(now_ms());
            let mut last_word: u64 = 0;
            let mut last_publish_ms: u64 = 0;
            let mut s_gen_seen: u64 = 0;
            let mut win_gen_seen: u64 = 0;
            let mut batch = [Ev::Quote { bid: 0.0, ask: 0.0 }; 256];
            let parker = xarb_hft::Parker::new(Duration::from_millis(1));
            let mut spin_budget_left: u64 = 0;
            let mut last_rec_ms: u64 = 0;

            loop {
                let mut activity = false;

                // 1. drain the Binance ring (batched)
                loop {
                    let n = ring.pop_batch(&mut batch);
                    if n == 0 {
                        break;
                    }
                    let now = now_ms();
                    for ev in &batch[..n] {
                        core.on_ev(*ev, now);
                        if let Ev::Trade { t_ms, .. } = ev {
                            let lag = now.saturating_sub(*t_ms);
                            if lag > 0 && lag < 5_000 {
                                lat.feed_lag.record(lag as u64 * 1_000_000);
                            }
                        }
                    }
                    activity = true;
                }

                // 2. fold PM cells (cheap: two atomic loads, done every pass)
                core.fold_pm(pm.up_cell_v(), pm.down_cell_v());

                // 3. refresh settings on generation bump
                let g = settings_gen.load(Ordering::Acquire);
                if g != s_gen_seen {
                    core.reload_settings(&settings.load_full(), g);
                    s_gen_seen = g;
                }

                // 4. window rollover (gen-first)
                let (strike, end_ms, wgen) = hot.window();
                if wgen != win_gen_seen {
                    core.set_window(strike, end_ms);
                    win_gen_seen = wgen;
                    last_word = 0; // force a fresh word publish
                }

                // 5. recompute on activity or 1ms time decay
                let now = now_ms();
                if activity || now != last_rec_ms {
                    let t0 = std::time::Instant::now();
                    let running_v = running.load(Ordering::Relaxed);
                    let kill_v = risk.kill.load(Ordering::Relaxed);
                    let (word, full) = core.recompute(now, running_v, kill_v);
                    lat.fv.record(t0.elapsed().as_nanos() as u64);

                    if word.0 != last_word {
                        hot.word_t.store(mono_ns(), Ordering::Release);
                        hot.word.store(word.0, Ordering::Release);
                        last_word = word.0;
                        strat_wake.wake();
                    }
                    if now.saturating_sub(last_publish_ms) >= FV_PUSH_MS {
                        hot.full.store(Arc::new(full));
                        last_publish_ms = now;
                    }
                    last_rec_ms = now;
                }

                // 6. power policy
                match mode {
                    SpinMode::Spin => {
                        if !activity {
                            std::hint::spin_loop();
                        }
                    }
                    SpinMode::Hybrid => {
                        if activity {
                            spin_budget_left = 5_000;
                            std::hint::spin_loop();
                        } else if spin_budget_left > 0 {
                            spin_budget_left -= 1;
                            std::hint::spin_loop();
                        } else {
                            parker.park(); // 1ms timeout
                            spin_budget_left = 5_000;
                        }
                    }
                    SpinMode::Eco => {
                        if !activity {
                            parker.park(); // 1ms timeout, or producer unpark
                        } else {
                            std::hint::spin_loop();
                        }
                    }
                }
            }
        })
        .expect("spawn fv thread")
}
