import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  clickByText,
  waitForText,
  snap,
} from "../helpers";

// Git integration is central to termic (every task is a worktree/checkout).
// This guards the Git panel: switching to it shows the working-tree status.
// The seeded fixture-repo has a single commit and no edits, so the state is
// deterministically clean.
describe("git panel", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("shows a clean working tree for the fixture repo", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git");

    // Switch the right panel from "All files" to "Git" (a real click).
    await clickByText("Git");

    // The Git status is fetched async; the clean-tree copy appears once it
    // resolves. waitForText auto-retries, so no sleep and no flake.
    await waitForText("Working tree is clean");

    await snap("git-panel.png");
  });
});
