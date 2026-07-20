// WKWebView zeroes `.xterm-viewport`'s scrollTop when an ancestor toggles
// display:none — the mechanism MainArea/TaskView use to hide inactive panes
// (docs/performance.md bear trap 2). xterm's Viewport guards its scroll
// handler while hidden (offsetParent === null), so the buffer position
// (ydisp) survives — but the DOM scroller is left at 0 and nothing on
// reveal puts it back:
//
//   * fit() usually lands on unchanged cols/rows → no resize event, no
//     `_afterResize` → no syncScrollArea.
//   * Render dimensions are unchanged → no onDimensionsChange.
//   * The viewport only re-syncs on a buffer scroll — i.e. when NEW
//     output scrolls a line, which for an idle agent never happens.
//
// The result is a terminal that renders correctly but whose scrollbar is
// pinned to the top: wheel-up is dead (scrollTop already 0), the first
// wheel-down teleports thousands of lines up (absolute scrollTop → ydisp
// mapping), and if output streamed while hidden the scroll-area height was
// computed against a 0-height viewport, leaving the true bottom
// unreachable until output forces a sync.
//
// Worse, syncScrollArea()'s own dirty-checks can all pass in this state
// (buffer length, viewport height, and _lastScrollTop can each be stale in
// a way that matches), so simply calling it is not enough: we invalidate
// its recorded viewport height first, forcing the full _innerRefresh that
// recomputes the scroll-area height and re-asserts
// scrollTop = ydisp * rowHeight against live layout.
//
// All reach-ins are optional-chained: if a future xterm renames these
// internals this degrades to a no-op, not a crash (same posture as
// termLinkOpener's _oscLinkService reach-in).
import type { Terminal } from "@xterm/xterm";

type ViewportInternals = {
  syncScrollArea?: (immediate?: boolean) => void;
  _lastRecordedViewportHeight?: number;
  _ignoreNextScrollEvent?: boolean;
};

/** Call on the display:none → visible edge (ResizeObserver zero → non-zero)
 *  to repair the viewport scroller WKWebView clobbered while hidden. */
export function resyncViewportAfterReveal(term: Terminal): void {
  try {
    const vp = (term as unknown as { _core?: { viewport?: ViewportInternals } })._core?.viewport;
    if (!vp?.syncScrollArea) return;
    // A hidden-time _innerRefresh sets _ignoreNextScrollEvent and then
    // writes scrollTop into a box that can't scroll — the write no-ops, no
    // scroll event ever consumes the flag, and it would swallow the user's
    // first real wheel tick. Clear it; the sync below re-arms it iff it
    // actually moves scrollTop.
    if (vp._ignoreNextScrollEvent) vp._ignoreNextScrollEvent = false;
    if (typeof vp._lastRecordedViewportHeight === "number") vp._lastRecordedViewportHeight = -1;
    vp.syncScrollArea(true);
  } catch {
    // Never let a viewport repair take down the pane.
  }
}
