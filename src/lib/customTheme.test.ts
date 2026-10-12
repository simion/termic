import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  UI_KEYS,
  TERMINAL_KEYS,
  isValidColor,
  isCustomId,
  sanitizeTheme,
  applyCustomVars,
  clearCustomVars,
  mergeTerminal,
  readThemeCache,
  writeThemeCache,
  clearThemeCache,
  deriveChrome,
  sanitizeImport,
  copyIdOf,
  type CustomThemeFile,
} from "@/lib/customTheme";

// ── isValidColor ──────────────────────────────────────────────────────

describe("isValidColor", () => {
  it("accepts hex in all four lengths", () => {
    expect(isValidColor("#abc")).toBe(true);
    expect(isValidColor("#abcd")).toBe(true);
    expect(isValidColor("#aabbcc")).toBe(true);
    expect(isValidColor("#aabbccdd")).toBe(true);
  });

  it("accepts rgb()/rgba()/hsl()/hsla() functional notation", () => {
    expect(isValidColor("rgb(1, 2, 3)")).toBe(true);
    expect(isValidColor("rgba(224,222,244,0.05)")).toBe(true);
    expect(isValidColor("hsl(210 50% 40%)")).toBe(true);
    expect(isValidColor("hsla(210, 50%, 40%, 0.5)")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isValidColor("  #aabbcc  ")).toBe(true);
  });

  it("rejects named colors, CSS injection shapes, and non-strings", () => {
    // Values land in inline styles / xterm options, so only shapes we
    // can reason about get through.
    expect(isValidColor("red")).toBe(false);
    expect(isValidColor("var(--color-bg)")).toBe(false);
    expect(isValidColor("url(javascript:alert(1))")).toBe(false);
    expect(isValidColor("#aabbcc; background: red")).toBe(false);
    expect(isValidColor("")).toBe(false);
    expect(isValidColor(42)).toBe(false);
    expect(isValidColor(null)).toBe(false);
  });
});

// ── isCustomId ────────────────────────────────────────────────────────

describe("isCustomId", () => {
  it("matches only the custom: namespace", () => {
    expect(isCustomId("custom:rose-pine-moon")).toBe(true);
    expect(isCustomId("claude")).toBe(false);
    expect(isCustomId("rosepine")).toBe(false);
  });
});

// ── sanitizeTheme ─────────────────────────────────────────────────────

function rawFile(overrides: Partial<CustomThemeFile> = {}): CustomThemeFile {
  return {
    id: "tokyo-night",
    name: "Tokyo Night",
    colorScheme: "dark",
    ui: {},
    terminal: {},
    ...overrides,
  };
}

describe("sanitizeTheme", () => {
  it("namespaces the id and keeps the name", () => {
    const t = sanitizeTheme(rawFile());
    expect(t.id).toBe("custom:tokyo-night");
    expect(t.name).toBe("Tokyo Night");
  });

  it("falls back name → slug and slug → 'theme'", () => {
    expect(sanitizeTheme(rawFile({ name: "  " })).name).toBe("tokyo-night");
    const empty = sanitizeTheme(rawFile({ id: "", name: "" }));
    expect(empty.id).toBe("custom:theme");
    expect(empty.name).toBe("theme");
  });

  it("treats anything but 'light' as dark", () => {
    expect(sanitizeTheme(rawFile({ colorScheme: "light" })).colorScheme).toBe("light");
    expect(sanitizeTheme(rawFile({ colorScheme: "DARK" })).colorScheme).toBe("dark");
    expect(sanitizeTheme(rawFile({ colorScheme: "" })).colorScheme).toBe("dark");
  });

  it("keeps allowlisted keys with valid colors, drops everything else", () => {
    const t = sanitizeTheme(rawFile({
      ui: {
        bg: "#1a1b26",
        accent: " #7aa2f7 ",          // trimmed on the way in
        "accent-fg": "#1a1b26",       // new ink token is themeable
        "ok-fg": "#1a1b26",
        fg: "red",                    // invalid value → dropped
        "not-a-key": "#ffffff",       // unknown key → dropped
      },
      terminal: {
        background: "#1a1b26",
        cursor: "blink",              // invalid value → dropped
        bogus: "#fff",                // unknown key → dropped
      },
    }));
    expect(t.ui).toEqual({
      bg: "#1a1b26",
      accent: "#7aa2f7",
      "accent-fg": "#1a1b26",
      "ok-fg": "#1a1b26",
    });
    expect(t.terminal).toEqual({ background: "#1a1b26" });
  });

  it("drops non-string values per-key, keeping the file's valid siblings", () => {
    // Rust hands ui/terminal over as raw JSON, so a number reaches us
    // instead of failing the whole file at deserialize time.
    const t = sanitizeTheme(rawFile({
      ui: { bg: 123, accent: "#ff00ff", fg: null, "fg-dim": { nested: 1 } },
      terminal: { background: true, cursor: "#ea9a97" },
    }));
    expect(t.ui).toEqual({ accent: "#ff00ff" });
    expect(t.terminal).toEqual({ cursor: "#ea9a97" });
  });

  it("survives non-object ui/terminal blocks", () => {
    const t = sanitizeTheme(rawFile({
      ui: "nope" as unknown as Record<string, string>,
      terminal: null as unknown as Record<string, string>,
    }));
    expect(t.ui).toEqual({});
    expect(t.terminal).toEqual({});
  });
});

// ── applyCustomVars / clearCustomVars ─────────────────────────────────

function fakeHtml() {
  const vars = new Map<string, string>();
  const html = {
    style: {
      setProperty: (k: string, v: string) => { vars.set(k, v); },
      removeProperty: (k: string) => { vars.delete(k); },
    },
  } as unknown as HTMLElement;
  return { html, vars };
}

describe("applyCustomVars", () => {
  it("sets provided keys and removes the rest (no stale vars across switches)", () => {
    const { html, vars } = fakeHtml();
    applyCustomVars(html, { bg: "#111111", accent: "#222222" });
    expect(vars.get("--color-bg")).toBe("#111111");
    expect(vars.get("--color-accent")).toBe("#222222");

    // Switch to a theme that only sets bg: accent must be cleared.
    applyCustomVars(html, { bg: "#333333" });
    expect(vars.get("--color-bg")).toBe("#333333");
    expect(vars.has("--color-accent")).toBe(false);
  });

  it("clearCustomVars removes every allowlisted var", () => {
    const { html, vars } = fakeHtml();
    const ui = Object.fromEntries(UI_KEYS.map(k => [k, "#123456"]));
    applyCustomVars(html, ui);
    expect(vars.size).toBe(UI_KEYS.length);
    clearCustomVars(html);
    expect(vars.size).toBe(0);
  });
});

// ── mergeTerminal ─────────────────────────────────────────────────────

describe("mergeTerminal", () => {
  it("overrides win, base fills the gaps", () => {
    const merged = mergeTerminal(
      { background: "#000000", red: "#ff0000" },
      { background: "#1a1b26" },
    );
    expect(merged).toEqual({ background: "#1a1b26", red: "#ff0000" });
  });
});

// ── first-paint cache ─────────────────────────────────────────────────

describe("theme cache", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  it("round-trips a sanitized theme", () => {
    writeThemeCache(sanitizeTheme(rawFile({ ui: { bg: "#1a1b26" } })));
    const back = readThemeCache();
    expect(back?.id).toBe("custom:tokyo-night");
    expect(back?.ui).toEqual({ bg: "#1a1b26" });
  });

  it("re-sanitizes on read: a tampered cache can't smuggle bad values", () => {
    store.set("customThemeCache", JSON.stringify({
      id: "custom:evil",
      name: "Evil",
      colorScheme: "dark",
      ui: { bg: "url(javascript:alert(1))", accent: "#7aa2f7", nope: "#fff" },
      terminal: {},
    }));
    const back = readThemeCache();
    expect(back?.ui).toEqual({ accent: "#7aa2f7" });
  });

  it("returns null for a non-custom id, garbage JSON, or an empty cache", () => {
    store.set("customThemeCache", JSON.stringify({ id: "claude" }));
    expect(readThemeCache()).toBeNull();
    store.set("customThemeCache", "{not json");
    expect(readThemeCache()).toBeNull();
    store.delete("customThemeCache");
    expect(readThemeCache()).toBeNull();
  });

  it("clearThemeCache removes the entry", () => {
    writeThemeCache(sanitizeTheme(rawFile()));
    clearThemeCache();
    expect(readThemeCache()).toBeNull();
  });
});

// ── seeded sample ─────────────────────────────────────────────────────
// The sample is what users copy, and it doubles as the format reference.
// It must therefore exercise every key, and survive the real sanitizer
// with nothing dropped. Guards against a new token landing in UI_KEYS
// without reaching the sample (how `ok-fg` first went missing).

describe("example.json.sample", () => {
  const sample = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../src-tauri/assets/themes/example.json.sample", import.meta.url)),
      "utf8",
    ),
  ) as CustomThemeFile;

  it("sets every ui key", () => {
    expect(Object.keys(sample.ui).sort()).toEqual([...UI_KEYS].sort());
  });

  it("sets the whole terminal palette, minus the selection-ink opt-ins", () => {
    // selectionForeground / selectionInactiveBackground are deliberately
    // absent: setting selectionForeground paints ALL selected text one
    // flat color instead of keeping each cell's own, which is rarely what
    // a theme author wants. They stay allowlisted, just not advertised.
    const optional = ["selectionForeground", "selectionInactiveBackground"];
    const expected = TERMINAL_KEYS.filter(k => !optional.includes(k));
    expect(Object.keys(sample.terminal).sort()).toEqual([...expected].sort());
  });

  it("survives sanitizing with nothing dropped", () => {
    const t = sanitizeTheme({ ...sample, id: "example" });
    expect(Object.keys(t.ui)).toHaveLength(UI_KEYS.length);
    expect(Object.keys(t.terminal)).toHaveLength(Object.keys(sample.terminal).length);
    expect(t.colorScheme).toBe("dark");
  });
});

// ── imported themes (Ghostty / Warp) ──────────────────────────────────

describe("deriveChrome / imported themes", () => {
  // classic Monokai: the palette most terminal ports share
  const monokai = {
    background: "#272822", foreground: "#f8f8f2",
    black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#e6db74",
    blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
  };
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
  };

  it("derives every UI key, all valid colors", () => {
    const { ui } = deriveChrome(monokai);
    for (const k of UI_KEYS) expect(isValidColor(ui[k]), k).toBe(true);
  });

  it("reads the scheme off the background and steps surfaces the right way", () => {
    const d = deriveChrome(monokai);
    expect(d.colorScheme).toBe("dark");
    expect(lum(d.ui["bg-1"])).toBeGreaterThan(lum(d.ui.bg));
    expect(lum(d.ui["bg-3"])).toBeGreaterThan(lum(d.ui["bg-1"]));

    const l = deriveChrome({ ...monokai, background: "#fafafa", foreground: "#272822" });
    expect(l.colorScheme).toBe("light");
    expect(lum(l.ui["bg-1"])).toBeLessThan(lum(l.ui.bg));
    expect(lum(l.ui["bg-3"])).toBeLessThan(lum(l.ui["bg-1"]));
  });

  it("keeps accent and status hues readable on a light background", () => {
    const light = { ...monokai, background: "#fafaf8", foreground: "#272822" };
    const { ui } = deriveChrome(light);
    const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const rl = (h: string) => {
      const [r, g, b] = rgb(h).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [rl(a), rl(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const k of ["accent", "ok", "warn", "err"]) expect(ratio(ui[k], ui.bg), k).toBeGreaterThanOrEqual(3);
    expect(ratio(deriveChrome(monokai).ui["accent-deep"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // ink on the accent fill comes from the theme's own pair
    expect([ui.bg, ui.fg]).toContain(ui["accent-fg"]);
    expect(ratio(ui["accent-fg"], ui.accent)).toBeGreaterThanOrEqual(3);
  });

  it("maps status colors from ANSI and honours a supplied accent", () => {
    expect(deriveChrome(monokai).ui.err).toBe("#f92672");
    expect(deriveChrome(monokai).ui.ok).toBe("#a6e22e");
    expect(deriveChrome(monokai, "#fd971f").ui.accent).toBe("#fd971f");
  });

  // stand-ins for TERMINAL_THEMES: just enough to tell which one filled a key
  const bases = {
    dark: { background: "#0b0b0d", foreground: "#eceef1", blue: "#4c8bf5", cursor: "#d97757" },
    light: { background: "#ffffff", foreground: "#1f2328", blue: "#2c5fb3", cursor: "#d97757" },
  };
  const imp = (terminal: Record<string, string>, ui: Record<string, string> = {}): CustomThemeFile =>
    ({ id: "warp:x", name: "X", colorScheme: "", ui, terminal });

  it("derives chrome in sanitizeImport only, never for a native file", () => {
    const base = { id: "ghostty:monokai", name: "Monokai", colorScheme: "", terminal: monokai };
    const imported = sanitizeImport({ ...base, ui: { accent: "#fd971f" } }, bases);
    expect(imported.colorScheme).toBe("dark");
    expect(imported.ui.accent).toBe("#fd971f");
    expect(imported.ui["bg-1"]).toBeDefined();

    const native = sanitizeTheme({ ...base, ui: {} });
    expect(native.ui).toEqual({});
  });

  it("fills an import's missing keys from the base, and derives chrome from the same palette", () => {
    const { blue: _, ...noBlue } = monokai;
    const t = sanitizeImport(imp(noBlue), bases);
    // the terminal's blue and the chrome's blue are one color
    expect(t.terminal.blue).toBe("#4c8bf5");
    expect(t.ui["palette-blue"]).toBe("#4c8bf5");
    expect(t.terminal.cursor).toBe("#d97757");

    // palette-only file: chrome bg is the base the terminal paints, not #000
    const bare = sanitizeImport(imp({ red: "#f92672" }), bases);
    expect(bare.ui.bg).toBe("#0b0b0d");
    expect(bare.terminal.background).toBe("#0b0b0d");

    // a light background picks the light base
    const light = sanitizeImport(imp({ background: "#fafafa" }), bases);
    expect(light.colorScheme).toBe("light");
    expect(light.terminal.foreground).toBe("#1f2328");
  });

  it("keeps a Warp accent only as an input, so its contrast fix sticks", () => {
    // pale yellow on near-white is ~1.4:1 as given
    const t = sanitizeImport(imp({ background: "#fafafa", foreground: "#272822" }, { accent: "#ffd700" }), bases);
    expect(t.ui.accent).not.toBe("#ffd700");
    // the siblings were built from the adjusted value, and still agree with it
    const [r, g, b] = [1, 3, 5].map(i => parseInt(t.ui.accent.slice(i, i + 2), 16));
    expect(t.ui["accent-soft"]).toBe(`rgba(${r}, ${g}, ${b}, 0.22)`);
  });

  it("ignores the file's colorScheme for an import, the background decides", () => {
    const t = sanitizeImport({ ...imp(monokai), colorScheme: "light" }, bases);
    expect(t.colorScheme).toBe("dark");
  });

  it("reads its saved copy back as a native theme that paints the same", () => {
    // pickImportedTheme writes the resolved import as a native file
    // (themes_save_import keeps name / colorScheme / ui / terminal), and
    // loadCustomThemes compares the two with JSON.stringify: any drift would
    // repaint the moment the copy replaces the preview
    const t = sanitizeImport(imp(monokai, { accent: "#fd971f" }), bases);
    const { id: _, ...onDisk } = JSON.parse(JSON.stringify(t));
    const copy = sanitizeTheme({ ...onDisk, id: "warp-x" });
    expect(JSON.stringify({ ...copy, id: t.id })).toBe(JSON.stringify(t));
  });

  it("names the copy the way theme_import.rs copy_stem does", () => {
    expect(copyIdOf("custom:ghostty:monokai-classic")).toBe("custom:ghostty-monokai-classic");
    expect(copyIdOf("custom:warp:w")).toBe("custom:warp-w");
  });
});
