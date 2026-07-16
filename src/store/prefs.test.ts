// @vitest-environment happy-dom
// loadRemoteImages (issue #69) is computed from localStorage once at module
// load, so its default-value behavior can only be observed with a FRESH
// module instance per scenario — vi.resetModules() + a dynamic import.
//
// One thing needs stubbing before that import can succeed at all,
// pre-existing and unrelated to loadRemoteImages itself:
//  - localStorage: Node's own experimental global `localStorage` (present
//    without a DOM environment, and seemingly winning out over happy-dom's
//    in this vitest setup too) throws/warns without `--localstorage-file`,
//    so neither the plain "node" nor "happy-dom" environment gives a
//    working one here. A fake Map-backed one is stubbed directly instead.
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
