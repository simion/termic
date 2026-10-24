// Secrets, task side (plan 2.4, 2.5, 2.7; mocks M4, M5, M6). Drives the real
// New Task dialog and footer: on an uncaged draft the role section says that
// picking a role turns the cage on, and does; picking a role turns the
// Keychain block on, leaving the
// cage or clearing the block clears it, the created task shows its role in
// the footer and the sidebar, and a task whose cage was dropped offers the
// one-click fix. macOS only: without Seatbelt there are no enforcing modes.
//
// Fixtures use the mocks' placeholder names only (alice, acme/widget).
import { archiveTask, clickWhenVisible, openTask, requireTermicApi, snap, waitForAgentPty, waitForAppShell, waitGone, waitVisible } from "../helpers";

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
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      const gh = (id: string, name: string) => ({
        id, name, kind: "generic", service: "gh:github.com", account: "alice", recipe: "github",
        hosts: ["api.github.com", "github.com"],
      });
      await t.ipc.settingsSave({
        ...s,
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
    });
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

  it("says when picking a role would turn the cage on", async () => {
    await browser.execute(() => {
      const proj = window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
      window.__termic!.useUI.getState().openNewTask(proj.id);
    });
    await waitVisible(dialog);
    await clickButton("Main checkout");
    await clickButton("Terminal");
    await clickWhenVisible(`${dialog} [data-sandbox-option="off"]`);
    await waitVisible(section);
    // clickable, not greyed: the note says what a pick does instead.
    expect(await sectionDisabled()).toBeNull();
    await waitVisible(note);
    await clickWhenVisible(`${dialog} [data-sandbox-option="monitor"]`);
    await waitVisible(note);
    await clickWhenVisible(`${dialog} [data-sandbox-option="enforce-fs"]`);
    await waitGone(note);
    expect(await blockChecked()).toBe("false");
    expect(await pressed("none")).toBe("true");
  });

  it("picking a role on an uncaged draft switches it to Enforcing (FS)", async () => {
    await clickWhenVisible(`${dialog} [data-sandbox-option="off"]`);
    await clickWhenVisible(card("reviewer"));
    await browser.waitUntil(async () => (await modePressed("enforce-fs")) === "true",
      { timeout: 5_000, timeoutMsg: "picking a role did not switch the draft to Enforce FS" });
    expect(await pressed("reviewer")).toBe("true");
    expect(await blockChecked()).toBe("true");
    // Monitor cannot block the Keychain either, so it switches the same way.
    await clickWhenVisible(`${dialog} [data-sandbox-option="monitor"]`);
    expect(await pressed("reviewer")).toBe("false");
    await clickWhenVisible(card("reviewer"));
    await browser.waitUntil(async () => (await modePressed("enforce-fs")) === "true",
      { timeout: 5_000, timeoutMsg: "picking a role under Monitor did not switch to Enforce FS" });
    await clickWhenVisible(card("none"));
  });

  it("picking a role turns the Keychain block on and shows the brokered summary", async () => {
    await clickWhenVisible(card("reviewer"));
    expect(await pressed("reviewer")).toBe("true");
    expect(await blockChecked()).toBe("true");
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
    await clickWhenVisible(`${dialog} [data-sandbox-option="off"]`);
    expect(await pressed("reviewer")).toBe("false");
    await waitGone(`${dialog} [data-testid="secrets-for-task"]`);
    await clickWhenVisible(`${dialog} [data-sandbox-option="enforce-fs"]`);
    // cleared, not merely hidden: coming back does not bring it back.
    expect(await pressed("reviewer")).toBe("false");
    await clickWhenVisible(card("reviewer"));
    expect(await blockChecked()).toBe("true");
    await clickWhenVisible(box);
    expect(await blockChecked()).toBe("false");
    expect(await pressed("reviewer")).toBe("false");
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
    await waitVisible(`[data-task-id="${created.id}"] [data-testid="secrets-chip"][data-role="reviewer"]`);
    await waitVisible(`[data-testid="task-role-key"][data-role="reviewer"]`);
    await clickWhenVisible(`[data-task-id="${created.id}"] [data-testid="secrets-chip"]`);
    await waitVisible('[data-testid="secrets-popover"]');
    await snap("secrets-m5-footer-popover.png");
    await browser.keys("Escape");
    await waitGone('[data-testid="secrets-popover"]');
  });

  it("an uncaged task with a role offers to turn on the cage and the block", async () => {
    // leaving the cage clears the task's own pick (the role needs the
    // Keychain block), so the role this notice offers back comes from the
    // project's default.
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
    expect(cleared).toBeNull();
    await waitGone(`[data-task-id="${taskId}"] [data-testid="secrets-chip"]`);
    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="secrets-uncaged-chip"]`);
    await waitVisible('[data-testid="secrets-uncaged-popover"]');
    await snap("secrets-m6-uncaged.png");
    await clickWhenVisible('[data-testid="secrets-uncaged-fix"]');
    await clickWhenVisible('[data-testid="confirm-ok"]');
    const t = await browser.waitUntil(
      () => browser.execute((id) => {
        const x = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id);
        return x?.sandbox_mode === "enforce-fs" && x?.sandbox_block_keychain ? x : false;
      }, taskId!),
      { timeout: 10_000, timeoutMsg: "the fix never turned on Enforce FS and the block" },
    ) as { role?: string | null };
    expect(t.role ?? null).toBeNull();
    await waitVisible(`[data-task-id="${taskId}"] [data-testid="secrets-chip"][data-role="reviewer"]`);
  });

  it("adds a role to an existing uncaged task from its sandbox dialog", async () => {
    // the bug this guards: the dialog saved the role before the sandbox, so
    // Rust refused it ("a role needs Enforcing...") and nothing could add one.
    await browser.execute(async (id) => {
      const t = window.__termic!;
      await t.ipc.taskSetSandbox(id, "off", [], [], false);
      await t.useApp.getState().loadAll();
      t.useUI.getState().openSandbox(id);
    }, taskId!);
    const sb = '[role="dialog"]:has([data-testid="sandbox-save-no-restart"])';
    await waitVisible(`${sb} [data-testid="role-cage-note"]`);
    await clickWhenVisible(`${sb} [data-role-option="maintainer"]`);
    await browser.waitUntil(
      () => browser.execute((s) => document.querySelector(`${s} [data-sandbox-option="enforce-fs"]`)?.getAttribute("aria-pressed") === "true", sb),
      { timeout: 5_000, timeoutMsg: "the sandbox dialog did not switch to Enforce FS" });
    // the switch must PAINT: the cards carried transition-colors, which froze
    // OFF and No secrets as selected (docs/gotchas.md, transition-colors).
    const selectedBorder = () => browser.execute((s) => ["off", "enforce-fs"].map(m =>
      getComputedStyle(document.querySelector(`${s} [data-sandbox-option="${m}"]`)!).borderTopColor), sb);
    await browser.waitUntil(async () => { const [off, fs] = await selectedBorder(); return off !== fs; },
      { timeout: 3_000, timeoutMsg: "the mode cards never repainted" });
    const [offB, fsB] = await selectedBorder();
    const unselected = await browser.execute((s) => getComputedStyle(document.querySelector(`${s} [data-sandbox-option="monitor"]`)!).borderTopColor, sb);
    expect(offB).toBe(unselected);
    expect(fsB).not.toBe(unselected);
    await snap("secrets-role-existing-task.png");
    await clickWhenVisible(`${sb} [data-testid="sandbox-save-no-restart"]`);
    await clickWhenVisible('[data-testid="confirm-ok"]');
    const saved = await browser.waitUntil(
      () => browser.execute((id) => {
        const x = window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id);
        return x?.role === "maintainer" ? x : false;
      }, taskId!),
      { timeout: 10_000, timeoutMsg: "the role never saved on the existing task" },
    ) as { sandbox_mode?: string; sandbox_block_keychain?: boolean };
    expect(saved.sandbox_mode).toBe("enforce-fs");
    expect(saved.sandbox_block_keychain).toBe(true);
    await waitGone(sb);
  });

  it("switches the role of a caged task with Save & restart", async () => {
    // already Enforcing (FS) with the Keychain blocked and a live terminal:
    // a different role through the restarting save.
    const sb = '[role="dialog"]:has([data-testid="sandbox-save-no-restart"])';
    const role = () => browser.execute((id) =>
      window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.role ?? null, taskId!);
    expect(await role()).toBe("maintainer");
    await browser.execute((id) => window.__termic!.useUI.getState().openSandbox(id), taskId!);
    // Reviewer is the project default here, so it saves as inherit (null).
    await clickWhenVisible(`${sb} [data-role-option="reviewer"]`);
    await browser.execute((s) => {
      const b = [...document.querySelectorAll(`${s} button`)].find(x => x.textContent?.includes("Save & restart")) as HTMLButtonElement;
      b.click();
    }, sb);
    await clickWhenVisible('[data-testid="confirm-ok"]');
    await waitGone(sb);
    expect(await role()).toBeNull();
    // the SAVED role; data-role is what a live broker runs, which for a shell
    // the save does not restart stays the old one until it respawns.
    await waitVisible(`[data-task-id="${taskId}"] [data-testid="secrets-chip"][data-saved-role="reviewer"]`);
  });

  it("Allow from the popover sticks, Pause holds until resumed, a switch reads as pending", async () => {
    // an agent tab opened now spawns under the cage with the Reviewer broker
    // (shell tabs are never caged). Through gh's socket it asks for a merge,
    // which Reviewer's fallback denies before any network: the fixture's
    // `#sh` runs it inside the cage, so the peer check, the spawn dir's
    // profile rules and the placeholder are all the real ones.
    const shellTab = "e2e-broker-agent";
    const chip = `[data-task-id="${taskId}"] [data-testid="secrets-chip"]`;
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

    await clickWhenVisible(chip);
    await waitVisible('[data-testid="secrets-popover"] [data-testid="secrets-allow"]');
    // the row names the secret, not its id.
    expect(await browser.execute(() => document.querySelector('[data-testid="secrets-popover"]')?.textContent ?? ""))
      .toContain("api.github.com · gh-review");
    await snap("secrets-popover-blocked.png");
    await clickWhenVisible('[data-testid="secrets-popover"] [data-testid="secrets-allow"]');
    await browser.waitUntil(() => browser.execute(async () => {
      const s = await window.__termic!.ipc.settingsLoad();
      const rule = s.roles?.find((r: any) => r.id === "reviewer")?.rule_sets
        .find((rs: any) => rs.host === "api.github.com")?.rules[0];
      return rule?.effect === "allow" && rule.methods.join() === "PUT" && rule.pattern === "/repos/acme/widget/pulls/1/merge";
    }), { timeout: 10_000, timeoutMsg: "the allow never landed on the role" });
    // and the row stays gone: Rust dropped the blocked entry, so the next
    // polls (1.5s popover, 2s footer) do not bring it back.
    await browser.waitUntil(() => counts().then(c => c.blocked === 0),
      { timeout: 10_000, timeoutMsg: "the blocked count never dropped after Allow" });
    await browser.pause(3_200);
    expect(await browser.execute(() => !!document.querySelector('[data-testid="secrets-allow"]'))).toBe(false);

    // Pause refuses every brokered request until Resume, live.
    await clickWhenVisible('[data-testid="secrets-pause"]');
    await waitVisible('[data-testid="secrets-paused-banner"]');
    await browser.waitUntil(() => counts().then(c => c.paused === true),
      { timeout: 5_000, timeoutMsg: "Pause never reached the broker" });
    await snap("secrets-popover-paused.png");
    await clickWhenVisible('[data-testid="secrets-pause"]');
    await waitGone('[data-testid="secrets-paused-banner"]');
    await browser.waitUntil(() => counts().then(c => c.paused === false),
      { timeout: 5_000, timeoutMsg: "Resume never reached the broker" });

    // a switch saves the new role but the live broker keeps the old one, so
    // the chip says so instead of claiming the new role is in force.
    const pickRole = (id: string) => browser.execute((rid) => {
      const trigger = document.querySelector('[data-testid="secrets-switch-role"]') as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      trigger.dispatchEvent(new PointerEvent("pointerdown", opts));
      trigger.dispatchEvent(new PointerEvent("pointerup", opts));
      trigger.click();
      return rid;
    }, id).then(async rid => {
      await clickWhenVisible(`[role="menu"] [data-role-option="${rid}"]`);
    });
    await pickRole("maintainer");
    await waitVisible(`${chip}[data-saved-role="maintainer"][data-role="reviewer"] [data-testid="secrets-chip-pending"]`);
    await waitVisible('[data-testid="secrets-pending-banner"]');
    await snap("secrets-popover-pending.png");
    await pickRole("reviewer");
    await waitGone('[data-testid="secrets-pending-banner"]');
    await waitGone(`${chip} [data-testid="secrets-chip-pending"]`);

    await browser.keys("Escape");
    await waitGone('[data-testid="secrets-popover"]');
    await browser.execute((id, tab) => window.__termic!.useApp.getState().closeTab(id, tab), taskId!, shellTab);
  });

  it("picks where an Allow saves with the same radio list as the sandbox popover", async () => {
    // collapsed it reads "Saving to <scope> · Change"; Change opens the radio
    // list, a pick collapses it again. Default is the role.
    const scope = '[data-testid="secrets-popover"] [data-testid="secrets-scope"]';
    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="secrets-chip"]`);
    await waitVisible(scope);
    expect(await browser.execute((s) => document.querySelector(s)?.textContent ?? "", scope)).toContain("Role: Reviewer");
    await clickWhenVisible('[data-testid="secrets-popover"] [data-testid="secrets-scope-change"]');
    await waitVisible(`${scope} [data-scope-option="task"]`);
    expect(await attr(`${scope} [data-scope-option="role"]`, "aria-checked")).toBe("true");
    expect(await browser.execute((s) => document.querySelector(s)?.textContent ?? "", `${scope} [data-scope-option="role"]`))
      .toMatch(/Every task on this role \(\d+ tasks?\)/);
    await snap("secrets-scope-picker.png");
    await clickWhenVisible(`${scope} [data-scope-option="task"]`);
    await waitGone(`${scope} [data-scope-option="task"]`);
    expect(await browser.execute((s) => document.querySelector(s)?.textContent ?? "", scope)).toContain("This task");
    await browser.keys("Escape");
    await waitGone('[data-testid="secrets-popover"]');
  });

  it("the role name in the popover opens Settings on that role", async () => {
    const editing = () => browser.execute(() => (document.querySelector('[data-testid="role-name"]') as HTMLInputElement)?.value ?? null);
    await clickWhenVisible(`[data-task-id="${taskId}"] [data-testid="secrets-chip"]`);
    await clickWhenVisible('[data-testid="secrets-popover"] [data-testid="secrets-role-link"]');
    await waitGone('[data-testid="secrets-popover"]');
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

  it("adding a role with Save & restart brings every agent back on its own", async () => {
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
      await clickWhenVisible(`${sb} [data-role-option="maintainer"]`);
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
        window.__termic!.useApp.getState().tasks.find((x: any) => x.id === id), agentTask) as { role?: string | null };
      expect(t.role).toBe("maintainer");
    } finally {
      await archiveTask(agentTask);
    }
  });
});
