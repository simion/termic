//! A panic leaves a line on disk.
//!
//! Termic is a GUI app: stderr goes nowhere, so a panic that aborts the process
//! (the main thread cannot unwind across AppKit, `panic_cannot_unwind`) used to
//! leave a crash report with a stack but no message and no panic site. The hook
//! runs BEFORE unwinding starts, so it still has the full backtrace of the code
//! that panicked, which the abort throws away.
//!
//! Best effort and silent: a hook that panics or blocks would turn one crash
//! into two, so every step ignores its own errors. The previous hook still runs
//! first, so the default stderr output (and `RUST_BACKTRACE`) is unchanged.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    panic::PanicHookInfo,
    path::{Path, PathBuf},
};

/// Past this size the log moves to `panic.log.1` before the next entry, so a
/// panic in a loop cannot fill the disk. One generation is enough: the newest
/// entry is the one anyone reads.
const MAX_BYTES: u64 = 512 * 1024;

/// Install the hook. Call once, first thing in `run()`.
pub(crate) fn install(path: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        let entry = render(info, &std::backtrace::Backtrace::force_capture().to_string());
        let _ = append(&path, &entry);
    }));
}

fn render(info: &PanicHookInfo<'_>, backtrace: &str) -> String {
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(non-string payload)".into());
    let at = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "(unknown location)".into());
    let thread = std::thread::current();
    format_entry(
        &chrono::Local::now().to_rfc3339(),
        thread.name().unwrap_or("(unnamed)"),
        &at,
        &message,
        backtrace,
    )
}

fn format_entry(when: &str, thread: &str, at: &str, message: &str, backtrace: &str) -> String {
    format!(
        "=== {when} termic {} thread '{thread}' panicked at {at}\n{message}\n{backtrace}\n\n",
        env!("CARGO_PKG_VERSION"),
    )
}

fn append(path: &Path, entry: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        let _ = fs::rename(path, old);
    }
    OpenOptions::new().create(true).append(true).open(path)?.write_all(entry.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_accumulate_and_carry_the_site_and_message() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("panic.log");
        append(&path, &format_entry("t0", "main", "src/a.rs:1:2", "boom", "frames")).unwrap();
        append(&path, &format_entry("t1", "worker", "src/b.rs:3:4", "bang", "frames")).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("thread 'main' panicked at src/a.rs:1:2\nboom"));
        assert!(text.contains("thread 'worker' panicked at src/b.rs:3:4\nbang"));
        assert!(text.find("boom") < text.find("bang"));
    }

    #[test]
    fn an_oversized_log_rotates_once_instead_of_growing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panic.log");
        fs::write(&path, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        append(&path, "fresh\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\n");
        assert_eq!(fs::metadata(dir.path().join("panic.log.1")).unwrap().len(), MAX_BYTES + 1);
    }

    #[test]
    fn the_hook_records_a_real_panic_with_its_backtrace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panic.log");
        let inner = path.clone();
        // Not `install`: the process-wide hook is shared with every other test.
        // This wires the same render + append pair around a private catch.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let bt = std::backtrace::Backtrace::force_capture().to_string();
            let _ = append(&inner, &render(info, &bt));
        }));
        let _ = std::panic::catch_unwind(|| panic!("recorded {}", 7));
        std::panic::set_hook(prev);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("recorded 7"), "{text}");
        assert!(text.contains("panic_log.rs"), "{text}");
    }
}
