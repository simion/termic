import { describe, it, expect } from "vitest";
import { isAtWordBoundary } from "./atTrigger";

describe("isAtWordBoundary", () => {
  it("is a boundary at column 0", () => {
    expect(isAtWordBoundary(0, "")).toBe(true);
    expect(isAtWordBoundary(0, "x")).toBe(true);
  });
  it("is a boundary when the previous cell is empty", () => {
    expect(isAtWordBoundary(5, "")).toBe(true);
  });
  it("is a boundary when the previous cell is whitespace", () => {
    expect(isAtWordBoundary(5, " ")).toBe(true);
    expect(isAtWordBoundary(5, "\t")).toBe(true);
  });
  it("is NOT a boundary mid-word", () => {
    expect(isAtWordBoundary(5, "a")).toBe(false);
    expect(isAtWordBoundary(5, "/")).toBe(false);
  });
});
