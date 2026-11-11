// Secrets, task side. Drives the real
// New Task dialog and footer: on an uncaged draft the role section says that
// picking a role turns the cage on, and does; picking a role turns the
// Keychain block on, leaving the
// cage or clearing the block clears it, the created task shows its role in
// the footer and the sidebar, a default seeds only tasks created after it, and
// an uncaged task seeded with a role offers the one-click fix. macOS only: without Seatbelt there are no enforcing modes.
//
// Fixtures use the mocks' placeholder names only (alice, acme/widget).
import path from "node:path";
import { archiveTask, clickWhenVisible, newTaskSection, openTask, requireTermicApi, snap, textOf, waitForAgentPty, waitForAppShell, waitGone, waitVisible } from "../helpers";

// a Radix menu opens on pointerdown, which a plain click() never sends.
const openMenu = (sel: string) => browser.execute((s) => {
  const trigger = document.querySelector(s) as HTMLElement;
  const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
  trigger.dispatchEvent(new PointerEvent("pointerdown", opts));
  trigger.dispatchEvent(new PointerEvent("pointerup", opts));
  trigger.click();
}, sel);

(process.platform !== "darwin" ? describe.skip : describe)("secrets: task role", () => {
  const dialog = '[role="dialog"]:has(input[placeholder="fix login bug"])';
  const box = `${dialog} [data-testid="sandbox-block-keychain"]`;
  const section = `${dialog} [data-testid="role-section"]`;
  const card = (id: string) => `${section} [data-role-option="${id}"]`;
  let prevSettings = "";
  let lastPick = "[]";
  let taskId: string | null = null;
  // the project default the uncaged case sets, restored in after().
  let prevProjectDefault: string | null | undefined;

  const clickButton = (text: string) => browser.waitUntil(
    () => browser.execute((sel, t) => {
      const b = [...(document.querySelector(sel)?.querySelectorAll("button") ?? [])]
        .find(x => x.textContent?.trim() === t) as HTMLButtonElement | undefined;
      b?.click();
      return !!b;
    }, dialog, text),
    { timeout: 8_000, timeoutMsg: `New Task button never appeared: ${text}` },
  );
  const attr = (sel: string, name: string) =>
    browser.execute((s, n) => document.querySelector(s)?.getAttribute(n) ?? null, sel, name);
  const pressed = (id: string) => attr(card(id), "aria-checked");
  const blockChecked = () => attr(box, "aria-checked");
  const sectionDisabled = () => attr(section, "data-disabled");

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    prevSettings = await browser.execute(async () => JSON.stringify(await window.__termic!.ipc.settingsLoad()));
    lastPick = await browser.execute(() => JSON.stringify(
      Object.entries(localStorage).filter(([k]) => k.endsWith("newTaskLastSandboxMode"))));
    // fakeagent is a script in the repo's scripts/, outside every cage
    // allow-list, so a caged spawn would exit 126 before it sends anything.
    // after() restores prevSettings, which drops this again.
    const scripts = path.resolve("scripts");
    await browser.execute(async (scripts) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const gh = (id: string, name: string) => ({
        id, name, kind: "generic", service: "gh:github.com", account: "alice", recipe: "github",
        hosts: ["api.github.com", "github.com"],
      });
      await t.ipc.settingsSave({
        ...s,
        sandbox_default_rw_paths: [...(s.sandbox_default_rw_paths ?? []), scripts],
        secrets: [gh("gh-review", "gh-review"), gh("gh-maintain", "gh-maintain")],
        roles: [
          {
            id: "reviewer", name: "Reviewer", colour: "purple", description: "Read, review, comment.",
            secrets: ["gh-review"],
            rule_sets: [{ secret: "gh-review", host: "api.github.com", fallback: "deny", rules: [
              { effect: "allow", methods: ["GET", "HEAD", "QUERY"], pattern: "/**", note: "read anything" },
              { effect: "allow", methods: ["POST"], pattern: "/repos/acme/*/pulls/*/reviews", note: "review and comment on acme/*" },
            ] }],
          },
          { id: "maintainer", name: "Maintainer", colour: "blue", description: "Full access.", secrets: ["gh-maintain"], rule_sets: [] },
        ],
      } as any);
      // the task-side mirror reloads when Settings closes, the same moment a
      // user's edit there would reach it.
      t.useApp.getState().openSettings();
      t.useApp.getState().closeSettings();
    }, scripts);
  });

  after(async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTask());
    if (prevProjectDefault !== undefined) {
      await browser.execute(async (prev) => {
        const t = window.__termic!;
        const p = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
        if (p) await t.ipc.projectUpdate({ ...p, default_role: prev });
        await t.useApp.getState().loadAll();
      }, prevProjectDefault);
    }
    if (taskId) await archiveTask(taskId);
    await browser.execute(async (prev, picks) => {
      const t = window.__termic!;
      await t.ipc.settingsSave(JSON.parse(prev));
      t.useApp.getState().openSettings();
      t.useApp.getState().closeSettings();
      for (const k of Object.keys(localStorage)) if (k.endsWith("newTaskLastSandboxMode")) localStorage.removeItem(k);
      for (const [k, v] of JSON.parse(picks) as [string, string][]) localStorage.setItem(k, v);
    }, prevSettings, lastPick);
  });

  const note = `${section} [data-testid="role-cage-note"]`;
  const modePressed = (m: string) => attr(`${dialog} [data-sandbox-option="${m}"]`, "aria-pressed");

  // The sandbox modes and the Keychain box live in the rail's Isolation pane,
  // the role picker in Secrets: a role pick changes the cage in the other.
  const iso = () => newTaskSection("isolation");
  const sec = () => newTaskSection("secrets");

  it("says when picking a role would turn the cage on", async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await waitVisible(dialog);
    await clickButton("Main checkout");
    await clickButton("Terminal");
    await iso();
    await clickWhenVisible(`${dialog} [data-sandbox-option="off"]`);
    await sec();
    await waitVisible(section);
    // clickable, not greyed: the note says what a pick does instead.
    expect(await sectionDisabled()).toBeNull();
    await waitVisible(note);
    await iso();
    await clickWhenVisible(`${dialog} [data-sandbox-option="monitor"]`);
    await sec();
    await waitVisible(note);
    await iso();
    await clickWhenVisible(`${dialog} [data-sandbox-option="enforce-fs"]`);
    await waitGone(note);
    expect(await blockChecked()).toBe("false");
    expect(await pressed("none")).toBe("true");
  });

  it("picking a role on an uncaged draft switches it to Enforcing (FS)", async () => {
    await iso();
    await clickWhenVisible(`${dialog} [data-sandbox-option="off"]`);
    await sec();
    await clickWhenVisible(card("reviewer"));
    await browser.waitUntil(async () => (await modePressed("enforce-fs")) === "true",
      { timeout: 5_000, timeoutMsg: "picking a role did not switch the draft to Enforce FS" });
    // seen from the Secrets pane, the rail says what the cage became.
    expect(await textOf(`${dialog} [data-testid="rail-isolation-sub"]`)).toBe("Enforcing (FS), Keychain blocked");
    expect(await pressed("reviewer")).toBe("true");
    expect(await blockChecked()).toBe("true");
    // Monitor cannot block the Keychain either, so it switches the same way.
    await iso();
    await clickWhenVisible(`${dialog} [data-sandbox-option="monitor"]`);
    expect(await pressed("reviewer")).toBe("false");
    await sec();
    await clickWhenVisible(card("reviewer"));
    await browser.waitUntil(async () => (await modePressed("enforce-fs")) === "true",
      { timeout: 5_000, timeoutMsg: "picking a role under Monitor did not switch to Enforce FS" });
    await clickWhenVisible(card("none"));
  });

  it("picking a role turns the Keychain block on and shows the brokered summary", async () => {
    await clickWhenVisible(card("reviewer"));
    expect(await pressed("reviewer")).toBe("true");
    expect(await blockChecked()).toBe("true");
    expect(await textOf(`${dialog} [data-testid="rail-secrets-sub"]`)).toBe("Reviewer");
    await waitVisible(`${dialog} [data-testid="secrets-for-task"]`);
    const env = await browser.execute((s) => document.querySelector(`${s} [data-testid="secrets-env-preview"]`)?.textContent ?? "", dialog);
    expect(env).toContain("GH_TOKEN=termic_ph_");
    expect(env).toContain("GH_CONFIG_DIR=<task>/gh");
    const summary = await browser.execute((s) => document.querySelector(`${s} [data-testid="secrets-for-task"]`)?.textContent ?? "", dialog);
    expect(summary).toContain("gh-maintain"); // under "Not available to this task"
    await snap("secrets-m4-new-task-role.png");
  });

  it("leaving the cage or clearing the block clears the role", async () => {
    await clickWhenVisible(card("reviewer"));
    await iso();
    await clickWhenVisible(`${dialog} [data-sandbox-option="off"]`);
    expect(await pressed("reviewer")).toBe("false");
    await waitGone(`${dialog} [data-testid="secrets-for-task"]`);
    await clickWhenVisible(`${dialog} [data-sandbox-option="enforce-fs"]`);
    // cleared, not merely hidden: coming back does not bring it back.
    expect(await pressed("reviewer")).toBe("false");
    await sec();
    await clickWhenVisible(card("reviewer"));
    expect(await blockChecked()).toBe("true");
    await iso();
    await clickWhenVisible(box);
    expect(await blockChecked()).toBe("false");
    expect(await pressed("reviewer")).toBe("false");
    await sec();
    await snap("secrets-m4-role-cleared.png");
  });

  it("creates the task with its role and shows it in the footer and sidebar", async () => {
    await clickWhenVisible(card("reviewer"));
    await browser.execute((sel) => {
      const input = document.querySelector(`${sel} input[placeholder="fix login bug"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "e2e-secrets-role");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, dialog);
    await clickButton("Create");
    const created = await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().tasks
        .find((t: any) => t.name === "e2e-secrets-role" && !t.archived) ?? false),
      { timeout: 15_000, timeoutMsg: "New Task never created e2e-secrets-role" },
    ) as { id: string; role?: string | null; sandbox_mode?: string; sandbox_block_keychain?: boolean };
    taskId = created.id;
    expect(created.sandbox_mode).toBe("enforce-fs");
    expect(created.sandbox_block_keychain).toBe(true);
    expect(created.role).toBe("reviewer");
    await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), created.id);
    const chip = `[data-task-id="${created.id}"] [data-testid="cage-chip"]`;
    await waitVisible(`${chip}[data-role="reviewer"]`);
    await waitVisible(`[data-testid="task-role-key"][data-role="reviewer"]`);
    // the chip opens settings: each row leads with its glyph and shows the
    // task's own values.
    await clickWhenVisible(chip);
    await waitVisible('[data-testid="cage-settings"]');
    expect(await attr('[data-testid="cage-mode-enforce-fs"]', "aria-checked")).toBe("true");
    expect(await attr('[data-testid="cage-block-stores"]', "aria-checked")).toBe("true");
    expect(await textOf('[data-testid="cage-role"]')).toContain("Reviewer");
    expect(await attr('[data-testid="cage-yolo"]', "aria-checked")).toBe("true");
    await snap("cage-settings.png");
    await browser.keys("Escape");
    await waitGone('[data-testid="cage-settings"]');
  });

  it("leaving the cage drops the role, and a project default set later never fills it", async () => {
    // defaults seed, tasks own: the project default only reaches tasks
    // created after it, so this one stays on No secrets.
    prevProjectDefault = await browser.execute(async (id) => {
      const t = window.__termic!;
      const p = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")!;
      const prev = p.default_role ?? null;
      await t.ipc.projectUpdate({ ...p, default_role: "reviewer" });
      await t.ipc.taskSetSandbox(id, "off", [], [], false);
      await t.useApp.getState().loadAll();
      return prev;
    }, taskId!);
    const cleared = await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.role ?? null, taskId!);
    // "", not null: a drop is an explicit No secrets (Task::role), so the
    // project default set above can never seed it back.
    expect(cleared).toBe("");
    const chip = `[data-task-id="${taskId}"] [data-testid="cage-chip"]`;
    await waitGone(`${chip}[data-role]`);
    await waitVisible(`${chip} [data-testid="cage-chip-no-secrets"]`);
    // a negative: outlast one 2s footer poll, which would draw a struck role.
    await browser.pause(2_500);
    expect(await browser.execute((s) => !!document.querySelector(`${s}[data-unapplied-role]`), chip)).toBe(false);
  });

  it("an uncaged task seeded with the project's role offers to turn on the cage and the block", async () => {
    // created with no role and no cage: Rust seeds the project default, which
    // waits for the block (the notice), and the fix keeps it.
    const seeded = await openTask("e2e-secrets-seeded");
    try {
      expect(await browser.execute((id) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.role ?? null, seeded)).toBe("reviewer");
      // settle the new task's agent first: once, mid-spawn, the popover was
      // gone between finding the Fix button and clicking it.
      await waitForAgentPty(seeded);
      const chip = `[data-task-id="${seeded}"] [data-testid="cage-chip"]`;
      await waitVisible(`${chip}[data-unapplied-role="reviewer"]`);
      await clickWhenVisible(chip);
      await waitVisible('[data-testid="cage-settings"] [data-testid="cage-role-unapplied"]');
      await snap("cage-role-unapplied.png");
      await clickWhenVisible('[data-testid="cage-role-fix"]');
      await clickWhenVisible('[data-testid="cage-save-restart"]');
      const t = await browser.waitUntil(
        () => browser.execute((id) => {
          const x = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id);
          return x?.sandbox_mode === "enforce-fs" && x?.sandbox_block_keychain ? x : false;
        }, seeded),
        { timeout: 10_000, timeoutMsg: "the fix never turned on Enforce FS and the block" },
      ) as { role?: string | null };
      expect(t.role).toBe("reviewer");
      await waitVisible(`${chip}[data-role="reviewer"]`);
    } finally {
      await archiveTask(seeded);
      await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId!);
    }
  });

  it("New Task starts on the project's default, says so, and saves an explicit No secrets", async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await waitVisible(dialog);
    await clickButton("Main checkout");
    await clickButton("Terminal");
    // the last create was Enforcing (FS), so the dialog reopens there with
    // the default picked and the block it needs.
    await browser.waitUntil(async () => (await pressed("reviewer")) === "true",
      { timeout: 5_000, timeoutMsg: "the project default never started picked" });
    expect(await blockChecked()).toBe("true");
    await sec();
    const seededLine = `${section} [data-testid="role-seeded-from"]`;
    await waitVisible(seededLine);
    expect(await browser.execute((s) => document.querySelector(s)?.textContent ?? "", seededLine))
      .toContain("Picked for you from this project's default");
    await browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), section);
    await snap("secrets-picker-new-task.png");
    await clickWhenVisible(card("none"));
    await waitGone(seededLine);
    await browser.execute((sel) => {
      const input = document.querySelector(`${sel} input[placeholder="fix login bug"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "e2e-secrets-none");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, dialog);
    await clickButton("Create");
    const created = await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().tasks
        .find((t: any) => t.name === "e2e-secrets-none" && !t.archived) ?? false),
      { timeout: 15_000, timeoutMsg: "New Task never created e2e-secrets-none" },
    ) as { id: string; role?: string | null };
    try {
      // "", not null: an explicit No secrets the project default can never fill.
      expect(created.role).toBe("");
    } finally {
      await archiveTask(created.id);
      await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId!);
    }
  });

  it("the sandbox dialog has no role picker, and warns before a save drops the role", async () => {
    // roles are picked in New Task, Edit task and the Secrets chip; the
    // sandbox dialog only says what its own changes would do to one.
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskSetSandbox(id, "enforce-fs", [], [], false, true);
      await t.ipc.taskSetRole(id, "maintainer");
      await t.useApp.getState().loadAll();
      t.useUI.getState().openSandbox(id);
    }, taskId!);
    const sb = '[role="dialog"]:has([data-testid="sandbox-save-no-restart"])';
    await waitVisible(`${sb} [data-sandbox-option="off"]`);
    const has = (q: string) => browser.execute((s, q) => !!document.querySelector(`${s} ${q}`), sb, q);
    expect(await has("[data-role-option]")).toBe(false);
    expect(await has('[data-testid="sandbox-drops-role"]')).toBe(false);
    await clickWhenVisible(`${sb} [data-sandbox-option="off"]`);
    await waitVisible(`${sb} [data-testid="sandbox-drops-role"]`);
    expect(await textOf(`${sb} [data-testid="sandbox-drops-role"]`)).toContain("Maintainer");
    // the switch must PAINT: the cards carried transition-colors, which froze
    // the old card as selected (docs/gotchas.md, transition-colors).
    const selectedBorder = () => browser.execute((s) => ["off", "enforce-fs"].map(m =>
      getComputedStyle(document.querySelector(`${s} [data-sandbox-option="${m}"]`)!).borderTopColor), sb);
    await browser.waitUntil(async () => { const [off, fs] = await selectedBorder(); return off !== fs; },
      { timeout: 3_000, timeoutMsg: "the mode cards never repainted" });
    await snap("secrets-sandbox-drops-role.png");
    // back on Enforce FS with the block still ticked, nothing is dropped.
    await clickWhenVisible(`${sb} [data-sandbox-option="enforce-fs"]`);
    await waitGone(`${sb} [data-testid="sandbox-drops-role"]`);
    await browser.keys(["Escape"]);
    await waitGone(sb);
    expect(await browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.role ?? null, taskId!)).toBe("maintainer");
  });

  it("a task with no role attaches one from the status bar", async () => {
    const chip = `[data-task-id="${taskId}"] [data-testid="cage-chip"]`;
    const settings = '[data-testid="cage-settings"]';
    const state = () => browser.execute((id) => {
      const x = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id);
      return { mode: x?.sandbox_mode, block: !!x?.sandbox_block_keychain, role: x?.role ?? null };
    }, taskId!);
    // uncaged: picking a role turns on the cage and the block in the draft,
    // and says so; Save writes all three.
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskSetRole(id, "");
      await t.ipc.taskSetSandbox(id, "off", [], [], false, false);
      await t.useApp.getState().loadAll();
    }, taskId!);
    await waitVisible(`${chip} [data-testid="cage-chip-no-secrets"]`);
    expect(await textOf(chip)).toContain("Sandbox off");
    await clickWhenVisible(chip);
    await waitVisible(settings);
    expect(await attr('[data-testid="cage-block-stores"]', "disabled")).not.toBeNull();
    await openMenu('[data-testid="cage-role"]');
    await clickWhenVisible('[role="menu"] [data-role-option="maintainer"]');
    await waitVisible(`${settings} [data-testid="cage-role-cage-note"]`);
    expect(await attr('[data-testid="cage-mode-enforce-fs"]', "aria-checked")).toBe("true");
    expect(await attr('[data-testid="cage-block-stores"]', "aria-checked")).toBe("true");
    await snap("cage-settings-role-turns-cage-on.png");
    await clickWhenVisible('[data-testid="cage-save"]');
    await waitGone(settings);
    await browser.waitUntil(async () => (await state()).role === "maintainer",
      { timeout: 10_000, timeoutMsg: "the role never attached" });
    expect(await state()).toEqual({ mode: "enforce-fs", block: true, role: "maintainer" });
    await waitVisible(`${chip}[data-saved-role="maintainer"]`);
    // turning the block off in the draft takes the role with it, and says so.
    await clickWhenVisible(chip);
    await clickWhenVisible('[data-testid="cage-block-stores"]');
    await waitVisible(`${settings} [data-testid="cage-role-dropped"]`);
    expect(await textOf('[data-testid="cage-role"]')).toContain("No secrets");
    await browser.keys("Escape");
    await waitGone(settings);
    expect((await state()).role).toBe("maintainer");
  });

  it("switches the role of a caged task from the settings popover", async () => {
    const role = () => browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.role ?? null, taskId!);
    expect(await role()).toBe("maintainer");
    const chip = `[data-task-id="${taskId}"] [data-testid="cage-chip"]`;
    await clickWhenVisible(chip);
    await openMenu('[data-testid="cage-role"]');
    // Reviewer is also the project default here, and still saves as itself:
    // the task owns its pick. Already caged: no "turns the cage on" note.
    await clickWhenVisible('[role="menu"] [data-role-option="reviewer"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="cage-role-cage-note"]'))).toBe(false);
    await clickWhenVisible('[data-testid="cage-save"]');
    await browser.waitUntil(async () => (await role()) === "reviewer",
      { timeout: 10_000, timeoutMsg: "the switch never saved" });
    await waitVisible(`${chip}[data-saved-role="reviewer"]`);
  });

  it("Activity floats above the task's status bar, blocks nothing, and keeps to one line", async () => {
    const activity = '[data-testid="cage-activity"]';
    await browser.execute((id) => window.__termic!.useUI.getState().openCageActivity(id), taskId!);
    await waitVisible(activity);
    const m = await browser.execute((a, id) => {
      const el = document.querySelector(a) as HTMLElement;
      const footer = el.closest('[data-testid="task-footer"]');
      const col = document.querySelector(`[data-task-id="${id}"]`)!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const [header, toolbar] = [el.children[0], el.children[1]] as HTMLElement[];
      const tops = [...toolbar.children].map(c => Math.round((c as HTMLElement).getBoundingClientRect().top));
      return {
        inFooter: footer?.closest(`[data-task-id="${id}"]`) !== null && !!footer,
        modal: !!el.closest('[role="dialog"]') || !!document.querySelector('.termic-backdrop[data-state="open"]'),
        insideColumn: r.left >= col.left - 1 && r.right <= col.right + 1,
        headerH: header.getBoundingClientRect().height,
        toolbarRows: new Set(tops).size,
      };
    }, activity, taskId!);
    // anchored to this task's footer, inside its column, and not a dialog:
    // the terminal under it keeps taking input.
    expect(m).toEqual({ inFooter: true, modal: false, insideColumn: true, headerH: m.headerH, toolbarRows: 1 });
    expect(m.headerH).toBeLessThan(44);
    await snap("cage-activity-empty.png");
    // the chip's tail is its off switch; with nothing to show, ✕ is.
    await clickWhenVisible('[data-testid="activity-close"]');
    await waitGone(activity);
  });

  it("Activity lists the block, allows it on the role, and Pause holds until resumed", async () => {
    // an agent tab opened now spawns under the cage with the Reviewer broker
    // (shell tabs are never caged). Through gh's socket it asks for a merge,
    // which Reviewer's fallback denies before any network: the fixture's
    // `#sh` runs it inside the cage, so the peer check, the spawn dir's
    // profile rules and the placeholder are all the real ones.
    const shellTab = "e2e-broker-agent";
    const chip = `[data-task-id="${taskId}"] [data-testid="cage-chip"]`;
    const activity = '[data-testid="cage-activity"]';
    const counts = () => browser.execute((id) => window.__termic!.ipc.brokerCounts(id), taskId!) as Promise<any>;
    await browser.execute((id, tab) => {
      window.__termic!.useApp.getState().addTab(id, { id: tab, type: "terminal", cli: "fakeagent", title: "broker" } as never);
    }, taskId!, shellTab);
    const pty = await browser.waitUntil(() => browser.execute((id, tab) =>
      (window.__termic!.useApp.getState().tabs[id] ?? []).find((x: any) => x.id === tab)?.ptyId ?? false, taskId!, shellTab),
    { timeout: 20_000, timeoutMsg: "the broker agent never spawned" }) as string;
    await browser.waitUntil(() => counts().then(c => c.live > 0 && c.roles.includes("reviewer")),
      { timeout: 10_000, timeoutMsg: "no live Reviewer broker for the agent" });
    const merge = `#sh s=$(sed -n 's/^http_unix_socket: //p' "$GH_CONFIG_DIR/config.yml"); `
      + `curl -s -o /dev/null --unix-socket "$s" -X PUT -H "Authorization: token $GH_TOKEN" `
      + `http://api.github.com/repos/acme/widget/pulls/1/merge\r`;
    await browser.execute((p, line) => window.__termic!.ipc.ptyWrite(p, [...new TextEncoder().encode(line)]), pty, merge);
    await browser.waitUntil(() => counts().then(c => c.blocked > 0),
      { timeout: 15_000, timeoutMsg: "the merge was never blocked" });

    // the chip's tail opens Activity, the wide view.
    await waitVisible(`${chip}[data-tail="blocked"]`);
    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="cage-chip-tail"]`);
    await waitVisible(`${activity} [data-testid="activity-row"][data-kind="rule"]`);
    // a row is one line; a click opens its detail under it, which names the
    // secret (not its id) and wraps instead of truncating. A second click
    // folds it back.
    const ruleRow = `${activity} [data-testid="activity-row"][data-kind="rule"]`;
    expect(await textOf(ruleRow)).toContain("/repos/acme/widget/pulls/1/merge");
    await clickWhenVisible(ruleRow);
    await waitVisible(`${activity} [data-testid="activity-detail"]`);
    expect(await textOf(`${activity} [data-testid="activity-detail"]`)).toContain("gh-review");
    // the left panel lists Reviewer's rules for the host and marks the one
    // that blocked it; the right one offers the scopes with an Allow.
    expect(await browser.execute((a) => !!document.querySelector(`${a} [data-testid="activity-detail-rules"] [data-hit]`), activity)).toBe(true);
    expect(await browser.execute((a) => document.querySelector(`${a} [data-testid="activity-detail-action"]`)?.getAttribute("data-tone"), activity)).toBe("blocked");
    await waitVisible(`${activity} [data-testid="activity-detail-allow"]`);
    expect(await browser.execute((r) => document.querySelector(r)?.getAttribute("aria-expanded"), ruleRow)).toBe("true");
    await snap("cage-activity-detail.png");
    await clickWhenVisible(ruleRow);
    await waitGone(`${activity} [data-testid="activity-detail"]`);
    // a header sorts: Times high to low, again low to high, then back to newest first.
    const timesTh = `${activity} th:has([data-testid="activity-sort-count"])`;
    const ariaSort = () => browser.execute((s) => document.querySelector(s)?.getAttribute("aria-sort"), timesTh);
    await clickWhenVisible(`${activity} [data-testid="activity-sort-count"]`);
    expect(await ariaSort()).toBe("descending");
    await clickWhenVisible(`${activity} [data-testid="activity-sort-count"]`);
    expect(await ariaSort()).toBe("ascending");
    await clickWhenVisible(`${activity} [data-testid="activity-sort-count"]`);
    expect(await ariaSort()).toBe("none");
    // one line per row, however long the request: measured, not eyeballed.
    const rowHeights = await browser.execute((a) => [...document.querySelectorAll(`${a} [data-testid="activity-row"]`)]
      .map(r => r.getBoundingClientRect().height), activity);
    expect(Math.max(...rowHeights)).toBeLessThan(36);
    await snap("cage-activity-blocked.png");
    // the filters narrow it: a kind with nothing in it empties the table, a
    // keyword that matches brings it back.
    await openMenu('[data-testid="activity-kind"]');
    await clickWhenVisible('[role="menu"] [data-testid="activity-kind-network"]');
    await waitVisible('[data-testid="activity-empty"]');
    await openMenu('[data-testid="activity-kind"]');
    await clickWhenVisible('[role="menu"] [data-testid="activity-kind-all"]');
    const search = '[data-testid="activity-search"]';
    await browser.execute((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "nothing-like-this");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, search);
    await waitVisible('[data-testid="activity-empty"]');
    await browser.execute((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "widget");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, search);
    await waitVisible(`${activity} [data-testid="activity-row"][data-kind="rule"]`);
    // with no default set, the face asks; the caret offers this task or the
    // role, and a pick there allows that row only, leaving the default unset.
    await browser.execute(() => { const p = window.__termic!.usePrefs.getState(); p.setSecretsAllowScope(null); });
    const allowBtn = `${ruleRow} [data-testid="secrets-allow"]`;
    await openMenu(`${activity} [data-testid="secrets-allow-scope"]`);
    await waitVisible('[data-testid="allow-scope-menu"] [data-scope-option="task"]');
    await snap("cage-activity-scope.png");
    await clickWhenVisible('[data-testid="allow-scope-menu"] [data-scope-option="role"]');
    const ruleOnRole = () => browser.execute(async () => {
      const s = await window.__termic!.ipc.settingsLoad();
      const rule = s.roles?.find((r: any) => r.id === "reviewer")?.rule_sets
        .find((rs: any) => rs.host === "api.github.com")?.rules[0];
      return rule?.effect === "allow" && rule.methods.join() === "PUT" && rule.pattern === "/repos/acme/widget/pulls/1/merge";
    });
    await browser.waitUntil(ruleOnRole, { timeout: 10_000, timeoutMsg: "the allow never landed on the role" });
    expect(await browser.execute(() => window.__termic!.usePrefs.getState().secretsAllowScope)).toBe(null);
    // the row stays, green, after Rust drops the blocked entry: the polls
    // (1.5s panel, 2s footer) do not take it away.
    await browser.waitUntil(() => counts().then(c => c.blocked === 0),
      { timeout: 10_000, timeoutMsg: "the blocked count never dropped after Allow" });
    await browser.pause(3_200);
    expect(await browser.execute((r) => document.querySelector(r)?.getAttribute("data-status"), ruleRow)).toBe("allowed");
    expect(await browser.execute((b) => document.querySelector(b)?.getAttribute("data-allowed"), allowBtn)).toBe("role");
    await snap("cage-activity-allowed.png");
    // a second click undoes it: the rule leaves the role, the row is blocked again.
    await clickWhenVisible(allowBtn);
    await browser.waitUntil(async () => !(await ruleOnRole()), { timeout: 10_000, timeoutMsg: "Undo never took the rule off the role" });
    await browser.waitUntil(() => browser.execute((r) => document.querySelector(r)?.getAttribute("data-status") === "blocked", ruleRow),
      { timeout: 5_000, timeoutMsg: "the row never went back to blocked" });

    // Pause refuses every brokered request until Resume, live.
    await clickWhenVisible('[data-testid="secrets-pause"]');
    await waitVisible('[data-testid="secrets-paused-banner"]');
    await browser.waitUntil(() => counts().then(c => c.paused === true),
      { timeout: 5_000, timeoutMsg: "Pause never reached the broker" });
    await waitVisible(`${chip}[data-tail="paused"]`);
    await snap("cage-activity-paused.png");
    await clickWhenVisible('[data-testid="secrets-pause"]');
    await waitGone('[data-testid="secrets-paused-banner"]');
    await browser.waitUntil(() => counts().then(c => c.paused === false),
      { timeout: 5_000, timeoutMsg: "Resume never reached the broker" });
    await clickWhenVisible('[data-testid="activity-close"]');
    await waitGone(activity);

    // a switch saves the new role but the live broker keeps the old one, so
    // the chip says so instead of claiming the new role is in force.
    const pickRole = async (id: string) => {
      await clickWhenVisible(chip);
      await openMenu('[data-testid="cage-role"]');
      await clickWhenVisible(`[role="menu"] [data-role-option="${id}"]`);
      await clickWhenVisible('[data-testid="cage-save"]');
      await waitGone('[data-testid="cage-settings"]');
    };
    await pickRole("maintainer");
    await waitVisible(`${chip}[data-saved-role="maintainer"][data-role="reviewer"] [data-testid="cage-chip-pending"]`);
    await clickWhenVisible(chip);
    await waitVisible('[data-testid="cage-settings"] [data-testid="secrets-pending-banner"]');
    await snap("cage-settings-pending.png");
    await browser.keys("Escape");
    await pickRole("reviewer");
    await waitGone(`${chip} [data-testid="cage-chip-pending"]`);

    // swapping the secret on the role the agent RUNS is the same story with
    // no switch: bindings are set up at spawn, so it reads as pending until
    // a restart, and a swap back clears it.
    const setReviewerSecret = (sid: string) => browser.execute(async (sid) => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...s, roles: s.roles.map((r: any) => r.id === "reviewer" ? { ...r, secrets: [sid] } : r) } as any);
    }, sid);
    await setReviewerSecret("gh-maintain");
    await browser.waitUntil(() => counts().then(c => c.stale === true),
      { timeout: 5_000, timeoutMsg: "the broker never reported the swapped secret as stale" });
    await waitVisible(`${chip}[data-saved-role="reviewer"][data-role="reviewer"] [data-testid="cage-chip-pending"]`);
    await clickWhenVisible(chip);
    expect(await textOf('[data-testid="secrets-pending-banner"]')).toContain("Reviewer changed since the agent started");
    await browser.keys("Escape");
    await setReviewerSecret("gh-review");
    await waitGone(`${chip} [data-testid="cage-chip-pending"]`);
    await browser.execute((id, tab) => window.__termic!.useApp.getState().closeTab(id, tab), taskId!, shellTab);
  });

  it("the role menu opens Settings on that role", async () => {
    const editing = () => browser.execute(() => (document.querySelector('[data-testid="role-name"]') as HTMLInputElement)?.value ?? null);
    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="cage-chip"]`);
    await openMenu('[data-testid="cage-role"]');
    await clickWhenVisible('[role="menu"] [data-testid="secrets-role-link"]');
    await waitGone('[data-testid="cage-settings"]');
    await waitVisible('[data-role-row="Reviewer"][data-selected]');
    expect(await editing()).toBe("Reviewer");
    expect(await browser.execute(() => window.__termic!.useApp.getState().view.settingsHighlight ?? null)).toBe(null);
    await snap("secrets-role-link-settings.png");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    // Reviewer is the first role, so also land on one that is not.
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("secrets", undefined, "role:maintainer"));
    await waitVisible('[data-role-row="Maintainer"][data-selected]');
    expect(await editing()).toBe("Maintainer");
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("a sandbox Save & restart brings every agent back on its own", async () => {
    // the bug this guards: an agent died and sat on the exited banner until
    // Restart was clicked. Needs real agent PTYs (the cases above run a
    // Terminal task, whose shell a sandbox save never kills), and two of
    // them: the respawn mark was one flag per task, so the first agent to
    // exit took it and the second stayed dead.
    const agentTask = await openTask("e2e-secrets-respawn");
    try {
      await waitForAgentPty(agentTask);
      await browser.execute((t) => {
        window.__termic!.useApp.getState().addTab(t, { id: "e2e-respawn-second", type: "terminal", cli: "fakeagent", title: "Second" } as never);
      }, agentTask);
      const ptys = () => browser.execute((id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? []).map((x: any) => x.ptyId ?? null), agentTask) as Promise<(string | null)[]>;
      await browser.waitUntil(async () => { const p = await ptys(); return p.length === 2 && p.every(Boolean); },
        { timeout: 20_000, timeoutMsg: "the second agent never spawned" });
      const before = await ptys();
      await browser.execute((id) => window.__termic!.useUI.getState().openSandbox(id), agentTask);
      const sb = '[role="dialog"]:has([data-testid="sandbox-save-no-restart"])';
      // any change makes Save & restart live; a mode is the simplest.
      const target = await browser.execute((id) =>
        window.__termic!.useApp.getState().tasks.find((x: any) => x.id === id)?.sandbox_mode === "enforce-fs" ? "monitor" : "enforce-fs", agentTask);
      await clickWhenVisible(`${sb} [data-sandbox-option="${target}"]`);
      await browser.execute((s) => {
        const b = [...document.querySelectorAll(`${s} button`)].find(x => x.textContent?.includes("Save & restart")) as HTMLButtonElement;
        b.click();
      }, sb);
      await clickWhenVisible('[data-testid="confirm-ok"]');
      await waitGone(sb);
      await browser.waitUntil(async () => {
        const p = await ptys();
        return p.every((x, i) => !!x && x !== before[i]);
      }, { timeout: 15_000, timeoutMsg: "an agent never respawned after Save & restart" });
      const t = await browser.execute((id) =>
        window.__termic!.useApp.getState().tasks.find((x: any) => x.id === id), agentTask) as { sandbox_mode?: string };
      expect(t.sandbox_mode).toBe(target);
    } finally {
      await archiveTask(agentTask);
    }
  });
});
