# termic

One window, many parallel agents (claude / gemini / codex) each in its own git-worktree workspace with an embedded terminal. **Performance trumps polish** — a 1-frame terminal flicker, a >100ms editor open, or an unnecessary sidebar re-render are real regressions.

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
    ├── workspace/ (MainArea, WorkspaceView, TabBar, TerminalPane, EditorPane, DiffPane, AuxTerminal, RightPanel, FileTree)
    ├── sidebar/ / settings/ / dialogs/ / ui/ / views/
    └── UnifiedBar.tsx
src-tauri/src/lib.rs   ← ALL Rust (PTY, project/workspace IO, settings, scripts, git, sandbox, proxy)
```

## Run / build

```sh
npm run tauri:dev    # vite (port 1420) + cargo; quit+relaunch after Rust changes
npm run tauri:build  # .app/.dmg in src-tauri/target/release/bundle/
npm run build        # tsc -b && vite build
```

⌘+R when HMR can't push (effect/state shape changes, React.lazy swaps, xterm/CodeMirror init). Quit+relaunch after `tauri.conf.json` / capabilities / any Rust signature change.

## Releasing

Add entry to TOP of `changelog.json` (`{version, date, summary}` — only write `summary`) before running `make release`. Full flow: **`RELEASING.md`**. Mock update UI: `VITE_MOCK_UPDATE=available|whatsnew npm run tauri:dev`.

## Copy rules

No em dashes (—) anywhere in user-visible text: dialogs, tooltips, buttons, `changelog.json`, error messages. Use a comma, period, parentheses, or colon instead.

## What NOT to do without asking

- Switch editor from CodeMirror 6 (Monaco is slower in WKWebView, verified).
- Re-enable React StrictMode (async PTY race).
- Add a server/backend daemon (app is entirely on-device).
- Make IO-heavy Tauri commands synchronous (freezes the Mac via WKWebView event loop).
- Sandbox AuxTerminal, setup, run, or archive scripts (only agent CLI PTY is the threat model).
- Expose `workspace_set_sandbox` without SIGKILLing live PTYs by default.
- Force subpixel font smoothing (colored fringing on dark backgrounds).
- Hard-code hex colors outside `@theme` in `index.css`.

## Docs

Deeper references — read when working in that area:

- [docs/ipc.md](docs/ipc.md) — Tauri commands, critical payload shapes, long-running IPC discipline
- [docs/data-model.md](docs/data-model.md) — data dirs, Project/Workspace/Settings/Tab entities
- [docs/performance.md](docs/performance.md) — perf traps, sub-pixel/rendering hardening
- [docs/sandbox.md](docs/sandbox.md) — sandbox-exec + CONNECT proxy, YOLO interaction, deny debugging
- [docs/shortcuts.md](docs/shortcuts.md) — shortcut system architecture, adding shortcuts, glyph rendering
- [docs/ui.md](docs/ui.md) — UI conventions, window chrome/drag, right-panel footer, settled detection
- [docs/gotchas.md](docs/gotchas.md) — common bugs (encountered + fixed), React/Zustand traps
- [docs/automation.md](docs/automation.md) — automation bridge, E2E testing (use the `e2e` skill, don't improvise)
