# Remote control: phones, other computers, servers

**Status: reference.** A phone, another Termic, or this
Termic itself driving agents on another machine, over one protocol: the
stream. Pairing (how two Termics come to trust each other) is
[peers.md](peers.md); what is left and what comes next is
[plans/remote-control.md](plans/remote-control.md) and
[plans/termic-server.md](plans/termic-server.md).

```
 phone app ──┐                                ┌── termic-server (a Linux box)
             ├─ stream ─> Termic desktop ─ stream (ssh stdio) ─┘
 other Termic┘  (WebSocket, sealed)     └─ stream (WebSocket) ─> other Termic
```

- **A phone** pairs by scanning a QR code on the desktop and is a remote
  control of it: tasks, transcript, answers, prompts, the live terminal.
  It runs nothing. The phone app is not part of this repo.
- **A paired computer's tasks** show in this Termic's sidebar under its
  name; a task opens in the main area with its terminal drawn by the local
  xterm.
- **A server** (`ssh user@host`) runs `termic-server`, a small daemon that
  holds agents so they keep working while the laptop sleeps. Its tasks
  show in the sidebar like a paired computer's. Crate:
  [termic-server/](../termic-server/).
- **Agents** reach any of them with `termic --peer <name>` / MCP
  `peer_call`, which now travel over the stream too.

No relay, no accounts: a phone reaches the desktop on the same network or
over the user's own VPN (Tailscale).

## Code

To run it on real machines and check it by hand: [remote-testing.md](remote-testing.md).


| Piece | Where |
|---|---|
| Messages, session crypto, WebSocket and stdio framing, transcript and screen readers | `termic-remote/` (shared by the app and termic-server) |
| The desktop as host: the `/stream` route, sessions, snapshots, terminal, answers | `src-tauri/src/remote_server.rs`, routed in `peers.rs` |
| Phones and the QR pairing, live-connection registry, `--peer` over the stream | `src-tauri/src/peers.rs` |
| The desktop as client: links to paired computers and servers, server setup (probe, trust, install) | `src-tauri/src/remote_client.rs` |
| Desktop UI | `src/components/remote/*`, `src/components/settings/RemoteSection.tsx`, `src/lib/remote.ts` |
| Headless host | `termic-server/` |

## The stream

One long-lived connection, client to host.

- **Transport.** A WebSocket at `ws://<host>:<peer port>/termic-peer/v1/stream`
  (React Native speaks it natively), or length-prefixed frames over the
  stdio of `ssh -T <box> termic-server bridge`.
- **Handshake** (WebSocket only; over ssh the channel is ssh's):

  ```text
  host   -> client  host salt (16 B, clear)
  client -> host    client salt (16 B) || client id (16 B raw), clear
  keys              HKDF-SHA256(ikm = pair key, salt = host salt || client salt,
                                info = "termic-stream-v1|" dir "|" host id "|" client id)
                    dir = c2s / s2c
  frames            ChaCha20-Poly1305, nonce = 4 zero bytes || u64 counter per direction
  client -> host    sealed hello   (opening it is the client's proof)
  host   -> client  sealed welcome (opening it is the host's)
  ```

  Both sides add randomness, so a recorded connection replays nothing;
  one key per direction, so nothing reflects; both ids in the keys; the
  implicit counter makes a dropped, repeated or reordered frame fail the
  next open, which ends the connection. Any failure closes with **4001**
  and no detail.
- **Messages** are JSON tagged by `t` (`termic-remote/src/wire.rs`, whose
  tests pin every shape). Client: `hello`, `call` (any termic-proto
  Request, run through `dispatch_authenticated` like the CLI and MCP),
  `term_open` / `term_input` / `term_close` / `resync`, `term_size` (to
  a host offering `resize` only), `keys`,
  `interrupt`, `transcript`, `ping`. Host: `welcome`, `tasks`, `reply`,
  `term_reset` / `term_data` / `term_resize` / `term_closed`, `ack`,
  `transcript`, `pong`, `error`.
- **Versions.** Additive: unknown types and fields are ignored, the hello
  and welcome carry a version and capabilities (`tasks`, `call`,
  `terminal`, `keys`, `transcript`, and `resize` from a termic-server,
  whose PTYs have no screen of their own so the viewing pane sizes
  them), and fields added after v1 are
  optional. A client uses only what the welcome lists.

Three rules keep it cheap:

- **Only what a client shows streams.** One terminal per connection; task
  state is a snapshot, small. A client that does not ask for `tasks` in
  its hello (a one-off `--peer` call) gets no snapshots and costs the host
  no task list or git diffs.
- **Behind means resync, never replay.** Past 1 MiB of terminal output
  queued for a client, live output for it is dropped and it gets the PTY
  ring again once its queue drains.
- **No cost when nobody is connected.** Snapshots are driven by the
  agent-state cache's own change signal while a client is connected;
  diff stats are refreshed every 60 s and for a task whose state moved.

### What a task row carries

`id, name, project, agent, branch, state, tabs, diff, created,
is_main_checkout`, plus `since_ms` (when the state last changed),
`activity` (while working: the agent's status line) and `question` (while
waiting). The last two come from **reading the agent's screen**: the PTY
ring replayed through a terminal emulator (`vt100`) at the PTY's size
(`termic-remote/src/screen.rs`). A question is a numbered menu counting
from 1 (a permission prompt; or AskUserQuestion, whose options carry a
description line each and may sit on both sides of a rule), or a `❯` list
with a confirm footer; anything else is not one, and clients fall back to
"look at the terminal". Pinned against the shapes Claude, Codex (0.154)
and Antigravity (agy 1.5) draw: their command approvals and folder-trust
prompts. The title is the dialog's question line (not a `Reason: ...?`
field, and a question ending mid-line counts), and an option's trailing
key hint (`(y)`, `(esc)`) is not part of its label. A question on screen
also makes the row
`waiting`, even when the state detector says idle (Claude at its folder
trust prompt). Each option carries the keys
that pick it (arrows from the highlighted option, then Enter).

**Answers are bound to their question.** `keys` may carry the question's
id; the host re-reads the screen and refuses (`ack` "stale") if that
question is no longer there, so an answer never lands on whatever came
next. `interrupt` lets the host pick the key per agent (Esc for claude and
codex, Ctrl-C otherwise). The key never passes through the window's
keyboard, so the host also emits `remote://interrupt` (by PTY) and the tab
ends the turn as it would for a watched Escape
(`src/lib/remoteInterrupt.ts`); without it a hooks agent stopped from a
phone read "working" until its next prompt (docs/agent-hooks.md,
"Interrupts").

**Transcripts** (the phone's chat) come from each agent's own session
log, read by `termic-remote/src/transcript.rs` into the same turns
(prompt, reply, one line per tool call). A server task's log is on the
box, so the desktop reads it there through `exec` (`task_host.rs`, as
`termic result` does): Claude's file, and Codex's rollout found by a
script on the box (`CODEX_ROLLOUT_SH`, the same lookup as below).
Antigravity's chat is a SQLite file, which a box need not be able to
read, so it is fetched whole (`cat` over `exec`) and read on the
desktop; only by the conversation id its hooks reported, since scanning
the box's conversations would mean fetching all of them:

- Claude: its JSONL under `~/.claude/projects/<cwd as a dir name>/`.
- Codex: its rollout under `~/.codex/sessions/YYYY/MM/DD/`. What Codex
  adds to a prompt (`<environment_context>`, the AGENTS.md preamble) is
  dropped; after 0.150 it no longer writes `user_message` events, so the
  response items are read.
- Antigravity: `~/.gemini/antigravity-cli/conversations/<id>.db`, SQLite
  whose steps are protobuf with no published schema (field numbers in
  the reader, read from agy 1.5). Its older `.pb` files are encrypted and
  not read.

The file is the one named by the session id the task's tab recorded
(agent_hooks.rs captures Codex's and agy's); without one, the newest
session started in the task's folder, which a task sharing the project
checkout cannot use, so it gets none. Account-relocated config dirs are
not followed yet: the default home dirs are read.

**The host owns the terminal size.** A client renders at the PTY's
columns and rows and never resizes it; a resize on the desktop arrives as
`term_resize`. The one exception is a host whose PTYs have no screen of
their own (termic-server, which says so with `resize`): there the
viewing pane sizes the PTY with `term_size` (see Servers). xterm's automatic answers to terminal queries are never
forwarded from a viewer (the agent already has a terminal answering).

## Pairing a phone

Settings > Remote control (phones, then other computers) >
**Mobile remote control** > **Connect a phone**, or Connect a phone in the sidebar's
remote add menu (the footer's globe, or REMOTE's + once it has rows), shows a QR code.
The card and the dialog's first step link the app: iPhone through the
public TestFlight link (open to anyone, no invite), Android through
Google Play (`PhoneAppLinks` in `ConnectPhoneDialog.tsx`).

```
termic-remote://pair?v=1&h=<host:port>[,<host:port>...]&id=<desktop id>&m=<name>&k=<256-bit key, base64url>
```

- One key, valid for 5 minutes and for **one** phone: the first that
  connects with it is stored (`peers.json` `phones`, the key in hex, 0600
  like pair keys) and the key is spent. "New code" replaces it; closing
  the dialog withdraws it. The camera is the secure channel, so the phone
  needs no code exchange.
- `h` lists every address a phone might reach: private LAN first, then
  Tailscale (100.64.0.0/10), then others. The phone tries them.
- Opening the dialog turns sharing on (a phone has to reach the listener).
- Every new phone raises a desktop notification ("A phone was paired:
  ... Not you? Unpair it in Settings"): a photographed QR code is the
  threat this makes visible.
- A phone is a remote control of this desktop: Drive, minus the verbs no
  paired machine gets (`quit`, `attach`, project add/remove, the peer
  verbs).
- **Unpairing a phone, unpairing a computer, or turning sharing off cuts
  the live connection at once** (the session's socket is shut down), not
  at its next request.

## Paired computers in the sidebar

While sharing is on, this Termic keeps a link (a stream with `tasks`) to
every paired computer, reconnecting with a 2 to 30 s backoff and pinging
every 20 s (the host drops a client silent for 75 s). Their tasks render
under REMOTE in the sidebar (`RemoteMachines.tsx`), from their own store
slice: a remote update never re-renders a local row, and an unchanged
machine list is never written. A remote task opens over the main area
(`RemoteTaskView.tsx`) as its terminal, focused, under one header that
says where it runs ("On <machine>") and offers Archive. Nothing else on
purpose: the phone's question card, transcript and composer stand in
for a keyboard, and a desktop has one, so here they would only repeat
what the agent's own screen already shows. A Reply-only pair shows no
tasks.

**Filed like the host files them.** A row also carries how the host's
own sidebar files and marks the task: its task group (`group`, named or
after its lead task, with its accent KEY), its project's folder
(`project_group`; folder colours live in the webview's localStorage, so
the desktop pushes them to the host with `remote_set_folder_colors` on
every change), `pinned`, the display order (`project_order`, `order`),
the PR as last read (`pr`: number, state, title, url, provider; no live
checks), each tab's labels (`tabs[].props`, from `termic prop`) and the
host profile its project belongs to (`profile`: slug, name, `#rrggbb`
accent; absent on a host with no profiles). `project_list` names each
project's profile slug the same way. The phone shows one profile at a
time, picked from a row of coloured pills under its top bar. All
optional: termic-server has none and sends none, and an older client
ignores them. Clients lay them out the same way (`layoutRemote` in
src/lib/remote.ts: folders at their first project, a group gathered at
its first member), keep the host's order rather than re-sorting, and map
the accent key to their own palette.

**Every tab, not only the agent.** `tasks[].tabs` lists the task's whole
strip as the host's webview reports it (`cliAgentState.ts`): each tab's
`kind` (`agent`, `shell`, `terminal`, `run`) and whether a PTY is `live`
(both absent from an older host, which sent agent tabs only: read as an
agent, openable). The desktop's remote view shows a tab strip when there
is more than one and opens the picked one with `term_open {task, tab}`;
a tab that is not running cannot be picked. Only agent and run tabs can
be opened from another machine: a plain shell or a custom terminal keeps
no retained output and is not addressable by id (TerminalPane's `role`),
on purpose, so the host marks it `viewable: false` and clients show it
disabled ("Opens only on that computer"). A tab's strip is only known
once that computer's window has loaded the task; before that a row has
no tabs and clients open its default agent.

**Acting on a remote task.** The row's context menu (only on a machine
that is online and lets this one drive) renames it in place, pins or
unpins it, moves it into another group in its project, founds a new
group (the first accent no group in that project uses) or removes it
from its group. Each is the host's own verb over `call`
(`remoteTaskRequest`: `rename`, `pin`, `group --join/--color/--leave`),
so the host applies it exactly as its sidebar would and the next
`tasks` snapshot carries the result. A server's row offers Rename alone:
termic-server has no pins or task groups. `pin` is a CLI verb for this
(`termic pin [TASK] [--off]`, MCP `task_pin`, protocol v26).

**Needs-you alerts.** When a snapshot shows a known task on an online
machine start waiting (with its question as the body, when read) or go
from working to done, the desktop rings as it does for a local tab
(`remoteAlerts`, then `notify`): only with Desktop notifications on,
never for the remote task open in a focused window, once per task per
8 s. The first snapshot, a new task and a reconnect say nothing, so a
machine coming online does not ring for everything already waiting.
The store keeps the last 20 (`useRemote.alerts`).

`--peer` calls use a fresh short stream connection each (as `/call`
used to), with the same grant checks, signature rewriting, reply
contacts and protocol-version refusal. `/call` is gone.

## Servers

Settings > Servers > **Add a server** (also in
the sidebar's remote add menu) is a checklist; nothing
is saved until it passes:

1. **Reach** `ssh -T -o BatchMode=yes -- <dest> ...`: the user's own ssh,
   config and keys; Termic stores no credential and never prompts. Every
   failure is one sentence with its fix (`explain_ssh`). A first-seen host
   key shows its fingerprint (`ssh -G` + `ssh-keyscan` + `ssh-keygen -lf`)
   and **Trust** records it with `StrictHostKeyChecking=accept-new`; a
   CHANGED key is refused with no one-click fix, by design.
2. **System** `uname -sm`.
3. **Installed** `~/.termic/bin/termic-server version`, else **Install on
   server**: the build for that system (a static musl build first) is
   piped through the same ssh into a temp file, run once to verify, then
   renamed into place. No sudo, nothing outside `~/.termic`, no internet on
   the box. Beside it, the same install from the server's own shell:
   `curl -fsSL https://termic.dev/install-server.sh | sh` (the website
   repo's `public/install-server.sh`), which takes the build for `uname
   -sm` from the release (the release workflow attaches the four builds,
   `termic-server-version.txt` and `termic-server-SHA256SUMS`), checks its
   sha256, runs its `version`, and renames it into `~/.termic/bin`.
4. **Connect** and load tasks.

**Versions that work together** (`termic-remote/src/compat.rs`). A
minimum per side, never a 1:1 match: most releases change nothing on the
wire, and an exact match would make every release a breaking one for
every server and paired computer. `REQUIRES_SERVER` is the oldest
termic-server this desktop works with; `REQUIRES_DESKTOP` the oldest
desktop this build works with, both as a paired computer and as the
desktop driving a termic-server built from the same tree. A host's
welcome carries its `needs` (its `REQUIRES_DESKTOP`); the connecting
desktop checks itself against it and the host's version against its own
floor (`remote_client::incompatible`) and, on a mismatch, refuses with
one sentence naming which machine to update. A paired computer's calls
are judged the same way on the host (`peers::peer_compatible`, from the
`app_version` in its hello), falling back to the old equal-CLI-protocol
rule only for a Termic too old to send a version. Versions compare by
`major.minor.patch`; a `+hash` build suffix is ignored, and an
unreadable version counts as older than every floor. The release skill
checks the wire diff each release and proposes a bump; a floor never
exceeds the app's own version (`this_build_works_with_itself`).

**Keeping termic-server current** (`remote_client::auto_upgrade`).
`scripts/build-termic-server.mjs` stamps each build with the app's
version plus a hash of every source file it is built from
(`TERMIC_SERVER_VERSION`, `termic-server util::version`), and writes that
version next to the builds (`termic-server-version.txt`), where the app
reads it: it cannot run a Linux build to ask. Unchanged code hashes the
same, so a release that did not touch the server restarts nothing. On
every connect, a server whose welcome carries an OLDER version than the
carried build (`upgrade_plan`, see "Versions that work together" below)
gets the carried build through the Install upload (renamed over the old file; the
running daemon keeps executing it, agents untouched), once per app run
and version. Then the daemon is restarted onto it with `quit` over the
open connection, no new ssh: `quit` previews the agents a restart would
stop, and commit records the PTYs it ends (`restarted_claims` in
`state.json`), hangs them up without telling the connected desktops
(their PTYs did not exit, the box restarted), answers, and exits; the
link's reconnect runs `bridge`, which starts the new binary. The box
starts no agent itself: the desktop's reattach is answered `restarted`
(below) and it starts each again, resuming its session. Before the
first `tasks` snapshot of a new connection the desktop does not restart
a box at all (`tasks_seen`): an empty list then means no news yet, and
a restart would land mid-turn. Only a REQUIRED update (the server is below
`compat::REQUIRES_SERVER`) restarts by itself; any other waits for
**Restart now** or the box's next restart, and the old build keeps
serving meanwhile. The restart waits until no agent is
mid-turn (no row working or waiting, `restart_when_settled`, checked
after the install and on every change to the server's rows), since an
in-flight turn is what a restart loses; meanwhile the server's row says
the update is installed and offers **Restart now** (`server-update-<id>`).
A box is never downgraded: a desktop on an older Termic connects to the
newer server as it is, unless the server's floor refuses it. There is no
self-update on the box, by
decision: a box chasing the latest release would fight a desktop that is
not on it (docs/plans/termic-server.md). A
server added with its own `command` is left alone. Who else can send a
box `quit`: this desktop's own authenticated CLI (`termic --peer <box>
quit --yes`, the same reach that can already `stop` its agents), never a
paired computer (it may not chain a call on to a third machine,
`peers.rs`).

Servers live in `<global data dir>/servers.json` (machine-wide, like
pairing). A destination starting with `-` or containing whitespace is
refused, and `--` precedes it on every ssh command line.

**A server's projects are ordinary projects.** On connect and on
every change to its task list, `server_projects.rs` mirrors the box's
projects and tasks into the desktop's store, keyed by the box's own ids:
a project gets `server` (the servers.json id) and its `root_path` is the
path on the box. The normal sidebar draws them; names, pins, order and
groups are shared through the box (below, `org`), and the box owns what
exists. A task that left the box is marked archived, never deleted.

**Why it is shaped this way** (decided 2026-11-22, when the box's own
agent engine was removed):

- **The box knows processes, not tasks.** Its surface is `exec`,
  daemon-owned PTYs with a ring, the queued-prompt drain, the hook-OSC
  reader that gives a state with nobody attached, and the folder fence.
  No agent registry, argv, resume, worktree creation or task verbs. What
  both sides compute identically lives in `termic-proto` /
  `termic-remote`, never copied.
- **`TaskHost` is the seam** (`task_host.rs`): every task operation picks
  Local or Server once; a server PTY emits the same `pty://` events, so
  TaskView, TabBar and NewTaskDialog have no remote branch.
- **No invisible local server.** Running termic-server on the Mac would
  mean a daemon (CLAUDE.md), moving sandbox, Docker, secrets and macOS
  permissions into it, and a hop on every terminal byte.
- **A box looks the same to every desktop on it.** It stores plain
  records (projects, tasks, `org`); every write goes to the box, which
  pushes it to every connected desktop. No offline edits: a disconnected
  laptop's server projects are read-only, so nothing piles up to merge.
  What stays per desktop is how it is viewed: collapsed folders, the
  open task, tabs, splits.
- **Not a goal: a phone without a desktop.** Adding a server, projects
  and tasks stay desktop actions, so the desktop owns the task engine.
  A phone straight to a box is an idea:
  [ideas/phone-to-server.md](ideas/phone-to-server.md).
Opening one shows the server's terminal in the main area (one at a time:
a connection carries one terminal); its row's state and fade come from
the server's rows (`data-remote-state`); New task on its project opens
the server's dialog with the project picked; archive goes to the box.
Server projects are not config-synced (another machine has its own
servers). The sidebar has two top-level sections, each a filled header with a
fold: PROJECTS (this computer's) and REMOTE (`RemoteSidebarSection` in
`RemoteMachines.tsx`), the sidebar's half of Settings > Remote control and
Servers. REMOTE
is drawn only once it has a row (a server or a paired computer; phones
have none), since most people never add one and an empty header was
noise. Its + menu, Add a server, Connect a phone, Pair a computer (which
opens Settings > Remote control), is on a globe in the sidebar footer
while the section is hidden (`RemoteFooterButton`). Under it, servers first (one row per
server with its state, its switch and a menu, right-click too, for Add
project, Server settings and Remove, and its projects drawn under it by
the sidebar's own `renderProject`; New task is on each project row, not
on the server, which holds several projects), then paired computers
(other Termic apps, drawn from what they report, Unpair in their menu).
Phones get no rows: they have no tasks to show. Every server and paired
computer row has the same menu (its ⋮ and right-click) with Connect /
Disconnect: a disconnected machine keeps its row, reads "Disconnected",
folds its projects away and runs no link until switched back on,
remembered in `remote-off.json` in the global data dir
(`remote_client::set_connected`, `supervise` skips it). Its icon carries
the connection: green, amber while connecting, faded otherwise. Add a
server is also linked from Add project. Settings' rail lists projects the same way. A server belongs to
the profile whose window added it (`ServerRecord.profile`, a window
label); one added before that field keeps its projects where they are.

**Running things on the box.** termic-server offers two general
primitives, and the desktop sends its existing code through them rather
than growing a verb per feature:

- `exec { cwd, argv, env, stdin, timeout_ms }` -> `{ code, stdout (b64),
  stderr }`: a program under the login shell's PATH, only inside a
  registered project or one of its worktrees (canonicalized, so `..`
  cannot leave), 120 s default timeout, output capped. The desktop host
  answers it with Unsupported.
- `project_add { path, clone }`: with `clone`, git clones the URL into
  `path` first (inside home, not existing yet), then registers it; the
  server dialog's add-project field takes a URL for this, and the CLI
  has `termic project add --clone <url> <path>` (with `--peer`).
- `pty_open { pid, cwd, argv, env, cols, rows, seen? }`, `pty_input`,
  `pty_resize`, `pty_kill`, answered by `pty_data { pid, data, at? }` and
  `pty_exit` (cap `pty`): extra terminals beside the agent's, fenced the
  same way, no argv being the box's login shell, 64 running at once. With
  cap `pty_keep` they belong to the daemon, not the connection: a shell or
  a run script keeps running while the laptop sleeps or the network drops.
  On every new connection the desktop sends `pty_open` again for the PTYs
  it had open there, with `seen` (bytes of output it already has), and the
  box attaches and sends only the rest, its first `pty_data` carrying `at`
  (where that backlog starts). A `seen` beyond everything the PTY wrote
  means the client watched an earlier process under the claim (another
  desktop restarted it), so it gets the whole ring rather than a clamp
  that drops this process's first bytes. Live output is flow-controlled:
  past `BEHIND_BYTES` queued for the client the box stops queueing and
  remembers the offset, then sends the missed stretch from the ring once
  the queue drains (`next_chunk` in session.rs). `seen` also means attach only: a PTY that
  ended meanwhile answers `pty_exit` instead of running its command
  again. One a `quit` ended (a restart onto a new build) answers it with
  the reason `restarted` (`wire::PTY_RESTARTED`, from `restarted_claims`
  in `state.json`), once: the desktop's pane then starts it again, an
  agent resuming its session, instead of showing it exited. Without it
  every upgrade left each server agent on its exited banner. An older box without `pty_keep` hangs them up when
  the connection ends, and the desktop reports that as before. The
  desktop host refuses `pty_open`.
- **The id on the box is a claim.** A server task's tabs are ordinary
  desktop tabs whose PTYs run on the box (TaskView, TabBar and TerminalPane
  draw them; `pty_spawn` routes by cwd to `server_pty_spawn`). A task's
  default agent opens as `<task>:agent` there, any other tab as
  `<task>:<tab>`, so an open of a running one attaches: a restarted desktop
  finds its agent still running, and two desktops share one agent. The
  desktop's own id (`<claim>/<8 hex>`, the `pty://` event name and the
  PtyManager slot key) is a handle, unique per spawn: several handles may
  share a claim for a moment (the webview does not await a kill before a
  respawn, a spawn can be cancelled), live output reaches every handle,
  an attach's backlog only the handle waiting for it, and the box's PTY
  ends with the last handle's kill. A kill reports no exit to its asker.
  Server PTYs get a PtyManager slot whose writer and master forward to the
  box, so the CLI, the phone host and logs reach them as local ones; the
  env is `task_spawn_env`, shared with local spawns. Quitting the desktop
  leaves them running (cleanup only signals local pids).

`server_projects.rs` keeps an index of the folders that live on a server
(project roots and task worktrees), longest first, and the desktop's
funnels consult it:

- `git_bytes` / `git_raw` (lib.rs): the git panel, diff, stage, commit,
  push, the finder's listing.
- `task_dir_list`, `task_file_read`, `task_file_write`: the file tree and
  the editor (a write goes to a temp file and is renamed over). A
  relative path that could climb out of the task is refused before it
  is sent.
- `repo_config::load` / `save`: a server repo's `.termic.yaml`.
- forge.rs `cli_command`: gh, glab and az run on this Mac from home, with
  `GH_REPO` from the box's origin remote; PR status and create name the
  branch (and `-R` for glab), read on the box. Azure passes its scope
  explicitly already. GitHub was checked against a real repo; GitLab and
  Azure for server tasks were not.
- `pty_spawn` / `pty_write` / `pty_resize` / `pty_kill` / `pty_attached`:
  a terminal in a server folder opens there and its output arrives as the
  same `pty://` and `pty-exit://` events (held until the pane attaches,
  as locally), so AuxTerminal has no remote branch. This Mac's bare login
  shell becomes the box's own.

What that gives a server task: the right panel (files, editor, Git
tab; no watcher on the box: the tree rereads when its agent finishes a
turn, and Refresh rereads on demand), shell tabs in its view that
outlive switching tasks, Run and Stop (the run script in a shell tab),
Prompts (through `send`), a Setup tab running the setup script when the
task is made from the dialog, Send to main (the diff applied and
untracked files copied with a tar pipe, both on the box), Open with (VS
Code or Cursor opening the worktree over SSH by its Remote-SSH URL),
custom run commands from Run's menu, and Archive (the archive script
runs in the worktree on the box first). The sandbox controls
are hidden for server tasks: the macOS sandbox does not reach the box.

**Several desktops on one box** see the same projects and tasks (the box's
records) and the same sidebar organisation. A task's name, pin, order and
group go to the box on every write of the task record that changes them
(`save_task` -> `server_projects::push_org_if_changed`, a `task_put` with
`org`), stamped with the write time; the box keeps `org` opaque, puts pin,
order and group in its `tasks` snapshot, and so every connected desktop
resyncs. The mirror takes the box's `org` only when it is newer than what
that desktop last wrote or took (`newer_box_org`): a resync already under
way when you pin something does not unpin it. Folders, colours of the
project and anything else stay per desktop.

`termic-server` itself: [termic-server/README.md](../termic-server/README.md).
It answers the same messages, keeps tasks in `~/.termic-server/state.json`,
listens only on a 0600 unix socket in a 0700 directory, and runs agents
through the user's login shell so their PATH matches an interactive login.
Its PTYs have no screen, so it offers `resize`: an open task's terminal
fills the desktop pane and the PTY follows it (debounced, 4x20 to
300x500), every watcher getting `term_resize`. A newer desktop talking
to an older server sees no `resize` and draws at the server's 120x40.
Its session takes any connected reader and writer
(`session::serve_conn`) and its id is 32 hex, so a phone can later pair
with a server directly (docs/plans/remote-control.md, step 3).

## Push (prepared, not live)

A phone in a pocket has no stream: iOS suspends the app seconds after it
leaves the screen. Push is how "needs you" reaches it. Prepared end to end
except the relay, so nothing is sent yet:

- **The phone** asks for nothing on its own. "Notify me when away" in its
  Settings is the one place that shows the system prompt; once allowed it
  reads the device token (APNs on iOS, FCM on Android, through
  `expo-notifications`, not Expo's push service) and sends
  `push_token { platform, token }` over the sealed stream on every
  connect. An empty token unregisters.
- **The desktop** keeps it on the phone's pairing (`peers.json`, `push`),
  and every OS notification it shows (`notify` in src/lib/ipc.ts) is
  offered to `phones_push` (src-tauri/src/push.rs), which targets paired
  phones that are not connected right now.
- **The relay** is missing: `PUSH_RELAY` is `None`, so `phones_push` logs
  and returns. Apple's push key (`.p8`) and an FCM service account cannot
  ship inside the app, so a small sender on termic.dev (a Worker) will hold
  them and forward `{ platform, token, title, body }`. termic.dev is
  already the one host the app talks to.

Left, in order: the Apple push key and the iOS `aps-environment`
entitlement (the `expo-notifications` config plugin, plus the App ID's
Push capability), a Firebase project and `google-services.json` for
Android, the Worker, then `PUSH_RELAY`. What a push says is the desktop
notification's own line ("project · task", "needs you"): Apple or
Google, and the relay, see that much. Encrypting it to the phone's pair
key (a Notification Service Extension decrypts it) would hide even that.

## Not done / known limits

- termic-server builds: `scripts/build-termic-server.mjs` builds static
  musl binaries for Linux x86_64 and aarch64 (cargo-zigbuild) and, on a
  Mac, macOS aarch64 and x86_64, into `src-tauri/resources/termic-server/`,
  which `tauri.conf.json` bundles. The release workflow's `server-bins`
  and `server-bins-mac` jobs build them, every build job bundles all four,
  and `build-mac` signs the macOS ones with the Developer ID first
  (notarization refuses an unsigned Mach-O in the bundle); one installed
  over ssh keeps the linker's ad hoc signature, which is enough (no
  quarantine on a file copied by ssh). Install looks in the bundle (in
  debug builds, only in `TERMIC_SERVER_BIN_DIR` when set). A box the
  desktop does not reach stays on its build until it does.
- Windows: a Windows desktop is a host and a client like any other, using
  Windows' built-in OpenSSH for servers; servers themselves run Linux or
  macOS (`termic-server` is unix only). Details in
  [windows.md](windows.md); compiled for Windows, not yet driven on one.
- A phone reaches the desktop only. The desktop relays a server
  project's task to it (state, transcript, terminal, keys; the server's
  connection carries one terminal at a time, so the phone and the desktop
  opening different server tasks take turns), not a paired computer's.
- No push notifications (no server to hold the keys); the phone notices
  changes while open.
- A paired computer's tasks have no file tree, editor or diff in the
  desktop view (a server's do: see "Servers").
- On the phone, the screen reader understands Claude's, Codex's and
  Antigravity's prompts; other agents' fall back to Approve (Enter) /
  Deny (Esc) with the terminal in view.
- Test seams (debug builds only): `TERMIC_DEBUG_PHONE_PAIRING=<file>`
  keeps a phone pairing on offer and writes its link there;
  `TERMIC_SERVER_BIN_DIR` as above; `TERMIC_SSH_BIN`, the e2e suite's
  stand-in for ssh (`e2e/fixtures/fake-ssh.sh`, a real termic-server on the
  runner for the host `termic-e2e-local`).
