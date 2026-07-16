// User-visible UI preferences (separate from app data and transient UI state).
// Persisted to localStorage so they survive launches. Currently just the mono
// font, but built for future things (themes, terminal opacity, etc.).

import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listFontFamilies, listMonospaceFonts, themesList } from "@/lib/ipc";
import {
  applyCustomVars, clearCustomVars, clearThemeCache, isCustomId, mergeTerminal,
  readThemeCache, sanitizeTheme, writeThemeCache, type CustomTheme,
} from "@/lib/customTheme";
import {
  DEFAULT_BINDINGS,
  type Binding,
  type BindingMap,
  type ShortcutId,
} from "@/lib/shortcuts";
import {
  DEFAULT_COMPLETION_SOUND_ID,
  LS_COMPLETION_SOUND,
  LS_COMPLETION_SOUND_ID,
  isCompletionSoundId,
  readCompletionSoundEnabled,
  readCompletionSoundId,
  type CompletionSoundId,
} from "@/lib/notificationSounds";

const LS_EDITOR_FONT   = "editorFont";
const LS_EDITOR_THEME  = "editorThemeId";
const LS_TERMINAL_FONT = "terminalFont";
const LS_TERMINAL_SIZE = "terminalFontSize";
const LS_EDITOR_SIZE   = "editorFontSize";
const LS_LIGATURES     = "codeLigatures";
const LS_THEME         = "themeMode";
const LS_DESKTOPNOTIF  = "desktopNotifications";
const LS_SETTLED_HIGHLIGHT = "settledHighlight";
const LS_CONFIRM_CLOSE_AGENT_TAB = "confirmBeforeCloseAgentTab";
const LS_WORKING_INDICATOR = "workingIndicator";
const LS_DEFAULT_SANDBOX = "globalDefaultSandbox";
const LS_SANDBOX_BYPASS  = "sandboxBypassPermissions";
const LS_ALLOW_SCOPE     = "sandboxAllowScope";
const LS_TERMINAL_LETTERSPACING = "terminalLetterSpacing";
const LS_TERMINAL_SCROLLBACK   = "terminalScrollback";
const LS_TERMINAL_OPTION_AS_META = "terminalOptionAsMeta";
const LS_TERMINAL_GPU            = "terminalGpuEnabled";
const LS_TERMINAL_COPY_ON_SELECT = "terminalCopyOnSelect";
const LS_TASK_EXPAND_MODE = "taskExpandMode";
const LS_HIDE_INACTIVE_PROJECTS = "hideInactiveProjects";
const LS_MD_VIEW       = "markdownDefaultView";
const LS_LOAD_REMOTE_IMAGES = "loadRemoteImages";
const LS_BRANCH_PREFIX = "branchPrefix";
const LS_QUEUE_MIN_INTERVAL = "queueMinIntervalMs";
const LS_SHORTCUTS     = "shortcutBindings";
const LS_PANE_DIM      = "splitPaneDim";
const LS_PANE_DIM_AMT  = "splitPaneDimAmount";
const LS_UI_SCALE      = "uiScale";

/** UI zoom bounds (percent). The whole webview is scaled via the CSS
 *  `zoom` property, so these are browser-zoom-style limits. */
const UI_SCALE_MIN = 50;
const UI_SCALE_MAX = 200;
const UI_SCALE_STEP = 10;
const clampUiScale = (pct: number): number =>
  Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(pct)));

/** Markdown edit-tab view: source editor, rendered preview, or both. */
export type MarkdownView = "source" | "preview" | "split";

export type BuiltinThemeMode = "auto" | "light" | "dark" | "claude" | "solarized" | "cobalt" | "matrix" | "rosepine";
/** The user's selection: a built-in mode, or a custom theme file id
 *  (`custom:<file-stem>`, see lib/customTheme.ts). */
export type ThemeMode = BuiltinThemeMode | `custom:${string}`;
/** What `applyTheme` resolves a BUILT-IN mode to: a concrete palette name.
 *  `auto` is never returned; it gets mapped to light/dark based on OS
 *  preference. Custom ids resolve to themselves (see resolveThemeFull). */
export type ResolvedTheme = "light" | "dark" | "claude" | "solarized" | "cobalt" | "matrix" | "rosepine";

const VALID_MODES: ReadonlyArray<BuiltinThemeMode> = ["auto", "light", "dark", "claude", "solarized", "cobalt", "matrix", "rosepine"];
/** Defensive parse: localStorage may hold a theme id that's been
 *  removed in a later version. Fall back to "claude" (the default
 *  theme) instead of letting the unknown string flow through and
 *  silently land on the @theme default. NOTE: this also migrates the
 *  old "vscode" id for free — that theme was renamed to "claude", and
 *  any stale "vscode" string lands here and resolves to it. A custom id
 *  is only trusted when the first-paint cache holds its payload (the
 *  cache is written on every custom pick, so a cache miss means the
 *  theme can't be painted anyway — the startup refetch would just
 *  bounce it back to the fallback). */
function parseThemeMode(raw: string): ThemeMode {
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as ThemeMode;
  if (isCustomId(raw) && readThemeCache()?.id === raw) return raw;
  return "claude";
}

/** xterm theme objects keyed by resolved palette. Each must define enough
 *  of xterm's ITheme that the terminal looks at home in the surrounding
 *  chrome. ANSI 16 colors stay close to the parent palette's family so a
 *  `ls --color` looks consistent with the app's surface colors. */
export const TERMINAL_THEMES: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    background: "#0b0b0d",
    foreground: "#eceef1",
    cursor: "#d97757",
    cursorAccent: "#0b0b0d",
    selectionBackground: "rgba(51,117,240,0.75)",
    black: "#1a1a1d", red: "#ef5350", green: "#4caf50", yellow: "#f0b13a",
    blue: "#4c8bf5", magenta: "#c084fc", cyan: "#22d3ee", white: "#eceef1",
    brightBlack: "#6e747e", brightRed: "#ff6b66", brightGreen: "#7cd57e", brightYellow: "#ffd166",
    brightBlue: "#7fb1ff", brightMagenta: "#d7a4ff", brightCyan: "#67e8f9", brightWhite: "#ffffff",
  },
  claude: {
    // "Claude" — terax-ai's warm-charcoal palette (formerly id "vscode").
    background: "#1f1e1d",
    foreground: "#f5f4ee",
    cursor: "#d97757",
    cursorAccent: "#1f1e1d",
    selectionBackground: "rgba(51,117,240,0.75)",
    black: "#1a1918", red: "#ef5350", green: "#4caf50", yellow: "#f0b13a",
    blue: "#4c8bf5", magenta: "#c084fc", cyan: "#22d3ee", white: "#f5f4ee",
    brightBlack: "#6e747e", brightRed: "#ff6b66", brightGreen: "#7cd57e", brightYellow: "#ffd166",
    brightBlue: "#7fb1ff", brightMagenta: "#d7a4ff", brightCyan: "#67e8f9", brightWhite: "#ffffff",
  },
  light: {
    background: "#faf9f6",
    foreground: "#1c1b1a",
    cursor: "#c25e3d",
    cursorAccent: "#faf9f6",
    selectionBackground: "rgba(51,117,240,0.40)",
    black: "#2b2926", red: "#b3322a", green: "#3f8a3f", yellow: "#a17415",
    blue: "#2c5fb3", magenta: "#7a3aa5", cyan: "#1c7c8e", white: "#3f3d3a",
    brightBlack: "#55534f", brightRed: "#d9453d", brightGreen: "#52a352", brightYellow: "#b88a26",
    brightBlue: "#3a7bd9", brightMagenta: "#9358c2", brightCyan: "#1f97ad", brightWhite: "#1c1b1a",
  },
  solarized: {
    // Solarized Dark canonical ANSI mapping (Ethan Schoonover).
    background: "#002b36",       // base03
    foreground: "#93a1a1",       // base1
    cursor: "#cb4b16",           // orange (canonical solarized cursor)
    cursorAccent: "#002b36",
    selectionBackground: "rgba(30,138,204,0.75)",
    black:   "#073642", red:     "#dc322f", green:   "#859900", yellow:  "#b58900",
    blue:    "#268bd2", magenta: "#d33682", cyan:    "#2aa198", white:   "#eee8d5",
    brightBlack:   "#586e75", brightRed:     "#cb4b16", brightGreen:   "#586e75", brightYellow:  "#657b83",
    brightBlue:    "#839496", brightMagenta: "#6c71c4", brightCyan:    "#93a1a1", brightWhite:   "#fdf6e3",
  },
  cobalt: {
    // Wes Bos / iTerm "Cobalt 2". Deep navy + bright accents; the
    // signature yellow cursor on dark blue is what makes it Cobalt.
    background: "#193549",
    foreground: "#e1efff",
    cursor: "#ffc600",
    cursorAccent: "#193549",
    selectionBackground: "rgba(255,198,0,0.45)",
    black: "#234a6a", red:     "#ff628c", green:   "#3ad900", yellow:  "#ffc600",
    blue:  "#9effff", magenta: "#fb94ff", cyan:    "#80ffbb", white:   "#e1efff",
    brightBlack: "#5a91b1", brightRed:     "#ff7da3", brightGreen:   "#5eea2e", brightYellow:  "#ffd54a",
    brightBlue:  "#b3ffff", brightMagenta: "#ffaaff", brightCyan:    "#a4ffd4", brightWhite:   "#ffffff",
  },
  matrix: {
    // Calmer Matrix - green where it matters (the agent's text + cursor)
    // but ANSI 16 keeps full contrast so git log / diffs stay readable.
    // The chrome (CSS vars) uses warm off-white gray; this terminal
    // palette is what the agent actually paints, kept slightly greener
    // for the CRT vibe without going full neon.
    background: "#050905",
    foreground: "#c8e1c0",
    cursor: "#3fb950",
    cursorAccent: "#050905",
    selectionBackground: "rgba(63,185,80,0.45)",
    black:   "#0d130d", red:     "#e07070", green:   "#3fb950", yellow:  "#d4c750",
    blue:    "#5a9fd6", magenta: "#c075c0", cyan:    "#50b0a8", white:   "#c8e1c0",
    brightBlack:   "#5a6058", brightRed:     "#e88a8a", brightGreen:   "#5fd06e", brightYellow:  "#e0d670",
    brightBlue:    "#7eb5e6", brightMagenta: "#d090d0", brightCyan:    "#70c8c0", brightWhite:   "#e8f0e0",
  },
  rosepine: {
    // Rosé Pine (main) — official ANSI mapping (matches Ghostty's built-in),
    // so agent TUIs look identical in termic and Ghostty. Brights stay equal
    // to normals except brightBlack=muted, per the official spec. Cursor
    // follows the termic convention of accent-colored cursors (rose, same
    // as the chrome accent); the official spec uses highlightHigh #524f67
    // if rose feels loud.
    background: "#191724",           // base
    foreground: "#e0def4",           // text
    cursor: "#ebbcba",               // rose — matches chrome accent
    cursorAccent: "#191724",
    selectionBackground: "#403d52",  // highlightMed (matches Ghostty)
    black: "#26233a",  red: "#eb6f92",     green: "#31748f",  yellow: "#f6c177",
    blue: "#9ccfd8",   magenta: "#c4a7e7", cyan: "#ebbcba",   white: "#e0def4",
    brightBlack: "#6e6a86", brightRed: "#eb6f92", brightGreen: "#31748f", brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",  brightMagenta: "#c4a7e7", brightCyan: "#ebbcba", brightWhite: "#e0def4",
  },
};

/** Look up a custom theme's payload by its `custom:<slug>` id. The store's
 *  fetched list wins; before the first themes_list answer (module load,
 *  first paint) we fall back to the localStorage cache of the active theme. */
function customThemeById(id: string): CustomTheme | null {
  const fromStore = usePrefs.getState().customThemes.find(t => t.id === id);
  if (fromStore) return fromStore;
  const cached = readThemeCache();
  return cached && cached.id === id ? cached : null;
}

/** Resolve the user's chosen theme to a concrete xterm palette. Custom
 *  themes merge their (sanitized) terminal overrides onto the built-in
 *  base matching their colorScheme, so a partial block stays readable. */
export function currentTerminalTheme(): Record<string, string> {
  const resolved = resolveThemeFull(usePrefs.getState().themeMode);
  if (isCustomId(resolved)) {
    const theme = customThemeById(resolved);
    if (!theme) return TERMINAL_THEMES.dark;
    const base = TERMINAL_THEMES[theme.colorScheme === "light" ? "light" : "dark"];
    return mergeTerminal(base, theme.terminal);
  }
  return TERMINAL_THEMES[resolved];
}

/** COLORFGBG is the long-standing convention agents (claude / gemini /
 *  codex) use to pick their TUI theme without a manual flag. Format is
 *  `fg;bg` where each is an ANSI color number; tools just check whether
 *  the bg value is "light" (1-6, 7, 15) or "dark" (0, 8, 16+). We emit
 *  conservative values - `0;15` (black on white) for light, `15;0`
 *  (white on black) for any dark-family palette. Set this on every
 *  PTY spawn alongside TERMIC_PORT etc. */
export function currentColorFgBg(): string {
  return resolveTheme(usePrefs.getState().themeMode) === "light" ? "0;15" : "15;0";
}

/** Minimum foreground/background contrast for the terminal (xterm's
 *  `minimumContrastRatio`). TERMINAL_THEMES only remaps the 16 indexed ANSI
 *  colors, so a CLI TUI themed for a dark background (Claude Code, gemini,
 *  codex) paints near-white *truecolor* fg that COLORFGBG can't redirect —
 *  invisible on a light terminal bg (#83). xterm darkens any fg below the
 *  ratio against its actual cell bg at paint time, which catches truecolor
 *  too. Only light-family palettes need it (dark themes already sit on a
 *  dark bg); 1 = off, a no-op with zero render cost. 4.5 = WCAG AA, the same
 *  default VS Code's integrated terminal ships. */
export function currentMinimumContrastRatio(): number {
  return resolveTheme(usePrefs.getState().themeMode) === "light" ? 4.5 : 1;
}

// Curated list of monospace fonts we probe for. JetBrains Mono ships
// locally via @fontsource so it's always present; the rest are detected at
// runtime via document.fonts.check(). We don't enumerate the system font
// catalog (WKWebView has no API for it) — this list covers ~95% of what real
// devs install. Add yours here if missing.
export const MONO_FONT_OPTIONS: { id: string; label: string; stack: string }[] = [
  { id: "jetbrains",     label: "JetBrains Mono",        stack: `"JetBrains Mono", monospace` },
  { id: "sfmono",        label: "SF Mono",               stack: `"SF Mono", ui-monospace, monospace` },
  { id: "menlo",         label: "Menlo",                 stack: `Menlo, monospace` },
  { id: "monaco",        label: "Monaco",                stack: `Monaco, monospace` },
  { id: "firacode",      label: "Fira Code",             stack: `"Fira Code", monospace` },
  { id: "firamono",      label: "Fira Mono",             stack: `"Fira Mono", monospace` },
  { id: "cascadiacode",  label: "Cascadia Code",         stack: `"Cascadia Code", monospace` },
  { id: "cascadiamono",  label: "Cascadia Mono",         stack: `"Cascadia Mono", monospace` },
  { id: "hack",          label: "Hack",                  stack: `Hack, monospace` },
  { id: "sourcecodepro", label: "Source Code Pro",       stack: `"Source Code Pro", monospace` },
  { id: "ibmplex",       label: "IBM Plex Mono",         stack: `"IBM Plex Mono", monospace` },
  { id: "geist",         label: "Geist Mono",            stack: `"Geist Mono", monospace` },
  { id: "iosevka",       label: "Iosevka",               stack: `Iosevka, monospace` },
  { id: "iosevkaterm",   label: "Iosevka Term",          stack: `"Iosevka Term", monospace` },
  { id: "iosevkanf",     label: "Iosevka Nerd Font",     stack: `"Iosevka Nerd Font", monospace` },
  { id: "victormono",    label: "Victor Mono",           stack: `"Victor Mono", monospace` },
  { id: "operatormono",  label: "Operator Mono",         stack: `"Operator Mono", monospace` },
  { id: "monolisa",      label: "MonoLisa",              stack: `MonoLisa, monospace` },
  { id: "berkeleymono",  label: "Berkeley Mono",         stack: `"Berkeley Mono", monospace` },
  { id: "commitmono",    label: "Commit Mono",           stack: `"Commit Mono", monospace` },
  { id: "comicmono",     label: "Comic Mono",            stack: `"Comic Mono", monospace` },
  { id: "comicshanns",   label: "Comic Shanns Mono",     stack: `"Comic Shanns Mono", monospace` },
  { id: "inconsolata",   label: "Inconsolata",           stack: `Inconsolata, monospace` },
  { id: "ubuntumono",    label: "Ubuntu Mono",           stack: `"Ubuntu Mono", monospace` },
  { id: "robotomono",    label: "Roboto Mono",           stack: `"Roboto Mono", monospace` },
  { id: "spacemono",     label: "Space Mono",            stack: `"Space Mono", monospace` },
  { id: "anonymouspro",  label: "Anonymous Pro",         stack: `"Anonymous Pro", monospace` },
  { id: "dejavusansmono",label: "DejaVu Sans Mono",      stack: `"DejaVu Sans Mono", monospace` },
  { id: "ptmono",        label: "PT Mono",               stack: `"PT Mono", monospace` },
  { id: "courierprime",  label: "Courier Prime",         stack: `"Courier Prime", monospace` },
  { id: "courier",       label: "Courier",               stack: `Courier, monospace` },
  { id: "couriernew",    label: "Courier New",           stack: `"Courier New", monospace` },
  { id: "consolas",      label: "Consolas",              stack: `Consolas, monospace` },
  { id: "lucidaconsole", label: "Lucida Console",        stack: `"Lucida Console", monospace` },
  { id: "andalemono",    label: "Andale Mono",           stack: `"Andale Mono", monospace` },
  { id: "monoid",        label: "Monoid",                stack: `Monoid, monospace` },
  { id: "monofur",       label: "Monofur",               stack: `Monofur, monospace` },
  { id: "anonymice",     label: "AnonymicePro Nerd Font", stack: `"AnonymicePro Nerd Font", monospace` },
  { id: "hasklig",       label: "Hasklig",               stack: `Hasklig, monospace` },
  { id: "input",         label: "Input Mono",            stack: `"Input Mono", monospace` },
  { id: "monaspaceneon", label: "Monaspace Neon",        stack: `"Monaspace Neon", monospace` },
  { id: "monaspaceradon",label: "Monaspace Radon",       stack: `"Monaspace Radon", monospace` },
  { id: "monaspaceargon",label: "Monaspace Argon",       stack: `"Monaspace Argon", monospace` },
  { id: "monaspacekrypton",label:"Monaspace Krypton",    stack: `"Monaspace Krypton", monospace` },
  { id: "monaspacexenon",label: "Monaspace Xenon",       stack: `"Monaspace Xenon", monospace` },
  { id: "intel",         label: "Intel One Mono",        stack: `"Intel One Mono", monospace` },
  // Meslo + the Powerline / Nerd Font patched variants — popular in iTerm2 setups.
  { id: "meslolgs",      label: "Meslo LG S",            stack: `"Meslo LG S", monospace` },
  { id: "meslolgm",      label: "Meslo LG M",            stack: `"Meslo LG M", monospace` },
  { id: "meslolgl",      label: "Meslo LG L",            stack: `"Meslo LG L", monospace` },
  { id: "meslolgsnf",    label: "MesloLGS NF",           stack: `"MesloLGS NF", "MesloLGS Nerd Font", monospace` },
  { id: "meslolgmnf",    label: "MesloLGM NF",           stack: `"MesloLGM NF", "MesloLGM Nerd Font", monospace` },
  { id: "meslolglnf",    label: "MesloLGL NF",           stack: `"MesloLGL NF", "MesloLGL Nerd Font", monospace` },
  { id: "meslopl",       label: "Meslo LG S for Powerline", stack: `"Meslo LG S for Powerline", monospace` },
];


/** The one font guaranteed on every install — ships with the app as a
 *  webfont (@fontsource), so the OS font catalog never sees it and the
 *  installed-only filter must exempt it explicitly. Exported so the picker
 *  can render it in its own "Bundled" optgroup. */
export const BUNDLED_FONT_ID = "jetbrains";

// CSS generic family keywords — never real installed families, so they
// don't participate in the installed check.
const CSS_GENERIC_FAMILIES = new Set(["monospace", "ui-monospace"]);

/** Concrete (non-generic) family names in a CSS stack, lowercased. */
function stackFamiliesLower(stack: string): string[] {
  return stack.split(",")
    .map(f => f.trim().replace(/^"|"$/g, ""))
    .filter(f => f && !CSS_GENERIC_FAMILIES.has(f.toLowerCase()))
    .map(f => f.toLowerCase());
}

/** Label-sort (case-insensitive) with the bundled default pinned first. */
export function sortFontOptions(list: typeof MONO_FONT_OPTIONS): typeof MONO_FONT_OPTIONS {
  return [...list].sort((a, b) => {
    if (a.id === BUNDLED_FONT_ID) return -1;
    if (b.id === BUNDLED_FONT_ID) return 1;
    return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
  });
}

/** Pure core of availableMonoFontsAsync, split out for tests.
 *
 *  - installedFamilies: every family the OS reports (unfiltered — lib.rs
 *    list_font_families)
 *  - monospaceFamilies: the is_monospace()-filtered subset (lib.rs
 *    list_monospace_fonts), which becomes the `system:` extras
 *
 *  A curated entry survives only when one of its concrete families is
 *  installed (case-insensitive). Exemptions:
 *  - the bundled JetBrains Mono: a webfont, invisible to the OS catalog
 *  - stacks leaning on the `ui-monospace` generic: stock macOS registers
 *    SF Mono only as a hidden dot-family the catalog can't vouch for, but
 *    the generic resolves to it anyway
 *  - installedFamilies empty (enumeration failed / not settled yet):
 *    filtering is skipped rather than hiding everything
 *
 *  Extras dedup checks ALL families of each kept entry, not just the
 *  first — an entry kept via a fallback name ("MesloLGS NF" installed as
 *  "MesloLGS Nerd Font") must not reappear as a system: duplicate. */
export function mergeFontOptions(
  curated: typeof MONO_FONT_OPTIONS,
  installedFamilies: string[],
  monospaceFamilies: string[],
): typeof MONO_FONT_OPTIONS {
  const installed = new Set(installedFamilies.map(n => n.toLowerCase()));
  const kept = installed.size === 0 ? curated : curated.filter(o =>
    o.id === BUNDLED_FONT_ID ||
    /\bui-monospace\b/i.test(o.stack) ||
    stackFamiliesLower(o.stack).some(f => installed.has(f))
  );
  const covered = new Set(kept.flatMap(o => stackFamiliesLower(o.stack)));
  const extras = monospaceFamilies
    .filter(name => !covered.has(name.toLowerCase()))
    .map(name => ({
      id: `system:${name}`,
      label: name,
      stack: `"${name}", monospace`,
    }));
  return sortFontOptions([...kept, ...extras]);
}

/** The curated list, unfiltered but display-sorted. Synchronous fallback so
 *  the picker renders instantly; availableMonoFontsAsync() replaces it with
 *  the installed-only list once font-kit answers. No webview-side installed
 *  detection here: canvas probing proved unreliable in WKWebView for faces
 *  with unusual naming (dropped Meslo on macs that clearly had it) — the
 *  Rust enumeration is the only trusted source. */
export function availableMonoFonts() {
  return sortFontOptions(MONO_FONT_OPTIONS);
}

// Process-wide caches for the Rust-enumerated lists. Populated by the first
// successful availableMonoFontsAsync() call, kept until the app exits.
let _systemFontsCache: string[] | null = null;
let _familiesCache: string[] | null = null;

/** Returns the curated entries whose font is actually installed, MERGED with
 *  every monospace font Rust finds via font-kit. Fonts not in the curated map
 *  get an auto-generated entry (id = "system:<name>", label = family name,
 *  stack = family). Sorted for display (bundled default first, then A→Z). */
export async function availableMonoFontsAsync(): Promise<typeof MONO_FONT_OPTIONS> {
  let system = _systemFontsCache;
  let families = _familiesCache;
  if (!system || !families) {
    // Failures are NOT cached: an enumeration that dies (e.g. fired before
    // the IPC bridge settles) must retry on the next call, not permanently
    // hide every system font behind an empty cached list.
    try {
      [system, families] = await Promise.all([listMonospaceFonts(), listFontFamilies()]);
      _systemFontsCache = system;
      _familiesCache = families;
    } catch {
      // Both caches are only ever set together, so reaching here means
      // neither list is available — empty lists make mergeFontOptions
      // skip filtering entirely rather than hide everything.
      system = [];
      families = [];
    }
  }
  return mergeFontOptions(MONO_FONT_OPTIONS, families, system);
}

/** Resolve a font id → CSS font-family stack, defaulting to JetBrains.
 *  Handles both curated ids and the `system:<family>` ids produced by
 *  availableMonoFontsAsync() — those never appear in MONO_FONT_OPTIONS,
 *  so without the prefix branch every system-enumerated pick silently
 *  fell back to the bundled JetBrains Mono (latin subset, no Nerd Font
 *  glyphs). */
export function stackFor(id: string) {
  if (id.startsWith("system:")) return `"${id.slice(7)}", monospace`;
  const opt = MONO_FONT_OPTIONS.find(o => o.id === id) || MONO_FONT_OPTIONS[0];
  return opt.stack;
}

interface PrefsState {
  /** Send OS notifications when an inactive tab's agent settles (output
   *  stopped changing). OFF by default — too noisy for many users. */
  desktopNotifications: boolean;
  /** Play a selectable notification sound when an inactive agent finishes
   *  a turn. OFF by default. */
  completionSound: boolean;
  /** Which notification sound to use when completion sound is enabled.
   *  Defaults to the app's default sound. */
  completionSoundId: CompletionSoundId;
  /** Highlight tasks / tabs whose agent has just settled (idle).
   *  ON by default — the brand-color icon swap on settle is the
   *  in-app "done" signal. Some users find it distracting and want
   *  the sidebar to stay calm regardless. */
  settledHighlight: boolean;
  /** Whether closing a non-shell terminal/agent tab asks for confirmation
   *  first. ON by default. Once the "+" menu's Resume section makes
   *  undoing a close one click away, users who've learned that can turn
   *  this off via the dialog's "Don't ask again" checkbox — closing then
   *  happens immediately, with a toast pointing back at Resume. Dirty
   *  edit-tab closes are never gated by this; that confirm always fires. */
  confirmBeforeCloseAgentTab: boolean;
  /** Show a spinner on an agent's tab (and sidebar icon) WHILE it's
   *  working. OFF by default — experimental. The "working" workState is
   *  always tracked internally to drive work-done detection; this pref only
   *  controls whether it's surfaced. Work detection can occasionally get a
   *  signal stuck, so TerminalPane has an absolute ceiling that force-clears
   *  a stale "working" state regardless of sender signals. */
  workingIndicator: boolean;
  /** Gates remote (http/https) images in the markdown preview. OFF by
   *  default: the webview sits outside the seatbelt + CONNECT proxy cage,
   *  so an `<img src="https://...">` fires an unprompted GET to whatever
   *  host untrusted markdown names (prompt injection, a dependency's
   *  README, a contributor's fork) — see docs/sandbox.md, "Known gap: the
   *  webview is outside the cage". A per-document affordance in the
   *  preview can unblock a single file without flipping this pref. */
  loadRemoteImages: boolean;
  /** Default for the NewTaskDialog's Sandbox toggle when neither
   *  the project's `default_sandbox` nor an explicit user pick is in
   *  effect. Lets a single-keystroke toggle apply across all projects
   *  without per-project bookkeeping. */
  globalDefaultSandbox: boolean;
  /** When a task is sandboxed, auto-pass the agent's "bypass
   *  permissions" (YOLO) flag at spawn even if the YOLO toggle is off.
   *  ON by default: the seatbelt cage is the real security boundary, so
   *  the agent's own permission prompts are just friction. Users who
   *  still want the agent to ask inside a sandbox can turn this off. */
  sandboxBypassPermissions: boolean;
  /** Where the "Allow" button in the sandbox activity/blocked popover
   *  writes. `null` until the user picks once (the radio is mandatory
   *  on first use); their choice then becomes the app-wide default.
   *  - "agent"   → the agent registry (every task using that CLI)
   *  - "project" → this project's personal defaults (projects.json)
   *  - "repo"    → the committed `.termic.yaml` (team-shared) */
  allowScope: "agent" | "project" | "repo" | null;
  /** Color scheme: explicit dark/light, auto = follow system, or a
   *  `custom:<slug>` theme file id. */
  themeMode: ThemeMode;
  /** Sanitized custom themes from `<data_dir>/themes/*.json`. Fetched at
   *  startup and re-fetched every time the theme picker opens (no fs
   *  watcher — the dir is tiny and the command is async). The reference
   *  only changes when the on-disk content actually changed, so
   *  subscribers don't re-render on every picker hover. */
  customThemes: CustomTheme[];
  /** Bumped when the ACTIVE custom theme's payload changed on a refetch
   *  (file edited while selected). Terminal panes key their live-swap
   *  effect on this so an edit updates xterm without a theme re-pick. */
  customThemeRev: number;
  /** Font for the CodeMirror editor + diff viewer. */
  editorFontId: string;
  /** Syntax theme for the editor + diff viewer (atomone, tokyo-night, …).
   *  Independent of the app `themeMode` — the surface still tracks the
   *  app palette, only the token colors come from this. */
  editorThemeId: string;
  /** Font for the xterm terminals (main + aux). Kept separate because power
   *  users often want a Nerd Font for the shell but a clean prose-friendly
   *  font for the editor. */
  terminalFontId: string;
  /** xterm font size in px. Editor size is currently fixed at 13. */
  terminalFontSize: number;
  /** Extra pixels added to each xterm cell's advance. xterm.js measures
   *  the natural glyph advance and rounds to integer px, which produces
   *  a tighter cell than iTerm/Terminal.app at the same font. Bumping
   *  to 1 or 2 px adds the cushion. Integer only — fractional values
   *  misalign the WebGL atlas. */
  terminalLetterSpacing: number;
  /** Lines of scrollback kept in agent terminals. Aux terminal uses half this value. */
  terminalScrollback: number;
  /** Treat the macOS Option key as Meta in the terminal (xterm's
   *  `macOptionIsMeta`). When ON, Option+key sends an ESC-prefixed sequence so
   *  terminal editors (vim/emacs/nano) see Option as their Meta/Alt modifier,
   *  matching Terminal.app's "Use Option as Meta key". When OFF (default),
   *  Option produces the usual accented characters. (issue #11) */
  terminalOptionAsMeta: boolean;
  /** Use xterm's GPU (WebGL) renderer. ON (default) is the fast path on every
   *  platform. Some Linux/WebKitGTK setups initialize WebGL on a software
   *  rasterizer (llvmpipe), where it is far SLOWER than the DOM renderer and
   *  makes typing lag. Turning this OFF forces xterm's DOM renderer. Applies to
   *  terminals opened after the change (relaunch to switch every terminal). */
  terminalGpuEnabled: boolean;
  /** iTerm-style copy-on-select: a finished mouse selection in any terminal
   *  is written to the clipboard automatically. ON by default. */
  terminalCopyOnSelect: boolean;
  editorFontSize: number;
  /** Whole-app zoom, in percent (100 = native). Applied via the webview's
   *  native page zoom (see applyUiScale), so it scales every chrome surface
   *  uniformly, terminals and editor included, like browser zoom. Independent
   *  of the per-pane terminal/editor font sizes. */
  uiScale: number;
  /** Enable font ligatures (=>, !==, ...) in the editor. */
  codeLigatures: boolean;
  /** How a task row's tab list (its "agents") expands in the sidebar:
   *  - "chevron": only the chevron toggles. Row click just activates.
   *               No auto-expand. Default — most predictable.
   *  - "click":   click on the active row's title also toggles, AND the
   *               task auto-expands when it grows to 2+ agents.
   *  - "always":  tasks are always expanded by default. The chevron
   *               still collapses, and that collapsed-state sticks. */
  taskExpandMode: "chevron" | "click" | "always";
  /** When true, projects with no active tasks are hidden from the
   *  sidebar list and folded behind a "Show N inactive" row at the bottom.
   *  Keeps a long project list (repos you've added but aren't actively
   *  working in) from crowding out the projects that have live agents. */
  hideInactiveProjects: boolean;
  /** Last-used view for markdown edit tabs (source / preview / split).
   *  New markdown tabs open in this mode, and toggling a tab's view
   *  updates it — so the app remembers however you last looked at a doc. */
  markdownDefaultView: MarkdownView;
  /** Prefix prepended to auto-generated worktree branch names in the New
   *  task dialog (e.g. "feature" → "feature/my-task"). Empty means no
   *  prefix. The user can still freely edit the branch field per task. */
  branchPrefix: string;
  /** Minimum delay (ms) enforced between consecutive message-queue sends to
   *  the same agent. A throttle on the "ralph loop": even if the agent
   *  reports work-done in under this window (or a false "done" fires), the
   *  next queued message waits out the remainder. Default 10000 (10s). 0
   *  disables the floor. Applies to "Send now" too. */
  queueMinIntervalMs: number;
  /** Resolved keyboard shortcut bindings (defaults merged with the user's
   *  overrides). Read live by `useShortcuts`; edited from the Shortcuts
   *  settings page. */
  shortcuts: BindingMap;
  /** Dim inactive split panes. ON by default. */
  splitPaneDim: boolean;
  /** Dimming intensity 0–100 (percentage of black overlay). Default 30. */
  splitPaneDimAmount: number;

  setEditorFontId:    (id: string) => void;
  setEditorThemeId:   (id: string) => void;
  setTerminalFontId:  (id: string) => void;
  setTerminalFontSize:(px: number) => void;
  setTerminalLetterSpacing:(px: number) => void;
  setTerminalScrollback:  (n: number) => void;
  setTerminalOptionAsMeta: (v: boolean) => void;
  setTerminalGpuEnabled: (v: boolean) => void;
  setTerminalCopyOnSelect: (v: boolean) => void;
  setEditorFontSize:  (px: number) => void;
  /** Set whole-app zoom (percent, clamped to UI_SCALE_MIN..MAX). */
  setUiScale:         (pct: number) => void;
  /** Bump zoom by one step in either direction (for the Cmd +/- shortcuts). */
  nudgeUiScale:       (dir: 1 | -1) => void;
  setCodeLigatures:   (v: boolean) => void;
  /** Restore every Appearance-section pref (fonts, sizes, weight,
   *  letter-spacing, ligatures) to `APPEARANCE_DEFAULTS`. Theme is
   *  left alone — it's not part of the Appearance page. */
  resetAppearance:    () => void;
  setThemeMode:       (m: ThemeMode) => void;
  /** Convenience: cycle auto → light → dark → auto. */
  cycleThemeMode:     () => void;
  /** Fetch + sanitize the custom theme files, then reconcile the active
   *  selection: file deleted → fall back to "claude" (persisted), file
   *  edited → re-apply vars + bump customThemeRev. Safe to fire often. */
  loadCustomThemes:   () => Promise<void>;
  setDesktopNotifications: (v: boolean) => void;
  setCompletionSound: (v: boolean) => void;
  setCompletionSoundId: (id: CompletionSoundId) => void;
  setSettledHighlight: (v: boolean) => void;
  setConfirmBeforeCloseAgentTab: (v: boolean) => void;
  setWorkingIndicator: (v: boolean) => void;
  setLoadRemoteImages: (v: boolean) => void;
  setGlobalDefaultSandbox: (v: boolean) => void;
  setSandboxBypassPermissions: (v: boolean) => void;
  setAllowScope: (s: "agent" | "project" | "repo") => void;
  setTaskExpandMode: (m: "chevron" | "click" | "always") => void;
  setHideInactiveProjects: (v: boolean) => void;
  setMarkdownDefaultView: (v: MarkdownView) => void;
  setBranchPrefix: (v: string) => void;
  setQueueMinIntervalMs: (ms: number) => void;
  setSplitPaneDim: (v: boolean) => void;
  setSplitPaneDimAmount: (v: number) => void;
  /** Rebind a single shortcut. */
  setShortcut: (id: ShortcutId, binding: Binding) => void;
  /** Restore one shortcut to its factory binding. */
  resetShortcut: (id: ShortcutId) => void;
  /** Restore every shortcut to its factory binding. */
  resetAllShortcuts: () => void;
}

const lsGet = (k: string, fallback: string) => {
  try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
};
const lsGetNum = (k: string, fallback: number) => {
  const v = Number(lsGet(k, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};
const lsGetBool = (k: string, fallback: boolean) => lsGet(k, fallback ? "1" : "0") === "1";

/** Resolve the stored keybinding overrides onto the defaults. Merging onto
 *  defaults (rather than trusting the stored blob) means commands added in a
 *  later version always have a binding even if the saved JSON predates them,
 *  and a malformed entry just falls back to its default. */
function loadShortcuts(): BindingMap {
  const merged: BindingMap = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(LS_SHORTCUTS);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Partial<Binding>>;
      // "open-shortcuts" was removed as a bindable shortcut in 0.17.4 — wipe any stored binding.
      if ("open-shortcuts" in parsed) {
        delete parsed["open-shortcuts"];
        try { localStorage.setItem(LS_SHORTCUTS, JSON.stringify(parsed)); } catch {}
      }
      for (const id of Object.keys(merged) as ShortcutId[]) {
        const b = parsed[id];
        if (b && typeof b.key === "string"
            && typeof b.cmd === "boolean" && typeof b.shift === "boolean" && typeof b.alt === "boolean") {
          merged[id] = { cmd: b.cmd, shift: b.shift, alt: b.alt, key: b.key };
        }
      }
    }
  } catch {}
  return merged;
}

function persistShortcuts(map: BindingMap) {
  try { localStorage.setItem(LS_SHORTCUTS, JSON.stringify(map)); } catch {}
}

/** Factory defaults for the Appearance section — single source of
 *  truth for both first-launch fallbacks and the "Reset to defaults"
 *  button. Default weight is 500 (Medium), not 400: xterm's WebGL
 *  addon rasterizes glyphs through Canvas2D, and WKWebView's Canvas2D
 *  path renders noticeably lighter than Core Text (what iTerm /
 *  Terminal.app use). 500 closes most of that gap out of the box. */
export const APPEARANCE_DEFAULTS = {
  editorFontId:          "jetbrains",
  terminalFontId:        "jetbrains",
  terminalFontSize:      13,
  terminalLetterSpacing: 1,
  terminalScrollback:    5000,
  terminalOptionAsMeta:  false,
  terminalGpuEnabled:    true,
  editorFontSize:        13,
  uiScale:               100,
  codeLigatures:         true,
} as const;

const initialEditorFont   = lsGet(LS_EDITOR_FONT, APPEARANCE_DEFAULTS.editorFontId);
const initialEditorTheme  = lsGet(LS_EDITOR_THEME, "auto");
const initialTerminalFont = lsGet(LS_TERMINAL_FONT, APPEARANCE_DEFAULTS.terminalFontId);
const initialTerminalSize = lsGetNum(LS_TERMINAL_SIZE, APPEARANCE_DEFAULTS.terminalFontSize);
const initialTerminalLetterSpacing = Math.max(0, Math.round(lsGetNum(LS_TERMINAL_LETTERSPACING, APPEARANCE_DEFAULTS.terminalLetterSpacing)));
const initialTerminalScrollback    = Math.max(1000, Math.min(100000, Math.round(lsGetNum(LS_TERMINAL_SCROLLBACK, APPEARANCE_DEFAULTS.terminalScrollback))));
const initialTerminalOptionAsMeta  = lsGetBool(LS_TERMINAL_OPTION_AS_META, APPEARANCE_DEFAULTS.terminalOptionAsMeta);
const initialTerminalGpuEnabled    = lsGetBool(LS_TERMINAL_GPU, APPEARANCE_DEFAULTS.terminalGpuEnabled);
const initialTerminalCopyOnSelect  = lsGetBool(LS_TERMINAL_COPY_ON_SELECT, true);
const initialEditorSize   = lsGetNum(LS_EDITOR_SIZE, APPEARANCE_DEFAULTS.editorFontSize);
const initialUiScale      = clampUiScale(lsGetNum(LS_UI_SCALE, APPEARANCE_DEFAULTS.uiScale));
const initialLigatures    = lsGetBool(LS_LIGATURES, APPEARANCE_DEFAULTS.codeLigatures);
const initialTheme        = parseThemeMode(lsGet(LS_THEME, "claude"));
const initialDesktopNotif = lsGetBool(LS_DESKTOPNOTIF, false);
const initialCompletionSound = readCompletionSoundEnabled();
const initialCompletionSoundId = readCompletionSoundId();
// WIP feature - the "agent has settled" heuristic produces false
// positives often enough that the highlight is noise more than
// Default ON. Claude Code's title classifier (Braille spinner glyph
// while working, "✳" brand prefix when idle — see TerminalPane.tsx
// classifyTitle) gives us a reliable busy→idle edge for Claude;
// Codex/Gemini have explicit "Ready"/"Working" title states. Existing
// users who toggled it OFF keep their setting (lsGetBool returns the
// stored value when present).
const initialSettledHighlight = lsGetBool(LS_SETTLED_HIGHLIGHT, true);
const initialConfirmCloseAgentTab = lsGetBool(LS_CONFIRM_CLOSE_AGENT_TAB, true);
// OFF by default — experimental re-introduction of the work-in-progress
// spinner. Opt in via Settings → General.
const initialWorkingIndicator = lsGetBool(LS_WORKING_INDICATOR, false);
// OFF by default (issue #69): closing the remote-image sandbox gap must not
// silently start firing image requests for existing users.
const initialLoadRemoteImages = lsGetBool(LS_LOAD_REMOTE_IMAGES, false);
const initialDefaultSandbox = lsGetBool(LS_DEFAULT_SANDBOX, false);
// ON by default — sandboxed agents bypass their own permission prompts
// because the seatbelt is the real boundary. Users can opt out.
const initialSandboxBypass = lsGetBool(LS_SANDBOX_BYPASS, true);
const initialAllowScope: "agent" | "project" | "repo" | null = (() => {
  const raw = lsGet(LS_ALLOW_SCOPE, "");
  return raw === "agent" || raw === "project" || raw === "repo" ? raw : null;
})();
const initialTaskExpandMode: "chevron" | "click" | "always" = (() => {
  const raw = lsGet(LS_TASK_EXPAND_MODE, "chevron");
  return raw === "click" || raw === "always" ? raw : "chevron";
})();
const initialHideInactiveProjects = lsGet(LS_HIDE_INACTIVE_PROJECTS, "") === "1";
const initialMarkdownView: MarkdownView = (() => {
  const raw = lsGet(LS_MD_VIEW, "source");
  return raw === "preview" || raw === "split" ? raw : "source";
})();
const initialBranchPrefix = lsGet(LS_BRANCH_PREFIX, "feature");
// Clamp 0–120s. Default 10s — fast loops (or false "done" oscillation)
// shouldn't fire prompts at the agent faster than this.
const initialQueueMinInterval = Math.max(0, Math.min(120000, Math.round(lsGetNum(LS_QUEUE_MIN_INTERVAL, 10000))));

export const usePrefs = create<PrefsState>(set => ({
  themeMode: initialTheme,
  customThemes: [],
  customThemeRev: 0,
  desktopNotifications: initialDesktopNotif,
  completionSound: initialCompletionSound,
  completionSoundId: initialCompletionSoundId,
  settledHighlight: initialSettledHighlight,
  confirmBeforeCloseAgentTab: initialConfirmCloseAgentTab,
  workingIndicator: initialWorkingIndicator,
  loadRemoteImages: initialLoadRemoteImages,
  globalDefaultSandbox: initialDefaultSandbox,
  sandboxBypassPermissions: initialSandboxBypass,
  allowScope: initialAllowScope,
  editorFontId: initialEditorFont,
  editorThemeId: initialEditorTheme,
  terminalFontId: initialTerminalFont,
  terminalFontSize: initialTerminalSize,
  terminalLetterSpacing: initialTerminalLetterSpacing,
  terminalScrollback: initialTerminalScrollback,
  terminalOptionAsMeta: initialTerminalOptionAsMeta,
  terminalGpuEnabled: initialTerminalGpuEnabled,
  terminalCopyOnSelect: initialTerminalCopyOnSelect,
  editorFontSize: initialEditorSize,
  uiScale: initialUiScale,
  codeLigatures: initialLigatures,
  taskExpandMode: initialTaskExpandMode,
  hideInactiveProjects: initialHideInactiveProjects,
  markdownDefaultView: initialMarkdownView,
  branchPrefix: initialBranchPrefix,
  queueMinIntervalMs: initialQueueMinInterval,
  shortcuts: loadShortcuts(),
  splitPaneDim: lsGetBool(LS_PANE_DIM, true),
  splitPaneDimAmount: Math.max(0, Math.min(100, Math.round(lsGetNum(LS_PANE_DIM_AMT, 10)))),

  setEditorFontId: (id) => {
    try { localStorage.setItem(LS_EDITOR_FONT, id); } catch {}
    applyEditorFont(id);
    set({ editorFontId: id });
  },
  setEditorThemeId: (id) => {
    try { localStorage.setItem(LS_EDITOR_THEME, id); } catch {}
    set({ editorThemeId: id });
  },
  setTerminalFontId: (id) => {
    try { localStorage.setItem(LS_TERMINAL_FONT, id); } catch {}
    // Terminal font does NOT touch --font-mono (which the editor uses);
    // it's read by xterm directly via currentTerminalStack().
    set({ terminalFontId: id });
  },
  setTerminalFontSize: (px) => {
    try { localStorage.setItem(LS_TERMINAL_SIZE, String(px)); } catch {}
    set({ terminalFontSize: px });
  },
  setTerminalLetterSpacing: (px) => {
    // Clamp to non-negative integer. Fractional values misalign the
    // WebGL atlas; very high values break TUI column math.
    const clamped = Math.max(0, Math.min(6, Math.round(px)));
    try { localStorage.setItem(LS_TERMINAL_LETTERSPACING, String(clamped)); } catch {}
    set({ terminalLetterSpacing: clamped });
  },
  setTerminalScrollback: (n) => {
    const clamped = Math.max(1000, Math.min(100000, Math.round(n)));
    try { localStorage.setItem(LS_TERMINAL_SCROLLBACK, String(clamped)); } catch {}
    set({ terminalScrollback: clamped });
  },
  setTerminalOptionAsMeta: (v) => {
    try { localStorage.setItem(LS_TERMINAL_OPTION_AS_META, v ? "1" : "0"); } catch {}
    set({ terminalOptionAsMeta: v });
  },
  setTerminalGpuEnabled: (v) => {
    try { localStorage.setItem(LS_TERMINAL_GPU, v ? "1" : "0"); } catch {}
    set({ terminalGpuEnabled: v });
  },
  setTerminalCopyOnSelect: (v) => {
    try { localStorage.setItem(LS_TERMINAL_COPY_ON_SELECT, v ? "1" : "0"); } catch {}
    set({ terminalCopyOnSelect: v });
  },
  setEditorFontSize: (px) => {
    try { localStorage.setItem(LS_EDITOR_SIZE, String(px)); } catch {}
    set({ editorFontSize: px });
  },
  setUiScale: (pct) => {
    const clamped = clampUiScale(pct);
    try { localStorage.setItem(LS_UI_SCALE, String(clamped)); } catch {}
    applyUiScale(clamped);
    set({ uiScale: clamped });
  },
  nudgeUiScale: (dir) => {
    usePrefs.getState().setUiScale(usePrefs.getState().uiScale + dir * UI_SCALE_STEP);
  },
  setCodeLigatures: (v) => {
    try { localStorage.setItem(LS_LIGATURES, v ? "1" : "0"); } catch {}
    set({ codeLigatures: v });
  },
  resetAppearance: () => {
    // Route through the individual setters so each one's side
    // effects fire (localStorage write, applyEditorFont, clamps).
    const d = APPEARANCE_DEFAULTS;
    const s = usePrefs.getState();
    s.setEditorFontId(d.editorFontId);
    s.setTerminalFontId(d.terminalFontId);
    s.setTerminalFontSize(d.terminalFontSize);
    s.setTerminalLetterSpacing(d.terminalLetterSpacing);
    s.setTerminalScrollback(d.terminalScrollback);
    s.setTerminalOptionAsMeta(d.terminalOptionAsMeta);
    s.setTerminalGpuEnabled(d.terminalGpuEnabled);
    s.setEditorFontSize(d.editorFontSize);
    s.setUiScale(d.uiScale);
    s.setCodeLigatures(d.codeLigatures);
  },
  setThemeMode: (m) => {
    // Picking a custom theme refreshes the first-paint cache so applyTheme
    // (and the next launch's module-load paint) has the payload at hand.
    if (isCustomId(m)) {
      const theme = usePrefs.getState().customThemes.find(t => t.id === m);
      if (theme) writeThemeCache(theme);
    }
    try { localStorage.setItem(LS_THEME, m); } catch {}
    applyTheme(m);
    set({ themeMode: m });
  },
  loadCustomThemes: async () => {
    let files;
    try { files = await themesList(); } catch { return; }
    const themes = files.map(sanitizeTheme);
    const prev = usePrefs.getState().customThemes;
    // Only publish a new array when the content changed — subscribers
    // (picker, terminal panes) shouldn't re-render on a no-op refetch.
    if (JSON.stringify(prev) !== JSON.stringify(themes)) set({ customThemes: themes });
    const mode = usePrefs.getState().themeMode;
    if (!isCustomId(mode)) return;
    const active = themes.find(t => t.id === mode);
    if (!active) {
      // The active theme's file was deleted — fall back to the default
      // theme and persist so the pref doesn't dangle on a dead id.
      clearThemeCache();
      usePrefs.getState().setThemeMode("claude");
      return;
    }
    const cached = readThemeCache();
    if (!cached || JSON.stringify(cached) !== JSON.stringify(active)) {
      // The active theme's file was edited — re-apply live.
      writeThemeCache(active);
      applyTheme(mode);
      set(s => ({ customThemeRev: s.customThemeRev + 1 }));
    }
  },
  setDesktopNotifications: (v) => {
    try { localStorage.setItem(LS_DESKTOPNOTIF, v ? "1" : "0"); } catch {}
    set({ desktopNotifications: v });
  },
  setCompletionSound: (v) => {
    try { localStorage.setItem(LS_COMPLETION_SOUND, v ? "1" : "0"); } catch {}
    set({ completionSound: v });
  },
  setCompletionSoundId: (id) => {
    const next = isCompletionSoundId(id) ? id : DEFAULT_COMPLETION_SOUND_ID;
    try { localStorage.setItem(LS_COMPLETION_SOUND_ID, next); } catch {}
    set({ completionSoundId: next });
  },
  setSettledHighlight: (v) => {
    try { localStorage.setItem(LS_SETTLED_HIGHLIGHT, v ? "1" : "0"); } catch {}
    set({ settledHighlight: v });
  },
  setConfirmBeforeCloseAgentTab: (v) => {
    try { localStorage.setItem(LS_CONFIRM_CLOSE_AGENT_TAB, v ? "1" : "0"); } catch {}
    set({ confirmBeforeCloseAgentTab: v });
  },
  setWorkingIndicator: (v) => {
    try { localStorage.setItem(LS_WORKING_INDICATOR, v ? "1" : "0"); } catch {}
    set({ workingIndicator: v });
  },
  setLoadRemoteImages: (v) => {
    try { localStorage.setItem(LS_LOAD_REMOTE_IMAGES, v ? "1" : "0"); } catch {}
    set({ loadRemoteImages: v });
  },
  setGlobalDefaultSandbox: (v) => {
    try { localStorage.setItem(LS_DEFAULT_SANDBOX, v ? "1" : "0"); } catch {}
    set({ globalDefaultSandbox: v });
  },
  setSandboxBypassPermissions: (v) => {
    try { localStorage.setItem(LS_SANDBOX_BYPASS, v ? "1" : "0"); } catch {}
    set({ sandboxBypassPermissions: v });
  },
  setAllowScope: (s) => {
    try { localStorage.setItem(LS_ALLOW_SCOPE, s); } catch {}
    set({ allowScope: s });
  },
  setTaskExpandMode: (m) => {
    try { localStorage.setItem(LS_TASK_EXPAND_MODE, m); } catch {}
    set({ taskExpandMode: m });
  },
  setHideInactiveProjects: (v) => {
    try { localStorage.setItem(LS_HIDE_INACTIVE_PROJECTS, v ? "1" : "0"); } catch {}
    set({ hideInactiveProjects: v });
  },
  setMarkdownDefaultView: (v) => {
    try { localStorage.setItem(LS_MD_VIEW, v); } catch {}
    set({ markdownDefaultView: v });
  },
  setBranchPrefix: (v) => {
    // Store as-typed (normalization happens at the use site in
    // NewTaskDialog) so a trailing "/" isn't stripped mid-keystroke.
    try { localStorage.setItem(LS_BRANCH_PREFIX, v); } catch {}
    set({ branchPrefix: v });
  },
  setQueueMinIntervalMs: (ms) => {
    const clamped = Math.max(0, Math.min(120000, Math.round(ms)));
    try { localStorage.setItem(LS_QUEUE_MIN_INTERVAL, String(clamped)); } catch {}
    set({ queueMinIntervalMs: clamped });
  },
  setSplitPaneDim: (v) => {
    try { localStorage.setItem(LS_PANE_DIM, v ? "1" : "0"); } catch {}
    set({ splitPaneDim: v });
  },
  setSplitPaneDimAmount: (v) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    try { localStorage.setItem(LS_PANE_DIM_AMT, String(clamped)); } catch {}
    set({ splitPaneDimAmount: clamped });
  },
  setShortcut: (id, binding) => {
    const next = { ...usePrefs.getState().shortcuts, [id]: binding };
    persistShortcuts(next);
    set({ shortcuts: next });
  },
  resetShortcut: (id) => {
    const next = { ...usePrefs.getState().shortcuts, [id]: DEFAULT_BINDINGS[id] };
    persistShortcuts(next);
    set({ shortcuts: next });
  },
  resetAllShortcuts: () => {
    const next: BindingMap = { ...DEFAULT_BINDINGS };
    persistShortcuts(next);
    set({ shortcuts: next });
  },
  cycleThemeMode: () => {
    // Cycle only the original three for the keyboard shortcut - explicit
    // espresso/solarized picks live in the dropdown. Cycling through 5
    // states blindly with a single button feels random.
    const order: ThemeMode[] = ["auto", "light", "dark"];
    const cur = usePrefs.getState().themeMode;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    try { localStorage.setItem(LS_THEME, next); } catch {}
    applyTheme(next);
    set({ themeMode: next });
  },
}));

/** Legacy resolver kept for callers that only care about light-vs-dark
 *  (toolbar icon swap, editor auto, COLORFGBG, system colorScheme hint).
 *  Espresso + Solarized both collapse to "dark"; a custom theme collapses
 *  to its declared colorScheme. This single mapping is why editor-auto
 *  and COLORFGBG need zero custom-theme awareness of their own. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  const full = resolveThemeFull(mode);
  if (isCustomId(full)) return customThemeById(full)?.colorScheme ?? "dark";
  return full === "light" ? "light" : "dark";
}

/** Resolve to the concrete palette name (light / dark / espresso /
 *  solarized). `auto` only ever maps to light or dark - the OS doesn't
 *  speak espresso/solarized; those require an explicit user pick.
 *  Custom ids pass through as-is. */
export function resolveThemeFull(mode: ThemeMode): ResolvedTheme | `custom:${string}` {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

/** Swap the html element's palette. Built-ins toggle their CSS class;
 *  custom themes push their colors as inline vars (inline beats a
 *  class-defined var in the cascade, so a partial theme falls back
 *  per-key to whatever class is underneath). We always toggle every class
 *  AND reconcile the inline vars so nothing from the previous theme bleeds
 *  through after a switch in either direction.
 *
 *  A custom theme keeps the `light` class when it declares
 *  `colorScheme: "light"`: the @theme defaults are the DARK palette, so
 *  without this a light theme that omits `fg` would paint near-white text
 *  on its own near-white `bg`. Its own keys still win (inline > class), and
 *  dark customs need no class since @theme is already their fallback. */
export function applyTheme(mode: ThemeMode) {
  const resolved = resolveThemeFull(mode);
  const custom = isCustomId(resolved) ? customThemeById(resolved) : null;
  const html = document.documentElement;
  html.classList.toggle("light",     custom ? custom.colorScheme === "light" : resolved === "light");
  html.classList.toggle("dark",      resolved === "dark");
  html.classList.toggle("claude",    resolved === "claude");
  html.classList.toggle("solarized", resolved === "solarized");
  html.classList.toggle("cobalt",    resolved === "cobalt");
  html.classList.toggle("matrix",    resolved === "matrix");
  html.classList.toggle("rosepine",  resolved === "rosepine");
  if (custom) {
    applyCustomVars(html, custom.ui);
    // Color-scheme tells the browser to use light/dark form controls +
    // scrollbars; the theme file declares which family it belongs to.
    html.style.colorScheme = custom.colorScheme;
  } else {
    // Built-in (or a custom id whose payload is gone — every class is
    // off, so this degrades to the @theme Dark+ defaults).
    clearCustomVars(html);
    html.style.colorScheme = resolved === "light" ? "light" : "dark";
  }
}

// Apply at module load so the first paint matches the user's preference.
applyTheme(initialTheme);

// Live-track system-theme changes when in auto mode.
if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (usePrefs.getState().themeMode === "auto") applyTheme("auto");
  });
}

/** Editor font drives the --font-mono CSS var so any `font-mono` class +
 *  CodeMirror picks it up via `var(--font-mono)`. */
export function applyEditorFont(id: string) {
  document.documentElement.style.setProperty("--font-mono", stackFor(id));
}

/** Whole-app zoom via the webview's NATIVE page zoom (WKWebView
 *  pageZoom), the same mechanism as a browser's Cmd +/-. This reflows
 *  the layout to fit the window, unlike the CSS `zoom` property which
 *  (in this WebKit) scales the root past the viewport and clips the
 *  right/bottom. It also scales every surface uniformly, so a root
 *  font-size tweak (defeated by the app's hardcoded px) isn't needed.
 *  Async + best-effort: the invoke is a no-op until the webview is up. */
export function applyUiScale(pct: number) {
  const factor = clampUiScale(pct) / 100;
  // getCurrentWebview() throws synchronously when the Tauri internals aren't
  // present (outside the app / in tests); the .catch only covers the async
  // setZoom. Guard so module load never crashes off-Tauri.
  try {
    getCurrentWebview().setZoom(factor).catch(() => {});
  } catch {
    // no webview to scale — no-op
  }
}

export const currentEditorStack   = () => stackFor(usePrefs.getState().editorFontId);

/** Terminal font stack with a bundled fallback injected before the
 *  generic `monospace`. JetBrains Mono (static 400/700 masters) ships
 *  with the app and covers glyphs many monospace fonts lack — notably
 *  the Romanian comma-below ș/ț (U+0219/U+021B). Without it, a glyph
 *  missing from the chosen font falls back to the OS `monospace`. */
export const currentTerminalStack = () => {
  const stack = stackFor(usePrefs.getState().terminalFontId);
  return stack.replace(/\bmonospace\s*$/, '"JetBrains Mono", monospace');
};

// Apply editor font at module load so the first paint uses the right font.
applyEditorFont(initialEditorFont);

// Apply saved zoom at module load so the first paint is already scaled.
applyUiScale(initialUiScale);

// Warm the system font enumeration at startup so the Settings font pickers
// have the full list by the time one first mounts. Without this the first
// dropdown open raced the scan and only showed the curated subset (the
// native select popup won't take options added while it's open).
availableMonoFontsAsync().catch(() => {});
