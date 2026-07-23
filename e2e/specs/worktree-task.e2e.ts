import { execSync } from "node:child_process";
import path from "node:path";
import { waitForAppShell, requireTermicApi, snap } from "../helpers";

// P2: creating a WORKTREE task (branch in its own working dir), vs the repo-root
// tasks the rest of the suite uses. Verifies it lands on its own branch, then
// archives it (removes the worktree) and prunes the branch.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const BRANCH = "e2e-wt-branch";

describe("worktree task", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.taskArchive(id, true); // deleteBranch
        await window.__termic!.useApp.getState().loadAll();
      }, taskId);
    }
    try {
      execSync(`git -C "${fixture}" worktree prune`);
      execSync(`git -C "${fixture}" branch -D ${BRANCH}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  });

  it("creates a task on its own worktree branch", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const t = await browser.execute(async (branch) => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await window.__termic!.ipc.taskCreate({
        project_id: proj.id,
        name: "e2e-wt",
        cli: "fakeagent",
        base_branch: "main",
        branch,
      });
      await window.__termic!.useApp.getState().loadAll();
      return task;
    }, BRANCH);
    taskId = (t as any).id;

    // It's a worktree: on its own branch, not the main checkout.
    expect((t as any).branch).toBe(BRANCH);
    expect((t as any).is_main_checkout).not.toBe(true);
    await snap("worktree-task.png");
  });
});
