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
  clickMenuItemUntilReady,
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

/** A plain click on a project header: its fold toggles on pointerup over
 *  the same header (the header is also a drag handle, so it has no onClick). */
const clickProjectHeader = (pid: string) => browser.execute(id => {
  const el = document.querySelector(`[data-project-id="${id}"] span.truncate`) as HTMLElement;
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: r.left + 4, clientY: r.top + 4 };
  el.dispatchEvent(new PointerEvent("pointerdown", init));
  el.dispatchEvent(new PointerEvent("pointerup", init));
}, pid);
const storedFold = (pid: string) => browser.execute(id => window.__termic!.useApp.getState().collapsedProjects[id] ?? null, pid);
const queryFolds = () => browser.execute(() => ({ ...window.__termic!.useUI.getState().sidebarQueryFolds })) as Promise<Record<string, boolean>>;

const activeTaskId = () => browser.execute(() => window.__termic!.useApp.getState().activeTaskId) as Promise<string | null>;
/** Put back the task that was open before a case changed it: later cases
 *  assume it, since the tree always keeps the open task listed. */
async function restoreActive(id: string | null): Promise<void> {
  if (id) await ensureActiveTask(id);
  else await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
}

async function waitTree(ids: string[], want: (shown: string[]) => boolean, msg: string): Promise<void> {
  await browser.waitUntil(async () => want(await treeShows(ids)), { timeout: 5_000, timeoutMsg: msg });
}

/** Seatbelt, and so the Seatbelt sandbox modes, exist on macOS only. */
const SEATBELT = process.platform === "darwin";

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

  it("location glyphs: both by default, and the list options submenu narrows them", async () => {
    // openTask opens the repo root, so a, b and c are main checkouts.
    wt = await createWorktreeTask("sfilter-worktree", "sfilter-worktree", false);
    await waitVisible(TREE_ROW(wt));
    // data-location, not the aria-label: the label names the branch too.
    const glyphs = () => browser.execute((main, worktree) => {
      const has = (id: string, location: string) =>
        !!document.querySelector(`[data-sidebar-task-row="${id}"] [data-testid="task-location-icon"][data-location="${location}"]`);
      return { main: has(main, "main"), worktree: has(worktree, "worktree") };
    }, b, wt);
    const setMode = (m: string) => browser.execute(v => window.__termic!.usePrefs.getState().setTaskLocationIcon(v as any), m);
    try {
      expect(await glyphs()).toEqual({ main: true, worktree: true });
      for (const [mode, want] of [
        ["worktree", { main: false, worktree: true }],
        ["none", { main: false, worktree: false }],
        ["both", { main: true, worktree: true }],
      ] as const) {
        await setMode(mode);
        await browser.waitUntil(async () => { const g = await glyphs(); return g.main === want.main && g.worktree === want.worktree; },
          { timeout: 5_000, timeoutMsg: `${mode}: glyphs were ${JSON.stringify(await glyphs())}` });
      }
      // the menu alias writes the same pref
      await waitVisible('[data-testid="sidebar-list-options"]');
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="sidebar-list-options"]') as HTMLElement;
        const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
      });
      await waitVisible('[data-testid="sidebar-task-git-icon"]');
      await clickMenuItemUntilReady("Git icon", () => present('[role="menuitem"][data-value="main"]') as Promise<boolean>);
      await snap("sidebar-task-git-icon-menu.png");
      await clickWhenVisible('[role="menuitem"][data-value="main"]');
      await browser.waitUntil(async () => { const g = await glyphs(); return g.main && !g.worktree; },
        { timeout: 5_000, timeoutMsg: "the submenu's Main checkout only did not hide the worktree glyph" });
    } finally {
      await setMode("both");
      await dismissOverlays();
    }
  });

  it("PR mark: the number alone by default, and the list options submenu picks the icon, both or none", async () => {
    // The store is the seam on purpose: a real PR would need a forge. What is
    // under test is the row, not the lookup.
    const setPr = (on: boolean) => browser.execute((id, on) => {
      window.__termic!.useApp.setState((s: any) => ({
        tasks: s.tasks.map((w: any) => w.id === id
          ? { ...w, pr_url: on ? "https://github.com/acme/repo/pull/42" : null, pr_number: on ? 42 : null, pr_provider: on ? "github" : null }
          : w),
      }));
    }, b, on);
    const BADGE = `${TREE_ROW(b)} [data-testid="task-pr-badge"]`;
    // null: no badge at all. Otherwise what it draws.
    const badge = () => browser.execute(sel => {
      const el = document.querySelector(sel);
      // The PR glyph, not the approval tick, which is an svg in the same button.
      return el ? { text: el.textContent?.trim() ?? "", icon: !!el.querySelector('svg:not([data-testid="task-pr-approved"])') } : null;
    }, BADGE);
    const setMode = (m: string) => browser.execute(v => window.__termic!.usePrefs.getState().setTaskPrBadge(v as any), m);
    const waitBadge = async (want: { text: string; icon: boolean } | null, why: string) => {
      // Field by field: WebView2's driver hands the object back with its keys
      // in another order, so comparing the JSON text failed on Windows alone.
      const same = (got: { text: string; icon: boolean } | null) =>
        got === null || want === null ? got === want : got.text === want.text && got.icon === want.icon;
      await browser.waitUntil(async () => same(await badge()),
        { timeout: 5_000, timeoutMsg: `${why}: badge was ${JSON.stringify(await badge())}` });
    };
    try {
      await setPr(true);
      await waitVisible(BADGE);
      // Set, not assumed: the pref persists in the e2e profile, so what a
      // run starts on is whatever the last one stored. The default itself is
      // pinned in prefs.test.ts, where each case gets a clean store.
      await setMode("number");
      await waitBadge({ text: "#42", icon: false }, "number");
      await snap("sidebar-task-pr-number.png");

      for (const [mode, want] of [
        ["icon", { text: "", icon: true }],
        ["both", { text: "#42", icon: true }],
        ["none", null],
        ["number", { text: "#42", icon: false }],
      ] as const) {
        await setMode(mode);
        await waitBadge(want, mode);
      }

      // the menu alias writes the same pref
      await waitVisible('[data-testid="sidebar-list-options"]');
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="sidebar-list-options"]') as HTMLElement;
        const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
      });
      await waitVisible('[data-testid="sidebar-task-pr-badge"]');
      await clickMenuItemUntilReady("PR badge", () => present('[role="menuitem"][data-pr-value="both"]') as Promise<boolean>);
      await snap("sidebar-task-pr-menu.png");
      await clickWhenVisible('[role="menuitem"][data-pr-value="both"]');
      await waitBadge({ text: "#42", icon: true }, "the submenu's Icon and number");
      await dismissOverlays();
      await snap("sidebar-task-pr-both.png");
      // The key is profile-scoped, so match it whatever the prefix is here.
      expect(await browser.execute(() => {
        const hit = Object.keys(localStorage).find(x => x === "taskPrBadge" || x.endsWith(":taskPrBadge"));
        return hit ? localStorage.getItem(hit) : null;
      })).toBe("both");

      // A PR whose number is not known yet keeps its glyph under "number":
      // dropping both would drop the link.
      await setMode("number");
      await waitBadge({ text: "#42", icon: false }, "back to number");
      await browser.execute(id => {
        window.__termic!.useApp.setState((s: any) => ({
          tasks: s.tasks.map((w: any) => w.id === id ? { ...w, pr_number: null } : w),
        }));
      }, b);
      await waitBadge({ text: "", icon: true }, "number mode with no number");

      // a task with no PR draws nothing in any mode
      await setMode("both");
      await setPr(false);
      await waitBadge(null, "no PR");
    } finally {
      await setPr(false);
      await setMode("number");
      await dismissOverlays();
    }
  });

  it("PR status: the last one known colours the mark before any poll, and an approved PR is ticked", async () => {
    // The stores are the seam on purpose: a real PR needs a forge, and an
    // approval needs a second account. What is under test is what the row
    // draws from a status, remembered or live.
    const BADGE = `${TREE_ROW(b)} [data-testid="task-pr-badge"]`;
    const TICK = `${BADGE} [data-testid="task-pr-approved"]`;
    const setPr = (on: boolean) => browser.execute((id, on) => {
      window.__termic!.useApp.setState((s: any) => ({
        tasks: s.tasks.map((w: any) => w.id === id
          ? { ...w, pr_url: on ? "https://github.com/acme/repo/pull/42" : null, pr_number: on ? 42 : null, pr_provider: on ? "github" : null }
          : w),
      }));
    }, b, on);
    /** `live: null` leaves no lookup, which is a launch before its first poll.
     *  `fetchedAt` is now either way, so the background pass leaves it alone. */
    const seed = (remembered: any, live: any) => browser.execute((id, remembered, live) => {
      const pr = (p: any) => ({ provider: "github", number: 42, url: "https://github.com/acme/repo/pull/42", title: "t", base: "main", head: "h", ...p });
      window.__termic!.usePr.setState((s: any) => {
        const key = String(id);
        const rest = { ...s.snapshots }; delete rest[key];
        return {
          snapshots: remembered ? { ...rest, [key]: { provider: "github", number: 42, ...remembered } } : rest,
          byTask: { ...s.byTask, [key]: {
            lookup: live ? { provider: "github", remote_url: "", status: "ok", message: "", pr: pr(live) } : null,
            loading: false, fetchedAt: Date.now() } },
        };
      });
    }, b, remembered, live);
    const mark = () => browser.execute((sel, tickSel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const tick = document.querySelector(tickSel) as HTMLElement | null;
      // What --color-ok computes to here, read off a probe rather than
      // hard-coded: themes recolour it.
      const probe = document.createElement("span");
      probe.style.color = "var(--color-ok)";
      document.body.appendChild(probe);
      const ok = getComputedStyle(probe).color;
      probe.style.color = "var(--color-pr-closed)";
      const closed = getComputedStyle(probe).color;
      probe.style.color = "var(--color-err)";
      const err = getComputedStyle(probe).color;
      probe.remove();
      const num = el.querySelector('[data-testid="task-pr-number"]') as HTMLElement | null;
      // How far the drawn line sits from the middle of a DIGIT, in px. The
      // baseline comes off a zero-size inline probe, the digit's height off
      // the font itself.
      let strikeOff: number | null = null;
      if (num) {
        const base = document.createElement("span");
        base.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
        num.appendChild(base);
        const baseline = base.getBoundingClientRect().bottom;
        base.remove();
        const cs = getComputedStyle(num);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const r = num.getBoundingClientRect();
        strikeOff = Math.abs((r.top + r.height / 2) - (baseline - ctx.measureText("4").actualBoundingBoxAscent / 2));
      }
      return {
        strikeOff,
        // closed-without-merging: its own muted red, never the alarm red,
        // and struck through so it does not rest on colour alone
        // a drawn line, not text-decoration: the font's own strikeout sits
        // below the middle of a digit
        struck: !!num && getComputedStyle(num).backgroundImage.includes("gradient")
          && !getComputedStyle(num).textDecorationLine.includes("line-through"),
        closedRed: !!num && getComputedStyle(num).color === closed && closed !== err,
        state: el.dataset.prState ?? "",
        cached: "prCached" in el.dataset,
        ticked: !!tick,
        tickIsOk: tick ? getComputedStyle(tick).color === ok : null,
        // the tick sits LEFT of the number, which stays the last thing in
        // the mark so the numbers share one right edge down the tree
        tickBeforeNumber: tick ? tick.nextElementSibling === el.lastElementChild && el.lastElementChild !== tick
          && (el.lastElementChild?.textContent ?? "").includes("42") : null,
      };
    }, BADGE, TICK);
    const waitMark = async (want: Record<string, unknown>, why: string) => {
      await browser.waitUntil(async () => {
        const got = await mark() as Record<string, unknown> | null;
        return !!got && Object.entries(want).every(([k, v]) => got[k] === v);
      }, { timeout: 5_000, timeoutMsg: `${why}: mark was ${JSON.stringify(await mark())}` });
    };
    try {
      await setPr(true);
      // No poll yet, nothing remembered: an identity, not a state.
      await seed(null, null);
      await waitMark({ state: "unknown", cached: false, ticked: false }, "nothing known");

      // Remembered from the last run: the colour is there before any poll.
      await seed({ state: "open", checks: "passing", review: "none" }, null);
      await waitMark({ state: "open", cached: true, ticked: false }, "remembered open");
      await seed({ state: "merged", checks: "passing", review: "approved" }, null);
      // merged is done: approved no longer says anything
      await waitMark({ state: "merged", cached: true, ticked: false }, "remembered merged");
      await seed({ state: "open", checks: "failing", review: "approved" }, null);
      await waitMark({ state: "open", cached: true, ticked: true, tickIsOk: true, tickBeforeNumber: true }, "remembered approved");

      // The live poll wins over what was remembered.
      await seed({ state: "open", checks: "passing", review: "approved" }, { state: "draft", checks: "none", review: "none" });
      await waitMark({ state: "draft", cached: false, ticked: false, struck: false, closedRed: false }, "live draft over a remembered open");

      // Closed without merging. A draft is the same grey number as an
      // unknown PR; a closed one must not be.
      await seed(null, { state: "closed", checks: "none", review: "none" });
      await waitMark({ state: "closed", struck: true, closedRed: true, ticked: false }, "live closed");
      await snap("sidebar-pr-closed.png");
      // Through the middle of the digits. The font's own strikeout was not:
      // it sat several px low. Up to 1px, because the drawn line is 1px and
      // snaps to the pixel grid: CI's runner, with its fallback font, lands
      // it exactly 1px off the digits' centre, which is the line's own width.
      expect((await mark())!.strikeOff).toBeLessThanOrEqual(1);
      await seed({ state: "closed", checks: "none", review: "none" }, null);
      await waitMark({ state: "closed", cached: true, struck: true, closedRed: true }, "remembered closed");
      await seed(null, { state: "open", checks: "passing", review: "changes_requested" });
      await waitMark({ state: "open", ticked: false }, "changes requested is not a tick");
      await seed(null, { state: "open", checks: "passing", review: "approved" });
      await waitMark({ state: "open", cached: false, ticked: true, tickIsOk: true, tickBeforeNumber: true }, "live approved");
      await snap("sidebar-task-pr-approved.png");

      // A remembered status for ANOTHER PR is not this one's.
      await browser.execute(id => {
        window.__termic!.usePr.setState((s: any) => ({
          byTask: { ...s.byTask, [id]: { lookup: null, loading: false, fetchedAt: Date.now() } },
          snapshots: { ...s.snapshots, [id]: { provider: "github", number: 41, state: "merged", checks: "passing", review: "none" } },
        }));
      }, b);
      await waitMark({ state: "unknown", cached: false }, "a snapshot of another PR");
    } finally {
      await browser.execute(id => {
        window.__termic!.usePr.setState((s: any) => {
          const byTask = { ...s.byTask }; delete byTask[id as string];
          const snapshots = { ...s.snapshots }; delete snapshots[id as string];
          return { byTask, snapshots };
        });
      }, b);
      await setPr(false);
    }
  });

  it("gives the row one trailing slot: state at rest, the menu on hover, and no dead column between them", async () => {
    // One fixed 18px slot, always rightmost. The menu trigger shares it,
    // hidden at rest and holding no badge of its own. It once had a reserved
    // slot beside the state one, which left every row 22px short on the right.
    const anatomy = await browser.execute(id => {
      const row = document.querySelector(`[data-sidebar-task-row="${id}"]`)!;
      const state = row.querySelector('[data-testid="task-state-slot"]') as HTMLElement | null;
      const menu = row.querySelector('[data-testid="task-menu-trigger"]') as HTMLElement | null;
      const slot = state?.parentElement ?? null;
      // The wrapper also holds expanded tab rows; the slots live in its header.
      const header = slot?.parentElement ?? null;
      const s = state?.getBoundingClientRect(), m = menu?.getBoundingClientRect(), h = header?.getBoundingClientRect();
      return {
        slotIsLast: !!slot && header!.lastElementChild === slot,
        sameSlot: !!slot && menu?.parentElement === slot,
        sameBox: !!s && !!m && Math.abs(s.left - m.left) < 1 && Math.abs(s.width - m.width) < 1,
        slotWidth: slot ? Math.round(slot.getBoundingClientRect().width) : null,
        // Nothing but the row's own padding to the right of the slot.
        gapToEdge: s && h ? Math.round(h.right - s.right) : null,
        menuOpacity: menu ? getComputedStyle(menu).opacity : null,
        badgeInMenu: !!menu?.querySelector('[data-testid="work-badge"], [data-testid="task-yolo-badge"]'),
      };
    }, b);
    expect(anatomy).toEqual({
      slotIsLast: true, sameSlot: true, sameBox: true, slotWidth: 18, gapToEdge: 4,
      menuOpacity: "0", badgeInMenu: false,
    });
  });

  it("PR numbers share one right edge, whether or not a row carries a mode mark", async () => {
    // The mode mark (sandbox, docker, YOLO) is absent on most rows. It used to
    // sit BETWEEN the PR mark and the trailing slot, so a row that had one
    // pushed its number 22px left of every row that did not. It is inline
    // after the name now, and the PR sits directly against the slot.
    const seedPr = (ids: string[], on: boolean) => browser.execute((ids, on) => {
      window.__termic!.useApp.setState((s: any) => ({
        tasks: s.tasks.map((w: any) => ids.includes(w.id)
          ? { ...w, pr_url: on ? "https://github.com/acme/repo/pull/42" : null, pr_number: on ? 42 : null, pr_provider: on ? "github" : null }
          : w),
      }));
    }, ids, on);
    // Seatbelt is macOS only: elsewhere every Seatbelt mode reads as off
    // (effectiveSandboxMode) and draws no mark, so the row is dressed in the
    // cage that platform has, Docker. The layout rule is the same for both.
    const setSandbox = (id: string, mode: string | null) => browser.execute((id, mode, seatbelt) => {
      window.__termic!.useApp.setState((s: any) => ({
        tasks: s.tasks.map((w: any) => w.id === id
          ? seatbelt
            ? { ...w, sandbox_enabled: !!mode, sandbox_mode: mode ?? "off" }
            : { ...w, docker_sandbox_enabled: !!mode }
          : w),
      }));
    }, id, mode, SEATBELT);
    const edges = () => browser.execute((plain, marked) => {
      const of = (id: string) => {
        const row = document.querySelector(`[data-sidebar-task-row="${id}"]`);
        const badge = row?.querySelector('[data-testid="task-pr-badge"]') as HTMLElement | null;
        const mode = row?.querySelector('[data-testid="task-mode-slot"]') as HTMLElement | null;
        return {
          right: badge ? Math.round(badge.getBoundingClientRect().right) : null,
          hasMode: !!mode,
          // the mode mark, when there is one, is LEFT of the PR mark
          modeLeftOfPr: mode && badge ? mode.getBoundingClientRect().right <= badge.getBoundingClientRect().left : null,
          // ...and beside the name, not in a trailing column of its own
          // (the trailing marks are direct children of the row)
          modeInNameGroup: !!mode && mode.parentElement !== row,
        };
      };
      return { plain: of(plain), marked: of(marked) };
    }, a, b);
    try {
      await seedPr([a, b], true);
      await setSandbox(b, "enforce");
      await browser.waitUntil(async () => {
        const e = await edges();
        return e.plain.right !== null && e.marked.right !== null && e.marked.hasMode;
      }, { timeout: 5_000, timeoutMsg: `the rows never drew: ${JSON.stringify(await edges())}` });
      const e = await edges();
      await snap("sidebar-task-pr-aligned.png");
      expect(e.plain.hasMode).toBe(false);
      expect(e.marked.modeLeftOfPr).toBe(true);
      expect(e.marked.modeInNameGroup).toBe(true);
      expect(e.marked.right).toBe(e.plain.right);
    } finally {
      await setSandbox(b, null);
      await seedPr([a, b], false);
    }
  });

  it("every mode mark sits beside the name, and no mix of marks moves a PR number", async () => {
    // Four rows, three passes: each mode (YOLO, monitor, enforce, enforce-fs,
    // docker) with and without a PR, numbers of different widths, and a
    // collapsed row whose name group also carries the tab count. The PR's
    // right edge is the one thing that must not depend on any of it.
    type Mark = { yolo?: boolean; mode?: string; docker?: boolean; pr?: number };
    const dress = (rows: Record<string, Mark>) => browser.execute(rows => {
      window.__termic!.useApp.setState((s: any) => ({
        tasks: s.tasks.map((w: any) => {
          const m = rows[w.id];
          if (!m) return w;
          return {
            ...w,
            sandbox_enabled: !!m.mode,
            sandbox_mode: m.mode ?? "off",
            docker_sandbox_enabled: !!m.docker,
            pr_url: m.pr ? `https://github.com/acme/repo/pull/${m.pr}` : null,
            pr_number: m.pr ?? null,
            pr_provider: m.pr ? "github" : null,
          };
        }),
      }));
    }, rows);
    const read = (ids: string[]) => browser.execute(ids => ids.map(id => {
      const row = document.querySelector(`[data-sidebar-task-row="${id}"]`);
      const badge = row?.querySelector('[data-testid="task-pr-badge"]') as HTMLElement | null;
      const mode = row?.querySelector('[data-testid="task-mode-slot"]') as HTMLElement | null;
      return {
        mode: !!mode,
        yolo: !!row?.querySelector('[data-testid="task-yolo-badge"]'),
        // the trailing marks are direct children of the row
        modeTrailing: !!mode && mode.parentElement === row,
        modeLeftOfPr: mode && badge ? mode.getBoundingClientRect().right <= badge.getBoundingClientRect().left : null,
        prRight: badge ? Math.round(badge.getBoundingClientRect().right) : null,
      };
    }), ids);
    const ids = [a, b, c, wt];
    const before = await activeTaskId();
    const pass = async (name: string, wanted: Mark[]) => {
      // Off macOS a Seatbelt mode draws nothing (see setSandbox above). A
      // sleeping row (c, wt) carries Docker instead, so it still has a mark
      // to place. A LIVE row (a, b) just drops it: a cage under a live agent
      // is a YOLO flip that raises a restart prompt and takes the window's
      // one confirm slot (see setYolo below), and that row expects no mark.
      const live = new Set([a, b]);
      const marks = SEATBELT ? wanted : wanted.map((m, i) => (!m.mode ? m
        : live.has(ids[i]) ? { ...m, mode: undefined } : { ...m, mode: undefined, docker: true }));
      await dress(Object.fromEntries(ids.map((id, i) => [id, marks[i]])));
      const want = marks.map(m => ({ mode: !!(m.yolo || m.mode || m.docker), pr: !!m.pr }));
      await browser.waitUntil(async () => (await read(ids)).every((r, i) =>
        r.mode === want[i].mode && (r.prRight !== null) === want[i].pr),
      { timeout: 5_000, timeoutMsg: `${name}: the rows never drew: ${JSON.stringify(await read(ids))}` });
      await snap(`sidebar-mode-inline-${name}.png`);
      const got = await read(ids);
      for (const r of got) {
        expect(r.modeTrailing).toBe(false);
        if (r.modeLeftOfPr !== null) expect(r.modeLeftOfPr).toBe(true);
      }
      expect(new Set(got.map(r => r.prRight).filter(x => x !== null)).size).toBe(1);
      return got;
    };
    // Flipping YOLO under a live agent asks whether to restart it, and the
    // window has ONE confirm slot. So: one task at a time, each answered
    // "Later" before the next, or a prompt is left over every later case.
    const setYolo = async (id: string, on: boolean) => {
      const flipped = await browser.execute((id, on) => {
        const app = window.__termic!.useApp;
        if (!!app.getState().tasks.find((w: any) => w.id === id)?.yolo === on) return false;
        app.setState((s: any) => ({ tasks: s.tasks.map((w: any) => w.id === id ? { ...w, yolo: on } : w) }));
        return true;
      }, id, on);
      if (!flipped) return;
      const pending = () => browser.execute(id =>
        !!window.__termic!.useUI.getState().confirm?.req.key?.startsWith(`yolo-restart:${id}:`), id);
      await browser.waitUntil(pending, { timeout: 8_000, timeoutMsg: `no restart prompt for ${id}` });
      await browser.execute(() => window.__termic!.useUI.getState().resolveConfirm(false));
      await browser.waitUntil(async () => !(await pending()), { timeout: 5_000, timeoutMsg: "the restart prompt stayed" });
    };
    let second = "";
    // Put back as found, absent key included: an unset fold is not `false`,
    // and the chip case below reads a's badge off its collapsed row.
    const fold = await browser.execute(t => window.__termic!.useApp.getState().collapsedTasks[t] ?? null, a);
    try {
      // YOLO only draws over a LIVE agent, and b was created without being
      // opened. c and wt stay asleep and take the cages: leaving a cage
      // under a live agent is a YOLO flip too, and would prompt.
      for (const id of [a, b]) { await ensureActiveTask(id); await waitForAgentReady(id); }
      await pass("sandbox", [
        { mode: "monitor", pr: 42 }, {}, { mode: "enforce-fs", pr: 19902 }, { docker: true, pr: 7 },
      ]);
      await setYolo(a, true);
      await setYolo(b, true);
      const yolo = await pass("yolo", [
        { yolo: true, pr: 20069 }, { yolo: true }, { docker: true }, { mode: "enforce", pr: 19752 },
      ]);
      expect(yolo.map(r => r.yolo)).toEqual([true, true, false, false]);
      // Collapsed with two tabs: the name group also holds the count.
      second = await browser.execute(t => {
        const tab = { id: crypto.randomUUID(), type: "terminal", cli: "fakeagent", title: "Second" };
        window.__termic!.useApp.getState().addTab(t, tab as never);
        window.__termic!.useApp.getState().setTaskCollapsed(t, true);
        return tab.id;
      }, a);
      await pass("collapsed", [
        { yolo: true, pr: 20069 }, { yolo: true, pr: 42 }, { mode: "monitor" }, { docker: true, pr: 7 },
      ]);
    } finally {
      if (second) await browser.execute((t: any, tb: any, was: any) => {
        window.__termic!.useApp.getState().closeTab(t, tb);
        window.__termic!.useApp.setState((s: any) => {
          const next: any = { ...s.collapsedTasks };
          if (was === null) delete next[t]; else next[t] = was;
          return { collapsedTasks: next };
        });
      }, a, second, fold);
      await setYolo(a, false);
      await setYolo(b, false);
      await dress(Object.fromEntries(ids.map(id => [id, {}])));
      await restoreActive(before);
    }
  });

  it("the three dots can be pressed: the status layer over them takes no pointer events", async () => {
    // The slot holds the status badge AND the menu trigger in one box. The
    // badge's layer comes later in the DOM, so it is on top, and once it was
    // left able to take pointer events: invisible on hover, and still eating
    // every click meant for the dots. No spec caught it, because specs press
    // things with element.click(), which never asks what is on top.
    //
    // So this asks. CSS :hover cannot be driven from here, but it does not
    // need to be: the question is whether the layer on top is click-through,
    // and `elementsFromPoint` lists exactly the elements a pointer can hit.
    const ROW = `[data-sidebar-task-row="${b}"]`;
    const TRIGGER = `${ROW} [data-testid="task-menu-trigger"]`;
    const probe = () => browser.execute(sel => {
      const trigger = document.querySelector(sel) as HTMLElement;
      const state = trigger.parentElement!.querySelector('[data-testid="task-state-slot"]') as HTMLElement;
      const r = trigger.getBoundingClientRect();
      const hittable = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        stateOverTrigger: !!(trigger.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING),
        statePointerEvents: getComputedStyle(state).pointerEvents,
        stateHittable: hittable.includes(state),
      };
    }, TRIGGER);
    try {
      // On top, and yet nothing a pointer can land on.
      expect(await probe()).toEqual({ stateOverTrigger: true, statePointerEvents: "none", stateHittable: false });

      // Hidden at rest, so not clickWhenVisible. Radix opens on pointerdown.
      await browser.execute(sel => {
        const el = document.querySelector(sel) as HTMLElement;
        const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
      }, TRIGGER);
      await browser.waitUntil(
        () => browser.execute(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
          .some(el => el.textContent?.includes("Archive"))),
        { timeout: 5_000, timeoutMsg: "the three dots opened no task menu" });
      await snap("sidebar-task-menu-open.png");
      // Still click-through with the menu open, when the badge is hidden by
      // a class rather than by hover.
      expect((await probe()).statePointerEvents).toBe("none");
    } finally {
      await dismissOverlays();
    }
  });

  it("Pin keeps a task listed whatever the filters say, and Unpin lets them hide it again (GH #458)", async () => {
    const pid = await fixtureId();
    const prev = await activeTaskId();
    const ROW = (id: string) => `[data-sidebar-task-row="${id}"]`;
    const pinned = (id: string) => browser.execute(i =>
      !!window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.pinned, id);
    // The real menu, the real item: Radix opens on pointerdown, and the
    // trigger is hover-only, so a plain click would never reach it.
    const openMenu = async (id: string) => {
      await browser.execute(sel => {
        const el = document.querySelector(sel) as HTMLElement;
        const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
      }, `${ROW(id)} [data-testid="task-menu-trigger"]`);
      await waitVisible('[data-testid="task-menu-pin"]');
    };
    const pinLabel = () => browser.execute(() =>
      document.querySelector('[data-testid="task-menu-pin"]')?.textContent?.trim() ?? null);
    try {
      // The open task is `c`, so `b` is not held up by being active.
      await ensureActiveTask(c);
      await openMenu(b);
      expect(await pinLabel()).toBe("Pin");
      await snap("sidebar-task-menu-pin.png");
      await clickWhenVisible('[data-testid="task-menu-pin"]');
      await browser.waitUntil(() => pinned(b), { timeout: 5_000, timeoutMsg: "Pin did not mark the task pinned" });
      await dismissOverlays();
      // The row says why it ignores the filters, and only the pinned row does.
      expect(await present(`${ROW(b)} [data-testid="task-pinned-mark"]`)).toBe(true);
      expect(await present(`${ROW(a)} [data-testid="task-pinned-mark"]`)).toBe(false);
      await openMenu(b);
      expect(await pinLabel()).toBe("Unpin");
      await dismissOverlays();

      // The sidebar query: `b` matches nothing here, and stays, with its project.
      await setQuery("sfilter-no-such-thing");
      await waitTree([a, b, c], s => s.includes(b) && !s.includes(a), "a pinned task was hidden by the sidebar query");
      expect(await present(`[data-project-id="${pid}"]`)).toBe(true);
      await snap("sidebar-filter-pinned-survives.png");
      await setQuery("");

      // The project's own filter bar, the same way.
      await browser.execute(i => window.__termic!.useUI.getState().setTaskFilterText(i, "sfilter-no-such-thing"), pid);
      await waitTree([a, b, c], s => s.includes(b) && !s.includes(a), "a pinned task was hidden by the project filter");
      await browser.execute(i => window.__termic!.useUI.getState().setTaskFilterText(i, ""), pid);

      // Unpin, and the same query hides it again.
      await openMenu(b);
      await clickWhenVisible('[data-testid="task-menu-pin"]');
      await browser.waitUntil(async () => !(await pinned(b)), { timeout: 5_000, timeoutMsg: "Unpin did not clear the pin" });
      await dismissOverlays();
      expect(await present(`${ROW(b)} [data-testid="task-pinned-mark"]`)).toBe(false);
      await setQuery("sfilter-no-such-thing");
      await waitTree([a, b, c], s => !s.includes(b), "an unpinned task was still kept by the query");
    } finally {
      await setQuery("");
      await browser.execute(i => window.__termic!.useUI.getState().setTaskFilterText(i, ""), pid);
      await dismissOverlays();
      // A failed assertion above must not leave the fixture pinned for the
      // cases after this one: a pinned task ignores every filter they use.
      if (await pinned(b)) {
        await browser.execute(i => window.__termic!.useApp.getState().setTaskPinned(i, false), b);
        await browser.waitUntil(async () => !(await pinned(b)), { timeout: 5_000, timeoutMsg: "cleanup could not unpin the fixture task" });
      }
      await restoreActive(prev);
    }
  });

  it("a project with no matches hides, and the empty state clears the query", async () => {
    const pid = await fixtureId();
    const prev = await activeTaskId();
    const open = c;
    await ensureActiveTask(open);
    await setQuery("project:no-such-project");
    // the open task is always kept, so its project stays with just that row
    await waitTree([a, b, c], s => s.length === 1 && s[0] === open, "the open task's project did not keep only the open task");
    expect(await present(`[data-project-id="${pid}"]`)).toBe(true);
    // with nothing open, nothing holds the project up
    await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
    await browser.waitUntil(async () => !(await present(`[data-project-id="${pid}"]`)),
      { timeout: 5_000, timeoutMsg: "an unmatched project still showed its header" });
    await clickWhenVisible('[data-testid="sidebar-filter-empty"] button');
    await browser.waitUntil(async () => (await query()) === "", { timeout: 5_000, timeoutMsg: "the empty state's clear did not clear" });
    await waitVisible(`[data-project-id="${pid}"]`);
    await restoreActive(prev);
  });

  it("a sidebar query pauses the project's own filter: bar hidden, icon slashed, both back when it clears", async () => {
    const pid = await fixtureId();
    const toggle = `[data-testid="project-filter-toggle-${pid}"]`;
    const input = `[data-testid="project-filter-input-${pid}"]`;
    const icon = () => browser.execute(sel => {
      const el = document.querySelector(sel);
      return el && {
        paused: el.getAttribute("data-paused"),
        pinned: el.getAttribute("data-pinned"),
        pressed: el.getAttribute("aria-pressed"),
        slashed: !!el.querySelector('svg path[d="m2 2 20 20"]'),
      };
    }, toggle);
    const prev = await activeTaskId();
    await ensureActiveTask(c);
    try {
      // the project filter alone: only alpha (and the open task) are left
      await browser.execute(id => window.__termic!.useUI.getState().setTaskFilterText(id, "sfilter-alpha"), pid);
      await waitTree([a, b], s => s.length === 1 && s[0] === a, "the project filter did not narrow to alpha");
      await waitVisible(input);
      expect(await icon()).toEqual({ paused: null, pinned: "true", pressed: "true", slashed: false });
      // a sidebar query takes over: bravo shows though the project filter
      // would hide it, the bar goes, and the icon stays pinned with a slash
      await setQuery("sfilter-bravo");
      await waitTree([a, b], s => s.length === 1 && s[0] === b, "the sidebar query did not take over from the project filter");
      await waitGone(input);
      expect(await icon()).toEqual({ paused: "true", pinned: "true", pressed: "false", slashed: true });
      await snap("sidebar-filter-project-paused.png");
      // the slashed icon is inert: no bar, and the query is untouched
      await browser.execute(sel => (document.querySelector(sel) as HTMLElement).click(), toggle);
      await browser.pause(150);
      expect(await present(input)).toBe(false);
      expect(await query()).toBe("sfilter-bravo");
      // clearing the query brings the project filter back untouched
      await setQuery("");
      await waitTree([a, b], s => s.length === 1 && s[0] === a, "the project filter did not resume after the query cleared");
      await waitVisible(input);
      expect(await browser.execute(sel => (document.querySelector(sel) as HTMLInputElement).value, input)).toBe("sfilter-alpha");
      expect(await icon()).toEqual({ paused: null, pinned: "true", pressed: "true", slashed: false });

      // an empty open bar has nothing to pause: a query closes it for good
      await browser.execute(id => window.__termic!.useUI.getState().setTaskFilterText(id, ""), pid);
      await browser.execute(sel => (document.querySelector(sel) as HTMLElement).click(), toggle);
      await waitVisible(input);
      await setQuery("sfilter-bravo");
      await waitGone(input);
      expect(await present(`${toggle}[data-paused]`)).toBe(false);
      await setQuery("");
      // a negative: the closed bar must NOT reopen, and nothing fires for that
      await browser.pause(150);
      expect(await present(input)).toBe(false);
    } finally {
      await setQuery("");
      await browser.execute(id => window.__termic!.useUI.getState().setTaskFilterText(id, ""), pid);
      await restoreActive(prev);
    }
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

  it("a fold made while filtering is the query's: the stored fold never moves, and an edit drops it", async () => {
    const pid = await fixtureId();
    const before = await storedFold(pid);
    await setQuery("sfilter-bravo");
    await waitVisible(TREE_ROW(b));
    await clickProjectHeader(pid);
    await waitGone(TREE_ROW(b));
    expect(await queryFolds()).toEqual({ [pid]: true });
    expect(await storedFold(pid)).toBe(before);
    // Any edit to the query starts from open again.
    await setQuery("sfilter-brav");
    await waitVisible(TREE_ROW(b));
    expect(await queryFolds()).toEqual({});
    // Folded again, then cleared: the stored layout is back as it was.
    await clickProjectHeader(pid);
    await waitGone(TREE_ROW(b));
    await setQuery("");
    await waitVisible(TREE_ROW(b));
    expect(await storedFold(pid)).toBe(before);
  });

  it("a match inside a collapsed task group shows while filtering, and the group's stored fold stays", async () => {
    // c joins a group led by b (the group id is the lead's task id), then the
    // group is folded the stored way.
    await browser.execute(async (member, lead) => {
      const t = window.__termic!;
      await t.ipc.taskGroupJoin(member, lead);
      await t.useApp.getState().loadAll();
    }, c, b);
    await waitVisible(`[data-task-group-id="${b}"] ${TREE_ROW(c)}`);
    await browser.execute(g => window.__termic!.useApp.getState().setTaskGroupCollapsed(g, true), b);
    await waitGone(TREE_ROW(c));
    await setQuery("sfilter-charlie");
    await waitVisible(TREE_ROW(c));
    expect(await browser.execute(g => window.__termic!.useApp.getState().collapsedTaskGroups[g], b)).toBe(true);
    // Its chevron folds it for this query only.
    await clickWhenVisible(`[data-testid="task-group-toggle-${b}"]`);
    await waitGone(TREE_ROW(c));
    expect(await queryFolds()).toEqual({ [`taskGroup:${b}`]: true });
    await setQuery("");
    await browser.execute(async (member, g) => {
      const t = window.__termic!;
      t.useApp.getState().setTaskGroupCollapsed(g, false);
      await t.ipc.taskGroupLeave(member);
      await t.useApp.getState().loadAll();
    }, c, b);
    await waitVisible(TREE_ROW(c));
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

    // Under another clause a chip counts within it, and stays drawn at 0 so
    // typing never makes the row come and go. b was never opened.
    const chipCount = () => browser.execute(sel =>
      document.querySelector(`${sel} [data-testid="status-chip-count"]`)?.textContent ?? null, CHIP);
    await setQuery("sfilter-bravo");
    await browser.waitUntil(async () => (await chipCount()) === "0", { timeout: 5_000, timeoutMsg: "the chip did not count under the query" });
    // Its click leaves exactly that: no attention task, only the open one
    // the tree always keeps (none here, the dashboard is up).
    await clickWhenVisible(CHIP);
    await browser.waitUntil(async () => (await query()) === "sfilter-bravo status:attention", { timeout: 5_000, timeoutMsg: "the chip did not AND into the query" });
    await waitTree([a, b, c], s => s.length === 0, "the chip under a clause left rows its count did not");
    await setQuery("");
  });

  // A query longer than the sidebar is wide cannot be read or edited in one
  // clipped line, so the field wraps while it has focus. It grows OVER the
  // chips, out of flow: nothing below it may move.
  it("wraps a long query while focused, without moving the chips, and is one line again on blur", async () => {
    const CHIPS = '[data-testid="status-chips"]';
    // Against the field's own ROW, never a literal 28: h-7 is rem, and the
    // app's root font size is 14px, so the row is 24.5px. The component made
    // the same assumption and stood 3.5px taller than its row when focused.
    const heights = () => browser.execute((inp, chips) => ({
      field: Math.round((document.querySelector(inp) as HTMLElement).getBoundingClientRect().height),
      row: Math.round((document.querySelector(inp) as HTMLElement).parentElement!.getBoundingClientRect().height),
      chipsTop: Math.round((document.querySelector(chips) as HTMLElement).getBoundingClientRect().top),
    }), INPUT, CHIPS);
    await setQuery("");
    await browser.execute(sel => (document.querySelector(sel) as HTMLElement).blur(), INPUT);
    const idle = await heights();
    expect(idle.row).toBeGreaterThan(0);
    expect(idle.field).toBe(idle.row);
    // Focused with nothing to wrap, it is still exactly its row.
    await browser.execute(sel => (document.querySelector(sel) as HTMLElement).focus(), INPUT);
    expect((await heights()).field).toBe(idle.row);
    // And it has its own row. The field is out of flow, so a row that
    // collapses puts it straight on top of the chips: that shipped to a beta
    // build with every other measurement in this case still passing.
    const fieldBottom = await browser.execute(sel =>
      Math.round((document.querySelector(sel) as HTMLElement).getBoundingClientRect().bottom), INPUT);
    expect(fieldBottom).toBeLessThanOrEqual(idle.chipsTop);

    // setInputValue focuses, which is the state under test.
    await setInputValue(INPUT, "status:done,attention agent:fakeagent,claude,codex,gemini branch:feature/some-long-branch-name");
    await browser.waitUntil(async () => { const h = await heights(); return h.field > h.row; }, { timeout: 5_000, timeoutMsg: "a focused long query stayed on one line" });
    expect((await heights()).chipsTop).toBe(idle.chipsTop);
    await snap("sidebar-filter-wrapped.png");
    // Never a newline, whatever the field looks like: Enter adds none.
    await browser.keys(["Enter"]);
    const typed = await query();
    expect(typed).toContain("status:done,attention");
    expect(typed).not.toContain("\n");

    await browser.execute(sel => (document.querySelector(sel) as HTMLElement).blur(), INPUT);
    await browser.waitUntil(async () => { const h = await heights(); return h.field === h.row; }, { timeout: 5_000, timeoutMsg: "the blurred field stayed tall" });
    expect((await heights()).chipsTop).toBe(idle.chipsTop);
    await snap("sidebar-filter-blurred-long.png");
    await setQuery("");
  });

  // The row used to exist only while a chip had something to count, so it
  // appeared with the first working agent and went with the last, and the
  // project tree jumped a row each time.
  it("draws every chip whatever it counts, and an empty one does nothing", async () => {
    const chips = () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="status-chips"] [data-status-chip]')].map(el => ({
        chip: el.getAttribute("data-status-chip"),
        empty: el.hasAttribute("data-empty"),
        disabled: el.getAttribute("aria-disabled"),
        count: el.querySelector('[data-testid="status-chip-count"]')?.textContent ?? null,
      })));
    const all = await chips();
    expect(all.map(c => c.chip)).toEqual(["action", "working", "attention", "review", "settled"]);
    // The fixture has no PR, so In review is the chip that is certainly empty.
    const review = all.find(c => c.chip === "review")!;
    expect(review).toEqual({ chip: "review", empty: true, disabled: "true", count: "0" });
    // Every chip agrees with itself: empty exactly when it is disabled.
    for (const c of all) expect(c.disabled === "true").toBe(c.empty);
    // Tasks in action counts tasks with an open agent tab (is:open). `a` has
    // a live agent terminal, so action counts at least 1.
    const n = (chip: string) => Number(all.find(c => c.chip === chip)!.count);
    expect(n("action")).toBeGreaterThanOrEqual(1);
    expect(await browser.execute(() => {
      const row = document.querySelector('[data-testid="status-chips"]')!;
      const rule = row.querySelector('[data-testid="status-chips-rule"]');
      const kids = [...row.children];
      // Right after the total, before the first column.
      return !!rule && kids.indexOf(rule) === 1;
    })).toBe(true);

    // The row's box is what must not move: same top and height with one chip
    // counting as with none. `a` still carries the attention seeded above.
    const box = () => browser.execute(() => {
      const r = document.querySelector('[data-testid="status-chips"]')!.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height) };
    });
    const withOne = await box();
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.clearAttention(id, tab.id);
    }, a);
    await browser.waitUntil(
      async () => (await chips()).find(c => c.chip === "attention")!.empty,
      { timeout: 5_000, timeoutMsg: "the attention chip never emptied" },
    );
    expect(await box()).toEqual(withOne);

    await clickWhenVisible('[data-status-chip="review"]');
    expect(await query()).toBe("");
  });

  it("Tasks in action chip toggles is:open and yields to column chips", async () => {
    // Seed attention on a so the attention chip is active and clickable.
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.markAttention(id, tab.id, "attention", "needs you");
    }, a);
    const ACTION = '[data-status-chip="action"]';
    const ATTENTION = '[data-status-chip="attention"]';
    await waitVisible(ACTION);

    // Clicking action writes is:open
    await clickWhenVisible(ACTION);
    await browser.waitUntil(async () => (await query()) === "is:open", {
      timeout: 5_000,
      timeoutMsg: "the action chip did not write is:open",
    });
    expect(await browser.execute(sel => document.querySelector(sel)?.getAttribute("aria-pressed"), ACTION)).toBe("true");

    // Clicking a column chip replaces is:open with that status
    await clickWhenVisible(ATTENTION);
    await browser.waitUntil(async () => (await query()) === "status:attention", {
      timeout: 5_000,
      timeoutMsg: "the attention chip did not replace is:open",
    });
    expect(await browser.execute(sel => document.querySelector(sel)?.getAttribute("aria-pressed"), ACTION)).toBe("false");
    expect(await browser.execute(sel => document.querySelector(sel)?.getAttribute("aria-pressed"), ATTENTION)).toBe("true");

    // Clicking action while a column chip is on replaces it with is:open
    await clickWhenVisible(ACTION);
    await browser.waitUntil(async () => (await query()) === "is:open", {
      timeout: 5_000,
      timeoutMsg: "action chip did not replace column status with is:open",
    });

    // Clicking action again toggles it back off
    await clickWhenVisible(ACTION);
    await browser.waitUntil(async () => (await query()) === "", {
      timeout: 5_000,
      timeoutMsg: "a second click did not take is:open back out",
    });

    // Clean up seeded attention
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.clearAttention(id, tab.id);
    }, a);
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
