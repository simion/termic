import {
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  artifact,
} from "../helpers";

// P1: splitting a task into multiple panes (Sublime-style). Cases: no split to
// start, split right builds a 2-leaf tree, split below grows it to 3 leaves.
describe("split pane", () => {
  let taskId: string | undefined;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  // Count pane leaves in the task's split tree (leaves are type:"pane").
  const leafCount = () =>
    browser.execute((id) => {
      const tree = window.__termic!.useApp.getState().splitTree[id];
      if (!tree) return 0;
      // SplitNode = { type:"split", a, b }; PaneLeaf = { type:"pane" }.
      const walk = (node: any): number =>
        !node ? 0 : node.type === "pane" ? 1 : walk(node.a) + walk(node.b);
      return walk(tree);
    }, taskId);

  const clickSplit = async (lucideClass: string, label: string) => {
    // Wait for the toggle to render (the tab strip mounts async after the task
    // becomes active, and is slower under full-suite load).
    await browser.waitUntil(
      () =>
        browser.execute(
          (cls) =>
            [...document.querySelectorAll("button")].some((b) =>
              b.querySelector(`svg.${cls}`),
            ),
          lucideClass,
        ),
      { timeout: 10_000, timeoutMsg: `${label} toggle never appeared` },
    );
    await browser.execute((cls) => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.querySelector(`svg.${cls}`),
      );
      (btn as HTMLElement).click();
    }, lucideClass);
  };

  it("starts unsplit", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-split");
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length >= 1,
          taskId,
        ),
      { timeout: 20_000, timeoutMsg: "task never opened" },
    );
    expect(await leafCount()).toBe(0); // no split tree yet
  });

  it("split right builds a two-leaf tree", async () => {
    await clickSplit("lucide-square-split-horizontal", "Split right");
    await browser.waitUntil(async () => (await leafCount()) === 2, {
      timeout: 8_000,
      timeoutMsg: "split right did not produce 2 panes",
    });
  });

  it("split below grows the tree to three leaves", async () => {
    await clickSplit("lucide-square-split-vertical", "Split below");
    await browser.waitUntil(async () => (await leafCount()) === 3, {
      timeout: 8_000,
      timeoutMsg: "split below did not produce 3 panes",
    });
    await browser.saveScreenshot(artifact("split-pane.png"));
  });
});
