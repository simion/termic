import { describe, it, expect } from "vitest";
import {
  gatherSubgroupRuns, layoutTabRows, nextSubgroupColor, reseatForSubgroup, sameSubgroup,
  stripMembership, subgroupBadgeKinds, subgroupIdsIn, taskSubgroups, withSubgroup,
} from "@/lib/tabSubgroups";
import type { Tab, TabSubgroup, TerminalTab } from "@/lib/types";

const A: TabSubgroup = { id: "A", name: "Alpha", color: "blue" };
const B: TabSubgroup = { id: "B", name: "Beta", color: "teal" };

function term(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return { id, type: "terminal", title: id, cli: "claude", ...extra };
}
const edit = (id: string): Tab => ({ id, type: "edit", title: id, path: `/${id}` } as unknown as Tab);
const ids = (l: readonly Tab[]) => l.map(t => t.id);
const groups = (l: readonly Tab[]) => l.map(t => (t as TerminalTab).subgroup?.id ?? "-").join("");

describe("layoutTabRows", () => {
  it("draws loose rows as rows and a subgroup as one block at its first member", () => {
    const rows = [term("a"), term("b", { subgroup: A }), term("c"), term("d", { subgroup: A })];
    const segs = layoutTabRows(rows);
    expect(segs.map(s => (s.kind === "tab" ? s.tab.id : `[${s.subgroup.id}:${ids(s.tabs).join(",")}]`)))
      .toEqual(["a", "[A:b,d]", "c"]);
  });

  it("ignores a stray subgroup on a pinned tab", () => {
    const segs = layoutTabRows([term("p", { pinned: true, subgroup: A }), term("x", { subgroup: A })]);
    expect(segs.map(s => s.kind)).toEqual(["tab", "subgroup"]);
  });

  it("uses the first member's copy for the block", () => {
    const segs = layoutTabRows([term("a", { subgroup: { ...A, name: "First" } }), term("b", { subgroup: A })]);
    expect(segs[0].kind === "subgroup" && segs[0].subgroup.name).toBe("First");
  });

  it("honours an override, so a dragged row can wear the hovered subgroup", () => {
    const rows = [term("a", { subgroup: A }), term("b"), term("c", { subgroup: B })];
    const segs = layoutTabRows(rows, t => (t.id === "b" ? A : t.subgroup ?? null));
    expect(segs.map(s => (s.kind === "subgroup" ? `${s.subgroup.id}:${ids(s.tabs)}` : s.tab.id)))
      .toEqual(["A:a,b", "B:c"]);
  });
});

describe("taskSubgroups / subgroupIdsIn", () => {
  it("lists each subgroup once, first appearance first, skipping pane tabs", () => {
    const tabs = [term("a", { subgroup: B }), term("b", { subgroup: A }), term("c", { subgroup: B }), term("p", { paneId: "x", subgroup: { id: "Z", name: "z" } })];
    expect(taskSubgroups(tabs).map(g => g.id)).toEqual(["B", "A"]);
  });

  it("collects ids across lists", () => {
    expect([...subgroupIdsIn([[{ subgroup: A }], undefined, [{}, { subgroup: B }]])].sort()).toEqual(["A", "B"]);
  });
});

describe("gatherSubgroupRuns", () => {
  it("returns the same array when every run is contiguous", () => {
    const all = [term("a"), term("b", { subgroup: A }), term("c", { subgroup: A }), term("d")];
    expect(gatherSubgroupRuns(all)).toBe(all);
  });

  it("gathers a split run at its first member's position", () => {
    const all = [term("a", { subgroup: A }), term("x"), term("b", { subgroup: A }), term("c", { subgroup: B }), term("y"), term("d", { subgroup: B })];
    expect(ids(gatherSubgroupRuns(all))).toEqual(["a", "b", "x", "c", "d", "y"]);
  });

  it("leaves hidden edit and split-pane tabs in their slots", () => {
    const all = [term("a", { subgroup: A }), edit("e"), term("x"), term("p", { paneId: "L" }), term("b", { subgroup: A })];
    expect(ids(gatherSubgroupRuns(all))).toEqual(["a", "e", "b", "p", "x"]);
  });
});

describe("withSubgroup", () => {
  it("removes the key for null instead of writing undefined", () => {
    const t = withSubgroup(term("a", { subgroup: A }), null);
    expect("subgroup" in t).toBe(false);
  });

  it("unpins a tab that joins", () => {
    const t = withSubgroup(term("a", { pinned: true }), A);
    expect(t.pinned).toBeUndefined();
    expect(t.subgroup).toBe(A);
  });
});

describe("reseatForSubgroup", () => {
  const base = () => [term("p", { pinned: true }), term("a", { subgroup: A }), term("b", { subgroup: A }), term("x"), term("y")];

  it("joining places the tab after the subgroup's last member", () => {
    const next = reseatForSubgroup(base(), "y", A);
    expect(ids(next)).toEqual(["p", "a", "b", "y", "x"]);
    expect(groups(next)).toEqual("-AAA-");
  });

  it("leaving places the tab right after the run it left", () => {
    const next = reseatForSubgroup(base(), "a", null);
    expect(ids(next)).toEqual(["p", "b", "a", "x", "y"]);
    expect(groups(next)).toEqual("-A---");
  });

  it("a lone member leaving stays put", () => {
    const all = [term("x"), term("a", { subgroup: A }), term("y")];
    const next = reseatForSubgroup(all, "a", null);
    expect(ids(next)).toEqual(["x", "a", "y"]);
    expect(groups(next)).toEqual("---");
  });

  it("moving between subgroups joins the other one's tail", () => {
    const all = [term("a", { subgroup: A }), term("b", { subgroup: A }), term("c", { subgroup: B }), term("d", { subgroup: B })];
    const next = reseatForSubgroup(all, "a", B);
    expect(ids(next)).toEqual(["b", "c", "d", "a"]);
    expect(groups(next)).toEqual("ABBB");
  });

  it("founding a subgroup from inside another run steps out of it first", () => {
    const all = [term("a", { subgroup: A }), term("b", { subgroup: A }), term("c", { subgroup: A })];
    const next = reseatForSubgroup(all, "b", B);
    expect(ids(next)).toEqual(["a", "c", "b"]);
    expect(groups(next)).toEqual("AAB");
  });

  it("a pinned tab joining is unpinned and leaves the pinned block", () => {
    const all = [term("p", { pinned: true }), term("q", { pinned: true }), term("x")];
    const next = reseatForSubgroup(all, "p", B);
    expect(ids(next)).toEqual(["q", "p", "x"]);
    expect((next[1] as TerminalTab).pinned).toBeUndefined();
  });

  it("a pinned tab joining steps past a pinned EDIT tab too (every pill can be pinned)", () => {
    const pe = { ...edit("pe"), pinned: true } as Tab;
    const all = [term("pt", { pinned: true }), pe, term("u")];
    const next = reseatForSubgroup(all, "pt", B);
    expect(ids(next)).toEqual(["pe", "pt", "u"]);
    expect(next[0].pinned).toBe(true);
    expect((next[1] as TerminalTab).pinned).toBeUndefined();
  });

  it("returns the same array when nothing changes", () => {
    const all = base();
    expect(reseatForSubgroup(all, "a", A)).toBe(all);
    expect(reseatForSubgroup(all, "x", null)).toBe(all);
    expect(reseatForSubgroup(all, "nope", A)).toBe(all);
  });

  it("refreshes a disagreeing copy in place", () => {
    const all = base();
    const next = reseatForSubgroup(all, "a", { ...A, name: "New" });
    expect(ids(next)).toEqual(ids(all));
    expect((next[1] as TerminalTab).subgroup?.name).toBe("New");
  });

  it("refuses split-pane tabs", () => {
    const all = [term("a", { paneId: "L" })];
    expect(reseatForSubgroup(all, "a", A)).toBe(all);
  });
});

describe("stripMembership (tab strip drop)", () => {
  it("landing between two members joins", () => {
    expect(stripMembership([term("a", { subgroup: A }), term("x"), term("b", { subgroup: A })], "x")).toBe(A);
  });

  it("a loose tab at the edge of a run stays loose", () => {
    expect(stripMembership([term("a", { subgroup: A }), term("b", { subgroup: A }), term("x")], "x")).toBeNull();
    expect(stripMembership([term("x"), term("a", { subgroup: A })], "x")).toBeNull();
  });

  it("a member still touching its run stays", () => {
    expect(stripMembership([term("a", { subgroup: A }), term("b", { subgroup: A }), term("x")], "b")?.id).toBe("A");
  });

  it("a member dropped away from its run leaves", () => {
    expect(stripMembership([term("a", { subgroup: A }), term("x"), term("b", { subgroup: A })], "b")).toBeNull();
  });

  it("a lone member keeps its subgroup anywhere", () => {
    expect(stripMembership([term("x"), term("y"), term("a", { subgroup: A })], "a")?.id).toBe("A");
  });

  it("a member landing inside another run joins that one", () => {
    expect(stripMembership([term("c", { subgroup: B }), term("a", { subgroup: A }), term("d", { subgroup: B }), term("b", { subgroup: A })], "a")?.id).toBe("B");
  });

  it("a pinned tab never joins", () => {
    expect(stripMembership([term("a", { subgroup: A }), term("p", { pinned: true }), term("b", { subgroup: A })], "p")).toBeNull();
  });
});

describe("subgroupBadgeKinds", () => {
  const prefs = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
  it("carries one of each mark the hidden rows draw, not just the most urgent", () => {
    const kinds = subgroupBadgeKinds([
      term("a", { workState: "done" }),
      term("b", { unread: { reason: "attention" } } as Partial<TerminalTab>),
      term("c", { workState: "done" }),
      term("d"),
    ], prefs, false);
    expect(kinds).toEqual(["attention", "done"]);
  });

  it("honours the prefs that hide a mark", () => {
    expect(subgroupBadgeKinds([term("a", { workState: "working" })], { ...prefs, workingIndicator: false }, false)).toEqual([]);
  });
});

describe("nextSubgroupColor", () => {
  it("picks the first founding accent no subgroup of the task wears", () => {
    expect(nextSubgroupColor([])).toBe("blue");
    expect(nextSubgroupColor([term("a", { subgroup: A })])).toBe("teal");
    expect(nextSubgroupColor([term("a", { subgroup: A }), term("b", { subgroup: B })])).toBe("purple");
  });
});

describe("sameSubgroup", () => {
  it("compares the copy, with an absent colour equal to none", () => {
    expect(sameSubgroup(A, { ...A })).toBe(true);
    expect(sameSubgroup({ id: "A", name: "n" }, { id: "A", name: "n", color: undefined })).toBe(true);
    expect(sameSubgroup(A, { ...A, name: "x" })).toBe(false);
    expect(sameSubgroup(undefined, null)).toBe(true);
  });
});
