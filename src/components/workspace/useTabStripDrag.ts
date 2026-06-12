// Shared pointer-drag for tab strips (main + right split). Encapsulates the
// reorder-within-strip logic AND cross-pane move-on-drop, so BOTH strips drive
// the exact same behavior and ANY tab type (terminal / edit / diff) drags the
// same way. Pointer-based, NOT HTML5 DnD — WKWebView's native drag is
// unreliable and Tauri intercepts it for file drops.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Tab } from "@/lib/types";

/** Which split pane sits under a screen point, for cross-pane tab drag. Panes
 *  are tagged with data-attributes: the main strip + content carry
 *  data-main-strip / data-main-content; the right strip + content carry
 *  data-right-strip / data-right-split. Returns null when over neither. */
export function paneAtPoint(x: number, y: number): "main" | "right" | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  if (el.closest("[data-right-strip], [data-right-split]")) return "right";
  if (el.closest("[data-main-strip], [data-main-content]")) return "main";
  return null;
}

interface DragBookkeeping {
  id: string;
  grabOffset: number;
  startX: number;
  pointerX: number;
  pointerY: number;
  started: boolean;
  appliedTx: number;
}

export function useTabStripDrag(opts: {
  wsId: string;
  /** Which pane this strip belongs to — a drop over the OTHER pane moves the tab. */
  pane: "main" | "right";
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** Tabs shown in THIS strip, in display order (the filtered list). */
  stripTabs: Tab[];
  /** The full per-workspace tab array — reorderTab indexes into this. */
  allTabs: Tab[];
  reorderTab: (wsId: string, tabId: string, toIndex: number) => void;
  moveTabToPane: (wsId: string, tabId: string, toPane: "main" | "right") => void;
}) {
  const { wsId, pane, stripRef, stripTabs, allTabs, reorderTab, moveTabToPane } = opts;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTx, setDragTx] = useState(0);
  // Set briefly on drop so the click that ends a drag doesn't also select the tab.
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragBookkeeping | null>(null);
  // Latest lists in refs so the long-lived pointer handlers (bound once per
  // drag in startDrag) always read current values after a live reorder.
  const stripTabsRef = useRef(stripTabs); stripTabsRef.current = stripTabs;
  const allTabsRef = useRef(allTabs); allTabsRef.current = allTabs;
  const otherPane: "main" | "right" = pane === "main" ? "right" : "main";

  // Translate that keeps the dragged pill's left edge at (cursor − grab offset).
  // Self-correcting: reads the pill's live rect and subtracts the transform
  // already applied to recover the untranslated layout slot, so it stays right
  // even after a live reorder shuffles the DOM.
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

  // Reorder when the dragged pill's center passes a neighbour's center. `target`
  // is computed in the filtered strip space, then translated to a full-array
  // index for reorderTab (other-pane tabs live in the same array but not in
  // this strip, so a raw index would corrupt the order).
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
    reorderTab(wsId, d.id, fullTarget);
  }

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current; if (!d) return;
    d.pointerX = e.clientX; d.pointerY = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return; // below the drag threshold
      d.started = true; setDragId(d.id);
    }
    setDragTx(computeTx(e.clientX));
    // Only reorder while the cursor is over THIS pane — once it's over the
    // other pane the drop will MOVE the tab, so reordering would just thrash.
    if (paneAtPoint(e.clientX, e.clientY) !== otherPane) maybeReorder(e.clientX);
  }
  function onPointerUp() {
    const d = dragRef.current;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (d?.started) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      // Dropped over the other pane → move this tab there. Any tab type moves;
      // moveTabToPane opens/closes the split + reassigns active pointers.
      if (paneAtPoint(d.pointerX, d.pointerY) === otherPane) {
        moveTabToPane(wsId, d.id, otherPane);
      }
    }
    dragRef.current = null; setDragId(null); setDragTx(0);
  }
  function startDrag(tabId: string, e: React.PointerEvent) {
    // Left button only; ignore drags that begin on the close button / rename
    // input (those have their own jobs).
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    const pill = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: tabId,
      grabOffset: e.clientX - pill.getBoundingClientRect().left,
      startX: e.clientX, pointerX: e.clientX, pointerY: e.clientY,
      started: false, appliedTx: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  // After a live reorder re-renders the strip, the dragged pill sits in a new
  // slot — re-derive its transform from the new layout BEFORE paint so it
  // doesn't jump for a frame.
  useLayoutEffect(() => {
    const d = dragRef.current;
    if (d?.started) setDragTx(computeTx(d.pointerX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripTabs]);
  // Tear down window listeners if the component unmounts mid-drag.
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { dragId, dragTx, suppressClickRef, startDrag };
}
