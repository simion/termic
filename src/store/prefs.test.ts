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

// A default that is NOT the falsy one, which the other prefs here do not
// cover: an absent key has to mean the gesture ships on (left Shift), and only
// a stored mode changes it. Getting that backwards would silently disable
// double-Shift for everybody on upgrade.
describe("prefs: doubleShiftMode", () => {
  const KEY = "doubleShiftMode";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to left-Shift-only with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().doubleShiftMode).toBe("left");
  });

  it("reads back each stored mode", async () => {
    for (const mode of ["off", "any", "outside-terminal", "left"] as const) {
      vi.stubGlobal("localStorage", fakeLocalStorage());
      vi.resetModules();
      localStorage.setItem(KEY, mode);
      const { usePrefs } = await import("./prefs");
      expect(usePrefs.getState().doubleShiftMode).toBe(mode);
    }
  });

  it("falls back to the default for a value it does not recognise", async () => {
    // A hand-edited profile, or a mode from a later build.
    localStorage.setItem(KEY, "sometimes");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().doubleShiftMode).toBe("left");
  });

  it("persists what it is set to", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setDoubleShiftMode("off");
    expect(usePrefs.getState().doubleShiftMode).toBe("off");
    expect(localStorage.getItem(KEY)).toBe("off");
    usePrefs.getState().setDoubleShiftMode("outside-terminal");
    expect(localStorage.getItem(KEY)).toBe("outside-terminal");
  });
});

// The recently-used-tabs gesture. Absent has to mean ⌃⇥, which is what every
// profile from before it was recordable has, so no migration exists to get
// wrong. A Cmd gesture is not usable off macOS and this test environment is
// not a Mac, so a Ctrl gesture on a key other than Tab is the one stored.
describe("prefs: recentTabsGesture", () => {
  const KEY = "recentTabsGesture";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to Ctrl+Tab with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Tab" });
  });

  it("reads back a stored gesture", async () => {
    localStorage.setItem(KEY, JSON.stringify({ hold: "ctrl", code: "Semicolon" }));
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Semicolon" });
  });

  it("reads garbage as the default, and leaves the stored value alone", async () => {
    localStorage.setItem(KEY, "{nope");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Tab" });
    expect(localStorage.getItem(KEY)).toBe("{nope");
  });

  it("persists what it is set to, as JSON", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Semicolon" });
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Semicolon" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hold: "ctrl", code: "Semicolon" });
  });

  it("keeps the recorded key's character, and a gesture stored without one still loads", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Semicolon", key: "ö" });
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Semicolon", key: "ö" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hold: "ctrl", code: "Semicolon", key: "ö" });
    // Re-recorded on another layout: same key, new character, so it is written.
    usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Semicolon", key: ";" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hold: "ctrl", code: "Semicolon", key: ";" });
  });

  it("remembers a stored gesture it cannot use here, and reset writes over it", async () => {
    // Cmd, synced from a Mac: unusable off macOS, so the default runs. The
    // stored value is left alone, and Settings shows why with a reset.
    localStorage.setItem(KEY, JSON.stringify({ hold: "cmd", code: "Semicolon" }));
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Tab" });
    expect(usePrefs.getState().recentTabsGestureRefused).toEqual({ hold: "cmd", code: "Semicolon" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hold: "cmd", code: "Semicolon" });
    // Resetting to the default it already runs is not a no-op: it is the
    // user choosing it here.
    usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Tab" });
    expect(usePrefs.getState().recentTabsGestureRefused).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ hold: "ctrl", code: "Tab" });
  });

  it("does not publish an unchanged gesture", async () => {
    // docs/performance.md bear trap 8: an unchanged write still copies the
    // whole store and re-runs every selector.
    const { usePrefs } = await import("./prefs");
    const before = usePrefs.getState();
    usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Tab" });
    expect(usePrefs.getState()).toBe(before);
  });

  it("is picked up by reloadPrefsFromStorage, and only when it moved", async () => {
    // Config sync writes the key behind the store's back.
    const { usePrefs, reloadPrefsFromStorage } = await import("./prefs");
    expect(reloadPrefsFromStorage()).not.toContain("recentTabsGesture");
    localStorage.setItem(KEY, JSON.stringify({ hold: "ctrl", code: "Semicolon" }));
    expect(reloadPrefsFromStorage()).toContain("recentTabsGesture");
    expect(usePrefs.getState().recentTabsGesture).toEqual({ hold: "ctrl", code: "Semicolon" });
    expect(reloadPrefsFromStorage()).not.toContain("recentTabsGesture");
  });
});

describe("prefs: findInFilesRegex", () => {
  const KEY = "findInFilesRegex";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to false with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().findInFilesRegex).toBe(false);
  });

  it("picks up a persisted true value as the initial state on load", async () => {
    localStorage.setItem(KEY, "1");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().findInFilesRegex).toBe(true);
  });

  it("setFindInFilesRegex(true) updates state and persists it", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setFindInFilesRegex(true);
    expect(usePrefs.getState().findInFilesRegex).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("setFindInFilesRegex(false) updates state and persists it", async () => {
    localStorage.setItem(KEY, "1");
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setFindInFilesRegex(false);
    expect(usePrefs.getState().findInFilesRegex).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});

describe("prefs: findInFilesMatchCase", () => {
  const KEY = "findInFilesMatchCase";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to false, so search stays case-insensitive", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().findInFilesMatchCase).toBe(false);
  });

  it("picks up a persisted true value as the initial state on load", async () => {
    localStorage.setItem(KEY, "1");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().findInFilesMatchCase).toBe(true);
  });

  it("setFindInFilesMatchCase(true) updates state and persists it", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setFindInFilesMatchCase(true);
    expect(usePrefs.getState().findInFilesMatchCase).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("setFindInFilesMatchCase(false) updates state and persists it", async () => {
    localStorage.setItem(KEY, "1");
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setFindInFilesMatchCase(false);
    expect(usePrefs.getState().findInFilesMatchCase).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("is independent of the regexp toggle", async () => {
    localStorage.setItem("findInFilesRegex", "1");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().findInFilesRegex).toBe(true);
    expect(usePrefs.getState().findInFilesMatchCase).toBe(false);
  });
});

// The three-way renderer pref (GH #140 follow-up) has to coexist with the
// boolean it supersedes: profiles in the wild only have terminalGpuEnabled,
// and the Appearance toggle still writes it. Anything that lets the two drift
// means the UI and the mounted renderer disagree, so the sync is the contract
// worth pinning, in both directions and across a reload.
describe("prefs: terminalRenderer", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to webgl with nothing stored", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().terminalRenderer).toBe("webgl");
    expect(usePrefs.getState().terminalGpuEnabled).toBe(true);
  });

  it("migrates a pre-existing terminalGpuEnabled=0 profile to dom", async () => {
    localStorage.setItem("terminalGpuEnabled", "0");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().terminalRenderer).toBe("dom");
  });

  it("prefers an explicit terminalRenderer over the legacy boolean", async () => {
    localStorage.setItem("terminalGpuEnabled", "0");
    localStorage.setItem("terminalRenderer", "canvas");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().terminalRenderer).toBe("canvas");
  });

  it("falls back to the boolean when the stored kind is garbage", async () => {
    localStorage.setItem("terminalRenderer", "vulkan");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().terminalRenderer).toBe("webgl");
  });

  it("setTerminalRenderer(canvas) clears the legacy boolean", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setTerminalRenderer("canvas");
    expect(usePrefs.getState().terminalGpuEnabled).toBe(false);
    expect(localStorage.getItem("terminalRenderer")).toBe("canvas");
    expect(localStorage.getItem("terminalGpuEnabled")).toBe("0");
  });

  it("setTerminalGpuEnabled(false) moves the renderer to dom, not canvas", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setTerminalRenderer("canvas");
    usePrefs.getState().setTerminalGpuEnabled(false);
    expect(usePrefs.getState().terminalRenderer).toBe("dom");
  });

  it("setTerminalGpuEnabled(true) restores webgl, not the previous canvas", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setTerminalRenderer("canvas");
    usePrefs.getState().setTerminalGpuEnabled(true);
    expect(usePrefs.getState().terminalRenderer).toBe("webgl");
    expect(localStorage.getItem("terminalRenderer")).toBe("webgl");
  });
});

describe("prefs: editorThemeIdDark / editorThemeIdLight", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("both default to auto with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().editorThemeIdDark).toBe("auto");
    expect(usePrefs.getState().editorThemeIdLight).toBe("auto");
  });

  // Pre-split installs only ever wrote the single "editorThemeId" key. An
  // explicit pick applied under both app modes, so on first load after the
  // split, both selectors must seed from it identically — otherwise an
  // existing user's chosen theme silently vanishes from one mode.
  it("seeds editorThemeIdLight from the pre-split editorThemeId when unset", async () => {
    localStorage.setItem("editorThemeId", "tokyo-night");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().editorThemeIdDark).toBe("tokyo-night");
    expect(usePrefs.getState().editorThemeIdLight).toBe("tokyo-night");
  });

  it("editorThemeIdLight uses its own key once explicitly set, independent of dark", async () => {
    localStorage.setItem("editorThemeId", "tokyo-night");
    localStorage.setItem("editorThemeIdLight", "github-light");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().editorThemeIdDark).toBe("tokyo-night");
    expect(usePrefs.getState().editorThemeIdLight).toBe("github-light");
  });

  it("setEditorThemeIdDark/Light update state and persist independently", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setEditorThemeIdDark("nord");
    usePrefs.getState().setEditorThemeIdLight("xcode-light");
    expect(usePrefs.getState().editorThemeIdDark).toBe("nord");
    expect(usePrefs.getState().editorThemeIdLight).toBe("xcode-light");
    expect(localStorage.getItem("editorThemeId")).toBe("nord");
    expect(localStorage.getItem("editorThemeIdLight")).toBe("xcode-light");
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

// The font picker must only offer fonts that actually exist on the machine
// (plus the bundled JetBrains Mono, which the OS catalog can't see), sorted
// for display. mergeFontOptions is the pure core behind
// availableMonoFontsAsync — tested directly so no IPC mocking is needed.
describe("prefs: mergeFontOptions", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
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

// "Show all installed fonts" (follow-up to the installed-only filter): a
// default-off escape hatch for monos that is_monospace() misses. Plain
// persisted boolean, reset with the rest of the Appearance page.
describe("prefs: showAllInstalledFonts", () => {
  const LS = "showAllInstalledFonts";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to false with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().showAllInstalledFonts).toBe(false);
  });

  it("picks up a persisted true value as the initial state on load", async () => {
    localStorage.setItem(LS, "1");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().showAllInstalledFonts).toBe(true);
  });

  it("setShowAllInstalledFonts updates state and persists it", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setShowAllInstalledFonts(true);
    expect(usePrefs.getState().showAllInstalledFonts).toBe(true);
    expect(localStorage.getItem(LS)).toBe("1");
  });

  it("resetAppearance restores it to off", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setShowAllInstalledFonts(true);
    usePrefs.getState().resetAppearance();
    expect(usePrefs.getState().showAllInstalledFonts).toBe(false);
    expect(localStorage.getItem(LS)).toBe("0");
  });
});

// availableMonoFontsAsync(showAll): showAll widens the system: extras source
// from the is_monospace() subset to the full family catalog. The curated
// installed-only filter is unchanged either way. IPC is mocked (importOriginal
// keeps the module's other exports real) so both toggle states can be observed
// against the same fake catalog, including after the lists are cached.
describe("prefs: availableMonoFontsAsync showAll", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
    vi.doMock("@/lib/ipc", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      listFontFamilies: async () => ["Menlo", "Comic Sans MS"],
      listMonospaceFonts: async () => ["Menlo"],
    }));
  });
  afterEach(() => {
    vi.doUnmock("@/lib/ipc");
    vi.unstubAllGlobals();
  });

  it("hides non-monospace families by default", async () => {
    const { availableMonoFontsAsync } = await import("./prefs");
    const ids = (await availableMonoFontsAsync()).map(o => o.id);
    expect(ids).not.toContain("system:Comic Sans MS");
    expect(ids).toContain("menlo");
  });

  it("lists every installed family as a system: extra when showAll is on", async () => {
    const { availableMonoFontsAsync } = await import("./prefs");
    // First call caches the enumerated lists; the showAll call must
    // re-merge from those caches, not serve the filtered result.
    await availableMonoFontsAsync();
    const ids = (await availableMonoFontsAsync(true)).map(o => o.id);
    expect(ids).toContain("system:Comic Sans MS");
    // curated handling is untouched: Menlo stays curated (no system:
    // duplicate), uninstalled curated entries stay hidden
    expect(ids).toContain("menlo");
    expect(ids).not.toContain("system:Menlo");
    expect(ids).not.toContain("hack");
  });
});

// The macOS appearance flip. `themeMode` cannot carry it: under "auto" the
// stored string is "auto" before AND after the flip, so every subscriber keyed
// on it (the xterm palette swap in TerminalPane / AuxTerminal, the editor and
// diff themes) stayed on the old palette until the user re-picked a theme by
// hand. `systemScheme` is the field that actually changes, and these cases pin
// both halves: that a flip is recorded, and that it only moves the RESOLVED
// palette when the user is following the system.
describe("prefs: systemScheme follows the OS appearance", () => {
  function stubMatchMedia(light: boolean) {
    const listeners = new Set<() => void>();
    let isLight = light;
    const mql = {
      get matches() { return isLight; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    };
    // Every query resolves to the same list — prefs only ever asks for
    // "(prefers-color-scheme: light)".
    vi.stubGlobal("matchMedia", () => mql);
    return (next: boolean) => { isLight = next; listeners.forEach(fn => fn()); };
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("initializes from the OS at module load", async () => {
    stubMatchMedia(true);
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().systemScheme).toBe("light");
  });

  it("defaults to dark when matchMedia is unavailable", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const { usePrefs, readSystemScheme } = await import("./prefs");
    expect(readSystemScheme()).toBe("dark");
    expect(usePrefs.getState().systemScheme).toBe("dark");
  });

  it("records a flip, so an auto theme resolves to the new palette", async () => {
    const flip = stubMatchMedia(false);
    const { usePrefs, resolveThemeFull } = await import("./prefs");
    usePrefs.getState().setThemeMode("auto");
    expect(resolveThemeFull("auto", usePrefs.getState().systemScheme)).toBe("dark");

    flip(true);
    expect(usePrefs.getState().systemScheme).toBe("light");
    expect(resolveThemeFull("auto", usePrefs.getState().systemScheme)).toBe("light");
  });

  it("records the flip under an explicit theme too, without moving the palette", async () => {
    // The store write is unconditional so the value is already right when the
    // user switches to auto later — but the resolved id is what the terminal
    // panes key on, and it must NOT move here: re-assigning `options.theme`
    // repaints every mounted xterm for a palette that did not change.
    const flip = stubMatchMedia(false);
    const { usePrefs, resolveThemeFull } = await import("./prefs");
    usePrefs.getState().setThemeMode("claude");

    flip(true);
    expect(usePrefs.getState().systemScheme).toBe("light");
    expect(resolveThemeFull("claude", usePrefs.getState().systemScheme)).toBe("claude");

    usePrefs.getState().setThemeMode("auto");
    expect(resolveThemeFull("auto", usePrefs.getState().systemScheme)).toBe("light");
  });

  it("leaves a custom theme id untouched across a flip", async () => {
    const flip = stubMatchMedia(false);
    const { usePrefs, resolveThemeFull } = await import("./prefs");
    const custom = {
      id: "custom:paper" as const, name: "Paper", colorScheme: "light" as const,
      ui: {}, terminal: {},
    };
    usePrefs.setState({ customThemes: [custom as any] });
    usePrefs.getState().setThemeMode(custom.id);

    flip(true);
    expect(resolveThemeFull(custom.id, usePrefs.getState().systemScheme)).toBe(custom.id);
  });
});

// The footer's per-agent readouts. Stored as OPT-OUTS, so an agent nobody has
// touched (including one added after this shipped) shows both, and a corrupt
// blob loses only the opt-outs.
describe("prefs: agentFooterHidden", () => {
  const KEY = "agentFooterHidden";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows everything by default", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().agentFooterHidden).toEqual({});
  });

  it("hides and re-shows one readout for one agent, and persists it", async () => {
    const { usePrefs } = await import("./prefs");
    const s = usePrefs.getState();
    s.setAgentFooterShown("claude", "context", false);
    expect(usePrefs.getState().agentFooterHidden).toEqual({ claude: { context: true } });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ claude: { context: true } });
    s.setAgentFooterShown("claude", "usage", false);
    s.setAgentFooterShown("claude", "context", true);
    expect(usePrefs.getState().agentFooterHidden).toEqual({ claude: { usage: true } });
    s.setAgentFooterShown("claude", "usage", true);
    // Nothing hidden leaves no entry behind at all.
    expect(usePrefs.getState().agentFooterHidden).toEqual({});
  });

  it("does not write an unchanged value (bear trap 8)", async () => {
    const { usePrefs } = await import("./prefs");
    const before = usePrefs.getState().agentFooterHidden;
    usePrefs.getState().setAgentFooterShown("codex", "usage", true);
    expect(usePrefs.getState().agentFooterHidden).toBe(before);
  });

  it("reads back only `true` opt-outs from a stored blob", async () => {
    localStorage.setItem(KEY, JSON.stringify({ a: { usage: true, context: "yes" }, b: 5, c: { context: true } }));
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().agentFooterHidden).toEqual({ a: { usage: true }, c: { context: true } });
  });

  it("survives a corrupt blob", async () => {
    localStorage.setItem(KEY, "{nope");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().agentFooterHidden).toEqual({});
  });
});

// A default that ships ON, so an absent key must not read as off. The mark it
// gates is the only thing that moves on a turn with three subagents between
// "started" and "finished", and turning it off for everybody on upgrade would
// look like the feature was never built.
describe("prefs: partialDoneIndicator", () => {
  const KEY = "partialDoneIndicator";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to on with nothing in localStorage", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().partialDoneIndicator).toBe(true);
  });

  it("picks up a persisted off value on load", async () => {
    localStorage.setItem(KEY, "0");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().partialDoneIndicator).toBe(false);
  });

  it("setPartialDoneIndicator persists both directions", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setPartialDoneIndicator(false);
    expect(usePrefs.getState().partialDoneIndicator).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    usePrefs.getState().setPartialDoneIndicator(true);
    expect(usePrefs.getState().partialDoneIndicator).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });
});

// The bell used to ride `settledHighlight`, so this key is absent on every
// existing install. Seeding it from that pref is the difference between
// respecting a choice somebody already made and silently reversing it: a
// user who turned the work-done UI off to stop being interrupted would
// otherwise be interrupted again by the upgrade.
describe("prefs: attentionIndicator", () => {
  const KEY = "attentionIndicator";
  const OLD = "settledHighlight";
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults to on for a fresh install", async () => {
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().attentionIndicator).toBe(true);
  });

  it("inherits an off work-done pref when it has no key of its own", async () => {
    localStorage.setItem(OLD, "0");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().attentionIndicator).toBe(false);
  });

  it("its own key wins over the one it was seeded from", async () => {
    localStorage.setItem(OLD, "0");
    localStorage.setItem(KEY, "1");
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().attentionIndicator).toBe(true);
  });

  it("setAttentionIndicator persists both directions", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setAttentionIndicator(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    usePrefs.getState().setAttentionIndicator(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });
});

describe("prefs: status section", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("ships off, with no bucket overrides (count-only buckets folded)", async () => {
    const { usePrefs } = await import("./prefs");
    const s = usePrefs.getState();
    expect(s.showStatusSection).toBe(false);
    expect(s.statusBucketCollapsed).toEqual({});
  });

  it("reads both back from localStorage, dropping junk bucket entries", async () => {
    localStorage.setItem("showStatusSection", "1");
    localStorage.setItem("statusBucketCollapsed", '{"settled":false,"archived":true}');
    const { usePrefs } = await import("./prefs");
    const s = usePrefs.getState();
    expect(s.showStatusSection).toBe(true);
    expect(s.statusBucketCollapsed).toEqual({ settled: false });
  });

  it("the Kanban nav entry ships on, and only a stored 0 turns it off", async () => {
    const first = await import("./prefs");
    expect(first.usePrefs.getState().showBoard).toBe(true);
    first.usePrefs.getState().setShowBoard(false);
    expect(localStorage.getItem("showBoard")).toBe("0");
    vi.resetModules();
    const second = await import("./prefs");
    expect(second.usePrefs.getState().showBoard).toBe(false);
    let calls = 0;
    const off = second.usePrefs.subscribe(() => { calls++; });
    second.usePrefs.getState().setShowBoard(false);
    off();
    expect(calls).toBe(0);
  });

  it("the Scheduled nav entry: always by default, and auto follows the schedules", async () => {
    const first = await import("./prefs");
    expect(first.usePrefs.getState().scheduledNav).toBe("always");
    expect(first.parseScheduledNav("junk")).toBe("always");
    expect(first.scheduledNavVisible("always", false)).toBe(true);
    expect(first.scheduledNavVisible("auto", false)).toBe(false);
    expect(first.scheduledNavVisible("auto", true)).toBe(true);
    expect(first.scheduledNavVisible("off", true)).toBe(false);
    first.usePrefs.getState().setScheduledNav("auto");
    expect(localStorage.getItem("scheduledNav")).toBe("auto");
    vi.resetModules();
    const second = await import("./prefs");
    expect(second.usePrefs.getState().scheduledNav).toBe("auto");
  });

  it("the task git icon: both by default, and each mode shows its own rows", async () => {
    const first = await import("./prefs");
    expect(first.usePrefs.getState().taskLocationIcon).toBe("both");
    expect(first.parseTaskLocationIcon("junk")).toBe("both");
    expect(first.taskLocationIconShown("both", true)).toBe(true);
    expect(first.taskLocationIconShown("both", false)).toBe(true);
    expect(first.taskLocationIconShown("main", true)).toBe(true);
    expect(first.taskLocationIconShown("main", false)).toBe(false);
    expect(first.taskLocationIconShown("worktree", true)).toBe(false);
    expect(first.taskLocationIconShown("worktree", false)).toBe(true);
    expect(first.taskLocationIconShown("none", true)).toBe(false);
    first.usePrefs.getState().setTaskLocationIcon("main");
    expect(localStorage.getItem("taskLocationIcon")).toBe("main");
    vi.resetModules();
    const second = await import("./prefs");
    expect(second.usePrefs.getState().taskLocationIcon).toBe("main");
  });

  it("the task PR mark: the number alone by default, and a choice survives a reload", async () => {
    const first = await import("./prefs");
    expect(first.usePrefs.getState().taskPrBadge).toBe("number");
    expect(first.parseTaskPrBadge("junk")).toBe("number");
    for (const m of ["both", "icon", "number", "none"] as const) expect(first.parseTaskPrBadge(m)).toBe(m);
    let notified = 0;
    const unsub = first.usePrefs.subscribe(() => { notified++; });
    // Already the default: no write, no notify (bear trap 8).
    first.usePrefs.getState().setTaskPrBadge("number");
    expect(notified).toBe(0);
    expect(localStorage.getItem("taskPrBadge")).toBeNull();
    // "both" was the default once, so it has to be a value that is STORED:
    // falling through to the default would now silently mean "number".
    first.usePrefs.getState().setTaskPrBadge("both");
    unsub();
    expect(notified).toBe(1);
    expect(localStorage.getItem("taskPrBadge")).toBe("both");
    vi.resetModules();
    const second = await import("./prefs");
    expect(second.usePrefs.getState().taskPrBadge).toBe("both");
  });

  it("the profile colour stays off the sidebar until asked for", async () => {
    const first = await import("./prefs");
    expect(first.usePrefs.getState().profileSidebarWash).toBe(false);
    first.usePrefs.getState().setProfileSidebarWash(true);
    expect(localStorage.getItem("profileSidebarWash")).toBe("1");
    vi.resetModules();
    const second = await import("./prefs");
    expect(second.usePrefs.getState().profileSidebarWash).toBe(true);
  });

  it("the setters persist", async () => {
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setShowStatusSection(true);
    usePrefs.getState().setStatusSectionCollapsed(true);
    usePrefs.getState().setStatusBucketCollapsed("settled", false);
    expect(localStorage.getItem("showStatusSection")).toBe("1");
    expect(localStorage.getItem("statusSectionCollapsed")).toBe("1");
    expect(JSON.parse(localStorage.getItem("statusBucketCollapsed")!)).toEqual({ settled: false });
  });

  it("an unchanged value notifies nobody (bear trap 8)", async () => {
    const { usePrefs } = await import("./prefs");
    let notified = 0;
    const unsub = usePrefs.subscribe(() => { notified++; });
    usePrefs.getState().setShowStatusSection(false);
    usePrefs.getState().setStatusSectionCollapsed(false);
    // Already the default for both, so there is no override to write.
    usePrefs.getState().setStatusBucketCollapsed("attention", false);
    usePrefs.getState().setStatusBucketCollapsed("backlog", true);
    expect(notified).toBe(0);
    expect(localStorage.getItem("statusBucketCollapsed")).toBeNull();
    usePrefs.getState().setStatusBucketCollapsed("backlog", false);
    usePrefs.getState().setStatusBucketCollapsed("backlog", false);
    expect(notified).toBe(1);
    unsub();
  });

  it("remembers expanded rows, prunes dead ones, and bails on no change", async () => {
    localStorage.setItem("statusTaskExpanded", '{"old":true}');
    const { usePrefs } = await import("./prefs");
    expect(usePrefs.getState().statusTaskExpanded).toEqual({ old: true });
    let notified = 0;
    const unsub = usePrefs.subscribe(() => { notified++; });
    usePrefs.getState().setStatusTaskExpanded("t1", true, ["t1"]);
    expect(usePrefs.getState().statusTaskExpanded).toEqual({ t1: true });
    expect(JSON.parse(localStorage.getItem("statusTaskExpanded")!)).toEqual({ t1: true });
    usePrefs.getState().setStatusTaskExpanded("t1", true, ["t1"]);
    expect(notified).toBe(1);
    unsub();
  });

  it("remembers folded group captions apart from the tree's, pruned the same way", async () => {
    localStorage.setItem("statusGroupCollapsed", '{"dissolved":true}');
    const { usePrefs } = await import("./prefs");
    usePrefs.getState().setStatusGroupCollapsed("g1", true, ["g1"]);
    expect(usePrefs.getState().statusGroupCollapsed).toEqual({ g1: true });
    expect(JSON.parse(localStorage.getItem("statusGroupCollapsed")!)).toEqual({ g1: true });
  });
});

// A theme missing from themes_list means "the user deleted the file", so the
// pick resets to claude and is persisted. An import is never the active
// theme outside a palette preview: picking one saves a native copy, so the
// Ghostty / Warp file going away cannot strand the pick.
describe("prefs: custom and imported themes", () => {
  let listed: () => Promise<unknown>;
  let imports: () => Promise<unknown>;
  let saved: (args: { theme: { id: string } }) => Promise<unknown>;
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
    imports = () => Promise.resolve([]);
    saved = ({ theme }) => Promise.resolve(theme.id.replace(":", "-"));
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: vi.fn((cmd: string, args: any) =>
        cmd === "themes_list" ? listed()
        : cmd === "themes_imports" ? imports()
        : cmd === "themes_save_import" ? saved(args)
        : Promise.resolve(undefined)),
    }));
  });
  afterEach(() => { vi.doUnmock("@tauri-apps/api/core"); vi.unstubAllGlobals(); });

  const file = (id: string) => ({
    id, name: id, colorScheme: "dark", ui: {}, terminal: { background: "#272822" },
  });

  async function pick(id: string, files: unknown[]) {
    const prefs = await import("./prefs");
    listed = () => Promise.resolve(files);
    await prefs.usePrefs.getState().loadCustomThemes();
    prefs.usePrefs.getState().setThemeMode(`custom:${id}` as const);
    return prefs;
  }

  it("resets a native pick whose file was deleted", async () => {
    const { usePrefs } = await pick("paper", [file("paper")]);
    listed = () => Promise.resolve([]);
    await usePrefs.getState().loadCustomThemes();
    expect(usePrefs.getState().themeMode).toBe("claude");
    expect(localStorage.getItem("customThemeCache")).toBeNull();
  });

  it("keeps a native pick when the listing itself fails", async () => {
    const { usePrefs } = await pick("paper", [file("paper")]);
    listed = () => Promise.reject(new Error("themes dir unreadable"));
    await usePrefs.getState().loadCustomThemes();
    expect(usePrefs.getState().themeMode).toBe("custom:paper");
    expect(usePrefs.getState().customThemes.map(t => t.id)).toEqual(["custom:paper"]);
  });

  it("picks an import by saving a native copy and switching to it", async () => {
    const { usePrefs } = await import("./prefs");
    listed = () => Promise.resolve([]);
    imports = () => Promise.resolve([file("ghostty:monokai")]);
    await usePrefs.getState().loadImportedThemes();
    let sent: any;
    saved = (args) => {
      sent = args.theme;
      listed = () => Promise.resolve([{ ...args.theme, id: "ghostty-monokai" }]);
      return Promise.resolve("ghostty-monokai");
    };
    await usePrefs.getState().pickImportedTheme("custom:ghostty:monokai");
    // the copy carries the derived chrome, not the bare palette
    expect(sent.id).toBe("ghostty:monokai");
    expect(sent.ui["bg-1"]).toBeDefined();
    expect(usePrefs.getState().themeMode).toBe("custom:ghostty-monokai");
    expect(localStorage.getItem("themeMode")).toBe("custom:ghostty-monokai");

    // the Ghostty file goes away: the copy is untouched by it
    imports = () => Promise.resolve([]);
    await usePrefs.getState().loadImportedThemes();
    await usePrefs.getState().loadCustomThemes();
    expect(usePrefs.getState().themeMode).toBe("custom:ghostty-monokai");
  });

  it("leaves the theme alone when saving the copy fails", async () => {
    const { usePrefs } = await pick("paper", [file("paper")]);
    imports = () => Promise.resolve([file("warp:x")]);
    await usePrefs.getState().loadImportedThemes();
    saved = () => Promise.reject(new Error("read-only"));
    await expect(usePrefs.getState().pickImportedTheme("custom:warp:x")).rejects.toThrow();
    expect(usePrefs.getState().themeMode).toBe("custom:paper");
  });

  it("does not reset a palette preview of an import when the listing lands", async () => {
    const { usePrefs } = await pick("paper", [file("paper")]);
    imports = () => Promise.resolve([file("warp:x")]);
    await usePrefs.getState().loadImportedThemes();
    usePrefs.getState().previewThemeMode("custom:warp:x");
    await usePrefs.getState().loadCustomThemes();
    expect(usePrefs.getState().themeMode).toBe("custom:warp:x");
  });

  // quitting mid-preview must reopen on the committed theme: before, the
  // previewed import id was persisted with no cache payload behind it, and
  // the next launch fell back to claude
  it("never persists a preview, and a commit or rollback ends it", async () => {
    const { usePrefs } = await pick("paper", [file("paper"), file("ink")]);
    imports = () => Promise.resolve([file("warp:x")]);
    await usePrefs.getState().loadImportedThemes();
    usePrefs.getState().previewThemeMode("custom:warp:x");
    usePrefs.getState().previewThemeMode("custom:ink");
    expect(usePrefs.getState().themeMode).toBe("custom:ink");
    expect(localStorage.getItem("themeMode")).toBe("custom:paper");
    expect(JSON.parse(localStorage.getItem("customThemeCache")!).id).toBe("custom:paper");
    // a refetch while previewing leaves both alone
    await usePrefs.getState().loadCustomThemes();
    expect(JSON.parse(localStorage.getItem("customThemeCache")!).id).toBe("custom:paper");

    // rolled back: a deleted file resets again, so the preview is over
    usePrefs.getState().setThemeMode("custom:paper");
    listed = () => Promise.resolve([file("ink")]);
    await usePrefs.getState().loadCustomThemes();
    expect(usePrefs.getState().themeMode).toBe("claude");
  });

  it("republishes an unchanged scan when the list was cleared", async () => {
    const { usePrefs } = await import("./prefs");
    imports = () => Promise.resolve([file("warp:x")]);
    await usePrefs.getState().loadImportedThemes();
    usePrefs.setState({ importedThemes: [] });
    await usePrefs.getState().loadImportedThemes();
    expect(usePrefs.getState().importedThemes.map(t => t.id)).toEqual(["custom:warp:x"]);
  });

  it("does not republish an unchanged import list", async () => {
    const { usePrefs } = await import("./prefs");
    imports = () => Promise.resolve([file("warp:x")]);
    await usePrefs.getState().loadImportedThemes();
    const first = usePrefs.getState().importedThemes;
    await usePrefs.getState().loadImportedThemes();
    expect(usePrefs.getState().importedThemes).toBe(first);
  });
});
