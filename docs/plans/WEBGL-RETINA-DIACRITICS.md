# WebGL terminal — thin diacritics on retina (WKWebView compositing bug)

**Status:** open — root cause located & proven, native fix not yet implemented.
**Last updated:** 2026-05-21

## Summary

On a retina display, terminal text rendered by xterm.js's **WebGL renderer**
comes up with **thin / under-weight diacritic glyphs** — Romanian `ă â î ș ț`
(letters carrying a mark) render visibly thinner than the surrounding base
ASCII letters, same line, same font. Intermittent at launch; **deterministic
per new terminal tab** (every new tab is thin). Dragging the window between
monitors (a real screen change) fixes every currently-open terminal at once;
terminals opened afterward are thin again until the next move.

## Environment

- termic = Tauri 2 → **WKWebView** on macOS. (Not Electron/Chromium.)
- xterm.js `@xterm/xterm@5.5.0` + `@xterm/addon-webgl@0.19.0`.
- Retina display, `devicePixelRatio` = 2.
- Reproduced by the project owner **and** a colleague. The colleague was on the
  default bundled font — rules out any font customization as a factor.

## Root cause — CONCLUDED, backed by data

It is a **WKWebView compositing bug**. Not xterm, not the font, not any
JavaScript we can write.

`window.__termicDumpRenderer()` (diagnostic in `src/lib/terminalRenderer.ts`)
dumps the WebGL renderer's internal state. In the **thin** state:

```
rendererDPR: 2          canvasBacking.w: 2112   (= 1056 CSS × 2)   ✓
charSize.w: 7.8         dimsDeviceChar.w: 15    (= 7.8 × 2 → 15)   ✓
dimsCSSCell.w: 8        dimsDeviceCell.w: 16    (= 8 × 2)          ✓
```

**Every value is correct and correctly scaled for 2× retina.** xterm's WebGL
renderer is flawlessly configured — atlas cells at 2× device resolution, canvas
backing buffer double the CSS size. It renders thin *anyway*. Therefore the
fault is WKWebView mis-compositing the (correctly-rendered) WebGL canvas layer
onto the screen. A native `NSWindowDidChangeScreen` / backing-properties event
makes WKWebView re-composite correctly — which is exactly why a monitor move
fixes it.

Why VS Code's xterm+WebGL renders fine: VS Code is Electron → **Chromium**;
Chromium's WebGL compositing doesn't have this bug. Tauri uses the OS webview
(WKWebView on macOS) by design — it can't switch to Chromium.

## Ruled out — do NOT re-investigate these

- **Font** — colleague reproduced on the default bundled JetBrains Mono (which
  has every glyph); the DOM renderer renders the same glyphs perfectly.
- **`devicePixelRatio` value** — constant `2`, measured in both thin and fixed
  states.
- **xterm renderer configuration** — the dump proves it is correct (full 2×) in
  the thin state.
- **A full JS reload (⌘R)** — does not fix it (rebuilds xterm + WebGL + glyph
  atlas from scratch; still thin).
- Window resize, minimize/restore, `clearTextureAtlas()`, disposing +
  recreating the `WebglAddon`, calling `RenderService.handleDevicePixelRatioChange()` —
  none fix it.
- **Only a real monitor / screen change fixes it.**

## Hypotheses tried and disproven (chronological — so they aren't repeated)

1. `latin-ext` webfont subset not loaded → fallback font → wrong (default font
   has the glyphs).
2. WebGL atlas baked before the font loaded; `clearTextureAtlas()` after
   `document.fonts.ready` → no fix.
3. Stale atlas after a DPR change → wrong; it's wrong at *launch*, no monitor
   switch is involved to go stale from.
4. Auto dispose + recreate the `WebglAddon` ~600 ms post-launch → no fix.
5. Call `RenderService.handleDevicePixelRatioChange()` (the method a monitor
   move triggers via `onDprChange`) on a timer → no fix.
6. Canvas renderer (`@xterm/addon-canvas`) → fixed `ș/ț` but mangled `ă` (a
   *separate* canvas-renderer glyph bug). Not a viable path.
7. DOM renderer → renders everything correctly, but rejected: WebGL is required
   for performance (DOM is too slow under the agent-output firehose).

## Proposed fix — next step

Native. From Rust (objc2), post `NSWindowDidChangeBackingPropertiesNotification`
for the app's `NSWindow` — programmatically, after each terminal mounts — to
force WKWebView to re-composite its layers, replicating what a monitor move
does. Likely shape: a Tauri command the frontend calls on terminal mount.

- Risk: native objc; if it doesn't work it's a genuine WKWebView/Tauri bug to
  file upstream.
- Matters beyond multi-monitor users: someone on a **single retina screen**
  cannot do the monitor-move workaround at all — for them it is permanently
  broken.

## xterm source reference (context — all verified *correct* in the thin state)

- `WebglRenderer._updateDimensions()` scales the glyph atlas by
  `_devicePixelRatio` (cached at construction); guarded by
  `_charSizeService.width && .height`.
- `WebglRenderer.handleDevicePixelRatioChange()` re-syncs `_devicePixelRatio` +
  `handleResize`; runs only on `onDprChange`.
- core `RenderService.handleDevicePixelRatioChange()` re-measures char size and
  cascades to the renderer; wired to `coreBrowserService.onDprChange`.
- `CoreBrowserService.dpr` is a live getter — `return window.devicePixelRatio`.

These were the basis of fixes #2–#5; the dump shows they're all already correct,
so the next investigation should NOT re-walk them.

## Reproduce

1. Fresh-launch termic on a retina display.
2. Type Romanian diacritics: `ă â î ș ț` next to base letters `a s t`.
3. The diacritic letters render thinner. Open a new terminal tab → reproduces.
4. Drag the window to another monitor and back → fixed (until the next new tab).

## Diagnostic tooling currently in the tree

`src/lib/terminalRenderer.ts` installs a **temporary** diagnostic:
`window.__termicDumpRenderer()` (run it in the Web Inspector console) dumps the
WebGL renderer's dimension state; it also auto-dumps at ~400 ms and ~1.8 s after
a terminal mounts. **Remove this diagnostic once the bug is fixed.**

## Current code state (uncommitted)

- `src/lib/terminalRenderer.ts` — `loadTerminalRenderer()` loads the WebGL addon
  + installs the temporary diagnostic above. The earlier renderer toggle
  (`localStorage.termicRenderer`, canvas/dom options) and the failed
  font-load/atlas-rebuild attempts have been removed.
- `src/components/workspace/TerminalPane.tsx` / `AuxTerminal.tsx` — call
  `loadTerminalRenderer(term)`.
- `@xterm/addon-canvas` — uninstalled (canvas A/B scaffolding removed).
- Already shipped (v0.4.4, committed): `currentTerminalStack()` appends
  `"JetBrains Mono Variable"` as a fallback before `monospace`. Benign and
  unrelated to this bug — keep it.
