import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForAppShell, requireTermicApi, artifact } from "../helpers";

// P2: repo discovery (Add Project → Discover). Scans a folder and returns the
// git repos in it.
describe("discover repos", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-discover-"));
    const sub = path.join(dir, "sub-repo");
    mkdirSync(sub, { recursive: true });
    execSync(`git -C "${sub}" init -q`);
    execSync(
      `git -C "${sub}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a git repo inside a folder", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const repos = await browser.execute(
      async (d) => await window.__termic!.ipc.discoverRepos(d),
      dir,
    );
    expect(
      (repos as any[]).some((r) => JSON.stringify(r).includes("sub-repo")),
    ).toBe(true);
    await browser.saveScreenshot(artifact("discover.png"));
  });
});
