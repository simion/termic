// Split-view scroll sync between a markdown source editor and its rendered
// preview. The preview's blocks carry `data-src-line` (MarkdownPreview's
// `src_lines` rule), which gives a list of (source line, preview y) anchors.
// Between two anchors the position is interpolated linearly, so a long
// paragraph or a tall image still scrolls smoothly instead of jumping.
//
// Lines are FRACTIONAL here: 12.5 means halfway down line 12.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";

export interface SyncAnchor { line: number; y: number }

/** Reduce raw (line, y) points to a strictly increasing list in both axes,
 *  bracketed by line 1 at y 0 and `endLine` at `endY`. Nested blocks (a list
 *  and its first item) share a line, and a block can render above an earlier
 *  line's block (floats, `<details>`), so anything that would make the map
 *  non-monotonic is dropped. */
export function buildAnchors(raw: SyncAnchor[], endLine: number, endY: number): SyncAnchor[] {
  const out: SyncAnchor[] = [{ line: 1, y: 0 }];
  for (const a of [...raw].sort((p, q) => p.y - q.y || p.line - q.line)) {
    const last = out[out.length - 1];
    if (a.line > last.line && a.y > last.y && a.line < endLine && a.y < endY) out.push(a);
  }
  const last = out[out.length - 1];
  if (endLine > last.line && endY > last.y) out.push({ line: endLine, y: endY });
  return out;
}

function interp(a: SyncAnchor[], v: number, from: "line" | "y", to: "line" | "y"): number {
  if (a.length === 0) return 0;
  if (v <= a[0][from]) return a[0][to];
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1], q = a[i];
    if (v <= q[from]) return p[to] + ((v - p[from]) / (q[from] - p[from])) * (q[to] - p[to]);
  }
  return a[a.length - 1][to];
}

export const lineToY = (a: SyncAnchor[], line: number) => interp(a, line, "line", "y");
export const yToLine = (a: SyncAnchor[], y: number) => interp(a, y, "y", "line");

/** The preview's anchors, in scroller coordinates (the scrollTop that puts
 *  each block at the top of the viewport). */
export function previewAnchors(scroller: HTMLElement, host: HTMLElement, endLine: number): SyncAnchor[] {
  const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const raw: SyncAnchor[] = [];
  for (const el of Array.from(host.querySelectorAll<HTMLElement>("[data-src-line]"))) {
    const line = Number(el.dataset.srcLine);
    // a block with no box (inside a closed <details>) reads top 0, which is
    // no position at all and would knock real anchors out of the map
    if (line && el.getClientRects().length) raw.push({ line, y: el.getBoundingClientRect().top - top });
  }
  return buildAnchors(raw, endLine, Math.max(1, scroller.scrollHeight - scroller.clientHeight));
}

/** Pixels between the editor scroller's top and the document's top. */
function docOffset(view: EditorView): number {
  return view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
}

/** The fractional source line at the top of the editor's viewport. */
export function editorTopLine(view: EditorView): number {
  const sd = view.scrollDOM;
  // pinned to the bottom: say so exactly, or a short last screen never lets
  // the preview reach its own bottom. An editor with nothing to scroll is at
  // its top, not its bottom.
  const max = sd.scrollHeight - sd.clientHeight;
  if (max > 1 && sd.scrollTop >= max - 1) return view.state.doc.lines + 1;
  const y = sd.scrollTop - docOffset(view);
  const b = view.lineBlockAtHeight(y);
  return view.state.doc.lineAt(b.from).number + (b.height ? Math.max(0, y - b.top) / b.height : 0);
}

/** The editor scrollTop that puts fractional `line` at the top. */
export function editorYForLine(view: EditorView, line: number): number {
  const doc = view.state.doc;
  const n = Math.max(1, Math.min(doc.lines, Math.floor(line)));
  const b = view.lineBlockAt(doc.line(n).from);
  return b.top + Math.min(1, line - n) * b.height + docOffset(view);
}

/** Keep a preview scroller and its source editor in scroll step while both
 *  are on screen. Returns `realign`, for the preview to call after it rebuilt
 *  its blocks under a still editor. */
export function useScrollSync(
  scrollerRef: RefObject<HTMLElement | null>, hostRef: RefObject<HTMLElement | null>,
  view: EditorView | null, visible: boolean, editorVisible: boolean,
): () => void {
  // Anchors are cached until something moves the blocks: a rebuild
  // (realign), or a resize of the content or pane, which covers late image
  // loads and mermaid diagrams landing.
  const anchorsRef = useRef<SyncAnchor[] | null>(null);
  const syncRef = useRef<(() => void) | null>(null);
  // what was on screen last time the effect ran: the pane that was already
  // showing is the one the reader is looking at, so it leads.
  const shownRef = useRef({ visible, editorVisible });
  useEffect(() => {
    const was = shownRef.current;
    shownRef.current = { visible, editorVisible };
    const scroller = scrollerRef.current, host = hostRef.current;
    if (!view || !scroller || !host || !visible || !editorVisible) return;
    const ed = view.scrollDOM;
    const anchors = () => (anchorsRef.current ??= previewAnchors(scroller, host, view.state.doc.lines + 1));
    // each side's scroll drives the other, and writing scrollTop fires a
    // scroll event back on the driven side. That echo is recognised by the
    // value it lands on, not by a time window: a busy frame (mermaid, a big
    // doc) can deliver it late, and a late echo would drive back.
    let echoEd: number | null = null, echoPv: number | null = null;
    const drive = (el: HTMLElement, y: number) => {
      const before = el.scrollTop;
      el.scrollTop = y;
      return el.scrollTop !== before ? el.scrollTop : null;
    };
    /** False when a pane had no box to sync, so nothing happened. */
    const sync = (from: "editor" | "preview"): boolean => {
      // a pane with no box (task in the background, mid collapse) has no
      // position to give, and WKWebView fires scroll(0) around those toggles.
      if (!scroller.clientHeight || !ed.clientHeight) return false;
      if (from === "editor") echoPv = drive(scroller, lineToY(anchors(), editorTopLine(view)));
      else echoEd = drive(ed, editorYForLine(view, yToLine(anchors(), scroller.scrollTop)));
      return true;
    };
    const isEcho = (el: HTMLElement, echo: number | null) => echo != null && Math.abs(el.scrollTop - echo) <= 1;
    // until the first sync has run, a scroll is the panes being laid out, not
    // the reader. WebKitGTK shows the editor with a width and no height, and
    // hiddenScrollRestore puts its old position back on that delivery; the
    // scroll event lands before the first sync and would drag the preview
    // to the editor's old place, with the first sync then following it.
    const fromEditor = () => { const echo = isEcho(ed, echoEd); echoEd = null; if (!echo && !first) sync("editor"); };
    const fromPreview = () => { const echo = isEcho(scroller, echoPv); echoPv = null; if (!echo && !first) sync("preview"); };
    // the first sync waits for the ResizeObserver's initial delivery, which
    // lands before paint and AFTER the editor's attachHiddenScrollRestore
    // (an older observer, so notified first) puts back the position it had
    // when it was hidden. Syncing earlier would be undone by that restore.
    let first: "editor" | "preview" | null = was.visible && !was.editorVisible ? "preview" : "editor";
    // `first` is spent only by a sync that RAN. WebKitGTK can deliver the
    // first observation while the editor still has no height (it lays the
    // split out a callback later); spending it there left the editor where
    // it was and nothing ever brought it to the preview's place. The editor
    // getting its height is itself a resize, so the next delivery retries.
    const ro = new ResizeObserver(() => {
      anchorsRef.current = null;
      if (first && sync(first)) first = null;
    });
    ro.observe(host);
    ro.observe(scroller);
    ro.observe(ed);
    ed.addEventListener("scroll", fromEditor, { passive: true });
    scroller.addEventListener("scroll", fromPreview, { passive: true });
    syncRef.current = () => { sync("editor"); };
    return () => {
      syncRef.current = null;
      ro.disconnect();
      ed.removeEventListener("scroll", fromEditor);
      scroller.removeEventListener("scroll", fromPreview);
    };
  }, [scrollerRef, hostRef, view, visible, editorVisible]);
  return useCallback(() => {
    anchorsRef.current = null;
    syncRef.current?.();
  }, []);
}
