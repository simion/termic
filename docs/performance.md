# Performance

## Bear traps

1. **Lazy editor.** `EditorPane`/`DiffPane` via `React.lazy` in `TaskView`. Don't break.
2. **Keep terminals mounted, hide with `display:none`.** `TaskView`/`MainArea` toggle `display:none` instead of unmounting. `mountedTasks: Set<string>` in app store keeps every visited task rendered. NEVER switch back to `visibility:hidden`: xterm's renderer pauses only on zero geometry (IntersectionObserver), so visibility-hidden terminals kept running WebGL draws for every background TUI repaint — GPU ~90% busy and ~0.5 core of WebContent CPU with the app nominally idle. `display:none` also blurs the hidden pane, pausing its cursor-blink loop. KNOWN COST: WKWebView zeroes scroll offsets inside a `display:none` subtree. xterm does NOT self-heal — its buffer position (ydisp) survives, but the DOM `.xterm-viewport` scroller stays zeroed and nothing re-syncs it when the on-reveal `fit()` lands on unchanged dims; scrolling reads as locked (wheel-up dead, or the bottom unreachable) until new output scrolls the buffer. Both terminal panes repair it on the ResizeObserver zero → non-zero edge via `resyncViewportAfterReveal` (`src/lib/xtermViewportSync.ts`). CodeMirror and plain overflow divs treat the DOM as the source of truth — any scrollable that must survive hiding needs `attachHiddenScrollRestore` (`src/lib/hiddenScrollRestore.ts`), as EditorPane/DiffPane do.
3. **WebGL non-negotiable.** Load AFTER `term.open(host)`. Dispose `webglAddon` BEFORE `term.dispose()` — render loop fires on half-disposed terminal otherwise (`_isDisposed` crash). Same fix in TerminalPane AND AuxTerminal.
4. **`lineHeight: 1.0` in xterm.** Anything else inflates cells; TUIs show ribbons between rows.
5. **Tight Zustand selectors.** Never destructure the whole store. Use frozen empty constants (`EMPTY_TABS`) for referential stability — React 19 warns "getSnapshot should be cached".
6. **`Math.round` every dimension.** Sub-pixel widths blur glyphs in WKWebView. All sidebar/right-panel/footer/split setters round on write AND on `localStorage` read.
7. **Disable transitions during drag.** `App.tsx` grid uses `transition: var(--cols-transition, …)` and `ResizeHandle` sets `--cols-transition: none` on `<html>` while dragging.
8. **PTY firehose.** Coalesced in Rust: the flusher batches reader output into ≤1 event per 8ms. The flusher and exit-waiter BLOCK on a condvar the reader signals — no sleep-loop polling. A quiet PTY must cost zero timer wakeups; the old `loop { sleep(8ms) }` flusher burned 125 wakeups/s per PTY forever, and the old `sleep(1ms)` exit-drain spun at ~1000/s (forever, if an orphan held the PTY slave open). On the JS side, the per-chunk `lastOutputAt` store patch is coalesced to one per 500ms so streaming doesn't re-render tabs/sidebar at chunk rate.

## Sub-pixel / rendering hardening

- Force grayscale font smoothing on `html` (`-webkit-font-smoothing: antialiased`) — subpixel AA produces colored fringing on dark backgrounds.
- Dialogs use flexbox centering on a full-viewport wrapper, no transforms on `Dialog.Content` — `-translate-x-1/2 -translate-y-1/2` hits sub-pixel offsets on odd viewport widths.
- Streaming output / `pre` boxes inside dialogs need `min-w-0` on grid items (default `min-width: auto` overflows).
- `ResizeHandle` is 1px wide (`-ml-px`/`-mt-px`) with 4px invisible hit area each side.
- Terminal text lighter than native: WebGL atlas rasterizes via Canvas 2D. Mitigation: `terminalFontWeight` pref, Medium (500) closes most of the gap.
- `document.fonts.check()` lies in WKWebView — use canvas measurement against two baselines (monospace + serif) instead.
