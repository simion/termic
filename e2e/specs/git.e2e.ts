import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTask, clickByText, clickMenuItem, clickWhenVisible, createWorktreeTask, dismissOverlays, ensureActiveTask, openRightTab, flushEditorMeasure, openTask, requireTermicApi, snap, waitForAppShell, waitForText, waitForTextGone, waitGone, waitVisible } from "../helpers";

// Git integration is central to termic (every task is a worktree/checkout).
// This guards the Git panel: switching to it shows the working-tree status.
// The seeded fixture-repo has a single commit and no edits, so the state is
// deterministically clean.
describe("git panel", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("shows a clean working tree for the fixture repo", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git");

    // Switch the right panel from "All files" to "Git" (a real click).
    await openRightTab("Git");
    await selectGitView("commit");

    // The Git status is fetched async; the clean-tree copy appears once it
    // resolves. waitForText auto-retries, so no sleep and no flake.
    await waitForText("Working tree is clean");

    await snap("git-panel.png");
  });
});

// P0: the Git panel must reflect real working-tree changes. Modifies README on
// disk, forces a git refresh, and asserts the panel leaves the clean state and
// git status reports the file. Restores README on teardown so the clean-tree
// spec (git-panel) is unaffected.
describe("git dirty tree", () => {
  let taskId!: string;
  let original: string | undefined;

  after(async () => {
    if (taskId && original !== undefined) {
      await browser.execute(
        (id, c) => window.__termic!.ipc.taskFileWrite(id, "README.md", c),
        taskId,
        original,
      );
    }
    // The section-collapse flags are global and outlive the task; leave none
    // behind for the suites after this one. Same for the theme: the contrast
    // case below flips it, and a failure mid-flip would hand every later spec
    // file a light window.
    await browser.execute(() => {
      localStorage.removeItem("gitUnstagedCollapsed");
      localStorage.removeItem("gitStagedCollapsed");
      window.__termic!.usePrefs.getState().setThemeMode("dark");
    });
    if (taskId) await archiveTask(taskId);
  });

  /** WCAG contrast between the chip's ink and its fill, read from COMPUTED
   *  style — the point is what actually renders under the live theme, which
   *  no token-level assertion can answer. */
  const chipContrast = () =>
    browser.execute(() => {
      const chip = document.querySelector(
        '[data-testid="git-file-row"][data-pane="unstaged"] span',
      ) as HTMLElement | null;
      if (!chip) return null;
      const cs = getComputedStyle(chip);
      const lum = (rgb: string) => {
        const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
        const ch = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const a = lum(cs.color), b = lum(cs.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }) as Promise<number | null>;

  const paneCollapsed = (pane: "unstaged" | "staged") =>
    browser.execute((p) => {
      const el = document.querySelector(
        `[data-testid="git-pane-header"][data-pane="${p}"]`,
      );
      return el?.getAttribute("data-collapsed") ?? null;
    }, pane) as Promise<string | null>;

  const rowCount = (pane: "unstaged" | "staged") =>
    browser.execute(
      (p) =>
        document.querySelectorAll(`[data-testid="git-file-row"][data-pane="${p}"]`)
          .length,
      pane,
    ) as Promise<number>;

  const togglePane = async (pane: "unstaged" | "staged") => {
    await browser.execute((p) => {
      const el = document.querySelector(
        `[data-testid="git-pane-header"][data-pane="${p}"]`,
      ) as HTMLElement | null;
      el?.click();
    }, pane);
  };

  it("lists a modified file after the tree changes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git-dirty");
    original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );

    // Open the Commit panel (starts clean).
    await openRightTab("Git");
    await selectGitView("commit");

    // Dirty the tree, then force the panel's git poll to re-fetch.
    await browser.execute(async (id, c) => {
      await window.__termic!.ipc.taskFileWrite(id, "README.md", c + "\nedited by e2e\n");
      window.__termic!.useApp.getState().bumpGitRevision(id);
    }, taskId, original);

    // The clean-tree message goes away...
    await waitForTextGone("Working tree is clean");

    // ...and git status reports README as changed.
    await browser.waitUntil(
      () =>
        browser.execute(async (id) => {
          const st = await window.__termic!.ipc.taskGitStatus(id);
          return JSON.stringify(st).includes("README.md");
        }, taskId),
      { timeout: 10_000, timeoutMsg: "git status never reported README changed" },
    );

    await snap("git-dirty.png");
  });

  // Reported from the light theme: the "modified" chip is a solid fill with a
  // 10.5px letter on it, and light darkens --color-accent for text on cream,
  // which left black ink on it at 4.96:1 and muddy. Asserting the RATIO rather
  // than a colour keeps this true for every theme, including ones not written
  // yet. The bar is 5.5 and not WCAG's 4.5: the reported bug CLEARED 4.5, so a
  // floor there would have watched it ship. Measured today: 6.73 dark (black
  // ink on the terracotta accent), 5.98 light (white on --color-accent-deep).
  it("keeps the status chip readable in both themes", async () => {
    expect(await chipContrast()).toBeGreaterThanOrEqual(5.5);

    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setThemeMode("light"));
    await browser.waitUntil(
      () => browser.execute(() => document.documentElement.classList.contains("light")),
      { timeout: 5_000, timeoutMsg: "the app never switched to the light theme" },
    );
    expect(await chipContrast()).toBeGreaterThanOrEqual(5.5);

    await browser.execute(() =>
      window.__termic!.usePrefs.getState().setThemeMode("dark"));
    await browser.waitUntil(
      () => browser.execute(() => !document.documentElement.classList.contains("light")),
      { timeout: 5_000, timeoutMsg: "the app never switched back to dark" },
    );
  });

  it("opens a diff tab for the changed file", async () => {
    // README is dirty from the previous case; open its unstaged diff.
    await browser.execute((id) => {
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "diff",
        path: "README.md",
        title: "README.md",
        scope: "unstaged",
      });
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "diff" && t.path === "README.md",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "diff tab never opened" },
    );
  });

  // GH #266: a diff tab must not keep showing content the agent has since
  // rewritten. It deliberately does NOT live-update - the content moving
  // under a reader mid-review is worse than it being old - so the contract
  // is: say it is out of date, and re-read when asked.
  it("flags an open diff as stale once the file changes underneath it", async () => {
    const dirty = await browser.execute((id) =>
      (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id))!.path as string, taskId);
    // Wait for the pane to have actually READ the file: staleness is a
    // fingerprint comparison, so before the first read there is nothing to
    // compare against and a bump is correctly ignored.
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector('[data-testid="diff-pane"]')?.getAttribute("data-diff-loaded") === "1"),
      { timeoutMsg: "the diff never finished loading" });
    // The tab from the previous case is open on README.md.
    writeFileSync(path.join(dirty, "README.md"), `# changed by an agent ${Date.now()}\n`);
    // `fsRevision` is the "files may have changed" tick an agent bumps when
    // it settles; driving it directly is what a settling agent would do.
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    await waitVisible('[data-testid="diff-stale-banner"]');

    // Refresh clears it, and the tab is re-read rather than reopened: the
    // nonce is what the pane watches.
    const before = await browser.execute((id) =>
      ((window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "diff") as any)?.reloadNonce ?? 0, taskId);
    await clickWhenVisible('[data-testid="diff-stale-refresh"]');
    await browser.waitUntil(async () => {
      const after = await browser.execute((id) =>
        ((window.__termic!.useApp.getState().tabs[id] ?? [])
          .find((t: any) => t.type === "diff") as any)?.reloadNonce ?? 0, taskId);
      return (after as number) > (before as number);
    }, { timeoutMsg: "Refresh did not ask the pane to re-read" });
    await waitGone('[data-testid="diff-stale-banner"]', 8_000);
  });

  it("re-reads an already-open diff when the same file is opened again", async () => {
    // "At minimum, make re-clicking the file in the Git panel reload the
    // already-open tab instead of just focusing it" - the tab exists, so this
    // is the branch that used to return the list untouched.
    const nonceOf = () => browser.execute((id) =>
      ((window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "diff" && t.path === "README.md") as any)?.reloadNonce ?? 0, taskId);
    const before = await nonceOf() as number;
    await browser.execute((id) => {
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "diff", path: "README.md", title: "README.md", scope: "unstaged",
      });
    }, taskId);
    await browser.waitUntil(async () => (await nonceOf() as number) > before,
      { timeoutMsg: "re-opening the same diff did not re-read it" });
  });

  it("collapses the Unstaged section to its header", async () => {
    // The panel's 4s git poll is skipped while the window is unfocused, and a
    // parallel suite run leaves it unfocused. Drive the fetch instead of
    // waiting for a tick that may never come.
    await browser.execute((id) => {
      window.__termic!.useApp.getState().bumpGitRevision(id);
    }, taskId);
    await browser.waitUntil(async () => (await rowCount("unstaged")) > 0, {
      timeout: 15_000,
      timeoutMsg: "the unstaged section never listed a file",
    });

    await togglePane("unstaged");

    await browser.waitUntil(async () => (await rowCount("unstaged")) === 0, {
      timeout: 4_000,
      timeoutMsg: "the unstaged rows survived the collapse",
    });
    expect(await paneCollapsed("unstaged")).toBe("true");
    await snap("git-pane-collapsed.png");
  });

  it("expands the Unstaged section again", async () => {
    await togglePane("unstaged");

    await browser.waitUntil(async () => (await rowCount("unstaged")) > 0, {
      timeout: 4_000,
      timeoutMsg: "the unstaged rows never came back",
    });
    expect(await paneCollapsed("unstaged")).toBe("false");
  });

  it("remembers the Staged section state in localStorage", async () => {
    await togglePane("staged");
    await browser.waitUntil(
      async () => (await paneCollapsed("staged")) === "true",
      { timeout: 4_000, timeoutMsg: "the staged section never collapsed" },
    );
    expect(
      await browser.execute(() => localStorage.getItem("gitStagedCollapsed")),
    ).toBe("1");

    await togglePane("staged");
    await browser.waitUntil(
      async () => (await paneCollapsed("staged")) === "false",
      { timeout: 4_000, timeoutMsg: "the staged section never expanded" },
    );
    expect(
      await browser.execute(() => localStorage.getItem("gitStagedCollapsed")),
    ).toBe("0");
  });
});

// A diff is not always the right reader for a changed file. A doc added in
// one commit renders as an unbroken wall of `+`, and a markdown file loses
// its preview entirely - so every row offers the file itself as well as its
// diff, through the context menu and an ⌥-click fast path.
describe("git open whole file", () => {
  let taskId!: string;
  /** Working tree this spec dirties. Captured at describe scope so teardown
   *  can put it back after a throw ANYWHERE in the body, not only after the
   *  happy path: the deletion below is staged, and the next describe in this
   *  file makes a commit, which would otherwise commit it. */
  let root = "";
  /** Untracked file this spec adds. The fixture seed self-heals TRACKED
   *  paths and deliberately leaves untracked ones alone, so this is ours to
   *  remove or the NEXT run boots on a dirty tree (see the e2e skill). */
  let addedDoc = "";

  after(async () => {
    if (addedDoc) rmSync(addedDoc, { force: true });
    // Idempotent and correct whether or not the deletion was ever staged:
    // restores index and worktree from HEAD in one step, and is a no-op if
    // the body threw before touching README at all.
    if (root) {
      try { execSync("git checkout -q HEAD -- README.md", { cwd: root }); } catch { /* nothing to restore */ }
    }
    if (taskId) await archiveTask(taskId);
  });

  /** Dispatched, not driven: a WebDriver right-click does not reach Radix's
   *  onContextMenu in this WKWebView, so the spec goes in through the real
   *  trigger the way files.e2e.ts does. */
  const openRowMenu = async (testid: string, rel: string) => {
    // Tag whatever is already on screen, so the wait below can only be
    // satisfied by a NEW menu. Waiting for menus to DISAPPEAR does not work
    // here: helpers' dismissOverlays neutralises a stale Radix menu rather
    // than removing it (detaching a React-managed node tears down the root),
    // so "no menu in the DOM" is a state the app never reliably reaches.
    await browser.execute(() => {
      document.querySelectorAll('[role="menu"]').forEach(m => m.setAttribute("data-e2e-stale", "1"));
    });
    await browser.keys(["Escape"]);
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`no row ${sel}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2,
        clientX: r.left + 10, clientY: r.top + 10,
      }));
    }, `[data-testid="${testid}"][data-path="${rel}"]`);
    await browser.waitUntil(async () => (await menuItems()).length > 0,
      { timeout: 8_000, timeoutMsg: `the context menu never opened for ${rel}` });
  };

  /** Scoped to the menu holding the path items, never a bare [role="menu"]:
   *  menus stack and a closing one can linger. Read from innerText, because
   *  ContextMenuItem leaves `role` undefined for plain items. */
  const menuItems = () => browser.execute(() => {
    const menu = [...document.querySelectorAll('[role="menu"]:not([data-e2e-stale])')]
      .find(m => (m as HTMLElement).innerText.includes("Copy path")) as HTMLElement | undefined;
    if (!menu) return [] as string[];
    return menu.innerText.split("\n").map(t => t.trim()).filter(Boolean);
  }) as Promise<string[]>;

  /** Local, NOT the shared helper: that one queries `[role="menuitem"]`, and
   *  ContextMenuItem leaves `role` undefined for plain items, so the ARIA
   *  selector matches nothing here (files.e2e.ts measured the same). */
  const clickItem = (label: string) => browser.execute((text) => {
    const menu = [...document.querySelectorAll('[role="menu"]:not([data-e2e-stale])')]
      .find(m => (m as HTMLElement).innerText.includes("Copy path")) as HTMLElement | undefined;
    if (!menu) throw new Error("the file context menu is not open");
    // Deepest node whose own text is exactly the label, so a wrapper that
    // merely contains it is never clicked instead.
    const item = [...menu.querySelectorAll("*")].reverse()
      .find(i => (i as HTMLElement).innerText?.trim() === text) as HTMLElement | undefined;
    if (!item) throw new Error(`no menu item "${text}"`);
    item.click();
  }, label);

  /** Every tab open on the task, as `${type}:${path}` - the assertion is
   *  about which READER opened, so the type is the whole point. */
  const openTabs = () => browser.execute((id) =>
    (window.__termic!.useApp.getState().tabs[id] ?? [])
      .filter((t: any) => t.type === "edit" || t.type === "diff")
      .map((t: any) => `${t.type}:${t.path}`), taskId) as Promise<string[]>;

  const waitForTab = async (want: string, msg: string) => {
    try {
      await browser.waitUntil(async () => (await openTabs()).includes(want), { timeout: 8_000 });
    } catch {
      // Name what DID open: "no edit tab" is a much slower thing to debug
      // than "a diff opened instead".
      throw new Error(`${msg} (open: ${JSON.stringify(await openTabs())})`);
    }
  };

  it("lists a new doc and a deleted file as changes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git-openfile");

    root = await browser.execute((id) =>
      (window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id))!.path as string, taskId) as string;
    // A NEW markdown file is the case that motivates the feature: its diff
    // is every line prefixed `+`, which is the worst way to read a spec.
    addedDoc = path.join(root, "OPENFILE-NOTES.md");
    writeFileSync(addedDoc, "# Notes\n\nA doc that reads better as itself.\n");
    // A DELETION is the negative case: there is no working-tree file, so
    // there is nothing to open and the item must not be offered.
    //
    // Deleted in the WORKING TREE, not staged (`git rm`): a staged row
    // renders in the Staged pane, and the preceding describe toggles that
    // pane's collapse state, so this spec would depend on which way it was
    // left. Both of this spec's files now live in Unstaged.
    rmSync(path.join(root, "README.md"), { force: true });

    await openRightTab("Git");
    await selectGitView("commit");
    // A collapsed pane renders no rows, and the collapse flag is global and
    // outlives the describe that set it, so ask rather than assume.
    await browser.execute(() => {
      const h = document.querySelector('[data-testid="git-pane-header"][data-pane="unstaged"]') as HTMLElement | null;
      if (h?.getAttribute("data-collapsed") === "true") h.click();
    });
    await browser.execute((id) => window.__termic!.useApp.getState().bumpGitRevision(id), taskId);
    await waitVisible('[data-testid="git-file-row"][data-path="OPENFILE-NOTES.md"]');
    await waitVisible('[data-testid="git-file-row"][data-path="README.md"]');
  });

  it("offers Open file on a changed row, and opens the file rather than its diff", async () => {
    await openRowMenu("git-file-row", "OPENFILE-NOTES.md");
    expect(await menuItems()).toContain("Open file");

    await clickItem("Open file");
    await waitForTab("edit:OPENFILE-NOTES.md", "Open file did not open an editor tab");

    // The point of the feature: this is NOT the diff reader. Nothing opened
    // a diff for the same path.
    expect(await openTabs()).not.toContain("diff:OPENFILE-NOTES.md");
    await snap("git-open-whole-file.png");
  });

  it("keeps the row selected so the list does not lose your place", async () => {
    // A state attribute, not the themed border class: the promise is "the
    // row is still the selected one", and a class string is not that.
    const selected = await browser.execute(() =>
      document.querySelector('[data-testid="git-file-row"][data-path="OPENFILE-NOTES.md"]')
        ?.getAttribute("data-selected"));
    expect(selected).toBe("true");
  });

  it("does not offer Open file for a deleted file", async () => {
    await openRowMenu("git-file-row", "README.md");
    const items = await menuItems();
    // The eye is hidden on a deletion for the same reason (no working-tree
    // content to anchor to); Open file follows it, rather than opening an
    // editor on a path that is gone.
    expect(items).not.toContain("Open file");
    // Proves the menu really is this row's and really opened, so the
    // assertion above is a real absence rather than an empty read. The path
    // items are split in two ("Copy path" alone is not an entry), and the
    // git actions name the pane the deletion is staged in.
    expect(items).toContain("Copy path (relative)");
    expect(items).toContain("Discard changes");
    // The next case clicks a row button for real, and an open menu is
    // hit-tested over it. dismissOverlays neutralises the menu (it cannot
    // remove it - see openRowMenu) which is exactly what a real click needs.
    await dismissOverlays();
  });

  it("puts an Open file button on the row itself", async () => {
    // The affordance the maintainer went looking for first: the menu and the
    // modifier are both invisible at rest, so the row carries the action too.
    const btn = '[data-testid="git-file-row"][data-path="OPENFILE-NOTES.md"] button[aria-label="Open file"]';
    await waitVisible(btn);

    // Drive it from a diff, so "it opened the file" is a real transition
    // rather than something a previous case already left on screen.
    await browser.execute((id) => {
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "diff", path: "OPENFILE-NOTES.md", title: "Δ OPENFILE-NOTES.md", scope: "unstaged",
      });
    }, taskId);
    await waitForTab("diff:OPENFILE-NOTES.md", "the diff never opened to switch away from");

    await clickWhenVisible(btn);
    await waitForTab("edit:OPENFILE-NOTES.md", "the row button did not open the file");
  });

  it("does not stage the file when its row buttons are double-clicked", async () => {
    // The row's dblclick stages, so a read-only button that stops only
    // `click` mutates the index on the second one. Asserted through the
    // real staged/unstaged panes, which is what the user would see.
    const paneOf = (rel: string) => browser.execute((r) => {
      const row = document.querySelector(`[data-testid="git-file-row"][data-path="${r}"]`);
      return row?.getAttribute("data-pane") ?? null;
    }, rel);
    const dblClick = (sel: string) => browser.execute((s2) => {
      const el = document.querySelector(s2) as HTMLElement | null;
      if (!el) throw new Error(`no element ${s2}`);
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    }, sel);

    const row = '[data-testid="git-file-row"][data-path="OPENFILE-NOTES.md"]';
    expect(await paneOf("OPENFILE-NOTES.md")).toBe("unstaged");

    await dblClick(`${row} button[aria-label="Open file"]`);
    expect(await paneOf("OPENFILE-NOTES.md")).toBe("unstaged");

    // The eye had the same hole before this change, so it is pinned too.
    await dblClick(`${row} button[aria-pressed]`);
    expect(await paneOf("OPENFILE-NOTES.md")).toBe("unstaged");
  });

  it("has no Open file button on a deleted row", async () => {
    const gone = await browser.execute(() =>
      document.querySelectorAll('[data-testid="git-file-row"][data-path="README.md"] button[aria-label="Open file"]').length);
    expect(gone).toBe(0);
  });

  it("⌥-click opens the file, plain click still opens the diff", async () => {
    const clickRow = (rel: string, alt: boolean) => browser.execute((sel, withAlt) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`no row ${sel}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, altKey: withAlt,
        clientX: r.left + 10, clientY: r.top + 10,
      }));
    }, `[data-testid="git-file-row"][data-path="${rel}"]`, alt);

    // Plain click: the diff, which is what this panel is for.
    await clickRow("OPENFILE-NOTES.md", false);
    await waitForTab("diff:OPENFILE-NOTES.md", "a plain click did not open the diff");

    // ⌥-click: the file. It recycles the same preview slot, so the diff
    // gives way to the editor rather than both piling up.
    await clickRow("OPENFILE-NOTES.md", true);
    await waitForTab("edit:OPENFILE-NOTES.md", "⌥-click did not open the file");
    await browser.waitUntil(async () => !(await openTabs()).includes("diff:OPENFILE-NOTES.md"),
      { timeoutMsg: "the diff tab was left behind instead of being recycled" });
  });

  it("offers the same reading from the Compare tab", async () => {
    await selectGitView("compare");
    await waitVisible('[data-testid="compare-file-row"][data-path="OPENFILE-NOTES.md"]');

    await openRowMenu("compare-file-row", "OPENFILE-NOTES.md");
    expect(await menuItems()).toContain("Open file");
    await clickItem("Open file");
    await waitForTab("edit:OPENFILE-NOTES.md", "Compare's Open file did not open an editor tab");
    await selectGitView("commit");
  });

  // The happy-path restore. `after()` repeats it as the safety net, because
  // this `it` never runs if an earlier one throws.
  it("restores the fixture tree", async () => {
    execSync("git checkout -q HEAD -- README.md", { cwd: root });
    rmSync(addedDoc, { force: true });
    addedDoc = "";
    await browser.execute((id) => window.__termic!.useApp.getState().bumpGitRevision(id), taskId);
    await waitGone('[data-testid="git-file-row"][data-path="OPENFILE-NOTES.md"]', 8_000);
  });
});

// Tasks here open the repo ROOT, so every case below edits this one working
// tree and has to put it back.
/** Select one of the Git tab's sub-tabs. The choice is PERSISTED (a review
 *  outlives a task switch and a relaunch), and the e2e profile is reused
 *  between runs, so a spec that needs the staging view has to ask for it
 *  rather than assume the panel opens there. */
async function selectGitView(view: "commit" | "compare" | "history"): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((v) => {
      const el = document.querySelector(`[data-testid="git-view-${v}"]`) as HTMLElement | null;
      if (!el) return false;
      el.click();
      return true;
    }, view),
    { timeout: 10_000, timeoutMsg: `the Git tab never offered the ${view} sub-tab` },
  );
}

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

// GH #199: committed work used to vanish from termic the moment the tree went
// clean, sending people to VS Code or Fork to see what an agent had just done.
// The Graph section of the Commit tab is that view: real commits, each expandable into
// the files it touched, each file opening a diff of THAT revision.
describe("git history tab", () => {
  let taskId!: string;
  /** Subject of the commit this spec makes, unique per run so a leftover
   *  fixture commit from an earlier run can't satisfy the assertions. */
  // Stamped, and so is the FILE. This spec used to commit a fixed
  // `history-probe.txt` containing a fixed "probe\n": on the second run
  // against a fixture repo that still had the first run's commit, `git add`
  // staged nothing, `git commit` exited non-zero, and the whole describe fell
  // over on an execSync throw. It also asserts the file is an ADD in this
  // commit, which is only true while the name is new.
  const stamp = Date.now();
  const subject = `e2e history probe ${stamp}`;
  const probe = `history-probe-${stamp}.txt`;
  /** The fixture's own branch, read rather than assumed: the picker lists it
   *  by name and `main` vs `master` depends on the seeding git's defaults. */
  const BRANCH = execSync(`git -C "${fixture}" branch --show-current`).toString().trim();

  after(async () => {
    if (taskId) await archiveTask(taskId);
    // The commit + its file are ours: drop them so the next run's clean-tree
    // and history specs start from the seeded fixture again.
    try {
      // Only ours: a reset that fired blind would throw away whatever the
      // fixture legitimately holds if this spec never got as far as committing.
      const head = execSync(`git -C "${fixture}" log -1 --pretty=%s`).toString().trim();
      if (head === subject) execSync(`git -C "${fixture}" reset --hard HEAD~1`, { stdio: "ignore" });
    } catch { /* the commit never landed */ }
  });

  /** Open the Git tab's History sub-tab. The graph was its own top-level tab
   *  (GH #199), then a collapsible section at the foot of the staging view;
   *  it is one of three sub-tabs now (Commit / Compare / History), full
   *  height, so reaching it is the tab plus one sub-tab click. */
  const openGraph = async () => {
    await openRightTab("Git");
    await selectGitView("history");
    await waitVisible('[data-testid="history-panel"]');
  };

  /** Subjects of the commit rows currently rendered, newest first. */
  const commitSubjects = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="history-subject"]')].map(
        (e) => (e as HTMLElement).innerText,
      ),
    ) as Promise<string[]>;

  /** The same, but only once the graph has finished fetching.
   *
   *  Changing the scope does not clear the list: `HistoryPanel` calls
   *  `setCommits` on success only, so the rows of the scope you just LEFT stay
   *  on screen until the new page lands. Reading between those two moments
   *  gives you the previous scope's commits, and they look exactly like a real
   *  answer. On this Mac the fetch lands before the next line runs, so the gap
   *  does not exist; on the CI runner it does, and this file failed there
   *  three releases running while passing everywhere else.
   *
   *  Hence the panel's own `data-loading`, not a count that stopped moving: a
   *  list is "stable" for the whole duration of a slow fetch, so quiet is not
   *  evidence of anything. */
  const settledSubjects = async (): Promise<string[]> => {
    await browser.waitUntil(
      () => browser.execute(() =>
        document.querySelector('[data-testid="history-panel"]')
          ?.getAttribute("data-loading") === "false"),
      { timeout: 15_000, timeoutMsg: "the commit graph never finished loading" },
    );
    return commitSubjects();
  };

  it("lists real commits, newest first", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-history");

    // A commit made OUTSIDE the app: the tab must read the repo, not some
    // in-app cache of what termic itself committed.
    writeFileSync(path.join(fixture, probe), "probe\n");
    execSync(`git -C "${fixture}" add "${probe}"`);
    execSync(`git -C "${fixture}" commit -q -m "${subject}"`);

    await openGraph();

    await browser.waitUntil(
      async () => (await commitSubjects())[0] === subject,
      { timeout: 15_000, timeoutMsg: "the new commit never appeared at the top of the Graph" },
    );
    // The seeded repo's own first commit is under it — this is a list, not a
    // single row.
    expect((await commitSubjects()).length).toBeGreaterThan(1);
    // Every row draws its lane gutter.
    const gutters = await browser.execute(() =>
      document.querySelectorAll('[data-testid="history-commit"] svg').length);
    expect(gutters).toBeGreaterThan(1);
    // The tip carries its branch as a ref chip.
    const refs = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="history-ref"]')].map(e => (e as HTMLElement).innerText));
    expect(refs.join(" ")).toContain("main");

    await snap("git-history.png");
  });

  it("expands a commit into the files it touched", async () => {
    await browser.execute(() => {
      const row = document.querySelector('[data-testid="history-commit-row"]') as HTMLElement;
      row.click();
    });
    await waitVisible('[data-testid="history-commit-detail"]');
    await browser.waitUntil(
      () =>
        // `probe` is PASSED, never closed over: this callback is serialised
        // and evaluated in the webview, where a Node-side variable does not
        // exist ("Can't find variable: probe").
        browser.execute((file) =>
          [...document.querySelectorAll('[data-testid="history-file-row"]')].some(
            (e) => e.getAttribute("data-path") === file,
          ), probe,
        ),
      { timeout: 10_000, timeoutMsg: "the commit's file list never appeared" },
    );
    // The expanded row shows the short sha, so the user can tell which
    // revision they are looking at.
    const detail = await browser.execute(() =>
      (document.querySelector('[data-testid="history-commit-detail"]') as HTMLElement).innerText);
    expect(detail).toMatch(/[0-9a-f]{7}/);
    await snap("git-history-expanded.png");
  });

  it("opens a file's diff AT that commit, not the working tree", async () => {
    // Dirty the file in the working tree first: a commit diff that leaked the
    // worktree side would show this text.
    writeFileSync(path.join(fixture, probe), "probe\nWORKTREE ONLY\n");

    await browser.execute((file) => {
      const f = [...document.querySelectorAll('[data-testid="history-file-row"]')].find(
        (e) => e.getAttribute("data-path") === file,
      ) as HTMLElement;
      f.click();
    }, probe);

    // The tab carries the commit scope...
    const scope = await browser.waitUntil(
      async () =>
        browser.execute((id, file) => {
          const tab = (window.__termic!.useApp.getState().tabs[id] ?? []).find(
            (t: any) => t.type === "diff" && t.path === file,
          );
          return tab?.scope ?? null;
        }, taskId, probe),
      { timeout: 10_000, timeoutMsg: "no diff tab opened for the commit's file" },
    ) as unknown as string;
    expect(scope).toMatch(/^commit:[0-9a-f]{7,}$/);

    // ...and the backend resolves that scope to the two REVISIONS: the file is
    // an add in this commit (no left side), and the right side is the
    // committed content, never the dirtied working tree.
    const sides = await browser.execute(
      (id, sc, file) => window.__termic!.ipc.taskFileDiffSides(id, file, sc),
      taskId,
      scope,
      probe,
    );
    expect(sides.original_exists).toBe(false);
    expect(sides.modified).toBe("probe\n");
    expect(sides.modified).not.toContain("WORKTREE ONLY");

    // Restore the working tree for the specs that follow.
    writeFileSync(path.join(fixture, probe), "probe\n");
  });

  it("keeps the review affordances off a historical diff", async () => {
    // The commit chip identifies the revision; "Mark as viewed" and "Comment"
    // (both of which address the LIVE file) must not be offered.
    await waitVisible('[data-testid="diff-commit-chip"]');
    const header = await browser.execute(() =>
      (document.querySelector('[data-testid="diff-commit-chip"]')!.parentElement as HTMLElement).innerText);
    expect(header).not.toContain("Mark as viewed");
    expect(header).not.toContain("Comment");
  });

  const trigger = '[data-testid="history-scope"]';
  const scope = () =>
    browser.execute((sel) => {
      const el = document.querySelector(sel);
      return { all: el?.getAttribute("data-all"), picked: el?.getAttribute("data-picked") };
    }, trigger);
  /** Radix opens on pointerdown, and WebKit's WebDriver click emits no
   *  pointer events at all (verified: a wdio click leaves aria-expanded
   *  false, a dispatched pointerdown/up pair flips it to true). So the pair
   *  is the only thing that opens this menu. NO trailing `el.click()`: on
   *  this trigger it toggles the menu straight back shut. */
  const openMenu = async () => {
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }, trigger);
    await waitVisible('[data-testid="history-scope-row"]');
  };
  /** Click a row in the open picker by the ref name it carries. The menu
   *  portals in asynchronously, so wait for the row rather than assuming. */
  const pick = async (name: string) => {
    await browser.waitUntil(
      async () => browser.execute((n) =>
        document.querySelector(`[data-testid="history-scope-row"][data-ref="${n}"]`) !== null, name),
      { timeout: 5_000, timeoutMsg: `no picker row for ${name}` },
    );
    await browser.execute((n) => {
      (document.querySelector(`[data-testid="history-scope-row"][data-ref="${n}"]`) as HTMLElement).click();
    }, name);
  };

  it("scopes the graph from the ref picker: Auto, All, and a named branch", async () => {
    await openGraph();

    // Auto is the default: HEAD alone, nothing picked.
    expect(await scope()).toEqual({ all: "false", picked: "0" });

    await openMenu();
    // All is a complete answer on its own, so it closes the menu.
    await pick("All");
    await browser.waitUntil(async () => (await scope()).all === "true",
      { timeout: 5_000, timeoutMsg: "All never took effect" });
    // --all must not empty the graph (the fixture has one branch, so the
    // contents match Auto; what matters is that the refetch returned rows).
    await browser.waitUntil(async () => (await commitSubjects()).length > 1,
      { timeout: 10_000, timeoutMsg: "the all-refs view came back empty" });

    // A named branch is a different scope again, and it is a MULTI-select, so
    // the menu STAYS open and the count is what changes.
    await openMenu();
    await pick(BRANCH);
    await browser.waitUntil(async () => {
      const s = await scope();
      return s.all === "false" && s.picked === "1";
    }, { timeout: 5_000, timeoutMsg: "picking a branch never registered" });
    await browser.waitUntil(async () => (await commitSubjects()).length > 1,
      { timeout: 10_000, timeoutMsg: "the picked-branch view came back empty" });

    // Unticking the last ref lands back on Auto, not on an empty graph. No
    // reopen needed: a ref row leaves the menu up, which is the point.
    await pick(BRANCH);
    await browser.waitUntil(async () => {
      const s = await scope();
      return s.all === "false" && s.picked === "0";
    }, { timeout: 5_000, timeoutMsg: "unticking the last ref never returned to Auto" });
    await browser.keys(["Escape"]);
  });

  it("collapses merged branches with First parent only", async () => {
    // The confusion it answers: picking one branch still drew a lane per
    // merged branch, because those commits ARE its ancestors. This is not a
    // fourth scope, it is how much of the topology to walk, so it stacks on
    // whatever scope is active and the menu stays open.
    await openGraph();
    // SETTLED, not sampled. The case before this one leaves the picker on Auto
    // and waits only for the scope ATTRIBUTES to say so, so the refetch back
    // to Auto can still be in flight here: an unsettled read returns the
    // all-refs list it was showing a moment ago, which on a machine with a
    // dozen branches from earlier specs is much longer than Auto's. `before`
    // is then a number the graph will never return to, and the last wait in
    // this case times out on a restore that did happen.
    const before = (await settledSubjects()).length;
    await openMenu();
    await pick("First parent only");
    const firstParent = (await settledSubjects()).length;
    expect(firstParent).toBeGreaterThan(0);
    // The fixture may have no merges, in which case the two walks agree; what
    // must never happen is the option emptying the graph or growing it.
    expect(firstParent).toBeLessThanOrEqual(before);
    await pick("First parent only");
    const restored = (await settledSubjects()).length;
    // Thrown with the NUMBERS in it. "did not restore the walk" is what this
    // failure said for three releases, and a bare count mismatch is exactly
    // the case where knowing which of the two moved is the whole diagnosis.
    if (restored !== before) {
      throw new Error(
        `first-parent off restored ${restored} rows, not the ${before} it started with ` +
        `(first-parent showed ${firstParent})`);
    }
    await browser.keys(["Escape"]);
  });

  it("searches commit messages across the branch, not just the loaded rows", async () => {
    await openGraph();
    const box = await $('input[placeholder="Search messages"]');
    await box.setValue(subject.slice(0, 12));
    await browser.waitUntil(
      async () => {
        const s = await commitSubjects();
        return s.length > 0 && s.every(t => t.includes("e2e history probe"));
      },
      { timeout: 10_000, timeoutMsg: "the message search never narrowed the graph" },
    );
    // A query nothing matches is an empty graph with an explanation, not the
    // unfiltered list and not an error (the box takes literal text, so an
    // unbalanced bracket is a query with no hits).
    await box.setValue("[no-such-commit");
    await browser.waitUntil(
      async () => (await commitSubjects()).length === 0,
      { timeout: 10_000, timeoutMsg: "a no-match search still listed commits" },
    );
    await box.setValue("");
    await browser.waitUntil(
      async () => (await commitSubjects()).length > 1,
      { timeout: 10_000, timeoutMsg: "clearing the search did not restore the graph" },
    );
  });

  it("indents a commit's subject to its own lane", async () => {
    await openGraph();
    // The graph reads as VS Code's does: a row's text starts just past ITS
    // dot, so a branch's rows are a visibly indented run. Rows on the same
    // lane share an offset; a row on a deeper lane starts further right.
    const offsets = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="history-subject"]')]
        .slice(0, 12)
        .map(e => Math.round((e as HTMLElement).getBoundingClientRect().left)));
    expect(offsets.length).toBeGreaterThan(1);
    // Every row is inset past the gutter's first lane, never at 0.
    expect(Math.min(...offsets)).toBeGreaterThan(0);
  });
});

// P0: the Git tab's Compare mode (issue #208). The complaint it answers is
// that work an agent COMMITTED was invisible: the staging view shows the
// working tree only, so a task split across several commits read as an empty
// panel. These cases
// pin the one thing that must be true — committed, uncommitted and untracked
// work all appear in ONE list against a chosen ref — plus the merge-base
// semantics, the review flow that hangs off it, and the base picker.
//
// e2e tasks are REPO-ROOT tasks (`openTask` → `taskOpenRepo`), so the task's
// own `base_branch` is the branch it is already sitting on. That is why the
// spec pins its own `e2e-compare-base` at the pre-commit HEAD: comparing
// against a ref that genuinely predates the commit is the whole scenario, and
// a repo-root task's default base cannot supply one.
describe("git compare mode", () => {
  let taskId!: string;
  let headSha = "";
  /** A ref parked at the pre-commit HEAD. Comparing against it is what makes
   *  committed work visible, which is the point of the tab. */
  const baseBranch = "e2e-compare-base";
  /** Unique per run: the fixture is shared and a crashed earlier run can leave
   *  this file already committed with identical bytes, in which case `git add`
   *  stages nothing and the commit below fails on an empty index. */
  const stamp = Date.now();
  const committedBody = `committed ${stamp}\n`;

  before(() => {
    headSha = execSync(`git -C "${fixture}" rev-parse HEAD`).toString().trim();
    execSync(`git -C "${fixture}" branch -f ${baseBranch} ${headSha}`);
  });
  after(async () => {
    // The Git tab's sub-tab is persisted, so leaving it on Compare would hand
    // the next spec a panel with no staging panes in it.
    await openChanges().catch(() => {});
    if (taskId) await archiveTask(taskId);
    // This spec COMMITS to the shared fixture checkout, so it has to put the
    // repo back exactly as it found it — the specs after this one assert on a
    // clean tree and would fail on the leftovers.
    execSync(`git -C "${fixture}" reset --hard ${headSha}`);
    execSync(`git -C "${fixture}" clean -fd`);
    try {
      execSync(`git -C "${fixture}" branch -D ${baseBranch}`, { stdio: "ignore" });
    } catch { /* never created */ }
  });

  /** Compare is one of the Git tab's three sub-tabs (Commit / Compare /
   *  History), so getting to it is the Git tab plus one sub-tab click. */
  const openCompare = async () => {
    await openRightTab("Git");
    await selectGitView("compare");
    await waitVisible('[data-testid="compare-panel"]');
  };

  /** Back to the staging view, so a later spec does not inherit Compare (the
   *  sub-tab is persisted on purpose: a review outlives one task switch). */
  const openChanges = () => selectGitView("commit");

  /** The compare rows on screen, as path → status. */
  const rows = () =>
    browser.execute(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-testid="compare-file-row"]')].map((e) => [
          e.getAttribute("data-path"),
          e.getAttribute("data-status"),
        ]),
      ),
    ) as Promise<Record<string, string>>;

  const waitForRow = (path: string, msg: string) =>
    browser.waitUntil(async () => path in (await rows()), {
      timeout: 15_000,
      timeoutMsg: msg,
    });

  const currentBase = () =>
    browser.execute(() =>
      document.querySelector('[data-testid="compare-base"]')?.getAttribute("data-base"),
    ) as Promise<string | null>;

  it("compares against the task's own base and shows only uncommitted work", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-compare");

    // The three ways work can exist in a task: committed away from the base,
    // edited but not committed, and never added at all. README.md is the
    // modify case because it EXISTS at the base branch — a file first
    // committed after the base and then edited nets out to an add, not a
    // modify, which is git being right and not worth asserting twice.
    writeFileSync(path.join(fixture, "committed.txt"), committedBody);
    // Nested, so the tree view below has a real folder to group under. The
    // list is "one list" in the sense of not splitting committed from
    // uncommitted; it is NOT flat (GH #208 review) — it shares the Commit
    // tab's tree/list/combined mode through the same flattenRows.
    mkdirSync(path.join(fixture, "cmp-nested", "deep"), { recursive: true });
    writeFileSync(path.join(fixture, "cmp-nested", "deep", "buried.txt"), "buried\n");
    execSync(`git -C "${fixture}" add committed.txt cmp-nested`);
    execSync(`git -C "${fixture}" commit -q -m "e2e compare probe ${stamp}"`);
    writeFileSync(path.join(fixture, "README.md"), `# edited by the compare spec ${stamp}\n`);
    writeFileSync(path.join(fixture, "compare-untracked.txt"), "untracked\n");

    await openCompare();
    await waitForRow("README.md", "the edited file never appeared in the compare list");

    // A repo-root task's base IS the branch it sits on, so the merge base is
    // HEAD and only uncommitted work can differ. That is the three-dot
    // contract: commits already on the base are not this branch's changes.
    expect(await currentBase()).toContain("main");
    const seen = await rows();
    expect(seen["README.md"]).toBe("M");
    expect(seen["compare-untracked.txt"]).toBe("?");
    expect(seen["committed.txt"]).toBeUndefined();
  });

  it("brings committed work into the same list against an earlier ref", async () => {
    // The whole reason the tab exists: pick a ref from before the commits and
    // work that `git status` cannot see joins the uncommitted work in ONE list.
    // Radix opens on pointerdown, so a bare .click() isn't enough.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="compare-base"]') as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    });
    await waitVisible('[role="menu"]');
    await browser.waitUntil(
      () => browser.execute((b) =>
        [...document.querySelectorAll('[role="menuitem"]')].some(
          (e) => (e as HTMLElement).textContent?.trim() === b), baseBranch),
      { timeout: 10_000, timeoutMsg: "the branch picker never listed the base branch" },
    );
    await clickMenuItem(baseBranch);

    await waitForRow("committed.txt", "picking an earlier base never surfaced the committed file");
    expect(await currentBase()).toBe(baseBranch);
    const seen = await rows();
    expect(seen["committed.txt"]).toBe("A");
    expect(seen["README.md"]).toBe("M");
    expect(seen["compare-untracked.txt"]).toBe("?");

    await snap("git-compare.png");
  });

  it("groups the changed files into a folder tree, like the Commit tab", async () => {
    // The reviewer on GH #208 read "one flat list" as "no hierarchy". The list
    // is one list only in the sense that committed and uncommitted work sit
    // together in it; it renders through the SAME flattenRows the Commit tab
    // uses, in whichever of tree / list / combined is stored, defaulting to
    // tree. So a nested path must appear under folder rows, not as a full path
    // on one line.
    const dirs = () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-testid="compare-dir-row"]')].map(e =>
          e.getAttribute("data-dir")),
      ) as Promise<string[]>;

    await browser.waitUntil(async () => (await dirs()).includes("cmp-nested"), {
      timeout: 10_000,
      timeoutMsg: "the compare list never grouped the nested file under a folder",
    });
    // The whole chain is there, not just the first level.
    expect(await dirs()).toContain("cmp-nested/deep");
    // And the leaf is labelled by its BASENAME under those folders, which is
    // what makes the hierarchy readable rather than decorative.
    const leaf = await browser.execute(() => {
      const el = [...document.querySelectorAll('[data-testid="compare-file-row"]')].find(
        e => e.getAttribute("data-path") === "cmp-nested/deep/buried.txt");
      return el ? (el as HTMLElement).innerText.includes("buried.txt") : null;
    });
    expect(leaf).toBe(true);

    // Folders collapse, so a big feature can be read a directory at a time.
    await browser.execute(() => {
      const el = [...document.querySelectorAll('[data-testid="compare-dir-row"]')].find(
        e => e.getAttribute("data-dir") === "cmp-nested") as HTMLElement;
      el.click();
    });
    await browser.waitUntil(
      async () => !(await rows())["cmp-nested/deep/buried.txt"],
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its files" },
    );
    await browser.execute(() => {
      const el = [...document.querySelectorAll('[data-testid="compare-dir-row"]')].find(
        e => e.getAttribute("data-dir") === "cmp-nested") as HTMLElement;
      el.click();
    });
    await waitForRow("cmp-nested/deep/buried.txt", "re-expanding the folder did not restore it");
  });

  it("summarizes the comparison before you read a file", async () => {
    const summary = await browser.execute(() =>
      (document.querySelector('[data-testid="compare-summary"]') as HTMLElement).innerText);
    // Impact at a glance: a file count and a diffstat.
    expect(summary).toMatch(/\d+ files/);
    expect(summary).toMatch(/\+\d+/);
  });

  it("narrows the list with the filter", async () => {
    // The filter is GitPanel's, on the branch row and shared by all three
    // sub-tabs, so it is outside the compare panel in the DOM.
    const input = await $('input[placeholder="Filter"]');
    await input.setValue("committed");
    await browser.waitUntil(
      async () => {
        const r = await rows();
        return "committed.txt" in r && !("README.md" in r);
      },
      { timeout: 8_000, timeoutMsg: "the filter never narrowed the compare list" },
    );
    await input.setValue("");
    await waitForRow("README.md", "clearing the filter did not restore the list");
  });

  it("diffs a committed file against the base, not against HEAD", async () => {
    await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="compare-file-row"]')].find(
        (e) => e.getAttribute("data-path") === "committed.txt",
      ) as HTMLElement;
      row.click();
    });

    const scope = (await browser.waitUntil(
      async () =>
        browser.execute((id) => {
          const tab = (window.__termic!.useApp.getState().tabs[id] ?? []).find(
            (t: any) => t.type === "diff" && t.path === "committed.txt",
          );
          return tab?.scope ?? null;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "no diff tab opened from the compare list" },
    )) as unknown as string;
    expect(scope).toMatch(/^base:[0-9a-f]{7,}$/);

    // The base predates the commit, so the file is an add there; the right
    // side is the LIVE file, which is what separates this from a History diff.
    const sides = await browser.execute(
      (id, sc) => window.__termic!.ipc.taskFileDiffSides(id, "committed.txt", sc),
      taskId,
      scope,
    );
    expect(sides.original_exists).toBe(false);
    expect(sides.modified).toBe(committedBody);
    // A real worktree fingerprint is what keeps "mark as viewed" anchored.
    expect(sides.fp).not.toBe("");
  });

  it("keeps the review affordances on, unlike a historical diff", async () => {
    // Same machinery as a History diff, opposite outcome: because the right
    // side is the working copy, both affordances a commit diff has to drop are
    // offered here.
    await waitForText("Mark as viewed");
    const chip = await browser.execute(() =>
      document.querySelector('[data-testid="diff-commit-chip"]') !== null);
    expect(chip).toBe(false);
  });

  it("flips to Commit and back without losing the chosen base", async () => {
    await openChanges();
    await browser.waitUntil(
      async () => browser.execute(() =>
        document.querySelector('[data-testid="compare-panel"]') === null),
      { timeout: 5_000, timeoutMsg: "Compare stayed mounted after switching to Commit" },
    );

    // Back to Compare: the mode switch UNMOUNTS this panel, so a deliberately
    // chosen base has to be remembered outside the component or it snaps to
    // the task default on every round trip.
    await openCompare();
    await waitForRow("committed.txt", "the compare list never came back");
    expect(await currentBase()).toBe(baseBranch);
  });
});

// P1: a diff on a PNG renders pictures, not the screenful of U+FFFD that a
// lossy decode of `git show HEAD:shot.png` used to produce. The fixture repo
// carries a committed 1x1 PNG (scripts/e2e-seed.mjs), so both sides exist.
describe("image diff", () => {
  let taskId!: string;
  // Different bytes, still a valid PNG (2x1 instead of 1x1) so the After side
  // decodes and reports its own dimensions.
  const EDITED_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGO4WR7+H4QBF40FTdFBOmcAAAAASUVORK5CYII=";

  after(async () => {
    if (taskId) await archiveTask(taskId);
    // Tasks open the repo ROOT (taskOpenRepo), so these cases dirty the shared
    // fixture in place — restore both files or the commit spec below sees a
    // tree that never goes clean.
    execSync(`git -C "${fixture}" checkout -- shot.png README.md`);
  });

  const diffPaneText = () =>
    browser.execute((id) => {
      const pane = document.querySelector(`[data-task-id="${id}"]`) ?? document.body;
      return (pane as HTMLElement).innerText;
    }, taskId);

  it("renders both sides of a changed PNG as images", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-image-diff");

    // Write the new bytes straight into the task worktree: taskFileWrite is
    // String-only, and this file is binary by design.
    const taskPath = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path,
      taskId,
    );
    writeFileSync(path.join(taskPath as string, "shot.png"), Buffer.from(EDITED_PNG_B64, "base64"));

    await browser.execute((id) => {
      window.__termic!.useApp.getState().bumpGitRevision(id);
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "diff",
        path: "shot.png",
        title: "Δ shot.png",
        scope: "unstaged",
      });
    }, taskId);

    // Two <img>, one per side, both fed by the base64 diff channel.
    await browser.waitUntil(
      async () => {
        const n = await browser.execute(() =>
          document.querySelectorAll('img[src^="data:image/png;base64,"]').length);
        return n === 2;
      },
      { timeout: 10_000, timeoutMsg: "the image diff never rendered two <img> sides" },
    );

    // Dimensions are read off the decoded images, so this also proves the
    // bytes survived the round trip rather than arriving corrupted.
    await browser.waitUntil(
      async () => {
        const txt = await diffPaneText();
        return txt.includes("1×1") && txt.includes("2×1");
      },
      { timeout: 10_000, timeoutMsg: "per-side dimensions never appeared" },
    );

    // Case-insensitive: the labels are CSS-uppercased, and innerText only
    // reflects that while the window is actually rendering — occluded, it
    // falls back to the raw "Before"/"After".
    const txt = (await diffPaneText()).toUpperCase();
    expect(txt).toContain("BEFORE");
    expect(txt).toContain("AFTER");
    // The bug this replaces: a wall of replacement characters.
    expect(txt).not.toContain("�");

    await snap("image-diff.png");
  });

  it("does not mount a CodeMirror editor for the image diff", async () => {
    const editors = await browser.execute((id) => {
      const pane = document.querySelector(`[data-task-id="${id}"]`);
      return pane ? pane.querySelectorAll(".cm-editor").length : -1;
    }, taskId);
    expect(editors).toBe(0);
  });

  it("still renders a text diff as CodeMirror in the same task", async () => {
    // Negative control: the kind branch must not swallow ordinary files.
    await browser.execute(async (id) => {
      const orig = await window.__termic!.ipc.taskFileRead(id, "README.md");
      await window.__termic!.ipc.taskFileWrite(id, "README.md", orig + "\nimage-diff control\n");
      window.__termic!.useApp.getState().bumpGitRevision(id);
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "diff",
        path: "README.md",
        title: "Δ README.md",
        scope: "unstaged",
      });
    }, taskId);

    await browser.waitUntil(
      async () => {
        const n = await browser.execute((id) => {
          const pane = document.querySelector(`[data-task-id="${id}"]`);
          return pane ? pane.querySelectorAll(".cm-editor").length : 0;
        }, taskId);
        return n > 0;
      },
      { timeout: 10_000, timeoutMsg: "the text diff never mounted CodeMirror" },
    );
  });

  it("renders a deleted PNG as a single Deleted image", async () => {
    // The deleted-file half of the image diff: the worktree path no longer
    // exists, so the backend's image probe has nothing to canonicalize and
    // used to fall back to kind "binary" - the "Binary file · deleted" line.
    const taskPath = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path,
      taskId,
    );
    rmSync(path.join(taskPath as string, "shot.png"));

    await browser.execute((id) => {
      window.__termic!.useApp.getState().bumpGitRevision(id);
      window.__termic!.useApp.getState().openPreviewTab(id, {
        type: "diff",
        path: "shot.png",
        title: "Δ shot.png",
        scope: "unstaged",
      });
    }, taskId);

    // One <img> (the HEAD side) on the removed-wash panel, no summary line.
    await browser.waitUntil(
      async () => {
        const n = await browser.execute(() =>
          document.querySelectorAll('img[src^="data:image/png;base64,"]').length);
        return n === 1;
      },
      { timeout: 10_000, timeoutMsg: "the deleted image never rendered its <img>" },
    );
    const txt = (await diffPaneText()).toUpperCase();
    expect(txt).toContain("DELETED");
    expect(txt).not.toContain("BINARY FILE");

    await snap("image-diff-deleted.png");
  });
});

// P1: the staging + commit backend (Fork-style). Cases: a changed file can be
// staged (moves to the staged list), and committing it leaves the tree clean.
// Teardown hard-resets the fixture repo so its HEAD/tree are exactly restored.
describe("git stage & commit", () => {
  let taskId!: string;
  let headSha = "";

  before(() => {
    headSha = execSync(`git -C "${fixture}" rev-parse HEAD`).toString().trim();
  });
  after(async () => {
    if (taskId) await archiveTask(taskId);
    execSync(`git -C "${fixture}" reset --hard ${headSha}`);
    execSync(`git -C "${fixture}" clean -fd`);
  });

  const status = () =>
    browser.execute(
      (id) => window.__termic!.ipc.taskGitStatus(id),
      taskId,
    ) as Promise<any>;

  it("stages a changed file", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-commit");

    // Modify README, then stage it via the app's own IPC.
    await browser.execute(async (id) => {
      const orig = await window.__termic!.ipc.taskFileRead(id, "README.md");
      await window.__termic!.ipc.taskFileWrite(id, "README.md", orig + "\ncommit-test\n");
    }, taskId);
    await browser.execute(
      (id) => window.__termic!.ipc.taskStage(id, "", ["README.md"]),
      taskId,
    );

    await browser.waitUntil(
      async () => {
        const st = await status();
        return (st.repos?.[0]?.staged ?? []).some((f: any) =>
          f.path.includes("README"),
        );
      },
      { timeout: 8_000, timeoutMsg: "README never appeared in the staged list" },
    );
  });

  it("unstages the file (back to unstaged)", async () => {
    await browser.execute(
      (id) => window.__termic!.ipc.taskUnstage(id, "", ["README.md"]),
      taskId,
    );
    await browser.waitUntil(
      async () => {
        const st = await status();
        const repo = st.repos?.[0];
        return (
          !(repo?.staged ?? []).some((f: any) => f.path.includes("README")) &&
          (repo?.unstaged ?? []).some((f: any) => f.path.includes("README"))
        );
      },
      { timeout: 8_000, timeoutMsg: "unstage did not move README back to unstaged" },
    );
  });

  it("commits the staged change and the tree goes clean", async () => {
    // Re-stage (the previous case unstaged it), then commit.
    await browser.execute(
      (id) => window.__termic!.ipc.taskStage(id, "", ["README.md"]),
      taskId,
    );
    await browser.execute(
      (id) =>
        window.__termic!.ipc.taskCommit(id, "", "e2e commit", "", false, false),
      taskId,
    );
    await browser.waitUntil(
      async () => (await status()).total_changed === 0,
      { timeout: 8_000, timeoutMsg: "tree was not clean after commit" },
    );
    await snap("git-commit.png");
  });
});

// P1: commit-and-push. Points the fixture at a throwaway bare remote, commits
// with push=true, and asserts the remote received the commit. Fully restores
// the fixture (reset, remove remote, clean) on teardown.

describe("git commit & push", () => {
  let taskId!: string;
  let headSha = "";
  let bare = "";

  before(() => {
    headSha = execSync(`git -C "${fixture}" rev-parse HEAD`).toString().trim();
    bare = mkdtempSync(path.join(os.tmpdir(), "e2e-bare-"));
    execSync(`git init --bare -q "${bare}"`);
    try {
      execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
    } catch {
      /* none */
    }
    execSync(`git -C "${fixture}" remote add origin "${bare}"`);
  });
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" branch --unset-upstream`, { stdio: "ignore" });
    } catch {
      /* no upstream */
    }
    execSync(`git -C "${fixture}" reset --hard ${headSha}`);
    // Restore the fixture's SEEDED origin (the sibling bare repo the seed set
    // up), not just drop the throwaway one: later specs (the agent-race test)
    // create worktrees off the project default base `origin/main`, so that ref
    // must resolve again. Without this restore the race spawn dies with
    // "not a valid object name: origin/main". Idempotent + best-effort.
    const seedOrigin = `${fixture}-origin.git`;
    try {
      execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
    } catch {
      /* none */
    }
    if (existsSync(seedOrigin)) {
      execSync(`git -C "${fixture}" remote add origin "${seedOrigin}"`);
      execSync(`git -C "${fixture}" fetch -q origin`, { stdio: "ignore" });
      try {
        execSync(`git -C "${fixture}" branch --set-upstream-to=origin/main main`, {
          stdio: "ignore",
        });
      } catch {
        /* upstream already set */
      }
    }
    execSync(`git -C "${fixture}" clean -fd`);
    rmSync(bare, { recursive: true, force: true });
  });

  it("commits and pushes to the remote", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-push");

    await browser.execute(async (id) => {
      const orig = await window.__termic!.ipc.taskFileRead(id, "README.md");
      await window.__termic!.ipc.taskFileWrite(id, "README.md", orig + "\npush-test\n");
      await window.__termic!.ipc.taskStage(id, "", ["README.md"]);
      await window.__termic!.ipc.taskCommit(
        id,
        "",
        "e2e push commit",
        "",
        false,
        true, // push
      );
    }, taskId);

    // The bare remote received the commit.
    const log = execSync(
      `git -C "${bare}" log --oneline main 2>/dev/null || true`,
    ).toString();
    expect(log).toContain("e2e push commit");
    await snap("commit-push.png");
  });
});

// GH #157: inline review comments are CodeMirror block widgets, and CodeMirror
// sizes the line-number gutter from a height map it fills by measuring each
// widget's border box. Vertical margin on the measured element is space it
// never counts, so the gutter sheared away from the code, ~12px per comment.
// Only a real layout engine can see that, so it lives here rather than in
// reviewCommentsExt.test.ts (happy-dom has no layout).
describe("review comment alignment", () => {
  let taskId!: string;
  let original: string | undefined;
  after(async () => {
    // Restore README: without this the 30 appended align lines survive
    // the run, and the NEXT run's clean-tree spec boots against a dirty
    // fixture whose "Git" tab wears a count badge, so its exact-text
    // click misses (the suite then fails one file per run, one run late).
    if (taskId && original !== undefined) {
      await browser.execute(
        (id, c) => window.__termic!.ipc.taskFileWrite(id, "README.md", c),
        taskId,
        original,
      );
    }
    if (taskId) await archiveTask(taskId);
  });

  /**
   * Vertical offset between each gutter element and the content block beside
   * it. A constant offset is fine (the columns can share a padding); what #157
   * produced was a SPREAD, the offset growing line by line down the file.
   */
  const gutterDrift = async () => {
    // The harness window is occluded, so CM's rAF-scheduled measure never
    // runs and its height map would still hold the unmeasured 14px default:
    // a 6px-per-line drift that no wait clears and that this spec would
    // report as the regression it guards. See flushEditorMeasure.
    const flushed = await flushEditorMeasure();
    if (!flushed) throw new Error("no CodeMirror editor to flush: has the view handle moved?");
    return browser.execute(() => {
      const ed = [...document.querySelectorAll(".cm-editor")]
        .find((e) => e.getBoundingClientRect().height > 0);
      if (!ed) return null;
      const lines = [...(ed.querySelector(".cm-content")?.children ?? [])]
        .filter((el) => el.classList.contains("cm-line"));
      // One gutter element per rendered line, in the same order (CodeMirror's
      // lineNumbers has no widget marker, so block widgets get none) — EXCEPT
      // the zero-height hidden spacer that sizes the column to the widest
      // number. Pair by index once that is dropped; the counts matching is the
      // proof the pairing is real, so report them.
      const nums = [...ed.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
        .filter((el) => getComputedStyle(el).visibility !== "hidden");
      const drifts = lines.map((line, i) =>
        (nums[i]?.getBoundingClientRect().top ?? NaN) - line.getBoundingClientRect().top);
      return {
        lines: lines.length,
        nums: nums.length,
        spread: drifts.length ? Math.max(...drifts) - Math.min(...drifts) : NaN,
      };
    });
  };

  /**
   * Leave a comment the way a user does: select the line, click the tooltip
   * button that raises, type, save. Selecting is the only step that needs care
   * — CodeMirror reads the DOM selection inside its content into state (a
   * read-only editor doesn't even need focus for that), and a non-empty
   * selection is what makes the "Comment on line N" tooltip appear.
   */
  async function addCommentOnLine(lineText: string, body: string) {
    await browser.execute((text) => {
      const ed = [...document.querySelectorAll(".cm-editor")]
        .find((e) => e.getBoundingClientRect().height > 0);
      const line = [...(ed?.querySelector(".cm-content")?.children ?? [])]
        .find((el) => el.classList.contains("cm-line") && el.textContent?.trim() === text);
      if (!line) throw new Error(`no rendered diff line reading: ${text}`);
      const range = document.createRange();
      range.selectNodeContents(line);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }, lineText);

    await waitVisible(".tc-add-comment-btn");
    await browser.execute(() => {
      // The tooltip button commits on mousedown, so that the editor can't clear
      // the selection out from under it first. `.click()` alone does nothing.
      document.querySelector(".tc-add-comment-btn")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });

    await waitVisible(".tc-comment-textarea");
    await browser.execute((text) => {
      const ta = document.querySelector(".tc-comment-textarea") as HTMLTextAreaElement;
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true })); // also runs autoGrow
      // "Add to pending" queues the comment card; the primary CTA is now Send,
      // which ships it to the agent instead of mounting a card.
      (document.querySelector(".tc-comment-composer .tc-btn-queue") as HTMLElement).click();
    }, body);
    await waitGone(".tc-comment-textarea");
  }

  it("keeps the line numbers level with the code across several comments", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-comment-align");

    // A diff long enough that drift below the comments is unmistakable. Append
    // rather than rewrite: an added-only diff keeps @codemirror/merge's own
    // deleted-chunk widgets out of the measurement.
    original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );
    await browser.execute(async (id, orig) => {
      const t = window.__termic!;
      const added = Array.from({ length: 30 }, (_, i) => `align line ${i + 1}`).join("\n");
      await t.ipc.taskFileWrite(id, "README.md", `${orig}\n${added}\n`);
      t.useApp.getState().openPreviewTab(id, {
        type: "diff",
        path: "README.md",
        title: "README.md",
        scope: "unstaged",
      });
    }, taskId, original);

    await browser.waitUntil(async () => ((await gutterDrift())?.lines ?? 0) >= 10, {
      timeout: 15_000,
      timeoutMsg: "the diff never rendered enough lines to measure",
    });

    // Baseline: no comment widgets in the content column yet.
    const before = (await gutterDrift())!;
    expect(before.nums).toEqual(before.lines);
    expect(before.spread).toBeLessThan(2);

    for (const n of [2, 5, 8]) await addCommentOnLine(`align line ${n}`, `comment on ${n}`);

    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll(".tc-comment-card").length === 3),
      { timeout: 10_000, timeoutMsg: "the three comment cards never mounted" },
    );

    // The cards push the code down; the numbers have to move with it. Before
    // the fix this was ~36px by the bottom of the file.
    //
    // Poll rather than measure the instant the third card mounts: each card is
    // sized by a ResizeObserver and CodeMirror re-measures its height map on
    // the following frame, so a single sample can land mid-layout and read a
    // drift that is gone a frame later. The regression this guards is a
    // PERMANENT offset, so settling for it is the honest wait; the assertions
    // below still have to hold on the real sample.
    await browser.waitUntil(
      async () => {
        const m = await gutterDrift();
        return !!m && m.nums === m.lines && m.spread < 2;
      },
      { timeout: 10_000, timeoutMsg: "the gutter never settled level with the code" },
    );
    const after = (await gutterDrift())!;
    expect(after.nums).toEqual(after.lines);
    expect(after.spread).toBeLessThan(2);
    await snap("comment-alignment.png");
  });
});

// Multi-repo Git panel. A multi task's status carries the host repo FIRST
// (dir_name ""), then one entry per member — so "the repo with the changes" is
// almost never the first one. Opening the panel has to land on a changed repo
// by itself; it used to open on the empty host and sit there until the user
// clicked a pill (the mount-time reset raced the auto-select and won).
//
// Fixture: a non-git wrapper host plus two throwaway member repos, all under
// one tmp dir. Torn down completely (task archived, project removed, tmp
// deleted) so the profile is left exactly as it was found.
describe("git multi-repo panel", () => {
  let tmp = "";
  let projectId!: string;
  let taskId!: string;

  const member = (name: string) => path.join(tmp, name);

  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "e2e-multi-"));
    mkdirSync(path.join(tmp, "host"));
    for (const name of ["alpha", "beta"]) {
      const p = member(name);
      mkdirSync(p);
      execSync(`git init -b main -q "${p}"`);
      writeFileSync(path.join(p, "README.md"), `# ${name}\n`);
      execSync(`git -C "${p}" add .`);
      execSync(
        `git -C "${p}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q -m init`,
      );
    }
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    if (projectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, projectId);
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  /** The repo pills, in render order. There is exactly one Git panel in the
   *  DOM (RightPanel is an App-level singleton over the active task), so these
   *  need no per-task scoping. */
  const pills = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="repo-pill"]')].map((e) => ({
        dir: e.getAttribute("data-repo-dir"),
        active: e.getAttribute("data-active") === "true",
      })),
    ) as Promise<Array<{ dir: string | null; active: boolean }>>;

  /** Listed file rows as `<pane>:<repo-relative path>`. */
  const rows = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="git-file-row"]')].map(
        (e) => `${e.getAttribute("data-pane")}:${e.getAttribute("data-path")}`,
      ),
    ) as Promise<string[]>;

  it("creates a task spanning two member repos", async () => {
    await waitForAppShell();
    await requireTermicApi();

    const created = await browser.execute(
      async (host, alpha, beta) => {
        const t = window.__termic!;
        // A run that died before its teardown leaves the project behind: the
        // host path is fresh every time but the NAME is not, and the sidebar
        // would accumulate them. Drop any stale one first.
        for (const p of t.useApp.getState().projects.filter((p: any) => p.name === "e2e-multi")) {
          try { await t.ipc.projectRemove(p.id); } catch { /* has live tasks */ }
        }
        const spec = (root_path: string, name: string) => ({
          root_path,
          name,
          // Explicit: these repos have no remote, and an empty base would be
          // filled in as "/main" (remote + "/" + branch) and never resolve.
          base_branch: "main",
          setup_script: "",
          run_script: "",
          archive_script: "",
        });
        const proj = await t.ipc.projectAddMulti(
          host,
          "e2e-multi",
          [spec(alpha, "alpha"), spec(beta, "beta")],
          true, // non-git wrapper host
        );
        // Member paths come back CANONICALIZED (/var/folders/… →
        // /private/var/folders/… on macOS), and task_create_multi matches a
        // requested member against the project's list by exact string — so
        // feed it what the project stored, not what we passed in.
        const at = (n: string) =>
          proj.members!.find((m: any) => m.name === n)!.root_path;
        const task = await t.ipc.taskCreateMulti({
          project_id: proj.id,
          name: "e2e-multi-git",
          cli: "fakeagent",
          branch: "e2e-multi-git",
          members: [
            { root_path: at("alpha"), mode: "worktree" as const },
            { root_path: at("beta"), mode: "worktree" as const },
          ],
        });
        await t.useApp.getState().loadAll();
        t.useApp.getState().setActiveTask(task.id);
        return { projectId: proj.id, taskId: task.id as string };
      },
      path.join(tmp, "host"),
      member("alpha"),
      member("beta"),
    );
    projectId = created.projectId;
    taskId = created.taskId;

    // Both members are checked out inside the wrapper, each on the task branch.
    const st = await browser.execute(
      (id) => window.__termic!.ipc.taskGitStatus(id),
      taskId,
    );
    expect(st.repos.map((r: any) => r.dir_name)).toEqual(["", "alpha", "beta"]);
  });

  it("opens on the changed member repo with its files listed, no click", async () => {
    // Start from "All files" so switching to Git below is a real mount of the
    // panel against an ALREADY dirty status — that is the regression window.
    await openRightTab("All files");

    // Dirty the SECOND member only: the host (repos[0], the default before any
    // selection) and alpha both stay clean, so a panel that fails to auto-select
    // shows an empty file list.
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskFileWrite(id, "beta/README.md", "# beta\nedited by e2e\n");
      window.__termic!.useApp.getState().bumpGitRevision(id);
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute(async (id) => {
          const s = await window.__termic!.ipc.taskGitStatus(id);
          return s.repos_changed === 1;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "git status never reported the member change" },
    );

    await openRightTab("Git");

    // Only the changed repo gets a pill, and it is selected without a click.
    await browser.waitUntil(
      async () => {
        const p = await pills();
        return p.length === 1 && p[0].dir === "beta" && p[0].active;
      },
      { timeout: 10_000, timeoutMsg: "the changed member repo was never auto-selected" },
    );
    // ...and its file list is populated, not the empty host's.
    expect(await rows()).toEqual(["unstaged:README.md"]);
    await snap("git-multi-repo.png");
  });

  it("keeps the selection put when a second repo goes dirty", async () => {
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskFileWrite(id, "alpha/README.md", "# alpha\nedited by e2e\n");
      window.__termic!.useApp.getState().bumpGitRevision(id);
    }, taskId);

    // The new pill appears in repo order (alpha before beta)...
    await browser.waitUntil(
      async () => (await pills()).length === 2,
      { timeout: 10_000, timeoutMsg: "the second changed repo never got a pill" },
    );
    const p = await pills();
    expect(p.map((r) => r.dir)).toEqual(["alpha", "beta"]);
    // ...without stealing the selection, and the file list is still beta's.
    expect(p.find((r) => r.dir === "beta")!.active).toBe(true);
    expect(await rows()).toEqual(["unstaged:README.md"]);
  });

  it("swaps the file list when another repo pill is clicked", async () => {
    await browser.execute(() => {
      const el = document.querySelector(
        '[data-testid="repo-pill"][data-repo-dir="alpha"]',
      ) as HTMLElement;
      el.click();
    });
    await browser.waitUntil(
      async () => (await pills()).find((r) => r.dir === "alpha")!.active,
      { timeout: 8_000, timeoutMsg: "clicking the alpha pill never selected it" },
    );

    // Staging inside the selected member must hit THAT repo: the row moves to
    // the staged pane and beta's own file is untouched.
    await browser.execute((id) =>
      window.__termic!.ipc.taskStage(id, "alpha", ["README.md"]),
      taskId,
    );
    await browser.execute((id) =>
      window.__termic!.useApp.getState().bumpGitRevision(id), taskId);
    await browser.waitUntil(
      async () => (await rows()).includes("staged:README.md"),
      { timeout: 10_000, timeoutMsg: "the staged file never moved panes" },
    );
    const st = await browser.execute(
      (id) => window.__termic!.ipc.taskGitStatus(id),
      taskId,
    );
    const alpha = st.repos.find((r: any) => r.dir_name === "alpha");
    const beta = st.repos.find((r: any) => r.dir_name === "beta");
    expect(alpha.staged.map((f: any) => f.path)).toEqual(["README.md"]);
    expect(beta.staged).toEqual([]);
    expect(beta.unstaged.map((f: any) => f.path)).toEqual(["README.md"]);
  });

  // The host of a multi-repo project is routinely a PLAIN FOLDER holding real
  // git repos, so `Project.non_git` is true while every pill above these views
  // points at a genuine repository. Both used to ask the project that question
  // and answer "this project is not a git repository" over a selected member's
  // history.
  it("shows History and Compare for the selected member, not a non-git notice", async () => {
    const panelText = () =>
      browser.execute(() =>
        (document.querySelector('[data-testid="git-panel-body"]')
          ?? document.querySelector('[role="tabpanel"]')
          ?? document.body).textContent ?? "");

    for (const view of ["history", "compare"] as const) {
      await selectGitView(view);
      await waitVisible(
        view === "history"
          ? '[data-testid="history-panel"]'
          : '[data-testid="compare-panel"]',
      );
      await browser.waitUntil(
        async () => !(await panelText()).includes("not a git repository"),
        { timeout: 8_000, timeoutMsg: `${view} claimed the member repo is not a git repository` },
      );
    }

    // History is the one that can prove it reached the right repo: the member
    // fixtures carry exactly one commit, "init".
    await selectGitView("history");
    await browser.waitUntil(
      async () => {
        const subjects = await browser.execute(() =>
          [...document.querySelectorAll('[data-testid="history-subject"]')].map(
            (e) => (e as HTMLElement).innerText));
        return subjects.includes("init");
      },
      { timeout: 10_000, timeoutMsg: "the member repo's history never listed its commit" },
    );

    // Leave the panel on Commit: the sub-tab is persisted.
    await selectGitView("commit");
  });
});

// Long branch names are the normal case, and both rows of the Git tab share
// their width with something else: the filter on Commit, the base-ref picker
// on Compare. Sized to its content, the name took the whole row and left the
// other control its own padding (a stub with no room for a character) or a
// single glyph ("d…"). Geometry, so it can only be measured in a real window:
// happy-dom has no layout, and asserting the class names would pass just as
// happily on the markup that broke.
describe("git branch bar layout", () => {
  let taskId!: string;
  let original = "";
  /** A real branch name off a real report, and the length that matters: on
   *  its own it fits the panel (265px inner in this window, ~36 monospace
   *  characters), two of them do not. A name longer than the panel truncates
   *  however the row is laid out, which would prove nothing about either fix. */
  const longBranch = "feature/title-authoring-model";

  before(() => {
    original = execSync(`git -C "${fixture}" rev-parse --abbrev-ref HEAD`).toString().trim();
    // -B, not -b: a crashed earlier run can leave the branch behind.
    execSync(`git -C "${fixture}" checkout -q -B ${longBranch}`);
  });

  after(async () => {
    await selectGitView("commit").catch(() => {});
    if (taskId) await archiveTask(taskId);
    execSync(`git -C "${fixture}" checkout -q ${original}`);
    try {
      execSync(`git -C "${fixture}" branch -D ${longBranch}`, { stdio: "ignore" });
    } catch { /* already gone */ }
  });

  /** Widths in CSS pixels, plus the row's own content box (its width minus the
   *  padding its children are laid out inside). */
  const measure = () =>
    browser.execute(() => {
      const box = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return {
          width: r.width, height: r.height,
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          // A truncated element scrolls wider than it renders. This is how
          // "did it end in an ellipsis" is asked without reading pixels.
          clipped: el.scrollWidth > el.clientWidth + 1,
          // What it would take to show the whole label, ellipsis or not.
          natural: el.scrollWidth,
        };
      };
      const rowBox = (el: HTMLElement) => {
        const row = el.parentElement as HTMLElement;
        const cs = getComputedStyle(row);
        const r = row.getBoundingClientRect();
        return {
          inner: row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          height: r.height,
          right: r.right - parseFloat(cs.paddingRight),
        };
      };
      const chip = document.querySelector('[data-testid="branch-chip"]') as HTMLElement | null;
      if (!chip) throw new Error("the branch chip is not on screen");
      const base = document.querySelector('[data-testid="compare-base"]') as HTMLElement | null;
      const target = document.querySelector('[data-testid="compare-target"]') as HTMLElement | null;
      const filter = document.querySelector(
        'input[placeholder="Filter"], input[placeholder="Search messages"]',
      ) as HTMLElement | null;
      return {
        branchRow: rowBox(chip),
        chip: box(chip),
        filter: filter ? box(filter) : null,
        compareRow: base ? rowBox(base) : null,
        base: base ? box(base) : null,
        target: target ? box(target) : null,
      };
    });

  it("leaves the filter its 30% of the branch row, however long the name", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-branch-bar");
    await openRightTab("Git");
    await selectGitView("commit");
    await waitVisible('[data-testid="branch-chip"]');

    // The chip really is holding the long name — without that, everything
    // below passes on an empty row and proves nothing.
    await browser.waitUntil(
      async () => (await measure()).chip.width > 0,
      { timeout: 10_000, timeoutMsg: "the branch chip never rendered" },
    );
    const m = await measure();
    expect(m.filter).not.toBe(null);

    // The point of the fix: the filter keeps its share instead of collapsing
    // to its own padding. Sub-pixel slack, since 30% of an odd width rounds.
    expect(m.filter!.width).toBeGreaterThanOrEqual(m.branchRow.inner * 0.3 - 1);
    // And the chip yields rather than overflowing the panel.
    expect(m.chip.right).toBeLessThanOrEqual(m.branchRow.right + 0.5);
    expect(m.chip.width).toBeLessThanOrEqual(m.branchRow.inner * 0.7 + 1);
    // It stays on ONE row: this panel drags down to 220px, so the filter row
    // is not allowed to grow a second line the way Compare's bar may.
    // Asked as a relationship, not a pixel count: WebKit takes its minimum
    // font size from the system, so a Mac set to larger text renders these
    // controls taller than a hard-coded ceiling would allow, and the test
    // would fail for a machine's accessibility setting rather than a bug.
    expect(m.filter!.top).toBeLessThan(m.chip.bottom);        // same line
    expect(m.branchRow.height).toBeLessThan(m.chip.height * 2);
  });

  it("wraps the compare bar to a second row instead of crushing the base ref", async () => {
    await selectGitView("compare");
    await waitVisible('[data-testid="compare-panel"]');
    await browser.waitUntil(
      async () => (await measure()).target !== null,
      { timeout: 10_000, timeoutMsg: "the compare bar never named the target branch" },
    );

    const m = await measure();
    // Both names are readable in full. Neither is allowed to end in an
    // ellipsis while the other one keeps its name, which is what one row of
    // proportional shrinking did to the picker.
    //
    // Only asked when a row of its own would actually hold the name, which is
    // this block's stated premise rather than a given: WebKit's minimum font
    // size comes from the system, and on a Mac set to larger text these 12px
    // labels render at 18px, where the name outgrows the panel under every
    // possible layout. Wrapping cannot rescue a name that does not fit a full
    // row, so there is nothing left for these two to prove.
    const fitsOwnRow = m.target!.natural <= m.compareRow!.inner;
    if (fitsOwnRow) {
      expect(m.base!.clipped).toBe(false);
      expect(m.target!.clipped).toBe(false);
    }
    // The target took a row of its own: it starts below the picker's bottom.
    // (A panel wide enough to fit both keeps them on one row, and then the two
    // assertions above are the ones carrying the weight.)
    if (m.target!.top >= m.base!.bottom) {
      expect(m.compareRow!.height).toBeGreaterThan(m.base!.height);
    }
    // Wrapped or not, nothing hangs outside the panel.
    expect(m.target!.right).toBeLessThanOrEqual(m.compareRow!.right + 0.5);
    expect(m.base!.right).toBeLessThanOrEqual(m.compareRow!.right + 0.5);
  });
});

describe("pr card (#21)", () => {
  let taskId: string | undefined;

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  /** Seed a lookup and wait for `text`, RE-SEEDING on every poll.
   *
   *  A real lookup landing mid-assertion overwrites the seeded one, and the
   *  fixture repo is not on a forge, so the real answer is
   *  "unsupported-remote" - for which the card renders nothing and the wait
   *  times out. Several things trigger a real lookup (an agent PTY spawning,
   *  the panel's own refresh), so which case lost the race varied between
   *  runs; it presented as two adjacent tests taking turns to fail.
   *
   *  Re-asserting the seed each poll makes the race unlosable without
   *  disabling `refresh`, which other cases in this file legitimately need. */
  const seedPrAndWaitForText = async (lookup: unknown, texts: string[]) => {
    await seedPr(lookup);
    await browser.waitUntil(async () => {
      await browser.execute(
        (id, lk) => {
          window.__termic!.usePr.setState((s: any) => ({
            byTask: { ...s.byTask, [id!]: { lookup: lk, loading: false, fetchedAt: Date.now() } },
          }));
        }, taskId, lookup);
      // ALL of them in one poll. Asserting them one after another let the
      // seed be clobbered between assertions: the first passed, the card
      // reverted to the real (card-less) lookup, and the second timed out.
      return browser.execute(
        (ts) => ts.every(t => document.body.innerText.includes(t)), texts);
    }, { timeoutMsg: `never appeared together with the lookup held in place: ${texts.join(", ")}` });
  };

  /** Let the card finish its own first lookup, then overwrite it. */
  const seedPr = async (lookup: unknown) => {
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const e = window.__termic!.usePr.getState().byTask[id!];
          return !!e && !e.loading && e.fetchedAt > 0;
        }, taskId),
      { timeout: 20_000, timeoutMsg: "the PR card never completed its initial lookup" },
    );
    await browser.execute(
      (id, lk) => {
        window.__termic!.usePr.setState((s: any) => ({
          byTask: { ...s.byTask, [id!]: { lookup: lk, loading: false, fetchedAt: Date.now() } },
        }));
      },
      taskId,
      lookup,
    );
  };

  const OPEN_PR = {
    provider: "github",
    remote_url: "https://github.com/acme/widgets.git",
    status: "ok",
    message: "",
    pr: {
      provider: "github",
      number: 4242,
      url: "https://github.com/acme/widgets/pull/4242",
      title: "Teach the parser about trailing commas",
      state: "open",
      checks: "passing",
      review: "changes_requested",
      base: "main",
      head: "feature/commas",
    },
  };

  it("renders nothing at all on a repo that is not hosted on a forge", async () => {
    await waitForAppShell();
    await requireTermicApi();
    // A worktree task, not a main checkout: PR/MR surfaces are scoped to a
    // real branch, and a main checkout sits on the project's default branch
    // by definition (never gets a card at all - see the main-checkout case
    // below).
    taskId = await createWorktreeTask("e2e-pr-card", "wt-pr-card");

    await clickByText("Git");
    // The fixture's origin is a local bare repo: neither GitHub nor GitLab,
    // and not an instance any CLI is signed in to. A repo gh/glab could
    // never help with gets no PR surface and no install nagging, so the
    // card must be absent, not explaining itself.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const e = window.__termic!.usePr.getState().byTask[id!];
          return !!e && !e.loading && e.fetchedAt > 0;
        }, taskId),
      { timeout: 20_000, timeoutMsg: "the PR lookup never settled" },
    );
    const status = await browser.execute(
      (id) => window.__termic!.usePr.getState().byTask[id!]?.lookup?.status,
      taskId,
    );
    expect(status).toBe("unsupported-remote");
    await waitGone("[data-testid='pr-card']");
  });

  it("names the missing CLI and how to install it", async () => {
    await seedPrAndWaitForText({
      provider: "github",
      remote_url: "https://github.com/acme/widgets.git",
      status: "cli-missing",
      message: "",
      pr: null,
    }, ["need the gh CLI", "brew install gh"]);
  });

  it("tells the user to sign in when the CLI is unauthenticated", async () => {
    await seedPrAndWaitForText({
      provider: "gitlab",
      remote_url: "https://gitlab.com/acme/widgets.git",
      status: "cli-unauthed",
      message: "glab is not authenticated.",
      pr: null,
    }, ["Sign in to GitLab", "glab auth login"]);
  });

  it("offers to create one when the branch has no PR", async () => {
    await seedPr({
      provider: "github",
      remote_url: "https://github.com/acme/widgets.git",
      status: "ok",
      message: "",
      pr: null,
    });
    await waitForText("No pull request yet");
  });

  it("opens the create dialog from the card, prefilled", async () => {
    await clickByText("Create");
    await waitForText("Create pull request");
    // Seeded from the fixture's last commit subject, not left blank.
    const title = await browser.execute(
      () =>
        (document.querySelector("input[placeholder='Title']") as HTMLInputElement | null)?.value ?? "",
    );
    expect(title.length).toBeGreaterThan(0);
    await clickByText("Cancel");
    await waitForTextGone("Description (optional)");
  });

  it("renders an open PR with its number, title, checks and review", async () => {
    await seedPr(OPEN_PR);
    // The number + title live in a truncating flex child, which a narrow
    // right panel collapses out of innerText — read the card's textContent.
    await browser.waitUntil(
      async () => {
        const t = await browser.execute(
          () => document.querySelector("[data-testid='pr-card']")?.textContent ?? "",
        );
        return t.includes("#4242") && t.includes("Teach the parser about trailing commas");
      },
      { timeout: 8_000, timeoutMsg: "the card never rendered the PR number + title" },
    );
    // State pill, CI rollup and review decision all render.
    await waitForText("Open");
    await waitForText("CI");
    await waitForText("Changes requested");
    await snap("pr-card-open.png");
  });

  it("badges the task row in the sidebar and links out to the PR (#21)", async () => {
    const badge = "[data-testid='task-pr-badge']";
    await waitVisible(badge);
    await browser.waitUntil(
      () =>
        browser.execute(
          (sel) => document.querySelector(sel)?.getAttribute("data-pr-state") === "open",
          badge,
        ),
      { timeout: 8_000, timeoutMsg: "sidebar PR badge never showed the open state" },
    );
  });

  it("follows the PR into merged, in the card and in the sidebar", async () => {
    await seedPr({
      ...OPEN_PR,
      pr: { ...OPEN_PR.pr, state: "merged", checks: "none", review: "none" },
    });
    await waitForText("Merged");
    await waitForTextGone("Changes requested");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector("[data-testid='task-pr-badge']")
              ?.getAttribute("data-pr-state") === "merged",
        ),
      { timeout: 8_000, timeoutMsg: "sidebar PR badge never followed the merge" },
    );
    await snap("pr-card-merged.png");
  });

  // GitLab is a first-class provider, not a GitHub special case: same card,
  // same states, MR wording and `!` numbering throughout (forge.rs maps
  // glab's payloads onto the identical vocabulary, including the review
  // decision it reconstructs from reviewer state + the approvals endpoint).
  it("renders a GitLab MR with merge-request wording and ! numbering", async () => {
    await seedPr({
      provider: "gitlab",
      remote_url: "https://gitlab.com/acme/widgets.git",
      status: "ok",
      message: "",
      pr: {
        provider: "gitlab",
        number: 77,
        url: "https://gitlab.com/acme/widgets/-/merge_requests/77",
        title: "Drop the legacy importer",
        state: "draft",
        checks: "pending",
        review: "approved",
        base: "main",
        head: "chore/importer",
      },
    });
    await browser.waitUntil(
      async () => {
        const t = await browser.execute(
          () => document.querySelector("[data-testid='pr-card']")?.textContent ?? "",
        );
        return t.includes("!77") && t.includes("Drop the legacy importer");
      },
      { timeout: 8_000, timeoutMsg: "the card never rendered the MR number + title" },
    );
    await waitForText("Draft");
    await waitForText("Approved");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document
              .querySelector("[data-testid='task-pr-badge']")
              ?.getAttribute("data-pr-state") === "draft",
        ),
      { timeout: 8_000, timeoutMsg: "sidebar badge never showed the draft MR" },
    );
    await snap("pr-card-gitlab.png");
  });

  it("uses merge-request wording in the create dialog for GitLab", async () => {
    await seedPr({
      provider: "gitlab",
      remote_url: "https://gitlab.com/acme/widgets.git",
      status: "ok",
      message: "",
      pr: null,
    });
    await waitForText("No merge request yet");
    await clickByText("Create");
    await waitForText("Create merge request");
    await waitForText("glab");
    await clickByText("Cancel");
    await waitForTextGone("Description (optional)");
  });

  it("drops the card entirely for a repo with no remote at all", async () => {
    await seedPr({
      provider: null,
      remote_url: "",
      status: "no-remote",
      message: "No git remote configured.",
      pr: null,
    });
    // Nothing PR-shaped is left in the panel — a local-only repo gets no
    // "install gh" nagging, which is the whole point of the no-remote arm.
    await waitForTextGone("Teach the parser about trailing commas");
    await waitGone("[data-testid='task-pr-badge']");
  });

  it("refreshes immediately when the task's Git tab regains focus after being backgrounded", async () => {
    // taskId stays mounted (display:none) once backgrounded - the point of
    // this case is that switching back to it doesn't just resume the stale
    // 60s tick, it forces an immediate lookup.
    const before = await browser.execute(
      (id) => window.__termic!.usePr.getState().byTask[id!]?.fetchedAt ?? 0,
      taskId,
    );
    const otherTaskId = await createWorktreeTask("e2e-pr-card-focus", "wt-pr-card-focus");
    try {
      await ensureActiveTask(taskId!);
      await browser.waitUntil(
        async () => {
          const after = await browser.execute(
            (id) => window.__termic!.usePr.getState().byTask[id!]?.fetchedAt ?? 0,
            taskId,
          );
          return after > before;
        },
        { timeout: 5_000, timeoutMsg: "regaining focus never forced a fresh PR lookup" },
      );
    } finally {
      await archiveTask(otherTaskId);
    }
  });

  it("never polls at all for a main checkout - there is no branch that could have a PR", async () => {
    const mainTaskId = await openTask("e2e-pr-card-main");
    try {
      await clickByText("Git");
      await waitForText("Working tree is clean");
      // No lookup ever starts: the card isn't in the tree to trigger one,
      // not just hidden after the fact. usePr's byTask entry stays entirely
      // absent, the same as it would for a task nobody ever opened the Git
      // tab on.
      const entry = await browser.execute(
        (id) => window.__termic!.usePr.getState().byTask[id!] ?? null,
        mainTaskId,
      );
      expect(entry).toBeNull();
      await waitGone("[data-testid='pr-card']");
    } finally {
      await archiveTask(mainTaskId);
    }
  });

  it("keeps the badge current on a task whose PR card is not mounted (#281)", async () => {
    // Every FOREGROUND refresh hangs off PrCard, which renders only while
    // the right panel is open on its Git tab. Off that tab (or on a task
    // never opened this session) nothing polled at all: the sidebar badge
    // sat on its grey "state unknown" glyph for good and no poll arrived to
    // notice a merge. The background poller is what covers those rows.
    const badge = "[data-testid='task-pr-badge']";
    const prState = () =>
      browser.execute(
        (sel) => document.querySelector(sel)?.getAttribute("data-pr-state") ?? null, badge);
    await ensureActiveTask(taskId!);
    try {
      // Leave the Git tab FIRST: the card goes, and with it every poll this
      // row used to get. Whatever the badge does from here is the background
      // poller's doing and nothing else's.
      await openRightTab("All files");
      await waitGone("[data-testid='pr-card']");

      // A real PR puts its identity on the task record (Rust persists it),
      // and that record is what draws the badge. Behind it, a snapshot
      // claiming something the backend will not confirm. Stamped as just
      // fetched, so the poller's own tick leaves it alone until this case
      // says otherwise.
      const seed = () => browser.execute((id) => {
        const t = window.__termic!;
        t.useApp.setState((s: any) => ({
          tasks: s.tasks.map((w: any) => w.id === id
            ? {
              ...w,
              pr_url: "https://github.com/acme/widgets/pull/4242",
              pr_number: 4242,
              pr_provider: "github",
            }
            : w),
        }));
        t.usePr.setState((s: any) => ({
          byTask: {
            ...s.byTask,
            [id!]: {
              lookup: {
                provider: "github",
                remote_url: "https://github.com/acme/widgets.git",
                status: "ok",
                message: "",
                pr: {
                  provider: "github", number: 4242,
                  url: "https://github.com/acme/widgets/pull/4242",
                  title: "Teach the parser about trailing commas",
                  state: "merged", checks: "none", review: "none",
                  base: "main", head: "feat",
                },
              },
              loading: false,
              fetchedAt: Date.now(),
            },
          },
        }));
      }, taskId);
      // RE-SEEDED on every poll, the way every other seeded case in this file
      // is: `loadAll()` re-reads every task from disk on window focus and on
      // any archive, and the identity below lives only in memory, so a single
      // seed can be wiped between the write and the read.
      await browser.waitUntil(async () => {
        await seed();
        return await prState() === "merged";
      }, { timeout: 8_000, timeoutMsg: "the seeded state never reached the badge" });

      // Age the snapshot past the background cadence and run one pass, in a
      // single step so no real tick can slip in between and make the result
      // ambiguous. (One landing there would be the same feature working, but
      // this case should prove it, not depend on luck.)
      await browser.execute(async (id) => {
        const t = window.__termic!;
        t.usePr.setState((s: any) => ({
          byTask: {
            ...s.byTask,
            [id!]: { ...s.byTask[id!], fetchedAt: Date.now() - 10 * 60_000 },
          },
        }));
        await t.prStatusPassNow();
      }, taskId);

      // The fixture repo is not on a forge, so the truthful answer has no PR
      // at all and the badge drops the merged glyph it was holding. Which
      // direction it moves is incidental (no fixture can produce a real
      // green one) - what this pins is that a row with no card behind it
      // still tracks the backend.
      await browser.waitUntil(async () => await prState() === "unknown",
        { timeout: 8_000, timeoutMsg: "the badge never followed a background poll" });
      await waitGone("[data-testid='pr-card']");
    } finally {
      // The identity is seeded in memory only (nothing on disk knows about
      // it); drop it so no later spec inherits a pollable task.
      await browser.execute((id) => {
        window.__termic!.useApp.setState((s: any) => ({
          tasks: s.tasks.map((w: any) => w.id === id
            ? { ...w, pr_url: null, pr_number: null, pr_provider: null }
            : w),
        }));
      }, taskId);
      await openRightTab("Git");
    }
  });
});

// ─────────────────── Start a task from an issue ───────────────────
//
// The forge half needs a live gh/glab, which an offline fixture run has
// none of, so this covers the parts that must hold regardless: the
// affordance only exists for repos actually hosted on a forge, the prompt
// composed for the agent carries the issue and tells it to read the thread
// itself, and the branch/name derivation is traceable back to the issue.
// The prompt composition itself is unit-tested in src/lib/issuePrompt.test.ts.

describe("start a task from an issue", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("resolves the fixture repo as NOT a forge, so no issue UI is offered", async () => {
    await waitForAppShell();
    await requireTermicApi();
    // The fixture pushes to a local bare repo. Nothing GitHub/GitLab-shaped
    // may appear for it - that is the "only on GitHub/GitLab repos" rule.
    const provider = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      const r = await t.invoke("project_forge_provider", { projectId: proj.id });
      return r.provider;
    });
    expect(provider).toBe(null);
  });

  it("reports the exact reason instead of an empty list", async () => {
    const lookup = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      return t.invoke("project_forge_issues", { projectId: proj.id, limit: 5 });
    });
    // A local bare remote is not a forge, and saying so beats a silent
    // empty list the user cannot act on.
    expect(lookup.status).toBe("unsupported-remote");
    expect(lookup.issues).toEqual([]);
  });

  it("composes a prompt that carries the issue and defers the thread", async () => {
    const built = await browser.execute(() =>
      window.__termic!.issuePrompt.buildIssuePrompt({
        provider: "github",
        number: 21,
        title: "Auto-archive when PR merges",
        url: "https://github.com/simion/termic/issues/21",
        body: "I would like to archive worktrees automatically.",
        author: "adamatan",
        comments: 4,
        labels: ["enhancement"],
        updated_at: "2026-07-01T10:00:00Z",
      }));
    expect(built).toContain("GitHub issue #21: Auto-archive when PR merges");
    expect(built).toContain("archive worktrees automatically");
    // 4 comments exist and are NOT inlined; the agent fetches them.
    expect(built).toContain("4 comments");
    expect(built).toContain("gh issue view 21 --comments");
    expect(built).toContain("Work on the issue above.");
    expect(built).toContain("Do not close the issue");
  });

  it("seeds the composed prompt into a fresh task's agent", async () => {
    taskId = await openTask("e2e-issue-task");
    await browser.execute((id) => {
      // 3-arg signature: (taskId, prompt, deadlineMs). A 4th argument used
      // to be passed here, which silently made the DEADLINE 0 - the seeder
      // then gave up on its first poll and the prompt never landed.
      window.__termic!.seedPrompt.seedPromptWhenReady(id!, "ISSUE-PROMPT-MARKER", 20000);
    }, taskId);

    // Terminal content is a WebGL canvas, so assert the store's record of
    // input having been written (same signal the race spec uses).
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id!] ?? []).some(
              (t: any) => t.type === "terminal" && t.is_default && !!t.lastInputAt,
            ),
          taskId,
        ),
      { timeout: 25_000, timeoutMsg: "the issue prompt never reached the agent" },
    );
  });
});

// The route in: a palette row of its own, the shared project picker, then the
// standard New Task dialog already showing its issue split. Every step here is
// real UI. What CANNOT be exercised on this fixture is picking an actual issue
// (a local bare remote is not a forge, by design of the fixture - see the
// describe above), so the prompt auto-fill that a pick triggers is covered by
// src/lib/issuePrompt.test.ts instead.
describe("the route into an issue task", () => {
  const dialogOpen = () =>
    browser.execute(() => !!window.__termic!.useUI.getState().newTaskProjectId);

  /** Click a picker row by name. Not `clickByText`: a row's text is its name
   *  AND its path, and the name itself is split into per-character <b>s by the
   *  fuzzy highlighter, so there is no element whose exact text is the name.
   *  Scoped to the picker so it can never grab a command-palette row, which
   *  carries the same `data-row` attribute. */
  const pickProject = (name: string) =>
    browser.execute((n) => {
      const picker = document.querySelector('[data-testid="project-picker"]');
      if (!picker) throw new Error("project picker is not open");
      const row = [...picker.querySelectorAll("[data-row]")].find(
        (e) => e.textContent?.includes(n),
      );
      if (!row) throw new Error(`no picker row for: ${n}`);
      (row as HTMLElement).click();
    }, name);

  after(async () => {
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeCommandPalette?.();
      ui.closeProjectPicker?.();
      ui.closeNewTask?.();
    });
  });

  it("offers it as its own palette row, not buried in the New Task dialog", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
    // Discovery is the point of the row existing: you should not have to be
    // creating a task already to find out you can start from an issue.
    await waitForText("New task from an issue…");
    await clickByText("New task from an issue…");
  });

  it("asks which project through the SAME picker, flagged as an issue pick", async () => {
    // One picker, two intents. The placeholder is how the user can tell which
    // question they are answering.
    await waitVisible('[data-testid="project-picker"][data-intent="issue"]');
    await waitVisible('input[placeholder="Search a project to pick an issue from"]');
  });

  it("opens the standard New Task dialog straight onto the issue split", async () => {
    await pickProject("fixture-repo");
    await browser.waitUntil(dialogOpen, { timeoutMsg: "New Task never opened" });
    // Not a second dialog: the same one, with one more column.
    await waitVisible('[data-testid="issue-column"]');
    // The column's own heading is uppercased in CSS, and innerText returns it
    // transformed - so assert on the hint below it, which is not.
    await waitForText("Open issues, most recently updated first.");
    // And the rest of the form is right there beside it.
    await waitForText("Task type");
    await waitForText("Default CLI");
  });

  it("says why a non-forge repo has no issues instead of showing an empty list", async () => {
    // The fixture pushes to a local bare repo. An empty list would read as
    // "no open issues", which is a different and wrong statement.
    await waitForText("is not a GitHub or GitLab host");
  });

  it("drops back to a blank form, split and all", async () => {
    await clickByText("Blank task instead");
    await waitGone('[data-testid="issue-column"]');
    // The dialog stays open on the ordinary form rather than closing under
    // the user: they still wanted a task, just not from an issue.
    expect(await dialogOpen()).toBe(true);
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
  });
});
