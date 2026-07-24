import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

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

    await snap("agent-attention.png");
  });
});

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

// P2: per-task agent extras. Cases: toggling YOLO mode; opening an aux (bottom)
// terminal for a task.
describe("agent extras", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const task = () =>
    browser.execute(
      (id) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id),
      taskId,
    );

  it("toggles YOLO mode on a task", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-extras");
    const before = !!(await task())?.yolo;
    await browser.execute(
      (id, b) => window.__termic!.useApp.getState().setTaskYolo(id, !b),
      taskId,
      before,
    );
    await browser.waitUntil(async () => !!(await task())?.yolo !== before, {
      timeout: 8_000,
      timeoutMsg: "YOLO never toggled",
    });
    // restore
    await browser.execute(
      (id, b) => window.__termic!.useApp.getState().setTaskYolo(id, b),
      taskId,
      before,
    );
  });

  it("opens an aux (bottom) terminal", async () => {
    await browser.execute(
      (id) => window.__termic!.useApp.getState().addBottomTab(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().bottomTabs[id] ?? []).length >= 1,
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "aux terminal was not added" },
    );
    await snap("agent-extras.png");
  });
});

// P1: the agent registry (Settings → Agent CLIs). Guards disabling/enabling an
// agent CLI through agentsSave. Uses "gemini" (not the test agents) and always
// restores it.
describe("agent settings", () => {
  const AGENT = "gemini";

  const setDisabled = (disabled: boolean) =>
    browser.execute(
      async (id, dis) => {
        const st = window.__termic!.useApp.getState();
        const next = st.agents.map((a: any) =>
          a.id === id ? { ...a, disabled: dis } : a,
        );
        await window.__termic!.ipc.agentsSave(next);
        await st.loadAll();
      },
      AGENT,
      disabled,
    );
  const isDisabled = () =>
    browser.execute(
      (id) =>
        !!window.__termic!.useApp
          .getState()
          .agents.find((a: any) => a.id === id)?.disabled,
      AGENT,
    );

  after(async () => {
    await setDisabled(false);
  });

  it("disables an agent CLI", async () => {
    await waitForAppShell();
    await requireTermicApi();
    expect(await isDisabled()).toBe(false);
    await setDisabled(true);
    await browser.waitUntil(async () => (await isDisabled()) === true, {
      timeout: 8_000,
      timeoutMsg: "agent never became disabled",
    });
  });

  it("re-enables an agent CLI", async () => {
    await setDisabled(false);
    await browser.waitUntil(async () => (await isDisabled()) === false, {
      timeout: 8_000,
      timeoutMsg: "agent never re-enabled",
    });
    await snap("agent-settings.png");
  });
});
