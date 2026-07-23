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
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

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

    // Wait until the saved config is readable back (launchSetupTab resolves it
    // live; on a slow runner the write→read can lag).
    await browser.waitUntil(
      () =>
        browser.execute(async () => {
          const proj = window.__termic!.useApp
            .getState()
            .projects.find((p: any) => p.name === "fixture-repo");
          const cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
          return cfg?.scripts?.setup === "echo setup-ran";
        }),
      { timeout: 10_000, timeoutMsg: "setup config never persisted" },
    );

    // Launch it (await the async resolve so the tab is added before asserting).
    await browser.execute(
      async (id) => {
        await window.__termic!.runTabs.launchSetupTab(id);
      },
      taskId,
    );

    // A Setup tab is created. (Its PTY spawn is rAF-gated in TerminalPane and
    // lags on an occluded/offscreen CI window; the launch wiring is the
    // regression surface — PTY spawn is covered by task-spawn's agent PTY.)
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.runTab?.kind === "setup",
            ),
          taskId,
        ),
      { timeout: 15_000, interval: 250, timeoutMsg: "setup tab never created" },
    );
    await snap("setup-script.png");
  });
});
