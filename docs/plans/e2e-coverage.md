# E2E coverage plan & checklist

The running map of what our WebdriverIO e2e suite covers and what it still
needs. Update this whenever you add/change a spec. Harness + authoring rules
live in [docs/e2e-tests.md](../e2e-tests.md) and the **`e2e` skill**.

- **Run:** `make e2e` (build + run) · `npm run test:e2e` (iterate).
- **Specs:** `e2e/specs/*.e2e.ts` · **helpers:** `e2e/helpers.ts`.
- **Legend:** ✅ covered · ⬜ todo (P0 core / P1 important / P2 nice-to-have).

## The rule

Every new feature with a UI/flow surface gets a spec; every change to an
existing feature updates its spec. A PR that adds/changes a flow is not done
until `make e2e` is green and this file reflects it.

## Covered today

| Area | What's asserted | Spec |
|---|---|---|
| ✅ App shell | Renders; `__termic` exposes real store state | `smoke.e2e.ts` |
| ✅ Navigation | Dashboard ↔ History via real clicks | `smoke.e2e.ts` |
| ✅ Create (wizard) | NewTaskDialog: name + shell CLI + Main-checkout → Create → task exists | `create-wizard.e2e.ts` |
| ✅ Task spawn | Task created; agent PTY comes alive; PTY write round-trips; agent OSC title reaches the app | `task-spawn.e2e.ts` |
| ✅ Agent working | After a real submit, the agent enters the working state | `agent-working.e2e.ts` |
| ✅ Agent attention | A backgrounded agent flags completion (unread/done) when it finishes | `agent-attention.e2e.ts` |
| ✅ Run tabs | A custom run command opens a run tab whose PTY executes it | `run.e2e.ts` |
| ✅ Task archive | Archived task leaves the active board | `task-archive.e2e.ts` |
| ✅ Task restore | Archived task shows in History; restore returns it to active | `task-restore.e2e.ts` |
| ✅ Multi-task | Two tasks, independent/distinct PTYs, survive going inactive, switching works | `multi-task.e2e.ts` |
| ✅ Editor open | Click a file → editor tab opens → CodeMirror loads the real contents | `editor.e2e.ts` |
| ✅ Editor save | Edit in CodeMirror → dirty dot → Cmd+S → written to disk | `editor-save.e2e.ts` |
| ✅ Git clean | Clean working-tree status for the fixture repo | `git-panel.e2e.ts` |
| ✅ Git dirty | Modify a file → Git panel leaves clean state, git status reports it | `git-dirty.e2e.ts` |
| ✅ Settings | Toggling a preference lands in the prefs store + control reflects it | `settings.e2e.ts` |
| ✅ Tabs | Add a terminal tab via the "+" menu; switch active tab | `tabs.e2e.ts` |
| ✅ Tab rename | Double-click inline edit commits the new name | `rename.e2e.ts` |
| ✅ Theme | Picker switches theme; palette class applied to `<html>` | `theme.e2e.ts` |
| ✅ Editor persist | Single-click = preview tab; double-click persists it | `editor.e2e.ts` |
| ✅ Split panes | Unsplit start; split-right → 2 leaves; split-below → 3 | `split-pane.e2e.ts` |
| ✅ Message queue | Message held while working, drains on idle | `message-queue.e2e.ts` |
| ✅ Command palette | Opens/lists; filters; command activation closes it; Escape closes | `command-palette.e2e.ts` |
| ✅ File finder | ⌘P lists the repo's files; selecting one opens an editor tab | `file-finder.e2e.ts` |
| ✅ Git stage/unstage/commit | Stage → unstage → re-stage + commit → clean | `git-commit.e2e.ts` |
| ✅ Task rename/delete | Rename updates store+sidebar; delete removes the task entirely | `task-lifecycle.e2e.ts` |
| ✅ Git diff | Open a diff tab for a changed file | `git-dirty.e2e.ts` |
| ✅ Find in files | ⇧⌘F opens; a repo-present query returns a result row | `find-in-files.e2e.ts` |
| ✅ Markdown preview | Preview view renders the README markdown (h1) | `editor.e2e.ts` |
| ✅ File tree | Create a folder → expand reveals its child → collapse hides it | `file-tree.e2e.ts` |
| ✅ Dialogs/palettes | Shortcuts help, prompt palette, broadcast open (and close) | `dialogs-open.e2e.ts` |
| ✅ More dialogs | Changelog, welcome, race dialog open | `dialogs2.e2e.ts` |
| ✅ Preferences | Sandbox default, editor font, terminal font setters | `prefs.e2e.ts` |
| ✅ Agent extras | YOLO toggle; aux (bottom) terminal | `agent-extras.e2e.ts` |
| ✅ Worktree task | Create a task on its own worktree branch (not repo-root) | `worktree-task.e2e.ts` |
| ✅ Project rename | Rename a project (add covered too) | `project.e2e.ts` |
| ✅ Editor split | Split view shows source + rendered preview together | `editor.e2e.ts` |
| ✅ Repo config | Save a `.termic.yaml` field and read it back | `repo-config.e2e.ts` |
| ✅ Setup script | Configure + launch a Setup tab that spawns | `setup-script.e2e.ts` |
| ✅ Sidebar layout | Sidebar width setter persists | `layout.e2e.ts` |
| ✅ Code editor | Open a .py file → CodeMirror renders with highlight tokens | `code-editor.e2e.ts` |
| ✅ Commit & push | Commit with push to a bare remote; remote receives it | `commit-push.e2e.ts` |
| ✅ Discover repos | Scan a folder → returns its git repos | `discover.e2e.ts` |
| ✅ Import worktree | Lists importable (unopened) worktrees for a project | `import-worktree.e2e.ts` |
| ✅ Project reorder | Reorder projects | `project.e2e.ts` |
| ✅ Resume closed tab | resumeClosedTab reopens a tab and consumes the entry | `resume-tab.e2e.ts` |
| ✅ Run stop | Kill a running run tab's PTY → it stops | `run-stop.e2e.ts` |
| ✅ Project group | Assign a project to a group | `project.e2e.ts` |
| ✅ Task sandbox | Enable enforce mode then turn it off (per task) | `sandbox.e2e.ts` |
| ✅ Project add/remove | Add a git repo as a project; remove drops it | `project.e2e.ts` |
| ✅ Agent settings | Disable/re-enable an agent CLI via agentsSave | `agent-settings.e2e.ts` |
| ✅ Run config modal | The #124 run-commands manager opens for a project | `run-config.e2e.ts` |

## Deferred (with rationale)

Lower-value or high-setup items left for later; the patterns to do them are all in place.

- **Second live agent in one task / quick-create / multi-member project** — heavy fixture setup (agent-tab construction, multi-repo members) for low marginal coverage. Resume (`resume-tab`) covers the reopen path.
- **Run-at-repo-root (spotlight)** — needs spotlight state; the run-tab mechanism is covered (`run`, `run-scripts` via proxy).
- **Configured `.termic.yaml` run scripts via the Run button** — covered by proxy: `setup-script` (configured-script launch) + `run` (run-tab mechanism) + `repo-config` (config persistence). The live Run-button path has a config-cache nuance not worth the flake.
- **Image/PDF preview, file create/rename/delete via context menu, file-tree reveal** — need binary fixtures or Radix context-menu driving (flaky, no clean IPC).
- **Prompts management, keybindings editor** — config-file editing, low value.

## Environment-limited (not robustly testable here)

These are intentionally NOT covered by written specs — asserting them would be flaky or impossible in the occluded-window / embedded-WebDriver setup. Left as manual checks.

- **OS desktop notification delivery + completion sound** on agent done — no in-webview signal to assert; the store-side attention/unread IS covered (`agent-attention.e2e.ts`).
- **Keyboard shortcuts into CodeMirror** (e.g. ⌘F search) don't route reliably across window-focus states — manual check. Button-driven editor actions (Preview) ARE covered.
- **Real keystrokes into xterm / CodeMirror** (contenteditable + WebGL canvas) — WebDriver key events don't route there reliably. Covered by proxy: PTY round-trips via `ipc.ptyWrite` (`task-spawn`, `message-queue`) and editor edits via the CodeMirror view API (`editor-save`).
- **Commit-and-push / setup script / resume-closed-tab** — need mock-remote / `.termic.yaml` / multi-agent-tab infra with careful fixture cleanup; deferred, tracked above.

## Known harness gotchas (read before writing a spec)

- **Terminal content is not in the DOM** (WebGL canvas) — assert `lastOutputAt`/`liveTitle`/store, never innerText, for PTY output.
- **`workState === "working"`** won't flip from a raw `ipc.ptyWrite`; termic gates it on a real submit through the input path.
- **Radix menus open on pointerdown** — dispatch `pointerdown`/`pointerup`, not just `.click()` (see `tabs.e2e.ts`).
- **Hover-gated controls** (theme picker, History "Restore →") need a dispatched `mouseover`/`mouseenter` first, or drive the underlying store/IPC.
- **rAF-deferred effects are frozen when the window is occluded** (e.g. the command palette's `act()` → `requestAnimationFrame`). Assert the synchronous part, or drive the underlying store, rather than the deferred side effect.
- **No fixed sleeps, ever** — `waitUntil`/`waitFor*`/auto-retrying `expect` only.
- **Screenshots are for humans**, never assertions (the xterm canvas even reads black in captures).
- **Isolation:** each spec creates its own task via `openTask()` and archives it in `after`; never assume the app launched on a particular view (self-establish it).
