import {
  archiveTask,
  clickWhenVisible,
  dismissOverlays,
  openTask,
  requireTermicApi,
  setInputValue,
  snap,
  waitForAppShell,
  waitForAgentPty,
  waitForAgentReady,
  waitGone,
  waitVisible,
} from "../helpers.js";

const DIALOG = '[data-testid="task-finder"]';
const INPUT = '[data-testid="task-finder-input"]';
const STATUS = '[data-testid="task-finder-status"]';

describe("task finder dialog", () => {
  let t1 = "";
  let t2 = "";
  let t3 = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();

    t1 = await openTask("finder-alpha", true, "fakeagent");
    t2 = await openTask("finder-bravo", false, "fakeagent");
    t3 = await openTask("finder-charlie", false, "fakeagent");

    // radix keeps a closing dialog mounted until its exit animation ends, and
    // WebKit freezes animations while the window reads as occluded, so a
    // waitGone after Escape could wait forever. Skip the animations here.
    await browser.execute(() => {
      const s = document.createElement("style");
      s.id = "tf-noanim";
      s.textContent = ".termic-pop[data-state],.termic-backdrop[data-state]{animation:none!important}";
      document.head.appendChild(s);
    });
  });

  after(async () => {
    await browser.execute(() => document.getElementById("tf-noanim")?.remove());
    await dismissOverlays();
    for (const id of [t1, t2, t3]) {
      if (id) await archiveTask(id);
    }
  });

  it("opens via shortcut with Open selected and can switch to All", async () => {
    const isMac = process.platform === "darwin";
    // the shortcut picks Open only when a task has a live agent, read once at
    // open time, so wait for one before pressing it.
    await waitForAgentPty(t1);
    // Open via ⌘O / Ctrl+O keyboard event
    await browser.execute((mac) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "o",
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
        }),
      );
    }, isMac);
    await waitVisible(DIALOG);
    await waitVisible(INPUT);
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector('[data-testid="task-finder-filter-open"]')?.getAttribute("data-active") === "true"));

    // Ensure dialog animation settles for snapshot in unfocused test runner
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.style.animation = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }, DIALOG);

    // The shortcut always starts with Open selected.
    await snap("task-finder-idle.png");

    await browser.execute((mac, selector) => {
      document.querySelector(selector)!.dispatchEvent(new KeyboardEvent("keydown", {
        key: "1", code: "Digit1", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true,
      }));
    }, isMac, INPUT);
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector('[data-testid="task-finder-filter-all"]')?.getAttribute("data-active") === "true"));

    // Close with Escape
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);
  });

  it("opens from the command palette with All, then searches and switches tasks", async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().openCommandPalette();
    });
    const paletteInput = 'input[placeholder*="Type a command"]';
    await waitVisible(paletteInput);
    await setInputValue(paletteInput, "task finder");
    await clickWhenVisible('[data-cmd-id="task-finder"]');
    await waitVisible(DIALOG);
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector('[data-testid="task-finder-filter-all"]')?.getAttribute("data-active") === "true"));

    // Ensure dialog animation settles
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.style.animation = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }, DIALOG);

    // Type filter query
    await setInputValue(INPUT, "bravo");

    // Filter snapshot showing matching tasks
    await snap("task-finder-filtered.png");

    // Select with Enter
    await browser.keys(["Enter"]);
    await waitGone(DIALOG);

    // Active task should now be t2 (bravo)
    const active = await browser.execute(() => window.__termic!.useApp.getState().activeTaskId);
    expect(active).toBe(t2);
  });

  it("shows status on the right and filters by status query", async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().openTaskFinder();
    });
    await waitVisible(DIALOG);
    await waitVisible(INPUT);
    await waitVisible(STATUS);

    // Ensure dialog animation settles
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.style.animation = "none";
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }, DIALOG);

    // Search by status query
    await setInputValue(INPUT, "status:not-started");
    await snap("task-finder-status-filtered.png");

    // Close with Escape
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);
  });

  it("filters open agents with shortcut 7, search text, and the footer toggle", async () => {
    await waitForAgentReady(t1);
    await waitForAgentReady(t2);
    // Put Charlie to sleep through the same action as closing its last tab.
    await browser.execute((id) => {
      const app = window.__termic!.useApp.getState();
      for (const tab of app.tabs[id] ?? []) app.closeTab(id, tab.id);
      window.__termic!.useUI.getState().openTaskFinder();
    }, t3);
    await waitVisible(DIALOG);
    await waitVisible(INPUT);

    const pressFilter = async (key: string) => browser.execute((k, mac, selector) => {
      document.querySelector(selector)!.dispatchEvent(new KeyboardEvent("keydown", {
        key: k, code: `Digit${k}`, metaKey: mac, ctrlKey: !mac,
        bubbles: true, cancelable: true,
      }));
    }, key, process.platform === "darwin", INPUT);
    const rows = async () => browser.execute((selector) =>
      Array.from(document.querySelectorAll(`${selector} [data-row]`), row => row.textContent ?? "").join(" "), DIALOG);
    const active = async (name: string) => browser.execute((n) =>
      document.querySelector(`[data-testid="task-finder-filter-${n}"]`)?.getAttribute("data-active") === "true", name);

    await pressFilter("7");
    await browser.waitUntil(async () => await active("open") && (await rows()).includes("finder-alpha"));
    expect(await rows()).toContain("finder-bravo");
    expect(await rows()).not.toContain("finder-charlie");
    await snap("task-finder-open.png");

    await setInputValue(INPUT, "bravo");
    await browser.waitUntil(async () => (await rows()).includes("finder-bravo") && !(await rows()).includes("finder-alpha"));
    await pressFilter("1");
    await setInputValue(INPUT, "is:open");
    await browser.waitUntil(async () => await active("open"));
    expect(await rows()).not.toContain("finder-charlie");

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="task-finder-filter-open"]')!.click();
    });
    await browser.waitUntil(async () => await active("all") && (await rows()).includes("finder-charlie"));
    expect(await browser.execute((selector) => document.activeElement === document.querySelector(selector), INPUT)).toBe(true);
    await snap("task-finder-all-filters.png");
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);
  });

  it("falls back to All on shortcut opening after all agents close, while explicit Open stays empty", async () => {
    await browser.execute(() => {
      const app = window.__termic!.useApp.getState();
      for (const taskId of Object.keys(app.tabs)) {
        for (const tab of app.tabs[taskId] ?? []) app.closeTab(taskId, tab.id);
      }
    });
    const shortcut = async (key: string) => browser.execute((k, mac) => {
      const target = document.querySelector('[data-testid="task-finder-input"]') ?? window;
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: k, code: k === "o" ? "KeyO" : `Digit${k}`,
        metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true,
      }));
    }, key, process.platform === "darwin");
    const active = async (name: string) => browser.execute((n) =>
      document.querySelector(`[data-testid="task-finder-filter-${n}"]`)?.getAttribute("data-active") === "true", name);
    const rowText = async () => browser.execute((selector) =>
      Array.from(document.querySelectorAll(`${selector} [data-row]`), row => row.textContent ?? "").join(" "), DIALOG);

    await shortcut("o");
    await waitVisible(DIALOG);
    await browser.waitUntil(async () => await active("all") && (await rowText()).includes("finder-alpha"));
    expect(await rowText()).toContain("finder-bravo");
    expect(await rowText()).toContain("finder-charlie");
    await snap("task-finder-open-fallback.png");

    await shortcut("7");
    await browser.waitUntil(async () => await active("open") && (await rowText()) === "");
    expect(await browser.execute((selector) => document.querySelector(selector)?.textContent, DIALOG)).toContain("No matching tasks");
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);

    await shortcut("o");
    await waitVisible(DIALOG);
    await browser.waitUntil(async () => await active("all") && (await rowText()).includes("finder-alpha"));
    await browser.keys(["Escape"]);
    await waitGone(DIALOG);
  });
});
