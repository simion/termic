//! `termic`: thin client for the Termic app's control socket.
//!
//! Verbs: `list` (alias `ls`), `status`, `open` (Phase 0); `new`,
//! `wait`, `archive`, `project add|list|remove`, `help --json`
//! (Phase 1). The app is the daemon; this binary holds no state, reads
//! none of termic's data files, and links only `termic-proto`
//! (docs/plans/cli.md). Exit codes and `--output-format` shapes are a
//! public contract: see `termic_proto::exit_code` and the per-command
//! help. Help copy is written for LLM agents as much as humans: every
//! verb states what it does, what it prints on stdout, and its exit
//! codes inline (`termic help --json` returns the whole surface
//! machine-readably).

use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use std::io::Read as _;
use termic_proto as proto;
use termic_proto::exit_code;

pub mod attach;
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

/// What a successful command run produces: the final stdout text plus
/// the exit code. Watched runs (`wait`, `new --wait`) succeed with
/// NON-ZERO codes (3 needs input, 7 timeout, 9 not delivered) while
/// still printing their result object, so scripts can parse stdout AND
/// branch on the code.
#[derive(Debug, PartialEq)]
pub struct Output {
    pub stdout: String,
    pub code: i32,
}

impl Output {
    fn ok(stdout: String) -> Self {
        Output { stdout, code: exit_code::OK }
    }
}

/// Exit-code contract, shown in --help so scripts can branch on it
/// without reading the source.
const EXIT_CODES_HELP: &str = "Exit codes:
  0   success (watched runs: the agent settled done; attach: clean detach)
  1   error (bad task or project name, ambiguity, server failure)
  2   usage error (reserved for argument parsing)
  3   the agent stopped but is asking for input (wait, new/send --wait)
  4   Termic is not running (--no-launch), or did not start after launch
  5   the CLI is disabled in Termic Settings
  6   refused: bad or missing token, or this shell is inside a sandboxed task
  7   --timeout expired (the task keeps running)
  8   connection to Termic lost mid-command
  9   the prompt was never delivered (new/send --wait)
  10  apply left the main checkout conflicted (resolve or reset there)
  11  the attach target closed underneath the session (agent exited or task archived)
A closed output pipe ends the process via SIGPIPE (shells report 141),
the standard unix behavior.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
    /// NDJSON: one line per streamed event, ending in exactly one
    /// result line (streaming verbs; read verbs emit the result only).
    StreamJson,
}

#[derive(Parser, Debug)]
#[command(
    name = "termic",
    bin_name = "termic",
    version = VERSION,
    disable_help_subcommand = true,
    about = "Control the Termic app from any shell: create and drive agent tasks, list them, wait on them.",
    long_about = "Control the Termic app from any shell. The app is the daemon: every command \
talks to the running Termic over a local socket and fails fast when it cannot. \
Requires the CLI to be enabled in Termic Settings (General). \
`termic help --json` prints the whole command surface machine-readably.",
    after_help = EXIT_CODES_HELP
)]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Cmd,

    /// Output format. `json` prints exactly one JSON object on stdout;
    /// `stream-json` prints NDJSON events ending in one result line.
    /// Fields only ever grow (additive contract).
    #[arg(long, global = true, value_enum, default_value_t = OutputFormat::Text)]
    pub output_format: OutputFormat,

    /// Shorthand for --output-format json.
    #[arg(long, global = true, conflicts_with = "output_format")]
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
\"waiting\", \"done\", \"idle\", \"inactive\"; omitted when the UI could not answer), \
open_tabs and diff {files_changed, insertions, deletions, untracked}.

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
dirty_files. Without <TASK>, resolves the task from the current directory \
(worktrees first, then main-checkout tasks), like `open`. Use --project \
(or project/name) when the name exists in more than one project.

Exit codes: 0 success, 1 unknown or ambiguous task, 4 app not running, \
5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Status {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory, like `open`.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
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

    /// Create a task and start its agent; optionally inject a prompt.
    #[command(
        after_help = "Creates the task exactly as the New Task dialog would: the project \
resolves from a <project>/<name> qualified name, --project, or the current \
directory (task worktrees first, then registered project roots; an \
unregistered git repo offers registration on a TTY), the agent falls back \
to the project default, the mode to the GUI's remembered choice, and the \
sandbox to the project seeds. Streams setup-script \
output to stdout until the agent spawns, then prints the task (name, branch, \
path, agent). -p - reads the prompt from stdin.

Without --wait the command returns at spawn; a prompt keeps injecting \
app-side but is NOT confirmed. With --wait it blocks until the prompt is \
confirmed delivered AND that turn settles (or, with no prompt, until the \
agent is quiescent). Settle detection is heuristic: exit 0 means the agent \
STOPPED, not that the work is right. Ctrl-C stops watching only; the task \
keeps running in Termic.

Getting results out: the agent's terminal output is not readable from the \
CLI. For a machine-readable result, tell the agent IN THE PROMPT to write \
its deliverable to a file in the task directory (for example: \"write your \
findings to RESULT.md\"), then read <path>/RESULT.md after --wait exits 0. \
The path is printed at creation and is .task.path in the --json output. \
Unattended runs should also pass --sandbox enforce (permission prompts \
self-approve inside the cage) or --yolo, or the agent will stop to ask.

With --output-format json, one object at the end: {\"task\": {...}, \
\"wait\": {\"outcome\", \"state\"}} (wait omitted without --wait). With \
stream-json, NDJSON events (setup_output, created, prompt_delivered, state, \
heartbeat) ending in one {\"event\":\"result\", ...} line. Errors print to \
stderr only; no result line is emitted on error.

Exit codes: 0 created (with --wait: settled done), 1 error (bad name, \
unknown project or agent, duplicate task), 3 agent stopped needing input, \
4 app not running, 5 CLI disabled, 6 refused, 7 --timeout expired, \
8 connection lost, 9 prompt never delivered."
    )]
    New {
        /// Task name (seeds the branch for worktree tasks). A
        /// <project>/<name> prefix targets that project, like the
        /// other verbs; with --project the name stays literal.
        name: String,
        /// Prompt to inject once the agent is ready. `-` reads stdin.
        #[arg(short, long)]
        prompt: Option<String>,
        /// Agent CLI id (claude, codex, ...). Default: the project's default agent.
        #[arg(long)]
        agent: Option<String>,
        /// Create an isolated git worktree for the task (the default is
        /// the GUI's remembered mode).
        #[arg(long, conflicts_with = "main")]
        worktree: bool,
        /// Open the agent in the repo's live main checkout instead of a worktree.
        #[arg(long)]
        main: bool,
        /// Base branch for the worktree (default: the repo's default base).
        #[arg(long, conflicts_with = "main")]
        base: Option<String>,
        /// Sandbox mode for the task. Default: the project's sandbox seeds.
        #[arg(long, value_parser = ["off", "monitor", "enforce", "enforce-fs"])]
        sandbox: Option<String>,
        /// Skip agent permission prompts (the agent's YOLO flag).
        #[arg(long)]
        yolo: bool,
        /// Project name (default: resolved from the current directory).
        #[arg(long)]
        project: Option<String>,
        /// Select the new task in the GUI and raise the window.
        #[arg(long)]
        open: bool,
        /// Block until the injected prompt's turn settles (delivery
        /// confirmed), or until the agent is quiescent without a prompt.
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this long (exit 7). E.g. 90, 30s, 5m, 1h.
        #[arg(long, requires = "wait", value_name = "DURATION")]
        timeout: Option<String>,
    },

    /// Block until the task's agent is quiescent (settled, empty queue).
    #[command(
        after_help = "Quiescent means the agent settled AND its message queue is empty, so a \
prompt queued behind the current turn still counts as running. Without \
<TASK>, resolves the task from the current directory, like `open`. Refuses tasks \
with no open agent, and agents whose work-done detection is disabled (there \
is no settle signal to wait on). Settle detection is heuristic: exit 0 means \
the agent STOPPED, not that the work is right.

--tab narrows the wait to ONE tab of the task: pass a tab id (as printed \
by `termic tab` and `termic status`), a 1-based index into status's tab \
list, or a tab title. Only that tab's state and queue then count; a \
sibling tab can neither satisfy nor stall the wait. A title matching more \
than one tab is an error listing them; use the index or the id.

Prints the final state on stdout. With --output-format json, one object: \
{\"task_id\", \"outcome\": \"done\"|\"needs_input\"|\"timeout\", \"state\"}. With \
stream-json, NDJSON state/heartbeat events ending in one result line. \
Errors print to stderr only; no result line is emitted on error.

Exit codes: 0 agent settled done, 1 error (unknown task or tab, no agent \
open, detection disabled), 3 agent stopped needing input, 4 app not \
running, 5 CLI disabled, 6 refused, 7 --timeout expired, 8 connection lost."
    )]
    Wait {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory, like `open`.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
        /// Give up after this long (exit 7). E.g. 90, 30s, 5m, 1h.
        #[arg(long, value_name = "DURATION")]
        timeout: Option<String>,
        /// Wait on one tab: a tab id, 1-based index, or title.
        #[arg(long, value_name = "SEL")]
        tab: Option<String>,
    },

    /// Prompt the task's running agent; queues if it is mid-turn.
    #[command(
        after_help = "Targets the RUNNING agent (the default agent tab; --tab picks another: a \
tab id, a 1-based index into status's tab list, or a title, agent tabs \
only). If it is mid-turn and \
supports work-done detection, the prompt QUEUES and delivers when the turn \
finishes; an agent with detection disabled gets it typed immediately (with a \
warning: completion cannot be observed, and --wait refuses such agents). \
With no agent running, --resume restores the last session and --fresh starts \
a new agent without context; without either flag that case is an error \
naming both. If a stored session no longer resolves, --resume falls back to \
a fresh agent and the prompt still delivers there (the app's own recovery \
path). -p - reads the prompt from stdin, so `git diff | termic send \
foo -p -` works. --here targets the surrounding task ($TERMIC_TASK_ID); \
without <TASK> or --here the task resolves from the current directory.

Without --wait the command returns once the prompt is delivered (queued and \
respawn deliveries stay unconfirmed). With --wait it blocks until the \
prompt is confirmed delivered AND that turn settles, the same contract as \
new --wait; settle detection is heuristic (the agent STOPPED, not that the \
work is right), and because a sibling tab's state is never trusted as this \
prompt's turn, a very short turn can take up to 30s extra to report done; \
size --timeout accordingly. Each --fresh adds a NEW agent tab to the task \
(none are reused or closed). Ctrl-C stops watching only.

Prints the delivery mode (or the wait outcome) on stdout. With \
--output-format json, one object: {\"task_id\", \"mode\": \
\"delivered\"|\"queued\"|\"spawned\", \"capable\", \"wait\": {\"outcome\", \
\"state\"}} (wait omitted without --wait). With stream-json, NDJSON events \
(queued, prompt_delivered, state, heartbeat) ending in one \
{\"event\":\"result\", ...} line.

Exit codes: 0 delivered (with --wait: settled done), 1 error (unknown task, \
no agent running without --resume/--fresh, nothing to resume), 3 agent \
stopped needing input, 4 app not running, 5 CLI disabled, 6 refused, \
7 --timeout expired, 8 connection lost, 9 prompt never delivered."
    )]
    Send {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory (or --here).
        task: Option<String>,
        /// Target the task this shell runs inside ($TERMIC_TASK_ID).
        #[arg(long, conflicts_with = "task")]
        here: bool,
        /// The prompt. `-` reads stdin.
        #[arg(short, long)]
        prompt: String,
        /// No agent running: restore the last session, then deliver.
        #[arg(long)]
        resume: bool,
        /// No agent running: start a fresh agent (no context), then deliver.
        #[arg(long, conflicts_with = "resume")]
        fresh: bool,
        /// Block until the prompt is confirmed delivered and its turn
        /// settles (or the agent asks for input).
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this long (exit 7). E.g. 90, 30s, 5m, 1h.
        #[arg(long, requires = "wait", value_name = "DURATION")]
        timeout: Option<String>,
        /// Deliver to one tab: a tab id, 1-based index, or title (agent
        /// tabs only; --resume/--fresh spawn, a --tab target is open).
        #[arg(long, value_name = "SEL", conflicts_with_all = ["resume", "fresh"])]
        tab: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
    },

    /// Attach this terminal to the task's agent (raw TTY, like tmux).
    #[command(
        after_help = "Interactive: keystrokes go to the agent, its output renders here, and the \
retained backlog replays on entry so the screen is not blank. Detach with \
ctrl-\\ (configurable via --detach-keys, Docker's grammar: single keys or \
ctrl-<x> chords, comma-separated); detaching never stops the agent. \
NON-resizing by default: the Termic pane owns the PTY size, and resizing \
under it is tmux's smallest-client problem; --resize opts in (SIGWINCH \
follows this terminal). --shell attaches to the task's aux terminal \
instead of the agent; --tab attaches to one strip tab (a tab id, a \
1-based index into status's tab list, or a title; agent tabs only, since \
shell and terminal tabs are write-only from the CLI). The aux terminal is \
not a strip tab, so --shell and --tab exclude each other. Without <TASK>, \
resolves from the current directory.

Not scriptable: needs a real TTY on stdin and stdout (use logs to read \
output non-interactively). --output-format is ignored.

Exit codes: 0 detached (the task keeps running), 1 error (unknown task or \
tab, no agent or aux terminal open, no TTY), 4 app not running, 5 CLI \
disabled, 6 refused, 8 connection lost (Termic quit mid-session), 11 the \
target closed underneath the session (agent exited or task archived)."
    )]
    Attach {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
        /// Attach to the task's aux terminal instead of the agent.
        #[arg(long)]
        shell: bool,
        /// Attach to one tab: a tab id, 1-based index, or title.
        #[arg(long, value_name = "SEL", conflicts_with = "shell")]
        tab: Option<String>,
        /// Follow this terminal's size (SIGWINCH -> PTY resize). Off by
        /// default: the Termic pane owns the PTY size.
        #[arg(long)]
        resize: bool,
        /// Detach key sequence (Docker grammar: e.g. ctrl-\\ or ctrl-p,ctrl-q).
        #[arg(long, value_name = "SEQ", default_value = "ctrl-\\")]
        detach_keys: String,
    },

    /// Print the agent's recent terminal output (server-side backlog).
    #[command(
        after_help = "Dumps the retained tail of the agent PTY's output (a 256 KB ring, ANSI \
escapes intact; long tails are trimmed to fit the 1 MB reply line once \
JSON-escaped) to stdout; --shell reads the aux terminal instead, --tab \
reads one strip tab (a tab id, a 1-based index into status's tab list, or \
a title; agent tabs only, since shell and terminal tabs retain no output). \
This is the rendered terminal stream, useful for a quick look; for the \
agent's structured answer prefer `termic result` or the RESULT.md file \
convention. A note goes to stderr when older output was already dropped. \
Without <TASK>, resolves from the current directory.

With --output-format json, one object: {\"task_id\", \"source\": \
\"agent\"|\"aux\", \"data\", \"truncated\"}.

Exit codes: 0 success, 1 error (unknown task or tab, no agent or aux \
terminal open), 4 app not running, 5 CLI disabled, 6 refused, \
8 connection lost."
    )]
    Logs {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
        /// Read the task's aux terminal instead of the agent.
        #[arg(long)]
        shell: bool,
        /// Read one tab: a tab id, 1-based index, or title.
        #[arg(long, value_name = "SEL", conflicts_with = "shell")]
        tab: Option<String>,
        /// Print only the last N bytes of the retained tail.
        #[arg(long, value_name = "BYTES")]
        bytes: Option<u64>,
    },

    /// Print the agent's last message, read from its session transcript.
    #[command(
        after_help = "Reads the task agent's most recent message from its on-disk session \
transcript (claude only today; other agents get an error pointing at the \
file convention: prompt the agent to write RESULT.md, then read it from the \
task path). The transcript pinned by the task's stored session id wins; \
otherwise the newest session for the task directory. Without <TASK>, \
resolves from the current directory.

Prints the message text on stdout. With --output-format json, one object: \
{\"task_id\", \"agent\", \"transcript\", \"text\"}.

Exit codes: 0 success, 1 error (unknown task, unsupported agent, no \
transcript or message yet), 4 app not running, 5 CLI disabled, 6 refused, \
8 connection lost."
    )]
    Result {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
    },

    /// Show the task's diff vs its base branch (summary, or --full patch).
    #[command(
        after_help = "Summarizes the task's cumulative diff against its base branch: commits + \
staged + unstaged + untracked, the same counting as the GUI diff pane. \
--full prints the unified patch itself on stdout (and nothing else), so it \
pipes; a patch too large for the 1 MB reply line (measured JSON-escaped) \
arrives truncated with an explicit marker. \
Main-checkout tasks diff the shared checkout. Without <TASK>, resolves \
from the current directory.

With --output-format json, one object: {\"task_id\", \"files_changed\", \
\"insertions\", \"deletions\", \"untracked\", \"commits\", \"diff\"} (diff \
only under --full).

Exit codes: 0 success, 1 error (unknown or ambiguous task, git failure), \
4 app not running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Diff {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
        /// Print the full unified patch instead of the summary.
        #[arg(long)]
        full: bool,
    },

    /// Apply the task's diff to the project's main checkout (uncommitted).
    #[command(
        after_help = "The GUI's \"send diff to main\": the task's cumulative diff (tracked \
changes patched via git apply --3way, untracked files copied) lands as \
UNCOMMITTED changes in the project's main checkout. Not a merge: no \
commits are made, the task and its worktree survive, and re-running \
re-applies. Refuses a dirty main checkout (commit or stash there first) \
and main-checkout tasks (they ARE the main checkout). If the --3way \
fallback hits drifted lines, conflict markers are left IN THE MAIN \
CHECKOUT and the exit code says so. Asks for confirmation on a TTY unless \
--yes; non-interactive runs REQUIRE --yes.

Prints what was applied on stdout. With --output-format json, one object: \
{\"task_id\", \"tracked_files\", \"untracked_files\"}.

Exit codes: 0 applied, 1 error (unknown task, dirty main, git failure, \
declined), 4 app not running, 5 CLI disabled, 6 refused, 8 connection \
lost, 10 apply left the main checkout conflicted (resolve or reset there)."
    )]
    Apply {
        /// Task name, task id, or qualified project/name.
        task: String,
        /// Project name, to disambiguate.
        #[arg(long)]
        project: Option<String>,
        /// Skip the confirmation prompt (required non-interactively).
        #[arg(short, long)]
        yes: bool,
    },

    /// Print the task's worktree path: cd "$(termic path foo)".
    #[command(
        after_help = "Prints the task's absolute worktree path on stdout, nothing else. For a \
main-checkout task this is the SHARED project root (the cd lands in the \
live checkout). Without <TASK>, resolves from the current directory.

With --output-format json, one object: {\"task_id\", \"path\"}.

Exit codes: 0 success, 1 unknown or ambiguous task, 4 app not running, \
5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Path {
        /// Task name, task id, or qualified project/name. Omitted:
        /// resolved from the current directory.
        task: Option<String>,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
    },

    /// List the agents and custom terminals `tab` will accept.
    #[command(
        after_help = "Answers \"what can I pass to --agent or --terminal?\". The registry is \
per-user and editable in Settings, so it cannot live in static help.

`usable` is the field to branch on: enabled in Settings, and found on PATH \
where detection has an answer. `installed` is blank rather than false when \
detection has not run, which is not the same as missing. One inherited \
quirk: if detection resolves and finds NOTHING installed (a stripped GUI \
PATH), every enabled agent is reported usable rather than stranding you \
with an empty list, matching what the app's own menus do.

Prints a table on stdout. With --output-format json, one object: \
{\"agents\": [{\"id\", \"kind\", \"enabled\", \"installed\", \"usable\"}]}.

Exit codes: 0 listed, 1 error, 4 app not running, 5 CLI disabled, \
6 refused, 8 connection lost."
    )]
    Agents,
    /// Open a tab inside a running task: the "+" tab menu as a command.
    #[command(
        after_help = "Opens an agent, custom-terminal or shell tab in a task that is already \
running, and prints the new tab's id. That id is the stable selector: a \
tab's index shifts when another closes, and its title is agent-authored and \
changes mid-turn, so neither is safe for a script to key on.

Kinds are separate flags, not one --kind value, because they differ in \
SANDBOX behaviour: an agent tab inherits the task's sandbox pin, while \
terminal and shell tabs are uncaged exactly as the GUI's are. A mistyped \
kind must not silently downgrade a caged agent into an uncaged shell.

--agent takes a registry id and fails if it is unknown, disabled in \
Settings, or not installed, listing the ids that would work. The GUI just \
hides those; a CLI caller has no menu to look at. With no kind flag you get \
another tab of whatever the task already runs.

The new tab is NOT focused: a shell command should not yank the window you \
are working in.

-p injects a prompt into the NEW tab once its agent is ready (agent kinds \
only), through the same confirmed delivery route `send --tab` uses; the \
new tab's id is the target, so a second tab opening meanwhile cannot \
steal it. Without --wait the command returns once the injection is \
underway (mode \"spawned\" stays unconfirmed, like send); with --wait it \
blocks until the prompt is confirmed delivered AND that turn settles, the \
send --wait contract. -p - reads the prompt from stdin.

LIMITATION, --shell and --terminal only: those tabs are write-only from the \
CLI. They open, and you can use them in the window, but `attach` and `logs` \
cannot reach them and no output history is kept, because only agent tabs \
carry the PTY role those commands resolve against. That is deliberate: \
terminal tabs are never sandboxed (so git and ssh work), and putting an \
uncaged PTY on the control socket where it can be driven remotely is not \
something to do without a use case.

Prints the tab on stdout. With --output-format json, one object: \
{\"task_id\", \"tab_id\", \"cli\", \"title\", \"prompt\": {\"mode\", \
\"capable\", \"wait\"} (only with -p; wait only under --wait)}. With \
stream-json under -p, NDJSON events (queued, prompt_delivered, state, \
heartbeat) ending in one result line.

Exit codes: 0 opened (with --wait: settled done), 1 error (unknown or \
ambiguous task, unusable agent id, prompt on a non-agent tab), 3 agent \
stopped needing input, 4 app not running, 5 CLI disabled, 6 refused, \
7 --timeout expired, 8 connection lost, 9 prompt never delivered."
    )]
    Tab {
        /// Task name, task id, or qualified project/name.
        task: Option<String>,
        /// Project name, to disambiguate.
        #[arg(long, requires = "task")]
        project: Option<String>,
        /// Agent registry id (claude, codex, ...). Must be enabled and installed.
        #[arg(long, group = "tabkind")]
        agent: Option<String>,
        /// Custom terminal registry id (kind: "terminal" entries).
        #[arg(long, group = "tabkind")]
        terminal: Option<String>,
        /// A plain login shell, uncaged like the GUI's.
        #[arg(long, group = "tabkind")]
        shell: bool,
        /// Prompt to inject into the new tab once its agent is ready
        /// (agent kinds only). `-` reads stdin.
        #[arg(short, long, conflicts_with_all = ["shell", "terminal"])]
        prompt: Option<String>,
        /// Block until the prompt is confirmed delivered and its turn
        /// settles (or the agent asks for input).
        #[arg(long, requires = "prompt")]
        wait: bool,
        /// Give up waiting after this long (exit 7). E.g. 90, 30s, 5m, 1h.
        #[arg(long, requires = "wait", value_name = "DURATION")]
        timeout: Option<String>,
    },
    /// Quit Termic: every running agent dies with it. For the human at the keyboard, not for agents driving Termic.
    ///
    /// The only shell-side teardown for a windowless instance. Asks for
    /// confirmation on a TTY unless --yes, naming how many agents it is
    /// about to kill. Never launches Termic; if it is not running this
    /// succeeds silently, so teardown scripts do not need `|| true`.
    #[command(
        after_help = "Every live agent PTY, script process group and in-flight grep dies \
with the app, the same teardown Cmd-Q does. Any ACTIVE SPOTLIGHT SESSION is \
also reverted, which force-checks-out the project's main checkout. The \
confirmation names how many agents it is about to kill; non-interactive runs \
REQUIRE --yes.

Never launches Termic. On the default socket, a Termic that is not running \
prints a note and exits 0, so teardown scripts do not need `|| true`. With \
TERMIC_SOCKET set explicitly, a missing socket is a misconfiguration and \
still exits 4.

Prints what happened on stdout. With --output-format json, one object, \
always carrying `running` and `quitting`: \
{\"running\", \"quitting\", \"tasks_with_agents\", \"live_agents\", \
\"working_tasks\" (null when the work-state cache is stale)} when Termic was running, or {\"running\": false, \
\"quitting\": false} when it was not.

Exit codes: 0 quit (or nothing was running), 1 error (declined, no TTY \
without --yes), 4 the app went away before the command committed, 5 CLI \
disabled, 6 refused, 8 the app exited mid-command."
    )]
    Quit {
        /// Skip the confirmation prompt (required non-interactively).
        #[arg(short, long)]
        yes: bool,
    },
    /// Rename a task: the sidebar label only; branch and directory stay.
    #[command(
        allow_missing_positional = true,
        after_help = "Renames the task's LABEL: what the sidebar, `list` and `status` show. \
The git branch and the worktree directory keep their creation-time names \
(the branch may be pushed, the directory is a live cwd), so open PRs and \
running shells are unaffected.

Without <TASK>, targets your own task ($TERMIC_TASK_ID, injected into every \
agent shell), then falls back to the current directory like `open`. Renaming \
another task stays possible but must name it explicitly.

A name already used by a live task in the same project is refused (archived \
names may be reused). The old name stops resolving the moment the rename \
lands; the task id never changes, so scripts should hold the id.

Prints the rename on stdout. With --output-format json, one object: \
{\"task\": {...}, \"old_name\"}, where task carries the new name.

Exit codes: 0 renamed, 1 error (unknown or ambiguous task, empty or \
duplicate name), 4 app not running, 5 CLI disabled, 6 refused, 8 connection \
lost."
    )]
    Rename {
        /// Task name, task id, or qualified project/name. Omitted:
        /// $TERMIC_TASK_ID, then the current directory.
        task: Option<String>,
        /// The new name.
        name: String,
        /// Project name, to disambiguate. Requires a task name.
        #[arg(long, requires = "task")]
        project: Option<String>,
    },

    /// Archive a task: SIGKILL its live agents, remove its worktree.
    #[command(
        after_help = "Kills the task's live agent PTYs FIRST, then archives: the worktree \
directory is removed (the branch stays in git); a main-checkout task is \
unlinked without touching the repo. Asks for confirmation on a TTY unless \
--yes; non-interactive runs REQUIRE --yes.

Prints what was archived on stdout. With --output-format json, one object: \
{\"task_id\", \"name\", \"project\", \"killed_agents\"}.

Exit codes: 0 archived, 1 error (unknown or ambiguous task, declined, no \
TTY without --yes), 4 app not running, 5 CLI disabled, 6 refused, \
8 connection lost."
    )]
    Archive {
        /// Task name, task id, or qualified project/name.
        task: String,
        /// Project name, to disambiguate.
        #[arg(long)]
        project: Option<String>,
        /// Skip the confirmation prompt (required non-interactively).
        #[arg(short, long)]
        yes: bool,
    },

    /// Manage registered projects.
    #[command(subcommand)]
    Project(ProjectCmd),

    /// Print help; `--json` prints the whole surface machine-readably.
    #[command(
        after_help = "With --json, one object on stdout: {app, version, protocol, exit_codes, \
commands: [{name, aliases, about, args, flags, exit_codes}]}. Fields only \
ever grow (additive contract). Intended for agents that introspect the \
surface instead of parsing prose."
    )]
    Help {
        /// Command to describe (default: the top-level overview).
        command: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum ProjectCmd {
    /// Register a directory as a project (`termic project add .`).
    #[command(
        after_help = "The non-interactive registration path scripts need: no prompt, the \
directory (default: the current one) must be a git repository. Prints the \
registered project on stdout; with --output-format json, one object: \
{\"project\": {id, name, root_path, tasks, default_agent}}.

Exit codes: 0 registered (or already registered), 1 error (not a git \
repository, missing directory), 4 app not running, 5 CLI disabled, \
6 refused, 8 connection lost."
    )]
    Add {
        /// Directory to register (default: the current directory).
        #[arg(default_value = ".")]
        path: String,
        /// Register a plain (non-git) folder. Non-git projects only
        /// support main-checkout tasks (worktrees need git).
        #[arg(long)]
        non_git: bool,
    },
    /// List registered projects with live-task counts.
    #[command(
        after_help = "Prints one row per project on stdout. With --output-format json, one \
object: {\"projects\": [{id, name, root_path, tasks, default_agent}]}.

Exit codes: 0 success, 1 error, 4 app not running, 5 CLI disabled, \
6 refused, 8 connection lost."
    )]
    List,
    /// Unregister a project and archive ALL its tasks.
    #[command(
        after_help = "Destructive: every task of the project is archived and its worktree \
deleted (the project's own repo is not touched). Asks for confirmation on a \
TTY unless --yes; non-interactive runs REQUIRE --yes.

Prints what was removed on stdout. With --output-format json, one object: \
{\"name\", \"removed_tasks\"}.

Exit codes: 0 removed, 1 error (unknown project, declined, no TTY without \
--yes), 4 app not running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Remove {
        /// Project name.
        name: String,
        /// Skip the confirmation prompt (required non-interactively).
        #[arg(short, long)]
        yes: bool,
    },
}

pub fn run() -> i32 {
    // clap exits 2 on usage/parse errors itself; 2 stays reserved for it.
    let cli = Cli::parse();
    match execute(&cli) {
        Ok(out) => {
            if !out.stdout.is_empty() {
                println!("{}", out.stdout);
            }
            out.code
        }
        Err(e) => {
            eprintln!("termic: {}", e.message);
            e.code
        }
    }
}

/// Should the control plane be refused from inside this environment?
/// Pure so the rule is testable: refused iff sandboxed AND the mode is
/// not Monitor (unknown/absent modes count as enforcing).
pub fn cage_refused(sandbox: Option<&str>, mode: Option<&str>) -> bool {
    sandbox == Some("1") && mode != Some("monitor")
}

fn effective_format(cli: &Cli) -> OutputFormat {
    if cli.json { OutputFormat::Json } else { cli.output_format }
}

fn execute(cli: &Cli) -> Result<Output, CliError> {
    // In-cage pre-check (docs/plans/cli.md, Security DX): ENFORCING
    // cages get NO CLI surface; fail with the real reason instead of a
    // token error. Monitor is exempt by contract (observe, never
    // block): a monitored agent reaches the socket by design and its
    // token read + CLI use show up in the log. TERMIC_SANDBOX_MODE is
    // new; its absence (older app) refuses, the safe default.
    if cage_refused(
        std::env::var("TERMIC_SANDBOX").ok().as_deref(),
        std::env::var("TERMIC_SANDBOX_MODE").ok().as_deref(),
    ) {
        return Err(CliError::new(
            exit_code::REFUSED,
            "this shell is inside a sandboxed termic task, the control plane is unavailable",
        ));
    }

    let format = effective_format(cli);

    // Help is fully local: no socket, no app.
    if let Cmd::Help { command } = &cli.cmd {
        return help_output(command.as_deref(), format);
    }

    // Resolve `-p -` stdin BEFORE touching the socket: a generator
    // slower than the server's 30s idle timeout must not turn a
    // healthy pipe into "connection lost".
    let prompt = match &cli.cmd {
        Cmd::New { prompt: Some(p), .. }
        | Cmd::Send { prompt: p, .. }
        | Cmd::Tab { prompt: Some(p), .. } => Some(resolve_prompt(p)?),
        _ => None,
    };

    let paths = client::socket_paths();
    // `quit` never launches: starting Termic in order to stop it is absurd,
    // and a teardown script wants "already gone" to be SUCCESS, not an error
    // it has to `|| true` away. Every other verb keeps auto-launch.
    let quitting = matches!(cli.cmd, Cmd::Quit { .. });
    let mut conn = match client::connect_or_launch(&paths, cli.no_launch || quitting) {
        // "Nothing to quit" is success, so a teardown script does not need
        // `|| true`. But ONLY on the default socket: if the user pointed
        // TERMIC_SOCKET somewhere explicit, a socket that is not there is a
        // misconfiguration, and reporting exit 0 would tell a script it had
        // stopped agents that are in fact still running.
        Err(e) if quitting && !paths.custom && e.code == exit_code::APP_NOT_RUNNING => {
            return Ok(Output::ok(final_stdout(
                format,
                "Termic is not running.",
                &serde_json::json!({ "running": false, "quitting": false }),
            )));
        }
        other => other?,
    };
    client::hello(&mut conn)?;
    let token = client::read_token(&paths)?;

    match &cli.cmd {
        Cmd::Help { .. } => unreachable!("handled above"),
        Cmd::New { .. } => execute_new(cli, &mut conn, &token, format, &paths, prompt),
        Cmd::Send { .. } => execute_send(cli, &mut conn, &token, format, prompt),
        Cmd::Attach { task, project, shell, tab, resize, detach_keys } => {
            let seq = attach::parse_detach_keys(detach_keys)?;
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let wire = proto::Command::Attach {
                task: task.clone(),
                project: project.clone(),
                shell: *shell,
                tab: tab.clone(),
                cwd,
            };
            attach::run_attach(conn, &token, wire, seq, detach_keys, *resize)
        }
        Cmd::Apply { task, project, yes } => {
            execute_apply(&mut conn, &token, format, task, project.as_deref(), *yes, &paths)
        }
        Cmd::Diff { task, project, full } => {
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let cmd = proto::Command::Diff {
                task: task.clone(),
                project: project.clone(),
                full: *full,
                cwd,
            };
            let data = client::request(&mut conn, cmd, &token)?;
            let proto::ReplyData::Diff(d) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to diff"));
            };
            // --full pipes: the patch is the whole stdout, no summary.
            let text = if *full {
                d.diff.clone().unwrap_or_default().trim_end().to_string()
            } else {
                output::diff_text(&d)
            };
            Ok(Output::ok(final_stdout(format, &text, &d)))
        }
        Cmd::Logs { task, project, shell, tab, bytes } => {
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let cmd = proto::Command::Logs {
                task: task.clone(),
                project: project.clone(),
                shell: *shell,
                tab: tab.clone(),
                last_bytes: *bytes,
                cwd,
            };
            let data = client::request(&mut conn, cmd, &token)?;
            let proto::ReplyData::Logs(l) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to logs"));
            };
            if l.truncated && format == OutputFormat::Text {
                eprintln!("termic: older output was already dropped from the buffer");
            }
            let text = l.data.trim_end().to_string();
            Ok(Output::ok(final_stdout(format, &text, &l)))
        }
        Cmd::Result { task, project } => {
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let cmd = proto::Command::LastResult {
                task: task.clone(),
                project: project.clone(),
                cwd,
            };
            let data = client::request(&mut conn, cmd, &token)?;
            let proto::ReplyData::LastResult(r) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to result"));
            };
            Ok(Output::ok(final_stdout(format, &output::result_text(&r), &r)))
        }
        Cmd::Path { task, project } => {
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let cmd = proto::Command::Status {
                task: task.clone(),
                project: project.clone(),
                cwd,
            };
            let data = client::request(&mut conn, cmd, &token)?;
            let proto::ReplyData::Status(s) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to status"));
            };
            let obj = serde_json::json!({
                "task_id": s.task.summary.id,
                "path": s.task.summary.path,
            });
            Ok(Output::ok(final_stdout(format, &s.task.summary.path, &obj)))
        }
        Cmd::Wait { task, project, timeout, tab } => {
            let timeout_ms = timeout.as_deref().map(parse_duration_ms).transpose()?;
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let cmd = proto::Command::Wait {
                task: task.clone(),
                project: project.clone(),
                timeout_ms,
                tab: tab.clone(),
                cwd,
            };
            let data = run_streamed(&mut conn, cmd, &token, format)?;
            let proto::ReplyData::Wait(w) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to wait"));
            };
            let code = w.result.outcome.exit_code();
            Ok(Output { stdout: final_stdout(format, &output::wait_text(&w), &w), code })
        }
        Cmd::Agents => {
            let data = client::request(&mut conn, proto::Command::Agents, &token)?;
            let proto::ReplyData::Agents(a) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to agents"));
            };
            Ok(Output::ok(final_stdout(format, &output::agents_text(&a), &a)))
        }
        Cmd::Tab { task, project, agent, terminal, shell, prompt: _, wait, timeout } => {
            let kind = if let Some(id) = agent {
                proto::TabKind::Agent { id: id.clone() }
            } else if let Some(id) = terminal {
                proto::TabKind::Terminal { id: id.clone() }
            } else if *shell {
                proto::TabKind::Shell
            } else {
                proto::TabKind::Default
            };
            if let Some(p) = &prompt {
                if p.trim().is_empty() {
                    return Err(CliError::new(exit_code::ERROR, "the prompt is empty"));
                }
            }
            let timeout_ms = timeout.as_deref().map(parse_duration_ms).transpose()?;
            let wire = proto::Command::Tab {
                task: task.clone(),
                project: project.clone(),
                kind,
                prompt: prompt.clone(),
                wait: *wait,
                timeout_ms,
                cwd: std::env::current_dir().ok().map(|p| p.display().to_string()),
            };
            // A prompt streams (queued/prompt_delivered/state events, the
            // send shape); a bare open stays one request/reply.
            let streamed = prompt.is_some();
            if *wait && format == OutputFormat::Text {
                eprintln!(
                    "termic: watching the agent (Ctrl-C stops watching; the task keeps running)"
                );
            }
            let data = if streamed {
                run_streamed(&mut conn, wire, &token, format)?
            } else {
                client::request(&mut conn, wire, &token)?
            };
            let proto::ReplyData::Tab(t) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to tab"));
            };
            let code = t
                .prompt
                .as_ref()
                .and_then(|p| p.wait.as_ref())
                .map(|w| w.outcome.exit_code())
                .unwrap_or(exit_code::OK);
            Ok(Output { stdout: final_stdout(format, &output::tab_text(&t), &t), code })
        }
        Cmd::Quit { yes } => execute_quit(&mut conn, &token, format, *yes, &paths),
        Cmd::Archive { task, project, yes } => {
            execute_archive(&mut conn, &token, format, task, project.as_deref(), *yes, &paths)
        }
        Cmd::Rename { task, name, project } => {
            // Explicit task wins; otherwise the caller's own task
            // ($TERMIC_TASK_ID, injected into every agent shell). The id
            // is preferred over cwd because it survives `cd` and stays
            // unambiguous; cwd rides along as the last-resort fallback
            // the server only consults when `task` is absent.
            let target = task.clone().or_else(|| {
                std::env::var("TERMIC_TASK_ID").ok().filter(|s| !s.is_empty())
            });
            let data = client::request(
                &mut conn,
                proto::Command::Rename {
                    task: target,
                    project: project.clone(),
                    name: name.clone(),
                    cwd: std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()),
                },
                &token,
            )?;
            render(&cli.cmd, format, data).map(Output::ok)
        }
        Cmd::Project(p) => execute_project(&mut conn, &token, format, p, &paths),
        // The Phase 0 read verbs: one request, one reply.
        Cmd::List { .. } | Cmd::Status { .. } | Cmd::Open { .. } => {
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
            let cmd = to_wire_command(&cli.cmd, format, cwd);
            let data = client::request(&mut conn, cmd, &token)?;
            render(&cli.cmd, format, data).map(Output::ok)
        }
    }
}

/// Serialize a value as the final stdout for json/stream-json, or use
/// the prepared text line.
fn final_stdout<T: serde::Serialize>(format: OutputFormat, text: &str, value: &T) -> String {
    match format {
        OutputFormat::Text => text.to_string(),
        OutputFormat::Json => output::json(value),
        OutputFormat::StreamJson => output::result_line(value),
    }
}

// ───────────────────────────── new ───────────────────────────────────

/// The server drops idle connections after 30s, and a human can easily
/// sit on a y/N prompt longer than that, so every post-confirmation
/// request runs on a FRESH connection instead of racing the timeout.
/// NEVER auto-launches: the confirmation was given against a specific
/// running instance, and relaunching would mint a fresh per-boot token
/// that turns the retained one into a baffling exit 6. Only the
/// not-running class gets the reworded message; other failures keep
/// their own truth.
fn reconnect(paths: &client::SocketPaths) -> Result<client::Conn, CliError> {
    client::connect_or_launch(paths, true).map_err(|e| {
        if e.code == exit_code::APP_NOT_RUNNING {
            CliError::new(
                e.code,
                "Termic quit while waiting for the confirmation; rerun the command".to_string(),
            )
        } else {
            e
        }
    })
}

fn execute_new(
    cli: &Cli,
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    paths: &client::SocketPaths,
    prompt: Option<String>,
) -> Result<Output, CliError> {
    let Cmd::New {
        name,
        prompt: _,
        agent,
        worktree,
        main,
        base,
        sandbox,
        yolo,
        project,
        open,
        wait,
        timeout,
    } = &cli.cmd
    else {
        unreachable!()
    };
    if prompt.as_deref().is_some_and(|p| p.trim().is_empty()) {
        return Err(CliError::new(exit_code::ERROR, "the prompt is empty"));
    }
    let timeout_ms = timeout.as_deref().map(parse_duration_ms).transpose()?;
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let mode = if *worktree {
        Some("worktree".to_string())
    } else if *main {
        Some("main".to_string())
    } else {
        None
    };
    let wire = proto::Command::New {
        name: name.clone(),
        prompt,
        agent: agent.clone(),
        mode,
        base: base.clone(),
        sandbox: sandbox.clone(),
        yolo: *yolo,
        project: project.clone(),
        open: *open,
        wait: *wait,
        timeout_ms,
        cwd,
    };

    if *wait && format == OutputFormat::Text {
        eprintln!("termic: watching the agent (Ctrl-C stops watching; the task keeps running)");
    }
    let data = match run_streamed(conn, wire.clone(), token, format) {
        Ok(d) => d,
        // The cwd is a git repo Termic doesn't know. On a TTY, offer to
        // register it and retry once; scripts get the actionable error.
        Err(e) => {
            let Some(root) = e.unregistered_root() else { return Err(e.into_cli()) };
            let question = format!(
                "termic: {root} is not a registered Termic project. Add it and continue?"
            );
            // No TTY (scripts): fall through to the server's actionable
            // error ("run termic project add ..."), never a --yes hint
            // for a flag `new` does not have.
            if !confirm_tty(&question).unwrap_or(false) {
                return Err(e.into_cli());
            }
            let mut fresh = reconnect(paths)?;
            // Same widened budget as the standalone `project add` path;
            // a busy webview must not turn a confirmed registration
            // into a false "connection lost".
            fresh.set_read_timeout(client::PROJECT_ADD_READ_TIMEOUT);
            let add = proto::Command::ProjectAdd { path: root, non_git: false };
            client::request(&mut fresh, add, token)?;
            run_streamed(&mut fresh, wire, token, format).map_err(StreamError::into_cli)?
        }
    };
    let proto::ReplyData::New(n) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to new"));
    };
    let code = n.wait.as_ref().map(|w| w.outcome.exit_code()).unwrap_or(exit_code::OK);
    Ok(Output { stdout: final_stdout(format, &output::new_final_text(&n), &n), code })
}

/// The request line caps at 1 MB (proto::MAX_LINE_BYTES) POST-JSON-
/// escaping, so the prompt budget measures ESCAPED bytes (a control-
/// char-heavy prompt inflates up to 6x); margin left for the envelope.
/// This is what turns an oversized prompt into a clear exit 1 instead
/// of a server hangup misread as "connection lost".
const PROMPT_MAX_BYTES: usize = 900 * 1024;

fn prompt_size_ok(s: &str) -> Result<(), CliError> {
    if proto::json_escaped_len(s) > PROMPT_MAX_BYTES {
        return Err(CliError::new(
            exit_code::ERROR,
            format!(
                "the prompt is too large (limit {} KB once encoded; control characters count sixfold)",
                PROMPT_MAX_BYTES / 1024
            ),
        ));
    }
    Ok(())
}

/// Read the prompt, honoring the `-p -` stdin convention. Bounded:
/// stdin is read at most `PROMPT_MAX_BYTES` + 1 raw bytes, never
/// buffered unboundedly; the escaped-size check then applies to both
/// sources.
fn resolve_prompt(p: &str) -> Result<String, CliError> {
    if p != "-" {
        prompt_size_ok(p)?;
        return Ok(p.to_string());
    }
    let mut buf: Vec<u8> = Vec::new();
    std::io::stdin()
        .lock()
        .take(PROMPT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| CliError::new(exit_code::ERROR, format!("could not read the prompt from stdin ({e})")))?;
    if buf.len() > PROMPT_MAX_BYTES {
        return Err(CliError::new(
            exit_code::ERROR,
            format!("the prompt is too large (limit {} KB)", PROMPT_MAX_BYTES / 1024),
        ));
    }
    let trimmed = String::from_utf8_lossy(&buf).trim_end().to_string();
    if trimmed.is_empty() {
        return Err(CliError::new(exit_code::ERROR, "the prompt from stdin is empty"));
    }
    prompt_size_ok(&trimmed)?;
    Ok(trimmed)
}

// ───────────────────────────── send ──────────────────────────────────

fn execute_send(
    cli: &Cli,
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    prompt: Option<String>,
) -> Result<Output, CliError> {
    let Cmd::Send { task, here, prompt: _, resume, fresh, wait, timeout, tab, project } = &cli.cmd
    else {
        unreachable!()
    };
    let prompt = prompt.expect("send resolves its prompt before connecting");
    if prompt.trim().is_empty() {
        return Err(CliError::new(exit_code::ERROR, "the prompt is empty"));
    }
    let task = match (task, here) {
        (Some(t), _) => Some(t.clone()),
        (None, true) => match std::env::var("TERMIC_TASK_ID").ok().filter(|s| !s.is_empty()) {
            Some(id) => Some(id),
            None => {
                return Err(CliError::new(
                    exit_code::ERROR,
                    "--here needs TERMIC_TASK_ID in the environment (run it inside a termic task terminal)",
                ));
            }
        },
        (None, false) => None, // cwd resolution, server-side
    };
    let timeout_ms = timeout.as_deref().map(parse_duration_ms).transpose()?;
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let wire = proto::Command::Send {
        task,
        project: project.clone(),
        prompt,
        resume: *resume,
        fresh: *fresh,
        wait: *wait,
        timeout_ms,
        tab: tab.clone(),
        cwd,
    };
    if *wait && format == OutputFormat::Text {
        eprintln!("termic: watching the agent (Ctrl-C stops watching; the task keeps running)");
    }
    let data = run_streamed(conn, wire, token, format)?;
    let proto::ReplyData::Send(s) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to send"));
    };
    let code = s.wait.as_ref().map(|w| w.outcome.exit_code()).unwrap_or(exit_code::OK);
    Ok(Output { stdout: final_stdout(format, &output::send_text(&s), &s), code })
}

// ───────────────────────────── apply ─────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn execute_apply(
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    task: &str,
    project: Option<&str>,
    yes: bool,
    paths: &client::SocketPaths,
) -> Result<Output, CliError> {
    // Resolve first so the confirmation names the real target (the
    // archive verb's rule), and main-checkout tasks fail before a
    // pointless confirm.
    let status = client::request(
        conn,
        proto::Command::Status {
            task: Some(task.to_string()),
            project: project.map(str::to_string),
            cwd: None,
        },
        token,
    )?;
    let proto::ReplyData::Status(s) = status else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to status"));
    };
    let t = &s.task.summary;
    if t.is_main_checkout {
        return Err(CliError::new(
            exit_code::ERROR,
            "this task IS the main checkout, there is nothing to apply",
        ));
    }
    let mut fresh: Option<client::Conn> = None;
    if !yes {
        let question = format!(
            "termic: apply {}/{} to the main checkout? Its cumulative diff lands as UNCOMMITTED changes in the project root; the task and its worktree are untouched.",
            t.project, t.name
        );
        if !confirm_tty(&question)? {
            return Err(CliError::new(exit_code::ERROR, "apply declined"));
        }
        fresh = Some(reconnect(paths)?);
    }
    let conn = fresh.as_mut().unwrap_or(conn);
    // git diff + apply on a big repo can take a while; the default 30s
    // read timeout would report a false "connection lost".
    conn.set_read_timeout(client::SLOW_VERB_READ_TIMEOUT);
    let data = client::request(
        conn,
        proto::Command::Apply { task: t.id.clone(), project: None },
        token,
    )?;
    let proto::ReplyData::Apply(a) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to apply"));
    };
    Ok(Output::ok(final_stdout(format, &output::apply_text(&a), &a)))
}

// ───────────────────────────── archive / project ─────────────────────

#[allow(clippy::too_many_arguments)]
fn execute_archive(
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    task: &str,
    project: Option<&str>,
    yes: bool,
    paths: &client::SocketPaths,
) -> Result<Output, CliError> {
    // Resolve first (status is cheap) so the confirmation names the real
    // target and its worktree path, not whatever the user typed.
    let status = client::request(
        conn,
        proto::Command::Status {
            task: Some(task.to_string()),
            project: project.map(str::to_string),
            cwd: None,
        },
        token,
    )?;
    let proto::ReplyData::Status(s) = status else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to status"));
    };
    let t = &s.task.summary;
    let mut fresh: Option<client::Conn> = None;
    if !yes {
        let question = if t.is_main_checkout {
            format!(
                "termic: archive {}/{}? This removes the Termic entry; the repo on disk is not touched. Any running agent is killed.",
                t.project, t.name
            )
        } else {
            format!(
                "termic: archive {}/{}? The worktree at {} is removed and any running agent killed. The branch stays in git.",
                t.project, t.name, t.path
            )
        };
        if !confirm_tty(&question)? {
            return Err(CliError::new(exit_code::ERROR, "archive declined"));
        }
        fresh = Some(reconnect(paths)?);
    }
    let conn = fresh.as_mut().unwrap_or(conn);
    // task_archive runs archive scripts + worktree removal
    // synchronously; the server allows itself 300s, so a fixed 30s
    // read timeout here would report a false "connection lost" for an
    // archive that succeeds.
    conn.set_read_timeout(client::SLOW_VERB_READ_TIMEOUT);
    let data = client::request(
        conn,
        proto::Command::Archive { task: t.id.clone(), project: None },
        token,
    )?;
    let proto::ReplyData::Archive(a) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to archive"));
    };
    Ok(Output::ok(final_stdout(format, &output::archive_text(&a), &a)))
}

/// `termic quit`. Preview first so the confirmation can name what dies,
/// then commit. Never auto-launches: launching Termic in order to quit it
/// is absurd, and a teardown script wants "already gone" to be success.
fn execute_quit(
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    yes: bool,
    paths: &client::SocketPaths,
) -> Result<Output, CliError> {
    let data = client::request(conn, proto::Command::Quit { commit: false }, token)?;
    let proto::ReplyData::Quit(p) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to quit"));
    };

    let mut fresh = None;
    if !yes {
        if !confirm_tty(&output::quit_question(&p))? {
            return Err(CliError::new(exit_code::ERROR, "quit declined"));
        }
        // A human can sit on the prompt longer than the server's 30s idle
        // timeout, so reconnect before committing (same as archive).
        fresh = Some(reconnect(paths)?);
    }
    let conn = fresh.as_mut().unwrap_or(conn);
    let data = client::request(conn, proto::Command::Quit { commit: true }, token)?;
    let proto::ReplyData::Quit(q) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to quit"));
    };
    Ok(Output::ok(final_stdout(format, &output::quit_text(&q), &q)))
}

fn execute_project(
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    cmd: &ProjectCmd,
    paths: &client::SocketPaths,
) -> Result<Output, CliError> {
    match cmd {
        ProjectCmd::List => {
            let data = client::request(conn, proto::Command::ProjectList, token)?;
            let proto::ReplyData::ProjectList(l) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to project list"));
            };
            Ok(Output::ok(final_stdout(format, &output::project_list_text(&l.projects), &l)))
        }
        ProjectCmd::Add { path, non_git } => {
            // Canonicalize CLIENT-side: the server must never resolve a
            // relative path against ITS cwd.
            let abs = std::fs::canonicalize(path).map_err(|e| {
                CliError::new(exit_code::ERROR, format!("cannot resolve {path} ({e})"))
            })?;
            conn.set_read_timeout(client::PROJECT_ADD_READ_TIMEOUT);
            let data = client::request(
                conn,
                proto::Command::ProjectAdd {
                    path: abs.to_string_lossy().into_owned(),
                    non_git: *non_git,
                },
                token,
            )?;
            let proto::ReplyData::ProjectAdd(a) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to project add"));
            };
            Ok(Output::ok(final_stdout(format, &output::project_add_text(&a.project), &a)))
        }
        ProjectCmd::Remove { name, yes } => {
            let mut fresh: Option<client::Conn> = None;
            let mut target = name.clone();
            if !yes {
                // Show what the removal actually costs before asking.
                let data = client::request(conn, proto::Command::ProjectList, token)?;
                let proto::ReplyData::ProjectList(l) = data else {
                    return Err(CliError::new(exit_code::ERROR, "unexpected reply to project list"));
                };
                let found = l
                    .projects
                    .iter()
                    .find(|p| p.name.eq_ignore_ascii_case(name) || p.id == *name);
                let Some(p) = found else {
                    return Err(CliError::new(exit_code::ERROR, format!("no project named \"{name}\"")));
                };
                let question = format!(
                    "termic: remove project {}? Its {} task(s) are archived and their worktrees deleted; the repo at {} is not touched.",
                    p.name, p.tasks, p.root_path
                );
                if !confirm_tty(&question)? {
                    return Err(CliError::new(exit_code::ERROR, "remove declined"));
                }
                // Send the RESOLVED id, not the raw string, so the
                // confirmation and the removal cannot name different
                // projects (the archive verb's rule).
                target = p.id.clone();
                fresh = Some(reconnect(paths)?);
            }
            let conn = fresh.as_mut().unwrap_or(conn);
            // Removal archives every task of the project (server budget
            // 300s); see the archive read-timeout note.
            conn.set_read_timeout(client::SLOW_VERB_READ_TIMEOUT);
            let data = client::request(
                conn,
                proto::Command::ProjectRemove { name: target },
                token,
            )?;
            let proto::ReplyData::ProjectRemove(r) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to project remove"));
            };
            Ok(Output::ok(final_stdout(format, &output::project_remove_text(&r), &r)))
        }
    }
}

// ───────────────────────────── streaming ─────────────────────────────

/// Structured error off a streamed exchange: IO problems are already
/// CliErrors; domain errors keep the wire body so `new` can react to
/// `unregistered_project` before flattening.
pub enum StreamError {
    Io(CliError),
    Domain(proto::ErrorBody),
}

impl From<StreamError> for CliError {
    fn from(e: StreamError) -> Self {
        e.into_cli()
    }
}

impl StreamError {
    fn into_cli(self) -> CliError {
        match self {
            StreamError::Io(e) => e,
            StreamError::Domain(b) => CliError::new(b.code.exit_code(), b.message),
        }
    }
    /// The repo root carried by an unregistered-project error, if that
    /// is what this is.
    fn unregistered_root(&self) -> Option<String> {
        match self {
            StreamError::Domain(b) if b.code == proto::ErrorCode::UnregisteredProject => b
                .data
                .as_ref()
                .and_then(|d| d.get("root"))
                .and_then(|r| r.as_str())
                .map(str::to_string),
            _ => None,
        }
    }
}

/// Run a streaming verb: print events per the format as they arrive,
/// return the final reply's data.
fn run_streamed(
    conn: &mut client::Conn,
    cmd: proto::Command,
    token: &str,
    format: OutputFormat,
) -> Result<proto::ReplyData, StreamError> {
    let reply = client::exchange_streamed(conn, cmd, token, &mut |ev| print_event(format, ev))
        .map_err(StreamError::Io)?;
    if let Some(body) = reply.error {
        return Err(StreamError::Domain(body));
    }
    reply
        .data
        .ok_or_else(|| StreamError::Io(CliError::new(exit_code::ERROR, "empty reply from Termic")))
}

/// One streamed event hits stdout immediately (text: setup output raw +
/// a created summary; stream-json: the event as NDJSON; json: nothing,
/// the final object is the only output).
fn print_event(format: OutputFormat, ev: &proto::StreamEvent) {
    use std::io::Write as _;
    match format {
        OutputFormat::Json => {}
        OutputFormat::StreamJson => {
            // Heartbeats included: they are documented events and the
            // consumer's only liveness signal during long quiet turns.
            println!("{}", output::event_line(ev));
        }
        OutputFormat::Text => match ev.event.as_str() {
            "setup_output" => {
                if let Some(data) = &ev.data {
                    let mut out = std::io::stdout();
                    let _ = out.write_all(data.as_bytes());
                    let _ = out.flush();
                }
            }
            "created" => {
                if let Some(task) = &ev.task {
                    println!("{}", output::new_created_text(task));
                }
            }
            "prompt_delivered" => eprintln!("termic: prompt delivered"),
            "queued" => {
                eprintln!("termic: prompt queued; it sends when the agent's current turn finishes");
            }
            _ => {}
        },
    }
}

// ───────────────────────────── tty ───────────────────────────────────

/// Ask a yes/no question on the controlling terminal, NOT stdin (the
/// prompt may be piped through stdin via `-p -`). No TTY = a hard error
/// telling scripts to pass --yes.
fn confirm_tty(question: &str) -> Result<bool, CliError> {
    use std::io::{BufRead, BufReader, Write};
    let no_tty = || {
        CliError::new(
            exit_code::ERROR,
            "confirmation needs a terminal; pass --yes (or -y) in scripts",
        )
    };
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .map_err(|_| no_tty())?;
    let inp = std::fs::File::open("/dev/tty").map_err(|_| no_tty())?;
    write!(out, "{question} [y/N] ").and_then(|_| out.flush()).map_err(|_| no_tty())?;
    let mut line = String::new();
    BufReader::new(inp).read_line(&mut line).map_err(|_| no_tty())?;
    Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

// ───────────────────────────── durations ─────────────────────────────

/// Parse `90`, `30s`, `5m`, `1h`, `1h30m`, `2m30s` into milliseconds.
/// Bare numbers are seconds.
pub fn parse_duration_ms(s: &str) -> Result<u64, CliError> {
    let bad = || {
        CliError::new(
            exit_code::ERROR,
            format!("invalid duration \"{s}\" (use seconds, or 30s / 5m / 1h / 1h30m)"),
        )
    };
    let s = s.trim();
    if s.is_empty() {
        return Err(bad());
    }
    if let Ok(secs) = s.parse::<u64>() {
        return Ok(secs.saturating_mul(1000));
    }
    let mut total: u64 = 0;
    let mut digits = String::new();
    let mut any = false;
    for c in s.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit_ms: u64 = match c {
            's' => 1000,
            'm' => 60_000,
            'h' => 3_600_000,
            _ => return Err(bad()),
        };
        if digits.is_empty() {
            return Err(bad());
        }
        let n: u64 = digits.parse().map_err(|_| bad())?;
        total = total.saturating_add(n.saturating_mul(unit_ms));
        digits.clear();
        any = true;
    }
    if !digits.is_empty() || !any {
        return Err(bad());
    }
    Ok(total)
}

// ───────────────────────────── help ──────────────────────────────────

/// One description per pinned exit code: the single table the global
/// `help --json` map AND the per-verb lists derive from. The machine
/// surface is agent-parsed contract; two hand-kept copies would drift.
/// The numbers themselves are pinned in termic-proto.
const EXIT_CODE_TABLE: &[(i32, &str)] = &[
    (0, "success (watched runs: agent settled done; attach: clean detach)"),
    (1, "error"),
    (2, "usage error (argument parsing)"),
    (3, "agent stopped needing input"),
    (4, "Termic not running"),
    (5, "CLI disabled in Settings"),
    (6, "refused (token or sandboxed shell)"),
    (7, "timeout expired"),
    (8, "connection lost"),
    (9, "prompt never delivered"),
    (10, "apply left the main checkout conflicted (resolve or reset there)"),
    (11, "the attach target closed (agent exited or task archived)"),
];

fn exit_code_desc(code: i32) -> &'static str {
    EXIT_CODE_TABLE
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, d)| *d)
        .unwrap_or("")
}

/// Which pinned exit codes a verb can actually produce, for the machine
/// surface; descriptions come from `EXIT_CODE_TABLE`. 2 (clap usage)
/// is global-only: every verb can exit 2 before it runs.
fn verb_exit_codes(name: &str) -> Vec<i32> {
    const COMMON: &[i32] = &[0, 1, 4, 5, 6, 8];
    const WATCHED: &[i32] = &[0, 1, 3, 4, 5, 6, 7, 8];
    match name {
        "new" | "send" => {
            let mut v = WATCHED.to_vec();
            v.push(9);
            v
        }
        "wait" => WATCHED.to_vec(),
        "apply" => {
            let mut v = COMMON.to_vec();
            v.push(10);
            v
        }
        "attach" => {
            let mut v = COMMON.to_vec();
            v.push(11);
            v
        }
        // Fully local (no socket): only success, an unknown command
        // name, and the in-cage refusal that precedes it are reachable.
        "help" => vec![0, 1, 6],
        // COMMON, and every code in it is genuinely reachable: 4 and 8 when
        // the app exits underneath us (a second `quit`, or Cmd-Q while a
        // human sits on the confirmation), which is why `after_help` lists
        // them rather than pretending quit always succeeds.
        "quit" => COMMON.to_vec(),
        _ => COMMON.to_vec(),
    }
}

fn help_output(command: Option<&str>, format: OutputFormat) -> Result<Output, CliError> {
    if format == OutputFormat::Text {
        let mut root = Cli::command();
        let text = match command {
            None => root.render_long_help().to_string(),
            Some(name) => {
                let sub = root
                    .find_subcommand_mut(name)
                    .ok_or_else(|| CliError::new(exit_code::ERROR, format!("unknown command \"{name}\"")))?;
                sub.render_long_help().to_string()
            }
        };
        // render_long_help ends with a newline; run() adds one more.
        return Ok(Output::ok(text.trim_end().to_string()));
    }
    Ok(Output::ok(output::json(&machine_help())))
}

/// The whole surface, machine-readably: what an agent introspects
/// instead of parsing prose (docs/plans/cli.md, Agents as users).
pub fn machine_help() -> serde_json::Value {
    fn args_of(cmd: &clap::Command) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
        let mut positional = Vec::new();
        let mut flags = Vec::new();
        for a in cmd.get_arguments() {
            if a.get_id() == "help" || a.get_id() == "version" {
                continue;
            }
            let help = a.get_help().map(|h| h.to_string()).unwrap_or_default();
            if a.is_positional() {
                positional.push(serde_json::json!({
                    "name": a.get_id().to_string(),
                    "required": a.is_required_set(),
                    "help": help,
                }));
            } else {
                let takes_value = a.get_action().takes_values();
                flags.push(serde_json::json!({
                    "flag": a.get_long().map(|l| format!("--{l}")),
                    "short": a.get_short().map(|c| format!("-{c}")),
                    "value": takes_value.then(|| {
                        a.get_value_names()
                            .and_then(|v| v.first().map(|s| s.to_string()))
                            .unwrap_or_else(|| a.get_id().to_string().to_uppercase())
                    }),
                    "help": help,
                }));
            }
        }
        (positional, flags)
    }
    fn command_entry(cmd: &clap::Command, qualified: &str) -> serde_json::Value {
        let (args, flags) = args_of(cmd);
        let exit_codes: serde_json::Map<String, serde_json::Value> = verb_exit_codes(qualified)
            .into_iter()
            .map(|c| (c.to_string(), serde_json::Value::String(exit_code_desc(c).to_string())))
            .collect();
        serde_json::json!({
            "name": qualified,
            "aliases": cmd.get_visible_aliases().map(|a| a.to_string()).collect::<Vec<_>>(),
            "about": cmd.get_about().map(|a| a.to_string()).unwrap_or_default(),
            "args": args,
            "flags": flags,
            "exit_codes": exit_codes,
        })
    }

    let root = Cli::command();
    let (_, global_flags) = args_of(&root);
    let mut commands = Vec::new();
    for sub in root.get_subcommands() {
        if sub.get_name() == "help" {
            commands.push(command_entry(sub, "help"));
            continue;
        }
        if sub.has_subcommands() {
            for nested in sub.get_subcommands() {
                let qualified = format!("{} {}", sub.get_name(), nested.get_name());
                commands.push(command_entry(nested, &qualified));
            }
            continue;
        }
        commands.push(command_entry(sub, sub.get_name()));
    }
    let global_exit_codes: serde_json::Map<String, serde_json::Value> = EXIT_CODE_TABLE
        .iter()
        .map(|(c, d)| (c.to_string(), serde_json::Value::String(d.to_string())))
        .collect();
    serde_json::json!({
        "app": "termic",
        "version": VERSION,
        "protocol": proto::PROTOCOL_VERSION,
        "global_flags": global_flags,
        "exit_codes": global_exit_codes,
        "commands": commands,
    })
}

// ───────────────────────────── wire mapping ──────────────────────────

/// Map the parsed subcommand + effective output format to the wire
/// command. Pure so the format-dependent `quiet` logic is unit-testable.
/// Streaming and interactive verbs build their wire commands in their
/// own executors.
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
        Cmd::Status { task, project } => proto::Command::Status {
            task: task.clone(),
            project: project.clone(),
            cwd,
        },
        Cmd::Open { task, project } => proto::Command::Open {
            task: task.clone(),
            project: project.clone(),
            cwd,
        },
        _ => unreachable!("streaming/interactive verbs build their own wire commands"),
    }
}

/// Turn a successful reply into stdout text. Pure, unit-tested.
pub fn render(cmd: &Cmd, format: OutputFormat, data: proto::ReplyData) -> Result<String, CliError> {
    let unexpected =
        |what: &str| CliError::new(exit_code::ERROR, format!("unexpected reply to {what}"));
    match (cmd, data) {
        (Cmd::List { quiet, .. }, proto::ReplyData::List(list)) => Ok(match format {
            OutputFormat::Json | OutputFormat::StreamJson => output::json(&list),
            OutputFormat::Text if *quiet => output::list_quiet(&list.tasks),
            OutputFormat::Text => output::list_text(&list.tasks),
        }),
        (Cmd::Status { .. }, proto::ReplyData::Status(status)) => Ok(match format {
            OutputFormat::Json | OutputFormat::StreamJson => output::json(&status),
            OutputFormat::Text => output::status_text(&status.task),
        }),
        (Cmd::Open { .. }, proto::ReplyData::Open(open)) => Ok(match format {
            OutputFormat::Json | OutputFormat::StreamJson => output::json(&open),
            OutputFormat::Text => output::open_text(&open),
        }),
        (Cmd::Rename { .. }, proto::ReplyData::Rename(r)) => Ok(match format {
            OutputFormat::Json | OutputFormat::StreamJson => output::json(&r),
            OutputFormat::Text => output::rename_text(&r),
        }),
        (Cmd::List { .. }, _) => Err(unexpected("list")),
        (Cmd::Status { .. }, _) => Err(unexpected("status")),
        (Cmd::Open { .. }, _) => Err(unexpected("open")),
        (Cmd::Rename { .. }, _) => Err(unexpected("rename")),
        _ => Err(unexpected("command")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clap_definition_is_coherent() {
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
    fn new_flag_rules() {
        // Mode is one of worktree/main, never both.
        assert!(Cli::try_parse_from(["termic", "new", "x", "--worktree", "--main"]).is_err());
        // --base only makes sense for a worktree.
        assert!(Cli::try_parse_from(["termic", "new", "x", "--main", "--base", "dev"]).is_err());
        // --timeout without --wait would silently do nothing.
        assert!(Cli::try_parse_from(["termic", "new", "x", "--timeout", "5m"]).is_err());
        // The full happy form parses.
        assert!(Cli::try_parse_from([
            "termic", "new", "fix-auth", "-p", "fix it", "--agent", "claude", "--worktree",
            "--base", "develop", "--sandbox", "enforce-fs", "--yolo", "--project", "web",
            "--open", "--wait", "--timeout", "1h30m",
        ])
        .is_ok());
        // Sandbox values are validated at parse time.
        assert!(Cli::try_parse_from(["termic", "new", "x", "--sandbox", "jail"]).is_err());
    }

    #[test]
    fn project_subcommands_parse() {
        assert!(Cli::try_parse_from(["termic", "project", "add"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "project", "add", "/repo/web"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "project", "list"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "project", "remove", "web", "--yes"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "project"]).is_err(), "a subcommand is required");
    }

    #[test]
    fn status_and_wait_task_is_optional_but_project_needs_one() {
        assert!(Cli::try_parse_from(["termic", "status"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "wait"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "wait", "--timeout", "5m"]).is_ok());
        // --project without a task would silently filter nothing.
        assert!(Cli::try_parse_from(["termic", "status", "--project", "web"]).is_err());
        assert!(Cli::try_parse_from(["termic", "wait", "--project", "web"]).is_err());
    }

    #[test]
    fn stream_json_output_format_parses() {
        let cli = Cli::try_parse_from(["termic", "wait", "x", "--output-format", "stream-json"])
            .expect("parses");
        assert_eq!(cli.output_format, OutputFormat::StreamJson);
    }

    #[test]
    fn send_flag_rules() {
        // The prompt is required.
        assert!(Cli::try_parse_from(["termic", "send", "foo"]).is_err());
        // --here replaces the task name; both together is a usage error.
        assert!(Cli::try_parse_from(["termic", "send", "foo", "--here", "-p", "x"]).is_err());
        // --resume and --fresh are mutually exclusive.
        assert!(
            Cli::try_parse_from(["termic", "send", "foo", "-p", "x", "--resume", "--fresh"])
                .is_err()
        );
        // --timeout without --wait would silently do nothing.
        assert!(Cli::try_parse_from(["termic", "send", "foo", "-p", "x", "--timeout", "5m"]).is_err());
        // The full forms parse.
        assert!(Cli::try_parse_from(["termic", "send", "foo", "-p", "x"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "send", "--here", "-p", "-"]).is_ok());
        assert!(Cli::try_parse_from([
            "termic", "send", "foo", "-p", "x", "--resume", "--wait", "--timeout", "5m",
        ])
        .is_ok());
        // Task-less send resolves from cwd, so a bare send parses too.
        assert!(Cli::try_parse_from(["termic", "send", "-p", "x"]).is_ok());
    }

    #[test]
    fn phase2_verbs_parse() {
        assert!(Cli::try_parse_from(["termic", "attach"]).is_ok());
        assert!(Cli::try_parse_from([
            "termic", "attach", "foo", "--shell", "--resize", "--detach-keys", "ctrl-p,ctrl-q",
        ])
        .is_ok());
        assert!(Cli::try_parse_from(["termic", "logs", "foo", "--shell", "--bytes", "4096"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "result"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "diff", "foo", "--full"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "apply", "foo", "--yes"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "path", "foo"]).is_ok());
        // apply is destructive-adjacent: the task name is REQUIRED.
        assert!(Cli::try_parse_from(["termic", "apply"]).is_err());
        // --project still needs a task name on the cwd-aware verbs.
        for verb in ["logs", "result", "diff", "path", "attach"] {
            assert!(
                Cli::try_parse_from(["termic", verb, "--project", "web"]).is_err(),
                "{verb} --project without a task must not parse"
            );
        }
    }

    #[test]
    fn rename_positional_rules() {
        // One positional is the NAME (task falls back to $TERMIC_TASK_ID
        // then cwd); two are TASK + NAME. allow_missing_positional does
        // the back-filling; these tests pin that it stays configured.
        let one = Cli::try_parse_from(["termic", "rename", "PR 123 - fix login"]).unwrap();
        let Cmd::Rename { task, name, project } = &one.cmd else { panic!("not rename") };
        assert_eq!(task.as_deref(), None);
        assert_eq!(name, "PR 123 - fix login");
        assert_eq!(project.as_deref(), None);

        let two = Cli::try_parse_from(["termic", "rename", "old-task", "new name"]).unwrap();
        let Cmd::Rename { task, name, .. } = &two.cmd else { panic!("not rename") };
        assert_eq!(task.as_deref(), Some("old-task"));
        assert_eq!(name, "new name");

        let scoped =
            Cli::try_parse_from(["termic", "rename", "old", "new", "--project", "web"]).unwrap();
        let Cmd::Rename { task, name, project } = &scoped.cmd else { panic!("not rename") };
        assert_eq!(task.as_deref(), Some("old"));
        assert_eq!(name, "new");
        assert_eq!(project.as_deref(), Some("web"));

        // No positionals at all: nothing to rename to.
        assert!(Cli::try_parse_from(["termic", "rename"]).is_err());
        // --project only disambiguates an explicit task name.
        assert!(Cli::try_parse_from(["termic", "rename", "new", "--project", "web"]).is_err());
    }

    #[test]
    fn rename_render_contract() {
        let cmd = Cmd::Rename { task: None, name: "new".into(), project: None };
        let data = proto::ReplyData::Rename(proto::RenameData {
            task: proto::TaskSummary {
                id: "w1".into(),
                name: "PR 123 - fix login".into(),
                project: "web".into(),
                branch: "fix-thing".into(),
                ..Default::default()
            },
            old_name: "fix-thing".into(),
        });
        let text = render(&cmd, OutputFormat::Text, data.clone()).unwrap();
        assert_eq!(
            text,
            "renamed web/fix-thing to \"PR 123 - fix login\" (branch fix-thing and its directory are unchanged)"
        );
        let json = render(&cmd, OutputFormat::Json, data).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["task"]["name"], "PR 123 - fix login");
        assert_eq!(v["old_name"], "fix-thing");

        // A main-checkout task has no task-owned branch to reassure about.
        let main = proto::ReplyData::Rename(proto::RenameData {
            task: proto::TaskSummary {
                name: "docs".into(),
                project: "web".into(),
                is_main_checkout: true,
                ..Default::default()
            },
            old_name: "main".into(),
        });
        assert_eq!(
            render(&cmd, OutputFormat::Text, main).unwrap(),
            "renamed web/main to \"docs\""
        );
    }

    #[test]
    fn parse_duration_grammar() {
        assert_eq!(parse_duration_ms("90").unwrap(), 90_000);
        assert_eq!(parse_duration_ms("30s").unwrap(), 30_000);
        assert_eq!(parse_duration_ms("5m").unwrap(), 300_000);
        assert_eq!(parse_duration_ms("1h").unwrap(), 3_600_000);
        assert_eq!(parse_duration_ms("1h30m").unwrap(), 5_400_000);
        assert_eq!(parse_duration_ms("2m30s").unwrap(), 150_000);
        for bad in ["", "s", "12x", "5m3", "-5", "1.5h"] {
            assert!(parse_duration_ms(bad).is_err(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn help_carries_no_em_dashes() {
        // Repo copy rule: no em dashes in any user-visible text, and the
        // whole surface means every nested subcommand too.
        fn sweep(cmd: &mut clap::Command, path: &str) -> String {
            let mut all = format!("{}", cmd.render_long_help());
            let names: Vec<String> =
                cmd.get_subcommands().map(|s| s.get_name().to_string()).collect();
            for name in names {
                let sub = cmd.find_subcommand_mut(&name).unwrap();
                all.push_str(&sweep(&mut sub.clone(), &format!("{path} {name}")));
            }
            all
        }
        let mut root = Cli::command();
        let all = sweep(&mut root, "termic");
        assert!(!all.contains('\u{2014}'), "copy rule: no em dashes in help text");
    }

    #[test]
    fn machine_help_covers_the_surface() {
        let v = machine_help();
        assert_eq!(v["app"], "termic");
        assert_eq!(v["protocol"], proto::PROTOCOL_VERSION);
        let names: Vec<&str> =
            v["commands"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        for expected in [
            "list", "status", "open", "new", "send", "attach", "logs", "result", "diff",
            "apply", "path", "wait", "archive", "tab", "agents", "quit", "project add",
            "project list",
            "project remove", "help",
        ] {
            assert!(names.contains(&expected), "missing {expected} in {names:?}");
        }
        // Every command documents exit codes; watched verbs carry theirs.
        let by_name = |n: &str| {
            v["commands"].as_array().unwrap().iter().find(|c| c["name"] == n).unwrap().clone()
        };
        let new_cmd = by_name("new");
        assert_eq!(new_cmd["exit_codes"]["9"], "prompt never delivered");
        assert_eq!(by_name("send")["exit_codes"]["9"], "prompt never delivered");
        assert!(by_name("apply")["exit_codes"]["10"]
            .as_str()
            .unwrap()
            .contains("conflicted"));
        assert!(by_name("attach")["exit_codes"]["11"]
            .as_str()
            .unwrap()
            .contains("closed"));
        assert_eq!(v["exit_codes"]["7"], "timeout expired");
        // Global flags are introspectable too: stream-json lives there,
        // and it is the flag the streaming contract hangs on.
        let globals: Vec<&str> = v["global_flags"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f["flag"].as_str())
            .collect();
        for f in ["--output-format", "--json", "--no-launch"] {
            assert!(globals.contains(&f), "missing {f} in {globals:?}");
        }
        // Flags are introspectable (an agent reads these, not the prose).
        let flags: Vec<&str> = new_cmd["flags"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f["flag"].as_str())
            .collect();
        for f in ["--prompt", "--agent", "--wait", "--sandbox", "--timeout"] {
            assert!(flags.contains(&f), "missing {f} in {flags:?}");
        }
        // And the whole machine surface obeys the copy rule.
        assert!(!output::json(&v).contains('\u{2014}'));
    }

    #[test]
    fn every_verb_exit_code_is_in_the_table() {
        // The per-verb lists derive their descriptions from
        // EXIT_CODE_TABLE; a code outside it would render as "".
        let v = machine_help();
        for cmd in v["commands"].as_array().unwrap() {
            for (code, desc) in cmd["exit_codes"].as_object().unwrap() {
                assert!(
                    !desc.as_str().unwrap().is_empty(),
                    "exit code {code} of {} has no description",
                    cmd["name"]
                );
            }
        }
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

    #[test]
    fn cage_refusal_exempts_monitor_only() {
        // Enforcing cages: refused. Monitor: allowed by contract
        // (observe, never block; CLI use shows up in the log). An
        // absent/unknown mode (older app) refuses, the safe default.
        assert!(cage_refused(Some("1"), Some("enforce")));
        assert!(cage_refused(Some("1"), Some("enforce-fs")));
        assert!(cage_refused(Some("1"), None));
        assert!(cage_refused(Some("1"), Some("weird")));
        assert!(!cage_refused(Some("1"), Some("monitor")));
        // Not sandboxed at all: never refused, whatever mode says.
        assert!(!cage_refused(None, None));
        assert!(!cage_refused(None, Some("enforce")));
        assert!(!cage_refused(Some("0"), Some("enforce")));
    }

    #[test]
    fn stream_error_surfaces_unregistered_root() {
        let e = StreamError::Domain(proto::ErrorBody {
            code: proto::ErrorCode::UnregisteredProject,
            message: "not registered".into(),
            data: Some(serde_json::json!({ "root": "/repo/x" })),
        });
        assert_eq!(e.unregistered_root().as_deref(), Some("/repo/x"));
        assert_eq!(e.into_cli().code, exit_code::ERROR);
        let io = StreamError::Io(CliError::new(exit_code::CONNECTION_LOST, "gone"));
        assert!(io.unregistered_root().is_none());
        assert_eq!(io.into_cli().code, exit_code::CONNECTION_LOST);
    }
}
