import {
  waitForAppShell,
  requireTermicApi,
  clickByText,
  snap,
} from "../helpers";

// Theme switching is a visible, frequently-used preference. Guards that
// picking a theme updates the prefs store AND applies the palette class to
// <html> (the actual rendering surface).
describe("theme switching", () => {
  let original: string | undefined;
  after(async () => {
    if (original) {
      await browser.execute(
        (m) => window.__termic!.usePrefs.getState().setThemeMode(m),
        original,
      );
    }
  });

  const openPicker = () =>
    browser.execute(() => {
      // The picker trigger is the Sun/Moon button in the top bar; it opens on
      // hover, so dispatch the enter/over events React's onMouseEnter watches.
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.querySelector("svg.lucide-sun, svg.lucide-moon"),
      );
      if (!btn) throw new Error("theme picker trigger not found");
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });

  it("switches theme via the picker and applies it to <html>", async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await browser.execute(
      () => window.__termic!.usePrefs.getState().themeMode,
    );

    await openPicker();
    await clickByText("Light");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.usePrefs.getState().themeMode === "light" &&
            document.documentElement.classList.contains("light"),
        ),
      { timeout: 8_000, timeoutMsg: "Light theme was not applied to <html>" },
    );

    await openPicker();
    await clickByText("Dark+");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            window.__termic!.usePrefs.getState().themeMode === "dark" &&
            document.documentElement.classList.contains("dark"),
        ),
      { timeout: 8_000, timeoutMsg: "Dark theme was not applied to <html>" },
    );

    await snap("theme.png");
  });
});
