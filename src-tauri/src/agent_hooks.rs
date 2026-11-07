//! Agent lifecycle hooks: one hook, installed into Claude's own config, that
//! tells termic the moment the agent is blocked on the user.
//!
//! Why this exists: Claude paints its IDLE glyph while it is waiting on a
//! permission prompt, a question, or plan approval. termic reads that title,
//! arms its 5s settle, and fires a "done" badge about a second before the
//! native OSC 9 notify (6.0s late) corrects it to "needs you". Measured; see
//! `docs/agent-hooks.md`.
//!
//! The transport is deliberately not IPC. A Claude hook's stdout JSON may carry
//! a `terminalSequence`, which Claude writes to its own PTY, and `TerminalPane`
//! already parses OSC 777 into `goAttention` (which calls `cancelSettle`, and
//! that is what kills the false done). So there is no socket, no callback
//! binary, no Seatbelt grant and no Docker plumbing: the channel is the terminal
//! the agent already owns, and it behaves identically caged and uncaged.
//!
//! Two things here are load-bearing and easy to undo by accident:
//!
//! 1. The script lives in the agent's OWN config dir, never the termic data
//!    dir. Seatbelt denies the data dir read AND write, and `$HOME/.config` is
//!    not in `sandbox::system_read_roots()`, so a caged agent could exec a
//!    script in neither. `~/.claude` is already readable in the cage.
//! 2. The script bails unless `TERMIC_TASK_ID` is set and `GROK_HOOK_EVENT` is
//!    not. The install is GLOBAL, so without the first gate we would write OSC
//!    into every terminal the user runs claude in; and Grok reads
//!    `~/.claude/settings.json` too (measured), so without the second we would
//!    silently change an agent the user never opted in for.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bump when the script body or the settings entry shape changes. Recorded in
/// the manifest so a later version knows an older install is stale and replaces
/// it rather than appending a second entry.
// v2 registered a Working HEARTBEAT (claude/grok PreToolUse, an opencode
// throttle). An install from v1 still works and reports less, so it is stale
// rather than broken.
// v3 writes to the first of three targets that accepts it, so a Docker
// sandboxed agent can reach the terminal at all: $TERMIC_PTY is a HOST path and
// does not exist in the container, which made every hook in a sandboxed tab a
// silent no-op. A v2 install is not stale-but-working there, it is dead, which
// is the strongest reason yet for sync to update installs on its own.
// v4 registers claude's `SessionStart` as `Signal::Ready`. Without it the only
// evidence that an agent can accept typed input is that its terminal painted
// and went quiet, and a blocking startup dialog does exactly that: termic typed
// its first message into claude's "do you trust this folder?" picker and the
// submit landed on the highlighted default, `No, exit`. A v3 install types into
// the dialog exactly as before, so this is stale-and-harmful, not stale-and-
// quieter. See `Signal::Ready`.
// v5 turns claude's Done guard from "is anything in flight" into a whitelist of
// task types. v4 asked the wrong question: an artifact watch is an ambient
// websocket monitor that stays `running` for the whole session, so one publish
// made every later `Stop` look like outstanding work and the tab span forever
// with no demoter left to correct it. A v4 install is not stale-and-quieter, it
// is a tab that never stops loading, which is the same severity as v3 in Docker.
// v6 changes two script BODIES, which an upgrade alone would not pick up: an
// install writes the scripts once and nothing rewrites them afterwards, so a v5
// install keeps reporting exactly what v5 reported. Both changes matter enough
// to be worth a reinstall. claude's and codex's ATTENTION scripts now read
// `tool_name` out of the payload, so the banner names the tool it is blocked on
// rather than saying "agent needs your input"; and codex's READY script now also
// reports the session id, which is the only way a repo-root codex task can
// resume its OWN conversation instead of whichever one ran last in that
// directory.
// v7 adds claude's usage STATUS LINE (GH #277), which is not a hook and is not
// in `hooks_for`: it is a second file in the same script dir plus a `statusLine`
// entry in the same config. A v6 install has neither, and nothing but a
// reinstall would write them, so the bump is the only thing that gets the
// footer its numbers on an existing setup. Unlike every bump above this one is
// stale-and-quieter rather than stale-and-harmful: a v6 install keeps reporting
// state correctly and shows no usage.
//
// v10 has claude's READY script report the session id after `/clear`,
// `/resume` and `/compact` (GH #306). Each of those is a `SessionStart` in the
// same process, and `/clear` and `/resume` move the conversation to another
// session id that termic never heard about, so a relaunch resumed the session
// from before the `/clear`. Stale-and-harmful: a v9 install keeps resuming the
// wrong conversation.
//
// Safe to bump for an existing codex install: the trust entries in config.toml
// hash the hooks.json ENTRY (command path, timeout, status message), none of
// which this changes, so a reinstall re-asks codex and writes back the same
// hashes rather than orphaning them.
//
// v11 has claude's status line also report the CONTEXT WINDOW, on its own
// `ctx` body. Stale-and-quieter: a v10 install reports usage exactly as before
// and simply shows no context.
//
// v12 filters grok's `Notification` to `permission_prompt` (its idle nag rang
// the bell after every turn) and has agy report its conversation id.
// Stale-and-harmful for grok: a v11 install keeps ringing.
//
// v13 moves working/done off raw OSC 133 onto termic's own trusted bodies
// (`WORKING_BODY` / `DONE_BODY`), so an agent's own 133 marks can be ignored,
// and ends an opencode turn on its final message rather than `session.idle`.
// Stale-and-harmful: a v12 install's 133 is now ignored for hooked agents.
//
// v14 bounds every terminal write (`bound_emits`): a hook blocked writing to a
// dead tab's pty held the tty lock and hung every new claude. Stale-and-
// harmful: a v13 install can still wedge.
// v15 makes a HELD done speak. Every done guard that withholds (claude's
// `background_tasks`, grok's `backgroundTasks`, agy's `fullyIdle`) used to
// `exit 0` writing nothing, which is byte-for-byte what a model mid-token
// writes; it now reports `agent delegated: <count> <label> <ids>`. Stale-and-
// harmful: a v14 install keeps the silent script, so a tab whose agent left a
// shell running spins until the 20-minute ceiling and every later turn in
// that session is swallowed too. That is the whole bug, so an install that
// does not re-sync does not get the fix.
// v16 drops codex's `PermissionRequest`, which also fires for requests
// `auto_review` approves on its own, and has install strip our entries from
// any event the current set no longer registers (an upgrade only ever merged,
// so a dropped event kept firing). Stale-and-harmful: a v15 codex install
// rings needs-you for every auto-reviewed command.
// v17 makes opencode's plugin load under opencode 2, which refuses a module
// without `default.{id, setup}` and runs server plugins in a shared background
// service whose env is not this task's; the reporting moves to a TUI plugin in
// `plugins/termic/tui.js`. Stale-and-harmful for opencode: a v16 install is
// rejected outright by opencode 2 and reports nothing at all. The TUI plugin
// also reports the session id of the root a turn starts in, because
// `opencode session list` only knows the newest session in the folder.
pub const SCHEMA_VERSION: u32 = 17;

/// Directory we create inside the agent's config dir. Also the prefix that
/// identifies our entries for removal, which is why it must never be renamed
/// without a `SCHEMA_VERSION` bump and a migration.
const SCRIPT_DIR: &str = "termic-hooks";
const MANIFEST_NAME: &str = "manifest.json";
const BACKUP_NAME: &str = "config.termic-backup";

/// Where a given install writes. Host is the user's own config dir; Docker is
/// the termic-owned dir that gets bind-mounted into the container, which is why
/// a Docker install mutates nothing of the user's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Carries the agent id, so one call site can serve every agent.
    Host(String),
    /// Carries the agent's OWN id (a clone keeps its own folder), not the base
    /// id. `docker.rs` documents why conflating the two makes clones unusable.
    Docker(String),
}

impl Target {
    /// The agent id this target is for. Docker keys on the agent's OWN id while
    /// the config SHAPE comes from the base id, which is why `command_path`
    /// resolves the base separately.
    pub fn agent(&self) -> &str {
        match self {
            Target::Host(a) | Target::Docker(a) => a,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub schema_version: u32,
    /// Absolute path we wrote into the config. Host or container form.
    pub command: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HookStatus {
    pub installed: bool,
    /// The config file we would write, so the UI can name it BEFORE writing.
    pub settings_path: String,
    pub script_dir: String,
    /// True when the user has set `disableAllHooks`. An install is then a no-op
    /// and the UI must say so rather than report success.
    pub disabled_all: bool,
    /// Set when the config could not be read or parsed. Install is refused.
    pub error: Option<String>,
    pub schema_version: Option<u32>,
    /// Installed, but generated by an older termic whose hook SET differs from
    /// this build's. Surfaced because it is otherwise invisible: the config
    /// looks installed and quietly keeps reporting less than it could. The
    /// heartbeat that stops a cleared spinner staying gone arrived this way,
    /// and without this every existing install would have silently missed it.
    pub stale: bool,
    /// At least one entry of OURS is in the config, i.e. the user opted in at
    /// some point and has not removed it. NOT the same as `installed`, which
    /// demands every event in TODAY's set.
    ///
    /// The distinction is what makes the hook set extensible. `installed` is
    /// an ALL, so the moment a new event joins an agent's set every existing
    /// install fails it - and `agent_hooks_sync` skipping anything not
    /// installed meant adding an event orphaned exactly the installs the sync
    /// exists to upgrade. Caught the first time it mattered: `SessionStart`
    /// was added, agy and grok (whose sets were unchanged) upgraded, and
    /// claude, the agent the event was FOR, silently did not.
    ///
    /// Consent is what this tracks, so it is the right gate for an unattended
    /// upgrade: `remove` deletes every entry of ours, so a user who opted out
    /// reads false here and is never re-installed behind their back.
    pub ours_present: bool,
}

/// What a hook tells termic. Each maps onto an OSC the terminal already
/// understands, so nothing new has to be parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// Blocked on the user. OSC 777 `notify`, whose TITLE field marks it as
    /// termic's own (see `lib/agentHooks.ts`: a user's `attention` list is an
    /// ALLOW-LIST and would otherwise filter ours out).
    Attention,
    /// Turn started. OSC 133;C, which `TerminalPane` maps to `goWorking`.
    Working,
    /// Turn genuinely over. OSC 133;D, which `TerminalPane` maps to
    /// `goIdle(reason, 0)`: a hard done with no settle wait. It only fires
    /// when we were working, which is why an agent using it needs `Working`
    /// registered too.
    Done,
    /// The session exists and the agent is past its own startup, so a typed
    /// message will reach its input box. OSC 777 `notify` like `Attention`,
    /// distinguished by its BODY (`lib/agentHooks.ts` owns both strings): same
    /// trusted-sender check, no new OSC id to parse, and it survives the Docker
    /// three-target write that `Attention` already relies on.
    ///
    /// This is the one signal termic cannot approximate from the terminal.
    /// Everything else here corrects a state the terminal gets WRONG; this one
    /// reports a state the terminal cannot express at all. A blocking startup
    /// dialog paints and then goes quiet, which is byte-for-byte what a ready
    /// agent looks like, so the quiet heuristic says "ready" and the first
    /// message is typed into a picker whose default answer is destructive.
    Ready,
}

/// OSC 777 `notify` up to and including the sender field. `termic` in the title
/// position is what marks a signal as OURS rather than something the agent chose
/// to say, which is what lets it skip `notificationWantsAttention`'s allow-list
/// (see `lib/agentHooks.ts`).
const NOTIFY_PREFIX: &str = "777;notify;termic;";

/// The generic attention body. Split out from the payload because claude's
/// script composes its body at RUN time and needs this exact string as its
/// fallback: two copies of it would be two things to keep in step.
/// KEEP IN SYNC with `HOOK_OSC_BODY` in `lib/agentHooks.ts`.
const ATTENTION_BODY: &str = "agent needs your input";

/// Prefix of the body that reports the agent's own session id: sent by an agent
/// that can resume a session by id but cannot be handed one at launch (codex,
/// devin, omp, opencode 2), or whose session moves inside a running process
/// (claude). KEEP IN SYNC with `HOOK_OSC_SESSION_PREFIX` in
/// `lib/agentHooks.ts`.
const SESSION_BODY_PREFIX: &str = "session ";

/// KEEP IN SYNC with `HOOK_OSC_READY_BODY` in `lib/agentHooks.ts`. Must never be
/// a prefix of `ATTENTION_BODY` or vice versa: the TS handler routes the two
/// apart on an exact match and would badge a ready session as needing you.
const READY_BODY: &str = "agent ready for input";

/// A turn started / a turn is over. termic's OWN bodies, on the trusted
/// channel, where they used to be raw OSC `133;C` / `133;D`: agents emit 133
/// themselves (pi marks every message block on each repaint, claude's shell
/// integration marks its prompts), and a hook speaking the same marks could not
/// be told apart from them. A pi tab went to "working" on every repaint and a
/// relaunch rang "finished" for agents nobody had spoken to. With their own
/// bodies, a tab whose agent has termic hooks ignores raw 133 altogether.
/// KEEP IN SYNC with `HOOK_OSC_WORKING_BODY` / `HOOK_OSC_DONE_BODY` in
/// `lib/agentHooks.ts`.
const WORKING_BODY: &str = "agent working";
const DONE_BODY: &str = "agent done";

/// Prefix of the body reporting work the agent DELEGATED and has not finished,
/// `agent delegated: <count> <label> <ids>`. It replaces the `exit 0` the done
/// guard used to take, which wrote nothing at all and was therefore
/// indistinguishable from a model mid-token. KEEP IN SYNC with
/// `HOOK_OSC_DELEGATED_PREFIX` in `lib/agentHooks.ts`.
const DELEGATED_BODY_PREFIX: &str = "agent delegated: ";

/// claude's task types, in the order the label is chosen, mapped to the wire
/// labels `lib/delegatedWork.ts` accepts. AGENT-OWNED types come first, and
/// that ordering is the policy: a payload holding both a subagent and a shell
/// is an agent waiting on its subagent, not one that has handed back. `shell`
/// is last for the same reason.
///
/// Absent, and deliberately: `monitor` / `monitor_ws` (an artifact watch that
/// never ends), `dream`, `auto-mode scan`, and any type a future release adds.
/// An unrecognised type reports nothing outstanding and the turn is done, which
/// is the direction to fail in once hooks own a tab.
/// Appended to every done guard that can report a hold, claude's and grok's
/// alike: both payloads spell an entry's id `"id":"..."`, and the ids are what
/// termic compares one turn's outstanding set against the last one's.
///
/// Shared rather than copied because the two guards differ only in the KEY
/// they slice (`background_tasks` vs grok's camelCase `backgroundTasks`) and
/// the type spellings they know. Everything after `$tasks` is set is identical,
/// and two copies of a shell loop is two things to fix.
const DELEGATED_IDS: &str = concat!(
    "# The ids of everything outstanding. termic compares one turn's set\n",
    "# against the last one's: work that was already outstanding cannot be\n",
    "# what THIS turn is waiting on, which is how a shell left running stops\n",
    "# holding every later turn open. Ids only, never displayed, and anything\n",
    "# that is not plainly an id is dropped.\n",
    "if [ -n \"$dlg\" ]; then\n",
    "  ids=''\n",
    "  rest=$tasks\n",
    "  i=0\n",
    "  while [ \"$i\" -lt 20 ]; do\n",
    "    case \"$rest\" in\n",
    "      *'\"id\":\"'*) rest=${rest#*'\"id\":\"'}; id=${rest%%'\"'*} ;;\n",
    "      *) break ;;\n",
    "    esac\n",
    "    i=$((i+1))\n",
    "    case \"$id\" in ''|*[!0-9A-Za-z_-]*) continue ;; esac\n",
    "    ids=\"$ids,$id\"\n",
    "  done\n",
    "  ids=${ids#,}\n",
    "  [ -n \"$ids\" ] || ids='-'\n",
    "  dlg=\"$dlg $ids\"\n",
    "fi\n",
);

#[cfg(test)]
const DELEGATED_LABELS: [(&str, &str); 6] = [
    ("subagent", "subagent"),
    ("workflow", "workflow"),
    ("teammate", "teammate"),
    ("cloudsession", "cloud_session"),
    ("MCPtask", "mcp_task"),
    ("shell", "shell"),
];

/// Prefix of the body that reports subscription usage (GH #277). Written by the
/// STATUS LINE, not by a hook, but it rides the same OSC 777 channel and the
/// same trusted `termic` title. Must never be a prefix of `ATTENTION_BODY` or
/// `READY_BODY`, or vice versa: the TS handler tells the three apart on the
/// body alone. KEEP IN SYNC with `USAGE_BODY_PREFIX` in `lib/agentUsage.ts`.
const USAGE_BODY_PREFIX: &str = "usage ";

/// Prefix of the body that reports the CONTEXT WINDOW: `ctx <used tokens>
/// <window tokens> [<used percent>]`. Written by every agent that has a
/// source (claude's and grok's status line, codex's Stop hook, the opencode
/// and pi plugins), one format so the terminal has one parser. Same rule as
/// the usage prefix: never a prefix of another body, or prefixed by one.
/// KEEP IN SYNC with `CONTEXT_BODY_PREFIX` in `lib/agentContext.ts`.
pub(crate) const CONTEXT_BODY_PREFIX: &str = "ctx ";

/// Filename stem of the status line script. Not a `Signal::stem()`, because a
/// status line is not a signal: it is not registered against an event, it is
/// not part of `hooks_for`, and `installed` must not depend on it.
const USAGE_STEM: &str = "usage";

/// The claude status line, which is how termic learns subscription usage
/// without asking Anthropic for it (GH #277).
///
/// Claude Code pipes `rate_limits` into the statusLine command's stdin on every
/// turn, piggybacked on the Messages API response, so reading it costs no
/// request and no rate-limit budget of its own. The alternative was the OAuth
/// usage endpoint, which on a Mac host needs a keychain item whose ACL names
/// only `/usr/bin/security`; see docs/ideas/usage-footer.md for that whole
/// comparison.
///
/// **This script must print NOTHING.** Whatever a status line writes to stdout
/// is rendered by claude under the user's input box on every turn. Measured
/// both ways on 2.1.260: a probe printing a marker put the marker on screen, a
/// probe printing an empty string left no text at all. So the numbers go out
/// the side channel the hooks already use, and the slot stays visually empty.
///
/// Deliberately no `jq`, like every other script here: it keeps the "no
/// dependencies" property, and a status line that fails to run is one claude
/// reports on every single turn.
pub fn statusline_body() -> String {
    statusline_body_for("claude")
}

/// The status line script as written for one agent. ONE script for every agent
/// with a status line slot (claude, agy, copilot, grok), because they all pipe
/// a JSON payload with a `context_window` object on stdin and differ only in
/// which fields it holds; the agent is baked in so the parts that are one
/// agent's alone (claude's `rate_limits` and cost, agy's `quota`) cannot be
/// misread from another's payload.
pub fn statusline_body_for(agent: &str) -> String {
    bound_emits(&STATUSLINE_TEMPLATE
        .replace("@AGENT@", agent)
        .replace("@NOTIFY@", NOTIFY_PREFIX)
        .replace("@USAGE@", USAGE_BODY_PREFIX)
        .replace("@CTX@", CONTEXT_BODY_PREFIX)
        .replace("@SCHEMA@", &SCHEMA_VERSION.to_string()))
}

/// Make every terminal write in a generated script unable to block for long.
///
/// A hook writes its OSC to the agent's pty, and a write to a tty BLOCKS once
/// its buffer is full, which is exactly the state of a pty whose reader has
/// gone (a closed tab, a quit app). Measured, and costly: three grok `done.sh`
/// hooks sat for 22 minutes blocked in that write, and a blocked tty write
/// holds the device's lock, so every `lstat` of that /dev node hung with it.
/// claude resolves its own tty name at startup by walking /dev
/// (`ttyname_r` -> `devname_r` -> `lstat`), so NEW claude sessions in every
/// termic window stopped drawing, whichever account, until the stuck hooks
/// were killed. `ps` hung the same way.
///
/// So each `X "$TERMIC_PTY" || X /proc/1/fd/1 || X /dev/tty || true` chain
/// runs in the background with a 2s budget, then the script exits whatever
/// happened. A tty write blocked on a full buffer is interruptible, so the
/// TERM lands. The watchdog is killed as soon as the write returns, so it
/// never outlives a normal hook (and never signals a recycled pid).
fn bound_emits(script: &str) -> String {
    let mut out = String::with_capacity(script.len() + 512);
    for line in script.split_inclusive('\n') {
        let body = line.trim_end_matches('\n');
        let indent_len = body.len() - body.trim_start().len();
        let (indent, rest) = body.split_at(indent_len);
        let func = rest.split_whitespace().next().unwrap_or("");
        let chain = format!(
            "{func} \"$TERMIC_PTY\" || {func} /proc/1/fd/1 || {func} /dev/tty || true"
        );
        if !func.is_empty() && rest == chain {
            let unix_call = chain.trim_end_matches(" || true");
            // Windows host: `$TERMIC_PTY` is a named pipe (hook_pipe.rs),
            // which Git Bash cannot open with `>`. The bundled CLI opens it
            // properly, so the report goes through it. TERMIC_PTY_PIPE is set
            // only on Windows host PTYs, so the same script inside a Docker
            // container (Linux) takes the ordinary chain.
            let windows_call;
            let call = if cfg!(windows) {
                windows_call = format!(
                    "if [ -n \"$TERMIC_PTY_PIPE\" ]; then {func} /dev/stdout | \"$TERMIC_CLI\" hook-emit \"$TERMIC_PTY\"; else {unix_call}; fi"
                );
                windows_call.as_str()
            } else {
                unix_call
            };
            out.push_str(&format!(
                "{indent}( {call} ) </dev/null >/dev/null 2>&1 &\n\
                 {indent}termic_w=$!\n\
                 {indent}( sleep 2; kill \"$termic_w\" ) </dev/null >/dev/null 2>&1 &\n\
                 {indent}termic_k=$!\n\
                 {indent}wait \"$termic_w\" 2>/dev/null\n\
                 {indent}kill \"$termic_k\" 2>/dev/null\n"
            ));
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Written as a template with `@TOKEN@` holes rather than a `format!`, because
/// the body is mostly `${...}` parameter expansion and every brace in it would
/// otherwise have to be doubled. A shell script full of `{{` is a script nobody
/// can read against the thing it is supposed to be.
const STATUSLINE_TEMPLATE: &str = r#"#!/bin/sh
# termic status line for @AGENT@ (usage + context feed, schema v@SCHEMA@). Safe to delete.
#
# Reports subscription usage to termic by writing ONE OSC sequence to the
# terminal termic handed it, and printing NOTHING to stdout.
#
# Printing nothing is the point. Claude renders a status line's stdout under
# the user's input box on every turn, so anything printed here would be a
# termic string sitting in the user's agent forever. The numbers ride the same
# side channel the termic hooks use instead.
#
# No network, no files, no arguments, no dependencies. Exits 0 on every path:
# a status line must never be why an agent stalls, and claude runs this one
# every turn.

# Drain stdin FIRST, whatever happens next. An early exit that left the payload
# unread is a broken pipe on claude's side, once per turn.
payload=$(cat | tr -d '[:space:]')

# Installed globally, so this also runs in iTerm, Ghostty and CI. An empty
# status line is the correct output there, and it is what an exit prints.
[ -n "$TERMIC_TASK_ID" ] || exit 0
[ -n "$TERMIC_PTY" ] || exit 0
agent='@AGENT@'
# grok reads ~/.claude/settings.json too, so claude's copy can also run under
# grok. The user never opted grok in there. Same provenance rule as its hook
# siblings. grok's own copy is grok's.
[ "$agent" != claude ] || [ -z "$GROK_HOOK_EVENT" ] || exit 0

# An API-KEY account has no rate_limits at all: plan windows are a subscription
# concept. That is precisely the account whose cost is worth reporting, so the
# early exit checks for BOTH sources and gives up only when neither is there.
case "$payload" in
  *'"rate_limits":'*|*'"total_cost_usd":'*|*'"context_window":{'*|*'"quota":{'*) ;;
  *) exit 0 ;;
esac
# Only claude's payload has a `rate_limits` worth reading. Cleared for anyone
# else so a field of the same name can never be taken for claude's.
rl=''
[ "$agent" = claude ] && rl=${payload#*'"rate_limits":'}

# One window object sliced out, then one number read out of it.
#
# A field is cut at the next ',' and then at the next '}', so it parses whether
# or not it is last in its object. TWO cuts rather than one '[,}]' class: a '}'
# inside a bracket expression closes the ${...} itself, so that pattern silently
# leaves ']*}' glued to every value. Traced, not guessed.
#
# A value that is not bare digits is dropped rather than passed on: the body it
# would land in is a ';'-separated OSC payload.
five='-'; fivereset='-'; seven='-'; sevenreset='-'

case "$rl" in
  *'"five_hour":{'*)
    w=${rl#*'"five_hour":{'}
    w=${w%%\}*}
    case "$w" in
      *'"used_percentage":'*)
        v=${w#*'"used_percentage":'}; v=${v%%,*}; v=${v%%\}*}
        case "$v" in ''|*[!0-9.]*) ;; *) five=$v ;; esac ;;
    esac
    case "$w" in
      *'"resets_at":'*)
        v=${w#*'"resets_at":'}; v=${v%%,*}; v=${v%%\}*}
        case "$v" in ''|*[!0-9]*) ;; *) fivereset=$v ;; esac ;;
    esac
    ;;
esac

case "$rl" in
  *'"seven_day":{'*)
    w=${rl#*'"seven_day":{'}
    w=${w%%\}*}
    case "$w" in
      *'"used_percentage":'*)
        v=${w#*'"used_percentage":'}; v=${v%%,*}; v=${v%%\}*}
        case "$v" in ''|*[!0-9.]*) ;; *) seven=$v ;; esac ;;
    esac
    case "$w" in
      *'"resets_at":'*)
        v=${w#*'"resets_at":'}; v=${v%%,*}; v=${v%%\}*}
        case "$v" in ''|*[!0-9]*) ;; *) sevenreset=$v ;; esac ;;
    esac
    ;;
esac

# Session cost in USD, which claude sends on EVERY account, including one with
# no plan at all. Same two-cut parse as the windows above, and the same rule:
# anything that is not a bare number is dropped rather than passed into an OSC
# payload. A dot is allowed because this is dollars and cents.
cost='-'
# claude only. grok sends a `cost.total_cost_usd` too, but a grok account is
# billed against a credit limit that this cannot see, and a dollar figure with
# no plan beside it reads as "billed per token", which it is not.
[ "$agent" = claude ] && case "$payload" in
  *'"total_cost_usd":'*)
    v=${payload#*'"total_cost_usd":'}; v=${v%%,*}; v=${v%%\}*}
    case "$v" in ''|*[!0-9.]*) ;; *) cost=$v ;; esac ;;
esac

# agy's quota, per bucket, as a REMAINING fraction. Which buckets apply depends
# on the model: Gemini models spend `gemini-*`, everything else `3p-*`. The
# fraction becomes a used percentage and `reset_in_seconds` an epoch, in awk
# because sh has no floating point. Measured on agy 1.2.6.
if [ "$agent" = agy ]; then
  q=''
  case "$payload" in *'"quota":{'*) q=${payload#*'"quota":{'} ;; esac
  model=''
  case "$payload" in
    *'"model":{'*) m=${payload#*'"model":{'}; m=${m%%\}*}
      case "$m" in *'"id":"'*) model=${m#*'"id":"'}; model=${model%%'"'*} ;; esac ;;
  esac
  case "$model" in *gemini*) fam=gemini ;; *) fam=3p ;; esac
  now=$(date +%s)
  bucket() {
    case "$q" in
      *"\"$fam-$1\":{"*)
        b=${q#*"\"$fam-$1\":{"}; b=${b%%\}*}
        f='-'; r='-'
        case "$b" in *'"remaining_fraction":'*)
          v=${b#*'"remaining_fraction":'}; v=${v%%,*}
          case "$v" in ''|*[!0-9.]*) ;; *) f=$v ;; esac ;;
        esac
        case "$b" in *'"reset_in_seconds":'*)
          v=${b#*'"reset_in_seconds":'}; v=${v%%,*}
          case "$v" in ''|*[!0-9]*) ;; *) r=$((now + v)) ;; esac ;;
        esac
        [ "$f" = '-' ] && return
        # LC_ALL=C, because awk's printf follows the locale: on a machine set
        # to a comma-decimal locale (ro_RO, de_DE, fr_FR...) this prints
        # "1,60", and the usage body is parsed as a bare number with a DOT
        # (lib/agentUsage parseUsageBody), so the reading silently vanishes for
        # everyone in half of Europe. Found by the Rust test failing on a
        # ro_RO.UTF-8 box while CI, on C, was green.
        pct=$(LC_ALL=C awk -v f="$f" 'BEGIN { p = (1 - f) * 100; if (p < 0) p = 0; printf "%.2f", p }')
        echo "$pct $r" ;;
    esac
  }
  set -- $(bucket 5h); [ -n "$1" ] && { five=$1; fivereset=$2; }
  set -- $(bucket weekly); [ -n "$1" ] && { seven=$1; sevenreset=$2; }
fi

# The context window. `total_input_tokens` is input + cache creation + cache
# read of the LAST call, which is exactly the numerator of claude's own
# `used_percentage` (measured in 2.1.276's bundle), and unlike that field it is
# flat: `used_percentage` comes AFTER the nested `current_usage` object, where
# the two-cut parse would stop on the wrong brace. termic divides instead.
# Zero tokens is a session before its first call, which is no reading at all.
#
# The other agents name the same thing differently, so each field is a list
# tried in order and the first plain number wins:
#   tokens  copilot `current_context_tokens` (its `total_input_tokens` is the
#           whole SESSION's, never the window), grok `context_tokens`, then
#           claude and agy `total_input_tokens`
#   window  `context_window_size` (null on copilot's auto model, 0 on agy
#           before its first call), then copilot `displayed_context_limit`
ctxused='-'; ctxsize='-'
num() {
  case "$cw" in
    *"\"$1\":"*)
      v=${cw#*"\"$1\":"}; v=${v%%,*}; v=${v%%\}*}
      case "$v" in ''|0|*[!0-9]*) return 1 ;; *) echo "$v" ;; esac ;;
    *) return 1 ;;
  esac
}
case "$payload" in
  *'"context_window":{'*)
    cw=${payload#*'"context_window":{'}
    ctxused=$(num current_context_tokens || num context_tokens || num total_input_tokens || echo -)
    ctxsize=$(num context_window_size || num displayed_context_limit || echo -)
    ;;
esac

# THREE targets, tried in order, exactly as the hooks do: $TERMIC_PTY is a HOST
# path a Docker-sandboxed agent cannot see, /proc/1/fd/1 is the container's own
# stdout which docker relays to that same pty, /dev/tty is the last resort that
# usually fails because these run with no controlling terminal.
#
# The values go through printf's %s, never into its FORMAT string.
emitctx() { printf ']@NOTIFY@@CTX@%s %s' "$ctxused" "$ctxsize" >> "$1" 2>/dev/null; }
if [ "$ctxused" != '-' ] && [ "$ctxsize" != '-' ]; then
  emitctx "$TERMIC_PTY" || emitctx /proc/1/fd/1 || emitctx /dev/tty || true
fi

# Nothing readable in the payload: say nothing rather than report three dashes.
[ "$five" = '-' ] && [ "$seven" = '-' ] && [ "$cost" = '-' ] && exit 0

# Same three targets as the context write above. `>>` on both, which is the
# same thing on a pty and does not let the second write erase the first when
# the target is a plain file (the tests, and any future log target).
emit() { printf ']@NOTIFY@@USAGE@%s %s %s %s %s' "$five" "$seven" "$fivereset" "$sevenreset" "$cost" >> "$1" 2>/dev/null; }
emit "$TERMIC_PTY" || emit /proc/1/fd/1 || emit /dev/tty || true
exit 0
"#;

impl Signal {
    /// The OSC payload, without introducer or terminator.
    fn payload(self) -> String {
        match self {
            Signal::Attention => format!("{NOTIFY_PREFIX}{ATTENTION_BODY}"),
            Signal::Working => format!("{NOTIFY_PREFIX}{WORKING_BODY}"),
            Signal::Done => format!("{NOTIFY_PREFIX}{DONE_BODY}"),
            Signal::Ready => format!("{NOTIFY_PREFIX}{READY_BODY}"),
        }
    }
    /// Filename stem for the generated script, so one agent's scripts do not
    /// collide and a reader can tell what each one is for.
    fn stem(self) -> &'static str {
        match self {
            Signal::Attention => "attention",
            Signal::Working => "working",
            Signal::Done => "done",
            Signal::Ready => "ready",
        }
    }

    /// What Claude shows in its own UI while the hook runs. It is USER-VISIBLE,
    /// so it has to describe the signal actually being sent: a single shared
    /// string meant a turn STARTING announced "you are needed", which is a lie
    /// on two of the three hooks. Found by installing into a real config and
    /// reading the result rather than by a test, which is why one now exists.
    fn status_message(self) -> &'static str {
        match self {
            Signal::Attention => "termic: reporting that you are needed",
            Signal::Working => "termic: reporting that this turn started",
            Signal::Done => "termic: reporting that this turn finished",
            Signal::Ready => "termic: reporting that this session is ready",
        }
    }
}

/// Which events an agent gets, and what each one reports. Deliberately minimal:
/// termic already has anything the terminal tells it, so a hook is only
/// registered for a state the terminal gets WRONG or cannot express. Per-tool-
/// call events are never registered, on any agent.
///
/// claude: `PermissionRequest` at +20ms. Its title claims IDLE while blocked,
///   so this is a correction, not an addition. (`Notification` is a +6.0s
///   nudge, measured, so it is the wrong event.)
/// grok: `Notification` (`notificationType=permission_prompt`). grok has no
///   `PermissionRequest`, and its title FREEZES on a busy spinner while
///   blocked, measured at 217s on one frame, so this is the only signal that
///   state has.
/// agy: `Stop` plus `PreInvocation`. agy emits NO OSC whatsoever, so today
///   every turn ends in the byte-quiet fallback's orange bell rather than a
///   done. It has no attention-shaped event at all, so needs-you stays on the
///   fallback. `Working` is required for `Done` to fire, since a hard idle is
///   ignored unless we were working.
pub fn hooks_for(agent: &str) -> &'static [(&'static str, Signal)] {
    match agent {
        // opencode's plugin sees all four edges in-process. It is the only
        // agent that reports permission.replied, so its attention can be
        // cleared exactly rather than waiting for the next busy signal.
        // pi's extension, same in-process model as opencode's plugin. No
        // Ready: `session_start` fires before the TUI's input box is up, and a
        // Ready that arrives early is worse than none (seedPrompt trusts it).
        // Done is `agent_settled`, not `agent_end`: pi can still auto-retry or
        // compact after `agent_end` (its own docs say so). Attention is an
        // extension's own `ctx.ui` prompt, the only blocking input pi has.
        // copilot 1.0.86, every event measured firing with the env intact.
        // `permissionRequest` fires even under `--allow-all-tools`, and is the
        // blocking edge; `postToolUse` hands working back once it is answered,
        // since copilot has no "permission replied" event. No Ready: the trust
        // dialog comes BEFORE `sessionStart`, so it cannot gate a first prompt.
        // muse 1.3.0, through its MANAGED hook file, the one hook source that
        // is handed the env vars it names (see `ConfigSlot::MuseManaged`).
        // SessionStart is lazy (it fires on the first prompt), so no Ready.
        "muse" => &[
            ("UserPromptSubmit", Signal::Working),
            ("PreToolUse", Signal::Working),
            ("PostToolUse", Signal::Working),
            ("PermissionRequest", Signal::Attention),
            ("Stop", Signal::Done),
        ],
        "copilot" => &[
            ("userPromptSubmitted", Signal::Working),
            ("preToolUse", Signal::Working),
            ("postToolUse", Signal::Working),
            ("permissionRequest", Signal::Attention),
            ("agentStop", Signal::Done),
        ],
        "pi" => &[
            ("before_agent_start", Signal::Working),
            ("tool_call", Signal::Working),
            ("ui_prompt_start", Signal::Attention),
            ("ui_prompt_end", Signal::Working),
            ("agent_settled", Signal::Done),
        ],
        // omp, same in-process model as pi's extension (it is a pi fork; the
        // API moved under the same names). Differences, all measured on
        // 18.6.0: there is no `agent_settled` (Done is `agent_end`, guarded by
        // the event's `willContinue` flag so an auto-retry continuation does
        // not settle the turn); there is no `ui_prompt_*` (attention is the
        // `tool_approval_requested`/`tool_approval_resolved` pair, which fires
        // only when a tool genuinely needs a prompt — wrapper.ts gates it on
        // `approvalCheck.required` — plus `tool_execution_start` with
        // `toolName === "ask"`, which is how omp's own Warp bridge derives its
        // `question_asked`). No Ready: `session_start` fires at startup,
        // before the composer is up, and an early Ready is worse than none.
        // Default approvals are yolo (`tools.approvalMode` defaults "yolo"),
        // so on a stock install the attention pair only fires for a user who
        // raised the setting — wiring it anyway is what makes that setting
        // honest inside termic.
        "omp" => &[
            ("before_agent_start", Signal::Working),
            ("tool_call", Signal::Working),
            ("tool_approval_requested", Signal::Attention),
            ("tool_approval_resolved", Signal::Working),
            ("agent_end", Signal::Done),
        ],
        "opencode" => &[
            ("chat.message", Signal::Working),
            ("permission.asked", Signal::Attention),
            ("permission.replied", Signal::Working),
            ("session.idle", Signal::Done),
        ],
        // Working is registered even though the title already reports it,
        // because it makes the pair SELF-SUFFICIENT: `goIdle(reason, 0)` is
        // ignored unless we were working, so a Done that depended on the title
        // having set working would inherit the title's fragility. The Codex
        // latch (see docs/gotchas.md) is what that failure looks like: a vendor
        // changed their title format and done detection silently stopped.
        // `PreToolUse` is a HEARTBEAT, not a duplicate of UserPromptSubmit.
        //
        // Working is a sustained state and every other signal here is an edge.
        // The terminal title, which this replaced, re-asserted working on every
        // repaint, so anything that wrongly cleared the spinner self-healed
        // within a frame. UserPromptSubmit fires ONCE, so the same clear became
        // permanent for the rest of the turn: a user clicking into a running
        // task has its spinner dropped (the manual-clear path) and nothing ever
        // put it back. Reported from a real session, and a straight regression
        // against the title detection it replaced.
        //
        // A tool call is the protocol's own "still going", it lands many times
        // per turn, and an observer hook that exits 0 with no output cannot
        // affect the tool (the same shape as the rtk hook people already run on
        // this event).
        //
        // `SessionStart` fires only once claude is past its own startup, which
        // notably includes the trust picker: "Is this a project you created or
        // one you trust?" with `No, exit` highlighted, and NO hook fires while
        // it is up. Measured. That makes it a true readiness gate rather than a
        // guess, and it is the only signal that distinguishes a blocking dialog
        // from a waiting input box, since both paint and then go quiet.
        //
        // Trust resolves through the REPO, not the directory: a worktree of an
        // already-trusted repo inherits it and gets no record of its own, which
        // is why the picker is not an every-task event. It is the FIRST task in
        // a repo claude has never run in - a project just added to termic, or a
        // machine where claude only ever runs through termic. Also measured,
        // after the opposite was assumed and written down.
        "claude" => &[
            ("SessionStart", Signal::Ready),
            ("UserPromptSubmit", Signal::Working),
            ("PreToolUse", Signal::Working),
            ("PermissionRequest", Signal::Attention),
            ("Stop", Signal::Done),
        ],
        // grok is the only agent measured that reports an INTERRUPT, so it is
        // the only one whose done survives an escape. StopCancelled carries
        // reason=user_interrupt, and also covers a declined permission prompt,
        // --max-turns and a no-progress bail-out.
        "grok" => &[
            ("UserPromptSubmit", Signal::Working),
            ("PreToolUse", Signal::Working),
            ("Notification", Signal::Attention),
            ("Stop", Signal::Done),
            ("StopCancelled", Signal::Done),
        ],
        // agy needs no extra heartbeat: PreInvocation already fires once per
        // model invocation, several times in a turn. Its PreToolUse is also the
        // one tool event across these agents that is NOT safe to observe
        // silently, since `decision` is documented as required, so adding it
        // would risk blocking the tool for no gain.
        "agy" => &[("PreInvocation", Signal::Working), ("Stop", Signal::Done)],
        // codex, and the reason its old "not needed" exclusion is out of date.
        //
        // That exclusion was argued from ATTENTION alone: codex's title says
        // `Action Required` at +22ms, so it needed no hook to report a
        // permission prompt. True, and beside the point for the state that
        // actually broke. Codex is not a hooks target, so it is the ONE agent
        // that can never reach the `hooksOwn` branch, which means every turn it
        // runs is ended by a guess: the byte-quiet fallback calls a turn done
        // after 4s of silence, and 4s of silence is an ordinary model
        // round-trip. That is the GH #276 storm, and codex is the agent it was
        // reported on.
        //
        // The event names are claude's exactly, which is not a coincidence:
        // codex 0.153.0 reads a claude-shaped `hooks.json` and its own
        // `HookEventName` enum lists the same set. Same mapping, same reasons,
        // one difference: codex's hooks do not run until they are TRUSTED (see
        // codex_trust.rs), which is the whole of the extra work here.
        //
        // No `PermissionRequest`, and this time the reason is measured. It
        // fires for EVERY approval request, including the ones
        // `approvals_reviewer = "auto_review"` answers itself, and its payload
        // has no field saying which reviewer will answer. Measured on 0.164.0
        // driving a real TUI at a network command: with the user as reviewer
        // the hook fired and the title went `[ . ] Action Required` 10ms
        // later; with auto_review the hook fired just the same, the title kept
        // its working spinner, and the command ran 3s later. So the hook rang
        // a needs-you for every auto-reviewed command, and the title, which
        // termic still reads for attention on a hooked agent, is the one
        // source that knows a person is being asked.
        "codex" => &[
            ("SessionStart", Signal::Ready),
            ("UserPromptSubmit", Signal::Working),
            ("PreToolUse", Signal::Working),
            ("Stop", Signal::Done),
        ],
        // devin speaks the same claude-shaped hook protocol (its docs call it
        // claude-compatible, and a live 3000.10.21 fired every one of these
        // against a file in `.devin/`). `SessionStart` carries `session_id`
        // too, which is the only way termic learns the slug to resume by:
        // devin mints its own ids and nothing accepts one at launch, so this
        // report IS the session binding, not a nicety.
        //
        // `ask_user_question` never reaches `PermissionRequest`: it is
        // auto-decided and routed to an elicitation panel, which blocks on the
        // user while only `PreToolUse` has fired (measured). The Working
        // script reads `hook_event_name` + `tool_name` and reports Attention
        // for exactly that edge; `PostToolUse` exists to hand Working back
        // the moment the answer lands.
        "devin" => &[
            ("SessionStart", Signal::Ready),
            ("UserPromptSubmit", Signal::Working),
            ("PreToolUse", Signal::Working),
            ("PostToolUse", Signal::Working),
            ("PermissionRequest", Signal::Attention),
            ("Stop", Signal::Done),
        ],
        _ => &[],
    }
}

// Why every agent writes to `$TERMIC_PTY`, including claude.
//
// claude CAN return a `terminalSequence` and write the OSC itself, and that was
// the original design. It is not enough. Its runtime allowlists what it will
// write: "only OSC 0/1/2/9/99/777 and BEL are permitted, and OSC 9 bodies may
// not begin with a digit unless in the 9;4 progress form", quoted from the
// binary. OSC 133 is not on that list, so a `Done` sent that way is dropped
// SILENTLY: the hook fires correctly and nothing reaches the parser. Measured.
//
// Staying on `9;4` instead would be allowed but costs the hard done: `9;4;0`
// routes through the 5s settle, while `133;D` is `goIdle(reason, 0)`. For the
// two states that matter most that is the wrong trade, so claude joins
// everyone else on the pty.
//
// The pty path works for every agent because opening a tty BY NAME needs no
// controlling terminal, which is exactly what rules out `/dev/tty` (measured on
// grok: hooks run with no ctty and the write fails, rc=1).

/// Config schema. They are not variations on one shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Schema {
    /// Not a config file at all: a module dropped into a directory the agent
    /// autoloads (opencode's `plugins/`, pi's `agent/extensions/`). Install is
    /// a file write, removal a delete, and there is nothing of the user's to
    /// merge with or preserve. The module runs in-process and sees the
    /// agent's own env, which is how it finds `$TERMIC_PTY`.
    PluginFile,
    /// `hooks.<Event>[] = { hooks: [handler] }`. claude and grok both use it,
    /// which is not a coincidence: grok reads claude's file on purpose.
    ClaudeCompatible,
    /// `<name> = { enabled, <Event>: ... }`, and HETEROGENEOUS: tool events take
    /// a `{matcher, hooks}` group while `PreInvocation` / `PostInvocation` /
    /// `Stop` take handlers DIRECTLY. Wrap the latter and they register with an
    /// EMPTY command: visible in `agy -p "/hooks"`, silently inert. Measured.
    AntigravityNamed,
    /// copilot's native hook file, `{"version":1,"hooks":{"<event>":[{"type":
    /// "command","bash":...}]}}`, written WHOLE into `hooks/termic.json`: every
    /// `*.json` there is loaded, so the file is ours outright and removal is a
    /// delete. The native shape rather than a claude-style one because the
    /// camelCase event names are the only ones measured to fire (1.0.86).
    CopilotFile,
}

fn schema_for(agent: &str) -> Schema {
    match agent {
        "copilot" => Schema::CopilotFile,
        // omp is a pi fork and kept the layout: its loader scans the active
        // agent dir's `extensions/` for `.ts`/`.js` modules (18.6.0, with
        // explicit legacy-pi compat machinery), so the same transport works.
        "opencode" | "pi" | "omp" => Schema::PluginFile,
        "agy" => Schema::AntigravityNamed,
        _ => Schema::ClaudeCompatible,
    }
}

/// How often the opencode plugin may re-assert "working" while a turn streams.
/// Well under any demoter's patience, and far above the raw event rate.
const HEARTBEAT_MS: u32 = 2_000;

/// Top-level key we own in the Antigravity config. Removal deletes exactly this.
const AGY_HOOK_NAME: &str = "termic";

// ─────────────────────────── The script ────────────────────────────────

/// The hook body. `printf '%s'` with a single-quoted argument so the shell
/// never touches the backslashes: the escape and bell reach Claude as the JSON
/// escapes `` / ``, never as raw control bytes, which keeps the file
/// greppable and diffable.
pub fn script_body(agent: &str, sig: Signal) -> String {
    let payload = sig.payload();

    // A Done hook must NOT claim the turn is over while the agent still has
    // work outstanding. claude fires `Stop` with a populated `background_tasks`
    // when it backgrounds a subagent or a shell and keeps waiting (measured),
    // and agy reports the same thing as `fullyIdle: false`. termic used to
    // catch this by scanning the SCREEN for the agent's own status line, which
    // is the kind of text heuristic hooks exist to replace: this reads the
    // protocol instead.
    //
    // The guard is a WHITELIST of task types, and it has to be, because
    // "non-empty" was measured to mean things that never end. Read out of
    // 2.1.259: the Stop payload is built by mapping the whole task registry
    // through one filter, `status is running|pending && isBackgrounded !==
    // false`. Nothing else is dropped, and the switch that decorates the
    // entries has an explicit arm for `monitor_ws` - a websocket monitor.
    // Publishing an artifact opens one (the live-updates subscription) and it
    // stays `running` for the whole session, so from the first publish onward
    // EVERY `Stop` carried a non-empty array and this guard dropped every one
    // of them. claude's own task list hides exactly these
    // (`if (t.type === "monitor_ws" && t.ambient) continue`); the hook payload
    // does not, so termic has to.
    //
    // So the question is not "is anything in flight" but "is the AGENT still
    // working", and only delegated units of work answer yes. The friendly
    // labels come from claude's own type map: local_agent -> subagent,
    // local_workflow -> workflow, local_bash -> shell, in_process_teammate ->
    // teammate, remote_agent -> cloud session, mcp_task -> MCP task. Ambient
    // monitors (monitor_ws / monitor_mcp), `dream` and `auto-mode scan` are
    // deliberately absent, and so is any type a future release adds: an
    // unknown type falls through to done.
    //
    // Fail towards done, not towards working. Once hooks own a tab there is no
    // demoter left to correct a done that never arrives, so a wrong hold is
    // permanent; a wrong done is re-armed by the very next `PreToolUse`
    // heartbeat. The asymmetry runs the opposite way to the fallback path's.
    //
    // Deliberately no `jq`: whitespace is stripped and the field matched
    // literally, so the script keeps its "no dependencies" property. An absent
    // field means an older agent that cannot background work, so done stands.
    // The array is sliced out before matching rather than matched across the
    // whole payload, because `last_assistant_message` carries the agent's own
    // prose and a turn that happened to discuss `"type":"shell"` would
    // otherwise hold its own spinner down forever. `##` (longest prefix) picks
    // the LAST occurrence, which is the real field: claude serialises
    // `last_assistant_message` before `background_tasks`.
    let guard = match (agent, sig) {
        ("claude", Signal::Done) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "# Only DELEGATED work means the agent itself is still going. An\n",
            "# ambient monitor (an artifact watch) never ends, so it must not\n",
            "# hold the turn open. Unknown types fall through to done.\n",
            "dlg=''\n",
            "case \"$flat\" in\n",
            "  *'\"background_tasks\":['*)\n",
            "    tasks=${flat##*'\"background_tasks\":['}\n",
            "    tasks=${tasks%%]*}\n",
            "    # Agent-owned types first: a payload holding a subagent AND\n",
            "    # the shell that subagent backgrounded is an agent waiting on\n",
            "    # its subagent, and must be labelled as one.\n",
            "    for pair in 'subagent subagent' 'workflow workflow' \\\n",
            "                'teammate teammate' 'cloudsession cloud_session' \\\n",
            "                'MCPtask mcp_task' 'shell shell'; do\n",
            "      key=${pair%% *}\n",
            "      n=0\n",
            "      rest=$tasks\n",
            "      while :; do\n",
            "        case \"$rest\" in\n",
            "          *'\"type\":\"'\"$key\"'\"'*)\n",
            "            rest=${rest#*'\"type\":\"'\"$key\"'\"'}\n",
            "            n=$((n+1))\n",
            "            ;;\n",
            "          *) break ;;\n",
            "        esac\n",
            "      done\n",
            "      if [ \"$n\" -gt 0 ]; then dlg=\"$n ${pair#* }\"; break; fi\n",
            "    done\n",
            "    ;;\n",
            "esac\n",
        ),
        // codex's CONTEXT WINDOW, read at the end of every turn. `Stop` carries
        // `transcript_path`, the rollout JSONL, and by the time it fires that
        // file already holds the turn's `token_count` event (measured on
        // 0.154.0). The figure is codex's own "N% context left", computed the
        // way `codex-rs/protocol` does: a 12000-token BASELINE is reserved out
        // of the window and out of the usage, so tokens/window would disagree
        // with the TUI by several points. Only the tail is read: a rollout
        // grows for the whole session.
        ("codex", Signal::Done) => concat!(
            "# RAW, not whitespace-stripped: the path can contain a space.\n",
            "raw=$(cat)\n",
            "ctx=''\n",
            "tp=''\n",
            "case \"$raw\" in *'\"transcript_path\":\"'*) tp=${raw#*'\"transcript_path\":\"'}; tp=${tp%%'\"'*} ;; esac\n",
            "if [ -n \"$tp\" ] && [ -f \"$tp\" ]; then\n",
            "  line=$(tail -c 262144 \"$tp\" 2>/dev/null | grep '\"type\":\"token_count\"' | tail -n 1)\n",
            "  case \"$line\" in *'\"last_token_usage\":{'*'\"model_context_window\":'*)\n",
            "    lu=${line#*'\"last_token_usage\":{'}; lu=${lu%%\\}*}\n",
            "    tot=${lu#*'\"total_tokens\":'}; tot=${tot%%[!0-9]*}\n",
            "    win=${line#*'\"model_context_window\":'}; win=${win%%[!0-9]*}\n",
            "    if [ -n \"$tot\" ] && [ -n \"$win\" ] && [ \"$win\" -gt 12000 ]; then\n",
            "      eff=$((win - 12000)); used=$((tot - 12000)); [ \"$used\" -lt 0 ] && used=0\n",
            "      left=$(( ((eff - used) * 200 / eff + 1) / 2 ))\n",
            "      [ \"$left\" -lt 0 ] && left=0; [ \"$left\" -gt 100 ] && left=100\n",
            "      ctx=\"$tot $win $((100 - left))\"\n",
            "    fi ;;\n",
            "  esac\n",
            "fi\n",
        ),
        // muse runs hooks for its own internal subagents too, under their own
        // `session_id`, and a subagent's Stop would end the tab's turn early.
        // Measured on 1.3.0: the main session's id is a UUIDv7, a subagent's
        // a UUIDv4. The version is the 15th character. Anything that is not
        // a v7 is dropped, which fails quiet: the title still reports state.
        ("muse", _) => concat!(
            "raw=$(cat)\n",
            "sid=''\n",
            "case \"$raw\" in *'\"session_id\":\"'*) sid=${raw#*'\"session_id\":\"'}; sid=${sid%%'\"'*} ;; esac\n",
            "case \"$sid\" in ??????????????7*) ;; *) exit 0 ;; esac\n",
        ),
        // grok's `Notification` is not one event but several, told apart by
        // `notificationType`: `permission_prompt` is the blocking edge this
        // hook exists for, and `idle_prompt` fires about a minute after ANY
        // turn ends (grok's own hooks doc, which says to match on the type,
        // not the display `message`). Unfiltered, every finished grok turn
        // rang the bell a minute later, measured in the work-state log:
        // done at 13:51:08, "agent needs your input" at 13:52:08 with no turn
        // running. A payload with no type at all keeps the old behaviour.
        ("grok", Signal::Attention) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "case \"$flat\" in\n",
            "  *'\"notificationType\":\"permission_prompt\"'*) ;;\n",
            "  *'\"notificationType\":'*) exit 0 ;;\n",
            "esac\n",
        ),
        // agy's conversation id, for a main-checkout task to resume ITS OWN
        // conversation (`--conversation <id>`) rather than the last one run in
        // the directory. agy cannot be handed an id at launch, and it has no
        // startup event, so the first model invocation reports it; every hook
        // payload carries `conversationId` (measured on 1.2.6). Same UUID-only
        // rule as codex, since the value lands in a command line.
        ("agy", Signal::Working) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "sid=''\n",
            "case \"$flat\" in\n",
            "  *'\"conversationId\":\"'*)\n",
            "    sid=${flat#*'\"conversationId\":\"'}\n",
            "    sid=${sid%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
            "case \"$sid\" in\n",
            "  ????????-????-????-????-????????????) ;;\n",
            "  *) sid='' ;;\n",
            "esac\n",
            "case \"$sid\" in\n",
            "  *[!0-9a-fA-F-]*) sid='' ;;\n",
            "esac\n",
        ),
        // grok reports the same thing claude does, in camelCase, and says so
        // itself. From the hooks reference embedded in the 1.0.40 binary:
        // "`Stop` input also carries `backgroundTasks` and `sessionCrons`, so a
        // hook can distinguish 'session is done' from 'session is paused
        // waiting for background work to wake it back up'", each entry
        // carrying `id`, `type` (`shell`, `monitor`, or `subagent`), `status`,
        // and `agentType`. It also states the difference from claude outright:
        // "`backgroundTasks[].type` is only `shell`, `monitor`, or `subagent`;
        // Claude's other labels (`workflow`, `teammate`, ...)" do not occur.
        //
        // So `monitor` is the ambient type here, the same trap claude's
        // `monitor_ws` is, and it is excluded for the same reason: a watch
        // outlives every turn.
        //
        // Read out of the shipped binary's own documentation, NOT yet observed
        // on a live wire, which is a weaker provenance than everything else in
        // this file. It is safe at that strength and a guessed EVENT would not
        // be: an absent field leaves `$dlg` empty and the script emits the
        // plain done it emits today, so the failure mode is no change at all.
        // The probe that would settle it is in docs/agent-hooks.md.
        //
        // Gated on `Stop`. One script serves `StopCancelled` too (see
        // `hooks_for`), and that one is an INTERRUPT: the turn is over
        // whatever is still in flight, so it must never report a hold. The
        // closing quote in the pattern is what keeps `"Stop"` from matching
        // `"StopCancelled"`.
        ("grok", Signal::Done) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "dlg=''\n",
            "tasks=''\n",
            "case \"$flat\" in\n",
            "  *'\"hook_event_name\":\"Stop\"'*)\n",
            "    case \"$flat\" in\n",
            "      *'\"backgroundTasks\":['*)\n",
            "        tasks=${flat##*'\"backgroundTasks\":['}\n",
            "        tasks=${tasks%%]*}\n",
            "        for pair in 'subagent subagent' 'shell shell'; do\n",
            "          key=${pair%% *}\n",
            "          n=0\n",
            "          rest=$tasks\n",
            "          while :; do\n",
            "            case \"$rest\" in\n",
            "              *'\"type\":\"'\"$key\"'\"'*)\n",
            "                rest=${rest#*'\"type\":\"'\"$key\"'\"'}\n",
            "                n=$((n+1))\n",
            "                ;;\n",
            "              *) break ;;\n",
            "            esac\n",
            "          done\n",
            "          if [ \"$n\" -gt 0 ]; then dlg=\"$n ${pair#* }\"; break; fi\n",
            "        done\n",
            "        ;;\n",
            "    esac\n",
            "    ;;\n",
            "esac\n",
        ),
        ("agy", Signal::Done) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "# agy states it outright: anything but true means work continues.\n",
            "# It does not say WHAT is outstanding, so the generic label, and no\n",
            "# ids: with nothing to compare, termic always reads it as new work\n",
            "# and waits for agy rather than announcing over it.\n",
            "dlg=''\n",
            "case \"$flat\" in\n",
            "  *'\"fullyIdle\":false'*) dlg='1 work -' ;;\n",
            "esac\n",
        ),
        // Name the tool in the ATTENTION body, because this hook is the signal
        // that actually reaches the user.
        //
        // Measured order (GH #276): the hook fires the instant claude blocks,
        // and claude's own OSC 9 ("Claude needs your permission") arrives a
        // further 6.0s behind it. The banner is therefore always composed from
        // the hook's body, and claude's better wording only ever reaches the
        // badge - it cannot re-notify, and must not, since that would be two
        // banners for one prompt. So the fix is to make the body that WINS the
        // race the informative one, and the hook can be more specific than
        // claude is: it knows which tool is being asked about.
        //
        // `tool_name` is the documented field for the tool events on BOTH
        // agents that get this guard: claude 2.1.259 documents it in its own
        // embedded hooks reference ("session_id", "tool_name", "tool_input"),
        // and codex 0.153.0 requires it in the `permission-request.command.input`
        // JSON Schema its binary carries. Same field, same shape. FIRST
        // occurrence, not last, because that serialisation order puts the real
        // field before `tool_input` - the opposite of the Done guard above,
        // which needs the last one for the opposite reason.
        //
        // Still no jq, same as everything else here. And still exits 0 on
        // every path: an unparseable payload falls back to the generic body
        // rather than emitting nothing.
        // codex reports the id of the session it just started, which is the
        // only way termic can ever resume THAT session rather than "whatever
        // ran last in this directory". Two repo-root tasks share a cwd, so
        // `resume --last` hands the second one the first one's conversation;
        // this is what closes that.
        //
        // `session_id` is required in codex's own `session-start.command.input`
        // schema and was captured from a live 0.153.0 to confirm the position:
        // it is the FIRST field, ahead of `transcript_path` and `cwd`, so the
        // shortest-prefix match takes the real one. Measured across a fresh
        // start AND a resume: the id is the SAME both times (`source` is what
        // differs), so storing it on every spawn is idempotent rather than a
        // chain of ids that has to be kept in order.
        ("codex", Signal::Ready) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "sid=''\n",
            "case \"$flat\" in\n",
            "  *'\"session_id\":\"'*)\n",
            "    sid=${flat#*'\"session_id\":\"'}\n",
            "    sid=${sid%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
            "# A session id is a UUID and nothing else. It ends up expanded into\n",
            "# a `resume <id>` COMMAND LINE, so anything that is not plainly one\n",
            "# is dropped rather than escaped.\n",
            "case \"$sid\" in\n",
            "  ????????-????-????-????-????????????) ;;\n",
            "  *) sid='' ;;\n",
            "esac\n",
            "case \"$sid\" in\n",
            "  *[!0-9a-fA-F-]*) sid='' ;;\n",
            "esac\n",
        ),
        // claude reports its session id only when it MOVES inside a running
        // process (GH #306). termic already knows the id a spawn starts on: it
        // passed `--session-id` or `--resume`. What it cannot see is `/clear`,
        // which starts a new session in the same process, or `/resume`, which
        // switches to another one; everything after either lands under an id
        // the tab never stored, and the next relaunch resumes the old one.
        //
        // Measured on 2.1.273 with a SessionStart hook logging its stdin and
        // env. `session_id` is the first field. `source` is `startup` at
        // launch, `clear` with a NEW id on every `/clear`, `resume` with the
        // resumed id on `/resume <id>`, `compact` with the SAME id. So the id
        // is taken on those three and never on `startup`.
        //
        // `CLAUDE_CODE_ENTRYPOINT` must be `cli`. A `claude -p` started from
        // inside the agent inherits `TERMIC_TASK_ID` and `TERMIC_PTY`, so its
        // hook writes into this tab's pty too; it reports `startup` (already
        // excluded) and claude sets its entrypoint to `sdk-cli` even when the
        // parent env says `cli`. `CLAUDE_CODE_CHILD_SESSION` cannot tell them
        // apart: claude sets it for every hook subprocess, the main session's
        // included (measured).
        ("claude", Signal::Ready) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "sid=''\n",
            "src=''\n",
            "case \"$flat\" in\n",
            "  *'\"source\":\"'*)\n",
            "    src=${flat#*'\"source\":\"'}\n",
            "    src=${src%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
            "case \"$src:$CLAUDE_CODE_ENTRYPOINT\" in\n",
            "  clear:cli|resume:cli|compact:cli)\n",
            "    case \"$flat\" in\n",
            "      *'\"session_id\":\"'*)\n",
            "        sid=${flat#*'\"session_id\":\"'}\n",
            "        sid=${sid%%'\"'*}\n",
            "        ;;\n",
            "    esac\n",
            "    ;;\n",
            "esac\n",
            "# A uuid and nothing else: it ends up in a `--resume <id>` command line.\n",
            "case \"$sid\" in\n",
            "  ????????-????-????-????-????????????) ;;\n",
            "  *) sid='' ;;\n",
            "esac\n",
            "case \"$sid\" in\n",
            "  *[!0-9a-fA-F-]*) sid='' ;;\n",
            "esac\n",
        ),
        // Same report as codex's, with a wider alphabet: a devin session id is
        // a slug (`brassy-polish`), not a uuid. Captured from a live
        // 3000.10.21: `session_id` is in every payload, `SessionStart`'s
        // included, and it is the value `-r` takes verbatim. The check is
        // what the id ends up inside - a `--resume <id>` command line - so a
        // leading dash or a shell-active byte means dropped, not escaped.
        ("devin", Signal::Ready) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "sid=''\n",
            "case \"$flat\" in\n",
            "  *'\"session_id\":\"'*)\n",
            "    sid=${flat#*'\"session_id\":\"'}\n",
            "    sid=${sid%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
            "case \"$sid\" in\n",
            "  [0-9a-zA-Z]*) ;;\n",
            "  *) sid='' ;;\n",
            "esac\n",
            "case \"$sid\" in\n",
            "  *[!0-9a-zA-Z_-]*) sid='' ;;\n",
            "esac\n",
        ),
        ("claude", Signal::Attention) | ("codex", Signal::Attention) | ("devin", Signal::Attention) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "tool=''\n",
            "case \"$flat\" in\n",
            "  *'\"tool_name\":\"'*)\n",
            "    tool=${flat#*'\"tool_name\":\"'}\n",
            "    tool=${tool%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
            "# A tool name is a bare identifier (Bash, Write, mcp__srv__tool).\n",
            "# Anything else is not one, and a ';' would split the OSC 777\n",
            "# payload into the wrong fields, so reject rather than sanitise.\n",
            "case \"$tool\" in\n",
            "  ''|*[!A-Za-z0-9_-]*) tool='' ;;\n",
            "esac\n",
        ),
        // One Working script serves three events; the fields below are how the
        // emit arm tells the question-tool edge (PreToolUse +
        // ask_user_question) apart from the post-answer restore
        // (PostToolUse) and from every ordinary call.
        ("devin", Signal::Working) => concat!(
            "flat=$(cat | tr -d '[:space:]')\n",
            "evt=''\n",
            "tool=''\n",
            "case \"$flat\" in\n",
            "  *'\"hook_event_name\":\"'*)\n",
            "    evt=${flat#*'\"hook_event_name\":\"'}\n",
            "    evt=${evt%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
            "case \"$flat\" in\n",
            "  *'\"tool_name\":\"'*)\n",
            "    tool=${flat#*'\"tool_name\":\"'}\n",
            "    tool=${tool%%'\"'*}\n",
            "    ;;\n",
            "esac\n",
        ),
        _ => "",
    };

    // The id list is the same in both dialects, so it is appended rather than
    // written twice. agy is absent on purpose: it reports that work exists
    // without naming any, so there is nothing to compare and its report stays
    // `1 work -` (see `delegatedVerdict`, which then always reads it as new).
    let guard = if matches!((agent, sig), ("claude", Signal::Done) | ("grok", Signal::Done)) {
        format!("{guard}{DELEGATED_IDS}")
    } else {
        guard.to_string()
    };

    // Every agent writes straight to the terminal termic handed it. See
    // `uses_terminal_sequence` for why claude does not use its own channel.
    //
    // THREE targets, tried in order, because `$TERMIC_PTY` is a HOST path and
    // a Docker-sandboxed agent cannot see it. Measured inside the real sandbox
    // image: `TERMIC_PTY_EXISTS=NO`, so every hook in a sandboxed tab fired
    // correctly and wrote into nothing. Its neighbours on the same agent,
    // unsandboxed, worked throughout.
    //
    //   $TERMIC_PTY    the slave by name. The host case, and unambiguous.
    //   /proc/1/fd/1   the container's main process stdout, which docker
    //                  relays to that same host pty (`docker run -i -t`).
    //                  Measured to arrive. Needs NO controlling terminal,
    //                  which is the whole reason it beats /dev/tty here.
    //   /dev/tty       last resort. Hooks run with no ctty (measured on grok,
    //                  rc=1), so this usually fails, but it costs one failed
    //                  open and covers a runtime that does give them one.
    //
    // Chained on redirection failure, not on a readiness test: `[ -w /dev/tty ]`
    // is true even where opening it fails, so trying the write IS the test.
    // claude's attention body is composed at RUN time from `$tool` (set by the
    // guard above), so its payload cannot be a compile-time literal like every
    // other one. Two things about the shape are load-bearing:
    //
    //   - the body goes through `%s`, never into printf's FORMAT string. A tool
    //     name is rejected unless it is a bare identifier, but a `%` reaching a
    //     format string would be a bug waiting for the first one that is not.
    //   - the fallback is `HOOK_OSC_BODY` verbatim (`lib/agentHooks.ts`), so a
    //     payload this cannot read behaves exactly as it did before.
    let emit = if matches!((agent, sig), ("claude", Signal::Ready) | ("codex", Signal::Ready) | ("devin", Signal::Ready)) {
        // TWO sequences, ONE write. Ready keeps its exact body because the TS
        // side routes it on an exact match; the id rides a second sequence with
        // its own prefix, concatenated into the same `printf`.
        //
        // One write rather than two calls to `emit`, and that is not tidiness:
        // every script here writes with a TRUNCATING redirect, which is
        // meaningless on a pty and total on a regular file. Two writes meant
        // the id erased the ready that preceded it anywhere the target was a
        // file, and ready is the half `seedPrompt` blocks on. Caught by the
        // test below, which writes to a file for exactly that reason.
        //
        // `%s` again, never the format string.
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             if [ -n \"$sid\" ]; then\n\
               emit() {{ printf '\\033]{ready}\\007\\033]{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}%s\\007' \"$sid\" > \"$1\" 2>/dev/null; }}\n\
             else\n\
               emit() {{ printf '\\033]{ready}\\007' > \"$1\" 2>/dev/null; }}\n\
             fi\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true",
            ready = Signal::Ready.payload()
        )
    } else if matches!((agent, sig), ("agy", Signal::Working)) {
        // Working and the conversation id in ONE write, same reason as Ready.
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             if [ -n \"$sid\" ]; then\n\
               emit() {{ printf '\\033]{working}\\007\\033]{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}%s\\007' \"$sid\" > \"$1\" 2>/dev/null; }}\n\
             else\n\
               emit() {{ printf '\\033]{working}\\007' > \"$1\" 2>/dev/null; }}\n\
             fi\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true",
            working = Signal::Working.payload()
        )
    } else if matches!((agent, sig), ("codex", Signal::Done)) {
        // Done and the context in ONE write, for the same reason Ready and the
        // session id are: a truncating redirect onto a plain file would let the
        // second erase the first.
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             if [ -n \"$ctx\" ]; then\n\
               emit() {{ printf '\\033]{done}\\007\\033]{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}%s\\007' \"$ctx\" > \"$1\" 2>/dev/null; }}\n\
             else\n\
               emit() {{ printf '\\033]{done}\\007' > \"$1\" 2>/dev/null; }}\n\
             fi\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true",
            done = Signal::Done.payload()
        )
    } else if matches!((agent, sig),
        ("claude", Signal::Done) | ("agy", Signal::Done) | ("grok", Signal::Done)) {
        // The done guard used to `exit 0` here, writing nothing. Nothing is
        // what a model mid-token also writes, so a tab could not tell a turn
        // still running from a turn that ended while a `sleep 900` it
        // backgrounded kept its `Stop` payload populated for the rest of the
        // session. It now reports what is outstanding and lets termic decide
        // (`lib/delegatedWork.ts`), which is the same division of labour as
        // everywhere else here: the script reads the protocol, the state
        // machine sets policy.
        //
        // `%s` again, never the format string: `$dlg` is built from an
        // agent-controlled payload.
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             if [ -n \"$dlg\" ]; then\n\
               emit() {{ printf '\\033]{NOTIFY_PREFIX}{DELEGATED_BODY_PREFIX}%s\\007' \"$dlg\" > \"$1\" 2>/dev/null; }}\n\
             else\n\
               emit() {{ printf '\\033]{done}\\007' > \"$1\" 2>/dev/null; }}\n\
             fi\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true",
            done = Signal::Done.payload()
        )
    } else if sig == Signal::Attention && matches!(agent, "claude" | "codex" | "devin") {
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             if [ -n \"$tool\" ]; then\n\
               body=\"needs your permission: $tool\"\n\
             else\n\
               body='{ATTENTION_BODY}'\n\
             fi\n\
             emit() {{ printf '\\033]{NOTIFY_PREFIX}%s\\007' \"$body\" > \"$1\" 2>/dev/null; }}\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true"
        )
    } else if matches!((agent, sig), ("devin", Signal::Working)) {
        // `ask_user_question` is devin's blocking input edge: the panel it
        // paints is pixel-identical to working, and no other hook fires until
        // the answer arrives. Exact-matched, so the name reaching the OSC body
        // is always that one literal.
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             if [ \"$evt\" = PreToolUse ] && [ \"$tool\" = ask_user_question ]; then\n\
               emit() {{ printf '\\033]{NOTIFY_PREFIX}%s\\007' \"needs your answer: $tool\" > \"$1\" 2>/dev/null; }}\n\
             else\n\
               emit() {{ printf '\\033]{payload}\\007' > \"$1\" 2>/dev/null; }}\n\
             fi\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true",
            payload = Signal::Working.payload()
        )
    } else {
        format!(
            "[ -n \"$TERMIC_PTY\" ] || exit 0\n\
             emit() {{ printf '\\033]{payload}\\007' > \"$1\" 2>/dev/null; }}\n\
             emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true"
        )
    };

    // grok is the one agent that reads ANOTHER agent's config (it scans
    // ~/.claude/settings.json too), so claude's script must stay silent when
    // grok is the caller or a claude install would silently rewire grok.
    // grok's own script wants the opposite test.
    let provenance = if agent == "grok" {
        "# Only meaningful when grok is the caller; this file is grok's own.\n[ -n \"$GROK_HOOK_EVENT\" ] || exit 0"
    } else if agent == "claude" {
        "# grok reads ~/.claude/settings.json too, so this file also runs under\n# grok. The user never opted grok in here, and grok has its own install.\n[ -z \"$GROK_HOOK_EVENT\" ] || exit 0"
    } else {
        "# This file is only read by its own agent."
    };

    let what = sig.stem();
    bound_emits(&format!(
        r#"#!/bin/sh
# termic agent hook for {agent} ({what}, schema v{SCHEMA_VERSION}). Safe to delete.
#
# Puts one OSC sequence on the agent's own terminal so termic knows its state.
# No network, no files, no arguments, no stdin parsing.
# Exits 0 on every path: a hook must never be why an agent stalls.

# Not spawned by a termic PTY (this file is installed globally, so it also runs
# in iTerm, Ghostty and CI). Stay silent there.
[ -n "$TERMIC_TASK_ID" ] || exit 0

{provenance}

{guard}{emit}
exit 0
"#
    ))
}

/// opencode's plugin, which is a JS module rather than a spawned hook.
///
/// It runs IN-PROCESS inside opencode, so the safety model inverts: there is no
/// timeout and no exit code, and a throw inside `tool.execute.before` blocks
/// the tool (opencode's own documented example for it). Every handler is
/// therefore individually wrapped, and the module does nothing at all outside a
/// termic pty.
///
/// Being in-process is also why it writes with `fs` rather than spawning
/// anything: no process per event.
/// The module a `Schema::PluginFile` agent loads.
fn plugin_body(agent: &str) -> String {
    match agent {
        "pi" => pi_extension_body(),
        "omp" => omp_extension_body(),
        _ => opencode_plugin_body(),
    }
}

/// omp's extension. Same transport and structure as pi's (same fork, same
/// `pi.on(event, handler)` surface, same `ContextUsage`), with the event
/// differences 18.6.0 actually has — each measured live with a probe
/// extension that logged every payload:
///
/// - Done is `agent_end`, NOT guarded by a settle event: omp has no
///   `agent_settled`. Instead `AgentEndEvent.willContinue` says the session
///   already scheduled a continuation (auto-retry and friends) and
///   "subscribers must not treat this as a user-visible terminal settle"
///   (shared-events.ts) — so `willContinue` truthy suppresses the Done.
/// - Attention is `tool_approval_requested` (fired only when a tool truly
///   needs a prompt — `approvalCheck.required` in wrapper.ts — so yolo runs
///   never false-attention) plus omp's own ask edge, `tool_execution_start`
///   with `toolName === "ask"`, which is the same event omp's Warp bridge
///   maps to its `question_asked` attention event. Working comes back on
///   `tool_approval_resolved`, or on the next tool result after an ask.
/// - omp runs SUBAGENTS in-session (`ctx.agent.kind` is `"main"` or `"sub"`)
///   and a subagent's `agent_end` would end the tab's turn early — the muse
///   trap. Every handler drops non-main sessions.
/// - The session id is REPORTED (`session <uuid>` body), the codex way: omp
///   mints its own UUIDv7 at startup and accepts one only on `-r`, so this
///   report is the resume binding. `session_start` fires at startup (before
///   the first prompt, measured in `-p` and TUI alike) and again on an
///   in-process `/resume` switch, where `session_switch` also fires.
///
/// Context comes from `ctx.getContextUsage()` — `{tokens, contextWindow,
/// percent}`, the identical shape pi reports (measured:
/// `{tokens: 5788, contextWindow: 1000000, percent: 0.5788}`), percent 0-100.
fn omp_extension_body() -> String {
    let attention = Signal::Attention.payload();
    let working = Signal::Working.payload();
    let done = Signal::Done.payload();
    let ctx = format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}");
    let session = format!("{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}");
    format!(
        r#"// termic agent hook for omp (generated, schema v{SCHEMA_VERSION}). Safe to delete.
//
// Reports oh-my-pi's state, context window and session id to termic by writing
// one OSC sequence to the terminal termic handed it ($TERMIC_PTY). Runs
// in-process, so every handler is wrapped: a throw here would land in omp.
import {{ openSync, writeSync, closeSync, constants as fsConstants }} from "node:fs";

const PTY = process.env.TERMIC_PTY;
// Installed globally, so it also loads under a plain `omp` in any terminal.
const ACTIVE = Boolean(PTY && process.env.TERMIC_TASK_ID);
const TARGETS = [PTY, "/proc/1/fd/1", "/dev/tty"];

const send = (payload: string) => {{
  if (!ACTIVE) return;
  for (const t of TARGETS) {{
    if (!t) continue;
    try {{
      // NON-BLOCKING: a tty whose reader is gone fills up, and a blocking
      // write would freeze the agent itself (this runs in its process) and
      // hold the tty's lock, which hangs anything else that stats /dev.
      const fd = openSync(t, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
      try {{ writeSync(fd, `\x1b]${{payload}}\x07`); }} finally {{ closeSync(fd); }}
      return;
    }} catch {{ /* try the next */ }}
  }}
}};

const ATTENTION = "{attention}";
const WORKING   = "{working}";
const DONE      = "{done}";
const CTX       = "{ctx}";
const SESSION   = "{session}";

let lastBeat = 0;
const beat = () => {{
  const now = Date.now();
  if (now - lastBeat < {HEARTBEAT_MS}) return;
  lastBeat = now;
  send(WORKING);
}};

let lastCtx = "";
const reportContext = (ctx: any) => {{
  const u = ctx?.getContextUsage?.();
  if (!u || u.tokens == null || !(u.contextWindow > 0)) return;
  const pct = typeof u.percent === "number" ? u.percent : (u.tokens / u.contextWindow) * 100;
  const body = `${{Math.round(u.tokens)}} ${{Math.round(u.contextWindow)}} ${{Math.round(pct)}}`;
  if (body === lastCtx) return;
  lastCtx = body;
  send(CTX + body);
}};

// Subagents run in this session's process under their own id; their edges
// must never move the tab (a subagent's agent_end would end the turn early).
const isMain = (ctx: any) => !ctx?.agent || ctx.agent.kind === "main";
const reportSession = (ctx: any) => {{
  if (!isMain(ctx)) return;
  const id = ctx?.sessionManager?.getSessionId?.();
  if (typeof id === "string" && id) send(SESSION + id);
}};

export default function (pi: any) {{
  if (!ACTIVE) return;
  // Set by the two blocking edges (approval prompt, ask) and cleared by the
  // next tool result, so an answered ask hands Working back EXACTLY rather
  // than whenever the next heartbeat happens to be due (opencode is the
  // precedent: attention cleared, not inferred).
  let awaiting = false;
  const on = (event: string, fn: (event: any, ctx: any) => void) =>
    pi.on(event, async (event: any, ctx: any) => {{
      try {{ if (isMain(ctx)) fn(event, ctx); }} catch {{ /* never throw into omp */ }}
    }});
  on("before_agent_start", () => {{ send(WORKING); lastBeat = Date.now(); }});
  on("tool_call", () => beat());
  on("tool_approval_requested", () => {{ awaiting = true; send(ATTENTION); }});
  on("tool_approval_resolved", () => {{ awaiting = false; send(WORKING); }});
  // omp's ask tool blocks on the user without an approval event; this is the
  // edge its own Warp bridge maps to `question_asked`.
  on("tool_execution_start", (event: any) => {{
    if (event?.toolName === "ask") {{ awaiting = true; send(ATTENTION); }}
  }});
  on("tool_result", () => {{
    if (awaiting) {{ awaiting = false; send(WORKING); return; }}
    beat();
  }});
  // omp handlers receive (event, ctx) — the payload FIRST, context second —
  // so every ctx-only handler names the payload and lets it go.
  on("turn_end", (_event: any, ctx: any) => reportContext(ctx));
  on("session_compact", (_event: any, ctx: any) => reportContext(ctx));
  // A resumed session already has a context before its first turn, and the
  // id is the resume binding: report both the moment a session exists.
  on("session_start", (_event: any, ctx: any) => {{ reportContext(ctx); reportSession(ctx); }});
  on("session_switch", (_event: any, ctx: any) => reportSession(ctx));
  // `willContinue` = the session already scheduled a continuation
  // (auto-retry, empty-stop retry); omp's own docs say subscribers must not
  // treat that agent_end as a terminal settle.
  on("agent_end", (event: any, ctx: any) => {{
    if (event?.willContinue) return;
    reportContext(ctx);
    reportSession(ctx);
    send(DONE);
  }});
}}
"#
    )
}

/// pi's extension. Everything the opencode plugin says about running
/// in-process applies: a throw lands in pi, so every handler is wrapped, and it
/// does nothing outside a termic pty.
///
/// It also reports the CONTEXT WINDOW, from pi's own `ctx.getContextUsage()`,
/// which is the figure pi's footer shows (measured: `{tokens, contextWindow,
/// percent}`, percent 0-100, tokens null right after a compaction).
fn pi_extension_body() -> String {
    let attention = Signal::Attention.payload();
    let working = Signal::Working.payload();
    let done = Signal::Done.payload();
    let ctx = format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}");
    format!(
        r#"// termic agent hook for pi (generated, schema v{SCHEMA_VERSION}). Safe to delete.
//
// Reports pi's state and context window to termic by writing one OSC sequence
// to the terminal termic handed it ($TERMIC_PTY). Runs in-process, so every
// handler is wrapped: a throw here would land in pi.
import {{ openSync, writeSync, closeSync, constants as fsConstants }} from "node:fs";

const PTY = process.env.TERMIC_PTY;
// Installed globally, so it also loads under a plain `pi` in any terminal.
const ACTIVE = Boolean(PTY && process.env.TERMIC_TASK_ID);
const TARGETS = [PTY, "/proc/1/fd/1", "/dev/tty"];

const send = (payload: string) => {{
  if (!ACTIVE) return;
  for (const t of TARGETS) {{
    if (!t) continue;
    try {{
      // NON-BLOCKING: a tty whose reader is gone fills up, and a blocking
      // write would freeze the agent itself (this runs in its process) and
      // hold the tty's lock, which hangs anything else that stats /dev.
      const fd = openSync(t, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
      try {{ writeSync(fd, `\x1b]${{payload}}\x07`); }} finally {{ closeSync(fd); }}
      return;
    }} catch {{ /* try the next */ }}
  }}
}};

const ATTENTION = "{attention}";
const WORKING   = "{working}";
const DONE      = "{done}";
const CTX       = "{ctx}";

let lastBeat = 0;
const beat = () => {{
  const now = Date.now();
  if (now - lastBeat < {HEARTBEAT_MS}) return;
  lastBeat = now;
  send(WORKING);
}};

let lastCtx = "";
const reportContext = (ctx: any) => {{
  const u = ctx?.getContextUsage?.();
  if (!u || u.tokens == null || !(u.contextWindow > 0)) return;
  const pct = typeof u.percent === "number" ? u.percent : (u.tokens / u.contextWindow) * 100;
  const body = `${{Math.round(u.tokens)}} ${{Math.round(u.contextWindow)}} ${{Math.round(pct)}}`;
  if (body === lastCtx) return;
  lastCtx = body;
  send(CTX + body);
}};

export default function (pi: any) {{
  if (!ACTIVE) return;
  const on = (event: string, fn: (ctx: any) => void) =>
    pi.on(event, async (_event: any, ctx: any) => {{ try {{ fn(ctx); }} catch {{ /* never throw into pi */ }} }});
  on("before_agent_start", () => {{ send(WORKING); lastBeat = Date.now(); }});
  on("tool_call", () => beat());
  on("ui_prompt_start", () => send(ATTENTION));
  on("ui_prompt_end", () => send(WORKING));
  on("turn_end", ctx => reportContext(ctx));
  on("session_compact", ctx => reportContext(ctx));
  // A resumed session already has a context before its first turn.
  on("session_start", ctx => reportContext(ctx));
  on("agent_settled", ctx => {{ reportContext(ctx); send(DONE); }});
}}
"#
    )
}

fn opencode_plugin_body() -> String {
    let attention = Signal::Attention.payload();
    let working = Signal::Working.payload();
    let done = Signal::Done.payload();
    let ctx = format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}");
    format!(
        r#"// termic agent hook for opencode (generated, schema v{SCHEMA_VERSION}). Safe to delete.
//
// Reports opencode's state to termic by writing one OSC sequence to the
// terminal termic handed it ($TERMIC_PTY). opencode emits no busy/idle OSC of
// its own, so without this every turn ends in termic's byte-quiet fallback.
//
// This file is opencode 1's. opencode 2 loads it too, and is handed a no-op
// (see the export at the bottom); its reporting is plugins/termic/tui.js.
//
// Runs IN-PROCESS: no timeout, no exit code, and a throw in a tool handler
// blocks the tool. Every handler below is wrapped for that reason.
import {{ openSync, writeSync, closeSync, constants as fsConstants }} from "fs";

const PTY = process.env.TERMIC_PTY;
// Not spawned by a termic pty (this file is installed globally, so it also
// loads under a plain `opencode` in any terminal). Do nothing there.
const ACTIVE = Boolean(PTY && process.env.TERMIC_TASK_ID);

// Same three targets as the shell hooks, same reason: $TERMIC_PTY is a HOST
// path, so a Docker-sandboxed opencode cannot see it. /proc/1/fd/1 is the
// container's main process stdout, which docker relays to that same pty.
const TARGETS = [PTY, "/proc/1/fd/1", "/dev/tty"];

const send = (payload) => {{
  if (!ACTIVE) return;
  for (const t of TARGETS) {{
    if (!t) continue;
    try {{
      // NON-BLOCKING: a tty whose reader is gone fills up, and a blocking
      // write would freeze the agent itself (this runs in its process) and
      // hold the tty's lock, which hangs anything else that stats /dev.
      const fd = openSync(t, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
      try {{ writeSync(fd, `\x1b]${{payload}}\x07`); }} finally {{ closeSync(fd); }}
      return;
    }} catch {{ /* try the next */ }}
  }}
}};

const ATTENTION = "{attention}";
const WORKING   = "{working}";
const DONE      = "{done}";
const CTX       = "{ctx}";

// Context window, computed exactly as opencode's own TUI does (read out of the
// 1.18.31 binary): the LAST assistant message with output, summing input,
// output, reasoning and both cache counts, over the model's `limit.context`.
// The limit is learned from `chat.params`, which hands over the model it is
// about to call, and keyed by provider/model because a turn can make a second
// call on a different small model (the title). `config.providers()` is the
// fallback for a session resumed before any `chat.params` fired.
const limits = new Map();
let lastDoneFor = "";
// Set once this turn's done is sent, cleared by the next user message: a part
// update that trails the final message must not re-assert working after done.
let turnDone = false;
let lastCtx = "";
const reportContext = async (client, info) => {{
  const t = info?.tokens;
  if (!t || !(t.output > 0)) return;
  const used = (t.input || 0) + (t.output || 0) + (t.reasoning || 0)
    + (t.cache?.read || 0) + (t.cache?.write || 0);
  const key = `${{info.providerID}}/${{info.modelID}}`;
  let limit = limits.get(key);
  if (limit === undefined && client?.config?.providers) {{
    limits.set(key, 0); // one lookup per model, not one per streamed update
    try {{
      const res = await client.config.providers();
      const list = res?.data?.providers ?? res?.providers ?? [];
      const model = list.find(p => p.id === info.providerID)?.models?.[info.modelID];
      limit = model?.limit?.context || 0;
      limits.set(key, limit);
    }} catch {{ limit = 0; }}
  }}
  if (!(used > 0) || !(limit > 0)) return;
  const body = `${{used}} ${{limit}} ${{Math.round(used / limit * 100)}}`;
  if (body === lastCtx) return;
  lastCtx = body;
  send(CTX + body);
}};

// Heartbeat. `chat.message` fires ONCE per turn, and working is a sustained
// state: anything that clears the spinner mid-turn (the user clicking into the
// task drops it) would otherwise never be undone, which is the regression the
// terminal title did not have, because it re-asserted on every repaint.
// opencode streams `message.part.delta` continuously while it works (measured:
// hundreds per turn), so re-asserting on those restores self-healing. Throttled
// because the raw rate is far too high to write an OSC per event.
let lastBeat = 0;
const beat = () => {{
  if (turnDone) return;
  const now = Date.now();
  if (now - lastBeat < {HEARTBEAT_MS}) return;
  lastBeat = now;
  send(WORKING);
}};

const TermicStatus = async ({{ client }} = {{}}) => ({{
  // One per turn, on submit.
  "chat.message": async () => {{ try {{ turnDone = false; send(WORKING); lastBeat = Date.now(); }} catch {{}} }},
  "chat.params": async (input) => {{
    try {{
      const m = input?.model;
      if (m?.limit?.context > 0) limits.set(`${{m.providerID}}/${{m.id}}`, m.limit.context);
    }} catch {{}}
  }},
  event: async ({{ event }}) => {{
    try {{
      if (event?.type === "message.updated") {{
        const info = event.properties?.info;
        if (ACTIVE && info?.role === "assistant") {{
          await reportContext(client, info);
          // The END of the turn is the assistant's final message completing,
          // not `session.idle`: idle waits for opencode's second model call
          // (the session title), measured at 14s after a 2s reply. A final
          // message is one that completed with a finish reason that does not
          // hand back to a tool. `session.idle` stays as the backstop, and a
          // second done on one turn is a no-op on termic's side.
          if (info.time?.completed && info.finish && info.finish !== "tool-calls"
              && info.id && info.id !== lastDoneFor) {{
            lastDoneFor = info.id;
            turnDone = true;
            send(DONE);
          }}
        }}
        return;
      }}
      if (event?.type === "message.part.delta" || event?.type === "message.part.updated") {{
        beat();
        return;
      }}
      switch (event?.type) {{
        // The only agent measured that reports the block AND its release, so
        // attention here can be cleared exactly rather than inferred.
        case "permission.asked":   send(ATTENTION); break;
        case "permission.replied": send(WORKING);   break;
        case "session.idle":       send(DONE);      break;
      }}
    }} catch {{ /* never throw into opencode */ }}
  }},
}});

// One module, two loaders.
//
// opencode 1 reads `default.server` (`readV1Plugin`, 1.18.31 and 1.19.5) and
// runs the hooks above.
//
// opencode 2 refuses a module without `default.{{id, setup}}` (named exports
// alone fail with "Plugin must export a default definition"), and runs `setup`
// in its BACKGROUND SERVICE: one detached process shared by every opencode
// client on the machine, spawned with the environment of whichever client
// started it. Its $TERMIC_PTY is another task's terminal, or nothing, so the
// server half must stay a no-op. `server` is an unknown key there and is
// stripped by the module schema.
//
// Nothing else is exported: opencode 1's fallback (`getLegacyPlugins`)
// registers every export it finds, and a second one would be a second copy of
// these hooks.
export default {{ id: "termic", server: TermicStatus, setup() {{}} }};
"#
    )
}

/// Where opencode 2 finds `opencode_tui_plugin_body`, relative to its config
/// dir. A DIRECTORY with a `tui.js` and nothing else: opencode 2 discovers TUI
/// plugins only as directories under `plugins/` (`discoverPluginTargets`),
/// resolves `tui` by its conventional file name when there is no package.json,
/// and its server skips a directory with no `server`/`index` entry. opencode 1
/// loads only `plugins/*.{ts,js}`, one level deep, so it never sees this.
const OPENCODE_TUI_REL: &str = "plugins/termic/tui.js";

/// opencode 2's half: a TUI plugin, read out of the 2.2.5 source rather than
/// measured (see docs/agent-hooks.md, "opencode 2").
///
/// It has to be the TUI. opencode 2's server plugins run in a background
/// service shared by every client on the machine, spawned detached with
/// `{...process.env}` of whichever client started it, so its `$TERMIC_PTY` is
/// another task's terminal or nobody's. The TUI is the process termic spawned.
///
/// What it cannot assume: the event stream is the service's, "across all
/// server locations", so it carries every other task's sessions and the desktop
/// app's. A session moves this tab only once this TUI's route has shown it, and
/// stays this tab's after the user navigates away, so a running turn's done is
/// not dropped. Not its tab list: opencode 2 keeps one per directory
/// (`tui/tabs.json` under `XDG_STATE_HOME`), shared by every TUI there, so two
/// tasks in one folder each list the other's sessions. A subagent belongs to
/// its root.
///
/// The edges are opencode's own: its notifications plugin
/// (`tui/src/feature-plugins/system/notifications.ts`) rings on exactly these
/// events, including the rule that a root which succeeds while a subagent is
/// still running is not done (the subagent's report wakes it again). The
/// context window is the TUI footer's formula (`tui/src/util/session.ts`).
fn opencode_tui_plugin_body() -> String {
    let attention = Signal::Attention.payload();
    let working = Signal::Working.payload();
    let done = Signal::Done.payload();
    let ctx = format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}");
    let session = format!("{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}");
    format!(
        r#"// termic agent hook for opencode 2 (generated, schema v{SCHEMA_VERSION}). Safe to delete.
//
// Reports opencode's state, context window and session id to termic by
// writing one OSC sequence to the terminal termic handed it ($TERMIC_PTY).
//
// A TUI plugin, not a server one: opencode 2 runs server plugins in a
// background service shared by every opencode on this machine, started with
// the environment of whichever client launched it, so its $TERMIC_PTY is some
// other task's terminal. This file runs in the opencode termic spawned.
//
// Runs IN-PROCESS in opencode's TUI: a throw here lands there. Every handler
// is wrapped.
import {{ openSync, writeSync, closeSync, constants as fsConstants }} from "fs";

const PTY = process.env.TERMIC_PTY;
// Not spawned by a termic pty (this file is installed globally, so it also
// loads under a plain `opencode` in any terminal). Do nothing there.
const ACTIVE = Boolean(PTY && process.env.TERMIC_TASK_ID);

// Same three targets as the shell hooks, same reason: $TERMIC_PTY is a HOST
// path, so a Docker-sandboxed opencode cannot see it. /proc/1/fd/1 is the
// container's main process stdout, which docker relays to that same pty.
const TARGETS = [PTY, "/proc/1/fd/1", "/dev/tty"];

// Several payloads go out as ONE write, like the shell hooks' single printf.
const send = (...payloads) => {{
  if (!ACTIVE) return;
  const out = payloads.map((p) => `\x1b]${{p}}\x07`).join("");
  for (const t of TARGETS) {{
    if (!t) continue;
    try {{
      // NON-BLOCKING: a tty whose reader is gone fills up, and a blocking
      // write would freeze the agent itself (this runs in its process) and
      // hold the tty's lock, which hangs anything else that stats /dev.
      const fd = openSync(t, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
      try {{ writeSync(fd, out); }} finally {{ closeSync(fd); }}
      return;
    }} catch {{ /* try the next */ }}
  }}
}};

const ATTENTION = "{attention}";
const WORKING   = "{working}";
const DONE      = "{done}";
const CTX       = "{ctx}";
const SESSION   = "{session}";

// Streaming events. Each one re-asserts working (throttled), so anything that
// clears the spinner mid-turn is undone by the next token, as with opencode 1.
const BEAT = [
  "session.step.started", "session.text.delta", "session.reasoning.delta",
  "session.tool.input.delta", "session.tool.called", "session.tool.progress",
];

export default {{
  id: "termic",
  setup(ctx) {{
    if (!ACTIVE || typeof ctx?.data?.on !== "function") return;
    const data = ctx.data;
    const ui = ctx.ui;

    // Parent links, from `session.created` and, for a session created before
    // this plugin loaded, the TUI's own store.
    const parents = new Map();
    const parentOf = (id) => {{
      if (parents.has(id)) return parents.get(id);
      try {{ return data.session.get(id)?.parentID || undefined; }} catch {{ return undefined; }}
    }};
    const rootOf = (id) => {{
      let cur = id;
      // Bounded: a malformed link must never hang the TUI.
      for (let i = 0; i < 64; i++) {{
        const p = parentOf(cur);
        if (!p) return cur;
        cur = p;
      }}
      return cur;
    }};

    // The event stream is the shared service's, across every location it
    // serves: other termic tasks' sessions, the desktop app's. A root becomes
    // this tab's once this TUI's route shows it, and stays this tab's.
    // Not its tab list: opencode keeps one list per directory, shared by every
    // TUI there, so two tasks in one folder each list the other's sessions.
    const owned = new Set();
    const shown = (root) => {{
      try {{
        const r = ui?.router?.current?.();
        return r?.type === "session" && rootOf(r.sessionID) === root;
      }} catch {{ return false; }}
    }};
    const mine = (id) => {{
      if (typeof id !== "string" || !id) return false;
      const root = rootOf(id);
      if (owned.has(root)) return true;
      if (!shown(root)) return false;
      owned.add(root);
      return true;
    }};
    const isRoot = (id) => !parentOf(id);

    // Roots of this tab with an execution in flight, and the prompts (a
    // permission or a form) still waiting on the user, keyed to their root.
    const running = new Set();
    const blocked = new Map();
    let lastBeat = 0;
    const working = () => {{ lastBeat = Date.now(); send(WORKING); }};
    // The resume binding. A turn starting in one of this TUI's roots is the
    // session the user works in, so it is the one a relaunch should reopen.
    // termic's fallback, `opencode session list`, only knows the newest
    // session in the folder, which is another task's when two share one. Sent
    // when it changes, and only in the id shape termic accepts.
    let reported = "";
    const binding = (id) => {{
      if (id === reported || !/^[0-9a-zA-Z][0-9a-zA-Z_-]{{0,127}}$/.test(id)) return [];
      reported = id;
      return [SESSION + id];
    }};
    const beat = () => {{
      if (!running.size || blocked.size) return;
      const now = Date.now();
      if (now - lastBeat < {HEARTBEAT_MS}) return;
      lastBeat = now;
      send(WORKING);
    }};
    const block = (key, sessionID) => {{
      const root = rootOf(sessionID);
      blocked.set(key, root);
      running.add(root);
      send(ATTENTION);
    }};
    // The release: attention is cleared exactly, not inferred from the next
    // token.
    const unblock = (key) => {{
      if (blocked.delete(key) && !blocked.size) working();
    }};
    // Only direct children, and only running ones: opencode's own rule for
    // holding a root's done (a grandchild reports to its own parent).
    const hasRunningChild = (id) => {{
      try {{
        return data.session.family(id).some((child) =>
          child !== id && data.session.get(child)?.parentID === id && data.session.status(child) === "running");
      }} catch {{ return false; }}
    }};
    const finish = (root) => {{
      if (!running.delete(root)) return;
      for (const [key, r] of blocked) if (r === root) blocked.delete(key);
      if (!running.size) send(DONE);
    }};

    // Context window, the TUI footer's formula: the last assistant step's
    // input + output + reasoning + cache read + cache write, over the model's
    // `limit.context` from the session location's model list.
    const models = new Map();
    const limits = new Map();
    let lastCtx = "";
    const limitFor = async (sessionID, ref) => {{
      const location = data.session.get(sessionID)?.location;
      const find = () => data.location?.model?.list?.(location)
        ?.find((m) => m.providerID === ref.providerID && m.id === ref.id);
      let model = find();
      if (!model && data.location?.model?.sync) {{
        await data.location.model.sync(location);
        model = find();
      }}
      return model?.limit?.context || 0;
    }};
    const reportContext = async (sessionID, t) => {{
      const ref = models.get(sessionID);
      if (!ref || !t) return;
      const used = (t.input || 0) + (t.output || 0) + (t.reasoning || 0)
        + (t.cache?.read || 0) + (t.cache?.write || 0);
      if (!(used > 0)) return;
      const key = `${{ref.providerID}}/${{ref.id}}`;
      let limit = limits.get(key);
      if (limit === undefined) {{
        limits.set(key, 0); // one lookup per model, not one per step
        try {{ limit = await limitFor(sessionID, ref); }} catch {{ limit = 0; }}
        limits.set(key, limit);
      }}
      if (!(limit > 0)) return;
      const body = `${{used}} ${{limit}} ${{Math.round(used / limit * 100)}}`;
      if (body === lastCtx) return;
      lastCtx = body;
      send(CTX + body);
    }};

    const off = [];
    const on = (type, fn) => {{
      try {{
        off.push(data.on(type, (event) => {{
          try {{
            const r = fn(event?.data ?? {{}});
            if (r && typeof r.catch === "function") r.catch(() => {{}});
          }} catch {{ /* never throw into opencode */ }}
        }}));
      }} catch {{ /* an event this build does not know */ }}
    }};

    on("session.created", (d) => {{ if (d.parentID) parents.set(d.sessionID, d.parentID); }});
    on("session.execution.started", (d) => {{
      if (!mine(d.sessionID) || !isRoot(d.sessionID)) return;
      running.add(d.sessionID);
      lastBeat = Date.now();
      send(WORKING, ...binding(d.sessionID));
    }});
    on("session.execution.succeeded", (d) => {{
      if (!mine(d.sessionID) || !isRoot(d.sessionID)) return;
      // A running subagent's report wakes this session again: not done yet.
      if (hasRunningChild(d.sessionID)) return;
      finish(d.sessionID);
    }});
    on("session.execution.interrupted", (d) => {{
      if (mine(d.sessionID) && isRoot(d.sessionID)) finish(d.sessionID);
    }});
    on("session.execution.failed", (d) => {{
      if (mine(d.sessionID) && isRoot(d.sessionID)) finish(d.sessionID);
    }});
    on("permission.asked", (d) => {{ if (mine(d.sessionID)) block(`p:${{d.id}}`, d.sessionID); }});
    on("permission.replied", (d) => unblock(`p:${{d.requestID}}`));
    on("form.created", (d) => {{ if (mine(d.form?.sessionID)) block(`f:${{d.form.id}}`, d.form.sessionID); }});
    on("form.replied", (d) => unblock(`f:${{d.id}}`));
    on("form.cancelled", (d) => unblock(`f:${{d.id}}`));
    on("session.step.started", (d) => {{
      if (d.model && mine(d.sessionID) && isRoot(d.sessionID)) models.set(d.sessionID, d.model);
    }});
    on("session.step.ended", (d) => {{
      if (mine(d.sessionID) && isRoot(d.sessionID)) return reportContext(d.sessionID, d.tokens);
    }});
    // Heartbeats only ever extend a turn already known to be this tab's, so
    // the stream's other locations cost a map lookup, not a tab scan.
    for (const type of BEAT) on(type, (d) => {{
      if (running.size && owned.has(rootOf(d.sessionID))) beat();
    }});

    return () => {{ for (const dispose of off.reverse()) try {{ dispose?.(); }} catch {{}} }};
  }},
}};
"#
    )
}

/// Files a `Schema::PluginFile` agent needs BESIDE its main module, relative
/// to its config dir. Written by install, required by status, deleted by
/// remove: the same lifecycle as the module itself.
fn plugin_companions(agent: &str) -> Vec<(&'static str, String)> {
    match agent {
        "opencode" => vec![(OPENCODE_TUI_REL, opencode_tui_plugin_body())],
        _ => Vec::new(),
    }
}

// ───────────────────────── Pure JSON surgery ───────────────────────────
//
// Kept pure and separate from the filesystem so the merge rules can be tested
// exhaustively without a HOME fixture. These are the functions that must not
// eat a user's hand-written hooks.

/// True when this hook entry is one of ours, decided by the `command` path
/// prefix rather than a marker key. A marker would need Claude's schema to
/// tolerate unknown fields (Codex's rejects the whole file over one), and a
/// path survives the user reformatting their config.
fn is_ours(entry: &Value, prefix: &str) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.starts_with(prefix))
}

/// Strip every entry of ours from `hooks.<EVENT>`, dropping groups and keys
/// that become empty. Returns true when anything was removed.
fn strip_ours(root: &mut Value, prefix: &str, event: &str) -> bool {
    let mut removed = false;
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    if let Some(groups) = hooks.get_mut(event).and_then(Value::as_array_mut) {
        for group in groups.iter_mut() {
            if let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                let before = list.len();
                list.retain(|e| !is_ours(e, prefix));
                removed |= list.len() != before;
            }
        }
        // A group whose hook list we emptied was ours alone; drop it. A group
        // that still holds user hooks stays exactly as it was.
        groups.retain(|g| {
            g.get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|l| !l.is_empty())
        });
        if groups.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        root.as_object_mut().map(|o| o.remove("hooks"));
    }
    removed
}

/// Strip our entries from every event the current set no longer registers.
/// Merging alone only ever adds, so an event dropped from `hooks_for` kept
/// firing from an older install forever.
fn without_retired_events(root: &Value, prefix: &str, hooks: &[(&str, Signal)]) -> Value {
    let mut out = root.clone();
    let events: Vec<String> = root
        .get("hooks")
        .and_then(Value::as_object)
        .map(|h| h.keys().cloned().collect())
        .unwrap_or_default();
    for event in events {
        if !hooks.iter().any(|(e, _)| *e == event) {
            strip_ours(&mut out, prefix, &event);
        }
    }
    out
}

/// Insert our entry, replacing any older one of ours. Every unknown key at
/// every level is preserved: we only ever touch `hooks.<EVENT>`.
pub fn merge(existing: &Value, command: &str, prefix: &str, event: &str, status: &str) -> Value {
    let mut root = if existing.is_object() {
        existing.clone()
    } else {
        Value::Object(Map::new())
    };
    strip_ours(&mut root, prefix, event);

    let entry = serde_json::json!({
        "type": "command",
        "command": command,
        "timeout": 5,
        "statusMessage": status,
    });

    let obj = root.as_object_mut().expect("root is an object");
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks.as_object_mut().expect("hooks is an object");
    let groups = hooks.entry(event).or_insert_with(|| Value::Array(vec![]));
    if !groups.is_array() {
        *groups = Value::Array(vec![]);
    }
    groups
        .as_array_mut()
        .expect("groups is an array")
        .push(serde_json::json!({ "hooks": [entry] }));
    root
}

/// Remove our entry. Returns `None` when there was nothing of ours to remove,
/// so the caller can leave the file completely untouched.
pub fn unmerge(existing: &Value, prefix: &str, event: &str) -> Option<Value> {
    let mut root = existing.clone();
    if !strip_ours(&mut root, prefix, event) {
        return None;
    }
    Some(root)
}

/// Antigravity's config, which is a different shape and needs its own pair.
/// One named entry we own outright, so install is a set and removal a delete.
///
/// The heterogeneity is the trap: tool events take a `{matcher, hooks}` group
/// while `PreInvocation` / `PostInvocation` / `Stop` take handlers DIRECTLY.
/// Wrapping the latter registers them with an EMPTY command, which `agy -p
/// "/hooks"` will show and which fires nothing. Measured.
fn agy_entry(commands: &[(&str, String, Signal)]) -> Value {
    let mut obj = Map::new();
    obj.insert("enabled".into(), Value::Bool(true));
    for (event, command, _sig) in commands {
        let handler = serde_json::json!({
            "type": "command", "command": command, "timeout": 5,
        });
        let is_tool_event = matches!(*event, "PreToolUse" | "PostToolUse");
        let v = if is_tool_event {
            serde_json::json!([{ "matcher": "*", "hooks": [handler] }])
        } else {
            serde_json::json!([handler])
        };
        obj.insert((*event).to_string(), v);
    }
    Value::Object(obj)
}

fn agy_merge(existing: &Value, commands: &[(&str, String, Signal)]) -> Value {
    let mut root = if existing.is_object() { existing.clone() } else { Value::Object(Map::new()) };
    root.as_object_mut()
        .expect("root is an object")
        .insert(AGY_HOOK_NAME.into(), agy_entry(commands));
    root
}

fn agy_unmerge(existing: &Value) -> Option<Value> {
    let mut root = existing.clone();
    let removed = root.as_object_mut()?.remove(AGY_HOOK_NAME).is_some();
    if removed { Some(root) } else { None }
}

/// agy's settings with `workspace` added to `trustedWorkspaces`, or None when
/// there is nothing to write: already trusted, or a shape we do not
/// understand and so must not rewrite.
fn agy_with_trusted(root: &Value, workspace: &str) -> Option<Value> {
    let mut out = root.clone();
    let list = out.as_object_mut()?
        .entry("trustedWorkspaces")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()?;
    if list.iter().any(|v| v.as_str() == Some(workspace)) {
        return None;
    }
    list.push(Value::String(workspace.into()));
    Some(out)
}

/// Pre-accept agy's "Do you trust the contents of this project?" before it
/// starts in `workspace`. Opening the project in termic is already that
/// decision, and the dialog has no input box, so a prompt sent by another
/// agent lands on it and is withheld (agentSend's echo check), i.e. lost.
///
/// There is no flag or env var for it (measured on 1.4.6, including
/// `--dangerously-skip-permissions`), and trust is an EXACT path match: a
/// trusted parent does not cover a task's worktree under it. Only ever adds.
pub fn agy_trust_workspace(config_dir: &Path, workspace: &str) -> Result<(), String> {
    let path = config_dir.join("antigravity-cli/settings.json");
    match agy_with_trusted(&read_settings(&path)?, workspace) {
        Some(next) => write_json(&path, &next),
        None => Ok(()),
    }
}

/// Whether the user has switched every hook off. Install must respect it and
/// say so, rather than writing a file that will never fire.
pub fn disable_all_hooks(root: &Value) -> bool {
    root.get("disableAllHooks")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

// ─────────────────────────── Paths ─────────────────────────────────────

/// The agent's own config dir on the host, from the same table Seatbelt and
/// Docker read so the three cannot drift.
///
/// The e2e build lets `TERMIC_E2E_AGENT_HOME` stand in for `$HOME`. Without it
/// the suite's only way to exercise install/remove would be to write into the
/// developer's REAL config, which is not a test, it is a hazard. Feature-gated
/// so no release binary can be pointed anywhere but the user's own home.
/// Indexed in `docs/tech-debt.md`.
fn agent_home() -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        if let Some(v) = std::env::var_os("TERMIC_E2E_AGENT_HOME") {
            return Ok(PathBuf::from(v));
        }
    }
    dirs::home_dir().ok_or_else(|| "no home directory".to_string())
}

/// Home-relative directory holding the agent's config.
fn state_dir(agent: &str) -> Result<&'static str, String> {
    crate::agent_dirs::state_dirs(agent)
        .first()
        .copied()
        .ok_or_else(|| format!("{agent} has no known state dir"))
}

/// Which BUILT-IN an agent behaves as: itself, or what it was cloned from.
///
/// Everything about a hook comes from this (the event set, the config schema,
/// the file within the config dir), because a clone of claude runs the claude
/// binary and reads claude's config shape. Keyed on the base, a duplicated
/// agent was simply unsupported: `SUPPORTED` never matched it, so the row read
/// "could not resolve the agent config directory" and the user got no hooks on
/// the account they made the clone for.
///
/// Deliberately NOT `docker::base_agent_id_str`, which falls back to "claude"
/// for an unrecognised base. That is right for deciding a Docker mount and
/// wrong here: it would install claude's hooks into an unrelated agent's
/// config. An unknown agent stays unknown and is reported unsupported.
fn base_of(agent_id: &str) -> String {
    let agents = crate::load_settings_inner().agents;
    crate::docker::base_agent_id(&agents, agent_id).to_string()
}

/// The directory we write into, on the host filesystem, for a given target.
///
/// Resolved from the agent ENTRY, not from its base's default dir. A clone made
/// to hold a second account relocates its whole config with the agent's own env
/// var, and writing the base's path here would put one account's hooks into the
/// other account's config, which is worse than installing none.
pub fn config_dir(target: &Target) -> Result<PathBuf, String> {
    match target {
        Target::Host(agent) => {
            let home = agent_home()?;
            let agents = crate::load_settings_inner().agents;
            crate::agent_dirs::instance_config_dir(&agents, agent, &home)
                .ok_or_else(|| format!("{agent} has no known state dir"))
        }
        Target::Docker(agent_id) => Ok(crate::docker::agent_config_host_dir(agent_id)),
    }
}

/// The config FILE we merge into, which is not the same shape per agent:
/// claude keeps hooks in `settings.json` alongside everything else, grok reads
/// every `*.json` under `hooks/` so it gets a file of its own (which also makes
/// removal a delete rather than a merge-back).
fn settings_rel(agent: &str) -> &'static str {
    match agent {
        // The plugin itself. `.opencode/plugin` AND `.opencode/plugins` are
        // BOTH loaded (measured: writing both double-fires every event), so
        // only ever the documented plural.
        "opencode" => "plugins/termic.js",
        "copilot" => "hooks/termic.json",
        // Inside OUR script dir: muse reads it only because settings.json
        // points `managed_hooks_path` at it, so it is ours outright.
        "muse" => "termic-hooks/managed-hooks.json",
        // pi autoloads every `~/.pi/agent/extensions/*.ts` in every project and
        // transpiles it itself, so there is no build step (measured on 0.85.1,
        // under `-p` as well as the TUI).
        "pi" => "agent/extensions/termic.ts",
        // omp inherited the layout: its loader scans the active agent dir's
        // `extensions/` for `.ts`/`.js`, transpiling in-process (18.6.0, `-p`
        // and TUI both, measured live with a probe extension). The agent dir
        // is `<config root>/agent`, so this lands at `~/.omp/agent/extensions/`.
        "omp" => "agent/extensions/termic.ts",
        // grok reads every *.json under hooks/, so it gets a file of its own
        // and removal is a delete rather than a merge-back.
        "grok" => "hooks/termic.json",
        // Antigravity's LIVE path. `~/.gemini/antigravity-cli/hooks.json` also
        // parses and logs "loaded 1 named hooks", and then executes nothing:
        // their own changelog records that path as a bug they fixed because it
        // was desynchronised from the backend. Measured; do not "simplify" this
        // to the other one.
        "agy" => "config/hooks.json",
        // codex keeps hooks in their own file, NOT in config.toml: measured
        // via its `hooks/list`, which reports a hook written here with
        // `source: "user"`. config.toml is still touched, but only for the
        // TRUST entry (codex_trust.rs), never for the hooks themselves.
        "codex" => "hooks.json",
        // Devin's user config, whose `hooks` key is the claude-compatible
        // event map. Documented locations also include `.devin/hooks.v1.json`
        // in the project, but that is per-repo and user-owned; the global
        // config is the install termic can stand behind.
        "devin" => "config.json",
        _ => "settings.json",
    }
}

/// Directory prefix every script of ours lives under, as the CONFIG should
/// name it. Everything under this is ours, which is how removal identifies our
/// entries without needing a marker key (Codex's schema rejects a whole file
/// over one unknown key, and a path survives the user reformatting the config).
///
/// For Docker this must be the path as the CONTAINER sees it, not the host
/// path: the config dir is bind-mounted at `CONTAINER_HOME`, so a host path
/// would not resolve inside the cage.
pub fn command_prefix(target: &Target) -> Result<String, String> {
    Ok(match target {
        // Forward slashes on Windows: the agent runs the hook command
        // through Git Bash, which would read `C:\\Users\\u` as escapes.
        Target::Host(_) => format!(
            "{}/",
            config_dir(target)?.join(SCRIPT_DIR).to_string_lossy().replace('\\', "/")
        ),
        Target::Docker(agent_id) => format!(
            "{}/{}/{}/",
            crate::docker::CONTAINER_HOME,
            state_dir(crate::docker::base_agent_id_str(agent_id))?,
            SCRIPT_DIR
        ),
    })
}

fn settings_path(target: &Target) -> Result<PathBuf, String> {
    Ok(config_dir(target)?.join(settings_rel(&base_of(target.agent()))))
}

fn script_dir(target: &Target) -> Result<PathBuf, String> {
    Ok(config_dir(target)?.join(SCRIPT_DIR))
}

// ─────────────────────────── Filesystem ────────────────────────────────

/// NOTE: `serde_json` is built with `preserve_order` (see `Cargo.toml`).
/// Without it `Map` is a `BTreeMap` and every install silently re-sorts the
/// user's `settings.json` into alphabetical order, which is a visible,
/// pointless rewrite of a file they hand-wrote, and it also defeats the
/// byte-identical restore below.
///
/// Write via a temp file in the SAME directory then rename, so a crash or a
/// full disk can never leave a half-written `settings.json` behind. That file
/// breaks the user's agent, not just termic.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "no parent dir".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.termic-tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create temp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write temp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync temp: {e}"))?;
    }
    // One-step replace on Windows too: the agent may read it mid-write.
    crate::rename_replace(&tmp, path).map_err(|e| format!("rename into place: {e}"))
}

/// Read and parse settings.json. A missing file is an empty object; malformed
/// JSON is an ERROR, never an empty object, because overwriting a config we
/// failed to understand would destroy the user's own hooks.
fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("read {}: {e}", path.display())),
        Ok(s) if s.trim().is_empty() => Ok(Value::Object(Map::new())),
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display())),
    }
}

pub fn status(target: &Target) -> HookStatus {
    // The BASE: what this agent behaves as. Paths still come from the target,
    // which carries the instance id, so a clone writes into its own config dir.
    let agent = base_of(target.agent());
    let settings = settings_path(target);
    let script = script_dir(target);
    let (settings_path_s, script_dir_s) = (
        settings.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        script.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    );
    let mut out = HookStatus {
        installed: false,
        settings_path: settings_path_s,
        script_dir: script_dir_s,
        disabled_all: false,
        error: None,
        schema_version: None,
        stale: false,
        ours_present: false,
    };
    let (Ok(settings), Ok(script)) = (settings, script) else {
        out.error = Some("could not resolve the agent config directory".into());
        return out;
    };
    if schema_for(&agent) == Schema::PluginFile {
        // A JS file, not JSON: presence IS the install, and there are no
        // per-event entries. With a companion (opencode 2's TUI plugin) the
        // module alone is incomplete rather than absent, so consent is ANY of
        // our files and completeness is all. A v16 opencode install is exactly
        // that, and stale, so sync writes the rest.
        let config = config_dir(target).ok();
        let companions: Vec<bool> = plugin_companions(&agent)
            .iter()
            .map(|(rel, _)| config.as_ref().is_some_and(|c| c.join(rel).exists()))
            .collect();
        out.installed = settings.exists() && companions.iter().all(|&c| c);
        out.ours_present = settings.exists() || companions.iter().any(|&c| c);
        out.schema_version = std::fs::read_to_string(script.join(MANIFEST_NAME))
            .ok()
            .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
            .map(|m| m.schema_version);
        out.stale = out.ours_present && out.schema_version != Some(SCHEMA_VERSION);
        return out;
    }
    let root = match read_settings(&settings) {
        Ok(v) => v,
        Err(e) => { out.error = Some(e); return out; }
    };
    out.disabled_all = disable_all_hooks(&root);
    let Ok(prefix) = command_prefix(target) else { return out };

    match schema_for(&agent) {
        Schema::ClaudeCompatible => {
            let hooks = hooks_for(&agent);
            let has = |event: &str| {
                root.get("hooks")
                    .and_then(|h| h.get(event))
                    .and_then(Value::as_array)
                    .is_some_and(|groups| groups.iter().any(|g| {
                        g.get("hooks").and_then(Value::as_array)
                            .is_some_and(|l| l.iter().any(|e| is_ours(e, &prefix)))
                    }))
            };
            // Every registered event must be present, or a partial install
            // would report as done and quietly miss a signal.
            out.installed = !hooks.is_empty() && hooks.iter().all(|(event, _)| has(event));
            // codex only: hooks it does not TRUST are discovered, reported
            // enabled, and never run (codex_trust.rs). Reporting "on" for those
            // would be the UI stating the opposite of the truth, so the trust
            // entry is part of what "installed" means here. Read from
            // config.toml rather than asked of codex: status runs for every
            // agent on every Settings mount and cannot spawn a process per row.
            if agent == "codex" && out.installed && matches!(target, Target::Host(_)) {
                let cfg = config_dir(target)
                    .ok()
                    .and_then(|d| std::fs::read_to_string(d.join("config.toml")).ok())
                    .unwrap_or_default();
                if !crate::codex_trust::is_trusted_here(&cfg, &settings) {
                    out.installed = false;
                    out.error = Some(
                        "codex has the hooks but has not been told to trust them, so they \
                         will not run. Re-install them to fix it."
                            .into(),
                    );
                }
            }
            // ANY entry is consent. A set that gained an event since this
            // install was written is incomplete, not absent, and it is the
            // case sync exists for.
            out.ours_present = hooks.iter().any(|(event, _)| has(event));
        }
        Schema::AntigravityNamed => {
            out.installed = root.get(AGY_HOOK_NAME).is_some();
            // One key we own outright: it is there or it is not.
            out.ours_present = out.installed;
        }
        Schema::CopilotFile => {
            let hooks = hooks_for(&agent);
            let has = |event: &str| {
                root.get("hooks").and_then(|h| h.get(event)).and_then(Value::as_array)
                    .is_some_and(|l| l.iter().any(|e| {
                        e.get("bash").and_then(Value::as_str).is_some_and(|c| c.starts_with(&prefix))
                    }))
            };
            out.installed = hooks.iter().all(|(event, _)| has(event));
            out.ours_present = hooks.iter().any(|(event, _)| has(event));
        }
        // Handled by the early return above: the plugin is one file we write
        // whole, so there is no config to inspect or merge. Spelled out rather
        // than a catch-all so a NEW schema still fails to compile here.
        Schema::PluginFile => unreachable!("opencode returns before this"),
    };
    out.schema_version = std::fs::read_to_string(script.join(MANIFEST_NAME))
        .ok()
        .and_then(|s| serde_json::from_str::<Manifest>(&s).ok())
        .map(|m| m.schema_version);
    // An install predating the manifest has no version at all, which is older
    // than anything and therefore stale too. Keyed on `ours_present`, not
    // `installed`: an install missing an event ADDED since it was written is
    // the definition of stale, and keying on the stricter flag made exactly
    // that case invisible to sync.
    out.stale = out.ours_present && out.schema_version != Some(SCHEMA_VERSION);
    out
}

/// Trace line for the trust step. It is the one part of an install that can
/// fail for a reason outside termic (codex missing, not on PATH, an app-server
/// that will not answer), so it says so in the same log every other work-state
/// decision lands in rather than only in a returned error the UI may collapse.
fn log_trust(msg: &str) {
    crate::dlog(&format!("[agent-hooks] {msg}"));
}

/// Where codex keeps ITS config for this target, which is the same dir the
/// hooks file lives in. `CODEX_HOME` is how a clone points codex at a second
/// account, and `config_dir` already resolves that, so the trust entry follows
/// the hooks into whichever home they were written to.
fn codex_home_for(target: &Target) -> Result<PathBuf, String> {
    config_dir(target)
}

/// The codex binary to ask. Resolved from the REGISTRY entry rather than
/// hard-coded, so a user who renamed the command or pointed it at an absolute
/// path gets their binary asked, not a `codex` that may not exist.
fn codex_binary(target: &Target) -> String {
    let agents = crate::load_settings_inner().agents;
    crate::agent_dirs::resolve_agent(&agents, target.agent())
        .map(|a| a.command)
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "codex".to_string())
}

/// Ask codex for the hash of each hook we just wrote, then record it as
/// trusted. Fails the install when it cannot: a codex install that silently
/// ends with untrusted hooks looks identical to a working one and reports
/// nothing, which is the failure this whole feature exists to remove.
fn trust_codex_hooks(target: &Target, settings: &Path, prefix: &str) -> Result<(), String> {
    let home = codex_home_for(target)?;
    let bin = codex_binary(target);
    // cwd only scopes which PROJECT-level hooks codex reports; ours are
    // user-level and are listed for any cwd. The home dir is a directory that
    // always exists and can never be a git repo with its own `.codex`.
    let found = crate::codex_trust::discover_ours(&bin, &home, settings, prefix, &home)?;
    if found.is_empty() {
        return Err(format!(
            "codex did not report the hooks termic just wrote to {}. They would \
             be installed but never run.",
            settings.display()
        ));
    }
    let cfg = home.join("config.toml");
    let existing = match std::fs::read_to_string(&cfg) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("read {}: {e}", cfg.display())),
    };
    let next = crate::codex_trust::with_trust(&existing, &found)?;
    write_atomic(&cfg, next.as_bytes())?;
    log_trust(&format!("codex: trusted {} hook(s) in {}", found.len(), cfg.display()));
    Ok(())
}

/// Remove the trust entries for the hooks file we are uninstalling.
fn untrust_codex_hooks(target: &Target, settings: &Path) -> Result<(), String> {
    if matches!(target, Target::Docker(_)) {
        return Ok(());
    }
    let cfg = codex_home_for(target)?.join("config.toml");
    let existing = match std::fs::read_to_string(&cfg) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read {}: {e}", cfg.display())),
    };
    let next = crate::codex_trust::without_trust(&existing, settings)?;
    if next != existing {
        write_atomic(&cfg, next.as_bytes())?;
    }
    Ok(())
}

/// One script per (agent, signal). A bare absolute path with no arguments, so
/// there is no quoting hazard inside JSON-inside-config on any agent.
fn script_for(dir: &Path, sig: Signal) -> PathBuf {
    dir.join(format!("{}.sh", sig.stem()))
}

/// Same, as the path the CONFIG should name. Docker needs the container view.
fn command_for(target: &Target, sig: Signal) -> Result<String, String> {
    Ok(format!("{}{}.sh", command_prefix(target)?, sig.stem()))
}

/// Who actually owns the `statusLine` slot for a task running in `cwd`, and
/// therefore whether termic's usage feed can run at all.
///
/// This exists because the failure is INVISIBLE. A project that ships its own
/// status line outranks the one termic installs at user level, so termic's
/// script never executes, no usage OSC is ever written, and the footer simply
/// shows nothing. Nothing is broken, nothing is logged, and the user is left
/// to work out why one repo reports usage and another does not. Reported
/// exactly that way.
///
/// Precedence is MEASURED, not assumed (claude 2.1.260): a project's
/// `.claude/settings.local.json` beats its `.claude/settings.json`, and either
/// beats the user's own `~/.claude/settings.json`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusLineOwner {
    /// `termic`, `project`, `project-local`, `user`, or `none`.
    pub owner: String,
    /// The settings file that owns it, so the user can go and look.
    pub path: String,
    /// The command in that slot, so the message can name what is running.
    pub command: String,
}

/// Read a `statusLine.command` out of one settings file, if it has one.
fn status_line_command(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("statusLine")?
        .get("command")?
        .as_str()
        .map(str::to_string)
}

/// Resolve the slot for `cwd`, in claude's precedence order.
pub fn status_line_owner(agent_id: &str, cwd: &Path) -> StatusLineOwner {
    let own = |owner: &str, p: &Path, c: String| StatusLineOwner {
        owner: owner.to_string(),
        path: p.display().to_string(),
        command: c,
    };
    // Project first, both files, highest precedence first. A status line here
    // wins even when termic owns the user-level slot, which is the case that
    // confuses people: the same account reports usage in one repo and not in
    // another.
    for (rel, label) in [
        (".claude/settings.local.json", "project-local"),
        (".claude/settings.json", "project"),
    ] {
        let p = cwd.join(rel);
        if let Some(c) = status_line_command(&p) {
            return own(label, &p, c);
        }
    }
    // Then the user's own, which is where termic installs.
    let target = Target::Host(agent_id.to_string());
    let Ok(settings) = settings_path(&target) else {
        return own("none", Path::new(""), String::new());
    };
    match status_line_command(&settings) {
        Some(c) => {
            let ours = command_prefix(&target)
                .map(|prefix| c.starts_with(&prefix))
                .unwrap_or(false);
            own(if ours { "termic" } else { "user" }, &settings, c)
        }
        None => own("none", &settings, String::new()),
    }
}

/// Why the usage feed is or is not running for one task.
///
/// The agent's OWN id, never its base: a clone relocates its config dir, and
/// asking about the base read `~/.claude` for every clone. A clone with its own
/// status line was then reported as termic's and got no explanation, and a
/// free clone was reported as blocked by a status line it never reads.
#[tauri::command]
pub fn usage_status_line_owner(agent_id: String, cwd: String) -> StatusLineOwner {
    status_line_owner(&agent_id, Path::new(&cwd))
}

/// Claim claude's `statusLine`, but ONLY when it is free or already ours.
///
/// There is exactly one such slot per config, and it is not termic's. A user
/// who has written their own status line looks at it on every turn, and
/// silently replacing it would be the most visible thing this feature could
/// possibly do. So a slot that is taken by anyone else is left exactly as it
/// is, and the usage feed simply does not arrive for that user.
///
/// Ownership is decided by the command's PATH PREFIX, the same test the hook
/// entries use, rather than by a marker key: it survives the user reformatting
/// the config, and claude's schema has nowhere to put a marker anyway.
fn merge_statusline(root: &Value, command: &str, prefix: &str) -> Value {
    let mut out = root.clone();
    let Some(obj) = out.as_object_mut() else { return out };
    let ours = match obj.get("statusLine") {
        None => true,
        Some(v) => v
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| c.starts_with(prefix)),
    };
    if !ours {
        return out;
    }
    obj.insert(
        "statusLine".into(),
        serde_json::json!({ "type": "command", "command": command }),
    );
    out
}

/// The inverse: drop the slot if it still names one of our scripts, else leave
/// it. Returns None when there was nothing of ours to remove, so the caller can
/// tell "removed" from "untouched" and skip a pointless rewrite of the file.
fn unmerge_statusline(root: &Value, prefix: &str) -> Option<Value> {
    let cmd = root.get("statusLine")?.get("command")?.as_str()?;
    if !cmd.starts_with(prefix) {
        return None;
    }
    let mut out = root.clone();
    out.as_object_mut()?.remove("statusLine");
    Some(out)
}

/// copilot's hook file, whole. `timeoutSec` well under copilot's default: a
/// hook here writes one OSC and exits, and a `preToolUse` that errors DENIES
/// the tool (measured), so it must never be slow enough to be killed.
fn copilot_hooks_file(commands: &[(&str, String, Signal)]) -> Value {
    let mut hooks = Map::new();
    for (event, command, _) in commands {
        let list = hooks.entry(event.to_string()).or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(a) = list {
            a.push(serde_json::json!({ "type": "command", "bash": command, "timeoutSec": 10 }));
        }
    }
    serde_json::json!({ "version": 1, "hooks": Value::Object(hooks) })
}

/// A key termic claims in a config file OTHER than the one its hooks live in:
/// an agent's status line slot, or muse's managed-hooks pointer. claude's
/// status line is in the same `settings.json` as its hooks and is merged
/// inline with them, so it is not here.
///
/// Every variant is claimed only when free and handed back only if still
/// ours, the same ownership rule as claude's `statusLine`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigSlot {
    /// A JSON settings file (config-dir relative) with a `statusLine` object.
    /// `typed`: whether the object carries `"type": "command"` (copilot's
    /// schema has it; agy's has only `command`, and agy 1.2.6 rewrites its
    /// settings on launch dropping keys it does not know).
    Json { rel: &'static str, typed: bool },
    /// grok's `[ui.status_line]` table in `config.toml`.
    GrokToml,
    /// muse's `managed_hooks_path` + `managed_hooks_env_vars` in its
    /// `settings.json`. Plain `hooks` there run with a STRIPPED environment
    /// (still true on 1.3.0), so `$TERMIC_PTY` never reaches them; the managed
    /// file is the one source muse hands named variables to. Measured end to
    /// end: an OSC from a managed hook reached a live TUI's pty, and removing
    /// the env key took the variables away again. `managed_hooks_path` is a
    /// single slot an enterprise policy may already hold, hence claim-if-free.
    MuseManaged,
}

fn config_slot(agent: &str) -> Option<ConfigSlot> {
    match agent {
        "agy" => Some(ConfigSlot::Json { rel: "antigravity-cli/settings.json", typed: false }),
        "copilot" => Some(ConfigSlot::Json { rel: "settings.json", typed: true }),
        "grok" => Some(ConfigSlot::GrokToml),
        "muse" => Some(ConfigSlot::MuseManaged),
        _ => None,
    }
}

/// The env vars muse is told to forward to managed hooks. Names only: muse
/// refuses to START on a glob like `TERMIC_*` (measured, exit 1).
const MUSE_ENV_VARS: &[&str] = &["TERMIC_PTY", "TERMIC_TASK_ID"];

/// Claim muse's managed-hooks slot in its settings, or None when it is someone
/// else's. Pure, for the tests. `schema_version` is left exactly as found:
/// muse rejects a settings file without one, and it is not ours to add.
fn muse_claim_managed(root: &Value, hooks_file: &str, prefix: &str) -> Option<Value> {
    let cur = root.get("managed_hooks_path").and_then(Value::as_str);
    if cur.is_some_and(|p| !p.starts_with(prefix)) {
        return None;
    }
    let mut out = root.clone();
    let obj = out.as_object_mut()?;
    obj.insert("managed_hooks_path".into(), Value::String(hooks_file.into()));
    let mut vars: Vec<Value> = obj.get("managed_hooks_env_vars").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    for v in MUSE_ENV_VARS {
        if !vars.iter().any(|x| x.as_str() == Some(v)) {
            vars.push(Value::String((*v).into()));
        }
    }
    obj.insert("managed_hooks_env_vars".into(), Value::Array(vars));
    Some(out)
}

/// Hand it back if it still points into our dir. The env list keeps whatever
/// names the user added; ours go, and the key goes when nothing is left.
fn muse_release_managed(root: &Value, prefix: &str) -> Option<Value> {
    let cur = root.get("managed_hooks_path").and_then(Value::as_str)?;
    if !cur.starts_with(prefix) {
        return None;
    }
    let mut out = root.clone();
    let obj = out.as_object_mut()?;
    obj.remove("managed_hooks_path");
    if let Some(Value::Array(vars)) = obj.get("managed_hooks_env_vars").cloned() {
        let rest: Vec<Value> = vars.into_iter()
            .filter(|x| !x.as_str().is_some_and(|s| MUSE_ENV_VARS.contains(&s)))
            .collect();
        if rest.is_empty() {
            obj.remove("managed_hooks_env_vars");
        } else {
            obj.insert("managed_hooks_env_vars".into(), Value::Array(rest));
        }
    }
    Some(out)
}

/// The `type` values grok reads as "no status line" (its own docs), which is
/// a slot termic may claim. Anything else is the user's.
const GROK_SLOT_FREE: &[&str] = &["disabled", "off", "none", "hidden"];

/// Claim grok's slot in a `config.toml` source, returning the new source, or
/// None when the slot is the user's. Pure, for the tests. `toml_edit` keeps
/// every comment and the user's formatting outside the one table touched.
fn grok_claim_status_line(src: &str, command: &str, prefix: &str) -> Result<Option<String>, String> {
    let mut doc: toml_edit::DocumentMut = src.parse().map_err(|e| format!("config.toml: {e}"))?;
    let existing = doc.get("ui").and_then(|u| u.get("status_line"));
    if let Some(t) = existing {
        let kind = t.get("type").and_then(|v| v.as_str()).unwrap_or("disabled");
        let cmd = t.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let ours = cmd.starts_with(prefix);
        if !ours && !GROK_SLOT_FREE.contains(&kind) {
            return Ok(None);
        }
    }
    if doc.get("ui").is_none() {
        let mut ui = toml_edit::Table::new();
        ui.set_implicit(true);
        doc["ui"] = toml_edit::Item::Table(ui);
    }
    let mut t = toml_edit::Table::new();
    t["type"] = toml_edit::value("command");
    t["command"] = toml_edit::value(command);
    doc["ui"]["status_line"] = toml_edit::Item::Table(t);
    Ok(Some(doc.to_string()))
}

/// Hand grok's slot back if it still names our script. None when untouched.
fn grok_release_status_line(src: &str, prefix: &str) -> Result<Option<String>, String> {
    let mut doc: toml_edit::DocumentMut = src.parse().map_err(|e| format!("config.toml: {e}"))?;
    let ours = doc.get("ui").and_then(|u| u.get("status_line"))
        .and_then(|t| t.get("command")).and_then(|v| v.as_str())
        .is_some_and(|c| c.starts_with(prefix));
    if !ours {
        return Ok(None);
    }
    if let Some(ui) = doc.get_mut("ui").and_then(|u| u.as_table_like_mut()) {
        ui.remove("status_line");
        if ui.is_empty() {
            doc.remove("ui");
        }
    }
    Ok(Some(doc.to_string()))
}

fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

fn install_config_slot(
    target: &Target, agent: &str, dir: &Path, prefix: &str, slot: ConfigSlot,
) -> Result<(), String> {
    let base = config_dir(target)?;
    if slot == ConfigSlot::MuseManaged {
        let path = base.join("settings.json");
        let root = read_settings(&path)?;
        let hooks_file = format!("{prefix}managed-hooks.json");
        return match muse_claim_managed(&root, &hooks_file, prefix) {
            Some(next) if next != root => write_json(&path, &next),
            Some(_) => Ok(()),
            None => Err("muse's managed_hooks_path already names another file".into()),
        };
    }
    let script = dir.join(format!("{USAGE_STEM}.sh"));
    write_atomic(&script, statusline_body_for(agent).as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod status line: {e}"))?;
    }
    let command = format!("{prefix}{USAGE_STEM}.sh");
    match slot {
        ConfigSlot::MuseManaged => unreachable!("returned above"),
        ConfigSlot::Json { rel, typed } => {
            let path = base.join(rel);
            let root = read_settings(&path)?;
            let mut next = merge_statusline(&root, &command, prefix);
            if !typed {
                if let Some(sl) = next.get_mut("statusLine").and_then(Value::as_object_mut) {
                    if sl.get("command").and_then(Value::as_str) == Some(command.as_str()) {
                        sl.remove("type");
                    }
                }
            }
            if next == root {
                return Ok(());
            }
            write_json(&path, &next)
        }
        ConfigSlot::GrokToml => {
            let path = base.join("config.toml");
            let src = std::fs::read_to_string(&path).unwrap_or_default();
            match grok_claim_status_line(&src, &command, prefix)? {
                Some(next) if next != src => write_atomic(&path, next.as_bytes()),
                _ => Ok(()),
            }
        }
    }
}

fn remove_config_slot(target: &Target, prefix: &str, slot: ConfigSlot) -> Result<(), String> {
    let base = config_dir(target)?;
    match slot {
        ConfigSlot::Json { .. } | ConfigSlot::MuseManaged => {
            let path = base.join(match slot { ConfigSlot::Json { rel, .. } => rel, _ => "settings.json" });
            if !path.exists() {
                return Ok(());
            }
            let root = read_settings(&path)?;
            let next = match slot {
                ConfigSlot::MuseManaged => muse_release_managed(&root, prefix),
                _ => unmerge_statusline(&root, prefix),
            };
            if let Some(next) = next {
                write_json(&path, &next)?;
            }
            Ok(())
        }
        ConfigSlot::GrokToml => {
            let path = base.join("config.toml");
            let Ok(src) = std::fs::read_to_string(&path) else { return Ok(()) };
            match grok_release_status_line(&src, prefix)? {
                Some(next) => write_atomic(&path, next.as_bytes()),
                None => Ok(()),
            }
        }
    }
}

pub fn install(target: &Target) -> Result<(), String> {
    // The BASE: what this agent behaves as. Paths still come from the target,
    // which carries the instance id, so a clone writes into its own config dir.
    let agent = base_of(target.agent());
    // codex in Docker: write NOTHING, and succeed.
    //
    // Its hooks do not run until a trust entry names them by the path codex
    // RESOLVED plus a hash only codex can produce (codex_trust.rs). Inside a
    // container both are unknowable from out here: the path is the container's
    // (`/root/.codex/hooks.json`, not the host dir termic wrote), and the
    // app-server that would report the hash runs in a container that does not
    // exist yet at install time.
    //
    // So the choice is between writing hooks that are discovered and silently
    // never run, and writing none. None is the honest one: an install that
    // reports success while the agent reports nothing is precisely the failure
    // this feature exists to remove, and `status()` then says "off" for the
    // Docker half, which is true. Returning Ok rather than Err matters as much:
    // `agent_hooks_install` rolls the HOST install back on a Docker error, so
    // refusing here would make codex hooks uninstallable everywhere.
    if agent == "codex" && matches!(target, Target::Docker(_)) {
        log_trust("codex: skipping the Docker half, its hooks cannot be trusted from outside the container");
        return Ok(());
    }
    let hooks = hooks_for(&agent);
    if hooks.is_empty() {
        return Err(format!("hooks are not supported for {agent} yet"));
    }
    let settings = settings_path(target)?;
    let dir = script_dir(target)?;

    // A plugin file is written WHOLE, and it is not JSON: it is the module
    // itself. It must never reach the parse below, which refused every
    // UPGRADE of an opencode or pi install (the file exists, is JS/TS, fails
    // to parse as JSON) while a first install sailed through (no file yet).
    // So those two agents sat on whatever schema they were first installed
    // with: measured, opencode at v9 and pi at v11 while every other agent had
    // synced to v12, and opencode never got its context code at all.
    if schema_for(&agent) == Schema::PluginFile {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        std::fs::create_dir_all(settings.parent().ok_or("no plugin dir")?)
            .map_err(|e| format!("create plugin dir: {e}"))?;
        write_atomic(&settings, plugin_body(&agent).as_bytes())?;
        let config = config_dir(target)?;
        for (rel, body) in plugin_companions(&agent) {
            // `write_atomic` creates the parent, which for opencode 2 is the
            // plugin DIRECTORY itself.
            write_atomic(&config.join(rel), body.as_bytes())?;
        }
        let manifest = Manifest {
            schema_version: SCHEMA_VERSION,
            command: settings.to_string_lossy().into_owned(),
            installed_at: chrono::Utc::now().to_rfc3339(),
        };
        return write_atomic(
            &dir.join(MANIFEST_NAME),
            serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes(),
        );
    }

    // Refuse rather than clobber a config we could not parse.
    let root = read_settings(&settings)?;
    if disable_all_hooks(&root) {
        return Err(
            "disableAllHooks is set in this config, so a hook would never run. \
             Clear it first."
                .into(),
        );
    }

    // Back the original up once, before the first write, so a botched merge is
    // recoverable and removal can restore byte-for-byte.
    let backup = dir.join(BACKUP_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    if !backup.exists() && settings.exists() {
        std::fs::copy(&settings, &backup).map_err(|e| format!("back up the config: {e}"))?;
    }

    let mut commands: Vec<(&str, String, Signal)> = Vec::new();
    for (event, sig) in hooks {
        let script = script_for(&dir, *sig);
        write_atomic(&script, script_body(&agent, *sig).as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod hook script: {e}"))?;
        }
        commands.push((event, command_for(target, *sig)?, *sig));
    }

    let prefix = command_prefix(target)?;
    let merged = match schema_for(&agent) {
        Schema::ClaudeCompatible => {
            let mut acc = without_retired_events(&root, &prefix, hooks);
            for (event, command, sig) in &commands {
                acc = merge(&acc, command, &prefix, event, sig.status_message());
            }
            // The usage status line (GH #277). claude ONLY: it is the one agent
            // that pipes rate limits into a statusLine command, and grok, which
            // shares this schema, has no such slot to write into.
            //
            // Written unconditionally, merged conditionally. The script is
            // cheap and harmless to have on disk, and writing it even when the
            // slot is taken means a user who later clears their own status line
            // gets the feature on the next sync without a reinstall.
            if agent == "claude" {
                let script = dir.join(format!("{USAGE_STEM}.sh"));
                write_atomic(&script, statusline_body().as_bytes())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                        .map_err(|e| format!("chmod status line: {e}"))?;
                }
                acc = merge_statusline(&acc, &format!("{prefix}{USAGE_STEM}.sh"), &prefix);
            }
            acc
        }
        Schema::AntigravityNamed => agy_merge(&root, &commands),
        Schema::CopilotFile => copilot_hooks_file(&commands),
        // Handled by the early return above: the plugin is one file we write
        // whole, so there is no config to inspect or merge. Spelled out rather
        // than a catch-all so a NEW schema still fails to compile here.
        Schema::PluginFile => unreachable!("opencode returns before this"),
    };
    if let Some(parent) = settings.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut bytes = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_atomic(&settings, &bytes)?;

    // The status line slot of an agent that keeps it OUTSIDE the hooks file.
    // Best effort: a slot we cannot claim costs the footer its context number
    // and nothing else, so it never fails the hook install it rides on.
    if let Some(slot) = config_slot(&agent) {
        let claimed = install_config_slot(target, &agent, &dir, &prefix, slot);
        match (slot, claimed) {
            (_, Ok(())) => {}
            // muse's slot is the TRANSPORT, not an extra: without it every
            // hook fires with a stripped env and writes nothing. Fail loudly.
            (ConfigSlot::MuseManaged, Err(e)) => return Err(e),
            (_, Err(e)) => crate::dlog(&format!("[agent-hooks] {agent}: slot not claimed: {e}")),
        }
    }

    // codex only, and it is not optional: its hooks are discovered, reported
    // `enabled: true`, and then NOT RUN until they are trusted. Everything
    // above would leave a hook that fires nothing and says nothing about why.
    // Deliberately AFTER the write, because the hash codex reports covers the
    // hook as written. See codex_trust.rs.
    if agent == "codex" {
        trust_codex_hooks(target, &settings, &prefix)?;
    }

    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        command: commands.first().map(|(_, c, _)| c.clone()).unwrap_or_default(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    write_atomic(
        &dir.join(MANIFEST_NAME),
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
}

pub fn remove(target: &Target) -> Result<(), String> {
    // The BASE: what this agent behaves as. Paths still come from the target,
    // which carries the instance id, so a clone writes into its own config dir.
    let agent = base_of(target.agent());
    let settings = settings_path(target)?;
    let dir = script_dir(target)?;
    let prefix = command_prefix(target)?;

    // Drop codex's trust entries FIRST, and never fail the uninstall over them.
    // They name a file that is about to stop containing our hooks, so leaving
    // them behind is dead config pointing at nothing; but a user who removes
    // hooks wants them gone, and refusing that because a config.toml could not
    // be parsed would trap them. No codex call is needed here (the key begins
    // with the hooks path), so the only way this fails is an unreadable config,
    // which is the user's to fix and ours to leave alone.
    if agent == "codex" {
        if let Err(e) = untrust_codex_hooks(target, &settings) {
            log_trust(&format!("codex untrust skipped: {e}"));
        }
    }

    // Deleting a file we wrote whole. Nothing to unmerge.
    if schema_for(&agent) == Schema::PluginFile {
        if settings.exists() {
            std::fs::remove_file(&settings)
                .map_err(|e| format!("remove {}: {e}", settings.display()))?;
        }
        let config = config_dir(target)?;
        for (rel, _) in plugin_companions(&agent) {
            let file = config.join(rel);
            if file.exists() {
                std::fs::remove_file(&file).map_err(|e| format!("remove {}: {e}", file.display()))?;
            }
            // The directory opencode 2 discovers the plugin BY. `remove_dir`
            // only takes an empty one, so anything a user put beside ours stays.
            if let Some(parent) = file.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
        }
        return Ok(());
    }

    let root = read_settings(&settings)?;
    let stripped = match schema_for(&agent) {
        Schema::ClaudeCompatible => {
            let mut acc = root.clone();
            let mut touched = false;
            for (event, _) in hooks_for(&agent) {
                if let Some(next) = unmerge(&acc, &prefix, event) {
                    acc = next;
                    touched = true;
                }
            }
            // Hand the statusLine slot back, but only if it is still ours. A
            // user who replaced it with their own since the install keeps
            // theirs: `unmerge_statusline` matches on our command prefix, the
            // same ownership test the install used to claim it.
            if let Some(next) = unmerge_statusline(&acc, &prefix) {
                acc = next;
                touched = true;
            }
            if touched { Some(acc) } else { None }
        }
        Schema::AntigravityNamed => agy_unmerge(&root),
        Schema::CopilotFile => {
            // Ours outright: every entry in it is ours, so the file goes.
            if settings.exists() {
                std::fs::remove_file(&settings)
                    .map_err(|e| format!("remove {}: {e}", settings.display()))?;
            }
            None
        }
        // Handled by the early return above: the plugin is one file we write
        // whole, so there is no config to inspect or merge. Spelled out rather
        // than a catch-all so a NEW schema still fails to compile here.
        Schema::PluginFile => unreachable!("opencode returns before this"),
    };
    if let Some(slot) = config_slot(&agent) {
        if let Err(e) = remove_config_slot(target, &prefix, slot) {
            crate::dlog(&format!("[agent-hooks] {agent}: slot not handed back: {e}"));
        }
    }

    if let Some(stripped) = stripped {
        // If what remains matches the pre-install backup, restore the backup's
        // BYTES: that is the only way "removal leaves the file byte-identical"
        // survives our own pretty-printer reformatting the user's spacing.
        let backup = dir.join(BACKUP_NAME);
        let restored = std::fs::read(&backup).ok().filter(|b| {
            serde_json::from_slice::<Value>(b).is_ok_and(|orig| orig == stripped)
        });
        match restored {
            Some(bytes) => write_atomic(&settings, &bytes)?,
            None => {
                let mut bytes = serde_json::to_vec_pretty(&stripped).map_err(|e| e.to_string())?;
                bytes.push(b'\n');
                write_atomic(&settings, &bytes)?;
            }
        }
    }
    // Remove our directory whether or not the config entry was there: a user
    // who hand-deleted the entry still wants the scripts gone. grok's config is
    // a file we own outright, so that goes too.
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    if settings_rel(&agent).starts_with("hooks/") && settings.exists() {
        std::fs::remove_file(&settings).map_err(|e| format!("remove {}: {e}", settings.display()))?;
    }
    Ok(())
}

// ─────────────────────────── Commands ──────────────────────────────────

/// Agents this build can wire. Phase 1 is claude alone; the UI reads this so a
/// row can say "not supported yet" rather than offering a button that fails.
/// Agents this build can wire. Each needs a measured event AND a transport
/// that reaches termic; see `event_for` / `uses_terminal_sequence`.
pub const SUPPORTED: &[&str] = &["claude", "grok", "agy", "opencode", "codex", "devin", "pi", "omp", "copilot", "muse"];

/// Which agents' hooks work on this OS. Windows: claude only. Its hooks run
/// through Git Bash, which the `.sh` scripts need, and reach the app
/// through the named pipe + `termic hook-emit` (hook_pipe.rs). Which shell
/// the other agents run hooks in on Windows is unmeasured
/// (docs/ideas/windows.md, M3), and a `.sh` path under cmd does nothing.
fn hooks_work_for(base: &str) -> bool {
    !cfg!(windows) || base == "claude"
}

fn check_supported(agent_id: &str) -> Result<(), String> {
    if !hooks_work_for(&base_of(agent_id)) {
        return Err(format!("hooks for {agent_id} are not available on Windows yet"));
    }
    // A duplicated agent is supported when what it was cloned FROM is. It runs
    // the same binary and reads the same config shape, and the only reason it
    // was rejected before is that this list holds built-in names.
    let base = base_of(agent_id);
    if SUPPORTED.contains(&base.as_str()) {
        Ok(())
    } else {
        Err(format!("hooks are not supported for {agent_id} yet"))
    }
}

/// Per-agent status across BOTH targets. One toggle governs the pair, so the UI
/// needs to see both to render a single honest row.
#[derive(Debug, Clone, Serialize)]
pub struct AgentHookStatus {
    pub agent_id: String,
    pub supported: bool,
    pub host: HookStatus,
    pub docker: HookStatus,
}

/// Everything an install would write, for an audience that will read it.
/// These users run coding agents for a living: the honest thing is to show the
/// exact files and the exact script contents BEFORE touching anything, not a
/// reassuring sentence.
#[derive(Debug, Clone, Serialize)]
pub struct HookPlanEntry {
    /// The agent's own event name, e.g. `PermissionRequest`.
    pub event: String,
    /// What termic learns from it: attention, working or done.
    pub reports: String,
    /// Absolute path of the script this event runs.
    pub script_path: String,
    /// The script, verbatim. Short by design, precisely so it can be read.
    pub script_body: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HookPlan {
    pub agent_id: String,
    pub supported: bool,
    /// The config file termic edits, and whether it is shared with the user's
    /// own settings or a file termic owns outright.
    pub config_path: String,
    pub config_is_shared: bool,
    /// The exact JSON fragment merged into that config.
    pub config_fragment: String,
    pub entries: Vec<HookPlanEntry>,
    /// Anything else the install changes about how the agent runs.
    pub notes: Vec<String>,
}

#[tauri::command]
pub fn agent_hooks_plan(agent_id: String) -> Result<HookPlan, String> {
    let target = Target::Host(agent_id.clone());
    // The BASE decides the SHAPE (which events, which schema, which config
    // file); paths still come from the target, which carries the instance id.
    // `install` has always resolved it this way, and the preview did not, so a
    // clone was shown an empty plan and then given a working install. Every
    // lookup below that asks "what is this agent" takes the base for that
    // reason. See `docker.rs` on why conflating the two breaks clones.
    let base = base_of(&agent_id);
    let hooks = hooks_for(&base);
    let prefix = command_prefix(&target).unwrap_or_default();
    let entries: Vec<HookPlanEntry> = hooks
        .iter()
        .map(|(event, sig)| HookPlanEntry {
            event: (*event).to_string(),
            reports: sig.stem().to_string(),
            script_path: format!("{prefix}{}.sh", sig.stem()),
            script_body: script_body(&base, *sig),
        })
        .collect();

    // Both names are the agent's own user-level settings file, which termic
    // merges into rather than owns outright.
    let shared = matches!(settings_rel(&base), "settings.json" | "config.json");
    let fragment = if hooks.is_empty() {
        String::new()
    } else {
        let commands: Vec<(&str, String, Signal)> = hooks
            .iter()
            .map(|(e, s)| (*e, format!("{prefix}{}.sh", s.stem()), *s))
            .collect();
        let merged = match schema_for(&base) {
            Schema::AntigravityNamed => agy_merge(&Value::Object(Map::new()), &commands),
            Schema::PluginFile => Value::String("(a JS plugin file, shown below)".into()),
            Schema::CopilotFile => copilot_hooks_file(&commands),
            Schema::ClaudeCompatible => {
                let mut acc = Value::Object(Map::new());
                for (event, command, sig) in &commands {
                    acc = merge(&acc, command, &prefix, event, sig.status_message());
                }
                // Mirror what `install` actually writes, statusLine included.
                // A preview that omitted it would show the user a fragment
                // smaller than the change they are approving, and this is the
                // one key in that fragment that is not termic's to take.
                if base == "claude" {
                    acc = merge_statusline(&acc, &format!("{prefix}{USAGE_STEM}.sh"), &prefix);
                }
                acc
            }
        };
        serde_json::to_string_pretty(&merged).unwrap_or_default()
    };

    let mut notes = Vec::new();
    if base == "claude" {
        notes.push(
            "Also installs a status line that reports how much of your plan \
             limits you have used, and how full the context window is, for the \
             task footer. It prints nothing, so the agent looks unchanged. If you \
             already have your own status line, yours is kept and neither is shown."
                .into(),
        );
    }
    match config_slot(&base) {
        Some(ConfigSlot::Json { rel, .. }) => notes.push(format!(
            "Also sets the status line in {rel}, which reports {} for the task footer. \
             It prints nothing, so the agent looks unchanged. If you already have your \
             own status line, yours is kept and nothing is shown.",
            if base == "agy" { "your plan quota and the context window" } else { "the context window" },
        )),
        Some(ConfigSlot::GrokToml) => notes.push(
            "Also sets [ui.status_line] in config.toml to a script that reports the \
             context window for the task footer. It prints nothing, and grok hides an \
             empty row. If you already use a status line (built-in or your own), it is \
             kept and no context is shown."
                .into(),
        ),
        Some(ConfigSlot::MuseManaged) => notes.push(
            "muse strips the environment it gives ordinary hooks, so these are \
             registered as MANAGED hooks: settings.json gets managed_hooks_path \
             pointing at termic's file, and managed_hooks_env_vars naming \
             TERMIC_PTY and TERMIC_TASK_ID, the only two variables muse is asked to \
             pass through. If managed_hooks_path already names another file, \
             nothing is changed and the install fails."
                .into(),
        ),
        None => {}
    }
    if !hooks.is_empty() {
        notes.push(
            "Each script writes one OSC sequence to this terminal and exits 0. \
             No network, no file writes, no arguments."
                .into(),
        );
        notes.push(
            "They stay silent unless TERMIC_TASK_ID is set, so the same files do \
             nothing when you run the agent in another terminal."
                .into(),
        );
    }
    if shared && !hooks.is_empty() {
        notes.push(
            "This file is yours and may already contain your own hooks. termic \
             appends one entry per event and removes only those, and it keeps a \
             backup taken before the first install."
                .into(),
        );
    }
    if agent_id == "claude" {
        notes.push(
            "grok also reads ~/.claude/settings.json. The scripts detect that and \
             stay silent, and termic additionally sets GROK_CLAUDE_HOOKS_ENABLED=false \
             for grok tabs it launches."
                .into(),
        );
    }
    if base == "opencode" {
        notes.push(format!(
            "Also writes {OPENCODE_TUI_REL}, the part opencode 2 runs. opencode 2 \
             runs ordinary plugins in one background service shared by every \
             opencode on this computer, which cannot tell which terminal is this \
             task's, so its reporting runs in opencode's terminal UI instead. \
             opencode 1 does not load that folder."
        ));
    }
    if agent_id == "grok" {
        notes.push(
            "grok tabs launched by termic also get GROK_CLAUDE_HOOKS_ENABLED=false, \
             so grok stops reading claude's hook config and no event fires twice."
                .into(),
        );
    }
    Ok(HookPlan {
        supported: SUPPORTED.contains(&agent_id.as_str()),
        config_path: settings_path(&target).map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        config_is_shared: shared,
        config_fragment: fragment,
        entries,
        notes,
        agent_id,
    })
}

#[tauri::command]
pub fn agent_hooks_status(agent_id: String) -> AgentHookStatus {
    AgentHookStatus {
        supported: hooks_work_for(&base_of(&agent_id)) && SUPPORTED.contains(&base_of(&agent_id).as_str()),
        host: status(&Target::Host(agent_id.clone())),
        docker: status(&Target::Docker(agent_id.clone())),
        agent_id,
    }
}

/// What sync knows about one target when it decides whether to write.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SyncCheck {
    pub is_docker: bool,
    /// Does the same agent have hooks on the HOST? Only meaningful for a
    /// Docker target, where it stands in for "the user asked for hooks here".
    pub host_installed: bool,
    pub ours_present: bool,
    pub stale: bool,
    pub has_error: bool,
    pub disabled_all: bool,
}

/// Should `agent_hooks_sync` write to this target?
///
/// Extracted because the rule has two halves that pull opposite ways and the
/// function around it reads real config directories, so this is the only part
/// that can be tested.
pub(crate) fn should_sync(c: SyncCheck) -> bool {
    if c.has_error {
        return false;
    }
    // A Docker target with NOTHING gets a first install, provided the user has
    // hooks on the host for the same agent.
    //
    // Sync otherwise only ever UPGRADES, so a Docker install that was never
    // made, or that was lost when its config dir was cleared, stayed missing
    // forever and in silence: the container's agent ran with no hooks and no
    // status line, so a sandboxed task reported no work state and no plan
    // usage while the same agent on the host reported both, with nothing on
    // screen saying why.
    //
    // Safe to do unasked, unlike the host: the Docker config dir is
    // termic-owned (see this file's header), so there is no user
    // configuration here to merge with or clobber.
    if c.is_docker && c.host_installed && !c.ours_present {
        return true;
    }
    // `ours_present`, not `installed`: see its doc comment. Gating an upgrade
    // on the CURRENT set already being complete means an upgrade can never add
    // an event, which is most of what an upgrade is for.
    c.ours_present && c.stale && !c.disabled_all
}

/// Bring every ALREADY-INSTALLED agent's hooks up to this build's set.
///
/// The user's consent is "hooks on for this agent", not "these exact three
/// scripts". Asking them to notice a version number and press a button to get a
/// fix is asking them to do our job, and it fails silently: an install from an
/// older termic keeps looking installed while reporting less than it could. The
/// heartbeat that stops a cleared spinner staying gone shipped this way, and
/// every existing install would have missed it.
///
/// Only touches agents that are already installed on the HOST, so it never
/// introduces hooks for an agent the user declined, and it re-runs `install`,
/// which preserves the pre-install backup (`if !backup.exists()`), so clean
/// removal survives. The one thing it CREATES rather than upgrades is a
/// missing DOCKER install for an agent whose host hooks exist; see
/// `should_sync` for why that is the user's decision already.
/// Refuses the same cases install refuses: an unreadable config or
/// `disableAllHooks` is left exactly as found.
///
/// Returns the agent ids it updated, so a caller can say what happened.
///
/// `async` so it runs OFF the main thread: an install (upgrade or "install all
/// hooks") can spawn `codex app-server` for its trust hashes, and a sync
/// command doing that freezes the window (docs/ipc.md).
#[tauri::command(async)]
pub fn agent_hooks_sync() -> Vec<String> {
    let mut updated = Vec::new();
    // Every agent in the registry, not just the built-in names: a clone is
    // exactly as entitled to a working set of hooks as what it was copied from,
    // and it is the clone whose config dir may have moved.
    let ids: Vec<String> = crate::load_settings_inner()
        .agents
        .iter()
        .map(|a| a.id.clone())
        .collect();
    for agent in &ids {
        // Whether the user has hooks for this agent AT ALL, which is what
        // makes seeding the Docker side below their decision rather than ours.
        let host_installed = status(&Target::Host(agent.clone())).ours_present;
        for target in [
            Target::Host(agent.clone()),
            Target::Docker(agent.clone()),
        ] {
            let st = status(&target);
            if !should_sync(SyncCheck {
                is_docker: matches!(target, Target::Docker(_)),
                host_installed,
                ours_present: st.ours_present,
                stale: st.stale,
                has_error: st.error.is_some(),
                disabled_all: st.disabled_all,
            }) {
                continue;
            }
            if install(&target).is_ok() && matches!(target, Target::Host(_)) {
                updated.push(agent.clone());
            }
        }
    }
    // "Install all hooks" (`Settings.auto_install_hooks`): every supported
    // agent that is on PATH and has none gets them, host and Docker, the same
    // way the Settings button installs one. An agent whose config cannot be
    // read or has `disableAllHooks` set is left alone, exactly as a manual
    // install would refuse it. Runs after the upgrade pass above, so an agent
    // that was just upgraded is not installed twice.
    if crate::load_settings_inner().auto_install_hooks {
        let agents = crate::load_settings_inner().agents;
        for agent in &ids {
            if check_supported(agent).is_err() || updated.contains(agent) {
                continue;
            }
            let st = status(&Target::Host(agent.clone()));
            if st.ours_present || st.error.is_some() || st.disabled_all {
                continue;
            }
            if !crate::agent_binary_on_path(&agents, agent) {
                continue;
            }
            match agent_hooks_install(agent.clone()) {
                Ok(_) => updated.push(agent.clone()),
                Err(e) => crate::dlog(&format!("[agent-hooks] auto-install {agent} skipped: {e}")),
            }
        }
    }
    updated
}

/// Is "install all hooks" on?
#[tauri::command]
pub fn agent_hooks_auto_get() -> bool {
    crate::load_settings_inner().auto_install_hooks
}

/// Turn "install all hooks" on or off. Turning it on installs right away and
/// returns the agents it wired; turning it off installs and removes nothing
/// (what is in stays in, and each row's own button is how to take one out).
/// Async and off the main thread: an install can spawn `codex app-server` to
/// learn its trust hashes, which is a cold process start.
#[tauri::command]
pub async fn agent_hooks_auto_set(on: bool) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = crate::load_settings_inner();
        if s.auto_install_hooks != on {
            s.auto_install_hooks = on;
            crate::save_settings_inner(&s)?;
        }
        Ok(if on { agent_hooks_sync() } else { Vec::new() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Install for one agent, covering host AND its Docker config dir. Docker needs
/// no separate consent (termic owns that dir) but must never be installed for an
/// agent the user declined, which is why it rides this one call.
#[tauri::command]
pub fn agent_hooks_install(agent_id: String) -> Result<AgentHookStatus, String> {
    check_supported(&agent_id)?;
    install(&Target::Host(agent_id.clone()))?;
    // A Docker failure must not leave the host half installed and the UI lying,
    // so roll the host back and report the real error.
    if let Err(e) = install(&Target::Docker(agent_id.clone())) {
        let _ = remove(&Target::Host(agent_id.clone()));
        return Err(format!("installed for the host but not for Docker, so nothing was kept: {e}"));
    }
    Ok(agent_hooks_status(agent_id))
}

/// Remove for one agent, both targets. Deliberately NOT gated on `SUPPORTED`:
/// a user who downgrades termic, or who had a since-dropped agent wired, must
/// still be able to clean up.
#[tauri::command]
pub fn agent_hooks_remove(agent_id: String) -> Result<AgentHookStatus, String> {
    let host = remove(&Target::Host(agent_id.clone()));
    let docker = remove(&Target::Docker(agent_id.clone()));
    host.and(docker)?;
    Ok(agent_hooks_status(agent_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "/home/u/.claude/termic-hooks/";
    const C: &str = "/home/u/.claude/termic-hooks/attention.sh";
    /// The tests below all exercise the claude shape. grok's differs only in
    /// which event key it writes under, which `grok_writes_its_own_event` pins.
    const EVENT: &str = "PermissionRequest";
    /// The real message for `EVENT`'s signal, so the merge tests carry what
    /// actually ships rather than a placeholder.
    const SM: &str = "termic: reporting that you are needed";

    fn ours_count(v: &Value) -> usize {
        v.get("hooks")
            .and_then(|h| h.get(EVENT))
            .and_then(Value::as_array)
            .map(|groups| {
                groups
                    .iter()
                    .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                    .flatten()
                    .filter(|e| is_ours(e, P))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn installs_into_an_empty_config() {
        let out = merge(&serde_json::json!({}), C, P, EVENT, SM);
        assert_eq!(ours_count(&out), 1);
        let entry = &out["hooks"][EVENT][0]["hooks"][0];
        assert_eq!(entry["type"], "command");
        assert_eq!(entry["command"], C);
        // Never a control field: we observe, we do not gate.
        assert!(entry.get("decision").is_none());
        assert!(entry.get("async").is_none());
    }

    #[test]
    fn users_own_hooks_survive_verbatim() {
        let before = serde_json::json!({
            "model": "opus",
            "hooks": {
                "PermissionRequest": [
                    { "hooks": [{ "type": "command", "command": "/usr/local/bin/audit" }] }
                ],
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "/usr/local/bin/done" }] }
                ]
            }
        });
        let after = merge(&before, C, P, EVENT, SM);
        assert_eq!(after["model"], "opus", "unknown top-level keys preserved");
        assert_eq!(after["hooks"]["Stop"], before["hooks"]["Stop"], "other events untouched");
        assert_eq!(
            after["hooks"][EVENT][0], before["hooks"][EVENT][0],
            "the user's own entry for OUR event is untouched"
        );
        assert_eq!(ours_count(&after), 1);
    }

    #[test]
fn an_install_missing_a_newly_added_event_is_still_ours() {
        // The regression that broke the upgrade the first time an event was
        // added. `installed` is an ALL over today's set, so a config written
        // before `SessionStart` existed fails it - and sync skipping anything
        // not installed meant the agent the new event was FOR was the one
        // agent that never got it. Consent is `ours_present`, and that is what
        // sync gates on.
        let mut cfg = serde_json::json!({});
        for ev in ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"] {
            cfg = merge(&cfg, &format!("{P}{ev}.sh"), P, ev, SM);
        }
        let hooks = hooks_for("claude");
        let has = |root: &Value, event: &str| {
            root.get("hooks").and_then(|h| h.get(event)).and_then(Value::as_array)
                .is_some_and(|groups| groups.iter().any(|g| {
                    g.get("hooks").and_then(Value::as_array)
                        .is_some_and(|l| l.iter().any(|e| is_ours(e, P)))
                }))
        };
        // Exactly the shape `status` computes, without needing a real HOME.
        let installed = hooks.iter().all(|(e, _)| has(&cfg, e));
        let ours_present = hooks.iter().any(|(e, _)| has(&cfg, e));
        assert!(!installed, "a v3 config should NOT satisfy the v4 set");
        assert!(ours_present, "a v3 config is still ours, and still needs upgrading");
    }

    #[test]
    fn an_upgrade_strips_our_entry_from_a_retired_event_and_keeps_the_users() {
        let mut cfg = serde_json::json!({});
        for ev in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"] {
            cfg = merge(&cfg, &format!("{P}{ev}.sh"), P, ev, SM);
        }
        cfg = merge(&cfg, "/Users/u/bin/my-hook.sh", "/Users/u/bin/", "PermissionRequest", "");
        let after = without_retired_events(&cfg, P, hooks_for("codex"));
        let perm = after["hooks"]["PermissionRequest"].to_string();
        assert!(!perm.contains(P), "our PermissionRequest entry survived: {perm}");
        assert!(perm.contains("my-hook.sh"), "the user's own hook was removed: {perm}");
        for (ev, _) in hooks_for("codex") {
            assert_eq!(after["hooks"][ev], cfg["hooks"][ev], "{ev} was disturbed");
        }
        // Nothing of ours retired: untouched.
        assert_eq!(without_retired_events(&after, P, hooks_for("codex")), after);
    }

    #[test]
fn a_v3_config_gains_the_readiness_event_without_losing_the_others() {
        // What the self-upgrade actually has to do. A config written by the
        // build before Ready already carries our four entries; syncing must
        // ADD SessionStart and leave the rest byte-identical, not rewrite the
        // file wholesale and not append a second copy of anything.
        let mut cfg = serde_json::json!({});
        let v3 = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"];
        for ev in v3 {
            cfg = merge(&cfg, &format!("{P}{ev}.sh"), P, ev, SM);
        }
        let before = cfg.clone();
        // The sync: re-run install for the CURRENT set, which now includes
        // the readiness event.
        let mut after = cfg;
        for (ev, _sig) in hooks_for("claude") {
            after = merge(&after, &format!("{P}{ev}.sh"), P, ev, SM);
        }
        assert!(after["hooks"]["SessionStart"].is_array(), "readiness event not added");
        for ev in v3 {
            assert_eq!(after["hooks"][ev], before["hooks"][ev], "{ev} was disturbed by the upgrade");
        }
        // Re-running it changes nothing: sync runs on every launch.
        let mut again = after.clone();
        for (ev, _sig) in hooks_for("claude") {
            again = merge(&again, &format!("{P}{ev}.sh"), P, ev, SM);
        }
        assert_eq!(again, after, "sync is not idempotent, so every launch rewrites the config");
    }

    #[test]
        fn install_is_idempotent() {
        let once = merge(&serde_json::json!({}), C, P, EVENT, SM);
        let twice = merge(&once, C, P, EVENT, SM);
        assert_eq!(ours_count(&twice), 1, "no duplicate entry");
        assert_eq!(once, twice);
    }

    #[test]
    fn an_older_entry_of_ours_is_replaced_not_appended() {
        let stale = serde_json::json!({
            "hooks": { EVENT: [
                { "hooks": [{ "type": "command", "command": format!("{P}old-name.sh"), "timeout": 1 }] }
            ]}
        });
        let out = merge(&stale, C, P, EVENT, SM);
        assert_eq!(ours_count(&out), 1);
        assert_eq!(out["hooks"][EVENT][0]["hooks"][0]["command"], C);
    }

    #[test]
    fn removal_restores_the_original_value() {
        let before = serde_json::json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "/x" }] }] }
        });
        let after = merge(&before, C, P, EVENT, SM);
        let back = unmerge(&after, P, EVENT).expect("something of ours to remove");
        assert_eq!(back, before, "byte-identical after a round trip");
    }

    #[test]
    fn removal_from_a_config_that_was_empty_leaves_it_empty() {
        let after = merge(&serde_json::json!({}), C, P, EVENT, SM);
        let back = unmerge(&after, P, EVENT).unwrap();
        assert_eq!(back, serde_json::json!({}), "our own hooks key is cleaned up");
    }

    #[test]
    fn removal_is_a_noop_when_nothing_is_ours() {
        let theirs = serde_json::json!({
            "hooks": { EVENT: [{ "hooks": [{ "type": "command", "command": "/usr/local/bin/audit" }] }] }
        });
        assert!(unmerge(&theirs, P, EVENT).is_none(), "left completely alone");
    }

    #[test]
    fn a_user_edited_entry_of_ours_is_still_matched_by_path() {
        // They changed the timeout and the status message but not the path.
        let edited = serde_json::json!({
            "hooks": { EVENT: [
                { "hooks": [{ "type": "command", "command": C, "timeout": 99, "note": "mine now" }] }
            ]}
        });
        assert_eq!(unmerge(&edited, P, EVENT).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn a_user_entry_sharing_our_group_survives_removal() {
        let mixed = serde_json::json!({
            "hooks": { EVENT: [
                { "hooks": [
                    { "type": "command", "command": C },
                    { "type": "command", "command": "/usr/local/bin/audit" }
                ]}
            ]}
        });
        let back = unmerge(&mixed, P, EVENT).unwrap();
        assert_eq!(ours_count(&back), 0);
        assert_eq!(back["hooks"][EVENT][0]["hooks"][0]["command"], "/usr/local/bin/audit");
    }

    #[test]
    fn a_non_object_root_does_not_panic() {
        let out = merge(&serde_json::json!([1, 2, 3]), C, P, EVENT, SM);
        assert_eq!(ours_count(&out), 1);
    }

    #[test]
    fn disable_all_hooks_is_detected() {
        assert!(disable_all_hooks(&serde_json::json!({ "disableAllHooks": true })));
        assert!(!disable_all_hooks(&serde_json::json!({ "disableAllHooks": false })));
        assert!(!disable_all_hooks(&serde_json::json!({})));
    }

    #[test]
    fn docker_writes_the_container_path_not_the_host_path() {
        let host = command_prefix(&Target::Host("claude".into())).unwrap();
        let docker = command_prefix(&Target::Docker("claude".into())).unwrap();
        assert!(docker.starts_with(crate::docker::CONTAINER_HOME), "{docker}");
        assert!(docker.ends_with("termic-hooks/"));
        assert_ne!(host, docker, "a host path would not resolve inside the cage");
        // The host FILE still lands in the termic-owned docker-agents dir.
        let dir = config_dir(&Target::Docker("claude".into())).unwrap();
        assert!(dir.to_string_lossy().contains("docker-agents"), "{dir:?}");
    }

    #[test]
    fn a_cloned_agent_gets_its_own_directory() {
        let a = config_dir(&Target::Docker("claude".into())).unwrap();
        let b = config_dir(&Target::Docker("claude-review".into())).unwrap();
        assert_ne!(a, b, "clones keep their own login state");
        // ...but both write claude's container path, because the SHAPE is claude's.
        assert_eq!(
            command_prefix(&Target::Docker("claude".into())).unwrap(),
            command_prefix(&Target::Docker("claude-review".into())).unwrap()
        );
    }

    #[test]
    fn the_script_gates_on_both_env_vars_and_always_exits_zero() {
        let s = script_body("claude", Signal::Attention);
        assert!(s.starts_with("#!/bin/sh\n"));
        assert!(s.contains(r#"[ -n "$TERMIC_TASK_ID" ] || exit 0"#));
        assert!(s.contains(r#"[ -z "$GROK_HOOK_EVENT" ] || exit 0"#));
        assert!(s.contains("exit 0\n"));
        // Never raw control bytes in a generated file, whichever form it takes.
        assert!(s.contains("]777;notify;termic;"));
        assert!(!s.contains('\u{1b}'), "no raw ESC in the generated file");
        assert!(!s.contains('\u{7}'), "no raw BEL in the generated file");
        // The body must not match BUILTIN_NOTIFY_IGNORE.claude or the
        // notification is filtered out and the feature dies silently.
        assert!(!s.contains("is waiting for your input"));
    }

    // ── grok ────────────────────────────────────────────────────────
    // grok is the second agent, and almost every difference from claude is
    // load-bearing rather than cosmetic.

    #[test]
    fn grok_writes_its_own_event_and_its_own_file() {
        // grok has NO PermissionRequest. Its attention edge is Notification
        // with notificationType=permission_prompt, measured.
        // Attention is the edge each of these two exists for.
        assert!(hooks_for("grok").contains(&("Notification", Signal::Attention)));
        assert!(hooks_for("claude").contains(&("PermissionRequest", Signal::Attention)));
        // grok scans every *.json under hooks/, so it gets a file of its own:
        // removal is then a delete rather than a merge-back into a file the
        // user also owns.
        assert_eq!(settings_rel("grok"), "hooks/termic.json");
        assert_eq!(settings_rel("claude"), "settings.json");
    }

    /// The chain has to survive a target that does not exist, which is exactly
    /// the Docker case: `$TERMIC_PTY` names a host device the container has no
    /// entry for, so the first redirection fails and the next must be tried.
    #[test]
    fn a_dead_first_target_falls_through_to_the_next() {
        let body = script_body("claude", Signal::Working);
        // `||` chaining on redirection failure, NOT a readiness test:
        // `[ -w /dev/tty ]` is true in places where opening it fails, so
        // attempting the write is the only honest test.
        assert!(body.contains("emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty"),
                "targets must chain on failure:\n{body}");
        assert!(!body.contains("[ -w"), "a readiness test would lie about /dev/tty");
        // Still gated: an agent termic did not spawn writes nothing at all,
        // wherever it is running.
        assert!(body.contains("[ -n \"$TERMIC_PTY\" ] || exit 0"));
        assert!(body.contains("[ -n \"$TERMIC_TASK_ID\" ] || exit 0"));
    }

    #[test]
    fn grok_writes_to_the_pty_because_it_has_no_terminal_sequence() {
        // Every agent is on the pty, claude included: its runtime allowlist
        // drops OSC 133, so its own channel cannot carry a hard done.
        let g = script_body("grok", Signal::Attention);
        assert!(g.contains("$TERMIC_PTY"), "grok must write to the injected pty");
        assert!(!g.contains("terminalSequence"), "grok's runtime ignores that field");
        // $TERMIC_PTY is FIRST and the others are fallbacks, which is the whole
        // ordering: a host agent must never route around the pty it was given.
        let pty_at = g.find("$TERMIC_PTY").expect("pty target");
        for later in ["/proc/1/fd/1", "/dev/tty"] {
            assert!(g.find(later).expect(later) > pty_at, "{later} must come after $TERMIC_PTY");
        }
        // This used to assert /dev/tty was absent, on the grounds that hooks run
        // with no controlling terminal (measured on grok, rc=1). Still true, and
        // that is why it is LAST rather than why it is excluded: a failed open
        // costs one syscall. The reason the chain exists at all is Docker, where
        // $TERMIC_PTY is a host path the container cannot see, measured in the
        // real sandbox image as TERMIC_PTY_EXISTS=NO.
        let c = script_body("claude", Signal::Attention);
        assert!(c.contains("$TERMIC_PTY"));
        assert!(!c.contains("terminalSequence"));
    }

    #[test]
    fn the_two_scripts_gate_on_grok_in_opposite_directions() {
        // grok reads ~/.claude/settings.json too, so claude's script must stay
        // silent when grok is the caller or a claude install silently rewires
        // grok. grok's own script wants exactly the opposite test.
        assert!(script_body("claude", Signal::Attention).contains(r#"[ -z "$GROK_HOOK_EVENT" ] || exit 0"#));
        assert!(script_body("grok", Signal::Attention).contains(r#"[ -n "$GROK_HOOK_EVENT" ] || exit 0"#));
        // Both still refuse to speak outside a termic PTY.
        for a in ["claude", "grok"] {
            assert!(script_body(a, Signal::Attention).contains(r#"[ -n "$TERMIC_TASK_ID" ] || exit 0"#));
            assert!(script_body(a, Signal::Attention).trim_end().ends_with("exit 0"));
            assert!(!script_body(a, Signal::Attention).contains('\u{1b}'), "no raw ESC in {a}'s script");
        }
    }

    #[test]
    fn claude_registers_a_readiness_event() {
        // The one signal that is not a correction of something the terminal
        // got wrong, but a state it cannot express at all. Without it the
        // first message is typed on a quiet-terminal guess, and claude's trust
        // picker is quiet with `No, exit` highlighted.
        let set = hooks_for("claude");
        assert!(set.contains(&("SessionStart", Signal::Ready)),
            "claude lost its readiness hook: {set:?}");
        // Only claude: nobody else was measured, and a guessed event name
        // installs a hook that never fires and looks like one that does.
        for agent in ["grok", "agy", "opencode"] {
            assert!(!hooks_for(agent).iter().any(|(_, s)| *s == Signal::Ready),
                "{agent} claims Ready without a measurement behind it");
        }
    }

    #[test]
    fn ready_and_attention_share_an_osc_but_never_a_body() {
        // They are told apart on the TypeScript side by BODY alone
        // (`lib/agentHooks.ts`), so neither may be a prefix of the other or a
        // ready session badges as needing you.
        let ready = Signal::Ready.payload();
        let attn = Signal::Attention.payload();
        let pre = "777;notify;termic;";
        assert!(ready.starts_with(pre) && attn.starts_with(pre));
        let (rb, ab) = (&ready[pre.len()..], &attn[pre.len()..]);
        assert!(!rb.starts_with(ab) && !ab.starts_with(rb), "{rb:?} vs {ab:?} are confusable");
        // Pinned against HOOK_OSC_READY_BODY, which cannot import this. The
        // two constants are the halves of one contract across the boundary.
        assert_eq!(rb, "agent ready for input");
        // Each signal needs its own script filename or one overwrites another.
        let stems = [Signal::Attention, Signal::Working, Signal::Done, Signal::Ready]
            .map(|s| s.stem());
        let mut uniq = stems.to_vec();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), stems.len(), "duplicate script stem: {stems:?}");
        // User-visible in claude's UI while the hook runs, so it has to
        // describe the signal actually being sent.
        assert_ne!(Signal::Ready.status_message(), Signal::Attention.status_message());
    }

    // ── The usage status line (GH #277) ────────────────────────────────

    /// Run the generated status line against a payload and return what it put
    /// on the pty, plus what it printed on STDOUT.
    ///
    /// Same harness as `done_emits_for`, and for the same reason: the whole
    /// thing is shell parameter expansion, and shell is where the bugs are.
    /// Stdout is captured too because "prints nothing" is a load-bearing
    /// property here, not a detail: whatever a status line prints, claude
    /// renders under the user's input box on every turn.
    #[cfg(unix)]
    fn statusline_run(payload: &str) -> (String, String) {
        statusline_run_as("claude", payload)
    }

    #[cfg(unix)]
    fn statusline_run_as(agent: &str, payload: &str) -> (String, String) {
        use std::io::Read;
        use std::process::{Command, Stdio};

        // A UUID, not a TIMESTAMP. Several of these tests run in parallel in
        // one process, and `SystemTime` is not nanosecond-resolution on macOS:
        // two of them landed on the same directory name, and the first to
        // finish deleted the other's pty file mid-read. That is a flake with a
        // symptom nowhere near its cause, in a test that passes alone.
        let dir = std::env::temp_dir()
            .join(format!("termic-statusline-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("usage.sh");
        let pty = dir.join("pty");
        std::fs::write(&script, statusline_body_for(agent)).unwrap();
        std::fs::write(&pty, "").unwrap();

        let mut child = Command::new("/bin/sh")
            .arg(&script)
            .env("TERMIC_TASK_ID", "t1")
            .env("TERMIC_PTY", &pty)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        {
            use std::io::Write as _;
            child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "a status line must never exit non-zero");

        let mut emitted = String::new();
        std::fs::File::open(&pty).unwrap().read_to_string(&mut emitted).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        (emitted, String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The shape claude pipes in. Transcribed from the schema rather than
    /// pasted from a live session (CLAUDE.md on fixtures), with the awkward
    /// parts kept: `used_percentage` arrives as a float with float noise, and
    /// `rate_limits` is the LAST key in the object so its window has no
    /// trailing comma to cut on.
    #[cfg(unix)]
    const STATUSLINE_PAYLOAD: &str = r#"{
      "session_id": "00000000-0000-0000-0000-000000000000",
      "cwd": "/Users/u/work/repo",
      "model": { "display_name": "Opus 5" },
      "context_window": {
        "total_input_tokens": 8123, "total_output_tokens": 311, "context_window_size": 200000,
        "current_usage": { "input_tokens": 3, "cache_creation_input_tokens": 120, "cache_read_input_tokens": 8000 },
        "used_percentage": 4, "remaining_percentage": 96
      },
      "rate_limits": {
        "five_hour": { "used_percentage": 16, "resets_at": 1788530400 },
        "seven_day": { "used_percentage": 14.000000000000002, "resets_at": 1788937200 }
      }
    }"#;

    #[test]
    #[cfg(unix)]
    fn the_status_line_reports_both_windows_and_prints_nothing() {
        let (emitted, stdout) = statusline_run(STATUSLINE_PAYLOAD);
        // Printing NOTHING is the whole reason this slot is usable at all.
        // Measured on 2.1.260: a status line printing a marker puts the marker
        // on screen; one printing an empty string leaves no text.
        assert_eq!(stdout, "", "a status line's stdout is rendered in the TUI");
        assert!(
            emitted.contains(&format!("{NOTIFY_PREFIX}{USAGE_BODY_PREFIX}16 14.000000000000002 1788530400 1788937200")),
            "unexpected body: {emitted:?}"
        );
    }

    /// The context window rides its own body, in claude's real key order: the
    /// two flat numbers come BEFORE the nested `current_usage`, which is why the
    /// script reads them and not `used_percentage`.
    #[test]
    #[cfg(unix)]
    fn the_status_line_reports_the_context_window() {
        let (emitted, stdout) = statusline_run(STATUSLINE_PAYLOAD);
        assert_eq!(stdout, "");
        assert!(
            emitted.contains(&format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}8123 200000")),
            "unexpected body: {emitted:?}"
        );
    }

    /// Context alone is still worth a write: an account whose first payload
    /// carries no limits and no cost yet can already say how full it is. And
    /// zero tokens is a session before its first call, which says nothing.
    #[test]
    #[cfg(unix)]
    fn context_alone_is_reported_and_zero_tokens_is_not() {
        let (emitted, _) = statusline_run(
            r#"{"context_window":{"total_input_tokens":500,"context_window_size":1000000,"current_usage":null}}"#,
        );
        assert_eq!(emitted, format!("\x1b]{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}500 1000000\x07"));
        let (emitted, _) = statusline_run(
            r#"{"context_window":{"total_input_tokens":0,"context_window_size":200000,"current_usage":null}}"#,
        );
        assert_eq!(emitted, "");
    }

    /// copilot on its `auto` model: `context_window_size` and `used_percentage`
    /// are null, the live figures are `current_context_tokens` over
    /// `displayed_context_limit`, and `total_input_tokens` is the whole
    /// SESSION's, which must never be read as the window. Shape measured on
    /// 1.0.86, values placeholders.
    #[test]
    #[cfg(unix)]
    fn copilot_reports_its_live_context_and_never_its_session_total() {
        let payload = r#"{"session_id":"x","model":{"id":"auto"},
          "cost":{"total_premium_requests":1},
          "context_window":{"current_context_tokens":13781,"displayed_context_limit":200000,
            "current_context_used_percentage":7,"context_window_size":null,"used_percentage":null,
            "total_input_tokens":99999,"total_output_tokens":10}}"#;
        let (emitted, stdout) = statusline_run_as("copilot", payload);
        assert_eq!(stdout, "");
        assert_eq!(emitted, format!("\x1b]{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}13781 200000\x07"));
    }

    /// grok: `context_tokens` is the live window (`session_input_tokens` only
    /// grows). It also sends a cost, which is NOT forwarded: that is claude's
    /// field on the usage body, and a grok account is credit-limited.
    #[test]
    #[cfg(unix)]
    fn grok_reports_context_tokens_and_no_cost() {
        let payload = r#"{"schema_version":1,"cost":{"total_cost_usd":0.03},
          "context_window":{"context_window_size":500000,"context_tokens":21000,
            "session_input_tokens":90000,"used_percentage":4}}"#;
        let (emitted, _) = statusline_run_as("grok", payload);
        assert_eq!(emitted, format!("\x1b]{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}21000 500000\x07"));
    }

    /// Every `awk` in the hook body formats under LC_ALL=C.
    ///
    /// awk's printf follows the locale, so "%.2f" is "1,60" on a
    /// comma-decimal machine (ro_RO, de_DE, fr_FR...). The usage body is
    /// parsed as a bare dotted number (lib/agentUsage `parseUsageBody`), so
    /// such a reading is dropped and the footer shows nothing, for the user
    /// and never for CI, which runs on C. Source-level because the locales
    /// needed to reproduce it are not installed on a runner.
    #[test]
    fn every_awk_in_the_hook_body_is_locale_pinned() {
        for agent in ["claude", "agy", "codex", "grok"] {
            let body = statusline_body_for(agent);
            for line in body.lines() {
                // The CALL, not the word: the block above it explains why the
                // maths is in awk at all, and a comment is not a formatter.
                let Some(at) = line.find("awk -v") else { continue };
                assert!(
                    line[..at].contains("LC_ALL=C"),
                    "{agent}: awk without LC_ALL=C formats numbers in the user's locale: {line}",
                );
            }
        }
    }

    /// agy: claude-shaped context, plus a `quota` of REMAINING fractions per
    /// bucket, picked by model family. 0.984 remaining is 1.6% used.
    #[test]
    #[cfg(unix)]
    fn agy_reports_context_and_its_model_family_quota() {
        let payload = r#"{"model":{"id":"gemini-pro-agent"},
          "context_window":{"total_input_tokens":28600,"total_output_tokens":10,"context_window_size":1048576,
            "used_percentage":2.73,"current_usage":{"input_tokens":1}},
          "quota":{"gemini-5h":{"remaining_fraction":0.984,"reset_time":"x","reset_in_seconds":3600},
            "gemini-weekly":{"remaining_fraction":0.5,"reset_time":"x","reset_in_seconds":7200},
            "3p-5h":{"remaining_fraction":0.1,"reset_time":"x","reset_in_seconds":60}}}"#;
        let (emitted, _) = statusline_run_as("agy", payload);
        assert!(emitted.contains(&format!("{CONTEXT_BODY_PREFIX}28600 1048576")), "{emitted:?}");
        let body = emitted.split(USAGE_BODY_PREFIX).nth(1).expect("a usage body");
        let f: Vec<&str> = body.trim_end_matches('\x07').split(' ').collect();
        assert_eq!(&f[..2], &["1.60", "50.00"], "{body:?}");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let reset: i64 = f[2].parse().unwrap();
        assert!((reset - (now + 3600)).abs() < 5, "5h reset {reset} vs now {now}");
        assert_eq!(f[4], "-", "agy reports no cost");

        // A non-Gemini model spends the third-party buckets.
        let (emitted, _) = statusline_run_as("agy", &payload.replace("gemini-pro-agent", "claude-sonnet"));
        assert!(emitted.contains(&format!("{USAGE_BODY_PREFIX}90.00 - ")), "{emitted:?}");

        // Before the first call the window is 0: no context reading.
        let (emitted, _) = statusline_run_as("agy",
            r#"{"model":{"id":"g"},"context_window":{"total_input_tokens":0,"context_window_size":0,"current_usage":null}}"#);
        assert_eq!(emitted, "");
    }

    #[test]
    fn grok_status_line_is_claimed_only_when_free_and_handed_back_intact() {
        let prefix = "/Users/u/.grok/termic-hooks/";
        let cmd = format!("{prefix}usage.sh");
        // Nothing there: claimed, and the rest of the file untouched.
        let src = "# my grok config\nmodel = \"grok-4\"\n\n[mcp]\nfoo = 1\n";
        let claimed = grok_claim_status_line(src, &cmd, prefix).unwrap().expect("free slot");
        assert!(claimed.starts_with("# my grok config\nmodel = \"grok-4\"\n"), "{claimed}");
        assert!(claimed.contains("[ui.status_line]") && claimed.contains(&cmd), "{claimed}");
        // Handing it back restores the original exactly.
        assert_eq!(grok_release_status_line(&claimed, prefix).unwrap().as_deref(), Some(src));
        // A user's own command row is theirs.
        let theirs = "[ui.status_line]\ntype = \"command\"\ncommand = \"~/.grok/mine.sh\"\n";
        assert_eq!(grok_claim_status_line(theirs, &cmd, prefix).unwrap(), None);
        assert_eq!(grok_release_status_line(theirs, prefix).unwrap(), None);
        // So is the built-in row they chose.
        let builtin = "[ui.status_line]\ntype = \"builtin\"\nitems = [\"cwd\"]\n";
        assert_eq!(grok_claim_status_line(builtin, &cmd, prefix).unwrap(), None);
        // An explicitly disabled one is free, in any of its spellings.
        let off = "[ui]\ntheme = \"dark\"\n\n[ui.status_line]\ntype = \"off\"\n";
        let claimed = grok_claim_status_line(off, &cmd, prefix).unwrap().expect("off is free");
        assert!(claimed.contains("theme = \"dark\""));
        // Releasing ours keeps the user's other [ui] keys.
        let released = grok_release_status_line(&claimed, prefix).unwrap().unwrap();
        assert!(released.contains("theme = \"dark\"") && !released.contains("status_line"), "{released}");
        // Re-claiming our own is idempotent.
        let once = grok_claim_status_line("", &cmd, prefix).unwrap().unwrap();
        assert_eq!(grok_claim_status_line(&once, &cmd, prefix).unwrap().as_deref(), Some(once.as_str()));
        // Unparseable TOML is refused, never replaced.
        assert!(grok_claim_status_line("[ui\n", &cmd, prefix).is_err());
    }

    #[test]
    fn muse_managed_slot_is_claimed_only_when_free_and_keeps_the_users_vars() {
        let prefix = "/Users/u/.config/muse/termic-hooks/";
        let file = format!("{prefix}managed-hooks.json");
        let root = serde_json::json!({ "schema_version": 1, "model": "m" });
        let claimed = muse_claim_managed(&root, &file, prefix).expect("free");
        assert_eq!(claimed["managed_hooks_path"], file.as_str());
        assert_eq!(claimed["managed_hooks_env_vars"], serde_json::json!(["TERMIC_PTY", "TERMIC_TASK_ID"]));
        assert_eq!(claimed["schema_version"], 1, "muse rejects a file without it");
        assert_eq!(muse_release_managed(&claimed, prefix), Some(root.clone()));
        // An enterprise or user managed file is not ours to replace.
        let theirs = serde_json::json!({ "schema_version": 1, "managed_hooks_path": "/etc/muse/hooks.json" });
        assert_eq!(muse_claim_managed(&theirs, &file, prefix), None);
        assert_eq!(muse_release_managed(&theirs, prefix), None);
        // A var the user listed survives both directions, and is not doubled.
        let mixed = serde_json::json!({ "schema_version": 1, "managed_hooks_env_vars": ["FOO", "TERMIC_PTY"] });
        let c = muse_claim_managed(&mixed, &file, prefix).unwrap();
        assert_eq!(c["managed_hooks_env_vars"], serde_json::json!(["FOO", "TERMIC_PTY", "TERMIC_TASK_ID"]));
        let r = muse_release_managed(&c, prefix).unwrap();
        assert_eq!(r["managed_hooks_env_vars"], serde_json::json!(["FOO"]));
    }

    /// grok's idle nag is a `Notification` too; only the permission prompt may
    /// badge the tab.
    #[test]
    #[cfg(unix)]
    fn grok_attention_is_the_permission_prompt_only() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let dir = unique_test_dir("grok-notify");
        let run = |payload: &str| -> String {
            let script = dir.join("attention.sh");
            let pty = dir.join("pty");
            std::fs::write(&script, script_body("grok", Signal::Attention)).unwrap();
            std::fs::write(&pty, "").unwrap();
            let mut child = Command::new("/bin/sh").arg(&script)
                .env("TERMIC_TASK_ID", "t1").env("TERMIC_PTY", &pty)
                .env("GROK_HOOK_EVENT", "notification")
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            {
                use std::io::Write as _;
                child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
            }
            assert!(child.wait().unwrap().success());
            let mut out = String::new();
            std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
            out
        };
        let bell = format!("\x1b]{NOTIFY_PREFIX}{ATTENTION_BODY}\x07");
        assert_eq!(run(r#"{"notificationType": "permission_prompt", "message": "m"}"#), bell);
        assert_eq!(run(r#"{"notificationType":"idle_prompt","message":"Grok is waiting"}"#), "");
        assert_eq!(run(r#"{"notificationType":"task_complete"}"#), "");
        assert_eq!(run(r#"{"message":"no type"}"#), bell);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hook whose terminal will not take the write must still exit. A FIFO
    /// with no reader blocks the open exactly like a pty whose reader is gone
    /// blocks the write; before the budget, grok `done.sh` hooks sat 22
    /// minutes in that state and held the tty lock that hung every new claude
    /// (see `bound_emits`). Every signal's script and the status line.
    #[test]
    #[cfg(unix)]
    fn a_hook_never_blocks_on_a_terminal_that_will_not_read() {
        use std::io::Write as _;
        use std::process::{Command, Stdio};
        let dir = unique_test_dir("stuck-pty");
        let fifo = dir.join("pty");
        assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        let mut bodies: Vec<(String, String)> = [Signal::Working, Signal::Done, Signal::Attention, Signal::Ready]
            .into_iter()
            .map(|sig| (format!("claude {}", sig.stem()), script_body("claude", sig)))
            .collect();
        bodies.push(("grok done".into(), script_body("grok", Signal::Done)));
        bodies.push(("statusline".into(), statusline_body_for("claude")));
        for (name, body) in bodies {
            let script = dir.join("s.sh");
            std::fs::write(&script, body).unwrap();
            let started = std::time::Instant::now();
            let mut child = Command::new("/bin/sh").arg(&script)
                .env("TERMIC_TASK_ID", "t1").env("TERMIC_PTY", &fifo)
                .env_remove("GROK_HOOK_EVENT")
                .env("GROK_HOOK_EVENT", if name.starts_with("grok") { "stop" } else { "" })
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            child.stdin.as_mut().unwrap()
                .write_all(br#"{"session_id":"x","context_window":{"total_input_tokens":5,"context_window_size":9}}"#)
                .unwrap();
            drop(child.stdin.take());
            let status = child.wait().unwrap();
            let took = started.elapsed();
            assert!(status.success(), "{name}: a hook must exit 0");
            assert!(took < std::time::Duration::from_secs(5), "{name}: blocked for {took:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bound_emits_wraps_every_chain_and_nothing_else() {
        let src = "a\n  emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty || true\nexit 0\n";
        let out = bound_emits(src);
        // Windows routes a host PTY's report through `termic hook-emit` and
        // keeps the ordinary chain for a Docker container (hook_pipe.rs).
        let chain = "emit \"$TERMIC_PTY\" || emit /proc/1/fd/1 || emit /dev/tty";
        let call = if cfg!(windows) {
            format!("if [ -n \"$TERMIC_PTY_PIPE\" ]; then emit /dev/stdout | \"$TERMIC_CLI\" hook-emit \"$TERMIC_PTY\"; else {chain}; fi")
        } else {
            chain.to_string()
        };
        assert!(out.starts_with(&format!("a\n  ( {call} ) </dev/null >/dev/null 2>&1 &\n")), "{out}");
        assert!(out.contains("  ( sleep 2; kill \"$termic_w\" )"));
        assert!(out.ends_with("exit 0\n"));
        // Every generated script is bounded: no bare chain survives.
        for sig in [Signal::Working, Signal::Done, Signal::Attention, Signal::Ready] {
            for agent in ["claude", "codex", "grok", "devin", "agy", "copilot", "muse"] {
                assert!(!script_body(agent, sig).contains("|| emit /dev/tty || true"), "{agent} {sig:?}");
            }
        }
        assert!(!statusline_body_for("claude").contains("/dev/tty || true"));
    }

    /// agy reports its conversation id on the first model invocation, in the
    /// same write as working, so a main-checkout task can resume it with
    /// `--conversation <id>`. Anything that is not a UUID never reaches a
    /// command line.
    #[test]
    #[cfg(unix)]
    fn agy_working_reports_its_conversation_id() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let dir = unique_test_dir("agy");
        let run = |payload: &str| -> String {
            let script = dir.join("working.sh");
            let pty = dir.join("pty");
            std::fs::write(&script, script_body("agy", Signal::Working)).unwrap();
            std::fs::write(&pty, "").unwrap();
            let mut child = Command::new("/bin/sh").arg(&script)
                .env("TERMIC_TASK_ID", "t1").env("TERMIC_PTY", &pty)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            {
                use std::io::Write as _;
                child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
            }
            assert!(child.wait().unwrap().success());
            let mut out = String::new();
            std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
            out
        };
        let id = "11111111-2222-4333-8444-555555555555";
        assert_eq!(
            run(&format!(r#"{{"conversationId":"{id}","modelName":"m","invocationNum":1}}"#)),
            format!("\x1b]{NOTIFY_PREFIX}{WORKING_BODY}\x07\x1b]{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}{id}\x07")
        );
        assert_eq!(run(r#"{"conversationId":"x; rm -rf ~","invocationNum":1}"#), format!("\x1b]{NOTIFY_PREFIX}{WORKING_BODY}\x07"));
        assert_eq!(run(r#"{"invocationNum":1}"#), format!("\x1b]{NOTIFY_PREFIX}{WORKING_BODY}\x07"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// muse's hooks also fire for its internal subagents, whose session ids are
    /// UUIDv4 where the main session's is v7. Only v7 may move the tab.
    #[test]
    #[cfg(unix)]
    fn muse_hooks_ignore_its_internal_subagents() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let dir = unique_test_dir("muse");
        let run = |sid: &str| -> String {
            let script = dir.join("done.sh");
            let pty = dir.join("pty");
            std::fs::write(&script, script_body("muse", Signal::Done)).unwrap();
            std::fs::write(&pty, "").unwrap();
            let mut child = Command::new("/bin/sh").arg(&script)
                .env("TERMIC_TASK_ID", "t1").env("TERMIC_PTY", &pty)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            {
                use std::io::Write as _;
                let p = format!(r#"{{"hook_event_name":"Stop","session_id":"{sid}","cwd":"/w"}}"#);
                child.stdin.as_mut().unwrap().write_all(p.as_bytes()).unwrap();
            }
            assert!(child.wait().unwrap().success());
            let mut out = String::new();
            std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
            out
        };
        assert_eq!(run("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"), format!("\x1b]{NOTIFY_PREFIX}{DONE_BODY}\x07"));
        assert_eq!(run("3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9"), "");
        assert_eq!(run(""), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copilot_gets_its_native_hook_file() {
        let cmds = vec![
            ("agentStop", "/p/termic-hooks/done.sh".to_string(), Signal::Done),
            ("preToolUse", "/p/termic-hooks/working.sh".to_string(), Signal::Working),
        ];
        let v = copilot_hooks_file(&cmds);
        assert_eq!(v["version"], 1);
        assert_eq!(v["hooks"]["agentStop"][0]["bash"], "/p/termic-hooks/done.sh");
        assert_eq!(v["hooks"]["agentStop"][0]["type"], "command");
        assert!(v["hooks"]["preToolUse"][0]["timeoutSec"].as_u64().unwrap() <= 10);
        assert_eq!(settings_rel("copilot"), "hooks/termic.json");
        assert_eq!(schema_for("copilot"), Schema::CopilotFile);
    }

    /// A payload named `rate_limits` in another agent's status line is never
    /// read as claude's plan.
    #[test]
    #[cfg(unix)]
    fn only_claude_reads_rate_limits() {
        let (emitted, _) = statusline_run_as("copilot", STATUSLINE_PAYLOAD);
        assert!(!emitted.contains(USAGE_BODY_PREFIX), "{emitted:?}");
    }

    /// The window that is NOT last in the object, cut on a comma rather than on
    /// the closing brace. Both paths through the same expansion.
    #[test]
    #[cfg(unix)]
    fn a_window_missing_its_reset_still_reports_its_percentage() {
        let payload = r#"{"rate_limits":{"five_hour":{"used_percentage":7},"seven_day":{"used_percentage":3,"resets_at":9}}}"#;
        let (emitted, _) = statusline_run(payload);
        assert!(emitted.contains(&format!("{USAGE_BODY_PREFIX}7 3 - 9")), "got {emitted:?}");
    }

    /// A payload with NOTHING readable writes nothing, rather than a row of
    /// dashes. claude sends one on a turn that never reached the API, and a
    /// footer that blanked itself on those would flicker on every such turn.
    #[test]
    #[cfg(unix)]
    fn a_payload_with_neither_limits_nor_cost_emits_nothing() {
        let (emitted, stdout) = statusline_run(r#"{"session_id":"x","model":{"id":"m"}}"#);
        assert_eq!(emitted, "");
        assert_eq!(stdout, "");
    }

    /// Cost WITHOUT rate limits is the API-key account, and it is the whole
    /// reason cost is read at all: plan windows are a subscription concept, so
    /// that account reports no percentages and its footer was empty.
    ///
    /// This test used to assert the opposite. It was called
    /// `a_payload_without_rate_limits_emits_nothing` and its fixture was this
    /// exact payload, which means the repo had a passing test pinning that we
    /// were handed a cost figure every turn and threw it away.
    #[test]
    #[cfg(unix)]
    fn cost_alone_is_reported_because_that_is_the_api_key_account() {
        let (emitted, stdout) = statusline_run(r#"{"session_id":"x","cost":{"total_cost_usd":0.1}}"#);
        assert!(emitted.contains(&format!("{USAGE_BODY_PREFIX}- - - - 0.1")), "got {emitted:?}");
        assert_eq!(stdout, "", "a status line must never print");
    }

    /// The subscription account: percentages AND cost, in one body.
    #[test]
    #[cfg(unix)]
    fn cost_rides_alongside_the_plan_windows_as_a_fifth_field() {
        let (emitted, _) = statusline_run(
            r#"{"cost":{"total_cost_usd":12.5},"rate_limits":{"five_hour":{"used_percentage":7,"resets_at":9},"seven_day":{"used_percentage":3}}}"#,
        );
        // APPENDED, never inserted: an older frontend reads the first four
        // fields and ignores the rest, so a stale install keeps working.
        assert!(emitted.contains(&format!("{USAGE_BODY_PREFIX}7 3 9 - 12.5")), "got {emitted:?}");
    }

    /// The same rule every other field obeys: a value that is not a bare
    /// number is dropped rather than passed into a ';'-separated OSC payload.
    #[test]
    #[cfg(unix)]
    fn a_hostile_cost_is_dropped_rather_than_forwarded() {
        let (emitted, _) = statusline_run(
            r#"{"cost":{"total_cost_usd":"1;rm -rf /"},"rate_limits":{"five_hour":{"used_percentage":7}}}"#,
        );
        assert!(emitted.contains(&format!("{USAGE_BODY_PREFIX}7 - - - -")), "got {emitted:?}");
        assert!(!emitted.contains("rm -rf"), "got {emitted:?}");
    }

    /// The body reaches an OSC 777 payload, whose fields are ';'-separated, and
    /// the values come from an agent-controlled JSON document. A value that is
    /// not bare digits is DROPPED rather than passed through: a ';' in the
    /// percentage field would re-point the earlier fields and let a payload
    /// forge a trusted signal, which is the same reasoning the attention
    /// script's tool-name check is built on.
    #[test]
    #[cfg(unix)]
    fn a_non_numeric_percentage_is_dropped_rather_than_forwarded() {
        let hostile = r#"{"rate_limits":{"five_hour":{"used_percentage":"1;notify;termic;agent needs your input"},"seven_day":{"used_percentage":5}}}"#;
        let (emitted, _) = statusline_run(hostile);
        assert!(!emitted.contains("agent needs your input"), "forged a signal: {emitted:?}");
        assert!(emitted.contains(&format!("{USAGE_BODY_PREFIX}- 5 - -")), "got {emitted:?}");
    }

    /// Installed globally, so it also runs in iTerm, Ghostty and CI. Silence
    /// there is both correct and required: an empty status line is what a
    /// non-termic terminal should render.
    #[test]
    #[cfg(unix)]
    fn the_status_line_is_silent_outside_a_termic_pty() {
        use std::io::Write as _;
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("termic-sl-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("usage.sh");
        std::fs::write(&script, statusline_body()).unwrap();
        for (task, pty) in [("", "/dev/null"), ("t1", "")] {
            let mut child = Command::new("/bin/sh")
                .arg(&script)
                .env("TERMIC_TASK_ID", task)
                .env("TERMIC_PTY", pty)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.as_mut().unwrap().write_all(STATUSLINE_PAYLOAD.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            assert_eq!(String::from_utf8_lossy(&out.stdout), "");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The three bodies that share OSC 777 and the trusted `termic` title are
    /// told apart by their body ALONE, on both sides of the boundary. Any one
    /// being a prefix of another routes a usage report into the attention path,
    /// which badges a tab that nobody needs to look at.
    #[test]
    fn the_usage_body_is_not_confusable_with_the_other_signals() {
        for other in [ATTENTION_BODY, READY_BODY] {
            assert!(
                !USAGE_BODY_PREFIX.starts_with(other) && !other.starts_with(USAGE_BODY_PREFIX),
                "{USAGE_BODY_PREFIX:?} vs {other:?} are confusable"
            );
        }
        // Pinned against USAGE_BODY_PREFIX in lib/agentUsage.ts, which cannot
        // import this. The two are the halves of one contract.
        assert_eq!(USAGE_BODY_PREFIX, "usage ");
        // Not a Signal stem: a status line is not registered against an event,
        // so `installed` must never depend on it.
        for sig in [Signal::Attention, Signal::Working, Signal::Done, Signal::Ready] {
            assert_ne!(sig.stem(), USAGE_STEM);
        }
    }

    // Same contract as the usage body, one signal along. The delegated report
    // shares OSC 777 and the trusted `termic` title with ready, attention and
    // the session id, and the handler routes them apart on the body alone.
    #[test]
    fn the_delegated_body_is_not_confusable_with_the_other_signals() {
        for other in [ATTENTION_BODY, READY_BODY, WORKING_BODY, DONE_BODY,
                      SESSION_BODY_PREFIX, USAGE_BODY_PREFIX] {
            assert!(
                !DELEGATED_BODY_PREFIX.starts_with(other) && !other.starts_with(DELEGATED_BODY_PREFIX),
                "{DELEGATED_BODY_PREFIX:?} vs {other:?} are confusable"
            );
        }
        // Pinned against HOOK_OSC_DELEGATED_PREFIX in lib/agentHooks.ts, which
        // cannot import this. The two are the halves of one contract.
        assert_eq!(DELEGATED_BODY_PREFIX, "agent delegated: ");
        // It must also survive claude's OWN notification ignore list, the way
        // every body on this channel has to (lib/agents.ts
        // BUILTIN_NOTIFY_IGNORE.claude), or the report is dropped silently.
        assert!(!DELEGATED_BODY_PREFIX.contains("is waiting for your input"));
    }

    #[test]
    fn the_status_line_claims_an_empty_slot_and_never_a_users_own() {
        let prefix = "/home/u/.claude/termic-hooks/";
        let cmd = format!("{prefix}usage.sh");

        // Empty config: ours goes in.
        let claimed = merge_statusline(&serde_json::json!({}), &cmd, prefix);
        assert_eq!(claimed["statusLine"]["command"], serde_json::json!(cmd));
        assert_eq!(claimed["statusLine"]["type"], serde_json::json!("command"));

        // A user's own status line is the one thing they look at every turn.
        // Replacing it would be the most visible thing this feature could do.
        let theirs = serde_json::json!({
            "statusLine": { "type": "command", "command": "/home/u/bin/my-bar.sh" }
        });
        assert_eq!(merge_statusline(&theirs, &cmd, prefix), theirs, "clobbered the user's status line");
        assert_eq!(unmerge_statusline(&theirs, prefix), None, "removal must not take the user's");

        // Ours, re-installed: idempotent, not duplicated.
        let again = merge_statusline(&claimed, &cmd, prefix);
        assert_eq!(again, claimed);

        // Removal hands the slot back, and reports that it did so.
        let stripped = unmerge_statusline(&claimed, prefix).expect("ours should be removable");
        assert!(stripped.get("statusLine").is_none());
        assert_eq!(unmerge_statusline(&serde_json::json!({}), prefix), None);
    }

    /// Other keys in the config are the user's, and a merge that reordered or
    /// dropped them would be a silent rewrite of a file they hand-wrote.
    #[test]
    fn claiming_the_slot_leaves_the_rest_of_the_config_alone() {
        let prefix = "/home/u/.claude/termic-hooks/";
        let root = serde_json::json!({ "theme": "dark", "hooks": { "Stop": [] } });
        let out = merge_statusline(&root, &format!("{prefix}usage.sh"), prefix);
        assert_eq!(out["theme"], serde_json::json!("dark"));
        assert_eq!(out["hooks"], root["hooks"]);
    }

    /// A clone must be PREVIEWED as what it will actually get. `install`
    /// resolves the base and the preview did not, so a clone of claude was
    /// shown an empty plan and then handed a full install: the dialog
    /// disagreed with the thing it was asking permission for.
    #[test]
    fn the_install_preview_resolves_a_clone_to_its_base() {
        let plan = agent_hooks_plan("claude".into()).expect("claude has a plan");
        assert!(!plan.entries.is_empty());
        assert!(
            plan.config_fragment.contains("statusLine"),
            "the preview must show every key the install writes: {}",
            plan.config_fragment
        );
        // A note has to SAY the status line is part of this, since the slot is
        // the one thing in that fragment that is not termic's to take.
        assert!(plan.notes.iter().any(|n| n.contains("status line")));
    }

    /// Precedence, in the order claude actually applies it. Measured on
    /// 2.1.260 by rendering a marker from each file and seeing which won.
    #[test]
    fn a_projects_own_status_line_is_reported_as_the_owner() {
        let dir = std::env::temp_dir().join(format!("termic-slowner-{}", std::process::id()));
        let claude = dir.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();

        // No project status line: the answer comes from the user level, which
        // in a test profile is whatever that profile has.
        let bare = status_line_owner("claude", &dir);
        assert!(bare.owner != "project" && bare.owner != "project-local", "{bare:?}");

        // A committed project status line wins over the user's, which is the
        // case that made usage silently stop in one repo and not another.
        std::fs::write(claude.join("settings.json"),
            r#"{"statusLine":{"type":"command","command":"node ./bar.js"}}"#).unwrap();
        let proj = status_line_owner("claude", &dir);
        assert_eq!(proj.owner, "project");
        assert_eq!(proj.command, "node ./bar.js");
        assert!(proj.path.ends_with(".claude/settings.json"), "{}", proj.path);

        // settings.local.json outranks settings.json, so it is the honest
        // answer when both exist: naming the wrong file sends the user to
        // edit something that is not in force.
        std::fs::write(claude.join("settings.local.json"),
            r#"{"statusLine":{"type":"command","command":"my-local-bar"}}"#).unwrap();
        let local = status_line_owner("claude", &dir);
        assert_eq!(local.owner, "project-local");
        assert_eq!(local.command, "my-local-bar");

        // A settings file with no statusLine at all must not claim the slot.
        std::fs::write(claude.join("settings.local.json"), r#"{"model":"opus"}"#).unwrap();
        assert_eq!(status_line_owner("claude", &dir).owner, "project");

        // Malformed JSON is somebody else's problem, not a panic and not an
        // owner: a config we cannot read tells us nothing about the slot.
        std::fs::write(claude.join("settings.local.json"), "{ not json").unwrap();
        assert_eq!(status_line_owner("claude", &dir).owner, "project");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A clone reads its OWN config dir, so that is the only file that can
    /// own its status line. Asking about the base read `~/.claude` instead.
    #[test]
    fn a_clones_status_line_is_read_from_its_own_config_dir() {
        crate::test_support::with_scratch_data_dir(|scratch| {
            let cfg = scratch.join("next-claude-config");
            std::fs::create_dir_all(&cfg).unwrap();
            std::fs::write(cfg.join("settings.json"),
                r#"{"statusLine":{"type":"command","command":"my-clone-bar"}}"#).unwrap();
            let mut settings = crate::load_settings_inner();
            let mut clone = crate::default_agents().into_iter().find(|a| a.id == "claude").unwrap();
            clone.id = "next-claude".into();
            clone.builtin = false;
            clone.extends = Some("claude".into());
            clone.env = [("CLAUDE_CONFIG_DIR".to_string(), cfg.to_string_lossy().into_owned())]
                .into_iter().collect();
            settings.agents.push(clone);
            crate::save_settings_inner(&settings).unwrap();

            let project = scratch.join("project");
            std::fs::create_dir_all(&project).unwrap();
            let owner = usage_status_line_owner("next-claude".into(), project.to_string_lossy().into_owned());
            assert_eq!(owner.owner, "user", "{owner:?}");
            assert_eq!(owner.command, "my-clone-bar");
            assert!(owner.path.starts_with(&*cfg.to_string_lossy()), "{}", owner.path);
        });
    }

    fn chk(is_docker: bool, host_installed: bool, ours_present: bool, stale: bool) -> SyncCheck {
        SyncCheck { is_docker, host_installed, ours_present, stale,
                    has_error: false, disabled_all: false }
    }

    #[test]
    fn sync_seeds_a_missing_docker_install_when_the_host_has_one() {
        // THE BUG. Sync only ever upgraded, so a Docker install that was never
        // made (or was lost when its config dir was cleared) stayed missing
        // forever, in silence: the container's agent ran with no hooks and no
        // status line, so a sandboxed task reported no work state and no plan
        // usage while the SAME agent on the host reported both.
        assert!(should_sync(chk(true, true, false, false)));
    }

    #[test]
    fn sync_never_introduces_hooks_for_an_agent_the_user_declined() {
        // No host install means no consent. The Docker dir is termic-owned, so
        // writing there is harmless, but hooks the user never asked for would
        // start reporting from an agent they deliberately left alone.
        assert!(!should_sync(chk(true, false, false, false)));
        // ...and the host itself is never seeded from nothing.
        assert!(!should_sync(chk(false, false, false, false)));
        assert!(!should_sync(chk(false, true, false, false)));
    }

    #[test]
    fn sync_upgrades_a_stale_install_on_either_side() {
        assert!(should_sync(chk(false, true, true, true)));
        assert!(should_sync(chk(true, true, true, true)));
    }

    #[test]
    fn sync_leaves_a_current_install_alone() {
        assert!(!should_sync(chk(false, true, true, false)));
        assert!(!should_sync(chk(true, true, true, false)));
    }

    #[test]
    fn sync_refuses_a_target_it_could_not_read_or_that_is_switched_off() {
        // An unreadable config and `disableAllHooks` are both the user's
        // state, not ours to overwrite, and that holds for the Docker seed
        // too: an error there means we do not know what is in the directory.
        let mut c = chk(true, true, false, false);
        c.has_error = true;
        assert!(!should_sync(c), "an unreadable target is never written to");

        let mut c = chk(false, true, true, true);
        c.disabled_all = true;
        assert!(!should_sync(c), "disableAllHooks is left exactly as found");
    }

    #[test]
    fn the_schema_bump_is_what_makes_sync_replace_old_installs() {
        // The upgrade path rests entirely on this. An install from the build
        // before the current set must read as stale, or `agent_hooks_sync`
        // skips it and the user keeps that set forever: v3 types into startup
        // dialogs, v4 holds a tab on `working` for the rest of the session,
        // v14 says nothing at all when a done is held and spins until the
        // ceiling, v16 is refused outright by opencode 2's plugin loader.
        assert_eq!(SCHEMA_VERSION, 17, "bump me with the hook set, or installs go stale silently");
    }

    #[test]
    fn every_supported_agent_has_an_event_and_a_state_dir() {
        for a in SUPPORTED {
            assert!(!hooks_for(a).is_empty(), "{a} is listed as supported but has no events");
            assert!(state_dir(a).is_ok(), "{a} has no state dir, so nowhere to install");
            // Install targets must be global or termic-owned, never a repo.
            let host = config_dir(&Target::Host((*a).into())).unwrap();
            assert!(!host.to_string_lossy().contains("worktree"), "{a}: {host:?}");
        }
    }

    // The two states that matter most must come from a PROTOCOL on every
    // agent that has one, never from the terminal. The terminal is a heuristic
    // that changes when a vendor changes their UI: the Codex latch in
    // docs/gotchas.md is exactly that failure, and it silently disabled done
    // detection until someone noticed tabs stuck on "working".
    #[test]
    fn done_comes_from_a_hook_on_every_agent_that_can_report_it() {
        for agent in SUPPORTED {
            let h = hooks_for(agent);
            if *agent == "agy" || *agent == "opencode" || *agent == "claude" || *agent == "grok" || *agent == "codex" || *agent == "devin" {
                assert!(
                    h.iter().any(|(_, s)| *s == Signal::Done),
                    "{agent} must report done via a hook, not the title"
                );
            }
            // Done is ignored unless we were working, so an agent reporting
            // Done must report Working too or its done never fires.
            if h.iter().any(|(_, s)| *s == Signal::Done) {
                assert!(
                    h.iter().any(|(_, s)| *s == Signal::Working),
                    "{agent} reports Done with no Working, so Done can never fire"
                );
            }
        }
    }

    #[test]
    fn attention_comes_from_a_hook_wherever_the_agent_has_such_an_event() {
        for agent in ["claude", "grok", "opencode", "devin"] {
            assert!(
                hooks_for(agent).iter().any(|(_, s)| *s == Signal::Attention),
                "{agent} has an attention-shaped event and must use it"
            );
        }
        // agy is the documented exception: no attention-shaped event exists,
        // so needs-you there stays on termic's byte-quiet fallback.
        assert!(!hooks_for("agy").iter().any(|(_, s)| *s == Signal::Attention));
        // codex has one, `PermissionRequest`, and it is wrong: it also fires
        // for approvals auto_review grants itself. Its title says when a person
        // is asked. See `hooks_for`.
        assert!(!hooks_for("codex").iter().any(|(_, s)| *s == Signal::Attention));
    }

    #[test]
    fn only_grok_can_report_an_interrupt() {
        // Measured: ESC mid-turn fires NOTHING on claude or codex, so their
        // done cannot survive an interrupt and OSC stays the backstop there.
        // grok's StopCancelled is the one exception.
        assert!(hooks_for("grok").iter().any(|(e, _)| *e == "StopCancelled"));
        assert!(!hooks_for("claude").iter().any(|(e, _)| *e == "StopCancelled"));
    }

    // The reason done must come from the protocol, in one test.
    //
    // Measured: claude backgrounds two shells, ends the parent turn, and paints
    // its IDLE glyph 49.6 SECONDS before the work actually finishes. On a
    // 1-2 hour subagent run that is 1-2 hours of a confident, wrong "done".
    // Its `Stop` fires three times there, and only the third has an empty
    // `background_tasks`. agy says the same thing as `fullyIdle`.
    #[test]
    fn done_hooks_refuse_to_fire_while_work_is_outstanding() {
        let claude = script_body("claude", Signal::Done);
        assert!(claude.contains("background_tasks"), "claude's done must consult its payload");
        // A WHITELIST, not a non-empty test. The delegated types hold the turn
        // open; anything else, named or not, lets done through. See the guard.
        for held in ["subagent", "workflow", "shell", "teammate"] {
            assert!(claude.contains(&format!("'{held} ")),
                "{held} must hold the turn open");
        }
        // The types that never end must NOT appear. `monitor` is the artifact
        // watch (an ambient websocket monitor); it outlives every turn.
        for never in ["monitor", "dream", "auto-modescan"] {
            assert!(!claude.contains(&format!("'{never} ")),
                "{never} must never hold the turn open");
        }
        // And the hold is REPORTED now, never silent: see
        // `a_held_done_reports_what_it_is_holding_for`.
        assert!(!claude.contains("exit 0 ;;"), "a hold must write, not exit");
        // Sliced out of the array, not matched across the whole payload:
        // `last_assistant_message` is the agent's own prose.
        assert!(claude.contains(r#"tasks=${flat##*'"background_tasks":['}"#),
            "the array must be sliced before matching");

        let agy = script_body("agy", Signal::Done);
        assert!(agy.contains("fullyIdle"), "agy's done must consult its payload");

        // No jq: the scripts must keep working on a machine that has none.
        for a in ["claude", "agy"] {
            assert!(!script_body(a, Signal::Done).contains("jq"));
        }
        // Only Done inspects a payload. Working and attention are unconditional.
        assert!(!script_body("claude", Signal::Working).contains("background_tasks"));
        assert!(!script_body("claude", Signal::Attention).contains("background_tasks"));
    }

    /// A fresh empty directory per call. The script harnesses below each run
    /// the generated shell against a `TERMIC_PTY` file inside one, and cargo
    /// runs them in parallel: pid+nanos lands two tests on the same path often
    /// enough that one reads (or deletes) the other's pty mid-run.
    #[cfg(unix)]
    fn unique_test_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "termic-{tag}-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Run claude's generated Done script against a real `Stop` payload and
    /// report whether it emitted. `TERMIC_PTY` points at a temp file, which is
    /// exactly how the script addresses a pty: a plain path it redirects into.
    ///
    /// This executes the shell rather than asserting on the source, because
    /// every bug this guard has had was a semantic one that a substring
    /// assertion happily agreed with.
    #[cfg(unix)]
    fn done_emits_for(payload: &str) -> bool {
        done_output_for("claude", payload).contains(DONE_BODY)
    }

    /// What the delegated report says, minus its OSC wrapper, or None when the
    /// script reported a plain done. `<count> <label> <ids>`, the grammar
    /// `parseDelegatedBody` in `lib/delegatedWork.ts` accepts.
    #[cfg(unix)]
    fn delegated_for(agent: &str, payload: &str) -> Option<String> {
        let out = done_output_for(agent, payload);
        let rest = out.split(DELEGATED_BODY_PREFIX).nth(1)?;
        Some(rest.trim_end_matches('\u{7}').trim().to_string())
    }

    /// Run an agent's generated Done script against a real payload and return
    /// everything it wrote. `TERMIC_PTY` points at a temp file, which is
    /// exactly how the script addresses a pty: a plain path it redirects into.
    ///
    /// This executes the shell rather than asserting on the source, because
    /// every bug this guard has had was a semantic one that a substring
    /// assertion happily agreed with.
    #[cfg(unix)]
    fn done_output_for(agent: &str, payload: &str) -> String {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let dir = unique_test_dir("hook");
        let script = dir.join("done.sh");
        let pty = dir.join("pty");
        std::fs::write(&script, script_body(agent, Signal::Done)).unwrap();
        std::fs::write(&pty, "").unwrap();

        // grok's script refuses to run unless grok is the caller, and claude's
        // refuses when it IS: the two share `~/.claude/settings.json`, so each
        // gates on `GROK_HOOK_EVENT` in the opposite direction. The harness
        // has to answer that the way the real runtime does, per agent, or a
        // grok script silently writes nothing and every assertion here reads
        // as "the guard held".
        let mut cmd = Command::new("/bin/sh");
        cmd.arg(&script)
            .env("TERMIC_TASK_ID", "t1")
            .env("TERMIC_PTY", &pty);
        if agent == "grok" { cmd.env("GROK_HOOK_EVENT", "stop"); }
        else { cmd.env_remove("GROK_HOOK_EVENT"); }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        {
            use std::io::Write as _;
            child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        }
        assert!(child.wait().unwrap().success(), "a hook must never exit non-zero");

        let mut out = String::new();
        std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// codex's Done hook with a rollout on disk: done, plus the context the way
    /// the codex TUI computes it. The fixture's `token_count` line is the
    /// measured 0.154.0 shape with placeholder numbers, and the rollout path
    /// has a SPACE in it, which a whitespace-stripped read would break.
    #[test]
    #[cfg(unix)]
    fn codex_done_reports_the_context_codex_itself_shows() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let dir = unique_test_dir("codex ctx");
        let rollout = dir.join("rollout 1.jsonl");
        let tc = |total: u64| format!(
            r#"{{"timestamp":"t","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":91308,"total_tokens":92436}},"last_token_usage":{{"input_tokens":33935,"cached_input_tokens":27392,"output_tokens":422,"reasoning_output_tokens":29,"total_tokens":{total}}},"model_context_window":258400}},"rate_limits":{{"primary":{{"used_percent":5.0}}}}}}}}"#);
        std::fs::write(&rollout, format!(
            "{{\"type\":\"session_meta\"}}\n{}\n{{\"type\":\"response_item\"}}\n{}\n", tc(1000), tc(34357)
        )).unwrap();
        let run = |payload: String| -> String {
            let script = dir.join("done.sh");
            let pty = dir.join("pty");
            std::fs::write(&script, script_body("codex", Signal::Done)).unwrap();
            std::fs::write(&pty, "").unwrap();
            let mut child = Command::new("/bin/sh").arg(&script)
                .env("TERMIC_TASK_ID", "t1").env("TERMIC_PTY", &pty)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            {
                use std::io::Write as _;
                child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
            }
            assert!(child.wait().unwrap().success());
            let mut out = String::new();
            std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
            out
        };
        let payload = format!(
            r#"{{"session_id":"s","transcript_path":"{}","hook_event_name":"Stop","stop_hook_active":false}}"#,
            rollout.display()
        );
        // The LAST token_count wins: 34357 of 258400 with the 12k baseline is
        // (246400 - 22357) / 246400 = 90.9% left, which codex shows as 91.
        assert_eq!(
            run(payload),
            format!("\x1b]{NOTIFY_PREFIX}{DONE_BODY}\x07\x1b]{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}34357 258400 9\x07")
        );
        // No transcript, or one that is gone: done alone, never a guessed 0%.
        assert_eq!(run(r#"{"session_id":"s"}"#.into()), format!("\x1b]{NOTIFY_PREFIX}{DONE_BODY}\x07"));
        assert_eq!(
            run(r#"{"transcript_path":"/nonexistent/rollout.jsonl"}"#.into()),
            format!("\x1b]{NOTIFY_PREFIX}{DONE_BODY}\x07")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Run claude's generated ATTENTION script against a payload and return the
    /// body it put on the pty. Same harness as `done_emits_for` and for the same
    /// reason: the extraction is shell, and shell is where the bugs are.
    #[cfg(unix)]
    fn attention_body_for(payload: &str) -> String {
        attention_body_for_agent("claude", payload)
    }

    #[cfg(unix)]
    fn attention_body_for_agent(agent: &str, payload: &str) -> String {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let dir = unique_test_dir("attn");
        let script = dir.join("attention.sh");
        let pty = dir.join("pty");
        std::fs::write(&script, script_body(agent, Signal::Attention)).unwrap();
        std::fs::write(&pty, "").unwrap();

        let mut child = Command::new("/bin/sh")
            .arg(&script)
            .env("TERMIC_TASK_ID", "t1")
            .env("TERMIC_PTY", &pty)
            .env_remove("GROK_HOOK_EVENT")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        {
            use std::io::Write as _;
            child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        }
        assert!(child.wait().unwrap().success(), "a hook must never exit non-zero");

        let mut out = String::new();
        std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        // Strip introducer/terminator and the sender fields, leaving the body.
        let start = out.find(NOTIFY_PREFIX).map(|i| i + NOTIFY_PREFIX.len());
        match start {
            Some(i) => out[i..].trim_end_matches('\u{7}').to_string(),
            None => String::new(),
        }
    }

    /// A `PermissionRequest` payload in the field order claude's own embedded
    /// hooks reference documents for the tool events (2.1.259: `session_id`,
    /// `tool_name`, `tool_input`). Values are synthetic.
    #[cfg(unix)]
    fn permission_payload(tool: &str, input: &str) -> String {
        format!(
            r#"{{"session_id":"s1","transcript_path":"/Users/u/.claude/x.jsonl",
               "cwd":"/Users/u/proj","hook_event_name":"PermissionRequest",
               "tool_name":"{tool}","tool_input":{input}}}"#
        )
    }

    // GH #276, the second half. The hook is what the user actually SEES: it
    // fires the moment claude blocks, and claude's own OSC 9 arrives 6.0s
    // behind it, too late to compose the banner and rightly unable to raise a
    // second one. So the hook's body has to carry the useful part.
    #[test]
    #[cfg(unix)]
    fn claude_attention_names_the_tool_it_is_blocked_on() {
        assert_eq!(
            attention_body_for(&permission_payload("Bash", r#"{"command":"rm -rf build"}"#)),
            "needs your permission: Bash",
        );
        // An MCP tool id is still a bare identifier, and is the case most worth
        // naming: "needs your permission" alone tells you nothing about which
        // of six servers is asking.
        assert_eq!(
            attention_body_for(&permission_payload("mcp__github__create_pr", "{}")),
            "needs your permission: mcp__github__create_pr",
        );
    }

    #[test]
    #[cfg(unix)]
    fn claude_attention_falls_back_rather_than_going_silent() {
        // Events that are not tool events carry no `tool_name` (SessionStart,
        // Stop, UserPromptSubmit). They must still notify, with the old body.
        let no_tool = r#"{"session_id":"s1","hook_event_name":"Notification",
                          "message":"Claude needs your permission"}"#;
        assert_eq!(attention_body_for(no_tool), ATTENTION_BODY);
        // Empty stdin is the degenerate case a runtime change could produce.
        assert_eq!(attention_body_for(""), ATTENTION_BODY);
    }

    #[test]
    #[cfg(unix)]
    fn claude_attention_rejects_a_tool_name_that_would_corrupt_the_payload() {
        // A `;` would split OSC 777 into the wrong fields, and the body sits in
        // the LAST field, so an injected one silently re-points the sender: a
        // body of `termic;...` in the title position is how a hostile payload
        // would forge a trusted signal. Rejected wholesale rather than
        // sanitised, so there is no escaping rule to get subtly wrong.
        assert_eq!(
            attention_body_for(&permission_payload("Bash;notify;termic;pwned", "{}")),
            ATTENTION_BODY,
        );
        // Same for a printf format specifier: the body goes through `%s` so it
        // could not reach the format string anyway, and this pins BOTH guards.
        assert_eq!(attention_body_for(&permission_payload("%s%s%n", "{}")), ATTENTION_BODY);
        // Whitespace is NOT rejected, it is gone before the check: the payload
        // is flattened first (same `tr -d '[:space:]'` the Done guard uses), so
        // an interior space is deleted rather than caught. Asserted because it
        // is surprising, and left alone because it is harmless - the extraction
        // stops at the closing quote, so the worst case is two words glued into
        // one identifier in a banner, never a field separator.
        assert_eq!(
            attention_body_for(&permission_payload("Bash Write", "{}")),
            "needs your permission: BashWrite",
        );
    }

    /// codex's `PermissionRequest` payload, transcribed from the shape a live
    /// 0.153.0 emitted at a real approval prompt. Placeholders throughout: the
    /// captured one carried a real home path, a real session id and a real
    /// transcript path, none of which belong in this repo.
    ///
    /// The shape is the point. `tool_name` sits AFTER `hook_event_name` and
    /// before `tool_input`, and `tool_input.description` is free-form prose
    /// from the model, which is exactly the field that would break a naive
    /// last-occurrence match.
    #[cfg(unix)]
    fn codex_permission_payload(tool: &str) -> String {
        format!(
            r#"{{"session_id":"00000000-0000-0000-0000-000000000000",
               "turn_id":"00000000-0000-0000-0000-000000000001",
               "transcript_path":"/Users/u/.codex/sessions/2026/01/01/rollout.jsonl",
               "cwd":"/Users/u/proj","hook_event_name":"PermissionRequest",
               "model":"gpt-5","permission_mode":"default","tool_name":"{tool}",
               "tool_input":{{"command":"echo hello > out.txt",
               "description":"Do you want to allow creating out.txt?"}}}}"#
        )
    }

    #[test]
    #[cfg(unix)]
    fn codex_attention_names_the_tool_too() {
        // Measured end to end before this was written: driving a real codex TUI
        // to an approval prompt fired PermissionRequest with `"tool_name":"Bash"`
        // at the instant the prompt painted.
        assert_eq!(
            attention_body_for_agent("codex", &codex_permission_payload("Bash")),
            "needs your permission: Bash",
        );
        // And the same guards apply, since it is literally the same script body.
        assert_eq!(
            attention_body_for_agent("codex", &codex_permission_payload("a;notify;termic;x")),
            ATTENTION_BODY,
        );
    }

    /// Run the agent's generated READY script and return everything it put on
    /// the pty, both sequences.
    #[cfg(unix)]
    fn ready_output_for(agent: &str, payload: &str) -> String {
        ready_output_with_env(agent, payload, &[])
    }

    /// `ready_output_for` with extra env for the hook process. The entrypoint
    /// is always cleared first: the test runner may itself be running under
    /// claude, whose value would otherwise decide the case.
    #[cfg(unix)]
    fn ready_output_with_env(agent: &str, payload: &str, extra: &[(&str, &str)]) -> String {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let dir = unique_test_dir("ready");
        let script = dir.join("ready.sh");
        let pty = dir.join("pty");
        std::fs::write(&script, script_body(agent, Signal::Ready)).unwrap();
        std::fs::write(&pty, "").unwrap();
        let mut child = Command::new("/bin/sh")
            .arg(&script)
            .env("TERMIC_TASK_ID", "t1")
            .env("TERMIC_PTY", &pty)
            .env_remove("GROK_HOOK_EVENT")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .envs(extra.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        {
            use std::io::Write as _;
            child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        }
        assert!(child.wait().unwrap().success(), "a hook must never exit non-zero");
        let mut out = String::new();
        std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// claude's `SessionStart` payload: the shape measured on 2.1.273, with
    /// placeholder paths. `session_id` first, `source` near the end.
    #[cfg(unix)]
    fn claude_session_start_payload(sid: &str, source: &str) -> String {
        format!(
            r#"{{"session_id":"{sid}",
               "transcript_path":"/Users/u/.claude/projects/-Users-u-proj/{sid}.jsonl",
               "cwd":"/Users/u/proj","scratchpad_dir":"/tmp/u/scratchpad",
               "hook_event_name":"SessionStart","source":"{source}","model":"m"}}"#
        )
    }

    /// GH #306. `/clear` and `/resume` move the conversation to another id in
    /// the same process; the tab has to hear about it or the next relaunch
    /// resumes the session from before the `/clear`.
    #[test]
    #[cfg(unix)]
    fn claude_ready_reports_the_new_session_after_clear_resume_and_compact() {
        let sid = "992f21c0-b227-4ae2-9c3c-245e63b4eeb8";
        for source in ["clear", "resume", "compact"] {
            let out = ready_output_with_env(
                "claude", &claude_session_start_payload(sid, source),
                &[("CLAUDE_CODE_ENTRYPOINT", "cli")],
            );
            assert!(out.contains(&format!("{NOTIFY_PREFIX}{READY_BODY}")), "{source}: ready must still be sent: {out:?}");
            assert!(
                out.contains(&format!("{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}{sid}")),
                "{source}: the new session id never reached the pty: {out:?}"
            );
            assert!(out.find(READY_BODY).unwrap() < out.find(SESSION_BODY_PREFIX).unwrap(), "{source}: {out:?}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn claude_ready_keeps_quiet_about_the_id_it_already_knows_and_about_nested_runs() {
        let sid = "b6d9e12e-f45c-442c-8d4e-f0725adb8c0d";
        let cases: [(&str, &[(&str, &str)]); 5] = [
            // termic passed this id itself (`--session-id` / `--resume`).
            ("startup", &[("CLAUDE_CODE_ENTRYPOINT", "cli")]),
            // A `claude -p` inside the agent inherits TERMIC_PTY; claude sets
            // its entrypoint to sdk-cli (measured), whatever the source.
            ("startup", &[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")]),
            ("clear", &[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")]),
            // No entrypoint at all: not provably the tab's own process.
            ("clear", &[]),
            // A source this build does not know.
            ("fork", &[("CLAUDE_CODE_ENTRYPOINT", "cli")]),
        ];
        for (source, vars) in cases {
            let out = ready_output_with_env("claude", &claude_session_start_payload(sid, source), vars);
            assert!(out.contains(&format!("{NOTIFY_PREFIX}{READY_BODY}")), "{source} {vars:?}: ready must still be sent: {out:?}");
            assert!(!out.contains(SESSION_BODY_PREFIX), "{source} {vars:?}: must not report an id: {out:?}");
        }
        // And an id that is not a uuid never reaches a `--resume` command line.
        let out = ready_output_with_env(
            "claude", &claude_session_start_payload("abc;rm -rf /", "clear"),
            &[("CLAUDE_CODE_ENTRYPOINT", "cli")],
        );
        assert!(!out.contains(SESSION_BODY_PREFIX), "{out:?}");
    }

    /// codex's `SessionStart` payload, transcribed from a live 0.153.0 with
    /// placeholders for the paths. Field ORDER matters: `session_id` comes
    /// first, ahead of `transcript_path`, and `transcript_path` embeds the same
    /// uuid a second time, which is what a last-occurrence match would find.
    #[cfg(unix)]
    fn codex_session_start_payload(sid: &str) -> String {
        format!(
            r#"{{"session_id":"{sid}",
               "transcript_path":"/Users/u/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-{sid}.jsonl",
               "cwd":"/Users/u/proj","hook_event_name":"SessionStart",
               "model":"gpt-5","permission_mode":"default","source":"startup"}}"#
        )
    }

    // Repo-root resume for codex hangs entirely off this one line of shell: no
    // id reported means no id stored, which means `resume --last` and the wrong
    // task's conversation.
    #[test]
    #[cfg(unix)]
    fn codex_ready_reports_the_session_id_alongside_ready() {
        let sid = "01a06adc-eeb5-77a0-b603-d7b670dd11e7";
        let out = ready_output_for("codex", &codex_session_start_payload(sid));
        assert!(
            out.contains(&format!("{NOTIFY_PREFIX}{READY_BODY}")),
            "ready must still be sent, unchanged: {out:?}"
        );
        assert!(
            out.contains(&format!("{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}{sid}")),
            "the session id never made it to the pty: {out:?}"
        );
        // Ready FIRST. `seedPrompt` waits on it, and an id arriving ahead of it
        // would be the tab reporting a session before it reports being usable.
        assert!(
            out.find(READY_BODY).unwrap() < out.find(SESSION_BODY_PREFIX).unwrap(),
            "ready must precede the session id: {out:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn codex_ready_still_reports_ready_when_there_is_no_usable_id() {
        // Ready is the load-bearing half: `seedPrompt` refuses to type into an
        // agent that reports readiness and has not reported it, so a payload
        // this cannot parse must NOT cost the tab its ready signal.
        for payload in [
            String::new(),
            r#"{"hook_event_name":"SessionStart","cwd":"/Users/u/p"}"#.to_string(),
            // Not a uuid: rejected rather than escaped, because it would be
            // expanded into a `resume <id>` command line.
            codex_session_start_payload("not-a-uuid"),
            codex_session_start_payload("../../etc/passwd"),
            codex_session_start_payload("$(rm -rf /)"),
        ] {
            let out = ready_output_for("codex", &payload);
            assert!(out.contains(READY_BODY), "ready lost for {payload:?}: {out:?}");
            assert!(
                !out.contains(SESSION_BODY_PREFIX),
                "a bad id must not be reported: {out:?}"
            );
        }
    }

    /// devin's `SessionStart` payload, transcribed from a live 3000.10.21.
    /// `session_id` is a slug (`brassy-polish`), not a uuid, and `source` is
    /// `startup` on a fresh spawn / `resume` on `-r`.
    #[cfg(unix)]
    fn devin_session_start_payload(sid: &str) -> String {
        format!(
            r#"{{"session_id":"{sid}","hook_event_name":"SessionStart",
               "source":"startup","cwd":"/Users/u/proj"}}"#
        )
    }

    // Same contract as codex's pair above: the slug IS what `devin --resume`
    // takes, so losing it strands repo-root resume on `--continue` and the
    // wrong task's session.
    #[test]
    #[cfg(unix)]
    fn devin_ready_reports_the_session_id_alongside_ready() {
        let sid = "brassy-polish";
        let out = ready_output_for("devin", &devin_session_start_payload(sid));
        assert!(
            out.contains(&format!("{NOTIFY_PREFIX}{READY_BODY}")),
            "ready must still be sent, unchanged: {out:?}"
        );
        assert!(
            out.contains(&format!("{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}{sid}")),
            "the session id never made it to the pty: {out:?}"
        );
        assert!(
            out.find(READY_BODY).unwrap() < out.find(SESSION_BODY_PREFIX).unwrap(),
            "ready must precede the session id: {out:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn devin_ready_still_reports_ready_when_there_is_no_usable_id() {
        // Slugs take letters, digits, dash and underscore; anything else lands
        // in a `--resume <id>` command line, so it is dropped not escaped.
        // Whitespace inside the value is the one case that is NOT rejected:
        // the script strips all whitespace before matching, so `"a b"` reads
        // as `ab` — still shell-safe, and a slug that resolves to nothing
        // fails the resume fast and respawns fresh rather than injecting.
        for payload in [
            String::new(),
            r#"{"hook_event_name":"SessionStart","cwd":"/Users/u/p"}"#.to_string(),
            devin_session_start_payload("--resume"),
            devin_session_start_payload("../../etc/passwd"),
            devin_session_start_payload("$(rm -rf /)"),
        ] {
            let out = ready_output_for("devin", &payload);
            assert!(out.contains(READY_BODY), "ready lost for {payload:?}: {out:?}");
            assert!(
                !out.contains(SESSION_BODY_PREFIX),
                "a bad id must not be reported: {out:?}"
            );
        }
    }

    /// Run devin's generated WORKING script against a payload and return
    /// everything it put on the pty. Same harness as `ready_output_for`: the
    /// extraction is shell, and shell is where the bugs are.
    #[cfg(unix)]
    fn devin_working_output_for(payload: &str) -> String {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let dir = unique_test_dir("working");
        let script = dir.join("working.sh");
        let pty = dir.join("pty");
        std::fs::write(&script, script_body("devin", Signal::Working)).unwrap();
        std::fs::write(&pty, "").unwrap();
        let mut child = Command::new("/bin/sh")
            .arg(&script)
            .env("TERMIC_TASK_ID", "t1")
            .env("TERMIC_PTY", &pty)
            .env_remove("GROK_HOOK_EVENT")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh");
        {
            use std::io::Write as _;
            child.stdin.as_mut().unwrap().write_all(payload.as_bytes()).unwrap();
        }
        assert!(child.wait().unwrap().success(), "a hook must never exit non-zero");
        let mut out = String::new();
        std::fs::File::open(&pty).unwrap().read_to_string(&mut out).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// devin's tool-event payload, transcribed from a live 3000.10.21.
    /// `hook_event_name` is snake_case in the payload even though the docs
    /// camelCase the `hookSpecificOutput` field of the same name.
    #[cfg(unix)]
    fn devin_tool_payload(evt: &str, tool: &str) -> String {
        format!(
            r#"{{"hook_event_name":"{evt}","tool_name":"{tool}",
               "tool_input":{{}},"tool_use_id":"{tool}_0",
               "session_id":"s1","prompt_id":"p1","cwd":"/Users/u/proj"}}"#
        )
    }

    // `ask_user_question` paints a blocking panel and never emits
    // `PermissionRequest` (measured: the panel sat up with only PreToolUse
    // logged). Without this the tab spins working for the whole time the
    // question waits on an answer.
    #[test]
    #[cfg(unix)]
    fn devin_question_tool_reports_attention_not_working() {
        let out = devin_working_output_for(&devin_tool_payload("PreToolUse", "ask_user_question"));
        assert!(
            out.contains(&format!("{NOTIFY_PREFIX}needs your answer: ask_user_question")),
            "the question edge must raise attention: {out:?}"
        );
        assert!(!out.contains(WORKING_BODY), "a blocked question is not working: {out:?}");
    }

    // The same script on the SAME tool's PostToolUse hands working back the
    // moment the answer lands, rather than leaving the tab badged while the
    // resumed turn runs.
    #[test]
    #[cfg(unix)]
    fn devin_question_answer_restores_working() {
        let out = devin_working_output_for(&devin_tool_payload("PostToolUse", "ask_user_question"));
        assert!(out.contains(WORKING_BODY), "answer landed, turn resumed: {out:?}");
        assert!(!out.contains("needs your"), "an answered question is not attention: {out:?}");
    }

    #[test]
    #[cfg(unix)]
    fn devin_working_stays_working_for_ordinary_events() {
        for payload in [
            // A prompt submit carries no tool_name at all.
            r#"{"hook_event_name":"UserPromptSubmit","prompt":"hi","session_id":"s1"}"#.to_string(),
            devin_tool_payload("PreToolUse", "exec"),
            devin_tool_payload("PostToolUse", "exec"),
            // Garbage parses to empty fields, which must still mean working.
            String::new(),
        ] {
            let out = devin_working_output_for(&payload);
            assert!(out.contains(WORKING_BODY), "working lost for {payload:?}: {out:?}");
            assert!(!out.contains("needs your"), "not attention for {payload:?}: {out:?}");
        }
    }

    // The body must survive the TS side, which is the failure mode with no
    // symptom: the hook fires correctly and termic drops it on the floor.
    #[test]
    fn the_enriched_attention_body_is_still_not_claudes_idle_nag() {
        // `notificationWantsAttention`'s ignore pattern for claude is "is
        // waiting for your input" (its 60s nudge after an unanswered turn).
        for body in [ATTENTION_BODY, "needs your permission: Bash"] {
            assert!(!body.contains("is waiting for your input"), "{body} would be filtered");
        }
        // And it must never collide with the READY body, which shares the OSC
        // id and the trusted sender and is told apart by an exact match alone.
        assert_ne!(ATTENTION_BODY, READY_BODY);
        assert!(!"needs your permission: Bash".starts_with(READY_BODY));
    }

    /// `TERMIC_E2E_AGENT_HOME` is process-global and the test harness runs
    /// tests in parallel: two tests that each point it at their own temp home
    /// install into each other's. Every test that sets it holds this.
    #[cfg(all(unix, feature = "e2e"))]
    static AGENT_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// An UPGRADE of a plugin-file install. The plugin is JS/TS, and install
    /// used to parse the existing file as JSON before reaching the plugin
    /// branch, so every upgrade was refused and opencode sat on v9 for a day.
    /// Needs the e2e feature to move the agent home into a temp dir.
    #[test]
    #[cfg(all(unix, feature = "e2e"))]
    fn a_plugin_install_upgrades_over_an_old_one() {
        let _home = AGENT_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("termic-plugin-upgrade-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("TERMIC_E2E_AGENT_HOME", &home);
        for agent in ["opencode", "pi"] {
            let target = Target::Host(agent.into());
            install(&target).expect("first install");
            let plugin = settings_path(&target).unwrap();
            // What an old schema left on disk: an older module and manifest.
            std::fs::write(&plugin, "// termic agent hook (generated, schema v9)\nexport const X = 1;\n").unwrap();
            let manifest = script_dir(&target).unwrap().join(MANIFEST_NAME);
            std::fs::write(&manifest, r#"{"schema_version":9,"command":"x","installed_at":"t"}"#).unwrap();
            assert!(status(&target).stale, "{agent}: an old install must read as stale");

            install(&target).unwrap_or_else(|e| panic!("{agent}: the upgrade was refused: {e}"));
            let st = status(&target);
            assert!(st.installed && !st.stale, "{agent}: still stale after the upgrade");
            let body = std::fs::read_to_string(&plugin).unwrap();
            assert!(body.contains(CONTEXT_BODY_PREFIX), "{agent}: the new module was not written");
            remove(&target).unwrap();
        }
        std::env::remove_var("TERMIC_E2E_AGENT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// opencode's install is TWO files: the module both versions load and
    /// opencode 2's TUI plugin directory. A v16 install (the module alone) is
    /// incomplete rather than absent, so sync writes the rest; removal takes
    /// both and the directory, but nothing a user put in it.
    #[test]
    #[cfg(all(unix, feature = "e2e"))]
    fn an_opencode_install_writes_and_removes_the_opencode_2_plugin_too() {
        let _home = AGENT_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home =std::env::temp_dir().join(format!("termic-opencode2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("TERMIC_E2E_AGENT_HOME", &home);
        let target = Target::Host("opencode".into());
        let tui = config_dir(&target).unwrap().join(OPENCODE_TUI_REL);

        install(&target).expect("install");
        assert_eq!(std::fs::read_to_string(&tui).unwrap(), opencode_tui_plugin_body());
        let st = status(&target);
        assert!(st.installed && st.ours_present && !st.stale);

        // What a v16 install left: the module, no TUI plugin.
        std::fs::remove_file(&tui).unwrap();
        let st = status(&target);
        assert!(!st.installed, "the module alone reported as a complete install");
        assert!(st.ours_present, "the module alone reported as no install");
        install(&target).expect("reinstall");
        assert!(status(&target).installed && tui.exists());

        remove(&target).unwrap();
        assert!(!tui.exists() && !tui.parent().unwrap().exists(), "the plugin directory was left");
        assert!(!settings_path(&target).unwrap().exists());
        let st = status(&target);
        assert!(!st.installed && !st.ours_present);

        // A file of the user's beside ours keeps the directory.
        install(&target).expect("install again");
        let theirs = tui.parent().unwrap().join("notes.txt");
        std::fs::write(&theirs, "mine").unwrap();
        remove(&target).unwrap();
        assert!(!tui.exists() && theirs.exists());

        std::env::remove_var("TERMIC_E2E_AGENT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The whole codex loop against a REAL `codex` binary: install, trust,
    /// verify codex agrees, remove, verify nothing of ours is left.
    ///
    /// `#[ignore]`d because it needs codex on PATH, which CI does not have. Run
    /// it with a real one:
    ///
    /// ```sh
    /// cargo test --features e2e codex_hooks_install -- --ignored --nocapture
    /// ```
    ///
    /// It writes ONLY into a temp dir: `TERMIC_E2E_AGENT_HOME` moves the agent
    /// home, and `CODEX_HOME` follows it because `config_dir` derives one from
    /// the other. The user's own `~/.codex` is never opened.
    ///
    /// The assertion that matters is not "we wrote a trust entry" but "codex
    /// says trusted". A trust entry with the wrong hash is silently `modified`
    /// and the hook never runs, so only codex's own verdict proves the install.
    #[test]
    #[ignore = "needs a real codex binary on PATH"]
    #[cfg(all(unix, feature = "e2e"))]
    fn codex_hooks_install_is_trusted_by_codex_and_leaves_nothing_behind() {
        let _home = AGENT_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home =std::env::temp_dir().join(format!("termic-codex-e2e-{}", std::process::id()));
        let codex_home = home.join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::env::set_var("TERMIC_E2E_AGENT_HOME", &home);

        // A config.toml the user "already had", so the trust write has to
        // preserve something rather than starting from an empty file.
        let original_config = "model = \"gpt-5.6-sol\"\n\n[tui]\nnotifications = true\n";
        std::fs::write(codex_home.join("config.toml"), original_config).unwrap();

        let target = Target::Host("codex".into());
        install(&target).expect("install codex hooks");

        // 1. The hooks file exists and holds one group per registered event.
        let hooks_json = codex_home.join("hooks.json");
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks_json).unwrap()).unwrap();
        for (event, _) in hooks_for("codex") {
            assert!(
                v["hooks"][event].as_array().is_some_and(|g| !g.is_empty()),
                "{event} missing from {}",
                hooks_json.display()
            );
        }

        // 2. The user's own config survived, and trust was added beside it.
        let cfg = std::fs::read_to_string(codex_home.join("config.toml")).unwrap();
        assert!(cfg.contains("gpt-5.6-sol"), "the user's config was clobbered:\n{cfg}");
        assert!(cfg.contains("[tui]"));
        assert!(cfg.contains("trusted_hash"), "no trust written:\n{cfg}");

        // 3. THE assertion: codex itself agrees. Anything wrong with the key or
        //    the hash shows up here as `untrusted`/`modified`, which is exactly
        //    how this fails in the field - silently.
        let bin = "codex";
        let found = crate::codex_trust::discover_ours(
            bin,
            &codex_home,
            &hooks_json,
            &command_prefix(&target).unwrap(),
            &codex_home,
        )
        .expect("codex app-server hooks/list");
        assert_eq!(
            found.len(),
            hooks_for("codex").len(),
            "codex did not report every hook we wrote: {found:?}"
        );
        for h in &found {
            eprintln!("  codex says: {} -> {}", h.key, h.trust_status);
            assert_eq!(h.trust_status, "trusted", "hook not trusted: {h:?}");
        }

        // 4. Status agrees too, so the UI is not claiming something else.
        assert!(status(&target).installed, "status must see a complete install");

        // 5. The command the UI actually calls, which does BOTH targets and
        //    rolls the host back if the Docker half errors. An earlier version
        //    of the Docker guard returned Err here and made codex hooks
        //    uninstallable everywhere while every direct-install test passed.
        remove(&target).expect("reset before the command-level install");
        let full = agent_hooks_install("codex".into()).expect("agent_hooks_install");
        assert!(full.supported, "codex must report as supported");
        assert!(full.host.installed, "the host half must be installed");
        assert!(
            !full.docker.installed,
            "the Docker half must report OFF rather than claiming hooks that cannot run"
        );

        // 6. Status is HONEST about trust, not just about the hooks file.
        //    Strip the trust the way a user editing config.toml would, and the
        //    row must stop claiming "on": those hooks are still on disk, still
        //    reported `enabled` by codex, and still run nothing.
        let cfg_path = codex_home.join("config.toml");
        let stripped =
            crate::codex_trust::without_trust(&std::fs::read_to_string(&cfg_path).unwrap(), &hooks_json)
                .unwrap();
        std::fs::write(&cfg_path, &stripped).unwrap();
        let untrusted = status(&target);
        assert!(!untrusted.installed, "status must not claim untrusted hooks are on");
        assert!(
            untrusted.error.as_deref().is_some_and(|e| e.contains("trust")),
            "and it must say why: {:?}",
            untrusted.error
        );
        // Re-installing is the documented fix, so it has to actually work.
        install(&target).expect("re-install after trust was stripped");
        assert!(status(&target).installed, "re-install must restore trust");

        // 7. Removal takes the hooks AND the trust with it, and hands the
        //    user's config.toml back byte-identical.
        remove(&target).expect("remove codex hooks");
        let after = std::fs::read_to_string(codex_home.join("config.toml")).unwrap();
        assert_eq!(after, original_config, "config.toml must come back unchanged");
        let left = std::fs::read_to_string(&hooks_json).unwrap_or_default();
        assert!(
            !left.contains(SCRIPT_DIR),
            "our commands are still in hooks.json:\n{left}"
        );
        assert!(!status(&target).ours_present, "status still sees our entries");

        std::env::remove_var("TERMIC_E2E_AGENT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The other half, and the one that cannot be argued from a config file:
    /// does a REAL codex turn actually run these hooks and put termic's OSC on
    /// the terminal it was handed?
    ///
    /// `#[ignore]`d and separate from the install test because it costs a live
    /// model call on the user's own account. Run it deliberately:
    ///
    /// ```sh
    /// cargo test --features e2e codex_hooks_fire -- --ignored --nocapture
    /// ```
    ///
    /// It borrows the user's login with a SYMLINK to `auth.json` rather than a
    /// copy, so no credential is ever duplicated into a temp dir, and the real
    /// `~/.codex` is never written to. `TERMIC_PTY` points at a plain file,
    /// which is how the scripts address a pty anyway (they redirect into a
    /// path), so this needs no terminal.
    #[test]
    #[ignore = "spends a real codex turn on the user's account"]
    #[cfg(all(unix, feature = "e2e"))]
    fn codex_hooks_fire_on_a_real_turn() {
        let _home = AGENT_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home =std::env::temp_dir().join(format!("termic-codex-fire-{}", std::process::id()));
        let codex_home = home.join(".codex");
        let work = home.join("work");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::create_dir_all(&work).unwrap();

        let real_auth = dirs::home_dir().unwrap().join(".codex/auth.json");
        if !real_auth.exists() {
            eprintln!("SKIP: no ~/.codex/auth.json, cannot make a live call");
            return;
        }
        std::os::unix::fs::symlink(&real_auth, codex_home.join("auth.json")).unwrap();

        std::env::set_var("TERMIC_E2E_AGENT_HOME", &home);
        let target = Target::Host("codex".into());
        install(&target).expect("install codex hooks");

        // A REAL pty, not a file. The scripts write with a TRUNCATING redirect
        // (`> "$1"`), which is meaningless on a character device and total on a
        // regular file: pointed at a file, each hook erases the one before it
        // and a three-hook turn ends with only the last sequence on disk. Found
        // exactly that way, and it would have hidden two of the three signals
        // this test exists to prove.
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize::default())
            .expect("open a pty");
        let pty_path = crate::pty_slave_path(&pair.master).expect("pty slave path");
        let mut reader = pair.master.try_clone_reader().expect("pty reader");
        let seen_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let sink = seen_buf.clone();
        std::thread::spawn(move || {
            use std::io::Read as _;
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        let pty = std::path::PathBuf::from(&pty_path);
        let out = std::process::Command::new("codex")
            .args(["exec", "--skip-git-repo-check", "reply with the single word ok"])
            .current_dir(&work)
            .env("CODEX_HOME", &codex_home)
            .env("TERMIC_PTY", &pty)
            .env("TERMIC_TASK_ID", "live-fire")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("run codex exec");
        let transcript = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        // The hooks write asynchronously through a pty; give the reader a beat
        // to drain what the child wrote just before it exited.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let seen = String::from_utf8_lossy(&seen_buf.lock().unwrap()).to_string();
        eprintln!("--- codex said ---\n{}", transcript.chars().take(1200).collect::<String>());
        eprintln!("--- pty got {} bytes ---\n{seen:?}", seen.len());

        // Ready, working and done are the three the state machine cannot run
        // without. Attention needs a permission prompt, which a read-only
        // one-shot never reaches, so it is proven by the install test agreeing
        // codex registered it rather than by firing here.
        assert!(seen.contains("777;notify;termic;agent ready for input"),
            "SessionStart (ready) never reached the pty");
        assert!(seen.contains(WORKING_BODY), "working never reached the pty");
        assert!(seen.contains(DONE_BODY), "Stop (done) never reached the pty");
        // Order matters as much as presence: a done before any working is a
        // turn termic would ignore, since a hard idle is dropped unless we
        // were working.
        assert!(seen.find(WORKING_BODY).unwrap() < seen.rfind(DONE_BODY).unwrap(),
            "done arrived before working: {seen:?}");

        // The session id, which is what makes repo-root resume possible at all:
        // several tasks share the repo root's cwd, so `resume --last` there is
        // another task's conversation. codex cannot be HANDED an id at launch,
        // so it has to report the one it chose.
        let reported = seen
            .split("\u{1b}]777;notify;termic;session ")
            .nth(1)
            .and_then(|rest| rest.split('\u{7}').next())
            .map(str::to_string)
            .expect(&format!("no session id reported: {seen:?}"));
        // It must be the id codex actually used, not merely a well-formed one.
        assert!(
            transcript.contains(&reported),
            "reported {reported} is not the session codex announced:\n{transcript}"
        );
        // Ready first: seedPrompt blocks on it, and both ride ONE write, which
        // is why a truncating redirect cannot cost us the ready half.
        assert!(
            seen.find("agent ready for input").unwrap() < seen.find("session ").unwrap(),
            "ready must precede the session id: {seen:?}"
        );

        remove(&target).expect("remove codex hooks");
        std::env::remove_var("TERMIC_E2E_AGENT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// One payload per background-task type claude can report, in the shape
    /// `Rcr` builds them (2.1.259). Types transcribed from claude's own label
    /// map; the values are synthetic.
    #[cfg(unix)]
    fn stop_payload(tasks: &str) -> String {
        format!(
            r#"{{"session_id":"s1","transcript_path":"/Users/u/.claude/x.jsonl",
               "cwd":"/Users/u/proj","hook_event_name":"Stop","stop_hook_active":false,
               "last_assistant_message":"done","background_tasks":[{tasks}],
               "session_crons":[]}}"#
        )
    }

    // The regression this whole guard exists to not have twice.
    //
    // v4 asked "is background_tasks non-empty". An artifact watch answers yes
    // for the entire session: it is an ambient websocket monitor, it is
    // `running` from the moment a page is published, and claude's Stop payload
    // includes it (the builder's only filter is status running|pending). So one
    // publish silenced every later done, and because hooks had already proven
    // themselves on that pty, no demoter and neither ceiling was left armed to
    // notice. The tab loaded forever, across new turns and finished turns.
    #[test]
    #[cfg(unix)]
    fn done_fires_through_an_artifact_watch() {
        let watch = r#"{"id":"m1","type":"monitor","status":"running",
                        "description":"Artifact live updates"}"#;
        assert!(done_emits_for(&stop_payload(watch)),
            "an artifact watch must NOT hold the spinner: it never ends");
        assert!(done_emits_for(&stop_payload("")), "an empty array is plainly done");
    }

    // The half the guard is right about, kept honest.
    #[test]
    #[cfg(unix)]
    fn done_waits_for_delegated_work() {
        let cases = [
            (r#"{"id":"a1","type":"subagent","status":"running","description":"Explore","agent_type":"Explore"}"#, false),
            (r#"{"id":"w1","type":"workflow","status":"running","description":"review","name":"review"}"#, false),
            (r#"{"id":"b1","type":"shell","status":"running","description":"build","command":"make beta"}"#, false),
            (r#"{"id":"d1","type":"dream","status":"running","description":"dreaming"}"#, true),
            (r#"{"id":"u1","type":"some_future_type","status":"running","description":"?"}"#, true),
        ];
        for (task, should_emit) in cases {
            assert_eq!(done_emits_for(&stop_payload(task)), should_emit,
                "wrong verdict for {task}");
        }
        // A watch alongside a real subagent still waits for the subagent.
        let both = r#"{"id":"m1","type":"monitor","status":"running","description":"Artifact live updates"},
                      {"id":"a1","type":"subagent","status":"running","description":"Explore","agent_type":"Explore"}"#;
        assert!(!done_emits_for(&stop_payload(both)), "the subagent must still hold");
    }

    // Holding is not the same as saying nothing, which is what this used to do.
    // A silent hook is byte-for-byte a model mid-token, so the tab span until
    // the 20-minute ceiling cleared it with no badge and no bell. Every case
    // that holds must now REPORT, in the grammar `parseDelegatedBody` accepts.
    #[test]
    #[cfg(unix)]
    fn a_held_done_reports_what_it_is_holding_for() {
        let subagent = r#"{"id":"a1","type":"subagent","status":"running","description":"Explore","agent_type":"Explore"}"#;
        assert_eq!(delegated_for("claude", &stop_payload(subagent)).as_deref(),
            Some("1 subagent a1"));

        // Counted, so the chip can say "2 subagents" rather than guessing.
        let two = format!("{subagent},{}",
            r#"{"id":"a2","type":"subagent","status":"running","description":"Plan","agent_type":"Plan"}"#);
        assert_eq!(delegated_for("claude", &stop_payload(&two)).as_deref(),
            Some("2 subagent a1,a2"));

        // Measured in C (docs/agent-hooks.md): a subagent that backgrounds its
        // own shell puts BOTH in the parent's payload. The parent is waiting on
        // its subagent, so the label has to say subagent, or the detached-work
        // grace would start ticking on an orchestration that is running fine.
        let mixed = format!("{subagent},{}",
            r#"{"id":"b1","type":"shell","status":"running","description":"sleep 70","command":"sleep 70"}"#);
        assert_eq!(delegated_for("claude", &stop_payload(&mixed)).as_deref(),
            Some("1 subagent a1,b1"), "agent-owned work names the hold");

        // The wire labels the TS side accepts, which are not all the payload's
        // own spellings.
        for (ty, label) in [("cloudsession", "cloud_session"), ("MCPtask", "mcp_task"),
                            ("teammate", "teammate"), ("workflow", "workflow")] {
            let task = format!(r#"{{"id":"x1","type":"{ty}","status":"running","description":"d"}}"#);
            assert_eq!(delegated_for("claude", &stop_payload(&task)).as_deref(),
                Some(format!("1 {label} x1").as_str()), "wrong label for {ty}");
        }

        // A plain done reports no delegation at all, and an ambient watch is a
        // plain done (the regression above).
        assert_eq!(delegated_for("claude", &stop_payload("")), None);
        let watch = r#"{"id":"m1","type":"monitor","status":"running","description":"Artifact live updates"}"#;
        assert_eq!(delegated_for("claude", &stop_payload(watch)), None);
    }

    // The ids are the whole mechanism behind "this turn is not waiting on it":
    // termic compares one turn's set against the last one's. An id it cannot
    // read is dropped rather than passed through, because the body is built
    // from an agent-controlled payload.
    #[test]
    #[cfg(unix)]
    fn the_delegated_report_carries_ids_and_drops_junk() {
        let hostile = r#"{"id":"ok-1_2","type":"shell","status":"running","command":"x"},
                         {"id":"no;rm -rf","type":"shell","status":"running","command":"y"}"#;
        assert_eq!(delegated_for("claude", &stop_payload(hostile)).as_deref(),
            Some("2 shell ok-1_2"), "count is of TYPES, the id list is filtered");

        // Nothing readable at all still reports the hold, with `-` for "no ids".
        // termic then treats every report as new work, which waits rather than
        // announcing: the conservative direction.
        let noid = r#"{"type":"shell","status":"running","command":"x"}"#;
        assert_eq!(delegated_for("claude", &stop_payload(noid)).as_deref(), Some("1 shell -"));
    }

    // grok's dialect, from the hooks reference embedded in its own binary:
    // camelCase `backgroundTasks`, and only three types, `monitor` among them.
    // Synthetic payloads in that documented shape; the values are placeholders.
    #[test]
    #[cfg(unix)]
    fn grok_reads_its_own_camelcase_dialect() {
        let stop = |tasks: &str| format!(
            r#"{{"sessionId":"s1","hook_event_name":"Stop","hookEventName":"stop",
               "stopHookActive":false,"reason":"end_turn","lastAssistantMessage":"ok",
               "backgroundTasks":[{tasks}],"sessionCrons":[]}}"#
        );
        let shell = r#"{"id":"bg1","type":"shell","status":"running","command":"npm run dev"}"#;
        let sub = r#"{"id":"sa1","type":"subagent","status":"running","agentType":"general"}"#;
        let mon = r#"{"id":"m1","type":"monitor","status":"running","description":"watch"}"#;

        assert_eq!(delegated_for("grok", &stop(shell)).as_deref(), Some("1 shell bg1"));
        assert_eq!(delegated_for("grok", &stop(sub)).as_deref(), Some("1 subagent sa1"));
        // A monitor is grok's ambient type, the same trap claude's `monitor_ws`
        // is: it outlives every turn, so it must not hold one open.
        assert_eq!(delegated_for("grok", &stop(mon)), None);
        assert!(done_output_for("grok", &stop(mon)).contains(DONE_BODY));
        assert_eq!(delegated_for("grok", &stop("")), None);
        // Agent-owned wins the label when both are outstanding, so the
        // detached grace never starts on a running subagent.
        assert_eq!(delegated_for("grok", &stop(&format!("{shell},{sub}"))).as_deref(),
            Some("1 subagent bg1,sa1"));

        // claude's SNAKE_CASE key must not be read here, or a hook reading the
        // wrong dialect would silently report nothing for every grok turn.
        let snake = r#"{"hook_event_name":"Stop","background_tasks":[
            {"id":"b1","type":"shell","status":"running"}]}"#;
        assert_eq!(delegated_for("grok", snake), None);

        // ONE script serves `StopCancelled` too, and that is an interrupt: the
        // turn is over whatever is still in flight. The closing quote in the
        // pattern is what keeps this from matching `"Stop"`.
        let cancelled = format!(
            r#"{{"hook_event_name":"StopCancelled","reason":"user_interrupt",
               "backgroundTasks":[{shell}]}}"#
        );
        assert_eq!(delegated_for("grok", &cancelled), None,
            "an interrupt must never report a hold");
        assert!(done_output_for("grok", &cancelled).contains(DONE_BODY));
    }

    // agy says work is outstanding without saying what, and that is the shape
    // the generic label exists for. No ids, so termic never reads it as carried
    // over and never puts the detached-work clock on it: it waits for agy.
    #[test]
    #[cfg(unix)]
    fn agy_reports_a_hold_without_naming_it() {
        assert_eq!(delegated_for("agy", r#"{"fullyIdle":false}"#).as_deref(), Some("1 work -"));
        assert_eq!(delegated_for("agy", r#"{"fullyIdle":true}"#), None);
        assert!(done_output_for("agy", r#"{"fullyIdle":true}"#).contains(DONE_BODY));
    }

    // The labels the script sends and the labels Rust documents are one list.
    #[test]
    fn every_documented_label_is_in_the_script() {
        let s = script_body("claude", Signal::Done);
        for (ty, label) in DELEGATED_LABELS {
            assert!(s.contains(&format!("'{ty} {label}'")),
                "the script must map {ty} to {label}");
        }
    }

    // The agent's own prose must not be able to hold its spinner down. A turn
    // that discusses `"type":"shell"` (this one did) serialises that text into
    // `last_assistant_message`, which is why the array is sliced out first.
    #[test]
    #[cfg(unix)]
    fn done_ignores_task_types_quoted_in_the_transcript() {
        let payload = r#"{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false,
            "last_assistant_message":"The whitelist holds for \"type\":\"subagent\" and \"type\":\"shell\".",
            "background_tasks":[],"session_crons":[]}"#;
        assert!(done_emits_for(payload),
            "only the background_tasks array may decide this");
    }

    // ── Antigravity ─────────────────────────────────────────────────
    // Its config is a different SHAPE, not a variation on claude's, and the
    // heterogeneity below is the thing that silently produced empty commands.

    #[test]
    fn agy_reports_done_and_working_because_it_has_no_attention_event() {
        let h = hooks_for("agy");
        assert_eq!(h, &[("PreInvocation", Signal::Working), ("Stop", Signal::Done)]);
        // Working is not optional here: `goIdle(reason, 0)` is ignored unless
        // we were working, so Done alone would never fire.
        assert!(h.iter().any(|(_, s)| *s == Signal::Working));
    }

    /// Claude DISPLAYS `statusMessage` while the hook runs, so a shared string
    /// meant a turn starting announced "you are needed". It shipped that way
    /// and was only caught by installing into a real config and reading the
    /// merged file. Each signal now says what it is actually reporting.
    /// Working is the only SUSTAINED state here, and the only one that needs
    /// re-asserting. The terminal title this replaced repainted constantly, so
    /// a spinner cleared by anything came back within a frame; a single
    /// UserPromptSubmit made the same clear permanent for the whole turn.
    #[test]
    fn working_has_a_heartbeat_wherever_one_is_safe() {
        for agent in ["claude", "grok", "devin"] {
            let working: Vec<&str> = hooks_for(agent)
                .iter()
                .filter(|(_, s)| *s == Signal::Working)
                .map(|(e, _)| *e)
                .collect();
            assert!(
                working.len() >= 2,
                "{agent} reports working from one edge only, so a cleared spinner never returns: {working:?}",
            );
            assert!(working.contains(&"PreToolUse"), "{agent}: {working:?}");
        }

        // agy is the deliberate exception, twice over: PreInvocation already
        // fires per model invocation (so it HAS a heartbeat), and its
        // PreToolUse documents `decision` as required, so observing it
        // silently risks blocking the tool.
        let agy: Vec<&str> = hooks_for("agy").iter().map(|(e, _)| *e).collect();
        assert!(!agy.contains(&"PreToolUse"), "agy must not observe PreToolUse: {agy:?}");
        assert!(agy.contains(&"PreInvocation"));
    }

    /// Done and attention are EDGES and deliberately have no heartbeat. A turn
    /// ends once, and a repeated "still done" would re-badge something the user
    /// already dismissed.
    #[test]
    fn done_and_attention_stay_single_edges() {
        for agent in SUPPORTED {
            for sig in [Signal::Done, Signal::Attention] {
                let n = hooks_for(agent).iter().filter(|(_, s)| *s == sig).count();
                // grok is the one agent with two done events, and they are
                // mutually exclusive outcomes of one turn (Stop, StopCancelled),
                // not a repeat of the same one.
                let cap = if *agent == "grok" && sig == Signal::Done { 2 } else { 1 };
                assert!(n <= cap, "{agent} {sig:?} registered {n} times");
            }
        }
    }

    #[test]
    fn each_signal_announces_itself_honestly() {
        let msgs: Vec<&str> = [Signal::Working, Signal::Attention, Signal::Done]
            .iter()
            .map(|s| s.status_message())
            .collect();
        let mut uniq = msgs.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), 3, "every signal needs its own wording: {msgs:?}");
        assert!(
            Signal::Attention.status_message().contains("needed"),
            "only the attention hook may claim the user is needed",
        );
        for s in [Signal::Working, Signal::Done] {
            assert!(
                !s.status_message().contains("needed"),
                "{s:?} must not announce that the user is needed",
            );
        }
        // Copy rule: no em dashes in anything a user reads.
        for m in msgs {
            assert!(!m.contains('\u{2014}'), "em dash in user-visible text: {m}");
        }
    }

    #[test]
    fn agy_wraps_tool_events_but_not_the_others() {
        let cmds = vec![
            ("PreInvocation", "/h/pre.sh".to_string(), Signal::Working),
            ("Stop", "/h/stop.sh".to_string(), Signal::Done),
            ("PreToolUse", "/h/tool.sh".to_string(), Signal::Working),
        ];
        let out = agy_merge(&serde_json::json!({}), &cmds);
        let e = &out[AGY_HOOK_NAME];
        assert_eq!(e["enabled"], true);
        // Matcher-less events take handlers DIRECTLY. Wrapping them registers
        // an EMPTY command: visible in `agy -p "/hooks"`, and it fires nothing.
        assert_eq!(e["Stop"][0]["command"], "/h/stop.sh");
        assert_eq!(e["PreInvocation"][0]["command"], "/h/pre.sh");
        assert!(e["Stop"][0].get("hooks").is_none(), "Stop must NOT be wrapped");
        // Tool events do take the matcher group.
        assert_eq!(e["PreToolUse"][0]["hooks"][0]["command"], "/h/tool.sh");
        assert_eq!(e["PreToolUse"][0]["matcher"], "*");
    }

    #[test]
    fn agy_removal_is_a_delete_of_one_named_key() {
        let before = serde_json::json!({ "someone-elses-hook": { "enabled": true } });
        let after = agy_merge(&before, &[("Stop", "/h/stop.sh".to_string(), Signal::Done)]);
        assert!(after.get(AGY_HOOK_NAME).is_some());
        let back = agy_unmerge(&after).expect("ours to remove");
        assert_eq!(back, before, "another author's hook survives untouched");
        assert!(agy_unmerge(&before).is_none(), "nothing of ours, nothing to do");
    }

    #[test]
    fn agy_trust_adds_the_workspace_once_and_keeps_everything_else() {
        let before = serde_json::json!({
            "model": "m", "trustedWorkspaces": ["/Users/alice/a"], "statusLine": { "command": "x" },
        });
        let after = agy_with_trusted(&before, "/Users/alice/b").expect("new workspace");
        assert_eq!(after["trustedWorkspaces"], serde_json::json!(["/Users/alice/a", "/Users/alice/b"]));
        assert_eq!(after["model"], "m");
        assert_eq!(after["statusLine"], before["statusLine"]);
        assert!(agy_with_trusted(&after, "/Users/alice/b").is_none(), "already trusted, no write");

        let fresh = agy_with_trusted(&serde_json::json!({}), "/w").expect("no list yet");
        assert_eq!(fresh["trustedWorkspaces"], serde_json::json!(["/w"]));
        // A shape we do not understand is left alone rather than rewritten.
        assert!(agy_with_trusted(&serde_json::json!({ "trustedWorkspaces": "/w" }), "/x").is_none());
        assert!(agy_with_trusted(&serde_json::json!([]), "/x").is_none());
    }

    #[test]
    fn agy_trust_writes_settings_and_refuses_to_clobber_bad_json() {
        let dir = tempfile::tempdir().unwrap();
        agy_trust_workspace(dir.path(), "/w").unwrap();
        let path = dir.path().join("antigravity-cli/settings.json");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["trustedWorkspaces"], serde_json::json!(["/w"]));

        std::fs::write(&path, "{ not json").unwrap();
        assert!(agy_trust_workspace(dir.path(), "/x").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn agy_and_grok_both_write_to_the_pty_with_their_own_sequences() {
        let done = script_body("agy", Signal::Done);
        assert!(done.contains("$TERMIC_PTY"));
        assert!(done.contains(DONE_BODY), "hard done, no settle wait");
        let working = script_body("agy", Signal::Working);
        assert!(working.contains(WORKING_BODY));
        // agy is not grok and must not carry grok's provenance gate.
        assert!(!done.contains("GROK_HOOK_EVENT"));
        assert!(done.contains(r#"[ -n "$TERMIC_TASK_ID" ] || exit 0"#));
    }

    // ── opencode ────────────────────────────────────────────────────
    #[test]
    fn opencode_is_a_plugin_not_a_config_merge() {
        assert_eq!(schema_for("opencode"), Schema::PluginFile);
        // The documented plural ONLY. `.opencode/plugin` and
        // `.opencode/plugins` are both loaded, and writing both double-fires
        // every event (measured).
        assert_eq!(settings_rel("opencode"), "plugins/termic.js");
        assert!(!settings_rel("opencode").contains("plugin/"));
    }

    #[test]
    fn opencode_reports_all_four_edges_including_the_release() {
        let h = hooks_for("opencode");
        assert!(h.iter().any(|(e, s)| *e == "permission.asked" && *s == Signal::Attention));
        // The edge no other agent has: attention CLEARED, rather than inferred
        // from the next busy signal.
        assert!(h.iter().any(|(e, s)| *e == "permission.replied" && *s == Signal::Working));
        assert!(h.iter().any(|(e, s)| *e == "session.idle" && *s == Signal::Done));
        assert!(h.iter().any(|(e, s)| *e == "chat.message" && *s == Signal::Working));
    }

    #[test]
    fn the_opencode_plugin_can_never_throw_into_its_host() {
        let js = opencode_plugin_body();
        // In-process: no timeout, no exit code, and a throw in a tool handler
        // blocks the tool. Every handler must be wrapped.
        assert!(js.matches("try {").count() >= 3, "every handler needs its own try");
        assert!(js.contains("catch"), "and a catch that swallows");
        // Silent outside a termic pty, same rule as the shell scripts.
        assert!(js.contains("TERMIC_PTY") && js.contains("TERMIC_TASK_ID"));
        assert!(js.contains(&Signal::Attention.payload()));
        assert!(js.contains(WORKING_BODY) && js.contains(DONE_BODY));
        // No raw control bytes in a generated source file.
        assert!(!js.contains('\u{1b}') && !js.contains('\u{7}'));
    }

    // ── opencode 2 ──────────────────────────────────────────────────
    #[test]
    fn opencode_2_gets_a_tui_plugin_directory_beside_the_module() {
        let companions = plugin_companions("opencode");
        assert_eq!(companions.len(), 1);
        let (rel, body) = &companions[0];
        // A DIRECTORY under plugins/ holding `tui.js`: opencode 2 discovers TUI
        // plugins only as directories, and a top-level file there would be
        // handed to its server (the shared background service) instead.
        assert_eq!(*rel, "plugins/termic/tui.js");
        assert_eq!(Path::new(rel).parent(), Some(Path::new("plugins/termic")));
        // opencode 1 globs `{plugin,plugins}/*.{ts,js}`, one level deep, so the
        // module stays top-level and the TUI plugin never is.
        assert_eq!(Path::new(settings_rel("opencode")).parent(), Some(Path::new("plugins")));
        assert_eq!(body, &opencode_tui_plugin_body());
        // pi and omp have one module and nothing beside it.
        assert!(plugin_companions("pi").is_empty() && plugin_companions("omp").is_empty());
    }

    #[test]
    fn the_opencode_2_plugin_can_never_throw_into_its_host() {
        let js = opencode_tui_plugin_body();
        assert!(js.contains("export default {"), "opencode 2 loads `default` only");
        assert!(js.contains(r#"id: "termic""#) && js.contains("setup(ctx)"));
        // Every event handler goes through the one wrapper, which swallows.
        assert!(js.contains("never throw into opencode"));
        assert!(!js.contains("data.on(\"") && !js.contains("ctx.data.on("), "a handler bypassed the wrapper");
        assert!(js.contains("TERMIC_PTY") && js.contains("TERMIC_TASK_ID"));
        assert!(js.contains(&Signal::Attention.payload()));
        assert!(js.contains(WORKING_BODY) && js.contains(DONE_BODY));
        assert!(js.contains(&format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}")));
        assert!(!js.contains('\u{1b}') && !js.contains('\u{7}'));
    }

    /// The one module both opencode loaders read. opencode 1 takes
    /// `default.server`; opencode 2 refuses anything without `default.{id,
    /// setup}` and runs `setup` in its shared background service, where it
    /// must do nothing even with a $TERMIC_PTY (inherited from whichever task
    /// started that service). Runs the real module under node.
    #[test]
    #[cfg(unix)]
    fn the_opencode_module_loads_under_both_opencode_loaders() {
        use std::process::Command;
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("termic.mjs");
        let pty = dir.path().join("pty");
        std::fs::write(&plugin, opencode_plugin_body()).unwrap();
        std::fs::write(&pty, "").unwrap();
        let driver = dir.path().join("drive.mjs");
        std::fs::write(&driver, r#"
            const mod = await import(process.argv[2]);
            const d = mod.default;
            const ret = await d.setup({ client: {}, event: {}, session: {} });
            const hooks = await d.server({});
            console.log(JSON.stringify({
              keys: Object.keys(mod), id: d.id, server: typeof d.server, setup: typeof d.setup,
              setupReturned: ret === undefined, hooks: Object.keys(hooks).sort(),
            }));
        "#).unwrap();
        let out = Command::new("node").arg(&driver).arg(&plugin)
            .env("TERMIC_PTY", &pty).env("TERMIC_TASK_ID", "t1").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let got: Value = serde_json::from_slice(&out.stdout).unwrap();
        // Only `default`: opencode 1's fallback registers every export.
        assert_eq!(got["keys"], serde_json::json!(["default"]));
        assert_eq!(got["id"], "termic");
        assert_eq!(got["server"], "function");
        assert_eq!(got["setup"], "function");
        assert_eq!(got["setupReturned"], true);
        assert_eq!(got["hooks"], serde_json::json!(["chat.message", "chat.params", "event"]));
        assert_eq!(std::fs::read_to_string(&pty).unwrap(), "", "the server half wrote to a terminal");
    }

    /// Drives the opencode 2 TUI plugin under node against a fake TUI context
    /// shaped like `@opencode/plugin/tui`'s (`data.on`, `data.session`,
    /// `data.location.model`, `ui.router`, `ui.tabs`), with event payloads from
    /// opencode 2.2.5's schemas. Each step snapshots the pty, so a step's
    /// value is what it alone sent.
    #[test]
    #[cfg(unix)]
    fn the_opencode_2_plugin_follows_only_its_own_sessions() {
        use std::process::Command;
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("tui.mjs");
        let log = dir.path().join("log");
        let pty = dir.path().join("pty");
        std::fs::write(&plugin, opencode_tui_plugin_body()).unwrap();
        std::fs::write(&pty, "").unwrap();
        let driver = dir.path().join("drive.mjs");
        std::fs::write(&driver, r#"
            import { readFileSync, writeFileSync, appendFileSync } from "fs";
            const [,, plugin, pty, log] = process.argv;
            const mod = await import(plugin);
            const handlers = new Map();
            let route = { type: "home" };
            let tabs = [];
            const sessions = new Map();
            const models = [{ providerID: "acme", id: "small", limit: { context: 200000 } }];
            const ctx = {
              data: {
                on(type, fn) {
                  if (!handlers.has(type)) handlers.set(type, new Set());
                  handlers.get(type).add(fn);
                  return () => handlers.get(type).delete(fn);
                },
                session: {
                  get: (id) => sessions.get(id),
                  family: (id) => [id, ...[...sessions.keys()].filter((k) => sessions.get(k)?.parentID === id)],
                  status: (id) => sessions.get(id)?.status ?? "idle",
                },
                location: { model: { list: () => models, sync: async () => {} } },
              },
              ui: { router: { current: () => route }, tabs: { list: () => tabs } },
            };
            const cleanup = await mod.default.setup(ctx);
            const emit = (type, data) => { for (const fn of handlers.get(type) ?? []) fn({ id: "evt", type, data }); };
            const flush = () => new Promise((r) => setTimeout(r, 0));
            const step = async (name, fn) => {
              writeFileSync(pty, "");
              await fn();
              await flush();
              appendFileSync(log, name + "=" + JSON.stringify(readFileSync(pty, "utf8")) + "\n");
            };

            // Another task's session on the same shared service.
            await step("foreign", () => emit("session.execution.started", { sessionID: "ses_other" }));
            await step("foreign-perm", () => emit("permission.asked", { id: "per_x", sessionID: "ses_other" }));
            // This TUI's own.
            route = { type: "session", sessionID: "ses_a" };
            await step("start", () => emit("session.execution.started", { sessionID: "ses_a" }));
            // A subagent: its own execution edges never move the tab...
            sessions.set("ses_c", { parentID: "ses_a", status: "running" });
            await step("child-start", () => {
              emit("session.created", { sessionID: "ses_c", parentID: "ses_a" });
              emit("session.execution.started", { sessionID: "ses_c" });
            });
            // ...but its permission is the user's to answer.
            await step("perm", () => emit("permission.asked", { id: "per_1", sessionID: "ses_c" }));
            await step("beat-blocked", () => emit("session.text.delta", { sessionID: "ses_c" }));
            await step("replied", () => emit("permission.replied", { sessionID: "ses_c", requestID: "per_1", reply: "once" }));
            await step("form", () => emit("form.created", { form: { id: "frm_1", sessionID: "ses_a", title: "Pick" } }));
            await step("form-done", () => emit("form.replied", { id: "frm_1", sessionID: "ses_a", answer: {} }));
            await step("step-start", () => emit("session.step.started", {
              sessionID: "ses_a", assistantMessageID: "msg_1", agent: "build",
              model: { providerID: "acme", id: "small" }, started: 1 }));
            await step("ctx", () => emit("session.step.ended", {
              sessionID: "ses_a", assistantMessageID: "msg_1", finish: "stop", cost: 0,
              tokens: { input: 9189, output: 3, reasoning: 14, cache: { read: 1024, write: 0 } } }));
            await step("ctx-again", () => emit("session.step.ended", {
              sessionID: "ses_a", assistantMessageID: "msg_1", finish: "stop", cost: 0,
              tokens: { input: 9189, output: 3, reasoning: 14, cache: { read: 1024, write: 0 } } }));
            // The root finishes while its subagent still runs: held.
            await step("held", () => emit("session.execution.succeeded", { sessionID: "ses_a" }));
            sessions.get("ses_c").status = "idle";
            await step("child-done", () => emit("session.execution.succeeded", { sessionID: "ses_c" }));
            await step("wake", () => emit("session.execution.started", { sessionID: "ses_a" }));
            // The user navigated away: the turn is still this tab's.
            route = { type: "home" };
            await step("done", () => emit("session.execution.succeeded", { sessionID: "ses_a" }));
            await step("trailing", () => emit("session.text.delta", { sessionID: "ses_a" }));
            await step("again", () => emit("session.execution.succeeded", { sessionID: "ses_a" }));
            await step("restart", () => emit("session.execution.started", { sessionID: "ses_a" }));
            await step("interrupted", () => emit("session.execution.interrupted", { sessionID: "ses_a", reason: "user" }));
            // A session only in the tab list is not this TUI's: opencode keeps
            // one list per directory, shared by every TUI there, so it holds
            // another task's sessions when two tasks share a folder.
            tabs = [{ sessionID: "ses_u", active: false, busy: false, attention: false }];
            await step("tab-only-start", () => emit("session.execution.started", { sessionID: "ses_u" }));
            await step("tab-only-perm", () => emit("permission.asked", { id: "per_u", sessionID: "ses_u" }));
            await step("tab-only-done", () => emit("session.execution.succeeded", { sessionID: "ses_u" }));
            // Two of this TUI's own sessions at once: done waits for the last.
            route = { type: "session", sessionID: "ses_t" };
            await step("t-start", () => emit("session.execution.started", { sessionID: "ses_t" }));
            await step("a-start", () => emit("session.execution.started", { sessionID: "ses_a" }));
            await step("one-left", () => emit("session.execution.succeeded", { sessionID: "ses_a" }));
            await step("failed", () => emit("session.execution.failed", { sessionID: "ses_t", error: { type: "x", message: "m" } }));
            // An id termic would refuse never goes out as one.
            route = { type: "session", sessionID: "ses x;y" };
            await step("odd-start", () => emit("session.execution.started", { sessionID: "ses x;y" }));
            await step("odd-done", () => emit("session.execution.succeeded", { sessionID: "ses x;y" }));
            await cleanup();
            await step("disposed", () => emit("session.execution.started", { sessionID: "ses_a" }));
            appendFileSync(log, "handlers=" + [...handlers.values()].reduce((n, s) => n + s.size, 0) + "\n");
        "#).unwrap();
        let out = Command::new("node").arg(&driver).arg(&plugin).arg(&pty).arg(&log)
            .env("TERMIC_PTY", &pty).env("TERMIC_TASK_ID", "t1").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let log = std::fs::read_to_string(&log).unwrap();
        let at = |k: &str| {
            let line = log.lines().find(|l| l.starts_with(&format!("{k}="))).unwrap_or_else(|| panic!("no {k}: {log}"));
            serde_json::from_str::<String>(&line[k.len() + 1..]).unwrap_or_default()
        };
        let osc = |p: String| format!("\x1b]{p}\x07");
        let (working, done, attention) =
            (osc(Signal::Working.payload()), osc(Signal::Done.payload()), osc(Signal::Attention.payload()));
        let ctx = |b: &str| osc(format!("{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}{b}"));
        // A turn's root is the resume binding, reported when it changes.
        let started = |id: &str| format!("{working}{}", osc(format!("{NOTIFY_PREFIX}{SESSION_BODY_PREFIX}{id}")));

        assert_eq!(at("foreign"), "", "another task's session moved this tab: {log}");
        assert_eq!(at("foreign-perm"), "", "another task's permission rang here: {log}");
        assert_eq!(at("start"), started("ses_a"), "{log}");
        assert_eq!(at("child-start"), "", "a subagent's start is not a turn edge: {log}");
        assert_eq!(at("perm"), attention, "a subagent's permission is the user's: {log}");
        assert_eq!(at("beat-blocked"), "", "a heartbeat cleared a pending prompt: {log}");
        assert_eq!(at("replied"), working, "the release clears attention exactly: {log}");
        assert_eq!(at("form"), attention, "{log}");
        assert_eq!(at("form-done"), working, "{log}");
        assert_eq!(at("step-start"), "", "a heartbeat inside the throttle wrote: {log}");
        // opencode's footer formula: 9189 + 3 + 14 + 1024 + 0 over 200000.
        assert_eq!(at("ctx"), ctx("10230 200000 5"), "{log}");
        assert_eq!(at("ctx-again"), "", "the same reading twice: {log}");
        assert_eq!(at("held"), "", "done while a subagent still runs: {log}");
        assert_eq!(at("child-done"), "", "a subagent's done ended the turn: {log}");
        assert_eq!(at("wake"), working, "the same session reported twice: {log}");
        assert_eq!(at("done"), done, "navigating away dropped the done: {log}");
        assert_eq!(at("trailing"), "", "a trailing token re-asserted working: {log}");
        assert_eq!(at("again"), "", "one done per turn: {log}");
        assert_eq!(at("restart"), working, "{log}");
        assert_eq!(at("interrupted"), done, "{log}");
        assert_eq!(at("tab-only-start"), "", "a session only in the shared tab list moved this tab: {log}");
        assert_eq!(at("tab-only-perm"), "", "a session only in the shared tab list rang here: {log}");
        assert_eq!(at("tab-only-done"), "", "{log}");
        assert_eq!(at("t-start"), started("ses_t"), "{log}");
        assert_eq!(at("a-start"), started("ses_a"), "a turn back in the first session moves the binding: {log}");
        assert_eq!(at("one-left"), "", "done while another of this tab's sessions runs: {log}");
        assert_eq!(at("failed"), done, "a failed execution ends the turn: {log}");
        assert_eq!(at("odd-start"), working, "an id termic refuses was reported: {log}");
        assert_eq!(at("odd-done"), done, "{log}");
        assert_eq!(at("disposed"), "", "a handler outlived cleanup: {log}");
        assert!(log.contains("handlers=0"), "{log}");

        // Outside a termic pty it registers nothing at all.
        let out = Command::new("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(format!(
                "const m = await import({:?}); const n = []; \
                 const r = m.default.setup({{ data: {{ on: (t) => {{ n.push(t); return () => {{}}; }} }} }}); \
                 console.log(n.length, r === undefined);",
                plugin.to_string_lossy()
            ))
            .env("TERMIC_PTY", &pty).env_remove("TERMIC_TASK_ID").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0 true");
    }

    /// Runs the generated plugin for real under node, with the event shapes
    /// opencode 1.18.31 was measured sending, and reads what reached the pty.
    /// Skipped where there is no node (the plugin itself runs under opencode's
    /// bundled runtime, not node, but the module is plain ESM either way).
    #[test]
    #[cfg(unix)]
    fn the_opencode_plugin_reports_the_context_window_the_way_its_tui_does() {
        use std::process::Command;
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("termic.mjs");
        let pty = dir.path().join("pty");
        std::fs::write(&plugin, opencode_plugin_body()).unwrap();
        std::fs::write(&pty, "").unwrap();
        let driver = dir.path().join("drive.mjs");
        std::fs::write(&driver, r#"
            const { default: { server: TermicStatus } } = await import(process.argv[2]);
            const client = { config: { providers: async () => ({ data: { providers: [
              { id: "acme", models: { "big": { limit: { context: 400000 } } } },
            ] } }) } };
            const h = await TermicStatus({ client });
            const info = (tokens, modelID = "small") => ({ type: "message.updated", properties: { info: {
              role: "assistant", providerID: "acme", modelID, tokens } } });
            await h["chat.params"]({ model: { providerID: "acme", id: "small", limit: { context: 200000 } } });
            // The first update of a message is all zeros: no reading.
            await h.event({ event: info({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) });
            await h.event({ event: info({ input: 9189, output: 3, reasoning: 14, cache: { read: 1024, write: 0 } }) });
            // The same figure again writes nothing.
            await h.event({ event: info({ input: 9189, output: 3, reasoning: 14, cache: { read: 1024, write: 0 } }) });
            // A model chat.params never named: the limit comes from providers().
            await h.event({ event: info({ input: 100000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, "big") });
            await h.event({ event: info({ input: 100000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, "big") });
            // A user message is not a reading.
            await h.event({ event: { type: "message.updated", properties: { info: { role: "user", tokens: { output: 5 } } } } });
        "#).unwrap();
        let out = Command::new("node")
            .arg(&driver).arg(&plugin)
            .env("TERMIC_PTY", &pty).env("TERMIC_TASK_ID", "t1")
            .output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let got = std::fs::read_to_string(&pty).unwrap();
        let ctx = |b: &str| format!("\x1b]{NOTIFY_PREFIX}{CONTEXT_BODY_PREFIX}{b}\x07");
        // writeFileSync truncates, so the file holds the LAST write only.
        assert_eq!(got, ctx("100010 400000 25"));
        // And the first reading, run on its own, is opencode's formula.
        std::fs::write(&pty, "").unwrap();
        std::fs::write(&driver, r#"
            const { default: { server: TermicStatus } } = await import(process.argv[2]);
            const h = await TermicStatus({});
            await h["chat.params"]({ model: { providerID: "acme", id: "small", limit: { context: 200000 } } });
            await h.event({ event: { type: "message.updated", properties: { info: { role: "assistant",
              providerID: "acme", modelID: "small",
              tokens: { input: 9189, output: 3, reasoning: 14, cache: { read: 1024, write: 0 } } } } } });
        "#).unwrap();
        let out = Command::new("node")
            .arg(&driver).arg(&plugin)
            .env("TERMIC_PTY", &pty).env("TERMIC_TASK_ID", "t1")
            .output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_to_string(&pty).unwrap(), ctx("10230 200000 5"));
    }

    /// opencode's turn ends on the FINAL assistant message, not on
    /// `session.idle` (which waits for the title call), and a trailing part
    /// update does not put it back to working. Runs the real module.
    #[test]
    #[cfg(unix)]
    fn the_opencode_plugin_ends_the_turn_on_the_final_message() {
        use std::process::Command;
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("termic.mjs");
        let log = dir.path().join("log");
        let pty = dir.path().join("pty");
        std::fs::write(&plugin, opencode_plugin_body()).unwrap();
        std::fs::write(&pty, "").unwrap();
        let driver = dir.path().join("drive.mjs");
        // The plugin truncates the target on every write, so the driver
        // snapshots it after each step: the snapshot is the LAST thing sent.
        std::fs::write(&driver, r#"
            import { readFileSync, writeFileSync, appendFileSync } from "fs";
            const [,, plugin, pty, log] = process.argv;
            const { default: { server: TermicStatus } } = await import(plugin);
            const h = await TermicStatus({});
            const step = async (name, fn) => {
              writeFileSync(pty, "");
              await fn();
              appendFileSync(log, name + "=" + JSON.stringify(readFileSync(pty, "utf8")) + "\n");
            };
            const msg = (id, extra) => ({ event: { type: "message.updated", properties: { info: {
              role: "assistant", id, providerID: "p", modelID: "m", tokens: { output: 0 }, ...extra } } } });
            await step("submit", () => h["chat.message"]());
            await step("tool", () => h.event(msg("m1", { time: { completed: 1 }, finish: "tool-calls" })));
            await step("final", () => h.event(msg("m2", { time: { completed: 2 }, finish: "stop" })));
            await step("trailing", () => h.event({ event: { type: "message.part.updated" } }));
            await step("again", () => h.event(msg("m2", { time: { completed: 2 }, finish: "stop" })));
        "#).unwrap();
        let out = Command::new("node").arg(&driver).arg(&plugin).arg(&pty).arg(&log)
            .env("TERMIC_PTY", &pty).env("TERMIC_TASK_ID", "t1").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let log = std::fs::read_to_string(&log).unwrap();
        let at = |k: &str| log.lines().find(|l| l.starts_with(&format!("{k}="))).unwrap().to_string();
        let done = Signal::Done.payload();
        let working = Signal::Working.payload();
        assert!(at("submit").contains(&working), "{log}");
        assert!(!at("tool").contains(&done), "a tool-call message is not the end: {log}");
        assert!(at("final").contains(&done), "the final message ends the turn: {log}");
        assert_eq!(at("trailing"), "trailing=\"\"", "a trailing part re-asserted working: {log}");
        assert_eq!(at("again"), "again=\"\"", "one done per message: {log}");
    }

    #[test]
    fn read_settings_refuses_malformed_json_rather_than_replacing_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, b"{ not json").unwrap();
        assert!(read_settings(&p).is_err());
        // Missing and empty both mean "nothing yet", not an error.
        std::fs::write(&p, b"").unwrap();
        assert_eq!(read_settings(&p).unwrap(), serde_json::json!({}));
        assert_eq!(
            read_settings(&dir.path().join("nope.json")).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn write_atomic_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        write_atomic(&p, b"{}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{}\n");
        let strays: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("termic-tmp"))
            .collect();
        assert!(strays.is_empty(), "temp file left behind");
    }

    // ── omp ─────────────────────────────────────────────────────────
    #[test]
    fn omp_is_a_plugin_with_pis_layout_and_its_own_edges() {
        assert_eq!(schema_for("omp"), Schema::PluginFile);
        // The pi layout: the active agent dir's extensions/, which for omp is
        // `~/.omp/agent/extensions/` (config root + `agent`).
        assert_eq!(settings_rel("omp"), "agent/extensions/termic.ts");
        assert!(SUPPORTED.contains(&"omp"));
        let h = hooks_for("omp");
        assert!(h.iter().any(|(e, s)| *e == "tool_approval_requested" && *s == Signal::Attention));
        // The release edge, like opencode's permission.replied: attention
        // CLEARED rather than inferred from the next busy signal.
        assert!(h.iter().any(|(e, s)| *e == "tool_approval_resolved" && *s == Signal::Working));
        // Done is agent_end here, not pi's agent_settled: omp has no settle
        // event; the plugin guards on AgentEndEvent.willContinue instead.
        assert!(h.iter().any(|(e, s)| *e == "agent_end" && *s == Signal::Done));
    }

    #[test]
    fn the_omp_plugin_never_signals_with_raw_133_or_carries_prose() {
        let js = omp_extension_body();
        assert!(js.matches("try {").count() >= 3, "every handler needs its own try");
        assert!(js.contains("catch"), "and a catch that swallows");
        assert!(js.contains("TERMIC_PTY") && js.contains("TERMIC_TASK_ID"));
        assert!(js.contains(&Signal::Attention.payload()));
        assert!(js.contains(WORKING_BODY) && js.contains(DONE_BODY));
        assert!(js.contains(SESSION_BODY_PREFIX), "the resume binding: omp cannot be told an id at launch");
        // willContinue is the done guard: an auto-retry continuation must not
        // settle the turn (shared-events.ts: "must not ... terminal settle").
        assert!(js.contains("willContinue"));
        // The muse trap: omp runs subagents in-process under their own id.
        assert!(js.contains("agent.kind"), "subagent sessions must be dropped");
        // No raw control bytes in a generated source file.
        assert!(!js.contains('\u{1b}') && !js.contains('\u{7}'));
    }

    /// Runs the generated omp extension for real under node's type stripping,
    /// dispatching the event shapes omp 18.6.0 was measured sending, and reads
    /// what reached the pty. Skipped where there is no node (the extension
    /// itself runs under omp's Bun runtime, but the module strips either way).
    #[test]
    #[cfg(unix)]
    fn the_omp_extension_reports_edges_context_and_session_to_the_pty() {
        use std::process::Command;
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let ext = dir.path().join("termic.ts");
        let pty = dir.path().join("pty");
        std::fs::write(&ext, omp_extension_body()).unwrap();
        std::fs::write(&pty, "").unwrap();
        let driver = dir.path().join("drive.mjs");
        // Each event: clear the pty, dispatch, read what the event wrote. A
        // regular file does not append across O_WRONLY opens, so the read
        // sees the event's LAST send; two-send events assert their tail and
        // the other body is pinned elsewhere (session_start's context write
        // is asserted by turn_end's).
        std::fs::write(&driver, format!(r#"
            import {{ readFileSync, writeFileSync }} from "node:fs";
            const mod = await import(process.argv[2]);
            const handlers = {{}};
            const pi = {{ on: (event, fn) => {{ (handlers[event] ??= []).push(fn); }} }};
            await mod.default(pi);
            const dispatch = async (event, payload, ctx) => {{
                writeFileSync(process.env.TERMIC_PTY, "");
                for (const h of handlers[event] ?? []) await h(payload, ctx);
                return readFileSync(process.env.TERMIC_PTY, "utf8");
            }};
            const usage = (tokens, window, percent) => ({{ getContextUsage: () => ({{ tokens, contextWindow: window, percent }}) }});
            const ctxMain = {{ ...usage(5788, 1000000, 0.5788), agent: {{ kind: "main", id: "Main" }},
                sessionManager: {{ getSessionId: () => "01a10783-4ba0-7000-a311-9f53ffa13147" }} }};
            // The turn GROWS the context (probe: 5788 → 6717 on the resume
            // turn); turn_end reports the new figure. usage() spreads LAST
            // so its getContextUsage wins the override.
            const ctxTurn = {{ ...ctxMain, ...usage(6717, 1000000, 0.6717) }};
            const ctxSub = {{ agent: {{ kind: "sub", id: "0-Explore" }} }};
            const reads = [];
            reads.push(["session_start", await dispatch("session_start", {{}}, ctxMain)]);
            reads.push(["before_agent_start", await dispatch("before_agent_start", {{}}, ctxMain)]);
            reads.push(["turn_end", await dispatch("turn_end", {{}}, ctxTurn)]);
            reads.push(["approval_requested", await dispatch("tool_approval_requested", {{ toolName: "write" }}, ctxMain)]);
            reads.push(["approval_resolved", await dispatch("tool_approval_resolved", {{ toolName: "write", approved: true }}, ctxMain)]);
            reads.push(["ask", await dispatch("tool_execution_start", {{ toolName: "ask" }}, ctxMain)]);
            reads.push(["tool_result", await dispatch("tool_result", {{ toolName: "ask" }}, ctxMain)]);
            reads.push(["agent_end_will_continue", await dispatch("agent_end", {{ willContinue: true, messages: [] }}, ctxMain)]);
            reads.push(["agent_end", await dispatch("agent_end", {{ willContinue: false, messages: [] }}, ctxTurn)]);
            reads.push(["sub_working", await dispatch("before_agent_start", {{}}, ctxSub)]);
            reads.push(["sub_agent_end", await dispatch("agent_end", {{ messages: [] }}, ctxSub)]);
            reads.push(["ctx_dedup", await dispatch("turn_end", {{}}, ctxTurn)]);
            console.log(JSON.stringify(reads));
        "#)).unwrap();
        let out = Command::new("node")
            .arg("--experimental-strip-types")
            .arg(&driver).arg(&ext)
            .env("TERMIC_PTY", &pty).env("TERMIC_TASK_ID", "t1")
            .output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let reads: Vec<(String, String)> = serde_json::from_slice(&out.stdout).unwrap();
        let body = |b: &str| format!("\x1b]{NOTIFY_PREFIX}{b}\x07");
        let expect: Vec<(&str, String)> = vec![
            // session_start sends context THEN the id; a regular file holds
            // the last, so the id is the observable one here.
            ("session_start", body("session 01a10783-4ba0-7000-a311-9f53ffa13147")),
            ("before_agent_start", body(WORKING_BODY)),
            // The turn's new reading: 6717/1000000 → "6717 1000000 1".
            ("turn_end", body(&format!("{CONTEXT_BODY_PREFIX}6717 1000000 1"))),
            ("approval_requested", body(ATTENTION_BODY)),
            ("approval_resolved", body(WORKING_BODY)),
            ("ask", body(ATTENTION_BODY)),
            // An answered ask hands Working back EXACTLY (the awaiting flag),
            // not on the next heartbeat: without this the tab stays needs-you
            // for up to the 2s heartbeat after the user answers.
            ("tool_result", body(WORKING_BODY)),
            // willContinue: the session scheduled a continuation — NOT a
            // settle, per omp's own event docs.
            ("agent_end_will_continue", String::new()),
            // The real settle: the handler reports the session id FIRST and
            // then done — two writes per event. On a real pty they append
            // (stream, no file offset); on the regular file this driver uses,
            // the second open rewinds to 0 and overwrites, leaving the tail
            // of the session body visible after the done body. Assert that
            // exact composition: it proves BOTH writes fired, in that order.
            ("agent_end", {
                let s = body("session 01a10783-4ba0-7000-a311-9f53ffa13147");
                let d = body(DONE_BODY);
                format!("{d}{}", &s[d.len()..])
            }),
            // A subagent's edges move nothing — the muse trap.
            ("sub_working", String::new()),
            ("sub_agent_end", String::new()),
            // The same context figure writes nothing the second time.
            ("ctx_dedup", String::new()),
        ];
        for ((label, want), (got_label, got)) in expect.iter().zip(reads.iter()) {
            assert_eq!(label, got_label, "driver order changed");
            assert_eq!(want, got, "event {label} wrote the wrong thing");
        }
    }
}


