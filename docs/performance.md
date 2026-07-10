# Performance

## Bear traps

1. **Lazy editor.** `EditorPane`/`DiffPane` via `React.lazy` in `TaskView`. Don't break.
2. **Keep terminals mounted.** `TaskView`/`MainArea` toggle `visibility:hidden` instead of unmounting. `mountedTasks: Set<string>` in app store keeps every visited task rendered.
3. **WebGL non-negotiable.** Load AFTER `term.open(host)`. Dispose `webglAddon` BEFORE `term.dispose()` — render loop fires on half-disposed terminal otherwise (`_isDisposed` crash). Same fix in TerminalPane AND AuxTerminal.
4. **`lineHeight: 1.0` in xterm.** Anything else inflates cells; TUIs show ribbons between rows.
5. **Tight Zustand selectors.** Never destructure the whole store. Use frozen empty constants (`EMPTY_TABS`) for referential stability — React 19 warns "getSnapshot should be cached".
6. **`Math.round` every dimension.** Sub-pixel widths blur glyphs in WKWebView. All sidebar/right-panel/footer/split setters round on write AND on `localStorage` read.
7. **Disable transitions during drag.** `App.tsx` grid uses `transition: var(--cols-transition, …)` and `ResizeHandle` sets `--cols-transition: none` on `<html>` while dragging.
8. **PTY firehose** (known, not fixed). Every chunk: Rust → event → JS → xterm. Coalescing in Rust (~4ms window) would cut event count 10-50x.

## Sub-pixel / rendering hardening

- Force grayscale font smoothing on `html` (`-webkit-font-smoothing: antialiased`) — subpixel AA produces colored fringing on dark backgrounds.
- Dialogs use flexbox centering on a full-viewport wrapper, no transforms on `Dialog.Content` — `-translate-x-1/2 -translate-y-1/2` hits sub-pixel offsets on odd viewport widths.
- Streaming output / `pre` boxes inside dialogs need `min-w-0` on grid items (default `min-width: auto` overflows).
- `ResizeHandle` is 1px wide (`-ml-px`/`-mt-px`) with 4px invisible hit area each side.
- Terminal text lighter than native: WebGL atlas rasterizes via Canvas 2D. Mitigation: `terminalFontWeight` pref, Medium (500) closes most of the gap.
- `document.fonts.check()` lies in WKWebView — use canvas measurement against two baselines (monospace + serif) instead.
