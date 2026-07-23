# termic

One window, many parallel agents (claude / gemini / codex) each in its own git-worktree task with an embedded terminal. **Performance trumps polish** — a 1-frame terminal flicker, a >100ms editor open, or an unnecessary sidebar re-render are real regressions.

## Stack

React 19 + Vite 8 + TypeScript on Tauri 2 (Rust + WKWebView). Tailwind v4 (`@theme` CSS vars), Radix, Zustand 5 (`@/store/{app,ui,prefs,scriptRuns}`). CodeMirror 6 for the editor (do NOT swap to Monaco — verified slower in WKWebView). xterm.js + WebGL addon for terminals. portable-pty (wezterm) on the Rust side.

**No StrictMode** (`src/main.tsx`) — double-invoke races the async PTY spawn. Don't re-enable without auditing every async effect's cancellation.

## Layout

```
src/
├── main.tsx / App.tsx / index.css
├── lib/          (types, ipc wrappers, review prompt, utils.cn)
├── store/        (app, ui, prefs, scriptRuns)
├── hooks/        (useShortcuts, useAttentionNotifier)
└── components/
    ├── task/ (MainArea, TaskView, TabBar, TerminalPane, EditorPane, DiffPane, AuxTerminal, RightPanel, FileTree)
    ├── sidebar/ / settings/ / dialogs/ / ui/ / views/
    └── UnifiedBar.tsx
src-tauri/src/lib.rs   ← ALL Rust (PTY, project/task IO, settings, scripts, git, sandbox, proxy)
```

## Run / build

```sh
npm run tauri:dev    # vite (port 1420) + cargo; quit+relaunch after Rust changes
npm run tauri:build  # .app/.dmg in src-tauri/target/release/bundle/
npm run build        # tsc -b && vite build
```

⌘+R when HMR can't push (effect/state shape changes, React.lazy swaps, xterm/CodeMirror init). Quit+relaunch after `tauri.conf.json` / capabilities / any Rust signature change.

## Releasing

**Maintainer-only. Do NOT cut releases or write changelog entries as part of a contribution or agent task.** Never run `make release` / `make release-patch`, never bump the version, and never add or edit a `CHANGELOG.md` entry (or `changelog.json`) unless the maintainer explicitly asks you to in that request. A PR that fixes a bug or adds a feature must NOT touch `CHANGELOG.md` — the maintainer authors the entry when they cut the release. If you think a change is release-worthy, say so and stop; leave the versioning to them.

Add a `## [version] - ` section to the TOP of `CHANGELOG.md` (Keep a Changelog format: summary lead line + `### Features`/`### Bug fixes` bullets) before running `make release`. `CHANGELOG.md` is the source of truth; `changelog.json` is derived from it by `scripts/changelog.mjs` (do not hand-edit it). For a small change riding along with the last release, `make release-patch` folds it into a patch (bump the top heading in place + append a bullet, no new entry). Full flow: the **`release` skill** (`.claude/skills/release/SKILL.md`). Mock update UI: `VITE_MOCK_UPDATE=available|whatsnew npm run tauri:dev`.

## Copy rules

No em dashes (—) anywhere in user-visible text: dialogs, tooltips, buttons, `CHANGELOG.md`, error messages. Use a comma, period, parentheses, or colon instead.

## What NOT to do without asking

- Run e2e live testing (the `e2e` skill / automation bridge) proactively. Only run it when the user explicitly asks, or when it's absolutely necessary to confirm a change can't be verified any other way. Default to NOT launching the live app.
- Switch editor from CodeMirror 6 (Monaco is slower in WKWebView, verified).
- Re-enable React StrictMode (async PTY race).
- Add a server/backend daemon (app is entirely on-device).
- Make IO-heavy Tauri commands synchronous (freezes the Mac via WKWebView event loop).
- Sandbox AuxTerminal, setup, run, or archive scripts (only agent CLI PTY is the threat model).
- Expose `task_set_sandbox` without SIGKILLing live PTYs by default.
- Widen the CSP in `tauri.conf.json`. One policy covers the whole webview, and the webview sits outside the sandbox ("Known gap" in [docs/sandbox.md](docs/sandbox.md)). `img-src https:` is an accepted exception; `connect-src` / `script-src` would be far worse.
- Force subpixel font smoothing (colored fringing on dark backgrounds).
- Hard-code hex colors outside `@theme` in `index.css`.
- Hide panes with `visibility: hidden` (must be `display: none`). xterm's renderer only pauses on zero geometry; visibility-hidden terminals keep running WebGL draws for background TUI repaints and pin the GPU. See docs/performance.md bear trap 2.
- Add `thread::sleep` poll loops in Rust. PTY flusher/waiter block on a condvar; sleep-polling burned ~1,950 wakeups/s and kept the CPU out of deep sleep. See docs/performance.md bear trap 8.

## Docs

Deeper references — read when working in that area:

- [docs/ipc.md](docs/ipc.md) — Tauri commands, critical payload shapes, long-running IPC discipline
- [docs/data-model.md](docs/data-model.md) — data dirs, Project/Task/Settings/Tab entities
- [docs/tech-debt.md](docs/tech-debt.md) — index of temporary/removable scaffolding (e.g. the workspace→task migration) + purge checklists
- [docs/performance.md](docs/performance.md) — perf traps, sub-pixel/rendering hardening
- [docs/sandbox.md](docs/sandbox.md) — sandbox-exec + CONNECT proxy, YOLO interaction, deny debugging
- [docs/shortcuts.md](docs/shortcuts.md) — shortcut system architecture, adding shortcuts, glyph rendering
- [docs/themes.md](docs/themes.md) — custom theme file format (`~/.config/termic/themes/*.json`), ui/terminal key reference
- [docs/ui.md](docs/ui.md) — UI conventions, window chrome/drag, right-panel footer, settled detection
- [docs/gotchas.md](docs/gotchas.md) — common bugs (encountered + fixed), React/Zustand traps
- [docs/automation.md](docs/automation.md) — automation bridge, E2E testing (use the `e2e` skill, don't improvise)
- [docs/e2e-tests.md](docs/e2e-tests.md) — written WebdriverIO e2e suite (run via `make e2e`); authoring lives in the `e2e` skill
- [docs/plans/e2e-coverage.md](docs/plans/e2e-coverage.md) — e2e coverage checklist + roadmap (what's tested, what's next)
