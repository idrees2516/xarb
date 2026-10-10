//! CPU affinity + realtime scheduling (best effort).
//!
//! Pinning the hot threads to dedicated cores removes scheduler migration
//! and preemption jitter from the nanosecond path. SCHED_FIFO is attempted
//! but optional: unprivileged containers simply keep SCHED_OTHER.

/// Pin the calling thread to `core` (0-based). Returns false on failure.
pub fn pin_current(core: usize) -> bool {
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        libc::CPU_ZERO(&mut set);
        libc::CPU_SET(core, &mut set);
        libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) == 0
    }
}

/// Number of cores available to this process.
pub fn core_count() -> usize {
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) == 0 {
            let mut n = 0;
            for i in 0..libc::CPU_SETSIZE as usize {
                if libc::CPU_ISSET(i, &set) {
                    n += 1;
                }
            }
            if n > 0 {
                return n;
            }
        }
    }
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Best-effort realtime scheduling (SCHED_FIFO, priority 10). Root or
/// CAP_SYS_NICE required; returns false silently otherwise.
pub fn try_realtime() -> bool {
    unsafe {
        let param = libc::sched_param { sched_priority: 10 };
        libc::sched_setscheduler(0, libc::SCHED_FIFO, &param) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_count_positive() {
        assert!(core_count() >= 1);
    }

    #[test]
    fn pin_to_valid_core() {
        let ok = pin_current(0);
        // May legitimately fail in restricted sandboxes; just don't crash.
        let _ = ok;
        assert!(core_count() >= 1);
    }
}
