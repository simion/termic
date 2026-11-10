// Recurring schedules (GH #300): a parent task, runs in its group, a report
// file each run writes, and the run's lifecycle after it ends.
//
// A spec cannot wait for a slot, so it presses Run now or runs ONE pass of the
// minute ticker at a chosen moment, through the same functions the app uses
// (window.__termic.scheduleRunner). The schedule's own cadence is set days
// away, so the real ticker never fires during the run. The agent is the
// `fakeagent` fixture: its first prompt line is a directive (`#report`,
// `#attn`, `#noreport`) and it writes the report file Termic's appended
// instruction names.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveTask, clickByText, clickWhenVisible, dismissOverlays, requireTermicApi, setInputValue, sidebarBadge, snap,
  waitForAppShell, waitGone, waitTabInFront, waitTaskUnmounted, waitVisible,
} from "../helpers.js";

describe("scheduled tasks", () => {
  let projectId = "";
  let root = "";
  let parent = "";
  let slug = "";
  const runs: string[] = [];
  let onceParent = "";
  let onceRun = "";
  const NAME = "e2e nightly";

  const block = (gid: string) => `[data-task-group-id="${gid}"]`;
  const row = (id: string) => `[data-sidebar-task-id="${id}"]`;
  const toggle = (gid: string) => `[data-testid="task-group-toggle-${gid}"]`;

  const schedule = () =>
    browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.schedule ?? null,
      parent,
    ) as Promise<any>;
  const entryOf = async (runId: string) =>
    ((await schedule())?.history ?? []).find((e: any) => e.run_task_id === runId) ?? null;
  const waitOutcome = (runId: string, outcome: string, timeout = 30_000) =>
    browser.waitUntil(async () => (await entryOf(runId))?.outcome === outcome, {
      timeout, interval: 250,
      timeoutMsg: `run ${runId} never reached "${outcome}"`,
    });
  const update = (patch: Record<string, unknown>) =>
    browser.execute(async (id, p) => { await window.__termic!.scheduleRunner.updateSchedule(id, p); }, parent, patch);
  const runNow = async (): Promise<{ kind: string; runId?: string }> => {
    const r = await browser.execute(
      async (id) => window.__termic!.scheduleRunner.runScheduleNow(id),
      parent,
    ) as { kind: string; runId?: string };
    if (r.runId) runs.push(r.runId);
    return r;
  };
  const diskTask = (id: string) =>
    browser.execute(async (i) => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return all.find(t => t.id === i) ?? null;
    }, id) as Promise<any>;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().projects.some((x: any) => x.name === "fixture-repo")),
      { timeout: 15_000, timeoutMsg: "the fixture project never loaded" },
    );
    ({ projectId, root } = await browser.execute(() => {
      const p = window.__termic!.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      return { projectId: p.id as string, root: p.root_path as string };
    }));
    await browser.execute((p) => window.__termic!.useApp.getState().setProjectCollapsed(p, false), projectId);
    await dismissOverlays();
  });

  after(async () => {
    if (parent) {
      await browser.execute(
        async (id) => { await window.__termic!.scheduleRunner.deleteSchedule(id, true); },
        parent,
      ).catch(() => {});
    }
    if (onceParent) {
      await browser.execute(
        async (id) => { await window.__termic!.scheduleRunner.deleteSchedule(id, true); },
        onceParent,
      ).catch(() => {});
    }
    for (const id of [...runs, onceParent, parent].filter(Boolean)) {
      const t = await diskTask(id).catch(() => null);
      if (t && !t.archived) await archiveTask(id);
    }
    // Leave the fixture as it was found: the empty report root, and the
    // exclude line creating the schedule added.
    for (const dir of [path.join(root, ".termic", "schedules"), path.join(root, ".termic")]) {
      try { rmdirSync(dir); } catch { /* not empty, or never made */ }
    }
    const exclude = path.join(root, ".git", "info", "exclude");
    if (existsSync(exclude)) {
      const kept = readFileSync(exclude, "utf8").split("\n").filter(l => l !== "/.termic/schedules/");
      writeFileSync(exclude, kept.join("\n"));
    }
  });

  it("creates an unmounted parent that leads a collapsed group, its reports kept out of git", async () => {
    parent = await browser.execute(async (pid, name) => {
      // Three days out, so the real minute ticker never fires it mid-spec.
      const weekday = (new Date().getDay() + 3) % 7;
      return window.__termic!.scheduleRunner.createSchedule({
        projectId: pid,
        agent: { cli: "fakeagent", agentArgs: [], yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] } },
        input: {
          name, prompt: "#report", cadence: { kind: "weekly", time: "03:00", weekday },
          catch_up: false, keep_runs: 7, report_days: null,
        },
      });
    }, projectId, NAME);
    slug = (await schedule()).slug;

    await waitVisible(block(parent));
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-expanded"), toggle(parent))).toBe("false");
    // Created, not started: no task view, so no agent, until someone opens it.
    expect(await browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"]`), parent)).toBe(false);

    expect(existsSync(path.join(root, ".termic", "schedules", slug))).toBe(true);
    expect(readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).toContain("/.termic/schedules/");
    // Anything that lands in the folder is invisible to git.
    const probe = path.join(root, ".termic", "schedules", slug, "probe.md");
    writeFileSync(probe, "x");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    unlinkSync(probe);
    expect(status).not.toContain(".termic");
    await snap("schedules-01-parent-collapsed.png");
  });

  it("Run now makes a run in the parent's group that writes its report and is stopped", async () => {
    const r = await runNow();
    expect(r.kind).toBe("started");
    const run = r.runId!;
    expect((await diskTask(run))?.group?.id).toBe(parent);
    await browser.waitUntil(
      () => browser.execute((g) => document.querySelector(`[data-testid="task-group-count-${g}"]`)?.textContent?.trim().startsWith("2") ?? false, parent),
      { timeout: 10_000, timeoutMsg: "the run never showed in the parent's group" },
    );

    await waitOutcome(run, "fired");
    const e = await entryOf(run);
    expect(e.title).toBe("Fake scheduled report");
    expect(readFileSync(path.join(root, e.report), "utf8")).toContain("# Fake scheduled report");
    // Done means stopped: no agent left running behind a collapsed group.
    await waitTaskUnmounted(run, 15_000);
    await snap("schedules-02-run-done.png");
  });

  it("opening the run puts its rendered report in front of the agent tab", async () => {
    const run = runs[0];
    await clickWhenVisible(toggle(parent));
    await clickWhenVisible(row(run));
    await browser.waitUntil(
      () => browser.execute((id) => document.querySelector(`[data-task-id="${id}"] .markdown-body h1`)?.textContent ?? null, run)
        .then(t => t === "Fake scheduled report"),
      { timeout: 15_000, timeoutMsg: "the run's report never rendered in its task view" },
    );
    const reportTab = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return (s.tabs[id] ?? []).find((t: any) => t.type === "edit")?.id ?? null;
    }, run) as string | null;
    expect(reportTab).toBeTruthy();
    await waitTabInFront(run, reportTab!);
    // The agent tab is still there behind it.
    expect(await browser.execute((id) =>
      (window.__termic!.useApp.getState().tabs[id] ?? []).some((t: any) => t.type === "terminal"), run)).toBe(true);
    await snap("schedules-03-report-open.png");
  });

  it("archives runs past keep_runs without running the project's archive script", async () => {
    const marker = path.join(os.tmpdir(), `termic-e2e-archive-script-${process.pid}`);
    const original = await browser.execute((pid) =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.id === pid).archive_script ?? "", projectId);
    const setScript = (script: string) => browser.execute(async (pid, sc) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.id === pid);
      await t.ipc.projectUpdate({ ...p, archive_script: sc });
      await t.useApp.getState().loadAll();
    }, projectId, script);
    try {
      await setScript(`touch "${marker}"`);
      await update({ keep_runs: 1 });
      // The run on screen is never archived; step off it.
      await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
      const first = runs[0];
      const r = await runNow();
      await waitOutcome(r.runId!, "fired");
      await waitGone(row(first), 15_000);
      expect((await diskTask(first))?.archived).toBe(true);
      expect((await diskTask(r.runId!))?.archived).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await setScript(original);
    }
  });

  it("a run that needs input stays live, shows it, and holds back the next one", async () => {
    await update({ prompt: "#attn", keep_runs: 7 });
    const r = await runNow();
    const run = r.runId!;
    await waitOutcome(run, "needs_input");
    await browser.waitUntil(async () => (await sidebarBadge(run)) === "attention", {
      timeout: 10_000, timeoutMsg: "the run's row never asked for attention",
    });
    expect(await browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"] .xterm`), run)).toBe(true);
    expect((await runNow()).kind).toBe("busy");
    await snap("schedules-04-needs-input.png");

    await browser.execute((id) => window.__termic!.useApp.getState().stopTask(id), run);
    await waitOutcome(run, "failed");
    expect((await entryOf(run)).error).toBe("stopped");
  });

  it("archiving the parent pauses the schedule, and a restore resumes it", async () => {
    await update({ prompt: "#report" });
    const tickAt = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).schedule;
      const d = new Date();
      for (let i = 1; i <= 7; i++) {
        const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 3, 0);
        if (c.getDay() === s.cadence.weekday) return c.getTime() + 60_000;
      }
      throw new Error("no slot in the next week");
    }, parent) as number;
    const tick = () => browser.execute(
      async (now) => window.__termic!.scheduleRunner.scheduleTickNow(now),
      tickAt,
    ) as unknown as Promise<number>;

    await archiveTask(parent);
    expect(await tick()).toBe(0);

    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRestore(id);
      await window.__termic!.useApp.getState().loadAll();
    }, parent);
    expect(await tick()).toBe(1);
    const s = await schedule();
    const e = s.history[s.history.length - 1];
    expect(e.slot).toBe(tickAt - 60_000);
    runs.push(e.run_task_id);
    await waitOutcome(e.run_task_id, "fired");
  });

  it("a one-off fires once at its date and never again", async () => {
    // Tomorrow 03:00, so the real minute ticker never fires it mid-spec.
    const once = await browser.execute(async (pid) => {
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      const date = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
      const id = await window.__termic!.scheduleRunner.createSchedule({
        projectId: pid,
        agent: { cli: "fakeagent", agentArgs: [], yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] } },
        input: {
          name: "e2e one-off", prompt: "#report", cadence: { kind: "once", time: "03:00", date },
          catch_up: false, keep_runs: 7, report_days: null,
        },
      });
      return { id: id as string, slot: new Date(t.getFullYear(), t.getMonth(), t.getDate(), 3, 0).getTime() };
    }, projectId) as { id: string; slot: number };
    onceParent = once.id;
    const onceSchedule = () => browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.schedule ?? null,
      onceParent,
    ) as Promise<any>;
    const tickAt = (now: number) => browser.execute(
      async (n) => window.__termic!.scheduleRunner.scheduleTickNow(n), now,
    ) as unknown as Promise<number>;

    // Created ahead of its date: armed, nothing acted on.
    const created = await onceSchedule();
    expect(created.cadence.kind).toBe("once");
    expect(created.last_slot).toBeNull();
    expect(created.history).toEqual([]);

    // Before the slot nothing is due. The tick walks every schedule, the
    // weekly one above included, and that one is days from its own slot.
    expect(await tickAt(once.slot - 60_000)).toBe(0);
    // Inside the grace window: it fires.
    expect(await tickAt(once.slot + 60_000)).toBe(1);
    const fired = await onceSchedule();
    expect(fired.history).toHaveLength(1);
    expect(fired.history[0].slot).toBe(once.slot);
    expect(fired.last_slot).toBe(once.slot);
    onceRun = fired.history[0].run_task_id;
    runs.push(onceRun);
    await browser.waitUntil(
      async () => ((await onceSchedule())?.history ?? [])[0]?.outcome === "fired",
      { timeout: 30_000, interval: 250, timeoutMsg: "the one-off's run never reached fired" },
    );
    // Neither a minute later nor a week later does it run again.
    expect(await tickAt(once.slot + 120_000)).toBe(0);
    expect(await tickAt(once.slot + 7 * 86_400_000)).toBe(0);
    expect((await onceSchedule()).history).toHaveLength(1);
  });
});

// The same feature through its own surfaces: the Scheduled view, the schedule
// dialog and the task menu. Setup is the dialog itself, not the store.
describe("the Scheduled view and dialog", () => {
  let projectId = "";
  let root = "";
  let parent = "";
  let dockerTask = "";
  let onceParent = "";
  const runs: string[] = [];
  const NAME = "e2e ui schedule";

  const rowSel = (id: string) => `[data-testid="schedule-row-${id}"]`;
  const attr = (sel: string, name: string) =>
    browser.execute((s, n) => document.querySelector(s)?.getAttribute(n) ?? null, sel, name) as Promise<string | null>;
  const text = (sel: string) =>
    browser.execute((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel) as Promise<string | null>;
  const diskTask = (id: string) =>
    browser.execute(async (i) => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return all.find(t => t.id === i) ?? null;
    }, id) as Promise<any>;
  /** The dialog on screen, by its own test id: dialogs stack. */
  const inDialog = (sel: string) => `[data-testid="schedule-dialog"] ${sel}`;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().projects.some((x: any) => x.name === "fixture-repo")),
      { timeout: 15_000, timeoutMsg: "the fixture project never loaded" },
    );
    ({ projectId, root } = await browser.execute(() => {
      const p = window.__termic!.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      return { projectId: p.id as string, root: p.root_path as string };
    }));
    await browser.execute((p) => window.__termic!.useApp.getState().setProjectCollapsed(p, false), projectId);
    await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
    await dismissOverlays();
  });

  after(async () => {
    for (const id of [parent, onceParent].filter(Boolean)) {
      await browser.execute(async (i) => {
        const t = window.__termic!;
        if (t.useApp.getState().tasks.find((x: any) => x.id === i)?.schedule) await t.scheduleRunner.deleteSchedule(i, true);
      }, id).catch(() => {});
    }
    for (const id of [...runs, parent, onceParent, dockerTask].filter(Boolean)) {
      const t = await diskTask(id).catch(() => null);
      if (t && !t.archived) await archiveTask(id);
    }
    for (const dir of [path.join(root, ".termic", "schedules"), path.join(root, ".termic")]) {
      try { rmdirSync(dir); } catch { /* not empty, or never made */ }
    }
    const exclude = path.join(root, ".git", "info", "exclude");
    if (existsSync(exclude)) {
      const kept = readFileSync(exclude, "utf8").split("\n").filter(l => l !== "/.termic/schedules/");
      writeFileSync(exclude, kept.join("\n"));
    }
  });

  // Settings -> Appearance -> Sidebar's three-way. "With schedules" is
  // asserted against the store rather than a fixed answer, so this holds
  // whichever schedules the cases above left behind.
  it("the Scheduled nav entry follows its setting", async () => {
    const nav = '[data-testid="nav-scheduled"]';
    const shown = () => browser.execute((s) => !!document.querySelector(s), nav);
    const setMode = (m: string) => browser.execute(
      (v) => window.__termic!.usePrefs.getState().setScheduledNav(v as any), m,
    );
    const expectShown = (want: boolean, why: string) =>
      browser.waitUntil(async () => (await shown()) === want, { timeout: 5_000, timeoutMsg: why });
    await waitVisible(nav);
    try {
      await setMode("off");
      await expectShown(false, "the Scheduled entry stayed with the setting off");
      await setMode("auto");
      const has = await browser.execute(() =>
        window.__termic!.useApp.getState().tasks.some((t: any) => !!t.schedule && !t.archived));
      await expectShown(has, `"With schedules" disagreed with the store (has a schedule: ${has})`);
    } finally {
      await setMode("always");
    }
    await expectShown(true, "the Scheduled entry did not come back on Always");
  });

  it("the nav opens the Scheduled view, which states its ceiling", async () => {
    await clickWhenVisible('[data-testid="nav-scheduled"]');
    await waitVisible('[data-testid="scheduled-root"]');
    expect(await text('[data-testid="scheduled-ceiling"]')).toContain("only while Termic is running");
    await snap("schedules-ui-01-view.png");
  });

  it("New schedule creates one through the dialog", async () => {
    await clickWhenVisible('[data-testid="schedule-new"]');
    await waitVisible(inDialog('[data-testid="schedule-name"]'));
    expect(await text(inDialog('[data-testid="schedule-ceiling"]'))).toContain("Missed runs are skipped");
    await setInputValue(inDialog('[data-testid="schedule-name"]'), NAME);
    await browser.execute((sel, pid) => {
      const s = document.querySelector(sel) as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, pid);
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }, inDialog('[data-testid="schedule-project"]'), projectId);
    await clickWhenVisible(inDialog('[data-testid="schedule-agent-fakeagent"]'));
    await browser.waitUntil(
      async () => (await attr(inDialog('[data-testid="schedule-agent-fakeagent"]'), "aria-pressed")) === "true",
      { timeout: 5_000, timeoutMsg: "picking FakeAgent did not select it" },
    );
    await setInputValue(inDialog('[data-testid="schedule-prompt"]'), "#report");
    await clickWhenVisible(inDialog('[data-testid="schedule-cadence"] [data-value="weekly"]'));
    // Three days out, so the real ticker never fires it mid-spec.
    await browser.execute((sel) => {
      const s = document.querySelector(sel) as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, String((new Date().getDay() + 3) % 7));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }, inDialog('[data-testid="schedule-weekday"]'));
    // The dialog takes the two widths New Task used to: one column until a Seatbelt
    // cage is picked, then a second column with the cage's allow-lists. It
    // shipped capped at AppDialog's 448px and with no second column at all.
    const dialogWidth = () => browser.execute(
      (sel) => Math.round((document.querySelector(sel)!.closest('[role="dialog"]') as HTMLElement).getBoundingClientRect().width),
      '[data-testid="schedule-dialog"]',
    );
    const cage = inDialog('[data-testid="schedule-cage-column"]');
    const pick = (mode: string) => clickWhenVisible(inDialog(`[data-sandbox-option="${mode}"]`));
    await pick("off");
    await waitGone(cage);
    const narrow = await dialogWidth();
    expect(narrow).toBeGreaterThan(448);
    if (process.platform === "darwin") {
      await pick("enforce");
      await waitVisible(inDialog('[data-testid="schedule-allowed-hosts"]'));
      expect(await dialogWidth()).toBeGreaterThan(narrow);
      await snap("schedules-ui-02b-dialog-cage.png");
      // Enforcing (FS) has no network cage, so no host list to fill in.
      await pick("enforce-fs");
      await waitGone(inDialog('[data-testid="schedule-allowed-hosts"]'));
      await waitVisible(inDialog('[data-testid="schedule-rw-paths"]'));
      await pick("off");
      await waitGone(cage);
      expect(await dialogWidth()).toBe(narrow);
    }
    await snap("schedules-ui-02-dialog.png");
    await clickWhenVisible('[data-testid="schedule-submit"]');
    await waitGone('[data-testid="schedule-dialog"]');

    parent = await browser.waitUntil(
      () => browser.execute((n) => window.__termic!.useApp.getState().tasks.find((t: any) => t.schedule?.name === n)?.id ?? false, NAME),
      { timeout: 10_000, timeoutMsg: "the dialog never created the schedule" },
    ) as unknown as string;
    await waitVisible(rowSel(parent));
    expect(await text(`[data-testid="schedule-name-${parent}"]`)).toBe(NAME);
    expect(await text(`[data-testid="schedule-cadence-${parent}"]`)).toMatch(/^Every \w+ at 09:00$/);
    expect(await text(`[data-testid="schedule-next-${parent}"]`)).toMatch(/^Next /);
    expect(await attr(`[data-testid="schedule-last-${parent}"]`, "data-outcome")).toBe("none");
    // The parent was created, not started.
    expect(await browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"]`), parent)).toBe(false);
    expect((await diskTask(parent)).cli).toBe("fakeagent");
  });

  it("Once shows a date, and the dialog refuses a moment that has passed", async () => {
    await clickWhenVisible('[data-testid="schedule-new"]');
    await waitVisible(inDialog('[data-testid="schedule-name"]'));
    const dateSel = inDialog('[data-testid="schedule-date"]');
    expect(await browser.execute((sel) => !!document.querySelector(sel), dateSel)).toBe(false);
    await clickWhenVisible(inDialog('[data-testid="schedule-cadence"] [data-value="once"]'));
    await waitVisible(dateSel);
    // The date defaults to tomorrow and cannot be picked from the past.
    const tomorrow = await browser.execute(() => {
      const d = new Date(Date.now() + 86_400_000);
      const p2 = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    });
    expect(await browser.execute((sel) => (document.querySelector(sel) as HTMLInputElement).value, dateSel)).toBe(tomorrow);
    expect(await attr(dateSel, "min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await browser.execute((sel) => document.querySelector(sel)!.scrollIntoView({ block: "center" }), dateSel);
    await snap("schedules-ui-02c-dialog-once.png");

    await setInputValue(inDialog('[data-testid="schedule-name"]'), "e2e past one-off");
    await setInputValue(inDialog('[data-testid="schedule-prompt"]'), "#report");
    await setInputValue(dateSel, "2020-01-01");
    await clickWhenVisible('[data-testid="schedule-submit"]');
    await waitVisible('[data-testid="schedule-error"]');
    expect(await text('[data-testid="schedule-error"]')).toBe("Pick a date and time that are still ahead.");
    await snap("schedules-ui-02d-dialog-once-past.png");
    // Refused: nothing was created.
    expect(await browser.execute(() =>
      window.__termic!.useApp.getState().tasks.some((t: any) => t.schedule?.name === "e2e past one-off"))).toBe(false);

    // Back to tomorrow (09:00, the default time): created, and the row reads
    // its date and a next run on it.
    await browser.execute((sel, pid) => {
      const s = document.querySelector(sel) as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, pid);
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }, inDialog('[data-testid="schedule-project"]'), projectId);
    await clickWhenVisible(inDialog('[data-testid="schedule-agent-fakeagent"]'));
    await setInputValue(dateSel, tomorrow);
    await clickWhenVisible('[data-testid="schedule-submit"]');
    await waitGone('[data-testid="schedule-dialog"]');
    onceParent = await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().tasks.find((t: any) => t.schedule?.name === "e2e past one-off")?.id ?? false),
      { timeout: 10_000, timeoutMsg: "the dialog never created the one-off" },
    ) as unknown as string;
    await waitVisible(rowSel(onceParent));
    expect(await text(`[data-testid="schedule-cadence-${onceParent}"]`)).toMatch(/^Once on .+ at 09:00$/);
    expect(await text(`[data-testid="schedule-next-${onceParent}"]`)).toMatch(/^Next /);

    // The app was "closed" over its slot: a pass a day later records it
    // missed (catch-up is off by default) and the row reads Done, not Paused.
    const slot = await browser.execute((d) => {
      const [y, m, day] = d.split("-").map(Number);
      return new Date(y, m - 1, day, 9, 0).getTime();
    }, tomorrow);
    await browser.execute(async (n) => window.__termic!.scheduleRunner.scheduleTickNow(n), slot + 86_400_000);
    const sched = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.schedule, onceParent) as any;
    expect(sched.history.map((h: any) => h.outcome)).toEqual(["missed"]);
    await browser.waitUntil(async () => (await text(`[data-testid="schedule-next-${onceParent}"]`)) === "Done", {
      timeout: 5_000, timeoutMsg: "a finished one-off did not read Done",
    });
    await browser.execute((sel) => document.querySelector(sel)!.scrollIntoView({ block: "center" }), rowSel(onceParent));
    await snap("schedules-ui-02e-once-done.png");
  });

  it("Run now from the view runs it, and the last run links its report", async () => {
    await clickWhenVisible(`[data-testid="schedule-run-now-${parent}"]`);
    const last = `[data-testid="schedule-last-${parent}"]`;
    await browser.waitUntil(async () => (await attr(last, "data-outcome")) === "fired", {
      timeout: 30_000, interval: 250, timeoutMsg: "the view never showed the run's report",
    });
    expect(await text(last)).toBe("Fake scheduled report");
    const run = await browser.execute((id) => {
      const h = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).schedule.history;
      return h[h.length - 1].run_task_id as string;
    }, parent) as string;
    runs.push(run);
    await snap("schedules-ui-03-fired.png");

    await clickWhenVisible(`${last} [data-testid="schedule-report-link"]`);
    await browser.waitUntil(
      () => browser.execute((id) => document.querySelector(`[data-task-id="${id}"] .markdown-body h1`)?.textContent ?? null, run)
        .then(t => t === "Fake scheduled report"),
      { timeout: 15_000, timeoutMsg: "the report link did not open the rendered report" },
    );
    await clickWhenVisible('[data-testid="nav-scheduled"]');
    await waitVisible(rowSel(parent));
  });

  it("the switch pauses it, and an edit renames it without moving its reports", async () => {
    const slug = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).schedule.slug, parent);
    await clickWhenVisible(`[data-testid="schedule-toggle-${parent}"]`);
    await browser.waitUntil(async () => (await attr(rowSel(parent), "data-schedule-enabled")) === "false", {
      timeout: 8_000, timeoutMsg: "the switch did not pause the schedule",
    });
    expect(await text(`[data-testid="schedule-next-${parent}"]`)).toBe("Paused");
    expect((await diskTask(parent)).schedule.enabled).toBe(false);

    await clickWhenVisible(`[data-testid="schedule-edit-${parent}"]`);
    await waitVisible(inDialog('[data-testid="schedule-name"]'));
    // Edit shows the schedule's fields, not the parent's agent settings.
    expect(await browser.execute((s) => !!document.querySelector(s), inDialog('[data-testid="schedule-inherits"]'))).toBe(true);
    expect(await browser.execute((s) => !!document.querySelector(s), inDialog('[data-testid="schedule-agent-fakeagent"]'))).toBe(false);
    await setInputValue(inDialog('[data-testid="schedule-name"]'), `${NAME} renamed`);
    await clickWhenVisible('[data-testid="schedule-submit"]');
    await waitGone('[data-testid="schedule-dialog"]');
    await browser.waitUntil(async () => (await text(`[data-testid="schedule-name-${parent}"]`)) === `${NAME} renamed`, {
      timeout: 8_000, timeoutMsg: "the edit never reached the row",
    });
    const s = (await diskTask(parent)).schedule;
    expect(s.slug).toBe(slug);
    expect(s.enabled).toBe(false);
    // The parent was named after the schedule, so it follows the rename, and
    // so does its sidebar group, which shows its lead's name.
    expect((await diskTask(parent)).name).toBe(`${NAME} renamed`);
    await browser.waitUntil(async () => (await text(`[data-testid="task-group-label-${parent}"]`)) === `${NAME} renamed`, {
      timeout: 8_000, timeoutMsg: "the sidebar group kept the old name",
    });

    await clickWhenVisible(`[data-testid="schedule-toggle-${parent}"]`);
    await browser.waitUntil(async () => (await attr(rowSel(parent), "data-schedule-enabled")) === "true", {
      timeout: 8_000, timeoutMsg: "the switch did not turn the schedule back on",
    });
    await snap("schedules-ui-04-edited.png");
  });

  it("Schedule... is disabled on a Docker task, and says why", async () => {
    dockerTask = await browser.execute(async (pid) => {
      const t = window.__termic!;
      const task = await t.ipc.taskOpenRepo(pid, "fakeagent", "e2e-docker-sched",
        { enabled: false, rwPaths: [], allowedHosts: [], docker: true });
      await t.useApp.getState().loadAll();
      return task.id as string;
    }, projectId) as string;
    await waitVisible(`[data-sidebar-task-id="${dockerTask}"]`);
    await browser.execute((i) => {
      document.querySelector(`[data-sidebar-task-id="${i}"]`)!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    }, dockerTask);
    const item = `[data-testid="task-schedule-${dockerTask}"]`;
    await waitVisible(item);
    expect(await attr(item, "data-disabled")).not.toBeNull();
    expect(await text(`[data-testid="task-schedule-docker-${dockerTask}"]`)).toBe("Scheduled runs do not support Docker yet");
    await snap("schedules-ui-05-docker-disabled.png");
    await browser.keys("Escape");
    await dismissOverlays();
  });

  it("delete asks, and keeps the reports unless told otherwise", async () => {
    const slug = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).schedule.slug, parent);
    await clickWhenVisible('[data-testid="nav-scheduled"]');
    await clickWhenVisible(`[data-testid="schedule-delete-${parent}"]`);
    await snap("schedules-ui-06-delete-confirm.png");
    await clickByText("Delete schedule");
    await waitGone(rowSel(parent));
    expect((await diskTask(parent)).schedule).toBeUndefined();
    // Kept: the report the run wrote is still there.
    const folder = path.join(root, ".termic", "schedules", slug);
    expect(existsSync(folder)).toBe(true);
    // The parent is an ordinary task now; remove what the run left behind.
    rmSync(folder, { recursive: true, force: true });
  });
});
