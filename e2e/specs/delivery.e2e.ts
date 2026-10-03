import { writeFileSync } from "node:fs";
import { archiveTask, clickByText, clickWhenVisible, clickMenuItem, createWorktreeTask, openRightTab, requireTermicApi, waitGone, waitVisible, waitForAgentReady, waitForAppShell, waitForText } from "../helpers";

const openActions = async () => {
  await browser.waitUntil(() => browser.execute(() => !document.querySelector<HTMLButtonElement>('[data-testid="delivery-actions"]')?.disabled));
  await browser.execute(() => {
    const trigger = document.querySelector('[data-testid="delivery-actions"]')!;
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", isPrimary: true };
    trigger.dispatchEvent(new PointerEvent("pointerdown", init));
    trigger.dispatchEvent(new PointerEvent("pointerup", init));
  });
  await waitVisible('[role="menu"]');
};
const refreshPanel = async () => {
  const selector = '[data-testid="delivery-panel"] button[aria-label="Refresh"]';
  await browser.waitUntil(() => browser.execute(s => !document.querySelector<HTMLButtonElement>(s)?.disabled, selector));
  await clickWhenVisible(selector);
};
describe("task delivery", () => {
  let taskId = "";
  after(async () => { await browser.keys("Escape"); await openRightTab("All files"); if (taskId) await archiveTask(taskId); });

  it("shows clean repositories and retains failed branch-update results", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await createWorktreeTask("e2e-delivery", "e2e-delivery");
    await openRightTab("Delivery");
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="delivery-repo"]')?.textContent?.includes("Clean")));
    await openActions();
    await clickMenuItem("Update branches");
    await browser.execute(() => { const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!; select.value = "pull"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await clickByText("Update branches");
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="delivery-results"]')?.textContent?.toLowerCase().includes("upstream")));
    await openRightTab("All files");
    await openRightTab("Delivery");
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="delivery-results"]')?.textContent?.toLowerCase().includes("upstream")));
  });

  it("reviews exact scope and rejects a changed worktree before sending", async () => {
    await waitForAgentReady(taskId);
    await openActions();
    await clickMenuItem("Create PRs");
    await clickByText("Draft all with agent");
    await waitForText("Review agent handoff");
    await waitForText("does not authorize commits");
    await browser.execute(async id => {
      await window.__termic!.ipc.taskFileWrite(id, "README.md", "changed after reviewing the handoff\n");
    }, taskId);
    await browser.waitUntil(() => browser.execute(() => !document.querySelector<HTMLButtonElement>('[data-testid="delivery-send"]')?.disabled));
    await clickWhenVisible('[data-testid="delivery-send"]');
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[role="dialog"]')?.textContent?.includes("working files changed")));
    await browser.keys("Escape");
    await browser.keys("Escape");
    await waitGone('[role="dialog"]');
    await browser.execute(async id => {
      // Undo through git in the fixture's isolated checkout, not the shared repo.
      const t = window.__termic!;
      await t.ipc.taskDiscard(id, "", ["README.md"]);
    }, taskId);
  });

  it("imports an agent PR report and auto-fills untouched dialog fields", async () => {
    await refreshPanel();
    await browser.waitUntil(() => browser.execute(id => !window.__termic!.useDelivery.getState().byTask[id]?.loading, taskId));
    await openActions();
    await clickMenuItem("Create PRs");
    await clickByText("Draft all with agent");
    await waitForText("Review agent handoff");
    const request = await browser.execute(async id => {
      const requests = await window.__termic!.ipc.taskDeliveryRequests(id);
      return requests[requests.length - 1];
    }, taskId);
    // Simulate an agent writing its report, using the reviewed fixture path.
    writeFileSync(request.report, JSON.stringify({ drafts: [], prs: [
      { dir_name: "", title: "Proposed delivery title", body: "Proposed description, pending human review." },
    ] }));
    await browser.execute(async (id, requestId) => {
      await window.__termic!.ipc.taskDeliveryRequestStatus(id, requestId, "sent");
    }, taskId, request.id);
    await browser.waitUntil(() => browser.execute(() => !document.querySelector<HTMLButtonElement>('[data-testid="delivery-send"]')?.disabled));
    await browser.keys("Escape");
    // The imported draft lands in the still-open Create PRs dialog, filling
    // only fields the user has not touched.
    await browser.execute(async id => { await window.__termic!.useDelivery.getState().refresh(id); }, taskId);
    await browser.waitUntil(() => browser.execute(() => document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value === "Proposed delivery title"));
    expect(await browser.execute(() => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')?.checked)).toBe(true);
    await waitForText("pushes committed branch changes");
    await browser.keys("Escape");
    await waitGone('[role="dialog"]');
    await waitForText("Proposed delivery title");
  });

  it("renders independent review and CI states without treating skipped jobs as passed", async () => {
    await browser.execute(id => {
      const store = window.__termic!.useDelivery;
      const current = store.getState().byTask[id];
      const identity = current.repos[0].identity;
      window.__termic!.usePr.setState({ byTask: { ...window.__termic!.usePr.getState().byTask, [id]: {
        lookup: { status: "ok", provider: "github", pr: { provider: "github", number: 7, state: "open", checks: "failing", review: "changes_requested", title: "Handle missing branch", url: "https://example.test/pull/7" } },
        loading: false, fetchedAt: Date.now(),
      } } });
      store.setState({ byTask: { ...store.getState().byTask, [id]: { ...current, details: {
        "": { identity, revision: "abc123", pr: { provider: "github", number: 7, url: "https://example.test/pull/7" },
          ci_error: null, threads_error: null,
          ci: [{ id: "run", parent: null, name: "Build workflow", status: "failed", duration: null, url: "", log_id: null },
            { id: "job", parent: "run", name: "Skipped deployment", status: "skipped", duration: null, url: "", log_id: null }],
          threads: [{ id: "thread", reply_id: "1", path: "src/example.ts", line: 12, resolved: false, url: "",
            comments: [{ id: "1", author: "Reviewer", body: "Please handle the missing branch." }] }],
        },
      } } } });
    }, taskId);
    await clickWhenVisible('[data-testid="delivery-repo-details"]');
    await waitForText("Build workflow");
    await waitForText("Skipped deployment");
    await waitForText("skipped");
    await waitForText("src/example.ts:12 · Unresolved");
    await waitForText("Please handle the missing branch.");
  });
});
