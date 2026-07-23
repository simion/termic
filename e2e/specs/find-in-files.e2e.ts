import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

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
