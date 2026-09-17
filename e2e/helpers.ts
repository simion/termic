// Shared building blocks for termic e2e specs. Keep spec files short and
// declarative by using these; when the UI changes, fix the flow in ONE place.
// See the `e2e` skill for the full authoring guide.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../wdio.conf.js";

const socketPath = path.join(dataDir, "termic.sock");
/** Per-boot CLI token, read fresh: the app rewrites it on every launch. */
const cliToken = () => fs.readFileSync(path.join(dataDir, "cli-token"), "utf8").trim();

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
  useApp: {
    getState: () => any;
    setState: (p: any) => void;
    /** Zustand's own subscribe, for watching a value CHANGE rather than
     *  sampling it: a poll cannot see a state that is restored before the
     *  next tick, and "when did it change" is often the whole question. */
    subscribe: (fn: (s: any, prev: any) => void) => () => void;
  };
  useUI: { getState: () => any; setState: (p: any) => void };
  usePrefs: { getState: () => any };
  useRace: { getState: () => any };
  /** PR/MR store (src/store/pr.ts). Specs seed `byTask` directly to render
   *  card states without a real forge/network. */
  usePr: { getState: () => any; setState: (p: any) => void };
  /** One pass of the background PR status poller (GH #281): the real one
   *  ticks on a multi-minute cadence and has no on-screen trigger. */
  prStatusPassNow: () => Promise<void>;
  /** Git half of the derived phase (src/store/taskGit.ts). `refresh(id, true)`
   *  is the one a spec wants between two steps seconds apart: the unforced
   *  call and `taskGitPassNow` both honour the 30s per-task floor, so the
   *  second of two consecutive reads would silently be a no-op. */
  useTaskGit: {
    getState: () => { byTask: Record<string, any>; refresh: (taskId: string, force?: boolean) => Promise<void> };
    setState: (p: any) => void;
  };
  /** One pass of the dashboard-scoped git poller, floor and all. Exposed for
   *  the same reason `prStatusPassNow` is: the pass only ticks while the
   *  dashboard is mounted and there is nothing on screen to press. */
  taskGitPassNow: () => Promise<void>;
  /** Profiles registry as this window sees it (src/store/profiles.ts, GH
   *  #280). Read for setup/teardown; the strip is what the spec asserts on. */
  useProfiles: { getState: () => any; setState: (p: any) => void };
  /** Plan usage (src/store/agentUsage.ts). Seeded by specs: no fixture agent
   *  reports a real reading. */
  useAgentUsage: { getState: () => any; setState: (p: any) => void };
  /** Dismissed "Usage unknown" labels (src/store/usageUnknownDismissed.ts). */
  useUsageUnknownDismissed: { getState: () => any; setState: (p: any) => void };
  ipc: any;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  runTabs: any;
  scriptRuns: { getState: () => any };
  usePromptLibrary: { getState: () => any };
  /** Issue -> task composition (src/lib/issuePrompt.ts). */
  issuePrompt: { buildIssuePrompt: (issue: any) => string };
  /** Prompt seeding into a fresh agent (src/lib/seedPrompt.ts). */
  seedPrompt: {
    seedPromptWhenReady: (taskId: string, prompt: string, settleMs?: number, deadlineMs?: number) => void;
  };
  signalLog: {
    recordTitle: (agentId: string, title: string, classified: string | null) => void;
    noteSubmit: (agentId: string) => void;
    noteDone: (agentId: string, restingTitle: string | null) => void;
    startCapture: (agentId: string) => void;
    stopCapture: () => void;
    resetSignalLog: (agentId?: string) => void;
    observationsFor: (agentId: string) => Array<{ title: string; seen: number }>;
  };
  /** `termic://` deep links (GH #192). `handleDeepLink` takes the raw URL
   *  string Rust would have queued — WebDriver cannot ask macOS to open a
   *  URL scheme, so specs enter at the parse step instead. */
  deepLink: {
    handleDeepLink: (url: string) => void;
    MAX_PROMPT_CHARS: number;
  };
  /** GH #245: configurable browser for preview URLs + terminal links. */
  previewBrowser: {
    openWebUrl: (url: string, browser: string) => Promise<void>;
    openWebUrlForProject: (
      url: string, globalCmd: string | undefined,
      project: { preview_browser?: string } | null | undefined,
    ) => Promise<void>;
    resolveBrowserCommand: (g: string | undefined, p: string | undefined) => string;
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
  /** Tasks mid-creation (GH #242 — non-blocking worktree create). Seeding an
   *  entry directly lets specs catch PendingTaskRow / CreatingTaskPane in
   *  their "creating" state without racing the fixture repo's near-instant
   *  real worktree add. */
  usePendingTasks: { getState: () => any };
  /** Tasks mid-archive (GH #246 — non-blocking archive). Same trick as
   *  usePendingTasks: the fixture repo's archive is far too fast to catch the
   *  "Archiving…" row by racing a real one. */
  useArchivingTasks: { getState: () => any };
  /** CodeMirror's indentation facet, for asserting what a file was detected
   *  as (lib/detectIndent). */
  cm: {
    indentUnit: unknown;
    startCompletion: (view: unknown) => boolean;
    /** `syntaxTree(state)` — how far the grammar has actually parsed. A spec
     *  that asks the DOM whether the screen is highlighted races the parse;
     *  this is the state the highlight is derived from. */
    syntaxTree: (state: unknown) => { length: number };
  };
  /** Code-intelligence grants (GH #174): which checkouts may run a language
   *  server, and which tasks hold that grant open. Never persisted. */
  useCodeIntel: { getState: () => any; setState: (p: any) => void };
  /** The whole code-intel module: `useCodeIntel` plus `grantKey`, since a
   *  grant is keyed by (checkout, server). */
  codeIntel: { useCodeIntel: any; grantKey: (root: string, server: string) => string };
  /** Live per-server phase (starting / indexing / ready / failed). */
  lspStatus: { useLspStatus: any; statusKey: (root: string, server: string) => string };
  /** The jump trail behind Back / Forward. */
  navHistory: { useNavHistory: any };
  /** This page load's stamp, which every server it starts carries. A reload
   *  cannot be simulated from inside a spec, so the reap is driven with a
   *  DIFFERENT id, which is exactly what the next page load would send. */
  lspPageId: string;
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
 * Open one of the right panel's tabs.
 *
 * By test id, never by text: the tab renders its change count INSIDE the
 * button, so "Git" reads as "Git29" the moment the checkout is dirty, and
 * clickByText matches exact text. That made every spec that opens the Git tab
 * depend on a clean fixture repo, which is not something a spec running tenth
 * in a suite can assume: the whole "git dirty tree" block failed with "no
 * clickable element with text: Git" whenever an earlier spec left a file
 * behind, and passed when git.e2e ran alone.
 */
export async function openRightTab(label: "All files" | "Git"): Promise<void> {
  await browser.execute((l) => {
    const el = document.querySelector(
      `[data-testid="right-tab"][data-tab="${l}"]`,
    ) as HTMLElement | null;
    if (!el) throw new Error(`no right-panel tab: ${l}`);
    el.click();
  }, label);
}

/**
 * Click a control by its exact visible text (semantic, resilient to markup
 * and class churn). Throws if nothing matches, so a broken selector fails
 * loudly instead of silently no-op'ing.
 *
 * Not for anything that can grow a badge or a count: see openRightTab.
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

/**
 * Click a menu entry and keep clicking it until the menu actually reacts.
 *
 * Radix remounts a menu's content whenever what it renders changes (the "+"
 * menu's Worktree / Main checkout flip is the one that bites here), and a
 * click dispatched into that remount lands on a node React is replacing: it
 * does nothing, the menu stays open, and the spec then waits out its timeout
 * on a prompt nobody opened. Settling the menu first narrows that window but
 * cannot close it, because the read and the click are two separate round
 * trips and the remount can start between them.
 *
 * Retrying is what closes it. `doneSelector` is what the click is supposed to
 * produce (the inline name input, a dialog); once it is there, or once the
 * item is gone because the menu closed, this stops clicking, so a landed
 * click is never repeated into a second task.
 */
export async function clickMenuItemUntil(
  text: string,
  doneSelector: string,
  timeout = 15_000,
): Promise<void> {
  try {
    await browser.waitUntil(
      () =>
        browser.execute(
          (t, sel) => {
            const done = document.querySelector(sel) as HTMLElement | null;
            if (done) {
              const r = done.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return true;
            }
            const el = [...document.querySelectorAll("[role='menuitem']")].find(
              (e) =>
                e.textContent?.trim() === t &&
                e.getBoundingClientRect().width > 0,
            );
            // No item and no result yet: the menu is mid-remount, or the click
            // landed and its result has not painted. Either way, wait.
            if (el) (el as HTMLElement).click();
            return false;
          },
          text,
          doneSelector,
        ),
      { timeout, interval: 250, timeoutMsg: `menu item "${text}" never produced ${doneSelector}` },
    );
  } catch (e) {
    // The click going nowhere and the click landing on a prompt that never
    // painted look identical from the timeout alone, and this only reproduces
    // on CI — so report the DOM that produced it rather than the deadline.
    const state = await browser.execute(
      (t, sel) => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)}`;
        };
        return {
          menus: [...document.querySelectorAll('[role="menu"]')].map(
            (m) => `${box(m)} state=${m.getAttribute("data-state")}`,
          ),
          items: [...document.querySelectorAll('[role="menuitem"]')]
            .filter((e) => e.textContent?.trim() === t)
            .map((e) => `${box(e)} state=${e.closest('[role="menu"]')?.getAttribute("data-state")}`),
          done: [...document.querySelectorAll(sel)].map(box),
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
            (d) => `${box(d)} state=${d.getAttribute("data-state")}`,
          ),
        };
      },
      text,
      doneSelector,
    );
    throw new Error(`${(e as Error).message}\n  DOM at timeout: ${JSON.stringify(state)}`);
  }
}

/** Wait until the app's PATH detection for the agent registry has landed.
 *
 *  App.tsx kicks `refreshClis` off at startup, and it takes SECONDS (one
 *  login-shell probe per configured agent). Any CLI verb that opens a tab
 *  hydrates the registry inline if it is still empty, inside the CLI's own
 *  10s "did the UI answer?" deadline — so a spec that drives `termic tab`
 *  during the first few seconds of app life fails with "the Termic UI did not
 *  answer within 10000ms" on a slow machine, while passing on a fast one.
 *  Wait for the detection the app is already doing instead of racing it.
 */
export async function waitForClisDetected(timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        () => Object.keys(window.__termic!.useApp.getState().detectedClis).length > 0,
      ),
    { timeout, timeoutMsg: "the agent registry never finished PATH detection" },
  );
}

/** Focus `selector`, then send a real key to it.
 *
 *  Inline inputs autofocus through a `requestAnimationFrame` chain, and rAF is
 *  FROZEN while the window is occluded (another window on top, another Space).
 *  A bare `browser.keys` then goes to whatever still holds focus, the row never
 *  commits, and it stays open to block the next spec's menu — a failure that
 *  only ever reproduces on a backgrounded window. Focusing explicitly keeps the
 *  keystroke real without depending on the app's rAF landing first.
 */
export async function keysIn(selector: string, key: string): Promise<void> {
  await browser.execute((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`no element to focus: ${sel}`);
    el.focus();
  }, selector);
  await browser.keys(key);
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
 *
 * `cli` picks a different fixture agent. It matters for resume: the repo root
 * is the ONE task shape with no cwd fallback, so an agent's resume behaviour
 * there is entirely a function of its registry capabilities (`fakecapture` is
 * codex's shape, `fakeagent` claude's).
 */
export async function openTask(name: string, activate = true, cli = "fakeagent"): Promise<string> {
  return browser.execute(
    async (n, act, c) => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, c, n);
      await t.useApp.getState().loadAll();
      if (act) t.useApp.getState().setActiveTask(task.id);
      return task.id as string;
    },
    name,
    activate,
    cli,
  );
}

/**
 * Create a worktree task (its own branch, cut from `main`) in the seeded
 * `fixture-repo`, as opposed to `openTask`'s repo-root/main-checkout entry.
 * PR/MR surfaces only make sense against a real branch - a main checkout
 * sits on the project's default branch by definition, so it never has one.
 */
export async function createWorktreeTask(name: string, branch: string, activate = true): Promise<string> {
  return browser.execute(
    async (n, b, act) => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskCreate({
        project_id: proj.id, name: n, cli: "fakeagent", base_branch: "main", branch: b,
      });
      await t.useApp.getState().loadAll();
      if (act) t.useApp.getState().setActiveTask(task.id);
      return task.id as string;
    },
    name,
    branch,
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
  // Wait for the DOM, not the store. setActiveTask is synchronous, so the
  // old store-only wait passed on the same tick it was called and barred
  // nothing: React had not rendered yet, and every button in the chrome still
  // closed over the previous task. Clicking one then acted on the WRONG task,
  // which is what made "silent archive never landed" flake on loaded runners.
  // UnifiedBar's data-active-task is the rendered answer.
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) =>
          window.__termic!.useApp.getState().activeTaskId === id &&
          document
            .querySelector("header[data-active-task]")
            ?.getAttribute("data-active-task") === id,
        taskId,
      ),
    { timeout: 8_000, timeoutMsg: `task ${taskId} never became active on screen` },
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

// ── agent input + work-state badges ───────────────────────────────────────
//
// Specs used to drive agents by hand: reach into the store, stamp
// `lastInputAt` (the private flag TerminalPane's work detector arms on),
// `ipc.ptyWrite` the line, then assert `tab.workState === "working"` back out
// of the store. That is three implementation details per case, and every one
// of them would keep passing if the UI stopped showing anything at all.
//
// The helpers below close both ends: `submitToAgent` goes in through the
// terminal's own input path (xterm → TerminalPane → PTY), and the badge
// helpers assert on what the user actually sees.

/** What a tab's status badge can be showing. Mirrors `data-work-state`. */
export type WorkBadge = "working" | "done" | "attention" | "failed";

/**
 * Make sure the two prefs that gate work-state badges are on, so a spec can
 * assert on the DOM. Both default to on, but they are user-toggleable and
 * localStorage-backed — the profile is reused across spec files, so an earlier
 * settings spec could have left either one off.
 */
export async function requireWorkBadges(): Promise<void> {
  await browser.execute(() => {
    const p = window.__termic!.usePrefs.getState();
    p.setWorkingIndicator(true);
    p.setSettledHighlight(true);
  });
}

/** Wait until the task's agent tab has spawned its PTY. */
export async function waitForAgentPty(taskId: string, timeout = 20_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => !!(window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.ptyId,
        taskId,
      ),
    { timeout, interval: 250, timeoutMsg: `agent PTY never spawned for ${taskId}` },
  );
}

/**
 * Wait until the agent is actually able to RECEIVE a prompt.
 *
 * {@link waitForAgentPty} is not enough and was the cause of a long-running CI
 * flake: it resolves as soon as Rust reports a `ptyId`, which says the process
 * was spawned and nothing else. Submitting then dispatches input events at an
 * xterm that may not have wired its `_inputEvent` handler yet, so the
 * keystrokes are dropped silently, `submitToAgent` still returns "ok", the
 * agent never emits its OSC, and the spec fails 15s later with
 * `[null, null]` badges. On a laptop the gap is invisible; on a loaded 3-core
 * CI runner it is wide enough to lose the race regularly. It failed a
 * different badge spec on nearly every run, which is exactly why it read as
 * random rather than as one bug.
 *
 * The condition is `lastOutputAt`: the fixture prints its banner before the
 * read loop, and that field is only stamped by TerminalPane's PTY data
 * handler, which is wired in the same effect that calls `term.open()`. So
 * output having reached the store proves the whole chain is live: process
 * spawned, script running, xterm attached, store wired. A terminal that is
 * delivering output is a terminal that will deliver input.
 *
 * Deliberately NOT `liveTitle`, which was the first attempt and is wrong:
 * `setTabLiveTitle` drops the agent's title outright when a tab has
 * `customTitle` set, so a legitimately-ready agent can sit at `liveTitle:
 * null` forever. It is still accepted as an alternative signal for the case
 * where a title arrives before the first output patch (the store coalesces
 * `lastOutputAt` to one write per 500ms, so a fast title can win the race).
 */
export async function waitForAgentReady(taskId: string, timeout = 30_000): Promise<void> {
  await waitForAgentPty(taskId, timeout);
  let last: { out: number | null; title: string | null } = { out: null, title: null };
  await browser
    .waitUntil(
      async () => {
        last = await browser.execute((id) => {
          const t = (window.__termic!.useApp.getState().tabs[id] ?? [])[0];
          return { out: t?.lastOutputAt ?? null, title: t?.liveTitle ?? null };
        }, taskId);
        return (last.out ?? 0) > 0 || !!last.title?.trim();
      },
      { timeout, interval: 100 },
    )
    .catch(() => {
      throw new Error(
        `agent in ${taskId} never produced output, so it was never ready for input ` +
          `— last {lastOutputAt, liveTitle} = ${JSON.stringify(last)}`,
      );
    });
}

/**
 * Send a prompt to a task's on-screen agent terminal the way a user does:
 * through xterm's own input path, not by writing to the PTY behind its back.
 *
 * Both steps are the events WKWebView itself produces for a keystroke burst:
 *   • an `insertText` input event on the helper textarea — xterm's `_inputEvent`
 *     forwards it to the PTY (this is the path `lib/ime.ts` documents);
 *   • an Enter keydown — xterm turns it into a CR on `onData`, which is what
 *     TerminalPane treats as a real submit: it stamps `lastInputAt`, arms the
 *     work detector and re-arms done for the new turn.
 *
 * That last part is the point. Specs no longer patch `lastInputAt` themselves,
 * so they stop encoding how work detection is armed — if the submit path
 * breaks, these tests fail instead of quietly compensating for it.
 */
/**
 * Press Escape in the task's terminal, through xterm's own key handling.
 *
 * Deliberately NOT `ipc.ptyWrite`: that reaches the PTY without passing
 * through xterm, so `term.onData` never fires and termic never sees the
 * keystroke. The interrupt path reads `onData`, so a spec using ptyWrite
 * would test the fixture rather than the feature.
 */
/**
 * Wait until the agent has produced `ms` worth of OUTPUT since now.
 *
 * For negative assertions ("no done badge appeared"), which need time to pass
 * but must not be a sleep. This is a real condition on the app's own clock,
 * and it additionally proves the agent kept working across the window, which
 * is usually the thing that makes the negative meaningful.
 */
export async function waitForOutputSpan(taskId: string, ms: number): Promise<void> {
  const at = () =>
    browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.lastOutputAt ?? 0,
      taskId,
    ) as Promise<number>;
  const start = await at();
  await browser.waitUntil(async () => (await at()) - start > ms, {
    timeout: ms + 20_000,
    interval: 400,
    timeoutMsg: `agent in ${taskId} stopped producing output before ${ms}ms elapsed`,
  });
}

/** Drive the app's idea of window focus, deterministically.
 *
 *  `useSeenWhenWatched` treats "the badged tab is on screen in a FOCUSED window"
 *  as having read the badge. Real focus is not something a spec can rely on:
 *  the suite's window is frequently occluded (another Space, behind the
 *  terminal, a CI runner with no desktop), so `document.hasFocus()` decides
 *  whether a badge survives, and a spec that does not say which it wants
 *  passes or fails on where the window happened to be.
 *
 *  So every spec that cares states it. `false` models the user being away,
 *  which is the only time a badge is meant to persist at all.
 */
export async function setWindowPresence(focused: boolean): Promise<void> {
  // Sets the flag, rather than dispatching a focus/blur event. `initWindowFocus`
  // treats those events only as a cue to re-read `document.hasFocus()`, because
  // inferring focus from which event arrived gets it wrong when they interleave
  // during a Space switch. A synthetic event would therefore be a no-op that
  // silently re-asserted whatever the real window was doing.
  await browser.execute((f) => {
    window.__termic!.useUI.getState().setWindowFocused(f);
  }, focused);
}

export async function pressEscape(taskId: string): Promise<void> {
  const result = await browser.execute((id) => {
    const host = document.querySelector(`[data-task-id="${id}"]`);
    if (!host) return "task view is not mounted";
    const ta = [...host.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")].find(
      (el) => {
        const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      },
    );
    if (!ta) return "no visible terminal in the task view";
    ta.focus();
    for (const type of ["keydown", "keyup"]) {
      ta.dispatchEvent(new KeyboardEvent(type, {
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
        bubbles: true, cancelable: true,
      } as KeyboardEventInit));
    }
    return "ok";
  }, taskId);
  if (result !== "ok") throw new Error(`could not press Escape in ${taskId}: ${result}`);
}

/** Mark an agent as hook-reporting (or not) for the duration of a spec. */
export async function setHooksOwnState(cli: string, on: boolean): Promise<void> {
  await browser.execute((c, v) => {
    const s = window.__termic!.useApp;
    s.setState({ agentHooksInstalled: { ...s.getState().agentHooksInstalled, [c]: v } });
  }, cli, on);
}

export async function submitToAgent(taskId: string, text: string): Promise<void> {
  // What `lastInputAt` was before this submit. TerminalPane stamps it from
  // xterm's `onData` for a CR, so it advancing is PROOF the keystrokes went
  // through xterm and reached the PTY. Without this check a dropped submit is
  // indistinguishable from a working one until some unrelated assertion times
  // out much later with a useless message.
  const before = await browser.execute(
    (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.lastInputAt ?? 0,
    taskId,
  );

  const result = await browser.execute(
    (id, line) => {
      const host = document.querySelector(`[data-task-id="${id}"]`);
      if (!host) return "task view is not mounted";
      // Every visited task stays mounted and inactive tabs are display:none,
      // so take the first terminal that actually has geometry.
      const ta = [...host.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")].find(
        (el) => {
          const r = (el.closest(".xterm") ?? el).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        },
      );
      if (!ta) return "no visible terminal in the task view";
      ta.focus();
      ta.dispatchEvent(
        new InputEvent("input", { inputType: "insertText", data: line, bubbles: true }),
      );
      const enter = (type: string) =>
        ta.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          } as KeyboardEventInit),
        );
      enter("keydown");
      // The keyup is NOT decoration: xterm latches `_keyDownSeen` on keydown
      // and only clears it on keyup, and while it is latched the NEXT
      // insertText input event is dropped as "already handled by a keydown".
      // Skipping it makes the first submit work and every later one vanish.
      enter("keyup");
      return "ok";
    },
    taskId,
    text,
  );
  if (result !== "ok") throw new Error(`could not submit to agent in ${taskId}: ${result}`);

  // "ok" only means the events were dispatched, not that xterm forwarded them.
  // Fail HERE, naming the real cause, instead of letting a badge assertion
  // time out 15s later reporting [null, null] as though the app misbehaved.
  await browser
    .waitUntil(
      async () =>
        (await browser.execute(
          (id) => (window.__termic!.useApp.getState().tabs[id] ?? [])[0]?.lastInputAt ?? 0,
          taskId,
        )) > before,
      { timeout: 10_000, interval: 100 },
    )
    .catch(() => {
      throw new Error(
        `submit to ${taskId} was dispatched but xterm never forwarded it ` +
          `(lastInputAt did not advance past ${before}). The terminal was not ` +
          `ready for input — call waitForAgentReady() before submitting.`,
      );
    });
}

/**
 * The work state the task's OWN tab strip is showing, or null when the tab
 * carries no badge. Only meaningful while the task is the active one — a
 * backgrounded task stays mounted but hidden, so read {@link sidebarBadge}
 * for those.
 */
export async function taskViewBadge(taskId: string): Promise<WorkBadge | null> {
  return browser.execute((id) => {
    const el = document.querySelector(
      `[data-task-id="${id}"] [data-testid="work-badge"]`,
    ) as HTMLElement | null;
    return (el?.dataset.workState as string | undefined) ?? null;
  }, taskId) as Promise<WorkBadge | null>;
}

/**
 * The work state the SIDEBAR row for a task is showing, or null when it has
 * no badge. This is the surface that matters for a backgrounded agent: the
 * user is looking at another task, and the sidebar row is the only place its
 * bell / done bullet / spinner can appear. Covers both shapes of the row (the
 * aggregate badge while collapsed, the per-tab badge while expanded).
 */
export async function sidebarBadge(taskId: string): Promise<WorkBadge | null> {
  return browser.execute((id) => {
    const el = document.querySelector(
      `[data-sidebar-task-row="${id}"] [data-testid="work-badge"]`,
    ) as HTMLElement | null;
    return (el?.dataset.workState as string | undefined) ?? null;
  }, taskId) as Promise<WorkBadge | null>;
}

/**
 * The work state the DASHBOARD row for a task is showing, or null when it has
 * no badge.
 *
 * Scoped through `data-dashboard-task-id` on purpose: `work-badge` is no
 * longer unique on the page. The sidebar is always mounted and the dashboard
 * is an overlay on top of it, so a task with a live agent renders the badge
 * twice and a bare testid query would return whichever came first in document
 * order (the sidebar's).
 */
export async function dashboardBadge(taskId: string): Promise<WorkBadge | null> {
  return browser.execute((id) => {
    const el = document.querySelector(
      `[data-dashboard-task-id="${id}"] [data-testid="work-badge"]`,
    ) as HTMLElement | null;
    return (el?.dataset.workState as string | undefined) ?? null;
  }, taskId) as Promise<WorkBadge | null>;
}

/**
 * Wait until the badge for `taskId` reads one of `want`. Looks at the task's
 * own tab strip AND its sidebar row, so the same call works whether the task
 * is in front or backgrounded.
 */
export async function waitForWorkBadge(
  taskId: string,
  want: WorkBadge | WorkBadge[],
  opts: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
  const wanted = Array.isArray(want) ? want : [want];
  // Remember what we last saw so the failure message names it — "never showed
  // working" is a lot less useful than "showed attention instead".
  let last: Array<WorkBadge | null> = [];
  await browser
    .waitUntil(
      async () => {
        last = await workBadges(taskId);
        return last.some((s) => s !== null && wanted.includes(s));
      },
      { timeout: opts.timeout ?? 10_000, interval: opts.interval ?? 250 },
    )
    .catch(() => {
      const base = opts.message ?? `${taskId} never showed a ${wanted.join("/")} badge`;
      throw new Error(`${base} — last saw [tab strip, sidebar] = ${JSON.stringify(last)}`);
    });
}

/** Wait until NEITHER surface shows any of `unwanted` any more. */
export async function waitForWorkBadgeGone(
  taskId: string,
  unwanted: WorkBadge | WorkBadge[],
  opts: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
  const gone = Array.isArray(unwanted) ? unwanted : [unwanted];
  let last: Array<WorkBadge | null> = [];
  await browser
    .waitUntil(
      async () => {
        last = await workBadges(taskId);
        return last.every((s) => s === null || !gone.includes(s));
      },
      { timeout: opts.timeout ?? 10_000, interval: opts.interval ?? 250 },
    )
    .catch(() => {
      const base = opts.message ?? `${taskId} still shows a ${gone.join("/")} badge`;
      throw new Error(`${base} — last saw [tab strip, sidebar] = ${JSON.stringify(last)}`);
    });
}

/**
 * How many messages the task's queue control says are waiting for the active
 * agent (the "N queued" chip in the footer), or null when the control is not
 * on screen.
 */
export async function queuedCount(taskId: string): Promise<number | null> {
  return browser.execute((id) => {
    const el = document.querySelector(
      `[data-task-id="${id}"] [data-testid="queue-button"]`,
    ) as HTMLElement | null;
    if (!el) return null;
    return Number(el.dataset.queued ?? "0");
  }, taskId) as Promise<number | null>;
}

/** Both badge surfaces for a task: `[tab strip, sidebar row]`. */
export async function workBadges(taskId: string): Promise<Array<WorkBadge | null>> {
  return Promise.all([taskViewBadge(taskId), sidebarBadge(taskId)]);
}

/**
 * One request over the REAL control socket, on a fresh connection; stream
 * lines (heartbeats, state events) are skipped and the final Reply resolves.
 *
 * This is the only way a spec can read what actually landed in a PTY:
 * `pty_logs_tail` is not a Tauri command, so `{cmd:"logs"}` here is the sole
 * route to the agent's output ring. Terminal content is NOT in the DOM (xterm
 * renders to a canvas), and store state only carries timestamps.
 */
export function cliRpc(cmd: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    const to = setTimeout(() => {
      c.destroy();
      reject(new Error("no reply from the control socket within 30s"));
    }, 30_000);
    c.on("connect", () =>
      c.write(JSON.stringify({ id: "e2e", token: cliToken(), ...cmd }) + "\n"),
    );
    c.on("data", d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.stream) continue; // heartbeat / state / queued events
        clearTimeout(to);
        c.end();
        resolve(msg);
        return;
      }
    });
    c.on("error", e => {
      clearTimeout(to);
      reject(e);
    });
  });
}

/** The staged `termic-cli` sidecar built for THIS machine.
 *
 *  `scripts/build-cli.mjs` only lipos `termic-cli-universal-apple-darwin` when
 *  BOTH macOS rustup targets are installed; with one it stages the host arch
 *  alone and prints a note saying so. A spec that hardcodes the universal name
 *  therefore runs only on a machine that happens to have both targets and
 *  fails identically everywhere else, CI included.
 *
 *  Prefers the universal binary when it exists (that is what a release ships),
 *  falls back to the host arch, and names what it DID find when neither is
 *  there - "ENOENT" on a path nobody printed is a long way from "run
 *  `npm run build:cli`". */
export function cliBinary(): string {
  const dir = path.resolve("src-tauri/binaries");
  const triple = process.platform === "darwin"
    ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
    : (process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu");
  const candidates = process.platform === "darwin"
    ? [`termic-cli-universal-apple-darwin`, `termic-cli-${triple}`]
    : [`termic-cli-${triple}`];
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.startsWith("termic-cli-")).join(", ") || "nothing"
    : "no binaries directory at all";
  throw new Error(
    `no termic-cli sidecar for this machine in ${dir}. Looked for ` +
    `${candidates.join(" then ")}; found ${found}. Run \`npm run build:cli\`.`);
}

/** Run the sidecar and return its stdout.
 *
 *  Never let `execFileSync` throw its own error through. Node attaches a
 *  self-referencing `error` property to it, so wdio's `JSON.stringify` of the
 *  thrown value dies with "Converting circular structure to JSON" and the
 *  actual reason - a missing binary, a non-zero exit, whatever the CLI wrote
 *  to stderr - never reaches the log. That masked this exact bug through a
 *  full CI run and a local one. */
export function runCli(args: string[], env: Record<string, string>): string {
  try {
    return execFileSync(cliBinary(), args, {
      cwd: path.resolve("."),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
  } catch (e: any) {
    const parts = [
      `termic-cli ${args.join(" ")} failed`,
      e?.status != null ? `exit ${e.status}` : null,
      e?.stderr ? `stderr: ${String(e.stderr).trim()}` : null,
      e?.stdout ? `stdout: ${String(e.stdout).trim()}` : null,
      e?.message ? `message: ${e.message}` : null,
    ].filter(Boolean);
    // A PLAIN Error: the one Node threw carries a circular `error` property.
    throw new Error(parts.join(" | "));
  }
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

/**
 * Run CodeMirror's pending layout measurement NOW, and report how many editors
 * were flushed.
 *
 * CM schedules that measurement with `requestAnimationFrame`, and WebKit
 * freezes rAF in an occluded window — which the harness window permanently is
 * (`document.hidden` is true for the whole suite; the Activity spec leans on
 * the same fact for its back-off case). Until the measurement runs, CM's
 * height map keeps its UNMEASURED default of 14px per line while the rendered
 * lines are really 20, so every gutter number sits 6px above its code and the
 * gap grows down the file. That is the exact shape of the bug an alignment
 * spec is looking for, manufactured by the harness rather than by the code
 * under test, and no amount of waiting clears it: the frame never comes.
 *
 * `coordsAtPos` is the public read that flushes a pending measure (through
 * CM's internal `readMeasured`), so ask for a position and drop the answer. A
 * visible window gets all of this for free on the next frame.
 *
 * Call it before reading any geometry OUT of a CodeMirror editor. The count
 * comes back so a CM upgrade that renames the view handle cannot quietly turn
 * this into a no-op that reintroduces the drift.
 */
export function flushEditorMeasure(): Promise<number> {
  return browser.execute(() => {
    let flushed = 0;
    for (const ed of [...document.querySelectorAll(".cm-editor")]) {
      if (!(ed as HTMLElement).getBoundingClientRect().height) continue;
      // EditorView.findFromDOM's own route to the view (@codemirror/view 6.43).
      const view = (ed.querySelector(".cm-content") as any)?.cmTile?.root?.view;
      if (typeof view?.coordsAtPos !== "function") continue;
      view.coordsAtPos(0);
      flushed++;
    }
    return flushed;
  }) as Promise<number>;
}
