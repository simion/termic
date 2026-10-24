import { describe, expect, it } from "vitest";
import { blockForLine, labelBox, lastLine, lineRef, rangeText, remapRange, sliceLines } from "./lines";

describe("references", () => {
  it("names a single line or a range, with the path when there is one", () => {
    expect(rangeText({ startLine: 7, endLine: 7 })).toBe("7");
    expect(lineRef("docs/plan.md", { startLine: 337, endLine: 342 })).toBe("docs/plan.md:337-342");
    expect(lineRef(undefined, { startLine: 337, endLine: 342 })).toBe("337-342");
    expect(lineRef("", { startLine: 3, endLine: 3 })).toBe("3");
  });
});

describe("blockForLine", () => {
  // a heading, a list (1 item spanning 4-5, another 6), a fence
  const ranges = [
    { startLine: 1, endLine: 1 },
    { startLine: 3, endLine: 6 },
    { startLine: 3, endLine: 3 },
    { startLine: 4, endLine: 5 },
    { startLine: 6, endLine: 6 },
    { startLine: 8, endLine: 10 },
  ];
  it("lands on the innermost block holding the line, never the list", () => {
    expect(blockForLine(ranges, 1)).toBe(0);
    expect(blockForLine(ranges, 5)).toBe(3);
    expect(blockForLine(ranges, 6)).toBe(4);
    expect(blockForLine(ranges, 9)).toBe(5);
  });
  it("a blank line goes to the innermost block where the next one starts", () => {
    expect(blockForLine(ranges, 2)).toBe(2);
    expect(blockForLine(ranges, 7)).toBe(5);
  });
  it("past the last block is -1", () => {
    expect(blockForLine(ranges, 11)).toBe(-1);
    expect(blockForLine([], 1)).toBe(-1);
  });
});

describe("lastLine", () => {
  it("does not count the line a final newline would start", () => {
    expect(lastLine("a\nb\n")).toBe(2);
    expect(lastLine("a\nb")).toBe(2);
    expect(lastLine("a\n\n")).toBe(2);
    expect(lastLine("")).toBe(1);
  });
});

describe("labelBox", () => {
  const lh = 25;
  it("sits on the first line of a multi-line block, under its padding", () => {
    expect(labelBox({ top: 100, height: 16 + 4 * lh + 16, padTop: 16, padBottom: 16, lineHeight: lh }))
      .toEqual({ top: 116, height: lh });
  });
  it("centers on the whole content box of a one-line block (a table row, a heading)", () => {
    expect(labelBox({ top: 0, height: 37, padTop: 0, padBottom: 0, lineHeight: lh })).toEqual({ top: 0, height: 37 });
    expect(labelBox({ top: 0, height: 49.6, padTop: 0, padBottom: 9.6, lineHeight: 40 })).toEqual({ top: 0, height: 40 });
  });
});

describe("blockForLine: the next block after a blank line", () => {
  it("is the nearest by source line, not the first in DOM order", () => {
    // a footnote definition at line 5 renders after the body block at line 9
    const ranges = [{ startLine: 1, endLine: 3 }, { startLine: 9, endLine: 9 }, { startLine: 5, endLine: 5 }];
    expect(blockForLine(ranges, 4)).toBe(2);
  });
});

describe("sliceLines", () => {
  it("matches split/slice/join without splitting the document", () => {
    const docs = ["", "x", "x\n", "a\nb\nc", "a\nb\nc\n", "\n\n"];
    for (const t of docs) for (let a = 1; a <= 5; a++) for (let b = a; b <= 5; b++) {
      expect(sliceLines(t, a, b), JSON.stringify([t, a, b])).toBe(t.split("\n").slice(a - 1, b).join("\n"));
    }
  });
});

describe("remapRange", () => {
  const doc = (...ls: string[]) => ls.join("\n");
  const before = doc("# T", "", "para one", "para two", "", "tail");
  const block = { startLine: 3, endLine: 4 };

  it("keeps a block an edit below it never reached", () => {
    expect(remapRange(before, doc("# T", "", "para one", "para two", "", "tail", "more"), block))
      .toEqual({ startLine: 3, endLine: 4, changed: false });
  });

  it("shifts a block when lines are added or removed above it", () => {
    expect(remapRange(before, doc("# T", "x", "y", "", "para one", "para two", "", "tail"), block))
      .toEqual({ startLine: 5, endLine: 6, changed: false });
    expect(remapRange(before, doc("", "para one", "para two", "", "tail"), block))
      .toEqual({ startLine: 2, endLine: 3, changed: false });
  });

  it("refuses when identical lines make the edit's place ambiguous", () => {
    // X A X losing two lines: it could have been X A or A X, so line 1 is
    // either the X it was or the other one
    expect(remapRange(doc("X", "A", "X"), doc("X"), { startLine: 1, endLine: 1 })).toBeNull();
    // unambiguous neighbours still follow: a blank line added beside blanks
    expect(remapRange(doc("a", "", "b", "", "c"), doc("a", "", "", "b", "", "c"), { startLine: 3, endLine: 3 }))
      .toEqual({ startLine: 4, endLine: 4, changed: false });
  });

  it("follows a whole-document replace, as a reload from disk is", () => {
    expect(remapRange(before, "new\n" + before, block)).toEqual({ startLine: 4, endLine: 5, changed: false });
  });

  it("reports an edit confined to the block, with its new extent", () => {
    expect(remapRange(before, doc("# T", "", "para ONE", "para two", "", "tail"), block))
      .toEqual({ startLine: 3, endLine: 4, changed: true });
    expect(remapRange(before, doc("# T", "", "para one", "inserted", "para two", "", "tail"), block))
      .toEqual({ startLine: 3, endLine: 5, changed: true });
  });

  it("refuses an edit that reaches past the block, or deletes it", () => {
    // lines added above AND the block changed: one span covering both
    expect(remapRange(before, doc("# T", "x", "", "para ONE", "para two", "", "tail"), block)).toBeNull();
    expect(remapRange(before, doc("# T", "", "", "tail"), block)).toBeNull();
  });
});
