import { describe, it, expect } from "vitest";
import { pinBoundary, closableSiblings, sidebarDropBeforeId, sidebarTabMoveIndex, type StripTab, type SidebarStripTab } from "./tabActions";

const strip = (...spec: string[]): StripTab[] =>
  spec.map(s => (s.endsWith("*") ? { id: s.slice(0, -1), pinned: true } : { id: s }));

describe("pinBoundary", () => {
  it("is 0 when nothing is pinned", () => {
    expect(pinBoundary(strip("a", "b", "c"), "c")).toBe(0);
  });

  it("counts the pinned block", () => {
    expect(pinBoundary(strip("a*", "b*", "c", "d"), "d")).toBe(2);
  });

  it("ignores the moving tab's own pinned flag", () => {
    // Unpinning "b" must land it right after "a", not after itself.
    expect(pinBoundary(strip("a*", "b*", "c"), "b")).toBe(1);
    // Pinning "c" appends it to the block, which is still 2 long without it.
    expect(pinBoundary(strip("a*", "b*", "c"), "c")).toBe(2);
  });

  it("is the whole length when every other tab is pinned", () => {
    expect(pinBoundary(strip("a*", "b*", "c"), "c")).toBe(2);
  });
});

describe("closableSiblings", () => {
  it("others: every unpinned tab but the clicked one", () => {
    expect(closableSiblings(strip("a", "b", "c"), "b", "others")).toEqual(["a", "c"]);
  });

  it("others: skips pinned tabs", () => {
    expect(closableSiblings(strip("a*", "b", "c", "d*"), "b", "others")).toEqual(["c"]);
  });

  it("right: only the tabs after the clicked one", () => {
    expect(closableSiblings(strip("a", "b", "c", "d"), "b", "right")).toEqual(["c", "d"]);
  });

  it("right: skips pinned tabs after the clicked one", () => {
    expect(closableSiblings(strip("a", "b", "c*", "d"), "b", "right")).toEqual(["d"]);
  });

  it("right: empty on the last tab", () => {
    expect(closableSiblings(strip("a", "b"), "b", "right")).toEqual([]);
  });

  it("others: empty when the clicked tab is the only unpinned one", () => {
    expect(closableSiblings(strip("a*", "b"), "b", "others")).toEqual([]);
  });

  it("never closes the clicked tab, even when it is pinned", () => {
    expect(closableSiblings(strip("a*", "b", "c"), "a", "others")).toEqual(["b", "c"]);
    expect(closableSiblings(strip("a*", "b", "c"), "a", "right")).toEqual(["b", "c"]);
  });

  it("is empty for an unknown tab id", () => {
    expect(closableSiblings(strip("a", "b"), "zz", "others")).toEqual([]);
    expect(closableSiblings(strip("a", "b"), "zz", "right")).toEqual([]);
  });
});

// A task's full tab array, spelled compactly:
//   "a"     main-pane terminal (a sidebar row)
//   "a*"    the same, pinned
//   "e:x"   edit tab (no sidebar row); "d:x" diff, "s:x" scratch
//   "e:x*"  pinned edit tab
//   "p:x"   terminal in a split pane (no sidebar row)
const tabs = (...spec: string[]): SidebarStripTab[] =>
  spec.map(raw => {
    const pinned = raw.endsWith("*");
    const s = pinned ? raw.slice(0, -1) : raw;
    const [kind, id] = s.includes(":") ? s.split(":") : ["t", s];
    const base: SidebarStripTab = kind === "e" ? { id, type: "edit" }
      : kind === "d" ? { id, type: "diff" }
      : kind === "s" ? { id, type: "scratch" }
      : kind === "p" ? { id, type: "terminal", paneId: "pane-1" }
      : { id, type: "terminal" };
    return pinned ? { ...base, pinned: true } : base;
  });

// reorderTab's semantics (src/store/app.ts): remove the tab, then splice it
// in at `toIndex` of the list WITHOUT it.
const applyMove = (all: SidebarStripTab[], id: string, toIndex: number): string[] => {
  const tab = all.find(t => t.id === id)!;
  const without = all.filter(t => t.id !== id);
  without.splice(Math.max(0, Math.min(toIndex, without.length)), 0, tab);
  return without.map(t => t.id);
};

/** The full order after dropping `id` before `beforeId`, or null for no-op. */
const drop = (all: SidebarStripTab[], id: string, beforeId: string | null): string[] | null => {
  const idx = sidebarTabMoveIndex(all, id, beforeId);
  return idx === null ? null : applyMove(all, id, idx);
};

describe("sidebarTabMoveIndex", () => {
  it("moves a row up, before the given row", () => {
    expect(drop(tabs("a", "b", "c"), "c", "a")).toEqual(["c", "a", "b"]);
    expect(drop(tabs("a", "b", "c"), "c", "b")).toEqual(["a", "c", "b"]);
  });

  it("moves a row down", () => {
    expect(drop(tabs("a", "b", "c"), "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("beforeId null puts the row after the last row", () => {
    expect(drop(tabs("a", "b", "c"), "a", null)).toEqual(["b", "c", "a"]);
  });

  it("is null when the row would not move", () => {
    expect(drop(tabs("a", "b", "c"), "b", "c")).toBeNull();
    expect(drop(tabs("a", "b", "c"), "c", null)).toBeNull();
    expect(drop(tabs("a", "b", "c"), "a", "b")).toBeNull();
  });

  it("is null for a single row, with or without hidden tabs", () => {
    expect(sidebarTabMoveIndex(tabs("a"), "a", null)).toBeNull();
    expect(sidebarTabMoveIndex(tabs("e:x", "a", "p:y"), "a", null)).toBeNull();
  });

  it("is null for an unknown dragged id or an unknown anchor", () => {
    expect(sidebarTabMoveIndex(tabs("a", "b"), "zz", "a")).toBeNull();
    expect(sidebarTabMoveIndex(tabs("a", "b"), "b", "zz")).toBeNull();
    // A hidden tab is not a row, so it is not a valid anchor either.
    expect(sidebarTabMoveIndex(tabs("a", "e:x", "b"), "b", "x")).toBeNull();
    // Nor a valid thing to drag.
    expect(sidebarTabMoveIndex(tabs("a", "e:x", "b"), "x", "a")).toBeNull();
  });

  it("keeps hidden edit/diff/scratch tabs where they sit between rows", () => {
    expect(drop(tabs("a", "e:x", "b", "c"), "c", "a")).toEqual(["c", "a", "x", "b"]);
    expect(drop(tabs("a", "d:x", "b", "s:y", "c"), "a", null)).toEqual(["x", "b", "y", "c", "a"]);
  });

  it("keeps split-pane terminals where they sit", () => {
    expect(drop(tabs("a", "p:x", "b", "c"), "c", "b")).toEqual(["a", "x", "c", "b"]);
    expect(drop(tabs("a", "b", "p:x"), "a", null)).toEqual(["b", "a", "x"]);
  });

  it("a pinned row stops at the end of the pinned rows", () => {
    expect(drop(tabs("a*", "b*", "c", "d"), "a", null)).toEqual(["b", "a", "c", "d"]);
    expect(drop(tabs("a*", "b*", "c", "d"), "a", "d")).toEqual(["b", "a", "c", "d"]);
    // Already at the boundary: no-op.
    expect(drop(tabs("a*", "b*", "c"), "b", null)).toBeNull();
  });

  it("an unpinned row cannot cross above the pinned rows", () => {
    expect(drop(tabs("a*", "b*", "c", "d"), "d", "a")).toEqual(["a", "b", "d", "c"]);
    expect(drop(tabs("a*", "b", "c"), "c", "a")).toEqual(["a", "c", "b"]);
    // Already first after the pinned block: no-op.
    expect(drop(tabs("a*", "b", "c"), "b", "a")).toBeNull();
  });

  it("only pinned rows: they reorder among themselves", () => {
    expect(drop(tabs("a*", "b*"), "b", "a")).toEqual(["b", "a"]);
  });

  it("a hidden unpinned tab between the groups stays after the pinned block", () => {
    // [Pa, Pb, U-edit, Ut]: dropping Pa below Pb anchors before Ut, and
    // without the second clamp Pa would land after the unpinned edit tab.
    expect(drop(tabs("Pa*", "Pb*", "e:U", "Ut"), "Pa", "Ut")).toEqual(["Pb", "Pa", "U", "Ut"]);
    expect(drop(tabs("Pa*", "Pb*", "e:U", "Ut"), "Pa", null)).toEqual(["Pb", "Pa", "U", "Ut"]);
  });

  it("an unpinned row dropped at the top stays after a pinned hidden tab", () => {
    // A pinned edit tab heads the strip; the row may not cross above it.
    expect(drop(tabs("e:P*", "a", "b"), "b", "a")).toEqual(["P", "b", "a"]);
  });

  it("randomized: the pinned main tabs stay a prefix of the main strip", () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 42;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const kinds = ["t", "t", "t", "e", "d", "s", "p"];
    for (let round = 0; round < 2000; round++) {
      const n = 2 + rand(7);
      // Build a valid strip: pinned main tabs first, then the rest, with
      // pane tabs sprinkled anywhere (they have their own strip).
      const pinnedCount = rand(n + 1);
      const spec: string[] = [];
      for (let i = 0; i < n; i++) {
        const k = kinds[rand(kinds.length)];
        const id = `${k}${i}`;
        const pin = i < pinnedCount && k !== "p";
        spec.push(k === "t" ? id + (pin ? "*" : "") : `${k}:${id}${pin ? "*" : ""}`);
      }
      const all = tabs(...spec);
      const isMainPinnedPrefix = (order: string[]) => {
        const byId = new Map(all.map(t => [t.id, t]));
        const main = order.map(id => byId.get(id)!).filter(t => !t.paneId);
        const firstUnpinned = main.findIndex(t => !t.pinned);
        return firstUnpinned < 0 || main.slice(firstUnpinned).every(t => !t.pinned);
      };
      if (!isMainPinnedPrefix(all.map(t => t.id))) continue; // invalid start
      const rows = all.filter(t => t.type === "terminal" && !t.paneId);
      if (!rows.length) continue;
      const dragged = rows[rand(rows.length)].id;
      const anchors = [null, ...rows.map(t => t.id)];
      const before = anchors[rand(anchors.length)];
      const idx = sidebarTabMoveIndex(all, dragged, before === dragged ? null : before);
      if (idx === null) continue;
      const after = applyMove(all, dragged, idx);
      expect(isMainPinnedPrefix(after), `${spec.join(",")} drag ${dragged} before ${before}`).toBe(true);
      // Every tab other than the dragged one keeps its relative order.
      expect(after.filter(id => id !== dragged)).toEqual(all.map(t => t.id).filter(id => id !== dragged));
    }
  });
});

describe("sidebarDropBeforeId", () => {
  const row = (id: string, top: number) => ({ kind: "row" as const, id, top, bottom: top + 20 });
  const block = (subgroupId: string, top: number, h: number) => ({ kind: "block" as const, subgroupId, top, bottom: top + h });
  const first = (m: Record<string, string>) => (sg: string) => m[sg] ?? null;

  it("picks the first row whose midpoint is below the cursor, skipping the dragged one", () => {
    const c = [row("a", 0), row("x", 20), row("b", 40)];
    expect(sidebarDropBeforeId(c, 25, "x", first({}))).toBe("b");
    expect(sidebarDropBeforeId(c, 5, "x", first({}))).toBe("a");
    expect(sidebarDropBeforeId(c, 55, "x", first({}))).toBeNull();
  });

  it("a block wholly below the cursor anchors on its first member, not the row it shows", () => {
    // Folded, showing only its last member m3.
    const c = [row("y", 0), block("A", 20, 40), row("m3", 40), row("x", 60)];
    expect(sidebarDropBeforeId(c, 15, "x", first({ A: "m1" }))).toBe("m1");
  });

  it("a folded block with no visible member anchors on its first member too", () => {
    const c = [row("y", 0), block("A", 20, 20), row("x", 40)];
    expect(sidebarDropBeforeId(c, 15, "x", first({ A: "m1" }))).toBe("m1");
  });

  it("inside a block the rows inside decide", () => {
    const c = [row("y", 0), block("A", 20, 40), row("m3", 40), row("x", 60)];
    expect(sidebarDropBeforeId(c, 45, "x", first({ A: "m1" }))).toBe("m3");
    expect(sidebarDropBeforeId(c, 25, "x", first({ A: "m1" }))).toBe("m3");
  });

  it("a block holding only the dragged row falls through to the rows", () => {
    const c = [row("y", 0), block("A", 20, 40), row("x", 40), row("z", 60)];
    expect(sidebarDropBeforeId(c, 15, "x", first({}))).toBe("z");
  });
});
