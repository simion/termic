# Testing servers by hand

How to run a termic-server box with this branch and check each feature
yourself. The design and the wire are in [remote.md](remote.md); this
page is the runbook, written for a person or an agent setting it up on a
fresh checkout.

The automated suites do not replace this. They drive a termic-server on
the same machine through a stand-in for ssh; a flicker, a stolen focus or
a late repaint only shows up when someone uses it.

## What you need

| Piece | For | Where |
|---|---|---|
| This branch, built | the desktop | `npm install`, `npm run tauri:dev` |
| A Linux or macOS box you reach with `ssh` | the server | your own ssh config and keys (`ssh <box>` must work without a password) |

Machine setup: Node 22, Rust (stable), Xcode on macOS. Install once:

```sh
npm install
npm run tauri:dev        # vite on 1420 + cargo; first build takes minutes
```

A dev build keeps its own data (`termic_dev`), so servers and settings
made here never touch an installed Termic, and the two can run at once.

After any Rust change, quit and relaunch `tauri:dev`; ⌘R is enough for
webview-only changes.

## A server, over ssh

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
- **New task on <server>** from its sidebar section: the agent starts on
  the box (its login shell's PATH), the row shows, and its terminal opens
  and fills the pane; resize the window and the remote PTY follows.
- Close the laptop lid or quit Termic: the server's agents keep running;
  reopen and they are still there.
- Remove the server: its tasks leave the sidebar but keep running on the
  box.

## Automated checks for the same features

```sh
npm test && (cd src-tauri && cargo test)
for c in termic-proto termic-remote termic-server termic-cli; do
  (cd $c && CARGO_TARGET_DIR=../src-tauri/target cargo test); done
npm run e2e:build
TERMIC_E2E_SPECS=remote,cli,mcp,settings,peers npx wdio run ./wdio.conf.ts   # incl. a local termic-server
TERMIC_E2E_TEST_BOX=alice@box TERMIC_E2E_SPECS=remote npx wdio run ./wdio.conf.ts   # plus a real box
```

Run e2e with the Mac unlocked and awake: a locked screen hides every
window, so terminals paint nothing and keyboard tests fail for no code
reason. `cargo test` overwrites the e2e binary, so `npm run e2e:build`
again before wdio. The real-box cases leave the box as they found it
(a scratch repo and agent, removed at the end).
