import {
  waitForAppShell,
  requireTermicApi,
  artifact,
} from "../helpers";

// The task lifecycle's other half: archiving. Guards the archive path (which
// on a real worktree task removes the checkout) and the store transition that
// moves a task out of the active board and into History.
describe("task archive", () => {
  it("archives a task and removes it from the active list", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // A repo-root task (task_open_repo): archiving it never rm -rf's a
    // worktree, so this fixture is safe to create and destroy repeatedly.
    const taskId = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "e2e-archive");
      await t.useApp.getState().loadAll();
      return task.id as string;
    });

    // Precondition: it exists and is active (not archived).
    const activeBefore = await browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.some((t: any) => t.id === id && !t.archived),
      taskId,
    );
    expect(activeBefore).toBe(true);

    // Archive it (deleteBranch defaults off).
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskArchive(id);
      await t.useApp.getState().loadAll();
    }, taskId);

    // It is now archived and gone from the active set.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const task = window.__termic!.useApp
            .getState()
            .tasks.find((t: any) => t.id === id);
          return !!task && task.archived === true;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "task never became archived" },
    );
    const stillActive = await browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.some((t: any) => t.id === id && !t.archived),
      taskId,
    );
    expect(stillActive).toBe(false);

    await browser.saveScreenshot(artifact("task-archive.png"));
  });
});
