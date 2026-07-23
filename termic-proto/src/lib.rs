//! Wire protocol for the termic CLI <-> app control socket.
//!
//! Shared by the app's socket server (src-tauri) and the `termic-cli`
//! binary, and by NOTHING else. Deliberately tiny: serde types, the
//! protocol version, NDJSON framing helpers, and the pinned exit-code
//! contract. termic-cli links only this crate, never the app's lib.rs
//! (docs/plans/cli.md), so keep it dependency-light.
//!
//! Compatibility rules (public API once shipped, docs/plans/cli.md):
//! - The hello handshake carries `protocol`; on mismatch the CLI fails
//!   with a clear message instead of mis-parsing.
//! - Reply/payload shapes evolve ADDITIVELY only: new fields may appear,
//!   nothing is renamed or removed. Deserializers must therefore
//!   tolerate unknown fields (serde's default) - never add
//!   `deny_unknown_fields` here.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};

/// Bumped whenever the wire shape changes incompatibly. The unauthenticated
/// hello carries it so a CLI left resolved in an old shell fails with
/// "Termic updated, rerun your command" instead of garbage.
///
/// v2 (Phase 1): `new` / `wait` / `archive` / `project_*` verbs, streamed
/// events, `ErrorBody.data`. A v1 server would reject the new commands as
/// "malformed request", so the version gate turns phase skew into the two
/// clear restart/rerun messages instead.
pub const PROTOCOL_VERSION: u32 = 2;

/// Socket + token file names inside the app's data dir.
pub const SOCKET_FILE: &str = "termic.sock";
pub const TOKEN_FILE: &str = "cli-token";

/// Exact user-facing error for the disabled-CLI path (docs/plans/cli.md,
/// Landing). The server sends it; the CLI prints it verbatim and exits
/// with `exit_code::CLI_DISABLED`.
pub const CLI_DISABLED_MESSAGE: &str =
    "Termic is running but the CLI is disabled, enable it in Settings";

/// Printed by the CLI when the server speaks a NEWER protocol (the app
/// updated under a shell that resolved an old binary; re-executing picks
/// up the new one).
pub const VERSION_MISMATCH_MESSAGE: &str = "Termic updated, rerun your command";

/// Printed when the server speaks an OLDER protocol (a stale Termic is
/// still running while the bundle on disk, and so the CLI symlink, moved
/// on). Rerunning would not help; restarting the app does.
pub const VERSION_STALE_APP_MESSAGE: &str =
    "the running Termic is older than this CLI, restart Termic";

/// Hard cap on a single NDJSON line, both directions. A request or reply
/// larger than this is a bug or an attack, not traffic.
pub const MAX_LINE_BYTES: u64 = 1024 * 1024;

/// The pinned exit-code contract (docs/plans/cli.md, Command surface).
/// Public API once shipped: scripts branch on these numbers. 2 is
/// RESERVED because clap already exits 2 on usage errors; domain codes
/// start at 3 in the spec's order. Phase 1 produces everything except 10,
/// which stays pinned for `apply` (Phase 2).
pub mod exit_code {
    /// Success (for `--wait` verbs: the agent settled done).
    pub const OK: i32 = 0;
    /// Generic error.
    pub const ERROR: i32 = 1;
    /// Usage / parse error. Reserved for clap; never used for domain errors.
    pub const USAGE: i32 = 2;
    /// The agent stopped but is asking for input (attention).
    pub const AGENT_NEEDS_INPUT: i32 = 3;
    /// App not running (under --no-launch) or did not start after launch.
    pub const APP_NOT_RUNNING: i32 = 4;
    /// CLI disabled in Settings.
    pub const CLI_DISABLED: i32 = 5;
    /// Refused: auth or scope (bad/missing token, in-cage caller).
    pub const REFUSED: i32 = 6;
    /// --wait / `wait` --timeout expiry.
    pub const WAIT_TIMEOUT: i32 = 7;
    /// Connection lost mid-command (app quit under us).
    pub const CONNECTION_LOST: i32 = 8;
    /// The prompt was never delivered (webview reload, spawn failure).
    pub const PROMPT_NOT_DELIVERED: i32 = 9;
    /// Apply left main conflicted, later phases.
    pub const APPLY_CONFLICT: i32 = 10;
}

/// How a watched run ended (`wait`, `new --wait`). Ordered by the exit
/// code it maps to; the mapping is part of the public contract.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitOutcome {
    /// The agent settled with a finished turn and an empty message queue.
    Done,
    /// The agent stopped but is asking for input.
    NeedsInput,
    /// --timeout expired first. The task keeps running.
    Timeout,
    /// The prompt never reached the agent (webview reload during the
    /// settle window, spawn failure). The task itself exists.
    NotDelivered,
}

impl WaitOutcome {
    pub fn exit_code(self) -> i32 {
        match self {
            WaitOutcome::Done => exit_code::OK,
            WaitOutcome::NeedsInput => exit_code::AGENT_NEEDS_INPUT,
            WaitOutcome::Timeout => exit_code::WAIT_TIMEOUT,
            WaitOutcome::NotDelivered => exit_code::PROMPT_NOT_DELIVERED,
        }
    }
}

// ───────────────────────────── requests ─────────────────────────────

/// One request line. `token` is absent only for `hello` (the
/// unauthenticated surface); everything else requires the per-boot token
/// read from `<data_dir>/cli-token`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Request {
    /// Client-chosen correlation id, echoed on the reply.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(flatten)]
    pub cmd: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// Unauthenticated: app-is-running + protocol version. Nothing else.
    Hello,
    /// Unauthenticated: bring the running instance's window to front. Used
    /// by a second instance launching on the same data dir (single
    /// instance per data dir) to defer to the one already running. Same
    /// trust tier as hello: it only raises a window, discloses nothing.
    Raise,
    /// Tasks with work-state and diff stat.
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Ids only: the server skips the webview work-state query and the
        /// per-task git diff, which `-q` output does not use. Absent =
        /// false (an older CLI omits it), so the server does the full work.
        #[serde(default)]
        quiet: bool,
    },
    /// One task in depth (cwd-aware when `task` absent).
    Status {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Raise the window and select a task (cwd-aware when `task` absent).
    Open {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Create a task (and optionally inject a prompt). Streamed reply:
    /// setup output events until the agent spawns, a `created` event,
    /// then (under `wait`) state events until the final Reply.
    New {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
        /// "worktree" | "main". Absent = the GUI's remembered mode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// Base branch for a worktree task. Absent = the repo default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
        /// "off" | "monitor" | "enforce" | "enforce-fs". Absent = the
        /// project's sandbox seeds (same fallback the GUI uses).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sandbox: Option<String>,
        #[serde(default)]
        yolo: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Select the new task in the GUI and raise the window.
        #[serde(default)]
        open: bool,
        /// Hold the reply until the injected prompt's turn settles
        /// (delivery-confirmed) or, without a prompt, until quiescent.
        #[serde(default)]
        wait: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        /// The CLI's working directory, for project resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Block until the task's agent is quiescent: settled AND its
    /// message queue is empty. Streamed reply (state + heartbeat
    /// events). cwd-aware when `task` absent.
    Wait {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Archive a task. Live agent PTYs are SIGKILLed first. The
    /// confirmation prompt is the CLI's job (`--yes` skips it); the
    /// server never asks.
    Archive {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
    /// Register a directory as a project (absolute path; the CLI
    /// canonicalizes before sending). `non_git` opts a plain folder in
    /// (the GUI's "add as plain folder" confirmation, as a flag).
    ProjectAdd {
        path: String,
        #[serde(default)]
        non_git: bool,
    },
    /// Registered projects with live-task counts.
    ProjectList,
    /// Unregister a project. Archives and deletes ALL its tasks; the
    /// CLI confirms before sending.
    ProjectRemove { name: String },
}

// ───────────────────────────── replies ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Reply {
    /// Echo of the request id.
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<ReplyData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Reply {
    pub fn ok(id: &str, data: ReplyData) -> Self {
        Reply { id: id.to_string(), ok: true, data: Some(data), error: None }
    }
    pub fn err(id: &str, code: ErrorCode, message: impl Into<String>) -> Self {
        Reply {
            id: id.to_string(),
            ok: false,
            data: None,
            error: Some(ErrorBody { code, message: message.into(), data: None }),
        }
    }
    /// An error carrying machine-readable detail (see `ErrorBody.data`).
    pub fn err_with(
        id: &str,
        code: ErrorCode,
        message: impl Into<String>,
        data: serde_json::Value,
    ) -> Self {
        Reply {
            id: id.to_string(),
            ok: false,
            data: None,
            error: Some(ErrorBody { code, message: message.into(), data: Some(data) }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplyData {
    Hello(HelloData),
    List(ListData),
    Status(StatusData),
    Open(OpenData),
    New(NewData),
    Wait(WaitData),
    Archive(ArchiveData),
    ProjectList(ProjectListData),
    ProjectAdd(ProjectAddData),
    ProjectRemove(ProjectRemoveData),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HelloData {
    pub app: String,
    pub app_version: String,
    pub protocol: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListData {
    pub tasks: Vec<TaskSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusData {
    pub task: TaskStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenData {
    /// The task that was selected, if any resolved. `None` means the
    /// window was raised without selecting a task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskSummary>,
    pub raised: bool,
}

/// How a watched run ended, plus the last observed agent state
/// ("done", "waiting", "idle", ...) when the cache had one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitResult {
    pub outcome: WaitOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Human-readable context for non-success outcomes (why a prompt
    /// counts as never delivered).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewData {
    pub task: TaskSummary,
    /// Present under `wait`: how the watched run ended. Absent when the
    /// reply was sent at spawn (no wait; delivery not confirmed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<WaitResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitData {
    pub task_id: String,
    #[serde(flatten)]
    pub result: WaitResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArchiveData {
    pub task_id: String,
    pub name: String,
    pub project: String,
    /// Live agent PTYs SIGKILLed before the archive ran.
    pub killed_agents: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub root_path: String,
    /// Live (non-archived) task count.
    pub tasks: u32,
    pub default_agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectListData {
    pub projects: Vec<ProjectInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectAddData {
    pub project: ProjectInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectRemoveData {
    pub name: String,
    /// Tasks archived and deleted along with the project.
    pub removed_tasks: u32,
}

/// One task row for `list` (and embedded in `status` / `open`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskSummary {
    pub id: String,
    pub name: String,
    /// Owning project's display name.
    pub project: String,
    /// Agent CLI id (claude / gemini / codex / custom id).
    pub agent: String,
    pub branch: String,
    pub base_branch: String,
    /// Worktree absolute path (the shared checkout for main-checkout tasks).
    pub path: String,
    pub is_main_checkout: bool,
    pub created: String,
    /// Aggregated agent state from the webview: "working", "waiting",
    /// "done", "idle", or "inactive" (the task exists but has no agent tab
    /// open). `None` when the webview could not answer at all (busy, still
    /// booting); consumers must treat `None` as unknown, not idle. New
    /// values may be added (additive contract), so unknown strings should
    /// be passed through, not rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_state: Option<String>,
    /// Live terminal tabs open for this task, when the webview answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_tabs: Option<u32>,
    /// Diff stat vs the base branch. `None` when git had nothing to say
    /// (non-git project, git error).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<DiffStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DiffStat {
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
    /// New untracked files (not folded into files_changed).
    pub untracked: u64,
}

/// `status` detail: the summary plus depth fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskStatus {
    #[serde(flatten)]
    pub summary: TaskSummary,
    /// Sandbox mode: "off", "monitor", "enforce" or "enforce-fs".
    pub sandbox: String,
    /// Persisted agent sessions (durable tabs that resume on relaunch).
    pub sessions: u32,
    /// files_changed + untracked, when the diff stat resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirty_files: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    /// Machine-readable detail for errors the CLI can act on (e.g.
    /// `unregistered_project` carries `{"root": "<repo root>"}` so the
    /// CLI can offer to register it). Additive; absent for most errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Malformed request line.
    BadRequest,
    /// "Enable CLI" is off in Settings.
    CliDisabled,
    /// Missing or wrong token.
    Auth,
    /// Task / project did not resolve.
    NotFound,
    /// A name matched tasks in more than one project.
    Ambiguous,
    /// The cwd is a git repo but not a registered project (`new`).
    /// `data.root` carries the repo root.
    UnregisteredProject,
    /// The target already exists (same-name task in the project).
    Conflict,
    /// The verb cannot work on this target (e.g. `wait` on an agent
    /// with work-done detection disabled, or with no agent open).
    Unsupported,
    /// Server-side failure.
    Internal,
}

impl ErrorCode {
    /// The pinned exit code the CLI uses for this error class.
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCode::CliDisabled => exit_code::CLI_DISABLED,
            ErrorCode::Auth => exit_code::REFUSED,
            ErrorCode::BadRequest
            | ErrorCode::NotFound
            | ErrorCode::Ambiguous
            | ErrorCode::UnregisteredProject
            | ErrorCode::Conflict
            | ErrorCode::Unsupported
            | ErrorCode::Internal => exit_code::ERROR,
        }
    }
}

// ───────────────────────────── stream events ─────────────────────────

/// One streamed line of a `stream: true` reply sequence (`new`, `wait`).
/// Events interleave before exactly one final `Reply`. Deliberately a
/// LOOSE struct (a tag string plus optional fields) rather than a tagged
/// enum: consumers must IGNORE unknown event tags (additive contract),
/// which a serde enum would reject.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamEvent {
    /// Echo of the request id.
    pub id: String,
    /// Always true; discriminates an event line from the final Reply.
    pub stream: bool,
    /// "setup_output" | "created" | "prompt_delivered" | "state" |
    /// "heartbeat". New tags may appear; skip what you don't know.
    pub event: String,
    /// setup_output: raw script output (UTF-8 lossy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// created: the new task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskSummary>,
    /// state: an observed agent work-state transition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

impl StreamEvent {
    fn base(id: &str, event: &str) -> Self {
        StreamEvent {
            id: id.to_string(),
            stream: true,
            event: event.to_string(),
            data: None,
            task: None,
            state: None,
        }
    }
    pub fn setup_output(id: &str, data: String) -> Self {
        StreamEvent { data: Some(data), ..Self::base(id, "setup_output") }
    }
    pub fn created(id: &str, task: TaskSummary) -> Self {
        StreamEvent { task: Some(task), ..Self::base(id, "created") }
    }
    pub fn prompt_delivered(id: &str) -> Self {
        Self::base(id, "prompt_delivered")
    }
    pub fn state(id: &str, state: String) -> Self {
        StreamEvent { state: Some(state), ..Self::base(id, "state") }
    }
    pub fn heartbeat(id: &str) -> Self {
        Self::base(id, "heartbeat")
    }
}

/// One line of a streamed reply, as the CLI reads it.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamLine {
    Event(StreamEvent),
    Done(Reply),
}

/// Decode one line of a (possibly streamed) reply. Lines carrying
/// `"stream": true` are events; anything else is the final Reply.
pub fn parse_stream_line(line: &str) -> Result<StreamLine, String> {
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if v.get("stream").and_then(|s| s.as_bool()) == Some(true) {
        serde_json::from_value::<StreamEvent>(v)
            .map(StreamLine::Event)
            .map_err(|e| e.to_string())
    } else {
        serde_json::from_value::<Reply>(v)
            .map(StreamLine::Done)
            .map_err(|e| e.to_string())
    }
}

// ───────────────────────────── framing ──────────────────────────────

/// Write one message as a single compact-JSON line. Compact encoding is
/// mandated: newline framing dies on pretty-printed output.
pub fn write_msg<W: Write, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let mut line = serde_json::to_vec(msg).map_err(io::Error::other)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

/// Read one NDJSON line, bounded by `MAX_LINE_BYTES`. Returns `Ok(None)`
/// on clean EOF, an error on an oversized or truncated line.
pub fn read_line<R: BufRead>(r: &mut R) -> io::Result<Option<String>> {
    let mut buf: Vec<u8> = Vec::new();
    let n = r.by_ref().take(MAX_LINE_BYTES + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') {
        if buf.len() as u64 > MAX_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "message exceeds the 1 MB line cap",
            ));
        }
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "connection closed mid-message",
        ));
    }
    buf.pop();
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "message is not valid UTF-8"))
}

/// Read + decode one message.
pub fn read_msg<R: BufRead, T: DeserializeOwned>(r: &mut R) -> io::Result<Option<T>> {
    match read_line(r)? {
        None => Ok(None),
        Some(line) => serde_json::from_str(&line)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
    }
}

/// Version-gate helper: the CLI calls this with the server's hello. The
/// message is direction-aware: a NEWER server means rerunning resolves
/// the fresh CLI; an OLDER server means the stale app must restart.
pub fn check_protocol(server_protocol: u32) -> Result<(), String> {
    use std::cmp::Ordering;
    match server_protocol.cmp(&PROTOCOL_VERSION) {
        Ordering::Equal => Ok(()),
        Ordering::Greater => Err(VERSION_MISMATCH_MESSAGE.to_string()),
        Ordering::Less => Err(VERSION_STALE_APP_MESSAGE.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    fn roundtrip<T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(v: &T) {
        let mut buf: Vec<u8> = Vec::new();
        write_msg(&mut buf, v).unwrap();
        assert_eq!(buf.iter().filter(|b| **b == b'\n').count(), 1, "one line per message");
        let mut r = BufReader::new(&buf[..]);
        let back: T = read_msg(&mut r).unwrap().expect("one message");
        assert_eq!(&back, v);
        assert!(read_msg::<_, T>(&mut r).unwrap().is_none(), "clean EOF after");
    }

    #[test]
    fn roundtrip_every_request() {
        for cmd in [
            Command::Hello,
            Command::Raise,
            Command::List { project: None, quiet: false },
            Command::List { project: Some("web".into()), quiet: true },
            Command::Status {
                task: Some("fix-auth".into()),
                project: Some("web".into()),
                cwd: None,
            },
            Command::Status { task: None, project: None, cwd: Some("/tasks/web/x".into()) },
            Command::Open { task: None, project: None, cwd: Some("/tmp/x".into()) },
            Command::Open { task: Some("fix-auth".into()), project: None, cwd: None },
            Command::New {
                name: "fix-auth".into(),
                prompt: Some("fix the login redirect".into()),
                agent: Some("claude".into()),
                mode: Some("worktree".into()),
                base: Some("develop".into()),
                sandbox: Some("enforce-fs".into()),
                yolo: true,
                project: Some("web".into()),
                open: true,
                wait: true,
                timeout_ms: Some(60_000),
                cwd: Some("/repo/web".into()),
            },
            Command::New {
                name: "bare".into(),
                prompt: None,
                agent: None,
                mode: None,
                base: None,
                sandbox: None,
                yolo: false,
                project: None,
                open: false,
                wait: false,
                timeout_ms: None,
                cwd: None,
            },
            Command::Wait {
                task: Some("fix-auth".into()),
                project: None,
                timeout_ms: Some(1000),
                cwd: None,
            },
            Command::Wait { task: None, project: None, timeout_ms: None, cwd: Some("/t".into()) },
            Command::Archive { task: "fix-auth".into(), project: Some("web".into()) },
            Command::ProjectAdd { path: "/repo/web".into(), non_git: false },
            Command::ProjectAdd { path: "/notes/plain".into(), non_git: true },
            Command::ProjectList,
            Command::ProjectRemove { name: "web".into() },
        ] {
            roundtrip(&Request { id: "r1".into(), token: Some("t".into()), cmd });
        }
    }

    #[test]
    fn roundtrip_every_reply() {
        let summary = TaskSummary {
            id: "w1".into(),
            name: "fix-auth".into(),
            project: "web".into(),
            agent: "claude".into(),
            branch: "fix-auth".into(),
            base_branch: "main".into(),
            path: "/Users/x/termic/tasks/web/fix-auth".into(),
            is_main_checkout: false,
            created: "2026-01-01T00:00:00Z".into(),
            work_state: Some("working".into()),
            open_tabs: Some(2),
            diff: Some(DiffStat { files_changed: 3, insertions: 10, deletions: 2, untracked: 1 }),
        };
        for data in [
            ReplyData::Hello(HelloData {
                app: "termic".into(),
                app_version: "1.0.0".into(),
                protocol: PROTOCOL_VERSION,
            }),
            ReplyData::List(ListData { tasks: vec![summary.clone()] }),
            ReplyData::Status(StatusData {
                task: TaskStatus {
                    summary: summary.clone(),
                    sandbox: "enforce".into(),
                    sessions: 2,
                    dirty_files: Some(4),
                },
            }),
            ReplyData::Open(OpenData { task: Some(summary.clone()), raised: true }),
            ReplyData::Open(OpenData { task: None, raised: true }),
            ReplyData::New(NewData { task: summary.clone(), wait: None }),
            ReplyData::New(NewData {
                task: summary.clone(),
                wait: Some(WaitResult {
                    outcome: WaitOutcome::Done,
                    state: Some("done".into()),
                    detail: None,
                }),
            }),
            ReplyData::Wait(WaitData {
                task_id: "w1".into(),
                result: WaitResult { outcome: WaitOutcome::NeedsInput, state: Some("waiting".into()), detail: None },
            }),
            ReplyData::Wait(WaitData {
                task_id: "w1".into(),
                result: WaitResult { outcome: WaitOutcome::Timeout, state: None, detail: Some("x".into()) },
            }),
            ReplyData::Archive(ArchiveData {
                task_id: "w1".into(),
                name: "fix-auth".into(),
                project: "web".into(),
                killed_agents: 2,
            }),
            ReplyData::ProjectList(ProjectListData {
                projects: vec![ProjectInfo {
                    id: "p1".into(),
                    name: "web".into(),
                    root_path: "/repo/web".into(),
                    tasks: 3,
                    default_agent: "claude".into(),
                }],
            }),
            ReplyData::ProjectAdd(ProjectAddData { project: ProjectInfo::default() }),
            ReplyData::ProjectRemove(ProjectRemoveData { name: "web".into(), removed_tasks: 2 }),
        ] {
            roundtrip(&Reply::ok("r1", data));
        }
        roundtrip(&Reply::err("r1", ErrorCode::CliDisabled, CLI_DISABLED_MESSAGE));
        roundtrip(&Reply::err_with(
            "r1",
            ErrorCode::UnregisteredProject,
            "not a registered project",
            serde_json::json!({ "root": "/repo/web" }),
        ));
    }

    #[test]
    fn roundtrip_stream_events_and_line_discrimination() {
        let task = TaskSummary { id: "w1".into(), name: "fix-auth".into(), ..Default::default() };
        for ev in [
            StreamEvent::setup_output("r1", "npm install\n".into()),
            StreamEvent::created("r1", task),
            StreamEvent::prompt_delivered("r1"),
            StreamEvent::state("r1", "working".into()),
            StreamEvent::heartbeat("r1"),
        ] {
            roundtrip(&ev);
            let line = serde_json::to_string(&ev).unwrap();
            match parse_stream_line(&line).unwrap() {
                StreamLine::Event(back) => assert_eq!(back, ev),
                other => panic!("expected event, got {other:?}"),
            }
        }
        // The final Reply of a stream has no `stream` field.
        let reply = Reply::ok(
            "r1",
            ReplyData::Wait(WaitData {
                task_id: "w1".into(),
                result: WaitResult { outcome: WaitOutcome::Done, state: Some("done".into()), detail: None },
            }),
        );
        let line = serde_json::to_string(&reply).unwrap();
        match parse_stream_line(&line).unwrap() {
            StreamLine::Done(back) => assert_eq!(back, reply),
            other => panic!("expected done, got {other:?}"),
        }
    }

    #[test]
    fn unknown_stream_event_tags_still_parse() {
        // Additive contract: a newer server may emit event tags this CLI
        // does not know. They must parse (and be skippable), not error.
        let line = r#"{"id":"r1","stream":true,"event":"totally_new","extra":1}"#;
        match parse_stream_line(line).unwrap() {
            StreamLine::Event(ev) => assert_eq!(ev.event, "totally_new"),
            other => panic!("expected event, got {other:?}"),
        }
    }

    #[test]
    fn wait_outcomes_map_to_pinned_exits() {
        assert_eq!(WaitOutcome::Done.exit_code(), 0);
        assert_eq!(WaitOutcome::NeedsInput.exit_code(), 3);
        assert_eq!(WaitOutcome::Timeout.exit_code(), 7);
        assert_eq!(WaitOutcome::NotDelivered.exit_code(), 9);
    }

    #[test]
    fn unknown_fields_are_tolerated() {
        // Additive evolution: an older CLI must parse a newer server's
        // replies (and vice versa) that carry extra fields.
        let line = r#"{"id":"r1","ok":true,"data":{"kind":"hello","app":"termic","app_version":"9.9.9","protocol":1,"new_field":true},"future":42}"#;
        let reply: Reply = serde_json::from_str(line).unwrap();
        assert!(reply.ok);
        match reply.data {
            Some(ReplyData::Hello(h)) => assert_eq!(h.protocol, 1),
            other => panic!("expected hello, got {other:?}"),
        }
    }

    #[test]
    fn compact_encoding_no_newlines_inside() {
        // A value containing a newline must stay one line on the wire.
        let reply = Reply::err("r1", ErrorCode::Internal, "line1\nline2");
        let mut buf = Vec::new();
        write_msg(&mut buf, &reply).unwrap();
        assert_eq!(buf.iter().filter(|b| **b == b'\n').count(), 1);
        let mut r = BufReader::new(&buf[..]);
        let back: Reply = read_msg(&mut r).unwrap().unwrap();
        assert_eq!(back.error.unwrap().message, "line1\nline2");
    }

    #[test]
    fn oversized_line_is_rejected() {
        let mut big = vec![b'x'; (MAX_LINE_BYTES + 10) as usize];
        big.push(b'\n');
        let mut r = BufReader::new(&big[..]);
        let err = read_line(&mut r).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn truncated_line_is_an_error_not_a_message() {
        let mut r = BufReader::new(&b"{\"id\":\"r1\""[..]);
        let err = read_line(&mut r).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn version_mismatch_messages_are_direction_aware() {
        assert!(check_protocol(PROTOCOL_VERSION).is_ok());
        // Newer server: rerunning resolves the fresh CLI symlink.
        let msg = check_protocol(PROTOCOL_VERSION + 1).unwrap_err();
        assert_eq!(msg, VERSION_MISMATCH_MESSAGE);
        // Older server: the stale running app must restart.
        let msg = check_protocol(PROTOCOL_VERSION - 1).unwrap_err();
        assert_eq!(msg, VERSION_STALE_APP_MESSAGE);
    }

    #[test]
    fn error_codes_map_to_pinned_exits() {
        assert_eq!(ErrorCode::CliDisabled.exit_code(), 5);
        assert_eq!(ErrorCode::Auth.exit_code(), 6);
        assert_eq!(ErrorCode::NotFound.exit_code(), 1);
        assert_eq!(ErrorCode::Ambiguous.exit_code(), 1);
    }

    #[test]
    fn canned_messages_obey_copy_rules() {
        // Repo copy rule: no em dashes anywhere in user-visible text.
        for s in [CLI_DISABLED_MESSAGE, VERSION_MISMATCH_MESSAGE, VERSION_STALE_APP_MESSAGE] {
            assert!(!s.contains('\u{2014}'), "em dash in {s:?}");
        }
    }
}
