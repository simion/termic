import { describe, expect, it } from "vitest";

import { formatTerminalTitle, isConsoleHostTitle } from "./terminalTitle";

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

  it("removes the circle and star spinner families, not only Braille", () => {
    expect(formatTerminalTitle("◑ Task name", "claude", true)).toBe("Task name");
    expect(formatTerminalTitle("◐ Task name", "claude", true)).toBe("Task name");
    expect(formatTerminalTitle("✻ Task name", "claude", true)).toBe("Task name");
    expect(formatTerminalTitle("· Task name", "claude", true)).toBe("Task name");
  });

  it("never eats a title's own letters or ASCII punctuation", () => {
    expect(formatTerminalTitle("修复登录", "claude", true)).toBe("修复登录");
    expect(formatTerminalTitle("◑ 修复登录", "claude", true)).toBe("修复登录");
    expect(formatTerminalTitle("#12 fix", "claude", true)).toBe("#12 fix");
    expect(formatTerminalTitle("[wip] login", "claude", true)).toBe("[wip] login");
  });

  it("keeps Claude's spinner when Termic draws no working badge", () => {
    expect(formatTerminalTitle("⠋ Task name", "claude", false)).toBe(
      "⠋ Task name",
    );
  });

  it("always removes the brand glyph: the icon beside the title says it", () => {
    expect(formatTerminalTitle("✳ Task name", "claude", false)).toBe("Task name");
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

describe("isConsoleHostTitle", () => {
  it("recognizes the path ConPTY announces as the title", () => {
    expect(isConsoleHostTitle("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
    expect(isConsoleHostTitle("C:\\Windows\\system32\\cmd.exe")).toBe(true);
    expect(isConsoleHostTitle("D:\\a\\termic\\scripts\\fake-agent.cmd")).toBe(true);
    expect(isConsoleHostTitle("Administrator: C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
  });

  it("leaves a program's own title alone", () => {
    expect(isConsoleHostTitle("\u2733 fakeagent")).toBe(false);
    expect(isConsoleHostTitle("vim C:\\notes\\a.md")).toBe(false);
    expect(isConsoleHostTitle("C:\\repo")).toBe(false);
    expect(isConsoleHostTitle("~/src/app")).toBe(false);
  });
});
