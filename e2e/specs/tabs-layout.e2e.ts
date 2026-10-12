import { archiveTask, clickMenuItem, clickWhenVisible, clickMenuItemUntilReady, dismissOverlays, ensureActiveTask, mouseDrag, openTask, pointerDrag, pointerRelease, requireTermicApi, sidebarBadge, snap, waitForAppShell, waitGone, waitVisible } from "../helpers";

// Tabs are how a task holds multiple terminals/agents/editors. Guards adding a
// tab through the "+" menu and switching the active tab by clicking it.
describe("tab management", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const tabCount = () =>
    browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
      taskId,
    );
  const activeTab = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState().activeTab[id],
      taskId,
    );

  /** Open the tab strip's "+" menu. Radix opens on pointerdown, so a bare
   *  .click() is not enough.
   *
   *  Retried until the menu is THERE rather than dispatched once and waited
   *  on: a synthetic pointer sequence can land before Radix has bound its
   *  handler, and one that does is silently swallowed. That cost the Linux
   *  runner this whole file (the + menu case fails, and the eight cases that
   *  build on its tab cascade off it). The dispatch is skipped while a menu
   *  is already open, since a second pointerdown on the trigger closes it. */
  const openPlusMenu = async () => {
    await browser.waitUntil(
      () => browser.execute(() => {
        if (document.querySelector("[role='menu']")) return true;
        const strip = document.querySelector("[data-main-strip]");
        const plus = [...(strip?.querySelectorAll("button") ?? [])].find((b) =>
          b.querySelector("svg.lucide-plus"),
        );
        if (!plus) return false;
        const el = plus as HTMLElement;
        const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
        return !!document.querySelector("[role='menu']");
      }),
      { timeout: 15_000, interval: 250, timeoutMsg: "the tab strip's + menu never opened" },
    );
    await waitVisible("[role='menu']");
  };

  it("adds a terminal tab via the + menu and switches between tabs", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tabs");

    // Starts with the single agent tab.
    await browser.waitUntil(async () => (await tabCount()) === 1, {
      timeout: 20_000,
      timeoutMsg: "initial agent tab never appeared",
    });
    const agentTabId = await activeTab();

    // Wait for the tab strip's "+" button to render (it mounts async after the
    // task activates, slower under full-suite load).
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const strip = document.querySelector("[data-main-strip]");
          return [...(strip?.querySelectorAll("button") ?? [])].some((b) =>
            b.querySelector("svg.lucide-plus"),
          );
        }),
      { timeout: 10_000, timeoutMsg: "tab '+' button never appeared" },
    );

    // Open the tab bar's "+" menu through the retrying helper: dispatched
    // once, this is the click the Linux runner drops.
    await openPlusMenu();
    // Wait for the Radix menu to render, then add a Terminal.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[role='menuitem']")].some(
            (e) => e.textContent?.trim() === "Terminal",
          ),
        ),
      { timeout: 5_000, timeoutMsg: "the + menu (Terminal item) never opened" },
    );
    // Retried until the tab EXISTS: a click into Radix's remount does
    // nothing and leaves the menu open, which is how this case (and the eight
    // built on its tab) fails on the Linux runner.
    // `>=`, not `===`. A retrying click can only ever ADD tabs, so an exact
    // count turns one duplicated click into a condition that can never be
    // satisfied again. The helper now waits for the result before retrying,
    // and this is the second half of that: a monotonic condition.
    await clickMenuItemUntilReady("Terminal", async () => (await tabCount()) >= 2,
      { reopen: openPlusMenu });
    expect(await activeTab()).not.toBe(agentTabId);

    // Switch back to the agent tab with a real click.
    await browser.execute(
      (id) =>
        (document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement).click(),
      agentTabId,
    );
    await browser.waitUntil(async () => (await activeTab()) === agentTabId, {
      timeout: 5_000,
      timeoutMsg: "clicking the agent tab did not re-activate it",
    });

    await snap("tabs.png");
  });

  // The "+" menu's Resume section is a SUBMENU, matching the project launcher
  // and the sidebar task row. Closed tabs accumulate, and a flat list of them
  // pushed Terminal / the agents / Scratchpad off the top of a menu that opens
  // under the "+".
  it("keeps closed tabs behind one Resume row", async () => {
    // Close the terminal added above, so there is something to resume. A
    // secondary agent-less shell is not resumable, so use a fakeagent tab.
    const spawned = await browser.execute((id) => {
      const tabId = crypto.randomUUID();
      window.__termic!.useApp.getState().addTab(id, {
        id: tabId, type: "terminal", title: "fakeagent", cli: "fakeagent",
      } as never);
      return tabId as string;
    }, taskId) as string;
    await browser.execute((id, tabId) => {
      window.__termic!.useApp.getState().closeTab(id, tabId);
    }, taskId, spawned);
    await browser.waitUntil(
      () => browser.execute(
        (id) => (window.__termic!.useApp.getState().closedTabs[id] ?? []).length > 0, taskId),
      { timeout: 10_000, timeoutMsg: "closing the agent tab left no Resume entry" },
    );

    await openPlusMenu();
    const text = await browser.execute(() =>
      (document.querySelector("[role='menu']") as HTMLElement | null)?.innerText ?? "");
    expect(text).toContain("Resume");
    // The whole point: the sessions are NOT on the top level, so the rows the
    // user came for stay near the cursor however long the history gets.
    expect(text).not.toContain("now");

    // Hovering the trigger opens the submenu and reveals them.
    await browser.execute(() => {
      const t = [...document.querySelectorAll('[aria-haspopup="menu"]')]
        .find(e => e.textContent?.includes("Resume")) as HTMLElement | undefined;
      if (!t) throw new Error("no Resume submenu trigger");
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      t.dispatchEvent(new PointerEvent("pointerover", opts));
      t.dispatchEvent(new PointerEvent("pointermove", opts));
      t.click();
    });
    await browser.waitUntil(
      () => browser.execute(() =>
        [...document.querySelectorAll("[role='menuitem']")]
          .some(e => (e as HTMLElement).innerText.includes("fakeagent"))),
      { timeout: 8_000, timeoutMsg: "the Resume submenu never listed the closed tab" },
    );
    await dismissOverlays();
  });
});

// GH #197: the "+" menu is ALSO the sidebar task row's "New" submenu, because
// that row (right-click or kebab) is where people look for "add another agent
// to this task" and the tab strip's "+" was undiscoverable. Both render from
// NewTabMenuItems, so these cases guard the wiring: the same entries, spawning
// into the row's task (not whichever task happens to be on screen), and
// waking that task rather than replacing its restore seed.
describe("sidebar task menu: New submenu", () => {
  let taskId!: string;
  let otherId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    if (otherId) await archiveTask(otherId);
  });

  const tabsOf = (id: string) =>
    browser.execute(
      (i) =>
        (window.__termic!.useApp.getState().tabs[i] ?? []).map((t: any) => t.cli),
      id,
    ) as Promise<string[]>;

  /** The entries of the open Radix menu that holds the "Terminal" row. Scoped
   *  to that one menu: the task menu stays open behind its submenu, so a bare
   *  `[role='menuitem']` sweep would mix "Rename" / "Archive task" in. */
  const entriesOfTerminalMenu = () =>
    browser.execute(() => {
      const menu = [...document.querySelectorAll("[role='menu']")].find((m) =>
        [...m.querySelectorAll("[role='menuitem']")].some(
          (i) => i.textContent?.trim() === "Terminal",
        ),
      );
      if (!menu) throw new Error("no open menu contains a Terminal entry");
      return [...menu.querySelectorAll("[role='menuitem']")].map(
        (e) => e.textContent?.trim() ?? "",
      );
    }) as Promise<string[]>;

  /** Right-click the row (the gesture from the issue) and wait for the menu. */
  async function openTaskRowMenu(id: string) {
    await browser.execute((i) => {
      const row = document.querySelector(`[data-sidebar-task-id="${i}"]`);
      if (!row) throw new Error(`no sidebar row for task ${i}`);
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
      );
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[role='menuitem']")].some(
            (e) => e.textContent?.trim() === "New",
          ),
        ),
      { timeout: 5_000, timeoutMsg: "the task row menu never opened" },
    );
  }

  /** Open the "New" submenu and return the entries it offers. */
  async function openNewSubmenu(rowId: string): Promise<string[]> {
    // Radix opens a SubTrigger on hover OR click; click is the deterministic
    // one under WebDriver (no pointer position involved).
    // Retried: the submenu's entries are the result, and a swallowed click
    // leaves the parent menu open with nothing new in it.
    await clickMenuItemUntilReady("New", () => browser.execute(() =>
      [...document.querySelectorAll("[role='menuitem']")].some(
        (e) => e.textContent?.trim() === "Terminal",
      )) as Promise<boolean>,
    // The parent menu is what closes under a swallowed click here, and the
    // submenu cannot be reopened without it.
    { reopen: () => openTaskRowMenu(rowId) });
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[role='menuitem']")].some(
            (e) => e.textContent?.trim() === "Terminal",
          ),
        ),
      { timeout: 5_000, timeoutMsg: "the New submenu never opened" },
    );
    return entriesOfTerminalMenu();
  }

  it("spawns a terminal into the row's task, waking it without dropping its agent", async () => {
    await waitForAppShell();
    await requireTermicApi();
    // Two tasks: one on screen, one never visited. The submenu must act on the
    // row it was opened from, not on the active task.
    otherId = await openTask("e2e-newmenu-other");
    taskId = await openTask("e2e-newmenu", false);
    await ensureActiveTask(otherId);
    // The row has to be on screen to be right-clicked: a project an earlier
    // spec collapsed renders no task rows at all.
    await browser.execute(() => {
      const app = window.__termic!.useApp.getState();
      const proj = app.projects.find((p: any) => p.name === "fixture-repo");
      app.setProjectCollapsed(proj.id, false);
    });
    await waitVisible(`[data-sidebar-task-id="${taskId}"]`);

    await openTaskRowMenu(taskId);
    await openNewSubmenu(taskId);
    await clickMenuItemUntilReady("Terminal", async () =>
      (await tabsOf(taskId!)).includes("shell"),
    { reopen: async () => { await openTaskRowMenu(taskId!); await openNewSubmenu(taskId!); } });

    // The row's task is now the active one and holds BOTH its seeded agent tab
    // and the new shell — picking "Terminal" on a cold task must not cost the
    // user the agent the task exists for.
    await browser.waitUntil(
      async () => (await tabsOf(taskId!)).includes("shell"),
      { timeout: 10_000, timeoutMsg: "the shell tab never landed in the task" },
    );
    const clis = await tabsOf(taskId);
    expect(clis).toEqual(["fakeagent", "shell"]);
    expect(await tabsOf(otherId!)).not.toContain("shell");
    expect(
      await browser.execute(
        () => window.__termic!.useApp.getState().activeTaskId,
      ),
    ).toBe(taskId);
    // The new tab is the focused one (addTab self-focuses).
    expect(
      await browser.execute(
        (id) => window.__termic!.useApp.getState().activeTab[id],
        taskId,
      ),
    ).toBe(
      await browser.execute(
        (id) =>
          (window.__termic!.useApp.getState().tabs[id] ?? []).find(
            (t: any) => t.cli === "shell",
          )?.id,
        taskId,
      ),
    );
    await snap("sidebar-new-submenu.png");
  });

  it("offers the same entries as the tab strip's + menu", async () => {
    await dismissOverlays();
    await ensureActiveTask(taskId!);

    await openTaskRowMenu(taskId!);
    const fromSidebar = await openNewSubmenu(taskId!);
    await dismissOverlays();

    // Same list from the "+" button on the active task's strip. Radix opens on
    // pointerdown, so a bare .click() is not enough.
    await browser.execute(() => {
      const strip = document.querySelector("[data-main-strip]");
      const plus = [...(strip?.querySelectorAll("button") ?? [])].find((b) =>
        b.querySelector("svg.lucide-plus"),
      );
      if (!plus) throw new Error("tab '+' button not found");
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      plus.dispatchEvent(new PointerEvent("pointerdown", opts));
      plus.dispatchEvent(new PointerEvent("pointerup", opts));
      (plus as HTMLElement).click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[role='menuitem']")].some(
            (e) => e.textContent?.trim() === "Terminal",
          ),
        ),
      { timeout: 5_000, timeoutMsg: "the + menu never opened" },
    );
    const fromTabStrip = await entriesOfTerminalMenu();
    await dismissOverlays();

    expect(fromSidebar.length).toBeGreaterThan(1);
    expect(fromSidebar).toEqual(fromTabStrip);
  });
});

// Right-clicking a tab's row in the sidebar: "New below" puts the new tab
// directly under the clicked one (not at the end of the list), and "Close"
// closes it. The order has to agree in the sidebar, the tab strip and on disk,
// because all three read the one tab list.
describe("sidebar tab row menu", () => {
  let taskId!: string;
  after(async () => {
    await dismissOverlays();
    if (taskId) await archiveTask(taskId);
  });

  const tabIds = (id: string) =>
    browser.execute(
      (i) => (window.__termic!.useApp.getState().tabs[i] ?? []).map((t: any) => t.id),
      id,
    ) as Promise<string[]>;

  const sidebarRowIds = (id: string) =>
    browser.execute(
      (i) =>
        [...document.querySelectorAll(`[data-sidebar-task-row="${i}"] [data-testid="sidebar-tab-row"]`)]
          .map((r) => (r as HTMLElement).dataset.sidebarTabId ?? ""),
      id,
    ) as Promise<string[]>;

  const stripPillIds = (id: string) =>
    browser.execute(
      (i) =>
        [...document.querySelectorAll(`[data-task-id="${i}"] [data-main-strip] [data-tab-id]`)]
          .map((p) => (p as HTMLElement).dataset.tabId ?? ""),
      id,
    ) as Promise<string[]>;

  /** Add a tab through the store, at the end, without focusing it. Setup only:
   *  the feature under test is the menu, not how these got there. */
  const seedTerminal = (id: string, cli: string) =>
    browser.execute(
      (i, c) => {
        const tabId = crypto.randomUUID();
        window.__termic!.useApp.getState().addTab(
          i, { id: tabId, type: "terminal", title: c, cli: c } as any, { focus: false },
        );
        return tabId;
      },
      id, cli,
    ) as Promise<string>;

  async function openTabRowMenu(tabId: string) {
    await dismissOverlays();
    await browser.execute((t) => {
      const row = document.querySelector(`[data-sidebar-tab-id="${t}"]`);
      if (!row) throw new Error(`no sidebar row for tab ${t}`);
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    }, tabId);
    await waitVisible('[data-testid="sidebar-tab-menu"]', 5_000);
  }

  /** The labels of the open "New below" submenu (the menu holding "Terminal"). */
  const submenuEntries = () =>
    browser.execute(() => {
      const menu = [...document.querySelectorAll("[role='menu']")].find((m) =>
        [...m.querySelectorAll("[role='menuitem']")].some((i) => i.textContent?.trim() === "Terminal"),
      );
      if (!menu) throw new Error("no open menu contains a Terminal entry");
      return [...menu.querySelectorAll("[role='menuitem']")].map((e) => e.textContent?.trim() ?? "");
    }) as Promise<string[]>;

  async function openNewBelow(tabId: string) {
    await clickMenuItemUntilReady("New below", () => browser.execute(() =>
      [...document.querySelectorAll("[role='menuitem']")].some((e) => e.textContent?.trim() === "Terminal"),
    ) as Promise<boolean>, { reopen: () => openTabRowMenu(tabId) });
  }

  it("opens on right-click with New below and Close, and Escape changes nothing", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tabrow-menu");
    await ensureActiveTask(taskId);
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const proj = app.projects.find((p: any) => p.name === "fixture-repo");
      app.setProjectCollapsed(proj.id, false);
      app.setTaskCollapsed(id, false);
    }, taskId);
    await browser.waitUntil(async () => (await tabIds(taskId)).length === 1,
      { timeout: 10_000, timeoutMsg: "the task's agent tab never seeded" });
    await seedTerminal(taskId, "shell");
    await seedTerminal(taskId, "shell");
    await browser.waitUntil(async () => (await sidebarRowIds(taskId)).length === 3,
      { timeout: 5_000, timeoutMsg: "the three tab rows never rendered" });

    const [agent] = await tabIds(taskId);
    const before = await tabIds(taskId);
    await openTabRowMenu(agent);
    const items = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="sidebar-tab-menu"] [role="menuitem"]')]
        .map((e) => e.textContent?.trim() ?? ""),
    );
    expect(items).toEqual(["New below", "Close"]);
    await snap("sidebar-tab-row-menu.png");

    await browser.execute(() => {
      document.querySelector('[data-testid="sidebar-tab-menu"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitGone('[data-testid="sidebar-tab-menu"]', 5_000);
    expect(await tabIds(taskId)).toEqual(before);
  });

  it("offers the + menu's entries without the scratchpads", async () => {
    const [agent] = await tabIds(taskId);
    await openTabRowMenu(agent);
    await openNewBelow(agent);
    const entries = await submenuEntries();
    expect(entries).toContain("Terminal");
    expect(entries).toContain("FakeAgent");
    expect(entries.some((e) => e.includes("Scratchpad"))).toBe(false);
    await dismissOverlays();
  });

  it("New below > Terminal lands right under the clicked row, in the sidebar and the strip", async () => {
    const before = await tabIds(taskId); // agent, shell, shell
    await openTabRowMenu(before[0]);
    await openNewBelow(before[0]);
    await clickMenuItemUntilReady("Terminal", async () => (await tabIds(taskId)).length === 4,
      { reopen: async () => { await openTabRowMenu(before[0]); await openNewBelow(before[0]); } });

    const after = await tabIds(taskId);
    const added = after.find((id) => !before.includes(id))!;
    expect(after).toEqual([before[0], added, before[1], before[2]]);
    await browser.waitUntil(async () => JSON.stringify(await sidebarRowIds(taskId)) === JSON.stringify(after),
      { timeout: 5_000, timeoutMsg: `sidebar rows never matched ${after.join(",")}` });
    await browser.waitUntil(async () => JSON.stringify(await stripPillIds(taskId)) === JSON.stringify(after),
      { timeout: 5_000, timeoutMsg: `tab strip never matched ${after.join(",")}` });
    // The picked tab is the one you are now looking at, not the anchor.
    expect(await browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId)).toBe(added);
    // ...and the anchor is no longer marked selected: one active pill and one
    // active row, both the new tab. Read as state (`data-active`), not as the
    // row's computed background: the rows fade with `transition-colors`, and a
    // computed colour read here came back mid-fade or still at the old value
    // across runs while the class list was already right (docs/gotchas.md,
    // "getComputedStyle during a transition returns the value mid-flight").
    const marked = await browser.execute((i) => ({
      pills: [...document.querySelectorAll(`[data-task-id="${i}"] [data-main-strip] [data-tab-id][data-active]`)]
        .map((p) => (p as HTMLElement).dataset.tabId),
      rows: [...document.querySelectorAll(`[data-sidebar-task-row="${i}"] [data-testid="sidebar-tab-row"][data-active]`)]
        .map((r) => (r as HTMLElement).dataset.sidebarTabId),
    }), taskId);
    expect(marked).toEqual({ pills: [added], rows: [added] });
    await snap("sidebar-tab-row-new-below.png");
  });

  it("New below > an agent keeps its slot on disk", async () => {
    // Shells are not durable, so the agents carry the persisted order.
    const second = await seedTerminal(taskId, "fakeagent");
    const [first] = await tabIds(taskId);
    const before = await tabIds(taskId);
    await openTabRowMenu(first);
    await openNewBelow(first);
    await clickMenuItemUntilReady("FakeAgent", async () => (await tabIds(taskId)).length === before.length + 1,
      { reopen: async () => { await openTabRowMenu(first); await openNewBelow(first); } });
    const added = (await tabIds(taskId)).find((id) => !before.includes(id))!;

    await browser.waitUntil(async () => {
      const persisted = await browser.execute(async (id) => {
        const tasks = await window.__termic!.ipc.tasksList();
        return (tasks.find((t: any) => t.id === id)?.persisted_tabs ?? []).map((p: any) => p.id);
      }, taskId) as string[];
      return JSON.stringify(persisted) === JSON.stringify([first, added, second]);
    }, { timeout: 10_000, timeoutMsg: "persisted_tabs never took the inserted order" });
  });

  it("Close removes the clicked tab and only that one", async () => {
    const before = await tabIds(taskId);
    const shell = await browser.execute((id) =>
      (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.cli === "shell")!.id, taskId);
    await openTabRowMenu(shell);
    await clickMenuItem("Close");
    await waitGone(`[data-sidebar-tab-id="${shell}"]`, 5_000);
    expect(await tabIds(taskId)).toEqual(before.filter((id) => id !== shell));
  });
});

// Dragging a tab's child row in the sidebar reorders the task's tabs: the
// rows, the tab strip (same `tabs[taskId]`) and the durable agent order on
// disk all move together. Guards the clamps (own task only, pinned rows stay
// a block), that hidden edit tabs keep their strip slot, and that neither the
// drop nor a short press goes wrong on activation.
describe("sidebar tab drag", () => {
  let taskId!: string;
  let otherId!: string;
  after(async () => {
    await dismissOverlays();
    if (taskId) await archiveTask(taskId);
    if (otherId) await archiveTask(otherId);
  });

  const tabIds = (id: string) =>
    browser.execute(
      (i) => (window.__termic!.useApp.getState().tabs[i] ?? []).map((t: any) => t.id),
      id,
    ) as Promise<string[]>;

  const rowIds = (id: string) =>
    browser.execute(
      (i) => (window.__termic!.useApp.getState().tabs[i] ?? [])
        .filter((t: any) => t.type === "terminal" && !t.paneId).map((t: any) => t.id),
      id,
    ) as Promise<string[]>;

  const sidebarRowIds = (id: string) =>
    browser.execute(
      (i) =>
        [...document.querySelectorAll(`[data-sidebar-task-row="${i}"] [data-testid="sidebar-tab-row"]`)]
          .map((r) => (r as HTMLElement).dataset.sidebarTabId ?? ""),
      id,
    ) as Promise<string[]>;

  const stripPillIds = (id: string) =>
    browser.execute(
      (i) =>
        [...document.querySelectorAll(`[data-task-id="${i}"] [data-main-strip] [data-tab-id]`)]
          .map((p) => (p as HTMLElement).dataset.tabId ?? ""),
      id,
    ) as Promise<string[]>;

  const persistedIds = async (id: string) =>
    (await browser.execute(async (i) => {
      const tasks = await window.__termic!.ipc.tasksList();
      return (tasks.find((t: any) => t.id === i)?.persisted_tabs ?? []).map((p: any) => p.id);
    }, id)) as string[];

  const activeTab = (id: string) =>
    browser.execute((i) => window.__termic!.useApp.getState().activeTab[i], id) as Promise<string | undefined>;

  const row = (tabId: string) => `[data-sidebar-tab-id="${tabId}"]`;

  const seedTerminal = (id: string, cli: string) =>
    browser.execute(
      (i, c) => {
        const tabId = crypto.randomUUID();
        window.__termic!.useApp.getState().addTab(
          i, { id: tabId, type: "terminal", title: c, cli: c } as any, { focus: false },
        );
        return tabId;
      },
      id, cli,
    ) as Promise<string>;

  const expand = (id: string) =>
    browser.execute((i) => {
      const app = window.__termic!.useApp.getState();
      const proj = app.projects.find((p: any) => p.name === "fixture-repo");
      app.setProjectCollapsed(proj.id, false);
      app.setTaskCollapsed(i, false);
    }, id);

  /** The full gesture in ONE synchronous turn, including the `click` a real
   *  release produces (pointerDrag fires none). The click has to land before
   *  the drop's 0ms timer clears the suppression flag, which is the timing a
   *  real mouse gives it, and only a single execute reproduces that. `dy` is
   *  the travel in px from the source row's centre. */
  const pressMoveRelease = (fromSel: string, dy: number) =>
    browser.execute((sel, d) => {
      const src = document.querySelector(sel) as HTMLElement | null;
      if (!src) throw new Error(`no row: ${sel}`);
      src.scrollIntoView({ block: "nearest" });
      const r = src.getBoundingClientRect();
      const x = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const under = (yy: number) => (document.elementFromPoint(x, yy) as HTMLElement | null) ?? document.body;
      const fire = (type: string, yy: number, node: EventTarget) => node.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: yy, button: 0, buttons: type === "pointerup" ? 0 : 1,
        pointerType: "mouse", bubbles: true, cancelable: true,
      }));
      fire("pointerdown", y0, src);
      const steps = Math.max(1, Math.ceil(Math.abs(d) / 6));
      for (let i = 1; i <= steps; i++) fire("pointermove", y0 + (d * i) / steps, under(y0 + (d * i) / steps));
      const end = y0 + d;
      const target = under(end);
      fire("pointerup", end, target);
      target.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: end, button: 0, bubbles: true, cancelable: true }));
    }, fromSel, dy);

  it("dragging the third row above the first reorders the sidebar, the strip and the disk", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tabrow-drag");
    await ensureActiveTask(taskId);
    await expand(taskId);
    await browser.waitUntil(async () => (await tabIds(taskId)).length === 1,
      { timeout: 10_000, timeoutMsg: "the task's agent tab never seeded" });
    await seedTerminal(taskId, "shell");
    await seedTerminal(taskId, "fakeagent");
    await browser.waitUntil(async () => (await sidebarRowIds(taskId)).length === 3,
      { timeout: 5_000, timeoutMsg: "the three tab rows never rendered" });

    const [a0, sh, a1] = await tabIds(taskId);
    const active = await activeTab(taskId);
    await browser.waitUntil(async () => JSON.stringify(await persistedIds(taskId)) === JSON.stringify([a0, a1]),
      { timeout: 10_000, timeoutMsg: "the seeded agents never reached persisted_tabs" });

    // Held mid-gesture: the row is lifted and the order is already live.
    await pointerDrag(row(a1), row(a0), { land: "top", hold: true });
    expect(await browser.execute((s) => document.querySelector(s)!.hasAttribute("data-dragging"), row(a1))).toBe(true);
    await snap("sidebar-tab-drag-mid.png");
    await pointerRelease(row(a0), "top");
    await waitGone(`${row(a1)}[data-dragging]`, 5_000);

    const want = [a1, a0, sh];
    expect(await tabIds(taskId)).toEqual(want);
    await browser.waitUntil(async () => JSON.stringify(await sidebarRowIds(taskId)) === JSON.stringify(want),
      { timeout: 5_000, timeoutMsg: `sidebar rows never matched ${want.join(",")}` });
    await browser.waitUntil(async () => JSON.stringify(await stripPillIds(taskId)) === JSON.stringify(want),
      { timeout: 5_000, timeoutMsg: `tab strip never matched ${want.join(",")}` });
    // Only agents are durable, and they persist in the new order.
    await browser.waitUntil(async () => JSON.stringify(await persistedIds(taskId)) === JSON.stringify([a1, a0]),
      { timeout: 10_000, timeoutMsg: "persisted_tabs never took the dragged order" });
    // The lifted transform is gone with the drag.
    expect(await browser.execute((s) => (document.querySelector(s) as HTMLElement).style.transform, row(a1))).toBe("");
    // The drop moved a tab, it did not select one.
    expect(await activeTab(taskId)).toBe(active);
  });

  it("the click that trails a drop selects nothing, and an inactive task stays inactive", async () => {
    otherId = await openTask("e2e-tabrow-drag-other");
    await ensureActiveTask(otherId);
    await expand(taskId);
    await waitVisible(`[data-sidebar-task-row="${taskId}"] [data-testid="sidebar-tab-row"]`);
    const before = await rowIds(taskId); // [a1, a0, sh]
    const active = await activeTab(taskId);
    const rowH = await browser.execute((s) => document.querySelector(s)!.getBoundingClientRect().height, row(before[2]));

    // Bottom row to just above the middle row's midpoint: one slot up.
    await pressMoveRelease(row(before[2]), -(rowH + 4));
    const want = [before[0], before[2], before[1]];
    await browser.waitUntil(async () => JSON.stringify(await rowIds(taskId)) === JSON.stringify(want),
      { timeout: 5_000, timeoutMsg: `rows never took ${want.join(",")}` });
    // The trailing click landed on the dropped row; it must not have
    // activated the task or the tab.
    expect(await browser.execute(() => window.__termic!.useApp.getState().activeTaskId)).toBe(otherId);
    expect(await activeTab(taskId)).toBe(active);
    // ...and the suppression flag was cleared, so the NEXT click works.
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), row(before[1]));
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__termic!.useApp.getState().activeTaskId)) === taskId,
      { timeout: 5_000, timeoutMsg: "a plain click after the drop did not activate the task" });
    expect(await activeTab(taskId)).toBe(before[1]);
  });

  it("a press under the threshold is a click: it activates and moves nothing", async () => {
    const before = await rowIds(taskId);
    const current = await activeTab(taskId);
    const target = before.find((id) => id !== current)!;
    await pressMoveRelease(row(target), 2);
    await browser.waitUntil(async () => (await activeTab(taskId)) === target,
      { timeout: 5_000, timeoutMsg: "a short press did not activate its tab" });
    expect(await rowIds(taskId)).toEqual(before);
    expect(await browser.execute((s) => document.querySelector(s)!.hasAttribute("data-dragging"), row(target))).toBe(false);
  });

  it("dropping onto another task's row is refused: the row clamps to its own list", async () => {
    await ensureActiveTask(taskId);
    await expand(taskId);
    await expand(otherId);
    await waitVisible(`[data-sidebar-task-id="${otherId}"]`);
    const mine = await tabIds(taskId);
    const theirs = await tabIds(otherId);
    const rows = await rowIds(taskId);
    const otherBelow = await browser.execute((a, b) =>
      document.querySelector(`[data-sidebar-task-id="${b}"]`)!.getBoundingClientRect().top >
      document.querySelector(`[data-sidebar-task-row="${a}"]`)!.getBoundingClientRect().top, taskId, otherId);
    // Drag the row farthest from the other task toward it.
    const dragged = otherBelow ? rows[0] : rows[rows.length - 1];
    await pointerDrag(row(dragged), `[data-sidebar-task-id="${otherId}"]`);

    expect(await tabIds(otherId)).toEqual(theirs);
    expect([...(await tabIds(taskId))].sort()).toEqual([...mine].sort());
    const after = await rowIds(taskId);
    expect(otherBelow ? after[after.length - 1] : after[0]).toBe(dragged);
  });

  it("pinned rows stay a block: an unpinned row stops below them, a pinned one above the rest", async () => {
    const rows = await rowIds(taskId);
    const pinned = rows[1];
    await browser.execute((i, t) => window.__termic!.useApp.getState().pinTab(i, t), taskId, pinned);
    await browser.waitUntil(async () => (await rowIds(taskId))[0] === pinned,
      { timeout: 5_000, timeoutMsg: "pinning did not move the tab to the head" });
    const [p, u1, u2] = await rowIds(taskId);

    // The last unpinned row aimed at the very top lands right after the pin.
    await pointerDrag(row(u2), row(p), { land: "top" });
    expect(await rowIds(taskId)).toEqual([p, u2, u1]);

    // The pinned row aimed at the bottom does not leave the pinned block.
    await pointerDrag(row(p), row(u1), { land: "bottom" });
    expect(await rowIds(taskId)).toEqual([p, u2, u1]);

    await browser.execute((i, t) => window.__termic!.useApp.getState().unpinTab(i, t), taskId, pinned);
  });

  it("an edit tab between rows keeps its place in the strip", async () => {
    await ensureActiveTask(taskId);
    const rows = await rowIds(taskId);
    // Park an edit tab right after the first row.
    await browser.execute((i) => window.__termic!.useApp.getState().openPreviewTab(i,
      { type: "edit", path: "README.md", title: "README.md", permanent: true }), taskId);
    const edit = await browser.waitUntil(async () =>
      (await browser.execute((i) => (window.__termic!.useApp.getState().tabs[i] ?? [])
        .find((t: any) => t.type === "edit")?.id, taskId)) as string | undefined,
      { timeout: 5_000, timeoutMsg: "the edit tab never opened" }) as string;
    const firstIdx = (await tabIds(taskId)).indexOf(rows[0]);
    await browser.execute((i, e, at) => window.__termic!.useApp.getState().reorderTab(i, e, at),
      taskId, edit, firstIdx + 1);
    const before = await tabIds(taskId);
    expect(before.indexOf(edit)).toBe(before.indexOf(rows[0]) + 1);

    // Last row to the top: the edit tab still follows the row it followed.
    const last = rows[rows.length - 1];
    await pointerDrag(row(last), row(rows[0]), { land: "top" });
    const after = await tabIds(taskId);
    expect(after.filter((id) => id !== edit)).toEqual([last, ...before.filter((id) => id !== edit && id !== last)]);
    expect(after.indexOf(edit)).toBe(after.indexOf(rows[0]) + 1);
    await browser.waitUntil(async () => JSON.stringify(await stripPillIds(taskId)) === JSON.stringify(after),
      { timeout: 5_000, timeoutMsg: `tab strip never matched ${after.join(",")}` });

    await browser.execute((i, e) => window.__termic!.useApp.getState().closeTab(i, e), taskId, edit);
  });
});

// Renaming a tab (double-click -> inline edit -> Enter) is a common action and
// exercises the controlled-input + persist path. Guards that the committed
// name lands in the store.
describe("tab rename", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("renames a tab via double-click inline edit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-rename");

    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
          taskId,
        )) === 1,
      { timeout: 20_000, timeoutMsg: "agent tab never appeared" },
    );
    const tabId = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].id as string,
      taskId,
    );

    // Double-click the tab to enter rename mode.
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, tabId);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => !!document.querySelector(`[data-tab-id="${id}"] input`),
          tabId,
        ),
      { timeout: 5_000, timeoutMsg: "rename input never appeared" },
    );

    // Type into the controlled input (native setter + input event so React's
    // onChange fires).
    await browser.execute((id) => {
      const input = document.querySelector(
        `[data-tab-id="${id}"] input`,
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, tabId);

    // Commit with Enter in a separate round-trip, so React has flushed the
    // new value into state before the keydown handler reads it.
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"] input`)!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
    }, tabId);

    await browser.waitUntil(
      () =>
        browser.execute(
          (tid, aid) => {
            const tab = (window.__termic!.useApp.getState().tabs[tid] ?? []).find(
              (t: any) => t.id === aid,
            );
            return tab?.title === "e2e-renamed";
          },
          taskId,
          tabId,
        ),
      { timeout: 5_000, timeoutMsg: "tab title never became the new name" },
    );

    await snap("rename.png");
  });
});

// P1: splitting a task into multiple panes (Sublime-style). Cases: no split to
// start, split right builds a 2-leaf tree, split below grows it to 3 leaves.
describe("split pane", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Count pane leaves in the task's split tree (leaves are type:"pane").
  const leafCount = () =>
    browser.execute((id) => {
      const tree = window.__termic!.useApp.getState().splitTree[id];
      if (!tree) return 0;
      // SplitNode = { type:"split", a, b }; PaneLeaf = { type:"pane" }.
      const walk = (node: any): number =>
        !node ? 0 : node.type === "pane" ? 1 : walk(node.a) + walk(node.b);
      return walk(tree);
    }, taskId);

  const clickSplit = async (lucideClass: string, label: string) => {
    // Wait for the toggle to render (the tab strip mounts async after the task
    // becomes active, and is slower under full-suite load).
    await browser.waitUntil(
      () =>
        browser.execute(
          (cls) =>
            [...document.querySelectorAll("button")].some((b) =>
              b.querySelector(`svg.${cls}`),
            ),
          lucideClass,
        ),
      { timeout: 10_000, timeoutMsg: `${label} toggle never appeared` },
    );
    await browser.execute((cls) => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.querySelector(`svg.${cls}`),
      );
      (btn as HTMLElement).click();
    }, lucideClass);
  };

  it("starts unsplit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-split");
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length >= 1,
          taskId,
        ),
      { timeout: 20_000, timeoutMsg: "task never opened" },
    );
    expect(await leafCount()).toBe(0); // no split tree yet
  });

  it("split right builds a two-leaf tree", async () => {
    await clickSplit("lucide-square-split-horizontal", "Split right");
    await browser.waitUntil(async () => (await leafCount()) === 2, {
      timeout: 8_000,
      timeoutMsg: "split right did not produce 2 panes",
    });
  });

  it("split below grows the tree to three leaves", async () => {
    await clickSplit("lucide-square-split-vertical", "Split below");
    await browser.waitUntil(async () => (await leafCount()) === 3, {
      timeout: 8_000,
      timeoutMsg: "split below did not produce 3 panes",
    });
    await snap("split-pane.png");
  });

  // The divider between two panes is a ResizeHandle (mouse drag, not pointer).
  // Dragging it moves the split ratio and persists the layout.
  it("dragging the divider changes the split ratio", async () => {
    const ratios = () =>
      browser.execute((id) => {
        const walk = (n: any): number[] =>
          !n || n.type === "pane" ? [] : [n.ratio, ...walk(n.a), ...walk(n.b)];
        return walk(window.__termic!.useApp.getState().splitTree[id]);
      }, taskId);

    const before = (await ratios()) as number[];
    expect(before.length).toBeGreaterThan(0);
    await mouseDrag(`[data-task-id="${taskId}"] [data-resize-handle='split-divider']`, -80);
    await browser.waitUntil(
      async () => {
        const after = (await ratios()) as number[];
        return after.some((r, i) => Math.abs(r - before[i]) > 0.01);
      },
      { timeout: 8_000, timeoutMsg: "dragging the divider did not move the split ratio" },
    );
    // Ratios stay inside the clamp, so a pane can never be dragged to nothing.
    for (const r of (await ratios()) as number[]) {
      expect(r).toBeGreaterThanOrEqual(0.05);
      expect(r).toBeLessThanOrEqual(0.95);
    }
  });
});

// P1: dragging tabs (pointer-based, see helpers.pointerDrag). Cases: reorder
// within the main strip; drag onto a pane EDGE to split there; drag a tab out
// of a split pane header back into the main strip. All three go through
// useTabStripDrag / PaneHeader and land in different store actions
// (reorderTab / moveTabToSplit / moveTabToMain), so each is asserted on the
// store, not on pixels.
describe("tab drag", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Annotated, like the other list helpers in the suite: the store behind
  // `window.__termic` is loosely typed, so without this the result lands as an
  // `any`-derived union and every `.find((t) => ...)` below it is an implicit
  // any that only a typecheck of this project would ever flag.
  const tabs = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).map((t: any) => ({
          id: t.id as string,
          title: t.title as string,
          paneId: (t.paneId ?? null) as string | null,
        })),
      taskId,
    ) as Promise<Array<{ id: string; title: string; paneId: string | null }>>;
  const leafCount = () =>
    browser.execute((id) => {
      const tree = window.__termic!.useApp.getState().splitTree[id];
      const walk = (n: any): number =>
        !n ? 0 : n.type === "pane" ? 1 : walk(n.a) + walk(n.b);
      return walk(tree);
    }, taskId);

  // Every visited task stays mounted (MainArea keeps PTYs alive), so the tab
  // strip and pane chrome exist once PER TASK. Scope every selector to this
  // task or a hidden task's copy — rect 0x0, unreachable — wins the query.
  const scope = () => `[data-task-id="${taskId}"]`;

  it("reorders tabs within the main strip", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tabdrag");

    // Second tab: an editor tab is enough to drag (and costs no PTY).
    await browser.waitUntil(
      async () => (await tabs()).length === 1,
      { timeout: 20_000, timeoutMsg: "agent tab never appeared" },
    );
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      app.openPreviewTab(id, { type: "edit", path: "README.md", title: "README.md" });
      const opened = app.tabs[id] ?? [];
      app.persistTab(id, opened[opened.length - 1].id);
    }, taskId);
    await browser.waitUntil(async () => (await tabs()).length === 2, {
      timeout: 8_000,
      timeoutMsg: "second tab never appeared",
    });

    // An earlier spec file may have left a dialog backdrop over the strip.
    await dismissOverlays();
    await ensureActiveTask(taskId);
    const [first, second] = await tabs();
    // Grab the left tab and carry it past the right one's far edge.
    await pointerDrag(`${scope()} [data-main-strip] [data-tab-id="${first.id}"]`,
                      `${scope()} [data-main-strip] [data-tab-id="${second.id}"]`,
                      { grab: "left", land: "right" });
    await browser.waitUntil(
      async () => (await tabs())[0].id === second.id,
      { timeout: 8_000, timeoutMsg: "dragging a tab did not reorder the strip" },
    );
    expect((await tabs())[1].id).toBe(first.id);
  });

  it("dropping a tab on a pane edge splits there", async () => {
    await ensureActiveTask(taskId!);
    expect(await leafCount()).toBe(0); // unsplit until the drag says otherwise
    const dragged = (await tabs())[0];
    // The outer 20% of the main pane is the split zone; "right" lands at 8%.
    // landOn: the pane chrome sets the rect, but what's actually UNDER the
    // cursor is the flat content layer's own [data-main-content] sibling —
    // which is exactly what the app's hit test resolves, so accept it.
    await pointerDrag(`${scope()} [data-main-strip] [data-tab-id="${dragged.id}"]`,
                      `${scope()} [data-main-content][data-split-leaf]`,
                      { land: "right", landOn: "[data-main-content]" });
    await browser.waitUntil(async () => (await leafCount()) === 2, {
      timeout: 8_000,
      timeoutMsg: "dropping a tab on the pane edge did not split",
    });
    // The dragged tab is the one that moved into the new pane.
    const moved = (await tabs()).find((t) => t.id === dragged.id)!;
    expect(moved.paneId).toBeTruthy();
    await snap("tab-drag-split.png");
  });

  it("dragging a tab out of a pane returns it to the main strip", async () => {
    await ensureActiveTask(taskId!);
    const inPane = (await tabs()).find((t) => t.paneId)!;
    await pointerDrag(`${scope()} [data-pane-header] [data-tab-id="${inPane.id}"]`,
                      `${scope()} [data-main-strip]`);
    await browser.waitUntil(
      async () => !(await tabs()).find((t) => t.id === inPane.id)!.paneId,
      { timeout: 8_000, timeoutMsg: "the tab never returned to the main strip" },
    );
    // Emptying the pane collapses the split back to a single surface.
    expect(await leafCount()).toBeLessThan(2);
  });
});

// Right-click "Split right" / "Split down" / "Move to split…" are the menu
// equivalents of the toolbar split buttons and drag-and-drop, wired straight
// to the same store actions (moveTabToSplit / moveTabToMain). "Move to
// split" specifically arms a cursor-following drag with no button held
// (src/lib/menuDrag.ts): the ghost follows the pointer from wherever the menu
// closed, and the next click commits wherever it lands — mirroring
// pointerDrag's real drag without a real grab to start it.
describe("split from the tab context menu", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const tabs = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).map((t: any) => ({
          id: t.id as string,
          paneId: (t.paneId ?? null) as string | null,
        })),
      taskId,
    ) as Promise<Array<{ id: string; paneId: string | null }>>;
  const leafCount = () =>
    browser.execute((id) => {
      const tree = window.__termic!.useApp.getState().splitTree[id];
      const walk = (n: any): number =>
        !n ? 0 : n.type === "pane" ? 1 : walk(n.a) + walk(n.b);
      return walk(tree);
    }, taskId);

  const addShells = (prefix: string, n: number) =>
    browser.execute(
      (id, p, count) => {
        const app = window.__termic!.useApp.getState();
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const tabId = `${p}-${i}`;
          ids.push(tabId);
          app.addTab(id, { id: tabId, type: "terminal", cli: "shell", title: tabId } as any);
        }
        return ids;
      },
      taskId, prefix, n,
    );

  // Same dispatched-contextmenu approach as the "tab context menu" describe
  // above: a WebDriver right-click gesture doesn't reach Radix in this
  // WKWebView, so the MouseEvent goes in through the real trigger instead.
  const openTabMenu = async (tabId: string) => {
    await browser.execute((id) => {
      const el = document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
      if (!el) throw new Error(`no tab pill ${id}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: r.left + 10, clientY: r.top + 10,
      }));
    }, tabId);
    await waitVisible('[role="menu"]');
  };

  const clickTabMenuItem = (label: string) =>
    browser.execute((text) => {
      const menu = [...document.querySelectorAll('[role="menu"]')].pop() as HTMLElement | undefined;
      if (!menu) throw new Error("the tab context menu is not open");
      const item = [...menu.children].find(
        (i) => (i as HTMLElement).innerText?.trim() === text,
      ) as HTMLElement | undefined;
      if (!item) throw new Error(`no menu item "${text}"`);
      item.click();
    }, label);

  it("split right moves the tab into a fresh pane to the right", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-menusplit");
    await browser.waitUntil(async () => (await tabs()).length === 1, {
      timeout: 20_000, timeoutMsg: "agent tab never appeared",
    });
    // Extra main tabs: Split right/down and Move to split stay disabled (or
    // hidden, for Move to split) while a main tab is alone in the strip.
    await addShells("e2e-menusplit-shell", 3);
    await browser.waitUntil(async () => (await tabs()).length === 4, {
      timeout: 8_000, timeoutMsg: "shell tabs never appeared",
    });
    await ensureActiveTask(taskId);
    await dismissOverlays();

    const [target] = await tabs();
    await openTabMenu(target.id);
    await clickTabMenuItem("Split right");
    await browser.waitUntil(async () => (await leafCount()) === 2, {
      timeout: 8_000, timeoutMsg: "split right never produced a second pane",
    });
    const moved = (await tabs()).find((t) => t.id === target.id)!;
    expect(moved.paneId).toBeTruthy();
  });

  it("split down grows the tree further", async () => {
    await ensureActiveTask(taskId!);
    const mainTab = (await tabs()).find((t) => !t.paneId)!;
    await openTabMenu(mainTab.id);
    await clickTabMenuItem("Split down");
    await browser.waitUntil(async () => (await leafCount()) === 3, {
      timeout: 8_000, timeoutMsg: "split down never produced a third pane",
    });
  });

  it("move to split arms a cursor-following drag that commits on the next click", async () => {
    await ensureActiveTask(taskId!);
    const paneTab = (await tabs()).find((t) => t.paneId)!;
    await openTabMenu(paneTab.id);
    await clickTabMenuItem("Move to split…");

    // The menu closes and a drag ghost appears immediately, following the
    // cursor with no button held — that's the whole point of the feature.
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector(".termic-drag-ghost")),
      { timeout: 4_000, timeoutMsg: "move to split never armed a drag ghost" },
    );

    // There's no button held from a real grab to release, so a fresh
    // pointerdown anywhere stands in for the drop. Land it on the main
    // strip's header, which always resolves to "move to main" regardless of
    // where in the header it lands.
    await browser.execute((scopeSel) => {
      const strip = document.querySelector(`${scopeSel} [data-main-strip]`) as HTMLElement;
      const r = strip.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, `[data-task-id="${taskId}"]`);

    await browser.waitUntil(
      async () => !(await tabs()).find((t) => t.id === paneTab.id)!.paneId,
      { timeout: 8_000, timeoutMsg: "move to split never landed the tab back on main" },
    );
    expect(await browser.execute(() => !!document.querySelector(".termic-drag-ghost"))).toBe(false);
  });
});

// Theme switching is a visible, frequently-used preference. Guards that
// picking a theme updates the prefs store AND applies the palette class to
// <html> (the actual rendering surface).
describe("theme switching", () => {
  let original: string | undefined;
  after(async () => {
    if (original) {
      await browser.execute(
        (m) => window.__termic!.usePrefs.getState().setThemeMode(m),
        original,
      );
    }
  });

  /** The sidebar icon opens the theme list; pick a row from it. The list
   *  is filtered to the current theme's scheme, so widen it to All first. */
  const pick = async (mode: string) => {
    await clickWhenVisible('[data-testid="theme-picker"]');
    await waitVisible('[data-testid="theme-filter-all"]');
    // the filter acts on mousedown, which a scripted click never fires
    await browser.execute(() => {
      document.querySelector('[data-testid="theme-filter-all"]')!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    });
    await clickWhenVisible(`[data-cmd-id="theme:${mode}"]`);
    await browser.waitUntil(() => browser.execute(() => !window.__termic!.useUI.getState().commandPaletteOpen));
  };

  it("switches theme via the picker and applies it to <html>", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await browser.execute(
      () => window.__termic!.usePrefs.getState().themeMode,
    );

    await pick("light");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.usePrefs.getState().themeMode === "light" &&
            document.documentElement.classList.contains("light"),
        ),
      { timeout: 8_000, timeoutMsg: "Light theme was not applied to <html>" },
    );

    await pick("dark");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.usePrefs.getState().themeMode === "dark" &&
            document.documentElement.classList.contains("dark"),
        ),
      { timeout: 8_000, timeoutMsg: "Dark theme was not applied to <html>" },
    );

    await snap("theme.png");
  });
});

// P2: layout state. Guards the sidebar width setter (persisted layout pref).
describe("layout", () => {
  let original: number | undefined;
  const width = () =>
    browser.execute(() => window.__termic!.useApp.getState().sidebarWidth);

  after(async () => {
    if (original !== undefined) {
      await browser.execute(
        (w) => window.__termic!.useApp.getState().setSidebarWidth(w),
        original,
      );
    }
  });

  it("sets the sidebar width", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = (await width()) as number;
    await browser.execute(() =>
      window.__termic!.useApp.getState().setSidebarWidth(320),
    );
    await browser.waitUntil(async () => (await width()) === 320, {
      timeout: 5_000,
      timeoutMsg: "sidebar width never applied",
    });
    await snap("layout.png");
  });

  // The sidebar's right edge is a ResizeHandle: a MOUSE drag (resize handles
  // are the one gesture family that isn't pointer-based), persisted to
  // localStorage so the width survives a relaunch.
  it("widens the sidebar by dragging its edge", async () => {
    // From the floor, so the drag has room under the 33vw cap: on a 1024px
    // window (the CI runner's) the default width plus 60 is past it.
    await mouseDrag("[data-resize-handle='sidebar-width']", -600);
    await browser.waitUntil(async () => ((await width()) as number) === 160, { timeout: 8_000 });
    const start = (await width()) as number;
    await mouseDrag("[data-resize-handle='sidebar-width']", 60);
    await browser.waitUntil(async () => ((await width()) as number) > start + 40, {
      timeout: 8_000,
      timeoutMsg: "dragging the sidebar edge did not widen it",
    });
    const persisted = await browser.execute(() =>
      Number(localStorage.getItem("sidebarWidth")),
    );
    expect(persisted).toBe(await width());
  });

  it("clamps the sidebar to its minimum", async () => {
    // Far past the 160px floor: the drag clamps instead of collapsing it.
    await mouseDrag("[data-resize-handle='sidebar-width']", -600);
    await browser.waitUntil(async () => ((await width()) as number) === 160, {
      timeout: 8_000,
      timeoutMsg: "sidebar width never clamped to its minimum",
    });
  });

  // The cases above dispatch mousedown AT the handle element, which skips hit
  // testing: they pass against a target a pointer cannot land on. What a user
  // aims at is the divider, so measure the strip around it the way a pointer
  // finds one, with elementFromPoint, and require room on BOTH sides. The
  // handle's painted hover line is the same element, so a strip narrower than
  // this is also a lie: the divider lights up under the cursor and then does
  // not take the press.
  const grabStrip = (label: string) =>
    browser.execute((sel) => {
      const el = document.querySelector(`[data-resize-handle='${sel}']`);
      if (!el) throw new Error(`no resize handle ${sel}`);
      // Measured from the painted LINE, not from the strip: the line is what
      // a user aims at, and the strip is deliberately not centred on it (the
      // panel's own side of the edge carries its scrollbar).
      const line = el.firstElementChild ?? el;
      const r = line.getBoundingClientRect();
      const y = Math.round(r.top + r.height / 2);
      const edge = Math.round(r.left + r.width / 2);
      const hits: number[] = [];
      for (let dx = -12; dx <= 12; dx++) {
        if (document.elementFromPoint(edge + dx, y)?.closest(`[data-resize-handle='${sel}']`))
          hits.push(dx);
      }
      return hits;
    }, label) as Promise<number[]>;

  it("gives both dividers a grab strip a pointer can actually land on", async () => {
    // The right panel only exists with a task on screen, and only when it has
    // not been hidden by a previous case.
    const taskId = await openTask("e2e-grab-strip");
    await ensureActiveTask(taskId);
    await browser.execute(() => {
      const app = window.__termic!.useApp.getState();
      if (app.rightPanelHidden) app.toggleRightPanel();
    });
    await waitVisible("[data-resize-handle='right-panel-width']");
    for (const label of ["sidebar-width", "right-panel-width"]) {
      const hits = await grabStrip(label);
      const report = `${label} grabbable at dx ${hits.join(",") || "nowhere"}`;
      // 4px each side of the line. Fitts's law, and the number VS Code's sash
      // uses: 1px was the shipped behaviour and it is unusable.
      if (hits.length < 8) throw new Error(`${report} (${hits.length}px wide, want >= 8)`);
      if (!hits.some(dx => dx <= -3)) throw new Error(`${report} (nothing to the left of the line)`);
      if (!hits.some(dx => dx >= 3)) throw new Error(`${report} (nothing to the right of the line)`);
    }
    await archiveTask(taskId);
  });
});

// P0: a split whose pane tabs don't come back must not restore as a blank
// half, and a task must never restore owning zero main tabs. Both were hit by
// the same real layout: main-panel shells are deliberately not durable (no
// session to resume), so moving the only agent into a pane and leaving a shell
// in main persists nothing for main. Found on disk as a saved split_layout
// referencing two tab ids beside an empty persisted tab list.
describe("split restore", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  /** Re-run the real restore path as a COLD start. `ensureDefaultTab` is what
   *  runs on load and bails when main already has tabs, so the in-memory tabs
   *  AND the live split tree both have to go: a relaunch has neither, and
   *  leaving the tree behind would let the assertions pass against state that
   *  never came from disk. */
  const restore = (id: string) =>
    browser.execute((wid) => {
      const s = window.__termic!.useApp;
      const cli = s.getState().tasks.find((t: any) => t.id === wid)?.cli ?? "fakeagent";
      const st = s.getState();
      const { [wid]: _tabs, ...tabsRest } = st.tabs;
      const { [wid]: _tree, ...treeRest } = st.splitTree;
      const { [wid]: _pane, ...paneRest } = st.activePaneId;
      s.setState({
        tabs: { ...tabsRest, [wid]: [] },
        splitTree: treeRest,
        activePaneId: paneRest,
        activeTab: { ...st.activeTab, [wid]: "" },
      });
      s.getState().ensureDefaultTab(wid, cli);
    }, id);

  const leaves = (id: string) =>
    browser.execute((wid) => {
      const tree = window.__termic!.useApp.getState().splitTree[wid];
      if (!tree) return [];
      const walk = (n: any): any[] => n.type === "pane" ? [n] : [...walk(n.a), ...walk(n.b)];
      return walk(tree).map((l: any) => ({ isMain: !!l.isMain, count: (l.tabIds ?? []).length }));
    }, id);

  it("keeps a main tab when every main tab was non-durable", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-split-restore");

    // Reproduce the reported sequence exactly. A plain shell has to go into
    // main FIRST: moveTabToPane refuses to empty main ("main must keep at
    // least one tab"), and that guard counts LIVE main tabs. A shell satisfies
    // it while being non-durable, so main survives the session and restores
    // with nothing. That mismatch is the whole bug.
    await browser.execute((wid) => {
      const s = window.__termic!.useApp.getState();
      const agent = s.tabs[wid][0];
      s.addTab(wid, {
        id: crypto.randomUUID(), type: "terminal", title: "shell", cli: "shell",
      } as any, { focus: false });
      const paneId = s.splitPane(wid, "v");
      window.__termic!.useApp.getState().moveTabToPane(wid, agent.id, paneId);
      const st = window.__termic!.useApp.getState();
      st.syncDurableTabs(wid);
      st.saveSplitLayout(wid);
    }, taskId);

    // Assert the SETUP before the restore, so a failure below can only mean
    // the restore is at fault. Both halves are needed: pane tabs are only
    // rebuilt inside the `if (task.split_layout)` branch, so a durable pane
    // tab with no saved layout is silently dropped.
    const persistedBefore = await browser.execute((wid) => {
      const t = window.__termic!.useApp.getState().tasks.find((x: any) => x.id === wid);
      return {
        layout: t?.split_layout ?? null,
        paneEntries: (t?.persisted_tabs ?? []).filter((p: any) => !!p.pane_leaf_id).length,
        mainEntries: (t?.persisted_tabs ?? []).filter((p: any) => !p.pane_leaf_id).length,
      };
    }, taskId);
    expect(persistedBefore.layout).not.toBeNull();
    expect(persistedBefore.paneEntries).toBeGreaterThan(0);
    expect(persistedBefore.mainEntries).toBe(0);

    await restore(taskId!);

    const after = await browser.execute((wid) => {
      const s = window.__termic!.useApp.getState();
      const tabs = s.tabs[wid] ?? [];
      return {
        mainCount: tabs.filter((t: any) => !t.paneId).length,
        paneCount: tabs.filter((t: any) => !!t.paneId).length,
        activeTab: s.activeTab[wid] ?? "",
      };
    }, taskId);

    // The violated invariant: a task always owns a main tab pointed at by a
    // real activeTab. Previously both were empty and the pane rendered blank.
    expect(after.mainCount).toBeGreaterThan(0);
    expect(after.activeTab).not.toBe("");
    // The durable pane agent still comes back, so the split is still earned.
    expect(after.paneCount).toBeGreaterThan(0);
    await snap("split-restore-main-tab.png");
  });

  it("collapses a pane whose tabs are all gone", async () => {
    // Inject the shape found on disk: a saved layout whose pane references tab
    // ids nothing will restore (session-only editor tabs do exactly this).
    await browser.execute(async (wid) => {
      const t = window.__termic!;
      const tree = {
        type: "split", id: crypto.randomUUID(), dir: "v", ratio: 0.5,
        a: { type: "pane", id: crypto.randomUUID(), isMain: true, tabIds: [], activeTabId: null },
        b: {
          type: "pane", id: crypto.randomUUID(),
          tabIds: ["ghost-a", "ghost-b"], activeTabId: "ghost-b",
        },
      };
      await t.invoke("task_set_split_layout", { id: wid, layout: JSON.stringify(tree) });
      await t.useApp.getState().loadAll();
    }, taskId);

    await restore(taskId!);

    // Every ghost pruned away, so the pane has nothing left and the whole
    // split goes with it rather than restoring as a blank leg.
    for (const l of await leaves(taskId!)) {
      if (!l.isMain) expect(l.count).toBeGreaterThan(0);
    }
    const mainCount = await browser.execute(
      (wid) => (window.__termic!.useApp.getState().tabs[wid] ?? [])
        .filter((t: any) => !t.paneId).length,
      taskId,
    );
    expect(mainCount).toBeGreaterThan(0);
    await snap("split-restore-collapsed.png");
  });
});

// Tab context menu (GH #183): Pin / Unpin plus the two bulk closes. Pinning is
// an ORDERING operation, not just a flag — the pin appends to the pinned block
// at the head of the strip and the unpin drops back to the first slot after it,
// so the cases assert tab order, and that both bulk closes spare pinned tabs.
describe("tab context menu", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Main-strip tab ids, in display order.
  const strip = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? [])
          .filter((t: any) => !t.paneId)
          .map((t: any) => t.id as string),
      taskId,
    );

  // Shell tabs on purpose: closing one is silent, so the bulk-close cases
  // assert the close itself instead of racing a confirm dialog.
  const addShells = (prefix: string, n: number) =>
    browser.execute(
      (id, p, count) => {
        const app = window.__termic!.useApp.getState();
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const tabId = `${p}-${i}`;
          ids.push(tabId);
          app.addTab(id, { id: tabId, type: "terminal", cli: "shell", title: tabId } as any);
        }
        return ids;
      },
      taskId, prefix, n,
    );

  // Dispatched, not gestured: a WebDriver right-click does not reach Radix's
  // onContextMenu in this WKWebView (same gap as its double-click, see
  // files.e2e.ts). The MouseEvent goes through the real trigger, so everything
  // from the menu opening downwards is genuinely exercised.
  const openTabMenu = async (tabId: string) => {
    await browser.execute((id) => {
      const el = document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
      if (!el) throw new Error(`no tab pill ${id}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: r.left + 10, clientY: r.top + 10,
      }));
    }, tabId);
    await browser.waitUntil(async () => (await menuItems()).length > 0, {
      timeout: 8_000,
      timeoutMsg: `the tab context menu never opened for ${tabId}`,
    });
  };

  // Scoped to the menu holding the tab items, never a bare [role="menu"]:
  // menus stack and a closing one can linger (see the e2e skill). Items are the
  // content div's direct children; ContextMenuItem passes role={undefined} for
  // plain items, so an ARIA selector would match nothing.
  const menuItems = () =>
    browser.execute(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes("Close others"),
      ) as HTMLElement | undefined;
      if (!menu) return [] as { label: string; disabled: boolean }[];
      return [...menu.children]
        .map((el) => ({
          label: (el as HTMLElement).innerText?.trim() ?? "",
          disabled: el.hasAttribute("data-disabled"),
        }))
        .filter((i) => i.label.length > 0);
    });

  const clickTabMenuItem = (label: string) =>
    browser.execute((text) => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes("Close others"),
      ) as HTMLElement | undefined;
      if (!menu) throw new Error("the tab context menu is not open");
      const item = [...menu.children].find(
        (i) => (i as HTMLElement).innerText?.trim() === text,
      ) as HTMLElement | undefined;
      if (!item) throw new Error(`no menu item "${text}"`);
      item.click();
    }, label);

  const isPinned = (tabId: string) =>
    browser.execute(
      (id) => !!document.querySelector(`[data-tab-id="${id}"][data-pinned]`),
      tabId,
    );

  const pillWidth = (tabId: string) =>
    browser.execute((wid, id) => {
      const pill = document.querySelector(
        `[data-task-id="${wid}"] [data-tab-id="${id}"]`,
      ) as HTMLElement | null;
      return pill ? Math.round(pill.getBoundingClientRect().width) : -1;
    }, taskId, tabId);

  const tabLiveTitle = (tabId: string) =>
    browser.execute((wid, id) => {
      const tab = (window.__termic!.useApp.getState().tabs[wid] ?? []).find(
        (t: any) => t.id === id,
      );
      return (tab?.liveTitle as string) ?? "";
    }, taskId, tabId);

  // Titles of the pill's own action buttons, which is what the user can click.
  // Run-tab controls (Restart / Stop / Run) would show up here too; these
  // fixtures are plain shells and an agent, so the trailing slot is all there is.
  const pillButtons = (tabId: string) =>
    browser.execute(
      (id) =>
        [...document.querySelectorAll(`[data-tab-id="${id}"] button`)].map(
          (b) => b.getAttribute("title") ?? "",
        ),
      tabId,
    );

  it("pins a tab to the head of the strip", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tabmenu");
    await browser.waitUntil(async () => (await strip()).length === 1, {
      timeout: 20_000,
      timeoutMsg: "agent tab never appeared",
    });
    await ensureActiveTask(taskId);
    await dismissOverlays();

    const [agent] = await strip();
    const [s0, s1, s2] = await addShells("e2e-pin", 3);
    await browser.waitUntil(async () => (await strip()).length === 4, {
      timeout: 8_000, timeoutMsg: "shell tabs never rendered",
    });

    await openTabMenu(s2);
    await clickTabMenuItem("Pin");
    await browser.waitUntil(async () => (await strip())[0] === s2, {
      timeout: 5_000, timeoutMsg: "the pinned tab never moved to the head",
    });
    expect(await strip()).toEqual([s2, agent, s0, s1]);
    expect(await isPinned(s2)).toBe(true);
    await snap("tab-menu-pinned.png");
  });

  it("holds a pinned pill's width steady while its live title changes", async () => {
    const [s2, , s0] = await strip(); // [s2*, agent, s0, s1]
    // A pinned pill sits in the strip's shrink-to-fit region, so a
    // content-sized one would re-measure on every OSC title the agent emits and
    // shove the whole scrolling remainder sideways with it.
    const before = await pillWidth(s2);
    const looseBefore = await pillWidth(s0);
    // The fixed width equals the unpinned max-width, so the pinned pill matches
    // an uncrowded neighbour and holds while a crowded one shrinks below it.
    // Asserted as "never the narrower one" because which of the two reads is
    // true depends on the window width, and the suite pins no window size.
    expect(before).toBeGreaterThanOrEqual(looseBefore);

    // s2 is a REAL shell, and a shell may set its own title when its first
    // prompt appears: Ubuntu's stock ~/.bashrc does (PS1 carries an OSC 0 with
    // user@host: dir). Written after one of the titles below, it replaced it
    // and "live title never became y" failed about one run in three on such a
    // machine. Let the shell say its piece first: the title has to hold still
    // across several reads before this starts writing its own.
    let settled = 0, last: string | null | undefined;
    await browser.waitUntil(async () => {
      const now = await tabLiveTitle(s2);
      settled = now === last ? settled + 1 : 0;
      last = now;
      return settled >= 5;
    }, { timeout: 10_000, interval: 150, timeoutMsg: "the shell's own title never settled" });

    for (const title of ["x", "a considerably longer live title than before", "y"]) {
      await browser.execute((wid, id, t) => {
        window.__termic!.useApp.getState().setTabLiveTitle(wid, id, t);
      }, taskId, s2, title);
      await browser.waitUntil(
        async () => (await tabLiveTitle(s2)) === title,
        { timeout: 5_000, timeoutMsg: `live title never became "${title}"` },
      );
      expect(await pillWidth(s2)).toBe(before);
      // The point of the fixed width: a title change must not shove the
      // scrolling remainder sideways either.
      expect(await pillWidth(s0)).toBe(looseBefore);
    }
  });

  it("trades the close X for an unpin control on a pinned pill", async () => {
    const [s2, agent] = await strip(); // [s2*, agent, s0, s1]
    // A pinned tab must not be one stray click from a dead PTY: the pill
    // offers "Unpin tab" where an unpinned one offers "Close tab".
    expect(await pillButtons(s2)).toEqual(["Unpin tab"]);
    expect(await pillButtons(agent)).toEqual(["Close tab"]);

    // And that control unpins rather than closing: the tab survives, it just
    // leaves the pinned block.
    await browser.execute((id) => {
      const btn = document.querySelector(
        `[data-tab-id="${id}"] button[title="Unpin tab"]`,
      ) as HTMLElement;
      btn.click();
    }, s2);
    await browser.waitUntil(async () => !(await isPinned(s2)), {
      timeout: 5_000, timeoutMsg: "the pin control never unpinned the tab",
    });
    expect(await strip()).toHaveLength(4);
    expect(await pillButtons(s2)).toEqual(["Close tab"]);

    // Put it back so the ordering cases below start where they expect.
    await openTabMenu(s2);
    await clickTabMenuItem("Pin");
    await browser.waitUntil(async () => (await strip())[0] === s2, {
      timeout: 5_000, timeoutMsg: "the tab never went back to the pinned block",
    });
  });

  // GH #369. Dispatched for the same reason the context menu is: what is
  // under test is what the pill does with a middle click, not whether
  // WebDriver can produce one. `auxclick` is the event the browser raises for
  // a non-primary button, and `button: 1` is the middle one.
  it("a middle click closes a tab, and leaves a pinned one alone", async () => {
    const middleClick = (tabId: string) => browser.execute((id) => {
      const el = document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
      if (!el) throw new Error(`no tab pill ${id}`);
      el.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    }, tabId);
    const [s2] = await strip(); // [s2*, agent, s0, s1]
    expect(await isPinned(s2)).toBe(true);
    const before = await strip();

    // A throwaway shell tab, so the cases below still find the strip they expect.
    const [extra] = await addShells("mid", 1);
    await browser.waitUntil(async () => (await strip()).includes(extra), {
      timeout: 5_000, timeoutMsg: "the extra tab never appeared",
    });

    // The two that must do NOTHING go first, so the close below is also the
    // proof they had their chance: a pinned tab ("do not lose this": no close
    // X, and no middle-click close), and the right button on a loose one.
    await middleClick(s2);
    await browser.execute((id) => {
      const el = document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;
      el.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    }, before[1]);

    await middleClick(extra);
    await browser.waitUntil(async () => !(await strip()).includes(extra), {
      timeout: 5_000, timeoutMsg: "a middle click did not close the tab",
    });
    // Only the tab that was middle-clicked is gone.
    expect(await strip()).toEqual(before);
  });

  it("a second pin appends to the END of the pinned block", async () => {
    const [, , s0] = await strip(); // [s2*, agent, s0, s1]
    await openTabMenu(s0);
    await clickTabMenuItem("Pin");
    await browser.waitUntil(async () => (await strip())[1] === s0, {
      timeout: 5_000, timeoutMsg: "the second pin did not land after the first",
    });
  });

  it("unpin drops the tab to the first slot after the pinned block", async () => {
    const [s2, s0] = await strip(); // [s2*, s0*, agent, s1]
    await openTabMenu(s2);
    await clickTabMenuItem("Unpin");
    await browser.waitUntil(async () => (await strip())[0] === s0, {
      timeout: 5_000, timeoutMsg: "the unpinned tab never left the pinned block",
    });
    expect((await strip())[1]).toBe(s2);
    expect(await isPinned(s2)).toBe(false);
  });

  it("close to the right spares pinned tabs", async () => {
    // Pin the agent tab too, so no bulk close can reach it (closing an agent
    // tab would raise a confirm dialog; shells close silently).
    const before = await strip(); // [s0*, s2, agent, s1]
    const agent = before[2];
    await openTabMenu(agent);
    await clickTabMenuItem("Pin");
    await browser.waitUntil(async () => (await strip())[1] === agent, {
      timeout: 5_000, timeoutMsg: "the agent tab never joined the pinned block",
    });

    const [pinnedShell] = await strip(); // [s0*, agent*, s2, s1]
    await openTabMenu(pinnedShell);
    await clickTabMenuItem("Close to the right");
    await browser.waitUntil(async () => (await strip()).length === 2, {
      timeout: 8_000, timeoutMsg: "close to the right never closed the tabs",
    });
    expect(await strip()).toEqual([pinnedShell, agent]);
  });

  it("close others keeps the clicked tab and every pinned tab", async () => {
    const [pinnedShell, agent] = await strip();
    const [keep] = await addShells("e2e-others", 2);
    await browser.waitUntil(async () => (await strip()).length === 4, {
      timeout: 8_000, timeoutMsg: "shell tabs never rendered",
    });

    await openTabMenu(keep);
    await clickTabMenuItem("Close others");
    await browser.waitUntil(async () => (await strip()).length === 3, {
      timeout: 8_000, timeoutMsg: "close others never closed the sibling",
    });
    expect(await strip()).toEqual([pinnedShell, agent, keep]);
  });

  it("disables a bulk close that has nothing to close", async () => {
    const strips = await strip(); // [pinned shell*, agent*, keep]
    await openTabMenu(strips[strips.length - 1]);
    const items = await menuItems();
    const byLabel = (l: string) => items.find((i) => i.label === l);
    // Nothing to its right, and every other tab is pinned.
    expect(byLabel("Close to the right")?.disabled).toBe(true);
    expect(byLabel("Close others")?.disabled).toBe(true);
    expect(byLabel("Close")?.disabled).toBe(false);
    await browser.keys(["Escape"]);
  });
});

// The reason pinning exists (GH #183): a pinned tab must stay in reach when the
// strip overflows. Reordering it to the head is not enough on its own — it has
// to sit OUTSIDE the scroller, so this drives the strip to a real overflow and
// scrolls it to the end.
describe("pinned tabs do not scroll away", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Scoped to THIS task's strip: every visited task stays mounted, so a bare
  // [data-main-strip] can return a hidden copy whose geometry is all zeroes
  // (see the e2e skill) — which reads as "never overflows" forever.
  const geometry = (tabId: string) =>
    browser.execute((wid, id) => {
      const strip = document.querySelector(
        `[data-task-id="${wid}"] [data-main-strip]`,
      ) as HTMLElement | null;
      const scroller = strip?.querySelector("[data-scroll-strip]") as HTMLElement | null;
      const pill = strip?.querySelector(`[data-tab-id="${id}"]`) as HTMLElement | null;
      if (!strip || !scroller || !pill) {
        return { found: false, pillLeft: 0, visible: false, overflowing: false, scrollLeft: 0, scrollWidth: 0, clientWidth: 0 };
      }
      const s = strip.getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      return {
        found: true,
        pillLeft: Math.round(p.left),
        // Fully inside the strip's box = the user can see and click it.
        visible: p.left >= s.left - 1 && p.right <= s.right + 1,
        overflowing: scroller.scrollWidth > scroller.clientWidth + 1,
        scrollLeft: Math.round(scroller.scrollLeft),
        scrollWidth: Math.round(scroller.scrollWidth),
        clientWidth: Math.round(scroller.clientWidth),
      };
    }, taskId, tabId);

  it("keeps a pinned tab in view after the strip is scrolled to the end", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-pinscroll");
    await browser.waitUntil(
      () => browser.execute(
        (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length === 1,
        taskId,
      ),
      { timeout: 20_000, timeoutMsg: "agent tab never appeared" },
    );
    await ensureActiveTask(taskId);
    await dismissOverlays();

    // Pin the agent tab, then flood the strip until it genuinely overflows.
    const agent = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].id as string,
      taskId,
    );
    await browser.execute((id, tab) => {
      window.__termic!.useApp.getState().pinTab(id, tab);
    }, taskId, agent);

    // Size the flood to the real strip: a pill shrinks to min-w 140px, so it
    // takes ceil(width / 140) of them to overflow. A fixed count would silently
    // stop overflowing on a wider window and make the case vacuous.
    const need = Math.ceil((await geometry(agent)).clientWidth / 140) + 3;
    await browser.execute((id, n) => {
      const app = window.__termic!.useApp.getState();
      for (let i = 0; i < n; i++) {
        app.addTab(id, { id: `e2e-flood-${i}`, type: "terminal", cli: "shell", title: `flood ${i}` } as any);
      }
    }, taskId, need);

    // A strip that does not overflow would make every assertion below vacuous,
    // so fail loudly WITH the measurements rather than passing on nothing.
    let g = await geometry(agent);
    try {
      await browser.waitUntil(async () => (g = await geometry(agent)).overflowing, { timeout: 10_000 });
    } catch {
      throw new Error(`the tab strip never overflowed: ${JSON.stringify(g)}`);
    }

    const before = await geometry(agent);
    expect(before.visible).toBe(true);

    // Scroll the unpinned remainder all the way to its end.
    await browser.execute((wid) => {
      const scroller = document.querySelector(
        `[data-task-id="${wid}"] [data-main-strip] [data-scroll-strip]`,
      ) as HTMLElement;
      scroller.scrollLeft = scroller.scrollWidth;
    }, taskId);
    await browser.waitUntil(async () => (await geometry(agent)).scrollLeft > 0, {
      timeout: 5_000, timeoutMsg: "the strip never scrolled",
    });

    // The pinned pill has not moved a pixel and is still fully in the bar.
    const after = await geometry(agent);
    expect(after.visible).toBe(true);
    expect(after.pillLeft).toBe(before.pillLeft);
    await snap("tab-pinned-stays-visible.png");
  });
});

// ⌃⇥ walks the places you actually looked at, newest first, instead of the
// positional order every other navigation key in the app uses. It is a
// GESTURE, not a binding: the ring is snapshotted on the first tap, each tap
// switches live, and releasing the held modifier lands. Both halves are
// recordable (Settings, `prefs.recentTabsGesture`), so the walk here is
// parameterized by the gesture it drives.
//
// The keys are dispatched at the terminal's own textarea rather than at
// `window`, because "does xterm eat this?" is the entire risk. xterm listens
// there in the capture phase and its `cancel()` calls stopPropagation, so a
// spec that dispatched at `window` would pass while the feature was dead in
// every real terminal.
//
// They are SYNTHETIC, and cannot be otherwise: the driver cannot hold Control.
// `browser.action("key").down(Key.Control)` does deliver a Control keydown and
// keyup, but every key pressed in between still arrives with `ctrlKey: false`
// — Meta propagates, Control does not. So these cases prove the handler, the
// ordering against xterm, and every rule of the walk; whether macOS hands ⌃⇥
// to the webview at all is the part only a human at the keyboard can
// confirm. See docs/e2e-tests.md.
describe("recently-used tab navigation", () => {
  let a!: string, b!: string, c!: string;

  /** One gesture, as the events a real keyboard would send for it. `keyCode`
   *  on both, not just `key`: xterm's evaluateKeyboardEvent switches on
   *  keyCode, so an event without it would never have reached the PTY and
   *  proves nothing about what we took from it. */
  type Gesture = {
    holdKey: string; holdCode: string; holdKeyCode: number;
    holdFlag: "ctrlKey" | "altKey" | "metaKey";
    key: string; code: string; keyCode: number;
  };
  const CTRL_TAB: Gesture = {
    holdKey: "Control", holdCode: "ControlLeft", holdKeyCode: 17, holdFlag: "ctrlKey",
    key: "Tab", code: "Tab", keyCode: 9,
  };
  // An Option / Alt hold the recorder accepts on this platform: Option + Tab
  // on macOS, Alt + F9 elsewhere (Alt + Tab is the desktop's, Alt + a
  // character is Meta to the terminal). Tab rather than Option + `, which
  // also records on macOS, because xterm WOULD send a Tab for Option + Tab
  // (and nothing for the dead key), so the no-bytes case below is only
  // proof with Tab. The stored value is what the walk reads, so it is set
  // to exactly what Settings would record.
  const MAC = process.platform === "darwin";
  const ALT_HOLD: Gesture = MAC
    ? { holdKey: "Alt", holdCode: "AltLeft", holdKeyCode: 18, holdFlag: "altKey", key: "Tab", code: "Tab", keyCode: 9 }
    : { holdKey: "Alt", holdCode: "AltLeft", holdKeyCode: 18, holdFlag: "altKey", key: "F9", code: "F9", keyCode: 120 };
  const ALT_HOLD_PREF = { hold: "alt", code: ALT_HOLD.code };

  /** Watch what reaches a PTY, at `fetch`, where a Tauri command leaves the
   *  page (`__TAURI_INTERNALS__.invoke` is neither writable nor
   *  configurable). The same rig as shortcuts-linux.e2e.ts. */
  const watchPty = () => browser.execute(() => {
    const w = window as unknown as { __ptyOut?: number[]; __ptyWatched?: boolean };
    w.__ptyOut = [];
    if (w.__ptyWatched) return;
    w.__ptyWatched = true;
    const real = window.fetch;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      try {
        const url = String((input as Request).url ?? input);
        if (url.endsWith("/pty_write") && typeof init?.body === "string") {
          w.__ptyOut!.push(...(JSON.parse(init.body).data as number[]));
        }
      } catch { /* not ours to break */ }
      return real.call(this, input, init);
    } as typeof window.fetch;
  });
  /** Bytes written to any PTY since the last call. */
  const ptyBytes = () => browser.execute(() => {
    const w = window as unknown as { __ptyOut?: number[] };
    const out = w.__ptyOut ?? [];
    w.__ptyOut = [];
    return out;
  }) as unknown as Promise<number[]>;
  /** One plain key at the task's visible terminal. */
  const typeKey = (taskId: string, key: string, code: string, keyCode: number) =>
    browser.execute((id, k, c, kc) => {
      const host = document.querySelector(`[data-task-id="${id}"]`)!;
      const ta = [...host.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")]
        .find(el => {
          const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })!;
      ta.focus();
      const ev = { bubbles: true, cancelable: true, key: k, code: c, keyCode: kc, which: kc };
      ta.dispatchEvent(new KeyboardEvent("keydown", ev));
      ta.dispatchEvent(new KeyboardEvent("keyup", ev));
    }, taskId, key, code, keyCode);

  // Restored even when a case throws half way: the gesture and the switch
  // are synced prefs, and a rebound walk would break every later spec that
  // presses ⌃⇥.
  let originalGesture: unknown = null;
  let originalMode: string | null = null;
  after(async () => {
    await browser.execute((g, m) => {
      const p = window.__termic!.usePrefs.getState();
      if (g) p.setRecentTabsGesture(g as any);
      if (m) p.setCtrlTabMode(m as any);
    }, originalGesture, originalMode);
    for (const id of [a, b, c]) if (id) await archiveTask(id);
  });

  /** The task the user can actually see. Hidden ones stay mounted (PTYs), so
   *  this reads the rendered geometry rather than the store. */
  const visibleTask = () =>
    browser.execute(() =>
      [...document.querySelectorAll("[data-task-id]")]
        .find(el => el.getBoundingClientRect().width > 0)
        ?.getAttribute("data-task-id") ?? null);

  /** Hold the gesture's modifier, tap its key once per entry (true = with
   *  Shift), release. ⌃⇥ unless told otherwise. */
  const walk = (taskId: string, taps: boolean[], g: Gesture = CTRL_TAB) =>
    browser.execute((id, presses: boolean[], gesture: Gesture) => {
      const host = document.querySelector(`[data-task-id="${id}"]`);
      if (!host) throw new Error(`task ${id} is not mounted`);
      const ta = [...host.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")]
        .find(el => {
          const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      if (!ta) throw new Error(`no visible terminal in ${id}`);
      ta.focus();
      const hold = {
        key: gesture.holdKey, code: gesture.holdCode,
        keyCode: gesture.holdKeyCode, which: gesture.holdKeyCode,
      };
      const base = { bubbles: true, cancelable: true };
      ta.dispatchEvent(new KeyboardEvent("keydown", { ...base, ...hold, [gesture.holdFlag]: true }));
      for (const shift of presses) {
        const k = {
          ...base, key: gesture.key, code: gesture.code,
          keyCode: gesture.keyCode, which: gesture.keyCode,
          [gesture.holdFlag]: true, shiftKey: shift,
        };
        ta.dispatchEvent(new KeyboardEvent("keydown", k));
        ta.dispatchEvent(new KeyboardEvent("keyup", k));
      }
      ta.dispatchEvent(new KeyboardEvent("keyup", { ...base, ...hold, [gesture.holdFlag]: false }));
    }, taskId, taps, g);

  /** Select a task and wait for it, so the recency order is deterministic.
   *  One round trip per visit: the tracker coalesces within a microtask, which
   *  is what stops a task+tab pair recording twice. */
  const visit = async (id: string) => {
    await ensureActiveTask(id);
    await browser.waitUntil(async () => (await visibleTask()) === id,
      { timeout: 10_000, timeoutMsg: `task ${id} never became visible` });
  };

  const waitVisibleTask = (id: string, why: string) =>
    browser.waitUntil(async () => (await visibleTask()) === id,
      { timeout: 10_000, timeoutMsg: why });

  /** The walk did NOT move. Asserted after a settle, not immediately: the
   *  switch is asynchronous, so an instant check would pass against the
   *  broken behaviour too. The settle is written at each call site, not in
   *  here, so e2e/fixedWaits.test.ts counts every 500ms this file spends. */
  const expectStillOn = async (id: string) => {
    expect(await visibleTask()).toBe(id);
  };

  it("steps back to where you just were, and lands there on release", async () => {
    await waitForAppShell();
    await requireTermicApi();
    [originalGesture, originalMode] = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return [p.recentTabsGesture, p.ctrlTabMode] as [unknown, string];
    });
    // From the default, whatever an earlier run left behind.
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setRecentTabsGesture({ hold: "ctrl", code: "Tab" });
      p.setCtrlTabMode("on");
    });
    a = await openTask("e2e-ctrltab-a");
    b = await openTask("e2e-ctrltab-b");
    c = await openTask("e2e-ctrltab-c");
    for (const id of [a, b, c]) {
      await browser.waitUntil(
        () => browser.execute(
          (i) => (window.__termic!.useApp.getState().tabs[i] ?? []).length > 0, id),
        { timeout: 20_000, timeoutMsg: `task ${id} never got its agent tab` });
    }

    await visit(a); await visit(b); await visit(c);
    await walk(c, [false]);
    await waitVisibleTask(b, "one tap did not go back to the previous task");
    await snap("ctrl-tab-one-step");
  });

  it("goes further back the more you tap, inside one hold", async () => {
    await visit(a); await visit(b); await visit(c);
    await walk(c, [false, false]);
    await waitVisibleTask(a, "two taps did not reach two places back");
  });

  it("reverses under Shift without ending the walk", async () => {
    // The Shift keydown arrives BEFORE the Tab it modifies. Treating any
    // non-Tab key as the end of the gesture would make this impossible.
    await visit(a); await visit(b); await visit(c);
    await walk(c, [false, false, true]);
    await waitVisibleTask(b, "Shift did not step back towards the start");
  });

  it("landing reorders the list, so the next tap returns", async () => {
    // This is what makes it a recency ring rather than a cursor: after
    // stopping on B, the place you came FROM is now the most recent one.
    await visit(a); await visit(b); await visit(c);
    await walk(c, [false]);
    await waitVisibleTask(b, "first walk did not land on B");
    await walk(b, [false]);
    await waitVisibleTask(c, "the return tap did not go back to C");
  });

  it("does not disturb a badge it passes over", async () => {
    // Selecting a task normally means "I have seen this" and clears its
    // badges. A place that was on screen for 80ms on the way somewhere else
    // has not been seen, and nothing would put the badge back.
    await visit(a); await visit(b); await visit(c);
    const bTab = await browser.execute(
      (id) => window.__termic!.useApp.getState().activeTab[id], b);
    await browser.execute((id, tab) => {
      window.__termic!.useApp.getState().setWorkState(id, tab, "done");
    }, b, bTab);
    await browser.waitUntil(async () => (await sidebarBadge(b)) === "done",
      { timeout: 10_000, timeoutMsg: "task B never showed a done badge" });

    // Walk C → B → A: B is passed THROUGH, and must keep its badge.
    await walk(c, [false, false]);
    await waitVisibleTask(a, "the walk did not pass through B to A");
    expect(await sidebarBadge(b)).toBe("done");

    // Control: landing on it DOES clear it, which is the whole distinction.
    await visit(b);
    await browser.waitUntil(async () => (await sidebarBadge(b)) === null,
      { timeout: 10_000, timeoutMsg: "landing on B did not clear its done badge" });
  });

  it("leaves a plain Tab to the agent", async () => {
    // The gesture takes ⌃⇥ from the terminal, which costs it nothing (xterm
    // sends ⌃⇥ as a plain tab anyway). Unmodified Tab must be untouched.
    await visit(a); await visit(b); await visit(c);
    await browser.execute((id) => {
      const host = document.querySelector(`[data-task-id="${id}"]`)!;
      const ta = [...host.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")]
        .find(el => {
          const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })!;
      ta.focus();
      const k = { bubbles: true, cancelable: true, key: "Tab", code: "Tab", keyCode: 9, which: 9 };
      ta.dispatchEvent(new KeyboardEvent("keydown", k));
      ta.dispatchEvent(new KeyboardEvent("keyup", k));
    }, c);
    // The walk switches asynchronously: give it a window to fail in.
    await browser.pause(500);
    await expectStillOn(c);
  });

  it("stands down while Settings is open", async () => {
    // Selecting a task replaces `view` wholesale, so a walk under the overlay
    // would close Settings out from under the user.
    await visit(a); await visit(b); await visit(c);
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("shortcuts"));
    await waitVisible("[data-testid='ctrl-tab-mode']");
    await walk(c, [false]);
    // The walk switches asynchronously: give it a window to fail in.
    await browser.pause(500);
    await expectStillOn(c);
    expect(await browser.execute(
      () => window.__termic!.useApp.getState().view.settingsOpen)).toBe(true);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await waitGone("[data-testid='ctrl-tab-mode']");
  });

  it("stands down when it is switched off", async () => {
    await visit(a); await visit(b); await visit(c);
    await browser.execute(() => window.__termic!.usePrefs.getState().setCtrlTabMode("off"));
    try {
      await walk(c, [false]);
      // The walk switches asynchronously: give it a window to fail in.
      await browser.pause(500);
      await expectStillOn(c);
    } finally {
      await browser.execute(() => window.__termic!.usePrefs.getState().setCtrlTabMode("on"));
    }
    // And back on, the same keys walk again: off was the switch, not the key.
    await walk(c, [false]);
    await waitVisibleTask(b, "switching the gesture back on did not bring it back");
  });

  it("walks on a rebound gesture, and lands when Option comes up", async () => {
    await browser.execute((g) =>
      window.__termic!.usePrefs.getState().setRecentTabsGesture(g as any), ALT_HOLD_PREF);
    try {
      await visit(a); await visit(b); await visit(c);
      await walk(c, [false], ALT_HOLD);
      await waitVisibleTask(b, "the Option hold did not step back to the previous task");
      // Landing is what reorders the ring: the return tap only goes back to
      // C if the Option release landed the first walk on B.
      await walk(b, [false], ALT_HOLD);
      await waitVisibleTask(c, "the Option release did not land the walk");
      // Shift reverses on a rebound gesture too.
      await visit(a); await visit(b); await visit(c);
      await walk(c, [false, false, true], ALT_HOLD);
      await waitVisibleTask(b, "Shift did not reverse the Option walk");
    } finally {
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Tab" }));
    }
  });

  it("sends nothing to the PTY while it walks on an Option hold", async () => {
    // With Option as Meta, xterm would send the tapped key down as an ESC
    // sequence; the capture-phase claim is what keeps it out.
    await browser.execute((g) =>
      window.__termic!.usePrefs.getState().setRecentTabsGesture(g as any), ALT_HOLD_PREF);
    try {
      await visit(a); await visit(b); await visit(c);
      await watchPty();
      // The control: the rig sees a plain key typed into this terminal at
      // all, or the empty result below would prove nothing. Backspace after
      // it, so the agent's prompt is left as it was.
      await typeKey(c, "x", "KeyX", 88);
      await browser.waitUntil(async () => (await ptyBytes()).includes(0x78), {
        timeout: 5_000, timeoutMsg: "a typed x never reached the PTY, so the rig sees no writes",
      });
      await typeKey(c, "Backspace", "Backspace", 8);
      await browser.waitUntil(async () => (await ptyBytes()).length === 0, {
        timeout: 5_000, timeoutMsg: "the PTY writes never went quiet",
      });
      await walk(c, [false, true, false], ALT_HOLD);
      await waitVisibleTask(b, "the Option walk did not move");
      // The landing is what would have flushed a byte, and it has happened.
      expect(await ptyBytes()).toEqual([]);
    } finally {
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Tab" }));
    }
  });

  it("leaves the old ⌃⇥ inert once the gesture is rebound", async () => {
    await browser.execute((g) =>
      window.__termic!.usePrefs.getState().setRecentTabsGesture(g as any), ALT_HOLD_PREF);
    try {
      await visit(a); await visit(b); await visit(c);
      await walk(c, [false], CTRL_TAB);
      // The walk switches asynchronously: give it a window to fail in.
      await browser.pause(500);
      await expectStillOn(c);
    } finally {
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().setRecentTabsGesture({ hold: "ctrl", code: "Tab" }));
    }
    // Restored: ⌃⇥ walks again.
    await walk(c, [false]);
    await waitVisibleTask(b, "⌃⇥ did not come back after the reset");
  });
});

// The compact rail is one icon per task, so its tooltip has to say what is
// INSIDE the task: every terminal with the title the expanded tree shows, and
// its state. Top-aligned with the icon, since it is taller than the tile. The
// rail scrolls with no visible bar.
describe("compact rail", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      const s = window.__termic!.useApp.getState();
      if (s.compactSidebar) s.toggleCompactSidebar();
    });
    if (taskId) await archiveTask(taskId);
  });

  it("lists the task's terminals in its tooltip, level with the icon", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-rail-tip");
    await browser.execute(() => {
      const s = window.__termic!.useApp.getState();
      if (!s.compactSidebar) s.toggleCompactSidebar();
    });
    const trigger = `[data-rail-task-id="${taskId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      document.querySelector(sel)!.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    }, trigger);
    await waitVisible('[data-testid="compact-task-tip"]');
    const tip = await browser.execute((sel) => {
      const t = document.querySelector('[data-testid="compact-task-tip"]')!;
      const box = (t.closest('[data-side]') ?? t).getBoundingClientRect();
      const icon = document.querySelector(sel)!.getBoundingClientRect();
      return {
        text: (t as HTMLElement).innerText,
        rows: t.querySelectorAll('[data-testid="compact-task-tip-tab"]').length,
        topDelta: Math.round(box.top - icon.top),
      };
    }, trigger);
    expect(tip.text).toContain("e2e-rail-tip");
    expect(tip.rows).toBeGreaterThanOrEqual(1);
    // Level with the icon, not centred on it (a few px of border/padding).
    expect(Math.abs(tip.topDelta)).toBeLessThanOrEqual(6);
    await snap("compact-rail-tooltip.png");
  });

  it("scrolls without a visible scrollbar", async () => {
    // Measured as the space a scrollbar takes, not as `scrollbar-width`:
    // macOS 14's WebKit (the CI runner) predates that property and reads it
    // back as something else, while the `::-webkit-scrollbar` half of
    // `.no-scrollbar` hides the bar there all the same.
    const bar = await browser.execute(() => {
      const el = document.querySelector('[data-rail-task-id]')!.closest(".overflow-y-auto") as HTMLElement;
      return { cls: el.classList.contains("no-scrollbar"), gutter: el.offsetWidth - el.clientWidth };
    });
    expect(bar.cls).toBe(true);
    expect(bar.gutter).toBe(0);
    await snap("compact-rail.png");
  });
});
