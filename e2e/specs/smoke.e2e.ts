import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  waitForAppShell,
  waitForText,
  waitForTextGone,
  clickByText,
  requireTermicApi,
} from "../helpers";

const artifacts = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".e2e",
  "artifacts",
);

// Reference spec + harness smoke test. Both `it`s share ONE launched window
// (wdio runs a spec file's tests serially in one session): boot once, assert
// many. No fixed sleeps — every wait is a condition, so runs are deterministic.
describe("termic e2e pipeline", () => {
  it("renders the shell and exposes app state", async () => {
    await waitForAppShell();
    // The e2e build exposes window.__termic — read REAL store state, not DOM.
    await requireTermicApi();
    const projectNames = await browser.execute(
      () => window.__termic!.useApp.getState().projects.map((p: any) => p.name),
    );
    expect(projectNames).toContain("fixture-repo");
    await browser.saveScreenshot(path.join(artifacts, "dashboard.png"));
  });

  it("navigates Dashboard -> History with a real click", async () => {
    // Self-establish the starting view: a prior spec/run may have left a task
    // active, so click Dashboard rather than assuming the app launched on it.
    await clickByText("Dashboard");
    await waitForText("HOME FOR YOUR CLI CODING AGENTS");
    await clickByText("History");
    await waitForTextGone("HOME FOR YOUR CLI CODING AGENTS");
    await browser.saveScreenshot(path.join(artifacts, "history.png"));
  });
});
