//! Production control-plane socket server for the `termic` CLI.
//!
//! Unix socket at `<data_dir>/termic.sock` (mode 0600), NDJSON framing
//! from `termic-proto`. Runs on its OWN thread, never the IPC/main
//! thread (docs/ipc.md: sync IO on the WKWebView event-loop thread froze
//! the Mac once already; the automation bridge's dedicated-thread model
//! is the template).
//!
//! Security model (docs/plans/cli.md, Security):
//! - The server ALWAYS binds; the unauthenticated surface is `hello`
//!   only (app-is-running + protocol version). That disclosure is the
//!   accepted price of the clear disabled-CLI error.
//! - Everything else requires BOTH the "Enable CLI" setting AND the
//!   per-boot token from `<data_dir>/cli-token` (0600, 244 random bits).
//! - The token lives ONLY in this module's state, NEVER in the app
//!   process environment: `pty_spawn` copies the full app env into every
//!   child, caged included, so an env-stashed token would hand a full
//!   sandbox escape to every agent.
//! - `getpeereid` (SO_PEERCRED on Linux) same-uid check on every
//!   connection, before a single byte is read.
//! - Caged agents get NO CLI surface at all; the seatbelt profile
//!   carries a final socket deny + data-dir read deny (sandbox.rs).
//!
//! Webview RPC: work-state (working / waiting / done) exists only in the
//! webview, so `list`/`status` query it through a typed correlation-id
//! channel: emit `cli-rpc://request`, the frontend registry
//! (src/lib/cliRpc.ts, `window.__termic.rpc`) executes the handler and
//! replies via the `cli_rpc_result` command. This is NEW hardened code
//! that only borrows the debug bridge's correlation-id pattern; the
//! bridge itself (automation.rs, `/eval`) is never armed or reused here.

use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};
use termic_proto as proto;
use termic_proto::{Command, ErrorCode, Reply, ReplyData, Request, StreamEvent, WaitOutcome};

use crate::{dlog, Project, Task};

/// Darwin's sockaddr_un.sun_path is 104 bytes including the NUL.
const MAX_SUN_PATH: usize = 103;

/// `open` is user-visible feedback; give a busy webview a little longer.
const OPEN_TIMEOUT: Duration = Duration::from_millis(10_000);
/// Simple read-modify webview RPCs (project add / remove w/o tasks).
const PROJECT_RPC_TIMEOUT: Duration = Duration::from_secs(60);
/// `new_task` covers worktree add + optional base fetch + mount; big
/// repos are slow. Setup streaming keeps the connection visibly alive.
const NEW_TASK_TIMEOUT: Duration = Duration::from_secs(180);
/// `archive_task` / `project_remove` run archive scripts + worktree
/// removal, per task for a project remove.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);
/// `send_prompt` covers a tracked delivery into a running agent (~1s)
/// or a respawn (PTY spawn deadline 15s + margin); the injection into a
/// respawned agent continues app-side after the RPC returns.
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
thread_local! {
    /// Set by the `quit` handler, consumed by `serve_conn` once the reply has
    /// been written: a flag rather than a direct call so teardown cannot race
    /// the reply it is supposed to follow.
    ///
    /// THREAD-LOCAL, not a global. `serve_listener` spawns one thread per
    /// connection and `handle_request` runs synchronously on it, so a global
    /// would let ANY concurrent connection consume the flag - a sibling
    /// `termic list` finishing its own write first would tear the app down
    /// before the quitting client's reply was flushed, which is the exact
    /// failure this mechanism exists to prevent, just moved from a timer race
    /// to a thread race. Thread-local also means a future caller of
    /// handle_request outside serve_conn cannot leave the flag armed for an
    /// unrelated request to trip over.
    static QUIT_AFTER_REPLY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Keepalive cadence on streamed replies (10s in production). Must stay
/// well under the CLI's 30s socket read timeout. Tests shrink every
/// watch-loop constant so the timing paths run in milliseconds.
const HEARTBEAT_EVERY: Duration = Duration::from_millis(if cfg!(test) { 50 } else { 10_000 });
/// Condvar wait slice while a delivery report is pending (reports do
/// not bump the cache seq, so this bounds their detection latency).
const CV_SLICE: Duration = Duration::from_millis(if cfg!(test) { 10 } else { 1000 });
/// How long a spawned prompt gets to confirm delivery (90s in
/// production): PTY spawn deadline (15s) + agent settle (6s) + generous
/// margin for a loaded machine. After this, the prompt counts as never
/// delivered.
const DELIVERY_TIMEOUT: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 90_000 });
/// Grace for the webview's first agent-state push (app just launched)
/// and for a fresh task to appear in the pushed map. 15s in production.
const POPULATE_GRACE: Duration = Duration::from_millis(if cfg!(test) { 150 } else { 15_000 });
/// A cache older than this mid-wait means the webview stopped
/// reporting (reload that never came back, wedged UI): fail the wait
/// rather than trusting a frozen snapshot. 120s in production: the push
/// module re-pushes every 20s regardless of changes, and the wide
/// margin also rides out App Nap throttling of a fully idle, occluded
/// webview.
const CACHE_STALE_AFTER: Duration = Duration::from_millis(if cfg!(test) { 800 } else { 120_000 });
/// Own-prompt waits (30s in production): if the turn's "working" edge
/// was never observed (classifier miss) and the agent has sat idle this
/// long after confirmed delivery, call it settled. Heuristic honesty is
/// part of the contract (--help says "the agent stopped, not the work
/// is right"); hanging forever on a missed signal would be worse.
const IDLE_SETTLE_GRACE: Duration = Duration::from_millis(if cfg!(test) { 200 } else { 30_000 });

// ───────────────────────────── lifecycle ─────────────────────────────

/// Bind and serve. Called once from the app setup hook. Never panics the
/// app: every failure path logs and returns (the CLI then reports
/// "Termic did not start" / "not listening").
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || server_main(app));
}

/// Single instance per DATA DIR. If another termic already owns this data
/// dir's control socket, ask it to come to front and return true so the
/// caller exits before building a window. The data dir is the real unit:
/// the socket AND projects.json/tasks/ are single-writer per data dir, so
/// prod and beta (which share the release data dir) are mutually exclusive
/// by design, dev has its own (termic_dev), and e2e runs isolate via a
/// scratch TERMIC_DATA_DIR.
///
/// RELEASE only. Debug is newest-wins: relaunching `make dev` over a
/// lingering instance should hand the socket to the FRESH build (server_main
/// unlinks + rebinds), not defer to stale code.
pub fn another_instance_running() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    let Ok(dir) = crate::data_dir() else { return false };
    raise_existing(&dir.join(proto::SOCKET_FILE))
}

/// Connect to `sock`; if a LIVE termic answers hello (not a stale socket
/// file left by a crash), ask it to raise its window and report true.
fn raise_existing(sock: &Path) -> bool {
    let Ok(stream) = UnixStream::connect(sock) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let Ok(mut writer) = stream.try_clone() else { return false };
    let mut reader = BufReader::new(stream);
    // Confirm a live instance via hello. A parseable hello reply (any
    // protocol) means a sibling is running and owns this data dir.
    let hello = Request { id: "preflight".into(), token: None, cmd: Command::Hello };
    if proto::write_msg(&mut writer, &hello).is_err() {
        return false;
    }
    let alive = matches!(
        proto::read_msg::<_, Reply>(&mut reader),
        Ok(Some(reply)) if reply.ok && matches!(reply.data, Some(ReplyData::Hello(_)))
    );
    if !alive {
        return false;
    }
    // Best-effort: bring the running instance to front, then let the caller
    // exit. If the raise is dropped, single-instance still holds; the user
    // just may need to click the running window.
    let raise = Request { id: "preflight".into(), token: None, cmd: Command::Raise };
    let _ = proto::write_msg(&mut writer, &raise);
    let _ = proto::read_msg::<_, Reply>(&mut reader);
    true
}

fn server_main(app: tauri::AppHandle) {
    let dir = match crate::data_dir() {
        Ok(d) => d,
        Err(e) => {
            dlog(&format!("[cli] no data dir, control socket disabled: {e}"));
            return;
        }
    };
    let sock = dir.join(proto::SOCKET_FILE);
    if sock.as_os_str().as_bytes().len() > MAX_SUN_PATH {
        dlog(&format!(
            "[cli] socket path exceeds the {MAX_SUN_PATH}-byte unix limit, control socket disabled: {}",
            sock.display()
        ));
        return;
    }
    // Stale socket from a previous boot (or a crashed instance): unlink
    // before bind, the standard unix-daemon dance.
    let _ = std::fs::remove_file(&sock);
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            dlog(&format!("[cli] bind {} failed: {e}", sock.display()));
            return;
        }
    };
    if let Err(e) = std::fs::set_permissions(&sock, {
        use std::os::unix::fs::PermissionsExt;
        std::fs::Permissions::from_mode(0o600)
    }) {
        dlog(&format!("[cli] chmod 0600 on {} failed: {e}", sock.display()));
        return;
    }
    // Write the token only AFTER the socket is bound, so at startup the two
    // appear together (we never advertise a token before a live socket).
    // It is deliberately NOT removed on quit: a stale token then lingers
    // until the next launch overwrites it, which is harmless (useless
    // without a live server). On a write failure, unlink the socket we just
    // bound so nothing dangling is left either.
    let token = mint_token();
    if let Err(e) = write_token_file(&dir.join(proto::TOKEN_FILE), &token) {
        dlog(&format!("[cli] token file write failed, control socket disabled: {e}"));
        let _ = std::fs::remove_file(&sock);
        return;
    }
    dlog(&format!("[cli] listening on {}", sock.display()));
    let host: Arc<dyn CliHost> = Arc::new(TauriHost { app, token });
    serve_listener(listener, host);
}

/// Accept loop, decomposed from `server_main` so integration tests can
/// drive a real socket with a stub host.
fn serve_listener(listener: UnixListener, host: Arc<dyn CliHost>) {
    // A transient accept error (EMFILE when the app is fd-heavy with many
    // PTYs, ECONNABORTED, EINTR) must NOT kill the server thread: a dead
    // listener also silently breaks the release single-instance guard (a
    // second launch can't reach us, unlinks + rebinds, and two instances
    // race the shared projects.json/tasks/). Log and keep serving; give up
    // only if the listener is persistently broken.
    let mut consecutive_errors = 0u32;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                consecutive_errors = 0;
                let host = host.clone();
                std::thread::spawn(move || serve_conn(stream, host));
            }
            Err(e) => {
                consecutive_errors += 1;
                dlog(&format!("[cli] accept failed ({consecutive_errors}): {e}"));
                if consecutive_errors > 64 {
                    dlog("[cli] too many consecutive accept failures, stopping control socket");
                    break;
                }
                // Brief backoff so a persistent condition (EMFILE) doesn't
                // spin this thread hot while file descriptors free up.
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn serve_conn(stream: UnixStream, host: Arc<dyn CliHost>) {
    // Same-uid peer check BEFORE reading anything. Root is not exempted:
    // there is no reason for another uid, root included, to be here.
    if peer_uid(&stream) != Some(unsafe { libc::geteuid() }) {
        return;
    }
    // A client that connects and never sends must not pin this thread.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    loop {
        let line = match proto::read_line(&mut reader) {
            Ok(Some(line)) => line,
            Ok(None) => return, // clean EOF
            Err(_) => return,   // timeout / oversized / mid-line EOF
        };
        let req = match serde_json::from_str::<Request>(&line) {
            Ok(req) => req,
            Err(e) => {
                let reply =
                    Reply::err("", ErrorCode::BadRequest, format!("malformed request: {e}"));
                if proto::write_msg(&mut writer, &reply).is_err() {
                    return;
                }
                continue;
            }
        };
        // A live attach session takes over the WHOLE connection (frames
        // flow both ways); only a refused attach stays in the loop.
        if matches!(req.cmd, Command::Attach { .. }) {
            match validate_attach(&req, &*host) {
                Err(reply) => {
                    if proto::write_msg(&mut writer, &*reply).is_err() {
                        return;
                    }
                    continue;
                }
                Ok((task_id, attachment)) => {
                    run_attach_session(&req.id, task_id, attachment, host, reader, writer);
                    return;
                }
            }
        }
        let reply = {
            let mut sink = SocketSink { writer: &mut writer };
            handle_request(&req, &*host, &mut sink)
        };
        let wrote = proto::write_msg(&mut writer, &reply).is_ok();
        // `quit` defers teardown to HERE, once the reply is actually on the
        // wire. Exiting from inside handle_request raced the write: on a busy
        // machine (this app exists to run many agents) the serving thread can
        // be descheduled past any fixed grace, the socket closes first, and a
        // SUCCESSFUL quit is reported to the client as CONNECTION_LOST. Once
        // write_msg returns the bytes are buffered in the kernel and survive
        // our exit.
        // Deliberately NOT gated on `wrote`: the commit was received and
        // processed, so a client that died before reading its reply does not
        // cancel a quit the user asked for. Only the ORDER is guaranteed here,
        // not delivery.
        if QUIT_AFTER_REPLY.with(|f| f.replace(false)) {
            host.quit_app();
        }
        if !wrote {
            return;
        }
    }
}

// ───────────────────────────── attach ────────────────────────────────

/// Resolve + subscribe the attach target; every failure is an ordinary
/// error Reply (boxed: clippy's result_large_err) and the connection
/// stays in the request/reply loop.
fn validate_attach(
    req: &Request,
    host: &dyn CliHost,
) -> Result<(String, crate::PtyAttachment), Box<Reply>> {
    let Command::Attach { task, project, shell, tab, cwd } = &req.cmd else {
        unreachable!("validate_attach called with a non-attach command")
    };
    if let Some(refused) = auth_gate(req, host) {
        return Err(Box::new(refused));
    }
    if *shell && tab.is_some() {
        return Err(Box::new(Reply::err(
            &req.id,
            ErrorCode::BadRequest,
            "--shell targets the aux terminal, which is not a strip tab; drop one of the flags",
        )));
    }
    let (projects, tasks) = host.projects_tasks();
    let t = resolve_task_arg(&projects, &tasks, task.as_deref(), project.as_deref(), cwd.as_deref())
        .map_err(|e| Box::new(Reply { id: req.id.clone(), ok: false, data: None, error: Some(e) }))?;
    let pty = match tab.as_deref() {
        // `--tab`: the selector resolves to a tab id, and the id to that
        // tab's own live agent PTY, never a fallback to a sibling.
        Some(sel) => {
            let rt = resolve_tab_selector(host, t, sel).map_err(|e| {
                Box::new(Reply { id: req.id.clone(), ok: false, data: None, error: Some(e) })
            })?;
            host.find_tab_pty(&t.id, &rt.id)
                .map_err(|e| Box::new(Reply::err(&req.id, ErrorCode::Unsupported, e)))?
        }
        None => {
            let kind = if *shell { "aux" } else { "agent" };
            host.find_role_pty(&t.id, kind)
                .map_err(|e| Box::new(Reply::err(&req.id, ErrorCode::Unsupported, e)))?
        }
    };
    let attachment = host
        .pty_subscribe(&pty)
        .map_err(|e| Box::new(Reply::err(&req.id, ErrorCode::Unsupported, e)))?;
    Ok((t.id.clone(), attachment))
}

/// The live attach session: PTY output frames out, keystroke/resize
/// frames in, until one side ends it. The client's input is read on its
/// own thread (a blocked socket read is only interruptible by shutdown);
/// PTY output is forwarded on this thread, parked in recv() with no
/// timer: every end condition arrives IN-BAND on the tap channel (the
/// input thread posts the client's detach through its sender clone, the
/// PTY reader posts "exited" at EOF, archive posts its reason).
fn run_attach_session(
    req_id: &str,
    task_id: String,
    attachment: crate::PtyAttachment,
    host: Arc<dyn CliHost>,
    reader: BufReader<UnixStream>,
    mut writer: UnixStream,
) {
    // Both directions can be legitimately silent for minutes; EOF is
    // the liveness signal, not a read timeout. (The socket options live
    // on the shared file description, so this covers the reader too.)
    let _ = writer.set_read_timeout(None);

    // `ready` tells the client to enter raw mode; the backlog replays
    // the retained screen state so an idle TUI is not a blank window.
    if proto::write_msg(&mut writer, &proto::AttachFrame::ready()).is_err() {
        return;
    }
    if !attachment.backlog.is_empty()
        && proto::write_msg(&mut writer, &proto::AttachFrame::out(&attachment.backlog)).is_err()
    {
        return;
    }

    // Input thread: client frames -> PTY. Every exit (a detach frame,
    // client EOF, our shutdown below) posts an in-band detach so the
    // forwarder wakes; the blocking send is bounded by the forwarder's
    // own 10s socket write timeout in the worst (stalled-client) case.
    let input_thread = {
        let host = host.clone();
        let detach_tx = attachment.tx.clone();
        let pty_id = attachment.pty_id.clone();
        let mut reader = reader;
        std::thread::spawn(move || {
            while let Ok(Some(line)) = proto::read_line(&mut reader) {
                let Ok(frame) = serde_json::from_str::<proto::AttachFrame>(&line) else {
                    continue;
                };
                match frame.kind.as_str() {
                    "in" => {
                        if let Some(bytes) = frame.data_bytes() {
                            let _ = host.pty_input(&pty_id, &bytes);
                        }
                    }
                    "resize" => {
                        if let (Some(rows), Some(cols)) = (frame.rows, frame.cols) {
                            let _ = host.pty_set_size(&pty_id, rows, cols);
                        }
                    }
                    "detach" => break,
                    // Unknown kinds are skipped (additive contract).
                    _ => {}
                }
            }
            let _ = detach_tx.send(crate::PtyTapMsg::Detach("detached".into()));
        })
    };

    // Output forwarder: tap -> socket. Disconnect is a rare backstop
    // now (both senders gone); with the explicit exited notice in
    // place, its usual cause is a tap force-dropped for falling behind.
    let reason = loop {
        match attachment.rx.recv() {
            Ok(crate::PtyTapMsg::Data(bytes)) => {
                if proto::write_msg(&mut writer, &proto::AttachFrame::out(&bytes)).is_err() {
                    // Client socket gone; the input thread sees EOF too.
                    break "detached".to_string();
                }
            }
            Ok(crate::PtyTapMsg::Detach(reason)) => break reason,
            Err(std::sync::mpsc::RecvError) => break "lagged".to_string(),
        }
    };

    // Best-effort epilogue: the in-band reason, then the final Reply
    // that ends the session protocol. On a dead socket both just fail.
    if reason != "detached" {
        let _ = proto::write_msg(&mut writer, &proto::AttachFrame::detach(&reason));
    }
    let _ = proto::write_msg(
        &mut writer,
        &Reply::ok(req_id, ReplyData::Attach(proto::AttachData { task_id, reason })),
    );
    // Unblock the input thread's socket read so it can exit.
    let _ = writer.shutdown(std::net::Shutdown::Both);
    let _ = input_thread.join();
}

// ───────────────────────────── dispatch ──────────────────────────────

/// Where streamed events go on their way to the client. The socket
/// writer in production; a Vec in tests. An Err from `emit` means the
/// client is gone: streaming verbs abort their watch instead of
/// blocking a dead connection's thread forever.
pub(crate) trait EventSink {
    fn emit(&mut self, ev: &StreamEvent) -> std::io::Result<()>;
}

struct SocketSink<'a> {
    writer: &'a mut UnixStream,
}

impl EventSink for SocketSink<'_> {
    fn emit(&mut self, ev: &StreamEvent) -> std::io::Result<()> {
        proto::write_msg(self.writer, ev)
    }
}

/// One registered agent CLI, as the verbs need it: enough to validate
/// `--agent` and refuse `wait` on an agent with no settle signal.
#[derive(Debug, Clone)]
pub(crate) struct AgentMeta {
    pub id: String,
    /// "agent" or "terminal" (terminal entries have no work-done
    /// machinery at all).
    pub kind: String,
    pub work_done: bool,
    pub disabled: bool,
}

/// Everything the request handler needs from the app, behind a trait so
/// the dispatch + resolution logic is testable without a running Tauri.
pub(crate) trait CliHost: Send + Sync {
    fn cli_enabled(&self) -> bool;
    fn token(&self) -> &str;
    fn app_version(&self) -> String;
    fn projects_tasks(&self) -> (Vec<Project>, Vec<Task>);
    /// Per-task agent state for `list`/`status` rows. Since Phase 1
    /// this reads the webview-pushed cache, not a webview round-trip.
    /// `None` = the webview has never pushed (still booting); per-task
    /// entries may still be missing.
    fn work_states(&self, ids: &[String]) -> Option<HashMap<String, WorkStateInfo>>;
    fn open_task_in_ui(&self, task_id: &str) -> Result<(), String>;
    fn raise_window(&self);
    /// (tasks with live agents, live agent PTYs). Ground truth from the
    /// PTY map, not the webview cache.
    fn live_agent_counts(&self) -> (u32, u32);
    /// Tear the app down. Everything the app owns dies with it.
    fn quit_app(&self);
    fn diff_stat(&self, task: &Task) -> Option<proto::DiffStat>;
    /// Registered agent CLIs (Settings registry).
    fn agents(&self) -> Vec<AgentMeta>;
    /// Typed webview RPC, no progress.
    fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String>;
    /// Typed webview RPC with a progress callback (setup output
    /// streaming; idle ticks drive keepalive heartbeats).
    fn rpc_stream(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
        on_progress: &mut dyn FnMut(RpcProgress),
    ) -> Result<serde_json::Value, String>;
    /// The webview-pushed agent-state cache `wait` blocks on.
    fn agent_cache(&self) -> &AgentCache;
    /// Delivery confirmations for CLI-injected prompts.
    fn prompt_reports(&self) -> &PromptReports;
    /// SIGKILL every live PTY of a task (the task_set_sandbox
    /// precedent); returns the victim count.
    fn kill_task_ptys(&self, task_id: &str) -> u32;
    /// `git rev-parse --show-toplevel` for `new` run outside any
    /// registered project: is the cwd a repo we could register?
    fn git_toplevel(&self, cwd: &str) -> Option<String>;
    /// The send-to-main flow (`apply`), typed so the verb can pin
    /// distinct exit codes on the failure classes.
    fn apply_diff(&self, task_id: &str) -> Result<crate::SendDiffResult, crate::SendDiffError>;
    /// Full diff summary vs the base branch (`task_diff`'s engine).
    fn diff_summary(&self, task_id: &str) -> Result<crate::TaskDiffSummary, String>;
    /// Resolve the PTY `attach`/`logs` target: kind is "agent" or "aux".
    fn find_role_pty(&self, task_id: &str, kind: &str) -> Result<String, String>;
    /// Resolve ONE tab's live agent PTY by its stable tab id (`--tab`,
    /// GH #138 part 2). Err covers dead agent tabs and shell/terminal
    /// tabs, which never carry a role (write-only from the CLI).
    fn find_tab_pty(&self, task_id: &str, tab_id: &str) -> Result<String, String>;
    /// The retained output tail of a role-tagged PTY.
    fn pty_logs(&self, pty_id: &str, max: usize) -> Result<(Vec<u8>, bool), String>;
    /// Register a live attach tap + backlog snapshot on a PTY.
    fn pty_subscribe(&self, pty_id: &str) -> Result<crate::PtyAttachment, String>;
    /// Type bytes into a PTY (the attach `in` path).
    fn pty_input(&self, pty_id: &str, data: &[u8]) -> Result<(), String>;
    /// Resize a PTY (the attach `resize` path, opt-in client-side).
    fn pty_set_size(&self, pty_id: &str, rows: u16, cols: u16) -> Result<(), String>;
    /// Tell live attach sessions on this task why they are ending,
    /// BEFORE the PTYs are killed.
    fn notify_detach(&self, task_id: &str, reason: &str);
    /// The user's home directory (session transcripts live under it).
    fn home_dir(&self) -> Option<PathBuf>;
}

#[derive(Debug, Clone)]
pub(crate) struct WorkStateInfo {
    pub state: String,
    pub tabs: u32,
}

/// The gate every authenticated verb passes: the "Enable CLI" setting,
/// then the per-boot token. Shared by the normal dispatch and the
/// attach path (which consumes the connection before dispatch).
fn auth_gate(req: &Request, host: &dyn CliHost) -> Option<Reply> {
    if !host.cli_enabled() {
        return Some(Reply::err(&req.id, ErrorCode::CliDisabled, proto::CLI_DISABLED_MESSAGE));
    }
    // Constant-ish compare is not load-bearing against a same-uid local
    // caller; possession of the 0600 file is the credential.
    if req.token.as_deref() != Some(host.token()) {
        return Some(Reply::err(&req.id, ErrorCode::Auth, "invalid or missing CLI token"));
    }
    None
}

pub(crate) fn handle_request(req: &Request, host: &dyn CliHost, sink: &mut dyn EventSink) -> Reply {
    // Hello is the whole unauthenticated surface: app-running + protocol
    // version. Nothing else leaks before the token check.
    if let Command::Hello = req.cmd {
        return Reply::ok(
            &req.id,
            ReplyData::Hello(proto::HelloData {
                app: "termic".into(),
                app_version: host.app_version(),
                protocol: proto::PROTOCOL_VERSION,
            }),
        );
    }
    // Raise is the other unauthenticated verb: a second instance launching
    // on this data dir asks the running one to come to front, then exits
    // (single instance per data dir). Same trust tier as hello.
    if let Command::Raise = req.cmd {
        host.raise_window();
        return Reply { id: req.id.clone(), ok: true, data: None, error: None };
    }
    if let Some(refused) = auth_gate(req, host) {
        return refused;
    }
    match &req.cmd {
        Command::Hello | Command::Raise => unreachable!("handled above"),
        // A live attach session is handled by serve_conn BEFORE dispatch
        // (it takes over the whole connection); reaching here means a
        // path with no bidirectional transport (tests, future callers).
        Command::Attach { .. } => Reply::err(
            &req.id,
            ErrorCode::BadRequest,
            "attach needs a dedicated connection",
        ),
        Command::List { project, quiet } => {
            handle_list(&req.id, host, project.as_deref(), *quiet)
        }
        Command::Status { task, project, cwd } => {
            handle_status(&req.id, host, task.as_deref(), project.as_deref(), cwd.as_deref())
        }
        Command::Open { task, project, cwd } => {
            handle_open(&req.id, host, task.as_deref(), project.as_deref(), cwd.as_deref())
        }
        Command::New { .. } => handle_new(req, host, sink),
        Command::Wait { task, project, timeout_ms, tab, cwd } => {
            handle_wait(
                &req.id,
                host,
                task.as_deref(),
                project.as_deref(),
                cwd.as_deref(),
                *timeout_ms,
                tab.as_deref(),
                sink,
            )
        }
        Command::Quit { commit } => {
            let (tasks_with_agents, live_agents) = host.live_agent_counts();
            // Working count comes from the webview cache - only it knows
            // work state. A stale cache reports 0 rather than guessing, so
            // the number is a floor: it never overstates what the user is
            // about to lose, and the PTY counts above still tell the truth
            // about what dies.
            let snap = host.agent_cache().snapshot();
            // Per TASK, not per agent: the cache aggregates a single state
            // per task. Clamped, because a cache inside the staleness window
            // can still lag a PTY that just died, which would otherwise read
            // as "kills 1 agent across 1 task, 2 of them still working".
            //
            // None when the cache is stale: the webview stopped reporting, so
            // this is UNKNOWN rather than zero. The prompt says so instead of
            // quietly dropping the note, which would read the same as "nothing
            // is working" on a question about killing agents.
            let working_tasks = snap
                .age
                .filter(|a| *a <= CACHE_STALE_AFTER)
                .map(|_| {
                    (snap.states.values().filter(|s| s.state == "working").count() as u32)
                        .min(tasks_with_agents)
                });
            if *commit {
                // Armed, not fired: serve_conn tears down after this reply is
                // written. See the note there.
                QUIT_AFTER_REPLY.with(|f| f.set(true));
            }
            Reply::ok(
                &req.id,
                ReplyData::Quit(proto::QuitData {
                    running: true,
                    tasks_with_agents,
                    live_agents,
                    working_tasks,
                    quitting: *commit,
                }),
            )
        }
        Command::Agents => handle_agents(req, host),
        Command::Tab { .. } => handle_tab(req, host, sink),
        Command::Archive { task, project } => {
            handle_archive(&req.id, host, task, project.as_deref())
        }
        Command::ProjectAdd { path, non_git } => {
            handle_project_add(&req.id, host, path, *non_git)
        }
        Command::ProjectList => handle_project_list(&req.id, host),
        Command::ProjectRemove { name } => handle_project_remove(&req.id, host, name),
        Command::Send { .. } => handle_send(req, host, sink),
        Command::Apply { task, project } => {
            handle_apply(&req.id, host, task, project.as_deref())
        }
        Command::Diff { task, project, full, cwd } => {
            handle_diff(&req.id, host, task.as_deref(), project.as_deref(), *full, cwd.as_deref())
        }
        Command::Logs { task, project, shell, tab, last_bytes, cwd } => handle_logs(
            &req.id,
            host,
            task.as_deref(),
            project.as_deref(),
            *shell,
            tab.as_deref(),
            *last_bytes,
            cwd.as_deref(),
        ),
        Command::LastResult { task, project, cwd } => {
            handle_result(&req.id, host, task.as_deref(), project.as_deref(), cwd.as_deref())
        }
    }
}

fn handle_list(id: &str, host: &dyn CliHost, project: Option<&str>, quiet: bool) -> Reply {
    let (projects, mut tasks) = host.projects_tasks();
    tasks.retain(|t| !t.archived);
    if let Some(name) = project {
        let Some(p) = find_project(&projects, name) else {
            return Reply::err(id, ErrorCode::NotFound, format!("no project named \"{name}\""));
        };
        let pid = p.id.clone();
        tasks.retain(|t| t.project_id == pid);
    }
    // `-q` prints ids only, so skip the two expensive per-list costs the
    // output never uses: the webview work-state round-trip and the
    // per-task git diff (2 subprocesses each).
    let states = if quiet {
        None
    } else {
        let ids: Vec<String> = tasks.iter().map(|t| t.id.clone()).collect();
        host.work_states(&ids)
    };
    let mut rows: Vec<proto::TaskSummary> = tasks
        .iter()
        .map(|t| {
            let diff = if quiet { None } else { host.diff_stat(t) };
            summarize(t, &projects, states.as_ref(), diff)
        })
        .collect();
    rows.sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
    Reply::ok(id, ReplyData::List(proto::ListData { tasks: rows }))
}

fn handle_status(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(&projects, &tasks, task, project, cwd) {
        Ok(t) => t,
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    let states = host.work_states(std::slice::from_ref(&t.id));
    let diff = host.diff_stat(t);
    let summary = summarize(t, &projects, states.as_ref(), diff.clone());
    let sandbox = sandbox_mode_str(t);
    let sessions = (t.persisted_tabs.len() + t.right_split_tabs.len()) as u32;
    let dirty_files = diff.map(|d| d.files_changed + d.untracked);
    let tabs = cached_tab_states(&host.agent_cache().snapshot(), &t.id);
    Reply::ok(
        id,
        ReplyData::Status(proto::StatusData {
            task: proto::TaskStatus { summary, sandbox, sessions, dirty_files, tabs },
        }),
    )
}

fn handle_open(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let resolved: Option<&Task> = match task {
        Some(name) => match resolve_by_name(&projects, &tasks, name, project) {
            Ok(t) => Some(t),
            Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
        },
        None => match cwd {
            Some(cwd) => match resolve_by_cwd(&projects, &tasks, cwd) {
                Ok(t) => t,
                Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
            },
            None => None,
        },
    };
    if let Some(t) = resolved {
        if let Err(e) = host.open_task_in_ui(&t.id) {
            host.raise_window();
            return Reply::err(
                id,
                ErrorCode::Internal,
                format!("could not select the task in Termic ({e})"),
            );
        }
    }
    host.raise_window();
    let summary = resolved.map(|t| summarize(t, &projects, None, None));
    Reply::ok(id, ReplyData::Open(proto::OpenData { task: summary, raised: true }))
}

// ───────────────────────────── new ───────────────────────────────────

/// Resolve which project `new` targets: worktree task first (creating
/// from inside a task worktree lands in that task's project), then the
/// longest registered project-root prefix. `Err` distinguishes "a git
/// repo you could register" from "nowhere at all".
pub(crate) fn resolve_project_for_new<'a>(
    projects: &'a [Project],
    tasks: &[Task],
    host: &dyn CliHost,
    cwd: Option<&str>,
) -> Result<&'a Project, proto::ErrorBody> {
    let Some(cwd) = cwd else {
        return Err(proto::ErrorBody {
            code: ErrorCode::NotFound,
            message: "no working directory given; use --project".into(),
            data: None,
        });
    };
    // Inside a task worktree? That task's project wins (worktree-first,
    // docs/plans/cli.md Traps). Ambiguity here means shared main
    // checkouts, which still agree on the project via longest prefix.
    if let Ok(Some(t)) = resolve_by_cwd(projects, tasks, cwd) {
        if let Some(p) = projects.iter().find(|p| p.id == t.project_id) {
            return Ok(p);
        }
    }
    let canon_cwd = canon(cwd);
    let mut best: Option<&Project> = None;
    for p in projects {
        let root = canon(&p.root_path);
        if under(&canon_cwd, &root)
            && best.is_none_or(|b| canon(&b.root_path).len() < root.len())
        {
            best = Some(p);
        }
    }
    if let Some(p) = best {
        return Ok(p);
    }
    match host.git_toplevel(cwd) {
        Some(root) => Err(proto::ErrorBody {
            code: ErrorCode::UnregisteredProject,
            message: format!(
                "{root} is a git repository but not a registered Termic project. Register it with `termic project add {root}`, or pass --project."
            ),
            data: Some(serde_json::json!({ "root": root })),
        }),
        None => Err(proto::ErrorBody {
            code: ErrorCode::NotFound,
            message: "not inside a registered project or a git repository; use --project <name> or a qualified <project>/<task> name".into(),
            data: None,
        }),
    }
}

fn handle_new(req: &Request, host: &dyn CliHost, sink: &mut dyn EventSink) -> Reply {
    let Command::New {
        name,
        prompt,
        agent,
        mode,
        base,
        sandbox,
        yolo,
        project,
        open,
        wait,
        timeout_ms,
        cwd,
    } = &req.cmd
    else {
        unreachable!("handle_new called with a non-new command")
    };
    let id = &req.id;
    let fail = |code, msg: String| Reply::err(id, code, msg);

    // Validate the enums FIRST: cheap, side-effect free.
    if let Some(m) = mode.as_deref() {
        if m != "worktree" && m != "main" {
            return fail(ErrorCode::BadRequest, format!("unknown mode \"{m}\" (worktree or main)"));
        }
    }
    if let Some(s) = sandbox.as_deref() {
        if !["off", "monitor", "enforce", "enforce-fs"].contains(&s) {
            return fail(
                ErrorCode::BadRequest,
                format!("unknown sandbox mode \"{s}\" (off, monitor, enforce or enforce-fs)"),
            );
        }
    }
    let mut trimmed = name.trim();
    if trimmed.is_empty() {
        return fail(ErrorCode::BadRequest, "the task name is empty".into());
    }
    // An empty prompt would mint a prompt id nothing ever reports on
    // and burn the whole delivery timeout under --wait.
    let prompt = prompt.as_ref().filter(|p| !p.trim().is_empty());

    let (projects, tasks) = host.projects_tasks();
    // `new web/fix-auth` targets project web, like the read verbs'
    // qualified form. Only without --project (an explicit --project
    // keeps the name literal, the escape hatch for slash-NAMED tasks
    // whose prefix collides with a project name) and only when the
    // prefix actually names a registered project; otherwise the slash
    // stays part of the task name and seeds the branch, as in the GUI.
    let qualified = match project {
        Some(_) => None,
        None => trimmed.split_once('/').and_then(|(prefix, rest)| {
            let rest = rest.trim();
            (!rest.is_empty())
                .then(|| find_project(&projects, prefix).map(|p| (p, rest)))
                .flatten()
        }),
    };
    let proj = match (qualified, project.as_deref()) {
        (Some((p, rest)), _) => {
            trimmed = rest;
            p
        }
        (None, Some(pname)) => match find_project(&projects, pname) {
            Some(p) => p,
            None => return fail(ErrorCode::NotFound, format!("no project named \"{pname}\"")),
        },
        (None, None) => match resolve_project_for_new(&projects, &tasks, host, cwd.as_deref()) {
            Ok(p) => p,
            Err(e) => return Reply { id: id.clone(), ok: false, data: None, error: Some(e) },
        },
    };

    // Non-git projects cannot host worktrees (the GUI forces the main
    // checkout for them); an explicit --worktree is an impossible ask,
    // and an unspecified mode is pinned to main HERE, against the
    // disk-read project, so a lagging webview store cannot fall back to
    // a remembered worktree mode.
    if proj.non_git && mode.as_deref() == Some("worktree") {
        return fail(
            ErrorCode::BadRequest,
            format!(
                "project \"{}\" is a plain folder (non-git); worktree tasks need git. Use --main or omit the mode.",
                proj.name
            ),
        );
    }
    let mode = if proj.non_git { &Some("main".to_string()) } else { mode };

    // Same-name collision is a clean error naming the existing task,
    // never cleanup (docs/plans/cli.md: task_create_sync's orphan
    // cleanup makes interleaved same-name creates destructive; the
    // webview create lock serializes, this check keeps the error clear).
    if let Some(existing) = tasks
        .iter()
        .find(|t| !t.archived && t.project_id == proj.id && t.name.eq_ignore_ascii_case(trimmed))
    {
        return fail(
            ErrorCode::Conflict,
            format!("task {}/{} already exists", proj.name, existing.name),
        );
    }

    // Validate the agent against the registry (the project default is
    // what the webview falls back to when None).
    let agents = host.agents();
    let effective_agent = agent.clone().unwrap_or_else(|| proj.default_cli.clone());
    let known = agents.iter().find(|a| a.id == effective_agent && a.kind == "agent");
    match known {
        Some(meta) if meta.disabled => {
            return fail(
                ErrorCode::Unsupported,
                format!("agent \"{effective_agent}\" is disabled in Settings; enable it there or pass a different --agent"),
            );
        }
        None => {
            let mut ids: Vec<&str> = agents
                .iter()
                .filter(|a| a.kind == "agent" && !a.disabled)
                .map(|a| a.id.as_str())
                .collect();
            ids.sort();
            return fail(
                ErrorCode::NotFound,
                format!("unknown agent \"{effective_agent}\" (available: {})", ids.join(", ")),
            );
        }
        Some(meta) if *wait && !meta.work_done => {
            return fail(
                ErrorCode::Unsupported,
                format!(
                    "agent \"{effective_agent}\" has work-done detection disabled, so --wait has no settle signal. Create the task without --wait."
                ),
            );
        }
        Some(_) => {}
    }

    // Register delivery interest BEFORE the webview learns the id, so a
    // fast report can never race past us.
    let prompt_id = prompt.as_ref().map(|_| uuid::Uuid::new_v4().simple().to_string());
    if let Some(pid) = &prompt_id {
        host.prompt_reports().expect(pid);
    }

    let params = serde_json::json!({
        "name": trimmed,
        "agent": agent,
        "mode": mode,
        "base": base,
        "sandbox": sandbox,
        "yolo": yolo,
        "projectId": proj.id,
        "open": open,
        "prompt": prompt,
        "promptId": prompt_id,
    });
    // Forward setup output; heartbeat on idle. A dead client cannot
    // cancel the create (it already committed app-side), so emit
    // failures just stop the streaming.
    let mut sink_dead = false;
    let value = {
        let mut on_progress = |p: RpcProgress| {
            if sink_dead {
                return;
            }
            sink_dead = match p {
                RpcProgress::Value(v) => match v.get("setupOutput").and_then(|d| d.as_str()) {
                    Some(data) => {
                        sink.emit(&StreamEvent::setup_output(id, data.to_string())).is_err()
                    }
                    None => false,
                },
                RpcProgress::Idle => sink.emit(&StreamEvent::heartbeat(id)).is_err(),
            };
        };
        host.rpc_stream("new_task", params, NEW_TASK_TIMEOUT, &mut on_progress)
    };
    let value = match value {
        Ok(v) => v,
        Err(e) => {
            if let Some(pid) = &prompt_id {
                host.prompt_reports().forget(pid);
            }
            return fail(ErrorCode::Internal, format!("could not create the task ({e})"));
        }
    };
    let task_id = value
        .get("taskId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    // "spawned" = the default agent tab holds a live PTY. The prompt
    // path folds a failed spawn into the delivery report (exit 9); the
    // promptless --wait path must fail here or an idle dead task would
    // read as quiescent (a false exit 0).
    let spawned = value.get("spawned").and_then(|v| v.as_bool()).unwrap_or(true);

    // Reload: the create committed on disk; summarize the fresh task.
    let (projects, tasks) = host.projects_tasks();
    let Some(task) = tasks.iter().find(|t| t.id == task_id) else {
        if let Some(pid) = &prompt_id {
            host.prompt_reports().forget(pid);
        }
        return fail(
            ErrorCode::Internal,
            "the task was created but could not be read back".into(),
        );
    };
    let states = host.work_states(std::slice::from_ref(&task_id));
    let summary = summarize(task, &projects, states.as_ref(), None);
    let _ = sink.emit(&StreamEvent::created(id, summary.clone()));
    if *open {
        host.raise_window();
    }

    if !*wait {
        // Without --wait the reply lands at spawn. A prompt keeps
        // injecting app-side, UNCONFIRMED by design; --wait is the
        // strong contract (exit 0 = delivered + settled).
        if let Some(pid) = &prompt_id {
            host.prompt_reports().forget(pid);
        }
        return Reply::ok(id, ReplyData::New(proto::NewData { task: summary, wait: None }));
    }

    if !spawned && prompt_id.is_none() {
        return fail(
            ErrorCode::Internal,
            format!(
                "the task was created but its agent never spawned; open {}/{} in Termic",
                summary.project, summary.name
            ),
        );
    }
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let watch = watch_agent(
        host,
        WatchOpts {
            req_id: id,
            task_id: &task_id,
            tab_id: None,
            prompt_id: prompt_id.as_deref(),
            deadline,
            strict_target: false,
            queued: false,
            // A fresh task's only agent is ours, so a done/waiting state
            // IS our turn settling.
            trust_done: true,
        },
        sink,
    );
    match watch {
        Ok(result) => {
            // Refresh the state column so the final object tells the
            // truth about where the agent landed.
            let states = host.work_states(std::slice::from_ref(&task_id));
            let mut summary = summary;
            if let Some(info) = states.as_ref().and_then(|m| m.get(&task_id)) {
                summary.work_state = Some(info.state.clone());
                summary.open_tabs = Some(info.tabs);
            }
            Reply::ok(id, ReplyData::New(proto::NewData { task: summary, wait: Some(result) }))
        }
        Err(e) => Reply { id: id.clone(), ok: false, data: None, error: Some(e) },
    }
}

// ───────────────────────────── wait ──────────────────────────────────

struct WatchOpts<'a> {
    req_id: &'a str,
    task_id: &'a str,
    /// Some = watch ONE strip tab instead of the task aggregate
    /// (`--tab`, GH #138 part 2): state, queue and capability all read
    /// from that tab's pushed entry, so a sibling tab can neither
    /// satisfy nor stall the wait.
    tab_id: Option<&'a str>,
    /// Some = track our OWN injected prompt: outcome requires confirmed
    /// delivery plus that turn settling, not just any quiet.
    prompt_id: Option<&'a str>,
    deadline: Option<Instant>,
    /// `wait` verb semantics: refuse an inactive or incapable target on
    /// first sight instead of waiting on a signal that cannot come.
    strict_target: bool,
    /// The prompt sits in the agent's message queue behind a running
    /// turn (`send` to a busy agent). The fixed DELIVERY_TIMEOUT does
    /// not apply (a turn can legitimately run for an hour); instead the
    /// watch fails when the QUEUE empties without a delivery report
    /// (a webview reload drops the queue, and with it the prompt).
    queued: bool,
    /// Whether a cached "done"/"waiting" state counts as OUR turn
    /// settling without an observed working edge. True for `new` (a
    /// fresh task's only agent is ours, so any done is ours); false for
    /// `send` (the aggregate is task-level and a SIBLING tab's stale
    /// done badge would read as an instant false exit 0). Without the
    /// shortcut, a missed working edge falls back to the post-delivery
    /// idle grace.
    trust_done: bool,
}

fn outcome_for(state: &str) -> WaitOutcome {
    match state {
        "waiting" => WaitOutcome::NeedsInput,
        _ => WaitOutcome::Done,
    }
}

/// The signal watch_agent actually reads each snapshot: the task
/// aggregate, or one tab's entry under `--tab`. Normalizing here keeps
/// the state machine below identical for both.
struct SignalView {
    state: String,
    queued: u32,
    capable: bool,
}

/// Block until the task's agent is quiescent (settled AND empty queue),
/// riding the webview-pushed cache. Emits state transitions and
/// heartbeats to `sink`; aborts early when the client hangs up.
fn watch_agent(
    host: &dyn CliHost,
    opts: WatchOpts<'_>,
    sink: &mut dyn EventSink,
) -> Result<proto::WaitResult, proto::ErrorBody> {
    let internal = |msg: &str| proto::ErrorBody {
        code: ErrorCode::Internal,
        message: msg.to_string(),
        data: None,
    };
    let cache = host.agent_cache();
    let reports = host.prompt_reports();
    let started = Instant::now();
    let mut awaiting_delivery = opts.prompt_id.is_some();
    let mut delivered_at: Option<Instant> = None;
    let mut last_state: Option<String> = None;
    let mut seen_working = false;
    let mut seen_active = false;
    let mut last_seq = 0u64;
    let mut last_heartbeat = Instant::now();
    // A webview reload replaces the cache wholesale and can transiently
    // push an EMPTY map (before loadAll hydrates); the entry-missing
    // error therefore requires the entry to be CONTINUOUSLY absent for
    // the grace window, never a single bad snapshot mid-wait.
    let mut entry_missing_since: Option<Instant> = None;
    // Same rule for the WATCHED TAB under `--tab`: continuously gone
    // from the pushed strip means it closed.
    let mut tab_missing_since: Option<Instant> = None;
    // Queued sends only: how long the agent's queue has been empty with
    // the agent not working while our delivery report is still missing.
    // Continuously past the grace window = the queue (and our prompt)
    // is gone, most likely a webview reload.
    let mut queue_gone_since: Option<Instant> = None;
    // Queued sends only: how long the agent has been STOPPED FOR INPUT
    // with our prompt still queued behind it. The drain only advances
    // on work-done, so an attention stop strands the queue until a
    // human answers; exit 3 is the honest report (the prompt stays
    // queued and still delivers if they do).
    let mut queue_waiting_since: Option<Instant> = None;

    let cleanup = |awaiting: bool| {
        if awaiting {
            if let Some(pid) = opts.prompt_id {
                reports.forget(pid);
            }
        }
    };

    loop {
        if let Some(d) = opts.deadline {
            if Instant::now() >= d {
                cleanup(awaiting_delivery);
                return Ok(proto::WaitResult {
                    outcome: WaitOutcome::Timeout,
                    state: last_state,
                    detail: None,
                });
            }
        }

        if awaiting_delivery {
            if let Some(pid) = opts.prompt_id {
                match reports.try_take(pid) {
                    Some(Ok(())) => {
                        awaiting_delivery = false;
                        delivered_at = Some(Instant::now());
                        let _ = sink.emit(&StreamEvent::prompt_delivered(opts.req_id));
                    }
                    Some(Err(reason)) => {
                        return Ok(proto::WaitResult {
                            outcome: WaitOutcome::NotDelivered,
                            state: last_state,
                            detail: Some(reason),
                        });
                    }
                    None if !opts.queued && started.elapsed() >= DELIVERY_TIMEOUT => {
                        reports.forget(pid);
                        return Ok(proto::WaitResult {
                            outcome: WaitOutcome::NotDelivered,
                            state: last_state,
                            detail: Some(
                                "no delivery confirmation from the Termic UI (a reload drops the injection)"
                                    .into(),
                            ),
                        });
                    }
                    None => {}
                }
            }
        }

        let snap = cache.snapshot();
        match snap.age {
            None => {
                if started.elapsed() > POPULATE_GRACE {
                    cleanup(awaiting_delivery);
                    return Err(internal(
                        "the Termic UI has not reported agent state (is the app still starting?)",
                    ));
                }
            }
            Some(age) => {
                if let Some(entry) = snap.states.get(opts.task_id) {
                    entry_missing_since = None;
                    // Under --tab the watched signal narrows to ONE strip
                    // tab (GH #138 part 2). A durable tab whose PTY is
                    // not live maps to "inactive": the same meaning as a
                    // task with no agent open, and the same honesty rules
                    // below apply to it unchanged.
                    let view = match opts.tab_id {
                        None => Some(SignalView {
                            state: entry.state.clone(),
                            queued: entry.queued,
                            capable: entry.capable,
                        }),
                        Some(tid) => {
                            entry.tab_states.iter().find(|t| t.id == tid).map(|t| SignalView {
                                state: if !t.live {
                                    "inactive".into()
                                } else {
                                    t.state.clone().unwrap_or_else(|| "idle".into())
                                },
                                queued: t.queued,
                                capable: t.capable,
                            })
                        }
                    };
                    match view {
                        None => {
                            // The watched tab is gone from the pushed
                            // strip. Same transient-empty-push tolerance
                            // as a missing task entry; continuously
                            // absent means it closed and no signal can
                            // come.
                            if tab_missing_since.get_or_insert_with(Instant::now).elapsed()
                                > POPULATE_GRACE
                            {
                                cleanup(awaiting_delivery);
                                return Err(proto::ErrorBody {
                                    code: ErrorCode::Unsupported,
                                    message:
                                        "the tab went away while waiting (closed, or the task stopped)"
                                            .into(),
                                    data: None,
                                });
                            }
                        }
                        Some(view) => {
                            tab_missing_since = None;
                            if opts.strict_target && last_state.is_none() {
                                // First sight of the target under `wait`.
                                if view.state == "inactive" {
                                    return Err(proto::ErrorBody {
                                        code: ErrorCode::Unsupported,
                                        message: if opts.tab_id.is_some() {
                                            "no agent is running in that tab (open one with `termic tab`, then rerun)".into()
                                        } else {
                                            "no agent is open in this task (open it in Termic, then rerun)"
                                                .to_string()
                                        },
                                        data: None,
                                    });
                                }
                                if !view.capable {
                                    return Err(proto::ErrorBody {
                                        code: ErrorCode::Unsupported,
                                        message: if opts.tab_id.is_some() {
                                            "that tab's agent has work-done detection disabled, there is no settle signal to wait on".into()
                                        } else {
                                            "this task's agent has work-done detection disabled, there is no settle signal to wait on".to_string()
                                        },
                                        data: None,
                                    });
                                }
                            }
                            if last_state.as_deref() != Some(view.state.as_str()) {
                                last_state = Some(view.state.clone());
                                let _ = sink.emit(&StreamEvent::state(opts.req_id, view.state.clone()));
                            }
                            if view.state == "working" {
                                seen_working = true;
                            }
                            if view.state != "inactive" {
                                seen_active = true;
                            }
                            if awaiting_delivery && opts.queued {
                                // The queued prompt's liveness signal: while it
                                // (or anything ahead of it) is queued, or the
                                // agent is mid-turn, the loop is healthy. An
                                // empty queue on a non-working agent with no
                                // delivery report can only mean the queue was
                                // dropped (reload) or the drain's report was
                                // lost; either way delivery cannot be claimed.
                                let queue_alive = view.queued > 0 || view.state == "working";
                                if queue_alive {
                                    queue_gone_since = None;
                                } else if queue_gone_since.get_or_insert_with(Instant::now).elapsed()
                                    > IDLE_SETTLE_GRACE
                                {
                                    cleanup(true);
                                    return Ok(proto::WaitResult {
                                        outcome: WaitOutcome::NotDelivered,
                                        state: Some(view.state.clone()),
                                        detail: Some(
                                            "the queued prompt disappeared before delivery (a Termic reload drops the queue)"
                                                .into(),
                                        ),
                                    });
                                }
                                // The in-flight turn ended asking for INPUT: the
                                // drain advances on work-done only, so nothing
                                // will deliver our prompt until a human answers.
                                // Persisting past the grace, exit 3 is the honest
                                // report; the prompt STAYS queued and delivers if
                                // they unblock the agent later.
                                if view.state == "waiting" && view.queued > 0 {
                                    if queue_waiting_since.get_or_insert_with(Instant::now).elapsed()
                                        > IDLE_SETTLE_GRACE
                                    {
                                        cleanup(true);
                                        return Ok(proto::WaitResult {
                                            outcome: WaitOutcome::NeedsInput,
                                            state: Some(view.state.clone()),
                                            detail: Some(
                                                "the agent stopped for input before the queued prompt could deliver; it stays queued"
                                                    .into(),
                                            ),
                                        });
                                    }
                                } else {
                                    queue_waiting_since = None;
                                }
                            }
                            if !awaiting_delivery {
                                let quiescent = view.state != "working" && view.queued == 0;
                                // A task the webview reports as inactive never
                                // ran here: only count it as "stopped" once we
                                // saw it alive (or gave the spawn a fair grace).
                                let inactive_ok = view.state != "inactive"
                                    || seen_active
                                    || started.elapsed() > IDLE_SETTLE_GRACE;
                                // An agent that VANISHED (tab closed, task
                                // stopped) is not "settled done": exit 0 here
                                // would send a script off to read a RESULT.md
                                // that was never written. Error instead. This
                                // deliberately covers finished-then-closed too:
                                // a done snapshot the watch actually SAW already
                                // returned Done above, so reaching inactive
                                // means done and close coalesced into one push
                                // (the 80ms debounce) and "it finished" cannot
                                // be distinguished from "it was killed mid-turn".
                                // Honesty rule: never claim settled without
                                // evidence.
                                if quiescent && inactive_ok && view.state == "inactive" {
                                    cleanup(awaiting_delivery);
                                    return Err(proto::ErrorBody {
                                        code: ErrorCode::Unsupported,
                                        message: "the agent went away while waiting (tab closed or task stopped)"
                                            .into(),
                                        data: None,
                                    });
                                }
                                let own_prompt_settled = opts.prompt_id.is_none()
                                    || seen_working
                                    || (opts.trust_done
                                        && (view.state == "done" || view.state == "waiting"))
                                    || delivered_at.is_some_and(|t| t.elapsed() > IDLE_SETTLE_GRACE);
                                if quiescent && inactive_ok && own_prompt_settled {
                                    return Ok(proto::WaitResult {
                                        outcome: outcome_for(&view.state),
                                        state: Some(view.state.clone()),
                                        detail: None,
                                    });
                                }
                            }
                        }
                    }
                } else if entry_missing_since.get_or_insert_with(Instant::now).elapsed()
                    > POPULATE_GRACE
                {
                    cleanup(awaiting_delivery);
                    // Archived tasks drop out of the pushed map; say so
                    // instead of blaming the UI.
                    let archived = host
                        .projects_tasks()
                        .1
                        .iter()
                        .find(|t| t.id == opts.task_id)
                        .is_none_or(|t| t.archived);
                    if archived {
                        return Err(internal("the task was archived while waiting"));
                    }
                    return Err(internal("the Termic UI is not reporting this task's state"));
                }
                // Staleness only matters when we KEEP waiting: an
                // already-quiescent answer returned above even if the
                // last push is old (an idle occluded webview is not a
                // dead one). From here on, flips could not reach us.
                if age > CACHE_STALE_AFTER {
                    cleanup(awaiting_delivery);
                    return Err(internal("the Termic UI stopped reporting agent state"));
                }
            }
        }

        if last_heartbeat.elapsed() >= HEARTBEAT_EVERY {
            last_heartbeat = Instant::now();
            if sink.emit(&StreamEvent::heartbeat(opts.req_id)).is_err() {
                // Client hung up mid-wait: stop watching (the task keeps
                // running); the reply write will fail the same way.
                cleanup(awaiting_delivery);
                return Ok(proto::WaitResult {
                    outcome: WaitOutcome::Timeout,
                    state: last_state,
                    detail: Some("client disconnected".into()),
                });
            }
        }

        // Delivery reports don't bump the cache seq, so poll faster
        // while one is pending; otherwise sleep until the next heartbeat
        // is due (cache pushes wake us early), keeping the keepalive
        // cadence tight against the CLI's 30s read timeout. Clamped to
        // the caller's deadline so --timeout never overshoots by a
        // sleep slice.
        let mut slice = if awaiting_delivery {
            CV_SLICE
        } else {
            HEARTBEAT_EVERY
                .saturating_sub(last_heartbeat.elapsed())
                .max(Duration::from_millis(20))
        };
        if let Some(d) = opts.deadline {
            slice = slice
                .min(d.saturating_duration_since(Instant::now()))
                .max(Duration::from_millis(5));
        }
        last_seq = cache.wait_change(last_seq, slice);
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_wait(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
    tab: Option<&str>,
    sink: &mut dyn EventSink,
) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(&projects, &tasks, task, project, cwd) {
        Ok(t) => t,
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    let target = match tab.map(|sel| resolve_tab_selector(host, t, sel)).transpose() {
        Ok(rt) => rt,
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let watch = watch_agent(
        host,
        WatchOpts {
            req_id: id,
            task_id: &t.id,
            tab_id: target.as_ref().map(|rt| rt.id.as_str()),
            prompt_id: None,
            deadline,
            strict_target: true,
            queued: false,
            trust_done: true,
        },
        sink,
    );
    match watch {
        Ok(result) => Reply::ok(
            id,
            ReplyData::Wait(proto::WaitData { task_id: t.id.clone(), result }),
        ),
        Err(e) => Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    }
}

// ───────────────────────────── send ──────────────────────────────────

/// The webview's send_prompt handler makes its DOMAIN failures
/// machine-readable across the string-only RPC error channel with a
/// sentinel prefix: "cli_send:<code>: <human message>". Anything else
/// is a real internal failure.
fn parse_send_error(e: &str) -> (ErrorCode, String) {
    let Some(rest) = e.strip_prefix("cli_send:") else {
        return (ErrorCode::Internal, format!("could not send the prompt ({e})"));
    };
    let (code, msg) = rest.split_once(':').unwrap_or(("", rest));
    let code = match code {
        "no_agent" | "no_session" | "not_capable" | "flags_useless" | "ambiguous"
        | "not_sendable" | "tab_not_live" => ErrorCode::Unsupported,
        // The resolver's cache trailed the store: the tab closed between
        // resolution and delivery.
        "unknown_tab" => ErrorCode::NotFound,
        _ => ErrorCode::Internal,
    };
    (code, msg.trim().to_string())
}

fn handle_send(req: &Request, host: &dyn CliHost, sink: &mut dyn EventSink) -> Reply {
    let Command::Send { task, project, prompt, resume, fresh, wait, timeout_ms, tab, cwd } =
        &req.cmd
    else {
        unreachable!("handle_send called with a non-send command")
    };
    let id = &req.id;
    if prompt.trim().is_empty() {
        return Reply::err(id, ErrorCode::BadRequest, "the prompt is empty");
    }
    // clap guards this in the shipped CLI; the wire guard keeps a
    // hand-rolled client from silently getting one behavior of the two.
    if *resume && *fresh {
        return Reply::err(id, ErrorCode::BadRequest, "resume and fresh are mutually exclusive");
    }
    if tab.is_some() && (*resume || *fresh) {
        return Reply::err(
            id,
            ErrorCode::BadRequest,
            "--tab targets a tab that is already open; drop --resume/--fresh",
        );
    }
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(
        &projects,
        &tasks,
        task.as_deref(),
        project.as_deref(),
        cwd.as_deref(),
    ) {
        Ok(t) => t.clone(),
        Err(e) => return Reply { id: id.clone(), ok: false, data: None, error: Some(e) },
    };
    let target = match tab.as_deref().map(|sel| resolve_tab_selector(host, &t, sel)).transpose() {
        Ok(rt) => rt,
        Err(e) => return Reply { id: id.clone(), ok: false, data: None, error: Some(e) },
    };

    // Register delivery interest BEFORE the webview learns the id (the
    // handle_new rule): a fast report can never race past us.
    let prompt_id = uuid::Uuid::new_v4().simple().to_string();
    host.prompt_reports().expect(&prompt_id);

    let params = serde_json::json!({
        "taskId": t.id,
        "prompt": prompt,
        "promptId": prompt_id,
        "resume": resume,
        "fresh": fresh,
        "wait": wait,
        "tabId": target.as_ref().map(|rt| rt.id.as_str()),
    });
    // Idle ticks keep the CLI's 30s read timeout honest while a
    // respawned agent boots; there is no payload progress to forward.
    let mut sink_dead = false;
    let value = {
        let mut on_progress = |p: RpcProgress| {
            if sink_dead {
                return;
            }
            if matches!(p, RpcProgress::Idle) {
                sink_dead = sink.emit(&StreamEvent::heartbeat(id)).is_err();
            }
        };
        host.rpc_stream("send_prompt", params, SEND_TIMEOUT, &mut on_progress)
    };
    let value = match value {
        Ok(v) => v,
        Err(e) => {
            host.prompt_reports().forget(&prompt_id);
            let (code, msg) = parse_send_error(&e);
            return Reply::err(id, code, msg);
        }
    };
    let mode = value
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or(proto::send_mode::DELIVERED)
        .to_string();
    let capable = value.get("capable").and_then(|c| c.as_bool()).unwrap_or(true);
    if mode == proto::send_mode::QUEUED {
        let _ = sink.emit(&StreamEvent::queued(id));
    }

    if !*wait {
        // Delivered mode already confirmed inside the RPC (the handler
        // awaits the tracked injection); queued/spawned stay unconfirmed
        // by design, exactly like `new` without --wait.
        host.prompt_reports().forget(&prompt_id);
        return Reply::ok(
            id,
            ReplyData::Send(proto::SendData { task_id: t.id, mode, capable, wait: None }),
        );
    }
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let queued = mode == proto::send_mode::QUEUED;
    let watch = watch_agent(
        host,
        WatchOpts {
            req_id: id,
            task_id: &t.id,
            tab_id: target.as_ref().map(|rt| rt.id.as_str()),
            prompt_id: Some(&prompt_id),
            deadline,
            strict_target: false,
            queued,
            // Never trust a pre-existing done as OUR turn settling, with
            // or without --tab. Per-tab state removes sibling pollution
            // but not the race on the target itself: the cache trails
            // the store by the push debounce, and the tab you target is
            // OFTEN one showing a stale done badge from its last turn,
            // which would read as an instant false exit 0 the moment
            // delivery confirms. (`tab -p` differs: its tab is brand
            // new, so any done it shows is genuinely ours.)
            trust_done: false,
        },
        sink,
    );
    match watch {
        Ok(result) => Reply::ok(
            id,
            ReplyData::Send(proto::SendData {
                task_id: t.id,
                mode,
                capable,
                wait: Some(result),
            }),
        ),
        Err(e) => {
            // Every Err path inside watch_agent already releases the
            // report; this is drift insurance so a future path can
            // never leak a stranded prompt id (forget is idempotent).
            host.prompt_reports().forget(&prompt_id);
            Reply { id: id.clone(), ok: false, data: None, error: Some(e) }
        }
    }
}

// ───────────────────────────── apply / diff ──────────────────────────

fn first_line(s: &str) -> &str {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim()
}

fn handle_apply(id: &str, host: &dyn CliHost, task: &str, project: Option<&str>) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    // Explicit name only, like archive: this verb writes into the
    // user's main checkout.
    let t = match resolve_by_name(&projects, &tasks, task, project) {
        Ok(t) => t.clone(),
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    match host.apply_diff(&t.id) {
        Ok(r) => Reply::ok(
            id,
            ReplyData::Apply(proto::ApplyData {
                task_id: t.id,
                tracked_files: r.tracked_files as u64,
                untracked_files: r.untracked_files as u64,
            }),
        ),
        // The app's own three failure modes, each with its pinned
        // message + exit class (docs/plans/cli.md, Command surface).
        Err(crate::SendDiffError::MainCheckout) => Reply::err(
            id,
            ErrorCode::Unsupported,
            "this task IS the main checkout, there is nothing to apply",
        ),
        Err(crate::SendDiffError::DirtyMain) => Reply::err(
            id,
            ErrorCode::BadRequest,
            "the main checkout has uncommitted changes. Commit or stash there first, then rerun.",
        ),
        Err(crate::SendDiffError::Conflict { main, detail }) => Reply::err(
            id,
            ErrorCode::ApplyConflict,
            format!(
                "apply left the main checkout at {main} CONFLICTED; resolve or reset there ({})",
                first_line(&detail)
            ),
        ),
        Err(e) => Reply::err(id, ErrorCode::Internal, format!("apply failed ({})", e.message())),
    }
}

fn handle_diff(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    full: bool,
    cwd: Option<&str>,
) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(&projects, &tasks, task, project, cwd) {
        Ok(t) => t.clone(),
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    match host.diff_summary(&t.id) {
        Ok(s) => {
            // Reply lines cap at MAX_LINE_BYTES (1 MB) POST-JSON-escaping
            // (quotes/backslashes double, control bytes go 6x), so the
            // budgets measure ESCAPED bytes. A huge patch is truncated
            // with an explicit marker rather than turning the reply into
            // a connection error; the commit list gets a small budget of
            // its own since it rides the same line.
            const DIFF_BUDGET: usize = 850 * 1024;
            const COMMITS_BUDGET: usize = 32 * 1024;
            let (commits, commits_cut) = proto::json_budget_prefix(&s.commits, COMMITS_BUDGET);
            let mut commits = commits.to_string();
            if commits_cut {
                commits.push_str("\n[commit list truncated]");
            }
            let diff = full.then(|| {
                let (kept, cut) = proto::json_budget_prefix(&s.diff, DIFF_BUDGET);
                if cut {
                    format!(
                        "{kept}\n[diff truncated to fit the wire; open the task in Termic for the rest]"
                    )
                } else {
                    s.diff.clone()
                }
            });
            Reply::ok(
                id,
                ReplyData::Diff(proto::DiffData {
                    task_id: t.id,
                    files_changed: s.files_changed as u64,
                    insertions: s.insertions as u64,
                    deletions: s.deletions as u64,
                    untracked: s.untracked as u64,
                    commits,
                    diff,
                }),
            )
        }
        Err(e) => Reply::err(id, ErrorCode::Internal, format!("diff failed ({e})")),
    }
}

// ───────────────────────────── logs ──────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn handle_logs(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    shell: bool,
    tab: Option<&str>,
    last_bytes: Option<u64>,
    cwd: Option<&str>,
) -> Reply {
    if shell && tab.is_some() {
        return Reply::err(
            id,
            ErrorCode::BadRequest,
            "--shell targets the aux terminal, which is not a strip tab; drop one of the flags",
        );
    }
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(&projects, &tasks, task, project, cwd) {
        Ok(t) => t.clone(),
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    let kind = if shell { "aux" } else { "agent" };
    let pty = match tab {
        Some(sel) => {
            let rt = match resolve_tab_selector(host, &t, sel) {
                Ok(rt) => rt,
                Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
            };
            match host.find_tab_pty(&t.id, &rt.id) {
                Ok(p) => p,
                Err(e) => return Reply::err(id, ErrorCode::Unsupported, e),
            }
        }
        None => match host.find_role_pty(&t.id, kind) {
            Ok(p) => p,
            Err(e) => return Reply::err(id, ErrorCode::Unsupported, e),
        },
    };
    let max = last_bytes.map(|b| b as usize).unwrap_or(usize::MAX);
    match host.pty_logs(&pty, max) {
        Ok((bytes, truncated)) => {
            // Reply lines cap at MAX_LINE_BYTES (1 MB) POST-JSON-escaping
            // (an ANSI-heavy stream inflates up to 6x), so the tail is
            // bounded by ESCAPED size, keeping the newest output.
            const LOGS_BUDGET: usize = 850 * 1024;
            let text = String::from_utf8_lossy(&bytes);
            let (kept, cut) = proto::json_budget_suffix(&text, LOGS_BUDGET);
            Reply::ok(
                id,
                ReplyData::Logs(proto::LogsData {
                    task_id: t.id,
                    source: kind.into(),
                    data: kept.to_string(),
                    truncated: truncated || cut,
                }),
            )
        }
        Err(e) => Reply::err(id, ErrorCode::Internal, e),
    }
}

// ───────────────────────────── result ────────────────────────────────

/// Claude Code's transcript-directory name for a cwd: every character
/// that is not ASCII alphanumeric becomes '-'. Verified against the
/// live layout ("/Users/x/.config/dotfiles" -> "-Users-x--config-dotfiles").
fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The agent's last message out of a Claude Code JSONL transcript: the
/// last "assistant" line carrying non-empty text content (tool-use-only
/// turns are skipped).
fn last_assistant_text(jsonl: &str) -> Option<String> {
    for line in jsonl.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        // Sidechain lines are a subagent's internal conversation
        // interleaved in the same transcript; their last message is not
        // the agent's answer.
        if v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        let text = match content {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
        .map(|e| e.path())
}

fn handle_result(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(&projects, &tasks, task, project, cwd) {
        Ok(t) => t.clone(),
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    // Transcript layout is agent-specific; claude's JSONL is the one
    // reader shipped (docs/plans/cli.md: the RESULT.md file drop stays
    // the agent-agnostic floor).
    if t.cli != "claude" {
        return Reply::err(
            id,
            ErrorCode::Unsupported,
            format!(
                "result reads claude session transcripts and this task's agent is \"{}\". Use the file convention instead: prompt the agent to write RESULT.md, then read it from the task path.",
                t.cli
            ),
        );
    }
    let Some(home) = host.home_dir() else {
        return Reply::err(id, ErrorCode::Internal, "no home directory");
    };
    let dir = home.join(".claude").join("projects").join(claude_project_dir_name(&t.path));
    // A stored per-tab session id pins the transcript (repo-root tasks);
    // otherwise the newest .jsonl of the task's cwd is the session
    // `--continue` would resume (worktree tasks).
    let pinned = t
        .persisted_tabs
        .iter()
        .filter(|p| p.cli == "claude")
        .max_by_key(|p| p.is_default)
        .and_then(|p| p.session_id.clone())
        .map(|s| dir.join(format!("{s}.jsonl")))
        .filter(|f| f.is_file());
    // Main-checkout tasks SHARE their cwd with the user's own claude
    // sessions and any sibling main-checkout task; newest-in-dir would
    // happily serve someone else's conversation as this task's result.
    // Worktree cwds are exclusive to the task, so newest is safe there.
    if pinned.is_none() && t.is_main_checkout {
        return Reply::err(
            id,
            ErrorCode::Unsupported,
            "this task shares the project checkout, so its transcript cannot be identified. Use the file convention instead: prompt the agent to write RESULT.md, then read it from the task path.",
        );
    }
    let Some(file) = pinned.or_else(|| newest_jsonl(&dir)) else {
        return Reply::err(
            id,
            ErrorCode::NotFound,
            "no claude session transcript found for this task (has the agent replied yet?)",
        );
    };
    let jsonl = match std::fs::read_to_string(&file) {
        Ok(s) => s,
        Err(e) => {
            return Reply::err(
                id,
                ErrorCode::Internal,
                format!("could not read {} ({e})", file.display()),
            );
        }
    };
    let Some(text) = last_assistant_text(&jsonl) else {
        return Reply::err(
            id,
            ErrorCode::NotFound,
            "the session transcript has no agent message yet",
        );
    };
    Reply::ok(
        id,
        ReplyData::LastResult(proto::ResultData {
            task_id: t.id,
            agent: t.cli.clone(),
            transcript: file.display().to_string(),
            text,
        }),
    )
}

// ──────────────────────── tabs + registry (GH #138) ──────────────────

/// `termic agents` (GH #138). Goes through the webview rather than
/// `host.agents()` on purpose: installed-ness comes from a login-shell probe
/// per agent that the webview already caches, and the same cached view is what
/// `new_tab` validates against. Reading the registry from Rust here would give
/// a second answer to "is this agent usable?" that could disagree with the one
/// that actually gates tab creation.
fn handle_agents(req: &Request, host: &dyn CliHost) -> Reply {
    let id = &req.id;
    let value = match host.rpc("list_agents", serde_json::json!({}), OPEN_TIMEOUT) {
        Ok(v) => v,
        Err(e) => return Reply::err(id, ErrorCode::Internal, &e),
    };
    let agents: Vec<proto::AgentEntry> =
        match serde_json::from_value(value.get("agents").cloned().unwrap_or_default()) {
            Ok(a) => a,
            Err(e) => {
                return Reply::err(id, ErrorCode::Internal, format!("bad list_agents reply: {e}"))
            }
        };
    Reply::ok(id, ReplyData::Agents(proto::AgentsData { agents }))
}

/// `termic tab` (GH #138). Tab creation lives in the webview (the store owns
/// the tab list and TerminalPane spawns the PTY from it), so this resolves the
/// task here and hands the rest to `new_tab`, which owns registry validation:
/// the GUI hides an unusable agent, but a CLI caller needs to be told why.
///
/// `-p` (part 2) rides the SAME delivery route `send --tab` uses: a second
/// `send_prompt` RPC targeted at the id `new_tab` just returned. Not a
/// second injection recipe; the targeted path is injectPromptTracked with
/// the spawn-pending rule, i.e. exactly what `send` to a respawned agent
/// does, so delivery stays confirmed (docs/plans/cli.md, Phase 1).
fn handle_tab(req: &Request, host: &dyn CliHost, sink: &mut dyn EventSink) -> Reply {
    let Command::Tab { task, project, kind, prompt, wait, timeout_ms, cwd } = &req.cmd else {
        unreachable!("handle_tab called with a non-tab command")
    };
    let id = &req.id;
    if let Some(p) = prompt {
        if p.trim().is_empty() {
            return Reply::err(id, ErrorCode::BadRequest, "the prompt is empty");
        }
        // A prompt needs an agent on the other end. Shell and terminal
        // kinds provably are not; Default is checked below once the task
        // is known (its cli decides), and the webview still has the
        // final word for anything we cannot prove here.
        if matches!(kind, proto::TabKind::Shell | proto::TabKind::Terminal { .. }) {
            return Reply::err(
                id,
                ErrorCode::BadRequest,
                "a prompt cannot ride a shell or terminal tab; they are write-only from the CLI",
            );
        }
    }
    if *wait && prompt.is_none() {
        return Reply::err(id, ErrorCode::BadRequest, "--wait needs a prompt to wait on");
    }
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(
        &projects,
        &tasks,
        task.as_deref(),
        project.as_deref(),
        cwd.as_deref(),
    ) {
        Ok(t) => t.clone(),
        Err(e) => return Reply::err(id, e.code, &e.message),
    };
    if prompt.is_some() && matches!(kind, proto::TabKind::Default) {
        let non_agent = t.cli == "shell"
            || t.cli == "custom"
            || host.agents().iter().any(|a| a.id == t.cli && a.kind == "terminal");
        if non_agent {
            return Reply::err(
                id,
                ErrorCode::BadRequest,
                "this task's default tab is not an agent; a prompt cannot ride it (pass --agent)",
            );
        }
    }

    let (kind_str, agent_id) = match kind {
        proto::TabKind::Agent { id } => ("agent", Some(id.clone())),
        proto::TabKind::Terminal { id } => ("terminal", Some(id.clone())),
        proto::TabKind::Shell => ("shell", None),
        proto::TabKind::Default => ("default", None),
    };

    let value = match host.rpc(
        "new_tab",
        serde_json::json!({ "taskId": t.id, "kind": kind_str, "id": agent_id }),
        OPEN_TIMEOUT,
    ) {
        Ok(v) => v,
        // The webview owns the "which agents are usable" answer, so its
        // message is the useful one; pass it through rather than flattening
        // it into a generic failure.
        //
        // BadRequest is chosen for the DOMINANT case (a caller naming an
        // agent that is unknown, disabled, or not installed), which is a
        // genuine bad request. A transport failure here (timeout, dead
        // webview) is technically Internal and gets this code too. That is
        // deliberate, not an oversight: both map to exit_code::ERROR and the
        // message passes through either way, so the distinction is invisible
        // to callers, and Internal would mis-tag the common case.
        Err(e) => return Reply::err(id, ErrorCode::BadRequest, &e),
    };

    let tab_id = value.get("tabId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let cli = value.get("cli").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let title = value.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if tab_id.is_empty() {
        return Reply::err(id, ErrorCode::Internal, "new_tab returned no tab id");
    }

    let Some(prompt) = prompt else {
        return Reply::ok(
            id,
            ReplyData::Tab(proto::TabData { task_id: t.id, tab_id, cli, title, prompt: None }),
        );
    };

    // Register delivery interest BEFORE the webview learns the id (the
    // handle_new rule): a fast report can never race past us.
    let prompt_id = uuid::Uuid::new_v4().simple().to_string();
    host.prompt_reports().expect(&prompt_id);
    let params = serde_json::json!({
        "taskId": t.id,
        "prompt": prompt,
        "promptId": prompt_id,
        "wait": wait,
        "tabId": tab_id,
        // The tab was created a moment ago and TerminalPane may still be
        // spawning its PTY: a missing PTY means wait for the spawn, not
        // a dead-target refusal.
        "spawnPending": true,
    });
    let mut sink_dead = false;
    let value = {
        let mut on_progress = |p: RpcProgress| {
            if sink_dead {
                return;
            }
            if matches!(p, RpcProgress::Idle) {
                sink_dead = sink.emit(&StreamEvent::heartbeat(id)).is_err();
            }
        };
        host.rpc_stream("send_prompt", params, SEND_TIMEOUT, &mut on_progress)
    };
    let value = match value {
        Ok(v) => v,
        Err(e) => {
            host.prompt_reports().forget(&prompt_id);
            let (code, msg) = parse_send_error(&e);
            // The tab EXISTS at this point; a reply that only said
            // "send failed" would leave the caller re-running `tab` and
            // stacking empty tabs.
            return Reply::err(
                id,
                code,
                format!("the tab was opened ({tab_id}) but the prompt failed: {msg}"),
            );
        }
    };
    let mode = value
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or(proto::send_mode::SPAWNED)
        .to_string();
    let capable = value.get("capable").and_then(|c| c.as_bool()).unwrap_or(true);
    if mode == proto::send_mode::QUEUED {
        let _ = sink.emit(&StreamEvent::queued(id));
    }

    if !*wait {
        // Delivered mode confirmed inside the RPC; spawned stays
        // unconfirmed by design, exactly like `send` without --wait.
        host.prompt_reports().forget(&prompt_id);
        return Reply::ok(
            id,
            ReplyData::Tab(proto::TabData {
                task_id: t.id,
                tab_id,
                cli,
                title,
                prompt: Some(proto::PromptOutcome { mode, capable, wait: None }),
            }),
        );
    }
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let queued = mode == proto::send_mode::QUEUED;
    let watch = watch_agent(
        host,
        WatchOpts {
            req_id: id,
            task_id: &t.id,
            // Per-tab watch: the NEW tab's own state, so its done and
            // waiting are trustworthy (no sibling pollution).
            tab_id: Some(&tab_id),
            prompt_id: Some(&prompt_id),
            deadline,
            strict_target: false,
            queued,
            trust_done: true,
        },
        sink,
    );
    match watch {
        Ok(result) => Reply::ok(
            id,
            ReplyData::Tab(proto::TabData {
                task_id: t.id,
                tab_id,
                cli,
                title,
                prompt: Some(proto::PromptOutcome { mode, capable, wait: Some(result) }),
            }),
        ),
        Err(e) => {
            host.prompt_reports().forget(&prompt_id);
            Reply { id: id.clone(), ok: false, data: None, error: Some(e) }
        }
    }
}

// ───────────────────────────── archive ───────────────────────────────

fn handle_archive(id: &str, host: &dyn CliHost, task: &str, project: Option<&str>) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_by_name(&projects, &tasks, task, project) {
        Ok(t) => t.clone(),
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    let project_name = projects
        .iter()
        .find(|p| p.id == t.project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| t.project_id.clone());
    // Kill the task's live PTYs FIRST: removing a worktree under a live
    // agent is undefined (docs/plans/cli.md; the GUI's archive copy
    // already promises termination, the CLI actually delivers it).
    // Attached clients get the in-band reason before the SIGKILL turns
    // their stream into a bare disconnect.
    host.notify_detach(&t.id, "archived");
    let killed = host.kill_task_ptys(&t.id);
    if let Err(e) = host.rpc(
        "archive_task",
        serde_json::json!({ "taskId": t.id }),
        ARCHIVE_TIMEOUT,
    ) {
        return Reply::err(id, ErrorCode::Internal, format!("archive failed ({e})"));
    }
    Reply::ok(
        id,
        ReplyData::Archive(proto::ArchiveData {
            task_id: t.id,
            name: t.name,
            project: project_name,
            killed_agents: killed,
        }),
    )
}

// ───────────────────────────── projects ──────────────────────────────

fn project_info(p: &Project, tasks: &[Task]) -> proto::ProjectInfo {
    proto::ProjectInfo {
        id: p.id.clone(),
        name: p.name.clone(),
        root_path: p.root_path.clone(),
        tasks: tasks.iter().filter(|t| !t.archived && t.project_id == p.id).count() as u32,
        default_agent: p.default_cli.clone(),
    }
}

fn handle_project_list(id: &str, host: &dyn CliHost) -> Reply {
    let (mut projects, tasks) = host.projects_tasks();
    projects.sort_by(|a, b| a.name.cmp(&b.name));
    let projects = projects.iter().map(|p| project_info(p, &tasks)).collect();
    Reply::ok(id, ReplyData::ProjectList(proto::ProjectListData { projects }))
}

fn handle_project_add(id: &str, host: &dyn CliHost, path: &str, non_git: bool) -> Reply {
    let value = match host.rpc(
        "project_add",
        serde_json::json!({ "path": path, "nonGit": non_git }),
        PROJECT_RPC_TIMEOUT,
    ) {
        Ok(v) => v,
        // Idempotency is part of the help contract ("0 registered, or
        // already registered"): agents defensively add before creating,
        // and a healthy re-add must not read as failure. The substring
        // is marked load-bearing at its lib.rs origin.
        Err(e) if e.contains("project already added") => {
            let (projects, tasks) = host.projects_tasks();
            let canon_path = canon(path);
            if let Some(p) = projects.iter().find(|p| canon(&p.root_path) == canon_path) {
                return Reply::ok(
                    id,
                    ReplyData::ProjectAdd(proto::ProjectAddData {
                        project: project_info(p, &tasks),
                    }),
                );
            }
            return Reply::err(id, ErrorCode::Internal, format!("could not add the project ({e})"));
        }
        // The backend's non-git message describes the GUI confirmation
        // dialog; the CLI's version of that confirmation is a flag.
        Err(e) if !non_git && e.contains("not a git repo") => {
            return Reply::err(
                id,
                ErrorCode::BadRequest,
                format!("{path} is not a git repository. Pass --non-git to register it as a plain folder."),
            );
        }
        Err(e) => return Reply::err(id, ErrorCode::Internal, format!("could not add the project ({e})")),
    };
    let project_id = value.get("projectId").and_then(|v| v.as_str()).unwrap_or_default();
    let (projects, tasks) = host.projects_tasks();
    let Some(p) = projects.iter().find(|p| p.id == project_id) else {
        return Reply::err(id, ErrorCode::Internal, "the project was added but could not be read back");
    };
    Reply::ok(
        id,
        ReplyData::ProjectAdd(proto::ProjectAddData { project: project_info(p, &tasks) }),
    )
}

fn handle_project_remove(id: &str, host: &dyn CliHost, name: &str) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let Some(p) = find_project(&projects, name) else {
        return Reply::err(id, ErrorCode::NotFound, format!("no project named \"{name}\""));
    };
    let removed_tasks =
        tasks.iter().filter(|t| !t.archived && t.project_id == p.id).count() as u32;
    // Every live agent in the project dies with it; same rule as
    // archive (never remove a worktree under a live PTY).
    for t in tasks.iter().filter(|t| !t.archived && t.project_id == p.id) {
        host.notify_detach(&t.id, "archived");
        host.kill_task_ptys(&t.id);
    }
    if let Err(e) = host.rpc(
        "project_remove",
        serde_json::json!({ "projectId": p.id }),
        ARCHIVE_TIMEOUT,
    ) {
        return Reply::err(id, ErrorCode::Internal, format!("could not remove the project ({e})"));
    }
    Reply::ok(
        id,
        ReplyData::ProjectRemove(proto::ProjectRemoveData {
            name: p.name.clone(),
            removed_tasks,
        }),
    )
}

fn summarize(
    task: &Task,
    projects: &[Project],
    states: Option<&HashMap<String, WorkStateInfo>>,
    diff: Option<proto::DiffStat>,
) -> proto::TaskSummary {
    let project = projects
        .iter()
        .find(|p| p.id == task.project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| task.project_id.clone());
    let info = states.and_then(|m| m.get(&task.id));
    proto::TaskSummary {
        id: task.id.clone(),
        name: task.name.clone(),
        project,
        agent: task.cli.clone(),
        branch: task.branch.clone(),
        base_branch: task.base_branch.clone(),
        path: task.path.clone(),
        is_main_checkout: task.is_main_checkout,
        created: task.created.clone(),
        work_state: info.map(|i| i.state.clone()),
        open_tabs: info.map(|i| i.tabs),
        diff,
    }
}

fn sandbox_mode_str(task: &Task) -> String {
    serde_json::to_value(task.effective_sandbox_mode())
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "off".into())
}

// ───────────────────────────── resolution ────────────────────────────

fn find_project<'a>(projects: &'a [Project], name: &str) -> Option<&'a Project> {
    projects
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(name))
        .or_else(|| projects.iter().find(|p| p.id == name))
}

fn qualified(projects: &[Project], task: &Task) -> String {
    let p = projects
        .iter()
        .find(|p| p.id == task.project_id)
        .map(|p| p.name.as_str())
        .unwrap_or("?");
    format!("{p}/{}", task.name)
}

/// Resolve a task from an optional name, falling back to the caller's
/// cwd (worktree first, then main-checkout prefix), the same rule
/// `open` uses. Verbs that read or wait go through this; destructive
/// verbs (archive) deliberately require the explicit name.
pub(crate) fn resolve_task_arg<'a>(
    projects: &[Project],
    tasks: &'a [Task],
    task: Option<&str>,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Result<&'a Task, proto::ErrorBody> {
    if let Some(name) = task {
        return resolve_by_name(projects, tasks, name, project);
    }
    // clap guards this in the shipped CLI (requires = "task"); the wire
    // guard keeps a hand-rolled client from silently having its
    // --project ignored on the cwd path.
    if project.is_some() {
        return Err(proto::ErrorBody {
            code: ErrorCode::BadRequest,
            message: "--project requires a task name".into(),
            data: None,
        });
    }
    let not_here = || proto::ErrorBody {
        code: ErrorCode::NotFound,
        message: "not inside a task worktree or project checkout; name the task".into(),
        data: None,
    };
    match cwd {
        Some(cwd) => resolve_by_cwd(projects, tasks, cwd)?.ok_or_else(not_here),
        None => Err(not_here()),
    }
}

/// Resolve a task by name, id, or qualified `project/name`; `--project`
/// filters first. A name matching tasks in more than one project errors
/// listing the candidates (docs/plans/cli.md).
pub(crate) fn resolve_by_name<'a>(
    projects: &[Project],
    tasks: &'a [Task],
    raw: &str,
    project: Option<&str>,
) -> Result<&'a Task, proto::ErrorBody> {
    let not_found = |what: &str| proto::ErrorBody {
        code: ErrorCode::NotFound,
        message: what.to_string(),
        data: None,
    };
    let live: Vec<&Task> = tasks.iter().filter(|t| !t.archived).collect();

    let scoped: Vec<&Task> = match project {
        Some(pname) => {
            let Some(p) = find_project(projects, pname) else {
                return Err(not_found(&format!("no project named \"{pname}\"")));
            };
            live.iter().copied().filter(|t| t.project_id == p.id).collect()
        }
        None => live.clone(),
    };

    let matches = |candidates: &[&'a Task], name: &str| -> Vec<&'a Task> {
        candidates
            .iter()
            .copied()
            .filter(|t| t.name.eq_ignore_ascii_case(name) || t.id == name)
            .collect()
    };

    let mut found = matches(&scoped, raw);
    // Qualified project/name, tried after the literal name so a task
    // whose NAME contains a slash still resolves.
    if found.is_empty() && project.is_none() {
        if let Some((pname, tname)) = raw.split_once('/') {
            if let Some(p) = find_project(projects, pname) {
                let in_project: Vec<&Task> =
                    live.iter().copied().filter(|t| t.project_id == p.id).collect();
                found = matches(&in_project, tname);
            }
        }
    }
    match found.len() {
        0 => Err(not_found(&match project {
            Some(p) => format!("no task named \"{raw}\" in project \"{p}\""),
            None => format!("no task named \"{raw}\""),
        })),
        1 => Ok(found[0]),
        _ => {
            let mut names: Vec<String> = found.iter().map(|t| qualified(projects, t)).collect();
            names.sort();
            Err(proto::ErrorBody {
                code: ErrorCode::Ambiguous,
                message: format!(
                    "task \"{raw}\" exists in more than one project: {}. Disambiguate with --project or project/name.",
                    names.join(", ")
                ),
                data: None,
            })
        }
    }
}

fn canon(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
}

fn under(path: &str, base: &str) -> bool {
    !base.is_empty()
        && (path == base
            || (path.len() > base.len()
                && path.starts_with(base)
                && path.as_bytes()[base.len()] == b'/'))
}

/// cwd resolution, worktree first then longest project-path prefix
/// (docs/plans/cli.md, Traps): a path can be inside a project repo AND a
/// task worktree of another project. Main-checkout tasks live at the
/// project root, so the project-prefix stage IS the main-checkout stage;
/// several of them can share one checkout, which is the ambiguous case.
pub(crate) fn resolve_by_cwd<'a>(
    projects: &[Project],
    tasks: &'a [Task],
    cwd: &str,
) -> Result<Option<&'a Task>, proto::ErrorBody> {
    let cwd = canon(cwd);
    let live: Vec<&Task> = tasks.iter().filter(|t| !t.archived).collect();

    let best_by = |candidates: &[(&'a Task, String)]| -> (usize, Vec<&'a Task>) {
        let mut best_len = 0usize;
        let mut best: Vec<&'a Task> = Vec::new();
        for (t, base) in candidates {
            if under(&cwd, base) && base.len() >= best_len {
                if base.len() > best_len {
                    best.clear();
                    best_len = base.len();
                }
                if !best.iter().any(|b| b.id == t.id) {
                    best.push(t);
                }
            }
        }
        (best_len, best)
    };

    // Stage 1: worktree tasks (their own dir + composition member dirs).
    let worktree_paths: Vec<(&Task, String)> = live
        .iter()
        .copied()
        .filter(|t| !t.is_main_checkout)
        .flat_map(|t| {
            std::iter::once((t, canon(&t.path))).chain(
                t.composition
                    .iter()
                    .filter(|m| !m.path.is_empty())
                    .map(move |m| (t, canon(&m.path))),
            )
        })
        .collect();
    let (_, found) = best_by(&worktree_paths);
    match found.len() {
        1 => return Ok(Some(found[0])),
        n if n > 1 => {
            let mut names: Vec<String> = found.iter().map(|t| qualified(projects, t)).collect();
            names.sort();
            return Err(proto::ErrorBody {
                code: ErrorCode::Ambiguous,
                message: format!(
                    "this directory belongs to more than one task: {}. Name the task explicitly.",
                    names.join(", ")
                ),
                data: None,
            });
        }
        _ => {}
    }

    // Stage 2: main-checkout tasks by project-path prefix.
    let main_paths: Vec<(&Task, String)> = live
        .iter()
        .copied()
        .filter(|t| t.is_main_checkout)
        .map(|t| (t, canon(&t.path)))
        .collect();
    let (_, found) = best_by(&main_paths);
    match found.len() {
        0 => Ok(None),
        1 => Ok(Some(found[0])),
        _ => {
            let mut names: Vec<String> = found.iter().map(|t| qualified(projects, t)).collect();
            names.sort();
            Err(proto::ErrorBody {
                code: ErrorCode::Ambiguous,
                message: format!(
                    "this checkout is shared by more than one task: {}. Name the task explicitly.",
                    names.join(", ")
                ),
                data: None,
            })
        }
    }
}

// ───────────────────────────── token ─────────────────────────────────

/// 244 random bits as 64 hex chars (two v4 uuids; the spec floor is
/// 128). Exists only here and in the 0600 file the CLI reads.
fn mint_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    // Recreate rather than truncate so the 0600 mode is guaranteed even
    // if an old file existed with different permissions.
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(token.as_bytes())?;
    f.flush()
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: valid fd from a live UnixStream; out-params are plain ints.
        if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } == 0 {
            Some(uid)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: valid fd; SO_PEERCRED fills a ucred of exactly this size.
        let ok = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut _ as *mut libc::c_void,
                &mut len,
            )
        } == 0;
        if ok { Some(cred.uid) } else { None }
    }
}

// ───────────────────────────── Tauri host ────────────────────────────

struct TauriHost {
    app: tauri::AppHandle,
    token: String,
}

impl CliHost for TauriHost {
    fn cli_enabled(&self) -> bool {
        // Re-read per request so the Settings toggle applies live.
        crate::load_settings_inner().cli_enabled
    }
    fn token(&self) -> &str {
        &self.token
    }
    fn app_version(&self) -> String {
        env!("CARGO_PKG_VERSION").into()
    }
    fn projects_tasks(&self) -> (Vec<Project>, Vec<Task>) {
        (crate::load_projects(), crate::load_tasks())
    }
    fn work_states(&self, ids: &[String]) -> Option<HashMap<String, WorkStateInfo>> {
        cached_work_states(&global_agent_cache().snapshot(), ids)
    }
    fn open_task_in_ui(&self, task_id: &str) -> Result<(), String> {
        webview_rpc(
            &self.app,
            "open_task",
            serde_json::json!({ "taskId": task_id }),
            OPEN_TIMEOUT,
        )
        .map(|_| ())
    }
    fn raise_window(&self) {
        // Routes through leave_windowless (which unminimizes) so a `--headless` instance also
        // regains its dock icon and drops the menu-bar item, instead of
        // showing a window while still pretending to be an accessory.
        crate::leave_windowless(&self.app);
    }
    fn diff_stat(&self, task: &Task) -> Option<proto::DiffStat> {
        diff_stat(task)
    }
    fn agents(&self) -> Vec<AgentMeta> {
        crate::load_settings_inner()
            .agents
            .iter()
            .map(|a| AgentMeta {
                id: a.id.clone(),
                kind: a.kind.clone(),
                work_done: a.work_done,
                disabled: a.disabled,
            })
            .collect()
    }
    fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        webview_rpc(&self.app, method, params, timeout)
    }
    fn rpc_stream(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
        on_progress: &mut dyn FnMut(RpcProgress),
    ) -> Result<serde_json::Value, String> {
        webview_rpc_stream(&self.app, method, params, timeout, on_progress)
    }
    fn live_agent_counts(&self) -> (u32, u32) {
        let manager = self.app.state::<crate::PtyManager>();
        crate::live_agent_pty_counts(&manager)
    }
    fn quit_app(&self) {
        // Called by serve_conn AFTER the reply is written, so this can exit
        // immediately. app.exit drives RunEvent::Exit -> cleanup_children,
        // which reaps PTYs, script process groups, greps and spotlight
        // sessions - the same teardown Cmd-Q performs.
        self.app.exit(0);
    }
    fn agent_cache(&self) -> &AgentCache {
        global_agent_cache()
    }
    fn prompt_reports(&self) -> &PromptReports {
        global_prompt_reports()
    }
    fn kill_task_ptys(&self, task_id: &str) -> u32 {
        // Archive paths kill the aux shell too (role-tagged, no
        // task_id): a live shell inside a removed worktree is the same
        // undefined state the agent kill prevents, and its attach
        // clients were just told "archived".
        let manager = self.app.state::<crate::PtyManager>();
        (crate::kill_task_ptys(&manager, task_id) + crate::kill_task_role_ptys(&manager, task_id))
            as u32
    }
    fn git_toplevel(&self, cwd: &str) -> Option<String> {
        let out = crate::git(&["rev-parse", "--show-toplevel"], Path::new(cwd)).ok()?;
        let root = out.trim();
        (!root.is_empty()).then(|| root.to_string())
    }
    fn apply_diff(&self, task_id: &str) -> Result<crate::SendDiffResult, crate::SendDiffError> {
        crate::task_send_diff_to_main_inner(task_id)
    }
    fn diff_summary(&self, task_id: &str) -> Result<crate::TaskDiffSummary, String> {
        crate::task_diff_inner(task_id.to_string())
    }
    fn find_role_pty(&self, task_id: &str, kind: &str) -> Result<String, String> {
        crate::find_role_pty(&self.app.state::<crate::PtyManager>(), task_id, kind)
    }
    fn find_tab_pty(&self, task_id: &str, tab_id: &str) -> Result<String, String> {
        crate::find_tab_pty(&self.app.state::<crate::PtyManager>(), task_id, tab_id)
    }
    fn pty_logs(&self, pty_id: &str, max: usize) -> Result<(Vec<u8>, bool), String> {
        crate::pty_logs_tail(&self.app.state::<crate::PtyManager>(), pty_id, max)
    }
    fn pty_subscribe(&self, pty_id: &str) -> Result<crate::PtyAttachment, String> {
        crate::pty_subscribe(&self.app.state::<crate::PtyManager>(), pty_id)
    }
    fn pty_input(&self, pty_id: &str, data: &[u8]) -> Result<(), String> {
        crate::pty_write_inner(&self.app.state::<crate::PtyManager>(), pty_id, data)
    }
    fn pty_set_size(&self, pty_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        crate::pty_resize_inner(&self.app.state::<crate::PtyManager>(), pty_id, rows, cols)
    }
    fn notify_detach(&self, task_id: &str, reason: &str) {
        crate::notify_task_detach(&self.app.state::<crate::PtyManager>(), task_id, reason);
    }
    fn home_dir(&self) -> Option<PathBuf> {
        dirs::home_dir()
    }
}

/// Cheap diff stat vs the base branch: one `git diff --numstat` plus one
/// untracked-file listing. Deliberately NOT `task_diff_inner`, which
/// renders a full unified diff and shells out per untracked file; `list`
/// runs this for every task.
fn diff_stat(task: &Task) -> Option<proto::DiffStat> {
    if task.base_branch.is_empty() {
        return None;
    }
    let wt = Path::new(&task.path);
    let numstat =
        crate::git(&["--no-pager", "diff", "--numstat", &task.base_branch], wt).ok()?;
    let mut files_changed = 0u64;
    let mut insertions = 0u64;
    let mut deletions = 0u64;
    for line in numstat.lines().filter(|l| !l.trim().is_empty()) {
        let mut cols = line.split('\t');
        insertions += cols.next().and_then(|c| c.parse::<u64>().ok()).unwrap_or(0);
        deletions += cols.next().and_then(|c| c.parse::<u64>().ok()).unwrap_or(0);
        files_changed += 1;
    }
    let untracked = crate::git(&["ls-files", "--others", "--exclude-standard", "-z"], wt)
        .map(|s| s.split('\0').filter(|x| !x.is_empty()).count() as u64)
        .unwrap_or(0);
    Some(proto::DiffStat { files_changed, insertions, deletions, untracked })
}

// ───────────────────────── agent state cache ─────────────────────────

/// One task's aggregated agent state, as pushed by the webview
/// (src/lib/cliAgentState.ts). The webview is the only writer; the
/// socket threads read it for `list`/`status` and block on it for
/// `wait` (docs/plans/cli.md, Phase 1: the flips live in Rust, so the
/// verbs work even while the webview is busy).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TaskAgentState {
    /// "working" | "waiting" | "done" | "idle" | "inactive".
    pub state: String,
    /// Live terminal tabs for the task.
    #[serde(default)]
    pub tabs: u32,
    /// Messages still queued to the task's agents (the ralph loop).
    /// Quiescence requires 0: settle alone races `send`'s queueing.
    #[serde(default)]
    pub queued: u32,
    /// Any tab has work-done detection (agent capability, not opted
    /// out). Without it there is no settle signal to wait on.
    #[serde(default)]
    pub capable: bool,
    /// The strip's terminal tabs in display order (GH #138 part 2): what
    /// `--tab` selectors resolve against and `status` lists. Default so
    /// a not-yet-updated frontend degrades to "no per-tab data" rather
    /// than a parse failure.
    #[serde(default)]
    pub tab_states: Vec<TabAgentState>,
}

/// One strip tab, as pushed by the webview (cliAgentState.ts
/// computeTabState). 1-based position in the Vec IS the `--tab <n>`
/// index.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TabAgentState {
    /// Stable store id: the identity selectors resolve to, and the id
    /// carried on the matching `PtyRole.tab_id`.
    pub id: String,
    /// "agent" | "shell" | "terminal" | "run". Only agent tabs are
    /// addressable by send/wait/attach/logs.
    #[serde(default)]
    pub kind: String,
    /// cli id ("claude", "shell", a custom terminal's id).
    #[serde(default)]
    pub cli: String,
    /// Display title as the GUI renders it (agent-authored, mutable).
    #[serde(default)]
    pub title: String,
    /// Per-tab work state; None where no settle signal exists (shell,
    /// custom terminal, work-done-incapable agents).
    #[serde(default)]
    pub state: Option<String>,
    /// Prompts queued behind this tab's current turn.
    #[serde(default)]
    pub queued: u32,
    /// Work-done detection exists for this tab's cli.
    #[serde(default)]
    pub capable: bool,
    /// A PTY is live in this tab right now.
    #[serde(default)]
    pub live: bool,
    /// The tab verbs resolve to when `--tab` is absent.
    #[serde(default)]
    pub is_default: bool,
}

struct AgentCacheInner {
    states: HashMap<String, TaskAgentState>,
    /// Bumped on every push; waiters detect change by seq, never by
    /// polling field diffs.
    seq: u64,
    /// When the last push arrived. None = the webview never pushed
    /// (still booting, or an old frontend).
    last_push: Option<Instant>,
}

pub(crate) struct AgentCache {
    inner: Mutex<AgentCacheInner>,
    cv: Condvar,
}

/// A read of the cache at one instant.
#[derive(Debug, Clone)]
pub(crate) struct AgentSnapshot {
    pub states: HashMap<String, TaskAgentState>,
    /// Age of the newest push; None = never pushed.
    pub age: Option<Duration>,
}

impl AgentCache {
    pub(crate) fn new() -> Self {
        AgentCache {
            inner: Mutex::new(AgentCacheInner { states: HashMap::new(), seq: 0, last_push: None }),
            cv: Condvar::new(),
        }
    }

    pub(crate) fn update(&self, states: HashMap<String, TaskAgentState>) {
        let mut inner = self.inner.lock().unwrap();
        inner.states = states;
        inner.seq += 1;
        inner.last_push = Some(Instant::now());
        drop(inner);
        self.cv.notify_all();
    }

    pub(crate) fn snapshot(&self) -> AgentSnapshot {
        let inner = self.inner.lock().unwrap();
        AgentSnapshot {
            states: inner.states.clone(),
            age: inner.last_push.map(|t| t.elapsed()),
        }
    }

    /// Block until a push newer than `last_seq` lands or `timeout`
    /// passes. Returns the current seq either way.
    pub(crate) fn wait_change(&self, last_seq: u64, timeout: Duration) -> u64 {
        let deadline = Instant::now() + timeout;
        let mut inner = self.inner.lock().unwrap();
        while inner.seq <= last_seq {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (next, timed_out) = self
                .cv
                .wait_timeout(inner, deadline - now)
                .unwrap_or_else(|p| p.into_inner());
            inner = next;
            if timed_out.timed_out() {
                break;
            }
        }
        inner.seq
    }
}

fn global_agent_cache() -> &'static AgentCache {
    static CACHE: OnceLock<AgentCache> = OnceLock::new();
    CACHE.get_or_init(AgentCache::new)
}

/// Webview push target: the FULL per-task state map (idempotent
/// snapshot, not a delta - deltas would desync on a webview reload).
#[tauri::command]
pub fn cli_agent_states(states: HashMap<String, TaskAgentState>) {
    global_agent_cache().update(states);
}

/// list/status rows from a cache snapshot. Phase 1 reads the
/// webview-pushed cache instead of a webview round-trip (works while
/// the UI is busy; one less moving part). A cache past the staleness
/// cutoff degrades to "unknown" like Phase 0's webview timeout did:
/// frozen rows presented as live would be worse than no answer.
pub(crate) fn cached_work_states(
    snap: &AgentSnapshot,
    ids: &[String],
) -> Option<HashMap<String, WorkStateInfo>> {
    snap.age.filter(|a| *a <= CACHE_STALE_AFTER)?;
    let mut out = HashMap::new();
    for id in ids {
        if let Some(s) = snap.states.get(id) {
            out.insert(id.clone(), WorkStateInfo { state: s.state.clone(), tabs: s.tabs });
        }
    }
    Some(out)
}

/// `status`'s tab rows from a cache snapshot (GH #138 part 2). `None`
/// degrades exactly like `cached_work_states`: a stale or absent
/// snapshot is UNKNOWN, never an empty strip.
pub(crate) fn cached_tab_states(
    snap: &AgentSnapshot,
    task_id: &str,
) -> Option<Vec<proto::TabStatus>> {
    snap.age.filter(|a| *a <= CACHE_STALE_AFTER)?;
    let entry = snap.states.get(task_id)?;
    Some(
        entry
            .tab_states
            .iter()
            .enumerate()
            .map(|(i, t)| proto::TabStatus {
                id: t.id.clone(),
                index: i as u32 + 1,
                kind: t.kind.clone(),
                agent: t.cli.clone(),
                title: t.title.clone(),
                state: t.state.clone(),
                is_default: t.is_default,
                live: t.live,
                queued: t.queued,
            })
            .collect(),
    )
}

// ───────────────────── tab selectors (GH #138 part 2) ────────────────

/// A `--tab` selector, resolved to a strip tab's stable id (what
/// `PtyRole.tab_id` carries).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedTab {
    pub id: String,
}

/// Resolve `--tab <n|id|title>` against the task's strip, from the
/// webview's per-tab snapshot. Precedence is settled by the plan
/// (docs/plans/cli.md, GH #138): the tab id IS the identity, so an
/// exact id match wins; a 1-based index and a case-insensitive
/// title/cli match are human conveniences resolving to it. Ambiguity
/// is an error listing the candidates, never a guess. Only AGENT tabs
/// resolve: everything a selector feeds (send/wait/attach/logs) can
/// only reach a tab with a PtyRole and a settle signal; shell and
/// terminal tabs are write-only from the CLI by design.
fn resolve_tab_selector(
    host: &dyn CliHost,
    task: &Task,
    selector: &str,
) -> Result<ResolvedTab, proto::ErrorBody> {
    let err = |code: ErrorCode, message: String| proto::ErrorBody { code, message, data: None };
    let gate = |index: u32, t: &TabAgentState| -> Result<ResolvedTab, proto::ErrorBody> {
        if t.kind != "agent" {
            return Err(err(
                ErrorCode::Unsupported,
                format!(
                    "tab [{index}] {} is a {} tab; only agent tabs are reachable, the rest are write-only from the CLI (see `termic tab --help`)",
                    t.title, t.kind
                ),
            ));
        }
        Ok(ResolvedTab { id: t.id.clone() })
    };

    let snap = host.agent_cache().snapshot();
    let fresh = snap.age.is_some_and(|a| a <= CACHE_STALE_AFTER);
    let tabs = snap
        .states
        .get(&task.id)
        .filter(|_| fresh)
        .map(|e| e.tab_states.clone())
        .filter(|t| !t.is_empty());

    let Some(tabs) = tabs else {
        // Degraded: no per-tab snapshot yet (app just started, or the
        // task never reported). An EXACT id can still resolve against
        // the persisted strip set, so a script that recorded the id
        // `termic tab` printed keeps working; index and title need the
        // live list and honestly cannot.
        if let Some(pt) = task
            .persisted_tabs
            .iter()
            .filter(|p| p.pane_leaf_id.is_none())
            .find(|p| p.id == selector)
        {
            let terminal_kind = pt.cli == "custom"
                || pt.cli == "shell"
                || pt.run_member.is_some()
                || host.agents().iter().any(|a| a.id == pt.cli && a.kind == "terminal");
            if terminal_kind {
                return Err(err(
                    ErrorCode::Unsupported,
                    "that tab is not an agent tab; only agent tabs are reachable, the rest are write-only from the CLI".into(),
                ));
            }
            return Ok(ResolvedTab { id: pt.id.clone() });
        }
        return Err(err(
            ErrorCode::Internal,
            "the Termic UI has not reported this task's tabs yet; rerun in a moment, or pass the tab id".into(),
        ));
    };

    // 1. The identity itself.
    if let Some((i, t)) = tabs.iter().enumerate().find(|(_, t)| t.id == selector) {
        return gate(i as u32 + 1, t);
    }
    // 2. A 1-based strip index (`status` prints the same numbering).
    if let Ok(n) = selector.parse::<usize>() {
        if n == 0 || n > tabs.len() {
            return Err(err(
                ErrorCode::NotFound,
                format!(
                    "tab {n} does not exist; the task has {} tab{} (see `termic status`)",
                    tabs.len(),
                    if tabs.len() == 1 { "" } else { "s" }
                ),
            ));
        }
        return gate(n as u32, &tabs[n - 1]);
    }
    // 3. Title or cli id, case-insensitive. Titles are agent-authored
    // and drift mid-turn, so they are a convenience, not the identity.
    let sel = selector.to_lowercase();
    let matches: Vec<(usize, &TabAgentState)> = tabs
        .iter()
        .enumerate()
        .filter(|(_, t)| t.title.to_lowercase() == sel || t.cli.to_lowercase() == sel)
        .collect();
    match matches.as_slice() {
        [] => Err(err(
            ErrorCode::NotFound,
            format!(
                "no tab matches \"{selector}\"; the task's tabs: {} (see `termic status`)",
                tabs.iter()
                    .enumerate()
                    .map(|(i, t)| format!("[{}] {}", i + 1, t.title))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
        [(i, t)] => gate(*i as u32 + 1, t),
        many => Err(err(
            ErrorCode::Ambiguous,
            format!(
                "\"{selector}\" matches more than one tab: {}; use the index or the tab id",
                many.iter()
                    .map(|(i, t)| format!("[{}] {} (id {})", i + 1, t.title, t.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

// ───────────────────────── prompt delivery reports ───────────────────

/// Delivery confirmations for CLI-injected prompts. The webview's
/// injection path reports delivered/failed per prompt id; `new --wait`
/// blocks on the report because the injection recipe itself can die
/// silently (a webview reload during the settle window drops the timer
/// chain while the Rust-owned PTY survives idle - exit 0 must mean
/// CONFIRMED delivery, docs/plans/cli.md Phase 1).
pub(crate) struct PromptReports {
    inner: Mutex<PromptReportsInner>,
}

#[derive(Default)]
struct PromptReportsInner {
    /// Ids a server thread is (or will be) waiting on. Reports for
    /// unknown ids are dropped, so a late or forged report can never
    /// accumulate state. Waiters poll `try_take` on their existing
    /// watch cadence, so no condvar is needed here.
    expected: HashSet<String>,
    results: HashMap<String, Result<(), String>>,
}

impl PromptReports {
    pub(crate) fn new() -> Self {
        PromptReports { inner: Mutex::new(PromptReportsInner::default()) }
    }

    /// Register interest BEFORE the webview learns the id, so a fast
    /// report can never race past the waiter.
    pub(crate) fn expect(&self, id: &str) {
        self.inner.lock().unwrap().expected.insert(id.to_string());
    }

    /// Drop interest without waiting (error paths, waiter give-up).
    pub(crate) fn forget(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.expected.remove(id);
        inner.results.remove(id);
    }

    pub(crate) fn resolve(&self, id: &str, result: Result<(), String>) {
        let mut inner = self.inner.lock().unwrap();
        if !inner.expected.contains(id) {
            return;
        }
        inner.results.insert(id.to_string(), result);
    }

    /// Non-blocking probe; unregisters the id when a report is taken.
    fn try_take(&self, id: &str) -> Option<Result<(), String>> {
        let mut inner = self.inner.lock().unwrap();
        let r = inner.results.remove(id);
        if r.is_some() {
            inner.expected.remove(id);
        }
        r
    }
}

fn global_prompt_reports() -> &'static PromptReports {
    static REPORTS: OnceLock<PromptReports> = OnceLock::new();
    REPORTS.get_or_init(PromptReports::new)
}

/// Webview callback: delivery outcome for one injected prompt.
#[tauri::command]
pub fn cli_prompt_report(id: String, ok: bool, error: Option<String>) {
    let result = if ok {
        Ok(())
    } else {
        Err(error.unwrap_or_else(|| "prompt injection failed".into()))
    };
    global_prompt_reports().resolve(&id, result);
}

// ───────────────────────────── webview RPC ───────────────────────────

/// One-way readiness latch: set when the webview's RPC listener has
/// registered (`cli_rpc_ready`). Tauri events are NOT queued for future
/// listeners, so an RPC emitted during app cold-launch (socket binds in
/// setup(), React mounts seconds later) would vanish and the request
/// would burn its whole timeout. Every RPC waits on this first.
pub(crate) struct ReadyLatch {
    inner: Mutex<bool>,
    cv: Condvar,
}

impl ReadyLatch {
    pub(crate) fn new() -> Self {
        ReadyLatch { inner: Mutex::new(false), cv: Condvar::new() }
    }
    pub(crate) fn set(&self) {
        *self.inner.lock().unwrap() = true;
        self.cv.notify_all();
    }
    /// True once set; false if `timeout` passes first.
    pub(crate) fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut ready = self.inner.lock().unwrap();
        while !*ready {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            ready = self
                .cv
                .wait_timeout(ready, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        true
    }
}

fn webview_ready() -> &'static ReadyLatch {
    static READY: OnceLock<ReadyLatch> = OnceLock::new();
    READY.get_or_init(ReadyLatch::new)
}

/// How long an RPC waits for the webview listener before emitting
/// anyway (30s in production: cold app launch + React mount; the
/// emit-anyway fallback preserves the old timeout behavior if the
/// ready signal ever goes missing).
const WEBVIEW_READY_TIMEOUT: Duration =
    Duration::from_millis(if cfg!(test) { 50 } else { 30_000 });

/// Invoked by src/lib/cliRpc.ts once its `cli-rpc://request` listener
/// is registered. Idempotent; a webview reload re-invokes it.
#[tauri::command]
pub fn cli_rpc_ready() {
    webview_ready().set();
}

enum RpcMsg {
    /// Intermediate progress from a streaming handler (raw value JSON).
    Progress(String),
    /// The handler's final `{ok, value|error}` envelope.
    Result(String),
}

/// Pending RPCs: correlation id -> channel the socket thread blocks on.
/// Unbounded senders: `cli_rpc_result` / `cli_rpc_progress` run on the
/// IPC thread and must NEVER block (docs/ipc.md).
fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<RpcMsg>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<RpcMsg>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Progress signal for a streaming RPC: either a payload from the
/// webview handler or an idle tick (about every `HEARTBEAT_EVERY` of
/// silence) the caller can use to keep its socket stream alive.
pub(crate) enum RpcProgress {
    Value(serde_json::Value),
    Idle,
}

fn webview_rpc(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    webview_rpc_stream(app, method, params, timeout, &mut |_| {})
}

/// Emit a typed request into the webview and block for the final
/// result, forwarding progress payloads (and idle ticks) to
/// `on_progress`.
fn webview_rpc_stream(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
    on_progress: &mut dyn FnMut(RpcProgress),
) -> Result<serde_json::Value, String> {
    // Cold-launch guard: don't emit into a webview that has no listener
    // yet (the event would be dropped, not queued). Heartbeat THROUGH
    // the wait: a slow webview boot must not starve a streaming client
    // whose read timeout (30s) equals this latch budget. If the latch
    // never sets, fall through and let the normal timeout produce the
    // error.
    let ready_deadline = Instant::now() + WEBVIEW_READY_TIMEOUT;
    loop {
        let remaining = ready_deadline.saturating_duration_since(Instant::now());
        if webview_ready().wait(HEARTBEAT_EVERY.min(remaining)) || remaining.is_zero() {
            break;
        }
        on_progress(RpcProgress::Idle);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = mpsc::channel::<RpcMsg>();
    pending().lock().unwrap().insert(id.clone(), tx);
    let payload = serde_json::json!({ "id": id, "method": method, "params": params });
    if let Err(e) = app.emit("cli-rpc://request", payload) {
        pending().lock().unwrap().remove(&id);
        return Err(format!("emit failed: {e}"));
    }
    let deadline = Instant::now() + timeout;
    let mut idle_since = Instant::now();
    loop {
        let now = Instant::now();
        if now >= deadline {
            pending().lock().unwrap().remove(&id);
            return Err(format!("the Termic UI did not answer within {}ms", timeout.as_millis()));
        }
        let slice = CV_SLICE.min(deadline - now);
        match rx.recv_timeout(slice) {
            Ok(RpcMsg::Progress(raw)) => {
                idle_since = Instant::now();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    on_progress(RpcProgress::Value(v));
                }
            }
            Ok(RpcMsg::Result(raw)) => {
                pending().lock().unwrap().remove(&id);
                let v: serde_json::Value =
                    serde_json::from_str(&raw).map_err(|e| format!("bad rpc payload: {e}"))?;
                if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
                    return Ok(v.get("value").cloned().unwrap_or(serde_json::Value::Null));
                }
                return Err(v
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("webview handler failed")
                    .to_string());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if idle_since.elapsed() >= HEARTBEAT_EVERY {
                    idle_since = Instant::now();
                    on_progress(RpcProgress::Idle);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                pending().lock().unwrap().remove(&id);
                return Err("rpc channel closed".into());
            }
        }
    }
}

/// Callback target for the frontend RPC registry (src/lib/cliRpc.ts).
/// Unknown ids are ignored, so nothing can be injected into a request
/// that is not currently waiting.
#[tauri::command]
pub fn cli_rpc_result(id: String, payload: String) -> Result<(), String> {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(RpcMsg::Result(payload));
    }
    Ok(())
}

/// Intermediate progress for a streaming RPC (`new_task` setup output).
/// The pending entry stays registered until the result lands.
#[tauri::command]
pub fn cli_rpc_progress(id: String, payload: String) -> Result<(), String> {
    if let Some(tx) = pending().lock().unwrap().get(&id) {
        let _ = tx.send(RpcMsg::Progress(payload));
    }
    Ok(())
}

// ───────────────────────────── PATH install ──────────────────────────

/// Where the bundled sidecar lives: next to the app binary
/// (Contents/MacOS/termic-cli in a bundle, target/<profile>/termic-cli
/// in dev, both placed by tauri's externalBin machinery).
pub(crate) fn bundled_cli_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("app binary has no parent dir")?;
    let p = dir.join("termic-cli");
    if p.is_file() {
        Ok(p)
    } else {
        Err(format!("the termic-cli binary was not found at {}", p.display()))
    }
}

/// The command name to install on PATH, per build flavor, so dev, beta,
/// and prod can all coexist:
///   - debug build  -> `termic-dev`  (talks to the termic_dev data dir)
///   - beta bundle   -> `termic-beta` (identifier ends in ".beta")
///   - release       -> `termic`
/// The on-disk sidecar is always `termic-cli`; only the LINK name varies,
/// so `replaceable` still recognizes our links by their target basename.
fn install_name(identifier: &str) -> &'static str {
    if cfg!(debug_assertions) {
        "termic-dev"
    } else if identifier.ends_with(".beta") {
        "termic-beta"
    } else {
        "termic"
    }
}

fn user_bin() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".local/bin"))
}

fn install_targets(name: &str) -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from(format!("/usr/local/bin/{name}"))];
    if let Some(bin) = user_bin() {
        v.push(bin.join(name));
    }
    v
}

/// Is `dir` on the user's LOGIN-SHELL PATH (not the app's launchd PATH)?
/// That is what a fresh terminal resolves commands against, so it is the
/// honest "will `termic` be found" check. Uses the same resolved PATH the
/// PTY spawn uses (shell_env), so the answer matches the real shell.
fn dir_on_login_path(dir: &Path) -> bool {
    let path = crate::shell_env::resolved_path();
    std::env::split_paths(&path).any(|p| p == dir)
}

/// A symlink we may replace: anything whose target basename is
/// `termic-cli` (a previous install, possibly from an older app path).
/// A real file or a foreign symlink is never touched.
fn replaceable(link: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(link) {
        Err(_) => Ok(true), // absent
        Ok(md) if md.file_type().is_symlink() => {
            let target = std::fs::read_link(link).map_err(|e| e.to_string())?;
            Ok(target.file_name().is_some_and(|n| n == "termic-cli"))
        }
        Ok(_) => Ok(false),
    }
}

fn symlink_replacing(src: &Path, link: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_file(link)?;
    }
    std::os::unix::fs::symlink(src, link)
}

/// Install the CLI onto PATH. `system=false` is the no-prompt path used
/// automatically when the CLI is enabled: it symlinks into ~/.local/bin
/// (created if needed) and never asks for a password. `system=true` is
/// the explicit "install system-wide" button: /usr/local/bin via an admin
/// prompt, falling back to ~/.local/bin if that is declined. Returns a
/// human-readable result line that already states whether the location is
/// on the user's PATH.
#[tauri::command]
pub async fn cli_install_symlink(app: tauri::AppHandle, system: bool) -> Result<String, String> {
    let name = install_name(&app.config().identifier);
    tauri::async_runtime::spawn_blocking(move || install_inner(name, system))
        .await
        .map_err(|e| e.to_string())?
}

fn install_user(src: &Path, name: &str) -> Result<PathBuf, String> {
    let bin = user_bin().ok_or("no home directory")?;
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let link = bin.join(name);
    if !replaceable(&link)? {
        return Err(format!(
            "{} exists and was not installed by Termic, refusing to replace it",
            link.display()
        ));
    }
    symlink_replacing(src, &link).map_err(|e| e.to_string())?;
    Ok(link)
}

fn on_path_suffix(dir: &Path) -> String {
    if dir_on_login_path(dir) {
        String::new()
    } else {
        format!(" (add {} to your PATH, or use Install system-wide)", dir.display())
    }
}

fn install_inner(name: &str, system: bool) -> Result<String, String> {
    let src = bundled_cli_path()?;

    if system {
        let primary = PathBuf::from(format!("/usr/local/bin/{name}"));
        if !replaceable(&primary)? {
            return Err(format!(
                "{} exists and was not installed by Termic, refusing to replace it",
                primary.display()
            ));
        }
        let already = std::fs::read_link(&primary).ok().as_deref() == Some(src.as_path());
        if already || symlink_replacing(&src, &primary).is_ok() {
            return Ok(format!("installed at {}", primary.display()));
        }
        #[cfg(target_os = "macos")]
        if admin_symlink(&src, name).is_ok() {
            return Ok(format!("installed at {}", primary.display()));
        }
        // Admin declined / unavailable: fall back to the user dir.
        let link = install_user(&src, name)?;
        let dir = link.parent().unwrap_or(&link).to_path_buf();
        return Ok(format!("installed at {}{}", link.display(), on_path_suffix(&dir)));
    }

    // No-prompt user install (the on-enable path).
    let link = install_user(&src, name)?;
    let dir = link.parent().unwrap_or(&link).to_path_buf();
    Ok(format!("installed at {}{}", link.display(), on_path_suffix(&dir)))
}

/// `ln -shf` through an osascript administrator prompt, the VS Code
/// precedent for writing into /usr/local/bin.
#[cfg(target_os = "macos")]
fn admin_symlink(src: &Path, name: &str) -> Result<(), String> {
    let quoted = format!("'{}'", src.to_string_lossy().replace('\'', r"'\''"));
    let shell = format!("mkdir -p /usr/local/bin && ln -shf {quoted} /usr/local/bin/{name}");
    let script = format!(
        "do shell script \"{}\" with prompt \"Termic wants to install the {name} command.\" with administrator privileges",
        shell.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let ok = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map(|o| o.status.success())
        .map_err(|e| e.to_string())?;
    if ok { Ok(()) } else { Err("administrator prompt declined".into()) }
}

/// Current install state for the Settings UI: where the CLI is installed
/// (a symlink of ours that still resolves), the command name for this
/// build, and whether that location is on the user's login PATH.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CliInstallStatus {
    /// Absolute path of the installed symlink, or null when not installed.
    pub path: Option<String>,
    /// The command name for this build (termic / termic-dev / termic-beta).
    pub name: String,
    /// True when the installed location is on the user's login PATH.
    pub on_path: bool,
}

#[tauri::command]
pub fn cli_install_status(app: tauri::AppHandle) -> CliInstallStatus {
    let name = install_name(&app.config().identifier);
    for link in install_targets(name) {
        if let Ok(md) = std::fs::symlink_metadata(&link) {
            let ours = md.file_type().is_symlink()
                && std::fs::read_link(&link)
                    .ok()
                    .is_some_and(|t| t.file_name().is_some_and(|n| n == "termic-cli"))
                && link.exists();
            if ours {
                let on_path = link.parent().is_some_and(dir_on_login_path);
                return CliInstallStatus {
                    path: Some(link.to_string_lossy().into_owned()),
                    name: name.to_string(),
                    on_path,
                };
            }
        }
    }
    CliInstallStatus { path: None, name: name.to_string(), on_path: false }
}

// ───────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn project(id: &str, name: &str, root: &str) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            root_path: root.into(),
            default_cli: "claude".into(),
            ..Default::default()
        }
    }

    fn task(id: &str, name: &str, project_id: &str, path: &str) -> Task {
        Task {
            id: id.into(),
            name: name.into(),
            project_id: project_id.into(),
            path: path.into(),
            branch: name.into(),
            base_branch: "main".into(),
            cli: "claude".into(),
            ..Default::default()
        }
    }

    fn agent_meta(id: &str, work_done: bool) -> AgentMeta {
        AgentMeta { id: id.into(), kind: "agent".into(), work_done, disabled: false }
    }

    struct StubHost {
        enabled: bool,
        token: String,
        projects: Vec<Project>,
        tasks: Vec<Task>,
        states: Option<HashMap<String, WorkStateInfo>>,
        opened: Mutex<Vec<String>>,
        raised: Mutex<u32>,
        agents: Vec<AgentMeta>,
        /// method -> scripted result; unscripted methods error.
        rpc_results: Mutex<HashMap<String, Result<serde_json::Value, String>>>,
        /// Recorded (method, params) calls, in order.
        rpc_calls: Mutex<Vec<(String, serde_json::Value)>>,
        /// Setup chunks fed through on_progress before a new_task result.
        setup_chunks: Vec<String>,
        /// Tasks "created" by a scripted new_task rpc (appended to
        /// `tasks` on the reload handle_new performs).
        extra_tasks: Mutex<Vec<Task>>,
        killed: Mutex<Vec<String>>,
        /// (tasks with agents, live agents) the stub reports for `quit`.
        live_agents: (u32, u32),
        /// Bumped by quit_app, so a test can assert teardown happened
        /// exactly once and NOT at all under `--preview`.
        quit_calls: Mutex<u32>,
        /// Flat side-effect log ("kill:<id>", "rpc:<method>",
        /// "detach:<id>:<reason>") so tests can assert ORDER across
        /// kinds (archive must notify, then kill, then rpc).
        ops: Mutex<Vec<String>>,
        cache: AgentCache,
        reports: PromptReports,
        git_root: Option<String>,
        /// Scripted `apply` outcome, taken once per call.
        apply_result: Mutex<Option<Result<crate::SendDiffResult, crate::SendDiffError>>>,
        /// Scripted `diff` outcome, taken once per call.
        diff_result: Mutex<Option<Result<crate::TaskDiffSummary, String>>>,
        /// (task_id, kind) -> pty id, for `logs`/`attach` resolution.
        role_ptys: Mutex<HashMap<(String, String), String>>,
        /// (task_id, tab_id) -> pty id, for `--tab` resolution
        /// (GH #138 part 2, the PtyRole.tab_id path).
        tab_ptys: Mutex<HashMap<(String, String), String>>,
        /// pty id -> (retained bytes, truncated flag).
        pty_rings: Mutex<HashMap<String, (Vec<u8>, bool)>>,
        /// Bytes the attach path typed into PTYs.
        pty_inputs: Mutex<Vec<(String, Vec<u8>)>>,
        /// Live attach tap senders per pty id, so tests can drive (and
        /// end) an attach session.
        taps: Mutex<HashMap<String, Vec<std::sync::mpsc::SyncSender<crate::PtyTapMsg>>>>,
        /// (pty id, rows, cols) resizes the attach path applied.
        resizes: Mutex<Vec<(String, u16, u16)>>,
        /// Fake home dir for the transcript reader.
        home: Option<PathBuf>,
    }

    impl Default for StubHost {
        fn default() -> Self {
            let projects = vec![project("p1", "web", "/repo/web"), project("p2", "api", "/repo/api")];
            let tasks = vec![
                task("w1", "fix-auth", "p1", "/tasks/web/fix-auth"),
                task("w2", "fix-auth", "p2", "/tasks/api/fix-auth"),
                task("w3", "solo", "p1", "/tasks/web/solo"),
            ];
            StubHost {
                enabled: true,
                token: "tok".into(),
                projects,
                tasks,
                states: None,
                opened: Mutex::new(Vec::new()),
                raised: Mutex::new(0),
                live_agents: (0, 0),
                quit_calls: Mutex::new(0),
                agents: vec![
                    agent_meta("claude", true),
                    agent_meta("codex", true),
                    agent_meta("nodone", false),
                ],
                rpc_results: Mutex::new(HashMap::new()),
                rpc_calls: Mutex::new(Vec::new()),
                setup_chunks: Vec::new(),
                extra_tasks: Mutex::new(Vec::new()),
                killed: Mutex::new(Vec::new()),
                ops: Mutex::new(Vec::new()),
                cache: AgentCache::new(),
                reports: PromptReports::new(),
                git_root: None,
                apply_result: Mutex::new(None),
                diff_result: Mutex::new(None),
                role_ptys: Mutex::new(HashMap::new()),
                tab_ptys: Mutex::new(HashMap::new()),
                pty_rings: Mutex::new(HashMap::new()),
                pty_inputs: Mutex::new(Vec::new()),
                taps: Mutex::new(HashMap::new()),
                resizes: Mutex::new(Vec::new()),
                home: None,
            }
        }
    }

    impl StubHost {
        fn script_rpc(&self, method: &str, result: Result<serde_json::Value, String>) {
            self.rpc_results.lock().unwrap().insert(method.to_string(), result);
        }
        fn push_states(&self, entries: &[(&str, TaskAgentState)]) {
            self.cache.update(
                entries.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            );
        }
    }

    impl CliHost for StubHost {
        fn live_agent_counts(&self) -> (u32, u32) {
            self.live_agents
        }
        fn quit_app(&self) {
            *self.quit_calls.lock().unwrap() += 1;
            self.ops.lock().unwrap().push("quit".into());
        }
        fn cli_enabled(&self) -> bool {
            self.enabled
        }
        fn token(&self) -> &str {
            &self.token
        }
        fn app_version(&self) -> String {
            "0.0.0-test".into()
        }
        fn projects_tasks(&self) -> (Vec<Project>, Vec<Task>) {
            let mut tasks = self.tasks.clone();
            tasks.extend(self.extra_tasks.lock().unwrap().iter().cloned());
            (self.projects.clone(), tasks)
        }
        fn work_states(&self, _ids: &[String]) -> Option<HashMap<String, WorkStateInfo>> {
            self.states.as_ref().map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
        }
        fn open_task_in_ui(&self, task_id: &str) -> Result<(), String> {
            self.opened.lock().unwrap().push(task_id.to_string());
            Ok(())
        }
        fn raise_window(&self) {
            *self.raised.lock().unwrap() += 1;
        }
        fn diff_stat(&self, _task: &Task) -> Option<proto::DiffStat> {
            None
        }
        fn agents(&self) -> Vec<AgentMeta> {
            self.agents.clone()
        }
        fn rpc(
            &self,
            method: &str,
            params: serde_json::Value,
            _timeout: Duration,
        ) -> Result<serde_json::Value, String> {
            self.rpc_calls.lock().unwrap().push((method.to_string(), params.clone()));
            self.ops.lock().unwrap().push(format!("rpc:{method}"));
            let result = self
                .rpc_results
                .lock()
                .unwrap()
                .get(method)
                .cloned()
                .unwrap_or_else(|| Err(format!("no scripted rpc result for {method}")));
            if method == "new_task" {
                if let Ok(v) = &result {
                    // Mirror the webview: the create committed, so the
                    // reload sees the task.
                    if let Some(tid) = v.get("taskId").and_then(|t| t.as_str()) {
                        let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("x");
                        let pid =
                            params.get("projectId").and_then(|p| p.as_str()).unwrap_or("p1");
                        self.extra_tasks.lock().unwrap().push(task(
                            tid,
                            name,
                            pid,
                            &format!("/tasks/{name}"),
                        ));
                    }
                }
            }
            result
        }
        fn rpc_stream(
            &self,
            method: &str,
            params: serde_json::Value,
            timeout: Duration,
            on_progress: &mut dyn FnMut(RpcProgress),
        ) -> Result<serde_json::Value, String> {
            for chunk in &self.setup_chunks {
                on_progress(RpcProgress::Value(serde_json::json!({ "setupOutput": chunk })));
            }
            self.rpc(method, params, timeout)
        }
        fn agent_cache(&self) -> &AgentCache {
            &self.cache
        }
        fn prompt_reports(&self) -> &PromptReports {
            &self.reports
        }
        fn kill_task_ptys(&self, task_id: &str) -> u32 {
            self.killed.lock().unwrap().push(task_id.to_string());
            self.ops.lock().unwrap().push(format!("kill:{task_id}"));
            1
        }
        fn git_toplevel(&self, _cwd: &str) -> Option<String> {
            self.git_root.clone()
        }
        fn apply_diff(&self, _task_id: &str) -> Result<crate::SendDiffResult, crate::SendDiffError> {
            self.apply_result
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err(crate::SendDiffError::Other("no scripted apply result".into())))
        }
        fn diff_summary(&self, _task_id: &str) -> Result<crate::TaskDiffSummary, String> {
            self.diff_result
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err("no scripted diff result".into()))
        }
        fn find_role_pty(&self, task_id: &str, kind: &str) -> Result<String, String> {
            self.role_ptys
                .lock()
                .unwrap()
                .get(&(task_id.to_string(), kind.to_string()))
                .cloned()
                .ok_or_else(|| match kind {
                    "aux" => "no aux terminal is open in this task".into(),
                    _ => "no agent is running in this task".into(),
                })
        }
        fn find_tab_pty(&self, task_id: &str, tab_id: &str) -> Result<String, String> {
            self.tab_ptys
                .lock()
                .unwrap()
                .get(&(task_id.to_string(), tab_id.to_string()))
                .cloned()
                .ok_or_else(|| "no agent is running in that tab".into())
        }
        fn pty_logs(&self, pty_id: &str, max: usize) -> Result<(Vec<u8>, bool), String> {
            let rings = self.pty_rings.lock().unwrap();
            let (bytes, dropped) =
                rings.get(pty_id).ok_or("the target terminal just closed")?;
            let skip = bytes.len().saturating_sub(max);
            Ok((bytes[skip..].to_vec(), *dropped || skip > 0))
        }
        fn pty_subscribe(&self, pty_id: &str) -> Result<crate::PtyAttachment, String> {
            let rings = self.pty_rings.lock().unwrap();
            let (bytes, _) = rings.get(pty_id).ok_or("the target terminal just closed")?;
            let (tx, rx) = std::sync::mpsc::sync_channel(256);
            self.taps.lock().unwrap().entry(pty_id.to_string()).or_default().push(tx.clone());
            Ok(crate::PtyAttachment {
                pty_id: pty_id.to_string(),
                backlog: bytes.clone(),
                rx,
                tx,
            })
        }
        fn pty_input(&self, pty_id: &str, data: &[u8]) -> Result<(), String> {
            self.pty_inputs.lock().unwrap().push((pty_id.to_string(), data.to_vec()));
            Ok(())
        }
        fn pty_set_size(&self, pty_id: &str, rows: u16, cols: u16) -> Result<(), String> {
            self.resizes.lock().unwrap().push((pty_id.to_string(), rows, cols));
            Ok(())
        }
        fn notify_detach(&self, task_id: &str, reason: &str) {
            self.ops.lock().unwrap().push(format!("detach:{task_id}:{reason}"));
        }
        fn home_dir(&self) -> Option<PathBuf> {
            self.home.clone()
        }
    }

    fn req(cmd: Command, token: Option<&str>) -> Request {
        Request { id: "r".into(), token: token.map(str::to_string), cmd }
    }

    /// Sink that records events; can simulate a hung-up client.
    #[derive(Default)]
    struct VecSink {
        events: Vec<StreamEvent>,
        fail: bool,
    }

    impl EventSink for VecSink {
        fn emit(&mut self, ev: &StreamEvent) -> std::io::Result<()> {
            if self.fail {
                return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "client gone"));
            }
            self.events.push(ev.clone());
            Ok(())
        }
    }

    fn handle(req: &Request, host: &dyn CliHost) -> Reply {
        handle_request(req, host, &mut VecSink::default())
    }

    // ── auth / gating ────────────────────────────────────────────────

    #[test]
    fn hello_needs_no_token_and_reports_protocol() {
        let host = StubHost { enabled: false, ..Default::default() };
        let reply = handle(&req(Command::Hello, None), &host);
        assert!(reply.ok);
        match reply.data {
            Some(ReplyData::Hello(h)) => assert_eq!(h.protocol, proto::PROTOCOL_VERSION),
            other => panic!("expected hello, got {other:?}"),
        }
    }

    // The protocol tolerates unknown fields by design, so a misspelled or
    // renamed flag silently takes serde's default. For this verb that default
    // must be "preview", never "tear the app down".
    #[test]
    fn quit_without_the_commit_field_previews_rather_than_quitting() {
        let host = StubHost { live_agents: (1, 1), ..Default::default() };
        let raw = r#"{"id":"x","token":"tok","cmd":"quit","previw":true}"#;
        let req: Request = serde_json::from_str(raw).expect("unknown fields are tolerated");
        let reply = handle(&req, &host);
        assert!(reply.ok, "{reply:?}");
        let Some(ReplyData::Quit(q)) = reply.data else { panic!("expected quit") };
        assert!(!q.quitting, "a missing commit field must not quit");
        assert_eq!(*host.quit_calls.lock().unwrap(), 0, "typo'd field tore the app down");
    }

    // The cache can name more working tasks than there are tasks with live
    // agents: it is a webview push, and a state inside the 120s staleness
    // window can still lag a PTY that just died. Without the clamp the
    // confirmation reads "kills 1 agent across 1 task. 2 tasks still
    // working", which is nonsense the user is being asked to approve.
    #[test]
    fn quit_clamps_working_tasks_to_tasks_with_live_agents() {
        let host = StubHost { live_agents: (1, 1), ..Default::default() };
        host.push_states(&[
            ("w1", TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] }),
            // Still cached as working, but its agent PTY is already gone.
            ("w3", TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] }),
        ]);
        let reply = handle(&req(Command::Quit { commit: false }, Some("tok")), &host);
        let Some(ReplyData::Quit(q)) = reply.data else { panic!("expected quit") };
        assert_eq!(q.tasks_with_agents, 1);
        assert_eq!(q.working_tasks, Some(1), "working must never exceed the task count");
    }

    // `quit` is the most destructive verb on the socket, so the preview /
    // commit split is load-bearing: the CLI asks what would die to build its
    // confirmation question, and that ask must not itself kill anything.
    #[test]
    fn quit_preview_reports_without_tearing_down() {
        let host = StubHost { live_agents: (2, 3), ..Default::default() };
        host.push_states(&[
            ("w1", TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] }),
            ("w3", TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] }),
        ]);
        let reply = handle(&req(Command::Quit { commit: false }, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let Some(ReplyData::Quit(q)) = reply.data else { panic!("expected quit, got {reply:?}") };
        assert_eq!((q.tasks_with_agents, q.live_agents), (2, 3));
        assert_eq!(q.working_tasks, Some(1));
        assert!(!q.quitting, "preview must not claim to be quitting");
        assert_eq!(*host.quit_calls.lock().unwrap(), 0, "preview tore the app down");
    }

    #[test]
    fn quit_commits_and_reports_what_died() {
        let host = StubHost { live_agents: (2, 3), ..Default::default() };
        let reply = handle(&req(Command::Quit { commit: true }, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let Some(ReplyData::Quit(q)) = reply.data else { panic!("expected quit, got {reply:?}") };
        assert!(q.quitting);
        assert_eq!(q.live_agents, 3);
        // handle_request only ARMS teardown; serve_conn fires it after the
        // reply is written. See quit_replies_before_it_tears_the_app_down.
        assert_eq!(*host.quit_calls.lock().unwrap(), 0);
        assert!(
            QUIT_AFTER_REPLY.with(|f| f.replace(false)),
            "commit did not arm teardown on this thread",
        );
    }

    // Quitting kills every agent, so it sits behind the same gate as the
    // rest: NOT part of the unauthenticated hello/raise surface.
    #[test]
    fn quit_requires_a_token() {
        let host = StubHost::default();
        let reply = handle(&req(Command::Quit { commit: true }, None), &host);
        assert!(!reply.ok);
        assert_eq!(reply.error.as_ref().unwrap().code, ErrorCode::Auth);
        assert_eq!(*host.quit_calls.lock().unwrap(), 0, "unauthenticated quit tore the app down");
    }

    // A stale work-state cache must report 0 working rather than guessing:
    // the question would otherwise overstate what the user is about to lose.
    // The PTY counts are unaffected - they come from the PTY map, not here.
    #[test]
    fn quit_reports_unknown_work_state_when_the_cache_is_stale() {
        let host = StubHost { live_agents: (1, 1), ..Default::default() };
        host.push_states(&[(
            "w1",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        // CACHE_STALE_AFTER is 800ms under cfg(test); let it actually go stale
        // rather than reaching into the cache's internals.
        std::thread::sleep(CACHE_STALE_AFTER + Duration::from_millis(100));
        let reply = handle(&req(Command::Quit { commit: false }, Some("tok")), &host);
        let Some(ReplyData::Quit(q)) = reply.data else { panic!("expected quit") };
        assert_eq!(q.working_tasks, None, "a stale cache is UNKNOWN, not zero");
        assert_eq!(q.live_agents, 1, "PTY counts do not depend on the cache");
    }

    #[test]
    fn raise_needs_no_token_and_brings_the_window_to_front() {
        // Raise is unauthenticated (the single-instance handshake) and
        // must work even when the CLI is disabled.
        let host = StubHost { enabled: false, ..Default::default() };
        let reply = handle(&req(Command::Raise, None), &host);
        assert!(reply.ok);
        assert!(reply.data.is_none());
        assert_eq!(*host.raised.lock().unwrap(), 1);
    }

    #[test]
    fn disabled_cli_gets_the_exact_error_before_any_token_check() {
        let host = StubHost { enabled: false, ..Default::default() };
        let reply = handle(&req(Command::List { project: None, quiet: false }, Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::CliDisabled);
        assert_eq!(err.message, proto::CLI_DISABLED_MESSAGE);
    }

    #[test]
    fn bad_or_missing_token_is_refused() {
        let host = StubHost::default();
        for token in [None, Some("wrong")] {
            let reply = handle(&req(Command::List { project: None, quiet: false }, token), &host);
            assert_eq!(reply.error.expect("error").code, ErrorCode::Auth);
        }
    }

    // ── verbs ────────────────────────────────────────────────────────

    #[test]
    fn list_returns_tasks_sorted_and_degrades_without_webview() {
        let host = StubHost::default();
        let reply = handle(&req(Command::List { project: None, quiet: false }, Some("tok")), &host);
        match reply.data {
            Some(ReplyData::List(l)) => {
                let names: Vec<String> =
                    l.tasks.iter().map(|t| format!("{}/{}", t.project, t.name)).collect();
                assert_eq!(names, ["api/fix-auth", "web/fix-auth", "web/solo"]);
                assert!(l.tasks.iter().all(|t| t.work_state.is_none()));
            }
            other => panic!("expected list, got {other:?}"),
        }
    }

    #[test]
    fn list_filters_by_project_and_rejects_unknown() {
        let host = StubHost::default();
        let reply = handle(
            &req(Command::List { project: Some("api".into()), quiet: false }, Some("tok")),
            &host,
        );
        match reply.data {
            Some(ReplyData::List(l)) => {
                assert_eq!(l.tasks.len(), 1);
                assert_eq!(l.tasks[0].project, "api");
            }
            other => panic!("expected list, got {other:?}"),
        }
        let reply = handle(
            &req(Command::List { project: Some("nope".into()), quiet: false }, Some("tok")),
            &host,
        );
        assert_eq!(reply.error.expect("error").code, ErrorCode::NotFound);
    }

    #[test]
    fn list_carries_webview_work_state_when_available() {
        let mut states = HashMap::new();
        states.insert("w3".to_string(), WorkStateInfo { state: "working".into(), tabs: 2 });
        let host = StubHost { states: Some(states), ..Default::default() };
        let reply = handle(&req(Command::List { project: None, quiet: false }, Some("tok")), &host);
        let Some(ReplyData::List(l)) = reply.data else { panic!() };
        let solo = l.tasks.iter().find(|t| t.name == "solo").unwrap();
        assert_eq!(solo.work_state.as_deref(), Some("working"));
        assert_eq!(solo.open_tabs, Some(2));
        // Tasks the webview did not report stay unknown, not "idle".
        let other = l.tasks.iter().find(|t| t.project == "api").unwrap();
        assert!(other.work_state.is_none());
    }

    #[test]
    fn agent_cache_updates_bump_seq_and_wake_waiters() {
        let cache = AgentCache::new();
        assert!(cache.snapshot().age.is_none(), "no push yet");
        let mut states = HashMap::new();
        states.insert(
            "w1".to_string(),
            TaskAgentState { state: "working".into(), tabs: 2, queued: 1, capable: true, tab_states: vec![] },
        );
        cache.update(states);
        let snap = cache.snapshot();
        assert!(snap.age.is_some());
        assert_eq!(snap.states["w1"].state, "working");
        // A waiter behind the current seq returns immediately.
        assert_eq!(cache.wait_change(0, Duration::from_millis(1)), 1);
        // A waiter at the current seq times out without a push.
        assert_eq!(cache.wait_change(1, Duration::from_millis(5)), 1);
    }

    #[test]
    fn status_resolves_and_reports_depth_fields() {
        let host = StubHost::default();
        let reply = handle(
            &req(Command::Status { task: Some("solo".into()), project: None, cwd: None }, Some("tok")),
            &host,
        );
        match reply.data {
            Some(ReplyData::Status(s)) => {
                assert_eq!(s.task.summary.name, "solo");
                assert_eq!(s.task.sandbox, "off");
                assert_eq!(s.task.sessions, 0);
                assert!(s.task.dirty_files.is_none());
            }
            other => panic!("expected status, got {other:?}"),
        }
    }

    #[test]
    fn open_by_name_selects_and_raises() {
        let host = StubHost::default();
        let reply = handle(
            &req(
                Command::Open { task: Some("solo".into()), project: None, cwd: None },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Open(o)) = reply.data else { panic!() };
        assert!(o.raised);
        assert_eq!(o.task.unwrap().id, "w3");
        assert_eq!(*host.opened.lock().unwrap(), vec!["w3".to_string()]);
    }

    #[test]
    fn open_without_match_still_raises() {
        let host = StubHost::default();
        let reply = handle(
            &req(
                Command::Open { task: None, project: None, cwd: Some("/elsewhere".into()) },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Open(o)) = reply.data else { panic!() };
        assert!(o.raised);
        assert!(o.task.is_none());
        assert!(host.opened.lock().unwrap().is_empty());
    }

    // ── name resolution ──────────────────────────────────────────────

    #[test]
    fn ambiguous_name_lists_candidates() {
        let host = StubHost::default();
        let err = resolve_by_name(&host.projects, &host.tasks, "fix-auth", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::Ambiguous);
        assert!(err.message.contains("api/fix-auth"));
        assert!(err.message.contains("web/fix-auth"));
    }

    #[test]
    fn project_flag_and_qualified_name_disambiguate() {
        let host = StubHost::default();
        let t = resolve_by_name(&host.projects, &host.tasks, "fix-auth", Some("api")).unwrap();
        assert_eq!(t.id, "w2");
        let t = resolve_by_name(&host.projects, &host.tasks, "web/fix-auth", None).unwrap();
        assert_eq!(t.id, "w1");
    }

    #[test]
    fn id_matches_and_archived_tasks_are_invisible() {
        let mut host = StubHost::default();
        let t = resolve_by_name(&host.projects, &host.tasks, "w2", None).unwrap();
        assert_eq!(t.name, "fix-auth");
        host.tasks[2].archived = true;
        let err = resolve_by_name(&host.projects, &host.tasks, "solo", None).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    // ── cwd resolution ───────────────────────────────────────────────

    #[test]
    fn cwd_resolves_worktree_by_longest_prefix() {
        let host = StubHost::default();
        let t = resolve_by_cwd(&host.projects, &host.tasks, "/tasks/web/solo/src/deep")
            .unwrap()
            .unwrap();
        assert_eq!(t.id, "w3");
        // Sibling dir with a shared prefix but no path-segment boundary.
        assert!(resolve_by_cwd(&host.projects, &host.tasks, "/tasks/web/solo2")
            .unwrap()
            .is_none());
    }

    #[test]
    fn cwd_prefers_worktree_over_main_checkout() {
        let mut host = StubHost::default();
        // A main-checkout task at a path that is ALSO an ancestor of a
        // worktree task path: worktree wins (worktree-first rule).
        let mut main = task("m1", "root", "p1", "/tasks/web");
        main.is_main_checkout = true;
        host.tasks.push(main);
        let t = resolve_by_cwd(&host.projects, &host.tasks, "/tasks/web/solo").unwrap().unwrap();
        assert_eq!(t.id, "w3");
        let t = resolve_by_cwd(&host.projects, &host.tasks, "/tasks/web").unwrap().unwrap();
        assert_eq!(t.id, "m1");
    }

    #[test]
    fn cwd_resolves_composition_members() {
        let mut host = StubHost::default();
        host.tasks[2].composition = vec![crate::TaskMember {
            path: "/members/api-wt".into(),
            ..Default::default()
        }];
        let t = resolve_by_cwd(&host.projects, &host.tasks, "/members/api-wt/src")
            .unwrap()
            .unwrap();
        assert_eq!(t.id, "w3");
    }

    #[test]
    fn shared_main_checkout_is_ambiguous() {
        let mut host = StubHost::default();
        for (id, name) in [("m1", "root-a"), ("m2", "root-b")] {
            let mut t = task(id, name, "p1", "/repo/web");
            t.is_main_checkout = true;
            host.tasks.push(t);
        }
        let err = resolve_by_cwd(&host.projects, &host.tasks, "/repo/web/src").unwrap_err();
        assert_eq!(err.code, ErrorCode::Ambiguous);
        assert!(err.message.contains("web/root-a"));
        assert!(err.message.contains("web/root-b"));
    }

    // ── new ──────────────────────────────────────────────────────────

    fn new_cmd(name: &str, project: Option<&str>) -> Command {
        Command::New {
            name: name.into(),
            prompt: None,
            agent: None,
            mode: None,
            base: None,
            sandbox: None,
            yolo: false,
            project: project.map(str::to_string),
            open: false,
            wait: false,
            timeout_ms: None,
            cwd: None,
        }
    }

    #[test]
    fn new_creates_streams_setup_and_replies_at_spawn() {
        let mut host = StubHost::default();
        host.setup_chunks = vec!["npm install\n".into(), "done\n".into()];
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1", "spawned": true })));
        let mut sink = VecSink::default();
        let reply = handle_request(&req(new_cmd("shiny", Some("web")), Some("tok")), &host, &mut sink);
        let Some(ReplyData::New(n)) = reply.data else { panic!("expected new, got {reply:?}") };
        assert_eq!(n.task.id, "nw1");
        assert_eq!(n.task.name, "shiny");
        assert_eq!(n.task.project, "web");
        assert!(n.wait.is_none(), "no --wait means reply at spawn");
        let kinds: Vec<&str> = sink.events.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(kinds, ["setup_output", "setup_output", "created"]);
        assert_eq!(sink.events[0].data.as_deref(), Some("npm install\n"));
        assert_eq!(sink.events[2].task.as_ref().unwrap().id, "nw1");
        // The webview got the resolved project and the raw inputs.
        let calls = host.rpc_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "new_task");
        assert_eq!(calls[0].1["projectId"], "p1");
        assert_eq!(calls[0].1["name"], "shiny");
        assert!(calls[0].1["promptId"].is_null(), "no prompt, no prompt id");
    }

    #[test]
    fn new_resolves_project_from_cwd_worktree_first() {
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        let mut cmd = new_cmd("shiny", None);
        if let Command::New { cwd, .. } = &mut cmd {
            // Inside w2's worktree, which belongs to project api even
            // though no project root contains this path.
            *cwd = Some("/tasks/api/fix-auth/src".into());
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        assert_eq!(host.rpc_calls.lock().unwrap()[0].1["projectId"], "p2");
    }

    #[test]
    fn new_in_unregistered_repo_names_the_root() {
        let mut host = StubHost::default();
        host.git_root = Some("/repo/elsewhere".into());
        let mut cmd = new_cmd("shiny", None);
        if let Command::New { cwd, .. } = &mut cmd {
            *cwd = Some("/repo/elsewhere/sub".into());
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::UnregisteredProject);
        assert_eq!(err.data.unwrap()["root"], "/repo/elsewhere");
        // Nowhere at all: plain not-found pointing at --project.
        let mut host = StubHost::default();
        host.git_root = None;
        let mut cmd = new_cmd("shiny", None);
        if let Command::New { cwd, .. } = &mut cmd {
            *cwd = Some("/nowhere".into());
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.expect("error");
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("--project"), "{}", err.message);
    }

    #[test]
    fn new_same_name_is_a_clean_conflict_not_cleanup() {
        let host = StubHost::default();
        let reply = handle(&req(new_cmd("fix-auth", Some("web")), Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(err.message.contains("web/fix-auth"), "{}", err.message);
        // Nothing reached the webview: the create never started.
        assert!(host.rpc_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn new_validates_mode_sandbox_and_agent() {
        let host = StubHost::default();
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { mode, .. } = &mut cmd {
            *mode = Some("detached".into());
        }
        assert_eq!(handle(&req(cmd, Some("tok")), &host).error.unwrap().code, ErrorCode::BadRequest);
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { sandbox, .. } = &mut cmd {
            *sandbox = Some("jail".into());
        }
        assert_eq!(handle(&req(cmd, Some("tok")), &host).error.unwrap().code, ErrorCode::BadRequest);
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { agent, .. } = &mut cmd {
            *agent = Some("gpt-9".into());
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("claude"), "lists available agents: {}", err.message);
        // --wait with a work-done-incapable agent is refused upfront.
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { agent, wait, .. } = &mut cmd {
            *agent = Some("nodone".into());
            *wait = true;
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
    }

    #[test]
    fn new_accepts_a_qualified_project_name() {
        // `new api/shiny` from anywhere = project api, task shiny,
        // mirroring the read verbs' qualified form.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        let reply = handle(&req(new_cmd("api/shiny", None), Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let calls = host.rpc_calls.lock().unwrap();
        assert_eq!(calls[0].1["projectId"], "p2");
        assert_eq!(calls[0].1["name"], "shiny");
        drop(calls);
        // An explicit --project keeps a slash-name LITERAL: the escape
        // hatch when a task name's prefix collides with a project name.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw2" })));
        let reply = handle(&req(new_cmd("api/shiny", Some("web")), Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let calls = host.rpc_calls.lock().unwrap();
        assert_eq!(calls[0].1["projectId"], "p1");
        assert_eq!(calls[0].1["name"], "api/shiny");
        drop(calls);
        // A prefix that is NOT a project stays part of the name and
        // resolution falls through to cwd.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw3" })));
        let mut cmd = new_cmd("feat/shiny", None);
        if let Command::New { cwd, .. } = &mut cmd {
            *cwd = Some("/repo/web/src".into());
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let calls = host.rpc_calls.lock().unwrap();
        assert_eq!(calls[0].1["projectId"], "p1");
        assert_eq!(calls[0].1["name"], "feat/shiny");
    }

    #[test]
    fn new_forces_main_mode_semantics_for_non_git_projects() {
        let mut host = StubHost::default();
        host.projects[0].non_git = true;
        // Explicit --worktree on a plain folder: impossible, clean error.
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { mode, .. } = &mut cmd {
            *mode = Some("worktree".into());
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::BadRequest);
        assert!(err.message.contains("non-git"), "{}", err.message);
        assert!(host.rpc_calls.lock().unwrap().is_empty());
        // Unspecified mode is fine: the webview handler falls back to
        // the main checkout, like the GUI.
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        let reply = handle(&req(new_cmd("shiny", Some("web")), Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
    }

    // ── tab / agents (GH #138) ───────────────────────────────────────

    fn tab_cmd(task: &str, kind: proto::TabKind) -> Command {
        Command::Tab {
            task: Some(task.into()),
            project: None,
            kind,
            prompt: None,
            wait: false,
            timeout_ms: None,
            cwd: None,
        }
    }

    #[test]
    fn tab_sends_the_kind_strings_the_webview_switches_on() {
        // These four literals are a CONTRACT with newTabHandler's switch in
        // src/lib/cliRpc.ts. A typo here does not fail to compile on either
        // side; it fails at runtime with "unknown tab kind" after the app has
        // already launched. Pin every arm.
        let cases: Vec<(proto::TabKind, &str, Option<&str>)> = vec![
            (proto::TabKind::Default, "default", None),
            (proto::TabKind::Shell, "shell", None),
            (proto::TabKind::Agent { id: "codex".into() }, "agent", Some("codex")),
            (proto::TabKind::Terminal { id: "btop".into() }, "terminal", Some("btop")),
        ];
        for (kind, want_kind, want_id) in cases {
            let host = StubHost::default();
            host.script_rpc(
                "new_tab",
                Ok(serde_json::json!({ "tabId": "t1", "cli": "codex", "title": "Codex" })),
            );
            let reply = handle(&req(tab_cmd("solo", kind), Some("tok")), &host);
            assert!(reply.ok, "{want_kind}: {reply:?}");
            let calls = host.rpc_calls.lock().unwrap();
            assert_eq!(calls[0].0, "new_tab");
            assert_eq!(calls[0].1["kind"], want_kind);
            assert_eq!(calls[0].1["taskId"], "w3");
            match want_id {
                Some(id) => assert_eq!(calls[0].1["id"], id, "{want_kind}"),
                None => assert!(calls[0].1["id"].is_null(), "{want_kind}"),
            }
        }
    }

    #[test]
    fn tab_resolves_the_task_before_touching_the_webview() {
        // An ambiguous or unknown name must fail here, not open something.
        let host = StubHost::default();
        // "fix-auth" exists in BOTH fixture projects.
        let err = handle(&req(tab_cmd("fix-auth", proto::TabKind::Shell), Some("tok")), &host)
            .error
            .expect("ambiguous name should error");
        assert_eq!(err.code, ErrorCode::Ambiguous);
        assert!(host.rpc_calls.lock().unwrap().is_empty(), "must not spawn a tab");

        let host = StubHost::default();
        let err = handle(&req(tab_cmd("nope", proto::TabKind::Shell), Some("tok")), &host)
            .error
            .expect("unknown name should error");
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(host.rpc_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn tab_rejects_a_reply_with_no_tab_id() {
        // The tab id is what part 2's --tab resolves against, so a webview
        // that answers without one is a bug, not a success.
        let host = StubHost::default();
        host.script_rpc("new_tab", Ok(serde_json::json!({ "cli": "claude", "title": "Claude" })));
        let err = handle(&req(tab_cmd("solo", proto::TabKind::Shell), Some("tok")), &host)
            .error
            .expect("empty tabId should error");
        assert_eq!(err.code, ErrorCode::Internal);
    }

    #[test]
    fn tab_passes_the_webview_refusal_through() {
        // The webview owns "is this agent usable", and its message names the
        // alternatives. Flattening it would strip the only useful part.
        let host = StubHost::default();
        host.script_rpc(
            "new_tab",
            Err("unknown agent: gemni. Available: claude, codex (see `termic agents`)".into()),
        );
        let err = handle(
            &req(tab_cmd("solo", proto::TabKind::Agent { id: "gemni".into() }), Some("tok")),
            &host,
        )
        .error
        .expect("refusal should error");
        assert!(err.message.contains("Available: claude, codex"), "{}", err.message);
    }

    #[test]
    fn agents_parses_the_registry_reply_and_needs_a_token() {
        let host = StubHost::default();
        host.script_rpc(
            "list_agents",
            Ok(serde_json::json!({ "agents": [
                { "id": "claude", "kind": "agent",
                  "enabled": true, "installed": true, "usable": true },
                // installed: null is the "not detected yet" case, distinct
                // from false; it must survive the round trip.
                { "id": "btop", "kind": "terminal",
                  "enabled": false, "installed": null, "usable": false },
            ]})),
        );
        let reply = handle(&req(Command::Agents, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let Some(ReplyData::Agents(d)) = reply.data else { panic!("{reply:?}") };
        assert_eq!(d.agents.len(), 2);
        assert_eq!(d.agents[0].id, "claude");
        assert_eq!(d.agents[0].installed, Some(true));
        assert_eq!(d.agents[1].installed, None);
        assert!(!d.agents[1].enabled);
        assert!(!d.agents[1].usable);

        // Both verbs sit behind auth_gate; neither joins hello/raise.
        let host = StubHost::default();
        assert_eq!(
            handle(&req(Command::Agents, None), &host).error.unwrap().code,
            ErrorCode::Auth,
        );
        assert_eq!(
            handle(&req(tab_cmd("solo", proto::TabKind::Shell), None), &host).error.unwrap().code,
            ErrorCode::Auth,
        );
    }

    #[test]
    fn new_wait_confirms_delivery_then_settles() {
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { prompt, wait, .. } = &mut cmd {
            *prompt = Some("fix it".into());
            *wait = true;
        }
        let request = req(cmd, Some("tok"));
        std::thread::scope(|scope| {
            let handle_thread = scope.spawn(|| {
                let mut sink = VecSink::default();
                let reply = handle_request(&request, &host, &mut sink);
                (reply, sink)
            });
            // Wait for the webview call, then play the app's part:
            // confirm delivery, run a turn, settle.
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "new_task")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            host.reports.resolve(&prompt_id, Ok(()));
            host.push_states(&[(
                "nw1",
                TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            std::thread::sleep(Duration::from_millis(50));
            host.push_states(&[(
                "nw1",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let (reply, sink) = handle_thread.join().unwrap();
            let Some(ReplyData::New(n)) = reply.data else { panic!("expected new, got {reply:?}") };
            let wait = n.wait.expect("wait result");
            assert_eq!(wait.outcome, WaitOutcome::Done);
            assert_eq!(wait.state.as_deref(), Some("done"));
            let kinds: Vec<&str> = sink.events.iter().map(|e| e.event.as_str()).collect();
            assert!(kinds.contains(&"created"), "{kinds:?}");
            assert!(kinds.contains(&"prompt_delivered"), "{kinds:?}");
            assert!(kinds.contains(&"state"), "{kinds:?}");
        });
    }

    #[test]
    fn new_wait_propagates_a_failed_delivery_reason() {
        // An explicit failure report (agent PTY died mid-injection)
        // must exit 9 WITH the webview's reason, not a generic line.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { prompt, wait, .. } = &mut cmd {
            *prompt = Some("fix it".into());
            *wait = true;
        }
        let request = req(cmd, Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "new_task")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            host.reports.resolve(&prompt_id, Err("the agent PTY exited while the prompt was being typed".into()));
            let reply = t.join().unwrap();
            let Some(ReplyData::New(n)) = reply.data else { panic!("expected new, got {reply:?}") };
            let wait = n.wait.expect("wait result");
            assert_eq!(wait.outcome, WaitOutcome::NotDelivered);
            assert!(wait.detail.as_deref().unwrap_or("").contains("PTY exited"), "{wait:?}");
        });
    }

    #[test]
    fn new_wait_idle_settle_grace_covers_a_classifier_miss() {
        // Delivered, but the turn's "working" edge never shows (title
        // classifier miss): after the idle grace the wait settles Done
        // instead of hanging to the timeout.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        host.push_states(&[(
            "nw1",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { prompt, wait, .. } = &mut cmd {
            *prompt = Some("fix it".into());
            *wait = true;
        }
        let request = req(cmd, Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "new_task")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            host.reports.resolve(&prompt_id, Ok(()));
            // Keep the cache fresh while idle (the push module would).
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(60));
                host.push_states(&[(
                    "nw1",
                    TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
                )]);
            }
            let reply = t.join().unwrap();
            let Some(ReplyData::New(n)) = reply.data else { panic!("expected new, got {reply:?}") };
            let wait = n.wait.expect("wait result");
            assert_eq!(wait.outcome, WaitOutcome::Done);
            assert_eq!(wait.state.as_deref(), Some("idle"));
        });
    }

    #[test]
    fn new_wait_timeout_wins_over_a_pending_delivery() {
        // --timeout shorter than the delivery window: expiry is exit 7
        // (timeout), not exit 9, and it must not wait the full delivery
        // budget first.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        host.push_states(&[(
            "nw1",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { prompt, wait, timeout_ms, .. } = &mut cmd {
            *prompt = Some("fix it".into());
            *wait = true;
            *timeout_ms = Some(120); // < DELIVERY_TIMEOUT (300ms in test)
        }
        let started = Instant::now();
        let reply = handle(&req(cmd, Some("tok")), &host);
        let Some(ReplyData::New(n)) = reply.data else { panic!("expected new, got {reply:?}") };
        assert_eq!(n.wait.expect("wait result").outcome, WaitOutcome::Timeout);
        assert!(started.elapsed() < Duration::from_millis(290), "did not outlive the deadline");
    }

    #[test]
    fn new_wait_errors_when_the_agent_never_spawned_promptless() {
        // Promptless --wait on a task whose agent tab never got a PTY:
        // an idle dead task must not read as quiescent (false exit 0).
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1", "spawned": false })));
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { wait, .. } = &mut cmd {
            *wait = true;
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Internal);
        assert!(err.message.contains("never spawned"), "{}", err.message);
    }

    #[test]
    fn wait_survives_a_transient_empty_push() {
        // A webview reload can push an EMPTY map before loadAll
        // hydrates; a wait in flight must ride it out (the entry must
        // be CONTINUOUSLY absent for the grace window to fail).
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&req(wait_cmd("solo", None), Some("tok")), &host));
            std::thread::sleep(Duration::from_millis(60));
            host.push_states(&[]); // the reload's empty boot push
            std::thread::sleep(Duration::from_millis(60));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
            assert_eq!(w.result.outcome, WaitOutcome::Done);
        });
    }

    #[test]
    fn archive_rpc_failure_reports_after_the_kill() {
        // The kill is not undoable; a failed archive RPC must surface
        // as an error while the ops log shows the pinned order.
        let host = StubHost::default();
        host.script_rpc("archive_task", Err("webview exploded".into()));
        let reply = handle(
            &req(Command::Archive { task: "solo".into(), project: None }, Some("tok")),
            &host,
        );
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Internal);
        assert!(err.message.contains("archive failed"), "{}", err.message);
        assert_eq!(
            *host.ops.lock().unwrap(),
            vec!["detach:w3:archived", "kill:w3", "rpc:archive_task"]
        );
    }

    #[test]
    fn new_wait_without_delivery_report_is_not_delivered() {
        // A webview reload during the settle window drops the injection
        // silently; the PTY survives idle. Exit 0 must not happen.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        host.push_states(&[(
            "nw1",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { prompt, wait, .. } = &mut cmd {
            *prompt = Some("fix it".into());
            *wait = true;
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        let Some(ReplyData::New(n)) = reply.data else { panic!("expected new, got {reply:?}") };
        let wait = n.wait.expect("wait result");
        assert_eq!(wait.outcome, WaitOutcome::NotDelivered);
        assert!(wait.detail.is_some(), "carries the reason");
    }

    // ── wait ─────────────────────────────────────────────────────────

    fn wait_cmd(task: &str, timeout_ms: Option<u64>) -> Command {
        Command::Wait { task: Some(task.into()), project: None, timeout_ms, tab: None, cwd: None }
    }

    #[test]
    fn wait_returns_immediately_when_quiescent() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.task_id, "w3");
        assert_eq!(w.result.outcome, WaitOutcome::Done);
        // An agent parked on a question maps to needs-input (exit 3).
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "waiting".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!() };
        assert_eq!(w.result.outcome, WaitOutcome::NeedsInput);
    }

    #[test]
    fn wait_refuses_inactive_and_incapable_targets() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "inactive".into(), tabs: 0, queued: 0, capable: false, tab_states: vec![] },
        )]);
        let err = handle(&req(wait_cmd("solo", None), Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("no agent is open"), "{}", err.message);
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: false, tab_states: vec![] },
        )]);
        let err = handle(&req(wait_cmd("solo", None), Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("work-done"), "{}", err.message);
    }

    #[test]
    fn wait_quiescence_requires_an_empty_queue() {
        // Settle alone races send's queueing (docs/plans/cli.md): a
        // "done" agent with a queued message is NOT quiescent.
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 1, queued: 1, capable: true, tab_states: vec![] },
        )]);
        let reply = handle(&req(wait_cmd("solo", Some(120)), Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.result.outcome, WaitOutcome::Timeout);
    }

    #[test]
    fn wait_times_out_while_working() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let started = Instant::now();
        let reply = handle(&req(wait_cmd("solo", Some(100)), Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.result.outcome, WaitOutcome::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn wait_unblocks_on_a_push() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&req(wait_cmd("solo", None), Some("tok")), &host));
            std::thread::sleep(Duration::from_millis(60));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
            assert_eq!(w.result.outcome, WaitOutcome::Done);
            assert_eq!(w.result.state.as_deref(), Some("done"));
        });
    }

    #[test]
    fn wait_fails_when_the_cache_goes_stale_mid_wait() {
        // The webview stopped reporting (reload that never came back):
        // a frozen "working" snapshot must fail the wait, not hold it
        // forever. CACHE_STALE_AFTER is test-shrunk to 800ms.
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let started = Instant::now();
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Internal);
        assert!(err.message.contains("stopped reporting"), "{}", err.message);
        assert!(started.elapsed() >= Duration::from_millis(700), "not before the cutoff");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn wait_answers_from_a_stale_cache_when_already_quiescent() {
        // Staleness only matters when we would KEEP waiting: an idle
        // occluded webview is not a dead one, so a quiescent cached
        // state is returned even past the cutoff.
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        std::thread::sleep(Duration::from_millis(900)); // age past the 800ms test cutoff
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.result.outcome, WaitOutcome::Done);
    }

    #[test]
    fn wait_reports_a_task_the_ui_does_not_know() {
        // Cache populated, but no entry for this task (fresh create the
        // store has not loaded, or it vanished): after the grace the
        // error names the task, not a dead UI.
        let host = StubHost::default();
        host.push_states(&[(
            "w1",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Internal);
        assert!(err.message.contains("this task"), "{}", err.message);
    }

    #[test]
    fn ready_latch_blocks_until_set() {
        let latch = ReadyLatch::new();
        assert!(!latch.wait(Duration::from_millis(30)), "unset latch times out");
        latch.set();
        assert!(latch.wait(Duration::from_millis(1)), "set latch returns immediately");
        // Cross-thread: a waiter wakes on set().
        let latch = std::sync::Arc::new(ReadyLatch::new());
        let l2 = latch.clone();
        let t = std::thread::spawn(move || l2.wait(Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(20));
        latch.set();
        assert!(t.join().unwrap());
    }

    #[test]
    fn new_rejects_a_disabled_agent() {
        let mut host = StubHost::default();
        host.agents.push(AgentMeta {
            id: "parked".into(),
            kind: "agent".into(),
            work_done: true,
            disabled: true,
        });
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { agent, .. } = &mut cmd {
            *agent = Some("parked".into());
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("disabled"), "{}", err.message);
        assert!(host.rpc_calls.lock().unwrap().is_empty(), "nothing reached the webview");
    }

    #[test]
    fn new_treats_a_blank_prompt_as_no_prompt() {
        // A whitespace prompt must not mint a prompt id nothing ever
        // reports on (it would burn the delivery timeout under --wait).
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        let mut cmd = new_cmd("shiny", Some("web"));
        if let Command::New { prompt, .. } = &mut cmd {
            *prompt = Some("   ".into());
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let calls = host.rpc_calls.lock().unwrap();
        assert!(calls[0].1["prompt"].is_null());
        assert!(calls[0].1["promptId"].is_null());
    }

    #[test]
    fn wait_errors_when_the_ui_never_pushed() {
        let host = StubHost::default();
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Internal);
        assert!(err.message.contains("not reported"), "{}", err.message);
    }

    #[test]
    fn watch_aborts_when_the_client_hangs_up() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let mut sink = VecSink { fail: true, ..Default::default() };
        let started = Instant::now();
        let reply =
            handle_request(&req(wait_cmd("solo", None), Some("tok")), &host, &mut sink);
        // The watch must END (not spin forever) once the heartbeat
        // write fails; the reply itself would also fail to send.
        assert!(started.elapsed() < Duration::from_secs(5));
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.result.detail.as_deref(), Some("client disconnected"));
    }

    // ── archive ──────────────────────────────────────────────────────

    #[test]
    fn archive_kills_ptys_before_the_webview_archive() {
        let host = StubHost::default();
        host.script_rpc("archive_task", Ok(serde_json::Value::Null));
        let reply = handle(
            &req(Command::Archive { task: "solo".into(), project: None }, Some("tok")),
            &host,
        );
        let Some(ReplyData::Archive(a)) = reply.data else { panic!("expected archive, got {reply:?}") };
        assert_eq!(a.task_id, "w3");
        assert_eq!(a.project, "web");
        assert_eq!(a.killed_agents, 1);
        // Order is the point: attach sessions get their in-band reason,
        // then SIGKILL strictly before the archive RPC (removing a
        // worktree under a live agent is undefined).
        assert_eq!(
            *host.ops.lock().unwrap(),
            vec!["detach:w3:archived", "kill:w3", "rpc:archive_task"]
        );
    }

    #[test]
    fn archive_unknown_task_errors_without_side_effects() {
        let host = StubHost::default();
        let reply = handle(
            &req(Command::Archive { task: "nope".into(), project: None }, Some("tok")),
            &host,
        );
        assert_eq!(reply.error.unwrap().code, ErrorCode::NotFound);
        assert!(host.ops.lock().unwrap().is_empty());
    }

    // ── projects ─────────────────────────────────────────────────────

    #[test]
    fn project_list_reports_live_task_counts_sorted() {
        let mut host = StubHost::default();
        host.tasks[2].archived = true; // solo out
        let reply = handle(&req(Command::ProjectList, Some("tok")), &host);
        let Some(ReplyData::ProjectList(l)) = reply.data else { panic!("expected list, got {reply:?}") };
        let rows: Vec<(String, u32)> =
            l.projects.iter().map(|p| (p.name.clone(), p.tasks)).collect();
        assert_eq!(rows, vec![("api".into(), 1), ("web".into(), 1)]);
        assert_eq!(l.projects[0].default_agent, "claude");
    }

    #[test]
    fn project_add_goes_through_the_webview_and_reads_back() {
        let host = StubHost::default();
        host.script_rpc("project_add", Ok(serde_json::json!({ "projectId": "p2" })));
        let reply = handle(
            &req(Command::ProjectAdd { path: "/repo/api".into(), non_git: false }, Some("tok")),
            &host,
        );
        let Some(ReplyData::ProjectAdd(a)) = reply.data else { panic!("expected add, got {reply:?}") };
        assert_eq!(a.project.name, "api");
        let calls = host.rpc_calls.lock().unwrap();
        assert_eq!(calls[0].0, "project_add");
        assert_eq!(calls[0].1["path"], "/repo/api");
    }

    #[test]
    fn project_add_is_idempotent_for_an_already_registered_path() {
        // The help promises "0 registered (or already registered)";
        // agents defensively add before creating tasks.
        let host = StubHost::default();
        host.script_rpc("project_add", Err("project already added".into()));
        let reply = handle(
            &req(Command::ProjectAdd { path: "/repo/api".into(), non_git: false }, Some("tok")),
            &host,
        );
        let Some(ReplyData::ProjectAdd(a)) = reply.data else { panic!("expected add, got {reply:?}") };
        assert_eq!(a.project.name, "api");
        // A path that matches NO registered project still errors.
        let host = StubHost::default();
        host.script_rpc("project_add", Err("project already added".into()));
        let reply = handle(
            &req(Command::ProjectAdd { path: "/repo/unknown".into(), non_git: false }, Some("tok")),
            &host,
        );
        assert_eq!(reply.error.expect("error").code, ErrorCode::Internal);
    }

    #[test]
    fn cached_work_states_degrades_past_the_staleness_cutoff() {
        let fresh = AgentSnapshot {
            states: HashMap::from([(
                "w1".to_string(),
                TaskAgentState { state: "working".into(), tabs: 2, queued: 0, capable: true, tab_states: vec![] },
            )]),
            age: Some(Duration::from_millis(1)),
        };
        let ids = vec!["w1".to_string()];
        let out = cached_work_states(&fresh, &ids).expect("fresh cache answers");
        assert_eq!(out["w1"].state, "working");
        // Stale: unknown (None), never frozen rows presented as live.
        let stale = AgentSnapshot { age: Some(CACHE_STALE_AFTER + Duration::from_millis(1)), ..fresh.clone() };
        assert!(cached_work_states(&stale, &ids).is_none());
        // Never pushed: unknown.
        let never = AgentSnapshot { age: None, ..fresh };
        assert!(cached_work_states(&never, &ids).is_none());
    }

    #[test]
    fn resolve_task_arg_rejects_project_without_task() {
        let host = StubHost::default();
        let (projects, tasks) = host.projects_tasks();
        let err = resolve_task_arg(&projects, &tasks, None, Some("web"), Some("/tasks/web/solo"))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::BadRequest);
    }

    #[test]
    fn project_add_maps_the_non_git_error_to_the_flag() {
        // The backend's message describes the GUI confirmation dialog;
        // the CLI's version of that confirmation is --non-git.
        let host = StubHost::default();
        host.script_rpc(
            "project_add",
            Err("/x/plain is not a git repo. Confirm adding it as a plain folder.".into()),
        );
        let reply = handle(
            &req(Command::ProjectAdd { path: "/x/plain".into(), non_git: false }, Some("tok")),
            &host,
        );
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::BadRequest);
        assert!(err.message.contains("--non-git"), "{}", err.message);
        // With the flag, the choice is forwarded to the webview.
        let host = StubHost::default();
        host.script_rpc("project_add", Ok(serde_json::json!({ "projectId": "p2" })));
        let reply = handle(
            &req(Command::ProjectAdd { path: "/x/plain".into(), non_git: true }, Some("tok")),
            &host,
        );
        assert!(reply.ok, "{reply:?}");
        assert_eq!(host.rpc_calls.lock().unwrap()[0].1["nonGit"], true);
    }

    #[test]
    fn project_remove_counts_tasks_and_kills_their_ptys_first() {
        let host = StubHost::default();
        host.script_rpc("project_remove", Ok(serde_json::Value::Null));
        let reply = handle(
            &req(Command::ProjectRemove { name: "web".into() }, Some("tok")),
            &host,
        );
        let Some(ReplyData::ProjectRemove(r)) = reply.data else { panic!("expected remove, got {reply:?}") };
        assert_eq!(r.name, "web");
        assert_eq!(r.removed_tasks, 2);
        let ops = host.ops.lock().unwrap();
        assert_eq!(
            *ops,
            vec!["detach:w1:archived", "kill:w1", "detach:w3:archived", "kill:w3", "rpc:project_remove"]
        );
        // Unknown project: clean error, no kills, no RPC.
        drop(ops);
        let host = StubHost::default();
        let reply = handle(
            &req(Command::ProjectRemove { name: "nope".into() }, Some("tok")),
            &host,
        );
        assert_eq!(reply.error.unwrap().code, ErrorCode::NotFound);
        assert!(host.ops.lock().unwrap().is_empty());
    }

    // ── streamed replies over the real socket ────────────────────────

    #[test]
    fn socket_streams_wait_events_before_the_final_reply() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let (sock, _guard) = spawn_server(host);
        let mut stream = UnixStream::connect(&sock).unwrap();
        proto::write_msg(&mut stream, &req(wait_cmd("solo", None), Some("tok"))).unwrap();
        let mut reader = BufReader::new(stream);
        let mut saw_state = false;
        loop {
            let line = proto::read_line(&mut reader).unwrap().expect("line");
            match proto::parse_stream_line(&line).unwrap() {
                proto::StreamLine::Event(ev) => {
                    if ev.event == "state" {
                        assert_eq!(ev.state.as_deref(), Some("done"));
                        saw_state = true;
                    }
                }
                proto::StreamLine::Done(reply) => {
                    assert!(reply.ok, "{reply:?}");
                    assert!(matches!(reply.data, Some(ReplyData::Wait(_))));
                    break;
                }
            }
        }
        assert!(saw_state, "a state event precedes the reply");
    }

    // ── project resolution for new ───────────────────────────────────

    #[test]
    fn resolve_project_for_new_prefers_worktree_then_longest_root() {
        let host = StubHost::default();
        let (projects, tasks) = host.projects_tasks();
        // Inside a worktree of api's task: api wins.
        let p = resolve_project_for_new(&projects, &tasks, &host, Some("/tasks/api/fix-auth/deep"))
            .unwrap();
        assert_eq!(p.id, "p2");
        // Inside a registered root: that project.
        let p = resolve_project_for_new(&projects, &tasks, &host, Some("/repo/web/src")).unwrap();
        assert_eq!(p.id, "p1");
        // No cwd at all: told to use --project.
        let err = resolve_project_for_new(&projects, &tasks, &host, None).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("--project"));
    }

    #[test]
    fn status_and_wait_resolve_from_cwd_like_open() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let status = handle(
            &req(
                Command::Status { task: None, project: None, cwd: Some("/tasks/web/solo/src".into()) },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Status(s)) = status.data else { panic!("expected status, got {status:?}") };
        assert_eq!(s.task.summary.name, "solo");
        let wait = handle(
            &req(
                Command::Wait { task: None, project: None, timeout_ms: None, tab: None, cwd: Some("/tasks/web/solo".into()) },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Wait(w)) = wait.data else { panic!("expected wait, got {wait:?}") };
        assert_eq!(w.task_id, "w3");
        // Nowhere: a clear name-the-task error, not a resolution puzzle.
        let miss = handle(
            &req(Command::Status { task: None, project: None, cwd: Some("/elsewhere".into()) }, Some("tok")),
            &host,
        );
        let err = miss.error.expect("error");
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("name the task"), "{}", err.message);
    }

    // ── token hygiene ────────────────────────────────────────────────

    #[test]
    fn token_is_long_random_and_never_in_the_app_env() {
        let t1 = mint_token();
        let t2 = mint_token();
        assert_ne!(t1, t2);
        assert!(t1.len() >= 32, "128+ bits required, got {} chars", t1.len());
        // The app-env invariant pty_spawn depends on: the token must
        // never appear in this process's environment, under any name.
        // (Textual assertion for ABSENCE, per the testing rules.)
        for (k, v) in std::env::vars() {
            assert_ne!(v, t1, "token leaked into env var {k}");
            assert!(
                !k.eq_ignore_ascii_case("TERMIC_CLI_TOKEN"),
                "a token-shaped env var exists: {k}"
            );
        }
    }

    #[test]
    fn token_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(proto::TOKEN_FILE);
        // Pre-existing file with sloppy permissions must be replaced.
        std::fs::write(&p, "old").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_token_file(&p, "newtoken").unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "newtoken");
    }

    // ── real-socket integration (stub host, no app) ──────────────────

    fn spawn_server(host: StubHost) -> (PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join(proto::SOCKET_FILE);
        let listener = UnixListener::bind(&sock).unwrap();
        let host: Arc<dyn CliHost> = Arc::new(host);
        std::thread::spawn(move || serve_listener(listener, host));
        (sock, dir)
    }

    fn roundtrip_on(sock: &Path, req: &Request) -> Reply {
        let mut stream = UnixStream::connect(sock).unwrap();
        proto::write_msg(&mut stream, req).unwrap();
        let mut reader = BufReader::new(stream);
        proto::read_msg::<_, Reply>(&mut reader).unwrap().unwrap()
    }

    /// Like `spawn_server` but keeps a concrete handle to the host so a
    /// test can observe side effects (e.g. raise_window calls).
    fn spawn_server_arc(host: StubHost) -> (PathBuf, tempfile::TempDir, Arc<StubHost>) {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join(proto::SOCKET_FILE);
        let listener = UnixListener::bind(&sock).unwrap();
        let arc = Arc::new(host);
        let dynamic: Arc<dyn CliHost> = arc.clone();
        std::thread::spawn(move || serve_listener(listener, dynamic));
        (sock, dir, arc)
    }

    // The ordering `quit` depends on: the client must GET its reply, and only
    // then may the app tear down. Get this backwards and a successful quit is
    // reported as CONNECTION_LOST (exit 8). Exercised over a real socket
    // because the bug lives in serve_conn, not in handle_request.
    #[test]
    fn quit_replies_before_it_tears_the_app_down() {
        let (sock, _guard, host) = spawn_server_arc(StubHost {
            live_agents: (1, 2),
            ..Default::default()
        });
        let reply = roundtrip_on(&sock, &req(Command::Quit { commit: true }, Some("tok")));
        // The reply arrived at all: that is the property under test.
        assert!(reply.ok, "{reply:?}");
        let Some(ReplyData::Quit(q)) = reply.data else { panic!("expected quit, got {reply:?}") };
        assert!(q.quitting);
        assert_eq!(q.live_agents, 2);
        // ...and teardown followed it.
        let mut fired = false;
        for _ in 0..100 {
            if *host.quit_calls.lock().unwrap() == 1 {
                fired = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(fired, "reply was delivered but the app never tore down");
    }

    #[test]
    fn preflight_raises_a_live_sibling_and_ignores_a_dead_socket() {
        let (sock, guard, host) = spawn_server_arc(StubHost::default());
        // A live sibling answers hello, so the preflight raises it and
        // reports true (the second instance should exit). raise_existing
        // reads the raise reply, so the raise_window call has already run.
        assert!(raise_existing(&sock));
        assert_eq!(*host.raised.lock().unwrap(), 1);
        // No server behind the path: not a live sibling, so we would bind.
        let dead = guard.path().join("nobody.sock");
        assert!(!raise_existing(&dead));
    }

    #[test]
    fn preflight_treats_a_stale_socket_file_as_no_sibling() {
        // A leftover socket FILE with nothing listening (crash) must not
        // be mistaken for a live instance: connect() fails fast.
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(proto::SOCKET_FILE);
        let listener = UnixListener::bind(&stale).unwrap();
        drop(listener); // socket file may linger, but nothing listens
        assert!(!raise_existing(&stale));
    }

    #[test]
    fn socket_serves_hello_and_authenticated_list() {
        let (sock, _guard) = spawn_server(StubHost::default());
        let hello = roundtrip_on(&sock, &req(Command::Hello, None));
        assert!(hello.ok);
        let list = roundtrip_on(&sock, &req(Command::List { project: None, quiet: false }, Some("tok")));
        assert!(list.ok);
        let denied = roundtrip_on(&sock, &req(Command::List { project: None, quiet: false }, Some("bad")));
        assert_eq!(denied.error.unwrap().code, ErrorCode::Auth);
    }

    #[test]
    fn socket_handles_multiple_requests_per_connection() {
        let (sock, _guard) = spawn_server(StubHost::default());
        let mut stream = UnixStream::connect(&sock).unwrap();
        proto::write_msg(&mut stream, &req(Command::Hello, None)).unwrap();
        proto::write_msg(&mut stream, &req(Command::List { project: None, quiet: false }, Some("tok")))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let first: Reply = proto::read_msg(&mut reader).unwrap().unwrap();
        let second: Reply = proto::read_msg(&mut reader).unwrap().unwrap();
        assert!(matches!(first.data, Some(ReplyData::Hello(_))));
        assert!(matches!(second.data, Some(ReplyData::List(_))));
    }

    #[test]
    fn install_name_is_build_aware() {
        // In this test binary cfg!(debug_assertions) is true, so the name
        // is always the dev one regardless of identifier - which is
        // exactly the invariant we want (a debug build installs
        // `termic-dev`, never colliding with a prod `termic`).
        assert_eq!(install_name("com.simion.termic"), "termic-dev");
        assert_eq!(install_name("com.simion.termic.beta"), "termic-dev");
        // The release/beta arms are unreachable here; assert the pure
        // suffix rule they use so a rename is caught.
        assert!("com.simion.termic.beta".ends_with(".beta"));
        assert!(!"com.simion.termic".ends_with(".beta"));
    }

    #[test]
    fn install_targets_use_the_name() {
        let t = install_targets("termic-dev");
        assert_eq!(t[0], PathBuf::from("/usr/local/bin/termic-dev"));
        assert!(t.iter().any(|p| p.ends_with(".local/bin/termic-dev")));
    }

    #[test]
    fn socket_survives_garbage_lines() {
        let (sock, _guard) = spawn_server(StubHost::default());
        let mut stream = UnixStream::connect(&sock).unwrap();
        stream.write_all(b"this is not json\n").unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let reply: Reply = proto::read_msg(&mut reader).unwrap().unwrap();
        assert_eq!(reply.error.unwrap().code, ErrorCode::BadRequest);
        // The connection stays usable afterwards.
        proto::write_msg(&mut stream, &req(Command::Hello, None)).unwrap();
        let reply: Reply = proto::read_msg(&mut reader).unwrap().unwrap();
        assert!(reply.ok);
    }

    // ── tab selectors / part 2 (GH #138) ─────────────────────────────

    fn tab_state(
        id: &str,
        kind: &str,
        cli: &str,
        title: &str,
        state: Option<&str>,
        live: bool,
        is_default: bool,
    ) -> TabAgentState {
        TabAgentState {
            id: id.into(),
            kind: kind.into(),
            cli: cli.into(),
            title: title.into(),
            state: state.map(str::to_string),
            queued: 0,
            capable: state.is_some(),
            live,
            is_default,
        }
    }

    /// Push a per-tab snapshot for one task (aggregate derived).
    fn push_tabs(host: &StubHost, task: &str, aggregate: &str, tabs: Vec<TabAgentState>) {
        let entry = TaskAgentState {
            state: aggregate.into(),
            tabs: tabs.len() as u32,
            queued: tabs.iter().map(|t| t.queued).sum(),
            capable: tabs.iter().any(|t| t.capable),
            tab_states: tabs,
        };
        host.cache.update(HashMap::from([(task.to_string(), entry)]));
    }

    /// The canonical three-tab strip most selector tests run against:
    /// [1] claude (default), [2] codex titled "fixing tests", [3] shell.
    fn seed_strip(host: &StubHost) {
        push_tabs(
            host,
            "w3",
            "idle",
            vec![
                tab_state("tab-a", "agent", "claude", "claude", Some("idle"), true, true),
                tab_state("tab-b", "agent", "codex", "fixing tests", Some("idle"), true, false),
                tab_state("tab-c", "shell", "shell", "Terminal", None, true, false),
            ],
        );
    }

    fn w3(host: &StubHost) -> Task {
        host.tasks.iter().find(|t| t.id == "w3").unwrap().clone()
    }

    #[test]
    fn selector_resolves_id_index_title_and_cli() {
        let host = StubHost::default();
        seed_strip(&host);
        let t = w3(&host);
        for (sel, want) in [
            ("tab-b", "tab-b"),        // the identity itself
            ("2", "tab-b"),            // 1-based strip index
            ("fixing tests", "tab-b"), // title
            ("CODEX", "tab-b"),        // cli id, case-insensitive
            ("1", "tab-a"),
        ] {
            let got = resolve_tab_selector(&host, &t, sel).unwrap_or_else(|e| {
                panic!("selector {sel:?} should resolve: {}", e.message)
            });
            assert_eq!(got.id, want, "selector {sel:?}");
        }
    }

    #[test]
    fn selector_ambiguity_is_an_error_listing_candidates_never_a_guess() {
        let host = StubHost::default();
        push_tabs(
            &host,
            "w3",
            "idle",
            vec![
                tab_state("tab-a", "agent", "claude", "claude", Some("idle"), true, true),
                tab_state("tab-b", "agent", "claude", "claude", Some("idle"), true, false),
            ],
        );
        let e = resolve_tab_selector(&host, &w3(&host), "claude").unwrap_err();
        assert_eq!(e.code, ErrorCode::Ambiguous);
        for needle in ["tab-a", "tab-b", "[1]", "[2]"] {
            assert!(e.message.contains(needle), "{}", e.message);
        }
    }

    #[test]
    fn selector_not_found_names_the_strip() {
        let host = StubHost::default();
        seed_strip(&host);
        let t = w3(&host);
        let e = resolve_tab_selector(&host, &t, "9").unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert!(e.message.contains("has 3 tabs"), "{}", e.message);
        let e = resolve_tab_selector(&host, &t, "0").unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        let e = resolve_tab_selector(&host, &t, "nope").unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        // The listing is how a caller learns the strip without a second
        // command.
        assert!(e.message.contains("[1] claude"), "{}", e.message);
        assert!(e.message.contains("[2] fixing tests"), "{}", e.message);
    }

    #[test]
    fn selector_refuses_non_agent_tabs() {
        let host = StubHost::default();
        seed_strip(&host);
        let t = w3(&host);
        for sel in ["3", "Terminal", "tab-c"] {
            let e = resolve_tab_selector(&host, &t, sel).unwrap_err();
            assert_eq!(e.code, ErrorCode::Unsupported, "{sel}");
            assert!(e.message.contains("write-only"), "{}", e.message);
        }
    }

    #[test]
    fn selector_degrades_to_exact_persisted_ids_without_a_snapshot() {
        // No push at all: a recorded id still resolves (scripts that
        // saved what `termic tab` printed), index and title honestly
        // cannot, and a persisted custom tab is refused.
        let host = StubHost::default();
        let mut t = w3(&host);
        t.persisted_tabs = vec![
            crate::PersistedTab {
                id: "tab-a".into(),
                cli: "claude".into(),
                title: None,
                custom_title: false,
                is_default: true,
                command: None,
                session_id: None,
                previous_session_id: None,
                pane_leaf_id: None,
                run_member: None,
            },
            crate::PersistedTab {
                id: "tab-x".into(),
                cli: "custom".into(),
                title: None,
                custom_title: false,
                is_default: false,
                command: Some("npm run dev".into()),
                session_id: None,
                previous_session_id: None,
                pane_leaf_id: None,
                run_member: None,
            },
            crate::PersistedTab {
                id: "tab-sh".into(),
                cli: "shell".into(),
                title: None,
                custom_title: false,
                is_default: false,
                command: None,
                session_id: None,
                previous_session_id: None,
                pane_leaf_id: None,
                run_member: None,
            },
        ];
        assert_eq!(resolve_tab_selector(&host, &t, "tab-a").unwrap().id, "tab-a");
        let e = resolve_tab_selector(&host, &t, "1").unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
        assert!(e.message.contains("not reported"), "{}", e.message);
        // Non-agent persisted tabs get the typed write-only refusal, not
        // a resolution that fails later with a misleading message.
        for sel in ["tab-x", "tab-sh"] {
            let e = resolve_tab_selector(&host, &t, sel).unwrap_err();
            assert_eq!(e.code, ErrorCode::Unsupported, "{sel}");
            assert!(e.message.contains("write-only"), "{sel}: {}", e.message);
        }
    }

    #[test]
    fn send_tab_resolves_then_passes_the_tab_id_to_the_webview() {
        let host = StubHost::default();
        seed_strip(&host);
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "delivered", "capable": true })),
        );
        let mut cmd = send_cmd("solo", false);
        if let Command::Send { tab, .. } = &mut cmd {
            *tab = Some("2".into());
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let calls = host.rpc_calls.lock().unwrap();
        let (_, params) = calls.iter().find(|(m, _)| m == "send_prompt").unwrap();
        // The webview receives the RESOLVED ID, never the raw selector:
        // one resolver decides what "2" means for every verb.
        assert_eq!(params["tabId"], "tab-b");
        assert!(params.get("spawnPending").map_or(true, |v| v.is_null() || v == false));
    }

    #[test]
    fn send_tab_flag_conflicts_and_bad_selectors_never_reach_the_webview() {
        let host = StubHost::default();
        seed_strip(&host);
        let mut cmd = send_cmd("solo", false);
        if let Command::Send { tab, resume, .. } = &mut cmd {
            *tab = Some("2".into());
            *resume = true;
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::BadRequest);
        let mut cmd = send_cmd("solo", false);
        if let Command::Send { tab, .. } = &mut cmd {
            *tab = Some("9".into());
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(host.rpc_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn send_tab_wait_ignores_the_targets_stale_done() {
        // Per-tab state removes SIBLING pollution, but the target's own
        // stale done is still poison: the cache trails the store by the
        // push debounce, and the tab you target is often exactly the one
        // wearing a done badge from its LAST turn. Trusting it settles
        // the wait the instant delivery confirms: a false exit 0 before
        // the new turn even starts. This is the send_wait_ignores_a_
        // stale_sibling_done contract, targeted edition; it pins
        // trust_done=false for send --tab (flipping it greens nothing
        // else and fails only here).
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "delivered", "capable": true })),
        );
        let stale = |state: &str| {
            vec![tab_state("tab-b", "agent", "codex", "codex", Some(state), true, false)]
        };
        push_tabs(&host, "w3", "done", stale("done"));
        let mut cmd = send_cmd("solo", true);
        if let Command::Send { tab, .. } = &mut cmd {
            *tab = Some("tab-b".into());
        }
        let request = req(cmd, Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "send_prompt")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            host.reports.resolve(&prompt_id, Ok(()));
            // Well inside the idle grace (200ms under cfg(test)): the
            // target's stale done must NOT have settled the wait.
            std::thread::sleep(Duration::from_millis(100));
            assert!(!t.is_finished(), "the target's stale done settled the wait");
            // The real turn: working, then done, on the target tab.
            push_tabs(&host, "w3", "working", stale("working"));
            std::thread::sleep(Duration::from_millis(30));
            push_tabs(&host, "w3", "done", stale("done"));
            let reply = t.join().unwrap();
            let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
            assert_eq!(s.wait.expect("wait result").outcome, WaitOutcome::Done);
        });
    }

    #[test]
    fn wait_tab_reads_only_that_tabs_state() {
        // The whole point of --tab: a busy SIBLING must not stall the
        // wait. Aggregate says working; the watched tab is done.
        let host = StubHost::default();
        push_tabs(
            &host,
            "w3",
            "working",
            vec![
                tab_state("tab-a", "agent", "claude", "claude", Some("working"), true, true),
                tab_state("tab-b", "agent", "codex", "codex", Some("done"), true, false),
            ],
        );
        let mut cmd = wait_cmd("solo", Some(2_000));
        if let Command::Wait { tab, .. } = &mut cmd {
            *tab = Some("tab-b".into());
        }
        let reply = handle(&req(cmd, Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.result.outcome, WaitOutcome::Done);
        assert_eq!(w.result.state.as_deref(), Some("done"));
    }

    #[test]
    fn wait_tab_refuses_dead_and_incapable_tabs_on_first_sight() {
        let host = StubHost::default();
        push_tabs(
            &host,
            "w3",
            "idle",
            vec![
                tab_state("tab-dead", "agent", "claude", "claude", Some("idle"), false, false),
                {
                    let mut t =
                        tab_state("tab-nod", "agent", "nodone", "nodone", None, true, false);
                    t.capable = false;
                    t
                },
            ],
        );
        for (sel, needle) in [
            ("tab-dead", "no agent is running in that tab"),
            ("tab-nod", "work-done detection disabled"),
        ] {
            let mut cmd = wait_cmd("solo", Some(2_000));
            if let Command::Wait { tab, .. } = &mut cmd {
                *tab = Some(sel.into());
            }
            let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
            assert_eq!(err.code, ErrorCode::Unsupported, "{sel}");
            assert!(err.message.contains(needle), "{sel}: {}", err.message);
        }
    }

    #[test]
    fn wait_tab_errors_when_the_tab_closes_mid_wait() {
        let host = StubHost::default();
        push_tabs(
            &host,
            "w3",
            "working",
            vec![tab_state("tab-a", "agent", "claude", "claude", Some("working"), true, true)],
        );
        let mut cmd = wait_cmd("solo", Some(5_000));
        if let Command::Wait { tab, .. } = &mut cmd {
            *tab = Some("tab-a".into());
        }
        let request = req(cmd, Some("tok"));
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(60));
                // The tab vanishes from the strip (closed); the task
                // entry itself stays.
                push_tabs(&host, "w3", "idle", vec![]);
            });
            let err = handle(&request, &host).error.expect("tab-gone error");
            assert_eq!(err.code, ErrorCode::Unsupported);
            assert!(err.message.contains("went away"), "{}", err.message);
        });
    }

    #[test]
    fn logs_tab_reads_that_tabs_ring_and_conflicts_with_shell() {
        let host = StubHost::default();
        seed_strip(&host);
        host.tab_ptys
            .lock()
            .unwrap()
            .insert(("w3".into(), "tab-b".into()), "pty-b".into());
        host.pty_rings
            .lock()
            .unwrap()
            .insert("pty-b".into(), (b"codex says hi".to_vec(), false));
        let logs = |shell: bool, tab: Option<&str>| {
            handle(
                &req(
                    Command::Logs {
                        task: Some("solo".into()),
                        project: None,
                        shell,
                        tab: tab.map(str::to_string),
                        last_bytes: None,
                        cwd: None,
                    },
                    Some("tok"),
                ),
                &host,
            )
        };
        let Some(ReplyData::Logs(l)) = logs(false, Some("2")).data else {
            panic!("expected logs")
        };
        assert_eq!(l.data, "codex says hi");
        assert_eq!(l.source, "agent");
        // --shell + --tab cannot both target something.
        let err = logs(true, Some("2")).error.unwrap();
        assert_eq!(err.code, ErrorCode::BadRequest);
        // A dead agent tab resolves but has no PTY behind it.
        let err = logs(false, Some("1")).error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("that tab"), "{}", err.message);
    }

    #[test]
    fn attach_tab_resolves_that_tabs_pty() {
        let host = StubHost::default();
        seed_strip(&host);
        host.tab_ptys
            .lock()
            .unwrap()
            .insert(("w3".into(), "tab-b".into()), "pty-b".into());
        host.pty_rings.lock().unwrap().insert("pty-b".into(), (b"backlog".to_vec(), false));
        let attach = |shell: bool, tab: Option<&str>| {
            validate_attach(
                &req(
                    Command::Attach {
                        task: Some("solo".into()),
                        project: None,
                        shell,
                        tab: tab.map(str::to_string),
                        cwd: None,
                    },
                    Some("tok"),
                ),
                &host,
            )
        };
        let Ok((task_id, attachment)) = attach(false, Some("fixing tests")) else {
            panic!("attach with a --tab selector should resolve")
        };
        assert_eq!(task_id, "w3");
        assert_eq!(attachment.pty_id, "pty-b");
        let Err(reply) = attach(true, Some("2")) else {
            panic!("--shell with --tab must be refused")
        };
        assert_eq!(reply.error.unwrap().code, ErrorCode::BadRequest);
    }

    #[test]
    fn status_lists_the_strip_and_degrades_to_unknown() {
        let host = StubHost::default();
        seed_strip(&host);
        let reply = handle(
            &req(
                Command::Status { task: Some("solo".into()), project: None, cwd: None },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Status(s)) = reply.data else { panic!("expected status") };
        let tabs = s.task.tabs.expect("tabs listed");
        assert_eq!(tabs.len(), 3);
        assert_eq!(
            tabs.iter().map(|t| t.index).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "indices are the --tab <n> contract"
        );
        assert_eq!(tabs[1].id, "tab-b");
        assert_eq!(tabs[1].title, "fixing tests");
        assert_eq!(tabs[2].kind, "shell");
        assert!(tabs[0].is_default);

        // No push: UNKNOWN, not an empty strip.
        let silent = StubHost::default();
        let reply = handle(
            &req(
                Command::Status { task: Some("solo".into()), project: None, cwd: None },
                Some("tok"),
            ),
            &silent,
        );
        let Some(ReplyData::Status(s)) = reply.data else { panic!("expected status") };
        assert!(s.task.tabs.is_none(), "a silent webview must not read as zero tabs");
    }

    #[test]
    fn tab_prompt_rides_the_send_route_targeted_at_the_new_tab() {
        let host = StubHost::default();
        host.script_rpc(
            "new_tab",
            Ok(serde_json::json!({ "tabId": "tab-new", "cli": "claude", "title": "claude" })),
        );
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "spawned", "capable": true })),
        );
        let cmd = Command::Tab {
            task: Some("solo".into()),
            project: None,
            kind: proto::TabKind::Agent { id: "claude".into() },
            prompt: Some("run the tests".into()),
            wait: false,
            timeout_ms: None,
            cwd: None,
        };
        let reply = handle(&req(cmd, Some("tok")), &host);
        assert!(reply.ok, "{reply:?}");
        let Some(ReplyData::Tab(t)) = reply.data else { panic!("expected tab") };
        assert_eq!(t.tab_id, "tab-new");
        let p = t.prompt.expect("prompt outcome");
        assert_eq!(p.mode, proto::send_mode::SPAWNED);
        assert!(p.wait.is_none());
        // One recipe: new_tab, then send_prompt AT the id it returned,
        // spawn-pending so the racing PTY is waited for, not refused.
        let calls = host.rpc_calls.lock().unwrap();
        assert_eq!(
            calls.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
            vec!["new_tab", "send_prompt"]
        );
        let (_, params) = &calls[1];
        assert_eq!(params["tabId"], "tab-new");
        assert_eq!(params["spawnPending"], true);
        assert!(params["promptId"].as_str().is_some_and(|p| !p.is_empty()));
    }

    #[test]
    fn tab_prompt_guards_fire_before_any_rpc() {
        let host = StubHost::default();
        let tab = |kind, prompt: Option<&str>, wait| Command::Tab {
            task: Some("solo".into()),
            project: None,
            kind,
            prompt: prompt.map(str::to_string),
            wait,
            timeout_ms: None,
            cwd: None,
        };
        for cmd in [
            tab(proto::TabKind::Shell, Some("hi"), false),
            tab(proto::TabKind::Terminal { id: "term-1".into() }, Some("hi"), false),
            tab(proto::TabKind::Agent { id: "claude".into() }, Some("   "), false),
            tab(proto::TabKind::Agent { id: "claude".into() }, None, true),
        ] {
            let err = handle(&req(cmd, Some("tok")), &host).error.expect("refused");
            assert_eq!(err.code, ErrorCode::BadRequest);
        }
        // A shell task's DEFAULT tab is provably not an agent.
        let mut shell_host = StubHost::default();
        shell_host.tasks.iter_mut().find(|t| t.id == "w3").unwrap().cli = "shell".into();
        let err = handle(
            &req(tab(proto::TabKind::Default, Some("hi"), false), Some("tok")),
            &shell_host,
        )
        .error
        .expect("refused");
        assert_eq!(err.code, ErrorCode::BadRequest);
        assert!(err.message.contains("--agent"), "{}", err.message);
        assert!(host.rpc_calls.lock().unwrap().is_empty());
        assert!(shell_host.rpc_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn tab_prompt_failure_still_names_the_opened_tab() {
        let host = StubHost::default();
        host.script_rpc(
            "new_tab",
            Ok(serde_json::json!({ "tabId": "tab-new", "cli": "claude", "title": "claude" })),
        );
        host.script_rpc("send_prompt", Err("cli_send:not_capable: no settle signal".into()));
        let cmd = Command::Tab {
            task: Some("solo".into()),
            project: None,
            kind: proto::TabKind::Agent { id: "claude".into() },
            prompt: Some("run".into()),
            wait: false,
            timeout_ms: None,
            cwd: None,
        };
        let err = handle(&req(cmd, Some("tok")), &host).error.expect("error");
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("tab-new"), "{}", err.message);
        assert!(err.message.contains("was opened"), "{}", err.message);
    }

    // ── send ─────────────────────────────────────────────────────────

    fn send_cmd(task: &str, wait: bool) -> Command {
        Command::Send {
            task: Some(task.into()),
            project: None,
            prompt: "run the tests".into(),
            resume: false,
            fresh: false,
            wait,
            timeout_ms: None,
            tab: None,
            cwd: None,
        }
    }

    #[test]
    fn send_delivers_to_a_running_agent() {
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "delivered", "capable": true })),
        );
        let reply = handle(&req(send_cmd("solo", false), Some("tok")), &host);
        let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
        assert_eq!(s.task_id, "w3");
        assert_eq!(s.mode, proto::send_mode::DELIVERED);
        assert!(s.capable);
        assert!(s.wait.is_none());
        // The RPC carried the prompt and a minted prompt id.
        let calls = host.rpc_calls.lock().unwrap();
        let (_, params) = calls.iter().find(|(m, _)| m == "send_prompt").unwrap();
        assert_eq!(params["taskId"], "w3");
        assert_eq!(params["prompt"], "run the tests");
        assert!(params["promptId"].as_str().is_some_and(|p| !p.is_empty()));
    }

    #[test]
    fn send_queued_emits_the_queued_event() {
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "queued", "capable": true })),
        );
        let mut sink = VecSink::default();
        let reply = handle_request(&req(send_cmd("solo", false), Some("tok")), &host, &mut sink);
        let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
        assert_eq!(s.mode, proto::send_mode::QUEUED);
        assert!(sink.events.iter().any(|e| e.event == "queued"), "{:?}", sink.events);
    }

    #[test]
    fn send_maps_webview_domain_errors() {
        // The sentinel-prefixed domain failures keep their class; a raw
        // failure is internal.
        for (raw, code, needle) in [
            (
                "cli_send:no_agent: no agent is running in this task. Rerun with --resume or --fresh.",
                ErrorCode::Unsupported,
                "--resume",
            ),
            (
                "cli_send:no_session: this task has no prior agent session; use --fresh.",
                ErrorCode::Unsupported,
                "--fresh",
            ),
            (
                "cli_send:not_capable: work-done detection is disabled for this agent.",
                ErrorCode::Unsupported,
                "work-done",
            ),
            ("webview exploded", ErrorCode::Internal, "webview exploded"),
        ] {
            let host = StubHost::default();
            host.script_rpc("send_prompt", Err(raw.into()));
            let reply = handle(&req(send_cmd("solo", true), Some("tok")), &host);
            let err = reply.error.expect("error");
            assert_eq!(err.code, code, "{raw}");
            assert!(err.message.contains(needle), "{}", err.message);
        }
    }

    #[test]
    fn send_rejects_empty_prompts_and_conflicting_flags() {
        let host = StubHost::default();
        let mut cmd = send_cmd("solo", false);
        if let Command::Send { prompt, .. } = &mut cmd {
            *prompt = "   ".into();
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::BadRequest);
        let mut cmd = send_cmd("solo", false);
        if let Command::Send { resume, fresh, .. } = &mut cmd {
            *resume = true;
            *fresh = true;
        }
        let err = handle(&req(cmd, Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::BadRequest);
        // Nothing reached the webview.
        assert!(host.rpc_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn send_wait_tracks_delivery_then_settles() {
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "delivered", "capable": true })),
        );
        let request = req(send_cmd("solo", true), Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "send_prompt")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            host.reports.resolve(&prompt_id, Ok(()));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            std::thread::sleep(Duration::from_millis(50));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
            let wait = s.wait.expect("wait result");
            assert_eq!(wait.outcome, WaitOutcome::Done);
        });
    }

    #[test]
    fn send_wait_queued_outlives_the_delivery_timeout() {
        // A prompt queued behind a long turn must NOT hit the fixed
        // delivery timeout: the queue itself is the liveness signal.
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "queued", "capable": true })),
        );
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 1, capable: true, tab_states: vec![] },
        )]);
        let request = req(send_cmd("solo", true), Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "send_prompt")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            // Sit past DELIVERY_TIMEOUT (300ms under cfg(test)) with the
            // prompt still queued, then drain: deliver + settle.
            std::thread::sleep(DELIVERY_TIMEOUT + Duration::from_millis(100));
            host.reports.resolve(&prompt_id, Ok(()));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            std::thread::sleep(Duration::from_millis(50));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
            assert_eq!(s.wait.expect("wait result").outcome, WaitOutcome::Done);
        });
    }

    #[test]
    fn send_wait_ignores_a_stale_sibling_done() {
        // The cache is a TASK-level aggregate: a sibling tab's old
        // "done" badge must not read as OUR turn settling the moment
        // delivery confirms. The wait holds until a real working edge
        // (or the idle grace); trusting the stale done was a false
        // instant exit 0.
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "delivered", "capable": true })),
        );
        // Stale state from an earlier turn, pushed before the send.
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 2, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let request = req(send_cmd("solo", true), Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "send_prompt")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            host.reports.resolve(&prompt_id, Ok(()));
            // Well inside the idle grace (200ms under cfg(test)): the
            // stale done must NOT have settled the wait.
            std::thread::sleep(Duration::from_millis(100));
            assert!(!t.is_finished(), "stale sibling done settled the wait");
            // The real turn: working, then done.
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "working".into(), tabs: 2, queued: 0, capable: true, tab_states: vec![] },
            )]);
            std::thread::sleep(Duration::from_millis(30));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 2, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
            assert_eq!(s.wait.expect("wait result").outcome, WaitOutcome::Done);
        });
    }

    #[test]
    fn send_wait_queued_reports_needs_input_when_the_turn_stops_for_it() {
        // The drain only advances on work-done; a turn that ends
        // ASKING for input strands the queue until a human answers.
        // That is exit 3 (the prompt stays queued), never a silent
        // hang to the timeout.
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "queued", "capable": true })),
        );
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "waiting".into(), tabs: 1, queued: 1, capable: true, tab_states: vec![] },
        )]);
        let reply = handle(&req(send_cmd("solo", true), Some("tok")), &host);
        let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
        let wait = s.wait.expect("wait result");
        assert_eq!(wait.outcome, WaitOutcome::NeedsInput);
        assert!(wait.detail.as_deref().unwrap_or("").contains("queued"), "{wait:?}");
    }

    #[test]
    fn wait_errors_when_the_agent_vanishes_mid_wait() {
        // A tab closed (or task stopped) mid-wait flips the state to
        // "inactive". That is not "settled done": exit 0 would send a
        // script off to read a deliverable that was never written.
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let request = req(wait_cmd("solo", None), Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            std::thread::sleep(Duration::from_millis(50));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "inactive".into(), tabs: 0, queued: 0, capable: false, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let err = reply.error.expect("error, not a false done");
            assert_eq!(err.code, ErrorCode::Unsupported);
            assert!(err.message.contains("went away"), "{}", err.message);
        });
    }

    #[test]
    fn send_wait_queued_drain_with_a_late_report_is_not_a_false_exit_9() {
        // The gone-detector's window: the queue drains (delivered!) and
        // the agent sits briefly non-working before the delivery report
        // propagates. A report landing INSIDE the grace must win; the
        // detector exists for lost reports, not slow ones.
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "queued", "capable": true })),
        );
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "waiting".into(), tabs: 1, queued: 1, capable: true, tab_states: vec![] },
        )]);
        let request = req(send_cmd("solo", true), Some("tok"));
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&request, &host));
            let prompt_id = loop {
                if let Some((_, params)) =
                    host.rpc_calls.lock().unwrap().iter().find(|(m, _)| m == "send_prompt")
                {
                    break params["promptId"].as_str().unwrap().to_string();
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            // The human answers; the turn drains our prompt: the queue
            // empties on a non-working agent (the gone-detector arms)...
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            // ...and the report lands a beat later, inside the grace.
            std::thread::sleep(Duration::from_millis(60));
            host.reports.resolve(&prompt_id, Ok(()));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            std::thread::sleep(Duration::from_millis(30));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
            )]);
            let reply = t.join().unwrap();
            let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
            let wait = s.wait.expect("wait result");
            assert_eq!(wait.outcome, WaitOutcome::Done, "{wait:?}");
        });
    }

    #[test]
    fn every_webview_send_error_code_round_trips_to_a_domain_class() {
        // The cli_send: sentinel is produced in TypeScript (cliRpc.ts
        // sendErr) and consumed here (parse_send_error); the code set is
        // hand-maintained on both sides. Extract every code the webview
        // can emit from its SOURCE and assert each maps to a DOMAIN
        // class (anything but Internal); a typo on either side would
        // otherwise degrade silently to Internal and break scripted
        // callers months later.
        let ts = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/cliRpc.ts"),
        )
        .expect("cliRpc.ts readable from the workspace");
        let mut codes = Vec::new();
        let mut rest = ts.as_str();
        while let Some(at) = rest.find("sendErr(") {
            rest = &rest[at + "sendErr(".len()..];
            // Only CALL sites count: the first argument must be a string
            // literal (possibly on the next line). The function's own
            // definition (`sendErr(code: string, ...)`) is skipped.
            let arg = rest.trim_start();
            let Some(lit) = arg.strip_prefix('"') else { continue };
            let Some(q2) = lit.find('"') else { break };
            codes.push(lit[..q2].to_string());
        }
        codes.sort();
        codes.dedup();
        assert!(
            codes.len() >= 4,
            "expected the webview's sentinel codes, found {codes:?} (did sendErr move?)"
        );
        for code in &codes {
            let (mapped, msg) = parse_send_error(&format!("cli_send:{code}: human text"));
            assert_ne!(
                mapped,
                ErrorCode::Internal,
                "webview code {code:?} does not map to a domain class"
            );
            assert_eq!(msg, "human text");
        }
    }

    #[test]
    fn send_wait_detects_a_vanished_queue() {
        // Queued, then the webview reloads: the queue empties with no
        // delivery report and the agent sits idle. That is exit 9, not
        // a false "done" and not a hang.
        let host = StubHost::default();
        host.script_rpc(
            "send_prompt",
            Ok(serde_json::json!({ "mode": "queued", "capable": true })),
        );
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true, tab_states: vec![] },
        )]);
        let reply = handle(&req(send_cmd("solo", true), Some("tok")), &host);
        let Some(ReplyData::Send(s)) = reply.data else { panic!("expected send, got {reply:?}") };
        let wait = s.wait.expect("wait result");
        assert_eq!(wait.outcome, WaitOutcome::NotDelivered);
        assert!(
            wait.detail.as_deref().unwrap_or("").contains("queue"),
            "{wait:?}"
        );
    }

    // ── apply / diff ─────────────────────────────────────────────────

    #[test]
    fn apply_reports_counts_on_success() {
        let host = StubHost::default();
        *host.apply_result.lock().unwrap() =
            Some(Ok(crate::SendDiffResult { tracked_files: 3, untracked_files: 1 }));
        let reply = handle(
            &req(Command::Apply { task: "solo".into(), project: None }, Some("tok")),
            &host,
        );
        let Some(ReplyData::Apply(a)) = reply.data else { panic!("expected apply, got {reply:?}") };
        assert_eq!(a.task_id, "w3");
        assert_eq!(a.tracked_files, 3);
        assert_eq!(a.untracked_files, 1);
    }

    #[test]
    fn apply_failure_modes_have_pinned_classes() {
        // The three documented failure modes each map to their class:
        // main-checkout (unsupported), dirty main (precondition), and
        // a --3way conflict (its own exit-10 code, saying markers are
        // in main NOW).
        let cases: Vec<(crate::SendDiffError, ErrorCode, &str)> = vec![
            (crate::SendDiffError::MainCheckout, ErrorCode::Unsupported, "main checkout"),
            (crate::SendDiffError::DirtyMain, ErrorCode::BadRequest, "uncommitted"),
            (
                crate::SendDiffError::Conflict {
                    main: "/repo/web".into(),
                    detail: "Applied patch to 'x' with conflicts.".into(),
                },
                ErrorCode::ApplyConflict,
                "CONFLICTED",
            ),
        ];
        for (scripted, code, needle) in cases {
            let host = StubHost::default();
            *host.apply_result.lock().unwrap() = Some(Err(scripted));
            let reply = handle(
                &req(Command::Apply { task: "solo".into(), project: None }, Some("tok")),
                &host,
            );
            let err = reply.error.expect("error");
            assert_eq!(err.code, code);
            assert!(err.message.contains(needle), "{}", err.message);
        }
    }

    #[test]
    fn diff_summarizes_and_gates_the_full_patch() {
        let summary = || crate::TaskDiffSummary {
            commits: "abc123 fix\n".into(),
            diff: "--- a/x\n+++ b/x\n".into(),
            files_changed: 2,
            insertions: 10,
            deletions: 3,
            untracked: 1,
        };
        let host = StubHost::default();
        *host.diff_result.lock().unwrap() = Some(Ok(summary()));
        let reply = handle(
            &req(
                Command::Diff { task: Some("solo".into()), project: None, full: false, cwd: None },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Diff(d)) = reply.data else { panic!("expected diff, got {reply:?}") };
        assert_eq!((d.files_changed, d.insertions, d.deletions, d.untracked), (2, 10, 3, 1));
        assert!(d.diff.is_none(), "summary must not carry the patch");
        *host.diff_result.lock().unwrap() = Some(Ok(summary()));
        let reply = handle(
            &req(
                Command::Diff { task: Some("solo".into()), project: None, full: true, cwd: None },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::Diff(d)) = reply.data else { panic!("expected diff, got {reply:?}") };
        assert!(d.diff.as_deref().unwrap_or("").contains("+++"), "{d:?}");
    }

    // ── logs ─────────────────────────────────────────────────────────

    #[test]
    fn logs_reads_the_ring_tail() {
        let host = StubHost::default();
        host.role_ptys
            .lock()
            .unwrap()
            .insert(("w3".into(), "agent".into()), "pty1".into());
        host.pty_rings
            .lock()
            .unwrap()
            .insert("pty1".into(), (b"0123456789".to_vec(), false));
        let logs = |last_bytes| {
            handle(
                &req(
                    Command::Logs {
                        task: Some("solo".into()),
                        project: None,
                        shell: false,
                        tab: None,
                        last_bytes,
                        cwd: None,
                    },
                    Some("tok"),
                ),
                &host,
            )
        };
        let Some(ReplyData::Logs(l)) = logs(None).data else { panic!("expected logs") };
        assert_eq!(l.data, "0123456789");
        assert_eq!(l.source, "agent");
        assert!(!l.truncated);
        let Some(ReplyData::Logs(l)) = logs(Some(4)).data else { panic!("expected logs") };
        assert_eq!(l.data, "6789");
        assert!(l.truncated, "a capped tail must say older output was dropped");
        // No aux terminal registered: --shell is a clean unsupported.
        let reply = handle(
            &req(
                Command::Logs {
                    task: Some("solo".into()),
                    project: None,
                    shell: true,
                    tab: None,
                    last_bytes: None,
                    cwd: None,
                },
                Some("tok"),
            ),
            &host,
        );
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("aux"), "{}", err.message);
    }

    // ── result ───────────────────────────────────────────────────────

    #[test]
    fn claude_project_dir_name_matches_the_live_layout() {
        assert_eq!(
            claude_project_dir_name("/Users/x/dev/external/termic"),
            "-Users-x-dev-external-termic"
        );
        // '.' becomes '-' too (observed: /Users/x/.config/dotfiles).
        assert_eq!(
            claude_project_dir_name("/Users/x/.config/dotfiles"),
            "-Users-x--config-dotfiles"
        );
        assert_eq!(claude_project_dir_name("/a_b c.d"), "-a-b-c-d");
    }

    #[test]
    fn last_assistant_text_reads_the_final_message() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"content":"do it"}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"working on it"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"All tests pass."}]}}"#, "\n",
            r#"{"type":"summary","summary":"irrelevant"}"#, "\n",
        );
        assert_eq!(last_assistant_text(jsonl).as_deref(), Some("All tests pass."));
        // Tool-use-only tail lines are skipped, not returned empty.
        let jsonl = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"the answer"}]}}"#, "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#, "\n",
        );
        assert_eq!(last_assistant_text(jsonl).as_deref(), Some("the answer"));
        assert_eq!(last_assistant_text(r#"{"type":"user"}"#), None);
        assert_eq!(last_assistant_text("not json at all"), None);
    }

    #[test]
    fn result_reads_the_transcript_for_the_task_cwd() {
        let home = tempfile::tempdir().unwrap();
        let mut host = StubHost { home: Some(home.path().to_path_buf()), ..Default::default() };
        // Pin the transcript via the persisted default tab's session id.
        host.tasks[2].persisted_tabs = vec![crate::PersistedTab {
            id: "tab1".into(),
            cli: "claude".into(),
            is_default: true,
            session_id: Some("sess42".into()),
            ..Default::default()
        }];
        let dir = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir_name("/tasks/web/solo"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("sess42.jsonl"),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done, see RESULT.md"}]}}"#,
        )
        .unwrap();
        let reply = handle(
            &req(
                Command::LastResult { task: Some("solo".into()), project: None, cwd: None },
                Some("tok"),
            ),
            &host,
        );
        let Some(ReplyData::LastResult(r)) = reply.data else {
            panic!("expected result, got {reply:?}")
        };
        assert_eq!(r.text, "done, see RESULT.md");
        assert!(r.transcript.ends_with("sess42.jsonl"));
        assert_eq!(r.agent, "claude");
    }

    #[test]
    fn result_refuses_non_claude_agents_and_missing_transcripts() {
        let home = tempfile::tempdir().unwrap();
        let mut host = StubHost { home: Some(home.path().to_path_buf()), ..Default::default() };
        host.tasks[2].cli = "codex".into();
        let cmd = || Command::LastResult { task: Some("solo".into()), project: None, cwd: None };
        let err = handle(&req(cmd(), Some("tok")), &host).error.expect("error");
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("RESULT.md"), "{}", err.message);
        // Claude agent, but no transcript on disk yet.
        let host = StubHost { home: Some(home.path().to_path_buf()), ..Default::default() };
        let err = handle(&req(cmd(), Some("tok")), &host).error.expect("error");
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    // ── attach ───────────────────────────────────────────────────────

    #[test]
    fn attach_without_a_transport_is_refused_in_dispatch() {
        let host = StubHost::default();
        let reply = handle(
            &req(
                Command::Attach { task: Some("solo".into()), project: None, shell: false, tab: None, cwd: None },
                Some("tok"),
            ),
            &host,
        );
        assert_eq!(reply.error.expect("error").code, ErrorCode::BadRequest);
    }

    fn attach_host() -> StubHost {
        let host = StubHost::default();
        host.role_ptys
            .lock()
            .unwrap()
            .insert(("w3".into(), "agent".into()), "pty1".into());
        host.pty_rings
            .lock()
            .unwrap()
            .insert("pty1".into(), (b"SCREEN".to_vec(), false));
        host
    }

    fn attach_req(task: &str) -> Request {
        req(
            Command::Attach { task: Some(task.into()), project: None, shell: false, tab: None, cwd: None },
            Some("tok"),
        )
    }

    /// Read attach lines until a predicate matches, with a deadline.
    fn read_until<R: std::io::BufRead>(
        reader: &mut R,
        mut pred: impl FnMut(&proto::AttachLine) -> bool,
    ) -> proto::AttachLine {
        loop {
            let line = proto::read_line(reader).unwrap().expect("line before EOF");
            let parsed = proto::parse_attach_line(&line).unwrap();
            if pred(&parsed) {
                return parsed;
            }
        }
    }

    #[test]
    fn attach_session_streams_both_ways_and_detaches_cleanly() {
        let (sock, _guard, host) = spawn_server_arc(attach_host());
        let mut stream = UnixStream::connect(&sock).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        proto::write_msg(&mut stream, &attach_req("solo")).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        // ready, then the backlog replay.
        let ready = read_until(&mut reader, |l| matches!(l, proto::AttachLine::Frame(_)));
        let proto::AttachLine::Frame(f) = &ready else { unreachable!() };
        assert_eq!(f.kind, "ready");
        let backlog = read_until(&mut reader, |l| {
            matches!(l, proto::AttachLine::Frame(f) if f.kind == "out")
        });
        let proto::AttachLine::Frame(f) = &backlog else { unreachable!() };
        assert_eq!(f.data_bytes().unwrap(), b"SCREEN");
        // Keystrokes + resize flow into the PTY.
        proto::write_msg(&mut stream, &proto::AttachFrame::input(b"ls\r")).unwrap();
        proto::write_msg(&mut stream, &proto::AttachFrame::resize(50, 180)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while host.pty_inputs.lock().unwrap().is_empty() || host.resizes.lock().unwrap().is_empty()
        {
            assert!(Instant::now() < deadline, "input/resize never reached the host");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(host.pty_inputs.lock().unwrap()[0], ("pty1".to_string(), b"ls\r".to_vec()));
        assert_eq!(host.resizes.lock().unwrap()[0], ("pty1".to_string(), 50, 180));
        // Live output reaches the client.
        host.taps.lock().unwrap().get("pty1").unwrap()[0]
            .send(crate::PtyTapMsg::Data(b"output!".to_vec()))
            .unwrap();
        let out = read_until(&mut reader, |l| {
            matches!(l, proto::AttachLine::Frame(f) if f.kind == "out")
        });
        let proto::AttachLine::Frame(f) = &out else { unreachable!() };
        assert_eq!(f.data_bytes().unwrap(), b"output!");
        // Clean detach ends the session with the final Reply.
        proto::write_msg(&mut stream, &proto::AttachFrame::detach("detached")).unwrap();
        let done = read_until(&mut reader, |l| matches!(l, proto::AttachLine::Done(_)));
        let proto::AttachLine::Done(reply) = done else { unreachable!() };
        let Some(ReplyData::Attach(a)) = reply.data else { panic!("expected attach data") };
        assert_eq!(a.reason, "detached");
    }

    #[test]
    fn attach_session_ends_with_reason_when_the_server_side_closes() {
        // The server side ends sessions IN-BAND: archive posts its
        // reason, and the PTY reader posts "exited" at EOF (channel
        // disconnect alone cannot signal it: the session's own input
        // thread holds a sender clone).
        for reason in ["archived", "exited"] {
            let (sock, _guard, host) = spawn_server_arc(attach_host());
            let mut stream = UnixStream::connect(&sock).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            proto::write_msg(&mut stream, &attach_req("solo")).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            read_until(&mut reader, |l| {
                matches!(l, proto::AttachLine::Frame(f) if f.kind == "ready")
            });
            // Wait for the tap to register, then end it server-side.
            let deadline = Instant::now() + Duration::from_secs(5);
            while host.taps.lock().unwrap().get("pty1").is_none_or(|t| t.is_empty()) {
                assert!(Instant::now() < deadline, "tap never registered");
                std::thread::sleep(Duration::from_millis(5));
            }
            let expected = reason;
            host.taps.lock().unwrap().get("pty1").unwrap()[0]
                .send(crate::PtyTapMsg::Detach(reason.into()))
                .unwrap();
            // The in-band detach frame precedes the final Reply.
            let detach = read_until(&mut reader, |l| {
                matches!(l, proto::AttachLine::Frame(f) if f.kind == "detach")
            });
            let proto::AttachLine::Frame(f) = &detach else { unreachable!() };
            assert_eq!(f.reason.as_deref(), Some(expected));
            let done = read_until(&mut reader, |l| matches!(l, proto::AttachLine::Done(_)));
            let proto::AttachLine::Done(reply) = done else { unreachable!() };
            let Some(ReplyData::Attach(a)) = reply.data else { panic!("expected attach data") };
            assert_eq!(a.reason, expected);
        }
    }

    #[test]
    fn attach_refusal_keeps_the_connection_usable() {
        // No agent PTY registered: the attach errors as a normal Reply
        // and the SAME connection still serves requests.
        let (sock, _guard) = spawn_server(StubHost::default());
        let mut stream = UnixStream::connect(&sock).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        proto::write_msg(&mut stream, &attach_req("solo")).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let reply: Reply = proto::read_msg(&mut reader).unwrap().unwrap();
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("no agent"), "{}", err.message);
        proto::write_msg(&mut stream, &req(Command::Hello, None)).unwrap();
        let reply: Reply = proto::read_msg(&mut reader).unwrap().unwrap();
        assert!(reply.ok);
    }
}
