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
