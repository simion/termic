// The welcome screen, the getting-started tour and feature tips
// (docs/guide.md).
//
// Tips are SUPPRESSED in the e2e binary (store/guide.ts), so no other spec
// ever finds a card over what it is driving. This file turns them on, and
// off again in teardown.
//
// Two things here are simulated in the store rather than on disk, both for
// the same reason: the profile is shared with every other spec file. "No
// projects yet" and "no tasks yet" are written into `useApp` and undone by
// `loadAll()`, instead of deleting the seeded fixture project to get a
// genuinely empty install. What the tips then do is real: they read the same
// store, look up real anchors in the real DOM, and are driven by real clicks.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  waitForAppShell, requireTermicApi, waitVisible, waitGone, waitForText, snap,
  openTask, archiveTask, ensureActiveTask, dismissOverlays, readClipboard, clickMenuItemUntil,
} from "../helpers.js";

const TIP = '[data-testid="guide-tip"]';
const tip = (id: string) => `${TIP}[data-tip-id="${id}"]`;

const guide = <T>(fn: string, ...args: unknown[]) =>
  browser.execute((f, a) => (window.__termic!.useGuide.getState() as any)[f](...a), fn, args) as Promise<T>;
const guideState = (key: string) =>
  browser.execute((k) => (window.__termic!.useGuide.getState() as any)[k], key);

const shownTip = () =>
  browser.execute((sel) => document.querySelector(sel)?.getAttribute("data-tip-id") ?? null, TIP);

/** Press a button on the card the way a pointer does: the card's own
 *  pointerdown / mousedown handlers are part of what is under test. */
const pressOnCard = (testid: string) => browser.execute((id) => {
  const el = document.querySelector(`[data-testid="guide-tip"] [data-testid="${id}"]`) as HTMLElement | null;
  if (!el) throw new Error(`no ${id} on the card`);
  const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}, testid);

/** The ring is drawn 3px outside the control it points at. Asserting that is
 *  what proves the tip found the RIGHT element, not merely some element. */
const ringHugs = (anchor: string) => browser.execute((sel) => {
  const ring = document.querySelector('[data-testid="guide-ring"]')?.getBoundingClientRect();
  const el = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 0)?.getBoundingClientRect();
  if (!ring || !el) return false;
  return Math.abs(ring.left - (el.left - 3)) <= 1 && Math.abs(ring.top - (el.top - 3)) <= 1
    && Math.abs(ring.width - (el.width + 6)) <= 1 && Math.abs(ring.height - (el.height + 6)) <= 1;
}, anchor);

/** The card must sit beside the control, never on top of it. */
const cardClearOf = (anchor: string) => browser.execute((sel) => {
  const c = document.querySelector('[data-testid="guide-tip"]')!.getBoundingClientRect();
  const a = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 0)!.getBoundingClientRect();
  return c.right <= a.left || c.left >= a.right || c.bottom <= a.top || c.top >= a.bottom;
}, anchor);

describe("welcome screen and guide", () => {
  const made: string[] = [];
  let projectId = "";
  // A SECOND project with its own empty "New task" row. The card once
  // jumped to it while the user was naming a task in the first.
  let otherDir = "";
  let otherId = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-guide-other-")));
    execSync(`git -C "${otherDir}" init -q && git -C "${otherDir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`);
    otherId = await browser.execute(async (dir) => {
      const t = window.__termic!;
      const p = await t.ipc.projectAdd(dir);
      await t.useApp.getState().loadAll();
      return p.id as string;
    }, otherDir);
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id as string);
    await browser.execute(() => {
      const g = window.__termic!.useGuide;
      g.getState().resetAll();
      g.setState({ seen: [], activeGuide: null, tipsSpent: 0 });
      g.getState().setSuppressed(false);
    });
  });

  after(async () => {
    await browser.execute(() => {
      const t = window.__termic!;
      t.useGuide.getState().setSuppressed(true);
      t.useGuide.getState().skipGuide("welcome");
      t.useUI.getState().closeWelcome();
    });
    await browser.keys("Escape");
    // The profile's default, and nothing left installed: settings.e2e.ts
    // asserts on hook state from a clean slate.
    await browser.execute(async () => {
      const t = window.__termic!;
      await t.invoke("agent_hooks_auto_set", { on: false });
      for (const a of t.useApp.getState().agents) {
        try { await t.invoke("agent_hooks_remove", { agentId: a.id }); } catch { /* unsupported */ }
      }
      await t.useApp.getState().refreshAgentHooks();
    });
    if (otherId) {
      await browser.execute(async (id) => { try { await window.__termic!.ipc.projectRemove(id); } catch { /* gone */ } }, otherId);
    }
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    for (const id of made) { try { await archiveTask(id); } catch { /* already gone */ } }
    try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch { /* never made */ }
  });

  it("is one screen: the agents found, and two ways out", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openWelcome());
    await waitForText("Welcome to Termic");
    await waitVisible('[data-testid="welcome-clis"]');
    const shape = await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find(x => x.textContent?.includes("Welcome to Termic"))!;
      return {
        // No pips, no Next: the wizard this replaced had five steps.
        pips: d.querySelectorAll('[aria-label^="Step "]').length,
        steps: [...d.querySelectorAll("button")].map(b => b.textContent?.trim()).filter(t => t === "Next" || t === "Back").length,
        // No hooks question: the app installs hooks at startup, so a
        // checkbox here asked about something already done.
        checkboxes: d.querySelectorAll('input[type="checkbox"]').length,
      };
    });
    expect(shape).toEqual({ pips: 0, steps: 0, checkboxes: 0 });
    await snap("guide-01-welcome.png");
  });

  it("Show me around starts the tour, changes no hook setting, and leaves the tips armed", async () => {
    const autoOn = () => browser.execute(() => window.__termic!.invoke("agent_hooks_auto_get")) as unknown as Promise<boolean>;
    const before = await autoOn();
    await browser.execute(() => (document.querySelector('[data-testid="welcome-start"]') as HTMLElement).click());
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useUI.getState().welcomeOpen === false),
      { timeout: 10_000, timeoutMsg: "the welcome screen never closed" },
    );
    expect(await autoOn()).toBe(before);
    expect(await guideState("activeGuide")).toBe("welcome");
    // (Not "seen is empty": the tour settles the steps this profile has
    // already done, such as having a project, the moment it starts.)
    const seen = await guideState("seen") as string[];
    for (const id of ["statusLine", "agentHooks", "addCredentials", "agentWaiting"]) expect(seen).not.toContain(id);
  });

  it("points a new install at Add project, without taking focus", async () => {
    // Re-applied until it holds. Finishing the welcome screen saves settings,
    // and a `loadAll()` still in flight from that puts the real projects back
    // over the simulated empty store, which the guide then reads (correctly)
    // as "this user has a project" and settles the tip unseen.
    await browser.waitUntil(async () => {
      await browser.execute(() => {
        const t = window.__termic!;
        t.useGuide.getState().startGuide("welcome");
        t.useApp.setState({ projects: [], tasks: [], activeTaskId: null });
      });
      return (await shownTip()) === "addProject";
    }, { timeout: 15_000, interval: 400, timeoutMsg: "the Add project tip never showed on an empty install" });
    await browser.waitUntil(() => ringHugs('[data-testid="sidebar-add-project"]'), {
      timeout: 5_000, timeoutMsg: "the ring is not round the Add project button",
    });
    expect(await cardClearOf('[data-testid="sidebar-add-project"]')).toBe(true);
    expect(await browser.execute((s) => !!document.activeElement?.closest(s), TIP)).toBe(false);
    // Every card has "Got it", an action card too: doing the thing is one
    // way to end it, saying you have read it is the other.
    expect(await browser.execute((s) => !!document.querySelector(`${s} [data-testid="guide-tip-ok"]`), TIP)).toBe(true);
    // Where the user is in the tour, and how much is left.
    expect(await browser.execute(() => document.querySelector('[data-testid="guide-step-count"]')?.textContent)).toBe("1/5");
    await snap("guide-02-add-project.png");
  });

  it("steps aside while a dialog covers the control, and comes back after", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openNewProject());
    await waitGone(TIP);
    await browser.execute(() => {
      const ui = window.__termic!.useUI.getState() as any;
      (ui.closeNewProject ?? ui.setNewProjectOpen)?.(false);
    });
    await browser.keys("Escape");
    await waitVisible(tip("addProject"));
  });

  it("moves on to starting a task as soon as a project exists", async () => {
    // The projects come back in ONE store write, with no tasks and both
    // projects already open (so two "New task" rows are on screen). Going
    // through loadAll() put the tasks other spec files left in the profile on
    // screen for a render, and the guide settled every task step for good.
    await browser.execute(async (ids) => {
      const t = window.__termic!;
      for (const id of ids) t.useApp.getState().setProjectCollapsed(id, false);
      const projects = await t.ipc.projectsList();
      t.useApp.setState({ projects, tasks: [], activeTaskId: null });
    }, [projectId, otherId]);
    await waitVisible(`[data-testid="project-empty-new-task-${otherId}"]`);
    await waitVisible(tip("newTask"));
    // Settled by the project existing, not by anyone pressing Next.
    expect(await guideState("seen")).toContain("addProject");
    await browser.waitUntil(() => ringHugs(`[data-testid="project-empty-new-task-${projectId}"]`), {
      timeout: 5_000, timeoutMsg: "the ring is not round the project's New task row",
    });
    expect(await browser.execute(() => document.querySelector('[data-testid="guide-step-count"]')?.textContent)).toBe("4/5");
    await snap("guide-03-new-task.png");
  });

  it("explains main checkout and worktree inside the launcher, and Got it leaves the menu open", async () => {
    const trigger = `[data-testid="project-empty-new-task-${projectId}"]`;
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"] [data-guide="task-mode"]');
    // Pressing the control the card pointed at finishes that card, for good.
    expect(await guideState("seen")).toContain("newTask");
    await waitVisible(tip("taskMode"));
    expect(await cardClearOf('[role="menu"] [data-guide="task-mode"]')).toBe(true);
    await snap("guide-04-task-mode.png");
    await pressOnCard("guide-tip-ok");
    await browser.waitUntil(async () => (await guideState("seen") as string[]).includes("taskMode"), {
      timeout: 5_000, timeoutMsg: "Got it did not dismiss the tip",
    });
    // The whole point of the card swallowing its own pointerdown: Radix
    // treats a press outside a menu as "close it".
    expect(await browser.execute(() => !!document.querySelector('[role="menu"][data-state="open"] [data-guide="task-mode"]'))).toBe(true);
    await browser.keys("Escape");
    await waitGone('[role="menu"][data-state="open"] [data-guide="task-mode"]');
    // A closing menu's exit animation never finishes on an occluded window,
    // which leaves its node mounted and `pointer-events: none` parked on
    // <body>. Every anchor then fails its hit test, correctly: nothing on
    // screen can be clicked. The app clears that lock itself
    // (lib/pointerEventsGuard); a spec has to ask.
    await dismissOverlays();
  });

  it("explains the name on the field while it is being typed, and leaves the caret there", async () => {
    // Pick an agent from the launcher: the "New task" row turns into the
    // name field, which is where this card belongs.
    const trigger = `[data-testid="project-empty-new-task-${projectId}"]`;
    const field = `[data-guide="task-name"]`;
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"] [data-guide="task-mode"]');
    await clickMenuItemUntil("FakeAgent", field);
    await waitVisible(tip("nameTask"));
    await browser.waitUntil(() => ringHugs(field), { timeout: 5_000, timeoutMsg: "the ring is not round the task name field" });
    expect(await cardClearOf(field)).toBe(true);
    // The user is typing: with the caret in the field, the card does not take
    // it. The spec puts the caret there itself: the field focuses itself two
    // animation frames after it mounts, and a hidden e2e window runs no
    // animation frames at all (measured: none in 3s), so waiting for that
    // tests the window, not the card.
    await browser.execute((sel) => (document.querySelector(sel) as HTMLInputElement).focus(), field);
    await browser.waitUntil(
      () => browser.execute((sel) => document.activeElement === document.querySelector(sel), field),
      { timeout: 3_000, timeoutMsg: "the caret never reached the task name field" },
    );
    expect(await browser.execute((s) => !!document.querySelector(`${s} [data-testid="guide-tip-ok"]`), TIP)).toBe(true);
    await snap("guide-05-name-task.png");
    // Clicking into the field is not an answer: the card stays.
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.click();
    }, field);
    expect(await shownTip()).toBe("nameTask");
    expect(await guideState("seen")).not.toContain("nameTask");
    // Backing out takes the field away, and the card with it.
    await browser.keys("Escape");
    await waitGone(field);
    await waitGone(TIP);
    await dismissOverlays();
  });

  it("Got it on the name card ends it for good and leaves the caret in the field", async () => {
    const trigger = `[data-testid="project-empty-new-task-${projectId}"]`;
    const field = `[data-guide="task-name"]`;
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"] [data-guide="task-mode"]');
    await clickMenuItemUntil("FakeAgent", field);
    await waitVisible(tip("nameTask"));
    // Typing (see the case above for why the spec places the caret).
    await browser.execute((sel) => (document.querySelector(sel) as HTMLInputElement).focus(), field);
    await pressOnCard("guide-tip-ok");
    await waitGone(TIP);
    expect(await guideState("seen")).toContain("nameTask");
    expect(await browser.execute((sel) => document.activeElement === document.querySelector(sel), field)).toBe(true);
    // Backing out and coming back does not bring it back.
    await browser.keys("Escape");
    await waitGone(field);
    await dismissOverlays();
    expect(await shownTip()).toBe(null);
  });

  it("does not point at New task again, on this project or another, once it has been pressed", async () => {
    // The reported failure: press "New task" on one project, start naming
    // the task, and the card reappears on the NEXT project's "New task".
    // Both rows are on screen and reachable here, there is still no task,
    // and the user backed out. Nothing may be drawn.
    for (const id of [projectId, otherId]) {
      await waitVisible(`[data-testid="project-empty-new-task-${id}"]`);
    }
    expect(await browser.execute(() => window.__termic!.useApp.getState().tasks.filter((t: any) => !t.archived).length)).toBe(0);
    expect(await guideState("activeGuide")).toBe("welcome");
    await waitGone(TIP);
    expect(await shownTip()).toBe(null);
  });

  it("ends on the first task's status mark, with no further cards", async () => {
    const id = await openTask("guide-tour-a");
    made.push(id);
    await ensureActiveTask(id);
    await browser.execute(() => {
      const s = window.__termic!.useApp.getState() as any;
      if (s.rightPanelHidden) s.toggleRightPanel?.();
    });

    // Straight to what the mark means. There is no "this is a tab" card.
    expect(await guideState("seen")).toContain("newTask");
    await waitVisible(tip("taskStatus"));
    await browser.waitUntil(() => ringHugs(`[data-sidebar-task-id="${id}"]`), {
      timeout: 5_000, timeoutMsg: "the ring is not round the active task's sidebar row",
    });
    // The real legend, with the real badges, not a description of them.
    await waitVisible(`${TIP} [data-testid="work-mark-legend"]`);
    await snap("guide-06-task-status.png");
    await pressOnCard("guide-tip-ok");

    // That was the last card: the intro is the basics and nothing else.
    await waitGone(TIP);
    expect(await guideState("activeGuide")).toBe(null);
  });

  it("can be skipped from any card", async () => {
    await guide("startGuide", "welcome");
    await waitVisible(tip("taskStatus"));
    await pressOnCard("guide-skip-tour");
    await waitGone(TIP);
    expect(await guideState("activeGuide")).toBe(null);
  });

  it("shows nothing while Settings is open, and Settings can replay the tour", async () => {
    await guide("startGuide", "welcome");
    await waitVisible(tip("taskStatus"));
    // Settings does not cover the title bar, so a tip anchored up there would
    // still pass its hit test and draw half under the settings panel. The
    // layer stands down for the whole overlay instead.
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitVisible('[data-testid="replay-tour"]');
    await waitGone(TIP);
    // No screenshot of this page: Settings > General lists the forge accounts
    // signed in on the machine running the spec, which is real data.
    await guide("skipGuide");
    expect(await guideState("activeGuide")).toBe(null);

    // Reset: everything already shown is forgotten, and nothing starts.
    expect((await guideState("seen") as string[]).length).toBeGreaterThan(0);
    await browser.execute(() => (document.querySelector('[data-testid="reset-tips"]') as HTMLElement).click());
    await browser.waitUntil(async () => (await guideState("seen") as string[]).length === 0, {
      timeout: 5_000, timeoutMsg: "Reset did not clear what was seen",
    });
    expect(await guideState("activeGuide")).toBe(null);
    expect(await browser.execute(() => localStorage.getItem("guideShown"))).toBe("[]");

    await browser.execute(() => (document.querySelector('[data-testid="replay-tour"]') as HTMLElement).click());
    await browser.waitUntil(async () => (await guideState("activeGuide")) === "welcome", {
      timeout: 5_000, timeoutMsg: "Replay did not start the tour",
    });
    // Settings closes, because the tour points at the app underneath it.
    await waitVisible(tip("taskStatus"));
  });

  it("skipping from the welcome screen skips the tour and leaves the tips armed", async () => {
    await browser.execute(() => {
      const t = window.__termic!;
      t.useGuide.getState().resetAll();
      t.useGuide.setState({ seen: [], activeGuide: null, tipsSpent: 0 });
      t.useUI.getState().openWelcome();
    });
    await waitVisible('[data-testid="welcome-skip-tour"]');
    await browser.execute(() => (document.querySelector('[data-testid="welcome-skip-tour"]') as HTMLElement).click());
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useUI.getState().welcomeOpen === false),
      { timeout: 10_000, timeoutMsg: "the welcome screen never closed" },
    );
    expect(await guideState("activeGuide")).toBe(null);
    const seen = await guideState("seen") as string[];
    // The tour's cards are done with.
    for (const id of ["addProject", "taskMode", "nameTask", "newTask", "taskStatus"]) expect(seen).toContain(id);
    // The tips are not: skipping a tour is not turning tips off, and they
    // are what explains a footer that says "usage n/a".
    for (const id of ["statusLine", "agentHooks", "addCredentials", "agentWaiting", "reviewChanges", "commandPalette"]) {
      expect(seen).not.toContain(id);
    }
    // No tour card comes back with a task on screen.
    await waitGone(TIP);
  });
});

// Feature tips. All three point at the task footer's agent chip, which
// carries a different anchor name for each state it can be in, so each case
// puts the chip in one state and asserts which tip answers.
describe("feature tips on the footer chip", () => {
  const AGENT = "fakeclaude";
  const made: string[] = [];
  let root = "";
  let projectId = "";
  let madeClaudeDir = false;

  const openWith = async (name: string) => {
    const id = await openTask(name, true, AGENT);
    made.push(id);
    await ensureActiveTask(id);
    return id;
  };
  /** An install that predates these tips: set up, never took the tour (so it
   *  is not running), has seen no feature tip, and has spent none this
   *  launch. Written straight into the store: `skipGuide("welcome")` is what a user who
   *  DECLINED does, and it puts every existing tip away. */
  const asUpgradedInstall = () => browser.execute(() => {
    const g = window.__termic!.useGuide;
    g.getState().resetAll();
    g.setState({ seen: [], activeGuide: null, tipsSpent: 0, tipsEnabled: true, suppressed: false });
  });
  const seedUsage = (pct: number) => browser.execute((agent, p) => {
    window.__termic!.useAgentUsage.getState().report(agent, null, {
      session: { usedPercent: p, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      weekly: { usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    }, "statusline");
  }, AGENT, pct);
  const settingsFile = () => path.join(root, ".claude", "settings.json");

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    const proj = await browser.execute(() => {
      const p = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      return { id: p.id as string, root: p.root_path as string };
    });
    projectId = proj.id;
    root = proj.root;
  });

  after(async () => {
    // The fixture repo is shared, and an UNTRACKED file left in it fails the
    // next run's git specs rather than this one.
    try { fs.rmSync(settingsFile(), { force: true }); } catch { /* never written */ }
    if (madeClaudeDir) { try { fs.rmdirSync(path.join(root, ".claude")); } catch { /* not empty: not ours */ } }
    await browser.execute((agent) => {
      const t = window.__termic!;
      t.useGuide.getState().setSuppressed(true);
      t.useGuide.getState().skipGuide("welcome");
      t.useAgentUsage.setState({ byAgent: {}, cost: {} });
      t.useUsageUnknownDismissed.getState().setDismissed(agent, false);
      t.useApp.getState().closeSettings();
    }, AGENT);
    await browser.keys("Escape");
    await browser.execute(() => window.__termic!.useApp.getState().refreshAgentHooks());
    for (const id of made) { try { await archiveTask(id); } catch { /* already gone */ } }
  });

  it("says nothing about a chip that is simply showing numbers", async () => {
    const id = await openWith("guide-chip");
    await seedUsage(30);
    await waitVisible(`[data-task-id="${id}"] [data-testid="usage-chip"]:not([data-guide])`);
    await asUpgradedInstall();
    // Someone reading their usage here knows what the chip is. The layer has
    // tips pending and a task on screen, and still draws nothing.
    await browser.waitUntil(async () => (await guideState("ready")) === true);
    expect(await shownTip()).toBe(null);
    expect(await guideState("present")).toEqual({});
  });

  it("offers a second login when the account hits its limit, and remembers having shown it", async () => {
    await seedUsage(96);
    const limit = '[data-testid="usage-chip"][data-guide~="addCredentials"]';
    await waitVisible(limit);
    await waitVisible(tip("addCredentials"));
    await waitForText("Tip");
    await browser.waitUntil(() => ringHugs(limit), { timeout: 5_000, timeoutMsg: "the ring is not round the chip at its limit" });
    expect(await cardClearOf(limit)).toBe(true);
    // A feature tip is not part of a tour, so there is none to skip.
    expect(await browser.execute((s) => !!document.querySelector(`${s} [data-testid="guide-skip-tour"]`), TIP)).toBe(false);
    await snap("guide-09-limit.png");

    // Nobody presses anything. Once it has been up long enough to be read it
    // is on record as shown, and it stays on screen for this window.
    await browser.waitUntil(
      () => browser.execute(() => (JSON.parse(localStorage.getItem("guideShown") ?? "[]") as string[]).includes("addCredentials")),
      { timeout: 10_000, timeoutMsg: "the tip was on screen and never recorded as shown" },
    );
    expect(await shownTip()).toBe("addCredentials");
    // What the next launch does with that record: reads it as seen. The limit
    // is still hit and the chip still says so, and the card does not return.
    await browser.execute(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "guideShown" }));
      window.__termic!.useGuide.setState({ tipsSpent: 0 });
    });
    await waitGone(TIP);
    expect(await browser.execute((s) => !!document.querySelector(s), limit)).toBe(true);
    expect(await guideState("seen")).toContain("addCredentials");
  });

  it("shows no tip with Show tips off, even when its situation holds", async () => {
    // Same chip, same limit, and a launch that has spent nothing: the only
    // thing in the way is the preference.
    await browser.execute(() => {
      const g = window.__termic!.useGuide;
      g.getState().resetAll();
      g.setState({ tipsSpent: 0 });
      g.getState().setTipsEnabled(false);
    });
    await waitVisible('[data-testid="usage-chip"][data-guide~="addCredentials"]');
    expect(await guideState("present")).toEqual({ addCredentials: 1 });
    await waitGone(TIP);
    expect(await shownTip()).toBe(null);
    // Back on, the same situation is answered, which proves the preference
    // was what held it.
    await browser.execute(() => window.__termic!.useGuide.getState().setTipsEnabled(true));
    await waitVisible(tip("addCredentials"));
    await pressOnCard("guide-tip-ok");
    await waitGone(TIP);
  });

  it("ends when the user presses the control it points at, without Got it", async () => {
    // The reported case: the "nearly out" card stayed up over the account
    // panel its own chip had just opened.
    await browser.execute(() => {
      const g = window.__termic!.useGuide;
      g.getState().resetAll();
      g.setState({ tipsSpent: 0 });
    });
    const limit = '[data-testid="usage-chip"][data-guide~="addCredentials"]';
    await waitVisible(tip("addCredentials"));
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, limit);
    await waitGone(TIP);
    expect(await guideState("seen")).toContain("addCredentials");
    await browser.keys("Escape");
    await dismissOverlays();
    expect(await shownTip()).toBe(null);
  });

  it("says hooks are off when that is why the chip is empty", async () => {
    await browser.execute(() => window.__termic!.useAgentUsage.setState({ byAgent: {}, cost: {} }));
    const unhooked = '[data-testid="usage-chip"][data-guide~="agentHooks"]';
    // Re-applied until it holds: a hook status refresh in flight writes both
    // maps back from disk.
    await browser.waitUntil(async () => {
      await browser.execute((agent) => {
        const t = window.__termic!;
        const s = t.useApp.getState();
        t.useUsageUnknownDismissed.getState().setDismissed(agent, false);
        t.useApp.setState({
          agentHooksSupported: { ...s.agentHooksSupported, [agent]: true },
          agentHooksInstalled: { ...s.agentHooksInstalled, [agent]: false },
        });
        // A new launch, as far as the one-per-launch allowance goes.
        t.useGuide.setState({ tipsSpent: 0 });
      }, AGENT);
      return (await shownTip()) === "agentHooks";
    }, { timeout: 15_000, interval: 400, timeoutMsg: "the hooks tip never showed on an unhooked agent's chip" });
    await browser.waitUntil(() => ringHugs(unhooked), { timeout: 5_000, timeoutMsg: "the ring is not round the unhooked chip" });
    await snap("guide-10-hooks-off.png");
    await pressOnCard("guide-tip-ok");
    await waitGone(TIP);
  });

  it("says a custom status line is in the way, on the chip that shows it", async () => {
    // A project that ships its own Claude status line. Synthetic: the shape
    // `status_line_owner` looks for, nothing from a real config.
    madeClaudeDir = !fs.existsSync(path.join(root, ".claude"));
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command: "node ./bar.js" } }));
    // The chip asks who owns the slot when it mounts, so a task opened AFTER
    // the file exists is the one that sees it.
    const id = await openWith("guide-blocked");
    const blocked = `[data-task-id="${id}"] [data-testid="usage-blocked-chip"][data-usage-owner="project"]`;
    await waitVisible(blocked);
    await browser.execute(() => window.__termic!.useGuide.setState({ tipsSpent: 0 }));
    await waitVisible(tip("statusLine"));
    await browser.waitUntil(() => ringHugs(blocked), { timeout: 5_000, timeoutMsg: "the ring is not round the blocked chip" });
    await snap("guide-11-status-line.png");
    await pressOnCard("guide-tip-ok");
    await waitGone(TIP);
  });

  it("keeps the fix prompt in the project's settings, and the prompt asks where to put the change", async () => {
    await browser.execute((pid) => window.__termic!.useApp.getState().openSettings("repositories", pid), projectId);
    await waitVisible('[data-repo-tab="advanced"]');
    await browser.execute(() => (document.querySelector('[data-repo-tab="advanced"]') as HTMLElement).click());
    const field = '[data-testid="project-status-line"][data-owner="project"]';
    await waitVisible(field);
    // Names the file that holds it, so the user is not left to work out
    // which of three settings files is in force.
    expect(await browser.execute((s) => document.querySelector(s)!.textContent ?? "", field)).toContain(".claude/settings.json");
    await browser.execute((s) => (document.querySelector(`${s} [data-testid="status-line-copy-prompt"]`) as HTMLElement).click(), field);
    await browser.waitUntil(() => readClipboard().includes("notify;termic;usage"), {
      timeout: 5_000, timeoutMsg: "the prompt never reached the clipboard",
    });
    const prompt = readClipboard();
    // The committed file is the repo's: both ways are offered, and the user
    // chooses before anything is written.
    expect(prompt).toContain("BEFORE CHANGING ANYTHING, ask the user");
    expect(prompt).toContain(".claude/settings.local.json");
    expect(prompt).toContain(".git/info/exclude");
    // Both halves of the footer, not usage alone.
    expect(prompt).toContain("notify;termic;ctx");
    expect(prompt).toContain("node ./bar.js");

    // Without the file the same field says there is nothing to fix.
    fs.rmSync(settingsFile(), { force: true });
    await browser.execute(() => (document.querySelector('[data-repo-tab="scripts"]') as HTMLElement).click());
    await browser.execute(() => (document.querySelector('[data-repo-tab="advanced"]') as HTMLElement).click());
    await waitVisible('[data-testid="project-status-line"]:not([data-owner="project"])');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="status-line-copy-prompt"]'))).toBe(false);
  });
});

// A tip about something happening right now, which has to last to be shown.
describe("a tip for a moment: an agent waiting", () => {
  const made: string[] = [];
  let here = "";
  let there = "";

  /** An install with nothing seen, no guide running, and tips on. */
  const fresh = () => browser.execute(() => {
    const g = window.__termic!.useGuide;
    g.getState().resetAll();
    g.setState({ seen: [], activeGuide: null, tipsSpent: 0, tipsEnabled: true, suppressed: false });
  });
  const present = () => guideState("present") as Promise<Record<string, number>>;
  /** Put an agent tab into the state a finished turn leaves it in. */
  const setWaiting = (taskId: string, on: boolean) => browser.execute((id, w) => {
    const s = window.__termic!.useApp.getState();
    const tab = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
    s.patchTab(id, tab.id, { workState: w ? "done" : undefined });
  }, taskId, on);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    there = await openTask("guide-wait-there");
    here = await openTask("guide-wait-here");
    made.push(there, here);
    await ensureActiveTask(here);
    await fresh();
  });

  after(async () => {
    await browser.execute(() => {
      const t = window.__termic!;
      t.useGuide.getState().setSuppressed(true);
      t.useGuide.getState().skipGuide("welcome");
    });
    for (const id of made) { try { await archiveTask(id); } catch { /* already gone */ } }
  });

  it("says nothing about a wait in the task you are looking at", async () => {
    await setWaiting(here, true);
    // Not the pill: a focused window marks a finished turn in the task on
    // screen as read at once (CI's window is focused, a local hidden run's
    // is not), so whether the pill shows depends on the runner. The claim is
    // about the TIP: for longer than the hold it needs, it never arms.
    const armed = await browser.waitUntil(
      async () => (await present()).agentWaiting !== undefined || (await shownTip()) !== null,
      { timeout: 4_000, interval: 250 },
    ).then(() => true, () => false);
    expect(armed).toBe(false);
    await setWaiting(here, false);
  });

  it("points at the pill once an agent has been waiting elsewhere for a moment, not at once", async () => {
    await setWaiting(there, true);
    const pill = '[data-testid="waiting-agents-pill"]';
    await waitVisible(pill);
    // Not on the frame the wait begins: it has to last.
    expect((await present()).agentWaiting).toBeUndefined();
    expect(await shownTip()).toBe(null);
    await waitVisible(tip("agentWaiting"), 10_000);
    await browser.waitUntil(() => ringHugs(pill), { timeout: 5_000, timeoutMsg: "the ring is not round the waiting pill" });
    expect(await cardClearOf(pill)).toBe(true);
    await snap("guide-12-agent-waiting.png");
  });

  it("drops it the moment the wait is over, and a wait that only flickers never shows it", async () => {
    await setWaiting(there, false);
    await waitGone(TIP);
    expect((await present()).agentWaiting).toBeUndefined();
    // On and straight off again, well inside the delay.
    await setWaiting(there, true);
    await setWaiting(there, false);
    expect(await shownTip()).toBe(null);
    // Still unseen, so a real wait later can still be pointed at.
    expect(await guideState("seen")).not.toContain("agentWaiting");
  });

  it("does not come back after the user does what it says, without pressing Got it", async () => {
    // Shown, read, acted on: the wait ends because the user went and dealt
    // with it. Nobody pressed Got it. The next agent to wait elsewhere must
    // not bring the same card back.
    await fresh();
    await setWaiting(there, true);
    await waitVisible(tip("agentWaiting"), 10_000);
    await browser.waitUntil(
      () => browser.execute(() => (JSON.parse(localStorage.getItem("guideShown") ?? "[]") as string[]).includes("agentWaiting")),
      { timeout: 10_000, timeoutMsg: "the tip was on screen and never recorded as shown" },
    );
    await setWaiting(there, false);
    await waitGone(TIP);
    expect(await guideState("seen")).toContain("agentWaiting");
    expect(await guideState("tipsSpent")).toBe(1);

    await setWaiting(there, true);
    await waitVisible('[data-testid="waiting-agents-pill"]');
    expect((await present()).agentWaiting).toBeUndefined();
    expect(await shownTip()).toBe(null);
    await setWaiting(there, false);
  });

  it("points at the Git tab once the task has changes and its agent has stopped", async () => {
    // The step after the intro: the agent is done, where are the changes.
    await fresh();
    await ensureActiveTask(here);
    await browser.execute(() => {
      const s = window.__termic!.useApp.getState() as any;
      if (s.rightPanelHidden) s.toggleRightPanel();
    });
    const root = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).path as string, here);
    const file = path.join(root, "guide-review-probe.txt");
    const gitTab = '[data-testid="right-tab"][data-guide~="reviewChanges"]';
    try {
      // A clean task: nothing to review, nothing said.
      expect((await present()).reviewChanges).toBeUndefined();
      fs.writeFileSync(file, "changed by the spec\n");
      await browser.execute(() => window.dispatchEvent(new Event("focus")));
      await waitVisible(tip("reviewChanges"), 30_000);
      await browser.waitUntil(() => ringHugs(gitTab), { timeout: 5_000, timeoutMsg: "the ring is not round the Git tab" });
      await snap("guide-14-review-changes.png");
      // Going to the Git view is doing what it says.
      await browser.execute((sel) => (document.querySelector(sel) as HTMLElement).click(), gitTab);
      await waitGone(TIP);
    } finally {
      // The fixture repo is shared: an untracked file left here fails the
      // NEXT run's git specs, not this one.
      fs.rmSync(file, { force: true });
      await browser.execute(() => {
        const btn = [...document.querySelectorAll('[data-testid="right-tab"]')].find(b => b.getAttribute("data-active") === "false" && !b.getAttribute("data-guide")) as HTMLElement | undefined;
        btn?.click();
      });
    }
  });

  it("points at the command palette only for someone who has had the app a while and never opened it", async () => {
    const button = '[data-testid="command-palette-button"]';
    const DAY = 24 * 60 * 60 * 1000;
    const usage = (since: number, launches: number, used: string[] = []) => browser.execute((u) => {
      window.__termic!.useGuide.setState({ usage: u });
    }, { since, launches, used });
    await fresh();
    await browser.execute(() => window.__termic!.useUI.getState().closeCommandPalette());

    // A new install, an hour in: not yet.
    await usage(Date.now() - 60 * 60 * 1000, 1);
    expect((await present()).commandPalette).toBeUndefined();
    // Days have passed but it is only the second launch: installing on
    // Friday and coming back on Monday is not "has had it a while".
    await usage(Date.now() - 4 * DAY, 2);
    expect((await present()).commandPalette).toBeUndefined();
    // Three launches, same day: not yet either.
    await usage(Date.now() - 60 * 60 * 1000, 5);
    expect((await present()).commandPalette).toBeUndefined();
    // Someone who already uses it is never told, however long they have had the app.
    await usage(Date.now() - 30 * DAY, 40, ["command-palette"]);
    expect((await present()).commandPalette).toBeUndefined();
    expect(await shownTip()).toBe(null);

    // Four days, three launches, never opened.
    await usage(Date.now() - 4 * DAY, 3);
    await waitVisible(tip("commandPalette"));
    // A tip is not part of a tour, so it carries no step count.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="guide-step-count"]'))).toBe(false);
    await browser.waitUntil(() => ringHugs(button), { timeout: 5_000, timeoutMsg: "the ring is not round the command palette button" });
    await snap("guide-13-command-palette.png");

    // Opening it, by any route, is the end of the tip: here the shortcut's
    // own store action, not the button.
    await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
    await browser.waitUntil(async () => ((await guideState("usage")) as any).used.includes("command-palette"), {
      timeout: 5_000, timeoutMsg: "opening the palette was not recorded as a use",
    });
    await waitGone(TIP);
    await browser.execute(() => window.__termic!.useUI.getState().closeCommandPalette());
    expect((await present()).commandPalette).toBeUndefined();
  });
});
