import { describe, it, expect } from "vitest";
import { resolveTargetPty } from "./activeTerminal";
import type { Tab } from "./types";

const term = (id: string, ptyId?: string): Tab =>
  ({ id, type: "terminal", title: id, cli: "claude", ptyId } as Tab);
const edit = (id: string): Tab => ({ id, type: "edit", title: id, path: `${id}.ts` } as Tab);

describe("resolveTargetPty", () => {
  it("returns the active terminal tab's pty", () => {
    const tabs = [term("a", "pty-a"), term("b", "pty-b")];
    expect(resolveTargetPty(tabs, "b")).toBe("pty-b");
  });

  it("falls back to the first terminal pty when the active tab is an editor", () => {
    const tabs = [edit("doc"), term("t", "pty-t")];
    expect(resolveTargetPty(tabs, "doc")).toBe("pty-t");
  });

  it("returns null when there are no terminal tabs", () => {
    expect(resolveTargetPty([edit("a"), edit("b")], "a")).toBeNull();
  });

  it("returns null when the only terminal has not spawned a pty yet", () => {
    expect(resolveTargetPty([term("a")], "a")).toBeNull();
  });

  it("skips an un-spawned active terminal and uses a later spawned one", () => {
    const tabs = [term("a"), term("b", "pty-b")];
    expect(resolveTargetPty(tabs, "a")).toBe("pty-b");
  });
});
