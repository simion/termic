// Fenced code: the line stamps go on the <pre> (the block in the flow), and
// ```mermaid fences become a placeholder rendered to SVG after mount by
// mermaid (securityLevel: "strict"), lazy-imported so the large chunk only
// lands when a diagram is actually previewed.

import type { MdExtension } from "../extension";
import { i18n } from "@/lib/i18n";

// Monotonic id source for mermaid render targets. Math.random/Date.now are
// avoided elsewhere in this codebase; a plain counter is deterministic enough.
let mermaidSeq = 0;

let mermaidMod: typeof import("mermaid").default | null = null;
async function getMermaid() {
  if (!mermaidMod) mermaidMod = (await import("mermaid")).default;
  return mermaidMod;
}

function renderMermaidError(el: HTMLElement, message: string, src: string) {
  el.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "mermaid-error";
  pre.textContent = `${i18n.t("panels:mdPreview.mermaidError", { message })}\n\n${src}`;
  el.appendChild(pre);
}

export const fence: MdExtension = {
  name: "fence",
  // `data-mermaid` is listed explicitly rather than via ALLOW_DATA_ATTR so
  // the data-* surface stays exactly one attribute wide. It grants nothing
  // new: a ```mermaid fence already renders author-controlled diagram source.
  allow: { attrs: ["data-mermaid"] },
  plugin(md) {
    const defaultFence = md.renderer.rules.fence!;
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const tok = tokens[idx];
      const info = tok.info.trim().split(/\s+/)[0]?.toLowerCase();
      const at = tok.attrGet("data-src-line");
      const lines = at ? ` data-src-line="${at}" data-src-end="${tok.attrGet("data-src-end")}"` : "";
      if (info === "mermaid") {
        // Stash the diagram source URI-encoded in a data attr; rendered to SVG
        // by hydrate below (mermaid.render is async).
        return `<div class="mermaid-block"${lines} data-mermaid="${encodeURIComponent(tok.content)}"></div>`;
      }
      // the default fence puts token attrs on the inner <code>; the lines belong
      // on the <pre>, which is the block that actually sits in the flow.
      tok.attrs = tok.attrs?.filter(([k]) => k !== "data-src-line" && k !== "data-src-end") ?? null;
      return defaultFence(tokens, idx, options, env, self).replace(/^<pre/, `<pre${lines}`);
    };
  },
  hydrate(host, cx) {
    const blocks = Array.from(host.querySelectorAll<HTMLElement>(".mermaid-block"));
    if (blocks.length === 0) return;
    void (async () => {
      let mermaid: typeof import("mermaid").default;
      try {
        mermaid = await getMermaid();
        if (!cx.isAlive()) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: cx.themeDark ? "dark" : "default",
        });
      } catch (e) {
        // Import or init failed: surface it on every block instead of
        // leaving silent gaps, and log so it reaches the debug log.
        console.error("[markdown-preview] mermaid load/init failed:", e);
        if (cx.isAlive()) blocks.forEach(el => renderMermaidError(el, String(e), decodeURIComponent(el.dataset.mermaid || "")));
        return;
      }
      for (const el of blocks) {
        if (!cx.isAlive()) return;
        const src = decodeURIComponent(el.dataset.mermaid || "");
        try {
          const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
          if (!cx.isAlive()) return;
          el.innerHTML = svg;
          cx.claim(el);
        } catch (e) {
          console.error("[markdown-preview] mermaid render failed:", e);
          if (!cx.isAlive()) return;
          renderMermaidError(el, String(e), src);
        }
      }
    })();
  },
};
