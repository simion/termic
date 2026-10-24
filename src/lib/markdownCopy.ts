// What ⌘C puts on the clipboard from the rendered markdown preview.
//
// The job is "paste into Slack / a doc and keep the links, bold, lists and
// code". WebKit's own copy of a selection gets the structure right but inlines
// every COMPUTED style into the HTML: the theme's near-white text colour,
// Inter, the dark code background. Paste that into anything with a light
// surface and it arrives as invisible white text in the wrong font. So the
// preview serializes the selection itself: the same elements, no styles, no
// classes, and nothing a paste target cannot resolve.
//
// DOM-only, no Tauri, so it is unit-testable under happy-dom.

import { WIDE_CLASS } from "@/lib/markdown/extensions/breakout";
import { SLOT_ATTR } from "@/lib/markdown/trust";


/** The `<mark>` around the text a review comment quotes (previewComments).
 *  Overlay like find's, so copy unwraps it. A document's own `tc-*` classes
 *  are stripped by the claim pass (lib/markdown/trust). */
export const QUOTE_CLASS = "tc-md-quote";

/** Attributes that survive, per tag. Everything else (class, style, data-*,
 *  ids from heading anchors, title hints) is termic's, not the document's. */
const KEEP_ATTRS: Record<string, readonly string[]> = {
  A: ["href"],
  IMG: ["src", "alt"],
  OL: ["start"],
  TD: ["align", "colspan", "rowspan"],
  TH: ["align", "colspan", "rowspan"],
  INPUT: ["type", "checked", "disabled"],
};

/** Containers a partial selection must be re-wrapped in, or the paste loses
 *  what makes it that structure: rows without a table paste as run-on text,
 *  items without their list paste without bullets, and lines out of a code
 *  block lose their monospace. Everything else (a paragraph, a heading, a
 *  strong) is what the user selected INSIDE of, and wrapping a few selected
 *  words in it would paste as a new block they did not ask for. */
const REWRAP = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TR", "PRE"]);

/** A link or image only helps a paste target if it can resolve it there. */
const PORTABLE_URL = /^(https?:|mailto:)/i;

function clean(root: Node): void {
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const els: Element[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) els.push(n as Element);
  for (const el of els) {
    const tag = el.tagName;
    // review-comment cards are app UI, not the document
    if (el.hasAttribute(SLOT_ATTR)) {
      el.remove();
      continue;
    }
    // the breakout wrapper is layout, not structure: a paste gets the table
    // or code block it holds, not a <div> around it
    if (tag === "DIV" && el.classList.contains(WIDE_CLASS)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    // Find-in-preview and comment-quote highlights are termic's overlay, not
    // the document.
    if (tag === "MARK" && (el.classList.contains("md-find") || el.classList.contains(QUOTE_CLASS))) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    // A relative link points into a checkout the reader of the paste does not
    // have. Keep the words, drop the dead link.
    if (tag === "A" && !PORTABLE_URL.test(el.getAttribute("href") ?? "")) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    // Local images are data: URLs of the whole file, and blocked remote ones
    // have no src at all. Neither is worth megabytes of clipboard.
    if (tag === "IMG" && !PORTABLE_URL.test(el.getAttribute("src") ?? "")) {
      el.remove();
      continue;
    }
    const keep = KEEP_ATTRS[tag] ?? [];
    for (const attr of Array.from(el.attributes)) {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    }
  }
}

/** HTML for a selection range inside `host`, ready for `text/html`. */
export function clipboardHtmlForRange(range: Range, host: HTMLElement): string {
  const doc = host.ownerDocument;
  let content: Node = range.cloneContents();
  let anc: Node | null = range.commonAncestorContainer;
  if (anc.nodeType !== Node.ELEMENT_NODE) anc = anc.parentNode;
  for (let el = anc as Element | null; el && el !== host && host.contains(el); el = el.parentElement) {
    // A code block's <code> goes with its <pre>: alone, the <pre> pastes as
    // preformatted text, which Slack does not render as a code block.
    const codeInPre = el.tagName === "CODE" && el.parentElement?.tagName === "PRE";
    if (!REWRAP.has(el.tagName) && !codeInPre) continue;
    const shell = el.cloneNode(false);
    shell.appendChild(content);
    content = shell;
  }
  const box = doc.createElement("div");
  box.appendChild(content);
  clean(box);
  return box.innerHTML;
}
