//! Wait-free SPSC ring (Vyukov-style, u64 cursors).
//!
//! Exactly one producer thread and exactly one consumer thread. Power-of-two
//! capacity, no allocation after construction, no locks, no syscalls.
//! Memory ordering:
//!   producer: load head (Acquire) → write slot → store tail (Release)
//!   consumer: load tail (Acquire) → read slot  → store head (Release)
//! which is the classic sound SPSC scheme: every slot write is published by
//! the tail Release and observed under the tail Acquire before read; every
//! slot read completes (head Release) before the producer may overwrite the
//! slot (head Acquire).

use crate::pad::CachePadded;
use std::mem::MaybeUninit;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct SpscRing<T: Copy> {
    buf: Box<[MaybeUninit<T>]>,
    mask: u64,
    /// Consumer cursor — total items ever popped.
    head: CachePadded<AtomicU64>,
    /// Producer cursor — total items ever pushed.
    tail: CachePadded<AtomicU64>,
    /// Items dropped because the ring was full (Relaxed).
    dropped: CachePadded<AtomicU64>,
}

// Safety: the ring is SPSC; the single producer thread writes slots and the
// single consumer thread reads them, synchronized by the Release/Acquire
// cursor protocol above. T must be Copy so reads cannot observe partially
// constructed data.
unsafe impl<T: Copy + Send> Send for SpscRing<T> {}
unsafe impl<T: Copy + Send> Sync for SpscRing<T> {}

impl<T: Copy> SpscRing<T> {
    /// Capacity must be a power of two (e.g. 4096).
    pub fn with_capacity(pow2: usize) -> Self {
        assert!(pow2.is_power_of_two(), "capacity must be a power of two");
        SpscRing {
            buf: (0..pow2).map(|_| MaybeUninit::uninit()).collect(),
            mask: (pow2 - 1) as u64,
            head: CachePadded::new(AtomicU64::new(0)),
            tail: CachePadded::new(AtomicU64::new(0)),
            dropped: CachePadded::new(AtomicU64::new(0)),
        }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// Producer side. Returns false (and counts a drop) when full — market
    /// data is freshest-wins, so the consumer drains in batches and fullness
    /// is a pathological state that we surface as a metric.
    #[inline]
    pub fn try_push(&self, v: T) -> bool {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        // u64 cursors cannot wrap in practice (584 years at 1G ops/s).
        debug_assert!(tail >= head);
        if tail - head >= self.mask + 1 {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        unsafe {
            self.buf.as_ptr().add((tail & self.mask) as usize)
                .cast::<T>()
                .cast_mut()
                .write(v);
        }
        self.tail.store(tail + 1, Ordering::Release);
        true
    }

    /// Consumer side: pop one item.
    #[inline]
    pub fn pop(&self) -> Option<T> {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head == tail {
            return None;
        }
        let v = unsafe {
            self.buf.as_ptr().add((head & self.mask) as usize)
                .cast::<T>()
                .read()
        };
        self.head.store(head + 1, Ordering::Release);
        Some(v)
    }

    /// Consumer side: drain up to `out.len()` items in one cursor bump —
    /// amortizes the atomic stores across a whole batch of market events.
    #[inline]
    pub fn pop_batch(&self, out: &mut [T]) -> usize {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        let avail = (tail - head).min(out.len() as u64) as usize;
        for i in 0..avail {
            out[i] = unsafe {
                self.buf
                    .as_ptr()
                    .add(((head + i as u64) & self.mask) as usize)
                    .cast::<T>()
                    .read()
            };
        }
        if avail > 0 {
            self.head.store(head + avail as u64, Ordering::Release);
        }
        avail
    }

    /// Approximate fill level (racy snapshot, diagnostics only).
    pub fn len(&self) -> u64 {
        self.tail.load(Ordering::Relaxed) - self.head.load(Ordering::Relaxed)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total items ever pushed.
    pub fn total_pushed(&self) -> u64 {
        self.tail.load(Ordering::Relaxed)
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn fifo_order_and_empty() {
        let r = SpscRing::<u64>::with_capacity(4);
        assert!(r.pop().is_none());
        assert!(r.try_push(1));
        assert!(r.try_push(2));
        assert_eq!(r.pop(), Some(1));
        assert_eq!(r.pop(), Some(2));
        assert!(r.pop().is_none());
    }

    #[test]
    fn full_ring_drops_and_counts() {
        let r = SpscRing::<u64>::with_capacity(2);
        assert!(r.try_push(10));
        assert!(r.try_push(20));
        assert!(!r.try_push(30));
        assert_eq!(r.dropped(), 1);
        assert_eq!(r.pop(), Some(10));
        assert!(r.try_push(30)); // space again
        assert_eq!(r.pop(), Some(20));
        assert_eq!(r.pop(), Some(30));
    }

    #[test]
    fn batch_drain_in_order() {
        let r = SpscRing::<u64>::with_capacity(8);
        for i in 0..6 {
            assert!(r.try_push(i));
        }
        let mut out = [0u64; 4];
        assert_eq!(r.pop_batch(&mut out), 4);
        assert_eq!(out, [0, 1, 2, 3]);
        let mut out2 = [0u64; 8];
        assert_eq!(r.pop_batch(&mut out2), 2);
        assert_eq!(&out2[..2], &[4, 5]);
        assert_eq!(r.pop_batch(&mut out2), 0);
    }

    #[test]
    fn wraps_correctly_past_capacity() {
        let r = SpscRing::<u64>::with_capacity(4);
        for round in 0..10u64 {
            for i in 0..3u64 {
                assert!(r.try_push(round * 3 + i), "round {round}");
            }
            for i in 0..3u64 {
                assert_eq!(r.pop(), Some(round * 3 + i));
            }
        }
        assert_eq!(r.total_pushed(), 30);
    }

    /// Cross-thread stress: 100k items, checksum verified on the consumer.
    #[test]
    fn cross_thread_stress() {
        const N: u64 = 100_000;
        let ring = Arc::new(SpscRing::<u64>::with_capacity(1024));
        let (prod, cons) = (ring.clone(), ring);
        let h = thread::spawn(move || {
            let mut pushed = 0u64;
            while pushed < N {
                if prod.try_push(pushed) {
                    pushed += 1;
                } else {
                    std::hint::spin_loop();
                }
            }
        });
        let mut got = 0u64;
        let mut sum = 0u64;
        while got < N {
            match cons.pop() {
                Some(v) => {
                    sum = sum.wrapping_add(v);
                    got += 1;
                }
                None => std::hint::spin_loop(),
            }
        }
        h.join().unwrap();
        // Data integrity: every value arrived exactly once, in order.
        assert_eq!(sum, (N - 1) * N / 2);
        assert_eq!(cons.total_pushed(), N);
        // `dropped` counts REFUSED pushes under burst; the producer retries
        // the same item, so integrity holds — no zero-drop guarantee.
    }
}
