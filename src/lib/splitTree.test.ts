import { describe, expect, it } from "vitest";
import { dropEmptyLeaves, focusedTabId, getAllLeaves, pruneLeafTabs } from "./splitTree";
import type { PaneLeaf, SplitTree } from "./splitTree";

const pane = (id: string, tabIds: string[], isMain = false): PaneLeaf => ({
  type: "pane", id, tabIds, activeTabId: tabIds[0] ?? null,
  ...(isMain ? { isMain: true } : {}),
});

const split = (id: string, a: SplitTree, b: SplitTree, ratio = 0.5): SplitTree =>
  ({ type: "split", id, dir: "v", ratio, a, b });

describe("dropEmptyLeaves", () => {
  it("collapses a split when one pane has no tabs left", () => {
    const t = split("s1", pane("main", [], true), pane("p1", []));
    // Only the main leaf survives, and a lone pane is no longer a split.
    expect(dropEmptyLeaves(t)).toEqual(pane("main", [], true));
  });

  it("keeps a pane that still holds tabs", () => {
    const t = split("s1", pane("main", [], true), pane("p1", ["a"]));
    expect(dropEmptyLeaves(t)).toEqual(t);
  });

  it("never drops the main leaf, which legitimately holds no tabIds", () => {
    // Main mirrors activeTab[taskId] rather than owning ids, so empty tabIds
    // there is the normal case, not an empty pane.
    expect(dropEmptyLeaves(pane("main", [], true))).toEqual(pane("main", [], true));
  });

  it("drops several empty panes and keeps the survivors nested", () => {
    const t = split("s1",
      split("s2", pane("main", [], true), pane("p1", [])),
      split("s3", pane("p2", ["b"]), pane("p3", [])));
    expect(dropEmptyLeaves(t)).toEqual(split("s1", pane("main", [], true), pane("p2", ["b"])));
  });

  it("preserves the ratios of splits that survive", () => {
    // The removed leaf's parent disappears whole, so nothing needs
    // rebalancing and the user's sizing elsewhere must not be touched.
    const t = split("s1",
      split("s2", pane("main", [], true), pane("p1", ["a"]), 0.25),
      pane("p2", []));
    expect(dropEmptyLeaves(t)).toEqual(
      split("s2", pane("main", [], true), pane("p1", ["a"]), 0.25));
  });

  it("returns null when nothing survives", () => {
    expect(dropEmptyLeaves(split("s1", pane("p1", []), pane("p2", [])))).toBeNull();
  });

  it("repairs the real recorded layout: prune then collapse", () => {
    // Verbatim from a task on disk whose split_layout outlived every tab it
    // referenced (persisted `tabs` was empty). Pruning alone left an empty
    // pane beside an empty main, which is the blank left pane in the report.
    const saved: SplitTree = {
      type: "split", id: "8caa989a", dir: "v", ratio: 0.5,
      a: { type: "pane", id: "f2c31f7d", isMain: true, tabIds: [], activeTabId: null },
      b: {
        type: "pane", id: "aed7b79a",
        tabIds: ["4dccb4ca", "26ee7af0"],
        activeTabId: "26ee7af0",
      },
    };
    const pruned = pruneLeafTabs(saved, new Set());       // nothing restored
    expect(getAllLeaves(pruned)).toHaveLength(2);          // pruning keeps the hole
    const repaired = dropEmptyLeaves(pruned);
    expect(repaired?.type).toBe("pane");                   // back to an unsplit task
    expect((repaired as PaneLeaf).isMain).toBe(true);
  });

  it("keeps the split when the pane's tabs did restore", () => {
    const saved: SplitTree = {
      type: "split", id: "s1", dir: "v", ratio: 0.5,
      a: { type: "pane", id: "main", isMain: true, tabIds: [], activeTabId: null },
      b: { type: "pane", id: "p1", tabIds: ["t1", "t2"], activeTabId: "t2" },
    };
    const repaired = dropEmptyLeaves(pruneLeafTabs(saved, new Set(["t1", "t2"])));
    expect(repaired?.type).toBe("split");
    expect(getAllLeaves(repaired!)).toHaveLength(2);
  });

  it("keeps a pane whose tabs only PARTLY restored", () => {
    const saved: SplitTree = {
      type: "split", id: "s1", dir: "v", ratio: 0.5,
      a: { type: "pane", id: "main", isMain: true, tabIds: [], activeTabId: null },
      b: { type: "pane", id: "p1", tabIds: ["t1", "gone"], activeTabId: "gone" },
    };
    const repaired = dropEmptyLeaves(pruneLeafTabs(saved, new Set(["t1"])));
    expect(repaired?.type).toBe("split");
    // activeTabId must fall back to a real tab, not the pruned ghost.
    const leaf = getAllLeaves(repaired!).find(l => l.id === "p1")!;
    expect(leaf.tabIds).toEqual(["t1"]);
    expect(leaf.activeTabId).toBe("t1");
  });
});

describe("focusedTabId", () => {
  // No split: the main pane's active tab always owns the keyboard.
  it("returns the main pane's active tab when there is no split", () => {
    expect(focusedTabId(null, "", "main-tab")).toBe("main-tab");
    expect(focusedTabId(pane("main", [], true), "", "main-tab")).toBe("main-tab");
  });

  it("returns the focused leaf's active tab", () => {
    const t = split("s1", pane("main", [], true), pane("p1", ["leaf-tab"]));
    expect(focusedTabId(t, "p1", "main-tab")).toBe("leaf-tab");
  });

  // The case TaskView's inline predicate got wrong: it answered "the active
  // main tab" for main tabs unconditionally, ignoring which pane was focused.
  // A split leaf holding the focus leaves the main tab visible but silent.
  it("does NOT hand the keyboard to the main tab while a split leaf is focused", () => {
    const t = split("s1", pane("main", [], true), pane("p1", ["leaf-tab"]));
    expect(focusedTabId(t, "p1", "main-tab")).not.toBe("main-tab");
  });

  it("hands it back to main when the main leaf itself is focused", () => {
    const t = split("s1", pane("main", [], true), pane("p1", ["leaf-tab"]));
    expect(focusedTabId(t, "main", "main-tab")).toBe("main-tab");
  });

  // Focus not yet placed in any pane (fresh split, activePaneId still empty):
  // main keeps the keyboard rather than nobody having it.
  it("falls back to main when no pane is focused, or the id is stale", () => {
    const t = split("s1", pane("main", [], true), pane("p1", ["leaf-tab"]));
    expect(focusedTabId(t, "", "main-tab")).toBe("main-tab");
    expect(focusedTabId(t, "gone", "main-tab")).toBe("main-tab");
  });

  it("returns null for a focused leaf with no tabs (an empty SplitLauncher)", () => {
    const t = split("s1", pane("main", [], true), pane("p1", []));
    expect(focusedTabId(t, "p1", "main-tab")).toBeNull();
  });

  // Only ONE tab app-wide may answer true. Walk every pane in turn: each must
  // name its OWN tab and no other, so no two callers can both claim the key.
  it("names exactly one tab across a three-pane tree", () => {
    const t = split("s1", pane("main", [], true), split("s2", pane("p1", ["a"]), pane("p2", ["b"])));
    const named = ["main", "p1", "p2"].map(p => focusedTabId(t, p, "main-tab"));
    expect(named).toEqual(["main-tab", "a", "b"]);
    expect(new Set(named).size).toBe(3);
  });
});
