# E2E coverage plan & checklist

The running map of what our WebdriverIO e2e suite covers and what it still
needs. Update this whenever you add/change a spec. Harness + authoring rules
live in [docs/e2e-tests.md](../e2e-tests.md) and the **`e2e` skill**.

- **Run:** `make e2e` (build + run) · `npm run test:e2e` (iterate). ~40s serial.
- **Specs are grouped by area** into ~10 files (one app launch each; cases run sequentially and self-clean). Add a new test as an `it` in the relevant group file.
- **Specs:** `e2e/specs/*.e2e.ts` · **helpers:** `e2e/helpers.ts`.
- **Legend:** ✅ covered · ⬜ todo (P0 core / P1 important / P2 nice-to-have).

## The rule

Every new feature with a UI/flow surface gets a spec; every change to an
existing feature updates its spec. A PR that adds/changes a flow is not done
until `make e2e` is green and this file reflects it.

## Covered today

| Area | What's asserted | Spec |
|---|---|---|
| ✅ App shell | Renders; `__termic` exposes real store state | `app.e2e.ts` |
| ✅ Navigation | Dashboard ↔ History via real clicks | `app.e2e.ts` |
| ✅ Create (wizard) | NewTaskDialog: name + shell CLI + Main-checkout → Create → task exists | `task.e2e.ts` |
| ✅ Task spawn | Task created; agent PTY comes alive; PTY write round-trips; agent OSC title reaches the app | `task.e2e.ts` |
| ✅ Agent working | After a real submit, the agent enters the working state | `agent.e2e.ts` |
| ✅ Agent attention | An agent you are not viewing flags completion (unread/done) when it finishes | `agent.e2e.ts` |
| ✅ CLI tabs (unit) | `termic tab` on an UNMOUNTED task keeps every persisted agent and its session id, does not steal the default-target role, and a shell tab does not strand the task agentless | `store/cliTab.integration.test.ts` |
| ✅ CLI tab ids end to end | Over the real control socket: `tab` returns a stable id; `logs --tab` resolves it to THAT tab's own PTY (the `PtyRole.tab_id` thread); `send --tab` delivers to the targeted tab only; `tab -p` confirms delivery into the new tab; `status` lists the strip with the same ids and 1-based indices; a missed selector is a typed not_found and a duplicate title refuses as ambiguous | `cli.e2e.ts` |
| ✅ CLI rename end to end | Over the real control socket (GH #153): `rename` retitles by explicit name, the reply carries the persisted NEW name and old_name, the store reflects it live; a same-project duplicate refuses with a typed conflict | `cli.e2e.ts` |
| ✅ CLI send --tab (unit) | Targeted send delivers/queues on the TARGET tab's own state, refuses vanished (unknown_tab), non-agent (not_sendable), dead (tab_not_live) targets, spawn-pending waits for the racing PTY, --resume/--fresh conflict, incapable --wait refused | `store/cliSend.integration.test.ts` |
| ✅ CLI adopt worktree (GH #169) | Over the real socket: `new --from` adopts an externally-created worktree (project resolved from its repo, name derived from its branch), re-adopting the same path and a plain non-worktree dir refuse cleanly, and `--resume` on both `new` and `tab` refuses an agent without id-resume support; `--resume` SEEDING (task agent_session_ids, tab sessionId, `--resume <id>` arg composition keeping `--name`) is pinned by `cli_server.rs` tests + `agents.test.ts` + `store/cliTab.integration.test.ts` | `cli.e2e.ts` |
| ✅ Windowless completion | An agent finishing while Termic is windowless still flags unread/done, even for the task that was active | `app.e2e.ts` |
| ✅ Pending work defers done | An agent that backgrounds work and returns to its idle title holds the done badge back past byte-quiet (4s) and the settle timer (5s); done fires once its status line clears | `agent.e2e.ts` |
| ✅ A hold that never clears ends | A status line that never clears cannot pin a tab to "working": the absolute ceiling force-clears it (shortened for the test via `localStorage.workDoneCeilingMs`) | `agent.e2e.ts` |
| ✅ A premature done is taken back | A done fired at a stage boundary is undone when the agent goes back to work (spinner returns, stale bullet drops), and the turn's real completion still fires | `agent.e2e.ts` |
| ✅ Split restore | A pane whose tabs are all gone collapses instead of restoring a blank leg; a task whose main tabs were all non-durable still restores with a main tab and a real activeTab | `tabs-layout.e2e.ts` |
| ✅ Agent notifications | OSC 9 raises attention carrying the agent's verbatim body; the "waiting for your input" idle nag raises nothing | `agent.e2e.ts` |
| ✅ Run tabs | A custom run command opens a run tab whose PTY executes it | `run.e2e.ts` |
| ✅ Task archive | Archived task leaves the active board | `task.e2e.ts` |
| ✅ Task restore | Archived task shows in History; restore returns it to active | `task.e2e.ts` |
| ✅ Multi-task | Two tasks, independent/distinct PTYs, survive going inactive, switching works | `task.e2e.ts` |
| ✅ Editor open | Click a file → editor tab opens → CodeMirror loads the real contents | `editor.e2e.ts` |
| ✅ Editor save | Edit in CodeMirror → dirty dot → Cmd+S → written to disk | `editor.e2e.ts` |
| ✅ Git clean | Clean working-tree status for the fixture repo | `git.e2e.ts` |
| ✅ Git dirty | Modify a file → Git panel leaves clean state, git status reports it | `git.e2e.ts` |
| ✅ Settings | Toggling a preference lands in the prefs store + control reflects it | `settings.e2e.ts` |
| ✅ GPU renderer toggle | Appearance → Terminal exposes the WebGL toggle on macOS (GH #140); flipping the real switch lands in prefs, both directions | `settings.e2e.ts` |
| ✅ Tabs | Add a terminal tab via the "+" menu; switch active tab | `tabs-layout.e2e.ts` |
| ✅ Tab rename | Double-click inline edit commits the new name | `tabs-layout.e2e.ts` |
| ✅ Theme | Picker switches theme; palette class applied to `<html>` | `tabs-layout.e2e.ts` |
| ✅ Editor persist | Single-click = preview tab; double-click persists it | `editor.e2e.ts` |
| ✅ Split panes | Unsplit start; split-right → 2 leaves; split-below → 3 | `tabs-layout.e2e.ts` |
| ✅ Message queue | Message held while working, drains on idle | `agent.e2e.ts` |
| ✅ Command palette | Opens/lists; filters; command activation closes it; Escape closes | `app.e2e.ts` |
| ✅ File finder | ⌘P lists the repo's files; selecting one opens an editor tab | `files.e2e.ts` |
| ✅ Git stage/unstage/commit | Stage → unstage → re-stage + commit → clean | `git.e2e.ts` |
| ✅ Task rename/delete | Rename updates store+sidebar; duplicate name refused (IPC) + toast (inline flow, GH #153); delete removes the task entirely | `task.e2e.ts` |
| ✅ Git diff | Open a diff tab for a changed file | `git.e2e.ts` |
| ✅ Inline review comments | Select a diff line → tooltip → compose → save, three times; line numbers stay level with the code throughout (GH #157) | `git.e2e.ts` |
| ✅ Find in files | ⇧⌘F opens; a repo-present query returns a result row | `files.e2e.ts` |
| ✅ Markdown preview | Preview view renders the README markdown (h1) | `editor.e2e.ts` |
| ✅ Directory links | A folder link recycles the preview tab into a listing and expands the tree; the folder README renders under it; folder rows, `..` and links inside the README navigate in place; a file row or README file link pins the listing and opens alongside it; a hidden listing's README does not claim ⌘F; ⌘[ / ⌘] walk the folder trail, are declined when focus is in the bottom drawer or right panel, and fall through to task switching once the trail runs out | `editor.e2e.ts` |
| ✅ Find in preview | ⌘F marks exactly the query text and nothing else (asserted on the `<mark>`s and their *computed background*, never a highlight registry), including the code spans a doc contains but the query doesn't touch; Enter/⇧Enter step with the counter and wrap both ways; a second query replaces the first instead of stacking; a query inside a code span still matches; a phrase the markdown source hard-wrapped still matches; a regex metacharacter stays literal; no match clears; Escape restores the document; a theme flip that rebuilds the DOM re-marks against the fresh one | `editor.e2e.ts` |
| ✅ ⌘F ownership | Only the tab the reader is in opens a find bar: not a background task's mounted preview, not the visible preview while a split pane holds focus, not while a modal holds the focus trap, and not under the Settings overlay (which traps nothing, so only the store flag sees it). The tab takes the key back on close, and a tab recycled onto another file drops its marks. In split view the editor keeps ⌘F while the caret is in it and the preview claims it once clicked into | `editor.e2e.ts` |
| ✅ File tree | Create a folder → expand reveals its child → collapse hides it | `files.e2e.ts` |
| ✅ Drag a file to a terminal | Row dragged onto a terminal sends the relative path to the PTY (no editor tab); released elsewhere types nothing; a plain click still opens the file | `files.e2e.ts` |
| ✅ Tab drags | Reorder within the main strip; drop on a pane edge to split there; drag out of a pane back to main | `tabs-layout.e2e.ts` |
| ✅ Resize drags | Sidebar edge widens + clamps at its minimum (persisted); split divider moves the ratio inside its clamp | `tabs-layout.e2e.ts` |
| ✅ Sidebar project drags | Reorder two projects; drop one into a group folder; move a whole folder as one block | `projects.e2e.ts` |
| ✅ Sidebar task drags | Reorder tasks inside a project (siblings keep their relative order); the new order persists to the task files, so a cold load reads it back; a task dragged at another project's row clamps to its own list instead of moving | `task.e2e.ts` |
| ✅ Settings reorder drags | Prompt rows reorder by their grip (and a click without movement does not); agent pills reorder within their kind | `settings.e2e.ts` |
| ✅ Resume submenu | The project `+` menu keeps archived sessions behind one Resume row; the submenu lists them and restores the picked one | `projects.e2e.ts` |
| ✅ Empty archive | History's Empty archive: cancelling keeps every task, confirming deletes them all for good | `task.e2e.ts` |
| ✅ Signal inspector layout | Observed titles render whole (no clipped column) and each row offers a copy button | `settings.e2e.ts` |
| ✅ Dialogs/palettes | Shortcuts help, prompt palette, broadcast open (and close) | `app.e2e.ts` |
| ✅ More dialogs | Changelog, welcome, race dialog open | `app.e2e.ts` |
| ✅ Windowless mode | Close backgrounds without killing the task; panes collapse to zero geometry; agent output keeps flowing; `raise` restores window + panes | `app.e2e.ts` |
| ✅ Agent race | Fire one prompt at 2 agents: cohort recorded, both spawn a PTY + receive the prompt (lastInputAt) + drive a fakeagent OSC title; runs on a no-remote repo; RaceDialog gates Start then steppers+prompt launch it; a name collision surfaces an error and records no new race | `task.e2e.ts` |
| ✅ Preferences | Sandbox default, editor font, terminal font setters | `settings.e2e.ts` |
| ✅ Agent extras | YOLO toggle; aux (bottom) terminal | `agent.e2e.ts` |
| ✅ Worktree task | Create a task on its own worktree branch (not repo-root); on a no-remote repo the default-base create falls back to local main | `task.e2e.ts` |
| ✅ Project rename | Rename a project (add covered too) | `projects.e2e.ts` |
| ✅ Editor split | Split view shows source + rendered preview together | `editor.e2e.ts` |
| ✅ Repo config | Save a `.termic.yaml` field and read it back | `projects.e2e.ts` |
| ✅ Setup script | Configure + launch a Setup tab that spawns | `run.e2e.ts` |
| ✅ Sidebar layout | Sidebar width setter persists | `tabs-layout.e2e.ts` |
| ✅ Code editor | Open a .py file → CodeMirror renders with highlight tokens | `editor.e2e.ts` |
| ✅ Editor h-scroll gutter | A long line scrolled fully right keeps the sticky gutter painting the host's surface, so code never shows through it (GH #161) | `editor.e2e.ts` |
| ✅ Commit & push | Commit with push to a bare remote; remote receives it | `git.e2e.ts` |
| ✅ Discover repos | Scan a folder → returns its git repos | `projects.e2e.ts` |
| ✅ Import worktree | Lists importable (unopened) worktrees for a project | `projects.e2e.ts` |
| ✅ Project reorder | Reorder projects | `projects.e2e.ts` |
| ✅ Resume closed tab | resumeClosedTab reopens a tab and consumes the entry | `task.e2e.ts` |
| ✅ Run stop | Kill a running run tab's PTY → it stops | `run.e2e.ts` |
| ✅ Project group | Assign a project to a group | `projects.e2e.ts` |
| ✅ Task sandbox | Enable enforce mode then turn it off (per task) | `settings.e2e.ts` |
| ✅ Project add/remove | Add a git repo as a project; remove drops it | `projects.e2e.ts` |
| ✅ Agent settings | Disable/re-enable an agent CLI via agentsSave | `agent.e2e.ts` |
| ✅ Run config modal | The #124 run-commands manager opens for a project | `run.e2e.ts` |
| ✅ PDF preview | A hidden PDF tab keeps its `display` (main tab and split pane) while a hidden terminal still goes to display:none; the embed URL is fingerprint-keyed, so only a real rewrite reloads it | `editor.e2e.ts` |

## CLI control plane (Phase 1/2)

The socket verbs are covered by Rust integration tests against a real
unix socket with a stub host (`src-tauri/src/cli_server.rs` tests: auth,
every verb, streaming framing, full bidirectional attach sessions,
watch/queue semantics), plus vitest for the store-level pieces
(`cliPromptReports`, `stopTask` queue fail-fast, the unattended-restore
mark). What that rig cannot see is the webview HANDLER side running in
the real app; e2e specs to add:

- ⬜ P1 `send` end to end: real socket request → send_prompt handler →
  fake-agent PTY receives the text; busy path queues and drains.
- ⬜ P1 `send --resume` respawnKick: exited fake-agent tab respawns and
  receives the injection (covers the TerminalPane kick effect).
- ⬜ P2 `send --fresh` adds a secondary tab without forgetting the
  persisted set (assert `persisted_tabs` after).
- ⬜ P2 `logs`/`result` against a fake-agent transcript fixture.

## Deferred (with rationale)

Lower-value or high-setup items left for later; the patterns to do them are all in place.

- **Second live agent in one task / quick-create / multi-member project** — heavy fixture setup (agent-tab construction, multi-repo members) for low marginal coverage. Resume (`resume-tab`) covers the reopen path.
- **Run-at-repo-root (spotlight)** — needs spotlight state; the run-tab mechanism is covered (`run`, `run-scripts` via proxy).
- **Configured `.termic.yaml` run scripts via the Run button** — covered by proxy: `setup-script` (configured-script launch) + `run` (run-tab mechanism) + `repo-config` (config persistence). The live Run-button path has a config-cache nuance not worth the flake.
- **File create/rename/delete via context menu, file-tree reveal** — need Radix context-menu driving (flaky, no clean IPC). Binary previews are no longer on this list: image preview is covered by `files.e2e.ts`, PDF preview by `editor.e2e.ts` (which builds a tiny valid PDF inline rather than committing a fixture).
- **Prompts management, keybindings editor** — config-file editing, low value.

## Environment-limited (not robustly testable here)

These are intentionally NOT covered by written specs — asserting them would be flaky or impossible in the occluded-window / embedded-WebDriver setup. Left as manual checks.

- **OS desktop notification delivery + completion sound** on agent done — no in-webview signal to assert; the store-side attention/unread IS covered (`agent.e2e.ts`).
- **Keyboard shortcuts into CodeMirror** (e.g. its own ⌘F search panel) don't route reliably across window-focus states — manual check. Button-driven editor actions (Preview) ARE covered. This is specific to CodeMirror's keymap: the markdown preview's ⌘F is a plain window listener, so it dispatches fine as a synthetic keydown and IS covered (find-in-preview, `editor.e2e.ts`).
- **Real keystrokes into xterm / CodeMirror** (contenteditable + WebGL canvas) — WebDriver key events don't route there reliably. Covered by proxy: PTY round-trips via `ipc.ptyWrite` (`task-spawn`, `message-queue`) and editor edits via the CodeMirror view API (`editor-save`).
- **Commit-and-push / setup script / resume-closed-tab** — need mock-remote / `.termic.yaml` / multi-agent-tab infra with careful fixture cleanup; deferred, tracked above.
- **The page a PDF is scrolled to** — it lives in WKWebView's native PDF view, which exposes nothing to the DOM. The spec asserts the two mechanisms that keep that view (and its page) alive; the page itself is a manual check.

## Known harness gotchas (read before writing a spec)

- **Terminal content is not in the DOM** (WebGL canvas) — assert `lastOutputAt`/`liveTitle`/store, never innerText, for PTY output.
- **`workState === "working"`** won't flip from a raw `ipc.ptyWrite`; termic gates it on a real submit through the input path.
- **Radix menus open on pointerdown** — dispatch `pointerdown`/`pointerup`, not just `.click()` (see `tabs-layout.e2e.ts`).
- **Hover-gated controls** (theme picker, History "Restore →") need a dispatched `mouseover`/`mouseenter` first, or drive the underlying store/IPC.
- **rAF-deferred effects are frozen when the window is occluded** (e.g. the command palette's `act()` → `requestAnimationFrame`). Assert the synchronous part, or drive the underlying store, rather than the deferred side effect.
- **Run/Setup tab PTY spawn is rAF-gated** in TerminalPane, so a newly-added run tab's PTY lags on an occluded/offscreen window (CI). Assert the tab is *created* (launch wiring); PTY spawn/execution is covered by task-spawn's agent PTY.
- **Don't use WebdriverIO's native visibility** (`$().waitForDisplayed()`/`isDisplayed()`): offscreen, it triggers Tauri window-state calls that time out 5s each (a trivial check took 47s). Use `waitVisible()`/`clickWhenVisible()` — a FAST client-side visibility check via `browser.execute`. The config polls every 100ms so waits fire on-condition, not on a timeout.
- **No fixed sleeps, ever** — `waitUntil`/`waitFor*`/auto-retrying `expect` only.
- **Screenshots are for humans**, never assertions (the xterm canvas even reads black in captures).
- **Scope dialog queries to the SPECIFIC dialog, never a bare `[role="dialog"]`.** Dialogs stack, and on an occluded window a closing dialog's rAF-driven unmount lags so a stale node lingers in the DOM — a bare selector then grabs the wrong dialog (a test can pass solo but fail as the last spec). Find the dialog by its title/content: `[...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes("Start an agent race"))`. See the RaceDialog cases in `task.e2e.ts`.
- **The fixture repo has an `origin` remote** (a sibling bare repo, `.e2e/fixture-repo-origin.git`), so `origin/main` resolves like a real cloned checkout. The project default base is `origin/main`, and worktree spawns (New Task, every Agent Race racer) branch from it — a local-only fixture would die with `git branch … origin/main → not a valid object name`. If a spec repoints `origin` (e.g. `git.e2e.ts` commit-push), it MUST restore the seeded origin in teardown, or later specs lose their base. `resolve_base_ref` (lib.rs) makes a genuinely remote-less repo fall back to local `main` — covered by the no-remote race + New Task cases in `task.e2e.ts`.
- **Isolation:** each spec creates its own task via `openTask()` and archives it in `after`; never assume the app launched on a particular view (self-establish it).
