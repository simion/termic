// WKWebView can't resolve user-installed font families on a DISCONNECTED
// canvas (docs/gotchas.md): the family silently fails and the stack falls
// through to a webfont or to generic `monospace` (Courier, a slab serif). The
// bad resolution also STICKS: WebKit skips re-parsing `ctx.font = <identical
// string>`, so only a DIFFERENT font string heals it.
//
// xterm's WebGL TextureAtlas rasterizes every glyph on one long-lived hidden
// canvas shared by same-config terminals. Real draws attach it to the drawing
// terminal first, but the ASCII warm-up draws container-less and a pane
// unmount orphans it — so glyphs can rasterize detached. They cache per
// (char, fg, bg, ext) with no font in the key, so default-colored text keeps
// the wrong family while selection (new bg = new key = fresh connected draw)
// shows the right one: the font swaps under the highlight. Same atlas
// mechanics as GH #70; reproduced with a standalone WKWebView probe.
//
// Guard: park the canvas under document.body wherever it might be orphaned,
// and poison the cached font string so the next draw re-resolves while
// connected. The poke is unconditional (self-heals unforeseen windows) and
// safe mid-render: every atlas draw assigns ctx.font before painting.
// Reach-ins are optional-chained; xtermInternals.test.ts pins the names.

interface AtlasInternals {
  _tmpCanvas?: HTMLCanvasElement;
  _tmpCtx?: { font: string };
}

/** Park `addon`'s atlas scratch canvas under document.body if orphaned (or
 *  inside `dyingHost`, a subtree about to unmount) and force the next draw to
 *  re-resolve the font stack. */
export function keepAtlasCanvasConnected(addon: unknown, dyingHost?: HTMLElement | null): void {
  const atlas = (addon as { _renderer?: { _charAtlas?: AtlasInternals } } | null | undefined)
    ?._renderer?._charAtlas;
  const canvas = atlas?._tmpCanvas;
  if (!canvas) return;
  if (!canvas.isConnected || (dyingHost?.contains(canvas) ?? false)) {
    canvas.style.display = "none";
    document.body.append(canvas);
  }
  const ctx = atlas?._tmpCtx;
  // Never equals a real atlas font string, so the next draw re-parses.
  if (ctx) ctx.font = "1px serif";
}
