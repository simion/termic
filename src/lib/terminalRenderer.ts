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
/** True once the bundled JetBrains Mono face — the lazy @font-face behind
 *  GH #70 — is genuinely active for both weights xterm rasterizes (400 +
 *  700). `document.fonts.check` on the concrete family is stricter than
 *  terminalFontsSettled(): the latter uses `document.fonts.load`, which on
 *  WebKit can reject and fall back to `document.fonts.ready`, resolving
 *  before the face is actually usable. This is the source of truth.
 *
 *  Checking JetBrains Mono alone covers every terminal font: it is the only
 *  lazy @font-face in the app, currentTerminalStack() always appends it as
 *  the fallback, and installed system fonts never participate in FontFaceSet
 *  loading (check() is true for them from the start). If a second webfont
 *  ever ships, this must widen to the selected family too. */
const bundledFontActive = (): boolean =>
  document.fonts.check('400 1em "JetBrains Mono"') &&
  document.fonts.check('700 1em "JetBrains Mono"');

/** GH #70: the bundled JetBrains Mono is a lazy @font-face; if terminal
 *  output rasterizes before it activates, xterm's WebGL atlas caches those
 *  glyphs drawn with the fallback monospace — keyed per (char, fg, bg,
 *  style), with the font only in the atlas config — so the same char keeps
 *  its wrong-height glyph until the cell happens to re-rasterize (selection
 *  changes the bg → new key → correct glyph, which is why selecting text
 *  "fixed" it).
 *
 *  The earlier gate (c677201) held the spawn until terminalFontsSettled()
 *  resolved, but its fast path returned with no safety net — so a
 *  false-positive settle (the WebKit fonts.ready fallback above; also the
 *  duplicate/late-loading 700 face) still poisoned the atlas permanently.
 *  This version makes correctness self-healing instead of race-dependent:
 *   1. If the face is already active, nothing could have rasterized against
 *      the fallback — return immediately, zero cost (the warm path, which
 *      the prefs startup warm-up makes the norm).
 *   2. Otherwise gate the spawn on the settle (capped at 800ms so a hung
 *      load never stalls a spawn) ONLY to avoid a visible reflow, then
 *      unconditionally rebuild the atlas the moment the face is *genuinely*
 *      active (polling check(), not trusting the settle) so any glyph that
 *      cached against the fallback during the race is evicted. The poll is
 *      capped so a face that never loads can't spin.
 *
 *  The rebuild's fit() is guarded against the two hazards a late fit() has:
 *  zero-geometry hosts (collapsed split — same reason the panes'
 *  ResizeObservers bail at 0x0) and the mid-spawn window where term.onResize
 *  isn't registered yet, which would silently desync PTY cols/rows (hence
 *  the explicit ptyResize with retry). */
export async function awaitTerminalFonts(
  term: Terminal,
  fit: { fit(): void },
  host: HTMLElement,
  isCancelled: () => boolean,
  ptyId: () => string | null,
): Promise<void> {
  if (bundledFontActive()) return;

  await Promise.race([
    terminalFontsSettled(),
    new Promise<void>(r => window.setTimeout(r, 800)),
  ]);

  let tries = 50;   // ~5s at 100ms; a face this slow is effectively hung
  // `preSpawn` is true only for the synchronous first attempt, which the
  // caller awaits — so no PTY exists or can be in flight yet, and the fit()
  // below simply feeds the caller's own spawn. Pushing a resize there would
  // poll for a pid just to restate the dims the spawn already used. Every
  // later attempt runs off the poll, i.e. after we returned and the caller
  // may have spawned (or be mid-spawn, before term.onResize is wired), so it
  // must push the resize explicitly or the PTY silently desyncs.
  const heal = (preSpawn: boolean) => {
    if (isCancelled()) return;
    if (!bundledFontActive()) {
      if (tries-- > 0) window.setTimeout(() => heal(false), 100);
      return;
    }
    try { term.clearTextureAtlas(); } catch {}
    if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
    try { fit.fit(); } catch {}
    if (preSpawn) return;
    let rtries = 20;
    const push = () => {
      if (isCancelled() || rtries-- <= 0) return;
      const pid = ptyId();
      if (pid) ipc.ptyResize(pid, term.rows, term.cols).catch(() => {});
      else window.setTimeout(push, 250);
    };
    push();
  };
  heal(true);
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
