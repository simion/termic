// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  workspacesList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
}));

import { useApp } from "@/store/app";
import type { Tab, TerminalTab } from "@/lib/types";

// ── helpers ───────────────────────────────────────────────────────────

function makeTermTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: crypto.randomUUID(),
    type: "terminal",
    title: "claude",
    ptyId: "pty-1",
    cli: "claude",
    workState: "idle",
    workProgress: null,
    workProgressKind: null,
    workClearedAt: undefined,
    preview: false,
    ...overrides,
  } as TerminalTab;
}

function addTab(wsId: string, tab: Tab) {
  useApp.setState(s => ({
    tabs: { ...s.tabs, [wsId]: [...(s.tabs[wsId] ?? []), tab] },
    activeTab: { ...s.activeTab, [wsId]: tab.id },
  }));
}

beforeEach(() => {
  // Reset store to clean state before each test.
  useApp.setState({
    tabs: {},
    activeTab: {},
    activeWorkspaceId: null,
    mountedWorkspaces: new Set(),
    workspaces: [],
    projects: [],
    agents: [],
  });
});

// ── setWorkState ──────────────────────────────────────────────────────

describe("setWorkState", () => {
  it("transitions idle → working", () => {
    const wsId = "ws1";
    const tab = makeTermTab();
    addTab(wsId, tab);

    useApp.getState().setWorkState(wsId, tab.id, "working");

    const result = useApp.getState().tabs[wsId].find(t => t.id === tab.id) as TerminalTab;
    expect(result.workState).toBe("working");
  });

  it("transitions working → done", () => {
    const wsId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(wsId, tab);

    useApp.getState().setWorkState(wsId, tab.id, "done");

    const result = useApp.getState().tabs[wsId].find(t => t.id === tab.id) as TerminalTab;
    expect(result.workState).toBe("done");
  });

  it("sticky done: agent cannot flip done → working", () => {
    const wsId = "ws1";
    const tab = makeTermTab({ workState: "done" });
    addTab(wsId, tab);

    useApp.getState().setWorkState(wsId, tab.id, "working");

    const result = useApp.getState().tabs[wsId].find(t => t.id === tab.id) as TerminalTab;
    // done is sticky — agent "working" signal is ignored
    expect(result.workState).toBe("done");
  });

  it("idempotent: same state write causes no update", () => {
    const wsId = "ws1";
    const tab = makeTermTab({ workState: "idle" });
    addTab(wsId, tab);

    const before = useApp.getState().tabs[wsId];
    useApp.getState().setWorkState(wsId, tab.id, "idle");
    const after = useApp.getState().tabs[wsId];

    // Same reference = no re-render triggered
    expect(after).toBe(before);
  });

  it("drops done → idle on the focused tab", () => {
    const wsId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(wsId, tab);
    // Mark this workspace+tab as active (the user is looking at it)
    useApp.setState({ activeWorkspaceId: wsId, activeTab: { [wsId]: tab.id } });

    useApp.getState().setWorkState(wsId, tab.id, "done");

    const result = useApp.getState().tabs[wsId].find(t => t.id === tab.id) as TerminalTab;
    // "done" on the focused tab is silently downgraded to "idle"
    expect(result.workState).toBe("idle");
  });

  it("no-op on non-terminal tab", () => {
    const wsId = "ws1";
    const editTab: Tab = { id: "edit-1", type: "edit", title: "foo.ts", path: "/x/foo.ts" } as any;
    addTab(wsId, editTab);

    const before = useApp.getState().tabs[wsId];
    useApp.getState().setWorkState(wsId, "edit-1", "working");
    expect(useApp.getState().tabs[wsId]).toBe(before);
  });

  it("clears workProgress when leaving working state", () => {
    const wsId = "ws1";
    const tab = makeTermTab({ workState: "working", workProgress: 60, workProgressKind: 1 });
    addTab(wsId, tab);

    useApp.getState().setWorkState(wsId, tab.id, "done");

    const result = useApp.getState().tabs[wsId].find(t => t.id === tab.id) as TerminalTab;
    // workProgress cleared when not "working"
    expect(result.workProgress).toBeNull();
    expect(result.workProgressKind).toBeNull();
  });
});

// ── closeTab ──────────────────────────────────────────────────────────

describe("closeTab", () => {
  it("removes the tab from the list", () => {
    const wsId = "ws1";
    const tab = makeTermTab();
    addTab(wsId, tab);

    useApp.getState().closeTab(wsId, tab.id);

    expect(useApp.getState().tabs[wsId]).toHaveLength(0);
  });

  it("adjusts active tab to the previous sibling", () => {
    const wsId = "ws1";
    const t1 = makeTermTab({ id: "t1" });
    const t2 = makeTermTab({ id: "t2" });
    addTab(wsId, t1);
    addTab(wsId, t2);
    useApp.setState(s => ({ activeTab: { ...s.activeTab, [wsId]: "t2" } }));

    useApp.getState().closeTab(wsId, "t2");

    expect(useApp.getState().activeTab[wsId]).toBe("t1");
  });

  it("adjusts active tab to next sibling when first is closed", () => {
    const wsId = "ws1";
    const t1 = makeTermTab({ id: "t1" });
    const t2 = makeTermTab({ id: "t2" });
    addTab(wsId, t1);
    addTab(wsId, t2);
    useApp.setState(s => ({ activeTab: { ...s.activeTab, [wsId]: "t1" } }));

    useApp.getState().closeTab(wsId, "t1");

    expect(useApp.getState().activeTab[wsId]).toBe("t2");
  });

  it("no-op when tab id does not exist", () => {
    const wsId = "ws1";
    const tab = makeTermTab();
    addTab(wsId, tab);

    const before = useApp.getState().tabs[wsId];
    useApp.getState().closeTab(wsId, "ghost-id");
    expect(useApp.getState().tabs[wsId]).toBe(before);
  });
});

// ── openPreviewTab ────────────────────────────────────────────────────

describe("openPreviewTab", () => {
  it("creates a new preview tab when none exists", () => {
    const wsId = "ws1";
    useApp.setState({ tabs: { [wsId]: [] } });

    useApp.getState().openPreviewTab(wsId, { type: "edit", path: "/x/foo.ts", title: "foo.ts" });

    const tabs = useApp.getState().tabs[wsId];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].preview).toBe(true);
    expect((tabs[0] as any).path).toBe("/x/foo.ts");
  });

  it("reuses an existing preview tab (replaces content)", () => {
    const wsId = "ws1";
    const previewTab: Tab = { id: "prev-1", type: "edit", title: "old.ts", path: "/x/old.ts", preview: true } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, { type: "edit", path: "/x/new.ts", title: "new.ts" });

    const tabs = useApp.getState().tabs[wsId];
    expect(tabs).toHaveLength(1);
    expect((tabs[0] as any).path).toBe("/x/new.ts");
    expect(tabs[0].preview).toBe(true);
  });

  it("activates existing tab for the same path without creating a duplicate", () => {
    const wsId = "ws1";
    const existing: Tab = { id: "e1", type: "edit", title: "foo.ts", path: "/x/foo.ts", preview: false } as any;
    useApp.setState({ tabs: { [wsId]: [existing] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, { type: "edit", path: "/x/foo.ts", title: "foo.ts" });

    expect(useApp.getState().tabs[wsId]).toHaveLength(1);
    expect(useApp.getState().activeTab[wsId]).toBe("e1");
  });

  it("sets revealAt on existing tab when requested", () => {
    const wsId = "ws1";
    const existing: Tab = { id: "e1", type: "edit", title: "foo.ts", path: "/x/foo.ts", preview: false } as any;
    useApp.setState({ tabs: { [wsId]: [existing] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, {
      type: "edit", path: "/x/foo.ts", title: "foo.ts",
      revealAt: { line: 42, col: 5 },
    });

    const tab = useApp.getState().tabs[wsId].find(t => t.id === "e1") as any;
    expect(tab.revealAt).toEqual({ line: 42, col: 5 });
  });
});
