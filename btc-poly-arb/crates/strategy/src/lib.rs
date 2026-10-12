//! strategy — pure decision logic, zero allocation, zero I/O.
//!
//! Encodes the tweet's one-liner:
//! > when to buy, at what price and how fast.
//! > if [fair value] jumps 20c+ within 5 seconds and goes over 60c,
//! > while Polymarket is still selling the share 10c+ cheaper, you buy.
//!
//! Symmetric DOWN leg: if FV(UP) *drops* 20c+ within 5s and FV(DOWN) > 60c
//! while DOWN asks 10c+ below FV(DOWN), buy DOWN.
//!
//! `Strategy::evaluate` is called by the engine thread on every mark/book
//! update. It is branch-light and finishes in ~50-150 ns (measured in the
//! bench harness) so evaluation cost never delays the fire path.

use core::f64::consts::SQRT_2;

/// Decision thresholds (tweet defaults).
#[derive(Clone, Copy, Debug)]
pub struct StrategyCfg {
    /// minimum FV move over the jump window (dollars; 0.20 = "20c+")
    pub jump_c: f64,
    /// FV must clear this ("goes over 60c")
    pub fv_gate: f64,
    /// PM ask must be at least this far below FV ("10c+ cheaper")
    pub edge_c: f64,
    /// lookback for the jump (seconds)
    pub jump_window_s: f64,
    /// trade the symmetric DOWN leg too
    pub trade_down: bool,
    /// refuse entries with less than this much time left (settlement race)
    pub min_tau_s: f64,
}

impl Default for StrategyCfg {
    fn default() -> Self {
        StrategyCfg {
            jump_c: 0.20,
            fv_gate: 0.60,
            edge_c: 0.10,
            jump_window_s: 5.0,
            trade_down: true,
            min_tau_s: 10.0,
        }
    }
}

/// Everything the strategy needs to decide, in one flat Copy view.
#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
    pub t_ns: i64,
    /// seconds to window close
    pub tau_s: f64,
    /// FV(UP) 0..1
    pub fv_up: f64,
    /// best ask on the UP token, 0..1 (0.0 = no ask / empty book)
    pub up_ask: f64,
    pub up_ask_sz: f64,
    /// best ask on the DOWN token, 0..1 (0.0 = none)
    pub down_ask: f64,
    pub down_ask_sz: f64,
}

/// Reject reasons, index-mapped into `wire::DashState.rejects`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Reject {
    /// no live window installed
    NoWindow = 0,
    /// too close to window close
    Tau = 1,
    /// FV below the momentum gate
    Gate = 2,
    /// FV jump under threshold (or wrong direction)
    Jump = 3,
    /// spread vs PM ask under the edge threshold
    Edge = 4,
    /// cooldown active or an order already in flight
    Busy = 5,
    /// position/risk caps (max pos, daily loss, balance)
    Risk = 6,
    /// no executable ask (empty book, size < min, stale feed)
    NoAsk = 7,
}

/// Risk view — owned by the engine, copied into the call.
#[derive(Clone, Copy, Debug, Default)]
pub struct RiskView {
    /// ns when cooldown expires (last fill/ack + cooldown)
    pub cooldown_until_ns: i64,
    /// orders currently in flight
    pub in_flight: u8,
    /// trades already fired in this window
    pub trades_this_window: u32,
    /// hard cap per window
    pub max_trades_per_window: u32,
    /// open position (shares) in the candidate direction
    pub pos_dir_sh: f64,
    /// maximum position allowed in one direction
    pub max_pos_sh: f64,
    /// daily loss stop tripped
    pub loss_stopped: bool,
    /// feed staleness (ns since last binance mark; i64::MAX = no data)
    pub binance_age_ns: i64,
    /// max allowed staleness
    pub stale_ns: i64,
    /// global kill switch
    pub kill: bool,
}

/// A fire signal — everything the executor needs.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Signal {
    pub t_ns: i64,
    /// 0 = buy UP, 1 = buy DOWN
    pub dir: u8,
    /// FV of the bought share at signal time
    pub fv: f64,
    /// best ask at signal time
    pub ask: f64,
    pub ask_sz: f64,
    /// fv - ask
    pub edge: f64,
    /// 5s FV jump of the bought share
    pub jump: f64,
}

/// Rolling FV history for the 5-second jump measurement.
///
/// Fixed 2048-slot ring. `Strategy::observe_fv` downsamples to ~10 ms
/// spacing (with an exception for large moves), so 2048 slots cover >20 s
/// of history — enough for the 5 s window at any feed rate, including
/// 50k events/s benchmark storms.
pub struct FvWindow {
    buf: [(i64, f64); 2048],
    head: usize,
    len: usize,
    window_ns: i64,
    last_t_ns: i64,
    last_fv: f64,
}

impl FvWindow {
    pub fn new(window_s: f64) -> Self {
        FvWindow {
            buf: [(0, 0.0); 2048],
            head: 0,
            len: 0,
            window_ns: (window_s * 1e9) as i64,
            last_t_ns: 0,
            last_fv: 0.5,
        }
    }

    /// Downsampled push: keep ~10ms spacing, but always record moves of
    /// >= 5c (a real jump must never be smoothed away).
    #[inline]
    pub fn push_sampled(&mut self, t_ns: i64, fv: f64) {
        const MIN_SPACING_NS: i64 = 10_000_000;
        const BIG_MOVE: f64 = 0.05;
        if self.len > 0
            && t_ns - self.last_t_ns < MIN_SPACING_NS
            && (fv - self.last_fv).abs() < BIG_MOVE
        {
            // intra-sample noise: track but do not store
            self.last_fv = fv;
            return;
        }
        self.push(t_ns, fv);
    }

    #[inline]
    pub fn push(&mut self, t_ns: i64, fv: f64) {
        self.buf[self.head] = (t_ns, fv);
        self.head = (self.head + 1) & 2047;
        if self.len < 2048 {
            self.len += 1;
        }
        self.last_t_ns = t_ns;
        self.last_fv = fv;
        // retire entries older than the window (amortized O(1): drop oldest)
        while self.len > 1 {
            let oldest = (self.head.wrapping_sub(self.len)) & 2047;
            if t_ns - self.buf[oldest].0 > self.window_ns * 2 {
                self.len -= 1;
            } else {
                break;
            }
        }
    }

    /// FV as of (or just before) `t_ns`; `None` if no sample that old.
    #[inline]
    pub fn fv_at(&self, t_ns: i64) -> Option<f64> {
        if self.len == 0 {
            return None;
        }
        // scan backwards for the newest sample with t <= t_ns
        for k in 1..=self.len {
            let idx = (self.head.wrapping_sub(k)) & 2047;
            let (t, v) = self.buf[idx];
            if t <= t_ns {
                return Some(v);
            }
        }
        None
    }

    /// The jump over the configured window ending `now`:
    /// `fv(now) - fv(now - window)`.
    #[inline]
    pub fn jump(&self, now_ns: i64) -> Option<f64> {
        let cur = self.fv_at(now_ns)?;
        let then = self.fv_at(now_ns - self.window_ns)?;
        Some(cur - then)
    }
}

/// The stateful strategy: jump window + last-fire bookkeeping.
pub struct Strategy {
    pub cfg: StrategyCfg,
    window: FvWindow,
}

impl Strategy {
    pub fn new(cfg: StrategyCfg) -> Self {
        let w = cfg.jump_window_s;
        Strategy {
            cfg,
            // FvWindow retains 2x window internally; lookup uses exact window
            window: FvWindow::new(w),
        }
    }

    /// Record each FV update (called by the engine on every mark change).
    /// Downsampled: the jump detector only needs ~10 ms granularity.
    #[inline]
    pub fn observe_fv(&mut self, t_ns: i64, fv_up: f64) {
        self.window.push_sampled(t_ns, fv_up);
    }

    /// Jump over the window ending `now` (read-only, for dashboards).
    #[inline]
    pub fn jump_now(&self, now_ns: i64) -> Option<f64> {
        self.window.jump(now_ns)
    }

    /// FV as of a past time (read-only).
    #[inline]
    pub fn fv_then(&self, t_ns: i64) -> Option<f64> {
        self.window.fv_at(t_ns)
    }

    /// Decide. `Ok(signal)` = fire now.
    #[inline]
    pub fn evaluate(&self, snap: &Snapshot, risk: &RiskView) -> Result<Signal, Reject> {
        if risk.kill {
            return Err(Reject::Risk);
        }
        if snap.tau_s <= 0.0 {
            return Err(Reject::NoWindow);
        }
        if snap.tau_s < self.cfg.min_tau_s {
            return Err(Reject::Tau);
        }
        if risk.loss_stopped {
            return Err(Reject::Risk);
        }
        if risk.in_flight > 0
            || snap.t_ns < risk.cooldown_until_ns
            || risk.trades_this_window >= risk.max_trades_per_window
        {
            return Err(Reject::Busy);
        }
        if risk.binance_age_ns > risk.stale_ns {
            return Err(Reject::NoAsk);
        }

        let jump_up = self.window.jump(snap.t_ns).unwrap_or(0.0);
        let fv_dn = 1.0 - snap.fv_up;

        // ---- UP leg ----------------------------------------------------
        let up_entry = |jump: f64| -> Option<Signal> {
            if jump < self.cfg.jump_c {
                return None;
            }
            if snap.fv_up < self.cfg.fv_gate {
                return None;
            }
            if snap.up_ask <= 0.0 {
                return None;
            }
            let edge = snap.fv_up - snap.up_ask;
            if edge < self.cfg.edge_c {
                return None;
            }
            Some(Signal {
                t_ns: snap.t_ns,
                dir: 0,
                fv: snap.fv_up,
                ask: snap.up_ask,
                ask_sz: snap.up_ask_sz,
                edge,
                jump,
            })
        };

        if risk.pos_dir_sh < risk.max_pos_sh {
            if let Some(sig) = up_entry(jump_up) {
                return Ok(sig);
            }
        }

        // ---- DOWN leg --------------------------------------------------
        if self.cfg.trade_down {
            let jump_dn = -jump_up;
            if risk.pos_dir_sh < risk.max_pos_sh {
                if jump_dn >= self.cfg.jump_c
                    && fv_dn >= self.cfg.fv_gate
                    && snap.down_ask > 0.0
                {
                    let edge = fv_dn - snap.down_ask;
                    if edge >= self.cfg.edge_c {
                        return Ok(Signal {
                            t_ns: snap.t_ns,
                            dir: 1,
                            fv: fv_dn,
                            ask: snap.down_ask,
                            ask_sz: snap.down_ask_sz,
                            edge,
                            jump: jump_dn,
                        });
                    }
                    return Err(Reject::Edge);
                }
                if jump_dn >= self.cfg.jump_c && fv_dn >= self.cfg.fv_gate {
                    return Err(Reject::Edge);
                }
            }
        }

        // classify the dominant near-miss for the telemetry counters
        if jump_up >= self.cfg.jump_c && snap.fv_up >= self.cfg.fv_gate {
            if snap.up_ask <= 0.0 {
                return Err(Reject::NoAsk);
            }
            return Err(Reject::Edge);
        }
        if jump_up >= self.cfg.jump_c {
            return Err(Reject::Gate);
        }
        Err(Reject::Jump)
    }
}

/// Convert a normal quantile to a probability (helper for dashboards/tests).
#[inline]
pub fn phi(z: f64) -> f64 {
    0.5 * (1.0 + erf_approx(z / SQRT_2))
}

// tiny local erf to keep this crate dependency-free (tests use it lightly)
#[inline]
fn erf_approx(x: f64) -> f64 {
    // A&S 7.1.26 (same constants as the pricing crate)
    if x == 0.0 {
        return 0.0;
    }
    let s = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    if x > 4.0 {
        return s;
    }
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t
            + 0.254_829_592)
            * t
            * (-x * x).exp();
    s * y
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(t_ns: i64, tau: f64, fv: f64, up_ask: f64, dn_ask: f64) -> Snapshot {
        Snapshot {
            t_ns,
            tau_s: tau,
            fv_up: fv,
            up_ask,
            up_ask_sz: 500.0,
            down_ask: dn_ask,
            down_ask_sz: 500.0,
        }
    }

    fn risk_ok(now_ns: i64) -> RiskView {
        RiskView {
            cooldown_until_ns: 0,
            in_flight: 0,
            trades_this_window: 0,
            max_trades_per_window: 2,
            pos_dir_sh: 0.0,
            max_pos_sh: 200.0,
            loss_stopped: false,
            binance_age_ns: 10_000_000, // 10ms
            stale_ns: 400_000_000,
            kill: false,
        }
    }

    fn seeded(cfg: StrategyCfg, points: &[(i64, f64)]) -> Strategy {
        let mut s = Strategy::new(cfg);
        for (t, fv) in points {
            s.observe_fv(*t, *fv);
        }
        s
    }

    fn tweet_points() -> Vec<(i64, f64)> {
        // 83,215 -> 83,330 over 5 seconds, 2 minutes left, K = 83,200:
        // BS digital at sigma 1.3e-4/s gives fv 0.55 -> 0.86
        let t0 = 10_000_000_000i64;
        let mut pts = Vec::new();
        // warm the window so jump_at(t0+5s) has a 5s-old reference
        for k in 0..10 {
            let t = t0 - 6_000_000_000 + k * 600_000_000;
            pts.push((t, 0.549));
        }
        pts.push((t0, 0.549));
        pts.push((t0 + 1_000_000_000, 0.561));
        pts.push((t0 + 2_000_000_000, 0.583));
        pts.push((t0 + 3_000_000_000, 0.640));
        pts.push((t0 + 4_000_000_000, 0.702));
        pts.push((t0 + 5_000_000_000, 0.862));
        pts
    }

    #[test]
    fn fires_on_tweet_scenario() {
        let cfg = StrategyCfg::default();
        let pts = tweet_points();
        let s = seeded(cfg, &pts);
        let last = pts.last().unwrap().0;
        // PM still selling UP at 56c while FV says 86c
        let snap = snap(last, 120.0, 0.862, 0.56, 0.90);
        let sig = s.evaluate(&snap, &risk_ok(last)).expect("must fire");
        assert_eq!(sig.dir, 0);
        assert!((sig.edge - 0.302).abs() < 1e-9);
        assert!(sig.jump > 0.20);
        assert_eq!(sig.ask, 0.56);
    }

    #[test]
    fn no_fire_without_edge() {
        let pts = tweet_points();
        let s = seeded(StrategyCfg::default(), &pts);
        let last = pts.last().unwrap().0;
        // PM ask only 5c cheaper -> reject Edge
        let snap = snap(last, 120.0, 0.862, 0.82, 0.90);
        assert_eq!(s.evaluate(&snap, &risk_ok(last)), Err(Reject::Edge));
    }

    #[test]
    fn no_fire_under_gate() {
        let cfg = StrategyCfg::default();
        let t = 5_000_000_000i64;
        // jump 20c clears the jump threshold but fv 58c < 60c gate
        let pts = vec![(0, 0.37), (t - 5_000_000_000, 0.37), (t, 0.58)];
        let s = seeded(cfg, &pts);
        let snap = snap(t, 120.0, 0.58, 0.40, 0.90);
        assert_eq!(s.evaluate(&snap, &risk_ok(t)), Err(Reject::Gate));
    }

    #[test]
    fn no_fire_small_jump() {
        let t = 5_000_000_000i64;
        let pts = vec![(0, 0.62), (t - 5_000_000_000, 0.62), (t, 0.68)]; // 6c jump
        let s = seeded(StrategyCfg::default(), &pts);
        let snap = snap(t, 120.0, 0.68, 0.50, 0.90);
        assert_eq!(s.evaluate(&snap, &risk_ok(t)), Err(Reject::Jump));
    }

    #[test]
    fn fires_down_leg_symmetric() {
        let t = 5_000_000_000i64;
        // fv_up collapses 0.62 -> 0.35 (jump 27c), so fv_dn 0.65 over gate
        let pts = vec![
            (0, 0.62),
            (t - 5_000_000_000, 0.62),
            (t - 2_000_000_000, 0.55),
            (t, 0.35),
        ];
        let s = seeded(StrategyCfg::default(), &pts);
        // DOWN asks 48c while FV(DOWN) = 65c -> 17c edge
        let snap = snap(t, 120.0, 0.35, 0.70, 0.48);
        let sig = s.evaluate(&snap, &risk_ok(t)).expect("down leg must fire");
        assert_eq!(sig.dir, 1);
        assert!((sig.edge - 0.17).abs() < 1e-9);
    }

    #[test]
    fn cooldown_blocks() {
        let pts = tweet_points();
        let s = seeded(StrategyCfg::default(), &pts);
        let last = pts.last().unwrap().0;
        let mut rv = risk_ok(last);
        rv.cooldown_until_ns = last + 1_000_000_000;
        let snap = snap(last, 120.0, 0.862, 0.56, 0.90);
        assert_eq!(s.evaluate(&snap, &rv), Err(Reject::Busy));
    }

    #[test]
    fn in_flight_blocks() {
        let pts = tweet_points();
        let s = seeded(StrategyCfg::default(), &pts);
        let last = pts.last().unwrap().0;
        let mut rv = risk_ok(last);
        rv.in_flight = 1;
        let snap = snap(last, 120.0, 0.862, 0.56, 0.90);
        assert_eq!(s.evaluate(&snap, &rv), Err(Reject::Busy));
    }

    #[test]
    fn late_tau_blocks() {
        let pts = tweet_points();
        let s = seeded(StrategyCfg::default(), &pts);
        let last = pts.last().unwrap().0;
        let snap = snap(last, 5.0, 0.862, 0.56, 0.90); // 5s left < min_tau 10s
        assert_eq!(s.evaluate(&snap, &risk_ok(last)), Err(Reject::Tau));
    }

    #[test]
    fn max_pos_blocks() {
        let pts = tweet_points();
        let s = seeded(StrategyCfg::default(), &pts);
        let last = pts.last().unwrap().0;
        let mut rv = risk_ok(last);
        rv.pos_dir_sh = 200.0;
        let snap = snap(last, 120.0, 0.862, 0.56, 0.90);
        // UP blocked by position; DOWN blocked because fv_dn < gate
        let r = s.evaluate(&snap, &rv);
        assert!(r.is_err());
    }

    #[test]
    fn stale_feed_blocks() {
        let pts = tweet_points();
        let s = seeded(StrategyCfg::default(), &pts);
        let last = pts.last().unwrap().0;
        let mut rv = risk_ok(last);
        rv.binance_age_ns = 900_000_000;
        let snap = snap(last, 120.0, 0.862, 0.56, 0.90);
        assert_eq!(s.evaluate(&snap, &rv), Err(Reject::NoAsk));
    }

    #[test]
    fn fv_window_reference_semantics() {
        let mut w = FvWindow::new(5.0);
        let t0 = 1_000_000_000i64;
        w.push(t0, 0.40);
        w.push(t0 + 5_000_000_000, 0.75);
        assert_eq!(w.fv_at(t0), Some(0.40));
        assert_eq!(w.fv_at(t0 + 5_000_000_000), Some(0.75));
        assert_eq!(w.fv_at(t0 + 2_000_000_000), Some(0.40));
        assert_eq!(w.jump(t0 + 5_000_000_000), Some(0.35));
    }
}
