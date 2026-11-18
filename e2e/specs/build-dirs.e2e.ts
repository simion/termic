import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  createWorktreeTask, dismissOverlays, ensureActiveTask, requireTermicApi, rmTree, snap,
  waitForAppShell, waitForText, waitTaskUnmounted,
} from "../helpers";

// Idle build-folder cleanup (src-tauri/src/build_dirs.rs, src/lib/idleBuildDirs.ts).
// The selection rules are unit-tested in Rust; this drives the real pass on a
// real worktree and the restore that runs when the task is opened again.
describe("idle build-folder cleanup", () => {
  const NAME = "e2e-build-dirs";
  let taskId = "";
  let wt = "";
  const record = () => path.join(dataDir, "tasks", `${taskId}.json`);
  const read = () => JSON.parse(readFileSync(record(), "utf8"));

  /** Ignored node_modules (untracked .gitignore, so the fixture repo is not
   *  touched), a TRACKED dir with an allowlisted name, and a record aged past
   *  the 14-day default. Aged on disk, not by waiting. */
  const seed = () => {
    writeFileSync(path.join(wt, ".gitignore"), "node_modules/\n");
    mkdirSync(path.join(wt, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(wt, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(path.join(wt, "lib", "node_modules"), { recursive: true });
    writeFileSync(path.join(wt, "lib", "node_modules", "keep.js"), "x");
    execSync(`git -C "${wt}" add -f lib/node_modules/keep.js`);
    const rec = read();
    delete rec.last_active_at;
    writeFileSync(record(), JSON.stringify({ ...rec, created: "2026-01-01T00:00:00Z" }, null, 2));
  };

  /** A pass that frees this task. The window's own task is never idle and a
   *  live PTY is never touched, so close the task first and wait for its
   *  PTYs to be reaped (a kill is asynchronous), retrying the pass until then. */
  const freeThisTask = async () => {
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      s.stopTask(id);
      s.setActiveTask(null);
    }, taskId);
    await waitTaskUnmounted(taskId);
    let report: { tasks: string[]; bytes: number } | null = null;
    await browser.waitUntil(async () => {
      report = (await browser.execute(() => window.__termic!.runIdleBuildDirCleanup())) as typeof report;
      return !!report?.tasks.includes(taskId);
    }, { timeout: 15_000, interval: 500, timeoutMsg: "the idle task was never freed" });
    return report!;
  };

  const setSetupScript = (script: string) =>
    browser.execute(async (s) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      await t.ipc.projectUpdate({ ...p, setup_script: s });
      await t.useApp.getState().loadAll();
    }, script);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    taskId = await createWorktreeTask(NAME, NAME, false);
    wt = (await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).path,
      taskId,
    )) as string;
    seed();
  });

  after(async () => {
    await setSetupScript("");
    if (taskId) {
      await browser.execute(async (id) => {
        const t = window.__termic!;
        try { await t.ipc.taskArchive(id, true, true); } catch { /* gone */ }
        await t.useApp.getState().loadAll();
      }, taskId);
    }
    // Belt and braces: the worktree holds untracked files the spec made.
    if (wt && existsSync(wt)) rmTree(wt, { bestEffort: true });
  });

  it("frees an ignored node_modules and keeps a tracked one", async () => {
    const report = await freeThisTask();
    expect(report.bytes).toBeGreaterThan(0);
    expect(existsSync(path.join(wt, "node_modules"))).toBe(false);
    expect(existsSync(path.join(wt, "lib", "node_modules", "keep.js"))).toBe(true);
    expect(read().artifacts_freed_at).toBeTruthy();
    await waitForText("Freed ");
    await snap("build-dirs-freed.png");
  });

  it("opening a freed task with no setup script says so, and clears the marker", async () => {
    await ensureActiveTask(taskId);
    await waitForText(`Build folders in ${NAME} were freed`);
    await browser.waitUntil(() => !read().artifacts_freed_at, { timeout: 8_000, timeoutMsg: "marker never cleared" });
    expect(read().last_active_at).toBeTruthy();
    expect(await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).some((t: any) => t.runTab?.kind === "setup"),
      taskId,
    )).toBe(false);
    await snap("build-dirs-restore-toast.png");
  });

  it("leaves an open task alone however old its record says it is", async () => {
    // Open (active, agent running) but aged on disk past the threshold.
    seed();
    const report = (await browser.execute(() => window.__termic!.runIdleBuildDirCleanup())) as
      { tasks: string[] } | null;
    expect(report?.tasks ?? []).not.toContain(taskId);
    expect(existsSync(path.join(wt, "node_modules", "pkg", "index.js"))).toBe(true);
  });

  it("opening a freed task with a setup script re-runs it", async () => {
    await setSetupScript("echo e2e-setup");
    seed();
    await freeThisTask();
    expect(existsSync(path.join(wt, "node_modules"))).toBe(false);

    await ensureActiveTask(taskId);
    await browser.waitUntil(
      () => browser.execute(
        (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])
          .some((t: any) => t.runTab?.kind === "setup"),
        taskId,
      ),
      { timeout: 15_000, timeoutMsg: "opening the freed task did not start its setup script" },
    );
    await browser.waitUntil(() => !read().artifacts_freed_at, { timeout: 8_000, timeoutMsg: "marker never cleared" });
  });
});
