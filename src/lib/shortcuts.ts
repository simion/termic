// Single source of truth for the app's rebindable keyboard shortcuts.
//
// Each command has a stable `id`, a human label + group (for the Shortcuts
// settings page), and a `defaultBinding`. The live handler in
// `src/hooks/useShortcuts.ts` matches incoming KeyboardEvents against the
// RESOLVED bindings (defaults merged with the user's overrides, persisted in
// the prefs store) — so adding a command here + a case there is all it takes
// to make it configurable.
//
// Modifier model mirrors the handler's long-standing one: `cmd` is true for
// EITHER Cmd or Ctrl (the app folds the two together), `shift` / `alt` are
// their own flags. `key` is a normalized token: a lowercase letter ("l"),
// punctuation ("[", "]", ","), an arrow ("ArrowUp"…), or the sentinel "1-9"
// for the "jump to tab N" range (matches any digit 1-9 with the modifiers).

export type Binding = {
  cmd: boolean;
  shift: boolean;
  alt: boolean;
  /** Normalized key token. See module header. */
  key: string;
};

export type ShortcutId =
  | "sidebar-prev"
  | "sidebar-next"
  | "workspace-prev"
  | "workspace-next"
  | "workspace-prev-arrow"
  | "workspace-next-arrow"
  | "tab-prev"
  | "tab-next"
  | "tab-prev-arrow"
  | "tab-next-arrow"
  | "jump-to-tab"
  | "focus-terminal"
  | "new-tab"
  | "close-tab"
  | "clear-terminal"
  | "new-right-split-terminal"
  | "toggle-terminal"
  | "terminal-copy"
  | "terminal-paste"
  | "new-workspace-quick"
  | "command-palette"
  | "open-settings"
  | "open-shortcuts"
  | "file-finder"
  | "find-in-files"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "broadcast"
  | "stage-file"
  | "discard-file";

export type ShortcutGroup = "Navigation" | "Tabs" | "Terminal" | "Git" | "General";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBinding: Binding;
  /** Help text shown under the label in the settings list. */
  hint?: string;
}

const B = (key: string, mods: Partial<Omit<Binding, "key">> = {}): Binding => ({
  cmd: !!mods.cmd,
  shift: !!mods.shift,
  alt: !!mods.alt,
  key,
});

// Order here = display order in the settings page (grouped by `group`).
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // Navigation
  { id: "sidebar-prev", group: "Navigation", label: "Previous sidebar row",
    hint: "Workspace or expanded tab above", defaultBinding: B("ArrowUp", { alt: true }) },
  { id: "sidebar-next", group: "Navigation", label: "Next sidebar row",
    hint: "Workspace or expanded tab below", defaultBinding: B("ArrowDown", { alt: true }) },
  { id: "workspace-prev", group: "Navigation", label: "Previous workspace",
    defaultBinding: B("[", { cmd: true }) },
  { id: "workspace-next", group: "Navigation", label: "Next workspace",
    defaultBinding: B("]", { cmd: true }) },
  { id: "workspace-prev-arrow", group: "Navigation", label: "Previous workspace (arrow)",
    defaultBinding: B("ArrowUp", { cmd: true, alt: true }) },
  { id: "workspace-next-arrow", group: "Navigation", label: "Next workspace (arrow)",
    defaultBinding: B("ArrowDown", { cmd: true, alt: true }) },

  // Tabs
  { id: "tab-prev", group: "Tabs", label: "Previous tab",
    defaultBinding: B("[", { cmd: true, shift: true }) },
  { id: "tab-next", group: "Tabs", label: "Next tab",
    defaultBinding: B("]", { cmd: true, shift: true }) },
  { id: "tab-prev-arrow", group: "Tabs", label: "Previous tab (arrow)",
    defaultBinding: B("ArrowLeft", { cmd: true, alt: true }) },
  { id: "tab-next-arrow", group: "Tabs", label: "Next tab (arrow)",
    defaultBinding: B("ArrowRight", { cmd: true, alt: true }) },
  { id: "jump-to-tab", group: "Tabs", label: "Jump to tab 1…9",
    hint: "Modifier + a number key", defaultBinding: B("1-9", { cmd: true }) },
  { id: "new-tab", group: "Tabs", label: "New tab",
    defaultBinding: B("t", { cmd: true }) },
  { id: "close-tab", group: "Tabs", label: "Close active tab",
    defaultBinding: B("w", { cmd: true }) },

  // Terminal
  { id: "focus-terminal", group: "Terminal", label: "Focus main agent",
    hint: "Jump focus to the main pane (its agent terminal or the open editor) from anywhere",
    defaultBinding: B("l", { cmd: true }) },
  { id: "clear-terminal", group: "Terminal", label: "Clear focused terminal",
    hint: "Moved from ⌘K, which now opens the command palette.",
    defaultBinding: B("k", { cmd: true, shift: true }) },
  { id: "new-right-split-terminal", group: "Terminal", label: "New right-split terminal",
    defaultBinding: B("d", { cmd: true }) },
  { id: "toggle-terminal", group: "Terminal", label: "Toggle terminal panel",
    hint: "Show + focus the bottom split, or hide it and return to the agent",
    defaultBinding: B("j", { cmd: true }) },
  // Copy / paste are LINUX/WINDOWS ONLY and handled locally in the terminal
  // panes (TerminalPane / AuxTerminal `attachCustomKeyEventHandler`), gated to
  // !IS_MAC, NOT by the global useShortcuts handler (like the Git ids below,
  // they have no `switch` case there). macOS keeps native ⌘C / ⌘V untouched, so
  // these rows are hidden from the Shortcuts settings on macOS. The Shift in the
  // defaults is load-bearing: plain Ctrl+C must stay SIGINT for the shell.
  { id: "terminal-copy", group: "Terminal", label: "Copy selection",
    hint: "Linux/Windows only. macOS uses Cmd+C natively.",
    defaultBinding: B("c", { cmd: true, shift: true }) },
  { id: "terminal-paste", group: "Terminal", label: "Paste into terminal",
    hint: "Linux/Windows only. macOS uses Cmd+V natively.",
    defaultBinding: B("v", { cmd: true, shift: true }) },

  // General
  { id: "command-palette", group: "General", label: "Command palette",
    hint: "Search every command and action", defaultBinding: B("k", { cmd: true }) },
  { id: "new-workspace-quick", group: "General", label: "New workspace…",
    hint: "Search a project and start a new workspace", defaultBinding: B("n", { cmd: true }) },
  { id: "open-settings", group: "General", label: "Open settings",
    defaultBinding: B(",", { cmd: true }) },
  { id: "open-shortcuts", group: "General", label: "Open keyboard shortcuts",
    hint: "Jump straight to this list", defaultBinding: B("/", { cmd: true }) },
  { id: "file-finder", group: "General", label: "Open file finder",
    defaultBinding: B("p", { cmd: true }) },
  { id: "find-in-files", group: "General", label: "Find in files",
    defaultBinding: B("f", { cmd: true, shift: true }) },
  { id: "toggle-left-sidebar", group: "General", label: "Toggle left sidebar",
    hint: "Collapse / expand the projects sidebar", defaultBinding: B("b", { cmd: true }) },
  { id: "toggle-right-sidebar", group: "General", label: "Toggle right sidebar",
    hint: "Show / hide the right panel", defaultBinding: B("b", { cmd: true, alt: true }) },
  { id: "broadcast", group: "General", label: "Broadcast to agents",
    defaultBinding: B("b", { cmd: true, shift: true }) },

  // Git — contextual: these act on the file selected in the Git panel and
  // are handled there (GitPanel), not the global handler. The discard
  // binding deliberately shares ⇧⌘D with the bottom-split terminal; the
  // Git panel only claims it while a file is selected, so the settings
  // "conflict" note is expected.
  { id: "stage-file", group: "Git", label: "Stage / unstage selected file",
    hint: "Toggles the Git panel's selected file in or out of staging",
    defaultBinding: B("s", { cmd: true }) },
  { id: "discard-file", group: "Git", label: "Discard selected file",
    hint: "Restores the selected file to HEAD after a confirm",
    defaultBinding: B("d", { cmd: true, shift: true }) },
];

export const GROUP_ORDER: ShortcutGroup[] = ["Navigation", "Tabs", "Terminal", "Git", "General"];

/** Groups of rebindable commands that intentionally share a binding and can
 *  NEVER fire at the same time, so the Shortcuts settings page must not flag
 *  them as conflicts. Empty for now: ⇧⌘D is a hard-coded alias for ⌘J
 *  (toggle-terminal) handled outside the rebindable set, and `discard-file`
 *  (also ⇧⌘D) only acts while the Git panel has a file selected, so neither
 *  appears here. */
export const NON_CONFLICTING_GROUPS: ShortcutId[][] = [];

export type BindingMap = Record<ShortcutId, Binding>;

export const DEFAULT_BINDINGS: BindingMap = Object.fromEntries(
  SHORTCUT_DEFS.map(d => [d.id, d.defaultBinding]),
) as BindingMap;

/** Normalize a live KeyboardEvent's key to the same token space as `Binding.key`. */
export function eventKeyToken(e: KeyboardEvent): string {
  const k = e.key;
  if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  return k; // ArrowUp / "[" / "]" / "," / digits …
}

/** True when the event's modifiers + key satisfy the binding. The "1-9"
 *  sentinel matches any digit 1-9 with the binding's modifiers. */
export function bindingMatches(e: KeyboardEvent, b: Binding | undefined): boolean {
  if (!b) return false;
  // LINUX/WINDOWS: folding Ctrl into `cmd` is safe on macOS (the shell uses
  // the physically-separate Ctrl key, the app uses Cmd) but hijacks readline
  // off macOS — Ctrl+W (close-tab), Ctrl+K (clear-terminal), Ctrl+T (new-tab),
  // Ctrl+P (file-finder) are all emacs/readline editing keys. `focus-terminal`
  // dodges this via its isTyping guard; the others don't. Before shipping a
  // real Linux/Windows build, gate this fold so Ctrl is only the app modifier
  // when focus is NOT inside a terminal (or require Meta specifically on those
  // platforms). See the matching note in useShortcuts.ts.
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd !== b.cmd || e.shiftKey !== b.shift || e.altKey !== b.alt) return false;
  if (b.key === "1-9") return /^[1-9]$/.test(e.key);
  return eventKeyToken(e) === b.key;
}

/** Build a Binding from a recorded keydown. Returns null for a bare modifier
 *  press (no real key yet). `digitMode` collapses a recorded digit into the
 *  "1-9" range sentinel (used by the jump-to-tab row). */
export function bindingFromEvent(e: KeyboardEvent, digitMode = false): Binding | null {
  const k = e.key;
  if (k === "Meta" || k === "Control" || k === "Shift" || k === "Alt" || k === "CapsLock") {
    return null;
  }
  let key: string;
  if (/^[a-zA-Z]$/.test(k)) key = k.toLowerCase();
  else if (/^[0-9]$/.test(k)) key = digitMode ? "1-9" : k;
  else key = k;
  return { cmd: e.metaKey || e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key };
}

/** At least one of Cmd/Ctrl or Option must be present, otherwise the binding
 *  would swallow ordinary typing (or Shift+letter = capitals) everywhere. */
export function isValidBinding(b: Binding): boolean {
  return b.cmd || b.alt;
}

/** True on macOS. The handler folds Cmd≡Ctrl so shortcuts FIRE on every
 *  platform (Ctrl+L on Linux/Windows hits the same command as ⌘L on a Mac);
 *  this flag only changes how modifiers are LABELLED. Detected once from the
 *  user agent — synchronous, unlike Tauri's async `platform()`. */
export const IS_MAC: boolean = (() => {
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || "");
})();

/** The Cmd-or-Ctrl modifier reads as "Cmd" on macOS, "Ctrl" elsewhere; the
 *  Option-or-Alt modifier reads as "Option" on macOS, "Alt" elsewhere. */
export const CMD_LABEL = IS_MAC ? "Cmd" : "Ctrl";
export const ALT_LABEL = IS_MAC ? "Option" : "Alt";

const ARROW_GLYPH: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

/** Platform-appropriate human label for a display glyph. Modifier words track
 *  the OS convention; arrows + named keys are universal; letters / digits /
 *  punctuation render as themselves. */
export function glyphLabel(glyph: string): string {
  switch (glyph) {
    case "⌘": return CMD_LABEL;
    case "⌥": return ALT_LABEL;
    case "⌃": return "Ctrl";
    case "⇧": return "Shift";
    case "↑": return "Up";
    case "↓": return "Down";
    case "←": return "Left";
    case "→": return "Right";
    case "↩": return "Return";
    case "␣": return "Space";
    case ",": return "Comma";
    default: return glyph;
  }
}

/** Render a key token as a display glyph (↑, 1…9, L, [ …). */
export function keyGlyph(key: string): string {
  if (key === "1-9") return "1…9";
  if (ARROW_GLYPH[key]) return ARROW_GLYPH[key];
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return key;
}

/** Ordered glyph chips for a binding, e.g. ["⌥","⌘","↑"] or ["⌘","1…9"].
 *  Modifier order matches the app's historic strings: ⌥, ⇧, ⌘, then key. */
export function bindingGlyphs(b: Binding): string[] {
  const out: string[] = [];
  if (b.alt) out.push("⌥");
  if (b.shift) out.push("⇧");
  if (b.cmd) out.push("⌘");
  out.push(keyGlyph(b.key));
  return out;
}

/** Stable signature for conflict detection (two ids sharing one = a clash). */
export function bindingSignature(b: Binding): string {
  return `${b.cmd ? "C" : ""}${b.shift ? "S" : ""}${b.alt ? "A" : ""}:${b.key}`;
}

export function bindingsEqual(a: Binding | undefined, b: Binding | undefined): boolean {
  if (!a || !b) return false;
  return a.cmd === b.cmd && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}
