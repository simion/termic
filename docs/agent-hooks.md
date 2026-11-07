# Agent hooks

How termic learns what an agent is doing from the agent itself, instead of
reading its terminal. On by default since the one-time
`migrate_hooks_auto_default` flip ("Install hooks for every agent"), per
agent, installed globally into that agent's own config. The switch and the
coverage count are Settings → Agents & Terminals → Agent hooks; each agent's
own install, removal and the disclosure of what it writes are on that agent's
card, under Agent state (docs/ui.md "Settings: where a feature's row belongs").

The state machine this feeds (`working` / `attention` / `done`, the settle
timer, the demoters) lives in `TerminalPane`; this doc covers the hook half and
the measurements that decided it. Generation is
`src-tauri/src/agent_hooks.rs`, the OSC contract is `src/lib/agentHooks.ts`.

## Why not read the terminal

The fallback path infers state from the title (OSC 0/2), from OSC 9
notifications and OSC 9;4 progress where an agent sends them, and otherwise
from heuristics: 4s of PTY silence, a stable scrollback, an unchanged viewport
hash. It is usually right. Two measurements say "usually" is not enough:

- **Blocked reads as finished.** Claude paints its IDLE glyph while blocked on
  a permission prompt, a question, or plan approval (measured on 2.1.250). The
  false `done` fires at `SETTLE_MS`, about a second before the honest OSC 9
  arrives.
- **Running reads as finished.** Over an 8.5 minute run with four real
  subagents, the title claimed idle for **154s, 30% of the window**, while
  claude's own `Stop` correctly stayed silent throughout. This is the
  "long subagent run reports done early" bug.

The screen-text guard meant to catch the second matched **twice** in those 8.5
minutes: claude had changed its wording. A text heuristic aimed at a moving
target.

## What is installed, per agent

| agent | ready | working | attention | done | interrupt |
| --- | --- | --- | --- | --- | --- |
| claude | `SessionStart` | `UserPromptSubmit`, `PreToolUse` | `PermissionRequest` | `Stop`, guarded on the `background_tasks` whitelist, which REPORTS what it holds for (see Delegated work) | none exists |
| grok | not measured | `UserPromptSubmit`, `PreToolUse` | `Notification` | `Stop` + `StopCancelled`, `Stop` guarded on `backgroundTasks` (see Delegated work) | `StopCancelled` |
| agy | not measured | `PreInvocation` | none exists (see below) | `Stop`, guarded on `fullyIdle`, which reports an unlabelled hold | none exists |
| opencode 1 | not measured | `chat.message`, `permission.replied` | `permission.asked` | the final assistant `message.updated`, `session.idle` as the backstop | `session.idle`, on the SECOND escape |
| opencode 2 (read from 2.2.5 source, not measured) | none | `session.execution.started` on a root, `permission.replied`, `form.replied` / `form.cancelled` | `permission.asked`, `form.created` | `session.execution.succeeded` / `.failed` on a root, held while a direct subagent runs | `session.execution.interrupted` |
| codex | `SessionStart` | `UserPromptSubmit`, `PreToolUse` | none: the `Action Required` title (see below) | `Stop` | none exists |
| devin | `SessionStart` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `PermissionRequest`, plus `PreToolUse` on `ask_user_question` | `Stop` | none exists |
| copilot | none (trust dialog precedes `sessionStart`) | `userPromptSubmitted`, `preToolUse`, `postToolUse` | `permissionRequest` | `agentStop` | none exists |
| pi | none (`session_start` precedes the input box) | `before_agent_start`, `tool_call` | `ui_prompt_start` (an extension's own prompt; pi has no permission prompts) | `agent_settled` | none exists |
| omp | none (`session_start` fires at startup, before the composer) | `before_agent_start`, `tool_call` | `tool_approval_requested`, plus `tool_execution_start` on `ask` | `agent_end`, guarded on `willContinue` | none exists |
| muse | none (`SessionStart` is lazy) | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `PermissionRequest` | `Stop` | none exists |

Three install shapes are new with copilot, pi and muse (GH #277 follow-up):

- **copilot** gets its NATIVE hook file, `~/.copilot/hooks/termic.json`
  (`{"version":1,"hooks":{"<event>":[{"type":"command","bash":…}]}}`), which
  copilot loads alongside any other `hooks/*.json`. It is ours outright, so
  removal is a delete. Measured on 1.0.86: every event fires with
  `TERMIC_PTY` / `TERMIC_TASK_ID` intact, in `-p` and in the TUI, and
  `permissionRequest` fires even under `--allow-all-tools`. A `preToolUse`
  hook that ERRORS denies the tool, which is one more reason every script
  here exits 0.
- **pi** is a plugin-file agent like opencode: one TypeScript extension at
  `~/.pi/agent/extensions/termic.ts`, autoloaded and transpiled by pi itself,
  running in-process (so the env is simply pi's). Done is `agent_settled`,
  not `agent_end`, because pi can still auto-retry or compact after
  `agent_end`.
- **omp** (oh-my-pi) is pi's rewritten fork and kept the plugin transport:
  the same `~/.omp/agent/extensions/termic.ts`, the same
  `pi.on(event, (payload, ctx))` surface, the same
  `ctx.getContextUsage()` shape. Measured live on 18.6.0 with a probe
  extension that logged every payload. What moved against pi:
  - **No `agent_settled`.** Done is `agent_end`, suppressed while the
    event's `willContinue` flag is truthy — omp's own docs say a subscriber
    "must not treat this as a user-visible terminal settle" when a
    continuation (auto-retry and friends) is already scheduled.
  - **No `ui_prompt_*`.** Attention is `tool_approval_requested`, which
    wrapper.ts emits only when a tool genuinely needs a prompt
    (`approvalCheck.required`), so yolo runs never false-attention — plus
    `tool_execution_start` with `toolName === "ask"`, the same edge omp's
    own Warp bridge maps to `question_asked`. On a STOCK install none of
    this ever fires: `tools.approvalMode` defaults to `"yolo"` (measured: a
    write inside AND outside the workspace executed unasked, TUI and `-p`
    both). It is wired anyway so the setting stays honest for a user who
    raises it.
  - **Subagents run in-process** with `ctx.agent.kind` of `"main"` or
    `"sub"`; every handler drops non-main sessions (the muse trap).
  - **The session id is reported** (`session <uuid>` on `session_start`,
    `session_switch` and `agent_end`): omp mints its own UUIDv7 at startup,
    nothing accepts one at launch, and `session_start` fires at startup —
    earlier than opencode's lazy mint, so there is no capture backstop
    command either (omp's only lister is an interactive picker).
  - **An agent's own notifications:** omp sends `OSC 9;omp: Complete` once
    per clean turn (completion.notify defaults on; termic's iTerm2 spoof
    picks the OSC 9 channel). Anchored in `BUILTIN_NOTIFY_IGNORE`. Its
    other body, `omp: Stopped with error`, is deliberately NOT ignored — a
    died turn should ring.
  - **Why not omp's Warp protocol:** omp also ships a structured channel,
    `WARP_CLI_AGENT_PROTOCOL_VERSION=1` in the env → OSC 777
    `notify;warp://cli-agent;{json}` frames with events `stop`,
    `stop_failure`, `permission_request`, `question_asked` (attention set
    per its own tests). Zero-install state detection is tempting, but it
    would mean a second Rust parser and a second event contract beside the
    plugin transport that already covers the same states — the bespoke
    mechanism the runbook forbids when a unified one exists. Rejected;
    this paragraph is the record so nobody re-investigates.
- **muse** needs its MANAGED hook file, see below.
- **opencode 2** gets a second file, see "opencode 2" below. The module
  both versions load stays `~/.config/opencode/plugins/termic.js`.

**Ready is the only signal that is not a correction.** Everything else here
replaces a state the terminal reports WRONG. Ready reports one the terminal
cannot express at all: whether a typed message will reach the agent's input
box. A blocking startup dialog paints and then goes quiet, which is
byte-for-byte what a waiting input box looks like, so every quiet-based
heuristic calls it ready.

The measured case is claude's trust picker: a repo claude has never run in gets
`Is this a project you created or one you trust?` with `No, exit` HIGHLIGHTED,
and no hook fires while it is up, not even `SessionStart`.

Trust resolves through the REPO, not the directory. A worktree of an
already-trusted repo inherits it and is given no record of its own, so this is
NOT an every-task event: it is the first task in a project just added to
termic, or on a machine where claude only ever runs through termic. Measured
both ways (standalone `git init` prompts, `git worktree add` off a trusted repo
does not) after the opposite was assumed and written down here. termic's first-message path waited out its 3s floor, saw
quiet, typed the prompt into the picker and sent the submit 450ms later, which
confirmed the highlighted option: the agent EXITED. One injection, no retry
needed. That is why a retry loop is not a fix on its own here, and why
`seedPromptWhenReady` refuses to type at all when an agent that reports
readiness has not reported it (`lib/agentReady`, outcome `blocked`).

Ready reuses OSC 777 `notify` with the trusted `termic` title, and is told
apart from attention by its BODY alone (`HOOK_OSC_READY_BODY` in
`lib/agentHooks.ts`, pinned on both sides). No new OSC id to parse, and it
inherits the v3 three-target write that makes hooks work inside Docker.

Only claude registers it. The other agents have plausible-looking candidate
events, but a guessed event name installs a hook that never fires and is
indistinguishable from one that does. They keep the echo fallback below.

**Agents without hooks are not left on the old behaviour.** `deliverMessage`
takes a `verifyEcho` option, used by the first-message path only: it writes the
text, watches the PTY for the agent echoing it back, and sends the submit only
if it does. An input box echoes what you type; a selection list does not. That
is a discriminator rather than another timer, and it is what protects an agent
whose hooks are not installed. The queue does NOT use it: a queued message is
only ever sent after a turn ended, which already proves the agent was at its
input box.

Codex is excluded from the ECHO fallback specifically, and only that: its title
already says `Action Required` at +22ms, so a first message typed into it does
not need the echo check. It is a full hooks agent otherwise (see below).

**Muse Code's ORDINARY hooks cannot use this transport; its managed hooks can
(1.3.0).** The history is kept because the ordinary path is still dead. It has a hooks system and it looks like an easy win: the config is
claude-shaped, lives at `~/.config/muse/settings.json` (needs
`"schema_version": 1`, or muse rejects the whole file), and `SessionStart`,
`UserPromptSubmit`, `Stop`, `PreLLMCall` and `PostLLMCall` all fire, every
payload carrying `session_id`. Two things kill it, both checked against a live
1.0.2 through its offline `--provider echo`:

- **Muse strips the environment it hands a hook.** `HOME` survives;
  `TERMIC_PTY`, `TERMIC_TASK_ID` and an arbitrary probe variable all arrive
  EMPTY. Every script here opens with `[ -n "$TERMIC_TASK_ID" ] || exit 0` and
  writes to `$TERMIC_PTY`, so all of them would exit 0 having written nothing,
  silently. Setting `shell_environment_policy` (`inherit: all`,
  `include_only: ["TERMIC_.*"]`) does not change it, so that policy governs the
  agent's own shell tool and not hook commands. The Docker fallbacks do not
  rescue it either: `/proc/1/fd/1` is Linux-only and `/dev/tty` fails for a hook
  with no controlling terminal.
- **`SessionStart` is lazy.** It does not fire at startup; it fires on the FIRST
  PROMPT. Nothing had arrived 12s into an idle session, and it landed the moment
  a prompt was submitted. Its own payload says `source: "startup"`, which makes
  this easy to get backwards. So it could not be the readiness gate that earns
  claude's `Ready` signal even if the transport worked.

None of which is urgent, because muse is the rare agent whose TITLE already
carries real state: a braille spinner prefix while the model runs, the bare
workspace basename when idle, both captured off a live PTY. The title path
classifies it unaided, and unlike codex it never puts its final message on an
`OSC 9` (a full capture shows `OSC 0`, `4`, `10` and `11` only), so it has none
of the end-of-turn bell problem either. What hooks would add is the attention
state, which is the one thing its title was not measured for.

**What changed in 1.3.0: managed hooks.** Two top-level keys in
`~/.config/muse/settings.json`, `managed_hooks_path` (a file with a
claude-shaped `{"hooks":{…}}`) and `managed_hooks_env_vars` (a list of NAMES),
make muse forward exactly those variables to the hooks in that file and to no
others. Measured end to end: with the keys set, an OSC 777 written by a managed
hook reached a live interactive TUI's pty; with the env key removed, the same
hooks lost both variables again. So termic writes its hook file into its own
script dir (`termic-hooks/managed-hooks.json`) and claims the two keys, only
when `managed_hooks_path` is free or already ours, since it is a single slot an
enterprise policy may hold. Unlike a status line slot this one is the
TRANSPORT, so an install that cannot claim it FAILS rather than reporting on.
Two traps: a glob like `TERMIC_*` in the env list makes muse refuse to start
(exit 1), and muse runs hooks for its own internal subagents under their own
`session_id`, so every script drops a payload whose id is not a UUIDv7 (the
main session's; subagents get v4). Without that filter a subagent's `Stop`
ends the tab's turn early.

**Muse Code is also the case the echo guard cannot cover, and the reason
`UNATTENDED_SPAWN_ARGS` grew a third entry.** Muse has a trust picker too
(`Do you trust this workspace?`, options `1 Trust and continue` / `2 Quit`),
but unlike claude's it is keyed by DIRECTORY rather than by repo, so it is a
genuinely every-task event: measured, a `git worktree add` off an
already-trusted repo prompts again. The part that defeats the guard is which
keys the picker binds. `n` selects `Quit` and a SPACE confirms it, so the
prompt "rename the button" exits the agent partway through being typed, with
no Enter involved at all. The guard withholds the submit, which is the wrong
end: by then the damage is done. Measured both ways on a live 1.0.2, no Enter
sent in any of them: `hello world` and `add a test` leave the picker up, while
`rename the button` and a bare `n` then space exit.

So the unattended path passes `--trust-workspace`, muse's own flag for this.
It trusts for THAT RUN ONLY (verified: the same directory prompts again on the
next spawn without the flag), so an unattended launch cannot quietly leave a
workspace trusted afterwards, and an attended spawn still gets the picker and
answers it itself. A caged task never sees any of this: `isTaskCaged(task) ||
task.yolo` means it always gets `--yolo`, which trusts the workspace for the
run as a side effect of dropping approval.

**Devin is a claude-shaped hooks agent whose session ids are slugs.** The
config is `~/.config/devin/config.json`, a shared user file like claude's
`settings.json`, with the same `"hooks"` map and the same entry shape
(`statusMessage` included — verified live: the hook fires with it present).
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PermissionRequest` and `Stop` all fire in `-p` mode and in the TUI, and every
payload carries `session_id`. Measured on 3000.10.21:

- **`session_id` is a slug, not a UUID** — `brassy-polish`, not
  `aaaaaaaa-…`. It is exactly what `devin --resume` wants, so the ready
  script reports it through the same OSC channel codex uses and the tab
  stores it verbatim. The charset guard is slug-shaped (first byte
  alphanumeric, then `[0-9a-zA-Z_-]*`): a leading dash or a shell metachar
  is dropped, never escaped, because the value lands in a `--resume <id>`
  command line. `devin list --format csv | tail -n +2 | head -1 | cut -d, -f1`
  is the post-launch backstop for when hooks are off; plain `devin list` is
  an interactive picker and captures nothing.
- **`Stop` has `stop_hook_active` but no `background_tasks`**, so it takes
  the plain done body — devin runs no claude-style background agents that
  would need the whitelist.
- **`ask_user_question` never emits `PermissionRequest`.** The question is
  auto-decided and routed to an elicitation panel, so while it sits blocking,
  the only event on the wire is `PreToolUse`. The Working script reads
  `hook_event_name` and `tool_name` and reports attention for exactly that
  pair; `PostToolUse` on the same tool hands working back when the answer
  lands. Without this the tab spins through the whole wait.
- **The title carries no state.** A live turn flips `devin: <dir>` to
  `devin: <prompt>` to `devin: <generated title>` and emits no `OSC 9`
  anywhere, including on a permission prompt. Signals stay empty and hooks
  are the only state source.
- **The trust picker blocks an unattended first prompt.** A directory devin
  has never run in gets `Yes, trust / No, exit` and it eats the injected
  prompt's keystrokes, so the unattended path passes
  `--respect-workspace-trust false`. The flag trusts for that run only
  (verified: the next spawn without it prompts again), so it cannot leave a
  workspace trusted afterwards.

**`PreToolUse` is a heartbeat, not a duplicate.** Working is the only sustained
state here; every other signal is an edge. The title re-asserted working on
every repaint, so anything that wrongly cleared the spinner self-healed within
a frame. A single `UserPromptSubmit` made the same clear permanent for the rest
of the turn: a user clicking into a running task had its spinner dropped and
nothing ever put it back. A tool call is the protocol's own "still going".

agy is the exception twice over: `PreInvocation` already fires per model
invocation, and its `PreToolUse` documents `decision` as REQUIRED, so observing
it silently risks blocking the tool.

**Done and attention get no heartbeat.** A turn ends once, and repeating it
would re-badge something the user just dismissed. There is a test saying so.

## claude reports its session id only when it moves (GH #306)

termic tells claude which session to run (`--session-id` on a first spawn,
`--resume <id>` afterwards) and stores that id per tab. That was the whole
story until `/clear`: it starts a NEW session with a new id inside the same
process, and `/resume` switches to another. Everything after either lands under
an id the tab never stored, so a relaunch resumed the session from before the
`/clear`, and the agent said it had never worked on what the tab was doing.
Every relaunch brought the original back and every `/clear` after it left one
more branch nobody could find.

claude's READY script (its `SessionStart`) therefore also reports the id, over
the same `session <id>` OSC codex and devin use, but only when the session
moved. Measured on 2.1.273 with a hook logging its stdin and env:

| Action | `source` | `session_id` | `CLAUDE_CODE_ENTRYPOINT` |
|---|---|---|---|
| startup | `startup` | S1 | `cli` |
| `/compact` | `compact` | S1, unchanged | `cli` |
| `/clear` | `clear` | new every time | `cli` |
| `/resume <S1>` | `resume` | S1, the resumed one | `cli` |
| `/compact` on an empty conversation | no event | | |
| `claude -p` inside the agent | `startup` | its own | `sdk-cli` |

So the id is sent for `clear`, `resume` and `compact`, never for `startup`
(termic passed that id itself), and only when the entrypoint is `cli`. The
entrypoint half is what keeps a nested `claude -p` out: it inherits
`TERMIC_TASK_ID` and `TERMIC_PTY`, so its hook writes into this tab's terminal,
and claude sets its entrypoint to `sdk-cli` even when the parent env says
`cli`. `CLAUDE_CODE_CHILD_SESSION` is no use as a nesting signal: claude sets it
for every hook subprocess, the main session's included. An interactive claude
started from inside the agent and then cleared is not covered; the agent has no
interactive terminal to start one in.

The id lands on the tab whose terminal it arrived in (`TERMIC_PTY` is per
spawn), keyed by tab id, so several agent tabs in one task, in any order, each
keep their own. Unless another tab already holds it: a
main-checkout task's picker (or a `/resume`) lists its siblings' sessions, and
storing one of those swapped the two tasks, so it is dropped with a toast
naming the owner (`sessionHolder`, see
[adding-an-agent.md](adding-an-agent.md) "When a stored id stops resolving"). On the TypeScript side a reported id also supersedes the id the
spawn minted: that one is only held once the spawn survives `RESUME_FAILURE_MS`
and only persisted on the first prompt, so a `/clear` before either used to be
undone by the next Enter (`sessionReportedRef` in `TerminalPane`).

## claude's attention body names the tool, because that body is the one you read

The hook wins the race and therefore composes the banner. Measured: it fires the
instant claude blocks, and claude's own `OSC 9` ("Claude needs your permission")
arrives a further **6.0s** behind it, by which point the notification has been
delivered and cannot be edited. Raising a second one for the same prompt is the
GH #276 bug, so the agent's own wording only ever reaches the badge.

So the hook says the more useful thing, since it knows something claude's own
notification does not mention: which tool is being asked about. The body is
`needs your permission: Bash`, or `needs your permission: mcp__github__create_pr`,
which is the case that earns the feature (a bare "needs your permission" tells
you nothing when six MCP servers could be asking).

`tool_name` is claude's documented field for the tool events, `PermissionRequest`
included, read out of 2.1.259's own embedded hooks reference (`session_id`,
`tool_name`, `tool_input`). The script extracts the FIRST occurrence, the
opposite of the Done guard's `##`, because that serialisation order puts the real
field ahead of `tool_input`. Still no `jq`, and still exit 0 on every path: a
payload it cannot read falls back to the generic `HOOK_OSC_BODY`.

Two guards, both pinned by tests that RUN the generated script rather than
grep it:

- **A tool name must be a bare identifier or it is rejected outright**, not
  sanitised. The body sits in OSC 777's LAST field, so an injected `;` would
  re-point the earlier fields, and a body of `termic;...` landing in the title
  position is exactly how a payload would forge a trusted signal.
- **The body goes through `printf`'s `%s`, never into its format string.** A `%`
  cannot reach a format specifier even if a future tool name gets past the
  identifier check.

One surprise worth knowing before you debug it: whitespace inside a tool name is
not rejected, it is deleted, because the payload is flattened with
`tr -d '[:space:]'` first (the same step the Done guard uses). `Bash Write` reads
as `BashWrite`. Harmless, since the extraction stops at the closing quote and can
never produce a field separator, and asserted so nobody has to work it out twice.

**The badge keeps the FIRST wording, not the last.** claude's later `OSC 9` marks
attention again, and letting it overwrite would leave the badge vaguer than the
banner the user already read, and disagreeing with it. That second mark is also
flagged `repeat` (see `Tab.unread.repeat`), so its silence is deliberate rather
than an accident of the rising edge being spent: without the flag, anything that
cleared `unread` between the two marks produced two banners for one prompt.

The echo is bounded by TIME (`ATTENTION_ECHO_MS`, 10s), not by "a needs-you mark
is already held". That was the first shape and it had a hole worth not
rediscovering: a permission prompt is answered with a BARE KEY (`y`), and only
Enter clears the mark, so the state test stayed true long after the user had
dealt with the prompt and went silent on the NEXT genuine needs-you. A re-ask
inside the window can only happen with the user at the keyboard, where the focus
gate suppresses the banner anyway.

## codex hooks do not run until they are TRUSTED

Codex was left out of this feature at first, on the grounds that it "does not
need it": its title reports `Action Required` at +22ms, so attention was already
covered. That argument was about the wrong state. An agent with no hooks can
never reach the `hooksOwn` branch, so every turn it runs is ended by a guess,
and the byte-quiet fallback calls a turn done after 4s of silence. Four seconds
of silence is an ordinary model round-trip. That is GH #276, and codex is the
agent it was reported on.

The event names are claude's, exactly. Codex 0.153.0 reads a claude-shaped
`hooks.json` and its own `HookEventName` enum carries the same set, so the
mapping and the `Schema::ClaudeCompatible` merge are reused unchanged. The file
is `$CODEX_HOME/hooks.json` (flat, NOT `hooks/hooks.json`), confirmed by codex
reporting a hook written there with `source: "user"`.

**What is new is trust, and it fails silently.** Codex discovers the file,
reports every hook in it as `enabled: true`, and then does not run them.
Measured, all four states:

| config | `trustStatus` | runs? |
| --- | --- | --- |
| `hooks.json` alone | `untrusted` | no |
| plus `enabled = true` | `untrusted` | no |
| plus a WRONG `trusted_hash` | `modified` | no |
| plus the right `trusted_hash` | `trusted` | **yes** |

There is no error, no log line and no output in any of the three failing rows.
An install that stopped after writing `hooks.json` would look exactly like a
working one and report nothing, forever. So installing codex hooks writes two
files: the hooks, and a trust entry per hook in `$CODEX_HOME/config.toml`.

```toml
[hooks.state."/Users/u/.codex/hooks.json:session_start:0:0"]
enabled = true
trusted_hash = "sha256:…"
```

The key is `<sourcePath>:<snake_case_event>:<group>:<handler>`.

**The hash is asked for, never computed.** It is not the sha256 of the command,
the handler object or the file (all three checked, plus six TOML shapes) but
codex's own serialisation of an internal identity struct. Reimplementing that
would mean a codex patch release flipping every hook to `modified` with no
symptom other than an agent that stops reporting. So `codex_trust.rs` asks
codex: one `initialize` + one `hooks/list` over `codex app-server`, which is
part of its generated protocol schema rather than a private detail, and it
returns the key and the current hash. Removal needs no such call, because the
key begins with the hooks file's path.

**Paths are compared canonicalised.** Codex reports the path it RESOLVED, and on
macOS both likely scratch homes (`/tmp`, `/var/folders/...`) are symlinks under
`/private`. A plain `==` rejects termic's own file as somebody else's and the
install fails with "codex did not report the hooks termic just wrote". Found
exactly that way.

**The shared daemon runs the hooks, with somebody else's environment.** codex
≥ 0.157 routes interactive sessions through a background app-server daemon
that the first TUI auto-starts and every later TUI, in any terminal, attaches
to. Hooks then run inside the daemon, which inherited the environment of the
tab that started it: on 2026-10-20 (codex-cli 0.163.0) a daemon from
2026-10-16 still carried `TERMIC_PTY=/dev/ttys006`, a pty that by then
belonged to a claude tab. Every codex session's working/done went there, and
the codex tabs themselves were read from the terminal: five hooks reported
`trusted` by `hooks/list`, `codex exec` ran all of them, and a tab ran none.
Three fresh tabs in one task settled it: `--no-daemon` and a `-c` override
(which the daemon cannot serve, so the session runs in-process) reported
every hook; the plain tab reported nothing. The `hooks` feature flag was a
red herring: `codex doctor --all` lists it enabled by default. So termic
composes `--no-daemon` into every codex spawn (`ALWAYS_SPAWN_ARGS`,
lib/agents.ts), first available in rust-v0.156.0 (2026-09-22); an older
codex rejects it at startup, visibly, which beats hooks that write into
another tab. A daemon the user started elsewhere keeps misrouting ITS
sessions' hooks until it is restarted.

**Ownership is decided twice**, by the command's `termic-hooks/` prefix AND by
the file the hook came from. A hook whose command merely looks like ours, in a
project config someone copied from a dotfiles repo, is a stranger's script;
trusting it on prefix alone would be termic approving arbitrary code on the
user's behalf.

**Docker writes nothing at all, and succeeds.** Inside a container both halves of
the trust entry are unknowable from outside: the key would need the container's
path (`/root/.codex/hooks.json`), and the app-server that reports the hash runs
in a container that does not exist at install time. Writing hooks that are
discovered and silently never run is the exact failure this feature removes, so
the Docker half writes nothing and `status()` reports it off, which is true.
Returning `Ok` matters as much as writing nothing: `agent_hooks_install` rolls
the HOST install back when the Docker half errors, so refusing there made codex
hooks uninstallable everywhere while every direct-install test still passed.

**Two ignored tests cover this, and they need a real codex.**

```sh
cargo test --features e2e codex_hooks_install -- --ignored --nocapture  # install/trust/remove
cargo test --features e2e codex_hooks_fire    -- --ignored --nocapture  # a live turn
```

The first asserts codex's own verdict rather than the file termic wrote, since a
trust entry with a wrong hash is silently `modified`. The second runs a real
turn and reads a real pty, and captured exactly this:

```text
ESC]777;notify;termic;agent ready for input BEL   SessionStart
ESC]777;notify;termic;agent working BEL           UserPromptSubmit
ESC]777;notify;termic;agent done BEL              Stop
```

(Captured when working/done were still raw `133;C` / `133;D`; the bodies are
what schema v13 writes. See "Working and done are termic's own bodies".)

It borrows the user's login with a SYMLINK to `auth.json` rather than a copy, so
no credential is duplicated into a temp dir, and it never writes to the real
`~/.codex`. It uses a real pty deliberately: the scripts write with a truncating
redirect, which is meaningless on a character device and total on a regular
file, so pointing `TERMIC_PTY` at a file makes a three-hook turn look like a
one-hook turn. That cost an hour once.

`PermissionRequest` is the one signal not proven by those two, because
`codex exec` pins approvals to `never` and never reaches a prompt. It was
measured separately by driving the real TUI to an approval prompt: the hook
fired the instant the prompt painted, carrying `"tool_name":"Bash"`, which is
what the shared attention body turns into `needs your permission: Bash`.

**codex's `PermissionRequest` is no longer installed (schema v16).** It fires
for every approval REQUEST, including the ones `approvals_reviewer =
"auto_review"` answers itself, and its payload has no field naming the
reviewer. Measured on 0.164.0, a real TUI asked to run a network command:

```text
reviewer=user         hook +0ms   title "[ . ] Action Required" +10ms, then blinks
reviewer=auto_review  hook +0ms   title keeps its working spinner, command runs +3s
```

So with auto review on, every escalated command rang a needs-you that nobody
had to answer. The title only says `Action Required` when a person is asked,
and termic reads title attention on a hooked agent too, so the title is now
codex's only attention source. Install also strips our entries from any event
the current set no longer registers: it only ever merged, so a dropped event
kept firing from an older install.

Before v16 the hook and the title both marked a real prompt, the same shape as
claude's hook-then-`OSC 9` pair, absorbed by the `ATTENTION_ECHO_MS` window.

The title source is also EDGE-gated (only a change INTO attention marks), and
the window alone was not enough: while a prompt waits, codex 0.164.0 blinks
the title `[ ! ]`/`[ . ] Action Required` once a second. Every blink marked
attention, and the first one past the 10s window counted as news, so an
unanswered prompt rang every 10 seconds (12 marks and 2 banners in a 12s
blink, measured by the "a blinking attention title" e2e case; 1 and 1 with the
gate).

**0.154.0 put model-written prose in that title, and the second source went
bad.** Codex renames the thread mid-turn and renders the generated name through
the same `activity` title item. Captured across one turn, in a real pty:

```text
⠋ renaming... ⠋ | proj                                    the rename, in flight
⠧ Create out.txt with hello | proj                        busy, thread title
[ ! ] Action Required | Create out.txt with hello | proj   the real prompt
```

So the title carries whatever the model decided to call the conversation. The
attention pattern was `\bAction Required\b`, unanchored, and `classifyAgentTitle`
tests attention BEFORE busy: a thread the model named `Explain Action Required`
badged needs-you for the rest of the session, spinner running, with no prompt on
screen. Asking codex about approvals or CI was enough to trigger it.

The pattern is anchored to the START of the title now. Genuine attention always
leads, behind the `[ ! ]`/`[ . ]` blink; the prose never does, because the
activity item precedes it. `renaming...` is only in 0.154.0 (checked against the
twelve releases cached under `~/.codex/packages/standalone/releases`), so 0.153.4
and earlier are unaffected.

The same free text reaches the `busy` patterns, where `\b(Working|Thinking)\b` is
also unanchored. NOT changed here, because no false busy has actually been
measured and this file's own rule is that a pattern written from reasoning is
what the last sweep had to replace. Worth a capture before touching it.

## agy has no attention event, so it is read from the screen

Measured against Antigravity CLI 1.1.24 at a live permission prompt: **no
title, no OSC of any kind, no bell.** The prompt exists only as text:

```
Requesting permission for:
   echo hello-from-agy
Do you want to proceed?
```

So agy is a hybrid: hooks for working and done, screen content for attention.
`BUILTIN_OUTPUT_SIGNALS` in `lib/agents.ts` is a table SEPARATE from the title
one, deliberately: claude's `^\s*✳` describes a title and is nonsense against
stdout, which is why the output scanner refuses to fall back to it.

Give a pty a window size before probing a TUI. Two earlier probes concluded agy
emits nothing at all, and both were invalid: without `TIOCSWINSZ` agy never
finishes booting, so the probe was typing into a splash screen.

## opencode 2 reports from its TUI, because its server is not this task's

opencode 2 (`@opencode/cli`, 2.x; opencode 1 is still `opencode-ai` on npm and
is what the Docker image installs) rebuilt plugins, and three things broke the
opencode 1 plugin at once. Everything in this section was READ out of the
2.2.5 source, not measured on a live binary: re-measure before trusting a
detail, and fix this section when it disagrees.

1. **The loader refuses the old module.** A server plugin must default-export
   `{ id, setup }` or `{ id, effect }`; a module with only named exports fails
   with "Plugin must export a default definition with an id and an effect or
   setup function" (`core/src/plugin/module.ts`). It still auto-discovers a
   top-level `plugins/*.js` file, so our file is loaded and rejected.
2. **Server plugins do not run in the process termic spawned.** The `opencode`
   TUI connects to a background service (`opencode serve --service`), one per
   machine, shared by every client and the desktop app, and spawns it if none
   is running: detached, with `{...process.env}` of the client that started it
   (`client/src/service-contender.ts`). That service's `$TERMIC_PTY` is
   whichever task launched opencode first, or nothing. A server plugin there
   would write every task's state into one task's terminal.
3. **Every event changed.** `chat.message`, `chat.params`, `message.updated`
   and `message.part.delta` are gone.

So the one module now carries both: `export default { id: "termic", server,
setup() {} }`. opencode 1's `readV1Plugin` (1.18.31 and 1.19.5) runs
`default.server`, the old hooks; opencode 2 strips the unknown `server` key
(Effect Schema's default `onExcessProperty: "ignore"`) and runs a `setup` that
does nothing. No named export, because opencode 1's fallback registers every
export it finds.

The reporting is `plugins/termic/tui.js`, a TUI plugin. opencode 2 discovers
TUI plugins only as DIRECTORIES under `plugins/`, resolves `tui` by its
conventional name without a package.json, and its server skips a directory
with no `server` / `index` entry. opencode 1 globs `{plugin,plugins}/*.{ts,js}`
one level deep and never sees it. The TUI is the process termic spawned, so
its env and its terminal are this task's.

**The event stream is not this task's either.** The TUI's `data.on` carries
events "across all server locations": other tasks' sessions, the desktop
app's. A root session becomes this tab's the first time this TUI's route shows
it, and stays this tab's after the user navigates away, so a running turn's
done is not dropped. The TUI's tab list does not count: opencode keeps one per
directory (`tui/tabs.json` under `XDG_STATE_HOME`), shared by every TUI there,
so two termic tasks in one folder each list the other's sessions, and claiming
by tab made one task's tab spin for the other's turn (measured by hand on
2.2.6). The cost is a session that runs in a restored tab nobody has opened
yet: it reports once it is shown. A subagent belongs to its root,
through `session.created`'s `parentID` or the TUI's store. Heartbeats only
extend a turn already known to be this tab's, so another task's token stream
costs a map lookup.

The edges are the ones opencode's own notifications plugin rings on
(`tui/src/feature-plugins/system/notifications.ts`): working on a root's
`session.execution.started`; attention on `permission.asked` and
`form.created` (the question tool), released exactly by `permission.replied`,
`form.replied` and `form.cancelled`; done on a root's `.succeeded`, `.failed`
or `.interrupted`. A root that succeeds while a direct subagent still runs is
not done, because the subagent's report wakes it again. With several of this
TUI's sessions running, done waits for the last. The context window is the
footer's formula (`tui/src/util/session.ts`): the last step's input + output
+ reasoning + cache read + cache write, over the model's `limit.context`.

**The session id comes from the plugin.** Each time a turn starts in one of
this TUI's roots, and the root differs from the last one sent, it reports
`session <id>`, the same body codex, devin and omp send. That is
the tab's resume binding, so a relaunch passes `--session <id>` for the
conversation the user actually worked in. termic's other source, the
`post_launch_capture` (`opencode session list`, first `ses_` line), is the
newest session in the folder: two tasks sharing one folder both resumed the
same one (seen by hand on 2.2.6, two spawns under a second apart with one
`--session` id). The capture is still the fallback for opencode 1 and for a
tab whose plugin never reported. A turn run in another task's session (its
tab is on this TUI's bar too, see below) is refused by `sessionHolder`, which
says whose it is instead of moving the binding.

Known gaps, all from what opencode 2 shares per machine (its service, its
`XDG_STATE_HOME`) and none fixed here:

- **Accounts.** termic moves an opencode login with `XDG_DATA_HOME`, but the
  service registers itself under `XDG_STATE_HOME`, which termic does not
  move. A second account's tab can connect to a service started with the
  first account's environment.
- **Sandbox.** Tools run in the service (`core/src/session/model-request.ts`),
  not in the PTY termic wrapped in `sandbox-exec`. See docs/sandbox.md.
- **Tabs in a shared folder.** Two termic tasks in one folder (a plain-folder
  project, a multi-repo parent) show the same opencode tab bar, every
  session of both tasks, because the list lives in
  `XDG_STATE_HOME/opencode/<channel>/tui/tabs.json` per directory. termic no
  longer claims by tab (above), but opening the other task's session there
  makes both termic tabs follow it. Worktree tasks have their own folders and
  are unaffected. A per-task `XDG_STATE_HOME` would split the list, and also
  the service registration, so it belongs with the `--standalone` question.

## Transport

Every agent writes one OSC to the terminal termic handed it. Three targets,
tried in order, chained on redirection failure:

```sh
emit "$TERMIC_PTY" || emit /proc/1/fd/1 || emit /dev/tty || true
```

- `$TERMIC_PTY` is the slave path from `ptsname(master_fd)`, exported per spawn.
- `/proc/1/fd/1` is the container's main-process stdout, which docker relays to
  that same pty under `run -i -t`. It needs NO controlling terminal, which is
  why it beats `/dev/tty`: hooks run without one (measured on grok, rc=1).
- Chained on failure rather than a readiness test, because `[ -w /dev/tty ]` is
  true in places where opening it fails. Attempting the write IS the test.

**Docker needs the env, not just the script.** `cmd.env(...)` sets the HOST
process's environment, and for a Docker task that process is the `docker run`
CLI. Docker forwards none of it, so `TERMIC_PTY` and `TERMIC_TASK_ID` are
pushed onto the container env in `docker::build_spec`, with `TERMIC_PTY` set to
the CONTAINER's address (`/proc/1/fd/1`). Before that, every hook in a
sandboxed tab exited on its first line and a whole tab delivered zero OSCs
while its unsandboxed neighbours delivered hundreds.

### Working and done are termic's own bodies, not OSC 133

Until schema v13 the hooks said "turn started" / "turn over" as raw OSC
`133;C` / `133;D`, the FinalTerm shell-integration marks. Agents emit those
marks THEMSELVES: pi wraps every message block in `133;A`..`C` on each repaint
(`OSC133_ZONE_START` in its message components), and claude's shell
integration marks its prompts. termic could not tell its own hook from the
agent's paint, so a hooked pi tab went back to `working` on every repaint.

The hooks now send `agent working` / `agent done` on the trusted `termic`
channel (routed on an exact match, like ready), and a tab whose agent has
termic hooks IGNORES raw `133` altogether (`native-133-ignored`, logged once
per pty). An agent without termic hooks still gets `133` read as before,
which is the only state signal some of them have.

### An agent's own notifications, and dones nobody asked for

Three more ways a correct hook install still rang the wrong bell, all measured
in the work-state log:

- **Agents announce their own end of turn**, over OSC 9 / 777, a beat after
  the hook's done: grok `Turn complete in 3.5s. · <title>` (~180ms), devin
  `Devin finished`, muse `<workspace> — done (18s)` (10 to 20s). Unmatched,
  each read as needs-you. They are in `BUILTIN_NOTIFY_IGNORE`
  (`lib/agents.ts`), anchored, so a real request from the same agent still
  badges. A new agent's own notifications have to be checked the same way.
- **grok's `Notification` hook is several events**, told apart by
  `notificationType`: `permission_prompt` is the block, `idle_prompt` fires a
  minute after ANY turn ends. The attention script passes the first only.
- **A relaunch restores every task, and most agents then report a done** (a
  resumed hook, pi's `agent_settled`, a replayed session) with nothing sent to
  them: one relaunch rang "agent finished" for six agents at once. `fireDone`
  clears the spinner but does not badge or notify a done with no input since
  the spawn (`done-unasked` in the log).

The fallbacks have to stand down too. The submit-window promotion (output soon
after Enter means working, for agents with no state signal) put a hooked pi tab
back to `working` 26ms after its hook's done, permanently, since only a hook
ends a hook-owned turn. It is skipped once `hookSeenRef` is set.

**Why not `terminalSequence`.** claude can write the OSC itself, and its
runtime allowlists that to OSC 0/1/2/9/99/777 plus BEL. OSC 133 is not on the
list and is dropped SILENTLY, so a Done sent that way never arrives. Measured.

**Why not the CLI socket.** `cli_server` is a command surface whose token is
deliberately kept out of the app environment, because `pty_spawn` copies that
environment into every child: an env-stashed token would be a sandbox escape.
The seatbelt profile also denies caged agents that socket by path, and a
container has neither the socket nor the binary. An ingest-only socket (no
verbs, no shared secret) would be a sound escalation if the pty ever proves
insufficient; the cage already permits unix sockets generally.

## Hooks own the turn, once they have proved it

While an agent's hooks are installed AND at least one has been seen on that
pty, nothing else may end a turn for it: not the title, not byte-quiet, not
scrollback stability, not the settled hash, not the 90s ceiling. They are one
heuristic wearing five hats, and leaving any armed reproduces the bug hooks
exist to fix.

**The 10-minute absolute ceiling is the one exception, and it must stay one.**
It is not a sixth guess at whether a turn ended; it is a liveness backstop, and
it ran BELOW the hooks-own gate until an artifact watch proved what that costs
(see below). Everything termic knows about a hook-owned turn arrives over a
contract termic does not control, so the state machine needs one bound that
does not depend on that contract holding. Ten minutes of a genuinely working
agent costs a spinner that clears early and is re-armed by the very next
`PreToolUse` heartbeat. A missing done costs the tab, permanently.

**Installed is not working**, and conflating them hangs the UI. Hooks earn the
right per pty by delivering once (`hookSeenRef`). A working hook proves itself
on the first submit; a transport that cannot deliver leaves the fallbacks armed,
which is the behaviour that existed before hooks. That is what stopped Docker
tabs pinning to `working` forever while their hooks wrote into nothing.

The title must not drive `working` either, once hooks own the tab. Captured
live: a hook reported `133;C` then `133;D` 1ms apart, the title re-armed
`working` 19ms later, and the next genuine `133;D` was swallowed by the
one-done-per-submit token the first had spent. The tab claimed to be working
for 44 seconds with the agent idle at its prompt.

**A hook done outranks that token.** The token stops one turn NOTIFYING twice
(a settle, a late OSC 9); it was never meant to stop a turn ENDING. Safe by
measurement: claude fires `Stop` several times per turn and the script drops
every one whose `background_tasks` holds delegated work, so at most one
qualifying done reaches us.

## The done guard is a whitelist, because "in flight" includes things that never end

claude's `Stop` payload carries `background_tasks`, and the guard used to hold
the turn open whenever that array was non-empty. That question is the wrong one,
and a session that publishes an artifact answers it wrong forever.

Read out of 2.1.259: the payload is built by mapping the WHOLE task registry
through a single filter, `status is running|pending && isBackgrounded !== false`.
Nothing else is dropped, and the switch that decorates each entry has an
explicit arm for `monitor_ws`, a websocket monitor. An artifact's live-updates
subscription is one of those, it opens on the first publish, and it stays
`running` for the rest of the session. claude's own task list hides exactly
these (`if (t.type === "monitor_ws" && t.ambient) continue`); the hook payload
does not.

So from one `Artifact` publish onward, every `Stop` looked like outstanding
work, the hook emitted nothing, and because hooks had already proved themselves
on that pty there was no demoter and no ceiling left to notice. Reported as a
tab stuck on loading across new turns and finished turns, which is exactly what
it was.

The guard now asks whether the AGENT is still working, which only delegated
work answers. Held: `subagent`, `workflow`, `shell`, `teammate`, `cloud
session`, `MCP task`. Not held: `monitor` (either dialect), `dream`, `auto-mode
scan`, and any type a future release adds. The friendly labels are claude's own
(`local_agent` → `subagent`, `local_bash` → `shell`, and so on); an unrecognised
type falls through to its raw discriminant and therefore to done.

**Fail towards done here, the opposite way to the fallback path.** Once hooks
own a tab, a wrong hold is permanent and a wrong done is corrected by the next
`PreToolUse` heartbeat, because working is the only sustained state and it is
re-asserted many times per turn. That asymmetry is why an unknown type emits.

The array is sliced out of the payload before matching, not matched across the
whole thing: `last_assistant_message` carries the agent's own prose, and a turn
that discussed `"type":"shell"` would otherwise hold its own spinner down. `##`
(longest prefix) picks the last occurrence, which is the real field, since
claude serialises the message first. `agent_hooks.rs`'s tests run the generated
script under `/bin/sh` against real payload shapes rather than asserting on its
source, because every bug this guard has had was one a substring assertion
agreed with.

## Delegated work: a hold is not silence, and it is not a done either

For the resulting STATES, one table with every badge and whether it
rings, see [agent-states.md](agent-states.md). This section is the hook
half: what is on the wire and what was measured to put it there.

The guard above decides WHETHER to hold. This is what the hold then reports,
and why holding used to be indistinguishable from a model still thinking.

Until this existed, a done hook that found outstanding work took `exit 0` and
wrote nothing. Nothing is byte-for-byte what a model mid-token writes, so a tab
could not tell "still generating" from "stopped, waiting on a subagent" from
"stopped, and a dev server will keep it stopped for the rest of the session".
The hook now reports it: `agent delegated: <count> <label> <ids>` on the same
OSC 777 channel, with the same trusted `termic` sender, told apart by its body
prefix like the session id is (`HOOK_OSC_DELEGATED_PREFIX` in
`lib/agentHooks.ts`, `DELEGATED_BODY_PREFIX` in `agent_hooks.rs`). The policy
that reads it is `lib/delegatedWork.ts`; the state machine is `TerminalPane`.

### What was measured

Five scenarios against a live claude 2.1.278, driven through a PTY with an
observer hook logging every payload, ms-stamped. Times are from session start.

| run | what the agent did | first `Stop` | what came next |
| --- | --- | --- | --- |
| B | backgrounded `sleep 75` | +9.6s, `[shell]` | resumed +83.8s, `Stop` empty +85.2s |
| C | one `Agent` subagent | +9.8s, `[subagent]` | resumed +84.0s, `Stop` empty +85.2s |
| D | backgrounded `sleep 900` | +11.3s, `[shell]` | never |
| F | FOREGROUND `sleep 70` | +81.2s, empty | nothing outstanding, ever |
| A | a background command that failed on launch | +9.4s, empty | it had already resumed at +8.6s, `<status>failed</status>` |

Six things follow, and each one decided part of the design:

**A `Stop` only fires when the model loop has stopped.** F spent 70 seconds
inside a foreground `Bash` call and produced no `Stop` at all. So a `shell` in
a `Stop` payload is DETACHED by construction, never one the agent is blocked
on, and the agent's input box is live for as long as it sits there. Measured
directly in D: a prompt typed 104s into the hold was accepted and answered.

**The hold was per SESSION, not per turn.** D's second turn was a one-word
reply that used no tools, and the same `sleep 900` held its `Stop` too. One
`npm run dev` swallowed every done for the rest of the session. This is the
half that made it feel like a hang rather than a slow turn, and it is what the
carried-over rule below fixes.

**Resumption is a synthetic `UserPromptSubmit`.** Its prompt begins
`<task-notification>` and carries `<task-id>`, `<output-file>` and
`<status>completed|failed</status>`. Identical for a shell (B) and a subagent
(C), and it fires for failures too (A). termic gets the re-arm free, since the
Working hook is on `UserPromptSubmit`; what it is worth knowing for is that
`UserPromptSubmit` does NOT mean a person typed.

**`Notification` with `notification_type: "idle_prompt"` is 60s of a stopped
loop, not an idle agent.** It fired in every run exactly 60s after the loop
stopped, and again 60s after each later `Stop`. It also fired in C at +75.0s
while the subagent was still running, so it cannot tell D from C. termic
already drops the terminal-side version of it by body
(`BUILTIN_NOTIFY_IGNORE.claude`), and it stays dropped.

**Subagent tool calls fire hooks in the PARENT session.** One `session_id`
throughout C; a subagent's own events are marked by `agent_id` and
`agent_type`, and the main agent's carry neither. The `Stop` at +14.9s had
`agent_id: null` and held on a `shell` that belonged to the subagent. So a
`shell`-only payload can mean "the parent is waiting on its subagent's
shell", which is why `shell` could not simply be dropped from the whitelist:
that fires a false done in the middle of a healthy orchestration.

**`last_assistant_message` distinguishes the cases in prose** ("STARTED" in B,
"Still waiting, the subagent's sleep is running" in C). It is the text
heuristic hooks exist to replace, and it is a moving target by construction.
Not used.

### What termic does with it

The verdict cannot come from the payload. B and D produced byte-identical
reports and went opposite ways. So termic asks a question the payload CAN
answer, and puts a clock on the residue:

- **Carried over.** The outstanding set is IDENTICAL to the last report AND a
  person asked for the turn that just ended, so none of it can be what this
  turn produced: the turn is over and these are leftovers. Fires a real,
  announced done. This is the per-session hold, gone.
- **Shrank.** Strictly smaller, nothing added: something reported back and
  the rest runs on. Not a finished turn, so no bell, but it gets its own
  badge. Both halves of this were measured wrong first, and the two traps are
  written up in [agent-states.md](agent-states.md): a subset test rings
  "done" with two of three subagents still running, and an unchanged set only
  means "finished" relative to something a person asked for.
- **Agent-owned and new** (`subagent`, `workflow`, `teammate`, `cloud
  session`, `MCP task`, and agy's unlabelled `work`): keep the turn open with
  no clock on it, because it is measured to come back on its own. Bounded only
  by the existing 20-minute liveness ceiling.
- **Detached and new** (`shell`): keep the turn open for
  `DELEGATED_DETACHED_GRACE_MS`, then call it over and say so. Five minutes:
  past every measured round trip (the slowest was 85s end to end), short of
  the ceiling that clears the spinner and tells nobody. This is the only clock
  in the state machine that is honest about being a clock, and the one number
  here set from the cost of being wrong rather than from a measurement.

Both dones pass `force`, and that is load-bearing rather than tidy. claude's
`pending` screen patterns (`lib/agents.ts`) include `N shells still running`,
which is on screen for exactly as long as the leftover shell lives, so
`fireDone`'s screen-scan hold would defer these forever. That scan is the
FALLBACK for the payload fact the hook has just read directly, and it must not
overrule it.

The report is kept on the tab after the done, which is the decoration half:
an idle tab that says `1 shell` is the honest rendering of a finished turn
that left something running. It is cleared on the next working EDGE (not on
every heartbeat: writing an unchanged value through a store setter on a
PTY-driven path is bear trap 8 in docs/performance.md), and the memory the
carried-over rule compares against is cleared only by a done that reports
nothing outstanding, or by a respawn.

### The other agents

A pass over all nine, since the mechanism is agent-agnostic and only the
script decides when to send:

| agent | reports outstanding work? | status |
| --- | --- | --- |
| claude | `background_tasks[].type`, six labels | measured, implemented |
| grok | `backgroundTasks[].type`: `shell`, `monitor`, `subagent` | implemented from its own docs, see below |
| agy | `fullyIdle: false`, unlabelled | implemented, reports `1 work -` |
| devin | no. It HAS background shells (`cognition.ai/backgroundShellId`) and does not mention them at `Stop` | known gap, nothing to read |
| codex, pi, opencode, copilot, muse | no such field anywhere in the shipped binary | nothing to do |

**grok is the one whose provenance is weaker than everything else here, and
deliberately so.** Its 1.0.40 binary embeds its own hooks reference, which
states the contract outright: "`Stop` input also carries `backgroundTasks` and
`sessionCrons`, so a hook can distinguish 'session is done' from 'session is
paused waiting for background work to wake it back up'", each entry carrying
`id`, `type` (`shell`, `monitor` or `subagent`), `status` and `agentType`, and
"`backgroundTasks[].type` is only `shell`, `monitor`, or `subagent`; Claude's
other labels (`workflow`, `teammate`, ...)" do not occur. That is read out of
the binary, not observed on a wire, which for an EVENT name would not be good
enough (a guessed event installs a hook that never fires and looks identical
to one that does). For a FIELD it is, because the failure mode is no change at
all: an absent field leaves `$dlg` empty and the script writes the same plain
done it writes today.

Two grok specifics the guard already handles. `monitor` is its ambient type,
the same trap claude's `monitor_ws` is, so it is excluded. And one script
serves `Stop` AND `StopCancelled` (see `hooks_for`), so the guard is gated on
`"hook_event_name":"Stop"` with the closing quote in the pattern: an interrupt
ends the turn whatever is still in flight.

**The probe that would settle grok**, and the recipe for any future agent:
install a hooks config whose every event logs its raw stdin with a timestamp,
run the agent in a PTY, ask it to start something in the background without
waiting, and watch whether a later event mentions it. Read the parent's events
apart from a subagent's by `agent_id`. The claude table above came from
exactly that, and it took four scenarios because the first one accidentally
launched a command that failed instantly.

## Interrupts: the one thing hooks do not cover

Measured on every agent, both keys, mid-generation:

| agent | Escape | Ctrl-C |
| --- | --- | --- |
| claude | no hook; idle glyph 110ms later | no hook; idle glyph 40ms later |
| grok | `StopCancelled`, `reason="user_interrupt"` | same |
| agy | nothing, and no title either | nothing |
| opencode | first press does nothing; the SECOND fires `session.idle` | `session.idle`, then it exits |

claude was measured with 29 of its 31 lifecycle events registered; its event
list, read out of the binary, has no cancel or abort event to register.

So the keystroke has to be part of the evidence, and can never be all of it:
opencode's first Escape leaves it streaming, so acting on one press would end a
live turn. termic accepts an interrupt only when the key is corroborated by the
title going idle (3s) or the terminal falling quiet (15s), and only while the
user is watching. It calls `interruptWork`, not `fireDone`: an interrupt is not
a completion, so it earns no badge and spends no done token.

## Config shapes, and the grok guard

Three shapes: claude-compatible JSON (claude, grok), Antigravity's named-block
shape with tool events grouped under a matcher and the rest direct (agy), and a
generated JS plugin (opencode, plus opencode 2's `plugins/termic/tui.js` from
`plugin_companions`). Paths are in `settings_rel`; agy's LIVE path is
`config/hooks.json` (`antigravity-cli/hooks.json` parses, logs "loaded 1 named
hooks", and executes nothing).

grok reads `~/.claude/settings.json` on purpose, so installing both double-fires
everything. termic exports `GROK_CLAUDE_HOOKS_ENABLED=false` on grok tabs, and
each script carries the opposite `GROK_HOOK_EVENT` gate.

## Versioning and auto-maintenance

`SCHEMA_VERSION` in `agent_hooks.rs`, recorded in each install's
`manifest.json`. An install from an older version is `stale`, and
`agent_hooks_sync` (run from `refreshAgentHooks` on startup) rewrites it. The
user's consent is "hooks on for this agent", not "these exact scripts": asking
someone to notice a version number and press a button is asking them to do our
job, and it fails quietly, since a stale install still reports itself installed
while reporting less than it could. v2 added the heartbeat; v3 added the
container transport, which a v2 install does not have at all; v15 makes a held
done speak, so a v14 install still spins on a tab whose agent left a shell
running, which is the entire bug that version exists to fix.

Sync only touches agents already installed, so it never introduces hooks for
one the user declined, and re-running `install` preserves the pre-install
backup (`if !backup.exists()`), so removal stays byte-for-byte.

**It has to be CALLED, and for two releases it was not.** `agent_hooks_sync`
existed, was registered as a command, was exported as `agentHooksSync`, and
`AgentHookStatus.stale` was documented as "kept up to date automatically by
`agentHooksSync`" - and no code path invoked it. Every install therefore stayed
at whatever `SCHEMA_VERSION` it was created with, forever, reporting
`installed: true` while missing whatever a later set added. The v3 Docker fix
shipped this way: a v2 install inside a container is not quieter, it is dead,
and it would have stayed dead.

`App.tsx` now calls `syncAgentHooks()` at startup, which syncs and THEN reads
status, so `agentHooksInstalled` reflects the upgraded install rather than the
one just replaced. This is the mechanism the Ready signal depends on: without
it, only users who install hooks for the first time after this release would
get a readiness signal, and everyone already opted in would keep typing into
startup dialogs.

The consent recorded is "hooks on for this agent", not "these exact scripts".
That is what makes an unattended upgrade legitimate, and it is also its limit:
sync may replace a set, never introduce one.

**Sync gates on `ours_present`, never on `installed`, and the difference is
load-bearing.** `installed` is an ALL over the CURRENT event set, because a
partial install would otherwise report as done while missing a signal. That is
right for the UI toggle and catastrophic as an upgrade gate: the moment a new
event joins an agent's set, every existing install fails the ALL, reads as not
installed, and is skipped by the sync whose entire job is to add that event.

This was not hypothetical. Adding `SessionStart` and syncing upgraded agy and
grok, whose sets had not changed, and silently skipped claude, the one agent
the new event was for. It went unnoticed through a green unit suite because
every part was individually correct: the merge, the schema bump, the staleness
rule, the new signal. Only the INTERACTION between "what counts as installed"
and "what sync will touch" was wrong, and nothing tested a pair.

`ours_present` is ANY entry of ours, i.e. consent, which is the question an
unattended upgrade should actually be asking. It is safe as a gate because
`remove` deletes every entry AND the script directory, so an opted-out user
reads false and is never re-installed behind their back. Pinned by
`an_install_missing_a_newly_added_event_is_still_ours`.

## "Install hooks for every agent"

One switch at the top of the Agents page's hooks block, visible without
expanding it (`Settings.auto_install_hooks`, persisted in `settings.json`).
On, every `agent_hooks_sync` (boot, the switch itself, and opening the Agents
page) installs hooks for each supported agent whose binary is on PATH
(`agent_binary_on_path`, the same resolution as `detect_clis`) and that has
none yet, host and Docker together exactly like the row's own button. An
agent whose config is unreadable or has `disableAllHooks` is skipped, as a
manual install would refuse it. Off installs and removes nothing: what is in
stays in.

Two things fell out of building it. `agent_hooks_sync` became an ASYNC command:
it can now install, and a codex install spawns `codex app-server` for its trust
hashes, which on the main thread freezes the window. And the block's mount
effect must not re-run on the switch: it did, and two syncs raced over the same
config files, leaving one agent "not installed" on some runs.

A clone that relocates nothing shares its base's config dir, so installing for
either wires both; the sync reports whichever id it reached first.

## agy resumes its own conversation in a main checkout

agy cannot be handed a conversation id at launch, and has `--conversation <id>`
to resume one, the same shape as codex (`session_id_args` empty,
`resume_id_args` set, `cliSupportsCaptureResume`). Its `PreInvocation` hook
reads `conversationId` from the payload (a UUID, measured on 1.2.6) and
reports it on the session body in the same write as working, so the next
spawn of a main-checkout task resumes that conversation. Without hooks there
is no id and the task starts fresh, as before.

## The context window, per agent

The footer chip shows how full the CURRENT conversation is, next to the plan
windows (`lib/agentContext.ts`, `store/agentContext.ts`). It is keyed by task
and agent, not by account: two tasks on one login share a quota and nothing
else. Every agent reports it on one body, `ctx <used tokens> <window tokens>
[<used percent>]`, on the same trusted OSC 777 channel, so the terminal has one
parser. The optional percent is the agent's own figure where its formula is not
tokens/window.

| agent | source | fields, measured |
| --- | --- | --- |
| claude | status line | `context_window.total_input_tokens` (input + cache creation + cache read of the last call, the numerator of claude's own `used_percentage`) over `context_window_size` |
| agy | status line (`antigravity-cli/settings.json`, `statusLine.command`) | same fields as claude; `context_window_size` is 0 before the first call |
| copilot | status line (`~/.copilot/settings.json`) | `current_context_tokens` over `displayed_context_limit`. NOT `total_input_tokens`, which is the whole session's, and `context_window_size` is null on the `auto` model |
| grok | status line (`[ui.status_line]` in `~/.grok/config.toml`) | `context_tokens` over `context_window_size` (`session_input_tokens` only grows) |
| codex | `Stop` hook | `transcript_path` is the rollout; its last `token_count` has `last_token_usage.total_tokens` and `model_context_window`. The percent is codex's own, with its 12000-token baseline reserved (`codex-rs/protocol`), so plain tokens/window would disagree with the TUI |
| opencode 1 | plugin | the last assistant `message.updated` with output: input + output + reasoning + cache read + write, over the model's `limit.context` from `chat.params` (the TUI's formula, read out of 1.18.31) |
| opencode 2 | TUI plugin | `session.step.ended`'s `tokens`, same sum, over `limit.context` of the model `session.step.started` named, from the session location's model list (the footer's formula, read from the 2.2.5 source) |
| pi | extension | `ctx.getContextUsage()`, pi's own footer figure |
| omp | extension | `ctx.getContextUsage()` — the identical `{tokens, contextWindow, percent}` shape pi reports (measured: `{tokens: 5788, contextWindow: 1000000, percent: 0.5788}`) |
| devin | read at turn end | nothing live: no status line, no token count in any hook. `num_tokens_preceding` of the last assistant node in `cli/sessions.db`, over `max_context_tokens` from `devin models list` (`agent_context_devin`) |
| muse | none | only `muse serve` (MSP) reports it, never a TUI tab |

The status line script is ONE template for all four status line agents, baked
per agent: context fields are tried in a fixed order and the first plain number
wins, and the parts that belong to one agent (claude's `rate_limits` and cost,
agy's `quota`) are read only in that agent's copy. grok sends a cost too; it is
not forwarded, because grok is credit-limited and a dollar figure with no plan
beside it reads as "billed per token".

The other slots are claimed the way claude's is: only when free (a user's own
status line, or grok's built-in row, is theirs), handed back only while still
ours. agy's `statusLine` has no `type` key, and agy 1.2.6 rewrites its settings
on launch dropping keys it does not know.

## The status line is not a hook, and rides the same channel anyway

claude's usage feed (GH #277) is installed by the same `install` call, into the
same config file and the same script dir, and writes the same OSC 777 with the
same trusted `termic` title. It is NOT in `hooks_for`, is not registered against
an event, and `installed` must never depend on it: `status()` answers about
hooks, and a config whose statusLine slot was already taken is still a complete
hook install.

**Claude Code pipes `rate_limits` into a statusLine command's stdin on every
turn**, piggybacked on the Messages API response, so reading it costs no request
and no rate-limit budget. Measured on 2.1.260, the payload also carries
`context_window`, `cost`, `model` and `session_id`.

Three things about it were measured rather than assumed, and each one would have
killed the approach if it had gone the other way:

- **Whatever the script prints is RENDERED**, under the user's input box, every
  turn. A probe printing `ZZMARKERZZ` put `ZZMARKERZZ` on screen. A probe
  printing an empty string left no text at all, which is what makes the slot
  usable as a pure data channel: the numbers go out the side, stdout stays
  empty, and the agent looks unchanged.
- **claude does NOT strip the environment it hands a statusLine command.**
  `TERMIC_PTY`, `TERMIC_TASK_ID` and an arbitrary unrelated variable all arrive
  intact. This is the exact thing that killed the transport for Muse Code, so
  it was worth checking rather than assuming, and it is why the numbers arrive
  already attributed to a task with no cwd mapping.
- **`/dev/tty` fails the same way it does for a hook** (`Device not
  configured`). The three-target chain is load-bearing here too, not
  defensive.

**It runs about once per TURN, not several times per second.** Measured on
2.1.260 with an instrumented script counting its own invocations: 5 runs across
4 turns, and 2 runs across a single 60s streaming turn (one of them before the
prompt was even submitted). Worth stating because the opposite is a plausible
guess and Orca's own source comments claim their statusline "ticks ~3x/sec
while streaming", which would have made a spawn-per-tick script a real
regression and forced a throttle. It does not, on this version, so there is no
throttle here. If a future release changes that, this is the measurement to
redo before anything else.

One invocation costs ~12ms wall / ~11.5ms CPU, of which ~9ms is the bare
`/bin/sh` spawn and drain: the parsing itself is ~2.5ms. Against a turn
measured in seconds, per turn, that is not a number worth optimising.

**`total_cost_usd` is NESTED under a top-level `cost` object.** Measured on
2.1.250, alongside `total_duration_ms`, `total_api_duration_ms` and the line
counts. `rate_limits` IS top-level; the cost is not, and the asymmetry is the
trap. termic's own script survives it by accident: it string-searches the raw
payload for `"total_cost_usd":` and finds it at any depth. Anyone writing a
status line with a real JSON parser reads `payload["total_cost_usd"]`, gets
nothing, and reports no cost for ever on every account. The published fix-it
prompt said exactly that for one release.

**The status line does not run under `claude -p`.** Print mode has no status
line, so a non-interactive run cannot be used to capture a payload, and a probe
that reports nothing there is measuring the wrong thing. Every payload has to
come from an interactive session.

**Both a subscription and a team seat send `rate_limits` AND `cost`.**
Measured on two accounts (`claude_team` / `team_tier_1` / `default_claude_max_5x`,
and an ordinary Max login): each carries both, so the two are not alternatives
and a panel showing plan windows next to a dollar figure is correct. What
differs is the MEANING, which is why the spend row is labelled by `sawPlan`
(see docs/agent-accounts.md).

**A session that was already running does not pick it up.** Claude reads
`settings.json` ONCE, at session start, so every tab open at the moment the
status line is installed keeps running without one and reports no usage for the
rest of its life. Restarting that tab is the whole fix. Worth knowing before
debugging anything else, because it presents exactly as "it worked and then it
stopped": new tasks show a usage chip, the long-lived tab you have had open all
afternoon never does, and nothing about the install is actually wrong. The same
is true of the hooks themselves.

**The slot is not termic's.** A config has exactly one `statusLine`, and a user
who wrote their own looks at it on every turn. `merge_statusline` claims it only
when it is free or already ours, decided by the command's path prefix, the same
ownership test the hook entries use. A slot taken by anyone else is left exactly
as it is and that user simply gets no usage. The script is still WRITTEN in that
case, so clearing their own status line later turns the feature on at the next
sync without a reinstall. Docker is unaffected: termic owns that config dir
outright, so there is no slot to lose.

**A PROJECT-level status line silently wins, and there is nothing to do about
it.** Claude Code reads `.claude/settings.json` inside the repo as well as the
user's own, and the project one outranks it. Measured with termic's real
installed status line at user level and a marker one in a project's
`.claude/settings.json`: the project's marker rendered in the TUI and termic's
usage OSC never fired at all.

So a repo that ships its own status line gets no usage chip for its tasks,
while every other project on the same account still does. That is confusing and
it is still the right behaviour: the alternative is writing termic's absolute
path into a file that lives IN THE USER'S REPOSITORY and gets committed, which
is not a trade any footer is worth. The same is true of
`.claude/settings.local.json`.

termic DOES notice, which is the part that stops this being a silent hole.
`status_line_owner` resolves the slot for a task's cwd in claude's real
precedence order (`.claude/settings.local.json`, then `.claude/settings.json`,
then the user's own), measured rather than assumed. When something else owns
it the footer shows a quiet `usage n/a` chip instead of nothing, naming the
exact file in force, which is not obvious: a local settings file outranks the
committed one, so the file a user would go and edit is often the wrong one.

Claude ONLY, and only on a POSITIVE detection. It is the only agent whose
usage arrives through a status line, so the only one that can be shadowed;
codex is asked directly and cannot hit this. The check is asked while there is
nothing to show, and again whenever the chip's panel is open, so a working
feed pays for it only when someone is looking; it reads the
AGENT'S OWN config dir: a clone relocates it, and asking about the base read
`~/.claude` for every clone.

Short of a blocker, an agent that can report usage (`reports_usage`) and has
not yet shows "Usage unknown" rather than nothing. Nothing at all read as a
feature that does not apply, and it was indistinguishable from a clone whose
hooks were never installed. Its panel says which of the two it is from `agentHooksInstalled` in the app
store, which Settings refreshes as it installs or removes hooks. Not an IPC on
open: that rendered the panel empty, placed it for that size and then grew it,
which could clip it at the bottom of the window. Without
hooks it says usage needs hooks and a first response and offers "Install
hooks", which opens the hooks block in Settings rather than writing from the
footer, because that block shows what it will write first; with hooks it says
usage appears after the first response. codex and devin need no hooks and get
neither message.

Beside "Install hooks" sits "Dismiss for <agent>", for someone who does not
want hooks now. It does not hide the chip: the brand icon and the label become
one faint rising-line icon (`UsageRisingIcon`, which never dips, in the idle
Terminal button's ink) that opens the same panel. It lasts only while the agent
has no hooks, which is what was dismissed:
installing them (Settings refreshes `agentHooksInstalled` on the spot) brings
the label back until real usage replaces it, so there is nothing to undo. Per
agent entry, since a clone has its own hooks, and per profile, in localStorage
(`store/usageUnknownDismissed.ts`, its own store so a click re-runs no prefs
selector).

The chip offers a PROMPT to copy rather than instructions to follow. The user
does not have to learn the wire format: they paste it at the agent that owns
that status line and it makes the edit. `statusLineAgentPrompt` in
`lib/agentUsage.ts` carries the three rules that decide whether the result
works or silently does not, and its test pins them: the `TERMIC_PTY` /
`TERMIC_TASK_ID` guard (which keeps it a no-op for teammates and CI), that
stdout IS the status line so the sequence must go to the pty and nowhere else,
and `-` rather than `0` for a missing value, since a zero reports a spent
limit as unused.

The prompt teaches BOTH halves of the footer: the `usage` body and the `ctx`
body (raw tokens and the window size, sent only when both are above zero). It
taught usage alone until the tips work, so a custom status line taught by it
filled half the footer and left the context gauge empty with nothing saying
why. It also names the Docker fallback targets (`/proc/1/fd/1`, `/dev/tty`),
since `$TERMIC_PTY` is a host path a container cannot see.

For a status line set in the COMMITTED `.claude/settings.json` the prompt makes
the agent stop and ask the user where the change goes, before it writes
anything (`statusLineWhere`). That file is the repo's, and the person holding
the prompt may not be able to change it. Two options, both spelled out so the
answer is informed: edit the repo's script and commit it (everyone gets it, a
no-op without Termic), or leave the repo untouched with a git-ignored
`.claude/settings.local.json` that takes the slot for this checkout and points
at a wrapper which runs the original command, prints its output unchanged and
does the reporting. The wrapper and the local settings are kept out of git
through `.git/info/exclude`, never `.gitignore`, which is itself committed. A
`project-local` or `user` owner gets no question: it is already their own file.

The prompt is offered in THREE places (`components/task/StatusLinePrompt.tsx`),
because the first one disappears. The `usage n/a` chip is gone the moment the
script reports a single number, so a script taught by an older prompt, or
taught half right, had no way back to it. So it is also in the usage panel of
a task whose custom status line already reports, and permanently in Settings,
under the project, More, "Claude status line", which asks the same
`status_line_owner` question for that project's folder.

Sources that are NOT this, all measured and all dead: claude's HOOK payloads
carry no usage field (a real `Stop` payload has `session_id`,
`transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`,
`background_tasks`, `session_crons`, and nothing else); its transcript JSONL
writes `quotaLimits` ONLY on a request that was already rejected; and its OTEL
export has no rate-limit metric. codex is the other way round entirely: it has
no status line and is ASKED, over `account/rateLimits/read` (docs/ipc.md).
docs/ideas/usage-footer.md carries that whole comparison, including the OAuth
endpoint and why the keychain makes it the wrong default on a Mac host.

## Cloned agents

Everything here resolves through `extends`: the event set, the schema, the
config file, and the config DIRECTORY. A clone made to hold a second account
relocates its whole config with the agent's own env var
(`CLAUDE_CONFIG_DIR=~/.next-claude`), so `agent_dirs::instance_config_dir`
resolves the directory from the agent ENTRY rather than the base's default.
Writing the base's path there would put one account's hooks into the other
account's config, which is worse than installing none.

Deliberately NOT `docker::base_agent_id_str`, which falls back to `"claude"`
for an unrecognised base. Right for choosing a Docker mount, wrong here.

## Diagnostics

`termic-workstate.log` in the OS temp dir (`-dev` and `-e2e` suffixes per build
flavour, so two live apps do not interleave). Always on, no flag: by the time
anyone notices a wrong badge, the evidence has to already be on disk.

It records state CHANGES and REFUSALS, because a resulting state cannot tell
you why it is wrong: "working was requested and refused because the tab is in
its post-click grace window" and "no working signal ever arrived" leave
identical state and have opposite causes. `hook-osc` lines record every hook
OSC on ARRIVAL, since the heartbeat mostly lands on a tab that is already
working and would otherwise be invisible. The last twenty trusted bodies per
agent are also kept in memory (`recordHook` in `lib/agentSignalLog.ts`) and
shown under "Show recent hook reports" in the agent's card in Settings, so
"did the hook fire at all" is answerable without the file. The spawn line carries `base`,
`inherited`, `hooksInstalled` and `hookProven`, which are the first four things
to check and the easiest to get wrong.

## Traps

- **Measuring a real codex outside termic: pass `--no-daemon`.** Without it
  codex runs through its shared background daemon, which fires hooks with the
  environment of whichever session started the daemon, so `TERMIC_PTY` points
  at an earlier run's target and the run under test reports nothing at all. An
  afternoon went into "hooks do not fire unless `-c approval_policy` is set"
  before this: any `-c` happened to force a fresh process. termic itself
  always passes `--no-daemon` (`lib/agents.ts`). To capture a session, run the
  TUI in a pty with `TERMIC_TASK_ID` set and `TERMIC_PTY` pointing at a plain
  file, and answer the folder-trust prompt.

- **`/dev/tty` does not work from a hook on the host.** No controlling terminal
  (measured on grok, rc=1). Opening the slave BY NAME needs none.
- **`SubagentStop` is not a done.** 107 fires against 2 real Stops in one run.
  `background_tasks` already covers subagents (`type: "subagent"` ×1006,
  `"shell"` ×1529).
- **"Is anything in flight" is not "is the agent working".** The registry holds
  ambient monitors that outlive every turn. Whitelist the types that mean the
  agent will be woken again; see the guard section above.
- **claude's notifications are not all needs-you.** Eleven `notificationType`s,
  five of which mean it. `agent_completed` sends `` `${label} finished` `` when
  a turn SUCCEEDS, and termic spoofs iTerm2 so it arrives as OSC 9. See
  `BUILTIN_NOTIFY_ATTENTION`: an allow-list, because the failure mode is a type
  the vendor adds LATER.
- **Read the binary, not the website.** Both wrong conclusions in this work
  (agy "loads hooks and never runs them", grok "has the least complete event
  set") came from reasoning instead of asking the installed binary. grok has
  the most complete set of the four.
