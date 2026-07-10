// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
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
import type { Tab, TerminalTab, Task, PersistedTab } from "@/lib/types";

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

function addTab(taskId: string, tab: Tab) {
  useApp.setState(s => ({
    tabs: { ...s.tabs, [taskId]: [...(s.tabs[taskId] ?? []), tab] },
    activeTab: { ...s.activeTab, [taskId]: tab.id },
  }));
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "ws1", project_id: "p1", name: "Feature Foo", branch: "feature/foo",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false,
    ...overrides,
  } as Task;
}

beforeEach(() => {
  // Reset store to clean state before each test.
  useApp.setState({
    tabs: {},
    activeTab: {},
    activeTaskId: null,
    mountedTasks: new Set(),
    tasks: [],
    projects: [],
    agents: [],
  });
  vi.clearAllMocks();
});

// ── setWorkState ──────────────────────────────────────────────────────

describe("setWorkState", () => {
  it("transitions idle → working", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    const result = useApp.getState().tabs[taskId].find(t => t.id === tab.id) as TerminalTab;
    expect(result.workState).toBe("working");
  });

  it("transitions working → done", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "done");

    const result = useApp.getState().tabs[taskId].find(t => t.id === tab.id) as TerminalTab;
    expect(result.workState).toBe("done");
  });

  it("sticky done: agent cannot flip done → working", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "done" });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    const result = useApp.getState().tabs[taskId].find(t => t.id === tab.id) as TerminalTab;
    // done is sticky — agent "working" signal is ignored
    expect(result.workState).toBe("done");
  });

  it("idempotent: same state write causes no update", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "idle" });
    addTab(taskId, tab);

    const before = useApp.getState().tabs[taskId];
    useApp.getState().setWorkState(taskId, tab.id, "idle");
    const after = useApp.getState().tabs[taskId];

    // Same reference = no re-render triggered
    expect(after).toBe(before);
  });

  it("drops done → idle on the focused tab", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(taskId, tab);
    // Mark this task+tab as active (the user is looking at it)
    useApp.setState({ activeTaskId: taskId, activeTab: { [taskId]: tab.id } });

    useApp.getState().setWorkState(taskId, tab.id, "done");

    const result = useApp.getState().tabs[taskId].find(t => t.id === tab.id) as TerminalTab;
    // "done" on the focused tab is silently downgraded to "idle"
    expect(result.workState).toBe("idle");
  });

  it("no-op on non-terminal tab", () => {
    const taskId = "ws1";
    const editTab: Tab = { id: "edit-1", type: "edit", title: "foo.ts", path: "/x/foo.ts" } as any;
    addTab(taskId, editTab);

    const before = useApp.getState().tabs[taskId];
    useApp.getState().setWorkState(taskId, "edit-1", "working");
    expect(useApp.getState().tabs[taskId]).toBe(before);
  });

  it("clears workProgress when leaving working state", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working", workProgress: 60, workProgressKind: 1 });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "done");

    const result = useApp.getState().tabs[taskId].find(t => t.id === tab.id) as TerminalTab;
    // workProgress cleared when not "working"
    expect(result.workProgress).toBeNull();
    expect(result.workProgressKind).toBeNull();
  });
});

// ── closeTab ──────────────────────────────────────────────────────────

describe("closeTab", () => {
  it("removes the tab from the list", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    useApp.getState().closeTab(taskId, tab.id);

    expect(useApp.getState().tabs[taskId]).toHaveLength(0);
  });

  it("adjusts active tab to the previous sibling", () => {
    const taskId = "ws1";
    const t1 = makeTermTab({ id: "t1" });
    const t2 = makeTermTab({ id: "t2" });
    addTab(taskId, t1);
    addTab(taskId, t2);
    useApp.setState(s => ({ activeTab: { ...s.activeTab, [taskId]: "t2" } }));

    useApp.getState().closeTab(taskId, "t2");

    expect(useApp.getState().activeTab[taskId]).toBe("t1");
  });

  it("adjusts active tab to next sibling when first is closed", () => {
    const taskId = "ws1";
    const t1 = makeTermTab({ id: "t1" });
    const t2 = makeTermTab({ id: "t2" });
    addTab(taskId, t1);
    addTab(taskId, t2);
    useApp.setState(s => ({ activeTab: { ...s.activeTab, [taskId]: "t1" } }));

    useApp.getState().closeTab(taskId, "t1");

    expect(useApp.getState().activeTab[taskId]).toBe("t2");
  });

  it("no-op when tab id does not exist", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    const before = useApp.getState().tabs[taskId];
    useApp.getState().closeTab(taskId, "ghost-id");
    expect(useApp.getState().tabs[taskId]).toBe(before);
  });
});

// ── openPreviewTab ────────────────────────────────────────────────────

describe("openPreviewTab", () => {
  it("creates a new preview tab when none exists", () => {
    const taskId = "ws1";
    useApp.setState({ tabs: { [taskId]: [] } });

    useApp.getState().openPreviewTab(taskId, { type: "edit", path: "/x/foo.ts", title: "foo.ts" });

    const tabs = useApp.getState().tabs[taskId];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].preview).toBe(true);
    expect((tabs[0] as any).path).toBe("/x/foo.ts");
  });

  it("reuses an existing preview tab (replaces content)", () => {
    const taskId = "ws1";
    const previewTab: Tab = { id: "prev-1", type: "edit", title: "old.ts", path: "/x/old.ts", preview: true } as any;
    useApp.setState({ tabs: { [taskId]: [previewTab] }, activeTab: { [taskId]: "prev-1" } });

    useApp.getState().openPreviewTab(taskId, { type: "edit", path: "/x/new.ts", title: "new.ts" });

    const tabs = useApp.getState().tabs[taskId];
    expect(tabs).toHaveLength(1);
    expect((tabs[0] as any).path).toBe("/x/new.ts");
    expect(tabs[0].preview).toBe(true);
  });

  it("activates existing tab for the same path without creating a duplicate", () => {
    const taskId = "ws1";
    const existing: Tab = { id: "e1", type: "edit", title: "foo.ts", path: "/x/foo.ts", preview: false } as any;
    useApp.setState({ tabs: { [taskId]: [existing] }, activeTab: { [taskId]: "e1" } });

    useApp.getState().openPreviewTab(taskId, { type: "edit", path: "/x/foo.ts", title: "foo.ts" });

    expect(useApp.getState().tabs[taskId]).toHaveLength(1);
    expect(useApp.getState().activeTab[taskId]).toBe("e1");
  });

  it("sets revealAt on existing tab when requested", () => {
    const taskId = "ws1";
    const existing: Tab = { id: "e1", type: "edit", title: "foo.ts", path: "/x/foo.ts", preview: false } as any;
    useApp.setState({ tabs: { [taskId]: [existing] }, activeTab: { [taskId]: "e1" } });

    useApp.getState().openPreviewTab(taskId, {
      type: "edit", path: "/x/foo.ts", title: "foo.ts",
      revealAt: { line: 42, col: 5 },
    });

    const tab = useApp.getState().tabs[taskId].find(t => t.id === "e1") as any;
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

  it("clears a per-document remoteImagesUnblocked override when the preview tab is recycled (issue #69)", () => {
    // Regression: the previous file's "Show images" override must not
    // silently carry over to a DIFFERENT file recycled into the same
    // preview tab slot — that would unblock remote images in a file the
    // user never actually approved.
    const wsId = "ws1";
    const previewTab: Tab = {
      id: "prev-1", type: "edit", title: "old.md", path: "docs/old.md",
      preview: true, remoteImagesUnblocked: true,
    } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, { type: "edit", path: "docs/new.md", title: "new.md" });

    const tab = useApp.getState().tabs[wsId][0] as any;
    expect(tab.path).toBe("docs/new.md");
    expect(tab.remoteImagesUnblocked).toBeUndefined();
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
  function ids(taskId: string) {
    return useApp.getState().tabs[taskId].map(t => t.id);
  }
  function seed(taskId: string, n: number) {
    for (let i = 0; i < n; i++) addTab(taskId, makeTermTab({ id: `t${i}` }));
  }

  it("moves a tab to the end (toIndex === others.length)", () => {
    const taskId = "ws1";
    seed(taskId, 3); // t0 t1 t2
    useApp.getState().reorderTab(taskId, "t0", 2);
    expect(ids(taskId)).toEqual(["t1", "t2", "t0"]);
  });

  it("moves a later tab before an earlier one", () => {
    const taskId = "ws1";
    seed(taskId, 3); // t0 t1 t2
    useApp.getState().reorderTab(taskId, "t2", 0);
    expect(ids(taskId)).toEqual(["t2", "t0", "t1"]);
  });

  it("moving a tab to its own index is a no-op", () => {
    const taskId = "ws1";
    seed(taskId, 3); // t0 t1 t2
    const before = ids(taskId);
    useApp.getState().reorderTab(taskId, "t1", 1);
    expect(ids(taskId)).toEqual(before);
  });

  it("ignores an unknown tab id", () => {
    const taskId = "ws1";
    seed(taskId, 2);
    const before = ids(taskId);
    useApp.getState().reorderTab(taskId, "nope", 0);
    expect(ids(taskId)).toEqual(before);
  });
});

// ── persist + restore agent tabs (issue #23) ──────────────────────────

describe("ensureDefaultTab — seed / restore / migrate", () => {
  it("seeds a single default agent tab when nothing is persisted", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].cli).toBe("claude");
    expect(tabs[0].is_default).toBe(true);
    // The seed is persisted so a later quit-restore brings it back.
    expect(ipc.taskSetTabs).toHaveBeenCalledWith("ws1", expect.arrayContaining([
      expect.objectContaining({ id: tabs[0].id, cli: "claude", is_default: true }),
    ]));
  });

  it("restores the full persisted agent-tab set, in order, with sessions", () => {
    const persisted: PersistedTab[] = [
      { id: "t1", cli: "claude", is_default: true, session_id: "u1" },
      { id: "t2", cli: "codex", custom_title: true, title: "Reviewer" },
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
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
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
  });

  it("re-derives the title for tabs the user never renamed", () => {
    const persisted: PersistedTab[] = [
      { id: "t1", cli: "gemini", is_default: true, custom_title: false, title: "stale" },
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "gemini");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    // agentDisplayName is mocked to echo the cli id, so non-renamed tabs
    // pick up the fresh display name rather than the stale persisted one.
    expect(tabs[0].title).toBe("gemini");
    expect(tabs[0].customTitle).toBe(false);
  });

  it("migrates a legacy per-cli session uuid onto the default tab", () => {
    useApp.setState({ tasks: [makeTask({ agent_session_ids: { claude: "legacy-uuid" } })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs[0].sessionId).toBe("legacy-uuid");
    // The migrated uuid is carried into the persisted payload (the Rust
    // merge honors a payload session_id on a tab's first write).
    expect(ipc.taskSetTabs).toHaveBeenCalledWith("ws1", [
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
    useApp.setState({ tasks: [makeTask({ persisted_tabs: corrupt })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    // Only the first default survives → ONE agent restored, not four.
    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("t1");
    expect(tabs[0].sessionId).toBe("s1");
    // And the repaired shape is written back to disk.
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["t1"]);
  });

  it("keeps real secondary (non-default) agents during repair", () => {
    const mixed: PersistedTab[] = [
      { id: "main", cli: "claude", is_default: true, session_id: "m" },
      { id: "extra-main", cli: "claude", is_default: true, session_id: "x" }, // corruption
      { id: "reviewer", cli: "codex", is_default: false },                    // legit secondary
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: mixed })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs.map(t => t.id)).toEqual(["main", "reviewer"]);
  });

  it("is a no-op when the task already has live tabs", () => {
    useApp.setState({ tasks: [makeTask()] });
    const tab = makeTermTab({ id: "live" });
    addTab("ws1", tab);
    vi.clearAllMocks();

    useApp.getState().ensureDefaultTab("ws1", "claude");

    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["live"]);
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
  });
});

describe("durable persistence on tab mutations (issue #23)", () => {
  function lastSetTabsPayload(): PersistedTab[] {
    const calls = vi.mocked(ipc.taskSetTabs).mock.calls;
    return calls[calls.length - 1][1] as PersistedTab[];
  }

  it("addTab persists the durable set and excludes shell tabs", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));
    expect(lastSetTabsPayload().map(t => t.id)).toEqual(["a", "b"]);

    // A scratch shell tab is ephemeral — never persisted.
    useApp.getState().addTab("ws1", makeTermTab({ id: "sh", cli: "shell" }));
    expect(lastSetTabsPayload().map(t => t.id)).toEqual(["a", "b"]);
    // And the in-memory task mirror agrees.
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["a", "b"]);
  });

  it("closeTab on the MAIN tab keeps it durable (X = end for now → resumes on reopen)", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "main", cli: "claude", is_default: true }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));
    // Give main a minted session, then close it.
    useApp.getState().setTabSessionId("ws1", "main", "sess-main");
    useApp.getState().closeTab("ws1", "main");

    // main is gone from the live tabs...
    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["b"]);
    // ...but still in the durable set WITH its session, so reopening resumes it.
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    const persistedMain = task.persisted_tabs!.find(t => t.id === "main");
    expect(persistedMain).toBeTruthy();
    expect(persistedMain!.session_id).toBe("sess-main");
  });

  it("closeTab on a SECONDARY tab forgets it (X = get rid of it for good)", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "main", cli: "claude", is_default: true }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "extra", cli: "claude" }));
    useApp.getState().setTabSessionId("ws1", "extra", "sess-extra");

    useApp.getState().closeTab("ws1", "extra");

    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["main"]);
    // Dropped from the durable set — it will NOT be restored on reopen.
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["main"]);
  });

  it("closing the LAST (main) tab keeps it durable so the task resumes on reopen", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "only", cli: "claude", is_default: true }));
    useApp.getState().setTabSessionId("ws1", "only", "sess-only");

    useApp.getState().closeTab("ws1", "only");

    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["only"]);
    expect(task.persisted_tabs![0].session_id).toBe("sess-only");
  });

  it("forgetTab drops the agent from the durable set (explicit close & forget)", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));

    useApp.getState().forgetTab("ws1", "b");

    expect(useApp.getState().tabs["ws1"].map(t => t.id)).toEqual(["a"]);
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["a"]);
  });

  it("renameTab persists the new custom title", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));

    useApp.getState().renameTab("ws1", "a", "My Tab");

    const entry = lastSetTabsPayload().find(t => t.id === "a")!;
    expect(entry.custom_title).toBe(true);
    expect(entry.title).toBe("My Tab");
  });

  it("reorderTab persists the new order", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));

    useApp.getState().reorderTab("ws1", "a", 1);

    expect(lastSetTabsPayload().map(t => t.id)).toEqual(["b", "a"]);
  });
});

describe("setTabSessionId", () => {
  it("updates the tab, the persisted entry, and the disk", () => {
    useApp.setState({ tasks: [makeTask({ persisted_tabs: [{ id: "a", cli: "claude", is_default: true }] })] });
    addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));

    useApp.getState().setTabSessionId("ws1", "a", "minted-uuid");

    const tab = useApp.getState().tabs["ws1"].find(t => t.id === "a") as TerminalTab;
    expect(tab.sessionId).toBe("minted-uuid");
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.find(t => t.id === "a")!.session_id).toBe("minted-uuid");
    expect(ipc.taskSetTabSessionId).toHaveBeenCalledWith("ws1", "a", "minted-uuid");
  });

  it("clears the session uuid when given an empty string", () => {
    useApp.setState({ tasks: [makeTask({ persisted_tabs: [{ id: "a", cli: "claude", session_id: "old" }] })] });
    addTab("ws1", makeTermTab({ id: "a", cli: "claude", sessionId: "old" }));

    useApp.getState().setTabSessionId("ws1", "a", "");

    const tab = useApp.getState().tabs["ws1"].find(t => t.id === "a") as TerminalTab;
    expect(tab.sessionId).toBeUndefined();
    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.find(t => t.id === "a")!.session_id).toBeNull();
    expect(ipc.taskSetTabSessionId).toHaveBeenCalledWith("ws1", "a", "");
  });
});

describe("openSettings / clearSettingsHighlight", () => {
  beforeEach(() => { useApp.setState({ view: { page: "dashboard" } }); });

  it("opens to the given tab with no highlight by default", () => {
    useApp.getState().openSettings("agents");
    expect(useApp.getState().view).toMatchObject({ settingsOpen: true, settingsTab: "agents", settingsHighlight: undefined });
  });

  it("sets a highlight target for the section to consume (issue #69's Settings link)", () => {
    useApp.getState().openSettings("general", undefined, "load-remote-images");
    expect(useApp.getState().view.settingsHighlight).toBe("load-remote-images");
  });

  it("a later openSettings call without a highlight clears a previous one", () => {
    // Regression: a stale highlight from an earlier "Settings" link must
    // not resurface (re-flashing the wrong row) just because Settings is
    // reopened normally afterwards, e.g. from the sidebar gear icon.
    useApp.getState().openSettings("general", undefined, "load-remote-images");
    useApp.getState().openSettings("general");
    expect(useApp.getState().view.settingsHighlight).toBeUndefined();
  });

  it("clearSettingsHighlight removes the highlight without closing settings or changing tab", () => {
    useApp.getState().openSettings("general", undefined, "load-remote-images");
    useApp.getState().clearSettingsHighlight();
    expect(useApp.getState().view).toMatchObject({ settingsOpen: true, settingsTab: "general", settingsHighlight: undefined });
  });
});

// ── project-group UI state (collapse + color maps) ────────────────────

describe("group UI state", () => {
  const projectWith = (id: string, group?: string) =>
    ({ id, name: id, group } as import("@/lib/types").Project);

  beforeEach(() => {
    useApp.setState({ collapsedGroups: {}, groupColors: {} });
    localStorage.clear();
  });

  it("setGroupCollapsed sets state and persists", () => {
    useApp.getState().setGroupCollapsed("BACKEND", true);
    expect(useApp.getState().collapsedGroups).toEqual({ BACKEND: true });
    expect(JSON.parse(localStorage.getItem("collapsedGroups")!)).toEqual({ BACKEND: true });
  });

  it("setGroupColor sets a palette key; null clears it", () => {
    useApp.getState().setGroupColor("BACKEND", "red");
    expect(useApp.getState().groupColors).toEqual({ BACKEND: "red" });
    useApp.getState().setGroupColor("BACKEND", null);
    expect(useApp.getState().groupColors).toEqual({});
    expect(JSON.parse(localStorage.getItem("groupColors")!)).toEqual({});
  });

  it("renameGroupState carries collapse + color to a fresh name", () => {
    useApp.setState({ collapsedGroups: { OLD: true }, groupColors: { OLD: "teal" } });
    useApp.getState().renameGroupState("OLD", "NEW");
    expect(useApp.getState().collapsedGroups).toEqual({ NEW: true });
    expect(useApp.getState().groupColors).toEqual({ NEW: "teal" });
  });

  it("renameGroupState onto an existing group merges, destination wins", () => {
    useApp.setState({
      collapsedGroups: { SRC: true, DST: false },
      groupColors: { SRC: "red", DST: "blue" },
    });
    useApp.getState().renameGroupState("SRC", "DST");
    expect(useApp.getState().collapsedGroups).toEqual({ DST: false });
    expect(useApp.getState().groupColors).toEqual({ DST: "blue" });
  });

  it("renameGroupState is a no-op for an unknown source", () => {
    useApp.setState({ collapsedGroups: { A: true }, groupColors: {} });
    useApp.getState().renameGroupState("MISSING", "B");
    expect(useApp.getState().collapsedGroups).toEqual({ A: true });
  });

  it("setAllGroupsCollapsed covers live groups and drops stale names", () => {
    useApp.setState({
      projects: [projectWith("p1", "one"), projectWith("p2", " TWO "), projectWith("p3")],
      collapsedGroups: { STALE: true },
    });
    useApp.getState().setAllGroupsCollapsed(true);
    // Keys are normalized (trim + uppercase); STALE is gone.
    expect(useApp.getState().collapsedGroups).toEqual({ ONE: true, TWO: true });
    useApp.getState().setAllGroupsCollapsed(false);
    expect(useApp.getState().collapsedGroups).toEqual({ ONE: false, TWO: false });
  });

  it("loadAll prunes collapse/color entries for groups that no longer exist", async () => {
    (ipc.projectsList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      projectWith("p1", "ALIVE"),
    ]);
    useApp.setState({
      collapsedGroups: { ALIVE: true, DEAD: true },
      groupColors: { DEAD: "pink" },
    });
    await useApp.getState().loadAll();
    expect(useApp.getState().collapsedGroups).toEqual({ ALIVE: true });
    expect(useApp.getState().groupColors).toEqual({});
    expect(JSON.parse(localStorage.getItem("collapsedGroups")!)).toEqual({ ALIVE: true });
    expect(JSON.parse(localStorage.getItem("groupColors")!)).toEqual({});
  });
});
