import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// termic's core promise: many parallel agents, each in its own task, all
// alive at once. This guards that two tasks run independent PTYs, that a task
// stays alive when it's not the active one (panes are kept mounted), and that
// switching the active task works.
describe("multi-task isolation", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  const waitForPty = (id: string, label: string) =>
    browser.waitUntil(
      () =>
        browser.execute((i) => {
          const tabs = window.__termic!.useApp.getState().tabs[i] ?? [];
          return tabs.length > 0 && !!tabs[0].ptyId;
        }, id),
      { timeout: 20_000, interval: 250, timeoutMsg: `${label} PTY never spawned` },
    );
  const ptyOf = (id: string) =>
    browser.execute(
      (i) => window.__termic!.useApp.getState().tabs[i][0].ptyId as string,
      id,
    );
  const activeTask = () =>
    browser.execute(() => window.__termic!.useApp.getState().activeTaskId);

  it("runs two tasks with independent PTYs and switches between them", async () => {
    await waitForAppShell();
    await requireTermicApi();

    a = await openTask("e2e-multi-a"); // spawns + becomes active
    await waitForPty(a, "task A");
    const ptyA = await ptyOf(a);

    b = await openTask("e2e-multi-b"); // spawns + becomes active
    await waitForPty(b, "task B");
    expect(await activeTask()).toBe(b);

    // Both PTYs are alive and DISTINCT, and A survived going inactive
    // (termic keeps background task panes mounted).
    const ptyB = await ptyOf(b);
    const ptyAstill = await ptyOf(a);
    expect(ptyAstill).toBe(ptyA);
    expect(ptyB).not.toBe(ptyA);

    // Switch back to A (the store action a sidebar click triggers).
    await browser.execute(
      (id) => window.__termic!.useApp.getState().setActiveTask(id),
      a,
    );
    expect(await activeTask()).toBe(a);

    await browser.saveScreenshot(artifact("multi-task.png"));
  });
});
