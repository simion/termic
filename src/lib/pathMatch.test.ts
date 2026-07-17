import { describe, it, expect } from "vitest";
import { normalizePath, matchesSuffix, resolvePathClick } from "./pathMatch";

describe("normalizePath", () => {
  it("strips a leading ./", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
  });
  it("strips all leading ./ and / segments", () => {
    expect(normalizePath(".//src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("././src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("/./src/a.ts")).toBe("src/a.ts");
  });
  it("strips a leading absolute slash", () => {
    expect(normalizePath("/src/a.ts")).toBe("src/a.ts");
  });
  it("leaves ../ alone (parent traversal is meaningful)", () => {
    expect(normalizePath("../src/a.ts")).toBe("../src/a.ts");
  });
  it("leaves an already-bare path untouched", () => {
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("matchesSuffix", () => {
  it("matches an identical path", () => {
    expect(matchesSuffix("src/file.ts", "src/file.ts")).toBe(true);
  });
  it("matches a segment-boundary suffix", () => {
    expect(matchesSuffix("foo/src/file.ts", "src/file.ts")).toBe(true);
  });
  it("matches a bare filename against a deeper path", () => {
    expect(matchesSuffix("foo/src/file.ts", "file.ts")).toBe(true);
  });
  it("rejects a different leading segment", () => {
    expect(matchesSuffix("abc/file.ts", "src/file.ts")).toBe(false);
  });
  it("rejects a raw (non-segment-boundary) suffix", () => {
    expect(matchesSuffix("foo/barfile.ts", "file.ts")).toBe(false);
  });
  it("normalizes both sides before comparing", () => {
    expect(matchesSuffix("/foo/src/file.ts", "./src/file.ts")).toBe(true);
  });
  it("does not match when the candidate is shorter than the query", () => {
    expect(matchesSuffix("file.ts", "src/file.ts")).toBe(false);
  });
});

describe("resolvePathClick", () => {
  const files = ["src/app/dup.ts", "src/lib/dup.ts", "src/main.ts", "README.md"];

  it("returns a single match (handler opens it directly)", () => {
    expect(resolvePathClick(files, "main.ts")).toEqual(["src/main.ts"]);
  });
  it("returns every duplicate-basename match (handler shows the picker)", () => {
    expect(resolvePathClick(files, "dup.ts")).toEqual(["src/app/dup.ts", "src/lib/dup.ts"]);
  });
  it("disambiguates a duplicate down to one when the click is dir-qualified", () => {
    expect(resolvePathClick(files, "app/dup.ts")).toEqual(["src/app/dup.ts"]);
  });
  it("returns nothing for an unknown path (handler shows the no-matches row)", () => {
    expect(resolvePathClick(files, "nope.ts")).toEqual([]);
  });
});
