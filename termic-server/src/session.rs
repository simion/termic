//! One client connection on the daemon's socket, plain framed messages
//! (SSH is the secure channel; the bridge only copies bytes).
//!
//! Mirrors the desktop's remote_server.rs: a full task snapshot on connect
//! and on every change, `call` on its own thread, one open terminal with
//! backlog-then-live and behind-means-resync. Threads: this one reads, a
//! writer owns the socket's write half (every message goes through its
//! queue), a state thread waits on the daemon's change condvar, and a
//! forwarder per open terminal reads its tap.

use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termic_proto::{ErrorCode, Reply, Request};
use termic_remote::conn::{MsgReader, MsgWriter};
use termic_remote::framed::{FramedReader, FramedWriter};
use termic_remote::outbox::Outbox;
use termic_remote::wire::{self, caps, ClientMsg, HostKind, ServerMsg, TaskRow};

use crate::daemon::Daemon;
use crate::pty::{self, Pty, TapMsg};
use crate::util;
use crate::verbs;

/// Clients ping every 20 s; this much silence means the other end is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
/// Calls in flight per connection.
const MAX_CALLS: usize = 32;
/// Keystrokes per message.
const MAX_KEYS: usize = 64 * 1024;
/// `pty_open` PTYs the daemon keeps running at once, across connections.
const MAX_PTYS: usize = 64;

#[derive(Clone)]
struct Term {
    gen: u64,
    task_id: String,
    tab: Option<String>,
    pty: Arc<Pty>,
    tap: u64,
}

struct Session {
    d: Arc<Daemon>,
    out: Outbox,
    term: Mutex<Option<Term>>,
    gen: AtomicU64,
    calls: AtomicUsize,
    done: AtomicBool,
    /// The daemon's `pty_open` PTYs this connection watches: id -> (PTY,
    /// tap). Dropped with the connection; the PTYs keep running.
    taps: Mutex<std::collections::HashMap<String, (Arc<pty::Pty>, u64)>>,
}

/// One connection on the daemon's unix socket (what `bridge` copies an ssh
/// session to): plain frames, since ssh is the secure channel.
pub fn serve(d: Arc<Daemon>, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(IDLE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let Ok(wstream) = stream.try_clone() else { return };
    let Ok(kill) = stream.try_clone() else { return };
    let mut reader = MsgReader::plain(Box::new(FramedReader(stream)));
    let writer = MsgWriter::plain(Box::new(FramedWriter(wstream)));
    let Ok(Some(hello @ ClientMsg::Hello { .. })) = reader.recv::<ClientMsg>() else { return };
    serve_conn(d, reader, writer, hello, Box::new(move || {
        let _ = kill.shutdown(std::net::Shutdown::Both);
    }));
}

/// Serve one client whose hello has been read, over any transport. The
/// unix socket above is the only one today; the reader and writer are
/// `termic_remote::conn`'s, so a sealed stream (`conn::host_handshake`,
/// which returns the hello it checked) plugs in here unchanged: that is
/// how a phone could later pair with a server directly
/// (docs/remote.md, "Not done"). `kill` cuts the transport when the
/// session ends, so a blocked writer never outlives it.
pub fn serve_conn(d: Arc<Daemon>, mut reader: MsgReader, mut writer: MsgWriter, hello: ClientMsg, kill: Box<dyn FnOnce() + Send>) {
    let ClientMsg::Hello { name, caps, .. } = hello else { return };
    let wants_tasks = caps.iter().any(|c| c == caps::TASKS);
    let welcome = ServerMsg::Welcome {
        v: wire::VERSION,
        id: d.id.clone(),
        name: d.name.clone(),
        version: crate::util::version(),
        kind: HostKind::Server,
        caps: [caps::CALL, caps::TASKS, caps::TERMINAL, caps::KEYS, caps::TRANSCRIPT, caps::RESIZE, caps::PTY, caps::PTY_KEEP].map(String::from).to_vec(),
        grant: Some("drive".into()),
        needs: Some(termic_remote::compat::REQUIRES_DESKTOP.into()),
    };
    if writer.send(&welcome).is_err() {
        return;
    }
    util::log(&format!("client connected: {name}"));
    let (out, rx) = Outbox::new();
    let s = Arc::new(Session {
        d: d.clone(),
        out,
        term: Mutex::new(None),
        gen: AtomicU64::new(0),
        calls: AtomicUsize::new(0),
        done: AtomicBool::new(false),
        taps: Mutex::new(Default::default()),
    });
    let writer_thread = {
        let s = s.clone();
        let mut writer = writer;
        std::thread::spawn(move || s.out.write_loop(rx, &mut writer, || term_reset(&s)))
    };
    let state_thread = wants_tasks.then(|| {
        let s = s.clone();
        std::thread::spawn(move || state_loop(&s))
    });
    while let Ok(Some(msg)) = reader.recv::<ClientMsg>() {
        handle(&s, msg);
    }
    s.done.store(true, Ordering::SeqCst);
    close_term(&s);
    // Stop watching; the PTYs are the daemon's and keep running.
    for (_, (p, tap)) in s.taps.lock().unwrap().drain() {
        p.unsubscribe(tap);
    }
    d.nudge();
    if let Some(t) = state_thread {
        let _ = t.join();
    }
    s.out.stop();
    let _ = writer_thread.join();
    kill();
    util::log(&format!("client disconnected: {name}"));
}

fn send(s: &Session, msg: ServerMsg) {
    s.out.send(msg);
}

fn error(s: &Session, message: impl Into<String>) {
    send(s, ServerMsg::Error { message: message.into() });
}

fn ack(s: &Session, id: Option<String>, r: Result<(), String>) {
    if let Some(id) = id {
        let (ok, message) = match r {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };
        send(s, ServerMsg::Ack { id, ok, message });
    } else if let Err(e) = r {
        error(s, e);
    }
}

/// A task's running agent, by id or name: (task id, agent id, its PTY).
fn running(s: &Session, task: &str, tab: Option<&str>) -> Result<(String, String, Arc<Pty>), String> {
    if !matches!(tab, None | Some("agent") | Some("1") | Some("")) {
        return Err(format!("no tab \"{}\": termic-server tasks have one tab, \"agent\"", tab.unwrap_or_default()));
    }
    let t = verbs::resolve(&s.d, Some(task), None, None).map_err(|e| e.1)?;
    // The desktop starts agents (resuming their session); this host has
    // no agent table to start one from.
    let pty = s.d.agent_pty(&t.id).ok_or_else(|| format!("{}'s agent is not running; open the task in Termic to start it", t.name))?;
    Ok((t.id, t.agent, pty))
}

fn handle(s: &Arc<Session>, msg: ClientMsg) {
    match msg {
        ClientMsg::Ping {} => send(s, ServerMsg::Pong {}),
        ClientMsg::Call { id, req, .. } => {
            if s.calls.fetch_add(1, Ordering::SeqCst) >= MAX_CALLS {
                s.calls.fetch_sub(1, Ordering::SeqCst);
                let r = Reply::err(&id, ErrorCode::Internal, "too many calls in flight on this connection");
                return send(s, ServerMsg::Reply { id, reply: serde_json::to_value(r).unwrap_or_default() });
            }
            // Calls can block for minutes (wait); each gets its own thread.
            let s = s.clone();
            std::thread::spawn(move || {
                let reply = match serde_json::from_value::<Request>(req) {
                    Ok(r) => verbs::call(&s.d, r),
                    Err(e) => Reply::err(&id, ErrorCode::BadRequest, format!("malformed request: {e}")),
                };
                let mut reply = reply;
                reply.id = id.clone();
                send(&s, ServerMsg::Reply { id, reply: serde_json::to_value(reply).unwrap_or_default() });
                s.calls.fetch_sub(1, Ordering::SeqCst);
            });
        }
        ClientMsg::TermOpen { task, tab } => open_term(s, &task, tab),
        ClientMsg::TermClose {} => close_term(s),
        ClientMsg::TermSize { cols, rows } => {
            if let Some(t) = s.term.lock().unwrap().clone() {
                if let Err(e) = t.pty.resize(rows, cols) {
                    error(s, e);
                }
            }
        }
        ClientMsg::TermInput { data } => {
            let term = s.term.lock().unwrap().clone();
            if let (Some(t), Some(bytes)) = (term, termic_remote::unb64(&data)) {
                if bytes.len() <= MAX_KEYS {
                    let _ = t.pty.input(&bytes);
                }
            }
        }
        ClientMsg::Keys { task, tab, data, id, question } => {
            let r = (|| {
                let bytes = termic_remote::unb64(&data).filter(|b| b.len() <= MAX_KEYS).ok_or("bad keys")?;
                let (task_id, _, pty) = running(s, &task, tab.as_deref())?;
                // An answer to a question that is no longer on screen would
                // be typed into whatever came next.
                if let Some(q) = question {
                    if s.d.question_now(&task_id).map(|x| x.id) != Some(q) {
                        return Err("stale".to_string());
                    }
                }
                pty.input(&bytes)
            })();
            ack(s, id, r);
        }
        ClientMsg::Interrupt { task, tab, id } => {
            let r = running(s, &task, tab.as_deref()).and_then(|(_, agent, pty)| pty.input(termic_proto::interrupt_key(&agent)));
            ack(s, id, r);
        }
        ClientMsg::PtyOpen { pid, cwd, argv, env, cols, rows, seen } => pty_open(s, pid, &cwd, argv, env, cols, rows, seen),
        ClientMsg::PtyInput { pid, data } => {
            let p = s.d.ptys.lock().unwrap().get(&pid).cloned();
            if let (Some(p), Some(bytes)) = (p, termic_remote::unb64(&data)) {
                if bytes.len() <= MAX_KEYS {
                    let _ = p.input(&bytes);
                    // Enter into an agent starts a turn: the monitor reads
                    // it now, as a `send` does (its output may come inside
                    // the quiet window and wake nothing).
                    if pid.ends_with(":agent") && bytes.contains(&b'\r') {
                        s.d.poke();
                    }
                }
            }
        }
        ClientMsg::PtyResize { pid, cols, rows } => {
            if let Some(p) = s.d.ptys.lock().unwrap().get(&pid).cloned() {
                let _ = p.resize(rows, cols);
            }
        }
        ClientMsg::PtyKill { pid } => {
            // The asker has forgotten it, and may already be starting a new
            // PTY under the same id (a stable `<task>:agent`): no exit goes
            // back to it, or that late exit would end the new one. Another
            // desktop watching it still sees it close.
            if let Some((p, tap)) = s.taps.lock().unwrap().remove(&pid) {
                p.unsubscribe(tap);
            }
            if let Some(p) = s.d.ptys.lock().unwrap().remove(&pid) {
                p.hangup();
                let p2 = p.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    p2.kill();
                });
            }
        }
        ClientMsg::Resync {} => {
            s.out.resync();
        }
        ClientMsg::Transcript { id, task } => {
            // Reading the chat is looking at the task: "done" is seen.
            if let Ok(t) = verbs::resolve(&s.d, Some(&task), None, None) {
                if let Some(pty) = s.d.agent_pty(&t.id) {
                    pty.mark_seen();
                    s.d.poke();
                }
            }
            let s = s.clone();
            std::thread::spawn(move || {
                let msg = match transcript(&s.d, &task) {
                    Ok((task_id, turns)) => ServerMsg::Transcript { id, task: task_id, turns, error: None },
                    Err(e) => ServerMsg::Transcript { id, task, turns: Vec::new(), error: Some(e) },
                };
                send(&s, msg);
            });
        }
        _ => {}
    }
}

fn transcript(d: &Daemon, task: &str) -> Result<(String, Vec<wire::Turn>), String> {
    let t = verbs::resolve(d, Some(task), None, None).map_err(|e| e.1)?;
    if matches!(t.agent.as_str(), "codex" | "agy" | "antigravity") {
        // No hooks here to record a session id: the task's folder decides,
        // which the project's own checkout shares with every other session.
        if t.is_main_checkout {
            return Err("this task shares the project checkout, so its conversation cannot be told apart from others there".into());
        }
        let turns = termic_remote::transcript::other_agent(&t.agent, &util::home(), &t.path, None)?;
        return Ok((t.id, turns));
    }
    if t.agent != "claude" {
        return Err("transcripts are available for Claude, Codex and Antigravity tasks".into());
    }
    let Some(path) = verbs::claude_transcript(&t) else { return Ok((t.id, Vec::new())) };
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok((t.id, termic_remote::transcript::parse_claude_jsonl(&text)))
}

// ─────────────────────────── extra PTYs ──────────────────────────────

/// A shell or a script in a project's folder (`pty_open`): fenced like
/// `exec`, run under the login shell's PATH, output streamed by `pid`.
/// The daemon owns it: an open with the `pid` of one still running
/// attaches instead, sending only the output after `seen`; with `seen`
/// set and nothing running under that `pid`, it never starts a new one.
#[allow(clippy::too_many_arguments)]
fn pty_open(s: &Arc<Session>, pid: String, cwd: &str, argv: Vec<String>, env: Vec<(String, String)>, cols: u16, rows: u16, seen: Option<u64>) {
    let exit = |reason: String| send(s, ServerMsg::PtyExit { pid: pid.clone(), reason });
    let opening = s.d.opening.lock().unwrap();
    let running = {
        let mut map = s.d.ptys.lock().unwrap();
        // Ended PTYs nobody came back for go now.
        map.retain(|_, p| !p.exited());
        map.get(&pid).cloned()
    };
    let p = match running {
        Some(p) => p,
        // `seen` means "attach": a PTY that ended while the client was away
        // (a server restart) is not started again, or a run script would
        // run twice.
        None if seen.is_some() => {
            // Ended by a restart onto a new build: the desktop starts it
            // again (resuming an agent's session). Once.
            let restarted = {
                let mut st = s.d.st.lock().unwrap();
                let hit = st.restarted_claims.iter().position(|c| *c == pid).map(|i| st.restarted_claims.remove(i));
                if hit.is_some() {
                    s.d.save(&st);
                }
                hit.is_some()
            };
            return exit(if restarted { wire::PTY_RESTARTED.into() } else { "ended while this computer was away".into() });
        }
        None => {
            if !verbs::exec_allowed(&s.d, std::path::Path::new(cwd)) {
                return exit(format!("{cwd} is not inside a project on this server"));
            }
            if s.d.ptys.lock().unwrap().len() >= MAX_PTYS {
                return exit(format!("too many terminals running on this server ({MAX_PTYS})"));
            }
            let wrapped: Vec<String> = if argv.is_empty() {
                vec!["/bin/sh".into(), "-c".into(), "exec \"${SHELL:-/bin/sh}\" -l".into()]
            } else {
                ["/bin/sh", "-lc", "exec \"$0\" \"$@\""].iter().map(|x| x.to_string()).chain(argv).collect()
            };
            let mut env = env;
            for (k, v) in [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")] {
                if !env.iter().any(|(e, _)| e == k) {
                    env.push((k.into(), v.into()));
                }
            }
            // Output after a quiet spell wakes the state monitor, which reads
            // a desktop-started agent (`<task>:agent`) as it does its own.
            let d = Arc::downgrade(&s.d);
            let notify: pty::Notify = Arc::new(move || {
                if let Some(d) = d.upgrade() {
                    d.poke();
                }
            });
            let p = match pty::Pty::spawn(&wrapped, cwd, &env, s.d.quiet, notify) {
                Ok(p) => p,
                Err(e) => return exit(e),
            };
            s.d.ptys.lock().unwrap().insert(pid.clone(), p.clone());
            p
        }
    };
    drop(opening);
    let _ = p.resize(rows, cols);
    let (tap, backlog, at, rx) = match p.subscribe_from(seen) {
        Ok(x) => x,
        Err(e) => return exit(e),
    };
    // Someone has it open now (and a new agent PTY can be found): the
    // monitor recomputes.
    s.d.poke();
    // A second open of the same PTY on this connection replaces the first tap.
    if let Some((old, old_tap)) = s.taps.lock().unwrap().insert(pid.clone(), (p.clone(), tap)) {
        old.unsubscribe(old_tap);
    }
    if !backlog.is_empty() || seen.is_some() {
        send(s, ServerMsg::PtyData { pid: pid.clone(), data: termic_remote::b64(&backlog), at: Some(at) });
    }
    let s2 = s.clone();
    std::thread::spawn(move || {
        // Flow control: past BEHIND_BYTES queued for this client, output is
        // not queued but remembered by offset; once the queue drains, what
        // was missed goes as one chunk read back from the ring, so a
        // flooding command on a slow link cannot grow the daemon's memory.
        // The tap carries the output right after the backlog, so `pos` is
        // where each chunk ends in it, whether sent or skipped.
        let mut pos = at + backlog.len() as u64;
        let mut sent = pos;
        loop {
            match rx.recv() {
                Ok(TapMsg::Data(bytes)) => {
                    pos += bytes.len() as u64;
                    if s2.out.queued_bytes() > termic_remote::outbox::BEHIND_BYTES {
                        continue;
                    }
                    let data = next_chunk(sent, pos, bytes, |from| p.since(from));
                    sent = pos;
                    let n = data.len();
                    s2.out.send_sized(ServerMsg::PtyData { pid: pid.clone(), data: termic_remote::b64(&data), at: None }, n);
                }
                Ok(TapMsg::Resize(..)) => {}
                Ok(TapMsg::Closed(_)) => break,
                // Unsubscribed: the connection ended or attached again. The
                // PTY runs on; nothing to tell.
                Err(_) => return,
            }
        }
        {
            let mut map = s2.d.ptys.lock().unwrap();
            if map.get(&pid).is_some_and(|x| Arc::ptr_eq(x, &p)) {
                map.remove(&pid);
            }
        }
        s2.taps.lock().unwrap().remove(&pid);
        // Ended by a restart onto a new build: say nothing. An "exited" here
        // could reach the desktop before the connection drops, and it would
        // show the agent exited instead of asking the next daemon, which
        // answers "restarted" (pty_open above) so the desktop starts it again.
        if s2.d.restarting.load(Ordering::SeqCst) {
            return;
        }
        send(&s2, ServerMsg::PtyExit { pid, reason: "exited".into() });
    });
}

/// What to send for a tap chunk ending at `pos` when `sent` bytes have gone:
/// the chunk itself, or, after chunks were skipped (`sent` short of where
/// this one starts), everything from `sent` to `pos` read back from the ring
/// (`since`: bytes from an offset and where they start), as far as it holds.
fn next_chunk(sent: u64, pos: u64, chunk: Vec<u8>, since: impl Fn(u64) -> (Vec<u8>, u64)) -> Vec<u8> {
    if sent + chunk.len() as u64 >= pos {
        return chunk;
    }
    let (ring, start) = since(sent);
    let upto = (pos.saturating_sub(start) as usize).min(ring.len());
    ring[..upto].to_vec()
}

#[cfg(test)]
mod flow_tests {
    use super::next_chunk;

    #[test]
    fn a_skipped_stretch_comes_back_in_order_and_once() {
        let out: Vec<u8> = (0u8..=99).collect(); // the whole output, offsets 0..100
        let ring = |from: u64| (out[from as usize..].to_vec(), from);
        // In step: the chunk as it came.
        assert_eq!(next_chunk(10, 20, out[10..20].to_vec(), ring), out[10..20]);
        // 30 bytes skipped while behind, then a chunk ending at 70: 40..70.
        assert_eq!(next_chunk(40, 70, out[60..70].to_vec(), ring), out[40..70]);
        // Output written after this chunk (70..100) is not sent ahead of it.
        assert_eq!(next_chunk(40, 70, out[60..70].to_vec(), ring).len(), 30);
        // The ring moved past `sent`: what it still holds, up to the chunk's end.
        let short = |from: u64| { let s = from.max(50); (out[s as usize..].to_vec(), s) };
        assert_eq!(next_chunk(40, 70, out[60..70].to_vec(), short), out[50..70]);
    }
}

// ───────────────────────────── terminal ──────────────────────────────

fn open_term(s: &Arc<Session>, task: &str, tab: Option<String>) {
    close_term(s);
    let (task_id, _, pty) = match running(s, task, tab.as_deref()) {
        Ok(x) => x,
        Err(e) => return send(s, ServerMsg::TermClosed { reason: e }),
    };
    let (tap, backlog, rx) = match pty.subscribe() {
        Ok(x) => x,
        Err(e) => return send(s, ServerMsg::TermClosed { reason: e }),
    };
    // Looking at it reads what it finished: the monitor recomputes.
    s.d.poke();
    let gen = s.gen.fetch_add(1, Ordering::SeqCst) + 1;
    *s.term.lock().unwrap() = Some(Term { gen, task_id: task_id.clone(), tab: tab.clone(), pty, tap });
    s.out.caught_up();
    let (rows, cols) = live_size(s);
    send(s, ServerMsg::TermReset { task: task_id, tab, cols, rows, data: termic_remote::b64(&backlog) });
    let s2 = s.clone();
    std::thread::spawn(move || forward(&s2, rx, gen));
}

/// The open terminal's PTY size (rows, cols).
fn live_size(s: &Session) -> (u16, u16) {
    s.term.lock().unwrap().as_ref().map(|t| t.pty.size()).unwrap_or((pty::ROWS, pty::COLS))
}

fn close_term(s: &Session) {
    if let Some(t) = s.term.lock().unwrap().take() {
        // Dropping the tap's sender ends the forwarder.
        t.pty.unsubscribe(t.tap);
    }
}

/// Tap -> queue while the terminal is open. Drops output while the client
/// is behind; the writer resyncs it once the queue drains.
fn forward(s: &Session, rx: mpsc::Receiver<TapMsg>, gen: u64) {
    let current = || s.term.lock().unwrap().as_ref().is_some_and(|t| t.gen == gen);
    loop {
        match rx.recv() {
            Ok(TapMsg::Data(bytes)) => {
                if s.done.load(Ordering::SeqCst) {
                    return;
                }
                s.out.term(bytes);
            }
            // In order with the output around it: the same queue.
            Ok(TapMsg::Resize(rows, cols)) => {
                if current() {
                    send(s, ServerMsg::TermResize { cols, rows });
                }
            }
            Ok(TapMsg::Closed(reason)) => {
                if current() {
                    s.term.lock().unwrap().take();
                    send(s, ServerMsg::TermClosed { reason });
                }
                return;
            }
            // Unsubscribed by close_term (or a newer open).
            Err(_) => return,
        }
    }
}

/// The open terminal's current screen, for a client that fell behind.
fn term_reset(s: &Session) -> Option<ServerMsg> {
    let t = s.term.lock().unwrap().clone()?;
    let (data, _) = t.pty.tail(pty::RING_BYTES);
    let (rows, cols) = t.pty.size();
    Some(ServerMsg::TermReset { task: t.task_id, tab: t.tab, cols, rows, data: termic_remote::b64(&data) })
}

// ───────────────────────────── state ─────────────────────────────────

fn state_loop(s: &Session) {
    let mut last: Option<Vec<TaskRow>> = None;
    let mut seen = s.d.seq();
    while !s.done.load(Ordering::SeqCst) {
        let rows = s.d.rows();
        if last.as_ref() != Some(&rows) {
            last = Some(rows.clone());
            send(s, ServerMsg::Tasks { tasks: rows });
        }
        seen = s.d.wait_seq(seen, None, &|| s.done.load(Ordering::SeqCst));
    }
}
