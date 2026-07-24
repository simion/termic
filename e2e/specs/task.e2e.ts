import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { archiveTask, clickByText, openTask, requireTermicApi, snap, waitForAppShell, waitForText } from "../helpers";

// P0: create a task through the real NewTaskDialog wizard (the primary user
// path; the other specs take the IPC shortcut). Uses the shell ("Terminal")
// CLI in Main-checkout (repo-root) mode so it's token-free and safe to archive.
// Everything is scoped to the dialog: the app footer also has a "Terminal"
// button, so an unscoped text match would hit the wrong control.
describe("create task wizard", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Click a button by its exact text inside the NewTaskDialog specifically
  // (scoped via the name input's dialog — there can be more than one
  // [role="dialog"] in the DOM). Waits for the button first: the dialog renders
  // progressively (the mode toggle lands after an async worktree scan).
  const clickDialogButton = async (text: string) => {
    await browser.waitUntil(
      () =>
        browser.execute((t) => {
          const dlg = document
            .querySelector('input[placeholder="fix login bug"]')
            ?.closest('[role="dialog"]');
          return [...(dlg?.querySelectorAll("button") ?? [])].some(
            (b) => b.textContent?.trim() === t,
          );
        }, text),
      { timeout: 8_000, timeoutMsg: `dialog button never appeared: ${text}` },
    );
    await browser.execute((t) => {
      const dlg = document
        .querySelector('input[placeholder="fix login bug"]')
        ?.closest('[role="dialog"]');
      const btn = [...(dlg?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === t,
      );
      (btn as HTMLElement).click();
    }, text);
  };

  it("creates a repo-root shell task via NewTaskDialog", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Open the wizard for fixture-repo (the sidebar "+" action).
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(
              '[role="dialog"] input[placeholder="fix login bug"]',
            ),
        ),
      { timeout: 8_000, timeoutMsg: "NewTaskDialog never opened" },
    );

    // Force Main checkout (repo-root) mode — the last-used mode is persisted.
    await clickDialogButton("Main checkout");

    // Type the task name into the controlled input.
    await browser.execute(() => {
      const input = document.querySelector(
        '[role="dialog"] input[placeholder="fix login bug"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-wizard");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Pick the Terminal (shell) CLI — token-free — then Create.
    await clickDialogButton("Terminal");
    await clickDialogButton("Create");

    // A repo-root task with that name now exists.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          window.__termic!.useApp
            .getState()
            .tasks.some((t: any) => t.name === "e2e-wizard" && !t.archived),
        ),
      { timeout: 15_000, timeoutMsg: "wizard did not create the task" },
    );
    taskId = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.name === "e2e-wizard" && !t.archived)?.id,
    );

    await snap("create-wizard.png");
  });
});

// The single most important flow in termic: create a task in a project and
// have the agent's terminal come alive. One green run proves project/task IO,
// git-worktree/checkout setup, the Rust PTY spawn, and tab/store wiring.
// Uses `fakeagent` (a claude-like fixture CLI, zero tokens).
describe("task spawn", () => {
  let taskId: string | undefined;

  // Keep the profile clean across repeated runs: archive the task we created
  // (kills its PTY, moves it off the active board). Repo-root task, so archive
  // never removes a worktree.
  after(async () => {
    if (!taskId) return;
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskArchive(id);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
  });

  it("spawns a task and the agent PTY comes alive", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Create the task through the app's own IPC (fast + robust vs. clicking
    // the create wizard). Repo-root task: no worktree, safe to archive later.
    taskId = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "e2e-spawn");
      await t.useApp.getState().loadAll();
      t.useApp.getState().setActiveTask(task.id);
      return task.id as string;
    });
    expect(typeof taskId).toBe("string");

    // The PTY spawns once the task view mounts. Poll the store, don't sleep.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tabs = window.__termic!.useApp.getState().tabs[id] ?? [];
          return tabs.length > 0 && !!tabs[0].ptyId;
        }, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    // Round-trip: write to the PTY and assert new output lands. Terminal
    // content is a WebGL canvas (never in the DOM), so assert via the store's
    // lastOutputAt, not innerText.
    const before = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
      taskId,
    );
    await browser.execute(async (id) => {
      const t = window.__termic!;
      const tab = t.useApp.getState().tabs[id][0];
      await t.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("ping\r")),
      );
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute(
          (a) =>
            (window.__termic!.useApp.getState().tabs[a.id][0].lastOutputAt ??
              0) !== a.before,
          { id: taskId, before },
        ),
      { timeout: 10_000, timeoutMsg: "no PTY output after write" },
    );

    // The claude-like fixture drives the OSC terminal title (✳ when idle, a
    // spinner while working); termic ingests it as the tab's liveTitle. This
    // proves the fake agent's title behavior reaches the app end to end.
    // (We assert liveTitle rather than workState because termic gates the
    // working indicator on a real submit through its input path, which a raw
    // ptyWrite intentionally bypasses — that heuristic gets its own test.)
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tab = window.__termic!.useApp.getState().tabs[id][0];
          return !!tab.liveTitle && tab.liveTitle.includes("e2e-spawn");
        }, taskId),
      {
        timeout: 10_000,
        timeoutMsg: "agent OSC title (liveTitle) never reached the app",
      },
    );

    await snap("task-spawn.png");
  });
});

// The task lifecycle's other half: archiving. Guards the archive path (which
// on a real worktree task removes the checkout) and the store transition that
// moves a task out of the active board and into History.
describe("task archive", () => {
  it("archives a task and removes it from the active list", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // A repo-root task (task_open_repo): archiving it never rm -rf's a
    // worktree, so this fixture is safe to create and destroy repeatedly.
    const taskId = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "e2e-archive");
      await t.useApp.getState().loadAll();
      return task.id as string;
    });

    // Precondition: it exists and is active (not archived).
    const activeBefore = await browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.some((t: any) => t.id === id && !t.archived),
      taskId,
    );
    expect(activeBefore).toBe(true);

    // Archive it (deleteBranch defaults off).
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskArchive(id);
      await t.useApp.getState().loadAll();
    }, taskId);

    // It is now archived and gone from the active set.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const task = window.__termic!.useApp
            .getState()
            .tasks.find((t: any) => t.id === id);
          return !!task && task.archived === true;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "task never became archived" },
    );
    const stillActive = await browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.some((t: any) => t.id === id && !t.archived),
      taskId,
    );
    expect(stillActive).toBe(false);

    await snap("task-archive.png");
  });
});

// Completes the task lifecycle: archive -> it appears in History -> restore ->
// it's active again. Guards the History view's filtering and the restore path.
describe("task restore", () => {
  let taskId: string | undefined;
  after(async () => {
    // Leave it archived (out of the active board) for the next run.
    if (taskId) await archiveTask(taskId);
  });

  it("restores an archived task from History", async () => {
    await waitForAppShell();
    await requireTermicApi();

    taskId = await openTask("e2e-restore", false);
    await archiveTask(taskId);

    // Navigate to History (real click) and confirm the task is listed there.
    await clickByText("History");
    await waitForText("e2e-restore");

    // Restore it. The hover-gated "Restore ->" button wraps exactly this call;
    // we invoke it directly so the assertion isn't at the mercy of a hover.
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRestore(id);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);

    // The task is active again (no longer archived).
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const task = window.__termic!.useApp
            .getState()
            .tasks.find((t: any) => t.id === id);
          return !!task && task.archived === false;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "task was never restored to active" },
    );

    await snap("task-restore.png");
  });
});

// P1: task rename + permanent delete (distinct from archive). Cases: renaming
// updates the store and the sidebar; deleting removes the task entirely (not
// just archived).
describe("task lifecycle", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const id of cleanup) {
      const exists = await browser.execute(
        (i) => window.__termic!.useApp.getState().tasks.some((t: any) => t.id === i),
        id,
      );
      if (exists) await archiveTask(id);
    }
  });

  it("renames a task (store + sidebar)", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const id = await openTask("e2e-life-rename");
    cleanup.push(id);

    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskRename(i, "renamed-task");
      await window.__termic!.useApp.getState().loadAll();
    }, id);

    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .tasks.find((t: any) => t.id === i)?.name === "renamed-task",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "task name never updated in the store" },
    );
    // The sidebar reflects the new name.
    await waitForText("renamed-task");
  });

  it("deletes a task permanently", async () => {
    const id = await openTask("e2e-life-delete", false);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskDelete(i);
      await window.__termic!.useApp.getState().loadAll();
    }, id);

    // Gone entirely — not present in the tasks list at all (archived or not).
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            !window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.id === i),
          id,
        ),
      { timeout: 8_000, timeoutMsg: "deleted task still present" },
    );
    await snap("task-lifecycle.png");
  });
});

// termic's core promise: many parallel agents, each in its own task, all
// alive at once. This guards that two tasks run independent PTYs, that a task
// stays alive when it's not the active one (panes are kept mounted), and that
// switching the active task works.
describe("multi-task isolation", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  const waitForPty = (id: string, label: string) =>
    browser.waitUntil(
      () =>
        browser.execute((i) => {
          const tabs = window.__termic!.useApp.getState().tabs[i] ?? [];
          return tabs.length > 0 && !!tabs[0].ptyId;
        }, id),
      { timeout: 20_000, interval: 250, timeoutMsg: `${label} PTY never spawned` },
    );
  const ptyOf = (id: string) =>
    browser.execute(
      (i) => window.__termic!.useApp.getState().tabs[i][0].ptyId as string,
      id,
    );
  const activeTask = () =>
    browser.execute(() => window.__termic!.useApp.getState().activeTaskId);

  it("runs two tasks with independent PTYs and switches between them", async () => {
    await waitForAppShell();
    await requireTermicApi();

    a = await openTask("e2e-multi-a"); // spawns + becomes active
    await waitForPty(a, "task A");
    const ptyA = await ptyOf(a);

    b = await openTask("e2e-multi-b"); // spawns + becomes active
    await waitForPty(b, "task B");
    expect(await activeTask()).toBe(b);

    // Both PTYs are alive and DISTINCT, and A survived going inactive
    // (termic keeps background task panes mounted).
    const ptyB = await ptyOf(b);
    const ptyAstill = await ptyOf(a);
    expect(ptyAstill).toBe(ptyA);
    expect(ptyB).not.toBe(ptyA);

    // Switch back to A (the store action a sidebar click triggers).
    await browser.execute(
      (id) => window.__termic!.useApp.getState().setActiveTask(id),
      a,
    );
    expect(await activeTask()).toBe(a);

    await snap("multi-task.png");
  });
});

// P2: creating a WORKTREE task (branch in its own working dir), vs the repo-root
// tasks the rest of the suite uses. Verifies it lands on its own branch, then
// archives it (removes the worktree) and prunes the branch.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const BRANCH = "e2e-wt-branch";

describe("worktree task", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.taskArchive(id, true); // deleteBranch
        await window.__termic!.useApp.getState().loadAll();
      }, taskId);
    }
    try {
      execSync(`git -C "${fixture}" worktree prune`);
      execSync(`git -C "${fixture}" branch -D ${BRANCH}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  });

  it("creates a task on its own worktree branch", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const t = await browser.execute(async (branch) => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await window.__termic!.ipc.taskCreate({
        project_id: proj.id,
        name: "e2e-wt",
        cli: "fakeagent",
        base_branch: "main",
        branch,
      });
      await window.__termic!.useApp.getState().loadAll();
      return task;
    }, BRANCH);
    taskId = (t as any).id;

    // It's a worktree: on its own branch, not the main checkout.
    expect((t as any).branch).toBe(BRANCH);
    expect((t as any).is_main_checkout).not.toBe(true);
    await snap("worktree-task.png");
  });
});

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

// P1: Agent Race — fire ONE prompt at N agents, each in its own fresh worktree,
// and seed the prompt into every agent once it boots (src/lib/agentRace.ts). The
// dialog-opens smoke lives in app.e2e.ts; THIS asserts the engine end to end:
// the cohort is recorded, every racer's default agent tab spawns a live PTY, and
// every racer receives the prompt after the settle (lastInputAt stamped + the
// fakeagent's OSC title flips to its working spinner). Regression guard for the
// "race just sits there" failure mode — an agent that spawns but never gets fed.
describe("agent race", () => {
  // Unique per run so a re-run never collides on the race branch/worktree even
  // if a prior run's cleanup was interrupted (git worktree add is unforgiving).
  const raceName = `e2erace-${Date.now()}`;
  let taskIds: string[] = [];

  before(() => {
    // Racers branch off the project default `origin/main`, so that ref must
    // resolve. The git commit-push spec swaps the fixture's origin to a
    // throwaway and restores it, but keep this test independent of run order:
    // if origin/main is missing, restore it from the seeded sibling bare repo.
    try {
      execSync(`git -C "${fixture}" rev-parse --verify -q origin/main`, {
        stdio: "ignore",
      });
    } catch {
      const seedOrigin = `${fixture}-origin.git`;
      if (existsSync(seedOrigin)) {
        try {
          execSync(`git -C "${fixture}" remote add origin "${seedOrigin}"`, {
            stdio: "ignore",
          });
        } catch {
          /* remote already present, just needs a fetch */
        }
        execSync(`git -C "${fixture}" fetch -q origin`, { stdio: "ignore" });
      }
    }
  });

  after(async () => {
    // Hard-delete each racer: removes its worktree AND wipes the task file, so
    // the next run starts from the same clean fixture. Best-effort.
    for (const id of taskIds) {
      await browser
        .execute(async (i) => {
          await window.__termic!.ipc.taskDelete(i);
          await window.__termic!.useApp.getState().loadAll();
        }, id)
        .catch(() => {});
    }
    // taskDelete keeps the branch (deleteBranch=false), so prune the worktrees
    // AND the race branches this run created, or the fixture accrues them.
    try {
      execSync(`git -C "${fixture}" worktree prune`);
      for (const n of [1, 2]) {
        execSync(`git -C "${fixture}" branch -D race/${raceName}/fakeagent-${n}`, {
          stdio: "ignore",
        });
      }
    } catch {
      /* nothing to prune */
    }
  });

  it("fires one prompt at 2 agents, each spawns and receives it", async () => {
    await waitForAppShell();
    await requireTermicApi();

    taskIds = (await browser.execute(
      async (name) => {
        const t = window.__termic!;
        const proj = t.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo");
        return await t.agentRace.startRace({
          projectId: proj.id,
          racers: [
            { cli: "fakeagent", n: 1 },
            { cli: "fakeagent", n: 2 },
          ],
          prompt: "hello from the race test",
          name,
        });
      },
      raceName,
    )) as string[];

    expect(taskIds).toHaveLength(2);

    // 1) The cohort is recorded before anything mounts, so the board can
    //    enumerate exactly which worktrees raced.
    const cohort = await browser.execute((ids: string[]) => {
      const races = Object.values(
        window.__termic!.useRace.getState().races ?? {},
      ) as any[];
      const c = races.find((r) => ids.every((id) => r.taskIds.includes(id)));
      return c ? { taskIds: c.taskIds } : null;
    }, taskIds);
    expect(cohort?.taskIds).toEqual(expect.arrayContaining(taskIds));

    // Reads the default agent tab (the seeded, is_default terminal) of every
    // racer at once — the exact tab agentRace targets for prompt injection.
    const racerTabs = () =>
      browser.execute((ids: string[]) => {
        const app = window.__termic!.useApp.getState();
        return ids.map((id) => {
          const def = (app.tabs[id] ?? []).find(
            (x: any) => x.type === "terminal" && x.is_default,
          );
          return {
            ptyId: def?.ptyId ?? null,
            lastInputAt: def?.lastInputAt ?? null,
            liveTitle: def?.liveTitle ?? null,
          };
        });
      }, taskIds);

    // 2) Both racers' agents actually spawn: their default tab acquires a live
    //    PTY. This is the "did the hidden/inactive racer boot at all" guard.
    await browser.waitUntil(
      async () => (await racerTabs()).every((t) => !!t.ptyId),
      { timeout: 20_000, timeoutMsg: "a racer never spawned its agent PTY" },
    );

    // 3) Both racers receive the prompt after the settle: agentRace stamps
    //    lastInputAt when it injects. This is the core "sits there" guard — an
    //    agent that spawned but was never fed would fail HERE.
    await browser.waitUntil(
      async () => (await racerTabs()).every((t) => !!t.lastInputAt),
      {
        timeout: 20_000,
        timeoutMsg: "a racer spawned but never received the race prompt",
      },
    );

    // 4) The seeded terminals are real fakeagent PTYs driving claude-style OSC
    //    titles (✳ idle / Braille spinner working), not empty shells. Poll: the
    //    inactive racer's title can lag a beat behind its prompt injection.
    await browser.waitUntil(
      async () =>
        (await racerTabs()).every((t) =>
          (t.liveTitle ?? "").includes("fakeagent"),
        ),
      {
        timeout: 15_000,
        timeoutMsg: "a racer never published its fakeagent OSC title",
      },
    );
    await snap("agent-race.png");
  });
});
