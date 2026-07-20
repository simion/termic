import { describe, it, expect } from "vitest";
import { PATH_TOKEN_RE, parsePathToken, scanPathTokens } from "./termLinkOpener";

const firstMatch = (s: string): string | null => PATH_TOKEN_RE.exec(s)?.[0] ?? null;
const scan = (s: string): string[] => scanPathTokens(s).map(t => t.raw);

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
  it("matches an @ filename (retina asset)", () => {
    expect(firstMatch("logo@2x.png")).toBe("logo@2x.png");
  });
  it("stays fast on a long slash-less/dot-less blob (no O(n^2) backtracking)", () => {
    // A wrapped base64/hash line can reach tens of thousands of chars; the
    // hover-underline pass runs this regex on every row, so a quadratic blowup
    // would stall the main thread. Bounded segment runs keep it linear.
    const blob = "a".repeat(40000);
    const start = performance.now();
    expect(firstMatch(blob)).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("scanPathTokens", () => {
  it("skips a schemed URL (WebLinksAddon owns it) but keeps a nearby path", () => {
    expect(scan("https://example.com/a/b.ts and src/file.ts:10")).toEqual(["src/file.ts:10"]);
  });
  it("skips an scp-style host:path git remote entirely", () => {
    expect(scan("git@github.com:dancras/termic.git clone")).toEqual([]);
  });
  it("keeps a :line:col position ref (colon before a digit is not a connector)", () => {
    expect(scan("error at src/app.ts:45:2 today")).toEqual(["src/app.ts:45:2"]);
  });
  it("keeps a path before a prose colon ((path): description)", () => {
    expect(scan("see (my/path.ts): description here")).toEqual(["my/path.ts"]);
    expect(scan("file.ts: some description")).toEqual(["file.ts"]);
  });
  it("keeps @ filenames and scoped-package paths", () => {
    expect(scan("retina logo@2x.png and node_modules/@types/node/index.d.ts"))
      .toEqual(["logo@2x.png", "node_modules/@types/node/index.d.ts"]);
  });
  it("still underlines bare domains (addon does not; they are path-shaped)", () => {
    expect(scan("bare example.com/page utils.ts")).toEqual(["example.com/page", "utils.ts"]);
  });
  it("stays fast on a long connector-heavy blob (bounded first run)", () => {
    const blob = ("x".repeat(300) + ":").repeat(200) + "@".repeat(40000);
    const start = performance.now();
    scan(blob);
    expect(performance.now() - start).toBeLessThan(150);
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
