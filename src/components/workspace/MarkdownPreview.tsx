// Rendered Markdown view for .md/.markdown/.mdx files. Parses with
// markdown-it (raw HTML disabled — the WKWebView has Tauri IPC reach, so a
// malicious README must never inject script) and renders ```mermaid fenced
// blocks as SVG diagrams via mermaid (securityLevel: "strict").
//
// The rendered HTML is written into the host element IMPERATIVELY (not via
// React's dangerouslySetInnerHTML). React must NOT own this subtree: mermaid
// writes SVG into the .mermaid-block children asynchronously, and if React
// reconciled the same nodes it would wipe those diagrams on the next render.
// So this component owns one <div ref> and drives all of its contents by hand.
//
// markdown-it + mermaid are both heavy; this whole component is lazy-loaded
// (see WorkspaceView) and mermaid is further dynamic-imported on first render
// so the chunk only lands when a markdown file is actually previewed.

import { useEffect, useRef } from "react";
import MarkdownIt from "markdown-it";
import { openPath } from "@/lib/ipc";

// Monotonic id source for mermaid render targets. Math.random/Date.now are
// avoided elsewhere in this codebase; a plain counter is deterministic enough.
let mermaidSeq = 0;

// One markdown-it instance, reused across renders. html:false escapes raw
// HTML; linkify autolinks bare URLs; we intercept ```mermaid fences below.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = tokens[idx].info.trim().split(/\s+/)[0]?.toLowerCase();
  if (info === "mermaid") {
    // Stash the diagram source URI-encoded in a data attr; rendered to SVG
    // after the HTML is injected (mermaid.render is async).
    return `<div class="mermaid-block" data-mermaid="${encodeURIComponent(tokens[idx].content)}"></div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// mermaid is imported lazily so the (large) chunk only loads on first preview.
let mermaidMod: typeof import("mermaid").default | null = null;
async function getMermaid() {
  if (!mermaidMod) mermaidMod = (await import("mermaid")).default;
  return mermaidMod;
}

function renderMermaidError(el: HTMLElement, message: string, src: string) {
  el.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "mermaid-error";
  pre.textContent = `Mermaid render error: ${message}\n\n${src}`;
  el.appendChild(pre);
}

export function MarkdownPreview({ text, themeDark }: { text: string; themeDark: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Single imperative effect: parse → inject → hydrate mermaid. Re-runs when
  // the buffer text or the theme changes. `alive` cancels a stale run when a
  // newer one supersedes it (or on unmount) mid async-render.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = md.render(text || "");
    const blocks = Array.from(host.querySelectorAll<HTMLElement>(".mermaid-block"));
    if (blocks.length === 0) return;

    let alive = true;
    (async () => {
      let mermaid: typeof import("mermaid").default;
      try {
        mermaid = await getMermaid();
        if (!alive) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: themeDark ? "dark" : "default",
        });
      } catch (e) {
        // Import or init failed — surface it on every block instead of
        // leaving silent gaps, and log so it reaches the debug log.
        console.error("[markdown-preview] mermaid load/init failed:", e);
        if (alive) blocks.forEach(el => renderMermaidError(el, String(e), decodeURIComponent(el.dataset.mermaid || "")));
        return;
      }
      for (const el of blocks) {
        if (!alive) return;
        const src = decodeURIComponent(el.dataset.mermaid || "");
        try {
          const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
          if (!alive) return;
          el.innerHTML = svg;
        } catch (e) {
          console.error("[markdown-preview] mermaid render failed:", e);
          if (!alive) return;
          renderMermaidError(el, String(e), src);
        }
      }
    })();
    return () => { alive = false; };
  }, [text, themeDark]);

  // Intercept link clicks: a bare <a href> would navigate the whole webview
  // (and blow away the app). Route external links to the OS opener instead.
  function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) openPath(href);
  }

  return (
    <div className="h-full overflow-auto bg-[var(--color-bg)]">
      <div ref={hostRef} className="markdown-body mx-auto max-w-[820px] px-8 py-6" onClick={onClick} />
    </div>
  );
}
