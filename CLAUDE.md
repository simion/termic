# termic — context for Claude Code

One window, many parallel agents (claude / gemini / codex) each in its own git-worktree workspace with an embedded terminal. **Performance trumps polish** — a 1-frame terminal flicker, a >100ms editor open, or an unnecessary sidebar re-render are all real regressions.

## Stack

React 19 + Vite 8 + TypeScript on top of Tauri 2 (Rust + WKWebView). Tailwind v4 (`@theme` CSS vars), Radix headless primitives, Zustand 5 for state (`@/store/app`, `@/store/ui`, `@/store/prefs`, `@/store/scriptRuns`). CodeMirror 6 for the editor (~150KB; **do not** swap to Monaco — verified slower in WKWebView). xterm.js + WebGL addon for terminals (DOM ribbons; canvas drops frames). portable-pty (wezterm) on the Rust side. Inter Variable for UI, JetBrains Mono Variable for code/terminal (bundled via `@fontsource-variable/*`). lucide-react + inline brand SVGs.

**No StrictMode.** Disabled in `src/main.tsx` — double-invoke races the async PTY spawn (first spawn killed before its data listener wires). Don't re-enable without auditing every async effect's cancellation.

## Layout

```
src/
├── main.tsx              (createRoot, NO StrictMode, global error → log_line)
├── App.tsx               (UnifiedBar + grid: Sidebar / MainArea / RightPanel; Settings is a z-40 overlay, NOT a replacement — preserves PTYs)
├── index.css             (@theme tokens, html.light overrides, forced grayscale smoothing)
├── lib/                  (types, ipc wrappers, review prompt, utils.cn)
├── icons/                (CliIcon + TermicLogo)
├── store/
│   ├── app.ts            (projects/workspaces/tabs + mountedWorkspaces Set + footerTerm map + bottomTabs + per-ws split/widths)
│   ├── ui.ts             (dialog visibility + busyMessage overlay)
│   ├── prefs.ts          (theme, fonts, terminal font weight, yolo, desktopNotifications)
│   └── scriptRuns.ts     (per-(ws,kind) Run/Setup live status + lines)
├── hooks/                (useShortcuts: ⌘1..9, ⌘[/], ⌘W, ⌘L, ⌘T, ⇧⌘[/] workspace nav; useAttentionNotifier)
└── components/
    ├── UnifiedBar.tsx, ui/, sidebar/, views/
    ├── workspace/{MainArea,WorkspaceView,TabBar,TerminalPane,EditorPane,DiffPane,AuxTerminal,RightPanel,FileTree}.tsx
    ├── settings/         (Appearance, General, Agents, Shortcuts, Repository)
    └── dialogs/{Dialogs,NewProject,NewWorkspace,Welcome,Review}.tsx
src-tauri/
├── tauri.conf.json       (Overlay titleBarStyle, hiddenTitle, trafficLightPosition {x:16,y:16}, visible:false → positioned then shown)
├── capabilities/default.json   (REQUIRES core:window:allow-start-dragging + allow-toggle-maximize + allow-minimize)
└── src/lib.rs            ← ALL the Rust (PTY mgr, project/workspace IO, settings, scripts, discovery, git)
```

## Run / build

```sh
npm install
npm run tauri:dev         # vite (port 1420) + cargo run; auto-rebuilds Rust on save BUT keeps old process running — quit + relaunch after Rust changes
npm run tauri:build       # release .app/.dmg in src-tauri/target/release/bundle/
npm run build             # tsc -b && vite build (type-check + bundle)
```

⌘+R after frontend changes when HMR can't push (useEffect/useState shape changes, React.lazy swaps, xterm/CodeMirror init edits). **Quit + relaunch** after `tauri.conf.json` / `capabilities/*.json` / any Rust signature change.

## Releasing

`make release` (→ `scripts/release.sh`) cuts the tag; CI does the rest. **Before** running it, add the new version's entry to the TOP of `changelog.json` (repo root) — schema is `{version, date, summary}` and you only write `summary` (`version` from the bump, `date` auto-stamped). `make release` gates on it (scaffolds a stub + aborts if `summary` is empty). The `summary` feeds the in-app Update card and Changelog dialog. CI copies `changelog.json` to `termic.dev` alongside `latest.json`. Full flow + schema: **`RELEASING.md`**. Dev the update UI with `VITE_MOCK_UPDATE=available|whatsnew npm run tauri dev`.

## Data model

- **Data dirs.** TWO directories — different owners:
  - `<data_local_dir>/termic/` (e.g. macOS: `~/Library/Application Support/termic/`) — app-owned: `projects.json`, `workspaces/`, `settings.json`. Path via `dirs::data_local_dir().join("termic")` in `lib.rs#data_dir()`.
  - `<data_local_dir>/com.simion.termic/` — tauri-plugin-state owned (window position/size from `tauri-plugin-window-state`). Path derives from `tauri.conf.json#identifier`.
- **Project** entries live in `<data_local_dir>/termic/projects.json` as a single JSON array — git repo + scripts + `preview_url` template + `files_to_copy` globs + `default_cli`.
- **Workspace** (`workspaces/<uuid>.json`, one per file) — git worktree branched from project's `base_branch`. Worktrees live at `~/termic/workspaces/<project>/<name>/`. `is_repo_root=true` workspaces point at the project's live checkout (no worktree, archive doesn't `rm -rf`).
- **Settings** (`settings.json`) — `repos_dir`, `welcomed`, `agents[]` (user-editable registry: claude/gemini/codex defaults + customs; each has command/args/yolo_args/runtime_yolo_command). On load, defaults are seeded if `agents` is empty.
- **Tab** (per workspace, in `useApp`): `terminal` (PTY running a CLI), `edit` (CodeMirror), `diff` (vs HEAD). PTYs die with the app.

## Tauri commands (highlights)

- Workspaces: `workspace_create` (async, streams setup via `setup-output://<ws_id>` + `setup-done://<ws_id>`), `workspace_archive`/`workspace_delete` (**async, spawn_blocking** — see freeze note below), `workspace_open_repo`, `workspace_run_script_stream` + `workspace_stop_script` (script PIDs tracked in `RUNNING_SCRIPTS` map, child spawned with `process_group(0)` for clean SIGTERM tree-kill).
- PTYs: `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`. Emits `pty://<id>` (`PtyChunk { data: Vec<u8> }`) and `pty-exit://<id>` (`PtyExit { code: Option<i32> }`).
- Scripts: emit `script-output://<wsId>:<kind>` (`{ line }`) + `script-done://<wsId>:<kind>` (`{ code, success }`). `kind` ∈ `setup`/`run`.
- Settings/discovery: `settings_load`/`settings_save`/`agents_save`/`discover_repos`/`detect_clis`/`list_monospace_fonts` (async + `spawn_blocking` + OnceLock cache — font-kit is 7s synchronous).
- Misc: `notify`, `open_path` (handles URLs too via macOS `open`), `home_dir`, `path_exists`, `log_line`.

### Critical IPC shapes (regress easily, fail silently)

- `pty_spawn` payload is `{ args: SpawnArgs }`, NOT `SpawnArgs` at top level. Wrong shape → "invalid length 0, expected struct SpawnArgs".
- Listener payload is `ev.payload.data` / `ev.payload.line` — Rust emits **structs**, not bare arrays. Wrong unpack → blank terminals, no error.
- `workspace_run_script` (one-shot) takes `{ id, which }`. Frontend wrapper used to forget `which` → silent no-op.

## Long-running IPC discipline

**Any IPC that does heavy IO MUST be `async fn` + `tauri::async_runtime::spawn_blocking`.** Synchronous Tauri commands run on the IPC handler thread, which is the same thread driving the WKWebView event loop in dev — `fs::remove_dir_all` on a 50k-inode `.venv` froze the *entire Mac* through that path (WindowServer + Dock back up). Already applied to `workspace_archive`, `workspace_delete`, `list_monospace_fonts`. Pair with `useUI.setBusy("…")` overlay (`Dialogs.tsx`) so the user knows a multi-second op is in flight.

## Right-panel footer (Setup / Run / Terminal)

Three tabs. Setup + Run stream live output via `useScriptRuns` (per-(ws,kind) state). Terminal is **opt-in**: only created when user clicks the `+` icon → `useApp.enableFooterTerm(wsId)`, AuxTerminal mounts. RunToolbar: Open (expands `project.preview_url` with `$TERMIC_PORT` / `$CONDUCTOR_PORT` / `$PORT` / `$TERMIC_WORKSPACE_NAME` + legacy `$CONDUCTOR_*` aliases) + Run/Stop (Stop SIGTERMs the process group). Defaults: tab=Run, expanded.

`workspace_archive` sweeps `RUNNING_SCRIPTS` for the ws and SIGTERMs each before tearing down — otherwise dev servers keep their ports forever.

## Performance bear traps & wins

1. **Lazy editor.** `EditorPane`/`DiffPane` via `React.lazy` in `WorkspaceView`. Don't break.
2. **Keep terminals mounted across switches.** `WorkspaceView` and `MainArea` toggle `visibility:hidden` instead of unmounting — xterm rebuild + PTY reconnect is slow + stateful. `mountedWorkspaces: Set<string>` in app store keeps every visited workspace rendered.
3. **WebGL renderer non-negotiable.** Load AFTER `term.open(host)`. **CRITICAL**: dispose `webglAddon` BEFORE `term.dispose()` — its render loop fires on a half-disposed terminal otherwise (`_isDisposed` crash). Same fix lives in TerminalPane AND AuxTerminal.
4. **`lineHeight: 1.0` in xterm.** Anything else inflates cells; TUIs paint visible "ribbons" between rows.
5. **Tight Zustand selectors.** Never destructure the whole store. Use frozen empty constants (`EMPTY_TABS`) so default-case selectors stay referentially stable — React 19 warns "getSnapshot should be cached" otherwise.
6. **Math.round every dimension.** Sub-pixel widths blur every glyph in WKWebView. All sidebar/right-panel/footer/split setters round on write AND on `localStorage` read.
7. **Disable transitions during drag.** `App.tsx` grid uses `transition: var(--cols-transition, …)` and `ResizeHandle` sets `--cols-transition: none` on `<html>` while a drag is active — otherwise the column lerps and visibly trails the cursor.
8. **PTY firehose.** Every chunk: Rust → event → JS → xterm. Coalescing in Rust (~4ms window) would cut event count 10–50×. Not done yet.

## Sub-pixel & rendering hardening

- Force grayscale font smoothing on `html` (`-webkit-font-smoothing: antialiased`) — subpixel AA produces colored fringing on dark backgrounds. Don't revert.
- Dialogs use **flexbox centering on a full-viewport wrapper**, no transforms on `Dialog.Content` — `-translate-x-1/2 -translate-y-1/2` puts the box at sub-pixel offsets when viewport width is odd, blurring every glyph.
- Streaming output / pre boxes inside dialogs need `min-w-0` on grid items — grid items default to `min-width: auto` and won't shrink below their content's intrinsic width (long monospace lines push the dialog past `max-w-md`).
- `ResizeHandle` is 1px wide (`-ml-px`/`-mt-px`) with 4px-each-side invisible hit area. `-ml-0.5` would be 2px on retina but ~0 on 1×, sub-pixel disaster.
- Terminal text looks lighter than native Terminal.app — WebGL atlas rasterizes glyphs via Canvas 2D once, WKWebView's path is consistently lighter than Core Text. Mitigation: `terminalFontWeight` pref (Appearance section), Medium (500) closes most of the gap on 1× displays.

## Settled detection / notifications

TerminalPane samples `term.buffer.active` every 3s, FNV-1a hashes the visible viewport, marks the tab "settled" after 2 consecutive identical samples. Resets on user input. `markAttention(wsId, tabId, reason)` is gated at the store: **never marks the active tab in the active workspace** (no dot on what the user is looking at). `useAttentionNotifier` further suppresses OS notifications for **every tab in the focused workspace** — fires only for inactive workspaces. Desktop notifications OFF by default in Prefs.

## UI conventions

- Colors are `@theme` CSS vars in `index.css` (light + dark variants). Accent terracotta `#d97757`, dark surfaces `#0a0a0a → #181818`, warm-neutral text. Never hard-code hex outside `@theme`.
- `CliIcon cli={...}` + `CLI_BRAND_COLOR[cli]` for claude/gemini/codex (orange/blue/green) — tab bar, sidebar, popovers, dialogs.
- Tooltips default `delay: 0`. Override per-call for chrome.
- `cn()` from `@/lib/utils` for class composition — never concatenate manually.
- **Never enable spell check on inputs/textareas.** Always set `spellCheck={false}` (and `autoCorrect="off"` / `autoCapitalize="off"` / `autoComplete="off"` where appropriate) on every `<input>` and `<textarea>`. This is a developer tool — file names, paths, agent names, branch names, shell commands are never English words and squiggles are pure noise.

## Window chrome / drag

macOS overlay title bar with hidden title; reserves 84px on the left for traffic lights. Unified bar uses **three drag mechanisms together** (each fails differently):

1. `data-tauri-drag-region` attribute (Tauri 2 JS handler) — primary
2. `WebkitAppRegion: "drag"` inline style (native AppKit hint) — backup
3. `onMouseDown → getCurrentWindow().startDragging()` (imperative) — escape hatch

Interactive containers opt out with both `data-tauri-drag-region="false"` and `WebkitAppRegion: "no-drag"`. mousedown handler checks `e.target.closest("button, input, [data-no-drag]")`.

`startDragging()` silently fails without `core:window:allow-start-dragging` in capabilities. Don't put `user-select: none` on the drag region (breaks WKWebView's drag detection); put it on inner text spans.

## Keyboard shortcuts (configurable)

Shortcuts are **user-rebindable**. `src/lib/shortcuts.ts` is the single source of truth: a `ShortcutId` union + `SHORTCUT_DEFS` (each has `id`, `label`, `group`, optional `hint`, `defaultBinding`). A `Binding` is `{ cmd, shift, alt, key }` where `cmd` folds **Cmd≡Ctrl** (the app fires the same command on every platform), `shift`/`alt` are their own flags, and `key` is a normalized token (lowercase letter, punctuation, `ArrowUp`…, or the `"1-9"` sentinel). **Adding a shortcut = a `ShortcutId` + a `SHORTCUT_DEFS` entry** (+ a `case` in `useShortcuts` for global ones); the help modal and settings editor are fully data-driven from `SHORTCUT_DEFS`, so they update automatically.

- **Resolved bindings** live in the prefs store (`usePrefs(s => s.shortcuts)`): `DEFAULT_BINDINGS` merged with the user's localStorage overrides (merge-onto-defaults so new commands always have a binding). Mutate via `setShortcut` / `resetShortcut` / `resetAllShortcuts`.
- **Global handler** (`src/hooks/useShortcuts.ts`): one window keydown listener matching events against the resolved bindings via `bindingMatches(e, binding)`. **Contextual** shortcuts (ones that need component state, e.g. acting on a panel's selection) are instead handled inside their component with a capture-phase listener that reads the resolved binding from prefs and `stopPropagation`s only when it actually claims the key — so a shared chord can mean different things by context (the settings "conflict" note on such a pair is expected, not a bug).
- **Help modal** (`ShortcutsHelpDialog`, ⌘/ = `open-shortcuts`): read-only searchable cheat sheet grouped by `GROUP_ORDER`. Its **Edit** button closes it and jumps to Settings → Shortcuts (`ShortcutsSection`), which records a new combo per row via a capture-phase recorder, flags clashes (`bindingSignature`), and resets to factory.
- **Glyph styling**: `bindingGlyphs(b)` returns ordered chips `["⌥","⇧","⌘", key]`; `keyGlyph` renders the key (`1…9`, arrows, uppercase letters, punctuation). The **help modal** shows the raw mac glyphs (⌘ ⌥ ⇧ ↑) for the compact look; the **settings editor** spells them out platform-aware via `glyphLabel` (Cmd/Ctrl, Option/Alt) since the bare symbols read like hieroglyphs. `IS_MAC` / `CMD_LABEL` / `ALT_LABEL` drive the labels. `isValidBinding` requires Cmd/Ctrl or Option so a binding can't swallow ordinary typing.

## React/Zustand bear traps

1. Don't return new objects/arrays from selectors without memo. Use frozen constants for defaults; `find` results are stable while the array is.
2. Async setup in `useEffect` with cleanup — never in component bodies.
3. Effect deps should be stable IDs (`ws.id`, `tab.id`) — never the ws/tab objects (identity changes every patch).
4. React 19 strict mode is off. Audit before re-enabling.

## Sandbox (`src-tauri/src/sandbox.rs` + `WorkspaceSandboxDialog`)

Per-workspace macOS sandbox-exec (Seatbelt) + per-workspace in-process HTTPS CONNECT proxy (`src-tauri/src/proxy.rs`). Configured per-project (defaults), pinned per-workspace at creation, **editable post-creation** with a forced PTY restart.

**Scope (do NOT confuse)**: ONLY the agent CLI's PTY is sandboxed. The aux/scratch terminal (`AuxTerminal`), setup script, run script, and archive script all run **unsandboxed by design** — they're explicit user-authored shell that needs full reach (`gh pr create`, `kubectl apply`, `docker build`). The agent is the threat model; everything else is the user. The "no sandbox" carve-out is enforced by simply not passing `workspace_id` in `pty_spawn` / by routing scripts through the separate `run_script` codepath that never calls `sandbox::provision`.

**Layered model**:
1. `sandbox-exec -f <profile.sb>` — kernel seatbelt. SBPL profile rendered per spawn under `$TMPDIR/termic-sandbox-<wsId>.sb`. Allows broad `file-read*`, narrow `file-write*` on workspace + agent dirs + caches; secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.config/gh/hosts.yml`, Keychains) ALWAYS denied; `(deny network*)` except loopback to the per-workspace in-process proxy.
2. Per-workspace **in-process CONNECT proxy** on an OS-assigned free port (Rust thread inside the Tauri binary — no external daemon). Regex hostname allowlist baked into Rust per CLI: claude→anthropic, gemini→google, codex→openai + baseline (github, npmjs, pypi, crates.io, CA OCSP) + workspace-specific extras. Non-matching hostnames get HTTP 403. Thread + listener stop via `SandboxBundle::Drop` when PTY teardown removes the slot.

**Pinning & edit**: `Workspace.sandbox_enabled` is captured at create time. Edit later via `workspace_set_sandbox` IPC, which persists the new lists AND SIGKILLs every live PTY for that workspace (otherwise the running process holds the OLD profile's permissions — the exact thing we're enforcing against). `WorkspaceSandboxDialog` warns before save.

**YOLO interaction (critical)**: when `ws.sandbox_enabled`, spawn args always include the CLI's `yolo_args` regardless of the global YOLO toggle — the seatbelt is the real boundary, so the agent's own permission prompts are friction. Toolbar `Zap` button visualizes safety: OFF→gray, ON+sandboxed→green, ON+UNsandboxed→**red, pulsing, ⚠️ tooltip**. Code is in `UnifiedBar.tsx` near the YOLO button.

**Default sets** are baked into Rust (`builtin_rw_paths` / `builtin_deny_paths` and the per-CLI `render_filter` block in `sandbox.rs`). The Project's `sandbox_*` fields are *extras only*, seeded into a workspace at creation. Surfaced read-only in the dialog's "Built-in defaults" details/summary so users don't waste lines re-typing them.

**Recent denies** debugging: `workspace_recent_denials(id, minutes?)` IPC shells out to `log show --predicate '...' --last <N>m` filtered to the workspace path and lines containing `deny`. Surfaced in the sandbox dialog under a lazy-load `<details>` — when `npm install` silently fails inside a sandbox, this is the only sane way to diagnose what was blocked.

## Automation bridge (`automation.rs`, dev-only)

Agent-driven E2E against the LIVE app (tauri-driver has no macOS support). Armed only when debug build + `TERMIC_AUTOMATION=1`: localhost HTTP server, port+token printed to the debug log (`[automation] listening`). Routes: `POST /eval` (body = async-function body, runs in the webview, returns `{ok,value}` - `window.__termic` exposes the zustand stores + ipc wrappers, dev bundles only), `GET /screenshot`, `POST /raise?on=1|0` (always-on-top + all-Spaces + fullscreen-auxiliary + app activation), `POST /quit`, `GET /info`. Isolation seams: `TERMIC_DATA_DIR` (scratch profile) + `PORT` (parallel vite). `scripts/fake-agent.sh` registers as a custom agent so spawn/resume/queue flows are testable without burning real-agent tokens.

Operational rules (learned the hard way): tear down by SIGTERM-ing dev.mjs (its sweep reaps the whole tree; `/quit` alone leaves vite on the port). Never touch src-tauri/ while a driven instance runs - the watcher restart strands the old app process. Occluded/other-Space windows report `visibilityState=hidden` and FREEZE rAF: PTY spawns survive this only because TerminalPane's rAF gate has a timeout fallback (do not remove it); prefer store/DOM assertions over screenshots (those also need Screen Recording TCC for the dev binary). Frontend edits: eval `location.reload()`. The full agent playbook (launch, worked example, teardown rules) lives in `.claude/skills/e2e/SKILL.md` - committed; Claude Code picks it up as the `e2e` skill.

### End-to-end testing (lazy - load the skill, don't improvise)

The full recipe (isolated launch, readiness polling, eval/assert examples, fake-agent registration, raise/screenshot, teardown) lives in the **`e2e` skill** (`.claude/skills/e2e/SKILL.md`). A persistent, pre-seeded profile lives at `.e2e/` (gitignored): fixture repo + fakeagent already registered - launch against it, don't re-seed from scratch. Load it when the user asks to verify something in the live app, OR before claiming victory on changes that impact UI flows (workspace create/archive, PTY spawn/resume, tab/sidebar interactions, dialogs). Don't paste-from-memory variants of its commands: the skill encodes hard-won teardown and ownership rules whose violation strands processes or kills the user's own session. Note the driven app is a real, visible GUI window on the user's screen (isolated profile; usually unfocused - `POST /raise?on=1` floats it).

## AI Code Review (`ReviewDialog`)

User picks a CLI → spawn a fresh terminal tab in the workspace → wait for the PTY id → `ptyWrite` the **verbatim review prompt** (`lib/review.ts`) + `\r`. Prompt has a baked-in `git diff` fallback — agent fetches its own diff; we don't pre-inject it.

## Debug log

Rust `log_line(msg)` appends to `<tempdir>/termic-debug.log` (on macOS that's `/var/folders/.../T/`, NOT `/tmp`):

```sh
python3 -c 'import tempfile; print(tempfile.gettempdir() + "/termic-debug.log")'
```

Dev process logs go to `/tmp/termic-dev.log` if started via `npm run tauri:dev > /tmp/termic-dev.log 2>&1 &`. `window.error` + `unhandledrejection` are wired in `main.tsx` to forward to `log_line` via IPC — WKWebView's JS console is otherwise isolated.

## Common gotchas (encountered, fixed — don't reintroduce)

- **Window opens tiny.** `tauri-plugin-window-state` restores prior size before min-size kicks in. Reset: `rm "<data_local_dir>/com.simion.termic/.window-state.json"` (macOS: `~/Library/Application Support/com.simion.termic/.window-state.json`).
- **Window on wrong monitor + huge.** `position_on_cursor_monitor()` in the setup hook + `visible: false` + `show()` after positioning.
- **Terminal blank.** Payload shape — see Critical IPC shapes.
- **Terminal "ribbons" in TUIs.** lineHeight ≠ 1.0 or WebglAddon not loaded.
- **WebGL crash (`_isDisposed`)** on tab switch — webglAddon disposed after term.dispose(). Fix order is canonical now.
- **`document.fonts.check()` lies in WKWebView.** Canvas-measurement against TWO baselines (monospace + serif) instead.
- **Theme picker flicker** — Radix DropdownMenu has cursor-transit gaps. Use HoverCard with `sideOffset=0`.
- **Toggle knob escapes track.** Hardcode geometry, don't lean on Tailwind transform classes.
- **Footer collapses, files overflow.** Grid needs `gridTemplateRows: "minmax(0, 1fr)"`. Default `auto` lets file list push footer off-screen.
- **`pty_spawn` "invalid length 0"** — payload wrap forgotten.
- **Right-click contextmenu** — `window.addEventListener("contextmenu", e => e.preventDefault())` in `main.tsx`.
- **App icon missing in dev** — dev runs raw binary, not `.app` bundle. Custom icon appears only after `npm run tauri:build`.

## Copy / typography rules

- **No em dashes (—) anywhere on the website or in the app.** Applies to all
  user-visible text: marketing copy on `termic.dev`, dialog/toast/tooltip
  strings, button labels, JSX/HTML text content, the in-app Changelog
  summaries and notes (`changelog.json`), error messages. Use a comma, a
  period, parentheses, or a colon instead. Comments in source files are not
  user-visible and are exempt, but prefer rewriting them too so the convention
  doesn't leak into copy via copy-paste.

## What NOT to do without asking

- Switch the editor away from CodeMirror 6 (slower in WKWebView, verified).
- Re-enable React StrictMode (reintroduces async PTY race).
- Add a server/backend daemon — app runs entirely on-device.
- Embed Monaco (~5MB cold-start regression).
- Bundle config/settings in source — config lives in user dirs only.
- Force subpixel font smoothing (fringing on dark).
- Make any IO-heavy Tauri command synchronous (freezes the Mac).
- Sandbox the aux terminal, setup script, run script, or archive script. These are explicit user-authored shell with the user's full reach by design; only the agent CLI's PTY is the threat model.
- Expose a mutator for `Workspace.sandbox_enabled` that doesn't SIGKILL the matching live PTYs by default. The kill is the security boundary. The dialog's "Save without restart" button (`workspace_set_sandbox` with `kill_live=false`) is an explicit, confirmed escape hatch — the user is warned that the running agent retains its OLD profile until respawn. Don't make this the default; don't drop the warning.
