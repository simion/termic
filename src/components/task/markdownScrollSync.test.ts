// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { buildAnchors, editorTopLine, lineToY, previewAnchors, yToLine } from "./markdownScrollSync";

describe("markdownScrollSync", () => {
  const a = buildAnchors(
    [{ line: 1, y: 16 }, { line: 5, y: 100 }, { line: 5, y: 120 }, { line: 3, y: 200 }, { line: 10, y: 300 }],
    21, 1000,
  );

  it("keeps the map strictly increasing and bracketed", () => {
    expect(a).toEqual([
      { line: 1, y: 0 }, { line: 5, y: 100 }, { line: 10, y: 300 }, { line: 21, y: 1000 },
    ]);
  });

  it("interpolates between anchors both ways", () => {
    expect(lineToY(a, 7.5)).toBe(200);
    expect(yToLine(a, 200)).toBe(7.5);
    expect(yToLine(a, lineToY(a, 15))).toBeCloseTo(15);
  });

  it("clamps outside the range", () => {
    expect(lineToY(a, 0)).toBe(0);
    expect(lineToY(a, 99)).toBe(1000);
    expect(yToLine(a, -5)).toBe(1);
    expect(yToLine(a, 5000)).toBe(21);
  });

  it("degenerates to a straight line with no blocks", () => {
    const b = buildAnchors([], 11, 500);
    expect(lineToY(b, 6)).toBe(250);
  });
});

describe("editorTopLine", () => {
  // just enough of an EditorView for the scroll math
  const view = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
    scrollDOM: { scrollTop, scrollHeight, clientHeight, getBoundingClientRect: () => ({ top: 0 }) },
    documentTop: -scrollTop,
    lineBlockAtHeight: (y: number) => ({ from: Math.floor(y / 20), top: Math.floor(y / 20) * 20, height: 20 }),
    state: { doc: { lines: 5, lineAt: (pos: number) => ({ number: pos + 1 }) } },
  }) as unknown as EditorView;

  it("reads the fractional line at the top", () => {
    expect(editorTopLine(view(30, 300, 100))).toBe(2.5);
  });

  it("reports past the last line when pinned to the bottom", () => {
    expect(editorTopLine(view(200, 300, 100))).toBe(6);
  });

  // a short file with a tall preview: nothing to scroll is the top, or
  // opening split slams the preview to its end
  it("an editor with nothing to scroll is at its top", () => {
    expect(editorTopLine(view(0, 100, 100))).toBe(1);
  });
});

describe("previewAnchors", () => {
  it("skips blocks with no box (inside a closed <details>)", () => {
    const scroller = document.createElement("div");
    const host = document.createElement("div");
    host.innerHTML = '<p data-src-line="1"></p><details><p data-src-line="3"></p></details><p data-src-line="5"></p>';
    scroller.append(host);
    Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    const tops: Record<string, number> = { "1": 0, "3": 0, "5": 400 };
    for (const p of Array.from(host.querySelectorAll<HTMLElement>("p"))) {
      const line = p.dataset.srcLine!;
      p.getBoundingClientRect = () => ({ top: tops[line] }) as DOMRect;
      p.getClientRects = () => ({ length: line === "3" ? 0 : 1 }) as DOMRectList;
    }
    expect(previewAnchors(scroller, host, 11)).toEqual([
      { line: 1, y: 0 }, { line: 5, y: 400 }, { line: 11, y: 900 },
    ]);
  });
});
