// Secrets, shell side (docs/sandbox.md "Shells"): a shell gets nothing until
// the user starts it with a role, a role shell holds placeholders only, its
// badge rides its own tab and never the status bar, its blocked requests are
// its own (not the agent's), switching its role restarts it, and an rc file
// exporting GH_TOKEN shows the banner. macOS only, like the broker.
//
// Requests go to the shell's own gh socket with curl, the way gh sends them.
// Every one of them is refused by the role (or by pause) before the broker
// dials anything, so nothing here reaches the network. Placeholder names only.
import fs from "node:fs";
import path from "node:path";
import {
  archiveTask, clickMenuItemUntilReady, clickWhenVisible, openTask, requireTermicApi, setInputValue, snap, textOf,
  waitForAppShell, waitGone, waitVisible,
} from "../helpers";

(process.platform !== "darwin" ? describe.skip : describe)("secrets: shell roles", () => {
  let taskId = "";
  let prevSettings = "";
  const out = (name: string) => path.resolve(".e2e", "artifacts", `shell-${name}.txt`);
  const pill = (tab: string) => `[data-task-id="${taskId}"] [data-tab-id="${tab}"]`;
  const badge = (tab: string) => `${pill(tab)} [data-testid="shell-role-badge"]`;

  /** Main-area tabs of the task that are shells, in order. */
  const shellTabs = () => browser.execute((id) =>
    (window.__termic!.useApp.getState().tabs[id] ?? [])
      .filter((t: any) => t.type === "terminal" && t.cli === "shell")
      .map((t: any) => ({ id: t.id as string, role: (t.secretsRole ?? null) as string | null })), taskId) as Promise<{ id: string; role: string | null }[]>;

  /** Wait for a tab's shell to print something (its prompt), then type `line`. */
  async function runIn(tab: string, line: string) {
    await browser.waitUntil(() => browser.execute((id, tb) =>
      !!(window.__termic!.useApp.getState().tabs[id] ?? []).find((t: any) => t.id === tb && t.ptyId && t.firstOutputAt), taskId, tab),
    { timeout: 20_000, timeoutMsg: `shell ${tab} never came up` });
    await browser.execute(async (id, tb, l) => {
      const t = window.__termic!;
      const tabRec = t.useApp.getState().tabs[id].find((x: any) => x.id === tb);
      await t.ipc.ptyWrite(tabRec.ptyId, Array.from(new TextEncoder().encode(`${l}\r`)));
    }, taskId, tab, line);
  }

  /** Run `cmd` in the shell with its output in a file, and read it back. */
  async function capture(tab: string, name: string, cmd: string): Promise<string> {
    const f = out(name);
    fs.rmSync(f, { force: true });
    // written to .tmp first, so a half-written file is never read.
    await runIn(tab, `${cmd} > '${f}.tmp' 2>&1; mv '${f}.tmp' '${f}'`);
    await browser.waitUntil(async () => fs.existsSync(f), { timeout: 15_000, timeoutMsg: `${name}: no output from the shell` });
    return fs.readFileSync(f, "utf8");
  }

  /** Screenshots are fixtures: a fixed tab title and prompt, so neither the
   *  shell's OSC title nor its prompt puts this machine's user@host in one. */
  async function tidy(tab: string) {
    await browser.execute((id, tb) => window.__termic!.useApp.getState().renameTab(id, tb, "Terminal"), taskId, tab);
    await runIn(tab, "PROMPT='$ '; PS1='$ '; clear");
  }

  // curl to this shell's gh socket, as gh would send it.
  const ghCurl = (method: string, p: string, token = "$GH_TOKEN") =>
    `curl -s --unix-socket "$(sed -n 's/^http_unix_socket: //p' "$GH_CONFIG_DIR/config.yml")" -X ${method} -H "Authorization: token ${token}" http://api.github.com${p}`;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    fs.mkdirSync(path.resolve(".e2e", "artifacts"), { recursive: true });
    prevSettings = await browser.execute(async () => JSON.stringify(await window.__termic!.ipc.settingsLoad()));
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.ipc.settingsLoad();
      // only api.github.com: no git route, so no proxy and no CA either.
      const gh = (id: string) => ({ id, name: id, kind: "generic", service: "gh:github.com", account: "alice", recipe: "github", hosts: ["api.github.com"] });
      await t.ipc.settingsSave({
        ...s,
        secrets: [gh("gh-deploy"), gh("gh-review")],
        roles: [
          { id: "deploy", name: "Deploy", colour: "teal", secrets: ["gh-deploy"],
            rule_sets: [{ secret: "gh-deploy", host: "api.github.com", fallback: "deny", rules: [
              { effect: "allow", methods: ["GET"], pattern: "/**", note: "read" },
            ] }] },
          { id: "review", name: "Reviewer", colour: "purple", secrets: ["gh-review"], rule_sets: [] },
        ],
      } as any);
      t.useApp.getState().openSettings();
      t.useApp.getState().closeSettings();
    });
    taskId = await openTask("secrets-shell", true, "fakeagent");
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    await browser.execute(async (prev) => {
      const t = window.__termic!;
      await t.ipc.settingsSave(JSON.parse(prev));
      t.useApp.getState().openSettings();
      t.useApp.getState().closeSettings();
    }, prevSettings);
    for (const f of fs.readdirSync(path.resolve(".e2e", "artifacts"))) {
      if (f.startsWith("shell-") && f.endsWith(".txt")) fs.rmSync(path.resolve(".e2e", "artifacts", f), { force: true });
    }
  });

  let plainTab = "";
  it("a plain shell gets none of it", async () => {
    plainTab = await browser.execute((id) => {
      const t = window.__termic!;
      const tab = crypto.randomUUID();
      t.useApp.getState().addTab(id, { id: tab, type: "terminal", title: "Terminal", cli: "shell" });
      return tab;
    }, taskId);
    await tidy(plainTab);
    const env = await capture(plainTab, "plain-env", "env");
    expect(env).toContain("PATH=");
    expect(env).not.toContain("termic_ph_");
    expect(env).not.toContain("TERMIC_SECRETS_ROLE");
    expect(env).not.toContain("GH_CONFIG_DIR=/private/tmp/termic-");
    expect(env).not.toMatch(/https?_proxy=http:\/\/termic:/i);
    expect(await browser.execute((s) => !!document.querySelector(s), badge(plainTab))).toBe(false);
  });

  const palette = '[data-testid="new-tab-palette"]';
  // closed first (and seen gone, so the open is a fresh mount), so every
  // case starts on the default list.
  const openPalette = async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeNewTabPalette());
    await waitGone(palette);
    await browser.execute((id) => window.__termic!.useUI.getState().openNewTabPalette(id), taskId);
  };
  const rowKinds = () => browser.execute((s) => [...document.querySelectorAll(`${s} [data-row]`)].map(e => e.getAttribute("data-kind")), palette);
  // the mouse path into the roles list (the keyboard path is →).
  const openRoles = async () => {
    await openPalette();
    await clickWhenVisible(`${palette} [data-testid="new-tab-with-secrets"]`);
    await waitVisible(`${palette} [data-role-mode]`);
  };

  it("⌘T keeps every agent's number: roles are behind → on Terminal", async () => {
    await openPalette();
    await waitVisible(`${palette} [data-row="0"]`);
    const kinds = await rowKinds();
    expect(kinds).not.toContain("shell_role");
    expect(kinds[0]).toBe("shell");
    expect(kinds[1]).toBe("agent");
    await waitVisible(`${palette} [data-testid="new-tab-with-secrets"]`);
    await snap("secrets-shell-01-launcher.png");
    // → on the selected Terminal row swaps in the roles, numbered from 1.
    // focus the query box (setInputValue focuses), then →.
    await setInputValue(`${palette} input`, "");
    await browser.keys(["ArrowRight"]);
    await waitVisible(`${palette} [data-role-mode]`);
    // one row per role (the fixture has Deploy and Review), nothing else.
    const roleKinds = await rowKinds();
    expect(roleKinds.length).toBeGreaterThan(1);
    expect(roleKinds.every(k => k === "shell_role")).toBe(true);
    expect(await textOf(palette)).toContain("Deploy");
    expect(await textOf(palette)).toContain("Uses your gh login.");
    await snap("secrets-shell-01b-roles.png");
    // Esc goes back to the list, not out of the palette.
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await browser.execute((s) => !!document.querySelector(`${s} [data-role-mode]`), palette)),
      { timeout: 5_000, timeoutMsg: "Esc did not leave the roles list" });
    expect((await rowKinds())[1]).toBe("agent");
  });

  it("typing a role name finds it from the main list", async () => {
    await openPalette();
    await waitVisible(`${palette} [data-row="0"]`);
    await setInputValue(`${palette} input`, "deplo");
    await browser.waitUntil(async () => (await rowKinds()).includes("shell_role"),
      { timeout: 5_000, timeoutMsg: "typing never surfaced the role row" });
    expect(await textOf(palette)).toContain("Terminal as Deploy");
    await browser.keys(["Escape"]);
  });

  let roleTab = "";
  it("the launcher starts a shell that holds placeholders only", async () => {
    await openRoles();
    const before = (await shellTabs()).map(t => t.id);
    // retried until the tab exists: a click into the palette's remount is lost.
    await clickMenuItemUntilReady("Deploy", async () => (await shellTabs()).some(t => !before.includes(t.id)), {
      reopen: openRoles,
    });
    const fresh = (await shellTabs()).find(t => !before.includes(t.id))!;
    expect(fresh.role).toBe("deploy");
    roleTab = fresh.id;
    await tidy(roleTab);
    const env = await capture(roleTab, "role-env", "env");
    expect(env).toMatch(/^GH_TOKEN=termic_ph_[0-9a-f]{32}$/m);
    expect(env).toContain("TERMIC_SECRETS_ROLE=Deploy");
    expect(env).toMatch(/^GH_CONFIG_DIR=\/private\/tmp\/termic-\d+\/[0-9a-f]{12}\/gh$/m);
    // not caged: none of the cage's vars.
    expect(env).not.toContain("TERMIC_SANDBOX");
    await waitVisible(badge(roleTab));
    expect(await textOf(badge(roleTab))).toContain("Deploy");
  });

  it("the badge rides the shell's tab, never the status bar", async () => {
    const footer = `[data-task-id="${taskId}"] [data-testid="task-footer"]`;
    const footerText = await browser.execute((s) => document.querySelector(s)?.textContent ?? "", footer);
    expect(footerText).not.toContain("Deploy");
    await snap("secrets-shell-02-badge.png");
  });

  it("a blocked request counts on the shell, not on the agent", async () => {
    const resp = await capture(roleTab, "blocked", ghCurl("DELETE", "/repos/acme/widget"));
    expect(resp).toContain('blocked by Termic role "Deploy"');
    await browser.waitUntil(async () => (await textOf(`${badge(roleTab)} [data-testid="shell-role-blocked"]`).catch(() => "")).includes("1"),
      { timeout: 10_000, timeoutMsg: "the shell's badge never counted the block" });
    const agent = await browser.execute(async (id) => window.__termic!.ipc.brokerCounts(id), taskId);
    expect(agent.blocked).toBe(0);
    await snap("secrets-shell-03-blocked.png");
  });

  it("the shell's badge opens Activity on that shell, which allows on the role only", async () => {
    await clickWhenVisible(badge(roleTab));
    const act = '[data-testid="cage-activity"]';
    await waitVisible(act);
    // pre-filtered to this shell.
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("data-value") ?? "", `${act} [data-testid="activity-who"]`)).toMatch(new RegExp(`${roleTab}$`));
    const row = `${act} [data-testid="activity-row"][data-kind="rule"][data-who="shell"]`;
    await browser.waitUntil(async () => (await textOf(row).catch(() => "")).includes("/repos/acme/widget"),
      { timeout: 10_000, timeoutMsg: "the blocked row never reached Activity" });
    expect(await textOf(row)).toContain("DELETE");
    // the role may be shared, so a shell's Allow never acts on a default.
    expect(await browser.execute((b) => document.querySelector(b)?.getAttribute("data-scope"), `${row} [data-testid="secrets-allow"]`)).toBe(null);
    // one scope only: a shell has no task allows, so the menu offers the role.
    await browser.execute((s) => {
      const trigger = document.querySelector(s) as HTMLElement;
      const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
      trigger.dispatchEvent(new PointerEvent("pointerdown", opts));
      trigger.dispatchEvent(new PointerEvent("pointerup", opts));
      trigger.click();
    }, `${row} [data-testid="secrets-allow-scope"]`);
    await waitVisible('[data-testid="allow-scope-menu"] [data-scope-option="role"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="allow-scope-menu"] [data-scope-option="task"]'))).toBe(false);
    await snap("secrets-shell-07-activity.png");
    await clickWhenVisible('[data-testid="allow-scope-menu"] [data-scope-option="role"]');
    // the row stays, its button now the undo.
    await browser.waitUntil(() => browser.execute((b) => document.querySelector(b)?.getAttribute("data-allowed") === "role", `${row} [data-testid="secrets-allow"]`),
      { timeout: 10_000, timeoutMsg: "the shell's row never showed it allowed" });
    const rules = await browser.execute(async () => {
      const s = await window.__termic!.ipc.settingsLoad();
      return JSON.stringify((s.roles as any[]).find(r => r.id === "deploy").rule_sets);
    });
    expect(rules).toContain("/repos/acme/widget");
    // pause belongs to the shell picked in Who, and refuses its brokered
    // requests, live.
    await clickWhenVisible(`[data-testid="secrets-pause"]`);
    await waitVisible(`${act} [data-testid="secrets-paused-banner"]`);
    const paused = await capture(roleTab, "paused", ghCurl("GET", "/user"));
    expect(paused).toContain("secrets are paused");
    await clickWhenVisible(`[data-testid="secrets-pause"]`);
    await waitGone(`${act} [data-testid="secrets-paused-banner"]`);
    await clickWhenVisible(`${act} [data-testid="activity-close"]`);
    await waitGone(act);
  });

  it("gh sending its own token shows the rc-file banner", async () => {
    // what an rc file exporting GH_TOKEN after Termic looks like on the socket.
    const resp = await capture(roleTab, "foreign", ghCurl("DELETE", "/repos/acme/widget", "gho_FROMZSHRC"));
    expect(resp).toContain("blocked by Termic role");
    const banner = `[data-task-id="${taskId}"] [data-testid="shell-rc-banner"]`;
    await waitVisible(banner);
    expect(await textOf(banner)).toContain("~/.zshrc");
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("data-state-kind"), badge(roleTab))).toBe("foreign");
    await snap("secrets-shell-04-rc-banner.png");
    await clickWhenVisible(`${banner} [data-testid="shell-rc-dismiss"]`);
    await waitGone(banner);
  });

  it("switching the role confirms what still runs, then restarts the shell", async () => {
    await runIn(roleTab, "sleep 600 &");
    // the job is a child of the shell once `pty_children` sees it.
    await browser.waitUntil(() => browser.execute(async (id, tb) => {
      const t = window.__termic!;
      const p = t.useApp.getState().tabs[id].find((x: any) => x.id === tb).ptyId;
      return (await t.invoke("pty_children", { id: p }) as string[]).includes("sleep");
    }, taskId, roleTab), { timeout: 10_000, timeoutMsg: "sleep never showed under the shell" });
    const oldPty = await browser.execute((id, tb) => window.__termic!.useApp.getState().tabs[id].find((x: any) => x.id === tb).ptyId as string, taskId, roleTab) as string;
    await browser.execute((s) => {
      const el = document.querySelector(s) as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 5 }));
    }, pill(roleTab));
    await clickWhenVisible('[data-testid="shell-restart-secrets"]');
    await waitVisible('[data-testid="shell-role-review"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="shell-role-deploy"]'))).toBe(false);
    await snap("secrets-shell-05-restart-menu.png");
    await clickWhenVisible('[data-testid="shell-role-review"]');
    await browser.waitUntil(() => browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(d => d.textContent?.includes("Restart this shell as Reviewer?"))),
    { timeout: 8_000, timeoutMsg: "no restart confirm" });
    expect(await browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(d => d.textContent?.includes("Restart this shell as Reviewer?"))?.textContent ?? "")).toContain("sleep");
    await snap("secrets-shell-06-restart-confirm.png");
    await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(x => x.textContent?.includes("Restart this shell as Reviewer?"));
      ([...(d?.querySelectorAll("button") ?? [])].find(b => b.textContent?.trim() === "Restart shell") as HTMLButtonElement | undefined)?.click();
    });
    await browser.waitUntil(async () => (await shellTabs()).find(t => t.id === roleTab)?.role === "review", { timeout: 8_000, timeoutMsg: "the role never switched" });
    await browser.waitUntil(() => browser.execute((id, tb, old) => {
      const p = window.__termic!.useApp.getState().tabs[id].find((x: any) => x.id === tb).ptyId;
      return !!p && p !== old;
    }, taskId, roleTab, oldPty), { timeout: 15_000, timeoutMsg: "the shell never respawned" });
    await tidy(roleTab);
    const env = await capture(roleTab, "switched-env", "env");
    expect(env).toContain("TERMIC_SECRETS_ROLE=Reviewer");
    expect(await textOf(badge(roleTab))).toContain("Reviewer");
  });

  it("No secrets turns it back into a plain shell", async () => {
    const oldPty = await browser.execute((id, tb) => window.__termic!.useApp.getState().tabs[id].find((x: any) => x.id === tb).ptyId as string, taskId, roleTab) as string;
    await browser.execute((s) => {
      const el = document.querySelector(s) as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 20, clientY: r.top + 5 }));
    }, pill(roleTab));
    await clickWhenVisible('[data-testid="shell-restart-secrets"]');
    await clickWhenVisible('[data-testid="shell-role-none"]');
    // nothing runs under the fresh shell, so no confirm.
    await browser.waitUntil(async () => (await shellTabs()).find(t => t.id === roleTab)?.role === null, { timeout: 8_000, timeoutMsg: "the role was never cleared" });
    await waitGone(badge(roleTab));
    await browser.waitUntil(() => browser.execute((id, tb, old) => {
      const p = window.__termic!.useApp.getState().tabs[id].find((x: any) => x.id === tb)?.ptyId;
      return !!p && p !== old;
    }, taskId, roleTab, oldPty), { timeout: 15_000, timeoutMsg: "the shell never respawned" });
    const env = await capture(roleTab, "cleared-env", "env");
    expect(env).not.toContain("termic_ph_");
    expect(env).not.toContain("TERMIC_SECRETS_ROLE");
  });
});
