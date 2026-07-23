import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// P1: commit-and-push. Points the fixture at a throwaway bare remote, commits
// with push=true, and asserts the remote received the commit. Fully restores
// the fixture (reset, remove remote, clean) on teardown.
const fixture = path.join(process.cwd(), ".e2e", "fixture-repo");

describe("git commit & push", () => {
  let taskId: string | undefined;
  let headSha = "";
  let bare = "";

  before(() => {
    headSha = execSync(`git -C "${fixture}" rev-parse HEAD`).toString().trim();
    bare = mkdtempSync(path.join(os.tmpdir(), "e2e-bare-"));
    execSync(`git init --bare -q "${bare}"`);
    try {
      execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
    } catch {
      /* none */
    }
    execSync(`git -C "${fixture}" remote add origin "${bare}"`);
  });
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" branch --unset-upstream`, { stdio: "ignore" });
    } catch {
      /* no upstream */
    }
    execSync(`git -C "${fixture}" reset --hard ${headSha}`);
    try {
      execSync(`git -C "${fixture}" remote remove origin`);
    } catch {
      /* none */
    }
    execSync(`git -C "${fixture}" clean -fd`);
    rmSync(bare, { recursive: true, force: true });
  });

  it("commits and pushes to the remote", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-push");

    await browser.execute(async (id) => {
      const orig = await window.__termic!.ipc.taskFileRead(id, "README.md");
      await window.__termic!.ipc.taskFileWrite(id, "README.md", orig + "\npush-test\n");
      await window.__termic!.ipc.taskStage(id, "", ["README.md"]);
      await window.__termic!.ipc.taskCommit(
        id,
        "",
        "e2e push commit",
        "",
        false,
        true, // push
      );
    }, taskId);

    // The bare remote received the commit.
    const log = execSync(
      `git -C "${bare}" log --oneline main 2>/dev/null || true`,
    ).toString();
    expect(log).toContain("e2e push commit");
    await browser.saveScreenshot(artifact("commit-push.png"));
  });
});
