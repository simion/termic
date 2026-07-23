import {
  waitForAppShell,
  requireTermicApi,
  snap,
} from "../helpers";

// The single most important flow in termic: create a task in a project and
// have the agent's terminal come alive. One green run proves project/task IO,
// git-worktree/checkout setup, the Rust PTY spawn, and tab/store wiring.
// Uses `fakeagent` (a claude-like fixture CLI, zero tokens).
describe("task spawn", () => {
  let taskId: string | undefined;

  // Keep the profile clean across repeated runs: archive the task we created
  // (kills its PTY, moves it off the active board). Repo-root task, so archive
  // never removes a worktree.
  after(async () => {
    if (!taskId) return;
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskArchive(id);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
  });

  it("spawns a task and the agent PTY comes alive", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Create the task through the app's own IPC (fast + robust vs. clicking
    // the create wizard). Repo-root task: no worktree, safe to archive later.
    taskId = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "e2e-spawn");
      await t.useApp.getState().loadAll();
      t.useApp.getState().setActiveTask(task.id);
      return task.id as string;
    });
    expect(typeof taskId).toBe("string");

    // The PTY spawns once the task view mounts. Poll the store, don't sleep.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tabs = window.__termic!.useApp.getState().tabs[id] ?? [];
          return tabs.length > 0 && !!tabs[0].ptyId;
        }, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    // Round-trip: write to the PTY and assert new output lands. Terminal
    // content is a WebGL canvas (never in the DOM), so assert via the store's
    // lastOutputAt, not innerText.
    const before = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
      taskId,
    );
    await browser.execute(async (id) => {
      const t = window.__termic!;
      const tab = t.useApp.getState().tabs[id][0];
      await t.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("ping\r")),
      );
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute(
          (a) =>
            (window.__termic!.useApp.getState().tabs[a.id][0].lastOutputAt ??
              0) !== a.before,
          { id: taskId, before },
        ),
      { timeout: 10_000, timeoutMsg: "no PTY output after write" },
    );

    // The claude-like fixture drives the OSC terminal title (✳ when idle, a
    // spinner while working); termic ingests it as the tab's liveTitle. This
    // proves the fake agent's title behavior reaches the app end to end.
    // (We assert liveTitle rather than workState because termic gates the
    // working indicator on a real submit through its input path, which a raw
    // ptyWrite intentionally bypasses — that heuristic gets its own test.)
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tab = window.__termic!.useApp.getState().tabs[id][0];
          return !!tab.liveTitle && tab.liveTitle.includes("e2e-spawn");
        }, taskId),
      {
        timeout: 10_000,
        timeoutMsg: "agent OSC title (liveTitle) never reached the app",
      },
    );

    await snap("task-spawn.png");
  });
});
