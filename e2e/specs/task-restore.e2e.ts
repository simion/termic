import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  clickByText,
  waitForText,
  artifact,
} from "../helpers";

// Completes the task lifecycle: archive -> it appears in History -> restore ->
// it's active again. Guards the History view's filtering and the restore path.
describe("task restore", () => {
  let taskId: string | undefined;
  after(async () => {
    // Leave it archived (out of the active board) for the next run.
    if (taskId) await archiveTask(taskId);
  });

  it("restores an archived task from History", async () => {
    await waitForAppShell();
    await requireTermicApi();

    taskId = await openTask("e2e-restore", false);
    await archiveTask(taskId);

    // Navigate to History (real click) and confirm the task is listed there.
    await clickByText("History");
    await waitForText("e2e-restore");

    // Restore it. The hover-gated "Restore ->" button wraps exactly this call;
    // we invoke it directly so the assertion isn't at the mercy of a hover.
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRestore(id);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);

    // The task is active again (no longer archived).
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const task = window.__termic!.useApp
            .getState()
            .tasks.find((t: any) => t.id === id);
          return !!task && task.archived === false;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "task was never restored to active" },
    );

    await browser.saveScreenshot(artifact("task-restore.png"));
  });
});
