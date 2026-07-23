import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  clickMenuItem,
  artifact,
} from "../helpers";

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

    await browser.saveScreenshot(artifact("tabs.png"));
  });
});
