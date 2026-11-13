---
name: e2e
description: Write and maintain termic's automated end-to-end tests (WebdriverIO driving the real macOS window). Use whenever you develop a NEW feature (add a spec that exercises its flow), CHANGE an existing feature (update its spec), or need to verify a UI flow before declaring done. This is how termic avoids UI regressions. Replaces the old automation-bridge driving skill.
---

# Authoring & maintaining termic e2e tests

Automated, repeatable tests that launch the **real** Termic window, click
through real flows, read real app state, and screenshot. The point is
regression safety: **every new feature with a UI/flow surface gets a spec, and
every change to an existing feature updates its spec.** Don't skip it.

Full architecture + prod-safety rationale: [docs/e2e-tests.md](../../../docs/e2e-tests.md).

## The workflow (do this every time)

**New feature** → add an `it` (or a `describe`) to the relevant grouped file under `e2e/specs/` (specs are grouped by area — app, task, agent, editor, files, git, tabs-layout, settings, run, projects — one app launch per file). Cover its main
user-observable outcome(s). **Changed feature** → open that feature's spec,
adjust the assertion/selectors to the new behavior (keep asserting the
*outcome*, not incidental markup), and re-run. **Before declaring done** on any
UI-affecting change → `make e2e` must be green.

## Run

```sh
make e2e            # build the --features e2e binary + run the whole suite
```

Iterating on spec files only? Skip the rebuild:

```sh
npm run test:e2e    # just runs wdio against the last-built binary
```

On macOS the run is invisible: the window is fully transparent and
click-through, and never takes focus. To watch a spec drive the window:

```sh
make e2e_visible                        # make e2e, with the window on screen
TERMIC_E2E_VISIBLE=1 npm run test:e2e   # same, without the rebuild
```

Rebuild (`npm run e2e:build`, or `make e2e`) **after any Rust or frontend
change** — the frontend is embedded in the e2e binary. Screenshots land in
`.e2e/artifacts/` (gitignored, local only — no-op in CI via `snap()`). Runs
locally and in a non-required `macos-26` CI job (see docs/e2e-tests.md).

Never build the e2e binary with a bare `cargo build` — that produces a binary
that points at the (unrunning) dev server and the window comes up blank. Always
go through `npm run e2e:build` / `make e2e` (it runs `tauri build`, which
embeds the frontend). If a run shows `url: about:blank` / a white window, this
is the cause.

## Writing a spec

Use the shared helpers in [e2e/helpers.ts](../../../e2e/helpers.ts) so specs
stay short and a UI change is a one-place fix. Reference example:
[e2e/specs/app.e2e.ts](../../../e2e/specs/app.e2e.ts).

```ts
import { waitForAppShell, clickByText, waitForText } from "../helpers.js";

describe("archive a task", () => {
  it("moves the task to History", async () => {
    await waitForAppShell();
    await clickByText("Archive");
    await waitForText("No archived tasks."); // auto-retries; no sleep
  });
});
```

One `it` = one user-observable outcome. All `it`s in a file share ONE launched
window (boot once, assert many) — order them so earlier tests don't leave state
that breaks later ones, or reset between them.

## Reading real app state (for SETUP, and for what the DOM can't show)

The e2e binary exposes `window.__termic` (stores + ipc + invoke — same handle
the dev bridge uses; enabled via `VITE_E2E=1`, stripped from real release
builds). Use it to **set up** state fast, to **locate** things (ids), and to
read what genuinely has no DOM surface (PTY bytes — see rule 4).

**Do NOT use it for the assertion when the feature has a visible surface.**
`tab.workState === "working"` is the detector's private bookkeeping; the
spinner badge is the feature. A spec that asserts the former keeps passing
after the badge stops rendering. `agent.e2e.ts` is the reference: it submits
through the terminal's own input path (`submitToAgent`) and asserts on
`[data-testid="work-badge"]`'s `data-work-state` via `waitForWorkBadge` /
`sidebarBadge`. When there is no hook yet, add a small `data-testid` +
`data-*` state attribute to the component rather than reaching into the store.

Read state or drive real IPC through `browser.execute`:

```ts
// Read store state
const names = await browser.execute(() =>
  window.__termic!.useApp.getState().workspaces.map((w: any) => w.name));

// Set up state fast by driving the app's own IPC (no clicking through wizards)
const wsId = await browser.execute(async () => {
  const t = window.__termic!;
  const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
  const ws = await t.invoke("workspace_open_repo",
    { projectId: proj.id, cli: "fakeagent", name: null });
  await t.useApp.getState().loadAll();
  t.useApp.getState().setActiveWorkspace(ws.id);
  return ws.id;
});
```

`requireTermicApi()` asserts the handle is present (fails loudly if you ran an
old/non-e2e binary).

## Stability rules (non-negotiable — this is what keeps the suite non-fuzzy)

1. **Never sleep.** No `setTimeout` / fixed waits. Use `browser.waitUntil`, the
   `waitFor*` helpers, or auto-retrying `expect`. Every wait is a *condition*.
2. **Address a control by test id when its label can grow.** `clickByText`
   matches EXACT text, and the right panel's tabs render a change count inside
   the button, so "Git" becomes "Git29" as soon as the checkout is dirty. That
   made the whole `git dirty tree` block pass alone and fail tenth in a suite.
   Use `openRightTab()`; reserve `clickByText` for labels that are only ever a
   label.
3. **Assert on what the user sees, not pixels and not internals.** Screenshots
   are for humans to eyeball, never for assertions. Prefer DOM text /
   `data-*` state attributes over store fields whenever a surface exists
   (see the section above); fall back to store state only for rule 4.
4. **Terminal content is NOT in the DOM.** xterm renders to a WebGL canvas, so
   `innerText` never contains PTY output no matter how long you wait. Assert
   terminal activity via store state — e.g. `tab.lastOutputAt` (non-query output)
   or `tab.liveTitle` (the agent's OSC title) read through `window.__termic`.
   For raw liveness, including cursor/status queries, use
   `window.__termic.lastPtyOutputAt(tab)` or `waitPtyQuiet`. The UI snapshot
   deliberately skips query-only traffic; see docs/performance.md item 14.
   All OTHER UI (sidebar, tabs, dialogs, Git panel) is normal DOM.
   `scripts/fake-agent.sh` mimics claude: it drives the OSC title with claude's
   glyphs (`✳` idle / Braille spinner working). NOTE: the working indicator
   won't flip from a raw `ipc.ptyWrite` — termic gates it on a real submit
   through its input path. Use `submitToAgent(taskId, text)`, which goes in
   through xterm (insertText input event + Enter keydown/keyup) and therefore
   arms the detector the way a keystroke does. Do NOT patch `lastInputAt` by
   hand: that encodes how arming works into the spec and hides a broken submit
   path. For pure OSC-title checks, assert `liveTitle` — see the task-spawn
   case in `e2e/specs/task.e2e.ts`.
   **ALWAYS `await waitForAgentReady(taskId)` before the first
   `submitToAgent`, never `waitForAgentPty`.** `waitForAgentPty` returns as
   soon as Rust reports a `ptyId`, which means a process was spawned and
   nothing else. Submitting into that window dispatches input at an xterm that
   may not have wired its handler yet: the keystrokes vanish, the submit still
   reports success, and the spec fails much later on an unrelated badge
   assertion showing `[null, null]`. That was one bug presenting as a
   different flaky spec on nearly every CI run. `waitForAgentReady` waits for
   the fixture's OSC title to reach the store, which proves the whole chain
   (process, script, xterm, store) is live. See the postmortem in
   [docs/e2e-tests.md](../../../docs/e2e-tests.md).
5. **Semantic selectors.** Match by role / visible text (`clickByText`). Add a
   `data-testid` where text is ambiguous, localized, or can grow (rule 2).
   Never depend on generated class names.
   - **Scope dialog queries to the SPECIFIC dialog, never a bare
     `[role="dialog"]`.** Dialogs stack, and on an occluded window a closing
     dialog's rAF-driven unmount lags, leaving a stale node in the DOM — a bare
     selector then grabs the wrong dialog (a test can pass solo but fail as the
     last spec). Find it by title/content: `[...document.querySelectorAll(
     '[role="dialog"]')].find(d => d.textContent.includes("<dialog title>"))`.
     See the RaceDialog cases in `e2e/specs/task.e2e.ts`.
6. **Deterministic fixtures.** Runs use the isolated `.e2e/profile`
   (`welcomed` + the `fixture-repo` project + the zero-token `fakeagent`).
   Agent flows use `fakeagent` (`scripts/fake-agent.sh`, real PTY, zero tokens).
   Don't depend on state a previous test left behind.

## Drags (all pointer-based)

There is no HTML5 drag-and-drop in the app (WKWebView's native drag is
unreliable and Tauri intercepts it for file drops), so specs drive real
pointer/mouse sequences through the app's own handlers. WebDriver cannot start
an OS drag; this exercises the handlers, not WebKit's gesture recognition.

```ts
await pointerDrag(`[data-tab-id="${a}"]`, `[data-tab-id="${b}"]`, { grab: "left", land: "right" });
await mouseDrag("[data-resize-handle='sidebar-width']", 60);   // resize handles are MOUSE-driven
```

Four traps, all already handled by the helpers:

1. **Every drop is hit-tested with `elementFromPoint`.** A dialog backdrop, a
   popover, or a Radix menu left behind by an EARLIER spec file covers the drop
   point and the gesture silently does nothing (`.click()` doesn't care, drags
   do). Radix also parks `pointer-events: none` on `<body>` while a modal is
   open, and a dialog that never finished closing leaves it stuck — then every
   hit test returns `<html>`. `dismissOverlays()` clears both; `pointerDrag`
   retries once through it and then fails naming what is in the way.
   **Neutralize, never remove**: those nodes are React-managed, and detaching
   one makes React throw when it later unmounts it, which tears down the whole
   root and leaves `#root` empty for every spec after it.
2. **Every visited task stays mounted** (MainArea keeps PTYs alive), so tab
   strips and pane chrome exist once per task. Scope to the visible one with
   `[data-task-id="<id>"] …` or a hidden copy (rect 0x0) wins the query.
3. **The window is reused across spec files**, so the task on screen may not be
   yours: `ensureActiveTask(taskId)` before anything that drags real elements.
4. **Some handlers re-measure the DOM on every move** (the sidebar reads its
   rendered width), so a burst of synchronous moves all read the same
   pre-commit value. `mouseDrag` yields between steps — with a timer, not rAF,
   which is frozen while the window is occluded.

Assert the store action the drag lands in (`reorderTab`, `moveTabToSplit`,
`projectReorder`, …), not pixels. Mid-drag affordances have DOM hooks:
`.termic-drag-ghost`, `.termic-drop-target`, `[data-drop-zone]`.

## Fixtures / isolation

`wdio.conf.ts` launches the app against `TERMIC_DATA_DIR=.e2e/profile`, a
throwaway profile seeded once (the same one the ad-hoc bridge used), so a run
never touches your real `termic_dev` data. Paths round-trip canonicalized on
`projectAdd` (symlinks resolved), so match projects by `name`, not by the path
you passed in.

The seeded `fixture-repo` carries an **`origin` remote** (sibling bare repo
`.e2e/fixture-repo-origin.git`), so `origin/main` resolves like a real cloned
checkout. This matters because the project default base is `origin/main`, and
every worktree spawn (New Task, each Agent Race racer) branches from it — a
remote-less fixture would die with `git branch … origin/main → not a valid
object name`. If your spec repoints `origin`, restore the seeded one in
teardown (see `git.e2e.ts` commit-push), or later specs lose their base. A
genuinely remote-less repo falls back to local `main` via `resolve_base_ref`
(lib.rs); the no-remote race + New Task cases in `task.e2e.ts` cover it.

Each spec **file** gets its own app launch (one window per file, not per
`it`); tests within a file share that window and run sequentially, so order
them so earlier state doesn't break later ones, or reset between them.

**Leave the fixture the way you found it, including UNTRACKED files.** The
seed self-heals tracked paths (`git checkout HEAD -- .`) and deliberately does
not touch untracked ones, which are the spec's to own and therefore the spec's
to remove. A file left behind does not fail the run that created it: it fails
the NEXT one, in another spec, usually as `git panel` booting on a dirty tree.
CI never sees it (fresh checkout, one run), so this only ever bites a person
running `make e2e` twice. `mcp.e2e.ts` restores the README it dirties and
`scratchpad.e2e.ts` removes the `notes/` it promotes into.

Cleaning up **after a failure** takes more than an `after()` hook that deletes
what the test returned. `agent race` creates racer 1, then racer 2; a throw in
between leaves racer 1 on disk and returns no ids at all, so its teardown
sweeps by NAME as well. Ask what your teardown deletes when the body threw
half way, not only when it passed.

## Debugging a failing spec

- **See what's actually on screen:** the spec should `saveScreenshot` into
  `.e2e/artifacts/`; open it. A blank white window ⇒ the about:blank build
  issue above.
- **Wrong webview / empty DOM:** enumerate handles —
  `await browser.getWindowHandles()` then `switchToWindow(h)` and log
  `location.href` per handle. The app content is the `main` handle at a
  `tauri://` URL, not `about:blank`.
- **Occluded window:** if the window is on another Space / behind others,
  `document.visibilityState` is `hidden` and rAF is frozen. `browser.execute`,
  IPC, and store reads still work; only rAF-driven visual updates stall.
- **`window.__termic` undefined:** you're running a non-e2e binary — `make e2e`.

## Ad-hoc / exploratory driving (not a written test)

For one-off manual poking where you don't (yet) want a spec, the dev automation
bridge still exists (`src-tauri/src/automation.rs`, `TERMIC_AUTOMATION=1` under
`tauri dev`) — see [docs/automation.md](../../../docs/automation.md). But
anything meant to prevent a regression belongs in a spec here, not a throwaway
eval.

## Maturity caveat

`@wdio/tauri-service` + `tauri-plugin-wdio-webdriver` are young (1.x, 2026) and
maintained by the WebdriverIO org. `package.json` pins `@wdio/native-utils` to
`2.5.0` via `overrides` to work around a broken pin in tauri-service 1.2.0. If a
future upgrade breaks, pin the `@wdio/*` packages and `tauri-plugin-wdio-webdriver`
in lockstep to the last-known-good set.
