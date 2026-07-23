import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

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
