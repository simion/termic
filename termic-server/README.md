# termic-server

The headless half of Termic's remote control. A small daemon on a box you
reach over SSH (a mini PC, a VM, a cloud instance) that holds your agents'
terminals, so agents keep running while your laptop sleeps or the network
drops. The Termic desktop (and `termic --peer <server> ...`) drive it with
the remote-control messages (`termic-remote`): its tasks show in the
sidebar, open as their terminal, and answer the CLI's verbs. Linux and
macOS (a headless Mac mini works too).

It opens no network port. The only way in is SSH: the desktop runs
`ssh <box> termic-server bridge`, and the bridge copies that session's
bytes to the daemon's unix socket.

## Install

The desktop's Settings > Remote > Add a server installs it for you (the
build for the box's system, bundled in the app, piped over the same ssh).
By hand, copy the build to the box and make it executable. No root,
nothing outside your home directory:

```sh
scp termic-server-x86_64-unknown-linux-gnu box:/tmp/termic-server
ssh box 'mkdir -p ~/.termic/bin && install -m 755 /tmp/termic-server ~/.termic/bin/termic-server'
ssh box '~/.termic/bin/termic-server version'
```

A static build (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`)
runs on any Linux whatever its libc; a Mac takes `aarch64-apple-darwin` or
`x86_64-apple-darwin`. `node scripts/build-termic-server.mjs` builds every
target this machine can (all four on a Mac).

Building it yourself, from a checkout:

```sh
cargo build --release -p termic-server            # glibc
CC_x86_64_unknown_linux_musl=gcc \
  cargo build --release -p termic-server --target x86_64-unknown-linux-musl
```

(`ring`, used by termic-remote's sealed sessions, needs a C compiler for
the musl target; the system gcc works.)

After upgrading the binary, run `termic-server stop` so the next
connection starts the new daemon. Stopping hangs up every running agent.

## How ssh runs it

The desktop runs, with your own `~/.ssh/config`, keys and agent (Termic
stores no credentials):

```sh
ssh -T -o BatchMode=yes <box> 'if [ -x ~/.termic/bin/termic-server ]; then exec ~/.termic/bin/termic-server bridge; elif command -v termic-server >/dev/null 2>&1; then exec termic-server bridge; else echo "termic-server is not installed" >&2; exit 127; fi'
```

`bridge` connects stdin and stdout to `~/.termic-server/sock`. If no daemon
is running it starts one in a new session (so it outlives the SSH session
that started it), waits up to 5 seconds for its socket, then copies bytes
both ways until either side closes. It does not parse anything.

On the wire: u32 big-endian length-prefixed frames, each a JSON message
(`termic-remote/src/wire.rs`), not sealed again because SSH already is the
secure channel. The client sends `hello`; the server answers `welcome` with
`kind: "server"`, its stable id and hostname, and the caps `call`, `tasks`,
`terminal`, `keys`, `transcript`.

## Commands

| Command | What it does |
|---|---|
| `termic-server bridge` | What ssh runs (above). |
| `termic-server daemon` | The long-running process. Normally started by `bridge`. |
| `termic-server status` | Whether a daemon is running, and its pid. Exit 0 running, 3 not. |
| `termic-server stop` | Stop the daemon (SIGTERM), hanging up every agent. |
| `termic-server version` | The binary's version. |

## Files

Everything lives in `~/.termic-server` (or `$TERMIC_SERVER_HOME`), a
directory created `0700`. The daemon refuses to start if it is owned by
another user.

| File | What |
|---|---|
| `sock` | The unix socket, `0600`. Connections from another uid are refused too. |
| `daemon.pid` | The daemon's pid, and its lock (held with `flock` for the daemon's life, so a stale pid is never trusted). |
| `state.json` | Projects and tasks and the server's id, `0600`, written atomically. A file that does not parse is moved aside, never overwritten. |
| `daemon.log` | The log, rotated to `daemon.log.1` past 2 MiB. |
| `worktrees/<project>/<task>/` | Task worktrees. Both parts are slugs (`a-z0-9-`), so a name can never climb out. |

Agent transcripts are read from where the agents write them
(`~/.claude/projects/...`), not copied.

## Agents

The box has no agent list of its own. The Termic desktop starts every
agent, from its own registry (argv, session id, env), in a PTY it opens
here with `pty_open`; a task's agent is the PTY named `<task>:agent`.
The PTY runs in the task's directory through your login shell, so PATH
matches an interactive login on the box (ssh's non-interactive PATH
misses npm, nvm, bun and `~/.local/bin` installs):

```text
/bin/sh -lc 'exec "$0" "$@"' <argv...>
```

The argv is passed as positional parameters, never pasted into shell
code. Its environment is the desktop's (`TERMIC_TASK_ID`, `TERMIC_TASK`,
`TERMIC_TAB_ID`, ...) plus `TERM=xterm-256color`, `COLORTERM=truecolor`
and `TERMIC_PTY` (its slave path, where the agent's hooks report).

PTYs belong to the daemon and outlive a connection: a desktop that comes
back attaches again with `seen`. A `quit` (a restart onto a new build)
notes the ones it ends, and the desktop's reattach is answered
`restarted`, so it starts them again.

## Work state

The desktop's vocabulary, from PTY activity and the screen:

- **working**: output (or a prompt typed in, or the spawn itself) within
  the last 2 seconds.
- **waiting**: quiet, and the screen shows a question: a menu
  `termic_remote::screen::question` can read (sent to clients as
  `question`, with its options as keys), or one of a small table of prompt
  texts in the last 4 KB of output (`Do you want`, `(y/n)`, `[Y/n]`,
  `Esc to cancel`, ...; see `src/detect.rs`).
- **done**: quiet after answering input.
- **idle**: quiet, never given anything.
- **inactive**: no agent process (it exited, or the daemon restarted).

This is the floor for when no desktop is attached; a desktop reads the
agent's hooks and title itself.

The daemon re-evaluates on PTY output after a quiet spell and at the next
quiet deadline (a condvar wait), never on a timer while everything is
settled, and pushes a full `tasks` snapshot to clients only when something
in it changed. While working, the snapshot carries the agent's own status
line as `activity`.

## Verbs (`call`)

termic-proto requests and replies, the same shapes the desktop answers:

| Verb | Notes |
|---|---|
| `list`, `status` | Work state, diff stat against the base branch, one `agent` tab. |
| `task_put` | Records a task the desktop made (its worktree created over `exec`); starts nothing. The path must be inside a project or `worktrees/`. `org` (the desktops' name, pin, order and group for it) is kept opaque and handed back in `list`; pin, order and group are in the `tasks` snapshot. |
| `send` | Into the task's running agent at once: bracketed paste (when the agent turned it on), then Enter. An agent that is not running is refused: the desktop starts it when the task is opened. |
| `wait` | Until done (exit 0), waiting (needs input) or the timeout, capped at 5 minutes. |
| `archive` | SIGKILLs the task's PTYs' process groups, `git worktree remove --force`, marks the task archived. The branch is kept. |
| `rename` | The label only; branch and directory keep their names. |
| `logs` | The PTY ring's tail (256 KiB retained). |
| `result` | Claude's last message, from its transcript. |
| `diff` | Counts, commits since the base, the patch with `full`. |
| `project_add`, `project_list`, `project_remove` | A path on the box; `~/` is expanded. `non_git` adds a plain folder (main-checkout tasks only). Removing a project archives its tasks. |

`new` and `agents` answer `unsupported`: the desktop creates tasks and
chooses agents. Anything else answers `unsupported`, "termic-server does
not support <verb> yet". Prompt-library references, `--from`, `--resume <id>` and
`--pr` are refused the same way.

Stream messages: `term_open` (backlog, then live output; a client more
than 1 MiB behind gets the ring again rather than a replay), `term_input`,
`term_close`, `resync`, `keys` (with an optional `question` id: keys for a
question no longer on screen are refused with `ack` "stale"), `interrupt`
(Esc for claude, codex and opencode, Ctrl-C otherwise), `transcript`
(claude tasks), `ping`.

## Limits

- One tab per task (the agent). No aux terminal, no extra tabs.
- The PTY size is fixed at 120x40; clients do not resize it.
- No sandbox, no setup or archive scripts, no schedules, no scratchpads.
- Work state is read from output and the screen only (no agent hooks), so
  an agent that prints nothing while it thinks reads as done.
- Upgrading the binary needs `termic-server stop`, which ends the agents.
- systemd-logind with `KillUserProcesses=yes` kills everything a user
  started when their last session ends, the daemon included. Ubuntu's
  default is `no`; if yours is not, `loginctl enable-linger $USER`.

## Tests

```sh
cargo test -p termic-server
```

Unit tests cover the state patterns, slugs, state persistence and argv
quoting; `tests/e2e.rs` runs the real binary on a temp home with a real git
repo and a fake agent in a real PTY, through `bridge`. To drive a real box
over real ssh: `cargo run -p termic-server --example remote -- run|check|cleanup user@box`.
