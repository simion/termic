import { describe, expect, it } from "vitest";
import { clearRemoteInterrupt, noteRemoteInterrupt, remoteInterruptAt } from "./remoteInterrupt";

describe("remote interrupts", () => {
  it("are kept per PTY until spent", () => {
    expect(remoteInterruptAt("pty-a")).toBe(0);
    noteRemoteInterrupt("pty-a", 1000);
    expect(remoteInterruptAt("pty-a")).toBe(1000);
    // Another agent's PTY is not licensed by it.
    expect(remoteInterruptAt("pty-b")).toBe(0);
    clearRemoteInterrupt("pty-a");
    expect(remoteInterruptAt("pty-a")).toBe(0);
  });

  it("ignore a tab with no PTY yet", () => {
    expect(remoteInterruptAt(null)).toBe(0);
    expect(remoteInterruptAt(undefined)).toBe(0);
    expect(() => clearRemoteInterrupt(null)).not.toThrow();
  });
});
