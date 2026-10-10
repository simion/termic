# Keyboard shortcuts

## Architecture

`src/lib/shortcuts.ts` is the single source of truth: `ShortcutId` union + `SHORTCUT_DEFS` (each: `id`, `group`, `defaultBinding`). A `Binding` is `{ cmd, shift, alt, key }` where `cmd` folds Cmd=Ctrl, `key` is a normalized token or `"1-9"` sentinel.

The rows' **wording is not in that file**: labels, hints and the mode select's
options are locale entries (`settings:shortcuts.defs.*`), reached by id through
`src/lib/shortcutCopy.ts`. The Shortcuts page and the ⌘/ sheet both draw the
same rows, so one copy is the only way they cannot disagree, and a new
`ShortcutId` is a compile error until it has a key there. A dynamic key like
that is invisible to `usedKeys.test.ts` (it reads literals) and to
`parity.test.ts` (it only compares en against zh-CN), so
`shortcutCopy.test.ts` is what pins it: every id resolves to a label in both
languages, the hint set matches across them, and no copy is left behind for a
row that no longer exists.

**Adding a shortcut** = new `ShortcutId` + `SHORTCUT_DEFS` entry + `case` in `useShortcuts` (for global ones). Help modal and settings editor are data-driven from `SHORTCUT_DEFS`.

## Runtime

- **Resolved bindings** in prefs store (`usePrefs(s => s.shortcuts)`): `DEFAULT_BINDINGS` merged with localStorage overrides. Mutate via `setShortcut`/`resetShortcut`/`resetAllShortcuts`.
- **Global handler** (`src/hooks/useShortcuts.ts`): one `keydown` listener, matches via `bindingMatches(e, binding)`.
- **Contextual shortcuts** (need component state) handled inside the component with a capture-phase listener that `stopPropagation`s only when it claims the key. Shared chord meaning different things by context is expected, not a bug.
  - A component that stays MOUNTED while off screen (every visited task, every open tab) must gate that listener on an app-wide claim, not "am I laid out". Several instances answer the latter yes at once, and capture + `stopPropagation` means the loser doesn't just misfire, it eats the chord from whoever should have had it. Store state can't finish the job either: it doesn't model the bottom split, the right panel, or a modal on top. See the ⌘F bullet in [gotchas.md](gotchas.md#reactzustand-traps).
- **Help modal** (`ShortcutsHelpDialog`, triggered by `open-shortcuts`): read-only, grouped by `GROUP_ORDER`. Edit button jumps to Settings → Shortcuts.

## What "Cmd" is on each platform, and what a real key looks like

One table serves all three platforms. `Binding.cmd` is Cmd on macOS, and off
macOS it is Ctrl OR the Windows / Super key (`eventCmd` in `lib/shortcuts.ts`).
The second half is what makes shortcuts usable from INSIDE a terminal there:
plain Ctrl+letter is the shell's (Ctrl+J is a line feed, Ctrl+P is readline's
previous line), so the terminal keeps all of them, and of the Ctrl chords only
the handful in `PASS_TO_APP` that also carry Shift or Alt are handed to the
app. Win+J on Windows and Super+J on Linux toggle the terminal panel from a
focused terminal exactly as ⌘J does on a Mac.

Three things a real key does on Linux that a synthetic `KeyboardEvent` never
shows. All three were measured with real X key events against WebKitGTK 2.52,
and `e2e/specs/shortcuts-linux.e2e.ts` presses every binding that way:

- **Super is never reported as a modifier.** Super+J arrives as `key: "j"`
  with `metaKey: false`, and `getModifierState` is false for `Super`, `OS`,
  `Meta` and `Hyper` alike. What does arrive is the Super key's own keydown
  and keyup (`key: "Super"`, `code: "OSLeft"`), so `shortcuts.ts` tracks the
  held state from those and clears it when the window loses focus (GNOME
  takes the focus, and the keyup, when Super is released alone). A terminal
  asks `superIsHeld()` in its key handler and returns false, or the bare
  letter is written to the PTY.
- **Shift+Tab is `key: "Unidentified"`** (X's `ISO_Left_Tab` keysym). Anything
  that means Tab reads `isTabKey`, which falls back to `code`. ⌃⇧⇥ never
  walked backwards before it did.
- **Shift turns punctuation into another character.** ⇧⌘[ arrives as `{`, so
  the default previous / next tab chords never matched. `eventKeyToken` takes
  Shift's effect back out, and a recorded binding stores the key, not the
  character.

Settings → Shortcuts says so on Linux (`shortcuts.terminalNote`), and draws its
key chips in the platform's order: `bindingGlyphs` emits Ctrl, Alt, Shift off
macOS, the order `bindingText` already printed, where the chips used to read
"Shift Ctrl A". Copy and paste in a terminal are the terminal's own (they are
handled in its key handler, before the Super guard), so Super+Shift+V pastes
like Ctrl+Shift+V does.

**Off macOS a terminal gives the app every chord that carries Shift or Alt
with Ctrl** (`isAppChordInTerminal`), and keeps plain Ctrl+letter for the
shell. That was always the stated rule and used to be applied to four
hand-picked shortcuts, so Ctrl+Alt+Left (pane left) or Ctrl+Alt+P (prompt
palette) pressed in a terminal went to the PTY as an escape sequence. The
terminal's own three are excluded: copy, paste, and Ctrl+Shift+F, which there
is that terminal's find.

**The desktop takes some chords before any application sees them**, and which
ones is a fact about the desktop, read here from GNOME's own settings on
Ubuntu 26.04 (`gsettings list-recursively | grep '<Super>'`), not from memory:

- Super+1 to 9 and Super+0 (dock applications), Super+A, D, H, L (lock), M, N,
  O, P, Q, S, V, Super+Tab, Super+Space, Super+arrows, Super+Page Up / Down.
- Super+Alt+Up / Down and Super+Alt+Left / Right.
- Ctrl+Alt+Up / Down (workspaces), Ctrl+Alt+T, Ctrl+Alt+Tab.

What that costs Termic on that desktop:

| Shortcut | Default | From inside a terminal |
| --- | --- | --- |
| Previous / next task | Ctrl+Alt+Up / Down | Nowhere: GNOME keeps both this and the Super form. Alt+Up / Down (sidebar row) does the same job outside a terminal; otherwise rebind |
| Pane left / right | Ctrl+Alt+Left / Right | Ctrl+Alt+Left / Right (the Super form is GNOME's) |
| Jump to tab 1 to 9 | Ctrl+1 to 9 | Not reachable: Super+digit is the dock's |
| Focus main agent, split right, new task, file finder, task finder | Ctrl+L, D, N, P, O | Not reachable: the shell keeps the Ctrl form and GNOME the Super one |
| Zoom reset | Ctrl+0 | Not reachable (Super+0 is the dock's) |
| Everything else | | Super+key, or Ctrl+Shift / Ctrl+Alt+key |

Those rows are a property of the default bindings on one desktop, not a bug in
the matcher, and every one is rebindable in Settings → Shortcuts. Choosing
Linux-specific defaults that avoid them is an open decision.

A grabbed chord must not leave Super "held". Measured under a window manager
that grabs Super+L and Super+Alt+Down (openbox with those two bound): the page
sees Super go down, never sees the grabbed key, sees Super come up, and the
next plain `j` is typed. Where the key-up is lost instead (the compositor
takes the focus with it), losing focus clears the flag.

Alt was considered as a second stand-in for Cmd and rejected: inside a
terminal Alt+letter belongs to the agent (Claude Code's Alt+T and Alt+P,
readline's Alt+B / F / D).

## Code navigation keys

The five editor jumps (`go-to-definition` F12, `find-usages` ⇧F12,
`go-to-implementation` ⌥⇧B, `go-to-type-definition` ⌥⇧T, `file-structure` ⌘F12)
are ordinary `SHORTCUT_DEFS` entries, so they appear in the help sheet and in
Settings → Shortcuts like anything else. They were five literal key strings in
a CodeMirror keymap: they worked for whoever already knew F12, could not be
found, and could not be changed.

They stay a **CodeMirror keymap** rather than moving to the window handler,
because they must fire only while an editor has focus (F12 in a terminal
belongs to the terminal). `bindingToCmKey` converts a `Binding` into
CodeMirror's notation, and the keymap is built per editor mount, so a rebind
takes effect on the next open rather than instantly.

Two defaults are deliberately NOT IntelliJ's. ⌥⌘B (its go-to-implementation)
already toggles the right sidebar here, and the editor's copy fired on top of
it; the duplicate-chord test in `shortcuts.test.ts` is what surfaced that. ⌃⇧B
cannot be expressed at all, because a `Binding` folds Ctrl into Cmd and it
would read as ⌘⇧B on a Mac.

**F12 needs no modifier**, which is why `isValidBinding` exempts F1-F20: a
function key types nothing, so it cannot swallow input.

They live in their own **Code navigation** group, named after the feature and
therefore after the type-checking switch (`shortcutGroupLabel` in
`lib/shortcutCopy.ts`, the one group heading that is not a locale entry). Back
/ Forward stay in Navigation: they walk a folder
listing's trail as well as the symbol trail, so filing them here would describe
half of what they do.

## Shortcuts that cannot be rebound

`FIXED_SHORTCUTS` is a small separate list for gestures that are not a chord.
Two entries: Double-Shift (Search everywhere) via `lib/doubleTap.ts`, and ⌃⇥
(Recently used tabs) via `lib/ctrlTab.ts`. Both are handled in `useShortcuts`,
and both carry a mode select in Settings where the recorder would be.

A row that carries such a select says so with `control`
(`"double-shift" | "ctrl-tab"`). The Shortcuts page and the ⌘/ sheet both
branch on it. They used to branch on `f.id === "search-everywhere"`, in five
places across the two files, which was fine while there was one such row and a
copy-paste bug waiting to happen as soon as there were two.

**Double-Shift cannot be rebound, so what Settings offers instead is WHEN it
applies** (`prefs.doubleShiftMode`, a select on that same read-only row):

| mode | label the reader sees | |
| --- | --- | --- |
| `off` | Off | never |
| `left` | Double left Shift | **the default** |
| `outside-terminal` | Double Shift, not in a terminal | never while a terminal has focus |
| `any` | Double Shift | JetBrains' own behaviour |

Every label names the WHOLE gesture, and the row prints nothing else beside
the select. It first shipped reading "Double tap, left" next to a select
saying "Left Shift only": the same gesture named twice, in two vocabularies,
neither half meaning anything alone. `DOUBLE_SHIFT_MODES` is the one list, and
the command sheet prints the current mode's label from it where a recorder
would be, so the two surfaces cannot word it differently.

The reason it needs a setting at all: this is two taps of the key that starts
every capital letter, and there is no other key to move it to. The right-hand
Shift is the one a touch typist holds for left-hand capitals, so excluding it
keeps the gesture while dropping the hand the accidents come from, and under
`left` a right-Shift press CANCELS a half-finished tap rather than being
ignored (left-right-left inside the window is typing, not a request).

The location test is written as "not the right-hand one", never
`location === 1`: a synthetic event carries location 0, and a rule demanding 1
would turn the gesture off wherever the location is not reported. The ⌘/ sheet drops the row
entirely when the mode is off, since a sheet printing a gesture that does
nothing is an instruction to press an inert key.

They are deliberately NOT in `SHORTCUT_DEFS`: everything there has a `Binding`,
and the bindings map, the conflict check, the Settings recorder and the
localStorage migration all assume one. A def without a binding would need a
special case in each.

Both surfaces render them read-only, with their keys spelled out literally and
a word where the recorder would be ("Double tap"). Shown rather than hidden,
because a reader looking for "how do I open Search everywhere" reads its
absence as the app not having it.

## Recently used tabs (⌃⇥ / ⌃⇧⇥)

Hold Ctrl, tap Tab to step back through the places you were actually looking
at, Shift to step the other way, release to land. A "place" is a
`(taskId, tabId)` pair, so it crosses tasks: used inside one task it degrades
into cycling that task's tabs.

It exists because every other navigation key here is POSITIONAL (⌥↑/↓, ⌥⌘↑/↓,
⌥⌘←/→, ⇧⌘[/], ⌘1..9), and none of them answers "take me back to the thing I
was just looking at". With eight agents open that is the question you ask most,
and the tab two slots to the left is not the tab you were in.

**Why it is not a `SHORTCUT_DEFS` entry.** A `Binding` cannot express it:
`bindingMatches` folds Cmd and Ctrl into one flag, so the nearest thing the
table could hold is `{cmd:true, key:"Tab"}`, which renders as ⌘⇥ and is dead on
macOS. It is also hold-and-tap rather than one chord, and it needs `keyup`,
which nothing else in the app does. `isValidBinding` therefore refuses Tab
outright (`isReservedKey`) — without that, recording ⌃⇥ in Settings would store
that half-dead binding and fire it on every press of the gesture, forever, on
top of the gesture itself.

**Why it may take a Ctrl chord at all**, when GH #10 deliberately gave Ctrl to
the terminal: nothing observable is lost. xterm's `evaluateKeyboardEvent` reads
only `shiftKey` for Tab, so ⌃⇥ reaches the PTY as a plain `\t` and ⌃⇧⇥ as a
plain `ESC[Z` — byte-identical to ⇥ and ⇧⇥, which are untouched. No program on
the far end could tell the difference, so there was no binding there to take.
It is still switchable off in Settings for anyone who wants that rule to have
no exceptions.

**Three listeners, not the usual one.** A window **capture**-phase `keydown`,
because xterm listens on its own textarea and its `cancel()` calls
`stopPropagation` — anything on the bubble phase never sees the key. Plus
`keyup` (the walk lands when Control comes up, detected as `!e.ctrlKey` rather
than `key === "Control"`, as `modKeyClass` does) and `blur`. The blur listener
is **non-capture**, and that is load-bearing: `blur` does not bubble but it
does capture, and the walk itself causes element blurs by hiding the pane it is
leaving, so a capture listener would abort on the first tap.

**A step is a PREVIEW, not a visit** — `previewPlace` in the app store, not
`setActiveTask`/`setActiveTabId`. Selecting something is how this app decides
you have SEEN it: `setActiveTask` clears `unread` on every tab of the task and
demotes the active tab's done state, resets the departing tab's timestamps,
force-expands the project and its group (two localStorage writes), reorders
`recentTasks`, and replaces `view` wholesale, which closes Settings. Flashing
past a finished agent on the way somewhere else would destroy the one signal
saying it had finished. The real setters run once, on landing.

**The ring is a snapshot** taken on the first tap, and recording is suspended
for the duration. Each step changes what is on screen, which is what feeds the
recency list; walking the live list would reorder it under the next keypress.

**It only offers places it can reach for free.** `livePlaces` filters on
`mountedTasks`, not on "does this tab still exist". `stopTask` keeps a task and
its tabs but evicts it from `mountedTasks` and kills its PTYs, so the weaker
check would let ⌃⇥ resurrect a task the user explicitly stopped. Navigation
must never start a process — which is also why the ring is session-only and is
not seeded from the persisted `recentTasks` at startup.

The list itself is `store/recentPlaces.ts`, fed by a subscription in
`lib/recentPlacesTracker.ts` rather than from inside the setters, so all thirty
call sites of those two setters record for free (deep links, the CLI, the
palette, LSP navigation, the sidebar). The push is coalesced into a microtask
because picking a task and a tab is one act that three call sites perform as
two calls.

## Back and Forward (⌘[ / ⌘])

One chord, one idea: go back to where you just were. It used to mean three
things chosen by where focus happened to be (switch task, walk a folder
listing's trail, retrace a symbol jump), with the two histories claiming it
conditionally on top of task switching and each carrying an escape hatch so it
"never silently stole" the key.

All of that machinery existed to protect task switching, which ⌥⌘↑ / ⌥⌘↓
already do and do inside a split too (tabs have ⇧⌘[ / ⇧⌘]). Removing it removed
the conditionals with it: the handler is now the folder listing if it has
somewhere to go, else the symbol jump trail, else nothing. A key that quietly
changes which task you are looking at once a history runs out is how people
lose their place.

The listing goes first because it is the more local history and the one you can
see. `dirHistoryTarget` (pure, unit-tested) decides which listing may claim it
from DOM-focus facts, rather than that logic living inline in the handler.

The ids are `nav-back` / `nav-forward`. They were `task-prev` / `task-next`, and
before that `workspace-prev` / `workspace-next`; `lib/lsMigration.ts` carries a
user's rebind across both renames.

## ⌥-click on a changed file row

Not a rebindable binding (it is a mouse modifier on one surface, not a
`useShortcuts` entry): ⌥-click on a row in the Git panel's Commit or Compare
list opens the FILE rather than its diff. The context menu's "Open file" is
the discoverable half of the same action; see docs/ui.md, "Two readings of one
changed file", for why the diff is not always the right reader.

## Glyphs

`bindingGlyphs(b)` returns `["⌥","⇧","⌘", key]`. Help modal uses raw glyphs (⌘ ⌥ ⇧); settings editor uses `glyphLabel` (Cmd/Ctrl, Option/Alt). `isValidBinding` requires Cmd/Ctrl or Option to prevent swallowing normal typing. The top-bar command-palette button (docs/ui.md) builds its tooltip the same way, so a rebind retitles it.

## Kanban filter bar (`/` and ⌘F)

Contextual, in `BoardFilterBar`'s own capture listener, not `SHORTCUT_DEFS`:
the board is mounted only while it is the view, and the overlay clears
`activeTaskId`, so no task's find handler competes for ⌘F while it is up.
It stands down for a modal (`[role="dialog"]` around the active element),
the Settings overlay (store flag only, it traps no focus), and, for `/`
alone, any editable control already holding the keyboard (`select` included,
`contenteditable="false"` not). ⌘F is matched with `bindingMatches`, so it
inherits the AltGr guard and the Ctrl fold off macOS, and it also stands
down when the user has bound ⌘F to a command in Settings: the listener runs
in the capture phase and stops propagation, so claiming it anyway would
swallow that binding before `useShortcuts` saw it. See docs/ui.md "Kanban
view" > Filtering.

## Prompt palette (⌥⌘P)

`prompt-palette` (default ⌥⌘P) is a plain single-chord shortcut that opens `PromptPalette.tsx`: a searchable list of enabled prompts (fuzzy-filtered by title only). Enter runs the highlighted one; while the query is empty, digits `1-9` fire the top rows directly (a positional accelerator, Raycast-style, not a persisted per-prompt key). Firing goes through `fireOrPickDestination` in `src/lib/promptFire.ts`, which sends straight to the focused agent tab or falls back to the shared destination-picker dialog (`PromptDestinationDialog.tsx`) when there's no focused live agent. The Prompts dropdown in `UnifiedBar.tsx` always opens the picker so you can tweak the body and choose a target.

## Task finder (⌘O)

`task-finder` (default ⌘O) opens `TaskFinderDialog.tsx`: a centered
fuzzy-search palette to quickly jump to any active task across all
projects without touching the mouse or disturbing the sidebar tree layout.
When the query is empty, it orders tasks by recency (`recentTasks`),
placing the current task first. Querying matches across task names, project
names, git branches, and agent CLIs. Enter activates the task
(`setActiveTask`) and focuses its main tab, while Escape restores focus to
whichever element was previously focused.

## Add selection to agent (⇧⌘L)

`add-selection-to-agent` is contextual, not global: it has no `case` in `useShortcuts`. `EditorPane` owns it, and answers only when the selection is non-empty AND the editor either holds DOM focus or is the visible active tab (`focused ? focused !== v.dom : !isActive`) — the two are mutually exclusive, so two mounted editors can never both fire on one press. With no selection it does not `preventDefault`, so the chord falls through untouched.

⇧⌘L is what the agent-first editors converged on for this action (Cursor's "Add selection to Chat", VS Code Copilot's "Add Selection to Chat"; Zed uses ⌘>), and it sits next to termic's own ⌘L "focus main agent".

It does not send anything. It opens the review-comment composer (`dispatchSelectionComment` in `reviewCommentsExt.ts`) on the selected lines — the same surface the diff pane uses, so editor remarks queue in the `reviewComments` store alongside diff ones and go to the agent as ONE batch from the pending-comments bar. The pointer route is the gutter icon that appears next to a selection (the diff's labelled pill stays on the diff, see [ui.md](ui.md#inline-review-comments-two-surfaces)). Both paths land in the same place; neither writes to a PTY on its own.

## ⌘W on an empty window closes the profile

`close-tab` closes the innermost thing there is to close, and when a window has
no task open the window itself is that thing. That is the browser convention
(a tab, then the last tab takes the window with it).

**Never the last window.** Closing that one is a QUIT, not a close: it is
governed by the close-action setting (menu bar / quit / ask) and by ⌘Q.
Escalating a tab-close key into a quit is how someone loses the agents they had
running, so ⌘W is a no-op there.

The check is split on purpose. `shouldCloseProfileWindow` (`lib/profileScope`)
decides only whether this window is empty enough for the shortcut to mean the
window; **Rust owns the window count**, in `window_close_if_not_last`. The
frontend learns about a sibling closing through an event, so its count can be a
moment stale, and being wrong in that direction quits the app.
