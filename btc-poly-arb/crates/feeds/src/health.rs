//! Lock-free feed health shared between feed tasks and the dashboard.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};

#[derive(Default)]
pub struct FeedHealth {
    /// monotonic ns of the last accepted message
    pub last_msg_ns: AtomicI64,
    /// total messages normalized into events
    pub msgs: AtomicU64,
    /// detected sequence gaps (binance trade id jumps)
    pub gaps: AtomicU64,
    /// currently connected
    pub connected: AtomicBool,
    /// reconnect count
    pub reconnects: AtomicU64,
}

impl FeedHealth {
    pub fn on_msg(&self, t_ns: i64) {
        self.last_msg_ns.store(t_ns, Ordering::Release);
        self.msgs.fetch_add(1, Ordering::Relaxed);
    }

    pub fn age_ns(&self, now_ns: i64) -> i64 {
        let last = self.last_msg_ns.load(Ordering::Acquire);
        if last == 0 {
            i64::MAX
        } else {
            now_ns - last
        }
    }

    pub fn mark_connected(&self, v: bool) {
        if v {
            self.connected.store(true, Ordering::Release);
        } else {
            let was = self.connected.swap(false, Ordering::AcqRel);
            if was {
                self.reconnects.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}
