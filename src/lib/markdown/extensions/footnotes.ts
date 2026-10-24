// footnotes, `[^1]` and `^[inline]`, via markdown-it-footnote. The preview
// emits no element ids, so the plugin's `#fn1` / `#fnref1` anchors are
// rewritten to trusted attrs and a delegated click does the jumping:
//   note:      <li data-fn="1">
//   reference: <sup><a data-fnref="1:0">   (note 1, its first reference)
//   back link: <a class="footnote-backref" data-fnref="1:0">
// A definition's <li> carries the line stamps of its source lines.

import footnote from "markdown-it-footnote";
import type Token from "markdown-it/lib/token.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type { MdExtension } from "../extension";
import { NONCE } from "../trust";
import { flashTo } from "../reveal";
import { i18n } from "@/lib/i18n";

const trusted = (name: string, v: string | number) => ` ${name}="${NONCE}${v}"`;
const refId = (t: Token) => `${t.meta.id + 1}:${t.meta.subId ?? 0}`;

type Note = { label?: string; count: number; tokens?: Token[]; content?: string };

// markdown-it-footnote 4.0.0's footnote_tail, token for token, except that it
// appends each note with push where upstream does `state.tokens =
// state.tokens.concat(tokens)` per note: O(notes x tokens), seconds on a doc
// of many ^[inline] notes.
function footnoteTail(state: StateCore) {
  const fn = state.env.footnotes as { list?: Note[] } | undefined;
  if (!fn) return;
  const refTokens = new Map<string, Token[]>();
  let current: Token[] = [];
  let insideRef = false;
  state.tokens = state.tokens.filter((tok) => {
    if (tok.type === "footnote_reference_open") {
      insideRef = true;
      current = [];
      refTokens.set(tok.meta.label, current);
      return false;
    }
    if (tok.type === "footnote_reference_close") { insideRef = false; return false; }
    if (insideRef) current.push(tok);
    return !insideRef;
  });
  if (!fn.list) return;
  const out = state.tokens;
  out.push(new state.Token("footnote_block_open", "", 1));
  let tokens: Token[] | undefined;
  fn.list.forEach((note, i) => {
    const open = new state.Token("footnote_open", "", 1);
    open.meta = { id: i, label: note.label };
    out.push(open);
    if (note.tokens) {
      const po = new state.Token("paragraph_open", "p", 1);
      po.block = true;
      const inline = new state.Token("inline", "", 0);
      inline.children = note.tokens;
      inline.content = note.content ?? "";
      const pc = new state.Token("paragraph_close", "p", -1);
      pc.block = true;
      tokens = [po, inline, pc];
    } else if (note.label) {
      tokens = refTokens.get(note.label);
    }
    if (tokens) for (const t of tokens) out.push(t);
    const lastParagraph = out[out.length - 1].type === "paragraph_close" ? out.pop() : null;
    for (let j = 0; j < Math.max(note.count, 1); j++) {
      const a = new state.Token("footnote_anchor", "", 0);
      a.meta = { id: i, subId: j, label: note.label };
      out.push(a);
    }
    if (lastParagraph) out.push(lastParagraph);
    out.push(new state.Token("footnote_close", "", -1));
  });
  out.push(new state.Token("footnote_block_close", "", -1));
}

export const footnotes: MdExtension = {
  name: "footnotes",
  trusted: { attrs: ["data-fn", "data-fnref"] },
  plugin(md) {
    md.use(footnote);
    md.core.ruler.at("footnote_tail", footnoteTail);
    const r = md.renderer.rules;
    r.footnote_ref = (tokens, idx) =>
      `<sup class="footnote-ref"><a${trusted("data-fnref", refId(tokens[idx]))}>${tokens[idx].meta.id + 1}</a></sup>`;
    r.footnote_block_open = () => `<ol class="footnotes">\n`;
    r.footnote_block_close = () => `</ol>\n`;
    r.footnote_open = (tokens, idx, _o, _env, self) =>
      `<li class="footnote-item"${trusted("data-fn", tokens[idx].meta.id + 1)}${self.renderAttrs(tokens[idx])}>`;
    r.footnote_anchor = (tokens, idx) =>
      ` <a class="footnote-backref"${trusted("data-fnref", refId(tokens[idx]))} title="${md.utils.escapeHtml(i18n.t("panels:mdExt.footnote.back"))}">↩︎</a>`;
    // the plugin builds each note's <li> token without a map: give it the
    // span of the definition's own tokens so srcLines stamps it. Inline
    // ^[notes] have no definition lines and stay unstamped.
    md.core.ruler.after("footnote_tail", "footnote_lines", (state) => {
      const ts = state.tokens;
      for (let i = 0; i < ts.length; i++) {
        if (ts[i].type !== "footnote_open") continue;
        let from = Infinity, to = -1, j = i + 1;
        for (; j < ts.length && ts[j].type !== "footnote_close"; j++) {
          const m = ts[j].map;
          if (m) { from = Math.min(from, m[0]); to = Math.max(to, m[1]); }
        }
        if (to >= 0) {
          ts[i].map = [from, to];
          ts[i].block = true;
        }
        i = j;
      }
    });
  },
  hydrate(host, cx) {
    const notes = new Map<string, HTMLElement>();
    for (const li of Array.from(host.querySelectorAll<HTMLElement>("li[data-fn]"))) notes.set(li.dataset.fn!, li);
    const refs = Array.from(host.querySelectorAll<HTMLElement>("a[data-fnref]:not(.footnote-backref)"));
    // hover shows the note: one title per note, not per reference, since a
    // note referenced N times holds N back links
    const titles = new Map<string, string>();
    for (const a of refs) {
      const id = a.dataset.fnref!.split(":")[0];
      const note = notes.get(id);
      if (!note) continue;
      let title = titles.get(id);
      if (title === undefined) titles.set(id, title = (note.textContent ?? "").split("↩︎").join("").trim());
      a.title = title;
    }
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[data-fnref]") as HTMLElement | null;
      if (!a || !host.contains(a)) return;
      e.preventDefault();
      const id = a.dataset.fnref!;
      const target = a.classList.contains("footnote-backref")
        ? refs.find(r => r.dataset.fnref === id)
        : notes.get(id.split(":")[0]);
      if (target) flashTo(cx.scroller ?? null, target);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  },
};
