// Thin abstraction over the two terminal emulator libraries Termic can
// run. The choice is a user pref (Settings -> General -> Terminal engine);
// TerminalPane + AuxTerminal call `loadTerminalEngine(name)` to get back
// constructors they then use as if it were xterm.js.
//
// Why an abstraction:
//   - ghostty-web's `Terminal` is xterm.js-API-compatible but the package
//     requires an async one-time `init()` to load its WASM blob.
//   - ghostty-web ships its own canvas renderer and has no WebGL addon, so
//     the WebGL plumbing must be conditional.
//   - Both libraries are wholly client-side; we lazy-load them via dynamic
//     import so opting into ghostty doesn't bloat the xterm path's bundle.
//
// Both engines expose enough overlapping surface that the rest of the
// terminal panes don't branch internally - they just take whatever
// constructors `EngineModule` hands them and use the common subset:
// constructor(options) / open(host) / write(data) / onData(cb) / onResize /
// dispose / options.{fontFamily,fontSize,fontWeight} / buffer.active.

import type { TerminalEngine } from "@/store/prefs";

/** Surface of the two libraries we care about. Typed as `any` because the
 *  exact xterm vs ghostty class identities aren't compatible at the type
 *  level (different `.d.ts`) but they ARE compatible at the value level
 *  for the methods we call. Treat this like a duck-typed plugin. */
export interface EngineModule {
  Terminal: any;
  FitAddon: any;
  WebLinksAddon: any;
  /** xterm.js has @xterm/addon-webgl; ghostty-web does not. Callers branch
   *  on this being null to skip the WebGL setup + the careful disposal
   *  ordering that the WebGL renderer requires. */
  WebglAddon: any | null;
  /** Engine identity passed through so call sites can apply
   *  engine-specific quirks (e.g. xterm needs `lineHeight: 1.0` to
   *  avoid the TUI "ribbon" artifact; ghostty has no such option). */
  name: TerminalEngine;
}

// Cache the ghostty WASM init promise so multiple terminals on the same
// page share one load. xterm has no analogous init, so the resolver just
// returns synchronously.
let ghosttyInitPromise: Promise<void> | null = null;

export async function loadTerminalEngine(name: TerminalEngine): Promise<EngineModule> {
  if (name === "ghostty") {
    // Parallel dynamic imports for the core lib (which exports both the
    // Terminal class and the FitAddon) and xterm's WebLinks addon (which
    // ghostty-web doesn't ship - we reuse xterm's since it's purely a
    // DOM overlay on top of the terminal's element).
    const [g, weblinks] = await Promise.all([
      import("ghostty-web"),
      import("@xterm/addon-web-links"),
    ]);
    if (!ghosttyInitPromise) ghosttyInitPromise = g.init();
    await ghosttyInitPromise;
    return {
      Terminal: g.Terminal,
      FitAddon: g.FitAddon,
      WebLinksAddon: weblinks.WebLinksAddon,
      WebglAddon: null,
      name: "ghostty",
    };
  }
  // xterm path - default. Three small packages, all already in deps.
  const [xt, fit, weblinks, webgl] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/addon-webgl"),
  ]);
  return {
    Terminal: xt.Terminal,
    FitAddon: fit.FitAddon,
    WebLinksAddon: weblinks.WebLinksAddon,
    WebglAddon: webgl.WebglAddon,
    name: "xterm",
  };
}
