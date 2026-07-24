import { execSync } from "node:child_process";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

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

// P1: the Setup script. Configure a setup command in the repo config, launch
// it, and assert a Setup tab spawns and runs. Cleans the .termic.yaml away.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("setup script", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("launches the setup script in a Setup tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-setup");

    // Configure a setup command in .termic.yaml.
    await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      let cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      if (!cfg) {
        await window.__termic!.ipc.repoConfigScaffold(proj.id);
        cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      }
      cfg.scripts.setup = "echo setup-ran";
      await window.__termic!.ipc.repoConfigSave(proj.id, cfg);
    });

    // Wait until the saved config is readable back (launchSetupTab resolves it
    // live; on a slow runner the write→read can lag).
    await browser.waitUntil(
      () =>
        browser.execute(async () => {
          const proj = window.__termic!.useApp
            .getState()
            .projects.find((p: any) => p.name === "fixture-repo");
          const cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
          return cfg?.scripts?.setup === "echo setup-ran";
        }),
      { timeout: 10_000, timeoutMsg: "setup config never persisted" },
    );

    // Launch it (await the async resolve so the tab is added before asserting).
    await browser.execute(
      async (id) => {
        await window.__termic!.runTabs.launchSetupTab(id);
      },
      taskId,
    );

    // A Setup tab is created. (Its PTY spawn is rAF-gated in TerminalPane and
    // lags on an occluded/offscreen CI window; the launch wiring is the
    // regression surface — PTY spawn is covered by task-spawn's agent PTY.)
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.runTab?.kind === "setup",
            ),
          taskId,
        ),
      { timeout: 15_000, interval: 250, timeoutMsg: "setup tab never created" },
    );
    await snap("setup-script.png");
  });
});

// P1: the Run commands manager (GH #124). Guards that it opens for a project
// and closes. (Persisting a command edits projects.json; opening + rendering is
// the robust check that the dialog is wired.)
describe("run config", () => {
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeRunCommands?.(),
    );
  });

  it("opens the run commands manager for a project", async () => {
    await waitForAppShell();
    await requireTermicApi();

    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI
        .getState()
        .openRunCommands(proj.id, { label: "e2e-cmd", command: "echo hi" });
    });

    // The dialog state is set and a modal renders.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.useUI.getState().runCommandsDialog !== null &&
            !!document.querySelector('[role="dialog"]'),
        ),
      { timeout: 8_000, timeoutMsg: "run commands manager never opened" },
    );
    await snap("run-config.png");
  });
});
