//! Binary frame codec for the dashboard WebSocket.
//!
//! Layout (little-endian):
//! ```text
//! [0..2]   kind        u16   (1 = DashState snapshot, 2 = log line, 3 = hello)
//! [2..4]   version     u16   (1)
//! [4..]    payload
//! ```
//! DashState payload is a flat field dump — deliberately simple, no deps,
//! identical decode logic on native and wasm32.

use crate::*;

pub const KIND_DASH: u16 = 1;
pub const KIND_LOG: u16 = 2;
pub const KIND_HELLO: u16 = 3;
pub const PROTO_VERSION: u16 = 1;

/// A log line sent to the dashboard (max 200 bytes payload).
#[derive(Clone, Debug)]
pub struct LogLine {
    pub t_ns: i64,
    pub level: u8, // 0 trace,1 debug,2 info,3 warn,4 error
    pub msg: String,
}

pub fn encode_hello(bot_name: &str, version: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 2 + bot_name.len() + 2 + version.len());
    out.extend_from_slice(&KIND_HELLO.to_le_bytes());
    out.extend_from_slice(&PROTO_VERSION.to_le_bytes());
    put_str(&mut out, bot_name);
    put_str(&mut out, version);
    out
}

pub fn encode_log(l: &LogLine) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 8 + 1 + 2 + l.msg.len().min(190));
    out.extend_from_slice(&KIND_LOG.to_le_bytes());
    out.extend_from_slice(&PROTO_VERSION.to_le_bytes());
    out.extend_from_slice(&l.t_ns.to_le_bytes());
    out.push(l.level);
    put_str(&mut out, &l.msg);
    out
}

pub fn encode_dash(d: &DashState) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 12 * 1024);
    out.extend_from_slice(&KIND_DASH.to_le_bytes());
    out.extend_from_slice(&PROTO_VERSION.to_le_bytes());
    encode_dash_payload(&mut out, d);
    out
}

/// Decoded WebSocket frame.
#[derive(Debug)]
pub enum Frame {
    Dash(Box<DashState>),
    Log(LogLine),
    Hello { bot: String, version: String },
    Unknown { kind: u16, version: u16 },
}

pub fn decode(buf: &[u8]) -> Option<Frame> {
    if buf.len() < 4 {
        return None;
    }
    let kind = u16::from_le_bytes([buf[0], buf[1]]);
    let version = u16::from_le_bytes([buf[2], buf[3]]);
    let p = &mut Reader::new(&buf[4..]);
    match kind {
        KIND_DASH => {
            if version != PROTO_VERSION {
                return Some(Frame::Unknown { kind, version });
            }
            let mut d = DashState::default();
            decode_dash_payload(p, &mut d)?;
            Some(Frame::Dash(Box::new(d)))
        }
        KIND_LOG => {
            let t_ns = p.i64();
            let level = p.u8();
            let msg = p.str();
            Some(Frame::Log(LogLine { t_ns, level, msg }))
        }
        KIND_HELLO => {
            let bot = p.str();
            let ver = p.str();
            Some(Frame::Hello { bot, version: ver })
        }
        _ => Some(Frame::Unknown { kind, version }),
    }
}

// ---------- primitives ----------

pub struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Reader<'a> {
        Reader { b, pos: 0 }
    }
    pub fn u8(&mut self) -> u8 {
        let v = *self.b.get(self.pos).unwrap_or(&0);
        self.pos += 1;
        v
    }
    pub fn u16(&mut self) -> u16 {
        let v = u16::from_le_bytes(self.take2());
        v
    }
    pub fn u32(&mut self) -> u32 {
        let v = u32::from_le_bytes(self.take4());
        v
    }
    pub fn u64(&mut self) -> u64 {
        let v = u64::from_le_bytes(self.take8());
        v
    }
    pub fn i64(&mut self) -> i64 {
        self.u64() as i64
    }
    pub fn f64(&mut self) -> f64 {
        f64::from_bits(self.u64())
    }
    pub fn bool8(&mut self) -> bool {
        self.u8() != 0
    }
    pub fn str(&mut self) -> String {
        let n = self.u16() as usize;
        let s = self
            .b
            .get(self.pos..self.pos + n)
            .unwrap_or(&[]);
        self.pos += n;
        String::from_utf8_lossy(s).into_owned()
    }
    fn take2(&mut self) -> [u8; 2] {
        let mut a = [0u8; 2];
        for (i, x) in a.iter_mut().enumerate() {
            *x = *self.b.get(self.pos + i).unwrap_or(&0);
        }
        self.pos += 2;
        a
    }
    fn take4(&mut self) -> [u8; 4] {
        let mut a = [0u8; 4];
        for (i, x) in a.iter_mut().enumerate() {
            *x = *self.b.get(self.pos + i).unwrap_or(&0);
        }
        self.pos += 4;
        a
    }
    fn take8(&mut self) -> [u8; 8] {
        let mut a = [0u8; 8];
        for (i, x) in a.iter_mut().enumerate() {
            *x = *self.b.get(self.pos + i).unwrap_or(&0);
        }
        self.pos += 8;
        a
    }
    pub fn more(&self) -> bool {
        self.pos < self.b.len()
    }
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    let n = s.len().min(u16::MAX as usize);
    out.extend_from_slice(&(n as u16).to_le_bytes());
    out.extend_from_slice(&s.as_bytes()[..n]);
}

// ---------- DashState payload ----------

fn encode_dash_payload(out: &mut Vec<u8>, d: &DashState) {
    out.extend_from_slice(&d.t_ns.to_le_bytes());
    out.extend_from_slice(&d.wall_ms.to_le_bytes());
    out.push(d.mode);
    out.push(d.kill as u8);
    out.push(d.window_phase);
    out.extend_from_slice(&d.window_seq.to_le_bytes());
    out.extend_from_slice(&d.start_ms.to_le_bytes());
    out.extend_from_slice(&d.end_ms.to_le_bytes());
    out.extend_from_slice(&d.tau_s.to_le_bytes());
    out.extend_from_slice(&d.strike.to_le_bytes());

    put_f64s(out, &[d.mark, d.bb_bid, d.bb_ask, d.bb_sz_bid, d.bb_sz_ask]);
    put_f64s(
        out,
        &[
            d.fv,
            d.fv_5s_ago,
            d.jump,
            d.sigma,
            d.delta,
            d.up_bid,
            d.up_bid_sz,
            d.up_ask,
            d.up_ask_sz,
            d.dn_bid,
            d.dn_bid_sz,
            d.dn_ask,
            d.dn_ask_sz,
            d.up_ask_impl,
            d.edge_up,
            d.edge_dn,
            d.spread_up,
            d.pos_up_sh,
            d.pos_dn_sh,
            d.avg_up,
            d.avg_dn,
        ],
    );
    put_f64s(
        out,
        &[
            d.realized_c,
            d.unrealized_c,
            d.equity_c,
            d.cooldown_left_s,
            (d.trades_today as f64),
            (d.signals_today as f64),
        ],
    );
    put_f64s(
        out,
        &[
            d.cfg_jump,
            d.cfg_gate,
            d.cfg_edge,
            d.cfg_size_sh,
            d.cfg_max_pos,
            d.cfg_min_tau,
            d.cfg_cooldown,
        ],
    );

    out.extend_from_slice(&(d.windows_done as u64).to_le_bytes());
    out.push(d.in_flight);
    out.push(d.cfg_model);
    out.push(d.cfg_exit);
    out.push(d.cfg_trade_down as u8);

    out.extend_from_slice(&(d.feed_bin_age_ms as u64).to_le_bytes());
    out.extend_from_slice(&d.feed_bin_msgs.to_le_bytes());
    out.extend_from_slice(&d.feed_bin_gaps.to_le_bytes());
    out.extend_from_slice(&(d.feed_pm_age_ms as u64).to_le_bytes());
    out.extend_from_slice(&d.feed_pm_msgs.to_le_bytes());
    out.extend_from_slice(&d.evals.to_le_bytes());
    for r in d.rejects.iter() {
        out.extend_from_slice(&r.to_le_bytes());
    }
    for l in d.lat.iter() {
        out.extend_from_slice(&l.p50_ns.to_le_bytes());
        out.extend_from_slice(&l.p99_ns.to_le_bytes());
        out.extend_from_slice(&l.max_ns.to_le_bytes());
        out.extend_from_slice(&l.n.to_le_bytes());
    }

    put_sig_ring(out, &d.sigs, d.sig_head);
    put_ord_ring(out, &d.ords, d.ord_head);
    put_win_ring(out, &d.wins, d.win_head);

    put_f64_arr(out, &d.chart_mark);
    put_f64_arr(out, &d.chart_fv);
    put_f64_arr(out, &d.chart_ask);
    out.extend_from_slice(&d.chart_head.to_le_bytes());
}

fn decode_dash_payload(p: &mut Reader, d: &mut DashState) -> Option<()> {
    d.t_ns = p.i64();
    d.wall_ms = p.i64();
    d.mode = p.u8();
    d.kill = p.bool8();
    d.window_phase = p.u8();
    d.window_seq = p.u32();
    d.start_ms = p.i64();
    d.end_ms = p.i64();
    d.tau_s = p.f64();
    d.strike = p.f64();

    let mark = p.f64();
    let bb_bid = p.f64();
    let bb_ask = p.f64();
    let bb_sz_bid = p.f64();
    let bb_sz_ask = p.f64();
    let fv = p.f64();
    let fv_5s_ago = p.f64();
    let jump = p.f64();
    let sigma = p.f64();
    let delta = p.f64();
    let up_bid = p.f64();
    let up_bid_sz = p.f64();
    let up_ask = p.f64();
    let up_ask_sz = p.f64();
    let dn_bid = p.f64();
    let dn_bid_sz = p.f64();
    let dn_ask = p.f64();
    let dn_ask_sz = p.f64();
    let up_ask_impl = p.f64();
    let edge_up = p.f64();
    let edge_dn = p.f64();
    let spread_up = p.f64();
    let pos_up_sh = p.f64();
    let pos_dn_sh = p.f64();
    let avg_up = p.f64();
    let avg_dn = p.f64();
    let realized_c = p.f64();
    let unrealized_c = p.f64();
    let equity_c = p.f64();
    let cooldown_left_s = p.f64();
    let trades_today = p.f64() as u32;
    let signals_today = p.f64() as u32;
    let cfg_jump = p.f64();
    let cfg_gate = p.f64();
    let cfg_edge = p.f64();
    let cfg_size_sh = p.f64();
    let cfg_max_pos = p.f64();
    let cfg_min_tau = p.f64();
    let cfg_cooldown = p.f64();
    let windows_done = p.u64() as u32;
    d.in_flight = p.u8();
    d.cfg_model = p.u8();
    d.cfg_exit = p.u8();
    d.cfg_trade_down = p.bool8();

    d.feed_bin_age_ms = p.u64() as i64;
    d.feed_bin_msgs = p.u64();
    d.feed_bin_gaps = p.u64();
    d.feed_pm_age_ms = p.u64() as i64;
    d.feed_pm_msgs = p.u64();
    d.evals = p.u64();
    for r in d.rejects.iter_mut() {
        *r = p.u64();
    }
    for l in d.lat.iter_mut() {
        l.p50_ns = p.u64();
        l.p99_ns = p.u64();
        l.max_ns = p.u64();
        l.n = p.u64();
    }

    d.sig_head = get_sig_ring(p, &mut d.sigs);
    d.ord_head = get_ord_ring(p, &mut d.ords);
    d.win_head = get_win_ring(p, &mut d.wins);

    get_f64_arr(p, &mut d.chart_mark);
    get_f64_arr(p, &mut d.chart_fv);
    get_f64_arr(p, &mut d.chart_ask);
    d.chart_head = p.u32();

    d.mark = mark;
    d.bb_bid = bb_bid;
    d.bb_ask = bb_ask;
    d.bb_sz_bid = bb_sz_bid;
    d.bb_sz_ask = bb_sz_ask;
    d.fv = fv;
    d.fv_5s_ago = fv_5s_ago;
    d.jump = jump;
    d.sigma = sigma;
    d.delta = delta;
    d.up_bid = up_bid;
    d.up_bid_sz = up_bid_sz;
    d.up_ask = up_ask;
    d.up_ask_sz = up_ask_sz;
    d.dn_bid = dn_bid;
    d.dn_bid_sz = dn_bid_sz;
    d.dn_ask = dn_ask;
    d.dn_ask_sz = dn_ask_sz;
    d.up_ask_impl = up_ask_impl;
    d.edge_up = edge_up;
    d.edge_dn = edge_dn;
    d.spread_up = spread_up;
    d.pos_up_sh = pos_up_sh;
    d.pos_dn_sh = pos_dn_sh;
    d.avg_up = avg_up;
    d.avg_dn = avg_dn;
    d.realized_c = realized_c;
    d.unrealized_c = unrealized_c;
    d.equity_c = equity_c;
    d.cooldown_left_s = cooldown_left_s;
    d.trades_today = trades_today;
    d.signals_today = signals_today;
    d.cfg_jump = cfg_jump;
    d.cfg_gate = cfg_gate;
    d.cfg_edge = cfg_edge;
    d.cfg_size_sh = cfg_size_sh;
    d.cfg_max_pos = cfg_max_pos;
    d.cfg_min_tau = cfg_min_tau;
    d.cfg_cooldown = cfg_cooldown;
    d.windows_done = windows_done;

    if p.more() {
        // trailing bytes = unknown future fields; tolerate
    }
    Some(())
}

fn put_f64s(out: &mut Vec<u8>, vs: &[f64]) {
    for v in vs {
        out.extend_from_slice(&v.to_bits().to_le_bytes());
    }
}

fn put_f64_arr(out: &mut Vec<u8>, vs: &[f64]) {
    for v in vs {
        out.extend_from_slice(&v.to_bits().to_le_bytes());
    }
}

fn get_f64_arr(p: &mut Reader, vs: &mut [f64]) {
    for v in vs.iter_mut() {
        *v = p.f64();
    }
}

fn put_sig_ring(out: &mut Vec<u8>, ring: &[SigRec], head: u32) {
    out.extend_from_slice(&head.to_le_bytes());
    for s in ring.iter() {
        out.extend_from_slice(&s.t_ns.to_le_bytes());
        out.extend_from_slice(&s.seq.to_le_bytes());
        out.push(s.dir);
        out.extend_from_slice(&s.fv.to_bits().to_le_bytes());
        out.extend_from_slice(&s.ask.to_bits().to_le_bytes());
        out.extend_from_slice(&s.edge.to_bits().to_le_bytes());
        out.extend_from_slice(&s.jump.to_bits().to_le_bytes());
    }
}

fn get_sig_ring(p: &mut Reader, ring: &mut [SigRec]) -> u32 {
    let head = p.u32();
    for s in ring.iter_mut() {
        s.t_ns = p.i64();
        s.seq = p.u64();
        s.dir = p.u8();
        s.fv = p.f64();
        s.ask = p.f64();
        s.edge = p.f64();
        s.jump = p.f64();
    }
    head
}

fn put_ord_ring(out: &mut Vec<u8>, ring: &[OrdRec], head: u32) {
    out.extend_from_slice(&head.to_le_bytes());
    for o in ring.iter() {
        out.extend_from_slice(&o.t_ns.to_le_bytes());
        out.extend_from_slice(&o.seq.to_le_bytes());
        out.push(o.dir);
        out.extend_from_slice(&o.limit_c.to_le_bytes());
        out.extend_from_slice(&o.sh.to_bits().to_le_bytes());
        out.push(o.status);
        out.extend_from_slice(&o.fill_sh.to_bits().to_le_bytes());
        out.extend_from_slice(&o.avg_px_c.to_bits().to_le_bytes());
    }
}

fn get_ord_ring(p: &mut Reader, ring: &mut [OrdRec]) -> u32 {
    let head = p.u32();
    for o in ring.iter_mut() {
        o.t_ns = p.i64();
        o.seq = p.u64();
        o.dir = p.u8();
        o.limit_c = p.i64();
        o.sh = p.f64();
        o.status = p.u8();
        o.fill_sh = p.f64();
        o.avg_px_c = p.f64();
    }
    head
}

fn put_win_ring(out: &mut Vec<u8>, ring: &[WinRec], head: u32) {
    out.extend_from_slice(&head.to_le_bytes());
    for w in ring.iter() {
        out.extend_from_slice(&w.start_ms.to_le_bytes());
        out.extend_from_slice(&w.pnl_c.to_bits().to_le_bytes());
        out.extend_from_slice(&w.trades.to_le_bytes());
        out.extend_from_slice(&w.sigs.to_le_bytes());
    }
}

fn get_win_ring(p: &mut Reader, ring: &mut [WinRec]) -> u32 {
    let head = p.u32();
    for w in ring.iter_mut() {
        w.start_ms = p.i64();
        w.pnl_c = p.f64();
        w.trades = p.u32();
        w.sigs = p.u32();
    }
    head
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dash_roundtrip() {
        let mut d = DashState::default();
        d.t_ns = 1234567890;
        d.mark = 83215.10;
        d.fv = 0.77;
        d.jump = 0.22;
        d.up_ask = 0.56;
        d.edge_up = 0.21;
        d.realized_c = 1250.0;
        d.sig_head = 3;
        d.sigs[0] = SigRec { t_ns: 1, seq: 7, dir: 0, fv: 0.7, ask: 0.5, edge: 0.2, jump: 0.25 };
        d.ords[1] = OrdRec { t_ns: 2, seq: 7, dir: 1, limit_c: 44, sh: 50.0, status: 2, fill_sh: 50.0, avg_px_c: 44.0 };
        d.wins[2] = WinRec { start_ms: 99, pnl_c: 12.5, trades: 1, sigs: 1 };
        d.lat[3] = LatStats { p50_ns: 100, p99_ns: 900, max_ns: 1100, n: 5 };
        d.chart_head = 255;
        d.chart_mark[7] = 83000.0;

        let bytes = encode_dash(&d);
        match decode(&bytes).unwrap() {
            Frame::Dash(dd) => {
                assert_eq!(dd.t_ns, d.t_ns);
                assert_eq!(dd.mark, d.mark);
                assert_eq!(dd.fv, d.fv);
                assert_eq!(dd.edge_up, d.edge_up);
                assert_eq!(dd.sig_head, 3);
                assert_eq!(dd.sigs[0].seq, 7);
                assert_eq!(dd.ords[1].limit_c, 44);
                assert_eq!(dd.wins[2].pnl_c, 12.5);
                assert_eq!(dd.lat[3].p99_ns, 900);
                assert_eq!(dd.chart_head, 255);
                assert_eq!(dd.chart_mark[7], 83000.0);
                assert_eq!(dd.lat[0].n, 0);
            }
            _ => panic!("wrong frame"),
        }
    }

    #[test]
    fn log_roundtrip() {
        let l = LogLine { t_ns: 42, level: 3, msg: "kill switch engaged".into() };
        let b = encode_log(&l);
        match decode(&b).unwrap() {
            Frame::Log(ll) => {
                assert_eq!(ll.t_ns, 42);
                assert_eq!(ll.level, 3);
                assert_eq!(ll.msg, "kill switch engaged");
            }
            _ => panic!("wrong frame"),
        }
    }

    #[test]
    fn hello_roundtrip() {
        let b = encode_hello("polyarb", "0.1.0");
        match decode(&b).unwrap() {
            Frame::Hello { bot, version } => {
                assert_eq!(bot, "polyarb");
                assert_eq!(version, "0.1.0");
            }
            _ => panic!("wrong frame"),
        }
    }
}
