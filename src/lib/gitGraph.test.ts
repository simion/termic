import { describe, it, expect } from "vitest";
import { layoutGraph, graphWidth, type GraphCommit, type GraphRow } from "./gitGraph";

/** Terse commit builder: `c("b", "a")` = b with parent a. */
const c = (sha: string, ...parents: string[]): GraphCommit => ({ sha, parents });

const laneOf = (rows: GraphRow[], sha: string) => rows.find(r => r.sha === sha)!.lane;
const colorOf = (rows: GraphRow[], sha: string) => rows.find(r => r.sha === sha)!.color;
const outs = (rows: GraphRow[], sha: string) =>
  rows.find(r => r.sha === sha)!.links.filter(l => l.kind === "out");
const ins = (rows: GraphRow[], sha: string) =>
  rows.find(r => r.sha === sha)!.links.filter(l => l.kind === "in");

describe("layoutGraph", () => {
  it("keeps a linear history in one lane with one colour", () => {
    const rows = layoutGraph([c("d", "c"), c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0, 0]);
    expect(new Set(rows.map(r => r.color)).size).toBe(1);
    expect(graphWidth(rows)).toBe(1);
    // The tip has no line arriving from above; the root has none leaving.
    expect(ins(rows, "d")).toHaveLength(0);
    expect(outs(rows, "a")).toHaveLength(0);
  });

  it("gives a diverged branch its own lane and colour", () => {
    //   f (branch tip)   e (main tip)
    //    \               |
    //     \--------------d
    const rows = layoutGraph([c("f", "d"), c("e", "d"), c("d", "c"), c("c")]);
    expect(laneOf(rows, "f")).toBe(0);
    expect(laneOf(rows, "e")).toBe(1);
    expect(colorOf(rows, "e")).not.toBe(colorOf(rows, "f"));
    // e's line curves back into lane 0 at its own row (lane 0 is already
    // heading for d), so d itself is a single-column dot below both tips.
    expect(outs(rows, "e")).toMatchObject([{ fromLane: 1, toLane: 0 }]);
    expect(laneOf(rows, "d")).toBe(0);
    expect(ins(rows, "d").map(l => l.fromLane)).toEqual([0]);
    expect(graphWidth(rows)).toBe(2);
  });

  it("routes a merge's second parent into its own lane and closes it on merge-back", () => {
    //   m ── merge of main (a-side) and a topic branch
    //   |\
    //   | t   topic commit
    //   b/    main commit, also the topic's base
    const rows = layoutGraph([c("m", "b2", "t"), c("b2", "b"), c("t", "b"), c("b")]);
    expect(laneOf(rows, "m")).toBe(0);
    const mOut = outs(rows, "m");
    expect(mOut).toHaveLength(2);
    // First parent inherits the merge's lane + colour (straight line down).
    expect(mOut[0]).toMatchObject({ fromLane: 0, toLane: 0, color: colorOf(rows, "m") });
    // Second parent opens a lane of its own, in a different colour.
    expect(mOut[1].toLane).toBe(1);
    expect(mOut[1].color).not.toBe(colorOf(rows, "m"));
    expect(laneOf(rows, "t")).toBe(1);
    // The topic's line rejoins the main lane AT t (its parent b is already
    // tracked in lane 0), so it curves left there rather than running a second
    // column all the way down to b.
    expect(outs(rows, "t")).toMatchObject([{ fromLane: 1, toLane: 0 }]);
    // Below that the graph is one column again, and b takes it.
    expect(laneOf(rows, "b")).toBe(0);
    expect(ins(rows, "b").map(l => l.fromLane)).toEqual([0]);
    expect(rows[rows.length - 1].width).toBe(1);
  });

  it("draws a merge whose second parent is an already-tracked lane as a join, not a new column", () => {
    // Both parents of m are lines already on screen (x is waited on by the
    // side branch). The second edge must aim at that lane, not open a third.
    const rows = layoutGraph([c("m", "p", "x"), c("s", "x"), c("p", "x"), c("x")]);
    const mOut = outs(rows, "m");
    expect(mOut).toHaveLength(2);
    expect(new Set(mOut.map(l => l.toLane)).size).toBe(2);
    expect(graphWidth(rows)).toBeLessThanOrEqual(3);
    // Everything funnels into x, whose dot sits in the leftmost lane still
    // WAITING for it (lane 0 was released when p rejoined lane 1).
    expect(laneOf(rows, "x")).toBe(1);
    expect(outs(rows, "p")).toMatchObject([{ fromLane: 0, toLane: 1 }]);
  });

  it("reuses a freed lane instead of drifting right", () => {
    // The topic branch (lane 1) ends at t; the next independent tip must take
    // lane 1 back rather than opening lane 2.
    const rows = layoutGraph([c("m", "b", "t"), c("t"), c("head2", "b"), c("b")]);
    expect(laneOf(rows, "t")).toBe(1);
    expect(laneOf(rows, "head2")).toBe(1);
    expect(graphWidth(rows)).toBe(2);
  });

  it("handles an octopus merge: one out-link per parent", () => {
    const rows = layoutGraph([c("o", "a", "b", "c"), c("a"), c("b"), c("c")]);
    const oOut = outs(rows, "o");
    expect(oOut.map(l => l.toLane)).toEqual([0, 1, 2]);
    expect(new Set(oOut.map(l => l.color)).size).toBe(3);
    expect(graphWidth(rows)).toBe(3);
  });

  it("leaves lines dangling when a page cuts history mid-branch", () => {
    // `head`'s parent is off-page: the lane stays open past the last row so
    // the segment runs off the bottom edge, and nothing crashes.
    const rows = layoutGraph([c("head", "offpage")]);
    expect(rows).toHaveLength(1);
    expect(outs(rows, "head")).toMatchObject([{ fromLane: 0, toLane: 0 }]);
  });

  it("never emits a negative or fractional lane, and links stay inside the row width", () => {
    // A gnarly little DAG: two roots, a cross-merge, a branch that outlives it.
    const rows = layoutGraph([
      c("z", "y", "w"), c("y", "x"), c("w", "v"), c("x", "r1"), c("v", "r1"), c("r1"), c("r2"),
    ]);
    for (const r of rows) {
      expect(Number.isInteger(r.lane)).toBe(true);
      expect(r.lane).toBeGreaterThanOrEqual(0);
      expect(r.lane).toBeLessThan(r.width);
      for (const l of r.links) {
        expect(l.fromLane).toBeGreaterThanOrEqual(0);
        expect(l.toLane).toBeGreaterThanOrEqual(0);
        expect(Math.max(l.fromLane, l.toLane)).toBeLessThan(r.width);
      }
    }
  });

  it("hands out colours per branch LINE, not per lane, so a narrow graph still uses the whole palette", () => {
    // Ten short-lived branches that each merge straight back: the graph never
    // gets wider than two lanes, but ten distinct lines are drawn. A colour
    // scheme keyed on the lane index would paint them all with two colours —
    // and would cap the usable palette at the gutter's clip width.
    const commits: GraphCommit[] = [];
    for (let i = 0; i < 10; i++) {
      commits.push(c(`m${i}`, `b${i}`, `t${i}`));  // merge
      commits.push(c(`t${i}`, `b${i}`));           // topic commit
      commits.push(c(`b${i}`, `m${i + 1}`));       // base, continues down
    }
    const rows = layoutGraph(commits);
    expect(graphWidth(rows)).toBeLessThanOrEqual(3);
    const colors = new Set(rows.flatMap(r => [r.color, ...r.links.map(l => l.color)]));
    expect(colors.size).toBeGreaterThan(6);
  });

  it("returns nothing for an empty history", () => {
    expect(layoutGraph([])).toEqual([]);
    expect(graphWidth([])).toBe(0);
  });
});
