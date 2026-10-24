// The preview's outline rail: h1-h3 from the DocModel (no DOM walk for the
// list), each with its source line, click to scroll there, and the section
// being read highlighted as the preview scrolls. See docs/ui.md "Outline".
//
// Perf rules, same spirit as the line gutter:
// - heading offsets are measured on a rebuild, a resize (ResizeObserver on
//   the document and the scroller: late images, mermaid, a reader setting
//   reflowing the text, the rail itself narrowing the pane) and a <details>
//   toggle, coalesced to one frame.
// - the scroll handler is rAF-throttled and reads scrollTop only, then a
//   search over the cached offsets. No layout reads on scroll.
// - the list re-renders only when the headings themselves change, not on
//   every rebuild of the document.

import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Heading } from "@/lib/markdown/model";
import { revealInDetails } from "@/lib/markdown/extensions/details";
import { cn } from "@/lib/utils";

/** where a heading counts as "being read": this far below the top */
const READ_LINE = 80;

const EMPTY: readonly Heading[] = [];

/** The outline's entries: h1-h3. Exported for tests. */
export function outlineHeadings(all: readonly Heading[] | undefined): readonly Heading[] {
  const h = all?.filter(x => x.level <= 3) ?? [];
  return h.length ? h : EMPTY;
}

function sameHeadings(a: readonly Heading[], b: readonly Heading[]): boolean {
  return a.length === b.length && a.every((h, i) => h.line === b[i].line && h.level === b[i].level && h.text === b[i].text);
}

/** The entry being read at `scrollTop`: the last heading at or above the read
 *  line, the last one once scrolled to the bottom, the first before any.
 *  NaN offsets (a heading with no box, inside a closed <details>) never
 *  match. Exported for tests. */
export function activeHeading(offsets: readonly number[], scrollTop: number, atBottom: boolean): number {
  if (!offsets.length) return -1;
  if (atBottom) return offsets.length - 1;
  let idx = 0;
  for (let i = 0; i < offsets.length; i++) if (offsets[i] <= scrollTop + READ_LINE) idx = i;
  return idx;
}

/** The heading element for a model heading: matched by its trusted source
 *  line stamp, so duplicates and raw-HTML headings can never be confused. */
function headingEls(host: HTMLElement): Map<number, HTMLElement> {
  const m = new Map<number, HTMLElement>();
  for (const el of Array.from(host.querySelectorAll<HTMLElement>("h1[data-src-line], h2[data-src-line], h3[data-src-line]"))) {
    m.set(Number(el.dataset.srcLine), el);
  }
  return m;
}

export function OutlineRail({ initial, bind, hostRef, scrollerRef }: {
  /** the headings already rendered when the rail opens */
  initial: readonly Heading[] | undefined;
  /** hands the rail its update callback, called after every rebuild */
  bind: (update: ((h: readonly Heading[]) => void) | null) => void;
  hostRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation("panels");
  const [heads, setHeads] = useState(() => outlineHeadings(initial));
  const [active, setActive] = useState(-1);
  const headsRef = useRef(heads);
  headsRef.current = heads;
  const st = useRef({ offsets: [] as number[], max: 0, measureRaf: 0, spyRaf: 0 });

  useEffect(() => {
    const scroller = scrollerRef.current, host = hostRef.current;
    if (!scroller || !host) return;
    const s = st.current;
    const spy = () => {
      s.spyRaf = 0;
      const top = scroller.scrollTop;
      setActive(activeHeading(s.offsets, top, s.max > 0 && top >= s.max - 4));
    };
    const measure = () => {
      s.measureRaf = 0;
      // hidden (display: none): nothing to measure; the resize on reveal remeasures
      if (!scroller.getClientRects().length) return;
      const els = headingEls(host);
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      s.offsets = headsRef.current.map(h => {
        const el = els.get(h.line);
        return el && el.getClientRects().length ? el.getBoundingClientRect().top - origin : NaN;
      });
      s.max = scroller.scrollHeight - scroller.clientHeight;
      spy();
    };
    const scheduleMeasure = () => { if (!s.measureRaf) s.measureRaf = requestAnimationFrame(measure); };
    const onScroll = () => { if (!s.spyRaf) s.spyRaf = requestAnimationFrame(spy); };
    bind(h => {
      const next = outlineHeadings(h);
      setHeads(prev => sameHeadings(prev, next) ? prev : next);
      headsRef.current = next;
      scheduleMeasure();
    });
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(host);
    ro.observe(scroller);
    host.addEventListener("toggle", scheduleMeasure, true);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      bind(null);
      ro.disconnect();
      host.removeEventListener("toggle", scheduleMeasure, true);
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(s.measureRaf);
      cancelAnimationFrame(s.spyRaf);
      s.measureRaf = s.spyRaf = 0;
    };
  }, [bind, hostRef, scrollerRef]);

  const go = (h: Heading) => {
    const host = hostRef.current;
    const el = host && headingEls(host).get(h.line);
    if (!el) return;
    // open a closed <details> first, as every other jump does (flashTo);
    // the outline keeps its own landing, the heading at the top
    revealInDetails(el);
    el.scrollIntoView({ block: "start" });
  };

  return (
    <nav
      data-testid="md-outline"
      aria-label={t("mdReview.outline")}
      className="w-[232px] shrink-0 overflow-auto border-r border-[var(--color-border-soft)] px-2 pb-10 pt-3.5"
    >
      <div className="px-2 pb-2 text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-fg-faint)]">{t("mdReview.outline")}</div>
      {heads.length === 0 && (
        <div className="px-2 text-[12px] text-[var(--color-fg-faint)]">{t("mdReview.noHeadings")}</div>
      )}
      {heads.map((h, i) => (
        <button
          key={`${h.line}:${h.slug}`}
          type="button"
          data-outline-line={h.line}
          aria-current={i === active ? "location" : undefined}
          onClick={() => go(h)}
          className={cn(
            "flex w-full justify-between gap-2 rounded px-2 py-1 text-left text-[12.5px] leading-[1.35]",
            "hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            h.level === 1 ? "font-semibold text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
            h.level === 3 && "pl-[22px]",
            i === active && "bg-[var(--color-hover)] text-[var(--color-fg)] shadow-[inset_2px_0_0_var(--color-accent)]",
          )}
        >
          <span className="min-w-0 break-words">{h.text}</span>
          <span className="pt-px font-mono text-[11px] tabular-nums text-[var(--color-fg-faint)]">{h.line}</span>
        </button>
      ))}
    </nav>
  );
}
