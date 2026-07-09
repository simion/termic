# Common gotchas

- **Window opens tiny.** `tauri-plugin-window-state` restores prior size before min-size kicks in. Reset: `rm "~/Library/Application Support/com.simion.termic/.window-state.json"`.
- **Window on wrong monitor.** `position_on_cursor_monitor()` in setup hook + `visible: false` + `show()` after positioning.
- **Terminal blank.** Wrong payload shape — see [ipc.md](ipc.md).
- **Terminal ribbons in TUIs.** `lineHeight` != 1.0 or WebglAddon not loaded.
- **WebGL crash (`_isDisposed`).** Dispose `webglAddon` BEFORE `term.dispose()`.
- **Theme picker flicker.** Radix DropdownMenu has cursor-transit gaps. Use HoverCard with `sideOffset=0`.
- **Toggle knob escapes track.** Hardcode geometry, don't lean on Tailwind transform classes.
- **Footer collapses, files overflow.** Grid needs `gridTemplateRows: "minmax(0, 1fr)"`.
- **`pty_spawn` "invalid length 0".** Payload wrap forgotten — wrap SpawnArgs in `{ args: ... }`.
- **Right-click contextmenu.** `window.addEventListener("contextmenu", e => e.preventDefault())` in `main.tsx`.
- **App icon missing in dev.** Dev runs raw binary, not `.app` bundle. Icon appears after `npm run tauri:build`.
- **Picked system font ignored, Nerd Font glyphs box out.** `system:<family>` font ids (from the Rust enumeration) must go through the prefix branch in `stackFor()` (prefs.ts) — they're not in `MONO_FONT_OPTIONS`, and falling back silently uses bundled JetBrains Mono (latin subset, zero PUA glyphs). Confusingly partial symptom: Powerline U+E0A0–E0BF still render because xterm's WebGL renderer custom-draws them without a font.
- **Font picker incomplete on first open.** The macOS native `<select>` popup snapshots its options when opened — options React adds mid-open don't appear, and a value with no matching option renders blank. Hence: warm `availableMonoFontsAsync()` at prefs module load, and seed selected `system:` ids into the picker's initial list (AppearanceSection).

## React/Zustand traps

- Don't return new objects/arrays from selectors without memo. Use frozen constants for defaults.
- Async setup in `useEffect` with cleanup — never in component bodies.
- Effect deps: stable IDs (`ws.id`, `tab.id`), never ws/tab objects (identity changes every patch).
- StrictMode is off. Audit before re-enabling.
