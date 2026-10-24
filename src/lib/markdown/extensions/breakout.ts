// Wide content: top-level tables, code blocks (mermaid included) and
// image-only paragraphs are wrapped in <div class="md-wide">, which may run
// wider than the text measure (index.css "Markdown reader layout"). The
// wrapper is a plain html_block token with no map, so it carries no line
// stamps: those stay on the block inside it, where scroll sync, comments and
// the gutter look for them.
//
// ponytail: top level only. A table inside a list item stays at the measure;
// breaking it out would mean escaping the list's indent too.

import type Token from "markdown-it/lib/token.mjs";
import type { MdExtension } from "../extension";

/** The wrapper's class. Copy unwraps it (lib/markdownCopy). A document can
 *  write one too, which only buys it the same layout. */
export const WIDE_CLASS = "md-wide";
/** A mermaid wrapper takes the full wide width and centers its diagram, since
 *  an SVG has no max-content width to size the box by. */
export const WIDE_FILL_CLASS = "md-wide-fill";

// images, linked images (a README's badge row) and the whitespace between them
const IMAGE_ONLY = new Set(["image", "link_open", "link_close", "softbreak"]);
const isImageOnly = (inline: Token | undefined) => {
  const kids = inline?.children ?? [];
  return kids.some(c => c.type === "image")
    && kids.every(c => IMAGE_ONLY.has(c.type) || (c.type === "text" && !c.content.trim()));
};

/** Index of the last token of the wide block starting at `i`, or -1. */
function wideEnd(tokens: Token[], i: number): number {
  const t = tokens[i];
  if (t.type === "fence" || t.type === "code_block") return i;
  if (t.type === "table_open") {
    for (let j = i + 1; j < tokens.length; j++) if (tokens[j].type === "table_close" && tokens[j].level === 0) return j;
  }
  if (t.type === "paragraph_open" && tokens[i + 2]?.type === "paragraph_close" && isImageOnly(tokens[i + 1])) return i + 2;
  return -1;
}

export const breakout: MdExtension = {
  name: "breakout",
  plugin(md) {
    md.core.ruler.push("breakout", (state) => {
      const src = state.tokens;
      const out: Token[] = [];
      const html = (content: string) => {
        const t = new state.Token("html_block", "", 0);
        t.content = content;
        t.block = true;
        return t;
      };
      for (let i = 0; i < src.length; i++) {
        const end = src[i].level === 0 ? wideEnd(src, i) : -1;
        if (end < 0) { out.push(src[i]); continue; }
        const mermaid = src[i].type === "fence" && src[i].info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
        out.push(html(`<div class="${mermaid ? `${WIDE_CLASS} ${WIDE_FILL_CLASS}` : WIDE_CLASS}">\n`));
        for (let j = i; j <= end; j++) out.push(src[j]);
        out.push(html("</div>\n"));
        i = end;
      }
      state.tokens = out;
    });
  },
};
