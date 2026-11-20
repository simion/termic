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
  `pty_spawn` in a server folder opens there, so a server task's view has
  shell tabs on the box that live on while you switch tasks; Run opens
  the run script (Settings or the box's `.termic.yaml`, read there) in
  one. Prompts go to the box's agent through termic-server `send`. Left:
  setup scripts on the box, custom run commands, Stop, and the top bar's
  Send to main and Open with (hidden for server tasks until then).
- Stage 3, partly: termic-server `exec` (fenced to project roots and
  worktrees). `git_bytes` and `git_raw` (lib.rs) send a server folder's git
  there through an index of server paths in `server_projects.rs`, so the
  git panel, diff, stage, commit and push work. The file tree listing,
  editor read and save go to the box too. Left: setup and archive
  scripts, `.termic.yaml`, clone and add project, a file watcher (today
  Refresh rereads), and the full task menu for server tasks.
- Stage 4 in full: a server records the window it was added in and its
  projects mirror into that profile; the sidebar's projects header has an
  Add a server button, and the Add project dialog links to it.

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
