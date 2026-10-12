//! Seqlock for `Copy` state with one writer and any number of readers.
//!
//! The engine thread owns the write side (e.g. publishing `DashState` at
//! 10 Hz); readers (telemetry task) retry if a write overlapped their read.
//! Readers never block the writer — the writer never even loads anything the
//! readers touch — which is the entire point for a spinning hot thread.
//!
//! Version discipline:
//! * `0` is even = stable
//! * writer: `fetch_add(1)` -> odd (locked) -> copy in -> `store(even)`
//! * reader: load version (even) -> copy out -> `Acquire` fence -> load again

use core::cell::UnsafeCell;
use core::marker::PhantomData;
use core::sync::atomic::{AtomicU32, Ordering};

pub struct SeqLock<T: Copy> {
    v: UnsafeCell<T>,
    ver: AtomicU32,
    _marker: PhantomData<*mut T>,
}

unsafe impl<T: Copy + Send> Send for SeqLock<T> {}
unsafe impl<T: Copy + Send> Sync for SeqLock<T> {}

impl<T: Copy> SeqLock<T> {
    pub const fn new(v: T) -> Self {
        SeqLock {
            v: UnsafeCell::new(v),
            ver: AtomicU32::new(0),
            _marker: PhantomData,
        }
    }

    /// A monotonically bumped generation; engine may use it to detect updates.
    #[inline]
    pub fn version(&self) -> u32 {
        self.ver.load(Ordering::Relaxed)
    }

    /// Writer side. The closure receives a scratch copy of the value;
    /// mutated scratch is published on return.
    #[inline]
    pub fn write_with<F: FnOnce(&mut T)>(&self, f: F) {
        // enter: odd
        self.ver.fetch_add(1, Ordering::AcqRel);
        // SAFETY: writer is unique by protocol; readers retry on odd version.
        unsafe {
            let ptr = self.v.get();
            let mut scratch = ptr.read();
            f(&mut scratch);
            ptr.write(scratch);
        }
        // exit: even (Release publishes the payload)
        self.ver.fetch_add(1, Ordering::Release);
    }

    /// Direct store of a pre-built value.
    #[inline]
    pub fn store(&self, v: T) {
        self.ver.fetch_add(1, Ordering::AcqRel);
        unsafe {
            *self.v.get() = v;
        }
        self.ver.fetch_add(1, Ordering::Release);
    }

    /// Reader side: copy under seqlock; retries if torn.
    #[inline]
    pub fn read(&self) -> T {
        loop {
            let v1 = self.ver.load(Ordering::Acquire);
            if v1 & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            // SAFETY: even version guarantees the writer is not mid-copy.
            let copy = unsafe { self.v.get().read() };
            core::sync::atomic::fence(Ordering::Acquire);
            let v2 = self.ver.load(Ordering::Acquire);
            if v1 == v2 {
                return copy;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Clone, Copy, Default, PartialEq, Debug)]
    struct Payload {
        a: [u64; 8],
        b: f64,
    }

    #[test]
    fn read_write_basic() {
        let s = SeqLock::new(Payload::default());
        s.write_with(|p| {
            p.a[7] = 42;
            p.b = 3.5;
        });
        let r = s.read();
        assert_eq!(r.a[7], 42);
        assert_eq!(r.b, 3.5);
        assert_eq!(s.version(), 2);
    }

    #[test]
    fn concurrent_no_tear() {
        let s = Arc::new(SeqLock::new(Payload::default()));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let s = s.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut i = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let v = i;
                    let checksum = v.wrapping_mul(0x9E3779B97F4A7C15);
                    s.write_with(|p| {
                        for slot in p.a.iter_mut() {
                            *slot = checksum;
                        }
                        p.b = checksum as f64;
                    });
                    i += 1;
                }
            })
        };
        let reader = {
            let s = s.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut reads = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let p = s.read();
                    let c0 = p.a[0];
                    for slot in p.a.iter() {
                        assert_eq!(*slot, c0, "torn read detected");
                    }
                    reads += 1;
                }
                reads
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        stop.store(true, Ordering::Relaxed);
        writer.join().unwrap();
        let n = reader.join().unwrap();
        assert!(n > 100, "reader starved: only {} reads", n);
    }
}
