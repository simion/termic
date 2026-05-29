# Context Picker — Design Spec

**Date:** 2026-05-28
**Branch:** `feature/add-context-picker`
**Status:** Approved, pending implementation plan

## Goal

A two-pane fuzzy file/folder picker that inserts workspace-relative `@path`
tokens into the active agent terminal, so the user can hand files and folders
to an agent CLI (claude / codex / gemini) without typing paths by hand.

This is the "advanced" sibling of the existing `⌘P` `FileFinderDialog`: that one
is single-select, no preview, no recency, and opens an editor tab. The context
picker is multi-select, has a live preview pane, ranks by recency, and inserts
into a terminal's PTY instead of opening a tab.

### In scope
- Multi-select with selection chips.
- Recency ranking (mtime half-life + git-changed boost).
- Folder selection (inserts `@path/`).
- Live preview pane.
- Two triggers: `⌘I` shortcut (always) and `@`-key interception (toggleable, off by default).

### Out of scope (YAGNI)
- Cross-project / global search (the pi-agent reference's `Ctrl+G`). Workspace-scoped only.
- Inserting context into the CodeMirror editor. Context is an agent-terminal concept; the editor is not a target.
- Caching the file list across opens (refetch-on-open, matching `FileFinderDialog`).

## Target resolution: which terminal receives the insertion

Terminal tabs carry a `ptyId` on the `TerminalTab` type (set via
`patchTab(ws.id, tab.id, { ptyId })` in the app store). The insertion target
PTY is resolved with the same focus rule `⌘W` / `⌘T` / `⌘K` already use in
`useShortcuts.ts`:

1. If the bottom split (`[data-bottom-split]` ancestor) owns focus → the active
   bottom tab's `ptyId`.
2. Else if the active main tab is a terminal → its `ptyId`.
3. Else the first terminal tab in the workspace.
4. If no terminal tab exists at all → do not open; show a toast
   ("No terminal to insert into").

For the `@`-interception trigger, no resolution is needed: `TerminalPane`'s
`term.onData` already has its own `ptyId` in scope and passes it directly.

## Triggers

### Phase 1 — `⌘I` shortcut (robust core)

- Added to `useShortcuts.ts` alongside `⌘P`. `⌘I` (`i`, no shift) is currently
  unbound.
- No `isTyping` guard (xterm's hidden textarea always reports as typing, same
  rationale as `⌘P`). Requires an active workspace.
- Resolves the target PTY (see above), then calls
  `openContextPicker(wsId, ptyId)`. `preventDefault` always.

### Phase 2 — `@`-key interception (toggleable enhancement)

- Gated behind a new pref `contextAtTrigger`, **default `false`**.
- Implemented inside the existing `term.onData` callback in `TerminalPane.tsx`
  (line ~830), before the `ipc.ptyWrite`:
  - When `data === "@"` AND the cell immediately before the cursor in
    `term.buffer.active` is empty / whitespace, or the cursor is at column 0
    (a "word boundary"), then **swallow** the `@` (do not write it to the PTY)
    and call `openContextPicker(ws.id, ptyId)`.
  - Otherwise forward `@` normally.
- **Cancel** (Esc / dismiss): write the literal `@` back to the PTY so the
  keystroke the user typed is not lost.
- **Confirm**: the `@` is the leading character of the first inserted token, so
  nothing extra is re-added.
- The word-boundary check is heuristic (the agent's TUI owns the real cursor /
  prompt rendering). This is acceptable because the feature is opt-in and the
  `⌘I` path is always available as the reliable fallback.

## Components & files

### New
- **`src/lib/fuzzy.ts`** — `matchTerm`, `fuzzyScore`, and the `Scored` interface
  extracted verbatim from `FileFinderDialog`. `FileFinderDialog` is updated to
  import from here (its UX and scoring stay byte-for-byte identical). Single
  matcher shared by both pickers.
- **`src/components/dialogs/ContextPickerDialog.tsx`** — the new picker (see
  layout below).

### Modified
- **`src/components/dialogs/FileFinderDialog.tsx`** — import the matcher from
  `lib/fuzzy.ts` instead of defining it inline. No behavior change.
- **`src/store/ui.ts`** — add `contextPicker: { wsId: string; ptyId: string } | null`
  plus `openContextPicker(wsId, ptyId)` / `closeContextPicker()`, mirroring the
  `fileFinderWsId` pattern. Lives in the UI store so opening it does not churn
  the workspace tree.
- **`src/store/prefs.ts`** — add `contextAtTrigger: boolean` (localStorage key
  `contextAtTrigger`, default `false`) + `setContextAtTrigger`.
- **`src/hooks/useShortcuts.ts`** — add the `⌘I` handler.
- **`src/components/workspace/TerminalPane.tsx`** — add the `@`-interception
  branch inside `term.onData`.
- **`src/components/dialogs/Dialogs.tsx`** — mount `<ContextPickerDialog/>`.
- **`src/components/settings/General.tsx`** (Settings → General) — checkbox for
  "Open the context picker when you type @ in a terminal".
- **`src/lib/ipc.ts`** — wrapper for the new Rust command.
- **`src-tauri/src/lib.rs`** — new command + shared ignore-walk helper.

## Rust: file list with mtime

`workspace_list_files_for_finder` returns a flat `Vec<String>` with no mtime, so
recency ranking needs file modification times.

- New command **`workspace_context_files(id: String) -> Result<Vec<ContextFile>, String>`**
  where `ContextFile { path: String, mtime_ms: i64, is_dir: bool }`.
- The walk reuses the **same ignore rules** as
  `workspace_list_files_for_finder`. Extract a shared Rust helper so the two
  commands cannot drift (the finder keeps returning `Vec<String>`; the new
  command returns the richer struct). The walk includes directory entries
  (needed for folder selection).
- `mtime_ms` is epoch milliseconds; `is_dir` distinguishes folders for the
  trailing-slash insertion.
- IPC wrapper in `lib/ipc.ts`:
  `workspaceContextFiles(id) => invoke<ContextFile[]>("workspace_context_files", { id })`.

## Ranking

On open, fetch in parallel:
- `workspaceContextFiles(wsId)` → paths + mtime + is_dir.
- `workspaceChanges(wsId)` → the set of git-changed paths.

Score for a row = `fuzzyScore(path, query)` + recency boost:
- **Recency:** 14-day half-life on `mtime_ms` (pi-agent's constant). Normalize to
  0..1, weight at ~25% of the fuzzy match magnitude so a strong name match still
  beats a stale-but-fuzzier file.
- **Git-changed boost:** files in the `workspaceChanges` set get an additional
  flat bonus so "what I'm actively working on" floats to the top.
- **Empty query:** sort by recency (and git-changed) alone — the picker opens
  showing recently-touched files first.

`MAX_RESULTS` caps rendered rows (reuse FileFinder's value).

## Multi-select & insertion

- A `Set<string>` of selected relative paths.
- `Tab` or `Space` toggles the highlighted row in/out of the set.
- `↑` / `↓` move the highlight; highlight follows the mouse too (FileFinder
  convention).
- Selected rows render a check; a chips row above/below the input shows the
  count and selected names, removable by click.
- `Enter` confirms: inserts the selected set, or — if nothing is checked — the
  single highlighted row.
- `Esc` cancels (and, for the `@` trigger, re-emits the literal `@`).

**Insertion string:**
- Each path → `@<relpath>` token. Directories → `@<relpath>/` (trailing slash).
- Tokens are space-separated with exactly **one trailing space** so the user can
  keep typing.
- Spaces inside a path are **backslash-escaped** (`@my\ file.ts`). This is
  best-effort parity with Terminal.app / iTerm drag-drop; agent `@`-parsers vary
  in whether they honor the escape, so this is documented as a known limitation.
  The overwhelming majority of repo paths have no spaces.
- No leading space is prepended. The `⌘I` path is typically hit at a word
  boundary; the `@` trigger already sits at one.
- Write via `ipc.ptyWrite(targetPtyId, Array.from(new TextEncoder().encode(str)))`,
  then `closeContextPicker()`.

## Preview pane

- Debounced (~120 ms after the highlight settles) `workspaceFileRead(wsId, path)`.
- Client-side truncate to ~200 lines / ~10 KB before render.
- Null-byte detection → render "Binary file" instead of garbage.
- Strip ANSI / control characters before render (render safety).
- Fetch is cancellable: ignore results for a path that is no longer highlighted
  (same late-result-guard idea as the grep `searchId` pattern).
- For a highlighted **folder**, show a short child listing instead of file
  content.
- Relies on the file list already excluding `node_modules` / binaries, so reads
  stay cheap; no new byte-capped Rust read command in v1.

## Layout

Top-anchored Radix dialog (same vertical placement as `FileFinderDialog`,
`fixed top-12`), wider to fit two panes: `w-[min(880px,92vw)]`. Flexbox-centered
horizontally, no transforms on `Dialog.Content` (sub-pixel rule). Left column:
search input, chips row, scrollable results list. Right column: preview. Uses
`@theme` CSS vars and `cn()` throughout; file icons via `fileIconUrl` (same as
FileFinder). All inputs `spellCheck={false}` + `autoCorrect/Capitalize/Complete=off`.

## Performance & correctness guards

- Refetch-on-open, no persistent cache.
- `MAX_RESULTS` cap on rendered rows.
- Preview fetch debounced + cancellable.
- `⌘I` and the `@`-swallow both `preventDefault` / suppress the PTY write so the
  keystroke cannot double-fire.
- No new always-on global listeners: the `@` layer lives inside the existing
  `term.onData`; the picker state lives in the UI store.
- Round any pixel dimensions on write (sub-pixel rule), consistent with the rest
  of the app.

## Build order

1. **Phase 1 (complete, usable feature):**
   1. Extract `lib/fuzzy.ts`; repoint `FileFinderDialog`.
   2. Rust `workspace_context_files` + shared ignore-walk helper; `lib/ipc.ts` wrapper.
   3. `ui.ts` context-picker state.
   4. `ContextPickerDialog.tsx` — list + multi-select + recency + preview + insertion.
   5. `⌘I` in `useShortcuts.ts`; mount in `Dialogs.tsx`.
2. **Phase 2 (layered enhancement):**
   1. `prefs.ts` `contextAtTrigger` + Settings → General checkbox.
   2. `@`-interception in `TerminalPane.tsx` (swallow / open / cancel-re-emit).

## Acceptance criteria

- `⌘I` in a workspace with a terminal opens the picker; with no terminal, shows
  a toast and does not open.
- Typing filters with the shared fuzzy matcher; empty query shows recent /
  git-changed files first.
- `Tab` / `Space` multi-selects; chips reflect the selection.
- `Enter` inserts `@path` tokens (folders with trailing slash, spaces escaped,
  one trailing space) into the resolved terminal's PTY; the picker closes.
- Preview renders text files, flags binaries, and lists folder children, without
  janking the picker on large repos.
- `FileFinderDialog` (`⌘P`) behaves exactly as before.
- With `contextAtTrigger` on, typing `@` at a word boundary in a terminal opens
  the picker and swallows the `@`; cancelling re-emits it. With the pref off,
  `@` types normally.
