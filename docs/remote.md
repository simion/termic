# Servers: agents on a box you reach over SSH

**Status: reference, experimental.** This Termic driving agents on
another machine, a Linux box, a cloud VM or a headless Mac, that keeps
them running while the laptop sleeps or the network drops. The box runs
`termic-server`, a small daemon ([termic-server/](../termic-server/)); the
desktop reaches it with the user's own ssh. What is left before release,
and what comes after (phones, Termic computers driving each other):
`docs/plans/termic-server.md` and `docs/plans/remote-control.md`.

```
 Termic desktop ── ssh -T <box> termic-server bridge ──> termic-server (daemon on the box)
                   (frames over the ssh session's stdio)     holds the agents' PTYs
```

- **Settings > Servers > Add a server**: a checklist that saves nothing
  until it passes, and installs termic-server if it is missing.
- **The server's tasks in the sidebar**, under its name; a task opens as
  its terminal; **New task on <server>** starts one there.
- **Agents** reach it with `termic --peer <server>` / MCP `peer_call`.

No network port on the box, no accounts, no relay: ssh is the only way in.

## Code

To run it on a real box and check it by hand: [remote-testing.md](remote-testing.md).

| Piece | Where |
|---|---|
| Messages, framing, the screen and transcript readers | `termic-remote/` (shared by the app and termic-server) |
| The desktop as client: one link per server, calls, the terminal, server setup (probe, trust, install) | `src-tauri/src/remote_client.rs` |
| `--peer <server>` | `src-tauri/src/peers.rs` `forward_to_server` (after no paired computer matched the name) |
| Desktop UI | `src/components/remote/*`, `src/components/settings/RemoteSection.tsx`, `src/lib/remote.ts` |
| The daemon | `termic-server/` |

## The wire

One long-lived connection per server: `ssh -T <box> termic-server bridge`,
u32 big-endian length-prefixed frames of JSON over the ssh session's
stdio, not sealed again (ssh is the secure channel). The bridge copies
bytes to the daemon's unix socket and parses nothing.

- **Messages** are JSON tagged by `t` (`termic-remote/src/wire.rs`, whose
  tests pin every shape). Client: `hello`, `call` (any termic-proto
  Request), `term_open` / `term_input` / `term_close` / `resync`,
  `term_size`, `keys`, `interrupt`, `transcript`, `ping`. Server:
  `welcome`, `tasks`, `reply`, `term_reset` / `term_data` / `term_resize` /
  `term_closed`, `ack`, `transcript`, `pong`, `error`.
- **Versions.** Additive: unknown types and fields are ignored, and the
  hello and welcome carry a version and capabilities (`tasks`, `call`,
  `terminal`, `keys`, `transcript`, `resize`). A client uses only what the
  welcome lists, so an older and a newer side work together.
- **Only what a client shows streams.** One terminal per connection; task
  state is a snapshot, small. Past 1 MiB of terminal output queued for a
  client, live output for it is dropped and it gets the PTY ring again
  once its queue drains (behind means resync, never replay).

### What a task row carries

`id, name, project, agent, branch, state, tabs, diff, created,
is_main_checkout`, plus `since_ms` (when the state last changed),
`activity` (while working: the agent's status line) and `question` (while
waiting). The last two come from **reading the agent's screen**: the PTY
ring replayed through a terminal emulator (`vt100`) at the PTY's size
(`termic-remote/src/screen.rs`). A question is a numbered menu counting
from 1, or a `❯` list with a confirm footer; anything else is not one.
Pinned against the shapes Claude, Codex (0.154) and Antigravity (agy 1.5)
draw: their command approvals and folder-trust prompts. A question on
screen also makes the row `waiting`.

A row may also carry how a host's sidebar files the task (`group`,
`project_group`, `pinned`, `project_order`, `order`, `pr`, tab `props`).
All optional, and termic-server sends none: a server has no task groups
or pins. The desktop lays rows out with `layoutRemote` (src/lib/remote.ts),
which on a server's flat rows is the project list in its order.

**Transcripts** come from each agent's own session log
(`termic-remote/src/transcript.rs`): Claude's JSONL, Codex's rollout,
Antigravity's SQLite. termic-server offers them (`transcript`); the
desktop view does not show them (it shows the terminal).

## A server's tasks in the sidebar

This Termic keeps a link to every server, reconnecting with a 2 to 30 s
backoff and pinging every 20 s (the server drops a client silent for
75 s). Their tasks render below the local projects (`RemoteMachines.tsx`),
from their own store slice: a remote update never re-renders a local row,
and an unchanged machine list is never written.

- **A task opens as its terminal** over the main area
  (`RemoteTaskView.tsx`), focused, under one header that says where it
  runs ("On <server>") and offers Archive. A server's PTYs have no screen,
  so the server offers `resize`: the open terminal fills the pane and the
  PTY follows it (debounced, 4x20 to 300x500), every watcher getting
  `term_resize`. A server task has one tab, so there is no tab strip.
- **The row menu is Rename** (inline, Enter saves, Esc cancels), the
  server's own `rename` verb over `call`. Nothing else: termic-server has
  no pins or task groups.
- **Needs-you alerts.** When a snapshot shows a known task start waiting
  (with its question as the body, when read) or go from working to done,
  the desktop rings as for a local tab (`remoteAlerts`, then `notify`):
  only with Desktop notifications on, never for the remote task open in a
  focused window, once per task per 8 s. The first snapshot, a new task
  and a reconnect say nothing. The store keeps the last 20
  (`useRemote.alerts`).
- **New task on <server>** (`NewRemoteTaskDialog.tsx`): pick one of the
  server's projects, or add one by its path on the box; an agent the
  server knows; a prompt.

`termic pin` (CLI protocol 26, MCP `task_pin`) is new with this work, for
pinning a task by name from an agent or the CLI.

## Servers

Settings > Servers > **Add a server** is a checklist; nothing is saved
until it passes:

1. **Reach** `ssh -T -o BatchMode=yes -- <dest> ...`: the user's own ssh,
   config and keys; Termic stores no credential and never prompts. Every
   failure is one sentence with its fix (`explain_ssh`). A first-seen host
   key shows its fingerprint (`ssh -G` + `ssh-keyscan` + `ssh-keygen -lf`)
   and **Trust** records it with `StrictHostKeyChecking=accept-new`; a
   CHANGED key is refused with no one-click fix, by design.
2. **System** `uname -sm`.
3. **Installed** `~/.termic/bin/termic-server version`, else **Install on
   server**: the build for that system is piped through the same ssh into
   a temp file, run once to verify, then renamed into place. No sudo,
   nothing outside `~/.termic`, no internet on the box.
4. **Connect** and load tasks.

Servers live in `<global data dir>/servers.json` (machine-wide). A
destination starting with `-` or containing whitespace is refused, and
`--` precedes it on every ssh command line.

`termic-server` itself: [termic-server/README.md](../termic-server/README.md).
It keeps tasks in `~/.termic-server/state.json`, listens only on a 0600
unix socket in a 0700 directory, and starts agents through the user's
login shell so their PATH matches an interactive login. Its session code
takes any connected reader and writer (`session::serve_conn`), and its
server id is 32 hex: both on purpose, so a phone can later pair with a
server directly (docs/plans/remote-control.md).

## Builds

`scripts/build-termic-server.mjs` builds into
`src-tauri/resources/termic-server/`, which `tauri.conf.json` bundles:
static musl builds for Linux x86_64 and aarch64 (cargo-zigbuild), and
macOS aarch64 and x86_64 (plain cargo, on a Mac). The release workflow's
`server-bins` (Linux) and `server-bins-mac` jobs build them, every build
job bundles all four, and `build-mac` signs the macOS ones with the
Developer ID before bundling (notarization refuses an unsigned Mach-O in
the bundle). A build installed over ssh keeps the linker's ad hoc
signature, which is enough: a file copied over ssh carries no quarantine.
Install looks in the bundle (and, in debug builds, in
`TERMIC_SERVER_BIN_DIR`); a local build without builds still bundles the
folder's README, and Install then says there is no build for that system.

## Not done / known limits

- Updating termic-server on a box, installing it from the box's own
  shell, and uninstalling it: docs/plans/termic-server.md.
- Windows: a Windows desktop adds servers with Windows' built-in OpenSSH;
  servers themselves run Linux or macOS (`termic-server` is unix only).
  Details in [windows.md](windows.md).
- Remote tasks have no file tree, editor or diff in the desktop view.
- A server's agents have no `termic` CLI or MCP of their own, so they
  cannot message the task that started them; an agent driving a server
  waits (`task_wait`) and reads (`task_result`).
- Test seams (debug builds only): `TERMIC_SERVER_BIN_DIR` (where Install
  looks for builds) and `TERMIC_SSH_BIN` (the e2e suite's stand-in for
  ssh, `e2e/fixtures/fake-ssh.sh`).
