//! Shared value types.

/// One price level: price in DOLLARS (0.01..0.99), size in shares.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Level {
    pub p: f64,
    pub s: f64,
}

/// Book side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Bid,
    Ask,
}
