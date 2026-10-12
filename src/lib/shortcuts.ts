// Single source of truth for the app's rebindable keyboard shortcuts.
//
// Each command has a stable `id`, a `group` (for the Shortcuts settings page)
// and a `defaultBinding`. Its user-visible wording is NOT here: it lives in
// the locale files, keyed by id, and `lib/shortcutCopy.ts` is the map (both
// the settings page and the ⌘/ sheet read it, so they cannot drift). The live
// handler in
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
import { IS_LINUX, IS_MAC } from "./platform";

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
  | "nav-back"
  | "nav-forward"
  | "task-prev-arrow"
  | "task-next-arrow"
  | "jump-next-waiting"
  | "tab-prev"
  | "tab-next"
  | "tab-prev-arrow"
  | "tab-next-arrow"
  | "jump-to-tab"
  | "focus-terminal"
  | "new-tab"
  | "new-scratchpad"
  | "close-tab"
  | "clear-terminal"
  | "split-pane-right"
  | "split-pane-below"
  | "toggle-terminal"
  | "terminal-copy"
  | "terminal-paste"
  | "new-task-quick"
  | "command-palette"
  | "change-theme"
  | "open-settings"
  | "file-finder"
  | "task-finder"
  | "find-in-files"
  | "toggle-left-sidebar"
  | "toggle-right-sidebar"
  | "broadcast"
  | "prompt-palette"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "create-pr"
  | "stage-file"
  | "discard-file"
  | "add-selection-to-agent"
  | "go-to-definition"
  | "find-usages"
  | "go-to-implementation"
  | "go-to-type-definition"
  | "file-structure"
  | "search-everywhere";

export type ShortcutGroup =
  | "Navigation" | "Code navigation" | "Tabs" | "Terminal" | "Git" | "General";

export interface ShortcutDef {
  id: ShortcutId;
  group: ShortcutGroup;
  /** null = ships unbound. Only a command that has another way in may do
   *  this (search-everywhere has double-Shift); everything else needs a key,
   *  or it is a command nobody can reach. Reset puts null back. */
  defaultBinding: Binding | null;
  /** A second trigger that is not a chord, drawn as a select beside the
   *  recorder on the same row. The chord and the gesture are independent:
   *  either can be off while the other works. */
  gesture?: "double-shift";
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
  { id: "sidebar-prev", group: "Navigation",
    defaultBinding: B("ArrowUp", { alt: true }) },
  { id: "sidebar-next", group: "Navigation",
    defaultBinding: B("ArrowDown", { alt: true }) },
  // ⌘[ / ⌘] mean BACK and FORWARD, and nothing else.
  //
  // They used to switch tasks as well, with the folder listing and then the
  // jump trail claiming them conditionally on top — three meanings for one
  // chord, decided by where the focus happened to be. Switching tasks was the
  // redundant one: ⌥⌘↑ / ⌥⌘↓ already do it (and do it in a split too), and
  // tabs have ⇧⌘[ / ⇧⌘]. One key, one idea: go back to where I just was.
  { id: "nav-back", group: "Navigation",
    defaultBinding: B("[", { cmd: true }) },
  // Code navigation (GH #174). These fire only while an editor has focus, and
  // only on a checkout the reader has switched it on for; they are listed here
  // like any other key, because a shortcut nobody can find is a feature nobody
  // has. The defaults are IntelliJ's, which is where most of this app's users
  // learned them.
  { id: "go-to-definition", group: "Code navigation",
    defaultBinding: B("F12") },
  { id: "find-usages", group: "Code navigation",
    defaultBinding: B("F12", { shift: true }) },
  // NOT IntelliJ's ⌥⌘B and ⌃⇧B. ⌥⌘B already toggles the right sidebar here,
  // and the editor's copy of it fired on top of that (this table's own
  // duplicate-chord test is what surfaced it). ⌃⇧B cannot be expressed at all:
  // a Binding folds Ctrl into Cmd, so on a Mac it would read as ⌘⇧B.
  { id: "go-to-implementation", group: "Code navigation",
    defaultBinding: B("b", { alt: true, shift: true }) },
  { id: "go-to-type-definition", group: "Code navigation",
    defaultBinding: B("t", { alt: true, shift: true }) },
  { id: "file-structure", group: "Code navigation",
    defaultBinding: B("F12", { cmd: true }) },
  // Double-Shift is JetBrains' gesture for this, and stays (a select on the
  // same row picks when it applies). The chord is for whoever wants a key
  // they can press on purpose. Unbound by default: every free chord is
  // somebody's muscle memory, and the gesture already answers "how do I open
  // it" for everyone else.
  { id: "search-everywhere", group: "Code navigation",
    defaultBinding: null, gesture: "double-shift" },
  { id: "nav-forward", group: "Navigation",
    defaultBinding: B("]", { cmd: true }) },
  { id: "task-prev-arrow", group: "Navigation",
    defaultBinding: B("ArrowUp", { cmd: true, alt: true }) },
  { id: "task-next-arrow", group: "Navigation",
    defaultBinding: B("ArrowDown", { cmd: true, alt: true }) },
  { id: "jump-next-waiting", group: "Navigation",
    defaultBinding: B("a", { cmd: true, shift: true }) },

  // Tabs
  { id: "tab-prev", group: "Tabs",
    defaultBinding: B("[", { cmd: true, shift: true }) },
  { id: "tab-next", group: "Tabs",
    defaultBinding: B("]", { cmd: true, shift: true }) },
  { id: "tab-prev-arrow", group: "Tabs",
    defaultBinding: B("ArrowLeft", { cmd: true, alt: true }) },
  { id: "tab-next-arrow", group: "Tabs",
    defaultBinding: B("ArrowRight", { cmd: true, alt: true }) },
  { id: "jump-to-tab", group: "Tabs",
    defaultBinding: B("1-9", { cmd: true }) },
  { id: "new-tab", group: "Tabs",
    defaultBinding: B("t", { cmd: true }) },
  { id: "new-scratchpad", group: "Tabs",
    // NOT ⌘N — that is already "New task…" and stealing it would cost the
    // app's most-used create. ⌥⌘N is free (⌥⌘B and ⌥⌘P are the other two
    // Option-Cmd bindings) and rebindable like everything else.
    defaultBinding: B("n", { cmd: true, alt: true }) },
  { id: "close-tab", group: "Tabs",
    defaultBinding: B("w", { cmd: true }) },

  // Terminal
  { id: "focus-terminal", group: "Terminal",
    defaultBinding: B("l", { cmd: true }) },
  { id: "clear-terminal", group: "Terminal",
    defaultBinding: B("k", { cmd: true }) },
  { id: "split-pane-right", group: "Terminal",
    defaultBinding: B("d", { cmd: true }) },
  { id: "split-pane-below", group: "Terminal",
    defaultBinding: B("d", { cmd: true, shift: true }) },
  { id: "toggle-terminal", group: "Terminal",
    defaultBinding: B("j", { cmd: true }) },
  // Copy / paste are LINUX/WINDOWS ONLY and handled locally in the terminal
  // panes (TerminalPane / AuxTerminal `attachCustomKeyEventHandler`), gated to
  // !IS_MAC, NOT by the global useShortcuts handler (like the Git ids below,
  // they have no `switch` case there). macOS keeps native ⌘C / ⌘V untouched, so
  // these rows are hidden from the Shortcuts settings on macOS. The Shift in the
  // defaults is load-bearing: plain Ctrl+C must stay SIGINT for the shell.
  { id: "terminal-copy", group: "Terminal",
    defaultBinding: B("c", { cmd: true, shift: true }) },
  { id: "terminal-paste", group: "Terminal",
    defaultBinding: B("v", { cmd: true, shift: true }) },

  // General
  { id: "command-palette", group: "General",
    defaultBinding: B("p", { cmd: true, shift: true }) },
  { id: "change-theme", group: "General",
    defaultBinding: B("t", { cmd: true, alt: true }) },
  { id: "new-task-quick", group: "General",
    defaultBinding: B("n", { cmd: true }) },
  { id: "open-settings", group: "General",
    defaultBinding: B(",", { cmd: true }) },
  { id: "file-finder", group: "General",
    defaultBinding: B("p", { cmd: true }) },
  { id: "task-finder", group: "General",
    defaultBinding: B("o", { cmd: true }) },
  { id: "find-in-files", group: "General",
    defaultBinding: B("f", { cmd: true, shift: true }) },
  { id: "toggle-left-sidebar", group: "General",
    defaultBinding: B("b", { cmd: true }) },
  { id: "toggle-right-sidebar", group: "General",
    defaultBinding: B("b", { cmd: true, alt: true }) },
  { id: "broadcast", group: "General",
    defaultBinding: B("b", { cmd: true, shift: true }) },
  { id: "prompt-palette", group: "General",
    defaultBinding: B("p", { cmd: true, alt: true }) },
  { id: "zoom-in", group: "General",
    defaultBinding: B("=", { cmd: true }) },
  { id: "zoom-out", group: "General",
    defaultBinding: B("-", { cmd: true }) },
  { id: "zoom-reset", group: "General",
    defaultBinding: B("0", { cmd: true }) },
  // Contextual (editor): handled in EditorPane, not the global switch, and
  // only when that editor holds focus AND has a non-empty selection. Any
  // other time the key falls through untouched. ⇧⌘L is the convention every
  // agent-first editor landed on for this (Cursor's "Add selection to Chat",
  // VS Code Copilot's "Add Selection to Chat"), and it sits next to termic's
  // own ⌘L "focus main agent".
  { id: "add-selection-to-agent", group: "General",
    defaultBinding: B("l", { cmd: true, shift: true }) },

  { id: "create-pr", group: "Git",
    defaultBinding: B("r", { cmd: true, alt: true }) },

  // Git — contextual: these act on the file selected in the Git panel and
  // are handled there (GitPanel), not the global handler. The discard
  // binding deliberately shares ⇧⌘D with the bottom-split terminal; the
  // Git panel only claims it while a file is selected, so the settings
  // "conflict" note is expected.
  { id: "stage-file", group: "Git",
    defaultBinding: B("s", { cmd: true }) },
  { id: "discard-file", group: "Git",
    defaultBinding: B("d", { cmd: true, shift: true }) },
];

export const GROUP_ORDER: ShortcutGroup[] =
  ["Navigation", "Code navigation", "Tabs", "Terminal", "Git", "General"];

/**
 * Shortcuts that are a GESTURE rather than a chord.
 *
 * Kept OUT of `SHORTCUT_DEFS` deliberately. Everything there is a `Binding`,
 * and a Binding is one chord pressed at once: the bindings map, the conflict
 * check, the chord recorder and the localStorage migration all assume it.
 * Recently used tabs is hold-a-modifier-and-tap, it needs keyup, and it has
 * to tell Ctrl from Cmd, which a Binding folds together.
 *
 * Its keys are recordable all the same (a `HoldGesture`, in the prefs store
 * as `recentTabsGesture`), with a recorder of its own on the row. Search
 * everywhere used to be listed here too; it is a def now, with a chord that
 * ships unbound and its double-Shift select (`ShortcutDef.gesture`).
 */
export type GestureShortcutId = "recent-tabs";

export interface GestureShortcut {
  id: GestureShortcutId;
  group: ShortcutGroup;
  /** What the row carries in Settings. `hold-tap`: a HoldGesture recorder
   *  plus the on/off select. */
  control: "hold-tap";
}

export const GESTURE_SHORTCUTS: GestureShortcut[] = [
  { id: "recent-tabs", group: "Navigation", control: "hold-tap" },
];

// ── Hold gestures (recently used tabs) ──────────────────────────────────
//
// Hold one modifier, tap a key, release the modifier to land. The modifier is
// the user's choice, and so is the key, recorded as `KeyboardEvent.code` (the
// physical key) rather than `key`: with Option held, macOS turns letters into
// other characters and ` into a dead key (`key: "Dead"`), so `key` would
// record something different on every layout.

export type HoldModifier = "ctrl" | "alt" | "cmd";

export interface HoldGesture {
  hold: HoldModifier;
  /** `KeyboardEvent.code`: "Tab", "Backquote", "KeyJ"... */
  code: string;
}

export const DEFAULT_RECENT_TABS: HoldGesture = { hold: "ctrl", code: "Tab" };

/** A refusal about the tapped key. Each names the held modifier (`mod`) and
 *  the keys that DO work with it here (`allowed`), so the message leads to a
 *  gesture that records instead of to another refusal. */
export type HoldKeyErrorKind =
  | "holdRecorderKey" | "holdMovesCursor" | "holdTerminalKey" | "holdTypes" | "holdMetaKey" | "holdAppKey";

/** Why a recorded hold gesture was refused. Each `kind` is a locale key under
 *  `settings:shortcuts.*`; `keys` fills `holdOsReserved`. */
export type HoldError =
  | { kind: "holdNeedsOne" }
  | { kind: "holdOsReserved"; keys: string }
  | { kind: HoldKeyErrorKind; mod: string; allowed: string };

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "MetaLeft", "MetaRight", "OSLeft", "OSRight", "CapsLock", "Fn", "FnLock", "AltGraph",
]);
const MODIFIER_NAMES = new Set([
  "Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "Super", "OS", "Fn",
]);

/** What each punctuation code is called as a binding token and as a glyph.
 *  Letters (KeyX) and digits (DigitN) are derived. */
const CODE_CHAR: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  IntlBackslash: "§",
};

/** The `code` a key would have, for an event that does not carry one (some
 *  synthetic events). Tab, letters, digits and the punctuation above. */
function codeFromKey(key: string): string {
  if (key === "Tab") return "Tab";
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  for (const [code, ch] of Object.entries(CODE_CHAR)) if (ch === key) return code;
  return "";
}

/** The physical key of an event: `code`, which every real key reports, or a
 *  reconstruction from `key` when it is missing. */
export function eventCode(e: Pick<KeyboardEvent, "code" | "key">): string {
  return e.code || codeFromKey(e.key);
}

/** A code as a Binding key token ("KeyJ" -> "j", "Tab" -> "Tab"), which is
 *  how a gesture is compared with a chord for conflicts. */
export function tokenForCode(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_CHAR[code] ?? code;
}

/** A code as the glyph a key chip prints ("Tab" -> "⇥", "KeyJ" -> "J"). */
export function codeGlyph(code: string): string {
  if (code === "Tab") return "⇥";
  if (code === "Space") return "␣";
  if (code === "Enter") return "↩";
  return keyGlyph(tokenForCode(code));
}

const HOLD_GLYPH: Record<HoldModifier, string> = { ctrl: "⌃", alt: "⌥", cmd: "⌘" };

/** Chips for a gesture: the held modifier, then the tapped key. */
export function holdGestureGlyphs(g: HoldGesture): string[] {
  return [HOLD_GLYPH[g.hold], codeGlyph(g.code)];
}

/** The name of the held modifier, for prose ("Hold Option and tap `"). */
export function holdModifierName(hold: HoldModifier, isMac: boolean = IS_MAC): string {
  if (hold === "ctrl") return "Ctrl";
  if (hold === "alt") return isMac ? "Option" : "Alt";
  return isMac ? "Cmd" : "Win";
}

/** A gesture as one string: `⌃⇥` on macOS, `Ctrl+Tab` elsewhere. */
export function holdGestureText(g: HoldGesture, isMac: boolean = IS_MAC): string {
  if (isMac) return holdGestureGlyphs(g).join("");
  return `${holdModifierName(g.hold, false)}+${glyphLabel(codeGlyph(g.code))}`;
}

/** The modifiers a hold gesture may use here, for the "hold exactly one of"
 *  message. Cmd is only a choice on macOS: off it, the Windows / Super key
 *  belongs to the desktop. */
export function holdModifierChoices(isMac: boolean = IS_MAC): string {
  return isMac ? "Ctrl, Option, Cmd" : "Ctrl, Alt";
}

const ALNUM_CODE = /^(Key[A-Z]|Digit[0-9])$/;

/** Every key that has a character: letters, digits, and the punctuation in
 *  CODE_CHAR (IntlBackslash included). */
function typesCharacter(code: string): boolean {
  return ALNUM_CODE.test(code) || code in CODE_CHAR;
}

/** Ctrl with these sends a C0 control character down a terminal: ^[ is ESC,
 *  ^\ SIGQUIT, ^] GS (xterm's own table), ^/ and ^- (^_ with Shift, which
 *  the walk's reverse adds) readline's undo, ^` NUL in most terminals. */
const CTRL_CONTROL_CODES = new Set(["BracketLeft", "BracketRight", "Backslash", "Slash", "Minus", "Backquote"]);

/** Keys that move a cursor with every modifier on some platform: Option and
 *  Ctrl+arrow by word, ⌘+arrow to the line's ends, Home / End / Page. ⌃+arrow
 *  on macOS is Mission Control. */
const CURSOR_CODES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Off macOS, what Windows and the Linux desktops do with Alt held: Tab
 *  switches windows, F4 closes one, Space opens the window menu, ` switches
 *  between an application's windows (GNOME), and F1, F2, F7, F8, F10 are
 *  GNOME's overview, run dialog, move, resize and maximize. */
const ALT_OS_CODES = new Set(["Tab", "F4", "Space", "Backquote", "F1", "F2", "F7", "F8", "F10"]);

/** The keys a hold on `hold` can be recorded with on this platform, as the
 *  refusals print them ("Keys that work with Ctrl: ..."). A sample that is
 *  sure to record, not an exhaustive list: function keys work too. Kept next
 *  to `holdGestureError`, whose rules it has to agree with
 *  (`shortcuts.test.ts` records every key it names). */
export function holdAllowedKeys(hold: HoldModifier, isMac: boolean = IS_MAC): string {
  if (hold === "ctrl") return "Tab ; ' , . =";
  if (hold === "alt") return isMac ? "Tab" : "F3 F5 F6 F9 F11 F12";
  return isMac ? "; ' , ." : "";
}

function keyError(kind: HoldKeyErrorKind, hold: HoldModifier, isMac: boolean): HoldError {
  return { kind, mod: holdModifierName(hold, isMac), allowed: holdAllowedKeys(hold, isMac) };
}

/** The rule the recorder and the stored-value parser share. null when the
 *  gesture is one Termic can see and may own. */
export function holdGestureError(g: HoldGesture, isMac: boolean = IS_MAC): HoldError | null {
  if (!g.code || MODIFIER_CODES.has(g.code)) return { kind: "holdNeedsOne" };
  if (isMac) {
    // ⌘⇥ is the app switcher, ⌘` the next window, ⌘Space Spotlight, ⌃Space
    // the input source switcher: the system takes them before the webview
    // sees them.
    if ((g.hold === "cmd" && (g.code === "Tab" || g.code === "Space" || g.code === "Backquote"))
        || (g.hold === "ctrl" && g.code === "Space")) {
      return { kind: "holdOsReserved", keys: holdGestureText(g, true) };
    }
  } else if (g.hold === "cmd" || (g.hold === "alt" && ALT_OS_CODES.has(g.code))) {
    // The Windows / Super key is the desktop's whatever it is held with.
    return { kind: "holdOsReserved", keys: holdGestureText(g, false) };
  }
  // Keys that confirm, clear or type in the recorder itself.
  if (g.code === "Enter" || g.code === "NumpadEnter" || g.code === "Backspace"
      || g.code === "Escape" || g.code === "Space") {
    return keyError("holdRecorderKey", g.hold, isMac);
  }
  if (CURSOR_CODES.has(g.code)) return keyError("holdMovesCursor", g.hold, isMac);
  // Ctrl+letter is readline's (^R, ^P, ^W...), and the gesture claims its key
  // before xterm sees it, so it would take one away from every shell. The
  // same for the punctuation that makes a control character.
  if (g.hold === "ctrl" && (ALNUM_CODE.test(g.code) || CTRL_CONTROL_CODES.has(g.code))) {
    return keyError("holdTerminalKey", g.hold, isMac);
  }
  if (g.hold === "alt" && typesCharacter(g.code)) {
    // macOS: Option + any of these types a character (å, …, æ) or starts one
    // (` is the dead key for à and è). preventDefault would stop the
    // composition, but the point is the character: claiming the key takes
    // it away from every editor and prompt. Elsewhere Alt is Meta to the
    // terminal: Alt+B and Alt+F move by word, Alt+. yanks the last argument.
    return keyError(isMac ? "holdTypes" : "holdMetaKey", g.hold, isMac);
  }
  // ⌘ + letter or digit is copy, paste, cut, undo, quit, close... The walk's
  // capture listener preventDefaults every press of the gesture, so ⌘C here
  // would kill copy app-wide, and `conflicts` cannot say so: ⌘C / ⌘V are not
  // SHORTCUT_DEFS, they are the system's.
  if (g.hold === "cmd" && ALNUM_CODE.test(g.code)) return keyError("holdAppKey", g.hold, isMac);
  return null;
}

/** Read a stored gesture. Anything unreadable, or a gesture this platform
 *  cannot use (Cmd synced over from a Mac to Linux), reads as the default.
 *  Read time only: the stored value is never rewritten, so the Mac it came
 *  from keeps its choice. */
export function parseHoldGesture(raw: string | null, isMac: boolean = IS_MAC): HoldGesture {
  if (!raw) return DEFAULT_RECENT_TABS;
  try {
    const v = JSON.parse(raw) as Partial<HoldGesture> | null;
    if (!v || typeof v !== "object") return DEFAULT_RECENT_TABS;
    if (v.hold !== "ctrl" && v.hold !== "alt" && v.hold !== "cmd") return DEFAULT_RECENT_TABS;
    if (typeof v.code !== "string" || !/^[A-Za-z0-9]+$/.test(v.code)) return DEFAULT_RECENT_TABS;
    const g: HoldGesture = { hold: v.hold, code: v.code };
    return holdGestureError(g, isMac) ? DEFAULT_RECENT_TABS : g;
  } catch {
    return DEFAULT_RECENT_TABS;
  }
}

export function holdGesturesEqual(a: HoldGesture, b: HoldGesture): boolean {
  return a.hold === b.hold && a.code === b.code;
}

function altGraph(e: KeyboardEvent): boolean {
  return typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
}

/** A recorded keydown as a hold gesture. null for a bare modifier press (the
 *  user is on the way to the key); an error for a combination Termic cannot
 *  or must not own. Shift is ignored: it is how the walk reverses. */
export function holdGestureFromEvent(
  e: KeyboardEvent, isMac: boolean = IS_MAC,
): HoldGesture | { error: HoldError } | null {
  if (MODIFIER_NAMES.has(e.key) || MODIFIER_CODES.has(e.code)) return null;
  const code = eventCode(e);
  // AltGr reports as Ctrl+Alt in Chromium, and either way it is a typing key.
  const ag = altGraph(e);
  const held: HoldModifier[] = [];
  if (e.ctrlKey && !ag) held.push("ctrl");
  if (e.altKey && !ag) held.push("alt");
  if (e.metaKey || (!isMac && superIsHeld())) held.push("cmd");
  // The desktop's own chords first: telling somebody who pressed ⌘⇥ to hold
  // exactly one modifier would be telling them what they already did.
  for (const hold of held) {
    const err = holdGestureError({ hold, code }, isMac);
    if (err?.kind === "holdOsReserved") return { error: err };
  }
  if (held.length !== 1) return { error: { kind: "holdNeedsOne" } };
  const g: HoldGesture = { hold: held[0], code };
  const err = holdGestureError(g, isMac);
  return err ? { error: err } : g;
}

/** Exactly the gesture's modifier is down (Shift aside, which reverses).
 *  Alt excludes AltGr, a typing key on most European layouts. */
export function holdHeld(e: KeyboardEvent, hold: HoldModifier): boolean {
  switch (hold) {
    case "ctrl": return e.ctrlKey && !e.metaKey && !e.altKey;
    case "alt": return e.altKey && !e.ctrlKey && !e.metaKey && !altGraph(e);
    case "cmd": return e.metaKey && !e.ctrlKey && !e.altKey;
  }
}

/** The gesture's modifier has come up, so the walk lands. Read off the flag
 *  rather than `key === "Control"`, which misses a release that arrives while
 *  another modifier is down, and every synthetic sequence. */
export function holdReleased(e: KeyboardEvent, hold: HoldModifier): boolean {
  switch (hold) {
    case "ctrl": return !e.ctrlKey;
    case "alt": return !e.altKey;
    case "cmd": return !e.metaKey;
  }
}

/** When the double-Shift gesture opens Search everywhere.
 *
 *    off              never.
 *    left             two taps of the LEFT Shift (the default). The right one
 *                     is what a touch typist holds for left-hand capitals,
 *                     which is where the accidental opens come from.
 *    outside-terminal either Shift, but never while a terminal has focus.
 *    any              either Shift, JetBrains' own behaviour.
 *
 *  Declared HERE rather than in the prefs store: prefs already imports this
 *  module for the bindings, so the other direction would be a cycle. */
export type DoubleShiftMode = "off" | "left" | "outside-terminal" | "any";

/** When double-Shift opens Search everywhere, as the user picks it.
 *
 *  Ordered off-to-most-permissive, so the list reads as a dial. Shared by the
 *  Shortcuts page (the select) and the command sheet (which prints the
 *  current one where a recorder would be), so those two cannot disagree: both
 *  name a mode through `doubleShiftModeLabel` in lib/shortcutCopy.ts, and the
 *  wording rule (every label names the WHOLE gesture, because the row prints
 *  nothing else beside the select) is stated there. */
export const DOUBLE_SHIFT_MODES: DoubleShiftMode[] =
  ["off", "left", "outside-terminal", "any"];

/** Whether the recently-used-tabs gesture (⌃⇥ unless rebound) is on.
 *
 *  Declared here, next to DOUBLE_SHIFT_MODES and for the same reason: prefs
 *  already imports this module for the bindings, so the other direction would
 *  be a cycle.
 *
 *  On/off rather than the four modes double-Shift needs, because the awkward
 *  question that one answers ("should this fire while I am typing?") is
 *  answered by the recorder instead: holdGestureError refuses a key that
 *  types with the held modifier (Option + anything with a character), one
 *  the terminal reads (Ctrl + letter or control character, Alt as Meta off
 *  macOS), one that moves the cursor, and the app's and system's own (⌘C,
 *  ⌘⇥). What is left is Tab and a few symbol keys that do nothing there.
 *  The id keeps its historic name so stored prefs carry over. */
export type CtrlTabMode = "off" | "on";

/** Labelled plain Off / On: the gesture itself sits on the recorder beside
 *  the select, so the option no longer spells it out (and could not, now that
 *  it can be any modifier and key). */
export const CTRL_TAB_MODES: CtrlTabMode[] = ["off", "on"];

/** Groups of rebindable commands that intentionally share a binding and can
 *  NEVER fire at the same time, so the Shortcuts settings page must not flag
 *  them as conflicts. `split-pane-below` and `discard-file` share ⇧⌘D:
 *  the Git panel captures the key only when a file is selected and
 *  stopPropagation()s, so the terminal handler never sees it in that case. */
export const NON_CONFLICTING_GROUPS: ShortcutId[][] = [
  ["split-pane-below", "discard-file"],
];

/** null = unbound, which only a def whose default is null can be. */
export type BindingMap = Record<ShortcutId, Binding | null>;

export const DEFAULT_BINDINGS: BindingMap = Object.fromEntries(
  SHORTCUT_DEFS.map(d => [d.id, d.defaultBinding]),
) as BindingMap;

// ── Linux: the Super key ────────────────────────────────────────────────
//
// On macOS Cmd is `metaKey`, and on Windows so is the Win key, which is what
// makes Win+J toggle the terminal from INSIDE a terminal: xterm leaves a meta
// chord alone, where it keeps Ctrl+J for the shell (it is a line feed).
//
// WebKitGTK reports none of that. Measured with real X key events (WebKitGTK
// 2.52): holding Super and pressing J delivers a keydown with `key: "j"`,
// `metaKey: false`, and `getModifierState` false for "Super", "OS", "Meta"
// and "Hyper" alike. The chord is indistinguishable from typing a j. What
// DOES arrive is the Super key's own keydown and keyup (`key: "Super"`,
// `code: "OSLeft"` / `"OSRight"`), so the held state is tracked here and
// folded into `cmd` like the other two.
//
// The cost of tracking is a missed keyup: GNOME takes the focus for its
// overview when Super is released alone, and the release can go with it. A
// stuck flag would turn every typed j into a shortcut, so losing focus clears
// it.
let superHeld = false;

function isSuperKey(e: KeyboardEvent): boolean {
  return e.key === "Super" || e.key === "OS" || e.code === "OSLeft" || e.code === "OSRight"
    || e.code === "MetaLeft" || e.code === "MetaRight";
}

if (IS_LINUX && typeof window !== "undefined") {
  // Capture phase: xterm and CodeMirror stop some keys before they bubble.
  window.addEventListener("keydown", e => { if (isSuperKey(e)) superHeld = true; }, true);
  window.addEventListener("keyup", e => { if (isSuperKey(e)) superHeld = false; }, true);
  window.addEventListener("blur", () => { superHeld = false; });
  document.addEventListener("visibilitychange", () => { superHeld = false; });
}

/** Linux only: Super is down, so the key being pressed is an app shortcut
 *  and not text. A terminal asks this to keep the letter out of the PTY. */
export function superIsHeld(): boolean {
  return IS_LINUX && superHeld;
}

/** Test seam: there is no way to hold a key between two synthetic events. */
export function setSuperHeldForTests(v: boolean): void {
  superHeld = v;
}

/** The app's "Cmd" for a live event: Cmd on macOS, Ctrl or the Win key on
 *  Windows, Ctrl or Super on Linux. */
export function eventCmd(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || superIsHeld();
}

const TERMINAL_OWN: ReadonlySet<ShortcutId> = new Set<ShortcutId>(["terminal-copy", "terminal-paste", "find-in-files"]);

/** Off macOS: is this key one of the app's chords that a TERMINAL should let
 *  go? The rule is the one the terminals always stated: Ctrl is the app's
 *  Cmd there, plain Ctrl+letter belongs to the shell (Ctrl+P is readline's
 *  previous line), and a chord that also carries Shift or Alt does not.
 *
 *  It used to be applied to four hand-picked shortcuts, so Ctrl+Alt+Left
 *  (pane left), Ctrl+Alt+P (prompt palette) and every other Ctrl+Alt chord
 *  went to the PTY as an escape sequence instead. That mattered more on
 *  Linux than it looks: GNOME keeps Super+Alt+arrows for itself, so the
 *  Super form of those is not there to fall back on.
 *
 *  Always false on macOS, where Cmd is its own key and the terminals pass a
 *  short explicit list (`PASS_TO_APP`). */
export function isAppChordInTerminal(e: KeyboardEvent, binds: Partial<BindingMap>): boolean {
  if (IS_MAC) return false;
  for (const d of SHORTCUT_DEFS) {
    // The terminal's OWN: copy, paste, and Ctrl+Shift+F, which inside a
    // terminal is that terminal's find. Their handlers sit around the call
    // sites in no fixed order, so they are excluded here, not by position.
    if (TERMINAL_OWN.has(d.id)) continue;
    const b = binds[d.id];
    if (b && b.cmd && (b.shift || b.alt) && bindingMatches(e, b)) return true;
  }
  return false;
}

/** The few app chords a focused TERMINAL hands to the app instead of the
 *  PTY (TerminalPane's `PASS_TO_APP`). xterm would otherwise send the key down
 *  and preventDefault it, so the window handler never fires.
 *
 *  On macOS only the Cmd press is taken. `bindingMatches` folds Ctrl into
 *  `cmd`, so ⌘R bound to a command would match ⌃R as well; but Ctrl is the
 *  terminal's own modifier there (GH #10), and useShortcuts bails on a Ctrl
 *  chord in a terminal, so a ⌃R handed over would reach neither the shell
 *  (reverse search) nor the app. Off macOS the app's Cmd is Ctrl, and plain
 *  Ctrl+letter belongs to the shell (Ctrl+P is readline's previous line), so
 *  only a binding that also carries Shift or Alt is taken there. */
export function terminalPassesToApp(
  e: KeyboardEvent, binds: Partial<BindingMap>, ids: readonly ShortcutId[], isMac: boolean = IS_MAC,
): boolean {
  return ids.some(id => {
    const b = binds[id];
    const allowed = isMac ? e.metaKey : !!b?.shift || !!b?.alt;
    return allowed && bindingMatches(e, b);
  });
}

/** Tab, including Shift+Tab on Linux. X gives Shift+Tab its own keysym
 *  (ISO_Left_Tab) and WebKitGTK reports it as `key: "Unidentified"`, so a
 *  check on `key` alone never saw ⌃⇧⇥ there. `code` is the physical key. */
export function isTabKey(e: KeyboardEvent): boolean {
  return e.key === "Tab" || e.code === "Tab";
}

/** What Shift turns each punctuation key a binding can name into. A binding
 *  says `⇧⌘[`; WebKitGTK (and Chromium on Windows) report the CHARACTER, so
 *  the event says `{` and never matched. Measured with real keys on Linux:
 *  Ctrl+Shift+[ arrived as key "{", and previous / next tab did nothing.
 *  Letters need no entry, they are lower-cased below. */
const UNSHIFTED: Record<string, string> = {
  "{": "[", "}": "]", "<": ",", ">": ".", "+": "=", "_": "-", "?": "/", ":": ";", "\"": "'", "|": "\\", "~": "`",
};

/** A binding's key with Shift's effect on punctuation taken back out, so a
 *  binding recorded as `{` + Shift and one written as `[` + Shift are the
 *  same chord. */
function baseKey(key: string, shift: boolean): string {
  return shift ? UNSHIFTED[key] ?? key : key;
}

/** Normalize a live KeyboardEvent's key to the same token space as `Binding.key`. */
export function eventKeyToken(e: KeyboardEvent): string {
  const k = e.key;
  if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  if (k === "Unidentified" && e.code === "Tab") return "Tab";
  return baseKey(k, e.shiftKey); // ArrowUp / "[" / "]" / "," / digits …
}

/** True when the event's modifiers + key satisfy the binding. The "1-9"
 *  sentinel matches any digit 1-9 with the binding's modifiers. */
export function bindingMatches(e: KeyboardEvent, b: Binding | null | undefined): boolean {
  if (!b) return false;
  // LINUX/WINDOWS: Ctrl folds into `cmd`, so every shortcut fires there too.
  // Inside a terminal, readline keeps plain Ctrl+letter: xterm consumes those
  // before this handler sees them, and TerminalPane's PASS_TO_APP only takes
  // Shift/Alt bindings off macOS (docs/windows.md, "Keys").
  //
  // AltGr (German, Polish, French layouts) reports as Ctrl+Alt in Chromium,
  // so a key that types `@` or `{` would otherwise fire a Ctrl+Alt binding.
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return false;
  const cmd = eventCmd(e);
  if (cmd !== b.cmd || e.shiftKey !== b.shift || e.altKey !== b.alt) return false;
  if (b.key === "1-9") return /^[1-9]$/.test(e.key);
  return eventKeyToken(e) === baseKey(b.key, b.shift);
}

/** Whether a terminal key event matches an app binding that xterm must pass through. */
export function matchesTerminalAppBinding(e: KeyboardEvent, b: Binding | undefined, isMac: boolean): boolean {
  // Control without Command is reserved for readline and terminal key bindings on macOS.
  if (isMac && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) return false;
  return (isMac || !!b?.shift || !!b?.alt) && bindingMatches(e, b);
}

/** Build a Binding from a recorded keydown. Returns null for a bare modifier
 *  press (no real key yet). `digitMode` collapses a recorded digit into the
 *  "1-9" range sentinel (used by the jump-to-tab row). */
export function bindingFromEvent(e: KeyboardEvent, digitMode = false): Binding | null {
  const k = e.key;
  if (k === "Meta" || k === "Control" || k === "Shift" || k === "Alt" || k === "CapsLock" || isSuperKey(e)) {
    return null;
  }
  let key: string;
  if (/^[a-zA-Z]$/.test(k)) key = k.toLowerCase();
  else if (/^[0-9]$/.test(k)) key = digitMode ? "1-9" : k;
  // Recorded as the key, not the character Shift made of it: `⇧⌘[`, not `⇧⌘{`.
  else key = baseKey(k, e.shiftKey);
  return { cmd: eventCmd(e), shift: e.shiftKey, alt: e.altKey, key };
}

/**
 * Keys the registry refuses outright, whatever modifiers are on them.
 *
 * Tab, because a `Binding` cannot tell ⌃⇥ from ⌘⇥: `bindingMatches` folds
 * Cmd and Ctrl into one flag, so a recorded ⌃⇥ would be stored as
 * `{cmd:true, key:"Tab"}` and fire on every press of the recently-used-tabs
 * gesture, on top of it. Tab stays available to that gesture, which has a
 * recorder of its own (a `HoldGesture`) and can tell the two apart.
 */
export function isReservedKey(key: string): boolean {
  return key === "Tab";
}

/** At least one of Cmd/Ctrl, Option, or Shift+non-alphanumeric must be present.
 *  Pure Shift+letter = capitals (normal typing) — always rejected. */
export function isValidBinding(b: Binding): boolean {
  if (isReservedKey(b.key)) return false;
  if (b.cmd || b.alt) return true;
  // A function key types nothing, so it needs no modifier to be safe: F12 on
  // its own is go-to-definition in every IDE this app's users come from.
  if (/^F([1-9]|1[0-9]|20)$/.test(b.key)) return true;
  // Shift+punctuation (e.g. ⇧?) is a valid shortcut; Shift+letter is not.
  return b.shift && !/^[a-z0-9]$/i.test(b.key);
}

/**
 * A binding, in CodeMirror's own key notation ("Mod-Alt-b").
 *
 * The code-navigation keys live in a CodeMirror keymap rather than the window
 * handler, because they must only fire while an editor has focus, and CM
 * spells its modifiers differently from us. `cmd` becomes `Mod-`, which is
 * exactly our own Cmd/Ctrl fold.
 */
export function bindingToCmKey(b: Binding): string {
  return [b.cmd && "Mod", b.alt && "Alt", b.shift && "Shift", b.key]
    .filter(Boolean).join("-");
}

/** True on macOS. The handler folds Cmd≡Ctrl so shortcuts FIRE on every
 *  platform (Ctrl+L on Linux/Windows hits the same command as ⌘L on a Mac);
 *  this flag only changes how modifiers are LABELLED. Detected once from the
 *  user agent — synchronous, unlike Tauri's async `platform()`. */
export { IS_MAC };

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
    case "⇥": return "Tab";
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
export function bindingGlyphs(b: Binding, isMac: boolean = IS_MAC): string[] {
  const out: string[] = [];
  if (isMac) {
    if (b.alt) out.push("⌥");
    if (b.shift) out.push("⇧");
    if (b.cmd) out.push("⌘");
  } else {
    // The same Ctrl, Alt, Shift order `bindingText` prints off macOS. The
    // key chips are these glyphs drawn one per chip, and in the macOS order
    // the Shortcuts page read "Shift Ctrl A" and "Alt Ctrl Up" on Linux.
    if (b.cmd) out.push("⌘");
    if (b.alt) out.push("⌥");
    if (b.shift) out.push("⇧");
  }
  out.push(keyGlyph(b.key));
  return out;
}

/** A binding as one string, for tooltips and hints: the glyph run on macOS
 *  (`⌥⌘P`), the Windows / Linux convention elsewhere (`Ctrl+Alt+P`), where
 *  ⌘ and ⌥ are keys nobody has. */
export function bindingText(b: Binding, isMac: boolean = IS_MAC): string {
  if (isMac) return bindingGlyphs(b, true).join("");
  // Windows / Linux order: Ctrl, Alt, Shift, then the key (Microsoft's
  // style guide, and what VS Code and Windows Terminal print). The glyph
  // order above is the macOS one (⌥⇧⌘), which read "Shift+Ctrl+P".
  const parts: string[] = [];
  if (b.cmd) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(glyphLabel(keyGlyph(b.key)));
  return parts.join("+");
}

/** One chip's label: the glyph on macOS, the key's name elsewhere. */
export function displayGlyph(glyph: string): string {
  return IS_MAC ? glyph : glyphLabel(glyph);
}

/** Stable signature for conflict detection (two ids sharing one = a clash). */
export function bindingSignature(b: Binding): string {
  return `${b.cmd ? "C" : ""}${b.shift ? "S" : ""}${b.alt ? "A" : ""}:${b.key}`;
}

/** Two bindings are the same chord. Two nulls are equal (both unbound), so a
 *  row whose default is null reads as "not customised" while it stays so. */
export function bindingsEqual(a: Binding | null | undefined, b: Binding | null | undefined): boolean {
  if (a === null && b === null) return true;
  if (!a || !b) return false;
  return a.cmd === b.cmd && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/** Who clashes with whom on the Shortcuts page.
 *
 *  (a) chord vs chord: two rows on one signature, unless a
 *      NON_CONFLICTING_GROUPS entry says they cannot both be live. An unbound
 *      row clashes with nothing.
 *  (b) gesture vs chord, only while the gesture is on: a chord on the same
 *      key with the same modifier, Shift either way (Shift reverses the walk,
 *      so ⌃⇧⇥ is the gesture too). `cmd` folds Ctrl, so a ctrl or a cmd hold
 *      meets a `cmd` chord. The gesture's capture listener runs first and
 *      stops the event, so the gesture wins, and the page says so on both rows.
 *  (c) double-Shift vs anything: never, it has no key.
 *  (d) Tab in a chord never gets this far: the recorder refuses it.
 *
 *  Pure, so the rules are tested without drawing the page. */
export function conflicts(
  binds: BindingMap,
  gesture: HoldGesture,
  ctrlTabMode: CtrlTabMode,
): { chords: Set<ShortcutId>; withGesture: ShortcutId[] } {
  const bySig = new Map<string, ShortcutId[]>();
  for (const def of SHORTCUT_DEFS) {
    const b = binds[def.id];
    if (!b) continue;
    const sig = bindingSignature(b);
    bySig.set(sig, [...(bySig.get(sig) ?? []), def.id]);
  }
  const chords = new Set<ShortcutId>();
  for (const list of bySig.values()) {
    if (list.length <= 1) continue;
    if (NON_CONFLICTING_GROUPS.some(g => list.every(id => g.includes(id)))) continue;
    list.forEach(id => chords.add(id));
  }
  const withGesture: ShortcutId[] = [];
  if (ctrlTabMode === "on") {
    const token = tokenForCode(gesture.code);
    const alt = gesture.hold === "alt";
    for (const def of SHORTCUT_DEFS) {
      const b = binds[def.id];
      if (!b) continue;
      const sameKey = b.key === token || (b.key === "1-9" && /^Digit[1-9]$/.test(gesture.code));
      if (sameKey && b.alt === alt && b.cmd === !alt) withGesture.push(def.id);
    }
  }
  return { chords, withGesture };
}
