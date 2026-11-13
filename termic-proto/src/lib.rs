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
///
/// v12 (GH #287): `new` gains per-task agent arguments. They are persisted
/// on the task and included in task summaries so callers can verify the
/// launch they requested.
///
/// v13: the `pad_*` verbs. An agent creates, writes, reads and lists its
/// task's scratchpads, and an open pad shows the write live.
///
/// v14: `new` gains `checkout`, an EXISTING branch to check out into the
/// new worktree (fetched and tracked when it only exists on the remote)
/// instead of cutting a new one. A v13 server would drop the field and
/// quietly cut a fresh branch named after the task.
///
/// v15: `new` carries `parent_task`, so a task an agent creates joins the
/// agent's sidebar task group; the `group` verb shows or renames/recolours
/// it; task summaries carry `group` (and, additively, `spawned_by`).
///
/// v16 (GH #331): `tab` gains `title`, and the `tab_rename` verb sets or
/// clears the title of a tab that is already open. A v15 server would
/// drop the unknown `title` field and open an untitled tab, so a script
/// that then addresses `--tab <title>` would fail far from the cause.
/// v17: per-tab launch arguments. Older servers would silently discard
/// the requested model/reasoning, so a matching app and CLI are required.
///
/// v18 (GH #358): the `prop` verb sets, clears and lists the key/value
/// properties agents put on their tabs, and `status` carries them (per
/// tab, and the task's collected view).
///
/// v19: `send` gains `now`, which types the prompt into a busy agent at once
/// instead of queueing it behind the turn. A v18 server would drop the field
/// and quietly queue, the opposite of what an urgent message asked for.
///
/// v20: `scratchpad rm` and `scratchpad clear` (`pad_remove`, `pad_clear`)
/// delete one pad, or every pad of a task or scope. A v19 server does not
/// know either verb, and the version check says "restart the app" where the
/// bare failure would read as a broken command. Also `group` gains
/// `caller_task`: a v19 server would drop it and go on merging an agent's
/// task into another agent's group when their group names match.
///
/// v21: `new` gains `pr` (`termic review`, MCP `task_review`): the task is a
/// review of that pull request, on its fetched branch, holding the PR's
/// details ahead of a prompt tagged "Code review". A v20 server would drop
/// the field and create a task named after nothing on a fresh branch.
///
/// v22: paired machines on the LAN (docs/peers.md). `Request` gains `peer`
/// (run this verb on that paired Termic instead of here) and `from_task`;
/// the `peer_list` / `peer_pair` / `peer_unpair` / `peer_rename` verbs; and
/// the `peer_unreachable` error code (exit 12). A v21 server would drop
/// `peer` and run the verb HERE, on the wrong machine, so the bump is not
/// optional. Two paired apps must ALSO speak the same version to call each
/// other, for the same reason one hop further away.
///
/// v23: `group` gains `join` (move the task into another task's group) and
/// `leave` (take it out of its group). A v22 server would drop both and
/// answer with the group unchanged, which reads as success.
///
/// v24: `new` gains `members`, the member repos of a multi-repo project the
/// task worktrees (or, in the main checkout, links). A v23 server would drop
/// the field and create a task with no member worktrees, or with every
/// member linked, which reads as success. `project list` reports each
/// project's `type` and members.
pub const PROTOCOL_VERSION: u32 = 24;

/// A pasted "123", "#123", "!123" or a PR / MR link, reduced to its number.
/// None for anything else. The webview's `parsePrRef` (src/lib/prReview.ts)
/// is the same rule; the CLI and MCP parse here so a bad reference fails
/// before anything crosses the wire.
pub fn parse_pr_ref(raw: &str) -> Option<u64> {
    let t = raw.trim();
    for marker in ["/pull/", "/merge_requests/", "/pullrequest/"] {
        let lower = t.to_ascii_lowercase();
        if let Some(i) = lower.find(marker) {
            let digits: String = t[i + marker.len()..].chars().take_while(|c| c.is_ascii_digit()).collect();
            return digits.parse::<u64>().ok().filter(|n| *n > 0);
        }
    }
    let bare = t.strip_prefix('#').or_else(|| t.strip_prefix('!')).unwrap_or(t);
    if bare.is_empty() || !bare.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    bare.parse::<u64>().ok().filter(|n| *n > 0)
}

/// The argv `new` pins to a task's agent: the generic `--arg` values, then
/// `--model <m>` LAST, so an explicit model wins when the agent parses
/// last-value-wins. Shared by the CLI and the MCP server so `task_new` and
/// `termic new` cannot compose it differently.
pub fn compose_task_agent_args(args: &[String], model: Option<&str>) -> Vec<String> {
    let mut out = args.to_vec();
    if let Some(model) = model {
        out.push("--model".into());
        out.push(model.into());
    }
    out
}

/// Whether `d` is a real calendar date written `YYYY-MM-DD` (`2026-02-30` is
/// not one). The webview's runner reads it with `Date(y, m, d)`, which would
/// roll such a date into March, so every boundary refuses it instead: the CLI,
/// the MCP tool and `task_set_schedule` (GH #403).
pub fn calendar_date_ok(d: &str) -> bool {
    let b = d.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !d[..4].bytes().chain(d[5..7].bytes()).chain(d[8..].bytes()).all(|c| c.is_ascii_digit()) {
        return false;
    }
    let (y, m, day): (u32, u32, u32) = (d[..4].parse().unwrap_or(0), d[5..7].parse().unwrap_or(0), d[8..].parse().unwrap_or(0));
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if leap { 29 } else { 28 },
        _ => return false,
    };
    y >= 1970 && (1..=days).contains(&day)
}

/// Why `schedule set`'s cadence and date do not go together, or None (GH
/// #403): a date belongs to the once cadence, which needs one, and it must be
/// a real day. Shared by the CLI (pre-socket) and the MCP tool. Whether the
/// date and time are still AHEAD, and exist on the local clock, is the app's
/// call: it has the clock and the time zone.
pub fn schedule_date_problem(cadence: Option<&str>, date: Option<&str>) -> Option<&'static str> {
    let once = cadence.is_some_and(|c| c.eq_ignore_ascii_case("once"));
    match (cadence, date) {
        (Some(_), None) if once => Some("a once cadence needs a date, YYYY-MM-DD"),
        (Some(_), Some(_)) if !once => Some("a date only goes with the once cadence"),
        (None, Some(_)) => Some("a date needs the once cadence and a time"),
        (_, Some(d)) if !calendar_date_ok(d) => Some("the date must be a real calendar day, YYYY-MM-DD"),
        _ => None,
    }
}

/// Why `title` cannot be a tab title, or None when it can (GH #331).
/// Shared by the CLI (pre-socket), the server and the MCP tool, so the
/// three cannot disagree. Exactly "" is valid: it means "the automatic
/// title" (no rename on open, clear the rename on `tab_rename`).
/// Uniqueness is NOT checked here; it needs the live strip, which only
/// the webview has.
pub fn tab_title_problem(title: &str) -> Option<&'static str> {
    if title.is_empty() {
        return None;
    }
    let t = title.trim();
    if t.is_empty() {
        return Some("the title is blank; pass \"\" for the automatic title");
    }
    // `--tab <n>` resolves a number as a 1-based strip position before it
    // tries titles, so a tab titled "2" could never be reached by title.
    if t.chars().all(|c| c.is_ascii_digit()) {
        return Some(
            "a title cannot be a number: --tab <n> selects by position, so that tab could never be reached by its title",
        );
    }
    None
}

/// Property limits (GH #358). Values come from agents, so they are
/// validated, not escaped; the sidebar row is narrow.
pub const PROP_KEY_MAX: usize = 32;
pub const PROP_VALUE_MAX: usize = 40;
pub const PROP_KEYS_PER_TAB: usize = 8;

/// Why `key` cannot be a property key: `[a-z0-9][a-z0-9_-]*`, at most
/// `PROP_KEY_MAX` characters.
pub fn prop_key_problem(key: &str) -> Option<String> {
    let first_ok = key.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok = key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !first_ok || !rest_ok {
        return Some(format!(
            "property key \"{key}\" must be lowercase letters, digits, - and _, starting with a letter or digit"
        ));
    }
    if key.chars().count() > PROP_KEY_MAX {
        return Some(format!("a property key is longer than {PROP_KEY_MAX} characters"));
    }
    None
}

/// Why `value` cannot be a property value: one line, no control
/// characters, at most `PROP_VALUE_MAX` characters once trimmed. "" (or
/// only spaces) is valid: it clears the key.
pub fn prop_value_problem(value: &str) -> Option<String> {
    if value.chars().any(char::is_control) {
        return Some("a property value must be one line, with no control characters".into());
    }
    if value.trim().chars().count() > PROP_VALUE_MAX {
        return Some(format!("a property value is longer than {PROP_VALUE_MAX} characters"));
    }
    None
}

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
pub mod local;

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
    /// `--peer`: the paired machine could not be reached (off, asleep, left
    /// the network, firewall). Nothing ran there.
    pub const PEER_UNREACHABLE: i32 = 12;
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
    /// `--profile <name>`: which profile's window should serve this request
    /// (GH #280). Absent means "derive it", which is what every pre-profiles
    /// client sends and what the overwhelmingly common single-profile case
    /// wants. An UNKNOWN name is an error rather than a fallback: the server
    /// already refuses to guess for an unknown project, and guessing here
    /// would silently act on the wrong profile's data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// `--peer <name>` (v22): run this verb on that PAIRED Termic, not here.
    /// The app this request reaches forwards it, sealed with the pair's own
    /// key; the caller never holds a credential for the other machine. A
    /// request that arrives FROM a peer never carries this (no second hop).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    /// The task the caller runs in (`$TERMIC_TASK_ID`), sent alongside `peer`
    /// only. Not `caller_task`: the command is flattened into this object and
    /// `group` already owns that key (and `peer_*` verbs say `target`, not
    /// `peer`, for the same reason). The forwarding app records it, so that peer may later reply into
    /// this task even when it is only allowed to reply (docs/peers.md,
    /// "What a paired machine may do"). Caller-asserted, like the env var it
    /// comes from: it can only ever name a task the caller could have
    /// prompted itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_task: Option<String>,
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
        /// Additional argv elements pinned to the task's default agent.
        /// The CLI has already expanded `--model` into the final ordered
        /// vector by the time this crosses the wire.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        agent_args: Vec<String>,
        /// "worktree" | "main". Absent = the GUI's remembered mode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// Base branch for a worktree task. Absent = the repo default.
        /// With `checkout`, only what the diff compares against.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<String>,
        /// Check out this EXISTING branch into the new worktree (v14): a
        /// local branch, `<remote>/<branch>`, or a name that only exists
        /// on the remote (fetched and tracked). Never cuts a new branch;
        /// an unknown one is an error. Implies worktree mode; exclusive
        /// with `from`. `name` may be empty, the webview derives it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkout: Option<String>,
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
        /// Named agent account (GH #278) the task's agent runs on. Absent
        /// = the agent's default account.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
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
        /// v15: the caller's own task id (`$TERMIC_TASK_ID`), when an agent
        /// inside a task is the one creating this one. The new task joins
        /// that task's sidebar group, founding it if needed. Cosmetic and
        /// caller-asserted: an unknown id is ignored, never an error.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_task: Option<String>,
        /// v21: review this pull request (`termic review`). The webview
        /// fetches its head and checks it out (a worktree unless `mode` is
        /// "main"), names the task `review-pr-<n>` when `name` is empty,
        /// and puts the PR's details ahead of the prompt. Excludes `from`
        /// and `checkout`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pr: Option<u64>,
        /// v24: multi-repo projects only. Member NAMES as the caller typed
        /// them (`--member`); the server resolves them against the project,
        /// refuses an unknown one, and forwards root_paths. Empty = the
        /// pre-v24 create. Excludes `from`, `checkout`, `pr` and `resume`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        members: Vec<String>,
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
        /// Explicit per-tab argv. Requires an explicit agent kind.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        agent_args: Vec<String>,
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
        /// v16 (GH #331): the new tab's title, set as a user rename so the
        /// agent's OSC title cannot replace it and it survives a relaunch.
        /// Absent or "" = the automatic title. Unique among the task's
        /// tabs, since its point is being an unambiguous `--tab` selector.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// v16 (GH #331): set or clear the title of a tab that is already
    /// open: the tab strip's double-click rename as a verb. Replies with
    /// `ReplyData::Tab` (no prompt). Reaches every strip tab, like
    /// `tab_close`: renaming is not driving.
    TabRename {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Tab selector (id, 1-based strip index, or title/cli), resolved
        /// by the same rules `send`/`wait`/`tab_close` use.
        tab: String,
        /// The new title. "" clears the rename, and the tab goes back to
        /// its automatic, agent-driven title.
        title: String,
        /// The CLI's working directory, for worktree-first resolution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// v18 (GH #358): a tab's key/value properties. With `key` and `value`,
    /// set it on the tab `tab` resolves to ("" clears it); otherwise list
    /// the task's properties (`key` filters). Replies `ReplyData::Prop`.
    Prop {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        /// Tab selector (id, 1-based strip index, or title/cli). Required to
        /// set; the CLI fills it from `$TERMIC_TAB_ID`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
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
    /// v15: show or change a task's sidebar TASK GROUP (the block a task an
    /// agent creates joins, led by that agent's task). With neither `name`
    /// nor `color` it only reports. Setting either on a task in no group
    /// founds a group of one around it, so an orchestrator can name its
    /// group before it spawns anyone. `name: ""` returns the group to
    /// following its lead task's name. cwd-aware when `task` absent.
    Group {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        /// An accent key: red, orange, yellow, green, teal, blue, purple, pink.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// The task the CALLER runs in ($TERMIC_TASK_ID, or MCP's task
        /// header), which is not always `task`: it says whether this came
        /// from an agent inside Termic. Only a caller with NO task of its own
        /// may have an ungrouped task joined to an existing group by name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caller_task: Option<String>,
        /// v23: move the task into the group of THIS task (a name, id or
        /// project/name, in the same project). A target in no group founds
        /// one with it, as the sidebar's Move to group does. Not with
        /// `name`, `color` or `leave`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        join: Option<String>,
        /// v23: take the task out of its group. The group carries on with
        /// its other members. Not with `name`, `color` or `join`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        leave: bool,
    },
    /// List a task's scratchpads. cwd-aware when `task` absent.
    PadList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Create a scratchpad in a task, optionally titled and seeded. It opens
    /// as an unfocused tab when the task is open in the window.
    PadNew {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Replace (or append to) a scratchpad's text. `pad` is a pad id or its
    /// exact title, case-insensitive. An open pad updates in place.
    PadWrite {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        pad: String,
        content: String,
        #[serde(default, skip_serializing_if = "is_false")]
        append: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Read a scratchpad's text, including edits still in an open editor.
    PadRead {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        pad: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Delete ONE scratchpad for good: its text, its record and its tab.
    /// `pad` is a pad id or its exact title, case-insensitive.
    PadRemove {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        pad: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Delete EVERY scratchpad in the target (a task, or one shared scope).
    /// What `scratchpad list` shows is exactly what goes.
    PadClear {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
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
    /// This machine, the machines paired with it, and the unpaired ones in
    /// sight on the LAN (v22, docs/peers.md).
    PeerList,
    /// Pair with a machine in sight (its name or id) or at an address (`ip`
    /// or `ip:port`) that is in pairing mode, using the four-digit code its
    /// screen shows. Returns once both machines hold the pair, or fails on a
    /// wrong code or a machine not in pairing mode. Without `code`, asks the
    /// machine to show one and answers `PeerCodeShown`: the person there
    /// reads it out, and the caller sends this again with it. No bump: a
    /// v24 server refuses a missing code outright instead of misreading it.
    PeerPair {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Forget a paired machine and tell it to forget this one. Its key is
    /// deleted here at once, so it can no longer call in even when it is
    /// offline and never hears about it.
    PeerUnpair { target: String },
    /// Set the local name of a paired machine (empty: back to the name it
    /// gives itself). Local only: the other machine is not told.
    PeerRename { target: String, name: String },
    /// List recurring schedules across projects, optionally filtered to one project.
    ScheduleList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
    /// Show detailed status and history of a task's schedule.
    ScheduleShow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Create or update a schedule on a parent task.
    ScheduleSet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cadence: Option<ScheduleCadence>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keep_runs: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        report_days: Option<Option<u32>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        catch_up: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Trigger an immediate out-of-band run of a schedule ("Run now").
    ScheduleRun {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Remove a schedule from a task.
    ScheduleDelete {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        delete_reports: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        archive_tasks: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
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
        /// Skip the queue (`--now`, v19): type the prompt into the agent at
        /// once even when it is mid-turn or has messages waiting, for the
        /// message that cannot wait for the turn to end. The one thing it
        /// does not override is a draft the USER is typing in that prompt,
        /// which still queues the message behind it.
        #[serde(default)]
        now: bool,
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
    Prop(PropData),
    Quit(QuitData),
    Archive(ArchiveData),
    Rename(RenameData),
    Group(GroupData),
    Pad(PadData),
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
    Schedule(ScheduleData),
    /// `peer list`, `peer unpair` and `peer rename` (v22).
    Peers(PeersData),
    /// `peer pair` (v22).
    PeerPair(PeerPairData),
    PeerCodeShown(PeerCodeShownData),
}

/// One property as a tab carries it (GH #358).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PropEntry {
    pub key: String,
    pub value: String,
}

/// One key of a task's collected view: the distinct values its tabs hold,
/// in tab strip order. Keys come in the order each was first set anywhere
/// in the task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectedProp {
    pub key: String,
    pub values: Vec<String>,
}

/// A strip tab and the properties it holds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TabProps {
    pub tab_id: String,
    pub cli: String,
    pub title: String,
    pub props: Vec<PropEntry>,
}

/// `prop`'s reply: the task's properties after the write (if any). Only
/// tabs holding at least one property are listed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PropData {
    pub task_id: String,
    /// The tab a set/clear landed on; absent for a plain list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub tabs: Vec<TabProps>,
    pub collected: Vec<CollectedProp>,
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
    /// Named accounts (GH #278), what `new --account` takes. Empty when
    /// the agent has none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<String>,
    /// Which of `accounts` a task uses without `--account`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_account: Option<String>,
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
    /// Tagged "Code review" (v21): offered by Review a PR, and what
    /// `review` picks when no prompt is named.
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub review: bool,
    /// Every label the prompt carries (Settings, Prompts), the built-in
    /// one as `code-review`. Absent when it has none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
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
    /// Explicit per-tab overrides, not the provider's inferred effective configuration.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_args: Vec<String>,
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

/// A task's sidebar task group, as `group` and task summaries report it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskGroupInfo {
    /// The group's id: its lead task's id for a group an agent founded.
    pub id: String,
    /// What the sidebar shows: the group's own name, else its lead's.
    pub name: String,
    /// True when `name` is the group's own; false when it follows the lead.
    pub named: bool,
    /// Accent key, if the group has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Live members as `project/name`, lead first. Only `group` fills it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupData {
    /// The task asked about, as `project/name`.
    pub task: String,
    /// Its group after the call, or none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<TaskGroupInfo>,
}

/// One scratchpad, as `pad list` and every other pad verb report it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PadInfo {
    pub id: String,
    /// "" for a pad with no title yet (the window shows "Untitled").
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub syntax: Option<String>,
    /// Open as a tab in the window right now.
    #[serde(default)]
    pub open: bool,
}

/// Reply to every pad verb. `pads` is the whole list for `pad_list` and the
/// one pad acted on otherwise; `content` is only set by `pad_read`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PadData {
    pub task_id: String,
    pub pads: Vec<PadInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// `content` was clipped to fit the reply line.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub root_path: String,
    /// Live (non-archived) task count.
    pub tasks: u32,
    pub default_agent: String,
    /// v24: "single" or "multi", the app's `Project.type`.
    #[serde(rename = "type", default)]
    pub project_type: String,
    /// v24: a multi-repo project's member repos, in project order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<ProjectMemberInfo>,
}

/// One member repo of a multi-repo project (v24).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ProjectMemberInfo {
    /// What `new --member` takes.
    pub name: String,
    pub root_path: String,
    /// A plain folder: a task links it, never worktrees it.
    pub non_git: bool,
    /// The ref its worktrees branch from. Empty for a plain folder.
    pub base_branch: String,
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

/// This Termic, as `peer list` shows it and other machines see it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PeerSelf {
    pub id: String,
    /// The name other machines see (Settings, defaults to the computer name).
    pub name: String,
    /// LAN sharing is on (Settings > Nearby machines).
    pub sharing: bool,
    /// Where other machines reach this one, `ip:port`. Empty when sharing
    /// is off or the machine has no network.
    #[serde(default)]
    pub addresses: Vec<String>,
}

/// A paired machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PeerInfo {
    pub id: String,
    /// What to call it: the local name when one is set, else its own.
    pub name: String,
    /// The name it gives itself.
    pub advertised_name: String,
    /// Seen on the network in the last few minutes.
    pub online: bool,
    /// When it was last seen or heard from, RFC 3339. None: never.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    /// Last known `ip:port`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// What THAT machine may do HERE: "reply" or "drive".
    pub grant: String,
    /// What THIS machine may do THERE, as it last said. None: not heard yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub their_grant: Option<String>,
    /// It answered "not paired" the last time this machine called it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub revoked_by_peer: bool,
    /// What the user says this machine is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// An unpaired Termic in sight on the LAN.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct NearbyInfo {
    pub id: String,
    pub name: String,
    pub address: String,
    pub version: String,
    /// Speaks this machine's CLI protocol, so the two could call each other
    /// once paired.
    pub compatible: bool,
    /// In pairing mode: showing a code, ready to be paired with.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pairing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct PeersData {
    #[serde(rename = "self")]
    pub this: PeerSelf,
    pub peers: Vec<PeerInfo>,
    #[serde(default)]
    pub nearby: Vec<NearbyInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeerPairData {
    pub peer: PeerInfo,
}

/// `peer pair` without a code: the machine now shows one on its screen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeerCodeShownData {
    /// The name it gives itself, as the person there sees it.
    pub name: String,
    /// What the caller does next, for an agent reading the reply.
    pub next: String,
}

/// One schedule cadence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct ScheduleCadence {
    pub kind: String,
    pub time: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekday: Option<u8>,
    /// Once only: the local date, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// One schedule's summary row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ScheduleSummary {
    pub task_id: String,
    pub task_name: String,
    pub project_id: String,
    pub project_name: String,
    pub name: String,
    pub slug: String,
    pub enabled: bool,
    pub cadence: ScheduleCadence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_slot: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<String>,
    #[serde(default)]
    pub keep_runs: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_days: Option<u32>,
    #[serde(default)]
    pub catch_up: bool,
}

/// One entry in a schedule's history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ScheduleRunInfo {
    pub slot: i64,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub manual: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub report_gone: bool,
}

/// Immediate run outcome from "Run now".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ScheduleRunResult {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reply to schedule verbs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ScheduleData {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schedules: Vec<ScheduleSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduleSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<ScheduleRunInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_result: Option<ScheduleRunResult>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
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
    /// Task-owned argv appended after the agent's configured defaults.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_args: Vec<String>,
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
    /// The sidebar task group this task is in (v15). A `new` run from inside
    /// a task reports here the group the new task joined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<TaskGroupInfo>,
    /// The task whose agent created this one, as `project/name`. Set whether
    /// or not they share a group: a task spawned into ANOTHER project joins
    /// no group, and this is its only link back. Additive (an older peer
    /// ignores it or reads none), so no protocol bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<String>,
    /// v18 (GH #358): the task's collected tab properties (see
    /// `CollectedProp`). Empty when no tab holds any, or when the UI has
    /// not reported the task's tabs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub props: Vec<CollectedProp>,
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
    /// Explicit per-tab overrides, not the provider's inferred effective configuration.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_args: Vec<String>,
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
    /// v18 (GH #358): the tab's own properties.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub props: Vec<PropEntry>,
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
    /// `--peer`: the paired machine did not answer (v22). Nothing ran there.
    PeerUnreachable,
}

impl ErrorCode {
    /// The pinned exit code the CLI uses for this error class.
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCode::CliDisabled => exit_code::CLI_DISABLED,
            ErrorCode::Auth => exit_code::REFUSED,
            ErrorCode::ApplyConflict => exit_code::APPLY_CONFLICT,
            ErrorCode::PeerUnreachable => exit_code::PEER_UNREACHABLE,
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

    #[test]
    fn a_schedule_date_is_a_real_day_and_only_goes_with_once() {
        for ok in ["2026-10-27", "2028-02-29", "2000-02-29", "1970-01-01"] {
            assert!(super::calendar_date_ok(ok), "{ok}");
        }
        for bad in ["2026-02-29", "1900-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "27-10-2026", "2026-10-7", "2026/10/27", "", "1969-12-31"] {
            assert!(!super::calendar_date_ok(bad), "{bad}");
        }
        use super::schedule_date_problem as p;
        assert_eq!(p(Some("once"), Some("2026-10-27")), None);
        assert_eq!(p(Some("ONCE"), Some("2026-10-27")), None);
        assert_eq!(p(Some("weekly"), None), None);
        assert_eq!(p(None, None), None);
        assert!(p(Some("once"), None).is_some());
        assert!(p(Some("daily"), Some("2026-10-27")).is_some());
        assert!(p(None, Some("2026-10-27")).is_some());
        assert!(p(Some("once"), Some("2026-02-30")).is_some());
    }

    #[test]
    fn parse_pr_ref_reads_every_spelling_and_guesses_at_nothing() {
        for (raw, n) in [
            ("123", 123), (" #123 ", 123), ("!45", 45),
            ("https://github.com/acme/web/pull/77", 77),
            ("https://github.com/acme/web/pull/77/files", 77),
            ("https://gitlab.example.io/acme/web/-/merge_requests/9", 9),
            ("https://dev.azure.com/acme/proj/_git/web/pullRequest/12", 12),
        ] {
            assert_eq!(parse_pr_ref(raw), Some(n), "{raw}");
        }
        for raw in ["", "abc", "0", "#", "-3", "1.5", "https://github.com/acme/web/issues/4"] {
            assert_eq!(parse_pr_ref(raw), None, "{raw}");
        }
    }

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
                agent_args: vec!["--effort".into(), "high".into(), "--model".into(), "opus".into()],
                mode: Some("worktree".into()),
                base: Some("develop".into()),
                checkout: None,
                from: None,
                resume: None,
                sandbox: Some("enforce-fs".into()),
                yolo: true,
                account: Some("work".into()),
                project: Some("web".into()),
                open: true,
                wait: true,
                timeout_ms: Some(60_000),
                cwd: Some("/repo/web".into()),
                parent_task: None,
                pr: None,
                members: vec!["alpha".into(), "Beta".into()],
            },
            Command::New {
                name: "bare".into(),
                prompt: None,
                prompt_ref: None,
                agent: None,
                agent_args: Vec::new(),
                mode: None,
                base: None,
                checkout: None,
                from: None,
                resume: None,
                sandbox: None,
                yolo: false,
                account: None,
                project: None,
                open: false,
                wait: false,
                timeout_ms: None,
                cwd: None,
                parent_task: None,
                pr: None,
                members: Vec::new(),
            },
            // v14 checkout shape: an existing branch, the name left to the app.
            Command::New {
                name: String::new(),
                prompt: None,
                prompt_ref: None,
                agent: None,
                agent_args: Vec::new(),
                mode: Some("worktree".into()),
                base: Some("origin/develop".into()),
                checkout: Some("origin/alice/fix".into()),
                from: None,
                resume: None,
                sandbox: None,
                yolo: false,
                account: None,
                project: None,
                open: false,
                wait: false,
                timeout_ms: None,
                cwd: None,
                parent_task: None,
                pr: None,
                members: Vec::new(),
            },
            // v7 import shape (GH #169): adopt a worktree + resume a session.
            Command::New {
                name: String::new(),
                prompt: None,
                prompt_ref: None,
                agent: Some("claude".into()),
                agent_args: Vec::new(),
                mode: None,
                base: None,
                checkout: None,
                from: Some("/tasks/web/poll-linear".into()),
                resume: Some("018f2c1e-aaaa-bbbb-cccc-1234567890ab".into()),
                sandbox: None,
                yolo: false,
                account: None,
                project: None,
                open: false,
                wait: false,
                timeout_ms: None,
                cwd: None,
                parent_task: None,
                pr: None,
                members: Vec::new(),
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
                agent_args: Vec::new(),
                task: Some("fix-auth".into()),
                project: None,
                kind: TabKind::Agent { id: "claude".into() },
                prompt: Some("run the tests".into()),
                prompt_ref: Some("builtin:review".into()),
                wait: true,
                timeout_ms: Some(60_000),
                resume: Some("018f2c1e-aaaa-bbbb-cccc-1234567890ab".into()),
                title: Some("reviewer".into()),
                cwd: None,
            },
            Command::Tab {
                agent_args: Vec::new(),
                task: None, project: None, kind: TabKind::Shell,
                prompt: None, prompt_ref: None, wait: false, timeout_ms: None,
                resume: None, title: None, cwd: None,
            },
            Command::Tab {
                agent_args: Vec::new(),
                task: None, project: None, kind: TabKind::Default,
                prompt: None, prompt_ref: None, wait: false, timeout_ms: None,
                resume: None, title: None, cwd: None,
            },
            // v16 (GH #331): rename a tab, and clear a rename with "".
            Command::TabRename {
                task: Some("fix-auth".into()),
                project: Some("web".into()),
                tab: "2".into(),
                title: "implementer".into(),
                cwd: None,
            },
            Command::TabRename {
                task: None,
                project: None,
                tab: "implementer".into(),
                title: String::new(),
                cwd: Some("/tasks/web/x".into()),
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
            // v18 (GH #358): set, clear and list properties.
            Command::Prop {
                task: Some("fix-auth".into()),
                project: None,
                tab: Some("tab-1".into()),
                key: Some("ticket".into()),
                value: Some("ABC-1".into()),
                cwd: None,
            },
            Command::Prop {
                task: None, project: None, tab: Some("2".into()),
                key: Some("status".into()), value: Some(String::new()), cwd: None,
            },
            Command::Prop { task: None, project: None, tab: None, key: None, value: None, cwd: Some("/t".into()) },
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
            Command::PadList { task: None, project: None, scope: None, cwd: Some("/tasks/web/x".into()) },
            Command::PadNew {
                task: Some("fix-auth".into()),
                project: Some("web".into()),
                scope: None,
                title: Some("findings".into()),
                content: Some("# notes\n".into()),
                cwd: None,
            },
            Command::PadWrite {
                task: None,
                project: None,
                scope: None,
                pad: "findings".into(),
                content: "more\n".into(),
                append: true,
                cwd: None,
            },
            Command::PadRead { task: Some("t1".into()), project: None, scope: None, pad: "p1".into(), cwd: None },
            Command::PadRemove { task: Some("t1".into()), project: None, scope: None, pad: "p1".into(), cwd: None },
            Command::PadClear { task: None, project: Some("web".into()), scope: Some("project".into()), cwd: None },
            Command::ProjectAdd { path: "/repo/web".into(), non_git: false },
            Command::ProjectAdd { path: "/notes/plain".into(), non_git: true },
            Command::ProjectList,
            Command::ProjectRemove { name: "web".into() },
            Command::PeerList,
            Command::PeerPair { target: "192.168.1.20:23620".into(), code: Some("4821".into()) },
            Command::PeerPair { target: "laptop".into(), code: None },
            Command::PeerUnpair { target: "laptop".into() },
            Command::PeerRename { target: "laptop".into(), name: "".into() },
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
                now: true,
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
                now: false,
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
            Command::ScheduleList { project: Some("web".into()) },
            Command::ScheduleShow { task: Some("parent-1".into()), project: None, cwd: None },
            Command::ScheduleSet {
                task: Some("parent-1".into()),
                project: None,
                name: Some("nightly run".into()),
                cadence: Some(ScheduleCadence { kind: "daily".into(), time: "09:00".into(), weekday: None, date: None }),
                prompt: Some("check status".into()),
                prompt_ref: None,
                keep_runs: Some(7),
                report_days: Some(Some(30)),
                catch_up: Some(false),
                enabled: Some(true),
                cwd: None,
            },
            Command::ScheduleRun { task: Some("parent-1".into()), project: None, cwd: None },
            Command::ScheduleDelete { task: Some("parent-1".into()), project: None, delete_reports: true, archive_tasks: false, cwd: None },
            Command::ScheduleDelete { task: Some("parent-1".into()), project: None, delete_reports: false, archive_tasks: true, cwd: None },
        ] {
            roundtrip(&Request {
                id: "r1".into(),
                token: Some("t".into()),
                profile: None,
                peer: None,
                from_task: None,
                cmd,
            });
        }
    }

    #[test]
    fn peer_fields_ride_on_the_request_and_vanish_when_absent() {
        // `peer` is what sends a verb to another machine. An older CLI's
        // request (no field) must parse as "run it here", and a request with
        // no peer must not grow the keys, so the wire stays what it was.
        let plain = r#"{"id":"1","token":"t","cmd":"list"}"#;
        let req: Request = serde_json::from_str(plain).unwrap();
        assert_eq!((req.peer.as_deref(), req.from_task.as_deref()), (None, None));
        let line = serde_json::to_string(&req).unwrap();
        assert!(!line.contains("peer") && !line.contains("from_task"), "{line}");

        let req = Request {
            id: "1".into(),
            token: Some("t".into()),
            profile: None,
            peer: Some("laptop".into()),
            from_task: Some("w1".into()),
            cmd: Command::List { project: None, quiet: false },
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains(r#""peer":"laptop""#) && line.contains(r#""from_task":"w1""#), "{line}");
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
    }

    fn shop_project() -> ProjectInfo {
        ProjectInfo {
            id: "p2".into(),
            name: "shop".into(),
            root_path: "/src/shop-host".into(),
            tasks: 0,
            default_agent: "claude".into(),
            project_type: "multi".into(),
            members: vec![
                ProjectMemberInfo {
                    name: "api".into(),
                    root_path: "/src/api".into(),
                    non_git: false,
                    base_branch: "origin/main".into(),
                },
                ProjectMemberInfo { name: "docs".into(), root_path: "/src/docs".into(), non_git: true, base_branch: String::new() },
            ],
        }
    }

    #[test]
    fn project_info_names_its_type_as_the_app_does_and_omits_no_members() {
        // `type`, not `project_type`: the key projects.json and the webview's
        // `Project.type` use.
        let v = serde_json::to_value(shop_project()).unwrap();
        assert_eq!(v["type"], "multi");
        assert_eq!(v["members"][1]["non_git"], true);
        let single = ProjectInfo { project_type: "single".into(), ..ProjectInfo::default() };
        let v = serde_json::to_value(&single).unwrap();
        assert!(v.get("members").is_none(), "{v}");
        // A v23 server's row (neither key) still parses.
        let old = r#"{"id":"p1","name":"web","root_path":"/r","tasks":0,"default_agent":"claude"}"#;
        let p: ProjectInfo = serde_json::from_str(old).unwrap();
        assert_eq!((p.project_type.as_str(), p.members.len()), ("", 0));
    }

    #[test]
    fn peer_unreachable_has_its_own_exit_code() {
        // Scripts branch on "the other machine is off" vs "it refused": 12 is
        // nothing ran there, 6 is it said no.
        assert_eq!(ErrorCode::PeerUnreachable.exit_code(), exit_code::PEER_UNREACHABLE);
        assert_eq!(exit_code::PEER_UNREACHABLE, 12);
        let line = serde_json::to_string(&ErrorCode::PeerUnreachable).unwrap();
        assert_eq!(line, r#""peer_unreachable""#);
    }

    #[test]
    fn peers_data_names_this_machine_self_on_the_wire() {
        let d = PeersData {
            this: PeerSelf { id: "a".into(), name: "Studio".into(), sharing: true, addresses: vec![] },
            peers: vec![],
            nearby: vec![],
        };
        let v = serde_json::to_value(ReplyData::Peers(d)).unwrap();
        assert_eq!(v["kind"], "peers");
        assert_eq!(v["self"]["name"], "Studio");
    }

    #[test]
    fn result_command_and_reply_use_the_result_wire_tag() {
        // The variant is named LastResult only to dodge the std Result
        // name in code; the WIRE tag is "result" and is contract.
        let req = Request {
            id: "r1".into(),
            token: Some("t".into()),
            profile: None,
            peer: None,
            from_task: None,
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
            props: Default::default(),
            id: "w1".into(),
            name: "fix-auth".into(),
            project: "web".into(),
            agent: "claude".into(),
            agent_args: vec!["--model".into(), "worker".into()],
            branch: "fix-auth".into(),
            base_branch: "main".into(),
            path: "/Users/x/termic/tasks/web/fix-auth".into(),
            is_main_checkout: false,
            created: "2026-01-01T00:00:00Z".into(),
            work_state: Some("working".into()),
            open_tabs: Some(2),
            diff: Some(DiffStat { files_changed: 3, insertions: 10, deletions: 2, untracked: 1 }),
            group: None,
            spawned_by: None,
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
                            agent_args: Vec::new(),
                            id: "t1".into(),
                            index: 1,
                            kind: "agent".into(),
                            agent: "claude".into(),
                            title: "claude".into(),
                            state: Some("working".into()),
                            is_default: true,
                            live: true,
                            queued: 1,
                            props: vec![PropEntry { key: "ticket".into(), value: "ABC-1".into() }],
                        },
                        TabStatus {
                            agent_args: Vec::new(),
                            id: "t2".into(),
                            index: 2,
                            kind: "shell".into(),
                            agent: "shell".into(),
                            title: "Terminal".into(),
                            state: None,
                            is_default: false,
                            live: true,
                            queued: 0,
                            props: Vec::new(),
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
            ReplyData::Prop(PropData {
                task_id: "w1".into(),
                tab_id: Some("t1".into()),
                tabs: vec![TabProps {
                    tab_id: "t1".into(),
                    cli: "claude".into(),
                    title: "claude".into(),
                    props: vec![PropEntry { key: "ticket".into(), value: "ABC-1".into() }],
                }],
                collected: vec![CollectedProp { key: "ticket".into(), values: vec!["ABC-1".into()] }],
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
                    accounts: vec!["Work".into(), "Client A".into()],
                    default_account: Some("Work".into()),
                }],
            }),
            ReplyData::Prompts(PromptsData {
                prompts: vec![
                    PromptEntry {
                        review: false,
                        labels: Vec::new(),
                        id: "builtin:review".into(),
                        title: "Review".into(),
                        builtin: true,
                        enabled: true,
                        modified: false,
                        body: None,
                        truncated: false,
                    },
                    PromptEntry {
                        review: false,
                        labels: Vec::new(),
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
                agent_args: Vec::new(),
                task_id: "w1".into(),
                tab_id: "3f1c-…".into(),
                cli: "claude".into(),
                title: "claude".into(),
                prompt: None,
            }),
            ReplyData::Tab(TabData {
                agent_args: Vec::new(),
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
                projects: vec![
                    ProjectInfo {
                        id: "p1".into(),
                        name: "web".into(),
                        root_path: "/repo/web".into(),
                        tasks: 3,
                        default_agent: "claude".into(),
                        project_type: "single".into(),
                        members: Vec::new(),
                    },
                    shop_project(),
                ],
            }),
            ReplyData::Pad(PadData {
                task_id: "w1".into(),
                pads: vec![PadInfo { id: "p1".into(), title: "findings".into(), syntax: None, open: true }],
                content: Some("text".into()),
                truncated: true,
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
            ReplyData::Schedule(ScheduleData {
                schedules: vec![ScheduleSummary {
                    task_id: "w1".into(),
                    task_name: "parent-1".into(),
                    project_id: "p1".into(),
                    project_name: "web".into(),
                    name: "nightly run".into(),
                    slug: "nightly-run".into(),
                    enabled: true,
                    cadence: ScheduleCadence { kind: "daily".into(), time: "09:00".into(), weekday: None, date: None },
                    prompt: Some("check status".into()),
                    prompt_id: None,
                    next_run: Some(1728400000),
                    last_slot: Some(1728300000),
                    last_outcome: Some("fired".into()),
                    keep_runs: 7,
                    report_days: Some(30),
                    catch_up: false,
                }],
                schedule: None,
                history: Vec::new(),
                run_result: None,
                deleted: false,
            }),
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
    fn tab_titles_refuse_what_a_selector_could_never_reach() {
        assert_eq!(tab_title_problem(""), None, "\"\" is the automatic title");
        assert_eq!(tab_title_problem("reviewer"), None);
        assert_eq!(tab_title_problem(" reviewer "), None, "trimmed, not refused");
        assert_eq!(tab_title_problem("agent 2"), None, "digits inside a title are fine");
        assert!(tab_title_problem("   ").unwrap().contains("blank"));
        assert!(tab_title_problem("2").unwrap().contains("number"));
        assert!(tab_title_problem(" 12 ").unwrap().contains("number"));
    }

    #[test]
    fn prop_keys_and_values_are_validated_not_escaped() {
        for ok in ["status", "ticket", "a", "sp-points", "x_1", "2fa"] {
            assert_eq!(prop_key_problem(ok), None, "{ok}");
        }
        for bad in ["", "Status", "-x", "_x", "a b", "a.b", "ă"] {
            assert!(prop_key_problem(bad).is_some(), "{bad:?}");
        }
        assert!(prop_key_problem(&"k".repeat(PROP_KEY_MAX + 1)).unwrap().contains("longer"));
        assert_eq!(prop_value_problem("ABC-1"), None);
        assert_eq!(prop_value_problem(""), None, "\"\" clears");
        assert_eq!(prop_value_problem(&format!("  {}  ", "v".repeat(PROP_VALUE_MAX))), None, "trimmed");
        assert!(prop_value_problem(&"v".repeat(PROP_VALUE_MAX + 1)).unwrap().contains("longer"));
        assert!(prop_value_problem("a\nb").unwrap().contains("one line"));
        assert!(prop_value_problem("a\u{1b}[31m").is_some());
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
