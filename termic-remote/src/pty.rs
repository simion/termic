//! The slave device path of a PTY master, handed to agent hooks as
//! `TERMIC_PTY` (docs/agent-hooks.md "Transport"). One function for the
//! desktop and termic-server, so a hook on a box writes into its agent's
//! terminal exactly as it does on the desktop.

/// The slave path (`/dev/ttysNNN`, `/dev/pts/N`) of the PTY master `fd`.
///
/// `ptsname` returns a pointer to a STATIC buffer and has no `_r` variant on
/// macOS, so two concurrent spawns could otherwise read each other's result.
/// The lock is held across the call and the copy, which is the whole
/// critical section.
#[cfg(unix)]
pub fn slave_path(fd: std::os::unix::io::RawFd) -> Option<String> {
    static PTSNAME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = PTSNAME_LOCK.lock().ok()?;
    // SAFETY: `fd` is a live pty master owned by the caller for the duration
    // of this call, and the returned pointer is copied before the lock drops.
    unsafe {
        let p = libc::ptsname(fd);
        if p.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned())
    }
}
