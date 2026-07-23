import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// Renaming a tab (double-click -> inline edit -> Enter) is a common action and
// exercises the controlled-input + persist path. Guards that the committed
// name lands in the store.
describe("tab rename", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("renames a tab via double-click inline edit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-rename");

    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length,
          taskId,
        )) === 1,
      { timeout: 20_000, timeoutMsg: "agent tab never appeared" },
    );
    const tabId = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].id as string,
      taskId,
    );

    // Double-click the tab to enter rename mode.
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"]`)!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, tabId);
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => !!document.querySelector(`[data-tab-id="${id}"] input`),
          tabId,
        ),
      { timeout: 5_000, timeoutMsg: "rename input never appeared" },
    );

    // Type into the controlled input (native setter + input event so React's
    // onChange fires).
    await browser.execute((id) => {
      const input = document.querySelector(
        `[data-tab-id="${id}"] input`,
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, tabId);

    // Commit with Enter in a separate round-trip, so React has flushed the
    // new value into state before the keydown handler reads it.
    await browser.execute((id) => {
      document
        .querySelector(`[data-tab-id="${id}"] input`)!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
    }, tabId);

    await browser.waitUntil(
      () =>
        browser.execute(
          (tid, aid) => {
            const tab = (window.__termic!.useApp.getState().tabs[tid] ?? []).find(
              (t: any) => t.id === aid,
            );
            return tab?.title === "e2e-renamed";
          },
          taskId,
          tabId,
        ),
      { timeout: 5_000, timeoutMsg: "tab title never became the new name" },
    );

    await snap("rename.png");
  });
});
