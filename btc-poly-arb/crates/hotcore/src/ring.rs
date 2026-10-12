//! Wait-free SPSC ring buffer.
//!
//! Classic Lamport queue with monotonically increasing 64-bit indices and a
//! power-of-two mask, so no CAS, no ABA, and no wrap-around ambiguity.
//! Producer and consumer each own one cache line.
//!
//! Memory ordering:
//! * producer: write slot (plain) -> `Release` store of `head`
//! * consumer: `Acquire` load of `head` -> read slot -> `Release` store of `tail`
//! * producer loads `tail` with `Acquire` before reusing a slot
//!
//! `T: Copy` keeps reads/writes to trivially copyable memory — no drop glue,
//! no constructors, the whole buffer is uninitialized `MaybeUninit` memory.

use core::cell::UnsafeCell;
use core::marker::PhantomData;
use core::mem::MaybeUninit;
use core::sync::atomic::{AtomicU64, Ordering};

use crate::pad::CachePadded;

pub struct SpscRing<T: Copy> {
    buf: UnsafeCell<Box<[MaybeUninit<T>]>>,
    mask: u64,
    head: CachePadded<AtomicU64>, // producer-owned: next slot to write
    _pad0: CachePadded<u64>,
    tail: CachePadded<AtomicU64>, // consumer-owned: next slot to read
    _pad1: CachePadded<u64>,
    _marker: PhantomData<*mut T>,
}

// SAFETY: T is Copy (trivially movable, no drop), producer and consumer are
// distinct threads by construction (hence the PhantomData<*mut T> making !Send
// by default; we explicitly re-enable the needed auto traits).
unsafe impl<T: Copy + Send> Send for SpscRing<T> {}
unsafe impl<T: Copy + Send> Sync for SpscRing<T> {}

impl<T: Copy> SpscRing<T> {
    /// `cap_pow2` must be a power of two; the ring will hold exactly that many items.
    pub fn with_capacity(cap_pow2: usize) -> Self {
        assert!(cap_pow2 >= 2 && cap_pow2.is_power_of_two(), "capacity must be a power of two");
        let buf = Box::new_uninit_slice(cap_pow2);
        SpscRing {
            buf: UnsafeCell::new(buf),
            mask: (cap_pow2 - 1) as u64,
            head: CachePadded::new(AtomicU64::new(0)),
            _pad0: CachePadded::new(0),
            tail: CachePadded::new(AtomicU64::new(0)),
            _pad1: CachePadded::new(0),
            _marker: PhantomData,
        }
    }

    pub fn capacity(&self) -> u64 {
        self.mask + 1
    }

    /// Number of items currently in the ring (approximate under concurrency).
    #[inline]
    pub fn len(&self) -> u64 {
        let h = self.head.value.load(Ordering::Relaxed);
        let t = self.tail.value.load(Ordering::Relaxed);
        h.wrapping_sub(t)
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.head.value.load(Ordering::Relaxed) == self.tail.value.load(Ordering::Relaxed)
    }

    /// Producer side. Returns the item back if full (never blocks, never allocates).
    #[inline(always)]
    pub fn try_push(&self, v: T) -> Result<(), T> {
        let head = self.head.value.load(Ordering::Relaxed);
        let tail = self.tail.value.load(Ordering::Acquire);
        if head.wrapping_sub(tail) > self.mask {
            return Err(v); // full
        }
        let slot = (head & self.mask) as usize;
        unsafe {
            let arr = &mut *self.buf.get();
            arr[slot].write(v);
        }
        self.head.value.store(head.wrapping_add(1), Ordering::Release);
        Ok(())
    }

    /// Consumer side. `None` if empty.
    #[inline(always)]
    pub fn try_pop(&self) -> Option<T> {
        let tail = self.tail.value.load(Ordering::Relaxed);
        let head = self.head.value.load(Ordering::Acquire);
        if head == tail {
            return None; // empty
        }
        let slot = (tail & self.mask) as usize;
        let v = unsafe {
            let arr = &*self.buf.get();
            arr[slot].assume_init_read()
        };
        self.tail.value.store(tail.wrapping_add(1), Ordering::Release);
        Some(v)
    }

    /// Consumer side: drain up to `out.len()` items, return count filled.
    /// Single release-fence for the whole batch.
    #[inline]
    pub fn pop_slice(&self, out: &mut [T]) -> usize {
        let tail = self.tail.value.load(Ordering::Relaxed);
        let head = self.head.value.load(Ordering::Acquire);
        let avail = head.wrapping_sub(tail);
        let n = (out.len() as u64).min(avail) as usize;
        if n == 0 {
            return 0;
        }
        unsafe {
            let arr = &*self.buf.get();
            for i in 0..n {
                let slot = ((tail + i as u64) & self.mask) as usize;
                out[i] = arr[slot].assume_init_read();
            }
        }
        self.tail.value.store(tail.wrapping_add(n as u64), Ordering::Release);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn basic_fifo() {
        let r = SpscRing::<u64>::with_capacity(8);
        for i in 0..8u64 {
            assert!(r.try_push(i).is_ok());
        }
        assert!(r.try_push(99).is_err(), "must be full");
        for i in 0..8u64 {
            assert_eq!(r.try_pop(), Some(i));
        }
        assert_eq!(r.try_pop(), None);
    }

    #[test]
    fn stress_10m_sequence() {
        const N: u64 = 10_000_000;
        let ring = Arc::new(SpscRing::<(u64, u64)>::with_capacity(1024));
        let (tx, rx) = std::sync::mpsc::channel();
        let producer = {
            let ring = ring.clone();
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut i = 0u64;
                while i < N {
                    match ring.try_push((i, i.wrapping_mul(3))) {
                        Ok(()) => i += 1,
                        Err(_) => std::hint::spin_loop(),
                    }
                }
                tx.send(()).unwrap();
            })
        };
        let ring2 = ring.clone();
        let consumer = std::thread::spawn(move || {
            let mut got = 0u64;
            while got < N {
                if let Some((i, v)) = ring2.try_pop() {
                    assert_eq!(v, i.wrapping_mul(3), "value corruption at {}", i);
                    got += 1;
                } else {
                    std::hint::spin_loop();
                }
            }
        });
        rx.recv().unwrap();
        producer.join().unwrap();
        consumer.join().unwrap();
        assert!(ring.is_empty());
    }

    #[test]
    fn pop_slice_batch() {
        let r = SpscRing::<u32>::with_capacity(16);
        for i in 0..10u32 {
            r.try_push(i).unwrap();
        }
        let mut out = [0u32; 4];
        assert_eq!(r.pop_slice(&mut out), 4);
        assert_eq!(out, [0, 1, 2, 3]);
        let mut out2 = [0u32; 32];
        assert_eq!(r.pop_slice(&mut out2), 6);
        assert_eq!(&out2[..6], &[4, 5, 6, 7, 8, 9]);
    }
}
