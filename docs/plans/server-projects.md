# Server projects are ordinary projects

Status: approved 2026-11-20, in progress on the termic-server branch (#82).

A project on a server you reach over SSH is a desktop project like any
other: the normal sidebar and task view draw it, and right-click, drag,
pins, task groups, folders, project settings, New task, archive, the
file tree, the diff, git, run and setup scripts all work on it. The
desktop owns everything about it; termic-server only executes on the box.

Today a server has its own UI stack (`src/components/remote/*`,
`src/lib/remote.ts`, `remote_client.rs`) and termic-server keeps its own
project list and task order (`termic-server/src/state.rs`). That stack
reaches a fraction of the features and duplicates the rest.

## Model

- `Project.server: Option<String>`: the server's id (`servers.json`).
  `root_path` is the path ON THE BOX. A project without it is local, as
  every project is today.
- A task of a server project has its worktree path on the box in
  `Task.path`. Nothing else about Task changes: order, pins, groups,
  tabs, schedules, settings stay in the desktop's JSON.
- termic-server keeps only what it needs to execute: which worktrees
  exist and which PTYs run. Its project list becomes a cache of paths
  the desktop registered; its task order and names are no longer read.

## Two primitives on termic-server

Almost every desktop feature that touches a task is the desktop running
a program in the task's folder. Instead of a verb per feature:

1. `exec { cwd, argv, env, stdin?, timeout_ms }` -> `{ code, stdout,
   stderr }`, capped output. `cwd` must be inside a registered project
   or one of its worktrees. Covers git (status, diff, log, blame,
   stage, commit, push, branches, checkout), file reads and listings,
   `.termic.yaml`, clone and `git init`, forge CLIs on the box.
2. `pty_open { id, cwd, cmd, args, env, cols, rows }`, `pty_input`,
   `pty_resize`, `pty_kill`, with output per PTY id on the stream
   (`pty_data { id, data }`, `pty_exit { id, code }`). Several at once
   per connection. Covers the agent, shell tabs, run and setup scripts.

## Desktop routing

- `TaskHost` (src-tauri): `run(argv, cwd)` and `spawn_pty(...)` either
  locally (today's code) or through the server's connection. The git,
  file and script commands call it instead of `std::process::Command`
  and `portable_pty` directly, so one implementation serves both.
- `ipc.ptySpawn` for a server task returns a pty id backed by
  `pty_open`; `pty://<id>` and `pty-exit://<id>` are emitted from the
  stream, so TerminalPane and AuxTerminal need no remote branch.
- Commands with no meaning on a box (reveal in Finder, open externally,
  the macOS sandbox) are hidden for server tasks.

## Shipped so far

- Stage 1 in full.
- Stage 2, partly: termic-server `pty_open` family (cap `pty`), and
  `pty_spawn` in a server folder opens there. A server task's view has
  shell tabs on the box that live on while you switch tasks; Run opens
  the run script in one and Stop closes it; a task made from the server
  dialog runs the setup script in a Setup tab; Prompts go to the box's
  agent through `send`. Open with opens the worktree in VS Code or Cursor
  over SSH, and Run offers custom run commands too.
- Stage 3, partly: termic-server `exec` (fenced to project roots and
  worktrees). `git_bytes` and `git_raw` (lib.rs) send a server folder's git
  there through an index of server paths in `server_projects.rs`, so the
  git panel, diff, stage, commit and push work. The file tree listing,
  editor read and save, `.termic.yaml` and Send to main run on the box
  too; the tree refreshes when the box's agent finishes a turn (no
  watcher), and archiving runs the archive script there first.
  `project_add --clone` clones a repo onto the box (inside home, onto a
  new path) without widening exec's fence. Left: the rest of the task
  menu (agent, sandbox, resume, schedules); its Duplicate opens the
  server dialog from the task's branch.
- Stage 4 in full: a server records the window it was added in and its
  projects mirror into that profile; the sidebar's projects header has an
  Add a server button, and the Add project dialog links to it.

## Finishing it: what is still duplicated, and the order to remove it

Reviewed 2026-11-22 (read-only architecture review of the branch). The
first termic-server landed as a self-contained task engine, before this
plan; stages 1 and 4 replaced its organisation, stages 2 and 3 its git,
files, scripts and shells. What still runs on the bespoke engine, with
the drift already found:

- **The primary agent, its registry, argv and resume.** `agents.rs`
  `BUILTIN` (claude, codex, gemini, opencode, shell) against the
  desktop's `default_agents()` (11 agents, no gemini) and
  `spawnArgsForCli`; the box resumes with `--continue` and knows no
  session ids, accounts, YOLO args or env.
- **Task creation.** `verbs.rs new_task` against `task_create_sync`; the
  two slug functions differ (`util.rs slug` drops `_`, caps at 60), so
  one name gives two branch names. `--from`, `--resume`, `--pr` refused.
- **Work state.** `detect.rs` (quiet window and literal strings) against
  hooks and `classifyAgentTitle`, both inside one RemoteTaskView.
- **The task view and New task.** `RemoteTaskView.tsx` (own tab strip,
  `useServerShells`) and `NewRemoteTaskDialog.tsx`, plus about a dozen
  `project.server` branches (MainArea, useShortcuts, NewTabPalette,
  UnifiedBar, Sidebar, ProjectActionsMenuItems).
- **Copy-paste.** `last_assistant_text`, `claude_project_dir_name`,
  `interrupt_key` (the box's copy misses next-claude, cursor, grok).
- **Two task stores** (`state.rs TaskRec`, reconciled by `mirror()`) and
  two stream hosts (`session.rs`, `remote_server.rs`).

Why a shared engine crate is not the answer: half the engine (spawn
argv, title classification, the prompt queue) lives in the webview, so a
box could not link it. The thin host is, with one piece the stages above
missed: **`pty_open` PTYs belong to the connection** (`session.rs`) and
die with it, so only the daemon's own agent PTY outlives a sleeping
laptop. That is the reason the agent never moved.

Order, each step shippable on its own:

1. **Share the copies** (done, 16696208): `slugify` and `interrupt_key`
   in `termic-proto`, `last_assistant_text` in `termic-remote`.
2. **Daemon-owned PTYs** (done): the PTY map is the daemon's; `pty_open`
   with a running `pid` attaches, `seen` skips what the client has and
   means attach only (cap `pty_keep`, docs/remote.md). No floor bump: a
   desktop falls back to the old behaviour on a box without the cap.
3. Partly done: server tasks are drawn by TaskView; the desktop starts
   their agent and every tab through `pty_spawn` (claims and handles,
   docs/remote.md), with `task_spawn_env` shared and PtyManager slots, so
   the CLI's send / wait / logs / stop / diff take the local path. One
   top bar, one task menu, one Cmd+T palette (agents by `server_which`
   against the desktop's registry); the box's state reading covers a
   desktop-started agent for when no desktop has it open. Left: writing
   the hook config on the box, deleting RemoteTaskView's server half.
4. Done: `task_host.rs` (local or the box through exec) carries task
   creation's own filesystem steps; `task_create_sync` and
   `task_open_repo` make a server project's task with the desktop's code
   (worktree in the box's worktrees folder, the fence's), record it there
   with `task_put` (plain data, starts nothing), and the ordinary
   NewTaskDialog opens for server projects (agents by `server_which`, no
   isolation or secrets panes). A server's own New task opens it through
   `openNewTaskOnServer`; NewRemoteTaskDialog is a server's Add project
   only (paired computers keep it whole). The phone host's relay of server
   terminals is gone (their slots are local). Not on a box yet: git-crypt,
   profile customizations written into the worktree.
3. **The agent as an ordinary tab** (done; hook config on the box for
   every agent but the slot agents, docs/agent-hooks.md "Transport"): spawned with the desktop's argv, session id and env through
   `pty_spawn`; server tasks draw with TaskView and TabBar. RemoteTaskView
   is the paired-computer overlay only (`useServerShells`, `useBoxAgents`
   and its server tabs are deleted).
4. **Task creation over `exec`**, through a `TaskHost` seam that replaces
   the scattered `server_for_path` checks. New task is the one
   NewTaskDialog, agents the box lacks disabled. Delete
   `NewRemoteTaskDialog.tsx`, `verbs.rs new_task` and its CLI forward.
5. **Shrink the box** (done): the agent table (`agents.rs`, with
   gemini), resume-on-boot, the box's own agent engine (`Live`, its
   prompt queue) and the `new` and `agents` verbs are deleted; a task's
   agent on the box is the desktop's `<task>:agent` PTY, which `send`,
   `logs`, `stop`, `keys` and the terminal act on, and the box never
   starts one. `state.rs` keeps projects (`project_add` / `project_remove`),
   tasks (`task_put`, `archive`) and each task's organisation (`org`:
   name, pin, order, group, opaque to the box, last write wins by its `at`
   stamp) as shared records; the `tasks` snapshot carries pin, order and
   group, so a change any desktop makes is a snapshot change every
   connected desktop resyncs (`server_projects.rs` `push_org_if_changed`
   and `newer_box_org`). The box keeps `exec`, the PTY family, the
   hook-OSC reader and `detect.rs` as the fallback state.
6. **One stream host** (done): what the two hosts' session loops shared
   line for line, the outgoing queue, its back-pressure and the writer
   that resyncs a client that fell behind, is `termic-remote`'s
   `outbox.rs`, used by `session.rs` and `remote_server.rs`. The copies
   had already drifted: the desktop's never uncounted a dropped chunk, so
   a phone that fell behind once never caught up. What stays per host is
   host logic, not a copy: the desktop's snapshot is built from its store
   (folders, PRs, profiles), the box's from its records; their verbs
   differ. A trait over those would be an indirection with one
   implementation each.

### Step 3, as found in the code (2026-11-22)

- **Hooks need nothing new on the desktop.** The OSC contract is parsed
  in the webview (`src/lib/agentHooks.ts`, TerminalPane's
  `registerOscHandler`), so a server PTY's output, arriving as the same
  `pty://` events, is read exactly like a local one. The box sets
  `TERMIC_PTY` (done, 4f67a62b); left is writing the hook config there.
- **The spawn already routes.** TerminalPane -> `ipc.ptySpawn` ->
  `pty_spawn` -> `server_pty_spawn` by cwd. What differs is the env:
  `pty_spawn` builds it inline (task ports, `TERMIC_TASK_ID`,
  `TERMIC_TASK`, `TERMIC_TAB_ID`, `configure_terminal_env`'s terminal
  claims, MCP env), `server_pty_spawn` forwards only the webview's
  overlay. One `spawn_env()` both call, with the local-only entries
  (`TERMIC_CLI` and its help, sandbox, Docker, Secrets, accounts, the
  history shim, `TERMIC_PTY`) left to the local host. A registry command
  that is an absolute local path runs as its basename on a box.
- **Server PTYs are not in `PtyManager`.** They live in
  `remote_client`'s own map, so the CLI (`logs`, `send`), the phone host
  (`remote_server` `find_role_pty` / `find_tab_pty`) and feeds never see
  them. They get a slot there whose I/O is the server connection, so
  every PTY consumer has one path.
- **Frontend branches to delete** once TaskView draws server tasks:
  MainArea (RemoteTaskView), UnifiedBar (prompts via `send`, server Run,
  `useServerShells`), NewTabPalette, useShortcuts (Cmd+W server branch),
  Sidebar (`remoteState`), `cliAgentState.ts` (server rows), RightPanel.
- **The agent claim.** Opening a task whose agent is not running starts
  it through a compare-and-set on the box, so two desktops start one.
- **Tasks made by the old engine** have their agent in the daemon's own
  PTY: on first open under the new path it is stopped there and resumed
  by the desktop's spawn (its session id unknown, so the agent's
  cwd-based resume).

Accepted trade-off: with the laptop asleep, a server task's state is the
cruder floor, and a phone cannot create a task straight on a box. If
phone-to-box without a desktop becomes a goal, the box gets the agent
table pushed to it then. Open risk in step 3: agent hooks on the box
have no transport back to the desktop yet, so server agents read state
from titles (and the floor) until one exists.

### Agent hooks on the box

Done (`agent_hooks::sync_server`), codex's trust step included; the
slot agents (agy, copilot, grok, muse) are what is left.

Hooks are not a socket back to the desktop: each one writes an OSC into
the agent's own terminal (`$TERMIC_PTY`, docs/agent-hooks.md
"Transport"), which is why they already work inside Docker. So on a box:
the desktop's installer writes the agents' hook config there (through
`exec`, which means the installer goes through `TaskHost` with the rest
of step 4), and the agent is spawned with `TERMIC_PTY` set to its slave
path on the box. The OSCs then ride the PTY stream the desktop already
reads, and its existing parser gives a server agent exactly a local
agent's state. The daemon keeps them in the ring for a reconnect, and
can read the same OSCs itself for an exact state with nobody attached.
`detect.rs` stays only as the fallback for agents without hooks. Codex
trusts hooks per machine, so its trust step runs on the box too.

## Decisions, 2026-11-22

- **The server knows processes, not tasks.** Its surface: `exec`,
  daemon-owned PTYs (open, attach, input, resize, kill, a ring), the
  queued-prompt drain, reading hook OSCs out of PTY output for a state
  with nobody attached, the folder fence. No agent registry, argv,
  resume, worktree creation, slugs or task verbs. What both sides must
  compute identically lives in `termic-proto` / `termic-remote`, called
  by both, never copied.
- **`TaskHost` is the seam.** One trait in the desktop: `run`,
  `spawn_pty`, file read / write / list / exists / mkdir, `which`, and
  `caps` (sandbox, Docker, keychain, reveal in Finder...). `LocalHost` is
  today's code behind it; `RemoteHost` is one server connection over
  `exec` and the PTY family. Every task operation is `host_for(task)` and
  one implementation. The UI gates on host caps, not on `project.server`.
  A server PTY emits the same `pty://` events, so TaskView, TabBar and
  NewTaskDialog need no remote branch.
- **No invisible local server.** Running termic-server on the Mac for
  local tasks would give one transport and agents that survive an app
  restart, at the price of a daemon (CLAUDE.md), moving the sandbox,
  Docker, secrets and macOS permissions into it, and a hop on every
  terminal byte. `LocalHost` in process is that server without the
  process boundary; if surviving a restart becomes a goal, swap it
  behind the trait.
- **A box looks the same to every desktop that reaches it.** Several
  laptops (the same Unix user on the box, so one daemon) share one view:
  the box stores records, as plain data with no logic: projects, tasks
  (id, name, branch, worktree, agent, PTY ids, archived), organisation
  (groups, pins, order, folder colours) and project settings that affect
  the work (setup, run and archive scripts, base branch). Desktops write
  them through a put / delete interface; every connected desktop gets the
  change and mirrors it (`server_projects.rs`). Last write wins per
  field. What stays per desktop is how it is viewed: collapsed folders,
  the open task, tab layout, splits, the profile it shows in. This
  replaces the earlier stage-1 rule that the desktop owns a server
  project's organisation and stops reading the box's order.
- **Several desktops at once.** Every write goes to the box, which
  applies it and pushes the change to every connected desktop at once; a
  connect gets the full snapshot. No offline edits: a server's projects
  are read-only on a disconnected laptop, so nothing piles up to merge.
  Two writes to one field: arrival order, last wins. Starting a task's
  agent is a compare-and-set on the box ("set its agent PTY only if
  none"), so two laptops opening one stopped task start one agent and the
  other attaches. Two desktops on one agent terminal both see it and both
  type (a shared tmux session); the most recently active one sizes it
  (tmux `window-size latest`). An archive on one closes the task on the
  other with who archived it.
- **Upgrades.** A desktop that needs a primitive the box lacks (`pty_keep`,
  the records store) treats the box as below its floor: a required
  upgrade, restarted once agents settle (compat.rs), whatever the box's
  version string says. No released Termic carries termic-server yet, so
  every box in the wild is a development build.

## Not a goal: a phone without a desktop

Decided 2026-11-22. The phone is a companion to the desktop. Adding a
server, installing termic-server, adding projects and creating tasks stay
desktop actions, so the desktop can own the task engine and the box stays
a thin host. A standalone phone would need one engine shared by desktop
and box (a Rust crate holding what today lives partly in the webview),
which is not worth it for this.

## Later: a phone straight to a server (prepare, do not build)

The phone would connect the way the desktop does, `ssh host termic-server
bridge`, with its own key: no new port on the box. Pairing goes through
the desktop, which already has ssh: the phone makes a key (Keychain), and
the desktop adds its public half to the box's `authorized_keys` with a
forced command, `command="~/.termic/bin/termic-server bridge",
no-port-forwarding,no-pty`, so the key can do nothing but talk to
termic-server. Unpairing deletes that line. A QR printed by the server
was considered and dropped: it needs a network listener and a pairing
store on the box, more to protect for nothing sshd does not already give.

What keeps it possible, all cheap now:

1. ssh + `bridge` stays the only way into a server.
2. The box serves a client with no desktop: daemon-owned PTYs (step 2),
   hooks on the box, the queued-prompt drain.
3. The desktop pushes config instead of the box having its own: its
   agent registry into the `agents.json` the daemon already reads
   (replacing `BUILTIN`), later the task-creation rules. One source of
   truth, carried to the box, so a phone could create a task there.
4. Names, groups and pins are on the box (done, step 5), so a direct
   client sees the desktop's organisation.
5. One stream host (step 6), so the box speaks the phone's protocol with
   the desktop's code.
6. Pairing records leave room for "a phone's key on server X".

## Stages

1. Model + organization: `Project.server`, server projects listed in
   the normal sidebar, order / pins / groups / folders / rename desktop
   side, New task and archive through termic-server, the agent terminal
   through the existing stream. The separate remote sidebar section
   goes away for servers (paired computers keep theirs).
2. `pty_open` family: several PTYs per task, shell tabs, run scripts.
3. `exec` + `TaskHost`: git panel, diff, file tree and editor, setup
   and archive scripts, `.termic.yaml`, clone and add project.
4. Servers per profile: a server belongs to the profile it was added
   in; add a server from the sidebar and from Add project.
5. Phones see server projects for free (they read the desktop's).

## Migration

On first connect after the upgrade, the desktop imports the box's
existing projects and tasks into the profile the server belongs to,
keeping their worktrees, then stops reading the box's own order.
