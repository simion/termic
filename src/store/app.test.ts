// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks must be declared before the module under test is imported.
vi.mock("@/lib/ipc", () => ({
  // Every task activation stamps `last_opened_at` through these; a mock
  // missing them throws on property access, not on call.
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
  // Resolves with the resulting `parked_at`; cases that care override it.
  taskSetParked: vi.fn().mockResolvedValue(null),
  taskGitPhaseState: vi.fn().mockRejectedValue(new Error("not mocked")),
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
  STICKY_DONE_MS: 8_000,
}));

// cliPromptReports reaches tauri directly (kept dependency-free so this
// store can import it without cycling); observe its delivery reports.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { isTabOnScreenIn, isUserWatching, RECENT_TASKS_CAP, TOUCH_MIN_MS, useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import { markUnattendedSpawn, takeUnattendedSpawn } from "@/lib/unattendedSpawns";
import type { QueueItem, PaneLeaf, Tab, TerminalTab, PersistedTab } from "@/lib/types";
import { useUI } from "@/store/ui";
// Store interactor — the ONE place that knows the store's shape. Cases below
// say what they mean ("what work state is that tab in?") instead of spelling
// out `tabs[taskId].find(...) as TerminalTab` on every assertion.
import {
  focusTab,
  getActiveTabId,
  getTabIds,
  getTabWorkState,
  getTabs,
  getTabsRef,
  getTabUnread,
  getTerminalTab,
  makeTask,
  makeTerminalTab as makeTermTab,
  resetAppStore,
  seedTab as addTab,
} from "@/test-utils/store";

beforeEach(() => {
  resetAppStore();
  vi.clearAllMocks();
});

// ── setWorkState ──────────────────────────────────────────────────────

describe("setWorkState", () => {
  it("transitions idle → working", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    expect(getTabWorkState(taskId, tab.id)).toBe("working");
  });

  it("transitions working → done", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "done");

    expect(getTabWorkState(taskId, tab.id)).toBe("done");
  });

  // The focused-tab rule downgrades "done" to "idle" because the user is
  // looking right at it. Windowless there IS no window, so the downgrade would
  // silently eat the badge for work that finished while they were away.
  //
  // NOTE this tests the GUARD, not the feature. The real "agent finished" path
  // is fireDone in TerminalPane, which returns BEFORE setWorkState when it
  // thinks the user is watching - an earlier version of this test passed while
  // that path was still broken. Both now share isUserWatching, covered below.
  it("does NOT swallow done for the active task while windowless", () => {
    const taskId = "ws-bg";
    const tab = makeTermTab({ workState: "working" });
    addTab(taskId, tab);
    focusTab(taskId, tab.id);

    useUI.getState().setWindowless(false);
    useApp.getState().setWorkState(taskId, tab.id, "done");
    expect(getTabWorkState(taskId, tab.id)).toBe("idle");

    const tab2 = makeTermTab({ workState: "working" });
    addTab(taskId, tab2);
    focusTab(taskId, tab2.id);
    useUI.getState().setWindowless(true);
    useApp.getState().setWorkState(taskId, tab2.id, "done");
    expect(getTabWorkState(taskId, tab2.id)).toBe("done");
    useUI.getState().setWindowless(false);
  });

  // isUserWatching is the predicate fireDone, seenAtIdle, forwardNotification
  // and useAttentionNotifier all gate on. If it wrongly reports "watching"
  // while windowless, every completion signal is suppressed at once.
  it("isUserWatching is false while windowless, whatever the store says", () => {
    const taskId = "watch-1";
    const tab = makeTermTab();
    addTab(taskId, tab);
    focusTab(taskId, tab.id);

    useUI.getState().setWindowless(false);
    expect(isUserWatching(taskId, tab.id)).toBe(true);
    expect(isUserWatching(taskId)).toBe(true);            // task-level
    expect(isUserWatching("other", tab.id)).toBe(false);  // different task

    useUI.getState().setWindowless(true);
    expect(isUserWatching(taskId, tab.id)).toBe(false);
    expect(isUserWatching(taskId)).toBe(false);
    useUI.getState().setWindowless(false);
  });

  it("sticky done: a busy signal right after the done is ignored", () => {
    const taskId = "ws1";
    // Claude flickers ✳ ↔ spinner for a few frames after answering; that is
    // not the next turn starting.
    const tab = makeTermTab({ workState: "done", workDoneAt: Date.now() - 1_000 });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    expect(getTabWorkState(taskId, tab.id)).toBe("done");
  });

  it("sticky done: an unstamped done stays sticky", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "done" });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    expect(getTabWorkState(taskId, tab.id)).toBe("done");
  });

  it("a busy signal past the sticky window takes the tab back to working", () => {
    const taskId = "ws1";
    // The agent is still working 9s after we called the turn done: our done
    // was premature, and before the window existed nothing but a click could
    // undo it — the tab showed no spinner for the rest of a long turn.
    const tab = makeTermTab({ workState: "done", workDoneAt: Date.now() - 9_000 });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    expect(getTabWorkState(taskId, tab.id)).toBe("working");
    expect(getTerminalTab(taskId, tab.id).workDoneAt).toBeUndefined();
  });

  it("drops the stale done badge when the agent goes back to work", () => {
    const taskId = "ws1";
    const tab = makeTermTab({
      workState: "done",
      workDoneAt: Date.now() - 9_000,
      unread: { reason: "done" },
    });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    expect(getTabUnread(taskId, tab.id)).toBeNull();
  });

  it("keeps an attention badge when the agent goes back to work", () => {
    const taskId = "ws1";
    // The agent asked for the user in its own words. That request outlives our
    // guess about whether the turn ended.
    const tab = makeTermTab({
      workState: "done",
      workDoneAt: Date.now() - 9_000,
      unread: { reason: "attention", message: "Claude needs your permission" },
    });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "working");

    expect(getTabWorkState(taskId, tab.id)).toBe("working");
    expect(getTabUnread(taskId, tab.id)?.reason).toBe("attention");
  });

  it("stamps workDoneAt on the transition to done", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(taskId, tab);

    const before = Date.now();
    useApp.getState().setWorkState(taskId, tab.id, "done");

    expect(getTerminalTab(taskId, tab.id).workDoneAt).toBeGreaterThanOrEqual(before);
  });

  it("idempotent: same state write causes no update", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "idle" });
    addTab(taskId, tab);

    const before = getTabsRef(taskId);
    useApp.getState().setWorkState(taskId, tab.id, "idle");
    const after = getTabsRef(taskId);

    // Same reference = no re-render triggered
    expect(after).toBe(before);
  });

  it("drops done → idle on the focused tab", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working" });
    addTab(taskId, tab);
    // Mark this task+tab as active (the user is looking at it)
    focusTab(taskId, tab.id);

    useApp.getState().setWorkState(taskId, tab.id, "done");

    // "done" on the focused tab is silently downgraded to "idle"
    expect(getTabWorkState(taskId, tab.id)).toBe("idle");
  });

  it("no-op on non-terminal tab", () => {
    const taskId = "ws1";
    const editTab: Tab = { id: "edit-1", type: "edit", title: "foo.ts", path: "/x/foo.ts" } as any;
    addTab(taskId, editTab);

    const before = getTabsRef(taskId);
    useApp.getState().setWorkState(taskId, "edit-1", "working");
    expect(getTabsRef(taskId)).toBe(before);
  });

  it("clears workProgress when leaving working state", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ workState: "working", workProgress: 60, workProgressKind: 1 });
    addTab(taskId, tab);

    useApp.getState().setWorkState(taskId, tab.id, "done");

    // workProgress cleared when not "working"
    const result = getTerminalTab(taskId, tab.id);
    expect(result.workProgress).toBeNull();
    expect(result.workProgressKind).toBeNull();
  });
});

// ── setTabLiveTitle ───────────────────────────────────────────────────
//
// An UNCHANGED title must not write. xterm fires onTitleChange for every
// OSC 0/2 without comparing it to the previous value (InputHandler.setTitle),
// and an agent TUI re-emits its unchanged title while it sits at the prompt —
// so a setter that allocated on every one of those woke every store subscriber
// several times a second, per terminal, forever, with the app idle. Measured
// on a 16-terminal fixture: 62 store writes/s and 19% of a core, halving to 31
// writes/s and 12.7% with the bail below.
//
// This is a COUNT assertion, which is the class that can gate a PR — a 3-core
// CI runner counts the same as an M1 Max, where the CPU figure would not
// survive the trip (docs/performance.md, docs/perf-ci.md).
describe("setTabLiveTitle", () => {
  it("applies a title that actually changed", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    useApp.getState().setTabLiveTitle(taskId, tab.id, "✳ termic");

    expect(getTerminalTab(taskId, tab.id).liveTitle).toBe("✳ termic");
  });

  it("does not touch the store when the title is unchanged", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);
    useApp.getState().setTabLiveTitle(taskId, tab.id, "✳ termic");

    const before = useApp.getState();
    useApp.getState().setTabLiveTitle(taskId, tab.id, "✳ termic");
    const after = useApp.getState();

    // Same STATE object, not merely equal: a fresh `tabs` record is what
    // invalidates every selector in every mounted task.
    expect(after).toBe(before);
    expect(after.tabs).toBe(before.tabs);
    expect(after.tabs[taskId]).toBe(before.tabs[taskId]);
    expect(after.tabs[taskId][0]).toBe(before.tabs[taskId][0]);
  });

  it("notifies subscribers ONCE for a title repainted 100 times", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });
    for (let i = 0; i < 100; i++) {
      useApp.getState().setTabLiveTitle(taskId, tab.id, "✳ termic");
    }
    unsub();

    // Only the first write is real; the other 99 are the idle TUI repainting.
    expect(notifications).toBe(1);
  });

  it("keeps ignoring the agent's title on a user-renamed tab", () => {
    const taskId = "ws1";
    const tab = makeTermTab({ customTitle: true, title: "mine" });
    addTab(taskId, tab);

    const before = useApp.getState();
    useApp.getState().setTabLiveTitle(taskId, tab.id, "✳ termic");

    expect(useApp.getState()).toBe(before);
    expect(getTerminalTab(taskId, tab.id).liveTitle).toBeUndefined();
  });

  it("is a no-op for a tab id that does not exist", () => {
    const taskId = "ws1";
    addTab(taskId, makeTermTab({ id: "a" }));

    const before = useApp.getState();
    useApp.getState().setTabLiveTitle(taskId, "nope", "✳ termic");

    expect(useApp.getState()).toBe(before);
  });
});

// ── closeTab ──────────────────────────────────────────────────────────

describe("closeTab", () => {
  it("removes the tab from the list", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    useApp.getState().closeTab(taskId, tab.id);

    expect(getTabs(taskId)).toHaveLength(0);
  });

  it("adjusts active tab to the previous sibling", () => {
    const taskId = "ws1";
    const t1 = makeTermTab({ id: "t1" });
    const t2 = makeTermTab({ id: "t2" });
    addTab(taskId, t1);
    addTab(taskId, t2);
    useApp.setState(s => ({ activeTab: { ...s.activeTab, [taskId]: "t2" } }));

    useApp.getState().closeTab(taskId, "t2");

    expect(getActiveTabId(taskId)).toBe("t1");
  });

  it("adjusts active tab to next sibling when first is closed", () => {
    const taskId = "ws1";
    const t1 = makeTermTab({ id: "t1" });
    const t2 = makeTermTab({ id: "t2" });
    addTab(taskId, t1);
    addTab(taskId, t2);
    useApp.setState(s => ({ activeTab: { ...s.activeTab, [taskId]: "t1" } }));

    useApp.getState().closeTab(taskId, "t1");

    expect(getActiveTabId(taskId)).toBe("t2");
  });

  it("no-op when tab id does not exist", () => {
    const taskId = "ws1";
    const tab = makeTermTab();
    addTab(taskId, tab);

    const before = getTabsRef(taskId);
    useApp.getState().closeTab(taskId, "ghost-id");
    expect(getTabsRef(taskId)).toBe(before);
  });

  it("a close that matches nothing does not rewrite the durable set (GH #185)", () => {
    // The no-op above is about the STORE; this is about DISK. closeTab used
    // to re-sync persisted_tabs unconditionally, even after deciding there
    // was nothing to close, and syncDurableTabs rebuilds that set from the
    // store's tab list. On a task with no tabs loaded (never opened this
    // session) the rebuild kept only the default tab and dropped every other
    // agent's session_id, permanently, while closing nothing at all.
    //
    // Unreachable from the GUI, which never names a tab it is not rendering.
    // `termic tab close` can name one on an unmounted task, which is how it
    // surfaced; that verb refuses such tasks, and this pins the floor under
    // it so the store is safe regardless of who calls.
    const taskId = "ws1";
    useApp.setState(s => ({
      tabs: { ...s.tabs, [taskId]: [] },
      tasks: [{
        id: taskId, project_id: "p1", name: "fix-auth", branch: "main",
        base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
        created: "2024-01-01", archived: false,
        persisted_tabs: [
          { id: "main", cli: "claude", is_default: true, session_id: "SESSION-A" },
          { id: "second", cli: "codex", session_id: "SESSION-B" },
        ],
      }] as never,
    }));
    vi.mocked(ipc.taskSetTabs).mockClear();

    useApp.getState().closeTab(taskId, "second");

    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
    expect(
      useApp.getState().tasks.find(t => t.id === taskId)?.persisted_tabs?.map(t => t.id),
    ).toEqual(["main", "second"]);
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

  // ── directory tabs (issue #151) ─────────────────────────────────────
  // A folder link recycles the SAME preview slot a file link uses, so it
  // must never leave a second tab behind or inherit the previous
  // occupant's per-document state.

  it("recycles the preview tab into a directory listing", () => {
    const wsId = "ws1";
    const previewTab: Tab = { id: "prev-1", type: "edit", title: "guide.md", path: "docs/guide.md", preview: true } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, { type: "dir", path: "docs/plans", title: "plans" });

    const tabs = useApp.getState().tabs[wsId];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].type).toBe("dir");
    expect((tabs[0] as any).path).toBe("docs/plans");
    expect(tabs[0].preview).toBe(true);
    expect(useApp.getState().activeTab[wsId]).toBe("prev-1");
  });

  it("clears a per-document remoteImagesUnblocked override when recycling into a directory", () => {
    const wsId = "ws1";
    const previewTab: Tab = {
      id: "prev-1", type: "edit", title: "old.md", path: "docs/old.md",
      preview: true, remoteImagesUnblocked: true,
    } as any;
    useApp.setState({ tabs: { [wsId]: [previewTab] }, activeTab: { [wsId]: "prev-1" } });

    useApp.getState().openPreviewTab(wsId, { type: "dir", path: "docs", title: "docs" });

    expect((useApp.getState().tabs[wsId][0] as any).remoteImagesUnblocked).toBeUndefined();
  });

  it("does not confuse a directory tab with a file tab on the same path", () => {
    // "docs" the folder and a (hypothetical) "docs" file are different
    // targets; the existing-tab lookup keys on type as well as path, so
    // opening the folder must not just re-activate the file tab.
    const wsId = "ws1";
    const fileTab: Tab = { id: "e1", type: "edit", title: "docs", path: "docs", preview: false } as any;
    useApp.setState({ tabs: { [wsId]: [fileTab] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, { type: "dir", path: "docs", title: "docs" });

    const tabs = useApp.getState().tabs[wsId];
    expect(tabs).toHaveLength(2);
    expect(tabs[1].type).toBe("dir");
    expect(useApp.getState().activeTab[wsId]).toBe(tabs[1].id);
  });

  it("re-activates an open directory tab instead of duplicating it", () => {
    const wsId = "ws1";
    const dirTab: Tab = { id: "d1", type: "dir", title: "docs", path: "docs", preview: false } as any;
    const other: Tab = { id: "e1", type: "edit", title: "guide.md", path: "docs/guide.md", preview: true } as any;
    useApp.setState({ tabs: { [wsId]: [dirTab, other] }, activeTab: { [wsId]: "e1" } });

    useApp.getState().openPreviewTab(wsId, { type: "dir", path: "docs", title: "docs" });

    expect(useApp.getState().tabs[wsId]).toHaveLength(2);
    expect(useApp.getState().activeTab[wsId]).toBe("d1");
  });

  it("does not set reveal fields on directory tabs", () => {
    const wsId = "ws1";
    useApp.setState({ tabs: { [wsId]: [] } });

    useApp.getState().openPreviewTab(wsId, {
      type: "dir", path: "docs", title: "docs", revealHeading: "usage",
    });

    const tab = useApp.getState().tabs[wsId][0] as any;
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
  const ids = getTabIds;
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

// ── pin / unpin (issue #183) ──────────────────────────────────────────

describe("pinTab / unpinTab", () => {
  const ids = getTabIds;
  const pinnedOf = (taskId: string, tabId: string) =>
    !!getTabs(taskId).find(t => t.id === tabId)?.pinned;

  function seed(taskId: string, n: number) {
    for (let i = 0; i < n; i++) addTab(taskId, makeTermTab({ id: `t${i}` }));
  }

  it("pin moves the tab to the front when nothing else is pinned", () => {
    seed("ws1", 3); // t0 t1 t2
    useApp.getState().pinTab("ws1", "t2");
    expect(ids("ws1")).toEqual(["t2", "t0", "t1"]);
    expect(pinnedOf("ws1", "t2")).toBe(true);
  });

  it("pin appends to the END of the pinned block, not the front", () => {
    seed("ws1", 4); // t0 t1 t2 t3
    useApp.getState().pinTab("ws1", "t3");
    useApp.getState().pinTab("ws1", "t2");
    expect(ids("ws1")).toEqual(["t3", "t2", "t0", "t1"]);
  });

  it("unpin drops the tab to the first slot after the pinned block", () => {
    seed("ws1", 4); // t0 t1 t2 t3
    useApp.getState().pinTab("ws1", "t2");
    useApp.getState().pinTab("ws1", "t3"); // t2 t3 t0 t1
    useApp.getState().unpinTab("ws1", "t2");
    expect(ids("ws1")).toEqual(["t3", "t2", "t0", "t1"]);
    expect(pinnedOf("ws1", "t2")).toBe(false);
  });

  it("pinning an already-pinned tab at the boundary leaves the order alone", () => {
    seed("ws1", 3);
    useApp.getState().pinTab("ws1", "t0");
    const before = ids("ws1");
    useApp.getState().pinTab("ws1", "t0");
    expect(ids("ws1")).toEqual(before);
  });

  it("ignores an unknown tab id", () => {
    seed("ws1", 2);
    const before = ids("ws1");
    useApp.getState().pinTab("ws1", "nope");
    expect(ids("ws1")).toEqual(before);
  });

  it("persists the pinned flag and the new order", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));

    useApp.getState().pinTab("ws1", "b");

    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["b", "a"]);
    expect(task.persisted_tabs!.map(t => t.pinned)).toEqual([true, false]);
  });

  it("persists an unpin even when the order does not change", () => {
    useApp.setState({ tasks: [makeTask()] });
    useApp.getState().addTab("ws1", makeTermTab({ id: "a", cli: "claude" }));
    useApp.getState().addTab("ws1", makeTermTab({ id: "b", cli: "codex" }));
    useApp.getState().pinTab("ws1", "a"); // already first — no move

    useApp.getState().unpinTab("ws1", "a"); // still first — no move either

    const task = useApp.getState().tasks.find(w => w.id === "ws1")!;
    expect(task.persisted_tabs!.map(t => t.id)).toEqual(["a", "b"]);
    expect(task.persisted_tabs![0].pinned).toBe(false);
  });

  it("a main tab's pin ignores split-pane tabs interleaved in the array", () => {
    addTab("ws1", makeTermTab({ id: "p0", paneId: "leaf-1" }));
    addTab("ws1", makeTermTab({ id: "t0" }));
    addTab("ws1", makeTermTab({ id: "t1" }));
    useApp.getState().pinTab("ws1", "t1");
    // t1 lands before t0 (the first MAIN tab), not at array index 0.
    expect(ids("ws1")).toEqual(["p0", "t1", "t0"]);
  });

  it("a pane tab's pin reorders its leaf's tabIds", () => {
    addTab("ws1", makeTermTab({ id: "p0", paneId: "leaf-1" }));
    addTab("ws1", makeTermTab({ id: "p1", paneId: "leaf-1" }));
    useApp.setState({
      splitTree: {
        ws1: { type: "pane", id: "leaf-1", tabIds: ["p0", "p1"], activeTabId: "p0" },
      },
    } as never);

    useApp.getState().pinTab("ws1", "p1");

    const leaf = useApp.getState().splitTree["ws1"] as PaneLeaf;
    expect(leaf.tabIds).toEqual(["p1", "p0"]);
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

  it("restores the pinned flag (issue #183)", () => {
    const persisted: PersistedTab[] = [
      { id: "t1", cli: "claude", is_default: true, pinned: true },
      { id: "t2", cli: "codex", pinned: false },
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");

    const tabs = useApp.getState().tabs["ws1"];
    expect(tabs.map(t => !!t.pinned)).toEqual([true, false]);
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

describe("visiting a task does not stop a hook-driven agent looking busy", () => {
  const seed = (hooks: boolean) => {
    useUI.getState().setWindowless(false);
    useUI.getState().setWindowFocused(true);
    useApp.setState({
      tasks: [{ id: "t1", project_id: "p", name: "t1", path: "/tmp/t1" }],
      activeTaskId: null,
      activeTab: { t1: "a" },
      splitTree: {}, activePaneId: {},
      agentHooksInstalled: hooks ? { claude: true } : {},
      tabs: { t1: [{ id: "a", type: "terminal", cli: "claude", title: "a", workState: "working" }] },
    } as never);
  };
  const workState = () =>
    (useApp.getState().tabs.t1[0] as { workState?: string }).workState;

  it("keeps the spinner when the agent reports its own state", () => {
    // The reported regression. Clicking in dropped the spinner, the grace
    // window then refused to let it back, and unlike the terminal title
    // nothing re-asserts working, so it stayed gone for the whole turn.
    seed(true);
    useApp.getState().setActiveTask("t1");
    expect(workState()).toBe("working");
  });

  it("still clears it for an agent read from its terminal", () => {
    // The escape hatch is real where the state is a guess: a spinner that got
    // stuck needs a way out that does not involve restarting the tab.
    seed(false);
    useApp.getState().setActiveTask("t1");
    expect(workState()).toBe("idle");
  });

  it("always clears a done badge, hooks or not", () => {
    // Done IS a notification, and visiting is exactly the acknowledgement it
    // was waiting for. Only `working` is live state.
    seed(true);
    useApp.setState({
      tabs: { t1: [{ id: "a", type: "terminal", cli: "claude", title: "a", workState: "done" }] },
    } as never);
    useApp.getState().setActiveTask("t1");
    expect(workState()).toBe("idle");
  });
});

describe("isUserWatching and window focus", () => {
  beforeEach(() => {
    useUI.getState().setWindowless(false);
    useUI.getState().setWindowFocused(true);
    useApp.setState({
      activeTaskId: "t1", activeTab: { t1: "a" }, splitTree: {}, activePaneId: {},
    } as never);
  });
  afterEach(() => { useUI.getState().setWindowFocused(true); });

  it("counts a focused window on the active task as watching", () => {
    expect(isUserWatching("t1", "a")).toBe(true);
  });

  it("does NOT count an unfocused window, even on the active tab", () => {
    // The reported case: Termic open behind the browser, agent finishes on the
    // task that happens to be active. Treating that as watched suppressed the
    // badge as already-seen, so there was nothing waiting on return.
    useUI.getState().setWindowFocused(false);
    expect(isUserWatching("t1", "a")).toBe(false);
  });

  it("still excludes the windowless case", () => {
    useUI.getState().setWindowFocused(true);
    useUI.getState().setWindowless(true);
    expect(isUserWatching("t1", "a")).toBe(false);
    useUI.getState().setWindowless(false);
  });

  it("keeps on-screen separate from presence", () => {
    // isTabOnScreenIn answers "would they see it if they looked", which stays
    // true while they are away. That split is what lets a subscriber react to
    // the two stores independently.
    useUI.getState().setWindowFocused(false);
    expect(isTabOnScreenIn(useApp.getState(), "t1", "a")).toBe(true);
    expect(isUserWatching("t1", "a")).toBe(false);
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

  // Node's experimental global `localStorage` shadows happy-dom's and doesn't
  // work without --localstorage-file, so neither env gives a usable one here
  // (see the same note in prefs.test.ts). Stub a Map-backed fake per test.
  function fakeLocalStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    useApp.setState({ collapsedGroups: {}, groupColors: {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

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

// ── stopTask (GH #119) ────────────────────────────────────────────────

describe("stopTask", () => {
  const taskId = "ws1";

  function seedRunningTask() {
    useApp.setState({ tasks: [makeTask()] });
    addTab(taskId, makeTermTab({
      id: "t1",
      ptyId: "pty-live",
      sessionId: "sess-uuid",
      lastInputAt: 111,
      lastOutputAt: 222,
      workState: "working",
    }));
    useApp.setState({ mountedTasks: new Set([taskId]), activeTaskId: taskId });
  }

  it("evicts the task and clears runtime-only tab fields, keeping resume keys", () => {
    seedRunningTask();
    useApp.getState().stopTask(taskId);
    const s = useApp.getState();
    expect(s.mountedTasks.has(taskId)).toBe(false);
    const tab = s.tabs[taskId][0] as TerminalTab;
    expect(tab.ptyId).toBeUndefined();
    expect(tab.lastInputAt).toBeNull();
    expect(tab.lastOutputAt).toBeNull();
    expect(tab.workState).toBeUndefined();
    // The whole point of Stop vs Archive: the session survives.
    expect(tab.sessionId).toBe("sess-uuid");
  });

  it("falls back to the dashboard when stopping the active task", () => {
    seedRunningTask();
    useApp.getState().stopTask(taskId);
    expect(useApp.getState().activeTaskId).toBeNull();
  });

  it("leaves a background task's active selection alone", () => {
    seedRunningTask();
    useApp.setState({ activeTaskId: "other-task" });
    useApp.getState().stopTask(taskId);
    expect(useApp.getState().activeTaskId).toBe("other-task");
  });

  it("is a no-op for a task that is not mounted", () => {
    seedRunningTask();
    useApp.setState({ mountedTasks: new Set(), activeTaskId: null });
    const before = useApp.getState().tabs;
    useApp.getState().stopTask(taskId);
    expect(useApp.getState().tabs).toBe(before);
  });

  it("fails CLI-queued prompts fast and keeps the user's own queue", () => {
    // Nothing drains a stopped task's queue: a pending `send --wait`
    // must get its exit 9 NOW (via cli_prompt_report), and only the
    // CLI's items leave; the user's own loop entries stay.
    seedRunningTask();
    const userItem: QueueItem = { id: "q1", text: "again", repeat: 3, remaining: 2 };
    const cliItem: QueueItem = { id: "q2", text: "from cli", repeat: 1, remaining: 1, promptId: "p7" };
    useApp.getState().patchTab(taskId, "t1", { queue: [userItem, cliItem], queueActive: true });
    vi.mocked(invoke).mockClear();
    useApp.getState().stopTask(taskId);
    const tab = useApp.getState().tabs[taskId][0] as TerminalTab;
    expect(tab.queue).toEqual([userItem]);
    expect(invoke).toHaveBeenCalledWith("cli_prompt_report", {
      id: "p7",
      ok: false,
      error: "the task was stopped before the queued prompt delivered",
    });
  });
});

// ── unattended restore (CLI send --resume) ────────────────────────────

describe("ensureDefaultTab — unattended restore mark", () => {
  it("consumes the mark onto the restored DEFAULT tab only", () => {
    // The CLI's send --resume marks the task before hydrating so the
    // restored default spawns with UNATTENDED_SPAWN_ARGS (a startup
    // update menu must not swallow the injection that follows).
    const persisted: PersistedTab[] = [
      { id: "t1", cli: "claude", is_default: true, session_id: "u1" },
      { id: "t2", cli: "codex" },
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    markUnattendedSpawn("ws1");
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs.find(t => t.id === "t1")?.unattended).toBe(true);
    expect(tabs.find(t => t.id === "t2")?.unattended).toBeUndefined();
    // Consumed: a later restore of the same task is attended again.
    expect(takeUnattendedSpawn("ws1")).toBe(false);
  });

  it("restores without the flag when nothing marked the task", () => {
    const persisted: PersistedTab[] = [{ id: "t1", cli: "claude", is_default: true }];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tabs = useApp.getState().tabs["ws1"] as TerminalTab[];
    expect(tabs[0].unattended).toBeUndefined();
  });
});

// ── dashboard recents (localStorage-backed task MRU) ──────────────────

describe("recentTasks", () => {
  const task = (id: string, archived = false) =>
    ({ id, project_id: "p1", name: id, archived } as import("@/lib/types").Task);

  // Same Map-backed fake as the group-state block: Node's experimental global
  // localStorage shadows happy-dom's and is unusable without a backing file.
  function fakeLocalStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    useApp.setState({
      recentTasks: [],
      tasks: [task("a"), task("b"), task("c")],
      mountedTasks: new Set<string>(),
      collapsedProjects: {},
      collapsedGroups: {},
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const recents = () => useApp.getState().recentTasks;

  it("pushes the activated task to the front and persists it", () => {
    useApp.getState().setActiveTask("a");
    expect(recents()).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem("recentTasks")!)).toEqual(["a"]);
  });

  it("orders newest first", () => {
    useApp.getState().setActiveTask("a");
    useApp.getState().setActiveTask("b");
    expect(recents()).toEqual(["b", "a"]);
  });

  it("dedupes: revisiting a task moves it up rather than repeating it", () => {
    useApp.getState().setActiveTask("a");
    useApp.getState().setActiveTask("b");
    useApp.getState().setActiveTask("a");
    expect(recents()).toEqual(["a", "b"]);
  });

  it("caps the list, dropping the oldest", () => {
    const many = Array.from({ length: RECENT_TASKS_CAP + 3 }, (_, i) => `t${i}`);
    useApp.setState({ tasks: many.map(id => task(id)) });
    for (const id of many) useApp.getState().setActiveTask(id);
    expect(recents()).toHaveLength(RECENT_TASKS_CAP);
    expect(recents()[0]).toBe(many[many.length - 1]);
    expect(recents()).not.toContain("t0");
  });

  it("does not write when the task is already the newest entry", () => {
    useApp.getState().setActiveTask("a");
    const before = recents();
    useApp.getState().setActiveTask("a");
    // Same ARRAY, not merely equal: a fresh array would invalidate every
    // subscriber reading recentTasks for a list that did not change.
    expect(recents()).toBe(before);
  });

  it("records nothing when the active task is cleared", () => {
    useApp.getState().setActiveTask("a");
    useApp.getState().setActiveTask(null);
    expect(recents()).toEqual(["a"]);
  });

  it("loadAll prunes ids that no longer resolve to an open task", async () => {
    useApp.setState({ recentTasks: ["gone", "a", "archived"] });
    const ipc = await import("@/lib/ipc");
    vi.mocked(ipc.tasksList).mockResolvedValueOnce([task("a"), task("archived", true)]);
    await useApp.getState().loadAll();
    // "gone" no longer exists and "archived" belongs to History now, so
    // neither may sit in the Recent row offering a dead link.
    expect(recents()).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem("recentTasks")!)).toEqual(["a"]);
  });

  it("loadAll leaves an already-clean list alone", async () => {
    useApp.setState({ recentTasks: ["a"] });
    const before = useApp.getState().recentTasks;
    const ipc = await import("@/lib/ipc");
    vi.mocked(ipc.tasksList).mockResolvedValueOnce([task("a")]);
    await useApp.getState().loadAll();
    expect(useApp.getState().recentTasks).toBe(before);
  });
});

// ── previewPlace (the ⌃⇥ walk) ────────────────────────────────────────

describe("previewPlace", () => {
  // A ⌃⇥ walk passes THROUGH places on its way somewhere, in well under a
  // second each. Every assertion here is a shipped bug if it regresses: the
  // normal setters treat being selected as "the user has seen this", which for
  // a place that was on screen for 80ms is a lie that destroys state.
  const seed = (taskId: string, tabId: string, tab: Partial<TerminalTab> = {}) => {
    useApp.setState(s => ({ tasks: [...s.tasks, makeTask({ id: taskId })] }));
    addTab(taskId, makeTermTab({ id: tabId, ...tab }));
  };

  it("shows the place", () => {
    seed("A", "a1");
    useApp.getState().previewPlace("A", "a1");
    expect(useApp.getState().activeTaskId).toBe("A");
    expect(getActiveTabId("A")).toBe("a1");
  });

  it("does NOT clear a done badge it passes over", () => {
    // setActiveTask demotes done → idle and clears unread on every tab of the
    // task. Walking past an agent that had just finished would silently throw
    // away the one signal saying so, and nothing puts it back.
    seed("A", "a1", { workState: "done", unread: { reason: "done" } });
    useApp.getState().previewPlace("A", "a1");
    expect(getTabWorkState("A", "a1")).toBe("done");
    expect(getTabUnread("A", "a1")).toEqual({ reason: "done" });

    // Control: the real setter DOES clear both. That is correct for a click
    // and wrong for a place you flashed past, which is the whole distinction.
    useApp.getState().setActiveTask("A");
    expect(getTabWorkState("A", "a1")).toBe("idle");
    expect(getTabUnread("A", "a1")).toBeNull();
  });

  it("does NOT expand the project it passes through", () => {
    // setActiveTask force-expands the parent project and its sidebar group,
    // and persists both. A walk through collapsed projects would leave them
    // all open, permanently.
    seed("A", "a1");
    useApp.setState({ collapsedProjects: { p1: true } });
    useApp.getState().previewPlace("A", "a1");
    expect(useApp.getState().collapsedProjects.p1).toBe(true);
  });

  it("does NOT close the Settings overlay", () => {
    // setActiveTask replaces `view` wholesale rather than spreading it, so
    // selecting a task drops settingsOpen.
    seed("A", "a1");
    useApp.getState().openSettings("shortcuts");
    useApp.getState().previewPlace("A", "a1");
    expect(useApp.getState().view.settingsOpen).toBe(true);
    expect(useApp.getState().view.settingsTab).toBe("shortcuts");
  });

  it("leaves the tab list alone, so no tab-strip selector re-renders", () => {
    // setActiveTabId rebuilds tabs[taskId] through .map() unconditionally.
    seed("A", "a1");
    const before = getTabsRef("A");
    useApp.getState().previewPlace("A", "a1");
    expect(getTabsRef("A")).toBe(before);
  });

  it("writes nothing at all when it would change nothing", () => {
    seed("A", "a1");
    useApp.getState().previewPlace("A", "a1");
    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });
    useApp.getState().previewPlace("A", "a1");
    unsub();
    expect(notifications).toBe(0);
  });

  it("costs ONE notification per step, where the real setters cost more", () => {
    // The count is what pins this down on a 3-core CI runner, and what fails
    // if someone later folds previewPlace back into setActiveTask (which does
    // three writes of its own: patchTab on the departing tab, the main set,
    // and the unread-clearing set).
    seed("A", "a1");
    seed("B", "b1");
    useApp.getState().previewPlace("A", "a1");

    let preview = 0;
    let unsub = useApp.subscribe(() => { preview++; });
    useApp.getState().previewPlace("B", "b1");
    useApp.getState().previewPlace("A", "a1");
    useApp.getState().previewPlace("B", "b1");
    unsub();
    expect(preview).toBe(3);

    let real = 0;
    unsub = useApp.subscribe(() => { real++; });
    useApp.getState().setActiveTask("A");
    unsub();
    expect(real).toBeGreaterThan(1);
  });
});

// ── last_opened_at (task activation stamp) ────────────────────────────
//
// The stamp is written on EVERY activation, which is the hottest store path
// the sidebar has: a ⌘1/⌘2 flick between two tasks is two activations per
// keystroke. So both halves of the design are count assertions, the class that
// survives a 3-core CI runner (docs/perf-ci.md):
//
//   1. a second activation inside TOUCH_MIN_MS writes NOTHING, keeping the
//      `tasks` array identity that every mounted task's selectors hang off
//      (docs/performance.md bear trap 8); and
//   2. the write that does happen rides INSIDE the set() `setActiveTask` was
//      making anyway, so the feature adds zero subscriber notifications.
describe("setActiveTask last_opened_at", () => {
  const stamped = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.last_opened_at;

  beforeEach(() => {
    useApp.setState({ tasks: [makeTask({ id: "ws1" }), makeTask({ id: "ws2" })] });
  });

  it("stamps the task and persists it exactly once", () => {
    const before = Date.now();
    useApp.getState().setActiveTask("ws1");

    const at = stamped("ws1");
    expect(at).toBeTruthy();
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before);
    expect(ipc.taskTouch).toHaveBeenCalledTimes(1);
    expect(ipc.taskTouch).toHaveBeenCalledWith("ws1");
    // The sibling is untouched: a stamp is per task, not per activation.
    expect(stamped("ws2")).toBeUndefined();
  });

  it("does not touch the store again inside the 60s window", () => {
    // Both tasks stamped once, which is the only real work here.
    useApp.getState().setActiveTask("ws1");
    useApp.getState().setActiveTask("ws2");
    const first = stamped("ws1");

    // Now the ⌘1/⌘2 flick: straight back and forth, all inside the window.
    const before = useApp.getState();
    useApp.getState().setActiveTask("ws1");
    useApp.getState().setActiveTask("ws2");
    useApp.getState().setActiveTask("ws1");
    const after = useApp.getState();

    // Same ARRAY, not merely equal: a fresh `tasks` is what invalidates every
    // selector in every mounted task.
    expect(after.tasks).toBe(before.tasks);
    expect(stamped("ws1")).toBe(first);
    // Still the two opening touches: the flick added none.
    expect(ipc.taskTouch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.taskTouch).mock.calls.map(c => c[0])).toEqual(["ws1", "ws2"]);
  });

  it("re-stamps once the window has passed", () => {
    const old = new Date(Date.now() - TOUCH_MIN_MS - 1_000).toISOString();
    useApp.setState({ tasks: [makeTask({ id: "ws1", last_opened_at: old })] });

    useApp.getState().setActiveTask("ws1");

    expect(stamped("ws1")).not.toBe(old);
    expect(ipc.taskTouch).toHaveBeenCalledTimes(1);
  });

  // Both halves of the freshness predicate's escape hatch, pinned to the same
  // rule `touch_task_record` follows in lib.rs. They matter here more than
  // there: a stamp THIS side calls fresh never reaches Rust to be judged.
  //
  // NaN because `Date.now() - Date.parse("nonsense")` is NaN and every
  // comparison against NaN is false; a guard written as `>= TOUCH_MIN_MS`
  // would freeze the value forever. Negative because a clock that jumped
  // backwards would otherwise suppress every activation until it caught up.
  it("replaces a stamp it cannot parse", () => {
    useApp.setState({ tasks: [makeTask({ id: "ws1", last_opened_at: "yesterday" })] });

    useApp.getState().setActiveTask("ws1");

    expect(Date.parse(stamped("ws1")!)).not.toBeNaN();
    expect(ipc.taskTouch).toHaveBeenCalledTimes(1);
  });

  it("replaces a stamp from the future rather than waiting it out", () => {
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    useApp.setState({ tasks: [makeTask({ id: "ws1", last_opened_at: ahead })] });

    useApp.getState().setActiveTask("ws1");

    expect(stamped("ws1")).not.toBe(ahead);
    expect(Date.parse(stamped("ws1")!)).toBeLessThanOrEqual(Date.now());
    expect(ipc.taskTouch).toHaveBeenCalledTimes(1);
  });

  it("adds ZERO subscriber notifications to an activation", () => {
    const notificationsFor = (id: string) => {
      let n = 0;
      const unsub = useApp.subscribe(() => { n++; });
      useApp.getState().setActiveTask(id);
      unsub();
      return n;
    };

    // Warm both so the second measurement below is a BAILED touch, not a
    // first visit.
    useApp.getState().setActiveTask("ws2");
    useApp.getState().setActiveTask("ws1");

    // An activation that does stamp, versus one inside the window that does
    // not. The measurement is the comparison: the stamp rides inside a set()
    // `setActiveTask` was making anyway, so the two must be equal.
    useApp.setState({ tasks: [makeTask({ id: "ws1" }), makeTask({ id: "ws2" })] });
    useApp.getState().setActiveTask("ws2");
    vi.mocked(ipc.taskTouch).mockClear();
    const stamping = notificationsFor("ws1");
    const touchCallsWhileStamping = vi.mocked(ipc.taskTouch).mock.calls.length;

    useApp.getState().setActiveTask("ws2");
    const bailing = notificationsFor("ws1");

    expect(touchCallsWhileStamping).toBe(1);
    expect(bailing).toBe(stamping);
    // 2 is the PRE-EXISTING cost of one activation with no tabs open: the
    // main set(), plus the read-clearing set() under it. The stamp is inside
    // the first of those, so this number must not move.
    expect(stamping).toBe(2);
  });

  it("never touches when the active task is cleared", () => {
    useApp.getState().setActiveTask("ws1");
    vi.mocked(ipc.taskTouch).mockClear();

    useApp.getState().setActiveTask(null);

    expect(ipc.taskTouch).not.toHaveBeenCalled();
  });

  // Agent Race mounts N tasks at once without focusing them. Mounting is not
  // opening, and stamping there would backdate every task in the race to the
  // moment the user pressed one button.
  it("mountTasks never touches", () => {
    useApp.getState().mountTasks(["ws1", "ws2"]);

    expect(ipc.taskTouch).not.toHaveBeenCalled();
    expect(stamped("ws1")).toBeUndefined();
  });

  it("is a no-op for an id that resolves to no task", () => {
    useApp.getState().setActiveTask("nope");

    expect(ipc.taskTouch).not.toHaveBeenCalled();
  });
});

// ── recordSpawn ───────────────────────────────────────────────────────
//
// `task_record_spawn` always WROTE the count; nothing read the answer back,
// so a task created this session stayed at spawn_count 0 in the store until
// the next `loadAll`. (The derived phase no longer reads it: see the
// `markStarted` block below for what replaced it and why.)
describe("recordSpawn", () => {
  const count = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.spawn_count;

  beforeEach(() => {
    useApp.setState({ tasks: [makeTask({ id: "ws1", spawn_count: 0 })] });
  });

  it("folds the persisted count back into the store", async () => {
    vi.mocked(ipc.taskRecordSpawn).mockResolvedValueOnce(3);

    useApp.getState().recordSpawn("ws1");

    await vi.waitFor(() => expect(count("ws1")).toBe(3));
    expect(ipc.taskRecordSpawn).toHaveBeenCalledWith("ws1");
  });

  it("leaves state identity alone when the count did not change", async () => {
    vi.mocked(ipc.taskRecordSpawn).mockResolvedValueOnce(0);
    const before = useApp.getState();

    useApp.getState().recordSpawn("ws1");
    await vi.waitFor(() => expect(ipc.taskRecordSpawn).toHaveBeenCalled());
    await Promise.resolve();

    expect(useApp.getState()).toBe(before);
    expect(useApp.getState().tasks).toBe(before.tasks);
  });

  it("drops the answer for a task that is gone by the time it lands", async () => {
    vi.mocked(ipc.taskRecordSpawn).mockResolvedValueOnce(2);

    useApp.getState().recordSpawn("ws1");
    // Archived and reloaded out from under the in-flight call.
    useApp.setState({ tasks: [] });
    await vi.waitFor(() => expect(ipc.taskRecordSpawn).toHaveBeenCalled());
    await Promise.resolve();

    expect(useApp.getState().tasks).toEqual([]);
  });

  it("survives a rejected write without throwing", async () => {
    vi.mocked(ipc.taskRecordSpawn).mockRejectedValueOnce(new Error("disk full"));

    expect(() => useApp.getState().recordSpawn("ws1")).not.toThrow();
    await vi.waitFor(() => expect(ipc.taskRecordSpawn).toHaveBeenCalled());
    expect(count("ws1")).toBe(0);
  });
});

// ── markStarted ───────────────────────────────────────────────────────
//
// Write-once, and it rides the same "a human submitted something" gate as
// `lastInputAt`: every prompt submit in every terminal calls it, so the
// second call onwards must cost NOTHING (docs/performance.md bear trap 8).
// Same shape as the `setActiveTask last_opened_at` block above, for the same
// reason: what is worth asserting is the bail, not the stamp.
describe("markStarted", () => {
  const startedAt = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.started_at;

  beforeEach(() => {
    useApp.setState({ tasks: [makeTask({ id: "ws1" }), makeTask({ id: "ws2" })] });
  });

  it("stamps the task and persists it exactly once", () => {
    const before = Date.now();
    useApp.getState().markStarted("ws1");

    const at = startedAt("ws1");
    expect(at).toBeTruthy();
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before);
    expect(ipc.taskMarkStarted).toHaveBeenCalledTimes(1);
    expect(ipc.taskMarkStarted).toHaveBeenCalledWith("ws1");
    // Per task, not per app: the sibling is untouched.
    expect(startedAt("ws2")).toBeUndefined();
  });

  it("costs nothing on every submit after the first", () => {
    useApp.getState().markStarted("ws1");
    const first = startedAt("ws1");
    vi.mocked(ipc.taskMarkStarted).mockClear();

    const before = useApp.getState();
    useApp.getState().markStarted("ws1");
    useApp.getState().markStarted("ws1");
    useApp.getState().markStarted("ws1");
    const after = useApp.getState();

    // Same ARRAY, not merely equal: a fresh `tasks` is what invalidates every
    // selector in every mounted task.
    expect(after.tasks).toBe(before.tasks);
    expect(startedAt("ws1")).toBe(first);
    expect(ipc.taskMarkStarted).not.toHaveBeenCalled();
  });

  it("never re-stamps a task that arrived from disk already started", () => {
    // The common case after a relaunch: the record carries the stamp, and the
    // first Enter of the new session must not move it.
    const old = "2026-01-02T03:04:05.000Z";
    useApp.setState({ tasks: [makeTask({ id: "ws1", started_at: old })] });

    useApp.getState().markStarted("ws1");

    expect(startedAt("ws1")).toBe(old);
    expect(ipc.taskMarkStarted).not.toHaveBeenCalled();
  });

  it("treats a null stamp as not started, the way serde writes an empty one", () => {
    useApp.setState({ tasks: [makeTask({ id: "ws1", started_at: null })] });

    useApp.getState().markStarted("ws1");

    expect(startedAt("ws1")).toBeTruthy();
    expect(ipc.taskMarkStarted).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an id that resolves to no task", () => {
    const before = useApp.getState();
    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });

    useApp.getState().markStarted("nope");

    unsub();
    expect(notifications).toBe(0);
    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskMarkStarted).not.toHaveBeenCalled();
  });

  it("notifies subscribers ONCE on the first call and never again", () => {
    const notificationsFor = (id: string) => {
      let n = 0;
      const unsub = useApp.subscribe(() => { n++; });
      useApp.getState().markStarted(id);
      unsub();
      return n;
    };

    expect(notificationsFor("ws1")).toBe(1);
    expect(notificationsFor("ws1")).toBe(0);
    expect(notificationsFor("ws1")).toBe(0);
  });

  it("survives a rejected write without throwing, keeping the in-memory stamp", () => {
    vi.mocked(ipc.taskMarkStarted).mockRejectedValueOnce(new Error("disk full"));

    expect(() => useApp.getState().markStarted("ws1")).not.toThrow();
    expect(startedAt("ws1")).toBeTruthy();
  });

  // Any prompt un-parks: sending something into a task you put down means you
  // have picked it up again, and a park the user has to clear by hand is the
  // stale-by-hand signal the whole design refuses.
  describe("un-parking", () => {
    const parkedAt = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.parked_at;
    const reason = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.park_reason;

    it("clears the park on a task that was already started", () => {
      useApp.setState({
        tasks: [makeTask({
          id: "ws1",
          started_at: "2026-01-02T03:04:05.000Z",
          parked_at: "2026-02-02T03:04:05.000Z",
          park_reason: "waiting on the API key",
        })],
      });

      useApp.getState().markStarted("ws1");

      expect(parkedAt("ws1")).toBeNull();
      expect(reason("ws1")).toBeNull();
      // The original stamp is untouched: write-once holds here too, not only
      // on the Rust side.
      expect(startedAt("ws1")).toBe("2026-01-02T03:04:05.000Z");
      expect(ipc.taskMarkStarted).toHaveBeenCalledTimes(1);
    });

    it("stamps and un-parks in ONE notification for a parked task nobody started", () => {
      useApp.setState({
        tasks: [makeTask({ id: "ws1", parked_at: "2026-02-02T03:04:05.000Z" })],
      });
      let notifications = 0;
      const unsub = useApp.subscribe(() => { notifications++; });

      useApp.getState().markStarted("ws1");

      unsub();
      expect(notifications).toBe(1);
      expect(startedAt("ws1")).toBeTruthy();
      expect(parkedAt("ws1")).toBeNull();
    });

    it("costs nothing once the task is started AND unparked", () => {
      // The steady state after the park is cleared: the second prompt and
      // every one after it must not copy the state again (bear trap 8).
      useApp.setState({
        tasks: [makeTask({
          id: "ws1",
          started_at: "2026-01-02T03:04:05.000Z",
          parked_at: "2026-02-02T03:04:05.000Z",
        })],
      });
      useApp.getState().markStarted("ws1");
      vi.mocked(ipc.taskMarkStarted).mockClear();

      const before = useApp.getState();
      useApp.getState().markStarted("ws1");
      useApp.getState().markStarted("ws1");

      expect(useApp.getState().tasks).toBe(before.tasks);
      expect(ipc.taskMarkStarted).not.toHaveBeenCalled();
    });

    it("treats a null parked_at as not parked, so a started task still bails", () => {
      useApp.setState({
        tasks: [makeTask({
          id: "ws1", started_at: "2026-01-02T03:04:05.000Z", parked_at: null,
        })],
      });
      const before = useApp.getState();

      useApp.getState().markStarted("ws1");

      expect(useApp.getState().tasks).toBe(before.tasks);
      expect(ipc.taskMarkStarted).not.toHaveBeenCalled();
    });
  });
});

// ── setTaskGoal ───────────────────────────────────────────────────────
//
// Free text, not a state: what is worth pinning is that it writes once and
// that an unchanged submit costs nothing (docs/performance.md bear trap 8).
describe("setTaskGoal", () => {
  const goalOf = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.goal;

  beforeEach(() => {
    useApp.setState({ tasks: [makeTask({ id: "ws1" }), makeTask({ id: "ws2" })] });
  });

  it("records the goal in the store and on disk", () => {
    useApp.getState().setTaskGoal("ws1", "Ship the importer");

    expect(goalOf("ws1")).toBe("Ship the importer");
    expect(ipc.taskSetGoal).toHaveBeenCalledTimes(1);
    expect(ipc.taskSetGoal).toHaveBeenCalledWith("ws1", "Ship the importer");
    // Per task, not per app.
    expect(goalOf("ws2")).toBeUndefined();
  });

  it("does not touch started_at: writing a goal is not starting work", () => {
    useApp.getState().setTaskGoal("ws1", "Ship the importer");

    expect(useApp.getState().tasks.find(w => w.id === "ws1")?.started_at).toBeUndefined();
  });

  it("writes nothing when the goal is unchanged", () => {
    useApp.getState().setTaskGoal("ws1", "Ship the importer");
    vi.mocked(ipc.taskSetGoal).mockClear();

    const before = useApp.getState();
    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });

    useApp.getState().setTaskGoal("ws1", "Ship the importer");

    unsub();
    expect(notifications).toBe(0);
    // Same ARRAY, not merely equal.
    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetGoal).not.toHaveBeenCalled();
  });

  it("treats null, undefined and absent as one value, so clearing an empty goal is a no-op", () => {
    const before = useApp.getState();

    useApp.getState().setTaskGoal("ws1", null);

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetGoal).not.toHaveBeenCalled();
  });

  it("trims what it stores, the way the record does on the way to disk", () => {
    useApp.getState().setTaskGoal("ws1", "  Ship the importer  ");

    expect(goalOf("ws1")).toBe("Ship the importer");
    expect(ipc.taskSetGoal).toHaveBeenCalledWith("ws1", "Ship the importer");
  });

  it("a whitespace-only goal is no goal, so it neither writes nor stores a blank", () => {
    // Rust's `normalize_task_note` collapses this to None. If this side kept
    // `"  "`, the store would hold a truthy goal the disk does not have, and
    // the row would read Planned until the next loadAll.
    const before = useApp.getState();

    useApp.getState().setTaskGoal("ws1", "   ");

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetGoal).not.toHaveBeenCalled();
  });

  it("clears a set goal when the box is emptied to whitespace", () => {
    useApp.getState().setTaskGoal("ws1", "Ship the importer");
    vi.mocked(ipc.taskSetGoal).mockClear();

    useApp.getState().setTaskGoal("ws1", "  ");

    expect(goalOf("ws1")).toBeNull();
    expect(ipc.taskSetGoal).toHaveBeenCalledWith("ws1", null);
  });

  it("clears a goal that was set", () => {
    useApp.getState().setTaskGoal("ws1", "Ship the importer");
    vi.mocked(ipc.taskSetGoal).mockClear();

    useApp.getState().setTaskGoal("ws1", null);

    expect(goalOf("ws1")).toBeNull();
    expect(ipc.taskSetGoal).toHaveBeenCalledWith("ws1", null);
  });

  it("edits an existing goal", () => {
    useApp.getState().setTaskGoal("ws1", "Ship the importer");
    useApp.getState().setTaskGoal("ws1", "Ship the importer behind a flag");

    expect(goalOf("ws1")).toBe("Ship the importer behind a flag");
    expect(ipc.taskSetGoal).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for an id that resolves to no task", () => {
    const before = useApp.getState();

    useApp.getState().setTaskGoal("nope", "Ship the importer");

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetGoal).not.toHaveBeenCalled();
  });

  it("survives a rejected write without throwing, keeping the in-memory goal", () => {
    vi.mocked(ipc.taskSetGoal).mockRejectedValueOnce(new Error("disk full"));

    expect(() => useApp.getState().setTaskGoal("ws1", "Ship the importer")).not.toThrow();
    expect(goalOf("ws1")).toBe("Ship the importer");
  });
});

// ── setTaskParked ─────────────────────────────────────────────────────
//
// The one hand-set phase input. Two things carry the design: `parked_at`
// answers "since when" and must not move when the task is re-parked, and an
// unchanged park must not write at all (docs/performance.md bear trap 8).
describe("setTaskParked", () => {
  const parkedAt = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.parked_at;
  const reason = (id: string) => useApp.getState().tasks.find(w => w.id === id)?.park_reason;

  beforeEach(() => {
    useApp.setState({ tasks: [makeTask({ id: "ws1" }), makeTask({ id: "ws2" })] });
  });

  it("parks the task with a stamp and persists it", () => {
    const before = Date.now();

    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");

    const at = parkedAt("ws1");
    expect(at).toBeTruthy();
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before);
    expect(reason("ws1")).toBe("waiting on the API key");
    expect(ipc.taskSetParked).toHaveBeenCalledTimes(1);
    expect(ipc.taskSetParked).toHaveBeenCalledWith("ws1", true, "waiting on the API key");
    expect(parkedAt("ws2")).toBeUndefined();
  });

  it("parks without a reason, which is the common case", () => {
    useApp.getState().setTaskParked("ws1", true);

    expect(parkedAt("ws1")).toBeTruthy();
    expect(reason("ws1")).toBeNull();
    expect(ipc.taskSetParked).toHaveBeenCalledWith("ws1", true, null);
  });

  it("writes nothing when re-parking with the same reason", () => {
    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    vi.mocked(ipc.taskSetParked).mockClear();

    const before = useApp.getState();
    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });

    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");

    unsub();
    expect(notifications).toBe(0);
    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetParked).not.toHaveBeenCalled();
  });

  it("writes nothing when re-parking a reasonless park with no reason", () => {
    useApp.getState().setTaskParked("ws1", true);
    vi.mocked(ipc.taskSetParked).mockClear();
    const before = useApp.getState();

    useApp.getState().setTaskParked("ws1", true);
    useApp.getState().setTaskParked("ws1", true, null);
    useApp.getState().setTaskParked("ws1", true, undefined);

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetParked).not.toHaveBeenCalled();
  });

  it("trims the reason, and a whitespace-only one is no reason at all", () => {
    useApp.getState().setTaskParked("ws1", true, "  waiting on the API key  ");
    expect(reason("ws1")).toBe("waiting on the API key");
    expect(ipc.taskSetParked).toHaveBeenCalledWith("ws1", true, "waiting on the API key");

    vi.mocked(ipc.taskSetParked).mockClear();
    useApp.getState().setTaskParked("ws2", true, "   ");
    expect(parkedAt("ws2")).toBeTruthy();
    expect(reason("ws2")).toBeNull();
    expect(ipc.taskSetParked).toHaveBeenCalledWith("ws2", true, null);
  });

  it("re-parking with the same reason retyped with spaces writes nothing", () => {
    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    vi.mocked(ipc.taskSetParked).mockClear();
    const before = useApp.getState();

    useApp.getState().setTaskParked("ws1", true, "  waiting on the API key ");

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetParked).not.toHaveBeenCalled();
  });

  it("writes nothing when unparking a task that is not parked", () => {
    const before = useApp.getState();

    useApp.getState().setTaskParked("ws1", false);

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetParked).not.toHaveBeenCalled();
  });

  it("a CHANGED reason writes, and does NOT move parked_at", () => {
    // The stamp answers "since when", so editing the note must not restart the
    // clock. Rust refuses to move it; this side has to agree, or the store
    // disagrees with disk for a round trip and then snaps back.
    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    const first = parkedAt("ws1");
    vi.mocked(ipc.taskSetParked).mockClear();
    vi.mocked(ipc.taskSetParked).mockResolvedValueOnce(first!);

    useApp.getState().setTaskParked("ws1", true, "waiting on the vendor");

    expect(reason("ws1")).toBe("waiting on the vendor");
    expect(parkedAt("ws1")).toBe(first);
    expect(ipc.taskSetParked).toHaveBeenCalledWith("ws1", true, "waiting on the vendor");
  });

  it("dropping the reason off a parked task is a change and writes", () => {
    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    const first = parkedAt("ws1");
    vi.mocked(ipc.taskSetParked).mockClear();

    useApp.getState().setTaskParked("ws1", true, null);

    expect(reason("ws1")).toBeNull();
    expect(parkedAt("ws1")).toBe(first);
    expect(ipc.taskSetParked).toHaveBeenCalledTimes(1);
  });

  it("unparking clears both fields and sends no reason", () => {
    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    vi.mocked(ipc.taskSetParked).mockClear();

    useApp.getState().setTaskParked("ws1", false);

    expect(parkedAt("ws1")).toBeNull();
    expect(reason("ws1")).toBeNull();
    expect(ipc.taskSetParked).toHaveBeenCalledWith("ws1", false, null);
  });

  it("folds the real stamp back when Rust answers with a different one", async () => {
    // Rust owns the stamp: an already parked record on disk keeps its original,
    // which the optimistic write here cannot know about.
    const real = "2026-02-02T03:04:05.000Z";
    vi.mocked(ipc.taskSetParked).mockResolvedValueOnce(real);

    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    await vi.waitFor(() => expect(parkedAt("ws1")).toBe(real));
    expect(reason("ws1")).toBe("waiting on the API key");
  });

  it("leaves state identity alone when the stamp comes back unchanged", async () => {
    useApp.getState().setTaskParked("ws1", true);
    const stamp = parkedAt("ws1")!;
    vi.mocked(ipc.taskSetParked).mockClear();
    // The steady case: Rust echoes what the optimistic write already had.
    vi.mocked(ipc.taskSetParked).mockResolvedValueOnce(stamp);
    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    const before = useApp.getState();

    await vi.waitFor(() => expect(ipc.taskSetParked).toHaveBeenCalled());
    await Promise.resolve();

    expect(useApp.getState()).toBe(before);
    expect(useApp.getState().tasks).toBe(before.tasks);
  });

  it("does not re-park a task a prompt un-parked while the write was in flight", async () => {
    // markStarted clears the park, and the reply landing afterwards must not
    // put it back: the prompt is newer evidence than the click.
    const real = "2026-02-02T03:04:05.000Z";
    vi.mocked(ipc.taskSetParked).mockResolvedValueOnce(real);

    useApp.getState().setTaskParked("ws1", true, "waiting on the API key");
    useApp.getState().markStarted("ws1");
    expect(parkedAt("ws1")).toBeNull();

    await vi.waitFor(() => expect(ipc.taskSetParked).toHaveBeenCalled());
    await Promise.resolve();

    expect(parkedAt("ws1")).toBeNull();
    expect(reason("ws1")).toBeNull();
  });

  it("drops the answer for a task that is gone by the time it lands", async () => {
    vi.mocked(ipc.taskSetParked).mockResolvedValueOnce("2026-02-02T03:04:05.000Z");

    useApp.getState().setTaskParked("ws1", true);
    useApp.setState({ tasks: [] });
    await vi.waitFor(() => expect(ipc.taskSetParked).toHaveBeenCalled());
    await Promise.resolve();

    expect(useApp.getState().tasks).toEqual([]);
  });

  it("is a no-op for an id that resolves to no task", () => {
    const before = useApp.getState();

    useApp.getState().setTaskParked("nope", true, "waiting on the API key");

    expect(useApp.getState().tasks).toBe(before.tasks);
    expect(ipc.taskSetParked).not.toHaveBeenCalled();
  });

  it("survives a rejected write without throwing, keeping the in-memory park", async () => {
    vi.mocked(ipc.taskSetParked).mockRejectedValueOnce(new Error("disk full"));

    expect(() => useApp.getState().setTaskParked("ws1", true)).not.toThrow();
    await vi.waitFor(() => expect(ipc.taskSetParked).toHaveBeenCalled());
    expect(parkedAt("ws1")).toBeTruthy();
  });
});
