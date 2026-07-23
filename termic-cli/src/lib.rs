//! `termic`: thin client for the Termic app's control socket.
//!
//! Phase 0 verbs: `list` (alias `ls`), `status`, `open`. The app is the
//! daemon; this binary holds no state, reads none of termic's data
//! files, and links only `termic-proto` (docs/plans/cli.md). Exit codes
//! and `--output-format json` shapes are a public contract: see
//! `termic_proto::exit_code` and the per-command help.

use clap::{Parser, Subcommand, ValueEnum};
use termic_proto as proto;
use termic_proto::exit_code;

pub mod client;
pub mod output;

/// The version `termic --version` prints. It is the APP version, injected
/// at build time via `TERMIC_APP_VERSION` (src-tauri/build.rs and
/// scripts/build-cli.mjs), so a bundled CLI matches the app it ships in. A
/// bare `cargo build -p termic-cli` with no env set falls back to the crate
/// version. See build.rs for the rebuild tracking.
const VERSION: &str = match option_env!("TERMIC_APP_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

/// One error the binary exits on: pinned code + message for stderr.
#[derive(Debug, PartialEq)]
pub struct CliError {
    pub code: i32,
    pub message: String,
}

impl CliError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        CliError { code, message: message.into() }
    }
}

/// Exit-code contract, shown in --help so scripts can branch on it
/// without reading the source. 3, 7, 9 and 10 are pinned for later
/// phases and never repurposed.
const EXIT_CODES_HELP: &str = "Exit codes:
  0   success
  1   error (bad task or project name, ambiguity, server failure)
  2   usage error (reserved for argument parsing)
  4   Termic is not running (--no-launch), or did not start after launch
  5   the CLI is disabled in Termic Settings
  6   refused: bad or missing token, or this shell is inside a sandboxed task
  8   connection to Termic lost mid-command
Pinned for later phases: 3 agent needs input, 7 wait timeout,
9 prompt not delivered, 10 apply left main conflicted.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[derive(Parser, Debug)]
#[command(
    name = "termic",
    bin_name = "termic",
    version = VERSION,
    about = "Control the Termic app from any shell: list tasks, check one task, focus the window.",
    long_about = "Control the Termic app from any shell. The app is the daemon: every command \
talks to the running Termic over a local socket and fails fast when it cannot. \
Requires the CLI to be enabled in Termic Settings (General).",
    after_help = EXIT_CODES_HELP
)]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Cmd,

    /// Output format for read verbs. `json` prints exactly one JSON
    /// object on stdout; its fields only ever grow (additive contract).
    #[arg(long, global = true, value_enum, default_value_t = OutputFormat::Text)]
    pub output_format: OutputFormat,

    /// Shorthand for --output-format json.
    #[arg(long, global = true)]
    pub json: bool,

    /// Fail (exit 4) instead of auto-launching Termic when it is not running.
    #[arg(long, global = true)]
    pub no_launch: bool,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// List tasks: name, project, agent, work state, diff stat, branch.
    #[command(
        visible_alias = "ls",
        after_help = "Prints one row per task on stdout; with -q, task ids only. \
With --output-format json, one object: {\"tasks\": [...]} where each task carries \
id, name, project, agent, branch, base_branch, path, work_state (\"working\", \
\"waiting\", \"done\", \"idle\", or null when the UI could not answer), open_tabs \
and diff {files_changed, insertions, deletions, untracked}.

Exit codes: 0 success, 1 unknown project, 4 app not running, 5 CLI disabled, \
6 refused, 8 connection lost."
    )]
    List {
        /// Print task ids only, one per line.
        #[arg(short, long)]
        quiet: bool,
        /// Only tasks of this project (name).
        #[arg(long)]
        project: Option<String>,
    },

    /// Show one task in depth: agent state, branch, dirty file count, sessions.
    #[command(
        after_help = "Prints `key: value` lines on stdout. With --output-format json, one \
object: {\"task\": {...}} with the list fields plus sandbox, sessions and \
dirty_files. Use --project (or project/name) when the name exists in more \
than one project.

Exit codes: 0 success, 1 unknown or ambiguous task, 4 app not running, \
5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Status {
        /// Task name, task id, or qualified project/name.
        task: String,
        /// Project name, to disambiguate.
        #[arg(long)]
        project: Option<String>,
    },

    /// Raise the Termic window and select a task (current directory aware).
    #[command(
        after_help = "Without <TASK>, resolves the task from the current directory: task \
worktrees first, then the longest registered project path (main-checkout \
tasks). When nothing resolves, the window is still raised. Prints what was \
opened on stdout; with --output-format json, one object: {\"task\": {...}|null, \
\"raised\": true}.

Exit codes: 0 success, 1 unknown or ambiguous task, 4 app not running, \
5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Open {
        /// Task name, task id, or qualified project/name.
        task: Option<String>,
        /// Project name, to disambiguate. Only meaningful with a task name,
        /// so it requires one (it cannot select a task on its own).
        #[arg(long, requires = "task")]
        project: Option<String>,
    },
}

pub fn run() -> i32 {
    // clap exits 2 on usage/parse errors itself; 2 stays reserved for it.
    let cli = Cli::parse();
    match execute(&cli) {
        Ok(stdout) => {
            if !stdout.is_empty() {
                println!("{stdout}");
            }
            exit_code::OK
        }
        Err(e) => {
            eprintln!("termic: {}", e.message);
            e.code
        }
    }
}

fn execute(cli: &Cli) -> Result<String, CliError> {
    // In-cage pre-check (docs/plans/cli.md, Security DX): caged agents
    // get NO CLI surface. TERMIC_SANDBOX=1 is injected into every caged
    // spawn, so fail with the real reason instead of a token error.
    if std::env::var("TERMIC_SANDBOX").is_ok_and(|v| v == "1") {
        return Err(CliError::new(
            exit_code::REFUSED,
            "this shell is inside a sandboxed termic task, the control plane is unavailable",
        ));
    }

    let format = if cli.json { OutputFormat::Json } else { cli.output_format };
    let paths = client::socket_paths();
    let mut conn = client::connect_or_launch(&paths, cli.no_launch)?;
    client::hello(&mut conn)?;
    let token = client::read_token(&paths)?;

    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let cmd = to_wire_command(&cli.cmd, format, cwd);
    let data = client::request(&mut conn, cmd, &token)?;
    render(&cli.cmd, format, data)
}

/// Map the parsed subcommand + effective output format to the wire
/// command. Pure so the format-dependent `quiet` logic is unit-testable.
pub fn to_wire_command(cmd: &Cmd, format: OutputFormat, cwd: Option<String>) -> proto::Command {
    match cmd {
        Cmd::List { project, quiet } => proto::Command::List {
            project: project.clone(),
            // `quiet` tells the server to SKIP the work-state query + diff.
            // Only do that when the text `-q` path (ids only) is what
            // renders. JSON always emits full objects, so it needs those
            // fields; blanking them there would read, per the contract, as
            // "the UI could not answer" - a different meaning entirely.
            quiet: *quiet && format == OutputFormat::Text,
        },
        Cmd::Status { task, project } => {
            proto::Command::Status { task: task.clone(), project: project.clone() }
        }
        Cmd::Open { task, project } => proto::Command::Open {
            task: task.clone(),
            project: project.clone(),
            cwd,
        },
    }
}

/// Turn a successful reply into stdout text. Pure, unit-tested.
pub fn render(cmd: &Cmd, format: OutputFormat, data: proto::ReplyData) -> Result<String, CliError> {
    let unexpected =
        |what: &str| CliError::new(exit_code::ERROR, format!("unexpected reply to {what}"));
    match (cmd, data) {
        (Cmd::List { quiet, .. }, proto::ReplyData::List(list)) => Ok(match format {
            OutputFormat::Json => output::json(&list),
            OutputFormat::Text if *quiet => output::list_quiet(&list.tasks),
            OutputFormat::Text => output::list_text(&list.tasks),
        }),
        (Cmd::Status { .. }, proto::ReplyData::Status(status)) => Ok(match format {
            OutputFormat::Json => output::json(&status),
            OutputFormat::Text => output::status_text(&status.task),
        }),
        (Cmd::Open { .. }, proto::ReplyData::Open(open)) => Ok(match format {
            OutputFormat::Json => output::json(&open),
            OutputFormat::Text => output::open_text(&open),
        }),
        (Cmd::List { .. }, _) => Err(unexpected("list")),
        (Cmd::Status { .. }, _) => Err(unexpected("status")),
        (Cmd::Open { .. }, _) => Err(unexpected("open")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clap_definition_is_coherent() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn open_project_requires_a_task() {
        // `--project` only disambiguates a named task, so it cannot be used
        // without one (silently ignoring it would be the worst outcome).
        assert!(Cli::try_parse_from(["termic", "open", "--project", "web"]).is_err());
        // The valid forms still parse.
        assert!(Cli::try_parse_from(["termic", "open"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "open", "foo"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "open", "foo", "--project", "web"]).is_ok());
    }

    #[test]
    fn help_carries_no_em_dashes() {
        use clap::CommandFactory;
        let mut cmd = Cli::command();
        let mut all = format!("{}", cmd.render_long_help());
        for sub in ["list", "status", "open"] {
            let mut c = Cli::command();
            let s = c.find_subcommand_mut(sub).unwrap();
            all.push_str(&format!("{}", s.render_long_help()));
        }
        assert!(!all.contains('\u{2014}'), "copy rule: no em dashes in help text");
        let _ = cmd;
    }

    #[test]
    fn render_list_json_shape() {
        let list = proto::ListData {
            tasks: vec![proto::TaskSummary { id: "a".into(), name: "n".into(), ..Default::default() }],
        };
        let out = render(
            &Cmd::List { quiet: false, project: None },
            OutputFormat::Json,
            proto::ReplyData::List(list),
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["tasks"][0]["id"], "a");
        // The wire's internal "kind" tag must not leak into CLI output.
        assert!(v.get("kind").is_none());
    }

    #[test]
    fn render_quiet_lists_ids_only() {
        let list = proto::ListData {
            tasks: vec![
                proto::TaskSummary { id: "id-1".into(), name: "one".into(), ..Default::default() },
                proto::TaskSummary { id: "id-2".into(), name: "two".into(), ..Default::default() },
            ],
        };
        let out = render(
            &Cmd::List { quiet: true, project: None },
            OutputFormat::Text,
            proto::ReplyData::List(list),
        )
        .unwrap();
        assert_eq!(out, "id-1\nid-2");
    }

    #[test]
    fn quiet_skips_server_work_only_for_text_output() {
        let list = |quiet| Cmd::List { quiet, project: None };
        // -q in text: ask the server to skip work_state + diff (ids only).
        assert!(matches!(
            to_wire_command(&list(true), OutputFormat::Text, None),
            proto::Command::List { quiet: true, .. }
        ));
        // -q with JSON must NOT skip: the JSON emits full objects, and a
        // blanked work_state/diff would read as "UI could not answer".
        assert!(matches!(
            to_wire_command(&list(true), OutputFormat::Json, None),
            proto::Command::List { quiet: false, .. }
        ));
        // No -q: never quiet on the wire.
        assert!(matches!(
            to_wire_command(&list(false), OutputFormat::Text, None),
            proto::Command::List { quiet: false, .. }
        ));
    }

    #[test]
    fn render_mismatched_reply_is_an_error() {
        let err = render(
            &Cmd::List { quiet: false, project: None },
            OutputFormat::Text,
            proto::ReplyData::Open(proto::OpenData { task: None, raised: true }),
        )
        .unwrap_err();
        assert_eq!(err.code, exit_code::ERROR);
    }
}
