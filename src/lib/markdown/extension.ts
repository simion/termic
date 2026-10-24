// The unit a markdown feature is built as. The engine registers each one's
// markdown-it plugin, folds its allow/trusted lists into the sanitizer and
// the claim pass, and the preview runs its viewState and hydrate around
// every rebuild. See docs/markdown.md for the pipeline and the trust rules.

import type MarkdownIt from "markdown-it";

export interface HydrateCtx {
  themeDark: boolean;
  /** the preview has a write path (PreviewEditTarget.canEdit): checkboxes
   *  and block edits are live. False for read-only previews. */
  canEdit: boolean;
  /** false once this render has been superseded (newer text, theme) or the
   *  preview unmounted. Async work checks it before touching the DOM. */
  isAlive(): boolean;
  /** run over any document content inserted AFTER the main claim (e.g. a
   *  mermaid SVG, which has its own sanitizer). See trust.ts. */
  claim(root: ParentNode): void;
  /** the previewed file's path (task-relative, or absolute for an external
   *  file), when there is one: what a copied heading link starts with. */
  filePath?: string;
  /** the element the preview scrolls, for an in-document jump (footnotes).
   *  Absent: the jump opens and flashes its target without scrolling. */
  scroller?: HTMLElement | null;
}

export interface MdExtension {
  name: string;
  /** markdown-it rules: core/block/inline rules, renderer overrides. */
  plugin?(md: MarkdownIt): void;
  /** extra tags/attrs the sanitizer lets through. Anything a document can
   *  also write, so never anything the preview trusts. */
  allow?: { tags?: string[]; attrs?: string[] };
  /** attrs only we may set (stampAttr) and tags only we may create
   *  (trustMark). Added to the allowlist automatically; claim() drops a
   *  document-written one. */
  trusted?: { attrs?: string[]; tags?: string[] };
  /** post-mount pass, after every rebuild. Returns an optional cleanup run
   *  before the next rebuild or on unmount. */
  hydrate?(host: HTMLElement, cx: HydrateCtx): void | (() => void);
  /** reader state the full innerHTML rebuild would otherwise lose (which
   *  <details> are open). capture() runs on the old DOM, restore() on the
   *  new one after claim and before hydrate. */
  viewState?: {
    capture(host: HTMLElement): unknown;
    restore(host: HTMLElement, state: unknown): void;
  };
}
