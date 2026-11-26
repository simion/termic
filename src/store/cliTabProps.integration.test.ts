// @vitest-environment happy-dom
//
// `termic prop` (GH #358) driven through the REAL handler against the REAL
// store: what matters is what the store does with a property (where it
// goes, what reaches disk, what a no-op skips), not the handler's own lines.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { tabPropsHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { PersistedTab, Task, TerminalTab } from "@/lib/types";

const AGENTS = [
  { id: "claude", display_name: "Claude Code", disabled: false, command: "claude", args: [] },
  { id: "codex", display_name: "Codex", disabled: false, command: "codex", args: [] },
];

function task(over: Partial<Task> = {}): Task {
  return {
    id: "ws1", project_id: "p1", name: "fix-auth", branch: "main",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false,
    persisted_tabs: [
      { id: "main", cli: "claude", title: "claude", is_default: true, session_id: "S-A" },
      { id: "second", cli: "codex", title: "codex", session_id: "S-B" },
    ],
    ...over,
  } as unknown as Task;
}

const term = (over: Record<string, unknown>) =>
  ({ type: "terminal", title: "Claude Code", cli: "claude", ...over }) as unknown as TerminalTab;

/** A mounted task with both agents in the strip, the state a write needs. */
function seedMounted() {
  useApp.setState({
    tasks: [task()],
    tabs: {
      ws1: [
        term({ id: "main", cli: "claude", is_default: true, sessionId: "S-A" }),
        term({ id: "second", cli: "codex", title: "Codex", sessionId: "S-B" }),
      ],
    },
    mountedTasks: new Set(["ws1"]),
    agents: AGENTS,
  } as never);
  vi.mocked(ipc.taskSetTabs).mockClear();
}

const set = (tabId: string, key: string, value: string) =>
  tabPropsHandler({ taskId: "ws1", set: { tabId, key, value } });
const tabProps = (id: string) =>
  (useApp.getState().tabs.ws1 ?? []).find(t => t.id === id) as TerminalTab;
const lastDurable = (): PersistedTab[] => {
  const calls = vi.mocked(ipc.taskSetTabs).mock.calls;
  return calls[calls.length - 1][1] as PersistedTab[];
};

describe("termic prop: writing", () => {
  beforeEach(seedMounted);

  it("puts the property on that tab only, and persists it with the tab", async () => {
    const r = await set("second", "ticket", " ABC-2 ");
    expect(tabProps("second").props).toMatchObject([{ key: "ticket", value: "ABC-2" }]);
    expect(tabProps("main").props).toBeUndefined();
    expect(lastDurable().find(t => t.id === "second")?.props).toMatchObject([{ key: "ticket", value: "ABC-2" }]);
    expect(r.tabs).toEqual([{ tab_id: "second", cli: "codex", title: "Codex", props: [{ key: "ticket", value: "ABC-2" }] }]);
    expect(r.collected).toEqual([{ key: "ticket", values: ["ABC-2"] }]);
  });

  it("collects two tabs' values for one key in strip order", async () => {
    await set("second", "ticket", "ABC-2");
    const r = await set("main", "ticket", "ABC-1");
    expect(r.collected).toEqual([{ key: "ticket", values: ["ABC-1", "ABC-2"] }]);
  });

  it("an unchanged value writes nothing; \"\" clears", async () => {
    await set("main", "status", "ToDo");
    vi.mocked(ipc.taskSetTabs).mockClear();
    await set("main", "status", "ToDo");
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
    const r = await set("main", "status", "");
    expect(tabProps("main").props).toBeUndefined();
    expect(r.collected).toEqual([]);
  });

  it("answers bad input, a vanished tab, a full tab and a stopped task with typed errors", async () => {
    await expect(set("main", "Bad Key", "x")).rejects.toThrow(/^cli_tab_prop:invalid:/);
    await expect(set("gone", "k", "x")).rejects.toThrow(/^cli_tab_prop:unknown_tab:/);
    for (let i = 0; i < 8; i++) await set("main", `k${i}`, "v");
    await expect(set("main", "k8", "v")).rejects.toThrow(/^cli_tab_prop:too_many:/);
    useApp.setState({ mountedTasks: new Set() } as never);
    await expect(set("main", "k0", "w")).rejects.toThrow(/^cli_tab_prop:task_stopped:/);
  });
});

describe("termic prop: reading a task not opened this session", () => {
  it("lists the durable tabs' properties without mounting anything", async () => {
    useApp.setState({
      tasks: [task({
        persisted_tabs: [
          { id: "main", cli: "claude", is_default: true, props: [{ key: "ticket", value: "ABC-1", since: 1 }] },
          { id: "second", cli: "codex", custom_title: true, title: "reviewer", props: [{ key: "ticket", value: "ABC-2", since: 2 }] },
        ],
      } as Partial<Task>)],
      tabs: {},
      mountedTasks: new Set(),
      agents: AGENTS,
    } as never);
    const r = await tabPropsHandler({ taskId: "ws1" });
    expect(r.collected).toEqual([{ key: "ticket", values: ["ABC-1", "ABC-2"] }]);
    expect(r.tabs.map(t => [t.tab_id, t.title])).toEqual([["main", "Claude Code"], ["second", "reviewer"]]);
    expect(useApp.getState().mountedTasks.size).toBe(0);
  });
});

describe("termic prop: split-pane tabs", () => {
  it("sets and collects properties on a split-pane tab by id", async () => {
    useApp.setState({
      tasks: [task()],
      tabs: {
        ws1: [
          term({ id: "main", cli: "claude", is_default: true }),
          term({ id: "pane-1", paneId: "leaf-1", cli: "codex", title: "Split Codex" }),
        ],
      },
      mountedTasks: new Set(["ws1"]),
      agents: AGENTS,
    } as never);
    const r = await tabPropsHandler({ taskId: "ws1", set: { tabId: "pane-1", key: "role", value: "reviewer" } });
    expect(r.collected).toEqual([{ key: "role", values: ["reviewer"] }]);
    expect(r.tabs).toEqual([
      { tab_id: "pane-1", cli: "codex", title: "Split Codex", props: [{ key: "role", value: "reviewer" }] },
    ]);
  });
});
