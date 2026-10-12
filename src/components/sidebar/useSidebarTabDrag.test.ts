// @vitest-environment happy-dom
//
// The sidebar tab-row drag reorders LIVE through `reorderTab`, so wherever
// the row is when the drag ends is already the committed order. What an end
// owes is cleanup: the document listeners and the row's transform, however
// the drag ends (release, cancel, or the task row unmounting mid-drag: the
// task archived, closed by an agent over the CLI, its project collapsed). A
// listener left behind by an unmount would keep reordering the task's tabs
// on every later pointermove. Driven against the real store.
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

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/store/app";
import { getTabIds, makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";
import { useSidebarTabDrag } from "./useSidebarTabDrag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_H = 20;
const ORDER = ["a", "b", "x"];

let api: ReturnType<typeof useSidebarTabDrag> | null = null;

function Harness() {
  api = useSidebarTabDrag("ws1", ORDER.join(" "));
  return createElement("div", { "data-sidebar-task-row": "" },
    ORDER.map(id => createElement("div", { key: id, "data-sidebar-tab-id": id })));
}

let root: Root;
let host: HTMLElement;
const row = (id: string) => host.querySelector<HTMLElement>(`[data-sidebar-tab-id="${id}"]`)!;
const move = (clientY: number) =>
  act(() => { document.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY })); });

beforeEach(() => {
  resetAppStore();
  useApp.setState({ splitTree: {}, activePaneId: {}, paneHistory: {} });
  useApp.setState({ tasks: [makeTask({ id: "ws1" })] });
  for (const id of ORDER) seedTab("ws1", makeTerminalTab({ id }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(createElement(Harness)); });
  // Rows at FIXED y slots: happy-dom does not lay out.
  ORDER.forEach((id, i) => {
    row(id).getBoundingClientRect = () => ({
      top: i * ROW_H, bottom: (i + 1) * ROW_H, height: ROW_H, left: 0, right: 200, width: 200, x: 0, y: i * ROW_H,
      toJSON() { return {}; },
    }) as DOMRect;
  });
});

afterEach(() => {
  try { act(() => root.unmount()); } catch { /* already unmounted */ }
  host.remove();
  api = null;
});

/** Press x's row, then move into the gap between a and b. */
function liftXBetweenAAndB() {
  const el = row("x");
  act(() => {
    api!.onRowPointerDown({
      button: 0, target: el, currentTarget: el, clientX: 10, clientY: 50,
    } as unknown as React.PointerEvent, "x");
  });
  move(25);
}

describe("useSidebarTabDrag ends cleanly however the drag ends", () => {
  it("reorders live and lifts the row mid-drag", () => {
    liftXBetweenAAndB();
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
    expect(api!.dragTabId).toBe("x");
    expect(row("x").style.transform).not.toBe("");
  });

  it("a cancel keeps the live order, drops the lift and the listeners", () => {
    liftXBetweenAAndB();
    act(() => { document.dispatchEvent(new PointerEvent("pointercancel")); });
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
    expect(api!.dragTabId).toBeNull();
    expect(row("x").style.transform).toBe("");
    move(5);
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
  });

  it("an unmount mid-drag keeps the live order and leaves no listener behind", () => {
    liftXBetweenAAndB();
    const removed = vi.spyOn(document, "removeEventListener");
    act(() => root.unmount());
    const types = removed.mock.calls.map(c => c[0]);
    removed.mockRestore();
    expect(types).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
    // A surviving pointermove listener would move x to the top here.
    move(5);
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
  });

  it("an unmount after the task's tabs are gone does not throw or write", () => {
    liftXBetweenAAndB();
    useApp.setState(s => {
      const { ws1: _gone, ...rest } = s.tabs;
      void _gone;
      return { tabs: rest };
    });
    const before = useApp.getState();
    act(() => root.unmount());
    move(5);
    expect(useApp.getState()).toBe(before);
  });

  it("a press that never started reorders nothing, before or after an unmount", () => {
    const el = row("x");
    act(() => {
      api!.onRowPointerDown({
        button: 0, target: el, currentTarget: el, clientX: 10, clientY: 50,
      } as unknown as React.PointerEvent, "x");
    });
    move(51);
    expect(api!.dragTabId).toBeNull();
    act(() => root.unmount());
    move(5);
    expect(getTabIds("ws1")).toEqual(["a", "b", "x"]);
  });
});
