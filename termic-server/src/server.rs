// The whole server, unix only: included by main.rs (see there).

mod daemon;
mod detect;
mod pty;
mod session;
mod state;
mod util;
mod verbs;

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// How long `bridge` waits for a daemon it started to answer.
const START_WAIT: Duration = Duration::from_secs(5);
/// How long `stop` waits for the daemon to exit.
const STOP_WAIT: Duration = Duration::from_secs(10);
/// Concurrent client connections.
const MAX_CONNS: usize = 64;
const USAGE: &str = "usage: termic-server <bridge|daemon|status|stop|version>";

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let code = match cmd.as_str() {
        "bridge" => bridge(),
        "daemon" => run_daemon(),
        "status" => status(),
        "stop" => stop(),
        "version" | "--version" | "-V" => {
            println!("termic-server {}", crate::util::version());
            0
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            0
        }
        _ => {
            eprintln!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

fn fail(msg: impl std::fmt::Display) -> i32 {
    eprintln!("termic-server: {msg}");
    1
}

// ───────────────────────────── lock / pid ────────────────────────────

/// The pid file doubles as the daemon's lock: the daemon holds an
/// exclusive flock on it for its whole life. A stale pid in a file nobody
/// has locked is never trusted (that pid may belong to anything by now).
fn open_pid(dir: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(util::pid_path(dir))
}

fn try_flock(f: &File, op: libc::c_int) -> bool {
    // SAFETY: a valid fd we own.
    unsafe { libc::flock(f.as_raw_fd(), op | libc::LOCK_NB) == 0 }
}

/// The running daemon's pid, if one holds the lock.
fn running_pid(dir: &Path) -> Option<i32> {
    let mut f = File::open(util::pid_path(dir)).ok()?;
    if try_flock(&f, libc::LOCK_SH) {
        return None;
    }
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    s.trim().parse().ok()
}

// ───────────────────────────── daemon ────────────────────────────────

fn run_daemon() -> i32 {
    let dir = util::data_dir();
    if let Err(e) = util::ensure_private_dir(&dir) {
        return fail(e);
    }
    util::init_log(util::log_path(&dir));
    let mut lock = match open_pid(&dir) {
        Ok(f) => f,
        Err(e) => return fail(format!("{}: {e}", util::pid_path(&dir).display())),
    };
    if !try_flock(&lock, libc::LOCK_EX) {
        // Another daemon owns this dir (two bridges raced to start one).
        return 0;
    }
    let sock = util::sock_path(&dir);
    if sock.as_os_str().len() > 100 {
        return fail(format!("{} is too long for a unix socket path; set TERMIC_SERVER_HOME to a shorter directory", sock.display()));
    }
    // We hold the lock, so whatever socket is there belongs to no one.
    let _ = std::fs::remove_file(&sock);

    // The socket is created 0600 (umask), not chmodded after: no window in
    // which another user could connect.
    // SAFETY: umask has no preconditions; restored right after bind.
    let old = unsafe { libc::umask(0o177) };
    let listener = UnixListener::bind(&sock);
    unsafe { libc::umask(old) };
    let listener = match listener {
        Ok(l) => l,
        Err(e) => return fail(format!("{}: {e}", sock.display())),
    };
    let _ = lock.set_len(0);
    let _ = writeln!(lock, "{}", std::process::id());

    let st = match state::State::load(&dir) {
        Ok(s) => s,
        Err(e) => return fail(format!("could not read state.json: {e}")),
    };
    let quiet = std::env::var("TERMIC_SERVER_QUIET_MS").ok().and_then(|v| v.parse().ok()).map(Duration::from_millis).unwrap_or(Duration::from_secs(2));
    let d = daemon::Daemon::new(dir.clone(), st, quiet);
    util::log(&format!("daemon {} started (pid {}), socket {}", crate::util::version(), std::process::id(), sock.display()));
    {
        let d = d.clone();
        std::thread::spawn(move || d.monitor());
    }
    {
        let d = d.clone();
        let sig = match signal_pipe() {
            Ok(f) => f,
            Err(e) => return fail(format!("could not set up signals: {e}")),
        };
        std::thread::spawn(move || {
            let mut b = [0u8; 1];
            let mut sig = sig;
            let _ = sig.read(&mut b);
            util::log(&format!("signal {}: stopping, hanging up every agent", b[0]));
            d.hangup_all();
            exit_daemon(&d.dir);
        });
    }

    let conns = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if !same_user(&stream) {
            util::log("refused a connection from another user");
            continue;
        }
        if conns.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
            conns.fetch_sub(1, Ordering::SeqCst);
            util::log("refused a connection: too many clients");
            continue;
        }
        let (d, conns) = (d.clone(), conns.clone());
        std::thread::spawn(move || {
            session::serve(d, stream);
            conns.fetch_sub(1, Ordering::SeqCst);
        });
    }
    0
}

/// Remove the socket and pid file and exit: the next `bridge` starts a
/// daemon from the binary installed now.
pub fn exit_daemon(dir: &Path) -> ! {
    let _ = std::fs::remove_file(util::sock_path(dir));
    let _ = std::fs::remove_file(util::pid_path(dir));
    std::process::exit(0);
}

static SIGNAL_FD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let b = sig as u8;
    // SAFETY: write is async-signal-safe; the fd is a pipe we own.
    unsafe { libc::write(SIGNAL_FD.load(Ordering::Relaxed), &b as *const u8 as *const libc::c_void, 1) };
}

/// SIGTERM and SIGINT, as bytes on a pipe a thread reads. A handler
/// rather than a blocked mask plus sigwait, so what agents inherit never
/// depends on the spawn path resetting the mask (std's does today): a
/// caught signal always resets to the default at exec.
fn signal_pipe() -> io::Result<File> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: fds is valid for pipe to write; both ends get FD_CLOEXEC so
    // no child inherits them.
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return Err(io::Error::last_os_error());
        }
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        SIGNAL_FD.store(fds[1], Ordering::Relaxed);
        for sig in [libc::SIGTERM, libc::SIGINT] {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_signal as *const () as usize;
            libc::sigemptyset(&mut sa.sa_mask);
            sa.sa_flags = libc::SA_RESTART;
            if libc::sigaction(sig, &sa, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(File::from_raw_fd(fds[0]))
    }
}

/// The socket is 0600 in a 0700 dir; this is the belt to those braces.
fn same_user(s: &UnixStream) -> bool {
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    peer_uid(s).is_some_and(|u| u == me)
}

#[cfg(target_os = "linux")]
fn peer_uid(s: &UnixStream) -> Option<libc::uid_t> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: cred and len are valid for getsockopt to write.
    let rc = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
    (rc == 0).then_some(cred.uid)
}

#[cfg(not(target_os = "linux"))]
fn peer_uid(s: &UnixStream) -> Option<libc::uid_t> {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: uid and gid are valid for getpeereid to write.
    let rc = unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) };
    (rc == 0).then_some(uid)
}

// ───────────────────────────── bridge ────────────────────────────────

/// What ssh runs: connect stdio to the daemon, starting it if needed.
fn bridge() -> i32 {
    let dir = util::data_dir();
    if let Err(e) = util::ensure_private_dir(&dir) {
        return fail(e);
    }
    let sock = util::sock_path(&dir);
    let stream = match UnixStream::connect(&sock) {
        Ok(s) => s,
        Err(_) => {
            if let Err(e) = start_daemon(&dir) {
                return fail(format!("could not start the daemon: {e}"));
            }
            match wait_for_socket(&sock) {
                Some(s) => s,
                None => return fail(format!("the daemon did not start; see {}", util::log_path(&dir).display())),
            }
        }
    };
    let Ok(mut up) = stream.try_clone() else { return fail("socket clone failed") };
    let mut down = stream;
    // Raw fds, unbuffered: Rust's stdout is line-buffered and frames are
    // binary. ManuallyDrop so the fds are not closed twice.
    let mut stdin = ManuallyDrop::new(unsafe { File::from_raw_fd(0) });
    let mut stdout = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    std::thread::spawn(move || {
        pump(&mut *stdin, &mut up);
        // ssh closed our stdin: tell the daemon this client is done.
        let _ = up.shutdown(std::net::Shutdown::Write);
    });
    pump(&mut down, &mut *stdout);
    0
}

/// Copy until EOF or an error, forwarding each read at once. Not
/// `io::copy`: on Linux it splices between a pipe and a socket, which
/// stalled frames in testing.
fn pump(from: &mut impl Read, to: &mut impl Write) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                if to.write_all(&buf[..n]).and_then(|_| to.flush()).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

fn start_daemon(dir: &Path) -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let log = OpenOptions::new().create(true).append(true).mode(0o600).open(util::log_path(dir))?;
    let mut cmd = Command::new(exe);
    cmd.arg("daemon").stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log).current_dir(util::home());
    // SAFETY: setsid is async-signal-safe. A new session: the daemon is not
    // in ssh's process group and outlives the connection that started it.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map(|_| ())
}

/// Connect retries with a short, growing backoff, bounded by START_WAIT.
/// A one-off at startup: the daemon has no "ready" signal to block on.
fn wait_for_socket(sock: &Path) -> Option<UnixStream> {
    let until = Instant::now() + START_WAIT;
    let mut step = Duration::from_millis(10);
    while Instant::now() < until {
        if let Ok(s) = UnixStream::connect(sock) {
            return Some(s);
        }
        std::thread::sleep(step);
        step = (step * 2).min(Duration::from_millis(200));
    }
    None
}

// ───────────────────────────── status / stop ─────────────────────────

fn status() -> i32 {
    let dir = util::data_dir();
    match running_pid(&dir) {
        Some(pid) => {
            println!("running (pid {pid}), version {}, data in {}", crate::util::version(), dir.display());
            0
        }
        None => {
            println!("not running (data in {})", dir.display());
            3
        }
    }
}

fn stop() -> i32 {
    let dir = util::data_dir();
    let Some(pid) = running_pid(&dir) else {
        println!("not running");
        return 0;
    };
    // SAFETY: the pid is the lock holder's, so it is the daemon.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return fail(format!("could not signal pid {pid}: {}", io::Error::last_os_error()));
    }
    // Wait for the lock to be released (the daemon exiting), blocking on
    // flock in a thread so the wait is bounded without polling.
    let (tx, rx) = mpsc::channel();
    let path = util::pid_path(&dir);
    std::thread::spawn(move || {
        if let Ok(f) = File::open(&path) {
            // SAFETY: a valid fd we own.
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_SH) };
        }
        let _ = tx.send(());
    });
    match rx.recv_timeout(STOP_WAIT) {
        Ok(()) => {
            println!("stopped (pid {pid})");
            0
        }
        Err(_) => fail(format!("pid {pid} did not stop within {} s", STOP_WAIT.as_secs())),
    }
}
