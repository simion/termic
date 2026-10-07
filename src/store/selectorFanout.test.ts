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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import { useApp, selectTaskTabs, selectActiveTabId, EMPTY_TABS } from "@/store/app";
import { useAgentUsage, usageKey } from "@/store/agentUsage";
import {
  createSidebarFactsSelector, createRowTabsSelector, tabRenderEqual, tabListRenderEqual,
  createStatusFactsSelector, createBoardFilterFactsSelector, selectStatusRowBadge, selectStatusRowDelegated,
  selectStatusRowTabCount, selectStatusRowActiveChild, selectStatusGroupMarks,
} from "@/store/sidebarTabs";
import { parseBoardQuery } from "@/lib/boardFilter";
import { taskQueryNeeds } from "@/hooks/useTaskQuery";
import type { AppState } from "@/store/app";
import type { Tab, Task, TerminalTab } from "@/lib/types";

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
  /** Invalidations per subscriber, in the order they were passed. */
  perSub: number[];
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
  const perSub = subs.map(() => 0);

  const snapshots = subs.map(sel => sel(useApp.getState()));
  const unsub = useApp.subscribe(() => {
    for (let i = 0; i < subs.length; i++) {
      selectorRuns++;
      const next = subs[i](useApp.getState());
      if (!Object.is(next, snapshots[i])) {
        invalidations++;
        perSub[i]++;
        snapshots[i] = next;
      }
    }
  });

  const t0 = performance.now();
  for (let i = 0; i < times; i++) write(i);
  const elapsed = performance.now() - t0;
  unsub();

  return { selectorRuns, invalidations, perSub, msPerWrite: elapsed / times };
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

  it("a config-sync pull that changed nothing notifies nobody (bear trap 8)", () => {
    // Config sync (src/lib/configSync.ts) reloads the stores from storage
    // after every pull, including the common one that brought nothing. The
    // folder colors live in this store, so a reload that publishes an equal
    // value would re-run every mounted selector here on every sync.
    const seeded = Array.from({ length: SUBSCRIBERS }, (_, i) => `task-${i}`);
    useApp.setState({ tabs: Object.fromEntries(seeded.map(id => [id, [tab(`${id}-a`)]])) });
    const subs = seeded.map(id => selectTaskTabs(id));
    const r = measureFanout(subs, WRITES, () => useApp.getState().reloadGroupColors());
    expect(r.selectorRuns).toBe(0);
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

  // ── Board view column key (GH #318) ────────────────────────────────
  //
  // The board's columns come from useTaskQuery's column map over per-task
  // status facts (`createStatusFactsSelector`), the same record the sidebar's
  // status chips hold. These three cases pin it for the board's shape:
  // unrelated writes cost nothing, tab writes that move no badge cost
  // nothing, and a real column change costs exactly one invalidation.

  const boardTask = (id: string): Task => ({
    id, project_id: "p1", name: id, branch: id, base_branch: "main",
    path: "/tmp/x", cli: "claude", port: 0, created: "2026-09-01T00:00:00Z",
    archived: false,
  } as Task);

  it("the board's column key ignores unrelated writes", () => {
    useApp.setState({
      tasks: [boardTask("b1"), boardTask("b2")],
      tabs: { b1: [tab("b1-t")], b2: [tab("b2-t")] },
    });
    const subs = [createStatusFactsSelector()];

    const r = measureFanout(subs, WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));

    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(WRITES);
  });

  it("the board's column key ignores tab writes that move no badge", () => {
    useApp.setState({
      tasks: [boardTask("b1")],
      tabs: { b1: [tab("b1-t")] },
    });
    const subs = [createStatusFactsSelector()];

    // A title churn (the per-keystroke case: liveTitle updates land here)
    // changes the tab object but not the work facts, so the record keeps its
    // identity and the board does not re-render.
    const r = measureFanout(subs, 100, i => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b1: [{ ...tab("b1-t"), title: `t${i}` }] } });
    });

    expect(r.invalidations).toBe(0);
  });

  it("the board's column key fires exactly once on a real column change", () => {
    useApp.setState({
      tasks: [boardTask("b1")],
      tabs: { b1: [tab("b1-t")] },
    });
    const subs = [createStatusFactsSelector()];

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      // The cast narrows past the Tab union: workState exists only on
      // terminal tabs, and a spread over the union fails to compile.
      useApp.setState({ tabs: { ...s.tabs, b1: [{ ...(tab("b1-t") as TerminalTab), workState: "working" }] } });
    });

    expect(r.invalidations).toBe(1);
  });

  // ── Kanban filter bar facts ────────────────────────────────────────
  //
  // While a free-text query is typed, BoardView holds the filter facts
  // record. It must not move while agents stream or flip state, or the
  // whole board re-renders per OSC title and per working/idle flip for no
  // change in what the query matches. Only a STABLE title or a property
  // value moves it.

  it("the board's filter facts ignore live titles and work-state flips", () => {
    useApp.setState({ tabs: { b1: [tab("b1-t")] } });
    const subs = [createBoardFilterFactsSelector()];

    const r = measureFanout(subs, 100, i => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b1: [{
        ...(tab("b1-t") as TerminalTab),
        liveTitle: `thinking ${i}`,
        workState: i % 2 ? "done" : "idle",
      }] } });
    });

    expect(r.invalidations).toBe(0);
  });

  it("the board's filter facts fire once on a tab rename", () => {
    useApp.setState({ tabs: { b1: [tab("b1-t")] } });
    const subs = [createBoardFilterFactsSelector()];

    const r = measureFanout(subs, 1, () => {
      const s = useApp.getState();
      useApp.setState({ tabs: { ...s.tabs, b1: [{ ...tab("b1-t"), title: "Reviewer" }] } });
    });

    expect(r.invalidations).toBe(1);
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

// ── The sidebar while agents stream ────────────────────────────────────
//
// A WebContent profile of 16 tasks with 10 live claude PTYs had the main
// thread ~12% busy, most of it React renders driven by store writes, with
// object spreads as the hot leaves. The writes were `lastOutputAt` stamps:
// bear trap 9 bounds their RATE (one per 500 ms per streaming terminal), but
// the sidebar selected the whole `tabs` map, so each one re-rendered the
// sidebar and, with its rows unmemoized, every row in it. These counts pin
// the FAN-OUT: a stamp reaches no sidebar subscriber at all, and a write the
// sidebar does draw reaches exactly the subscribers that draw it.

describe("sidebar under streaming output (bear traps 5, 8)", () => {
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `task-${i}`);
  const main = (id: string) => `${id}-main`;

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** What the mounted sidebar subscribes with: one facts selector for the
   *  body, one tabs selector per row. */
  const mountSidebar = () => [
    createSidebarFactsSelector(),
    ...ids.map(id => createRowTabsSelector(id)),
  ];

  const stamp = (i: number) => {
    const id = ids[i % TASKS];
    useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
  };

  it("an output stamp invalidates neither the sidebar body nor any row", () => {
    const subs = mountSidebar();
    const r = measureFanout(subs, WRITES, stamp);

    expect(r.invalidations).toBe(0);
    // Not vacuous: every write notified, and every subscriber re-ran.
    expect(r.selectorRuns).toBe(subs.length * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("the subscriptions this replaced fail the same count (positive control)", () => {
    // The body used to select `s.tabs`, and each row `selectTaskTabs(id)`.
    const r = measureFanout(
      [(s: AppState) => s.tabs, ...ids.map(id => selectTaskTabs(id))], WRITES, stamp);

    expect(r.perSub[0]).toBe(WRITES);
    // Each row re-rendered for its own task's stamps, i.e. once per write.
    expect(r.perSub.slice(1).reduce((a, b) => a + b, 0)).toBe(WRITES);
    expect(r.perSub.slice(1).every(n => n > 0)).toBe(true);
  });

  it("a sidebar drag invalidates neither", () => {
    const r = measureFanout(mountSidebar(), WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));
    expect(r.invalidations).toBe(0);
  });

  // No false negatives: each write below changes something the sidebar
  // draws, so it must still get through, to exactly the subscribers that
  // draw it. perSub[0] is the body; perSub[1 + n] is row n.
  const OWNER = 3;
  const expectReached = (r: FanoutResult, body: number) => {
    expect(r.perSub[0]).toBe(body);
    expect(r.perSub.slice(1)).toEqual(ids.map((_, i) => (i === OWNER ? 1 : 0)));
  };
  const owner = ids[OWNER];

  it("an agent's live title reaches its row and not the body", () => {
    // The case a whole-map "ignore the timestamps" comparator gets wrong:
    // agents rewrite their title about once a second while they work, and
    // the body draws none of it.
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().setTabLiveTitle(owner, main(owner), "thinking")), 0);
  });

  it("a finished turn reaches the body (rollup dot, bell count) and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "done" })), 1);
  });

  it("an agent blocked on the user reaches the body and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().markAttention(owner, main(owner), "attention")), 1);
  });

  it("a tab rename reaches the body (the filter matches it) and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().renameTab(owner, `${owner}-shell`, "Reviewer")), 1);
  });

  it("a main agent exiting reaches the body (broadcast count) and its row", () => {
    expectReached(measureFanout(mountSidebar(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { ptyId: undefined })), 1);
  });

  it("a row held across stamps still shows the next visible change", () => {
    // The row keeps its PREVIOUS array while only hidden fields move, so
    // what it hands back after a stamp must not mask what comes next.
    const sel = createRowTabsSelector(owner);
    const before = sel(useApp.getState());
    stamp(OWNER);
    expect(sel(useApp.getState())).toBe(before);
    useApp.getState().patchTab(owner, main(owner), { workState: "done" });
    const after = sel(useApp.getState());
    expect(after).not.toBe(before);
    expect((after[0] as TerminalTab).workState).toBe("done");
    // And it carries the real timestamp again, not the held one.
    expect((after[0] as TerminalTab).lastOutputAt).toBe(1_000 + OWNER);
  });

  it("a task's tabs loading or going away reaches the body", () => {
    const facts = createSidebarFactsSelector();
    const before = facts(useApp.getState());
    expect(before["late"]).toBeUndefined();
    useApp.setState({ tabs: { ...useApp.getState().tabs, late: [tab("late-1")] } });
    const loaded = facts(useApp.getState());
    expect(loaded).not.toBe(before);
    expect(loaded["late"]).toBeDefined();
    // Untouched tasks keep their facts object, so nothing reading them moves.
    expect(loaded[owner]).toBe(before[owner]);
    const { late: _, ...rest } = useApp.getState().tabs;
    useApp.setState({ tabs: rest });
    expect(facts(useApp.getState())["late"]).toBeUndefined();
  });

  it("the Sidebar body does not select the tabs map", () => {
    // The counts above measure the selectors; this pins that the Sidebar
    // still USES them. `useApp(s => s.tabs)` is the exact line that caused
    // the fan-out, and a row selector reading one task's entry is fine.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(src).not.toMatch(/=>\s*s\.tabs\s*\)/);
    expect(src).toMatch(/useSidebarTabFacts\(\)/);
    expect(src).toMatch(/useRowTabs\(w\.id\)/);
  });
});

describe("tab render equality (sidebar rows)", () => {
  const base = { ...tab("t"), ptyId: "p", lastOutputAt: 1 } as Tab;

  it("ignores only the timestamps no row draws", () => {
    expect(tabRenderEqual(base, { ...base, lastOutputAt: 2 } as Tab)).toBe(true);
    expect(tabRenderEqual(base, { ...base, lastInputAt: 5, firstOutputAt: 6 } as Tab)).toBe(true);
    expect(tabRenderEqual(base, { ...base, title: "other" } as Tab)).toBe(false);
    expect(tabRenderEqual(base, { ...base, liveTitle: "x" } as Tab)).toBe(false);
    expect(tabRenderEqual(base, { ...base, ptyId: undefined } as Tab)).toBe(false);
  });

  it("reads an absent key and an undefined one the same, as they render", () => {
    expect(tabRenderEqual(base, { ...base, workState: undefined } as Tab)).toBe(true);
    expect(tabRenderEqual(base, { ...base, workState: "idle" } as Tab)).toBe(false);
  });

  it("compares lists by position", () => {
    const a = tab("a"), b = tab("b");
    expect(tabListRenderEqual([a, b], [a, b])).toBe(true);
    expect(tabListRenderEqual([a, b], [b, a])).toBe(false);
    expect(tabListRenderEqual([a, b], [a])).toBe(false);
  });
});

// ── The status section while agents stream ─────────────────────────────
//
// The section lists tasks by board column, and one of the facts behind a
// column (`untouched`) reads `lastInputAt`, a field the tree's rows hold back.
// So it keeps a facts record of its own, and these counts pin what that buys:
// timestamps and titles reach nothing, a real column change reaches the
// section, and the Sidebar BODY never pays for the section's facts.

describe("status section under streaming output (bear traps 5, 8)", () => {
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `st-${i}`);
  const main = (id: string) => `${id}-main`;
  const PREFS = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
  const OWNER = 5;
  const owner = ids[OWNER];

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** The mounted section, rows collapsed: one facts selector, and per row
   *  its badge, its delegated-work report, its tab count and whether a child
   *  carries the selection. perSub[0] is the facts record. */
  const mountSection = () => [
    createStatusFactsSelector(),
    ...ids.map(id => selectStatusRowBadge(id, PREFS)),
    ...ids.map(id => selectStatusRowDelegated(id, PREFS)),
    ...ids.map(id => selectStatusRowTabCount(id)),
    ...ids.map(id => selectStatusRowActiveChild(id)),
    // A folded group of four of them: its caption's marks.
    selectStatusGroupMarks(ids.slice(4, 8), PREFS, true),
  ];

  const stamp = (i: number) => {
    const id = ids[i % TASKS];
    useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
  };

  it("an output stamp invalidates neither the section nor any row", () => {
    const subs = mountSection();
    const r = measureFanout(subs, WRITES, stamp);
    expect(r.invalidations).toBe(0);
    expect(r.selectorRuns).toBe(subs.length * WRITES);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("a live title, which the tree's row DOES draw, reaches nothing here", () => {
    const r = measureFanout(mountSection(), 100, i =>
      useApp.getState().setTabLiveTitle(owner, main(owner), `thinking ${i}`));
    expect(r.invalidations).toBe(0);
  });

  it("a sidebar drag invalidates nothing", () => {
    const r = measureFanout(mountSection(), WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));
    expect(r.invalidations).toBe(0);
  });

  it("a task's FIRST input moves it out of Not started, and only the first", () => {
    // The fact useRowTabs cannot see: lastInputAt is in ROW_HIDDEN_TAB_FIELDS.
    const subs = mountSection();
    const first = measureFanout(subs, 1, () =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 2_000 }));
    expect(first.perSub[0]).toBe(1);
    expect(first.invalidations).toBe(1);
    const again = measureFanout(subs, 50, i =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 3_000 + i }));
    expect(again.invalidations).toBe(0);
  });

  it("an agent starting a turn reaches the section and its own badge, once", () => {
    const r = measureFanout(mountSection(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.perSub[0]).toBe(1);
    // Its badge (index 1 + OWNER) and nobody else's.
    expect(r.perSub.slice(1, 1 + TASKS)).toEqual(ids.map((_, i) => (i === OWNER ? 1 : 0)));
    // ...and the folded group it is a member of: the caption gains a mark.
    expect(r.perSub[r.perSub.length - 1]).toBe(1);
    expect(r.invalidations).toBe(3);
  });

  it("an agent starting a turn does NOT reach the Sidebar body", () => {
    // Why the section's facts are a record of their own: as fields on
    // SidebarTaskFacts, every idle -> working flip would re-render the whole
    // body, section on or off.
    const r = measureFanout([createSidebarFactsSelector()], 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.invalidations).toBe(0);
  });

  it("an agent blocked on the user reaches the section and its badge", () => {
    const r = measureFanout(mountSection(), 1, () =>
      useApp.getState().markAttention(owner, main(owner), "attention"));
    expect(r.perSub[0]).toBe(1);
    expect(r.perSub[1 + OWNER]).toBe(1);
  });

  it("StatusSection.tsx does not select the tabs map", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../components/sidebar/StatusSection.tsx"), "utf8");
    expect(src).not.toMatch(/=>\s*s\.tabs\s*\)/);
    expect(src).not.toMatch(/selectTaskTabs/);
    // A row's tabs are held only by an EXPANDED row's children, which draw
    // the titles; a collapsed row selects values.
    expect(src.match(/useRowTabs\(/g)?.length).toBe(1);
    const children = src.slice(src.indexOf("function StatusTaskTabs("));
    expect(children).toMatch(/useRowTabs\(taskId\)/);
    expect(src).toMatch(/useStatusTabFacts\(\)/);
    expect(src).toMatch(/selectStatusRowBadge\(/);
    // Mounted only with the pref on and never on the icon rail, so the off
    // state costs no subscription at all.
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/!compact && showStatusSection && <StatusSection[ />]/);
  });
});

// ── The status chips while agents stream ───────────────────────────────
//
// The chips count tasks by board column, and one of the facts behind a
// column (`untouched`) reads `lastInputAt`, a field the tree's rows hold back.
// So they keep a facts record of their own, and these counts pin what that
// buys: timestamps and titles reach nothing, a real column change reaches the
// chips, and the Sidebar BODY never pays for their facts.

describe("status chips under streaming output (bear traps 5, 8)", () => {
  const TASKS = 16;
  const ids = Array.from({ length: TASKS }, (_, i) => `st-${i}`);
  const main = (id: string) => `${id}-main`;
  const OWNER = 5;
  const owner = ids[OWNER];

  beforeEach(() => {
    useApp.setState({
      tabs: Object.fromEntries(ids.map(id => [id, [
        { ...tab(main(id)), is_default: true, ptyId: `pty-${id}` } as Tab,
        tab(`${id}-shell`),
      ]])),
    });
  });

  /** The mounted chips: one facts selector (inside useTaskQuery), and
   *  nothing per task. */
  const mountChips = () => [createStatusFactsSelector()];

  const stamp = (i: number) => {
    const id = ids[i % TASKS];
    useApp.getState().patchTab(id, main(id), { lastOutputAt: 1_000 + i });
  };

  it("an output stamp invalidates nothing", () => {
    const subs = mountChips();
    const r = measureFanout(subs, WRITES, stamp);
    expect(r.invalidations).toBe(0);
    expect(r.msPerWrite).toBeLessThan(MAX_MS_PER_WRITE);
  });

  it("a live title reaches nothing", () => {
    const r = measureFanout(mountChips(), 100, i =>
      useApp.getState().setTabLiveTitle(owner, main(owner), `thinking ${i}`));
    expect(r.invalidations).toBe(0);
  });

  it("a sidebar drag invalidates nothing", () => {
    const r = measureFanout(mountChips(), WRITES, i =>
      useApp.getState().setSidebarWidth(200 + (i % 120)));
    expect(r.invalidations).toBe(0);
  });

  it("a task's FIRST input moves its column, and only the first", () => {
    // The fact useRowTabs cannot see: lastInputAt is in ROW_HIDDEN_TAB_FIELDS.
    const subs = mountChips();
    const first = measureFanout(subs, 1, () =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 2_000 }));
    expect(first.invalidations).toBe(1);
    const again = measureFanout(subs, 50, i =>
      useApp.getState().patchTab(owner, main(owner), { lastInputAt: 3_000 + i }));
    expect(again.invalidations).toBe(0);
  });

  it("an agent starting a turn reaches the chips once", () => {
    const r = measureFanout(mountChips(), 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.invalidations).toBe(1);
  });

  it("an agent starting a turn does NOT reach the Sidebar body", () => {
    // Why the chips' facts are a record of their own: as fields on
    // SidebarTaskFacts, every idle -> working flip would re-render the body.
    const r = measureFanout([createSidebarFactsSelector()], 1, () =>
      useApp.getState().patchTab(owner, main(owner), { workState: "working" }));
    expect(r.invalidations).toBe(0);
  });

  it("an agent blocked on the user reaches the chips", () => {
    const r = measureFanout(mountChips(), 1, () =>
      useApp.getState().markAttention(owner, main(owner), "attention"));
    expect(r.invalidations).toBe(1);
  });

  it("StatusChips.tsx holds its own facts and never the tabs map", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../components/sidebar/StatusChips.tsx"), "utf8");
    expect(src).not.toMatch(/=>\s*s\.tabs\s*\)/);
    expect(src).not.toMatch(/selectTaskTabs|useRowTabs/);
    // its columns come from useTaskQuery, whose column facts are the record above
    expect(src).toMatch(/useTaskQuery\(\{[^}]*alwaysColumns: true/);
    const hook = readFileSync(resolve(here, "../hooks/useTaskQuery.tsx"), "utf8");
    expect(hook).toMatch(/useState\(createStatusFactsSelector\)/);
    // Its own memoized component, so a count moving re-renders the chips and
    // not the Sidebar body; never on the icon rail.
    expect(src).toMatch(/export const StatusChips = memo\(/);
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    // Never alongside the section, which lists the same buckets, and inside
    // the row that is itself gated off the icon rail.
    expect(sidebar).toMatch(/\{!compact && \(\s*<div[^>]*>\s*\{!showStatusSection && <StatusChips \/>\}/);
  });
});

describe("sidebar filter bar with no query (bear trap 5)", () => {
  // The Sidebar body calls useTaskQuery on every render, query or not. Each
  // subscription it adds must select a constant until the query (or the
  // open menu) reads it, or an empty bar would re-render the body on every
  // PR poll, diffstat and tab write. `taskQueryNeeds` is the gate every one
  // of those subscriptions goes through.
  const needs = (text: string, menuOpen = false, alwaysColumns = false) =>
    taskQueryNeeds(parseBoardQuery(text), menuOpen, alwaysColumns);

  it("an empty, closed bar needs nothing", () => {
    expect(needs("")).toEqual({
      filtering: false, watching: false, columns: false, pr: false, checks: false, changes: false, freeText: false,
    });
  });

  it("free text needs the PR trigger and text facts, and no columns", () => {
    expect(needs("login")).toMatchObject({ watching: true, pr: true, freeText: true, columns: false, changes: false });
  });

  it("columns only for `status:`, the open menu, or a caller that lays them out", () => {
    expect(needs("status:working").columns).toBe(true);
    expect(needs("project:web").columns).toBe(false);
    expect(needs("", true).columns).toBe(true);
    expect(needs("", false, true)).toMatchObject({ columns: true, pr: true, watching: false, changes: false });
  });

  it("checks and diffstats only while something reads them", () => {
    expect(needs("pr:open").checks).toBe(false);
    expect(needs("checks:failing").checks).toBe(true);
    expect(needs("has:changes").changes).toBe(true);
    expect(needs("", true)).toMatchObject({ checks: true, changes: true });
  });

  it("every subscription in the hook goes through the gate", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const hook = readFileSync(resolve(here, "../hooks/useTaskQuery.tsx"), "utf8");
    expect(hook).toMatch(/usePr\(s => needs\.pr\s*\?/);
    expect(hook).toMatch(/useDiffStat\(s => usesChanges\s*\?/);
    expect(hook).toMatch(/useApp\(needs\.columns \? selectStatusFacts : selectNoStatusFacts\)/);
    expect(hook).toMatch(/useApp\(!facts && needs\.freeText \? selectFilterFacts : selectNoFilterFacts\)/);
    // the sidebar reuses the tab facts its body already holds
    const sidebar = readFileSync(resolve(here, "../components/sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/facts: tabFacts/);
  });
});
