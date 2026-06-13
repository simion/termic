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
