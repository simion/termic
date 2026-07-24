import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// Editor (CodeMirror 6), open/preview/persist. Cases: single-click opens a
// PREVIEW tab (italic, recyclable) with the file's real contents; double-click
// PERSISTS it. Saving has its own spec (editor-save.e2e.ts).
describe("editor open", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const readmeSel = '[data-path="README.md"]';
  const editTab = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).find(
          (t: any) => t.type === "edit" && t.path === "README.md",
        ),
      taskId,
    );

  it("opens a file as a preview tab and loads its content in CodeMirror", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-editor");

    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, readmeSel);

    // A single click opens a *preview* edit tab.
    await browser.waitUntil(async () => (await editTab())?.preview === true, {
      timeout: 10_000,
      timeoutMsg: "single click did not open a preview edit tab",
    });

    // CodeMirror renders the real contents.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (document.querySelector(".cm-content")?.textContent ?? "").includes(
            "e2e fixture",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never showed the contents" },
    );
    await snap("editor.png");
  });

  it("persists the preview tab on double-click", async () => {
    const tab = await editTab();
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, (tab as any).id);

    await browser.waitUntil(async () => (await editTab())?.preview === false, {
      timeout: 5_000,
      timeoutMsg: "double-click did not persist the preview tab",
    });
  });

  // NOTE: editor search (⌘F) is keyboard-shortcut-only in CodeMirror and does
  // not route reliably across window-focus states in this harness (see the
  // environment-limited list in docs/plans/e2e-coverage.md), so it is a manual
  // check, not a spec.

  it("renders the markdown Preview", async () => {
    // README is a .md file → MarkdownPane. Switch to the Preview view and
    // assert the rendered markdown (the "# e2e fixture" heading becomes an h1).
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Preview",
      );
      if (!btn) throw new Error("Preview toggle not found");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("h1")].some((h) =>
            h.textContent?.includes("fixture"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "markdown preview never rendered" },
    );
  });

  it("shows source and preview together in Split view", async () => {
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Split",
      );
      if (!btn) throw new Error("Split toggle not found");
      (btn as HTMLElement).click();
    });
    // Split shows both the CodeMirror source and the rendered markdown.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(".cm-content") &&
            [...document.querySelectorAll("h1")].some((h) =>
              h.textContent?.includes("fixture"),
            ),
        ),
      { timeout: 8_000, timeoutMsg: "split view did not show both panes" },
    );
  });
});

// P0: editing a file and saving it. Guards the CodeMirror edit -> dirty dot ->
// Cmd+S -> taskFileWrite path (termic never auto-saves). Restores README on
// teardown so the fixture repo stays clean for the git specs.
describe("editor save", () => {
  let taskId: string | undefined;
  let original: string | undefined;

  after(async () => {
    if (taskId && original !== undefined) {
      await browser.execute(
        (id, content) => window.__termic!.ipc.taskFileWrite(id, "README.md", content),
        taskId,
        original,
      );
    }
    if (taskId) await archiveTask(taskId);
  });

  const editTab = (id: string) =>
    browser.execute(
      (t) =>
        (window.__termic!.useApp.getState().tabs[t] ?? []).find(
          (x: any) => x.type === "edit" && x.path === "README.md",
        ),
      id,
    );

  it("edits README, saves with Cmd+S, and writes it to disk", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-editor-save");
    original = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );

    // Open README in the editor.
    const readmeSel = '[data-path="README.md"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, readmeSel);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (document.querySelector(".cm-content")?.textContent ?? "").includes(
            "e2e fixture",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never loaded README" },
    );

    // Edit through CodeMirror's own view API (the e2e build exposes it on
    // .cm-editor). This flips the tab's dirty dot via the updateListener.
    await browser.execute(() => {
      const el = document.querySelector(".cm-editor") as unknown as {
        __cmView?: any;
      };
      const view = el?.__cmView;
      if (!view)
        throw new Error("CodeMirror e2e hook missing (build with make e2e)");
      view.dispatch({ changes: { from: view.state.doc.length, insert: "X" } });
    });
    await browser.waitUntil(
      async () => (await editTab(taskId!))?.dirty === true,
      { timeout: 5_000, timeoutMsg: "edit never marked the tab dirty" },
    );

    // Cmd+S (the editor's Mod-s keymap) saves and clears dirty.
    await browser.execute(() => {
      document
        .querySelector(".cm-content")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
        );
    });
    await browser.waitUntil(
      async () => (await editTab(taskId!))?.dirty === false,
      { timeout: 5_000, timeoutMsg: "Cmd+S never cleared the dirty flag" },
    );

    // The change is on disk.
    const saved = await browser.execute(
      (id) => window.__termic!.ipc.taskFileRead(id, "README.md"),
      taskId,
    );
    expect(saved).not.toBe(original);
    expect(saved).toContain("e2e fixture");

    await snap("editor-save.png");
  });
});

// P2: the editor handles non-markdown code files (CodeMirror language support).
// Creates a Python file, opens it, asserts CodeMirror renders it with
// syntax-highlight token spans. Git-cleans the file away.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

describe("code editor", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch {
      /* nothing */
    }
  });

  it("opens a code file with syntax highlighting", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-code");

    writeFileSync(
      path.join(fixture, "hello.py"),
      "def greet(name):\n    return f'hi {name}'\n",
    );
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    // Open it in the editor.
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !!document.querySelector('[data-path="hello.py"]'),
        ),
      { timeout: 10_000, timeoutMsg: "hello.py never appeared in the tree" },
    );
    await browser.execute(() =>
      (document.querySelector('[data-path="hello.py"]') as HTMLElement).click(),
    );

    // CodeMirror renders the content...
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          (document.querySelector(".cm-content")?.textContent ?? "").includes(
            "greet",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "CodeMirror never loaded hello.py" },
    );
    // ...with syntax-highlight token spans (the Python language extension is
    // active, so keywords/strings become classed spans).
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll(".cm-content .cm-line span[class]")
              .length > 0,
        ),
      { timeout: 8_000, timeoutMsg: "no syntax-highlight token spans" },
    );
    await snap("code-editor.png");
  });
});
