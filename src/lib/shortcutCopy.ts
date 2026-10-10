// The wording of every shortcut row: the id → locale-key table, plus the
// accessors the two surfaces that draw those rows share (Settings →
// Shortcuts and the ⌘/ sheet).
//
// `lib/shortcuts.ts` holds structure (ids, groups, bindings, glyphs) and no
// copy: the strings live in the locale files, under `settings:shortcuts.*`,
// which the sheet reads too so the two lists can never disagree about what a
// command is called. Adding a ShortcutId is a compile error until it has a row
// here, and `shortcutCopy.test.ts` fails when a row has no label in either
// language.
//
// A caller's `t` may be bound to ANY namespace: every key below carries its
// own ("settings:…"), so the settings page and the dialog each pass the `t`
// they already have.
import { kbd } from "./platform";
import { codeIntelName } from "./lsp/featureName";
import {
  type CtrlTabMode,
  type DoubleShiftMode,
  type FixedShortcutId,
  type ShortcutGroup,
  type ShortcutId,
} from "./shortcuts";

/** A `t` from react-i18next, loose enough that any namespace's binding fits. */
type T = (key: string, vars?: Record<string, string>) => string;

/** Key segment per command: the middle of `settings:shortcuts.defs.<k>.label`.
 *  camelCase, because the ids are kebab-case and locale keys here are not. */
const DEF_KEY: Record<ShortcutId, string> = {
  "sidebar-prev": "sidebarPrev",
  "sidebar-next": "sidebarNext",
  "nav-back": "navBack",
  "nav-forward": "navForward",
  "task-prev-arrow": "taskPrevArrow",
  "task-next-arrow": "taskNextArrow",
  "jump-next-waiting": "jumpNextWaiting",
  "tab-prev": "tabPrev",
  "tab-next": "tabNext",
  "tab-prev-arrow": "tabPrevArrow",
  "tab-next-arrow": "tabNextArrow",
  "jump-to-tab": "jumpToTab",
  "new-tab": "newTab",
  "new-scratchpad": "newScratchpad",
  "close-tab": "closeTab",
  "focus-terminal": "focusTerminal",
  "clear-terminal": "clearTerminal",
  "split-pane-right": "splitPaneRight",
  "split-pane-below": "splitPaneBelow",
  "toggle-terminal": "toggleTerminal",
  "terminal-copy": "terminalCopy",
  "terminal-paste": "terminalPaste",
  "command-palette": "commandPalette",
  "new-task-quick": "newTaskQuick",
  "open-settings": "openSettings",
  "file-finder": "fileFinder",
  "task-finder": "taskFinder",
  "find-in-files": "findInFiles",
  "toggle-left-sidebar": "toggleLeftSidebar",
  "toggle-right-sidebar": "toggleRightSidebar",
  "broadcast": "broadcast",
  "prompt-palette": "promptPalette",
  "zoom-in": "zoomIn",
  "zoom-out": "zoomOut",
  "zoom-reset": "zoomReset",
  "add-selection-to-agent": "addSelectionToAgent",
  "create-pr": "createPr",
  "stage-file": "stageFile",
  "discard-file": "discardFile",
  "go-to-definition": "goToDefinition",
  "find-usages": "findUsages",
  "go-to-implementation": "goToImplementation",
  "go-to-type-definition": "goToTypeDefinition",
  "file-structure": "fileStructure",
};

/** Same, for the two gestures that are not a chord
 *  (`settings:shortcuts.fixed`). */
const FIXED_KEY: Record<FixedShortcutId, string> = {
  "search-everywhere": "searchEverywhere",
  "recent-tabs": "recentTabs",
};

/** Same, for the selects those two rows carry (`settings:shortcuts.modes`).
 *  "Off" is one key for both: the two selects offer the same word. */
const MODE_KEY: Record<DoubleShiftMode | CtrlTabMode, string> = {
  "off": "off",
  "left": "doubleLeftShift",
  "outside-terminal": "doubleNotInTerminal",
  "any": "doubleShift",
  "on": "holdCtrlTab",
};

/** Same, for the group headings (`settings:shortcuts.groups`). "Code
 *  navigation" is deliberately absent: that heading is the feature's own name
 *  (lib/lsp/featureName.ts), and a second name for it here is exactly the
 *  drift that file exists to prevent. */
const GROUP_KEY: Record<Exclude<ShortcutGroup, "Code navigation">, string> = {
  Navigation: "navigation",
  Tabs: "tabs",
  Terminal: "terminal",
  Git: "git",
  General: "general",
};

/** Values for the `{{…}}` the hints interpolate, which spell a chord the way
 *  the platform writes it (⌘S on macOS, Ctrl+S elsewhere). Only the hints that
 *  name a key need an entry; the test requires every placeholder a hint uses
 *  to have one. */
const HINT_VARS: Partial<Record<ShortcutId, Record<string, string>>> = {
  "go-to-definition": { cmd: kbd("⌘") },
  "find-usages": { cmd: kbd("⌘") },
  "new-scratchpad": { cmdS: kbd("⌘S") },
  "clear-terminal": { cmdK: kbd("⌘K") },
  "split-pane-below": { shiftCmdD: kbd("⇧⌘D") },
  "command-palette": { shiftCmdP: kbd("⇧⌘P") },
};

const defKey = (id: ShortcutId) => `settings:shortcuts.defs.${DEF_KEY[id]}`;

/** A row's name, e.g. "Find usages". */
export function shortcutLabel(id: ShortcutId, t: T): string {
  return t(`${defKey(id)}.label`);
}

/** A row's second line, or undefined when it has none: Back, New tab and
 *  Zoom out say all there is to say, and a blank line under them would read as
 *  a bug.
 *
 *  "Has none" is read off the lookup, not a second list: a key with no entry
 *  comes back as the key itself (lib/i18n.ts inits with `returnNull: false`),
 *  so a missing `.hint` is a row without a hint. A hint that is missing where
 *  one belongs is a different thing, and `shortcutCopy.test.ts` is what pins
 *  the set in both languages. */
export function shortcutHint(id: ShortcutId, t: T): string | undefined {
  const key = `${defKey(id)}.hint`;
  const hint = t(key, HINT_VARS[id]);
  return hint === key ? undefined : hint;
}

/** A group's heading in the list. */
export function shortcutGroupLabel(
  group: ShortcutGroup, typeChecking: boolean, t: T,
): string {
  if (group === "Code navigation") return codeIntelName(typeChecking);
  return t(`settings:shortcuts.groups.${GROUP_KEY[group]}`);
}

/** A gesture that cannot be rebound: its name, the line under it, and (for a
 *  row that carries no mode select) why there is no recorder beside it. */
export function fixedShortcutLabel(id: FixedShortcutId, t: T): string {
  return t(`settings:shortcuts.fixed.${FIXED_KEY[id]}.label`);
}

export function fixedShortcutHint(id: FixedShortcutId, t: T): string {
  return t(`settings:shortcuts.fixed.${FIXED_KEY[id]}.hint`);
}

export function fixedShortcutReason(id: FixedShortcutId, t: T): string {
  return t(`settings:shortcuts.fixed.${FIXED_KEY[id]}.reason`);
}

/** What one double-Shift mode is called. Each names the WHOLE gesture, since
 *  the row prints nothing else beside the select. */
export function doubleShiftModeLabel(mode: DoubleShiftMode, t: T): string {
  return t(`settings:shortcuts.modes.${MODE_KEY[mode]}`);
}

/** Same, for the ⌃⇥ select. */
export function ctrlTabModeLabel(mode: CtrlTabMode, t: T): string {
  return t(`settings:shortcuts.modes.${MODE_KEY[mode]}`);
}
