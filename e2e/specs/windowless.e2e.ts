// The windowless cases live in their own spec file, so their app dies with
// them. Hiding and re-showing the e2e window (alpha 0, see
// hide_window_from_user_in_e2e) can leave WebKit's threaded scrolling waiting
// every frame for a rendering update that never comes: on a CI runner the
// next scrollable view froze the app's main thread (sampled: displayDidRefresh
// waiting on the scrolling thread), and every spec after it timed out.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, clickWhenVisible, openTask, snap, waitForAppShell, waitVisible, controlConnect } from "../helpers";

const artifacts = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".e2e",
  "artifacts",
);

// P1: windowless mode. Closing the window must send Termic to
// the menu bar WITHOUT killing agents, and must collapse every task pane to
// zero geometry — the only thing that actually pauses xterm's renderers, since
// a hidden NSWindow still reports full layout (docs/performance.md bear trap 2
// at window scope). Restoring goes through the CLI socket's unauthenticated
// `raise`, the same verb `termic open` and the single-instance handshake use.
//
// Cases: close goes windowless without killing the task; panes sit at zero
// geometry while windowless; agent output still flows while windowless
// (the whole point of a daemon); raise restores window + panes.
// macOS only: closing the window keeps the app running in the menu bar
// there. On Windows and Linux closing the window quits, by design (the close
// handler is macOS-only, docs/windows.md), so this suite would close the app
// under every later case.
(process.platform !== "darwin" ? describe.skip : describe)("windowless mode", () => {
  let taskId!: string;

  // Same constant wdio launches the app with, rather than a second hard-coded
  // copy of the path that could drift from it.
  const socketPath = path.join(dataDir, "termic.sock");

  /** Unauthenticated `raise` over the control socket (cli_server.rs handles it
   *  before the auth gate, so it works with the CLI setting off). */
  async function raiseOverSocket(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const c = controlConnect(socketPath);
      c.on("error", reject);
      c.on("connect", () => c.write(JSON.stringify({ id: "e2e", cmd: "raise" }) + "\n"));
      const t = setTimeout(() => { c.destroy(); reject(new Error("raise timed out")); }, 10_000);
      c.on("data", () => { clearTimeout(t); c.end(); resolve(); });
    });
  }

  const state = () =>
    browser.execute(() => {
      const t = window.__termic!;
      // Panes with NON-ZERO geometry: exactly what decides whether xterm keeps
      // its renderers running.
      const live = [...document.querySelectorAll(".xterm-screen")]
        .filter(e => e.getBoundingClientRect().width > 0).length;
      return {
        windowless: t.useUI.getState().windowless as boolean,
        livePanes: live,
        mounted: [...t.useApp.getState().mountedTasks].length as number,
      };
    });

  before(async () => {
    await waitForAppShell();
    // Belt and braces: the race case closes its own dialog now (it has to,
    // this describe is macOS-only and Windows runs the whole suite in ONE app
    // window), and a stacked close prompt should be covered by its own
    // styling rather than by accident here.
    await browser.execute(() => {
      const u = window.__termic!.useUI.getState();
      u.closeRace?.(); u.closeWelcome?.(); u.closeChangelog?.();
    });
    // A run killed mid-file (wdio.conf.ts kills a frozen app on macOS CI, or
    // someone pressed Ctrl-C) never reaches `after`, so its task is still
    // live and the next run would die on "bg-mode already exists". Sweep by
    // name.
    const left = await browser.execute(() =>
      window.__termic!.useApp.getState().tasks
        .filter((w: any) => !w.archived && w.name === "bg-mode")
        .map((w: any) => w.id as string));
    for (const id of left) await archiveTask(id);
    taskId = await openTask("bg-mode");
    // Wait for the PTY so there is a real terminal to collapse.
    await browser.waitUntil(
      async () => browser.execute(
        (id) => ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
          .some(t => t.ptyId),
        taskId!,
      ),
      { timeout: 20_000, timeoutMsg: "task never spawned a PTY" },
    );
  });

  after(async () => {
    // Never leave the suite windowless. Later spec files launch their own
    // window, but a stuck Accessory policy would be a miserable debug, so a
    // failure here is REPORTED rather than swallowed - loud in this file beats
    // mysterious in the next one.
    await setCloseAction(null).catch(() => {});
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000,
      timeoutMsg: "teardown could not restore the window; later specs would run windowless",
    });
    if (taskId) await archiveTask(taskId);
  });

  /** Set the backend `close_action` so a case can pick prompt vs no-prompt. */
  const setCloseAction = (v: string | null) =>
    browser.execute(async (val) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, close_action: val ?? undefined });
    }, v);

  const closeWindow = () =>
    browser.execute(() =>
      window.__termic!.invoke("plugin:window|close", { label: "main" }));

  const promptOpen = () =>
    browser.execute(() => window.__termic!.useUI.getState().closePromptOpen as boolean);

  it("asks before closing, and dismissing the prompt cancels the close", async () => {
    await setCloseAction("ask");
    const before = await state();
    expect(before.windowless).toBe(false);
    expect(before.livePanes).toBeGreaterThan(0);

    await closeWindow();
    await browser.waitUntil(async () => (await promptOpen()) === true, {
      timeout: 15_000, timeoutMsg: "close did not raise the prompt",
    });
    // The prompt is the branch's main new surface: capture it while it is up.
    await waitVisible('[data-testid="close-menubar"]');
    await snap("close-prompt.png");

    // Dismissal (Esc / click-away) must be HARMLESS: not a quit, and not even
    // going windowless. The window stays exactly as it was.
    await browser.execute(() => window.__termic!.useUI.getState().setClosePromptOpen(false));
    const after = await state();
    expect(after.windowless).toBe(false);
    expect(after.livePanes).toBeGreaterThan(0);
  });

  it("'Keep in Menu Bar' goes windowless without killing the task", async () => {
    await setCloseAction("ask");
    const before = await state();
    await closeWindow();
    await browser.waitUntil(async () => (await promptOpen()) === true, {
      timeout: 15_000, timeoutMsg: "close did not raise the prompt",
    });
    // CLICK THE REAL BUTTON. Invoking window_close_choice directly would keep
    // passing if the two onClick handlers were swapped - on a dialog where one
    // button SIGKILLs every running agent, the wiring is the thing to assert.
    await clickWhenVisible('[data-testid="close-menubar"]');

    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "'Keep in Menu Bar' never windowless the app",
    });
    // The task must SURVIVE: unmounting would kill its PTY and the agent.
    expect((await state()).mounted).toBe(before.mounted);
    const alive = await browser.execute(
      (id) => ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
        .some(t => t.ptyId),
      taskId!,
    );
    expect(alive).toBe(true);
  });

  /** Put the app in a known state, whatever the previous case left behind. */
  async function ensureWindowless(want: boolean) {
    if ((await state()).windowless === want) return;
    if (want) {
      await setCloseAction("menubar");
      await closeWindow();
    } else {
      await raiseOverSocket();
    }
    await browser.waitUntil(async () => (await state()).windowless === want, {
      timeout: 15_000, timeoutMsg: `could not reach windowless=${want}`,
    });
    await setCloseAction("ask");
  }

  it("collapses every task pane to zero geometry while windowless", async () => {
    await ensureWindowless(true);
    // Timers are clamped to 1Hz in a hidden webview, so give the layout a
    // generous window to settle rather than assuming one tick.
    await browser.waitUntil(async () => (await state()).livePanes === 0, {
      timeout: 15_000,
      timeoutMsg: "panes still had non-zero geometry while windowless — "
        + "xterm's renderers would keep drawing for an invisible window",
    });
  });

  it("keeps agent output flowing while windowless", async () => {
    await ensureWindowless(true);
    const at = () => browser.execute(
      (id) => {
        const tab = ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
          .find(t => t.ptyId);
        return (tab?.lastOutputAt ?? 0) as number;
      }, taskId!);
    const before = await at();
    // Bytes through the real PTY. (workState deliberately NOT asserted: termic
    // gates the working indicator on a submit through its own input path, so a
    // raw ptyWrite never flips it — visible or hidden. See the e2e skill.)
    await browser.execute((id) => {
      const t = window.__termic!;
      const tab = ((t.useApp.getState().tabs[id] || []) as any[]).find(x => x.ptyId);
      return t.ipc.ptyWrite(tab.ptyId, [...new TextEncoder().encode("hello\r")]);
    }, taskId!);
    await browser.waitUntil(async () => (await at()) > before, {
      timeout: 20_000,
      timeoutMsg: "no PTY output reached the webview while windowless — "
        + "the daemon property is broken",
    });
    expect((await state()).windowless).toBe(true);
  });

  it("skips the prompt once 'Don't ask again' has been stored", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the remembered-close case",
    });
    await setCloseAction("menubar");
    await closeWindow();
    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "a remembered 'menubar' close did not go windowless",
    });
    expect(await promptOpen()).toBe(false);
    await setCloseAction("ask");
  });

  it("'Don't ask again' persists the choice from the dialog itself", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the checkbox case",
    });
    await setCloseAction("ask");
    await closeWindow();
    await browser.waitUntil(async () => (await promptOpen()) === true, {
      timeout: 15_000, timeoutMsg: "close did not raise the prompt",
    });
    // Tick the real checkbox, then click the real button: this is the only
    // case that exercises checkbox -> window_close_choice(remember) -> disk.
    await clickWhenVisible('[data-testid="close-dont-ask"]');
    await clickWhenVisible('[data-testid="close-menubar"]');
    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "checkbox path never went windowless",
    });
    const stored = await browser.execute(async () =>
      (await window.__termic!.ipc.settingsLoad()).close_action);
    expect(stored).toBe("menubar");
    await setCloseAction("ask");
  });

  // The case that would have caught the fireDone gate: the task is ACTIVE when
  // the window closes, so every focus-proxy check says "the user is watching"
  // even though there is no window. Drives a REAL submit through the input path
  // (a raw ptyWrite never arms work detection) and asserts the completion is
  // not swallowed.
  it("flags completion for the ACTIVE task while windowless", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the completion case",
    });
    // Make the task and its agent tab active, so the proxy is maximally wrong.
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.setActiveTask(id);
      const tab = (s.tabs[id] || []).find((t: any) => t.ptyId);
      s.setActiveTabId(id, tab.id);
      s.patchTab(id, tab.id, { unread: false, workState: undefined });
    }, taskId!);

    await setCloseAction("menubar");
    await closeWindow();
    await browser.waitUntil(async () => (await state()).windowless === true, {
      timeout: 15_000, timeoutMsg: "close did not go windowless",
    });

    // Armed submit, exactly as the real send path does (stamp lastInputAt).
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = (s.tabs[id] || []).find((t: any) => t.ptyId);
      s.patchTab(id, tab.id, { lastInputAt: Date.now() });
      window.__termic!.ipc.ptyWrite(
        tab.ptyId, Array.from(new TextEncoder().encode("do something\r")));
    }, taskId!);

    // fakeagent goes spinner then back to the idle glyph; termic must turn that
    // into unread/done rather than silently idling it.
    await browser.waitUntil(
      async () => browser.execute((id) => {
        const tab = ((window.__termic!.useApp.getState().tabs[id] || []) as any[])
          .find(t => t.ptyId);
        return tab?.unread === true || tab?.workState === "done";
      }, taskId!),
      { timeout: 30_000,
        timeoutMsg: "an agent finishing while windowless left NO unread/done on "
          + "the active task - the completion was swallowed" },
    );
    await setCloseAction("ask");
  });

  it("surfaces the close behavior in Settings > General", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => (await state()).windowless === false, {
      timeout: 15_000, timeoutMsg: "could not restore before the settings case",
    });
    // Flash-target the block so the screenshot lands on the right control.
    await browser.execute(() =>
      window.__termic!.useApp.getState()
        .openSettings("general", undefined, "close-action"));
    await waitVisible('[data-testid="close-action-select"]');
    // All three options must be reachable here: "Ask me each time" is the only
    // way back once "Don't ask again" has been ticked.
    const opts = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="close-action-select"] option')]
        .map(o => (o as HTMLOptionElement).value));
    expect(opts).toEqual(["ask", "menubar", "quit"]);
    await snap("close-action-setting.png");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("raise restores the window and the panes", async () => {
    await raiseOverSocket();
    await browser.waitUntil(async () => {
      const s = await state();
      return s.windowless === false && s.livePanes > 0;
    }, { timeout: 15_000, timeoutMsg: "raise did not restore the window/panes" });
    await snap("windowless-restored.png");
  });
});
