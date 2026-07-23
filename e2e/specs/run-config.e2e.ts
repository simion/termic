import { waitForAppShell, requireTermicApi, snap } from "../helpers";

// P1: the Run commands manager (GH #124). Guards that it opens for a project
// and closes. (Persisting a command edits projects.json; opening + rendering is
// the robust check that the dialog is wired.)
describe("run config", () => {
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeRunCommands?.(),
    );
  });

  it("opens the run commands manager for a project", async () => {
    await waitForAppShell();
    await requireTermicApi();

    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI
        .getState()
        .openRunCommands(proj.id, { label: "e2e-cmd", command: "echo hi" });
    });

    // The dialog state is set and a modal renders.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.useUI.getState().runCommandsDialog !== null &&
            !!document.querySelector('[role="dialog"]'),
        ),
      { timeout: 8_000, timeoutMsg: "run commands manager never opened" },
    );
    await snap("run-config.png");
  });
});
