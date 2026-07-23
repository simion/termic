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
  useUI: { getState: () => any };
  usePrefs: { getState: () => any };
  useRace: { getState: () => any };
  ipc: any;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  runTabs: any;
  scriptRuns: { getState: () => any };
}

declare global {
  interface Window {
    __termic?: TermicApi;
  }
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

/** Archive a task and refresh the store (cleanup between runs). */
export async function archiveTask(id: string): Promise<void> {
  await browser.execute(async (i) => {
    await window.__termic!.ipc.taskArchive(i);
    await window.__termic!.useApp.getState().loadAll();
  }, id);
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
