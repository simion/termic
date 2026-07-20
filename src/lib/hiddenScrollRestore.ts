// WKWebView zeroes a scroll container's offsets when any ancestor toggles
// display:none — the mechanism MainArea/TaskView use to keep hidden panes
// mounted (docs/performance.md bear trap 2). xterm survives because it
// re-syncs its viewport from internal buffer state on render; CodeMirror
// and plain overflow divs treat the DOM as the source of truth, so their
// position dies with the box. This records offsets while the element is
// visible and re-applies them when the box comes back.
//
// The offsets can't be snapshotted at hide time: React applies the
// display change before any effect runs, so scrollTop is already 0 by
// the time a deactivation effect could read it. Hence the continuous
// scroll listener.
//
// The `hidden` latch guards against the engine's own scroll(0) events
// around the collapse/restore overwriting the saved offsets. It flips
// only on ResizeObserver edges (zero ↔ non-zero boxes), which deliver
// after layout — a scroll event in the same frame as a re-show still
// sees hidden=true and is ignored.
export function attachHiddenScrollRestore(el: HTMLElement): () => void {
  let top = 0;
  let left = 0;
  let hidden = el.clientHeight === 0;
  const onScroll = () => {
    if (hidden || el.clientHeight === 0) return;
    top = el.scrollTop;
    left = el.scrollLeft;
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(entries => {
    const r = entries[entries.length - 1].contentRect;
    if (r.width === 0 && r.height === 0) { hidden = true; return; }
    if (!hidden) return; // normal resize while visible — nothing to restore
    hidden = false;
    // Restore only a real position: a view mounted hidden that reveals a
    // line on first show (Find in Files) has scrolled without us ever
    // recording it, and stamping 0 over that would undo the reveal.
    if (top > 0 && el.scrollTop !== top) el.scrollTop = top;
    if (left > 0 && el.scrollLeft !== left) el.scrollLeft = left;
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    el.removeEventListener("scroll", onScroll);
  };
}
