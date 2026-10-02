import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTask, clickByText, clickMenuItemUntil, clickWhenVisible, cliRpc, dashboardBadge, dismissOverlays, ensureActiveTask, openTask, pointerDrag, requireTermicApi, requireWorkBadges, keysIn, rmTree, setWindowPresence, snap, submitToAgent, typeIntoAgent, waitForAgentReady, waitForAppShell, waitForText, waitForTextGone, waitForWorkBadge, waitGone, waitVisible  } from "../helpers";

// Seatbelt is macOS only: elsewhere a Seatbelt default reads as Off and the
// picker's cages aren't offered, so tests that need the fields skip.
const seatbeltIt = process.platform === "darwin" ? it : it.skip;

// P1: adding/removing a project. Cases: a git repo can be added as a project
// (shows in the store); removing it drops it. Uses a throwaway temp repo and
// cleans it up.
describe("project add/remove", () => {
  let dir = "";
  let projectId: string | null = null;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-proj-"));
    execSync(
      `git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(async () => {
    if (projectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, projectId);
    }
    rmTree(dir, { bestEffort: true });
  });

  it("adds a git repo as a project", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const proj = await browser.execute(
      async (d) => await window.__termic!.ipc.projectAdd(d),
      dir,
    );
    projectId = (proj as any).id;
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            window.__termic!.useApp.getState().projects.some((p: any) => p.id === id),
          projectId,
        ),
      { timeout: 8_000, timeoutMsg: "added project never appeared" },
    );
  });

  // The dialog's own path field: Enter adds, same as clicking Add. Typed
  // paths are the manual half of this dialog (the discovered list covers the
  // rest), and stopping to reach for the mouse to commit one is the kind of
  // friction nobody reports twice.
  it("adds the typed repository root when Enter is pressed", async () => {
    // realpath: the app stores the canonical root, and macOS tmpdir is a
    // symlink (/var -> /private/var), so the raw mkdtemp path never matches.
    const dir2 = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "e2e-proj-enter-")));
    execSync(
      `git -C "${dir2}" init -q && git -C "${dir2}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
    let addedId: string | null = null;
    try {
      await browser.execute(() => window.__termic!.useUI.getState().openNewProject());
      await waitVisible('[data-testid="new-project-path"]');
      // Set the value through React's own input event, then send a REAL
      // Enter to the focused field: the handler under test is onKeyDown.
      await browser.execute((value) => {
        const input = document.querySelector(
          '[data-testid="new-project-path"]',
        ) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value",
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, dir2);
      await keysIn('[data-testid="new-project-path"]', "Enter");

      await browser.waitUntil(
        async () => {
          const p = (await browser.execute(
            (d) => window.__termic!.useApp.getState()
              .projects.find((x: any) => x.root_path === d) ?? null,
            dir2,
          )) as any;
          if (!p) return false;
          addedId = p.id;
          return true;
        },
        { timeout: 10_000, timeoutMsg: "Enter in the repository root field added nothing" },
      );
      // A successful add closes the dialog, exactly as the button does.
      await waitGone('[data-testid="new-project-path"]');
    } finally {
      if (addedId) {
        await browser.execute(async (id) => {
          await window.__termic!.ipc.projectRemove(id);
          await window.__termic!.useApp.getState().loadAll();
        }, addedId);
      } else {
        await browser.execute(() => window.__termic!.useUI.getState().closeNewProject());
      }
      rmTree(dir2, { bestEffort: true });
    }
  });

  // The dashed "New task" placeholder stands in for the task rows an empty
  // project does not have yet, so it must be the same height as one. It used
  // to be ~11px taller, which broke the sidebar rhythm.
  it("sizes the empty-project placeholder like a task row", async () => {
    const id = projectId!;
    await browser.execute((i) => {
      window.__termic!.useApp.getState().setProjectCollapsed(i, false);
    }, id);
    const trigger = `[data-testid="project-empty-new-task-${id}"]`;
    await waitVisible(trigger);
    const placeholderH = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).offsetHeight,
      trigger,
    );

    const taskId = await browser.execute(async (i) => {
      const t = window.__termic!;
      const task = await t.ipc.taskOpenRepo(i, "fakeagent", "placeholder-size");
      await t.useApp.getState().loadAll();
      return task.id as string;
    }, id);
    const row = `[data-sidebar-task-id="${taskId}"]`;
    await waitVisible(row);
    const rowH = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).offsetHeight,
      row,
    );

    expect(placeholderH).toEqual(rowH);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskArchive(i);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
  });

  it("reorders projects", async () => {
    // Put the newly-added project first, then restore original order.
    const ids = await browser.execute(
      () => window.__termic!.useApp.getState().projects.map((p: any) => p.id),
      );
    const reordered = [
      projectId!,
      ...(ids as string[]).filter((i) => i !== projectId),
    ];
    await browser.execute(async (order) => {
      await window.__termic!.ipc.projectReorder(order);
      await window.__termic!.useApp.getState().loadAll();
    }, reordered);
    await browser.waitUntil(
      () =>
        browser.execute(
          (first) => window.__termic!.useApp.getState().projects[0]?.id === first,
          projectId,
        ),
      { timeout: 8_000, timeoutMsg: "project order never changed" },
    );
  });

  it("assigns the project to a group", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectSetGroup([i], "e2e-group");
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .projects.find((p: any) => p.id === i)?.group === "e2e-group",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "project group never applied" },
    );
  });

  it("renames the project", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectRename(i, "e2e-renamed-proj");
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .projects.find((p: any) => p.id === i)?.name === "e2e-renamed-proj",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "project name never updated" },
    );
  });

  it("removes the project", async () => {
    const id = projectId!;
    await browser.execute(async (i) => {
      await window.__termic!.ipc.projectRemove(i);
      await window.__termic!.useApp.getState().loadAll();
    }, id);
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            !window.__termic!.useApp.getState().projects.some((p: any) => p.id === i),
          id,
        ),
      { timeout: 8_000, timeoutMsg: "removed project still present" },
    );
    projectId = null;
    await snap("project.png");
  });
});

// P2: repo discovery (Add Project → Discover). Scans a folder and returns the
// git repos in it.
describe("discover repos", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-discover-"));
    const sub = path.join(dir, "sub-repo");
    mkdirSync(sub, { recursive: true });
    execSync(`git -C "${sub}" init -q`);
    execSync(
      `git -C "${sub}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));

  it("finds a git repo inside a folder", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const repos = await browser.execute(
      async (d) => await window.__termic!.ipc.discoverRepos(d),
      dir,
    );
    expect(
      (repos as any[]).some((r) => JSON.stringify(r).includes("sub-repo")),
    ).toBe(true);
    await snap("discover.png");
  });
});

// P2: importing an existing worktree (issue #5). Guards the discovery half:
// listing worktrees that exist on disk but aren't open as tasks. The fixture
// repo has a pre-seeded `sbcheck` worktree. (We only assert discovery — doing
// the import + archive would rm the shared worktree.)
/** Open a Radix trigger. It opens on POINTERDOWN, not click, so a synthetic
 *  `.click()` leaves the menu shut and every assertion after it looking for
 *  rows that were never rendered. Same sequence the history scope picker in
 *  `git.e2e.ts` drives. */
const openByPointer = async (selector: string) => {
  await waitVisible(selector);
  await browser.execute((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.click();
  }, selector);
};

describe("import worktree", () => {
  it("lists importable worktrees for the project", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const list = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      return await window.__termic!.ipc.taskImportableWorktrees(proj.id);
    });
    expect(Array.isArray(list)).toBe(true);
    expect(
      (list as any[]).some((w) => JSON.stringify(w).includes("sbcheck")),
    ).toBe(true);
    await snap("import-worktree.png");
  });

  // The launcher's SHAPE, which is the half the IPC case above cannot see.
  // Importable worktrees used to be a flat section: a label plus a row each,
  // at the top level, pushing the agents down the menu on exactly the projects
  // that have the most worktrees. It is a submenu now, sitting beside Resume.
  it("offers importable worktrees behind one row, next to Resume", async () => {
    await waitForAppShell();
    const projectId = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id);

    await openByPointer(`[data-testid="project-new-task-${projectId}"]`);
    await waitVisible('[data-testid="import-worktree-sub"]');

    // ONE row at the top level, whatever the project holds, and the worktrees
    // themselves are not among the menu's own items until it is opened.
    const before = await browser.execute(() =>
      document.body.innerText.includes("sbcheck"));
    expect(before).toBe(false);

    // Radix opens a submenu on hover; a pointer sequence is what a spec drives.
    await openByPointer('[data-testid="import-worktree-sub"]');
    await waitForText("sbcheck");
    await snap("import-worktree-submenu.png");
    await browser.keys(["Escape"]);
    await browser.keys(["Escape"]);
    await waitForTextGone("Import worktree");
  });

  // The other half of the ask: a project with nothing to import shows no row
  // at all, rather than an empty submenu that opens onto nothing.
  //
  // Its OWN repo, not another case's leftovers: a project that happens to have
  // no worktrees today is a test that passes for the wrong reason the moment
  // something gives it one, and one that bails when the project is missing is
  // a test that passes having asserted nothing.
  it("hides the import row entirely when there is nothing to import", async () => {
    await waitForAppShell();
    const bare = mkdtempSync(path.join(os.tmpdir(), "e2e-noimport-"));
    execSync(
      `git -C "${bare}" init -q && git -C "${bare}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
    let projectId: string | null = null;
    try {
      projectId = await browser.execute(async (d) => {
        const p = await window.__termic!.ipc.projectAdd(d);
        await window.__termic!.useApp.getState().loadAll();
        return p.id as string;
      }, bare);

      await openByPointer(`[data-testid="project-new-task-${projectId}"]`);
      // The menu IS open, so the missing row is an absence and not a menu that
      // failed to appear.
      await waitForText("Advanced…");
      await waitGone('[data-testid="import-worktree-sub"]');
      await browser.keys(["Escape"]);
      await waitForTextGone("Advanced…");
    } finally {
      if (projectId) {
        await browser.execute(async (id) => {
          await window.__termic!.ipc.projectRemove(id);
          await window.__termic!.useApp.getState().loadAll();
        }, projectId);
      }
      // Best effort: on the Windows runner this repo is sometimes still held
      // by a process outside termic's tree (none of its children is in it;
      // Defender or the indexer on a fresh .git is the likely owner), and
      // the case is about the import row, not the cleanup.
      rmTree(bare, { bestEffort: true });
    }
  });
});

// P2: per-repo config (.termic.yaml). Save a config field and read it back.
// Git-cleans the written .termic.yaml on teardown.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("repo config", () => {
  after(() => {
    try {
      execSync(`git -C "${fixture}" clean -fd`);
      execSync(`git -C "${fixture}" checkout -- .termic.yaml`, { stdio: "ignore" });
    } catch {
      /* nothing to restore */
    }
  });

  it("saves a repo config and reads it back", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const loaded = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      // Load returns null when there's no .termic.yaml yet; scaffold a default.
      let cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      if (!cfg) {
        await window.__termic!.ipc.repoConfigScaffold(proj.id);
        cfg = await window.__termic!.ipc.repoConfigLoad(proj.id);
      }
      cfg.scripts.setup = "echo e2e-setup";
      await window.__termic!.ipc.repoConfigSave(proj.id, cfg);
      return await window.__termic!.ipc.repoConfigLoad(proj.id);
    });
    expect((loaded as any).scripts.setup).toBe("echo e2e-setup");
    await snap("repo-config.png");
  });
});

// P1: which branch a new worktree task is cut from (`Project.base_branch` + the
// "Branch from" picker in the project `+` menu). Before this, the quick path
// always used a base detected as origin/main at add time, with nothing on
// screen saying so, which is wrong for anyone whose features come off a
// long-lived `dev`. The model is deliberately ONE concept: pick a branch, it's
// remembered as the project's base.
//
// Uses its OWN temp repo, not the shared fixture: these cases move HEAD around,
// and the fixture's checked-out branch is load-bearing for other spec files.
//
// Every branch points at a DIFFERENT commit on purpose. If any two shared a
// tip, most of these cases would pass against a wrong implementation:
//   main = origin/main = <mainSha>   what add-time detection picks
//   dev  = <devSha>                  ahead of main; HEAD sits here throughout
//   feat = <featSha>                 off main; a third pin target
describe("branch new tasks from", () => {
  let dir = "";
  let projectId = "";
  let mainSha = "";
  let devSha = "";
  let featSha = "";
  const createdTaskIds: string[] = [];

  /** Tip of `ref` in the temp repo. The worktree branch a task creates lives
   *  here too, so this is how we prove where it was cut from. */
  const rev = (ref: string) =>
    execSync(`git -C "${dir}" rev-parse ${ref}`).toString().trim();

  /** Create a worktree task and return the sha its branch points at. */
  const createTaskAt = async (name: string, base: string | null) => {
    const task = await browser.execute(
      async (pid, n, b) => {
        const t = await window.__termic!.ipc.taskCreate({
          project_id: pid,
          name: n,
          cli: "fakeagent",
          base_branch: b,
          branch: n,
        });
        await window.__termic!.useApp.getState().loadAll();
        return t;
      },
      projectId,
      name,
      base,
    );
    createdTaskIds.push((task as any).id);
    return rev(name);
  };

  /** Pin a base on the project, exactly as the picker does. */
  const pinBase = async (branch: string) => {
    await browser.execute(
      async (id, b) => {
        const t = window.__termic!;
        const p = t.useApp.getState().projects.find((x: any) => x.id === id);
        await t.ipc.projectUpdate({ ...p, base_branch: b });
        await t.useApp.getState().loadAll();
      },
      projectId,
      branch,
    );
  };

  /** The project's stored base, read back from the store. */
  const storedBase = async () =>
    (await browser.execute(
      (id) =>
        window.__termic!.useApp.getState().projects.find((p: any) => p.id === id)
          ?.base_branch,
      projectId,
    )) as string;

  const checkout = (branch: string) => execSync(`git -C "${dir}" checkout -q ${branch}`);

  /** The open new-task menu's visible text. Takes the first menu with a real
   *  box, not the first in the DOM: Radix leaves a closing menu mounted until
   *  its animation ends, and animations are frozen while the window is
   *  occluded (which the harness always is), so a zero-sized husk can sit in
   *  front of the menu this actually means. */
  const menuText = async () =>
    (await browser.execute(() => {
      const m = [...document.querySelectorAll('[role="menu"]')].find(
        (e) => e.getBoundingClientRect().width > 0,
      ) as HTMLElement | null;
      return m?.innerText ?? "";
    })) as string;

  /** Wait for the menu to finish re-rendering into `mode` before clicking
   *  anything in it.
   *
   *  The mode is remembered app-wide, so clicking "Worktree" / "Main checkout"
   *  usually CHANGES it, and the menu then re-renders to add or drop its
   *  "Branch from" row. An item clicked into that re-render lands on a node
   *  Radix is replacing and is simply lost: no name prompt, no task, and only
   *  on a machine slow enough to put the click inside the window — i.e. CI.
   *  5eff3f3 fixed exactly this for the main-checkout case; the worktree ones
   *  had the same hole. */
  const settleMenuMode = async (mode: "worktree" | "main") => {
    const wantsBranchFrom = mode === "worktree";
    const label = mode === "worktree" ? "Worktree" : "Main checkout";
    await browser.waitUntil(
      async () => {
        const text = await menuText();
        // The menu must EXIST, not merely lack the row. Radix remounts the
        // content while the mode flips, so there is a beat where the query
        // finds nothing — and "" trivially satisfies "no Branch from row",
        // which let the main-checkout case settle on a menu that was not
        // there yet and click into the remount.
        if (text.length === 0) return false;
        if (text.includes("Branch from") === wantsBranchFrom) return true;
        // Still on the other mode: the toggle click can be lost to the same
        // remount as the items are, and then this would just wait out its
        // timeout on a mode nothing is going to change. Click it again. The
        // buttons are idempotent (they set a mode, they do not flip one), so a
        // repeat is free.
        await browser.execute((t) => {
          const el = [...document.querySelectorAll('[role="menu"] button')].find(
            (e) => e.textContent?.trim() === t && e.getBoundingClientRect().width > 0,
          );
          if (el) (el as HTMLElement).click();
        }, label);
        return false;
      },
      { timeout: 8_000, interval: 250, timeoutMsg: `the menu never settled into ${mode} mode` },
    );
  };

  /** Open the project's New task menu. Radix opens on pointerdown, so a bare
   *  .click() is not enough. */
  const openNewTaskMenu = async (pid: string) => {
    const trigger = `[data-testid="project-new-task-${pid}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
  };

  /** Drive the menu into `mode`, pick `item`, and retry the WHOLE gesture if
   *  nothing comes of it.
   *
   *  settleMenuMode closes most of the remount window, and CI still lands
   *  inside it: the run for 41b3c5e timed out here with no menu, no menu item
   *  and no prompt anywhere on screen. That shape says the click did select
   *  (Radix closes the menu when it does) while the handler that opens the
   *  prompt went with the node being replaced. Waiting longer cannot help,
   *  because there is nothing left on screen to wait for, and no state that
   *  says so before the fact. Re-open and do it again instead. The gesture is
   *  idempotent up to the point it works: a lost click creates nothing. */
  const pickFromNewTaskMenu = async (
    pid: string,
    mode: "worktree" | "main",
    item: string,
    doneSelector: string,
    attempts = 3,
  ) => {
    for (let attempt = 1; ; attempt++) {
      await openNewTaskMenu(pid);
      await settleMenuMode(mode);
      try {
        await clickMenuItemUntil(item, doneSelector, 6_000);
        return;
      } catch (e) {
        if (attempt === attempts) throw e;
        // The menu is usually already gone; this is for the case where the
        // click never landed at all and it is still up.
        await browser.keys("Escape");
      }
    }
  };

  /** Alphabetical on purpose: "bitbucket" must sort before "origin". */
  const remotes = ["bitbucket", "origin"];
  const remotePath = (r: string) =>
    path.join(dir, "..", `${path.basename(dir)}-${r}.git`);

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-base-"));
    const g = (args: string) => execSync(`git -C "${dir}" ${args}`, { stdio: "ignore" });
    const commit = (msg: string) =>
      g(`-c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m ${msg}`);

    execSync(`git -C "${dir}" init -q -b main`);
    commit("base");
    // TWO remotes, and "bitbucket" sorts BEFORE "origin". `git remote` lists
    // alphabetically, so taking its first line pinned a stale remote as the
    // project base at add time. Real origins also matter on their own: without
    // one, resolve_base_ref falls back to local main and the policy-off case
    // would pass for the wrong reason.
    for (const r of remotes) {
      const bare = remotePath(r);
      execSync(`git init --bare -q -b main "${bare}"`);
      g(`remote add ${r} "${bare}"`);
      g(`push -q ${r} main`);
      // `push` does NOT write refs/remotes/<r>/HEAD; only clone or an explicit
      // set-head does. Needed so the alias-filtering assertion isn't vacuous.
      g(`remote set-head ${r} -a`);
    }
    mainSha = rev("main");

    // Move HEAD off the default onto a branch that is strictly AHEAD, so
    // "current branch" and "project default" can never be confused.
    g(`checkout -q -b dev`);
    commit("dev-work");
    devSha = rev("dev");

    // A third tip, so "re-read HEAD at create time" can be told apart from
    // "resolved once when the policy was switched on".
    g(`checkout -q -b feat main`);
    commit("feat-work");
    featSha = rev("feat");
    g(`checkout -q dev`);

    expect(new Set([mainSha, devSha, featSha]).size).toBe(3);
  });

  after(async () => {
    for (const id of createdTaskIds) {
      await browser
        .execute(async (i) => {
          await window.__termic!.ipc.taskDelete(i);
          await window.__termic!.useApp.getState().loadAll();
        }, id)
        .catch(() => {});
    }
    if (projectId) {
      await browser
        .execute(async (id) => {
          await window.__termic!.ipc.projectRemove(id);
          await window.__termic!.useApp.getState().loadAll();
        }, projectId)
        .catch(() => {});
    }
    for (const r of remotes) rmSync(remotePath(r), { recursive: true, force: true, maxRetries: 10 });
    rmTree(dir, { bestEffort: true });
  });

  it("adds the repo and reports its branch context", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const proj = await browser.execute(
      async (d) => {
        const p = await window.__termic!.ipc.projectAdd(d);
        await window.__termic!.useApp.getState().loadAll();
        return p;
      },
      dir,
    );
    projectId = (proj as any).id;
    // origin wins over the alphabetically-first "bitbucket", and the branch
    // comes from that remote's own HEAD alias.
    expect((proj as any).base_branch).toBe("origin/main");

    const ctx = await browser.execute(
      async (id) => await window.__termic!.ipc.projectBranchContext(id),
      projectId,
    );
    // The picker needs the live HEAD plus BOTH ref namespaces: the default it
    // has to render as selected ("origin/main") is remote-tracking, which
    // project_git_branches never returns.
    expect((ctx as any).head).toBe("dev");
    expect((ctx as any).local).toEqual(expect.arrayContaining(["main", "dev"]));
    expect((ctx as any).remote).toEqual(
      expect.arrayContaining(["origin/main", "bitbucket/main"]),
    );
    // The symbolic <remote>/HEAD aliases are filtered out. They shorten to a
    // BARE remote name ("origin"), not "origin/HEAD", so assert on that shape:
    // a bare entry here is an alias leaking into the picker as a fake branch.
    expect((ctx as any).remote.filter((r: string) => !r.includes("/"))).toEqual([]);
  });

  // HEAD sits on `dev` throughout these, so anything that wrongly cuts from
  // the checkout instead of the pin lands on devSha and fails.
  it("branches from the pinned base, not the checked-out branch", async () => {
    expect(await createTaskAt("e2e-base-pin", null)).toBe(mainSha);
  });

  it("treats a blank explicit base as absent, not as HEAD", async () => {
    // Regression guard: `unwrap_or_else` alone let Some("") through, and an
    // empty base resolves to "HEAD" in resolve_base_ref — a silent cut from
    // wherever the repo happened to be sitting.
    expect(await createTaskAt("e2e-base-blank", "   ")).toBe(mainSha);
  });

  it("lets an explicit per-task base outrank the pin", async () => {
    // The New Task dialog's "Branch from" field and the CLI's `base` arg.
    expect(await createTaskAt("e2e-base-explicit", "feat")).toBe(featSha);
    // ...without disturbing what the project remembers.
    expect(await storedBase()).toBe("origin/main");
  });

  it("remembers a newly picked base and uses it for the next task", async () => {
    // The whole model in one case: pick, it sticks, it's what you get.
    await pinBase("feat");
    expect(await storedBase()).toBe("feat");
    expect(await createTaskAt("e2e-base-repinned", null)).toBe(featSha);

    // Re-pinning replaces, it doesn't accumulate modes.
    await pinBase("dev");
    expect(await createTaskAt("e2e-base-repinned-2", null)).toBe(devSha);
  });

  it("keeps the pin fixed when the checkout moves", async () => {
    // The deliberate trade-off of dropping the follow-HEAD mode: the base is
    // yours, and moving the main checkout must NOT silently change it.
    await pinBase("main");
    checkout("feat");
    expect(await createTaskAt("e2e-base-stable", null)).toBe(mainSha);
    checkout("dev");
    expect(await storedBase()).toBe("main");
  });

  it("shows the base in the project menu, worktree mode only", async () => {
    await openNewTaskMenu(projectId);

    // Mode is remembered app-wide, so don't assume where we start: drive it.
    // Main checkout runs on the live branch, so there's no base to pick.
    await clickByText("Main checkout");
    await settleMenuMode("main");

    await clickByText("Worktree");
    await settleMenuMode("worktree");
    // The row names the PINNED base ("main" from the previous case), which is
    // the disclosure the quick path never had. HEAD is on `dev`, so a row
    // reading "dev" would mean the base is following the checkout again.
    expect(await menuText()).toContain("main");
    await snap("branch-from.png");
    await browser.keys("Escape");
  });

  // Terminal used to bypass the inline name prompt in main-checkout mode
  // (create-at-once, Rust auto-names it), unlike every other item in this
  // menu. It now goes through the same prompt as the agent items.
  it("prompts for a name before creating a main-checkout Terminal task", async () => {
    const nameInput = 'input[placeholder="Task name"]';
    // Menu closes, an inline name input takes its place instead of a task
    // appearing immediately.
    await pickFromNewTaskMenu(projectId, "main", "Terminal", nameInput);
    await waitVisible(nameInput);
    const prefilled = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLInputElement).value,
      nameInput,
    );
    expect(prefilled).toMatch(/^terminal-\d+$/);

    await keysIn(nameInput, "Enter");
    await browser.waitUntil(
      async () =>
        browser.execute(
          (pid, n) =>
            window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.project_id === pid && t.name === n),
          projectId,
          prefilled,
        ),
      { timeout: 8_000, timeoutMsg: "named main-checkout terminal task never appeared" },
    );
    const created = await browser.execute(
      (pid, n) =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.project_id === pid && t.name === n),
      projectId,
      prefilled,
    );
    createdTaskIds.push((created as any).id);
  });

  // The quick path has no dialog to show the YOLO default in, so it applies
  // it the way it applies the project's cage, says so in the menu, and the
  // created task carries it from its first spawn.
  it("applies the YOLO default to a quick-created agent task", async () => {
    const nameInput = 'input[placeholder="Task name"]';
    const NOTE = '[data-testid="quick-create-yolo-note"]';
    const prev = await browser.execute(() => !!window.__termic!.usePrefs.getState().defaultYolo);
    await browser.execute(() => window.__termic!.usePrefs.getState().setDefaultYolo(true));
    try {
      await openNewTaskMenu(projectId);
      await settleMenuMode("main");
      expect(await browser.execute((sel) => !!document.querySelector(sel), NOTE)).toBe(true);
      await browser.keys("Escape");

      await pickFromNewTaskMenu(projectId, "main", "FakeAgent", nameInput);
      await waitVisible(nameInput);
      const name = `e2e-quick-yolo-${Date.now()}`;
      await browser.execute((sel, n) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
          .set!.call(input, n);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, nameInput, name);
      await keysIn(nameInput, "Enter");
      await browser.waitUntil(
        () => browser.execute((pid, n) => window.__termic!.useApp.getState().tasks
          .some((t: any) => t.project_id === pid && t.name === n), projectId, name),
        { timeout: 10_000, timeoutMsg: "quick-created agent task never appeared" },
      );
      const created = await browser.execute((pid, n) => window.__termic!.useApp.getState().tasks
        .find((t: any) => t.project_id === pid && t.name === n), projectId, name) as any;
      createdTaskIds.push(created.id);
      expect(created.yolo).toBe(true);
    } finally {
      await browser.execute((v) => window.__termic!.usePrefs.getState().setDefaultYolo(v), prev);
    }
  });

  // GH #242: the sidebar's quick-create row is a SECOND worktree-creation
  // implementation, separate from NewTaskDialog, and used to block behind
  // its own overlay (QuickCreateProgressDialog) the same way the modal did.
  // Prove the inline row commits without blocking too: the menu/name-input
  // closes immediately, well before the worktree is actually ready, and the
  // task still lands on its own branch.
  it("creates a worktree task from the inline quick-create row without blocking", async () => {
    const nameInput = 'input[placeholder="Task name"]';
    await pickFromNewTaskMenu(projectId, "worktree", "Terminal", nameInput);
    await waitVisible(nameInput);
    await browser.execute((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-quick-wt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, nameInput);
    await keysIn(nameInput, "Enter");

    // The inline row (name + branch inputs) is gone right away — it does not
    // wait for `git worktree add` to finish, same fix as the dialog case in
    // task.e2e.ts.
    await waitGone(nameInput, 2_000);

    // ...and the worktree still lands once it's actually ready, on its own
    // branch (not the main checkout).
    await browser.waitUntil(
      () =>
        browser.execute(
          (pid) =>
            window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.project_id === pid && t.name === "e2e-quick-wt"),
          projectId,
        ),
      { timeout: 15_000, timeoutMsg: "quick-create worktree task never landed after the row closed early" },
    );
    const created = await browser.execute(
      (pid) =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.project_id === pid && t.name === "e2e-quick-wt"),
      projectId,
    );
    expect((created as any).is_main_checkout).not.toBe(true);
    createdTaskIds.push((created as any).id);
  });

  it("offers one flat branch list, pin checked and HEAD marked", async () => {
    // The pin lives IN the list rather than in a separate "Project default"
    // row, so there's one place to look. Mode is remembered app-wide (the
    // previous case left it on Main checkout), so drive it rather than
    // assume where we start.
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
    await clickByText("Worktree");
    await settleMenuMode("worktree");

    // Radix submenus open on hover; the trigger carries aria-haspopup.
    await browser.execute(() => {
      const t = [...document.querySelectorAll('[aria-haspopup="menu"]')].find((e) =>
        e.textContent?.includes("Branch from"),
      ) as HTMLElement | undefined;
      if (!t) throw new Error('no "Branch from" submenu trigger');
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      t.dispatchEvent(new PointerEvent("pointerover", opts));
      t.dispatchEvent(new PointerEvent("pointermove", opts));
      t.click();
    });

    // Every ref is offered in ONE list, including the pinned one.
    const items = async () =>
      (await browser.execute(() =>
        [...document.querySelectorAll('[role="menuitem"]')]
          .map((e) => (e as HTMLElement).innerText.trim())
          .filter(Boolean),
      )) as string[];
    await browser.waitUntil(
      async () => (await items()).some((t) => t.startsWith("origin/main")),
      { timeout: 8_000, timeoutMsg: "branch list never rendered" },
    );

    const list = await items();
    for (const b of ["main", "dev", "origin/main", "bitbucket/main"]) {
      expect(list.some((t) => t.split("\n")[0] === b)).toBe(true);
    }
    // The current branch is a HINT on its row, not a separate mode/entry.
    expect(list.some((t) => t.startsWith("dev") && t.includes("current"))).toBe(true);
    expect(list.some((t) => t === "Current branch")).toBe(false);
    expect(list.some((t) => t.startsWith("Project default"))).toBe(false);
    await snap("branch-list.png");
    await browser.keys("Escape");
  });
});

// P1: sidebar drags (pointer-based, see helpers.pointerDrag). Cases: reorder
// two projects; drop a project into a group folder; reorder a whole folder as
// a block. All three run through the same Sidebar pointer handler but land in
// different IPC calls (project_reorder / project_set_group), so each asserts on
// the store after the drop.
describe("sidebar project drag", () => {
  const dirs: string[] = [];
  const ids: string[] = [];
  // Uppercase on purpose: the sidebar renders (and writes back) group labels
  // uppercased, so this is the key the DOM and the store both use.
  const GROUP = "E2E-GROUP";

  before(() => {
    for (let i = 0; i < 2; i++) {
      const d = mkdtempSync(path.join(os.tmpdir(), "e2e-drag-"));
      execSync(
        `git -C "${d}" init -q && git -C "${d}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
      );
      dirs.push(d);
    }
  });
  after(async () => {
    for (const id of ids) {
      await browser.execute(async (i) => {
        await window.__termic!.ipc.projectRemove(i);
      }, id);
    }
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    for (const d of dirs) rmTree(d, { bestEffort: true });
  });

  // Project ids in sidebar order.
  const order = () =>
    browser.execute(() =>
      window.__termic!.useApp.getState().projects.map((p: any) => p.id as string),
    );
  const groupOf = (id: string) =>
    browser.execute(
      (i) =>
        (window.__termic!.useApp.getState().projects.find((p: any) => p.id === i)
          ?.group ?? null) as string | null,
      id,
    );
  const row = (id: string) => `[data-project-id="${id}"]`;

  it("reorders two projects by dragging one above the other", async () => {
    await waitForAppShell();
    await requireTermicApi();
    // Earlier cases in this file open dialogs; a lingering backdrop would eat
    // the drag's hit testing.
    await dismissOverlays();
    for (const d of dirs) {
      const proj = await browser.execute(
        async (dir) => await window.__termic!.ipc.projectAdd(dir),
        d,
      );
      ids.push((proj as any).id);
    }
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    const [a, b] = ids;
    await browser.waitUntil(
      async () => {
        const o = (await order()) as string[];
        return o.includes(a) && o.includes(b);
      },
      { timeout: 8_000, timeoutMsg: "the new projects never reached the sidebar" },
    );
    await waitVisible(row(b));
    expect(((await order()) as string[]).indexOf(a)).toBeLessThan(
      ((await order()) as string[]).indexOf(b),
    );

    // Carry the LAST one above the first: a drop above a row's midpoint puts
    // the dragged project before it.
    await pointerDrag(row(b), row(a), { land: "top" });
    await browser.waitUntil(
      async () => {
        const o = (await order()) as string[];
        return o.indexOf(b) < o.indexOf(a);
      },
      { timeout: 8_000, timeoutMsg: "dragging a project did not reorder the sidebar" },
    );
  });

  it("drops a project into a group folder", async () => {
    const [a, b] = ids;
    // Make a folder out of one project, then drag the other into it. Dropping
    // on the folder header's BOTTOM half is what adopts (the top half means
    // "put it above the folder").
    await browser.execute(
      async (id, g) => {
        await window.__termic!.ipc.projectSetGroup([id], g);
        await window.__termic!.useApp.getState().loadAll();
      },
      a,
      GROUP,
    );
    await waitVisible(`[data-group-name="${GROUP}"]`);
    expect(await groupOf(b)).toBeNull();

    await pointerDrag(row(b), `[data-group-name="${GROUP}"]`, { land: "bottom" });
    await browser.waitUntil(async () => (await groupOf(b)) === GROUP, {
      timeout: 8_000,
      timeoutMsg: "dropping a project on the folder did not add it to the group",
    });
    await snap("sidebar-project-drag.png");
  });

  it("reorders a whole folder as one block", async () => {
    // Both temp projects now live in the folder; the fixture project is loose.
    const fixture = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo").id as string,
    );
    const membersBefore = ((await order()) as string[]).filter((i) => ids.includes(i));

    // Drag the folder header above the loose project: the section moves as a
    // contiguous block, keeping its internal order.
    await pointerDrag(`[data-group-name="${GROUP}"]`, row(fixture), { land: "top" });
    await browser.waitUntil(
      async () => {
        const o = (await order()) as string[];
        return o.indexOf(membersBefore[membersBefore.length - 1]) < o.indexOf(fixture);
      },
      { timeout: 8_000, timeoutMsg: "dragging the folder did not move its members" },
    );
    const membersAfter = ((await order()) as string[]).filter((i) => ids.includes(i));
    expect(membersAfter).toEqual(membersBefore); // block move, not a shuffle
  });
});

// P1: the project `+` menu's Resume section. It's a SUBMENU (like "Branch
// from"), so the launcher keeps one row no matter how much history a project
// has. Cases: the top level shows a single Resume row, not the sessions; the
// submenu lists the recent archived ones and restores the picked one.
describe("resume submenu", () => {
  const archived: string[] = [];
  let projectId = "";

  after(async () => {
    // Archive whatever these cases restored, so the board is left as found.
    await browser.execute(async (ids) => {
      for (const id of ids) {
        try { await window.__termic!.ipc.taskArchive(id); } catch { /* already gone */ }
      }
      await window.__termic!.useApp.getState().loadAll();
    }, archived);
  });

  const menuText = async () =>
    (await browser.execute(() => {
      const m = document.querySelector('[role="menu"]') as HTMLElement | null;
      return m?.innerText ?? "";
    })) as string;

  const openMenu = async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    // Radix opens on pointerdown, so a bare .click() isn't enough.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
  };

  it("keeps the sessions behind one Resume row", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    projectId = (await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo").id as string,
    )) as string;

    // Two archived sessions to resume. Repo-root tasks: archiving one never
    // touches a worktree.
    for (const name of ["e2e-resume-a", "e2e-resume-b"]) {
      const id = (await browser.execute(async (pid, n) => {
        const t = window.__termic!;
        const task = await t.ipc.taskOpenRepo(pid, "fakeagent", n);
        await t.ipc.taskArchive(task.id);
        await t.useApp.getState().loadAll();
        return task.id as string;
      }, projectId, name)) as string;
      archived.push(id);
    }

    await openMenu();
    const text = await menuText();
    expect(text).toContain("Resume");
    // The point of the submenu: the sessions themselves are NOT on the top
    // level, so the agents stay near the cursor however long the history is.
    expect(text).not.toContain("e2e-resume-b");
  });

  it("lists the recent sessions and restores the picked one", async () => {
    // Submenus open on hover; the trigger carries aria-haspopup.
    await browser.execute(() => {
      const t = [...document.querySelectorAll('[aria-haspopup="menu"]')].find((e) =>
        e.textContent?.includes("Resume"),
      ) as HTMLElement | undefined;
      if (!t) throw new Error("no Resume submenu trigger");
      const opts = { bubbles: true, pointerType: "mouse" } as any;
      t.dispatchEvent(new PointerEvent("pointerover", opts));
      t.dispatchEvent(new PointerEvent("pointermove", opts));
      t.click();
    });

    const items = async () =>
      (await browser.execute(() =>
        [...document.querySelectorAll('[role="menuitem"]')]
          .map((e) => (e as HTMLElement).innerText.trim())
          .filter(Boolean),
      )) as string[];
    await browser.waitUntil(
      async () => (await items()).some((t) => t.includes("e2e-resume-b")),
      { timeout: 8_000, timeoutMsg: "the Resume submenu never listed the sessions" },
    );
    // Most-recently archived first, and both are offered.
    const listed = await items();
    expect(listed.some((t) => t.includes("e2e-resume-a"))).toBe(true);

    // Picking one restores it and makes it the active task.
    await browser.execute(() => {
      const row = [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
        (e as HTMLElement).innerText.includes("e2e-resume-b"),
      ) as HTMLElement | undefined;
      if (!row) throw new Error("no e2e-resume-b row");
      row.click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const s = window.__termic!.useApp.getState();
          const t = s.tasks.find((w: any) => w.id === s.activeTaskId);
          return !!t && t.name === "e2e-resume-b" && !t.archived;
        }),
      { timeout: 10_000, timeoutMsg: "picking a Resume entry did not restore the task" },
    );
    await snap("resume-submenu.png");
  });
});

// Issue #152: the dashboard's "No projects yet" card is the biggest thing a
// new user sees and reads as actionable, so it must actually be a button that
// opens the same Add project dialog as the sidebar "+" and the action card.
// The seeded profile always has fixture-repo, so the empty state is rendered
// by emptying the store's project list (disk untouched) and restored with
// loadAll() afterwards.
describe("dashboard empty state", () => {
  const CARD = '[data-testid="empty-projects-card"]';

  const showEmptyDashboard = async () => {
    await browser.execute(() => {
      window.__termic!.useApp.getState().setView("dashboard");
      window.__termic!.useApp.setState({ projects: [] });
    });
    await waitVisible(CARD);
  };
  const closeDialog = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewProject());
    await dismissOverlays();
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
  });
  after(async () => {
    await closeDialog();
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
  });

  it("opens the Add project dialog when the card is clicked", async () => {
    await showEmptyDashboard();
    await clickWhenVisible(CARD);
    await waitForText("Add project");
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')].some((d) =>
            (d as HTMLElement).innerText.includes("Add project"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "clicking the empty state did not open the Add project dialog" },
    );
    await snap("empty-projects-card.png");
    await closeDialog();
  });

  it("is a real button, focusable and activated by the keyboard", async () => {
    await showEmptyDashboard();
    const tag = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).tagName,
      CARD,
    );
    expect(tag).toEqual("BUTTON");

    // Reachable by Tab and focusable: a <div onClick> fails both. We assert
    // the tab order rather than pressing Enter, because native button
    // activation from a WebDriver key event doesn't land on the offscreen
    // window (the browser supplies that behaviour, we only supply the button).
    const { tabIndex, disabled, focusable } = await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLButtonElement;
      el.focus();
      return {
        tabIndex: el.tabIndex,
        disabled: el.disabled,
        focusable: document.activeElement === el,
      };
    }, CARD);
    expect(tabIndex).toBeGreaterThanOrEqual(0);
    expect(disabled).toBe(false);
    expect(focusable).toBe(true);
  });

  it("goes back to the project list once a project exists", async () => {
    await showEmptyDashboard();
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    await waitGone(CARD);
  });
});

// The dashboard is the home screen, and until now it showed a flat project
// list: no group folders, no live agent state, no PR state, no way back into
// what you were just doing. Each case here is one of those, driven through the
// real surfaces rather than the store, because the whole point of the feature
// is that the page RENDERS what the sidebar knows.
describe("dashboard", () => {
  const dirs: string[] = [];
  const ids: string[] = [];
  const GROUP = "E2E-DASH";
  /** Ungrouped, task-free, and first in store order: the thing the folder has
   *  to sort above once it holds an active task. */
  let looseId = "";
  /** The two projects inside the folder, in store order. */
  const grouped: string[] = [];
  let taskId = "";

  const header = `[data-dashboard-group-header="${GROUP}"]`;
  const section = `[data-dashboard-group="${GROUP}"]`;
  const card = (id: string) => `[data-dashboard-project-id="${id}"]`;

  const showDashboard = async () => {
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));
    await waitVisible('[data-testid="empty-projects-card"], [data-dashboard-project-id]');
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    // THREE projects: one loose and idle, then two in a folder. The loose one
    // is added FIRST so it precedes the folder in store order, which is what
    // makes the active-first case below assert something — and it makes that
    // case independent of whatever `fixture-repo` is carrying by the time this
    // block runs, which earlier blocks in this file are free to change.
    for (let i = 0; i < 3; i++) {
      const d = mkdtempSync(path.join(os.tmpdir(), "e2e-dash-"));
      execSync(
        `git -C "${d}" init -q && git -C "${d}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
      );
      dirs.push(d);
    }
    for (const d of dirs) {
      const proj = await browser.execute(
        async (dir) => await window.__termic!.ipc.projectAdd(dir),
        d,
      );
      ids.push((proj as any).id);
    }
    looseId = ids[0];
    grouped.push(ids[1], ids[2]);
    await browser.execute(
      async (list, g) => {
        await window.__termic!.ipc.projectSetGroup(list, g);
        await window.__termic!.useApp.getState().loadAll();
      },
      grouped,
      GROUP,
    );
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    for (const id of ids) {
      await browser.execute(async (i) => { await window.__termic!.ipc.projectRemove(i); }, id);
    }
    // The dashboard shares its collapse map with the sidebar, so a folder left
    // collapsed would follow this spec into the next one.
    await browser.execute((g) => {
      window.__termic!.useApp.getState().setGroupCollapsed(g, false);
      window.__termic!.useApp.setState({ recentTasks: [] });
      window.__termic!.useApp.getState().setView("dashboard");
    }, GROUP);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    for (const d of dirs) rmTree(d, { bestEffort: true });
  });

  it("renders a group folder with its members inside it", async () => {
    await showDashboard();
    await waitVisible(header);
    // Both project cards live INSIDE the folder, not merely after it: a flat
    // list that happened to sort them adjacently would pass a looser check.
    const inside = await browser.execute(
      (sec, a, b) => {
        const root = document.querySelector(sec) as HTMLElement;
        return [a, b].map((id) => !!root?.querySelector(`[data-dashboard-project-id="${id}"]`));
      },
      section, grouped[0], grouped[1],
    );
    expect(inside).toEqual([true, true]);
    // The count on the header is the folder's membership.
    const count = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).innerText.trim(),
      header,
    );
    expect(count).toContain("2");
    expect(count).toContain(GROUP);
    await snap("dashboard-groups.png");
  });

  it("shares its collapse state with the sidebar", async () => {
    await showDashboard();
    await clickWhenVisible(header);
    // Collapsing on the dashboard hides the member cards there...
    await waitGone(card(grouped[0]));
    // ...and the sidebar folder, which reads the same map, is collapsed too.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (g) => document.querySelector(`[data-group-name="${g}"]`)?.getAttribute("aria-expanded"),
          GROUP,
        )) === "false",
      { timeout: 8_000, timeoutMsg: "collapsing on the dashboard did not reach the sidebar folder" },
    );
    await snap("dashboard-group-collapsed.png");

    // And back: expanding from the SIDEBAR re-opens the dashboard folder, so
    // the sharing is not one-directional.
    await clickWhenVisible(`[data-group-name="${GROUP}"]`);
    await waitVisible(card(grouped[0]));
  });

  it("keys a MIXED-CASE group name the same way on both surfaces", async () => {
    // The sharing claim is that the dashboard and the sidebar agree on the
    // key for `collapsedGroups`. Every other fixture here uses a name that is
    // already ALL-CAPS, so nothing proved the normalization in `groupOf()`
    // actually reaches the section name: a group somebody types as
    // "Infrastructure" is stored as typed and must render, collapse and share
    // state under "INFRASTRUCTURE" everywhere.
    const TYPED = "Infrastructure";
    const KEY = "INFRASTRUCTURE";
    await browser.execute(async (list, g) => {
      await window.__termic!.ipc.projectSetGroup(list, g);
      await window.__termic!.useApp.getState().loadAll();
    }, grouped, TYPED);
    await showDashboard();

    // Rendered under the normalized key, not the typed one.
    await waitVisible(`[data-dashboard-group-header="${KEY}"]`);
    expect(await browser.execute(
      (typed) => !!document.querySelector(`[data-dashboard-group-header="${typed}"]`), TYPED,
    )).toBe(false);

    // And the collapse still crosses to the sidebar, which is the whole claim.
    await clickWhenVisible(`[data-dashboard-group-header="${KEY}"]`);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (k) => document.querySelector(`[data-group-name="${k}"]`)?.getAttribute("aria-expanded"),
          KEY,
        )) === "false",
      { timeout: 8_000, timeoutMsg: "a mixed-case group did not share its collapse state" },
    );

    // Put the fixture back for the cases below.
    await clickWhenVisible(`[data-group-name="${KEY}"]`);
    await browser.execute(async (list, g) => {
      await window.__termic!.ipc.projectSetGroup(list, g);
      await window.__termic!.useApp.getState().loadAll();
    }, grouped, GROUP);
    await waitVisible(header);
  });

  it("floats a section holding an active task above an idle one", async () => {
    // A task in the SECOND project should carry the whole folder above the
    // loose fixture-repo card, and must not reorder the folder internally.
    taskId = await browser.execute(async (projId) => {
      const t = window.__termic!;
      const ws = await t.invoke("task_open_repo",
        { projectId: projId, cli: "fakeagent", name: "dash-order" }) as any;
      await t.useApp.getState().loadAll();
      return ws.id as string;
    }, grouped[1]);
    await showDashboard();

    const domOrder = () => browser.execute(() =>
      [...document.querySelectorAll("[data-dashboard-project-id], [data-dashboard-group]")]
        .filter((el) => !el.parentElement?.closest("[data-dashboard-group]"))
        .map((el) => (el as HTMLElement).dataset.dashboardGroup
          ?? (el as HTMLElement).dataset.dashboardProjectId) as string[]);

    // The folder was added AFTER the loose project, so store order puts it
    // second; holding an active task has to carry it above.
    await browser.waitUntil(
      async () => {
        const o = (await domOrder()) as string[];
        return o.indexOf(GROUP) > -1 && o.indexOf(GROUP) < o.indexOf(looseId);
      },
      { timeout: 8_000, timeoutMsg: "the folder holding the active task did not sort above the idle project" },
    );
    // Members keep STORE order — the active one is second and stays second.
    // Sorting the flat project list instead of the sections is what would
    // promote it here, and would move the folder itself somewhere else again.
    const members = await browser.execute(
      (sec) => [...(document.querySelector(sec) as HTMLElement)
        .querySelectorAll("[data-dashboard-project-id]")]
        .map((el) => (el as HTMLElement).dataset.dashboardProjectId) as string[],
      section,
    );
    expect(members).toEqual(grouped);
  });

  it("shows the agent work badge on the task row", async () => {
    // A task created through IPC has no TABS until something mounts it: the
    // tab model is frontend-only and `task_open_repo` writes a record, not a
    // terminal. Visiting it once is what the badge needs to have anything to
    // read, and it is what a user does before an agent can be working anyway.
    await ensureActiveTask(taskId);
    await browser.waitUntil(
      () => browser.execute((id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length > 0, taskId),
      { timeout: 15_000, timeoutMsg: "the task never got a tab to carry a work state" },
    );
    await showDashboard();
    await waitVisible(`[data-dashboard-task-id="${taskId}"]`);
    // No agent has run, so the row is quiet.
    expect(await dashboardBadge(taskId)).toBeNull();

    // Seed the tab state the detector would have written. This is SETUP, not
    // the assertion: what is being tested is that the dashboard renders the
    // same badge the sidebar does from the same input.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? [])[0];
      app.setWorkState(id, tab.id, "done");
    }, taskId);
    await browser.waitUntil(async () => (await dashboardBadge(taskId)) === "done", {
      timeout: 8_000,
      timeoutMsg: "the dashboard row never showed the done badge",
    });

    // Attention outranks done, the same precedence the sidebar uses — the two
    // surfaces showing one task differently is the bug this shares code for.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? [])[0];
      app.markAttention(id, tab.id, "attention", "needs you");
    }, taskId);
    await browser.waitUntil(async () => (await dashboardBadge(taskId)) === "attention", {
      timeout: 8_000,
      timeoutMsg: "attention did not outrank done on the dashboard row",
    });
    await snap("dashboard-work-badge.png");

    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      const tab = (app.tabs[id] ?? [])[0];
      // patchTab, not setWorkState: setWorkState is the detector's state
      // machine and holds `done` deliberately (the sticky-done / premature-done
      // logic). A MANUAL clear goes through patchTab, which is what
      // TerminalPane and cliRpc both do.
      app.patchTab(id, tab.id, { workState: "idle", unread: null });
    }, taskId);
    await browser.waitUntil(async () => (await dashboardBadge(taskId)) === null, {
      timeout: 8_000,
      timeoutMsg: "the dashboard badge never cleared",
    });
  });

  it("shows the PR chip for a task that has one, and nothing for one that does not", async () => {
    await showDashboard();
    const chip = `[data-dashboard-task-id="${taskId}"] [data-testid="task-pr-badge"]`;
    // Nothing resolved yet, so no chip: the dashboard renders what the poller
    // already knows and never kicks a lookup of its own.
    expect(await browser.execute((sel) => !!document.querySelector(sel), chip)).toBe(false);

    await browser.execute((id) => {
      window.__termic!.usePr.setState({
        byTask: {
          [id]: {
            lookup: {
              status: "ok",
              pr: {
                provider: "github", number: 7, url: "https://github.com/acme/repo/pull/7",
                title: "t", state: "open", checks: "passing", review: "none",
                base: "main", head: "dash-order",
              },
            },
            loading: false,
            fetchedAt: Date.now(),
          },
        },
      });
    }, taskId);
    await waitVisible(chip);
    expect(await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).dataset.prState, chip,
    )).toEqual("open");
    await snap("dashboard-pr-chip.png");
    await browser.execute(() => window.__termic!.usePr.setState({ byTask: {} }));
  });

  it("lists a visited task under Recent, and drops it when it is archived", async () => {
    const RECENTS = '[data-testid="dashboard-recents"]';
    // A store with no history shows no Recent row at all, so an install that
    // has never opened a task sees exactly the page it always saw.
    await browser.execute(() => window.__termic!.useApp.setState({ recentTasks: [] }));
    await showDashboard();
    await waitGone(RECENTS);

    // Visiting a task is what records it; going back to the dashboard shows it.
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
    await showDashboard();
    await waitVisible(`${RECENTS} [data-dashboard-recent-task-id="${taskId}"]`);
    await snap("dashboard-recents.png");

    // Archiving moves the task to History, so the chip must not be left behind
    // offering a dead link.
    await archiveTask(taskId);
    taskId = "";
    await waitGone(RECENTS);
  });
});

// Per-member mode memory + bulk flip in the multi-repo New Task dialog.
//
// Each git member row remembers its last-used mode (localStorage
// `newTaskMemberModes`, keyed by member root_path) across dialog opens, and a
// "Set all" pair in the Members header flips every row at once. Dialog-only
// coverage: no task is ever created here, so the fixture is two tiny member
// repos plus a host dir, torn down completely.
describe("multi member modes (New Task dialog)", () => {
  let tmp = "";
  let projectId = "";

  /** Member rows as `{ name, mode, included }`, from the row's own state attributes. */
  const rowModes = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="member-mode-row"]')].map((e) => ({
        name: e.getAttribute("data-member-name"),
        mode: e.getAttribute("data-member-mode"),
        included: e.getAttribute("data-member-included"),
      })),
    ) as Promise<Array<{ name: string | null; mode: string | null; included: string | null }>>;

  const openDialog = async () => {
    await browser.execute((id) => window.__termic!.useUI.getState().openNewTask(id), projectId);
    // Seeding runs in the dialog's reset effect; wait for both rows to exist.
    await browser.waitUntil(async () => (await rowModes()).length === 2, {
      timeout: 10_000,
      timeoutMsg: "the member rows never rendered",
    });
  };

  const closeDialog = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    // Wait out the dialog's unmount: a lingering row would let the reopen's
    // row-count wait pass BEFORE the reset effect reseeds, and the memory
    // assertions would then read stale state instead of the seeded one.
    await waitGone('[data-testid="member-mode-row"]');
  };

  /** Click one row's Main checkout / Worktree toggle by member name. */
  const clickRowMode = (name: string, label: "Main checkout" | "Worktree") =>
    browser.execute(
      (n, l) => {
        const row = document.querySelector(`[data-testid="member-mode-row"][data-member-name="${n}"]`)!;
        const btn = [...row.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === l,
        ) as HTMLButtonElement;
        btn.click();
      },
      name,
      label,
    );

  /** Click one row's include checkbox by member name. */
  const clickRowInclude = (name: string) =>
    browser.execute((n) => {
      const row = document.querySelector(`[data-testid="member-mode-row"][data-member-name="${n}"]`)!;
      (row.querySelector('[data-testid="member-include"]') as HTMLInputElement).click();
    }, name);

  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "e2e-member-modes-"));
    mkdirSync(path.join(tmp, "host"));
    for (const name of ["alpha", "beta"]) {
      const p = path.join(tmp, name);
      mkdirSync(p);
      execSync(`git init -b main -q "${p}"`);
      execSync(`git -C "${p}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`);
    }
  });

  after(async () => {
    await closeDialog();
    await browser.execute(async (id) => {
      try {
        localStorage.removeItem("newTaskMemberModes");
        localStorage.removeItem("newTaskMemberSets");
      } catch { /* fine */ }
      if (id) {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }
    }, projectId);
    rmTree(tmp, { bestEffort: true });
  });

  it("seeds every git member row on Worktree when nothing is remembered", async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(
      async (host, alpha, beta) => {
        const t = window.__termic!;
        try {
          localStorage.removeItem("newTaskMemberModes");
          localStorage.removeItem("newTaskMemberSets");
          // The member rows only render in the Worktree host shape (the
          // host-level toggle is remembered app-wide), so pin it here; the
          // main-checkout describe below restores whatever it finds.
          localStorage.setItem("newTaskLastMode", "worktree");
        } catch { /* fine */ }
        // A run that died before teardown leaves the project behind (fresh
        // path, same name) — drop any stale one first.
        for (const p of t.useApp.getState().projects.filter((p: any) => p.name === "e2e-member-modes")) {
          try { await t.ipc.projectRemove(p.id); } catch { /* has live tasks */ }
        }
        const spec = (root_path: string, name: string) => ({
          root_path,
          name,
          base_branch: "main",
          setup_script: "",
          run_script: "",
          archive_script: "",
          // Per-member seatbelt lists so the sandbox unions visibly shrink
          // when the row's include box flips off.
          sandbox_rw_paths: [`/${name}-rw`],
          sandbox_allowed_hosts: [`${name}.local`],
        });
        const proj = await t.ipc.projectAddMulti(
          host,
          "e2e-member-modes",
          [spec(alpha, "alpha"), spec(beta, "beta")],
          true, // non-git wrapper host
        );
        await t.useApp.getState().loadAll();
        return proj.id as string;
      },
      path.join(tmp, "host"),
      path.join(tmp, "alpha"),
      path.join(tmp, "beta"),
    );
    await openDialog();
    expect(await rowModes()).toEqual([
      { name: "alpha", mode: "worktree", included: "true" },
      { name: "beta", mode: "worktree", included: "true" },
    ]);
  });

  it("Set all: Main checkout flips every row and surfaces the live-checkout warning", async () => {
    await clickWhenVisible('[data-testid="members-all-main"]');
    await browser.waitUntil(
      async () => (await rowModes()).every((r) => r.mode === "repo_root"),
      { timeout: 5_000, timeoutMsg: "Set all: Main checkout did not flip every member row" },
    );
    // The warning is the user-facing consequence of running on live checkouts.
    await waitForText("One or more members are linked to live checkouts.");
  });

  it("remembers each member's mode across dialog opens", async () => {
    // Split the modes so memory is per member, not one shared flag.
    await clickRowMode("alpha", "Worktree");
    await browser.waitUntil(
      async () => (await rowModes()).find((r) => r.name === "alpha")?.mode === "worktree",
      { timeout: 5_000, timeoutMsg: "the alpha row never flipped back to worktree" },
    );
    await closeDialog();
    await openDialog();
    expect(await rowModes()).toEqual([
      { name: "alpha", mode: "worktree", included: "true" },
      { name: "beta", mode: "repo_root", included: "true" },
    ]);
  });

  it("Set all: Worktree restores every row and persists too", async () => {
    await clickWhenVisible('[data-testid="members-all-worktree"]');
    await browser.waitUntil(
      async () => (await rowModes()).every((r) => r.mode === "worktree"),
      { timeout: 5_000, timeoutMsg: "Set all: Worktree did not flip every member row" },
    );
    await closeDialog();
    await openDialog();
    expect((await rowModes()).every((r) => r.mode === "worktree")).toBe(true);
  });

  it("unchecking a member drops it out of the count and dims its row", async () => {
    await clickRowInclude("beta");
    await browser.waitUntil(
      async () => (await rowModes()).find((r) => r.name === "beta")?.included === "false",
      { timeout: 5_000, timeoutMsg: "the beta row never unchecked" },
    );
    await waitForText("Members (1 of 2)");
  });

  it("None clears every checkbox, All restores them", async () => {
    await clickWhenVisible('[data-testid="members-none-include"]');
    await waitForText("Members (0 of 2)");
    await clickWhenVisible('[data-testid="members-all-include"]');
    await waitForText("Members (2 of 2)");
  });

  it("saves a member subset, reapplies it after a reset and a reopen, then deletes it", async () => {
    // Leave only beta checked, then save that as "just-beta".
    await clickRowInclude("alpha");
    await waitForText("Members (1 of 2)");
    await clickWhenVisible('[data-testid="member-set-save"]');
    await waitVisible('[data-testid="member-set-name"]');
    await browser.execute(() => {
      const input = document.querySelector('[data-testid="member-set-name"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "just-beta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitForText("just-beta");

    // Reset to all, then apply the chip: only beta survives.
    await clickWhenVisible('[data-testid="members-all-include"]');
    await browser.execute(() => {
      ([...document.querySelectorAll('[data-testid="member-set-apply"]')]
        .find((b) => b.textContent?.trim() === "just-beta") as HTMLElement).click();
    });
    await waitForText("Members (1 of 2)");
    expect((await rowModes()).find((r) => r.name === "alpha")?.included).toBe("false");

    // The set lives in localStorage, so a freshly opened dialog offers it too.
    await closeDialog();
    await openDialog();
    await waitForText("just-beta");

    await browser.execute(() => {
      (document.querySelector('[aria-label="Delete set just-beta"]') as HTMLElement).click();
    });
    await waitForTextGone("just-beta");
  });

  // The Seatbelt fields are macOS-only; the textarea itself is what's under
  // test, so Linux/Windows skip. This is the GH #343 regression net: a
  // checkbox must shrink an untouched union but never rewrite a hand edit.
  seatbeltIt(
    "include toggles re-derive the seatbelt lists, but a hand edit owns them",
    async () => {
      // Close first — the previous test left the dialog open, and seeding
      // (all members included) only runs on a fresh open.
      await closeDialog();
      await openDialog();
      await browser.execute(() => {
        const dlg = document.querySelector('[data-testid="member-include"]')!.closest('[role="dialog"]')!;
        const btn = [...dlg.querySelectorAll("button")].find(
          (b) => b.querySelector("span")?.textContent?.trim() === "ENFORCING (filesystem + network)",
        ) as HTMLButtonElement;
        btn.click();
      });
      const rw = '[data-testid="sandbox-rw-paths"]';
      const hosts = '[data-testid="sandbox-allowed-hosts"]';
      const field = (sel: string) => browser.execute(
        (s) => (document.querySelector(s) as HTMLTextAreaElement).value, sel);
      await waitVisible(rw);
      // Poll: the settings probe fills the unions a tick after the textareas mount.
      await browser.waitUntil(async () => (await field(rw)) === "/alpha-rw\n/beta-rw"
        && (await field(hosts)) === "alpha.local\nbeta.local",
        { timeout: 5_000, timeoutMsg: "the seatbelt lists never seeded the member union" });

      // Untouched union → unchecking beta drops its lines. (Worktree rows
      // resync through the row updater.)
      await clickRowInclude("beta");
      await waitForText("Members (1 of 2)");
      expect(await field(rw)).toBe("/alpha-rw");
      expect(await field(hosts)).toBe("alpha.local");

      // The main-checkout checklist is the OTHER toggle path — its boxes
      // funnel through setIncluded, not the worktree row updater.
      await clickWhenVisible('[data-testid="task-type-main"]');
      await waitForText("1 of 2 members run live");
      await clickRowInclude("beta"); // check → grows
      await waitForText("2 of 2 members run live");
      expect(await field(rw)).toBe("/alpha-rw\n/beta-rw");
      await clickRowInclude("beta"); // uncheck → shrinks
      await waitForText("1 of 2 members run live");
      expect(await field(rw)).toBe("/alpha-rw");

      // Hand-edited rw → the next toggle must leave it alone — while the
      // still-auto hosts list DOES resync (the fields decide independently).
      await browser.execute((s) => {
        const ta = document.querySelector(s) as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(ta, "/alpha-rw\n/keep-me");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, rw);
      await clickRowInclude("alpha");
      // The all-unchecked note is the flush marker (the "N of M" note only
      // renders while at least one member is included).
      await waitForText("No members selected");
      expect(await field(rw)).toBe("/alpha-rw\n/keep-me");
      expect(await field(hosts)).toBe("");
      // The task-type choice persists on click — put it back on Worktree.
      await clickWhenVisible('[data-testid="task-type-worktree"]');
      await closeDialog();
    },
  );
});

// The host-level Main checkout shape of the multi New Task dialog.
//
// Main checkout on a multi project is the SAME task the sidebar quick menu's
// Main checkout creates (task_open_repo: the live host checkout with every
// member linked in, no wrapper, no branch), so ⌘N and the `+` menu can't
// drift into different task shapes. Fixture: two tiny member repos plus a
// host dir, torn down completely (task archived, project removed, tmp gone).
describe("multi main checkout (New Task dialog)", () => {
  let tmp = "";
  let projectId = "";
  const taskIds: string[] = [];
  /** The app-wide task-type memory this spec drives; restored in teardown. */
  let savedMode: string | null = null;

  /** Fill the dialog's Name field (native setter so React sees it). */
  const typeName = (value: string) =>
    browser.execute((v) => {
      const input = document.querySelector(
        '[role="dialog"] input[placeholder="fix login bug"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);

  /** Click a button by exact label, scoped to the multi dialog. */
  const clickInDialog = (label: string) =>
    browser.execute((l) => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        d.textContent?.includes("New multi-repo task"),
      )!;
      const btn = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.trim() === l) as HTMLButtonElement;
      btn.click();
    }, label);

  /** Wait for the created task to land in the store; returns it. */
  const waitForTask = (name: string) =>
    browser.waitUntil(
      async () => {
        const t = await browser.execute((n) =>
          window.__termic!.useApp.getState().tasks.find((w: any) => w.name === n), name);
        return t ?? false;
      },
      { timeout: 15_000, timeoutMsg: `task "${name}" never appeared` },
    ) as Promise<any>;

  /** Uncheck a member's include box by member name. */
  const uncheckMember = (name: string) =>
    browser.execute((n) => {
      const row = document.querySelector(`[data-testid="member-mode-row"][data-member-name="${n}"]`)!;
      (row.querySelector('[data-testid="member-include"]') as HTMLInputElement).click();
    }, name);

  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "e2e-multi-main-"));
    mkdirSync(path.join(tmp, "host"));
    for (const name of ["alpha", "beta"]) {
      const p = path.join(tmp, name);
      mkdirSync(p);
      execSync(`git init -b main -q "${p}"`);
      execSync(`git -C "${p}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`);
    }
  });

  after(async () => {
    // A mid-test failure can leave either dialog open; close both.
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeNewTask();
      ui.closeEditTask();
    });
    for (const id of taskIds) await archiveTask(id);
    await browser.execute(async (id, mode) => {
      try {
        if (mode === null) localStorage.removeItem("newTaskLastMode");
        else localStorage.setItem("newTaskLastMode", mode);
      } catch { /* fine */ }
      if (id) {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }
    }, projectId, savedMode);
    // Longer than the others: on Windows a member repo stays busy for a few
    // seconds after its task and project are gone.
    if (tmp) rmTree(tmp);
  });

  it("shows the host-level toggle; Main checkout replaces the member rows with a run-live note", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const created = await browser.execute(
      async (host, alpha, beta) => {
        const t = window.__termic!;
        let saved: string | null = null;
        try {
          // Start from Worktree so the member rows are on screen and the
          // flip below is a real transition, not a no-op.
          saved = localStorage.getItem("newTaskLastMode");
          localStorage.setItem("newTaskLastMode", "worktree");
        } catch { /* fine */ }
        // A run that died before teardown leaves the project behind (fresh
        // path, same name) — drop any stale one first.
        for (const p of t.useApp.getState().projects.filter((p: any) => p.name === "e2e-multi-main")) {
          try { await t.ipc.projectRemove(p.id); } catch { /* has live tasks */ }
        }
        const spec = (root_path: string, name: string) => ({
          root_path,
          name,
          base_branch: "main",
          setup_script: "",
          run_script: "",
          archive_script: "",
          // Per-member seatbelt lists so the Edit-task sandbox test below
          // has a union to shrink.
          sandbox_rw_paths: [`/${name}-rw`],
          sandbox_allowed_hosts: [`${name}.local`],
        });
        const proj = await t.ipc.projectAddMulti(
          host,
          "e2e-multi-main",
          [spec(alpha, "alpha"), spec(beta, "beta")],
          true, // non-git wrapper host
        );
        await t.useApp.getState().loadAll();
        t.useUI.getState().openNewTask(proj.id);
        return { id: proj.id as string, saved };
      },
      path.join(tmp, "host"),
      path.join(tmp, "alpha"),
      path.join(tmp, "beta"),
    );
    projectId = created.id;
    savedMode = created.saved;

    // Worktree shape: one row per member, host toggle present.
    await waitVisible('[data-testid="task-type-main"]');
    await waitForText("Members (2 of 2)");

    await clickWhenVisible('[data-testid="task-type-main"]');
    await waitVisible('[data-testid="members-live-note"]');
    await waitForText("2 of 2 members run live");
    // Main checkout still shows the member list — as a plain checklist now,
    // since unchecking a member keeps it out of the task entirely.
    const rows = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="member-mode-row"]')].map(
        (e) => e.getAttribute("data-member-mode"),
      ));
    expect(rows).toEqual(["repo_root", "repo_root"]);
  });

  it("Create opens the live host checkout with every member linked in, no wrapper", async () => {
    await typeName("e2e-mm-live");
    // Terminal (shell) is token-free; both clicks scoped to THIS dialog.
    for (const label of ["Terminal", "Create"]) await clickInDialog(label);

    const task = await waitForTask("e2e-mm-live");
    taskIds.push(task.id);
    const hostRoot = await browser.execute(
      (id) => window.__termic!.useApp.getState().projects.find((p: any) => p.id === id).root_path,
      projectId,
    );
    expect(task.is_main_checkout).toBe(true);
    expect(task.path).toBe(hostRoot);
    expect(task.composition.map((m: any) => [m.dir_name, m.mode])).toEqual([
      ["alpha", "repo_root"],
      ["beta", "repo_root"],
    ]);
  });

  it("unchecking a member links only the checked ones into the live checkout", async () => {
    // Reopen — the previous create closed the dialog. Main-checkout mode is
    // remembered app-wide, so the checklist is already up.
    await browser.execute((id) => window.__termic!.useUI.getState().openNewTask(id), projectId);
    await waitVisible('[data-testid="member-mode-row"]');
    await uncheckMember("beta");
    await waitForText("1 of 2 members run live");

    await typeName("e2e-mm-subset");
    for (const label of ["Terminal", "Create"]) await clickInDialog(label);

    const task = await waitForTask("e2e-mm-subset");
    taskIds.push(task.id);
    expect(task.composition.map((m: any) => [m.dir_name, m.mode])).toEqual([
      ["alpha", "repo_root"],
    ]);

    // The host's managed .gitignore block must keep covering the LIVE
    // sibling's ("e2e-mm-live") links too — a subset open rewriting it
    // with only its own dirs would un-ignore /beta under that task.
    const hostRoot = await browser.execute(
      (id) => window.__termic!.useApp.getState().projects.find((p: any) => p.id === id).root_path,
      projectId,
    );
    const gitignore = readFileSync(path.join(hostRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain("\n/alpha\n");
    expect(gitignore).toContain("\n/beta\n");
  });

  it("worktree mode mounts only the checked members", async () => {
    await browser.execute((id) => window.__termic!.useUI.getState().openNewTask(id), projectId);
    await waitVisible('[data-testid="task-type-worktree"]');
    await clickWhenVisible('[data-testid="task-type-worktree"]');
    await waitVisible('[data-testid="member-include"]');
    await uncheckMember("alpha");
    await waitForText("Members (1 of 2)");

    await typeName("e2e-mm-subset-wt");
    for (const label of ["Terminal", "Create"]) await clickInDialog(label);

    const task = await waitForTask("e2e-mm-subset-wt");
    taskIds.push(task.id);
    const hostRoot = await browser.execute(
      (id) => window.__termic!.useApp.getState().projects.find((p: any) => p.id === id).root_path,
      projectId,
    );
    // A worktree task lives in the wrapper dir, not the host checkout.
    expect(task.path).not.toBe(hostRoot);
    expect(task.composition.map((m: any) => [m.dir_name, m.mode])).toEqual([
      ["beta", "worktree"],
    ]);
  });

  it("Duplicate worktree seeds the source task's member subset", async () => {
    // "e2e-mm-subset-wt" included only beta — duplicating it must reopen the
    // dialog with beta in and alpha out, not the all-in default.
    const taskId = await browser.execute(
      () => window.__termic!.useApp.getState().tasks.find((w: any) => w.name === "e2e-mm-subset-wt")?.id,
    ) as string;
    const row = `[data-sidebar-task-id="${taskId}"]`;
    await waitVisible(row);
    // WebDriver's right-click doesn't reach Radix's onContextMenu in this
    // WKWebView; the dispatched event does (task.e2e.ts measured it).
    // The menu item's onSelect defers openNewTask through
    // requestAnimationFrame — and rAF is permanently frozen in the
    // occluded harness window (document.hidden the whole suite), so the
    // callback never runs. Stub rAF synchronous for the gesture only —
    // the seed path, not the frame defer, is what's under test.
    await browser.execute(() => {
      const w = window as any;
      w.__origRAF = w.requestAnimationFrame;
      w.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
    });
    try {
      await browser.execute((s) => {
        const el = document.querySelector(s) as HTMLElement;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 5,
        }));
      }, row);
      await waitVisible('[role="menu"]');
      // Click straight away in one round-trip: clickMenuItemUntil's poll loop
      // can straddle the menu's open/close and end up watching nothing.
      await browser.execute(() => {
        const el = [...document.querySelectorAll("[role='menuitem']")].find(
          e => e.textContent?.trim() === "Duplicate worktree",
        ) as HTMLElement | undefined;
        if (!el) throw new Error("no Duplicate worktree menuitem");
        el.click();
      });
    } finally {
      await browser.execute(() => {
        const w = window as any;
        w.requestAnimationFrame = w.__origRAF;
      });
    }
    await waitForText("Members (1 of 2)");
    const included = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="member-mode-row"]')].map(
        (e) => [e.getAttribute("data-member-name"), e.getAttribute("data-member-included")],
      ));
    expect(included).toEqual([["alpha", "false"], ["beta", "true"]]);
    // A subset seed must union only the CHECKED members' sandbox lists —
    // seeding the all-members union would pin alpha's paths into a beta-only
    // task (and resync would never fix it: the textarea wouldn't equal the
    // checked-set union).
    if (process.platform === "darwin") {
      await browser.execute(() => {
        const dlg = document.querySelector('[data-testid="member-include"]')!.closest('[role="dialog"]')!;
        const btn = [...dlg.querySelectorAll("button")].find(
          (b) => b.querySelector("span")?.textContent?.trim() === "ENFORCING (filesystem + network)",
        ) as HTMLButtonElement;
        btn.click();
      });
      const rw = '[data-testid="sandbox-rw-paths"]';
      await waitVisible(rw);
      await browser.waitUntil(async () => (await browser.execute(
        (s) => (document.querySelector(s) as HTMLTextAreaElement).value, rw)) === "/beta-rw",
        { timeout: 5_000, timeoutMsg: "the subset seed pinned the all-members union" });
    }
    await dismissOverlays();
  });

  it("Edit task adds a missing member, removes one, and renames", async () => {
    // "e2e-mm-subset-wt" is beta-only. The edit flips it to alpha-only,
    // deletes beta's worktree, and renames — all in one save.
    const taskId = await browser.execute(
      () => window.__termic!.useApp.getState().tasks.find((w: any) => w.name === "e2e-mm-subset-wt")?.id,
    ) as string;
    const before = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id), taskId) as any;
    await browser.execute((id) => window.__termic!.useUI.getState().openEditTask(id), taskId);
    await waitVisible('[data-testid="edit-member-row"]');
    const initial = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="edit-member-row"]')].map((e) => [
        e.getAttribute("data-member-name"),
        e.getAttribute("data-member-existing"),
        e.getAttribute("data-member-checked"),
      ]));
    expect(initial).toEqual([["beta", "true", "true"], ["alpha", "false", "false"]]);

    const clickRow = (name: string) => browser.execute((n) => {
      const row = document.querySelector(`[data-testid="edit-member-row"][data-member-name="${n}"]`)!;
      (row.querySelector('[data-testid="edit-member-include"]') as HTMLElement).click();
    }, name);
    await clickRow("alpha");
    // Pin the add's mode explicitly — the app-wide member-mode memory is
    // order-dependent across the spec, so force Worktree either way.
    await browser.execute(() => {
      const row = document.querySelector('[data-testid="edit-member-row"][data-member-name="alpha"]')!;
      const btn = [...row.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Worktree",
      ) as HTMLButtonElement;
      btn.click();
    });
    await clickRow("beta");
    // Colon, not an em dash: CLAUDE.md bans em dashes in user-visible text,
    // and this string arrived with one.
    await waitForText("Will be removed: its worktree is deleted on save.");

    // Rename in the same save — name is the dialog's first input.
    await browser.execute((v) => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => d.textContent?.includes("Edit task"),
      )!;
      const input = dlg.querySelector("input") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, "e2e-mm-edited");

    await browser.execute(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => d.textContent?.includes("Edit task"),
      )!;
      const btn = [...dlg.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save",
      ) as HTMLButtonElement;
      btn.click();
    });
    // Removing a worktree member is destructive — the confirm must gate it.
    await waitVisible('[data-testid="confirm-ok"]');
    await clickWhenVisible('[data-testid="confirm-ok"]');

    const task = await waitForTask("e2e-mm-edited");
    // Same id as "e2e-mm-subset-wt" — already in taskIds; pushing it again
    // would archive it twice and the second teardown hits the gone worktree.
    expect(task.id).toBe(taskId);
    expect(task.composition.map((m: any) => [m.dir_name, m.mode])).toEqual([
      ["alpha", "worktree"],
    ]);
    // The wrapper now holds alpha's worktree; beta's dir is gone.
    expect(existsSync(path.join(before.path, "alpha"))).toBe(true);
    expect(existsSync(path.join(before.path, "beta"))).toBe(false);
    await waitGone('[data-testid="edit-member-row"]');
  });

  // The stored-list side of the same rule (the GH #343 follow-up): a task
  // whose seatbelt lists still equal the auto union gets them re-derived on
  // a toggle; a hand-edited textarea is the user's and stays put.
  // macOS-only — the Seatbelt fields don't render elsewhere.
  seatbeltIt(
    "Edit task re-derives stored seatbelt lists on a member toggle, keeps hand edits",
    async () => {
      const rw = '[data-testid="sandbox-rw-paths"]';
      const hosts = '[data-testid="sandbox-allowed-hosts"]';
      const field = (sel: string) => browser.execute(
        (s) => (document.querySelector(s) as HTMLTextAreaElement).value, sel);
      const clickRow = (name: string) => browser.execute((n) => {
        const row = document.querySelector(`[data-testid="edit-member-row"][data-member-name="${n}"]`)!;
        (row.querySelector('[data-testid="edit-member-include"]') as HTMLElement).click();
      }, name);
      /** A Seatbelt task over the first `count` members, storing the
       *  all-members union as if create had auto-pinned it. */
      const createSandboxed = (name: string, count: number) =>
        browser.execute(async (pid, n, c) => {
          const t = window.__termic!;
          // Member root_paths must be the canonical ones Rust stored — the
          // raw tmp path differs under macOS's /var → /private/var.
          const proj = t.useApp.getState().projects.find((p: any) => p.id === pid)!;
          const created = await t.ipc.taskCreateMulti({
            project_id: pid,
            name: n,
            cli: "shell",
            members: proj.members.slice(0, c).map((m: any) => ({ root_path: m.root_path, mode: "worktree" })),
            sandbox_enabled: true,
            sandbox_mode: "enforce",
            // Stored == the all-members union, so it reads as auto.
            sandbox_rw_paths: ["/alpha-rw", "/beta-rw"],
            sandbox_allowed_hosts: ["alpha.local", "beta.local"],
          });
          await t.useApp.getState().loadAll();
          return created;
        }, projectId, name, count) as Promise<any>;
      const removalNotes = () => browser.execute(() =>
        [...document.querySelectorAll('[data-testid="edit-member-row"]')]
          .filter((r) => r.textContent?.includes("Will be removed")).length);

      const task = await createSandboxed("e2e-mm-sandbox", 2);
      taskIds.push(task.id);
      await browser.execute((id) => window.__termic!.useUI.getState().openEditTask(id), task.id);
      await waitVisible(rw);
      expect(await field(rw)).toBe("/alpha-rw\n/beta-rw");
      expect(await field(hosts)).toBe("alpha.local\nbeta.local");

      // Stored is the auto union → unchecking beta shrinks both lists.
      await clickRow("beta");
      await browser.waitUntil(async () => (await field(rw)) === "/alpha-rw"
        && (await field(hosts)) === "alpha.local", {
        timeout: 5_000, timeoutMsg: "the stored auto union did not shrink on uncheck",
      });

      // Re-checking beta grows it back — textarea == prevAuto while
      // stored ≠ prevAuto, so only the arrEq(now, prevAuto) arm can fire.
      await clickRow("beta");
      await browser.waitUntil(async () => (await field(rw)) === "/alpha-rw\n/beta-rw", {
        timeout: 5_000, timeoutMsg: "the resynced union did not grow back on re-check",
      });

      // Hand-edited rw → the next toggle must not rewrite it (the still-auto
      // hosts list resyncs independently — to beta's alone).
      await browser.execute((s) => {
        const ta = document.querySelector(s) as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(ta, "/alpha-rw\n/keep-me");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }, rw);
      await clickRow("alpha");
      // Alpha's removal note is the flush marker for the uncheck commit.
      await browser.waitUntil(async () => (await removalNotes()) === 1,
        { timeout: 5_000, timeoutMsg: "alpha never marked for removal" });
      expect(await field(rw)).toBe("/alpha-rw\n/keep-me");
      expect(await field(hosts)).toBe("beta.local");
      await browser.execute(() => window.__termic!.useUI.getState().closeEditTask());
      await waitGone('[data-testid="edit-member-row"]');

      // The stored-auto arm the first task can't reach: a task whose
      // composition is a SUBSET of the project but whose stored lists are
      // the all-members union (pinned before subsets, or by the pre-#343
      // union). Only the stored==allAuto check treats it as untouched —
      // without it, unchecking the last member leaves the pinned union.
      const subTask = await createSandboxed("e2e-mm-sandbox-sub", 1);
      taskIds.push(subTask.id);
      await browser.execute((id) => window.__termic!.useUI.getState().openEditTask(id), subTask.id);
      await waitVisible(rw);
      expect(await field(rw)).toBe("/alpha-rw\n/beta-rw");
      await clickRow("alpha");
      await browser.waitUntil(async () => (await field(rw)) === ""
        && (await field(hosts)) === "", {
        timeout: 5_000, timeoutMsg: "the stored all-members union did not clear on uncheck",
      });
      await browser.execute(() => window.__termic!.useUI.getState().closeEditTask());
      await waitGone('[data-testid="edit-member-row"]');
    },
  );
});


// The project + menu is a launcher, so its first row is the one people reach
// for without reading: it must be the project's OWN default CLI, wherever
// that agent happens to sit in the Settings registry order.
describe("new task menu puts the project default first", () => {
  let projectId = "";
  let originalDefault = "";

  const openMenu = async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
  };

  /** The launcher rows, in display order, as the cli ids they create. */
  const cliRows = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[role="menu"] [data-launcher-cli]')].map(
        (el) => (el as HTMLElement).dataset.launcherCli as string,
      ),
    ) as Promise<string[]>;

  const setDefault = (cli: string) =>
    browser.execute(async (id, value) => {
      const app = window.__termic!.useApp.getState();
      const p = app.projects.find((x: any) => x.id === id);
      await window.__termic!.ipc.projectUpdate({ ...p, default_cli: value });
      await window.__termic!.useApp.getState().loadAll();
    }, projectId, cli);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    const p = (await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((x: any) => x.name === "fixture-repo"),
    )) as any;
    projectId = p.id;
    originalDefault = p.default_cli ?? "claude";
  });

  after(async () => {
    await browser.keys("Escape");
    await setDefault(originalDefault);
  });

  it("leads with the default agent, then the registry order", async () => {
    const ids = (await browser.execute(() =>
      window.__termic!.useApp.getState().agents.map((a: any) => a.id as string),
    )) as string[];
    const last = ids[ids.length - 1];
    await setDefault(last);

    await openMenu();
    const rows = await cliRows();
    expect(rows[0]).toBe(last);
    // Still one row per agent, plus Terminal: hoisting is a move, not a copy.
    expect(rows.filter((r) => r === last)).toHaveLength(1);
    // Terminal keeps the tail, and everything between holds its registry
    // order (which agents are offered at all is detection's business, not
    // this test's).
    expect(rows[rows.length - 1]).toBe("shell");
    const rest = rows.slice(1).filter((r) => r !== "shell");
    expect(rest).toEqual(ids.filter((i) => rest.includes(i)));
    await browser.keys("Escape");
  });

  it("hoists Terminal too when that is the default", async () => {
    await setDefault("shell");
    await openMenu();
    expect((await cliRows())[0]).toBe("shell");
    await browser.keys("Escape");
  });
});

// files_to_copy on a multi-repo project (GH #264).
//
// Multi-repo tasks used to get member worktrees with none of their gitignored
// files: `effective_files_to_copy` had two call sites and both were single-repo,
// so keystores / service-account keys / `.env` had to be hand-copied before a
// build would run. The list now resolves at three levels, and this spec pins
// all three because each resolves differently:
//
//   host   → the multi-repo project's own `files_to_copy`, into the task root
//   member → the per-member override on the project's member entry
//   member → that member repo's OWN committed `.termic.yaml`, when no override
//
// Assertions are on-disk (a file copy has no DOM surface): the spec reads the
// paths the create IPC hands back. The fixture lives under a realpath'd temp
// dir because Rust canonicalizes every member path on add, and
// `task_create_multi` matches the per-task member specs against those
// canonical strings — a raw `/var/...` would come back "member not found".
describe("recursive files to copy (GH #320)", () => {
  let repo = "";
  let projectId = "";

  before(() => {
    repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "e2e-recursive-copy-")));
    execSync(`git init -b main -q "${repo}"`);
    execSync(`git -C "${repo}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`);
    mkdirSync(path.join(repo, "evals/deep"), { recursive: true });
    writeFileSync(path.join(repo, ".env"), "ROOT=1");
    writeFileSync(path.join(repo, "evals/.env"), "EVALS=1");
    writeFileSync(path.join(repo, "evals/deep/.env.local"), "DEEP=1");
  });

  after(async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.execute(async (root) => {
      const t = window.__termic!;
      for (const task of t.useApp.getState().tasks.filter(
        (task: any) => task.name === "e2e-recursive-copy-task" && !task.archived,
      )) {
        await t.ipc.taskArchive(task.id);
      }
      for (const project of t.useApp.getState().projects.filter(
        (project: any) => project.root_path === root,
      )) {
        await t.ipc.projectRemove(project.id);
      }
      await t.useApp.getState().loadAll();
    }, repo);
    rmTree(repo, { bestEffort: true });
  });

  it("copies root and nested env files into a single-repo worktree", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const result = await browser.execute(async (root) => {
      const t = window.__termic!;
      const project = await t.ipc.projectAdd(root);
      await t.ipc.projectUpdate({ ...project, files_to_copy: ["**/.env*"] });
      const task = await t.ipc.taskCreate({
        project_id: project.id,
        name: "e2e-recursive-copy-task",
        cli: "shell",
        base_branch: "main",
        branch: "e2e-recursive-copy-task",
      });
      await t.useApp.getState().loadAll();
      return { projectId: project.id as string, path: task.path as string };
    }, repo);
    projectId = result.projectId;

    expect(readFileSync(path.join(result.path, ".env"), "utf8")).toBe("ROOT=1");
    expect(readFileSync(path.join(result.path, "evals/.env"), "utf8")).toBe("EVALS=1");
    expect(readFileSync(path.join(result.path, "evals/deep/.env.local"), "utf8")).toBe("DEEP=1");

    await browser.execute((id) =>
      window.__termic!.useApp.getState().openSettings("repositories", id), projectId);
    await waitVisible('textarea[placeholder*="src/config/local.py"]');
    expect(await browser.execute(() => {
      const heading = [...document.querySelectorAll("div")].find(
        (el) => el.textContent?.trim() === "Files to copy",
      );
      return heading?.parentElement?.textContent?.includes("**/.env* at any depth") ?? false;
    })).toBe(true);
    await browser.execute(() => document.querySelector(
      'textarea[placeholder*="src/config/local.py"]',
    )?.scrollIntoView({ block: "center" }));
    await snap("recursive-files-to-copy-settings.png");
  });
});

describe("multi files to copy (GH #264)", () => {
  const PROJECT_NAME = "e2e-multi-copy";
  let tmp = "";
  let taskId = "";

  /** A tiny git repo with one commit, plus whatever extra files. */
  const seedRepo = (root: string, files: Record<string, string>) => {
    mkdirSync(root, { recursive: true });
    execSync(`git init -b main -q "${root}"`);
    execSync(`git -C "${root}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`);
    for (const [rel, body] of Object.entries(files)) {
      const target = path.join(root, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  };

  /** Drop every project this spec owns, tasks and all. Swept by NAME, not by
   *  a captured id: a body that throws between the add and the assertions
   *  never gets to report one, and the leftover then poisons the next run
   *  with "a project at this path is already added". */
  const sweepProjects = () => browser.execute(async (name) => {
    const t = window.__termic!;
    for (const p of t.useApp.getState().projects.filter((p: any) => p.name === name)) {
      try { await t.ipc.projectRemove(p.id); } catch { /* best effort */ }
    }
    await t.useApp.getState().loadAll();
  }, PROJECT_NAME);

  before(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "e2e-multi-copy-")));
    // Host: gitignored secrets only the project's own list names.
    seedRepo(path.join(tmp, "host"), {
      ".env": "HOST=1",
      "evals/.env": "HOST_EVALS=1",
      "host-only.txt": "host",
      "README.md": "not copied",
    });
    // alpha declares its own globs in `.termic.yaml` — no override needed.
    seedRepo(path.join(tmp, "alpha"), {
      ".termic.yaml": "version: 1\nscripts:\n  files_to_copy:\n    - \"**/.env*\"\n    - \"secrets\"\n",
      ".env": "ALPHA=1",
      ".env.local": "ALPHA=2",
      "evals/.env": "ALPHA_EVALS=1",
      "secrets/key.pem": "PRIVATE",
      "README.md": "not copied",
    });
    // beta declares nothing; the multi-repo project overrides for it.
    seedRepo(path.join(tmp, "beta"), {
      "config/local.json": "{\"beta\":true}",
      "README.md": "not copied",
    });
  });

  after(async () => {
    // The window is reused by later spec files, so leave Settings closed.
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    if (taskId) await archiveTask(taskId);
    await sweepProjects();
    rmTree(tmp, { bestEffort: true });
  });

  it("copies the host list into the task root and each member's own list into its worktree", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await sweepProjects();

    const created = await browser.execute(
      async (name, host, alpha, beta) => {
        const t = window.__termic!;
        const member = (root_path: string, files_to_copy: string[]) => ({
          root_path,
          name: root_path.split(/[\\/]/).pop()!,
          base_branch: "main",
          setup_script: "", run_script: "", archive_script: "",
          files_to_copy,
        });
        const proj = await t.ipc.projectAddMulti(host, name, [
          member(alpha, []),                       // falls back to alpha's .termic.yaml
          member(beta, ["config/local.json"]),     // per-member override
        ], false) as any;
        // The multi-repo project's OWN list — the box that had no reader.
        await t.ipc.projectUpdate({ ...proj, files_to_copy: ["**/.env*", "host-only.txt"] });
        // Members are matched by the CANONICAL path Rust stored, not the one
        // passed in above.
        const task = await t.ipc.taskCreateMulti({
          project_id: proj.id,
          name: "e2e-copy-task",
          cli: "shell",
          members: proj.members.map((m: any) => ({ root_path: m.root_path, mode: "worktree" })),
        } as any);
        await t.useApp.getState().loadAll();
        return {
          taskId: task.id as string,
          root: task.path as string,
          members: Object.fromEntries(
            (task.composition ?? []).map((m: any) => [m.dir_name, m.path as string]),
          ) as Record<string, string>,
        };
      },
      PROJECT_NAME,
      path.join(tmp, "host"),
      path.join(tmp, "alpha"),
      path.join(tmp, "beta"),
    );
    taskId = created.taskId;

    // Host list → the task root (which IS the host's worktree).
    expect(readFileSync(path.join(created.root, ".env"), "utf8")).toBe("HOST=1");
    expect(readFileSync(path.join(created.root, "evals/.env"), "utf8")).toBe("HOST_EVALS=1");
    expect(readFileSync(path.join(created.root, "host-only.txt"), "utf8")).toBe("host");

    // alpha: resolved from its own committed .termic.yaml, directories included.
    const alphaWt = created.members.alpha;
    expect(readFileSync(path.join(alphaWt, ".env"), "utf8")).toBe("ALPHA=1");
    expect(readFileSync(path.join(alphaWt, ".env.local"), "utf8")).toBe("ALPHA=2");
    expect(readFileSync(path.join(alphaWt, "evals/.env"), "utf8")).toBe("ALPHA_EVALS=1");
    expect(readFileSync(path.join(alphaWt, "secrets/key.pem"), "utf8")).toBe("PRIVATE");

    // beta: the per-member override on the multi-repo project.
    const betaWt = created.members.beta;
    expect(readFileSync(path.join(betaWt, "config/local.json"), "utf8")).toBe("{\"beta\":true}");

    // Each list stays in its own lane: the host's globs must not rain down on
    // the members, alpha's must not reach beta, and nothing undeclared travels.
    expect(existsSync(path.join(alphaWt, "host-only.txt"))).toBe(false);
    expect(existsSync(path.join(betaWt, ".env"))).toBe(false);
    expect(existsSync(path.join(betaWt, "host-only.txt"))).toBe(false);
    expect(existsSync(path.join(alphaWt, "README.md"))).toBe(false);
  });

  it("restores the same files when the task is unarchived", async () => {
    // Archive tears the worktrees down and the copies go with them. Restore
    // has to re-run the copy or the task comes back unbuildable.
    const restored = await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskArchive(id);
      const task = await t.ipc.taskRestore(id);
      await t.useApp.getState().loadAll();
      return {
        root: task.path as string,
        members: Object.fromEntries(
          (task.composition ?? []).map((m: any) => [m.dir_name, m.path as string]),
        ) as Record<string, string>,
      };
    }, taskId);

    expect(readFileSync(path.join(restored.root, ".env"), "utf8")).toBe("HOST=1");
    expect(readFileSync(path.join(restored.root, "evals/.env"), "utf8")).toBe("HOST_EVALS=1");
    expect(readFileSync(path.join(restored.members.alpha, ".env.local"), "utf8")).toBe("ALPHA=2");
    expect(readFileSync(path.join(restored.members.alpha, "evals/.env"), "utf8")).toBe("ALPHA_EVALS=1");
    expect(readFileSync(path.join(restored.members.beta, "config/local.json"), "utf8")).toBe("{\"beta\":true}");
  });

  it("edits a member's Files list from Members & scripts and drops blank lines", async () => {
    // The settings field is the only way a user reaches the per-member list,
    // and blank lines matter: an empty glob would both suppress the member
    // repo's `.termic.yaml` fallback and resolve to the repo root itself.
    const projectId = await browser.execute((name) =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === name)!.id as string,
      PROJECT_NAME,
    );
    await browser.execute((id) =>
      window.__termic!.useApp.getState().openSettings("repositories", id), projectId);
    await waitVisible('[data-testid="member-files-to-copy-beta"]');
    expect(await browser.execute(() => {
      const heading = [...document.querySelectorAll("div")].find(
        (el) => el.textContent?.trim() === "Files to copy",
      );
      return heading?.parentElement?.textContent?.includes("**/.env* at any depth") ?? false;
    })).toBe(true);

    await browser.execute(() => {
      const box = document.querySelector(
        '[data-testid="member-files-to-copy-beta"]',
      ) as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value",
      )!.set!;
      setter.call(box, "config/local.json\n\n  gradle.properties  \n");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The Save button only enables once the edit lands in React state, so
    // wait for that rather than clicking a disabled button into the void.
    await browser.waitUntil(async () => browser.execute(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Save members & scripts (2)",
      ) as HTMLButtonElement | undefined;
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    }), { timeoutMsg: "the members Save button never enabled" });

    const saved = await browser.waitUntil(async () => {
      const list = await browser.execute((id) =>
        window.__termic!.useApp.getState().projects
          .find((p: any) => p.id === id)?.members
          ?.find((m: any) => m.name === "beta")?.files_to_copy ?? null,
        projectId) as string[] | null;
      return list && list.length === 2 ? list : false;
    }, { timeoutMsg: "the member's files_to_copy never came back from projects.json" }) as string[];

    expect(saved).toEqual(["config/local.json", "gradle.properties"]);
  });
});

// The quick-create menu says which cage a new task will get.
//
// The sidebar + menu applies the project's default silently, and on the main
// checkout that means a cage over your REAL files with nothing on screen
// having said so. The row states it, with the mode's own icon, so this and
// the sandbox picker are recognisably the same thing. It is HIDDEN for a
// project defaulting to "off", since uncaged is the baseline and a row saying
// so on every menu open is noise.
describe("quick-create sandbox note", () => {
  const NOTE = '[data-testid="quick-create-sandbox-note"]';
  let projectId = "";
  let saved: Record<string, unknown> | null = null;

  /** Set the project's default engine through the same IPC Settings uses. */
  const setDefault = (fields: Record<string, unknown>) => browser.execute(async (id, f) => {
    const t = window.__termic!;
    const p = t.useApp.getState().projects.find((p: any) => p.id === id);
    await t.ipc.projectUpdate({ ...p, ...(f as object) });
    await t.useApp.getState().loadAll();
  }, projectId, fields);

  const openMenu = async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    const info = await browser.execute(() => {
      const p = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")!;
      return { id: p.id as string, saved: {
        default_sandbox: p.default_sandbox ?? false,
        default_sandbox_mode: p.default_sandbox_mode ?? null,
        default_docker: p.default_docker ?? false,
      } };
    });
    projectId = info.id;
    saved = info.saved;
  });

  after(async () => {
    await browser.keys("Escape");
    if (saved) await setDefault(saved);
  });

  it("names Docker, with its icon, when the project defaults to it", async () => {
    await setDefault({ default_sandbox: false, default_sandbox_mode: null, default_docker: true });
    await openMenu();
    await waitVisible(NOTE);
    const [kind, text, hasIcon] = await browser.execute((sel) => {
      const el = document.querySelector(sel)!;
      return [el.getAttribute("data-sandbox-default"), el.textContent ?? "", !!el.querySelector("svg")];
    }, NOTE) as [string, string, boolean];
    expect(kind).toBe("docker");
    expect(text).toContain("Docker");
    expect(hasIcon).toBe(true);
    await browser.keys("Escape");
  });

  (process.platform === "darwin" ? it.skip : it)("says nothing for a Seatbelt default, which this OS does not have", async () => {
    await setDefault({ default_sandbox: true, default_sandbox_mode: "enforce", default_docker: false });
    await openMenu();
    const present = await browser.execute((sel) => !!document.querySelector(sel), NOTE);
    expect(present).toBe(false);
    await browser.keys("Escape");
  });

  seatbeltIt("names the mode, with its icon, when the project defaults to one", async () => {
    await setDefault({ default_sandbox: true, default_sandbox_mode: "monitor", default_docker: false });
    await openMenu();
    await waitVisible(NOTE);
    const [kind, text] = await browser.execute((sel) => {
      const el = document.querySelector(sel)!;
      return [el.getAttribute("data-sandbox-default"), el.textContent ?? ""];
    }, NOTE) as [string, string];
    expect(kind).toBe("monitor");
    expect(text).toContain("Sandboxed");
    // The icon rides along, so the row is recognisable at a glance rather
    // than being another line of grey text.
    const hasIcon = await browser.execute((sel) => !!document.querySelector(`${sel} svg`), NOTE);
    expect(hasIcon).toBe(true);
    await browser.keys("Escape");
  });

  seatbeltIt("follows the project to a different mode", async () => {
    await setDefault({ default_sandbox: true, default_sandbox_mode: "enforce", default_docker: false });
    await openMenu();
    await waitVisible(NOTE);
    const kind = await browser.execute((sel) =>
      document.querySelector(sel)!.getAttribute("data-sandbox-default"), NOTE);
    expect(kind).toBe("enforce");
    await browser.keys("Escape");
  });

  it("says nothing at all when the project is uncaged", async () => {
    await setDefault({ default_sandbox: false, default_sandbox_mode: null, default_docker: false });
    await openMenu();
    // The menu is up; the note specifically is not.
    const present = await browser.execute((sel) => !!document.querySelector(sel), NOTE);
    expect(present).toBe(false);
    await browser.keys("Escape");
  });
});

// The quick-create menu says when a new agent task will start in YOLO.
//
// Same reason as the sandbox note above: the + menu applies the default with
// no checkbox to show it in, so without this line it would switch approvals
// off with nothing on screen having said so. Hidden when the answer is off
// (the baseline) and when the project's cage already turns YOLO on.
describe("quick-create YOLO note", () => {
  const NOTE = '[data-testid="quick-create-yolo-note"]';
  let projectId = "";
  let saved: { pref: boolean; project: Record<string, unknown> } | null = null;

  const setProject = (fields: Record<string, unknown>) => browser.execute(async (id, f) => {
    const t = window.__termic!;
    const p = t.useApp.getState().projects.find((p: any) => p.id === id);
    await t.ipc.projectUpdate({ ...p, ...(f as object) });
    await t.useApp.getState().loadAll();
  }, projectId, fields);
  const setAppDefault = (on: boolean) =>
    browser.execute((v) => window.__termic!.usePrefs.getState().setDefaultYolo(v), on);

  const noteShown = async () => {
    const trigger = `[data-testid="project-new-task-${projectId}"]`;
    await waitVisible(trigger);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"]');
    const shown = await browser.execute((sel) => !!document.querySelector(sel), NOTE);
    await browser.keys("Escape");
    return shown;
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    const info = await browser.execute(() => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")!;
      return { id: p.id as string, pref: !!t.usePrefs.getState().defaultYolo, project: {
        default_yolo: p.default_yolo ?? null,
        default_sandbox: p.default_sandbox ?? false,
        default_sandbox_mode: p.default_sandbox_mode ?? null,
        default_docker: p.default_docker ?? false,
      } };
    });
    projectId = info.id;
    saved = { pref: info.pref, project: info.project };
    await setProject({ default_yolo: null, default_sandbox: false, default_sandbox_mode: null, default_docker: false });
  });

  after(async () => {
    await browser.keys("Escape");
    if (saved) {
      await setAppDefault(saved.pref);
      await setProject(saved.project);
    }
  });

  it("says nothing when no default is on", async () => {
    await setAppDefault(false);
    expect(await noteShown()).toBe(false);
  });

  it("says so when the app-wide default is on", async () => {
    await setAppDefault(true);
    expect(await noteShown()).toBe(true);
  });

  it("follows a project that keeps asking", async () => {
    await setAppDefault(true);
    await setProject({ default_yolo: false });
    expect(await noteShown()).toBe(false);
    await setProject({ default_yolo: null });
  });

  it("stays quiet when the project's cage already turns YOLO on", async () => {
    await setAppDefault(true);
    // Seatbelt is macOS only (off it, a Seatbelt default reads as Off);
    // Docker is a cage on every OS.
    const cage = process.platform === "darwin"
      ? { default_sandbox: true, default_sandbox_mode: "enforce" }
      : { default_docker: true };
    await setProject(cage);
    expect(await noteShown()).toBe(false);
    await setProject({ default_sandbox: false, default_sandbox_mode: null, default_docker: false });
  });
});

// Clone from a git URL (GH #285).
//
// Clones a LOCAL bare repo, so the spec is offline and deterministic: the
// flow under test is identical for a remote, and a network clone in CI would
// be the flakiest thing in the suite.
//
// Terminal output is a WebGL canvas and never reaches the DOM, so nothing here
// asserts on what the terminal shows. What it asserts instead is the thing the
// terminal is FOR: the command was typed into a real PTY, pressing Enter ran
// it, and a repo appeared on disk as a result.
describe("new project from a git URL", () => {
  let origin = "";
  let parent = "";
  let addedId: string | null = null;

  before(() => {
    origin = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "e2e-clone-origin-")));
    const work = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "e2e-clone-work-")));
    // A bare repo with one real commit: an EMPTY remote clones into something
    // indistinguishable from a clone still running, which is the exact case
    // the Add gate cannot resolve on its own.
    execSync(
      `git -C "${work}" init -q `
      + `&& git -C "${work}" -c user.email=e2e@termic.dev -c user.name=alice commit -q --allow-empty -m init `
      + `&& git -C "${work}" clone -q --bare . "${origin}/repo.git"`,
    );
    rmTree(work, { bestEffort: true });
    parent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "e2e-clone-into-")));
  });

  after(async () => {
    if (addedId) {
      await browser.execute(async (id) => {
        await window.__termic!.invoke("project_remove", { id });
        await window.__termic!.useApp.getState().loadAll();
      }, addedId);
    }
    // Both are this spec's own temp dirs; the clone lands inside `parent`.
    rmTree(origin, { bestEffort: true });
    rmTree(parent, { bestEffort: true });
  });

  it("proposes a destination from the URL and refuses to guess without one", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openNewProject());
    await waitVisible('[data-testid="project-mode-clone"]');
    await clickWhenVisible('[data-testid="project-mode-clone"]');
    await waitVisible('[data-testid="clone-url"]');

    // No URL yet: nothing to clone into, and Clone stays out of reach.
    const disabledBefore = await browser.execute(() =>
      (document.querySelector('[data-testid="clone-start"]') as HTMLButtonElement | null)?.disabled ?? null);
    expect(disabledBefore).toBe(true);

    await setDialogInput('[data-testid="clone-parent"]', parent);
    await setDialogInput('[data-testid="clone-url"]', `${origin}/repo.git`);

    // The name comes off the URL the way git would take it.
    await waitVisible('[data-testid="clone-dest"]');
    const dest = await browser.execute(() =>
      document.querySelector('[data-testid="clone-dest"]')!.textContent);
    expect(dest).toBe(path.join(parent, "repo"));
  });

  // Both of these shipped broken and neither was caught, because the spec fed
  // an absolute path that already existed. A `~` path is what the user reached
  // for first.
  it("expands ~ in the destination instead of taking it literally", async () => {
    await setDialogInput('[data-testid="clone-parent"]', "~");
    const shown = await browser.execute(() =>
      document.querySelector('[data-testid="clone-dest"]')?.textContent ?? "");
    // The home directory, not a folder called "~". Taken literally this became
    // a cwd that does not exist, the shell fell back to home, and the clone
    // landed somewhere the user never picked.
    expect(shown.startsWith("~")).toBe(false);
    expect(shown.endsWith(`${path.sep}repo`)).toBe(true);
  });

  it("refuses a folder that does not exist rather than cloning somewhere else", async () => {
    await setDialogInput('[data-testid="clone-parent"]', `${parent}/nope-not-here`);
    await clickWhenVisible('[data-testid="clone-start"]');
    // No terminal, and a reason. A missing cwd does not fail the spawn: it
    // starts the shell in the home directory, which is how a clone ends up in
    // a place nobody chose while the Add gate waits on a path that stays empty.
    await waitForText("does not exist");
    const spawned = await browser.execute(() =>
      !!document.querySelector('[data-testid="clone-terminal"]'));
    expect(spawned).toBe(false);
    // Put the real destination back for the clone that follows.
    await setDialogInput('[data-testid="clone-parent"]', parent);
  });

  it("runs the clone on its own and waits for a repo before offering Add", async () => {
    await clickWhenVisible('[data-testid="clone-start"]');
    await waitVisible('[data-testid="clone-terminal"]');

    // The command reaches the pty only once the shell has sent its prompt.
    // Writing it before that put it into the tty ahead of zsh, which echoed it
    // raw and then rendered it AGAIN when it read the type-ahead: the user saw
    // the command twice. This hook is the app saying the write has happened.
    await waitVisible('[data-testid="clone-terminal"] [data-initial-input="sent"]');

    // Nothing is typed or pressed here, deliberately. Clicking Clone is the
    // whole gesture: the command carries its own CR, so a repo appearing at
    // the destination is proof it reached a real shell and ran.
    await browser.waitUntil(
      async () => !(await browser.execute(() =>
        (document.querySelector('[data-testid="clone-add"]') as HTMLButtonElement).disabled)),
      { timeout: 30_000, timeoutMsg: "the clone never produced a repo at the destination" },
    );
    await snap("clone-from-url");
  });

  it("adds the clone as a project", async () => {
    await clickWhenVisible('[data-testid="clone-add"]');
    await browser.waitUntil(
      async () => {
        const p = (await browser.execute(
          (d) => window.__termic!.useApp.getState()
            .projects.find((x: any) => x.root_path === d) ?? null,
          path.join(parent, "repo"),
        )) as any;
        if (!p) return false;
        addedId = p.id;
        return true;
      },
      { timeout: 15_000, timeoutMsg: "the cloned repo was never added as a project" },
    );
    // A successful add closes the dialog, same as every other path in it.
    await waitGone('[data-testid="clone-url"]');
  });
});

/** Set a controlled input the way React sees it, then fire its input event. */
async function setDialogInput(selector: string, value: string): Promise<void> {
  await browser.execute((sel, v) => {
    const input = document.querySelector(sel) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    )!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, value);
}

// GH #324: the project row's task filter. A filter icon opens a bar under
// the header: a text input (task name + stable agent tab titles), and a bell
// that keeps only tasks with a notification. Both are live: a CLI rename or a
// notification arriving moves a row in or out with nothing else happening.
describe("sidebar task filter", () => {
  let pid = "";
  let home = "";
  let alpha = "";
  let beta = "";
  let gamma = "";
  const row = (id: string) => `[data-sidebar-task-id="${id}"]`;
  const INPUT = () => `[data-testid="project-filter-input-${pid}"]`;
  const TOGGLE = () => `[data-testid="project-filter-toggle-${pid}"]`;
  const CLEAR = () => `[data-testid="project-filter-clear-${pid}"]`;
  const BELL = () => `[data-testid="project-filter-bell-${pid}"]`;
  const COUNT = () => `[data-testid="project-filter-bell-count-${pid}"]`;
  const EMPTY = () => `[data-testid="project-filter-empty-${pid}"]`;

  const present = (id: string) =>
    browser.execute((sel) => !!document.querySelector(sel), row(id));
  const expectRows = async (want: Record<string, boolean>, msg: string) => {
    let last: Record<string, boolean> = {};
    await browser.waitUntil(async () => {
      // Built aside and swapped in whole, so a timeout mid-iteration still
      // reports the last complete reading instead of an empty one.
      const seen: Record<string, boolean> = {};
      for (const id of Object.keys(want)) seen[id] = await present(id);
      last = seen;
      return Object.keys(want).every(id => seen[id] === want[id]);
    }, { timeout: 8_000, timeoutMsg: `${msg}: rows ${JSON.stringify(last)}` });
  };
  // Raw click: the controls sit at opacity 0 until the row is hovered, and
  // whether a synthetic pointer counts as hover is not what these cases test.
  const click = (sel: string) =>
    browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), sel);
  /** Type into the filter through React's own input event, opening it first. */
  const typeFilter = async (value: string) => {
    if (!(await browser.execute((s) => !!document.querySelector(s), INPUT()))) {
      await click(TOGGLE());
      await waitVisible(INPUT());
    }
    await browser.execute((sel, v) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, INPUT(), value);
  };
  /** Park the real pointer off the sidebar, so hover cannot reveal the bar. */
  const pointerAway = () => $("header[data-active-task]").moveTo();
  const pinned = () =>
    browser.execute((s) => document.querySelector(s)?.getAttribute("data-pinned") ?? null, TOGGLE());
  const opacity = (sel: string) =>
    browser.execute((s) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).opacity : null;
    }, sel);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    pid = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")!.id as string);
    alpha = await openTask("e2e-filter-alpha");
    await waitForAgentReady(alpha);
    beta = await openTask("e2e-filter-beta");
    await waitForAgentReady(beta);
    gamma = await openTask("e2e-filter-gamma", false);
    // The active task is always shown, so keep one that no case filters for.
    home = await openTask("e2e-filter-home", true, "shell");
    await browser.execute((id) => {
      window.__termic!.useApp.getState().setProjectCollapsed(id, false);
      window.__termic!.useUI.setState({ taskFilters: {} });
    }, pid);
    await expectRows({ [alpha]: true, [beta]: true, [gamma]: true }, "setup rows");
  });

  after(async () => {
    await browser.execute(() => window.__termic!.useUI.setState({ taskFilters: {} }));
    await setWindowPresence(true);
    for (const id of [alpha, beta, gamma, home]) if (id) await archiveTask(id);
  });

  it("opens the filter bar from the filter icon, and closes it again", async () => {
    const lit = () => browser.execute((s) => document.querySelector(s)!.getAttribute("aria-pressed"), TOGGLE());
    await click(TOGGLE());
    await waitVisible(INPUT());
    // The bell sits in the same bar, to the input's right.
    await waitVisible(BELL());
    const focused = await browser.execute((s) => document.activeElement === document.querySelector(s), INPUT());
    expect(focused).toBe(true);
    // Open is not active: nothing filters yet, so the icon stays unlit.
    expect(await lit()).toBe("false");
    await click(TOGGLE());
    await waitGone(INPUT());
  });

  it("lights the filter icon for text and for the bell", async () => {
    const lit = () => browser.execute((s) => document.querySelector(s)!.getAttribute("aria-pressed"), TOGGLE());
    await typeFilter("alpha");
    await browser.waitUntil(async () => (await lit()) === "true", { timeoutMsg: "text did not light the icon" });
    await keysIn(INPUT(), "Escape");
    await waitGone(INPUT());
    expect(await lit()).toBe("false");
    await click(TOGGLE());
    await waitVisible(BELL());
    await click(BELL());
    await browser.waitUntil(async () => (await lit()) === "true", { timeoutMsg: "the bell did not light the icon" });
    // An active filter keeps its bar: the icon only focuses it now.
    await click(TOGGLE());
    await waitVisible(INPUT());
    await click(BELL());
    await waitGone(INPUT());
    expect(await lit()).toBe("false");
  });

  it("keeps only tasks whose name matches, and pins the bar", async () => {
    await typeFilter("ALPHA ");
    await expectRows({ [alpha]: true, [beta]: false, [gamma]: false }, "name filter");
    // The bar stays up with the pointer elsewhere, so the user can see why
    // rows are missing.
    await browser.waitUntil(async () => (await pinned()) === "true",
      { timeout: 5_000, timeoutMsg: "an active filter did not pin the bar" });
    await pointerAway();
    expect(await opacity(TOGGLE())).toBe("1");
    await snap("task-filter-name.png");
  });

  it("matches an agent tab's title", async () => {
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tab = s.tabs[id].find((t: any) => t.type === "terminal");
      s.renameTab(id, tab.id, "Reviewer");
    }, beta);
    await typeFilter("review");
    await expectRows({ [alpha]: false, [beta]: true, [gamma]: false }, "tab title filter");
  });

  it("follows a CLI rename live", async () => {
    await typeFilter("alpha");
    await expectRows({ [alpha]: true, [gamma]: false }, "before rename");
    const r = await cliRpc({ cmd: "rename", task: gamma, name: "e2e-filter-alpha-too" });
    expect(r.ok).toBe(true);
    await expectRows({ [gamma]: true }, "a rename into the filter did not show the task");
    await cliRpc({ cmd: "rename", task: gamma, name: "e2e-filter-gamma" });
    await expectRows({ [gamma]: false }, "a rename out of the filter did not hide the task");
  });

  it("clears from the button and turns the filter off", async () => {
    await typeFilter("alpha");
    await waitVisible(CLEAR());
    await click(CLEAR());
    await waitGone(INPUT());
    await expectRows({ [alpha]: true, [beta]: true, [gamma]: true }, "clear");
    const filters = await browser.execute(() => window.__termic!.useUI.getState().taskFilters);
    expect(filters).toEqual({});
    // Hover may still reveal it, so assert the pin itself, not the opacity.
    await browser.waitUntil(async () => (await pinned()) === "false",
      { timeout: 5_000, timeoutMsg: "the bar stayed pinned after the filter was cleared" });
  });

  it("says nothing under the active task it keeps on screen", async () => {
    // home is active and in this project, so the list is not empty: it holds
    // home by exemption. A "no matching tasks" line under a visible row reads
    // as a contradiction, so the hint waits for a genuinely empty list.
    await typeFilter("zzz-no-such-task");
    await expectRows({ [home]: true, [alpha]: false }, "active task exemption");
    expect(await browser.execute((s) => !!document.querySelector(s), EMPTY())).toBe(false);
    await keysIn(INPUT(), "Escape");
    await waitGone(INPUT());
    // No active task from here to the bell cases, so the list can be empty.
    await browser.execute(() => window.__termic!.useApp.getState().setActiveTask(null));
  });

  it("says so when nothing matches, and Escape clears", async () => {
    await typeFilter("zzz-no-such-task");
    await waitVisible(EMPTY());
    await expectRows({ [alpha]: false, [beta]: false, [gamma]: false }, "no match");
    await keysIn(INPUT(), "Escape");
    await waitGone(INPUT());
    await waitGone(EMPTY());
    await expectRows({ [alpha]: true, [beta]: true, [gamma]: true }, "escape");
  });

  it("clears from the empty row's action", async () => {
    await typeFilter("zzz-no-such-task");
    await waitVisible(EMPTY());
    await click(`${EMPTY()} button`);
    await waitGone(EMPTY());
    await expectRows({ [alpha]: true, [beta]: true, [gamma]: true }, "empty-row clear");
    await ensureActiveTask(home);
  });

  it("expands a collapsed project when a filter goes on, and still lets it collapse", async () => {
    // The header toggles on pointerdown + a document pointerup (it is also
    // the drag handle), so drive exactly that. A native WebDriver click
    // stalls on Tauri window-state calls.
    const clickHeader = () => browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, button: 0, clientX: r.left + 4, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new PointerEvent("pointerup", init));
    }, `[data-project-id="${pid}"] span.truncate`);
    await browser.execute((id) => window.__termic!.useApp.getState().setProjectCollapsed(id, true), pid);
    await expectRows({ [alpha]: false }, "collapse");
    await typeFilter("alpha");
    await expectRows({ [alpha]: true, [beta]: false }, "filter under a collapsed project");
    // A real click on the header, with the filter still on: the chevron has
    // to keep working, not be overridden for as long as a filter is up.
    await clickHeader();
    await expectRows({ [alpha]: false }, "collapsing with a filter on");
    await clickHeader();
    await expectRows({ [alpha]: true }, "expanding with a filter on");
    await keysIn(INPUT(), "Escape");
    await expectRows({ [alpha]: true, [beta]: true }, "clear");
  });

  it("keeps only tasks with a notification behind the bell", async () => {
    await requireWorkBadges();
    // Away: the only state in which a badge persists at all.
    await setWindowPresence(false);
    await ensureActiveTask(alpha);
    await submitToAgent(alpha, "#osc9 FakeAgent needs your permission");
    await waitForWorkBadge(alpha, "attention", { timeout: 15_000, message: "no attention to filter on" });
    await ensureActiveTask(home);

    await click(TOGGLE());
    await waitVisible(COUNT());
    await click(BELL());
    const pressed = await browser.execute((s) => document.querySelector(s)!.getAttribute("aria-pressed"), BELL());
    expect(pressed).toBe("true");
    await expectRows({ [alpha]: true, [beta]: false, [gamma]: false }, "bell filter");
    // The lit icon is what says rows are hidden, so it must actually show.
    await pointerAway();
    const probe = await browser.execute((s) => {
      const el = document.querySelector(s) as HTMLElement;
      const st = getComputedStyle(el);
      return { opacity: st.opacity, pressed: el.getAttribute("aria-pressed") };
    }, TOGGLE());
    expect(probe.opacity).toBe("1");
    expect(probe.pressed).toBe("true");
    await snap("task-filter-bell.png");
  });

  it("keeps the active task visible after answering clears its notification", async () => {
    const count = async () =>
      Number(await browser.execute((s) => document.querySelector(s)?.textContent ?? "0", COUNT()));
    const before = await count();
    await ensureActiveTask(alpha);
    // Opening is not answering: an agent's question keeps its bell, and the
    // count with it, until it is answered (docs/agent-states.md, "A question
    // is not answered by looking at it").
    await setWindowPresence(true);
    expect(await count()).toBe(before);
    // Answering is a key in that terminal: a bare digit, no Enter.
    await typeIntoAgent(alpha, "1");
    await browser.waitUntil(async () => (await count()) === before - 1,
      { timeout: 8_000, timeoutMsg: "answering the task did not clear its notification" });
    await typeIntoAgent(alpha, "\x7f");
    // Its notification is gone, but it is the row the user is on.
    await expectRows({ [alpha]: true }, "active task exemption");
    await ensureActiveTask(home);
    await expectRows({ [alpha]: false }, "leaving the task drops it from the filtered list");
    await click(BELL());
    await expectRows({ [alpha]: true, [beta]: true, [gamma]: true }, "bell off");
  });
});
