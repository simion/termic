// a link button at the end of every heading, shown on hover, that copies
// `path#slug` for it. The slug comes from findHeading, the one walk a
// `file.md#slug` link is also resolved by (findHeadingBySlug), and it is
// computed at click time: by then math has rendered, and headingText reads
// math as its TeX either way, so the copied link always lands back here.
// SLOT_ATTR chrome with no text, so find, copy and headingText are unchanged.

import type { MdExtension } from "../extension";
import { SLOT_ATTR } from "@/lib/markdown/trust";
import { copyToClipboard } from "@/lib/clipboard";
import { headingSlug, headingSlugger } from "@/lib/markdownPaths";
import { i18n } from "@/lib/i18n";

const BTN = "md-heading-link";

/** A rendered heading's text the way its slug is made: inline math as its TeX
 *  source (math hydrate keeps it in `data-tex`), so the answer is the same
 *  before and after KaTeX runs, and matches the DocModel's heading text. */
export function headingText(h: Element): string {
  if (!h.querySelector(".math-inline")) return h.textContent || "";
  let s = "";
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) s += c.nodeValue;
      else if (c instanceof HTMLElement && c.classList.contains("math-inline")) s += c.dataset.tex ?? c.textContent ?? "";
      else walk(c);
    }
  };
  walk(h);
  return s;
}

/** The first heading in `host`, in DOM order, for which `pick` holds, with its
 *  GitHub slug (duplicates numbered over every heading, raw-HTML ones
 *  included). The one walk copy-link and `#fragment` resolution share. */
export function findHeading(host: Element, pick: (h: HTMLElement, slug: string) => boolean): { el: HTMLElement; slug: string } | null {
  const slug = headingSlugger();
  for (const el of Array.from(host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))) {
    const s = slug(headingText(el));
    if (pick(el, s)) return { el, slug: s };
  }
  return null;
}

export const headingLinks: MdExtension = {
  name: "headingLinks",
  hydrate(host, cx) {
    const tip = i18n.t("panels:mdExt.headingLink.tip");
    for (const h of Array.from(host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))) {
      if (h.closest(`[${SLOT_ATTR}]`) || !headingSlug(headingText(h))) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = BTN;
      btn.setAttribute(SLOT_ATTR, "");
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
      h.appendChild(btn);
    }
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.(`.${BTN}`) as HTMLElement | null;
      if (!btn?.hasAttribute(SLOT_ATTR) || !host.contains(btn)) return;
      const hit = findHeading(host, h => h === btn.parentElement);
      if (hit) void copyToClipboard(`${cx.filePath ?? ""}#${hit.slug}`, i18n.t("panels:mdExt.headingLink.label"));
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  },
};
