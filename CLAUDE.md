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

## Testing

Unit/Rust: `npm test` (vitest) + `cargo test`. `npm run typecheck:e2e` covers `e2e/` and `perf/`, which the app's `tsc -b` project does NOT reach: they went unchecked long enough to accumulate 71 errors, so run it after touching a spec. UI flows: the written e2e suite (`make e2e`, WebdriverIO on the real window). The e2e suite also runs in CI on `macos-14` (`.github/workflows/test.yml`), deliberately NOT a required check yet, it is there to surface flakiness before it gates merges. Run it locally anyway; do not treat the CI job as your test pass.

Performance: `make perf` runs the nightly suite (startup, memory) and the local-only bench (idle CPU, GPU) and reports them separately. Neither gates. What DOES gate a PR is the count-and-invariant class (`src/store/selectorFanout.test.ts`) because counts survive a 3-core CI runner and timings do not. Read [docs/perf-ci.md](docs/perf-ci.md) before adding a perf check, especially before adding a threshold.

**When you implement or modify ANY functionality that could regress, run the relevant tests before committing and keep them green** — not just UI. Logic/Rust: `npm test` + `cargo test`. Behavior/flows: `make e2e` (rebuilds the `--features e2e` binary + runs the suite). Add or update the spec/test that covers what you changed — a change and its test land in the same commit. The suite is a maintained asset: authoring rules live in the **`e2e` skill**, the coverage map + roadmap in [docs/e2e-coverage.md](docs/e2e-coverage.md). Each spec should cover a feature with several cases (happy path + edge/negative + state transitions), not just one, so it actually catches regressions.

## Scratchpad

`scratchpad/` at the repo root is gitignored and local-only. Put throwaway work there: market/competitor research, GTM notes, half-finished drafts, one-off analysis, anything that shouldn't ship or be reviewed. Nothing in it has to be release-quality. Working docs meant for contributors belong in the tracked `docs/` tree: `docs/ideas/` for anything not yet approved, `docs/plans/` for approved implementation-ready specs. See ## Docs tree.

## Docs tree: what goes where, and what you owe it when you ship

Two categories for unbuilt work, and a doc's directory is a claim about its status, not a filing preference:

```
docs/*.md          reference + operational. True of the app as it exists today.
docs/plans/        approved and refined. Ready to implement, no design work left.
docs/ideas/        everything not yet approved. Detailed or not, it is not decided.
```

There is no third bucket for "detailed but undecided": that is an idea. `windows.md` and `agent-orchestration.md` are build-ready documents that are still ideas, because nobody has committed to them, and being detailed is not the same as being decided. The bar for `plans/` is high and the directory is usually near-empty; that is the honest state, not a gap to fill.

`scratchpad/` is gitignored throwaway work, outside all of this. See ## Scratchpad.

**GitHub issues are for planned work only.** An idea does not get an issue: an issue implies somebody intends to do it, and a backlog of issues nobody will action is worse than no backlog. An idea lives in its `docs/ideas/` file and, if it is worth advertising, one bullet under the README roadmap's Ideas heading. When an idea is approved it moves to `docs/plans/` and gets an issue labelled `planned` at the same time. **Never open an issue for an idea, a roadmap bullet, or a doc you just wrote.** If you think something deserves promoting, say so and stop.

**Shipping a change is not done until the docs tree reflects it.** The doc move lands in the same commit as the code, exactly like its test. Which move depends on what you did:

- **Implemented a `docs/plans/` spec.** Delete the plan and close its issue. It described work that no longer needs doing, and a stale plan is worse than no plan because someone will pick it up. Fold anything still true (a measurement, a trap, a decision and its reasoning) into the matching `docs/*.md` reference doc first. Precedent: `plans/cli.md`, `plans/notarization.md` and `plans/workspace-to-task-rename.md` were deleted in a1d6759 once shipped.
- **Implemented part of a plan.** Narrow the plan to what is left and say what shipped. Do not leave it describing the whole thing.
- **An idea got approved.** Move `ideas/ → plans/`, rewrite the header into a spec (what to build, not whether to), open its `planned` issue, and move its README bullet from Ideas to Planned. All four, or the three lists disagree.
- **A plan's premise changed.** Move it back `plans/ → ideas/`, say why at the top, and close its issue. Precedent: `mcp.md` was demoted when the 2026-07-28 spec revision reopened the question.
- **Changed behaviour a `docs/*.md` reference doc describes.** Update that doc. `ipc.md`, `data-model.md`, `ui.md`, `shortcuts.md`, `sandbox.md`, `themes.md`, `performance.md` and `gotchas.md` are load-bearing for the next agent, and a wrong one costs more than a missing one.
- **Removed scaffolding.** Update `tech-debt.md`, which indexes it.

The README roadmap, `docs/plans/`, `docs/ideas/` and the `planned` issue list are four views of the same thing and must agree: every Planned bullet has a `planned` issue, and every Ideas bullet with a write-up links its `docs/ideas/` file. The README is the USER-FACING view, so it lists features, not chores: an internal follow-up plan (`plans/right-panel-refresh.md` is the current example) belongs in `docs/plans/` with no roadmap bullet. Anything a user would notice does get one. The README roadmap and `CHANGELOG.md` are still maintainer-only to EDIT (## Releasing): if your change ships a roadmap item, say "closes #N" in your summary and stop.

Cross-doc references: link by **path**, and never cite a roadmap item by its position in the list. The list is reordered whenever something ships, and `docs/perf-ci.md` cited "roadmap item 12" until the item above it shipped and the reference silently became wrong.

## Releasing). Say in your summary that it closes issue #N, and stop.

Cross-doc references: link by **path**, and never cite a README roadmap item by its list position. The numbering shifts every time something ships, and `docs/perf-ci.md` cited "roadmap item 12" until the item above it shipped and the reference silently became wrong. Roadmap items are identified by their `planned`-labelled issue.

## Releasing

**Maintainer-only. Do NOT cut releases or write changelog entries as part of a contribution or agent task.** Never run `make release` / `make release-patch`, never bump the version, and never add or edit a `CHANGELOG.md` entry (or `changelog.json`) unless the maintainer explicitly asks you to in that request. A PR that fixes a bug or adds a feature must NOT touch `CHANGELOG.md` — the maintainer authors the entry when they cut the release. If you think a change is release-worthy, say so and stop; leave the versioning to them.

Add a `## [version] - ` section to the TOP of `CHANGELOG.md` (Keep a Changelog format: summary lead line + `### Features`/`### Bug fixes` bullets) before running `make release`. `CHANGELOG.md` is the source of truth; `changelog.json` is derived from it by `scripts/changelog.mjs` (do not hand-edit it). For a small change riding along with the last release, `make release-patch` folds it into a patch (bump the top heading in place + append a bullet, no new entry). Full flow: the **`release` skill** (`.claude/skills/release/SKILL.md`). Mock update UI: `VITE_MOCK_UPDATE=available|whatsnew npm run tauri:dev`.

## Commits

**Every commit that relates to a GitHub issue must name it in the message.** Put `(#N)` in the subject or a `Refs #N` / `Closes #N` line in the body, so `git log` and the issue thread stay linked without anyone having to reconstruct it later. If the work came from an issue, an investigation of one, or a follow-up to one, that counts. Only use `Closes`/`Fixes` when the change genuinely finishes the issue: a partial fix gets `Refs`, and the maintainer closes it.

## Copy rules

No em dashes (—) anywhere in user-visible text: dialogs, tooltips, buttons, `CHANGELOG.md`, error messages. Use a comma, period, parentheses, or colon instead.

## What NOT to do without asking

- Ad-hoc live-drive the app (the automation bridge) proactively for exploration. Default to NOT launching the live app for one-off poking. (This does NOT apply to the written e2e suite: running `make e2e` before committing a UI change is expected, per ## Testing.)
- Switch editor from CodeMirror 6 (Monaco is slower in WKWebView, verified).
- Re-enable React StrictMode (async PTY race).
- Add a server/backend daemon (app is entirely on-device).
- Make IO-heavy Tauri commands synchronous (freezes the Mac via WKWebView event loop).
- Sandbox AuxTerminal, setup, run, or archive scripts (only agent CLI PTY is the threat model).
- Expose `task_set_sandbox` without SIGKILLing live PTYs by default.
- Widen the CSP in `tauri.conf.json`. One policy covers the whole webview, and the webview sits outside the sandbox ("Known gap" in [docs/sandbox.md](docs/sandbox.md)). `img-src https:` is an accepted exception; `connect-src` / `script-src` would be far worse. `src/lib/cspGuard.test.ts` pins both, because [termic.dev/local](https://termic.dev/local/) publishes `connect-src` as proof the app only ever talks to termic.dev; if that test fails, the website is now wrong too.
- Force subpixel font smoothing (colored fringing on dark backgrounds).
- Hard-code hex colors outside `@theme` in `index.css`.
- Hide panes with `visibility: hidden` (must be `display: none`). xterm's renderer only pauses on zero geometry; visibility-hidden terminals keep running WebGL draws for background TUI repaints and pin the GPU. See docs/performance.md bear trap 2.
- Trust any single signal for WebGL renderer health. A lost context must be RECOVERED (dispose + re-attach a fresh addon), never just disposed, or every terminal goes black after sleep/idle and only a tab restart brings it back. Three signals are needed and each covers a hole in the others: the raw `webglcontextlost` on the addon's canvas (xterm's derived `onContextLoss` is 3s late and never fires at all for a RESTORED context, whose in-place repair leaves a stale glyph atlas), the `webglcontextrestored` on the same canvas, and the focus/visibilitychange `isContextLost()` probe (the loss event is not guaranteed for a suspended webview). `isContextLost()` is liveness, NOT health. See docs/gotchas.md and docs/performance.md bear trap 3.
- Write an UNCHANGED value through a store setter on a PTY-driven path. Zustand copies the whole ~233-key state and every mounted task's selectors re-run; `setTabLiveTitle` missing the bail its siblings had cost a third of idle CPU. See docs/performance.md bear trap 8.
- Add `thread::sleep` poll loops in Rust. PTY flusher/waiter block on a condvar; sleep-polling burned ~1,950 wakeups/s and kept the CPU out of deep sleep. See docs/performance.md bear trap 9.

## Docs

Deeper references — read when working in that area:

- [docs/ipc.md](docs/ipc.md) — Tauri commands, critical payload shapes, long-running IPC discipline
- [docs/data-model.md](docs/data-model.md) — data dirs, Project/Task/Settings/Tab entities
- [docs/tech-debt.md](docs/tech-debt.md) — index of temporary/removable scaffolding (e.g. the workspace→task migration) + purge checklists
- [docs/performance.md](docs/performance.md) — perf traps, sub-pixel/rendering hardening, what is measured where (`make perf`)
- [docs/perf-ci.md](docs/perf-ci.md) — why counts gate PRs and timings only run nightly; what Orca actually does
- [docs/auto-retry.md](docs/auto-retry.md) — auto-resume on a subscription usage limit (detection, the wait-or-pay menu, the never-spend-money rule)
- [docs/sandbox.md](docs/sandbox.md) — sandbox-exec + CONNECT proxy, YOLO interaction, deny debugging
- [docs/shortcuts.md](docs/shortcuts.md) — shortcut system architecture, adding shortcuts, glyph rendering
- [docs/themes.md](docs/themes.md) — custom theme file format (`~/.config/termic/themes/*.json`), ui/terminal key reference
- [docs/ui.md](docs/ui.md) — UI conventions, window chrome/drag, right-panel footer, settled detection
- [docs/gotchas.md](docs/gotchas.md) — common bugs (encountered + fixed), React/Zustand traps
- [docs/automation.md](docs/automation.md) — automation bridge, E2E testing (use the `e2e` skill, don't improvise)
- [docs/e2e-tests.md](docs/e2e-tests.md) — written WebdriverIO e2e suite (run via `make e2e`); authoring lives in the `e2e` skill
- [docs/e2e-coverage.md](docs/e2e-coverage.md) — e2e coverage checklist + roadmap (what's tested, what's next)
