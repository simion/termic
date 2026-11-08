//! Raise the open-file soft limit at startup.
//!
//! A macOS GUI app launched from the Dock/Finder inherits launchd's
//! `maxfiles` soft limit, which defaults to 256. Every live PTY holds 4 fds
//! on `/dev/ptmx` (the master, the reader's `try_clone_reader` dup, the
//! writer's `take_writer` dup, and `SudoWatch`'s dup on host PTYs), on top of
//! a ~70 fd baseline (WebKit, per-task gh broker sockets, proxy listeners).
//! About 50 terminals across all tasks fill the table and the next `openpty`
//! fails with EMFILE ("Too many open files (os error 24)"). Nothing leaks:
//! the count tracks live terminals.
//!
//! CHILDREN INHERIT THIS. Every agent, shell and script Termic spawns gets
//! the raised soft limit, not the 256 a Terminal.app shell would see.
//! Ghostty raises its limit the same way and then restores the original in
//! each child before exec (ghostty-org/ghostty#4215, then #4232 fixed by
//! #4241), so a shell sees what the user's environment would give it. We do
//! not: portable-pty 0.8 runs its own `pre_exec` and offers no hook for ours,
//! and the inheritance mostly helps here, since the children are node, jest
//! and cargo runs that hit EMFILE at 256 themselves.
//!
//! Because children get it, the target is a modest fixed number rather than
//! the hard limit (often unlimited) or `kern.maxfilesperproc` (~120k): 1024
//! is the usual Linux default, so a child sees nothing unusual, and it still
//! fits ~230 terminals. Some programs size tables by the limit or close every
//! fd up to it before exec, which is cheap at 1024 and not at 120k.

/// Linux's usual default soft limit; see the module doc for why not higher.
const TARGET: u64 = 1024;

#[cfg_attr(not(unix), allow(dead_code))]
/// The soft limit to ask for, or `None` to leave it. Never lowers it, and
/// never asks for more than the hard limit.
fn target(soft: u64, hard: u64) -> Option<u64> {
    let t = TARGET.min(hard);
    (t > soft).then_some(t)
}

/// Returns `(before, after)`.
#[cfg(unix)]
pub fn raise() -> Option<(u64, u64)> {
    let mut rl: libc::rlimit = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) } != 0 {
        return None;
    }
    let before = rl.rlim_cur as u64;
    let Some(t) = target(before, rl.rlim_max as u64) else {
        return Some((before, before));
    };
    rl.rlim_cur = t as libc::rlim_t;
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &rl) } != 0 {
        return Some((before, before));
    }
    Some((before, t))
}

#[cfg(not(unix))]
pub fn raise() -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::target;

    #[test]
    fn target_raises_low_limits_only() {
        // Dock launch: soft 256, hard unlimited (RLIM_INFINITY).
        assert_eq!(target(256, u64::MAX), Some(1024));
        // A hard limit below the target caps it.
        assert_eq!(target(256, 512), Some(512));
        // Already at or above the target (Linux default, a raised shell): untouched.
        assert_eq!(target(1024, u64::MAX), None);
        assert_eq!(target(1_048_576, u64::MAX), None);
        // Hard limit already reached.
        assert_eq!(target(256, 256), None);
    }

    // Run the test binary under `ulimit -n 256` to exercise the Dock-launch
    // case for real; under a normal shell it checks the no-op path.
    #[cfg(unix)]
    #[test]
    fn raise_sets_the_kernel_limit() {
        let (before, after) = super::raise().expect("getrlimit");
        let mut rl: libc::rlimit = unsafe { std::mem::zeroed() };
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl) };
        assert_eq!(rl.rlim_cur as u64, after);
        assert_eq!(after, target(before, rl.rlim_max as u64).unwrap_or(before));
        eprintln!("RLIMIT_NOFILE soft {before} -> {after}");
    }
}
