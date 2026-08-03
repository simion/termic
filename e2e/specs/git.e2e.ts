import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    // Switch the right panel from "All files" to "Git" (a real click).
    await clickByText("Git");

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

    // Open the Git panel (starts clean).
    await clickByText("Git");

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
  after(async () => {
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
      (document.querySelector(".tc-comment-composer .tc-btn-primary") as HTMLElement).click();
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
    await browser.execute(async (id) => {
      const t = window.__termic!;
      const orig = await t.ipc.taskFileRead(id, "README.md");
      const added = Array.from({ length: 30 }, (_, i) => `align line ${i + 1}`).join("\n");
      await t.ipc.taskFileWrite(id, "README.md", `${orig}\n${added}\n`);
      t.useApp.getState().openPreviewTab(id, {
        type: "diff",
        path: "README.md",
        title: "README.md",
        scope: "unstaged",
      });
    }, taskId);

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
