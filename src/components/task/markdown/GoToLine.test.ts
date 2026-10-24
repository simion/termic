// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealLine } from "./GoToLine";

function doc() {
  const scroller = document.createElement("div");
  const host = scroller.appendChild(document.createElement("div"));
  host.innerHTML = [
    '<h2 data-src-line="1" data-src-end="1">Title</h2>',
    '<ul data-src-line="3" data-src-end="4"><li data-src-line="3" data-src-end="3">one</li><li data-src-line="4" data-src-end="4">two</li></ul>',
    '<details><summary>s</summary><p data-src-line="7" data-src-end="7" class="closed">hidden</p></details>',
    '<p data-src-line="9" data-src-end="9">last</p>',
  ].join("");
  document.body.replaceChildren(scroller);
  // happy-dom has no layout: everything has a box but the closed <details> body
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.classList.contains("closed") ? [] : [{}]) as unknown as DOMRectList;
  });
  scroller.scrollTo = vi.fn() as unknown as typeof scroller.scrollTo;
  return { scroller, host };
}
const flashed = (host: HTMLElement) => Array.from(host.querySelectorAll(".md-flash")).map(el => el.textContent);

afterEach(() => vi.restoreAllMocks());

describe("revealLine", () => {
  it("flashes the innermost block holding the line", () => {
    const { scroller, host } = doc();
    expect(revealLine(host, scroller, 4)).toBe(true);
    expect(flashed(host)).toEqual(["two"]);
    expect(scroller.scrollTo).toHaveBeenCalledOnce();
  });
  it("lands on the next block from a blank line, opening a closed <details> around it", () => {
    const { scroller, host } = doc();
    revealLine(host, scroller, 6);
    expect(flashed(host)).toEqual(["hidden"]);
    expect(host.querySelector("details")!.open).toBe(true);
  });
  it("skips a block with no box that no <details> hides (one under the block editor)", () => {
    const { scroller, host } = doc();
    const p = host.querySelector<HTMLElement>('[data-src-line="9"]')!;
    p.classList.add("closed");
    host.querySelector("details")!.remove();
    revealLine(host, scroller, 9);
    expect(flashed(host)).toEqual(["two"]);
  });
  it("lands on the last block from the file's trailing blank lines", () => {
    const { scroller, host } = doc();
    revealLine(host, scroller, 12);
    expect(flashed(host)).toEqual(["last"]);
  });
  it("flashes each block it lands on", () => {
    const { scroller, host } = doc();
    revealLine(host, scroller, 1);
    revealLine(host, scroller, 3);
    expect(flashed(host)).toEqual(["Title", "one"]);
  });
});
