# UI

## Conventions

- Colors are `@theme` CSS vars in `index.css`. Accent terracotta `#d97757`, dark surfaces `#0a0a0a`-`#181818`. Never hard-code hex outside `@theme`.
- Ink on a solid **status/accent fill** must come from that fill's own `-fg` token, never `text-white`. On a `--color-accent` fill (count badges, filled CTAs, review-comment buttons, editor search checkmark, toggle knobs on an accent track) use `--color-accent-fg`; on a `--color-ok` fill (the AgentsSection toggle tracks) use `--color-ok-fg`. Do not reuse one for the other: a theme may pair a light accent with a dark ok. The accent is not guaranteed dark (cobalt sky 1.9:1, matrix green 2.5:1, rosepine rose 1.7:1 against white), so light-accent themes override the token to a dark ink. `--color-accent-deep` stays dark in every theme, so white text on it is fine, which is why the `:hover` states that drop to accent-deep flip back to white.
- `CliIcon cli={...}` + `CLI_BRAND_COLOR[cli]` for claude/gemini/codex (orange/blue/green).
- Tooltips default `delay: 0`. Override per-call.
- `cn()` from `@/lib/utils` for class composition.
- All `<input>` and `<textarea>` get `spellCheck={false}` + `autoCorrect="off"` + `autoCapitalize="off"` + `autoComplete="off"`. Developer tool — paths and commands are never English words.

## Settings layout

Left rail + one content pane (`components/settings/Settings.tsx`). Three bands, hairline-separated, then the per-project list:

1. **Opened by choice** (General, Appearance, Agents & Terminals)
2. **Set once** (Tasks, Notifications, Prompts, Shortcuts)
3. **The perimeter**, what the app is allowed to do (Sandbox, Termic CLI)
4. `PROJECTS`, the only band with a label, because it is a dynamic list needing an empty state

The bands are what the app looks like and runs, then how it behaves while you work, then what it is allowed to do. Sandbox sits low because of the last one, not because it matters least. General leads by convention rather than by that rule: it is app-level and set-once, but every settings UI opens on General and fighting that expectation costs more than the inconsistency does.

Appearance carries its own sub-tabs (Terminal, Editor, Interface) on the strip Settings → Projects uses. Terminal leads. Its live preview is a real `AuxTerminal`, so it is click-armed: a settings visit must never fork a shell on its own, and the pty dies when the tab unmounts.

Each page owns one domain, and a setting belongs to the page whose domain it changes, not the page that happened to be open when it was written. General is app-level only (repos directory, personal file-tree excludes, remote images in the markdown preview); it is deliberately short. A new setting that needs a fifth thing on General is a sign the domain wants its own rail item.

Sections share `Controls.tsx`: `Toggle`, `ListField`, `Block` (hairline + spacing), `SectionTitle`, and `useBackendSettings()`. Use the hook rather than calling `settingsLoad`/`settingsSave` directly: it caches the whole `Settings` object and merges patches into it, so one page saving one field cannot wipe another page's. Prefs (`store/prefs`) persist on change; backend `Settings` fields either persist on change through `patch()` or use an explicit Save button when the field is a multi-line list.

Deep links (`openSettings(tab, repoId, highlight)`) hard-code a tab name, so moving a setting between pages means updating its callers. Live ones: the markdown-preview banner (`general` + `load-remote-images`), the command palette's settings list, and the shortcuts help dialog.

### Experimental features

A feature is Experimental when it is off by default **because we are not yet confident in it**, with a stated way out. Off for safety (remote images), off for taste (copy on select), and off as policy (sandbox permission bypass) are none of them experimental: those defaults are permanent, and labelling them experimental makes the label meaningless.

It shows as a badge, on the rail item and next to the page title, not as a separate Labs page. The badge is dropped when the feature graduates: it survived a release with no bug reports against it and has e2e coverage. Graduating drops the badge and gets a changelog line; it does not move the page, because a settings page that moves twice is worse than one labelled honestly. A dedicated Experimental page only earns its place when several features qualify at once, which today they do not (there are no residents: the CLI graduated in 0.26.0, dropping the badge and flipping `cli_enabled` to default ON in the same change, since a badge that says "still settling" alongside a setting we ship enabled reads as a contradiction).

## Window chrome / drag

macOS overlay title bar, hidden title, 84px reserved left for traffic lights. Three drag mechanisms (each fails differently):

1. `data-tauri-drag-region` — primary (Tauri 2 JS handler)
2. `WebkitAppRegion: "drag"` — backup (native AppKit hint)
3. `onMouseDown → startDragging()` — escape hatch (imperative)

Opt-out with both `data-tauri-drag-region="false"` and `WebkitAppRegion: "no-drag"`. mousedown handler skips `button, input, [data-no-drag]`. `startDragging()` silently fails without `core:window:allow-start-dragging` in capabilities. No `user-select: none` on drag region — put it on inner text spans.

## Dropping a path into a terminal

Two gestures, one landing point (`lib/terminalDrop.ts`): every terminal host registers itself with `registerTerminalDropTarget`, and a drop types the escaped path into that PTY through `ipc.ptyWrite` — indistinguishable from typing it.

- **From Finder** — Tauri's native `onDragDropEvent` (the DOM `drop` never fires, and WKWebView would not expose the real path anyway). Absolute paths, physical-pixel drop point. A drop on a **sandboxed** agent asks first: stage into TMPDIR, or allow the file/folder (needs an agent restart).
- **From the file tree** (GH #136) — a pointer drag (`startPathDrag`), same as the tab strip: **never HTML5 DnD**, which is unreliable in WKWebView and gets intercepted by Tauri's file-drop. Inserts the path relative to the task root (falls back to absolute for another task's terminal); no sandbox prompt, since the worktree is already granted.

Both share the hit test and the `.termic-drop-target` highlight, so they agree on where a drop lands.

## Close vs Quit (windowless mode)

Standard macOS app semantics, added as a prerequisite for the CLI's windowless daemon mode:

- **Close** (red button; ⌘W is "close active tab", not the window) → routed by the `close_action` setting. `CloseRequested` is ALWAYS prevented first, then Rust decides:
  - unset / `"ask"` (default) → emits `termic://close-requested`; `CloseDialog` asks **Keep in Menu Bar** / **Quit Termic**, with "Don't ask again" writing the choice back to `close_action`.
  - `"menubar"` → straight to windowless, agents keep running.
  - `"quit"` → teardown.

  Anything unrecognised falls back to **ask**, never to quit (`close_action_from`, unit-tested): a corrupt or hand-edited settings file must not be able to start killing agents.

  Settings › General exposes all three as a select. It has to include "Ask me each time", because ticking "Don't ask again" in the prompt is otherwise a one-way door.

  `CloseDialog` is deliberately NOT built on `ConfirmDialog`, which folds dismissal into cancel — whichever action sat on cancel would also fire on Escape. It has three outcomes instead, and **dismissal cancels the close entirely** (window stays as it was), so Esc can neither quit nor be the only route to quitting.
- **Quit** (⌘Q or the menu-bar item) → the only teardown path: `RunEvent::Exit` → `cleanup_children` SIGKILLs every PTY and script group.
- **Dock icon** click on a windowless app reopens it (`RunEvent::Reopen`). Unhandled before, but moot then: closing the window quit the app outright, so there was nothing to reopen.

This is a deliberate behavior CHANGE, not a bug fix. Previously closing the last window quit Termic and killed every running agent (tao destroys the window → Tauri fires `ExitRequested` → unprevented → exit). The teardown comment in `lib.rs` claimed the app survived a last-window close; that was wrong, verified empirically.
- **Menu-bar item** opens a menu on click (either button): **Show Termic** / separator / **Quit Termic**. No bare left-click "show" shortcut — that would leave Quit reachable only by right-click, which is undiscoverable for the one action that stops your agents. The separator keeps Quit off the muscle-memory path. It has no setting, deliberately. Its presence IS the signal "Termic is running without a window": shown when the window goes away, hidden on restore. A preference would only control whether it also sits there during a normal windowed session, which adds chrome and says nothing. `enter_windowless` refuses to drop the dock icon (`Accessory`) unless the item actually came up, so the app always has a way back.
- `termic`'s auto-launch passes `--headless`, which boots straight into windowless: no window, no dock icon. An instance that has never shown a window stays `ActivationPolicy::Accessory`; once the user has seen one, the dock icon persists for the process lifetime (Mail/Messages behavior).

The webview stays ALIVE while windowless — it owns PTY lifetime and every work-state signal, so tearing it down would kill the agents. It is not suspended (WebKit only clamps timers to 1 Hz). What windowless mode DOES have to do is collapse the task panes to zero geometry, or xterm keeps drawing for an invisible window: see docs/performance.md bear trap 2b and `src/lib/windowlessMode.ts`.

## Right-panel tabs (All files / Git)

**Git** is one surface with three parts: the working tree at the top (Fork-style staging), a **Changes / Compare** switch on its toolbar, and at its foot a collapsible **Graph** section holding what has already been committed (issue #199). Changes answers "what can I stage right now". Compare answers "what does all of it add up to next to another branch" (issue #208): one list of every path that differs between a chosen ref and the working tree, committed and uncommitted alike, because an agent that split a feature over six commits leaves nothing in the staging view to read.

The graph was its own third tab when it landed, and the staging tab was renamed "Commit" then because two git surfaces made "Git" ambiguous. Folding them back together (GH #208) makes "Git" right again. The graph moved inside it because the two answer halves of one question, "what is in this branch", and a tab switch made it impossible to read a commit and its uncommitted follow-up at the same time. It starts collapsed (one header row): this tab is opened to stage and commit, and an expanded graph costs a `git log` per repo. Expanded, it takes half the body and the two file lists share the rest, with a drag handle between them; the split and the collapse both persist (`gitGraphCollapsed`, `gitGraphRatio`).

The graph follows the Git tab's repo pills rather than drawing its own, so a multi-repo task cannot end up with two repo selectors disagreeing. Its scope picker rides the Graph header rather than a row of its own: the branch is already on the BranchBar at the top of the tab, so a second chip repeating it spent a row saying nothing new. The picker's label is what is being SHOWN (the branch name under Auto, "All", or the picked ref / count), not the name of a mode.

The graph is modelled on VS Code's Source Control Graph: one dense row per commit — lane gutter, ref chips, subject, age — clicking a row expands it into the files that commit touched, and clicking a file opens a diff of THAT revision (`scope: "commit:<sha>"`, both sides read out of the object store). Lane maths is a pure function in [`lib/gitGraph.ts`](../src/lib/gitGraph.ts) (unit-tested; the panel only renders what it returns), lane colours come from the `--color-palette-*` tokens so every theme recolours the graph for free, and the gutter is clipped at 6 lanes because a 220px panel cannot spend its width on a wide graph. A row's subject is indented to its OWN lane (`textIndent`, clamped the same way the dot is), so a branch's rows read as one indented run instead of a column of text detached from the lines beside it.

**Scope** is a ref picker, not a toggle: All, Auto (the checked-out branch alone, the default, labelled with that branch's name), then the repo's branches, remote branches and tags, each with the sha it points at, multi-select and filterable. It replaced a single button reading "This branch", which was both a state and an invitation to click with no way to tell which, and which could not express "these two branches together" at all. Picked refs are allowlisted against the repo's real refs before they reach a `git log` argv (see [ipc.md](ipc.md)).

Two things the graph deliberately does NOT do: it shows no review affordances on a historical diff (both "Mark as viewed" and review comments address the file an agent is about to edit, and neither side of a commit diff is that file), and it hides the unpushed markers entirely when the branch has no upstream, where "not pushed" would be true of every commit and mean nothing. An unpushed commit is marked with a small filled dot before its subject, the way Fork does it: at this row height an arrow glyph read as a clickable control, and a column of them read as a toolbar.

Compare exists because neither of the other two could answer the question an agent's work actually raises: split a feature across six commits and the Commit tab goes empty while History shows six rows nobody wants to read one at a time. It is one flat list of every path differing between a chosen ref and the working tree — committed, staged, unstaged and untracked together — because "how does this branch read next to that one" does not care which of those a change happens to be in. It is a GENERIC ref-to-ref compare, not a PR view: any local or remote-tracking ref can be the base, and the task's own `base_branch` is only what the picker opens on.

Three deliberate choices there. The comparison runs from the **merge base** by default (`base → branch` in the bar, a "direct" chip when that is switched off), because a two-dot diff renders every commit the base gained since the branch point as a deletion the task never made — the most confusing thing a compare view can do. The rows are the Commit tab's rows minus the stage arrow and plus a churn column, sharing its stored view mode via `flattenRows`, so moving between the two tabs never asks you to relearn a row; folders carry no stage/discard action, since half of what the list shows is already committed and a control applying to only the other half would be a trap. And unlike History it KEEPS the review affordances (viewed marks, inline comments): the right side of a `base:<sha>` diff is the live file, so a fingerprint is real and a comment lands on the version about to be edited. There is no changed-file badge on the tab, and that is a perf choice — a badge would mean running the comparison on every status poll for every task, including the tabs nobody has open.

## Right-panel footer (Setup / Run / Terminal)

Three tabs. Setup + Run stream via `useScriptRuns`. Terminal is opt-in: click `+` → `useApp.enableFooterTerm(wsId)` → AuxTerminal mounts. RunToolbar: Open (expands `project.preview_url` with `$TERMIC_PORT`/`$CONDUCTOR_PORT`/`$PORT`/`$TERMIC_WORKSPACE_NAME`) + Run/Stop (SIGTERMs process group). Default: tab=Run, expanded.

`task_archive` sweeps `RUNNING_SCRIPTS` and SIGTERMs each before teardown.

## Inline review comments (two surfaces)

`reviewCommentsExtension(taskId, file, surface)` is one component with two loudness settings, because the same gesture means different things in the two places it runs.

- **Diff pane** (default `{ selection: "pill", hoverGutter: true }`) — reviewing IS the job, so a selection raises a labelled "＋ Comment on lines 12-40" pill and every line offers a hover button.
- **Code editor** (`{ selection: "gutter", hoverGutter: false }`) — you are reading and typing, so both of those read as a second cursor. One dim gutter icon, on the selection's first line, only while a selection stands. ⇧⌘L is the keyboard route (see [shortcuts.md](shortcuts.md)).

The composer has two exits, because a remark on code is sometimes the whole thought and sometimes one of five:

- **Send** (accent CTA, also ↵) ships THIS one immediately and never touches the queue. The comment body is optional there: the selected code alone is a legitimate message.
- **Add to pending** queues it. Queued remarks from the editor and the diff share one list (both key by `file`), and the pending-comments bar sends the batch as ONE message.

Both routes go through `sendCommentsToAgent` (`lib/sendComments.ts`) — one delivery path, so target resolution, the `lastInputAt` stamp that re-arms work-done detection, the focus handover and the toast cannot drift between the two entry points. Editing an already-queued comment offers Update only: it is in the queue, and the bar is where a queue gets sent. Every message carries the fenced code, not just a location line.

The editor's gutter column collapses to zero width while there is nothing to put in it (no selection, no comments for the file). A gutter costs its width on every line forever, and an editor is read far more than it is commented on — 20px of permanent horizontal room made files, markdown especially, start scrolling sideways sooner than they used to. The diff keeps a fixed column: it shows a button on every hover, so a width appearing and disappearing under the mouse would be worse than the space.

While an editor is open, each queued comment keeps the actual selection it was made on as document offsets, mapped through every edit (`lib/commentAnchors.ts`) and written back to the store debounced. Type three lines above a queued comment and its stored range follows the code instead of pointing at whatever now occupies the old line number. The association pair is deliberate: `from` maps with +1 and `to` with -1, so the range does not swallow text typed at its edges. Note the anchor tracks the BUFFER; comment on unsaved edits and the agent, which reads disk, sees something different.

## Settled detection / notifications

TerminalPane samples `term.buffer.active` every 3s, FNV-1a hashes the visible viewport, marks tab "settled" after 2 identical consecutive samples. Resets on user input. `markAttention(wsId, tabId, reason)` never marks the active tab in the active task. `useAttentionNotifier` suppresses OS notifications for every tab in the focused task. Desktop notifications off by default. Clicking a banner only brings the window forward: it never changes the active task or tab (the old focus-edge router jumped on any refocus within 15s of a notification, including a plain cmd-Tab). The unread dot is what points at the tab; the user does the switching.
