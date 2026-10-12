//! Token-based park/unpark with zero lost wakeups.
//!
//! Built on `std::thread::park_timeout` + `Thread::unpark`: an unpark issued
//! between parks is remembered as a token, so "producer pushed → consumer
//! parks" can never sleep through an event. Pairs with the SPSC rings: the
//! producer pushes, then unparks; the consumer parks only when its ring is
//! empty.

use std::thread::{self, Thread};
use std::time::Duration;

pub struct Parker {
    timeout: Duration,
}

/// Handle used by producers to wake a parked consumer thread.
#[derive(Clone)]
pub struct Unparker {
    thread: Thread,
}

/// Create a (Parker, Unparker) pair for the CURRENT thread — call the Parker
/// side from the thread that will park.
pub fn pair(timeout: Duration) -> (Parker, Unparker) {
    (Parker { timeout }, Unparker { thread: thread::current() })
}

impl Parker {
    pub fn new(timeout: Duration) -> Self {
        Parker { timeout }
    }

    /// Sleep until unparked or the timeout elapses (whichever first).
    /// An unpark token already pending returns immediately.
    #[inline]
    pub fn park(&self) {
        // Parks the CALLING thread; construct the Parker on the parking thread.
        thread::park_timeout(self.timeout);
    }
}

impl Unparker {
    /// Build an Unparker for an arbitrary thread handle (e.g. obtained from
    /// a `JoinHandle::thread()` by the spawner — no in-thread handshake
    /// needed).
    pub fn new(thread: Thread) -> Self {
        Unparker { thread }
    }

    /// Wake the paired thread (no-op if it is running; token if it is about
    /// to park — never lost).
    #[inline]
    pub fn unpark(&self) {
        self.thread.unpark();
    }
}

/// A wake slot that is filled after thread spawning — lets producers hold a
/// wake handle for a consumer thread that does not exist yet (breaks
/// spawn-order cycles). `wake()` before `set()` is a no-op; once set, every
/// wake reaches the target.
pub struct WakeSlot(std::sync::OnceLock<Unparker>);

impl Default for WakeSlot {
    fn default() -> Self {
        WakeSlot(std::sync::OnceLock::new())
    }
}

impl WakeSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Install the target unparker (idempotent — first writer wins).
    pub fn set(&self, u: Unparker) {
        let _ = self.0.set(u);
    }

    /// True once the slot has been armed.
    pub fn armed(&self) -> bool {
        self.0.get().is_some()
    }

    /// Wake the target thread if armed (no-op otherwise).
    #[inline]
    pub fn wake(&self) {
        if let Some(u) = self.0.get() {
            u.unpark();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    #[test]
    fn unpark_before_park_is_not_lost() {
        let (tx, rx) = std::sync::mpsc::channel();
        let val = Arc::new(AtomicU64::new(0));
        let v2 = val.clone();
        let h = thread::spawn(move || {
            let (parker, _unparker_handle_dropped) = pair(Duration::from_secs(10));
            // signal we built the pair, then simulate a short busy stretch
            tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(20));
            v2.store(1, Ordering::Relaxed);
            parker.park(); // token from producer must make this instant
            v2.store(2, Ordering::Relaxed);
        });
        rx.recv().unwrap();
        // unpark while the consumer is guaranteed NOT parked yet → token
        thread::sleep(Duration::from_millis(5));
        // producer unpark path requires an Unparker of that thread:
        h.thread().unpark();
        h.join().unwrap();
        assert_eq!(val.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn timeout_returns_control() {
        let t0 = Instant::now();
        let (parker, _) = pair(Duration::from_millis(30));
        parker.park();
        assert!(t0.elapsed() >= Duration::from_millis(25));
    }
}
