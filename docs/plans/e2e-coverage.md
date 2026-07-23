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
| ✅ Git stage/commit | Stage a changed file (moves to staged); commit → tree clean | `git-commit.e2e.ts` |

## Roadmap (todo)

### Task lifecycle & creation
- ⬜ P1 Create a **worktree** task (not repo-root); verify the worktree exists, and archive/delete removes it.
- ⬜ P1 **Delete** a task (permanent) + optional branch delete.
- ⬜ P1 Rename a **task** (sidebar context menu) — distinct from tab rename.
- ⬜ P2 Import an existing worktree; quick-create flow.

### Agents & terminal
- ⬜ P1 Desktop **notification** + completion **sound** on agent done (the OS-facing side of `useAttentionNotifier`).
- ⬜ P1 **Resume** a closed agent tab with its session id (Resume menu).
- ⬜ P1 Real **keystroke** input → PTY (xterm `onData`), asserting via `lastOutputAt`.
- ⬜ P2 Second agent in one task; YOLO toggle; AuxTerminal (bottom terminal).

### Editor
- ⬜ P1 Search/replace panel; markdown preview / split.
- ⬜ P2 Image/PDF preview; language highlighting.

### Git & diff
- ⬜ P1 Open a **diff** (DiffPane) for a changed file.
- ⬜ P1 Unstage a file; commit-and-push (mock remote).
- ⬜ P2 Multi-repo project status.

### File tree
- ⬜ P1 Expand/collapse folders; reveal/locate.
- ⬜ P1 **Find in files** (⌘⇧F).
- ⬜ P2 Create/rename/delete a file via context menu.

### Run & scripts (#54, #124)
- ⬜ P1 Configure run scripts via the **Run config modal** (.termic.yaml); the **Run** button launches/streams them.
- ⬜ P1 **Stop** a running script; Setup script.
- ⬜ P2 Run at repo root (spotlight).

### Panes & layout
- ⬜ P2 Sidebar toggle; right-panel toggle.

### Projects
- ⬜ P1 **Add a project** (NewProjectDialog); rename / remove / reorder.
- ⬜ P2 Discover repos (scan folder); multi-member project; repo config.

### Settings (broader)
- ⬜ P1 **Agents** section: add/edit/disable an agent CLI.
- ⬜ P1 **Sandbox** settings (global default; per-task enable → SIGKILLs live PTYs).
- ⬜ P2 Fonts (editor/terminal); prompts management; keybindings.

### Dialogs & palettes
- ⬜ P2 Prompt palette; Broadcast (send to all agents); Race; Shortcuts help; Changelog/What's-new; Welcome (first run).

### Notifications & cross-cutting
- ⬜ P1 Desktop notification + completion sound on agent done.
- ⬜ P2 Key global shortcuts (`useShortcuts`); window-state persistence; update UI (mock).

## Known harness gotchas (read before writing a spec)

- **Terminal content is not in the DOM** (WebGL canvas) — assert `lastOutputAt`/`liveTitle`/store, never innerText, for PTY output.
- **`workState === "working"`** won't flip from a raw `ipc.ptyWrite`; termic gates it on a real submit through the input path.
- **Radix menus open on pointerdown** — dispatch `pointerdown`/`pointerup`, not just `.click()` (see `tabs.e2e.ts`).
- **Hover-gated controls** (theme picker, History "Restore →") need a dispatched `mouseover`/`mouseenter` first, or drive the underlying store/IPC.
- **rAF-deferred effects are frozen when the window is occluded** (e.g. the command palette's `act()` → `requestAnimationFrame`). Assert the synchronous part, or drive the underlying store, rather than the deferred side effect.
- **No fixed sleeps, ever** — `waitUntil`/`waitFor*`/auto-retrying `expect` only.
- **Screenshots are for humans**, never assertions (the xterm canvas even reads black in captures).
- **Isolation:** each spec creates its own task via `openTask()` and archives it in `after`; never assume the app launched on a particular view (self-establish it).
