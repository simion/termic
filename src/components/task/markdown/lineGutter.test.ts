// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));

import { gutterLeaves, hoverTarget } from "./lineGutter";

function doc() {
  const host = document.createElement("div");
  host.innerHTML = [
    '<h2 data-src-line="1" data-src-end="1">Title</h2>',
    '<ul data-src-line="3" data-src-end="4"><li data-src-line="3" data-src-end="3"><em>one</em></li>',
    '<li data-src-line="4" data-src-end="4">two</li></ul>',
    '<div class="md-wide"><table data-src-line="6" data-src-end="8"><tbody data-src-line="8" data-src-end="8">',
    '<tr data-src-line="8" data-src-end="8"><td>x</td></tr></tbody></table></div>',
    '<div data-tc-slot=""><p>a comment card</p></div>',
  ].join("");
  document.body.replaceChildren(host);
  return host;
}

describe("hoverTarget", () => {
  it("is the innermost stamped block: the item, the row", () => {
    const host = doc();
    expect(hoverTarget(host.querySelector("em")!, host)?.tagName).toBe("LI");
    expect(hoverTarget(host.querySelector("td")!, host)?.tagName).toBe("TR");
    expect(hoverTarget(host.querySelector("h2")!, host)?.tagName).toBe("H2");
  });
  it("keeps the current block over the padding, a gap, a list's own box", () => {
    const host = doc();
    expect(hoverTarget(host, host)).toBeUndefined();
    expect(hoverTarget(host.querySelector("ul")!, host)).toBeUndefined();
    expect(hoverTarget(host.querySelector(".md-wide")!, host)).toBeUndefined();
    expect(hoverTarget(document.body, host)).toBeUndefined();
  });
  it("is nothing over a comment card", () => {
    const host = doc();
    expect(hoverTarget(host.querySelector("[data-tc-slot] p")!, host)).toBeNull();
  });
});

describe("gutterLeaves", () => {
  it("numbers items and rows, not the list or the table", () => {
    const host = doc();
    // happy-dom has no layout, so give every element a box
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    expect(gutterLeaves(host).map(el => el.tagName)).toEqual(["H2", "LI", "LI", "TR"]);
    vi.restoreAllMocks();
  });
});
