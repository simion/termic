//! The host side of the remote-control stream (docs/remote.md): a phone or
//! another Termic connected to THIS desktop over the peer listener's
//! `/termic-peer/v1/stream` (a WebSocket, frames sealed with the pair key).
//!
//! What a connection gets, and the three rules that keep it cheap:
//!
//! - **State**: a full task snapshot on connect and on change (the agent
//!   state cache's own change signal, never a timer that runs when nothing
//!   is connected). Not deltas: a client that misses one gets the next.
//! - **Verbs**: `call` runs a termic-proto Request through the same
//!   `dispatch_authenticated` the CLI, MCP and pairing use, under the
//!   client's grant.
//! - **Terminal**: only the one a client has open streams (the PTY feed's
//!   atomic backlog-and-tap, as `termic attach`). A client that falls
//!   behind is resynced from the ring, never replayed. The host owns the
//!   size; a client never resizes the PTY.
//! - **Transcript**: on request, read from the agent's session file.
//!
//! Threads per connection: this one reads, one writes (it owns the socket's
//! write half and every byte goes through its queue), one watches state,
//! and one forwards the open terminal. Every wait is a blocking read, a
//! channel or the cache's condvar (CLAUDE.md: no sleep-polls).

use std::collections::HashMap;
use std::net::{IpAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termic_proto::{ErrorCode, Reply, Request};
use termic_remote::conn::{self, MsgReader, MsgWriter};
use termic_remote::wire::{self, caps, ClientKind, ClientMsg, Diff, HostKind, ServerMsg, RowGroup, RowPr, RowProfile, RowProp, TabRow, TaskRow};
use termic_remote::ws;

use crate::cli_server::CliHost;
use crate::dlog;
use crate::peers::{Grant, Node};

/// Silence from a client longer than this ends its connection. Clients
/// ping every 20 s; a phone that was backgrounded and frozen by iOS is
/// noticed here and its terminal tap released.
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
/// Terminal bytes queued for one client beyond which it is "behind": live
/// output for it is dropped and it gets the ring again once the queue
/// drains. 1 MiB is ~4 full 256 KiB backlogs, seconds of a busy TUI.
const BEHIND_BYTES: usize = 1024 * 1024;
/// The retained output a resync replays (the whole PTY ring).
const BACKLOG_BYTES: usize = 256 * 1024;
/// How long the state watcher waits for the agent cache to change before
/// rebuilding anyway (task list edits, renames, a new task, do not touch
/// the cache).
const STATE_REFRESH: Duration = Duration::from_secs(4);
/// Diff stats cost two git subprocesses per task, so they are refreshed on
/// this cadence (and for a task whose state just changed), not per snapshot.
const DIFF_REFRESH: Duration = Duration::from_secs(60);
/// The private reason the session posts into its own terminal tap to stop
/// the forwarder; never shown to anyone.
const CLOSE_TAP: &str = "\u{0}remote-close";

/// Who is on the other end, as the node authorised it.
#[derive(Debug, Clone)]
pub(crate) struct StreamClient {
    pub id: String,
    pub name: String,
    pub kind: ClientKind,
    /// What this client may do here. A phone is the user's own remote
    /// control: Drive. A computer: whatever its pair record says.
    pub grant: Grant,
    /// Asked for task snapshots in its hello (`caps: ["tasks"]`). A one-off
    /// `--peer` call does not, and costs the host no task list or diffs.
    pub wants_tasks: bool,
}

impl StreamClient {
    fn drives(&self) -> bool {
        self.grant == Grant::Drive
    }
}

enum Out {
    Msg(ServerMsg),
    /// Terminal output and its raw length (for the behind accounting).
    Term(Vec<u8>, usize),
    Resync,
    /// The connection ended: the writer closes the socket and returns. Its
    /// own Arc<Session> holds a sender, so the queue never closes by itself.
    Stop,
}

/// The open terminal of a connection.
#[derive(Clone)]
struct TermState {
    task_id: String,
    tab: Option<String>,
    pty_id: String,
    /// Posts `CLOSE_TAP` into the tap so the forwarder ends.
    tx: mpsc::SyncSender<crate::PtyTapMsg>,
}

struct Session {
    host: Arc<dyn CliHost>,
    node: Arc<Node>,
    client: StreamClient,
    out: mpsc::Sender<Out>,
    queued: Arc<AtomicUsize>,
    behind: Arc<AtomicBool>,
    term: Arc<Mutex<Option<TermState>>>,
    done: Arc<AtomicBool>,
}

/// Serve one upgraded connection until it ends. Called on the listener's
/// connection thread after it read a `GET .../stream` with an upgrade.
pub(crate) fn serve(mut stream: TcpStream, ws_key: &str, node: Arc<Node>, src: IpAddr) {
    if ws::write_upgrade_response(&mut stream, ws_key).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(IDLE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_nodelay(true);
    let kill = match stream.try_clone() {
        Ok(k) => k,
        Err(_) => return,
    };
    let Ok((r, w)) = ws::split_tcp(stream, ws::End::Server) else { return };
    let host_id = node.self_id();
    let accepted = match conn::host_handshake(Box::new(r), Box::new(w), &host_id, |cid| node.stream_keys(cid)) {
        Ok(a) => a,
        Err(e) => {
            dlog(&format!("[remote] {src}: refused ({e})"));
            node.stream_refused();
            return;
        }
    };
    let Some(client) = node.stream_authorized(&accepted.client_id, accepted.key_index, &accepted.hello, src) else {
        let mut w = accepted.writer;
        w.close(conn::CLOSE_UNAUTHENTICATED, "unauthenticated");
        return;
    };
    let live = node.register_live(&client.id, kill);
    dlog(&format!("[remote] {} ({:?}) connected from {src}", client.name, client.kind));
    run(node.clone(), client.clone(), accepted.reader, accepted.writer);
    node.unregister_live(live);
    dlog(&format!("[remote] {} disconnected", client.name));
}

fn run(node: Arc<Node>, client: StreamClient, mut reader: MsgReader, mut writer: MsgWriter) {
    let host = node.host();
    let mut caps_list = vec![caps::CALL.to_string()];
    if client.drives() {
        caps_list.extend([caps::TASKS, caps::TERMINAL, caps::KEYS, caps::TRANSCRIPT].map(String::from));
    }
    let welcome = ServerMsg::Welcome {
        v: wire::VERSION,
        id: node.self_id(),
        name: node.self_name(),
        version: host.app_version(),
        kind: HostKind::Desktop,
        caps: caps_list,
        grant: Some(client.grant.as_str().to_string()),
    };
    if writer.send(&welcome).is_err() {
        return;
    }
    let (tx, rx) = mpsc::channel::<Out>();
    let s = Arc::new(Session {
        host: host.clone(),
        node: node.clone(),
        client: client.clone(),
        out: tx,
        queued: Arc::new(AtomicUsize::new(0)),
        behind: Arc::new(AtomicBool::new(false)),
        term: Arc::new(Mutex::new(None)),
        done: Arc::new(AtomicBool::new(false)),
    });

    let writer_thread = {
        let s = s.clone();
        std::thread::spawn(move || write_loop(&s, rx, writer))
    };
    let state_thread = (client.drives() && client.wants_tasks).then(|| {
        let s = s.clone();
        std::thread::spawn(move || state_loop(&s))
    });

    loop {
        match reader.recv::<ClientMsg>() {
            Ok(Some(msg)) => handle(&s, msg),
            Ok(None) => break,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::TimedOut {
                    dlog(&format!("[remote] {}: {e}", client.name));
                }
                break;
            }
        }
    }
    s.done.store(true, Ordering::SeqCst);
    close_term(&s);
    let _ = s.out.send(Out::Stop);
    drop(s);
    let _ = writer_thread.join();
    if let Some(t) = state_thread {
        let _ = t.join();
    }
}

fn send(s: &Session, msg: ServerMsg) {
    let _ = s.out.send(Out::Msg(msg));
}

fn error(s: &Session, message: impl Into<String>) {
    send(s, ServerMsg::Error { message: message.into() });
}

// ───────────────────────────── reading ───────────────────────────────

fn handle(s: &Arc<Session>, msg: ClientMsg) {
    match msg {
        ClientMsg::Ping {} => send(s, ServerMsg::Pong {}),
        ClientMsg::Call { id, req, proto } => {
            // Calls can block for minutes (wait, archive scripts): each
            // runs on its own thread and answers through the queue.
            let s = s.clone();
            std::thread::spawn(move || {
                let reply = call(&s, &id, req, proto);
                send(&s, ServerMsg::Reply { id, reply: serde_json::to_value(reply).unwrap_or_default() });
            });
        }
        ClientMsg::TermOpen { task, tab } => {
            if !s.client.drives() {
                return error(s, "this computer only lets yours reply to its tasks");
            }
            open_term(s, &task, tab.as_deref());
        }
        ClientMsg::TermClose {} => close_term(s),
        // Not offered (no `resize` in welcome): this PTY is sized by its own
        // window here, and a phone or another computer only follows it.
        ClientMsg::TermSize { .. } => {}
        ClientMsg::TermInput { data } => {
            let term = s.term.lock().unwrap().clone();
            if let (Some(t), Some(bytes)) = (term, termic_remote::unb64(&data)) {
                let _ = s.host.pty_input(&t.pty_id, &bytes);
            }
        }
        ClientMsg::Keys { task, tab, data, id, question } => {
            if !s.client.drives() {
                return error(s, "this computer only lets yours reply to its tasks");
            }
            let ack = |ok: bool, message: Option<String>| {
                if let Some(id) = id.clone() {
                    send(s, ServerMsg::Ack { id, ok, message });
                } else if let Some(m) = message.filter(|_| !ok) {
                    error(s, m);
                }
            };
            let Some(bytes) = termic_remote::unb64(&data) else { return ack(false, Some("bad keys".into())) };
            match resolve_pty(s, &task, tab.as_deref()) {
                Ok((_, pty)) => {
                    // An answer is bound to the question it answers: if the
                    // screen moved on (answered at the desk, a new prompt),
                    // typing it now would answer something else.
                    if let Some(qid) = question {
                        let live = screen_of(s, &pty).and_then(|l| termic_remote::screen::question(&l)).map(|q| q.id);
                        if live.as_deref() != Some(qid.as_str()) {
                            return ack(false, Some("stale".into()));
                        }
                    }
                    match s.host.pty_input(&pty, &bytes) {
                        Ok(()) => ack(true, None),
                        Err(e) => ack(false, Some(e)),
                    }
                }
                Err(e) => ack(false, Some(e)),
            }
        }
        ClientMsg::Interrupt { task, tab, id } => {
            if !s.client.drives() {
                return error(s, "this computer only lets yours reply to its tasks");
            }
            let r = resolve_pty(s, &task, tab.as_deref()).and_then(|(task_id, pty)| {
                let (_, tasks) = s.host.projects_tasks();
                let agent = tasks.iter().find(|t| t.id == task_id).map(|t| t.cli.clone()).unwrap_or_default();
                s.host.pty_input(&pty, interrupt_key(&agent))?;
                s.host.note_remote_interrupt(&task_id, &pty);
                Ok(())
            });
            match (id, r) {
                (Some(id), Ok(())) => send(s, ServerMsg::Ack { id, ok: true, message: None }),
                (Some(id), Err(e)) => send(s, ServerMsg::Ack { id, ok: false, message: Some(e) }),
                (None, Err(e)) => error(s, e),
                (None, Ok(())) => {}
            }
        }
        ClientMsg::Resync {} => {
            let _ = s.out.send(Out::Resync);
        }
        ClientMsg::Transcript { id, task } => {
            if !s.client.drives() {
                return error(s, "this computer only lets yours reply to its tasks");
            }
            let s = s.clone();
            std::thread::spawn(move || {
                let msg = match crate::cli_server::transcript_turns(s.host.as_ref(), &task) {
                    Ok((task_id, turns)) => ServerMsg::Transcript { id, task: task_id, turns, error: None },
                    Err(e) => ServerMsg::Transcript { id, task, turns: Vec::new(), error: Some(e) },
                };
                send(&s, msg);
            });
        }
        ClientMsg::PushToken { platform, token } => {
            if s.client.kind == ClientKind::Phone {
                let target = (!token.is_empty() && matches!(platform.as_str(), "ios" | "android"))
                    .then_some(crate::peers::PushTarget { platform, token });
                s.node.set_phone_push(&s.client.id, target);
            }
        }
        ClientMsg::Hello { .. } | ClientMsg::Unknown => {}
    }
}

/// Run one verb for the client, under its grant. The same checks a call
/// from a paired computer always had (peers.rs `permitted`), plus a phone,
/// which is the user's own remote control and drives.
fn call(s: &Session, id: &str, req: serde_json::Value, proto: Option<u32>) -> Reply {
    let req: Request = match serde_json::from_value(req) {
        Ok(r) => r,
        Err(e) => return Reply::err(id, ErrorCode::BadRequest, format!("malformed request: {e}")),
    };
    let mut reply = s.node.run_stream_call(&s.client, req, proto);
    reply.id = id.to_string();
    reply
}

// ───────────────────────────── terminal ──────────────────────────────

/// How much of a PTY's ring the screen reader replays: several full frames
/// of any TUI, and cheap (a few ms) to run through the emulator.
const SCREEN_BYTES: usize = 128 * 1024;

/// A PTY's visible screen, rebuilt from its ring at its current size.
fn screen_of(s: &Session, pty: &str) -> Option<Vec<String>> {
    let (rows, cols) = s.host.pty_size(pty)?;
    let (bytes, _) = s.host.pty_logs(pty, SCREEN_BYTES).ok()?;
    Some(termic_remote::screen::render(&bytes, rows, cols))
}

/// The key that stops an agent's turn without quitting it. Claude, Codex
/// and opencode take Esc; others (gemini, a shell) take Ctrl-C.
fn interrupt_key(agent: &str) -> &'static [u8] {
    match agent {
        "claude" | "next-claude" | "codex" | "opencode" | "cursor" | "grok" => b"\x1b",
        _ => b"\x03",
    }
}

/// A task (id or name) and its terminal PTY: `tab` names a strip tab by
/// id, otherwise the default agent tab.
fn resolve_pty(s: &Session, task: &str, tab: Option<&str>) -> Result<(String, String), String> {
    let (projects, tasks) = s.host.projects_tasks();
    let t = crate::cli_server::resolve_by_name(&projects, &tasks, task, None).map_err(|e| e.message)?;
    let pty = match tab {
        Some(tab) => s.host.find_tab_pty(&t.id, tab)?,
        None => s.host.find_role_pty(&t.id, "agent")?,
    };
    Ok((t.id.clone(), pty))
}

fn open_term(s: &Arc<Session>, task: &str, tab: Option<&str>) {
    close_term(s);
    let (task_id, pty_id) = match resolve_pty(s, task, tab) {
        Ok(x) => x,
        Err(e) => {
            send(s, ServerMsg::TermClosed { reason: e });
            return;
        }
    };
    let att = match s.host.pty_subscribe(&pty_id) {
        Ok(a) => a,
        Err(e) => {
            send(s, ServerMsg::TermClosed { reason: e });
            return;
        }
    };
    let (rows, cols) = s.host.pty_size(&pty_id).unwrap_or((24, 80));
    *s.term.lock().unwrap() = Some(TermState { task_id: task_id.clone(), tab: tab.map(str::to_string), pty_id: pty_id.clone(), tx: att.tx.clone() });
    s.behind.store(false, Ordering::SeqCst);
    send(s, ServerMsg::TermReset { task: task_id, tab: tab.map(str::to_string), cols, rows, data: termic_remote::b64(&att.backlog) });
    let s2 = s.clone();
    std::thread::spawn(move || forward_term(&s2, att.rx, pty_id, (rows, cols)));
}

fn close_term(s: &Session) {
    if let Some(t) = s.term.lock().unwrap().take() {
        let _ = t.tx.try_send(crate::PtyTapMsg::Detach(CLOSE_TAP.into()));
    }
}

/// Tap -> queue, for as long as the terminal is open. Drops output while
/// the client is behind; the writer resyncs it once it catches up.
fn forward_term(s: &Session, rx: mpsc::Receiver<crate::PtyTapMsg>, pty_id: String, mut size: (u16, u16)) {
    loop {
        match rx.recv() {
            Ok(crate::PtyTapMsg::Data(bytes)) => {
                if s.done.load(Ordering::SeqCst) {
                    return;
                }
                // The desktop owns the size; follow it when it changes. One
                // ioctl per chunk, only while a client watches.
                if let Some(now) = s.host.pty_size(&pty_id) {
                    if now != size {
                        size = now;
                        send(s, ServerMsg::TermResize { cols: now.1, rows: now.0 });
                    }
                }
                if s.behind.load(Ordering::SeqCst) {
                    continue;
                }
                let n = bytes.len();
                if s.queued.fetch_add(n, Ordering::SeqCst) + n > BEHIND_BYTES {
                    s.behind.store(true, Ordering::SeqCst);
                    continue;
                }
                let _ = s.out.send(Out::Term(bytes, n));
            }
            Ok(crate::PtyTapMsg::Detach(reason)) => {
                if reason != CLOSE_TAP {
                    s.term.lock().unwrap().take();
                    send(s, ServerMsg::TermClosed { reason });
                }
                return;
            }
            Err(_) => {
                if s.term.lock().unwrap().as_ref().is_some_and(|t| t.pty_id == pty_id) {
                    s.term.lock().unwrap().take();
                    send(s, ServerMsg::TermClosed { reason: "exited".into() });
                }
                return;
            }
        }
    }
}

// ───────────────────────────── writing ───────────────────────────────

fn write_loop(s: &Session, rx: mpsc::Receiver<Out>, mut w: MsgWriter) {
    let resync = |w: &mut MsgWriter| -> std::io::Result<()> {
        let Some(t) = s.term.lock().unwrap().clone() else { return Ok(()) };
        let (rows, cols) = s.host.pty_size(&t.pty_id).unwrap_or((24, 80));
        let data = s.host.pty_logs(&t.pty_id, BACKLOG_BYTES).map(|(b, _)| b).unwrap_or_default();
        s.behind.store(false, Ordering::SeqCst);
        w.send(&ServerMsg::TermReset { task: t.task_id, tab: t.tab, cols, rows, data: termic_remote::b64(&data) })
    };
    while let Ok(item) = rx.recv() {
        let r = match item {
            Out::Msg(m) => w.send(&m),
            Out::Term(bytes, n) => {
                s.queued.fetch_sub(n, Ordering::SeqCst);
                if s.behind.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    w.send(&ServerMsg::TermData { data: termic_remote::b64(&bytes) })
                }
            }
            Out::Resync => resync(&mut w),
            Out::Stop => break,
        };
        if r.is_err() {
            break;
        }
        // Caught up after falling behind: the latest screen, not a replay.
        if s.behind.load(Ordering::SeqCst) && s.queued.load(Ordering::SeqCst) == 0 && resync(&mut w).is_err() {
            break;
        }
    }
    w.close(1000, "");
}

// ───────────────────────────── state ─────────────────────────────────

/// Project folder colours: the webview keeps them (localStorage
/// `groupColors`, folder name -> accent key) and pushes the map here on
/// every change, so rows can carry them. Empty until it has.
static FOLDER_COLORS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, String>>> = std::sync::LazyLock::new(Default::default);

pub(crate) fn set_project_folder_colors(colors: HashMap<String, String>) {
    *FOLDER_COLORS.lock().unwrap() = colors;
}

/// What each window's sidebar has folded shut (its localStorage maps),
/// pushed on every change and keyed by window, since each profile's window
/// keeps its own. Rows carry it so a phone opens in the same shape.
#[derive(Clone, Default, Debug, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Folds {
    pub projects: Vec<String>,
    pub folders: Vec<String>,
    pub task_groups: Vec<String>,
}

static FOLDS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Folds>>> = std::sync::LazyLock::new(Default::default);

pub(crate) fn set_sidebar_folds(window: &str, folds: Folds) {
    FOLDS.lock().unwrap().insert(window.to_string(), folds);
}

/// Every window's folds as one set (ids are unique across profiles).
fn sidebar_folds() -> Folds {
    let mut all = Folds::default();
    for f in FOLDS.lock().unwrap().values() {
        all.projects.extend(f.projects.iter().cloned());
        all.folders.extend(f.folders.iter().cloned());
        all.task_groups.extend(f.task_groups.iter().cloned());
    }
    all
}

fn project_folder_colors() -> HashMap<String, String> {
    FOLDER_COLORS.lock().unwrap().clone()
}

/// How the host's sidebar files and marks a task: its group (named, or
/// after its lead task as the sidebar does), its project's folder, pin,
/// display order and pull request.
fn sidebar_fields(t: &crate::Task, projects: &[crate::Project], tasks: &[crate::Task], folder_colors: &HashMap<String, String>, registry: &crate::profiles::Registry, folds: &Folds) -> TaskRow {
    let group = t.group.as_ref().map(|g| RowGroup {
        id: g.id.clone(),
        name: g
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .or_else(|| tasks.iter().find(|x| x.id == g.id).map(|x| x.name.clone()))
            .unwrap_or_else(|| "Task group".into()),
        color: g.color.clone(),
        collapsed: folds.task_groups.contains(&g.id),
    });
    let project_pos = projects.iter().position(|p| p.id == t.project_id);
    // The folder's name as the sidebar shows and keys it: trimmed, ALL-CAPS
    // (src/lib/projectGroups.ts `groupOf`), so "Backend" and "backend" are
    // one folder and its colour is found under that key.
    let project_group = project_pos
        .and_then(|i| projects[i].group.as_deref())
        .map(|g| g.trim().to_uppercase())
        .filter(|g| !g.is_empty())
        .map(|g| RowGroup { color: folder_colors.get(&g).cloned(), collapsed: folds.folders.contains(&g), id: g.clone(), name: g });
    // Position among the project's live tasks in store order, which is the
    // sidebar's order.
    let order = tasks.iter().filter(|x| !x.archived && x.project_id == t.project_id).position(|x| x.id == t.id);
    let pr = t.pr_number.map(|number| RowPr {
        number,
        state: t.pr_state.clone(),
        title: t.pr_title.clone(),
        url: t.pr_url.clone(),
        provider: t.pr_provider.clone(),
    });
    let profile = project_pos
        .and_then(|i| registry.profile_of(&projects[i].profile))
        .map(|p| RowProfile { id: p.slug.clone(), name: p.name.clone(), accent: p.accent.clone() });
    TaskRow {
        group,
        project_group,
        profile,
        project_collapsed: folds.projects.contains(&t.project_id),
        pinned: t.pinned,
        project_order: project_pos.map(|i| i as u32),
        order: order.map(|i| i as u32),
        pr,
        ..Default::default()
    }
}

/// Whether another machine can open a tab of this kind: agent and run tabs
/// keep a retained output ring and are addressable by id (TerminalPane's
/// `role`); a plain shell or a custom terminal is neither, by design.
fn tab_viewable(kind: &str) -> bool {
    matches!(kind, "agent" | "run")
}

fn state_loop(s: &Session) {
    let cache = s.host.agent_cache();
    let mut seq = 0u64;
    let mut last: Option<Vec<TaskRow>> = None;
    let mut diffs: HashMap<String, Diff> = HashMap::new();
    let mut diffs_at: Option<Instant> = None;
    let mut last_states: HashMap<String, String> = HashMap::new();
    // When each task's state last changed (epoch ms), for "2m" on a phone.
    let mut since: HashMap<String, (String, i64)> = HashMap::new();
    while !s.done.load(Ordering::SeqCst) {
        let (projects, tasks) = s.host.projects_tasks();
        let live: Vec<&crate::Task> = tasks.iter().filter(|t| !t.archived).collect();
        let folder_colors = project_folder_colors();
        let registry = crate::profile_registry();
        let folds = sidebar_folds();
        let snap = cache.snapshot();
        let ids: Vec<String> = live.iter().map(|t| t.id.clone()).collect();
        let states = crate::cli_server::cached_work_states(&snap, &ids);
        let state_of = |id: &str| -> String {
            states.as_ref().and_then(|m| m.get(id)).map(|i| i.state.clone()).unwrap_or_else(|| "unknown".into())
        };
        let mut rows: Vec<TaskRow> = live
            .iter()
            .map(|t| {
                let project = projects.iter().find(|p| p.id == t.project_id).map(|p| p.name.clone()).unwrap_or_default();
                let tabs = crate::cli_server::cached_tab_states(&snap, &t.id)
                    .unwrap_or_default()
                    .into_iter()
                    // Every tab, not only agents: a client switches to a
                    // second agent, a shell or the run output like the strip.
                    .map(|tab| TabRow {
                        // Only agent and run tabs keep a retained output
                        // ring and are addressable by id; a shell or custom
                        // terminal opens on this computer only.
                        viewable: (!tab_viewable(&tab.kind)).then_some(false),
                        kind: tab.kind,
                        live: Some(tab.live),
                        id: tab.id,
                        title: tab.title,
                        agent: tab.agent,
                        state: tab.state.unwrap_or_else(|| "unknown".into()),
                        is_default: tab.is_default,
                        props: tab.props.into_iter().map(|p| RowProp { key: p.key, value: p.value }).collect(),
                    })
                    .collect();
                let mut state = state_of(&t.id);
                // A menu on the agent's screen is the stronger signal: an
                // agent at its folder-trust prompt reads "idle" to the state
                // detector, and a phone must still show it as needing you.
                let screen = (state != "inactive" && state != "unknown")
                    .then(|| s.host.find_role_pty(&t.id, "agent").ok().and_then(|p| screen_of(s, &p)))
                    .flatten();
                let mut question = screen.as_deref().filter(|_| state != "working").and_then(termic_remote::screen::question);
                if question.is_some() {
                    state = "waiting".into();
                }
                let now = chrono::Utc::now().timestamp_millis();
                let entry = since.entry(t.id.clone()).or_insert_with(|| (state.clone(), now));
                if entry.0 != state {
                    *entry = (state.clone(), now);
                }
                let activity = screen.as_deref().filter(|_| state == "working").and_then(termic_remote::screen::activity);
                if state != "waiting" {
                    question = None;
                }
                TaskRow {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    project,
                    agent: t.cli.clone(),
                    branch: (!t.branch.is_empty()).then(|| t.branch.clone()),
                    since_ms: Some(entry.1),
                    activity,
                    question,
                    state,
                    tabs,
                    diff: diffs.get(&t.id).cloned(),
                    created: (!t.created.is_empty()).then(|| t.created.clone()),
                    is_main_checkout: t.is_main_checkout,
                    ..sidebar_fields(t, &projects, &tasks, &folder_colors, &registry, &folds)
                }
            })
            .collect();
        // The host's own display order, so a client draws it the same way.
        rows.sort_by(|a, b| (a.project_order, a.order, &a.name).cmp(&(b.project_order, b.order, &b.name)));
        // The list first, so a client draws at once; diffs follow.
        if last.as_ref() != Some(&rows) {
            last = Some(rows.clone());
            send(s, ServerMsg::Tasks { tasks: rows });
        }
        // Diffs: all of them on the cadence, and any task whose state moved
        // (an agent that just finished has new changes to show) or that has
        // none yet. Then rebuild at once to send them.
        let refresh_all = diffs_at.is_none_or(|t| t.elapsed() >= DIFF_REFRESH);
        let mut refreshed = false;
        // The state the row reports (a question on screen makes it
        // "waiting" whatever the detector says): that is what moved.
        let row_state: HashMap<String, String> = last.iter().flatten().map(|r| (r.id.clone(), r.state.clone())).collect();
        for t in &live {
            if s.done.load(Ordering::SeqCst) {
                return;
            }
            let st = row_state.get(&t.id).cloned().unwrap_or_else(|| state_of(&t.id));
            let moved = last_states.insert(t.id.clone(), st.clone()).is_some_and(|p| p != st);
            if refresh_all || moved || !diffs.contains_key(&t.id) {
                if let Some(d) = s.host.diff_stat(t) {
                    let d = Diff { files_changed: d.files_changed + d.untracked, insertions: d.insertions, deletions: d.deletions };
                    if diffs.get(&t.id) != Some(&d) {
                        diffs.insert(t.id.clone(), d);
                        refreshed = true;
                    }
                }
            }
        }
        if refresh_all {
            diffs_at = Some(Instant::now());
        }
        if refreshed {
            continue;
        }
        seq = cache.wait_change(seq, STATE_REFRESH);
    }
}

#[cfg(test)]
mod sidebar_tests {
    use super::*;

    fn task(id: &str, name: &str, project: &str) -> crate::Task {
        crate::Task { id: id.into(), name: name.into(), project_id: project.into(), ..Default::default() }
    }

    #[test]
    fn only_agent_and_run_tabs_can_be_opened_from_another_machine() {
        assert!(tab_viewable("agent"));
        assert!(tab_viewable("run"));
        assert!(!tab_viewable("shell"));
        assert!(!tab_viewable("terminal"));
        assert!(!tab_viewable(""));
    }

    /// A row carries what the host's sidebar draws: the group (its name, or
    /// its lead task's), the project's folder and its colour, the pin, the
    /// display order and the PR.
    #[test]
    fn a_row_is_filed_and_marked_as_the_host_sidebar_draws_it() {
        let projects = vec![
            crate::Project { id: "p1".into(), name: "web".into(), ..Default::default() },
            crate::Project { id: "p2".into(), name: "api".into(), group: Some(" Backend ".into()), ..Default::default() },
        ];
        let mut lead = task("lead", "orchestrate", "p2");
        lead.group = Some(crate::TaskGroup { id: "lead".into(), name: None, color: Some("teal".into()) });
        let mut member = task("m", "fix-auth", "p2");
        member.group = Some(crate::TaskGroup { id: "lead".into(), name: None, color: Some("teal".into()) });
        member.pinned = true;
        member.pr_number = Some(42);
        member.pr_state = Some("open".into());
        member.pr_title = Some("Fix auth".into());
        let mut gone = task("old", "archived", "p2");
        gone.archived = true;
        let mut named = task("n", "docs", "p1");
        named.group = Some(crate::TaskGroup { id: "g2".into(), name: Some("  Docs work ".into()), color: None });
        let tasks = vec![gone, lead, member.clone(), named.clone()];
        let colors: HashMap<String, String> = [("BACKEND".to_string(), "purple".to_string())].into();

        let r = sidebar_fields(&member, &projects, &tasks, &colors, &Default::default(), &Default::default());
        assert_eq!(r.group, Some(RowGroup { id: "lead".into(), name: "orchestrate".into(), color: Some("teal".into()), ..Default::default() }), "unnamed: after its lead");
        assert_eq!(r.project_group, Some(RowGroup { id: "BACKEND".into(), name: "BACKEND".into(), color: Some("purple".into()), ..Default::default() }), "named and keyed as groupOf normalizes it");
        assert!(r.pinned);
        assert_eq!((r.project_order, r.order), (Some(1), Some(1)), "the archived task takes no place");
        assert_eq!(r.pr.as_ref().map(|p| (p.number, p.state.as_deref(), p.title.as_deref())), Some((42, Some("open"), Some("Fix auth"))));

        let n = sidebar_fields(&named, &projects, &tasks, &colors, &Default::default(), &Default::default());
        assert_eq!(n.group.map(|g| g.name), Some("Docs work".to_string()));
        assert_eq!((n.project_group, n.pinned, n.pr, n.project_order, n.order), (None, false, None, Some(0), Some(0)));
    }

    #[test]
    fn rows_say_what_the_sidebar_has_folded() {
        set_sidebar_folds("w1", Folds { projects: vec!["p1".into()], folders: vec![], task_groups: vec!["g1".into()] });
        set_sidebar_folds("w2", Folds { projects: vec![], folders: vec!["BACKEND".into()], task_groups: vec![] });
        let f = sidebar_folds();
        assert_eq!((f.projects, f.folders, f.task_groups), (vec!["p1".to_string()], vec!["BACKEND".to_string()], vec!["g1".to_string()]), "every window's folds, merged");
        set_sidebar_folds("w2", Folds::default());
        assert!(sidebar_folds().folders.is_empty(), "a window's push replaces its own earlier one");
        FOLDS.lock().unwrap().clear();
    }
}
