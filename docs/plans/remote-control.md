# Remote control: phones, and Termic computers driving each other

**Status: approved 2026-11-19, the second remote-control release**, after
[termic-server.md](termic-server.md). Supersedes
`docs/ideas/remote-control.md` (delete it when this plan lands on main).
The code is on the `remote-control` branch, stacked on
`termic-server`. The phone app itself lives in a separate,
private repository and is never part of this one.

## What the user gets

1. **A phone that controls this computer's agents.** Settings > Remote control >
   Connect a phone shows a QR code; the phone app scans it. The phone sees
   the tasks (filed as the sidebar files them), answers an agent's
   question as a card with the agent's own options (Claude, Codex,
   Antigravity), reads the conversation, watches and types into the
   terminal, switches between a task's agent and run tabs, renames, pins
   and groups tasks, starts and archives them. The phone runs nothing.
2. **Paired Termic computers in each other's sidebar.** A computer paired
   in Agent access shows its tasks below the local projects, filed with its
   own groups, colours, pins and order; a task opens as its terminal;
   Rename, Pin, Move to group from the row menu; a notification when one
   needs you.
3. **`--peer` between computers over the same stream.**

How it works: the desktop becomes a host on its LAN listener
(`/termic-peer/v1/stream`, a WebSocket, every frame sealed with the pair
key: HKDF-SHA256 per direction, ChaCha20-Poly1305). Pairing a phone is a
one-time 256-bit key in the QR code, good for five minutes, for the first
phone that uses it. Design and wire: `docs/remote.md` on the branch.

## Steps

### 1. The desktop as a host (this branch)

Built: the stream host (`remote_server.rs`), phone pairing and unpairing,
paired computers' tasks in the sidebar, tabs (only agent and run tabs open
remotely: a shell keeps no output for a viewer, by design), task actions,
alerts, the host's folder colours sent to clients. Tested with fake hosts
and phones in e2e (`peers.e2e.ts`, `remote.e2e.ts`), and with the real
phone app on Android against a real desktop.

Left: rebuild on top of `termic-server` once that merges; the manual test
and screenshots; a security read of the listener (it is the one new open
port: on only while sharing is on).

### 2. The phone app in the stores

The desktop half is useless until the app installs, so start this while
termic-server is in review:

- Apple developer account, TestFlight; Google Play internal testing.
- Store review wording for an app that drives another computer; privacy
  labels (the app talks only to the user's own computers).
- Whether the app is paid (see the relay below).
- Release the desktop half (step 1) when the app is installable.

Reaching the computer away from home needs the same network or the user's
own VPN (Tailscale is what the QR dialog suggests). The phone tries every
address in the pairing link at once and keeps the first that answers.

### 3. A phone pairing straight with a server

A phone controlling a termic-server box with no desktop involved. The
server already speaks the phone's messages; termic-server.md keeps the
session transport-agnostic and the server id link-compatible for this.
What it adds, all in termic-server:

- `termic-server pair`: a one-time key, the box's LAN and Tailscale
  addresses, the same pairing link as the desktop's, printed as a QR code
  in the terminal (scanned over ssh).
- `~/.termic-server/phones.json` (0600): paired phones (client id, name,
  key) and codes not used yet, flock-guarded since the CLI and the daemon
  both write it. `termic-server phones` lists them, `unpair` removes one
  and cuts its live connection.
- A TCP listener for the sealed stream, **up only while a phone is paired
  or a code is on offer**, so a server nobody paired a phone with still
  has no open port.
- The phone hides what a server does not have (pins, task groups).

## Not decided: a relay

Most people will not set up Tailscale to reach their computer from
outside. A relay that forwards the already-sealed frames (it cannot read
them) would remove that, as one more address the phone races. It is a
backend, which CLAUDE.md asks the maintainer to decide on, and it changes
what termic.dev/local publishes about the app's network use. Discussed in
the phone app's private repository, not here.

## Security

- The listener is on only while sharing is on (Settings > Remote control), and
  answers only paired phones and computers; an unknown key is refused.
- A pairing code works once, for five minutes, and every new phone raises
  an OS notification, so a photographed QR code cannot pair silently.
- Frames are sealed end to end; a frame that fails to open ends the
  connection.
