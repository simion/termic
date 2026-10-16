import { describe, expect, it } from "vitest";
import { terminalNewlineBytes } from "./terminalNewline";

describe("terminal Shift+Enter", () => {
  it("uses OpenCode's newline binding without a backslash or submit CR", () => {
    expect(terminalNewlineBytes("opencode")).toEqual([0x0a]);
  });

  it.each(["claude", "codex", "agy", "shell", "custom"])("keeps %s's existing encoding", id => {
    expect(terminalNewlineBytes(id)).toEqual([0x5c, 0x0d]);
  });
});
