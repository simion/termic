import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P1: the message queue lets you line up input while an agent is busy; it
// sends on idle. Cases: a message enqueued while working is HELD (not sent),
// then DRAINS once the agent goes idle (queue empties + the PTY receives it).
describe("message queue", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const tab = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0],
      taskId,
    );

  it("holds a message while working, then drains it when idle", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-queue");
    await browser.waitUntil(async () => !!(await tab())?.ptyId, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: "agent PTY never spawned",
    });

    // Put the agent to work (armed submit).
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const t = s.tabs[id][0];
      s.patchTab(id, t.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        t.ptyId,
        Array.from(new TextEncoder().encode("work\r")),
      );
    }, taskId);
    await browser.waitUntil(async () => (await tab())?.workState === "working", {
      timeout: 10_000,
      timeoutMsg: "agent never started working",
    });

    // Enqueue a message WHILE working — it must be held, not sent.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.enqueueAgentMessage(id, s.tabs[id][0].id, "queued-msg");
    }, taskId);
    expect((await tab())?.queue?.length ?? 0).toBeGreaterThanOrEqual(1);

    const before = (await tab())?.lastOutputAt ?? 0;

    // Once the agent settles to idle, the queue drains: it empties and the
    // PTY receives the queued line (new output).
    await browser.waitUntil(
      async () => {
        const t = await tab();
        return (t?.queue?.length ?? 0) === 0 && (t?.lastOutputAt ?? 0) !== before;
      },
      { timeout: 20_000, interval: 300, timeoutMsg: "queue never drained on idle" },
    );

    await snap("message-queue.png");
  });
});
