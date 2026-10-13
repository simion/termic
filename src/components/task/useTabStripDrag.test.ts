// @vitest-environment happy-dom
//
// The tab strip drag reorders LIVE through `reorderTab`, which never touches
// tab-subgroup membership (docs/ui.md "Tab subgroups"). So every way a
// started drag can end has to reach `onDropInStrip`, which settles it: a
// release in the strip, a pane/split drop the store refused, a cancelled
// pointer stream, and an unmount mid-drag. Missing one leaves the strip in
// the torn order the live reorder produced (a loose tab between two members)
// and syncDurableTabs persists it. These run the hook against the real store,
// wired the way TabBar wires it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetSplitLayout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/store/app";
import type { Tab, TabSubgroup, TerminalTab } from "@/lib/types";
import { getTabIds, getTabs, makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";
import { useTabStripDrag } from "./useTabStripDrag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A: TabSubgroup = { id: "A", name: "Alpha", color: "blue" };
const PILL_W = 100;
const groupsOf = () => getTabs("ws1").map(t => (t as TerminalTab).subgroup?.id ?? "-").join("");

let api: ReturnType<typeof useTabStripDrag> | null = null;
let strip: HTMLDivElement | null = null;

function Harness({ order }: { order: string[] }) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const all = useApp(s => s.tabs.ws1 ?? []) as Tab[];
  const stripTabs = all.filter(t => !t.paneId);
  api = useTabStripDrag({
    taskId: "ws1", stripRef, stripTabs, allTabs: all,
    reorderTab: useApp.getState().reorderTab,
    currentPaneId: null,
    onDropToPane: (tabId, toPaneId) => useApp.getState().moveTabToPane("ws1", tabId, toPaneId),
    onDropToSplit: (tabId, toPaneId, zone) => useApp.getState().moveTabToSplit("ws1", tabId, toPaneId, zone),
    onDropInStrip: (tabId) => useApp.getState().settleStripTabSubgroup("ws1", tabId),
  });
  // Pills at FIXED x slots by their seeded order: the hit test reads rects,
  // which happy-dom does not lay out, so each pill reports its slot.
  return createElement("div", {
    ref: (el: HTMLDivElement | null) => { stripRef.current = el; strip = el; },
  }, order.map(id => createElement("div", { key: id, "data-tab-id": id })));
}

let root: Root;
let host: HTMLElement;

function layout(order: string[]) {
  order.forEach((id, i) => {
    const el = strip!.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
    el.getBoundingClientRect = () => ({
      left: i * PILL_W, right: (i + 1) * PILL_W, width: PILL_W, top: 0, bottom: 20, height: 20, x: i * PILL_W, y: 0,
      toJSON() { return {}; },
    }) as DOMRect;
  });
}

function mount(order: string[]) {
  act(() => { root.render(createElement(Harness, { order })); });
  layout(order);
}

/** Press on `id`'s pill at its centre, then move so the dragged centre sits
 *  at `toX`: x lands before the first pill whose centre is past it. */
function dragTo(id: string, slot: number, toX: number) {
  const pill = strip!.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  const x0 = slot * PILL_W + PILL_W / 2;
  act(() => {
    api!.startDrag(id, {
      button: 0, target: pill, currentTarget: pill, clientX: x0, clientY: 10,
      preventDefault() {},
    } as unknown as React.PointerEvent);
  });
  act(() => {
    // happy-dom's offsetWidth is 0, so the dragged centre is clientX - grabOffset.
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: toX + PILL_W / 2, clientY: 10 }));
  });
}

beforeEach(() => {
  resetAppStore();
  useApp.setState({ splitTree: {}, activePaneId: {}, paneHistory: {}, collapsedTabSubgroups: {} });
  useApp.setState({ tasks: [makeTask({ id: "ws1" })] });
  for (const t of [{ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" }] as Partial<TerminalTab>[]) {
    seedTab("ws1", makeTerminalTab(t));
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mount(["a", "b", "x"]);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  api = null;
  strip = null;
});

describe("useTabStripDrag settles subgroup membership however the drag ends", () => {
  it("the live reorder alone tears the run (the state each case must repair)", () => {
    dragTo("x", 2, 80);
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
    expect(groupsOf()).toBe("A-A");
  });

  it("a release in the strip joins the run it landed inside", () => {
    dragTo("x", 2, 80);
    act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 130, clientY: 10 })); });
    expect(groupsOf()).toBe("AAA");
  });

  it("a cancelled pointer stream settles too", () => {
    dragTo("x", 2, 80);
    act(() => { window.dispatchEvent(new PointerEvent("pointercancel")); });
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
    expect(groupsOf()).toBe("AAA");
  });

  it("a pane drop the store refuses settles in the strip", () => {
    // A pane header under the cursor whose pane is not in any split tree:
    // moveTabToPane returns the state untouched, so x stays in the strip.
    const header = document.createElement("div");
    header.setAttribute("data-pane-header", "");
    header.setAttribute("data-pane-id", "gone");
    document.body.appendChild(header);
    const efp = vi.spyOn(document, "elementFromPoint").mockReturnValue(header);
    try {
      dragTo("x", 2, 80);
      act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 130, clientY: 10 })); });
    } finally {
      efp.mockRestore();
      header.remove();
    }
    expect(getTabs("ws1").find(t => t.id === "x")?.paneId).toBeUndefined();
    expect(groupsOf()).toBe("AAA");
  });

  it("a pane drop the store accepts moves the tab out and leaves the run whole", () => {
    useApp.getState().moveTabToSplit("ws1", "b", null, "right");
    const pane = getTabs("ws1").find(t => t.id === "b")!.paneId!;
    // b left A on the way out, so give the strip a second member to tear.
    useApp.getState().setTabSubgroup("ws1", "x", A);
    seedTab("ws1", makeTerminalTab({ id: "y" }));
    mount(["a", "x", "y"]);
    const header = document.createElement("div");
    header.setAttribute("data-pane-header", "");
    header.setAttribute("data-pane-id", pane);
    document.body.appendChild(header);
    const efp = vi.spyOn(document, "elementFromPoint").mockReturnValue(header);
    try {
      dragTo("y", 2, 80);
      act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 130, clientY: 10 })); });
    } finally {
      efp.mockRestore();
      header.remove();
    }
    expect(getTabs("ws1").find(t => t.id === "y")?.paneId).toBe(pane);
    const main = getTabs("ws1").filter(t => !t.paneId);
    expect(main.map(t => (t as TerminalTab).subgroup?.id ?? "-").join("")).toBe("AA");
  });

  it("an unmount mid-drag settles too", () => {
    dragTo("x", 2, 80);
    act(() => root.unmount());
    root = createRoot(host);
    expect(groupsOf()).toBe("AAA");
  });

  it("a press that never started a drag settles nothing", () => {
    const before = useApp.getState();
    const pill = strip!.querySelector<HTMLElement>(`[data-tab-id="x"]`)!;
    act(() => {
      api!.startDrag("x", {
        button: 0, target: pill, currentTarget: pill, clientX: 250, clientY: 10, preventDefault() {},
      } as unknown as React.PointerEvent);
    });
    act(() => { window.dispatchEvent(new PointerEvent("pointercancel")); });
    expect(useApp.getState()).toBe(before);
  });
});
