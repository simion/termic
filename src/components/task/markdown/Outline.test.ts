import { describe, expect, it } from "vitest";
import type { Heading } from "@/lib/markdown/model";
import { activeHeading, outlineHeadings } from "./Outline";

const h = (level: number, line: number): Heading => ({ level, text: `h${line}`, slug: `h${line}`, line });

describe("outlineHeadings", () => {
  it("keeps h1-h3 in document order", () => {
    expect(outlineHeadings([h(1, 1), h(4, 3), h(2, 5), h(3, 7), h(6, 9)]).map(x => x.line)).toEqual([1, 5, 7]);
  });

  it("is one frozen empty list for none, so an unchanged empty outline never re-renders", () => {
    expect(outlineHeadings(undefined)).toBe(outlineHeadings([h(5, 1)]));
  });
});

describe("activeHeading", () => {
  const offsets = [0, 400, 900, 1500];

  it("is the last heading at or above the read line", () => {
    expect(activeHeading(offsets, 0, false)).toBe(0);
    expect(activeHeading(offsets, 330, false)).toBe(1);
    expect(activeHeading(offsets, 1000, false)).toBe(2);
  });

  it("is the first before any heading has been reached", () => {
    expect(activeHeading([300, 600], 0, false)).toBe(0);
  });

  it("is the last once scrolled to the bottom, even if it never reached the top", () => {
    expect(activeHeading(offsets, 1000, true)).toBe(3);
  });

  it("skips a heading with no box (NaN), and is -1 with no headings", () => {
    expect(activeHeading([0, NaN, 900], 500, false)).toBe(0);
    expect(activeHeading([], 0, false)).toBe(-1);
  });
});
