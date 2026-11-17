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
    sync::OnceLock,
};

/// Where the hooks write, set once by `install`.
static LOG: OnceLock<PathBuf> = OnceLock::new();

/// The log, if anything has been written to it: what the Report a bug button
/// shows the user to attach.
pub(crate) fn existing() -> Option<&'static Path> {
    let path = LOG.get()?;
    fs::metadata(path).ok().filter(|m| m.len() > 0).map(|_| path.as_path())
}

/// Past this size the log moves to `panic.log.1` before the next entry, so a
/// panic in a loop cannot fill the disk. One generation is enough: the newest
/// entry is the one anyone reads.
const MAX_BYTES: u64 = 512 * 1024;

/// Install the hooks. Call once, first thing in `run()`.
pub(crate) fn install(path: PathBuf) {
    let _ = LOG.set(path.clone());
    #[cfg(target_os = "macos")]
    objc::install();
    #[cfg(unix)]
    signals::install(&path);
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

/// An uncaught Objective-C exception is not a Rust panic, so the panic hook
/// never sees it. It gets its own entry, in the same `=== ` header format so
/// one reader splits both. Not covered: one AppKit catches and logs itself.
///
/// Nor one thrown while handling an event (GH #429, #439). tao's
/// `sendEvent:` override is a Rust `extern "C"` fn calling
/// `[NSApplication sendEvent:]`, so an exception from AppKit or WebKit
/// unwinds into a frame that cannot unwind: Rust aborts with
/// `panic_cannot_unwind`, the exception never counts as uncaught, and the
/// log got only that panic. `guard_send_event` catches it one frame lower,
/// inside NSApplication's own implementation, records it, and drops that one
/// event, which is what a plain Cocoa app's run loop does by default.
#[cfg(target_os = "macos")]
mod objc {
    use std::{panic::AssertUnwindSafe, sync::OnceLock};
    use objc2::{msg_send, rc::Retained, runtime::{AnyClass, AnyObject, Imp, Sel}, sel};
    use objc2_foundation::{NSArray, NSException, NSSetUncaughtExceptionHandler, NSString};

    pub(super) fn install() {
        // SAFETY: the handler has the C signature Foundation calls it with.
        unsafe { NSSetUncaughtExceptionHandler(on_exception as *const () as *mut core::ffi::c_void) }
        guard_send_event();
    }

    /// NSApplication's own `sendEvent:`, which ours replaces.
    static ORIGINAL: OnceLock<Imp> = OnceLock::new();

    /// Swap `-[NSApplication sendEvent:]` for one that runs the original
    /// inside an Objective-C catch. tao's subclass reaches it through
    /// `super`, so this works before or after tao registers that subclass.
    fn guard_send_event() {
        let sel = sel!(sendEvent:);
        let Some(method) = AnyClass::get(c"NSApplication").and_then(|c| c.instance_method(sel)) else { return };
        if ORIGINAL.get().is_some() { return }
        // SAFETY: `guarded` has the method's signature, (self, _cmd, NSEvent*) -> void.
        let old = unsafe { method.set_implementation(std::mem::transmute::<SendEvent, Imp>(guarded)) };
        let _ = ORIGINAL.set(old);
    }

    type SendEvent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

    unsafe extern "C-unwind" fn guarded(this: *mut AnyObject, sel: Sel, event: *mut AnyObject) {
        let Some(&original) = ORIGINAL.get() else { return };
        // SAFETY: the IMP this one replaced, called with the arguments it was given.
        let original = unsafe { std::mem::transmute::<Imp, SendEvent>(original) };
        survive(AssertUnwindSafe(|| unsafe { original(this, sel, event) }));
    }

    /// Run `f`; an Objective-C exception it throws is recorded instead of
    /// propagating. A Rust panic still passes through.
    pub(super) fn survive(f: impl FnOnce() + std::panic::UnwindSafe) {
        if let Err(Some(e)) = objc2::exception::catch(f) {
            on_exception(Retained::as_ptr(&e) as *mut NSException);
        }
    }

    pub(super) extern "C" fn on_exception(e: *mut NSException) {
        let (Some(path), Some(e)) = (super::LOG.get(), unsafe { e.as_ref() }) else { return };
        let reason = e.reason().map(|r| r.to_string()).unwrap_or_default();
        // Not the typed `callStackSymbols()`: it panics on the nil an exception
        // that was never raised has, and a panic here aborts with no entry.
        let symbols: Option<Retained<NSArray<NSString>>> = unsafe { msg_send![e, callStackSymbols] };
        let stack: Vec<String> = symbols.iter().flat_map(|a| a.iter()).map(|s| s.to_string()).collect();
        let entry = super::format_exception(
            &chrono::Local::now().to_rfc3339(), &e.name().to_string(), &reason, &stack.join("\n"));
        let _ = super::append(path, &entry);
    }
}

fn format_exception(when: &str, name: &str, reason: &str, stack: &str) -> String {
    format!(
        "=== {when} termic {} Objective-C exception {name}\n{reason}\n{stack}\n\n",
        env!("CARGO_PKG_VERSION"),
    )
}

/// The web content process was killed and the webview reloaded itself. To the
/// user the interface just resets, and the OS leaves no report for it: the app
/// did not crash, so this line is the only trace.
#[cfg(target_os = "macos")]
pub(crate) fn record_webcontent_terminated(window: &str) {
    if let Some(path) = LOG.get() {
        let entry = format_webcontent_terminated(&chrono::Local::now().to_rfc3339(), window);
        let _ = append(path, &entry);
    }
}

#[cfg(any(target_os = "macos", test))]
fn format_webcontent_terminated(when: &str, window: &str) -> String {
    format!(
        "=== {when} termic {} webcontent-terminated window={window}\nthe web content process ended and the webview was reloaded\n\n",
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

#[cfg(unix)]
mod signals {
    use libc::c_int;
    use std::{ffi::CString, os::unix::ffi::OsStrExt, path::Path, sync::OnceLock};

    const SIGNALS: [(c_int, &str); 4] = [
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGABRT, "SIGABRT"),
    ];

    /// Built at install: the handler cannot allocate, so it only reads this.
    static PATH: OnceLock<CString> = OnceLock::new();
    /// What each signal did before, written once at install and read by the
    /// handler, which hands the signal back to it after logging.
    static mut PREVIOUS: [libc::sigaction; 4] = unsafe { std::mem::zeroed() };

    pub(super) fn install(path: &Path) {
        let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else { return };
        if PATH.set(c_path).is_err() {
            return;
        }
        for (i, (signal, _)) in SIGNALS.iter().enumerate() {
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = on_signal as extern "C" fn(c_int) as usize;
                // On the alternate stack Rust sets up per thread, so a stack
                // overflow (SIGSEGV with no stack left) can still run this.
                action.sa_flags = libc::SA_ONSTACK;
                libc::sigemptyset(&mut action.sa_mask);
                libc::sigaction(*signal, &action, std::ptr::addr_of_mut!(PREVIOUS[i]));
            }
        }
    }

    /// Only async-signal-safe calls from here on: no allocation, no locks, no
    /// formatting machinery. `open`, `write`, `close`, `time`, `sigaction` and
    /// `raise` are all on the safe list.
    extern "C" fn on_signal(signal: c_int) {
        let mut buf = [0u8; 160];
        let name = SIGNALS.iter().find(|(s, _)| *s == signal).map_or("?", |(_, n)| *n);
        let now = unsafe { libc::time(std::ptr::null_mut()) } as u64;
        let len = render(&mut buf, now, signal, name);
        if let Some(path) = PATH.get() {
            unsafe {
                let fd = libc::open(
                    path.as_ptr(),
                    libc::O_WRONLY | libc::O_APPEND | libc::O_CREAT | libc::O_CLOEXEC,
                    0o644,
                );
                if fd >= 0 {
                    libc::write(fd, buf.as_ptr().cast(), len);
                    libc::close(fd);
                }
            }
        }
        // Hand the signal back to whatever handled it before (Rust's own
        // stack-overflow handler, or the default that kills the process), so
        // the crash report and exit status stay what they would have been.
        if let Some(i) = SIGNALS.iter().position(|(s, _)| *s == signal) {
            unsafe {
                libc::sigaction(signal, std::ptr::addr_of!(PREVIOUS[i]), std::ptr::null_mut());
                libc::raise(signal);
            }
        }
    }

    /// `=== unix:<secs> termic <version> signal <n> <NAME>\n\n` into `buf`,
    /// returning its length. Hand-rolled integer formatting: `format!`
    /// allocates, which a signal handler must not do. Anything that does not
    /// fit is cut off, never overrun.
    pub(super) fn render(buf: &mut [u8], secs: u64, signal: c_int, name: &str) -> usize {
        let mut n = 0;
        put(buf, &mut n, b"=== unix:");
        put_u64(buf, &mut n, secs);
        put(buf, &mut n, b" termic ");
        put(buf, &mut n, env!("CARGO_PKG_VERSION").as_bytes());
        put(buf, &mut n, b" signal ");
        put_u64(buf, &mut n, signal.max(0) as u64);
        put(buf, &mut n, b" ");
        put(buf, &mut n, name.as_bytes());
        put(buf, &mut n, b"\n\n");
        n
    }

    fn put(buf: &mut [u8], n: &mut usize, bytes: &[u8]) {
        let room = buf.len() - *n;
        let take = bytes.len().min(room);
        buf[*n..*n + take].copy_from_slice(&bytes[..take]);
        *n += take;
    }

    fn put_u64(buf: &mut [u8], n: &mut usize, mut value: u64) {
        let mut digits = [0u8; 20];
        let mut i = digits.len();
        loop {
            i -= 1;
            digits[i] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        put(buf, n, &digits[i..]);
    }
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
    fn an_objc_exception_entry_shares_the_panic_header() {
        let e = format_exception("t0", "NSRangeException", "index 3 beyond bounds", "0 CoreFoundation");
        assert!(e.starts_with("=== t0 termic "), "{e}");
        assert!(e.contains("Objective-C exception NSRangeException\nindex 3 beyond bounds\n0 CoreFoundation"), "{e}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_objc_handler_records_a_real_exception() {
        use objc2_foundation::{NSException, NSString};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panic.log");
        // The only test that sets LOG: it is process-wide and set-once.
        LOG.set(path.clone()).unwrap();
        // SAFETY: a plain exception object, never raised.
        let e = unsafe { NSException::exceptionWithName_reason_userInfo(
            &NSString::from_str("NSRangeException"), Some(&NSString::from_str("index 3 beyond bounds")), None) };
        objc::on_exception(objc2::rc::Retained::as_ptr(&e) as *mut NSException);
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("Objective-C exception NSRangeException\nindex 3 beyond bounds"), "{text}");
        assert_eq!(existing(), Some(path.as_path()));

        // Shares LOG with the case above. A RAISED exception inside the guard
        // returns normally and lands in the log with its stack.
        objc::survive(|| {
            let e = unsafe { NSException::exceptionWithName_reason_userInfo(
                &NSString::from_str("NSInternalInconsistencyException"), Some(&NSString::from_str("thrown during an event")), None) };
            e.raise();
        });
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("Objective-C exception NSInternalInconsistencyException\nthrown during an event\n"), "{text}");
        assert!(text.contains("CoreFoundation"), "a raised exception carries its stack: {text}");
    }

    /// The real path: a child process raises an exception nothing catches,
    /// Foundation calls the installed handler, then the process aborts. Raised
    /// on a GCD thread, because a Rust thread's catch_unwind would claim it first.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_uncaught_objc_exception_crashes_with_an_entry() {
        const CHILD: &str = "TERMIC_TEST_OBJC_CRASH_LOG";
        if let Some(path) = std::env::var_os(CHILD) {
            install(PathBuf::from(path));
            extern "C" fn raise(_: *mut core::ffi::c_void) {
                use objc2_foundation::{NSException, NSString};
                // SAFETY: a plain exception object.
                let e = unsafe { NSException::exceptionWithName_reason_userInfo(
                    &NSString::from_str("NSRangeException"), Some(&NSString::from_str("boom from gcd")), None) };
                e.raise();
            }
            unsafe extern "C" {
                fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut core::ffi::c_void;
                fn dispatch_async_f(q: *mut core::ffi::c_void, ctx: *mut core::ffi::c_void, f: extern "C" fn(*mut core::ffi::c_void));
            }
            unsafe { dispatch_async_f(dispatch_get_global_queue(0, 0), std::ptr::null_mut(), raise) };
            loop { std::thread::park(); }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("panic.log");
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "panic_log::tests::an_uncaught_objc_exception_crashes_with_an_entry", "--test-threads=1"])
            .env(CHILD, &path)
            .output().unwrap();
        assert!(!out.status.success(), "the child should have aborted");
        let text = fs::read_to_string(&path).unwrap_or_default();
        assert!(text.contains("Objective-C exception NSRangeException\nboom from gcd\n"), "{text}");
        assert!(text.contains("CoreFoundation"), "a raised exception carries its stack: {text}");
    }

    /// GH #429: the crash's shape. A nounwind `extern "C"` frame (tao's
    /// `send_event`) calls `[NSApplication sendEvent:]`, and AppKit throws.
    /// Without the guard the child aborts with `panic_cannot_unwind`; with
    /// it the call returns and the exception is in the log.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_exception_during_an_event_is_survived_and_recorded() {
        use objc2::{class, msg_send, runtime::{AnyObject, Imp, Sel}, sel};
        const CHILD: &str = "TERMIC_TEST_OBJC_EVENT_LOG";
        if let Some(path) = std::env::var_os(CHILD) {
            unsafe extern "C-unwind" fn appkit_throws(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {
                use objc2_foundation::{NSException, NSString};
                let e = unsafe { NSException::exceptionWithName_reason_userInfo(
                    &NSString::from_str("NSInternalInconsistencyException"), Some(&NSString::from_str("thrown in sendEvent")), None) };
                e.raise();
            }
            // Stand-in for AppKit's implementation, installed BEFORE the guard wraps it.
            let m = class!(NSApplication).instance_method(sel!(sendEvent:)).unwrap();
            type F = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);
            unsafe { m.set_implementation(std::mem::transmute::<F, Imp>(appkit_throws)) };
            if std::env::var_os("TERMIC_TEST_NO_GUARD").is_none() {
                install(PathBuf::from(path));
            }
            extern "C" fn tao_send_event(app: &AnyObject) {
                let none: *mut AnyObject = std::ptr::null_mut();
                let _: () = unsafe { msg_send![app, sendEvent: none] };
            }
            let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
            tao_send_event(unsafe { &*app });
            println!("survived");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("panic.log");
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "panic_log::tests::an_exception_during_an_event_is_survived_and_recorded", "--test-threads=1", "--nocapture"])
            .env(CHILD, &path)
            .output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && stdout.contains("survived"), "{stdout}\n{}", String::from_utf8_lossy(&out.stderr));
        let text = fs::read_to_string(&path).unwrap_or_default();
        assert!(text.contains("Objective-C exception NSInternalInconsistencyException\nthrown in sendEvent\n"), "{text}");
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

    #[cfg(unix)]
    #[test]
    fn a_signal_entry_is_one_header_line_and_never_overruns() {
        let mut buf = [0u8; 160];
        let n = signals::render(&mut buf, 1_700_000_000, 11, "SIGSEGV");
        let text = std::str::from_utf8(&buf[..n]).unwrap();
        assert!(text.starts_with("=== unix:1700000000 termic "), "{text}");
        assert!(text.ends_with(" signal 11 SIGSEGV\n\n"), "{text}");
        // A buffer too small for the entry is cut off, not overrun.
        let mut tiny = [0u8; 12];
        assert_eq!(signals::render(&mut tiny, 1_700_000_000, 11, "SIGSEGV"), 12);
    }

    /// The crashing half runs in a child process: a fatal signal cannot be
    /// observed from inside the process that takes it.
    #[cfg(unix)]
    #[test]
    fn a_fatal_signal_leaves_an_entry_and_still_kills_the_process() {
        const ME: &str = "panic_log::tests::a_fatal_signal_leaves_an_entry_and_still_kills_the_process";
        if let Some(log) = std::env::var_os("PANIC_LOG_CHILD") {
            signals::install(Path::new(&log));
            // SIGABRT, what `abort()` raises after `panic_cannot_unwind`. A
            // SIGSEGV raised by hand would not do: Rust's own SIGSEGV handler
            // only expects a real fault and lets a synthetic one run on.
            unsafe { libc::raise(libc::SIGABRT) };
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("panic.log");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", ME, "--nocapture", "--test-threads=1"])
            .env("PANIC_LOG_CHILD", &log)
            .status()
            .unwrap();
        let text = fs::read_to_string(&log).unwrap_or_default();
        assert!(text.contains(" signal 6 SIGABRT"), "{text}");
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGABRT), "the signal must still end the process");
    }

    #[test]
    fn a_webcontent_entry_names_the_window() {
        let entry = format_webcontent_terminated("t0", "main");
        assert!(entry.starts_with("=== t0 termic "));
        assert!(entry.contains(" webcontent-terminated window=main\n"));
    }
}
