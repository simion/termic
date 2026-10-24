// Landing on a block of the rendered preview: open any <details> around it,
// scroll it to the upper third of the scroller, and flash it. Go to line and
// a footnote jump both land this way.

import { revealInDetails } from "./extensions/details";

const FLASH_CLASS = "md-flash";
// one timer per element: a second jump within the flash restarts it, so the
// first jump's timer must not end the second flash early
const timers = new WeakMap<HTMLElement, number>();

/** `scroller` null (a host not in a scroller yet) still opens and flashes. */
export function flashTo(scroller: HTMLElement | null, el: HTMLElement): void {
  revealInDetails(el);
  if (scroller) {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight * 0.3), behavior: reduce ? "auto" : "smooth" });
  }
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth; // restart the animation on a second jump to the same block
  el.classList.add(FLASH_CLASS);
  window.clearTimeout(timers.get(el));
  timers.set(el, window.setTimeout(() => { el.classList.remove(FLASH_CLASS); timers.delete(el); }, 1700));
}
