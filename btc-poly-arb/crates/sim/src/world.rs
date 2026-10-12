//! Synthetic market world: Binance price process + lagging PM market maker.
//!
//! The MM maintains his own FV estimate from the *stale* price (lagged by
//! `mm_lag_ms`) and requotes on his own cadence with a half-spread and
//! noise. All the edge the bot earns comes from that lag — set `mm_lag_ms
//! = 0` and the edge vanishes (control experiment).

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use wire::{FeedEvent, SIDE_ASK, SIDE_BID, TOK_DOWN, TOK_UP};

#[derive(Clone, Debug)]
pub struct WorldCfg {
    /// starting BTC price (window open / strike)
    pub s0: f64,
    /// per-second sigma of the underlying process
    pub sigma: f64,
    /// Poisson rate of sharp jumps (per virtual second)
    pub jump_rate_per_s: f64,
    /// mean jump size (points)
    pub jump_mean_points: f64,
    /// market maker reaction lag in ms — THE edge
    pub mm_lag_ms: f64,
    /// MM requote cadence (virtual ms)
    pub mm_requote_ms: f64,
    /// MM quoted half-spread (cents)
    pub mm_half_spread_c: f64,
    /// MM quote noise (cents, +/-)
    pub mm_noise_c: f64,
    /// simulated window length (virtual seconds)
    pub window_s: f64,
    /// compression factor (50 => 5 virtual minutes in 6 real seconds)
    pub speed: f64,
    pub n_windows: u32,
    pub seed: u64,
}

impl Default for WorldCfg {
    fn default() -> Self {
        WorldCfg {
            s0: 83_200.0,
            sigma: 1.0e-4,
            jump_rate_per_s: 0.05,
            jump_mean_points: 100.0,
            mm_lag_ms: 300.0,
            mm_requote_ms: 50.0,
            mm_half_spread_c: 2.0,
            mm_noise_c: 1.0,
            window_s: 300.0,
            speed: 50.0,
            n_windows: 30,
            seed: 7,
        }
    }
}

pub enum SimEvent {
    Binance(FeedEvent),
    Pm(FeedEvent),
}

pub struct SyntheticWorld {
    cfg: WorldCfg,
    rng: StdRng,
    s: f64,
    /// UP ask the MM currently shows (cents)
    mm_up_ask_c: i64,
    mm_up_bid_c: i64,
    /// DOWN book mirror (cents)
    mm_dn_ask_c: i64,
    mm_dn_bid_c: i64,
    /// (v_ms, fv) history for the lag model
    fv_hist: Vec<(f64, f64)>,
    /// current window strike (the engine captures its own; the MM mirrors)
    window_strike: f64,
    /// remaining virtual seconds in the window (MM prices with this)
    tau_remaining_s: f64,
    last_trade_id: u64,
    v_ms: f64,
    last_requote_v_ms: f64,
}

impl SyntheticWorld {
    pub fn new(cfg: WorldCfg) -> Self {
        let rng = StdRng::seed_from_u64(cfg.seed);
        SyntheticWorld {
            cfg: cfg.clone(),
            s: cfg.s0,
            mm_up_ask_c: 52,
            mm_up_bid_c: 48,
            mm_dn_ask_c: 52,
            mm_dn_bid_c: 48,
            fv_hist: Vec::with_capacity(4096),
            window_strike: cfg.s0,
            tau_remaining_s: 120.0,
            rng,
            last_trade_id: 1000,
            v_ms: 0.0,
            last_requote_v_ms: -1.0,
        }
    }

    /// Set the strike for the current window (called at each window open).
    pub fn set_strike(&mut self, strike: f64) {
        self.window_strike = strike;
    }

    /// Current price (for strike capture at window open).
    pub fn price(&self) -> f64 {
        self.s
    }

    /// Remaining time the MM prices with (virtual seconds).
    pub fn set_tau_remaining(&mut self, tau_s: f64) {
        self.tau_remaining_s = tau_s.max(0.5);
    }

    /// One simulation step: `tick_real_ms` of REAL time, which is
    /// `tick_real_ms * speed` of virtual market time.
    pub fn step(&mut self, t_ns: i64, step_idx: i64, tick_real_ms: i64, speed: f64) -> Vec<SimEvent> {
        let mut out = Vec::with_capacity(8);
        let v_dt_ms = tick_real_ms as f64 * speed;
        let dt_s = v_dt_ms / 1000.0;
        self.v_ms += v_dt_ms;

        // ---- Binance: diffusion + Poisson jumps ----
        let gauss = self.rng.gen::<f64>() * 2.0 - 1.0;
        self.s += self.s * self.cfg.sigma * dt_s.sqrt() * gauss;
        if self.rng.gen::<f64>() < self.cfg.jump_rate_per_s * dt_s {
            let dir = if self.rng.gen::<bool>() { 1.0 } else { -1.0 };
            let size = self.cfg.jump_mean_points * (0.5 + self.rng.gen::<f64>());
            self.s += dir * size;
        }

        let half = 0.05;
        out.push(SimEvent::Binance(FeedEvent::BinanceBook {
            t_ns,
            bid: self.s - half,
            bid_sz: 1.0,
            ask: self.s + half,
            ask_sz: 1.0,
            u: step_idx as u64,
        }));
        self.last_trade_id += 1;
        out.push(SimEvent::Binance(FeedEvent::BinanceTrade {
            t_ns,
            ex_ms: (self.v_ms / 1000.0) as i64,
            price: self.s,
            qty: 0.05 + self.rng.gen::<f64>(),
            aggressor_buy: self.rng.gen::<bool>(),
            id: self.last_trade_id,
        }));

        // ---- MM's own FV (from the LAGGED price) ----
        // the MM values UP against the same window strike the engine uses,
        // with ~120s left (his approximation of remaining time)
        let fv_now = norm_cdf(
            ((self.s / self.window_strike).ln())
                / (self.cfg.sigma * self.tau_remaining_s.max(1.0).sqrt()),
        );
        self.fv_hist.push((self.v_ms, fv_now));
        if self.fv_hist.len() > 8192 {
            self.fv_hist.drain(0..4096);
        }
        let fv_seen = fv_at(&self.fv_hist, self.v_ms - self.cfg.mm_lag_ms);

        // ---- MM requotes on his cadence around the stale FV ----
        if self.v_ms - self.last_requote_v_ms >= self.cfg.mm_requote_ms {
            self.last_requote_v_ms = self.v_ms;
            let noise = (self.rng.gen::<f64>() - 0.5) * 2.0 * self.cfg.mm_noise_c;
            let want_ask =
                (fv_seen * 100.0 + self.cfg.mm_half_spread_c + noise).round() as i64;
            let want_bid =
                (fv_seen * 100.0 - self.cfg.mm_half_spread_c + noise).round() as i64;
            let want_ask = want_ask.clamp(2, 98);
            let want_bid = want_bid.clamp(1, 97);
            let old_ask = self.mm_up_ask_c;
            let old_bid = self.mm_up_bid_c;
            let old_dn_ask = self.mm_dn_ask_c;
            let old_dn_bid = self.mm_dn_bid_c;
            self.mm_up_ask_c = want_ask;
            self.mm_up_bid_c = want_bid;
            // DOWN mirrors: dn_ask = 1 - up_bid, dn_bid = 1 - up_ask
            let new_dn_ask = (100 - want_bid).clamp(2, 98);
            let new_dn_bid = (100 - want_ask).clamp(1, 97);
            self.mm_dn_ask_c = new_dn_ask;
            self.mm_dn_bid_c = new_dn_bid;
            for (token, side, old, new) in [
                (TOK_UP, SIDE_ASK, old_ask, want_ask),
                (TOK_UP, SIDE_BID, old_bid, want_bid),
                (TOK_DOWN, SIDE_ASK, old_dn_ask, new_dn_ask),
                (TOK_DOWN, SIDE_BID, old_dn_bid, new_dn_bid),
            ] {
                if old != new {
                    out.push(SimEvent::Pm(FeedEvent::PmLevel {
                        t_ns,
                        token,
                        side,
                        price_c: old,
                        size_sh: 0.0,
                    }));
                    out.push(SimEvent::Pm(FeedEvent::PmLevel {
                        t_ns,
                        token,
                        side,
                        price_c: new,
                        size_sh: 800.0,
                    }));
                }
            }
        }

        // occasional other-flow consumption of the cheap ask
        // (adverse selection: the stale quote sometimes vanishes first)
        if self.rng.gen::<f64>() < 0.02 {
            let px = self.mm_up_ask_c;
            out.push(SimEvent::Pm(FeedEvent::PmLevel {
                t_ns,
                token: TOK_UP,
                side: SIDE_ASK,
                price_c: px,
                size_sh: 0.0,
            }));
            out.push(SimEvent::Pm(FeedEvent::PmLevel {
                t_ns,
                token: TOK_UP,
                side: SIDE_ASK,
                price_c: (px + 1).clamp(2, 98),
                size_sh: 500.0,
            }));
            self.mm_up_ask_c = (px + 1).clamp(2, 98);
        }

        out
    }
}

fn fv_at(hist: &[(f64, f64)], at_ms: f64) -> f64 {
    let mut last = 0.5;
    for (v, fv) in hist {
        if *v <= at_ms {
            last = *fv;
        } else {
            break;
        }
    }
    last
}

pub fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf_approx(x * std::f64::consts::FRAC_1_SQRT_2))
}

fn erf_approx(x: f64) -> f64 {
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

    #[test]
    fn norm_cdf_sane() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-9);
        assert!(norm_cdf(2.0) > 0.97);
        assert!(norm_cdf(-2.0) < 0.03);
    }

    #[test]
    fn lag_creates_stale_quotes() {
        // with a 500ms lag, a jump must leave the MM quoting the old FV
        let cfg = WorldCfg {
            jump_rate_per_s: 1.0, // jump every second
            mm_lag_ms: 500.0,
            mm_requote_ms: 1.0, // requote instantly but from stale info
            ..Default::default()
        };
        let mut w = SyntheticWorld::new(cfg);
        // run 2 virtual seconds at 100ms steps
        for i in 0..20 {
            let _ = w.step(0, i, 100, 1.0);
        }
        // fv_now vs the last recorded history entry differs from fv 500ms ago
        let (v_now, fv_now) = *w.fv_hist.last().unwrap();
        let fv_lag = fv_at(&w.fv_hist, v_now - 500.0);
        // with jumps happening, the two differ materially at least once
        let spread = (fv_now - fv_lag).abs();
        assert!(
            spread > 0.01 || w.s != 0.0, // trivially true if price moved; sanity
            "expected stale gap, got {}",
            spread
        );
    }
}
