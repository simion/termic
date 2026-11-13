# Written end-to-end tests (WebdriverIO)

Automated, repeatable e2e tests that launch the **real** Termic window, click
through real flows, and assert on live state. Purpose: catch regressions when
a feature changes. These are the *written* counterpart to the ad-hoc
[automation bridge](automation.md) / [`e2e` skill](../.claude/skills/e2e/SKILL.md)
(which stays, for agent-driven one-off verification).

## Why WebdriverIO (and not a home-grown harness)

Termic on macOS renders in **WKWebView**, which exposes no Chrome DevTools
Protocol and no native WebDriver, so stock Playwright/Selenium can't attach.
The one established framework with a native macOS path is **WebdriverIO** via
`@wdio/tauri-service`'s *embedded* provider: the Rust crate `tauri-plugin-wdio`
embeds a W3C WebDriver server inside the webview, and WebdriverIO speaks to it.
Real framework, standard API (`$`, `waitUntil`, auto-retrying `expect`), real
window, real screenshots. We did not invent a test framework.

## Zero production footprint

Everything test-only is behind a Cargo feature, `e2e`:

- `src-tauri/Cargo.toml` — `tauri-plugin-wdio-webdriver` is an **optional**
  dep; `[features] e2e = ["dep:tauri-plugin-wdio-webdriver"]`.
- `src-tauri/src/lib.rs` — the plugin registration
  (`tauri_plugin_wdio_webdriver::init()`) is `#[cfg(feature = "e2e")]`. The
  plugin exposes no IPC commands and starts only an HTTP WebDriver server, so
  it needs **no** capability/ACL entry — `capabilities/default.json` is
  untouched.
- All npm packages are `devDependencies`.

A normal `npm run tauri:dev` and every release build contain **none** of it:
no plugin, no WebDriver server. (`cfg(debug_assertions)` can't gate a
dependency — Cargo ignores it with a warning — which is why this is a feature,
not a profile check.)

Note on the npm side: `@wdio/tauri-service@1.2.0` ships a broken pin
(`@wdio/native-utils@2.4.0`) but imports a symbol only present in 2.5.0, so
`package.json` carries an `overrides` bumping `@wdio/native-utils` to `2.5.0`.
Revisit when the tauri-service fixes its pin.

## Run it

```sh
make e2e              # build the --features e2e binary + run the whole suite
# or, à la carte:
npm run e2e:build     # VITE_E2E=1 tauri build --debug --no-bundle --features e2e
npm run test:e2e      # wdio run ./wdio.conf.ts (skip the rebuild while iterating on specs)
```

`e2e:build` produces a self-contained debug binary at
`src-tauri/target/debug/termic` (embedded frontend, so no vite server needed at
test time). Rebuild it after any Rust or frontend change. Screenshots land in
`.e2e/artifacts/` (gitignored). Do NOT build the e2e binary with a bare
`cargo build` — that bakes in the dev-server URL and the window comes up blank
(`about:blank`); always go through `e2e:build` / `make e2e`.

The e2e binary is built with `VITE_E2E=1`, which exposes `window.__termic`
(stores + ipc + invoke) so specs can read real app state and drive real IPC.
That flag is unset in normal `npm run build`, so real release bundles still
tree-shake `__termic` out.

Tests run **on a real Mac only** — they launch a GUI window.

On Linux the same commands work, on your own desktop or headless the way CI
does it (`scripts/setup-linux.sh` with `WITH_E2E=1` installs Xvfb):

```sh
dbus-run-session -- xvfb-run -a -s "-screen 0 1440x900x24" npm run test:e2e
```

On a Wayland desktop also pass `env -u WAYLAND_DISPLAY GDK_BACKEND=x11`, or
GTK ignores the virtual display and opens every window on your real one.

**Against a packaged AppImage.** `TERMIC_E2E_BINARY` can name an e2e AppImage
instead of the bare binary, and the whole suite then drives the app in the form
users run it, which is the only way to see an AppImage-only bug (the
bundled-library environment reaching agents was one):

```sh
node scripts/tauri-env.mjs VITE_E2E=1 -- build --debug --features e2e --bundles appimage \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
TERMIC_E2E_BINARY=$PWD/src-tauri/target/debug/bundle/appimage/Termic_<version>_amd64.AppImage npm run test:e2e
```

It takes about twice as long. Three cases in `settings.e2e.ts` key off it: the
desktop-entry row must be ABSENT on the bare binary, and on an AppImage it must
add and remove a correct entry, and an agent's environment (read from `/proc`)
must carry nothing from the image's mount.

**With a window manager.** Xvfb alone has none, which is why maximize and
minimize are skipped on the Linux CI job. Put one on the display and
`window-chrome.e2e.ts` runs them on Linux too (it looks for EWMH's
`_NET_SUPPORTING_WM_CHECK`), and the real-key spec is exercised with focus
managed the way a desktop manages it:

```sh
dbus-run-session -- xvfb-run -a -s "-screen 0 1600x1000x24" \
  sh -c 'openbox & sleep 1; npm run test:e2e'
```

Give openbox a config with an empty `<keyboard>` section, or its own default
bindings (Super+D, Ctrl+Alt+arrows) take chords the spec is trying to press.

The run gets its own `XDG_DATA_HOME` and `XDG_CACHE_HOME` under
`.e2e/profile/` (`wdio.conf.ts`). `TERMIC_DATA_DIR` alone is not isolation on
Linux: WebKitGTK keeps localStorage, which is every pref, under
`$XDG_DATA_HOME/<app identifier>` keyed by origin, and every built binary
shares one origin. Before this the suite read the prefs of the Termic
installed on the same machine (a hidden right panel failed every file-tree
spec) and wrote its own into it. CI never saw it because a runner has no
installed Termic. Windows has the same hole and the same fix
(`WEBVIEW2_USER_DATA_FOLDER`).

`make e2e` and `make dev` both write `src-tauri/target/debug/termic`, so the
two cannot run side by side. To run the suite beside a live dev app, build the
e2e binary elsewhere and name it:

```sh
CARGO_TARGET_DIR=$PWD/src-tauri/target/e2e-build npm run e2e:build
TERMIC_E2E_BINARY=$PWD/src-tauri/target/e2e-build/debug/termic npm run test:e2e
```

### The README's screenshots

`docs/hero.png` and `docs/screenshots/*.png` come from
`e2e/specs/readme-shots.e2e.ts`, which the suite skips unless asked for. It
stages three `acme-*` demo repos and a handful of tasks in every state, with
agents labelled claude and codex that run `e2e/fixtures/readme-agent.sh`, so
nothing on screen comes from a real machine. Each shot is refused if the page
text holds the home path, user name or host name. To retake them after a
`make e2e`:

```sh
TERMIC_E2E_README_SHOTS=1 npm run test:e2e -- --spec e2e/specs/readme-shots.e2e.ts
sips -Z 2000 .e2e/artifacts/readme-hero.png --out docs/hero.png
for n in markdown-review scheduled; do
  sips -Z 2000 .e2e/artifacts/readme-$n.png --out docs/screenshots/$n.png
done
# The board's cards fill the top of the window: keep the top 60%.
# (--cropOffset 0 0 means "centred" to sips; 1 1 anchors the top.)
sips -c 1080 2880 --cropOffset 1 1 .e2e/artifacts/readme-board.png --out /tmp/board.png
sips -Z 2000 /tmp/board.png --out docs/screenshots/board.png
```

The window is 1440x900. The driver's `setWindowSize` counts physical pixels,
so the spec asks for twice that on a 2x display.

## CI

The suite runs on all three platforms for PRs and pushes to `main`: `e2e`
(`macos-26`; `macos-14` was retired in 2026-11) and `e2e-linux` (WebKitGTK under Xvfb, `ubuntu-22.04`) in
`.github/workflows/test.yml`, and the Windows job (WebView2) in
`.github/workflows/windows.yml`. Specs for a feature a platform does not have
are excluded in `wdio.conf.ts` (Touch ID off macOS). None is a **required check yet**: they are there to
surface flakiness under CI so we can harden it before gating merges. The
gitignored `.e2e/` fixture profile is recreated by `node scripts/e2e-seed.mjs`
(templates in `scripts/e2e-seed/`); screenshots are skipped when `CI` is set
(the `snap()` helper). Artifacts upload on failure. To promote it to required,
add it to branch protection once it's proven stable over ~20-30 runs.

## Isolation

`wdio.conf.ts` points the launched app at a throwaway `TERMIC_DATA_DIR`
(`.e2e/profile`, the same seeded profile the `e2e` skill uses: `welcomed=true`
+ the `fixture-repo` project + the zero-token `fakeagent`). A run never touches
your real `termic_dev` data. Agent flows use `fakeagent` (`scripts/fake-agent.sh`)
so no real tokens are spent.

Worktree tasks land in `.e2e/tasks/` and **nowhere else**. They used to be
created under `~/termic_dev/tasks/fixture-repo`, mixed in with the developer's
own dev tasks, where nothing could safely clean them up: a run killed mid-spec
left a worktree behind, and every later run then failed on `a worktree already
lives at …` (or, once the directory was gone but the registration was not,
`branch … is already checked out elsewhere`). `seed()` now wipes that directory
and prunes the fixture repo's worktrees on every run.

A run launched from an agent tab is isolated from that tab too. `onPrepare`
drops every inherited `TERMIC_*` except `TERMIC_E2E_*` (they name the outer
app's task, tab and sandbox, and a spec's `termic-cli` would act on them), and
picks a free WebDriver port unless `TAURI_WEBDRIVER_PORT` is set. The plugin's
default is a fixed 4445, so two agents running the suite at once drove each
other's app and both runs died on `ECONNREFUSED`.

**It refuses to run inside an enforcing Termic cage.** The cage denies the
app's WebKit storage (`~/Library/WebKit/termic`), the real spawn base
(`/private/tmp/termic-<uid>`) and `~/.config/termic`. A caged run measured on
2026-11-12 took 38 minutes and failed 19 of 48 spec files, none of them a
regression, so `wdio.conf.ts` now throws at load with the reason. Run it from
an unsandboxed shell. Making it pass caged needs a per-run WebKit store, an e2e
spawn base and a themes dir override; until then the refusal is the honest
answer.

### The language: an e2e build defaults to English, and writes no pref

The suites assert on English catalog text ("Dashboard", the open-with toast),
and the app's language pref defaults to `system`, which follows
`navigator.language`. On a zh-CN machine every user-visible string rendered in
Chinese and those assertions failed in a way no code change caused — which is
why `src/lib/i18n.ts` defaults the pref to `en` when `VITE_E2E` is set and
nothing is stored. An explicit choice from the settings picker still wins, in
both builds.

It defaults rather than **writes** because the app data dir is not the only
store an e2e run touches: the WebView's `localStorage` lives under the app
identifier (`com.simion.termic`), shared by an installed build and an e2e
binary on the same machine. A written pin would have switched the user's own
app's language. Same reason a spec that flips a localStorage-backed pref
should restore it afterwards — `recentTasks` is shared the same way.

### Windows: the staged sidecar must be the DEBUG one, or every `runCli` dies

`runCli` passes `TERMIC_DATA_DIR`, and the CLI honors it **only in a debug
build** (`cfg!(debug_assertions)`, `termic-cli/src/client.rs`) — a release
sidecar looks in the real app's data dir, finds no socket there, and every
`--no-launch` call fails with "Termic must be open", taking down every
describe that drives the CLI (task groups, spawn links) with cascading
`undefined` failures after the first one. The app side is fine; only the CLI
is misdirected.

Which sidecar lands in `src-tauri/binaries/` is a race between two writers:
`beforeBuildCommand` stages a **release** one (`scripts/build-cli.mjs`, right
for bundling), and `src-tauri/build.rs` re-stages one matching the app's
profile — debug for `npm run e2e:build` — but only when cargo actually reruns
the build script. A FRESH checkout always reruns it and lands debug, which is
why CI never sees this; an incremental machine can skip it and keep the
release one `beforeBuildCommand` just wrote. Symptom check: the staged
`termic-cli-<triple>.exe` is ~2.6MB (release), not ~4MB (debug). Fix:

```sh
cp src-tauri/target/debug/termic-cli.exe \
   "src-tauri/binaries/termic-cli-x86_64-pc-windows-msvc.exe"
```

It also deletes every branch but `main` in the fixture and its bare origin
(then `fetch --prune`), keeping any branch a worktree still has checked out.
Archiving a worktree task keeps its branch, so each local run added a few
dozen and nothing removed them; at ~1000 the New Task branch picker (capped at
100 choices) no longer listed the branch the "check out an existing branch"
spec pushes for itself, and that spec failed on every developer machine while
CI, a fresh checkout each time, stayed green. This only happens through
`make e2e` / the seed script: `npm run test:e2e` alone skips it.

Window frames are isolated too. `tauri-plugin-window-state` files its saved
sizes and positions under the bundle IDENTIFIER, and the e2e and dev builds
share the release one, so all three used to share one file: a run restored
whatever frame the installed app last had (a main window on an unplugged
monitor failed seven spec files at once) and wrote its own back into it (a
188x90 profile window). `window_state_filename()` in lib.rs gives the e2e and
dev builds their own files, and the seed deletes the e2e one so every run
starts at the default size.

The task RECORDS are swept separately, by `wdio.conf.ts`'s `onPrepare` — that
runs on every `test:e2e`, including runs that skip the seed script.

The seeded `fixture-repo` carries an `origin` remote (a sibling bare repo,
`.e2e/fixture-repo-origin.git`) so `origin/main` resolves like a real cloned
checkout. This matters because the project default base is `origin/main`: any
worktree spawn that honors it (a plain New Task, and every Agent Race racer)
would otherwise die with `git branch ... origin/main → not a valid object name`.
A spec that repoints origin (e.g. `git.e2e.ts`'s commit-push) MUST restore the
seeded origin in teardown, or the later `agent race` test loses its base.

**A spec that commits must commit something NEW.** `make e2e` reseeds, but
`npm run test:e2e` on its own does not, so the fixture repo carries the last
run's commits. `git.e2e.ts` used to write a fixed `history-probe.txt` with
fixed contents: on the second bare run `git add` staged nothing, `git commit`
exited non-zero, and the `execSync` throw took the whole describe with it (four
failures, none of them about what they claimed to test). Both the file name and
the subject are stamped now. The general rule: anything a spec commits should
be unique per run, and any assertion that a file is an ADD in that commit is
only true while the name is.

## Writing a test for a new feature

The full authoring workflow lives in the **`e2e` skill**
(`.claude/skills/e2e/SKILL.md`) — load it when adding or updating tests. In
short: one spec file per feature area under `e2e/specs/*.e2e.ts`, one `it` per
user-observable outcome, built from the shared helpers in `e2e/helpers.ts`
(`waitForAppShell`, `clickByText`, `waitForText`, …). Read real state via
`window.__termic` rather than scraping the DOM.

The non-negotiable stability rules (this is what keeps the suite from going
fuzzy):

1. **Never sleep.** No `setTimeout`/fixed waits. Use `browser.waitUntil(...)`
   or an auto-retrying `expect(...)`. Every wait is a *condition*, not a
   duration. If you are about to write `browser.pause(n)`, name the thing you
   are waiting for and poll THAT: the pane leaving the DOM
   (`waitTaskUnmounted`), the tab reaching the front (`waitTabInFront`), the
   host's own list emptying (`invoke("lsp_list")`). A duration that is long
   enough on your Mac is a coin flip on a loaded CI runner, and it is slower
   every run in exchange.

   **The one legitimate `pause`** is a wait whose subject IS time: proving
   something did NOT happen (a negative assertion needs a window for the
   thing to fail to happen in), or outlasting a timer the app itself owns (a
   500 ms debounce, `SURVIVE_MS`, a grace period). Those read as
   `await browser.pause(GRACE_MS * 2)` next to a comment saying which clock
   is being outlasted. Everything else is a condition you have not named yet.
2. **Assert on state, not pixels.** Screenshots are for humans to eyeball, not
   for assertions. Assert DOM text/attributes, or app state.
3. **Terminal content is NOT in the DOM.** xterm renders to a WebGL canvas —
   `innerText` never contains PTY output. Assert terminal activity via app
   state (`lastOutputAt` for non-query output, `liveTitle` for titles) read
   with `browser.execute`. For raw liveness, including status/cursor queries,
   use `window.__termic.lastPtyOutputAt(tab)` or `waitPtyQuiet`, as the `e2e`
   skill does. See [performance.md](performance.md), item 14. All other UI
   (sidebar, tabs, dialogs, Git panel) is normal DOM.
4. **Stable selectors.** Prefer role/visible-text; add a `data-testid` only
   where text is ambiguous or localized. Never depend on generated class names.
5. **Deterministic fixtures.** Reset/seed via the isolated profile; don't rely
   on state left by a previous test.
6. **Wait for READY, not for EXISTS.** A resource existing is not the same as
   it being able to do its job, and the gap between the two is where flake
   lives. Before submitting to an agent use `waitForAgentReady()`, not
   `waitForAgentPty()`: the latter resolves the moment Rust reports a `ptyId`,
   which says a process was spawned and nothing more.
7. **Verify the action landed.** An input event that dispatches without
   throwing has not necessarily been handled. `submitToAgent()` now checks
   that `lastInputAt` advanced, so a dropped submit fails at the submit with
   the real reason rather than 15s later at an unrelated assertion.

### The badge flake, and what it taught us

For a while the CI run failed almost every time, on a *different* badge spec
each run, always with `[null, null]`. That pattern reads as randomness and is
why it went unfixed: a real regression fails the same spec every time.

One bug, not many. `waitForAgentPty` returned as soon as the PTY existed, so a
spec could dispatch keystrokes at an xterm that had not yet wired its
`_inputEvent` handler. The events went nowhere, `submitToAgent` still reported
success, the fixture never emitted its OSC, and the badge assertion timed out
15s later blaming the app. On a laptop the window between "PTY exists" and
"xterm accepts input" is invisible. On a loaded 3-core CI runner it is wide
enough to lose regularly, and *which* spec lost was luck.

The fix is rules 6 and 7. `waitForAgentReady` waits for the fixture's OSC title
to reach the store, which proves process spawned + script running + xterm
parsing + store wired in one condition. An xterm parsing OSC will deliver
input.

Generalise it: when a spec fails intermittently and the failure moves around,
suspect a readiness precondition shared by all of them rather than N separate
timing bugs. And prefer a condition that proves the whole chain over one that
proves the first link.

Skeleton:

```ts
describe("my feature", () => {
  it("does the observable thing", async () => {
    await $("button=New task").click();
    await expect($("[data-testid='task-view']")).toBeDisplayed(); // auto-retries
  });
});
```

### Never click something that calls `openPath`

A spec may assert that a link is THERE, with the right target and state. It
must not click it. `openPath` is the OS opener: `open` on macOS, which returns
at once, and `xdg-open` on Linux, which on a CI runner reaches for a browser
through the desktop portal and does not come back.

The cost is not one red test. A board case that clicked the card's PR chip
passed on macOS, and on Linux hung for the 60s mocha timeout, then hung the
suite's after-all hook, then every spec that ran after it in that session:
deep-link and editor both failed as timeouts with nothing wrong in them. The
run reads as "Linux is flaky again" rather than as one bad line.

No spec in this suite clicks an opener-backed link. That is a convention with
no enforcement, so it is written here: `task-pr-badge` and `board-card-pr` are
both asserted on and never clicked.

The consequence is a real gap. A link's click guard (`stopPropagation`, so the
row or card behind it does not also activate) is not covered by anything, and
covering it would need a seam to stub the opener, which does not exist. Say so
when you add one rather than quietly clicking it.

### The e2e build never takes focus (and must not)

Each spec file launches its own instance, so a run launches seventeen. Under
`--features e2e` the app therefore sets `ActivationPolicy::Accessory` before
showing its window and skips the `set_focus()` a normal launch does
(`lib.rs`). On macOS `set_focus()` activates the app, and activating yanks the
user to whichever Space the window opened on: seventeen Space switches through
a four-minute run, on the machine of whoever is running the suite.

Nothing in the suite needed that focus. Specs drive the webview through
synthetic events, store writes and IPC, none of which care which app is
frontmost, and the window was already occluded anyway (see below). Do not add a
`set_focus()`, a `.show()` that activates, or an Accessory-to-Regular flip on
this path to make a spec pass: the spec is reaching for OS focus it should not
need, and the cost is the user's attention every time the suite runs.

### The e2e build draws nothing on screen (macOS)

Not taking focus was half of it. `show()` on macOS is `makeKeyAndOrderFront`,
so each spec file still put a 1500x1000 window on the current Space, in front
of everything but the app being typed in, and removed it seconds later. Nothing
was stolen and it still reads as an interruption on every launch.

So under `--features e2e` every window the app builds goes through
`hide_window_from_user_in_e2e` (`lib.rs`): alpha 0, click-through
(`ignoresMouseEvents`), and Transient + IgnoresCycle so it stays out of Mission
Control and the window cycle. The menu-bar item is never drawn either
(`set_tray_visible`), since it would otherwise blink in and out of the menu bar
once per spec file.

The window is still SHOWN, deliberately. An ordered-in window keeps its
backing store, so layout, script and `takeSnapshot` keep working: `snap()` and
the failure screenshot render the web content, not the window, and come out
opaque. Measured with `CGWindowListCopyWindowInfo` during a run: the
main and Activity windows report `kCGWindowAlpha` 0, and 1 with the override
below.

**To watch a spec run, use `make e2e_visible`**, which is `make e2e` with
`TERMIC_E2E_VISIBLE=1` set (`TERMIC_E2E_VISIBLE=1 npm run test:e2e` to skip the
rebuild). The app reads it at runtime, so both targets share one binary. The
window still does not take focus.

A window built by a NEW code path (a third `WebviewWindowBuilder`) has to call
the helper too, or it is the one window that pops up.

### The window may be occluded, and then nothing animates

The harness never brings the window to the front. When WebKit believes the
window is occluded, `document.hidden` is `true` and `requestAnimationFrame` is
frozen: **no rAF callback fires**, and anything the app defers to a frame is
deferred for as long as that lasts.

**Do not assume either state.** Whether the window counts as occluded depends
on what else is on the desktop, so it differs between machines and can change
mid-run. Measured on 2026-10-08 in the invisible mode above:
`document.hidden` was `false` and rAF ran at 60fps. A spec has to pass with
frames frozen AND with frames running. The second case bites when the app
defers a FOCUS to a frame: the comments popover in `editor.e2e.ts` was closed
by the terminal's focus-on-activate landing one frame after the spec opened it.

CodeMirror schedules its layout measurement that way. Until it runs, CM's
height map holds its unmeasured default of 14px per line while the rendered
lines are really 20, so each gutter number sits 6px above its code and the gap
grows down the file. A gutter-alignment spec then reports exactly the drift it
exists to catch, produced entirely by the harness. Waiting does not help: the
frame is never coming.

`flushEditorMeasure()` in `helpers.ts` runs the pending measure synchronously
(via `coordsAtPos`, whose public read flushes it) and returns how many editors
it touched, so a CodeMirror upgrade that moves the view handle fails loudly
instead of silently going back to measuring nothing. **Call it before reading
any geometry out of a CodeMirror editor.**

The same applies to product code that leans on rAF: it is invisible in a spec.
`cd359ba` moved the command palette's deferred effect from rAF to a macrotask
for the user-facing half of this (a palette command fired minutes late, over
whatever the user was doing by then, once the window came back).

## The driver cannot hold Control

Measured, not assumed, while writing the ⌃⇥ cases in `tabs-layout.e2e.ts`.
`browser.action("key").down(Key.Control)...` delivers a `Control` keydown and
keyup to the page, but every key pressed while it is notionally held still
arrives with **`ctrlKey: false`**. Meta behaves correctly by comparison: the
same sequence with `Key.Ctrl` (which WebdriverIO maps to Cmd on macOS, itself
a trap worth knowing) does set `metaKey: true` on the keys in between.

So a held-Control gesture cannot be driven from the suite at all, and a spec
that tries reports "the key never arrived" whether or not the feature works.
Drive such gestures with synthetic `KeyboardEvent`s instead — dispatched at the
element that would really receive them, never at `window`, or the spec proves
nothing about whether xterm eats the key first.

What that leaves uncovered is narrow but real: whether macOS and WKWebView hand
the chord to the page at all. Nothing in the app intercepts it natively (there
are no Tauri accelerators or `global_shortcut` registrations), but only a human
at the keyboard can confirm it.

## The one maturity caveat

`@wdio/tauri-service` + `tauri-plugin-wdio` are young (1.x, late-2025 / 2026).
They are maintained by the WebdriverIO org, but if a version regresses, pin the
last-known-good `@wdio/*` and `tauri-plugin-wdio` together (they release in
lockstep). The bridge/`e2e` skill remains as a fallback for manual checks.

## Typechecking the specs

`npm run typecheck:e2e` (`tsc -p e2e/tsconfig.json --noEmit`) covers `e2e/`,
`perf/` and both wdio configs. None of it is in the app's `tsc -b` project, so
`npm run build` says nothing about it, and by the time anyone looked there were
71 errors: mostly spec-scope `let taskId: string | undefined` flowing into
`browser.execute`, whose callback param then cannot index the store, plus two
perf report units that were simply not in the union they claimed. It runs in CI
beside the unit tests now.

Two conventions that keep it clean. Spec-scope ids are declared with a definite
assignment (`let taskId!: string`) because a before hook assigns them and the
after hooks still guard at runtime. And anything read out of `window.__termic`
is annotated at the boundary: the store is loosely typed, so an unannotated
value passed into another `execute` arrives as WebdriverIO's `HTMLElement`
union and every use of it is an implicit any.

## Where the time goes, and how to find out

`TERMIC_E2E_TIMING=1 npx wdio run wdio.conf.ts --spec <file>` writes
per-test durations to `.e2e/timings.txt`, slowest-first with
`sort -rn`. The spec reporter gives a per-FILE total, which tells you a file
is slow and nothing about why; without the per-test numbers you end up
optimising a 300ms sleep inside a seven minute file.

Measured on `agent.e2e.ts`, 73 tests: **11 of them were 315s of 470s**, and
42 tests together were 14s. Slowness is always a handful of cases.

Two causes, and only one of them is fixable:

**ELEMENT commands cost seconds; `browser.execute` costs milliseconds.**
Measured on this stack, not estimated: 50 sequential `browser.execute` calls
ran in 201ms, **4ms each**, and one holding a 1s timer in the page took
1015ms. So the protocol itself is not slow. What is slow is WebdriverIO's
ELEMENT layer (`$`, `$$`, `getAttribute`, `isExisting`, `getText`,
`waitForExist`, `waitForDisplayed`), which resolves elements over the wire
and, on our offscreen window, drags in Tauri window-state calls; that is the
same reason `waitVisible` here does its own visibility check inside a single
`execute` instead of calling `isDisplayed`.

An earlier version of this section said "a WebDriver command costs roughly
two seconds", which read as ALL commands and sent one optimisation pass
chasing `execute` polls that were never the problem (it moved a poll into
the page and won 9ms of 24s). Read it as: batch element work into one
`execute`, and poll with `execute` freely.

The case that made the difference: a poll written as `browser.$(sel)` then
`isExisting()` then `getAttribute()` spent **24s watching an attribute that
had been correct for 23.9 of them** (in-page marks: store at 41ms, DOM at
51ms, spec noticed at 23.9s). `waitForAttr` in helpers.ts is that poll in one
`execute`. Converting five such loops took `agent.e2e.ts`'s notifications
block from 3m27 to 1m20 and the file from 8m53 to 6m47.

`waitForExist` on an element an earlier case ALREADY put on screen is worse
than slow, it is wrong: it returns at once and the read after it races the
update. Wait for the value (`waitForAttr`), not the node.

**Tried and reverted: shortening the sticky-done window.** The three
two-stage cases (~20-27s each) idle 16s in the fixture to let a premature
done expire, so an override looked like the obvious win: `stickyDoneMs` in
localStorage, read by the one function both the store's gate and the pane's
token consult, fixture gap passed as `#stage <seconds>`. It does not pay.
The 16s is not sized by the 8s sticky window alone: the settle is 2 samples
of a 3s sampler, so the done it is waiting to take back lands up to ~9s
after the idle title, and the gap has to clear THAT and then the window. At
a 2s window and a 12s gap the title case failed outright ("the agent never
went back to work") and the pair ran no faster than the 45.3s they take
unmodified. The only remaining lever is the settle cadence itself, which is
the work-done detector, and that is not worth 8 seconds of a 10-minute run.

**The rest is the app's own timers, and it is not waste.** `SETTLE_MS` is
5s, `STICKY_DONE_MS` 8s, byte-quiet 4s, and a case proving a badge does NOT
appear has to outlast them. The fixture's two `sleep 16`s exist because a
done fires ~5s after a stage ends and the sticky window runs 8s from there.
Shortening those buys seconds and removes the thing being tested. Where a
timer is genuinely unusable in a test (the 20 minute liveness ceiling) the
app takes a `localStorage` override and the spec sets it; that is the
escape hatch, and it is not worth adding for a 5s timer.

Things that sound like causes and were measured not to be: window occlusion
(a run with the e2e window forced always-on-top came out SLOWER, 7m14s
against 6m28s), and fixed sleeps (21 of them across the suite, ~20s total).

**Never create data through the UI when a file will do.** `app.e2e.ts` built
a tall History list by creating and archiving twenty tasks, one IPC round
trip each, minutes of a window sitting on a screen doing nothing visible.
`wdio.conf.ts`'s `onPrepare` now writes those archived records straight to
disk. An archived task has no worktree by definition, so a JSON file is the
whole truth.
