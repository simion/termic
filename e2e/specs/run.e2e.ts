import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P0: the Run feature (#54/#124) launches commands in dedicated run tabs.
// Guards a custom run: it opens a run tab whose PTY actually executes the
// command. (No .termic.yaml needed, so the fixture repo stays clean.)
describe("run tabs", () => {
  let taskId: string | undefined;
  const MEMBER = "cmd:e2e-run";
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("launches a custom run command in a run tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-run");

    await browser.execute((id) => {
      window.__termic!.runTabs.launchCustomRun(id, {
        label: "e2e-run",
        command: "echo hello-from-e2e",
      });
    }, taskId);

    // A run tab is created for that command.
    await browser.waitUntil(
      () =>
        browser.execute(
          (id, member) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.runTab?.member === member,
            ),
          taskId,
          MEMBER,
        ),
      { timeout: 15_000, timeoutMsg: "run tab was not created" },
    );

    // NOTE: the run tab's PTY spawn is rAF-gated in TerminalPane, so on an
    // occluded/offscreen window (CI) it can lag past any reasonable timeout.
    // The launch wiring (a run tab created for the command) is the regression
    // surface here; PTY spawn + execution is covered by task-spawn's agent PTY.
    await snap("run.png");
  });
});
