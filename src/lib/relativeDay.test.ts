// One rung per boundary in the ladder, against a fixed `now` so the test
// never flips at midnight or a DST change. Mirrors the exact buckets that
// used to live only in History.tsx's `groupLabel()`.

import { describe, it, expect } from "vitest";
import { relativeDayLabel, daysSince } from "@/lib/relativeDay";

// A Wednesday, arbitrary but fixed.
const NOW = new Date("2026-09-16T12:00:00.000Z").getTime();

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

describe("relativeDayLabel", () => {
  it("Today at 0 days", () => {
    expect(relativeDayLabel(isoDaysAgo(0), NOW)).toBe("Today");
  });

  it("Yesterday at 1 day", () => {
    expect(relativeDayLabel(isoDaysAgo(1), NOW)).toBe("Yesterday");
  });

  it("counts days through the middle of the week", () => {
    expect(relativeDayLabel(isoDaysAgo(6), NOW)).toBe("6 days ago");
  });

  it("Last week at the 7 day boundary", () => {
    expect(relativeDayLabel(isoDaysAgo(7), NOW)).toBe("Last week");
  });

  it("still Last week at 13 days", () => {
    expect(relativeDayLabel(isoDaysAgo(13), NOW)).toBe("Last week");
  });

  it("2 weeks ago at the 14 day boundary", () => {
    expect(relativeDayLabel(isoDaysAgo(14), NOW)).toBe("2 weeks ago");
  });

  it("still 2 weeks ago at 20 days", () => {
    expect(relativeDayLabel(isoDaysAgo(20), NOW)).toBe("2 weeks ago");
  });

  it("3 weeks ago at the 21 day boundary", () => {
    expect(relativeDayLabel(isoDaysAgo(21), NOW)).toBe("3 weeks ago");
  });

  it("still 3 weeks ago at 27 days", () => {
    expect(relativeDayLabel(isoDaysAgo(27), NOW)).toBe("3 weeks ago");
  });

  it("falls to month + year at the 28 day boundary", () => {
    const iso = isoDaysAgo(28);
    const expected = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso));
    expect(relativeDayLabel(iso, NOW)).toBe(expected);
  });
});

describe("daysSince", () => {
  it("floors to whole 24h buckets, not calendar days", () => {
    expect(daysSince(isoDaysAgo(0), NOW)).toBe(0);
    expect(daysSince(isoDaysAgo(1), NOW)).toBe(1);
    expect(daysSince(isoDaysAgo(9.5), NOW)).toBe(9);
    expect(daysSince(isoDaysAgo(28), NOW)).toBe(28);
  });
});
