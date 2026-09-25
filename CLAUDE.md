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
├── store/        (app, ui, prefs, pr, scriptRuns)
├── hooks/        (useShortcuts, useAttentionNotifier)
└── components/
    ├── task/ (MainArea, TaskView, TabBar, TerminalPane, EditorPane, DiffPane, AuxTerminal, RightPanel, FileTree)
    ├── sidebar/ / settings/ / dialogs/ / ui/ / views/
    └── UnifiedBar.tsx
src-tauri/src/lib.rs   ← ALL Rust (PTY, project/task IO, settings, scripts, git, sandbox, proxy)
src-tauri/src/forge.rs ← GitHub/GitLab PR-MR integration via the gh / glab CLIs (detection, status, create)
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

### Green suites are not a manual test, and you cannot run one

**Before you open a PR, ask the user whether they have manually tested the change** — in those words, before opening it, not after. The PR is what the question gates.

`npm test`, `cargo test` and `make e2e` all pass on a change that flickers for a frame, steals focus, repaints one tick late, fires a shortcut twice, or looks wrong. Those are the bugs this project is judged on, and no assertion in the repo catches them. That is the whole reason the question exists: it is the one check you cannot run for the user, however many suites you have green.

If the answer is no or "not yet", stop and let them drive it. If they say open it anyway, that is their call: open it, and say in the PR description that it has not been manually verified, so the maintainer knows what they are reviewing. Either way the PR description carries one line of what was exercised by hand and what was observed. "All tests pass" is not an answer to that question.

Agent-written PRs are welcome in this repo (see [CONTRIBUTING.md](CONTRIBUTING.md#agent-written-prs), and most of Termic is one). This is the one gate they have to pass, and it is the same gate a hand-written PR passes.

### Building UI unattended: look at it before you call it done

**Only when no human is going to test it.** If the maintainer is driving the
change, their pass is the check and this is wasted time. But when you build a
UI from scratch with nobody in the loop, shipping it unseen means nobody has
ever looked at it, and green suites do not fill that hole.

**On a large feature, ASK first.** It costs a rebuild and a capture run per
pass, so on anything sizeable ask whether they want the visual check before
spending it - the answer turns entirely on whether they are about to open the
app themselves. Small unattended UI changes do not need the question; just do
it.

The screenshots go in the chat. Do not publish them as an artifact.

So: drive it with the e2e suite, `snap()` each state, and READ THE IMAGES BACK.
Not the ad-hoc bridge (see ## What NOT to do) - a written spec, so the states
you captured stay covered afterwards. Capturing them is usually a reason to
drive the real dialogs rather than the store, which is better coverage anyway.

This is not a formality. Building profiles, 18 passing e2e cases said the UI
was fine and four things were wrong, three of them visible only to an eye:

- avatar monograms read `PE` and `WO`, the first two letters of a one-word name
- two pickers in one dialog shared a `data-testid`, so the spec drove the wrong
  one, coloured the wrong profile, and passed
- a path preview hardcoded `~/termic/...` while the dev app dir is
  `termic_dev`, and stated it as fact
- a radio group where the dot moved and the highlight did not, because
  `transition-colors` never repaints a themed border-color in WKWebView

Two rules for what happens after you spot something:

**Measure, do not squint.** A screenshot tells you something is wrong, not
what. Assert the computed value (`getComputedStyle().borderTopColor`, the
rendered text, the node count) and let it name the defect. Half the time the
answer is that the SPEC was wrong, which a screenshot alone would have blamed
on the app.

**Run the control before writing a causal claim.** "X causes Y" earns a comment
in the code and a note in gotchas.md, and both outlive you. Remove X and
confirm Y goes; put X back and confirm Y returns. Three plausible explanations
were wrong before the real one, and each would have been written down as fact.

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

**GitHub prose uses semantic line breaks (SEMBR).** PR descriptions, PR review comments and issue comments: break the line after each sentence, and at major clause boundaries within a long one. Never hard-wrap to a column. GitHub reflows the source either way, so column wrapping buys nothing and costs the line-per-thought structure: editing a comment then means reflowing a paragraph instead of touching the one line that changed. See <https://sembr.org>. Commit message bodies and the `docs/` tree are the exception and stay wrapped to ~72-78 columns, matching what is already there.

## Fixtures: never paste real output into the repo

This repo is public and its history is permanent. A test fixture built by
pasting real output from a machine carries whatever that machine knew: an
employer's internal hostname, a work username, an absolute home path, an org
name. `forge.rs`'s `glab auth status` fixture shipped a real self-hosted
GitLab host and the maintainer's work account to GitHub, and the company found
it in a brand-monitoring sweep. Nothing in review flagged it, because a real
corporate hostname is syntactically indistinguishable from a made-up one.

**Transcribe the shape, never the bytes.** When a bug reproduces from real CLI
output, the fixture is synthetic from the first keystroke: retype the format
with placeholders substituted as you go. Do not paste and then sanitize, which
is how you miss the second occurrence three lines down.

**"Verbatim" in a fixture comment is the confession.** If you are about to
write "verbatim from my machine", "real output", "from the maintainer's
settings", or "the reported case, exactly as sent", stop: you are describing a
paste, and a paste is the leak. Say what shape the fixture reproduces and why
that shape is the hard case, which is the part a future reader actually needs.

**Use the placeholder vocabulary already in the tree.** Never invent a new
realistic-looking domain, because someone owns it. Hosts: `acme.com`,
`ghe.acme.com`, `git.acme.com`, `git.internal.acme.com`, `gitlab.example.io`,
`github.corp.net`. People: `alice`, `bob`, `bob.smith.ext`. Paths: `/Users/u`,
`/Users/alice`. Mail: `e2e@termic.dev`, `user@example.com`.

**A third party's data is the severe case.** Your own name in a fixture is
untidy; someone else's internal infrastructure is not yours to publish and you
cannot unpublish it. That includes anything a user pastes into an issue or a
bug report: their `auth status`, their remote URLs, their paths carry their
employer too, so a fixture derived from a report gets placeholdered before it
is committed, not after.

**A leak that already shipped is a history problem, not a file problem.**
Editing the file fixes today's clone and nothing else: the blob stays reachable
by commit SHA, on forks, and in the GitHub API. Fix the working tree
immediately so it stops spreading, then tell the maintainer plainly that the
history still holds it and that scrubbing it means a force-push rewrite plus a
GitHub support request to purge stale refs. That is the maintainer's call, not
yours.

## What NOT to do without asking

- Commit a fixture, doc example or screenshot built from real output without replacing every hostname, username and path with a placeholder (see ## Fixtures). A public repo's history is permanent.
- Open a PR without first asking the user whether they manually tested the change (see ## Testing). Every suite in the repo being green is not a substitute, and neither is your own confidence in the diff.
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
- Ship a rule about where an agent's files live without asking what DOCKER does with it. The host env overlay and `docker::build_spec` are two implementations of one idea, and three bugs in one feature came from fixing only the host (see [docs/gotchas.md](docs/gotchas.md) "Docker is a SECOND REALM").
- Add a window LABEL without adding it to a Tauri capability. A window matching no capability gets NO permissions at all, so it renders perfectly and then fails every `listen`, which kills every PTY spawn in it.
- Collapse `null` and `undefined` with `??` when `null` is a real answer. "Running on the ordinary login" and "nothing has spawned yet" are different facts; merging them made a running task's usage disappear.
- Cap the width of body text in a SETTINGS page (`max-w-prose`, `max-w-md`, `mx-auto max-w-*` on a sentence). The content pane is already narrowed, so a second cap wraps the text at half the pane and leaves a dead column beside it. This has been shipped and reverted repeatedly; no settings section uses a width utility on text. See [docs/ui.md](docs/ui.md) "Settings text runs the full width of the pane".
- Hide panes with `visibility: hidden` (must be `display: none`). xterm's renderer only pauses on zero geometry; visibility-hidden terminals keep running WebGL draws for background TUI repaints and pin the GPU. See docs/performance.md bear trap 2.
- Trust any single signal for WebGL renderer health. A lost context must be RECOVERED (dispose + re-attach a fresh addon), never just disposed, or every terminal goes black after sleep/idle and only a tab restart brings it back. Four signals are needed and each covers a hole in the others: the raw `webglcontextlost` on the addon's canvas (xterm's derived `onContextLoss` is 3s late and never fires at all for a RESTORED context, whose in-place repair leaves a stale glyph atlas), the `webglcontextrestored` on the same canvas, the focus/visibilitychange `isContextLost()` probe (the loss event is not guaranteed for a suspended webview), and the return-from-away rebuild (`src/lib/userPresence.ts`: a laptop driven over screen sharing never blurs or hides the window, so the other three never get to run, and the first input after a long gap rebuilds the addon without asking). `isContextLost()` is liveness, NOT health. See docs/gotchas.md and docs/performance.md bear trap 3.
- Write an UNCHANGED value through a store setter on a PTY-driven path. Zustand copies the whole ~233-key state and every mounted task's selectors re-run; `setTabLiveTitle` missing the bail its siblings had cost a third of idle CPU. See docs/performance.md bear trap 8.
- Add `thread::sleep` poll loops in Rust. PTY flusher/waiter block on a condvar; sleep-polling burned ~1,950 wakeups/s and kept the CPU out of deep sleep. See docs/performance.md bear trap 9.

## Docs

Deeper references — read when working in that area:

- [docs/ipc.md](docs/ipc.md) — Tauri commands, critical payload shapes, long-running IPC discipline
- [docs/i18n.md](docs/i18n.md) — i18next namespaces, wiring rules (hooks vs i18n.t, Trans, plurals), zh-CN conventions, parity test
- [docs/data-model.md](docs/data-model.md) — data dirs, Project/Task/Settings/Tab entities
- [docs/tech-debt.md](docs/tech-debt.md) — index of temporary/removable scaffolding (e.g. the workspace→task migration) + purge checklists
- [docs/performance.md](docs/performance.md) — perf traps, sub-pixel/rendering hardening, what is measured where (`make perf`)
- [docs/perf-ci.md](docs/perf-ci.md) — why counts gate PRs and timings only run nightly; what Orca actually does
- [docs/adding-an-agent.md](docs/adding-an-agent.md) — runbook for adding a built-in agent: what to measure before writing a default, and every table/file that has to move together
- [docs/agent-states.md](docs/agent-states.md) — every state an agent tab can be in, what produces it, what it draws, and whether it rings
- [docs/agent-hooks.md](docs/agent-hooks.md) — agent hooks: what each agent reports, the transport (including Docker), and the measurements behind both
- [docs/sandbox.md](docs/sandbox.md) — sandbox-exec + CONNECT proxy, YOLO interaction, deny debugging
- [docs/shortcuts.md](docs/shortcuts.md) — shortcut system architecture, adding shortcuts, glyph rendering
- [docs/themes.md](docs/themes.md) — custom theme file format (`~/.config/termic/themes/*.json`), ui/terminal key reference
- [docs/lsp.md](docs/lsp.md) — language servers: the rules a new one must obey, and `make lsp-smoke`
- [docs/ui.md](docs/ui.md) — UI conventions, window chrome/drag, right-panel footer, settled detection
- [docs/gotchas.md](docs/gotchas.md) — common bugs (encountered + fixed), React/Zustand traps
- [docs/automation.md](docs/automation.md) — automation bridge, E2E testing (use the `e2e` skill, don't improvise)
- [docs/e2e-tests.md](docs/e2e-tests.md) — written WebdriverIO e2e suite (run via `make e2e`); authoring lives in the `e2e` skill
- [docs/e2e-coverage.md](docs/e2e-coverage.md) — e2e coverage checklist + roadmap (what's tested, what's next)
