// Pointer-based drag-to-reorder for the main tab strip.
// Pointer-based, NOT HTML5 DnD — WKWebView's native drag is
// unreliable and Tauri intercepts it for file drops.

import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { Tab } from "@/lib/types";
import { showDragGhost, moveDragGhost, hideDragGhost } from "@/lib/dragGhost";
import { detectDropZone, setDropHighlight, clearDropHighlight, type DropZone } from "@/lib/dropZones";

interface DragBookkeeping {
  id: string;
  grabOffset: number;
  startX: number;
  pointerX: number;
  started: boolean;
  appliedTx: number;
}

export function useTabStripDrag(opts: {
  taskId: string;
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** Tabs shown in this strip, in display order. */
  stripTabs: Tab[];
  /** The full per-task tab array — reorderTab indexes into this. */
  allTabs: Tab[];
  reorderTab: (taskId: string, tabId: string, toIndex: number) => void;
  /** ID of the pane owning this strip. null/undefined = main TabBar. */
  currentPaneId?: string | null;
  /** Called when the user drops a tab onto a different pane's header. */
  onDropToPane?: (tabId: string, toPaneId: string) => void;
  /** Called on an edge drop: split the target pane (null = main) in half. */
  onDropToSplit?: (tabId: string, toPaneId: string | null, zone: "left" | "right" | "top" | "bottom") => void;
}) {
  const { taskId, stripRef, stripTabs, allTabs, reorderTab, currentPaneId, onDropToPane, onDropToSplit } = opts;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTx, setDragTx] = useState(0);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragBookkeeping | null>(null);
  const stripTabsRef = useRef(stripTabs); stripTabsRef.current = stripTabs;
  const allTabsRef = useRef(allTabs); allTabsRef.current = allTabs;
  // Track the currently highlighted drop-target pane header element.
  const prevDropTargetRef = useRef<HTMLElement | null>(null);

  function clearDropTarget() {
    if (prevDropTargetRef.current) {
      clearDropHighlight(prevDropTargetRef.current);
      prevDropTargetRef.current = null;
    }
  }

  // Drop target under the pointer. A tab can be dropped anywhere IN a pane
  // (headers and pane bodies both resolve to the pane), and near a pane edge
  // (outer 20%) the drop proposes a SPLIT instead of a move. For the main
  // strip's own drag, main is target-able only via its edges (center = plain
  // reorder); toPaneId null = the main pane.
  function hitTestDropTarget(clientX: number, clientY: number): { el: HTMLElement | null; toPaneId: string | null; zone: DropZone } | null {
    // Main strip dragging its ONLY tab: every drop is refused by the store
    // (main must keep at least one tab — an empty main has no launcher and
    // no close button), so don't offer a highlight that would no-op.
    if (!currentPaneId && stripTabsRef.current.length <= 1) return null;
    const raw = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const paneHighlight = (id: string) =>
      document.querySelector(`[data-split-leaf][data-pane-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    const zoneOf = (el: HTMLElement | null): DropZone =>
      el ? detectDropZone(el.getBoundingClientRect(), clientX, clientY) : "center";

    const header = raw?.closest("[data-pane-header]") as HTMLElement | null;
    let paneId = header?.getAttribute("data-pane-id") ?? null;
    let zone: DropZone = "center";
    if (!paneId) {
      const leaf = raw?.closest("[data-split-leaf]") as HTMLElement | null;
      if (leaf && !leaf.hasAttribute("data-main-content")) {
        paneId = leaf.getAttribute("data-pane-id");
        if (paneId) zone = zoneOf(paneHighlight(paneId));
      } else if (onDropToSplit && raw?.closest("[data-main-content]")) {
        // Over the main pane's own surface: an edge proposes splitting main.
        const el = document.querySelector("[data-main-content][data-split-leaf]") as HTMLElement | null;
        const z = zoneOf(el);
        return z === "center" ? null : { el, toPaneId: null, zone: z };
      }
    }
    if (!paneId) return null;
    const samePane = paneId === (currentPaneId ?? null);
    // Same-pane center drops are no-ops, but same-pane EDGE drops split the
    // current pane and move the dragged tab into the new half.
    if (samePane && zone === "center") return null;
    return { el: paneHighlight(paneId), toPaneId: paneId, zone };
  }

  function updateDropHighlight(clientX: number, clientY: number) {
    clearDropTarget();
    const target = hitTestDropTarget(clientX, clientY);
    if (target?.el) {
      setDropHighlight(target.el, target.zone);
      prevDropTargetRef.current = target.el;
    }
  }

  function computeTx(clientX: number): number {
    const strip = stripRef.current; const d = dragRef.current;
    if (!strip || !d) return 0;
    const pill = strip.querySelector(`[data-tab-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return 0;
    const layoutLeft = pill.getBoundingClientRect().left - d.appliedTx;
    const tx = (clientX - d.grabOffset) - layoutLeft;
    d.appliedTx = tx;
    return tx;
  }

  function maybeReorder(clientX: number) {
    const strip = stripRef.current; const d = dragRef.current;
    if (!strip || !d) return;
    const pill = strip.querySelector(`[data-tab-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return;
    const draggedCenter = (clientX - d.grabOffset) + pill.offsetWidth / 2;
    const pills = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
    let target = 0;
    for (const p of pills) {
      if (p.dataset.tabId === d.id) continue;
      const r = p.getBoundingClientRect();
      if (r.left + r.width / 2 < draggedCenter) target++;
    }
    const stripT = stripTabsRef.current; const allT = allTabsRef.current;
    const cur = stripT.findIndex(t => t.id === d.id);
    if (target === cur) return;
    const filteredWithout = stripT.filter(t => t.id !== d.id);
    const fullWithout = allT.filter(t => t.id !== d.id);
    let fullTarget: number;
    if (target >= filteredWithout.length) {
      const last = filteredWithout[filteredWithout.length - 1];
      fullTarget = last ? fullWithout.findIndex(t => t.id === last.id) + 1 : fullWithout.length;
    } else {
      const anchor = filteredWithout[target];
      fullTarget = fullWithout.findIndex(t => t.id === anchor.id);
    }
    reorderTab(taskId, d.id, fullTarget);
  }

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current; if (!d) return;
    d.pointerX = e.clientX;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return;
      d.started = true; setDragId(d.id);
      // Belt-and-suspenders vs. WebKit: drop any selection that still
      // sneaked in between mousedown and the drag threshold.
      window.getSelection()?.removeAllRanges();
      // Cursor-following ghost so the drag is visibly "carrying" the tab.
      const t = stripTabsRef.current.find(tt => tt.id === d.id);
      showDragGhost(t ? ((t as { liveTitle?: string }).liveTitle || t.title) : "Tab", e.clientX, e.clientY);
    }
    moveDragGhost(e.clientX, e.clientY);
    setDragTx(computeTx(e.clientX));
    maybeReorder(e.clientX);
    // Cross-pane / split drop highlight.
    if (onDropToPane || onDropToSplit) updateDropHighlight(e.clientX, e.clientY);
  }
  function onPointerUp(e: PointerEvent) {
    const d = dragRef.current;
    const target = d?.started ? hitTestDropTarget(e.clientX, e.clientY) : null;
    hideDragGhost();
    clearDropTarget();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    if (d?.started) {
      if (target) {
        if (target.zone !== "center" && onDropToSplit) {
          onDropToSplit(d.id, target.toPaneId, target.zone);
        } else if (target.toPaneId && onDropToPane) {
          onDropToPane(d.id, target.toPaneId);
        }
      }
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    dragRef.current = null; setDragId(null); setDragTx(0);
  }
  // Abort without dropping — WKWebView can cancel a pointer stream mid-drag
  // (gesture interruption); without this the listeners leak and the pill
  // stays in dragging styling (pointer-events:none) until a stray pointerup.
  function onPointerCancel() {
    hideDragGhost();
    clearDropTarget();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    dragRef.current = null; setDragId(null); setDragTx(0);
  }
  function startDrag(tabId: string, e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    // Kill the browser's native text selection: without this, dragging the
    // pill across the terminal/editor below sweeps a huge blue selection
    // (the pill is select-none, but the selection ANCHORS on mousedown and
    // extends into whatever selectable content the pointer crosses).
    e.preventDefault();
    const pill = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: tabId,
      grabOffset: e.clientX - pill.getBoundingClientRect().left,
      startX: e.clientX, pointerX: e.clientX,
      started: false, appliedTx: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  }

  // After a reorder shifts the pills, re-sync the drag transform so the pill
  // stays under the cursor. Key on the tab-id ORDER, not the `stripTabs` array:
  // TabBar derives stripTabs with `.filter()`, so it gets a fresh identity every
  // render and keying on it re-runs this effect after every render — including
  // the one setDragTx itself triggers. computeTx reads getBoundingClientRect()
  // and, on fractionally scaled displays, WebKit rounds .left to device pixels a
  // hair differently from the applied translateX, so the value drifts by a
  // subpixel each pass and setDragTx never settles: the effect keeps re-firing
  // until React's nested-update limit throws (#185, "MainArea crashed" mid-drag,
  // issue #127). An id-order string only changes on a real reorder, so the
  // resync runs once per reorder and can't feed itself.
  const orderKey = stripTabs.map(t => t.id).join(" ");
  useLayoutEffect(() => {
    const d = dragRef.current;
    if (d?.started) setDragTx(computeTx(d.pointerX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);
  useEffect(() => () => {
    hideDragGhost();
    clearDropTarget();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { dragId, dragTx, suppressClickRef, startDrag };
}
