import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveTask, FILE_MANAGER_NAME, waitForAgentReady, clickByText, clickMenuItem, clickWhenVisible, cliRpc, dismissOverlays, ensureActiveTask, openTask, pointerDrag, readClipboard, requireTermicApi, runCli, snap, waitForAgentPty, waitForAppShell, waitForText, waitForTextGone, waitForWorkBadge, waitGone, waitVisible, setInputValue, clickPresent, rmTree, textOf, newTaskSection, settledSnap } from "../helpers";
import { dataDir } from "../../wdio.conf.js";

// Click a button by its exact text inside the NewTaskDialog specifically
// (scoped via the name input's dialog — there can be more than one
// [role="dialog"] in the DOM). Waits for the button first: the dialog renders
// progressively (the mode toggle lands after an async worktree scan). Module
// scope so both "create task wizard" and "worktree task" below can drive the
// real dialog instead of the IPC shortcut.
async function clickDialogButton(text: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((t) => {
        const dlg = document
          .querySelector('input[placeholder="fix login bug"]')
          ?.closest('[role="dialog"]');
        return [...(dlg?.querySelectorAll("button") ?? [])].some(
          (b) => b.textContent?.trim() === t,
        );
      }, text),
    { timeout: 8_000, timeoutMsg: `dialog button never appeared: ${text}` },
  );
  await browser.execute((t) => {
    const dlg = document
      .querySelector('input[placeholder="fix login bug"]')
      ?.closest('[role="dialog"]');
    const btn = [...(dlg?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === t,
    );
    (btn as HTMLElement).click();
  }, text);
}

// P0: create a task through the real NewTaskDialog wizard (the primary user
// path; the other specs take the IPC shortcut). Uses the shell ("Terminal")
// CLI in Main-checkout (repo-root) mode so it's token-free and safe to archive.
// Everything is scoped to the dialog: the app footer also has a "Terminal"
// button, so an unscoped text match would hit the wrong control.
describe("create task wizard", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("creates a repo-root shell task via NewTaskDialog", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Open the wizard for fixture-repo (the sidebar "+" action).
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(
              '[role="dialog"] input[placeholder="fix login bug"]',
            ),
        ),
      { timeout: 8_000, timeoutMsg: "NewTaskDialog never opened" },
    );

    // Force Main checkout (repo-root) mode — the last-used mode is persisted.
    await clickDialogButton("Main checkout");

    // Type the task name into the controlled input.
    await browser.execute(() => {
      const input = document.querySelector(
        '[role="dialog"] input[placeholder="fix login bug"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-wizard");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Pick the Terminal (shell) CLI — token-free — then Create.
    await clickDialogButton("Terminal");
    await clickDialogButton("Create");

    // A repo-root task with that name now exists.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          window.__termic!.useApp
            .getState()
            .tasks.some((t: any) => t.name === "e2e-wizard" && !t.archived),
        ),
      { timeout: 15_000, timeoutMsg: "wizard did not create the task" },
    );
    taskId = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.name === "e2e-wizard" && !t.archived)?.id,
    );

    await snap("create-wizard.png");
  });

  // A name that slugs away to nothing. Branch names are a-z0-9-_ (the slug is
  // a worktree DIRECTORY as well as a git ref), so a non-Latin name leaves
  // nothing to build one from. This used to compose `sim/` from the prefix and
  // an empty slug, which is not a ref at all, and the create died several
  // layers down in git's own words; without a prefix it sent "" and Rust
  // silently named the branch `日本語` instead. Now: no branch, Create
  // disabled, and a sentence saying why at the field that is empty.
  it("says why a name with no a-z0-9 in it cannot become a branch", async () => {
    await waitForAppShell();
    await requireTermicApi();

    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await browser.waitUntil(
      () => browser.execute(() =>
        !!document.querySelector('[role="dialog"] input[placeholder="fix login bug"]')),
      { timeout: 8_000, timeoutMsg: "NewTaskDialog never opened" },
    );
    // Worktree mode: the branch field only exists there.
    await clickDialogButton("Worktree");

    const typeName = (value: string) => browser.execute((v) => {
      const input = document.querySelector(
        '[role="dialog"] input[placeholder="fix login bug"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);

    const branchValue = () => browser.execute(() =>
      (document.querySelector(
        '[role="dialog"] input[placeholder="feature/fix-login-bug"]',
      ) as HTMLInputElement | null)?.value ?? null);
    const createDisabled = () => browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"] button, button[form="new-task-form"]')]
        .find(b => b.textContent?.trim() === "Create")?.hasAttribute("disabled") ?? null);

    await typeName("日本語");
    await waitVisible('[data-testid="name-unslugabble"]');
    expect(await branchValue()).toBe("");
    expect(await createDisabled()).toBe(true);
    const warning = await browser.execute(() =>
      (document.querySelector('[data-testid="name-unslugabble"]') as HTMLElement)?.innerText ?? "");
    expect(warning).toContain("at least one letter or number");
    await snap("new-task-unslugabble.png");

    // An ASCII name clears it and derives a branch again, so the warning is
    // about THIS name rather than a state the dialog gets stuck in.
    await typeName("fix login bug");
    await waitGone('[data-testid="name-unslugabble"]');
    expect(await branchValue()).toMatch(/fix-login-bug$/);
    expect(await createDisabled()).toBe(false);

    // Nothing was created, so there is nothing to clean up.
    await clickDialogButton("Cancel");
  });

  // GH #242: worktree creation used to lock the whole window behind this
  // dialog until `git worktree add` + the file copy finished. Prove the fix
  // at the UI level — the dialog is gone the instant Create is clicked, not
  // once the worktree is actually ready. Worktree mode this time (not
  // repo-root): that's the path that used to block.
  it("closes the dialog immediately on Create, before the worktree is ready", async () => {
    await waitForAppShell();
    await requireTermicApi();

    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector(
              '[role="dialog"] input[placeholder="fix login bug"]',
            ),
        ),
      { timeout: 8_000, timeoutMsg: "NewTaskDialog never opened" },
    );

    await clickDialogButton("Worktree");
    await browser.execute(() => {
      const input = document.querySelector(
        '[role="dialog"] input[placeholder="fix login bug"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "e2e-wizard-wt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickDialogButton("Terminal");
    await clickDialogButton("Create");

    // The dialog closes synchronously with the click — it does not await
    // `taskCreate` first. A short timeout is the point: this must not need
    // to wait anywhere near as long as a real worktree add would take.
    await waitGone('[role="dialog"] input[placeholder="fix login bug"]', 2_000);

    // ...and the worktree still lands once it's actually ready.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          window.__termic!.useApp
            .getState()
            .tasks.some((t: any) => t.name === "e2e-wizard-wt" && !t.archived),
        ),
      { timeout: 15_000, timeoutMsg: "worktree task never landed after the dialog closed early" },
    );
    const wtTaskId: string = await browser.execute(
      () =>
        window.__termic!.useApp
          .getState()
          .tasks.find((t: any) => t.name === "e2e-wizard-wt" && !t.archived)?.id,
    );
    // The dialog closes before the worktree exists (that is the point of
    // the case), so wait for it before tearing it down: archiving a
    // checkout git is still writing fails on Windows, and deletes a branch
    // that does not exist yet.
    await waitForAgentPty(wtTaskId, 30_000);
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskArchive(id, true); // deleteBranch
      await window.__termic!.useApp.getState().loadAll();
    }, wtTaskId);
    try {
      execSync(`git -C "${fixture}" worktree prune`);
    } catch {
      /* already gone */
    }
  });
});

/** Argv of every spawn a task has made, oldest first (the fixture logs it:
 *  terminal output is a canvas, so this is the only way to read it). */
const spawnArgv = (id: string): string[] => {
  const log = path.join(dataDir, "e2e-agent-argv.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n")
    .filter((l) => l.startsWith(id + "\t"))
    .map((l) => l.slice(id.length + 1));
};

const firstSpawnArgv = async (id: string) => {
  await browser.waitUntil(async () => spawnArgv(id).length > 0, {
    timeout: 20_000, timeoutMsg: "the agent never spawned",
  });
  return spawnArgv(id)[0];
};

// The New Task dialog's layout: one fixed size, a rail of sections on the
// left, one pane per section. These cases pin what the redesign promised: the
// size never moves under the pointer, the rail shows every section's value
// and flags a warning in a pane you have not opened, explanations live behind
// (i) while warnings stay on screen, a disabled Create says what is missing
// and goes there from any section, and Cmd+Enter creates.
describe("new task dialog: side rail", () => {
  const NAME = '[data-testid="new-task-name"]';
  const created: string[] = [];
  let projectId!: string;

  after(async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    for (const id of created) await archiveTask(id);
  });

  const open = async () => {
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), projectId);
    await waitVisible(`[role="dialog"] ${NAME}`, 8_000);
  };
  const close = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    await waitGone(`[role="dialog"] ${NAME}`);
  };
  const typeName = (v: string) => setInputValue(NAME, v);
  const dialogSize = () =>
    browser.execute((sel) => {
      const b = (document.querySelector(sel)!.closest('[role="dialog"]') as HTMLElement).getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    }, NAME);
  /** Which pane shows, and the rail's entries as label + value. */
  const railState = () =>
    browser.execute(() => {
      const panes = [...document.querySelectorAll('[role="dialog"] [role="tabpanel"]')] as HTMLElement[];
      return {
        showing: panes.filter((p) => getComputedStyle(p).display !== "none").map((p) => p.getAttribute("data-testid")),
        rail: [...document.querySelectorAll('[data-testid="new-task-rail"] [role="tab"]')].map((b) => b.getAttribute("data-testid")),
        selected: document.querySelector('[data-testid="new-task-rail"] [aria-selected="true"]')?.getAttribute("data-testid"),
      };
    });
  const sub = (id: string) => textOf(`[data-testid="rail-${id}-sub"]`);
  const railWarn = (id: string) =>
    browser.execute((i) => document.querySelector(`[data-testid="rail-${i}"] [data-testid="rail-warn"]`)?.getAttribute("data-warn") ?? null, id);
  const blocked = () =>
    browser.execute(() => document.querySelector('[data-testid="new-task-create"]')?.getAttribute("data-blocked") ?? null);
  const focusedTestId = () =>
    browser.execute(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null);
  /** Click the disabled Create's wrapper. Blurs first: `setInputValue`
   *  focuses the field it fills, which would make the jump look done. */
  const clickCreateWrap = () =>
    browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      (document.querySelector('[data-testid="new-task-create-wrap"]') as HTMLElement).click();
    });
  const optionEnabled = (m: string) =>
    browser.execute((mode) => {
      const b = document.querySelector(`[role="dialog"] [data-sandbox-option="${mode}"]`) as HTMLButtonElement | null;
      return !!b && !b.disabled;
    }, m);

  it("opens on Task with Name focused and the rest of the sections in the rail", async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo").id);
    await open();
    // Focus starts on Name, not on the first (i): a focused (i) shows its
    // tooltip, which would then swallow the first Escape.
    await browser.waitUntil(async () => (await focusedTestId()) === "new-task-name",
      { timeout: 5_000, timeoutMsg: "the dialog did not open with Name focused" });
    expect(await browser.execute(() => document.querySelectorAll("[data-radix-popper-content-wrapper]").length)).toBe(0);
    // ...which is what the gotcha is about: ONE Escape closes it.
    await browser.keys("Escape");
    await waitGone(`[role="dialog"] ${NAME}`);
    await open();
    await clickDialogButton("Main checkout");
    await clickDialogButton("FakeAgent");
    // Single repo, no roles in this profile, an agent picked: no Repos, no
    // Secrets.
    expect(await railState()).toEqual({
      showing: ["new-task-pane-task"],
      rail: ["rail-task", "rail-agent", "rail-isolation"],
      selected: "rail-task",
    });
    expect(await sub("task")).toBe("Main checkout, blank");
    await settledSnap("new-task-c-task.png");
  });

  it("keeps one size through task type, source, section and sandbox mode", async () => {
    const before = await dialogSize();
    const same = async (what: string) => expect({ what, ...(await dialogSize()) }).toEqual({ what, ...before });
    await clickDialogButton("Worktree");
    await same("worktree");
    expect(await sub("task")).toBe("Worktree, new branch");
    await clickWhenVisible('[data-source-tab="branch"]');
    await same("existing branch source");
    expect(await sub("task")).toBe("Worktree, existing branch");
    await clickWhenVisible('[data-source-tab="import"]');
    await waitVisible('[data-testid="import-list"]');
    await same("import source");
    expect(await sub("task")).toBe("Worktree, import");
    await clickWhenVisible('[data-source-tab="new"]');
    for (const s of ["agent", "isolation", "task"]) {
      await newTaskSection(s);
      await same(`${s} section`);
    }
    // The sandbox config is the tallest pane. Seatbelt is macOS-only, so
    // elsewhere this step has nothing to open.
    await newTaskSection("isolation");
    if (await optionEnabled("enforce")) {
      await clickWhenVisible('[role="dialog"] [data-sandbox-option="enforce"]');
      await waitVisible('[data-testid="new-task-pane-isolation"] [data-testid="sandbox-config"]');
      await same("enforcing sandbox");
      expect(await sub("isolation")).toBe("Enforcing");
      const overflow = await browser.execute(() => {
        const p = document.querySelector('[data-testid="new-task-pane-isolation"]') as HTMLElement;
        return { scroll: p.scrollHeight, client: p.clientHeight };
      });
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
      await settledSnap("new-task-c-isolation-enforcing.png");
      await clickWhenVisible('[role="dialog"] [data-sandbox-option="off"]');
      await waitGone('[data-testid="sandbox-config"]');
    }
    expect(await sub("isolation")).toBe("Off");
    await same("sandbox off again");
  });

  it("lists the sandbox modes in a column, each saying what it does", async () => {
    await clickWhenVisible('[role="dialog"] [data-sandbox-option="off"]');
    expect(await textOf('[role="dialog"] [data-sandbox-option="off"]')).toContain("Full filesystem + network access.");
    // a column beside the settings, not a strip above them.
    const xs = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] [data-sandbox-option]')]
      .map((b) => Math.round(b.getBoundingClientRect().left)));
    expect(new Set(xs).size).toBe(1);
    const pressed = await browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"] [data-sandbox-option]')]
        .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-sandbox-option")));
    expect(pressed).toEqual(["off"]);
    // loosest to tightest, Docker last. Off Mac only off + docker render.
    const order = await browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"] [data-sandbox-option]')].map((b) => b.getAttribute("data-sandbox-option")));
    expect(order).toEqual(["off", "monitor", "enforce-fs", "enforce", "docker"].filter((id) => order.includes(id)));
  });

  it("lists the agents in a column, like Settings > Agents", async () => {
    await newTaskSection("agent");
    const xs = await browser.execute(() => [...document.querySelectorAll('[data-testid="new-task-pane-agent"] [data-cli]')]
      .map((b) => Math.round(b.getBoundingClientRect().left)));
    expect(xs.length).toBeGreaterThan(1);
    expect(new Set(xs).size).toBe(1);
    await snap("new-task-agent-column.png");
    await newTaskSection("isolation");
    await snap("new-task-sandbox-column.png");
  });

  it("flags uncaged YOLO on the Agent entry from any section, and walks the rail with the arrows", async () => {
    await newTaskSection("agent");
    const yoloBox = '[data-testid="new-task-yolo"] input[type="checkbox"]';
    const yoloOn = () => browser.execute((s) => (document.querySelector(s) as HTMLInputElement).checked, yoloBox);
    const wasOn = await yoloOn();
    if (!wasOn) await clickWhenVisible(yoloBox);
    await newTaskSection("task");
    await browser.waitUntil(async () => (await railWarn("agent")) === "uncaged",
      { timeoutMsg: "YOLO with the sandbox off did not flag the Agent entry" });
    expect(await sub("agent")).toBe("FakeAgent, YOLO on");
    // The reason is on hover and for a screen reader, not just a colour.
    expect(await textOf('[data-testid="rail-agent"] [data-testid="rail-warn"]'))
      .toBe("Nothing cages the agent: it runs every command without asking. Change it later from the task menu.");
    await settledSnap("new-task-c-yolo-flag.png");
    // A cage turns it auto-on and the flag goes.
    if (await optionEnabled("enforce")) {
      await newTaskSection("isolation");
      await clickWhenVisible('[role="dialog"] [data-sandbox-option="enforce"]');
      await browser.waitUntil(async () => (await railWarn("agent")) === null,
        { timeoutMsg: "a full cage left the Agent entry flagged" });
      expect(await sub("agent")).toBe("FakeAgent, YOLO auto-on");
      await clickWhenVisible('[role="dialog"] [data-sandbox-option="off"]');
    }
    await newTaskSection("agent");
    if (!wasOn) await clickWhenVisible(yoloBox);

    // Down from Agent lands on Isolation, up wraps past Task to the last.
    const key = (k: string) =>
      browser.execute((kk) => {
        const b = document.querySelector('[data-testid="rail-agent"]') as HTMLElement;
        b.focus();
        b.dispatchEvent(new KeyboardEvent("keydown", { key: kk, bubbles: true, cancelable: true }));
      }, k);
    await key("ArrowDown");
    expect((await railState()).selected).toBe("rail-isolation");
    expect(await focusedTestId()).toBe("rail-isolation");
    await newTaskSection("task");
  });

  it("counts the agent's YOLO flag typed into Extra args as YOLO on", async () => {
    await newTaskSection("isolation");
    await clickWhenVisible('[role="dialog"] [data-sandbox-option="off"]');
    await newTaskSection("agent");
    // the checkbox off, so the args are the only YOLO there is
    const yoloBox = '[data-testid="new-task-yolo"] input[type="checkbox"]';
    const wasOn = await browser.execute((s) => (document.querySelector(s) as HTMLInputElement).checked, yoloBox);
    if (wasOn) await clickWhenVisible(yoloBox);
    await setInputValue('[data-testid="agent-args"]', "--e2e-flag --dangerously-skip-permissions");
    await newTaskSection("task");
    await browser.waitUntil(async () => (await railWarn("agent")) === "uncaged",
      { timeoutMsg: "a YOLO flag in Extra args did not flag the Agent entry" });
    expect(await sub("agent")).toBe("FakeAgent, YOLO on, extra args");
    // A prefix of the flag is not the flag.
    await newTaskSection("agent");
    await setInputValue('[data-testid="agent-args"]', "--dangerously-skip-permissions-not");
    await browser.waitUntil(async () => (await railWarn("agent")) === null,
      { timeoutMsg: "a different flag sharing the prefix still flagged YOLO" });
    await setInputValue('[data-testid="agent-args"]', "");
    if (wasOn) await clickWhenVisible(yoloBox);
    await newTaskSection("task");
  });

  it("dots Task only for a warning the Task pane is showing", async () => {
    // A name with no slug: a worktree needs a branch from it, Main checkout
    // does not, so only the worktree pane says so and only it gets a dot.
    await clickDialogButton("Main checkout");
    await typeName("修复登录");
    await browser.waitUntil(async () => (await sub("task")).startsWith("Main checkout"));
    expect({ warn: await railWarn("task"), shown: await browser.execute(() => !!document.querySelector('[data-testid="name-unslugabble"]')) })
      .toEqual({ warn: null, shown: false });
    await clickDialogButton("Worktree");
    await waitVisible('[data-testid="name-unslugabble"]');
    expect(await railWarn("task")).toBe("warn");
    await clickDialogButton("Main checkout");
    await browser.waitUntil(async () => (await railWarn("task")) === null,
      { timeoutMsg: "the Task dot outlived its warning" });
    await typeName("");
  });

  it("reopens on Task, without a frame of the section it closed on", async () => {
    await newTaskSection("isolation");
    await close();
    // Record every DOM commit while it reopens: a section reset that runs
    // after paint commits the Isolation pane first, then Task.
    await browser.execute(() => {
      const w = window as any;
      w.__sawIsolation = false;
      w.__obs?.disconnect();
      w.__obs = new MutationObserver(() => {
        // panes hide with the `hidden` CLASS, not the attribute, so ask
        // the computed style: `p.hidden` is false on every pane.
        const p = document.querySelector('[data-testid="new-task-pane-isolation"]') as HTMLElement | null;
        if (p && getComputedStyle(p).display !== "none") w.__sawIsolation = true;
      });
      w.__obs.observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await open();
    const saw = await browser.execute(() => { const w = window as any; w.__obs.disconnect(); return w.__sawIsolation; });
    expect(saw).toBe(false);
    expect((await railState()).selected).toBe("rail-task");
    await browser.waitUntil(async () => (await focusedTestId()) === "new-task-name",
      { timeout: 5_000, timeoutMsg: "the reopened dialog did not focus Name" });
  });

  it("opens an import on a worktree, without changing the remembered task type", async () => {
    await clickDialogButton("Main checkout");
    await close();
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid, { importMode: true }), projectId);
    await waitVisible(`[role="dialog"] ${NAME}`, 8_000);
    const form = () => browser.execute(() => {
      const f = document.querySelector("#new-task-form")!;
      return { mode: f.getAttribute("data-task-mode"), source: f.getAttribute("data-task-source") };
    });
    expect(await form()).toEqual({ mode: "worktree", source: "import" });
    expect(await sub("task")).toBe("Worktree, import");
    // the worktree list is a column beside the fields, like a branch or a PR.
    const LIST = '[data-testid="new-task-picker"] [data-testid="import-column"] [data-testid="import-list"]';
    await waitVisible(LIST);
    await settledSnap("new-task-c-import-worktree.png");
    const side = await browser.execute(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const fields = r('[data-testid="new-task-fields"]');
      const picker = r('[data-testid="new-task-picker"]');
      return { right: picker.x >= fields.x + fields.width, top: Math.abs(picker.y - fields.y) <= 1, wide: picker.width > 200 };
    });
    expect(side).toEqual({ right: true, top: true, wide: true });
    expect(await textOf('[data-testid="new-task-picker"]')).toMatch(/^Existing worktree/);

    // a pick fills Name and unblocks Create. The seeded `sbcheck` worktree
    // is only picked, never imported: other specs need it unopened.
    expect(await blocked()).toBe("import");
    const picked = await browser.execute((sel) => {
      const row = [...document.querySelectorAll(`${sel} [data-worktree-path]`)]
        .find((b) => b.getAttribute("data-worktree-path")!.endsWith("sbcheck")) as HTMLElement | undefined;
      row?.click();
      return !!row;
    }, LIST);
    expect(picked).toBe(true);
    await browser.waitUntil(async () => (await blocked()) === null, { timeout: 5_000, timeoutMsg: "a pick did not unblock Create" });
    expect(await browser.execute((sel) => (document.querySelector(sel) as HTMLInputElement).value, NAME)).toBe("sbcheck");

    // entering import by its tab puts focus on the list, which otherwise
    // sits after Name and the prompt in the tab order.
    await clickWhenVisible('[data-source-tab="new"]');
    await clickWhenVisible('[data-source-tab="import"]');
    expect(await browser.execute(() => !!document.activeElement?.closest('[data-testid="import-list"]'))).toBe(true);

    // a reopen paints the new open's layout: the column it was closed on
    // does not play its way out on a fresh dialog.
    await close();
    await browser.execute(() => {
      const w = window as any;
      w.__sawLeaving = false;
      w.__obs?.disconnect();
      w.__obs = new MutationObserver(() => {
        if (document.querySelector('[data-testid="new-task-picker-leaving"]')) w.__sawLeaving = true;
      });
      w.__obs.observe(document.body, { subtree: true, childList: true });
    });
    await open();
    expect(await browser.execute(() => { const w = window as any; w.__obs.disconnect(); return w.__sawLeaving; })).toBe(false);
    expect((await form()).mode).toBe("repo_root");
  });

  it("keeps a seeded import with nothing to import on its tab, and a blocked Create offers New branch", async () => {
    // a repo with no worktrees but its own, so the import list is empty.
    const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-noimport-"));
    execSync(`git -C "${dir}" init -q && git -C "${dir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`);
    const pid = (await browser.execute(async (d) => {
      const t = window.__termic!;
      const p = await t.ipc.projectAdd(d);
      await t.useApp.getState().loadAll();
      return p.id as string;
    }, dir)) as string;
    try {
      await close();
      await browser.execute((p) => window.__termic!.useUI.getState().openNewTask(p, { importMode: true }), pid);
      await waitVisible('[data-testid="import-empty"]', 8_000);
      expect(await browser.execute(() => document.querySelector("#new-task-form")?.getAttribute("data-task-source"))).toBe("import");
      expect(await browser.execute(() => document.querySelector('[data-source-tab="import"]')?.getAttribute("aria-pressed"))).toBe("true");
      expect(await blocked()).toBe("import");
      await clickCreateWrap();
      expect(await focusedTestId()).toBe("checkout-branch-exit");
      await close();
    } finally {
      await browser.execute(async (p) => {
        const t = window.__termic!;
        try { await t.ipc.projectRemove(p); } catch { /* already gone */ }
        await t.useApp.getState().loadAll();
      }, pid);
      rmSync(dir, { recursive: true, force: true });
    }
    await open();
    await clickDialogButton("Worktree");
  });

  it("keeps explanations behind (i) and warnings on screen", async () => {
    // Worktree: the branch hint is an (i), not a line of text.
    await typeName("fix login bug");
    const PANE = '[data-testid="new-task-pane-task"]';
    const wt = await browser.execute((sel) => {
      const pane = document.querySelector(sel) as HTMLElement;
      return {
        shown: pane.innerText.includes("Auto-fills from the name."),
        tip: !!pane.querySelector('[data-info-tip][aria-label="Auto-fills from the name."]'),
        realFiles: !!document.querySelector('[data-testid="real-files-warn"]'),
      };
    }, PANE);
    expect(wt).toEqual({ shown: false, tip: true, realFiles: false });

    // Main checkout: the description goes behind the (i), its warning stays.
    await clickDialogButton("Main checkout");
    await waitVisible('[data-testid="real-files-warn"]');
    const main = await browser.execute((sel) => {
      const pane = document.querySelector(sel) as HTMLElement;
      return {
        shown: pane.innerText.includes("No worktree. The agent runs"),
        tip: !!pane.querySelector('[data-info-tip][aria-label^="No worktree. The agent runs"]'),
        warn: (document.querySelector('[data-testid="real-files-warn"]') as HTMLElement).innerText.trim(),
      };
    }, PANE);
    expect(main).toEqual({ shown: false, tip: true, warn: "No worktree: the agent edits this checkout directly, on its current branch." });
  });

  it("a disabled Create says what is missing and goes to it from any section", async () => {
    // Main checkout needs only a name. Asked from another section, the jump
    // brings Task back first: a hidden field cannot take focus.
    await typeName("");
    await browser.waitUntil(async () => (await blocked()) === "name", { timeoutMsg: "no name, but Create was not blocked on it" });
    await newTaskSection("isolation");
    await clickCreateWrap();
    expect((await railState()).selected).toBe("rail-task");
    expect(await focusedTestId()).toBe("new-task-name");

    // Worktree with a name but no branch.
    await clickDialogButton("Worktree");
    await typeName("fix login bug");
    await setInputValue('[data-testid="new-task-branch"]', "");
    await browser.waitUntil(async () => (await blocked()) === "branch", { timeoutMsg: "empty branch, but Create was not blocked on it" });
    await clickCreateWrap();
    expect(await focusedTestId()).toBe("new-task-branch");

    // Existing branch source: the branch to check out comes first.
    await clickWhenVisible('[data-source-tab="branch"]');
    await browser.waitUntil(async () => (await blocked()) === "checkout", { timeoutMsg: "no branch picked, but Create was not blocked on it" });
    await clickCreateWrap();
    expect(await focusedTestId()).toBe("checkout-branch-input");
    await clickWhenVisible('[data-source-tab="new"]');

    // Nothing missing: no reason, and Create is live.
    await setInputValue('[data-testid="new-task-branch"]', "e2e/side-rail");
    await browser.waitUntil(async () => (await blocked()) === null, { timeoutMsg: "Create stayed blocked with nothing missing" });
    expect(await browser.execute(() =>
      (document.querySelector('[data-testid="new-task-create"]') as HTMLButtonElement).disabled)).toBe(false);
    await close();
  });

  it("Cmd+Enter creates from any section, and plain Enter in the prompt is still a newline", async () => {
    await open();
    await clickDialogButton("Main checkout");
    await clickDialogButton("FakeAgent");
    const press = (sel: string, meta: boolean) =>
      browser.execute((s, m) => {
        const el = document.querySelector(s) as HTMLElement;
        el.focus();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: m, ctrlKey: false, bubbles: true, cancelable: true }));
      }, sel, meta);
    const prompt = '[role="dialog"] textarea[placeholder^="Describe the task"]';
    // Blocked, Cmd+Enter does what clicking the disabled Create does: it
    // goes to the missing field and creates nothing.
    await typeName("");
    await browser.waitUntil(async () => (await blocked()) === "name", { timeoutMsg: "no name, but Create was not blocked on it" });
    await press(prompt, true);
    expect(await focusedTestId()).toBe("new-task-name");
    expect(await browser.execute((s) => !!document.querySelector(s), `[role="dialog"] ${NAME}`)).toBe(true);
    await typeName("e2e-cmd-enter");
    await press(prompt, false);
    // Still open: a plain Enter in the prompt never creates.
    expect(await browser.execute((s) => !!document.querySelector(s), `[role="dialog"] ${NAME}`)).toBe(true);
    // From the rail of another section, it still creates.
    await newTaskSection("isolation");
    await press('[data-testid="rail-isolation"]', true);
    await waitGone(`[role="dialog"] ${NAME}`);
    const id = await browser.waitUntil(
      () => browser.execute(() =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.name === "e2e-cmd-enter" && !t.archived)?.id ?? false),
      { timeout: 15_000, timeoutMsg: "Cmd+Enter did not create the task" },
    );
    created.push(id as string);
  });

  it("puts the existing-branch list beside the fields, and a pick says it is checked out as is", async () => {
    await open();
    await clickDialogButton("Worktree");
    await clickWhenVisible('[data-source-tab="branch"]');
    const LIST = '[data-testid="new-task-pane-task"] [data-testid="branch-column"] [data-testid="checkout-branch-list"]';
    await waitVisible(LIST);
    // Beside, not under: the same split as an issue or a PR.
    const side = await browser.execute(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const fields = r('[data-testid="new-task-fields"]');
      const picker = r('[data-testid="new-task-picker"]');
      return { right: picker.x >= fields.x + fields.width, top: Math.abs(picker.y - fields.y) <= 1 };
    });
    expect(side).toEqual({ right: true, top: true });
    expect(await textOf('[data-testid="new-task-picker"]')).toMatch(/^Branches/);

    // main is the one branch every seed has.
    await clickWhenVisible(`${LIST} [data-branch-ref="main"]`);
    expect(await browser.execute(() =>
      (document.querySelector('[data-testid="checkout-branch-input"]') as HTMLInputElement).value)).toBe("main");
    // Typing filters the column.
    await setInputValue('[data-testid="checkout-branch-input"]', "mai");
    await browser.waitUntil(() => browser.execute((sel) => {
      const refs = [...document.querySelectorAll(`${sel} [data-branch-ref]`)].map((b) => b.getAttribute("data-branch-ref")!);
      return refs.length > 0 && refs.every((r) => r.includes("mai"));
    }, LIST), { timeoutMsg: "typing did not filter the branch column" });
    await setInputValue('[data-testid="checkout-branch-input"]', "main");
    await waitVisible('[data-testid="checkout-as-is"]');
    expect(await textOf('[data-testid="checkout-as-is"]'))
      .toBe("Checks out main as it is. To start a new branch from it, use New branch.");
    await settledSnap("new-task-c-existing-branch.png");

    // "New branch" in that line: a new branch, cut from the one picked.
    await clickWhenVisible('[data-testid="checkout-branch-from"]');
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector("#new-task-form")?.getAttribute("data-task-source") === "new"),
    { timeoutMsg: "New branch did not switch the source" });
    expect(await browser.execute(() => ({
      base: (document.querySelector('[data-testid="new-task-base"]') as HTMLInputElement).value,
      picker: !!document.querySelector('[data-testid="new-task-picker"]'),
    }))).toEqual({ base: "main", picker: false });
    await close();
  });

  it("sends the Agent pane's extra args, session and resume override with the task", async () => {
    await open();
    await clickDialogButton("Main checkout");
    await clickDialogButton("FakeNoResume");
    await newTaskSection("agent");
    // An agent that cannot resume by id gets no session field.
    await waitVisible('[data-testid="agent-args"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="resume-session"]'))).toBe(false);
    await clickDialogButton("FakeAgent");
    await waitVisible('[data-testid="resume-session"]');
    await setInputValue('[data-testid="agent-args"]', '--e2e-flag "two words"');
    await setInputValue('[data-testid="resume-session"]', "e2e-session-1");
    await browser.waitUntil(async () =>
      (await sub("agent")) === "FakeAgent, asks first, extra args, resumes a session",
    { timeoutMsg: "the Agent rail entry did not list the session" });
    // The override wins outright at spawn, so with one set the session is
    // not used: its field disables, says why, and the rail stops claiming it.
    await setInputValue('[data-testid="resume-override"]', "--e2e-resume {BRANCH}");
    await browser.waitUntil(async () =>
      (await sub("agent")) === "FakeAgent, asks first, extra args, custom resume args",
    { timeoutMsg: "the rail still claimed the session beside an override" });
    expect(await browser.execute(() =>
      (document.querySelector('[data-testid="resume-session"]') as HTMLInputElement).disabled)).toBe(true);
    expect(await textOf('[data-testid="new-task-pane-agent"]'))
      .toContain("Not used: the resume args override below replaces it.");
    await settledSnap("new-task-c-agent.png");
    // A terminal has none of them, and the rail stops listing them.
    await clickDialogButton("Terminal");
    await browser.waitUntil(async () => (await sub("agent")) === "Terminal", { timeoutMsg: "a terminal still listed agent options" });
    expect(await browser.execute(() => !!document.querySelector('[data-testid="agent-args"]'))).toBe(false);
    await clickDialogButton("FakeAgent");

    await newTaskSection("task");
    const name = `e2e-launch-${Date.now()}`;
    await typeName(name);
    await clickWhenVisible('[data-testid="new-task-create"]');
    const task = await browser.waitUntil(
      () => browser.execute((n) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.name === n && !t.archived) ?? false, name),
      { timeout: 15_000, timeoutMsg: "the task was not created" },
    ) as any;
    created.push(task.id);
    expect({ args: task.agent_args, session: task.agent_session_ids?.fakeagent, resume: task.resume_override })
      .toEqual({ args: ["--e2e-flag", "two words"], session: undefined, resume: "--e2e-resume {BRANCH}" });
    // ...and the first spawn carries the args, one word for the quoted value.
    const argv = await firstSpawnArgv(task.id);
    expect(argv).toContain("--e2e-flag");
    expect(argv).toContain("two words");
  });

  it("seeds a resume session on its own, and its first spawn resumes it", async () => {
    await open();
    await clickDialogButton("Main checkout");
    await clickDialogButton("FakeAgent");
    await newTaskSection("agent");
    await setInputValue('[data-testid="resume-session"]', "e2e-session-2");
    await newTaskSection("task");
    const name = `e2e-session-${Date.now()}`;
    await typeName(name);
    await clickWhenVisible('[data-testid="new-task-create"]');
    const task = await browser.waitUntil(
      () => browser.execute((n) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.name === n && !t.archived) ?? false, name),
      { timeout: 15_000, timeoutMsg: "the task was not created" },
    ) as any;
    created.push(task.id);
    expect(task.agent_session_ids?.fakeagent).toBe("e2e-session-2");
    expect(await firstSpawnArgv(task.id)).toContain("e2e-session-2");
  });

  it("shows which sandbox preset is in effect, and hides the presets in Enforcing (FS)", async () => {
    await open();
    await newTaskSection("isolation");
    if (!(await optionEnabled("enforce"))) { await close(); return; }
    await clickWhenVisible('[role="dialog"] [data-sandbox-option="enforce"]');
    await waitVisible('[data-testid="sandbox-presets"]');
    const pressed = () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="sandbox-presets"] [data-preset]')]
        .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-preset")));
    const hosts = () => browser.execute(() =>
      (document.querySelector('[data-testid="sandbox-allowed-hosts"]') as HTMLTextAreaElement).value);
    await clickWhenVisible('[data-testid="sandbox-presets"] [data-preset="standard"]');
    expect(await pressed()).toEqual(["standard"]);
    await clickWhenVisible('[data-testid="sandbox-presets"] [data-preset="permissive"]');
    expect(await pressed()).toEqual(["permissive"]);
    expect(await hosts()).toContain("quay.io");
    // A hand edit matches neither.
    await browser.execute(() => {
      const ta = document.querySelector('[data-testid="sandbox-allowed-hosts"]') as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, ta.value + "\nacme.com");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await pressed()).toEqual([]);
    await clickWhenVisible('[data-testid="sandbox-presets"] [data-preset="standard"]');
    expect(await hosts()).toBe("");
    // Enforcing (FS) has no host list, and the presets differ only in hosts.
    await clickWhenVisible('[role="dialog"] [data-sandbox-option="enforce-fs"]');
    await waitGone('[data-testid="sandbox-presets"]');
    await clickWhenVisible('[role="dialog"] [data-sandbox-option="off"]');
    await close();
  });
});

// Default YOLO for new tasks (Settings → Sandbox, overridable per project).
//
// A default must never be a silent auto-approve on an uncaged task, so all it
// does is SEED the New Task dialog's checkbox, which the user reads before
// Create. Driven through the real dialog, and checked where it shows: the
// checkbox, the red ⚡ on the new row, and the FIRST spawn's argv. That last
// one is the point of setting it at create: a flag set after the tab mounts
// only reaches the agent through a restart.
describe("YOLO default for new tasks", () => {
  const NAME_INPUT = 'input[placeholder="fix login bug"]';
  const created: string[] = [];
  let projectId!: string;
  let saved: { pref: boolean; project: boolean | null } | null = null;

  const setAppDefault = (on: boolean) =>
    browser.execute((v) => window.__termic!.usePrefs.getState().setDefaultYolo(v), on);

  /** Set the project's own answer through the same IPC Settings uses. */
  const setProjectDefault = (v: boolean | null) =>
    browser.execute(async (pid, val) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.id === pid);
      await t.ipc.projectUpdate({ ...p, default_yolo: val });
      await t.useApp.getState().loadAll();
    }, projectId, v);

  /** Open the dialog on Main checkout with FakeAgent picked, so every case
   *  starts from the same shape whatever the last one left remembered. */
  const openDialog = async () => {
    await browser.execute((pid) => window.__termic!.useUI.getState().openNewTask(pid), projectId);
    await waitVisible(`[role="dialog"] ${NAME_INPUT}`, 8_000);
    await clickDialogButton("Main checkout");
    await clickDialogButton("FakeAgent");
  };

  const closeDialog = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    await waitGone(`[role="dialog"] ${NAME_INPUT}`);
  };

  /** What the dialog's YOLO control shows, or null when it is not rendered. */
  const yoloControl = () =>
    browser.execute((sel) => {
      const dlg = document.querySelector(sel)?.closest('[role="dialog"]');
      const el = dlg?.querySelector('[data-testid="new-task-yolo"]');
      if (!el) return null;
      const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
      return { state: el.getAttribute("data-yolo-state"), checked: box.checked, disabled: box.disabled };
    }, NAME_INPUT);

  const clickYolo = () =>
    browser.execute((sel) => {
      const dlg = document.querySelector(sel)?.closest('[role="dialog"]');
      (dlg?.querySelector('[data-testid="new-task-yolo"] input') as HTMLElement).click();
    }, NAME_INPUT);

  /** Pick a sandbox mode in the dialog's picker, by its option id. */
  const pickSandbox = (mode: string) =>
    browser.execute((sel, m) => {
      const dlg = document.querySelector(sel)?.closest('[role="dialog"]');
      (dlg?.querySelector(`[data-sandbox-option="${m}"]`) as HTMLElement).click();
    }, NAME_INPUT, mode);

  /** Name the task, Create, and return the created task once it lands. */
  const createNamed = async (name: string) => {
    await browser.execute((sel, n) => {
      const input = document.querySelector(`[role="dialog"] ${sel}`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
        .set!.call(input, n);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, NAME_INPUT, name);
    await clickDialogButton("Create");
    await browser.waitUntil(
      () => browser.execute((n) =>
        window.__termic!.useApp.getState().tasks.some((t: any) => t.name === n && !t.archived), name),
      { timeout: 15_000, timeoutMsg: `the dialog did not create ${name}` },
    );
    const task = await browser.execute((n) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.name === n && !t.archived), name) as any;
    created.push(task.id);
    return task;
  };

  /** The red ⚡ on the task's sidebar row: YOLO without a cage. */
  const rowBadge = (id: string) =>
    browser.execute((i) =>
      !!document.querySelector(`[data-sidebar-task-row="${i}"] [data-testid="task-yolo-badge"]`), id);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    const info = await browser.execute(() => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.name === "fixture-repo");
      return { id: p.id as string, project: (p.default_yolo ?? null) as boolean | null,
        pref: !!t.usePrefs.getState().defaultYolo };
    });
    projectId = info.id;
    saved = { pref: info.pref, project: info.project };
    await setAppDefault(false);
    await setProjectDefault(null);
  });

  after(async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask()).catch(() => {});
    for (const id of created) await archiveTask(id).catch(() => {});
    if (saved) {
      await setAppDefault(saved.pref);
      await setProjectDefault(saved.project);
    }
  });

  it("leaves YOLO unticked, and the agent asking, when nothing sets a default", async () => {
    await openDialog();
    expect(await yoloControl()).toEqual({ state: "off", checked: false, disabled: false });
    const task = await createNamed(`e2e-yolo-off-${Date.now()}`);
    expect(task.yolo).toBe(false);
    expect(await firstSpawnArgv(task.id)).not.toContain("--dangerously-skip-permissions");
    expect(await rowBadge(task.id)).toBe(false);
  });

  it("starts ticked from the app-wide default, and the FIRST spawn already skips prompts", async () => {
    await setAppDefault(true);
    await openDialog();
    await snap("new-task-yolo-default-on.png");
    expect(await yoloControl()).toEqual({ state: "on", checked: true, disabled: false });
    const task = await createNamed(`e2e-yolo-on-${Date.now()}`);
    expect(task.yolo).toBe(true);
    // No restart involved: the flag is on the command line of spawn #1.
    expect(await firstSpawnArgv(task.id)).toContain("--dangerously-skip-permissions");
    await browser.waitUntil(() => rowBadge(task.id), {
      timeout: 5_000, timeoutMsg: "no red YOLO badge on the new task's row",
    });

    // ...and it goes away once nothing is running. YOLO is a statement about
    // what an agent may do to your machine right now, so on a task with no
    // live agent the mark described a setting rather than a risk. It used to
    // render dimmed, which reads as a live warning turned down rather than as
    // "not running".
    // Expression body, like every other `execute` in this file: wdio's
    // overloads resolve a BLOCK body to the (elem: HTMLElement) signature,
    // which types the argument as an element rather than the id.
    const killed = await browser.execute(
      (i: string) => (window.__termic!.useApp.getState().tabs[i] ?? [])
        .filter((t: any) => t.type === "terminal" && !!t.ptyId)
        .map((t: any) => (void window.__termic!.ipc.ptyKill(t.ptyId), 1)).length,
      task.id as string,
    );
    expect(killed).toBeGreaterThan(0);
    await browser.waitUntil(async () => !(await rowBadge(task.id)), {
      timeout: 10_000,
      timeoutMsg: "the YOLO badge outlived the agent it was warning about",
    });
  });

  it("lets the user untick the default for one task", async () => {
    await setAppDefault(true);
    await openDialog();
    await clickYolo();
    expect(await yoloControl()).toEqual({ state: "off", checked: false, disabled: false });
    const task = await createNamed(`e2e-yolo-unticked-${Date.now()}`);
    expect(task.yolo).toBe(false);
    expect(await firstSpawnArgv(task.id)).not.toContain("--dangerously-skip-permissions");
  });

  it("lets the project's own Off beat the app-wide On", async () => {
    await setAppDefault(true);
    await setProjectDefault(false);
    await openDialog();
    expect(await yoloControl()).toEqual({ state: "off", checked: false, disabled: false });
    await closeDialog();
    // ...and the project's On beats the app-wide Off.
    await setAppDefault(false);
    await setProjectDefault(true);
    await openDialog();
    expect((await yoloControl())?.state).toBe("on");
    await closeDialog();
    await setProjectDefault(null);
  });

  // The Seatbelt cards are macOS only.
  (process.platform === "darwin" ? it : it.skip)("reads auto-on and cannot be unticked while the sandbox cages the task", async () => {
    await setAppDefault(false);
    await openDialog();
    await pickSandbox("enforce");
    await browser.waitUntil(async () => (await yoloControl())?.state === "auto", {
      timeout: 5_000, timeoutMsg: "the YOLO control never switched to auto under Enforcing",
    });
    expect(await yoloControl()).toEqual({ state: "auto", checked: true, disabled: true });
    // Monitoring blocks nothing, so it is not a cage: the choice is live again.
    await pickSandbox("monitor");
    await browser.waitUntil(async () => (await yoloControl())?.state === "off", {
      timeout: 5_000, timeoutMsg: "the YOLO control stayed on auto under Monitoring",
    });
    await pickSandbox("off");
    await closeDialog();
  });

  it("hides for a task whose default tab is not an agent", async () => {
    await setAppDefault(true);
    await openDialog();
    expect(await yoloControl()).not.toBeNull();
    await clickDialogButton("Terminal");
    await browser.waitUntil(async () => (await yoloControl()) === null, {
      timeout: 5_000, timeoutMsg: "the YOLO control is still up for a Terminal task",
    });
    await closeDialog();
  });

  it("seeds the Race dialog's YOLO from the same default", async () => {
    const raceYolo = () =>
      browser.execute(() => {
        const box = document.querySelector('[data-testid="race-yolo"] input') as HTMLInputElement | null;
        return box ? box.checked : null;
      });
    const openRace = async () => {
      await browser.execute((pid) => window.__termic!.useUI.getState().openRace(pid), projectId);
      await browser.waitUntil(async () => (await raceYolo()) !== null, {
        timeout: 8_000, timeoutMsg: "race dialog never appeared",
      });
    };
    const closeRace = () => browser.execute(() => window.__termic!.useUI.getState().closeRace());

    await setAppDefault(true);
    await openRace();
    expect(await raceYolo()).toBe(true);
    await closeRace();
    await setAppDefault(false);
    await openRace();
    expect(await raceYolo()).toBe(false);
    await closeRace();
  });
});

// The single most important flow in termic: create a task in a project and
// have the agent's terminal come alive. One green run proves project/task IO,
// git-worktree/checkout setup, the Rust PTY spawn, and tab/store wiring.
// Uses `fakeagent` (a claude-like fixture CLI, zero tokens).
describe("task spawn", () => {
  let taskId!: string;

  // Keep the profile clean across repeated runs: archive the task we created
  // (kills its PTY, moves it off the active board). Repo-root task, so archive
  // never removes a worktree.
  after(async () => {
    if (!taskId) return;
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskArchive(id);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);
  });

  it("spawns a task and the agent PTY comes alive", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Create the task through the app's own IPC (fast + robust vs. clicking
    // the create wizard). Repo-root task: no worktree, safe to archive later.
    taskId = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "e2e-spawn");
      await t.useApp.getState().loadAll();
      t.useApp.getState().setActiveTask(task.id);
      return task.id as string;
    });
    expect(typeof taskId).toBe("string");

    // The PTY spawns once the task view mounts. Poll the store, don't sleep.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tabs = window.__termic!.useApp.getState().tabs[id] ?? [];
          return tabs.length > 0 && !!tabs[0].ptyId;
        }, taskId),
      { timeout: 20_000, interval: 250, timeoutMsg: "agent PTY never spawned" },
    );

    // Round-trip: write to the PTY and assert new output lands. Terminal
    // content is a WebGL canvas (never in the DOM), so assert via the store's
    // lastOutputAt, not innerText.
    const before = await browser.execute(
      (id) => window.__termic!.useApp.getState().tabs[id][0].lastOutputAt ?? 0,
      taskId,
    );
    await browser.execute(async (id) => {
      const t = window.__termic!;
      const tab = t.useApp.getState().tabs[id][0];
      await t.ipc.ptyWrite(
        tab.ptyId,
        Array.from(new TextEncoder().encode("ping\r")),
      );
    }, taskId);
    await browser.waitUntil(
      () =>
        browser.execute(
          (a) =>
            (window.__termic!.useApp.getState().tabs[a.id][0].lastOutputAt ??
              0) !== a.before,
          { id: taskId, before },
        ),
      { timeout: 10_000, timeoutMsg: "no PTY output after write" },
    );

    // The claude-like fixture drives the OSC terminal title (✳ when idle, a
    // spinner while working); termic ingests it as the tab's liveTitle. This
    // proves the fake agent's title behavior reaches the app end to end.
    // (We assert liveTitle rather than workState because termic gates the
    // working indicator on a real submit through its input path, which a raw
    // ptyWrite intentionally bypasses — that heuristic gets its own test.)
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const tab = window.__termic!.useApp.getState().tabs[id][0];
          return !!tab.liveTitle && tab.liveTitle.includes("e2e-spawn");
        }, taskId),
      {
        timeout: 10_000,
        timeoutMsg: "agent OSC title (liveTitle) never reached the app",
      },
    );

    // The SAME titles must land in the signal-log buffer that Settings →
    // Agents reads. Everything else about the inspector is exercised against
    // the buffer directly; this is the one case that proves the hot-path
    // wiring in TerminalPane's onTitleChange, i.e. that the feature works on a
    // real agent and not just on a module called from a test.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const obs = window.__termic!.signalLog.observationsFor("fakeagent");
          return obs.some((o: any) => o.title.includes("e2e-spawn") && o.seen > 0);
        }),
      {
        timeout: 10_000,
        timeoutMsg: "agent OSC title never reached the signal-log buffer",
      },
    );
    // And it is retained as a frequency table, not one row per repaint: the
    // fixture repaints its spinner continuously, so an append-per-frame buffer
    // would blow past the 60-entry cap within seconds.
    const rows = await browser.execute(
      () => window.__termic!.signalLog.observationsFor("fakeagent").length,
    );
    expect(rows).toBeLessThanOrEqual(60);

    await snap("task-spawn.png");
  });
});

// The task lifecycle's other half: archiving. Guards the archive path (which
// on a real worktree task removes the checkout) and the store transition that
// moves a task out of the active board and into History.
describe("task archive", () => {
  it("archives a task and removes it from the active list", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // A repo-root task (task_open_repo): archiving it never rm -rf's a
    // worktree, so this fixture is safe to create and destroy repeatedly.
    const taskId = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "e2e-archive");
      await t.useApp.getState().loadAll();
      return task.id as string;
    });

    // Precondition: it exists and is active (not archived).
    const activeBefore = await browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.some((t: any) => t.id === id && !t.archived),
      taskId,
    );
    expect(activeBefore).toBe(true);

    // Archive it (deleteBranch defaults off).
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskArchive(id);
      await t.useApp.getState().loadAll();
    }, taskId);

    // It is now archived and gone from the active set.
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const task = window.__termic!.useApp
            .getState()
            .tasks.find((t: any) => t.id === id);
          return !!task && task.archived === true;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "task never became archived" },
    );
    const stillActive = await browser.execute(
      (id) =>
        window.__termic!.useApp
          .getState()
          .tasks.some((t: any) => t.id === id && !t.archived),
      taskId,
    );
    expect(stillActive).toBe(false);

    await snap("task-archive.png");
  });
});

// P0: the archive confirmation's "Show this every time" opt-out (issue #102 -
// ticked by default, unticking is what opts out). All three halves are pinned
// here: backing out must NOT store the opt-out, confirming with it unticked
// must store BOTH it and the delete-branch answer, and a later archive must
// then run silently with that stored branch answer.
describe("archive confirmation", () => {
  const ARCHIVE_REPO = path.join(process.cwd(), ".e2e", "fixture-repo");
  // Deliberately NOT the task names below: the dialog title is
  // `Archive "<task name>"?`, so a branch named after its task would satisfy
  // the "names the branch" assertion even if the branch code block never
  // rendered at all.
  const BRANCH_A = "wt-ask-alpha";
  const BRANCH_B = "wt-silent-beta";
  let prefsOriginal: { confirm: boolean; deleteBranch: boolean } | undefined;
  // The first case creates it and backs out of archiving it; the second one
  // then archives that same task for real.
  let askTaskId = "";

  /** Create a worktree task on `branch` and make it the active one, so the
   *  unified bar's archive button acts on it. A worktree task (not a repo-root
   *  entry) is what puts the delete-branch checkbox in the dialog. */
  const createWorktreeTask = async (name: string, branch: string) => {
    const id = await browser.execute(async (n, b) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskCreate({
        project_id: proj.id, name: n, cli: "fakeagent", base_branch: "main", branch: b,
      });
      await t.useApp.getState().loadAll();
      return (task as any).id as string;
    }, name, branch);
    // Not setActiveTask: the caller's next move is to click a button in the
    // chrome, and that button closes over whatever task React last RENDERED.
    await ensureActiveTask(id);
    return id;
  };

  /** The archive dialog, found by its title. Never a bare [role="dialog"]:
   *  a closing dialog from an earlier case can still be in the DOM. */
  const dialogText = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"]')]
        .find((d) => d.textContent?.includes("Archive \""))?.textContent ?? "");

  /** Click a control inside the archive dialog by testid. */
  const clickInDialog = (testid: string) =>
    browser.execute((id) => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')]
        .find((d) => d.textContent?.includes("Archive \""));
      if (!dlg) throw new Error("archive dialog not open");
      const el = dlg.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      if (!el) throw new Error(`no ${id} in the archive dialog`);
      el.click();
    }, testid);

  const waitForArchiveDialog = () =>
    browser.waitUntil(async () => (await dialogText()).includes("Archive \""), {
      timeout: 10_000, timeoutMsg: "archive dialog never opened",
    });

  const archivePrefs = () =>
    browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { confirm: p.confirmBeforeArchiveTask, deleteBranch: p.archiveDeleteBranch };
    });

  const isArchived = (id: string) =>
    browser.execute((i) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.archived === true, id);

  const branchExists = (branch: string) => {
    try {
      execSync(`git -C "${ARCHIVE_REPO}" rev-parse --verify refs/heads/${branch}`, { stdio: "ignore" });
      return true;
    } catch { return false; }
  };

  /** Drop this describe's two branches and any worktree still registered for
   *  them. Runs BEFORE as well as after: an interrupted run leaves the branch
   *  behind, and `task_create` then fails on a name it cannot reuse. */
  const dropBranches = () => {
    try { execSync(`git -C "${ARCHIVE_REPO}" worktree prune`); } catch { /* nothing to prune */ }
    for (const b of [BRANCH_A, BRANCH_B]) {
      try { execSync(`git -C "${ARCHIVE_REPO}" branch -D ${b}`, { stdio: "ignore" }); } catch { /* already gone */ }
    }
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    prefsOriginal = await archivePrefs();
    dropBranches();
  });

  after(async () => {
    // Prefs persist to the shared profile — a leaked opt-out would make every
    // later archive in the run skip its dialog.
    if (prefsOriginal) {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setConfirmBeforeArchiveTask(o.confirm);
        p.setArchiveDeleteBranch(o.deleteBranch);
      }, prefsOriginal);
    }
    dropBranches();
  });

  it("keeps asking when the user unticks the box but then cancels", async () => {
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setConfirmBeforeArchiveTask(true);
      p.setArchiveDeleteBranch(false);
    });
    askTaskId = await createWorktreeTask("e2e-archive-ask", BRANCH_A);
    expect(branchExists(BRANCH_A)).toBe(true);

    await clickWhenVisible('[data-testid="archive-task"]');
    await waitForArchiveDialog();
    // The worktree variant offers the branch by name, so the user can see
    // exactly what "Delete the git branch" would remove.
    expect(await dialogText()).toContain(BRANCH_A);

    // Unticking "Show this every time" is the opt-out; the branch box is the
    // separate delete-the-branch answer.
    await clickInDialog("confirm-show-every-time");
    await clickInDialog("confirm-checkbox");
    await clickInDialog("confirm-cancel");

    // Nothing was archived, and nothing was remembered: the dialog reports the
    // checkbox state at dismissal, so a cancelled archive must not store it.
    expect(await isArchived(askTaskId)).toBe(false);
    expect(await archivePrefs()).toEqual({ confirm: true, deleteBranch: false });
    await snap("archive-confirm-cancelled.png");
  });

  it("stores the opt-out and the branch answer when the archive goes through", async () => {
    await ensureActiveTask(askTaskId);

    await clickWhenVisible('[data-testid="archive-task"]');
    await waitForArchiveDialog();
    await clickInDialog("confirm-show-every-time");
    await clickInDialog("confirm-checkbox");
    await clickInDialog("confirm-ok");

    await browser.waitUntil(() => isArchived(askTaskId), {
      timeout: 15_000, timeoutMsg: "task never became archived",
    });
    expect(await archivePrefs()).toEqual({ confirm: false, deleteBranch: true });
    expect(branchExists(BRANCH_A)).toBe(false);
  });

  it("archives with no dialog afterwards, honouring the stored branch answer", async () => {
    const taskId = await createWorktreeTask("e2e-archive-silent", BRANCH_B);
    expect(branchExists(BRANCH_B)).toBe(true);

    await clickWhenVisible('[data-testid="archive-task"]');

    await browser.waitUntil(() => isArchived(taskId), {
      timeout: 15_000, timeoutMsg: "silent archive never landed",
    });
    // No confirmation was ever shown, and the branch went with it because
    // that is what the user answered when they unticked "Show this every
    // time".
    expect(await dialogText()).toBe("");
    expect(branchExists(BRANCH_B)).toBe(false);
    // With no dialog, the toast is the only feedback and the only pointer to
    // where the task went (issue #102). Assert the rendered toast, not the
    // store: the [role="status"] node is the part the user actually reads.
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll('[role="status"]')].some((t) =>
            (t as HTMLElement).innerText.includes("History"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: "a silent archive showed no toast pointing at History" },
    );
    await snap("archive-silent.png");
  });
});

// P0: archiving must not lock the window (GH #246). It used to raise the same
// full-screen `fixed inset-0` click-blocker `ui.setBusy` puts up for anything
// else, and hold it for the whole archive: the project's archive script, then
// `git worktree remove`, then an `fs::remove_dir_all` over node_modules. Every
// other task's agent kept working behind it, unreachable. Two halves are
// pinned here: a real archive never raises the overlay, and while one is in
// flight the task's own sidebar row is what says so.
describe("non-blocking archive (GH #246)", () => {
  const ARCHIVE_REPO = path.join(process.cwd(), ".e2e", "fixture-repo");
  const BRANCH = "wt-nonblocking-archive";
  let prefsOriginal: { confirm: boolean; deleteBranch: boolean } | undefined;
  let taskId = "";

  const createWorktreeTask = async (name: string, branch: string) => {
    const id = await browser.execute(async (n, b) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskCreate({
        project_id: proj.id, name: n, cli: "fakeagent", base_branch: "main", branch: b,
      });
      await t.useApp.getState().loadAll();
      return (task as any).id as string;
    }, name, branch);
    // Not setActiveTask: the caller's next move is to click a button in the
    // chrome, and that button closes over whatever task React last RENDERED.
    await ensureActiveTask(id);
    return id;
  };

  const isArchived = (id: string) =>
    browser.execute((i) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.archived === true, id);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    prefsOriginal = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      return { confirm: p.confirmBeforeArchiveTask, deleteBranch: p.archiveDeleteBranch };
    });
  });

  after(async () => {
    if (prefsOriginal) {
      await browser.execute((o) => {
        const p = window.__termic!.usePrefs.getState();
        p.setConfirmBeforeArchiveTask(o.confirm);
        p.setArchiveDeleteBranch(o.deleteBranch);
      }, prefsOriginal);
    }
    // Never leave a seeded archiving flag behind: it would render every later
    // spec's row for that task inert.
    await browser.execute(() => {
      const a = window.__termic!.useArchivingTasks.getState();
      for (const id of Object.keys(a.ids)) a.end(id);
    });
    try { execSync(`git -C "${ARCHIVE_REPO}" worktree prune`); } catch { /* nothing to prune */ }
    try { execSync(`git -C "${ARCHIVE_REPO}" branch -D ${BRANCH}`, { stdio: "ignore" }); } catch { /* already gone */ }
  });

  it("confirming closes the dialog and never raises the full-window overlay", async () => {
    await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      p.setConfirmBeforeArchiveTask(true);
      p.setArchiveDeleteBranch(true);
    });
    taskId = await createWorktreeTask("e2e-archive-nonblocking", BRANCH);

    await clickWhenVisible('[data-testid="archive-task"]');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          [...document.querySelectorAll('[role="dialog"]')]
            .some((d) => d.textContent?.includes("Archive \"")))),
      { timeout: 10_000, timeoutMsg: "archive dialog never opened" },
    );
    await browser.execute(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')]
        .find((d) => d.textContent?.includes("Archive \""));
      (dlg!.querySelector('[data-testid="confirm-ok"]') as HTMLElement).click();
    });

    // Poll to completion, checking the overlay on EVERY sample rather than
    // once at the end: the old code held it up from the confirm click until
    // `task_archive` + `loadAll` had both returned, which is well over one
    // sampling interval even on this fixture.
    let sawOverlay = false;
    await browser.waitUntil(
      async () => {
        if (await browser.execute(() => !!document.querySelector('[data-testid="busy-overlay"]'))) {
          sawOverlay = true;
        }
        return await isArchived(taskId);
      },
      { interval: 50, timeout: 20_000, timeoutMsg: "task never became archived" },
    );
    expect(sawOverlay).toBe(false);
    // The store agrees, in case the overlay ever gains an exit animation that
    // makes the DOM check lag its state.
    expect(await browser.execute(() => window.__termic!.useUI.getState().busyMessage)).toBe(null);

    // The task's own row is what went away; the rest of the sidebar (the other
    // projects and their tasks) is still there and still clickable.
    await browser.waitUntil(
      () => browser.execute((id) => !document.querySelector(`[data-sidebar-task-id="${id}"]`), taskId),
      { timeout: 10_000, timeoutMsg: "the archived task's sidebar row never went away" },
    );
  });

  it("shows an inert Archiving row while the archive runs", async () => {
    // Seeded rather than raced: the fixture's worktree has no node_modules, so
    // a real archive finishes in the time it takes to look for the row. What
    // is being pinned is the row a slow archive leaves on screen.
    const other = await createWorktreeTask("e2e-archiving-row", "wt-archiving-row");
    await browser.execute((id) => {
      window.__termic!.useArchivingTasks.getState().begin(id);
    }, other);

    const row = `[data-sidebar-task-id="${other}"]`;
    await waitVisible(`${row}[data-task-archiving="true"]`);
    await waitVisible('[data-testid="archiving-badge"]');

    // Inert: clicking it does not select the task that is being torn down.
    await browser.execute(() => {
      window.__termic!.useApp.getState().setActiveTask(null);
    });
    await browser.execute((sel) => {
      (document.querySelector(sel) as HTMLElement).click();
    }, row);
    expect(await browser.execute(() => window.__termic!.useApp.getState().activeTaskId)).toBe(null);
    await snap("archiving-row.png");

    // Clearing the flag hands the row back to the normal TaskRow, kebab and
    // all — the archiving state is a render mode, not a one-way door.
    await browser.execute((id) => {
      window.__termic!.useArchivingTasks.getState().end(id);
    }, other);
    await browser.waitUntil(
      () => browser.execute((sel) =>
        !!document.querySelector(sel) && !document.querySelector(`${sel}[data-task-archiving="true"]`), row),
      { timeout: 5_000, timeoutMsg: "the row never came back as a normal task row" },
    );

    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskArchive(id, true); // deleteBranch
      await window.__termic!.useApp.getState().loadAll();
    }, other);
    try { execSync(`git -C "${ARCHIVE_REPO}" worktree prune`); } catch { /* nothing to prune */ }
  });

  it("does not announce the exit of an agent the archive itself stopped", async () => {
    // Archive stops the task's agents before it removes the worktree, and a
    // stopped agent is a PTY exit like any other: the terminal marked the tab
    // unread with reason "exit", and the notifier turned that into an
    // "agent exited" banner about a task the user had just archived. Reported
    // on Windows, where the stop is a Ctrl+C and a grace period, so the exit
    // lands while the task is still in the store.
    //
    // Counted on the unread mark for the same reason "one turn raises one
    // notification" (agent.e2e.ts) counts edges: the e2e binary never reaches
    // the OS banner, and the mark is the last decision before it.
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setConfirmBeforeArchiveTask(false);
    });
    const id = await createWorktreeTask("e2e-archive-quiet", "wt-archive-quiet");
    await waitForAgentReady(id);
    await browser.execute((taskId) => {
      const w = window as unknown as { __exitMarks?: number; __exitStop?: () => void };
      w.__exitMarks = 0;
      const marked = new Set<string>();
      w.__exitStop = window.__termic!.useApp.subscribe((s: { tabs: Record<string, Array<{ id: string; unread?: { reason?: string } | null }>> }) => {
        for (const tab of s.tabs[taskId] ?? []) {
          if (tab.unread?.reason === "exit" && !marked.has(tab.id)) {
            marked.add(tab.id);
            w.__exitMarks = (w.__exitMarks ?? 0) + 1;
          }
        }
      });
    }, id);

    // The real button, so the archive goes through the flow a user's does.
    await clickWhenVisible('[data-testid="archive-task"]');
    await browser.waitUntil(() => isArchived(id), { timeout: 20_000, timeoutMsg: "task never became archived" });
    // The archive has returned, so the agent is long stopped. What can still
    // be in flight is its exit event; the archiving flag is cleared in the
    // same settle, so wait for that rather than for a fixed time.
    await browser.waitUntil(
      () => browser.execute((taskId) => !window.__termic!.useArchivingTasks.getState().ids[taskId], id),
      { timeout: 10_000, timeoutMsg: "the archive never settled" },
    );
    const marks = await browser.execute(() => {
      const w = window as unknown as { __exitMarks?: number; __exitStop?: () => void };
      w.__exitStop?.();
      w.__exitStop = undefined;
      return w.__exitMarks ?? 0;
    });
    expect(marks).toBe(0);
    try { execSync(`git -C "${ARCHIVE_REPO}" worktree prune`); } catch { /* nothing to prune */ }
    try { execSync(`git -C "${ARCHIVE_REPO}" branch -D wt-archive-quiet`, { stdio: "ignore" }); } catch { /* already gone */ }
  });
});

// P1: emptying the archive from History. It's the one destructive bulk action
// in the app, so both halves matter: the confirmation must be able to say no,
// and saying yes must actually wipe the records (not just unlist them).
describe("empty archive", () => {
  const clickEmpty = () =>
    browser.execute(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Empty archive"),
      ) as HTMLElement | undefined;
      if (!btn) throw new Error("no Empty archive button");
      btn.click();
    });
  const archivedCount = () =>
    browser.execute(
      () => window.__termic!.useApp.getState().tasks.filter((t: any) => t.archived).length,
    );

  it("cancelling the confirmation keeps every archived task", async () => {
    await waitForAppShell();
    await requireTermicApi();

    const id = await openTask("e2e-empty-keep", false);
    await archiveTask(id);
    await clickByText("History");
    await waitForText("e2e-empty-keep");
    const before = (await archivedCount()) as number;
    expect(before).toBeGreaterThan(0);

    await clickEmpty();
    // The dialog names the real count, so it can't disagree with what it deletes.
    await waitForText("Empty the archive?");
    await waitForText(`${before} archived`);
    await clickByText("Cancel");
    await waitForTextGone("Empty the archive?");
    expect(await archivedCount()).toBe(before);
  });

  it("confirming deletes every archived task for good", async () => {
    // A second one, so this covers a bulk delete rather than a single row.
    const id = await openTask("e2e-empty-go", false);
    await archiveTask(id);
    await clickByText("History");
    await waitForText("e2e-empty-go");

    await clickEmpty();
    await waitForText("Empty the archive?");
    await clickByText("Delete all");

    // Gone from the store, not merely hidden: a deleted task is removed
    // entirely, so nothing is left to restore.
    await browser.waitUntil(async () => (await archivedCount()) === 0, {
      timeout: 15_000,
      timeoutMsg: "archived tasks survived the empty",
    });
    await waitForText("No archived tasks.");
    await snap("empty-archive.png");
  });
});

// Completes the task lifecycle: archive -> it appears in History -> restore ->
// it's active again. Guards the History view's filtering and the restore path.
describe("task restore", () => {
  let taskId!: string;
  after(async () => {
    // Leave it archived (out of the active board) for the next run.
    if (taskId) await archiveTask(taskId);
  });

  it("restores an archived task from History", async () => {
    await waitForAppShell();
    await requireTermicApi();

    taskId = await openTask("e2e-restore", false);
    await archiveTask(taskId);

    // Navigate to History (real click) and confirm the task is listed there.
    await clickByText("History");
    await waitForText("e2e-restore");

    // Restore it. The hover-gated "Restore ->" button wraps exactly this call;
    // we invoke it directly so the assertion isn't at the mercy of a hover.
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRestore(id);
      await window.__termic!.useApp.getState().loadAll();
    }, taskId);

    // The task is active again (no longer archived).
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const task = window.__termic!.useApp
            .getState()
            .tasks.find((t: any) => t.id === id);
          return !!task && task.archived === false;
        }, taskId),
      { timeout: 10_000, timeoutMsg: "task was never restored to active" },
    );

    await snap("task-restore.png");
  });
});

// P1: task rename + permanent delete (distinct from archive). Cases: renaming
// updates the store and the sidebar; deleting removes the task entirely (not
// just archived).
describe("task lifecycle", () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const id of cleanup) {
      const exists = await browser.execute(
        (i) => window.__termic!.useApp.getState().tasks.some((t: any) => t.id === i),
        id,
      );
      if (exists) await archiveTask(id);
    }
  });

  it("renames a task (store + sidebar)", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const id = await openTask("e2e-life-rename");
    cleanup.push(id);

    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskRename(i, "renamed-task");
      await window.__termic!.useApp.getState().loadAll();
    }, id);

    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            window.__termic!.useApp
              .getState()
              .tasks.find((t: any) => t.id === i)?.name === "renamed-task",
          id,
        ),
      { timeout: 8_000, timeoutMsg: "task name never updated in the store" },
    );
    // The sidebar reflects the new name.
    await waitForText("renamed-task");
  });

  // GH #153: task_rename refuses a live same-project duplicate (two
  // same-name tasks make CLI name resolution ambiguous with no name-based
  // way out), and the sidebar's inline-rename commit surfaces that refusal
  // as a toast instead of silently snapping back.
  it("refuses a duplicate name at the IPC layer and toasts in the inline flow", async () => {
    const dupId = await openTask("e2e-life-dup", false);
    cleanup.push(dupId);

    // IPC layer: renaming onto "renamed-task" (live, same project) rejects.
    const err = await browser.execute(async (i) => {
      try {
        await window.__termic!.ipc.taskRename(i, "renamed-task");
        return null;
      } catch (e) {
        return String(e);
      }
    }, dupId);
    expect(err).toContain("already exists");
    const name = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.name,
      dupId,
    );
    expect(name).toBe("e2e-life-dup");

    // task_open_repo enforces the same rule: repo-root tasks have no
    // per-name directory to collide on, so without this a second "Open
    // repo" could mint the same-name twin rename just refused.
    const openErr = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      try {
        await t.ipc.taskOpenRepo(proj.id, "fakeagent", "renamed-task");
        return null;
      } catch (e) {
        return String(e);
      }
    });
    expect(openErr).toContain("already exists");

    // DERIVED names take the other fork: two unnamed opens both fall back
    // to the branch name, and the second is auto-bumped ("main-2") rather
    // than refused, so the quick Terminal twice stays possible.
    const [a, b] = await browser.execute(async () => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      const first = await t.ipc.taskOpenRepo(proj.id, "fakeagent", null);
      const second = await t.ipc.taskOpenRepo(proj.id, "fakeagent", null);
      await t.useApp.getState().loadAll();
      return [
        { id: first.id, name: first.name },
        { id: second.id, name: second.name },
      ];
    });
    cleanup.push(a.id, b.id);
    expect(b.name).not.toBe(a.name);
    expect(b.name).toMatch(/-\d+$/);

    // UI layer: drive the real inline-rename commit (the palette's
    // renameRequest mounts the input in the task's sidebar row), type the
    // duplicate, commit, and the refusal lands as a toast.
    await browser.execute((i) => {
      window.__termic!.useUI.setState({ renameRequest: { taskId: i, nonce: Date.now() } });
    }, dupId);
    const inputSel = `[data-sidebar-task-id="${dupId}"] input`;
    await waitVisible(inputSel);
    await browser.execute((sel) => {
      const input = document.querySelector<HTMLInputElement>(sel)!;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "renamed-task");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // Blur commits, same as Enter; a synthetic keydown would not carry
      // through React's onKeyDown -> commit path reliably.
      input.blur();
    }, inputSel);
    await waitForText("already exists");
    // The row keeps its old name once the input unmounts.
    const after = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.name,
      dupId,
    );
    expect(after).toBe("e2e-life-dup");
    await snap("task-rename-dup-toast.png");
  });

  // task_restore mirrors the duplicate rule (GH #153): restoring an
  // archived task whose name a live task has since taken would resurrect
  // two same-name tasks in one project, which CLI name resolution cannot
  // untangle. Renaming the live squatter away unblocks the restore.
  it("refuses to restore an archived task when a live one took its name", async () => {
    const archived = await openTask("e2e-life-restore-dup", false);
    await archiveTask(archived);
    const squatter = await openTask("e2e-life-squatter", false);
    cleanup.push(squatter);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskRename(i, "e2e-life-restore-dup");
      await window.__termic!.useApp.getState().loadAll();
    }, squatter);

    const err = await browser.execute(async (i) => {
      try {
        await window.__termic!.ipc.taskRestore(i);
        return null;
      } catch (e) {
        return String(e);
      }
    }, archived);
    expect(err).toContain("already exists");
    const stillArchived = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.archived,
      archived,
    );
    expect(stillArchived).toBe(true);

    // Rename the squatter back; the restore now goes through.
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskRename(i, "e2e-life-squatter");
      await window.__termic!.useApp.getState().loadAll();
    }, squatter);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskRestore(i);
      await window.__termic!.useApp.getState().loadAll();
    }, archived);
    cleanup.push(archived);
    const restored = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.archived,
      archived,
    );
    expect(restored).toBe(false);
  });

  it("deletes a task permanently", async () => {
    const id = await openTask("e2e-life-delete", false);
    await browser.execute(async (i) => {
      await window.__termic!.ipc.taskDelete(i);
      await window.__termic!.useApp.getState().loadAll();
    }, id);

    // Gone entirely — not present in the tasks list at all (archived or not).
    await browser.waitUntil(
      () =>
        browser.execute(
          (i) =>
            !window.__termic!.useApp
              .getState()
              .tasks.some((t: any) => t.id === i),
          id,
        ),
      { timeout: 8_000, timeoutMsg: "deleted task still present" },
    );
    await snap("task-lifecycle.png");
  });
});

// termic's core promise: many parallel agents, each in its own task, all
// alive at once. This guards that two tasks run independent PTYs, that a task
// stays alive when it's not the active one (panes are kept mounted), and that
// switching the active task works.
describe("multi-task isolation", () => {
  let a: string | undefined;
  let b: string | undefined;
  after(async () => {
    if (a) await archiveTask(a);
    if (b) await archiveTask(b);
  });

  const waitForPty = (id: string, label: string) =>
    browser.waitUntil(
      () =>
        browser.execute((i) => {
          const tabs = window.__termic!.useApp.getState().tabs[i] ?? [];
          return tabs.length > 0 && !!tabs[0].ptyId;
        }, id),
      { timeout: 20_000, interval: 250, timeoutMsg: `${label} PTY never spawned` },
    );
  const ptyOf = (id: string) =>
    browser.execute(
      (i) => window.__termic!.useApp.getState().tabs[i][0].ptyId as string,
      id,
    );
  const activeTask = () =>
    browser.execute(() => window.__termic!.useApp.getState().activeTaskId);

  it("runs two tasks with independent PTYs and switches between them", async () => {
    await waitForAppShell();
    await requireTermicApi();

    a = await openTask("e2e-multi-a"); // spawns + becomes active
    await waitForPty(a, "task A");
    const ptyA = await ptyOf(a);

    b = await openTask("e2e-multi-b"); // spawns + becomes active
    await waitForPty(b, "task B");
    expect(await activeTask()).toBe(b);

    // Both PTYs are alive and DISTINCT, and A survived going inactive
    // (termic keeps background task panes mounted).
    const ptyB = await ptyOf(b);
    const ptyAstill = await ptyOf(a);
    expect(ptyAstill).toBe(ptyA);
    expect(ptyB).not.toBe(ptyA);

    // Switch back to A (the store action a sidebar click triggers).
    await browser.execute(
      (id) => window.__termic!.useApp.getState().setActiveTask(id),
      a,
    );
    expect(await activeTask()).toBe(a);

    await snap("multi-task.png");
  });
});

// P2: creating a WORKTREE task (branch in its own working dir), vs the repo-root
// tasks the rest of the suite uses. Verifies it lands on its own branch, then
// archives it (removes the worktree) and prunes the branch.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const BRANCH = "e2e-wt-branch";

describe("worktree task", () => {
  let taskId!: string;
  // The derived-branch case below names no branch, so it cannot be cleaned up
  // by a constant: whatever Rust derived is what has to be deleted.
  let derivedId: string | undefined;
  let derivedBranchName: string | undefined;
  after(async () => {
    for (const id of [taskId, derivedId]) {
      if (!id) continue;
      await browser.execute(async (i) => {
        await window.__termic!.ipc.taskArchive(i, true); // deleteBranch
        await window.__termic!.useApp.getState().loadAll();
      }, id);
    }
    try {
      execSync(`git -C "${fixture}" worktree prune`);
      for (const b of [BRANCH, derivedBranchName]) {
        if (b) execSync(`git -C "${fixture}" branch -D ${b}`, { stdio: "ignore" });
      }
    } catch {
      /* already gone */
    }
  });

  it("creates a task on its own worktree branch", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const t = await browser.execute(async (branch) => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await window.__termic!.ipc.taskCreate({
        project_id: proj.id,
        name: "e2e-wt",
        cli: "fakeagent",
        base_branch: "main",
        branch,
      });
      await window.__termic!.useApp.getState().loadAll();
      return task;
    }, BRANCH);
    taskId = (t as any).id;

    // It's a worktree: on its own branch, not the main checkout.
    expect((t as any).branch).toBe(BRANCH);
    expect((t as any).is_main_checkout).not.toBe(true);
    await snap("worktree-task.png");
  });

  // Every other create in this suite hands `task_create` an explicit branch,
  // so the DERIVATION had no coverage at all: `slugify` in lib.rs is what
  // names the branch (and the worktree directory) when the caller names none,
  // and it mapped each character on its own. A perfectly ordinary task name
  // with a dash in it produced `e2e-wt---dash-rule`, on disk and in git.
  it("derives a branch from the name without ever doubling a dash", async () => {
    const t = await browser.execute(async () => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const task = await window.__termic!.ipc.taskCreate({
        project_id: proj.id,
        // A space, a typed dash and a space: three separate substitutions,
        // which is how the run of dashes used to appear.
        name: "e2e wt - dash rule",
        cli: "fakeagent",
        base_branch: "main",
        // No branch. This is the whole point of the case.
      });
      await window.__termic!.useApp.getState().loadAll();
      return task;
    });
    derivedId = (t as any).id;
    derivedBranchName = (t as any).branch;

    expect(derivedBranchName).toBe("e2e-wt-dash-rule");
    // Asserted separately from the equality: the rule is "no two dashes in a
    // row", and it has to hold for any name, not just this one.
    expect(derivedBranchName).not.toMatch(/--/);
    // git agrees the branch is really there under that name, and the worktree
    // directory took the same slug rather than a differently-dashed one.
    execSync(`git -C "${fixture}" rev-parse --verify refs/heads/${derivedBranchName}`, {
      stdio: "ignore",
    });
    expect(path.basename((t as any).path)).toBe("e2e-wt-dash-rule");
  });

  // The case above passes an explicit base ("main"). The PRIMARY path uses the
  // project default base, which is a remote-tracking ref ("origin/main"). On a
  // repo with no remote that ref doesn't exist, so before resolve_base_ref
  // (lib.rs) a plain New Task here died with "not a valid object name:
  // origin/main". Prove the default-base create now falls back to local main.
  describe("on a local-only repo (default base)", () => {
    const LBRANCH = "e2e-wt-local";
    let localId: string | undefined;

    before(() => {
      try {
        execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
      } catch {
        /* already remote-less */
      }
    });
    after(async () => {
      if (localId) {
        await browser.execute(async (id) => {
          await window.__termic!.ipc.taskArchive(id, true); // deleteBranch
          await window.__termic!.useApp.getState().loadAll();
        }, localId);
      }
      try {
        execSync(`git -C "${fixture}" worktree prune`);
        execSync(`git -C "${fixture}" branch -D ${LBRANCH}`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      // Restore the seeded origin so later specs see origin/main again.
      const seedOrigin = `${fixture}-origin.git`;
      try {
        execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
      } catch {
        /* none */
      }
      if (existsSync(seedOrigin)) {
        try {
          execSync(`git -C "${fixture}" remote add origin "${seedOrigin}"`, {
            stdio: "ignore",
          });
        } catch {
          /* already present */
        }
        execSync(`git -C "${fixture}" fetch -q origin`, { stdio: "ignore" });
      }
    });

    it("creates a task on the default base when there is no origin/main", async () => {
      await waitForAppShell();
      await requireTermicApi();

      // Precondition: origin/main genuinely does not resolve here.
      let originResolves = true;
      try {
        execSync(`git -C "${fixture}" rev-parse --verify -q origin/main`, {
          stdio: "ignore",
        });
      } catch {
        originResolves = false;
      }
      expect(originResolves).toBe(false);

      // Create WITHOUT an explicit base_branch → the Rust side uses the project
      // default (origin/main), which resolve_base_ref falls back to local main.
      const t = await browser.execute(async (branch) => {
        const proj = window.__termic!.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo");
        const task = await window.__termic!.ipc.taskCreate({
          project_id: proj.id,
          name: "e2e-wt-local",
          cli: "fakeagent",
          base_branch: null, // the default-base path that used to fail
          branch,
        });
        await window.__termic!.useApp.getState().loadAll();
        return task;
      }, LBRANCH);
      localId = (t as any).id;

      // It succeeded, on its own worktree branch, cut from local main.
      expect((t as any).branch).toBe(LBRANCH);
      expect((t as any).is_main_checkout).not.toBe(true);
      const mainSha = execSync(`git -C "${fixture}" rev-parse main`)
        .toString()
        .trim();
      const branchSha = execSync(`git -C "${fixture}" rev-parse ${LBRANCH}`)
        .toString()
        .trim();
      expect(branchSha).toBe(mainSha);
    });
  });
});

// Checking out an EXISTING branch (a colleague's, to review it) into its own
// worktree, through the real New Task dialog. The branches live on the
// fixture's origin and NOT locally, which is the case that used to go wrong:
// typed into the ordinary Branch name field, a remote-only name missed
// `rev-parse --verify` and came out as a fresh branch off main.
describe("check out an existing branch", () => {
  const origin = `${fixture}-origin.git`;
  // Pushed, then fetched: a remote-tracking ref with no local branch.
  const LISTED = "e2e-colleague/listed";
  // Pushed AFTER the fixture's last fetch: this repo has never heard of it.
  const UNFETCHED = "e2e-colleague/unfetched";
  const UNKNOWN = "e2e-colleague/nobody-pushed-this";
  const TYPED_NAME = "e2e-review-unfetched";
  const TITLE = "Check out an existing branch";
  let scratch: string | undefined;
  const sha: Record<string, string> = {};

  const git = (cwd: string, args: string) =>
    execSync(`git -C "${cwd}" -c user.name=e2e -c user.email=e2e@termic.dev ${args}`, { stdio: "pipe" })
      .toString()
      .trim();

  before(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "termic-e2e-colleague-"));
    const colleague = path.join(scratch, "colleague");
    execSync(`git clone -q "${origin}" "${colleague}"`);
    for (const b of [LISTED, UNFETCHED]) {
      git(colleague, `checkout -q -b ${b} origin/main`);
      git(colleague, `commit -q --allow-empty -m "${b}"`);
      sha[b] = git(colleague, "rev-parse HEAD");
      git(colleague, `push -q origin ${b}`);
      // Fetch after the first push only, so the second stays unfetched.
      if (b === LISTED) git(fixture, "fetch -q origin");
    }
  });

  // By NAME as well as by id: a case that throws between Create and reading
  // the id back still leaves its task, and the branch it made, behind.
  after(async () => {
    await browser.execute(async (names) => {
      const t = window.__termic!;
      for (const task of t.useApp.getState().tasks) {
        if (names.includes(task.name) && !task.archived) await t.ipc.taskArchive(task.id, true);
      }
      await t.useApp.getState().loadAll();
    }, [LISTED, TYPED_NAME]);
    const quiet = (cwd: string, args: string) => {
      try {
        git(cwd, args);
      } catch {
        /* already gone */
      }
    };
    quiet(fixture, "worktree prune");
    for (const b of [LISTED, UNFETCHED, UNKNOWN]) {
      quiet(fixture, `branch -D ${b}`);
      quiet(fixture, `update-ref -d refs/remotes/origin/${b}`);
      quiet(origin, `branch -D ${b}`);
    }
    if (scratch) rmTree(scratch, { bestEffort: true });
  });

  /** Open New Task for fixture-repo in worktree mode, then flip to the
   *  existing-branch mode through its title-line switch. */
  async function openCheckoutMode(): Promise<void> {
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await clickDialogButton("Worktree");
    await clickWhenVisible('[data-testid="checkout-branch-toggle"]');
    await waitForText(TITLE);
  }

  /** Click a button by exact text inside THIS dialog, found by its title. */
  async function clickInCheckout(text: string): Promise<void> {
    await browser.waitUntil(
      () =>
        browser.execute(
          (title, t) => {
            const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
              (d) => d.getAttribute("data-state") !== "closed" && d.textContent?.includes(title),
            );
            const btn = [...(dlg?.querySelectorAll("button") ?? [])].find(
              (b) => b.textContent?.trim() === t,
            ) as HTMLButtonElement | undefined;
            if (!btn || btn.disabled) return false;
            btn.click();
            return true;
          },
          TITLE,
          text,
        ),
      { timeout: 8_000, timeoutMsg: `no enabled "${text}" in the checkout dialog` },
    );
  }

  async function typeInto(selector: string, value: string): Promise<void> {
    await waitVisible(selector);
    await browser.execute(
      (sel, v) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      selector,
      value,
    );
  }

  const liveTask = (name: string) =>
    browser.execute(
      (n) => window.__termic!.useApp.getState().tasks.find((t: any) => t.name === n && !t.archived) ?? null,
      name,
    ) as Promise<{ id: string; branch: string; path: string } | null>;

  it("swaps the branch field for a picker, and New branch instead swaps it back", async () => {
    await openCheckoutMode();
    const shape = () =>
      browser.execute(() => {
        const dlg = document.querySelector('[data-testid="new-task-name"]')?.closest('[role="dialog"]');
        // each field is a group named by its label (aria-labelledby), so this
        // also proves the name reaches the accessibility tree.
        const labels = [...(dlg?.querySelectorAll('[role="group"][aria-labelledby]') ?? [])]
          .map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent?.trim());
        return {
          labels,
          // The Main checkout tab, and whether it can be chosen. It used to
          // disappear in this mode; it now stays and is DISABLED, so the row
          // does not reflow and the reason is on screen.
          mainCheckoutOffered: [...(dlg?.querySelectorAll("button") ?? [])].some(
            (b) => b.textContent?.trim() === "Main checkout" && !(b as HTMLButtonElement).disabled,
          ),
          // The task type and the source the dialog will actually act on.
          // Read from the form's own attributes, NOT from which tab looks
          // filled: `getComputedStyle` on a `transition-colors` tab returns
          // the INTERPOLATED value while the transition runs, so a colour
          // assertion here reported the previous tab as selected and only in
          // the full-suite timing, where the probe lands inside those 150ms.
          mode: dlg?.querySelector("#new-task-form")?.getAttribute("data-task-mode")
            ?? document.querySelector("#new-task-form")?.getAttribute("data-task-mode"),
          source: dlg?.querySelector("#new-task-form")?.getAttribute("data-task-source")
            ?? document.querySelector("#new-task-form")?.getAttribute("data-task-source"),
        };
      });

    const inMode = await shape();
    expect(inMode.labels).toContain("Branch");
    expect(inMode.labels).toContain("Compare against");
    expect(inMode.labels).not.toContain("Branch name");
    // The answer is always a worktree, so Main checkout cannot be picked.
    expect(inMode.mainCheckoutOffered).toBe(false);
    // The forced answer is a worktree, so that is the tab that must be filled.
    // This source IS a worktree, so that is what the dialog must be set to.
    // Main checkout being disabled (above) and the task type actually being a
    // worktree are two different claims, and only this one reaches the task.
    expect(inMode.mode).toBe("worktree");
    expect(inMode.source).toBe("branch");
    await snap("checkout-branch-mode.png");

    await clickWhenVisible('[data-testid="checkout-branch-exit"]');
    await waitForText("New task in a worktree");
    const back = await shape();
    expect(back.labels).toContain("Branch name");
    expect(back.labels).toContain("Branch from");
    expect(back.labels).not.toContain("Compare against");
    expect(back.mainCheckoutOffered).toBe(true);
    await clickDialogButton("Cancel");
    await waitGone('[data-testid="new-task-name"]', 5_000);
  });

  it("checks out a listed remote-only branch on a local branch that tracks it", async () => {
    await openCheckoutMode();
    const row = `[data-testid="checkout-branch-list"] [data-branch-ref="origin/${LISTED}"]`;
    await clickWhenVisible(row);
    // The pick fills the branch; Name stays blank and shows its default.
    const picked = await browser.execute(() => ({
      branch: (document.querySelector('[data-testid="checkout-branch-input"]') as HTMLInputElement).value,
      namePlaceholder: (document.querySelector('[data-testid="new-task-name"]') as HTMLInputElement).placeholder,
    }));
    expect(picked).toEqual({ branch: `origin/${LISTED}`, namePlaceholder: LISTED });
    await clickInCheckout("Terminal");
    await clickInCheckout("Create");

    await browser.waitUntil(async () => !!(await liveTask(LISTED)), {
      timeout: 30_000,
      timeoutMsg: "the checkout task never landed",
    });
    const task = (await liveTask(LISTED))!;
    expect(task.branch).toBe(LISTED);
    // On the COLLEAGUE's commit, not on main: the whole point.
    expect(git(task.path, "rev-parse HEAD")).toBe(sha[LISTED]);
    expect(git(task.path, "rev-parse --abbrev-ref HEAD")).toBe(LISTED);
    expect(git(fixture, `rev-parse --abbrev-ref ${LISTED}@{upstream}`)).toBe(`origin/${LISTED}`);
  });

  it("restores that task on the colleague's branch after archive deleted it", async () => {
    // Archive WITH delete-branch, the one setting that removes the local
    // copy, then restore: the branch has to come back from the remote. Cut
    // from the base it would be main under the colleague's branch name.
    const before = (await liveTask(LISTED))!;
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskArchive(id, true); // deleteBranch
      await window.__termic!.useApp.getState().loadAll();
    }, before.id);
    let localLeft = true;
    try {
      git(fixture, `rev-parse --verify -q refs/heads/${LISTED}`);
    } catch {
      localLeft = false;
    }
    expect(localLeft).toBe(false);

    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRestore(id);
      await window.__termic!.useApp.getState().loadAll();
    }, before.id);
    const task = (await liveTask(LISTED))!;
    expect(task.id).toBe(before.id);
    expect(git(task.path, "rev-parse HEAD")).toBe(sha[LISTED]);
    expect(git(fixture, `rev-parse --abbrev-ref ${LISTED}@{upstream}`)).toBe(`origin/${LISTED}`);
  });

  it("fetches a typed branch this repo has never fetched", async () => {
    await openCheckoutMode();
    await typeInto('[data-testid="checkout-branch-input"]', UNFETCHED);
    // Said before Create, so a typo is not a surprise several seconds later.
    await waitVisible('[data-testid="checkout-branch-unfetched"]');
    await typeInto('[data-testid="new-task-name"]', TYPED_NAME);
    await clickInCheckout("Terminal");
    await clickInCheckout("Create");

    await browser.waitUntil(async () => !!(await liveTask(TYPED_NAME)), {
      timeout: 30_000,
      timeoutMsg: "the typed checkout never landed",
    });
    const task = (await liveTask(TYPED_NAME))!;
    expect(task.branch).toBe(UNFETCHED);
    expect(git(task.path, "rev-parse HEAD")).toBe(sha[UNFETCHED]);
  });

  it("fails an unknown branch and leaves no branch behind", async () => {
    await openCheckoutMode();
    await typeInto('[data-testid="checkout-branch-input"]', UNKNOWN);
    await clickInCheckout("Terminal");
    await clickInCheckout("Create");

    // The pending task turns into the error, in the main pane.
    await waitForText(`no branch '${UNKNOWN}'`, 30_000);
    let created = true;
    try {
      git(fixture, `rev-parse --verify -q refs/heads/${UNKNOWN}`);
    } catch {
      created = false;
    }
    expect(created).toBe(false);
    await clickByText("Dismiss");
    await waitForTextGone(`no branch '${UNKNOWN}'`);
  });
});

// GH #242: while a task is mid-creation it's represented as a "pending" entry
// (no real Task exists yet — see src/store/pendingTasks.ts), which the
// sidebar and main pane render specially (PendingTaskRow / CreatingTaskPane).
// The dialog-driven case above proves the dialog itself closes immediately;
// this covers what the app shows during the (usually sub-second, on this
// fixture) window that leaves open. Seeded directly via usePendingTasks
// rather than raced against the real worktree add — see the e2e skill's
// "Reading real app state" section on why a deterministic seed beats racing
// something this fast.
describe("task creation, in progress (GH #242)", () => {
  let pendingId: string | undefined;
  afterEach(async () => {
    if (!pendingId) return;
    await browser.execute((id) => {
      window.__termic!.usePendingTasks.getState().remove(id);
    }, pendingId);
    pendingId = undefined;
  });

  it("shows a pending sidebar row and a live log in the main pane, with no blocking dialog", async () => {
    await waitForAppShell();
    await requireTermicApi();

    pendingId = await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const id = crypto.randomUUID();
      window.__termic!.usePendingTasks.getState().add({
        id, projectId: proj.id, name: "e2e-pending", cli: "fakeagent",
      });
      window.__termic!.usePendingTasks.getState().appendLine(id, "Adding worktree at /tmp/e2e-pending…");
      window.__termic!.useApp.getState().setActiveTask(id);
      return id;
    });

    // Sidebar: a spinner-badged row for the pending task — same badge
    // surface a real working agent uses.
    await waitVisible(`[data-sidebar-task-id="${pendingId}"]`);
    await waitForWorkBadge(pendingId, "working");

    // Main pane: the live creation log, not the Dashboard.
    await waitForText("e2e-pending");
    await waitVisible('[data-testid="creating-task-log"]');
    const logText: string = await browser.execute(
      () => document.querySelector('[data-testid="creating-task-log"]')?.textContent ?? "",
    );
    expect(logText).toContain("Adding worktree");

    // Nothing is blocking: creating a task opens no dialog, which is the
    // whole point of GH #242.
    //
    // What counts is a MODAL dialog, and only one that was not already there.
    // This window is shared by every spec file: a non-modal palette another
    // file left open blocks nothing, and Radix defers a dialog's unmount
    // until its closing animation ends, which never arrives while the window
    // is occluded. Filtering to `data-state="open"` was still counting both,
    // so the case failed for leftovers it does not own. A modal is the thing
    // that would actually lock the window, and `aria-modal` is how the DOM
    // says so.
    const blocking = await browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .filter((d) => d.getAttribute("data-state") !== "closed")
        .map((d) => (d as HTMLElement).textContent?.slice(0, 80) ?? ""),
    );
    expect(blocking).toEqual([]);

    await snap("creating-task-pending.png");
  });

  it("turns into a dismissible error state when creation fails", async () => {
    await waitForAppShell();
    await requireTermicApi();

    pendingId = await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      const id = crypto.randomUUID();
      window.__termic!.usePendingTasks.getState().add({
        id, projectId: proj.id, name: "e2e-pending-fail", cli: "fakeagent",
      });
      window.__termic!.usePendingTasks.getState().fail(id, "branch already checked out elsewhere");
      window.__termic!.useApp.getState().setActiveTask(id);
      return id;
    });

    await waitForWorkBadge(pendingId, "attention");
    await waitForText("branch already checked out elsewhere");

    // Dismiss clears both the pending entry and the active selection — no
    // orphaned row left in the sidebar.
    await clickByText("Dismiss");
    await waitForTextGone("branch already checked out elsewhere");
    const stillPending: boolean = await browser.execute(
      (id) => id in window.__termic!.usePendingTasks.getState().pending,
      pendingId,
    );
    expect(stillPending).toBe(false);
    pendingId = undefined; // Dismiss already cleaned it up
  });
});

// P1: resuming a closed agent tab. Seeds a closedTabs entry (the same shape the
// close path snapshots) and drives resumeClosedTab: it must reopen a tab and
// consume the entry.
describe("resume closed tab", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("reopens a closed tab and consumes the entry", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-resume");
    const before: number = await browser.execute(
      (id) => (window.__termic!.useApp.getState().tabs[id] ?? []).length as number,
      taskId,
    );

    // Seed a closed-tab entry, then resume it.
    await browser.execute((id) => {
      const app = window.__termic!.useApp;
      const entry = {
        id: "e2e-closed-1",
        cli: "fakeagent",
        title: "Resumed",
        sessionId: null,
        closedAt: new Date().toISOString(),
      };
      app.setState((s: any) => ({
        closedTabs: { ...s.closedTabs, [id]: [entry] },
      }));
    }, taskId);
    await browser.execute(
      (id) =>
        window.__termic!.useApp.getState().resumeClosedTab(id, "e2e-closed-1"),
      taskId,
    );

    // A tab was reopened and the closed entry was consumed.
    await browser.waitUntil(
      () =>
        browser.execute(
          (id, b) => {
            const s = window.__termic!.useApp.getState();
            return (
              (s.tabs[id] ?? []).length > b &&
              (s.closedTabs[id] ?? []).length === 0
            );
          },
          taskId,
          before,
        ),
      { timeout: 10_000, timeoutMsg: "closed tab was not resumed" },
    ).catch(async (e) => {
      // Which half failed matters and a deadline does not say: the tab never
      // appeared, or it appeared and a loadAll landing mid-resume replaced the
      // tab list with the persisted one before the entry was consumed.
      const state = await browser.execute((id) => {
        const s = window.__termic!.useApp.getState();
        return {
          tabs: (s.tabs[id] ?? []).map((t: any) => ({ type: t.type, title: t.title, cli: t.cli })),
          closed: (s.closedTabs[id] ?? []).map((c: any) => c.id),
        };
      }, taskId);
      throw new Error(`${(e as Error).message}\n  before=${before} now: ${JSON.stringify(state)}`);
    });
    await snap("resume-tab.png");
  });
});

// P1: Agent Race — fire ONE prompt at N agents, each in its own fresh worktree,
// and seed the prompt into every agent once it boots (src/lib/agentRace.ts). The
// dialog-opens smoke lives in app.e2e.ts; THIS asserts the engine end to end:
// the cohort is recorded, every racer's default agent tab spawns a live PTY, and
// every racer receives the prompt after the settle (lastInputAt stamped + the
// fakeagent's OSC title flips to its working spinner). Regression guard for the
// "race just sits there" failure mode — an agent that spawns but never gets fed.
describe("agent race", () => {
  // Unique per run so a re-run never collides on the race branch/worktree even
  // if a prior run's cleanup was interrupted (git worktree add is unforgiving).
  const remoteName = `e2erace-${Date.now()}`;
  const localName = `e2elocalrace-${Date.now()}`;
  const createdTaskIds: string[] = [];

  before(() => {
    // Racers branch off the project default `origin/main`, so that ref must
    // resolve. The git commit-push spec swaps the fixture's origin to a
    // throwaway and restores it, but keep this test independent of run order:
    // if origin/main is missing, restore it from the seeded sibling bare repo.
    try {
      execSync(`git -C "${fixture}" rev-parse --verify -q origin/main`, {
        stdio: "ignore",
      });
    } catch {
      const seedOrigin = `${fixture}-origin.git`;
      if (existsSync(seedOrigin)) {
        try {
          execSync(`git -C "${fixture}" remote add origin "${seedOrigin}"`, {
            stdio: "ignore",
          });
        } catch {
          /* remote already present, just needs a fetch */
        }
        execSync(`git -C "${fixture}" fetch -q origin`, { stdio: "ignore" });
      }
    }
  });

  after(async () => {
    // Hard-delete each racer: removes its worktree AND wipes the task file, so
    // the next run starts from the same clean fixture. Best-effort.
    for (const id of createdTaskIds) {
      await browser
        .execute(async (i) => {
          await window.__termic!.ipc.taskDelete(i);
          await window.__termic!.useApp.getState().loadAll();
        }, id)
        .catch(() => {});
    }
    // A race that throws PART WAY through leaves racer 1 created and racer 2
    // never attempted, and raceAndVerify only records the ids startRace
    // RETURNS — so the loop above has nothing to delete and the worktree stays
    // on disk. Sweep by name, which is what the ids would have pointed at.
    // (Seen once in a full-suite run: racer 1's create reported "a worktree
    // already lives at …" for its own path, and the directory outlived the
    // suite.)
    for (const stale of [remoteName, localName]) {
      for (const dir of [
        path.join(process.cwd(), ".e2e", "tasks", "fixture-repo"),
        path.join(os.homedir(), "termic_dev", "tasks", "fixture-repo"),
      ]) {
        try {
          for (const entry of readdirSync(dir)) {
            if (entry.startsWith(stale)) rmSync(path.join(dir, entry), { recursive: true, force: true, maxRetries: 10 });
          }
        } catch { /* the directory may not exist on this machine */ }
      }
    }
    // taskDelete keeps the branch (deleteBranch=false), so prune the worktrees
    // AND every race branch this describe created, or the fixture accrues them.
    try {
      execSync(`git -C "${fixture}" worktree prune`);
      const raceBranches = execSync(
        `git -C "${fixture}" for-each-ref --format="%(refname:short)" refs/heads/race`,
      )
        .toString()
        .split("\n")
        .filter(Boolean);
      for (const b of raceBranches) {
        execSync(`git -C "${fixture}" branch -D "${b}"`, { stdio: "ignore" });
      }
    } catch {
      /* nothing to prune */
    }
  });

  // Start a 2-fakeagent race named `name` and assert the whole engine: cohort
  // recorded, both racers spawn a live PTY, both receive the prompt (lastInputAt
  // stamped), both drive a fakeagent OSC title. Returns the racer task ids.
  async function raceAndVerify(name: string): Promise<string[]> {
    await waitForAppShell();
    await requireTermicApi();

    const ids = (await browser.execute(
      async (n) => {
        const t = window.__termic!;
        const proj = t.useApp
          .getState()
          .projects.find((p: any) => p.name === "fixture-repo");
        return await t.agentRace.startRace({
          projectId: proj.id,
          racers: [
            { cli: "fakeagent", n: 1 },
            { cli: "fakeagent", n: 2 },
          ],
          prompt: "hello from the race test",
          name: n,
        });
      },
      name,
    )) as string[];
    createdTaskIds.push(...ids);
    expect(ids).toHaveLength(2);

    // 1) The cohort is recorded before anything mounts, so the board can
    //    enumerate exactly which worktrees raced.
    const cohort = await browser.execute((cohortIds: string[]) => {
      const races = Object.values(
        window.__termic!.useRace.getState().races ?? {},
      ) as any[];
      const c = races.find((r) => cohortIds.every((id) => r.taskIds.includes(id)));
      return c ? { taskIds: c.taskIds } : null;
    }, ids);
    expect(cohort?.taskIds).toEqual(expect.arrayContaining(ids));

    // Reads the default agent tab (the seeded, is_default terminal) of every
    // racer at once — the exact tab agentRace targets for prompt injection.
    const racerTabs = () =>
      browser.execute((tabIds: string[]) => {
        const app = window.__termic!.useApp.getState();
        return tabIds.map((id) => {
          const def = (app.tabs[id] ?? []).find(
            (x: any) => x.type === "terminal" && x.is_default,
          );
          return {
            ptyId: def?.ptyId ?? null,
            lastInputAt: def?.lastInputAt ?? null,
            liveTitle: def?.liveTitle ?? null,
            // Enough to tell "the pane never mounted" from "it mounted and the
            // spawn stalled" when this times out, which is the whole question
            // and is not answerable after the fact from a deadline alone.
            tabs: (app.tabs[id] ?? []).length,
            mounted: !!document.querySelector(`[data-task-id="${id}"]`),
            hasPane: !!document.querySelector(`[data-task-id="${id}"] .xterm`),
            // Does the task still EXIST, and how long has this document been
            // alive? A webview that reloaded mid-test comes back with an empty
            // store and a performance.now() near zero, which reads exactly
            // like "the racer never started" unless you ask.
            taskExists: app.tasks.some((t: any) => t.id === id),
            docAgeMs: Math.round(performance.now()),
          };
        });
      }, ids);

    // Two recorders, because the first one's SILENCE turned out to be the
    // finding. __raceLog rides in the JS context and notes every change to a
    // racer's tab list; the token rides in sessionStorage, which survives a
    // reload that the JS context does not. A timeout that reports an empty
    // timeline AND a surviving token whose window-side twin is gone did not
    // watch the tabs close: it watched the page get replaced underneath it.
    const startedAt = Date.now();
    await browser.execute((tabIds: string[]) => {
      const w = window as any;
      w.__raceLog = [];
      w.__raceToken = String(Math.round(performance.now()));
      sessionStorage.setItem("e2e-race-token", w.__raceToken);
      const app = window.__termic!.useApp;
      const seen: Record<string, number> = {};
      w.__raceUnsub = app.subscribe((s: any) => {
        for (const id of tabIds) {
          const n = (s.tabs[id] ?? []).length;
          if (seen[id] !== n) {
            seen[id] = n;
            w.__raceLog.push(`${Math.round(performance.now())}ms ${id.slice(0, 8)} tabs=${n} mounted=${s.mountedTasks.has(id)}`);
          }
        }
      });
    }, ids);

    /** waitUntil's message, with the state that produced it — and the right
     *  headline when the racers are innocent. */
    const withRacerState = async (msg: string) => {
      const page = await browser.execute(() => ({
        // A token in sessionStorage outlives a reload; its twin on `window`
        // does not. Disagreement means this is not the document the test
        // started in.
        reloaded: (window as any).__raceToken !== sessionStorage.getItem("e2e-race-token"),
        docAgeMs: Math.round(performance.now()),
        timeline: (window as any).__raceLog ?? [],
      })) as { reloaded: boolean; docAgeMs: number; timeline: string[] };
      const waited = Date.now() - startedAt;
      const head = page.reloaded
        ? `the webview reloaded during this test, so the store the assertions read is a fresh one`
        : msg;
      return `${head}\n  racers: ${JSON.stringify(await racerTabs())}`
        + `\n  tab-list timeline: ${JSON.stringify(page.timeline)}`
        + `\n  waited ${waited}ms, document is ${page.docAgeMs}ms old, reloaded=${page.reloaded}`
        + (page.reloaded ? `\n  (original failure: ${msg})` : "");
    };

    // 2) Both racers' agents actually spawn: their default tab acquires a live
    //    PTY. This is the "did the hidden/inactive racer boot at all" guard.
    await browser.waitUntil(
      async () => (await racerTabs()).every((t) => !!t.ptyId),
      // 45s, not 20: two worktrees, two PTYs and two agent boots, and this
      // spec runs about twice as slowly inside a full suite as it does alone
      // (43s vs 21s locally). Both halves of this wait timed out across two
      // consecutive full runs, on a different half each time, which is what a
      // deadline sized for an idle machine looks like rather than a bug. A
      // generous ceiling costs nothing when it works: waitUntil returns the
      // moment the condition holds.
      { timeout: 45_000, timeoutMsg: "a racer never spawned its agent PTY" },
    ).catch(async (e) => { throw new Error(await withRacerState((e as Error).message)); });

    // 3) Both racers receive the prompt after the settle: agentRace stamps
    //    lastInputAt when it injects. This is the core "sits there" guard — an
    //    agent that spawned but was never fed would fail HERE.
    await browser.waitUntil(
      async () => (await racerTabs()).every((t) => !!t.lastInputAt),
      {
        timeout: 45_000,
        timeoutMsg: "a racer spawned but never received the race prompt",
      },
    ).catch(async (e) => { throw new Error(await withRacerState((e as Error).message)); });

    // 4) The seeded terminals are real fakeagent PTYs driving claude-style OSC
    //    titles (✳ idle / Braille spinner working), not empty shells. Poll: the
    //    inactive racer's title can lag a beat behind its prompt injection.
    await browser.waitUntil(
      async () =>
        (await racerTabs()).every((t) =>
          (t.liveTitle ?? "").includes("fakeagent"),
        ),
      {
        timeout: 30_000,
        timeoutMsg: "a racer never published its fakeagent OSC title",
      },
    );
    return ids;
  }

  it("fires one prompt at 2 agents, each spawns and receives it", async () => {
    await raceAndVerify(remoteName);
    await snap("agent-race.png");
  });

  // ---- RaceDialog UI wiring ----------------------------------------------
  // The tests above call startRace() directly (the engine). These drive the
  // actual dialog: the Start-button gating (canStart), the +/- steppers, the
  // prompt field, and Start -> startRace. Small DOM helpers scoped to the
  // open [role=dialog]; React-controlled inputs need a dispatched input event.

  // More than one [role=dialog] can be in the DOM at once: dialogs stack, and on
  // an occluded window (full-suite load) a closing dialog's rAF-driven unmount
  // lags, so a stale node lingers. A bare [role=dialog] selector then grabs the
  // wrong one (this is why these passed solo but failed as the last spec until
  // scoped). Scope EVERY query to the race dialog by its title.
  const RACE_TITLE = "Start an agent race";

  // Set a React-controlled input/textarea's value so onChange fires (assigning
  // .value alone doesn't notify React).
  const setControlled = (selector: string, value: string) =>
    browser.execute(
      (sel, val, title) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
          (d.textContent || "").includes(title),
        );
        const el = dlg!.querySelector(sel) as
          | HTMLInputElement
          | HTMLTextAreaElement;
        const desc = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el),
          "value",
        )!;
        desc.set!.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      selector,
      value,
      RACE_TITLE,
    );

  // Click the +/- stepper of the FakeAgent row (its two buttons are [minus, plus]).
  const bumpFakeAgent = (dir: 1 | -1) =>
    browser.execute(
      (d, title) => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((x) =>
          (x.textContent || "").includes(title),
        );
        if (!dlg) return false;
        const row = [...dlg.querySelectorAll("div")].find(
          (r) =>
            r.querySelectorAll("button").length === 2 &&
            /FakeAgent/.test(r.textContent || ""),
        );
        if (!row) return false;
        (row.querySelectorAll("button")[d > 0 ? 1 : 0] as HTMLElement).click();
        return true;
      },
      dir,
      RACE_TITLE,
    );

  // Read the Start button's disabled state + the status line ("Pick at least 2
  // agents" vs "N agents racing").
  const startBtnState = () =>
    browser.execute((title) => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        (d.textContent || "").includes(title),
      );
      if (!dlg) return { disabled: null, pick2: false, racing: false };
      const btn = [...dlg.querySelectorAll("button")].find((b) =>
        /Start race/.test(b.textContent || ""),
      ) as HTMLButtonElement | undefined;
      const text = dlg.textContent || "";
      return {
        disabled: btn?.disabled ?? null,
        pick2: text.includes("Pick at least 2 agents"),
        racing: /agents racing/.test(text),
      };
    }, RACE_TITLE);

  const clickStart = () =>
    browser.execute((title) => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        (d.textContent || "").includes(title),
      );
      (
        [...dlg!.querySelectorAll("button")].find((b) =>
          /Start race/.test(b.textContent || ""),
        ) as HTMLElement
      ).click();
    }, RACE_TITLE);

  const openRaceDialog = async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openRace(proj.id);
    });
    // Wait for the RACE dialog specifically, not just any dialog.
    await browser.waitUntil(
      async () =>
        browser.execute(
          (title) =>
            [...document.querySelectorAll('[role="dialog"]')].some((d) =>
              (d.textContent || "").includes(title),
            ),
          RACE_TITLE,
        ),
      { timeout: 8_000, timeoutMsg: "race dialog never appeared" },
    );
  };
  const dialogOpen = () =>
    browser.execute(() => !!window.__termic!.useUI.getState().raceProjectId);

  it("dialog gates Start, then steppers + a prompt launch a race", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const uiName = `e2euirace-${Date.now()}`;
    await openRaceDialog();

    // Nothing picked yet: Start disabled, "Pick at least 2 agents".
    expect(await startBtnState()).toEqual({
      disabled: true,
      pick2: true,
      racing: false,
    });

    // Bump FakeAgent to 2.
    expect(await bumpFakeAgent(1)).toBe(true);
    await bumpFakeAgent(1);
    // 2 agents but still no prompt → Start stays disabled.
    expect((await startBtnState()).disabled).toBe(true);

    // Add the prompt + a unique name → Start enables, status flips to "racing".
    await setControlled("textarea", "do the thing");
    await setControlled("#race-name", uiName);
    await browser.waitUntil(async () => (await startBtnState()).disabled === false, {
      timeout: 5_000,
      timeoutMsg: "Start never enabled after 2 agents + a prompt",
    });
    expect((await startBtnState()).racing).toBe(true);

    // Start → the dialog closes and a 2-racer cohort under `uiName` is recorded.
    await clickStart();
    await browser.waitUntil(async () => (await dialogOpen()) === false, {
      timeout: 10_000,
      timeoutMsg: "race dialog did not close after Start",
    });
    const ids = (await browser.execute((nm) => {
      const races = Object.values(
        window.__termic!.useRace.getState().races ?? {},
      ) as any[];
      return races.find((r) => r.name === nm)?.taskIds ?? [];
    }, uiName)) as string[];
    expect(ids).toHaveLength(2);
    createdTaskIds.push(...ids);
  });

  it("dialog surfaces a name collision and records no new race", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const dupName = `e2edup-${Date.now()}`;

    // Seed a first race under `dupName` directly (fast), so its branches exist.
    const first = (await browser.execute(async (nm) => {
      const t = window.__termic!;
      const proj = t.useApp
        .getState()
        .projects.find((p: any) => p.name === "fixture-repo");
      return await t.agentRace.startRace({
        projectId: proj.id,
        racers: [
          { cli: "fakeagent", n: 1 },
          { cli: "fakeagent", n: 2 },
        ],
        prompt: "first race",
        name: nm,
      });
    }, dupName)) as string[];
    createdTaskIds.push(...first);
    const racesBefore = await browser.execute(
      () => Object.keys(window.__termic!.useRace.getState().races ?? {}).length,
    );

    // Drive the dialog to start a SECOND race with the SAME name → the first
    // racer's branch already exists, so startRace throws.
    await openRaceDialog();
    await bumpFakeAgent(1);
    await bumpFakeAgent(1);
    await setControlled("textarea", "second race");
    await setControlled("#race-name", dupName);
    await browser.waitUntil(async () => (await startBtnState()).disabled === false, {
      timeout: 5_000,
      timeoutMsg: "Start never enabled for the collision case",
    });
    await clickStart();

    // The dialog shows an error and stays OPEN (a failed race must not close
    // silently). The message is the task-create collision text.
    await browser.waitUntil(
      async () =>
        browser.execute((title) => {
          const dlg = [...document.querySelectorAll('[role="dialog"]')].find(
            (d) => (d.textContent || "").includes(title),
          );
          if (!dlg) return false;
          return [...dlg.querySelectorAll("p")].some((p) =>
            /already|checked out|exist|valid|used by/i.test(p.textContent || ""),
          );
        }, RACE_TITLE),
      { timeout: 12_000, timeoutMsg: "collision error was never shown in the dialog" },
    );
    expect(await dialogOpen()).toBe(true);
    // No NEW cohort was recorded (the record only happens after all creates).
    const racesAfter = await browser.execute(
      () => Object.keys(window.__termic!.useRace.getState().races ?? {}).length,
    );
    expect(racesAfter).toBe(racesBefore);

    await browser.execute(() => window.__termic!.useUI.getState().closeRace());
  });

  // A purely local git repo (no remote) has no origin/main, yet the project
  // default base IS origin/main — so without the base-ref fallback
  // (resolve_base_ref in lib.rs) every racer's `git branch ... origin/main`
  // dies with "not a valid object name" and the race can't start. This proves
  // a race still works with the remote removed, cutting worktrees from local main.
  describe("on a local-only repo (no remote)", () => {
    before(() => {
      try {
        execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
      } catch {
        /* already remote-less */
      }
    });
    after(() => {
      // Restore the seeded origin so later specs/runs see origin/main again.
      const seedOrigin = `${fixture}-origin.git`;
      try {
        execSync(`git -C "${fixture}" remote remove origin`, { stdio: "ignore" });
      } catch {
        /* none */
      }
      if (existsSync(seedOrigin)) {
        try {
          execSync(`git -C "${fixture}" remote add origin "${seedOrigin}"`, {
            stdio: "ignore",
          });
        } catch {
          /* already present */
        }
        execSync(`git -C "${fixture}" fetch -q origin`, { stdio: "ignore" });
      }
    });

    it("races with no remote, cutting worktrees from local main", async () => {
      // Precondition: origin/main genuinely does not resolve here.
      let originResolves = true;
      try {
        execSync(`git -C "${fixture}" rev-parse --verify -q origin/main`, {
          stdio: "ignore",
        });
      } catch {
        originResolves = false;
      }
      expect(originResolves).toBe(false);

      await raceAndVerify(localName);

      // The racer branches were actually cut (from local main, the fallback).
      const branches = execSync(
        `git -C "${fixture}" branch --list "race/${localName}/*"`,
      ).toString();
      expect(branches).toContain(`race/${localName}/fakeagent-1`);
      expect(branches).toContain(`race/${localName}/fakeagent-2`);
    });
  });
});

// P1: drag-to-reorder tasks inside a project (issue #144). The sidebar drag is
// pointer-based (see helpers.pointerDrag) and lands in `task_reorder`, which
// writes an `order` index into each task file. Cases: the live reorder; the
// order surviving a reload from disk (what a restart reads); and the hard
// boundary that a task never leaves its own project. Project drag-to-reorder,
// which shares the sidebar but a different handler, stays covered by
// projects.e2e.ts.
describe("sidebar task drag", () => {
  const ids: string[] = [];
  let otherDir: string | undefined;
  let otherProjectId: string | undefined;
  let otherTaskId: string | undefined;
  let fixtureProjectId: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    for (const n of ["drag-a", "drag-b", "drag-c"]) ids.push(await openTask(n, false));
    fixtureProjectId = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks
        .find((t: any) => t.id === id)!.project_id as string,
      ids[0],
    );
    // A second project + task: the cross-project case needs a real foreign
    // row to aim the drag at.
    otherDir = mkdtempSync(path.join(os.tmpdir(), "e2e-taskdrag-"));
    execSync(
      `git -C "${otherDir}" init -q && git -C "${otherDir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
    const seeded = await browser.execute(async (dir) => {
      const t = window.__termic!;
      const proj: any = await t.ipc.projectAdd(dir);
      const task: any = await t.ipc.taskOpenRepo(proj.id, "fakeagent", "other-task");
      await t.useApp.getState().loadAll();
      return { projectId: proj.id as string, taskId: task.id as string };
    }, otherDir);
    otherProjectId = (seeded as any).projectId;
    otherTaskId = (seeded as any).taskId;
    // Task rows only exist in the DOM while their project is expanded.
    await browser.execute((a, b) => {
      const s = window.__termic!.useApp.getState();
      s.setProjectCollapsed(a, false);
      s.setProjectCollapsed(b, false);
    }, fixtureProjectId, otherProjectId);
    await dismissOverlays();
  });

  after(async () => {
    for (const id of [...ids, otherTaskId].filter(Boolean) as string[]) {
      await archiveTask(id);
    }
    if (otherProjectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, otherProjectId);
    }
    if (otherDir) rmTree(otherDir, { bestEffort: true });
  });

  // Sidebar rows, NOT `[data-task-id]` — that one is MainArea's mounted
  // TaskView container, and every visited task stays mounted.
  const row = (id: string) => `[data-sidebar-task-id="${id}"]`;
  // Sidebar order = store order, filtered to one project's visible rows.
  const order = (projectId: string) =>
    browser.execute(
      (p) => window.__termic!.useApp.getState().tasks
        .filter((t: any) => t.project_id === p && !t.archived)
        .map((t: any) => t.id as string),
      projectId,
    ) as Promise<string[]>;
  // Same list, but re-read from the task files on disk — `tasks_list` calls
  // the very loader a cold start uses, so this is the restart check without
  // relaunching the window.
  const diskOrder = (projectId: string) =>
    browser.execute(async (p) => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return all.filter((t) => t.project_id === p && !t.archived).map((t) => t.id as string);
      // `as unknown as`: browser.execute types an async callback as
      // Promise<Promise<T>>, which WDIO flattens at runtime.
    }, projectId) as unknown as Promise<string[]>;
  // What the user actually SEES, read off the rendered rows. Store-only
  // assertions can't catch a surface that re-sorts the list on render — the
  // sidebar and the Dashboard each did exactly that before this feature, and
  // a revert of either would leave every store assertion green.
  const domOrder = (attr: "sidebar" | "dashboard", projectId: string) =>
    browser.execute(
      (a, p) => [...document.querySelectorAll<HTMLElement>(`[data-${a}-task-id]`)]
        .filter(el => el.dataset[`${a}TaskProjectId`] === p)
        .map(el => el.dataset[`${a}TaskId`]!),
      attr,
      projectId,
    ) as Promise<string[]>;

  it("moves a task above its sibling and keeps the rest in place", async () => {
    const [a, b, c] = ids;
    // Creation order, oldest first — the behavior before this feature.
    expect((await order(fixtureProjectId)).slice(-3)).toEqual([a, b, c]);

    await waitVisible(row(c));
    // Dropping above a row's midpoint inserts before it.
    await pointerDrag(row(c), row(a), { land: "top" });
    await browser.waitUntil(
      async () => {
        const o = await order(fixtureProjectId);
        return o.indexOf(c) < o.indexOf(a);
      },
      { timeout: 8_000, timeoutMsg: "dragging a task did not reorder the sidebar" },
    );
    // The two rows it passed keep their relative order: a reorder, not a shuffle.
    const after = await order(fixtureProjectId);
    expect(after.indexOf(a)).toBeLessThan(after.indexOf(b));
    // The SIDEBAR agrees with the store. Without this the spec passes even if
    // the render re-sorts by `created` and the user sees no change at all.
    expect(await domOrder("sidebar", fixtureProjectId)).toEqual(after);
    await snap("task-drag-reordered");
  });

  it("shows the same order on the Dashboard", async () => {
    // The Dashboard lists each project's tasks too, and used to re-sort them
    // by creation time — same project, two different orders.
    await browser.execute(() => window.__termic!.useApp.getState().setView("dashboard"));
    await waitVisible(`[data-dashboard-task-id="${ids[0]}"]`);
    expect(await domOrder("dashboard", fixtureProjectId))
      .toEqual(await order(fixtureProjectId));
  });

  it("persists the order to disk, so a restart reads it back", async () => {
    await browser.waitUntil(
      async () => {
        const [live, disk] = [await order(fixtureProjectId), await diskOrder(fixtureProjectId)];
        return live.join() === disk.join();
      },
      { timeout: 8_000, timeoutMsg: "task_reorder never reached the task files" },
    );
    const disk = await diskOrder(fixtureProjectId);
    expect(disk.indexOf(ids[2])).toBeLessThan(disk.indexOf(ids[0]));
  });

  it("refuses to move a task into another project", async () => {
    const [a] = ids;
    const foreignBefore = await order(otherProjectId!);

    await waitVisible(row(otherTaskId!));
    // Aim at a row that belongs to a DIFFERENT project. The handler only
    // hit-tests siblings, so the row clamps to the bottom of its own list
    // instead of defecting.
    await pointerDrag(row(a), row(otherTaskId!), { land: "bottom" });

    const projectOf = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks
        .find((t: any) => t.id === id)!.project_id as string,
      a,
    );
    expect(projectOf).toBe(fixtureProjectId);
    // The foreign project's list is untouched — nothing was inserted into it.
    expect(await order(otherProjectId!)).toEqual(foreignBefore);
    // And the drag still did something legal: last in its own project.
    const own = await order(fixtureProjectId);
    expect(own[own.length - 1]).toBe(a);
  });
});

// Task groups: an agent that creates tasks through the CLI gets them drawn
// as one block in the sidebar, led by its own task. The whole chain runs for
// real: the `termic` sidecar reads $TERMIC_TASK_ID, the server checks it and
// hands it to the webview's create handler, which joins the group before the
// row first renders. Then every way a user edits a group, through the real
// menus and the real drag handlers. Each state is snapped for a human pass.
describe("task groups", () => {
  let fixtureProjectId: string;
  let orch: string;
  let child1: string;
  let child2: string;
  let grandchild: string;
  let loose: string;
  const created: string[] = [];

  // The sidebar row and the drawn block. Rows are `data-sidebar-task-id`
  // (MainArea owns `data-task-id`, see "sidebar task drag").
  const row = (id: string) => `[data-sidebar-task-id="${id}"]`;
  const block = (gid: string) => `[data-task-group-id="${gid}"]`;
  /** Ids of the rows drawn INSIDE a group's block, in display order. */
  const blockRows = (gid: string) =>
    browser.execute(
      (sel) => [...document.querySelectorAll<HTMLElement>(`${sel} [data-sidebar-task-id]`)]
        .map(el => el.dataset.sidebarTaskId!),
      block(gid),
    ) as Promise<string[]>;
  /** Each task's group as the task FILE says, via the cold-start loader. */
  const diskGroups = () =>
    browser.execute(async () => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return Object.fromEntries(all.map(t => [t.id, t.group ?? null]));
    }) as unknown as Promise<Record<string, { id: string; name?: string; color?: string } | null>>;
  /** The rail's painted colour against the palette token it should resolve
   *  to, both read as computed rgb so a theme change cannot fake a match. */
  const railMatches = (gid: string, key: string) =>
    browser.execute((sel, k) => {
      const rail = document.querySelector(`${sel} [data-task-group-rail]`) as HTMLElement | null;
      if (!rail) return false;
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(--color-palette-${k})`;
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(rail).borderLeftColor === want;
    }, block(gid), key) as Promise<boolean>;
  const label = (gid: string) =>
    browser.execute(
      (g) => document.querySelector(`[data-testid="task-group-label-${g}"]`)?.textContent ?? null,
      gid,
    ) as Promise<string | null>;
  // A WebDriver right-click does not reach Radix's onContextMenu in this
  // WKWebView (files.e2e.ts measured it); the dispatched event goes through
  // the real trigger.
  const rightClick = (sel: string) =>
    browser.execute((s) => {
      const el = document.querySelector(s) as HTMLElement;
      if (!el) throw new Error(`nothing at ${s}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 5,
      }));
    }, sel);
  /** Click a menu entry by its visible label or aria-label, in whichever
   *  menu is open (ContextMenuItem has no menuitem role for plain items). */
  const clickInMenu = (text: string) =>
    browser.waitUntil(() => browser.execute((t) => {
      const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
      for (const m of menus) {
        // aria-label for the swatches; otherwise the DEEPEST element whose
        // text is exactly the label (an item is an icon plus a text node).
        const hit = [...m.querySelectorAll<HTMLElement>("*")].reverse().find(
          el => el.getAttribute("aria-label") === t || el.textContent?.trim() === t,
        );
        if (hit) { (hit.closest('[role="menuitem"], [role="menuitemcheckbox"], [data-radix-collection-item]') as HTMLElement ?? hit).click(); return true; }
      }
      return false;
    }, text), { timeout: 8_000, timeoutMsg: `no open menu offered "${text}"` });
  /** `termic new` exactly as an agent inside `parent` would run it. */
  const cliNew = (name: string, parent: string | null, extra: string[] = []) => {
    const env: Record<string, string> = { TERMIC_DATA_DIR: dataDir, TERMIC_TASK_ID: parent ?? "" };
    const out = JSON.parse(runCli([
      "--no-launch", "--json", "new", name,
      "--agent", "fakeagent", "--project", "fixture-repo", "--main", ...extra,
    ], env));
    created.push(out.task.id);
    return out.task.id as string;
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    orch = await openTask("grp-orchestrator", false);
    loose = await openTask("grp-loose", false);
    fixtureProjectId = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)!.project_id as string,
      orch,
    );
    await browser.execute(
      (p) => window.__termic!.useApp.getState().setProjectCollapsed(p, false),
      fixtureProjectId,
    );
    await dismissOverlays();
  });

  after(async () => {
    for (const id of [...created, orch, loose].filter(Boolean)) await archiveTask(id);
  });

  it("a task the orchestrator's agent creates founds a group led by the orchestrator", async () => {
    await waitVisible(row(orch));
    await snap("task-groups-01-before.png");
    child1 = cliNew("grp-worker-1", orch);

    await waitVisible(block(orch));
    await browser.waitUntil(async () => (await blockRows(orch)).join() === [orch, child1].join(), {
      timeout: 8_000, timeoutMsg: "the new task and its orchestrator were not drawn as one block",
    });
    // The group has no name of its own: it shows the orchestrator's.
    expect(await label(orch)).toBe("grp-orchestrator");
    const disk = await diskGroups();
    expect(disk[orch]?.id).toBe(orch);
    expect(disk[child1]).toEqual(disk[orch]);
    expect(disk[orch]?.name).toBeUndefined();
    // A colour was picked at founding, and the rail paints it.
    expect(disk[orch]?.color).toBeTruthy();
    expect(await railMatches(orch, disk[orch]!.color!)).toBe(true);
    // An unrelated task stays outside the block.
    expect(await blockRows(orch)).not.toContain(loose);
    await snap("task-groups-02-founded-by-cli.png");
  });

  it("more tasks join the same group, and a worker's own tasks join it too (flat)", async () => {
    child2 = cliNew("grp-worker-2", orch);
    // The worker orchestrating in turn: its task lands in the ROOT group.
    grandchild = cliNew("grp-sub-worker", child1);
    await browser.waitUntil(async () => (await blockRows(orch)).length === 4, {
      timeout: 8_000, timeoutMsg: "the second worker and the sub-worker did not join the block",
    });
    expect(await blockRows(orch)).toEqual([orch, child1, child2, grandchild]);
    const disk = await diskGroups();
    expect(disk[grandchild]?.id).toBe(orch);
    expect(disk[child2]?.color).toBe(disk[orch]?.color);
    await snap("task-groups-03-four-members.png");
  });

  it("keeps the block, as a coloured rail alone, in the compact sidebar", async () => {
    const color = (await diskGroups())[orch]!.color!;
    // The real toggle, not a store write: it is what suppresses the 220ms
    // column transition, and a snap taken mid-transition shows a rail
    // stranded at the old width's left edge.
    await browser.execute(() => window.__termic!.useApp.getState().toggleCompactSidebar());
    try {
      await waitVisible(block(orch));
      await browser.waitUntil(() => browser.execute(
        (sel) => (document.querySelector(sel)?.getBoundingClientRect().width ?? 999) < 100, block(orch),
      ), { timeout: 8_000, timeoutMsg: "the sidebar never narrowed to the icon rail" });
      // No caption on the icon rail, the rail itself carries the colour.
      expect(await browser.execute(
        (g) => !!document.querySelector(`[data-testid="task-group-header-${g}"]`), orch,
      )).toBe(false);
      const matches = await browser.execute((sel, k) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        const probe = document.createElement("span");
        probe.style.backgroundColor = `var(--color-palette-${k})`;
        document.body.appendChild(probe);
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(el).borderLeftColor === want;
      }, block(orch), color);
      expect(matches).toBe(true);
      // Compact rows are icon tiles keyed `data-rail-task-id`, not the full
      // row's `data-sidebar-task-id`.
      const tiles = await browser.execute(
        (sel) => [...document.querySelectorAll<HTMLElement>(`${sel} [data-rail-task-id]`)].map(el => el.dataset.railTaskId!),
        block(orch),
      );
      expect(tiles).toEqual([orch, child1, child2, grandchild]);
      // The rail hugs the tiles: a rail stranded far left of them reads as
      // a stray line, not as a bracket around these tasks.
      const gap = await browser.execute((sel) => {
        const b = document.querySelector(sel)!.getBoundingClientRect();
        const t = document.querySelector(`${sel} [data-rail-task-id]`)!.getBoundingClientRect();
        return t.left - b.left;
      }, block(orch));
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(16);
      await snap("task-groups-03b-compact.png");
    } finally {
      await browser.execute(() => {
        const s = window.__termic!.useApp.getState();
        if (s.compactSidebar) s.toggleCompactSidebar();
      });
    }
  });

  it("collapses to one of each mark its members carry, and navigating opens it", async () => {
    const toggle = `[data-testid="task-group-toggle-${orch}"]`;
    const badges = () => browser.execute(
      (g) => document.querySelector(`[data-testid="task-group-badges-${g}"]`)?.getAttribute("data-kinds") ?? null,
      orch,
    ) as Promise<string | null>;
    // Setup, not assertion: give two members a work state the way an agent's
    // hooks would, on their REAL agent tabs. Wait for each agent to be ready
    // first: these tasks are live (created by `new`), and an agent still
    // booting reports idle over whatever was set.
    await waitForAgentReady(child1);
    await waitForAgentReady(child2);
    await browser.execute((done, needs) => {
      const t = window.__termic!;
      const s = t.useApp.getState();
      s.patchTab(done, s.tabs[done][0].id, { workState: "done" });
      s.patchTab(needs, s.tabs[needs][0].id, { unread: { reason: "attention" } });
      t.useApp.setState({ activeTaskId: null });
    }, child1, child2);
    try {
      await clickWhenVisible(toggle);
      // Collapsed: no member rows, and the caption carries one of each mark
      // present, attention first.
      await browser.waitUntil(async () => (await blockRows(orch)).length === 0, {
        timeout: 5_000, timeoutMsg: "collapsing did not hide the members",
      });
      await browser.waitUntil(async () => (await badges()) === "attention,done", {
        timeout: 5_000,
      }).catch(async () => {
        const why = await browser.execute((id) => {
          const t = window.__termic!;
          return JSON.stringify({ tabs: t.useApp.getState().tabs[id], settled: t.usePrefs.getState().settledHighlight });
        }, child1);
        throw new Error(`collapsed caption showed ${await badges()} instead of attention,done; done member: ${why}`);
      });
      // Every mark sits on one centre line. Measured, since a bell riding the
      // text baseline a pixel or two above the dot is exactly the kind of
      // thing a screenshot shows and cannot quantify.
      const centres = await browser.execute((g) => {
        const box = document.querySelector(`[data-testid="task-group-badges-${g}"]`)!;
        return [...box.children].filter((c) => !(c as HTMLElement).dataset.testid?.startsWith("task-group-count")).map((c) => {
          const glyph = (c.querySelector("svg, span") ?? c) as Element;
          const r = glyph.getBoundingClientRect();
          return r.top + r.height / 2;
        });
      }, orch) as number[];
      expect(centres.length).toBe(2);
      expect(Math.abs(centres[0] - centres[1])).toBeLessThanOrEqual(1);
      // ...and the member count stays, so a collapsed group still says how
      // many tasks it holds rather than looking emptied.
      expect(await browser.execute(
        (g) => document.querySelector(`[data-testid="task-group-count-${g}"]`)?.textContent?.trim() ?? null, orch,
      )).toBe("4");
      await snap("task-groups-19-collapsed-marks.png");

      // Navigating to a member (the path every "go to task" takes) opens it.
      await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), child2);
      await browser.waitUntil(async () => (await blockRows(orch)).length === 4, {
        timeout: 5_000, timeoutMsg: "navigating to a member did not expand its group",
      });
      // Collapse again while on that member: its row stays in view.
      await clickWhenVisible(toggle);
      await browser.waitUntil(async () => (await blockRows(orch)).join() === child2, {
        timeout: 5_000, timeoutMsg: "a collapsed group hid the task you are on",
      });
      await snap("task-groups-20-collapsed-keeps-active.png");
    } finally {
      await browser.execute((ids) => {
        const t = window.__termic!;
        const s = t.useApp.getState();
        for (const id of ids.slice(0, 2)) {
          const tab = (s.tabs[id] ?? [])[0];
          if (tab) s.patchTab(id, tab.id, { workState: "idle", unread: null });
        }
        t.useApp.setState({ activeTaskId: null });
        s.setTaskGroupCollapsed(ids[2], false);
      }, [child1, child2, orch]);
    }
  });

  it("a click on the caption toggles it, and a double-click renames without toggling", async () => {
    const header = `[data-testid="task-group-header-${orch}"]`;
    const collapsed = () => browser.execute(
      (g) => !!window.__termic!.useApp.getState().collapsedTaskGroups[g], orch,
    ) as Promise<boolean>;
    // What the browser really sends: a single click, then for a double-click
    // click(detail 1), click(detail 2), dblclick. WebDriver's own double-click
    // does not reach React here (files.e2e.ts), so the sequence is dispatched.
    const fire = (types: [string, number][]) => browser.execute((sel, seq) => {
      const el = document.querySelector(`${sel} [data-testid^="task-group-label-"]`) as HTMLElement;
      const r = el.getBoundingClientRect();
      for (const [type, detail] of seq) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail, clientX: r.left + 4, clientY: r.top + 4 }));
      }
    }, header, types);
    await browser.execute(() => window.__termic!.useApp.setState({ activeTaskId: null }));
    expect(await collapsed()).toBe(false);

    await fire([["click", 1]]);
    await browser.waitUntil(async () => (await blockRows(orch)).length === 0, {
      timeout: 5_000, timeoutMsg: "a click on the caption did not collapse the group",
    });
    await fire([["click", 1]]);
    await browser.waitUntil(async () => (await blockRows(orch)).length === 4, {
      timeout: 5_000, timeoutMsg: "a second click on the caption did not expand it again",
    });

    await fire([["click", 1], ["click", 2], ["dblclick", 2]]);
    const input = `[data-testid="task-group-rename-${orch}"]`;
    await waitVisible(input);
    expect(await collapsed()).toBe(false); // the rename left it as it was
    await browser.keys("Escape");
    await waitGone(input);
    expect((await blockRows(orch)).length).toBe(4);
  });

  it("a filter shows its matches inside a collapsed group, and hides groups with none", async () => {
    const input = `[data-testid="project-filter-input-${fixtureProjectId}"]`;
    const typeFilter = async (v: string) => {
      if (!(await browser.execute((sel) => !!document.querySelector(sel), input))) {
        // Present but opacity-0 until the row is hovered, so visibility is the
    // wrong gate here.
    await clickPresent(`[data-testid="project-filter-toggle-${fixtureProjectId}"]`);
        await waitVisible(input);
      }
      await browser.execute((sel, val) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, input, v);
    };
    await browser.execute(() => window.__termic!.useApp.setState({ activeTaskId: null }));
    await browser.execute((g) => window.__termic!.useApp.getState().setTaskGroupCollapsed(g, true), orch);
    await browser.waitUntil(async () => (await blockRows(orch)).length === 0, { timeout: 5_000 });
    try {
      // A match inside the collapsed group is shown, the rest of it is not,
      // and the caption stays so you can see which group it is in.
      await typeFilter("grp-worker-2");
      await browser.waitUntil(async () => (await blockRows(orch)).join() === child2, {
        timeout: 5_000, timeoutMsg: "a filter match inside a collapsed group stayed hidden",
      });
      // The chevron still says collapsed while the filter shows the match,
      // so it cannot be clicked into a state you do not see.
      const expanded = () => browser.execute(
        (g) => document.querySelector(`[data-testid="task-group-toggle-${g}"]`)?.getAttribute("aria-expanded") ?? null, orch,
      );
      expect(await expanded()).toBe("false");
      await snap("task-groups-21-filter-in-collapsed.png");
      // Nothing in the group matches: no caption for an empty group.
      await typeFilter("grp-loose");
      await waitGone(block(orch));
      expect(await browser.execute((sel) => !!document.querySelector(sel), row(loose))).toBe(true);
    } finally {
      await browser.execute(() => window.__termic!.useUI.setState({ taskFilters: {} }));
      await browser.execute((g) => window.__termic!.useApp.getState().setTaskGroupCollapsed(g, false), orch);
    }
    // Clearing the filter restores the whole group.
    await browser.waitUntil(async () => (await blockRows(orch)).length === 4, { timeout: 5_000 });
  });

  it("--no-group, no $TERMIC_TASK_ID, or a stale id all create an ungrouped task", async () => {
    const optedOut = cliNew("grp-opted-out", orch, ["--no-group"]);
    const noEnv = cliNew("grp-no-env", null);
    const r = await cliRpc({
      cmd: "new", name: "grp-stale-parent", project: "fixture-repo", agent: "fakeagent",
      mode: "main", parent_task: "not-a-task",
    });
    expect(r.ok).toBe(true);
    created.push(r.data.task.id);
    await waitVisible(row(r.data.task.id));
    const disk = await diskGroups();
    for (const id of [optedOut, noEnv, r.data.task.id]) expect(disk[id]).toBeNull();
    expect(await blockRows(orch)).toHaveLength(4);
    await snap("task-groups-04-ungrouped-siblings.png");
  });

  it("lines the caption up with the loose rows, and indents members one folder step", async () => {
    // Measured, not eyeballed: a caption that sits a few px off its sibling
    // rows reads as misaligned long before anyone can say by how much.
    const loose = created[created.length - 1];
    await waitVisible(row(loose));
    const g = await browser.execute((orchId, c1, looseId) => {
      const box = (el: Element | null) => el ? el.getBoundingClientRect() : null;
      const centre = (el: Element | null) => { const r = box(el); return r ? r.left + r.width / 2 : NaN; };
      const rowOf = (id: string) => document.querySelector(`[data-sidebar-task-id="${id}"]`)!;
      const nameOf = (id: string) => [...rowOf(id).querySelectorAll("span")].find(s => s.textContent?.startsWith("grp-"))!;
      const cap = document.querySelector(`[data-testid="task-group-header-${orchId}"]`)!;
      const rail = document.querySelector(`[data-task-group-id="${orchId}"] [data-task-group-rail]`)!;
      return {
        looseChevron: centre(rowOf(looseId).querySelector("svg")),
        capIcon: centre(cap.querySelector("svg")),
        looseName: box(nameOf(looseId))!.left,
        capLabel: box(document.querySelector(`[data-testid="task-group-label-${orchId}"]`))!.left,
        rail: box(rail)!.left + parseFloat(getComputedStyle(rail).borderLeftWidth) / 2,
        looseRow: box(rowOf(looseId))!.left,
        memberRow: box(rowOf(c1))!.left,
      };
    }, orch, child1, loose);
    expect(Math.abs(g.capIcon - g.looseChevron)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.capLabel - g.looseName)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.rail - g.capIcon)).toBeLessThanOrEqual(1);
    expect(Math.round(g.memberRow - g.looseRow)).toBe(18);
    // And the rail is left of the members' rows, never under them.
    expect(g.rail).toBeLessThan(g.memberRow);
  });

  it("an unnamed group follows its lead's rename", async () => {
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRename(id, "grp-lead-renamed");
      await window.__termic!.useApp.getState().loadAll();
    }, orch);
    await browser.waitUntil(async () => (await label(orch)) === "grp-lead-renamed", {
      timeout: 8_000, timeoutMsg: "the group label did not follow the lead task's new name",
    });
  });

  it("renames the group from its header menu", async () => {
    await rightClick(`[data-testid="task-group-header-${orch}"]`);
    await clickInMenu("Rename group");
    const input = `[data-testid="task-group-rename-${orch}"]`;
    await waitVisible(input);
    // Rename looks like the caption it replaces: same font and weight, and
    // the text starts where the label's did (no padding pushes it right).
    const look = await browser.execute((sel, capSel) => {
      const i = document.querySelector(sel) as HTMLInputElement;
      const cap = document.querySelector(capSel)!;
      const cs = getComputedStyle(i), capCs = getComputedStyle(cap);
      return {
        size: [cs.fontSize, capCs.fontSize], weight: [cs.fontWeight, capCs.fontWeight],
        padLeft: cs.paddingLeft, border: cs.borderLeftWidth,
        capHeight: cap.getBoundingClientRect().height,
      };
    }, input, `[data-testid="task-group-header-${orch}"]`);
    expect(look.size[0]).toBe(look.size[1]);
    expect(look.weight[0]).toBe(look.weight[1]);
    expect(look.padLeft).toBe("0px");
    expect(look.border).toBe("0px");
    await snap("task-groups-05-renaming.png");
    await setInputValue(input, "Auth refactor");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await label(orch)) === "Auth refactor", {
      timeout: 8_000, timeoutMsg: "the header never showed the new group name",
    });
    const disk = await diskGroups();
    for (const id of [orch, child1, child2, grandchild]) expect(disk[id]?.name).toBe("Auth refactor");
    // Renaming the lead no longer moves a NAMED group.
    await browser.execute(async (id) => {
      await window.__termic!.ipc.taskRename(id, "grp-orchestrator");
      await window.__termic!.useApp.getState().loadAll();
    }, orch);
    expect(await label(orch)).toBe("Auth refactor");
    await snap("task-groups-06-renamed.png");
  });

  it("recolours the group from the swatch row", async () => {
    const before = (await diskGroups())[orch]?.color;
    const pick = before === "teal" ? "purple" : "teal";
    await rightClick(`[data-testid="task-group-header-${orch}"]`);
    await snap("task-groups-07-header-menu.png");
    await clickInMenu(pick === "teal" ? "Teal" : "Purple");
    await browser.waitUntil(() => railMatches(orch, pick), {
      timeout: 8_000, timeoutMsg: `the rail never repainted ${pick}`,
    });
    const disk = await diskGroups();
    for (const id of [orch, child1, child2, grandchild]) expect(disk[id]?.color).toBe(pick);
    await dismissOverlays();
    await snap("task-groups-08-recoloured.png");
  });

  it("the orchestrator's agent names its group with `termic group`", async () => {
    // Run exactly as the agent inside the orchestrator would: no task
    // argument, $TERMIC_TASK_ID says whose group.
    const env = { TERMIC_DATA_DIR: dataDir, TERMIC_TASK_ID: orch };
    // The CLI tells the agent where it is and that this exists, before it
    // ever runs the verb: `help --json` overview and the top of `--help`.
    const surface = JSON.parse(runCli(["help", "--json"], env));
    expect(surface.overview).toContain("INSIDE a Termic task");
    expect(surface.overview).toContain("group --name");
    expect(runCli(["--help"], env)).toContain("group --name");
    const shown = JSON.parse(runCli(["--no-launch", "--json", "group"], env));
    expect(shown.group.id).toBe(orch);
    expect(shown.group.name).toBe("Auth refactor");
    expect(shown.group.members.length).toBe(4);

    runCli(["--no-launch", "group", "--name", "Named by the agent"], env);
    await browser.waitUntil(async () => (await label(orch)) === "Named by the agent", {
      timeout: 8_000, timeoutMsg: "the caption never showed the name the agent set",
    });
    // "" goes back to following the lead's name.
    const followed = JSON.parse(runCli(["--no-launch", "--json", "group", "--name", ""], env));
    expect(followed.group.named).toBe(false);
    expect(followed.group.name).toBe("grp-orchestrator");
    await browser.waitUntil(async () => (await label(orch)) === "grp-orchestrator", { timeout: 8_000 });
    // A typo is refused naming the choices, and changes nothing.
    expect(() => runCli(["--no-launch", "group", "--color", "mauve"], env)).toThrow(/teal/);
    // Put the name back for the cases below.
    runCli(["--no-launch", "group", "--name", "Auth refactor"], env);
    await browser.waitUntil(async () => (await label(orch)) === "Auth refactor", { timeout: 8_000 });

    // `new` tells the agent which group the task joined, in plain text too.
    const out = runCli([
      "--no-launch", "new", "grp-told", "--agent", "fakeagent", "--project", "fixture-repo", "--main",
    ], env);
    expect(out).toMatch(/group:\s+Auth refactor/);
    const told = await browser.execute(
      () => window.__termic!.useApp.getState().tasks.find((t: any) => t.name === "grp-told")?.id as string,
    );
    await archiveTask(told);
  });

  it("dragging an outside task into the block joins it", async () => {
    await waitVisible(row(loose));
    await pointerDrag(row(loose), row(child2), { land: "center" });
    await browser.waitUntil(async () => (await blockRows(orch)).includes(loose), {
      timeout: 8_000, timeoutMsg: "the dropped task was not drawn inside the block",
    });
    await browser.waitUntil(async () => (await diskGroups())[loose]?.id === orch, {
      timeout: 8_000, timeoutMsg: "the join never reached the task file",
    });
    const disk = await diskGroups();
    expect(disk[loose]?.name).toBe("Auth refactor");
    await snap("task-groups-09-dragged-in.png");
  });

  it("dragging a member out of the block leaves the group", async () => {
    // The stale-parent task sits below the block; land on it.
    const outside = created[created.length - 1];
    await waitVisible(row(outside));
    await pointerDrag(row(loose), row(outside), { land: "bottom" });
    await browser.waitUntil(async () => !(await blockRows(orch)).includes(loose), {
      timeout: 8_000, timeoutMsg: "the dragged-out task was still drawn inside the block",
    });
    await browser.waitUntil(async () => (await diskGroups())[loose] === null, {
      timeout: 8_000, timeoutMsg: "the leave never reached the task file",
    });
    // The rest of the group is untouched.
    expect(await blockRows(orch)).toEqual([orch, child1, child2, grandchild]);
    await snap("task-groups-10-dragged-out.png");
  });

  /** Open a task row's menu, then its Move to group submenu. */
  const openMoveToGroup = async (id: string) => {
    await rightClick(row(id));
    await clickWhenVisible(`[data-testid="task-move-to-group-${id}"]`);
    await waitVisible(`[data-testid="task-new-group-${id}"]`);
  };

  it("Remove from group takes one task out, and a lone lead keeps its group", async () => {
    for (const id of [grandchild, child2, child1]) {
      await openMoveToGroup(id);
      if (id === child1) await snap("task-groups-11-move-to-group-menu.png");
      await clickWhenVisible(`[data-testid="task-leave-group-${id}"]`);
      await browser.waitUntil(async () => !(await blockRows(orch)).includes(id), {
        timeout: 8_000, timeoutMsg: `${id} was still drawn in the block after Remove from group`,
      });
    }
    // Like a project folder of one: the orchestrator alone is still a group.
    expect(await blockRows(orch)).toEqual([orch]);
    const disk = await diskGroups();
    expect(disk[orch]?.id).toBe(orch);
    for (const id of [child1, child2, grandchild]) expect(disk[id]).toBeNull();
    await snap("task-groups-12-lone-lead.png");
  });

  let manualGid: string;
  it("New group makes a group of one and asks for its name", async () => {
    await openMoveToGroup(child1);
    await clickWhenVisible(`[data-testid="task-new-group-${child1}"]`);
    // The caption opens its rename straight away, like a new project folder.
    manualGid = child1;
    const input = `[data-testid="task-group-rename-${manualGid}"]`;
    await waitVisible(input);
    // The whole name is selected, so typing replaces it.
    await browser.waitUntil(() => browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      return !!el && el.value.length > 0 && el.selectionStart === 0 && el.selectionEnd === el.value.length;
    }, input), { timeout: 5_000, timeoutMsg: "a new group's name was not selected for renaming" });
    await setInputValue(input, "Hand-made");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await label(manualGid)) === "Hand-made", {
      timeout: 8_000, timeoutMsg: "the new group never showed its typed name",
    });
    expect(await blockRows(manualGid)).toEqual([child1]);
    const disk = await diskGroups();
    expect(disk[child1]).toMatchObject({ id: child1, name: "Hand-made" });
    // It took a colour no other live group wears.
    expect(disk[child1]?.color).toBeTruthy();
    expect(disk[child1]?.color).not.toBe(disk[orch]?.color);
    await snap("task-groups-13-new-group.png");
  });

  it("Move to group lists both groups and moves a task into the chosen one", async () => {
    await openMoveToGroup(child2);
    for (const g of [orch, manualGid]) await waitVisible(`[data-testid="task-move-to-group-${child2}-${g}"]`);
    await snap("task-groups-14-move-menu-two-groups.png");
    await clickWhenVisible(`[data-testid="task-move-to-group-${child2}-${manualGid}"]`);
    await browser.waitUntil(async () => (await blockRows(manualGid)).join() === [child1, child2].join(), {
      timeout: 8_000, timeoutMsg: "the task was not drawn inside the group it was moved to",
    });
    const disk = await diskGroups();
    expect(disk[child2]).toEqual(disk[child1]);
    // Moving it again, into the orchestrator's group, leaves the hand-made
    // one with its first member.
    await openMoveToGroup(child2);
    await clickWhenVisible(`[data-testid="task-move-to-group-${child2}-${orch}"]`);
    await browser.waitUntil(async () => (await blockRows(orch)).includes(child2), {
      timeout: 8_000, timeoutMsg: "the second move never landed",
    });
    expect(await blockRows(manualGid)).toEqual([child1]);
    await dismissOverlays();
    await snap("task-groups-15-moved.png");
  });

  /** The project's top-level rows as the sidebar DRAWS them: a group block
   *  collapses to `[member,member]`, a loose row is its id. */
  const drawnTopLevel = () =>
    browser.execute((p) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-task-group-id], [data-sidebar-task-id]")) {
        if (el.dataset.taskGroupId !== undefined) {
          if (el.dataset.taskGroupProjectId !== p) continue;
          const ids = [...el.querySelectorAll<HTMLElement>("[data-sidebar-task-id]")].map(r => r.dataset.sidebarTaskId);
          out.push(`[${ids.join(",")}]`);
        } else if (el.dataset.sidebarTaskProjectId === p && !el.closest("[data-task-group-id]")) {
          out.push(el.dataset.sidebarTaskId!);
        }
      }
      return out;
    }, fixtureProjectId) as Promise<string[]>;
  const diskOrder = () =>
    browser.execute(async (p) => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return all.filter(t => t.project_id === p && !t.archived).map(t => t.id as string);
    }, fixtureProjectId) as unknown as Promise<string[]>;

  it("dragging a group's caption moves the whole block", async () => {
    const hand = `[${child1}]`, auth = `[${orch},${child2}]`;
    let top = await drawnTopLevel();
    expect(top.indexOf(auth)).toBeLessThan(top.indexOf(hand));

    // Hand-made above Auth refactor: land on the top half of its caption.
    await pointerDrag(`[data-testid="task-group-header-${manualGid}"]`, `[data-testid="task-group-header-${orch}"]`, { land: "top" });
    await browser.waitUntil(async () => {
      const o = await drawnTopLevel();
      return o.indexOf(hand) >= 0 && o.indexOf(hand) < o.indexOf(auth);
    }, { timeout: 8_000, timeoutMsg: "the dragged block never moved above the other group" });
    // Both blocks are still whole: the drag moved members as one run.
    top = await drawnTopLevel();
    expect(top).toContain(auth);
    expect(top).toContain(hand);
    await snap("task-groups-16-block-dragged.png");

    // Persisted in the order the user sees, members adjacent.
    await browser.waitUntil(async () => {
      const d = await diskOrder();
      return d.indexOf(child1) < d.indexOf(orch) && d.indexOf(child2) === d.indexOf(orch) + 1;
    }, { timeout: 8_000, timeoutMsg: "the block order never reached the task files" });

    // And past a loose row: drop Auth refactor below the last ungrouped task.
    const lastLoose = top.filter(x => !x.startsWith("[")).pop()!;
    await pointerDrag(`[data-testid="task-group-header-${orch}"]`, `[data-sidebar-task-id="${lastLoose}"]`, { land: "bottom" });
    await browser.waitUntil(async () => {
      const o = await drawnTopLevel();
      return o.indexOf(auth) > o.indexOf(lastLoose);
    }, { timeout: 8_000, timeoutMsg: "the block never moved below the loose row" });
    // Grouping itself is untouched by moving the block.
    const disk = await diskGroups();
    expect(disk[orch]?.id).toBe(orch);
    expect(disk[child2]?.id).toBe(orch);
    expect(disk[child1]?.id).toBe(manualGid);
    await snap("task-groups-17-block-below-loose.png");
  });

  it("Ungroup tasks clears every member at once", async () => {
    await rightClick(`[data-testid="task-group-header-${orch}"]`);
    await clickInMenu("Ungroup tasks");
    await waitGone(block(orch));
    await rightClick(`[data-testid="task-group-header-${manualGid}"]`);
    await clickInMenu("Ungroup tasks");
    await waitGone(block(manualGid));
    const disk = await diskGroups();
    for (const id of [orch, child1, child2]) expect(disk[id]).toBeNull();
    await dismissOverlays();
    await snap("task-groups-18-ungrouped.png");
  });
});

// A task an agent creates carries `spawned_by`. In the agent's own project it
// also joins the agent's group; in ANOTHER project it joins none (the sidebar
// is split by project, so a group spanning two drew as two unrelated groups
// of one), and the link shows as a mark on the child and as lines on hover.
describe("spawn links across projects", () => {
  let fixtureProjectId: string;
  let orch: string;
  let loose: string;
  let otherDir: string | undefined;
  let otherProjectId: string | undefined;
  let otherProjectName: string;
  const created: string[] = [];

  const row = (id: string) => `[data-sidebar-task-id="${id}"]`;
  const mark = (id: string) => `[data-testid="task-spawned-from-${id}"]`;
  const disk = () =>
    browser.execute(async () => {
      const all: any[] = await window.__termic!.ipc.tasksList();
      return Object.fromEntries(all.map(t => [t.id, { group: t.group?.id ?? null, spawnedBy: t.spawned_by ?? null }]));
    }) as unknown as Promise<Record<string, { group: string | null; spawnedBy: string | null }>>;
  /** `termic new` as an agent inside `parent` runs it, into `project`. */
  const cliNew = (name: string, parent: string, project: string) => {
    const out = JSON.parse(runCli([
      "--no-launch", "--json", "new", name,
      "--agent", "fakeagent", "--project", project, "--main",
    ], { TERMIC_DATA_DIR: dataDir, TERMIC_TASK_ID: parent }));
    created.push(out.task.id);
    return out.task as { id: string; spawned_by?: string; group?: unknown };
  };
  /** Hover a row the way the overlay hears it: a bubbling pointerover from
   *  inside the row, no button held. (A WebDriver move does not reliably
   *  deliver pointer events to the list in this WKWebView.) */
  const hover = (id: string | null) =>
    browser.execute((sel) => {
      const list = document.querySelector("[data-sidebar-task-id]")!.closest(".overflow-y-auto")!;
      if (!sel) { list.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false })); return; }
      document.querySelector(sel)!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, buttons: 0 }));
    }, id ? row(id) : null);
  const drawnLinks = () =>
    browser.execute(() =>
      [...document.querySelectorAll<SVGGElement>("[data-spawn-link]")].map(g => g.dataset.spawnLink!).sort(),
    ) as Promise<string[]>;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    orch = await openTask("spawn-orchestrator", false);
    loose = await openTask("spawn-loose", false);
    created.push(orch, loose);
    fixtureProjectId = await browser.execute(
      (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)!.project_id as string,
      orch,
    );
    otherDir = mkdtempSync(path.join(os.tmpdir(), "e2e-spawnlink-"));
    execSync(
      `git -C "${otherDir}" init -q && git -C "${otherDir}" -c user.email=e2e@termic.dev -c user.name=e2e commit -q --allow-empty -m init`,
    );
    const proj = await browser.execute(async (dir) => {
      const p: any = await window.__termic!.ipc.projectAdd(dir);
      await window.__termic!.useApp.getState().loadAll();
      return { id: p.id as string, name: p.name as string };
    }, otherDir) as unknown as { id: string; name: string };
    otherProjectId = proj.id;
    otherProjectName = proj.name;
    await browser.execute((a, b) => {
      const s = window.__termic!.useApp.getState();
      s.setProjectCollapsed(a, false);
      s.setProjectCollapsed(b, false);
    }, fixtureProjectId, otherProjectId);
    await dismissOverlays();
  });

  after(async () => {
    await hover(null).catch(() => {});
    for (const id of created) await archiveTask(id);
    if (otherProjectId) {
      await browser.execute(async (id) => {
        await window.__termic!.ipc.projectRemove(id);
        await window.__termic!.useApp.getState().loadAll();
      }, otherProjectId);
    }
    if (otherDir) rmTree(otherDir, { bestEffort: true });
  });

  let far: string;
  let near: string;

  it("a task spawned into another project is linked, not grouped", async () => {
    const t = cliNew("spawn-far-worker", orch, otherProjectName);
    far = t.id;
    // The CLI reports the link (as project/name), and no group.
    expect(t.spawned_by).toBe("fixture-repo/spawn-orchestrator");
    expect(t.group).toBeUndefined();
    await waitVisible(row(far));
    const d = await disk();
    expect(d[far]).toEqual({ group: null, spawnedBy: orch });
    expect(d[orch].group).toBeNull(); // the lead did not found a group of one either
    const blocks = await browser.execute(
      (a, b) => document.querySelectorAll(`[data-task-group-id="${a}"], [data-task-group-id="${b}"]`).length,
      orch, far,
    );
    expect(blocks).toBe(0);
    await snap("spawn-links-01-cross-project.png");
  });

  it("marks the child with its parent, and the mark goes there", async () => {
    await waitVisible(mark(far));
    const title = await browser.execute((s) => document.querySelector(s)!.getAttribute("title"), mark(far));
    expect(title).toContain("spawn-orchestrator (fixture-repo)");
    // The parent row carries no mark: it was not spawned.
    expect(await browser.execute((s) => !!document.querySelector(s), mark(orch))).toBe(false);
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), mark(far));
    await browser.waitUntil(
      () => browser.execute((id) => window.__termic!.useApp.getState().activeTaskId === id, orch),
      { timeout: 5_000, timeoutMsg: "clicking the mark did not go to the parent" },
    );
  });

  it("a task spawned in the same project joins the group and draws no mark", async () => {
    near = cliNew("spawn-near-worker", orch, "fixture-repo").id;
    await waitVisible(`[data-task-group-id="${orch}"] ${row(near)}`);
    const d = await disk();
    expect(d[near]).toEqual({ group: orch, spawnedBy: orch });
    // The rail already says it, but only once the PARENT is in the group too:
    // it joins when this first child does, and until the store has that, the
    // two do not share a block and the mark is briefly correct.
    //
    // So wait for that precondition explicitly rather than waiting out the
    // mark and hoping. Waiting only on the mark made this a race with however
    // long the parent's join took, which on the Linux runner lost, and then
    // reported "a same-group child kept its started-by mark" about a child
    // that was right and a parent that was late.
    await browser.waitUntil(
      async () => (await browser.execute(
        (id) => window.__termic!.useApp.getState().tasks
          .find((t: any) => t.id === id)?.group?.id ?? null,
        orch,
      )) === orch,
      { timeout: 10_000, timeoutMsg: "the parent never joined the group its child founded" },
    );
    await browser.waitUntil(
      () => browser.execute((s) => !document.querySelector(s), mark(near)),
      { timeout: 5_000, timeoutMsg: "a same-group child kept its started-by mark" },
    );
  });

  it("hovering a task draws lines to its parent and the tasks it spawned, and only then", async () => {
    expect(await drawnLinks()).toEqual([]);
    await hover(orch);
    await browser.waitUntil(async () => (await drawnLinks()).length > 0, {
      timeout: 5_000, timeoutMsg: "hovering the orchestrator drew no line to its worker elsewhere",
    });
    // Only the cross-project worker: `near` shares the orchestrator's group,
    // whose rail already links them.
    expect(await drawnLinks()).toEqual([`${orch}>${far}`]);
    await snap("spawn-links-02-hover-parent.png");
    // From the child, one line up.
    await hover(far);
    await browser.waitUntil(async () => (await drawnLinks()).join() === `${orch}>${far}`, {
      timeout: 5_000, timeoutMsg: "hovering the child did not draw the line to its parent",
    });
    // Each line ends on the child's row: measure, do not trust the path.
    const ends = await browser.execute((childSel) => {
      const svg = document.querySelector("[data-testid='spawn-links']")!;
      const dot = svg.querySelector("circle")!.getBoundingClientRect();
      const r = document.querySelector(childSel)!.getBoundingClientRect();
      return { dy: Math.abs((dot.top + dot.height / 2) - (r.top + r.height / 2)), dx: Math.abs((dot.left + dot.width / 2) - r.left) };
    }, row(far));
    expect(ends.dy).toBeLessThan(1.5);
    expect(ends.dx).toBeLessThan(1.5);
    // An unlinked task draws nothing, and leaving the list clears it.
    await hover(loose);
    await browser.waitUntil(async () => (await drawnLinks()).length === 0, { timeout: 5_000 });
    await hover(near);
    // A negative: an unlinked task draws nothing, and nothing is not an event
    // to wait for. Long enough that a wrong link would have been drawn.
    await browser.pause(300);
    expect(await drawnLinks()).toEqual([]);
    await hover(far);
    await browser.waitUntil(async () => (await drawnLinks()).length === 1, { timeout: 5_000 });
    await hover(null);
    await browser.waitUntil(async () => (await drawnLinks()).length === 0, {
      timeout: 5_000, timeoutMsg: "the lines outlived the hover",
    });
  });

  it("the dashboard's flat rows mark every spawned child, grouped or not", async () => {
    // Real click, the way the user gets there (app.e2e.ts's nav case). The
    // dashboard draws no group rail, so its rule is the sidebar's inverted:
    // every spawned child is marked, `near` included — the pair the sidebar
    // suppresses because its rail already says it.
    await clickByText("Dashboard");
    await waitForText("HOME FOR YOUR CLI CODING AGENTS");
    // Scoped through `data-dashboard-task-id` for the same reason as
    // `dashboardBadge()`: the sidebar row for the same task renders the same
    // `task-spawned-from-*` testid, and a bare query returns whichever came
    // first in document order.
    const dashMark = (id: string) =>
      `[data-dashboard-task-id="${id}"] [data-testid="task-spawned-from-${id}"]`;
    await waitVisible(dashMark(far));
    const title = await browser.execute((s) => document.querySelector(s)!.getAttribute("title"), dashMark(far));
    expect(title).toContain("Started by spawn-orchestrator (fixture-repo)");
    // Same project, same group: the sidebar draws no mark here; the dashboard does.
    await waitVisible(dashMark(near));
    // Captured on the dashboard itself: the snap after the click would show
    // the task view the click navigates to.
    await snap("spawn-links-03-dashboard.png");
    // The mark is a way to the parent from here too.
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), dashMark(far));
    await browser.waitUntil(
      () => browser.execute((id) => window.__termic!.useApp.getState().activeTaskId === id, orch),
      { timeout: 5_000, timeoutMsg: "clicking the dashboard mark did not go to the parent" },
    );
  });

  it("a group left spanning projects by an older build draws as plain rows", async () => {
    // Store-driven on purpose: Rust now refuses to write such a group, and
    // this is how the sidebar draws the ones already on disk.
    await browser.execute((a, b) => {
      const s = window.__termic!.useApp;
      s.setState({
        tasks: s.getState().tasks.map((t: any) =>
          t.id === a || t.id === b ? { ...t, group: { id: "legacy-span" } } : t),
      });
    }, loose, far);
    try {
      await browser.waitUntil(
        () => browser.execute(() => !document.querySelector('[data-task-group-id="legacy-span"]')),
        { timeout: 5_000, timeoutMsg: "a cross-project group of one was still drawn as a block" },
      );
      await waitVisible(row(loose));
      await waitVisible(mark(far));
    } finally {
      await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    }
  });
});

// Focusing a task looks up its PR (store/pr.ts initPrRefreshOnFocus), which
// is what discovers a PR its agent opened from the terminal. The fixture's
// remote is a local bare repo, so the lookup answers "not a forge" rather
// than finding a PR; the case asserts the LOOKUP ran on focus, the thing that
// was missing. The other triggers (agent spawn, the Git tab's card) are kept
// out of the way first, or they would pass this without the fix.
describe("PR lookup on task focus", () => {
  let wt: string | undefined;
  let main: string | undefined;
  after(async () => {
    for (const id of [wt, main].filter(Boolean) as string[]) await archiveTask(id);
  });

  const fetchedAt = (id: string) =>
    browser.execute((t) => window.__termic!.usePr.getState().byTask[t]?.fetchedAt ?? 0, id) as Promise<number>;

  it("runs a lookup when a worktree task becomes active, and never for a main checkout", async () => {
    await waitForAppShell();
    await requireTermicApi();
    const r = await cliRpc({ cmd: "new", name: `pr-focus-${Date.now()}`, project: "fixture-repo", agent: "fakeagent", mode: "worktree" });
    expect(r.ok).toBe(true);
    wt = r.data.task.id;
    main = await openTask("pr-focus-main", false);
    // Let the spawn-time lookup land, then forget it: what follows must come
    // from the focus alone.
    await waitForAgentReady(wt!);
    await browser.waitUntil(async () => !(await browser.execute(
      (t) => !!window.__termic!.usePr.getState().byTask[t]?.loading, wt!)), { timeout: 15_000 });
    await browser.execute((ids) => {
      const t = window.__termic!;
      const by = { ...t.usePr.getState().byTask };
      for (const id of ids) delete by[id];
      t.usePr.setState({ byTask: by });
      t.useApp.setState({ activeTaskId: null });
    }, [wt!, main]);

    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), wt!);
    await browser.waitUntil(async () => (await fetchedAt(wt!)) > 0, {
      timeout: 15_000, timeoutMsg: "focusing a worktree task did not look up its PR",
    });
    // The Git tab was never on screen, so this was the focus trigger.
    expect(await browser.execute(
      () => document.querySelector('[data-testid="right-tab"][data-tab="Git"][aria-selected="true"]') !== null,
    )).toBe(false);

    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), main);
    // Give a wrongly-fired lookup the time the one above took, then check.
    await browser.waitUntil(async () => (await browser.execute(
      (id) => window.__termic!.useApp.getState().activeTaskId === id, main)), { timeout: 5_000 });
    expect(await fetchedAt(main)).toBe(0);
  });
});

// Extra named ports (GH #196): tasks created after the project declares
// port names freeze consecutive name→port pairs from their own block, and
// two live tasks' blocks never overlap. Asserted on the task records:
// ports have no DOM surface (the env vars land inside the PTY), and the
// PTY spawn is rAF-gated on occluded CI windows (see run.e2e.ts).
describe("extra named ports allocation", () => {
  let projectId: string;
  const created: string[] = [];

  const setPorts = (names: string[]) =>
    browser.execute(async (id, list) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((x: any) => x.id === id);
      await t.ipc.projectUpdate({ ...p, extra_named_ports: list });
      await t.useApp.getState().loadAll();
    }, projectId, names);
  const taskById = (id: string) =>
    browser.execute(
      (tid) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === tid),
      id,
    );

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    projectId = await browser.execute(() =>
      window.__termic!.useApp.getState()
        .projects.find((p: any) => p.name === "fixture-repo").id as string,
    );
    await setPorts(["API_PORT", "DB_PORT"]);
  });

  after(async () => {
    for (const id of created) await archiveTask(id);
    await setPorts([]);
  });

  it("freezes consecutive named ports from the task's block", async () => {
    const id = await openTask("e2e-ports-a");
    created.push(id);
    const task: any = await taskById(id);
    // Single-repo task block: base ($TERMIC_PORT), extras at base+1, base+2.
    expect(task.extra_named_ports).toEqual([
      { name: "API_PORT", port: task.port + 1 },
      { name: "DB_PORT",  port: task.port + 2 },
    ]);
  });

  it("gives a second live task a non-overlapping block", async () => {
    const id = await openTask("e2e-ports-b");
    created.push(id);
    const a: any = await taskById(created[0]);
    const b: any = await taskById(id);
    // Block = 1 base + 2 extras + 5 buffer = 8 ports; the later base must
    // clear the earlier block entirely (either side).
    const BLOCK = 8;
    const clear = b.port >= a.port + BLOCK || a.port >= b.port + BLOCK;
    expect(clear).toBe(true);
    // And b's own pairs stay inside b's block, consecutive after its base.
    expect(b.extra_named_ports.map((np: any) => np.port)).toEqual([b.port + 1, b.port + 2]);
  });

  it("leaves a task created after the config is cleared without extra ports", async () => {
    await setPorts([]);
    const id = await openTask("e2e-ports-none");
    created.push(id);
    const task: any = await taskById(id);
    expect(task.extra_named_ports).toEqual([]);
  });

  // On-the-fly top-up: names configured AFTER a task exists reach it on
  // its next spawn via task_ensure_extra_ports (the command every tab
  // spawn calls). Asserted through the command + record because the env
  // itself lives inside the PTY (no DOM) and PTY spawn is rAF-gated on
  // occluded CI windows (see run.e2e.ts).
  it("tops up an existing task with newly configured names on spawn", async () => {
    const id = created[2]; // the extras-free task from the previous case
    await setPorts(["LATE_PORT"]);
    const fresh: any = await browser.execute(
      (tid) => window.__termic!.invoke("task_ensure_extra_ports", { id: tid }),
      id,
    );
    // The new name lands in the task's own buffer (base+1 for a
    // single-repo task with no prior extras) and persists on the record.
    expect(fresh.extra_named_ports).toEqual([{ name: "LATE_PORT", port: fresh.port + 1 }]);
    await browser.execute(() => window.__termic!.useApp.getState().loadAll());
    const stored: any = await taskById(id);
    expect(stored.extra_named_ports).toEqual([{ name: "LATE_PORT", port: stored.port + 1 }]);
    await setPorts([]);
  });
});

// P1: "Copy agent CLI briefing" on the task menu — the paste-into-another-agent
// CLI block that lets two agents drive each other (src/lib/agentBriefing.ts).
// Cases: the item is reachable from the right-click menu; running it actually
// reaches the clipboard; the command palette offers the same action.
//
// The BLOCK'S CONTENT is pinned by src/lib/agentBriefing.test.ts, not here:
// the webview holds `clipboard-manager:allow-write-text` and no read
// permission, so the success toast is the only observable proof the write
// happened, and it only fires after writeText resolves.
describe("copy agent briefing", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().closeCommandPalette?.();
      window.__termic!.useUI.setState({ toasts: [] });
    });
    await dismissOverlays();
    if (taskId) await archiveTask(taskId);
  });

  // Right-click the task header row: it opens the same menu as the kebab,
  // and unlike the kebab it is not gated on a hover-only pointer-events flip.
  const openTaskMenu = (id: string) =>
    browser.execute((i) => {
      const row = document.querySelector(`[data-sidebar-task-id="${i}"]`);
      if (!row) throw new Error(`no sidebar row for task ${i}`);
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    }, id);

  const menuLabels = () =>
    browser.execute(() =>
      [...document.querySelectorAll("[role='menuitem']")].map(
        (e) => e.textContent?.trim() ?? "",
      ),
    );

  const toasts = () =>
    browser.execute(() =>
      window.__termic!.useUI.getState().toasts.map((t: any) => `${t.kind}:${t.msg}`),
    );

  const clearToasts = () =>
    browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));

  const waitForCopyToast = async (what: string) => {
    await browser.waitUntil(
      async () => (await toasts()).includes("success:Copied agent CLI briefing"),
      {
        timeout: 8_000,
        timeoutMsg: `${what}: clipboard write never confirmed`,
      },
    );
  };

  it("offers the briefing on the task's right-click menu", async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    taskId = await openTask("e2e-briefing");
    await ensureActiveTask(taskId);

    await openTaskMenu(taskId);
    await browser.waitUntil(
      async () => (await menuLabels()).includes("Copy agent CLI briefing"),
      { timeout: 8_000, timeoutMsg: "task menu never offered Copy agent CLI briefing" },
    );
    const labels = await menuLabels();
    // Sits in the copy/edit block, not off in the archive block.
    expect(labels.indexOf("Copy agent CLI briefing")).toBeGreaterThan(
      labels.indexOf("Rename"),
    );
    expect(labels.indexOf("Copy agent CLI briefing")).toBeLessThan(
      labels.indexOf("Archive task"),
    );
  });

  it("running it writes to the clipboard", async () => {
    await clearToasts();
    await clickMenuItem("Copy agent CLI briefing");
    await waitForCopyToast("task menu");
    // What the user actually pastes: one block, tagged with THIS task, the
    // command addressing it by id and signed with its identity.
    const pasted = readClipboard();
    expect(pasted.startsWith(`<termic-task id="${taskId}" `)).toBe(true);
    expect(pasted.trimEnd().endsWith("</termic-task>")).toBe(true);
    expect(pasted).toContain(` send ${taskId} -p "[message from agent:<you> task:$TERMIC_TASK id:$TERMIC_TASK_ID]`);
    await dismissOverlays();
    await clearToasts();
  });

  // Second surface for the same action: the palette is how it is reached
  // without hunting for the row (CommandPalette.tsx).
  it("the command palette offers the same action", async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().openCommandPalette(),
    );
    await waitVisible('input[placeholder*="Type a command"]', 8_000);
    await browser.execute(() => {
      const input = document.querySelector(
        'input[placeholder*="Type a command"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "agent CLI briefing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector('[data-cmd-id="copy-agent-briefing"]'),
        ),
      { timeout: 8_000, timeoutMsg: "palette never listed copy-agent-briefing" },
    );
    await clearToasts();
    await browser.execute(() =>
      (
        document.querySelector(
          '[data-cmd-id="copy-agent-briefing"]',
        ) as HTMLElement
      ).click(),
    );
    await waitForCopyToast("command palette");
    await clearToasts();
  });
});

// P1: labelling a task by its branch (GH #260). An opt-in pref swaps the title
// typed at creation for the task's branch wherever a task is named. Both
// directions matter: turning it on has to actually change the sidebar row and
// the breadcrumb, and turning it back off has to restore the typed name, which
// is never overwritten. The pref is app-wide and shared with every later spec,
// so this restores it whatever happens.
describe("branch as the task name (GH #260)", () => {
  const REPO = path.join(process.cwd(), ".e2e", "fixture-repo");
  const NAME = "e2e-branch-label";
  const BRANCH = "wt-branch-label";
  let taskId = "";
  let original = false;

  /** Visible text of the task's sidebar row, minus the terminal count. */
  const rowText = (id: string) =>
    browser.execute(
      (i) => document.querySelector(`[data-sidebar-task-id="${i}"]`)?.textContent ?? "",
      id,
    );

  const setPref = (v: boolean) =>
    browser.execute((on) => {
      window.__termic!.usePrefs.getState().setUseBranchAsTaskName(on);
    }, v);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await browser.execute(
      () => window.__termic!.usePrefs.getState().useBranchAsTaskName,
    );
    taskId = await browser.execute(async (n, b) => {
      const t = window.__termic!;
      const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      const task = await t.ipc.taskCreate({
        project_id: proj.id, name: n, cli: "fakeagent", base_branch: "main", branch: b,
      });
      await t.useApp.getState().loadAll();
      t.useApp.getState().setActiveTask((task as any).id);
      return (task as any).id as string;
    }, NAME, BRANCH);
  });

  after(async () => {
    await setPref(original);
    if (taskId) await archiveTask(taskId);
    try { execSync(`git -C "${REPO}" worktree prune`); } catch { /* nothing to prune */ }
    try { execSync(`git -C "${REPO}" branch -D ${BRANCH}`, { stdio: "ignore" }); } catch { /* already gone */ }
  });

  it("shows the typed name while the pref is off", async () => {
    await setPref(false);
    await browser.waitUntil(async () => (await rowText(taskId)).includes(NAME), {
      timeout: 8_000,
      timeoutMsg: "the task row never showed its typed name",
    });
    expect(await rowText(taskId)).not.toContain(BRANCH);
  });

  it("swaps the row and the breadcrumb to the branch once it is on", async () => {
    await setPref(true);
    await browser.waitUntil(async () => (await rowText(taskId)).includes(BRANCH), {
      timeout: 8_000,
      timeoutMsg: "the task row never switched to the branch",
    });
    // The typed name is replaced, not appended: the point of the setting is
    // that the branch IS the identifier, and a row showing both is #73.
    expect(await rowText(taskId)).not.toContain(NAME);

    // Breadcrumb too, and only once: it used to read "<name> on <branch>", so
    // the branch label has to collapse that clause rather than say it twice.
    await ensureActiveTask(taskId);
    const crumb = await browser.execute(
      () => document.querySelector('[data-testid="task-breadcrumb"]')?.textContent ?? "",
    );
    expect(crumb).toContain(BRANCH);
    expect(crumb).not.toContain(NAME);
    expect(crumb.split(BRANCH).length - 1).toBe(1);
    await snap("branch-as-task-name.png");
  });

  it("leaves a main-checkout task on its typed name", async () => {
    // "Run in repo" tasks DO carry a branch (task_open_repo re-reads HEAD),
    // so this is a deliberate exclusion, not a fallback that happens to fire:
    // that branch is the shared checkout's, identical in every project.
    const repoRootId = await openTask("e2e-branch-label-repo-root");
    try {
      await setPref(true);
      await browser.waitUntil(
        async () => (await rowText(repoRootId)).includes("e2e-branch-label-repo-root"),
        { timeout: 8_000, timeoutMsg: "the repo-root row never showed its typed name" },
      );
      // It really does have a branch to have been tempted by.
      expect(
        await browser.execute(
          (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.branch,
          repoRootId,
        ),
      ).toBeTruthy();
    } finally {
      await archiveTask(repoRootId);
    }
  });

  it("keeps the typed name, so turning it back off restores the row", async () => {
    // The record is untouched: the pref is a display choice, and a rename
    // still edits the name this asserts.
    expect(
      await browser.execute(
        (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.name,
        taskId,
      ),
    ).toBe(NAME);

    await setPref(false);
    await browser.waitUntil(async () => (await rowText(taskId)).includes(NAME), {
      timeout: 8_000,
      timeoutMsg: "the typed name never came back",
    });
  });
});

// P1: the title bar's "open with" picker. That button used to be a fixed
// "Open in Finder"; it is now a split control whose left half launches the app
// picked last and whose chevron lists everything detected on the machine.
//
// The e2e binary records the pick instead of launching it (see
// `open_with_app` in lib.rs) and reports a FIXED app list instead of a real
// one (`E2E_APPS`): the CI runner has no editors installed, so a spec keyed on
// detection would assert an empty menu there. Real detection is unit-tested in
// Rust with an injected filesystem instead, which is the only place it can be
// tested deterministically.
//
// Cases: the menu's contents and group order; a pick reaches the backend with
// the task's absolute worktree path; the pick is REMEMBERED, so the left half
// then launches it without the menu; an app that has gone away reverts the
// button instead of staying dead; and Escape launches nothing.
describe("open the task folder in another app", () => {
  const openLog = path.join(process.cwd(), ".e2e", "profile", "e2e-open-with.log");
  const FILE_MANAGER = FILE_MANAGER_NAME;
  const FILE_MANAGER_PICK = { key: "file-manager", label: FILE_MANAGER, kind: "file-manager" };
  let taskId = "";

  /** `<app key>\t<absolute dir>` per launch, newest last. */
  const opens = (): string[][] => {
    try {
      return readFileSync(openLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"));
    } catch {
      return []; // not written yet — the caller is inside a waitUntil
    }
  };

  /** The MOST RECENT launch, waited for rather than slept on. The last line,
   *  not the first: a launch from the previous case can still be landing when
   *  this one clears the log. */
  const lastOpen = async (): Promise<string[]> => {
    await browser.waitUntil(() => opens().length > 0, {
      timeout: 8_000,
      timeoutMsg: "nothing reached open_with_app",
    });
    const all = opens();
    return all[all.length - 1];
  };

  const setPick = (p: unknown) =>
    browser.execute((v) => {
      window.__termic!.usePrefs.getState().setOpenWithApp(v);
    }, p);

  const currentPick = () =>
    browser.execute(() => window.__termic!.usePrefs.getState().openWithApp);

  /** Open the menu and wait for the app list to arrive. It is fetched on first
   *  open, never during render, so the items are not there on the first tick. */
  const openMenu = async () => {
    // A dispatched pointerdown/up pair, NOT clickWhenVisible: Radix opens on
    // pointerdown and WebKit's WebDriver click emits no pointer events at all,
    // so `el.click()` leaves the trigger `data-state="closed"` (measured here:
    // the first run of this spec failed with state closed and no menu in the
    // DOM). Same helper shape as the History scope picker in git.e2e.ts, and
    // no trailing click for the same reason: it would toggle straight shut.
    // Menu ITEMS are fine with a plain click, which is why only this half
    // needs the pair.
    await waitVisible('[data-testid="open-with-menu"]');
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="open-with-menu"]') as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    });
    // The app list is fetched on first open, never during render, so the rows
    // land a tick after the menu does.
    await waitVisible('[data-testid="open-with-file-manager"]');
  };

  /** Visible labels of the picker's menu rows, in render order. */
  const menuLabels = () =>
    browser.execute(() =>
      [...document.querySelectorAll("[role='menuitem']")]
        .filter((el) => el.getAttribute("data-testid")?.startsWith("open-with-"))
        .map((el) => (el as HTMLElement).innerText.trim()),
    );

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    taskId = await openTask("e2e-open-with");
    await ensureActiveTask(taskId);
    await waitVisible('[data-testid="open-with-launch"]');
  });

  after(async () => {
    // The pref is app-wide and the profile is shared with every later spec
    // file: a synthetic editor left behind would make any later click on this
    // button write a log line that spec never asked for.
    await setPick(FILE_MANAGER_PICK);
    rmSync(openLog, { force: true });
    if (taskId) await archiveTask(taskId);
  });

  it("defaults to the file manager, which is what the button always did", async () => {
    expect(await currentPick()).toMatchObject({ key: "file-manager" });
    expect(
      await browser.execute(
        () => document.querySelector('[data-testid="open-with-launch"]')?.getAttribute("data-app"),
      ),
    ).toBe("file-manager");
  });

  it("renders as one control, not two buttons side by side", async () => {
    // A split control in a 28px slot either reads as one button or looks
    // broken, and no screenshot assertion can say which. So measure it: equal
    // heights, touching edges, a real icon in the launch half, and a total
    // width that cannot silently balloon in a bar that has to earn its space
    // against the breadcrumb (docs/ui.md).
    const box = await browser.execute(() => {
      const l = document.querySelector('[data-testid="open-with-launch"]') as HTMLElement;
      const m = document.querySelector('[data-testid="open-with-menu"]') as HTMLElement;
      const lr = l.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      const svg = l.querySelector("svg");
      const sr = svg?.getBoundingClientRect();
      return {
        lh: Math.round(lr.height), mh: Math.round(mr.height),
        gap: Math.round(mr.left - lr.right),
        total: Math.round(mr.right - lr.left),
        icon: sr ? Math.round(sr.width) : 0,
      };
    });
    expect(box.lh).toBe(box.mh);            // one control, one height
    expect(box.gap).toBe(0);                // touching, no seam
    expect(box.icon).toBeGreaterThan(8);    // the glyph actually rendered
    expect(box.total).toBeLessThanOrEqual(48);
  });

  it("lists the file manager first, then editors, then terminals", async () => {
    // The menu draws one separator per group boundary, so the order is
    // load-bearing: a terminal sorted among the editors would put a separator
    // in the middle of them.
    await openMenu();
    expect(await menuLabels()).toEqual([FILE_MANAGER, "E2E Editor", "E2E Terminal"]);
    await snap("open-with-menu.png");
    await browser.keys(["Escape"]);
    await waitGone('[data-testid="open-with-file-manager"]');
  });

  it("launches nothing when the menu is dismissed", async () => {
    // Opening the menu is not a launch. Escape has to leave the folder alone.
    rmSync(openLog, { force: true });
    await openMenu();
    await browser.keys(["Escape"]);
    await waitGone('[data-testid="open-with-file-manager"]');
    expect(opens()).toEqual([]);
  });

  it("sends the task's absolute worktree path, not a relative one", async () => {
    rmSync(openLog, { force: true });
    await openMenu();
    await clickWhenVisible('[data-testid="open-with-e2e-editor"]');
    const [key, dir] = await lastOpen();
    expect(key).toBe("e2e-editor");
    // Absolute, and resolved in Rust from the task id: the frontend never
    // sends a path at all.
    expect(path.isAbsolute(dir)).toBe(true);
    const want = await browser.execute(
      (i) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === i)?.path,
      taskId,
    );
    expect(dir).toBe(want);
  });

  it("remembers the pick, so the button launches it without the menu", async () => {
    // The whole point of the split control: pick once, then one click.
    expect(await currentPick()).toMatchObject({ key: "e2e-editor", label: "E2E Editor" });
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('[data-testid="open-with-launch"]')?.getAttribute("data-app"),
        )) === "e2e-editor",
      { timeout: 8_000, timeoutMsg: "the button never adopted the pick" },
    );
    await snap("open-with-remembered.png");

    rmSync(openLog, { force: true });
    await clickWhenVisible('[data-testid="open-with-launch"]');
    const [key] = await lastOpen();
    expect(key).toBe("e2e-editor");
  });

  it("reverts to the file manager when the remembered app has gone away", async () => {
    // An app can be uninstalled between picking it and clicking, or weeks
    // later. Detection never runs on the render path (it is a blocking Rust
    // call), so recovering at launch is the only place this can be caught —
    // and leaving the button dead is the failure this prevents.
    rmSync(openLog, { force: true });
    await setPick({ key: "e2e-gone", label: "Gone", kind: "editor" });
    await clickWhenVisible('[data-testid="open-with-launch"]');
    await waitForText("Could not open in Gone");
    await browser.waitUntil(
      async () => (await currentPick()).key === "file-manager",
      { timeout: 8_000, timeoutMsg: "the pick never reverted to the file manager" },
    );
    expect(opens()).toEqual([]);
  });
});
