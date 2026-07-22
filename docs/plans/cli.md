# termic CLI (design)

Status: proposed, not started.

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
  lib.rs:545), so dev and release sockets never collide; a hypothetical Beta
  RELEASE build would share the release socket - accepted for v1, noted.
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
  fail with "Termic did not start" rather than hanging. `--no-launch` swaps
  auto-launch for an immediate "Termic must be open" error, for scripts.
  Concurrent invocations racing `open -ga` are deduped by LaunchServices; if
  doubles ever show up anyway, tmux's flock'd spawn lock is the known fix.
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
termic new <name> [-p|--prompt <text>] [--agent claude|gemini|codex|<custom>]
           [--worktree|--main] [--base <branch>] [--sandbox off|monitor|enforce|enforce-fs]
           [--yolo] [--project <name>] [--open] [--wait] [--attach]   # --attach lands with Phase 2
termic list [--project <name>] [-q]           # tasks + workState + diff stat (alias: ls; -q = ids only)
termic open [<task>]                          # raise window, select task (cwd-aware)
termic status <task>                          # one task in depth: agent state, branch,
                                              # dirty file count, session count
termic send <task>|--here -p <text> [--wait]  # prompt the RUNNING agent; if it is mid-turn
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
           [--resize] [--shell]               # aux terminal instead; interactive but
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
`termic new fix-auth -p "..."` directly. The `termic mcp` shim (Phase 3) is
then the MCP-native upgrade for orchestrators that want tools instead of a
shell - same CLI, same auth, same policy underneath. Env advertisement and
the help conventions land with Phase 1, when the verbs an agent needs exist.

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
matrix in v1. PATH install like VS Code: a Settings action (plus a first-run
hint) symlinks the bundled binary into `/usr/local/bin` (admin prompt) or
`~/.local/bin` (fallback, no prompt). The hello handshake carries a protocol
version anyway, so a later Homebrew formula (CLI-only installs, version skew
becomes real) needs no protocol change.

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
- **Phase 2**: `termic send` (same `--wait`), `termic apply`, `termic attach`
  with `--shell` (Rust-side PTY
  tee, raw mode, SIGWINCH -> `pty_resize`, detach key).
- **Phase 3**: windowless daemon mode (activation policy + run without a
  window), Homebrew formula, `termic events --json` (standing subscription:
  one JSON line per task event - done, waiting, created - fed by the same
  settle signal as `--wait`). The event stream is also what would make
  app-side hooks ("on task done, run this command" in settings) trivial
  later; hooks themselves are a separate future feature, not part of this
  plan. Also Phase 3+: `termic mcp`, a stdio<->socket shim (~a day) that
  makes termic drivable by any MCP client - an outer Claude Code session
  orchestrating termic tasks - with the same auth and policy, no new
  surface. This is the converged pattern in the space (vibe-kanban,
  container-use). Keep the tool count minimal and GENERATE the tool
  definitions from the same `help --json` metadata, so the CLI and MCP
  surfaces cannot drift.

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
  CLI is disabled, enable it in Settings". The unauthenticated hello
  intentionally discloses app-is-running plus protocol version to any
  same-uid process; that disclosure is the price of the clear error and is
  accepted. (The obvious alternative, bind
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
- **Webview RPC needs a live webview.** Fine in v1 (app dies with the window),
  but Phase 3's windowless mode must either keep the webview alive hidden or
  move the orchestration handlers down to Rust first.
- **Occluded windows freeze rAF** (docs/automation.md). The prompt-injection
  settle path must stay on wall-clock timers, never rAF, or `termic new -p`
  breaks exactly when the app is backgrounded, which for a CLI is always.
- **cwd resolution is ambiguous**: a path can be inside a project repo AND a
  task worktree of another project (worktrees live under `~/termic/tasks/`).
  Resolve worktree-first, then longest project-path prefix; `--project`
  overrides.
- **The CLI never touches termic's data files, read or write.** If it ever
  writes `projects.json`/`tasks/` directly "because the app wasn't running",
  the single-writer assumption breaks silently; if it ever reads them, an
  offline mode has snuck in. Launch the app instead; that is the design.
