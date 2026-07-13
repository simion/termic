// WebGL terminal renderer setup. Shared by TerminalPane + AuxTerminal.
//
// TEMP: also installs a diagnostic — `window.__termicDumpRenderer()`
// (call it from the Web Inspector console) dumps the WebGL renderer's
// full dimension state. Diffing that between the thin-launch state and
// the crisp after-monitor-move state pinpoints the exact wrong value.
// Remove once the retina-thinness bug is fixed.

import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { usePrefs, terminalFontsSettled } from "@/store/prefs";
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
/** GH #70: hold the first fit + PTY spawn until the terminal font's faces
 *  are active. The bundled JetBrains Mono is a lazy @font-face; if output
 *  is rasterized before it activates, xterm's WebGL atlas caches those
 *  glyphs drawn with the fallback monospace — keyed per (char, fg, bg,
 *  style), with the font only in the atlas config — so the same char keeps
 *  its wrong-height glyph until the cell happens to re-rasterize (selection
 *  changes the bg → new key → correct glyph, which is why selecting text
 *  "fixed" it). Gating the spawn means metrics AND glyphs come from the
 *  real font from the start: no post-hoc refit, no atlas churn.
 *
 *  prefs warms the load at module start, so this normally resolves in a
 *  microtask and adds zero spawn latency. The wait is capped so a hung
 *  load can never stall a spawn; on that (practically unreachable) path a
 *  one-shot repair runs when the face finally lands, guarded against the
 *  two hazards a late fit() has: zero-geometry hosts (collapsed split —
 *  same reason the panes' ResizeObservers bail at 0x0) and the mid-spawn
 *  window where term.onResize isn't registered yet, which would silently
 *  desync PTY cols/rows (hence the explicit ptyResize with retry). */
export async function awaitTerminalFonts(
  term: Terminal,
  fit: { fit(): void },
  host: HTMLElement,
  isCancelled: () => boolean,
  ptyId: () => string | null,
): Promise<void> {
  let ready = false;
  await Promise.race([
    terminalFontsSettled().then(() => { ready = true; }),
    new Promise<void>(r => window.setTimeout(r, 800)),
  ]);
  if (ready || isCancelled()) return;
  terminalFontsSettled().then(() => {
    if (isCancelled()) return;
    try { term.clearTextureAtlas(); } catch {}
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
  });
}

export function loadTerminalRenderer(term: Terminal): { dispose(): void } {
  let addon: WebglAddon | null = null;
  if (usePrefs.getState().terminalGpuEnabled) {
    try {
      const a = new WebglAddon();
      a.onContextLoss(() => a.dispose());
      term.loadAddon(a);
      addon = a;
    } catch {
      addon = null;  // WebGL unsupported → xterm's DOM renderer remains
    }
  }

  // TEMP diagnostic. Auto-dumps the launch state; the global lets the
  // user dump again after a monitor move (the crisp state) to diff.
  (window as unknown as { __termicDumpRenderer?: () => void }).__termicDumpRenderer =
    () => dumpRenderer(addon);
  const dumpTimers = [400, 1800].map(d => window.setTimeout(() => dumpRenderer(addon), d));

  return {
    dispose() {
      dumpTimers.forEach(t => window.clearTimeout(t));
      try { addon?.dispose(); } catch { /* already gone */ }
    },
  };
}
