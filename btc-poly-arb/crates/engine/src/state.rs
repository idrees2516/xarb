//! Engine state: books, marks, vol, positions, and the DashState publisher.

use hotcore::clock::Clock;
use hotcore::hist::Hist;
use pricing::EwmaVol;
use strategy::{RiskView, Snapshot, Strategy};
use wire::*;

/// Fixed-capacity price-level book (cents), allocation-free.
#[derive(Clone, Copy)]
pub struct LevelBook {
    pub bid: [Level; 64],
    pub bid_n: u8,
    pub ask: [Level; 64],
    pub ask_n: u8,
    pub last_ts_ns: i64,
    pub overflow_drops: u32,
}

#[derive(Clone, Copy, Default)]
pub struct Level {
    pub price_c: i64,
    pub size: f64,
}

impl LevelBook {
    pub const fn new() -> Self {
        LevelBook {
            bid: [Level { price_c: 0, size: 0.0 }; 64],
            bid_n: 0,
            ask: [Level { price_c: 0, size: 0.0 }; 64],
            ask_n: 0,
            last_ts_ns: 0,
            overflow_drops: 0,
        }
    }

    pub fn reset(&mut self, t_ns: i64) {
        self.bid_n = 0;
        self.ask_n = 0;
        self.last_ts_ns = t_ns;
    }

    /// Apply one level update; size 0 removes the level.
    pub fn apply(&mut self, side: u8, price_c: i64, size: f64, t_ns: i64) {
        self.last_ts_ns = t_ns;
        let (levels, n) = if side == SIDE_BID {
            (&mut self.bid, &mut self.bid_n)
        } else {
            (&mut self.ask, &mut self.ask_n)
        };
        // find the level
        for i in 0..(*n as usize) {
            if levels[i].price_c == price_c {
                if size <= 0.0 {
                    // remove (swap with last)
                    levels[i] = levels[*n as usize - 1];
                    *n -= 1;
                } else {
                    levels[i].size = size;
                }
                return;
            }
        }
        if size <= 0.0 {
            return; // removal of nonexistent level
        }
        if *n as usize >= 64 {
            self.overflow_drops += 1;
            return;
        }
        levels[*n as usize] = Level { price_c, size };
        *n += 1;
    }

    #[inline]
    pub fn best_bid(&self) -> Option<Level> {
        let mut best: Option<Level> = None;
        for i in 0..self.bid_n as usize {
            let l = self.bid[i];
            if l.size > 0.0 && best.map(|b| l.price_c > b.price_c).unwrap_or(true) {
                best = Some(l);
            }
        }
        best
    }

    #[inline]
    pub fn best_ask(&self) -> Option<Level> {
        let mut best: Option<Level> = None;
        for i in 0..self.ask_n as usize {
            let l = self.ask[i];
            if l.size > 0.0 && best.map(|b| l.price_c < b.price_c).unwrap_or(true) {
                best = Some(l);
            }
        }
        best
    }

    pub fn mid(&self) -> f64 {
        match (self.best_bid(), self.best_ask()) {
            (Some(b), Some(a)) => (b.price_c + a.price_c) as f64 / 200.0,
            (Some(b), None) => b.price_c as f64 / 100.0,
            (None, Some(a)) => a.price_c as f64 / 100.0,
            _ => 0.0,
        }
    }
}

/// Position and PnL per direction.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pos {
    pub up_sh: f64,
    pub dn_sh: f64,
    pub avg_up: f64, // avg cost in cents
    pub avg_dn: f64,
    pub realized_c: f64,
}

impl Pos {
    pub fn add_fill(&mut self, dir: u8, sh: f64, px_c: f64) {
        if dir == DIR_UP {
            let total = self.up_sh + sh;
            self.avg_up = if total > 0.0 {
                (self.avg_up * self.up_sh + px_c * sh) / total
            } else {
                px_c
            };
            self.up_sh = total;
        } else {
            let total = self.dn_sh + sh;
            self.avg_dn = if total > 0.0 {
                (self.avg_dn * self.dn_sh + px_c * sh) / total
            } else {
                px_c
            };
            self.dn_sh = total;
        }
    }

    /// Settle at resolution (payout in dollars per share: 1 or 0).
    pub fn settle(&mut self, dir: u8, payout: f64) -> f64 {
        let (sh, avg) = if dir == DIR_UP {
            (self.up_sh, self.avg_up)
        } else {
            (self.dn_sh, self.avg_dn)
        };
        if sh <= 0.0 {
            return 0.0;
        }
        let pnl_c = sh * (payout * 100.0 - avg);
        self.realized_c += pnl_c;
        if dir == DIR_UP {
            self.up_sh = 0.0;
            self.avg_up = 0.0;
        } else {
            self.dn_sh = 0.0;
            self.avg_dn = 0.0;
        }
        pnl_c
    }
}

/// The complete engine core. One thread owns this; methods are synchronous
/// and allocation-free (except telemetry strings, which never run here).
pub struct EngineCore {
    pub cfg: crate::config::AppConfig,
    pub clock: &'static Clock,
    pub strategy: Strategy,
    pub vol: EwmaVol,
    pub window: WindowCtx,
    pub phase: u8,
    pub books: [LevelBook; 2],
    pub pos: Pos,
    pub mark: f64,
    pub mark_ts_ns: i64,
    pub bb: (f64, f64, f64, f64), // bid, bid_sz, ask, ask_sz
    pub fv: pricing::Fv,
    pub model: pricing::Model,
    // risk state
    pub in_flight: u8,
    pub cooldown_until_ns: i64,
    pub fires_this_window: u32,
    pub sigs_this_window: u32,
    pub trades_today: u32,
    pub signals_today: u32,
    pub windows_done: u32,
    pub loss_today_c: f64,
    // telemetry
    pub dash: DashState,
    pub lat: [Hist; LAT_STAGES],
    pub lat_window_n: [u64; LAT_STAGES],
    pub rejects: [u64; 8],
    pub evals: u64,
    pub last_publish_ns: i64,
    pub publish_period_ns: i64,
    pub seq: u64,
    pub settle_done: bool,
    /// order produced by the last evaluation, drained by the runner
    pub pending: Option<OrderReq>,
}

impl EngineCore {
    pub fn new(cfg: crate::config::AppConfig) -> EngineCore {
        let strat = Strategy::new(cfg.strategy);
        let vol = EwmaVol::new(cfg.vol_half_life_s, cfg.sigma_floor, cfg.sigma_cap);
        let model = cfg.model();
        let period_ns = (1e9 / cfg.dash_fps.max(1) as f64) as i64;
        let mut dash = DashState::default();
        dash.mode = cfg.mode;
        dash.cfg_jump = cfg.strategy.jump_c;
        dash.cfg_gate = cfg.strategy.fv_gate;
        dash.cfg_edge = cfg.strategy.edge_c;
        dash.cfg_size_sh = cfg.size_sh;
        dash.cfg_max_pos = cfg.max_pos_sh;
        dash.cfg_min_tau = cfg.strategy.min_tau_s;
        dash.cfg_cooldown = cfg.cooldown_s;
        dash.cfg_model = if cfg.use_empirical_model { 1 } else { 0 };
        dash.cfg_trade_down = cfg.strategy.trade_down;
        EngineCore {
            strategy: strat,
            vol,
            model,
            window: WindowCtx::default(),
            phase: PHASE_NONE,
            books: [LevelBook::new(), LevelBook::new()],
            pos: Pos::default(),
            mark: 0.0,
            mark_ts_ns: 0,
            bb: (0.0, 0.0, 0.0, 0.0),
            fv: pricing::Fv::default(),
            cfg,
            clock: Clock::global(),
            in_flight: 0,
            cooldown_until_ns: 0,
            fires_this_window: 0,
            sigs_this_window: 0,
            trades_today: 0,
            signals_today: 0,
            windows_done: 0,
            loss_today_c: 0.0,
            dash,
            lat: [Hist::default(); LAT_STAGES],
            lat_window_n: [0; LAT_STAGES],
            rejects: [0; 8],
            evals: 0,
            last_publish_ns: 0,
            publish_period_ns: period_ns,
            seq: 0,
            settle_done: false,
            pending: None,
        }
    }

    /// Take the order produced by the latest evaluation (if any).
    #[inline]
    pub fn take_pending_order(&mut self) -> Option<OrderReq> {
        self.pending.take()
    }

    /// UNIX ns now.
    #[inline]
    pub fn unix_ns(&self) -> i64 {
        self.clock.unix_ns()
    }

    /// FV evaluation (cycles-timed).
    #[inline]
    pub fn compute_fv(&mut self, t_ns: i64) {
        let k = self.window.strike;
        let tau = ((self.window.end_ms * 1_000_000 - self.unix_ns()) as f64 / 1e9).max(0.0);
        if k > 0.0 && self.mark > 0.0 {
            let (r, cyc) = hotcore::clock::measure_cycles(|| {
                let sigma = match self.cfg.sigma_mode {
                    1 => self.vol.sigma_per_sec(),
                    2 => self.vol.sigma_per_sec().map(|l| {
                        let f = self.cfg.sigma_fallback;
                        0.5 * (l + f)
                    }),
                    _ => None, // fixed (tweet semantics)
                };
                self.model.eval(self.mark, k, tau, sigma)
            });
            let ns = self.clock.cycles_to_ns(cyc).max(0.0) as u64;
            self.lat[2].record(ns);
            self.fv = r;
            self.strategy.observe_fv(t_ns, r.up);
        }
    }

    /// Build the strategy snapshot from current state.
    pub fn snapshot(&self, t_ns: i64) -> Snapshot {
        let tau = ((self.window.end_ms * 1_000_000 - self.unix_ns()) as f64 / 1e9).max(0.0);
        let up_ask = self.books[TOK_UP as usize].best_ask();
        let dn_ask = self.books[TOK_DOWN as usize].best_ask();
        Snapshot {
            t_ns,
            tau_s: tau,
            fv_up: self.fv.up,
            up_ask: up_ask.map(|l| l.price_c as f64 / 100.0).unwrap_or(0.0),
            up_ask_sz: up_ask.map(|l| l.size).unwrap_or(0.0),
            down_ask: dn_ask.map(|l| l.price_c as f64 / 100.0).unwrap_or(0.0),
            down_ask_sz: dn_ask.map(|l| l.size).unwrap_or(0.0),
        }
    }

    pub fn risk_view(&self) -> RiskView {
        RiskView {
            cooldown_until_ns: self.cooldown_until_ns,
            in_flight: self.in_flight,
            trades_this_window: self.fires_this_window,
            max_trades_per_window: self.cfg.max_trades_per_window,
            pos_dir_sh: 0.0, // set by caller per-direction
            max_pos_sh: self.cfg.max_pos_sh,
            loss_stopped: self.loss_today_c <= -self.cfg.daily_loss_stop_c,
            binance_age_ns: if self.mark_ts_ns == 0 {
                i64::MAX
            } else {
                self.clock.mono_ns() - self.mark_ts_ns
            },
            stale_ns: self.cfg.stale_binance_ms * 1_000_000,
            kill: false, // runner ORs in the kill switch
        }
    }

    // ---- event application ----

    pub fn on_binance_event(&mut self, ev: FeedEvent) {
        match ev {
            FeedEvent::BinanceTrade { t_ns, price, .. } => {
                self.vol.on_trade(t_ns, price);
                if self.cfg.mark_source == 1 {
                    self.mark = price;
                    self.mark_ts_ns = t_ns;
                }
                self.after_mark_change(t_ns);
            }
            FeedEvent::BinanceBook { t_ns, bid, bid_sz, ask, ask_sz, .. } => {
                self.bb = (bid, bid_sz, ask, ask_sz);
                let mark = match self.cfg.mark_source {
                    0 => (bid + ask) / 2.0,
                    1 => self.mark,
                    _ => {
                        // microprice: weight mid by opposing queue imbalance
                        let den = bid_sz + ask_sz;
                        if den > 0.0 {
                            bid + (ask - bid) * (bid_sz / den)
                        } else {
                            (bid + ask) / 2.0
                        }
                    }
                };
                self.mark = mark;
                self.mark_ts_ns = t_ns;
                self.after_mark_change(t_ns);
            }
            _ => {}
        }
    }

    pub fn on_pm_event(&mut self, ev: FeedEvent) {
        match ev {
            FeedEvent::PmReset { t_ns, token } => {
                if token < 2 {
                    self.books[token as usize].reset(t_ns);
                }
            }
            FeedEvent::PmLevel { t_ns, token, side, price_c, size_sh } => {
                if token < 2 {
                    self.books[token as usize].apply(side, price_c, size_sh, t_ns);
                    // re-evaluate after book change (edge may open)
                    if self.phase == PHASE_TRADE {
                        self.evaluate(t_ns);
                    }
                }
            }
            _ => {}
        }
    }

    fn after_mark_change(&mut self, t_ns: i64) {
        // strike capture at window open
        if self.phase != PHASE_NONE && self.window.strike <= 0.0 && self.mark > 0.0 {
            let now_unix = self.unix_ns();
            if now_unix >= self.window.start_ms * 1_000_000 {
                self.window.strike = self.mark;
                self.dash.strike = self.mark;
                tracing::info!(target: "engine", strike = self.mark, "window strike captured");
            }
        }
        self.compute_fv(t_ns);
        if self.phase == PHASE_TRADE {
            self.evaluate(t_ns);
        }
    }

    /// Run the strategy; a produced order lands in `self.pending`.
    pub fn evaluate(&mut self, t_ns: i64) {
        let snap = self.snapshot(t_ns);
        // per-direction position limit
        let mut rv = self.risk_view();
        let dir_pos = if snap.fv_up >= 0.5 { self.pos.up_sh } else { self.pos.dn_sh };
        rv.pos_dir_sh = dir_pos;
        self.evals += 1;
        let (res, cyc) = hotcore::clock::measure_cycles(|| self.strategy.evaluate(&snap, &rv));
        let ns = self.clock.cycles_to_ns(cyc).max(0.0) as u64;
        self.lat[3].record(ns);
        match res {
            Ok(sig) => {
                // tick -> signal end-to-end (event arrival to signal emitted)
                let now_mono = self.clock.mono_ns();
                self.lat[5].record((now_mono - t_ns).max(0) as u64);
                self.seq += 1;
                self.sigs_this_window += 1;
                self.signals_today += 1;
                let limit_c = (sig.ask * 100.0).round() as i64 + self.cfg.max_chase_c;
                let req = OrderReq {
                    seq: self.seq,
                    ts_ns: t_ns,
                    token: if sig.dir == DIR_UP {
                        self.window.token_up
                    } else {
                        self.window.token_down
                    },
                    dir: sig.dir,
                    limit_c: limit_c.min(99),
                    size_sh: self.cfg.size_sh,
                    ask_at_signal_c: (sig.ask * 100.0).round() as i64,
                    ask_sz_at_signal: sig.ask_sz,
                    live: self.cfg.mode == wire::MODE_LIVE,
                    tick_c: self.window.tick_c,
                    neg_risk: self.window.neg_risk,
                    sig_fv: sig.fv,
                    sig_edge: sig.edge,
                };
                // record signal in telemetry ring (wall-clock ns for display)
                let wall_ns = self.clock.unix_ns();
                self.push_sig(SigRec {
                    t_ns: wall_ns,
                    seq: req.seq,
                    dir: sig.dir,
                    fv: sig.fv,
                    ask: sig.ask,
                    edge: sig.edge,
                    jump: sig.jump,
                });
                // in-flight + cooldown immediately (conservative; exec reports acks)
                self.in_flight += 1;
                self.cooldown_until_ns = self.clock.mono_ns()
                    + (self.cfg.cooldown_s * 1e9) as i64;
                self.trades_today += 1;
                self.pending = Some(req);
            }
            Err(rej) => {
                let idx = rej as usize;
                if idx < 8 {
                    self.rejects[idx] += 1;
                }
            }
        };
    }

    // ---- window lifecycle ----

    pub fn install_window(&mut self, w: WindowCtx) {
        // settle any residual position from the previous window
        self.maybe_settle(true);
        self.window = w;
        self.books = [LevelBook::new(), LevelBook::new()];
        self.fires_this_window = 0;
        self.sigs_this_window = 0;
        self.settle_done = false;
        let now = self.unix_ns();
        self.phase = if now < w.start_ms * 1_000_000 {
            PHASE_PRE
        } else {
            PHASE_TRADE
        };
        tracing::info!(target: "engine", seq = w.seq, end_ms = w.end_ms, "window installed");
    }

    pub fn clear_window(&mut self) {
        self.maybe_settle(true);
        self.window = WindowCtx::default();
        self.phase = PHASE_NONE;
    }

    /// Called periodically: rollover + publish telemetry.
    pub fn tick(&mut self) {
        let now_unix = self.unix_ns();
        if self.phase != PHASE_NONE && self.window.is_live() {
            let end_ns = self.window.end_ms * 1_000_000;
            if now_unix >= end_ns {
                // window closed: settle positions
                self.maybe_settle(false);
                self.phase = PHASE_SETTLE;
            } else if self.phase == PHASE_PRE && now_unix >= self.window.start_ms * 1_000_000 {
                self.phase = PHASE_TRADE;
            }
        }
        // dash publishing at fps
        let now_mono = self.clock.mono_ns();
        if now_mono - self.last_publish_ns >= self.publish_period_ns {
            self.last_publish_ns = now_mono;
            self.publish_dash(now_mono);
        }
    }

    fn maybe_settle(&mut self, force: bool) {
        if self.settle_done {
            return;
        }
        let end_ns = self.window.end_ms * 1_000_000;
        let closed = self.unix_ns() >= end_ns;
        if !closed && !force {
            return;
        }
        if self.window.is_live() && (self.pos.up_sh > 0.0 || self.pos.dn_sh > 0.0) {
            // resolution: UP wins if final mark >= strike (approximates the
            // Chainlink TWAP rule with our Binance mark; see README)
            let up_wins = self.mark >= self.window.strike;
            if self.pos.up_sh > 0.0 {
                let pnl = self.pos.settle(DIR_UP, if up_wins { 1.0 } else { 0.0 });
                self.loss_today_c += pnl;
                self.push_win(pnl);
            }
            if self.pos.dn_sh > 0.0 {
                let pnl = self.pos.settle(DIR_DOWN, if up_wins { 0.0 } else { 1.0 });
                self.loss_today_c += pnl;
                self.push_win(pnl);
            }
            tracing::info!(target: "engine", mark = self.mark, strike = self.window.strike, "window settled");
        }
        if self.window.is_live() {
            self.windows_done += 1;
        }
        self.settle_done = true;
        self.fires_this_window = 0;
    }

    // ---- control events ----

    pub fn on_ctl(&mut self, ev: CtlEvent) {
        match ev {
            CtlEvent::InstallWindow(w) => self.install_window(w),
            CtlEvent::ClearWindow { .. } => self.clear_window(),
            CtlEvent::OrderAck { seq, .. } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                self.update_ord(seq, 1, 0.0, 0.0);
            }
            CtlEvent::OrderRejected { seq, .. } => {
                self.in_flight = self.in_flight.saturating_sub(1);
                self.update_ord(seq, 4, 0.0, 0.0);
            }
            CtlEvent::Fill { seq, dir, sh, px_c, .. } => {
                self.pos.add_fill(dir, sh, px_c);
                self.fires_this_window += 1;
                self.update_ord(seq, 2, sh, px_c);
            }
            CtlEvent::FillAttempt { seq, dir, sh, limit_c, ts_ns } => {
                // paper fill: validate against the live book — the cheap
                // level must still exist when our order lands
                let tok = if dir == DIR_UP { TOK_UP } else { TOK_DOWN };
                let ask = self.books[tok as usize].best_ask();
                match ask {
                    Some(a) if a.price_c <= limit_c && a.size > 0.0 => {
                        let fill_sh = sh.min(a.size);
                        let px_c = a.price_c as f64;
                        // consume the level
                        self.on_pm_event(FeedEvent::PmLevel {
                            t_ns: ts_ns,
                            token: tok,
                            side: SIDE_ASK,
                            price_c: a.price_c,
                            size_sh: (a.size - fill_sh).max(0.0),
                        });
                        self.pos.add_fill(dir, fill_sh, px_c);
                        self.fires_this_window += 1;
                        self.update_ord(seq, 2, fill_sh, px_c);
                        tracing::debug!(target: "engine", seq, px = a.price_c, sh = fill_sh, "paper fill");
                    }
                    _ => {
                        // level gone (MM requoted or someone else took it):
                        // adverse selection, the trade missed
                        self.update_ord(seq, 3, 0.0, 0.0);
                        tracing::debug!(target: "engine", seq, "paper fill missed: level gone");
                    }
                }
            }
            CtlEvent::LatencySample { stage, ns } => {
                let s = (stage as usize).min(LAT_STAGES - 1);
                self.lat[s].record(ns);
            }
            CtlEvent::Shutdown => {}
        }
    }

    // ---- telemetry rings inside DashState ----

    /// Rings: head = number of valid entries (oldest at 0, newest last).
    /// When full, the oldest entry is dropped (memmove; entries are small
    /// and pushes are rare).
    fn push_sig(&mut self, s: SigRec) {
        let h = (self.dash.sig_head as usize).min(SIG_RING);
        if h == SIG_RING {
            self.dash.sigs.copy_within(1..SIG_RING, 0);
            self.dash.sigs[SIG_RING - 1] = s;
        } else {
            self.dash.sigs[h] = s;
            self.dash.sig_head = (h + 1) as u32;
        }
    }

    fn push_win(&mut self, pnl_c: f64) {
        let rec = WinRec {
            start_ms: self.window.start_ms,
            pnl_c,
            trades: self.fires_this_window,
            sigs: self.sigs_this_window,
        };
        let h = (self.dash.win_head as usize).min(WIN_RING);
        if h == WIN_RING {
            self.dash.wins.copy_within(1..WIN_RING, 0);
            self.dash.wins[WIN_RING - 1] = rec;
        } else {
            self.dash.wins[h] = rec;
            self.dash.win_head = (h + 1) as u32;
        }
    }

    fn update_ord(&mut self, seq: u64, status: u8, fill_sh: f64, avg_c: f64) {
        let head = (self.dash.ord_head as usize).min(ORD_RING);
        for k in (0..head).rev() {
            if self.dash.ords[k].seq == seq {
                self.dash.ords[k].status = status;
                if fill_sh > 0.0 {
                    self.dash.ords[k].fill_sh = fill_sh;
                    self.dash.ords[k].avg_px_c = avg_c;
                }
                return;
            }
        }
    }

    pub fn push_ord(&mut self, mut o: OrdRec) {
        o.t_ns = self.clock.unix_ns();
        let h = (self.dash.ord_head as usize).min(ORD_RING);
        if h == ORD_RING {
            self.dash.ords.copy_within(1..ORD_RING, 0);
            self.dash.ords[ORD_RING - 1] = o;
        } else {
            self.dash.ords[h] = o;
            self.dash.ord_head = (h + 1) as u32;
        }
    }

    // ---- dash snapshot ----

    pub fn publish_dash(&mut self, now_mono: i64) {
        let tau_s = ((self.window.end_ms * 1_000_000 - self.unix_ns()) as f64 / 1e9).max(0.0);
        let jump = self.strategy.jump_now(now_mono).unwrap_or(0.0);
        let up_sh = self.pos.up_sh;
        let dn_sh = self.pos.dn_sh;
        let up_mid = self.books[TOK_UP as usize].mid();
        let fv_up = self.fv.up;
        let fv_dn = 1.0 - fv_up;
        let avg_up = self.pos.avg_up;
        let avg_dn = self.pos.avg_dn;
        let realized = self.pos.realized_c;
        let unreal = up_sh * (fv_up * 100.0 - avg_up) + dn_sh * (fv_dn * 100.0 - avg_dn);
        let d = &mut self.dash;
        d.t_ns = now_mono;
        d.wall_ms = self.clock.unix_ms();
        d.window_phase = self.phase;
        d.window_seq = self.window.seq;
        d.start_ms = self.window.start_ms;
        d.end_ms = self.window.end_ms;
        d.tau_s = tau_s;
        d.strike = self.window.strike;
        d.mark = self.mark;
        d.bb_bid = self.bb.0;
        d.bb_ask = self.bb.2;
        d.bb_sz_bid = self.bb.1;
        d.bb_sz_ask = self.bb.3;
        d.fv = self.fv.up;
        d.sigma = self.fv.sigma;
        d.delta = self.fv.delta;
        let (up_b, dn_b) = (
            self.books[TOK_UP as usize].best_bid(),
            self.books[TOK_DOWN as usize].best_bid(),
        );
        let (up_a, dn_a) = (
            self.books[TOK_UP as usize].best_ask(),
            self.books[TOK_DOWN as usize].best_ask(),
        );
        d.up_bid = up_b.map(|l| l.price_c as f64 / 100.0).unwrap_or(0.0);
        d.up_bid_sz = up_b.map(|l| l.size).unwrap_or(0.0);
        d.up_ask = up_a.map(|l| l.price_c as f64 / 100.0).unwrap_or(0.0);
        d.up_ask_sz = up_a.map(|l| l.size).unwrap_or(0.0);
        d.dn_bid = dn_b.map(|l| l.price_c as f64 / 100.0).unwrap_or(0.0);
        d.dn_bid_sz = dn_b.map(|l| l.size).unwrap_or(0.0);
        d.dn_ask = dn_a.map(|l| l.price_c as f64 / 100.0).unwrap_or(0.0);
        d.dn_ask_sz = dn_a.map(|l| l.size).unwrap_or(0.0);
        d.up_ask_impl = dn_b.map(|l| 1.0 - l.price_c as f64 / 100.0).unwrap_or(0.0);
        // jump over the 5s window
        d.jump = jump;
        d.fv_5s_ago = d.fv - jump;
        // edges
        d.edge_up = if d.up_ask > 0.0 { d.fv - d.up_ask } else { f64::NAN };
        d.edge_dn = if d.dn_ask > 0.0 { fv_dn - d.dn_ask } else { f64::NAN };
        d.spread_up = if up_mid > 0.0 { d.fv - up_mid } else { f64::NAN };
        // position/pnl
        d.pos_up_sh = up_sh;
        d.pos_dn_sh = dn_sh;
        d.avg_up = avg_up;
        d.avg_dn = avg_dn;
        d.realized_c = realized;
        d.unrealized_c = unreal;
        d.equity_c = realized + unreal;
        d.trades_today = self.trades_today;
        d.signals_today = self.signals_today;
        d.windows_done = self.windows_done;
        d.in_flight = self.in_flight;
        let cd_left = (self.cooldown_until_ns - now_mono) as f64 / 1e9;
        d.cooldown_left_s = cd_left.max(0.0);
        d.feed_bin_age_ms = if self.mark_ts_ns == 0 {
            i64::MAX / 2
        } else {
            (now_mono - self.mark_ts_ns) / 1_000_000
        };
        d.evals = self.evals;
        d.rejects = self.rejects;
        // latency stats
        for i in 0..LAT_STAGES {
            d.lat[i] = wire::LatStats {
                p50_ns: self.lat[i].p50(),
                p99_ns: self.lat[i].p99(),
                max_ns: self.lat[i].max_ns,
                n: self.lat[i].total,
            };
        }
        // chart ring
        let chart_head = d.chart_head;
        let ch = (chart_head as usize).min(CHART_N - 1);
        d.chart_mark[ch] = self.mark;
        d.chart_fv[ch] = fv_up;
        d.chart_ask[ch] = d.up_ask;
        d.chart_head = if chart_head + 1 >= CHART_N as u32 { 0 } else { chart_head + 1 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_book_ops() {
        let mut b = LevelBook::new();
        b.apply(SIDE_BID, 55, 100.0, 1);
        b.apply(SIDE_BID, 54, 80.0, 2);
        b.apply(SIDE_ASK, 58, 90.0, 3);
        b.apply(SIDE_ASK, 59, 150.0, 4);
        assert_eq!(b.best_bid().unwrap().price_c, 55);
        assert_eq!(b.best_ask().unwrap().price_c, 58);
        // update
        b.apply(SIDE_BID, 55, 120.0, 5);
        assert_eq!(b.best_bid().unwrap().size, 120.0);
        // remove
        b.apply(SIDE_BID, 55, 0.0, 6);
        assert_eq!(b.best_bid().unwrap().price_c, 54);
        assert_eq!(b.bid_n, 1);
        // remove nonexistent: no-op
        b.apply(SIDE_ASK, 77, 0.0, 7);
        assert_eq!(b.ask_n, 2);
        assert!((b.mid() - 0.56).abs() < 1e-9);
    }

    #[test]
    fn pos_fill_and_settle() {
        let mut p = Pos::default();
        p.add_fill(DIR_UP, 50.0, 56.0);
        p.add_fill(DIR_UP, 50.0, 60.0);
        assert_eq!(p.up_sh, 100.0);
        assert_eq!(p.avg_up, 58.0);
        let pnl = p.settle(DIR_UP, 1.0);
        assert!((pnl - 4200.0).abs() < 1e-9); // 100 * (100 - 58)
        assert_eq!(p.up_sh, 0.0);
        assert!((p.realized_c - 4200.0).abs() < 1e-9);
        let pnl2 = p.settle(DIR_UP, 1.0);
        assert_eq!(pnl2, 0.0);
    }
}
