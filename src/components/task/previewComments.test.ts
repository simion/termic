// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({}));
vi.mock("@/store/app", () => ({ useApp: { getState: vi.fn() } }));
vi.mock("@/store/ui", () => ({ useUI: { getState: vi.fn() } }));
vi.mock("@/lib/sendComments", () => ({ sendCommentsToAgent: vi.fn() }));

import { claimDocument, renderSanitized } from "./MarkdownPreview";
import { narrowSelection, placeSlots, selectionLines } from "./previewComments";

// DOMPurify under happy-dom unwraps the FIRST element of its input (a
// test-env quirk, WebKit keeps it), so the doc opens with a sacrificial line.
const SRC = [
  "Intro.",             // 1
  "## Title",           // 2
  "Some **bold** text", // 3
  "over two lines.",    // 4
  "",                   // 5
  "- one",              // 6
  "- two",              // 7
  "",                   // 8
  "```ts",              // 9
  "const x = 1;",       // 10
  "```",                // 11
].join("\n");

function render(src = SRC) {
  const host = document.createElement("div");
  host.innerHTML = renderSanitized(src);
  claimDocument(host);
  document.body.appendChild(host);
  return host;
}

function rangeOver(a: Node, b: Node) {
  const r = document.createRange();
  r.setStart(a, 0);
  r.setEnd(b, 1);
  return r;
}

describe("preview source lines", () => {
  it("stamps top-level blocks, fences on the <pre> inside its breakout wrapper", () => {
    const host = render();
    const lines = Array.from(host.querySelectorAll(":scope > [data-src-line], :scope > .md-wide > [data-src-line]"))
      .map(el => [el.tagName, (el as HTMLElement).dataset.srcLine, (el as HTMLElement).dataset.srcEnd]);
    expect(lines).toEqual([["H2", "2", "2"], ["P", "3", "4"], ["UL", "6", "7"], ["PRE", "9", "11"]]);
    expect(host.querySelector("code")?.hasAttribute("data-src-line")).toBe(false);
  });

  it("maps a selection to the innermost block at each end", () => {
    const host = render();
    const [li1, li2] = Array.from(host.querySelectorAll("li"));
    expect(selectionLines(host, rangeOver(li2.firstChild!, li2.firstChild!))).toEqual({ startLine: 7, endLine: 7 });
    expect(selectionLines(host, rangeOver(host.querySelector("strong")!.firstChild!, li1.firstChild!)))
      .toEqual({ startLine: 3, endLine: 6 });
  });

  it("drops line stamps the document wrote itself", () => {
    const host = render(`${SRC}\n\n<div data-src-line="1" data-src-end="400"><span data-src-line="2">forged</span></div>\n`);
    const forged = host.querySelector("span")!;
    expect(forged.hasAttribute("data-src-line")).toBe(false);
    expect(forged.parentElement!.hasAttribute("data-src-end")).toBe(false);
    // the selection falls through to no block at all, not to lines 1-400
    expect(selectionLines(host, rangeOver(forged.firstChild!, forged.firstChild!))).toBeNull();
    // and ours are bare line numbers again
    expect(host.querySelector("h2")!.getAttribute("data-src-line")).toBe("2");
  });

  it("claims content written after the render (a mermaid SVG) the same way", () => {
    // mermaid's own sanitizer keeps data-* and class, so its labels arrive
    // unchecked; claimDocument is what keeps them from posing as ours
    const block = document.createElement("div");
    block.innerHTML = '<span data-src-line="5" data-src-end="400" data-tc-slot="" data-tc-commented="" class="tc-btn label">x</span>';
    claimDocument(block);
    const span = block.querySelector("span")!;
    expect(span.getAttributeNames().sort()).toEqual(["class"]);
    expect(span.className).toBe("label");
  });

  it("returns null outside any stamped block", () => {
    const host = render();
    const r = document.createRange();
    r.selectNodeContents(document.body);
    expect(selectionLines(host, r)).toBeNull();
  });
});

// a hard-wrapped paragraph: one rendered line, four source lines
const WRAPPED = [
  "Intro.",                                                     // 1
  "",                                                           // 2
  "The tool is in use and has a number of features and",        // 3
  "optimizations added along the way. Among those is a standard", // 4
  "framerate-based renderer, a renderer for scrollable regions", // 5
  "which works alongside the main one, and **mouse** support.",  // 6
].join("\n");

describe("narrowSelection", () => {
  it("quotes the selection and narrows to the lines it spans across a wrap", () => {
    expect(narrowSelection(WRAPPED, 3, 6, "Among those is a standard framerate-based renderer"))
      .toEqual({ startLine: 4, endLine: 5, quote: "Among those is a standard framerate-based renderer" });
  });
  it("narrows to one line for a selection inside it", () => {
    expect(narrowSelection(WRAPPED, 3, 6, " scrollable regions ")).toEqual({ startLine: 5, endLine: 5, quote: "scrollable regions" });
  });
  it("keeps the block's lines but still quotes the selection when rendering changed the text", () => {
    expect(narrowSelection(WRAPPED, 3, 6, "and mouse support."))
      .toEqual({ startLine: 3, endLine: 6, quote: "and mouse support." });
  });
  it("matches regex metacharacters literally", () => {
    expect(narrowSelection(WRAPPED, 3, 6, "one, and **mouse**").startLine).toBe(6);
  });
  it("falls back to the source lines for an all-whitespace selection", () => {
    expect(narrowSelection(SRC, 3, 4, "  ").quote).toBe("Some **bold** text\nover two lines.");
  });
});

describe("placeSlots", () => {
  const slot = (startLine: number, endLine: number, mark = true, quote?: string) => {
    const el = document.createElement("div");
    el.setAttribute("data-tc-slot", "");
    return { el, startLine, endLine, mark, quote };
  };
  const quoted = (host: HTMLElement) =>
    Array.from(host.querySelectorAll("mark.tc-md-quote")).map(m => m.textContent);
  const order = (host: HTMLElement) =>
    Array.from(host.children).map(el => el.hasAttribute("data-tc-slot") ? "slot" : el.tagName);
  const marked = (host: HTMLElement) =>
    Array.from(host.querySelectorAll("[data-tc-commented]")).map(el => el.tagName);

  it("puts a slot on a wide block after its wrapper, and marks the block inside", () => {
    const host = render();
    placeSlots(host, [slot(10, 10)]);
    expect(order(host)).toEqual(["H2", "P", "UL", "DIV", "slot"]);
    expect(marked(host)).toEqual(["PRE"]);
  });

  it("puts a slot after the block its range ends on and marks what it covers", () => {
    const host = render();
    placeSlots(host, [slot(3, 4)]);
    expect(order(host)).toEqual(["H2", "P", "slot", "UL", "DIV"]);
    expect(marked(host)).toEqual(["P"]);
  });

  it("marks the list item, not the list, and keeps the card out of the list", () => {
    const host = render();
    placeSlots(host, [slot(7, 7)]);
    expect(marked(host)).toEqual(["LI"]);
    expect(order(host)).toEqual(["H2", "P", "UL", "slot", "DIV"]);
  });

  it("stacks slots on one block in line order, and leaves a draft unmarked", () => {
    const host = render();
    const a = slot(6, 6), b = slot(7, 7, false);
    placeSlots(host, [a, b]);
    expect(Array.from(host.children).indexOf(b.el)).toBe(Array.from(host.children).indexOf(a.el) + 1);
    expect(marked(host)).toEqual(["LI"]);
  });

  it("finds the blocks inside an unstamped raw-HTML wrapper", () => {
    const host = render(`${SRC}\n\n<div align="center">\n\nCentered text.\n\n</div>\n`);
    const line = SRC.split("\n").length + 4; // "Centered text."
    placeSlots(host, [slot(line, line)]);
    expect(marked(host)).toEqual(["P"]);
    expect(host.lastElementChild!.hasAttribute("data-tc-slot")).toBe(true);
  });

  it("leaves a slot already in place where it is, and clears stale marks", () => {
    const host = render();
    const s = slot(3, 4);
    placeSlots(host, [s]);
    const moved = vi.fn();
    new MutationObserver(moved).observe(host, { childList: true });
    placeSlots(host, [s]);
    placeSlots(host, []);
    expect(marked(host)).toEqual([]);
    return Promise.resolve().then(() => expect(moved).not.toHaveBeenCalled());
  });

  it("highlights only the quoted text, across a wrap and an inline element, instead of the block", () => {
    const host = render(WRAPPED);
    placeSlots(host, [slot(4, 5, true, "Among those is a standard framerate-based renderer")]);
    expect(quoted(host).join("")).toBe("Among those is a standard\nframerate-based renderer");
    expect(marked(host)).toEqual([]);
    placeSlots(host, [slot(6, 6, true, "and mouse support")]);
    expect(quoted(host)).toEqual(["and ", "mouse", " support"]);
    // the previous highlight is gone and the text it split is whole again
    expect(host.querySelector("p")!.childNodes[0].nodeValue).toContain("Among those is a standard\nframerate");
  });

  it("highlights a quote that spans two blocks, skipping the seam between them", () => {
    const host = render();
    placeSlots(host, [slot(6, 7, true, "one\ntwo")]);
    expect(quoted(host)).toEqual(["one", "two"]);
    expect(host.querySelector("ul > mark")).toBeNull();
  });

  it("falls back to marking the block when the quote is not in the rendering", () => {
    const host = render();
    placeSlots(host, [slot(3, 4, true, "Some **bold** text")]);
    expect(quoted(host)).toEqual([]);
    expect(marked(host)).toEqual(["P"]);
  });

  it("highlights a draft's quote but never marks its blocks", () => {
    const host = render();
    placeSlots(host, [slot(3, 4, false, "over two")]);
    expect(quoted(host)).toEqual(["over two"]);
    placeSlots(host, [slot(3, 4, false, "**nope**")]);
    expect(quoted(host)).toEqual([]);
    expect(marked(host)).toEqual([]);
  });
});
