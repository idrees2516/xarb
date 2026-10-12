//! Cache-line padding.
//!
//! The engine's ring indices must not share a cache line with anything else:
//! a single false-sharing pair costs ~100x a normal store on contended paths.

#[repr(align(64))]
pub struct CachePadded<T> {
    pub value: T,
}

impl<T> CachePadded<T> {
    pub const fn new(v: T) -> Self {
        CachePadded { value: v }
    }
}

impl<T: Default> Default for CachePadded<T> {
    fn default() -> Self {
        CachePadded { value: T::default() }
    }
}

impl<T> core::ops::Deref for CachePadded<T> {
    type Target = T;
    #[inline(always)]
    fn deref(&self) -> &T {
        &self.value
    }
}
