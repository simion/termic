import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// Editor is a crown-jewel feature (CodeMirror 6, perf-critical). This guards
// the flow: click a file in the tree -> an editor tab opens -> the file's
// contents load into CodeMirror. CodeMirror renders to the DOM (unlike the
// xterm canvas), so we can assert its text directly.
describe("editor", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("opens a file from the tree and loads it in CodeMirror", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-editor");

    // The file tree (RightPanel "All files") reads the repo async; wait for
    // the README row to appear, then click it like a user.
    const readmeSel = '[data-path="README.md"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared in the file tree" },
    );
    await browser.execute((s) => {
      (document.querySelector(s) as HTMLElement).click();
    }, readmeSel);

    // An editor ("edit") tab should open for the file.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tabs = window.__termic!.useApp.getState().tabs[id] ?? [];
          return tabs.some(
            (t: any) => t.type === "edit" && t.path === "README.md",
          );
        }, taskId),
      { timeout: 10_000, timeoutMsg: "editor tab never opened for README.md" },
    );

    // CodeMirror should render the file's real contents ("# e2e fixture").
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const cm = document.querySelector(".cm-content");
          return !!cm && (cm.textContent ?? "").includes("e2e fixture");
        }),
      { timeout: 10_000, timeoutMsg: "CodeMirror never showed the file contents" },
    );

    await browser.saveScreenshot(artifact("editor.png"));
  });
});
