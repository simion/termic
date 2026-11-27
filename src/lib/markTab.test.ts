// @vitest-environment happy-dom
// `termic mark` / MCP `task_mark` (GH #473): each state lands as the badge
// the sidebar draws, with no OS banner, and `clear` takes all of them off.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn() }));

import { useApp } from "@/store/app";
import { markTabHandler } from "@/lib/cliRpc";
import { taskWorkBadge } from "@/lib/taskWorkState";
import type { Tab, TerminalTab } from "@/lib/types";

const prefs = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
const tabs = () => useApp.getState().tabs.t1 as Tab[];
const tab = () => tabs()[0] as TerminalTab;
const mark = (state: string, tabId = "a") => markTabHandler({ taskId: "t1", tabId, state });

beforeEach(() => {
  useApp.setState({
    tabs: {
      t1: [
        { id: "a", type: "terminal", title: "claude", cli: "claude" } as Tab,
        { id: "e", type: "edit", title: "x.ts", path: "/x.ts" } as unknown as Tab,
      ],
    },
  });
});

describe("markTabHandler", () => {
  it("done draws the done badge, badge only", async () => {
    await mark("done");
    expect(taskWorkBadge(tabs(), prefs)).toBe("done");
    expect(tab().unread).toEqual({ reason: "done", repeat: true });
  });

  it("attention draws needs-you, badge only", async () => {
    await mark("attention");
    expect(taskWorkBadge(tabs(), prefs)).toBe("attention");
    expect(tab().unread?.repeat).toBe(true);
  });

  it("unread draws the reminder dot", async () => {
    await mark("unread");
    expect(tab().markedUnread).toBe(true);
    expect(taskWorkBadge(tabs(), prefs)).toBe("marked");
  });

  it("clear removes every one of them", async () => {
    await mark("attention");
    await mark("unread");
    await mark("clear");
    expect(tab().unread).toBeFalsy();
    expect(tab().markedUnread).toBe(false);
    expect(tab().workState).not.toBe("done");
    expect(taskWorkBadge(tabs(), prefs)).toBeNull();
  });

  it("clear on a tab with nothing set writes nothing", async () => {
    const before = useApp.getState().tabs;
    await mark("clear");
    expect(useApp.getState().tabs).toBe(before);
  });

  it("refuses a state it does not know, and a tab that is not a terminal", async () => {
    await expect(mark("finished")).rejects.toThrow(/done, attention, unread or clear/);
    await expect(mark("done", "e")).rejects.toThrow(/cli_mark:unknown_tab/);
    await expect(mark("done", "gone")).rejects.toThrow(/cli_mark:unknown_tab/);
  });
});

describe("markTaskUnread (the task row's Mark as unread, GH #473)", () => {
  it("marks the task's active terminal tab", () => {
    useApp.setState({
      tabs: { t1: [
        { id: "a", type: "terminal", title: "claude", cli: "claude" } as Tab,
        { id: "b", type: "terminal", title: "codex", cli: "codex" } as Tab,
      ] },
      activeTab: { t1: "b" },
    });
    expect(useApp.getState().markTaskUnread("t1")).toBe(true);
    const [a, b] = tabs() as TerminalTab[];
    expect(b.markedUnread).toBe(true);
    expect(a.markedUnread).toBeFalsy();
  });

  it("falls back to the first terminal tab when an editor is active", () => {
    useApp.setState({ activeTab: { t1: "e" } });
    expect(useApp.getState().markTaskUnread("t1")).toBe(true);
    expect(tab().markedUnread).toBe(true);
  });

  it("says no when the task has no terminal tab", () => {
    useApp.setState({ tabs: { t1: [{ id: "e", type: "edit", title: "x", path: "/x" } as unknown as Tab] } });
    expect(useApp.getState().markTaskUnread("t1")).toBe(false);
    expect(useApp.getState().markTaskUnread("nope")).toBe(false);
  });
});
