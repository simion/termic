import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForAppShell, requireTermicApi, artifact } from "../helpers";

// P1: adding/removing a project. Cases: a git repo can be added as a project
// (shows in the store); removing it drops it. Uses a throwaway temp repo and
// cleans it up.
describe("project add/remove", () => {
  let dir = "";
  let projectId: string | null = null;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-proj-"));
    execSync(
      `git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(async () => {
    if (projectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, projectId);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds a git repo as a project", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const proj = await browser.execute(
      async (d) => await window.__termic!.ipc.projectAdd(d),
      dir,
    );
    projectId = (proj as any).id;
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().projects.some((p: any) => p.id === id),
          projectId,
        ),
      { timeout: 8_000, timeoutMsg: "added project never appeared" },
    );
  });

  it("reorders projects", async () => {
    // Put the newly-added project first, then restore original order.
    const ids = await browser.execute(
      () => window.__termic!.useApp.getState().projects.map((p: any) => p.id),
      );
    const reordered = [
      projectId!,
      ...(ids as string[]).filter((i) => i !== projectId),
    ];
    await browser.execute(async (order) => {
      await window.__termic!.ipc.projectReorder(order);
      await window.__termic!.useApp.getState().loadAll();
    }, reordered);
    await browser.waitUntil(
      () =>
        browser.execute(
          (first) => window.__termic!.useApp.getState().projects[0]?.id === first,
          projectId,
        ),
      { timeout: 8_000, timeoutMsg: "project order never changed" },
    );
  });

  it("renames the project", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectRename(i, "e2e-renamed-proj");
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .projects.find((p: any) => p.id === i)?.name === "e2e-renamed-proj",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "project name never updated" },
    );
  });

  it("removes the project", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectRemove(i);
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            !window.__termic!.useApp.getState().projects.some((p: any) => p.id === i),
          id,
        ),
      { timeout: 8_000, timeoutMsg: "removed project still present" },
    );
    projectId = null;
    await browser.saveScreenshot(artifact("project.png"));
  });
});
