import { describe, it, expect } from "vitest";
import { PATH_TOKEN_RE, parsePathToken } from "./termLinkOpener";

const firstMatch = (s: string): string | null => PATH_TOKEN_RE.exec(s)?.[0] ?? null;

describe("PATH_TOKEN_RE", () => {
  it("matches a dir-qualified path", () => {
    expect(firstMatch("src/index.ts")).toBe("src/index.ts");
  });
  it("matches a bare filename with a letter-led extension", () => {
    expect(firstMatch("file.ts")).toBe("file.ts");
  });
  it("matches a multi-dotted filename", () => {
    expect(firstMatch("file.min.js")).toBe("file.min.js");
  });
  it("captures a trailing :line:col", () => {
    expect(firstMatch("app.tsx:45:2")).toBe("app.tsx:45:2");
  });
  it("captures a trailing :line", () => {
    expect(firstMatch("src/a.ts:12")).toBe("src/a.ts:12");
  });
  it("does not match a bare version string", () => {
    expect(firstMatch("1.2.3")).toBeNull();
    expect(firstMatch("v1.2.3")).toBeNull();
  });
  it("does not match an extension-less, slash-less word", () => {
    expect(firstMatch("README")).toBeNull();
    expect(firstMatch("just words here")).toBeNull();
  });
});

describe("parsePathToken", () => {
  it("splits path, line, and col", () => {
    expect(parsePathToken("src/file.ts:123:5")).toEqual({ path: "src/file.ts", line: 123, col: 5 });
  });
  it("splits path and line with no col", () => {
    expect(parsePathToken("src/file.ts:123")).toEqual({ path: "src/file.ts", line: 123, col: undefined });
  });
  it("returns just the path when there is no trailing line", () => {
    expect(parsePathToken("src/file.ts")).toEqual({ path: "src/file.ts" });
  });
  it("handles a bare filename", () => {
    expect(parsePathToken("file.ts")).toEqual({ path: "file.ts" });
  });
});
