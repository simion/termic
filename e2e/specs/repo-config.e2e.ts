import { execSync } from "node:child_process";
import path from "node:path";
import { waitForAppShell, requireTermicApi, snap } from "../helpers";

// P2: per-repo config (.termic.yaml). Save a config field and read it back.
// Git-cleans the written .termic.yaml on teardown.
const fixture = path.join(process.cwd(), ".e2e", "fixture-repo");

describe("repo config", () => {
  after(() => {
    try {
      execSync(`git -C "${fixture}" clean -fd`);
      execSync(`git -C "${fixture}" checkout -- .termic.yaml`, { stdio: "ignore" });
    } catch {
      /* nothing to restore */
    }
  });

  it("saves a repo config and reads it back", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const loaded = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      // Load returns null when there's no .termic.yaml yet; scaffold a default.
      let cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      if (!cfg) {
        await window.__termic!.ipc.repoConfigScaffold(proj.id);
        cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      }
      cfg.scripts.setup = "echo e2e-setup";
      await window.__termic!.ipc.repoConfigSave(proj.id, cfg);
      return await window.__termic!.ipc.repoConfigLoad(proj.id);
    });
    expect((loaded as any).scripts.setup).toBe("echo e2e-setup");
    await snap("repo-config.png");
  });
});
