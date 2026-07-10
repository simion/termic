# Keyboard shortcuts

## Architecture

`src/lib/shortcuts.ts` is the single source of truth: `ShortcutId` union + `SHORTCUT_DEFS` (each: `id`, `label`, `group`, optional `hint`, `defaultBinding`). A `Binding` is `{ cmd, shift, alt, key }` where `cmd` folds Cmd=Ctrl, `key` is a normalized token or `"1-9"` sentinel.

**Adding a shortcut** = new `ShortcutId` + `SHORTCUT_DEFS` entry + `case` in `useShortcuts` (for global ones). Help modal and settings editor are data-driven from `SHORTCUT_DEFS`.

## Runtime

- **Resolved bindings** in prefs store (`usePrefs(s => s.shortcuts)`): `DEFAULT_BINDINGS` merged with localStorage overrides. Mutate via `setShortcut`/`resetShortcut`/`resetAllShortcuts`.
- **Global handler** (`src/hooks/useShortcuts.ts`): one `keydown` listener, matches via `bindingMatches(e, binding)`.
- **Contextual shortcuts** (need component state) handled inside the component with a capture-phase listener that `stopPropagation`s only when it claims the key. Shared chord meaning different things by context is expected, not a bug.
- **Help modal** (`ShortcutsHelpDialog`, triggered by `open-shortcuts`): read-only, grouped by `GROUP_ORDER`. Edit button jumps to Settings → Shortcuts.

## Glyphs

`bindingGlyphs(b)` returns `["⌥","⇧","⌘", key]`. Help modal uses raw glyphs (⌘ ⌥ ⇧); settings editor uses `glyphLabel` (Cmd/Ctrl, Option/Alt). `isValidBinding` requires Cmd/Ctrl or Option to prevent swallowing normal typing.

## Leader-key shortcuts (⌘R prompt quick-fire)

`prompt-quick-fire` (default ⌘R) is the first shortcut that doesn't fit the plain `SHORTCUT_DEFS` + `case` recipe above: it's a two-key LEADER sequence, not a single simultaneous chord. Pressing it doesn't fire anything by itself — it arms a transient "press a key" mode (`useUI().promptLeaderActive`, shown as a hint pill mounted in `Dialogs.tsx`) and installs a one-shot, capture-phase `keydown` listener (`armPromptLeader` in `src/hooks/useShortcuts.ts`) that:

- matches the next keystroke against each enabled prompt's EFFECTIVE trigger key (`effectiveTriggerKeys` in `src/store/prompts.ts` — a manual per-prompt override, else the next free slot in the default `1-9, a-z` sequence) and fires it at the focused agent tab (`fireOrPickDestination` in `src/lib/promptFire.ts`, falling back to the shared destination-picker dialog when there's no focused live agent)
- cancels on `Escape`, an unmapped key, or a ~2s idle timeout

The follow-up key MUST be captured before a focused terminal/xterm or editor/CodeMirror sees it, hence capture-phase + `stopImmediatePropagation` — same technique the Settings → Shortcuts key recorder uses, just re-armed after the leader key instead of after a click.

`prompt-palette` (default ⇧⌘R) is a plain single-chord shortcut (fits the normal recipe) that opens `PromptPalette.tsx`: a searchable list of prompts (fuzzy-filtered by title only), Enter runs the highlighted one via the same `fireOrPickDestination` path.

Per-prompt trigger keys are configurable in Settings → Prompts (`PromptLibrarySection.tsx`) and shown as badges in the Prompts dropdown (`UnifiedBar.tsx`) and the palette — NOT in `SHORTCUT_DEFS` (they're prompt data, not app shortcuts), so they don't show up in the Shortcuts help modal or settings editor.
