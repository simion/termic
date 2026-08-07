# termic CLI (design)

Status: Phase 0 implemented (PR #132) - `termic-proto` + `termic-cli`,
the socket server, `open`/`list`/`status`, sidecar bundling, PATH install,
and single-instance-per-data-dir. Phase 1 implemented on top (PR #133) -
`new` (setup streaming, delivery-confirmed prompt injection, `--wait`),
`wait`, `archive`, `project add|list|remove`, the Rust-side agent-state
cache, `help --json`, and the `TERMIC_TASK`/`TERMIC_CLI` env
advertisement (protocol v2). Phase 2 implemented on top - `send`
(queue-aware, `--resume`/`--fresh`, same `--wait` contract), `attach`
(+`--shell`, backlog replay, detach keys, opt-in `--resize`), `apply`
(exit 10 goes live), `diff`, `path`, and the result readers `logs`
(per-PTY ring buffer) and `result` (claude transcript reader), protocol
v5. Phase 3 in progress - windowless mode landed, `termic quit` landed;
tab management (GH #138) landed in full: part 1 (`termic tab` + stable
tab ids) and part 2 (`--tab <n|id|title>` targeting on
send/wait/attach/logs, tabs listed in `status`, `tab -p`), protocol v6.
`rename` (GH #153, label only; branch + dir keep their names) lands on
top, protocol v7.
Homebrew
is settled, not pending: the cask ships, a CLI-only formula is a non-goal
(see Distribution). `termic events --json` is SEQUENCED BEHIND hooks, not
merely deferred: see Phasing.
`termic mcp` stays parked under discussion and NOT approved (see
Phasing). Sections below note where the implementation refined the
original design.

A `termic` command that creates tasks, lists them with live agent state, focuses
the GUI, injects prompts, and attaches a real TTY to an agent's PTY, from any
shell. Written up so the architecture decision (and the sandbox trap) survive
the investigation that produced them.

Goal: `termic new fix-auth -p "fix the login redirect"` from inside any
registered repo does what the New Task dialog does, without touching the GUI.

Non-goals: a second product. No standalone daemon, no server, no independent
release cadence. The CLI is a remote control for the app, not a reimplementation
of it.

## The architecture question: separate app or embedded?

Products that pair a GUI with a CLI cluster into three patterns:

1. **Thin CLI client, app as the daemon.** VS Code's `code` is a tiny launcher
   bundled inside the .app that hands argv to the running instance over a local
   IPC socket. Docker Desktop ships the `docker` client speaking a versioned
   protocol to the daemon over a unix socket. 1Password's `op` reaches the
   desktop app over local IPC for biometric auth. tmux is the purest form:
   clients attach to a server over a unix socket. The CLI holds no state and
   contains no domain logic.

2. **Standalone CLI sharing a core library.** Two writers over one data layer.
   Requires the domain logic extracted into a shared library and a
   change-notification story so each side sees the other's writes.

3. **Separate products.** `gh` vs GitHub Desktop: same API, zero shared code,
   independent teams and release trains.

The GUI-first products all chose pattern 1, and termic's state layout forces
the same answer. Termic state lives in three places:

- **Disk** (`projects.json`, `tasks/*.json`): readable by anyone, but writes
  are single-writer by assumption. Nothing watches for external changes; a
  standalone CLI that wrote a task file would be invisible to a running GUI
  until restart.
- **The Rust process** (PTYs, running scripts, sandbox proxies): PTYs die with
  the app (docs/data-model.md). Any command that spawns or writes to an agent
  must run inside the app process or the agent dies when the CLI exits.
- **The webview** (orchestration + intelligence): task creation is not
  `task_create` alone, it's dialog/quickTask -> `taskCreate` ->
  `launchSetupTab` -> PTY spawn -> settle -> prompt injection
  (`src/lib/agentRace.ts`, `src/lib/runPrompt.ts`). Work-state
  (working/waiting/done) exists only in the webview: tab `workState`
  (`store/app.ts:312`), title heuristics (`lib/terminalTitle.ts`), waiting
  detection (`lib/waitingAgents.ts`). Rust has no idea whether an agent is done.

A standalone CLI (pattern 2) would have to reimplement the orchestration
recipe, duplicate the work-state heuristics or report nothing useful for `ls`,
and introduce a second writer against files the GUI assumes it owns. Pattern 3
is the same but worse. **Decision: pattern 1. The app is the daemon; the CLI is
a thin client bundled in the .app.**

Field check (2026): Sculptor ships exactly this shape (a `sculpt` CLI against
a local API served by the running GUI, agents identified via env vars); Claude
Code itself grew `--bg`/`attach`/`logs` verbs against a socket-based
supervisor; Conductor, the closest competitor, has no automation surface at
all, so this CLI is genuinely differentiating. One fork we reject
deliberately: Crystal and vibe-kanban skip PTYs entirely and drive agents as
headless `claude -p --output-format stream-json` turns, which yields exact
machine-readable done/needs-input events. Termic is PTY-native by product
design (the embedded terminal IS the product); that choice is why `--wait` is
heuristic where theirs is exact, and the hooks note under Phasing is the
honest upgrade path.

The protocol is designed so a future windowless daemon mode slots in without
changing the CLI surface (see Phasing), which is the escape hatch if termic
ever becomes CLI-first.

## Why this is cheaper than it looks

Four pieces already exist:

- **The RPC-into-the-webview machinery is built.** The dev automation bridge
  (`src-tauri/src/automation.rs`) already runs a localhost server on its own
  thread, forwards work into the webview, and blocks the request thread on a
  correlation-id channel until JS calls `automation_result`. The production
  socket server is that pattern with a unix socket, typed commands, and
  file-token auth instead of debug-only arming.
- **Programmatic task creation with prompt injection is a shipped recipe.**
  `agentRace.ts` creates N tasks from code, waits for each PTY, lets the TUI
  settle, injects the prompt, and stamps `lastInputAt` to arm work-done
  detection, with no dialog involved. `termic new -p "..."` is that recipe with
  N=1. `quickTask.ts` is the no-prompt variant.
- **Rust already owns the PTY bytes.** `pty_spawn`/`pty_write`/`pty_resize`
  emit `pty://<id>` chunks (docs/ipc.md). `attach` is a tee of those bytes to a
  socket subscriber plus stdin forwarded to `pty_write`; the webview is not
  involved.
- **Read commands are already Tauri commands.** `projects_list`, `tasks_list`,
  `task_diff` exist; `ls` composes them with a webview query for work-state.

## Architecture

```
termic (CLI, thin)  ──unix socket──  Termic.app
                                      ├─ Rust: socket server (own thread)
                                      │   ├─ native ops: ls, attach (PTY tee)
                                      │   └─ webview RPC: new, run, open, state
                                      └─ webview: window.__termic.rpc handlers
                                          (reuse automation correlation ids)
```

- **Binary**: `termic-cli` beside `src-tauri`, linking only a small
  `termic-proto` crate (request/response types + protocol version). Both the
  cargo workspace and tauri.conf's `externalBin` entry are net-new (src-tauri
  is a single crate today; routine change, just not lying around). It must
  NOT link `lib.rs`; it stays a milliseconds-fast, dependency-light client.
- **Transport**: unix domain socket at `<data_dir>/termic.sock`, mode 0600,
  newline-delimited JSON, compact encoding mandated (newline framing dies on
  pretty-printed output). mpv's JSON IPC is the closest published analog;
  HTTP-over-UDS (Docker-style) would force connection hijacking for attach,
  substantial machinery for zero benefit at this scale. Requests echo a
  client request id; streamed responses interleave as typed events ending in
  one `done` object. `attach` stays NDJSON in BOTH directions
  (`{type:"out"|"in", data:<b64>}` plus in-band `{type:"resize"}` /
  `{type:"detach"}`): base64 overhead is irrelevant at TTY bandwidth and the
  control messages need in-band framing anyway, so a raw-mode upgrade would
  buy nothing but a second framing layer. The hello carries the protocol
  version; on mismatch the CLI fails with "Termic updated, rerun your
  command", not garbage. Skew is real even for a bundled sidecar: the app
  auto-updates under a shell that resolved `termic` at login. Bind-time
  check against sun_path's 104-byte Darwin limit with a clear error. Debug
  builds already use a separate data dir (`termic_dev` via `APP_DIR`,
  lib.rs:545), so dev and release sockets never collide. Beta shares the
  release data dir + socket by design (it is long-term prod testing);
  Phase 0 enforces one instance per data dir (see the launch bullet), so
  beta and prod are mutually exclusive rather than colliding - launching
  one while the other runs raises the running one and exits.
  `TERMIC_SOCKET` overrides for cross-targeting. Requests carry a per-boot token (below). Responses
  are either one object or a `stream: true` sequence (setup output, attach)
  ending in a final `done` object.
- **Dispatch**: two domains. Rust-native commands (list from disk, PTY attach)
  answer directly on the server thread. Orchestration commands post a typed
  event into the webview where a handler registry (`window.__termic.rpc`,
  registered by the store layer) executes the same code paths the GUI uses and
  replies via the existing `automation_result`-style correlation channel. This
  keeps ONE implementation of task creation, prompt injection, and work-state.
  To be explicit: the production RPC channel is NEW hardened code that only
  borrows the correlation-id pattern; the debug bridge itself (armed solely
  under debug build + `TERMIC_AUTOMATION=1`, with `/eval`) stays debug-only
  and is never the transport.
- **App discovery/launch**: every command requires the running app; there is
  no offline mode and no disk-fallback read path. No socket -> `open -ga
  Termic` (background, no focus steal), poll the socket with a deadline, then
  fail with "Termic did not start" rather than hanging. Auto-launch is
  RELEASE-only: a debug CLI targets the `termic_dev` socket, so it never
  launches the release app (it fail-fasts with a pointer at `TERMIC_SOCKET`
  instead). `--no-launch` swaps auto-launch for an immediate "Termic must be
  open" error, for scripts. Concurrent invocations racing `open -ga` are
  deduped by LaunchServices. Phase 0 additionally enforces ONE INSTANCE PER
  DATA DIR: on startup a release build connects to its data dir's socket and,
  if a live termic answers, asks it to raise its window (a new unauthenticated
  `raise` verb) and exits, so a second launch (prod vs beta, or a direct
  binary run) never opens a duplicate racing the shared projects.json/tasks/.
  Debug is newest-wins (relaunching `make dev` steals the socket). The
  tmux-style flock'd spawn lock remains the known fix for the residual
  simultaneous-launch race (two launches within the pre-bind window).
- **Remote is out of scope.** The auth model is deliberately local-only
  primitives (unix socket, `getpeereid`, 0600 token file) and remote would
  break all three; nothing in this plan designs for it. Worth recording why
  that is not a trap, though: the CLI happens to unlock a plausible future
  where one machine drives termic on another simply by SSH-ing over and
  running THAT machine's CLI (`ssh -t box termic attach foo`) - every local
  primitive holds because SSH is the transport and the auth, and a `--host`
  sugar flag (the `docker -H ssh://` precedent) could wrap it. Speculation,
  not commitment; if it ever firms up it gets its own design. The known
  friction to note for that future: macOS runs GUI apps only inside a
  logged-in session (locked/asleep is fine; a dedicated box would want
  auto-login + Termic in Login Items), a platform rule that windowless mode
  does not lift and that only the rejected CLI-first architecture would
  remove.
- **Lifecycle**: the app exits with its window today (no `ExitRequested`
  prevention in `lib.rs`), so v1 "headless" means "the app is open but you
  never look at it". A true windowless mode (activation-policy Accessory, no
  window until asked) is Phase 3, and the socket protocol does not change for
  it.

## Command surface (v1)

Flat verbs (the majority pattern for single-noun tools; termic has one noun,
the task). Commands resolve tasks/projects by name, or from `cwd` when inside
a registered repo or a task worktree. A name matching tasks in more than one
project errors listing the candidates; `--project` or a qualified
`project/name` disambiguates. `-p -` reads the prompt from stdin, so
`git diff | termic send foo -p -` works. `--wait` takes `--timeout <dur>`
(distinct exit code on expiry); the app quitting mid-wait or mid-attach is a
socket EOF with its own reserved exit code, never a hang. v1 is
single-member tasks only: composition tasks (`task_create_multi`) are out of
scope until the surface stabilizes. Completions (`termic completions zsh`,
clap-generated) complete task names dynamically over the socket.

```
termic new [name] [-p|--prompt <text>] [--agent claude|gemini|codex|<custom>]
           [--worktree|--main] [--base <branch>] [--sandbox off|monitor|enforce|enforce-fs]
           [--yolo] [--project <name>] [--open] [--wait]   # a new --attach flag stayed unbuilt:
           [--from <path>] [--resume <session-id>]         # `termic new x && termic attach x`
                                                           # composes, so the flag is deferred
                                                           # until someone misses it
                                                           # --from (GH #169, protocol v7) ADOPTS an
                                                           # existing registered worktree instead of
                                                           # creating one (name optional: defaults to
                                                           # its branch; excludes mode/--base; no setup
                                                           # script; project resolved from the
                                                           # worktree's repo). --resume seeds the agent's
                                                           # first spawn with a session id via the
                                                           # registry's resume_id_args (id-resume-capable
                                                           # agents only; valid on any create, best where
                                                           # the task dir matches the session's); `tab`
                                                           # takes the same --resume for a NEW tab
termic list [--project <name>] [-q]           # tasks + workState + diff stat (alias: ls; -q = ids only)
termic open [<task>]                          # raise window, select task (cwd-aware)
termic status <task>                          # one task in depth: agent state, branch,
                                              # dirty file count, session count
termic send <task>|--here -p <text> [--wait]  # prompt the RUNNING agent; --tab <n|id|title>
           [--tab <sel>]                      # targets one strip tab (agent tabs only);
                                              # if the target is mid-turn
                                              # this QUEUES (runPrompt.ts:42 already queues
                                              # on workState "working"), not an error -
                                              # but ONLY for work-done-capable agents:
                                              # runPrompt's busy gate is capability AND
                                              # state, so an opted-out agent (shell tab,
                                              # custom agent with work_done=false) gets
                                              # the prompt delivered immediately with a
                                              # printed warning, and wait/--wait REFUSE
                                              # such agents outright (no settle signal
                                              # exists to wait on);
                                              # none running -> error naming the outs:
                                              # --resume (restore last session) or
                                              # --fresh (new agent, no context);
                                              # --resume with NO prior session is its
                                              # own explicit error pointing at --fresh,
                                              # never a silent fall-through
termic wait <task> [--timeout <dur>]          # block until the agent is QUIESCENT:
           [--tab <sel>]                      # (--tab narrows to ONE tab's state+queue)
                                              # settled AND its message queue is empty.
                                              # Settle alone races send's queueing (turn 1
                                              # settles -> wait returns -> only then does
                                              # the queued prompt deliver), so plain
                                              # settle would make `send foo -p ".." &&
                                              # wait foo && diff foo` diff the WRONG
                                              # state. Quiescence closes that. send/new
                                              # --wait are stronger still: they track
                                              # their OWN prompt (delivered + the turn it
                                              # started settled), not just any quiet.
termic attach <task> [--detach-keys <seq>]    # raw TTY <-> agent PTY; --shell targets the
           [--resize] [--shell|--tab <sel>]   # aux terminal, --tab one strip tab
                                              # (agent tabs only); interactive but
                                              # NON-resizing by default (the GUI pane owns
                                              # the PTY size; resizing under it is tmux's
                                              # smallest-client problem). --resize opts in.
termic path <task>                            # print worktree path: cd $(termic path foo)
termic diff <task>                            # summary via task_diff (already a Rust command)
termic apply <task> [--yes]                   # the GUI's "send diff to main"
                                              # (task_send_diff_to_main). NOT named
                                              # "merge": true merge orchestration
                                              # (conflicts, strategies) is out of scope -
                                              # the CLI never grows logic the app does
                                              # not have. apply does NOT archive: task
                                              # and worktree survive, re-running
                                              # re-applies. Three failure modes, each
                                              # with defined message + exit code: dirty
                                              # main checkout (precondition, lib.rs:4666),
                                              # main-checkout task ("nothing to send",
                                              # lib.rs:4652), and a --3way conflict,
                                              # which leaves conflict markers IN MAIN and
                                              # must say so explicitly ("main checkout
                                              # left conflicted, resolve or reset")
termic rename [<task>] <name>                 # GH #153. Retitle a task: the LABEL only,
                                              # branch + worktree dir keep their
                                              # creation-time names (pushed branches,
                                              # live PTY cwds). Without <task> targets
                                              # $TERMIC_TASK_ID (the caller's own task),
                                              # then cwd like `open`. Same-project live
                                              # duplicate -> Conflict (mirrors `new`'s
                                              # collision rule; task_rename enforces it
                                              # too, so the GUI shares the guard). Routed
                                              # through the rename_task webview RPC so
                                              # the sidebar updates live
termic archive <task> [--yes]                 # kills the task's live PTYs FIRST (the
                                              # task_set_sandbox SIGKILL precedent;
                                              # today NEITHER lib.rs task_archive nor
                                              # archiveTask.ts kills them - a latent gap
                                              # the CLI must not inherit, since removing
                                              # a worktree under a live agent plus a live
                                              # attach is undefined). Attached clients
                                              # get in-band {type:"detach",
                                              # reason:"archived"} + a distinct exit code
termic project add|list|remove                # rare admin ops, namespaced; `project add .`
                                              # is the non-interactive registration path
                                              # scripts need (the y/N prompt is TTY-only)
termic quit [--yes]                           # the only shell-side teardown for a
                                              # windowless app. Kills every PTY, script
                                              # group, grep AND reverts active spotlight
                                              # sessions (force-checkout of MAIN), so the
                                              # confirmation names what dies. Never
                                              # launches; exits 0 if not running
termic agents                                 # what --agent / --terminal accept:
                                              # id, kind, enabled, installed, usable.
                                              # The registry is per-user and editable,
                                              # so static help cannot carry it
termic tab <task> [--agent <id>|--terminal <id>|--shell]      # GH #138. A tab INSIDE a
           [-p <text> [--wait]]               # running task: the "+" menu as a verb, and
                                              # like that menu it distinguishes agent /
                                              # custom-terminal / aux-shell kinds, because
                                              # they differ in sandbox, resume and YOLO.
                                              # -p injects into the NEW tab (agent kinds
                                              # only) via send_prompt targeted at its id
```

Two structural rules the surface depends on. First, task creation
SERIALIZES behind one app-wide create lock shared by GUI and CLI:
`task_create_sync` is unserialized and its orphan cleanup will
`remove_dir_all` an unregistered-looking directory, so two same-name
creates interleaving is DESTRUCTIVE (one deletes the other's in-progress
worktree), and the app already knows single-file creation is the safe shape
- agentRace serializes its own creates because "git worktree add contends
on the repo index" (agentRace.ts:80). Same-name collision under the lock is
a clean error naming the existing task, never cleanup. Second,
main-checkout tasks (`--main`) are in scope but behave differently and the
doc says so per verb: `path` prints the SHARED project root (not an
isolated worktree - the cd lands in the live checkout), `apply` errors
("this task IS the main checkout", the app's own message), `archive`
unlinks without removing any worktree, and several main-checkout tasks can
share one checkout, so `diff`/`status` reflect shared state.

Verb naming, two deliberate calls: `send` not `run`, because "run" is already
a termic domain term (the project's run script, `task_run_script`) and the
rename keeps `termic run` free to mean exactly that someday; `new` not
`start`, because the product's own vocabulary is "New Task" and `start`
reads as starting an agent in an existing task, which is `--resume`'s job.

Machine output follows the field convention `--output-format text|json|
stream-json` (`--json` = shorthand for `json`). Reads emit one JSON object;
streaming verbs (`new`, `send` under `--wait`, and `wait` itself) emit NDJSON events ending in
exactly one result line. Exit codes are a documented contract scripts branch
on: 0 = agent settled done, 1 = error, and 2 is RESERVED for usage/parse
errors because clap already exits 2 there - a domain code on 2 would make a
typo'd flag read as "agent needs input". Domain codes therefore start at 3:
agent stopped needing input (`waitingAgents.ts` already distinguishes done
from attention), "app not running" (under `--no-launch`), "CLI disabled in
Settings", "refused: auth or scope" (a socket-reaching caller with no/valid-
but-insufficient token - the in-cage `TERMIC_SANDBOX` pre-check catches the
common case, but a scoped-token violation must be script-distinguishable),
`--wait --timeout` expiry, connection lost mid-command, "prompt never
delivered" (see Phasing: delivery must be confirmed, not assumed), and
"apply left main conflicted". Numbers get
pinned when the contract lands in `--help` at Phase 0. Exit codes AND the
`--json`/`stream-json` field shapes are public API once shipped: shapes
evolve additively only (new fields may appear; nothing is renamed or
removed), because agents will parse them. `attach` prints its detach hint on entry (docker/tmux
convention); the default is ctrl-\ but `--detach-keys` (Docker's grammar) is
configurable from day one - Docker's hard-coded ctrl-p,ctrl-q collision with
readline history is a decade-old documented failure that never got fixed.

Defaults mirror the GUI: agent falls back to the project's `default_cli`, mode
to the remembered new-task mode, sandbox flags to the project's seeds. `new`
in a git repo that is not a registered project asks "Add it as a project?
[y/N]" on a TTY and errors in non-interactive use; a project added this way
starts at the same defaults as the GUI picker. `new`
streams setup-script output until spawn, then prints the task id/branch/path
(or keeps blocking under `--wait`/`--attach`). Ctrl-C in the CLI never rolls
anything back: once `task_create` has committed, interrupting only stops
watching ("task continues in Termic"), it does not cancel the task. Copy rule applies to all CLI output and help text:
no em dashes.

## Tabs inside a running task (GH #138)

Everything above targets a TASK. A task is not one agent though: it is a tab
strip, and the GUI's "+" menu opens more agent tabs beside the first plus an
uncaged shell. The CLI cannot see any of that. Today the entire surface is one
boolean, `attach --shell`, and every other verb silently means "the default
agent tab" (`PtyRole.is_default`, already the target `attach`/`logs` resolve
to). So a second claude tab is unreachable, and `status` reports a `sessions`
COUNT with no way to ask what those sessions are.

Adopted into Phase 3, landed in two parts. **Part 1:** `termic tab`
plus `PtyRole.tab_id`, i.e. creating tabs and having a stable name for them.
**Part 2:** `--tab <n|id|title>` on send/wait/attach/logs, tabs
listed in `status`, and `tab -p` (protocol v6). Split because part 2 depended
on the selector decision and part 1 did not.

**`tab_id` is covered end to end** (the risk part 2 was told to close first):
`e2e/specs/cli.e2e.ts` drives the real socket and asserts a tab opened by
`termic tab` is addressable by the id that command returned (`logs --tab`,
`send --tab`, `tab -p` delivery, `status` listing), so dropping or miswiring
`PtyRole.tab_id` in TerminalPane's spawn call goes red there instead of
surfacing as a mystery in a user's script.

**How part 2 resolves selectors.** The webview's pushed snapshot
(cliAgentState.ts) carries per-tab entries (`tab_states`: id, kind, cli,
title, per-tab work state, queue, liveness, defaultness) in strip order; one
Rust resolver (`resolve_tab_selector`) serves send, wait, attach and logs
from it: exact id first, then 1-based index (the numbering `status` prints;
editor tabs are not listed and do not shift it), then case-insensitive
title/cli match. The STRIP is the whole surface, by decision: pane-split
leaves and right-panel split agents are not listed and no selector reaches
them (a right-split agent still counts in `sessions`). They become
addressable only if they are ever folded into the strip model; listing them
would break the "row n of status = `--tab n`" contract. Ambiguity errors listing the candidates. Only agent tabs
resolve (the write-only rule below). With no snapshot yet, an EXACT persisted
id still resolves so scripts keep working; index/title honestly error.
`attach`/`logs` then map the id to the tab's own PTY via `PtyRole.tab_id`
(`find_tab_pty`, no default-tab fallback); `send` passes the resolved id to
`send_prompt`, where the store re-validates it (the cache can trail a
just-closed tab); `wait --tab` narrows `watch_agent` to that tab's entry, so
a sibling tab can neither satisfy nor stall it. `send --tab --wait` still
does NOT trust a pre-existing done as its own turn settling: per-tab state
removes sibling pollution but not the cache-trails-the-store race on the
target itself, and the tab you target is often exactly the one wearing a
stale done badge (pinned by send_tab_wait_ignores_the_targets_stale_done).
`tab -p` is
`new_tab` followed by `send_prompt` targeted at the returned id with a
spawn-pending flag (wait for the racing PTY, don't refuse it): one delivery
recipe, exactly the reuse the TabData note demanded.

**Picking what to open is the hard part, and it is not a binary.** The GUI's
"+" menu already offers three distinct things and gates them: `kind: "agent"`
registry entries (filtered by `visibleCliIds` to enabled AND detected-installed),
`kind: "terminal"` custom entries (#27, which never resume and never take YOLO
args, `isTerminalCli`), and the task's aux shell. A `--agent | --shell` binary
would model none of that. So:

- **`termic tab <task> --agent <id>`** resolves `<id>` against the registry and
  fails if it is unknown, `disabled`, or not detected on PATH. The GUI simply
  hides those; the CLI must say why rather than spawn a PTY that dies on exec.
  The error lists the ids that WOULD work, since an agent driving this has no
  menu to look at. `help --json` cannot carry the list (the registry is
  per-user and mutable), so `status`/`list` are where it becomes discoverable.
- **`--terminal <id>`** for `kind: "terminal"` entries, kept separate from
  `--agent` for the same reason `--shell` is: the kinds differ in resume, YOLO
  and sandbox behaviour, so one `--kind <string>` flag would let a typo land
  you in the wrong semantics silently.
- **`--shell`** opens a plain login shell tab in the strip. NOTE this is not
  the aux terminal `attach --shell` resolves; that is a separate pane.

**Terminal tabs are write-only from the CLI, and that is accepted.** `--shell`
and `--terminal` tabs open and are fully usable in the window, but `attach`
and `logs` cannot reach them and no output ring is kept, because only agent
tabs carry a `PtyRole` and that is what both resolve against. Everything else
that separates the kinds follows from the same place: no work-done detection
(so `--wait` means nothing for them), no resume, no YOLO args, and shells are
not persisted across a restart. SANDBOXING IS A SEPARATE SWITCH, keyed on
`pty_spawn`'s `task_id` argument rather than on the role: terminal tabs are
deliberately never caged, which is what makes them usable for git and ssh
(#32). Giving them a role would make them addressable without
caging them, but that is the wrong way round: it would put an UNCAGED PTY on
the control socket where it can be driven remotely. Not an escalation (a caged
agent cannot reach the socket, and `attach --shell` already drives the uncaged
aux terminal), but it widens the socket's reach for no use case we have. The
retained-output ring per shell is the smaller cost. Part 2 kept the rule (its
selectors refuse non-agent tabs); revisit only if a real need to drive a
shell from a script turns up.
- **Omitted** = the task's own `cli`, i.e. "another one of what this task
  already runs", which is the common case and matches what the `+` button
  does before you pick anything.

Sandbox follows kind, not flag: an agent tab inherits the task's sandbox pin,
`terminal`/`shell` tabs are uncaged exactly as the GUI's are (only the agent
CLI PTY is the threat model, docs/sandbox.md). That asymmetry is the whole
reason the kinds are separate flags.

Then the targeting half (landed):

- **`--tab <n|id|title>` on `send` / `wait` / `attach` / `logs`.** Absent =
  the default agent tab, so every existing invocation keeps its meaning.
- **`status` lists tabs**: index, kind, agent, title, per-tab work state,
  queue depth, liveness, defaultness. Additive fields on `TaskStatus`
  (`tabs: Option<Vec<TabStatus>>`; `None` = the webview has not answered,
  which must not render as an empty strip).

Decisions, settled and shipped:

- **Selector stability: tab ids are the identity.** Index shifts
  when a tab closes and titles are agent-authored and change mid-turn (the
  same OSC stream the work-done classifier reads, lib/terminalTitle.ts), so
  neither can be the identity. The webview already minted a uuid per tab; it
  is carried on `PtyRole.tab_id`, so Rust resolves a selector without a
  webview round-trip. `termic tab` prints it. Index and title are human
  conveniences that resolve to it.
- **Ambiguity is an error, not a guess.** Two tabs titled `claude` fail
  with both selectors printed, the same shape as the existing ambiguous-task
  error, rather than picking the lower index.
- **`attach --shell` stays** as the alias for "the aux terminal" (it is
  shipped surface and the aux pane is not a strip tab, so `--tab` cannot
  reach it); the two flags conflict rather than quietly overlapping.
- **Resuming a closed tab.** The `+` menu offers it (`closedTabs`), and the
  CLI has no equivalent at any level. Out of scope here, but it is the obvious
  next ask once tabs are addressable, and `--tab` selectors are what it would
  hang off.
- **`tab -p` landed WITH targeting, not before.** `send_prompt` is the
  confirmed delivery route, and it used to pick only from a task's sendable
  agent tabs; `-p` is `new_tab` followed by `send_prompt` targeted at the id
  it returned. Writing a second injection recipe instead would have
  reintroduced exactly the silently-dropped prompt Phase 1 exists to prevent.

Protocol impact was additive (optional fields end to end), landing as the
v5 -> v6 bump, not a breaking change.

## Agents as users (discoverability)

The CLI's second audience is the agents themselves, and an agent only uses a
tool it can discover. Two pieces, cheap because the mechanisms exist:

- **Advertise in the task environment.** Spawns get
  `TERMIC_CLI=<absolute path to the bundled binary>` in the same env overlay
  that carries `TERMIC_TASK` and `TERMIC_SANDBOX`. Absolute path, so agents
  need no PATH install; injected only while "Enable CLI" is on, so the
  advertisement is never a lie. Uncaged agents see it and can act; caged
  agents that try get the explicit "control plane unavailable" refusal
  (cheap, clear failed discovery, no mystery).
- **Help written for LLMs as much as humans.** Every verb's help carries a
  one-line statement of what it does AND what it prints on stdout; exit
  codes are listed inline per command, not in a separate section an agent
  may never read. `termic help --json` returns the whole surface (verbs,
  flags, exit codes) machine-readably so an agent can introspect instead of
  parsing prose; under future scoped tokens it reflects the caller's
  effective scope, so a scoped agent learns exactly what it may do.

This is the path to #59's workflow with no MCP required: the agent sees
`TERMIC_CLI` in its env, runs `termic help`, and calls
`termic new fix-auth -p "..."` directly. That is the whole of #59, which is
why the `termic mcp` shim it was written against is now parked under
discussion rather than scheduled (see Phasing): it was the MCP-native upgrade
for orchestrators that want tools instead of a shell, and no such orchestrator
exists here yet. Env advertisement and the help conventions land with Phase 1,
when the verbs an agent needs exist.

Two conventions field testing settled (Phase 1):

- **The result convention is a file drop.** Agent terminal output is not
  readable from the CLI (PTY bytes are rendered by xterm, retained
  nowhere server-side), so the documented pattern - stated in `new
  --help` and the agent skill - is: the prompt tells the created agent
  to write its deliverable to a named file in the task directory;
  `--wait` + exit 0 + read `<path>/RESULT.md` closes the loop.
  Candidate Phase 2 upgrades, recorded so scoping starts here: a small
  Rust-side per-PTY ring buffer enabling `termic logs <task>` (and
  attach-with-backlog); and `termic result <task>`, reading the agent's
  last message from its session transcript via the task's persisted
  session id (agent-specific: trivial for claude's JSONL, per-agent
  readers otherwise - the file convention stays the agent-agnostic
  floor). Unattended runs also need `--sandbox enforce` (the cage
  self-approves permission prompts) or `--yolo`, or the agent stops at
  its first permission dialog; `new --help` says so.
- **Agent know-how ships vendor-neutral.** Passive help relies on agent
  initiative, so two agnostic layers close the gap: `TERMIC_CLI_HELP`
  (injected beside `TERMIC_CLI`, the `TERMIC_SANDBOX_HELP` precedent)
  carries a two-line version of the conventions every agent sees in its
  env; and docs/cli-agent-instructions.md is the canonical instructions
  block that drops unchanged into `AGENTS.md` (codex / gemini / cursor),
  `CLAUDE.md`, or any agent's instruction channel. A vendor-specific
  skill wrapper was considered and rejected: Claude-only distribution
  is not worth maintaining a second copy. Phase 2 adds an install
  action for the block. `termic mcp` would supersede all of it for
  MCP-native orchestrators, but it is parked under discussion (see
  Phasing), so the instructions block is the distribution story.

## Security: the socket is a sandbox boundary

This is the trap. The whole point of Enforce mode is that the agent's PTY
cannot write outside the cage or reach the network (docs/sandbox.md). A caged
agent that can speak to the control socket can run
`termic new x --sandbox off --yolo -p "<anything>"` and has escaped: the new
task's agent runs uncaged. The CLI socket is therefore a privilege boundary,
not a convenience port.

**The boundary is directional.** Outside -> in is free: `send`/`attach` against
a caged task are the app process (uncaged, owner of the PTY master) writing to
that task's stdin, identical to the user typing in its GUI terminal. The cage
constrains what the agent's process can do, not what stdin it receives, so
driving and viewing sandboxed tasks from the CLI needs no special machinery.
Inside -> out is the escape, and it is blocked entirely.

**Decision: caged agents get NO CLI surface, not a restricted subset.**

- Nearly every verb escalates from in-cage: `new` spawns an uncaged proxy,
  `send`/`attach` on a peer are code execution by proxy (inject "run this" into
  an uncaged sibling) plus read access to other tasks' terminals (other
  projects' secrets, conversations), `archive` is destructive. Cross-agent
  prompt injection is exactly the realistic threat sandbox.md already names.
- Even the one "safe-looking" verb, `list`, is a leak now: the sandbox is a
  pure allow-list under `(deny default)`, so caged agents cannot read
  termic's data files at all. An in-cage `list` would disclose task names,
  paths, and states the cage currently hides. Nothing is worth an anonymous
  protocol surface.
- A verb subset would require identifying WHICH task a socket peer belongs to.
  Peer creds give pid/uid only (uid is always the user); pid -> "descendant of
  task A's PTY" means process-tree walking, which pid reuse and daemonized
  children defeat. An unreliable check under an adversarial model is not a
  boundary.

**Policy lives in sandbox config, not in the CLI.** "May this task use the
control plane" is a per-task capability like an allowed host, owned by
`sandbox.rs` and rendered by `provision()`. The CLI and socket server carry no
policy of their own; they validate what the sandbox layer minted. Seatbelt is
the primary blocker (reachability), the token is what seatbelt cannot do:
identity (which task is calling, required for any future scoping), granularity
(profile rules are all-or-nothing on the socket, never per-verb), and drift
insurance (profiles are rendered per-task/per-CLI; one rendering bug should
not open the socket, and the unreadable token fails closed). v1 hardcodes the
policy (caged = none, uncaged = full) with no settings UI; if scoped access
ever ships, the knob belongs in TaskSandboxDialog/presets and renders down to
profile rules plus a scoped token.

Defenses, layered:

1. **File-token auth, token -> scope.** At boot the app writes a random token
   (fresh per boot, 128+ bits) to `<data_dir>/cli-token` (0600) and requires
   it on every request. Possession is the credential, so THREE rules keep it
   out of cages: the full token is NEVER injected into any PTY's environment
   (the CLI reads the file itself, running uncaged in the user's shell); the
   token lives only in the socket server's in-memory state, NEVER in the app
   process's environment, because `pty_spawn` copies the app's entire env
   into every child, caged included, before any sandbox filtering
   (lib.rs:1459) - an env-stashed token would silently hand a full escape to
   every agent; and the data dir stays off every allow-list, backed by an
   explicit deny (next paragraph).
   Future scoped tokens are independent random values (nothing is derived:
   holding a scoped token teaches nothing about the full one), registered
   server-side as token -> scope and revoked when their task dies. The old
   `builtin_deny_paths` hard-deny set is GONE (sandbox.rs ~1367: the sandbox
   became a pure allow-list under `(deny default)`), which default-denies
   the token - but default-denied is NOT guaranteed-denied: allow rules are
   subpath-based and the allow-list is user-, repo-, and agent-extensible
   through four unioned layers (`live_sandbox_lists`, lib.rs:1304; plus
   `agent_sandbox_add_allowed_path`, lib.rs:3672), so one broad ancestor
   (`~`, `~/Library`, `~/Library/Application Support`) silently places the
   token and `projects.json`/`tasks/` under an allowed subpath. Therefore
   emit `(deny file-read* (subpath "<data_dir>"))` as the FINAL filesystem
   rule of the enforcing profiles - last-match-wins makes the final deny
   beat any ancestor allow - and verify it behaviorally (Testing), not by
   textual absence. This holds in EnforceFs too, where the network sandbox
   is off and the socket itself is reachable. Protocol-wise the server maps token ->
   scope; v1 has exactly one token with scope `full`.

   The blocked default is CONFIGURABLE later, not architectural: a future
   "Control plane" row in the task's sandbox config (none / scoped / full,
   seeded from the project like allowed hosts/paths) lets a caged task hold
   CLI access. Scoped = `provision()` mints a per-task token with the scope
   attached (`{verbs, projects}` - project-level is the config grain) and
   places it INSIDE the cage; the server enforces scope by token possession,
   zero caller identification (vibe-kanban's orchestrator-mode tool router
   and Crystal's per-pid permission socket are prior art). The v1 protocol
   shape makes this a data change, not a redesign.

   Project scope alone is NOT sufficient - a caged agent with `send` into
   project X could inject commands into an UNCAGED task in X and escape by
   proxy. Scoped tokens therefore also carry a **sandbox monotonicity
   rule**: `send`/`attach` may only target tasks at least as caged as the
   caller (Enforce -> Off is an escape), and `new` caps the child's sandbox
   at the caller's or stricter, never uncaged YOLO. Mode ordering alone is
   NECESSARY BUT TOO COARSE, recorded now so the future phase does not
   rediscover it: two Enforce tasks can hold different capability sets, and
   a no-hosts caller sending prompts into a sibling with github.com allowed
   has found an exfiltration channel (broader write paths, a write
   channel). The real comparison is capability SUBSET, and it must compare
   EFFECTIVE capability, never stored lists: EnforceFs ignores its stored
   host list entirely (`(allow network*)`, no proxy), so its effective
   network capability is ALL hosts even when the list is empty - a stored-
   list subset check would rank it below an Enforce caller and hand that
   caller unrestricted egress through the sibling. Monitor's effective
   capability is likewise ALL. Pin the mode order explicitly: Enforce is
   strictly stronger than EnforceFs (same FS cage, network cage on top);
   Off and Monitor are unbounded. And `new` caps the child's effective
   allow-lists, not just its mode. With that rule a caged
   orchestrator farming out subtasks to caged workers never holds power it
   was not granted. This ships as its own phase with its own review; v1
   stays hard-blocked.
2. **Explicit socket deny - load-bearing, NOT belt-and-braces.** The rendered
   profile today contains `(allow network-outbound (remote unix-socket))`
   (sandbox.rs:1188), so every mode, Enforce included, currently permits
   unix-socket connects. SBPL is LAST-match-wins - the repo's own comments
   rely on it (sandbox.rs:1208, 1800), and it is why `(deny default)` opens
   the profile - so the `(deny network-outbound (remote unix-socket
   (path-literal "<sock>")))` must be emitted as the FINAL network rule of
   both ENFORCING branches (Enforce and EnforceFs - NOT Monitor, whose
   separate render path emits `(allow default (with report))` and whose
   contract is observe-never-block; a monitored agent reaches the socket by
   design, its token read and CLI use just show up in the log), after every
   allow that could match: after the broad
   unix-socket allow, after the `agy` special case's blanket
   `(allow network-outbound)`, and separately inside the EnforceFs branch,
   which early-returns at sandbox.rs:1182 with `(allow network*)` before the
   unix-socket section is ever reached. A deny placed before those allows
   would be silently overridden. Phase 0 work; until it lands, the token is
   the only thing standing between a caged agent and the socket.
3. **Same-uid peer check** (`getpeereid`) on every connection. Together with
   the 0600 modes this is the boundary against same-uid confusion; the
   token's real job is the sandbox case above. (Bitcoin Core's `.cookie` +
   tailscaled's peer-cred check are the same stack.)

Off/Monitor/unsandboxed-YOLO tasks get no new boundary: those agents can
already edit `projects.json` or run anything as the user, so the socket adds
convenience, not capability. Document it, accept it. (In Monitor mode the
token-file read shows up in the file-op log, so CLI use by a monitored agent
is at least visible.)

DX for the blocked case: `TERMIC_SANDBOX=1` already lands in every caged
spawn (sandbox.rs:1648), so the CLI can detect it and fail with "this shell
is inside a sandboxed termic task, the control plane is unavailable" instead
of a mysterious auth error. Setup/run scripts already get `TERMIC_TASK`
(lib.rs:3155 and friends); extend the same variable to agent and aux PTYs
(pty_spawn's env overlay already exists) to give `termic send --here` and
env-based task resolution for free.

The webview-outside-the-cage gap (docs/sandbox.md "Known gap") is unchanged by
this design; the socket server adds no new webview egress.

## Distribution

Bundled in `Termic.app` via Tauri's `externalBin` (sidecar) mechanism, so the
CLI updates in lockstep with the app updater and there is never a version-skew
matrix in v1. PATH install like VS Code, refined in Phase 0: enabling the CLI
auto-installs it with no prompt into `~/.local/bin` and shows whether that dir
is on the login PATH; a "system-wide" Settings action upgrades to
`/usr/local/bin` (admin prompt, macOS only). The installed command name is
build-aware - `termic` (release), `termic-dev` (debug, targets the `termic_dev`
data dir), `termic-beta` (beta bundle) - so dev, beta, and prod coexist on
PATH; the on-disk sidecar is always `termic-cli`, only the symlink name varies.

The CLI's `--version` reports the APP version, not the crate version: it is
injected at build time via `TERMIC_APP_VERSION` (set by `src-tauri/build.rs`
and `scripts/build-cli.mjs`, read through `option_env!` with the crate version
as the dev fallback), so a bundled CLI is always versioned with the app it
ships in. The hello handshake carries a protocol version anyway, so a
CLI-only Homebrew formula would need no protocol change. It is still not
being built (see below).

### Homebrew

- **Cask: done.** `brew install --cask simion/termic/termic` ships the app;
  `release.yml` bumps its version + sha256 in the tap on every release.
- **CLI-only formula: not doing it.** `brew install termic` would hand you a
  client with no server. The app IS the daemon, so a standalone CLI has
  nothing to talk to and cannot even auto-launch one. It would also break
  `--version` reporting the app version, and reintroduce the version skew
  this design avoids by bundling.
- **Not a cask `binary` stanza either.** That would put `termic` on PATH for
  everyone, which Landing rules out: the binary stays off PATH until the user
  runs the install action.

If CLI-first distribution is ever wanted, it means the rejected pattern-2
architecture (standalone CLI over a shared core), not a formula wrapping a
client whose server is missing.

## Phasing

- **Phase 0**: `termic-proto` + socket server (own thread, token auth) +
  `termic open` + `termic list` + `termic status` + bundling + PATH install.
  Proves transport, auth, launch-if-needed, and webview RPC (work-state
  query) end to end.
- **Phase 1**: `termic new` (setup streaming, prompt injection) with
  `--wait`, `termic wait`, `termic archive`, `termic project
  add|list|remove`. The headline feature. Injection REUSES the agentRace
  recipe's spawn/settle timing but must NOT reuse its delivery semantics:
  `seedPromptWhenReady` is a webview timer chain documented "gives up
  silently" (agentRace.ts:38), and a webview reload during the settle
  window drops it while the Rust-owned PTY survives idle - under `--wait`
  that idle agent looks quiescent and would exit 0 for a prompt that never
  ran. The CLI's injection path must report delivered/failed back to the
  server; exit 0 requires CONFIRMED delivery + that turn settled, and
  undelivered prompts exit with the dedicated "prompt never delivered"
  code.
  `--wait` rides the settle signal the webview already computes for
  notifications (`useAttentionNotifier` / workState): the webview pushes
  workState flips down to Rust once, the server holds the reply until the
  task's agent settles. Once those flips live in Rust, `list` switches to
  that Rust-side cache and drops its Phase 0 webview round-trip (works even
  when the webview is busy; one less moving part). Honesty caveat, stated in
  --help: settle detection is heuristic (title signals, output scan), so
  `--wait` means "the agent stopped", not "the work is right". Known upgrade
  path for Claude Code agents specifically: install Stop/Notification hooks
  into spawned agents for exact push-based done/needs-input signals instead
  of heuristics.

  Phase 1 implementation notes, where reality refined the sketch:
  - The push channel is `cli_agent_states`: the webview
    (src/lib/cliAgentState.ts) pushes a FULL per-task snapshot `{state,
    tabs, queued, capable}` on every debounced store flip plus a 20s
    unchanged re-push as a freshness heartbeat; the server treats a cache
    older than 120s as "the UI stopped reporting" and fails waits instead
    of trusting a frozen snapshot (but answers first if the cached state
    is already quiescent - an idle occluded webview is not a dead one).
  - Quiescence = settled AND `queued == 0` (the per-tab message queues),
    exactly as designed; `capable` (workDoneCapable per tab) is what lets
    `wait` refuse opted-out agents server-side.
  - Delivery confirmation is `cli_prompt_report`: the server mints a
    prompt id, registers interest BEFORE the webview learns it, and the
    injection path (deliverMessage, which resolves only after text + CR
    are written) reports delivered/failed. No report inside 90s = exit 9.
    One honesty compromise: if delivery confirmed but the turn's
    "working" edge is never observed (classifier miss) and the agent
    sits idle 30s, the wait calls it settled rather than hanging.
  - Streamed replies are NDJSON events (`setup_output`, `created`,
    `prompt_delivered`, `state`, `heartbeat`) before the final Reply;
    heartbeats every ~10s keep the CLI's 30s read timeout honest during
    silent setups and long waits, and a failed heartbeat write is how a
    server-side watch notices the client hung up (Ctrl-C) and stops.
  - Setup streaming tees the setup TAB's PTY output (the webview
    subscribes to the same `pty://<id>` events xterm renders and
    forwards chunks as RPC progress), so the CLI sees exactly what the
    GUI's setup tab shows, and only until spawn.
  - Creation goes through one app-wide create lock in the webview
    (src/lib/createLock.ts), now shared by the New Task dialog, quick
    create, agent races AND the CLI handler, closing the destructive
    same-name interleave for the GUI paths too. Branches auto-number
    past existing names (the dialog's uniqueBranch, now shared).
  - `new -p` marks the task's default tab unattended
    (lib/unattendedSpawns.ts) so UNATTENDED_SPAWN_ARGS compose in and a
    startup update menu can't swallow the injected prompt - the same
    mechanism race cohorts use.
  - The CLI reconnects before any post-confirmation request (archive,
    project remove, the unregistered-project add flow): a human can sit
    on a y/N prompt longer than the server's 30s idle timeout.
  - Protocol bumped to v2; the version check is direction-aware ("Termic
    updated, rerun" vs "restart Termic") since a stale RUNNING app under
    a fresh bundle is the likelier skew after an auto-update.
- **Phase 2**: `termic send` (same `--wait`), `termic apply`, `termic attach`
  with `--shell` (Rust-side PTY
  tee, raw mode, SIGWINCH -> `pty_resize`, detach key), plus the
  result readers scoped under "Agents as users": `termic logs` (per-PTY
  ring buffer) and `termic result` (session-transcript reader), and the
  cheap reads `termic diff` / `termic path`.

  Phase 2 implementation notes, where reality refined the sketch:
  - PTY addressing is a `role` field on `pty_spawn` ({task_id, kind
    agent|aux, is_default}), deliberately SEPARATE from `task_id`,
    which doubles as the sandbox trigger: the aux terminal stays
    uncaged (CLAUDE.md) yet attachable. Role-tagged PTYs get a 256 KiB
    output ring plus attach taps, fed atomically by the PTY reader
    thread; everything else keeps the zero-overhead path. `logs` reads
    the whole 256 KiB ring, trimmed to an 850 KiB ESCAPED-byte budget
    (JSON escaping of ANSI can inflate ~6x and reply lines cap at
    1 MB); `diff --full` truncates past the same escaped budget with
    an explicit marker, and the commit list gets a 32 KiB budget of
    its own.
  - `send` to an idle running agent delivers INSIDE the RPC (exit 0
    without --wait already means delivered). A busy capable agent
    queues with the CLI's prompt id riding on the queue item, and the
    TerminalPane drain delivers it tracked; a queued `--wait` drops
    the fixed 90s delivery timeout (a turn can run an hour) for a
    vanished-queue detector (queue empty + agent not working + no
    report for the idle grace = a reload dropped the queue, exit 9).
    Opted-out agents get the prompt typed immediately with a warning;
    `--wait` refuses them before sending anything.
  - `send --resume` restores per target state: an exited tab gets a
    programmatic Restart (a respawnKick field TerminalPane watches,
    reusing the exited banner's path and the tab's own resume
    decision); a fully closed task mounts and hydrates its persisted
    tabs. Both mark the spawn unattended first. `--fresh` adds a
    secondary agent tab, which starts context-free by design.
  - Attach ends with a reasoned final Reply: "detached" (exit 0),
    "exited" / "archived" (exit 11, the in-band detach frame first).
    CLI-initiated archives notify live attach sessions BEFORE the
    SIGKILL. The client withholds partially-matched detach sequences
    (Docker's behavior) and delivers SIGWINCH to the stdin thread via
    sigmask so the EINTR lands where the read blocks.
  - `result` reads claude's JSONL transcript: the persisted default
    tab's session id pins the file (repo-root tasks); otherwise the
    newest transcript for the task cwd, which is exactly what
    `--continue` would resume (worktree tasks). Other agents error
    toward the RESULT.md convention. `path` is CLI-side sugar over
    `status`; no new wire command.
  - The "install the instructions block" Settings action stayed
    unbuilt; docs/cli-agent-instructions.md remains paste-your-own.
- **Phase 3**: windowless daemon mode (activation policy + run without a
  window), `termic quit`, tab management inside a running task (GH #138, see
  "Tabs inside a running task").

  `termic events --json` (a standing subscription: one JSON line per task
  event, done / waiting / created) is SEQUENCED BEHIND agent hooks rather
  than deferred indefinitely. The order is the whole point. Termic's settle
  detection is heuristic by product design (PTY-native, so done-ness is
  inferred from title signals and output scans), and `--wait` carries that
  caveat in --help because its blast radius is one command with a human
  watching. An event stream is a VERSIONED PUBLIC API consumed by scripts
  with nobody watching, so publishing `{"event":"done"}` on a guess means
  owning those semantics forever. Installing Claude Code Stop/Notification
  hooks into spawned agents replaces the guess with exact push-based
  signals; build the stream on that. So the work item is HOOKS FIRST, then
  the stream, Claude-only at first, with the heuristic staying as the
  fallback for agents that have no hook surface. Neither is scheduled yet;
  what is settled is that the stream does not ship before the hooks.

  `termic quit` (protocol v4): the only shell-side teardown for a
  windowless instance, since the menu-bar Quit is otherwise the sole
  affordance and a user who picked "Keep in Menu Bar" plus don't-ask-again
  needs one that does not involve the mouse. Notes:
  - Authenticated, like every destructive verb. Caged agents cannot reach
    it at all (seatbelt denies the socket), same as `archive`.
  - Two-step: `preview` reports what WOULD die so the confirmation can
    name it, then the commit. The preview must never tear anything down.
  - Confirms on a TTY unless `--yes`, with the reconnect-after-confirm
    `archive` uses (a human outlasts the 30s idle timeout).
  - The server replies BEFORE exiting, and the teardown is triggered by
    the connection thread AFTER its write returns, not by a fixed grace.
    A timer cannot be sized: the serving thread can be descheduled past
    any constant on a machine busy running agents, and a successful quit
    would then be reported as CONNECTION_LOST. The flag is thread-local,
    since one thread per connection means a global would let a concurrent
    request consume it and quit before the quitting client's reply lands.
  - Never auto-launches, and exits 0 when Termic is not running ON THE
    DEFAULT SOCKET: starting the app to stop it is absurd, and a teardown
    script should not need `|| true`. With TERMIC_SOCKET set explicitly a
    missing socket is a misconfiguration and still exits 4 - reporting
    success there would tell a script it had stopped agents that are in
    fact still running.
  - Live-agent counts come from the PTY map (ground truth for what gets
    SIGKILLed), filtered to agent-kind roles so the aux shell and
    setup/run script tabs are not counted as agents. The working count is
    per TASK (the work-state cache aggregates that way), reports 0 when
    stale, and is clamped to the task count.

  Windowless mode implemented, where measurement refined the sketch:
  - The trap's "keep the webview alive hidden" branch WON on evidence, so
    no orchestration moved to Rust. A hidden webview under
    `ActivationPolicy::Accessory` is not suspended: JS keeps running
    indefinitely at WebKit's 1 Hz background-timer floor, and Rust->JS
    event delivery (the path PTY output takes) is not throttled at all
    (measured full rate). Every settle constant is >=3s and the byte-quiet
    check is wall-clock (`Date.now() - lastOutputAt`), so detection
    semantics are unchanged; the clamp costs latency, not correctness.
    `PUSH_DEBOUNCE_MS` (80) stretches to ~1s, well inside the server's
    120s staleness cutoff. Verified end to end: with the app windowless,
    `termic list` still reports live per-task work state from the pushed
    cache.
  - Scope note: this is macOS app semantics (Close -> windowless, Quit ->
    teardown), NOT a separate daemon. It is also ORTHOGONAL to the rest of
    Phase 3 - as this plan already said, "the socket protocol does not change
    for it". `events --json` and Homebrew do not depend on it, and the
    CLI-facing part is just `--headless` plus the `open --args` change. The
    substance is a product decision: closing the window used to QUIT Termic
    and kill every running agent, and now it does not. There is no headless-without-a-
    webview mode, and per the design there must not be: the webview owns
    PTY lifetime (unmounting a task kills its agent) and every work-state
    signal.
  - The cost model is the opposite of the intuition, and is why windowless
    mode has a webview half: hiding the WINDOW does not pause xterm's
    renderers (they key on zero geometry, which only `display:none`
    produces). See docs/performance.md bear trap 2b for the numbers.
    Windowless mode keeps agents alive; it does not make Termic cheaper,
    and it reclaims no memory.
  - `--headless` (how the CLI auto-launches) boots straight into
    windowless mode so a shell command never steals a window or a dock icon.
    An instance that has never shown a window stays `Accessory`; once the
    user has seen one, the dock icon persists for the process lifetime,
    matching Mail/Messages.

### `termic mcp`: under discussion, NOT approved

A stdio<->socket shim (~a day) that would make termic drivable by any MCP
client - an outer Claude Code session orchestrating termic tasks - with the
same auth and policy, no new surface. The converged pattern in the space
(vibe-kanban, container-use).

Parked 2026-07-24, the day 0.24.0 shipped the CLI. Not rejected on the merits:
it is an overcomplication for the users that exist today. #59 is the use case
it was meant to serve, and Phase 1's CLI closes that issue on its own (the
agent reads `$TERMIC_CLI` from its env and runs `termic new`), so building it
now means maintaining a second surface for nobody. #59 was closed saying as
much.

What would reopen it: an MCP client with NO shell tool that someone actually
wants to orchestrate termic from (Claude Desktop, an IDE plugin without a
terminal). Nothing running inside Termic qualifies - every agent there has a
PTY, which is the whole point of the app - so the case has to come from
outside. The context-window objection that killed it the first time (an MCP
tool definition costs tokens in every session; a CLI costs nothing until it
runs, @MHohlios on #59) applies to that client too, so "someone asked" is not
sufficient on its own.

If it is ever built, the design constraint stands: keep the tool count minimal
and GENERATE the tool definitions from the same `help --json` metadata, so the
CLI and MCP surfaces cannot drift.

## Testing

The e2e harness (docs/automation.md, `.claude/skills/e2e`) is already the
right rig: an isolated `TERMIC_DATA_DIR` scratch profile plus
`scripts/fake-agent.sh` registered as a custom agent means socket
integration tests can exercise the full create -> spawn -> inject -> settle
-> `--wait` loop against the live dev app without burning agent tokens.
Layers:

- `termic-proto`: plain unit tests (round-trip every message, version
  mismatch behavior).
- Socket server: integration tests over the e2e rig - auth (no token, bad
  token, missing socket), each verb, streaming framing, disabled-CLI error.
- Sandbox invariants, ALL behavioral - textual profile checks cannot catch
  a rule rendered in a position where last-match-wins makes it inert, and
  cannot catch an allow-listed ANCESTOR re-exposing a path whose literal is
  absent from the list. From inside a caged spawn, in both enforcing modes:
  (a) a real connect() to the socket path is refused; (b) a real open()/read
  of the token path is refused - including with a hostile fixture that
  allow-lists `~/Library` via each of the four extension layers; (c) the
  spawn's environment contains no token variable (guards the app-env
  invariant against `pty_spawn`'s full env copy). Monitor is exempt by
  contract (observe, never block).
- CLI binary: golden tests for exit codes and `--output-format` shapes; the
  exit-code contract is public API, treat it like one.

Cross-platform note: the design is unix-socket + seatbelt, macOS like the
app. Linux would need only a socket-path change; Windows means a named pipe;
the sandbox layer is macOS-only regardless (`sandbox_available` already
gates it).

## Landing

One phase = one PR into main, the repo's established shape (#62, #84, #113).
No long-lived integration branch: it drifts in a repo this fast, and the final
merge is a giant unreviewable diff whose sub-reviews detach on rebase. Every
phase PR must leave the app's primary build green and behaviorally unchanged
for anyone who has not opted in.

Merged is not live; exposure is controlled independently of review:

- Verbs are gated behind an "Enable CLI" setting (default off initially).
  The server always binds once its phase ships and answers hello/status
  regardless, so a disabled CLI fails fast with "Termic is running but the
  CLI is disabled, enable it in Settings". The unauthenticated surface is
  `hello` (discloses app-is-running + protocol version) and `raise` (brings
  the window to front, used by the single-instance handshake); neither leaks
  anything sensitive to a same-uid process, and that disclosure is the price
  of the clear error plus single-instance, and is accepted. (The obvious alternative, bind
  only when enabled, creates a first-run dead end: `termic new` auto-launches
  the app, polls a socket that will never bind, and times out with the WRONG
  error, "Termic did not start".) A merged phase is dormant behavior until
  the user flips the setting.
- The binary is not on anyone's PATH until they run the install action.
- Nothing is user-visible until a release is cut and the maintainer writes
  the changelog entry, as always.

Flip the setting's default (and announce) only when the surface feels done.
Incremental review, big-bang exposure.

## Traps

- **Do not serve the socket on the IPC/main thread.** Sync IO on the WKWebView
  event-loop thread froze the Mac once already (docs/ipc.md). The automation
  bridge's dedicated-thread model is the template.
- **Webview RPC needs a live webview.** RESOLVED in Phase 3 by keeping the
  webview alive hidden (measured: not suspended, see Phasing), so no
  orchestration moved to Rust. The constraint is now permanent rather than
  transitional: windowless mode MUST keep the webview alive, because the
  webview owns PTY lifetime (unmounting a task kills its agent) and every
  work-state signal `--wait` rides. A future "no webview at all" daemon would
  have to move both down to Rust first.
- **Occluded windows freeze rAF** (docs/automation.md). The prompt-injection
  settle path must stay on wall-clock timers, never rAF, or `termic new -p`
  breaks exactly when the app is windowless, which for a CLI is always.
- **cwd resolution is ambiguous**: a path can be inside a project repo AND a
  task worktree of another project (worktrees live under `~/termic/tasks/`).
  Resolve worktree-first, then longest project-path prefix; `--project`
  overrides.
- **The CLI never touches termic's data files, read or write.** If it ever
  writes `projects.json`/`tasks/` directly "because the app wasn't running",
  the single-writer assumption breaks silently; if it ever reads them, an
  offline mode has snuck in. Launch the app instead; that is the design.
