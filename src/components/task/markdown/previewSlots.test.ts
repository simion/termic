// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { SLOT_ATTR } from "@/lib/markdown/trust";
import { innermostBlocks, keepAfter, newSlot, rebuildWithSlots } from "./previewSlots";
import { elRange } from "@/lib/markdown/lines";

const HTML = '<p data-src-line="1" data-src-end="1">a</p>'
  + '<ul data-src-line="3" data-src-end="5"><li data-src-line="3" data-src-end="3">b</li><li data-src-line="4" data-src-end="5">c</li></ul>';

function host() {
  const h = document.createElement("div");
  h.innerHTML = HTML;
  document.body.replaceChildren(h);
  return h;
}

describe("previewSlots", () => {
  it("reads a block's range, a missing end meaning one line", () => {
    const el = document.createElement("p");
    el.dataset.srcLine = "7";
    expect(elRange(el)).toEqual({ startLine: 7, endLine: 7 });
    expect(elRange(document.createElement("p"))).toBeNull();
  });

  it("finds the innermost stamped blocks a range touches", () => {
    const h = host();
    const stamped = Array.from(h.querySelectorAll<HTMLElement>("[data-src-line]"));
    expect(innermostBlocks(stamped, 4, 4).map(e => e.textContent)).toEqual(["c"]);
    expect(innermostBlocks(stamped, 1, 3).map(e => e.textContent)).toEqual(["a", "b"]);
    expect(innermostBlocks(stamped, 2, 2)).toEqual([]);
  });

  it("moves a slot only when it is out of place", async () => {
    const h = host();
    const slot = newSlot();
    expect(slot.hasAttribute(SLOT_ATTR)).toBe(true);
    const p = h.querySelector("p")!;
    keepAfter(h, slot, p);
    expect(p.nextSibling).toBe(slot);
    const records: MutationRecord[] = [];
    const mo = new MutationObserver(r => records.push(...r));
    mo.observe(h, { childList: true });
    keepAfter(h, slot, p);
    await Promise.resolve();
    expect(records).toHaveLength(0);
    keepAfter(h, slot, null);
    expect(h.firstChild).toBe(slot);
    mo.disconnect();
  });

  it("puts the slots back after a rebuild and gives a focused field its caret back", () => {
    const h = host();
    const slot = newSlot();
    const ta = document.createElement("textarea");
    ta.value = "half a sentence";
    slot.appendChild(ta);
    h.querySelector("p")!.after(slot);
    ta.focus();
    ta.setSelectionRange(4, 6);
    rebuildWithSlots(h, () => { h.innerHTML = HTML; }, () => keepAfter(h, slot, h.querySelector("p")));
    expect(slot.isConnected).toBe(true);
    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([4, 6]);
  });
});
