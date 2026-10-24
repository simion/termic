//! The accept loop every broker listener runs. Three things the agent can
//! otherwise turn against the app:
//!   - shutdown is a self-pipe, never a connection to the listener's own
//!     address: the gh socket sits where a caged agent could unlink it, and
//!     then a wake-by-connect never lands and `Drop` joins forever.
//!   - an accept error (EMFILE) backs off instead of spinning a core.
//!   - live connections are capped, so a flood cannot exhaust threads, and
//!     a peer that can be refused cheaply (the gh socket's pid check) is
//!     refused before it takes a slot, so another task cannot fill them.
//!     The base-URL endpoint can only tell its own agent by the marker in
//!     the request, so a same-user process that floods its port can still
//!     crowd it out (docs/sandbox.md "Marker-only deliveries").

use std::io;
use std::net::{TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Connections one listener serves at once; past it a new one is closed.
const MAX_CONNS: usize = 64;
/// Same backoff as proxy.rs: an accept error usually means EMFILE.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);

pub(crate) trait Accept: AsRawFd + Send + 'static {
    type Conn: Send + 'static;
    fn accept_one(&self) -> io::Result<Self::Conn>;
}

// the listener is non-blocking (so a spurious wake cannot park the loop), and
// on macOS an accepted socket inherits that flag: put it back.
impl Accept for UnixListener {
    type Conn = UnixStream;
    fn accept_one(&self) -> io::Result<UnixStream> {
        let (s, _) = self.accept()?;
        s.set_nonblocking(false)?;
        Ok(s)
    }
}

impl Accept for TcpListener {
    type Conn = TcpStream;
    fn accept_one(&self) -> io::Result<TcpStream> {
        let (s, _) = self.accept()?;
        s.set_nonblocking(false)?;
        Ok(s)
    }
}

/// A running accept loop. Dropping it stops the loop and joins it; handlers
/// already running finish on their own (each has a read timeout).
pub(crate) struct Acceptor {
    wake: OwnedFd,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for Acceptor {
    fn drop(&mut self) {
        // SAFETY: one byte from a valid buffer to an fd we own.
        unsafe { libc::write(self.wake.as_raw_fd(), b"x".as_ptr().cast(), 1) };
        if let Some(t) = self.thread.take() { let _ = t.join(); }
    }
}

fn cloexec_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: pipe writes two fds into the array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 { return Err(io::Error::last_os_error()); }
    // SAFETY: both fds were just returned by pipe and are owned here.
    let (r, w) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    // PTYs are spawned from this process: never hand them our pipe.
    for fd in [&r, &w] {
        // SAFETY: fcntl on an fd we own.
        unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    Ok((r, w))
}

/// Serve `l` on its own thread, each connection on a thread of its own.
/// `admit` runs on the accept thread before a connection takes a slot; it
/// must be quick and may answer and drop the connection by returning false.
pub(crate) fn spawn<L: Accept>(
    l: L,
    admit: impl Fn(&L::Conn) -> bool + Send + 'static,
    handle: impl Fn(L::Conn) + Send + Sync + 'static,
) -> io::Result<Acceptor> {
    set_nonblocking(l.as_raw_fd())?;
    let (rd, wake) = cloexec_pipe()?;
    let handle = Arc::new(handle);
    let live = Arc::new(AtomicUsize::new(0));
    let thread = thread::spawn(move || loop {
        let mut fds = [
            libc::pollfd { fd: l.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: rd.as_raw_fd(), events: libc::POLLIN, revents: 0 },
        ];
        // SAFETY: two valid pollfds; blocks until one is ready, no timeout.
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted { continue; }
            return;
        }
        if fds[1].revents != 0 || fds[0].revents & (libc::POLLERR | libc::POLLNVAL) != 0 { return; }
        if fds[0].revents & libc::POLLIN == 0 { continue; }
        match l.accept_one() {
            Ok(c) => {
                if !admit(&c) { continue; }
                if live.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
                    live.fetch_sub(1, Ordering::SeqCst);
                    continue; // dropping `c` closes it
                }
                let (h, live) = (handle.clone(), live.clone());
                thread::spawn(move || {
                    h(c);
                    live.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => thread::sleep(ACCEPT_ERROR_BACKOFF),
        }
    });
    Ok(Acceptor { wake, thread: Some(thread) })
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl get/set flags on a valid fd.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
