import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// P1: the file finder (⌘P). Cases: opens and lists the repo's files; selecting
// a result opens an editor tab for that file.
describe("file finder", () => {
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFileFinder(),
    );
    if (taskId) await archiveTask(taskId);
  });

  it("opens and lists the repo's files", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-finder");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFileFinder(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-row]")].some((r) =>
            r.textContent?.includes("README"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "file finder never listed README" },
    );
  });

  it("selecting a result opens an editor tab", async () => {
    await browser.execute(() => {
      const row = [...document.querySelectorAll("[data-row]")].find((r) =>
        r.textContent?.includes("README"),
      );
      if (!row) throw new Error("README row not found");
      (row as HTMLElement).click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "README.md",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "selecting a file did not open an editor tab" },
    );
    await snap("file-finder.png");
  });
});

// P1: find-in-files (⇧⌘F) streams git-grep results. Cases: opens with an
// input; a query that matches the fixture README returns a result row.
describe("find in files", () => {
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFindInFiles(),
    );
    if (taskId) await archiveTask(taskId);
  });

  const inputSel = 'input[placeholder^="Find in"]';

  it("opens with a query input", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-fif");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFindInFiles(id),
      taskId,
    );
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), inputSel),
      { timeout: 8_000, timeoutMsg: "find-in-files never opened" },
    );
  });

  it("returns a match for a query present in the repo", async () => {
    // "fixture" is in the committed README ("# e2e fixture").
    await browser.execute((s) => {
      const input = document.querySelector(s) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "fixture");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, inputSel);

    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-row]")].some((r) =>
            r.textContent?.toLowerCase().includes("readme"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: "no result row for the query" },
    );
    await snap("find-in-files.png");
  });
});

// P1: the file tree. Guards expanding/collapsing a folder. Creates a throwaway
// nested file so there's a folder to toggle, then git-cleans it away.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("file tree", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    execSync(`git -C "${fixture}" clean -fd`);
  });

  const rowExists = (p: string) =>
    browser.execute((sel) => !!document.querySelector(sel), `[data-path="${p}"]`);
  const clickRow = (p: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `[data-path="${p}"]`,
    );

  it("expands and collapses a folder", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tree");

    // Create a nested file on disk → a folder appears in the tree; force a
    // re-read (taskFileWrite doesn't mkdir -p, so write it directly).
    mkdirSync(path.join(fixture, "e2e-subdir"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-subdir", "note.txt"), "hi\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    await browser.waitUntil(() => rowExists("e2e-subdir"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    // Expand → the child file becomes visible.
    await clickRow("e2e-subdir");
    await browser.waitUntil(() => rowExists("e2e-subdir/note.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its child",
    });

    // Collapse → the child is hidden again.
    await clickRow("e2e-subdir");
    await browser.waitUntil(
      async () => (await rowExists("e2e-subdir/note.txt")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its child" },
    );
    await snap("file-tree.png");
  });

  // Re-expanding an already-opened folder must re-read it from disk, so a file
  // created while it was collapsed shows up on reopen WITHOUT any global tree
  // reload (bumpFsRevision). Guards the on-demand per-dir refresh: before it,
  // a re-expand served the stale cache and the new file stayed hidden.
  it("re-expanding a folder re-reads only that dir from disk", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    // A fresh folder with a single child, surfaced via a one-time root reload.
    mkdirSync(path.join(fixture, "e2e-refresh"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-refresh", "one.txt"), "1\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-refresh"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    // First expand caches + shows the initial child.
    await clickRow("e2e-refresh");
    await browser.waitUntil(() => rowExists("e2e-refresh/one.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its first child",
    });
    // Collapse (the children cache is kept).
    await clickRow("e2e-refresh");
    await browser.waitUntil(
      async () => (await rowExists("e2e-refresh/one.txt")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its child" },
    );

    // Add a SECOND file on disk — deliberately with NO bumpFsRevision, so the
    // ONLY thing that can surface it is the re-expand re-reading this dir.
    writeFileSync(path.join(fixture, "e2e-refresh", "two.txt"), "2\n");

    // Re-expand → the on-demand refresh picks up the new file.
    await clickRow("e2e-refresh");
    await browser.waitUntil(() => rowExists("e2e-refresh/two.txt"), {
      timeout: 8_000,
      timeoutMsg: "re-expanding the folder did not re-read it from disk",
    });
    // The original child is still there too (a refresh, not a replace).
    expect(await rowExists("e2e-refresh/one.txt")).toBe(true);
  });
});
