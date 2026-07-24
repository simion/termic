import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireTermicApi, snap, waitForAppShell } from "../helpers";

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

  it("assigns the project to a group", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectSetGroup([i], "e2e-group");
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .projects.find((p: any) => p.id === i)?.group === "e2e-group",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "project group never applied" },
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
    await snap("project.png");
  });
});

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
    await snap("discover.png");
  });
});

// P2: importing an existing worktree (issue #5). Guards the discovery half:
// listing worktrees that exist on disk but aren't open as tasks. The fixture
// repo has a pre-seeded `sbcheck` worktree. (We only assert discovery — doing
// the import + archive would rm the shared worktree.)
describe("import worktree", () => {
  it("lists importable worktrees for the project", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const list = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      return await window.__termic!.ipc.taskImportableWorktrees(proj.id);
    });
    expect(Array.isArray(list)).toBe(true);
    expect(
      (list as any[]).some((w) => JSON.stringify(w).includes("sbcheck")),
    ).toBe(true);
    await snap("import-worktree.png");
  });
});

// P2: per-repo config (.termic.yaml). Save a config field and read it back.
// Git-cleans the written .termic.yaml on teardown.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

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
