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
pub const PROTOCOL_VERSION: u32 = 1;

/// Socket + token file names inside the app's data dir.
pub const SOCKET_FILE: &str = "termic.sock";
pub const TOKEN_FILE: &str = "cli-token";

/// Exact user-facing error for the disabled-CLI path (docs/plans/cli.md,
/// Landing). The server sends it; the CLI prints it verbatim and exits
/// with `exit_code::CLI_DISABLED`.
pub const CLI_DISABLED_MESSAGE: &str =
    "Termic is running but the CLI is disabled, enable it in Settings";

/// Printed by the CLI when the server's protocol version differs.
pub const VERSION_MISMATCH_MESSAGE: &str = "Termic updated, rerun your command";

/// Hard cap on a single NDJSON line, both directions. A request or reply
/// larger than this is a bug or an attack, not traffic.
pub const MAX_LINE_BYTES: u64 = 1024 * 1024;

/// The pinned exit-code contract (docs/plans/cli.md, Command surface).
/// Public API once shipped: scripts branch on these numbers. 2 is
/// RESERVED because clap already exits 2 on usage errors; domain codes
/// start at 3 in the spec's order. Phase 0 only produces 0, 1, 2, 4, 5,
/// 6 and 8; the rest are pinned now so later phases cannot renumber.
pub mod exit_code {
    /// Success (for `--wait` verbs later: agent settled done).
    pub const OK: i32 = 0;
    /// Generic error.
    pub const ERROR: i32 = 1;
    /// Usage / parse error. Reserved for clap; never used for domain errors.
    pub const USAGE: i32 = 2;
    /// Agent stopped needing input (attention), later phases.
    pub const AGENT_NEEDS_INPUT: i32 = 3;
    /// App not running (under --no-launch) or did not start after launch.
    pub const APP_NOT_RUNNING: i32 = 4;
    /// CLI disabled in Settings.
    pub const CLI_DISABLED: i32 = 5;
    /// Refused: auth or scope (bad/missing token, in-cage caller).
    pub const REFUSED: i32 = 6;
    /// --wait --timeout expiry, later phases.
    pub const WAIT_TIMEOUT: i32 = 7;
    /// Connection lost mid-command (app quit under us).
    pub const CONNECTION_LOST: i32 = 8;
    /// Prompt never delivered, later phases.
    pub const PROMPT_NOT_DELIVERED: i32 = 9;
    /// Apply left main conflicted, later phases.
    pub const APPLY_CONFLICT: i32 = 10;
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
    /// One task in depth.
    Status {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project: Option<String>,
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
            error: Some(ErrorBody { code, message: message.into() }),
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
            | ErrorCode::Internal => exit_code::ERROR,
        }
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

/// Version-gate helper: the CLI calls this with the server's hello.
pub fn check_protocol(server_protocol: u32) -> Result<(), String> {
    if server_protocol == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(VERSION_MISMATCH_MESSAGE.to_string())
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
            Command::Status { task: "fix-auth".into(), project: Some("web".into()) },
            Command::Open { task: None, project: None, cwd: Some("/tmp/x".into()) },
            Command::Open { task: Some("fix-auth".into()), project: None, cwd: None },
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
        ] {
            roundtrip(&Reply::ok("r1", data));
        }
        roundtrip(&Reply::err("r1", ErrorCode::CliDisabled, CLI_DISABLED_MESSAGE));
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
    fn version_mismatch_message() {
        assert!(check_protocol(PROTOCOL_VERSION).is_ok());
        let msg = check_protocol(PROTOCOL_VERSION + 1).unwrap_err();
        assert_eq!(msg, VERSION_MISMATCH_MESSAGE);
        assert!(!msg.contains('\u{2014}'), "copy rule: no em dashes");
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
        for s in [CLI_DISABLED_MESSAGE, VERSION_MISMATCH_MESSAGE] {
            assert!(!s.contains('\u{2014}'), "em dash in {s:?}");
        }
    }
}
