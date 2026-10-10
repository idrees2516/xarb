//! Cache-line padding: keep contended atomics on their own cachelines.

/// 64-byte aligned, 64-byte sized wrapper preventing false sharing between
/// adjacent atomics written by different cores.
#[repr(align(64))]
pub struct CachePadded<T> {
    pub value: T,
}

impl<T> CachePadded<T> {
    pub const fn new(value: T) -> Self {
        CachePadded { value }
    }
}

impl<T: Copy> Clone for CachePadded<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T: Copy> Copy for CachePadded<T> {}

impl<T: Default> Default for CachePadded<T> {
    fn default() -> Self {
        CachePadded { value: T::default() }
    }
}

impl<T: core::fmt::Debug> core::fmt::Debug for CachePadded<T> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        self.value.fmt(f)
    }
}

impl<T> core::ops::Deref for CachePadded<T> {
    type Target = T;
    #[inline]
    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T> core::ops::DerefMut for CachePadded<T> {
    #[inline]
    fn deref_mut(&mut self) -> &mut T {
        &mut self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[test]
    fn size_is_one_cacheline() {
        use core::mem::size_of;
        assert_eq!(size_of::<CachePadded<AtomicU64>>(), 64);
        // two padded cells cannot share a line
        assert!(size_of::<[CachePadded<AtomicU64>; 2]>() >= 128);
    }
}
