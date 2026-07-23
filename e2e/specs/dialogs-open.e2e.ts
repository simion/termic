import {
  waitVisible,
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P2: assorted dialogs/palettes open + close. Guards the wiring of the
// shortcuts help, prompt palette, and per-task broadcast dialog.
describe("dialogs & palettes open", () => {
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeShortcutsHelp?.();
      ui.closePromptPalette?.();
      ui.closeBroadcast?.();
    });
    if (taskId) await archiveTask(taskId);
  });

  const dialogPresent = () =>
    browser.execute(() => !!document.querySelector('[role="dialog"]'));
  const flag = (name: string) =>
    browser.execute(
      (n) => (window.__termic!.useUI.getState() as any)[n],
      name,
    );

  it("shortcuts help opens and closes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() =>
      window.__termic!.useUI.getState().openShortcutsHelp(),
    );
    await browser.waitUntil(async () => (await flag("shortcutsHelpOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "shortcuts help never opened",
    });
    await waitVisible('[role="dialog"]');
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeShortcutsHelp(),
    );
    await browser.waitUntil(
      async () => (await flag("shortcutsHelpOpen")) === false,
      { timeout: 5_000, timeoutMsg: "shortcuts help never closed" },
    );
  });

  it("prompt palette opens", async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().openPromptPalette(),
    );
    await browser.waitUntil(async () => (await flag("promptPaletteOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "prompt palette never opened",
    });
    await browser.execute(() =>
      window.__termic!.useUI.getState().closePromptPalette(),
    );
  });

  it("broadcast dialog opens for a task", async () => {
    taskId = await openTask("e2e-broadcast");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openBroadcast(id),
      taskId,
    );
    await waitVisible('[role="dialog"]', 8_000);
    await snap("dialogs-open.png");
  });
});
