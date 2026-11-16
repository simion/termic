// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Same stubs as cliAgentState.test.ts: taskFilter reaches the app store
// through cliAgentState, which drags in tauri and ipc.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn() }));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli === "claude" ? "Claude" : cli),
  workDoneCapable: vi.fn(() => true),
  isTerminalCli: vi.fn(() => false),
}));

import { filterTasks, isFilterActive, taskFilterFacts, taskHasNotification, taskMatchesText } from "@/lib/taskFilter";
import { computeTrayAttention } from "@/lib/trayAttention";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { Tab, Task, TerminalTab } from "@/lib/types";

function term(o: Partial<TerminalTab> = {}): TerminalTab {
  return { id: crypto.randomUUID(), type: "terminal", cli: "claude", title: "Claude", ...o } as TerminalTab;
}
function task(id: string, name = id, extra: Partial<Task> = {}): Task {
  return { id, name, project_id: "p1", archived: false, ...extra } as Task;
}

describe("taskHasNotification", () => {
  it("counts waiting and done, not working or idle", () => {
    expect(taskHasNotification([term({ unread: { reason: "attention" } })])).toBe(true);
    expect(taskHasNotification([term({ workState: "done" })])).toBe(true);
    expect(taskHasNotification([term({ workState: "idle" })])).toBe(false);
    // Working wins the aggregate, same as the tray: a task still busy in one
    // tab is not "waiting on you" yet.
    expect(taskHasNotification([term({ workState: "working" }), term({ workState: "done" })])).toBe(false);
  });

  it("is false for a task with no loaded or no terminal tabs", () => {
    expect(taskHasNotification(undefined)).toBe(false);
    expect(taskHasNotification([{ id: "d", type: "diff", title: "x" } as unknown as Tab])).toBe(false);
  });

  it("agrees with the tray's numeral", () => {
    const tabs: Record<string, Tab[]> = {
      a: [term({ unread: { reason: "attention" } })],
      b: [term({ workState: "done" })],
      c: [term({ workState: "working" })],
      d: [term()],
    };
    const tasks = ["a", "b", "c", "d"].map(id => task(id));
    useApp.setState({ tasks, tabs, projects: [{ id: "p1", name: "P" } as never] });
    const tray = computeTrayAttention().map(i => i.task_id).sort();
    const ours = tasks.filter(t => taskHasNotification(tabs[t.id])).map(t => t.id).sort();
    expect(ours).toEqual(tray);
  });
});

describe("taskMatchesText", () => {
  it("matches the task name, case-insensitive and trimmed", () => {
    expect(taskMatchesText(task("1", "Fix Login Bug"), taskFilterFacts([]), [], "  login ")).toBe(true);
    expect(taskMatchesText(task("1", "Fix Login Bug"), taskFilterFacts([]), [], "logout")).toBe(false);
  });

  it("matches a stable tab title", () => {
    const tabs = [term({ title: "Reviewer", customTitle: true })];
    expect(taskMatchesText(task("1", "x"), taskFilterFacts(tabs), [], "review")).toBe(true);
  });

  it("matches a tab property value, loaded or persisted (GH #358)", () => {
    const tabs = [term({ props: [{ key: "ticket", value: "ABC-12", since: 1 }] })];
    expect(taskMatchesText(task("1", "x"), taskFilterFacts(tabs), [], "abc-12")).toBe(true);
    expect(taskMatchesText(task("1", "x"), taskFilterFacts(tabs), [], "ticket")).toBe(false);
    const unloaded = task("2", "y", {
      persisted_tabs: [{ id: "a", cli: "claude", props: [{ key: "ticket", value: "ABC-99", since: 1 }] }],
    });
    expect(taskMatchesText(unloaded, undefined, [], "abc-99")).toBe(true);
  });

  it("ignores the agent's live OSC title", () => {
    const tabs = [term({ title: "Claude", liveTitle: "Refactoring parser" })];
    expect(taskMatchesText(task("1", "x"), taskFilterFacts(tabs), [], "parser")).toBe(false);
  });

  it("falls back to persisted tabs for a task not loaded yet", () => {
    const t = task("1", "x", {
      persisted_tabs: [{ id: "a", cli: "claude" }, { id: "b", cli: "codex", title: "Docs", custom_title: true }],
    });
    expect(taskMatchesText(t, undefined, [], "claude")).toBe(true);
    expect(taskMatchesText(t, undefined, [], "docs")).toBe(true);
    expect(taskMatchesText(t, undefined, [], "codex")).toBe(false);
  });

  it("an empty needle matches everything", () => {
    expect(taskMatchesText(task("1", "x"), taskFilterFacts([]), [], "   ")).toBe(true);
  });
});

describe("filterTasks", () => {
  const list = [task("a", "alpha"), task("b", "beta"), task("c", "gamma")];
  const tabs: Record<string, Tab[]> = {
    a: [term({ workState: "done" })],
    b: [term({ unread: { reason: "attention" } })],
    c: [term()],
  };
  const facts = Object.fromEntries(Object.entries(tabs).map(([id, ts]) => [id, taskFilterFacts(ts)]));

  it("returns the list untouched with no active filter", () => {
    expect(filterTasks(list, undefined, facts, [], null)).toBe(list);
    expect(filterTasks(list, { text: "  ", bell: false }, facts, [], null)).toBe(list);
  });

  it("ANDs the bell and the text", () => {
    const ids = (f: { text: string; bell: boolean }) => filterTasks(list, f, facts, [], null).map(t => t.id);
    expect(ids({ text: "", bell: true })).toEqual(["a", "b"]);
    expect(ids({ text: "a", bell: false })).toEqual(["a", "b", "c"]);
    expect(ids({ text: "gam", bell: false })).toEqual(["c"]);
    expect(ids({ text: "gam", bell: true })).toEqual([]);
  });

  it("keeps the active task even when it no longer matches", () => {
    expect(filterTasks(list, { text: "", bell: true }, facts, [], "c").map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a pinned task whatever the filter says (GH #458)", () => {
    // c has no notification and does not match "alp", so only the pin keeps it.
    const pinned = [task("a", "alpha"), task("b", "beta"), { ...task("c", "gamma"), pinned: true }];
    const ids = (f: { text: string; bell: boolean }, active: string | null = null) =>
      filterTasks(pinned, f, facts, [], active).map(t => t.id);
    expect(ids({ text: "alp", bell: false })).toEqual(["a", "c"]);
    expect(ids({ text: "zzz", bell: false })).toEqual(["c"]);
    expect(ids({ text: "", bell: true })).toEqual(["a", "b", "c"]);
    // Pinned and active together is one row, not two.
    expect(ids({ text: "zzz", bell: false }, "c")).toEqual(["c"]);
    // Unpinned, the same task goes like any other.
    expect(filterTasks(list, { text: "zzz", bell: false }, facts, [], null)).toEqual([]);
    expect(filterTasks(list, { text: "alp", bell: false }, facts, [], null).map(t => t.id)).toEqual(["a"]);
  });

  it("isFilterActive treats whitespace as empty", () => {
    expect(isFilterActive(undefined)).toBe(false);
    expect(isFilterActive({ text: " ", bell: false })).toBe(false);
    expect(isFilterActive({ text: "", bell: true })).toBe(true);
  });
});

describe("ui store task filters", () => {
  beforeEach(() => useUI.setState({ taskFilters: {} }));

  it("drops a project's entry once both parts are empty", () => {
    const s = useUI.getState();
    s.setTaskFilterText("p1", "foo");
    s.toggleTaskFilterBell("p1");
    expect(useUI.getState().taskFilters.p1).toEqual({ text: "foo", bell: true });
    s.setTaskFilterText("p1", "");
    s.toggleTaskFilterBell("p1");
    expect(useUI.getState().taskFilters).toEqual({});
  });

  it("keeps the same map for an unchanged write", () => {
    useUI.getState().setTaskFilterText("p1", "foo");
    const before = useUI.getState().taskFilters;
    useUI.getState().setTaskFilterText("p1", "foo");
    useUI.getState().setTaskFilterText("p2", "");
    expect(useUI.getState().taskFilters).toBe(before);
  });
});
