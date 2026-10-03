// Kanban view (docs/ui.md "Kanban view", issue #318): nav entry, derived
// columns, the two drags that mean something (same-project reorder,
// drop-to-archive with its confirm dialog), and the drag that does not
// (cross-column snap-back).
//
// Deterministic by construction: every task here is idle, so it sits in
// Settled regardless of the work-badge prefs. The transient working/attention
// columns are covered by the unit matrix in src/lib/taskBoardState.test.ts;
// racing the fake agent's sub-second busy window here would be the flaky
// version of the same assertion.

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  archiveTask,
  clickByText,
  dismissOverlays,
  ensureActiveTask,
  openTask,
  pointerDrag,
  pointerRelease,
  requireTermicApi,
  snap,
  waitForAppShell,
  waitGone,
  waitVisible,
} from "../helpers.js";

const COLUMN = (column: string) => `[data-board-cell][data-column="${column}"]`;
const LANE_IN = (lane: string, column: string) => `${COLUMN(column)} [data-board-lane="${lane}"]`;
const CARD = (id: string) => `[data-board-task-id="${id}"]`;

/** Ids of a project's live tasks in store order (what the sidebar shows). */
const projectTaskOrder = () =>
  browser.execute(() =>
    window.__termic!.useApp
      .getState()
      .tasks.filter((w: any) => !w.archived)
      .map((w: any) => w.id),
  );

/** Card ids rendered in one board lane, in DOM order. */
const cellCardOrder = (lane: string, column: string) =>
  browser.execute(
    sel =>
      [...document.querySelectorAll<HTMLElement>(`${sel} [data-board-task-id]`)]
        .map(el => el.dataset.boardTaskId),
    LANE_IN(lane, column),
  );

describe("board view", () => {
  let t1 = "";
  let t2 = "";
  let t3 = "";
  let t4 = "";
  // Tasks the archive-cap case creates and archives; the after hook treats
  // them like t2-t4 so a throw half way still leaves nothing live behind.
  let cap: string[] = [];

  after(async () => {
    // The cap case drives the limit pref through the store as setup; put it
    // back whichever way the case ended.
    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setBoardArchiveLimitMode("default"));
    // t1 is archived by its own case; archive what survived. Deleting by id
    // is enough here: each openTask either returned or threw before creating.
    for (const id of [t2, t3, t4, ...cap]) {
      if (!id) continue;
      const archived = await browser.execute(
        i => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === i)?.archived,
        id,
      );
      if (!archived) await archiveTask(id);
    }
  });

  /** Card ids rendered in the Archived column, in DOM order. */
  const archivedCardIds = () =>
    browser.execute(
      sel =>
        [...document.querySelectorAll<HTMLElement>(`${sel} [data-board-task-id]`)]
          .map(el => el.dataset.boardTaskId),
      "[data-board-archive]",
    );

  it("opens from the sidebar nav and places untouched tasks in Not started, one lane per agent", async () => {
    await waitForAppShell();
    await requireTermicApi();
    t1 = await openTask("board-a", true, "fakeagent");
    t2 = await openTask("board-b", false, "fakeagent");
    t3 = await openTask("board-c", false, "fakecapture");

    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');

    // One lane per cli actually in use, named for the agent.
    await waitVisible('[data-board-lane="fakeagent"]');
    await waitVisible('[data-board-lane="fakecapture"]');

    // Tasks nobody has submitted anything to are Not started, under their
    // agent's lane divider. This is the distinction that keeps "the agent
    // is sitting idle" from reading as "the agent finished".
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t1)}`);
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`);
    await waitVisible(`${LANE_IN("fakecapture", "backlog")} ${CARD(t3)}`);

    // The column accent edge is a color-mix over a theme token. Assert the
    // computed value: if the engine dropped the color-mix, the card would
    // render with the default border on all four edges and the accent would
    // be an invisible no-op that a screenshot cannot catch.
    const edge = await browser.execute(sel => {
      const cs = getComputedStyle(document.querySelector(sel) as HTMLElement);
      return { left: cs.borderLeftColor, right: cs.borderRightColor };
    }, `${LANE_IN("fakeagent", "backlog")} ${CARD(t1)}`);
    expect(edge.left).not.toBe(edge.right);

    await snap("board.png");
  });

  it("clicking a card activates the task and leaves the board", async () => {
    await browser.execute(
      sel => (document.querySelector(sel) as HTMLElement).click(),
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          id => window.__termic!.useApp.getState().activeTaskId === id,
          t2,
        ),
      { timeout: 5_000, timeoutMsg: "card click never activated the task" },
    );
    await waitGone('[data-testid="board-view"]');
  });

  it("dragging within a same-project group reorders, and the order persists", async () => {
    t4 = await openTask("board-d", false, "fakeagent");
    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');
    await dismissOverlays();

    // All three fakeagent tasks are untouched, so the backlog group holds
    // them in store order: t1, t2, then the just-created t4.
    const before = await cellCardOrder("fakeagent", "backlog");
    expect(before).toEqual([t1, t2, t4]);

    // Land on the TOP half of t1's card: the midpoint rule inserts before it.
    await pointerDrag(
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t4)}`,
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t1)}`,
      { land: "top" },
    );

    await browser.waitUntil(
      async () => JSON.stringify(await cellCardOrder("fakeagent", "backlog")) === JSON.stringify([t4, t1, t2]),
      { timeout: 5_000, timeoutMsg: "board cell never showed the reordered cards" },
    );
    // The store is the same truth the sidebar renders, and task_reorder
    // persists it. t3 (fakecapture lane, same project) keeps its place.
    const storeOrder = (await projectTaskOrder()) as string[];
    expect(storeOrder.indexOf(t4)).toBeLessThan(storeOrder.indexOf(t1));
    expect(storeOrder.indexOf(t1)).toBeLessThan(storeOrder.indexOf(t2));
  });

  it("a drag in one lane leaves the project's other lanes rendering", async () => {
    // The reorder preview used to be keyed by projectId alone. Every OTHER
    // group of the same project then applied it, matched none of the ids, and
    // rendered zero cards for the length of the gesture while lighting its own
    // drop ring. t3 is this project's fakecapture lane, in the same column as
    // the drag, so it is exactly the group that blanked.
    //
    // It has to be asserted mid-drag: on pointerup the preview clears and the
    // cards come back, which is why a whole-gesture drag sees nothing wrong.
    expect(await cellCardOrder("fakecapture", "backlog")).toEqual([t3]);

    await pointerDrag(
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`,
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t4)}`,
      { land: "top", hold: true },
    );
    const duringDrag = await cellCardOrder("fakecapture", "backlog");
    // Release before asserting, so a failure here still ends the gesture and
    // does not leave the pointer down for every case after it.
    await pointerRelease(COLUMN("working"));
    expect(duringDrag).toEqual([t3]);

    // Released over a column that is not a drop target: nothing was written,
    // so the lane the drag came from is untouched too.
    await browser.waitUntil(
      async () => JSON.stringify(await cellCardOrder("fakeagent", "backlog")) === JSON.stringify([t4, t1, t2]),
      { timeout: 5_000, timeoutMsg: "the held drag wrote an order after releasing off-target" },
    );
  });

  it("dragging to another column snaps back with no dialog and no write", async () => {
    await pointerDrag(
      `${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`,
      COLUMN("working"),
    );
    // No drop target outside the origin group and the Archived column, so the
    // card stays put and nothing (confirm dialog included) appears.
    const dialogUp = await browser.execute(
      () => !!document.querySelector('[role="dialog"]'),
    );
    expect(dialogUp).toBe(false);
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`);
    const archived = await browser.execute(
      id => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.archived,
      t2,
    );
    expect(archived).toBe(false);
  });

  it("a task that finished a turn moves out of Not started into Settled", async () => {
    // Submit through the real input path (waitForAgentReady first, per the
    // suite rule) and let the fake agent run its busy -> idle cycle: the
    // classifier must see working then done, and the card must end in
    // Settled. This is the regression case for "a task that did nothing
    // shows as completed": doing something is what moves the card.
    const { submitToAgent, waitForAgentReady, waitForWorkBadge, waitForWorkBadgeGone } = await import("../helpers.js");
    await ensureActiveTask(t1);
    await waitForAgentReady(t1);
    await submitToAgent(t1, "write something to the terminal");
    await waitForWorkBadge(t1, "working", { timeout: 20_000 });
    await waitForWorkBadgeGone(t1, "working", { timeout: 30_000 });

    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');
    await browser.waitUntil(
      async () => !!(await cellCardOrder("fakeagent", "settled")).includes(t1),
      { timeout: 30_000, timeoutMsg: "submitted task never landed in Settled" },
    );
    // Its untouched sibling stays behind in Not started.
    await waitVisible(`${LANE_IN("fakeagent", "backlog")} ${CARD(t2)}`);
    await snap("board-after-submit.png");
  });

  it("dropping a card on the Archived column archives it through the real confirm dialog", async () => {
    await dismissOverlays();
    // t1, now in Settled: this case deliberately drags from the column
    // ADJACENT to Archived. A source on the board's far side (backlog) and
    // the target cannot be on screen together in a narrow window, and the
    // drag helper's scroll-into-view of one endpoint moves the other — the
    // gesture then releases over whatever column is actually under the
    // cursor and the dialog never comes.
    await pointerDrag(
      `${LANE_IN("fakeagent", "settled")} ${CARD(t1)}`,
      "[data-board-archive]",
    );

    // The shared confirmAndArchive dialog, scoped by its title per the suite's
    // dialog rule. Repo-root task, so the confirm label is "Remove entry".
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')].some(d =>
            d.textContent?.includes('Archive "board-a"')),
        ),
      { timeout: 5_000, timeoutMsg: "archive confirm dialog never appeared" },
    );
    await clickByText("Remove entry");

    // The card moves to the Archived column and the store agrees; the
    // fakecapture lane stays, its task was never touched.
    await waitVisible(`[data-board-archive] ${CARD(t1)}`);
    await browser.waitUntil(
      () =>
        browser.execute(
          id => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.archived,
          t1,
        ),
      { timeout: 10_000, timeoutMsg: "task never landed as archived in the store" },
    );
    await snap("board-after-archive.png");
  });

  it("caps the Archived column to the limit, newest first, badge showing the full count", async () => {
    // The pref is SETUP here, driven through the store; the control that
    // edits it is covered in settings.e2e.ts. t1, archived by the case
    // above, is older than everything archived below, so the cap has to
    // push it off the column's far end too, not just bound new arrivals.
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setBoardArchiveLimitMode("custom");
      p.setBoardArchiveLimit(5);
    });
    const baseArchived = await browser.execute(
      () => window.__termic!.useApp.getState().tasks.filter((w: any) => w.archived).length,
    ) as number;

    cap = [];
    for (const name of ["board-cap-1", "board-cap-2", "board-cap-3", "board-cap-4", "board-cap-5", "board-cap-6", "board-cap-7"]) {
      cap.push(await openTask(name, false, "fakeagent"));
    }
    // Archive in creation order, so archived_at ascends with the index and
    // the column must render the exact reverse.
    for (const id of cap) await archiveTask(id);

    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');

    // Exactly the five most recent, newest first. waitUntil rather than a
    // bare expect: two archives landing in the same millisecond sort in
    // store order for a tick, and each round-trip only just missed it.
    await browser.waitUntil(
      async () =>
        JSON.stringify(await archivedCardIds()) === JSON.stringify(cap.slice(2).reverse()),
      { timeout: 5_000, timeoutMsg: "Archived column never showed the capped, newest-first slice" },
    );
    await waitGone(`[data-board-archive] ${CARD(t1)}`);

    // The badge keeps the truth: every archived task, rendered or not.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('[data-testid="board-archive-count"]')?.textContent ?? "",
        )) === String(baseArchived + cap.length),
      { timeout: 5_000, timeoutMsg: "badge never showed the full archived count" },
    );
    await snap("board-capped-archive.png");
  });

  // Empty columns are hidden so the ones with cards are not pushed off screen
  // (reported with four empty columns doing exactly that). The rail on the
  // right says which are hidden, and carries their drop targets so hiding a
  // column never removes its command.
  it("hides empty columns onto a rail that still takes their drops", async () => {
    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');
    // Whatever is empty right now is what should be missing. Read it from the
    // store rather than assuming a fixture shape.
    const emptyCols = await browser.execute(() => {
      const shown = [...document.querySelectorAll("[data-board-cell][data-column]")]
        .filter(e => !e.hasAttribute("data-board-hidden-column"))
        .map(e => (e as HTMLElement).dataset.column);
      return ["backlog", "attention", "working", "review", "settled"].filter(c => !shown.includes(c));
    }) as string[];
    expect(emptyCols.length).toBeGreaterThan(0);

    // Each hidden one is on the rail, and is still a drop target there.
    await waitVisible('[data-testid="board-hidden-columns"]');
    for (const c of emptyCols) {
      await waitVisible(`[data-board-hidden-column="${c}"]`);
      const droppable = await browser.execute((col) => {
        const el = document.querySelector(`[data-board-hidden-column="${col}"]`);
        return !!el?.hasAttribute("data-board-cell") && el.getAttribute("data-column") === col;
      }, c);
      // expect-webdriverio takes one argument, so the name goes in a throw.
      if (!droppable) throw new Error(`${c}: the rail strip does not answer the drop handler`);
    }

    // Archived is never hidden: it is the destructive drop and wants a fixed
    // home, empty or not.
    await waitVisible("[data-board-archive]");

    // Clicking a strip pins that column back open for this visit.
    const pin = emptyCols[0];
    await browser.execute((col) => {
      (document.querySelector(`[data-board-hidden-column="${col}"]`) as HTMLElement).click();
    }, pin);
    await waitVisible(`[data-board-cell][data-column="${pin}"]:not([data-board-hidden-column])`);
    await waitGone(`[data-board-hidden-column="${pin}"]`);
    await snap("board-hidden-columns.png");

    // Put it back, so the cases after this one see the fixture's own shape.
    await browser.execute((col) => {
      (document.querySelector(`[data-board-hide-column="${col}"]`) as HTMLElement).click();
    }, pin);
    await waitVisible(`[data-board-hidden-column="${pin}"]`);
  });

  // The card's third row: what the task produced, and where it is on the
  // forge. Both were invisible on the board before, which meant deciding
  // whether a task was worth opening required opening it.
  describe("the card's change summary and PR chip", () => {
    it("shows the churn once the task's worktree actually has changes", async () => {
      await clickByText("Kanban");
      await waitVisible('[data-testid="board-view"]');
      // No changes yet, so no churn: the row is absent rather than showing
      // zeros. A card that says "+0 -0 0 files" is noise on every new task.
      await waitVisible(CARD(t4));
      const before = await browser.execute(
        (id) => !!document.querySelector(`[data-board-task-id="${id}"] [data-testid="board-card-churn"]`),
        t4,
      );
      expect(before).toBe(false);

      // A real file in the real worktree, so this exercises the git path
      // rather than a store write. Three lines, one new file.
      const path = await browser.execute(
        (id) => window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.path ?? "",
        t4,
      ) as string;
      expect(path).toBeTruthy();
      writeFileSync(join(path, "churn-probe.txt"), "one\ntwo\nthree\n");

      try {
        // The measurement is demand-driven with a staleness floor, so drop
        // this task's entry and let the card ask again on its next render.
        await browser.execute((id) => {
          window.__termic!.useDiffStat.getState().invalidate(id);
        }, t4);
        await waitVisible(`${CARD(t4)} [data-testid="board-card-churn"]`);
        const text = await browser.execute(
          (id) => document.querySelector(
            `[data-board-task-id="${id}"] [data-testid="board-card-churn"]`,
          )?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          t4,
        );
        // +3 from the new file's three lines, and one file. The deletions
        // span is omitted entirely at zero rather than printed as "-0".
        expect(text).toContain("+3");
        expect(text).toContain("1 file");
        expect(text).not.toContain("-0");
        await snap("board-card-churn.png");
      } finally {
        execSync(`rm -f "${join(path, "churn-probe.txt")}"`);
      }
    });

    it("renders a PR chip that carries the state, and never opens the task", async () => {
      // The store is the seam here on purpose: a real PR would need a forge.
      // What is under test is the card, not the lookup.
      await browser.execute((id) => {
        window.__termic!.useApp.setState((s: any) => ({
          tasks: s.tasks.map((w: any) => w.id === id
            ? { ...w, pr_url: "https://github.com/acme/repo/pull/42", pr_number: 42, pr_provider: "github" }
            : w),
        }));
      }, t2);
      await waitVisible(`${CARD(t2)} [data-testid="board-card-pr"]`);
      const chip = await browser.execute((id) => {
        const el = document.querySelector(
          `[data-board-task-id="${id}"] [data-testid="board-card-pr"]`,
        ) as HTMLElement | null;
        return { text: el?.textContent?.trim() ?? "", state: el?.dataset.prState ?? "" };
      }, t2);
      expect(chip.text).toContain("#42");
      // No lookup has resolved, so it is an identity and not a state yet.
      expect(chip.state).toBe("unknown");

      // NOT clicked, deliberately, and this is the one rule to keep if this
      // case is ever extended. The chip opens the PR through `openPath`,
      // which on Linux is `xdg-open`: on a CI runner that reaches for a
      // browser through the desktop portal and does not come back. An earlier
      // version of this case did click it, passed on macOS where `open`
      // returns immediately, and on Linux hung the test, then the after-all
      // hook, then every spec that followed in that session.
      //
      // No spec in this suite clicks an opener-backed link, for that reason.
      // The chip's own guard (`stopPropagation`, so the card behind it does
      // not also activate) is therefore NOT covered here; covering it would
      // mean a seam to stub the opener, which does not exist yet.
      await snap("board-card-pr.png");
    });

    it("opens Delivery from the actionable CI status without a generic Delivery row", async () => {
      await browser.execute(id => {
        const store = window.__termic!.usePr;
        store.setState({ byTask: { ...store.getState().byTask, [id]: {
          lookup: { status: "ok", provider: "github", pr: { provider: "github", number: 42,
            url: "https://example.test/pull/42", state: "open", checks: "failing", review: "changes_requested",
            title: "Review fixture", base: "main", head: "topic" } },
          loading: false, fetchedAt: Date.now(),
        } } });
        const app = window.__termic!.useApp.getState();
        if (!app.rightPanelHidden) app.toggleRightPanel();
      }, t2);
      const selector = CARD(t2) + ' [data-testid="board-card-delivery"]';
      await waitVisible(selector);
      const text = await browser.execute(sel => document.querySelector(sel)?.textContent ?? "", selector);
      expect(text).toContain("CI");
      expect(text).not.toContain("Delivery");
      await browser.execute(sel => (document.querySelector(sel) as HTMLElement).click(), selector);
      await waitVisible('[data-testid="delivery-panel"]');
      // Put the suite back on its Board and keep later editor suites on Files.
      await browser.execute(() => (document.querySelector('[data-testid="right-tab"][data-tab="All files"]') as HTMLElement).click());
      await clickByText("Kanban");
      await waitVisible('[data-testid="board-view"]');
    });

    it("a wide PR chip and churn never make the column scroll sideways", async () => {
      // Shipped broken in 1.11.2: the chip and the churn were both shrink-0 on
      // one line, so "#18495 - checks failing" next to "+356 -21 12 files"
      // overflowed a 280px column and gave the whole lane a horizontal
      // scrollbar, with the file count clipped off the right edge. Reported
      // with a screenshot.
      //
      // The widest shape there is: a five-digit PR, a failing-checks note and
      // a seven-figure churn.
      await browser.execute((id) => {
        const t = window.__termic!;
        t.useApp.setState((s: any) => ({
          tasks: s.tasks.map((w: any) => w.id === id
            ? { ...w, pr_url: "https://github.com/acme/repo/pull/18495", pr_number: 18495, pr_provider: "github" }
            : w),
        }));
        t.usePr.setState((s: any) => ({
          byTask: {
            ...s.byTask,
            [id]: {
              lookup: {
                provider: "github", remote_url: "", status: "ok", message: "",
                pr: {
                  provider: "github", number: 18495, url: "https://github.com/acme/repo/pull/18495",
                  title: "x", state: "open", checks: "failing", review: "none",
                  base: "main", head: "topic",
                },
              },
              loading: false, fetchedAt: Date.now(),
            },
          },
        }));
        t.useDiffStat.setState((s: any) => ({
          byTask: {
            ...s.byTask,
            [id]: {
              stat: { files_changed: 11016, insertions: 1513884, deletions: 365272, untracked: 3 },
              loading: false, fetchedAt: Date.now(), error: null,
            },
          },
        }));
      }, t2);

      await waitVisible(`${CARD(t2)} [data-testid="board-card-churn"]`);
      const overflow = await browser.execute((id) => {
        const card = document.querySelector(`[data-board-task-id="${id}"]`) as HTMLElement;
        // The scrolling ancestor is the column's card list.
        const col = card.closest("[data-board-cell]") as HTMLElement;
        const list = [...col.querySelectorAll<HTMLElement>("div")]
          .find(d => d.scrollHeight > d.clientHeight || d.className.includes("overflow-y-auto")) ?? col;
        return {
          // The real symptom: content wider than the box it sits in.
          listOverflow: list.scrollWidth - list.clientWidth,
          colOverflow: col.scrollWidth - col.clientWidth,
          cardOverflow: card.scrollWidth - card.clientWidth,
        };
      }, t2);
      // Measured, not eyeballed: any positive value is a sideways scrollbar.
      expect(overflow.cardOverflow).toBeLessThanOrEqual(0);
      expect(overflow.listOverflow).toBeLessThanOrEqual(0);
      expect(overflow.colOverflow).toBeLessThanOrEqual(0);
      await snap("board-card-wide.png");
    });
  });

  // A pin is a SETTING. It was this view's state first, so leaving Kanban and
  // coming back silently undid it, which is what "they disappear again, quite
  // random" was: a lifetime tied to a mount you cannot see.
  it("a pinned column survives leaving the board, and only offers to hide while empty", async () => {
    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');
    const emptyCol = await browser.execute(() => {
      const el = document.querySelector("[data-board-hidden-column]");
      return el ? (el as HTMLElement).dataset.boardHiddenColumn ?? null : null;
    }) as string | null;
    if (!emptyCol) throw new Error("no empty column to pin: the fixture has changed shape");

    await browser.execute((col) => {
      (document.querySelector(`[data-board-hidden-column="${col}"]`) as HTMLElement).click();
    }, emptyCol);
    await waitVisible(`[data-board-cell][data-column="${emptyCol}"]:not([data-board-hidden-column])`);
    // Empty and pinned, so it carries the control that undoes the pin.
    await waitVisible(`[data-board-hide-column="${emptyCol}"]`);
    await snap("board-pinned-column.png");

    // The regression: leave the board entirely and come back.
    await ensureActiveTask(t1);
    await waitGone('[data-testid="board-view"]', 5_000);
    await clickByText("Kanban");
    await waitVisible('[data-testid="board-view"]');
    await waitVisible(`[data-board-cell][data-column="${emptyCol}"]:not([data-board-hidden-column])`);

    // It is stored, not just remembered in a closure: the pref is what the
    // next launch reads.
    const stored = await browser.execute(
      () => window.__termic!.usePrefs.getState().boardPinnedColumns,
    ) as string[];
    expect(stored).toContain(emptyCol);

    // A column holding cards must NOT offer to hide: the button would put
    // those cards out of sight, which is the one thing the board must not do.
    // backlog holds this spec's tasks.
    await waitVisible('[data-board-cell][data-column="backlog"]');
    const hideOnFull = await browser.execute(
      () => !!document.querySelector('[data-board-hide-column="backlog"]'),
    );
    expect(hideOnFull).toBe(false);

    // And the X puts it back, which is the other half of the pair.
    await browser.execute((col) => {
      (document.querySelector(`[data-board-hide-column="${col}"]`) as HTMLElement).click();
    }, emptyCol);
    await waitVisible(`[data-board-hidden-column="${emptyCol}"]`);
    const after = await browser.execute(
      () => window.__termic!.usePrefs.getState().boardPinnedColumns,
    ) as string[];
    expect(after).not.toContain(emptyCol);
  });
});
