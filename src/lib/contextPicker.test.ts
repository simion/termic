import { describe, it, expect } from "vitest";
import { rankContextFiles, recencyScore, buildInsertion } from "./contextPicker";
import type { ContextFile } from "./ipc";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const file = (path: string, mtime_ms: number, is_dir = false): ContextFile => ({ path, mtime_ms, is_dir });

describe("recencyScore", () => {
  it("is ~1 for a just-modified file and ~0.5 at one half-life (14 days)", () => {
    expect(recencyScore(NOW, NOW)).toBeCloseTo(1, 5);
    expect(recencyScore(NOW - 14 * DAY, NOW)).toBeCloseTo(0.5, 5);
  });
  it("is 0 for a missing/invalid mtime", () => {
    expect(recencyScore(0, NOW)).toBe(0);
  });
});

describe("rankContextFiles", () => {
  it("orders by recency on an empty query", () => {
    const files = [file("src/old.ts", NOW - 30 * DAY), file("src/new.ts", NOW - 1 * DAY)];
    const ranked = rankContextFiles(files, new Set(), "", NOW);
    expect(ranked.map((r) => r.path)).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("floats a git-changed file above an equal-recency unchanged file", () => {
    const files = [file("src/a.ts", NOW - 5 * DAY), file("src/b.ts", NOW - 5 * DAY)];
    const ranked = rankContextFiles(files, new Set(["src/b.ts"]), "", NOW);
    expect(ranked[0].path).toBe("src/b.ts");
  });

  it("lets a strong name match beat a stale-but-fresher weak match", () => {
    // Strong exact basename match, but old. Weak subsequence match, but fresh.
    const strongOld = file("src/App.tsx", NOW - 90 * DAY);
    const weakFresh = file("a/p/parser.ts", NOW); // a-p-p only as a scattered subsequence
    const ranked = rankContextFiles([weakFresh, strongOld], new Set(), "app", NOW);
    expect(ranked[0].path).toBe("src/App.tsx");
  });

  it("drops non-matching files when a query is present", () => {
    const files = [file("src/App.tsx", NOW), file("docs/readme.md", NOW)];
    const ranked = rankContextFiles(files, new Set(), "app", NOW);
    expect(ranked.map((r) => r.path)).toEqual(["src/App.tsx"]);
  });

  it("carries match indexes through for highlighting", () => {
    const ranked = rankContextFiles([file("src/App.tsx", NOW)], new Set(), "app", NOW);
    expect(ranked[0].matches.length).toBeGreaterThan(0);
  });
});

describe("buildInsertion", () => {
  it("returns empty string for no selection", () => {
    expect(buildInsertion([])).toBe("");
  });
  it("formats a single file with a trailing space", () => {
    expect(buildInsertion([{ path: "src/a.ts", is_dir: false }])).toBe("@src/a.ts ");
  });
  it("space-joins multiple files with one trailing space", () => {
    expect(
      buildInsertion([
        { path: "src/a.ts", is_dir: false },
        { path: "src/b.ts", is_dir: false },
      ]),
    ).toBe("@src/a.ts @src/b.ts ");
  });
  it("appends a trailing slash to directories", () => {
    expect(buildInsertion([{ path: "src/components", is_dir: true }])).toBe("@src/components/ ");
  });
  it("backslash-escapes spaces in paths", () => {
    expect(buildInsertion([{ path: "my docs/a b.ts", is_dir: false }])).toBe("@my\\ docs/a\\ b.ts ");
  });
});
