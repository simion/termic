import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTask, clickByText, clickMenuItemUntil, clickWhenVisible, createWorktreeTask, dashboardBadge, dismissOverlays, ensureActiveTask, openTask, pointerDrag, requireTermicApi, keysIn, snap, submitToAgent, waitForAgentReady, waitForAppShell, waitForText, waitForTextGone, waitGone, waitVisible } from "../helpers";

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
    rmSync(dir, { recursive: true, force: true });
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
    const dir2 = realpathSync(mkdtempSync(path.join(os.tmpdir(), "e2e-proj-enter-")));
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
      rmSync(dir2, { recursive: true, force: true });
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
  after(() => rmSync(dir, { recursive: true, force: true }));

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
      rmSync(bare, { recursive: true, force: true });
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
    for (const r of remotes) rmSync(remotePath(r), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
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
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
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
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
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

// A task's phase (src/lib/taskPhase.ts) is DERIVED at render from the task
// record plus the PR store plus the git store, never stored, so every case
// here drives the real inputs (create a task, prompt it through xterm, seed
// the snapshot the PR poller writes, move real refs with real git) and reads
// the phase back off the row's own `data-task-phase`. Asserting `taskPhase()`
// instead would keep passing after the row stopped rendering it, which is the
// whole failure mode this block exists to catch.
describe("dashboard phases", () => {
  /** Every fixture task carries this prefix, so teardown can sweep by NAME:
   *  a throw mid-case leaves a task on disk and returns no id at all. It is
   *  also the branch glob the fixture and its origin are swept with below. */
  const PREFIX = "e2e-phase-";
  /** The one branch this block creates in the shared fixture repo. */
  const BRANCH = `${PREFIX}pr`;
  const row = (id: string) => `[data-dashboard-task-id="${id}"]`;
  const pill = (phase: string) => `[data-testid="dashboard-phase-filter"] [data-phase="${phase}"]`;
  const age = (id: string) => `${row(id)} [data-testid="task-age"]`;
  const EMPTY = '[data-testid="dashboard-phase-empty"]';

  let todoId = "";
  let prId = "";
  let ageId = "";

  /** The fixture's `main`, the bare origin's `refs/heads/main`, and which
   *  branch the fixture checkout had out, all as they stood BEFORE this block
   *  ran. The merged-into-base case moves the first two and touches the third,
   *  and teardown restores them from THESE rather than from anything a case
   *  returned: a throw half way through that case returns nothing at all. */
  let mainSha = "";
  let originMainSha = "";
  let fixtureHead = "";

  /** Run git and hand back stdout. stderr is captured into the throw instead
   *  of printed, so a step that fails names itself in the test output rather
   *  than leaving a bare "Command failed" beside unrelated console noise. */
  const git = (args: string, cwd: string): string => {
    try {
      return execSync(`git -C "${cwd}" ${args}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(`git ${args} failed in ${cwd}: ${String(err.stderr ?? err.message ?? e).trim()}`);
    }
  };

  /** The same, for teardown steps that may legitimately have nothing to do
   *  (no remote branch to delete, no local branch left, no worktree to prune).
   *  Each one is separate so a failure in one does not skip the rest. */
  const gitTry = (args: string, cwd: string) => {
    try { git(args, cwd); } catch { /* nothing to undo */ }
  };

  const showDashboard = async () => {
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));
    // The phase-empty line is an accepted landing state: under a filter that
    // matches nothing there is no project card left to wait for.
    await waitVisible(`[data-dashboard-project-id], ${EMPTY}`);
  };

  /** `ensureActiveTask` waits on the STORE; `submitToAgent` needs a terminal
   *  with geometry. After a dashboard round trip those are not the same
   *  moment (`setView` nulls `activeTaskId` and the pane goes display:none),
   *  and the gap is how a submit gets dispatched at a hidden pane. */
  const focusTaskTerminal = async (id: string) => {
    await ensureActiveTask(id);
    await waitVisible(`[data-task-id="${id}"] .xterm`);
  };

  /** The phase the row is RENDERING, or null when the row is not on the page. */
  const rowPhase = (id: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement | null)?.dataset.taskPhase ?? null,
      row(id),
    ) as Promise<string | null>;

  const waitRowPhase = async (id: string, phase: string) => {
    let seen: string | null = null;
    await browser
      .waitUntil(
        async () => {
          seen = await rowPhase(id);
          return seen === phase;
        },
        { timeout: 15_000, interval: 100 },
      )
      .catch(() => {
        throw new Error(`row ${id} never reached phase ${phase} (it reads ${seen})`);
      });
  };

  /** A pill's count as a number. Every phase pill is always rendered, so a
   *  null here means the filter row itself is missing, not an empty phase. */
  const pillCount = (phase: string) =>
    browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? Number(el.dataset.count) : null;
    }, pill(phase)) as Promise<number | null>;

  /** Which pills read as selected. "all" is one of them: clearing the filter
   *  presses All rather than pressing nothing. */
  const pressedPills = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="dashboard-phase-filter"] [data-phase]')]
        .filter((el) => el.getAttribute("aria-pressed") === "true")
        .map((el) => el.getAttribute("data-phase")),
    ) as Promise<string[]>;

  /** Every phase the filter row offers, in the order it offers them. */
  const pillOrder = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="dashboard-phase-filter"] [data-phase]')].map((el) =>
        el.getAttribute("data-phase"),
      ),
    ) as Promise<string[]>;

  /** The number beside the Projects heading, read from the DOM rather than
   *  `projects.length`: the claim is about what the header SHOWS. */
  const projectsHeaderCount = () =>
    browser.execute(() => {
      const h = [...document.querySelectorAll("h2")].find((e) => e.textContent?.trim() === "Projects");
      return h?.parentElement?.querySelector("span")?.textContent?.trim() ?? null;
    }) as Promise<string | null>;

  const textOf = (selector: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement | null)?.textContent?.trim() ?? null,
      selector,
    ) as Promise<string | null>;

  const countOf = (selector: string) =>
    browser.execute((sel) => document.querySelectorAll(sel).length, selector) as Promise<number>;

  /** One field of the record as it stands ON DISK, straight from what
   *  `tasks_list` reads back, never from the store that is about to write it. */
  const diskField = (id: string, field: string) =>
    browser.execute(
      async (taskId, key) => {
        const list = (await window.__termic!.invoke("tasks_list")) as any[];
        const w = list.find((x) => x.id === taskId);
        return w ? (w[key] ?? null) : null;
      },
      id,
      field,
    ) as Promise<unknown>;

  const diskStamp = (id: string) => diskField(id, "last_opened_at") as Promise<string | null>;
  const diskStarted = (id: string) => diskField(id, "started_at") as Promise<string | null>;
  const diskSpawns = (id: string) => diskField(id, "spawn_count") as Promise<number | null>;

  /** Poll one disk stamp until it is present and minutes old rather than
   *  seconds in the future. Both writes behind these (`task_touch`,
   *  `task_mark_started`) are deliberately fire-and-forget. */
  const waitFreshStamp = async (id: string, field: "last_opened_at" | "started_at") => {
    let disk: string | null = null;
    await browser
      .waitUntil(
        async () => {
          disk = (await diskField(id, field)) as string | null;
          const elapsed = Date.now() - Date.parse(disk ?? "");
          return elapsed < 120_000 && elapsed > -5_000;
        },
        { timeout: 10_000, interval: 200 },
      )
      .catch(() => {
        throw new Error(`${field} never went null -> fresh on disk for ${id} (it holds ${disk})`);
      });
  };

  /** One task's git entry, as the store holds it. */
  const gitEntry = (id: string) =>
    browser.execute(
      (taskId) => window.__termic!.useTaskGit.getState().byTask[taskId] ?? null,
      id,
    ) as Promise<{ state: Record<string, unknown> | null; loading: boolean; fetchedAt: number } | null>;

  /**
   * Re-read one task's git state NOW.
   *
   * `taskGitPassNow()` is the wrong tool between two steps seconds apart: it
   * honours the 30s per-task floor, so the second call is a no-op and the row
   * keeps rendering the previous answer. `refresh(id, true)` skips the floor,
   * but it still returns silently while a lookup is in flight (the dashboard's
   * own pass can be mid-walk over the same task), so the condition is
   * `fetchedAt` ADVANCING, not the call returning.
   */
  const forceGit = async (id: string) => {
    const before = (await gitEntry(id))?.fetchedAt ?? 0;
    await browser.waitUntil(
      async () => {
        await browser.execute(async (taskId) => {
          await window.__termic!.useTaskGit.getState().refresh(taskId, true);
        }, id);
        return ((await gitEntry(id))?.fetchedAt ?? 0) > before;
      },
      { timeout: 20_000, interval: 200, timeoutMsg: `the git lookup for ${id} never completed` },
    );
  };

  /** `waitRowPhase`, with the git state folded into the failure. "it reads
   *  in_progress" says nothing when the fact that decides the case is
   *  `ahead: null` rather than `dirty: true`. */
  const waitGitPhase = async (id: string, phase: string) => {
    try {
      await waitRowPhase(id, phase);
    } catch (e) {
      throw new Error(`${(e as Error).message} - git state ${JSON.stringify(await gitEntry(id))}`);
    }
  };

  /** One base PR, one field changed per step, so each case in the ladder below
   *  differs only in the thing under test. Placeholder repo: never a real one. */
  const BASE_PR = {
    provider: "github",
    number: 31,
    url: "https://github.com/acme/repo/pull/31",
    title: "Teach the dashboard about phases",
    state: "open",
    checks: "passing",
    review: "none",
    base: "main",
    head: BRANCH,
  };

  /** Write the snapshot the poller would have written. Same shape as the
   *  PR-chip case above, because it is the same store entry. */
  const seedPr = (id: string, pr: Record<string, unknown>) =>
    browser.execute(
      (taskId, snapshot) => {
        window.__termic!.usePr.setState({
          byTask: {
            [taskId]: { lookup: { status: "ok", pr: snapshot }, loading: false, fetchedAt: Date.now() },
          },
        });
      },
      id,
      pr,
    );

  /** TerminalPane kicks an UNFORCED `usePr.refresh` when a worktree task
   *  spawns its agent, and that lookup resolves against the fixture's local
   *  origin some time later. Seeding before it lands would simply be
   *  overwritten, so wait for the app's own entry to settle first. The entry
   *  appears synchronously when `refresh` starts, so "no entry" is not
   *  "settled": both halves are the condition. */
  const waitForPrSettled = (id: string) =>
    browser.waitUntil(
      () =>
        browser.execute((taskId) => {
          const e = window.__termic!.usePr.getState().byTask[taskId];
          return !!e && !e.loading;
        }, id),
      { timeout: 20_000, timeoutMsg: `the spawn never settled a PR lookup for ${id}` },
    );

  /** Archive every non-archived `e2e-phase-` task, whatever this run knows
   *  about. The pill counts are over the WHOLE fleet, so one task left behind
   *  by a run that died mid-case skews every number here. */
  const sweepByName = () =>
    browser.execute(async (prefix) => {
      const t = window.__termic!;
      const stale = t.useApp.getState().tasks.filter(
        (w: any) => !w.archived && typeof w.name === "string" && w.name.startsWith(prefix),
      );
      for (const w of stale) {
        try { await t.ipc.taskArchive(w.id); } catch { /* already gone */ }
      }
      await t.useApp.getState().loadAll();
    }, PREFIX);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await sweepByName();
    await browser.execute(() => {
      // A seeded PR, a stale git entry or a selected phase from an earlier run
      // would change every count and hide half the rows.
      window.__termic!.usePr.setState({ byTask: {} });
      window.__termic!.useTaskGit.setState({ byTask: {} });
      window.__termic!.useUI.getState().setDashboardPhase(null);
    });
    // The same sweep teardown does, run FORWARDS: a branch left in the fixture
    // by a run that died mid-case makes `task_create` refuse the branch name
    // outright, and the failure would read as a broken create rather than as
    // last time's dirt. Tasks are archived first (above), which is what frees
    // the worktree holding the branch.
    gitTry("worktree prune", fixture);
    // `--format` QUOTED. `git` here goes through `execSync`, which runs the
    // string under /bin/sh, and a bare `%(refname:short)` is a shell syntax
    // error on the parenthesis: "syntax error near unexpected token `('".
    for (const b of git(`branch --list '${PREFIX}*' --format='%(refname:short)'`, fixture)
      .split("\n").map((s) => s.trim()).filter(Boolean)) {
      gitTry(`branch -D ${b}`, fixture);
    }
    for (const line of git("ls-remote --heads origin", fixture).split("\n")) {
      const ref = line.split(/\s+/)[1] ?? "";
      const name = ref.replace("refs/heads/", "");
      if (name.startsWith(PREFIX)) gitTry(`push -q origin --delete ${name}`, fixture);
    }

    fixtureHead = git("rev-parse --abbrev-ref HEAD", fixture);
    mainSha = git("rev-parse main", fixture);
    // The BARE repo's own truth, not `rev-parse origin/main`, which is only
    // ever as fresh as the last fetch this checkout happened to run.
    originMainSha = git("ls-remote origin refs/heads/main", fixture).split(/\s+/)[0] ?? "";
  });

  after(async () => {
    // Tasks first: archiving removes the worktree, and git refuses to delete a
    // branch that a worktree still has checked out. `task_archive` defaults
    // `delete_branch` to false and only ever runs `worktree remove --force`,
    // so the branch is always ours to clean up.
    for (const id of [todoId, prId, ageId]) {
      if (!id) continue;
      try { await archiveTask(id); } catch { /* already gone */ }
    }
    try { await sweepByName(); } catch { /* the window may be gone */ }
    try {
      await browser.execute(async () => {
        const t = window.__termic!;
        t.usePr.setState({ byTask: {} });
        t.useTaskGit.setState({ byTask: {} });
        t.useUI.getState().setDashboardPhase(null);
        t.useApp.getState().setView("dashboard");
        await t.useApp.getState().loadAll();
      });
    } catch { /* the window may be gone */ }

    // Then the fixture's REFS, which the merged-into-base case moves on both
    // sides. Every step is its own try, because what is left behind is not
    // this run's problem: `git.e2e.ts` branches from this same `main`, and a
    // half-restored fixture fails there instead, a much longer walk back.
    if (mainSha) {
      if (git("rev-parse --abbrev-ref HEAD", fixture) !== "main") gitTry("checkout -q main", fixture);
      gitTry(`reset --hard -q ${mainSha}`, fixture);
    }
    if (originMainSha) gitTry(`push -q --force origin ${originMainSha}:refs/heads/main`, fixture);
    gitTry(`push -q origin --delete ${BRANCH}`, fixture);
    gitTry("worktree prune", fixture);
    gitTry(`branch -D ${BRANCH}`, fixture);
    gitTry("fetch -q --prune origin", fixture);
    if (fixtureHead && fixtureHead !== "HEAD" && fixtureHead !== "main") {
      gitTry(`checkout -q ${fixtureHead}`, fixture);
    }

    // Assert the sweep actually swept, HERE, one screen away from the cause.
    // A branch or a remote head left behind never fails the run that created
    // it; it fails a later spec file on a base that moved.
    //
    // Scoped to what THIS block moves, deliberately. A blanket `status
    // --porcelain` check reads better but fails on any untracked file an
    // earlier spec left in the shared fixture, and then blames this block for
    // it: `reset --hard` does not remove untracked files, so the debris would
    // survive the restore above. The `repo config` block's `git clean -fd`
    // swallows its own errors, and a dev whose fixture is already dirty from
    // an interrupted run would fail here for a reason that is not ours.
    if (mainSha) expect(git("rev-parse main", fixture)).toEqual(mainSha);
    expect(git(`branch --list '${PREFIX}*'`, fixture)).toEqual("");
    expect(git("ls-remote origin", fixture)).not.toContain(PREFIX);
  });

  it("keeps a task Todo until the first prompt, even after its agent has spawned", async () => {
    // Created without activating, so the two halves of the claim stay apart:
    // nothing has spawned here, and it is still Todo after a spawn below.
    todoId = await openTask(`${PREFIX}todo`, false);
    await showDashboard();
    await waitRowPhase(todoId, "todo");

    // Every phase pill is always rendered, in lifecycle order, so a pill's
    // presence is no longer the claim: its count is. Parked comes last, after
    // Done: the first four are a task's life in sequence and Parked is a task
    // stepping out of that line, so it sits at the end rather than between In
    // review and Done (PHASE_ORDER in src/lib/taskPhase.ts).
    expect(await pillOrder()).toEqual(["all", "todo", "in_progress", "in_review", "done", "parked"]);
    const todoBefore = await pillCount("todo");
    expect(todoBefore).not.toBeNull();
    expect(todoBefore!).toBeGreaterThanOrEqual(1);

    // A record nothing has ever opened carries no `last_opened_at`, so the row
    // shows no age rather than a guessed one, and nobody has prompted it, so
    // there is no `started_at` on it either.
    expect(await countOf(age(todoId))).toEqual(0);
    expect(await diskStarted(todoId)).toBeNull();

    // SPAWNING IS NOT STARTING, which is the whole point of the change.
    // Opening the task mounts its pane and spawns fakeagent; the phase must
    // not move, because an agent sitting at its prompt is not work anyone
    // asked for.
    await ensureActiveTask(todoId);
    await waitForAgentReady(todoId);
    await showDashboard();
    await waitVisible(row(todoId));
    // Proved against a record the spawn REWROTE, not against a read that
    // merely happened early: `task_record_spawn` folds `spawn_count` back into
    // the file, so waiting for it to reach 1 and reading `started_at` off that
    // same listing is "the record moved and the stamp was not in it" rather
    // than "we looked and nothing had happened yet".
    await browser.waitUntil(async () => ((await diskSpawns(todoId)) ?? 0) >= 1, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `the spawn in ${todoId} was never recorded on disk`,
    });
    expect(await diskStarted(todoId)).toBeNull();
    expect(await rowPhase(todoId)).toEqual("todo");
    expect(await pillCount("todo")).toEqual(todoBefore);
    await snap("dashboard-phase-todo.png");

    // The first prompt a human submits is what starts it, and it goes in
    // through xterm's own input path (onData -> markStarted), never by
    // patching the record.
    await focusTaskTerminal(todoId);
    await submitToAgent(todoId, "hello");
    await showDashboard();
    await waitRowPhase(todoId, "in_progress");
    expect(await pillCount("todo")).toEqual(todoBefore! - 1);

    // And it persists, which has no DOM to read instead: null a moment ago,
    // now a stamp minutes old.
    await waitFreshStamp(todoId, "started_at");
  });

  it("follows the PR through the phase ladder", async () => {
    // A worktree task, not a main checkout: `pollableTasks` skips main
    // checkouts, so a PR seeded onto one would be testing a state that cannot
    // happen in production. It is also the branch the git case below drives.
    prId = await createWorktreeTask(`${PREFIX}pr`, BRANCH, true);
    await waitForAgentReady(prId);
    await waitForPrSettled(prId);
    await showDashboard();
    // Spawned and nothing else, exactly like the repo-root task above: a
    // worktree with a branch of its own is still not work in progress.
    await waitRowPhase(prId, "todo");

    // One prompt, so the ladder starts from a task somebody has actually asked
    // for something.
    await focusTaskTerminal(prId);
    await submitToAgent(prId, "hello");
    await showDashboard();
    await waitRowPhase(prId, "in_progress");

    const ladder: Array<[Record<string, unknown>, string]> = [
      // An open PR is the thing In review means.
      [{ state: "open" }, "in_review"],
      // A draft says outright that it is not ready to be looked at.
      [{ state: "draft" }, "in_progress"],
      // A review round does not bounce the phase back and forth: the PR chip
      // already says changes were requested.
      [{ state: "open", review: "changes_requested" }, "in_review"],
      // Nor does CI. A failing check is a property of the work, not a stage.
      [{ state: "open", checks: "failing" }, "in_review"],
      // Closed and unmerged falls back to In progress, never Todo: there is
      // real work on the branch.
      [{ state: "closed" }, "in_progress"],
      [{ state: "merged" }, "done"],
    ];
    for (const [patch, phase] of ladder) {
      await seedPr(prId, { ...BASE_PR, ...patch });
      await waitRowPhase(prId, phase);
    }

    // Leave it Open: the filter case below needs exactly one In review row.
    await seedPr(prId, { ...BASE_PR, state: "open" });
    await waitRowPhase(prId, "in_review");
  });

  it("hides what the selected phase does not match, and clears itself", async () => {
    // Both premises are re-seeded rather than inherited, so this case starts
    // from its own state whatever the ones above left behind: an open PR for
    // the worktree task, and a started stamp for the repo-root one.
    // `markStarted` is write-once, so re-running it on a started task is a
    // no-op rather than a second stamp.
    await seedPr(prId, { ...BASE_PR, state: "open" });
    await browser.execute((id) => window.__termic!.useApp.getState().markStarted(id), todoId);
    await showDashboard();
    await waitRowPhase(prId, "in_review");
    await waitRowPhase(todoId, "in_progress");

    const reviewCount = await pillCount("in_review");
    const progressCount = await pillCount("in_progress");
    const projectsCount = await projectsHeaderCount();

    await clickWhenVisible(pill("in_review"));
    await browser.waitUntil(
      async () => (await pressedPills()).includes("in_review"),
      { timeout: 8_000, timeoutMsg: "the In review pill never read as selected" },
    );
    await waitVisible(row(prId));
    await waitGone(row(todoId));

    // The pills describe the fleet, not the view, so selecting one must not
    // renumber them.
    expect(await pillCount("in_review")).toEqual(reviewCount);
    expect(await pillCount("in_progress")).toEqual(progressCount);
    // And the Projects heading still counts PROJECTS. Only the cards below it
    // thin out.
    expect(await projectsHeaderCount()).toEqual(projectsCount);
    await snap("dashboard-phase-filter.png");

    // Pressing the selected pill again is the undo, and it hands the selection
    // back to All rather than to nothing.
    await clickWhenVisible(pill("in_review"));
    await waitVisible(row(todoId));
    await waitVisible(row(prId));
    expect(await pressedPills()).toEqual(["all"]);

    // Nothing is Done (archived tasks are not listed, and the only seeded PR
    // is open), so this is the empty state. The Todo pill is rendered on a
    // zero too, which is exactly why the count is the thing asserted.
    expect(await pillCount("done")).toEqual(0);
    await clickWhenVisible(pill("done"));
    await waitVisible(EMPTY);
    expect(await textOf(EMPTY)).toEqual("Nothing done");
    expect(await countOf("[data-dashboard-task-id]")).toEqual(0);
    // The cards go with their rows: an empty filter leaves no card behind to
    // look at, which a row-only check would not catch.
    expect(await countOf("[data-dashboard-project-id]")).toEqual(0);
    await snap("dashboard-phase-empty.png");

    await clickWhenVisible(pill("all"));
    await waitVisible(row(prId));
    await waitVisible(row(todoId));
    await waitGone(EMPTY);
  });

  it("shows an age once a task is a day old, and clears it by opening the task", async () => {
    // Two claims, two tasks. The LABEL is seeded in the store, because no
    // fixture can be three days old; the PERSISTENCE is a task nothing has
    // ever opened, so the stamp it is asked for has to travel null -> fresh
    // and cannot be satisfied by a value that was already there.
    //
    // Created first on purpose: `openTask` reloads `tasks` from disk, which
    // would drop the store-only stamp seeded below.
    ageId = await openTask(`${PREFIX}age`, false);
    expect(await diskStamp(ageId)).toBeNull();

    // Three days and a bit, so the label cannot be read as a boundary case:
    // `daysSince` floors whole 24h buckets.
    const threeDaysAgo = new Date(Date.now() - (3 * 24 + 2) * 3_600_000).toISOString();
    await browser.execute(
      (id, iso) => {
        window.__termic!.useApp.setState((s: any) => ({
          tasks: s.tasks.map((w: any) => (w.id === id ? { ...w, last_opened_at: iso } : w)),
        }));
      },
      prId,
      threeDaysAgo,
    );
    await showDashboard();
    // Never opened and never prompted, so the second task is a Todo row while
    // it is here: age and phase are independent halves of the same row.
    await waitRowPhase(ageId, "todo");
    await waitVisible(age(prId));
    expect(await textOf(age(prId))).toEqual("3 days ago");
    await snap("dashboard-task-age.png");

    // Opening the task stamps it, so the label has nothing left to say.
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), prId);
    await showDashboard();
    await waitGone(age(prId));

    // The persistence half has no DOM at all, which is what makes reading the
    // record the right assertion here and the wrong one everywhere above.
    // It runs on the never-opened task, whose record was null a moment ago.
    // Asserting it on the task activated above would prove less: that one was
    // opened when it was created, and Rust holds a stamp younger than
    // TOUCH_MIN_SECS rather than rewriting the file, so a passing check there
    // could be reading the stamp that first activation left.
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), ageId);
    await waitForAgentReady(ageId);

    // Polled, because `task_touch` is deliberately fire-and-forget.
    await waitFreshStamp(ageId, "last_opened_at");
  });

  it("reads a pushed clean branch as In review and a merged one as Done, with no PR", async () => {
    // The PR half is out of the way for this case: everything below is the git
    // rule on its own, which is what a handed-off task looks like on a repo
    // with no forge, or before anybody has opened a PR.
    await browser.execute(() => window.__termic!.usePr.setState({ byTask: {} }));

    const wt = (await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.path ?? null,
      prId,
    )) as string | null;
    if (!wt) throw new Error(`task ${prId} has no worktree path on the record`);
    // Step (b) needs a clean tree, so say so HERE: a dropping left in the
    // worktree by creation would otherwise present as "never reached
    // in_review" with nothing naming the file responsible.
    expect(git("status --porcelain", wt)).toEqual("");

    await showDashboard();
    await forceGit(prId);
    // Started, no commits of its own, no remote branch at all. `ahead` is null
    // rather than 0, and null is not "nothing left to push".
    await waitGitPhase(prId, "in_progress");

    // (a) A commit of its own is not enough on its own: nothing has the work
    // but this machine.
    writeFileSync(path.join(wt, "phase-probe.txt"), "phase probe\n");
    git("add phase-probe.txt", wt);
    git('-c user.email=e2e@termic.dev -c user.name=e2e commit -q -m "e2e phase probe"', wt);
    await forceGit(prId);
    await waitGitPhase(prId, "in_progress");

    // (b) Pushed: own commits, clean tree, and the remote has everything.
    git(`push -q -u origin ${BRANCH}`, wt);
    await forceGit(prId);
    await waitGitPhase(prId, "in_review");
    await snap("dashboard-phase-git-review.png");

    // (c) One untracked file is enough to take it back, and that is the
    // intended reading rather than an oversight: unfinished work in the
    // worktree is unfinished work, whatever the commits say. Round trip, so
    // the rule is proved in both directions rather than as a one-way latch.
    const stray = path.join(wt, "phase-stray.txt");
    writeFileSync(stray, "stray\n");
    await forceGit(prId);
    await waitGitPhase(prId, "in_progress");
    rmSync(stray, { force: true });
    await forceGit(prId);
    await waitGitPhase(prId, "in_review");

    // (d) Merged into the base by fast-forward. The base is resolved from the
    // task's own `base_branch`, which is a LOCAL `main` here (the fixture's
    // refs are shared with every worktree cut from it), so the merge in the
    // fixture checkout is the load-bearing half; pushing `origin/main` on
    // behind it covers a task whose base is stored remote-qualified.
    const base = (await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((w: any) => w.id === id)?.base_branch ?? null,
      prId,
    )) as string | null;
    const head = git("rev-parse --abbrev-ref HEAD", fixture);
    if (head !== "main") git("checkout -q main", fixture);
    try {
      git(`merge --ff-only -q ${BRANCH}`, fixture);
    } catch (e) {
      throw new Error(
        `could not fast-forward main (the task's base is "${base}") onto ${BRANCH} in the ` +
          `fixture: ${(e as Error).message}. The fixture's main moved after the task was cut ` +
          `from it, which is an environment problem, not a phase one.`,
      );
    }
    git("push -q origin main", fixture);
    if (head !== "main") git(`checkout -q ${head}`, fixture);

    await forceGit(prId);
    await waitGitPhase(prId, "done");
    await snap("dashboard-phase-git-done.png");
  });

  // ───────────────────────────── the manual half ─────────────────────────────
  //
  // Everything above is DERIVED: a prompt, a PR snapshot, a branch. This block
  // is the two things a PERSON writes down, and the rule that lets them exist
  // beside derived ones at all (src/lib/taskPhase.ts): a person may set the
  // states the machine cannot see, and a manual state clears itself the moment
  // evidence arrives.
  //
  //   - PLANNED is a goal with no `started_at`. It is not a phase value: the
  //     row still reads `todo`, and the GOAL is what makes it read as planned.
  //   - PARKED is the one hand-set value, and the next prompt into any of the
  //     task's terminals wipes it. The last case here is that claim.
  //
  // Driven through the REAL dialogs and the real sidebar menu wherever there
  // is one, because the wiring is the thing under test: driving
  // `useApp.setTaskParked` from a spec would only prove that the store works,
  // which `src/store/*.test.ts` already does.
  //
  // NESTED inside `dashboard phases` on purpose. Every helper it wants
  // (`row`, `pill`, `waitRowPhase`, `showDashboard`, `focusTaskTerminal`,
  // `seedPr`, `diskField`, `countOf`, `textOf`, `git`, `gitTry`), the
  // `e2e-phase-` name sweep and the capture-and-restore of the fixture's refs
  // are describe-local consts up there, and a sibling block would have to
  // hoist or duplicate all of it. Mocha runs a suite's own tests before its
  // child suites, so the outer teardown still runs last, after this one's.
  describe("goals and parking", () => {
    /** Typed into the New Task dialog's prompt box in BOTH halves of the Start
     *  later case, so the only thing that differs between the two creates is
     *  the checkbox. */
    const INTENT = "Teach the parser about trailing commas.";
    /** The branch for the one worktree task this block cuts. A main checkout
     *  would be the easier fixture and the wrong one: `pollableTasks`
     *  (src/store/pr.ts) skips main checkouts, so a PR seeded onto one is a
     *  state that cannot happen in production. Same call the PR ladder above
     *  makes, for the same reason. */
    const PARK_BRANCH = `${PREFIX}park`;

    let laterId = "";
    let nowId = "";
    let parkedId = "";

    // Every one of these testids is unique app-wide, so they need no dialog
    // scoping. The two placeholder-matched fields are the New Task dialog's
    // own, which carries no testid on either.
    const NAME_FIELD = 'input[placeholder="fix login bug"]';
    const PROMPT_FIELD = 'textarea[placeholder^="Describe the task"]';
    const START_LATER = '[data-testid="new-task-start-later"]';
    const GOAL_FIELD = '[data-testid="task-goal-input"]';
    const GOAL_SAVE = '[data-testid="task-goal-save"]';
    const PARK_REASON = '[data-testid="park-reason-input"]';
    const PARK_ALSO_STOP = '[data-testid="park-also-stop"]';
    const PARK_CONFIRM = '[data-testid="park-confirm"]';

    /** The phase the row's GLYPH is reporting, which is the mark a reader
     *  actually sees. Deliberately not read off `data-task-phase`: that is the
     *  row's own copy, and asserting one against the other is what catches a
     *  glyph that stopped following the phase. */
    const glyphPhase = (id: string) =>
      browser.execute(
        (sel) => (document.querySelector(sel) as HTMLElement | null)?.dataset.phase ?? null,
        `[data-dashboard-task-id="${id}"] [data-testid="task-phase"]`,
      ) as Promise<string | null>;

    /** One row's own copy of a per-row hook. `task-goal` and `task-phase`
     *  are rendered once per dashboard row and are NOT unique, the same trap
     *  `work-badge` has, so every read of one goes through its row. */
    const inRow = (id: string, testid: string) => `${row(id)} [data-testid="${testid}"]`;

    /** Type into a CONTROLLED React field. Assigning `.value` updates the DOM
     *  and leaves the component's state behind; React listens for an `input`
     *  event and compares against the value IT last wrote, so the native
     *  setter has to run first, off the prototype that matches the element. */
    const typeInto = (selector: string, value: string) =>
      browser.execute(
        (sel, v) => {
          const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el) throw new Error(`no field to type into: ${sel}`);
          const proto = el instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        selector,
        value,
      );

    /** A `Checkbox`'s state. It is a styled BUTTON rather than a native input
     *  (src/components/ui/Checkbox.tsx), so `.checked` does not exist and a
     *  click on the wrapping label toggles nothing: `aria-checked` on the
     *  control itself is the only thing that says which way it is set. */
    const ariaChecked = (selector: string) =>
      browser.execute(
        (sel) => (document.querySelector(sel) as HTMLElement | null)?.getAttribute("aria-checked") ?? null,
        selector,
      ) as Promise<string | null>;

    /** A node's `title`, which is where the park reason lives on the row. */
    const titleOf = (selector: string) =>
      browser.execute(
        (sel) => (document.querySelector(sel) as HTMLElement | null)?.getAttribute("title") ?? null,
        selector,
      ) as Promise<string | null>;

    /** Whatever holds focus, named by its testid so the assertion reads as the
     *  claim ("the goal box has focus") rather than as a node comparison. */
    const focusedTestId = () =>
      browser.execute(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        return el.getAttribute("data-testid") ?? `<${el.tagName.toLowerCase()}>`;
      }) as Promise<string | null>;

    /** Press a button by its exact label inside the dialog that HOLDS
     *  `anchor`. Scoped through the anchor rather than a bare
     *  `[role="dialog"]`: dialogs stack, and the app footer has a "Terminal"
     *  button of its own that an unscoped text match would find. */
    const clickDialogButton = async (anchor: string, text: string) => {
      await browser.waitUntil(
        () => browser.execute((a, t) => {
          const dlg = document.querySelector(a)?.closest('[role="dialog"]');
          return [...(dlg?.querySelectorAll("button") ?? [])].some(b => b.textContent?.trim() === t);
        }, anchor, text),
        { timeout: 8_000, timeoutMsg: `the dialog holding ${anchor} never offered a "${text}" button` },
      );
      await browser.execute((a, t) => {
        const dlg = document.querySelector(a)?.closest('[role="dialog"]');
        const btn = [...(dlg?.querySelectorAll("button") ?? [])].find(b => b.textContent?.trim() === t);
        (btn as HTMLElement).click();
      }, anchor, text);
    };

    const openNewTaskDialog = async () => {
      await browser.execute(() => {
        const proj = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
        window.__termic!.useUI.getState().openNewTask(proj.id);
      });
      await waitVisible(NAME_FIELD);
    };

    /**
     * Fill in the New Task dialog for a repo-root fakeagent task and press
     * Create, with `startLater` deciding only the checkbox.
     *
     * Repo-root, not worktree: this half of the feature has nothing to do with
     * branches, and a worktree per case would leave four of them in the shared
     * fixture for the teardown to chase.
     *
     * ORDER MATTERS. The prompt box and the Start later checkbox sit behind
     * the same `canPrompt` guard, so with a remembered "Terminal" selection
     * from an earlier spec neither exists until the agent is picked.
     */
    const createViaDialog = async (name: string, prompt: string, startLater: boolean) => {
      await openNewTaskDialog();
      await clickDialogButton(NAME_FIELD, "Main checkout");
      await clickDialogButton(NAME_FIELD, "FakeAgent");
      await typeInto(NAME_FIELD, name);
      await waitVisible(PROMPT_FIELD);
      await typeInto(PROMPT_FIELD, prompt);
      // Unticked on every open, which is the point of asserting it twice: a
      // "start later" that persisted would quietly stop starting tasks.
      expect(await ariaChecked(START_LATER)).toEqual("false");
      if (startLater) {
        await clickWhenVisible(START_LATER);
        expect(await ariaChecked(START_LATER)).toEqual("true");
      }
      await clickDialogButton(NAME_FIELD, "Create");
      await waitGone(NAME_FIELD);

      let id: string | null = null;
      await browser
        .waitUntil(
          async () => {
            id = (await browser.execute(
              (n) => window.__termic!.useApp.getState().tasks.find((w: any) => w.name === n && !w.archived)?.id ?? null,
              name,
            )) as string | null;
            return !!id;
          },
          { timeout: 20_000, interval: 200 },
        )
        .catch(() => { throw new Error(`the New Task dialog never created a task called ${name}`); });
      return id!;
    };

    /** Open a task's own menu the way a right-click does. The kebab is behind
     *  a hover-only pointer-events flip; the row's contextmenu is not, and it
     *  opens the same menu (the pattern `task.e2e.ts` uses). */
    const openTaskMenu = async (id: string) => {
      await waitVisible(`[data-sidebar-task-id="${id}"]`);
      await browser.execute((i) => {
        const el = document.querySelector(`[data-sidebar-task-id="${i}"]`);
        if (!el) throw new Error(`no sidebar row for task ${i}`);
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      }, id);
      await waitVisible('[role="menu"]');
    };

    /**
     * Open the task menu, press one item by test id, and hand back the LABEL
     * it was carrying. Park and Unpark are one row whose label follows the
     * record, so the label is a claim in its own right.
     *
     * Waits for the menu to go before returning. It has an open animation and
     * no close one (src/components/ui/Dropdown.tsx), so the unmount is
     * synchronous, and the focus case below needs Radix's focus-return to the
     * trigger to have already happened when it reads `document.activeElement`.
     */
    const pickTaskMenuItem = async (id: string, testid: string) => {
      await openTaskMenu(id);
      const item = `[role="menu"] [data-testid="${testid}"]`;
      await waitVisible(item);
      const label = (await browser.execute(
        (sel) => (document.querySelector(sel) as HTMLElement | null)?.textContent?.trim() ?? "",
        item,
      )) as string;
      await browser.execute((sel) => (document.querySelector(sel) as HTMLElement).click(), item);
      await waitGone('[role="menu"]');
      return label;
    };

    /** Which of the goal/park rows the task menu is offering right now. */
    const taskMenuHas = async (id: string, testid: string) => {
      await openTaskMenu(id);
      const present = (await countOf(`[role="menu"] [data-testid="${testid}"]`)) > 0;
      await browser.keys(["Escape"]);
      await waitGone('[role="menu"]');
      return present;
    };

    const diskGoal = (id: string) => diskField(id, "goal") as Promise<string | null>;
    const diskParkedAt = (id: string) => diskField(id, "parked_at") as Promise<string | null>;

    /** Poll one field of the record until it reads what it should. Every write
     *  behind these is deliberately fire-and-forget (the store answers
     *  optimistically and drops the IPC reply), so a single read can be taken
     *  before the file has moved. */
    const waitDisk = async (id: string, field: string, want: string | null) => {
      let held: unknown = "<unread>";
      await browser
        .waitUntil(
          async () => {
            held = await diskField(id, field);
            return held === want;
          },
          { timeout: 10_000, interval: 200 },
        )
        .catch(() => {
          throw new Error(
            `${field} never reached ${JSON.stringify(want)} on disk for ${id} (it holds ${JSON.stringify(held)})`,
          );
        });
    };

    /** Wait for the store to agree the task has started. The DOM claim is the
     *  row's phase and the disk claim is `started_at`; this is neither, it is
     *  the gate that keeps the two from being read mid-delivery. */
    const waitStarted = (id: string) =>
      browser.waitUntil(
        () => browser.execute(
          (i) => !!window.__termic!.useApp.getState().tasks.find((w: any) => w.id === i)?.started_at,
          id,
        ),
        { timeout: 30_000, interval: 200, timeoutMsg: `the prompt never started task ${id}` },
      );

    /** Every phase the rows on screen are rendering. */
    const visiblePhases = () =>
      browser.execute(() =>
        [...document.querySelectorAll("[data-dashboard-task-id]")].map(
          (e) => (e as HTMLElement).dataset.taskPhase ?? null,
        ),
      ) as Promise<Array<string | null>>;

    before(async () => {
      await dismissOverlays();
      // The PR ladder above ends with a snapshot seeded on `prId`; the git
      // case then clears the map. Clear it again rather than assume, since a
      // stale entry would change the Done-outranks-Parked case's answer.
      await browser.execute(() => {
        window.__termic!.usePr.setState({ byTask: {} });
        window.__termic!.useUI.getState().setDashboardPhase(null);
      });
    });

    after(async () => {
      // The tasks first: archiving a worktree task removes its worktree, and
      // git refuses to delete a branch a worktree still has checked out.
      for (const id of [laterId, nowId, parkedId]) {
        if (!id) continue;
        try { await archiveTask(id); } catch { /* already gone */ }
      }
      // Then this block's own branch, on both sides. The outer teardown
      // deletes only its own `BRANCH` by name and then ASSERTS that no
      // `e2e-phase-*` branch survives anywhere, so a branch left here fails
      // there, one screen away from the block that made it.
      try {
        gitTry("worktree prune", fixture);
        gitTry(`push -q origin --delete ${PARK_BRANCH}`, fixture);
        gitTry(`branch -D ${PARK_BRANCH}`, fixture);
      } catch { /* nothing to undo */ }
      try {
        await browser.execute(() => {
          window.__termic!.usePr.setState({ byTask: {} });
          window.__termic!.useUI.getState().setDashboardPhase(null);
        });
        await dismissOverlays();
      } catch { /* the window may be gone */ }
    });

    it("writes the prompt down as a goal and starts nothing when Start later is ticked", async () => {
      laterId = await createViaDialog(`${PREFIX}later`, INTENT, true);
      await showDashboard();
      await waitRowPhase(laterId, "todo");

      // Planned is RENDERED, not derived: the phase is plain `todo` and the
      // goal beside it is what makes the row read as planned.
      await waitVisible(inRow(laterId, "task-goal"));
      expect(await textOf(inRow(laterId, "task-goal"))).toEqual(INTENT);
      expect(await diskGoal(laterId)).toEqual(INTENT);

      // Asserted against a record the SPAWN rewrote, the same way the Todo
      // case above does it: the create still cuts nothing short, the agent
      // still boots, and `spawn_count` reaching 1 on disk is what makes
      // "`started_at` is still null" a statement about a record that moved
      // rather than about a read that happened early.
      await browser.waitUntil(async () => ((await diskSpawns(laterId)) ?? 0) >= 1, {
        timeout: 20_000,
        interval: 200,
        timeoutMsg: `the spawn in ${laterId} was never recorded on disk`,
      });
      expect(await diskStarted(laterId)).toBeNull();
      expect(await rowPhase(laterId)).toEqual("todo");
      await snap("dashboard-phase-planned.png");

      // THE CONTRAST, and the half that makes the first one mean anything:
      // the same text in the same box with the checkbox left alone is
      // delivered, so the task is In progress from birth and carries no goal.
      // Without this, everything above would pass just as well against a
      // build that quietly dropped the prompt.
      nowId = await createViaDialog(`${PREFIX}now`, INTENT, false);
      await waitStarted(nowId);
      await showDashboard();
      await waitRowPhase(nowId, "in_progress");
      await waitFreshStamp(nowId, "started_at");
      expect(await diskGoal(nowId)).toBeNull();
      expect(await countOf(inRow(nowId, "task-goal"))).toEqual(0);
    });

    it("starts a planned task from its own menu, and keeps the goal", async () => {
      // Has to run before anything prompts `laterId`: the row is offered only
      // while there IS a goal and nothing has started (canStartWithGoal in
      // src/lib/taskNotes.ts), so a started task does not show it.
      //
      // Prove the agent chain is live BEFORE picking the row, which is the
      // same rule the skill states for any submit. `seedPromptWhenReady` waits
      // for the default tab's PTY and then for the agent to be ready for
      // input, and gives up SILENTLY if it never gets there, so a cold agent
      // turns into "the prompt never started this task" with nothing naming
      // the reason. That is exactly how this case failed in a full-suite run
      // while passing on its own: by then the window is holding every task
      // this file created, and readiness took longer than the wait below.
      await focusTaskTerminal(laterId);
      await waitForAgentReady(laterId);

      expect(await pickTaskMenuItem(laterId, "task-menu-start-with-goal")).toEqual("Start with goal");
      await waitStarted(laterId);
      await showDashboard();
      await waitRowPhase(laterId, "in_progress");
      await waitFreshStamp(laterId, "started_at");

      // The goal is a record of what the task is FOR, not a queue entry that
      // delivering consumes: it survives the start, on disk and on the row.
      expect(await diskGoal(laterId)).toEqual(INTENT);
      expect(await textOf(inRow(laterId, "task-goal"))).toEqual(INTENT);
      // And the row retires itself, because delivering ends in `markStarted`.
      expect(await taskMenuHas(laterId, "task-menu-start-with-goal")).toBe(false);
    });

    it("parks with a reason, rewrites the reason without moving the stamp, and unparks", async () => {
      const REASON = "Blocked on the API key";
      const REVISED = "Waiting on the acme.com credentials";

      expect(await pickTaskMenuItem(nowId, "task-menu-park")).toEqual("Park task");
      await waitVisible(PARK_REASON);
      await typeInto(PARK_REASON, REASON);
      // "Also stop the task" defaults to ticked and is rendered only while
      // there is something to stop. Untick it: the park case below submits a
      // prompt into this task's terminal, and stopping it here would leave
      // nothing to type into.
      expect(await ariaChecked(PARK_ALSO_STOP)).toEqual("true");
      await clickWhenVisible(PARK_ALSO_STOP);
      expect(await ariaChecked(PARK_ALSO_STOP)).toEqual("false");
      await clickWhenVisible(PARK_CONFIRM);
      await waitGone(PARK_REASON);

      await showDashboard();
      await waitRowPhase(nowId, "parked");
      // The glyph is on EVERY row, so the question is what it SAYS, never
      // whether it is there. Read independently of the row's own
      // `data-task-phase`: if both came from the same attribute the case
      // would prove the row agrees with itself.
      expect(await glyphPhase(nowId)).toEqual("parked");
      // The reason rides in the tooltip rather than on the row, which already
      // truncates a goal and a name.
      expect(await titleOf(inRow(nowId, "task-phase"))).toEqual(`Parked: ${REASON}`);
      await waitDisk(nowId, "park_reason", REASON);
      const stamp = await diskParkedAt(nowId);
      expect(stamp).not.toBeNull();
      await snap("dashboard-phase-parked.png");

      // Re-opening the dialog on an ALREADY PARKED task has its own menu row,
      // because the park row flips to Unpark the moment `parked_at` is set.
      // Without it, the dialog's pre-fill and the Rust path that rewrites the
      // reason while refusing to move the stamp would both be unreachable by
      // hand, which is dead code wearing a test.
      const wasMounted = await browser.execute(
        (id) => window.__termic!.useApp.getState().mountedTasks.has(id), nowId,
      );
      expect(wasMounted).toBe(true);
      expect(await pickTaskMenuItem(nowId, "task-menu-edit-park-reason"))
        .toEqual("Edit park reason\u2026");
      await waitVisible(PARK_REASON);
      expect(
        await browser.execute(
          (sel) => (document.querySelector(sel) as HTMLInputElement).value,
          PARK_REASON,
        ),
      ).toEqual(REASON);
      await typeInto(PARK_REASON, REVISED);
      // No "Also stop" while editing: the note is the whole subject, so the
      // checkbox is not rendered. Its state variable still holds its `true`
      // default underneath, so this asserts the dialog does not act on it.
      expect(await countOf(PARK_ALSO_STOP)).toEqual(0);
      await clickWhenVisible(PARK_CONFIRM);
      await waitGone(PARK_REASON);

      // Saving a reason must not kill the agents. Pinning it because the
      // hidden checkbox made that a real bug, not a hypothetical one.
      expect(
        await browser.execute(
          (id) => window.__termic!.useApp.getState().mountedTasks.has(id), nowId,
        ),
      ).toBe(true);

      await waitDisk(nowId, "park_reason", REVISED);
      // `parked_at` answers "since when", so re-parking must not move it.
      expect(await diskParkedAt(nowId)).toEqual(stamp);
      await showDashboard();
      await browser.waitUntil(async () => (await titleOf(inRow(nowId, "task-phase"))) === `Parked: ${REVISED}`, {
        timeout: 8_000,
        timeoutMsg: "the row's tooltip never picked up the rewritten reason",
      });

      // One row, two labels, following the record. Unpark is immediate: there
      // is nothing to ask, so it opens no dialog.
      expect(await pickTaskMenuItem(nowId, "task-menu-park")).toEqual("Unpark task");
      await showDashboard();
      await waitRowPhase(nowId, "in_progress");
      expect(await glyphPhase(nowId)).toEqual("in_progress");
      await waitDisk(nowId, "parked_at", null);
      await waitDisk(nowId, "park_reason", null);
    });

    it("lifts the park on the next prompt, with nobody touching the menu", async () => {
      // THE claim the whole design rests on: a hand-set state is allowed to
      // exist beside derived ones only because it clears itself on evidence
      // (src/lib/taskPhase.ts). Everything here goes through the real input
      // path, so a park that needed clearing by hand would fail here.
      await pickTaskMenuItem(nowId, "task-menu-park");
      await waitVisible(PARK_REASON);
      await typeInto(PARK_REASON, "Waiting on review");
      await clickWhenVisible(PARK_ALSO_STOP);
      expect(await ariaChecked(PARK_ALSO_STOP)).toEqual("false");
      await clickWhenVisible(PARK_CONFIRM);
      await waitGone(PARK_REASON);

      await showDashboard();
      await waitRowPhase(nowId, "parked");
      expect(await diskParkedAt(nowId)).not.toBeNull();

      // One prompt, submitted through xterm's own input path, and nothing
      // else. No menu, no store call, no second dialog.
      await focusTaskTerminal(nowId);
      await waitForAgentReady(nowId);
      await submitToAgent(nowId, "carry on");

      await showDashboard();
      await waitRowPhase(nowId, "in_progress");
      expect(await glyphPhase(nowId)).toEqual("in_progress");
      // And it un-parked the RECORD, not just this session's copy of it: the
      // reason goes with the stamp, since a reason for a park that is over is
      // a lie on the next read.
      await waitDisk(nowId, "parked_at", null);
      await waitDisk(nowId, "park_reason", null);
    });

    it("reads Done rather than Parked once the work has landed", async () => {
      // Never activated, so nothing spawns and nothing kicks a PR lookup of
      // its own (TerminalPane refreshes `usePr` on an agent spawn), which is
      // what lets the snapshot below be seeded and stay.
      parkedId = await createWorktreeTask(`${PREFIX}park`, PARK_BRANCH, false);
      await showDashboard();
      await waitRowPhase(parkedId, "todo");

      await pickTaskMenuItem(parkedId, "task-menu-park");
      await waitVisible(PARK_REASON);
      // Nothing to stop, so nothing is offered: the checkbox is rendered only
      // for a mounted task, and a permanently visible one that usually does
      // nothing would be worse than none.
      expect(await countOf(PARK_ALSO_STOP)).toEqual(0);
      await typeInto(PARK_REASON, "Superseded by the other branch");
      await clickWhenVisible(PARK_CONFIRM);
      await waitGone(PARK_REASON);
      await showDashboard();
      await waitRowPhase(parkedId, "parked");

      // Parked outranks every live signal below it, including an open PR, and
      // Done outranks Parked: a parked task whose work landed is finished,
      // whatever the user meant when they put it down, and leaving it at
      // Parked would hide a landed branch behind a state nobody revisits.
      await seedPr(parkedId, { ...BASE_PR, state: "merged", head: PARK_BRANCH });
      await waitRowPhase(parkedId, "done");
      expect(await glyphPhase(parkedId)).toEqual("done");
      // Outranked, not wiped. Nothing clears a park except the next prompt,
      // so the record still says the user put this down.
      expect(await diskParkedAt(parkedId)).not.toBeNull();

      // The round trip is what proves the PR did it rather than that the row
      // happened to read Done: take the snapshot away and Parked comes back.
      await browser.execute(() => window.__termic!.usePr.setState({ byTask: {} }));
      await waitRowPhase(parkedId, "parked");
      expect(await glyphPhase(parkedId)).toEqual("parked");
    });

    it("filters the board down to exactly the parked tasks", async () => {
      await showDashboard();
      await waitRowPhase(parkedId, "parked");
      // Parked is LAST, after Done. The first four pills are a task's life in
      // sequence; Parked is a task stepping out of that line, so it sits at
      // the end rather than between In review and Done.
      expect(await pillOrder()).toEqual(["all", "todo", "in_progress", "in_review", "done", "parked"]);

      const parkedCount = await pillCount("parked");
      expect(parkedCount).not.toBeNull();
      expect(parkedCount!).toBeGreaterThanOrEqual(1);

      await clickWhenVisible(pill("parked"));
      await browser.waitUntil(async () => (await pressedPills()).includes("parked"), {
        timeout: 8_000,
        timeoutMsg: "the Parked pill never read as selected",
      });
      await waitVisible(row(parkedId));
      // `nowId` is In progress after the prompt above, so it is the proof that
      // the filter removes rather than that the board happened to be short.
      await waitGone(row(nowId));
      // The pill's number and the board agree, and every row left reads
      // parked: a count that matched while an unrelated row survived would be
      // two bugs cancelling out.
      expect(await countOf("[data-dashboard-task-id]")).toEqual(parkedCount);
      expect([...new Set(await visiblePhases())]).toEqual(["parked"]);
      await snap("dashboard-phase-parked-filter.png");

      await clickWhenVisible(pill("all"));
      await waitVisible(row(nowId));
      expect(await pressedPills()).toEqual(["all"]);
    });

    it("takes focus in both dialogs opened from the task menu, and saves what is typed", async () => {
      // MEASURED, not assumed. Opening a dialog from a Radix dropdown races
      // the menu's own focus teardown, which returns focus to the trigger on
      // close: `Duplicate worktree` in this same menu defers its open into a
      // `requestAnimationFrame` to get out of the way, and `Resume override`
      // does not. Nobody had established which of the two these needed, and
      // an autofocused box that does not have focus is a real bug, so this
      // reads `document.activeElement` and lets it say.
      //
      // `pickTaskMenuItem` waits for the menu to be GONE, so Radix's
      // focus-return has already run by the time the read happens: a check
      // that fired while the menu was still unmounting could pass on a state
      // the user never sees.
      const REWRITTEN = "Teach the parser about trailing commas, then the lexer.";
      // Read rather than assumed, so the claim below is "saving a goal does
      // not MOVE the phase" rather than "the phase is in_progress", which
      // would be a second case's outcome smuggled into this one's assertion.
      await showDashboard();
      const phaseBefore = await rowPhase(laterId);
      expect(phaseBefore).not.toBeNull();

      // THE CONTROL for every focus reading below. With the menu open and no
      // dialog on screen, focus is somewhere in the menu, so a helper that
      // answered "task-goal-input" unconditionally (a stale node, a testid
      // read off the wrong element) would be caught HERE rather than passing
      // the real assertions for the wrong reason.
      await openTaskMenu(laterId);
      expect(await focusedTestId()).not.toEqual("task-goal-input");
      await browser.keys(["Escape"]);
      await waitGone('[role="menu"]');

      // "Edit goal…" rather than "Set a goal…": the one row's label follows
      // whether there is a goal already, the way Park's follows the record.
      expect(await pickTaskMenuItem(laterId, "task-menu-edit-goal")).toEqual("Edit goal…");
      await waitVisible(GOAL_FIELD);
      expect(await focusedTestId()).toEqual("task-goal-input");

      // Saving rewrites the goal and nothing else: a goal is text, not a
      // state, so the task stays exactly where it was in its life.
      await typeInto(GOAL_FIELD, REWRITTEN);
      await clickWhenVisible(GOAL_SAVE);
      await waitGone(GOAL_FIELD);
      await waitDisk(laterId, "goal", REWRITTEN);
      await showDashboard();
      await browser.waitUntil(async () => (await textOf(inRow(laterId, "task-goal"))) === REWRITTEN, {
        timeout: 8_000,
        timeoutMsg: "the row never picked up the rewritten goal",
      });
      expect(await rowPhase(laterId)).toEqual(phaseBefore);

      await pickTaskMenuItem(laterId, "task-menu-park");
      await waitVisible(PARK_REASON);
      expect(await focusedTestId()).toEqual("park-reason-input");
      await clickDialogButton(PARK_REASON, "Cancel");
      await waitGone(PARK_REASON);
      // Cancelling parks nothing, which is the other half of a dialog being
      // wired up correctly.
      expect(await diskParkedAt(laterId)).toBeNull();
      expect(await rowPhase(laterId)).not.toEqual("parked");
    });
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

  /** Member rows as `{ name, mode }`, from the row's own state attributes. */
  const rowModes = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="member-mode-row"]')].map((e) => ({
        name: e.getAttribute("data-member-name"),
        mode: e.getAttribute("data-member-mode"),
      })),
    ) as Promise<Array<{ name: string | null; mode: string | null }>>;

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
      try { localStorage.removeItem("newTaskMemberModes"); } catch { /* fine */ }
      if (id) {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }
    }, projectId);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("seeds every git member row on Worktree when nothing is remembered", async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(
      async (host, alpha, beta) => {
        const t = window.__termic!;
        try {
          localStorage.removeItem("newTaskMemberModes");
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
      { name: "alpha", mode: "worktree" },
      { name: "beta", mode: "worktree" },
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
      { name: "alpha", mode: "worktree" },
      { name: "beta", mode: "repo_root" },
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
  let taskId = "";
  /** The app-wide task-type memory this spec drives; restored in teardown. */
  let savedMode: string | null = null;

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
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    if (taskId) await archiveTask(taskId);
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
    if (tmp) rmSync(tmp, { recursive: true, force: true });
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
    await waitForText("Members (2)");

    await clickWhenVisible('[data-testid="task-type-main"]');
    await waitVisible('[data-testid="members-live-note"]');
    await waitForText("All 2 members run live");
    const rows = await browser.execute(() => document.body.textContent?.includes("Members (2)"));
    expect(rows).toBe(false);
  });

  it("Create opens the live host checkout with every member linked in, no wrapper", async () => {
    await browser.execute(() => {
      const input = document.querySelector(
        '[role="dialog"] input[placeholder="fix login bug"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "e2e-mm-live");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Terminal (shell) is token-free; both clicks scoped to THIS dialog.
    for (const label of ["Terminal", "Create"]) {
      await browser.execute((l) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
          d.textContent?.includes("New multi-repo task in the main checkout"),
        )!;
        const btn = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.trim() === l) as HTMLButtonElement;
        btn.click();
      }, label);
    }

    const task = await browser.waitUntil(
      async () => {
        const t = await browser.execute(() =>
          window.__termic!.useApp.getState().tasks.find((w: any) => w.name === "e2e-mm-live"),
        );
        return t ?? false;
      },
      { timeout: 15_000, timeoutMsg: "the main-checkout multi task never appeared" },
    ) as any;
    taskId = task.id;
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
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "e2e-multi-copy-")));
    // Host: gitignored secrets only the project's own list names.
    seedRepo(path.join(tmp, "host"), {
      ".env": "HOST=1",
      "host-only.txt": "host",
      "README.md": "not copied",
    });
    // alpha declares its own globs in `.termic.yaml` — no override needed.
    seedRepo(path.join(tmp, "alpha"), {
      ".termic.yaml": "version: 1\nscripts:\n  files_to_copy:\n    - \".env*\"\n    - \"secrets\"\n",
      ".env": "ALPHA=1",
      ".env.local": "ALPHA=2",
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
    if (tmp) rmSync(tmp, { recursive: true, force: true });
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
          name: root_path.split("/").pop()!,
          base_branch: "main",
          setup_script: "", run_script: "", archive_script: "",
          files_to_copy,
        });
        const proj = await t.ipc.projectAddMulti(host, name, [
          member(alpha, []),                       // falls back to alpha's .termic.yaml
          member(beta, ["config/local.json"]),     // per-member override
        ], false) as any;
        // The multi-repo project's OWN list — the box that had no reader.
        await t.ipc.projectUpdate({ ...proj, files_to_copy: [".env", "host-only.txt"] });
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
    expect(readFileSync(path.join(created.root, "host-only.txt"), "utf8")).toBe("host");

    // alpha: resolved from its own committed .termic.yaml, directories included.
    const alphaWt = created.members.alpha;
    expect(readFileSync(path.join(alphaWt, ".env"), "utf8")).toBe("ALPHA=1");
    expect(readFileSync(path.join(alphaWt, ".env.local"), "utf8")).toBe("ALPHA=2");
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
    expect(readFileSync(path.join(restored.members.alpha, ".env.local"), "utf8")).toBe("ALPHA=2");
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

  it("names the mode, with its icon, when the project defaults to one", async () => {
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

  it("follows the project to a different mode", async () => {
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
    origin = realpathSync(mkdtempSync(path.join(os.tmpdir(), "e2e-clone-origin-")));
    const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "e2e-clone-work-")));
    // A bare repo with one real commit: an EMPTY remote clones into something
    // indistinguishable from a clone still running, which is the exact case
    // the Add gate cannot resolve on its own.
    execSync(
      `git -C "${work}" init -q `
      + `&& git -C "${work}" -c user.email=e2e@termic.dev -c user.name=alice commit -q --allow-empty -m init `
      + `&& git -C "${work}" clone -q --bare . "${origin}/repo.git"`,
    );
    rmSync(work, { recursive: true, force: true });
    parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "e2e-clone-into-")));
  });

  after(async () => {
    if (addedId) {
      await browser.execute(async (id) => {
        await window.__termic!.invoke("project_remove", { id });
        await window.__termic!.useApp.getState().loadAll();
      }, addedId);
    }
    // Both are this spec's own temp dirs; the clone lands inside `parent`.
    rmSync(origin, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
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
    expect(dest).toBe(`${parent}/repo`);
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
    expect(shown.endsWith("/repo")).toBe(true);
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
          `${parent}/repo`,
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
