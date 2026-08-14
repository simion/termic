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
///
/// v3 (Phase 2): `send` / `apply` / `diff` / `logs` / `result` verbs and
/// the bidirectional `attach` session (AttachFrame lines after the
/// accepted request). Exit codes 10 (apply conflict) and 11 (attach
/// target closed) become live.
///
/// v4 (Phase 3): the `quit` verb. v5: `tab` / `agents` (GH #138 part 1).
///
/// v6 (GH #138 part 2): `tab` selectors (`tab` field on send / wait /
/// attach / logs), `TaskStatus.tabs`, and `tab -p` (prompt fields on the
/// `tab` command, `TabData.prompt`).
///
/// v7: the `rename` verb (GH #153).
///
/// v8 (GH #169): attach existing work. `new` gains `from` (adopt a
/// registered worktree instead of creating one) and `resume` (seed the
/// agent's session id); `tab` gains `resume`.
///
/// v9 (Phase 4): prompt library access. The `prompts` verb (list, or
/// resolve one selector to its body) and `prompt_ref` on `new` / `send`
/// / `tab` (the `-P/--library` selector; the server resolves it against
/// the live prompt store and composes the body with any literal prompt).
/// `send.prompt` becomes optional on the wire (`prompt_ref` can stand
/// alone).
///
/// v10 (GH #185): the `tab_close` verb. Additive in shape, but a v9
/// server rejects the new `cmd` value as a malformed request, which is
/// exactly the skew the version gate turns into "Termic updated, rerun
/// your command". `AttachData.reason` gains "closed".
///
/// v11 (GH #192): the `open_url` verb, used ONLY by a second instance
/// handing its `termic://` deep link to the instance that already owns
/// the data dir before exiting. termic-cli never sends it, so the bump
/// is pure bookkeeping for the shared wire shape.
pub const PROTOCOL_VERSION: u32 = 11;

/// serde default for `QuitData::running`.
pub(crate) fn default_true() -> bool { true }

/// serde skip helper for default-false flags.
pub(crate) fn is_false(b: &bool) -> bool { !*b }

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
    /// `apply` left conflict markers in the main checkout (git apply
    /// --3way fell back to a conflicted merge; resolve or reset there).
    pub const APPLY_CONFLICT: i32 = 10;
    /// An attach session ended because the target went away underneath
    /// it (task archived, agent exited), as opposed to a clean detach (0).
    pub const ATTACH_CLOSED: i32 = 11;
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
    /// Unauthenticated: hand a `termic://` deep link to the instance that
    /// already owns this data dir. Sent by the second instance right
    /// before it exits (single instance per data dir), so a link that
    /// launched a fresh process still lands in the running window instead
    /// of dying with it. Unauthenticated for the same reason as `raise`:
    /// the preflight connection has no token, and the URL can do no more
    /// than the browser-clicked link it came from - it pre-fills the New
    /// Task dialog, which a human still has to confirm.
    OpenUrl { url: String },
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
        /// Prompt-library selector (`-P/--library`, v9): an exact prompt
        /// id (`builtin:review`, a custom prompt's UUID) or a
        /// case-insensitive exact title. The server resolves it against
        /// the live prompt store BEFORE the task is created and delivers
        /// the body; with `prompt` too, the body, a blank line, then the
        /// text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
        /// "worktree" | "main". Absent = the GUI's remembered mode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// Base branch for a worktree task. Absent = the repo default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
        /// Adopt this EXISTING registered worktree instead of creating
        /// one (GH #169). Absolute path (the CLI canonicalizes). Mutually
        /// exclusive with mode/base; no setup script runs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        /// Session id to resume in the agent's first spawn (GH #169).
        /// The agent must declare `resume_id_args`. Valid with or
        /// without `from`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<String>,
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
        /// Wait on ONE tab instead of the whole task: a tab id (as
        /// printed by `termic tab`), a 1-based strip index, or a title.
        /// Absent = task-level quiescence, the pre-v6 meaning.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// List the agent registry: what `--agent` / `--terminal` accept.
    /// Answers "what can I pass?", which was otherwise only discoverable
    /// by guessing wrong and reading the error (GH #138).
    Agents,
    /// The prompt library (Phase 4): what `-P/--library` accepts. The
    /// library is per-user and editable, so static help cannot carry it
    /// (the `agents` argument). Resolution happens in the webview's live
    /// prompt store at request time, so overrides, renames and deletions
    /// are always current.
    Prompts {
        /// Absent: list the library (ids, titles, flags; no bodies).
        /// Present: resolve ONE prompt (exact id, then case-insensitive
        /// exact title) and include its body (`prompts show`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
    },
    /// Open a tab INSIDE a running task: the GUI's "+" menu as a verb.
    /// The KIND is explicit rather than a string, because the kinds differ
    /// in sandbox, resume and YOLO behaviour and a typo must not land the
    /// caller in the wrong semantics (docs/plans/cli.md, GH #138).
    Tab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        kind: TabKind,
        /// Deliver this prompt into the tab just opened (agent kinds
        /// only), through the same confirmed `send_prompt` route `send`
        /// uses; the tab's id is the target, so nothing races a second
        /// tab opening meanwhile. Streamed reply when present.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        /// Prompt-library selector (`-P/--library`, v9); see `New`. The
        /// server resolves it BEFORE the tab is opened (fail fast).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_ref: Option<String>,
        /// With `prompt`: hold the reply until that prompt's turn
        /// settles, the same contract as `send --wait`.
        #[serde(default)]
        wait: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        /// Session id the new tab's agent resumes (GH #169). Agent kinds
        /// only; the agent must declare `resume_id_args`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Close ONE tab of a running task: the GUI's × as a verb (GH #185).
    /// Anything that opens tabs programmatically needs a way to clean
    /// them up; task-level `archive` is the wrong hammer, it takes every
    /// tab including the caller's own session.
    TabClose {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Tab selector (id, 1-based strip index, or title/cli), resolved
        /// by the same rules `send`/`wait`/`attach`/`logs` use. Required:
        /// there is no "the obvious tab" to close by default, and
        /// guessing one would be the destructive direction.
        tab: String,
        /// Permit closing the DEFAULT tab, the one every unqualified
        /// `send`/`wait`/`attach` resolves to. Refused without this even
        /// when its agent already exited, because the refusal is about
        /// what other scripts are talking to, not about liveness.
        #[serde(default)]
        yes: bool,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Shut the app down: every PTY, script process group, in-flight grep
    /// and spotlight session goes with it (the same teardown Cmd-Q does).
    /// Authenticated, because it is the most destructive thing the socket
    /// can do. The confirmation prompt is the CLI's job (`--yes` skips it);
    /// the server never asks.
    Quit {
        /// Actually quit. Defaults to FALSE, i.e. preview only.
        ///
        /// Deliberately phrased so the fail-open direction is the safe one.
        /// The protocol tolerates unknown fields by design, so `previw: true`
        /// or any future rename would silently take the default - and for the
        /// most destructive verb on the socket that default must not be
        /// "tear the app down".
        #[serde(default)]
        commit: bool,
    },
    /// Archive a task. Live agent PTYs are SIGKILLed first. The
    /// confirmation prompt is the CLI's job (`--yes` skips it); the
    /// server never asks.
    Archive {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
    /// Rename a task: the sidebar label ONLY. The branch and worktree
    /// directory keep their creation-time names (they are pushed /
    /// referenced by live PTY cwds; moving them is not this verb's job).
    /// cwd-aware when `task` absent, like `open`.
    Rename {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// The new display name. Must be non-empty after trimming; a
        /// same-project live duplicate is a Conflict.
        name: String,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
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
    /// Prompt the task's RUNNING agent. Busy work-done-capable agents
    /// get the prompt QUEUED (delivered when the current turn ends);
    /// opted-out agents get it typed immediately. With no agent
    /// running, `resume` restores the last session and `fresh` spawns
    /// a new agent without context; neither set is an error naming
    /// both outs. Streamed reply under `wait` (state + heartbeat
    /// events), single reply otherwise. cwd-aware when `task` absent.
    Send {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// The literal prompt text. Defaulted (v9) so `prompt_ref` can
        /// stand alone; the server rejects the request when BOTH are
        /// empty/absent.
        #[serde(default)]
        prompt: String,
        /// Prompt-library selector (`-P/--library`, v9); see `New`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_ref: Option<String>,
        /// No agent running: restore the last session, then deliver.
        #[serde(default)]
        resume: bool,
        /// No agent running: spawn a fresh agent (no context), then deliver.
        #[serde(default)]
        fresh: bool,
        /// Hold the reply until the prompt's turn settles (delivery
        /// confirmed), the same contract as `new --wait`.
        #[serde(default)]
        wait: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        /// Deliver to ONE tab instead of the default agent tab: a tab id
        /// (as printed by `termic tab`), a 1-based strip index, or a
        /// title. `resume`/`fresh` are refused alongside it (they spawn,
        /// a selector targets something already open).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// The GUI's "send diff to main": bring the worktree's cumulative
    /// diff into the project's main checkout as uncommitted changes.
    /// Explicit task name only (it writes into the user's checkout);
    /// the CLI confirms before sending.
    Apply {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
    /// Diff summary vs the base branch (counts + commits; the full
    /// patch only when `full`). cwd-aware when `task` absent.
    Diff {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Include the full unified diff text in the reply.
        #[serde(default)]
        full: bool,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Recent terminal output of the task's agent PTY (or the aux
    /// terminal under `shell`), from the server-side ring buffer.
    /// cwd-aware when `task` absent.
    Logs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Target the task's aux terminal instead of the agent.
        #[serde(default)]
        shell: bool,
        /// Target ONE agent tab: a tab id (as printed by `termic tab`),
        /// a 1-based strip index, or a title. Mutually exclusive with
        /// `shell` (the aux terminal is not in the strip).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        /// Cap the returned tail to this many bytes (absent = the whole
        /// retained buffer).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_bytes: Option<u64>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// The agent's last message, read from its session transcript on
    /// disk (agent-specific; the RESULT.md file drop stays the
    /// agent-agnostic floor). cwd-aware when `task` absent.
    #[serde(rename = "result")]
    LastResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Attach a real TTY to the task's agent PTY (or the aux terminal
    /// under `shell`). On acceptance the connection LEAVES the
    /// request/reply protocol: the server sends `AttachFrame` lines
    /// (`ready`, backlog + live `out`, `detach`) and reads `AttachFrame`
    /// lines from the client (`in`, `resize`, `detach`) until one final
    /// `Reply` closes the session. cwd-aware when `task` absent.
    Attach {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Target the task's aux terminal instead of the agent.
        #[serde(default)]
        shell: bool,
        /// Target ONE agent tab: a tab id (as printed by `termic tab`),
        /// a 1-based strip index, or a title. Mutually exclusive with
        /// `shell` (the aux terminal is not in the strip).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
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

/// What `termic tab` opens. Separate variants rather than one string:
/// an agent tab inherits the task's sandbox pin, while terminal and shell
/// tabs are uncaged exactly as the GUI's are, so a mistyped kind must not
/// silently downgrade a caged agent into an uncaged shell.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "tab", rename_all = "snake_case")]
pub enum TabKind {
    /// A `kind: "agent"` registry entry. Rejected if unknown, disabled or
    /// not detected on PATH: the GUI hides those, but a CLI caller has no
    /// menu to look at and must be told why.
    Agent { id: String },
    /// A `kind: "terminal"` custom entry (#27). Never resumes, no YOLO args.
    Terminal { id: String },
    /// A plain login shell tab in the task's strip, uncaged like the GUI's.
    /// NOT the aux terminal: `attach --shell` / `logs --shell` resolve the
    /// separate aux pane (role kind "aux"), which this does not create.
    Shell,
    /// Another tab of whatever the task already runs. What the `+` button
    /// does before you pick anything.
    Default,
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
    Agents(AgentsData),
    Prompts(PromptsData),
    Tab(TabData),
    TabClose(TabCloseData),
    Quit(QuitData),
    Archive(ArchiveData),
    Rename(RenameData),
    ProjectList(ProjectListData),
    ProjectAdd(ProjectAddData),
    ProjectRemove(ProjectRemoveData),
    Send(SendData),
    Apply(ApplyData),
    Diff(DiffData),
    Logs(LogsData),
    #[serde(rename = "result")]
    LastResult(ResultData),
    Attach(AttachData),
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
pub struct AgentsData {
    pub agents: Vec<AgentEntry>,
}

/// One registry entry, as the CLI sees it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentEntry {
    /// What you pass to `--agent` or `--terminal`.
    pub id: String,
    /// "agent" or "terminal". Decides WHICH flag takes it, and with it the
    /// sandbox behaviour, so it is not cosmetic.
    pub kind: String,
    /// Enabled in Settings. A disabled entry is rejected by `tab`.
    pub enabled: bool,
    /// Found on PATH. `None` when detection has not run yet, which is not
    /// the same as "not installed" and must not be rendered as such.
    #[serde(default)]
    pub installed: Option<bool>,
    /// Usable RIGHT NOW: enabled, and installed where that is known. The
    /// single field a caller should branch on, so the enabled/installed
    /// rule cannot drift between the CLI and the tab validator.
    pub usable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptsData {
    /// The whole library in display order for a list, exactly one entry
    /// for a resolved selector.
    pub prompts: Vec<PromptEntry>,
}

/// One prompt-library entry, as the CLI sees it (Phase 4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptEntry {
    /// The stable identity every selector resolves to: `builtin:<slug>`
    /// for shipped prompts, a UUID for custom ones. Pin THIS in scripts;
    /// titles are user-editable conveniences.
    pub id: String,
    pub title: String,
    pub builtin: bool,
    /// Shown in the GUI dropdown. A DISABLED prompt is still fireable by
    /// explicit selector: disabled means hidden, not dead.
    pub enabled: bool,
    /// Built-in only: the user edited it away from the shipped text.
    pub modified: bool,
    /// The prompt body. Present only for a resolved selector
    /// (`prompts show`); the list omits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// True when `body` was trimmed to fit the reply-line cap. The body
    /// itself carries NO marker text (a marker would ride a
    /// `show | send -p -` pipe into an agent as instructions); the CLI
    /// warns on stderr instead.
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TabData {
    /// The task the tab was opened in.
    pub task_id: String,
    /// The tab's stable store id. Printed for every kind so a script can
    /// record what it made, and it never changes the way an index or an
    /// agent-authored title does.
    ///
    /// Resolution caveat for part 2: only AGENT tabs carry a `PtyRole`
    /// today, so only those are addressable by the RUST-NATIVE path
    /// (`find_role_pty`, which `attach` and `logs` use). Anything routed
    /// through the webview sees every tab, since the store holds them all.
    /// Giving shell and custom-terminal tabs a role would close that gap
    /// and is NOT a sandbox change: the cage keys on `pty_spawn`'s separate
    /// `task_id` argument, not on `role`.
    pub tab_id: String,
    /// Resolved cli id ("claude", "shell", a custom terminal's id).
    pub cli: String,
    /// Display title the GUI gave it.
    pub title: String,
    /// Present when a prompt rode along (`tab -p`): how it reached the
    /// new tab. Delivery goes through `send_prompt` targeted at this
    /// tab's id, the same confirmed route `send --tab` uses; a second
    /// injection recipe would reintroduce the silently-dropped prompt
    /// Phase 1 exists to prevent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<PromptOutcome>,
}

/// How a rode-along prompt (`tab -p`) reached its target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptOutcome {
    /// See `send_mode`.
    pub mode: String,
    /// False when the target agent has work-done detection disabled
    /// (prompt typed immediately, no settle signal; `--wait` refuses).
    pub capable: bool,
    /// Present under `wait`: how the watched turn ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<WaitResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TabCloseData {
    pub task_id: String,
    /// The tab that was closed, echoed back as its stable id: the caller
    /// may have named it by index or title, and only the id identifies
    /// what actually went.
    pub tab_id: String,
    /// Resolved cli id of the closed tab ("claude", "codex", "shell",
    /// a custom terminal's id).
    pub cli: String,
    /// Display title the GUI had given it.
    pub title: String,
    /// "agent" | "shell" | "terminal" | "run". Unlike every other
    /// tab-targeting verb, `tab close` reaches all of them: closing is
    /// not driving, and the CLI can open shell tabs, so it has to be
    /// able to clean them up.
    ///
    /// NOT named `kind`, which every sibling payload uses, because
    /// `ReplyData` is an internally-tagged enum whose tag IS `kind`:
    /// serde flattens the two into one key and the reply fails to parse
    /// with "duplicate field `kind`". `roundtrip_every_reply` catches it.
    #[serde(default)]
    pub tab_kind: String,
    /// True when this was the task's DEFAULT tab (closed under `yes`).
    /// Load-bearing for the caller, because the default tab is DURABLE:
    /// closing it ends the agent for now, and the task brings it back on
    /// reopen. A secondary tab is forgotten instead, recoverable only
    /// from the GUI's Resume menu.
    #[serde(default)]
    pub was_default: bool,
    /// A live process was stopped by this close (false when the tab's
    /// agent or shell had already exited).
    ///
    /// Named for the PTY, not the agent, because this verb closes shell
    /// and custom-terminal tabs too. How it dies differs by kind, and
    /// only agent tabs get the polite version: they carry a `PtyRole`,
    /// so the server can find and SIGTERM them by tab id and let the
    /// agent flush its transcript. Nothing else carries one, so those
    /// die the way the GUI's close button kills them, which costs
    /// nothing since they have no transcript to lose.
    #[serde(default)]
    pub killed_pty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuitData {
    /// Always true from the server (it answered, so it was running). The
    /// not-running case is synthesised by the CLI with `running: false`, so
    /// a script can branch on this one field either way.
    #[serde(default = "crate::default_true")]
    pub running: bool,
    /// Tasks with at least one live agent PTY.
    #[serde(default)]
    pub tasks_with_agents: u32,
    /// Live agent PTYs that will die (or died) with the app.
    #[serde(default)]
    pub live_agents: u32,
    /// TASKS the webview reports as working, not agents: the work-state
    /// cache aggregates per task, so two busy tabs in one task count once.
    /// Named for what it counts rather than what a caller might hope.
    /// Clamped to `tasks_with_agents`, because a lagging cache can otherwise
    /// name a task whose agent PTY is already gone.
    ///
    /// `None` means UNKNOWN, not zero: the cache went stale, so the webview
    /// stopped reporting. The distinction is load-bearing for a confirmation
    /// prompt - collapsing it into 0 would render "nothing is working" and
    /// "I cannot tell" identically, and understating what is about to die is
    /// the wrong direction for a safety question. `live_agents` is ground
    /// truth either way; only this field can go dark.
    #[serde(default)]
    pub working_tasks: Option<u32>,
    /// False for `preview`, true when the app is on its way out.
    pub quitting: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArchiveData {
    pub task_id: String,
    pub name: String,
    pub project: String,
    /// Live agent PTYs SIGKILLed before the archive ran.
    pub killed_agents: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RenameData {
    /// The task AFTER the rename, re-read from disk (name is the new one).
    pub task: TaskSummary,
    /// What the task was called before, for "renamed X to Y" output.
    pub old_name: String,
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
    /// The task's terminal tabs in strip order (GH #138 part 2), when
    /// the webview's per-tab snapshot answered. `None` means UNKNOWN
    /// (webview booting or stale), not "no tabs": consumers must not
    /// render it as an empty strip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<TabStatus>>,
}

/// One tab row for `status` (GH #138 part 2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TabStatus {
    /// Stable tab id: the identity every `--tab` selector resolves to.
    pub id: String,
    /// 1-based row number in THIS list, which is the task's terminal
    /// tabs in strip order (editor/diff tabs are not listed and do not
    /// shift it). `--tab <n>` means exactly this number.
    pub index: u32,
    /// "agent" | "shell" | "terminal" (custom, #27) | "run" (script
    /// tabs). Additive: skip unknown kinds. Only agent tabs are
    /// addressable by send/wait/attach/logs; the rest are write-only
    /// from the CLI by design (docs/plans/cli.md, GH #138).
    pub kind: String,
    /// cli id ("claude", "shell", a custom terminal's id).
    pub agent: String,
    /// Display title, as the GUI renders it (agent-authored titles
    /// change mid-turn; the id does not).
    pub title: String,
    /// Per-tab work state ("working", "waiting", "done", "idle").
    /// `None` for tabs with no settle signal (shell, custom terminal,
    /// work-done-incapable agents). Additive: pass unknown strings
    /// through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// The tab send/wait/attach/logs resolve to when `--tab` is absent.
    pub is_default: bool,
    /// A PTY is live in this tab right now (vs a durable tab awaiting
    /// restore).
    pub live: bool,
    /// Prompts queued behind the current turn (send's queue-on-busy).
    pub queued: u32,
}

/// How `send` got the prompt to the agent. Additive: new modes may
/// appear, consumers must pass unknown strings through.
pub mod send_mode {
    /// Typed into a running agent (delivery already confirmed).
    pub const DELIVERED: &str = "delivered";
    /// The agent was mid-turn: queued, delivers when the turn ends.
    pub const QUEUED: &str = "queued";
    /// No agent was running: one was spawned (`--resume`/`--fresh`);
    /// injection continues app-side, confirmed only under `wait`.
    pub const SPAWNED: &str = "spawned";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SendData {
    pub task_id: String,
    /// See `send_mode`.
    pub mode: String,
    /// False when the target agent has work-done detection disabled:
    /// the prompt was typed immediately and there is no settle signal
    /// (the CLI prints a warning; `wait` refuses such agents).
    pub capable: bool,
    /// Present under `wait`: how the watched turn ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<WaitResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApplyData {
    pub task_id: String,
    pub tracked_files: u64,
    pub untracked_files: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiffData {
    pub task_id: String,
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
    /// New untracked files (folded into files_changed, unlike `list`'s
    /// DiffStat: this mirrors the GUI diff pane's counting).
    pub untracked: u64,
    /// `git log --oneline base..HEAD`, one commit per line.
    pub commits: String,
    /// The full unified diff, only when the request asked for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogsData {
    pub task_id: String,
    /// "agent" or "aux", whichever PTY the tail came from.
    pub source: String,
    /// The retained tail, UTF-8 lossy (ANSI escapes intact).
    pub data: String,
    /// True when the ring had already dropped older output.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResultData {
    pub task_id: String,
    /// Agent CLI id the transcript belongs to.
    pub agent: String,
    /// Absolute path of the transcript the message was read from.
    pub transcript: String,
    /// The agent's last message text.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachData {
    pub task_id: String,
    /// Why the session ended: "detached" (client asked), "exited"
    /// (the PTY closed), "archived" (the task was archived under us),
    /// "closed" (the tab was closed under us, `tab close`), "lagged"
    /// (the session fell too far behind the output stream and was
    /// force-detached). Additive: skip unknown reasons.
    pub reason: String,
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
    /// `apply` left conflict markers in the main checkout (v3).
    ApplyConflict,
    /// Server-side failure.
    Internal,
}

impl ErrorCode {
    /// The pinned exit code the CLI uses for this error class.
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCode::CliDisabled => exit_code::CLI_DISABLED,
            ErrorCode::Auth => exit_code::REFUSED,
            ErrorCode::ApplyConflict => exit_code::APPLY_CONFLICT,
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
    /// "setup_output" | "created" | "prompt_delivered" | "queued" |
    /// "state" | "heartbeat". New tags may appear; skip what you
    /// don't know.
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
    /// `send`: the agent was mid-turn, the prompt is queued behind it.
    pub fn queued(id: &str) -> Self {
        Self::base(id, "queued")
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

// ───────────────────────────── attach frames ─────────────────────────

/// One line of an attach session, both directions (docs/plans/cli.md:
/// attach stays NDJSON both ways; base64 overhead is irrelevant at TTY
/// bandwidth and the control messages need in-band framing anyway).
///
/// Server -> client: `ready` (session accepted; raw mode may begin),
/// `out` (PTY output, base64), `detach` (the server is ending the
/// session; `reason` says why). Client -> server: `in` (keystrokes,
/// base64), `resize` (rows/cols), `detach` (clean detach request).
/// Unknown kinds must be skipped, the additive contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachFrame {
    #[serde(rename = "type")]
    pub kind: String,
    /// out / in: base64 payload bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    /// detach: "detached" | "exited" | "archived".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AttachFrame {
    fn base(kind: &str) -> Self {
        AttachFrame { kind: kind.into(), data: None, rows: None, cols: None, reason: None }
    }
    pub fn ready() -> Self {
        Self::base("ready")
    }
    pub fn out(bytes: &[u8]) -> Self {
        AttachFrame { data: Some(b64_encode(bytes)), ..Self::base("out") }
    }
    pub fn input(bytes: &[u8]) -> Self {
        AttachFrame { data: Some(b64_encode(bytes)), ..Self::base("in") }
    }
    pub fn resize(rows: u16, cols: u16) -> Self {
        AttachFrame { rows: Some(rows), cols: Some(cols), ..Self::base("resize") }
    }
    pub fn detach(reason: &str) -> Self {
        AttachFrame { reason: Some(reason.into()), ..Self::base("detach") }
    }
    /// Decoded payload of an `out`/`in` frame; None for other kinds or
    /// invalid base64.
    pub fn data_bytes(&self) -> Option<Vec<u8>> {
        self.data.as_deref().and_then(b64_decode)
    }
}

/// A line of an attach session as the CLI reads it: frames interleave
/// until the final Reply ends the session (mirrors `parse_stream_line`;
/// frames carry `type`, the Reply does not). The Reply is boxed: frames
/// are the hot path and should not pay the Reply's footprint.
#[derive(Debug, Clone, PartialEq)]
pub enum AttachLine {
    Frame(AttachFrame),
    Done(Box<Reply>),
}

pub fn parse_attach_line(line: &str) -> Result<AttachLine, String> {
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if v.get("type").is_some() {
        serde_json::from_value::<AttachFrame>(v)
            .map(AttachLine::Frame)
            .map_err(|e| e.to_string())
    } else {
        serde_json::from_value::<Reply>(v)
            .map(|r| AttachLine::Done(Box::new(r)))
            .map_err(|e| e.to_string())
    }
}

// ───────────────────────────── wire budgets ──────────────────────────

/// The JSON-escaped byte length of one char inside a JSON string:
/// control bytes serialize as six-char \u escapes (except the five
/// two-char shorthands), quotes and backslashes double, everything
/// else is its UTF-8 length. serde_json's exact behavior.
fn json_char_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// The byte length of `s` once JSON-escaped (quotes not counted). The
/// NDJSON line cap (`MAX_LINE_BYTES`) applies POST-escaping, so any
/// size check against it must measure this, not `s.len()`: ANSI-heavy
/// text inflates up to 6x.
pub fn json_escaped_len(s: &str) -> usize {
    s.chars().map(json_char_len).sum()
}

/// The longest PREFIX of `s` whose JSON-escaped length fits `budget`,
/// plus whether anything was cut. Char-boundary safe.
pub fn json_budget_prefix(s: &str, budget: usize) -> (&str, bool) {
    let mut used = 0usize;
    for (i, c) in s.char_indices() {
        let l = json_char_len(c);
        if used + l > budget {
            return (&s[..i], true);
        }
        used += l;
    }
    (s, false)
}

/// The longest SUFFIX of `s` whose JSON-escaped length fits `budget`
/// (the tail-keeping variant, for terminal backlogs), plus whether
/// anything was cut. A budget too small for even the last character
/// deliberately yields "" rather than a partial escape: half an ANSI
/// sequence would corrupt the receiving terminal.
pub fn json_budget_suffix(s: &str, budget: usize) -> (&str, bool) {
    let mut used = 0usize;
    let mut start = s.len();
    for (i, c) in s.char_indices().rev() {
        let l = json_char_len(c);
        if used + l > budget {
            return (&s[start..], true);
        }
        used += l;
        start = i;
    }
    (s, false)
}

// ───────────────────────────── base64 ────────────────────────────────

// Hand-rolled standard-alphabet base64 (with padding) so the attach
// frames need no new dependency: termic-cli links only this crate and
// must stay dependency-light (crate docs above).

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        let idx = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        out.push(B64_ALPHABET[idx[0] as usize] as char);
        out.push(B64_ALPHABET[idx[1] as usize] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[idx[2] as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_ALPHABET[idx[3] as usize] as char } else { '=' });
    }
    out
}

/// None on any malformed input (bad length, bad character, data after
/// padding): a garbage frame must never half-decode into PTY input.
pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let val = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let last = (i + 1) * 4 == bytes.len();
        let pad = chunk.iter().filter(|c| **c == b'=').count();
        // Padding only at the very end, only 1-2 chars, only trailing.
        if pad > 0 && (!last || pad > 2 || chunk[..4 - pad].contains(&b'=')) {
            return None;
        }
        let mut n: u32 = 0;
        for &c in &chunk[..4 - pad] {
            n = n << 6 | val(c)?;
        }
        n <<= 6 * pad as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
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
                prompt_ref: Some("builtin:review".into()),
                agent: Some("claude".into()),
                mode: Some("worktree".into()),
                base: Some("develop".into()),
                from: None,
                resume: None,
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
                prompt_ref: None,
                agent: None,
                mode: None,
                base: None,
                from: None,
                resume: None,
                sandbox: None,
                yolo: false,
                project: None,
                open: false,
                wait: false,
                timeout_ms: None,
                cwd: None,
            },
            // v7 import shape (GH #169): adopt a worktree + resume a session.
            Command::New {
                name: String::new(),
                prompt: None,
                prompt_ref: None,
                agent: Some("claude".into()),
                mode: None,
                base: None,
                from: Some("/tasks/web/poll-linear".into()),
                resume: Some("018f2c1e-aaaa-bbbb-cccc-1234567890ab".into()),
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
                tab: Some("2".into()),
                cwd: None,
            },
            Command::Wait {
                task: None, project: None, timeout_ms: None, tab: None, cwd: Some("/t".into()),
            },
            Command::Tab {
                task: Some("fix-auth".into()),
                project: None,
                kind: TabKind::Agent { id: "claude".into() },
                prompt: Some("run the tests".into()),
                prompt_ref: Some("builtin:review".into()),
                wait: true,
                timeout_ms: Some(60_000),
                resume: Some("018f2c1e-aaaa-bbbb-cccc-1234567890ab".into()),
                cwd: None,
            },
            Command::Tab {
                task: None, project: None, kind: TabKind::Shell,
                prompt: None, prompt_ref: None, wait: false, timeout_ms: None,
                resume: None, cwd: None,
            },
            Command::Tab {
                task: None, project: None, kind: TabKind::Default,
                prompt: None, prompt_ref: None, wait: false, timeout_ms: None,
                resume: None, cwd: None,
            },
            // v10 (GH #185): close one tab, by every selector shape.
            Command::TabClose {
                task: Some("fix-auth".into()),
                project: Some("web".into()),
                tab: "2".into(),
                yes: true,
                cwd: None,
            },
            Command::TabClose {
                task: None,
                project: None,
                tab: "a1b2c3".into(),
                yes: false,
                cwd: Some("/tasks/web/x".into()),
            },
            Command::Agents,
            Command::Prompts { selector: None },
            Command::Prompts { selector: Some("builtin:review".into()) },
            Command::Quit { commit: false },
            Command::Quit { commit: true },
            Command::Archive { task: "fix-auth".into(), project: Some("web".into()) },
            Command::Rename {
                task: Some("fix-auth".into()),
                project: Some("web".into()),
                name: "PR 123 - fix login".into(),
                cwd: None,
            },
            Command::Rename {
                task: None,
                project: None,
                name: "retitled".into(),
                cwd: Some("/tasks/web/x".into()),
            },
            Command::ProjectAdd { path: "/repo/web".into(), non_git: false },
            Command::ProjectAdd { path: "/notes/plain".into(), non_git: true },
            Command::ProjectList,
            Command::ProjectRemove { name: "web".into() },
            Command::Send {
                task: Some("fix-auth".into()),
                project: Some("web".into()),
                prompt: "run the tests".into(),
                prompt_ref: None,
                resume: false,
                fresh: false,
                wait: true,
                timeout_ms: Some(60_000),
                tab: Some("claude".into()),
                cwd: None,
            },
            Command::Send {
                task: None,
                project: None,
                prompt: "continue".into(),
                prompt_ref: Some("Review".into()),
                resume: true,
                fresh: false,
                wait: false,
                timeout_ms: None,
                tab: None,
                cwd: Some("/repo/web".into()),
            },
            Command::Apply { task: "fix-auth".into(), project: Some("web".into()) },
            Command::Diff { task: Some("fix-auth".into()), project: None, full: true, cwd: None },
            Command::Diff { task: None, project: None, full: false, cwd: Some("/t".into()) },
            Command::Logs {
                task: Some("fix-auth".into()),
                project: None,
                shell: true,
                tab: None,
                last_bytes: Some(4096),
                cwd: None,
            },
            Command::Logs {
                task: Some("fix-auth".into()),
                project: None,
                shell: false,
                tab: Some("a1b2c3".into()),
                last_bytes: None,
                cwd: None,
            },
            Command::LastResult { task: Some("fix-auth".into()), project: None, cwd: None },
            Command::Attach {
                task: None, project: None, shell: false, tab: Some("1".into()),
                cwd: Some("/t".into()),
            },
        ] {
            roundtrip(&Request { id: "r1".into(), token: Some("t".into()), cmd });
        }
    }

    #[test]
    fn result_command_and_reply_use_the_result_wire_tag() {
        // The variant is named LastResult only to dodge the std Result
        // name in code; the WIRE tag is "result" and is contract.
        let req = Request {
            id: "r1".into(),
            token: Some("t".into()),
            cmd: Command::LastResult { task: None, project: None, cwd: None },
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains(r#""cmd":"result""#), "wire tag drifted: {line}");
        let reply = Reply::ok(
            "r1",
            ReplyData::LastResult(ResultData {
                task_id: "w1".into(),
                agent: "claude".into(),
                transcript: "/t.jsonl".into(),
                text: "done".into(),
            }),
        );
        let line = serde_json::to_string(&reply).unwrap();
        assert!(line.contains(r#""kind":"result""#), "wire tag drifted: {line}");
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
                    tabs: Some(vec![
                        TabStatus {
                            id: "t1".into(),
                            index: 1,
                            kind: "agent".into(),
                            agent: "claude".into(),
                            title: "claude".into(),
                            state: Some("working".into()),
                            is_default: true,
                            live: true,
                            queued: 1,
                        },
                        TabStatus {
                            id: "t2".into(),
                            index: 2,
                            kind: "shell".into(),
                            agent: "shell".into(),
                            title: "Terminal".into(),
                            state: None,
                            is_default: false,
                            live: true,
                            queued: 0,
                        },
                    ]),
                },
            }),
            ReplyData::Status(StatusData {
                task: TaskStatus {
                    summary: summary.clone(),
                    sandbox: "off".into(),
                    sessions: 0,
                    dirty_files: None,
                    tabs: None,
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
            ReplyData::Agents(AgentsData {
                agents: vec![AgentEntry {
                    id: "claude".into(),
                    kind: "agent".into(),
                    enabled: true,
                    installed: Some(true),
                    usable: true,
                }],
            }),
            ReplyData::Prompts(PromptsData {
                prompts: vec![
                    PromptEntry {
                        id: "builtin:review".into(),
                        title: "Review".into(),
                        builtin: true,
                        enabled: true,
                        modified: false,
                        body: None,
                        truncated: false,
                    },
                    PromptEntry {
                        id: "3f1c0d6e-aaaa-bbbb-cccc-1234567890ab".into(),
                        title: "Ship it".into(),
                        builtin: false,
                        enabled: false,
                        modified: false,
                        body: Some("Review the diff, then commit.".into()),
                        truncated: true,
                    },
                ],
            }),
            ReplyData::Tab(TabData {
                task_id: "w1".into(),
                tab_id: "3f1c-…".into(),
                cli: "claude".into(),
                title: "claude".into(),
                prompt: None,
            }),
            ReplyData::Tab(TabData {
                task_id: "w1".into(),
                tab_id: "3f1c-…".into(),
                cli: "claude".into(),
                title: "claude".into(),
                prompt: Some(PromptOutcome {
                    mode: send_mode::SPAWNED.into(),
                    capable: true,
                    wait: Some(WaitResult {
                        outcome: WaitOutcome::Done,
                        state: Some("done".into()),
                        detail: None,
                    }),
                }),
            }),
            // v10 (GH #185): a secondary tab (forgotten) and the default
            // tab (durable), the distinction `was_default` exists for.
            ReplyData::TabClose(TabCloseData {
                task_id: "w1".into(),
                tab_id: "tab-2".into(),
                cli: "claude".into(),
                title: "reviewing the diff".into(),
                tab_kind: "agent".into(),
                was_default: false,
                killed_pty: true,
            }),
            ReplyData::TabClose(TabCloseData {
                task_id: "w1".into(),
                tab_id: "main".into(),
                cli: "codex".into(),
                title: "codex".into(),
                tab_kind: "agent".into(),
                was_default: true,
                killed_pty: false,
            }),
            // A shell tab: reachable by `tab close` and nothing else.
            ReplyData::TabClose(TabCloseData {
                task_id: "w1".into(),
                tab_id: "tab-sh".into(),
                cli: "shell".into(),
                title: "Terminal".into(),
                tab_kind: "shell".into(),
                was_default: false,
                killed_pty: true,
            }),
            ReplyData::Quit(QuitData {
                running: true,
                tasks_with_agents: 2,
                live_agents: 3,
                working_tasks: Some(1),
                quitting: true,
            }),
            ReplyData::Archive(ArchiveData {
                task_id: "w1".into(),
                name: "fix-auth".into(),
                project: "web".into(),
                killed_agents: 2,
            }),
            ReplyData::Rename(RenameData {
                task: summary.clone(),
                old_name: "fix-auth".into(),
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
            ReplyData::Send(SendData {
                task_id: "w1".into(),
                mode: send_mode::QUEUED.into(),
                capable: true,
                wait: Some(WaitResult {
                    outcome: WaitOutcome::Done,
                    state: Some("done".into()),
                    detail: None,
                }),
            }),
            ReplyData::Send(SendData {
                task_id: "w1".into(),
                mode: send_mode::DELIVERED.into(),
                capable: false,
                wait: None,
            }),
            ReplyData::Apply(ApplyData { task_id: "w1".into(), tracked_files: 3, untracked_files: 1 }),
            ReplyData::Diff(DiffData {
                task_id: "w1".into(),
                files_changed: 4,
                insertions: 100,
                deletions: 2,
                untracked: 1,
                commits: "abc123 fix\n".into(),
                diff: Some("--- a/x\n+++ b/x\n".into()),
            }),
            ReplyData::Logs(LogsData {
                task_id: "w1".into(),
                source: "agent".into(),
                data: "\u{1b}[1mhi\u{1b}[0m".into(),
                truncated: true,
            }),
            ReplyData::LastResult(ResultData {
                task_id: "w1".into(),
                agent: "claude".into(),
                transcript: "/Users/x/.claude/projects/-t/s.jsonl".into(),
                text: "All tests pass.".into(),
            }),
            ReplyData::Attach(AttachData { task_id: "w1".into(), reason: "archived".into() }),
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
    fn send_prompt_field_is_optional_on_the_wire() {
        // v9: `prompt_ref` can stand alone, so a send line without
        // `prompt` must parse (defaulting to empty) rather than error.
        let line = r#"{"id":"r1","token":"t","cmd":"send","prompt_ref":"builtin:review"}"#;
        let req: Request = serde_json::from_str(line).unwrap();
        match req.cmd {
            Command::Send { prompt, prompt_ref, .. } => {
                assert_eq!(prompt, "");
                assert_eq!(prompt_ref.as_deref(), Some("builtin:review"));
            }
            other => panic!("expected send, got {other:?}"),
        }
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
    fn attach_frames_roundtrip_and_discriminate_from_replies() {
        for frame in [
            AttachFrame::ready(),
            AttachFrame::out(b"\x1b[2Jhello"),
            AttachFrame::input(b"ls -la\r"),
            AttachFrame::resize(50, 180),
            AttachFrame::detach("archived"),
        ] {
            roundtrip(&frame);
            let line = serde_json::to_string(&frame).unwrap();
            match parse_attach_line(&line).unwrap() {
                AttachLine::Frame(back) => assert_eq!(back, frame),
                other => panic!("expected frame, got {other:?}"),
            }
        }
        // Payload bytes survive the base64 hop.
        assert_eq!(AttachFrame::out(b"\x00\xff\x1b[0m").data_bytes().unwrap(), b"\x00\xff\x1b[0m");
        // The kind string is the wire discriminator.
        let line = serde_json::to_string(&AttachFrame::input(b"x")).unwrap();
        assert!(line.contains(r#""type":"in""#));
        // The final Reply (no `type` field) ends the session.
        let reply = Reply::ok(
            "r1",
            ReplyData::Attach(AttachData { task_id: "w1".into(), reason: "exited".into() }),
        );
        let line = serde_json::to_string(&reply).unwrap();
        match parse_attach_line(&line).unwrap() {
            AttachLine::Done(back) => assert_eq!(*back, reply),
            other => panic!("expected done, got {other:?}"),
        }
        // Unknown frame kinds still parse (additive contract).
        let line = r#"{"type":"totally_new","x":1}"#;
        match parse_attach_line(line).unwrap() {
            AttachLine::Frame(f) => assert_eq!(f.kind, "totally_new"),
            other => panic!("expected frame, got {other:?}"),
        }
    }

    #[test]
    fn json_budgets_measure_escaped_bytes() {
        // ESC escapes to a six-byte backslash-u sequence, quote/backslash/newline to 2.
        assert_eq!(json_escaped_len("abc"), 3);
        assert_eq!(json_escaped_len("\u{1b}[0m"), 9);
        assert_eq!(json_escaped_len("a\"b\\c\nd"), 10);
        assert_eq!(json_escaped_len("é"), 2);
        // The measure matches serde's actual output (minus the quotes).
        for s in ["plain", "\u{1b}[1mhi\u{1b}[0m", "a\"b\\c\r\n\t\u{1}", "naïve — text"] {
            assert_eq!(
                json_escaped_len(s),
                serde_json::to_string(s).unwrap().len() - 2,
                "{s:?}"
            );
        }
        // Prefix keeps the head, suffix keeps the tail, both flag cuts
        // and never split an escape's budget accounting.
        let s = "aa\u{1b}bb";
        assert_eq!(json_budget_prefix(s, 100), (s, false));
        assert_eq!(json_budget_prefix(s, 3), ("aa", true)); // ESC needs 6
        assert_eq!(json_budget_suffix(s, 2), ("bb", true));
        assert_eq!(json_budget_suffix(s, 100), (s, false));
        assert_eq!(json_budget_suffix("\u{1b}\u{1b}", 5), ("", true));
        // Multi-byte chars stay on boundaries.
        let (p, cut) = json_budget_prefix("héllo", 2);
        assert!(cut);
        assert!(p == "h" || p == "hé");
    }

    #[test]
    fn base64_roundtrips_and_rejects_garbage() {
        // Goldens against the RFC 4648 test vectors.
        for (plain, enc) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(b64_encode(plain), enc);
            assert_eq!(b64_decode(enc).as_deref(), Some(plain));
        }
        // Every byte value survives.
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(b64_decode(&b64_encode(&all)).unwrap(), all);
        // Malformed input decodes to None, never to partial bytes.
        for bad in ["Zg", "Zg=", "Z===", "Zm=v", "Zg==Zg==x", "Z g=", "Zm9v!"] {
            assert!(b64_decode(bad).is_none(), "{bad:?} should not decode");
        }
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
        assert_eq!(ErrorCode::ApplyConflict.exit_code(), 10);
    }

    #[test]
    fn canned_messages_obey_copy_rules() {
        // Repo copy rule: no em dashes anywhere in user-visible text.
        for s in [CLI_DISABLED_MESSAGE, VERSION_MISMATCH_MESSAGE, VERSION_STALE_APP_MESSAGE] {
            assert!(!s.contains('\u{2014}'), "em dash in {s:?}");
        }
    }
}
