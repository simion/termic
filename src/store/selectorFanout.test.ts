// @vitest-environment happy-dom
//
// Selector fan-out budget (performance.md bear trap 5).
//
// The rule this guards: tight Zustand selectors, and frozen EMPTY constants
// for the absent case, so an unrelated write does not invalidate every
// subscriber. The regression it exists to catch is someone selecting a whole
// slice (or building a fresh array/object inside a selector), which turns one
// sidebar-drag frame into a re-render of every mounted tab bar.
//
// Why this shape rather than a wall-clock benchmark: the count is
// machine-independent, so it can gate a PR on a 3-core CI VM. Timings cannot.
// See docs/perf-ci.md for the full argument. The one time assertion
// here is a loose backstop with orders of magnitude of headroom, not a budget.
//
// This models `useSyncExternalStore` exactly: on every store notification each
// mounted subscriber re-runs its selector, and re-renders if and only if the
// new snapshot differs from the old one by Object.is.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocks as app.test.ts — importing the store pulls in the ipc layer.
vi.mock("@/lib/ipc", () => ({
  // Every task activation stamps `last_opened_at` through these; a mock
  // missing them throws on property access, not on call.
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
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

import { useApp, selectTaskTabs, selectActiveTabId, EMPTY_TABS } from "@/store/app";
import { useAgentUsage, usageKey } from "@/store/agentUsage";
import type { AppState } from "@/store/app";
import type { Tab } from "@/lib/types";

/** Mounted subscribers to simulate. A busy window is a handful of panes, not
 *  2500 — but the budget should hold with two orders of magnitude of slack. */
const SUBSCRIBERS = 500;
/** Unrelated writes. A sidebar drag at 120 Hz for ~8 seconds. */
const WRITES = 1000;
/** Loose wall-clock backstop. Not a perf budget: purely a tripwire for
 *  accidentally quadratic selector work. Real value on a dev box is ~0.001. */
const MAX_MS_PER_WRITE = 2;

interface FanoutResult {
  selectorRuns: number;
  invalidations: number;
  msPerWrite: number;
}

/** Run `write` `times` times with `subs` selectors mounted, counting how often
 *  each selector ran and how often its snapshot actually changed identity. */
function measureFanout(
  subs: ((s: AppState) => unknown)[],
  times: number,
  write: (i: number) => void,
): FanoutResult {
  let selectorRuns = 0;
  let invalidations = 0;

  const snapshots = subs.map(sel => sel(useApp.getState()));
  const unsub = useApp.subscribe(() => {
    for (let i = 0; i < subs.length; i++) {
      selectorRuns++;
      const next = subs[i](useApp.getState());
      if (!Object.is(next, snapshots[i])) {
        invalidations++;
        snapshots[i] = next;
      }
    }
  });

  const t0 = performance.now();
  for (let i = 0; i < times; i++) write(i);
  const elapsed = performance.now() - t0;
  unsub();

  return { selectorRuns, invalidations, msPerWrite: elapsed / times };
}

function tab(id: string): Tab {
  return { id, type: "terminal", title: id, cli: "claude" } as Tab;
}

describe("selector fan-out budget (bear trap 5)", () => {
  beforeEach(() => {
    useApp.setState({ tabs: {}, activeTab: {}, sidebarWidth: 260 });
  });

  it("a sidebar drag invalidates no tab selector", () => {
    // The hot path: `setSidebarWidth` fires once per pointer-move while the
    // user drags the sidebar edge. Every mounted tab bar has a `useTaskTabs`
    // subscription. None of them may re-render.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));

    expect(r.invalidations).toBe(0);
    // Sanity: the harness really did exercise every selector on every write.
    // Without this, `invalidations === 0` could pass vacuously.
    expect(r.selectorRuns).toBe(SUBSCRIBERS * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("detects fan-out when a selector is not tight (positive control)", () => {
    // Proves the harness can fail. A selector that reads the whole `tabs`
    // record is stable here, but one that derives a fresh array is not — this
    // is precisely the mistake bear trap 5 describes.
    useApp.setState({ tabs: { a: [tab("a-1")] } });
    const loose = [(s: AppState) => Object.keys(s.tabs).map(k => k)];

    const r = measureFanout(loose, 10, i =>
      useApp.getState().setSidebarWidth(200 + i));

    expect(r.invalidations).toBe(10);
  });

  it("a write to one task invalidates only that task's selector", () => {
    const ids = ["a", "b", "c"];
    useApp.setState({ tabs: Object.fromEntries(ids.map(id => [id, [tab(`${id}-1`)]])) });
    const subs = ids.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b: [tab("b-1"), tab("b-2")] } });
    });

    expect(r.invalidations).toBe(1);
  });

  it("absent tasks share one frozen EMPTY_TABS reference", () => {
    // This is what keeps `invalidations` at 0 for a task with no tabs yet.
    // A `?? []` here would allocate per call and re-render every frame.
    const s = useApp.getState();
    expect(selectTaskTabs("nope")(s)).toBe(EMPTY_TABS);
    expect(selectTaskTabs("nope")(s)).toBe(selectTaskTabs("other")(s));
    expect(selectTaskTabs(null)(s)).toBe(EMPTY_TABS);
    expect(Object.isFrozen(EMPTY_TABS)).toBe(true);
  });

  // ── Subscription usage (GH #277) ───────────────────────────────────
  //
  // The usage feed is the newest thing on a hot path: claude's status line
  // reports on every turn, on every running task at once. Two invariants keep
  // that from becoming a per-turn re-render of the whole window, and both are
  // counts, so they survive a 3-core CI runner.

  it("a usage report invalidates NO useApp selector", () => {
    // The design decision this pins: usage lives in its OWN store, not in
    // useApp's ~233-key state. Putting it there would mean every status line
    // report copies that whole object and re-runs every mounted tab bar's
    // selector, which is bear trap 8 arriving once per turn per task.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({ tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])) });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i =>
      useAgentUsage.getState().report(
        "claude", null, { session: { usedPercent: i % 100, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline"));

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(0);
  });

  it("a usage report reaches only the footers on that agent", () => {
    useAgentUsage.setState({ byAgent: {} });
    // A window of tasks split across two accounts: a claude clone holding a
    // second login must not re-render when the first one's quota moves.
    const agents = Array.from({ length: SUBSCRIBERS }, (_, i) =>
      i % 2 === 0 ? "claude" : "next-claude");

    let runs = 0, invalidations = 0;
    const snap = agents.map(a => useAgentUsage.getState().byAgent[usageKey(a, null)]);
    const unsub = useAgentUsage.subscribe(() => {
      for (let i = 0; i < agents.length; i++) {
        runs++;
        const next = useAgentUsage.getState().byAgent[usageKey(agents[i], null)];
        if (!Object.is(next, snap[i])) { invalidations++; snap[i] = next; }
      }
    });

    useAgentUsage.getState().report(
      "claude", null, { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(invalidations).toBe(SUBSCRIBERS / 2);

    // The same reading again. Most turns move a percentage by nothing, so this
    // is the COMMON case, and it must cost zero notifications: the bail in
    // `report` means no subscriber is even woken.
    const runsAfterFirst = runs;
    useAgentUsage.getState().report(
      "claude", null, { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(runs).toBe(runsAfterFirst);
    expect(invalidations).toBe(SUBSCRIBERS / 2);

    unsub();
  });

  it("an account pill only re-renders for its OWN agent's accounts", () => {
    // The pill BUILDS an object (one entry per account of its agent), so it is
    // the one usage subscriber that cannot be Object.is-stable by construction
    // and needs `useShallow`. Without it every pill in the window re-renders on
    // every status-line report from any agent, once per turn per task, which
    // is bear trap 8 on the hottest path there is.
    useAgentUsage.setState({ byAgent: {} });
    const agents = Array.from({ length: SUBSCRIBERS }, (_, i) =>
      i % 2 === 0 ? "claude" : "next-claude");
    const ACCOUNTS = ["Work", "Personal"];

    // What the pill's selector produces, compared the way useShallow compares.
    const build = (agent: string) =>
      Object.fromEntries(ACCOUNTS.map(n =>
        [n, useAgentUsage.getState().byAgent[usageKey(agent, n)]]));
    const shallowEq = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      Object.keys(a).length === Object.keys(b).length
      && Object.keys(a).every(k => Object.is(a[k], b[k]));

    let invalidations = 0;
    const snap = agents.map(build);
    const unsub = useAgentUsage.subscribe(() => {
      for (let i = 0; i < agents.length; i++) {
        const next = build(agents[i]);
        if (!shallowEq(next, snap[i])) { invalidations++; snap[i] = next; }
      }
    });

    useAgentUsage.getState().report(
      "claude", "Work", { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    // Only the claude pills, and only because one of THEIR accounts moved.
    expect(invalidations).toBe(SUBSCRIBERS / 2);

    // An account of the OTHER agent: the claude pills must not move again.
    useAgentUsage.getState().report(
      "next-claude", "Work", { session: { usedPercent: 5, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(invalidations).toBe(SUBSCRIBERS);

    // An account NOBODY's pill lists: no pill re-renders at all.
    const before = invalidations;
    useAgentUsage.getState().report(
      "claude", "Client", { session: { usedPercent: 9, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(invalidations).toBe(before);

    unsub();
  });

  it("activeTab selectors are undefined-stable for unknown tasks", () => {
    // `undefined` is Object.is-stable, so an unknown task never invalidates.
    const subs = Array.from({ length: 50 }, (_, i) => selectActiveTabId(`ghost-${i}`));
    const r = measureFanout(subs, 100, i =>
      useApp.getState().setSidebarWidth(200 + (i % 60)));
    expect(r.invalidations).toBe(0);
  });

  it("a ⌃⇥ walk step invalidates no tab-strip selector", () => {
    // The walk is live: every tap of Tab swaps what is on screen, so its cost
    // is paid while the user is holding a key down. `previewPlace` writes only
    // the pointers that decide what is visible, which is why it exists —
    // `setActiveTabId` rebuilds `tabs[taskId]` through .map() on every call and
    // hands back a fresh array even when no flag changed, so every mounted tab
    // bar in the window would re-render on each step.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`), tab(`${id}-b`)]])),
      activeTab: Object.fromEntries(seeded.map(id => [id, `${id}-a`])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, WRITES, i => {
      const id = seeded[i % SUBSCRIBERS];
      useApp.getState().previewPlace(id, `${id}-${i % 2 ? "a" : "b"}`);
    });

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(SUBSCRIBERS * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("the real setter DOES invalidate them (control for the step above)", () => {
    // Without this, the assertion above could pass because the walk never
    // wrote anything at all. This is the cost `previewPlace` avoids, measured
    // on the very same subscribers.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({
      tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`), tab(`${id}-b`)]])),
      activeTab: Object.fromEntries(seeded.map(id => [id, `${id}-a`])),
    });
    const subs = seeded.map(id => selectTaskTabs(id));

    const r = measureFanout(subs, 10, i => {
      const id = seeded[i % SUBSCRIBERS];
      useApp.getState().setActiveTabId(id, `${id}-${i % 2 ? "a" : "b"}`);
    });

    expect(r.invalidations).toBe(10);
  });

  it("one walk step is one notification", () => {
    // `setActiveTask` alone does three writes in a row (the departing tab's
    // timestamps, the main set, then the unread-clearing set). A walk that
    // went through it would pay all three per tap, and this count is what
    // fails if someone later folds previewPlace back into it.
    useApp.setState({
      tabs: { a: [tab("a1")], b: [tab("b1")] },
      activeTab: { a: "a1", b: "b1" },
      activeTaskId: "a",
    });
    let notifications = 0;
    const unsub = useApp.subscribe(() => { notifications++; });
    useApp.getState().previewPlace("b", "b1");
    useApp.getState().previewPlace("a", "a1");
    unsub();
    expect(notifications).toBe(2);
  });
});
