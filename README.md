<div align="center">

# termic

**Run `claude`, `gemini`, and `codex` in parallel — each in its own git worktree.**

[![Latest release](https://img.shields.io/github/v/release/simion/termic?label=release&color=d97757)](https://github.com/simion/termic/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-d97757)](./LICENSE)
[![macOS 12+](https://img.shields.io/badge/macOS-12%2B-d97757)](https://github.com/simion/termic/releases/latest)
[![Linux + Windows: build from source](https://img.shields.io/badge/Linux%20%2B%20Windows-build%20from%20source-d97757)](#linux-build-once-install-use)
[![termic.dev](https://img.shields.io/badge/website-termic.dev-d97757)](https://termic.dev)

Free, open-source desktop app for running AI coding-agent CLIs in parallel,
each in an isolated git worktree, with an optional macOS sandbox cage per
workspace.

[Install](#install) · [What it does](#what-it-does) · [Sandbox](#sandbox) · [Contributing](./CONTRIBUTING.md)

</div>

---

## Install

The recommended path is Homebrew + the official tap:

```sh
brew install --cask simion/termic/termic
```

That single command auto-taps `simion/homebrew-termic`, downloads the
latest `.dmg`, and installs `Termic.app` into `/Applications`. No
Gatekeeper warning — the tap is configured to bypass it.

Updates: Termic ships with a self-updater. When a new release lands you'll
see an **Update X.Y.Z** pill in the top-right of the toolbar; click it
to download + verify + relaunch. To check manually:

```sh
brew upgrade --cask termic
```

### Direct download

`.dmg`, `.app.tar.gz`, and the ed25519 signature for each version live at
the [Releases](https://github.com/simion/termic/releases) page. First
launch may show the "unidentified developer" Gatekeeper prompt — right-click
the app → Open, or strip the quarantine attribute:

```sh
xattr -dr com.apple.quarantine /Applications/Termic.app
```

### Build from source

#### macOS (first-class)

```sh
git clone https://github.com/simion/termic
cd termic
make setup          # brew/rust/node + npm install + cargo check
make install        # build, copy to /Applications, launch
```

`make dev` (vite HMR + Rust auto-rebuild) is the iteration loop — see
[CONTRIBUTING.md](./CONTRIBUTING.md) if you plan to hack on the code.

#### Linux (build once, install, use)

No prebuilt `.deb` / `.rpm` / `.AppImage` yet, so the path is "build
locally once, then install the resulting bundle." After that you
launch Termic from your app menu like any other app. **The sandbox
feature is macOS-only** — on Linux the workspace's Shield toggle is
disabled and agents run unsandboxed. Everything else (worktrees,
parallel tabs, themes, in-app diff, file finder, find-in-files, the
in-process CONNECT proxy) works the same.

Prerequisites — Debian / Ubuntu (24.04+ has WebKitGTK 4.1):

```sh
sudo apt update
sudo apt install -y \
  build-essential curl wget file git pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libsoup-3.0-dev libxdo-dev

# Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# Node 20+ — distro package, nvm, fnm, asdf, or mise (whichever you use)
```

Fedora:

```sh
sudo dnf install -y \
  @development-tools curl wget file git pkgconfig \
  webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel \
  librsvg2-devel openssl-devel libsoup3-devel libxdo-devel
```

Arch:

```sh
sudo pacman -S --needed base-devel curl wget file git pkgconf \
  webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl libsoup3 xdotool
```

Build and install:

```sh
git clone https://github.com/simion/termic
cd termic
npm install
npm run tauri build           # ~5 min first time, faster on incremental
```

The bundles land under `src-tauri/target/release/bundle/`. Pick whichever
fits your distro:

```sh
# Debian / Ubuntu / Pop / Mint
sudo apt install ./src-tauri/target/release/bundle/deb/termic_*_amd64.deb

# Fedora / RHEL / openSUSE
sudo dnf install ./src-tauri/target/release/bundle/rpm/termic-*.x86_64.rpm

# Distro-agnostic — no install needed, just make it executable and run
chmod +x src-tauri/target/release/bundle/appimage/termic_*_amd64.AppImage
./src-tauri/target/release/bundle/appimage/termic_*_amd64.AppImage
```

After the `.deb` / `.rpm` install, "Termic" shows up in your application
launcher. Self-update inside the app won't work on Linux yet (no signed
update channel for Linux); to upgrade, `git pull && npm run tauri build`
and reinstall the package, or replace the `.AppImage` in place.

If the window looks slightly off — an empty gap on the left of the top
bar, for example — that's the 84px reservation for macOS traffic-light
controls. Harmless, will be cleaned up when the cross-platform chrome
lands.

Wayland note: if fonts render thin, force X11 with
`GDK_BACKEND=x11 termic` (or set it in the `.desktop` file's `Exec=`).

#### Windows (self-build, no sandbox)

Same story: no prebuilt binaries, build works, sandbox is a no-op.
On Windows 11 (or Windows 10 with WebView2 Evergreen installed):

1. Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (the "Desktop development with C++" workload).
2. Install [Rust stable](https://www.rust-lang.org/tools/install) (rustup).
3. Install [Node 20+](https://nodejs.org/) and [Git for Windows](https://git-scm.com/download/win).

Then in PowerShell:

```powershell
git clone https://github.com/simion/termic
cd termic
npm install
npm run tauri build              # → src-tauri\target\release\bundle\msi\
```

The `.msi` is unsigned — Windows SmartScreen will warn on first run.
Click *More info → Run anyway* (or sign it yourself for distribution).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full dev guide.

---

## What it does

Termic is a control plane for **interactive CLI coding agents** — the ones
you type into in a terminal: `claude`, `gemini`, `codex`. It does NOT use
their respective SDKs (which bill against a separate credit pool as of
[June 2026](https://thenewstack.io/anthropic-agent-sdk-credits/)); it
spawns the same binaries you'd run in iTerm and rides on your existing
Pro / Max subscription.

The product surface:

- **One window, many workspaces.** Each workspace is a git worktree under
  `~/termic/workspaces/<project>/<name>/`, branched off your default.
  Tabs per workspace let you run multiple agents against the same branch.
  Worktree-or-repo-root toggle per workspace when you don't want a worktree.
- **Multi-repo workspaces.** A project type that groups N member repos under
  one wrapper directory with shared `CLAUDE.md` / `AGENTS.md` / `.claude/`,
  per-member ports (`$TERMIC_PORT_<MEMBER>` is exported so frontends can call
  backends without hardcoded ports), and one aggregated diff view.
- **Real PTYs.** Agents render in xterm.js + WebGL exactly as they would
  in your shell: animations, slash-commands, `/resume` pickers, bell, bold.
- **Work-done indicator.** Sender-driven, no idle heuristics: Claude's
  `OSC 9;4` busy/idle, Gemini's `◇ Ready` / `✦ Working…` / `✋ Action Required`
  title, Codex's `Working` / `Ready` / `Waiting` title. Green ✓ on the tab
  when a turn finishes, yellow 🔔 when the agent is blocked on your input,
  optional desktop notification that jumps you back to that workspace + tab.
- **Diff + edit in-app.** CodeMirror 6 editor + side-by-side ⇄ unified diff
  viewer with full syntax highlighting via `@codemirror/merge`. "Send to
  main" pushes the worktree's diff into the parent checkout for you to
  commit / PR there.
- **Per-CLI configuration.** Settings → Agents is a small editable registry:
  override the binary path, args, YOLO flags, runtime YOLO command, resume
  args. Claude, Gemini, Codex are built in; bring your own PTY-based CLI
  (OpenCode, aider, ollama, custom shell scripts) in 30 seconds.
- **Seven themes** (System / Light / Dark / VS Code / Solarized / Cobalt /
  Matrix), each one re-themes both the app chrome AND the xterm pane.

---

## Sandbox

Optional per-workspace macOS Seatbelt (`sandbox-exec`) + an in-process
HTTPS CONNECT proxy per workspace. Configured per project, pinned per
workspace at creation (editable later from the workspace's Shield icon),
enforced from the moment the agent spawns.

The cage:

- **Writes restricted** to the worktree, agent config dirs (`~/.claude`,
  `~/.gemini`, `~/.codex`), package caches (`~/.npm`, `~/.cache`,
  `~/.cargo/registry`), and TMPDIR. Always-denied: `~/.ssh`, `~/.aws`,
  `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, Keychains.
- **Network restricted** via an in-process CONNECT proxy with a regex
  hostname allowlist. Per-CLI vendor APIs (anthropic / google / openai)
  + GitHub + npmjs + PyPI + crates.io baked in. Add custom hosts per
  project. No external daemon — the proxy lives inside the Tauri
  binary, so there's nothing extra to install.
- **YOLO auto-on inside the cage.** The seatbelt profile IS the security
  boundary, so the agent's own permission prompts are skipped. The toolbar
  lightning icon turns red when YOLO is on *without* a sandbox (intentional
  danger signal — agents can `rm -rf $HOME` at that point).

For the full sandbox design — including the recent-denies debug panel
and the auto-restart-on-edit flow — see [CLAUDE.md](./CLAUDE.md)
§"Sandbox".

---

## Status

- **macOS:** first-class — universal binary (Apple Silicon + Intel),
  signed updater, Homebrew cask. Requires macOS 12+ (Monterey).
- **Linux + Windows:** build-from-source works today (Tauri 2 +
  WebKitGTK / WebView2). No prebuilt binaries yet — CI matrix entries
  + signed installers are on the roadmap.
- **Sandbox:** macOS-only (`sandbox-exec` is Apple's frontend to
  Seatbelt). On Linux + Windows the Shield toggle is greyed out and
  agents run unsandboxed.

---

## Why use Termic over Conductor

The honest pitch — see [termic.dev/vs/conductor](https://termic.dev/vs/conductor/) for the full version with explanations.

| | Termic | Conductor |
|---|---|---|
| License | Open source (AGPL-3.0) | Closed source, proprietary |
| Price | Free | Paid |
| Parallel agents in git worktrees | ✓ | ✓ |
| Attach an agent to the repo root (no worktree) | ✓ | ✗ (worktree per workspace only) |
| Runs `claude` | ✓ | ✓ |
| Runs `gemini` | ✓ | ✗ |
| Runs `codex` | ✓ | ✓ |
| Bring your own agent (PTY-based) | ✓ — opencode, aider, ollama, anything that runs in a terminal | ✗ |
| Multi-repo workspaces | ✓ — N repos under one wrapper, shared CLAUDE.md, per-member ports | ✗ |
| Uses Claude Pro / Max subscription quota | ✓ — spawns the interactive `claude` CLI directly | ◐ Routes through the Claude Agent SDK |
| Monthly Claude cost on top of your Pro / Max plan | $0 — same quota as running `claude` in iTerm | Capped by the separate SDK credit ($20 / $100 / $200) |
| Local-only, no vendor backend in the loop | ✓ | ✗ — vendor-hosted services |
| Per-workspace macOS sandbox (filesystem + network) | ✓ — Seatbelt + in-process network allowlist | ✗ |
| Work-done indicator from real PTY signals | ✓ — OSC 9;4 + per-CLI title classifier, no idle guessing | ✗ |
| Side-by-side ⇄ unified diff with syntax highlighting | ✓ | varies |
| Platforms | macOS today; Linux + Windows on the way | macOS |

If you already pay for a Claude Pro / Max plan, Termic spawns the same
`claude` binary that plan covers — no separate metered usage, no
per-token markup. The agent and Anthropic still see the same auth they'd
see in iTerm.

---

## Roadmap

What's next, roughly in order. No dates — open an issue if you want to
push something up the list or pick one off.

- **Better git support.** First-class commit / push / pull / branch
  switch from inside the app instead of dropping to the aux terminal.
  Currently the diff viewer is read-only and "Send to main" only moves
  the working tree.
- **Linear + GitHub PR integration.** Paste a Linear issue or GitHub
  issue/PR URL → new workspace seeded with the title + body. Create
  the PR from the app once you're done. No OAuth — uses the `gh` CLI
  + unauthenticated public APIs so we don't need your repo scopes.
- **Fix desktop notifications.** The "agent needs input" / "agent
  finished" notifications miss too often (settled-detection edge
  cases, OSC 9;4 dropped on resize, title parser regressions). Audit
  + tighten the per-CLI signal classifier and the OS-level fan-out.

---

## License

[AGPL-3.0-or-later](./LICENSE). Fork it, modify it, build a derivative —
the only string is that derivatives stay AGPL too. The "open core that
quietly went proprietary" pattern can't happen with this license, which
is most of the point.

---

## Links

- **Website:** [termic.dev](https://termic.dev)
- **Issues:** [github.com/simion/termic/issues](https://github.com/simion/termic/issues)
- **Releases:** [github.com/simion/termic/releases](https://github.com/simion/termic/releases)
- **Homebrew tap:** [github.com/simion/homebrew-termic](https://github.com/simion/homebrew-termic)
- **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md)
- **Architecture notes (for hackers + AI agents working in this repo):** [CLAUDE.md](./CLAUDE.md)
