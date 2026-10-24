// The preview's line-number gutter: the source line of a rendered block,
// drawn in the left margin beside its first line. Hover mode numbers the
// block under the pointer, always mode every leaf block. Hovering a number
// shows its whole range and its actions (copy a `path:337-342` reference,
// and on an editable preview the block editor's pencil). See docs/ui.md
// "Markdown preview".
//
// Perf rules, because a long spec has thousands of blocks:
// - one overlay layer outside the document (find, copy and the innerHTML
//   rebuild never see it), positioned in the scroller's CONTENT coordinates,
//   so scrolling moves it for free: nothing here runs on scroll.
// - positions are computed on a rebuild, a resize (ResizeObserver: late
//   images, mermaid, the pane, a reader setting reflowing the text) and a
//   <details> toggle, coalesced to one frame, all reads before any write.
// - hover is a closest() per mousemove and one block measured when the
//   hovered block changes; in always mode not even that, a class flips.
// - a label's buttons are built the first time the pointer reaches it, not
//   per paint: always mode has a label per leaf block and repaints on every
//   rebuild, and nobody hovers most of them.

import { useEffect, useRef, type RefObject } from "react";
import { i18n } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { SLOT_ATTR } from "@/lib/markdown/trust";
import { elRange, labelBox, lineRef, rangeText, type LineRange } from "@/lib/markdown/lines";
import type { LineNumbers } from "@/lib/markdown/reader";
import { editBlockTitle } from "./blockEditor";

// app constants, never document content: the only innerHTML here
const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// lucide `copy` and `pencil`
const COPY_ICON = icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>');
const EDIT_ICON = icon('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>');

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`panels:mdReader.${key}`, opts);

export function copyLineRef(path: string | undefined, r: LineRange) {
  const ref = lineRef(path, r);
  void copyToClipboard(ref, ref);
}

/** What hovering `target` means for the hovered block: the innermost stamped
 *  block under it, `null` for none (app UI such as a comment card), or
 *  `undefined` to keep the current one. The document's padding, the gaps
 *  between blocks and a list's own box (between its items) keep it, which
 *  is what lets the pointer travel from a block to its number. Exported for
 *  tests. */
export function hoverTarget(target: Element, host: HTMLElement): HTMLElement | null | undefined {
  if (target === host || !host.contains(target)) return undefined;
  if (target.closest(`[${SLOT_ATTR}]`)) return null;
  const b = target.closest<HTMLElement>("[data-src-line]");
  if (!b || !host.contains(b) || b.tagName === "UL" || b.tagName === "OL") return undefined;
  return b;
}

/** Every block that gets a number in always mode: stamped, laid out, and
 *  holding no stamped block of its own (the item, not the list; the row, not
 *  the table). Exported for tests. */
export function gutterLeaves(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-src-line]"))
    .filter(el => !el.querySelector("[data-src-line]") && el.getClientRects().length > 0);
}

export function useLineGutter({ scrollerRef, hostRef, layerRef, mode, refPath, onEdit, layoutKey }: {
  scrollerRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<HTMLElement | null>;
  /** the empty overlay element, a child of the scroller */
  layerRef: RefObject<HTMLElement | null>;
  mode: LineNumbers;
  /** task-relative path the copied reference names; absent = range only */
  refPath?: string;
  /** present when the preview can edit: the pencil, on the hovered block */
  onEdit?: (el: HTMLElement) => void;
  /** changes whenever a reader setting does, which may reflow every block */
  layoutKey: string;
}): { refresh(): void } {
  const live = useRef({ mode, refPath, onEdit });
  live.current = { mode, refPath, onEdit };
  // labels: block -> its label; owners: the reverse, for a label's events
  const st = useRef({
    hovered: null as HTMLElement | null, raf: 0,
    labels: new Map<HTMLElement, HTMLElement>(), owners: new WeakMap<HTMLElement, HTMLElement>(),
  });

  function paint() {
    const s = st.current;
    s.raf = 0;
    const layer = layerRef.current, host = hostRef.current, scroller = scrollerRef.current;
    if (!layer || !host || !scroller) return;
    const { mode } = live.current;
    if (s.hovered && !s.hovered.isConnected) s.hovered = null;
    // hidden (display: none): no geometry to read; the resize on reveal repaints
    if (mode !== "off" && !host.getClientRects().length) return;
    // a hovered block hidden since (the block editor over it) has no rect to
    // place a label at: same filter as gutterLeaves
    const hov = s.hovered && s.hovered.getClientRects().length ? s.hovered : null;
    const targets = mode === "always" ? gutterLeaves(host) : mode === "hover" && hov ? [hov] : [];
    // reads
    const sr = scroller.getBoundingClientRect();
    const ox = sr.left - scroller.scrollLeft, oy = sr.top - scroller.scrollTop;
    const colLeft = new Map<Element, number>();
    const boxes = targets.map(el => {
      let top: Element = el;
      while (top.parentElement && top.parentElement !== host) top = top.parentElement;
      let col = colLeft.get(top);
      if (col === undefined) colLeft.set(top, col = top.getBoundingClientRect().left - ox);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 16;
      const box = labelBox({
        top: r.top - oy, height: r.height,
        padTop: parseFloat(cs.paddingTop) || 0, padBottom: parseFloat(cs.paddingBottom) || 0,
        lineHeight: parseFloat(cs.lineHeight) || fs * 1.5,
      });
      return { el, x: col - 10, ...box };
    });
    // writes
    s.labels.clear();
    const frag = document.createDocumentFragment();
    for (const b of boxes) {
      const range = elRange(b.el);
      if (!range) continue;
      const lab = buildLabel(b.el, range);
      lab.style.left = `${Math.max(40, b.x)}px`;
      lab.style.top = `${b.top}px`;
      lab.style.height = `${Math.min(b.height, 40)}px`;
      if (b.el === s.hovered) lab.classList.add("md-gl-hot");
      s.labels.set(b.el, lab);
      s.owners.set(lab, b.el);
      frag.appendChild(lab);
    }
    layer.replaceChildren(frag);
  }

  function buildLabel(el: HTMLElement, range: LineRange): HTMLElement {
    const lab = document.createElement("div");
    lab.className = "md-gl";
    lab.title = t("lines", { range: rangeText(range) });
    const num = lab.appendChild(document.createElement("span"));
    num.className = "md-gl-num";
    num.textContent = String(range.startLine);
    const more = lab.appendChild(document.createElement("span"));
    more.className = "md-gl-more";
    if (range.endLine > range.startLine) {
      const end = more.appendChild(document.createElement("span"));
      end.textContent = `-${range.endLine}`;
    }
    return lab;
  }

  /** A label's buttons, on the first hover of it. */
  function addActions(lab: HTMLElement, range: LineRange) {
    if (lab.dataset.acts) return;
    lab.dataset.acts = "1";
    const more = lab.querySelector(".md-gl-more")!;
    const add = (id: string, svg: string, title: string) => {
      const btn = more.appendChild(document.createElement("button"));
      btn.type = "button";
      btn.className = "md-gl-act";
      btn.dataset.act = id;
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.innerHTML = svg;
    };
    add("copy", COPY_ICON, t("copyRef", { ref: lineRef(live.current.refPath, range) }));
    if (live.current.onEdit) add("edit", EDIT_ICON, editBlockTitle(range));
  }

  function schedule() {
    if (!st.current.raf) st.current.raf = requestAnimationFrame(paint);
  }

  useEffect(() => {
    const scroller = scrollerRef.current, host = hostRef.current, layer = layerRef.current;
    if (!scroller || !host || !layer) return;
    const s = st.current;
    const onMove = (e: MouseEvent) => {
      if (live.current.mode === "off") return;
      const target = e.target as Element;
      if (layer.contains(target)) return;
      const next = hoverTarget(target, host);
      if (next === undefined || next === s.hovered) return;
      s.labels.get(s.hovered!)?.classList.remove("md-gl-hot");
      s.hovered = next;
      if (live.current.mode === "hover") paint();
      else s.labels.get(next!)?.classList.add("md-gl-hot");
    };
    const onLeave = () => {
      if (!s.hovered) return;
      s.labels.get(s.hovered)?.classList.remove("md-gl-hot");
      s.hovered = null;
      if (live.current.mode === "hover") layer.replaceChildren();
    };
    const labelBlock = (target: EventTarget | null) => {
      const lab = (target as Element | null)?.closest?.<HTMLElement>(".md-gl");
      const el = lab && s.owners.get(lab);
      const range = el && elRange(el);
      return lab && el && range ? { lab, el, range } : null;
    };
    const onOver = (e: MouseEvent) => {
      const hit = labelBlock(e.target);
      if (hit) addActions(hit.lab, hit.range);
    };
    const onClick = (e: MouseEvent) => {
      const hit = labelBlock(e.target);
      if (!hit) return;
      const id = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act ?? "copy";
      if (id === "edit") live.current.onEdit?.(hit.el);
      else copyLineRef(live.current.refPath, hit.range);
    };
    // a label click must not drop the reader's selection or move focus
    const onDown = (e: MouseEvent) => e.preventDefault();
    scroller.addEventListener("mousemove", onMove);
    scroller.addEventListener("mouseleave", onLeave);
    layer.addEventListener("mouseover", onOver);
    layer.addEventListener("click", onClick);
    layer.addEventListener("mousedown", onDown);
    host.addEventListener("toggle", schedule, true);
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    return () => {
      scroller.removeEventListener("mousemove", onMove);
      scroller.removeEventListener("mouseleave", onLeave);
      layer.removeEventListener("mouseover", onOver);
      layer.removeEventListener("click", onClick);
      layer.removeEventListener("mousedown", onDown);
      host.removeEventListener("toggle", schedule, true);
      ro.disconnect();
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a mode or reader setting change may reflow every block
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(schedule, [mode, layoutKey, refPath, !!onEdit]);

  return { refresh: schedule };
}
