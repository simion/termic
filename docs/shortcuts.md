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

## Prompt palette (⌥⌘P)

`prompt-palette` (default ⌥⌘P) is a plain single-chord shortcut that opens `PromptPalette.tsx`: a searchable list of enabled prompts (fuzzy-filtered by title only). Enter runs the highlighted one; while the query is empty, digits `1-9` fire the top rows directly (a positional accelerator, Raycast-style, not a persisted per-prompt key). Firing goes through `fireOrPickDestination` in `src/lib/promptFire.ts`, which sends straight to the focused agent tab or falls back to the shared destination-picker dialog (`PromptDestinationDialog.tsx`) when there's no focused live agent. The Prompts dropdown in `UnifiedBar.tsx` always opens the picker so you can tweak the body and choose a target.
