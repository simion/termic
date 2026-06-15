// User-visible UI preferences (separate from app data and transient UI state).
// Persisted to localStorage so they survive launches. Currently just the mono
// font, but built for future things (themes, terminal opacity, etc.).

import { create } from "zustand";
import { listMonospaceFonts } from "@/lib/ipc";
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
const LS_WORKING_INDICATOR = "workingIndicator";
const LS_DEFAULT_SANDBOX = "globalDefaultSandbox";
const LS_SANDBOX_BYPASS  = "sandboxBypassPermissions";
const LS_ALLOW_SCOPE     = "sandboxAllowScope";
const LS_TERMINAL_LETTERSPACING = "terminalLetterSpacing";
const LS_TERMINAL_SCROLLBACK   = "terminalScrollback";
const LS_TERMINAL_OPTION_AS_META = "terminalOptionAsMeta";
const LS_TERMINAL_GPU            = "terminalGpuEnabled";
const LS_WS_EXPAND_MODE = "workspaceExpandMode";
const LS_HIDE_INACTIVE_PROJECTS = "hideInactiveProjects";
const LS_SHORTCUTS     = "shortcutBindings";

export type ThemeMode = "auto" | "light" | "dark" | "claude" | "solarized" | "cobalt" | "matrix";
/** What `applyTheme` resolves to: a concrete palette name. `auto` is
 *  never returned; it gets mapped to light/dark based on OS preference. */
export type ResolvedTheme = "light" | "dark" | "claude" | "solarized" | "cobalt" | "matrix";

const VALID_MODES: ReadonlyArray<ThemeMode> = ["auto", "light", "dark", "claude", "solarized", "cobalt", "matrix"];
/** Defensive parse: localStorage may hold a theme id that's been
 *  removed in a later version. Fall back to "claude" (the default
 *  theme) instead of letting the unknown string flow through and
 *  silently land on the @theme default. NOTE: this also migrates the
 *  old "vscode" id for free — that theme was renamed to "claude", and
 *  any stale "vscode" string lands here and resolves to it. */
function parseThemeMode(raw: string): ThemeMode {
  return (VALID_MODES as readonly string[]).includes(raw) ? (raw as ThemeMode) : "claude";
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
};

/** Resolve the user's chosen theme to a concrete palette name. Used by
 *  both `applyTheme` (to pick which html class to toggle) and the
 *  terminal panes (to pick the matching xterm theme). */
export function currentTerminalTheme(): Record<string, string> {
  const resolved = resolveThemeFull(usePrefs.getState().themeMode);
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
  const resolved = resolveThemeFull(usePrefs.getState().themeMode);
  return resolved === "light" ? "0;15" : "15;0";
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


/** Returns the subset of MONO_FONT_OPTIONS whose primary face is actually
 *  installed (always includes the bundled JetBrains Mono). Synchronous —
 *  for the *full* system enumeration use availableMonoFontsAsync(). */
export function availableMonoFonts() {
  // Always return the full curated list. Canvas-based installed-detection
  // is unreliable inside WKWebView for faces with unusual naming (Meslo's
  // "Meslo LG S" vs "MesloLGS", Powerline / Nerd Font variants, etc.) —
  // previous filter dropped Meslo entirely on macs that clearly had it
  // installed. If the user picks a font they don't have, the CSS stack
  // falls back to `monospace`, which is harmless.
  return MONO_FONT_OPTIONS;
}

// Process-wide cache for the Rust-enumerated list. Populated by the first
// availableMonoFontsAsync() call, kept until the app exits.
let _systemFontsCache: string[] | null = null;

/** Returns the curated installed list MERGED with every monospace font Rust
 *  finds via font-kit. Fonts not in the curated map get an auto-generated
 *  entry (id = "system:<name>", label = family name, stack = family). */
export async function availableMonoFontsAsync(): Promise<typeof MONO_FONT_OPTIONS> {
  const curated = availableMonoFonts();
  if (!_systemFontsCache) {
    try { _systemFontsCache = await listMonospaceFonts(); }
    catch { _systemFontsCache = []; }
  }
  // Names already covered by curated (case-insensitive match against the
  // first family in each stack) — we keep the curated entry so the brand
  // label / id stays stable across launches.
  const covered = new Set(curated.map(o =>
    o.stack.split(",")[0].trim().replace(/^"|"$/g, "").toLowerCase()
  ));
  const extras = _systemFontsCache
    .filter(name => !covered.has(name.toLowerCase()))
    .map(name => ({
      id: `system:${name}`,
      label: name,
      stack: `"${name}", monospace`,
    }));
  return [...curated, ...extras];
}

/** Resolve a font id → CSS font-family stack, defaulting to JetBrains. */
function stackFor(id: string) {
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
  /** Highlight workspaces / tabs whose agent has just settled (idle).
   *  ON by default — the brand-color icon swap on settle is the
   *  in-app "done" signal. Some users find it distracting and want
   *  the sidebar to stay calm regardless. */
  settledHighlight: boolean;
  /** Show a spinner on an agent's tab (and sidebar icon) WHILE it's
   *  working. OFF by default — experimental. The "working" workState is
   *  always tracked internally to drive work-done detection; this pref only
   *  controls whether it's surfaced. Work detection can occasionally get a
   *  signal stuck, so TerminalPane has an absolute ceiling that force-clears
   *  a stale "working" state regardless of sender signals. */
  workingIndicator: boolean;
  /** Default for the NewWorkspaceDialog's Sandbox toggle when neither
   *  the project's `default_sandbox` nor an explicit user pick is in
   *  effect. Lets a single-keystroke toggle apply across all projects
   *  without per-project bookkeeping. */
  globalDefaultSandbox: boolean;
  /** When a workspace is sandboxed, auto-pass the agent's "bypass
   *  permissions" (YOLO) flag at spawn even if the YOLO toggle is off.
   *  ON by default: the seatbelt cage is the real security boundary, so
   *  the agent's own permission prompts are just friction. Users who
   *  still want the agent to ask inside a sandbox can turn this off. */
  sandboxBypassPermissions: boolean;
  /** Where the "Allow" button in the sandbox activity/blocked popover
   *  writes. `null` until the user picks once (the radio is mandatory
   *  on first use); their choice then becomes the app-wide default.
   *  - "agent"   → the agent registry (every workspace using that CLI)
   *  - "project" → this project's personal defaults (projects.json)
   *  - "repo"    → the committed `.termic.yaml` (team-shared) */
  allowScope: "agent" | "project" | "repo" | null;
  /** Color scheme: explicit dark/light, or auto = follow system. */
  themeMode: ThemeMode;
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
  editorFontSize: number;
  /** Enable font ligatures (=>, !==, ...) in the editor. */
  codeLigatures: boolean;
  /** How a workspace row's tab list (its "agents") expands in the sidebar:
   *  - "chevron": only the chevron toggles. Row click just activates.
   *               No auto-expand. Default — most predictable.
   *  - "click":   click on the active row's title also toggles, AND the
   *               workspace auto-expands when it grows to 2+ agents.
   *  - "always":  workspaces are always expanded by default. The chevron
   *               still collapses, and that collapsed-state sticks. */
  workspaceExpandMode: "chevron" | "click" | "always";
  /** When true, projects with no active workspaces are hidden from the
   *  sidebar list and folded behind a "Show N inactive" row at the bottom.
   *  Keeps a long project list (repos you've added but aren't actively
   *  working in) from crowding out the projects that have live agents. */
  hideInactiveProjects: boolean;
  /** Resolved keyboard shortcut bindings (defaults merged with the user's
   *  overrides). Read live by `useShortcuts`; edited from the Shortcuts
   *  settings page. */
  shortcuts: BindingMap;

  setEditorFontId:    (id: string) => void;
  setEditorThemeId:   (id: string) => void;
  setTerminalFontId:  (id: string) => void;
  setTerminalFontSize:(px: number) => void;
  setTerminalLetterSpacing:(px: number) => void;
  setTerminalScrollback:  (n: number) => void;
  setTerminalOptionAsMeta: (v: boolean) => void;
  setTerminalGpuEnabled: (v: boolean) => void;
  setEditorFontSize:  (px: number) => void;
  setCodeLigatures:   (v: boolean) => void;
  /** Restore every Appearance-section pref (fonts, sizes, weight,
   *  letter-spacing, ligatures) to `APPEARANCE_DEFAULTS`. Theme is
   *  left alone — it's not part of the Appearance page. */
  resetAppearance:    () => void;
  setThemeMode:       (m: ThemeMode) => void;
  /** Convenience: cycle auto → light → dark → auto. */
  cycleThemeMode:     () => void;
  setDesktopNotifications: (v: boolean) => void;
  setCompletionSound: (v: boolean) => void;
  setCompletionSoundId: (id: CompletionSoundId) => void;
  setSettledHighlight: (v: boolean) => void;
  setWorkingIndicator: (v: boolean) => void;
  setGlobalDefaultSandbox: (v: boolean) => void;
  setSandboxBypassPermissions: (v: boolean) => void;
  setAllowScope: (s: "agent" | "project" | "repo") => void;
  setWorkspaceExpandMode: (m: "chevron" | "click" | "always") => void;
  setHideInactiveProjects: (v: boolean) => void;
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
  codeLigatures:         true,
} as const;

const initialEditorFont   = lsGet(LS_EDITOR_FONT, APPEARANCE_DEFAULTS.editorFontId);
const initialEditorTheme  = lsGet(LS_EDITOR_THEME, "atomone");
const initialTerminalFont = lsGet(LS_TERMINAL_FONT, APPEARANCE_DEFAULTS.terminalFontId);
const initialTerminalSize = lsGetNum(LS_TERMINAL_SIZE, APPEARANCE_DEFAULTS.terminalFontSize);
const initialTerminalLetterSpacing = Math.max(0, Math.round(lsGetNum(LS_TERMINAL_LETTERSPACING, APPEARANCE_DEFAULTS.terminalLetterSpacing)));
const initialTerminalScrollback    = Math.max(1000, Math.min(100000, Math.round(lsGetNum(LS_TERMINAL_SCROLLBACK, APPEARANCE_DEFAULTS.terminalScrollback))));
const initialTerminalOptionAsMeta  = lsGetBool(LS_TERMINAL_OPTION_AS_META, APPEARANCE_DEFAULTS.terminalOptionAsMeta);
const initialTerminalGpuEnabled    = lsGetBool(LS_TERMINAL_GPU, APPEARANCE_DEFAULTS.terminalGpuEnabled);
const initialEditorSize   = lsGetNum(LS_EDITOR_SIZE, APPEARANCE_DEFAULTS.editorFontSize);
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
// OFF by default — experimental re-introduction of the work-in-progress
// spinner. Opt in via Settings → General.
const initialWorkingIndicator = lsGetBool(LS_WORKING_INDICATOR, false);
const initialDefaultSandbox = lsGetBool(LS_DEFAULT_SANDBOX, false);
// ON by default — sandboxed agents bypass their own permission prompts
// because the seatbelt is the real boundary. Users can opt out.
const initialSandboxBypass = lsGetBool(LS_SANDBOX_BYPASS, true);
const initialAllowScope: "agent" | "project" | "repo" | null = (() => {
  const raw = lsGet(LS_ALLOW_SCOPE, "");
  return raw === "agent" || raw === "project" || raw === "repo" ? raw : null;
})();
const initialWsExpandMode: "chevron" | "click" | "always" = (() => {
  const raw = lsGet(LS_WS_EXPAND_MODE, "chevron");
  return raw === "click" || raw === "always" ? raw : "chevron";
})();
const initialHideInactiveProjects = lsGet(LS_HIDE_INACTIVE_PROJECTS, "") === "1";

export const usePrefs = create<PrefsState>(set => ({
  themeMode: initialTheme,
  desktopNotifications: initialDesktopNotif,
  completionSound: initialCompletionSound,
  completionSoundId: initialCompletionSoundId,
  settledHighlight: initialSettledHighlight,
  workingIndicator: initialWorkingIndicator,
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
  editorFontSize: initialEditorSize,
  codeLigatures: initialLigatures,
  workspaceExpandMode: initialWsExpandMode,
  hideInactiveProjects: initialHideInactiveProjects,
  shortcuts: loadShortcuts(),

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
  setEditorFontSize: (px) => {
    try { localStorage.setItem(LS_EDITOR_SIZE, String(px)); } catch {}
    set({ editorFontSize: px });
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
    s.setCodeLigatures(d.codeLigatures);
  },
  setThemeMode: (m) => {
    try { localStorage.setItem(LS_THEME, m); } catch {}
    applyTheme(m);
    set({ themeMode: m });
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
  setWorkingIndicator: (v) => {
    try { localStorage.setItem(LS_WORKING_INDICATOR, v ? "1" : "0"); } catch {}
    set({ workingIndicator: v });
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
  setWorkspaceExpandMode: (m) => {
    try { localStorage.setItem(LS_WS_EXPAND_MODE, m); } catch {}
    set({ workspaceExpandMode: m });
  },
  setHideInactiveProjects: (v) => {
    try { localStorage.setItem(LS_HIDE_INACTIVE_PROJECTS, v ? "1" : "0"); } catch {}
    set({ hideInactiveProjects: v });
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
 *  (toolbar icon swap, system colorScheme hint). Espresso + Solarized
 *  both collapse to "dark" for those binary purposes. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  const full = resolveThemeFull(mode);
  return full === "light" ? "light" : "dark";
}

/** Resolve to the concrete palette name (light / dark / espresso /
 *  solarized). `auto` only ever maps to light or dark - the OS doesn't
 *  speak espresso/solarized; those require an explicit user pick. */
export function resolveThemeFull(mode: ThemeMode): ResolvedTheme {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

/** Set the html element's class so the CSS palette swap kicks in.
 *  We toggle ALL palette classes so a stale class from a previous
 *  theme can't bleed through after a switch. */
export function applyTheme(mode: ThemeMode) {
  const resolved = resolveThemeFull(mode);
  const html = document.documentElement;
  html.classList.toggle("light",     resolved === "light");
  html.classList.toggle("dark",      resolved === "dark");
  html.classList.toggle("claude",    resolved === "claude");
  html.classList.toggle("solarized", resolved === "solarized");
  html.classList.toggle("cobalt",    resolved === "cobalt");
  html.classList.toggle("matrix",    resolved === "matrix");
  // Color-scheme tells the browser to use light/dark form controls +
  // scrollbars. Espresso + Solarized both want dark widgets.
  html.style.colorScheme = resolved === "light" ? "light" : "dark";
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
