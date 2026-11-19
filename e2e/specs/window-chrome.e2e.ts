// The window's own chrome: on Windows and Linux the app draws its title bar
// (no native frame), with minimize / maximize / close at the right of the top
// bar; on macOS the system's traffic lights sit on the app's bar. Each
// platform asserts its own shape, so a change that leaks the buttons onto
// macOS fails there too.
//
// Maximize and minimize are asked of the window MANAGER. The Linux CI display
// (Xvfb) has none, so there those two cases are skipped; run the suite with one
// on the display (`openbox &` inside the session is enough) and they run on
// Linux too. What Linux can assert without one, it always does: no frame, and
// the buttons in the corner.
//
// Close is not clicked: it would end the session every later spec runs in.
// It is the same `close()` the Rust CloseRequested handler already covers.

import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { archiveTask, controlConnect, openTask, requireTermicApi, snap, waitForAppShell, waitVisible } from "../helpers";
import { dataDir } from "../../wdio.conf.js";

const isWindows = process.platform === "win32";
/** Something is managing windows: always on Windows, on Linux only when the
 *  X display has a window manager (EWMH's _NET_SUPPORTING_WM_CHECK). */
const hasWindowManager = isWindows || (() => {
  if (process.platform !== "linux" || !process.env.DISPLAY) return false;
  try {
    return /window id # 0x[0-9a-f]+/.test(
      execFileSync("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    );
  } catch { return false; }
})();
/** Platforms where the app draws its own caption buttons. */
const drawsControls = isWindows || process.platform === "linux";

/** A Tauri window getter for the current window, through the IPC the app
 *  itself uses (core:window:default grants the getters). */
const windowState = (cmd: "is_maximized" | "is_minimized" | "is_decorated") =>
  browser.execute(async (c) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<boolean>; metadata: { currentWindow: { label: string } } };
    };
    const label = w.__TAURI_INTERNALS__.metadata.currentWindow.label;
    return w.__TAURI_INTERNALS__.invoke(`plugin:window|${c}`, { label });
  }, cmd) as unknown as Promise<boolean>;

/** Unauthenticated `raise` over the control socket: un-minimizes and shows
 *  the window, the path `termic open` uses. */
function raise(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const c: net.Socket = controlConnect(path.join(dataDir, "termic.sock"));
    c.on("error", reject);
    c.on("connect", () => c.write(JSON.stringify({ id: "e2e", cmd: "raise" }) + "\n"));
    const t = setTimeout(() => { c.destroy(); reject(new Error("raise timed out")); }, 10_000);
    c.on("data", () => { clearTimeout(t); c.end(); resolve(); });
  });
}

const clickControl = (kind: "minimize" | "maximize") =>
  browser.execute((k) => {
    (document.querySelector(`[data-testid="window-${k}"]`) as HTMLElement).click();
  }, kind);

describe("window chrome", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  it("draws the caption buttons on Windows and Linux, never on macOS", async () => {
    const present = await browser.execute(() => !!document.querySelector('[data-testid="window-controls"]'));
    expect(present).toBe(drawsControls);
  });

  (drawsControls ? it : it.skip)("has no native frame on Windows and Linux, so the app's bar is the title bar", async () => {
    expect(await windowState("is_decorated")).toBe(false);
    // The buttons sit flush with the window's top-right corner, the full
    // height of the bar, in the same order on both.
    const box = await browser.execute(() => {
      const bar = document.querySelector("header")!.getBoundingClientRect();
      const ctl = document.querySelector('[data-testid="window-controls"]')!.getBoundingClientRect();
      const order = [...document.querySelectorAll('[data-testid="window-controls"] button')]
        .map(b => (b as HTMLElement).dataset.testid);
      return { right: Math.round(window.innerWidth - ctl.right), top: Math.round(ctl.top), h: Math.round(ctl.height), barH: Math.round(bar.height), order };
    }) as { right: number; top: number; h: number; barH: number; order: string[] };
    expect(box.right).toBe(0);
    expect(box.top).toBe(0);
    expect(Math.abs(box.h - box.barH)).toBeLessThanOrEqual(1);
    expect(box.order).toEqual(["window-minimize", "window-maximize", "window-close"]);
    await snap("window-controls.png");
  });

  (hasWindowManager ? it : it.skip)("maximize toggles, and the button says which way", async () => {
    const was = await windowState("is_maximized");
    await clickControl("maximize");
    await browser.waitUntil(async () => (await windowState("is_maximized")) === !was, {
      timeout: 5_000, timeoutMsg: "the maximize button did not toggle the window",
    });
    await browser.waitUntil(
      () => browser.execute((w) =>
        document.querySelector('[data-testid="window-controls"]')?.getAttribute("data-maximized") === String(w), !was),
      { timeout: 5_000, timeoutMsg: "the button did not switch between maximize and restore" },
    );
    await snap("window-controls-toggled.png");
    // Back to how the spec found it, so later specs keep their geometry.
    await clickControl("maximize");
    await browser.waitUntil(async () => (await windowState("is_maximized")) === was, {
      timeout: 5_000, timeoutMsg: "the second click did not toggle back",
    });
  });

  (hasWindowManager ? it : it.skip)("minimize minimizes, and raise brings it back", async () => {
    await clickControl("minimize");
    await browser.waitUntil(() => windowState("is_minimized"), {
      timeout: 5_000, timeoutMsg: "the minimize button did not minimize the window",
    });
    await raise();
    await browser.waitUntil(async () => !(await windowState("is_minimized")), {
      timeout: 10_000, timeoutMsg: "raise did not restore the minimized window",
    });
    await waitVisible('[data-testid="window-controls"]');
  });
});

// GH #462: the OS title follows the active task and tab, for time trackers
// that read window titles. Read back from the window itself, since nothing in
// the page renders it.
describe("window title", () => {
  const ids: string[] = [];
  const title = () => browser.execute(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<string>; metadata: { currentWindow: { label: string } } };
    };
    return w.__TAURI_INTERNALS__.invoke("plugin:window|title", { label: w.__TAURI_INTERNALS__.metadata.currentWindow.label });
  }) as unknown as Promise<string>;
  const waitTitle = async (pred: (t: string) => boolean, msg: string) => {
    let last = "";
    await browser.waitUntil(async () => pred(last = await title()), { timeout: 8_000 })
      .catch(() => { throw new Error(`${msg}: ${JSON.stringify(last)}`); });
  };

  after(async () => { for (const id of ids) await archiveTask(id); });

  it("names the project, task and tab, and follows a task switch", async () => {
    await waitForAppShell();
    ids.push(await openTask("e2e-title-one"));
    await waitTitle(t => t.startsWith("Termic - fixture-repo / e2e-title-one - "), "the title never named the first task");
    ids.push(await openTask("e2e-title-two"));
    await waitTitle(t => t.startsWith("Termic - fixture-repo / e2e-title-two - "), "the title did not follow the switch");
  });

  it("goes back to plain Termic with no task selected", async () => {
    await browser.execute(() => window.__termic!.useApp.setState({ activeTaskId: null }));
    await waitTitle(t => t === "Termic", "the title kept a task nobody has open");
  });
});
