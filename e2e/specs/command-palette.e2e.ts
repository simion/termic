import {
  waitVisible,
  waitForAppShell,
  requireTermicApi,
  openTask,
  archiveTask,
  snap,
} from "../helpers";

// P1: the command palette (⌘K). Cases: opens and lists commands; filtering
// narrows the list; running a command performs its action and closes the
// palette; Escape closes it.
describe("command palette", () => {
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().closeCommandPalette?.();
      window.__termic!.useUI.getState().closeFileFinder?.();
    });
    if (taskId) await archiveTask(taskId);
  });

  const paletteOpen = () =>
    browser.execute(() => window.__termic!.useUI.getState().commandPaletteOpen);
  const open = () =>
    browser.execute(() =>
      window.__termic!.useUI.getState().openCommandPalette(),
    );
  const rowCount = () =>
    browser.execute(() => document.querySelectorAll("[data-row]").length);
  const setQuery = (q: string) =>
    browser.execute((query) => {
      const input = document.querySelector(
        'input[placeholder*="Type a command"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, q);

  it("opens and lists commands", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-palette");
    await open();
    // Appeared + visible → continue (fast client-side check).
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    expect(await rowCount()).toBeGreaterThan(1);
  });

  it("filters the command list by query", async () => {
    const all = await rowCount();
    await setQuery("File picker");
    await browser.waitUntil(async () => (await rowCount()) < all, {
      timeout: 5_000,
      timeoutMsg: "query did not narrow the list",
    });
    const hasFilePicker = await browser.execute(() =>
      [...document.querySelectorAll("[data-row]")].some((r) =>
        r.textContent?.includes("File picker"),
      ),
    );
    expect(hasFilePicker).toBe(true);
  });

  it("activating a command runs it and closes the palette", async () => {
    // Click the File picker command row. The palette's act() runs close()
    // synchronously then defers the effect via requestAnimationFrame — and rAF
    // is frozen while this window is occluded, so we assert the synchronous
    // run wiring (palette closes), not the deferred side effect.
    await browser.execute(() => {
      const btn = [...document.querySelectorAll("[data-row]")].find((r) =>
        r.textContent?.includes("File picker"),
      );
      if (!btn) throw new Error("File picker row not found");
      (btn as HTMLElement).click();
    });
    await browser.waitUntil(async () => (await paletteOpen()) === false, {
      timeout: 5_000,
      timeoutMsg: "activating a command did not close the palette",
    });
  });

  it("closes on Escape", async () => {
    await open();
    await browser.waitUntil(async () => (await paletteOpen()) === true, {
      timeout: 5_000,
      timeoutMsg: "palette did not reopen",
    });
    await browser.execute(() => {
      const input = document.querySelector(
        'input[placeholder*="Type a command"]',
      )!;
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await browser.waitUntil(async () => (await paletteOpen()) === false, {
      timeout: 5_000,
      timeoutMsg: "Escape did not close the palette",
    });
    await snap("command-palette.png");
  });
});
