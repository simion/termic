// @vitest-environment happy-dom
// loadRemoteImages (issue #69) is computed from localStorage once at module
// load, so its default-value behavior can only be observed with a FRESH
// module instance per scenario — vi.resetModules() + a dynamic import.
//
// Two things need stubbing before that import can succeed at all, both
// pre-existing and unrelated to loadRemoteImages itself:
//  - localStorage: Node's own experimental global `localStorage` (present
//    without a DOM environment, and seemingly winning out over happy-dom's
//    in this vitest setup too) throws/warns without `--localstorage-file`,
//    so neither the plain "node" nor "happy-dom" environment gives a
//    working one here. A fake Map-backed one is stubbed directly instead.
//  - document.fonts: prefs.ts calls terminalFontsSettled() unconditionally
//    at module load (warms the terminal font faces at startup) which reads
//    document.fonts — the CSS Font Loading API, which happy-dom doesn't
//    implement. Stubbed as a no-op so the import doesn't throw.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const LS_KEY = "loadRemoteImages";

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

describe("prefs: loadRemoteImages", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    (document as any).fonts = { load: () => Promise.resolve(), ready: Promise.resolve() };
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to false with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().loadRemoteImages).toBe(false);
  });

  it("picks up a persisted true value as the initial state on load", async () => {
    localStorage.setItem(LS_KEY, "1");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().loadRemoteImages).toBe(true);
  });

  it("setLoadRemoteImages(true) updates state and persists it", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setLoadRemoteImages(true);
    expect(usePrefs.getState().loadRemoteImages).toBe(true);
    expect(localStorage.getItem(LS_KEY)).toBe("1");
  });

  it("setLoadRemoteImages(false) updates state and persists it", async () => {
    localStorage.setItem(LS_KEY, "1");
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setLoadRemoteImages(false);
    expect(usePrefs.getState().loadRemoteImages).toBe(false);
    expect(localStorage.getItem(LS_KEY)).toBe("0");
  });
});

// #83: light themes must raise the terminal's minimumContrastRatio so CLI
// truecolor fg (which bypasses the ANSI-16 remap) stays readable on a light
// bg; dark themes leave it at 1 (off) so their tuned palettes are untouched.
describe("prefs: currentMinimumContrastRatio", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    (document as any).fonts = { load: () => Promise.resolve(), ready: Promise.resolve() };
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns 4.5 (WCAG AA) for the light theme", async () => {
    const { usePrefs, currentMinimumContrastRatio } = await import("./prefs");
    usePrefs.getState().setThemeMode("light");
    expect(currentMinimumContrastRatio()).toBe(4.5);
  });

  it("returns 1 (off) for dark-family themes", async () => {
    const { usePrefs, currentMinimumContrastRatio } = await import("./prefs");
    for (const mode of ["dark", "claude", "solarized", "cobalt", "matrix", "rosepine"] as const) {
      usePrefs.getState().setThemeMode(mode);
      expect(currentMinimumContrastRatio()).toBe(1);
    }
  });

  it("follows a custom theme's colorScheme (light custom -> 4.5)", async () => {
    const { usePrefs, currentMinimumContrastRatio } = await import("./prefs");
    const custom = {
      id: "custom:paper" as const, name: "Paper", colorScheme: "light" as const,
      ui: {}, terminal: {},
    };
    usePrefs.setState({ customThemes: [custom as any] });
    usePrefs.getState().setThemeMode(custom.id);
    expect(currentMinimumContrastRatio()).toBe(4.5);
  });
});

// The font picker must only offer fonts that actually exist on the machine
// (plus the bundled JetBrains Mono, which the OS catalog can't see), sorted
// for display. mergeFontOptions is the pure core behind
// availableMonoFontsAsync — tested directly so no IPC mocking is needed.
describe("prefs: mergeFontOptions", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    (document as any).fonts = { load: () => Promise.resolve(), ready: Promise.resolve() };
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const CURATED = [
    { id: "jetbrains", label: "JetBrains Mono", stack: `"JetBrains Mono", monospace` },
    { id: "sfmono",    label: "SF Mono",        stack: `"SF Mono", ui-monospace, monospace` },
    { id: "menlo",     label: "Menlo",          stack: `Menlo, monospace` },
    { id: "hack",      label: "Hack",           stack: `Hack, monospace` },
    { id: "meslolgsnf",label: "MesloLGS NF",    stack: `"MesloLGS NF", "MesloLGS Nerd Font", monospace` },
  ];

  it("hides curated entries whose font isn't installed, case-insensitively", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["menlo"], []);
    const ids = out.map(o => o.id);
    expect(ids).toContain("menlo");
    expect(ids).not.toContain("hack");
  });

  it("always keeps the bundled JetBrains Mono even though the OS can't see it", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["Menlo"], []);
    expect(out.map(o => o.id)).toContain("jetbrains");
  });

  it("keeps ui-monospace stacks (SF Mono is a hidden dot-family on stock macOS)", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["Menlo"], []);
    expect(out.map(o => o.id)).toContain("sfmono");
  });

  it("keeps an entry matched via a fallback family name in its stack", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["MesloLGS Nerd Font"], []);
    expect(out.map(o => o.id)).toContain("meslolgsnf");
  });

  it("skips filtering entirely when the enumeration came back empty", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, [], []);
    expect(out).toHaveLength(CURATED.length);
  });

  it("adds uncovered monospace families as system: extras", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["Menlo", "MonaspiceNe Nerd Font Mono"], ["MonaspiceNe Nerd Font Mono"]);
    const extra = out.find(o => o.id === "system:MonaspiceNe Nerd Font Mono");
    expect(extra).toBeTruthy();
    expect(extra!.stack).toBe(`"MonaspiceNe Nerd Font Mono", monospace`);
  });

  it("does not duplicate a font already covered by a kept entry's fallback name", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["MesloLGS Nerd Font"], ["MesloLGS Nerd Font"]);
    expect(out.map(o => o.id)).not.toContain("system:MesloLGS Nerd Font");
  });

  it("sorts by label case-insensitively with the bundled default pinned first", async () => {
    const { mergeFontOptions } = await import("./prefs");
    const out = mergeFontOptions(CURATED, ["Menlo", "Hack", "aardvark mono"], ["aardvark mono"]);
    expect(out[0].id).toBe("jetbrains");
    const rest = out.slice(1).map(o => o.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    // the lowercase system extra sorts among, not after, the curated labels
    expect(rest[0]).toBe("aardvark mono");
  });
});
