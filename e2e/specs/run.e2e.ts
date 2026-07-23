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
      { timeout: 10_000, timeoutMsg: "run tab was not created" },
    );

    // Its PTY spawns and executes the command (produces output).
    await browser.waitUntil(
      () =>
        browser.execute(
          (id, member) => {
            const tab = (window.__termic!.useApp.getState().tabs[id] ?? []).find(
              (t: any) => t.runTab?.member === member,
            );
            return !!tab?.ptyId && !!tab?.lastOutputAt;
          },
          taskId,
          MEMBER,
        ),
      {
        timeout: 15_000,
        interval: 250,
        timeoutMsg: "run tab PTY never produced output",
      },
    );

    await snap("run.png");
  });
});
