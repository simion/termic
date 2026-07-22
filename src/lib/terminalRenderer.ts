// WebGL terminal renderer setup. Shared by TerminalPane + AuxTerminal.
//
// TEMP: also installs a diagnostic — `window.__termicDumpRenderer()`
// (call it from the Web Inspector console) dumps the WebGL renderer's
// full dimension state. Diffing that between the thin-launch state and
// the crisp after-monitor-move state pinpoints the exact wrong value.
// Remove once the retina-thinness bug is fixed.

import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { usePrefs } from "@/store/prefs";
import { terminalFontReady, isTerminalFontReady } from "@/lib/terminalFontReady";
import { keepAtlasCanvasConnected } from "@/lib/atlasCanvasGuard";
import * as ipc from "@/lib/ipc";

function dumpRenderer(addon: WebglAddon | null): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r: any = (addon as any)?._renderer;
  if (!r) { console.log("[termic renderer] no WebGL renderer"); return; }
  console.log("[termic renderer] " + JSON.stringify({
    windowDPR: window.devicePixelRatio,
    coreBrowserDPR: r._coreBrowserService?.dpr,
    rendererDPR: r._devicePixelRatio,
    charSize: { w: r._charSizeService?.width, h: r._charSizeService?.height },
    canvasBacking: { w: r._canvas?.width, h: r._canvas?.height },
    canvasCSS: { w: r._canvas?.style?.width, h: r._canvas?.style?.height },
    dimsDeviceChar: r.dimensions?.device?.char,
    dimsDeviceCell: r.dimensions?.device?.cell,
    dimsCSSCell: r.dimensions?.css?.cell,
  }, null, 2));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Load xterm's WebGL renderer onto `term`. Returns a disposable —
 *  call `dispose()` BEFORE `term.dispose()` so the render loop can't
 *  fire on a half-disposed terminal. If WebGL is unsupported (throw) OR the
 *  user disabled the GPU renderer (the `terminalGpuEnabled` pref — escape
 *  hatch for Linux/WebKitGTK boxes where WebGL runs on a software rasterizer
 *  and typing crawls), the load is skipped and xterm's built-in DOM renderer
 *  remains. Read once at mount; toggling the pref takes effect on the next
 *  terminal spawn (relaunch to switch every open terminal). */
/** GH #70: the bundled JetBrains Mono is a lazy @font-face; xterm's WebGL atlas
 *  keys glyphs per (char, fg, bg, ext) with no font in the key, so a glyph
 *  rasterized against the fallback stays wrong-height until the cell happens to
 *  re-rasterize (selection changes the bg, new key, correct glyph, which is why
 *  selecting text "fixed" it).
 *
 *  The previous gate polled `document.fonts` for the family, but check() and
 *  load() both report a family READY before it is registered in the FontFaceSet
 *  (check() returns true and load() resolves with zero faces for an unregistered
 *  family, reproduced on WKWebView). Since fontsource registers "JetBrains Mono"
 *  via async CSS @font-face, that vacuous window is the poison window on a cold
 *  spawn. So correctness now comes from loadTerminalRenderer holding the WebGL
 *  attach until `terminalFontReady` resolves: real FontFace handles we own and
 *  await (lib/terminalFontReady). The atlas is then built against the real face
 *  and never poisoned, so nothing is cleared under a live renderer (the
 *  disproven #70 path). This fn is the spawn-side gate: it waits the same
 *  promise, then RE-FITS so the PTY cols/rows match the real metrics.
 *
 *  Warm path (faces already loaded, the norm thanks to the boot warm-up in
 *  main.tsx): return immediately, zero cost. The re-fit is guarded against
 *  zero-geometry hosts (collapsed split, same reason the panes' ResizeObservers
 *  bail at 0x0) and the mid-spawn window where term.onResize isn't registered
 *  yet, which would silently desync PTY cols/rows (hence the ptyResize retry). */
export async function awaitTerminalFonts(
  term: Terminal,
  fit: { fit(): void },
  host: HTMLElement,
  isCancelled: () => boolean,
  ptyId: () => string | null,
): Promise<void> {
  if (isTerminalFontReady()) return;
  await terminalFontReady;
  if (isCancelled()) return;
  // Faces are genuinely loaded now, so cols/rows measured against the fallback
  // are stale: re-fit. No clearTextureAtlas (the WebGL renderer only attached
  // once the faces were loaded, so the atlas was never poisoned).
  if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
  try { fit.fit(); } catch {}
  let tries = 20;
  const push = () => {
    if (isCancelled() || tries-- <= 0) return;
    const pid = ptyId();
    if (pid) ipc.ptyResize(pid, term.rows, term.cols).catch(() => {});
    else window.setTimeout(push, 250);
  };
  push();
}

export function loadTerminalRenderer(term: Terminal): { dispose(): void } {
  let addon: WebglAddon | null = null;
  let disposed = false;

  const attach = () => {
    if (disposed || addon || !usePrefs.getState().terminalGpuEnabled) return;
    try {
      const a = new WebglAddon();
      a.onContextLoss(() => a.dispose());
      // Atlas swaps (font/theme/dpr). Microtask: the event fires before the
      // renderer stores the new atlas; its warm-up runs later, on idle.
      a.onChangeTextureAtlas(() => queueMicrotask(() => { if (!disposed) keepAtlasCanvasConnected(a); }));
      term.loadAddon(a);
      addon = a;
      // Initial atlas (born inside loadAddon; fires the event too early for
      // the addon to forward it). Park before the idle warm-up rasterizes.
      keepAtlasCanvasConnected(a);
    } catch {
      addon = null;  // WebGL unsupported → xterm's DOM renderer remains
    }
  };

  // GH #70: hold the FIRST attach until the owned faces are genuinely loaded
  // (terminalFontReady is real FontFace handles, not document.fonts.check(),
  // which is vacuously true before the family is registered). The addon then
  // builds its glyph atlas against the real face instead of caching
  // fallback-height glyphs that never correct, so nothing is ever cleared under
  // a live renderer. xterm's DOM renderer covers the gap. GPU-off and warm-face
  // attach right away; a face that never loads still resolves terminalFontReady
  // and gets GPU (consistent fallback, not the mixed-height "waves").
  if (isTerminalFontReady() || !usePrefs.getState().terminalGpuEnabled) {
    attach();
  } else {
    terminalFontReady.then(() => { if (!disposed && !addon) attach(); });
  }

  // TEMP diagnostic. Auto-dumps the launch state; the global lets the
  // user dump again after a monitor move (the crisp state) to diff.
  (window as unknown as { __termicDumpRenderer?: () => void }).__termicDumpRenderer =
    () => dumpRenderer(addon);
  const dumpTimers = [400, 1800].map(d => window.setTimeout(() => dumpRenderer(addon), d));

  return {
    dispose() {
      disposed = true;
      dumpTimers.forEach(t => window.clearTimeout(t));
      // Park the shared atlas canvas before this pane's DOM unmounts with it.
      keepAtlasCanvasConnected(addon, term.element);
      try { addon?.dispose(); } catch { /* already gone */ }
    },
  };
}
