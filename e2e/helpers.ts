// Shared building blocks for termic e2e specs. Keep spec files short and
// declarative by using these; when the UI changes, fix the flow in ONE place.
// See the `e2e` skill for the full authoring guide.

import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".e2e",
  "artifacts",
);

/** Absolute path under .e2e/artifacts/ (created in wdio.conf onPrepare). */
export function artifact(name: string): string {
  return path.join(artifactsDir, name);
}

/**
 * Save a screenshot for LOCAL debugging only. No-op in CI (`process.env.CI`)
 * and never throws — screenshots are garnish, not assertions, and a runner has
 * no display / Screen-Recording permission.
 */
export async function snap(name: string): Promise<void> {
  if (process.env.CI) return;
  try {
    await browser.saveScreenshot(artifact(name));
  } catch {
    /* no display / permission — ignore */
  }
}

/**
 * The stores + ipc handle exposed on `window.__termic` in the e2e binary
 * (main.tsx, gated on VITE_E2E). Lets specs read real app state and drive
 * real IPC instead of scraping the DOM. Typed loosely on purpose — mirror
 * the shapes from src/store/* as you need them in a given spec.
 */
export interface TermicApi {
  useApp: { getState: () => any; setState: (p: any) => void };
  useUI: { getState: () => any; setState: (p: any) => void };
  usePrefs: { getState: () => any };
  useRace: { getState: () => any };
  ipc: any;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  runTabs: any;
  scriptRuns: { getState: () => any };
  usePromptLibrary: { getState: () => any };
  signalLog: {
    recordTitle: (agentId: string, title: string, classified: string | null) => void;
    noteSubmit: (agentId: string) => void;
    noteDone: (agentId: string, restingTitle: string | null) => void;
    startCapture: (agentId: string) => void;
    stopCapture: () => void;
    resetSignalLog: (agentId?: string) => void;
    observationsFor: (agentId: string) => Array<{ title: string; seen: number }>;
  };
  agentRace: {
    startRace: (opts: {
      projectId: string;
      racers: { cli: string; n: number }[];
      prompt: string;
      name?: string;
      branch?: string;
      sandbox?: boolean;
      yolo?: boolean;
    }) => Promise<string[]>;
  };
}

declare global {
  interface Window {
    __termic?: TermicApi;
  }
}

/**
 * Playwright-style waits, done with a FAST client-side visibility check inside
 * the webview (getBoundingClientRect + computed style) — NOT WebdriverIO's
 * native isDisplayed/waitForDisplayed, which triggers slow Tauri window-state
 * calls on our offscreen window. Poll interval is the config's 100ms, so these
 * fire the instant the element appears + is visible.
 */
export async function waitVisible(selector: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          st.visibility !== "hidden" &&
          st.display !== "none" &&
          st.opacity !== "0"
        );
      }, selector),
    { timeout, timeoutMsg: `never became visible: ${selector}` },
  );
}

/** Wait for the element to appear + be visible, then click it. */
export async function clickWhenVisible(selector: string, timeout = 15_000): Promise<void> {
  await waitVisible(selector, timeout);
  await browser.execute((sel) => {
    (document.querySelector(sel) as HTMLElement).click();
  }, selector);
}

/** Wait until the selector is gone from the DOM. */
export async function waitGone(selector: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((sel) => !document.querySelector(sel), selector),
    { timeout, timeoutMsg: `never disappeared: ${selector}` },
  );
}

/** Wait for React to mount the app shell (not a fixed sleep). */
export async function waitForAppShell(timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const root = document.getElementById("root");
        return !!root && root.children.length > 0;
      }),
    { timeout, interval: 250, timeoutMsg: "app shell (#root) never rendered" },
  );
}

/**
 * Click a control by its exact visible text (semantic, resilient to markup
 * and class churn). Throws if nothing matches, so a broken selector fails
 * loudly instead of silently no-op'ing.
 */
export async function clickByText(text: string): Promise<void> {
  await browser.execute((t) => {
    const el = [
      ...document.querySelectorAll("button, a, [role='button']"),
    ].find((e) => e.textContent?.trim() === t);
    if (!el) throw new Error(`no clickable element with text: ${t}`);
    (el as HTMLElement).click();
  }, text);
}

/**
 * Click a dropdown/menu entry by its exact visible text. Scoped to
 * `[role='menuitem']` so it never collides with same-named buttons elsewhere
 * (e.g. the footer "Terminal" vs. the "+" menu's "Terminal").
 */
export async function clickMenuItem(text: string): Promise<void> {
  await browser.execute((t) => {
    const el = [...document.querySelectorAll("[role='menuitem']")].find(
      (e) => e.textContent?.trim() === t,
    );
    if (!el) throw new Error(`no menu item with text: ${t}`);
    (el as HTMLElement).click();
  }, text);
}

/** Wait until the given substring is present in the visible body text. */
export async function waitForText(needle: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((n) => document.body.innerText.includes(n), needle),
    { timeout, timeoutMsg: `text never appeared: ${needle}` },
  );
}

/** Wait until the given substring is GONE from the visible body text. */
export async function waitForTextGone(needle: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((n) => !document.body.innerText.includes(n), needle),
    { timeout, timeoutMsg: `text never disappeared: ${needle}` },
  );
}

/**
 * Create a repo-root task in the seeded `fixture-repo` via the app's own IPC
 * (fast + robust vs. the create wizard) using the claude-like `fakeagent`.
 * Repo-root: archiving/deleting it never touches a worktree. Returns its id.
 */
export async function openTask(name: string, activate = true): Promise<string> {
  return browser.execute(
    async (n, act) => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", n);
      await t.useApp.getState().loadAll();
      if (act) t.useApp.getState().setActiveTask(task.id);
      return task.id as string;
    },
    name,
    activate,
  );
}

/**
 * Make `taskId` the active task and wait for it. Spec files run serially but
 * reuse the same window, so an earlier file's task can still be the active one
 * — re-assert before anything that drags real elements, since a drag reads the
 * DOM of whichever task is on screen.
 */
export async function ensureActiveTask(taskId: string): Promise<void> {
  await browser.execute((id) => {
    if (window.__termic!.useApp.getState().activeTaskId !== id) {
      window.__termic!.useApp.getState().setActiveTask(id);
    }
  }, taskId);
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => window.__termic!.useApp.getState().activeTaskId === id,
        taskId,
      ),
    { timeout: 8_000, timeoutMsg: `task ${taskId} never became active` },
  );
}

/** Archive a task and refresh the store (cleanup between runs). */
export async function archiveTask(id: string): Promise<void> {
  await browser.execute(async (i) => {
    await window.__termic!.ipc.taskArchive(i);
    await window.__termic!.useApp.getState().loadAll();
  }, id);
}

/**
 * Close every overlay and drop any orphaned dialog backdrop.
 *
 * Radix overlays unmount on an rAF-driven exit animation, and rAF is frozen
 * while the window is occluded — so a dialog closed by an EARLIER spec file
 * can leave a full-screen `.termic-backdrop` in the DOM forever. Clicks don't
 * care (`.click()` skips hit testing) but every drag does: the backdrop eats
 * elementFromPoint and the drop silently lands on nothing.
 *
 * Removing it is safe because the suite is serial (`maxInstances: 1` in
 * wdio.conf.ts): anything still standing when a spec starts belongs to a spec
 * that already finished. Call this before drag-driven cases.
 */
export async function dismissOverlays(): Promise<void> {
  await browser.execute(() => {
    const ui = window.__termic!.useUI.getState();
    ui.closeFileFinder();
    ui.closeFindInFiles();
    ui.closeProjectPicker();
    ui.closeCommandPalette();
    ui.closePromptPalette();
  });
  await browser.keys(["Escape"]);
  await browser.execute(() => {
    // Dialog backdrops, plus any dropdown/context menu still portaled to
    // <body> (Radix wraps popper content in its own div). Menus float over
    // whatever is beneath them, so a stale one blocks drags the same way.
    //
    // Make them transparent to hit testing — do NOT remove them. These nodes
    // are React-managed: detaching one makes React throw when it later tries
    // to unmount it, and an error thrown during commit tears down the whole
    // root, leaving `#root` empty for every spec that follows.
    document
      .querySelectorAll<HTMLElement>(".termic-backdrop, .termic-pop, [data-radix-popper-content-wrapper]")
      .forEach((el) => { el.style.pointerEvents = "none"; });
    // Radix parks `pointer-events: none` on <body> while a modal is open and
    // restores it on close. A dialog that never finished closing leaves it
    // stuck, and then EVERY elementFromPoint returns <html> — the whole app
    // becomes untargetable by drags while still looking normal.
    if (document.body.style.pointerEvents === "none") {
      document.body.style.pointerEvents = "";
    }
  });
}

/**
 * Where inside an element's rect a drag grabs or lands. Edge anchors sit ~8%
 * in, which is inside the 20% band `lib/dropZones` reads as a split zone, and
 * far enough past a neighbour's midpoint to trigger a reorder.
 */
export type DragAnchor = "center" | "left" | "right" | "top" | "bottom";

/**
 * Drive one of the app's drags: press on `from`, cross the drag threshold,
 * travel to `to`, release. EVERY drag in termic is pointer-based (WKWebView's
 * native drag is unreliable and Tauri intercepts it for file drops), so this
 * drives real pointerdown/pointermove/pointerup — there is no HTML5 dnd to
 * simulate. Moves are dispatched on the element under the cursor so they reach
 * handlers bound to `window` (tabs) and to `document` (sidebar) alike.
 *
 * WebDriver cannot start a real OS drag, so this exercises the app's handlers,
 * not WebKit's gesture recognition.
 */
export async function pointerDrag(
  from: string,
  to: string,
  opts: { grab?: DragAnchor; land?: DragAnchor; landOn?: string } = {},
): Promise<void> {
  // Every drop in the app is hit-tested with elementFromPoint, so a stray
  // overlay makes the drag silently do nothing. Check first and fail naming
  // what is in the way, instead of timing out on the outcome assertion.
  // What the topmost element at the drop point must resolve to. Defaults to
  // the target itself; override when the app's own hit test is looser than
  // containment — e.g. the main pane's content is painted by a SIBLING layer
  // (TaskView's flat content layer), so the element under the cursor is a
  // `[data-main-content]` that is not inside the pane chrome we aim at.
  const accept = opts.landOn ?? to;
  const covering = () =>
    browser.execute(
      (sel, a, acceptSel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return `missing: ${sel}`;
        // A row scrolled out of its list has a rect outside the viewport, so
        // elementFromPoint lands on <html> and every drop misses. Bring it into
        // view first, exactly as a user would before reaching for it.
        el.scrollIntoView({ block: "nearest" });
        const r = el.getBoundingClientRect();
        const ix = Math.max(6, r.width * 0.08), iy = Math.max(6, r.height * 0.08);
        const p =
          a === "left" ? { x: r.left + ix, y: r.top + r.height / 2 }
          : a === "right" ? { x: r.right - ix, y: r.top + r.height / 2 }
          : a === "top" ? { x: r.left + r.width / 2, y: r.top + iy }
          : a === "bottom" ? { x: r.left + r.width / 2, y: r.bottom - iy }
          : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const hit = document.elementFromPoint(p.x, p.y) as HTMLElement | null;
        if (!hit) return "nothing";
        if (hit.closest(acceptSel)) return "ok";
        // Name the blocker AND its ancestry — "which dialog is this?" is the
        // only question worth answering when a drop point is covered.
        const path: string[] = [];
        for (let el: Element | null = hit; el && path.length < 4; el = el.parentElement) {
          const cls = typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
          path.push(el.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
        }
        return path.join(" < ");
      },
      to,
      opts.land ?? "center",
      accept,
    );
  // A leftover backdrop from an earlier spec file would eat the drop; clear
  // orphans first, then wait for the point to actually resolve to the target.
  if ((await covering()) !== "ok") await dismissOverlays();
  await browser
    .waitUntil(async () => (await covering()) === "ok", { timeout: 8_000 })
    .catch(async () => {
      throw new Error(`drop point for ${to} is not reachable: ${await covering()}`);
    });

  await browser.execute(
    (fromSel, toSel, grab, land) => {
      const src = document.querySelector(fromSel) as HTMLElement | null;
      const dst = document.querySelector(toSel) as HTMLElement | null;
      if (!src) throw new Error(`drag source not found: ${fromSel}`);
      if (!dst) throw new Error(`drag target not found: ${toSel}`);
      // Both ends must be on screen before measuring: a rect outside the
      // viewport puts the whole gesture where nothing can receive it.
      dst.scrollIntoView({ block: "nearest" });
      src.scrollIntoView({ block: "nearest" });
      const point = (el: HTMLElement, a: string) => {
        const r = el.getBoundingClientRect();
        const ix = Math.max(6, r.width * 0.08);
        const iy = Math.max(6, r.height * 0.08);
        if (a === "left") return { x: r.left + ix, y: r.top + r.height / 2 };
        if (a === "right") return { x: r.right - ix, y: r.top + r.height / 2 };
        if (a === "top") return { x: r.left + r.width / 2, y: r.top + iy };
        if (a === "bottom") return { x: r.left + r.width / 2, y: r.bottom - iy };
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const start = point(src, grab);
      const end = point(dst, land);
      const fire = (type: string, x: number, y: number, node: EventTarget) =>
        node.dispatchEvent(
          new PointerEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            pointerType: "mouse",
            bubbles: true,
            cancelable: true,
          }),
        );
      // Dispatch on whatever is under the cursor: the event then bubbles to
      // BOTH document and window, whichever the drag listens on.
      const under = (x: number, y: number) =>
        (document.elementFromPoint(x, y) as HTMLElement | null) ?? document.body;

      fire("pointerdown", start.x, start.y, src);
      // A deliberate first hop past every threshold in the app (4-5px), then
      // interpolated steps so live-reordering drags see the intermediate
      // positions they react to.
      const dx = end.x - start.x, dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const kickX = start.x + (dx / len) * 12, kickY = start.y + (dy / len) * 12;
      fire("pointermove", kickX, kickY, under(kickX, kickY));
      const STEPS = 6;
      for (let i = 1; i <= STEPS; i++) {
        const x = start.x + (dx * i) / STEPS;
        const y = start.y + (dy * i) / STEPS;
        fire("pointermove", x, y, under(x, y));
      }
      fire("pointerup", end.x, end.y, under(end.x, end.y));
    },
    from,
    to,
    opts.grab ?? "center",
    opts.land ?? "center",
  );
}

/**
 * Drag a `ResizeHandle` by (dx, dy). Resize handles listen for MOUSE events
 * (not pointer, unlike every other drag in the app), and `onDrag` gets the
 * delta since the LAST move, so this walks the distance in steps.
 *
 * The steps yield to the event loop between moves: handlers like the sidebar's
 * re-measure the rendered width on every move, so a burst of synchronous moves
 * would all read the same pre-React-commit width and only the last delta would
 * stick. (A timer, not rAF — rAF is frozen while the window is occluded.)
 */
export async function mouseDrag(handle: string, dx: number, dy = 0): Promise<void> {
  await browser.execute(
    async (sel, x, y) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`resize handle not found: ${sel}`);
      const r = el.getBoundingClientRect();
      const sx = r.left + r.width / 2, sy = r.top + r.height / 2;
      const fire = (type: string, cx: number, cy: number, node: EventTarget) =>
        node.dispatchEvent(
          new MouseEvent(type, { clientX: cx, clientY: cy, button: 0, buttons: 1, bubbles: true, cancelable: true }),
        );
      const settle = () => new Promise((res) => setTimeout(res, 20));
      fire("mousedown", sx, sy, el);
      const STEPS = 4;
      for (let i = 1; i <= STEPS; i++) {
        fire("mousemove", sx + (x * i) / STEPS, sy + (y * i) / STEPS, window);
        await settle();
      }
      fire("mouseup", sx + x, sy + y, window);
    },
    handle,
    dx,
    dy,
  );
}

/** Assert `window.__termic` is present (i.e. the e2e build exposed state). */
export async function requireTermicApi(): Promise<void> {
  const ok = await browser.execute(() => !!window.__termic);
  if (!ok) {
    throw new Error(
      "window.__termic missing — rebuild with `make e2e` (VITE_E2E=1). See the e2e skill.",
    );
  }
}
