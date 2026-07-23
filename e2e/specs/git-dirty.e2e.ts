import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  clickByText,
  waitForTextGone,
  artifact,
} from "../helpers";

// P0: the Git panel must reflect real working-tree changes. Modifies README on
// disk, forces a git refresh, and asserts the panel leaves the clean state and
// git status reports the file. Restores README on teardown so the clean-tree
// spec (git-panel) is unaffected.
describe("git dirty tree", () => {
  let taskId: string | undefined;
  let original: string | undefined;

  after(async () => {
    if (taskId && original !== undefined) {
      await browser.execute(
        (id, c) => window.__termic!.ipc.taskFileWrite(id, "README.md", c),
        taskId,
        original,
      );
    }
    if (taskId) await archiveTask(taskId);
  });

  it("lists a modified file after the tree changes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git-dirty");
    original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );

    // Open the Git panel (starts clean).
    await clickByText("Git");

    // Dirty the tree, then force the panel's git poll to re-fetch.
    await browser.execute(async (id, c) => {
      await window.__termic!.ipc.taskFileWrite(id, "README.md", c + "\nedited by e2e\n");
      window.__termic!.useApp.getState().bumpGitRevision(id);
    }, taskId, original);

    // The clean-tree message goes away...
    await waitForTextGone("Working tree is clean");

    // ...and git status reports README as changed.
    await browser.waitUntil(
      () =>
        browser.execute(async (id) => {
          const st = await window.__termic!.ipc.taskGitStatus(id);
          return JSON.stringify(st).includes("README.md");
        }, taskId),
      { timeout: 10_000, timeoutMsg: "git status never reported README changed" },
    );

    await browser.saveScreenshot(artifact("git-dirty.png"));
  });
});
