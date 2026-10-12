//! hotcore — lock-free, allocation-free primitives for the hot path.
//!
//! * `pad`      — cache line padding to defeat false sharing
//! * `ring`     — single-producer/single-consumer Mpmc-free wait-free ring
//! * `clock`    — TSC (cycle) clock with sub-nanosecond resolution on x86_64
//! * `seqlock`  — seqlock for Copy state shared one-writer/many-readers
//! * `hist`     — log-spaced latency histogram (Copy, no allocation)

pub mod clock;
pub mod hist;
pub mod pad;
pub mod ring;
pub mod seqlock;
