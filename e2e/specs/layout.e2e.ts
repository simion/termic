import { waitForAppShell, requireTermicApi, artifact } from "../helpers";

// P2: layout state. Guards the sidebar width setter (persisted layout pref).
describe("layout", () => {
  let original: number | undefined;
  const width = () =>
    browser.execute(() => window.__termic!.useApp.getState().sidebarWidth);

  after(async () => {
    if (original !== undefined) {
      await browser.execute(
        (w) => window.__termic!.useApp.getState().setSidebarWidth(w),
        original,
      );
    }
  });

  it("sets the sidebar width", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = (await width()) as number;
    await browser.execute(() =>
      window.__termic!.useApp.getState().setSidebarWidth(320),
    );
    await browser.waitUntil(async () => (await width()) === 320, {
      timeout: 5_000,
      timeoutMsg: "sidebar width never applied",
    });
    await browser.saveScreenshot(artifact("layout.png"));
  });
});
