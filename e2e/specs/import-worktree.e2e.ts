import { waitForAppShell, requireTermicApi, artifact } from "../helpers";

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
    await browser.saveScreenshot(artifact("import-worktree.png"));
  });
});
