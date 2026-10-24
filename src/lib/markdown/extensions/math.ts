// math, with GitHub's rules: `$inline$` (no space just inside either `$`, and
// the closing `$` not followed by a digit, so `$5 and $10` stays text),
// `$$` blocks starting and ending on their own lines, and ```math fences.
//
// The parse emits a placeholder holding the TeX source as its text, and a
// hydrate lazily imports KaTeX (the 0.16.x mermaid already ships) to render
// it. Output is MathML ONLY: KaTeX's HTML output positions every glyph with
// inline `style`, which the preview never allows, while MathML needs no CSS,
// no fonts and no CSP change. KaTeX runs with `trust: false` (no \href,
// \htmlStyle, \includegraphics) and its output still goes through a
// MathML-only DOMPurify pass before it touches the DOM.

import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import DOMPurify from "dompurify";
import type { MdExtension } from "../extension";
import { i18n } from "@/lib/i18n";

const DOLLAR = 0x24;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax: max } = state;
  if (src.charCodeAt(pos) !== DOLLAR) return false;
  // `$$` inline is not math here (the block form is)
  if (src.charCodeAt(pos - 1) === DOLLAR || src.charCodeAt(pos + 1) === DOLLAR) return false;
  if (pos + 1 >= max || isSpace(src.charCodeAt(pos + 1))) return false;
  // the first unescaped `$` closes it or nothing does: scanning on past a
  // failed closer is what would turn `$5 and $10 ... $` into math.
  let end = pos + 1;
  for (; end < max; end++) {
    const c = src.charCodeAt(end);
    if (c === 0x5c) end++; // \$ and friends belong to the TeX
    else if (c === DOLLAR) break;
  }
  if (end >= max) return false;
  if (isSpace(src.charCodeAt(end - 1))) return false;
  const after = src.charCodeAt(end + 1);
  if (isDigit(after) || after === DOLLAR) return false;
  if (!silent) state.push("math_inline", "", 0).content = src.slice(pos + 1, end);
  state.pos = end + 1;
  return true;
}

// the last unclosed scan per context: a `$$` line inside the same run whose
// scan would hit the same stop line fails too. Without it, `$$` lines in one
// long paragraph rescan the rest of it each time, as a paragraph terminator.
// Keyed by context, not one slot: a block start runs as the container's type
// and a terminator check as "paragraph", and alternating the two evicted a
// single slot on every line (quadratic again).
type Miss = { from: number; to: number };
const misses = new WeakMap<StateBlock, Map<string, Miss>>();

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false; // indented code
  const lineAt = (l: number) => state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]).trim();
  const first = lineAt(startLine);
  if (!first.startsWith("$$")) return false;
  let last = startLine;
  let tex: string;
  if (first.length > 4 && first.endsWith("$$")) {
    tex = first.slice(2, -2); // `$$ x $$` on one line
  } else {
    const ctx = `${state.parentType}|${state.blkIndent}|${state.level}|${endLine}`;
    let byCtx = misses.get(state);
    if (!byCtx) misses.set(state, (byCtx = new Map()));
    const m = byCtx.get(ctx);
    if (m && startLine > m.from && startLine < m.to) return false;
    const parts = [first.slice(2)];
    let closed = false;
    // a blank line ends it unclosed, as on GitHub: a prose `$$` line never
    // swallows the doc up to some later `$$`
    for (last = startLine + 1; last < endLine; last++) {
      const s = lineAt(last);
      if (!s || state.sCount[last] < state.blkIndent) break; // or it left the container
      parts.push(s.endsWith("$$") ? s.slice(0, -2) : s);
      if ((closed = s.endsWith("$$"))) break;
    }
    if (!closed) {
      byCtx.set(ctx, { from: startLine, to: last });
      return false; // never closed: a paragraph, as before
    }
    tex = parts.join("\n");
  }
  if (!tex.trim()) return false;
  if (silent) return true;
  const t = state.push("math_block", "", 0);
  t.block = true;
  t.map = [startLine, last + 1];
  t.content = tex.trim();
  state.line = last + 1;
  return true;
}

function plugin(md: MarkdownIt) {
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  // ```math is the same block. Retyped before render, so the fence renderer
  // (and whatever wraps it) never sees it.
  md.core.ruler.after("block", "math_fence", (state) => {
    for (const t of state.tokens) {
      if (t.type === "fence" && t.info.trim().split(/\s+/)[0]?.toLowerCase() === "math") {
        t.type = "math_block";
        t.content = t.content.trim();
      }
    }
  });
  const esc = md.utils.escapeHtml;
  md.renderer.rules.math_inline = (tokens, idx) => `<span class="math-inline">${esc(tokens[idx].content)}</span>`;
  md.renderer.rules.math_block = (tokens, idx, _o, _env, self) =>
    `<div class="math-block"${self.renderAttrs(tokens[idx])}>${esc(tokens[idx].content)}</div>\n`;
}

// what KaTeX's MathML output uses, nothing more. No `id`, `href`, `style`,
// `class` or `xmlns`; <annotation> (the TeX source copy inside <semantics>)
// is dropped with its text, which would otherwise be kept as stray text.
// DOMPurify's own namespace check only lets MathML in through <math>.
const MATH_PURIFY = {
  ALLOWED_TAGS: [
    "math", "semantics", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace",
    "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mover", "munder", "munderover",
    "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom", "menclose",
  ],
  ALLOWED_ATTR: [
    "display", "displaystyle", "scriptlevel", "mathvariant", "mathcolor", "mathbackground",
    "stretchy", "fence", "separator", "lspace", "rspace", "minsize", "maxsize", "symmetric",
    "largeop", "movablelimits", "accent", "accentunder", "linethickness", "notation",
    "width", "height", "depth", "voffset", "columnalign", "columnspacing", "columnlines",
    "rowspacing", "rowlines", "frame", "framespacing",
  ],
  ADD_FORBID_CONTENTS: ["annotation", "annotation-xml"],
  ALLOW_DATA_ATTR: false,
};

type Katex = typeof import("katex").default;
let katexMod: Katex | null = null;
let katexLoad: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  return (katexLoad ??= import("katex").then(m => (katexMod = m.default)));
}

type Rendered = { html: string } | { error: string };
// every rebuild re-renders every formula; most of them did not change. An
// LRU, so a doc with more formulas than fit only re-renders the overflow.
const cache = new Map<string, Rendered>();
const CACHE_MAX = 1000;
// longer than any real formula: a hostile source this size would cost a
// synchronous render per rebuild and pin megabytes in a module-scoped cache.
const TEX_MAX = 5000;
// user macros are refused outright. maxExpand counts expansions, not output:
// `\def\b{<3k chars>}` then `\b` x999 is inside KaTeX's limit and still
// renders 29 MB of MathML. A preview has no use for them.
const MACRO_DEF = /\\(?:[gex]?def|let|futurelet|(?:re)?newcommand|providecommand|(?:re)?newenvironment)(?![a-zA-Z])/;
// a safety net for amplification without user macros: larger output is
// cached as an error, so it is paid once, never re-inserted per rebuild
const OUT_MAX = 256 * 1024;

/** sanitized MathML for a TeX source, or its parse error. Exported for tests. */
export function renderTex(katex: Katex, tex: string, display: boolean): Rendered {
  // english like KaTeX's own messages: it lands in the same error title
  if (tex.length > TEX_MAX) return { error: `source longer than ${TEX_MAX} characters` };
  if (MACRO_DEF.test(tex)) return { error: "macro definitions are not supported" };
  const key = (display ? "B" : "I") + tex;
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-set below: most recently used goes last
  } else {
    try {
      // maxSize caps \rule / \kern / \raisebox boxes (in em); maxExpand
      // is KaTeX's default, stated so it cannot drift up
      const raw = katex.renderToString(tex, {
        output: "mathml", displayMode: display, throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000,
      });
      hit = raw.length > OUT_MAX ? { error: "rendered output too large" } : { html: DOMPurify.sanitize(raw, MATH_PURIFY) };
    } catch (e) {
      hit = { error: e instanceof Error ? e.message : String(e) };
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, hit);
  return hit;
}

export const math: MdExtension = {
  name: "math",
  plugin,
  hydrate(host, cx) {
    // read the sources now: find and comment quotes skip these elements, so
    // the text is still exactly the TeX.
    const jobs = Array.from(host.querySelectorAll<HTMLElement>(".math-inline, .math-block"), el => ({
      el, tex: el.textContent ?? "", display: el.classList.contains("math-block"),
    }));
    if (!jobs.length) return;
    const run = (k: Katex) => {
      for (const { el, tex, display } of jobs) {
        // kept for headingText: a heading's slug is made from the TeX
        el.dataset.tex = tex;
        const r = renderTex(k, tex, display);
        if ("html" in r) {
          el.innerHTML = r.html;
          cx.claim(el);
        } else {
          el.classList.add("math-error");
          el.title = i18n.t("panels:mdExt.math.error", { message: r.error });
        }
      }
    };
    // loaded once: render in this same task, so a rebuild never paints the
    // raw TeX for a frame.
    if (katexMod) { run(katexMod); return; }
    loadKatex().then(
      (k) => { if (cx.isAlive()) run(k); },
      (e) => {
        console.error("[markdown-preview] katex load failed:", e);
        katexLoad = null; // let the next rebuild retry
      },
    );
  },
};
