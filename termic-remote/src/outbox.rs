//! One stream connection's outgoing queue, shared by both hosts (the
//! desktop's remote_server.rs and termic-server's session.rs): messages in
//! order, terminal output with back-pressure, and the writer that drains it.
//!
//! A client more than `BEHIND_BYTES` of terminal output behind stops getting
//! the bytes; once the queue drains it gets the current screen instead (the
//! host's `reset`), rather than a replay it would only scroll through.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;

use crate::conn::MsgWriter;
use crate::wire::ServerMsg;

/// Terminal output queued for one client beyond which it is "behind".
/// 1 MiB is about four full 256 KiB backlogs, seconds of a busy TUI.
pub const BEHIND_BYTES: usize = 1024 * 1024;

enum Out {
    Msg(ServerMsg),
    /// A message whose size counts toward `queued` (a `pty_data`).
    Sized(ServerMsg, usize),
    /// Terminal output and its raw length (for the behind accounting).
    Term(Vec<u8>, usize),
    Resync,
    /// The connection ended. The writer's session holds a sender, so the
    /// queue never closes by itself: it is told.
    Stop,
}

pub struct Outbox {
    tx: mpsc::Sender<Out>,
    queued: AtomicUsize,
    behind: AtomicBool,
}

/// The writer's end of an `Outbox`.
pub struct Drain(mpsc::Receiver<Out>);

impl Outbox {
    pub fn new() -> (Outbox, Drain) {
        let (tx, rx) = mpsc::channel();
        (Outbox { tx, queued: AtomicUsize::new(0), behind: AtomicBool::new(false) }, Drain(rx))
    }

    pub fn send(&self, m: ServerMsg) {
        let _ = self.tx.send(Out::Msg(m));
    }

    /// `send`, counting `n` bytes toward the backlog until it is written:
    /// output for a terminal other than the open one (`pty_data`), whose
    /// sender holds back while `queued_bytes` is over `BEHIND_BYTES`.
    pub fn send_sized(&self, m: ServerMsg, n: usize) {
        self.queued.fetch_add(n, Ordering::SeqCst);
        let _ = self.tx.send(Out::Sized(m, n));
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }

    /// Terminal output for the open terminal, or nothing while behind.
    pub fn term(&self, bytes: Vec<u8>) {
        if self.behind.load(Ordering::SeqCst) {
            return;
        }
        let n = bytes.len();
        if self.queued.fetch_add(n, Ordering::SeqCst) + n > BEHIND_BYTES {
            // Not queued, so not counted: the count must reach 0 again for
            // the catch-up reset to fire.
            self.queued.fetch_sub(n, Ordering::SeqCst);
            self.behind.store(true, Ordering::SeqCst);
            return;
        }
        let _ = self.tx.send(Out::Term(bytes, n));
    }

    /// Send the current screen (the host's `reset`) in order.
    pub fn resync(&self) {
        let _ = self.tx.send(Out::Resync);
    }

    /// A terminal was (re)opened: its reset carries the screen.
    pub fn caught_up(&self) {
        self.behind.store(false, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Out::Stop);
    }

    /// Drain the queue into `w` until `stop` or a write fails. `reset` is
    /// the open terminal's current screen (a `term_reset`), or None.
    pub fn write_loop(&self, rx: Drain, w: &mut MsgWriter, reset: impl Fn() -> Option<ServerMsg>) {
        let send_reset = |w: &mut MsgWriter| -> std::io::Result<()> {
            let Some(m) = reset() else { return Ok(()) };
            self.behind.store(false, Ordering::SeqCst);
            w.send(&m)
        };
        while let Ok(item) = rx.0.recv() {
            let r = match item {
                Out::Msg(m) => w.send(&m),
                Out::Sized(m, n) => {
                    self.queued.fetch_sub(n, Ordering::SeqCst);
                    w.send(&m)
                }
                Out::Term(bytes, n) => {
                    self.queued.fetch_sub(n, Ordering::SeqCst);
                    if self.behind.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        w.send(&ServerMsg::TermData { data: crate::b64(&bytes) })
                    }
                }
                Out::Resync => send_reset(w),
                Out::Stop => break,
            };
            if r.is_err() {
                break;
            }
            // Caught up after falling behind: the latest screen, not a replay.
            if self.behind.load(Ordering::SeqCst) && self.queued.load(Ordering::SeqCst) == 0 && send_reset(w).is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falling_behind_drops_output_and_the_count_returns_to_zero() {
        let (ob, _rx) = Outbox::new();
        ob.term(vec![0; BEHIND_BYTES]);
        assert_eq!(ob.queued.load(Ordering::SeqCst), BEHIND_BYTES);
        ob.term(vec![0; 10]);
        assert!(ob.behind.load(Ordering::SeqCst));
        // The dropped chunk is not counted, so draining the one queued
        // brings the count to 0 and the reset can fire.
        assert_eq!(ob.queued.load(Ordering::SeqCst), BEHIND_BYTES);
        ob.term(vec![0; 10]);
        assert_eq!(ob.queued.load(Ordering::SeqCst), BEHIND_BYTES, "nothing counted while behind");
    }
}
