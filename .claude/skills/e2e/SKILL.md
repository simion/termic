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

Rebuild (`npm run e2e:build`, or `make e2e`) **after any Rust or frontend
change** — the frontend is embedded in the e2e binary. Screenshots land in
`.e2e/artifacts/` (gitignored, local only — no-op in CI via `snap()`). Runs
locally and in a non-required `macos-14` CI job (see docs/e2e-tests.md).

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

## Reading real app state (prefer this over DOM scraping)

The e2e binary exposes `window.__termic` (stores + ipc + invoke — same handle
the dev bridge uses; enabled via `VITE_E2E=1`, stripped from real release
builds). Read state or drive real IPC through `browser.execute`:

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
2. **Assert on state / DOM text, not pixels.** Screenshots are for humans to
   eyeball, never for assertions.
3. **Terminal content is NOT in the DOM.** xterm renders to a WebGL canvas, so
   `innerText` never contains PTY output no matter how long you wait. Assert
   terminal activity via store state — e.g. `tab.lastOutputAt` (bytes flowed)
   or `tab.liveTitle` (the agent's OSC title) read through `window.__termic`.
   All OTHER UI (sidebar, tabs, dialogs, Git panel) is normal DOM.
   `scripts/fake-agent.sh` mimics claude: it drives the OSC title with claude's
   glyphs (`✳` idle / Braille spinner working). NOTE: `tab.workState ===
   "working"` won't flip from a raw `ipc.ptyWrite` — termic gates the working
   indicator on a real submit through its input path, so assert `liveTitle` for
   OSC-title checks, not `workState`. See the task-spawn case in `e2e/specs/task.e2e.ts`.
4. **Semantic selectors.** Match by role / visible text (`clickByText`). Add a
   `data-testid` only where text is ambiguous or localized. Never depend on
   generated class names.
5. **Deterministic fixtures.** Runs use the isolated `.e2e/profile`
   (`welcomed` + the `fixture-repo` project + the zero-token `fakeagent`).
   Agent flows use `fakeagent` (`scripts/fake-agent.sh`, real PTY, zero tokens).
   Don't depend on state a previous test left behind.

## Fixtures / isolation

`wdio.conf.ts` launches the app against `TERMIC_DATA_DIR=.e2e/profile`, a
throwaway profile seeded once (the same one the ad-hoc bridge used), so a run
never touches your real `termic_dev` data. Paths round-trip canonicalized on
`projectAdd` (symlinks resolved), so match projects by `name`, not by the path
you passed in.

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
