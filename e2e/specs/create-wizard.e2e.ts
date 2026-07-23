import {
  waitForAppShell,
  requireTermicApi,
  archiveTask,
  artifact,
} from "../helpers";

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

  // Click a button inside the open dialog by its exact text.
  const clickDialogButton = (text: string) =>
    browser.execute((t) => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) throw new Error("new task dialog not open");
      const btn = [...dlg.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === t,
      );
      if (!btn) throw new Error(`dialog button not found: ${t}`);
      (btn as HTMLElement).click();
    }, text);

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

    await browser.saveScreenshot(artifact("create-wizard.png"));
  });
});
