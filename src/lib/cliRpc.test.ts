// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
// cliRpc pulls in the tauri event/core APIs at module load, and useApp
// (via @/store/app) pulls in ipc/tabFocus/agents. Stub them all so the
// aggregation logic can be tested in the node/happy-dom env.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@/lib/agents", () => ({ agentDisplayName: vi.fn((cli: string) => cli) }));

import { workStateHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import type { Tab, TerminalTab } from "@/lib/types";

function term(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: crypto.randomUUID(),
    type: "terminal",
    cli: "claude",
    title: "t",
    ...overrides,
  } as TerminalTab;
}

/** Set the store's tabs for a set of tasks and query their states. */
function statesFor(tabs: Record<string, Tab[]>): Record<string, { state: string; tabs: number }> {
  useApp.setState({ tabs });
  return workStateHandler({ taskIds: Object.keys(tabs) }).states;
}

describe("workStateHandler aggregation", () => {
  beforeEach(() => useApp.setState({ tabs: {} }));

  it("follows the sidebar precedence: working > attention > done > idle", () => {
    const s = statesFor({
      working: [term({ workState: "done" }), term({ workState: "working" })],
      waiting: [term({ workState: "done" }), term({ unread: { reason: "attention" } })],
      done: [term({ workState: "idle" }), term({ workState: "done" })],
      idle: [term({ workState: "idle" })],
    });
    expect(s.working.state).toBe("working");
    expect(s.waiting.state).toBe("waiting");
    expect(s.done.state).toBe("done");
    expect(s.idle.state).toBe("idle");
  });

  it("reports 'inactive' with 0 tabs when a task has no live terminal tabs", () => {
    const s = statesFor({ dormant: [] });
    expect(s.dormant).toEqual({ state: "inactive", tabs: 0 });
  });

  it("counts only terminal tabs and reports the count", () => {
    const editor = { id: "e", type: "editor" } as unknown as Tab;
    const s = statesFor({ mixed: [term({ workState: "idle" }), editor, term({ workState: "idle" })] });
    expect(s.mixed).toEqual({ state: "idle", tabs: 2 });
  });

  it("ignores non-string task ids and returns an empty map for none", () => {
    useApp.setState({ tabs: { a: [term({ workState: "idle" })] } });
    expect(workStateHandler({ taskIds: [1, null, {}] }).states).toEqual({});
    expect(workStateHandler({}).states).toEqual({});
  });
});
