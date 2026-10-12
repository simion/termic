// Drag-to-reorder for a task's tab rows in the sidebar tree.
//
// Pointer-based like every other drag in the app (no HTML5 DnD: WKWebView's
// native drag is unreliable and Tauri intercepts it for file drops). Called
// ONCE per TaskRow, not per tab row, and holds no store subscription: the
// rows it reorders are the task's main-pane terminal tabs, read straight from
// `useApp.getState()` on each move, and the reorder itself goes through
// `reorderTab`, so the tab strip (which reads the same `tabs[taskId]`) moves
// with it and the order persists through `syncDurableTabs`.
//
// The follow-the-cursor transform is applied to the row element directly,
// never through React state: pointermove fires far faster than a TaskRow
// needs to render, and the only thing the row's markup has to know is WHICH
// tab is lifted (`dragTabId`). The row therefore must not carry a React
// `style` prop, which would overwrite the transform on its next render.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";
import { sidebarTabMoveIndex } from "@/lib/tabActions";

/** Same squared-distance threshold as the task-row drag: under it, the press
 *  is still a click. */
const DRAG_THRESHOLD_SQ = 16;
const NO_DRAG = 'button, input, a, [data-no-drag], [role="menu"], [role="dialog"]';

interface Armed {
  id: string;
  /** The `[data-sidebar-task-row]` wrapper this press started in. Every hit
   *  test is scoped to it, so another task's rows are never candidates. */
  list: HTMLElement;
  x: number;
  y: number;
  started: boolean;
  grabOffsetY: number;
  appliedTy: number;
  pointerY: number;
}

const rowEl = (list: HTMLElement, id: string) =>
  list.querySelector<HTMLElement>(`[data-sidebar-tab-id="${CSS.escape(id)}"]`);

/**
 * @param orderKey the task's tab-row ids joined into one string. The
 *   re-anchor effect keys on it, NOT on the rows array, which is a fresh
 *   `.filter()` every render and would make the effect re-run on the render
 *   its own measurement triggers (the #127 loop, see useTabStripDrag).
 */
export function useSidebarTabDrag(taskId: string, orderKey: string) {
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const armedRef = useRef<Armed | null>(null);
  // The click that trails a drop lands on the row it released over. Set on
  // drop, read + cleared by the row's onClick, and cleared on a 0ms timer
  // regardless, because a release over another element fires its click on a
  // common ancestor and the flag would otherwise swallow the NEXT click.
  const clickSuppressed = useRef(false);

  // translateY that keeps the lifted row under the cursor: the row's real
  // rect minus the transform already applied recovers its untranslated slot,
  // so the value self-corrects after every reorder.
  const applyTy = (a: Armed) => {
    const el = rowEl(a.list, a.id);
    if (!el) return;
    const layoutTop = el.getBoundingClientRect().top - a.appliedTy;
    a.appliedTy = (a.pointerY - a.grabOffsetY) - layoutTop;
    el.style.transform = `translateY(${a.appliedTy}px)`;
  };

  const onMove = (e: PointerEvent) => {
    const a = armedRef.current;
    if (!a) return;
    if (!a.started) {
      const dx = e.clientX - a.x;
      const dy = e.clientY - a.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return;
      a.started = true;
      setDragTabId(a.id);
    }
    a.pointerY = e.clientY;
    applyTy(a);

    // First sibling whose midpoint is below the cursor. None = past the last
    // row, so the row lands at the bottom of its own list; above the first
    // it lands at the top. Rows outside `a.list` are never looked at, which
    // is what refuses a drop onto another task: the row just clamps.
    let beforeId: string | null = null;
    for (const el of Array.from(a.list.querySelectorAll<HTMLElement>("[data-sidebar-tab-id]"))) {
      if (el.dataset.sidebarTabId === a.id) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY < (r.top + r.bottom) / 2) { beforeId = el.dataset.sidebarTabId!; break; }
    }
    const st = useApp.getState();
    const idx = sidebarTabMoveIndex(st.tabs[taskId] ?? [], a.id, beforeId);
    if (idx !== null) st.reorderTab(taskId, a.id, idx);
  };

  // The exact functions registered on press. Each render builds new
  // closures, so removal must go through this ref rather than through
  // whatever `onMove` the current render happens to hold.
  const listenersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);
  const detach = () => {
    const ls = listenersRef.current;
    if (!ls) return;
    document.removeEventListener("pointermove", ls.move);
    document.removeEventListener("pointerup", ls.up);
    document.removeEventListener("pointercancel", ls.up);
    listenersRef.current = null;
  };

  // A cancel ends the drag the same way a release does: the reorder is live,
  // so wherever the row is now is already the committed order.
  function onUp() {
    detach();
    const a = armedRef.current;
    armedRef.current = null;
    if (!a?.started) return;
    const el = rowEl(a.list, a.id);
    if (el) el.style.transform = "";
    setDragTabId(null);
    clickSuppressed.current = true;
    setTimeout(() => { clickSuppressed.current = false; }, 0);
  }

  // Listeners added on press hold the closures of THAT render; the handlers
  // only touch refs, the store and stable setters, so a stale closure is fine.
  const onRowPointerDown = (e: React.PointerEvent, tabId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(NO_DRAG)) return;
    const rows = (useApp.getState().tabs[taskId] ?? []).filter(t => t.type === "terminal" && !(t as { paneId?: string }).paneId);
    if (rows.length < 2) return;
    const row = e.currentTarget as HTMLElement;
    const list = row.closest<HTMLElement>("[data-sidebar-task-row]");
    if (!list) return;
    detach();
    armedRef.current = {
      id: tabId, list, x: e.clientX, y: e.clientY, started: false,
      grabOffsetY: e.clientY - row.getBoundingClientRect().top,
      appliedTy: 0, pointerY: e.clientY,
    };
    listenersRef.current = { move: onMove, up: onUp };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  // After a reorder moves the rows, re-anchor the lifted row under the
  // cursor before paint, so it never shows a frame at its old offset.
  useLayoutEffect(() => {
    const a = armedRef.current;
    if (a?.started) applyTy(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  useEffect(() => () => {
    const a = armedRef.current;
    if (a) {
      const el = rowEl(a.list, a.id);
      if (el) el.style.transform = "";
    }
    armedRef.current = null;
    detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { dragTabId, onRowPointerDown, clickSuppressed };
}
