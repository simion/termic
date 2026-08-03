// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mock set app.test.ts uses — the store pulls IPC in at import time.
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
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
import { dirHistoryTarget, dirTabTitle, goDirHistory, navigateDirTab, openDirTab } from "@/lib/dirTabs";
import type { Tab } from "@/lib/types";

const TASK = "ws1";
const seed = (tabs: Tab[], activeId?: string) =>
  useApp.setState({
    tasks: [{ id: TASK, path: "/repos/termic" }] as any,
    tabs: { [TASK]: tabs },
    activeTab: { [TASK]: activeId ?? tabs[0]?.id },
    splitTree: {},
    activePaneId: {},
    // Cleared per case: revealFile is what these tests assert on, and it
    // persists in the store until the tree consumes it.
    revealFile: null,
  } as any);

beforeEach(() => seed([]));

describe("dirTabTitle", () => {
  it("uses the folder basename", () => {
    expect(dirTabTitle("docs/plans", "/repos/termic")).toBe("plans");
  });

  it("falls back to the task root's own name for the root", () => {
    expect(dirTabTitle("", "/repos/termic")).toBe("termic");
  });
});

describe("openDirTab", () => {
  it("recycles the preview tab and reveals the folder in the tree", () => {
    seed([{ id: "p1", type: "edit", title: "guide.md", path: "docs/guide.md", preview: true } as any]);

    openDirTab(TASK, "docs/plans");

    const tabs = useApp.getState().tabs[TASK];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: "p1", type: "dir", path: "docs/plans", title: "plans" });
    expect(useApp.getState().revealFile).toMatchObject({ path: "docs/plans", isDir: true });
  });

  it("does not try to reveal the task root, which the tree cannot key on", () => {
    openDirTab(TASK, "");
    expect(useApp.getState().revealFile).toBeNull();
    expect((useApp.getState().tabs[TASK][0] as any).path).toBe("");
  });
});

describe("navigateDirTab", () => {
  it("moves a PINNED listing in place instead of opening another tab", () => {
    // Regression: a pinned dir tab is not the preview slot, so routing this
    // through openDirTab would leave it showing the old folder while the new
    // one landed somewhere else entirely.
    seed([{ id: "d1", type: "dir", title: "docs", path: "docs", preview: false } as any]);

    navigateDirTab(TASK, "d1", "docs/plans");

    const tabs = useApp.getState().tabs[TASK];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: "d1", path: "docs/plans", title: "plans", preview: false });
  });

  it("keeps the preview flag on an unpinned listing", () => {
    seed([{ id: "d1", type: "dir", title: "docs", path: "docs", preview: true } as any]);

    navigateDirTab(TASK, "d1", "docs/plans");

    expect(useApp.getState().tabs[TASK][0].preview).toBe(true);
  });

  it("keeps a manually renamed tab's label", () => {
    seed([{ id: "d1", type: "dir", title: "my folder", path: "docs", preview: false, customTitle: true } as any]);

    navigateDirTab(TASK, "d1", "docs/plans");

    const tab = useApp.getState().tabs[TASK][0] as any;
    expect(tab.path).toBe("docs/plans");
    expect(tab.title).toBe("my folder");
  });

  it("reveals the folder in the tree, and never the task root", () => {
    seed([{ id: "d1", type: "dir", title: "plans", path: "docs/plans", preview: true } as any]);

    navigateDirTab(TASK, "d1", "docs");
    expect(useApp.getState().revealFile).toMatchObject({ path: "docs", isDir: true });

    useApp.setState({ revealFile: null } as any);
    navigateDirTab(TASK, "d1", "");
    expect(useApp.getState().revealFile).toBeNull();
    expect((useApp.getState().tabs[TASK][0] as any).title).toBe("termic");
  });
});

describe("folder history (⌘[ / ⌘])", () => {
  const dirTab = (over: Record<string, unknown> = {}) =>
    ({ id: "d1", type: "dir", title: "docs", path: "docs", preview: true,
       dirHistory: ["docs"], dirHistoryIndex: 0, ...over } as any);
  const state = () => useApp.getState().tabs[TASK][0] as any;

  it("records each folder navigated to", () => {
    seed([dirTab()]);

    navigateDirTab(TASK, "d1", "docs/plans");
    navigateDirTab(TASK, "d1", "docs/plans/2026");

    expect(state().dirHistory).toEqual(["docs", "docs/plans", "docs/plans/2026"]);
    expect(state().dirHistoryIndex).toBe(2);
  });

  it("walks back and forward without touching the trail", () => {
    seed([dirTab({ dirHistory: ["docs", "docs/plans"], dirHistoryIndex: 1, path: "docs/plans" })]);

    expect(goDirHistory(TASK, "d1", -1)).toBe(true);
    expect(state().path).toBe("docs");
    expect(state().title).toBe("docs");

    expect(goDirHistory(TASK, "d1", 1)).toBe(true);
    expect(state().path).toBe("docs/plans");
    expect(state().dirHistory).toEqual(["docs", "docs/plans"]);
  });

  it("declines at either end so the key falls through to task switching", () => {
    seed([dirTab({ dirHistory: ["docs"], dirHistoryIndex: 0 })]);

    expect(goDirHistory(TASK, "d1", -1)).toBe(false);
    expect(goDirHistory(TASK, "d1", 1)).toBe(false);
    // Declining must be a true no-op, not a silent patch.
    expect(state().path).toBe("docs");
    expect(state().dirHistoryIndex).toBe(0);
  });

  it("declines on a tab that is not a listing", () => {
    seed([{ id: "e1", type: "edit", title: "guide.md", path: "docs/guide.md" } as any]);
    expect(goDirHistory(TASK, "e1", -1)).toBe(false);
  });

  it("truncates the forward trail when navigating after a back", () => {
    // Browser semantics: go back, then somewhere new, and the abandoned
    // branch must not stay reachable with forward.
    seed([dirTab({ dirHistory: ["docs", "docs/plans"], dirHistoryIndex: 1, path: "docs/plans" })]);

    goDirHistory(TASK, "d1", -1);
    navigateDirTab(TASK, "d1", "src");

    expect(state().dirHistory).toEqual(["docs", "src"]);
    expect(state().dirHistoryIndex).toBe(1);
    expect(goDirHistory(TASK, "d1", 1)).toBe(false);
  });

  it("clears the per-document remote-image approval on every folder move", () => {
    // Regression (issue #69 crossed with #151): the approval is per DOCUMENT.
    // Moving folders swaps which README renders, so carrying the flag would
    // silently unblock remote images in a README the user never approved.
    seed([dirTab({ remoteImagesUnblocked: true })]);
    navigateDirTab(TASK, "d1", "docs/plans");
    expect(state().remoteImagesUnblocked).toBeUndefined();

    // ...and the same on a history walk, which also swaps the document.
    useApp.getState().patchTab(TASK, "d1", { remoteImagesUnblocked: true } as any);
    expect(goDirHistory(TASK, "d1", -1)).toBe(true);
    expect(state().remoteImagesUnblocked).toBeUndefined();
  });

  it("starts a fresh trail when the preview slot recycles to another folder", () => {
    // Regression: ⌘[ must never walk back into whatever this tab held
    // before, which is a different document entirely.
    seed([dirTab({ dirHistory: ["docs", "docs/plans"], dirHistoryIndex: 1, path: "docs/plans" })]);

    openDirTab(TASK, "src");

    expect(state().dirHistory).toEqual(["src"]);
    expect(state().dirHistoryIndex).toBe(0);
    expect(goDirHistory(TASK, "d1", -1)).toBe(false);
  });
});

describe("dirHistoryTarget (who may claim ⌘[ / ⌘])", () => {
  const FOCUS = { inBottom: false, splitPaneId: null, inMainPane: false, noFocus: false };
  // Main leaf + one extra pane, the shape a "split right" produces.
  const tree: any = {
    type: "split", id: "s1", dir: "v", ratio: 0.5,
    a: { type: "pane", id: "main", isMain: true, tabIds: ["mainTab"], activeTabId: "mainTab" },
    b: { type: "pane", id: "paneA", isMain: false, tabIds: ["paneTab"], activeTabId: "paneTab" },
  };
  const st = (over: any = {}) => ({
    tabs: { [TASK]: [
      { id: "mainTab", type: "dir", path: "docs", title: "docs" },
      { id: "paneTab", type: "dir", path: "src", title: "src" },
      { id: "editTab", type: "edit", path: "docs/guide.md", title: "guide.md" },
    ] as any },
    splitTree: { [TASK]: tree },
    activePaneId: { [TASK]: "paneA" },
    activeTab: { [TASK]: "mainTab" },
    ...over,
  });

  it("declines outright when focus is in the bottom drawer", () => {
    expect(dirHistoryTarget(st(), TASK, { ...FOCUS, inBottom: true })).toBeUndefined();
    // Even if every other signal says a listing is right there.
    expect(dirHistoryTarget(st(), TASK, {
      ...FOCUS, inBottom: true, inMainPane: true, noFocus: true, splitPaneId: "paneA",
    })).toBeUndefined();
  });

  it("declines when focus is in the sidebar, right panel, or a dialog", () => {
    // None of the three location flags set = focus is somewhere that owns
    // the keyboard itself.
    expect(dirHistoryTarget(st(), TASK, FOCUS)).toBeUndefined();
  });

  it("uses the focused SPLIT pane's tab, not the main pane's", () => {
    expect(dirHistoryTarget(st(), TASK, { ...FOCUS, splitPaneId: "paneA" })).toBe("paneTab");
  });

  it("uses the MAIN pane's tab when focus is there, even with a stale activePaneId", () => {
    // Regression: the main tab strip never updates activePaneId, so it can
    // still name a split pane while the user is provably typing in main.
    // DOM focus must win, or the background pane's listing walks instead.
    expect(dirHistoryTarget(st(), TASK, { ...FOCUS, inMainPane: true })).toBe("mainTab");
  });

  it("falls back to activePaneId only when nothing holds focus", () => {
    expect(dirHistoryTarget(st(), TASK, { ...FOCUS, noFocus: true })).toBe("paneTab");
    // ...and to the main tab when activePaneId names the main leaf.
    expect(dirHistoryTarget(st({ activePaneId: { [TASK]: "main" } }), TASK,
      { ...FOCUS, noFocus: true })).toBe("mainTab");
    // ...or when there is no split at all.
    expect(dirHistoryTarget(st({ splitTree: {} }), TASK,
      { ...FOCUS, noFocus: true })).toBe("mainTab");
  });

  it("declines when the resolved tab is not a listing", () => {
    expect(dirHistoryTarget(st({ activeTab: { [TASK]: "editTab" } }), TASK,
      { ...FOCUS, inMainPane: true })).toBeUndefined();
  });

  it("survives a dead pane id, a missing leaf, and an empty pane", () => {
    // activePaneId pointing at a closed pane must not throw or resolve.
    expect(dirHistoryTarget(st({ activePaneId: { [TASK]: "ghost" } }), TASK,
      { ...FOCUS, noFocus: true })).toBe("mainTab");
    expect(dirHistoryTarget(st(), TASK, { ...FOCUS, splitPaneId: "ghost" })).toBeUndefined();
    const emptyPane: any = { ...tree, b: { ...tree.b, activeTabId: null } };
    expect(dirHistoryTarget(st({ splitTree: { [TASK]: emptyPane } }), TASK,
      { ...FOCUS, splitPaneId: "paneA" })).toBeUndefined();
  });

  it("declines for an unknown task", () => {
    expect(dirHistoryTarget(st(), "nope", { ...FOCUS, inMainPane: true })).toBeUndefined();
  });
});

describe("the right panel is not resurrected by a history walk", () => {
  const dirTab = (over: Record<string, unknown> = {}) =>
    ({ id: "d1", type: "dir", title: "docs", path: "docs", preview: true,
       dirHistory: ["docs", "docs/plans"], dirHistoryIndex: 1, path_: undefined, ...over } as any);

  it("keeps a deliberately closed panel closed on Cmd+[", () => {
    // Clicks mean "take me there" and may open the panel; a keystroke must
    // not resurrect a panel the user closed, nor pay the reveal's one IPC
    // per ancestor on a key that repeats.
    seed([dirTab({ path: "docs/plans" })]);
    useApp.setState({ rightPanelHidden: true } as any);

    expect(goDirHistory(TASK, "d1", -1)).toBe(true);

    expect(useApp.getState().rightPanelHidden).toBe(true);
    expect(useApp.getState().revealFile).toBeNull();
    expect((useApp.getState().tabs[TASK][0] as any).path).toBe("docs"); // still navigated
  });

  it("still tracks the tree when the panel is already open", () => {
    seed([dirTab({ path: "docs/plans" })]);
    useApp.setState({ rightPanelHidden: false } as any);

    expect(goDirHistory(TASK, "d1", -1)).toBe(true);
    expect(useApp.getState().revealFile).toMatchObject({ path: "docs", isDir: true });
  });

  it("a CLICK still opens a closed panel, as it always has", () => {
    seed([dirTab()]);
    useApp.setState({ rightPanelHidden: true } as any);

    navigateDirTab(TASK, "d1", "docs/plans");

    expect(useApp.getState().rightPanelHidden).toBe(false);
    expect(useApp.getState().revealFile).toMatchObject({ path: "docs/plans", isDir: true });
  });
});
