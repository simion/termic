// User-visible UI preferences (separate from app data and transient UI state).
// Persisted to localStorage so they survive launches. Currently just the mono
// font, but built for future things (themes, terminal opacity, etc.).

import { create } from "zustand";
import { listMonospaceFonts } from "@/lib/ipc";

const LS_EDITOR_FONT   = "editorFont";
const LS_TERMINAL_FONT = "terminalFont";
const LS_TERMINAL_SIZE = "terminalFontSize";
const LS_EDITOR_SIZE   = "editorFontSize";
const LS_LIGATURES     = "codeLigatures";
const LS_THEME         = "themeMode";
const LS_YOLO          = "yoloMode";
const LS_DESKTOPNOTIF  = "desktopNotifications";
const LS_SETTLED_HIGHLIGHT = "settledHighlight";
const LS_TERMINAL_WEIGHT = "terminalFontWeight";
const LS_TERMINAL_ENGINE = "terminalEngine";

export type TerminalEngine = "xterm" | "ghostty";

export type ThemeMode = "auto" | "light" | "dark";

// Curated list of monospace fonts we probe for. JetBrains Mono Variable ships
// locally via @fontsource so it's always present; the rest are detected at
// runtime via document.fonts.check(). We don't enumerate the system font
// catalog (WKWebView has no API for it) — this list covers ~95% of what real
// devs install. Add yours here if missing.
export const MONO_FONT_OPTIONS: { id: string; label: string; stack: string }[] = [
  { id: "jetbrains",     label: "JetBrains Mono",        stack: `"JetBrains Mono Variable", "JetBrains Mono", monospace` },
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

/**
 * Reliable font-installed check via canvas width comparison.
 * `document.fonts.check()` is unreliable in WKWebView — it returns true for
 * any font NAME it recognizes (including from @font-face that hasn't loaded
 * a real face). The canvas trick renders a probe string in the candidate
 * font with a known fallback; if the widths match the fallback, the
 * candidate wasn't applied (font not installed).
 */
function isFontInstalled(family: string): boolean {
  if (!family) return false;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return false;
  // Use a long mixed string so even fonts with overlapping metrics for short
  // runs still show a measurable diff.
  const probe = "abcdefghijklmnopqrstuvwxyz1234567890 mmmmmiiiii";
  const size = 24;
  // Compare against TWO baselines (monospace + serif) so a candidate that
  // happens to match one fallback's metrics is still detected.
  ctx.font = `${size}px monospace`;
  const monoBase  = ctx.measureText(probe).width;
  ctx.font = `${size}px serif`;
  const serifBase = ctx.measureText(probe).width;
  // Test against monospace fallback (most apt for mono fonts).
  ctx.font = `${size}px "${family}", monospace`;
  const wMono  = ctx.measureText(probe).width;
  ctx.font = `${size}px "${family}", serif`;
  const wSerif = ctx.measureText(probe).width;
  // Installed iff the candidate produced a width different from BOTH fallbacks
  // (matching either means the system fell back to the generic).
  return wMono !== monoBase || wSerif !== serifBase;
}

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
  /** YOLO mode — appends each agent's "auto-approve everything" flag to its
   *  spawn args. Toggleable from the unified bar. For agents that support
   *  runtime mode-switching (gemini), live PTYs receive a slash command on
   *  toggle; for the rest (claude/codex), new tabs pick it up but existing
   *  PTYs need a respawn. */
  yoloMode: boolean;
  /** Send OS notifications when an inactive tab's agent settles (output
   *  stopped changing). OFF by default — too noisy for many users. */
  desktopNotifications: boolean;
  /** Highlight workspaces / tabs whose agent has just settled (idle).
   *  ON by default — the brand-color icon swap on settle is the
   *  in-app "done" signal. Some users find it distracting and want
   *  the sidebar to stay calm regardless. */
  settledHighlight: boolean;
  /** Color scheme: explicit dark/light, or auto = follow system. */
  themeMode: ThemeMode;
  /** Font for the CodeMirror editor + diff viewer. */
  editorFontId: string;
  /** Font for the xterm terminals (main + aux). Kept separate because power
   *  users often want a Nerd Font for the shell but a clean prose-friendly
   *  font for the editor. */
  terminalFontId: string;
  /** xterm font size in px. Editor size is currently fixed at 13. */
  terminalFontSize: number;
  /** Weight for the xterm regular face (100..900). Bumping to 500 closes
   *  most of the visual gap with native Terminal.app, which renders heavier
   *  thanks to Core Text + subpixel AA. */
  terminalFontWeight: number;
  /** Which terminal emulation library to use:
   *   - "xterm" (default): xterm.js + WebGL addon. JS reimplementation of
   *     VT100. Battle-tested but every escape sequence is hand-coded.
   *   - "ghostty" (beta): ghostty-web - Ghostty's WASM-compiled VT100
   *     parser exposed via xterm.js-compatible API. Same parser that runs
   *     the native Ghostty app; fixes grapheme handling (Arabic /
   *     Devanagari) and XTPUSHSGR/XTPOPSGR. Canvas renderer only (no
   *     WebGL today), so very-heavy redraws may regress slightly. */
  terminalEngine: TerminalEngine;
  editorFontSize: number;
  /** Enable font ligatures (=>, !==, ...) in the editor. */
  codeLigatures: boolean;

  setEditorFontId:    (id: string) => void;
  setTerminalFontId:  (id: string) => void;
  setTerminalFontSize:(px: number) => void;
  setTerminalFontWeight:(w: number) => void;
  setEditorFontSize:  (px: number) => void;
  setCodeLigatures:   (v: boolean) => void;
  setThemeMode:       (m: ThemeMode) => void;
  /** Convenience: cycle auto → light → dark → auto. */
  cycleThemeMode:     () => void;
  setYoloMode:        (v: boolean) => void;
  setDesktopNotifications: (v: boolean) => void;
  setSettledHighlight: (v: boolean) => void;
  setTerminalEngine: (e: TerminalEngine) => void;
}

const lsGet = (k: string, fallback: string) => {
  try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
};
const lsGetNum = (k: string, fallback: number) => {
  const v = Number(lsGet(k, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};
const lsGetBool = (k: string, fallback: boolean) => lsGet(k, fallback ? "1" : "0") === "1";

const initialEditorFont   = lsGet(LS_EDITOR_FONT, "jetbrains");
const initialTerminalFont = lsGet(LS_TERMINAL_FONT, "jetbrains");
const initialTerminalSize = lsGetNum(LS_TERMINAL_SIZE, 13);
const initialTerminalWeight = lsGetNum(LS_TERMINAL_WEIGHT, 400);
const initialEditorSize   = lsGetNum(LS_EDITOR_SIZE, 13);
const initialLigatures    = lsGetBool(LS_LIGATURES, true);
const initialTheme        = (lsGet(LS_THEME, "dark") as ThemeMode);
const initialYolo         = lsGetBool(LS_YOLO, false);
const initialDesktopNotif = lsGetBool(LS_DESKTOPNOTIF, false);
const initialSettledHighlight = lsGetBool(LS_SETTLED_HIGHLIGHT, true);
// Default to xterm.js until the ghostty path has more flight time on real
// agent sessions. The toggle lets early adopters opt in immediately.
const initialTerminalEngine: TerminalEngine = (lsGet(LS_TERMINAL_ENGINE, "xterm") === "ghostty") ? "ghostty" : "xterm";

export const usePrefs = create<PrefsState>(set => ({
  themeMode: initialTheme,
  yoloMode: initialYolo,
  desktopNotifications: initialDesktopNotif,
  settledHighlight: initialSettledHighlight,
  terminalEngine: initialTerminalEngine,
  editorFontId: initialEditorFont,
  terminalFontId: initialTerminalFont,
  terminalFontSize: initialTerminalSize,
  terminalFontWeight: initialTerminalWeight,
  editorFontSize: initialEditorSize,
  codeLigatures: initialLigatures,

  setEditorFontId: (id) => {
    try { localStorage.setItem(LS_EDITOR_FONT, id); } catch {}
    applyEditorFont(id);
    set({ editorFontId: id });
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
  setTerminalFontWeight: (w) => {
    try { localStorage.setItem(LS_TERMINAL_WEIGHT, String(w)); } catch {}
    set({ terminalFontWeight: w });
  },
  setEditorFontSize: (px) => {
    try { localStorage.setItem(LS_EDITOR_SIZE, String(px)); } catch {}
    set({ editorFontSize: px });
  },
  setCodeLigatures: (v) => {
    try { localStorage.setItem(LS_LIGATURES, v ? "1" : "0"); } catch {}
    set({ codeLigatures: v });
  },
  setThemeMode: (m) => {
    try { localStorage.setItem(LS_THEME, m); } catch {}
    applyTheme(m);
    set({ themeMode: m });
  },
  setYoloMode: (v) => {
    try { localStorage.setItem(LS_YOLO, v ? "1" : "0"); } catch {}
    set({ yoloMode: v });
  },
  setDesktopNotifications: (v) => {
    try { localStorage.setItem(LS_DESKTOPNOTIF, v ? "1" : "0"); } catch {}
    set({ desktopNotifications: v });
  },
  setSettledHighlight: (v) => {
    try { localStorage.setItem(LS_SETTLED_HIGHLIGHT, v ? "1" : "0"); } catch {}
    set({ settledHighlight: v });
  },
  setTerminalEngine: (e) => {
    try { localStorage.setItem(LS_TERMINAL_ENGINE, e); } catch {}
    set({ terminalEngine: e });
    // Live takeover would require tearing down every mounted xterm/ghostty
    // instance and rebuilding it - costly and forces a PTY churn. Cheaper
    // to ask the user to reload (or to wait for the next workspace switch
    // for newly opened terminals to pick up the new engine).
  },
  cycleThemeMode: () => {
    const order: ThemeMode[] = ["auto", "light", "dark"];
    const cur = usePrefs.getState().themeMode;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    try { localStorage.setItem(LS_THEME, next); } catch {}
    applyTheme(next);
    set({ themeMode: next });
  },
}));

/** Resolve a ThemeMode to the actual class applied to <html>. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

/** Set the html element's class so the CSS palette swap kicks in. */
export function applyTheme(mode: ThemeMode) {
  const resolved = resolveTheme(mode);
  const html = document.documentElement;
  html.classList.toggle("light", resolved === "light");
  html.classList.toggle("dark",  resolved === "dark");
  // Color-scheme tells the browser to use light/dark form controls + scrollbars.
  html.style.colorScheme = resolved;
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
export const currentTerminalStack = () => stackFor(usePrefs.getState().terminalFontId);

// Apply editor font at module load so the first paint uses the right font.
applyEditorFont(initialEditorFont);
