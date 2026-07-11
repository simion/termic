# Contributing to Termic

Thanks for considering it. Termic is a small project with a clear scope —
contributions that fit the [philosophy](#philosophy) are welcome.

> **Contributor License Agreement.** By opening a pull request you agree
> to the terms in [CLA.md](./CLA.md). It's a standard inbound-CLA that
> lets the project relicense in the future (e.g. dual-license a paid
> edition) without having to track down every past contributor. Your
> existing contributions stay AGPL-3.0 regardless.

## Quick start

```sh
git clone https://github.com/simion/termic
cd termic
make setup          # installs brew/rust/node, runs npm install + cargo check
make dev            # vite HMR + Rust auto-rebuild
```

`make help` lists every available target.

### Requirements

- macOS 12+ (Apple Silicon supported; Intel works for dev, untested for release)
- Homebrew (`make setup` uses it to install missing deps)
- Rust toolchain ([rustup](https://rustup.rs/))
- Node.js 20+

Verify with `make doctor` — exits non-zero on the first missing dep with
a fix message. Safe to run in CI.

---

## Repo layout

```
src/                       # React 19 + Vite 8 + TypeScript frontend
├── App.tsx                # 3-column grid (sidebar / main / right panel)
├── components/            # everything UI lives here
├── hooks/                 # ⌘1..9 shortcuts, attention notifier
├── lib/                   # types + IPC wrappers + utils
└── store/                 # zustand stores (app / ui / prefs / scriptRuns)

src-tauri/                 # Rust + Tauri 2 backend
├── Cargo.toml
├── src/lib.rs             # PTY manager, project/workspace IO, settings, scripts
├── src/sandbox.rs         # seatbelt profile renderer + in-process CONNECT proxy lifecycle
├── src/proxy.rs           # the in-process HTTPS CONNECT proxy (regex hostname allowlist)
├── tauri.conf.json        # window, bundle, updater config
├── capabilities/          # tauri permission grants
└── icons/                 # rasterized icons (regenerate with `make icons`)

scripts/                   # gen-icon.sh, release.sh, fetch-deps.sh
.github/workflows/         # CI: release.yml (build + sign + publish)
Makefile                   # all developer commands
```

The architecture deep-dive (PTY plumbing, sandbox model, performance
foot-guns, every subtle bug we've fixed before) lives in
[CLAUDE.md](./CLAUDE.md). Read it before touching anything in
`src-tauri/src/lib.rs` or `src/components/workspace/TerminalPane.tsx`.

---

## How to contribute

### Reporting bugs

Open an [issue](https://github.com/simion/termic/issues/new) with:

1. **macOS version + arch** (`sw_vers && uname -m`)
2. **Termic version** (toolbar → theme picker → look at the corner, or
   `defaults read /Applications/Termic.app/Contents/Info CFBundleShortVersionString`)
3. **What you did, what you expected, what actually happened**
4. **The debug log** if the bug is sandbox-related or a hang —
   `tail -200 "$(python3 -c 'import tempfile; print(tempfile.gettempdir() + "/termic-debug.log")')"`

Screenshots of the actual symptom beat any description.

### Suggesting features

Issues with `[feature request]` in the title are great. Two things help
get a feature merged:

1. **Concrete use case** — "I want X because workflow Y is painful," not
   "X would be cool."
2. **Sketch of where it'd live** — which file in `src/components/`, what
   the IPC contract looks like, etc. Saves the maintainer half the work.

### Pull requests

1. **Branch off `main`.** Termic doesn't use long-lived branches.
2. **One concern per PR.** A bug fix + a refactor + a new feature in one
   PR is a recipe for "we'll need to split this." Split it yourself.
3. **Run `make check-all` before pushing.** That's `cargo check` +
   `tsc -b --noEmit`. CI will reject anything that fails it.
4. **Update CLAUDE.md if you change architecture.** It's the source of
   truth for invariants ("never re-enable React StrictMode", "WebGL
   addon disposes BEFORE term.dispose()", etc.). New invariant? Add it.
5. **No new dependencies without justification.** Termic optimizes
   aggressively for binary size + cold-start. A 5 MB lib for a one-line
   utility is a no.
6. **Match the existing code style** — Prettier defaults, no semicolons
   in CSS-in-JS templates, `cn()` from `@/lib/utils` for class composition,
   Zustand selectors stay tight (no destructured stores).
7. **Don't touch `CHANGELOG.md`, the version, or cut a release.** Releases
   and changelog entries are maintainer-only (see below) — the maintainer
   writes the entry when they cut the version. A PR that edits `CHANGELOG.md`
   / `changelog.json` or bumps the version will be asked to drop that change.
   If your work is release-worthy, just say so in the PR description.

---

## Philosophy

Termic exists because:

1. **The interactive `claude`/`gemini`/`codex` CLIs are the source of
   truth** — features ship there first, on whatever subscription you
   already pay for. SDK wrappers chase them.
2. **Real PTYs > web emulation of agent UX.** Animations, slash-commands,
   `/resume` pickers, bell rings — they only render correctly through a
   real PTY connected to xterm.js.
3. **Performance is the differentiator.** Every dependency, every render,
   every refit is measured. A bug that flickers a single frame is a real
   bug. A 100ms editor open is a regression.

### What we WILL accept

- Bug fixes
- Performance improvements (with before/after numbers)
- New themes (palette in `src/store/prefs.ts` + class in `src/index.css`)
- New sandbox presets (`src/lib/sandboxPresets.ts`)
- CLI registry improvements (Settings → Agents)
- Documentation improvements
- Multi-arch / multi-platform CI matrices (Intel mac, Linux, Windows)

### What we WON'T accept

- Switching the editor away from CodeMirror 6 (verified slower in WKWebView)
- Re-enabling React StrictMode (reintroduces async PTY race documented in CLAUDE.md)
- A backend daemon / server component — Termic runs entirely on-device
- Embedding Monaco (~5MB cold-start regression)
- Bundling config/settings in source — config lives in user dirs only
- Forcing subpixel font smoothing (fringing on dark backgrounds)
- Sandboxing the aux terminal, setup script, run script, or archive script
  (only the agent CLI is the threat model; the rest is explicit user shell)
- Anything that ships analytics / telemetry / "phone home" of any kind

---

## Releasing (maintainers)

> **Maintainer-only.** Contributors and automated agents should never run
> these steps, bump the version, or add a `CHANGELOG.md` entry. The
> maintainer authors the changelog and cuts the tag as one explicit step.
> Everything below is for that person.

```sh
make release                  # bump patch (0.1.0 → 0.1.1)
make release BUMP=minor       # 0.1.0 → 0.2.0
make release BUMP=0.4.2-rc1   # set explicit version
git push && git push --tags
```

The push triggers `.github/workflows/release.yml` which:

1. Builds the macOS bundle on `macos-14` (arm64)
2. Ad-hoc codesigns the `.app` (no Apple Developer Program needed — the
   tap's `quarantine: false` is what stops the Gatekeeper prompt)
3. Ed25519-signs the updater `.tar.gz` package
4. Creates a GitHub Release with the `.dmg` + `.app.tar.gz` + `.sig`
5. Bumps the Homebrew cask in `simion/homebrew-termic`
6. Bumps the updater manifest at `termic.dev/updates/latest.json` (CF
   Pages picks it up in ~30s)

End result: brew users get the new version on `brew upgrade`, running
Termic instances see the update pill within 5 min (CF cache TTL).

### Required GitHub Actions secrets

| Name | What it's for |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | ed25519 private key for updater package signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for the key |
| `HOMEBREW_TAP_TOKEN` | PAT with `contents: write` on `simion/homebrew-termic` |
| `WEBSITE_REPO_TOKEN` | PAT with `contents: write` on `simion/termic.dev` |

Generate the ed25519 keypair with `npx tauri signer generate -w ~/.tauri/termic.key`
and back it up somewhere safe. **Losing the private key breaks self-update
for every existing install** — they'll reject signatures from a new key.
See [CLAUDE.md](./CLAUDE.md) §"Releasing" for the rotation procedure.

---

## License & Contributor Agreement

Termic is released under [AGPL-3.0-or-later](./LICENSE), and every
contribution becomes part of the Project under that license.

In addition, by submitting a pull request you agree to the
[Termic Contributor License Agreement](./CLA.md). The CLA grants the
maintainer the right to relicense contributions under other terms in
the future (for example, to offer a commercial license to companies
that cannot accept AGPL obligations). Your contribution will always
remain available under AGPL-3.0-or-later in the public project; the CLA
only adds the option to also offer it under other terms.

Signing is one-click via the [CLA Assistant](https://cla-assistant.io/)
bot, which will comment on your first pull request. See [CLA.md](./CLA.md)
for the full text and the manual-sign fallback.

---

## Code of conduct

Don't be a dick. If you're not sure, ask. The bar is "would I want to
read this comment on Hacker News with my name attached?"
