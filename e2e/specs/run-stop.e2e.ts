import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P2: stopping a running script. Launch a long-running custom run, then kill
// its PTY (what the Stop button does) and assert the run tab stops.
describe("run stop", () => {
  let taskId: string | undefined;
  const MEMBER = "cmd:e2e-stop";
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const runTab = () =>
    browser.execute(
      (id, m) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).find(
          (t: any) => t.runTab?.member === m,
        ),
      taskId,
      MEMBER,
    );

  it("stops a running command by killing its PTY", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-runstop");

    await browser.execute((id) => {
      window.__termic!.runTabs.launchCustomRun(id, {
        label: "e2e-stop",
        command: "sleep 30",
      });
    }, taskId);

    // Wait for it to be running (PTY spawned).
    await browser.waitUntil(async () => !!(await runTab())?.ptyId, {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "run tab never started",
    });
    const ptyId = (await runTab())?.ptyId as string;

    // Stop it (the Stop button kills the run PTY).
    await browser.execute((p) => window.__termic!.ipc.ptyKill(p), ptyId);

    // The tab's PTY clears once the process exits.
    await browser.waitUntil(async () => !(await runTab())?.ptyId, {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: "run tab PTY never cleared after stop",
    });
    await snap("run-stop.png");
  });
});
