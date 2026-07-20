import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Canary for every xterm private-internal reach-in in this codebase. The
// reach-ins are all optional-chained, so an xterm upgrade that renames one
// degrades to a silent no-op in the field — the bug it worked around
// quietly returns with no signal. Pinning the names against the installed
// bundle turns that into a CI failure at upgrade time instead.
//
// A hit only proves the name still exists somewhere in the bundle, not
// that it still means the same thing — but a rename/removal (the realistic
// failure mode) is caught, which is the point.
const bundle = readFileSync(require.resolve("@xterm/xterm"), "utf8");

// name → the module that reaches for it.
const REACH_INS: Record<string, string> = {
  // Public Terminal wrapper's handle to the internal core (all reach-ins).
  _core: "termLinkOpener, terminalRenderer, xtermViewportSync",
  // lib/xtermViewportSync.ts — display:none reveal repair.
  viewport: "xtermViewportSync",
  syncScrollArea: "xtermViewportSync",
  _lastRecordedViewportHeight: "xtermViewportSync",
  _ignoreNextScrollEvent: "xtermViewportSync",
  // lib/termLinkOpener.ts — OSC 8 link data lookup.
  _oscLinkService: "termLinkOpener",
  getLinkData: "termLinkOpener",
  // lib/terminalRenderer.ts — renderer debug snapshot.
  _coreBrowserService: "terminalRenderer",
};

describe("xterm bundle still exposes our private reach-ins", () => {
  for (const [name, usedBy] of Object.entries(REACH_INS)) {
    it(`${name} (used by ${usedBy})`, () => {
      expect(bundle.includes(name), `"${name}" is gone from the installed @xterm/xterm bundle; the reach-in in ${usedBy} is now a silent no-op — re-derive it against the new internals`).toBe(true);
    });
  }
});
