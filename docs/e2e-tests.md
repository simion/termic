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

## CI

An `e2e` job in `.github/workflows/test.yml` runs the suite on `macos-14` for
PRs and pushes to `main`. It is **not a required check yet** — it's there to
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

The seeded `fixture-repo` carries an `origin` remote (a sibling bare repo,
`.e2e/fixture-repo-origin.git`) so `origin/main` resolves like a real cloned
checkout. This matters because the project default base is `origin/main`: any
worktree spawn that honors it (a plain New Task, and every Agent Race racer)
would otherwise die with `git branch ... origin/main → not a valid object name`.
A spec that repoints origin (e.g. `git.e2e.ts`'s commit-push) MUST restore the
seeded origin in teardown, or the later `agent race` test loses its base.

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
   duration.
2. **Assert on state, not pixels.** Screenshots are for humans to eyeball, not
   for assertions. Assert DOM text/attributes, or app state.
3. **Terminal content is NOT in the DOM.** xterm renders to a WebGL canvas —
   `innerText` never contains PTY output. Assert terminal activity via app
   state (e.g. `lastOutputAt`) read with `browser.execute`, exactly as the
   `e2e` skill does. All other UI (sidebar, tabs, dialogs, Git panel) is normal
   DOM.
4. **Stable selectors.** Prefer role/visible-text; add a `data-testid` only
   where text is ambiguous or localized. Never depend on generated class names.
5. **Deterministic fixtures.** Reset/seed via the isolated profile; don't rely
   on state left by a previous test.

Skeleton:

```ts
describe("my feature", () => {
  it("does the observable thing", async () => {
    await $("button=New task").click();
    await expect($("[data-testid='task-view']")).toBeDisplayed(); // auto-retries
  });
});
```

## The one maturity caveat

`@wdio/tauri-service` + `tauri-plugin-wdio` are young (1.x, late-2025 / 2026).
They are maintained by the WebdriverIO org, but if a version regresses, pin the
last-known-good `@wdio/*` and `tauri-plugin-wdio` together (they release in
lockstep). The bridge/`e2e` skill remains as a fallback for manual checks.
