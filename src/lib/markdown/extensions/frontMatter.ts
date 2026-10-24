// front matter: `---` on the document's first line through the next
// `---` or `...` line renders as a compact key/value card instead of an
// <hr> and a paragraph of YAML. Only at the very top of the root document.
// No YAML library: top-level `key: value` lines become pairs, every other
// line (nested maps, lists, block scalars, comments) goes in a collapsed raw
// area. The card is one stamped block, so comments and line numbers work on
// it; DocModel.frontMatter carries the same pairs.

import type { MdExtension } from "../extension";
import type { FrontMatter } from "../model";
import { i18n } from "@/lib/i18n";

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
// a plain one-line value: not a block scalar (| >), not a comment. Greedy,
// trimmed after: a lazy `.*?` against `[ \t]*$` backtracks quadratically on
// a long whitespace run inside the value.
const PAIR = /^([A-Za-z0-9_][\w.-]*)[ \t]*:[ \t]+([^|>#\s].*)$/;
// a key whose value is nested below it (`tags:` then `  - a`) or a block
// scalar (`description: |`): YAML too, it just has no one-line pair
const KEY_ONLY = /^[A-Za-z0-9_][\w.-]*[ \t]*:[ \t]*(?:[|>][-+]?[ \t]*)?$/;

function unwrap(v: string): string {
  const m = /^"(.*)"$|^'(.*)'$|^\[(.*)\]$/.exec(v);
  return m ? (m[1] ?? m[2] ?? m[3]) : v;
}

/** exported for tests. */
export function parseFrontMatter(lines: readonly string[]): Pick<FrontMatter, "pairs" | "raw"> {
  const pairs: FrontMatter["pairs"] = [];
  const raw: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = PAIR.exec(line);
    if (m) pairs.push([m[1], unwrap(m[2].trimEnd())]);
    else raw.push(line);
  }
  return { pairs, raw };
}

const PILL_KEYS = new Set(["status", "state"]);

export const frontMatter: MdExtension = {
  name: "frontMatter",
  plugin(md) {
    md.block.ruler.before("table", "front_matter", (state, startLine, endLine, silent) => {
      if (startLine !== 0 || state.parentType !== "root" || state.level !== 0) return false;
      const line = (l: number) => state.src.slice(state.bMarks[l], state.eMarks[l]);
      // a UTF-8 BOM (Windows editors write one) is not part of the fence
      if (!OPEN.test(line(0).replace(/^\uFEFF/, ""))) return false;
      let close = 1;
      while (close < endLine && !CLOSE.test(line(close))) close++;
      if (close >= endLine) return false; // never closed: an <hr>, as before
      const body: string[] = [];
      for (let l = 1; l < close; l++) body.push(line(l));
      const meta = parseFrontMatter(body);
      // no top-level key means not YAML front matter, just a doc opening
      // with a rule: render it as markdown, as GitHub does
      if (!meta.pairs.length && !body.some(l => KEY_ONLY.test(l))) return false;
      if (silent) return true;
      const t = state.push("front_matter", "", 0);
      t.block = true;
      t.map = [0, close + 1];
      t.meta = meta;
      state.line = close + 1;
      return true;
    });
    md.renderer.rules.front_matter = (tokens, idx, _opts, _env, self) => {
      const t = tokens[idx];
      const { pairs, raw } = t.meta as Pick<FrontMatter, "pairs" | "raw">;
      const esc = md.utils.escapeHtml;
      let html = `<div class="front-matter"${self.renderAttrs(t)}>`
        + `<span class="fm-label">${esc(i18n.t("panels:mdExt.frontMatter.label"))}</span>`;
      for (const [k, v] of pairs) {
        const cls = PILL_KEYS.has(k.toLowerCase()) ? "fm-v fm-pill" : "fm-v";
        html += `\n<span class="fm-pair"><span class="fm-k">${esc(k)}</span> <span class="${cls}">${esc(v)}</span></span>`;
      }
      if (raw.length) {
        html += `\n<details class="fm-raw"><summary>${esc(i18n.t("panels:mdExt.frontMatter.raw"))}</summary>`
          + `<pre><code>${esc(raw.join("\n"))}</code></pre></details>`;
      }
      return `${html}</div>\n`;
    };
  },
};
