import { describe, it, expect } from "vitest";
import { commitAge, parseRefs } from "./HistoryPanel";

// A fixed "now" so these never depend on the clock.
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0); // 2026-08-15T12:00:00Z
const ago = (secs: number) => Math.floor(NOW / 1000) - secs;

describe("commitAge", () => {
  it("counts up through minutes, hours and days", () => {
    expect(commitAge(ago(5), NOW)).toBe("now");
    expect(commitAge(ago(59), NOW)).toBe("now");
    expect(commitAge(ago(60), NOW)).toBe("1m");
    expect(commitAge(ago(14 * 60), NOW)).toBe("14m");
    expect(commitAge(ago(60 * 60), NOW)).toBe("1h");
    expect(commitAge(ago(23 * 3600), NOW)).toBe("23h");
    expect(commitAge(ago(24 * 3600), NOW)).toBe("1d");
    expect(commitAge(ago(6 * 24 * 3600), NOW)).toBe("6d");
  });

  it("switches to a date past a week, and adds the year once it is not this one", () => {
    // A day/month label — exact wording is locale-dependent, so assert on what
    // must hold: no relative suffix, and the day number is in there.
    const lastMonth = commitAge(ago(40 * 24 * 3600), NOW);
    expect(lastMonth).not.toMatch(/\d+[mhd]$/);
    expect(lastMonth).toMatch(/\d/);
    // Two years back must name the year; same-year dates must not.
    expect(commitAge(ago(730 * 24 * 3600), NOW)).toMatch(/2024/);
    expect(commitAge(ago(40 * 24 * 3600), NOW)).not.toMatch(/20\d\d/);
  });

  it("does not blow up on a clock-skewed future commit", () => {
    // A commit stamped in the future (skewed machine, rebased date) reads as
    // "now" rather than a negative age.
    expect(commitAge(ago(-3600), NOW)).toBe("now");
  });
});

describe("parseRefs", () => {
  it("splits git's decorations into typed chips, most informative first", () => {
    // Only the first couple of chips fit on a row, so the order IS the
    // feature: HEAD, then local branches, then tags, remotes last.
    const chips = parseRefs(["origin/main", "tag: v1.2.0", "HEAD -> main", "hotfix"]);
    expect(chips).toEqual([
      { label: "main", kind: "head" },
      { label: "hotfix", kind: "branch" },
      { label: "v1.2.0", kind: "tag" },
      { label: "origin/main", kind: "remote" },
    ]);
  });

  it("handles a detached HEAD and drops empty entries", () => {
    expect(parseRefs(["HEAD"])).toEqual([{ label: "HEAD", kind: "head" }]);
    expect(parseRefs(["", "  "])).toEqual([]);
    expect(parseRefs([])).toEqual([]);
  });

  it("keeps a slashed local branch name intact", () => {
    // `feature/x` is a local branch that LOOKS remote. The chip is a shade
    // off, but the name it shows must be the whole thing.
    expect(parseRefs(["feature/git-graph-199"])[0].label).toBe("feature/git-graph-199");
  });
});
