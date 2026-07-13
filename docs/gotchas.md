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
- **Mixed letter heights in a terminal; selecting text "fixes" them (GH #70).** The bundled JetBrains Mono is a lazy `@font-face` — it only starts loading when text first uses the family. If the PTY's first output wins that race, xterm's WebGL atlas caches those glyphs drawn with the fallback `monospace`, keyed by (char, fg, bg, style) with the font only in the atlas config — so the same char keeps its wrong-font glyph indefinitely, while chars first seen after activation render correctly. Selection changes bg → new key → fresh (correct) glyph; changing the font away-and-back resets the atlas. Fix: prefs warms the load at module start, and both panes gate the first fit + PTY spawn on `awaitTerminalFonts()` (lib/terminalRenderer.ts) so metrics and glyphs come from the real font from the start — normally a microtask, capped at 800ms so a hung load can't stall spawns. Do NOT "fix" this with a naive post-hoc `clearTextureAtlas()+fit()` instead: an async fit can fire mid-spawn (before `term.onResize` is registered → PTY cols/rows silently desync) or against a 0x0 collapsed host (PTY shrinks to minimum dims) — the helper's late path guards both. Any future pane that rasterizes text with a bundled font must go through the same gate.
- **A DETACHED canvas can't resolve user-installed fonts.** In WKWebView, a `<canvas>` never added to the document silently falls back for families under `~/Library/Fonts`: `fillText` with `"MesloLGS NF"` renders pixel-identical to a nonexistent family, *including plain ASCII*. System fonts (`/System/Library/Fonts`, e.g. Menlo) resolve either way, so the bug hides. Doesn't affect xterm (its canvas is attached), but it silently invalidates any font-probe helper — attach the canvas before measuring. `document.fonts.check()` is no help either: WebKit returns `true` for every codepoint, even glyphs the font lacks. To test coverage, rasterize and compare pixels against a known-missing font: every missing glyph draws the *same* tofu box, so identical signatures mean absent.

## React/Zustand traps

- Don't return new objects/arrays from selectors without memo. Use frozen constants for defaults.
- Async setup in `useEffect` with cleanup — never in component bodies.
- Effect deps: stable IDs (`ws.id`, `tab.id`), never ws/tab objects (identity changes every patch).
- StrictMode is off. Audit before re-enabling.

## Custom agent work-done detection (#68)

An agent's working / done / needs-you state is classified from the fastest reliable signal available. For a CUSTOM CLI, use the highest tier it can emit:

- **Tier 1 - OSC signals (most reliable, zero config).** If the agent emits `OSC 9;4` (ConEmu progress), `OSC 133;D` (FinalTerm command-done), `OSC 9` / `OSC 777` (notifications), or `BEL` from an idle state, work-done detection already works with no setup. Prefer this if you control the agent.
- **Tier 2 - title regexes.** Settings, Agents, then the Done / Busy / Attention signal fields: one regex per line, matched against the agent's `OSC 0/2` title. When any list is set it drives classification (the built-in claude/codex heuristics are the fallback for empty). Precedence: **attention > busy > done**. Invalid patterns are flagged in the UI and ignored, never crash the terminal.
- **Tier 3 - output-line scan (opt-in).** The "Also scan output lines" toggle matches the same patterns against stdout LINES, for CLIs that print status but set no title. Higher cost on chatty agents; off by default, and read at spawn, so it needs a terminal restart to take effect. Lines break on CR *or* LF (a status line repainted with a bare `\r` never sends a newline), are ANSI-stripped, and are length-capped.

`work_done: false` still disables the whole machine (badge, bell, notification) for an agent. The classifier lives in `lib/agents.ts` (`classifyAgentTitle`, unit-tested); Tier 3 scanning is in `TerminalPane`'s data sink.

**Any tier that classifies a state must write `senderStateRef`.** The interval demoters (byte-quiet, settled-hash, scrollback) read it for two decisions: a `busy` value suppresses them entirely, and a `null` value means "this agent has never signalled anything", which downgrades their verdict from `done` to `attention`. A classifying path that skips the ref leaves a title-less agent looking mute, so byte-quiet fires at `QUIET_MS` (4s, under `SETTLE_MS`) through any silent think and rings the attention bell mid-turn, which is the bug #68 opened about.
