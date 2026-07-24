import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveTask, clickByText, openTask, requireTermicApi, snap, waitForAppShell, waitForText, waitForTextGone, waitVisible } from "../helpers";

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
    await snap("dashboard.png");
  });

  it("navigates Dashboard -> History with a real click", async () => {
    // Self-establish the starting view: a prior spec/run may have left a task
    // active, so click Dashboard rather than assuming the app launched on it.
    await clickByText("Dashboard");
    await waitForText("HOME FOR YOUR CLI CODING AGENTS");
    await clickByText("History");
    await waitForTextGone("HOME FOR YOUR CLI CODING AGENTS");
    await snap("history.png");
  });
});

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
    // Clear any state the previous command left (its rAF-deferred effect can
    // open the file finder), then reopen and wait for the input to be visible.
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFileFinder(),
    );
    await open();
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
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

// P2: assorted dialogs/palettes open + close. Guards the wiring of the
// shortcuts help, prompt palette, and per-task broadcast dialog.
describe("dialogs & palettes open", () => {
  let taskId: string | undefined;
  after(async () => {
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState();
      ui.closeShortcutsHelp?.();
      ui.closePromptPalette?.();
      ui.closeBroadcast?.();
    });
    if (taskId) await archiveTask(taskId);
  });

  const dialogPresent = () =>
    browser.execute(() => !!document.querySelector('[role="dialog"]'));
  const flag = (name: string) =>
    browser.execute(
      (n) => (window.__termic!.useUI.getState() as any)[n],
      name,
    );

  it("shortcuts help opens and closes", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() =>
      window.__termic!.useUI.getState().openShortcutsHelp(),
    );
    await browser.waitUntil(async () => (await flag("shortcutsHelpOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "shortcuts help never opened",
    });
    await waitVisible('[role="dialog"]');
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeShortcutsHelp(),
    );
    await browser.waitUntil(
      async () => (await flag("shortcutsHelpOpen")) === false,
      { timeout: 5_000, timeoutMsg: "shortcuts help never closed" },
    );
  });

  it("prompt palette opens", async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().openPromptPalette(),
    );
    await browser.waitUntil(async () => (await flag("promptPaletteOpen")) === true, {
      timeout: 8_000,
      timeoutMsg: "prompt palette never opened",
    });
    await browser.execute(() =>
      window.__termic!.useUI.getState().closePromptPalette(),
    );
  });

  it("broadcast dialog opens for a task", async () => {
    taskId = await openTask("e2e-broadcast");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openBroadcast(id),
      taskId,
    );
    await waitVisible('[role="dialog"]', 8_000);
    await snap("dialogs-open.png");
  });
});

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
