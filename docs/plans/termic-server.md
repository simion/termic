# termic-server: agents on a box you reach over SSH

**Status: approved 2026-11-19, the first remote-control release.** Ships
before the phone app and the desktop-as-host work
([remote-control.md](remote-control.md)). The code is on the
`termic-server` branch (PR for #82); this plan is what is left before it
can release.

## What the user gets

Run agents on another machine (a Linux box at home, a cloud VM, a headless
Mac mini) that keeps working while the laptop sleeps or the network drops,
and drive them from the desktop as if they were local:

- **Settings > Servers > Add a server**: type what you would after `ssh`.
  A checklist (reach, host key, system, installed, connect) saves nothing
  until it passes, and installs termic-server for you if it is missing.
- The server's tasks in the **sidebar**, under the server; **New task on
  <server>** starts one there (adding a project by its path on the box).
- A remote task opens as **its terminal**, focused, sized to the pane (the
  server's PTY follows it), with **Rename** from the row menu and a desktop
  **notification** when its agent asks something or finishes.
- `termic --peer <server> ...` and MCP `peer_call` reach it too; `termic
  pin` is new (CLI protocol 26) for the sidebar's pin action.

How it works: `termic-server` is a small daemon on the box that holds the
agent PTYs. The desktop reaches it as `ssh -T <host> termic-server bridge`,
the user's own ssh, config and keys (Termic stores no credential). The
daemon listens only on a 0600 unix socket in a 0700 directory: **no
network port**. Design and wire: `docs/remote.md` on the branch.

## Built

- `termic-remote` crate: the wire messages, the screen question reader
  (Claude, Codex, Antigravity), the transcript readers, the framing.
- `termic-server`: daemon, bridge, projects and worktrees, agents through
  the login shell, `status` / `stop` / `version`. Unix only (Linux, macOS).
- Desktop: `remote_client.rs` (one supervised link per server, reconnect,
  ping, calls, terminal), Settings > Servers with the Add a server
  checklist and Install, the sidebar section, the remote task view, Rename
  in the row menu (a server has no pins or task groups, so nothing else),
  needs-you alerts (the Desktop notifications setting, never for the open
  task, debounced), `--peer <server>`.
- Release: static musl builds for Linux x86_64 and aarch64, and macOS
  aarch64 and x86_64 builds (Developer ID signed inside the app bundle for
  notarization), bundled into every platform's app. **The macOS part is
  written but has not run in CI yet.** A real install onto a Mac over ssh
  was tested by hand (probe, install, connect, a verb).
- Tests: termic-server unit and end-to-end; `remote_client` unit tests
  (ssh failure sentences, option smuggling refused); desktop e2e against a
  real termic-server on the runner itself (a stand-in for ssh,
  `e2e/fixtures/fake-ssh.sh`, so CI covers servers with no box), plus
  real-box cases behind `TERMIC_E2E_TEST_BOX`.

## Left before release

### 1. Finish the split

The branch is being cut out of the full remote-control work: no LAN
listener, no phone pairing, no paired computers' tasks, `peers.rs` as on
main plus the `--peer <server>` forward. Every suite green on it (vitest,
cargo across the crates, the e2e suite on macOS and Linux, the real box).

### 2. Install from the server's own shell

Today termic-server is installed only from the desktop (the bundled build,
piped over ssh: no internet needed on the box). Add the usual way too:

```sh
curl -fsSL https://termic.dev/install-server.sh | sh
```

- The script: `uname -sm` to a target triple, download
  `termic-server-<triple>` from the latest GitHub release, verify it (see
  signing below), install into `~/.termic/bin`, no sudo, print what to do
  next ("add this machine in Termic: Settings > Servers").
- Hosted on termic.dev (the website repo); the release publishes the
  binaries it fetches.
- Release assets: every `termic-server-<triple>`, its signature, and one
  manifest, `termic-server.json` (version, and per triple: url, sha256,
  signature), at a stable URL (`releases/latest/download/`).

### 3. Self-update

A server must not stay on the version it was installed with.

- `termic-server update [--check]`: read the manifest, and if newer,
  download to a temp file, verify the signature and the sha256, run its
  `version`, rename it into place (never a half-written binary).
- **Automatic** by default: the daemon checks at start and once a day,
  and installs a newer verified build in the background. Off with
  `"auto_update": false` in `~/.termic-server/config.json`.
- **Installed now, active on the next restart. Nothing restarts by
  itself.** The new file is renamed over `~/.termic/bin/termic-server`;
  the running daemon keeps executing the old one (a rename never touches
  a running binary's file) with every agent untouched, and the next start
  of the daemon (a reboot, `termic-server stop`, a crash) runs the new
  one. Settings' server row shows "update installed, applies on restart"
  and **Restart now** (it warns that running agents stop: restarting ends
  their PTYs; handing live PTYs to the new process is out of scope).
- **Rename, never write in place.** On macOS, rewriting a running signed
  binary invalidates its signature and the system can kill the process;
  a rename gives the new file its own inode. The same on Linux.
- **Old daemon, new bridge**: every ssh connection runs the NEW file's
  `bridge` against the still-running OLD daemon. The bridge only copies
  bytes, so this works; keep it that way (no protocol in the bridge).
- **Forward only, with a way back**: a lower version is refused even when
  signed; the previous binary is kept as `termic-server.prev`, and a new
  one that fails its `version` check is never installed.
- **Boxes without internet**: the desktop pushes its bundled build when it
  is newer than the server's (the Install path), with the same rule: it
  applies on the daemon's next restart. So a user who updates Termic
  updates their servers on the next connect, internet on the box or not.
- **Versioning**: termic-server's version is stamped with the app's at
  release, so "latest" is one number for both; compatibility between an
  older and a newer side stays the wire's job (each side announces caps
  and adapts, as `resize` does today).
- **Signing**: an ed25519 (minisign) key the release signs with, its
  public key compiled into termic-server and the install script. Whether
  this is the Tauri updater's key or a separate one is open (below).
- HTTP: shell out to `curl` (present on macOS and nearly every Linux) and
  verify in Rust, so termic-server takes on no TLS stack.

### 4. macOS as a server

- Verify the CI half: `server-bins-mac`, the signing step, a notarized
  app containing the four builds.
- A headless Mac goes to sleep: hold a `caffeinate -i` assertion while any
  agent runs (proposal), and say in the docs to turn automatic sleep off.
- Agent logins that live in the macOS Keychain (Claude Code's) may not be
  readable from a process started over ssh. Test on a Mac reached only
  over ssh before promising it; document the fix (unlocking the login
  keychain, or logging the agent in over ssh once).

### 5. Uninstall

`termic-server uninstall`: stop the daemon and its agents, remove the
binary; `--purge` also removes `~/.termic-server` (tasks, worktrees). The
docs and the "Remove server" confirmation point at it.

### 6. Projects on a server

Projects belong to a machine. A server project is a checkout ON THE BOX,
added by its path there, listed under that server in the sidebar; the
same repository can be a local project and a server project at once, two
independent checkouts with their own branches, worktrees and agents.
Nothing syncs them; a server task changes only the box's copy.

- **Clone from a URL** (this release). Today `project_add` on a server
  takes only a folder that already exists there, so the user has to ssh
  in and clone first. Accept a git URL too and clone it on the box (into
  `~/.termic-server/repos/<name>`, or a path the user picks), in the New
  task dialog's "Add a project" and in `project_add`. It uses the box's
  own git credentials (a deploy key, `gh auth` on the box): the user's
  ssh agent is not forwarded, since the daemon outlives the ssh session.
  Say so when a clone fails for want of them.
- **Bring the work home** (after this release). A server task's work is
  a branch in a worktree on the box; today it reaches the laptop only by
  pushing it somewhere. "Open locally" on a server task: find the local
  project with the same remote, `git fetch <ssh dest>:<worktree> <branch>`
  over the same ssh, and open it as a local worktree task. No push needed.

### 7. Agents spinning off work on a server

An agent already starts work on a paired computer with MCP `task_new`
and `peer: "<computer>"`. The same call reaches a server: `--peer` and
`peer` fall through to a server of that name when no paired computer has
it, and `task_send`, `task_wait`, `task_result`, `task_log`, `task_diff`,
`task_list`, `task_rename`, `task_archive`, `project_add` work there.
Left for this release:

- **Discovery.** `peer_list` (and MCP `peer_list`) lists only paired
  computers, so an agent cannot find a server unless told its name. List
  servers too, marked as servers.
- **Say what a server answers.** `task_tab`, `task_group`, `task_prop`,
  `task_review`, `pin` and scratchpads do not exist on a server. The MCP
  instructions name the tools that work against one, so an agent does not
  try the others.

After this release, **report back from a server's agent.** termic-server
gives its agents no `termic` CLI or MCP today (no `TERMIC_TASK_ID`), so a
server agent cannot message the task that started it, and orchestration
is pull-only (`task_wait`, then `task_result`). The fix: a `termic` on the
box that talks to the daemon, and the daemon passing a reply down the
link the desktop already holds to the originating task (the box never
has to reach the laptop).

### 8. Docs, tests, review

- `docs/remote.md` (the server half), `termic-server/README.md` (install,
  update, uninstall, what runs where), `docs/remote-testing.md` (the
  by-hand runbook), the e2e coverage map.
- Updater tests: manifest parsing, a bad signature or sha refused, a
  lower version refused, the atomic replace while the old daemon keeps
  running, the new build active after a restart, auto-update off.
- Manual test by the maintainer and screenshots before the PR
  (CLAUDE.md).

## Keep the door open for phones

A phone should later be able to pair straight with a server, no desktop
in between ([remote-control.md](remote-control.md), step 3). Nothing in
this release may make that hard:

- The session takes any connected reader and writer
  (`session::serve_conn`), so a sealed stream plugs in unchanged.
- The server id stays 32 hex: it is the `id` a phone pairing link carries.
- The `termic-remote` crate ships whole (seal, WebSocket, handshake).
- No TCP listener in this release: that comes with the phone, opt-in.

## Security

- No network port. ssh is the only way in, with the user's own keys;
  host keys are shown before trust and a changed one is refused.
- Nothing outside `~/.termic` and `~/.termic-server`, no sudo.
- Updates are signature-checked against a key compiled into the binary,
  over https, and never replace a working binary with an unverified one.

## Open decisions

1. The update signing key: reuse the Tauri updater key, or a separate key
   for termic-server.
2. Auto-update on by default (proposed) or opt-in.
3. Where the install script lives (termic.dev path) and its name.
