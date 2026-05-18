<div align="center">

# termic

**Run `claude`, `gemini`, and `codex` in parallel — each in its own git worktree.**

[![Latest release](https://img.shields.io/github/v/release/simion/termic?label=release&color=d97757)](https://github.com/simion/termic/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-d97757)](./LICENSE)
[![macOS 12+](https://img.shields.io/badge/macOS-12%2B-d97757)](https://github.com/simion/termic/releases/latest)
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
latest `.dmg`, and installs `termic.app` into `/Applications`. No
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
xattr -dr com.apple.quarantine /Applications/termic.app
```

### Build from source

```sh
git clone https://github.com/simion/termic
cd termic
make setup          # brew/rust/node + npm install + cargo check
make dev            # vite HMR + Rust auto-rebuild
make run            # build, install to /Applications, launch
```

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
  `~/termic/workspaces/<project>/<name>/`, branched off your default. Tabs
  per workspace let you run multiple agents against the same branch.
- **Real PTYs.** Agents render in xterm.js + WebGL exactly as they would
  in your shell: animations, slash-commands, `/resume` pickers, bell, bold.
- **Diff + edit in-app.** Built-in CodeMirror 6 editor + git-diff-vs-HEAD
  viewer per workspace. "Send to main" pushes the worktree's diff into the
  parent checkout for you to commit / PR there.
- **Per-CLI configuration.** Settings → Agents is a small editable registry:
  override the binary path, args, YOLO flags, runtime YOLO command. Claude,
  Gemini, Codex are the defaults; add your own.
- **Seven themes** (System / Light / Dark / Solarized Dark / Cobalt 2 /
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

- **Platform:** macOS 12+ (Monterey or later).
- **Architecture:** Apple Silicon (arm64) only at v0.1.x. Intel + Linux +
  Windows in the roadmap — the underlying stack (Tauri 2, portable-pty,
  xterm.js) supports them, just need CI matrix entries.
- **Sandbox:** macOS-only (`sandbox-exec` is Apple's thing). Disabled
  silently on other platforms when they ship.

---

## Why use Termic over Conductor / Cursor / Cline?

The honest pitch:

| | Termic | Conductor / Mux / etc. |
|---|---|---|
| **Bills against** | your existing Pro/Max | the new $200 credit pool (varies by plan) |
| **Underlying engine** | spawns the real CLI in a PTY | wraps the Claude Agent SDK |
| **License** | AGPL-3.0, open source | mostly proprietary |
| **New CLI features** | available the day the CLI ships them | wait for the SDK + wrapper to catch up |
| **Sandbox** | optional, per-workspace, kernel-enforced | varies |

If you already pay for a Claude Pro / Max plan, Termic spawns the same
`claude` binary that plan covers — no separate metered usage, no
per-token markup. The agent and Anthropic still see the same auth they'd
see in iTerm.

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
