// Every row a surface can draw has copy in BOTH languages.
//
// The registry stopped carrying its own strings (lib/shortcuts.ts), and the
// keys are built from a table inside lib/shortcutCopy.ts, so the two guards
// that cover the rest of the app cannot see them: `usedKeys.test.ts` reads
// `t("…")` literals, and these are not literals, while `parity.test.ts` only
// compares en against zh-CN, so a row missing from BOTH passes it. What is
// left is a shortcut whose row prints "settings:shortcuts.defs.florb.label" on
// the settings page and in the ⌘/ sheet, which is the failure mode the whole
// locale tree is built to avoid.
//
// Static, like those two, and for the same reason: drawing every row would
// mean constructing a plausible world and would only prove the strings resolve
// in THAT world.

import { describe, expect, it } from "vitest";
import en from "@/locales/en";
import zhCN from "@/locales/zh-CN";
import {
  CTRL_TAB_MODES,
  DOUBLE_SHIFT_MODES,
  FIXED_SHORTCUTS,
  GROUP_ORDER,
  SHORTCUT_DEFS,
} from "./shortcuts";
import {
  ctrlTabModeLabel,
  doubleShiftModeLabel,
  fixedShortcutHint,
  fixedShortcutLabel,
  fixedShortcutReason,
  shortcutGroupLabel,
  shortcutHint,
  shortcutLabel,
} from "./shortcutCopy";

const LANGS = ["en", "zh-CN"] as const;
type Lang = typeof LANGS[number];

const CATALOG = { en, "zh-CN": zhCN } as Record<Lang, unknown>;
const shortcutsOf = (lang: Lang) =>
  (CATALOG[lang] as { settings: Record<string, any> }).settings.shortcuts as Record<string, any>;

/** A `settings:…` key resolved against one language's catalog, without
 *  i18next: undefined when the entry is not there. The two readers below
 *  differ only in what they do about that. */
const lookup = (lang: Lang, key: string): string | undefined => {
  const settings = (CATALOG[lang] as { settings: Record<string, unknown> }).settings;
  let cur: unknown = settings;
  for (const part of key.replace(/^settings:/, "").split(".")) {
    cur = (cur as Record<string, unknown> | undefined)?.[part];
  }
  return typeof cur === "string" ? cur : undefined;
};

const fill = (text: string, vars?: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars?.[name] ?? whole);

/** `t` for one language, read straight off that language's catalog: an entry
 *  that is missing is an ERROR here, where i18next would return the key (which
 *  is what the app would paint) or fall back to English (which is why a
 *  zh-CN-only gap is invisible to a test that goes through i18n). An unfilled
 *  `{{placeholder}}` is the same class of bug: shortcutCopy.ts passes the
 *  chord, and a hint written against a name nothing provides prints the
 *  braces. */
const strictT = (lang: Lang) => (key: string, vars?: Record<string, string>) => {
  const entry = lookup(lang, key);
  if (entry === undefined) throw new Error(`${lang}: no entry for ${key}`);
  const out = fill(entry, vars);
  if (/\{\{/.test(out)) throw new Error(`${lang}: ${key} has an unfilled placeholder: ${out}`);
  return out;
};

/** i18next's own behaviour, for the one question that needs it: which rows
 *  have a hint at all (a missing entry is a row with nothing to explain). */
const lenientT = (lang: Lang) => (key: string, vars?: Record<string, string>) => {
  const entry = lookup(lang, key);
  return entry === undefined ? key : fill(entry, vars);
};

const hintKeys = (lang: Lang) => {
  const defs = shortcutsOf(lang).defs as Record<string, { hint?: string }>;
  return Object.entries(defs).filter(([, v]) => typeof v.hint === "string")
    .map(([k]) => k).sort();
};

describe("shortcut copy", () => {
  it("names every rebindable row, in both languages", () => {
    for (const lang of LANGS) {
      const t = strictT(lang);
      for (const def of SHORTCUT_DEFS) {
        const label = shortcutLabel(def.id, t);
        // The id, not the label: a row that resolves to its own key is the
        // exact failure this file exists for.
        expect(label, `${lang} ${def.id}`).not.toBe(def.id);
        expect(label.length, `${lang} ${def.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("agrees between languages about which rows have a hint", () => {
    // A hint is optional per row, and its absence is read off the lookup
    // rather than a second list, so the two languages have to agree about it
    // or one of them drops a line the other draws. Rows without one are
    // legitimate: Back, New tab and Zoom out say all there is to say.
    expect(hintKeys("en")).toEqual(hintKeys("zh-CN"));
    expect(hintKeys("en").length).toBeGreaterThan(0);
  });

  it("spells out every chord a hint interpolates", () => {
    // HINT_VARS in shortcutCopy.ts fills {{cmd}}, {{cmdS}}, {{cmdK}},
    // {{shiftCmdD}} and {{shiftCmdP}}. Resolving IS the assertion (strictT
    // refuses an unfilled placeholder); the row is named here because the
    // throw would only name the key. Only the rows that HAVE a hint: the
    // others resolve to nothing by design.
    for (const lang of LANGS) {
      const t = strictT(lang);
      const lenient = lenientT(lang);
      for (const def of SHORTCUT_DEFS) {
        if (shortcutHint(def.id, lenient) === undefined) continue;
        expect(() => shortcutHint(def.id, t), `${lang} ${def.id}`).not.toThrow();
      }
    }
  });

  it("names the gestures that cannot be rebound", () => {
    for (const lang of LANGS) {
      const t = strictT(lang);
      for (const fixed of FIXED_SHORTCUTS) {
        expect(fixedShortcutLabel(fixed.id, t).length, `${lang} ${fixed.id}`).toBeGreaterThan(0);
        expect(fixedShortcutHint(fixed.id, t).length, `${lang} ${fixed.id}`).toBeGreaterThan(0);
        // Never drawn for the two rows that carry a mode select (the select
        // names the gesture instead), but a third row without one prints it
        // where the recorder would be, so it has to exist.
        expect(fixedShortcutReason(fixed.id, t).length, `${lang} ${fixed.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("names every mode of both gestures", () => {
    for (const lang of LANGS) {
      const t = strictT(lang);
      for (const mode of DOUBLE_SHIFT_MODES) {
        expect(doubleShiftModeLabel(mode, t).length, `${lang} ${mode}`).toBeGreaterThan(0);
      }
      for (const mode of CTRL_TAB_MODES) {
        expect(ctrlTabModeLabel(mode, t).length, `${lang} ${mode}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the mode labels the shortcut page prints, word for word", () => {
    // These are what the Settings select offers, and the ⌘/ sheet prints the
    // chosen one where a recorder would be (e2e/specs/settings.e2e.ts asserts
    // the same list on screen). Each has to name the WHOLE gesture: the row
    // prints nothing else beside it, so "Left Shift" alone would leave "only
    // what?" unanswered.
    const t = strictT("en");
    expect(DOUBLE_SHIFT_MODES.map(m => doubleShiftModeLabel(m, t))).toEqual([
      "Off", "Double left Shift", "Double Shift, not in a terminal", "Double Shift",
    ]);
    expect(CTRL_TAB_MODES.map(m => ctrlTabModeLabel(m, t))).toEqual([
      "Off", "Hold Ctrl, tap Tab",
    ]);
  });

  it("names every group a list can render", () => {
    for (const lang of LANGS) {
      const t = strictT(lang);
      for (const group of GROUP_ORDER) {
        expect(shortcutGroupLabel(group, false, t).length, `${lang} ${group}`).toBeGreaterThan(0);
      }
    }
    // "Code navigation" is the one heading that is NOT a locale key: it is the
    // feature's own name, which follows its type-checking switch, and a second
    // name for it here is the drift lib/lsp/featureName.ts exists to prevent.
    const t = strictT("en");
    expect(shortcutGroupLabel("Code navigation", false, t)).toBe("Code navigation");
    expect(shortcutGroupLabel("Code navigation", true, t)).toBe("Code intelligence");
  });

  it("leaves no copy behind for a row that no longer exists", () => {
    // The other direction: a def deleted without its locale entry leaves a
    // string nothing reads, which stays invisible until somebody translates it
    // again. Counts rather than names, because the locale keys are camelCase
    // and the ids are not, and a bijection is what the count proves once every
    // id is known to resolve.
    for (const lang of LANGS) {
      const shortcuts = shortcutsOf(lang);
      expect(Object.keys(shortcuts.defs)).toHaveLength(SHORTCUT_DEFS.length);
      expect(Object.keys(shortcuts.fixed)).toHaveLength(FIXED_SHORTCUTS.length);
      // The four double-Shift modes plus the "Off" they share with ⌃⇥.
      expect(Object.keys(shortcuts.modes)).toHaveLength(5);
      expect(Object.keys(shortcuts.groups)).toHaveLength(GROUP_ORDER.length - 1);
    }
  });
});
