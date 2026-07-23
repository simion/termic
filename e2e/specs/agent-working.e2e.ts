import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P0: after a real submit, termic must show the agent as "working". Work
// detection is gated on the tab having been submitted-to since spawn (guards
// against cold-start false positives), so we stamp lastInputAt (what the app's
// send path does) before the claude-like fake agent flips to its spinner title.
describe("agent working state", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("enters the working state after a submit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-agent-working");

    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const t = (window.__termic!.useApp.getState().tabs[id] ?? [])[0];
          return !!t?.ptyId;
        }, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    // Arm the submit (stamp lastInputAt, as the real send path does) and send
    // a prompt line so the fake agent flips to its working/spinner title.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id][0];
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("do something\r")),
      );
    }, taskId);

    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().tabs[id][0].workState ===
            "working",
          taskId,
        ),
      { timeout: 10_000, timeoutMsg: "agent never entered the working state" },
    );

    await snap("agent-working.png");
  });
});
