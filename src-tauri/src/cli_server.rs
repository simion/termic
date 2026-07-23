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

use std::collections::HashMap;
use std::io::BufReader;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{Emitter, Manager};
use termic_proto as proto;
use termic_proto::{Command, ErrorCode, Reply, ReplyData, Request};

use crate::{dlog, Project, Task};

/// Darwin's sockaddr_un.sun_path is 104 bytes including the NUL.
const MAX_SUN_PATH: usize = 103;

/// How long list/status wait for the webview before degrading to
/// work_state = null. Wall-clock, never rAF: occluded windows freeze rAF
/// (docs/automation.md) and for a CLI the window is always backgrounded.
const WORK_STATE_TIMEOUT: Duration = Duration::from_millis(3000);
/// `open` is user-visible feedback; give a busy webview a little longer.
const OPEN_TIMEOUT: Duration = Duration::from_millis(10_000);

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
            Ok(req) => handle_request(&req, host),
            Err(e) => Reply::err("", ErrorCode::BadRequest, format!("malformed request: {e}")),
        };
        if proto::write_msg(&mut writer, &reply).is_err() {
            return;
        }
    }
}

// ───────────────────────────── dispatch ──────────────────────────────

/// Everything the request handler needs from the app, behind a trait so
/// the dispatch + resolution logic is testable without a running Tauri.
pub(crate) trait CliHost: Send + Sync {
    fn cli_enabled(&self) -> bool;
    fn token(&self) -> &str;
    fn app_version(&self) -> String;
    fn projects_tasks(&self) -> (Vec<Project>, Vec<Task>);
    /// Webview work-state query. `None` = the webview did not answer
    /// (busy, still booting); per-task entries may still be missing.
    fn work_states(&self, ids: &[String]) -> Option<HashMap<String, WorkStateInfo>>;
    fn open_task_in_ui(&self, task_id: &str) -> Result<(), String>;
    fn raise_window(&self);
    fn diff_stat(&self, task: &Task) -> Option<proto::DiffStat>;
}

#[derive(Debug, Clone)]
pub(crate) struct WorkStateInfo {
    pub state: String,
    pub tabs: u32,
}

pub(crate) fn handle_request(req: &Request, host: &dyn CliHost) -> Reply {
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
        Command::Status { task, project } => {
            handle_status(&req.id, host, task, project.as_deref())
        }
        Command::Open { task, project, cwd } => {
            handle_open(&req.id, host, task.as_deref(), project.as_deref(), cwd.as_deref())
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

fn handle_status(id: &str, host: &dyn CliHost, task: &str, project: Option<&str>) -> Reply {
    let (projects, tasks) = host.projects_tasks();
    let t = match resolve_by_name(&projects, &tasks, task, project) {
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
        let value = webview_rpc(
            &self.app,
            "work_state",
            serde_json::json!({ "taskIds": ids }),
            WORK_STATE_TIMEOUT,
        )
        .ok()?;
        parse_work_states(&value)
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
}

/// Parse the webview's work-state RPC reply. A single malformed entry is
/// SKIPPED, never fatal: one bad row must not collapse the whole map to
/// `None` and degrade every task to "UI did not answer". `None` only when
/// the top-level shape is wrong (no `states` object).
fn parse_work_states(value: &serde_json::Value) -> Option<HashMap<String, WorkStateInfo>> {
    let states = value.get("states")?.as_object()?;
    let mut out = HashMap::new();
    for (id, v) in states {
        let Some(state) = v.get("state").and_then(|s| s.as_str()) else { continue };
        let tabs = v.get("tabs").and_then(|t| t.as_u64()).unwrap_or(0) as u32;
        out.insert(id.clone(), WorkStateInfo { state: state.to_string(), tabs });
    }
    Some(out)
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

// ───────────────────────────── webview RPC ───────────────────────────

/// Pending RPCs: correlation id -> channel the socket thread blocks on.
fn pending() -> &'static Mutex<HashMap<String, mpsc::SyncSender<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, mpsc::SyncSender<String>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn webview_rpc(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = mpsc::sync_channel::<String>(1);
    pending().lock().unwrap().insert(id.clone(), tx);
    let payload = serde_json::json!({ "id": id, "method": method, "params": params });
    if let Err(e) = app.emit("cli-rpc://request", payload) {
        pending().lock().unwrap().remove(&id);
        return Err(format!("emit failed: {e}"));
    }
    match rx.recv_timeout(timeout) {
        Ok(raw) => {
            let v: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("bad rpc payload: {e}"))?;
            if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
                Ok(v.get("value").cloned().unwrap_or(serde_json::Value::Null))
            } else {
                Err(v
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("webview handler failed")
                    .to_string())
            }
        }
        Err(_) => {
            pending().lock().unwrap().remove(&id);
            Err(format!("the Termic UI did not answer within {}ms", timeout.as_millis()))
        }
    }
}

/// Callback target for the frontend RPC registry (src/lib/cliRpc.ts).
/// Unknown ids are ignored, so nothing can be injected into a request
/// that is not currently waiting.
#[tauri::command]
pub fn cli_rpc_result(id: String, payload: String) -> Result<(), String> {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(payload);
    }
    Ok(())
}

// ───────────────────────────── PATH install ──────────────────────────

/// Where the bundled sidecar lives: next to the app binary
/// (Contents/MacOS/termic-cli in a bundle, target/<profile>/termic-cli
/// in dev, both placed by tauri's externalBin machinery).
fn bundled_cli_path() -> Result<PathBuf, String> {
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

    struct StubHost {
        enabled: bool,
        token: String,
        projects: Vec<Project>,
        tasks: Vec<Task>,
        states: Option<HashMap<String, WorkStateInfo>>,
        opened: Mutex<Vec<String>>,
        raised: Mutex<u32>,
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
            }
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
            (self.projects.clone(), self.tasks.clone())
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
    }

    fn req(cmd: Command, token: Option<&str>) -> Request {
        Request { id: "r".into(), token: token.map(str::to_string), cmd }
    }

    // ── auth / gating ────────────────────────────────────────────────

    #[test]
    fn hello_needs_no_token_and_reports_protocol() {
        let host = StubHost { enabled: false, ..Default::default() };
        let reply = handle_request(&req(Command::Hello, None), &host);
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
        let reply = handle_request(&req(Command::Raise, None), &host);
        assert!(reply.ok);
        assert!(reply.data.is_none());
        assert_eq!(*host.raised.lock().unwrap(), 1);
    }

    #[test]
    fn disabled_cli_gets_the_exact_error_before_any_token_check() {
        let host = StubHost { enabled: false, ..Default::default() };
        let reply = handle_request(&req(Command::List { project: None, quiet: false }, Some("tok")), &host);
        let err = reply.error.expect("error");
        assert_eq!(err.code, ErrorCode::CliDisabled);
        assert_eq!(err.message, proto::CLI_DISABLED_MESSAGE);
    }

    #[test]
    fn bad_or_missing_token_is_refused() {
        let host = StubHost::default();
        for token in [None, Some("wrong")] {
            let reply = handle_request(&req(Command::List { project: None, quiet: false }, token), &host);
            assert_eq!(reply.error.expect("error").code, ErrorCode::Auth);
        }
    }

    // ── verbs ────────────────────────────────────────────────────────

    #[test]
    fn list_returns_tasks_sorted_and_degrades_without_webview() {
        let host = StubHost::default();
        let reply = handle_request(&req(Command::List { project: None, quiet: false }, Some("tok")), &host);
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
        let reply = handle_request(
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
        let reply = handle_request(
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
        let reply = handle_request(&req(Command::List { project: None, quiet: false }, Some("tok")), &host);
        let Some(ReplyData::List(l)) = reply.data else { panic!() };
        let solo = l.tasks.iter().find(|t| t.name == "solo").unwrap();
        assert_eq!(solo.work_state.as_deref(), Some("working"));
        assert_eq!(solo.open_tabs, Some(2));
        // Tasks the webview did not report stay unknown, not "idle".
        let other = l.tasks.iter().find(|t| t.project == "api").unwrap();
        assert!(other.work_state.is_none());
    }

    #[test]
    fn parse_work_states_skips_malformed_entries() {
        // One bad entry must NOT collapse the whole map (which would
        // degrade every task to "UI did not answer").
        let v = serde_json::json!({
            "states": {
                "w1": { "state": "working", "tabs": 2 },
                "w2": { "state": 123 },       // state not a string -> skip
                "w3": { "tabs": 1 },          // no state -> skip
                "w4": { "state": "idle" },    // ok; tabs defaults to 0
            }
        });
        let out = parse_work_states(&v).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out["w1"].state, "working");
        assert_eq!(out["w1"].tabs, 2);
        assert_eq!(out["w4"].state, "idle");
        assert_eq!(out["w4"].tabs, 0);
        assert!(!out.contains_key("w2"));
        assert!(!out.contains_key("w3"));
        // Only a wrong top-level shape (no `states` object) yields None.
        assert!(parse_work_states(&serde_json::json!({})).is_none());
    }

    #[test]
    fn status_resolves_and_reports_depth_fields() {
        let host = StubHost::default();
        let reply = handle_request(
            &req(Command::Status { task: "solo".into(), project: None }, Some("tok")),
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
        let reply = handle_request(
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
        let reply = handle_request(
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
