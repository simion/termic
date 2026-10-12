// Ordering + selection rules behind the tab context menu (issue #183).
//
// Typed on the smallest shape a tab strip has in common, so the main strip
// (`Tab[]`), a split pane's strip (`Tab[]`) and the bottom scratch shells
// (their own `{ id, title }` records) all share one implementation.

export interface StripTab {
  id: string;
  pinned?: boolean;
}

/** Where the pinned block ends, ignoring `tabId` itself. Chrome semantics: this
 *  is the destination for BOTH pin (append to the block) and unpin (first slot
 *  after it). */
export function pinBoundary(strip: StripTab[], tabId: string): number {
  return strip.filter(t => t.id !== tabId && t.pinned).length;
}

/** Tabs "Close others" / "Close to the right" should close. Pinned tabs and the
 *  clicked tab itself always survive. Empty when the clicked tab is unknown. */
export function closableSiblings(strip: StripTab[], tabId: string, mode: "others" | "right"): string[] {
  const idx = strip.findIndex(t => t.id === tabId);
  if (idx < 0) return [];
  const candidates = mode === "right" ? strip.slice(idx + 1) : strip;
  return candidates.filter(t => t.id !== tabId && !t.pinned).map(t => t.id);
}

/** The fields the sidebar's tab-row drag reads off a tab. */
export interface SidebarStripTab extends StripTab {
  type: string;
  paneId?: string | null;
}

/**
 * Where `reorderTab` must put `dragId` so that, among the sidebar's tab rows
 * (main-pane terminal tabs), it lands right before `beforeId`, or after the
 * last row when `beforeId` is null. `all` is the task's FULL tab array, which
 * also holds edit/diff/scratch tabs and split-pane tabs the sidebar does not
 * draw; the result is in `reorderTab`'s own terms, an index into `all` with
 * the dragged tab removed. Null when no row would move (or an id is not a
 * row), so the caller writes nothing.
 *
 * Pinned tabs own the head of the strip, so the move is clamped to the
 * dragged row's own group, exactly like the tab strip's drag: a pinned row
 * stops at the end of the pinned rows, an unpinned one cannot cross above
 * them. The clamp runs twice, once among the rows and once in the full
 * strip, because a hidden tab can sit between the two groups: in
 * [Pa, Pb, edit, Ut], dropping Pa below Pb anchors before Ut, which would
 * otherwise put Pa after the unpinned edit tab.
 */
export function sidebarTabMoveIndex(
  all: readonly SidebarStripTab[],
  dragId: string,
  beforeId: string | null,
): number | null {
  const vis = all.filter(t => t.type === "terminal" && !t.paneId);
  const cur = vis.findIndex(t => t.id === dragId);
  if (cur < 0) return null;
  const pinned = !!vis[cur].pinned;
  const visW = vis.filter(t => t.id !== dragId);
  let target = beforeId === null ? visW.length : visW.findIndex(t => t.id === beforeId);
  if (target < 0) return null;
  const boundary = visW.filter(t => t.pinned).length;
  target = pinned ? Math.min(target, boundary) : Math.max(target, boundary);
  if (target === cur) return null;

  const fullW = all.filter(t => t.id !== dragId);
  let idx: number;
  if (target < visW.length) idx = fullW.findIndex(t => t.id === visW[target].id);
  else if (visW.length) idx = fullW.findIndex(t => t.id === visW[visW.length - 1].id) + 1;
  else idx = fullW.length;
  let pinEnd = 0;
  fullW.forEach((t, i) => { if (t.pinned && !t.paneId) pinEnd = i + 1; });
  return pinned ? Math.min(idx, pinEnd) : Math.max(idx, pinEnd);
}
