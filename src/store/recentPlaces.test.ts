// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same mocks as app.test.ts — importing the store pulls in the ipc layer.
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  // `setActiveTask` stamps `last_opened_at` through this, so every file that
  // mocks the ipc module and drives an activation needs it present.
  taskTouch: vi.fn().mockResolvedValue(null),
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useApp } from "@/store/app";
import {
  useRecentPlaces,
  suspendRecording,
  resumeRecording,
  pushPlace,
  samePlace,
  PLACES_CAP,
  type Place,
} from "@/store/recentPlaces";
import { currentPlace, installRecentPlacesTracker, livePlaces } from "@/lib/recentPlacesTracker";
import { makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";

const p = (taskId: string, tabId: string): Place => ({ taskId, tabId });

/** Let the tracker's coalescing microtask run. */
const settle = () => Promise.resolve();

describe("the places list", () => {
  it("puts the newest first", () => {
    expect(pushPlace([], p("A", "1"))).toEqual([p("A", "1")]);
    expect(pushPlace([p("A", "1")], p("B", "1"))).toEqual([p("B", "1"), p("A", "1")]);
  });

  it("moves a revisit up instead of duplicating it", () => {
    const list = [p("C", "1"), p("B", "1"), p("A", "1")];
    expect(pushPlace(list, p("A", "1"))).toEqual([p("A", "1"), p("C", "1"), p("B", "1")]);
  });

  it("returns the list unchanged when it is already the head", () => {
    // Identity, not just equality: the store leans on this to skip a write.
    const list = [p("A", "1"), p("B", "1")];
    expect(pushPlace(list, p("A", "1"))).toBe(list);
  });

  it("keeps at most PLACES_CAP entries", () => {
    let list: Place[] = [];
    for (let i = 0; i < PLACES_CAP + 5; i++) list = pushPlace(list, p("t", String(i)));
    expect(list).toHaveLength(PLACES_CAP);
    expect(list[0]).toEqual(p("t", String(PLACES_CAP + 4)));
  });

  it("tells two tabs of one task apart", () => {
    // A place is the PAIR. Comparing on task alone would collapse a task's
    // tabs into one entry and make ⌃⇥ useless inside a task.
    expect(samePlace(p("A", "1"), p("A", "2"))).toBe(false);
    expect(pushPlace([p("A", "1")], p("A", "2"))).toHaveLength(2);
  });
});

describe("pruning", () => {
  beforeEach(() => useRecentPlaces.getState().reset());

  it("drops places belonging to tasks that are gone", () => {
    useRecentPlaces.getState().push(p("A", "1"));
    useRecentPlaces.getState().push(p("B", "1"));
    useRecentPlaces.getState().pruneTo(["B"]);
    expect(useRecentPlaces.getState().places).toEqual([p("B", "1")]);
  });

  it("does not write when nothing is pruned", () => {
    useRecentPlaces.getState().push(p("A", "1"));
    const before = useRecentPlaces.getState().places;
    useRecentPlaces.getState().pruneTo(["A"]);
    expect(useRecentPlaces.getState().places).toBe(before);
  });
});

describe("recording what is on screen", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    resetAppStore();
    useRecentPlaces.getState().reset();
    resumeRecording();
    stop = installRecentPlacesTracker();
  });
  afterEach(() => { stop?.(); stop = null; resumeRecording(); });

  const seed = (taskId: string, tabId: string) => {
    useApp.setState(s => ({ tasks: [...s.tasks, makeTask({ id: taskId })] }));
    seedTab(taskId, makeTerminalTab({ id: tabId }));
  };

  it("records a place once a task and tab are selected", async () => {
    seed("A", "a1");
    useApp.getState().setActiveTask("A");
    await settle();
    expect(useRecentPlaces.getState().places).toEqual([p("A", "a1")]);
  });

  it("coalesces a task+tab selection into ONE entry", async () => {
    // The sidebar, ⌥↑/↓ and ⇧⌘A all call setActiveTask then setActiveTabId.
    // Recording each write separately would file (B, its old tab) as a place
    // the user never looked at, leaving the ring [B/2, B/1, A/a1] — so the
    // next ⌃⇥ would go to B/1 rather than back to A.
    seed("A", "a1");
    seed("B", "b1");
    seedTab("B", makeTerminalTab({ id: "b2" }));
    useApp.getState().setActiveTabId("B", "b1");   // B's strip sits on b1
    useApp.getState().setActiveTask("A");
    await settle();

    useApp.getState().setActiveTask("B");
    useApp.getState().setActiveTabId("B", "b2");
    await settle();

    expect(useRecentPlaces.getState().places).toEqual([p("B", "b2"), p("A", "a1")]);
  });

  it("records nothing while a walk is in flight", async () => {
    // Every step of a ⌃⇥ walk moves the pointers, and recording each one would
    // reorder the ring under the very next keypress.
    seed("A", "a1");
    seed("B", "b1");
    seed("C", "c1");
    useApp.getState().setActiveTask("A");
    await settle();

    suspendRecording();
    useApp.getState().setActiveTask("B");
    useApp.getState().setActiveTask("C");
    await settle();
    expect(useRecentPlaces.getState().places).toEqual([p("A", "a1")]);

    // Landing is recorded explicitly by the gesture, not by the tracker: after
    // a walk the pointers ALREADY hold the destination, so a setter call at
    // commit time need not change them and the subscription need not fire.
    useRecentPlaces.getState().push(p("C", "c1"));
    resumeRecording();
    expect(useRecentPlaces.getState().places).toEqual([p("C", "c1"), p("A", "a1")]);
  });

  it("ignores split-pane tabs", async () => {
    // `activeTab[taskId]` is the MAIN pane's pointer; a pane tab there would
    // leave the main strip rendering nothing.
    seed("A", "a1");
    seedTab("A", makeTerminalTab({ id: "pane1", paneId: "leaf-2" }));
    useApp.getState().setActiveTask("A");
    await settle();
    expect(currentPlace()).toBeNull();
    expect(useRecentPlaces.getState().places).toEqual([]);
  });

  it("offers only places that can be reached without starting anything", async () => {
    // The load-bearing half is `mountedTasks`, and it is the easy one to leave
    // out: `stopTask` kills a task's PTYs and evicts it from that set but KEEPS
    // the task and its tabs, so a "does this tab still exist?" filter passes
    // and ⌃⇥ would respawn an agent the user explicitly stopped.
    seed("A", "a1");
    seed("B", "b1");
    useApp.getState().setActiveTask("A");
    await settle();
    useApp.getState().setActiveTask("B");
    await settle();
    expect(livePlaces().map(p => p.taskId)).toEqual(["B", "A"]);

    useApp.getState().stopTask("A");
    expect(useApp.getState().tabs["A"]).toBeDefined();   // the task is still there
    expect(livePlaces().map(p => p.taskId)).toEqual(["B"]);
  });

  it("does not offer an archived task, before loadAll has pruned it", async () => {
    seed("A", "a1");
    seed("B", "b1");
    useApp.getState().setActiveTask("A");
    await settle();
    useApp.getState().setActiveTask("B");
    await settle();

    useApp.setState(s => ({
      tasks: s.tasks.map(t => (t.id === "A" ? { ...t, archived: true } : t)),
    }));
    expect(livePlaces().map(p => p.taskId)).toEqual(["B"]);
  });

  it("records nothing from the dashboard, where no task is active", async () => {
    useApp.getState().setActiveTask(null);
    await settle();
    expect(currentPlace()).toBeNull();
    expect(useRecentPlaces.getState().places).toEqual([]);
  });
});
