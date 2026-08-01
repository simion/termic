import { describe, it, expect } from "vitest";
import { slugify, branchify, shortPath, formatBytes } from "@/lib/utils";

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

// ── branchify ─────────────────────────────────────────────────────────

describe("branchify", () => {
  it("preserves slashes in an already-qualified branch", () => {
    // The #15 case: a Linear branch pasted verbatim stays multi-segment.
    expect(branchify("jarred/special-branch-name")).toBe("jarred/special-branch-name");
  });

  it("slugifies each segment independently", () => {
    expect(branchify("Jarred/Login Fix")).toBe("jarred/login-fix");
  });

  it("drops leading, trailing, and doubled slashes", () => {
    expect(branchify("/feature//login/")).toBe("feature/login");
  });

  it("matches slugify when there is no slash", () => {
    expect(branchify("fix login bug")).toBe(slugify("fix login bug"));
  });

  it("returns empty string for slash-only input", () => {
    expect(branchify("///")).toBe("");
  });

  it("keeps underscores and hyphens within a segment", () => {
    expect(branchify("user/my_cool-feature")).toBe("user/my_cool-feature");
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

// ── formatBytes ───────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("shows raw bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  it("switches to KB at 1000 bytes", () => {
    expect(formatBytes(1000)).toBe("1.0 KB");
    expect(formatBytes(2450)).toBe("2.5 KB");
  });

  it("drops the decimal at 10 units and above", () => {
    expect(formatBytes(9950)).toBe("10 KB");
    expect(formatBytes(245_000)).toBe("245 KB");
  });

  it("steps up through MB and GB", () => {
    expect(formatBytes(1_400_000)).toBe("1.4 MB");
    expect(formatBytes(20_000_000)).toBe("20 MB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
  });

  it("stays in GB beyond the largest unit", () => {
    expect(formatBytes(5_000_000_000_000)).toBe("5000 GB");
  });
});
