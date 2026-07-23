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
| ✅ Task spawn | Task created; agent PTY comes alive; PTY write round-trips; agent OSC title reaches the app | `task-spawn.e2e.ts` |
| ✅ Task archive | Archived task leaves the active board | `task-archive.e2e.ts` |
| ✅ Task restore | Archived task shows in History; restore returns it to active | `task-restore.e2e.ts` |
| ✅ Multi-task | Two tasks, independent/distinct PTYs, survive going inactive, switching works | `multi-task.e2e.ts` |
| ✅ Editor | Click a file → editor tab opens → CodeMirror loads the real contents | `editor.e2e.ts` |
| ✅ Git panel | Clean working-tree status for the fixture repo | `git-panel.e2e.ts` |
| ✅ Settings | Toggling a preference lands in the prefs store + control reflects it | `settings.e2e.ts` |
| ✅ Tabs | Add a terminal tab via the "+" menu; switch active tab | `tabs.e2e.ts` |
| ✅ Tab rename | Double-click inline edit commits the new name | `rename.e2e.ts` |
| ✅ Theme | Picker switches theme; palette class applied to `<html>` | `theme.e2e.ts` |

## Roadmap (todo)

### Task lifecycle & creation
- ⬜ P0 Create a task through the real **NewTaskDialog** wizard (project/cli/name → confirm → spawns). Complements the IPC-based spawn.
- ⬜ P1 Create a **worktree** task (not repo-root); verify the worktree exists, and archive/delete removes it.
- ⬜ P1 **Delete** a task (permanent) + optional branch delete.
- ⬜ P1 Rename a **task** (sidebar context menu) — distinct from tab rename.
- ⬜ P2 Import an existing worktree; quick-create flow.

### Agents & terminal
- ⬜ P0 Agent **working → done** state via a real submit through the input path (the heuristic `task-spawn` intentionally bypasses).
- ⬜ P0 **Attention/notification** on agent done (unread badge, `useAttentionNotifier`).
- ⬜ P1 **Resume** a closed agent tab with its session id (Resume menu).
- ⬜ P1 **Message queue**: queue input while the agent is working; it sends on idle.
- ⬜ P1 Real **keystroke** input → PTY (xterm `onData`), asserting via `lastOutputAt`.
- ⬜ P2 Second agent in one task; YOLO toggle; AuxTerminal (bottom terminal).

### Editor
- ⬜ P0 Edit → **dirty** flag → **save** (⌘S) → file written to disk.
- ⬜ P1 Preview tab → **persist** (double-click); open multiple files.
- ⬜ P1 Search/replace panel; markdown preview / split.
- ⬜ P2 Image/PDF preview; language highlighting.

### Git & diff
- ⬜ P0 **Dirty** tree: change a file → Git panel lists it (make + revert an edit in the fixture).
- ⬜ P1 Open a **diff** (DiffPane) for a changed file.
- ⬜ P1 Stage/unstage → **commit**; commit-and-push (mock remote).
- ⬜ P2 Multi-repo project status.

### File tree
- ⬜ P1 Expand/collapse folders; reveal/locate.
- ⬜ P1 **File finder** (⌘P) → jump to file; **Find in files** (⌘⇧F).
- ⬜ P2 Create/rename/delete a file via context menu.

### Run & scripts (#54, #124)
- ⬜ P0 Configure run scripts via the **Run config modal**; Run → run tabs launch/stream.
- ⬜ P1 **Stop** a running script; Setup script; custom run command.
- ⬜ P2 Run at repo root (spotlight).

### Panes & layout
- ⬜ P1 **Split** pane right (⌘D) / below (⇧⌘D); close split; focus pane.
- ⬜ P2 Sidebar toggle; right-panel toggle.

### Projects
- ⬜ P1 **Add a project** (NewProjectDialog); rename / remove / reorder.
- ⬜ P2 Discover repos (scan folder); multi-member project; repo config.

### Settings (broader)
- ⬜ P1 **Agents** section: add/edit/disable an agent CLI.
- ⬜ P1 **Sandbox** settings (global default; per-task enable → SIGKILLs live PTYs).
- ⬜ P2 Fonts (editor/terminal); prompts management; keybindings.

### Dialogs & palettes
- ⬜ P1 **Command palette** (⌘K) → run a command.
- ⬜ P2 Prompt palette; Broadcast (send to all agents); Race; Shortcuts help; Changelog/What's-new; Welcome (first run).

### Notifications & cross-cutting
- ⬜ P1 Desktop notification + completion sound on agent done.
- ⬜ P2 Key global shortcuts (`useShortcuts`); window-state persistence; update UI (mock).

## Known harness gotchas (read before writing a spec)

- **Terminal content is not in the DOM** (WebGL canvas) — assert `lastOutputAt`/`liveTitle`/store, never innerText, for PTY output.
- **`workState === "working"`** won't flip from a raw `ipc.ptyWrite`; termic gates it on a real submit through the input path.
- **Radix menus open on pointerdown** — dispatch `pointerdown`/`pointerup`, not just `.click()` (see `tabs.e2e.ts`).
- **Hover-gated controls** (theme picker, History "Restore →") need a dispatched `mouseover`/`mouseenter` first, or drive the underlying store/IPC.
- **No fixed sleeps, ever** — `waitUntil`/`waitFor*`/auto-retrying `expect` only.
- **Screenshots are for humans**, never assertions (the xterm canvas even reads black in captures).
- **Isolation:** each spec creates its own task via `openTask()` and archives it in `after`; never assume the app launched on a particular view (self-establish it).
