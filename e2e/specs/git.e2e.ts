import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTask, clickByText, openTask, requireTermicApi, snap, waitForAppShell, waitForText, waitForTextGone, waitGone, waitVisible } from "../helpers";

// Git integration is central to termic (every task is a worktree/checkout).
// This guards the Git panel: switching to it shows the working-tree status.
// The seeded fixture-repo has a single commit and no edits, so the state is
// deterministically clean.
describe("git panel", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("shows a clean working tree for the fixture repo", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git");

    // Switch the right panel from "All files" to "Commit" (a real click).
    await clickByText("Commit");

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
  let taskId: string | undefined;
  let original: string | undefined;

  after(async () => {
    if (taskId && original !== undefined) {
      await browser.execute(
        (id, c) => window.__termic!.ipc.taskFileWrite(id, "README.md", c),
        taskId,
        original,
      );
    }
    if (taskId) await archiveTask(taskId);
  });

  it("lists a modified file after the tree changes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-git-dirty");
    original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );

    // Open the Commit panel (starts clean).
    await clickByText("Commit");

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
});

// Tasks here open the repo ROOT, so every case below edits this one working
// tree and has to put it back.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

// GH #199: committed work used to vanish from termic the moment the tree went
// clean, sending people to VS Code or Fork to see what an agent had just done.
// The History tab is that view: a graph of real commits, each expandable into
// the files it touched, each file opening a diff of THAT revision.
describe("git history tab", () => {
  let taskId: string | undefined;
  /** Subject of the commit this spec makes, unique per run so a leftover
   *  fixture commit from an earlier run can't satisfy the assertions. */
  const subject = `e2e history probe ${Date.now()}`;

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

  const openRightTab = (label: "All files" | "Commit" | "History") =>
    browser.execute((l) => {
      const el = document.querySelector(
        `[data-testid="right-tab"][data-tab="${l}"]`,
      ) as HTMLElement | null;
      if (!el) throw new Error(`no right-panel tab: ${l}`);
      el.click();
    }, label);

  /** Subjects of the commit rows currently rendered, newest first. */
  const commitSubjects = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="history-subject"]')].map(
        (e) => (e as HTMLElement).innerText,
      ),
    ) as Promise<string[]>;

  it("lists real commits, newest first", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-history");

    // A commit made OUTSIDE the app: the tab must read the repo, not some
    // in-app cache of what termic itself committed.
    writeFileSync(path.join(fixture, "history-probe.txt"), "probe\n");
    execSync(`git -C "${fixture}" add history-probe.txt`);
    execSync(`git -C "${fixture}" commit -q -m "${subject}"`);

    await openRightTab("History");

    await browser.waitUntil(
      async () => (await commitSubjects())[0] === subject,
      { timeout: 15_000, timeoutMsg: "the new commit never appeared at the top of History" },
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
        browser.execute(() =>
          [...document.querySelectorAll('[data-testid="history-file-row"]')].some(
            (e) => e.getAttribute("data-path") === "history-probe.txt",
          ),
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
    writeFileSync(path.join(fixture, "history-probe.txt"), "probe\nWORKTREE ONLY\n");

    await browser.execute(() => {
      const f = [...document.querySelectorAll('[data-testid="history-file-row"]')].find(
        (e) => e.getAttribute("data-path") === "history-probe.txt",
      ) as HTMLElement;
      f.click();
    });

    // The tab carries the commit scope...
    const scope = await browser.waitUntil(
      async () =>
        browser.execute((id) => {
          const tab = (window.__termic!.useApp.getState().tabs[id] ?? []).find(
            (t: any) => t.type === "diff" && t.path === "history-probe.txt",
          );
          return tab?.scope ?? null;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "no diff tab opened for the commit's file" },
    ) as unknown as string;
    expect(scope).toMatch(/^commit:[0-9a-f]{7,}$/);

    // ...and the backend resolves that scope to the two REVISIONS: the file is
    // an add in this commit (no left side), and the right side is the
    // committed content, never the dirtied working tree.
    const sides = await browser.execute(
      (id, sc) => window.__termic!.ipc.taskFileDiffSides(id, "history-probe.txt", sc),
      taskId,
      scope,
    );
    expect(sides.original_exists).toBe(false);
    expect(sides.modified).toBe("probe\n");
    expect(sides.modified).not.toContain("WORKTREE ONLY");

    // Restore the working tree for the specs that follow.
    writeFileSync(path.join(fixture, "history-probe.txt"), "probe\n");
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

  it("switches between this branch and all branches", async () => {
    await openRightTab("History");
    const scopeState = () =>
      browser.execute(() =>
        document.querySelector('[data-testid="history-scope"]')?.getAttribute("data-all"));
    expect(await scopeState()).toBe("false");
    await browser.execute(() =>
      (document.querySelector('[data-testid="history-scope"]') as HTMLElement).click());
    await browser.waitUntil(async () => (await scopeState()) === "true", {
      timeout: 5_000,
      timeoutMsg: "the branch-scope toggle never flipped",
    });
    // Still a real list after the refetch (the fixture has one branch, so the
    // contents are the same — what matters is that --all doesn't empty it).
    await browser.waitUntil(async () => (await commitSubjects()).length > 1, {
      timeout: 10_000,
      timeoutMsg: "the all-branches view came back empty",
    });
    await browser.execute(() =>
      (document.querySelector('[data-testid="history-scope"]') as HTMLElement).click());
  });
});

// P1: a diff on a PNG renders pictures, not the screenful of U+FFFD that a
// lossy decode of `git show HEAD:shot.png` used to produce. The fixture repo
// carries a committed 1x1 PNG (scripts/e2e-seed.mjs), so both sides exist.
describe("image diff", () => {
  let taskId: string | undefined;
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
});

// P1: the staging + commit backend (Fork-style). Cases: a changed file can be
// staged (moves to the staged list), and committing it leaves the tree clean.
// Teardown hard-resets the fixture repo so its HEAD/tree are exactly restored.
describe("git stage & commit", () => {
  let taskId: string | undefined;
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
  let taskId: string | undefined;
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
  let taskId: string | undefined;
  let original: string | undefined;
  after(async () => {
    // Restore README: without this the 30 appended align lines survive
    // the run, and the NEXT run's clean-tree spec boots against a dirty
    // fixture whose "Commit" tab wears a count badge, so its exact-text
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
  const gutterDrift = () =>
    browser.execute(() => {
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
  let projectId: string | undefined;
  let taskId: string | undefined;

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

  /** Click one of the right panel's own tabs. Not clickByText: the label grows
   *  badge digits ("Commit" → "Commit21") the moment anything is changed. */
  const openRightTab = (label: "All files" | "Commit" | "History") =>
    browser.execute((l) => {
      const el = document.querySelector(
        `[data-testid="right-tab"][data-tab="${l}"]`,
      ) as HTMLElement | null;
      if (!el) throw new Error(`no right-panel tab: ${l}`);
      el.click();
    }, label);

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

    await openRightTab("Commit");

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
});
