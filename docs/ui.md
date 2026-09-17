# UI

## Conventions

- Colors are `@theme` CSS vars in `index.css`. Accent terracotta `#d97757`, dark surfaces `#0a0a0a`-`#181818`. Never hard-code hex outside `@theme`.
- Ink on a solid **status/accent fill** must come from that fill's own `-fg` token, never `text-white`. On a `--color-accent` fill (count badges, filled CTAs, review-comment buttons, editor search checkmark, toggle knobs on an accent track) use `--color-accent-fg`; on a `--color-ok` fill (the AgentsSection toggle tracks) use `--color-ok-fg`. Do not reuse one for the other: a theme may pair a light accent with a dark ok. The accent is not guaranteed dark (cobalt sky 1.9:1, matrix green 2.5:1, rosepine rose 1.7:1 against white), so light-accent themes override the token to a dark ink. `--color-accent-deep` stays dark in every theme, so white text on it is fine, which is why the `:hover` states that drop to accent-deep flip back to white.
- `CliIcon cli={...}` + `CLI_BRAND_COLOR[cli]` for claude/gemini/codex (orange/blue/green).
- Tooltips default `delay: 0`. Override per-call.
- `cn()` from `@/lib/utils` for class composition.
- **Dialog mode switches ride the TITLE line** (`titleAction` on `AppDialog`, spread `dialogTitleAction` onto the control). "Import a worktree", "From a GitHub issue", "Blank task instead" and "New worktree instead" change what KIND of thing the dialog is making, which is chrome, not a field, and as form rows they cost a `gap-4` row each on every open of a dialog most of whose opens have nothing to do with them. The title line is mostly empty, so they are free there. Two rules for anything you put in that slot: it is inside the window drag region, so it must carry the `data-tauri-drag-region="false"` + `WebkitAppRegion: "no-drag"` opt-out that `dialogTitleAction` provides (without it the control is not clickable at all), and the labels stay SHORT because worktree mode can show two switches at once. The row wraps rather than truncating, so the pathological case degrades to the row it used to cost instead of clipping.
- **Focus indicator: one rule, `src/index.css`, `@layer base`.** A single `:where(a[href], button, summary, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])):focus-visible` gives every control a 2px `--color-accent-soft` outline at `outline-offset: -2px`. The negative offset draws it INSIDE the border box, so a control sitting flush against a container edge cannot have it clipped (the sandbox picker's first card, which its dialog autofocuses, was the case that forced this). `:where()` makes it zero-specificity, so any component overrides it just by saying so. Do NOT add a per-component `focus-visible:ring-*`: `src/lib/focusRing.test.ts` fails if one appears. Text fields opt out with `outline-none` and signal focus with a border instead, as do Radix menu items (`data-highlighted`) and dialog containers (Radix focuses the content on open).
- All `<input>` and `<textarea>` get `spellCheck={false}` + `autoCorrect="off"` + `autoCapitalize="off"` + `autoComplete="off"`. Developer tool — paths and commands are never English words.

## Settings layout

Left rail + one content pane (`components/settings/Settings.tsx`). Three bands, hairline-separated, then the per-project list:

1. **Opened by choice** (General, Appearance, Agents & Terminals)
2. **Set once** (Tasks, Notifications, Prompts, Shortcuts)
3. **The perimeter**, what the app is allowed to do (Sandbox, Termic CLI)
4. `PROJECTS`, the only band with a label, because it is a dynamic list needing an empty state

The bands are what the app looks like and runs, then how it behaves while you work, then what it is allowed to do. Sandbox sits low because of the last one, not because it matters least. General leads by convention rather than by that rule: it is app-level and set-once, but every settings UI opens on General and fighting that expectation costs more than the inconsistency does.

Appearance carries its own sub-tabs (Terminal, Editor, Interface) on the strip Settings → Projects uses. Terminal leads.

A per-project page carries four of those sub-tabs: Scripts & run (Members & scripts on a multi-repo project), Sandbox, Code navigation and More. Code navigation is named by `codeIntelName()`, so it reads Code intelligence once type checking is on, exactly like the panel it opens. It earned a tab rather than sitting under Scripts & run, where it started: it shares nothing with the setup/run/archive scripts that tab exists for, it is the size of a page on its own (arming, languages, the server picker, per-language settings), and it is machine-local `projects.json` while that tab's storage strip is switching between personal and the committed `.termic.yaml`. Its live preview is a real `AuxTerminal`, so it is click-armed: a settings visit must never fork a shell on its own, and the pty dies when the tab unmounts.

Each page owns one domain, and a setting belongs to the page whose domain it changes, not the page that happened to be open when it was written. General is app-level only (repos directory, personal file-tree excludes, remote images in the markdown preview); it is deliberately short. A new setting that needs a fifth thing on General is a sign the domain wants its own rail item.

Sections share `Controls.tsx`: `Toggle`, `ListField`, `Block` (hairline + spacing), `SectionTitle`, and `useBackendSettings()`. Use the hook rather than calling `settingsLoad`/`settingsSave` directly: it caches the whole `Settings` object and merges patches into it, so one page saving one field cannot wipe another page's. Prefs (`store/prefs`) persist on change; backend `Settings` fields either persist on change through `patch()` or use an explicit Save button when the field is a multi-line list.

Deep links (`openSettings(tab, repoId, highlight)`) hard-code a tab name, so moving a setting between pages means updating its callers. Live ones: the markdown-preview banner (`general` + `load-remote-images`), the command palette's settings list, and the shortcuts help dialog.

### Settings text runs the full width of the pane

**Never put `max-w-prose`, `max-w-md` or any other width cap on body text in a
settings page.** The content pane already sets the measure; a second cap inside
it wraps a paragraph at roughly half the pane's width and leaves an obvious
empty column to its right. Grep says it plainly: no settings section uses a
width utility on text, and every one that ever did was a regression.

It keeps happening because `max-w-prose` is genuinely good advice for a
full-bleed page and is the reflex when writing a description paragraph. It is
wrong HERE, because the pane is not full-bleed: it has already been narrowed
once. The two constraints multiply.

The same goes for `mx-auto max-w-*` on an empty state. Center the BOX, not the
sentence inside it.

If a paragraph genuinely reads too wide, the answer is the pane's own measure
in `Settings.tsx`, once, for every page: not a cap on one paragraph, which
makes that page disagree with the twelve beside it.

### Experimental features

A feature is Experimental when it is off by default **because we are not yet confident in it**, with a stated way out. Off for safety (remote images), off for taste (copy on select), and off as policy (sandbox permission bypass) are none of them experimental: those defaults are permanent, and labelling them experimental makes the label meaningless.

It shows as a badge, on the rail item and next to the page title, not as a separate Labs page. The badge is dropped when the feature graduates: it survived a release with no bug reports against it and has e2e coverage. Graduating drops the badge and gets a changelog line; it does not move the page, because a settings page that moves twice is worse than one labelled honestly. A dedicated Experimental page only earns its place when several features qualify at once, which today they do not (there are no residents: the CLI graduated in 0.26.0, dropping the badge and flipping `cli_enabled` to default ON in the same change, since a badge that says "still settling" alongside a setting we ship enabled reads as a contradiction).

## The new-task launcher's CLI order

The project `+` menu (`sidebar/ProjectActionsMenuItems.tsx`) and the New Task
dialog's Default CLI pills list the same thing: every offered agent, then
Terminal. Both hoist **this project's** default CLI to the front
(`defaultCliFirst` in `lib/agents.ts`, unit-tested), and the menu marks that
row `default`.

Two orders are in play and they answer different questions. Settings → Agents
& Terminals is a global preference ("which agents do I care about, in what
order"), and dragging its pills reorders that list for the whole app. Which
agent a given repo starts with is a per-project answer stored as
`Project.default_cli`, and in a launcher that one wins: the first row is the
one people click without reading, so it has to be the pick they configured,
wherever that agent happens to sit in the registry. Terminal takes part like
any other row (a repo defaulting to a plain shell gets it hoisted too), rather
than being pinned to the tail.

Rows carry `data-launcher-cli="<id>"` so tests can assert the order by id
instead of by display name.

## Run state in the sidebar

A run tab's controls live in its tab pill (restart + a red Stop while the PTY
is up, a Play once it exits, `TabBar.tsx`). The sidebar's child row for that
tab carries the Stop half as well: a live run is otherwise invisible from any
other task, and the only way to end it is to go back into the task that owns
it.

Both read the same thing, `tab.ptyId`, which TerminalPane clears on process
exit: red Stop while the run is up, quiet Play once it is not.

A COLLAPSED task header carries those same controls itself, inline right after
the name and the terminal count. Collapsing hides the child row that would
otherwise offer them, which is exactly when a run is hardest to notice and to
stop, so `RunTabControl` renders in whichever of the two places is on screen
(never both, so its testids stay unique). Three constraints shape it:

- **Inline, not in the trailing slot.** That column is the status badge and the
  kebab; a third icon there reads as one of them.
- **One button per run tab, capped at `COLLAPSED_RUN_BUTTON_CAP` (3).** A task
  can hold several runs at once (a multi-repo task runs one per member, custom
  run commands add their own, and a setup tab is a third kind), so a single
  button cannot stand for "the" run. Past the cap the header shows none and the
  task expands to reach them, which is what the tab strip makes it do anyway.
- **An instant `Tip`, not a native `title`.** On a collapsed row the button is
  the only thing naming the process it kills, and a tooltip that arrives a
  second later is no use to a cursor already on its way to the click. It holds
  the tab's name alone: a verb in front reads "Run Run" on the tab that is
  actually called Run, and the icon already says stop from start.

Play has a wrinkle Stop does not. The restart travels as a
`termic-run-tab-restart` window event, and the only listener is the tab's
`RunPane`, which exists solely under a mounted `TaskView` — so the row brings
the task up and fronts the run tab first. Whether it then fires the event
depends on what mounting already did: an already-mounted task needs it (its
pane is sitting on a finished run, and only the remount respawns), a task that
was NOT mounted spawns the run as `RunPane` mounts and firing as well would
kill that spawn to redo it, and the exception is a tab restored `idle`, whose
pane shows a play placeholder and waits for exactly this event. The dispatch is
deferred by a `setTimeout`, not a `requestAnimationFrame`: a just-mounted
listener has to be attached first, and rAF is frozen on an occluded window (see
[gotchas.md](gotchas.md)).

## What a task is called (name vs branch)

A task's label is decided in ONE place, `taskLabel()` in
[src/lib/taskLabel.ts](../src/lib/taskLabel.ts). By default it is the title
typed at creation. With `useBranchAsTaskName` on (Settings -> Tasks, off by
default, GH #260) a WORKTREE task is labelled by its branch instead, in the
sidebar row, the breadcrumb, the command palette, the archive and sandbox
dialogs, the Dashboard, the race board and the desktop notification title. New
surfaces that name a task go through the same helper: a place that reads
`task.name` directly is a place that disagrees with the sidebar.

Three rules the helper encodes, all load-bearing:

- **Only a worktree task is relabelled.** A plain-folder task has no branch
  (`""`), a detached checkout records the literal `"HEAD"`, and a main-checkout
  task is excluded even though `task_open_repo` does record a branch for it:
  that branch is the shared checkout's HEAD, so it reads `main` in every
  project and moves under the task whenever anyone runs `git checkout` there. A
  worktree's branch was cut FOR that task, which is the issue's whole premise.
  All three fall back to the typed name, which is also the guard against
  rendering an empty row.
- **The typed name is never overwritten.** It stays on the record, it is what
  rename edits, and it stays reachable in the row tooltip. The pref is a
  display choice, not a migration.
- **The branch is the one frozen on the worktree task's record**, the same
  value the breadcrumb has always shown. Checking out a different branch in the
  worktree does not rewrite it (`task_git_checkout` writes git, not the
  record), so a task whose HEAD has moved still shows the branch it was cut
  on. Resolving live HEAD instead would mean a git call per sidebar row on
  every render, which is not a trade this app makes.

Where the label already sat next to the branch, it collapses rather than
repeats it: the breadcrumb's `<name> on <branch>` and the Dashboard row's
identical shape both drop the "on" clause when the label IS the branch. That
is the same collapse `task.name === task.branch` has always triggered for a
task the user never renamed.

`task.name` is still the right field for anything that is data rather than a
label: `TERMIC_WORKSPACE_NAME` and the agent env slugs, PTY log filenames, and
the agent briefing all keep the typed name whatever the pref says.

## Task type on a plain-folder project

"Worktree" needs branches, so a project pointing at a plain folder can only
run in its main checkout. That is a **single-repo** rule, and the three
surfaces that enforce it (the New Task dialog's Task type toggle, the sidebar
`+` menu, and `parseDeepLink`) all draw the line at
`non_git && type !== "multi"`.

A multi-repo project is different: the members are the git repos, and the host
is only where the shared `CLAUDE.md` / `.claude` live. `task_create_multi`
already handles a plain-folder host by creating the wrapper directory itself
and symlinking those shared files in, then worktreeing each git member under
it exactly as it would under a git host. Clamping such a project to the main
checkout takes its whole per-member list away, which is what happened when the
dialog started gating the member rows on the task type. What a plain-folder
host really loses is the HOST-level "Branch from" pin (there are no host
branches to pin); the members keep their own, in the dialog's member list.

## Starting a task from an issue (GH #21/#22)

One flow, two doors, and the SAME `NewTaskDialog` behind both:

- **Command palette → "New task from an issue…"** → the shared project picker
  (`openProjectPicker("issue")`; the placeholder tells you which question you
  are answering) → `openNewTask(projectId, { issueMode: true })`.
- **Inside the dialog**, the "From a GitHub/GitLab issue" switch on the title
  line, which is the same `enterIssues()` the seed triggers.

It is deliberately not a dialog of its own. "Which project" is the first
question either way, and everything after the issue is picked (task type,
branch, CLI, sandbox) is the ordinary New Task form. A second dialog would have
had to grow all of it back.

The palette row is NOT gated on any project being on a forge: no project is
chosen at that point, and resolving every project's remote to decide whether to
draw a row would be a `git remote get-url` per project. A repo that turns out
not to be on a forge gets told so, by name, in the issue column
(`unsupported-remote` / `no-remote` / `cli-missing` / `cli-unauthed` each carry
their own copy) rather than being shown an empty list, which would read as "no
open issues" and mean something else entirely.

### The issue picker is a COLUMN, not a field

It sits beside the form as a second pane, the same treatment the sandbox config
gets, and the two compose: with both open the dialog is three columns (see the
`className` width math in `NewTaskDialog.tsx` - N columns is `N*base - (N-1)*0.5`
rem, and only literal Tailwind classes survive the source scan, so each width is
written out). Issues come BEFORE sandbox because picking one writes into the
fields beside it; the cage is set-and-forget.

It was inline above the form first. That put a 220px scrolling list inside a
dialog you were already scrolling, and hid the effect of a pick below the fold.

### A pick fills the form; it does not send anything

Picking an issue writes **Name**, **Branch** and **Initial prompt**, all three
still editable, and Create is still the only thing that acts.

The prompt is the part that changed: there used to be a second seeder in the
dialog (`seedIssue`) that composed `buildIssuePrompt(issue)` and typed it at the
agent after create, so the first message an issue task ever sent was one the
user never saw. It now lands in the Initial prompt box that already existed for
deep links (GH #192), which makes the box the preview, and lets you add the
sentence of steering an issue nearly always needs. There is exactly ONE seeder
in the dialog now (`seedFirstMessage`), which matters beyond tidiness: two of
them poll the same default tab and write to the same PTY, and `sendMessageToPty`
writes text then a CR shortly after, so two interleave into one line followed by
two Enters.

`buildIssuePrompt(issue, maxChars?)` takes a budget because the box caps what it
will send (`MAX_PROMPT_CHARS`). What gives is the issue BODY, never the tail:
the instructions are the ask, and the body is context the agent can re-read in
full with the `gh/glab issue view --comments` command already in the prompt.

The prompt's instruction half is `builtin:work-issue` from the prompt library,
read live, so editing it there changes every future issue task
(`src/lib/issuePrompt.ts`).

A plain shell or registry terminal has no prompt box, so the composed prompt has
nowhere to go: the column says so at the point the issue was chosen rather than
letting Create drop it silently.

## Title bar contents, and what moved out of it

Left to right: traffic lights (reserved unless full-screen), sidebar toggle,
the profile chip, the updater pill, the waiting-agents pill, then the task
breadcrumb.

The bar carries the current profile's accent as a wash from the left edge,
fading out by the first third (`profileWashCss`, docs/profiles.md). The chip
sits inside that wash, so the colour and the name are one signal rather than
two. Nothing else in the bar may take a background of its own: a tinted surface
inside a tinted one reads as a rendering fault.

**The theme picker is NOT here.** It lives in the sidebar footer, first in the
row, and moved there when the profile chip took the space. It is a set-once
preference; the title bar is the strip you drive agents from. Anything proposed
for this bar has to earn its width against the breadcrumb, which is the thing
people actually read.

### The folder button is a picker, not one action

`OpenWithButton` replaced a fixed "Open in Finder". Left half launches the app
picked last, a 14px chevron opens the menu of everything detected. Finder is
first in the list and the default, so the old behaviour is one click away and
nothing that worked stopped working. It earns the extra width because a git
worktree is rarely something you want in a file manager: the tools you want on
one are an editor or a terminal.

Three things about it are load-bearing:

**The app list is fetched on first menu open, never during render.** Detection
is a Rust call that stats `/Applications` (and on Linux walks the login shell's
PATH, which blocks), and this component repaints whenever the active task
changes. A render-path fetch is performance.md bear trap 5 here.

**Which means the button cannot know whether the remembered app still
exists, so it does not try.** It renders from the preference alone, and
`open_with_app` rejecting is what triggers the recovery: toast, then revert the
pick to the file manager. That is also the only correct answer for an app
deleted while the menu was open, so it is not a second-best fallback.

**The preference stores the label and kind, not just the key**
(`openWithApp` in localStorage, decoded once at store init by
`parseOpenWithPick`). That is what lets the button paint its icon and tooltip
with zero IPC. Decoding in a selector instead would mint a fresh object per
store notification and re-render the bar on unrelated prefs writes.

Icons are per GROUP, not per app (`FolderOpen` / `Code2` / `SquareTerminal`):
lucide has no Cursor or Warp glyph, and eight brand SVGs is a bigger change
than the feature. The label carries the identity, the tooltip spells it out.

Deliberately NOT extended to the file context menus (`CopyPathItems`,
`TerminalPathMenu`). Those act on a FILE and already have "Open in default
app"; this acts on the task root. `ContextMenuItem` also drops `data-*`
attributes, so its rows cannot carry a test id.

## Window chrome / drag

macOS overlay title bar, hidden title, 84px reserved left for traffic lights. Three drag mechanisms (each fails differently):

1. `data-tauri-drag-region` — primary (Tauri 2 JS handler)
2. `WebkitAppRegion: "drag"` — backup (native AppKit hint)
3. `onMouseDown → startDragging()` — escape hatch (imperative)

Opt-out with both `data-tauri-drag-region="false"` and `WebkitAppRegion: "no-drag"`. mousedown handler skips `button, input, [data-no-drag]`. `startDragging()` silently fails without `core:window:allow-start-dragging` in capabilities. No `user-select: none` on drag region — put it on inner text spans.

## Activity window (per-agent CPU / memory)

A SECOND window (label `procmon`, its own Vite entry `activity.html`), opened from the pulse icon in the sidebar footer or the palette's "Activity monitor". Not a modal, and that is the whole design: the numbers only mean something while you drive the agent that moves them, which a modal over the app makes impossible. Rows are grouped project → task → tab, with Termic's own processes in their own group at the bottom.

Every column header sorts (`activityGroups.ts`), default CPU descending, and a group sorts by the aggregate of whichever column is active. Two rules there are not obvious and both exist because the table was unreadable without them:

- **The CPU sort key is a short average, while the displayed number stays instantaneous.** Ordering on the instant makes near-equal rows trade places every tick, which is precisely when several agents are busy and you need to read the table.
- **The tie-break must be TOTAL** (name, then row key). Two idle claude tabs in one task tie on every column, and a comparator that returns 0 leaves them in snapshot order, i.e. Rust's `HashMap` iteration order — rows visibly reshuffling while nothing happens.

There is no expand affordance. PID is its own (sortable) column, and the per-child process breakdown a tree can have lives in the row's tooltip: for a one-process row, which is most rows, expanding only repeated the Process and PID columns.

Three things to know before touching it:

- **It has no capabilities.** `capabilities/default.json` is scoped `"windows": ["main"]`, so this window gets no core-plugin permissions: no `data-tauri-drag-region` (it keeps a NATIVE title bar, which is what you grab), no `startDragging`, no window-close from JS. App-defined `#[tauri::command]`s are outside the ACL and work fine, which is all the monitor needs. Anything plugin-backed you add here needs a second capability entry first.
- **Its own entry point, not a branch inside `main.tsx`.** `activity.html` → `src/activity.tsx` → `ActivityWindow.tsx`, which keeps xterm, the WebGL addon and CodeMirror out of the monitor's webview entirely (14 KB entry chunk + the shared React chunk, versus the app's 2.3 MB). A window whose job is reporting memory should not be the second-biggest consumer of it.
- **Snapshots never touch a Zustand store.** They live in local state in `ActivityWindow`. A 1 Hz write into `app.ts` would copy its ~233 keys and re-run every mounted task's selectors, i.e. the monitor would become the regression (docs/performance.md bear trap 8).

Theme comes from importing `@/store/prefs` (the module applies the persisted palette's CSS vars at load, and localStorage is shared across windows of the same origin). Zustand state does NOT cross webviews, so a theme change in the main window reaches this one when it next opens.

**Row names come from the main window, on request** (`lib/activityTitleBridge.ts`). A tab's displayed title is `customTitle ? title : (liveTitle || title)`, and `liveTitle` (the agent's OSC title) lives only in the main window's JS memory, never on disk — so Activity emits `activity://request-titles` and the main window answers with a `tabId -> title` map. Three details are load-bearing:

- **The request rides the sample tick, not `loadMeta`'s every-tenth.** The project/task lists are disk reads and genuinely slow-moving; a title is the one piece of metadata here that changes while you watch it, because an agent rewrites its tab title as it works. On the every-tenth cadence an occluded window lagged 50 s behind, which is also how the e2e case for it flaked.
- **A reply identical to the last one is dropped before it reaches React** (`sameTitles`). Nearly every reply is unchanged, and passing a fresh object identity through once a second would re-run `groupRows` for nothing — the cross-window twin of [performance.md](performance.md) bear trap 8.
- **A bridged title applies even to a tab absent from `persisted_tabs`.** The task list is re-read from disk on the slow cadence, so a just-opened task's tabs can still be missing from it while the main window is already showing their titles. Gating the overlay on the persisted array made such a row read "Agent · bash" until the next re-read.

`emit`/`listen` are the core `event` plugin, so — unlike a plain `#[tauri::command]` — they ARE capability-gated per window (`capabilities/procmon.json`). A dropped permission fails silently, with titles quietly reverting to the "Tab N · claude" fallback, which is why both sides log a broken bridge through `log_line`.

## Top-bar tooltips that name a shortcut

`CommandPaletteButton.tsx` opens the right-hand cluster in `UnifiedBar.tsx`, before Run and the rest of the task-scoped actions (a divider separates it from them), and renders with or without a task (the palette's global commands do not need one). The palette button is a bare icon (`SquareChevronRight`, the ">" prompt) matching its neighbours: the shortcut lives in the tooltip only, built from the LIVE `command-palette` binding via `bindingGlyphs` rather than a hard-coded "⇧⌘P", so a rebind retitles it. An earlier version printed the glyphs on the button face as a bordered chip, which read as a foreign element in a row of bare icons.

Prompts (⌥⌘P, the searchable palette over the same list) and the right-panel toggle (⌥⌘B) get the same treatment through the local `tipWithKey(text, id)` helper in `UnifiedBar.tsx`, which appends the live glyphs or nothing. Wrap the tooltip OUTSIDE a `DropdownTrigger asChild` (`<Tip><DropdownTrigger asChild><Button/></DropdownTrigger></Tip>`), and give that menu `onCloseAutoFocus={e => e.preventDefault()}` or the focus snapping back to the trigger re-fires the tooltip and leaves it stuck open.

The palette button toggles on `pointerdown`, not `click`, and that is load-bearing: the palette is a non-modal Radix dialog whose dismissable layer closes it on document pointerdown, so a click handler reading `commandPaletteOpen` always sees `false` and reopens what the user just dismissed. `onClick` remains as the keyboard path (Enter / Space fire no pointer event) and no-ops when pointerdown already handled the press.

## Dropping a path into a terminal

Two gestures, one landing point (`lib/terminalDrop.ts`): every terminal host registers itself with `registerTerminalDropTarget`, and a drop types the escaped path into that PTY through `ipc.ptyWrite` — indistinguishable from typing it.

- **From Finder** — Tauri's native `onDragDropEvent` (the DOM `drop` never fires, and WKWebView would not expose the real path anyway). Absolute paths, physical-pixel drop point. A drop on a **sandboxed** agent asks first: stage into TMPDIR, or allow the file/folder (needs an agent restart).
- **From the file tree** (GH #136) — a pointer drag (`startPathDrag`), same as the tab strip: **never HTML5 DnD**, which is unreliable in WKWebView and gets intercepted by Tauri's file-drop. Inserts the path relative to the task root (falls back to absolute for another task's terminal); no sandbox prompt, since the worktree is already granted.

Both share the hit test and the `.termic-drop-target` highlight, so they agree on where a drop lands.

## Confirms for recoverable actions

`ConfirmDialog` (`askConfirm`) renders an optional second checkbox when the
request passes `dontAskAgain: true`. It reads **"Show this every time" and
starts ticked**: unticking is the deliberate act, and the box then matches the
Settings toggle it writes rather than inverting it. The result still comes back
as `dontAskAgain` (true = the user opted out), so callers persist on
`confirmed && dontAskAgain` and never on dismissal alone: the dialog reports
the checkbox state at dismissal, so a backed-out action would otherwise disable
every future confirmation.

Two flows use it, both writing a Settings › Tasks toggle:
`confirmBeforeArchiveTask` (`src/lib/archiveTask.ts`) and
`confirmBeforeCloseAgentTab` (`src/lib/closeTab.ts`). When the confirm is off,
the action still reports itself with a toast that names the way back (History
for an archive, the `+` menu's Resume submenu for a closed tab), because the
dialog was the only other feedback that anything happened.

Copy follows what is actually recoverable, and only a genuinely one-way action
gets `destructive: true` (the red button). An archive keeps the task in History
and the branch in git; a secondary tab comes back from Resume. A **pane** tab
is never snapshotted into `closedTabs`, so that one is one-way and says so. Red
buttons everywhere teach people to ignore red buttons.

The main agent tab has TWO answers, and the dialog picks between them rather
than always claiming the first:

- **This close empties the task's main strip.** The task sleeps, and waking it
  restores the tab from `persisted_tabs` with its session. "The session resumes
  when you reopen the task" is literally true, and no `closedTabs` entry is
  taken (it would be a duplicate way back).
- **Another main tab is still open** (a shell, a Run tab, a diff). The task
  never sleeps, so nothing ever wakes it, and `ensureDefaultTab` bails on any
  task that owns main tabs. The durable record stays on disk, perfect and
  unreachable. So this close DOES take a `closedTabs` entry, keyed to the tab's
  own id and carrying `is_default`, and the copy points at the Resume list like
  a secondary tab's does. Resuming reuses that id, which re-attaches to the
  existing durable record instead of adding a second one aimed at the same
  session.

The split matters most in a main checkout, where there is no cwd resume to
paper over a lost session id: a replacement agent from `+` there comes back
with nothing at all. See docs/gotchas.md, "A durable tab is only restored by a
WAKE".

A **scratchpad** (GH #244) gets its own three-outcome prompt instead
(`ScratchCloseDialog`, Save… / Discard / Cancel, dismissal = Cancel), because
it has never been written anywhere the user chose and there is no file to go
back to. That prompt runs **once per pad, including inside a bulk close**
("Close others", "Close to the right"): folding several pads into the one
counting confirm would mean a single click deciding the fate of several notes.
Cancel there spares that pad and lets the rest of the set close, the only
reading that survives the fact that the tabs before it are already gone.
`confirmBulkClose` therefore counts dirty FILES and live agents only, and a set
of nothing but pads skips it entirely rather than stacking two dialogs on one
decision.

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

**Git** is one tab with three sub-tabs, because they are three questions about
one repo rather than three places:

- **Commit** — what you can stage right now (Fork-style staging, the only one
  of the three you ACT in: stage, discard, commit, push).
- **Compare** — what this branch adds up to next to another ref (issue #208):
  one list of every path that differs between a chosen ref and the working
  tree, committed and uncommitted alike, because an agent that split a feature
  over six commits leaves nothing in the staging view to read. Its own bar
  (`<base> → <branch>`) WRAPS to a second row rather than truncating: two long
  names is the normal case, and on one row flexbox splits the deficit in
  proportion to length, which crushed the shorter ref to a single character.
- **History** — the commit graph (issue #199), full height.

### Two readings of one changed file

A row in Commit or Compare opens the file's DIFF on a plain click, and the
file ITSELF three ways: a button on the row (left of the eye), the row's
context menu ("Open file"), or an ⌥-click. Both readings select the row, so
switching between them never loses your place in the list.

The row button is not redundant with the other two. A context item and a
modifier are both invisible at rest, so the feature did not exist for anyone
who did not already know it was there: the first person to use it went
looking for an icon beside the eye and found nothing. Order on the row is
open, then viewed, then stage: navigate, judge, act. It carries the same
quiet-until-hover treatment the eye has, so the resting row is no busier.

The diff is the right default and stays it: this panel exists to show what
changed. But it is the wrong reader often enough to need an escape hatch. A
file added in one commit renders as an unbroken wall of `+`, which is the
worst possible way to read a spec somebody just wrote, and a markdown file in
a diff loses its rendered preview entirely. Opening the file goes through the
same `openPreviewTab` the file tree uses, so a file opened from a change row
and the same file opened from the tree are ONE tab, and a markdown file
arrives in whatever view you last read one in (`markdownDefaultView`).

Both surfaces hide it on a DELETION, following the eye: there is no
working-tree file to open, and an editor on a path that is gone is not a
reading of anything. That is the ONLY condition. A repo_root member's files
open like any other group's, because `task_file_read` resolves a
`<dir_name>/…` path inside that member's own checkout even when the checkout
sits outside the wrapper subtree. `DiffPane`'s own "Open" button is the third way in, for
when you are already looking at the diff.

Order of the chrome above them, outermost first: repo pills (multi-repo tasks),
then the branch bar, then the sub-tabs. Which repo you are looking at is what
the branch and all three sub-tabs are ABOUT, so it cannot sit inside them.

One box serves all three, on the branch row. The chip is not "one short
control" the way that row was first written: branch names are routinely long
enough to fill it, and since the box is a flex-basis-0 item it absorbed none of
the shrink and collapsed to its own padding. The box holds a 30% floor and the
chip a matching cap, so a name truncates instead of taking the row. In Commit and Compare it filters the file list. In History it is a
MESSAGE SEARCH run by git (`--grep`, literal and case-insensitive, subject and
body) over the whole scope rather than over the rows on screen: "does this
branch have a commit about X" is a question about the history, and answering it
from the loaded page would make it a question about how far you had scrolled.
Debounced at 250ms, so it is one `git log` per pause. It narrows whatever scope
is active rather than replacing it, so a search under All searches every ref.

The sub-tab row keeps only what belongs to the active view: the view-mode menu
for Commit and Compare, the ref picker for History.

History's picker has two independent axes. WHICH refs to walk (Auto = the
checked-out branch, All = every ref, or any number of named ones) and HOW MUCH
of the topology: **First parent only** collapses a merged side branch into the
merge commit that brought it in. Without it, picking one branch still draws a
lane per merged branch, because those commits genuinely are its ancestors,
which reads as "why am I seeing other branches when I picked main".

The graph used to be a collapsible section at the foot of the staging view,
sharing the body by a draggable ratio. It is the one view here that wants
vertical space and was getting whatever two file lists left over, so it became
a sub-tab and the collapse flag, the ratio, the divider and their localStorage
keys went with it.

## Right-panel footer (Setup / Run / Terminal)

Three tabs. Setup + Run stream via `useScriptRuns`. Terminal is opt-in: click `+` → `useApp.enableFooterTerm(wsId)` → AuxTerminal mounts. RunToolbar: Open (expands `project.preview_url` with `$TERMIC_PORT`/`$CONDUCTOR_PORT`/`$PORT`/`$TERMIC_WORKSPACE_NAME` + any frozen extra named port, GH #196) + Run/Stop (SIGTERMs process group). Default: tab=Run, expanded.

`task_archive` sweeps `RUNNING_SCRIPTS` and SIGTERMs each before teardown.

## Markdown preview

**GitHub's typography, the theme's colours.** `.markdown-body` in `index.css`
ports Primer's markdown stylesheet: 16px block spacing, GitHub's heading
scale, 85% monospace code with a 6px radius, zebra table rows, and a 980px
measure centered in the pane. The one deliberate departure is the base size,
system font at 14px/1.5 instead of GitHub's 16px, which read as too large
next to the app's 13-14px chrome. Headings and code are `em`, so they follow.
Colours map onto theme tokens (links use `--color-palette-blue`), so the
document sits on the app surface under every theme. The old Inter 14px/1.65
across the full pane width read as heavy on a wide window.

**Selectable, and copies as clean rich text.** The host carries
`data-selectable` (the chrome is `user-select: none`). ⌘C is handled by
`lib/markdownCopy.ts`, not WebKit: WebKit inlines every computed style, so a
paste into a light surface arrived as near-white text in Inter. The handler
writes `text/html` with the document's structure only (links, emphasis,
lists, tables, headings, code), re-wrapping a partial selection in its
list / table / `<pre><code>` so bullets and code blocks survive, and drops
what a paste target cannot resolve: relative links become their text, local
`data:` images are left out. `text/plain` is the selection's text.

**External files preview too.** An absolute-path `.md` (the read-only
external tab from a ⌘-click) gets the same source / split / preview shell.
`MarkdownCtx.external` switches link resolution to the file's own directory
(`resolveExternalHref`): a target inside the task opens as an ordinary tab,
anything else as another external tab. Relative images are not loaded, see
docs/sandbox.md "Known gap".

**Word wrap** (`prefs.editorWordWrap`, off by default) lives in Settings >
Appearance and the palette's "Toggle word wrap". No toolbar control, by
choice. It is its own compartment in `EditorPane`, reconfigured in place.

## Editor path bar (breadcrumb + syntax)

The bar under the tab strip, for `edit` and `diff` tabs with a path (`EditorBreadcrumb` in `components/task/TaskView.tsx`). Each path segment is a click target: a folder reveals/expands that folder in the tree, the filename reveals the file, and every segment right-clicks to a copy menu. On the right: copy path, open the containing folder in Finder, locate in the tree.

Editor tabs also get a **language button** there, showing what the buffer is highlighted as and opening the "Set syntax" picker (`SyntaxPalette`, also reachable as the command palette's `set-syntax` row). Sublime and VS Code put this bottom-right; termic has no status bar, and inventing one to hold a single control would cost the terminal pane an edge, so it goes on the bar that already exists. Diff tabs deliberately do NOT get it: there is no editable buffer there, so a diff's syntax always follows its path.

A **scratchpad** (GH #244) renders its own variant of this bar: no trail, no copy / Finder / locate buttons (it has no path to point at), a line saying it is not in the project yet, and the language button — which matters more here than anywhere else, since with no extension the content sniffer is the only thing that CAN name the buffer. Its manual pick is PERSISTED, in the scratch index, unlike an edit tab's session-only one (point 1 below): there is no filename to re-derive it from after a relaunch. `SyntaxPalette` writes it at the moment of the pick, not the pane from an effect: picking Markdown swaps panes and remounts the editor in the same commit, so a pane-side effect would only ever see the new value as its initial seed.

Picking **Markdown** on a pad also earns it the source / preview / split shell a `.md` file gets (`MarkdownPane`, routed on `effectiveLanguageId(tab) === MARKDOWN` rather than on a path, since a pad has no extension). That works because the shell's preview is fed by the EDITOR BUFFER, not by disk, so an unsaved pad has something to render. Relative links and images resolve from the task root (a pad has no directory of its own), and there is no `file.md#heading` reveal to consume. Switching between the two panes remounts CodeMirror once; the pad's unmount flush writes the buffer on the way out, so nothing is lost.

### Which language, and where that is decided

The set of languages is **CodeMirror's published registry** (`@codemirror/language-data`, ~150 of them), so opening a `.php`, `.lua` or `.zig` file highlights with no edit here. **Adding a language is not a thing you do.** A language id IS the registry's `name` ("TypeScript", "Properties files", "TSX"), which is also its label.

Precedence, in `lib/languages.ts`:

1. **A manual pick** (`EditTab.syntax`) — session-only, exactly like Sublime's. It survives tab switches, not a relaunch, and is cleared when a preview tab slot recycles onto a different file (otherwise the next file to land in that slot inherits the override). A **scratchpad's** pick is the exception and persists (above).
2. **The automatic answer** (`syntaxAuto`), written by the editor pane: the language the PATH resolves to, or, when the path matches nothing, a guess from the **content** (`lib/detectSyntax.ts` — only markers close to unambiguous: a shebang, an `<?xml`, text that actually `JSON.parse`s; a wrong guess is worse than no guess, so anything vaguer stays Plain Text).

`effectiveLanguageId` therefore has only two levels, not three, and **does not look at the path**. It cannot: resolving a path needs the registry, and the registry may not be reachable from the main chunk (below). The pane owns resolution and writes its answer back to the tab, so the breadcrumb and the picker read one settled value instead of re-deriving it. A tab the pane has not answered for yet reads as Plain Text for a frame.

### The bundle rule

`lib/languageExts.ts` is the gateway to every grammar, and it is imported ONLY by the lazily loaded editor and diff panes. `lib/languages.ts` stays free of CodeMirror. **`lib/mainChunkGuard.test.ts` pins this** by walking the static import graph from `main.tsx`: a stray `import` of `@codemirror/language-data` from anything reachable at app start would move ~800K of grammars onto the launch path. `SyntaxPalette` is mounted from `App.tsx`, so it `import()`s the list when it opens rather than at module load.

The rule covers the GRAMMAR packages too, not just the registry index, and that is the half that bites. A single `import { javascript } from "@codemirror/lang-javascript"` in the settings theme preview pinned that package into the main chunk, and the namespace object the registry's own `import()` then received came back with **no `javascript` export at all** (`e.javascript is not a function`): every `.ts` and `.js` file in the app silently fell through to the content sniffer and highlighted as whatever that guessed. Nothing reachable at app start may name a grammar package, however small the use looks; fetch it with `await import("@/lib/languageExts")` instead. A failed grammar load now also `console.warn`s rather than resolving quietly to "no grammar".

Measured: the main chunk went 2361K → 2214K (the old catalog is gone, and so is the pinned JS grammar), `languageExts` is a 21K chunk fetched on the first editor or diff open, and `dist/` grows ~876K spread over ~119 extra chunks that are only fetched for a language actually opened.

### Async loads, and the race

A grammar is now a **chunk fetch**, so nothing about setting a language is synchronous. Both panes resolve it alongside the file read (`Promise.all`) rather than after it, so highlighting is there on first paint. Switching syntax still reconfigures the language **compartment** in place — no `EditorView` rebuild, so the cursor, undo history and scroll position survive.

Four things race to set one editor's language: the initial load, a path change on a recycled preview tab, the sniffer answering as a pad fills, and a manual pick. Whichever STARTED last must win no matter which chunk arrives first, so every apply goes through `lib/langSwitch.ts` (`claim()` returns a predicate that is false once anything else has claimed). An `alive` flag is not enough — it only knows about unmount.

### What termic still owns

Six grammars, because the registry cannot serve them, and a short **overlay** of filename rules, because it does not match the way we need:

- **Custom grammars**: `Makefile` (hand-written, `lib/makeMode.ts` — `legacy-modes` has ~150 CodeMirror 5 modes and Makefile is not among them; the rule that makes it a Makefile rather than a config file is that a leading TAB opens a recipe, where the line is shell instead of make, and a trailing backslash keeps that state across lines), `ProtoBuf` (`lib/protoMode.ts`; the registry's mode predates proto3, and ours takes the same NAME so it replaces rather than shadows it), `Elixir` (absent upstream), `Svelte` (`@replit/codemirror-lang-svelte`), `Astro` (`lib/astroMode.ts`, below) and `HCL` (`lib/hclMode.ts`, below).
- **Overlay rules** (`OVERLAY_RULES`), each reusing the registry entry's own loader: `Dockerfile.dev` (upstream's pattern is anchored `/^Dockerfile$/`), `justfile`, `.env.production`, `.zsh`/`.fish`, `.conf`, `.rake`, `.pyi`, `.mdx`, and the template formats with no grammar anywhere (`.ejs`, `.mustache`, `.twig`, `.njk`) which get tag highlighting from HTML.

**Frameworks.** React and Vue need nothing from us: the registry's JSX / TSX entries cover React, and its Vue entry loads `@codemirror/lang-vue`, a real single-file-component grammar. Svelte and Astro were on the HTML overlay until they read the tags and left every line of actual code grey, which on an `.astro` file means its entire frontmatter block.

`lib/astroMode.ts` exists because no CodeMirror grammar for Astro exists anywhere. An `.astro` file is a TypeScript block fenced by `---` followed by an HTML-with-expressions template, so it is the HTML parser with the frontmatter region **overlaid** by the TypeScript one (`parseMixed`). Three things about it are load-bearing:

- The overlay hangs off the leading **`Text` node**, not the document. A mount on the top node is silently dropped.
- It is **clipped to that node**, because a `<` in the frontmatter (a generic, a comparison) ends the Text node there and the HTML parser reads what follows as a tag. The block keeps its colouring up to that point instead of losing all of it.
- The closing fence must be a line that is exactly `---`, and an **unterminated** block highlights nothing. Both matter mid-edit: a half-typed fence that counted would flash the rest of the file a different colour on every keystroke.

Template `{expressions}` are attribute values and text, not JavaScript. That is the same trade every HTML-hosted format makes, and it is where a real Astro grammar would start.

Two upstream behaviours to know about. `LanguageDescription.matchFilename` compares the **raw** extension, so `README.MD` matches nothing — `matchLanguage` in `lib/languageExts.ts` does its own two-pass match with the extension lower-cased, and must not be swapped back. And the registry splits JSX/TSX out of JavaScript/TypeScript, so a `.tsx` file's button reads "TSX". `.gradle.kts` is Kotlin, not Groovy, which upstream already gets right.

**HCL.** The registry has no HCL entry. `CUSTOM` lazy-loads
`codemirror-lang-hcl` for `.tf`, `.tfvars` (including `.auto.tfvars`) and
`.hcl`, shared by the editor and diff viewer. The syntax picker calls it HCL
and also matches Terraform; `.tf.json` and `.tfvars.json` stay on JSON.
`lib/hclMode.ts` preserves the semantic tags and adds keyword/string
fallbacks for block types, labels and boolean/null literals, which Atom One
otherwise leaves uncoloured. Highlighting does not format files or start a
language server.

## Code intelligence (language servers, GH #174)

**The name follows the switch.** With type checking off (the default) the
feature is go-to-definition, find-usages, an outline and hover types, so every
user-visible surface calls it **Code navigation**; turn type checking on and
the same surfaces read **Code intelligence**, because then it is more than
navigation. One function decides (`lib/lsp/featureName.ts`), used by the
Settings heading, the chip, both consent prompts, the per-project section and
the editor's nav hint. Naming it "intelligence" while the checker is off sent
readers looking for a half of the feature they had not switched on.

**One download path, for both surfaces that offer it.** `confirmAndInstall`
(`lib/lsp/installFlow.ts`) discloses the size and the memory figure, fetches,
and reports a failure; the caller arms only when it returns true. It exists
because there were two copies and one was wrong: Search Everywhere's offer row
had an Install button that ARMED the checkout without downloading anything, so
nothing could start, the dialog waited for symbols that were never coming, and
the editor chip went on offering the same download. The confirm key is per
SERVER (`code-intel-install:<server>`), so "don't ask again" means the process
rather than the button that happened to be pressed.

**One click, from the editor.** The chip on the path bar (`CodeIntelChip`) is the whole entry point: open a file in a language something can serve and it says "Code intelligence" (or "Install ty 0.0.73" when nothing is on the machine). An earlier design gated this behind a Settings toggle that defaulted off, and the honest verdict on that was that nobody would ever find it. The Settings toggle survives as an OFF switch, default on, for people who never want the button.

Offering costs one IPC call per editor open and nothing else. Nothing is imported until a checkout is armed: `mainChunkGuard.test.ts` forbids `@codemirror/lsp-client` and `lib/lsp/host` from the app-start graph, and the `--version` probe that catches a broken `rust-analyzer` shim is cached by path in Rust, so the offer never spawns a process twice.

**The cost is disclosed once, not every time.** A language server holds its index (300 MB for TypeScript, ~3 GB for rust-analyzer, up to 7 GB for gopls on a big repo) and never releases it while it runs, and three of them also write into the checkout (clangd's `.cache/clangd`, ruby-lsp's `.ruby-lsp`), which is unusual enough that nobody should meet it by surprise. So the first arm shows what it costs, with a "don't show this again" checkbox; someone who has read it and turns navigation on in every repo does not read it again. Same pattern, and the same persist-only-if-confirmed rule, as archiving a task.

**A repo is usually several languages, and each is its own decision.** The chip reads the buffer's own language (`effectiveLanguageId` → `lspServerFor`), so a Django checkout offers Python on `models.py` and TypeScript on `static/app.js`, and arming one does NOT arm the other: the disclosure quotes a per-language number, and agreeing to ty's ~250 MB must not also start a second process. Grants are therefore keyed `(checkout, server)`, and several servers can run for one checkout, each with its own reap and its own Activity row. A project can narrow the set on that same sub-tab, under Auto start (`Project.code_intel_languages`, undefined = all). That list answers ONE question, "what starts here without being asked", and `autoStartsLanguage()` is read by the auto-start planner alone. It used to gate the editor chip, Search Everywhere and the nav hint as well, which made it answer a second question nobody had asked it: unticking Go to stop four servers starting by themselves also removed the one-click button for Go, along with the cost disclosure that button carries. Everything termic can serve is offered on request; the list decides what runs without one. This is what every editor with optional language servers does (Sublime's LSP package, Zed, Helix, Neovim); Fleet's single workspace-wide Smart Mode is the outlier.

**The grant is per (checkout, server)** and deliberately NOT sticky: refcounted against the tasks on that checkout, and it lapses when the last of them is closed or archived (`store/codeNav.ts`, pruned in `app.loadAll` beside the race and mark-as-viewed prunes). Worktrees disappear with their task, but the main checkout is permanent, and a grant made once for a five-minute code read would otherwise resurrect a multi-gigabyte server months later.

A project can standing-instruct arming in its own Code navigation sub-tab (Settings → the project), as three choices rather than a boolean (`Project.code_intel_auto`): off, main checkout only (bounded — one server per language, ever, shared by every task on it) or main checkout and worktrees (unbounded — one server per worktree). Machine-local in `projects.json`, never `.termic.yaml`: that file is committed, and whether to spend this machine's memory is not a colleague's decision.

**The languages live inside Auto start, and only appear once something starts.** They were a flat block ABOVE the radios, so the page asked which languages to narrow before anything had said what was being narrowed, and it read as a list of what the project supports. With Off selected there is nothing to narrow (each task asks, one chip click at a time) so the list is hidden, and switching to Off clears a stored one rather than leaving state behind that no visible control explains. Switching auto start ON with nothing decided yet runs detection over the checkout's file list (`projectLanguages`) and ticks what the repo turned out to be written in: every box ticked on a Python repo is an instruction to start four servers, and nobody means it.

**One list of servable languages** (`SERVABLE_LANGUAGES` in `lib/lsp/serverNames.ts`), pinned by a test against the set termic can actually serve. The per-project checkboxes used to enumerate four of the seven, so the first untick materialised a list of the remaining three UI ids and silently dropped C++, Swift and Ruby with it.

**The unit is the checkout, and that is a correctness rule, not a tuning knob.** Tasks that share a checkout share one server; two worktrees of one repo must not, because they hold different content behind the same module paths and a shared server would resolve an import into the wrong copy. `checkoutRoot()` is the one place that answers which is which.

**Turning it off stops the server now.** The idle grace (3 minutes, 1.5s in the e2e build) exists so closing a tab and opening another does not pay for a re-index. An explicit click on the chip is a different act: the commonest reason to toggle it is that the environment changed underneath the server (a package installed, a branch switched), and handing back the cached client would be the same process with the same stale view of the project. `stopClient` skips the grace, unless a sibling task on that checkout still holds the grant.

**Status, because a silent server looks like a broken one.** A cold rust-analyzer indexes a crate graph for minutes, and until it finishes hover and go-to-definition return nothing. The chip is the indicator, and it is ONE control: the compass becomes a pulsing dot while the server is starting or reading the repo, and the label holds still at "Code intelligence" throughout. The detail goes in the tooltip ("Loading crate graph 42%: answers are incomplete until this finishes", or why the server stopped), which is where someone wondering why a hover did nothing will look. A label that changed on every percentage would reflow the path bar under the reader, and the dot stops pulsing for BOTH settled states: ready, and failed, since a dot still pulsing on a dead server promises an answer that is not coming. That is why the client advertises `window.workDoneProgress` (the plan said not to until there was somewhere to show it, since a server whose `window/workDoneProgress/create` goes unanswered blocks; the Rust host answers it) and why `$/progress` is handled in `lib/lsp/host.ts`. The Activity window carries the other half: every live server as a row with its CPU, memory and a stop button, filed under no task because it belongs to the checkout.

The gap worth knowing about: the chip lives on the editor path bar, so while you are looking at a terminal tab nothing on screen says a server is running. Activity is where to look for that.

**Python environments are named, not inferred.** The host answers `workspace/configuration` per section: `python` gets `pythonPath` (pyright and basedpyright find their interpreter THERE and ignore `VIRTUAL_ENV`), `ty` gets `environment.python`, and every other section gets `null`, which is what the rest expect. Without this, a project whose packages live in `.venv` gets analysed against some other Python and fills with errors about imports that are installed. Termic also warns when a checkout has Django but no `django-stubs`: Django adds `Model.objects` at runtime, so a checker is right to call it missing, and the fix is a package rather than a setting (measured: ty reports that error without the stubs and zero diagnostics with them).

**A usages row says which file, but only when it has to.** Row labels come
from `usageLabels()` (`lib/lsp/usageLabels.ts`), which is PyCharm's rule: a
basename that appears once is shown bare, and only a clash pays for a path,
elided in the middle when long (`projects/…/views.py`). What it replaced named
every row by whatever was left after stripping the directory all rows share,
which collapsed to the bare basename exactly when it mattered: nine usages
spread over a Django repo's three `views.py` read as nine usages in one file.
Two files that would still elide to the same label get their full relative
paths instead, since an ambiguous label is the whole problem being solved. The
footer keeps the selected row's absolute path.

**The usages list resizes from its bottom-right corner, and the size sticks.**
That is the corner that moves nothing: the tooltip is anchored by its top-left,
so the header and arrow stay on the symbol. The drag is clamped to 320x120 and
to the window edge, and the result is kept in `localStorage.usagesPopupSize`.
A reopened popup takes the remembered WIDTH as fixed and the HEIGHT as a cap,
so three usages do not sit in a box sized for forty. The file column is a share
of the row (40%) rather than a fixed 26ch, so widening the popup is what
un-ellipsizes the labels. Every row's `title` is its absolute `path:line`, and
the footer's is the full path, for whatever still does not fit.

Locations are **deduplicated on (uri, line, character) before anything counts
them**: a server reporting one reference from both the open document and its
index is normal, and the popup listed each twice, so four usages read as eight
with the same line numbers repeated.

**⌘-click does what IntelliJ's does**, which is two things depending on where you are: on a usage it jumps to the definition, and **on the definition it lists the usages** (`lib/lsp/modClick.ts`). That second half is the one people miss when they leave JetBrains, and it costs one comparison: ask for the definition, and when the answer is the place you clicked, ask for references instead. It is a mousedown handler rather than a click one, so the editor never starts a text selection first. While the modifier is held the editor shows a pointer, reusing the same `termic-mod-held` class as the terminal's link affordance, scoped to `.cm-lsp-navigable` so an editor with no server keeps a text caret.

Keys come from the client's own keymaps, mounted only while a checkout is armed: **F12** jumps to definition, **Shift-F12** finds references (the client ships the panel it renders into). They are CodeMirror bindings, not entries in termic's rebindable shortcut system (docs/shortcuts.md), because they exist only inside an editor that has a server attached.

What the editor gets: completion, hover types, signature help, diagnostics (feeding the `lintGutter()` EditorPane has had mounted with no source since the day it was written) and go-to-definition. Definitions OUTSIDE the checkout open in a read-only external tab (`type: "external"`), because every other tab path is task-relative and `safe_task_path` rejects anything escaping the worktree. ⌘-clicking into `site-packages` also hops from a stub to the source it describes (`lib/lsp/declarationSource.ts`): landing in a `.pyi` full of `...` is the correct answer to "what is the type" and the wrong answer to "show me this code".

**Where a server comes from, and how it stays current.** Resolution order is the checkout's own toolchain (`node_modules/.bin`, `.venv/bin`), then the user's real login-shell PATH, then termic's own downloads. Nothing is ever put on the user's PATH: a downloaded server lives under `<data dir>/servers/<language>/<version>/` and deleting termic deletes it.

Versions are **not pinned to the termic release**. `lsp_install` resolves the latest release of a hardcoded upstream repo (microsoft/typescript, astral-sh/ty, rust-lang/rust-analyzer) and verifies the bytes against the SHA-256 that release's API record advertises, with the compiled-in version as a tested floor and an offline fallback. A hard pin ages in a way the user pays for, and re-pinning four servers across four platforms by hand is a chore that quietly stops happening. Be honest about what the digest buys: integrity (a truncated download, a corrupted CDN copy, a renamed asset are all refused), not provenance, since the bytes and the digest come from the same place. What this build decides is the PLACE.

Upgrading is in Settings, Appearance, Editor, under the Code intelligence toggle: it checks **on demand only** (a background version check is a network call the user did not ask for, in an app that otherwise talks to nothing but termic.dev), installs **alongside** rather than swapping (a binary replaced under a live session would answer from a different index mid-read, and the running process holds the old one anyway), and keeps the version it replaced so a bad upgrade is undone by deleting a directory. The new build is used the next time a server spawns.

Two things the servers themselves get wrong, both of which fail silently and are therefore pinned by tests. **Diagnostics are half push and half pull**: TypeScript 7 never pushes (0 pushed, 1 pulled on a one-line type error), while ty stops pushing the moment a client claims pull support (0 with the claim, 2 without). So the Rust host strips the CodeMirror client's `textDocument.diagnostic` claim from `initialize`, and `lib/lsp/pullDiagnostics.ts` polls any server that advertises a provider. And **`rust-analyzer` on PATH is usually rustup's shim**, which prints "unavailable for the active toolchain" and exits; resolution asks `rustup which` first and runs every candidate's `--version` before believing in it.

**Completion is the one that hid its own absence.** `basicSetup` ships a local word scraper, so the popup is never empty even with no server attached: it can offer an identifier because that word is on screen, and can never offer a member on it. `serverCompletion()` was missing from the extension list for a while and nothing looked broken. The e2e fixture therefore answers with a label that appears nowhere in the file, which a word scraper cannot invent.

`lib/lsp/workspace.ts` replaces the client's `DefaultWorkspace`, which THROWS on a second view of one file — a state termic reaches without trying, since several tasks can render editors on the same path. It holds a list of views per file, tells the server only about the first open and the last close, replays the last diagnostics into a view that attaches late, and fans pushed diagnostics out to every view rather than the first.

## Indentation, detected per file

The editor hard-coded two spaces for every buffer, which is wrong for most of what an agent writes: Python is four, Go and Makefiles are tabs, and a Makefile's tabs are the format rather than a preference. `lib/detectIndent.ts` reads it off the file, VS Code's default behaviour (`editor.detectIndentation`) and the only one that needs no configuration to be right.

It votes on the DIFFERENCE between consecutive indented lines rather than the smallest indent seen: a file full of 8-column aligned continuation lines still steps by 2, and the step is what survives that. Ties go to the smaller size (a 4-space file also steps by 8 wherever it nests twice), a single observation is not enough evidence to override the fallback, and only the first 64 KB is read, since this runs on the path that opens a file. It lives in its own compartment, so an external reload re-detects without rebuilding the view.

Not done: `.editorconfig`, which is the explicit signal and should win over the guess when a project has one.

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

## Inline git blame (cursor line only)

`inlineBlameExtension(taskId, path, { onOpenCommit, onShowInHistory })` annotates the line the cursor is on with `subject, Author (age)` in dimmed text, 50px after the code. VS Code's `git.blame.editorDecoration`, and the format is VS Code's default template with `commitAge` supplying the age so the editor and the History panel describe the same commit the same way.

**The annotation itself is inert.** It sits inside the line being edited, where a click target competes with placing the cursor, so it is hover-only. Resting on it for `CARD_DELAY_MS` (500ms) opens a hover card: long enough that crossing the annotation on the way somewhere else does not throw a card over the next line, short enough that resting on it feels answered.

The card carries author, relative age AND absolute date (the first answers "is this recent", the second "which release"), the short sha, co-authors, the subject in full, and the message prose. Its header holds the two actions:

- **Open diff** — this file as that commit changed it, in the `commit:<sha>` diff tab the History panel already uses.
- **Show in History** — `revealCommitInHistory(taskId, sha)` on the UI store. RightPanel opens the Git tab (and un-hides the panel), GitPanel switches to the Graph, HistoryPanel selects, expands and scrolls to the sha. Three consumers of one request, because the editor has no handle on any of them.

  Two things about that request are load-bearing:

  - **It is CONSUMED.** `clearCommitReveal()` once honoured, plus an `at` timestamp each consumer records so it acts on a request once. Left standing it is a standing order: RightPanel's effect depends on the active task, so it re-fires on every task switch and re-pins the panel to the Git tab. That is not theoretical, it cost most of a debugging session and broke two unrelated e2e specs.
  - **A commit that is not loaded is JUMPED to, not paged to.** `task_git_commit_offset` asks git how far back the sha is (`rev-list --count <sha>..HEAD`) and the panel fetches the single page around it, replacing the window rather than appending (the rows above belong to a different part of the history, and stitching them would draw a graph with a hole in it). Paging forward until the sha appears works on a young repo and is hopeless on a monorepo, where a two-year-old commit is tens of thousands of rows down. A sha that is not reachable from HEAD says so in a toast and drops the request.

The card is a CodeMirror tooltip (`showTooltip`), so CodeMirror owns positioning, flipping and clipping. Two things had to be told about the geometry, and both were visible bugs first:

- **`tooltips({ tooltipSpace })` in EditorPane**, constraining every tooltip to the editor pane's own rect. CodeMirror's default is the whole document viewport, so a card anchored at the end of a long line ran under the right panel and one near the top ran under the tab bar. Mounted in EditorPane rather than in this extension because the review-comment tooltip wants it too.
- **A `min-width` on the card**, not just a max. The annotation sits at the end of a line, so there is often only a sliver of room to its right; with no minimum the card shrink-to-fit into that sliver, wrapped its header into a column and drew its buttons over the author line. Given a width it cannot fit, CodeMirror shifts it left instead, which is the wanted behaviour. It has to survive the pointer travelling into it or its buttons are decoration, hence `CARD_CLOSE_MS` (220ms) of grace on leaving the annotation, cancelled when the pointer arrives in the card. Any edit closes it: the card describes a line that is moving under it.

The message body is NOT part of the blame payload. A file's blame can name 169 distinct commits and the reader looks at one, so `task_git_commit_meta` fetches the body when a card opens, cached per sha. The header renders immediately from the blame data and the prose fills in when git answers, rather than the card waiting on a fork before showing anything.

There is deliberately **no blame column**. Annotating every line is a layout cost, not a cosmetic choice; the reasoning and the CodeMirror rule behind it are bear trap 10 in [performance.md](performance.md).

The pref is `inlineBlame`, OFF by default (matching VS Code's own default and the opt-in shape `loadRemoteImages` set), in Settings → Appearance → Editor, and in the command palette as "Toggle inline git blame" with its current state as the row suffix. It is mounted through its own `Compartment`, so toggling reconfigures in place: cursor, undo history and scroll position all survive, and with it off the extension is never constructed, so nothing is fetched and no state field exists.

Two honesty rules, because a confidently wrong author is worse than none:

- **A line the user edited loses its attribution** and reads "Not committed yet". Mapping alone does not achieve that: `MapMode.TrackBefore` drops a line joined onto the one above, but the survivor keeps its own mark, so the merged line would be credited to whoever owned the first half. Every line an edit touched is filtered out of the snapshot as well.
- **A dirty buffer is never re-blamed.** Blame reads the file on DISK, so its line numbers would not match the screen. The save and external-reload paths drop the cache entry and dispatch `refreshBlame`, which is when a re-fetch happens.

A git tick is deliberately NOT a re-fetch. `gitRevision` bumps on every stage and unstage, not just on commits, so it dispatches `markBlameStale`: the annotation on screen stays put and the refetch rides the reader's next cursor move. Re-blaming per tick forks git once per open editor to redraw one line that usually did not change, and it measurably slowed the e2e suite when it was written that way.

## The dashboard

The home screen: hero, three action cards, a Recent row, and the project list.
Rendered by `MainArea` as an OVERLAY whenever no task is active and the view is
not History, with every visited task still mounted underneath so its PTYs
survive. That is why it can afford live signals at all: it is not on screen
while you are driving an agent.

**It shows the same structure the sidebar does.** Project groups render as
folders here too, through the same `projectSections()` in
`src/lib/projectGroups.ts` and, critically, the same `collapsedGroups` map.
Collapsing a folder in either view collapses it in both, because one folder in
two states is a bug the user would read as a rendering fault.

**Section first, then sort.** The dashboard floats projects with live tasks to
the top and the sidebar does not (it folds inactive ones into a trailing
section instead). Applying that sort to the flat project list before sectioning
splits a folder: a group is anchored at its FIRST member's index, so moving
members moves the folder and reorders it internally. `sortSectionsActiveFirst`
sorts whole sections, which keeps a folder intact and its members in the order
every other surface shows them. The worked counter-example is in that
function's comment.

**Rename and drag stay in the sidebar.** Both are inline edits on a row the
sidebar owns; a second way to do them here would be two sources of truth for
one gesture. The dashboard's folder right-click menu is the shared
`GroupActionsMenuItems` WITHOUT its `onRename`.

**Live signals are read-only.** The work badge and the PR chip are the sidebar's
own components (`TaskWorkBadge`, `TaskPrBadge`), fed by the same
`src/lib/taskWorkState.ts` predicates and the same precedence
(attention > done > working). The PR chip renders what the poller already
resolved and never starts a lookup, so listing every task costs nothing.

### Phase and age are derived, never stored

A task's phase comes from `taskPhase()` (`src/lib/taskPhase.ts`): the task
record, plus the live PR snapshot in `usePr`, plus the live git state in
`useTaskGit`. Five values, first match wins:

| Phase | When |
|---|---|
| **Done** | `archived`, or the PR is merged, or `merged_into_base` |
| **Parked** | `parked_at` is set |
| **In review** | the PR is open, or (no PR at all AND own commits AND clean AND nothing ahead) |
| **In progress** | the PR is draft or closed, or `started_at` is set |
| **Todo** | none of the above |

**The rule the table stands on:** a person may set the states the machine
cannot see, the machine owns every state it can see, and a manual state clears
itself the moment evidence arrives. In progress, In review and Done are
derived only, and no UI may hand-set them: each has a live twin the app already
polls, and a second hand-kept copy beside one is the redundancy PR #292 was
rejected for. **Parked is the one hand-set value**, allowed because "I have
deliberately put this down" leaves no trace in git, in the forge or in any
process, so it has nothing to contradict. It does not need hand-clearing
either: `markStarted` wipes `parked_at` and `park_reason` on the next prompt
into any terminal of the task. Its optional free-text reason is where "blocked
on the API key" lives, and there is deliberately no Blocked phase, since
blocked is a reason for parking rather than a stage of the work. Done outranks
Parked (a parked task whose PR merged is finished either way), and Parked
outranks even an open PR, because it is the most specific and most recent thing
a person has said about the work, and the row's PR chip still says the PR is
open.

**A `goal` is text, not a state.** It records what the task is for, feeds no
rule in the table, and exists because there was nowhere else to write one down:
the only place was the agent's prompt box, and submitting that stamps
`started_at`. A task with a goal and no `started_at` reads as **Planned**, and
that reading is rendered from those two fields rather than derived into a sixth
value: a Planned phase would store what `started_at` already answers. There is
no Planned pill and no `"planned"` in `PHASE_ORDER`; the dashboard row draws
the goal and that IS the reading. Where goals come from, and the four controls
that write these two fields, are in "Setting a goal, and parking" below.

**Todo is where every new task starts, and that is the normal case, not a
rarity.** Creating a task spawns its agent, so a spawn is not evidence that
anybody has given it work: the agent is sitting at its prompt waiting for one.
**In progress** begins at `started_at`, the first prompt a human submits into
any terminal of the task, stamped write-once by `markStarted` in `useApp` at
each place user text reaches a terminal (the GUI's Enter, a queued prompt, the
New Task dialog's seed, a library prompt, sent review comments, and the CLI's
`termic send`). Enter in a plain shell tab counts too: someone running the
task's tests has started working on it in every sense this screen cares about.

**The git rule** is the second half of In review, and it is what a task that
was worked on and handed off looks like when there is no PR: `own_commits >= 1`
(the branch has commits the base cannot reach), `dirty === false` (nothing
staged, unstaged **or untracked** in the worktree) and `ahead === 0` (the
remote branch exists and has everything). `ahead === null` means there is no
remote branch at all, which is not the same as nothing left to push, so it does
not qualify. `base_known` is deliberately not a condition: the commit count is
taken against the base branch, not the creation commit, so an imported
worktree or a reused branch (whose `base_sha` is None by design) qualifies like
any other. Only `merged_into_base` needs the creation commit, and Rust folds
that in on its own. A **draft or closed PR outranks this rule entirely**: both
are an explicit statement by a person about how ready the work is, and a clean
pushed branch underneath does not overrule it, which is why the rule requires
`pr` to be absent rather than merely not-open.

**Stop is deliberately not an input.** "The user stopped the task" is the
obvious signal for handing off, and it is unusable: it is not persisted
anywhere, so it is every task's state after a relaunch, and a phase that read
it would move the whole fleet to In review on every launch. The git rule
answers the same question from facts that survive a restart.

The decisions that table encodes, all of them argued in that file's header:
archived beats merged (a shelved task is finished whatever its PR did); a draft
PR is In progress, because a draft says outright that it is not ready to look
at; a closed unmerged PR falls back to In progress, not Todo, because the
branch has real work on it; `changes_requested` stays In review, so the phase
does not oscillate with every review round; a failing check does not move the
phase at all (CI is a property of the work, not a stage of it, and the PR chip
already turns red); a failed PR lookup has `pr === null` like "no PR" does and
therefore falls through, so a machine with no `gh`/`glab` still phases
correctly; an unknown git state does the same (`undefined` for a task nothing
has polled, `null` for one whose lookup failed, both "we do not know"); and a
main-checkout task never enters the git rules at all, because `pollableTasks`
skips `is_main_checkout`.

**With no PR, the phase moves In progress <-> In review with each work
cycle**, and that is truthful rather than noisy: edit something and the tree is
dirty, so it drops back; commit and push and it returns. It is a different
thing from the review-round oscillation the design avoids, where
`changes_requested` deliberately does not move the phase because a reviewer's
opinion is not a change in where the work stands. One consequence on purpose: a
stray untracked file pins a task at In progress. Unfinished work in the
worktree is unfinished work, whatever the commits say.

**Once a PR is open, none of that applies.** An open PR reads In review however
dirty the worktree is and however many commits are unpushed. The asymmetry is
real and deliberate: without a PR a single untracked file pins a task at In
progress, and with one, nothing local moves it at all.

An open PR is an explicit act by a person saying the work is ready to be looked
at. `dirty` and `ahead` are PROXIES for that same statement, used only where
the person has not made it, and a proxy must not overrule the thing it stands
in for. The practical half matters as much: a dirty worktree under an open PR
is what addressing review comments looks like, so a phase that flipped on every
edit would be noise, for the same reason `changes_requested` is kept out of the
phase. A draft PR is the control that shows this is a rule rather than an
oversight: it is the person saying the opposite, so it reads In progress even
on a clean, fully pushed branch.

**On upgrade**, existing tasks are backfilled: one that had ever spawned an
agent reads In progress, so nothing that was underway reappears as Todo, while
tasks created from here start in Todo and earn In progress at their first
prompt.

**The git pass is scoped to this page.** `useTaskGit`
(`src/store/taskGit.ts`) is shaped like the PR store, with one deliberate
difference: `startDashboardGitPolling()` / `stopDashboardGitPolling()` are
mounted by the Dashboard's effect and nothing else ticks it. That effect is
gated on there being tasks, the same gate `initPrStatusPoller` has: on launch
the page mounts before `loadAll` resolves, and starting there would spend the
immediate pass on an empty store and leave every git-derived phase reading In
progress until the next tick. The phase is drawn
only here, the Dashboard is mounted only while no task is open, and
`task_git_phase_state` shells out to git, so nothing runs while the user is
driving an agent. Inside a pass: sequential, at most 6 tasks, stalest first, a
30s floor per task, skipping archived, main-checkout, and any task whose PR is
open or merged (those decide the phase on their own). Draft and closed PRs are
still polled, because `merged_into_base` has to be able to beat them: a
squash-merged branch whose PR was closed rather than merged would otherwise
never reach Done. See [performance.md](performance.md).

**The filter row** (`data-testid="dashboard-phase-filter"`) sits between Recent
and the Projects header and renders only when at least one non-archived task
exists, so a fresh install sees the page it always saw, or while a filter is
selected, so archiving the last task cannot strand the empty line with no pill
to clear it. Pills are All then `PHASE_ORDER`, each a `<button>` carrying
`data-phase`, `data-count` and `aria-pressed`. **All six are always on
screen**, in lifecycle order (All, Todo, In progress, In review, Done, Parked),
so the vocabulary stays stable between visits and the row reads left to right
as a task's life. Parked sits at the END, after Done, and that is deliberately
not its precedence in the table above: the first four pills are a task's life
in sequence, and Parked is not a stage of that life, it is a task stepping out
of the line. Between In review and Done it would break the reading the row
exists to give, so it goes where a state that SUSPENDS the sequence belongs.
`PHASE_ORDER` in `src/lib/taskPhase.ts` is the one list all of this comes from.
Todo used to be conditional, on the theory that a permanent
"Backlog 0" was a word the user learns to ignore; that premise went with
`spawn_count`, since a task is now Todo until somebody prompts it and a pill
that comes and goes is worse than a zero. Clicking the selected pill clears the
filter.
Counts are over every non-archived task and do not change when a pill is
picked. Selecting a phase drops non-matching rows, then drops a card with no
rows left, then drops a group whose members all went; the Projects header count
stays the number of projects, because a task filter does not change how many
projects exist. When nothing matches, one line replaces the cards
(`data-testid="dashboard-phase-empty"`): "Nothing in progress" / "Nothing in
review" / "Nothing done" / "Nothing to do", an explicit map
(`PHASE_EMPTY_LABEL`) rather than a sentence assembled from a label. Recent is
not filtered: those eight are where you just were, which is a different
question. The filter lives in `useUI` and is session-only on purpose, since the
dashboard unmounts the moment a task is opened.

**The age label** (`data-testid="task-age"`) is `taskAgeLabel(last_opened_at)`,
in the right-hand cluster before the PR chip, with the full stamp in its
`title`. It appears only from one day old, because a row stamped minutes ago
does not need telling, and it shows nothing at all for a record written before
`last_opened_at` existed rather than guessing one. It is uncoloured.

**Neither the pills nor the age carry colour, and the phase is not drawn on the
row.** The PR chip owns green, purple and red on this page; a coloured phase
pill invites the reader to match two colour vocabularies that mean different
things, and a row reading "In review" beside a chip that already says open is
the redundancy PR #292 was rejected for. The row still exposes
`data-task-phase` for the e2e suite. The sidebar gets no phase in this pass
either: its rows are the densest thing in the app and already carry a CLI
glyph, a work badge and a PR chip. It is the obvious follow-up once the ladder
has been lived with, not something to add at the same time as inventing it.

**Two things about the ladder ARE on the row, both in the age's register**:
faint, uncoloured, one line, no chip. That register is the whole rule here,
and it is what #292 got wrong, since its coloured status square sat beside the
PR chip using the same colours for opposite meanings (purple was both "merged"
and "In review").

- **The goal** (`data-testid="task-goal"`), truncated to one line with the full
  text in its `title`. It is what makes a planned task LOOK planned: without
  it, a task with a goal and a task nobody has touched are the same empty row.
  It is laid out `flex-1` (basis 0) rather than `shrink`, so it takes only what
  the name and branch leave and is the first thing to give when the row runs
  out of width. Two shrinking items with natural bases split the deficit in
  proportion to their length, which is how a long goal would crush the task
  name, the same trap the Git Compare bar's two-row wrap records above. The
  goal stays on the row after the task starts, because it stays on the record.
- **The phase glyph** (`data-testid="task-phase"`, carrying `data-phase`), one
  monochrome shape on EVERY row, between the age and the badges so it lands in
  the same column whether or not the row has a PR chip. Empty ring for Todo,
  half filled for In progress, ring with a dot for In review, check for Done,
  and the same Moon the Park menu item carries. The label, plus a
  `park_reason` when there is one, is in the `title`.

  The first version of this drew NOTHING on the row, reasoning from #292 that
  any mark beside the PR chip repeats it. What that produced was a board where
  Todo, In progress and Parked were invisible and the other two were legible
  only because the chip happened to be there: three treatments in one column
  and no answer at all on most rows. #292's objection was narrower. Its status
  square was COLOURED, in the chip's own vocabulary, so purple meant "merged"
  on one and "In review" on the other and the two could contradict each other.
  Neither half holds here: colour stays the chip's, and the phase is DERIVED
  from the PR state, so a merged PR is Done and the two marks cannot disagree.
  Monochrome also means the phase still reads for someone who cannot tell the
  chip's green from its purple, which the chip alone never did.

  The chip is not merely redundant either. It carries what the phase throws
  away on purpose: failing checks and draft, because CI status is a property
  of the work rather than a stage of it.
- **A parked row is DIMMED** (`opacity-60`, what the sidebar already puts on a
  task with no live PTY), so "put down" and "not running" look alike, which
  they are. Both the dim and the glyph key on the derived PHASE, not on
  `parked_at`, so a row can never read Parked while the Parked pill would not
  list it: Done outranks Parked, and a parked task whose PR merged is finished.

### Setting a goal, and parking

Four controls expose the two hand-set fields. Three of them WRITE: Start later
and Edit goal write `goal`, Park and Unpark write `parked_at` and
`park_reason`. Start with goal writes neither, it DELIVERS the goal, and
`markStarted` does the writing on the far side of that. Every one of the four
exists on both the sidebar task menu and the command palette, under the same
conditions, because a task-scoped action reachable from only one of the two is
an action half the users never find. Their predicates live in `src/lib/taskNotes.ts` so
one rule answers for both surfaces (and so vitest, which runs `*.test.ts` in a
node environment, can cover them at all).

**"Start later", in the New Task dialog, is the point of the whole feature.**
The dialog's Initial prompt box is delivered at create by
`seedPromptWhenReady`, and delivery ends in `markStarted`, so until now writing
down what a task was FOR meant starting it: the prompt box was the only place
to type. Ticking Start later (`data-testid="new-task-start-later"`) writes the
same text down as the task's goal and sends nothing. Everything else about
create is unchanged, so the worktree is still cut and the agent still spawns;
the task simply stays Todo, with a record of what it is for, until somebody
prompts it. Which of the two happens is `deliverFirstMessage` in
`lib/taskNotes.ts`, called from the dialog's one seeder, so all three create
paths (worktree, repo-root, import) take the same branch.

Two rules on the checkbox. It rides INSIDE the same `canPrompt` guard as the
prompt field, so it appears and disappears with the box it describes rather
than offering to save a goal from a field that is not on screen. And it is
**reset on every open** and never persisted: this dialog is permanently mounted
from `Dialogs.tsx`, so the reset effect is the only thing that clears it, and a
sticky Start later would quietly stop starting tasks.

**"Start with goal"** (`data-testid="task-menu-start-with-goal"`) delivers a
planned task's goal through that same seeder with the same patient deadline, so
the task starts exactly as it would have at create. It shows only for a task
that HAS a goal, has never been prompted, and runs an agent with a prompt box
(a plain shell would just get prose typed at it and Return pressed). It
activates the task and calls `ensureDefaultTab` FIRST, the order
`spawnIntoTask` uses: an unmounted task never spawns a PTY, so the seeder would
sit out its deadline and give up silently. It does NOT clear the goal, which
stays as the record of what the task is for; the row disappears on its own
because delivery stamps `started_at`.

**"Edit goal…" / "Set a goal…"** (`data-testid="task-menu-edit-goal"`) opens
`TaskGoalDialog` on the current value. It sits beside Rename, because the two
are the same kind of thing: what the task is called and what it is for. An
emptied box clears the goal, the same answer `null`, an absent field and a box
holding only spaces all give (`normalize_task_note` in Rust,
`normalizeTaskNote` in `store/app.ts`, `noteText` in `lib/taskNotes.ts`, and
all three must keep agreeing). The field is a **textarea**, not an input: a
goal usually arrives from the New Task dialog's multi-line prompt box, and
`<input type="text">` silently strips the newlines out of its own value.

**"Park task" / "Unpark task"** (`data-testid="task-menu-park"`) follows
`parked_at`. Park opens `ParkTaskDialog` for the optional free-text reason;
unpark is immediate, because there is nothing to ask. Because that one row
flips to Unpark as soon as `parked_at` is set, a parked task gets a second row,
**"Edit park reason…"** (`data-testid="task-menu-edit-park-reason"`), which
re-opens the same dialog pre-filled. Saving from there leaves the task parked
and does NOT move `parked_at`, since the stamp answers "since when" and
clarifying why is the usual reason to open it twice. The dialog says "Edit park
reason" and "Save reason" in that mode, and hides the "Also stop the task"
checkbox: editing a note must not kill the agents. **The park clears
itself**: the next prompt into any terminal of the task runs `markStarted`,
which wipes `parked_at` and `park_reason` together, so a parked task you start
working on again is not left lying about its own state. That is the third
clause of the rule the whole design stands on, and it is what lets a hand-set
value exist here at all.

**Blocked is a REASON, not a state.** "Blocked on the API key" goes in the park
reason. A Blocked phase would be a second hand-set value carrying no evidence,
which is the shape #292 was rejected for.

**Park and Stop are separate actions, on purpose.** The park dialog offers
"Also stop the task" when the task is mounted, ticked by default, because
putting work down usually means wanting the memory back too. It fires
`stopTask` as a SECOND call after `setTaskParked`, and the coupling goes no
further: `stopTask` is a resource action (GH #119, kill the PTYs and keep the
session) and must never on its own set `parked_at`. Stop is every task's state
after a relaunch, so a Stop that parked would park the whole fleet overnight.
The checkbox is hidden when nothing is mounted, since there would be nothing to
free.

### `work-badge` is no longer a unique testid

The sidebar is always mounted and the dashboard sits on top of it, so a task
with a live agent renders the badge TWICE. A bare
`[data-testid="work-badge"]` query returns the sidebar's, in document order.
Every assertion must scope: `dashboardBadge()` goes through
`[data-dashboard-task-id]`, `sidebarBadge()` through `[data-sidebar-task-row]`.

### Recent is a way back in, not a second History

`recentTasks` in `useApp`: task ids, newest first, capped at
`RECENT_TASKS_CAP`, localStorage-backed and written inside the `set()` that
`setActiveTask` was already doing (a separate write would copy the whole state
again for a list nobody renders while a task is open). Archived and deleted ids
are pruned in `loadAll` alongside the group maps, so the row never offers a
dead link. It is hidden entirely when empty, so a fresh install sees the page
it always saw.

`last_opened_at` on the `Task` record now exists and is the durable, coarse
stamp the age label reads: one record write, at most once a minute, guarded on
both sides (see [ipc.md](ipc.md), `task_touch`). Recent stays in localStorage
anyway, because it is a different thing: an ordered list of the last eight
visits, at a resolution finer than a minute, which a single per-task stamp
cannot reproduce.

## A gauge that is a background, and what it costs the text on it

The task footer's usage chip (GH #277) draws each window's gauge as the fill
behind its own figure: `85% wk` sits on a box filled 85% of the way across,
with the unused part left as a visible track. It has been three designs, and
the reasons are worth keeping because they are not about this chip.

One bar, showing whichever window was closest to its limit, sat hard against
the 5h number and displayed the OTHER one. Two bars fixed that and left four
marks for two facts, costing 56px of a bar that starts hiding chips at 780px
(264px with the pills, 219px without). Both were reported by someone looking
straight at the thing, which is the only evidence that counts for a footer
meant to be read at a glance.

**A fill behind text costs that text contrast, and the cost lands where you
can least afford it.** Amber text on an amber fill measures 3.3:1 in dark
mode, so the number gets hardest to read exactly when it matters most, and
tuning the mix does not rescue it (22% still only reaches 4.08). So the BOX
carries the severity and the text carries the reading: warn and critical inks
go neutral-bright instead of taking their own hue, which puts every
level/theme pairing above 4.5:1 and in light mode actually improves on what
shipped before (warn was 3.71:1 on cream). A red-filled box is louder than red
text ever was.

**The quiet end is where the real constraint binds.** `normal` keeps a dim ink
so a calm chip does not shout, and dim ink falls through 4.5:1 once its fill
passes 18%. That caps how visible a calm gauge's fill EDGE can be (1.40 in
dark against 5.87 for warn). The trade is stated rather than hidden: the box
is always plainly a box, so a nearly-empty one is never mistaken for a failed
render, and the fill earns visibility as it grows.

Two mechanics that generalise: the fill is a **hard stop**, not a fade, because
a gradient that eases out has no readable edge and "where does it end" is the
whole question the shape answers; and both layers are `color-mix(...,
transparent)` over the footer's own ground, so a custom theme's tokens carry
through without the component knowing any of them.

Measurements live next to the constants in `AgentChip.tsx`. Re-derive them
before moving a number, and do it in both themes: every one of these values is
the ceiling of something.

## Scheduled queue messages (GH #300)

The queue popover's "Send after" row (Next turn / Tomorrow / In 3 days / In a
week / a date) turns a message into a scheduled one. The promise, stated under
the picker and never stronger: **sent the next time this chat is open and idle
on or after the date.** Nothing fires on its own. There is no daemon and no
Rust timer; with the app closed, `open -a Termic && "$TERMIC_CLI" send <task>
--resume -p "..."` under launchd is the headless route.

- **Dates are local midnight.** A preset or a picked date resolves to the start
  of that day, so "in a week" made at 14:05 still sends when the chat is opened
  at 09:00 that day. A date input is parsed as local, not UTC
  (`localDateValue`), which would be a day early west of Greenwich.
- **The drain** (`sendNextQueued` in TerminalPane, rules in
  `lib/scheduledQueue.ts`'s `pickQueueItem`): a due scheduled item sends
  whether or not the queue is active; a future one is skipped so ordinary items
  behind it still drain; future items do not keep the loop "running" and
  suppress the "Message queue finished" toast. A respawn pauses ordinary items
  and leaves scheduled ones alone, because a reopened chat is exactly when they
  exist.
- **A scheduled send waits for readiness**, like `seedPromptWhenReady`: it can
  be the first thing typed into a session resumed seconds ago, and claude's
  startup dialogs eat keystrokes (its trust picker answers `No, exit` on the
  submit). `blocked`, `lost`, a PTY swap, a turn the user started during the
  wait, or a missing echo all KEEP the item for the next try. It is removed and
  the file rewritten only after the write lands. More than an hour late toasts
  "Scheduled message sent (due N days ago)"; the prompt text is never changed.
- **Two kicks.** The PTY coming up (`tabPtyLive` in the queueKick effect's
  deps) covers reopening a chat. For a chat already open when the date passes,
  `lib/scheduledTicker.ts` walks mounted tabs once a minute and bumps
  `queueKick` only on a live, idle tab with a due item; a pass with nothing due
  writes nothing to the store. Not per-tab `setTimeout`s: past ~24.8 days the
  delay overflows, and timers do not track sleep.
- **Closing** a secondary or pane agent tab that holds scheduled messages asks
  "Delete scheduled messages?" even with the close confirm turned off, because
  the Resume list does not bring them back. The main strip tab stays durable
  when closed, so it does not ask.

Must be checked by hand whenever the readiness path changes: a resumed claude
session that shows an update or trust dialog at startup. No suite catches a
prompt typed into a splash screen.

## Settled detection / notifications

TerminalPane samples `term.buffer.active` every 3s, FNV-1a hashes the visible viewport, marks tab "settled" after 2 identical consecutive samples. Resets on user input. `markAttention(wsId, tabId, reason)` never marks the active tab in the active task. `useAttentionNotifier` suppresses OS notifications for every tab in the focused task. Desktop notifications off by default. Clicking a banner only brings the window forward: it never changes the active task or tab (the old focus-edge router jumped on any refocus within 15s of a notification, including a plain cmd-Tab). The unread dot is what points at the tab; the user does the switching.

## Settings: where a feature's row belongs

Agent hooks sits under **Agents & Terminals**, not Notifications, and the route
there is worth recording because the first answer was wrong.

The case for Notifications was real: the four settings there (desktop
notifications, completion sound, the done indicator, the in-progress spinner)
are all downstream of work-state detection, and hooks is where that detection
comes from. True, and beside the point. Notifications is where you choose
whether to be TOLD; hooks is how termic KNOWS, it writes into the agent's own
config, and it changes how that agent behaves.

The tell was the cross-reference. Placing it under Notifications required a
signpost on the Agents page pointing at it, which is usually evidence a thing
is in the wrong place: nobody looking for "how does termic know what claude is
doing" opens Notifications. The pointer now runs the other way, from the four
indicators to the thing that decides them, which is the direction that needs
explaining.

Two consequences worth keeping. The rows stay in ONE table above the per-agent
tabs rather than a field on each card: "not needed, its terminal already
reports this" and "not supported yet" only mean something next to each other,
and it is a decision made once, not a per-agent preference. And the link out of
Notifications does not gate on which agents are supported; the table is the
authority on that.
