# Testing remote control by hand

How to run remote control (the `remote-control` branch: the stream,
paired computers, servers and phone pairing) on real machines and check
each feature yourself. The
design and the protocol are in [remote.md](remote.md); this page is the
runbook. Written for a person or an agent setting it up on a fresh
checkout.

The automated suites do not replace this. They drive a fake host and a
fake phone; a flicker, a stolen focus or a late repaint only shows up
when someone uses it.

## What you need

| Piece | For | Where |
|---|---|---|
| This branch, built | the desktop: host, client, sidebar | `npm install`, `npm run tauri:dev` |
| A second computer running the same branch | paired computers in the sidebar | any Mac (or Linux / Windows) on the same network or Tailscale |
| A Linux or macOS box you reach with `ssh` | Servers | your own ssh config and keys |
| The phone app | Phones | the separate, private `termic-mobile` repo, cloned next to this one (never copy it into this repo) |

Machine setup: Node 22, Rust (stable), Xcode on macOS. Install once:

```sh
npm install
npm run tauri:dev        # vite on 1420 + cargo; first build takes minutes
```

A dev build keeps its own data (`termic_dev`), so pairings, servers and
settings made here never touch an installed Termic, and the two can run
at once: each takes the first free port in 23620-23719.

After any Rust change, quit and relaunch `tauri:dev`; ⌘R is enough for
webview-only changes.

## 1. Paired computers (two desktops)

On both machines: Settings > **Remote** > Pair computers, and pair
them (one shows a code, the other enters it; details in
[peers.md](peers.md)). Make sure **Allow paired phones and computers to
connect** is on in Settings > Remote control. Then, on machine A, look at machine
B's section at the bottom of the sidebar.

Check, with tasks running on B:

- **Filing.** B's tasks show under B's own project folders and task groups,
  with the same colours, pins and order as B's sidebar. Change a group
  colour, a folder colour, a pin or the order on B: A follows within a
  second or two.
- **PR and labels.** A task with a PR shows its badge; a tab label set on B
  (`termic prop ticket ABC-1` from that tab) shows on the row.
- **Open a task.** Click it: its terminal opens over the main area, focused,
  headed "On B". Type into it: the keys reach B's agent.
- **Tabs.** On B, open a run tab and a shell in that task. On A the strip
  shows all three. The agent and the run tab open; the shell is dimmed with
  "Opens only on that computer", by design (a shell keeps no output for a
  remote viewer). A stopped tab is dimmed too.
  Limit: B only knows a task's tabs once B's own window has loaded it.
  Until then A opens the default agent.
- **Actions.** Right-click a row of B's: Rename (inline, Enter saves, Esc
  cancels), Pin / Unpin, Move to group (B's groups, or New group with the
  first unused colour), Remove from group. Each lands in B's sidebar.
- **Alerts.** With A's window not focused on that task, make one of B's
  agents ask a question (or finish a turn): A shows a desktop notification
  with the question. It respects A's Desktop notifications setting, never
  fires for the task you have open, and does not burst on reconnect.
- **Reconnect.** Quit Termic on B: A's section says Offline and retries;
  start it again: rows come back without a reload.

## 2. Servers (over ssh)

Install needs a `termic-server` build for the box. A dev build has none
bundled, so build one and point Termic at it, or install it by hand:

```sh
# Option A, cross-compiled static builds (needs cargo-zigbuild + zig):
node scripts/build-termic-server.mjs
TERMIC_SERVER_BIN_DIR=$PWD/src-tauri/resources/termic-server npm run tauri:dev

# Option B, build on the box itself and copy it into place:
rsync -a termic-proto termic-remote termic-server <box>:termic-server-build/
ssh <box> 'cd termic-server-build && sed -i "/^workspace = /d" termic-*/Cargo.toml \
  && cargo build --release -p termic-server \
  && mkdir -p ~/.termic/bin && cp target/release/termic-server ~/.termic/bin/'
```

Then Settings > Servers > **Add a server**, type what you would after
`ssh` (`alice@192.168.1.20` or a `~/.ssh/config` name) and Connect.

Check:

- The checklist (reach, system, installed, connect) passes; a first-seen
  host key shows its fingerprint before Trust.
- **New task** on one of the server's project rows: the agent starts on
  the box (its login shell's PATH), the row shows, and its terminal opens
  and fills the pane; resize the window and the remote PTY follows.
- Close the laptop lid or quit Termic: the server's agents keep running;
  reopen and they are still there.
- Remove the server: its tasks leave the sidebar but keep running on the
  box.

## 3. A phone

The app is in the private `termic-mobile` repo (its README has the full
detail):

```sh
cd ../termic-mobile/app && npm install
npx expo start              # scan the Expo QR with Expo Go (iPhone or Android)
```

The phone must reach this computer: same Wi-Fi, or Tailscale on both. An
iPhone asks for Local Network the first time; allow it.

On the desktop: Settings > Remote control > **Connect a phone**, scan its code
with the app (or Copy link instead and paste it in the app). The code
works once, for 5 minutes.

Check:

- **List.** Needs you / Working / Done / Idle, filed with the desktop's
  folders, groups and colours, pins first.
- **Answer a question.** Start a Claude, Codex or Antigravity task that asks
  something (a command approval, the folder-trust menu): the phone shows
  the question as a card with the agent's own options; tapping one answers
  it on the desktop.
- **Chat.** The transcript of the agent's session; send a follow-up from
  the composer.
- **Terminal.** The Terminal tab shows the agent's screen at the desktop's
  size; the key bar sends Esc, Tab, arrows and Enter.
- **Tabs.** A task with a run tab and a shell: chips for each; the agent and
  the run tab open, the shell chip is dimmed.
- **Task menu (⋯).** Rename, Pin, Move to group (including New group),
  Archive: each shows up in the desktop sidebar.
- **New task.** The + sheet starts one on the desktop.
- **Leave and return.** Background the app and come back: it reconnects
  without re-pairing. Unpair it on the desktop: the app says it was
  removed.

## Automated checks for the same features

```sh
npm test && (cd src-tauri && cargo test)
for c in termic-proto termic-remote termic-server termic-cli; do
  (cd $c && CARGO_TARGET_DIR=../src-tauri/target cargo test); done
npm run e2e:build
TERMIC_E2E_SPECS=peers,remote,cli,mcp,settings npx wdio run ./wdio.conf.ts
TERMIC_E2E_TEST_BOX=alice@box TERMIC_E2E_SPECS=remote npx wdio run ./wdio.conf.ts   # real server
cd ../termic-mobile/app && npm test && npx tsc --noEmit
```

Run e2e with the Mac unlocked and awake: a locked screen hides every
window, so terminals paint nothing and keyboard tests fail for no code
reason. `cargo test` overwrites the e2e binary, so `npm run e2e:build`
again before wdio. The phone's Maestro flows (`termic-mobile/app/.maestro`)
need a pairing link passed with `-e LINK=...`; never commit one, and never
put one in a screenshot or a recording.
