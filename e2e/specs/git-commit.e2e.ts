import { execSync } from "node:child_process";
import path from "node:path";
import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// P1: the staging + commit backend (Fork-style). Cases: a changed file can be
// staged (moves to the staged list), and committing it leaves the tree clean.
// Teardown hard-resets the fixture repo so its HEAD/tree are exactly restored.
const fixture = path.join(process.cwd(), ".e2e", "fixture-repo");

describe("git stage & commit", () => {
  let taskId: string | undefined;
  let headSha = "";

  before(() => {
    headSha = execSync(`git -C "${fixture}" rev-parse HEAD`).toString().trim();
  });
  after(async () => {
    if (taskId) await archiveTask(taskId);
    execSync(`git -C "${fixture}" reset --hard ${headSha}`);
    execSync(`git -C "${fixture}" clean -fd`);
  });

  const status = () =>
    browser.execute(
      (id) => window.__termic!.ipc.taskGitStatus(id),
      taskId,
    ) as Promise<any>;

  it("stages a changed file", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-commit");

    // Modify README, then stage it via the app's own IPC.
    await browser.execute(async (id) => {
      const orig = await window.__termic!.ipc.taskFileRead(id, "README.md");
      await window.__termic!.ipc.taskFileWrite(id, "README.md", orig + "\ncommit-test\n");
    }, taskId);
    await browser.execute(
      (id) => window.__termic!.ipc.taskStage(id, "", ["README.md"]),
      taskId,
    );

    await browser.waitUntil(
      async () => {
        const st = await status();
        return (st.repos?.[0]?.staged ?? []).some((f: any) =>
          f.path.includes("README"),
        );
      },
      { timeout: 8_000, timeoutMsg: "README never appeared in the staged list" },
    );
  });

  it("commits the staged change and the tree goes clean", async () => {
    await browser.execute(
      (id) =>
        window.__termic!.ipc.taskCommit(id, "", "e2e commit", "", false, false),
      taskId,
    );
    await browser.waitUntil(
      async () => (await status()).total_changed === 0,
      { timeout: 8_000, timeoutMsg: "tree was not clean after commit" },
    );
    await browser.saveScreenshot(artifact("git-commit.png"));
  });
});
