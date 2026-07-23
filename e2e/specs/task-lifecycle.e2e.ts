import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  waitForText,
  snap,
} from "../helpers";

// P1: task rename + permanent delete (distinct from archive). Cases: renaming
// updates the store and the sidebar; deleting removes the task entirely (not
// just archived).
describe("task lifecycle", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const id of cleanup) {
      const exists = await browser.execute(
        (i) => window.__termic!.useApp.getState().tasks.some((t: any) => t.id === i),
        id,
      );
      if (exists) await archiveTask(id);
    }
  });

  it("renames a task (store + sidebar)", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const id = await openTask("e2e-life-rename");
    cleanup.push(id);

    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskRename(i, "renamed-task");
      await window.__termic!.useApp.getState().loadAll();
    }, id);

    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .tasks.find((t: any) => t.id === i)?.name === "renamed-task",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "task name never updated in the store" },
    );
    // The sidebar reflects the new name.
    await waitForText("renamed-task");
  });

  it("deletes a task permanently", async () => {
    const id = await openTask("e2e-life-delete", false);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskDelete(i);
      await window.__termic!.useApp.getState().loadAll();
    }, id);

    // Gone entirely — not present in the tasks list at all (archived or not).
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            !window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.id === i),
          id,
        ),
      { timeout: 8_000, timeoutMsg: "deleted task still present" },
    );
    await snap("task-lifecycle.png");
  });
});
