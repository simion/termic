import {
  waitVisible, waitForAppShell, requireTermicApi, snap } from "../helpers";

// P2: more dialogs — changelog, welcome, and the per-project Race dialog.
describe("more dialogs open", () => {
  after(async () => {
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeChangelog?.();
      ui.closeWelcome?.();
    });
  });

  const flag = (name: string) =>
    browser.execute((n) => (window.__termic!.useUI.getState() as any)[n], name);
  const dialogPresent = () =>
    browser.execute(() => !!document.querySelector('[role="dialog"]'));

  it("changelog opens and closes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => window.__termic!.useUI.getState().openChangelog());
    await browser.waitUntil(async () => (await flag("changelogOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "changelog never opened",
    });
    await browser.execute(() => window.__termic!.useUI.getState().closeChangelog());
    await browser.waitUntil(async () => (await flag("changelogOpen")) === false, {
      timeout: 5_000,
      timeoutMsg: "changelog never closed",
    });
  });

  it("welcome opens and closes", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openWelcome());
    await browser.waitUntil(async () => (await flag("welcomeOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "welcome never opened",
    });
    await waitVisible('[role="dialog"]');
    await browser.execute(() => window.__termic!.useUI.getState().closeWelcome());
    await browser.waitUntil(async () => (await flag("welcomeOpen")) === false, {
      timeout: 5_000,
      timeoutMsg: "welcome never closed",
    });
  });

  it("race dialog opens for a project", async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openRace(proj.id);
    });
    await waitVisible('[role="dialog"]', 8_000);
    await snap("dialogs2.png");
  });
});
