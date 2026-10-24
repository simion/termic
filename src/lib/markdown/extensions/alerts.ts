// callouts, as on GitHub: a blockquote whose first line is `[!NOTE]` (TIP,
// IMPORTANT, WARNING, CAUTION; any case) renders as a titled, coloured
// alert. The marker line has to stand alone, as on GitHub; anything else is
// a plain blockquote. The line stamps stay on the <blockquote>. The icon is
// a CSS mask on the title, so nothing new is allowlisted.

import type { MdExtension } from "../extension";
import { i18n } from "@/lib/i18n";

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

export const alerts: MdExtension = {
  name: "alerts",
  plugin(md) {
    // after block (the tokens exist), before inline (the paragraph's text is
    // still one string we can cut the marker off).
    md.core.ruler.after("block", "alerts", (state) => {
      const ts = state.tokens;
      for (let i = 0; i + 2 < ts.length; i++) {
        if (ts[i].type !== "blockquote_open" || ts[i + 1].type !== "paragraph_open") continue;
        const inline = ts[i + 2];
        const m = MARKER.exec(inline.content);
        if (!m) continue;
        const kind = m[1].toLowerCase();
        ts[i].meta = { ...ts[i].meta, alert: kind };
        ts[i].attrJoin("class", `markdown-alert markdown-alert-${kind}`);
        inline.content = inline.content.slice(m[0].length);
        if (inline.content.trim()) {
          // the paragraph now starts on the line after the marker
          if (ts[i + 1].map) ts[i + 1].map![0]++;
        } else {
          ts.splice(i + 1, 3); // the marker was the whole paragraph
        }
      }
    });
    const prev = md.renderer.rules.blockquote_open;
    md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
      const open = prev ? prev(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      const kind = tokens[idx].meta?.alert as string | undefined;
      if (!kind) return open;
      return `${open}<p class="markdown-alert-title">${md.utils.escapeHtml(i18n.t(`panels:mdExt.alert.${kind}`))}</p>\n`;
    };
  },
};
