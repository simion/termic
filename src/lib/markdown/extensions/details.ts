// raw <details>/<summary> already render (base allowlist). What the full
// rebuild loses is which ones the reader opened: every buffer change or
// agent write used to collapse them all. This captures the open ones off the
// old DOM and reopens their counterparts in the new one.
//
// A details is keyed by its summary text plus the first source line stamped
// inside it (the raw <details> tag itself is an html_block and carries no
// stamp). Restore matches on summary and takes the closest line, so an edit
// above that shifts every line still finds the same block.

import type { MdExtension } from "../extension";

type Key = { summary: string; line: number };
type Saved = Key & { open: boolean };

function keyOf(d: HTMLDetailsElement): Key {
  let summary = "";
  for (const c of Array.from(d.children)) {
    if (c.tagName === "SUMMARY") { summary = (c.textContent ?? "").trim(); break; }
  }
  const stamped = d.querySelector("[data-src-line]");
  return { summary, line: Number(stamped?.getAttribute("data-src-line") ?? 0) };
}

export const details: MdExtension = {
  name: "details",
  // both states are kept: a `<details open>` the reader closed stays closed.
  viewState: {
    capture(host): Saved[] {
      return Array.from(host.querySelectorAll<HTMLDetailsElement>("details"), d => ({ ...keyOf(d), open: d.open }));
    },
    restore(host, state) {
      const saved = state as Saved[] | undefined;
      if (!saved?.length) return;
      // both lists are in document order, so lines rise within a summary:
      // walk each summary's candidates with one cursor that only moves
      // forward, taking the closest line still ahead of it.
      const free = new Map<string, { d: HTMLDetailsElement; line: number }[]>();
      for (const d of Array.from(host.querySelectorAll<HTMLDetailsElement>("details"))) {
        const k = keyOf(d);
        let bucket = free.get(k.summary);
        if (!bucket) free.set(k.summary, bucket = []);
        bucket.push({ d, line: k.line });
      }
      const cursor = new Map<string, number>();
      for (const want of saved) {
        const bucket = free.get(want.summary);
        let i = cursor.get(want.summary) ?? 0;
        if (!bucket || i >= bucket.length) continue;
        const dist = (j: number) => Math.abs(bucket[j].line - want.line);
        while (i + 1 < bucket.length && dist(i + 1) < dist(i)) i++;
        bucket[i].d.open = want.open;
        cursor.set(want.summary, i + 1);
      }
    },
  },
};

/** open every <details> around `el`, so a find match inside one is visible. */
export function revealInDetails(el: Element): void {
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
}
