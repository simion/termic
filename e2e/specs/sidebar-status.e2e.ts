// The sidebar's status section (docs/ui.md "The sidebar's status section"):
// the toggle in both of its places, bucket membership from the board's own
// derivation, the row identity rules the tree depends on, the click, the
// folds that persist, and the icon rail that does not carry it.
//
// Deterministic by construction, like board.e2e.ts: every task here is filed
// by a state the spec seeds on an IDLE agent (attention, a held PR lookup) or
// by having no tabs at all (Not started). The transient Working bucket is
// covered by src/lib/sidebarStatus.test.ts and the fan-out pins in
// src/store/selectorFanout.test.ts; racing the fake agent's sub-second busy
// window here would be the flaky version of the same assertion.

import {
  archiveTask,
  createWorktreeTask,
  dismissOverlays,
  ensureActiveTask,
  openTask,
  requireTermicApi,
  sidebarBadge,
  snap,
  textOf,
  typeIntoAgent,
  waitForAgentReady,
  waitForAppShell,
  waitForText,
  waitGone,
  waitVisible,
} from "../helpers.js";

const SECTION = '[data-testid="status-section"]';
const HEADER = '[data-testid="status-section-header"]';
const BUCKET = (b: string) => `${SECTION} [data-status-bucket="${b}"]`;
const BUCKET_HEADER = (b: string) => `${BUCKET(b)} [data-testid="status-bucket-header"]`;
const ROW = (id: string) => `${SECTION} [data-status-task-id="${id}"]`;
const ROW_IN = (b: string, id: string) => `${BUCKET(b)} [data-status-task-id="${id}"]`;
const TOGGLE_ROW = '[data-testid="sidebar-toggle-status-section"]';
const SETTINGS_LABEL = "Status section";

const present = (sel: string) => browser.execute(s => !!document.querySelector(s), sel);

const ariaExpanded = (sel: string) =>
  browser.execute(s => document.querySelector(s)?.getAttribute("aria-expanded") ?? null, sel);

const click = (sel: string) =>
  browser.execute(s => (document.querySelector(s) as HTMLElement).click(), sel);

/** Task ids one bucket lists, in DOM order. */
const bucketIds = (b: string) =>
  browser.execute(
    sel => [...document.querySelectorAll<HTMLElement>(`${sel} [data-status-task-id]`)]
      .map(el => el.dataset.statusTaskId as string),
    BUCKET(b),
  );

/** Open or fold one bucket through its header, a real click. */
async function setBucketOpen(b: string, open: boolean): Promise<void> {
  await waitVisible(BUCKET_HEADER(b));
  if ((await ariaExpanded(BUCKET_HEADER(b))) !== String(open)) await click(BUCKET_HEADER(b));
  await browser.waitUntil(async () => (await ariaExpanded(BUCKET_HEADER(b))) === String(open), {
    timeout: 5_000, timeoutMsg: `bucket ${b} never became ${open ? "open" : "folded"}`,
  });
}

/** The Project list options menu. Radix opens on pointerdown, so a bare
 *  .click() is not enough (same as projects.e2e.ts's openMenu). */
async function openListOptions(): Promise<void> {
  await waitVisible('[data-testid="sidebar-list-options"]');
  await browser.execute(() => {
    const el = document.querySelector('[data-testid="sidebar-list-options"]') as HTMLElement;
    const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.click();
  });
  await waitVisible(TOGGLE_ROW);
}

/** The value a profile-scoped localStorage key holds, whatever the scope
 *  prefix is in this run. */
const stored = (key: string) =>
  browser.execute(k => {
    const hit = Object.keys(localStorage).find(x => x === k || x.endsWith(`:${k}`));
    return hit ? localStorage.getItem(hit) : null;
  }, key);

/** The switch in the settings row whose label matches exactly (the
 *  settings.e2e.ts helpers, which are local to that file). */
const settingsSwitch = (label: string, act: "read" | "click") =>
  browser.execute((lbl, a) => {
    const labelEl = [...document.querySelectorAll("div")].find(d => d.textContent?.trim() === lbl);
    const sw = labelEl?.closest(".justify-between")?.querySelector('[role="switch"]') as HTMLElement | null;
    if (!sw) throw new Error("toggle switch not found for: " + lbl);
    if (a === "click") sw.click();
    return sw.getAttribute("aria-checked");
  }, label, act);

describe("sidebar status section", () => {
  let projectId = "";
  let fresh = "";
  let blocked = "";
  let reviewed = "";
  let groupLead = "";
  let groupMember = "";
  let multi = "";
  let hoverRevealWas = false;

  /** Every pref this spec touches, back to the shipped defaults. */
  const resetPrefs = () =>
    browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setShowStatusSection(false);
      const defaults = [["attention", false], ["working", false], ["review", false], ["settled", true], ["backlog", true]] as const;
      for (const [b, c] of defaults) p.setStatusBucketCollapsed(b, c);
    });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await resetPrefs();
    hoverRevealWas = await browser.execute(() => window.__termic!.usePrefs.getState().sidebarHoverReveal);
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id as string);
  });

  after(async () => {
    await browser.execute((was) => {
      const t = window.__termic!;
      if (t.useApp.getState().compactSidebar) t.useApp.getState().toggleCompactSidebar();
      t.usePrefs.getState().setSidebarHoverReveal(was);
      t.useApp.getState().closeSettings();
    }, hoverRevealWas);
    await resetPrefs();
    for (const id of [fresh, blocked, reviewed, groupLead, groupMember, multi]) if (id) await archiveTask(id);
  });

  it("is off by default, and the list options menu turns it on above PROJECTS", async () => {
    expect(await present(SECTION)).toBe(false);

    await openListOptions();
    await click(TOGGLE_ROW);
    await waitVisible(SECTION);

    // The header is a label like PROJECTS, not a fold: the switch is how the
    // section goes away.
    const header = await browser.execute(sel => {
      const el = document.querySelector(sel) as HTMLElement;
      // textContent, not innerText: the capitals are CSS, not the string.
      return { tag: el.tagName, expandable: el.hasAttribute("aria-expanded"), text: el.textContent?.trim() };
    }, HEADER);
    expect(header).toEqual({ tag: "DIV", expandable: false, text: "Status" });
    // Above the PROJECTS header (which holds the Add project button), in
    // document order.
    const above = await browser.execute(sec => {
      const s = document.querySelector(sec)!;
      const projects = document.querySelector('[data-testid="sidebar-add-project"]')!;
      return !!(s.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING);
    }, SECTION);
    expect(above).toBe(true);
    expect(await stored("showStatusSection")).toBe("1");
  });

  it("files tasks nobody has opened under Not started, behind a count, in tree order", async () => {
    // Created, never visited: no tabs at all, so no work evidence.
    fresh = await openTask("status-fresh", false);
    blocked = await openTask("status-blocked", false);
    await browser.execute(pid => window.__termic!.useApp.getState().setProjectCollapsed(pid, false), projectId);
    await waitVisible(BUCKET("backlog"));

    // Count-only: folded, listing no rows, yet counting them.
    expect(await ariaExpanded(BUCKET_HEADER("backlog"))).toBe("false");
    expect(await present(ROW(fresh))).toBe(false);
    const count = Number(await textOf(`${BUCKET("backlog")} [data-testid="status-bucket-count"]`));
    expect(count).toBeGreaterThanOrEqual(2);

    await setBucketOpen("backlog", true);
    await waitVisible(ROW_IN("backlog", fresh));
    const listed = await bucketIds("backlog");
    // The count is the rows it unfolds into.
    expect(listed.length).toBe(count);
    // Same relative order as the tree: a row never shuffles inside a bucket.
    const tree = await browser.execute(
      () => [...document.querySelectorAll<HTMLElement>("[data-sidebar-task-id]")].map(el => el.dataset.sidebarTaskId as string));
    const inTree = (id: string) => tree.indexOf(id);
    const inBucket = (id: string) => listed.indexOf(id);
    expect(inTree(fresh)).toBeGreaterThanOrEqual(0);
    expect(inTree(blocked)).toBeGreaterThanOrEqual(0);
    expect(inBucket(fresh) < inBucket(blocked)).toBe(inTree(fresh) < inTree(blocked));

    // Identity: the copy carries none of the tree's row attributes, so the
    // drag hit tests, the spawn-link overlay and every `[data-sidebar-task-id]`
    // helper still find exactly one row per task.
    const ident = await browser.execute(id => {
      const row = document.querySelector(`[data-status-task-id="${id}"]`) as HTMLElement;
      return {
        treeRows: document.querySelectorAll(`[data-sidebar-task-id="${id}"]`).length,
        sidebarAttrs: row.getAttributeNames().filter(n => n.startsWith("data-sidebar")),
        insideTreeRow: !!row.closest("[data-sidebar-task-row]"),
      };
    }, fresh);
    expect(ident).toEqual({ treeRows: 1, sidebarAttrs: [], insideTreeRow: false });
  });

  it("lists a blocked agent under Needs attention with its bell, and the tree keeps its own", async () => {
    // A task has tabs only once something mounts it; visit it, let the fake
    // agent settle into its idle title, then step away so the seed lands on
    // a task the user is not looking at.
    await ensureActiveTask(blocked);
    await waitForAgentReady(blocked);
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));

    // SETUP, not the assertion: the tab state the detector would write.
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.markAttention(id, tab.id, "attention", "needs you");
    }, blocked);

    const bell = `${ROW_IN("attention", blocked)} [data-testid="status-work-badge"][data-work-state="attention"]`;
    await waitVisible(bell);
    // Needs attention is a listed bucket: open without being asked.
    expect(await ariaExpanded(BUCKET_HEADER("attention"))).toBe("true");
    expect(await present(ROW_IN("backlog", blocked))).toBe(false);
    // The tree's own badge is untouched, and the copy adds no `work-badge`.
    expect(await sidebarBadge(blocked)).toBe("attention");
    expect(await present(`${ROW(blocked)} [data-testid="work-badge"]`)).toBe(false);
    await snap("sidebar-status-attention.png");
  });

  it("a click opens the task and reveals it in the tree; the row leaves Needs attention only when you answer", async () => {
    // Fold the project first, so the reveal is something the click has to do.
    await browser.execute(pid => window.__termic!.useApp.getState().setProjectCollapsed(pid, true), projectId);
    await waitGone(`[data-sidebar-task-id="${blocked}"]`);

    await click(ROW(blocked));
    await browser.waitUntil(
      () => browser.execute(id => document.querySelector("header[data-active-task]")?.getAttribute("data-active-task") === id, blocked),
      { timeout: 8_000, timeoutMsg: "the status row's click never opened its task" },
    );
    await waitVisible(`[data-sidebar-task-id="${blocked}"]`);

    // Opening a task is not answering it: the agent is still blocked, so
    // the row stays under Needs attention (`unreadClearsOnSight`). Measured,
    // not looked at: the active mark, and the background it paints.
    //
    // The background is read with the row's colour transition switched off.
    // Measured in this window: with it running, the background sat at its
    // start value (alpha 0, then 0.016) while data-active was already true,
    // because `document.timeline.currentTime`, the clock CSS transitions run
    // on, moved 13 ms in about 1.5 s of wall time: the window was painting no
    // frames. One class change, one transition, never restarted. With
    // `transition: none` the same element reads the selection colour, so the
    // transition's end state is what is asserted.
    await browser.waitUntil(
      () => browser.execute(sel => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el?.dataset.active !== "true") return false;
        const was = el.style.transition;
        el.style.transition = "none";
        const bg = getComputedStyle(el).backgroundColor;
        el.style.transition = was;
        return bg !== "rgba(0, 0, 0, 0)" && !/, 0\)$/.test(bg);
      }, ROW_IN("attention", blocked)),
      { timeout: 5_000 },
    ).catch(async () => {
      const why = await browser.execute(id => {
        const t = (window.__termic!.useApp.getState().tabs[id] ?? []).find((x: any) => x.type === "terminal");
        const row = document.querySelector(`[data-status-task-id="${id}"]`) as HTMLElement | null;
        return JSON.stringify({
          unread: t?.unread ?? null, workState: t?.workState ?? null,
          bucket: row?.closest("[data-status-bucket]")?.getAttribute("data-status-bucket") ?? null,
          active: row?.dataset.active ?? null,
        });
      }, blocked);
      throw new Error(`the status row never painted itself active under Needs attention: ${why}`);
    });
    // And no other status row claims it.
    const actives = await browser.execute(
      sec => [...document.querySelectorAll<HTMLElement>(`${sec} [data-active]`)].map(el => el.dataset.statusTaskId),
      SECTION,
    );
    expect(actives).toEqual([blocked]);

    // Answering it is a key in that terminal. With no other work evidence
    // (the seed was the only one) the board's rule files it under Not started.
    await typeIntoAgent(blocked, "1");
    await waitGone(ROW_IN("attention", blocked));
    await waitVisible(ROW_IN("backlog", blocked));
    await typeIntoAgent(blocked, "\x7f");
  });

  it("remembers each bucket's fold", async () => {
    // Clicking the header does nothing: it is a label.
    await click(HEADER);
    expect(await present(BUCKET_HEADER("backlog"))).toBe(true);

    // A bucket's fold is stored as an override of its default. Not started
    // was opened earlier; folding it again writes that back.
    expect(await ariaExpanded(BUCKET_HEADER("backlog"))).toBe("true");
    expect(JSON.parse((await stored("statusBucketCollapsed")) ?? "{}").backlog).toBe(false);
    await setBucketOpen("backlog", false);
    expect(JSON.parse((await stored("statusBucketCollapsed")) ?? "{}").backlog).toBe(true);
    // Turning the section off and on keeps the fold: it is a pref, not
    // component state.
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(false));
    await waitGone(SECTION);
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(true));
    await waitVisible(BUCKET_HEADER("backlog"));
    expect(await ariaExpanded(BUCKET_HEADER("backlog"))).toBe("false");
    // And a listed bucket folds too. Re-seed the bell (SETUP), which the
    // answer in the case above cleared. On the task you are looking at, which
    // is where a bell used to vanish on sight.
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.markAttention(id, tab.id, "attention", "needs you");
    }, blocked);
    await waitVisible(ROW_IN("attention", blocked));
    await setBucketOpen("attention", false);
    expect(await present(ROW(blocked))).toBe(false);
    await setBucketOpen("attention", true);
    await waitVisible(ROW_IN("attention", blocked));
  });

  it("puts a task with an open PR in review, and a merge takes it out", async () => {
    reviewed = await createWorktreeTask("status-review", "status-review-branch", false);
    // The identity Rust persists once a lookup finds a PR, patched into the
    // store the way store/pr.ts's refresh writes it back. SETUP: the poller
    // cannot find a PR on the fixture's local remote.
    await browser.execute(id => {
      window.__termic!.useApp.setState((st: any) => ({
        tasks: st.tasks.map((t: any) => t.id === id
          ? { ...t, pr_number: 77, pr_provider: "github", pr_url: "https://github.com/acme/widgets/pull/77" }
          : t),
      }));
    }, reviewed);
    const lookup = (state: string) => ({
      provider: "github",
      remote_url: "https://github.com/acme/widgets.git",
      status: "ok",
      message: "",
      pr: {
        provider: "github", number: 77, url: "https://github.com/acme/widgets/pull/77",
        title: "Teach the parser about trailing commas", state, checks: "passing", review: "none",
        base: "main", head: "status-review-branch",
      },
    });
    /** Hold a lookup in place until the DOM agrees: a real poll of this task
     *  can land between the seed and the read and replace it. */
    const holdUntil = (state: string, done: () => Promise<boolean>, msg: string) =>
      browser.waitUntil(async () => {
        await browser.execute((id, lk) => {
          window.__termic!.usePr.setState((s: any) => ({
            byTask: { ...s.byTask, [id]: { lookup: lk, loading: false, fetchedAt: Date.now() } },
          }));
        }, reviewed, lookup(state));
        return done();
      }, { timeout: 15_000, timeoutMsg: msg });

    const chip = `${ROW_IN("review", reviewed)} [data-testid="status-pr-badge"][data-pr-state="open"]`;
    await holdUntil("open", () => present(chip), "the task never showed under In review with an open PR chip");
    // The tree's chip keeps its testid and stays the first in the document,
    // so the specs that query `task-pr-badge` bare still read the tree's.
    expect(await present(`${ROW(reviewed)} [data-testid="task-pr-badge"]`)).toBe(false);
    expect(await browser.execute(() =>
      !document.querySelector('[data-testid="task-pr-badge"]')?.closest("[data-status-task-id]"))).toBe(true);

    // Merged falls through, here to Not started: nothing has run in it.
    await holdUntil("merged", async () =>
      !(await present(ROW_IN("review", reviewed))) && (await present(BUCKET("backlog"))),
    "a merged PR never left In review");
    await setBucketOpen("backlog", true);
    await waitVisible(ROW_IN("backlog", reviewed));
  });

  it("keeps a task group whole, in its colour, under its most urgent member's bucket", async () => {
    groupLead = await openTask("status-group-lead", false);
    groupMember = await openTask("status-group-member", false);
    // SETUP through the app's own IPC: the lead founds a group, the member
    // joins it, the way the task menu's Move to group does.
    const groupId = await browser.execute(async (a, b) => {
      const t = window.__termic!;
      await t.invoke("task_group_new", { taskId: a, color: "teal" });
      await t.invoke("task_group_join", { taskId: b, targetId: a, color: null });
      await t.useApp.getState().loadAll();
      return t.useApp.getState().tasks.find((w: any) => w.id === a).group.id as string;
    }, groupLead, groupMember);
    const BLOCK = (bucket: string) => `${BUCKET(bucket)} [data-status-group-id="${groupId}"]`;

    // Both untouched, so the whole group is one unit under Not started.
    await setBucketOpen("backlog", true);
    await waitVisible(BLOCK("backlog"));

    // The member's agent asks something (SETUP on a background task): the
    // group moves as a unit, the untouched lead with it.
    await ensureActiveTask(groupMember);
    await waitForAgentReady(groupMember);
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));
    await browser.execute(id => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      app.markAttention(id, tab.id, "attention", "needs you");
    }, groupMember);
    await waitVisible(BLOCK("attention"));
    expect(await present(BLOCK("backlog"))).toBe(false);

    const shape = await browser.execute((sel, gid, lead, member) => {
      const block = document.querySelector(sel) as HTMLElement;
      const caption = block.querySelector('[data-testid="status-group-caption"]') as HTMLElement;
      const rail = block.querySelector("[data-status-group-rail]") as HTMLElement;
      const tree = document.querySelector(`[data-testid="task-group-header-${gid}"]`) as HTMLElement | null;
      const bucket = block.closest("[data-status-bucket]") as HTMLElement;
      return {
        members: [...block.querySelectorAll<HTMLElement>("[data-status-task-id]")].map(el => el.dataset.statusTaskId),
        // Only the member that asked carries the bell; the lead rides along.
        bells: [lead, member].map(id =>
          !!block.querySelector(`[data-status-task-id="${id}"] [data-testid="status-work-badge"][data-work-state="attention"]`)),
        caption: getComputedStyle(caption).color,
        rail: getComputedStyle(rail).borderLeftColor,
        treeCaption: tree ? getComputedStyle(tree).color : null,
        // Identity: the tree's group block is still the only one the task
        // drag can hit-test.
        treeBlocks: document.querySelectorAll(`[data-task-group-id="${gid}"]`).length,
        copyHasTreeAttr: !!block.querySelector("[data-task-group-id]") || block.hasAttribute("data-task-group-id"),
        count: Number(bucket.querySelector('[data-testid="status-bucket-count"]')?.textContent),
        rows: bucket.querySelectorAll("[data-status-task-id]").length,
      };
    }, BLOCK("attention"), groupId, groupLead, groupMember);
    expect(shape.members).toEqual([groupLead, groupMember]);
    expect(shape.bells).toEqual([false, true]);
    // The group's own colour, measured: the caption and the rail agree, and
    // match the tree's caption for the same group.
    expect(shape.caption).toBe(shape.rail);
    expect(shape.caption).toBe(shape.treeCaption);
    expect(shape.treeBlocks).toBe(1);
    expect(shape.copyHasTreeAttr).toBe(false);
    // A bucket counts task rows, group members included.
    expect(shape.count).toBe(shape.rows);
    await snap("sidebar-status-group.png");

    // It folds the tree's way: the members go behind the caption, which then
    // carries their marks (the bell) and the count. Its own fold state, so
    // the tree's block for the same group keeps its members on screen.
    const CAPTION = `${BLOCK("attention")} [data-testid="status-group-caption"]`;
    const treeMembers = () => browser.execute(gid =>
      document.querySelectorAll(`[data-task-group-id="${gid}"] [data-sidebar-task-id]`).length, groupId);
    const treeBefore = await treeMembers();
    expect(await ariaExpanded(CAPTION)).toBe("true");
    await click(CAPTION);
    await browser.waitUntil(async () => (await ariaExpanded(CAPTION)) === "false",
      { timeout: 5_000, timeoutMsg: "the group caption never folded" });
    const folded = await browser.execute(sel => {
      const block = document.querySelector(sel) as HTMLElement;
      return {
        rows: block.querySelectorAll("[data-status-task-id]").length,
        bell: !!block.querySelector('[data-testid="status-group-marks"] [data-testid="status-work-badge"][data-work-state="attention"]'),
        count: block.querySelector('[data-testid="status-group-marks"] [data-testid="status-group-count"]')?.textContent,
      };
    }, BLOCK("attention"));
    expect(folded).toEqual({ rows: 0, bell: true, count: "2" });
    expect(await treeMembers()).toBe(treeBefore);
    expect(JSON.parse((await stored("statusGroupCollapsed")) ?? "{}")[groupId]).toBe(true);
    await click(CAPTION);
    await browser.waitUntil(async () => (await ariaExpanded(CAPTION)) === "true",
      { timeout: 5_000, timeoutMsg: "the group caption never unfolded" });

    // Answered: the member has no other work evidence, so the group goes
    // back to Not started, whole.
    await ensureActiveTask(groupMember);
    await typeIntoAgent(groupMember, "1");
    await waitGone(BLOCK("attention"));
    await waitVisible(BLOCK("backlog"));
    await typeIntoAgent(groupMember, "\x7f");
  });

  it("a row running two agents expands to both, the tree's way, without opening the tree's row", async () => {
    multi = await openTask("status-multi", false);
    await ensureActiveTask(multi);
    await waitForAgentReady(multi);
    // SETUP: a second agent in the same task, the way the tab strip's + adds
    // one. A different agent, so the rows can say which is which.
    const second = await browser.execute(t => {
      const tab = { id: crypto.randomUUID(), type: "terminal", cli: "fakecapture", title: "second" };
      window.__termic!.useApp.getState().addTab(t, tab as never);
      return tab.id;
    }, multi);
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));
    await setBucketOpen("backlog", true);

    const WRAP = `${SECTION} [data-status-task-row="${multi}"]`;
    const TOGGLE = `${WRAP} [data-testid="status-task-toggle"]`;
    const CHILD = `${WRAP} [data-status-tab-id]`;
    // Collapsed: the tree's `(2)`, and no children.
    await waitVisible(`${WRAP} [data-testid="status-task-count"]`);
    expect(await textOf(`${WRAP} [data-testid="status-task-count"]`)).toBe("(2)");
    expect(await ariaExpanded(TOGGLE)).toBe("false");
    expect(await present(CHILD)).toBe(false);

    // The tree's row for the same task, measured before and after: its own
    // collapse state, untouched by this one.
    const treeRows = () => browser.execute(
      id => document.querySelector(`[data-sidebar-task-row="${id}"]`)?.children.length ?? -1, multi);
    const treeBefore = await treeRows();

    await click(TOGGLE);
    await browser.waitUntil(async () => (await browser.execute(
      sel => document.querySelectorAll(sel).length, CHILD)) === 2,
    { timeout: 5_000, timeoutMsg: "the expanded row never listed both agent tabs" });
    // Each child is its own agent, in tab order.
    expect(await browser.execute(
      sel => [...document.querySelectorAll<HTMLElement>(sel)].map(el => el.dataset.cli), CHILD))
      .toEqual(["fakeagent", "fakecapture"]);
    expect(await treeRows()).toBe(treeBefore);

    // A child opens ITS tab, and then carries the selection instead of the
    // task's row.
    await click(`${WRAP} [data-status-tab-id="${second}"]`);
    await browser.waitUntil(() => browser.execute((id, tab) => {
      const s = window.__termic!.useApp.getState();
      return s.activeTaskId === id && s.activeTab[id] === tab;
    }, multi, second), { timeout: 8_000, timeoutMsg: "clicking the child did not open its tab" });
    await browser.waitUntil(() => browser.execute((wrap, tab, id) =>
      document.querySelector(`${wrap} [data-status-tab-id="${tab}"]`)?.getAttribute("data-active") === "true"
        && !document.querySelector(`${wrap} [data-status-task-id="${id}"]`)?.hasAttribute("data-active"),
    WRAP, second, multi), { timeout: 5_000, timeoutMsg: "the selection did not move to the child row" });

    // Remembered, as a pref: off and on again, still expanded.
    expect(JSON.parse((await stored("statusTaskExpanded")) ?? "{}")[multi]).toBe(true);
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(false));
    await waitGone(SECTION);
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(true));
    await waitVisible(`${WRAP} [data-status-tab-id="${second}"]`);
    await snap("sidebar-status-expanded.png");
  });

  it("Settings > Appearance > Sidebar writes the same switch", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("appearance"));
    await waitVisible('[data-appearance-tab="interface"]');
    await click('[data-appearance-tab="interface"]');
    await waitForText(SETTINGS_LABEL);
    expect(await settingsSwitch(SETTINGS_LABEL, "read")).toBe("true");

    await settingsSwitch(SETTINGS_LABEL, "click");
    await waitGone(SECTION);
    expect(await stored("showStatusSection")).toBe("0");
    await settingsSwitch(SETTINGS_LABEL, "click");
    await waitVisible(SECTION);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());

    // The menu row agrees: it shows the check, and turns the section off.
    await openListOptions();
    expect(await present(`${TOGGLE_ROW} svg`)).toBe(true);
    await click(TOGGLE_ROW);
    await waitGone(SECTION);
    await openListOptions();
    expect(await present(`${TOGGLE_ROW} svg`)).toBe(false);
    await click(TOGGLE_ROW);
    await waitVisible(SECTION);
  });

  it("the icon rail does not carry it, and the hover overlay does", async () => {
    await browser.execute(() => {
      const t = window.__termic!;
      t.usePrefs.getState().setSidebarHoverReveal(false);
      if (!t.useApp.getState().compactSidebar) t.useApp.getState().toggleCompactSidebar();
    });
    // Rail only: nothing renders it.
    await waitGone(SECTION);

    // With hover reveal the full sidebar is kept mounted, off screen, over
    // the rail. It carries the section; the rail still does not.
    await browser.execute(() => window.__termic!.usePrefs.getState().setSidebarHoverReveal(true));
    // Present, not visible: the retracted overlay sits translated off screen.
    await browser.waitUntil(() => present(SECTION), {
      timeout: 5_000, timeoutMsg: "the hover overlay never mounted the status section",
    });
    const where = await browser.execute(sec =>
      [...document.querySelectorAll(sec)].map(s => !!s.closest("[aria-hidden]")), SECTION);
    expect(where).toEqual([true]);

    await browser.execute(() => window.__termic!.useApp.getState().toggleCompactSidebar());
    await browser.waitUntil(
      () => browser.execute(sec => document.querySelectorAll(sec).length === 1
        && !document.querySelector(sec)!.closest("[aria-hidden]"), SECTION),
      { timeout: 5_000, timeoutMsg: "the full sidebar did not get its status section back" },
    );
  });
});
