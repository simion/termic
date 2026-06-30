// Pointer-based drag-to-reorder for the main tab strip.
// Pointer-based, NOT HTML5 DnD — WKWebView's native drag is
// unreliable and Tauri intercepts it for file drops.

import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { Tab } from "@/lib/types";

interface DragBookkeeping {
  id: string;
  grabOffset: number;
  startX: number;
  pointerX: number;
  started: boolean;
  appliedTx: number;
}

export function useTabStripDrag(opts: {
  wsId: string;
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** Tabs shown in this strip, in display order. */
  stripTabs: Tab[];
  /** The full per-workspace tab array — reorderTab indexes into this. */
  allTabs: Tab[];
  reorderTab: (wsId: string, tabId: string, toIndex: number) => void;
}) {
  const { wsId, stripRef, stripTabs, allTabs, reorderTab } = opts;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTx, setDragTx] = useState(0);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragBookkeeping | null>(null);
  const stripTabsRef = useRef(stripTabs); stripTabsRef.current = stripTabs;
  const allTabsRef = useRef(allTabs); allTabsRef.current = allTabs;

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
    reorderTab(wsId, d.id, fullTarget);
  }

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current; if (!d) return;
    d.pointerX = e.clientX;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return;
      d.started = true; setDragId(d.id);
    }
    setDragTx(computeTx(e.clientX));
    maybeReorder(e.clientX);
  }
  function onPointerUp() {
    const d = dragRef.current;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (d?.started) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    dragRef.current = null; setDragId(null); setDragTx(0);
  }
  function startDrag(tabId: string, e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    const pill = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: tabId,
      grabOffset: e.clientX - pill.getBoundingClientRect().left,
      startX: e.clientX, pointerX: e.clientX,
      started: false, appliedTx: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  useLayoutEffect(() => {
    const d = dragRef.current;
    if (d?.started) setDragTx(computeTx(d.pointerX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripTabs]);
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { dragId, dragTx, suppressClickRef, startDrag };
}
