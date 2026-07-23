import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// P1: per-task sandbox. Enable enforce mode then turn it off via taskSetSandbox
// (killLive=false so the running PTY isn't disrupted) and assert the task's
// sandbox mode follows.
describe("task sandbox", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.taskSetSandbox(id, "off", [], [], false);
        await window.__termic!.useApp.getState().loadAll();
      }, taskId);
      await archiveTask(taskId);
    }
  });

  const mode = () =>
    browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.id === id)?.sandbox_mode,
      taskId,
    );

  it("enables enforce mode", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-sandbox");
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskSetSandbox(id, "enforce", [], [], false);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
    await browser.waitUntil(async () => (await mode()) === "enforce", {
      timeout: 8_000,
      timeoutMsg: "sandbox never became enforce",
    });
  });

  it("turns the sandbox off", async () => {
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskSetSandbox(id, "off", [], [], false);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
    await browser.waitUntil(async () => (await mode()) === "off", {
      timeout: 8_000,
      timeoutMsg: "sandbox never turned off",
    });
    await browser.saveScreenshot(artifact("sandbox.png"));
  });
});
