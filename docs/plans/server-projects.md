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

1. **Share the copies**: `last_assistant_text`, `interrupt_key`, the slug
   move into `termic-remote` / `termic-proto`.
2. **Daemon-owned PTYs**: move the PTY map from `Session` to `Daemon`,
   add `pty_attach` by id (`pty.rs` already keeps a ring and
   subscribers). Raise `compat::REQUIRES_SERVER`.
3. **The agent as an ordinary tab**: spawn it with the desktop's argv,
   session id and env through `pty_spawn`; draw server tasks with
   TaskView and TabBar. Delete RemoteTaskView's server half,
   `useServerShells`, `useBoxAgents` and the `project.server` branches it
   leaves behind (paired computers keep their small overlay).
4. **Task creation over `exec`**, through a `TaskHost` seam that replaces
   the scattered `server_for_path` checks. New task is the one
   NewTaskDialog, agents the box lacks disabled. Delete
   `NewRemoteTaskDialog.tsx`, `verbs.rs new_task` and its CLI forward.
5. **Shrink the box**: delete the agent table and resume, the task list
   in `state.rs`, the task half of `mirror()`, and the `new`, `rename`,
   `list` verbs. It keeps `exec`, the PTY family, a queued-prompt drain
   and `detect.rs` as the state floor for when no desktop is attached
   (a desktop's own reading wins when one is).
6. **One stream host**: the shared session loop of `session.rs` and
   `remote_server.rs` in `termic-remote` behind a host trait.

Accepted trade-off: with the laptop asleep, a server task's state is the
cruder floor, and a phone cannot create a task straight on a box. If
phone-to-box without a desktop becomes a goal, the box gets the agent
table pushed to it then. Open risk in step 3: agent hooks on the box
have no transport back to the desktop yet, so server agents read state
from titles (and the floor) until one exists.

### Agent hooks on the box

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
4. Names, groups and pins are pushed to the box (rename already is), so a
   direct client sees the desktop's organisation.
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
