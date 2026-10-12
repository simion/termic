// Review comments on the rendered markdown preview. The same comments the
// editor's reviewCommentsExt makes (same store, same file + source line
// range, same commentBoxes composer and card), so one made on rendered text
// shows up beside its source in the editor too, and the editor keeps it
// anchored through edits.
//
// Each box lives in a slot <div> that placeSlots() keeps after the block its
// range ends on, inside the preview's innerHTML-built document. The slots
// outlive a rebuild of that document, and are marked SLOT_ATTR so find, copy
// and selection leave them out.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { useReviewComments, type ReviewComment } from "@/store/reviewComments";
import { QUOTE_CLASS, SLOT_ATTR } from "@/lib/markdownCopy";
import { buildCard, buildComposer, type ComposerSpec } from "./commentBoxes";

const COMMENTED_ATTR = "data-tc-commented";

/** A draft in the preview always has a line range (no whole-file comments). */
type PreviewDraft = ComposerSpec & { startLine: number; endLine: number };

/** The source line range of a stamped block (`data-src-line`/`-end`, see
 *  MarkdownPreview's `src_lines` rule). */
function span(el: HTMLElement): [number, number] {
  const s = Number(el.dataset.srcLine);
  return [s, Number(el.dataset.srcEnd) || s];
}

/** Map a selection inside the rendered preview onto source lines, using the
 *  innermost stamped block at each end (a list item, not the whole list). */
export function selectionLines(host: HTMLElement, range: Range): { startLine: number; endLine: number } | null {
  const blockOf = (n: Node) =>
    (n.nodeType === Node.ELEMENT_NODE ? n as Element : n.parentElement)?.closest<HTMLElement>("[data-src-line]");
  const s = blockOf(range.startContainer), e = blockOf(range.endContainer);
  if (!s || !e || !host.contains(s) || !host.contains(e)) return null;
  const startLine = span(s)[0];
  const endLine = Math.max(startLine, span(e)[1]);
  return startLine ? { startLine, endLine } : null;
}

/** A literal matcher for `s` where every whitespace run matches any
 *  whitespace run. The source hard-wraps where the rendering joins with a
 *  space, and a selection across blocks reads "\n\n" where the DOM has
 *  nothing, so an exact match misses both. Null for an all-whitespace `s`. */
function looseRegex(s: string): RegExp | null {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
}

/** What a comment made on a preview selection says: the selection itself as
 *  the quote (that is what the user pointed at), and the block-level line
 *  range narrowed to the source lines the selection spans. When the selection
 *  is not in the source as typed (inline markdown, an entity, an escape), the
 *  lines stay the block's and the quote is still the selection.
 *
 *  ponytail: the first occurrence in the block wins, so a phrase repeated in
 *  one paragraph points at its first copy. Narrowing by the selection's
 *  offset within the block would fix it, if it ever matters. */
export function narrowSelection(
  text: string, startLine: number, endLine: number, selected: string,
): { startLine: number; endLine: number; quote: string } {
  const src = text.split("\n").slice(startLine - 1, endLine).join("\n");
  const quote = selected.trim();
  const m = looseRegex(quote)?.exec(src);
  if (!m) return { startLine, endLine, quote: quote || src };
  const lineAt = (i: number) => startLine + (src.slice(0, i).match(/\n/g)?.length ?? 0);
  return { startLine: lineAt(m.index), endLine: lineAt(m.index + m[0].length - 1), quote };
}

/** Wrap the rendered text of `quote` inside `blocks` in `<mark>`s, one per
 *  text node it touches. False when the text is not there (an editor comment
 *  quoting `**markdown**`), and the caller falls back to marking the blocks.
 *  A `<mark>` and not the CSS Custom Highlight API, which paints the wrong
 *  text in WKWebView (docs/gotchas.md), same as find. */
function markQuote(blocks: HTMLElement[], quote: string): boolean {
  const re = looseRegex(quote);
  if (!re) return false;
  const nodes: Text[] = [], starts: number[] = [];
  let hay = "";
  for (const b of blocks) {
    if (hay) hay += "\n";
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement?.closest(`[${SLOT_ATTR}], .mermaid-block`)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      starts.push(hay.length);
      nodes.push(n as Text);
      hay += n.nodeValue ?? "";
    }
  }
  const m = re.exec(hay);
  if (!m) return false;
  const from = m.index, to = m.index + m[0].length;
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i], e = s + nodes[i].length;
    const a = Math.max(from, s), b = Math.min(to, e);
    if (a >= b) continue;
    let node = nodes[i];
    if (b < e) node.splitText(b - s);
    if (a > s) node = node.splitText(a - s);
    // a whitespace seam between elements (inside a <ul>, a <tr>) is no place
    // for an inline element, and there is nothing to see in it anyway
    if (!node.nodeValue?.trim()) continue;
    const mark = document.createElement("mark");
    mark.className = QUOTE_CLASS;
    node.replaceWith(mark);
    mark.appendChild(node);
  }
  return true;
}

/** Undo every markQuote, rejoining the text nodes it split (the same reason
 *  unmarkFind normalizes: the next match must be able to cross the seam). */
function unmarkQuotes(host: HTMLElement): void {
  const parents = new Set<Node>();
  for (const m of Array.from(host.querySelectorAll(`mark.${QUOTE_CLASS}`))) {
    const parent = m.parentNode;
    if (!parent) continue;
    m.replaceWith(...Array.from(m.childNodes));
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

export interface Slot {
  el: HTMLElement;
  startLine: number;
  endLine: number;
  /** Highlight this text within the blocks it covers. */
  quote?: string;
  /** Mark the blocks it covers when the quote cannot be highlighted (a
   *  comment yes, the open composer no). */
  mark: boolean;
}

/** Put each slot after the block its range ends on, and highlight what it
 *  quotes (or, failing that, mark the blocks it covers). `slots` must be
 *  sorted by `endLine`.
 *
 *  A comment's blocks are the INNERMOST stamped elements its range touches
 *  (the list item, not the list; the paragraphs inside a raw-HTML `<div>`
 *  that has no stamp of its own), the same notion selectionLines uses. The
 *  slot goes after the top-level block holding the last of them, since a
 *  card inside a list or table would break it.
 *
 *  Moves only slots that are out of place: moving a node detaches it, and a
 *  detached composer textarea loses focus mid-sentence. */
export function placeSlots(host: HTMLElement, slots: Slot[]): void {
  unmarkQuotes(host);
  const stamped = Array.from(host.querySelectorAll<HTMLElement>("[data-src-line]"));
  const lit = new Set<Element>();
  // slots sharing a block stack behind each other, in line order
  let prevBlock: Element | null | undefined, prevSlot: Element | null = null;
  for (const s of slots) {
    const hits = stamped.filter(el => { const [a, b] = span(el); return a <= s.endLine && b >= s.startLine; });
    // in document order a block's stamped descendants follow it directly, so
    // a hit is innermost unless the next hit is inside it
    const leaves = hits.filter((el, i) => !hits[i + 1] || !el.contains(hits[i + 1]));
    const quoted = !!s.quote && markQuote(leaves, s.quote);
    if (s.mark && !quoted) for (const el of leaves) lit.add(el);
    let after: Element | null = leaves[leaves.length - 1] ?? stamped.filter(el => span(el)[0] <= s.endLine).pop() ?? null;
    while (after && after.parentElement !== host) after = after.parentElement;
    const ref = after === prevBlock ? prevSlot : after;
    if (ref ? ref.nextSibling !== s.el : host.firstChild !== s.el) {
      if (ref) ref.after(s.el); else host.prepend(s.el);
    }
    prevBlock = after;
    prevSlot = s.el;
  }
  for (const el of Array.from(host.querySelectorAll(`[${COMMENTED_ATTR}]`))) if (!lit.has(el)) el.removeAttribute(COMMENTED_ATTR);
  for (const el of lit) el.setAttribute(COMMENTED_ATTR, "");
}

/** Review comments on the preview of task file `file` (undefined = none).
 *  `focusPane` takes focus back when a composer closes without sending. */
export function usePreviewComments({ hostRef, scrollerRef, taskId, file, text, focusPane }: {
  hostRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  taskId: string | undefined;
  file: string | undefined;
  text: string;
  focusPane: () => void;
}) {
  // this file's comments only, element-wise compared: a comment on another
  // file of the task must not re-render the whole preview
  const comments = useReviewComments(useShallow(s =>
    taskId && file ? (s.byTask[taskId] ?? []).filter(c => c.file === file && c.startLine != null) : []));
  const [draft, setDraft] = useState<PreviewDraft | null>(null);
  const [pill, setPill] = useState<{ top: number; left: number; startLine: number; endLine: number } | null>(null);
  useEffect(() => { setDraft(null); setPill(null); }, [taskId, file]);
  // the comment being edited went away (sent, discarded, deleted in the
  // editor), so does its composer; an Update would land nowhere
  useEffect(() => {
    if (draft?.id && !comments.some(c => c.id === draft.id)) setDraft(null);
  }, [comments, draft]);

  // key -> slot element, and what its box was built from (rebuilt on change)
  const slotsRef = useRef(new Map<string, { el: HTMLDivElement; from: ReviewComment | PreviewDraft }>());
  const live = useRef({ comments, draft, taskId, file, focusPane });
  live.current = { comments, draft, taskId, file, focusPane };

  function place() {
    const host = hostRef.current;
    const { comments, draft, taskId, file, focusPane } = live.current;
    if (!host) return;
    const editDraft = (c: ReviewComment) =>
      setDraft({ id: c.id, startLine: c.startLine!, endLine: c.endLine ?? c.startLine!, quote: c.quote, body: c.body });
    const wanted = [
      ...comments.filter(c => c.id !== draft?.id).map(c => ({
        key: c.id, from: c as ReviewComment | PreviewDraft, startLine: c.startLine!, endLine: c.endLine ?? c.startLine!,
        quote: c.quote, mark: true,
        build: () => buildCard(c, () => editDraft(c)),
      })),
      ...(draft && taskId && file ? [{
        // the draft highlights its quote too: opening it cleared the selection
        key: "draft", from: draft as ReviewComment | PreviewDraft, startLine: draft.startLine, endLine: draft.endLine,
        quote: draft.quote, mark: false,
        build: () => buildComposer(draft, { taskId, file, source: "editor" }, {
          onClose: (sent) => { setDraft(null); if (!sent) focusPane(); },
        }),
      }] : []),
    ].sort((a, b) => a.endLine - b.endLine);

    const map = slotsRef.current;
    const keep = new Set(wanted.map(w => w.key));
    for (const [k, s] of map) if (!keep.has(k)) { s.el.remove(); map.delete(k); }
    for (const w of wanted) {
      let s = map.get(w.key);
      if (!s) {
        const el = document.createElement("div");
        el.setAttribute(SLOT_ATTR, "");
        map.set(w.key, s = { el, from: w.from });
        el.appendChild(w.build());
      } else if (s.from !== w.from) {
        s.from = w.from;
        s.el.replaceChildren(w.build());
      }
    }
    placeSlots(host, wanted.map(w => ({ ...w, el: map.get(w.key)!.el })));
  }
  // a layout effect so the slots are in the document before a new composer
  // focuses (its own setTimeout), and before paint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(place, [comments, draft]);

  /** Replace the host's document. It detaches every slot, and a detached
   *  textarea drops focus, so put the slots and an open composer's caret
   *  back afterwards. */
  function rebuild(render: () => void) {
    const host = hostRef.current;
    const active = document.activeElement;
    const caret = host && active instanceof HTMLTextAreaElement && host.contains(active)
      ? { el: active, from: active.selectionStart, to: active.selectionEnd } : null;
    render();
    place();
    if (caret) {
      caret.el.focus({ preventScroll: true });
      caret.el.setSelectionRange(caret.from, caret.to);
    }
  }

  function onMouseUp() {
    const host = hostRef.current, scroller = scrollerRef.current;
    const sel = window.getSelection();
    if (!taskId || !file || !host || !scroller || !sel || sel.isCollapsed || !sel.rangeCount) return setPill(null);
    const r = sel.getRangeAt(0);
    const common = r.commonAncestorContainer;
    const commonEl = common.nodeType === Node.ELEMENT_NODE ? common as Element : common.parentElement;
    if (!host.contains(common) || commonEl?.closest(`[${SLOT_ATTR}]`)) return setPill(null);
    const lines = selectionLines(host, r);
    if (!lines) return setPill(null);
    const rect = r.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
    const above = rect.top - sr.top + scroller.scrollTop - 30;
    setPill({
      ...lines,
      top: above >= scroller.scrollTop ? above : rect.bottom - sr.top + scroller.scrollTop + 6,
      left: Math.max(4, rect.left - sr.left + scroller.scrollLeft),
    });
  }
  useEffect(() => {
    if (!pill) return;
    const hide = () => { if (window.getSelection()?.isCollapsed) setPill(null); };
    document.addEventListener("selectionchange", hide);
    return () => document.removeEventListener("selectionchange", hide);
  }, [pill]);

  function openDraft() {
    if (!pill) return;
    const sel = window.getSelection();
    setDraft({ ...narrowSelection(text, pill.startLine, pill.endLine, sel?.toString() ?? ""), body: "" });
    setPill(null);
    sel?.removeAllRanges();
  }

  /** The slot elements now in the document (for copy to leave out). */
  const slotEls = () => Array.from(slotsRef.current.values(), s => s.el).filter(el => el.isConnected);

  return { pill, openDraft, onMouseUp, rebuild, slotEls };
}
