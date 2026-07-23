import { execSync } from "node:child_process";
import path from "node:path";
import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P1: the Setup script. Configure a setup command in the repo config, launch
// it, and assert a Setup tab spawns and runs. Cleans the .termic.yaml away.
const fixture = path.join(process.cwd(), ".e2e", "fixture-repo");

describe("setup script", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("launches the setup script in a Setup tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-setup");

    // Configure a setup command in .termic.yaml.
    await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      let cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      if (!cfg) {
        await window.__termic!.ipc.repoConfigScaffold(proj.id);
        cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      }
      cfg.scripts.setup = "echo setup-ran";
      await window.__termic!.ipc.repoConfigSave(proj.id, cfg);
    });

    // Launch it.
    await browser.execute(
      (id) => window.__termic!.runTabs.launchSetupTab(id),
      taskId,
    );

    // A Setup tab appears and its PTY spawns.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tab = (window.__termic!.useApp.getState().tabs[id] ?? []).find(
            (t: any) => t.runTab?.kind === "setup",
          );
          return !!tab?.ptyId;
        }, taskId),
      { timeout: 15_000, interval: 250, timeoutMsg: "setup tab never spawned" },
    );
    await snap("setup-script.png");
  });
});
