import {
  waitForAppShell,
  requireTermicApi,
  waitForText,
  snap,
} from "../helpers";

// Settings/preferences subsystem. Guards that a real toggle in the Settings
// overlay flips the pref in the prefs store and the control reflects it.
describe("settings", () => {
  const LABEL = "Work-in-progress indicator";
  let original: boolean | undefined;

  after(async () => {
    // Restore the pref so repeated runs start from the same state (prefs
    // persist to the profile's settings.json).
    if (original === undefined) return;
    await browser.execute((v) => {
      window.__termic!.usePrefs.getState().setWorkingIndicator(v);
    }, original);
  });

  it("toggles a preference and it lands in the prefs store", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Open Settings -> General (the same action the sidebar gear fires).
    await browser.execute(() =>
      window.__termic!.useApp.getState().openSettings("general"),
    );
    await waitForText(LABEL);

    original = await browser.execute(
      () => window.__termic!.usePrefs.getState().workingIndicator,
    );

    // Click the actual toggle switch in that setting's row.
    await browser.execute((lbl) => {
      const labelEl = [...document.querySelectorAll("div")].find(
        (d) => d.textContent?.trim() === lbl,
      );
      const sw = labelEl
        ?.closest(".justify-between")
        ?.querySelector('[role="switch"]') as HTMLElement | null;
      if (!sw) throw new Error("toggle switch not found for: " + lbl);
      sw.click();
    }, LABEL);

    // The prefs store must reflect the flip (poll, don't sleep).
    await browser.waitUntil(
      () =>
        browser.execute(
          (orig) =>
            window.__termic!.usePrefs.getState().workingIndicator !== orig,
          original,
        ),
      { timeout: 8_000, timeoutMsg: "workingIndicator pref never changed" },
    );

    // ...and the switch's aria-checked must agree with the new store value.
    const now = await browser.execute(
      () => window.__termic!.usePrefs.getState().workingIndicator,
    );
    const checked = await browser.execute((lbl) => {
      const labelEl = [...document.querySelectorAll("div")].find(
        (d) => d.textContent?.trim() === lbl,
      );
      return labelEl
        ?.closest(".justify-between")
        ?.querySelector('[role="switch"]')
        ?.getAttribute("aria-checked");
    }, LABEL);
    expect(checked).toBe(String(now));

    await snap("settings.png");
  });
});
