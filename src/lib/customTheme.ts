// Custom theme files — one JSON per theme in `~/.config/termic/themes/`
// ($XDG_CONFIG_HOME/termic/themes when set; shared by release + dev builds).
// Files are the whole interface: drop a JSON in the folder and it shows up
// in the theme picker as a first-class theme (chrome + terminal, coupled).
// This module is pure logic (no store / IPC imports): schema types, the
// key allowlists, validation, the inline-CSS-var apply/clear, the terminal
// palette merge, and the first-paint localStorage cache. See docs/themes.md
// for the file format reference.

export type ColorScheme = "dark" | "light";

/** Raw shape returned by the Rust `themes_list` command. Parsed JSON but
 *  NOT yet validated. Values are `unknown`, not `string`: Rust hands them
 *  over as raw JSON so one `"bg": 123` degrades that key instead of
 *  discarding the whole file, and `isValidColor` does the typeof check. */
export interface CustomThemeFile {
  /** File stem (e.g. "rose-pine-moon" for rose-pine-moon.json). */
  id: string;
  name: string;
  colorScheme: string;
  ui: Record<string, unknown>;
  terminal: Record<string, unknown>;
}

/** Sanitized in-app representation. `id` carries the `custom:` namespace
 *  prefix so a user file named claude.json (→ `custom:claude`) can never
 *  shadow the built-in theme ids. */
export interface CustomTheme {
  id: `custom:${string}`;
  name: string;
  colorScheme: ColorScheme;
  /** Allowlisted `--color-<key>` overrides. Partial — missing keys fall
   *  back to the @theme defaults (Dark+). */
  ui: Record<string, string>;
  /** Allowlisted xterm ITheme overrides, merged over the built-in base
   *  palette matching `colorScheme`. */
  terminal: Record<string, string>;
}

/** UI keys map 1:1 to the `--color-<key>` vars declared in index.css's
 *  @theme block. The `--color-cli-*` agent tints are deliberately excluded
 *  from v1 (they inherit defaults). */
export const UI_KEYS = [
  "bg", "bg-1", "bg-2", "bg-3",
  "fg", "fg-dim", "fg-faint",
  "border", "border-soft",
  "hover", "sel",
  "accent", "accent-soft", "accent-deep", "accent-fg",
  "ok", "ok-fg", "warn", "err",
  // Palette ramp: hue-named accents for user-assigned marks (project-group
  // folders consume it). Optional like everything else — omitted keys keep
  // the built-in hues. Tune shades to your theme but keep hues recognizable.
  "palette-red", "palette-orange", "palette-yellow", "palette-green",
  "palette-teal", "palette-blue", "palette-purple", "palette-pink",
] as const;

/** xterm ITheme color keys (see TERMINAL_THEMES in store/prefs.ts). */
export const TERMINAL_KEYS = [
  "background", "foreground",
  "cursor", "cursorAccent",
  "selectionBackground", "selectionForeground", "selectionInactiveBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/** Accepts hex (#rgb #rgba #rrggbb #rrggbbaa) and rgb/rgba/hsl/hsla()
 *  functional notation. Deliberately NOT a full CSS <color> grammar —
 *  these values land in inline styles and xterm options, so we only let
 *  through shapes we can reason about. Invalid values are skipped, not
 *  fatal (the key falls back to its default). */
const COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/deg-]+\))$/i;

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_RE.test(value.trim());
}

export function isCustomId(id: string): id is `custom:${string}` {
  return id.startsWith("custom:");
}

/** "ghostty" / "warp" for an import (`custom:ghostty:x`) or its saved copy
 *  (`custom:ghostty-x`), else null.
 *  ponytail: reads the id, so a hand-written `ghostty-foo.json` tags as
 *  Ghostty too; carry the source into the copy if that ever matters. */
export function themeSource(id: string): "ghostty" | "warp" | null {
  const m = /^custom:(ghostty|warp)[:-]/.exec(id);
  return m ? (m[1] as "ghostty" | "warp") : null;
}

/** Id of the native copy a picked import is saved as (`custom:ghostty:x` →
 *  `custom:ghostty-x`). Same rule as `copy_stem` in theme_import.rs, which
 *  names the file. */
export function copyIdOf(importId: `custom:${string}`): `custom:${string}` {
  return `custom:${importId.slice("custom:".length).replace(":", "-")}`;
}

function pickAllowlisted(
  raw: unknown,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (isValidColor(value)) out[key] = value.trim();
  }
  return out;
}

/** Validate a raw theme file into the in-app shape. Never throws: unknown
 *  keys and malformed color values are dropped, a missing/odd colorScheme
 *  falls back to "dark", a missing name falls back to the file stem. */
export function sanitizeTheme(file: CustomThemeFile): CustomTheme {
  const slug = String(file.id ?? "").trim() || "theme";
  const name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : slug;
  return {
    id: `custom:${slug}`,
    name,
    colorScheme: file.colorScheme === "light" ? "light" : "dark",
    ui: pickAllowlisted(file.ui, UI_KEYS),
    terminal: pickAllowlisted(file.terminal, TERMINAL_KEYS),
  };
}

/** Validate a Ghostty / Warp import (`themes_imports`) into the in-app
 *  shape, with its chrome derived from the palette. One palette serves both
 *  halves: `bases` (TERMINAL_THEMES) fills what the import lacks, and the
 *  chrome derives from that same full palette. The result is final, with
 *  the file's own `ui` (a Warp accent) only an input, so it is also exactly
 *  what gets written as the native copy when the import is picked. */
export function sanitizeImport(
  file: CustomThemeFile,
  bases: Record<ColorScheme, Record<string, string>>,
): CustomTheme {
  const base = sanitizeTheme(file);
  const bg = parseHex(base.terminal.background);
  const scheme: ColorScheme = bg && luminance(bg) > LIGHT_BG ? "light" : "dark";
  const full = pickAllowlisted({ ...bases[scheme], ...base.terminal }, TERMINAL_KEYS);
  const derived = deriveChrome(full, base.ui.accent);
  return { ...base, colorScheme: derived.colorScheme, ui: pickAllowlisted(derived.ui, UI_KEYS), terminal: full };
}

// ── Chrome derivation for imported themes ────────────────────────────────
// Ghostty and Warp themes are a terminal palette and nothing else. Falling
// back to the Dark+ chrome would put Monokai terminals inside Dark+ panels,
// so every chrome key is derived from the palette instead: surfaces step
// from the background toward the foreground (lighter on dark themes, darker
// on light ones, the same elevation direction as the built-ins), text tiers
// mix the foreground back toward the background, and the status / palette
// hues come straight from the ANSI colors.

type RGB = [number, number, number];

/** Parse #rgb / #rrggbb (alpha ignored). theme_import.rs only passes hex,
 *  so null means a key the palette did not have. */
function parseHex(c: string | undefined): RGB | null {
  const m = c?.trim().match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h.slice(0, 3)].map(x => x + x).join("");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

const toHex = (c: RGB) => "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
/** `t` of the way from a to b. */
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t) as RGB;
const rgba = (c: RGB, alpha: number) => `rgba(${c.map(Math.round).join(", ")}, ${alpha})`;

/** WCAG relative luminance. */
function luminance(c: RGB): number {
  const [r, g, b] = c.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Background luminance above which a palette reads as a light theme. */
const LIGHT_BG = 0.4;

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const chroma = (c: RGB) => Math.max(...c) - Math.min(...c);

/** Ink for text sitting on a solid `fill`: whichever end of the theme's own
 *  fg / bg pair reads better. Plain white loses on mid-light fills like
 *  Monokai's cyan, where the theme's dark background reads far better. */
const inkOn = (fill: RGB, bg: RGB, fg: RGB): RGB =>
  contrast(fill, bg) >= contrast(fill, fg) ? bg : fg;

/** Pull `c` toward `toward` until it reaches `min` contrast against `bg`.
 *  Terminal palettes are tuned for their own background at text weight,
 *  but a light theme's yellow or cyan used as UI text on near-white is
 *  often under 2:1. 3:1 is the WCAG floor for UI components and large text. */
function withContrast(c: RGB, bg: RGB, toward: RGB, min = 3): RGB {
  let out = c;
  for (let t = 0.1; contrast(out, bg) < min && t <= 1; t += 0.1) out = mix(c, toward, t);
  return out;
}

export function deriveChrome(
  terminal: Record<string, string>,
  accentOverride?: string,
): { colorScheme: ColorScheme; ui: Record<string, string> } {
  // the fallbacks only matter for a direct call: sanitizeImport hands over a
  // palette already filled from the terminal's base
  const bg = parseHex(terminal.background) ?? [0, 0, 0];
  const fg = parseHex(terminal.foreground) ?? [255, 255, 255];
  const colorScheme: ColorScheme = luminance(bg) > LIGHT_BG ? "light" : "dark";
  const dark = colorScheme === "dark";
  // every hue below is also used as text on the chrome background
  const ansi = (k: string, fallback: RGB): RGB => withContrast(parseHex(terminal[k]) ?? fallback, bg, fg);
  const red = ansi("red", [239, 83, 80]);
  const green = ansi("green", [76, 175, 80]);
  const yellow = ansi("yellow", [240, 177, 58]);
  const blue = ansi("blue", [66, 133, 244]);
  const magenta = ansi("magenta", [171, 71, 188]);
  const cyan = ansi("cyan", [38, 166, 154]);

  // ponytail: accent = the most saturated of blue / magenta / cyan. A theme's
  // "brand" color is not knowable from a palette; this just avoids picking a
  // greyed-out ANSI slot. Warp themes supply a real accent and skip this.
  const accent = withContrast(
    parseHex(accentOverride) ?? [blue, magenta, cyan].reduce((best, c) => (chroma(c) > chroma(best) ? c : best)),
    bg, fg,
  );

  // surfaces step toward fg; light themes need a slightly bigger step to
  // read, since the eye is less sensitive to small changes near white
  const step = dark ? 1 : 1.3;
  const ui: Record<string, string> = {
    bg: toHex(bg),
    "bg-1": toHex(mix(bg, fg, 0.04 * step)),
    "bg-2": toHex(mix(bg, fg, 0.07 * step)),
    "bg-3": toHex(mix(bg, fg, 0.12 * step)),
    fg: toHex(fg),
    "fg-dim": toHex(mix(fg, bg, 0.3)),
    "fg-faint": toHex(mix(fg, bg, 0.52)),
    border: toHex(mix(bg, fg, 0.17 * step)),
    "border-soft": toHex(mix(bg, fg, 0.09 * step)),
    hover: rgba(fg, dark ? 0.045 : 0.05),
    sel: rgba(accent, 0.22),
    accent: toHex(accent),
    "accent-soft": rgba(accent, 0.22),
    // filled buttons draw hardcoded `text-white` on accent-deep (27 sites),
    // so it has to carry white text whatever the theme's accent is
    "accent-deep": toHex(withContrast(accent, [255, 255, 255], [0, 0, 0], 4.5)),
    "accent-fg": toHex(inkOn(accent, bg, fg)),
    ok: toHex(green),
    "ok-fg": toHex(inkOn(green, bg, fg)),
    warn: toHex(yellow),
    err: toHex(red),
    "palette-red": toHex(red),
    "palette-orange": toHex(mix(red, yellow, 0.5)),
    "palette-yellow": toHex(yellow),
    "palette-green": toHex(green),
    "palette-teal": toHex(cyan),
    "palette-blue": toHex(blue),
    "palette-purple": toHex(magenta),
    "palette-pink": toHex(mix(red, magenta, 0.5)),
  };
  return { colorScheme, ui };
}

/** Push a custom theme's UI colors as inline vars on <html>. Inline style
 *  beats the @theme defaults in the cascade, so a partial theme falls back
 *  to Dark+ per-key automatically. Iterates the full allowlist (set or
 *  remove) so switching between two custom themes can't leave a stale var
 *  from the previous one. */
export function applyCustomVars(html: HTMLElement, ui: Record<string, string>) {
  for (const key of UI_KEYS) {
    if (ui[key]) html.style.setProperty(`--color-${key}`, ui[key]);
    else html.style.removeProperty(`--color-${key}`);
  }
}

/** Deterministic clear: remove every var we could have set. Called when
 *  switching back to a built-in theme (the likeliest regression path). */
export function clearCustomVars(html: HTMLElement) {
  for (const key of UI_KEYS) html.style.removeProperty(`--color-${key}`);
}

/** Custom terminal palette = built-in base with the theme's (already
 *  sanitized) overrides on top, so a partial `terminal` block still yields
 *  a complete, readable ANSI 16. */
export function mergeTerminal(
  base: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  return { ...base, ...overrides };
}

// ── First-paint cache ────────────────────────────────────────────────────
// applyTheme runs synchronously at module load, before any IPC can answer.
// The active custom theme's full payload lives in localStorage so the first
// paint applies it directly; the async themes_list fetch reconciles after
// (file edited → re-apply, file deleted → fall back to the default theme).
// Without this every launch would flash Dark+ → custom.

const LS_CUSTOM_THEME_CACHE = "customThemeCache";

export function readThemeCache(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(LS_CUSTOM_THEME_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown } & CustomThemeFile;
    if (typeof parsed?.id !== "string" || !isCustomId(parsed.id)) return null;
    // Re-sanitize on read: the cache is just localStorage, treat it as
    // untrusted input like the files themselves.
    return sanitizeTheme({ ...parsed, id: parsed.id.slice("custom:".length) });
  } catch {
    return null;
  }
}

export function writeThemeCache(theme: CustomTheme) {
  try { localStorage.setItem(LS_CUSTOM_THEME_CACHE, JSON.stringify(theme)); } catch {}
}

export function clearThemeCache() {
  try { localStorage.removeItem(LS_CUSTOM_THEME_CACHE); } catch {}
}
