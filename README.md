<div align="center">

# termic

**Run `claude`, `codex`, `gemini`, `grok`, and `agy` in parallel, each in its own git worktree.**

[![Latest release](https://img.shields.io/github/v/release/simion/termic?label=release&color=d97757)](https://github.com/simion/termic/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-d97757)](./LICENSE)
[![macOS 12+](https://img.shields.io/badge/macOS-12%2B-d97757)](https://github.com/simion/termic/releases/latest)
[![Linux AppImage](https://img.shields.io/badge/Linux-AppImage-d97757)](#linux-appimage)
[![Windows: build from source](https://img.shields.io/badge/Windows-build%20from%20source-d97757)](#windows-self-build-no-sandbox)
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

### Linux (AppImage)

Download `termic_<version>_amd64.AppImage` from the
[Releases](https://github.com/simion/termic/releases) page, make it
executable, and run it:

```sh
chmod +x termic_*_amd64.AppImage
./termic_*_amd64.AppImage
```

The AppImage is ed25519-signed by the same CI flow as the macOS build,
so the in-app updater works the same way: a new release appears as the
**Update X.Y.Z** pill in the top-right, click to download + verify +
relaunch. Keep the AppImage somewhere writable like `~/Applications/`
so the updater can replace it in place.

The sandbox feature is macOS-only on Linux: the workspace's Shield
toggle is disabled and agents run unsandboxed. Everything else
(worktrees, parallel tabs, find-in-files, themes, in-app diff) works
the same.

Wayland note: if fonts render thin, force X11 with `GDK_BACKEND=x11`
in front of the launch command (or in the `.desktop` file's `Exec=`).

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

#### Linux (build it yourself)

The signed AppImage on the
[Releases](https://github.com/simion/termic/releases) page is the
recommended path for most users — see [Linux (AppImage)](#linux-appimage)
above. Build from source if you want to hack on it, ship a `.deb` /
`.rpm` for your own distro packaging, or run an unreleased commit.

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
launcher. The in-app updater only knows how to replace the AppImage in
place — `.deb` / `.rpm` users upgrade via `git pull && npm run tauri build`
+ reinstall.

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

Termic spawns the real `claude` / `codex` / `gemini` / `grok` / `agy`
(Antigravity) CLIs inside PTYs, the same binaries you run in iTerm. It
does NOT use the vendor SDKs (which bill against a separate credit
pool as of [June 2026](https://thenewstack.io/anthropic-agent-sdk-credits/));
inference rides on your existing Pro / Max plan.

- **Parallel worktrees.** Each workspace is a git worktree under
  `~/termic/workspaces/<project>/<name>/`. Run N agents against the same
  branch across tabs; attach to repo root when you don't want a worktree;
  duplicate a worktree to spin up a parallel attempt off the same tip.
- **Broadcast & Brainstorm.** Send a single prompt to every agent in a workspace concurrently (⇧⌘B). Perfect for multi-agent code reviews, architectural brainstorming, or getting four "second opinions" on a complex bug in seconds.
- **Config as Code (`.termic.yaml`).** Persist all project-specific settings—setup scripts, run commands, preview URLs, and sandbox allowlists—into a `.termic.yaml` file. Commit it to your repo so your whole team gets the same optimized agent environment instantly.
- **Per-workspace sandbox** (macOS). Filesystem + network cage via
  `sandbox-exec` and an in-process HTTPS CONNECT proxy with a hostname
  allowlist. Lets the agent run with `--dangerously-skip-permissions`
  safely — the cage is the boundary, not the prompt.
- **Sidebar Cockpit.** Expand any workspace in the sidebar to see all its active agents, their live work-done indicators, and their agent-managed titles at a glance.
- **Work-done indicator** that's actually reliable. Per-CLI title classifier (Claude spinner, Gemini's `◇`, etc.) plus OSC 9;4, gated by byte-quiet and content-hash checks. This reliability enabled **opt-in desktop notifications** that only fire when an agent actually finishes a turn.
- **Message Queues.** Built on top of work-done detection: queue N messages (with optional repeats) to run autonomous "Ralph loop" sessions.
- **Auto-Resume Everything.** Termic auto-resumes sessions even for repo-root workspaces. The latest update now auto-resumes ALL agent tabs in a workspace, not just the primary one.
- **Find + edit in-app.** ⌘P fuzzy file finder, ⇧⌘F find-in-files
  (`git grep`, .gitignore-aware, streams live). CodeMirror 6 editor with
  side-by-side / unified diffs and **Markdown preview** (including inline **Mermaid diagrams**).
- **Fork-style Git UI.** A dedicated staging area inspired by the Fork app. Stage, unstage, and commit without dropping to a terminal.
- **AI review**: open the Review dialog, pick an agent, it gets the diff
  + a review prompt and starts streaming.
- **Bring your own agent.** Settings → Agents is an editable registry.
  Drop in aider, opencode, ollama, a shell script — 30 seconds. Claude,
  Codex, Antigravity, Gemini, and Grok ship as built-ins.
- **Keyboard-first.** ⌘1..9 swaps tabs, ⌥↑/↓ walks the visible sidebar
  tree, ⌥⌘↑/↓ hops workspace-only, ⇧⌘D opens a split shell, ⌘T spawns a
  new tab, ⌘W closes one. Seven themes (System, Light, Claude, Dark+,
  Solarized Dark, Cobalt, Matrix), each re-themes both chrome and the
  terminal pane.

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
- **Linux:** x86_64 AppImage shipped per release, signed by the same
  ed25519 key as the macOS build so the in-app updater works. ARM
  Linux + a Flathub submission are on the roadmap.
- **Windows:** build-from-source works today (Tauri 2 + WebView2). No
  prebuilt binaries yet — CI matrix entry is on the roadmap.
- **Sandbox:** macOS-only (`sandbox-exec` is Apple's frontend to
  Seatbelt). On Linux + Windows the Shield toggle is disabled and
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
| Platforms | macOS + Linux today (signed AppImage); Windows on the way | macOS |

If you already pay for a Claude Pro / Max plan, Termic spawns the same
`claude` binary that plan covers — no separate metered usage, no
per-token markup. The agent and Anthropic still see the same auth they'd
see in iTerm.

---

## Roadmap

Open an issue to push something up the list or pick one off.

- **First-class git surface.** Commit / push / pull / branch switch from
  inside the app instead of dropping to the aux terminal.
- **Linear + GitHub PR integration.** Paste an issue / PR URL, get a
  workspace seeded with title + body. Create the PR from the app via
  `gh`. No OAuth.
- **Sandbox parity on Linux + Windows.** macOS Seatbelt today; bubblewrap
  / landlock on Linux and AppContainer on Windows are the gap.
- **Windows prebuilts.** AppImage CI is live for Linux; Windows MSI is
  the matching CI matrix entry.

---

## Sponsors

Termic is free, AGPL-3.0, and built by one person. If your team builds on AI coding agents and finds it useful, sponsoring helps keep it moving.

| [![DontPayFull](https://static.dontpayfull.com/static/images/logo/logo.png)](https://www.dontpayfull.com) |
|---|

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?style=flat&logo=github)](https://github.com/sponsors/simion)

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
