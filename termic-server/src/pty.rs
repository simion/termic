//! One agent PTY: the process, a ring of its recent output, and taps for
//! the clients watching it.
//!
//! Two threads per PTY, both blocking: a reader (output -> ring and taps)
//! and a waiter (child exit). Neither polls.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

/// The retained output (what a terminal open or resync replays).
pub const RING_BYTES: usize = 256 * 1024;
pub const ROWS: u16 = 40;
pub const COLS: u16 = 120;
const MIN_ROWS: u16 = 4;
const MAX_ROWS: u16 = 300;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;

pub enum TapMsg {
    Data(Vec<u8>),
    /// The PTY was resized to (rows, cols).
    Resize(u16, u16),
    /// The PTY ended: "exited" or "archived".
    Closed(String),
}

#[derive(Default)]
struct Inner {
    ring: VecDeque<u8>,
    /// Bytes ever written to the ring (more than its length = truncated).
    total: u64,
    taps: Vec<(u64, mpsc::Sender<TapMsg>)>,
    closed: Option<String>,
    exited: bool,
    last_output: Option<Instant>,
    last_input: Option<Instant>,
    /// A prompt delivery, or the spawn itself: activity without output,
    /// so a booting agent reads working, not idle, until it settles.
    last_prompt: Option<Instant>,
    /// The program turned bracketed paste on (ESC[?2004h).
    bracketed: bool,
    /// (rows, cols) now: a client sizes it (there is no screen here).
    size: (u16, u16),
    /// When a terminal was last opened or closed on it (detect.rs `seen`).
    seen: Option<Instant>,
    /// The last resize: the redraw that follows is not the agent's work.
    resized: Option<Instant>,
}

/// How long after a resize output counts as the program redrawing.
const REDRAW: std::time::Duration = std::time::Duration::from_millis(1000);

pub struct Pty {
    pub pid: Option<u32>,
    writer: Mutex<Box<dyn Write + Send>>,
    // Kept alive for the PTY's lifetime: dropping the master hangs it up.
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    inner: Mutex<Inner>,
    next_tap: AtomicU64,
}

/// What a PTY tells its owner: output after a quiet spell, or exit. The
/// owner wakes its state monitor; nothing is sent per chunk while busy.
pub type Notify = Arc<dyn Fn() + Send + Sync>;

impl Pty {
    /// Spawn `argv` in `cwd` with `env` on a fresh PTY. `quiet` is the
    /// window within which more output cannot change the work state, so
    /// the owner is only notified when output follows a quiet spell.
    pub fn spawn(argv: &[String], cwd: &str, env: &[(String, String)], quiet: std::time::Duration, notify: Notify) -> Result<Arc<Pty>, String> {
        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: ROWS, cols: COLS, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("could not open a pty: {e}"))?;
        let (prog, args) = argv.split_first().ok_or("empty command")?;
        let mut cmd = CommandBuilder::new(prog);
        cmd.args(args);
        cmd.cwd(cwd);
        // ssh's session variables describe a connection that will be gone.
        for k in ["SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT", "SSH_ORIGINAL_COMMAND"] {
            cmd.env_remove(k);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        // Where agent hooks write their OSCs: this terminal, as on the
        // desktop (docs/agent-hooks.md "Transport"). Set last, so a value
        // from the desktop's env (its own slave path) never wins.
        if let Some(path) = pair.master.as_raw_fd().and_then(termic_remote::pty::slave_path) {
            cmd.env("TERMIC_PTY", path);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("could not start {prog}: {e}"))?;
        // The slave must close here or the reader never sees EOF.
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let pty = Arc::new(Pty {
            pid: child.process_id(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            inner: Mutex::new(Inner { last_prompt: Some(Instant::now()), size: (ROWS, COLS), ..Default::default() }),
            next_tap: AtomicU64::new(1),
        });
        {
            let p = pty.clone();
            let notify = notify.clone();
            std::thread::spawn(move || p.read_loop(reader, quiet, notify));
        }
        {
            let p = pty.clone();
            std::thread::spawn(move || {
                let _ = child.wait();
                p.inner.lock().unwrap().exited = true;
                notify();
            });
        }
        Ok(pty)
    }

    fn read_loop(&self, mut reader: Box<dyn Read + Send>, quiet: std::time::Duration, notify: Notify) {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];
            let wake = {
                let mut g = self.inner.lock().unwrap();
                let now = Instant::now();
                let prev = [g.last_output, g.last_prompt].into_iter().flatten().max();
                // A full-screen program repaints on SIGWINCH: that is the
                // terminal changing size, not the agent doing anything. Nor
                // is a chunk of nothing but terminal queries: with no screen
                // attached here nothing answers Claude's cursor-position
                // request, so it asks again and again, and that stream kept
                // a finished task "working" for as long as it ran.
                if !g.resized.is_some_and(|r| now.duration_since(r) < REDRAW) && !only_queries(chunk) {
                    g.last_output = Some(now);
                }
                if let Some(on) = bracketed_toggle(chunk) {
                    g.bracketed = on;
                }
                g.ring.extend(chunk);
                let over = g.ring.len().saturating_sub(RING_BYTES);
                g.ring.drain(..over);
                g.total += n as u64;
                g.taps.retain(|(_, tx)| tx.send(TapMsg::Data(chunk.to_vec())).is_ok());
                prev.is_none_or(|t| now.duration_since(t) >= quiet)
            };
            if wake {
                notify();
            }
        }
        self.close_taps("exited");
        notify();
    }

    /// End every tap with `reason` (once; later calls keep the first).
    pub fn close_taps(&self, reason: &str) {
        let mut g = self.inner.lock().unwrap();
        if g.closed.is_none() {
            g.closed = Some(reason.to_string());
        }
        let why = g.closed.clone().unwrap_or_default();
        for (_, tx) in g.taps.drain(..) {
            let _ = tx.send(TapMsg::Closed(why.clone()));
        }
    }

    /// The backlog and a tap for everything after it, atomically, so not a
    /// byte is lost or doubled between the two.
    pub fn subscribe(&self) -> Result<(u64, Vec<u8>, mpsc::Receiver<TapMsg>), String> {
        self.subscribe_from(None).map(|(id, backlog, _, rx)| (id, backlog, rx))
    }

    /// `subscribe` for a client that already has the first `seen` bytes of
    /// the output: the backlog starts there, or at the oldest byte the ring
    /// still holds. Also returns where the backlog starts in the output.
    pub fn subscribe_from(&self, seen: Option<u64>) -> Result<(u64, Vec<u8>, u64, mpsc::Receiver<TapMsg>), String> {
        let mut g = self.inner.lock().unwrap();
        if let Some(why) = &g.closed {
            return Err(why.clone());
        }
        let (tx, rx) = mpsc::channel();
        let id = self.next_tap.fetch_add(1, Ordering::Relaxed);
        g.taps.push((id, tx));
        g.seen = Some(Instant::now());
        let oldest = g.total - g.ring.len() as u64;
        // A client that saw MORE than this PTY ever wrote saw another process
        // under the same claim (another desktop restarted it): it gets this
        // one's whole ring, not a clamp that skips its first bytes.
        let start = match seen {
            Some(s) if s <= g.total => s.max(oldest),
            _ => oldest,
        };
        let backlog = g.ring.iter().skip((start - oldest) as usize).copied().collect();
        Ok((id, backlog, start, rx))
    }

    /// The output from offset `from` on, as far as the ring still holds it,
    /// and where what it returns starts (later than `from` when the ring has
    /// moved past it).
    pub fn since(&self, from: u64) -> (Vec<u8>, u64) {
        let g = self.inner.lock().unwrap();
        let oldest = g.total - g.ring.len() as u64;
        let start = from.clamp(oldest, g.total);
        (g.ring.iter().skip((start - oldest) as usize).copied().collect(), start)
    }

    pub fn unsubscribe(&self, id: u64) {
        let mut g = self.inner.lock().unwrap();
        g.taps.retain(|(t, _)| *t != id);
        g.seen = Some(Instant::now());
    }

    /// Someone looked at the task another way (read its chat): what it
    /// finished is no longer news, as when a terminal is opened on it.
    pub fn mark_seen(&self) {
        self.inner.lock().unwrap().seen = Some(Instant::now());
    }

    /// (someone has its terminal open, when one was last opened or closed)
    pub fn watched(&self) -> (bool, Option<Instant>) {
        let g = self.inner.lock().unwrap();
        (!g.taps.is_empty(), g.seen)
    }

    /// The last `max` bytes of the ring, and whether older output is gone.
    pub fn tail(&self, max: usize) -> (Vec<u8>, bool) {
        let g = self.inner.lock().unwrap();
        let skip = g.ring.len().saturating_sub(max);
        let truncated = skip > 0 || g.total > g.ring.len() as u64;
        (g.ring.iter().skip(skip).copied().collect(), truncated)
    }

    /// (rows, cols) now.
    pub fn size(&self) -> (u16, u16) {
        self.inner.lock().unwrap().size
    }

    /// Size the PTY for a client's pane, within sane bounds, and tell every
    /// watcher. Ok(false) when it already was that size.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<bool, String> {
        let (rows, cols) = (rows.clamp(MIN_ROWS, MAX_ROWS), cols.clamp(MIN_COLS, MAX_COLS));
        let mut g = self.inner.lock().unwrap();
        if g.size == (rows, cols) {
            return Ok(false);
        }
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("could not resize the terminal: {e}"))?;
        g.size = (rows, cols);
        g.resized = Some(Instant::now());
        g.taps.retain(|(_, tx)| tx.send(TapMsg::Resize(rows, cols)).is_ok());
        Ok(true)
    }

    /// Keystrokes from a person or a client.
    pub fn input(&self, bytes: &[u8]) -> Result<(), String> {
        if self.exited() {
            return Err("the agent is not running".into());
        }
        self.inner.lock().unwrap().last_input = Some(Instant::now());
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes).and_then(|_| w.flush()).map_err(|e| format!("could not write to the agent: {e}"))
    }

    /// Record a prompt delivery: activity now, so the state reads working
    /// until the agent has had a quiet window to answer.
    pub fn mark_prompt(&self) {
        let mut g = self.inner.lock().unwrap();
        let now = Instant::now();
        g.last_prompt = Some(now);
        g.last_input = Some(now);
    }

    pub fn bracketed(&self) -> bool {
        self.inner.lock().unwrap().bracketed
    }

    pub fn exited(&self) -> bool {
        let g = self.inner.lock().unwrap();
        g.exited || g.closed.is_some()
    }

    /// (exited, last_activity, last_output, last_input)
    pub fn activity(&self) -> (bool, Option<Instant>, Option<Instant>, Option<Instant>) {
        let g = self.inner.lock().unwrap();
        let act = [g.last_output, g.last_prompt].into_iter().flatten().max();
        (g.exited || g.closed.is_some(), act, g.last_output, g.last_input)
    }

    /// SIGKILL the agent's whole process group (portable-pty makes the
    /// child a session leader, so its pid is the group id).
    /// Returns whether its own process was still running. The group is
    /// killed either way: the leader may be gone while children that
    /// ignored the hang-up are not.
    pub fn kill(&self) -> bool {
        let Some(pid) = self.pid else { return false };
        let running = !self.exited();
        // SAFETY: killpg with a pid we spawned; at worst ESRCH.
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
        running
    }

    /// SIGHUP the group, the way a closed terminal ends it (daemon stop).
    pub fn hangup(&self) {
        if let Some(pid) = self.pid {
            // SAFETY: as above.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGHUP);
            }
        }
    }
}

/// The last bracketed-paste mode switch in a chunk, if any.
fn bracketed_toggle(chunk: &[u8]) -> Option<bool> {
    let on = find_last(chunk, b"\x1b[?2004h");
    let off = find_last(chunk, b"\x1b[?2004l");
    match (on, off) {
        (Some(a), Some(b)) => Some(a > b),
        (Some(_), None) => Some(true),
        (None, Some(_)) => Some(false),
        _ => None,
    }
}

fn find_last(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

/// Whether `chunk` holds nothing but terminal queries an agent sends to
/// learn about its terminal (cursor position `ESC[6n` / `ESC[?6n`, device
/// attributes `ESC[c` / `ESC[>c` / `ESC[>0c`, kitty keyboard `ESC[?u`, XTVERSION
/// `ESC[>0q`), which are asking, not doing work.
fn only_queries(chunk: &[u8]) -> bool {
    const QUERIES: &[&[u8]] = &[b"\x1b[?6n", b"\x1b[6n", b"\x1b[>0c", b"\x1b[>c", b"\x1b[c", b"\x1b[?u", b"\x1b[>0q"];
    let mut rest = chunk;
    if rest.is_empty() {
        return false;
    }
    'outer: while !rest.is_empty() {
        for q in QUERIES {
            if rest.starts_with(q) {
                rest = &rest[q.len()..];
                continue 'outer;
            }
        }
        return false;
    }
    true
}

#[cfg(test)]
mod tests {

    #[test]
    fn terminal_queries_alone_are_not_work() {
        assert!(super::only_queries(b"\x1b[?6n\x1b[?6n\x1b[?6n"));
        assert!(super::only_queries(b"\x1b[?6n\x1b[c"));
        assert!(!super::only_queries(b"\x1b[?6nHi"));
        assert!(!super::only_queries(b"Hi"));
        assert!(!super::only_queries(b""));
    }

    use super::*;

    #[test]
    fn bracketed_paste_tracks_the_last_switch() {
        assert_eq!(bracketed_toggle(b"x\x1b[?2004hy"), Some(true));
        assert_eq!(bracketed_toggle(b"\x1b[?2004h..\x1b[?2004l"), Some(false));
        assert_eq!(bracketed_toggle(b"\x1b[?2004l..\x1b[?2004h"), Some(true));
        assert_eq!(bracketed_toggle(b"plain"), None);
    }

    #[test]
    fn a_pty_rings_output_and_reports_exit() {
        let (tx, rx) = mpsc::channel::<()>();
        let tx = Mutex::new(tx);
        let notify: Notify = Arc::new(move || {
            let _ = tx.lock().unwrap().send(());
        });
        let argv: Vec<String> = ["/bin/sh", "-c", "printf 'hello\\n'; read x; printf 'got:%s\\n' \"$x\""].iter().map(|s| s.to_string()).collect();
        let p = Pty::spawn(&argv, "/", &[], std::time::Duration::from_millis(100), notify).unwrap();
        let (_, _, tap) = p.subscribe().unwrap();
        p.input(b"abc\r").unwrap();
        let mut seen = Vec::new();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match tap.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(TapMsg::Data(d)) => seen.extend(d),
                Ok(TapMsg::Resize(..)) => {}
                Ok(TapMsg::Closed(why)) => {
                    assert_eq!(why, "exited");
                    break;
                }
                Err(_) => panic!("no exit; saw {:?}", String::from_utf8_lossy(&seen)),
            }
        }
        let text = String::from_utf8_lossy(&seen);
        assert!(text.contains("got:abc"), "{text}");
        let (tail, _) = p.tail(RING_BYTES);
        assert!(String::from_utf8_lossy(&tail).contains("hello"));
        while rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok() {
            if p.exited() {
                break;
            }
        }
        assert!(p.exited());
        assert!(p.subscribe().is_err());
    }

    #[test]
    fn a_client_that_saw_another_process_gets_the_whole_ring() {
        let notify: Notify = Arc::new(|| {});
        let argv: Vec<String> = ["/bin/sh", "-c", "printf 'fresh-start\\n'; sleep 5"].iter().map(|s| s.to_string()).collect();
        let p = Pty::spawn(&argv, "/", &[], std::time::Duration::from_millis(100), notify).unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while !String::from_utf8_lossy(&p.tail(RING_BYTES).0).contains("fresh-start") {
            assert!(Instant::now() < deadline, "no output");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // It saw 1 MB of a process before this one: everything here is new.
        let (_, backlog, at, _) = p.subscribe_from(Some(1 << 20)).unwrap();
        assert_eq!(at, 0);
        assert!(String::from_utf8_lossy(&backlog).contains("fresh-start"));
        // One that saw part of THIS process gets only the rest.
        let total = p.tail(RING_BYTES).0.len() as u64;
        let (_, rest, at, _) = p.subscribe_from(Some(total)).unwrap();
        assert_eq!((at, rest.len()), (total, 0));
        p.kill();
    }

    /// A client sizes the PTY: the program inside sees it, every watcher is
    /// told, the same size twice is no change, and nonsense is clamped.
    #[test]
    fn a_resize_reaches_the_program_and_every_watcher() {
        let notify: Notify = Arc::new(|| {});
        let argv: Vec<String> = ["/bin/sh", "-c", "read x; stty size"].iter().map(|s| s.to_string()).collect();
        let p = Pty::spawn(&argv, "/", &[], std::time::Duration::from_millis(100), notify).unwrap();
        assert_eq!(p.size(), (ROWS, COLS));
        let (_, _, tap) = p.subscribe().unwrap();
        assert_eq!(p.resize(30, 100), Ok(true));
        assert_eq!(p.resize(30, 100), Ok(false));
        assert_eq!(p.size(), (30, 100));
        p.input(b"\r").unwrap();
        let (mut seen, mut told) = (Vec::new(), Vec::new());
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match tap.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(TapMsg::Data(d)) => seen.extend(d),
                Ok(TapMsg::Resize(r, c)) => told.push((r, c)),
                Ok(TapMsg::Closed(_)) => break,
                Err(_) => panic!("no exit; saw {:?}", String::from_utf8_lossy(&seen)),
            }
        }
        assert!(String::from_utf8_lossy(&seen).contains("30 100"), "{}", String::from_utf8_lossy(&seen));
        assert_eq!(told, vec![(30, 100)], "told once, not for the no-op");
        let q = Pty::spawn(&["/bin/sh".to_string(), "-c".to_string(), "read x".to_string()], "/", &[], std::time::Duration::from_millis(100), Arc::new(|| {})).unwrap();
        q.resize(1, 9999).unwrap();
        assert_eq!(q.size(), (MIN_ROWS, MAX_COLS));
        let _ = q.input(b"\r");
    }
}
