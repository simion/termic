// Slots: app UI living INSIDE the rendered preview's innerHTML-built
// document (review-comment cards and composers, the block editor). A slot is
// a <div SLOT_ATTR> the owner keeps a reference to and puts back after every
// rebuild of the document, so its contents (a half-typed comment, an open
// CodeMirror) outlive the rebuild. Find, copy and selection skip SLOT_ATTR,
// and the claim pass strips it from document content (lib/markdown/trust).

import { EditorView } from "@codemirror/view";
import { SLOT_ATTR } from "@/lib/markdown/trust";
import { elRange } from "@/lib/markdown/lines";

/** Whether `t` is app UI living in the document (a slot, or chrome marked
 *  SLOT_ATTR such as a code header). The preview's delegated handlers ask
 *  this first: the document's own elements wrap the chrome, so a closest()
 *  for an <a> or a block from inside it finds the document's. */
export function inChrome(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest(`[${SLOT_ATTR}]`);
}

export function newSlot(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute(SLOT_ATTR, "");
  return el;
}

/** The innermost stamped elements of `stamped` (document order) that touch
 *  lines startLine..endLine: the list item, not the list. */
export function innermostBlocks(stamped: HTMLElement[], startLine: number, endLine: number): HTMLElement[] {
  const hits = stamped.filter(el => { const r = elRange(el); return !!r && r.startLine <= endLine && r.endLine >= startLine; });
  // in document order a block's stamped descendants follow it directly, so
  // a hit is innermost unless the next hit is inside it
  return hits.filter((el, i) => !hits[i + 1] || !el.contains(hits[i + 1]));
}

/** Put `slot` right after `ref` (first in `host` when null), only if it is
 *  not there already: moving a node detaches it, and a detached field loses
 *  focus mid-sentence. */
export function keepAfter(host: HTMLElement, slot: Element, ref: Element | null): void {
  if (ref ? ref.nextSibling !== slot : host.firstChild !== slot) {
    if (ref) ref.after(slot); else host.prepend(slot);
  }
}

/** Replace the host's document (`render`), then put every slot back
 *  (`place`). The rebuild detaches the slots, and a detached field drops
 *  focus, so a focused textarea gets its caret back and a CodeMirror its
 *  focus (its selection lives in its state, EditorView.focus restores it). */
export function rebuildWithSlots(host: HTMLElement, render: () => void, place: () => void): void {
  const active = document.activeElement;
  const inSlot = active instanceof HTMLElement && host.contains(active) && !!active.closest(`[${SLOT_ATTR}]`);
  const caret = inSlot && active instanceof HTMLTextAreaElement
    ? { el: active, from: active.selectionStart, to: active.selectionEnd } : null;
  const cmDom = inSlot ? active.closest<HTMLElement>(".cm-editor") : null;
  const cm = cmDom ? EditorView.findFromDOM(cmDom) : null;
  render();
  place();
  if (caret) {
    caret.el.focus({ preventScroll: true });
    caret.el.setSelectionRange(caret.from, caret.to);
  } else if (cm?.dom.isConnected) {
    cm.focus();
  }
}
