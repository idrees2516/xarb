//! xarb-hft — the lock-free kernel of the XARB hot path.
//!
//! Production-grade primitives shared by every latency-critical stage:
//!   • `CachePadded`      — false-sharing-proof shared cells
//!   • `SpscRing<T>`      — wait-free single-producer/single-consumer ring
//!                          (u64 cursors, power-of-two, zero allocation after
//!                          construction, zero locks, zero syscalls)
//!   • `HotWord`          — u64 bit-packed trigger state: ONE atomic load +
//!                          ONE AND + ONE compare decides a fire. Single
//!                          writer (FV engine) / many readers (strategy).
//!   • `QuoteCell`        — u64 bit-packed Polymarket top-of-book per side.
//!   • `LogHist`          — allocation-free log-scale latency histogram with
//!                          O(1) record and O(64) percentile.
//!   • `Parker/Unparker`  — std-thread token park (no lost wakeups) for
//!                          adaptive spin/park power management.
//!   • affinity           — core pinning + SCHED_FIFO best effort.

pub mod affinity;
pub mod hist;
pub mod hot;
pub mod pad;
pub mod park;
pub mod ring;

pub use hist::LogHist;
pub use hot::{FireHit, HotWord, QuoteCell};
pub use pad::CachePadded;
pub use park::{pair, Parker, Unparker, WakeSlot};
pub use ring::SpscRing;

/// Hot-thread power policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpinMode {
    /// Pure spin with PAUSE hints — burns one core, ~50-200ns detect latency.
    Spin,
    /// Spin for `budget`, then park until event — balanced.
    Hybrid,
    /// Always park on the thread token — event-driven, ~5-30µs wake latency.
    Eco,
}

impl SpinMode {
    pub fn from_str(s: &str) -> Option<SpinMode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "spin" => Some(SpinMode::Spin),
            "hybrid" => Some(SpinMode::Hybrid),
            "eco" => Some(SpinMode::Eco),
            _ => None,
        }
    }

    /// Auto policy: pure spin needs a dedicated core per hot thread.
    pub fn auto(cores: usize) -> SpinMode {
        if cores >= 4 {
            SpinMode::Spin
        } else if cores >= 3 {
            SpinMode::Hybrid
        } else {
            SpinMode::Eco
        }
    }
}
