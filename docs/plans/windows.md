# Windows support (audit + plan)

Status: **proposed, not started. Nothing here has been compiled on Windows.**

Every line reference below came from reading the tree on 2026-07-27, not from
running a Windows build. That distinction matters: the compile-error list in
"Tier 1" is a prediction. The first real deliverable is replacing it with the
compiler's own output.

Goal: a Windows build that runs agents in worktrees with terminals, editor and
diff, at parity with macOS minus the sandbox.

Non-goal: parity *including* the sandbox. Seatbelt has no Windows equivalent
worth reimplementing (see "The sandbox decision").

## The short version

**The app does not compile on Windows today**, and it fails before `rustc` is
even reached. Beyond that: ~12 predicted compile errors, four subsystems that
need redesign rather than porting, and two silent correctness bugs that no
existing test would catch.

Rough shape, offered as order-of-magnitude and not as a commitment:

| Milestone | Estimate |
|---|---|
| Compiles and launches | ~1 week |
| Feature-comparable minus sandbox | ~3-4 weeks |

## What already works

Worth stating first, because it is more than expected and most of it is
deliberate rather than lucky.

- **`proxy.rs`** (665 lines) is genuinely platform-neutral: `std::net`, no
  `libc`, no `os::unix`. The file header says the `tinyproxy` child was replaced
  precisely to make this portable. It ports for free.
- **portable-pty 0.8** resolves `NativePtySystem` to ConPTY on Windows.
  `openpty` / `spawn_command` / `resize` (`lib.rs:1465-1472, 1607, 1828`) need
  no changes.
- **`open_command` (`lib.rs:7821`) and `reveal_command` (`lib.rs:5983`) already
  have real Windows arms**, with a comment explaining why `explorer` beats
  `cmd /C start`.
- **`data_dir()` (`lib.rs:557`)** uses `dirs::data_local_dir()`, so
  `%LOCALAPPDATA%\termic`. `repoint_task_bases` (`lib.rs:618`) already uses
  `MAIN_SEPARATOR`.
- **Updater config is already Windows-aware**: `plugins.updater.windows.installMode`
  is set, `createUpdaterArtifacts` and the minisign pubkey are platform-neutral,
  and `bundle.icon` already carries `icon.ico`.
- **macOS-only Cargo deps are correctly target-gated** (`objc2`, `objc2-app-kit`,
  `objc2-foundation`), and most `cfg(target_os = "macos")` blocks have real
  `not(macos)` fallbacks (completion sounds, sound install, dock icon).
- **Font stacks have Windows faces**: `index.css:105` ends
  `"Cascadia Mono", Consolas, monospace`, `:138` carries `"Segoe UI"`. Both
  primary faces (JetBrains Mono, Inter Variable) are bundled via `@fontsource`.
- **`IS_MAC` already exists** (`shortcuts.ts:257`) and ~12 sites branch on it.
  Terminal copy/paste, the Option-as-Meta setting and completion sounds are
  already gated off-mac. (The GPU-renderer toggle is shown on every platform
  since GH #140; only its hint text branches on `IS_MAC`.)
- **The e2e architecture ports better than standard Tauri.** We use the embedded
  `tauri-plugin-wdio-webdriver` (`wdio.conf.ts:36`, `driverProvider: "embedded"`),
  not `tauri-driver`, so the WebDriver server travels inside the app. Specs drive
  the store via `window.__termic` rather than synthetic key events, so there are
  no `Key.Meta` sends to rewrite.

## Tier 1: does not compile

### The build fails first

`build.rs:80-83` joins the sidecar path as `.../termic-cli` with no `.exe`
suffix, so `fs::copy` panics before any Rust is compiled. `bundled_cli_path()`
(`cli_server.rs:2028`) has the same omission at runtime.

**Fix this before anything else.** It is the difference between guessing at the
error list and reading it.

### Predicted errors, once the build gets past `build.rs`

| What | Where |
|---|---|
| `os::unix::process::CommandExt` + `.process_group(0)` | `lib.rs:7199, 7338, 7431, 7510` |
| `os::unix::fs::symlink`, **10 unguarded sites** | `lib.rs:2319, 3012, 3080, 4600, 4630, 6316`, `cli_server.rs:2092` |
| `os::unix::net::{UnixListener, UnixStream}` | `cli_server.rs:34-35, 120, 166` |
| `os::fd::AsRawFd` | `cli_server.rs:1487` |
| `PermissionsExt` / `OpenOptionsExt` (0o600) | `cli_server.rs:174-176, 1473-1480` |
| `libc::kill`, 13 sites | see Tier 3 |
| `peer_uid()` has a macOS arm and a Linux arm and **no third arm**, so the body evaluates to `()` where `Option<u32>` is expected | `cli_server.rs:1486-1517` |

`libc` is an unconditional dependency in `Cargo.toml`. It should be
`[target.'cfg(unix)'.dependencies]`.

Note that the symlink sites are inconsistent rather than uniformly broken:
`lib.rs:814, 847, 6471` and `lib.rs:2751, 4568` *are* correctly guarded with
`cfg(not(unix))` arms. The pattern exists; it just was not applied everywhere.

## Tier 2: compiles, silently wrong

These produce no error and no crash. They are the expensive ones to find later.

- **`shell_env.rs:339, 343` splits and joins `PATH` on `':'`.** Windows uses
  `';'`, and `C:\...` contains a colon, so this actively corrupts a Windows PATH.
  Use `std::env::split_paths` / `join_paths`, which `cli_server.rs:2071` already
  does correctly.
- **`pick_shell` (`shell_env.rs:110-137`) falls back to `/bin/sh`.** Every
  terminal fails to spawn. The frontend mirrors the same fallback in
  `loginShell.ts:19`.
- **`probe_login_shell` (`shell_env.rs:243-249`)** runs `shell -ilc env`.
  `fallback_path` (`:314-345`) hardcodes `/opt/homebrew/bin`, `~/.cargo/bin` and
  friends.
- **`notify()` (`lib.rs:7724-7728`) shells out to `osascript` with no cfg gate.**
  Spawn fails, nothing is shown. `tauri-plugin-notification` is already a
  dependency and is already used correctly elsewhere (`ipc.ts:559`).
- **CLI discovery** (`lib.rs:8946`) runs `/usr/bin/env sh -lc "command -v ..."`,
  and the fallback probes (`lib.rs:8958-8965`) hardcode POSIX bin dirs with no
  `.exe` / `.cmd` / `PATHEXT` awareness. npm-installed `claude` / `gemini` /
  `codex` are `.cmd` shims on Windows.
- **`lib.rs:8936` uses `bin.starts_with('/')` as the is-absolute test**, which
  misses `C:\`. Should be `Path::is_absolute()`. Same at `:8952`.
- **`expand_tilde` (`lib.rs:679`, plus inline copies at `:1866` and `:2030`)**
  strips a hardcoded `"~/"`, so `~\repos\foo` never expands.
- **~30 TS sites hardcode `/` as the separator.** There is no path abstraction on
  the frontend at all. The visible ones: `TerminalPane.tsx:2947-2953` (the CWD
  breadcrumb tests `startsWith("/")`, so no Windows path is ever "absolute" and
  it never splits), `markdownPaths.ts:54-66`, `pathMatch.ts:5, 12`,
  `clipboard.ts:26-30`, `utils.ts:19, 32-34`, `closeTab.ts:20`,
  `loginShell.ts:24`, plus basename splits across `FileTree`, `GitPanel`,
  `DiffPane`, `EditorPane`, `TabBar`, `RightPanel`, `MarkdownPreview`,
  `FindInFilesDialog`, `TerminalPathMenu`, `reviewCommentsExt`.
- **`termLinkOpener.ts:36`** matches forward-slash paths only, so no Windows path
  in terminal output is ever clickable.
- **`terminalDrop.ts:57-59`** backslash-escapes dropped paths for a POSIX shell,
  which mangles a path that is already full of backslashes.
- **`IS_MAC` defaults to `true`** when `navigator` is undefined
  (`shortcuts.ts:258`), so unit tests silently exercise the mac path.
- **`mergeFontOptions` (`prefs.ts:353-359`)** exempts any stack matching
  `ui-monospace` from the installed-fonts filter, so "SF Mono" stays in the
  picker on Windows. One line, cosmetic.

## Tier 3: needs redesign

### 1. Process-group kill

`libc::kill(-pid, SIG*)` at `lib.rs:4303, 6910, 7304, 7306, 7396, 7459, 7542,
7579, 9376, 9385`, paired with `.process_group(0)` at spawn (`lib.rs:7338,
7510`). Single-pid kills at `lib.rs:1842, 4150, 9395`.

Windows has no process groups in this sense. `CREATE_NEW_PROCESS_GROUP` only
enables `GenerateConsoleCtrlEvent`; it does not give tree-kill. The answer is
**Job Objects** (`CreateJobObject` + `AssignProcessToJobObject` +
`TerminateJobObject`, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).

Two things are lost and need explicit decisions:

- **The graceful path.** `lib.rs:7304-7308` sends SIGTERM, then polls
  `kill(-pid, 0)` for up to 5s so a dev server can release its port before the
  respawn. `TerminateJobObject` is unconditionally forceful. Sending
  `CTRL_BREAK_EVENT` first is the closest analogue and is not equivalent.
- **The deadlock dodge.** `lib.rs:1839-1841` explains that raw `kill()` is used
  instead of `Child::kill()` to avoid deadlocking with the waiter thread that has
  the `Child` pinned in `wait()`. That constraint is real and survives the port,
  so Windows needs a stored duplicated `HANDLE`, not the `Child`.

### 2. The CLI control plane

`cli_server.rs` binds a Unix socket at `data_dir()/termic.sock`
(`:166`), chmods it `0o600` (`:174-176`), and authenticates every connection by
comparing `getpeereid` against `geteuid()` (`:232, 1486-1517`). The token file is
also `0o600` (`:1473-1480`).

Windows equivalent: a **named pipe** (`\\.\pipe\termic`) with
`GetNamedPipeClientProcessId` into a token-SID comparison, and the token file's
confidentiality re-expressed as a DACL rather than a mode.

`std::os::unix::net` is unavailable on Windows even though Win10 1803+ has
AF_UNIX, so `uds_windows` is the only "keep the socket" option. Named pipes are
the better fit because they carry peer identity natively.

**This is security-relevant.** Deleting the `chmod` and the `peer_uid` check to
make it compile silently removes the CLI's entire authn boundary. Do not let that
happen incrementally.

### 3. `bash -lc` script execution

`lib.rs:3300, 6550, 6588, 7312`. Every setup, run and archive script goes through
`bash -lc`. User scripts in `.termic.yaml` are POSIX shell by construction, so
this is not only a spawn-site change: existing user configs do not survive.

Options, in rough order of preference:
1. Depend on Git Bash (already present on any machine with Git for Windows) and
   keep one script dialect.
2. Add a per-script shell field and default to PowerShell on Windows.
3. Detect and dispatch.

Option 1 keeps `.termic.yaml` portable across machines, which matters because
these files are committed to user repos.

### 4. Window chrome

The entire chrome block at `lib.rs:9194-9198` (`TitleBarStyle::Overlay`,
`hidden_title(true)`, `traffic_light_position`) is inside
`cfg(target_os = "macos")`. On Windows the window gets stock decorations stacked
on top of our own 44px bar. Two title bars.

- `UnifiedBar.tsx:41` reserves `TRAFFIC_LIGHT_WIDTH = 84` on the **left**
  (applied at `:94`), where Windows has nothing. Nothing reserves the ~138px
  caption-button strip on the **right**, so every right-hand action icon sits
  under minimize / maximize / close.
- `App.tsx:188` uses `pt-10` to clear the titlebar gap. Wrong axis and value.
- `useIsFullscreen.ts` is documented as tracking *macOS* full-screen, with a
  350ms settle for the macOS zoom animation (`:24`). `isFullscreen()` works on
  Windows but what it feeds (reclaim traffic-light space) is meaningless there.
- `UnifiedBar.tsx:73-89` falls back to `startDragging()` because WKWebView
  ignores `data-tauri-drag-region`. WebView2 honors it, so the two mechanisms
  would race, and `startDragging()` breaks double-click-to-maximize on Windows
  because the mouseup is swallowed by the native drag loop.
- `WebkitAppRegion` inline styles in 8 places (`UnifiedBar.tsx:95, 102, 193`,
  `ui/Dialog.tsx:49, 97, 108`, `ShortcutsHelpDialog.tsx:67, 76`,
  `WelcomeDialog.tsx:134, 152`) are Electron-only and are a no-op in both
  WKWebView and WebView2. Dead code that reads like the mechanism.

Rounded corners (`lib.rs:9500-9540`, raw objc2) are compiled out and Windows 11
rounds via DWM, so that part is a non-issue.

## Windowless mode is macOS-only on purpose (CLI Phase 3)

Windowless mode (Close -> menu bar, Quit -> teardown) landed macOS-gated, so
the Windows port inherits a decision rather than a bug.

What is already gated to `target_os = "macos"` in `lib.rs`:

- The `CloseRequested` -> `enter_windowless` handler. **This is a semantic
  choice, not a compile constraint.** Close-keeps-running is a mac convention
  (Mail, Messages). On Windows and most Linux desktops closing the window is
  expected to QUIT, and silently turning that into minimize-to-tray is a
  default users resent. Windows keeps Tauri's native close until someone
  deliberately decides otherwise.
- `ActivationPolicy::Accessory` / `Regular` (dock-icon suppression). No
  Windows equivalent; the taskbar follows window visibility. Windows would
  instead want `skip_taskbar`.
- `RunEvent::Reopen` (dock-icon click). The variant does not exist off macOS
  in Tauri, so naming it unconditionally is a hard compile error - including
  on the Linux CI runner that already builds `cargo test --workspace --lib`.

What is NOT gated, and is expected to work everywhere:

- `--headless` boots straight into background. Coherent on every platform:
  the user explicitly asked for no window.
- The menu-bar/tray item (`tray-icon` feature). Builds on Linux via
  `libayatana-appindicator3-dev`, already in the CI apt list. `icon_as_template`
  is a macOS no-op elsewhere and `show_menu_on_left_click` is documented
  unsupported on Linux, so a Linux tray needs its menu checked by hand.
- The webview half (`termic://windowless` -> `MainArea` collapses panes). Pure
  DOM, no platform surface.

Decision left for the port: what Close should do on Windows. Options are keep
native close (current behavior), or minimize-to-tray behind an explicit
opt-in setting. Do not copy the mac default without deciding.

## Two silent bugs to fix before shipping anything

Neither produces an error, and no existing test covers either.

### The IME bridge would double-send every CJK character

`src/lib/ime.ts` is premised on "WebKit does not fire compositionstart/update/end,
`isComposing` stays false, `keyCode` is always 229" (`:1-33`). **Every one of
those premises is false in Chromium.**

The `!e.isComposing` guard at `:112` holds for most of a composition, but
Chromium fires `compositionend` *before* the final `input` event, and that event
has `isComposing === false` with `inputType === "insertCompositionText"`, which
is in `FORWARDED_INPUT_TYPES` (`:49`). So xterm's `CompositionHelper` forwards
the composed text on `compositionend`, and then `onInput` forwards it again.
Same class as issue #38 ("Hello" becoming "HelloHello").

`deleteContentBackward` / `deleteContentForward` (`:52-53`) leak the same way,
because `TerminalPane.tsx:588` returns `false` for `keyCode === 229` and so skips
xterm's own keydown handling entirely.

**Fix: make the bridge a no-op off WebKit**, and drop the `keyCode === 229`
short-circuit at `TerminalPane.tsx:588` / `AuxTerminal.tsx:141` on Windows, where
xterm's native path is the correct one.

### The Ctrl fold eats terminal keys

`shortcuts.ts:216-224` is our own TODO on this. The modifier model folds Cmd and
Ctrl into one `cmd` flag, which is what makes every shortcut fire on Windows for
free, but `Ctrl+W`, `Ctrl+K`, `Ctrl+T`, `Ctrl+P`, `Ctrl+A`, `Ctrl+B` are readline
keys. The guard that saves macOS (`useShortcuts.ts:92`) is `IS_MAC &&`-gated and
therefore inert on Windows: with focus in a terminal, the app swallows all of
them before the PTY sees them.

`Ctrl+C` is safe only by accident (copy defaults to `Ctrl+Shift+C`,
`shortcuts.ts:142`).

Related, and not yet handled anywhere: **AltGr**. Chromium reports AltGr as
`ctrlKey && altKey`, and `bindingMatches` (`:225`) cannot tell them apart. So
`Ctrl+Alt+P` (prompt palette, `:167`), `Ctrl+Alt+B` (`:162`) and the
`Ctrl+Alt+arrow` task bindings (`:92-95`) fire when a German or Polish user types
a legitimate character.

Also: `ShortcutsHelpDialog.tsx:122` renders raw glyphs via `bindingGlyphs`
(`shortcuts.ts:301-308`, which unconditionally pushes `⌥ ⇧ ⌘`), while
`ShortcutsSection.tsx:181` correctly routes through `glyphLabel`. So Settings
says "Ctrl" and the help modal says "⌘" for the same binding. Plus 12 hardcoded
`⌘` strings in copy: `Sidebar.tsx:1680`, `TabBar.tsx:282, 304, 320`,
`RightPanel.tsx:868`, `EditCommandDialog.tsx:84`, `CustomCommandDialog.tsx:135`,
`ResumeOverrideDialog.tsx:119`, `closeTab.ts:25`, `SandboxSection.tsx:77`,
`PromptLibrarySection.tsx:189`, `shortcuts.ts:123, 129, 149`. And two hardcoded
"Finder" labels that bypass the existing `FILE_MANAGER` abstraction
(`Sidebar.tsx:1169`, `UnifiedBar.tsx:322`).

## The sandbox decision

`sandbox.rs` is 2905 lines of Apple Seatbelt: SBPL profile rendering, `/bin/ps`
ancestry filtering, `log stream` deny tailing, macOS path roots, the
`/tmp -> /private/tmp` firmlink dance. There is no Windows analogue short of
AppContainer plus restricted tokens plus WFP, which is a from-scratch security
subsystem, not a port.

It is already gated: `available()` (`sandbox.rs:1477-1479`) returns false off
macOS and the comment says so explicitly, and `provision()` (`:1657-1662`)
hard-errors early.

**But it sits on the main path.** `pty_spawn` (`lib.rs:1493-1515`) calls
`provision()` for any task whose mode is not `Off`, logs the failure, and
**spawns unsandboxed**. So a Windows build would run every agent uncaged while
the UI still renders the shield affordance.

Two things must happen together:

1. The frontend gates the sandbox UI on a `sandbox_available()` IPC rather than
   assuming availability.
2. `docs/sandbox.md` states plainly that Windows ships unsandboxed.

The CONNECT proxy compiles and runs on Windows, but note it is only *reached*
because `wrap_command` (`sandbox.rs:1725-1799`) injects `http_proxy` into the
sandboxed command line. Without the sandbox the proxy is a suggestion, not a
cage. Do not present it as network confinement on Windows.

## Testing, given the dev machine is Apple Silicon

Apple Silicon cannot virtualize x86-64 at all (Hypervisor.framework is ARM64
guests only). So:

- **CI on `windows-latest` is the only free real amd64 execution**, and it is
  where the compile-error list should come from. Free for public repos.
  `windows-11-arm` runners are also free for public repos if a matrix is wanted.
- **Local loop: Windows 11 ARM64 in Parallels or VMware Fusion.** Everything in
  this document is OS-level rather than arch-level, so an ARM64 guest exercises
  essentially all of it. x64 binaries run under Prism emulation if needed, but
  emulated timings are not a perf signal.
- **Perf claims require real amd64 hardware.** Given this project's standards
  ("a 1-frame terminal flicker is a real regression"), a cheap x64 mini PC is the
  only honest way to sign off on Windows performance. Buy it only if Windows
  becomes supported rather than experimental.

CI additions needed: a `build-windows` job in `release.yml` (which today has only
`build-mac` on `macos-26` and `build-linux` on `ubuntu-22.04`), plus code signing
before an installer can ship. `bundle.targets: "all"` yields NSIS + MSI on
Windows, and there is no `bundle.windows` block yet, so at minimum
`webviewInstallMode` needs setting.

The e2e suite needs `wdio.conf.ts:17` to add `.exe`, `package.json:26` to stop
using a POSIX env prefix (use `cross-env`), and `scripts/fake-agent.sh` to gain a
Windows sibling. `docs/e2e-tests.md:63, 67` need updating.

The **Makefile is a rewrite, not a port**: Homebrew is hard-required at 10 sites,
plus `.app`/`.dmg` bundles, `/Applications` install/uninstall, `osascript` quit,
and a `pkill -f /Applications/Termic.app/...`. GNU Make is not on stock Windows.
The `e2e` target (`:143-153`) is thin enough to move into npm scripts; the rest
needs a parallel PowerShell path.

## Phasing

| Phase | Work | Ships |
|---|---|---|
| 0 | Fix `build.rs` `.exe`; add `windows-latest` `cargo check` to CI | nothing visible; **replaces this document's Tier 1 guesses with facts** |
| 1 | Gate `libc` to `cfg(unix)`; Windows arms for symlinks, modes, `CommandExt`; stub `peer_uid` | it compiles |
| 2 | Job Objects for process/tree kill; named-pipe control plane; shell + PATH handling | it launches and runs an agent |
| 3 | Window chrome; IME bridge gating; Ctrl-fold and AltGr; path handling in TS | it is usable |
| 4 | `sandbox_available()` gating + docs; script-shell decision | it is honest about what it does not do |
| 5 | `build-windows` CI job, signing, NSIS/MSI config, updater platform key | it installs and updates |

Phase 0 is an afternoon and should happen whether or not the rest is ever built,
because it converts an estimate into a list.

## Open questions

- **Is Windows a supported platform or an experiment?** This changes the answer
  to signing (an EV cert is an annual cost and a procurement problem), to whether
  amd64 hardware gets bought, and to whether Phase 5 exists at all.
- **Script dialect.** Git Bash keeps `.termic.yaml` portable across machines,
  which matters because those files live in user repos. PowerShell is more native
  and more discoverable. Decide before Phase 2, because it is a file-format
  decision, not an implementation detail.
- **Symlinks require Developer Mode or `SeCreateSymbolicLinkPrivilege`** on
  Windows. Directory junctions do not, and cover the multi-repo composition case
  (`lib.rs:2319, 3012, 3080`), but not the agent-config file links
  (`lib.rs:4600`). Copy-instead-of-link is the fallback, and it silently changes
  semantics when the source file is edited. Decide per site.
- **Does anyone actually want this?** No Windows demand is recorded anywhere in
  the repo. This audit exists because the question was asked, not because a user
  asked for the platform. Worth confirming before Phase 1.
