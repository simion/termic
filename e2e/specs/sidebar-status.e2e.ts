// The sidebar's status section (docs/ui.md "The sidebar's status section"):
// the toggle in both of its places, bucket membership from the board's own
// derivation, the bucket marks in the board's colours, the row identity rules
// the tree depends on, the click, the folds that persist, and the icon rail
// that does not carry it. Alongside it, two things the tree's rows share with
// the section's: a folded project or folder carrying its hidden rows' marks,
// and a branch label drawn with its leading path faint.
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

/** The colour a theme token resolves to in this window, measured on a probe of
 *  our own so it compares in getComputedStyle's own format. */
const tokenColor = (token: string) =>
  browser.execute(tk => {
    const probe = document.createElement("span");
    probe.style.color = `var(${tk})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);

/** What a bucket header's mark and count actually render. */
const bucketMark = (b: string) =>
  browser.execute(sel => {
    const mark = document.querySelector(`${sel} [data-testid="status-bucket-mark"]`) as HTMLElement | null;
    const count = document.querySelector(`${sel} [data-testid="status-bucket-count"]`) as HTMLElement | null;
    if (!mark || !count) return null;
    const glyph = mark.querySelector("svg")?.getAttribute("class")?.match(/lucide-([a-z-]+)/)?.[1]
      ?? (mark.querySelector("svg") ? "svg" : "dot");
    return {
      bucket: mark.dataset.bucket ?? null,
      glyph,
      color: getComputedStyle(mark).color,
      hidden: mark.getAttribute("aria-hidden"),
      tint: getComputedStyle(count).backgroundColor,
    };
  }, BUCKET_HEADER(b));

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

/** The View options menu. Radix opens on pointerdown, so a bare
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

/** Flip the menu's Status section switch. A setting row keeps the menu open
 *  (so several can be flipped in one visit), so close it after, as a user
 *  would, before driving the tree. */
async function toggleStatusRow(): Promise<void> {
  await click(TOGGLE_ROW);
  await browser.keys("Escape");
  await waitGone(TOGGLE_ROW);
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
  let labelled = "";
  let folderName = "";
  let widthWas = 0;
  let hoverRevealWas = false;

  /** Every pref this spec touches, back to the shipped defaults. */
  const resetPrefs = () =>
    browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setShowStatusSection(false);
      p.setUseBranchAsTaskName(false);
      p.setStatusSectionCollapsed(false);
      const defaults = [["attention", false], ["working", false], ["review", false], ["settled", true], ["backlog", true]] as const;
      for (const [b, c] of defaults) p.setStatusBucketCollapsed(b, c);
    });

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await resetPrefs();
    hoverRevealWas = await browser.execute(() => window.__termic!.usePrefs.getState().sidebarHoverReveal);
    widthWas = await browser.execute(() => window.__termic!.useApp.getState().sidebarWidth as number);
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
    await browser.execute(async (pid, folder, w) => {
      const t = window.__termic!;
      t.useApp.getState().setSidebarWidth(w);
      if (folder) {
        t.useApp.getState().setGroupCollapsed(folder, false);
        await t.ipc.projectSetGroup([pid], null);
        await t.useApp.getState().loadAll();
      }
    }, projectId, folderName, widthWas);
    await resetPrefs();
    for (const id of [fresh, blocked, reviewed, groupLead, groupMember, multi, labelled]) if (id) await archiveTask(id);
  });

  it("is off by default, and the list options menu turns it on above PROJECTS", async () => {
    expect(await present(SECTION)).toBe(false);

    await openListOptions();
    await toggleStatusRow();
    await waitVisible(SECTION);

    // The header is a highlighted section bar with an expand/collapse toggle.
    const header = await browser.execute(sel => {
      const el = document.querySelector(sel) as HTMLElement;
      // textContent, not innerText: the capitals are CSS, not the string.
      return { tag: el.tagName, expandable: el.hasAttribute("aria-expanded"), text: el.textContent?.trim() };
    }, HEADER);
    expect(header.tag).toBe("DIV");
    expect(header.expandable).toBe(true);
    expect(header.text).toMatch(/^Status/);
    expect(await present('[data-testid="sidebar-section-divider"]')).toBe(true);
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

  it("takes the status chips' place: never both, and turning it off brings them back", async () => {
    const CHIPS = '[data-testid="status-chips"]';
    // On, with a task needing you: the section lists it and no chip counts it.
    await waitVisible(ROW_IN("attention", blocked));
    expect(await present(CHIPS)).toBe(false);

    await openListOptions();
    await toggleStatusRow();
    await waitVisible(`${CHIPS} [data-status-chip="attention"]`);
    expect(await present(SECTION)).toBe(false);

    await openListOptions();
    await toggleStatusRow();
    await waitVisible(SECTION);
    expect(await present(CHIPS)).toBe(false);
  });

  it("marks each bucket with its rows' glyph in the status chips' colour, and tints its count", async () => {
    // Needs attention and Not started are both on screen here. The colours
    // are STATUS_MARK_COLOR, the map the chips draw from too, measured
    // against the tokens rather than looked at.
    const attention = await bucketMark("attention");
    const backlog = await bucketMark("backlog");
    expect(attention).toMatchObject({
      bucket: "attention", glyph: "bell", hidden: "true", color: await tokenColor("--color-warn"),
    });
    expect(backlog).toMatchObject({
      bucket: "backlog", glyph: "moon", hidden: "true", color: await tokenColor("--color-fg-faint"),
    });
    // Each count wears its own bucket's tint, and a visible one.
    expect(attention!.tint).not.toBe(backlog!.tint);
    expect(attention!.tint).not.toBe("rgba(0, 0, 0, 0)");
    // The label still says which bucket it is: the mark is decoration.
    expect(await textOf(BUCKET_HEADER("attention"))).toMatch(/^Needs attention/);

    // The chips, which take the section's place while it is off, draw the
    // same bucket in the same colour.
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(false));
    const chipIcon = '[data-testid="status-chips"] [data-status-chip="attention"] svg';
    await waitVisible(chipIcon);
    expect(await browser.execute(sel => getComputedStyle(document.querySelector(sel)!).color, chipIcon))
      .toBe(attention!.color);
    await browser.execute(() => window.__termic!.usePrefs.getState().setShowStatusSection(true));
    await waitVisible(SECTION);
  });

  it("a folded project or folder carries its hidden rows' marks, and drops them open", async () => {
    // `blocked` still holds the bell from the cases above.
    const header = `[data-project-id="${projectId}"]`;
    const marks = `${header} [data-testid="project-marks"]`;
    const bell = '[data-testid="rollup-work-badge"][data-work-state="attention"]';
    await browser.execute(pid => window.__termic!.useApp.getState().setProjectCollapsed(pid, true), projectId);
    await waitGone(`[data-sidebar-task-id="${blocked}"]`);
    await waitVisible(`${marks} ${bell}`);
    expect(await browser.execute(sel =>
      (document.querySelector(sel) as HTMLElement).dataset.kinds?.split(",").includes("attention"), marks)).toBe(true);
    // Under its own testid: a folded header must not add a `work-badge` that
    // a bare query would find before any row's.
    expect(await present(`${header} [data-testid="work-badge"]`)).toBe(false);
    await snap("sidebar-project-marks.png");

    // Open, the rows carry their own badges and the header none.
    await browser.execute(pid => window.__termic!.useApp.getState().setProjectCollapsed(pid, false), projectId);
    await waitVisible(`[data-sidebar-task-id="${blocked}"]`);
    await waitGone(marks);

    // Inside a folder, the folder's header takes them over when it folds.
    folderName = await browser.execute(async pid => {
      const t = window.__termic!;
      await t.ipc.projectSetGroup([pid], "E2E-STATUS");
      await t.useApp.getState().loadAll();
      return t.useApp.getState().projects.find((p: any) => p.id === pid).group as string;
    }, projectId);
    const folder = `[data-group-name="${folderName}"]`;
    const folderMarks = `${folder} [data-testid="folder-marks"]`;
    await waitVisible(folder);
    expect(await present(folderMarks)).toBe(false);
    await browser.execute(g => window.__termic!.useApp.getState().setGroupCollapsed(g, true), folderName);
    await waitGone(header);
    await waitVisible(`${folderMarks} ${bell}`);
    expect(await present(`${folder} [data-testid="work-badge"]`)).toBe(false);
    await snap("sidebar-folder-marks.png");
    await browser.execute(g => window.__termic!.useApp.getState().setGroupCollapsed(g, false), folderName);
    await waitVisible(header);
    await waitGone(folderMarks);

    await browser.execute(async pid => {
      const t = window.__termic!;
      await t.ipc.projectSetGroup([pid], null);
      await t.useApp.getState().loadAll();
    }, projectId);
    await waitGone(folder);
    folderName = "";
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

  it("collapses and expands the status section, and remembers each bucket's fold", async () => {
    // Clicking the header collapses the section in place.
    expect(await ariaExpanded(HEADER)).toBe("true");
    expect(await present(BUCKET_HEADER("backlog"))).toBe(true);
    await snap("sidebar-sections-expanded.png");
    await click(HEADER);
    expect(await ariaExpanded(HEADER)).toBe("false");
    expect(await present(BUCKET_HEADER("backlog"))).toBe(false);
    expect(await stored("statusSectionCollapsed")).toBe("1");
    await snap("sidebar-status-collapsed.png");

    // Clicking again expands it back.
    await click(HEADER);
    expect(await ariaExpanded(HEADER)).toBe("true");
    expect(await present(BUCKET_HEADER("backlog"))).toBe(true);
    expect(await stored("statusSectionCollapsed")).toBe("0");

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

    // Collapsing the section while a task needs attention shows its rollup mark on the header.
    await click(HEADER);
    expect(await ariaExpanded(HEADER)).toBe("false");
    expect(await present('[data-testid="status-section-marks"]')).toBe(true);
    await click(HEADER);
    expect(await ariaExpanded(HEADER)).toBe("true");
  });

  it("the projects header is a label, and the tree stays while status folds", async () => {
    // PROJECTS does not fold: it is the tree itself, and a click on its
    // header is a click on a label. STATUS above it still does.
    const projHeader = '[data-testid="projects-section-header"]';
    await waitVisible(projHeader);
    // Not `[aria-expanded]`: the list-options menu button in the same header
    // carries one of its own.
    expect(await present(`${projHeader} [role="button"]`)).toBe(false);
    // Compared with what was there, not with null: a machine that ran the
    // suite while PROJECTS still folded keeps that old key in localStorage.
    const before = await stored("projectsSectionCollapsed");
    await click(projHeader);
    expect(await present(`[data-project-id="${projectId}"]`)).toBe(true);
    expect(await stored("projectsSectionCollapsed")).toBe(before);

    await click(HEADER);
    expect(await ariaExpanded(HEADER)).toBe("false");
    expect(await present(`[data-project-id="${projectId}"]`)).toBe(true);
    await snap("sidebar-status-collapsed.png");
    await click(HEADER);
    expect(await ariaExpanded(HEADER)).toBe("true");
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
    expect(await bucketMark("review")).toMatchObject({
      // The theme's fg, not the PR-open green, which read as "checks passed".
      bucket: "review", glyph: "git-pull-request", color: await tokenColor("--color-fg"),
    });
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

  it("draws a branch label's leading path faint in the tree, squeezes it before the leaf, and drops it in the section", async () => {
    labelled = await createWorktreeTask("teach the parser", "e2e/a-shared-leading-path/ab-parser", false);
    await browser.execute(pid => window.__termic!.useApp.getState().setProjectCollapsed(pid, false), projectId);
    const treeRow = `[data-sidebar-task-id="${labelled}"]`;
    const statusRow = ROW_IN("backlog", labelled);
    await waitVisible(treeRow);
    await waitVisible(statusRow);
    // Labelled by its typed name, nothing is split.
    expect(await present(`${treeRow} [data-testid="task-label-prefix"]`)).toBe(false);
    expect(await present(`${statusRow} [data-testid="task-label-prefix"]`)).toBe(false);

    // Labelled by its branch, the leading path goes faint in the tree...
    await browser.execute(() => window.__termic!.usePrefs.getState().setUseBranchAsTaskName(true));
    await waitVisible(`${treeRow} [data-testid="task-label-prefix"]`);
    // ...and the section's row, which also names the project, draws the leaf
    // alone and keeps the whole branch in its tooltip.
    const section = await browser.execute(sel => {
      const el = document.querySelector(`${sel} [data-testid="task-label"]`) as HTMLElement | null;
      return el && {
        text: el.textContent, dropped: el.dataset.droppedPrefix ?? null,
        title: el.getAttribute("title"),
        prefixEl: !!document.querySelector(`${sel} [data-testid="task-label-prefix"]`),
      };
    }, statusRow);
    expect(section).toMatchObject({ text: "ab-parser", dropped: "e2e/a-shared-leading-path/", prefixEl: false });
    expect(section!.title!.split("\n")).toEqual(["e2e/a-shared-leading-path/ab-parser", "Task name: teach the parser"]);
    // Truncation measured in fractional px: the text's own width (a Range
    // over it) against the box it sits in. scrollWidth / clientWidth round to
    // integers, and a leaf shrunk by 0.03px reads as whole to them while
    // WebKit already paints its ellipsis.
    const parts = (row: string) => browser.execute(sel => {
      const prefix = document.querySelector(`${sel} [data-testid="task-label-prefix"]`) as HTMLElement | null;
      const leaf = prefix?.nextElementSibling as HTMLElement | null;
      if (!prefix || !leaf) return null;
      const textWidth = (el: HTMLElement) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getBoundingClientRect().width;
      };
      return {
        prefix: prefix.textContent, leaf: leaf.textContent,
        prefixColor: getComputedStyle(prefix).color, leafColor: getComputedStyle(leaf).color,
        leafCut: textWidth(leaf) - leaf.getBoundingClientRect().width,
        prefixSqueezed: textWidth(prefix) - prefix.getBoundingClientRect().width > 1,
        // The separator stays drawn however hard the path is squeezed.
        slashWidth: (prefix.querySelector('[data-testid="task-label-slash"]') as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
      };
    }, row);
    const faint = await tokenColor("--color-fg-faint");
    const got = await parts(treeRow);
    expect(got).toMatchObject({ prefix: "e2e/a-shared-leading-path/", leaf: "ab-parser", prefixColor: faint });
    expect(got!.leafColor).not.toBe(faint);

    // Too narrow for the whole label: the prefix gives way, the leaf stays
    // whole, since the leaf is what tells two rows apart.
    await browser.execute(() => window.__termic!.useApp.getState().setSidebarWidth(240));
    await browser.waitUntil(async () => (await parts(treeRow))?.prefixSqueezed === true, {
      timeout: 5_000, timeoutMsg: "the label never overflowed the narrowed sidebar, so the squeeze was not exercised",
    });
    expect((await parts(treeRow))!.leafCut).toBeLessThan(0.01);
    // Never `gab-parser`: the path's slash survives the squeeze.
    expect((await parts(treeRow))!.slashWidth).toBeGreaterThan(2);
    await snap("sidebar-branch-label.png");
    await browser.execute(w => window.__termic!.useApp.getState().setSidebarWidth(w), widthWas);
    await browser.execute(() => window.__termic!.usePrefs.getState().setUseBranchAsTaskName(false));
    await waitGone(`${treeRow} [data-testid="task-label-prefix"]`);
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

    // The menu row agrees: its switch is on, and it turns the section off.
    await openListOptions();
    expect(await present(`${TOGGLE_ROW}[data-on="true"]`)).toBe(true);
    await toggleStatusRow();
    await waitGone(SECTION);
    await openListOptions();
    expect(await present(`${TOGGLE_ROW}[data-on="false"]`)).toBe(true);
    await toggleStatusRow();
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
