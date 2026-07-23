import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P1: resuming a closed agent tab. Seeds a closedTabs entry (the same shape the
// close path snapshots) and drives resumeClosedTab: it must reopen a tab and
// consume the entry.
describe("resume closed tab", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("reopens a closed tab and consumes the entry", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-resume");
    const before = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
      taskId,
    );

    // Seed a closed-tab entry, then resume it.
    await browser.execute((id) => {
      const app = window.__termic!.useApp;
      const entry = {
        id: "e2e-closed-1",
        cli: "fakeagent",
        title: "Resumed",
        sessionId: null,
        closedAt: new Date().toISOString(),
      };
      app.setState((s: any) => ({
        closedTabs: { ...s.closedTabs, [id]: [entry] },
      }));
    }, taskId);
    await browser.execute(
      (id) =>
        window.__termic!.useApp.getState().resumeClosedTab(id, "e2e-closed-1"),
      taskId,
    );

    // A tab was reopened and the closed entry was consumed.
    await browser.waitUntil(
      () =>
        browser.execute(
          (id, b) => {
            const s = window.__termic!.useApp.getState();
            return (
              (s.tabs[id] ?? []).length > b &&
              (s.closedTabs[id] ?? []).length === 0
            );
          },
          taskId,
          before,
        ),
      { timeout: 10_000, timeoutMsg: "closed tab was not resumed" },
    );
    await snap("resume-tab.png");
  });
});
