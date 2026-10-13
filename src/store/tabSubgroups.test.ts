// @vitest-environment happy-dom
//
// Tab subgroups in the app store (docs/ui.md "Tab subgroups"). The pure
// rules are pinned in src/lib/tabSubgroups.test.ts; this covers the actions
// that apply them, what reaches disk, and the restore path.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetSplitLayout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
  STICKY_DONE_MS: 8_000,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import * as ipc from "@/lib/ipc";
import type { PersistedTab, TabSubgroup, TerminalTab } from "@/lib/types";
import {
  getTabIds as ids, getTabs, makeTask, makeTerminalTab, resetAppStore, seedTab,
} from "@/test-utils/store";

const A: TabSubgroup = { id: "A", name: "Alpha", color: "blue" };
const B: TabSubgroup = { id: "B", name: "Beta", color: "teal" };

const groupsOf = (taskId: string) =>
  getTabs(taskId).map(t => (t as TerminalTab).subgroup?.id ?? "-").join("");
const tabOf = (id: string) => getTabs("ws1").find(t => t.id === id) as TerminalTab;
const lastPersisted = () => {
  const calls = vi.mocked(ipc.taskSetTabs).mock.calls;
  return calls[calls.length - 1]?.[1] as PersistedTab[];
};
function seed(...tabs: Partial<TerminalTab>[]) {
  useApp.setState({ tasks: [makeTask({ id: "ws1" })] });
  for (const t of tabs) seedTab("ws1", makeTerminalTab(t));
}

beforeEach(() => {
  resetAppStore();
  useApp.setState({ splitTree: {}, activePaneId: {}, paneHistory: {}, collapsedTabSubgroups: {} });
  useUI.setState({ tabSubgroupRenaming: null });
  vi.clearAllMocks();
});

describe("setTabSubgroup (the row menu)", () => {
  it("joins at the subgroup's tail and persists the copy", () => {
    seed({ id: "a", subgroup: A }, { id: "x" }, { id: "y" });
    useApp.getState().setTabSubgroup("ws1", "y", A);
    expect(ids("ws1")).toEqual(["a", "y", "x"]);
    expect(groupsOf("ws1")).toBe("AA-");
    expect(lastPersisted().find(p => p.id === "y")?.subgroup).toEqual(A);
  });

  it("leaving lands right after the run, and is ABSENT on disk", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" });
    useApp.getState().setTabSubgroup("ws1", "a", null);
    expect(ids("ws1")).toEqual(["b", "a", "x"]);
    expect(groupsOf("ws1")).toBe("A--");
    expect("subgroup" in tabOf("a")).toBe(false);
    expect("subgroup" in lastPersisted().find(p => p.id === "a")!).toBe(false);
  });

  it("moves a member between subgroups", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "c", subgroup: B });
    useApp.getState().setTabSubgroup("ws1", "a", B);
    expect(ids("ws1")).toEqual(["b", "c", "a"]);
    expect(groupsOf("ws1")).toBe("ABB");
  });

  it("unpins a pinned tab that joins", () => {
    seed({ id: "p", pinned: true }, { id: "a", subgroup: A });
    useApp.getState().setTabSubgroup("ws1", "p", A);
    expect(ids("ws1")).toEqual(["a", "p"]);
    expect(tabOf("p").pinned).toBeFalsy();
    expect(lastPersisted().find(p => p.id === "p")?.pinned).toBe(false);
  });
});

describe("store setters bail on unchanged values (bear trap 8)", () => {
  it("writes nothing when nothing changes", () => {
    seed({ id: "a", subgroup: A }, { id: "x" });
    const before = useApp.getState();
    useApp.getState().setTabSubgroup("ws1", "a", { ...A });
    useApp.getState().setTabSubgroup("ws1", "x", null);
    useApp.getState().setTabSubgroup("ws1", "nope", A);
    useApp.getState().renameTabSubgroup("ws1", "A", "Alpha");
    useApp.getState().renameTabSubgroup("ws1", "A", "   ");
    useApp.getState().recolorTabSubgroup("ws1", "A", "blue");
    useApp.getState().dissolveTabSubgroup("ws1", "nope");
    useApp.getState().setTabSubgroupCollapsed("A", false);
    useApp.getState().dropTabInSubgroup("ws1", "a", A);
    useApp.getState().settleStripTabSubgroup("ws1", "x");
    expect(useApp.getState()).toBe(before);
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
  });
});

describe("rename / recolour / dissolve", () => {
  it("rename and recolour rewrite every member's copy, trimmed", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: { ...A, name: "stale" } }, { id: "x" });
    useApp.getState().renameTabSubgroup("ws1", "A", "  Backend ");
    expect([tabOf("a"), tabOf("b")].map(t => t.subgroup?.name)).toEqual(["Backend", "Backend"]);
    useApp.getState().recolorTabSubgroup("ws1", "A", undefined);
    const sg = tabOf("a").subgroup!;
    expect(sg).toEqual({ id: "A", name: "Backend" });
    expect("color" in sg).toBe(false);
    expect(lastPersisted().filter(p => p.subgroup).map(p => p.subgroup)).toEqual([sg, sg]);
  });

  it("a stray copy on a pinned tab is neither rewritten nor unpinned", () => {
    // A pinned tab is never a member (memberOf), whatever a bad write left
    // on it, so a rename or a dissolve of that subgroup leaves it alone.
    seed({ id: "p", pinned: true, subgroup: A }, { id: "a", subgroup: A });
    useApp.getState().renameTabSubgroup("ws1", "A", "Renamed");
    expect(tabOf("p").pinned).toBe(true);
    expect(tabOf("p").subgroup).toEqual(A);
    expect(tabOf("a").subgroup?.name).toBe("Renamed");
    useApp.getState().dissolveTabSubgroup("ws1", "A");
    expect(tabOf("p").pinned).toBe(true);
  });

  it("the first MEMBER's copy is canonical, not a pinned tab's stray one", () => {
    seed({ id: "p", pinned: true, subgroup: { ...A, color: "red" } }, { id: "a", subgroup: A });
    useApp.getState().renameTabSubgroup("ws1", "A", "Renamed");
    expect(tabOf("a").subgroup).toEqual({ ...A, name: "Renamed" });
  });

  it("dissolve clears every member and keeps positions", () => {
    seed({ id: "x" }, { id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "c", subgroup: B });
    useApp.getState().dissolveTabSubgroup("ws1", "A");
    expect(ids("ws1")).toEqual(["x", "a", "b", "c"]);
    expect(groupsOf("ws1")).toBe("---B");
  });

  it("a closed member resumed comes back loose; resumed below a member, it joins", () => {
    // The closed-tab entry keeps no membership (docs/ui.md "Tab subgroups").
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" });
    const entry = (tabId: string) => ({ id: `e-${tabId}`, tabId, title: "Claude", cli: "claude", closedAt: new Date().toISOString() });
    useApp.setState(s => ({ closedTabs: { ...s.closedTabs, ws1: [entry("r1"), entry("r2")] as never } }));
    useApp.getState().resumeClosedTab("ws1", "e-r1");
    expect(ids("ws1")).toEqual(["a", "b", "x", "r1"]);
    expect("subgroup" in tabOf("r1")).toBe(false);
    useApp.getState().resumeClosedTab("ws1", "e-r2", { afterTabId: "a" });
    expect(ids("ws1")).toEqual(["a", "r2", "b", "x", "r1"]);
    expect(tabOf("r2").subgroup).toEqual(A);
  });

  it("closing the last member removes the subgroup", () => {
    seed({ id: "x" }, { id: "a", subgroup: A });
    useApp.getState().closeTab("ws1", "a");
    expect(getTabs("ws1").some(t => (t as TerminalTab).subgroup)).toBe(false);
  });
});

describe("newTabSubgroup", () => {
  it("founds one holding the tab, in a fresh colour, and starts its rename", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "c", subgroup: A });
    const id = useApp.getState().newTabSubgroup("ws1", "b");
    const sg = tabOf("b").subgroup!;
    expect(sg.id).toBe(id);
    expect(sg.color).toBe("teal"); // blue is A's
    expect(sg.name.length).toBeGreaterThan(0);
    // It stepped out of A's run, so A stays whole.
    expect(ids("ws1")).toEqual(["a", "c", "b"]);
    expect(useUI.getState().tabSubgroupRenaming).toEqual({ subgroupId: id, value: sg.name });
    // A new subgroup is open.
    expect(useApp.getState().collapsedTabSubgroups[id]).toBeFalsy();
  });
});

describe("contiguity on the other paths", () => {
  it("New below on a member creates the tab inside the same subgroup", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" });
    useApp.getState().addTab("ws1", makeTerminalTab({ id: "n" }), { afterTabId: "a" });
    expect(ids("ws1")).toEqual(["a", "n", "b", "x"]);
    expect(groupsOf("ws1")).toBe("AAA-");
    // ...and below the LAST member too.
    useApp.getState().addTab("ws1", makeTerminalTab({ id: "m" }), { afterTabId: "b" });
    expect(groupsOf("ws1")).toBe("AAAA-");
  });

  it("New below on a loose tab stays loose", () => {
    seed({ id: "x" }, { id: "a", subgroup: A });
    useApp.getState().addTab("ws1", makeTerminalTab({ id: "n" }), { afterTabId: "x" });
    expect(groupsOf("ws1")).toBe("--A");
  });

  it("pinning a member removes it from its subgroup", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A });
    useApp.getState().pinTab("ws1", "b");
    expect(ids("ws1")).toEqual(["b", "a"]);
    expect(groupsOf("ws1")).toBe("-A");
    expect(lastPersisted().find(p => p.id === "b")?.subgroup).toBeUndefined();
  });

  it("pinning drops the membership in the same write that sets the flag", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A });
    const seen: string[] = [];
    const unsub = useApp.subscribe(s => {
      const b = s.tabs.ws1?.find(t => t.id === "b") as TerminalTab | undefined;
      seen.push(`${b?.pinned ? "P" : "-"}${b?.subgroup ? "A" : "-"}`);
    });
    useApp.getState().pinTab("ws1", "b");
    unsub();
    // Never a loose-but-unpinned (or pinned member) intermediate state.
    expect(seen.every(x => x === "P-")).toBe(true);
  });

  it("moving a member into a split clears its subgroup, and it comes back loose", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "c", subgroup: A });
    useApp.getState().moveTabToSplit("ws1", "b", null, "right");
    expect(tabOf("b").paneId).toBeTruthy();
    expect("subgroup" in tabOf("b")).toBe(false);
    const pane = tabOf("b").paneId!;
    useApp.getState().moveTabToPane("ws1", "c", pane);
    expect("subgroup" in tabOf("c")).toBe(false);
    useApp.getState().moveTabToMain("ws1", "c");
    expect(tabOf("c").subgroup).toBeUndefined();
  });

  it("a tab coming back from a pane never splits a run", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "c", subgroup: A }, { id: "x" });
    // b keeps its array slot (between a and c) while it sits in the pane.
    useApp.getState().moveTabToSplit("ws1", "b", null, "right");
    useApp.getState().moveTabToMain("ws1", "b");
    const main = getTabs("ws1").filter(t => !(t as TerminalTab).paneId).map(t => t.id);
    expect(main).toEqual(["a", "c", "b", "x"]);
    expect(groupsOf("ws1")).toBe("AA--");
  });

  it("restore keeps each subgroup's run contiguous", () => {
    const persisted: PersistedTab[] = [
      { id: "a", cli: "claude", is_default: true, subgroup: A },
      { id: "x", cli: "codex" },
      { id: "b", cli: "claude", subgroup: A },
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    expect(ids("ws1")).toEqual(["a", "b", "x"]);
    expect(groupsOf("ws1")).toBe("AA-");
  });

  it("restore drops a stray subgroup on a pinned tab", () => {
    const persisted: PersistedTab[] = [
      { id: "p", cli: "claude", is_default: true, pinned: true, subgroup: A },
    ];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: persisted })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    expect("subgroup" in tabOf("p")).toBe(false);
  });
});

describe("persistence", () => {
  it("a disk-shaped record compares equal, so a sync writes nothing", () => {
    // Rust's serialization order (lib.rs PersistedTab) with every optional
    // field set: what loadAll hands the store, and what syncDurableTabs
    // compares the live list against.
    const disk = [{
      id: "a", cli: "claude", agent_args: ["--x"], title: null, custom_title: false,
      is_default: true, command: null, session_id: "s1", pane_leaf_id: null,
      run_member: null, pinned: false,
      scheduled: [{ id: "m1", text: "later", not_before: 9_999_999_999_999, created: 1 }],
      props: [{ key: "k", value: "v", since: 1 }],
      subgroup: { id: "A", name: "Alpha", color: "blue" },
    }] as PersistedTab[];
    useApp.setState({ tasks: [makeTask({ persisted_tabs: disk })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    vi.mocked(ipc.taskSetTabs).mockClear();
    useApp.getState().syncDurableTabs("ws1");
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
    expect(tabOf("a").subgroup).toEqual(A);
  });

  it("a subgroup-only change does reach disk", () => {
    seed({ id: "a", cli: "claude" });
    useApp.getState().syncDurableTabs("ws1");
    vi.mocked(ipc.taskSetTabs).mockClear();
    useApp.getState().setTabSubgroup("ws1", "a", A);
    expect(lastPersisted()[0].subgroup).toEqual(A);
  });

  it("a shell-only subgroup is not persisted (shells are not durable)", () => {
    seed({ id: "a", cli: "claude" }, { id: "s", cli: "shell" });
    useApp.getState().setTabSubgroup("ws1", "s", A);
    expect(lastPersisted()?.some(p => p.subgroup) ?? false).toBe(false);
  });

  it("fold state is pruned on loadAll to subgroups that still exist", async () => {
    useApp.setState({ collapsedTabSubgroups: { A: true, gone: true } });
    vi.mocked(ipc.tasksList).mockResolvedValueOnce([
      makeTask({ id: "ws1", persisted_tabs: [{ id: "a", cli: "claude", subgroup: A }] }),
    ]);
    await useApp.getState().loadAll();
    expect(useApp.getState().collapsedTabSubgroups).toEqual({ A: true });
  });

  it("fold state keeps a subgroup that lives only on live (shell) tabs", async () => {
    seed({ id: "s", cli: "shell", subgroup: B });
    useApp.setState({ collapsedTabSubgroups: { B: true } });
    vi.mocked(ipc.tasksList).mockResolvedValueOnce([makeTask({ id: "ws1" })]);
    await useApp.getState().loadAll();
    expect(useApp.getState().collapsedTabSubgroups).toEqual({ B: true });
  });
});

describe("drops", () => {
  it("the strip drop settles membership by position, never reorderTab itself", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" });
    useApp.getState().reorderTab("ws1", "x", 1);
    expect(groupsOf("ws1")).toBe("A-A");
    useApp.getState().settleStripTabSubgroup("ws1", "x");
    expect(groupsOf("ws1")).toBe("AAA");
  });

  it("a member dragged away from its run in the strip leaves", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" }, { id: "y" });
    useApp.getState().reorderTab("ws1", "a", 3);
    useApp.getState().settleStripTabSubgroup("ws1", "a");
    expect(ids("ws1")).toEqual(["b", "x", "y", "a"]);
    expect(groupsOf("ws1")).toBe("A---");
  });

  it("the sidebar drop commits membership and gathers the run in one tabs write", () => {
    seed({ id: "a", subgroup: A }, { id: "x" }, { id: "b", subgroup: A }, { id: "y" });
    const tabsWrites: number[] = [];
    let prev = useApp.getState().tabs;
    const unsub = useApp.subscribe(s => { if (s.tabs !== prev) { tabsWrites.push(1); prev = s.tabs; } });
    useApp.getState().dropTabInSubgroup("ws1", "x", null);
    unsub();
    expect(tabsWrites).toHaveLength(1);
    expect(ids("ws1")).toEqual(["a", "b", "x", "y"]);
    useApp.getState().dropTabInSubgroup("ws1", "y", A);
    expect(ids("ws1")).toEqual(["a", "b", "y", "x"]);
    expect(groupsOf("ws1")).toBe("AAA-");
  });

  it("the drop takes the subgroup's CURRENT copy, not the one from hover time", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" });
    // Renamed and recoloured while the row was in the air.
    useApp.getState().renameTabSubgroup("ws1", "A", "Renamed");
    useApp.getState().recolorTabSubgroup("ws1", "A", "red");
    useApp.getState().dropTabInSubgroup("ws1", "x", A);
    expect(tabOf("x").subgroup).toEqual({ id: "A", name: "Renamed", color: "red" });
    expect(tabOf("a").subgroup).toEqual({ id: "A", name: "Renamed", color: "red" });
  });

  it("a drop into a subgroup dissolved mid-drag stays loose and does not revive it", () => {
    seed({ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" });
    useApp.getState().dissolveTabSubgroup("ws1", "A");
    const before = useApp.getState();
    useApp.getState().dropTabInSubgroup("ws1", "x", A);
    expect(groupsOf("ws1")).toBe("---");
    expect(useApp.getState()).toBe(before);
  });

  it("a pinned row dropped in a block does not join", () => {
    seed({ id: "p", pinned: true }, { id: "a", subgroup: A });
    const before = useApp.getState();
    useApp.getState().dropTabInSubgroup("ws1", "p", A);
    expect(useApp.getState()).toBe(before);
  });
});
