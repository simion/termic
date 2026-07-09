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
