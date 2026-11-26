// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS, bindingFromEvent, bindingMatches, eventKeyToken, isAppChordInTerminal, isTabKey,
  setSuperHeldForTests, superIsHeld,
} from "./shortcuts";
import { IS_LINUX } from "./platform";

// Its own file because it needs a DOM, and a DOM is what makes platform.ts
// answer "Linux": shortcuts.test.ts runs under node, which reads as macOS.

it("runs as Linux", () => {
  expect(IS_LINUX).toBe(true);
});

// The unit-test DOM reports Linux (see platform.ts), which is the platform
// these are about. The shapes below are what WebKitGTK delivered for real X
// key events, measured: Super never shows up as a modifier on the letter.
describe("Super on Linux", () => {
  const press = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  const j = () => ({
    key: "j", code: "KeyJ", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    getModifierState: () => false,
  }) as unknown as KeyboardEvent;
  const cmdJ = { key: "j", cmd: true, shift: false, alt: false };

  it("counts as Cmd while it is held, from its own keydown and keyup", () => {
    expect(bindingMatches(j(), cmdJ)).toBe(false);
    press("keydown", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(true);
    expect(bindingMatches(j(), cmdJ)).toBe(true);
    press("keyup", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(false);
    // The same event is a typed j again.
    expect(bindingMatches(j(), cmdJ)).toBe(false);
  });

  it("lets go when the window loses focus, since the keyup can go with it", () => {
    press("keydown", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(superIsHeld()).toBe(false);
  });

  // A keyup that went missing while the window kept focus left Super "held"
  // until the next focus change: every letter a shortcut, every terminal
  // deaf. A press now lapses on its own.
  it("forgets a press whose keyup never came, without a focus change", () => {
    const t0 = Date.now();
    press("keydown", { key: "Super", code: "OSLeft" });
    expect(superIsHeld(t0 + 1000)).toBe(true);
    expect(superIsHeld(t0 + 2000)).toBe(false);
    expect(superIsHeld()).toBe(false);
  });

  it("stays held through a run of chords, each renewing it", () => {
    press("keydown", { key: "Super", code: "OSLeft" });
    press("keydown", { key: "1", code: "Digit1" });
    expect(superIsHeld()).toBe(true);
    press("keyup", { key: "Super", code: "OSLeft" });
    expect(superIsHeld()).toBe(false);
  });

  it("does not turn a bare-key binding into a Super one", () => {
    setSuperHeldForTests(true);
    try {
      const f12 = { key: "F12", cmd: false, shift: false, alt: false };
      const e = { ...j(), key: "F12", code: "F12" } as unknown as KeyboardEvent;
      expect(bindingMatches(e, f12)).toBe(false);
    } finally { setSuperHeldForTests(false); }
  });

  it("records a chord pressed with Super as a Cmd binding, and never Super alone", () => {
    setSuperHeldForTests(true);
    try {
      expect(bindingFromEvent(j())).toEqual(cmdJ);
      const superKey = { ...j(), key: "Super", code: "OSLeft" } as unknown as KeyboardEvent;
      expect(bindingFromEvent(superKey)).toBeNull();
    } finally { setSuperHeldForTests(false); }
  });
});

describe("Shift+Tab on Linux", () => {
  // X gives Shift+Tab the keysym ISO_Left_Tab; WebKitGTK reports it so.
  const shiftTab = { key: "Unidentified", code: "Tab", ctrlKey: true, shiftKey: true } as unknown as KeyboardEvent;
  it("is still Tab", () => {
    expect(isTabKey(shiftTab)).toBe(true);
    expect(eventKeyToken(shiftTab)).toBe("Tab");
    expect(isTabKey({ key: "Tab", code: "Tab" } as unknown as KeyboardEvent)).toBe(true);
    expect(isTabKey({ key: "Unidentified", code: "KeyQ" } as unknown as KeyboardEvent)).toBe(false);
  });
});

describe("what a terminal hands to the app off macOS", () => {
  const ev = (key: string, o: Partial<KeyboardEvent> = {}) => ({
    key, code: "", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false,
    getModifierState: () => false, ...o,
  }) as unknown as KeyboardEvent;
  const app = (e: KeyboardEvent) => isAppChordInTerminal(e, DEFAULT_BINDINGS);

  it("keeps plain Ctrl+letter for the shell", () => {
    // Line feed, clear screen, previous line, kill line: all readline's.
    for (const k of ["j", "l", "p", "k", "d", "w", "t", "n", "o", "b"]) expect(app(ev(k))).toBe(false);
  });

  it("gives up every chord that also carries Shift or Alt", () => {
    expect(app(ev("ArrowLeft", { altKey: true }))).toBe(true);   // pane left
    expect(app(ev("ArrowDown", { altKey: true }))).toBe(true);   // next task
    expect(app(ev("p", { altKey: true }))).toBe(true);           // prompt palette
    expect(app(ev("b", { altKey: true }))).toBe(true);           // right sidebar
    expect(app(ev("P", { shiftKey: true }))).toBe(true);         // command palette
    expect(app(ev("}", { shiftKey: true }))).toBe(true);         // next tab
  });

  it("leaves the terminal its own copy and paste", () => {
    expect(app(ev("C", { shiftKey: true }))).toBe(false);
    expect(app(ev("V", { shiftKey: true }))).toBe(false);
  });

  it("hands Ctrl+Shift+F to the app as find-in-files, and keeps Ctrl+Alt+F for the terminal's find", () => {
    expect(app(ev("F", { shiftKey: true }))).toBe(true);
    expect(app(ev("f", { altKey: true }))).toBe(false);
  });

  it("does not take Alt+Arrow, which has no Cmd in it", () => {
    // Word movement in every shell. sidebar-prev / sidebar-next are bound to
    // it and fire outside a terminal only.
    expect(app(ev("ArrowUp", { ctrlKey: false, altKey: true }))).toBe(false);
  });

  it("does not take an unbound Ctrl+Alt chord from a TUI", () => {
    expect(app(ev("x", { altKey: true }))).toBe(false);
  });
});
