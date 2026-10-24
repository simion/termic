// The markdown pipeline the preview renders through: one markdown-it
// instance, the registered extensions, the sanitizer allowlist composed from
// them, and the claim pass. Pure (no React); see docs/markdown.md.
//
// Raw HTML is PARSED (html: true, so the GitHub README idiom `<div
// align="center">` around an `<img>` renders at all) and then filtered
// through a DOMPurify allowlist before it reaches the DOM. The WKWebView has
// Tauri IPC reach, so a malicious README must never inject script;
// deny-by-default plus the CSP (script-src 'self', no 'unsafe-inline') is
// what keeps that true, not the absence of an HTML parser.

import MarkdownIt from "markdown-it";
import DOMPurify, { type UponSanitizeAttributeHook } from "dompurify";
import type { HydrateCtx, MdExtension } from "./extension";
import { buildModel, type DocModel } from "./model";
import { createClaim, TRUST_MARK } from "./trust";
import { srcLines } from "./extensions/srcLines";
import { fence } from "./extensions/fence";
import { taskList } from "./extensions/taskList";
import { breakout } from "./extensions/breakout";
import { alerts } from "./extensions/alerts";
import { details } from "./extensions/details";
import { frontMatter } from "./extensions/frontMatter";
import { codeHeader } from "./extensions/codeHeader";
import { headingLinks } from "./extensions/headingLinks";
import { footnotes } from "./extensions/footnotes";
import { deflist } from "./extensions/deflist";
import { mark } from "./extensions/mark";
import { math } from "./extensions/math";

/** Registration order is plugin order. breakout goes last: its core rule
 *  wraps finished blocks, after every other rule has shaped them. */
export const EXTENSIONS: readonly MdExtension[] = [
  srcLines, fence, frontMatter, alerts, details, taskList, codeHeader, headingLinks,
  footnotes, deflist, mark, math, breakout,
];

/** Everything the preview is allowed to render, whether markdown-it emitted it
 *  or a README hand-wrote it, before extensions add theirs. Deny-by-default:
 *  anything absent is dropped, so `script`, `iframe`, `object`, `form`,
 *  `style` and friends never appear by virtue of not being listed. Most of
 *  this list is just markdown-it's own output (`p`, `li`, `pre`, `table`, ...),
 *  and cutting it down would break ordinary markdown, not just raw HTML. The
 *  entries GitHub READMEs lean on: div, img, br, details, summary, sub, sup,
 *  kbd, span. */
const BASE_TAGS = [
  "p", "br", "hr", "div", "span", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "em", "strong", "s", "del", "ins", "mark", "sub", "sup", "kbd",
  "ul", "ol", "li", "dl", "dt", "dd",
  "pre", "code", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "details", "summary",
];

/** No `style` (CSS injection), no `on*` (DOMPurify strips those anyway, and the
 *  CSP has no 'unsafe-inline' so they could not fire regardless), no `srcset`.
 *  `class` is allowed because markdown-it stamps `language-*` on code blocks; a
 *  README setting its own class is inert without `style`. No data-* here:
 *  each one is an extension's, listed explicitly (ALLOW_DATA_ATTR stays off). */
const BASE_ATTRS = [
  "href", "src", "alt", "title", "align",
  "width", "height", "class", "colspan", "rowspan", "start",
];

const uniq = (xs: string[]) => [...new Set(xs)];
const TRUSTED_ATTRS = uniq(EXTENSIONS.flatMap(e => e.trusted?.attrs ?? []));
const TRUSTED_TAGS = uniq(EXTENSIONS.flatMap(e => e.trusted?.tags ?? []));

/** Exported for tests. */
export const ALLOWED_TAGS = uniq([...BASE_TAGS, ...EXTENSIONS.flatMap(e => e.allow?.tags ?? []), ...TRUSTED_TAGS]);
/** Exported for tests. */
export const ALLOWED_ATTR = uniq([
  ...BASE_ATTRS,
  ...EXTENSIONS.flatMap(e => e.allow?.attrs ?? []),
  ...TRUSTED_ATTRS,
  ...(TRUSTED_TAGS.length ? [TRUST_MARK] : []),
]);
const PURIFY = { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false };

/** `input` is on the allowlist only for the task checkbox (a trusted tag:
 *  claim removes any a document wrote), and `src` / `type` are there for
 *  `img` and the checkbox. So a document's `<input type="image" src=...>`
 *  would leave the sanitizer able to fetch, and only claim, run once it is in
 *  the DOM, would stop it. The sanitizer closes that itself: no input keeps a
 *  `src`, or a `type` other than checkbox. Scoped to renderDoc's own call,
 *  not a global hook, because other DOMPurify callers (lsp) share the
 *  instance. Exported for tests. */
export const inputCannotFetch: UponSanitizeAttributeHook = (node, data) => {
  if (node.nodeName !== "INPUT") return;
  if (data.attrName === "src" || (data.attrName === "type" && data.attrValue.trim().toLowerCase() !== "checkbox")) data.keepAttr = false;
};

/** Run on every piece of document content once it is in the preview. See
 *  trust.ts for what it unwraps and what it drops. */
export const claim = createClaim({ attrs: TRUSTED_ATTRS, tags: TRUSTED_TAGS });
/** The old name, kept for callers and tests. */
export const claimDocument = claim;

// One markdown-it instance, reused across renders. linkify autolinks bare
// URLs (toggled per render, see renderDoc).
const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
for (const e of EXTENSIONS) e.plugin?.(md);

/** Parse once, render, sanitize, and build the model from the same tokens.
 *  DOMPurify runs on the ASSEMBLED html, not per-token: markdown-it emits
 *  `<div align="center">` and its `</div>` as two separate html_block
 *  tokens, so sanitizing them in isolation would auto-close the opener and
 *  drop the closer, destroying the wrapper. This is how GitHub does it too.
 *  DOMPurify's URI check still blocks `javascript:` in href/src, and the CSP
 *  independently prevents inline script and handlers: three gates, not one.
 *
 *  `linkify: false` (the Changelog dialog) keeps bare filenames like
 *  CLAUDE.md from autolinking; set + render are synchronous, so the shared
 *  instance cannot bleed between callers. The html still carries our nonce
 *  stamps: claim() it once it is in the DOM. */
export function renderDoc(text: string, opts?: { linkify?: boolean }): { html: string; model: DocModel } {
  md.set({ linkify: opts?.linkify ?? true });
  const env: { lines?: string[] } = {};
  const tokens = md.parse(text, env);
  DOMPurify.addHook("uponSanitizeAttribute", inputCannotFetch);
  let html: string;
  try {
    html = DOMPurify.sanitize(md.renderer.render(tokens, md.options, env), PURIFY);
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute", inputCannotFetch);
  }
  return { html, model: buildModel(tokens, env.lines ?? text.replace(/\r\n?/g, "\n").split("\n")) };
}

/** renderDoc's html alone. */
export function renderSanitized(text: string): string {
  return renderDoc(text).html;
}

/** Each extension's view state, read off the DOM about to be replaced. */
export function captureViewState(host: HTMLElement): unknown[] {
  return EXTENSIONS.map(e => e.viewState?.capture(host));
}

export function restoreViewState(host: HTMLElement, saved: unknown[]): void {
  EXTENSIONS.forEach((e, i) => e.viewState?.restore(host, saved[i]));
}

/** Run every extension's hydrate; returns one cleanup for all of them. One
 *  that throws is logged and skipped: the rest still run, and the cleanups
 *  already collected are still returned. */
export function hydrate(host: HTMLElement, cx: HydrateCtx): () => void {
  const cleanups: (() => void)[] = [];
  for (const e of EXTENSIONS) {
    try {
      const c = e.hydrate?.(host, cx);
      if (c) cleanups.push(c);
    } catch (err) {
      console.error(`[markdown-preview] ${e.name} hydrate failed:`, err);
    }
  }
  return () => { for (const c of cleanups) c(); };
}
