// The top of the sidebar (docs/ui.md "The sidebar's filter bar", "The
// sidebar's status chips", "One glyph per meaning"): the board's filter bar
// and query language over the project tree, the status chips that write
// `status:` into it, and the row rules that give each mark one meaning.
// Covers where the bar sits, what it hides and keeps, the shared funnel menu,
// the folds it opens without writing, that its query is its own and not the
// board's, the chips, the location and slot rules, and the icon rail.
//
// Relative assertions only: earlier spec files leave tasks in the shared
// profile, so a case asserts on this file's tasks being in or out, never on
// a total.

import {
  archiveTask,
  clickByText,
  clickWhenVisible,
  createWorktreeTask,
  dismissOverlays,
  ensureActiveTask,
  openTask,
  requireTermicApi,
  waitForAgentReady,
  setInputValue,
  snap,
  waitForAppShell,
  waitGone,
  waitVisible,
} from "../helpers.js";

const BAR = '[data-testid="sidebar-filter"]';
const INPUT = '[data-testid="sidebar-filter-input"]';
const TREE_ROW = (id: string) => `[data-sidebar-task-id="${id}"]`;

const query = () => browser.execute(() => window.__termic!.useUI.getState().sidebarQuery) as Promise<string>;
const setQuery = (q: string) => browser.execute(v => window.__termic!.useUI.getState().setSidebarQuery(v), q);
const present = (sel: string) => browser.execute(s => !!document.querySelector(s), sel);
const fixtureId = () => browser.execute(() =>
  window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id) as Promise<string>;

/** Which of `ids` the project tree renders right now. */
const treeShows = (ids: string[]) =>
  browser.execute(list => list.filter(id => !!document.querySelector(`[data-sidebar-task-id="${id}"]`)), ids);

async function waitTree(ids: string[], want: (shown: string[]) => boolean, msg: string): Promise<void> {
  await browser.waitUntil(async () => want(await treeShows(ids)), { timeout: 5_000, timeoutMsg: msg });
}

describe("sidebar filter bar", () => {
  let a = "";
  let b = "";
  let c = "";
  let wt = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => {
      const t = window.__termic!;
      if (t.useApp.getState().compactSidebar) t.useApp.getState().toggleCompactSidebar();
    });
    a = await openTask("sfilter-alpha", true, "fakeagent");
    b = await openTask("sfilter-bravo", false, "fakeagent");
    c = await openTask("sfilter-charlie", false, "fakecapture");
  });

  after(async () => {
    await setQuery("");
    await browser.execute(() => {
      const t = window.__termic!;
      t.usePrefs.getState().setShowStatusSection(false);
      if (t.useApp.getState().compactSidebar) t.useApp.getState().toggleCompactSidebar();
    });
    for (const id of [a, b, c, wt]) if (id) await archiveTask(id);
  });

  it("sits at the top of the sidebar, under the nav strip and above the tree", async () => {
    await waitVisible(INPUT);
    // DOCUMENT_POSITION_FOLLOWING (4): the tree comes after the bar, the nav
    // before it.
    const order = await browser.execute(bar => {
      const el = document.querySelector(bar)!;
      return {
        tree: el.compareDocumentPosition(document.querySelector("[data-sidebar-task-id]")!) & 4,
        nav: el.compareDocumentPosition(document.querySelector("nav")!) & 2,
      };
    }, BAR);
    expect(order.tree).toBe(4);
    expect(order.nav).toBe(2);
    // The board's funnel glyph, in the same place inside the input.
    await waitVisible('[data-testid="sidebar-filter-menu-trigger"]');
    // The nav is one row of icons: its entries share a line, and keep their
    // names for screen readers (and for clickByText).
    const nav = await browser.execute(() => {
      const btns = [...document.querySelectorAll<HTMLElement>("nav button")];
      return { tops: [...new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)))].length, names: btns.map(b => b.getAttribute("aria-label")) };
    });
    expect(nav.tops).toBe(1);
    expect(nav.names).toContain("Kanban");
    await snap("sidebar-filter-idle.png");
  });

  it("free text narrows the tree, keeps the open task, and the count says so", async () => {
    await setInputValue(INPUT, "sfilter-bravo");
    await waitTree([a, b, c], s => s.includes(b) && !s.includes(c), "free text did not narrow the tree");
    // `a` is the open task: it stays listed even though it does not match.
    expect(await treeShows([a])).toEqual([a]);
    await waitVisible('[data-testid="sidebar-filter-count"]');
    await snap("sidebar-filter-text.png");
  });

  it("sits above STATUS too, and filters it by the same query", async () => {
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(true));
    await waitVisible('[data-testid="status-section"]');
    // DOCUMENT_POSITION_FOLLOWING (4): the section comes after the bar, so
    // the bar scopes it from above, as it does the tree.
    const below = await browser.execute(bar =>
      document.querySelector(bar)!.compareDocumentPosition(document.querySelector('[data-testid="status-section"]')!) & 4, BAR);
    expect(below).toBe(4);
    // b and c were never opened, so both sit in Not started.
    const notStarted = () => browser.execute(() =>
      document.querySelector('[data-status-bucket="backlog"] [data-testid="status-bucket-count"]')?.textContent ?? null);
    await setQuery("sfilter-bravo");
    await browser.waitUntil(async () => (await notStarted()) === "1",
      { timeout: 5_000, timeoutMsg: "STATUS did not narrow to the one matching task" });
    await setQuery("sfilter-nothing-matches-this");
    await browser.waitUntil(async () => (await notStarted()) === null,
      { timeout: 5_000, timeoutMsg: "an emptied bucket still showed" });
    await setQuery("");
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(false));
  });

  it("marks location on the exception: the main checkout has a glyph, a worktree none", async () => {
    // openTask opens the repo root, so a, b and c are main checkouts.
    wt = await createWorktreeTask("sfilter-worktree", "sfilter-worktree", false);
    await waitVisible(TREE_ROW(wt));
    const glyphs = await browser.execute((main, worktree) => ({
      main: !!document.querySelector(`[data-sidebar-task-row="${main}"] [aria-label="main checkout"]`),
      worktree: document.querySelector(`[data-sidebar-task-row="${worktree}"]`)!
        .querySelectorAll('[aria-label="main checkout"], [aria-label="worktree"]').length,
    }), b, wt);
    expect(glyphs).toEqual({ main: true, worktree: 0 });
  });

  it("gives the row's trailing slots one meaning each: the menu is hover-only and never holds state", async () => {
    // The state slot is always there and rightmost; the menu trigger sits in
    // its own slot, hidden at rest, and holds no badge.
    const anatomy = await browser.execute(id => {
      const row = document.querySelector(`[data-sidebar-task-row="${id}"]`)!;
      const state = row.querySelector('[data-testid="task-state-slot"]') as HTMLElement | null;
      const menu = row.querySelector('[data-testid="task-menu-trigger"]') as HTMLElement | null;
      // The wrapper also holds expanded tab rows; the slots live in its header.
      return {
        stateIsLast: !!state && state.parentElement!.lastElementChild === state,
        menuOpacity: menu ? getComputedStyle(menu).opacity : null,
        badgeInMenu: !!menu?.querySelector('[data-testid="work-badge"], [data-testid="task-yolo-badge"]'),
      };
    }, b);
    expect(anatomy).toEqual({ stateIsLast: true, menuOpacity: "0", badgeInMenu: false });
  });

  it("a project with no matches hides, and the empty state clears the query", async () => {
    await setQuery("project:no-such-project");
    const pid = await fixtureId();
    await browser.waitUntil(async () => !(await present(`[data-project-id="${pid}"]`)),
      { timeout: 5_000, timeoutMsg: "an unmatched project still showed its header" });
    await clickWhenVisible('[data-testid="sidebar-filter-empty"] button');
    await browser.waitUntil(async () => (await query()) === "", { timeout: 5_000, timeoutMsg: "the empty state's clear did not clear" });
    await waitVisible(`[data-project-id="${pid}"]`);
  });

  it("opens a folded project while filtering without touching its stored fold", async () => {
    const pid = await fixtureId();
    await browser.execute(id => window.__termic!.useApp.getState().setProjectCollapsed(id, true), pid);
    await waitGone(TREE_ROW(b));
    await setQuery("sfilter-bravo");
    await waitVisible(TREE_ROW(b));
    const stored = () => browser.execute(id => window.__termic!.useApp.getState().collapsedProjects[id], pid);
    expect(await stored()).toBe(true);
    await setQuery("");
    await waitGone(TREE_ROW(b));
    expect(await stored()).toBe(true);
    await browser.execute(id => window.__termic!.useApp.getState().setProjectCollapsed(id, false), pid);
    await waitVisible(TREE_ROW(b));
  });

  it("the funnel opens the board's menu, and its chips write this bar's query", async () => {
    await clickWhenVisible('[data-testid="sidebar-filter-menu-trigger"]');
    await waitVisible('[data-testid="sidebar-filter-menu"]');
    // The sidebar lists no archived tasks, so it offers no Archived chip.
    expect(await present('[data-board-filter-chip="status:archived"]')).toBe(false);
    const CHIP = '[data-board-filter-chip="agent:fakecapture"]';
    await clickWhenVisible(CHIP);
    await browser.waitUntil(async () => (await query()) === "agent:fakecapture", { timeout: 5_000, timeoutMsg: "chip did not include" });
    await waitTree([b, c], s => s.includes(c) && !s.includes(b), "including the agent did not narrow the tree");
    await snap("sidebar-filter-menu.png");
    await clickWhenVisible(CHIP);
    await browser.waitUntil(async () => (await query()) === "-agent:fakecapture", { timeout: 5_000, timeoutMsg: "chip did not exclude" });
    await waitTree([b, c], s => s.includes(b) && !s.includes(c), "excluding the agent did not narrow the tree");
    await browser.keys(["Escape"]);
    await waitGone('[data-testid="sidebar-filter-menu"]');
  });

  it("Esc in the bar clears the query", async () => {
    await setInputValue(INPUT, "sfilter-charlie");
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => (await query()) === "", { timeout: 5_000, timeoutMsg: "Esc did not clear" });
    await waitTree([a, b, c], s => s.length === 3, "clearing did not restore the tree");
  });

  it("a status chip counts what needs you, and filters the tree to it", async () => {
    // A task has tabs only once something mounts it; visit it, let the fake
    // agent settle, then step away so the seed lands on a task the user is
    // not looking at.
    await ensureActiveTask(a);
    await waitForAgentReady(a);
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));
    // SETUP, not the assertion: the tab state the detector would write.
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.markAttention(id, tab.id, "attention", "needs you");
    }, a);
    const CHIP = '[data-status-chip="attention"]';
    await waitVisible(CHIP);
    // The tree's own bell sits in the row's state slot.
    await waitVisible(`[data-sidebar-task-row="${a}"] [data-testid="task-state-slot"] [data-work-state="attention"]`);
    const count = Number(await browser.execute(sel =>
      document.querySelector(`${sel} [data-testid="status-chip-count"]`)?.textContent ?? "0", CHIP));
    expect(count).toBeGreaterThanOrEqual(1);
    await snap("sidebar-status-chips.png");

    await clickWhenVisible(CHIP);
    await browser.waitUntil(async () => (await query()) === "status:attention", { timeout: 5_000, timeoutMsg: "the chip did not write status:attention" });
    expect(await browser.execute(sel => document.querySelector(sel)?.getAttribute("aria-pressed"), CHIP)).toBe("true");
    // b and c were never opened, so they are not waiting on anyone.
    await waitTree([a, b, c], s => s.includes(a) && !s.includes(b) && !s.includes(c), "the chip did not narrow the tree");
    // The count is what clicking left: every attention task, and only those.
    const rows = await browser.execute(() => document.querySelectorAll("[data-sidebar-task-row]").length);
    expect(rows).toBe(count);

    await clickWhenVisible(CHIP);
    await browser.waitUntil(async () => (await query()) === "", { timeout: 5_000, timeoutMsg: "a second click did not take the clause back out" });
  });

  it("keeps its own query: the board is not filtered by it", async () => {
    await setQuery("sfilter-bravo");
    await clickByText("Kanban");
    await waitVisible('[data-testid="board-filter-input"]');
    const boardValue = await browser.execute(() =>
      (document.querySelector('[data-testid="board-filter-input"]') as HTMLInputElement).value);
    expect(boardValue).toBe("");
    await waitVisible(`[data-board-task-id="${c}"]`);
    // Both bars are mounted now; the tree is still filtered by its own.
    await waitTree([b, c], s => s.includes(b) && !s.includes(c), "the board's view changed the sidebar's filter");
    await setQuery("");
  });

  it("is absent on the icon rail, and a query typed before filters nothing there", async () => {
    await setQuery("sfilter-bravo");
    await browser.execute(() => window.__termic!.useApp.getState().toggleCompactSidebar());
    await waitGone(BAR);
    const pid = await fixtureId();
    await waitVisible(`[data-project-id="${pid}"]`);
    await browser.execute(() => window.__termic!.useApp.getState().toggleCompactSidebar());
    await waitVisible(INPUT);
    await setQuery("");
  });

  it("the command palette focuses the bar from the icon rail, and clears it", async () => {
    const PALETTE = 'input[placeholder*="Type a command"]';
    /** Open the palette, type `q`, click the row whose text is `label`. */
    const runCommand = async (q: string, label: string) => {
      await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
      await waitVisible(PALETTE, 8_000);
      await setInputValue(PALETTE, q);
      await browser.waitUntil(() => browser.execute(l =>
        [...document.querySelectorAll<HTMLElement>("[data-row]")].some(r => r.textContent?.includes(l)), label),
      { timeout: 5_000, timeoutMsg: `no palette row "${label}"` });
      await browser.execute(l =>
        [...document.querySelectorAll<HTMLElement>("[data-row]")].find(r => r.textContent?.includes(l))!.click(), label);
      await waitGone(PALETTE);
    };
    const rowShown = async (q: string, label: string) => {
      await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
      await waitVisible(PALETTE, 8_000);
      await setInputValue(PALETTE, q);
      const shown = await browser.execute(l =>
        [...document.querySelectorAll<HTMLElement>("[data-row]")].some(r => r.textContent?.includes(l)), label);
      await browser.keys(["Escape"]);
      await waitGone(PALETTE);
      return shown;
    };

    // No query, no Clear row.
    expect(await rowShown("sidebar filter", "Clear sidebar filter")).toBe(false);

    await browser.execute(() => window.__termic!.useApp.getState().toggleCompactSidebar());
    await waitGone(BAR);
    await runCommand("filter sidebar", "Filter sidebar tasks");
    await waitVisible(INPUT);
    await browser.waitUntil(() => browser.execute(sel => document.activeElement === document.querySelector(sel), INPUT),
      { timeout: 5_000, timeoutMsg: "the palette did not put focus in the bar" });
    expect(await browser.execute(() => window.__termic!.useApp.getState().compactSidebar)).toBe(false);

    await setQuery("sfilter-bravo");
    await runCommand("clear sidebar", "Clear sidebar filter");
    await browser.waitUntil(async () => (await query()) === "", { timeout: 5_000, timeoutMsg: "Clear sidebar filter did not clear" });
  });
});
