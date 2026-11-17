import { execSync } from "node:child_process";
import path from "node:path";
import { archiveTask, clickWhenVisible, cliRpc, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell, waitGone, waitVisible } from "../helpers";

// P0: the Run feature (#54/#124) launches commands in dedicated run tabs.
// Guards a custom run: it opens a run tab whose PTY actually executes the
// command. (No .termic.yaml needed, so the fixture repo stays clean.)
describe("run tabs", () => {
  let taskId!: string;
  const MEMBER = "label:e2e-run";
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

    // Titled as a run, with the command's label after it: the label alone
    // read as an ordinary terminal that happened to be called "e2e-run".
    const title = await browser.execute(
      (id, member) => {
        const t = (window.__termic!.useApp.getState().tabs[id] ?? []).find((x: any) => x.runTab?.member === member);
        const pill = t ? document.querySelector(`[data-tab-id="${t.id}"]`) : null;
        return { stored: t?.title as string | undefined, shown: pill?.textContent ?? null };
      },
      taskId,
      MEMBER,
    );
    expect(title.stored).toBe("Run · e2e-run");
    if (title.shown !== null) expect(title.shown).toContain("Run · e2e-run");

    // NOTE: the run tab's PTY spawn is rAF-gated in TerminalPane, so on an
    // occluded/offscreen window (CI) it can lag past any reasonable timeout.
    // The launch wiring (a run tab created for the command) is the regression
    // surface here; PTY spawn + execution is covered by task-spawn's agent PTY.
    await snap("run.png");
  });

  // An unlabeled command falls back to the command itself for both its tab
  // identity (`cmd:<command>`, a namespace apart from a labeled command's
  // `label:<label>`, so neither can collide with the other) and its visible
  // title, clipped at 40 chars.
  it("titles an unlabeled command with its (clipped) command", async () => {
    const command = "echo unlabeled-run-command-with-a-very-long-tail";
    await browser.execute((id, cmd) => {
      window.__termic!.runTabs.launchCustomRun(id, { label: "", command: cmd });
    }, taskId, command);

    const tabId = await browser.waitUntil(
      async () =>
        (await browser.execute(
          (id, member) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).find(
              (t: any) => t.runTab?.member === member,
            )?.id,
          taskId,
          `cmd:${command}`,
        )) as string | undefined,
      { timeout: 15_000, timeoutMsg: "unlabeled run tab was not keyed by its command" },
    );

    await ensureActiveTask(taskId!);
    // The tab strip shows "Run", then the command clipped to 40 chars with
    // an ellipsis.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (id, tab) =>
            document
              .querySelector(`[data-task-id="${id}"] [data-tab-id="${tab}"]`)
              ?.textContent?.includes("Run · echo unlabeled-run-command-with-a-very-…") ?? false,
          taskId,
          tabId,
        )) === true,
      { timeout: 10_000, timeoutMsg: "unlabeled run tab did not show the clipped command" },
    );
    await snap("run-unlabeled.png");
  });
});

// P2: stopping a running script. Launch a long-running custom run, then kill
// its PTY (what the Stop button does) and assert the run tab stops.
describe("run stop", () => {
  let taskId!: string;
  const MEMBER = "label:e2e-stop";
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
  let taskId!: string;
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

// A run you started is invisible from any other task once you navigate away:
// the tab pill carries the only Stop, and that pill lives inside the task. The
// sidebar's Run row mirrors it, so a live run is both visible and stoppable
// from the tree.
describe("sidebar run stop", () => {
  let taskId!: string;
  let tabId!: string;
  let ptyId!: string;

  after(async () => {
    if (ptyId) {
      await browser.execute(
        async (id) => { try { await window.__termic!.ipc.ptyKill(id); } catch { /* gone */ } },
        ptyId,
      );
    }
    if (taskId) await archiveTask(taskId);
  });

  it("stops a live run from the sidebar row", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-sidebar-run");

    await browser.execute((id) => {
      window.__termic!.runTabs.launchCustomRun(id, {
        label: "e2e-sidebar-run",
        command: "sleep 30",
      });
    }, taskId);
    tabId = (await browser.waitUntil(
      async () =>
        (await browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).find(
            (t: any) => t.runTab?.member === "label:e2e-sidebar-run",
          )?.id,
          taskId,
        )) as string | undefined,
      { timeout: 15_000, timeoutMsg: "run tab was not created" },
    )) as string;

    // Own the PTY rather than waiting for the tab's own spawn: that one is
    // rAF-gated in TerminalPane and stalls on an occluded window (see the
    // note in the first describe). A real PTY under the tab's `ptyId` is the
    // same state the row reads, and `pty_alive` can then prove the Stop
    // actually killed something.
    ptyId = (await browser.execute(async (id) => {
      const t = window.__termic!;
      const task = t.useApp.getState().tasks.find((w: any) => w.id === id);
      const res = await t.ipc.ptySpawn({
        cwd: task.path, cmd: "sleep", args: ["30"], rows: 24, cols: 80,
      });
      return res.id as string;
    }, taskId)) as string;
    await browser.execute((id, tab, pty) => {
      const app = window.__termic!.useApp.getState();
      app.setTaskCollapsed(id, false);
      app.patchTab(id, tab, { ptyId: pty });
    }, taskId, tabId, ptyId);

    const stop = `[data-testid="sidebar-run-stop-${tabId}"]`;
    await waitVisible(stop);
    await clickWhenVisible(stop);

    await browser.waitUntil(
      async () => !(await browser.execute(
        async (id) => await window.__termic!.ipc.ptyAlive(id), ptyId,
      )),
      { timeout: 10_000, timeoutMsg: "the sidebar Stop did not kill the run's PTY" },
    );
    await snap("sidebar-run-stop.png");

    // Stopped, the row offers the pill's other half instead: Play, which
    // fronts the run tab and asks its pane to start the command again.
    await browser.execute((id, tab) => {
      window.__termic!.useApp.getState().patchTab(id, tab, { ptyId: null });
      // The restart travels as a window event to the tab's RunPane; record
      // it rather than waiting on a PTY spawn, which is rAF-gated (see the
      // note above) and would make this flaky on an occluded window.
      (window as any).__runRestarts = [];
      window.addEventListener("termic-run-tab-restart", (e: any) => {
        (window as any).__runRestarts.push(e.detail?.tabId);
      });
    }, taskId, tabId);
    await waitGone(stop);

    const play = `[data-testid="sidebar-run-play-${tabId}"]`;
    await waitVisible(play);
    await snap("sidebar-run-play.png");
    await clickWhenVisible(play);
    await browser.waitUntil(
      async () => (await browser.execute(
        (tab) => ((window as any).__runRestarts ?? []).includes(tab), tabId,
      )) as boolean,
      { timeout: 8_000, timeoutMsg: "the sidebar Play never asked the run tab to restart" },
    );
    // It also brings the run tab to the front, the way clicking the row does.
    expect(await browser.execute(
      (id) => window.__termic!.useApp.getState().activeTab[id], taskId,
    )).toBe(tabId);
  });

  // Collapsing a task hides the child row that carries the run controls, which
  // is exactly when a run is hardest to notice and to stop. The header row
  // takes them over, inline after the name, one per run tab and capped.
  it("moves the run controls onto the header row while collapsed", async () => {
    // Whichever half the run is showing: the case before this one restarted
    // it, so the tab may hold a live ptyId (Stop) or not (Play). What is
    // asserted is WHERE the control lives, not which of the pair it is.
    const inHeader = () => browser.execute((id, tab) => {
      const row = document.querySelector(`[data-sidebar-task-id="${id}"]`);
      const btn = document.querySelector(
        `[data-testid="sidebar-run-stop-${tab}"], [data-testid="sidebar-run-play-${tab}"]`,
      );
      return { present: !!btn, inside: !!row && !!btn && row.contains(btn) };
    }, taskId, tabId);

    await browser.execute((id) => {
      window.__termic!.useApp.getState().setTaskCollapsed(id, true);
    }, taskId);
    // Inline in the header itself, not a child row that survived the collapse
    // and not the trailing badge/kebab column.
    await browser.waitUntil(async () => (await inHeader()).inside, {
      timeout: 8_000,
      timeoutMsg: "the collapsed header never carried the run control",
    });

    // Expanded, the header hands it back rather than showing it twice: the
    // control is still on screen, just not inside the header row.
    await browser.execute((id) => {
      window.__termic!.useApp.getState().setTaskCollapsed(id, false);
    }, taskId);
    await browser.waitUntil(async () => {
      const r = await inHeader();
      return r.present && !r.inside;
    }, {
      timeout: 8_000,
      timeoutMsg: "the expanded header kept a run control of its own",
    });
  });

  // A task can hold several runs (per-member, custom commands, setup), so the
  // collapsed header shows one button each up to the cap and none past it,
  // rather than filling the row with icons or picking one arbitrarily.
  it("shows one button per run tab, up to three", async () => {
    const extras = ["e2e-collapsed-2", "e2e-collapsed-3", "e2e-collapsed-4"];
    const visible = () => browser.execute((id) => {
      const row = document.querySelector(`[data-sidebar-task-id="${id}"]`);
      return row ? row.querySelectorAll('[data-testid^="sidebar-run-"]').length : -1;
    }, taskId);

    await browser.execute((id) => {
      window.__termic!.useApp.getState().setTaskCollapsed(id, true);
    }, taskId);
    await browser.waitUntil(async () => (await visible()) === 1,
      { timeout: 8_000, timeoutMsg: "the one run tab never showed its button" });

    for (const [i, label] of extras.entries()) {
      await browser.execute((id, l) => {
        window.__termic!.runTabs.launchCustomRun(id, { label: l, command: "sleep 30" });
      }, taskId, label);
      // 2 and 3 add a button each; the 4th takes the whole set past the cap.
      const want = i < 2 ? i + 2 : 0;
      await browser.waitUntil(async () => (await visible()) === want, {
        timeout: 8_000,
        timeoutMsg: `expected ${want} run buttons after adding ${label}`,
      });
    }
  });
});

// With more than one thing to run, the top bar's Run is a single button that
// opens the menu; with one, it runs at once next to a separate chevron.
describe("run button", () => {
  let taskId!: string;
  const setProject = (patch: Record<string, unknown>) =>
    browser.execute(async (p) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      await t.ipc.projectUpdate({ ...proj, ...p });
      await t.useApp.getState().loadAll();
    }, patch);
  // The button the user sees: every visited task stays mounted, so scope to
  // a rendered one.
  const button = () =>
    browser.execute(() => {
      const shown = (sel: string) =>
        [...document.querySelectorAll<HTMLElement>(sel)].find(e => e.getBoundingClientRect().width > 0) ?? null;
      const run = shown('[data-testid="run-button"]');
      return {
        run: !!run,
        menu: run?.getAttribute("aria-haspopup") ?? null,
        chevron: !!shown('[data-testid="run-menu"]'),
      };
    });
  after(async () => {
    await browser.keys("Escape");
    await setProject({ run_script: "", run_scripts: [] });
    if (taskId) await archiveTask(taskId);
  });

  it("runs directly when there is only the run script", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await setProject({ run_script: "echo main-run", run_scripts: [] });
    taskId = await openTask("e2e-run-button");
    await ensureActiveTask(taskId);
    await browser.waitUntil(async () => {
      const b = await button();
      return b.run && b.menu === null && b.chevron;
    }, { timeout: 8_000, timeoutMsg: "expected a plain Run button beside a chevron" });
  });

  it("opens a menu of every run when there is more than one", async () => {
    await setProject({ run_script: "echo main-run", run_scripts: [{ label: "e2e-extra", command: "echo extra" }] });
    await browser.waitUntil(async () => {
      const b = await button();
      return b.run && b.menu === "menu" && !b.chevron;
    }, { timeout: 8_000, timeoutMsg: "Run never became the menu trigger" });

    // Radix opens on pointerdown, which a WebDriver click never emits in
    // WebKit (see git.e2e.ts history scope), so dispatch the pair.
    await browser.execute(() => {
      const el = [...document.querySelectorAll<HTMLElement>('[data-testid="run-button"]')]
        .find(e => e.getBoundingClientRect().width > 0)!;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    });
    await waitVisible('[data-testid="run-primary"]');
    const items = await browser.execute(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent?.trim()));
    expect(items).toContain("e2e-extra");
    await snap("run-button-menu.png");

    // The menu's Run launches the primary run, as the button used to.
    await clickWhenVisible('[data-testid="run-primary"]');
    await browser.waitUntil(
      () => browser.execute((id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).some(
          (t: any) => t.runTab?.member === "" && (t.runTab?.kind ?? "run") === "run"),
        taskId),
      { timeout: 15_000, timeoutMsg: "the menu's Run never opened the run tab" },
    );
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

// `termic run` / MCP `task_run`: an agent starts the task's dev server in the
// SAME Run tab the Run button drives, so the user sees it and can stop it.
// Over the real control socket: auth, task resolution, the webview RPC, the
// launch path, and the PTY the tab spawns (read back through `logs --tab`).
describe("termic run", () => {
  let taskId!: string;
  const setRunScript = (run_script: string) =>
    browser.execute(async (s) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      await t.ipc.projectUpdate({ ...proj, run_script: s, run_scripts: [] });
      await t.useApp.getState().loadAll();
    }, run_script);
  const ptyOf = (tabId: string) =>
    browser.execute(
      (id, tab) => (window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === tab)?.ptyId ?? null,
      taskId, tabId,
    );
  after(async () => {
    await setRunScript("");
    if (taskId) await archiveTask(taskId);
  });

  it("says when nothing is configured, and refuses to start it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await setRunScript("");
    taskId = await openTask("e2e-cli-run");
    const status = await cliRpc({ cmd: "run", task: taskId, status: true });
    expect(status.ok).toBe(true);
    expect(status.data.targets).toEqual([]);
    const start = await cliRpc({ cmd: "run", task: taskId });
    expect(start.ok).toBe(false);
    expect(start.error.message).toContain("no run script configured");
  });

  it("starts the run script in the task's Run tab, once", async () => {
    await setRunScript("echo cli-run-ok; sleep 120");
    const r = await cliRpc({ cmd: "run", task: taskId });
    expect(r.ok).toBe(true);
    const [target] = r.data.targets;
    expect(target).toMatchObject({ script: "echo cli-run-ok; sleep 120", running: true, outcome: "started" });
    expect(typeof target.tab_id).toBe("string");

    await browser.waitUntil(async () => !!(await ptyOf(target.tab_id)), {
      timeout: 20_000, timeoutMsg: "the Run tab never spawned its PTY",
    });
    let logs: any;
    await browser.waitUntil(async () => {
      logs = await cliRpc({ cmd: "logs", task: taskId, tab: target.tab_id });
      return logs.ok && String(logs.data.data).includes("cli-run-ok");
    }, { timeout: 20_000, interval: 250 }).catch(() => {
      throw new Error(`the run script's output never reached its tab: ${JSON.stringify(logs).slice(0, 400)}`);
    });

    // Asking again leaves the running server alone: same tab, same process.
    const pty = await ptyOf(target.tab_id);
    const again = await cliRpc({ cmd: "run", task: taskId });
    expect(again.data.targets[0]).toMatchObject({ tab_id: target.tab_id, outcome: "already_running" });
    expect(await ptyOf(target.tab_id)).toBe(pty);
  });

  it("stops it, and status reads it as stopped", async () => {
    const r = await cliRpc({ cmd: "run", task: taskId, stop: true });
    expect(r.ok).toBe(true);
    expect(r.data.targets[0]).toMatchObject({ running: false, outcome: "stopped" });
    const tabId = r.data.targets[0].tab_id;
    await browser.waitUntil(async () => !(await ptyOf(tabId)), {
      timeout: 15_000, timeoutMsg: "the Run tab's PTY never exited",
    });
    const status = await cliRpc({ cmd: "run", task: taskId, status: true });
    expect(status.data.targets[0]).toMatchObject({ tab_id: tabId, running: false });
    expect(status.data.targets[0].outcome).toBeUndefined();
  });
});
