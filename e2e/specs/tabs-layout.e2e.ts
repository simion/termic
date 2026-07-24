import { archiveTask, clickByText, clickMenuItem, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// Tabs are how a task holds multiple terminals/agents/editors. Guards adding a
// tab through the "+" menu and switching the active tab by clicking it.
describe("tab management", () => {
  let taskId: string | undefined;
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

    // Open the tab bar's "+" menu (the button carrying the lucide plus icon,
    // scoped to the main tab strip). Radix opens the menu on pointerdown, so a
    // bare .click() isn't enough — dispatch the pointer sequence.
    await browser.execute(() => {
      const strip = document.querySelector("[data-main-strip]");
      const plus = [...(strip?.querySelectorAll("button") ?? [])].find((b) =>
        b.querySelector("svg.lucide-plus"),
      );
      if (!plus) throw new Error("tab '+' button not found");
      const el = plus as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    });
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
    await clickMenuItem("Terminal");

    // Now two tabs, and the new terminal is the active one.
    await browser.waitUntil(async () => (await tabCount()) === 2, {
      timeout: 10_000,
      timeoutMsg: "terminal tab was not added",
    });
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
});

// Renaming a tab (double-click -> inline edit -> Enter) is a common action and
// exercises the controlled-input + persist path. Guards that the committed
// name lands in the store.
describe("tab rename", () => {
  let taskId: string | undefined;
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
  let taskId: string | undefined;
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

  const openPicker = () =>
    browser.execute(() => {
      // The picker trigger is the Sun/Moon button in the top bar; it opens on
      // hover, so dispatch the enter/over events React's onMouseEnter watches.
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.querySelector("svg.lucide-sun, svg.lucide-moon"),
      );
      if (!btn) throw new Error("theme picker trigger not found");
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });

  it("switches theme via the picker and applies it to <html>", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await browser.execute(
      () => window.__termic!.usePrefs.getState().themeMode,
    );

    await openPicker();
    await clickByText("Light");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.usePrefs.getState().themeMode === "light" &&
            document.documentElement.classList.contains("light"),
        ),
      { timeout: 8_000, timeoutMsg: "Light theme was not applied to <html>" },
    );

    await openPicker();
    await clickByText("Dark+");
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
});
