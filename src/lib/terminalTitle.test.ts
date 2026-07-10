import { describe, expect, it } from "vitest";

import { formatTerminalTitle } from "./terminalTitle";

describe("formatTerminalTitle", () => {
  it("removes Claude's idle brand glyph when hiding is enabled", () => {
    expect(formatTerminalTitle("✳ Task name", "claude", true)).toBe(
      "Task name",
    );
  });

  it("removes one Claude Braille spinner glyph", () => {
    expect(formatTerminalTitle("⠋ Task name", "claude", true)).toBe(
      "Task name",
    );
  });

  it("removes multiple Claude Braille spinner glyphs", () => {
    expect(formatTerminalTitle("⠐ ⠂ Task name", "claude", true)).toBe(
      "Task name",
    );
  });

  it("keeps the raw Claude title when hiding is disabled", () => {
    expect(formatTerminalTitle("⠋ Task name", "claude", false)).toBe(
      "⠋ Task name",
    );
  });

  it("does not modify other CLI titles", () => {
    expect(formatTerminalTitle("⠋ Task name", "codex", true)).toBe(
      "⠋ Task name",
    );
  });

  it("does not modify ordinary Claude titles", () => {
    expect(formatTerminalTitle("Task name", "claude", true)).toBe("Task name");
  });
});
