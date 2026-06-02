import { describe, it, expect } from "vitest";
import { slugify, shortPath } from "@/lib/utils";

// ── slugify ───────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips leading and trailing hyphens", () => {
    // Spaces at start/end become hyphens, then get stripped.
    expect(slugify("  hello  ")).toBe("hello");
  });

  it("collapses multiple consecutive non-alphanum chars into one hyphen", () => {
    // Multiple spaces → single hyphen; trailing !! → single hyphen → stripped.
    expect(slugify("fix   bug!!")).toBe("fix-bug");
  });

  it("preserves underscores", () => {
    expect(slugify("my_component")).toBe("my_component");
  });

  it("preserves existing hyphens", () => {
    expect(slugify("foo-bar")).toBe("foo-bar");
  });

  it("handles unicode by replacing with hyphen (no collapsing adjacent)", () => {
    // 'ă' is not [a-z0-9-_] → replaced with '-'.
    // 'mă-duc': ă→-, existing - stays, result is 'm--duc' (not collapsed).
    expect(slugify("mă-duc")).toBe("m--duc");
  });

  it("returns empty string for all-special input", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("numeric-only string passes through", () => {
    expect(slugify("123")).toBe("123");
  });
});

// ── shortPath ─────────────────────────────────────────────────────────

describe("shortPath", () => {
  it("returns path unchanged when segments <= default (2)", () => {
    expect(shortPath("/foo/bar")).toBe("/foo/bar");
  });

  it("truncates long paths to last 2 segments with ellipsis prefix", () => {
    expect(shortPath("/a/b/c/d")).toBe("…/c/d");
  });

  it("respects custom segment count", () => {
    expect(shortPath("/a/b/c/d", 3)).toBe("…/b/c/d");
  });

  it("handles root-like single segment without truncation", () => {
    expect(shortPath("/foo")).toBe("/foo");
  });
});
