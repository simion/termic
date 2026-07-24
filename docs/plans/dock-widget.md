# Future work: ambient agent status (Dock tile, menu bar, Dock-flank strip)

Deferred, not yet built. Captured after researching the "widget parked next to
the Dock" look (see prior art below) and deciding which parts of it termic
actually wants.

## The problem

Agents finish, or block on an approval, while termic's window is behind a
browser or another editor. That is precisely when the sidebar's unread dots are
invisible, so the only signal today is an OS notification, and that signal is
fire-and-forget: macOS `osascript` notifications expose no click callback, so
`useAttentionNotifier.ts` routes clicks with a focus-edge heuristic (a 15s
window after firing, with acknowledged false positives).

An always-visible surface fixes both halves: it shows state without switching
apps, and it gives the user a real click target that routes to the exact
(task, tab).

## Prior art (what that screenshot was)

macOS has no native "widget in the Dock" slot. Apple's widgets live in
Notification Center and on the desktop. The glass weather panel sitting flush
against the Dock is a third-party floating window: docktor
(<https://docktorapp.com/>), Cooldock (<https://www.dock.cool/>), plus
ExtraDock, Dockspace, DockFix, and Docky
(<https://github.com/josejuanqm/docky>, open source, the useful reference
implementation). docktor requires macOS 26 and Accessibility.

The reclaimed space is real: `NSScreen.visibleFrame` already excludes the Dock
band across the full screen width, so no maximized window extends into it. On a
1512pt display with a ~10-icon Dock that is roughly 450pt of dead pixels on
each side, about 60pt tall.

## Constraints (decided up front)

These are not open questions. They bound every option below.

1. **No Accessibility permission.** Hugging the Dock pill needs the Dock
   process's AX list element; the Dock's `CGWindow` covers the entire screen,
   so `CGWindowListCopyWindowInfo` cannot give you the pill rect. A permission
   prompt is too high a price for cosmetics in a dev tool. The permission-free
   alternative is `NSScreen.frame` minus `visibleFrame`, which gives the Dock
   edge and thickness, so a strip can be corner-anchored inside the same band
   without ever knowing where the Dock pill starts.
2. **No second WKWebView.** Performance trumps polish. A second webview is tens
   of MB plus its own render pipeline, permanently resident, for a strip of
   text. Any always-visible surface is drawn natively (AppKit through `objc2`,
   already a dependency) and fed a compact, debounced model from the main
   window. If a surface can only be built as a webview, it does not ship.
3. **No WidgetKit.** Out of scope. It would need a Swift `.appex` built outside
   the Tauri pipeline, embedded and signed into the bundle, plus an App Group
   for a non-sandboxed Developer ID app, and the result lives in Notification
   Center where nobody sees it until they swipe.

## The surfaces

### 1. Dock tile (build first)

`NSApp.dockTile` takes a `badgeLabel` and, if wanted later, a `contentView`
drawn into the icon (`display()` to flush). No permission, no new window, no
minimum-version floor, works while termic is backgrounded. `objc2-app-kit` is
already in `Cargo.toml` and already drives `NSApplication` in `lib.rs`
(`set_dev_dock_icon`).

Scope:

- Badge = count of tabs in the "needs you" state, suppressed for the focused
  task exactly like the notifier does today (`state.activeTaskId === taskId`
  suppresses, run/setup tabs excluded).
- Optional second step: a custom `contentView` drawing a small state grid
  (one cell per active task, colored by state) over the icon.
- `NSDockTilePlugIn` (tile updates while termic is not running) is a separate,
  later question. It needs a loadable bundle inside the app and buys little
  when the interesting state only exists while termic runs.

### 2. Menu bar extra (build second)

Tauri ships tray support; the crate is currently built with
`tauri = { features = [] }`, so this is a feature flag plus an icon. Works on
every macOS version, needs no permission, and is the fallback for the large
share of users who auto-hide the Dock (where surface 3 has nowhere to live).

Scope: a compact title (for example `2 waiting`), and a menu listing the tasks
that need attention; selecting one activates termic and routes to that
(task, tab) through the same path as `onNotifyClick`.

### 3. Dock-flank strip (deferred, conditional)

The screenshot's look, minus the permission tax: a borderless, always-on-top,
corner-anchored strip inside the Dock band showing one pill per active task
(agent glyph, task name, state color, time in state).

Only worth building if 1 and 2 prove the demand, and only under constraints 1
and 2 above, which means native drawing rather than a webview. Mechanics
already researched, none of them blocking:

- **Level**: `always_on_top` maps to `NSFloatingWindowLevel` (3), below the
  Dock's level 20. Correct, since the strip sits beside the Dock, not over it.
- **Spaces**: `canJoinAllSpaces`. Fullscreen spaces have no Dock band, so hide.
- **Autohide / vertical Dock**: band thickness collapses; detect and hide, fall
  back to surface 2.
- **Focus**: clicking a pill should activate termic and jump to the task, so
  the non-activating `NSPanel` dance (runtime class swizzling via
  `tauri-nspanel`) is not needed.
- **Multi-display**: the Dock follows the active display; the strip must too.

Known cost: the strip lives outside the `make e2e` harness, which drives the
main window, so it ships with weaker regression cover than the rest of the app.

## What it shows

The data already exists; no new model is needed.

- Per tab: `unread.reason` (`bell | idle | exit | done | attention`),
  `needsAttention`, `liveTitle` (OSC 0/2), and the per-agent `signals`
  classification (precedence attention > busy > idle).
- Per task: script runs and git diff counts, if a pill has room.
- Exclusions mirror `useAttentionNotifier.ts`: run/setup tabs are managed dev
  surfaces, not agents, and anything inside the focused task stays quiet.

Summary line when there is more state than room: "3 running, 2 waiting".

## Wiring

Rust owns every surface. The webview pushes one compact status model over a
single debounced command whenever the relevant slice of the store changes; Rust
diffs it and touches the tile or the menu only when something actually changed.
Clicks travel the other way as an event carrying `{ taskId, tabId }`, reusing
the routing already written for notification clicks.

## What NOT to do

- Do not request Accessibility, for any part of this.
- Do not add a second webview window for a status surface.
- Do not poll from Rust. Updates are event-driven (see performance.md bear
  trap 8).
- Do not call `display()` on the Dock tile per state change without throttling;
  a busy agent flips state several times a second.
- Do not badge or ping for the task the user is already looking at.

## Open questions

- Prefs shape: one "ambient status" toggle, or per-surface toggles?
- Badge semantics: count of tabs needing attention, or of tasks?
- Does the tile `contentView` grid read at 48pt, or is the badge enough?
- Is `NSDockTilePlugIn` (state while termic is not running) worth a bundle?
