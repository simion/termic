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

/** Connect to the app's control plane. Unix: the socket file itself. Windows:
 *  the file holds the loopback `host:port` the app listens on
 *  (termic_proto::local). */
export function controlConnect(file: string = socketPath): net.Socket {
  if (process.platform !== "win32") return net.createConnection(file);
  const [host, port] = fs.readFileSync(file, "utf8").trim().split(/:(?=\d+$)/);
  return net.createConnection({ host, port: Number(port) });
}
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
  // Skipped in CI, unless TERMIC_E2E_SNAP (a regex on the name) asks for it:
  // a CI job sets it to look at a UI no one has on their own machine.
  const want = process.env.TERMIC_E2E_SNAP;
  if (process.env.CI && !(want && new RegExp(want).test(name))) return;
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
  useDelivery: { getState: () => any; setState: (p: any) => void };
  usePr: { getState: () => any; setState: (p: any) => void };
  /** Per-task change summaries (src/store/diffStat.ts). Demand-driven with a
   *  staleness floor, so a spec that changes a worktree calls `invalidate`
   *  rather than waiting the floor out. */
  useDiffStat: { getState: () => any; setState: (p: any) => void };
  /** One pass of the background PR status poller (GH #281): the real one
   *  ticks on a multi-minute cadence and has no on-screen trigger. */
  prStatusPassNow: () => Promise<void>;
  /** Profiles registry as this window sees it (src/store/profiles.ts, GH
   *  #280). Read for setup/teardown; the strip is what the spec asserts on. */
  useProfiles: { getState: () => any; setState: (p: any) => void };
  /** Plan usage (src/store/agentUsage.ts). Seeded by specs: no fixture agent
   *  reports a real reading. */
  useAgentUsage: { getState: () => any; setState: (p: any) => void };
  /** Dismissed "Usage unknown" labels (src/store/usageUnknownDismissed.ts). */
  useUsageUnknownDismissed: { getState: () => any; setState: (p: any) => void };
  /** `termic scratchpad`'s webview handler (src/lib/scratchCli.ts). */
  padHandler: (params: any) => Promise<any>;
  /** The live i18next instance, for `rawI18nKeysOnScreen` (i18n.e2e.ts). */
  i18n: {
    exists: (key: string, opts?: any) => boolean;
    language: string;
    options: { ns?: string | string[] };
  };
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
  try {
    await browser.waitUntil(
      () =>
        browser.execute((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          if (r.width <= 0 || r.height <= 0) return false;
          if (st.visibility === "hidden" || st.display === "none") return false;
          if (st.opacity !== "0") return true;
          // opacity 0 with a laid-out box and an animation attached: an ENTRY
          // animation that has not advanced past its first frame. WebKit
          // freezes animations in a window it believes is occluded, which is
          // every local run (nobody gives the e2e window focus), so
          // `termic-pop-in` never plays and a dialog that is open, sized and
          // interactive sits at opacity 0 forever. Measured on the project
          // picker: data-state="open", 760x79, visibility visible, opacity 0,
          // animation termic-pop-in, transform still at its -16px start.
          //
          // `data-state` is the authority for a Radix element, so a CLOSING one
          // is still excluded: it is the same shape in reverse, and treating it
          // as visible would make a stale dialog answer for a fresh one.
          return st.animationName !== "none" && el.getAttribute("data-state") !== "closed";
        }, selector),
      { timeout, timeoutMsg: `never became visible: ${selector}` },
    );
  } catch (e) {
    // Say WHICH of the five conditions failed. "never became visible" reads as
    // "it was not there", and the two cases need opposite fixes: a selector
    // that matches nothing is a spec or product bug, while a node sitting at
    // opacity 0 with a real box is usually an animation that never ran, which
    // is what happens to every fade-in while the window has no OS focus (see
    // docs/e2e-tests.md). Guessing between them has cost whole sessions.
    const why = await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) {
        const tag = sel.match(/\[data-testid="([^"]+)"\]/)?.[1];
        return { found: false, similarTestIds: tag
          ? [...document.querySelectorAll("[data-testid]")]
            .map((n) => n.getAttribute("data-testid")!)
            .filter((t) => t.includes(tag.split("-")[0])).slice(0, 8)
          : [] };
      }
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return {
        found: true, w: Math.round(r.width), h: Math.round(r.height),
        opacity: st.opacity, visibility: st.visibility, display: st.display,
        animation: st.animationName, transform: st.transform,
        state: el.getAttribute("data-state"),
      };
    }, selector);
    throw new Error(`${(e as Error).message}\nelement: ${JSON.stringify(why)}`);
  }
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
  // Pin English. The language picker defaults to "system", which follows the
  // Mac's locale — CI boxes resolve it to English, but on a developer machine
  // set to Chinese every English-label clickByText in the suite misses. The
  // language-picker spec is unaffected: it sets its own start state before
  // reading. Guarded on the pref value so an already-English session writes
  // nothing.
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const p = window.__termic?.usePrefs?.getState();
        if (!p) return false;
        if (p.language !== "en") p.setLanguage("en");
        return true;
      }),
    { timeout, interval: 250, timeoutMsg: "__termic prefs never came up" },
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
export async function openRightTab(label: "All files" | "Git" | "Delivery"): Promise<void> {
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
/** Why every menu lookup below is scoped to the OPEN menu.
 *
 *  Unscoped `[role='menuitem']` is a bug, and a subtle one. The tab strip's "+"
 *  menu and the sidebar row's New submenu offer the SAME entries ("Terminal",
 *  "FakeAgent", ...), so with a stale menu still in the DOM the helper could
 *  click the sidebar's Terminal, which adds a tab to a DIFFERENT task. The
 *  spec's own task then never reaches its expected count, the retry loop clicks
 *  again, and the reported shape is "31 attempts, 31 clicked, nothing
 *  happened", which reads like a dead click rather than a click that worked
 *  somewhere else. Radix leaves a closing menu mounted while its animation
 *  finishes, and on an occluded window that animation never finishes, so the
 *  stale menu can sit there indefinitely.
 *
 */
export async function clickMenuItemUntil(
  text: string,
  doneSelector: string,
  timeout = 15_000,
): Promise<void> {
  // Record every time the expected result enters or leaves the DOM, with the
  // focus at that instant. The end-state dump below cannot tell "the click
  // never landed" from "the row mounted and was cancelled a frame later", and
  // those have opposite fixes. A MutationObserver can, and it is test-side, so
  // nothing about the app's timing changes by asking.
  await browser.execute((sel) => {
    const w = window as unknown as { __menuTrace?: string[]; __menuObs?: MutationObserver };
    w.__menuObs?.disconnect();
    w.__menuTrace = [];
    const seen = new Set<Element>();
    const focus = () => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName}${a.id ? `#${a.id}` : ""}${a.getAttribute("placeholder") ? `[${a.getAttribute("placeholder")}]` : ""}` : "none";
    };
    const t0 = Date.now();
    const scan = () => {
      const now = [...document.querySelectorAll(sel)];
      for (const el of now) {
        if (!seen.has(el)) { seen.add(el); w.__menuTrace!.push(`+${Date.now() - t0}ms focus=${focus()}`); }
      }
      for (const el of [...seen]) {
        if (!now.includes(el)) { seen.delete(el); w.__menuTrace!.push(`-${Date.now() - t0}ms focus=${focus()}`); }
      }
    };
    scan();
    const obs = new MutationObserver(scan);
    obs.observe(document.body, { childList: true, subtree: true });
    w.__menuObs = obs;
  }, doneSelector);
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
            const el = (() => {
              const open = [...document.querySelectorAll('[role="menu"]')]
                .filter(m => m.getAttribute("data-state") !== "closed");
              const scope: (Document | Element)[] = open.length ? [open[open.length - 1]] : [document];
              return scope.flatMap(sc => [...sc.querySelectorAll<HTMLElement>("[role='menuitem']")]);
            })().find(
              (e) =>
                e.textContent?.trim() === t &&
                e.getBoundingClientRect().width > 0,
            );
            // No item and no result yet: the menu is mid-remount, or the click
            // landed and its result has not painted. Either way, wait.
            if (el) el.click();
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
          // Everything above can be empty for two opposite reasons, and the
          // shape "no menu, no item, no prompt" has now cost two CI runs
          // without saying which. So: did the click LAND (a task appeared,
          // or some other inline row is up), and where did focus end up?
          // A row that mounted and was cancelled leaves focus somewhere
          // telling; a click that never landed leaves it on the trigger.
          tasks: window.__termic?.useApp.getState().tasks.length ?? -1,
          inlineInputs: [...document.querySelectorAll("aside input")].map(
            (i) => `${box(i)} ph=${(i as HTMLInputElement).placeholder}`,
          ),
          focus: (() => {
            const a = document.activeElement as HTMLElement | null;
            if (!a) return "none";
            return `${a.tagName}${a.dataset?.testid ? `#${a.dataset.testid}` : ""}`;
          })(),
          // "+12ms focus=INPUT[Task name]" then "-31ms focus=BUTTON#…" means
          // the click DID land and the row was cancelled when focus went back
          // to the menu's trigger. An empty trace means it never mounted at all.
          trace: (window as unknown as { __menuTrace?: string[] }).__menuTrace ?? [],
        };
      },
      text,
      doneSelector,
    );
    throw new Error(`${(e as Error).message}\n  DOM at timeout: ${JSON.stringify(state)}`);
  } finally {
    // Never leave it running. A subtree observer on <body> outliving this call
    // would watch every mutation for the rest of the spec FILE, which is both a
    // cost and a way for a diagnostic to change the timing it is measuring.
    await browser.execute(() => {
      const w = window as unknown as { __menuObs?: MutationObserver };
      w.__menuObs?.disconnect();
      w.__menuObs = undefined;
    }).catch(() => { /* the window is gone; nothing to disconnect */ });
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
    // The syntax palette was missing here, and it is a `[role="dialog"]` like
    // the rest: editor.e2e left one up, and files.e2e's "top result" assertion
    // read the FIRST dialog on screen, which by then was not its own.
    ui.closeSyntaxPalette();
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
  opts: { grab?: DragAnchor; land?: DragAnchor; landOn?: string; hold?: boolean } = {},
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
    (fromSel, toSel, grab, land, hold) => {
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
      // `hold` stops one event short: the pointer stays DOWN over the target,
      // which is the only way to assert what the rest of the board looks like
      // mid-gesture. The caller finishes with `pointerRelease`.
      if (!hold) fire("pointerup", end.x, end.y, under(end.x, end.y));
    },
    from,
    to,
    opts.grab ?? "center",
    opts.land ?? "center",
    !!opts.hold,
  );
}

/**
 * Finish a `pointerDrag(..., { hold: true })`: move onto `to` and release
 * there. Separate from the drag itself so a spec can assert what the board
 * looks like WHILE a card is in hand, which is where a whole class of drag
 * bugs lives (a preview applied to the wrong group blanks that group's cards
 * for the length of the gesture and leaves no trace once the pointer is up).
 *
 * Releasing somewhere that is not a drop target is the way to end a held drag
 * without writing anything.
 */
export async function pointerRelease(to: string, land: DragAnchor = "center"): Promise<void> {
  await browser.execute(
    (toSel, a) => {
      const dst = document.querySelector(toSel) as HTMLElement | null;
      if (!dst) throw new Error(`release target not found: ${toSel}`);
      dst.scrollIntoView({ block: "nearest" });
      const r = dst.getBoundingClientRect();
      const ix = Math.max(6, r.width * 0.08), iy = Math.max(6, r.height * 0.08);
      const p =
        a === "left" ? { x: r.left + ix, y: r.top + r.height / 2 }
        : a === "right" ? { x: r.right - ix, y: r.top + r.height / 2 }
        : a === "top" ? { x: r.left + r.width / 2, y: r.top + iy }
        : a === "bottom" ? { x: r.left + r.width / 2, y: r.bottom - iy }
        : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const fire = (type: string, x: number, y: number) => {
        const node = (document.elementFromPoint(x, y) as HTMLElement | null) ?? document.body;
        node.dispatchEvent(new PointerEvent(type, {
          clientX: x, clientY: y, button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          pointerType: "mouse", bubbles: true, cancelable: true,
        }));
      };
      fire("pointermove", p.x, p.y);
      fire("pointerup", p.x, p.y);
    },
    to,
    land,
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
/** `delegated` is not a work state: it is the lowest-priority badge, an idle
 *  tab that still has something the agent started running (see
 *  `lib/delegatedWork.ts`). It draws only when nothing outranks it, which is
 *  why it belongs in this union and not in `WorkBadgeReason`. */
export type WorkBadge =
  | "working" | "done" | "attention" | "failed"
  /** Idle, with something the agent started still running. */
  | "delegated"
  /** Some of the delegated work reported back, the rest runs on. Outranks
   *  done and rings nothing: a turn that is partly over is not over. */
  | "partial";

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

/** Type into the agent's prompt WITHOUT submitting: the same xterm input
 *  path as `submitToAgent`, minus the Enter, so TerminalPane sees a user
 *  draft (control bytes such as Ctrl-U, "\x15", go through it too). */
export async function typeIntoAgent(taskId: string, text: string): Promise<void> {
  const result = await browser.execute(
    (id, line) => {
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
      ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: line, bubbles: true }));
      return "ok";
    },
    taskId,
    text,
  );
  if (result !== "ok") throw new Error(`typeIntoAgent: ${result}`);
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
 * What the tab strip's badge says the agent has DELEGATED and not finished
 * (`data-delegated`, one of lib/delegatedWork.ts's wire labels), or null when
 * it says nothing is outstanding.
 *
 * A separate attribute rather than a fifth `data-work-state`, because it can
 * accompany either `working` (the agent is waiting on its own subagent) or
 * `done` (the turn ended and left a shell running), and a spec needs to tell
 * those two apart.
 */
export async function delegatedLabel(taskId: string): Promise<string | null> {
  return browser.execute((id) => {
    const el = document.querySelector(
      `[data-task-id="${id}"] [data-testid="work-badge"]`,
    ) as HTMLElement | null;
    return (el?.dataset.delegated as string | undefined) ?? null;
  }, taskId) as Promise<string | null>;
}

/** What the tab strip badge's mark actually IS, measured rather than looked
 *  at: the working spinner and the background-work ring are both small round
 *  outlines, and a screenshot cannot tell you which one you are looking at or
 *  how fast it turns.
 *
 *  Both are now SVG rings, so the mark says which it is (`data-mark`)
 *  rather than the spec sniffing CSS for the difference. `duration`
 *  separates the two motions: the spinner turns every second, the ring every
 *  eight. */
export async function workBadgeMark(
  taskId: string,
): Promise<{ kind: string; duration: string } | null> {
  return browser.execute((id) => {
    const badge = document.querySelector(
      `[data-task-id="${id}"] [data-testid="work-badge"]`,
    ) as HTMLElement | null;
    if (!badge) return null;
    const mark = badge.querySelector("[data-mark]") as SVGElement | null;
    if (!mark) return { kind: "none", duration: "0s" };
    return {
      kind: mark.getAttribute("data-mark") ?? "none",
      duration: getComputedStyle(mark).animationDuration,
    };
  }, taskId) as Promise<{ kind: string; duration: string } | null>;
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
    const c = controlConnect();
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
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const triple = process.platform === "darwin" ? `${arch}-apple-darwin`
    : process.platform === "win32" ? `${arch}-pc-windows-msvc`
    : `${arch}-unknown-linux-gnu`;
  const candidates = process.platform === "darwin"
    ? [`termic-cli-universal-apple-darwin`, `termic-cli-${triple}`]
    : process.platform === "win32" ? [`termic-cli-${triple}.exe`]
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
  // The hook attaches after a burst of dynamic imports, so give it a moment
  // before calling it missing, and name WHY when it never came: a failed
  // import (main.tsx records it) is not a stale build, and saying "rebuild"
  // for it sent this hunt the wrong way twice.
  const state = await browser
    .waitUntil(
      () => browser.execute(() => (window.__termic ? "ok" : (window as any).__termicBootError ?? null)),
      { timeout: 10_000, interval: 200 },
    )
    .catch(() => null);
  if (state !== "ok") {
    const where = await browser.execute(() => location.href).catch(() => "?");
    throw new Error(
      state
        ? `window.__termic never attached: a boot import failed (${where}): ${state}`
        : `window.__termic missing at ${where}. Rebuild with \`make e2e\` (VITE_E2E=1) if the build is stale; see the e2e skill.`,
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

/**
 * `rmSync(dir, { recursive, force })`, retried, that says who is in the way
 * when it still fails. On Windows a directory some process is inside (its
 * working directory, or an open handle) cannot be removed, and EBUSY names
 * no process. The failure message then lists every process whose command
 * line mentions termic or git, with its parent, which is usually enough to
 * name the one that outlived its task.
 */
export function rmTree(dir: string, opts: { bestEffort?: boolean } = {}): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  } catch (e) {
    if (process.platform !== "win32") throw e;
    let procs = "";
    try {
      procs = execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'termic|git|pwsh|bash|node' } | "
        + "ForEach-Object { \"$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name): $($_.CommandLine)\" }"],
      { encoding: "utf8", timeout: 20_000 });
    } catch (le) { procs = `(could not list processes: ${String(le)})`; }
    const msg = `${(e as Error).message}\nprocesses at the time:\n${procs}`;
    // A temp dir in the OS temp folder that outlives its test is harmless;
    // `bestEffort` is for a case whose subject is not the cleanup.
    if (opts.bestEffort) { console.warn(`rmTree left ${dir} behind: ${msg}`); return; }
    throw new Error(msg);
  }
}

/** The system clipboard's text: `pbpaste` on macOS, `Get-Clipboard` on
 *  Windows (line endings back to `\n`, which is what the app wrote), `xclip`
 *  on Linux. */
export function readClipboard(): string {
  if (process.platform === "linux") {
    return execFileSync("xclip", ["-o", "-selection", "clipboard"], { encoding: "utf8" });
  }
  if (process.platform === "win32") {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" })
      .replace(/\r\n/g, "\n");
  }
  return execFileSync("pbpaste", { encoding: "utf8" });
}

/** What the app calls the OS file manager (`FILE_MANAGER` in
 *  src/lib/openExternal.ts), for specs asserting on menu and notice copy. */
export const FILE_MANAGER_NAME =
  process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "File Manager";

/** Translation keys that reached the screen as text.
 *
 *  A `<Trans>` or `t()` that names a key the active namespace does not hold
 *  renders the KEY, which is not a crash, not a type error and not something
 *  a spec asserting on one specific string ever sees: the PR card shipped
 *  "pr.cliMissingBody" to users, and the clone dialog lost its whole
 *  destination line, because the element that carries it lives inside the
 *  translation.
 *
 *  Precise rather than pattern-matched: every dotted token on screen is
 *  handed to i18next's own `exists`, so "package.json" and "1.9.1" are not
 *  keys and a real key cannot hide behind a regex nobody updated.
 */
export async function rawI18nKeysOnScreen(): Promise<string[]> {
  return await browser.execute(() => {
    const i18n = window.__termic!.i18n;
    const text = (document.body as HTMLElement).innerText ?? "";
    const seen = new Set<string>();
    for (const token of text.split(/[\s(){}\[\],;"'`]+/)) {
      // A key path: camelCase segments separated by dots, nothing else.
      if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(token)) continue;
      if (seen.has(token)) continue;
      // EVERY namespace, not the default one: a key that renders raw is
      // precisely a key the element looked for in the wrong namespace, so
      // asking only the default would miss the whole bug class.
      const all = i18n.options.ns;
      const namespaces = Array.isArray(all) ? all : all ? [all] : [];
      if (namespaces.some(ns => i18n.exists(token, { ns }))) seen.add(token);
    }
    return [...seen];
  }) as string[];
}

/** Wait until a stopped task has no terminal left in the DOM.
 *
 *  `stopTask` clears the store synchronously, but the PTYs die with the React
 *  unmount that follows, so re-activating in the same tick can re-mount a task
 *  whose processes were never killed and get no respawn at all. The unmounted
 *  pane is the observable end of that, which is why this waits for an element
 *  to go rather than for a guessed number of milliseconds.
 */
export async function waitTaskUnmounted(taskId: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((id) => !document.querySelector(`[data-task-id="${id}"] .xterm`), taskId),
    { timeout, timeoutMsg: `task ${taskId} still had a terminal mounted after it was stopped` },
  );
}

/** Wait until `tabId` is the tab at the front of `taskId`: the store says it
 *  is active AND its pane has been laid out, which is what typing into "the
 *  visible terminal" depends on. */
export async function waitTabInFront(taskId: string, tabId: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((id, tb) => {
      if (window.__termic!.useApp.getState().activeTab[id] !== tb) return false;
      const pane = document.querySelector(`[data-task-id="${id}"] [data-tab-id="${tb}"]`);
      const r = pane?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    }, taskId, tabId),
    { timeout, timeoutMsg: `tab ${tabId} never came to the front of task ${taskId}` },
  );
}

/** Wait until `taskId`'s first tab has seen no PTY output for `quietMs`.
 *
 *  The loop runs IN THE PAGE. Measured afterwards, that is NOT where the time
 *  was (an `execute` round trip is 4ms here, so the polling it replaced cost
 *  9ms of a 24s case); the win is legibility, and one command cannot
 *  interleave with another spec's reads mid-wait. The slow waits were the
 *  ELEMENT-command ones, which `waitForAttr` covers.
 *
 *  Still a condition, not a sleep: the wait ends when the bytes stop, and the
 *  `quietMs` a caller passes is the app threshold it has to outlast (byte-quiet
 *  at 4s, the settle window at 6s) for a "no badge appeared" assertion to mean
 *  anything.
 */
export async function waitPtyQuiet(taskId: string, quietMs: number, timeout = 30_000): Promise<void> {
  const quiet = await browser.execute(async (id, ms, cap) => {
    const started = Date.now();
    const since = () => {
      const tab = window.__termic!.useApp.getState().tabs[id]?.[0];
      return Date.now() - (tab?.lastOutputAt ?? 0);
    };
    while (Date.now() - started < cap) {
      if (since() > ms) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }, taskId, quietMs, timeout);
  if (!quiet) throw new Error(`PTY never went quiet for ${quietMs}ms within ${timeout}ms`);
}

/** Wait until `selector`'s `attr` reads `value`, in ONE WebDriver command per
 *  poll.
 *
 *  `browser.$(sel)` then `isExisting()` then `getAttribute()` is three
 *  ELEMENT commands, which are the expensive kind here (~2s each on this
 *  offscreen window, against 4ms for a plain `execute`: measured, see
 *  docs/e2e-tests.md). One such loop spent 24s watching an attribute that had
 *  been correct for 23.9 of them.
 */
export async function waitForAttr(
  selector: string,
  attr: string,
  value: string,
  timeout = 20_000,
): Promise<void> {
  await browser.waitUntil(
    () => browser.execute(
      (sel, a, v) => document.querySelector(sel)?.getAttribute(a) === v,
      selector, attr, value,
    ),
    {
      timeout,
      timeoutMsg: `${selector} never reported ${attr}="${value}" (last: `
        + `${await browser.execute((sel, a) => document.querySelector(sel)?.getAttribute(a) ?? "<no element>", selector, attr)})`,
    },
  );
}

/** Set a controlled input the way React sees it, then fire its input event.
 *
 *  The in-page path, not `$(sel).setValue()`: an ELEMENT command on this
 *  offscreen window is seconds, and two `$(sel).click()` calls alone were 58s
 *  of one 60s case (measured, docs/e2e-tests.md). React also ignores a plain
 *  `input.value = x`, which is why this goes through the prototype setter.
 */
export async function setInputValue(selector: string, value: string): Promise<void> {
  const ok = await browser.execute((sel, v) => {
    const input = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!input) return false;
    // FOCUS first: `$(sel).setValue()` focuses as a side effect, and specs
    // lean on it (`setInputValue(...)` then `browser.keys("Enter")` to commit
    // a rename). Without it the keys land on whatever had focus and the edit
    // is never submitted, which is silent: the value is right on screen.
    input.focus();
    const proto = input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, selector, value);
  if (!ok) throw new Error(`no input to set: ${selector}`);
}

/** `innerText` of the first match, in one `execute`. */
export async function textOf(selector: string): Promise<string> {
  return await browser.execute((sel) =>
    (document.querySelector(sel) as HTMLElement | null)?.innerText ?? "", selector);
}

/** Click an element that is PRESENT but may not be visible, in the page.
 *
 *  For controls that only paint on hover (`opacity-0 group-hover:opacity-100`,
 *  e.g. the project filter toggle): `clickWhenVisible` gates on opacity and so
 *  waits forever, and `$(sel).click()` costs seconds on this window. The click
 *  itself is what the hover would enable, so dispatch it directly.
 */
export async function clickPresent(selector: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(
    () => browser.execute((sel) => !!document.querySelector(sel), selector),
    { timeout, timeoutMsg: `never appeared in the DOM: ${selector}` },
  );
  await browser.execute((sel) => { (document.querySelector(sel) as HTMLElement).click(); }, selector);
}

/** Put the UI language back to "no pick", the way a fresh machine has it.
 *
 *  NOT `setLanguage("system")`: that WRITES `uiLanguage=system`, and a written
 *  pref beats the English default an e2e build applies when nothing is stored
 *  (src/lib/i18n.ts, GH #338). On a zh-CN machine the stored value then puts
 *  every later spec back into Chinese, and it follows the contributor home:
 *  the WebView's localStorage is keyed by the app identifier, so an e2e binary
 *  and an installed Termic share it. Removing the key restores both.
 *
 *  `applyLanguage` is still called so the live window re-renders, since only
 *  the STORED pref is being cleared, not the running one.
 */
export async function clearLanguagePref(): Promise<void> {
  await browser.execute(() => {
    try { localStorage.removeItem("uiLanguage"); } catch { /* private mode */ }
    window.__termic!.usePrefs.getState().setLanguage("system");
    try { localStorage.removeItem("uiLanguage"); } catch { /* private mode */ }
  });
}

/** `clickMenuItemUntil` for a result no CSS selector describes.
 *
 *  Same race, same cure: Radix remounts a menu's content when what it renders
 *  changes, and a click dispatched into that remount lands on a node React is
 *  replacing, so it does nothing and the menu just stays open. The sibling
 *  helper stops when a `doneSelector` appears; this one stops when `ready()`
 *  says so, for results that live in the store (a tab was added) or in text
 *  (a submenu's entries painted).
 *
 *  Costs one extra `execute` per poll, which is 4ms (docs/e2e-tests.md), and
 *  buys the nine-case cascade `tabs-layout.e2e.ts` loses on Linux whenever the
 *  first click is swallowed.
 *
 *  `reopen` is the other half, and it is not optional in practice: a swallowed
 *  click sometimes leaves the menu OPEN and sometimes CLOSES it, and in the
 *  second case retrying the item is retrying nothing. The loop then spends its
 *  whole timeout clicking a menu that is not on screen and fails with "never
 *  produced its result", which is what the Linux runner reported on a repeat
 *  run with eight cases behind it. Pass the opener and the retry covers both.
 */
export async function clickMenuItemUntilReady(
  text: string,
  ready: () => Promise<boolean>,
  opts: { timeout?: number; reopen?: () => Promise<void> } = {},
): Promise<void> {
  const { timeout = 15_000, reopen } = opts;
  // What the attempts actually did, for the failure message. This helper used
  // to time out saying only "never produced its result", which is true of a
  // menu that never opened, a click that was swallowed, and a result that
  // simply took too long, and those want three different fixes. Its sibling
  // `clickMenuItemUntil` got a DOM dump for the same reason; this is that, plus
  // the per-attempt history only this one can collect.
  const attempts: string[] = [];
  let reopens = 0;
  let reopenErr = "";
  let clicks = 0;
  /** After a click, how long to wait for the RESULT before deciding the click
   *  was swallowed and clicking again. */
  const POST_CLICK_GRACE_MS = 2_000;
  await browser.waitUntil(
    async () => {
      if (await ready()) return true;
      // A click that lands CLOSES the menu, and so does a click that is
      // swallowed, so "the menu is gone" does not mean "nothing happened".
      // Without this grace the loop treats an accepted click as a lost one,
      // reopens, and clicks again: with a `ready()` that tests an exact count
      // (`tabCount() === 2`, the shape every caller here uses) the second
      // click overshoots to 3 and the condition can NEVER become true again.
      // The retry then spends its whole timeout making the failure worse, and
      // reports "never produced its result" about an action that ran 31 times.
      // That is the Linux flake this helper was added to cure, caused by the
      // cure.
      if (clicks > 0) {
        const deadline = Date.now() + POST_CLICK_GRACE_MS;
        while (Date.now() < deadline) {
          if (await ready()) return true;
          await new Promise(r => setTimeout(r, 100));
        }
      }
      // Nothing to click: the menu closed under the last attempt. Put it back
      // before spending another poll on an empty document.
      const present = await browser.execute((t) =>
        (() => {
              const open = [...document.querySelectorAll('[role="menu"]')]
                .filter(m => m.getAttribute("data-state") !== "closed");
              const scope: (Document | Element)[] = open.length ? [open[open.length - 1]] : [document];
              return scope.flatMap(sc => [...sc.querySelectorAll<HTMLElement>("[role='menuitem']")]);
            })().some(
          (e) => e.textContent?.trim() === t && e.getBoundingClientRect().width > 0,
        ), text);
      if (reopen && !present) {
        reopens += 1;
        // Still swallowed, but no longer silently: a reopen that throws every
        // time is the difference between "the menu will not stay open" and
        // "the click does nothing", and the message could not tell them apart.
        await reopen().catch((e: Error) => { reopenErr = String(e?.message ?? e); });
        if (await ready()) return true;
      }
      const clicked = await browser.execute((t) => {
        const el = (() => {
              const open = [...document.querySelectorAll('[role="menu"]')]
                .filter(m => m.getAttribute("data-state") !== "closed");
              const scope: (Document | Element)[] = open.length ? [open[open.length - 1]] : [document];
              return scope.flatMap(sc => [...sc.querySelectorAll<HTMLElement>("[role='menuitem']")]);
            })().find(
          (e) => e.textContent?.trim() === t && e.getBoundingClientRect().width > 0,
        );
        if (!el) return false;
        el.click();
        return true;
      }, text);
      if (clicked) clicks += 1;
      attempts.push(present ? (clicked ? "clicked" : "vanished") : "absent");
      return await ready();
    },
    {
      timeout,
      timeoutMsg: `menu item "${text}" never produced its result`,
    },
  ).catch(async (e: Error) => {
    // Same shape as `clickMenuItemUntil`'s dump: what is on screen NOW, plus
    // the history of what the attempts saw, which is the part that says
    // whether the menu was ever there to click.
    const state = await browser.execute((t) => ({
      menus: [...document.querySelectorAll('[role="menu"]')]
        .map(m => `${Math.round(m.getBoundingClientRect().width)}x${Math.round(m.getBoundingClientRect().height)} state=${m.getAttribute("data-state")}`),
      items: [...document.querySelectorAll('[role="menuitem"]')]
        .map(e => (e as HTMLElement).innerText.trim().replace(/\s+/g, " ")).slice(0, 12),
      wanted: [...document.querySelectorAll('[role="menuitem"]')]
        .filter(e => e.textContent?.trim() === t)
        .map(e => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
      dialogs: [...document.querySelectorAll('[role="dialog"]')]
        .map(d => d.getAttribute("data-state") ?? "(no state)"),
      focus: (() => {
        const a = document.activeElement as HTMLElement | null;
        return a ? `${a.tagName}${a.id ? `#${a.id}` : ""}` : "none";
      })(),
      // Tabs per task, so a failure says whether the action ran and OVERSHOT
      // an exact-count `ready()` rather than never running. Those want
      // opposite fixes and the message could not tell them apart.
      tabs: Object.fromEntries(
        Object.entries(window.__termic!.useApp.getState().tabs as Record<string, unknown[]>)
          .map(([k, v]) => [k.slice(0, 8), v.length]),
      ),
    }), text);
    throw new Error(
      `${e.message}\n  attempts: ${attempts.length} (${clicks} clicked, ${reopens} reopened`
      + `${reopenErr ? `, reopen error: ${reopenErr}` : ""})`
      + `\n  sequence: ${attempts.slice(-12).join(" ")}`
      + `\n  DOM at timeout: ${JSON.stringify(state)}`,
    );
  });
}

