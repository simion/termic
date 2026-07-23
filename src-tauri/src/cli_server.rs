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
                std::thread::spawn(move || serve_conn(stream, &*host));
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

fn serve_conn(stream: UnixStream, host: &dyn CliHost) {
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
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => {
                let mut sink = SocketSink { writer: &mut writer };
                handle_request(&req, host, &mut sink)
            }
            Err(e) => Reply::err("", ErrorCode::BadRequest, format!("malformed request: {e}")),
        };
        if proto::write_msg(&mut writer, &reply).is_err() {
            return;
        }
    }
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
}

#[derive(Debug, Clone)]
pub(crate) struct WorkStateInfo {
    pub state: String,
    pub tabs: u32,
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
    if !host.cli_enabled() {
        return Reply::err(&req.id, ErrorCode::CliDisabled, proto::CLI_DISABLED_MESSAGE);
    }
    // Constant-ish compare is not load-bearing against a same-uid local
    // caller; possession of the 0600 file is the credential.
    if req.token.as_deref() != Some(host.token()) {
        return Reply::err(&req.id, ErrorCode::Auth, "invalid or missing CLI token");
    }
    match &req.cmd {
        Command::Hello | Command::Raise => unreachable!("handled above"),
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
        Command::Wait { task, project, timeout_ms, cwd } => {
            handle_wait(&req.id, host, task.as_deref(), project.as_deref(), cwd.as_deref(), *timeout_ms, sink)
        }
        Command::Archive { task, project } => {
            handle_archive(&req.id, host, task, project.as_deref())
        }
        Command::ProjectAdd { path, non_git } => {
            handle_project_add(&req.id, host, path, *non_git)
        }
        Command::ProjectList => handle_project_list(&req.id, host),
        Command::ProjectRemove { name } => handle_project_remove(&req.id, host, name),
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
    Reply::ok(
        id,
        ReplyData::Status(proto::StatusData {
            task: proto::TaskStatus { summary, sandbox, sessions, dirty_files },
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
            prompt_id: prompt_id.as_deref(),
            deadline,
            strict_target: false,
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
    /// Some = track our OWN injected prompt: outcome requires confirmed
    /// delivery plus that turn settling, not just any quiet.
    prompt_id: Option<&'a str>,
    deadline: Option<Instant>,
    /// `wait` verb semantics: refuse an inactive or incapable target on
    /// first sight instead of waiting on a signal that cannot come.
    strict_target: bool,
}

fn outcome_for(state: &str) -> WaitOutcome {
    match state {
        "waiting" => WaitOutcome::NeedsInput,
        _ => WaitOutcome::Done,
    }
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
                    None if started.elapsed() >= DELIVERY_TIMEOUT => {
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
                    if opts.strict_target && last_state.is_none() {
                        // First sight of the target under `wait`.
                        if entry.state == "inactive" {
                            return Err(proto::ErrorBody {
                                code: ErrorCode::Unsupported,
                                message:
                                    "no agent is open in this task (open it in Termic, then rerun)"
                                        .into(),
                                data: None,
                            });
                        }
                        if !entry.capable {
                            return Err(proto::ErrorBody {
                                code: ErrorCode::Unsupported,
                                message: "this task's agent has work-done detection disabled, there is no settle signal to wait on".into(),
                                data: None,
                            });
                        }
                    }
                    if last_state.as_deref() != Some(entry.state.as_str()) {
                        last_state = Some(entry.state.clone());
                        let _ = sink.emit(&StreamEvent::state(opts.req_id, entry.state.clone()));
                    }
                    if entry.state == "working" {
                        seen_working = true;
                    }
                    if entry.state != "inactive" {
                        seen_active = true;
                    }
                    if !awaiting_delivery {
                        let quiescent = entry.state != "working" && entry.queued == 0;
                        // A task the webview reports as inactive never
                        // ran here: only count it as "stopped" once we
                        // saw it alive (or gave the spawn a fair grace).
                        let inactive_ok = entry.state != "inactive"
                            || seen_active
                            || started.elapsed() > IDLE_SETTLE_GRACE;
                        let own_prompt_settled = opts.prompt_id.is_none()
                            || seen_working
                            || entry.state == "done"
                            || entry.state == "waiting"
                            || delivered_at.is_some_and(|t| t.elapsed() > IDLE_SETTLE_GRACE);
                        if quiescent && inactive_ok && own_prompt_settled {
                            return Ok(proto::WaitResult {
                                outcome: outcome_for(&entry.state),
                                state: Some(entry.state.clone()),
                                detail: None,
                            });
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

fn handle_wait(
    id: &str,
    host: &dyn CliHost,
    task: Option<&str>,
    project: Option<&str>,
    cwd: Option<&str>,
    timeout_ms: Option<u64>,
    sink: &mut dyn EventSink,
) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_task_arg(&projects, &tasks, task, project, cwd) {
        Ok(t) => t,
        Err(e) => return Reply { id: id.into(), ok: false, data: None, error: Some(e) },
    };
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let watch = watch_agent(
        host,
        WatchOpts {
            req_id: id,
            task_id: &t.id,
            prompt_id: None,
            deadline,
            strict_target: true,
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
        if let Some(win) = self.app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
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
    fn agent_cache(&self) -> &AgentCache {
        global_agent_cache()
    }
    fn prompt_reports(&self) -> &PromptReports {
        global_prompt_reports()
    }
    fn kill_task_ptys(&self, task_id: &str) -> u32 {
        let manager = self.app.state::<crate::PtyManager>();
        crate::kill_task_ptys(&manager, task_id) as u32
    }
    fn git_toplevel(&self, cwd: &str) -> Option<String> {
        let out = crate::git(&["rev-parse", "--show-toplevel"], Path::new(cwd)).ok()?;
        let root = out.trim();
        (!root.is_empty()).then(|| root.to_string())
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
        /// Flat side-effect log ("kill:<id>", "rpc:<method>") so tests
        /// can assert ORDER across kinds (archive must kill first).
        ops: Mutex<Vec<String>>,
        cache: AgentCache,
        reports: PromptReports,
        git_root: Option<String>,
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
            TaskAgentState { state: "working".into(), tabs: 2, queued: 1, capable: true },
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
                TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true },
            )]);
            std::thread::sleep(Duration::from_millis(50));
            host.push_states(&[(
                "nw1",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true },
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
                    TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true },
        )]);
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&req(wait_cmd("solo", None), Some("tok")), &host));
            std::thread::sleep(Duration::from_millis(60));
            host.push_states(&[]); // the reload's empty boot push
            std::thread::sleep(Duration::from_millis(60));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
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
        assert_eq!(*host.ops.lock().unwrap(), vec!["kill:w3", "rpc:archive_task"]);
    }

    #[test]
    fn new_wait_without_delivery_report_is_not_delivered() {
        // A webview reload during the settle window drops the injection
        // silently; the PTY survives idle. Exit 0 must not happen.
        let host = StubHost::default();
        host.script_rpc("new_task", Ok(serde_json::json!({ "taskId": "nw1" })));
        host.push_states(&[(
            "nw1",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true },
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
        Command::Wait { task: Some(task.into()), project: None, timeout_ms, cwd: None }
    }

    #[test]
    fn wait_returns_immediately_when_quiescent() {
        let host = StubHost::default();
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
        )]);
        let reply = handle(&req(wait_cmd("solo", None), Some("tok")), &host);
        let Some(ReplyData::Wait(w)) = reply.data else { panic!("expected wait, got {reply:?}") };
        assert_eq!(w.task_id, "w3");
        assert_eq!(w.result.outcome, WaitOutcome::Done);
        // An agent parked on a question maps to needs-input (exit 3).
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "waiting".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "inactive".into(), tabs: 0, queued: 0, capable: false },
        )]);
        let err = handle(&req(wait_cmd("solo", None), Some("tok")), &host).error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("no agent is open"), "{}", err.message);
        host.push_states(&[(
            "w3",
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: false },
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
            TaskAgentState { state: "done".into(), tabs: 1, queued: 1, capable: true },
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
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true },
        )]);
        std::thread::scope(|scope| {
            let t = scope.spawn(|| handle(&req(wait_cmd("solo", None), Some("tok")), &host));
            std::thread::sleep(Duration::from_millis(60));
            host.push_states(&[(
                "w3",
                TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "idle".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "working".into(), tabs: 1, queued: 0, capable: true },
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
        // Order is the point: SIGKILL strictly before the archive RPC
        // (removing a worktree under a live agent is undefined).
        assert_eq!(*host.ops.lock().unwrap(), vec!["kill:w3", "rpc:archive_task"]);
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
                TaskAgentState { state: "working".into(), tabs: 2, queued: 0, capable: true },
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
        assert_eq!(*ops, vec!["kill:w1", "kill:w3", "rpc:project_remove"]);
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
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
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
            TaskAgentState { state: "done".into(), tabs: 1, queued: 0, capable: true },
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
                Command::Wait { task: None, project: None, timeout_ms: None, cwd: Some("/tasks/web/solo".into()) },
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
}
