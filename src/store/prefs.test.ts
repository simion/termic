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
