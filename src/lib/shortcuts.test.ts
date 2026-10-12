import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS, DEFAULT_RECENT_TABS, FIXED_SHORTCUTS, GESTURE_SHORTCUTS, GROUP_ORDER, NON_CONFLICTING_GROUPS, SHORTCUT_DEFS,
  bindingFromEvent, bindingMatches, bindingSignature, bindingText, bindingToCmKey, bindingsEqual, codeGlyph,
  conflicts, holdGestureFromEvent, holdGestureGlyphs, holdGestureText, holdHeld, holdReleased,
  isValidBinding, isReservedKey, matchesTerminalAppBinding, parseHoldGesture, terminalPassesToApp, tokenForCode,
} from "./shortcuts";

// `SHORTCUT_DEFS` is the single source of truth for every bindable key, and it
// had no test at all: the help modal, the settings editor and the global
// handler are all data-driven from it, so a duplicated chord or a stray id
// shows up as "that key stopped working" and nothing else.

describe("the shortcut table", () => {
  it("has a unique id per entry", () => {
    const ids = SHORTCUT_DEFS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a group the help modal renders", () => {
    // A group missing from GROUP_ORDER means those shortcuts exist, work, and
    // appear in no list anybody can read.
    for (const d of SHORTCUT_DEFS) {
      expect(GROUP_ORDER, d.id).toContain(d.group);
    }
  });

  it("gives every entry a binding that cannot swallow normal typing", () => {
    for (const d of SHORTCUT_DEFS) {
      const b = d.defaultBinding;
      if (!b) continue; // unbound by default: see "ships without a chord" below
      expect(isValidBinding(b), `${d.id}: ${bindingSignature(b)}`).toBe(true);
    }
  });

  it("ships without a chord only where another way in exists", () => {
    // An unbound command nobody can reach is a dead feature. Search everywhere
    // is the one exception, and it has double-Shift.
    const unbound = SHORTCUT_DEFS.filter(d => d.defaultBinding === null);
    expect(unbound.map(d => d.id)).toEqual(["search-everywhere"]);
    for (const d of unbound) expect(d.gesture, d.id).toBe("double-shift");
  });

  it("hands each default chord to exactly one shortcut", () => {
    // Two entries on one chord is a race decided by the order of a switch
    // statement. The one deliberate pair is listed in NON_CONFLICTING_GROUPS,
    // because those two are claimed in contexts that cannot both be live.
    const allowed = new Set(NON_CONFLICTING_GROUPS.flat());
    const byChord = new Map<string, string[]>();
    for (const d of SHORTCUT_DEFS) {
      if (allowed.has(d.id) || !d.defaultBinding) continue;
      const sig = bindingSignature(d.defaultBinding);
      byChord.set(sig, [...(byChord.get(sig) ?? []), d.id]);
    }
    const clashes = [...byChord.entries()].filter(([, ids]) => ids.length > 1);
    expect(clashes, `chord claimed twice: ${JSON.stringify(clashes)}`).toEqual([]);
  });

  it("keeps DEFAULT_BINDINGS in step with the table", () => {
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual(SHORTCUT_DEFS.map(d => d.id).sort());
  });
});

describe("Back and Forward own the bracket keys", () => {
  const def = (id: string) => SHORTCUT_DEFS.find(d => d.id === id)!;

  it("binds Cmd+[ and Cmd+] to navigation, and to nothing else", () => {
    // They used to switch tasks as well, with two histories claiming them
    // conditionally on top: three meanings for one chord, decided by where
    // focus happened to be. This is the invariant that keeps it at one.
    // `bindingsEqual`, not a literal: every binding is normalised to carry
    // all three modifier flags, so a literal here would assert the shape of
    // the constructor rather than the chord.
    expect(bindingsEqual(def("nav-back").defaultBinding,
      { key: "[", cmd: true, shift: false, alt: false })).toBe(true);
    expect(bindingsEqual(def("nav-forward").defaultBinding,
      { key: "]", cmd: true, shift: false, alt: false })).toBe(true);
    const plainBracket = SHORTCUT_DEFS.filter(d => d.defaultBinding
      && (d.defaultBinding.key === "[" || d.defaultBinding.key === "]")
      && d.defaultBinding.cmd && !d.defaultBinding.shift && !d.defaultBinding.alt);
    expect(plainBracket.map(d => d.id).sort()).toEqual(["nav-back", "nav-forward"]);
  });

  it("leaves tasks and tabs on the chords that always meant them", () => {
    // The reason dropping task switching from Cmd+[ costs nothing: both other
    // routes still exist, and the arrow pair works inside a split too.
    expect(bindingsEqual(def("task-prev-arrow").defaultBinding,
      { key: "ArrowUp", cmd: true, alt: true, shift: false })).toBe(true);
    expect(bindingsEqual(def("task-next-arrow").defaultBinding,
      { key: "ArrowDown", cmd: true, alt: true, shift: false })).toBe(true);
    expect(bindingsEqual(def("tab-prev").defaultBinding,
      { key: "[", cmd: true, shift: true, alt: false })).toBe(true);
    expect(bindingsEqual(def("tab-next").defaultBinding,
      { key: "]", cmd: true, shift: true, alt: false })).toBe(true);
  });
});

describe("function keys", () => {
  it("are valid on their own", () => {
    // F12 types nothing, so it cannot swallow anybody's input. Requiring a
    // modifier would have made go-to-definition unbindable to the key every
    // IDE uses for it.
    expect(isValidBinding({ key: "F12", cmd: false, shift: false, alt: false })).toBe(true);
    expect(isValidBinding({ key: "F1", cmd: false, shift: false, alt: false })).toBe(true);
    expect(isValidBinding({ key: "F20", cmd: false, shift: false, alt: false })).toBe(true);
  });

  it("does not let a bare letter through with them", () => {
    // The rule this exception sits inside: `f` is a letter someone is typing.
    expect(isValidBinding({ key: "f", cmd: false, shift: false, alt: false })).toBe(false);
    expect(isValidBinding({ key: "F21", cmd: false, shift: false, alt: false })).toBe(false);
    expect(isValidBinding({ key: "F0", cmd: false, shift: false, alt: false })).toBe(false);
  });
});

describe("bindings in CodeMirror's notation", () => {
  // The code-navigation keys live in a CodeMirror keymap, which spells its
  // modifiers differently. A wrong string here is a key that silently does
  // nothing, and CodeMirror does not complain about one it cannot parse.
  it("spells each modifier the way CodeMirror expects", () => {
    expect(bindingToCmKey({ key: "F12", cmd: false, shift: false, alt: false })).toBe("F12");
    expect(bindingToCmKey({ key: "F12", cmd: false, shift: true, alt: false })).toBe("Shift-F12");
    expect(bindingToCmKey({ key: "F12", cmd: true, shift: false, alt: false })).toBe("Mod-F12");
    // Mod, then Alt, then Shift: CodeMirror requires that order.
    expect(bindingToCmKey({ key: "b", cmd: true, shift: true, alt: true }))
      .toBe("Mod-Alt-Shift-b");
  });

  it("converts every code-navigation default", () => {
    const ids = ["go-to-definition", "find-usages", "go-to-implementation",
                 "go-to-type-definition", "file-structure"] as const;
    for (const id of ids) {
      const key = bindingToCmKey(DEFAULT_BINDINGS[id]!);
      expect(key, id).toMatch(/^(Mod-)?(Alt-)?(Shift-)?[A-Za-z0-9]+$/);
    }
  });
});

describe("gesture shortcuts", () => {
  it("keeps them out of the bindable table", () => {
    // They have no Binding, and everything in SHORTCUT_DEFS is assumed to
    // have one: the bindings map, the conflict check, the chord recorder and
    // the localStorage migration would each need a special case.
    const ids = new Set(SHORTCUT_DEFS.map(d => d.id as string));
    for (const g of GESTURE_SHORTCUTS) expect(ids.has(g.id), g.id).toBe(false);
  });

  it("lists recently used tabs, with its hold-and-tap recorder, in a group the sheet renders", () => {
    // `bindingMatches` folds Cmd and Ctrl into one flag, so the nearest thing
    // the table could hold is {cmd:true, key:"Tab"}, which renders as ⌘⇥ and
    // is dead on macOS. It is hold-and-tap rather than one chord, so it has
    // a recorder of its own.
    expect(GESTURE_SHORTCUTS).toEqual([
      { id: "recent-tabs", group: "Navigation", control: "hold-tap" },
    ]);
    for (const g of GESTURE_SHORTCUTS) expect(GROUP_ORDER, g.id).toContain(g.group);
  });

  it("ships the gesture as ⌃⇥", () => {
    expect(DEFAULT_RECENT_TABS).toEqual({ hold: "ctrl", code: "Tab" });
    expect(holdGestureGlyphs(DEFAULT_RECENT_TABS)).toEqual(["⌃", "⇥"]);
  });
});

describe("search everywhere", () => {
  const def = SHORTCUT_DEFS.find(d => d.id === "search-everywhere")!;

  it("is a def in Code navigation, unbound, with double-Shift beside it", () => {
    // Double-Shift is the gesture people cannot guess, so it stays; the chord
    // is optional and ships empty.
    expect(def.group).toBe("Code navigation");
    expect(def.defaultBinding).toBeNull();
    expect(DEFAULT_BINDINGS["search-everywhere"]).toBeNull();
    expect(def.gesture).toBe("double-shift");
  });

  it("is the only def that carries a gesture", () => {
    expect(SHORTCUT_DEFS.filter(d => d.gesture).map(d => d.id)).toEqual(["search-everywhere"]);
  });

  it("accepts a recorded chord, and matches it", () => {
    const b = { key: "o", cmd: true, shift: true, alt: false };
    expect(isValidBinding(b)).toBe(true);
    const ev = {
      key: "O", code: "KeyO", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false,
      getModifierState: () => false,
    } as unknown as KeyboardEvent;
    expect(bindingMatches(ev, b)).toBe(true);
  });

  it("matches nothing while unbound", () => {
    const ev = {
      key: "o", code: "KeyO", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      getModifierState: () => false,
    } as unknown as KeyboardEvent;
    expect(bindingMatches(ev, null)).toBe(false);
  });

  it("treats two unbound bindings as equal, and unbound as different from bound", () => {
    // What the Settings page's reset button and Reset all read.
    expect(bindingsEqual(null, null)).toBe(true);
    expect(bindingsEqual(null, { key: "o", cmd: true, shift: true, alt: false })).toBe(false);
    expect(bindingsEqual(undefined, undefined)).toBe(false);
  });
});

// ── Hold gestures ───────────────────────────────────────────────────────

/** A keydown as the recorder sees it. `code` is the physical key. */
const kd = (code: string, key: string, mods: {
  ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean; altGraph?: boolean;
} = {}) => ({
  code, key,
  ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta, shiftKey: !!mods.shift,
  getModifierState: (m: string) => m === "AltGraph" && !!mods.altGraph,
}) as unknown as KeyboardEvent;

describe("parseHoldGesture", () => {
  it("reads absent and empty as ⌃⇥, so no migration is needed", () => {
    expect(parseHoldGesture(null, true)).toEqual(DEFAULT_RECENT_TABS);
    expect(parseHoldGesture("", true)).toEqual(DEFAULT_RECENT_TABS);
  });

  it("reads a stored gesture", () => {
    expect(parseHoldGesture('{"hold":"alt","code":"Backquote"}', true))
      .toEqual({ hold: "alt", code: "Backquote" });
    expect(parseHoldGesture('{"hold":"cmd","code":"Backquote"}', true))
      .toEqual({ hold: "cmd", code: "Backquote" });
  });

  it("reads garbage as the default", () => {
    for (const raw of ["{", "null", "42", '"x"', '{"hold":"shift","code":"Tab"}',
                       '{"hold":"ctrl"}', '{"hold":"ctrl","code":7}', '{"hold":"ctrl","code":"a b"}']) {
      expect(parseHoldGesture(raw, true), raw).toEqual(DEFAULT_RECENT_TABS);
    }
  });

  it("reads a gesture the recorder would refuse as the default", () => {
    // Hand-edited, or synced from somewhere older: never act on a gesture
    // that takes a key from readline or from the system.
    expect(parseHoldGesture('{"hold":"ctrl","code":"KeyR"}', true)).toEqual(DEFAULT_RECENT_TABS);
    expect(parseHoldGesture('{"hold":"cmd","code":"Tab"}', true)).toEqual(DEFAULT_RECENT_TABS);
  });

  it("reads a Cmd gesture synced to Linux or Windows as the default", () => {
    // Cmd is the Windows / Super key there, which the desktop keeps.
    expect(parseHoldGesture('{"hold":"cmd","code":"Backquote"}', false)).toEqual(DEFAULT_RECENT_TABS);
    expect(parseHoldGesture('{"hold":"alt","code":"Backquote"}', false))
      .toEqual({ hold: "alt", code: "Backquote" });
  });
});

describe("holdGestureFromEvent", () => {
  it("waits through a bare modifier press", () => {
    expect(holdGestureFromEvent(kd("AltLeft", "Alt", { alt: true }), true)).toBeNull();
    expect(holdGestureFromEvent(kd("ControlLeft", "Control", { ctrl: true }), true)).toBeNull();
    expect(holdGestureFromEvent(kd("MetaLeft", "Meta", { meta: true }), true)).toBeNull();
    expect(holdGestureFromEvent(kd("ShiftLeft", "Shift", { shift: true }), true)).toBeNull();
  });

  it("records ⌃⇥, ⌥` and ⌘` on macOS", () => {
    expect(holdGestureFromEvent(kd("Tab", "Tab", { ctrl: true }), true)).toEqual({ hold: "ctrl", code: "Tab" });
    expect(holdGestureFromEvent(kd("Backquote", "`", { alt: true }), true)).toEqual({ hold: "alt", code: "Backquote" });
    expect(holdGestureFromEvent(kd("Backquote", "`", { meta: true }), true)).toEqual({ hold: "cmd", code: "Backquote" });
  });

  it("records Option+` by its code, though the key is a dead key", () => {
    // What macOS reports for Option+`: the start of a composition.
    expect(holdGestureFromEvent(kd("Backquote", "Dead", { alt: true }), true))
      .toEqual({ hold: "alt", code: "Backquote" });
  });

  it("ignores Shift, which is how the walk reverses", () => {
    expect(holdGestureFromEvent(kd("Tab", "Tab", { ctrl: true, shift: true }), true))
      .toEqual({ hold: "ctrl", code: "Tab" });
  });

  it("refuses no modifier, and two", () => {
    expect(holdGestureFromEvent(kd("Tab", "Tab"), true)).toEqual({ error: { kind: "holdNeedsOne" } });
    expect(holdGestureFromEvent(kd("Tab", "Tab", { ctrl: true, alt: true }), true))
      .toEqual({ error: { kind: "holdNeedsOne" } });
  });

  it("refuses Enter, Backspace and Space", () => {
    for (const [code, key] of [["Enter", "Enter"], ["Backspace", "Backspace"], ["Space", " "]]) {
      expect(holdGestureFromEvent(kd(code, key, { alt: true }), true), code)
        .toEqual({ error: { kind: "holdNeedsOne" } });
    }
  });

  it("refuses what macOS keeps for itself", () => {
    expect(holdGestureFromEvent(kd("Tab", "Tab", { meta: true }), true))
      .toEqual({ error: { kind: "holdOsReserved", keys: "⌘⇥" } });
    expect(holdGestureFromEvent(kd("Space", " ", { meta: true }), true))
      .toEqual({ error: { kind: "holdOsReserved", keys: "⌘␣" } });
    expect(holdGestureFromEvent(kd("Space", " ", { ctrl: true }), true))
      .toEqual({ error: { kind: "holdOsReserved", keys: "⌃␣" } });
  });

  it("refuses what Windows and Linux keep for themselves", () => {
    expect(holdGestureFromEvent(kd("Tab", "Tab", { alt: true }), false))
      .toEqual({ error: { kind: "holdOsReserved", keys: "Alt+Tab" } });
    expect(holdGestureFromEvent(kd("Backquote", "`", { meta: true }), false))
      .toEqual({ error: { kind: "holdOsReserved", keys: "Win+`" } });
  });

  it("names the system's chord even when another modifier is down too", () => {
    expect(holdGestureFromEvent(kd("Tab", "Tab", { meta: true, ctrl: true }), true))
      .toEqual({ error: { kind: "holdOsReserved", keys: "⌘⇥" } });
  });

  it("refuses Ctrl with a letter or a digit (readline's)", () => {
    expect(holdGestureFromEvent(kd("KeyR", "r", { ctrl: true }), true))
      .toEqual({ error: { kind: "holdTerminalKey", mod: "Ctrl", allowed: "Tab ; ' , . =" } });
    expect(holdGestureFromEvent(kd("Digit1", "1", { ctrl: true }), false))
      .toMatchObject({ error: { kind: "holdTerminalKey" } });
  });

  it("refuses Option / Alt with a letter or a digit (it types)", () => {
    expect(holdGestureFromEvent(kd("KeyJ", "∆", { alt: true }), true))
      .toEqual({ error: { kind: "holdTypes", mod: "Option", allowed: "Tab" } });
    expect(holdGestureFromEvent(kd("Digit2", "™", { alt: true }), true)).toMatchObject({ error: { kind: "holdTypes" } });
  });

  it("refuses Cmd with a letter or a digit (copy, paste, quit...)", () => {
    // The walk's capture listener preventDefaults every press of the
    // gesture, so ⌘C recorded here would kill copy app-wide.
    for (const [code, key] of [["KeyC", "c"], ["KeyV", "v"], ["KeyX", "x"], ["KeyZ", "z"],
                               ["KeyQ", "q"], ["KeyW", "w"], ["Digit1", "1"]]) {
      expect(holdGestureFromEvent(kd(code, key, { meta: true }), true), code)
        .toMatchObject({ error: { kind: "holdAppKey" } });
    }
    expect(holdGestureFromEvent(kd("KeyC", "c", { meta: true }), true))
      .toEqual({ error: { kind: "holdAppKey", mod: "Cmd", allowed: "; ' , ." } });
    // And a stored one (hand-edited, or from a build before the rule) is
    // never acted on.
    expect(parseHoldGesture('{"hold":"cmd","code":"KeyC"}', true)).toEqual(DEFAULT_RECENT_TABS);
  });

  it("does not read AltGr as Alt or Ctrl", () => {
    // AltGr is Ctrl+Alt to Chromium. It is a typing key, not a hold.
    expect(holdGestureFromEvent(kd("Backquote", "`", { ctrl: true, alt: true, altGraph: true }), false))
      .toEqual({ error: { kind: "holdNeedsOne" } });
  });

  it("falls back to the key when an event carries no code", () => {
    expect(holdGestureFromEvent(kd("", "Tab", { ctrl: true }), true)).toEqual({ hold: "ctrl", code: "Tab" });
  });
});

describe("holdHeld / holdReleased", () => {
  it("wants exactly the gesture's modifier, Shift aside", () => {
    expect(holdHeld(kd("Tab", "Tab", { ctrl: true }), "ctrl")).toBe(true);
    expect(holdHeld(kd("Tab", "Tab", { ctrl: true, shift: true }), "ctrl")).toBe(true);
    expect(holdHeld(kd("Tab", "Tab", { ctrl: true, alt: true }), "ctrl")).toBe(false);
    expect(holdHeld(kd("Tab", "Tab", { ctrl: true, meta: true }), "ctrl")).toBe(false);
    expect(holdHeld(kd("Backquote", "Dead", { alt: true }), "alt")).toBe(true);
    expect(holdHeld(kd("Backquote", "`", { alt: true, ctrl: true }), "alt")).toBe(false);
    expect(holdHeld(kd("Backquote", "`", { meta: true }), "cmd")).toBe(true);
    expect(holdHeld(kd("Backquote", "`", { meta: true, alt: true }), "cmd")).toBe(false);
  });

  it("does not take AltGr for Alt", () => {
    expect(holdHeld(kd("Backquote", "`", { alt: true, altGraph: true }), "alt")).toBe(false);
  });

  it("lands when the gesture's own modifier comes up, whatever else is down", () => {
    const up = (mods: Parameters<typeof kd>[2]) => kd("ControlLeft", "Control", mods);
    expect(holdReleased(up({}), "ctrl")).toBe(true);
    expect(holdReleased(up({ shift: true }), "ctrl")).toBe(true);
    expect(holdReleased(up({ ctrl: true }), "ctrl")).toBe(false);
    expect(holdReleased(up({ ctrl: true }), "alt")).toBe(true);
    expect(holdReleased(up({ alt: true }), "alt")).toBe(false);
    expect(holdReleased(up({ meta: true }), "cmd")).toBe(false);
    expect(holdReleased(up({}), "cmd")).toBe(true);
  });
});

describe("hold gesture glyphs and names", () => {
  it("prints the modifier and the key", () => {
    expect(holdGestureGlyphs({ hold: "alt", code: "Backquote" })).toEqual(["⌥", "`"]);
    expect(holdGestureGlyphs({ hold: "cmd", code: "KeyJ" })).toEqual(["⌘", "J"]);
    expect(holdGestureGlyphs({ hold: "ctrl", code: "BracketLeft" })).toEqual(["⌃", "["]);
    expect(codeGlyph("Digit1")).toBe("1");
  });

  it("writes it as each platform does", () => {
    expect(holdGestureText({ hold: "alt", code: "Backquote" }, true)).toBe("⌥`");
    expect(holdGestureText({ hold: "ctrl", code: "Tab" }, false)).toBe("Ctrl+Tab");
    expect(holdGestureText({ hold: "alt", code: "Backquote" }, false)).toBe("Alt+`");
  });

  it("maps codes to the chord tokens a Binding uses", () => {
    expect(tokenForCode("KeyJ")).toBe("j");
    expect(tokenForCode("Digit3")).toBe("3");
    expect(tokenForCode("Tab")).toBe("Tab");
    expect(tokenForCode("Backquote")).toBe("`");
    expect(tokenForCode("ArrowUp")).toBe("ArrowUp");
  });
});

describe("conflicts", () => {
  const b = (key: string, mods: { cmd?: boolean; shift?: boolean; alt?: boolean } = {}) =>
    ({ key, cmd: !!mods.cmd, shift: !!mods.shift, alt: !!mods.alt });

  it("finds none in the defaults, with the gesture on", () => {
    // NON_CONFLICTING_GROUPS covers the one deliberate pair.
    const c = conflicts(DEFAULT_BINDINGS, DEFAULT_RECENT_TABS, "on");
    expect([...c.chords]).toEqual([]);
    expect(c.withGesture).toEqual([]);
  });

  it("(a) flags two chords on one signature, and skips unbound rows", () => {
    const binds = { ...DEFAULT_BINDINGS, "new-tab": b("k", { cmd: true }) };
    expect([...conflicts(binds, DEFAULT_RECENT_TABS, "on").chords].sort())
      .toEqual(["clear-terminal", "new-tab"]);
    // search-everywhere is null in the defaults and must not be compared.
    expect(conflicts(DEFAULT_BINDINGS, DEFAULT_RECENT_TABS, "on").chords.has("search-everywhere")).toBe(false);
  });

  it("(a) still honours NON_CONFLICTING_GROUPS", () => {
    expect(conflicts(DEFAULT_BINDINGS, DEFAULT_RECENT_TABS, "on").chords.has("discard-file")).toBe(false);
  });

  it("(b) flags a chord on the gesture's key and modifier, Shift either way", () => {
    const g = { hold: "alt" as const, code: "Backquote" };
    const binds = { ...DEFAULT_BINDINGS, "search-everywhere": b("`", { alt: true, shift: true }) };
    expect(conflicts(binds, g, "on").withGesture).toEqual(["search-everywhere"]);
    const plain = { ...DEFAULT_BINDINGS, "search-everywhere": b("`", { alt: true }) };
    expect(conflicts(plain, g, "on").withGesture).toEqual(["search-everywhere"]);
  });

  it("(b) folds Ctrl and Cmd the way a Binding does", () => {
    const binds = { ...DEFAULT_BINDINGS, "search-everywhere": b("`", { cmd: true }) };
    expect(conflicts(binds, { hold: "cmd", code: "Backquote" }, "on").withGesture).toEqual(["search-everywhere"]);
    expect(conflicts(binds, { hold: "ctrl", code: "Backquote" }, "on").withGesture).toEqual(["search-everywhere"]);
    expect(conflicts(binds, { hold: "alt", code: "Backquote" }, "on").withGesture).toEqual([]);
  });

  it("(b) a Cmd hold on a digit meets jump-to-tab's range", () => {
    expect(conflicts(DEFAULT_BINDINGS, { hold: "cmd", code: "Digit3" }, "on").withGesture)
      .toEqual(["jump-to-tab"]);
  });

  it("(b) says nothing while the gesture is off", () => {
    const binds = { ...DEFAULT_BINDINGS, "search-everywhere": b("`", { alt: true }) };
    expect(conflicts(binds, { hold: "alt", code: "Backquote" }, "off").withGesture).toEqual([]);
  });

  it("(c) double-Shift conflicts with nothing: an unbound search row is clean", () => {
    const c = conflicts(DEFAULT_BINDINGS, DEFAULT_RECENT_TABS, "on");
    expect(c.chords.has("search-everywhere")).toBe(false);
    expect(c.withGesture).not.toContain("search-everywhere");
  });

  it("(d) Tab stays out of chords, so the default gesture never meets one", () => {
    expect(isReservedKey("Tab")).toBe(true);
    for (const d of SHORTCUT_DEFS) expect(d.defaultBinding?.key, d.id).not.toBe("Tab");
  });
});

describe("Tab is not bindable", () => {
  it("is refused by the recorder whatever modifiers are on it", () => {
    // Recording ⌃⇥ would store {cmd:true, key:"Tab"} and, because of the
    // Cmd/Ctrl fold, that command would then fire on every press of the
    // recently-used-tabs gesture, forever, on top of it.
    expect(isReservedKey("Tab")).toBe(true);
    for (const b of [
      { cmd: true, shift: false, alt: false, key: "Tab" },
      { cmd: true, shift: true, alt: false, key: "Tab" },
      { cmd: false, shift: false, alt: true, key: "Tab" },
    ]) {
      expect(isValidBinding(b), JSON.stringify(b)).toBe(false);
    }
  });

  it("does not reserve anything else", () => {
    expect(isReservedKey("t")).toBe(false);
    expect(isValidBinding({ cmd: true, shift: false, alt: false, key: "t" })).toBe(true);
  });

  it("is claimed by no default binding", () => {
    for (const d of SHORTCUT_DEFS) expect(d.defaultBinding?.key, d.id).not.toBe("Tab");
  });
});

describe("the code-navigation group", () => {
  it("holds the editor jumps, and not the histories that also walk folders", () => {
    // Back / Forward stay in Navigation: they walk a folder listing's trail
    // as well as the symbol trail, so filing them under code navigation would
    // describe half of what they do.
    const inGroup = SHORTCUT_DEFS.filter(d => d.group === "Code navigation").map(d => d.id);
    expect(inGroup.sort()).toEqual([
      "file-structure", "find-usages", "go-to-definition",
      "go-to-implementation", "go-to-type-definition", "search-everywhere",
    ]);
    expect(SHORTCUT_DEFS.find(d => d.id === "nav-back")?.group).toBe("Navigation");
  });
});

describe("AltGr", () => {
  const ev = (o: Partial<KeyboardEvent> & { altGraph?: boolean }) => ({
    key: "p", code: "KeyP", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    getModifierState: (m: string) => m === "AltGraph" && !!o.altGraph,
    ...o,
  }) as unknown as KeyboardEvent;
  const ctrlAltP = { key: "p", cmd: true, shift: false, alt: true };

  it("does not fire a Ctrl+Alt binding from an AltGr key", () => {
    expect(bindingMatches(ev({ ctrlKey: true, altKey: true, altGraph: true }), ctrlAltP)).toBe(false);
  });
  it("still fires it from a real Ctrl+Alt", () => {
    expect(bindingMatches(ev({ ctrlKey: true, altKey: true }), ctrlAltP)).toBe(true);
  });
});

describe("terminal app shortcut matching", () => {
  const fileFinder = DEFAULT_BINDINGS["file-finder"];
  // Build key events with explicit modifiers for shortcut matching.
  const event = (modifiers: Partial<KeyboardEvent>) => ({
    key: "p", code: "KeyP", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    getModifierState: () => false, ...modifiers,
  }) as KeyboardEvent;

  it("leaves macOS Control+P for the terminal", () => {
    const ctrlP = event({ ctrlKey: true });
    expect(bindingMatches(ctrlP, fileFinder)).toBe(true);
    expect(matchesTerminalAppBinding(ctrlP, fileFinder, true)).toBe(false);
  });

  it("still passes macOS Command+P to the app", () => {
    expect(matchesTerminalAppBinding(event({ metaKey: true }), fileFinder, true)).toBe(true);
  });

  it("keeps modified Ctrl shortcuts available off macOS", () => {
    const binding = { key: "p", cmd: true, shift: true, alt: false };
    expect(matchesTerminalAppBinding(event({ ctrlKey: true, shiftKey: true }), binding, false)).toBe(true);
  });
});

describe("Shift and punctuation", () => {
  // What WebKitGTK and Chromium deliver for Ctrl+Shift+[ : the character.
  const ev = (key: string, o: Partial<KeyboardEvent> = {}) => ({
    key, code: "", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false,
    getModifierState: () => false, ...o,
  }) as unknown as KeyboardEvent;

  it("matches the default previous / next tab chords when the event says { and }", () => {
    expect(bindingMatches(ev("{"), DEFAULT_BINDINGS["tab-prev"])).toBe(true);
    expect(bindingMatches(ev("}"), DEFAULT_BINDINGS["tab-next"])).toBe(true);
    // And still when a platform reports the key itself.
    expect(bindingMatches(ev("["), DEFAULT_BINDINGS["tab-prev"])).toBe(true);
  });

  it("does not confuse them with the unshifted chord", () => {
    // Cmd+[ is Back. Without Shift, `{` cannot arrive, and `[` must not be tab-prev.
    expect(bindingMatches(ev("[", { shiftKey: false }), DEFAULT_BINDINGS["tab-prev"])).toBe(false);
    expect(bindingMatches(ev("[", { shiftKey: false }), DEFAULT_BINDINGS["nav-back"])).toBe(true);
    expect(bindingMatches(ev("{"), DEFAULT_BINDINGS["nav-back"])).toBe(false);
  });

  it("still honours a binding that was recorded as the shifted character", () => {
    // A rebind saved before this by a Linux or Windows user reads `{` + Shift.
    const recorded = { key: "{", cmd: true, shift: true, alt: false };
    expect(bindingMatches(ev("{"), recorded)).toBe(true);
  });

  it("records the key, not the character", () => {
    expect(bindingFromEvent(ev("{"))).toEqual({ key: "[", cmd: true, shift: true, alt: false });
    expect(bindingFromEvent(ev("+"))).toEqual({ key: "=", cmd: true, shift: true, alt: false });
  });
});

describe("bindingText", () => {
  it("uses the Windows / Linux modifier order off macOS", () => {
    expect(bindingText({ key: "p", cmd: true, shift: true, alt: false }, false)).toBe("Ctrl+Shift+P");
    expect(bindingText({ key: "p", cmd: true, shift: false, alt: true }, false)).toBe("Ctrl+Alt+P");
    expect(bindingText({ key: "ArrowUp", cmd: false, shift: false, alt: true }, false)).toBe("Alt+Up");
  });
  it("keeps the glyph run on macOS", () => {
    expect(bindingText({ key: "p", cmd: true, shift: true, alt: false }, true)).toBe("⇧⌘P");
  });
});

// TerminalPane's PASS_TO_APP. On macOS Ctrl is the terminal's own modifier
// (GH #10), and useShortcuts bails on a Mac Ctrl chord in a terminal, so a
// Ctrl press the terminal handed over would reach neither the shell nor the
// app. Only Cmd may be taken there.
describe("terminalPassesToApp", () => {
  const ev = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }) => ({
    key, code: `Key${key.toUpperCase()}`,
    ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt,
    getModifierState: () => false,
  }) as unknown as KeyboardEvent;
  const binds = { ...DEFAULT_BINDINGS, "search-everywhere": { cmd: true, shift: false, alt: false, key: "r" } };
  const ids = ["file-finder", "search-everywhere"] as const;

  it("on macOS hands over ⌘R bound to Search everywhere", () => {
    expect(terminalPassesToApp(ev("r", { meta: true }), binds, ids, true)).toBe(true);
  });

  it("on macOS keeps ⌃R (reverse search) for the shell, though ⌘R is bound", () => {
    expect(terminalPassesToApp(ev("r", { ctrl: true }), binds, ids, true)).toBe(false);
    // The same for the shipped ⌘P: ⌃P is readline's previous line.
    expect(terminalPassesToApp(ev("p", { ctrl: true }), binds, ids, true)).toBe(false);
    expect(terminalPassesToApp(ev("p", { meta: true }), binds, ids, true)).toBe(true);
  });

  it("off macOS keeps plain Ctrl+letter, and takes it with Shift or Alt", () => {
    expect(terminalPassesToApp(ev("r", { ctrl: true }), binds, ids, false)).toBe(false);
    const shifted = { ...binds, "search-everywhere": { cmd: true, shift: true, alt: false, key: "r" } };
    expect(terminalPassesToApp(ev("r", { ctrl: true, shift: true }), shifted, ids, false)).toBe(true);
  });
});
