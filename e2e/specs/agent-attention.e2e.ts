import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// P0: when an agent you're NOT watching finishes, termic must raise attention
// (unread / done) on its tab. Start an agent working, switch to another task so
// it's backgrounded (still mounted), and assert it flags completion.
describe("agent attention", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  it("flags a backgrounded agent's completion", async () => {
    await waitForAppShell();
    await requireTermicApi();

    a = await openTask("e2e-attn-a");
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const t = (window.__termic!.useApp.getState().tabs[id] ?? [])[0];
          return !!t?.ptyId;
        }, a),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent A PTY never spawned" },
    );

    // Submit a prompt so the agent goes to work.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id][0];
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("do something\r")),
      );
    }, a);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().tabs[id][0].workState ===
            "working",
          a,
        ),
      { timeout: 10_000, timeoutMsg: "agent A never started working" },
    );

    // Switch to a second task so A is backgrounded (kept mounted).
    b = await openTask("e2e-attn-b");

    // A should flag completion: unread attention set, or workState -> done.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const t = window.__termic!.useApp.getState().tabs[id][0];
          return !!t.unread || t.workState === "done";
        }, a),
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: "backgrounded agent never flagged completion",
      },
    );

    await browser.saveScreenshot(artifact("agent-attention.png"));
  });
});
