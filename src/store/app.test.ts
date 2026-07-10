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
  workspaceSetTabs: vi.fn().mockResolvedValue(undefined),
  workspaceSetTabSessionId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
}));

import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { Tab, TerminalTab, Workspace, PersistedTab } from "@/lib/types";

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

function makeWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws1", project_id: "p1", name: "Feature Foo", branch: "feature/foo",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false,
    ...overrides,
  } as Workspace;
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
  vi.clearAllMocks();
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

  it("sets revealHeading on existing tab (file.md#heading link to an open file)", () => {
    const wsId = "ws1";
    const existing: Tab = { id: "e1", type: "edit", title: "guide.md", path: "docs/guide.md", preview: false } as any;
    useApp.setState({ tabs: { [wsId]: [existing] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, {
      type: "edit", path: "docs/guide.md", title: "guide.md",
      revealHeading: "usage",
    });

    const tab = useApp.getState().tabs[wsId].find(t => t.id === "e1") as any;
    expect(tab.revealHeading).toBe("usage");
    expect(useApp.getState().activeTab[wsId]).toBe("e1");
  });

  it("carries revealHeading onto a new preview tab", () => {
    const wsId = "ws1";
    useApp.setState({ tabs: { [wsId]: [] } });

    useApp.getState().openPreviewTab(wsId, {
      type: "edit", path: "docs/guide.md", title: "guide.md",
      revealHeading: "usage",
    });

    const tabs = useApp.getState().tabs[wsId];
    expect(tabs).toHaveLength(1);
    expect((tabs[0] as any).revealHeading).toBe("usage");
  });

  it("carries revealHeading when recycling the preview tab", () => {
    const wsId = "ws1";
    const previewTab: Tab = { id: "prev-1", type: "edit", title: "old.md", path: "docs/old.md", preview: true } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, {
      type: "edit", path: "docs/new.md", title: "new.md",
      revealHeading: "install",
    });

    const tab = useApp.getState().tabs[wsId][0] as any;
    expect(tab.path).toBe("docs/new.md");
    expect(tab.revealHeading).toBe("install");
  });

  it("does not set reveal fields on diff tabs", () => {
    const wsId = "ws1";
    useApp.setState({ tabs: { [wsId]: [] } });

    useApp.getState().openPreviewTab(wsId, {
      type: "diff", path: "docs/guide.md", title: "guide.md",
      revealHeading: "usage",
    });

    const tab = useApp.getState().tabs[wsId][0] as any;
    expect(tab.revealHeading).toBeUndefined();
  });

  it("clears a stale revealHeading when the preview tab is recycled without a fragment", () => {
    // A file.md#missing-heading link set revealHeading but it was never
    // consumed (no heading matched); reusing the preview tab for another
    // file must not let the old fragment scroll the new document.
    const wsId = "ws1";
    const previewTab: Tab = {
      id: "prev-1", type: "edit", title: "old.md", path: "docs/old.md",
      preview: true, revealHeading: "missing-heading",
    } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, { type: "edit", path: "docs/new.md", title: "new.md" });

    const tab = useApp.getState().tabs[wsId][0] as any;
    expect(tab.path).toBe("docs/new.md");
    expect(tab.revealHeading).toBeUndefined();
  });

  it("does not wipe a not-yet-consumed reveal when re-activating an existing tab without a new one", () => {
    // Regression: re-activating the SAME already-open file (no new reveal
    // target in this call) must never cancel a reveal that's already
    // pending and hasn't been consumed yet (e.g. a Find-in-Files jump whose
    // EditorPane effect hasn't run, or a heading reveal MarkdownPreview
    // hasn't fulfilled) — unlike recycling a preview tab to a DIFFERENT
    // file, the file identity here isn't changing, so there's no stale
    // previous-occupant risk to guard against.
    const wsId = "ws1";
    const existing: Tab = {
      id: "e1", type: "edit", title: "guide.md", path: "docs/guide.md",
      preview: false, revealAt: { line: 7 }, revealHeading: "usage",
    } as any;
    useApp.setState({ tabs: { [wsId]: [existing] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, { type: "edit", path: "docs/guide.md", title: "guide.md" });

    const tab = useApp.getState().tabs[wsId].find(t => t.id === "e1") as any;
    expect(tab.revealAt).toEqual({ line: 7 });
    expect(tab.revealHeading).toBe("usage");
  });

  it("still applies a genuinely new reveal target to an already-open tab", () => {
    const wsId = "ws1";
    const existing: Tab = {
      id: "e1", type: "edit", title: "guide.md", path: "docs/guide.md",
      preview: false, revealAt: { line: 7 },
    } as any;
    useApp.setState({ tabs: { [wsId]: [existing] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, {
      type: "edit", path: "docs/guide.md", title: "guide.md", revealAt: { line: 99 },
    });

    const tab = useApp.getState().tabs[wsId].find(t => t.id === "e1") as any;
    expect(tab.revealAt).toEqual({ line: 99 });
  });

  it("clears reveal fields when the preview tab is recycled into a diff tab", () => {
    const wsId = "ws1";
    const previewTab: Tab = {
      id: "prev-1", type: "edit", title: "old.md", path: "docs/old.md",
      preview: true, revealHeading: "usage",
    } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, { type: "diff", path: "docs/old.md", title: "old.md" });

    const tab = useApp.getState().tabs[wsId][0] as any;
    expect(tab.type).toBe("diff");
    expect(tab.revealHeading).toBeUndefined();
  });
});

// ── reorderTab (issue #6: drag-to-reorder) ────────────────────────────

describe("reorderTab", () => {
  function ids(wsId: string) {
    return useApp.getState().tabs[wsId].map(t => t.id);
  }
  function seed(wsId: string, n: number) {
    for (let i = 0; i < n; i++) addTab(wsId, makeTermTab({ id: `t${i}` }));
  }

  it("moves a tab to the end (toIndex === others.length)", () => {
    const wsId = "ws1";
    seed(wsId, 3); // t0 t1 t2
    useApp.getState().reorderTab(wsId, "t0", 2);
    expect(ids(wsId)).toEqual(["t1", "t2", "t0"]);
  });

  it("moves a later tab before an earlier one", () => {
    const wsId = "ws1";
    seed(wsId, 3); // t0 t1 t2
    useApp.getState().reorderTab(wsId, "t2", 0);
    expect(ids(wsId)).toEqual(["t2", "t0", "t1"]);
  });

  it("moving a tab to its own index is a no-op", () => {
    const wsId = "ws1";
    seed(wsId, 3); // t0 t1 t2
    const before = ids(wsId);
    useApp.getState().reorderTab(wsId, "t1", 1);
    expect(ids(wsId)).toEqual(before);
  });

  it("ignores an unknown tab id", () => {
    const wsId = "ws1";
    seed(wsId, 2);
    const before = ids(wsId);
    useApp.getState().reorderTab(wsId, "nope", 0);
    expect(ids(wsId)).toEqual(before);
  });
});

// ── persist + restore agent tabs (issue #23) ──────────────────────────

describe("ensureDefaultTab — seed / restore / migrate", () => {
  it("seeds a single default agent tab when nothing is persisted", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].cli).toBe("claude");
    expect(tabs[0].is_default).toBe(true);
    // The seed is persisted so a later quit-restore brings it back.
    expect(ipc.workspaceSetTabs).toHaveBeenCalledWith("ws1", expect.arrayContaining([
      expect.objectContaining({ id: tabs[0].id, cli: "claude", is_default: true }),
    ]));
  });

  it("restores the full persisted agent-tab set, in order, with sessions", () => {
    const persisted: PersistedTab[] = [
      { id: "t1", cli: "claude", is_default: true, session_id: "u1" },
      { id: "t2", cli: "codex", custom_title: true, title: "Reviewer" },
    ];
    useApp.setState({ workspaces: [makeWs({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs.map(t => t.id)).toEqual(["t1", "t2"]);
    expect(tabs[0].sessionId).toBe("u1");
    expect(tabs[0].is_default).toBe(true);
    expect(tabs[1].cli).toBe("codex");
    expect(tabs[1].customTitle).toBe(true);
    expect(tabs[1].title).toBe("Reviewer");
    // Active tab is the default one.
    expect(useApp.getState().activeTab["ws1"]).toBe("t1");
    // Restore reads existing on-disk state — it must NOT re-persist.
    expect(ipc.workspaceSetTabs).not.toHaveBeenCalled();
  });

  it("re-derives the title for tabs the user never renamed", () => {
    const persisted: PersistedTab[] = [
      { id: "t1", cli: "gemini", is_default: true, custom_title: false, title: "stale" },
    ];
    useApp.setState({ workspaces: [makeWs({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "gemini");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    // agentDisplayName is mocked to echo the cli id, so non-renamed tabs
    // pick up the fresh display name rather than the stale persisted one.
    expect(tabs[0].title).toBe("gemini");
    expect(tabs[0].customTitle).toBe(false);
  });

  it("migrates a legacy per-cli session uuid onto the default tab", () => {
    useApp.setState({ workspaces: [makeWs({ agent_session_ids: { claude: "legacy-uuid" } })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs[0].sessionId).toBe("legacy-uuid");
    // The migrated uuid is carried into the persisted payload (the Rust
    // merge honors a payload session_id on a tab's first write).
    expect(ipc.workspaceSetTabs).toHaveBeenCalledWith("ws1", [
      expect.objectContaining({ id: tabs[0].id, session_id: "legacy-uuid" }),
    ]);
  });

  it("repairs corrupted persisted_tabs with multiple is_default entries", () => {
    // Wreckage from older builds: 4 phantom "main" tabs all is_default.
    const corrupt: PersistedTab[] = [
      { id: "t1", cli: "claude", is_default: true, session_id: "s1" },
      { id: "t2", cli: "claude", is_default: true, session_id: "s2" },
      { id: "t3", cli: "claude", is_default: true, session_id: "s3" },
      { id: "t4", cli: "claude", is_default: true, session_id: "s4" },
    ];
    useApp.setState({ workspaces: [makeWs({ persisted_tabs: corrupt })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    // Only the first default survives → ONE agent restored, not four.
    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("t1");
    expect(tabs[0].sessionId).toBe("s1");
    // And the repaired shape is written back to disk.
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.map(t => t.id)).toEqual(["t1"]);
  });

  it("keeps real secondary (non-default) agents during repair", () => {
    const mixed: PersistedTab[] = [
      { id: "main", cli: "claude", is_default: true, session_id: "m" },
      { id: "extra-main", cli: "claude", is_default: true, session_id: "x" }, // corruption
      { id: "reviewer", cli: "codex", is_default: false },                    // legit secondary
    ];
    useApp.setState({ workspaces: [makeWs({ persisted_tabs: mixed })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs.map(t => t.id)).toEqual(["main", "reviewer"]);
  });

  it("is a no-op when the workspace already has live tabs", () => {
    useApp.setState({ workspaces: [makeWs()] });
    const tab = makeTermTab({ id: "live" });
    addTab("ws1", tab);
    vi.clearAllMocks();

    useApp.getState().ensureDefaultTab("ws1", "claude");

    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["live"]);
    expect(ipc.workspaceSetTabs).not.toHaveBeenCalled();
  });
});

describe("durable persistence on tab mutations (issue #23)", () => {
  function lastSetTabsPayload(): PersistedTab[] {
    const calls = vi.mocked(ipc.workspaceSetTabs).mock.calls;
    return calls[calls.length - 1][1] as PersistedTab[];
  }

  it("addTab persists the durable set and excludes shell tabs", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));
    expect(lastSetTabsPayload().map(t => t.id)).toEqual(["a", "b"]);

    // A scratch shell tab is ephemeral — never persisted.
    useApp.getState().addTab("ws1", makeTermTab({ id: "sh", cli: "shell" }));
    expect(lastSetTabsPayload().map(t => t.id)).toEqual(["a", "b"]);
    // And the in-memory workspace mirror agrees.
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.map(t => t.id)).toEqual(["a", "b"]);
  });

  it("closeTab on the MAIN tab keeps it durable (X = end for now → resumes on reopen)", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "main", cli: "claude", is_default: true }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));
    // Give main a minted session, then close it.
    useApp.getState().setTabSessionId("ws1", "main", "sess-main");
    useApp.getState().closeTab("ws1", "main");

    // main is gone from the live tabs...
    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["b"]);
    // ...but still in the durable set WITH its session, so reopening resumes it.
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    const persistedMain = ws.persisted_tabs!.find(t => t.id === "main");
    expect(persistedMain).toBeTruthy();
    expect(persistedMain!.session_id).toBe("sess-main");
  });

  it("closeTab on a SECONDARY tab forgets it (X = get rid of it for good)", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "main", cli: "claude", is_default: true }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "extra", cli: "claude" }));
    useApp.getState().setTabSessionId("ws1", "extra", "sess-extra");

    useApp.getState().closeTab("ws1", "extra");

    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["main"]);
    // Dropped from the durable set — it will NOT be restored on reopen.
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.map(t => t.id)).toEqual(["main"]);
  });

  it("closing the LAST (main) tab keeps it durable so the workspace resumes on reopen", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "only", cli: "claude", is_default: true }));
    useApp.getState().setTabSessionId("ws1", "only", "sess-only");

    useApp.getState().closeTab("ws1", "only");

    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.map(t => t.id)).toEqual(["only"]);
    expect(ws.persisted_tabs![0].session_id).toBe("sess-only");
  });

  it("forgetTab drops the agent from the durable set (explicit close & forget)", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));

    useApp.getState().forgetTab("ws1", "b");

    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["a"]);
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.map(t => t.id)).toEqual(["a"]);
  });

  it("renameTab persists the new custom title", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));

    useApp.getState().renameTab("ws1", "a", "My Tab");

    const entry = lastSetTabsPayload().find(t => t.id === "a")!;
    expect(entry.custom_title).toBe(true);
    expect(entry.title).toBe("My Tab");
  });

  it("reorderTab persists the new order", () => {
    useApp.setState({ workspaces: [makeWs()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));

    useApp.getState().reorderTab("ws1", "a", 1);

    expect(lastSetTabsPayload().map(t => t.id)).toEqual(["b", "a"]);
  });
});

describe("setTabSessionId", () => {
  it("updates the tab, the persisted entry, and the disk", () => {
    useApp.setState({ workspaces: [makeWs({ persisted_tabs: [{ id: "a", cli: "claude", is_default: true }] })] });
    addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));

    useApp.getState().setTabSessionId("ws1", "a", "minted-uuid");

    const tab = useApp.getState().tabs["ws1"].find(t => t.id === "a") as TerminalTab;
    expect(tab.sessionId).toBe("minted-uuid");
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.find(t => t.id === "a")!.session_id).toBe("minted-uuid");
    expect(ipc.workspaceSetTabSessionId).toHaveBeenCalledWith("ws1", "a", "minted-uuid");
  });

  it("clears the session uuid when given an empty string", () => {
    useApp.setState({ workspaces: [makeWs({ persisted_tabs: [{ id: "a", cli: "claude", session_id: "old" }] })] });
    addTab("ws1", makeTermTab({ id: "a", cli: "claude", sessionId: "old" }));

    useApp.getState().setTabSessionId("ws1", "a", "");

    const tab = useApp.getState().tabs["ws1"].find(t => t.id === "a") as TerminalTab;
    expect(tab.sessionId).toBeUndefined();
    const ws = useApp.getState().workspaces.find(w => w.id === "ws1")!;
    expect(ws.persisted_tabs!.find(t => t.id === "a")!.session_id).toBeNull();
    expect(ipc.workspaceSetTabSessionId).toHaveBeenCalledWith("ws1", "a", "");
  });
});
