// What a document may NOT say about itself.
//
// Raw HTML in a document passes the sanitizer with whatever allowlisted
// attributes it wrote, so anything the preview treats as a fact about the
// source (a block's line range, "this checkbox is task line 12") cannot be
// read straight off the DOM. Ours carry a per-load nonce the document cannot
// know, and claim() runs over every piece of document content once it is in
// the preview: it unwraps our values and drops every forged one.
//
// Three kinds of thing are guarded:
// - trusted attrs: only a markdown-it rule of ours may set them (via
//   stampAttr). claim() strips the nonce from ours and removes the rest.
// - trusted tags: elements only we may create (a task checkbox <input>).
//   Ours carry TRUST_MARK=nonce; claim() removes every one that does not and
//   strips the mark from the survivors.
// - UI-chrome markers (SLOT_ATTR, data-tc-commented, tc-* classes) that find,
//   copy and selection use to skip app UI living inside the document. A
//   document never gets to carry one.
//
// claim() runs EXACTLY ONCE per fresh piece of content: a second pass over
// already-claimed nodes would read our unwrapped values as forged.

import type Token from "markdown-it/lib/token.mjs";

/** Marks app UI living inside the rendered preview's document (slots, the
 *  code header, heading links), which find, copy, selection and the link
 *  click all skip. Defined here, beside the claim pass that enforces it: a
 *  document cannot forge one, because the sanitizer strips unlisted `data-*`
 *  and claim strips it from mermaid output, which has its own sanitizer. */
export const SLOT_ATTR = "data-tc-slot";

/** Per-load nonce. Never rendered as-is: claim() unwraps it. */
export const NONCE = `${crypto.randomUUID()}:`;

/** Marks an element of a trusted tag as ours. Renderers that emit raw HTML
 *  write `${TRUST_MARK}="${NONCE}"` on it (see trustMark()). */
export const TRUST_MARK = "data-md-trust";

/** Set a trusted attribute on a markdown-it token. */
export function stampAttr(token: Token, name: string, value: string | number): void {
  token.attrSet(name, NONCE + value);
}

/** The ` data-md-trust="…"` fragment for a renderer writing a trusted tag
 *  as a raw string. */
export function trustMark(): string {
  return ` ${TRUST_MARK}="${NONCE}"`;
}

export type Trusted = { attrs: readonly string[]; tags: readonly string[] };

/** Build the claim pass for one set of trusted attrs and tags. The engine
 *  builds the real one from its extensions (import `claim` from engine). */
export function createClaim({ attrs, tags }: Trusted): (root: ParentNode) => void {
  const attrSel = attrs.map(a => `[${a}]`).join(", ");
  const tagSel = tags.join(", ");
  return (root) => {
    if (attrSel) {
      for (const el of Array.from(root.querySelectorAll(attrSel))) {
        for (const a of attrs) {
          const v = el.getAttribute(a);
          if (v == null) continue;
          if (v.startsWith(NONCE)) el.setAttribute(a, v.slice(NONCE.length));
          else el.removeAttribute(a);
        }
      }
    }
    if (tagSel) {
      for (const el of Array.from(root.querySelectorAll(tagSel))) {
        if (el.getAttribute(TRUST_MARK) !== NONCE) el.remove();
      }
    }
    // the mark itself, wherever it ended up (ours or written on a plain tag)
    for (const el of Array.from(root.querySelectorAll(`[${TRUST_MARK}]`))) el.removeAttribute(TRUST_MARK);
    for (const el of Array.from(root.querySelectorAll(`[${SLOT_ATTR}], [data-tc-commented]`))) {
      el.removeAttribute(SLOT_ATTR);
      el.removeAttribute("data-tc-commented");
    }
    for (const el of Array.from(root.querySelectorAll('[class*="tc-"]'))) {
      for (const c of Array.from(el.classList)) if (c.startsWith("tc-")) el.classList.remove(c);
    }
  };
}
