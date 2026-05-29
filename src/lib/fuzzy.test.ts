import { describe, it, expect } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns a zero-score match for an empty query", () => {
    expect(fuzzyScore("src/App.tsx", "")).toEqual({ path: "src/App.tsx", score: 0, matches: [] });
  });

  it("returns null when a term does not match", () => {
    expect(fuzzyScore("src/App.tsx", "zzzz")).toBeNull();
  });

  it("prefers a contiguous substring over a scattered subsequence", () => {
    // "review" appears contiguously in ReviewDialog and only as a scatter in
    // the other path. Contiguous must win, and its matched indexes must be
    // a contiguous run.
    const contiguous = "src/components/dialogs/ReviewDialog.tsx";
    const scattered = "src/r/e/v/i/e/w/other.tsx";
    const a = fuzzyScore(contiguous, "review")!;
    const b = fuzzyScore(scattered, "review")!;
    expect(a).not.toBeNull();
    expect(a.score).toBeGreaterThan(b.score);
    // contiguous run: each matched index is one more than the previous
    for (let i = 1; i < a.matches.length; i++) {
      expect(a.matches[i]).toBe(a.matches[i - 1] + 1);
    }
  });

  it("ANDs multi-term queries — every term must match", () => {
    const path = "src/components/workspace/TabBar.tsx";
    expect(fuzzyScore(path, "components tabbar")).not.toBeNull();
    // second term absent → whole query fails
    expect(fuzzyScore(path, "components zzz")).toBeNull();
  });

  it("scores a basename match above a same-text directory match", () => {
    const inName = fuzzyScore("src/other/finder.ts", "finder")!;
    const inDir = fuzzyScore("src/finder/other.ts", "finder")!;
    expect(inName.score).toBeGreaterThan(inDir.score);
  });

  it("keeps matches and drops non-matches over a sample set (characterization)", () => {
    const files = [
      "src/components/dialogs/FileFinderDialog.tsx",
      "src/lib/fuzzy.ts",
      "src/components/workspace/FileTree.tsx",
      "docs/readme.md",
    ];
    const matched = files
      .map((f) => fuzzyScore(f, "file"))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s) => s.path);
    // "file"/"File" appears in two of the paths; fuzzy.ts and readme.md
    // have no f-i-l-e subsequence and must be excluded.
    expect(matched).toContain("src/components/dialogs/FileFinderDialog.tsx");
    expect(matched).toContain("src/components/workspace/FileTree.tsx");
    expect(matched).not.toContain("src/lib/fuzzy.ts");
    expect(matched).not.toContain("docs/readme.md");
  });
});
