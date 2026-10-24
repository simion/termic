// stamp every rendered block with the 1-based inclusive source lines it came
// from, so the preview can be mapped back onto the editor (scroll sync, and
// which lines a comment made on rendered text points at). Trusted: a stamp
// the document wrote itself is dropped by claim().

import type { MdExtension } from "../extension";
import { blockEnd, docLines, isLineBlock } from "../model";
import { stampAttr } from "../trust";

export const srcLines: MdExtension = {
  name: "srcLines",
  trusted: { attrs: ["data-src-line", "data-src-end"] },
  plugin(md) {
    md.core.ruler.push("src_lines", (state) => {
      const lines = docLines(state);
      for (const t of state.tokens) {
        if (!isLineBlock(t)) continue;
        stampAttr(t, "data-src-line", t.map![0] + 1);
        stampAttr(t, "data-src-end", blockEnd(lines, t.map!));
      }
    });
  },
};
