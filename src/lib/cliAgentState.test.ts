// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// Mocks must be declared before the module under test is imported.
// cliAgentState pulls in the tauri core API and useApp (via @/store/app),
// which pulls in ipc/tabFocus/agents. Stub them all so the aggregation
// logic can be tested in the node/happy-dom env.
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
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
  // The real rule's shape: shells never qualify, `work_done: false`
  // registry entries opt out, unknown clis default on.
  workDoneCapable: vi.fn((cli: string) => cli !== "shell" && cli !== "nodone"),
}));

import { computeAgentStates } from "@/lib/cliAgentState";
import { useApp } from "@/store/app";
import type { Tab, Task, TerminalTab } from "@/lib/types";

function term(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: crypto.randomUUID(),
    type: "terminal",
    cli: "claude",
    title: "t",
    ...overrides,
  } as TerminalTab;
}

function task(id: string, archived = false): Task {
  return { id, name: id, project_id: "p1", archived } as Task;
}

/** Seed the store with one task per entry and aggregate. */
function statesFor(tabs: Record<string, Tab[]>) {
  useApp.setState({
    tasks: Object.keys(tabs).map(id => task(id)),
    tabs,
  });
  return computeAgentStates();
}

describe("computeAgentStates aggregation", () => {
  beforeEach(() => useApp.setState({ tasks: [], tabs: {} }));

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
    expect(s.dormant).toEqual({ state: "inactive", tabs: 0, queued: 0, capable: false });
  });

  it("counts only terminal tabs and reports the count", () => {
    const editor = { id: "e", type: "editor" } as unknown as Tab;
    const s = statesFor({ mixed: [term({ workState: "idle" }), editor, term({ workState: "idle" })] });
    expect(s.mixed.tabs).toBe(2);
  });

  it("sums queued messages across tabs (quiescence needs 0)", () => {
    const q = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: String(i), text: "x", repeat: 1, remaining: 1 }));
    const s = statesFor({
      busy: [term({ workState: "done", queue: q(2) }), term({ queue: q(1) })],
      clear: [term({ workState: "done" })],
    });
    expect(s.busy.queued).toBe(3);
    expect(s.clear.queued).toBe(0);
  });

  it("marks capability from the registry rule (any capable tab counts)", () => {
    const s = statesFor({
      capable: [term({ cli: "shell" }), term({ cli: "claude" })],
      incapable: [term({ cli: "shell" }), term({ cli: "nodone" })],
    });
    expect(s.capable.capable).toBe(true);
    expect(s.incapable.capable).toBe(false);
  });

  it("skips archived tasks entirely", () => {
    useApp.setState({
      tasks: [task("live"), task("gone", true)],
      tabs: { live: [term()], gone: [term()] },
    });
    const s = computeAgentStates();
    expect(Object.keys(s)).toEqual(["live"]);
  });
});
