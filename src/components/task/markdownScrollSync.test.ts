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

// The switch from preview to split: the editor must land where the reader was
// in the preview. WebKitGTK gave the editor its height one ResizeObserver
// delivery late, and the first sync was spent on the delivery where it had
// none, so the editor never followed (a Linux CI flake on editor.e2e.ts).
describe("useScrollSync, entering split from the preview", () => {
  // the preview read down to line 21 (one 20px block per line, scrollTop
  // 400), and an editor that sits elsewhere and gets its height late
  async function rig() {
    const { createElement, useRef } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const { useScrollSync } = await import("./markdownScrollSync");

    const observers: Array<() => void> = [];
    const RealRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; observers.push(() => this.cb()); }
      observe() {} unobserve() {} disconnect() {}
    } as unknown as typeof ResizeObserver;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const box = (el: HTMLElement, h: { client: () => number; scroll: number }, top = 0) => {
      let st = top;
      Object.defineProperties(el, {
        scrollTop: { get: () => st, set: (v: number) => { st = Math.max(0, Math.min(v, h.scroll - h.client())); }, configurable: true },
        clientHeight: { get: h.client, configurable: true },
        scrollHeight: { get: () => h.scroll, configurable: true },
      });
      el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    };
    const scroller = document.createElement("div");
    const host = document.createElement("div");
    for (let line = 1; line <= 100; line++) {
      const p = document.createElement("p");
      p.dataset.srcLine = String(line);
      p.getBoundingClientRect = () => ({ top: (line - 1) * 20 - scroller.scrollTop }) as DOMRect;
      p.getClientRects = () => ({ length: 1 }) as DOMRectList;
      host.append(p);
    }
    scroller.append(host);
    box(scroller, { client: () => 100, scroll: 2100 }, 400);
    const ed = document.createElement("div");
    const edBox = { height: 0 };
    box(ed, { client: () => edBox.height, scroll: 2100 });
    const view = {
      scrollDOM: ed,
      get documentTop() { return -ed.scrollTop; },
      lineBlockAt: (pos: number) => ({ top: pos * 20, height: 20 }),
      lineBlockAtHeight: (y: number) => ({ from: Math.floor(y / 20), top: Math.floor(y / 20) * 20, height: 20 }),
      state: { doc: { lines: 100, line: (n: number) => ({ from: n - 1 }), lineAt: (pos: number) => ({ number: pos + 1 }) } },
    } as unknown as EditorView;

    function Probe({ editorVisible }: { editorVisible: boolean }) {
      const s = useRef<HTMLElement | null>(scroller), h = useRef<HTMLElement | null>(host);
      useScrollSync(s, h, view, true, editorVisible);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => { root.render(createElement(Probe, { editorVisible: false })); });
    await act(async () => { root.render(createElement(Probe, { editorVisible: true })); });
    return {
      scroller, ed, edBox,
      deliver: () => { for (const fire of observers) fire(); },
      done: async () => { await act(async () => { root.unmount(); }); globalThis.ResizeObserver = RealRO; },
    };
  }

  it("waits for the editor to have a box before spending its first sync", async () => {
    const r = await rig();
    try {
      // first delivery: the editor has no height yet, so nothing can sync
      r.deliver();
      expect(r.ed.scrollTop).toBe(0);
      // the editor gets its height: that resize is the retry
      r.edBox.height = 100;
      r.deliver();
      expect(r.ed.scrollTop).toBe(400);
    } finally { await r.done(); }
  });

  it("does not let a restored editor position lead before the first sync", async () => {
    const r = await rig();
    try {
      // WebKitGTK: the editor comes back with a width and no height, and
      // hiddenScrollRestore puts back where it was hidden (line 61)
      r.deliver();
      r.ed.scrollTop = 1200;
      // its scroll event lands once the editor has its height, before the
      // delivery that runs the first sync
      r.edBox.height = 100;
      r.ed.dispatchEvent(new Event("scroll"));
      r.deliver();
      // the preview led: neither pane went to the editor's old place
      expect(r.scroller.scrollTop).toBe(400);
      expect(r.ed.scrollTop).toBe(400);
    } finally { await r.done(); }
  });
});
