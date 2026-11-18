import { describe, expect, it } from "vitest";
import { ACTIVE_MIX, MATCH_MIX, decorationsFor, findCountLabel, isTerminalCloseCombo, isTerminalFindCombo, mix, parseHex, toHex } from "./terminalFind";

describe("terminal find colours", () => {
  it("parses the hex forms a theme writes, dropping alpha", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#1e1e1e")).toEqual([30, 30, 30]);
    expect(parseHex("#1e1e1e80")).toEqual([30, 30, 30]);
    expect(parseHex("rgb(1,2,3)")).toBeNull();
  });

  it("every value handed to xterm is #RRGGBB, the only form it accepts", () => {
    const d = decorationsFor([217, 119, 87], [20, 20, 20]);
    for (const v of Object.values(d)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("the current match is a stronger wash of the accent than the rest", () => {
    const accent: [number, number, number] = [200, 100, 50];
    const bg: [number, number, number] = [0, 0, 0];
    const d = decorationsFor(accent, bg);
    expect(d.matchBackground).toBe(toHex(mix(accent, bg, MATCH_MIX)));
    expect(d.activeMatchBackground).toBe(toHex(mix(accent, bg, ACTIVE_MIX)));
    expect(ACTIVE_MIX).toBeGreaterThan(MATCH_MIX);
    expect(d.activeMatchBorder).toBe("#c86432");
  });

  it("blends toward a light background as well as a dark one", () => {
    expect(toHex(mix([0, 0, 0], [255, 255, 255], 0.3))).toBe("#b3b3b3");
  });
});

describe("terminal find count label", () => {
  it("reads as position of total", () => {
    expect(findCountLabel(0, 3, 1000)).toBe("1 of 3");
    expect(findCountLabel(2, 3, 1000)).toBe("3 of 3");
  });
  it("says so when nothing matches", () => {
    expect(findCountLabel(-1, 0, 1000)).toBe("No results");
  });
  it("past the highlight cap the addon has no index", () => {
    expect(findCountLabel(-1, 1000, 1000)).toBe("1000+ matches");
  });
});

describe("terminal find key", () => {
  // node environment: no KeyboardEvent constructor, and only these fields are read.
  const key = (init: Partial<KeyboardEvent>) =>
    ({ key: "f", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...init }) as KeyboardEvent;
  it("is exactly Cmd+F on macOS, leaving Shift+Cmd+F to find-in-files", () => {
    expect(isTerminalFindCombo(key({ metaKey: true }), true)).toBe(true);
    expect(isTerminalFindCombo(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isTerminalFindCombo(key({ ctrlKey: true }), true)).toBe(false);
  });
  it("is Ctrl+Alt+F elsewhere, leaving Ctrl+F to readline and Ctrl+Shift+F to find-in-files", () => {
    expect(isTerminalFindCombo(key({ ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(isTerminalFindCombo(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isTerminalFindCombo(key({ ctrlKey: true }), false)).toBe(false);
    // AltGr+F typing a character on its layout (Hungarian: "[") is typing.
    expect(isTerminalFindCombo(key({ key: "[", ctrlKey: true, altKey: true }), false)).toBe(false);
  });
  it("close-tab from a terminal is Ctrl+Shift+W off macOS, and never plain Ctrl+W", () => {
    const w = (init: Partial<KeyboardEvent>) => key({ key: "w", ...init });
    expect(isTerminalCloseCombo(w({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    // Shift makes the key an upper-case W on a real keyboard.
    expect(isTerminalCloseCombo(w({ key: "W", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    // The shell keeps delete-previous-word.
    expect(isTerminalCloseCombo(w({ ctrlKey: true }), false)).toBe(false);
    expect(isTerminalCloseCombo(w({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
    // macOS has ⌘W and needs no second chord.
    expect(isTerminalCloseCombo(w({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isTerminalCloseCombo(w({ metaKey: true }), true)).toBe(false);
  });
});
