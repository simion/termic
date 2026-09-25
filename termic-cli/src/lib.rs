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

use clap::{CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum};
use std::io::Read as _;
use termic_proto as proto;
use termic_proto::exit_code;

/// `termic hook-emit <target>`: copy stdin (an agent hook's OSC report) to
/// `target`, the terminal the hook reports to.
///
/// Exists for Windows, where `target` is the named pipe the app serves in
/// place of a PTY slave (src-tauri/src/hook_pipe.rs): Git Bash's `>` cannot
/// open a named pipe, and this opens it for writing the ordinary way. Also
/// correct for a plain file or a tty on unix, though the scripts only use it
/// on Windows. Exit 0 when written, 1 otherwise; never prints (a hook's
/// output is the agent's to render).
pub fn hook_emit(target: Option<&std::path::Path>) -> i32 {
    use std::io::Read;
    /// A report is a few OSC sequences; anything larger is not one.
    const MAX: u64 = 64 * 1024;
    let Some(target) = target else { return 1 };
    let mut body = Vec::new();
    if std::io::stdin().lock().take(MAX).read_to_end(&mut body).is_err() || body.is_empty() {
        return 1;
    }
    i32::from(write_report(target, &body).is_err())
}

/// Write one hook report to `target`. A named pipe reports "all instances
/// busy" (ERROR_PIPE_BUSY, 231) for the moment between the server accepting
/// one hook and listening for the next, so two hooks firing together would
/// otherwise lose one report: retry that, briefly, and nothing else.
pub fn write_report(target: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    const PIPE_BUSY: i32 = 231;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match std::fs::OpenOptions::new().write(true).open(target) {
            Ok(mut f) => {
                f.write_all(body)?;
                return f.flush();
            }
            Err(e) if e.raw_os_error() == Some(PIPE_BUSY) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
}

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

/// Who is reading this and what they can do, for the long `--help` and
/// `help --json`'s `overview`. The MCP server says the same thing in tool
/// names (`MCP_INSTRUCTIONS` in src-tauri/src/mcp_server.rs): keep the two in
/// step. An agent that does not realise it is INSIDE Termic never reaches for
/// any of this, which is the whole reason the text exists.
macro_rules! agent_overview {
    () => {
        "If $TERMIC_TASK_ID is set, you are an agent running INSIDE a Termic task \
right now. Termic runs coding agents side by side, each in its own task (a git \
worktree, or the project's main checkout, with its own terminal), listed in the \
app's sidebar; this CLI drives the app around you. From your task you can: \
start another agent beside you (`tab`); launch new tasks with their own agents \
(`new`), which join YOUR task's group in the sidebar (in your project; one in \
another project is linked to yours instead), a block you name for the \
batch of work with `group --name`; prompt another task's agent (`send`) and \
read what it produced (`logs`, `result`); retitle your own task \
(`rename`); and keep notes, plans, findings, logs and reports the user \
should READ in a scratchpad (`scratchpad new`, `scratchpad write`), a tab \
in your task that updates live and stays out of git: use one instead of \
dropping temporary .md files into the repo. Coordinate by prompting \
each other rather than blocking: end a prompt with the `send` back to your task \
you want run when the work is done. Without $TERMIC_TASK_ID you are driving \
Termic from outside it: name tasks explicitly."
    };
}

/// The four things an agent inside a task reaches for, at the top of
/// `termic --help` so they are found before the full command list. Every
/// one targets the caller's own task ($TERMIC_TASK_ID) with no argument.
macro_rules! quick_start_help {
    () => {
        "\
Quick start, from inside a task (your own task is the default target):
  termic tab --agent claude -p \"<prompt>\"                start another agent in this task
  termic scratchpad new --title \"<title>\" -c \"<text>\"    create a scratchpad, prints its id
  termic scratchpad write <id> --append -c \"<text>\"      update it (omit -c to read stdin)
  termic new <name> -p \"<prompt>\"                        launch a new task with its agent
  termic group --name \"<what this batch is>\"              name the group your new tasks join"
    };
}

#[derive(Parser, Debug)]
#[command(
    name = "termic",
    bin_name = "termic",
    version = VERSION,
    disable_help_subcommand = true,
    about = concat!(
        "Control the Termic app from any shell: create and drive agent tasks, list them, wait on them. \
If $TERMIC_TASK_ID is set, you are running inside a Termic task: `termic --help` says what you can do from there.\n\n",
        quick_start_help!()
    ),
    long_about = concat!(
        "Control the Termic app from any shell. The app is the daemon: every command \
talks to the running Termic over a local socket and fails fast when it cannot. \
Requires the CLI to be enabled in Termic Settings (General). \
`termic help --json` prints the whole command surface machine-readably.\n\n",
        agent_overview!(),
        "\n\n",
        quick_start_help!()
    ),
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

    /// Address a specific profile by name or slug (GH #280).
    ///
    /// A profile is a fully separate Termic in its own window. Omitted, a
    /// command addresses the profile that owns the project it names, and
    /// falls back to the most recently focused window when it names none.
    /// An unknown profile is an error, never a silent fallback to another
    /// one, matching how an unknown project is already treated.
    #[arg(long, global = true, value_name = "NAME")]
    pub profile: Option<String>,
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

-P/--library delivers a prompt from the prompt library (see `termic \
prompts`); with -p too, the body arrives first, then a blank line, then the \
text, and a bad selector fails BEFORE the task is created. That composition \
is the cross-agent handoff: `termic result plan | termic new review --agent \
codex -P builtin:review -p -` starts a second agent on the first one's \
output under a curated prompt.

With --from <PATH> the task ADOPTS an existing worktree instead of creating \
one: the path must already be a git worktree of the project's repo, the \
branch comes from its HEAD, the name defaults to that branch, and no setup \
script runs. --resume <SESSION_ID> makes the agent resume that session on \
its first spawn (an agent with id-resume support, e.g. claude), which \
attaches work started outside Termic (GH #169). It also works without \
--from, though agents look sessions up by directory, so it is most useful \
where the task's directory matches the session's (--from or --main).

With --checkout <BRANCH> the new worktree checks out an EXISTING branch \
instead of cutting one, for reviewing or continuing someone else's work: a \
local branch, <remote>/<branch>, or a name that only exists on the remote \
(fetched and tracked). It never creates a branch from the base; an unknown \
one is an error. --base then only sets what the diff compares against, and \
the name defaults to the branch.

Without --wait the command returns at spawn; a prompt keeps injecting \
app-side but is NOT confirmed. With --wait it blocks until the prompt is \
confirmed delivered AND that turn settles (or, with no prompt, until the \
agent is quiescent). Settle detection is heuristic: exit 0 means the agent \
STOPPED, not that the work is right. Ctrl-C stops watching only; the task \
keeps running in Termic.

Getting results out: from inside a task, ask the agent IN THE PROMPT to \
report back to you when it is done (a signed `send` to your \
$TERMIC_TASK_ID, see `send --help`); the report arrives in your own \
terminal and is the normal way results come back. If none arrives, \
`result` and `logs` read what the agent produced. A file is the FALLBACK, \
for an agent that cannot report back (sandboxed in enforce/enforce-fs) or \
a caller with no task to be prompted at (a script): tell the agent in the \
prompt to write its deliverable to a file in the task directory (for \
example RESULT.md), then read <path>/RESULT.md after --wait exits 0. The \
path is printed at creation and is .task.path in the --json output. \
Unattended runs need --yolo or --sandbox enforce, or the agent stops at its \
first permission prompt; the cage self-approves inside it but costs you the \
report-back.

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
        /// Optional with --from or --checkout: it defaults to the branch.
        #[arg(required_unless_present_any = ["from", "checkout"])]
        name: Option<String>,
        /// Prompt to inject once the agent is ready. `-` reads stdin.
        #[arg(short, long)]
        prompt: Option<String>,
        /// Prompt-library selector: a prompt id (builtin:review, a custom
        /// prompt's UUID) or its exact title, case-insensitive. Delivers
        /// that prompt's body; with -p too, the body, a blank line, then
        /// the text. See `termic prompts`.
        #[arg(short = 'P', long = "library", value_name = "SEL")]
        library: Option<String>,
        /// Agent CLI id (claude, codex, ...). Default: the project's default agent.
        #[arg(long)]
        agent: Option<String>,
        /// Model for this task's agent. Appended after --arg values so an
        /// explicit model wins when the agent uses last-value-wins parsing.
        #[arg(long, value_name = "MODEL")]
        model: Option<String>,
        /// Additional argument for this task's agent. Repeat for multiple
        /// argv elements; use --arg=VALUE when VALUE begins with a dash.
        #[arg(long = "arg", value_name = "ARG", allow_hyphen_values = true)]
        agent_args: Vec<String>,
        /// Create an isolated git worktree for the task (the default is
        /// the GUI's remembered mode).
        #[arg(long, conflicts_with = "main")]
        worktree: bool,
        /// Open the agent in the repo's live main checkout instead of a worktree.
        #[arg(long)]
        main: bool,
        /// Base branch for the worktree (default: the repo's default base).
        /// With --checkout, what the diff compares against.
        #[arg(long, conflicts_with = "main")]
        base: Option<String>,
        /// Check out this EXISTING branch into the new worktree instead of
        /// cutting a new one: a local branch, <remote>/<branch>, or a name
        /// only on the remote (fetched and tracked). Never creates a
        /// branch; an unknown one is an error. Implies --worktree.
        #[arg(long, value_name = "BRANCH", conflicts_with_all = ["main", "from"])]
        checkout: Option<String>,
        /// Adopt an EXISTING worktree of the project's repo as the task,
        /// instead of creating one. The path must already be a registered
        /// git worktree (`git worktree add` done by you or a script); no
        /// setup script runs. The project resolves from the worktree's
        /// repo when --project is absent.
        #[arg(long, value_name = "PATH", conflicts_with_all = ["worktree", "main", "base"])]
        from: Option<String>,
        /// Session id the agent resumes on its first spawn (e.g. a claude
        /// session started outside Termic). Needs an agent with id-resume
        /// support; the id is not validated, a wrong one surfaces as the
        /// agent's own "session not found". Most useful with --from or
        /// --main, where the task's directory matches the session's.
        #[arg(long, value_name = "SESSION_ID")]
        resume: Option<String>,
        /// Sandbox mode for the task. Default: the project's sandbox seeds.
        /// `enforce` / `enforce-fs` also deny the new agent the control
        /// plane, so it can never report back to you: ask it for a file in
        /// its worktree instead. `monitor` reaches the CLI by contract.
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
        /// Settle detection is a heuristic and you can do nothing while
        /// blocked: to coordinate with the new agent, prefer asking it in
        /// the prompt to report back with `termic send <your task id>`.
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this long (exit 7). E.g. 90, 30s, 5m, 1h.
        #[arg(long, requires = "wait", value_name = "DURATION")]
        timeout: Option<String>,
        /// Run from inside a task, the new task joins YOUR task's group in
        /// the sidebar (see `group`). This keeps it out.
        #[arg(long)]
        no_group: bool,
    },

    /// Block until the task's agent is quiescent (settled, empty queue).
    /// Coordinating two agents is better done with prompts than with this:
    /// see the notes under `send`.
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
finishes, EXCEPT while the agent is stalled on work it delegated (subagents \
or shells still running, its own loop stopped): then it is typed at once, so \
a report back reaches an orchestrator that is waiting on it. It also QUEUES \
while the user has an unsent draft typed into that agent, so it never lands \
in the middle of their text; it goes once they send or clear it. An agent with \
detection disabled gets it typed immediately (with a warning: completion \
cannot be observed, and --wait refuses such agents). \
With no agent running, --resume restores the last session and --fresh starts \
a new agent without context; without either flag that case is an error \
naming both. If a stored session no longer resolves, --resume falls back to \
a fresh agent and the prompt still delivers there (the app's own recovery \
path). -p - reads the prompt from stdin, so `git diff | termic send \
foo -p -` works. -P/--library delivers a prompt from the prompt library \
(see `termic prompts`); with -p too, the body arrives first, then a blank \
line, then the text. --here targets the surrounding task ($TERMIC_TASK_ID); \
without <TASK> or --here the task resolves from the current directory.

Without --wait the command returns once the prompt is delivered (queued and \
respawn deliveries stay unconfirmed). With --wait it blocks until the \
prompt is confirmed delivered AND that turn settles, the same contract as \
new --wait; settle detection is heuristic (the agent STOPPED, not that the \
work is right), and because a sibling tab's state is never trusted as this \
prompt's turn, a very short turn can take up to 30s extra to report done; \
size --timeout accordingly. Each --fresh adds a NEW agent tab to the task \
(none are reused or closed). Ctrl-C stops watching only.

COORDINATING TWO AGENTS: prompt each other, do not wait on each other. \
--wait ties you to a work-done heuristic (a settled terminal is a guess, not \
a finished job) and you can do nothing else while it blocks. Instead end \
every prompt you send with the command you want run when that work is done, \
and let the receiving agent choose the moment:

  termic send <task> -p \"[message from agent:claude task:$TERMIC_TASK \
id:$TERMIC_TASK_ID] <your prompt here: what you want it to do>. When done, \
reply: termic send $TERMIC_TASK_ID -p '[message from agent:<its agent> \
task:<its task name> id:<its task id>] done: <what you did> -- agent:<its \
agent> task:<its task name> id:<its task id>' -- agent:claude \
task:$TERMIC_TASK id:$TERMIC_TASK_ID\"

(Fill the <its ...> parts with the task you are prompting: you know its \
name and id, it is the one you are sending to.)

EVERY PROMPT ONE AGENT SENDS ANOTHER opens with the header \
`[message from agent:<agent> task:<task name> id:<task id>]` and ends with \
the signature `-- agent:<agent> task:<task name> id:<task id>`, naming the \
SENDER (you): your agent name, your task's name ($TERMIC_TASK) and its id \
($TERMIC_TASK_ID, which is where a reply goes). The receiver cannot \
otherwise tell a peer's prompt from the user typing, or which peer. A prompt that arrives WITH that header came from \
another agent, not from the user: treat it as a request from a peer (the \
user's own instructions win if the two conflict), and put the same header \
and your own signature on your reply.

The outer DOUBLE quotes are load-bearing: YOUR shell expands \
$TERMIC_TASK and $TERMIC_TASK_ID at send time, so the other agent is handed a literal \
address it can just run. Single quotes there would block expansion and \
leave it guessing. A prompt arriving in your terminal IS that report. With \
no task of your own to be prompted back at, ask for a file instead and \
read it when you next have a reason to.

A task sandboxed in `enforce` / `enforce-fs` CANNOT take part: the cage \
denies it the control plane outright, so it can neither be asked to report \
back nor do so. That is deliberate and will not change - a cage with a \
text channel to an uncaged agent is not a cage - so do not wire a \
report-back for one. Ask it for a file in its own worktree and read that \
yourself, or run the task in `monitor` (which reaches the CLI by contract) \
or uncaged. `--sandbox` on `new` is where that is chosen.

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
        /// The prompt. `-` reads stdin. At least one of -p / -P is
        /// required.
        #[arg(short, long, required_unless_present = "library")]
        prompt: Option<String>,
        /// Prompt-library selector: a prompt id (builtin:review, a custom
        /// prompt's UUID) or its exact title, case-insensitive. Delivers
        /// that prompt's body; with -p too, the body, a blank line, then
        /// the text. See `termic prompts`.
        #[arg(short = 'P', long = "library", value_name = "SEL")]
        library: Option<String>,
        /// No agent running: restore the last session, then deliver.
        #[arg(long)]
        resume: bool,
        /// No agent running: start a fresh agent (no context), then deliver.
        #[arg(long, conflicts_with = "resume")]
        fresh: bool,
        /// Block until the prompt is confirmed delivered and its turn
        /// settles (or the agent asks for input). Settle detection is a
        /// heuristic and you can do nothing while blocked: to coordinate
        /// with the agent, prefer ending the prompt with an instruction to
        /// report back via `termic send <your task id>`.
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

    /// List the prompt library: what -P/--library accepts.
    #[command(
        after_help = "Answers \"what can I pass to -P?\". The library is per-user and editable \
in Settings (built-ins plus custom prompts), so it cannot live in static \
help. One row per prompt: id, title, builtin or custom, enabled, modified.
The ID is the stable identity (builtin:review, or a custom prompt's UUID); \
titles are user-editable conveniences. Pin ids in scripts, use titles \
interactively. A prompt disabled in Settings is hidden from the GUI \
dropdown but still listed here and still fireable by explicit selector; \
deleted built-ins are not listed and do not resolve.

Prints a table on stdout. With --output-format json, one object: \
{\"prompts\": [{\"id\", \"title\", \"builtin\", \"enabled\", \"modified\"}]}.

Exit codes: 0 listed, 1 error, 4 app not running, 5 CLI disabled, \
6 refused, 8 connection lost."
    )]
    Prompts {
        #[command(subcommand)]
        cmd: Option<PromptsCmd>,
    },
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

Without <TASK>, opens the tab in your own task ($TERMIC_TASK_ID, injected into \
every agent shell), then falls back to the current directory. So from inside \
a task, `termic tab --agent codex -p \"review my diff\"` starts a second agent \
beside you.

The new tab is NOT focused: a shell command should not yank the window you \
are working in.

-p injects a prompt into the NEW tab once its agent is ready (agent kinds \
only), through the same confirmed delivery route `send --tab` uses; the \
new tab's id is the target, so a second tab opening meanwhile cannot \
steal it. Without --wait the command returns once the injection is \
underway (mode \"spawned\" stays unconfirmed, like send); with --wait it \
blocks until the prompt is confirmed delivered AND that turn settles, the \
send --wait contract. -p - reads the prompt from stdin. -P/--library \
delivers a prompt from the prompt library (agent kinds only; same \
composition as new/send), and a bad selector fails before the tab opens.

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

--title names the tab, for every kind. It is set the way a double-click \
rename sets it, so the agent retitling itself mid-turn cannot replace it and \
it survives a relaunch, which makes it a selector a script can key on: \
`termic tab fix-auth --agent claude --title reviewer -p \"...\"`, then \
`termic send fix-auth --tab reviewer`. A title must be unique among the \
task's tabs (compared case-insensitively, and against their agent ids \
too, since --tab matches those), and cannot be a bare number, which --tab \
reads as a position.

--tab <TAB> --title <TITLE> renames an OPEN tab instead of opening one \
(any tab: agent, shell or custom terminal). --title \"\" clears the rename, \
and the tab goes back to its automatic, agent-driven title. None of the \
open-a-tab flags apply there.

`termic tab close` is the other half: the tab strip's close button as a \
verb, for cleaning up the tabs a script opened. See \
`termic tab close --help`.

Exit codes: 0 opened or renamed (with --wait: settled done), 1 error \
(unknown or ambiguous task or tab, unusable agent id, prompt on a \
non-agent tab, --wait without -p/-P, a title already in use or not \
allowed), 3 agent stopped needing input, 4 app not running, 5 CLI \
disabled, 6 refused, 7 --timeout expired, 8 connection lost, 9 prompt \
never delivered."
    )]
    #[command(args_conflicts_with_subcommands = true)]
    Tab {
        /// Close a tab instead of opening one.
        #[command(subcommand)]
        close: Option<TabCmd>,
        /// Task name, task id, or qualified project/name. Omitted:
        /// $TERMIC_TASK_ID, then the current directory.
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
        /// Prompt-library selector: a prompt id (builtin:review, a custom
        /// prompt's UUID) or its exact title, case-insensitive. Delivers
        /// that prompt's body; with -p too, the body, a blank line, then
        /// the text. See `termic prompts`.
        #[arg(short = 'P', long = "library", value_name = "SEL",
              conflicts_with_all = ["shell", "terminal"])]
        library: Option<String>,
        /// Session id the new tab's agent resumes (e.g. a claude session
        /// started outside Termic). Needs --agent, and one with id-resume
        /// support; the id is not validated, a wrong one surfaces as the
        /// agent's own "session not found".
        #[arg(long, value_name = "SESSION_ID", requires = "agent")]
        resume: Option<String>,
        /// Block until the prompt is confirmed delivered and its turn
        /// settles (or the agent asks for input). Needs -p or -P.
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this long (exit 7). E.g. 90, 30s, 5m, 1h.
        #[arg(long, requires = "wait", value_name = "DURATION")]
        timeout: Option<String>,
        /// Title for the tab, kept even when the agent retitles itself.
        /// With --tab, renames that open tab instead. "" = the automatic
        /// title (clears a rename).
        #[arg(long, value_name = "TITLE")]
        title: Option<String>,
        /// Rename this OPEN tab instead of opening one: a tab id, a 1-based
        /// strip index, or a title. Needs --title.
        #[arg(long, value_name = "TAB", requires = "title",
              conflicts_with_all = ["agent", "terminal", "shell", "prompt", "library", "resume", "wait", "timeout"])]
        tab: Option<String>,
    },

    /// Scratchpads in a task: notes an agent writes for the human to read.
    // `pad` stays as a hidden alias: it is the short name an agent guesses.
    #[command(subcommand, name = "scratchpad", alias = "pad")]
    Pad(PadCmd),

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

    /// Show, rename or recolour your task's sidebar group.
    #[command(
        after_help = "Tasks you create with `new` from inside a task join YOUR task's group: \
the sidebar draws them as one coloured block, captioned, with your task as \
its lead, so the user sees which tasks you started. A worker that creates \
tasks in turn adds them to the same (top-level) group. A task created in \
ANOTHER project joins no group (a group lives in one project's list): the \
sidebar links it to your task instead. Pass --no-group to `new` to keep a \
task out.

Without --name or --color, prints the group: its name, colour and members. \
--name gives it a name the user will read (say what the batch of work is, \
e.g. \"Auth refactor\"); --name \"\" returns it to following the lead \
task's name, which is what a new group does. --color picks one of red, \
orange, yellow, green, teal, blue, purple, pink. A task in no group founds \
one around itself when you set either, so you can name the group before \
you create any workers.

Without <TASK>, targets your own task ($TERMIC_TASK_ID), then the current \
directory.

With --output-format json, one object: {\"task\", \"group\": {\"id\", \
\"name\", \"named\", \"color\", \"members\"}}, group absent when the task \
is in none.

Exit codes: 0 ok, 1 error (unknown task, unknown colour, archived task), \
4 app not running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Group {
        /// Task name, task id, or qualified project/name. Omitted:
        /// $TERMIC_TASK_ID, then the current directory.
        task: Option<String>,
        /// Name the group ("" to follow the lead task's name again).
        #[arg(long)]
        name: Option<String>,
        /// Group colour.
        #[arg(long, value_parser = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"])]
        color: Option<String>,
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
pub enum PromptsCmd {
    /// Print one prompt's body on stdout (pipe-friendly).
    #[command(
        after_help = "Resolves the selector exactly as -P does: an exact prompt id first \
(builtin:review, or a custom prompt's UUID), then a case-insensitive exact \
title match. A title matching more than one prompt is an error listing the \
candidates with their ids; a disabled prompt still resolves (disabled means \
hidden from the GUI dropdown, not dead). Prints the body and nothing else, \
so it pipes.

A body too large for the reply line arrives trimmed: a warning goes to \
stderr and the json carries \"truncated\": true (the body itself gets no \
marker text, so piping it stays clean). An empty-bodied prompt is refused \
by name, the same rule as -P.

With --output-format json, one object: {\"id\", \"title\", \"builtin\", \
\"enabled\", \"modified\", \"body\", \"truncated\" (only when trimmed)}.

Exit codes: 0 printed, 1 error (unknown or ambiguous selector, empty \
body), 4 app not running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Show {
        /// Prompt id (builtin:review, a custom prompt's UUID) or title.
        selector: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum TabCmd {
    /// Close one tab of a running task: the tab strip's close button as a command.
    #[command(
        after_help = "Closes ONE tab and leaves the task and its other tabs alone, which is \
what separates this from `archive`: an orchestrator cleaning up the tabs it \
opened must not take down the session it is driving from.

The tab is identified the same way `send`/`wait`/`attach`/`logs` identify \
one: --tab takes the tab id, a 1-based strip index, or a title/cli name, \
and ambiguity is an error listing the candidates rather than a guess.

Unlike those verbs, this one reaches EVERY tab in the strip, shell and \
custom-terminal tabs included. They are write-only from the CLI because \
driving an uncaged terminal remotely is the thing that rule prevents, and \
closing is not driving. `termic tab --shell` can open one, so it has to be \
able to clean one up.

There is no `/exit` negotiation and no prompt: the tab leaves the strip and \
its process is killed, exactly as the window's own close button does it. The \
server then sweeps that tab's PTY, so the command does not answer until \
termination is certain rather than merely requested. A live `attach` session \
on the tab is told why it is ending and exits 11.

Closing the task's LAST tab puts the task to sleep, which also ends its aux \
shell and any split-pane agent. Everything attached to the task is told.

A SECONDARY tab is forgotten: it leaves the task's durable set, and the \
only way back is the window's Resume menu. The DEFAULT tab is different, it \
is durable and the task reopens it, so closing it ends the agent for now \
rather than for good. Closing the default tab is REFUSED without --yes, \
even when its agent has already exited: it is the tab every unqualified \
`send`/`wait`/`attach` resolves to, so closing it silently changes what \
the caller's other commands are talking to.

Prints what was closed on stdout. With --output-format json, one object: \
{\"task_id\", \"tab_id\", \"cli\", \"title\", \"tab_kind\", \"was_default\", \
\"killed_pty\"}.

Exit codes: 0 closed, 1 error (unknown or ambiguous task, no tab matches \
the selector, the default tab without --yes), 4 app not running, \
5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Close {
        /// Task name, task id, or qualified project/name.
        task: Option<String>,
        /// Project name, to disambiguate.
        #[arg(long, requires = "task")]
        project: Option<String>,
        /// Which tab: its id, a 1-based strip index, or its title/cli.
        #[arg(long, value_name = "SELECTOR")]
        tab: String,
        /// Permit closing the task's DEFAULT tab.
        #[arg(short, long)]
        yes: bool,
    },
}

/// Which task a pad verb acts on. Shared by every `scratchpad` subcommand.
#[derive(clap::Args, Debug, Clone, Default)]
pub struct PadTarget {
    /// Task name, task id, or qualified project/name. Omitted: your own
    /// task ($TERMIC_TASK_ID), then the current directory.
    #[arg(long)]
    pub task: Option<String>,
    /// Project name, to disambiguate. Requires --task.
    #[arg(long, requires = "task")]
    pub project: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum PadCmd {
    /// List the task's scratchpads.
    #[command(
        after_help = "Prints one row per pad: id, title, and whether it is open in the window. \
With --output-format json, one object: {\"task_id\", \"pads\": [{\"id\", \"title\", \
\"syntax\", \"open\"}]}.

Exit codes: 0 listed, 1 error (unknown or ambiguous task), 4 app not running, \
5 CLI disabled, 6 refused, 8 connection lost."
    )]
    List {
        #[command(flatten)]
        target: PadTarget,
    },
    /// Create a scratchpad, optionally titled and seeded with text.
    #[command(
        after_help = "A scratchpad is a note that lives with the task but outside the worktree: \
nothing you put there shows up in git, and the human sees it as a tab. Use \
one for findings, a plan, or a report meant to be READ rather than \
committed. The pad opens as a tab without taking focus.

Prints the new pad's id on stdout. That id is the stable selector: titles \
are editable, and an untitled pad is named after its first line.

-c/--content seeds the text; `-c -` reads stdin. --title names the pad and \
keeps that name however the text changes.

With --output-format json, one object: {\"task_id\", \"pads\": [{\"id\", \
\"title\", \"syntax\", \"open\"}]}.

Exit codes: 0 created, 1 error (unknown task, content too large), 4 app not \
running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    New {
        #[command(flatten)]
        target: PadTarget,
        /// A fixed title for the tab.
        #[arg(long)]
        title: Option<String>,
        /// Initial text. `-` reads stdin.
        #[arg(short, long)]
        content: Option<String>,
    },
    /// Replace a scratchpad's text, or append to it.
    #[command(
        after_help = "<PAD> is the pad's id (from `scratchpad new` or `scratchpad list`) or its exact title, \
case-insensitive. A title shared by two pads is an error listing their ids.

The text comes from -c/--content, or from stdin when -c is omitted or `-`, \
so `make test 2>&1 | termic scratchpad write results --append` works. If the pad is \
open in the window, it updates in place and the human sees the change \
immediately; the write is undoable there with Cmd+Z.

With --output-format json, one object: {\"task_id\", \"pads\": [the pad]}.

Exit codes: 0 written, 1 error (unknown or ambiguous pad or task, content \
too large), 4 app not running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Write {
        /// Pad id or exact title.
        pad: String,
        #[command(flatten)]
        target: PadTarget,
        /// The text. `-` (or omitting it) reads stdin.
        #[arg(short, long)]
        content: Option<String>,
        /// Add to the end instead of replacing.
        #[arg(long)]
        append: bool,
    },
    /// Print a scratchpad's text on stdout (pipe-friendly).
    #[command(
        after_help = "<PAD> is the pad's id or its exact title, case-insensitive. Reads what \
the window shows, including edits the human has not paused on yet. Prints \
the text and nothing else, so it pipes.

A pad too large for the reply line arrives trimmed: a warning goes to stderr \
and the json carries \"truncated\": true.

With --output-format json, one object: {\"task_id\", \"pads\": [the pad], \
\"content\", \"truncated\" (only when trimmed)}.

Exit codes: 0 printed, 1 error (unknown or ambiguous pad or task), 4 app not \
running, 5 CLI disabled, 6 refused, 8 connection lost."
    )]
    Read {
        /// Pad id or exact title.
        pad: String,
        #[command(flatten)]
        target: PadTarget,
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

/// Help header: the build's version, on `--help` and not just
/// `--version`.
///
/// It answers a question this CLI made real. `termic` is ONE command for
/// both release apps (they share a data dir, therefore a socket,
/// therefore a single running instance), so the symlink can point into
/// either bundle, and "which build am I actually running" has a
/// non-obvious answer that `--help` is the natural place to see. The
/// version is the APP version the binary was built with (`VERSION`), so
/// one line covers both halves.
///
/// clap 3 printed this line by default and clap 4 dropped it; this is
/// that line, on every subcommand's help too.
///
/// `{version}` is deliberately NOT used: it renders empty on a
/// subcommand unless `propagate_version` is set, and that would bolt a
/// `--version` flag onto every subcommand — widening the surface that
/// `machine_help()` publishes and the MCP parity test pins, to fix a
/// help header.
fn help_template() -> String {
    format!(
        "termic {VERSION}\n\
         {{about-with-newline}}\n\
         {{usage-heading}} {{usage}}\n\
         \n\
         {{all-args}}{{after-help}}"
    )
}

/// The clap command with that header on the root AND every subcommand.
/// Every path that renders help goes through this one - argument
/// parsing, and `termic help [command]`'s own renderer - or `termic new
/// --help` quietly disagrees with `termic --help`.
pub fn cli_command() -> clap::Command {
    let t = help_template();
    Cli::command().help_template(t.clone()).mut_subcommands(|s| s.help_template(t.clone()))
}

pub fn run() -> i32 {
    // clap exits 2 on usage/parse errors itself; 2 stays reserved for it.
    // Not `Cli::parse()`: that would rebuild the command without the
    // version header, so `--help` would lose it.
    let cli = match Cli::from_arg_matches(&cli_command().get_matches()) {
        Ok(c) => c,
        Err(e) => e.exit(),
    };
    // Before any request is built: every Request carries it (GH #280).
    client::set_profile(cli.profile.clone());
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

/// Usage guards that must fail BEFORE the socket is touched, and
/// especially before auto-launch: a typo must never boot the app.
/// Pure so that no-boot property is testable without an environment.
fn pre_connect_guard(cmd: &Cmd) -> Result<(), CliError> {
    if let Cmd::New { model: Some(model), .. } = cmd {
        if model.trim().is_empty() {
            return Err(CliError::new(exit_code::ERROR, "the model is empty"));
        }
    }
    // `-P` is a selector, never stdin; an empty one fails here rather
    // than as a server lookup.
    if let Cmd::New { library: Some(l), .. }
    | Cmd::Send { library: Some(l), .. }
    | Cmd::Tab { library: Some(l), .. } = cmd
    {
        if l.trim().is_empty() {
            return Err(CliError::new(exit_code::ERROR, "the prompt selector is empty"));
        }
    }
    // `tab --wait` without -p/-P: clap cannot express the -p OR -P
    // requirement, so the guard is runtime (the server enforces it
    // too). Note this deliberately exits 1, not clap's 2: the contract
    // reserves 2 for clap itself, and this check runs after parsing.
    if let Cmd::Tab { wait: true, prompt: None, library: None, .. } = cmd {
        return Err(CliError::new(exit_code::ERROR, "--wait needs a prompt to wait on"));
    }
    // A title a selector could never reach fails here, before a usage
    // mistake can auto-launch the app. Uniqueness needs the live strip and
    // is the webview's call.
    if let Cmd::Tab { close: None, title: Some(t), .. } = cmd {
        if let Some(why) = proto::tab_title_problem(t) {
            return Err(CliError::new(exit_code::ERROR, why));
        }
    }
    Ok(())
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
            "this shell is inside a sandboxed termic task, the control plane is unavailable. \
This is by design and permanent, not a misconfiguration: a cage with a channel to an \
uncaged agent is not a cage. To report your work, write a file in your own task \
directory and say so in your final message; whoever is waiting on you reads it from \
outside.",
        ));
    }

    let format = effective_format(cli);

    // Help is fully local: no socket, no app.
    if let Cmd::Help { command } = &cli.cmd {
        return help_output(command.as_deref(), format);
    }

    pre_connect_guard(&cli.cmd)?;
    // Resolve `-p -` stdin BEFORE touching the socket: a generator
    // slower than the server's 30s idle timeout must not turn a
    // healthy pipe into "connection lost".
    let has_library = matches!(
        &cli.cmd,
        Cmd::New { library: Some(_), .. }
            | Cmd::Send { library: Some(_), .. }
            | Cmd::Tab { library: Some(_), .. }
    );
    let prompt = match &cli.cmd {
        Cmd::New { prompt: Some(p), .. }
        | Cmd::Send { prompt: Some(p), .. }
        | Cmd::Tab { prompt: Some(p), .. } => Some(resolve_prompt(p, has_library)?),
        _ => None,
    };
    // Pad text, from stdin before the socket for the same reason. `pad write`
    // with no -c reads stdin; an explicit literal is taken as given.
    let pad_content = match &cli.cmd {
        Cmd::Pad(PadCmd::New { content: Some(c), .. }) => Some(resolve_pad_content(c)?),
        Cmd::Pad(PadCmd::Write { content, .. }) => {
            Some(resolve_pad_content(content.as_deref().unwrap_or("-"))?)
        }
        _ => None,
    };

    let paths = client::socket_paths();
    // `quit` never launches: starting Termic in order to stop it is absurd,
    // and a teardown script wants "already gone" to be SUCCESS, not an error
    // it has to `|| true` away.
    let quitting = matches!(cli.cmd, Cmd::Quit { .. });
    // `tab close` never launches either, for the first of those reasons but
    // not the second: booting the app to close a tab is absurd (a fresh app
    // has no open tabs, so it could only ever answer "the task is not
    // open"), yet a missing tab is not the same success "nothing to quit"
    // is, so it stays exit 4 rather than inventing a second silent-success
    // verb. Every other verb keeps auto-launch.
    // Renaming a tab (`tab --tab X --title Y`) is the same case: a fresh app
    // has no open tab to rename.
    let closing_tab = matches!(
        cli.cmd,
        Cmd::Tab { close: Some(TabCmd::Close { .. }), .. } | Cmd::Tab { tab: Some(_), .. }
    );
    let mut conn = match client::connect_or_launch(&paths, cli.no_launch || quitting || closing_tab)
    {
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
        Cmd::Prompts { cmd } => {
            let selector =
                cmd.as_ref().map(|PromptsCmd::Show { selector }| selector.clone());
            let data = client::request(
                &mut conn,
                proto::Command::Prompts { selector: selector.clone() },
                &token,
            )?;
            let proto::ReplyData::Prompts(p) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to prompts"));
            };
            if selector.is_some() {
                // `show`: the body IS the stdout, so it pipes (`termic
                // prompts show review | pbcopy`); json emits the entry.
                let Some(one) = p.prompts.first() else {
                    return Err(CliError::new(exit_code::ERROR, "unexpected reply to prompts show"));
                };
                // Truncation is a FLAG plus a stderr warning, never
                // marker text inside the body: the body pipes into
                // agents, and a marker would arrive as instructions.
                if one.truncated && format == OutputFormat::Text {
                    eprintln!(
                        "termic: the body was truncated to fit the reply; edit the prompt in Termic for the rest"
                    );
                }
                let body = one.body.clone().unwrap_or_default();
                Ok(Output::ok(final_stdout(format, body.trim_end(), one)))
            } else {
                Ok(Output::ok(final_stdout(format, &output::prompts_text(&p.prompts), &p)))
            }
        }
        // `tab close` shares the verb but not the shape: it destroys a
        // tab rather than making one, so it takes the subcommand branch
        // before any of the open-a-tab argument handling below.
        Cmd::Tab { close: Some(TabCmd::Close { task, project, tab, yes }), .. } => {
            let data = client::request(
                &mut conn,
                proto::Command::TabClose {
                    task: task.clone(),
                    project: project.clone(),
                    tab: tab.clone(),
                    yes: *yes,
                    cwd: std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()),
                },
                &token,
            )?;
            let proto::ReplyData::TabClose(c) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to tab close"));
            };
            Ok(Output::ok(final_stdout(format, &output::tab_close_text(&c), &c)))
        }
        // `tab --tab X --title Y` renames an open tab; clap has already
        // refused every open-a-tab flag beside --tab.
        Cmd::Tab { close: None, tab: Some(tab), title, task, project, .. } => {
            let data = client::request(
                &mut conn,
                proto::Command::TabRename {
                    // Without <TASK>, the caller's own task, like `tab`.
                    task: task.clone().or_else(|| {
                        std::env::var("TERMIC_TASK_ID").ok().filter(|s| !s.is_empty())
                    }),
                    project: project.clone(),
                    tab: tab.clone(),
                    title: title.clone().unwrap_or_default(),
                    cwd: std::env::current_dir().ok().map(|p| p.display().to_string()),
                },
                &token,
            )?;
            let proto::ReplyData::Tab(t) = data else {
                return Err(CliError::new(exit_code::ERROR, "unexpected reply to tab rename"));
            };
            let reset = title.as_deref() == Some("");
            Ok(Output::ok(final_stdout(format, &output::tab_rename_text(&t, reset), &t)))
        }
        Cmd::Tab {
            close: None,
            task, project, agent, terminal, shell, prompt: _, library, resume, wait, timeout,
            title, tab: None,
        } => {
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
                if p.trim().is_empty() && library.is_none() {
                    return Err(CliError::new(exit_code::ERROR, "the prompt is empty"));
                }
            }
            // (--wait needs -p or -P; guarded pre-socket in execute so a
            // usage typo never auto-launches the app.)
            let timeout_ms = timeout.as_deref().map(parse_duration_ms).transpose()?;
            let wire = proto::Command::Tab {
                // Without <TASK>, the caller's own task, like `rename`: an
                // agent opening a helper beside itself should not have to
                // spell its own id, and cwd alone breaks after a `cd`.
                task: task.clone().or_else(|| {
                    std::env::var("TERMIC_TASK_ID").ok().filter(|s| !s.is_empty())
                }),
                project: project.clone(),
                kind,
                prompt: prompt.clone(),
                prompt_ref: library.clone(),
                wait: *wait,
                timeout_ms,
                resume: resume.clone(),
                // "" is "no title" on open; the wire carries only a real one.
                title: title.clone().filter(|t| !t.is_empty()),
                cwd: std::env::current_dir().ok().map(|p| p.display().to_string()),
            };
            // A prompt streams (queued/prompt_delivered/state events, the
            // send shape); a bare open stays one request/reply.
            let streamed = prompt.is_some() || library.is_some();
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
        Cmd::Group { task, name, color, project } => {
            // Same target rule as rename: explicit task, else the caller's
            // own ($TERMIC_TASK_ID), else the cwd the server resolves.
            let target = task.clone().or_else(|| {
                std::env::var("TERMIC_TASK_ID").ok().filter(|s| !s.is_empty())
            });
            let data = client::request(
                &mut conn,
                proto::Command::Group {
                    task: target,
                    project: project.clone(),
                    name: name.clone(),
                    color: color.clone(),
                    cwd: std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned()),
                },
                &token,
            )?;
            render(&cli.cmd, format, data).map(Output::ok)
        }
        Cmd::Project(p) => execute_project(&mut conn, &token, format, p, &paths),
        Cmd::Pad(p) => execute_pad(&mut conn, &token, format, p, pad_content),
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
        library,
        agent,
        model,
        agent_args,
        worktree,
        main,
        base,
        checkout,
        from,
        resume,
        sandbox,
        yolo,
        project,
        open,
        wait,
        timeout,
        no_group,
    } = &cli.cmd
    else {
        unreachable!()
    };
    if prompt.as_deref().is_some_and(|p| p.trim().is_empty()) && library.is_none() {
        return Err(CliError::new(exit_code::ERROR, "the prompt is empty"));
    }
    let timeout_ms = timeout.as_deref().map(parse_duration_ms).transpose()?;
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let mode = if *worktree || checkout.is_some() {
        Some("worktree".to_string())
    } else if *main {
        Some("main".to_string())
    } else {
        None
    };
    // --from canonicalizes CLI-side like `project add`, so the server
    // compares real paths; a vanished path fails here with a clear error.
    let from = from
        .as_ref()
        .map(|p| {
            std::fs::canonicalize(p)
                .map(|c| c.to_string_lossy().into_owned())
                .map_err(|_| CliError::new(exit_code::ERROR, format!("{p} does not exist")))
        })
        .transpose()?;
    let task_agent_args = compose_task_agent_args(agent_args, model.as_deref());
    let wire = proto::Command::New {
        name: name.clone().unwrap_or_default(),
        prompt,
        prompt_ref: library.clone(),
        agent: agent.clone(),
        agent_args: task_agent_args,
        mode,
        base: base.clone(),
        checkout: checkout.clone(),
        from,
        resume: resume.clone(),
        sandbox: sandbox.clone(),
        yolo: *yolo,
        project: project.clone(),
        open: *open,
        wait: *wait,
        timeout_ms,
        cwd,
        parent_task: if *no_group { None } else { parent_task_from_env() },
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

/// The task this CLI runs inside, if any: the orchestrator a `new` groups
/// under. Read from the env the app sets on every task PTY, so an agent gets
/// grouping without being told about it.
fn parent_task_from_env() -> Option<String> {
    std::env::var("TERMIC_TASK_ID").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Generic task args come first. The dedicated flag is deliberately last,
/// so `--model` is the unambiguous winner if the caller also supplied a
/// model flag through `--arg` and the agent uses last-value-wins parsing.
fn compose_task_agent_args(args: &[String], model: Option<&str>) -> Vec<String> {
    proto::compose_task_agent_args(args, model)
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
fn resolve_prompt(p: &str, library: bool) -> Result<String, CliError> {
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
    stdin_prompt(&buf, library)
}

/// The stdin half of `-p -`, split out so the empty-stdin rule is
/// unit-testable. With `-P` alongside, the library body is a complete
/// prompt on its own and empty stdin just means "no extra text": the
/// flagship handoff pipe (`termic result plan | termic new review
/// -P builtin:review -p -`) must not die when the upstream produced
/// nothing. Without it, empty stdin stays a hard error (there would be
/// nothing to send at all).
fn stdin_prompt(buf: &[u8], library: bool) -> Result<String, CliError> {
    if buf.len() > PROMPT_MAX_BYTES {
        return Err(CliError::new(
            exit_code::ERROR,
            format!("the prompt is too large (limit {} KB)", PROMPT_MAX_BYTES / 1024),
        ));
    }
    let trimmed = String::from_utf8_lossy(buf).trim_end().to_string();
    if trimmed.is_empty() {
        if library {
            return Ok(String::new());
        }
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
    let Cmd::Send { task, here, prompt: _, library, resume, fresh, wait, timeout, tab, project } =
        &cli.cmd
    else {
        unreachable!()
    };
    // clap guarantees -p or -P; an empty literal only passes with -P
    // (the composition ignores it).
    let prompt = prompt.unwrap_or_default();
    if prompt.trim().is_empty() && library.is_none() {
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
        prompt_ref: library.clone(),
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

/// Pad text from a literal or `-` (stdin), bounded like a prompt. Empty is
/// allowed: clearing a pad is a legitimate write.
fn resolve_pad_content(c: &str) -> Result<String, CliError> {
    if c != "-" {
        prompt_size_ok(c)?;
        return Ok(c.to_string());
    }
    let mut buf: Vec<u8> = Vec::new();
    std::io::stdin()
        .lock()
        .take(PROMPT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| CliError::new(exit_code::ERROR, format!("could not read the pad text from stdin ({e})")))?;
    if buf.len() > PROMPT_MAX_BYTES {
        return Err(CliError::new(
            exit_code::ERROR,
            format!("the pad text is too large (limit {} KB)", PROMPT_MAX_BYTES / 1024),
        ));
    }
    let text = String::from_utf8(buf)
        .map_err(|_| CliError::new(exit_code::ERROR, "the pad text on stdin is not UTF-8"))?;
    prompt_size_ok(&text)?;
    Ok(text)
}

/// The task a pad verb targets: explicit, else the caller's own task.
fn pad_task(t: &PadTarget) -> Option<String> {
    t.task.clone().or_else(|| std::env::var("TERMIC_TASK_ID").ok().filter(|s| !s.is_empty()))
}

fn execute_pad(
    conn: &mut client::Conn,
    token: &str,
    format: OutputFormat,
    cmd: &PadCmd,
    content: Option<String>,
) -> Result<Output, CliError> {
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned());
    let wire = match cmd {
        PadCmd::List { target } => proto::Command::PadList {
            task: pad_task(target),
            project: target.project.clone(),
            cwd,
        },
        PadCmd::New { target, title, .. } => proto::Command::PadNew {
            task: pad_task(target),
            project: target.project.clone(),
            title: title.clone(),
            content,
            cwd,
        },
        PadCmd::Write { pad, target, append, .. } => proto::Command::PadWrite {
            task: pad_task(target),
            project: target.project.clone(),
            pad: pad.clone(),
            content: content.unwrap_or_default(),
            append: *append,
            cwd,
        },
        PadCmd::Read { pad, target } => proto::Command::PadRead {
            task: pad_task(target),
            project: target.project.clone(),
            pad: pad.clone(),
            cwd,
        },
    };
    let data = client::request(conn, wire, token)?;
    let proto::ReplyData::Pad(d) = data else {
        return Err(CliError::new(exit_code::ERROR, "unexpected reply to pad"));
    };
    let text = match cmd {
        PadCmd::List { .. } => output::pad_list_text(&d.pads),
        PadCmd::New { .. } => d.pads.first().map(|p| p.id.clone()).unwrap_or_default(),
        PadCmd::Write { .. } => d
            .pads
            .first()
            .map(|p| format!("wrote pad {}", p.id))
            .unwrap_or_default(),
        PadCmd::Read { .. } => {
            if d.truncated && format == OutputFormat::Text {
                eprintln!("termic: the pad was truncated to fit the reply; read the rest in Termic");
            }
            d.content.clone().unwrap_or_default()
        }
    };
    Ok(Output::ok(final_stdout(format, &text, &d)))
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
        // tab included: -p/-P ride the send delivery + wait machinery,
        // so it produces 3/7/9 exactly as send does.
        "new" | "send" | "tab" => {
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
        let mut root = cli_command();
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
            // A parent whose subcommand is OPTIONAL is a verb in its own
            // right, beside the nested ones: `prompts` lists on its own,
            // `tab` opens a tab. Without this the surface would claim
            // they do not exist. `project` (subcommand required) stays
            // nested-only, since listing it would advertise a verb that
            // takes nothing and does nothing.
            if !sub.is_subcommand_required_set() {
                commands.push(command_entry(sub, sub.get_name()));
            }
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
        // Read first by an agent that asked for the surface: who it is
        // (maybe an agent INSIDE a task) and what it can do from there.
        "overview": agent_overview!(),
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
        (Cmd::Group { .. }, proto::ReplyData::Group(g)) => Ok(match format {
            OutputFormat::Json | OutputFormat::StreamJson => output::json(&g),
            OutputFormat::Text => output::group_text(&g),
        }),
        (Cmd::Group { .. }, _) => Err(unexpected("group")),
        _ => Err(unexpected("command")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clap_definition_is_coherent() {
        cli_command().debug_assert();
    }

    #[test]
    fn help_carries_the_version_everywhere_it_is_rendered() {
        // `termic` is one command for two release bundles, so the build
        // behind it is a real question. Every surface that renders help
        // must answer it, not just the root: a subcommand's --help and
        // the `termic help <cmd>` renderer go through separate clap
        // paths and it is easy to fix one and miss the others.
        let stamp = format!("termic {VERSION}");
        let mut root = cli_command();
        assert!(root.render_long_help().to_string().starts_with(&stamp));
        for name in ["new", "list", "wait"] {
            let sub = root.find_subcommand_mut(name).expect("subcommand exists");
            let text = sub.render_long_help().to_string();
            assert!(text.starts_with(&stamp), "{name} --help lost the version:\n{text}");
        }
        // The `help` subcommand renders through help_output, not clap's
        // own flag handling.
        let out = help_output(None, OutputFormat::Text).unwrap();
        assert!(out.stdout.starts_with(&stamp));
        let out = help_output(Some("new"), OutputFormat::Text).unwrap();
        assert!(out.stdout.starts_with(&stamp));
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
            "--arg=--effort", "--arg", "low", "--model", "worker",
            "--open", "--wait", "--timeout", "1h30m",
        ])
        .is_ok());
        // Sandbox values are validated at parse time.
        assert!(Cli::try_parse_from(["termic", "new", "x", "--sandbox", "jail"]).is_err());
    }

    #[test]
    fn new_checkout_flag_rules() {
        // An existing branch goes into a NEW worktree: not the main
        // checkout, and not an adopted worktree either.
        assert!(Cli::try_parse_from(["termic", "new", "x", "--checkout", "alice/fix", "--main"]).is_err());
        assert!(Cli::try_parse_from(["termic", "new", "--checkout", "alice/fix", "--from", "/wt"]).is_err());
        // The name is optional with it (the branch names the task), and
        // --base (the diff baseline) and --worktree still combine.
        let cli = Cli::try_parse_from([
            "termic", "new", "--checkout", "origin/alice/fix", "--base", "origin/dev", "--worktree",
        ])
        .unwrap();
        let Cmd::New { name, checkout, .. } = cli.cmd else { panic!() };
        assert_eq!(name, None);
        assert_eq!(checkout.as_deref(), Some("origin/alice/fix"));
        // Without --from or --checkout the name is still required.
        assert!(Cli::try_parse_from(["termic", "new", "--base", "dev"]).is_err());
    }

    #[test]
    fn new_task_args_preserve_argv_and_put_model_last() {
        let cli = Cli::try_parse_from([
            "termic", "new", "x", "--arg=--model", "--arg", "default",
            "--arg=--reasoning-effort", "--arg", "low", "--model", "worker",
        ])
        .unwrap();
        let Cmd::New { model, agent_args, .. } = cli.cmd else { panic!() };
        assert_eq!(model.as_deref(), Some("worker"));
        assert_eq!(agent_args, ["--model", "default", "--reasoning-effort", "low"]);
        assert_eq!(
            compose_task_agent_args(&agent_args, model.as_deref()),
            ["--model", "default", "--reasoning-effort", "low", "--model", "worker"],
        );
    }

    #[test]
    fn new_rejects_an_empty_model_before_connecting() {
        let cmd = Cli::try_parse_from(["termic", "new", "x", "--model", " "]).unwrap().cmd;
        assert_eq!(pre_connect_guard(&cmd).unwrap_err().message, "the model is empty");
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
    fn tab_title_opens_named_or_renames_an_open_tab() {
        // Open mode: --title rides every kind.
        for open in [
            vec!["termic", "tab", "fix-auth", "--title", "reviewer"],
            vec!["termic", "tab", "fix-auth", "--agent", "claude", "--title", "reviewer", "-p", "go"],
            vec!["termic", "tab", "fix-auth", "--shell", "--title", "logs"],
            vec!["termic", "tab", "fix-auth", "--terminal", "lazygit", "--title", "git"],
        ] {
            let cli = Cli::try_parse_from(open.clone())
                .unwrap_or_else(|e| panic!("{open:?} must parse: {e}"));
            let Cmd::Tab { close: None, tab: None, title: Some(_), .. } = &cli.cmd else {
                panic!("{open:?} is a titled open")
            };
        }

        // Rename mode: --tab + --title, and "" is a real value (the reset).
        let cli = Cli::try_parse_from(["termic", "tab", "fix-auth", "--tab", "2", "--title", "impl"])
            .expect("rename parses");
        let Cmd::Tab { close: None, tab: Some(tab), title: Some(title), .. } = &cli.cmd else {
            panic!("not a rename")
        };
        assert_eq!((tab.as_str(), title.as_str()), ("2", "impl"));
        let cli = Cli::try_parse_from(["termic", "tab", "--tab", "impl", "--title", ""])
            .expect("reset parses");
        let Cmd::Tab { title: Some(title), .. } = &cli.cmd else { panic!("not tab") };
        assert_eq!(title, "", "an empty title survives parsing as the reset");

        // --tab without --title would rename to nothing in particular.
        assert!(Cli::try_parse_from(["termic", "tab", "fix-auth", "--tab", "2"]).is_err());
        // Every open-a-tab flag is refused beside --tab: a rename opens nothing.
        for extra in [
            vec!["--agent", "claude"],
            vec!["--terminal", "lazygit"],
            vec!["--shell"],
            vec!["-p", "go"],
            vec!["-P", "builtin:review"],
            vec!["--resume", "abc"],
            vec!["--wait"],
        ] {
            let mut argv = vec!["termic", "tab", "fix-auth", "--tab", "2", "--title", "x"];
            argv.extend(extra.iter().copied());
            assert!(Cli::try_parse_from(argv.clone()).is_err(), "{argv:?} must be refused");
        }

        // `tab close --tab` still belongs to the subcommand.
        let cli = Cli::try_parse_from(["termic", "tab", "close", "fix-auth", "--tab", "2"])
            .expect("close parses");
        assert!(matches!(&cli.cmd, Cmd::Tab { close: Some(TabCmd::Close { .. }), tab: None, .. }));
    }

    #[test]
    fn tab_titles_a_selector_could_not_reach_fail_before_the_socket() {
        for (argv, why) in [
            (vec!["termic", "tab", "t", "--title", "   "], "blank"),
            (vec!["termic", "tab", "t", "--title", "2"], "number"),
            (vec!["termic", "tab", "t", "--tab", "1", "--title", " 3 "], "number"),
        ] {
            let cli = Cli::try_parse_from(argv.clone()).unwrap();
            let err = pre_connect_guard(&cli.cmd).unwrap_err();
            assert!(err.message.contains(why), "{argv:?}: {}", err.message);
        }
        for ok in [
            vec!["termic", "tab", "t", "--title", "reviewer"],
            vec!["termic", "tab", "t", "--tab", "1", "--title", ""],
        ] {
            let cli = Cli::try_parse_from(ok.clone()).unwrap();
            assert!(pre_connect_guard(&cli.cmd).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn tab_close_parses_without_shadowing_the_tab_verb() {
        // `tab` gained a subcommand (GH #185) but is still a verb in its
        // own right. Every open-a-tab form has to keep parsing, or the
        // subcommand quietly broke the surface it was bolted onto.
        for open in [
            vec!["termic", "tab"],
            vec!["termic", "tab", "fix-auth"],
            vec!["termic", "tab", "fix-auth", "--agent", "claude"],
            vec!["termic", "tab", "fix-auth", "--shell"],
            vec!["termic", "tab", "fix-auth", "-p", "run the tests", "--wait"],
            vec!["termic", "tab", "fix-auth", "--project", "web"],
        ] {
            let cli = Cli::try_parse_from(open.clone())
                .unwrap_or_else(|e| panic!("{open:?} must parse: {e}"));
            let Cmd::Tab { close, .. } = &cli.cmd else { panic!("not tab: {open:?}") };
            assert!(close.is_none(), "{open:?} is an open, not a close");
        }

        let cli = Cli::try_parse_from(["termic", "tab", "close", "fix-auth", "--tab", "2"])
            .expect("parses");
        let Cmd::Tab { close: Some(TabCmd::Close { task, tab, yes, project }), .. } = &cli.cmd
        else {
            panic!("not tab close")
        };
        assert_eq!(task.as_deref(), Some("fix-auth"));
        assert_eq!(tab, "2");
        assert!(!yes);
        assert_eq!(project.as_deref(), None);

        // --tab IS the target; there is no "obvious tab" to close.
        assert!(Cli::try_parse_from(["termic", "tab", "close", "fix-auth"]).is_err());
        // The task falls back to the cwd, like the other tab-aware verbs.
        assert!(Cli::try_parse_from(["termic", "tab", "close", "--tab", "claude"]).is_ok());
        // ...but --project still needs a task to disambiguate.
        assert!(
            Cli::try_parse_from(["termic", "tab", "close", "--tab", "1", "--project", "web"])
                .is_err()
        );
        // Both spellings of the default-tab override.
        for flag in ["--yes", "-y"] {
            let cli = Cli::try_parse_from(["termic", "tab", "close", "x", "--tab", "1", flag])
                .expect("parses");
            let Cmd::Tab { close: Some(TabCmd::Close { yes, .. }), .. } = &cli.cmd else {
                panic!("not tab close")
            };
            assert!(yes, "{flag} must set yes");
        }
        // The open-a-tab flags are NOT close's; a caller reaching for
        // them has misunderstood the verb and should hear so. -P/--library
        // included: a prompt has nothing to say to a tab being destroyed.
        for flag in [
            vec!["--agent", "claude"],
            vec!["-p", "hello"],
            vec!["-P", "builtin:review"],
            vec!["--shell"],
        ] {
            let mut argv = vec!["termic", "tab", "close", "x", "--tab", "1"];
            argv.extend(flag.iter());
            assert!(Cli::try_parse_from(&argv).is_err(), "{argv:?} must not parse");
        }

        // The one cost of hanging a subcommand off `tab`: a task LITERALLY
        // named "close" cannot be the bare first positional, because clap
        // matches the subcommand first. Leading with a flag still reaches
        // it, which is the documented escape hatch, so pin both halves.
        let shadowed = Cli::try_parse_from(["termic", "tab", "--agent", "claude", "close"])
            .expect("a flag first reaches a task named close");
        let Cmd::Tab { close, task, .. } = &shadowed.cmd else { panic!("not tab") };
        assert!(close.is_none());
        assert_eq!(task.as_deref(), Some("close"));
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
    fn prompts_and_library_flag_rules() {
        // The list form and the show form both parse; show needs a selector.
        assert!(Cli::try_parse_from(["termic", "prompts"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "prompts", "show", "builtin:review"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "prompts", "show"]).is_err());

        // -P rides new/send/tab, alone or beside -p.
        assert!(Cli::try_parse_from(["termic", "new", "x", "-P", "builtin:review"]).is_ok());
        assert!(
            Cli::try_parse_from(["termic", "new", "x", "-P", "builtin:review", "-p", "extra"])
                .is_ok()
        );
        // send: -P satisfies the prompt requirement on its own.
        assert!(Cli::try_parse_from(["termic", "send", "foo", "-P", "Review"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "send", "foo", "-P", "Review", "-p", "-"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "send", "foo"]).is_err(), "-p or -P is required");
        // tab: -P conflicts with the promptless kinds, exactly like -p.
        assert!(Cli::try_parse_from(["termic", "tab", "foo", "-P", "Review"]).is_ok());
        assert!(Cli::try_parse_from(["termic", "tab", "foo", "--shell", "-P", "Review"]).is_err());
        assert!(
            Cli::try_parse_from(["termic", "tab", "foo", "--terminal", "lazygit", "-P", "x"])
                .is_err()
        );
        // tab --wait needs -p or -P; the guard is runtime (clap cannot
        // express the OR), so the flag itself still parses bare.
        assert!(Cli::try_parse_from(["termic", "tab", "foo", "--wait", "-P", "Review"]).is_ok());
    }

    #[test]
    fn empty_stdin_is_fine_with_a_library_prompt() {
        // The flagship handoff (`termic result plan | termic new review
        // -P builtin:review -p -`) must not die when the upstream
        // produced nothing: with -P the body is the whole prompt.
        assert_eq!(stdin_prompt(b"", true).unwrap(), "");
        assert_eq!(stdin_prompt(b"  \n", true).unwrap(), "");
        // Without -P, empty stdin stays a hard error.
        assert!(stdin_prompt(b"", false).is_err());
        assert!(stdin_prompt(b"  \n", false).is_err());
        // Real text is unaffected either way.
        assert_eq!(stdin_prompt(b"do it\n", true).unwrap(), "do it");
        assert_eq!(stdin_prompt(b"do it\n", false).unwrap(), "do it");
    }

    #[test]
    fn pre_connect_guards_fire_without_touching_anything() {
        // These guards exist so a usage typo never auto-launches the
        // app; testing the pure helper (not execute) means a regression
        // fails the test instead of booting a real Termic on the dev
        // machine.
        let parse = |args: &[&str]| Cli::try_parse_from(args).expect("parses").cmd;
        let err = pre_connect_guard(&parse(&["termic", "tab", "foo", "--wait"])).unwrap_err();
        assert_eq!(err.code, exit_code::ERROR);
        assert_eq!(err.message, "--wait needs a prompt to wait on");
        let err =
            pre_connect_guard(&parse(&["termic", "send", "foo", "-P", "  "])).unwrap_err();
        assert_eq!(err.message, "the prompt selector is empty");
        // The valid shapes pass through untouched.
        for ok in [
            &["termic", "tab", "foo", "--wait", "-P", "Review"][..],
            &["termic", "tab", "foo", "--wait", "-p", "x"][..],
            &["termic", "new", "x", "-P", "builtin:review"][..],
        ] {
            assert!(pre_connect_guard(&parse(ok)).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn prompts_render_contract() {
        let entries = vec![
            proto::PromptEntry {
                id: "builtin:review".into(),
                title: "Review".into(),
                builtin: true,
                enabled: true,
                modified: true,
                body: None,
                truncated: false,
            },
            proto::PromptEntry {
                id: "3f1c0d6e-aaaa-bbbb-cccc-1234567890ab".into(),
                title: "Ship it".into(),
                builtin: false,
                enabled: false,
                modified: false,
                body: None,
                truncated: false,
            },
        ];
        let text = output::prompts_text(&entries);
        // Ids lead (the stable selector a script pins); flags render as
        // words, and a custom prompt's MODIFIED cell is a dash, not "no".
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("ID"), "{text}");
        assert!(lines[1].starts_with("builtin:review"), "{text}");
        assert!(lines[1].contains("builtin") && lines[1].contains("yes"), "{text}");
        assert!(lines[2].contains("custom") && lines[2].ends_with("-"), "{text}");
        assert_eq!(output::prompts_text(&[]), "The prompt library is empty.");
        // The wire's internal "kind" tag must not leak into --json output.
        let v: serde_json::Value = serde_json::from_str(&output::json(
            &proto::PromptsData { prompts: entries },
        ))
        .unwrap();
        assert_eq!(v["prompts"][0]["id"], "builtin:review");
        assert!(v.get("kind").is_none());
        // The list omits bodies (additive contract: absent, not null).
        assert!(v["prompts"][0].get("body").is_none());
    }

    #[test]
    fn pad_parse_rules() {
        let new = Cli::try_parse_from(["termic", "pad", "new", "--title", "findings", "-c", "# notes"]).unwrap();
        let Cmd::Pad(PadCmd::New { target, title, content }) = &new.cmd else { panic!("not pad new") };
        assert_eq!(target.task, None);
        assert_eq!(title.as_deref(), Some("findings"));
        assert_eq!(content.as_deref(), Some("# notes"));

        // No -c on write means stdin, resolved before the socket.
        let w = Cli::try_parse_from(["termic", "pad", "write", "findings", "--append", "--task", "t1"]).unwrap();
        let Cmd::Pad(PadCmd::Write { pad, target, content, append }) = &w.cmd else { panic!("not pad write") };
        assert_eq!(pad, "findings");
        assert_eq!(target.task.as_deref(), Some("t1"));
        assert_eq!(content, &None);
        assert!(*append);

        let r = Cli::try_parse_from(["termic", "pad", "read", "p1"]).unwrap();
        assert!(matches!(&r.cmd, Cmd::Pad(PadCmd::Read { pad, .. }) if pad == "p1"));
        assert!(Cli::try_parse_from(["termic", "pad", "list"]).is_ok());

        // A pad selector is required for write/read; --project needs --task.
        assert!(Cli::try_parse_from(["termic", "pad", "read"]).is_err());
        assert!(Cli::try_parse_from(["termic", "pad", "list", "--project", "web"]).is_err());
        // `pad` alone is not a verb.
        assert!(Cli::try_parse_from(["termic", "pad"]).is_err());
        // The canonical name parses to the same command as the alias.
        let full = Cli::try_parse_from(["termic", "scratchpad", "write", "findings", "-c", "x"]).unwrap();
        assert!(matches!(full.cmd, Cmd::Pad(PadCmd::Write { .. })));
    }

    #[test]
    fn pad_list_text_marks_closed_pads() {
        let pads = vec![
            proto::PadInfo { id: "a".into(), title: "findings".into(), syntax: None, open: true },
            proto::PadInfo { id: "b".into(), title: String::new(), syntax: None, open: false },
        ];
        assert_eq!(output::pad_list_text(&pads), "a  findings\nb  Untitled  (not open)");
        assert_eq!(output::pad_list_text(&[]), "no scratchpads");
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
            "project remove", "help", "prompts", "prompts show",
            "scratchpad list", "scratchpad new", "scratchpad write", "scratchpad read",
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
        assert_eq!(by_name("tab")["exit_codes"]["9"], "prompt never delivered");
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
        for f in [
            "--prompt", "--library", "--agent", "--model", "--arg", "--wait", "--sandbox",
            "--timeout",
        ] {
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
