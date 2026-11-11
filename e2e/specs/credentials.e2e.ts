import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  clickWhenVisible, dismissOverlays, requireTermicApi, snap, waitForText,
  waitForAppShell, waitVisible, waitGone, submitToAgent, waitForAgentReady,
  waitTaskUnmounted,
} from "../helpers";

// The account switcher (GH #278): several credential sets per agent, and a
// one-click switch.
//
// This spec OWNS a global mutation, the account list on an agent entry, so
// teardown clears it whatever the body left behind. The login STORES under
// `logins/` are deliberately not removed by a remove: they are global and
// shared by name, so dropping one would log another profile out of an account
// it never touched. Nothing here signs in, so nothing here creates one.

const AGENT = "claude";
/** Fixture agents that EXTEND the real ones, so they inherit their login
 *  SHAPE through `base_agent_id` while spawning a script. Three of them
 *  because the shape differs: claude relocates CLAUDE_CONFIG_DIR, codex
 *  CODEX_HOME, devin XDG_DATA_HOME. */
const FAKE_CLAUDE = "fakeclaude";
const FAKE_CODEX = "fakecodex";
const FAKE_DEVIN = "fakedevin";
/** A grok clone: an agent whose footer has a CONTEXT source and no usage one,
 *  which is the case "Usage unknown" used to skip entirely. */
const FAKE_GROK = "fakegrok";
/** The plain fixture agent, which has NO measured login store. */
const FAKE_AGENT = "fakeagent";

async function clearAccounts(agent = AGENT): Promise<void> {
  await browser.execute(async (agent) => {
    const t = window.__termic!;
    const v = await t.invoke("agent_accounts", { agentId: agent, docker: false });
    for (const a of (v.accounts ?? [])) {
      try { await t.invoke("account_remove", { agentId: agent, name: a.name }); } catch { /* gone */ }
    }
  }, agent);
}

/** "Personal" (ADOPTED: the login the agent already had, relocates nothing),
 *  plus "Work" and "Client", which are real stores. Three because two of them
 *  have to be non-adopted to prove two accounts get two DIRECTORIES. */
async function addAccounts(agent: string): Promise<void> {
  await clearAccounts(agent);
  await browser.execute(async (a) => {
    const t = window.__termic!;
    await t.invoke("account_add", { agentId: a, name: "Personal" });
    await t.invoke("account_add", { agentId: a, name: "Work" });
    await t.invoke("account_add", { agentId: a, name: "Client" });
    await t.invoke("account_set_default", { agentId: a, name: "Work" });
  }, agent);
}

function accountsFor(agent: string): Promise<any> {
  return browser.execute(async (a) =>
    window.__termic!.invoke("agent_accounts", { agentId: a, docker: false }), agent);
}

/** The open usage panel sits wholly inside the window and ABOVE its chip.
 *  Measured rather than eyeballed: a panel whose content arrives after it
 *  opens can be placed for its empty size and then grow off the bottom. */
async function panelGeometry(): Promise<{ inside: boolean; aboveChip: boolean; detail?: string }> {
  return await browser.execute(() => {
    const panel = document.querySelector('[data-testid="usage-detail"]')?.parentElement;
    // The chip that PAINTS: every task the user visited stays mounted with a
    // footer of its own, and the first match in the DOM can be a hidden one.
    const chip = [...document.querySelectorAll('[data-testid="usage-chip"]')]
      .find(el => el.getClientRects().length > 0);
    if (!panel || !chip) return { inside: false, aboveChip: false, detail: `panel=${!!panel} chip=${!!chip}` };
    const p = panel.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const inside = p.top >= 0 && p.bottom <= window.innerHeight;
    const aboveChip = p.bottom <= c.top + 1;
    return inside && aboveChip
      ? { inside, aboveChip }
      : { inside, aboveChip, detail: `panel=${Math.round(p.top)}..${Math.round(p.bottom)} chip.top=${Math.round(c.top)} vh=${window.innerHeight}` };
  });
}

async function openTaskWith(agent: string, name: string): Promise<string> {
  return await browser.execute(async (a, n) => {
    const t = window.__termic!;
    const proj = t.useApp.getState().projects.find((p: any) => p.name === "fixture-repo");
    const ws = await t.invoke("task_open_repo", { projectId: proj.id, cli: a, name: n });
    await t.useApp.getState().loadAll();
    const s = t.useApp.getState();
    (s.setActiveTask ?? s.setActiveWorkspace)?.call(s, ws.id);
    return ws.id as string;
  }, agent, name);
}

async function removeTask(id: string | null): Promise<void> {
  if (!id) return;
  await browser.execute(async (i) => {
    const t = window.__termic!;
    try { await t.invoke("task_archive", { id: i, deleteBranch: false }); } catch { /* gone */ }
    try { await t.invoke("task_delete", { id: i }); } catch { /* gone */ }
    await t.useApp.getState().loadAll();
  }, id);
}

async function setTaskAccount(taskId: string, agent: string, name: string): Promise<void> {
  await browser.execute(async (id, a, n) => {
    await window.__termic!.invoke("task_set_account", { id, agentId: a, name: n });
  }, taskId, agent, name);
}

function pillAccount(): Promise<string | null> {
  return browser.execute(() =>
    document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-account") ?? null);
}

/** The account the footer's NUMBERS belong to: the running process's login,
 *  which differs from `pillAccount` exactly while a switch is staged. */
function pillUsageAccount(): Promise<string> {
  return browser.execute(() =>
    document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-account") ?? "");
}

/** Wait until the task's agent process has actually SPAWNED on `account`.
 *
 *  Read from the tab, which is where `pty_spawn` records what it resolved,
 *  because the pill's attribute falls back to the CONFIGURED account before
 *  the first spawn and would answer "Work" for a process that does not exist
 *  yet. Setup, not an assertion: the assertions below are all on the DOM. */
async function waitForSpawnOn(taskId: string, account: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((id, want) => {
    const tabs = (window.__termic!.useApp.getState().tabs[id] || []) as any[];
    return tabs.some(t => t.ptyId && t.liveAccount === want);
  }, taskId, account), { timeout: 30_000, timeoutMsg: `no agent ever spawned on ${account}` });
}

/** The account the pill is OFFERING to move to, "" when it is offering
 *  nothing. Asserted rather than the amber styling: a colour assertion would
 *  pass on a pill that offered the wrong account. */
function pillOffering(): Promise<string> {
  return browser.execute(() =>
    document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-offering") ?? "");
}

/** The value the SPAWNED PROCESS actually received, read from the log the
 *  fixture agent appends to. Terminal output is a WebGL canvas, so this is the
 *  only way to see what the child got. */
async function loginEnvFor(taskId: string, envVar: string): Promise<string | null> {
  const raw = readFileSync(join(dataDir, "e2e-agent-login.log"), "utf8").trim();
  const lines = raw.split("\n").filter(l => l.startsWith(taskId + "\t"));
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const field = last.split("\t").find(f => f.startsWith(envVar + "="));
  const value = field?.slice(envVar.length + 1) ?? "";
  return value || null;
}

/** Restart the task's agent, which is what picks up a switched account.
 *
 *  Uses `stopTask`, the app's own eviction (GH #119): it unmounts the TaskView
 *  so every PTY dies, and re-activating spawns fresh ones. Killing the PTY
 *  directly leaves the tab dead instead, because nothing asks for a new one. */
async function respawn(taskId: string): Promise<void> {
  await browser.execute(async (id) => {
    const s = window.__termic!.useApp.getState();
    s.stopTask(id);
    s.setActiveTask(null);
  }, taskId);
  await waitTaskUnmounted(taskId);
  await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
}

/** Make an account look SIGNED IN, by writing into the store the agent would
 *  have written into itself.
 *
 *  Needed because `account_add` deliberately creates an empty directory and
 *  nothing else: termic never handles a credential, it makes a place for the
 *  agent to put one. An empty store reads as "named, not signed in", which is
 *  correct and is also why no e2e-created account is ever a switch candidate
 *  until this runs. The file's CONTENT is irrelevant (`account_signed_in`
 *  looks for any entry at all), so this writes a marker rather than anything
 *  shaped like a credential. */
function signIn(agent: string, name: string): void {
  const dir = join(dataDir, "logins", agent, name.toLowerCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".e2e-signed-in"), "not a credential\n");
}

/** Undo every `signIn`, which `clearAccounts` deliberately does NOT do.
 *
 *  Removing an account never removes its store: the store is global and shared
 *  by name, so dropping one would log another profile out of an account it
 *  never touched. Correct for the app, and a leak for this spec: a store left
 *  behind makes that account look signed in to every LATER test, which is
 *  exactly how "never offers an account nobody has signed into" passed against
 *  an account the previous case had signed in. Untracked files a spec creates
 *  are the spec's to remove. */
function signOutAll(agent: string): void {
  rmSync(join(dataDir, "logins", agent), { recursive: true, force: true, maxRetries: 10 });
}

/** Forget every usage reading. In-memory only, so this is the whole reset.
 *
 *  Readings outlive the task that produced them (that is the point: two tasks
 *  on one account share a number), so a case that seeds 96% leaves it there
 *  for the next one. Cost the first version of these cases three false
 *  failures, each looking like a different bug. */
async function resetUsage(): Promise<void> {
  // `cost` too: each session's first figure is the baseline the no-plan proof
  // rises from, so a total left over from the previous case would prove
  // something about this one.
  await browser.execute(() => window.__termic!.useAgentUsage.setState({ byAgent: {}, cost: {} }));
}

/** Seed a reading carrying COST, with or without plan windows.
 *
 *  Two shapes because the same dollar figure means two different things, and
 *  `sawPlan` is sticky per key, so each shape needs its own account. */
async function seedCost(
  agent: string, account: string | null, usd: number, withPlan: boolean, session = "sess-1",
): Promise<void> {
  await browser.execute((a, acct, c, plan, sess) => {
    window.__termic!.useAgentUsage.getState().report(a, acct, {
      session: plan ? { usedPercent: 9, resetsAt: Math.floor(Date.now() / 1000) + 3600 } : null,
      weekly: plan ? { usedPercent: 1, resetsAt: Math.floor(Date.now() / 1000) + 86400 } : null,
      sessionCostUsd: c,
    }, "statusline", sess);
  }, agent, account, usd, withPlan, session);
}

/** Seed a usage reading for one account, as the status line would.
 *
 *  Keyed by the account the PROCESS is running as, which is the same key the
 *  chip and the pill read. `null` is the agent's ordinary login. */
async function seedUsage(agent: string, account: string | null, pct: number): Promise<void> {
  await browser.execute((a, acct, p) => {
    window.__termic!.useAgentUsage.getState().report(a, acct, {
      session: { usedPercent: p, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      weekly: { usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    }, "statusline");
  }, agent, account, pct);
}

describe("agent credentials", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await clearAccounts();
  });

  after(async () => {
    await clearAccounts();
    // The login stores this spec created by hand. `clearAccounts` cannot do
    // it: removing an account deliberately leaves the store alone.
    for (const a of [AGENT, FAKE_CLAUDE, FAKE_CODEX, FAKE_DEVIN]) signOutAll(a);
    await dismissOverlays();
  });

  it("says one login, and offers a second, on the agent's own card", async () => {
    // Discovery for the six agents with no usage feed, and the canonical place
    // to manage them. At the TOP of the card: who this is signed in as reads
    // before how it runs.
    await openAgentsPage();
    // Dormant lives in the card HEADER, not a row of its own: almost every
    // install has one login for ever, and a full row for that costs space
    // above the fields people came to edit.
    await waitVisible(`[data-testid="agent-accounts-${AGENT}"]`);
    const label = await browser.execute((a) =>
      document.querySelector(`[data-testid="agent-accounts-${a}"]`)?.textContent ?? "", AGENT);
    expect(label).toContain("Second account");
    await snap("credentials-01-agent-card.png");
  });

  it("names the first credential set, and makes it the default", async () => {
    // The first account names the login the agent ALREADY has, so the user is
    // never shown a credential set they did not name. Same rule as the first
    // profile adopting the existing install.
    //
    // TWO names in one step, which is the whole shape of this form: naming
    // the current login alone leaves the user with one account and no second,
    // which is not a thing anyone came here to do. Asking for one name behind
    // a button reading "Second account" ended with the existing login renamed
    // and still no second account.
    // Started from the header, which is the only affordance while dormant.
    await clickWhenVisible(`[data-testid="agent-accounts-${AGENT}"]`);
    await setInput(`[data-testid="account-name-${AGENT}"]`, "Personal");
    await setInput(`[data-testid="account-second-${AGENT}"]`, "Work");
    // The confirm button, not Enter: `setInput` writes a value without moving
    // focus, so a keystroke would go wherever focus happened to be.
    await clickWhenVisible(`[data-testid="account-add-confirm-${AGENT}"]`);
    await waitVisible(`[data-testid="account-chip-${AGENT}-Personal"]`);
    await waitVisible(`[data-testid="account-chip-${AGENT}-Work"]`);

    const v = await accounts();
    expect(v.accounts.map((a: any) => a.name)).toEqual(["Personal", "Work"]);
    // The one that was ADOPTED is the default, not the one just created: the
    // agent is working right now, and a first switch nobody asked for is the
    // one way this feature could break a setup it was meant to extend.
    expect(v.accounts[0].isDefault).toBe(true);
    expect(v.accounts[1].isDefault).toBe(false);
    // Only the SECOND is a new login. The first was adopted, so it is the one
    // the agent already had, and nothing was created for it.
    expect(v.accounts[1].signedIn).toBe(false);
    // It ADOPTS the login the agent already has rather than creating an empty
    // one, so someone whose agent works fine is never told they are "not
    // signed in". Whether it reads as signed in depends on whether this
    // machine has claude set up at all, which a runner may not, so the
    // assertion is on the adoption rather than on the machine.
    const adopted = await browser.execute(async (agent) => {
      const s = await window.__termic!.invoke("settings_load");
      return (s.agents ?? []).find((a: any) => a.id === agent)?.adopted_account ?? null;
    }, AGENT);
    expect(adopted).toBe("Personal");
  });

  it("adds a further set from the row, and refuses names that collide on disk", async () => {
    // Every set after the first two comes from the row, which asks for one
    // name: there is no login left to adopt, so there is nothing to pair it
    // with. Enter, because a single field has nowhere else for focus to be.
    await clickWhenVisible(`[data-testid="account-add-${AGENT}"]`);
    await setInput(`[data-testid="account-name-${AGENT}"]`, "Client");
    await browser.keys(["Enter"]);
    await waitVisible(`[data-testid="account-chip-${AGENT}-Client"]`);
    await snap("credentials-02-two-accounts.png");
    const v2 = await accounts();
    expect(v2.accounts.find((a: any) => a.name === "Client").signedIn).toBe(false);

    // The name IS the key, so two names that slugify the same would share one
    // directory. Refused rather than silently merged.
    const err = await browser.execute(async (agent) => {
      try { await window.__termic!.invoke("account_add", { agentId: agent, name: "client" }); return null; }
      catch (e) { return String(e); }
    }, AGENT);
    expect(err).toBeTruthy();
    expect((await accounts()).accounts.length).toBe(3);
  });

  it("keeps the first one as the default until told otherwise", async () => {
    let v = await accounts();
    expect(v.accounts.find((a: any) => a.isDefault).name).toBe("Personal");
    await clickWhenVisible(`[data-testid="account-chip-${AGENT}-Work"] button`);
    await browser.waitUntil(async () => (await accounts()).accounts
      .find((a: any) => a.isDefault)?.name === "Work",
      { timeoutMsg: "clicking a chip did not make it the default" });
    v = await accounts();
    expect(v.accounts.find((a: any) => a.isDefault).name).toBe("Work");
  });

  // The footer pill is NOT driven here. Every task in the fixture runs
  // `fakeagent`, which has no measured login store, so the pill correctly
  // hides and a spec that forced it would be testing a task shape no user
  // has. Its rules (hidden below two accounts, switch calls task_set_account)
  // are covered in src/components/task/AccountPill.test.tsx, and the
  // resolution behind it (task override beats agent default) in lib.rs.

  it("shows the switcher in the task footer, and switches on one click", async () => {
    // Driven on `fakeclaude`, a fixture agent that EXTENDS claude. That is not
    // a shortcut: `base_agent_id` resolves it to claude, so it inherits
    // claude's real login shape from `agent_dirs::login_store` and this
    // exercises the actual resolution path, clone logic included, while
    // spawning a script instead of a real agent.
    await addAccounts(FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-pill");
    try {
      await waitVisible('[data-testid="usage-chip"]');
      await snap("credentials-05-footer-pill.png");
      expect(await pillAccount()).toBe("Work");

      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="account-pick-Personal"]');
      await snap("credentials-06-footer-switcher.png");
      await clickWhenVisible('[data-testid="account-pick-Personal"]');
      await browser.waitUntil(async () => (await pillAccount()) === "Personal",
        { timeoutMsg: "the switch did not take" });
      await snap("credentials-07-footer-switched.png");

      // The TASK changed, not the agent's default: every other task is
      // untouched, which is what makes this a per-task switch.
      const v = await accountsFor(FAKE_CLAUDE);
      expect(v.accounts.find((a: any) => a.isDefault).name).toBe("Work");
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
    }
  });

  it("puts the chosen account's login into the spawned process, per agent shape", async () => {
    // THE END-TO-END PROOF, and the only assertion covering the whole chain:
    // account chosen -> login_env computed -> pty_spawn applied -> the PROCESS
    // received it. Everything else only proves termic's own bookkeeping.
    //
    // Two agents on purpose, because the SHAPE differs: claude relocates
    // CLAUDE_CONFIG_DIR, codex relocates CODEX_HOME. A switcher that only ever
    // set one variable would pass a single-agent test.
    for (const [agent, envVar] of [[FAKE_CLAUDE, "CLAUDE_CONFIG_DIR"], [FAKE_CODEX, "CODEX_HOME"]] as const) {
      await addAccounts(agent);
      const taskId = await openTaskWith(agent, `acct-env-${agent}`);
      try {
        // Default is "Work", a real store.
        const first = await browser.waitUntil(
          async () => (await loginEnvFor(taskId, envVar)) || false,
          { timeout: 30_000, timeoutMsg: `${agent}: the spawn never recorded ${envVar}` },
        );
        expect(first.replace(/\\/g, "/")).toContain("/logins/");
        expect(first.replace(/\\/g, "/").endsWith(`/${agent}/work`)).toBe(true);

        // Switch to the other real store and respawn: the NEXT process gets a
        // DIFFERENT directory. A running process cannot have its environment
        // changed underneath it, which is why this lands on the next spawn.
        await setTaskAccount(taskId, agent, "Client");
        await respawn(taskId);
        const second = await browser.waitUntil(
          async () => {
            const v = await loginEnvFor(taskId, envVar);
            return v && v.replace(/\\/g, "/").endsWith("/client") ? v : false;
          },
          { timeout: 30_000, timeoutMsg: `${agent}: the respawn did not pick up the switch` },
        );
        expect(second).not.toBe(first);

        // And switching to the ADOPTED account relocates NOTHING: it is the
        // login the agent already had, so the right environment is no
        // override at all. Asserting a path here would enshrine the bug where
        // naming your existing login hands you an empty store.
        await setTaskAccount(taskId, agent, "Personal");
        await respawn(taskId);
        await browser.waitUntil(
          async () => (await loginEnvFor(taskId, envVar)) === null,
          { timeout: 30_000, timeoutMsg: `${agent}: the adopted account still relocated something` },
        );
      } finally {
        await removeTask(taskId);
        await clearAccounts(agent);
      }
    }
  });

  it("offers nothing at all for an agent that cannot hold a second login", async () => {
    // An agent whose boundary nobody has measured must NOT be offered a second
    // account: it would silently share one credential between them.
    //
    // And it says nothing either. A "One login" label sat in six agents'
    // headers forever, stating a limitation almost nobody was looking for.
    // Absence is the signal, the same way the profile chip does not exist
    // until there is a profile; the reasons live in docs/agent-accounts.md.
    await openAgentsPage(FAKE_AGENT);
    // The card is up (its Command field is the anchor), and the accounts
    // control is simply not in it.
    await waitVisible(`[data-agent-card="${FAKE_AGENT}"]`);
    const present = await browser.execute((a) => ({
      affordance: !!document.querySelector(`[data-testid="agent-accounts-${a}"]`),
      add: !!document.querySelector(`[data-testid="account-add-${a}"]`),
    }), FAKE_AGENT);
    expect(present.affordance).toBe(false);
    expect(present.add).toBe(false);
    await snap("credentials-08-unsupported.png");
  });

  it("warns when the variable it sets is broader than the agent", async () => {
    // opencode and muse ride a GENERIC XDG root that other tools in the same
    // environment also read. Admitting that beats presenting it as agent-local.
    // Accounts FIRST, then open the page: the row fetches on mount, so adding
    // them while it is already showing leaves it displaying the old state.
    await clearAccounts("opencode");
    await browser.execute(async () => {
      await window.__termic!.invoke("account_add", { agentId: "opencode", name: "Personal" });
      await window.__termic!.invoke("account_add", { agentId: "opencode", name: "Work" });
    });
    await openAgentsPage("opencode");
    await browser.waitUntil(async () => await browser.execute(() =>
      (document.querySelector('[data-testid="agent-accounts-opencode"]')?.textContent ?? "")
        .includes("other tools")),
      { timeoutMsg: "the shared-root warning never appeared" });
    await snap("credentials-09-shared-root-warning.png");
    await clearAccounts("opencode");
  });

  it("offers a second set from the usage popover, at the moment of need", async () => {
    // The best discovery vector, because a person opens that popover when they
    // are NEAR A LIMIT, which is exactly when a second account becomes
    // interesting. Seeded rather than waited for: no fixture agent reports a
    // real plan-usage reading.
    await addAccounts(FAKE_CLAUDE);
    await clearAccounts(FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-usage");
    try {
      await browser.execute((agent) => {
        window.__termic!.useAgentUsage.getState().report(agent, null, {
          session: { usedPercent: 96, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          weekly: { usedPercent: 41, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
        }, "statusline");
      }, FAKE_CLAUDE);
      await waitVisible('[data-testid="usage-chip"]');
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-add-credentials"]');
      await snap("credentials-10-usage-popover.png");
      // ...and it routes to Settings -> Agents, which is where the first extra
      // login is actually added. It cannot pre-select this agent's card: the
      // strip's selection is local component state, not the store.
      await clickWhenVisible('[data-testid="usage-add-credentials"]');
      await waitForText("Agents & Terminals");
    } finally {
      await removeTask(taskId);
      await dismissOverlays();
    }
  });

  it("calls devin's short window a day, and offers the automatic switch", async () => {
    // Devin's quota resets DAILY, so the footer's "5h" would misname the one
    // number it leads with. The transport is a pull on devin's own API, which
    // needs a credential the fixture cannot have, so the reading is seeded -
    // what this pins is the WIRING: a devin-based agent must reach the chip
    // with its own window name, keyed to the account it SPAWNED on, and with
    // `reportsUsage` set, which is what offers the opt-in.
    await resetUsage();
    await addAccounts(FAKE_DEVIN);
    signIn(FAKE_DEVIN, "Work");
    const taskId = await openTaskWith(FAKE_DEVIN, "devin-usage");
    try {
      // The report keys to the account the process is running as, so it has
      // to land after the spawn did: seeding on `null` while the process runs
      // on Work is a chip that never finds its reading.
      await waitForSpawnOn(taskId, "Work");
      await seedUsage(FAKE_DEVIN, "Work", 12);
      await waitVisible('[data-testid="usage-chip"]');
      const chip = await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.textContent ?? "");
      expect(chip).toContain("day");
      expect(chip).not.toContain("5h");
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitForText("Daily");
      await waitForText("resets daily");
      // `reportsUsage` flowing end to end is what puts the opt-in in this
      // panel; a devin row that forgot it would render the numbers alone.
      await waitVisible('[data-testid="account-auto-toggle"]');
      await snap("credentials-11-devin-day.png");
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_DEVIN);
      signOutAll(FAKE_DEVIN);
      await dismissOverlays();
    }
  });

  it("shows an uncapped devin plan's ACUs this period instead of 'Usage unknown'", async () => {
    // devin Enterprise is billed in ACUs with no quota: GetUserStatus answers
    // unlimited credits, no daily or weekly percentage, and `acuConsumed`
    // since `planStart`. The footer used to find no window and say "Usage
    // unknown" forever. Seeded for the same reason as the case above.
    await resetUsage();
    const taskId = await openTaskWith(FAKE_DEVIN, "devin-acu");
    try {
      // The ordinary login: the chip reads the key the process spawned on.
      await browser.waitUntil(async () => await browser.execute((id) =>
        ((window.__termic!.useApp.getState().tabs[id] || []) as any[]).some(t => t.ptyId && !t.liveAccount),
      taskId), { timeout: 30_000, timeoutMsg: "devin never spawned" });
      await browser.execute((a) => {
        window.__termic!.useAgentUsage.getState().report(a, null, {
          session: null, weekly: null, sessionCostUsd: null,
          consumed: { amount: 70.56, unit: "ACU", periodStart: 1894262400, periodEnd: 1896940800 },
        }, "rpc");
      }, FAKE_DEVIN);
      await waitVisible('[data-testid="usage-consumed"]');
      const chip = await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.textContent ?? "");
      expect(chip).toContain("70.6 ACU");
      expect(chip).not.toContain("Usage unknown");
      // No percentage: there is no cap for it to be a share of. The chip
      // writes an empty attribute, not a missing one, when it has no window.
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-session"))).toBe("");

      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-consumed-row"]');
      const row = await browser.execute(() =>
        document.querySelector('[data-testid="usage-consumed-row"]')?.textContent ?? "");
      expect(row).toContain("ACUs this billing period");
      expect(row).toContain("No quota on this plan.");
      expect(row).toContain("70.6 ACU");
      // The figure stays on one line beside its label.
      expect(await browser.execute(() => {
        const n = document.querySelector('[data-testid="usage-consumed-row"] > span:last-child') as HTMLElement;
        return n.getClientRects().length === 1 && n.offsetHeight < 24;
      })).toBe(true);
      // No quota means no "running low", so no nudge toward a second account.
      expect(await browser.execute(() => !!document.querySelector('[data-testid="usage-add-credentials"]'))).toBe(false);
      await snap("credentials-11b-devin-acu.png");
    } finally {
      await removeTask(taskId);
      await dismissOverlays();
    }
  });

  it("shows Codex credit budgets, their amounts and reset, and updates the warning", async () => {
    await resetUsage();
    await clearAccounts(FAKE_CODEX);
    const taskId = await openTaskWith(FAKE_CODEX, "codex-credits");
    const seedBudget = async (usedPercent: number, used: number) => {
      await browser.execute((agent, percent, amount) => {
        window.__termic!.useAgentUsage.getState().report(agent, null, {
          session: null, weekly: null, sessionCostUsd: null,
          budget: { usedPercent: percent, used: amount, limit: 8000, resetsAt: 1906502400 },
        }, "rpc");
      }, FAKE_CODEX, usedPercent, used);
    };
    try {
      await browser.waitUntil(async () => await browser.execute((id) =>
        ((window.__termic!.useApp.getState().tabs[id] || []) as any[]).some(t => t.ptyId && !t.liveAccount),
      taskId), { timeout: 30_000, timeoutMsg: "Codex fixture never spawned" });
      await seedBudget(8, 640.25);
      await waitVisible('[data-usage-window="credits"]');
      const chip = await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.textContent ?? "");
      expect(chip).toContain("8% credits");
      expect(chip).not.toContain("wk");
      expect(chip).not.toContain("Usage unknown");
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-budget-row"]');
      const row = await browser.execute(() =>
        document.querySelector('[data-testid="usage-budget-row"]')?.textContent ?? "");
      expect(row).toContain("Credit budget");
      expect(row).toContain("640.25 / 8,000 credits used");
      expect(row).toContain("2030");
      expect(row).toContain("Shared across Codex");
      expect((await panelGeometry()).inside).toBe(true);
      await snap("credentials-codex-credits.png");
      // An amount-only update must survive the store's equality bail.
      await seedBudget(8, 641);
      await waitForText("641 / 8,000 credits used");
      await seedBudget(97, 7760);
      await browser.waitUntil(async () => await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-level") === "critical"));
      await waitForText("Over 90% of the credit budget limit.");
      await snap("credentials-codex-credits-critical.png");
      await seedBudget(0, 0);
      await waitForText("0 / 8,000 credits used");
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.textContent ?? "")).toContain("0% credits");
    } finally {
      await removeTask(taskId);
      await dismissOverlays();
      await resetUsage();
    }
  });

  it("offers a switch, by name, once the running account is nearly out", async () => {
    // The manual half, and the one every agent gets. `switchCandidate` decides
    // WHICH account: the pill only renders the answer, so the assertion is on
    // the name it names.
    await resetUsage();
    await addAccounts(FAKE_CLAUDE);
    signIn(FAKE_CLAUDE, "Personal");
    signIn(FAKE_CLAUDE, "Client");
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-offer");
    try {
      await waitVisible('[data-testid="usage-chip"]');
      expect(await pillAccount()).toBe("Work");
      // Comfortable: no offer at all. Asserted BEFORE the limit, so a pill
      // that offered unconditionally could not pass this.
      await seedUsage(FAKE_CLAUDE, "Work", 40);
      expect(await pillOffering()).toBe("");

      await seedUsage(FAKE_CLAUDE, "Work", 96);
      await browser.waitUntil(async () => (await pillOffering()) !== "",
        { timeoutMsg: "the pill never offered a switch" });
      // "Client" comes after "Work" in the list, so the rotation reaches it
      // first. Naming the account is the point: an offer that just said
      // "switch" would make the user open the list to find out to what.
      expect(await pillOffering()).toBe("Client");

      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="account-switch-offer"]');
      await snap("credentials-12-switch-offer.png");
      await clickWhenVisible('[data-testid="account-switch-offer"]');
      await browser.waitUntil(async () => (await pillAccount()) === "Client",
        { timeoutMsg: "the offered switch did not take" });
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await dismissOverlays();
    }
  });

  it("never offers an account nobody has signed into", async () => {
    // The rule that keeps the feature from making things worse: an empty
    // store cannot start the agent at all, so moving to it would be a
    // downgrade from merely being near a limit.
    //
    // Run FROM the adopted account, which is the only arrangement that makes
    // this assertion mean anything. "Personal" is adopted, so it reports
    // signed in whenever the agent's own config dir exists (it IS the
    // pre-existing login, and relocates nothing), while "Work" and "Client"
    // are real stores that nothing has written to. Sitting on Personal leaves
    // two genuinely empty candidates and no signed-in one to fall back to.
    // The first version of this case sat on Work and was offered Personal,
    // which was the app being right and the spec being wrong.
    await resetUsage();
    signOutAll(FAKE_CLAUDE); // no store from an earlier case may survive here
    await addAccounts(FAKE_CLAUDE);
    await browser.execute(async (a) => {
      await window.__termic!.invoke("account_set_default", { agentId: a, name: "Personal" });
    }, FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-nosignin");
    try {
      await waitVisible('[data-testid="usage-chip"]');
      await browser.waitUntil(async () => (await pillAccount()) === "Personal",
        { timeoutMsg: "the task never landed on the adopted account" });
      // Asserted on the two stores this spec OWNS, not on the adopted one.
      // "Personal" is adopted, so it reports signed in exactly when the real
      // agent's config dir exists on this machine, which is true on a
      // developer's Mac and false on a CI runner that has never run claude.
      // Pinning it either way makes the spec pass in one place and fail in
      // the other, which is what it did. What the rule needs is that the two
      // empty stores are empty, and neither is offered.
      const v = await accountsFor(FAKE_CLAUDE);
      expect(v.accounts.filter((a: any) => a.signedIn).map((a: any) => a.name))
        .not.toContain("Work");
      expect(v.accounts.filter((a: any) => a.signedIn).map((a: any) => a.name))
        .not.toContain("Client");

      await seedUsage(FAKE_CLAUDE, "Personal", 99);
      // Nothing to prove a negative against, so give the offer every chance to
      // appear and assert it did not.
      await browser.pause(500);
      expect(await pillOffering()).toBe("");
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await dismissOverlays();
    }
  });

  it("switches on its own once the user opts in, and says that it did", async () => {
    // The opt-in is driven through the REAL checkbox rather than the command
    // behind it, because the checkbox living in the account menu (and in the
    // usage popover) is the feature: an auto-switch nobody can find is not one.
    await resetUsage();
    await addAccounts(FAKE_CLAUDE);
    signIn(FAKE_CLAUDE, "Personal");
    signIn(FAKE_CLAUDE, "Client");
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-auto");
    try {
      await waitVisible('[data-testid="usage-chip"]');
      // Wait for the agent to actually be RUNNING on Work before doing
      // anything. Without this the switch lands before the first spawn, which
      // is a legitimate case (the next spawn is the one being switched, and it
      // has not happened yet) but not the interesting one: it never exercises
      // a running process keeping its login while the setting moves.
      await waitForSpawnOn(taskId, "Work");
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="account-auto-toggle"]');
      await snap("credentials-13-auto-toggle.png");
      await clickWhenVisible('[data-testid="account-auto-toggle"] [role="checkbox"]');
      await browser.waitUntil(async () => await browser.execute(() =>
        document.querySelector('[data-testid="account-auto-toggle"]')?.getAttribute("data-on") === "1"),
        { timeoutMsg: "the opt-in never stuck" });
      await dismissOverlays();

      // Now hit the limit. Nobody clicks anything from here on.
      await seedUsage(FAKE_CLAUDE, "Work", 97);
      await browser.waitUntil(async () => (await pillAccount()) === "Client",
        { timeout: 10_000, timeoutMsg: "the automatic switch never happened" });

      // ...and it SAYS so. A switch the user is not told about is one they
      // discover by wondering why the number changed.
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="account-auto-notice"]');
      const notice = await browser.execute(() =>
        document.querySelector('[data-testid="account-auto-notice"]')?.textContent ?? "");
      expect(notice).toContain("Client");
      // It RESTARTED, and the copy says so. The manual switch only stages the
      // change (the case above asserts that gap, which is real: a running
      // process cannot have its environment changed underneath it). The
      // automatic one cannot stop there, because nobody is at the keyboard to
      // do the restart, and a switch that waits for a restart nobody performs
      // is a switch that never happens.
      expect(notice).toContain("resumed this conversation");
      // ...and it says the agent was told to carry on, because output
      // appearing with nobody at the keyboard is otherwise alarming.
      expect(notice).toContain("continue");
      await snap("credentials-14-auto-switched.png");

      // The promise, asserted end to end: a process is actually RUNNING on
      // Client. The setting alone would be the feature not working.
      await waitForSpawnOn(taskId, "Client");
      await browser.waitUntil(async () => (await pillUsageAccount()) === "Client",
        { timeout: 10_000, timeoutMsg: "the numbers never followed the process onto Client" });
      // ...and the numbers are Client's, not Work's 97% relabelled. This is
      // the misattribution the account half of the usage key exists to
      // prevent: Client has spent nothing, so there is nothing to show.
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-session")))
        .not.toBe("97");

      // The agent's DEFAULT is untouched: this moved one task, exactly as the
      // manual switch does. Every other task stays where it was.
      const v = await accountsFor(FAKE_CLAUDE);
      expect(v.accounts.find((a: any) => a.isDefault).name).toBe("Work");
    } finally {
      await browser.execute(async (a) => {
        try { await window.__termic!.invoke("account_set_auto_switch", { agentId: a, on: false }); }
        catch { /* the agent may be gone */ }
      }, FAKE_CLAUDE);
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await dismissOverlays();
    }
  });

  it("puts the numbers and the credentials in ONE panel", async () => {
    // They were two chips and two panels. The account pill's own comment
    // argued against that ("forms one unit with the usage chip", because the
    // numbers ARE that account's numbers), and the split cost a duplicated
    // auto-switch checkbox that went stale when toggled from the other side.
    // One trigger, one panel, one copy of the checkbox.
    await resetUsage();
    await addAccounts(FAKE_CLAUDE);
    signIn(FAKE_CLAUDE, "Personal");
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-one-panel");
    try {
      await seedUsage(FAKE_CLAUDE, "Work", 91);
      await waitVisible('[data-testid="usage-chip"]');
      // The one trigger carries BOTH halves' state.
      expect(await pillAccount()).toBe("Work");
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-session")))
        .toBe("91");

      await clickWhenVisible('[data-testid="usage-chip"]');
      // ...and the one panel carries the numbers AND the switcher.
      await waitVisible('[data-testid="usage-detail"]');
      await waitVisible('[data-testid="account-pick-Personal"]');
      await waitVisible('[data-testid="account-auto-toggle"]');
      // Exactly ONE auto-switch control now, not one per panel.
      expect(await browser.execute(() =>
        document.querySelectorAll('[data-testid="account-auto-toggle"]').length)).toBe(1);
      expect(await browser.execute(() =>
        !!document.querySelector('[data-testid="usage-auto-switch"]'))).toBe(false);
      await snap("credentials-15-one-panel.png");

      await clickWhenVisible('[data-testid="account-auto-toggle"] [role="checkbox"]');
      await browser.waitUntil(async () => await browser.execute(() =>
        document.querySelector('[data-testid="account-auto-toggle"]')?.getAttribute("data-on") === "1"),
        { timeoutMsg: "the opt-in never stuck" });
    } finally {
      await browser.execute(async (a) => {
        try { await window.__termic!.invoke("account_set_auto_switch", { agentId: a, on: false }); }
        catch { /* gone */ }
      }, FAKE_CLAUDE);
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await dismissOverlays();
    }
  });

  it("says a per-token account has no plan once its first turn is billed", async () => {
    // The wire an enterprise usage-based seat actually sends, measured:
    //   usage - - - - 0          at session start
    //   usage - - - - 0.235401   after the first turn
    // The first line is also what a SUBSCRIPTION sends before its first
    // message (claude 2.1.273 on Max), so it proves nothing: the chip says
    // usage is unknown until the cost rises, and only then "billed per token".
    await resetUsage();
    await addAccounts(FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-planless");
    try {
      await waitVisible('[data-testid="usage-chip"]');
      await seedCost(FAKE_CLAUDE, "Work", 0, false);
      await waitVisible('[data-testid="usage-unknown"]');

      await seedCost(FAKE_CLAUDE, "Work", 0.235401, false);
      await waitGone('[data-testid="usage-unknown"]');
      await clickWhenVisible('[data-testid="usage-chip"]');
      const panel = await browser.execute(() =>
        document.querySelector('[data-testid="usage-detail"]')?.textContent ?? "");
      expect(panel).toMatch(/billed per token/i);
      const row = await browser.execute(() =>
        document.querySelector('[data-testid="usage-spend-row"]')?.textContent ?? "");
      expect(row).toContain("Spent since launch");
      expect(row).toContain("0.24");
      await snap("credentials-17-planless.png");
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await resetUsage();
      await dismissOverlays();
    }
  });

  it("stays 'usage unknown' across restored sessions that have not reached the API", async () => {
    // THE BUG. After a relaunch every restored task's session sends one
    // window-less `0`, and two of them on one Max account used to count as
    // proof of no plan: the first task had no chip, the second showed $0.00
    // and "billed per token". Sessions that never reached the API prove
    // nothing, however many there are.
    await resetUsage();
    const taskId = await openTaskWith(FAKE_CLAUDE, "usage-restored");
    try {
      await waitVisible('[data-testid="usage-unknown"]');
      await seedCost(FAKE_CLAUDE, null, 0, false, "restored-1");
      await seedCost(FAKE_CLAUDE, null, 0, false, "restored-2");
      await seedCost(FAKE_CLAUDE, null, 0, false, "restored-3");
      // Give a wrong flip the time it would need to render.
      await browser.pause(300);
      const state = await browser.execute(() => ({
        unknown: !!document.querySelector('[data-testid="usage-unknown"]'),
        spend: !!document.querySelector('[data-usage-spend]'),
      }));
      expect(state).toEqual({ unknown: true, spend: false });
      await clickWhenVisible('[data-testid="usage-chip"]');
      const panel = await browser.execute(() =>
        document.querySelector('[data-testid="usage-detail"]')?.textContent ?? "");
      expect(panel).not.toMatch(/billed per token/i);
      await dismissOverlays();

      // The first turn of a subscription: windows, and the chip is numbers.
      await seedCost(FAKE_CLAUDE, null, 0.12, true, "restored-2");
      await waitGone('[data-testid="usage-unknown"]');
      const chip = await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-session") ?? "");
      expect(chip).toBe("9");
    } finally {
      await removeTask(taskId);
      await resetUsage();
      await dismissOverlays();
    }
  });

  it("sends an agent with no hooks to Settings, and drops that advice once they are in", async () => {
    // claude reports usage through the status line the agent hooks install,
    // so "unknown" has two different causes and two different next steps.
    await resetUsage();
    await browser.execute(async (a) => {
      const t = window.__termic!;
      try { await t.invoke("agent_hooks_remove", { agentId: a }); } catch { /* none */ }
      await t.useApp.getState().refreshAgentHooks();
    }, FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "usage-hooks");
    try {
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-unknown-detail"][data-usage-hooks="missing"]');
      const missing = await browser.execute(() =>
        document.querySelector('[data-testid="usage-unknown-detail"]')?.textContent ?? "");
      expect(missing).toMatch(/must have hooks enabled and a first response/i);
      // Measured on the frame the content is there, not after a settle: the
      // bug was a panel placed for its empty size that grew afterwards.
      expect(await panelGeometry()).toMatchObject({ inside: true, aboveChip: true });
      await snap("usage-unknown-no-hooks.png");

      // To Settings, onto the hooks block, and the popover does not linger.
      await clickWhenVisible('[data-testid="usage-install-hooks"]');
      await browser.waitUntil(async () => await browser.execute(() => {
        const v = window.__termic!.useApp.getState().view;
        return v.settingsOpen === true && v.settingsTab === "agents";
      }), { timeout: 8_000, timeoutMsg: "Install hooks did not open Settings on the Agents tab" });
      await waitVisible("#setting-agent-hooks");
      // Opened, not just scrolled to: the rows the reader came for are behind
      // the toggle.
      await browser.waitUntil(async () => await browser.execute(() =>
        document.querySelector('[data-testid="agent-hooks-toggle"]')?.getAttribute("aria-expanded") === "true"),
        { timeout: 5_000, timeoutMsg: "Install hooks landed on a collapsed hooks block" });
      await snap("usage-install-hooks-settings.png");
      expect(await browser.execute(() =>
        !!document.querySelector('[data-testid="usage-detail"]'))).toBe(false);
      await browser.execute(() => window.__termic!.useApp.getState().closeSettings());

      // Hooks in: the button goes, the message is about the first reply.
      // Settings refreshes the installed flag right after it writes; mirrored.
      await browser.execute(async (a) => {
        const t = window.__termic!;
        await t.invoke("agent_hooks_install", { agentId: a });
        await t.useApp.getState().refreshAgentHooks();
      }, FAKE_CLAUDE);
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-unknown-detail"][data-usage-hooks="active"]');
      const active = await browser.execute(() => ({
        text: document.querySelector('[data-testid="usage-unknown-detail"]')?.textContent ?? "",
        button: !!document.querySelector('[data-testid="usage-install-hooks"]'),
      }));
      expect(active.text).toMatch(/appears after a first message/i);
      expect(active.button).toBe(false);
      // Measured on the frame the content is there, not after a settle: the
      // bug was a panel placed for its empty size that grew afterwards.
      expect(await panelGeometry()).toMatchObject({ inside: true, aboveChip: true });
      await snap("usage-unknown-hooks-active.png");
    } finally {
      await browser.execute(async (a) => {
        const t = window.__termic!;
        try { await t.invoke("agent_hooks_remove", { agentId: a }); } catch { /* none */ }
        await t.useApp.getState().refreshAgentHooks();
      }, FAKE_CLAUDE);
      await removeTask(taskId);
      await resetUsage();
      await dismissOverlays();
    }
  });

  // grok reports its context window through the status line the hooks install
  // puts in, and no plan usage at all. "Usage unknown" used to be gated on
  // usage alone, so this agent's footer was empty forever with nothing saying
  // that installing hooks is what fills it.
  // A grok-based agent: agent hooks are claude-only on Windows (docs/windows.md).
  (process.platform === "win32" ? it.skip : it)("offers the hooks install for an agent whose only readout is the context window", async () => {
    await resetUsage();
    await browser.execute(async (a) => {
      const t = window.__termic!;
      try { await t.invoke("agent_hooks_remove", { agentId: a }); } catch { /* none */ }
      await t.useApp.getState().refreshAgentHooks();
    }, FAKE_GROK);
    const taskId = await openTaskWith(FAKE_GROK, "ctx-only-hooks");
    try {
      await waitVisible('[data-testid="usage-unknown"]');
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-unknown-detail"][data-usage-hooks="missing"]');
      const text = await browser.execute(() =>
        document.querySelector('[data-testid="usage-unknown-detail"]')?.textContent ?? "");
      // It names what hooks would bring: the context window, not "usage".
      expect(text).toMatch(/to see the context window you must have hooks enabled/i);
      await waitVisible('[data-testid="usage-install-hooks"]');
      await snap("usage-unknown-context-only.png");
      await dismissOverlays();

      // The agent's hooks are offered in Settings too (supported via its base).
      const supported = await browser.execute(async (a) =>
        (await window.__termic!.invoke("agent_hooks_status", { agentId: a })).supported, FAKE_GROK);
      expect(supported).toBe(true);

      // A context report replaces the label with the gauge.
      await waitForAgentReady(taskId);
      await submitToAgent(taskId, "#usage ctx 21000 500000");
      await waitVisible('[data-testid="context-gauge"]', 20_000);
      await waitGone('[data-testid="usage-unknown"]');
    } finally {
      await removeTask(taskId);
      await resetUsage();
      await dismissOverlays();
    }
  });

  // The other half of the case above: an agent whose USAGE is pulled (codex,
  // devin, copilot) shows numbers with or without hooks, so its chip is never
  // "unknown", and its context window, which only hooks bring, used to be
  // missing with nothing saying why. Reported on copilot.
  it("says the context window needs hooks on an agent that already shows usage", async () => {
    await resetUsage();
    // The installed flag is set in the store rather than by a real install:
    // a codex install runs codex's trust handshake against the clone's
    // command, which for this fixture is a script that never answers, so it
    // would spend the case's whole budget on a timeout. The flag is exactly
    // what Settings refreshes after a real install, and what the row reads.
    const setInstalled = (on: boolean) => browser.execute((a, v) => {
      const s = window.__termic!.useApp;
      s.setState({ agentHooksInstalled: { ...s.getState().agentHooksInstalled, [a]: v } });
    }, FAKE_CODEX, on);
    await setInstalled(false);
    const taskId = await openTaskWith(FAKE_CODEX, "ctx-missing-hooks");
    try {
      await waitVisible('[data-testid="usage-chip"]');
      await seedUsage(FAKE_CODEX, null, 12);
      await browser.waitUntil(async () => await browser.execute(() =>
        document.querySelector('[data-testid="usage-chip"]')?.getAttribute("data-usage-session") === "12"),
        { timeout: 10_000, timeoutMsg: "the seeded usage never reached the chip" });
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="context-missing"][data-context-hooks="missing"]');
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="context-missing"]')?.textContent ?? ""))
        .toMatch(/needs hooks/i);
      await waitVisible('[data-testid="context-install-hooks"]');
      await snap("usage-context-needs-hooks.png");
      await dismissOverlays();

      // Hooks in: the button goes, the line says it arrives with a reply.
      await setInstalled(true);
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="context-missing"][data-context-hooks="active"]');
      expect(await browser.execute(() =>
        !!document.querySelector('[data-testid="context-install-hooks"]'))).toBe(false);
    } finally {
      await browser.execute(() => window.__termic!.useApp.getState().refreshAgentHooks());
      await removeTask(taskId);
      await resetUsage();
      await dismissOverlays();
    }
  });

  it("shrinks a dismissed 'Usage unknown' to an icon until hooks are installed", async () => {
    // Someone who does not want hooks now should not keep paying a footer
    // label for it, and should keep a way back to installing them.
    await resetUsage();
    await browser.execute(async (a) => {
      const t = window.__termic!;
      try { await t.invoke("agent_hooks_remove", { agentId: a }); } catch { /* none */ }
      await t.useApp.getState().refreshAgentHooks();
    }, FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "usage-dismiss");
    try {
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-unknown-detail"][data-usage-hooks="missing"]');
      const label = await browser.execute(() =>
        document.querySelector('[data-testid="usage-dismiss"]')?.textContent ?? "");
      expect(label).toBe("Dismiss for FakeClaude");
      // A long agent name stays inside the fixed-width panel. Measured with
      // the real name swapped for one with no break point, which is the case
      // that cannot wrap.
      const fits = await browser.execute(() => {
        const btn = document.querySelector('[data-testid="usage-dismiss"]') as HTMLElement;
        const span = btn.querySelector("span") as HTMLElement;
        const original = span.textContent;
        span.textContent = "Dismiss for " + "averyveryverylongagentnamewithnobreakpoint".repeat(2);
        const panel = document.querySelector('[data-testid="usage-detail"]') as HTMLElement;
        const b = btn.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        const ok = b.right <= p.right + 0.5 && btn.scrollWidth > 0 && b.height < 40;
        span.textContent = original;
        return ok;
      });
      expect(fits).toBe(true);
      await clickWhenVisible('[data-testid="usage-dismiss"]');

      // Label gone, brand icon swapped for the faint one, panel closed.
      await waitVisible('[data-testid="usage-dismissed-icon"]');
      const footer = await browser.execute(() => ({
        label: !!document.querySelector('[data-testid="usage-unknown"]'),
        panel: !!document.querySelector('[data-testid="usage-detail"]'),
        chipText: (document.querySelector('[data-testid="usage-chip"]')?.textContent ?? "").trim(),
        faint: document.querySelector('[data-testid="usage-chip"]')?.className.includes("color-fg-faint") ?? false,
      }));
      expect(footer).toEqual({ label: false, panel: false, chipText: "", faint: true });
      await snap("usage-dismissed-icon.png");

      // One click on the icon is the same panel, with no second Dismiss.
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-install-hooks"]');
      expect(await browser.execute(() =>
        !!document.querySelector('[data-testid="usage-dismiss"]'))).toBe(false);

      // Installing hooks is the answer the dismissal was waiting for: the label
      // comes back on its own, with nothing to undo. Settings refreshes the
      // installed flag right after it writes, which is what this mirrors.
      await dismissOverlays();
      await browser.execute(async (a) => {
        const t = window.__termic!;
        await t.invoke("agent_hooks_install", { agentId: a });
        await t.useApp.getState().refreshAgentHooks();
      }, FAKE_CLAUDE);
      await waitVisible('[data-testid="usage-unknown"]');
      await waitGone('[data-testid="usage-dismissed-icon"]');
    } finally {
      await browser.execute(async (a) => {
        const t = window.__termic!;
        t.useUsageUnknownDismissed.getState().setDismissed(a, false);
        try { await t.invoke("agent_hooks_remove", { agentId: a }); } catch { /* none */ }
        await t.useApp.getState().refreshAgentHooks();
      }, FAKE_CLAUDE);
      await removeTask(taskId);
      await resetUsage();
      await dismissOverlays();
    }
  });

  it("does not call a subscription's dollars 'spent'", async () => {
    // claude reports `total_cost_usd` on EVERY account, subscription
    // included, so a plan account shows both windows and a dollar figure.
    // Reported from a real panel: 9% / 1% sitting next to "Spent since launch
    // $11" reads as eleven dollars charged, and on a plan nothing was
    // charged at all. Same number, two meanings, so the label has to move.
    await resetUsage();
    await addAccounts(FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-cost-label");
    try {
      await waitVisible('[data-testid="usage-chip"]');

      // A PLAN account: windows and a cost.
      await seedCost(FAKE_CLAUDE, "Work", 11, true);
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-spend-row"]');
      const onPlan = await browser.execute(() =>
        document.querySelector('[data-testid="usage-spend-row"]')?.textContent ?? "");
      expect(onPlan).toContain("Would have cost");
      expect(onPlan).not.toContain("Spent since launch");
      // ...and it says who paid, which is the whole correction.
      expect(onPlan).toMatch(/plan covers it/i);
      await dismissOverlays();

      // An account with NO plan is billed per token, so there "spent" is
      // exactly right and must not be softened away.
      await setTaskAccount(taskId, FAKE_CLAUDE, "Client");
      await respawn(taskId);
      await waitForSpawnOn(taskId, "Client");
      // Proved billed per token: the session's cost ROSE with no window.
      await seedCost(FAKE_CLAUDE, "Client", 0, false);
      await seedCost(FAKE_CLAUDE, "Client", 11, false);
      await clickWhenVisible('[data-testid="usage-chip"]');
      await waitVisible('[data-testid="usage-spend-row"]');
      const noPlan = await browser.execute(() =>
        document.querySelector('[data-testid="usage-spend-row"]')?.textContent ?? "");
      expect(noPlan).toContain("Spent since launch");
      expect(noPlan).not.toContain("Would have cost");
      await snap("credentials-16-cost-label.png");
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await resetUsage();
      await dismissOverlays();
    }
  });

  it("keeps the two REALMS apart, and says so in the footer", async () => {
    // The Docker realm is where every account bug that reached a human lived,
    // and this suite cannot run a container. What it CAN drive is the half
    // that decides which realm a task belongs to, which is the half that was
    // wrong: `agent_accounts` is asked per realm, and a Docker task's login is
    // a different store from the same account's host login.
    //
    // The mounts themselves are pinned in Rust
    // (`the_whole_chain_holds_from_saved_settings_to_the_docker_mounts`),
    // because a spec that needed a daemon would be a spec nobody could run.
    await resetUsage();
    await addAccounts(FAKE_CLAUDE);
    const taskId = await openTaskWith(FAKE_CLAUDE, "acct-realms");
    try {
      const realms = await browser.execute(async (a) => {
        const t = window.__termic!;
        return {
          host: await t.invoke("agent_accounts", { agentId: a, docker: false }),
          docker: await t.invoke("agent_accounts", { agentId: a, docker: true }),
        };
      }, FAKE_CLAUDE);

      // The same NAMES in both: the list is one setting on the agent entry.
      expect(realms.host.accounts.map((x: any) => x.name))
        .toEqual(realms.docker.accounts.map((x: any) => x.name));

      // ...but signing in is per realm. Nothing here has signed in anywhere,
      // so the interesting assertion is that the two answers are computed
      // separately rather than one being copied from the other: sign the HOST
      // store in by hand and only the host view moves.
      signIn(FAKE_CLAUDE, "Work");
      const after = await browser.execute(async (a) => {
        const t = window.__termic!;
        return {
          host: await t.invoke("agent_accounts", { agentId: a, docker: false }),
          docker: await t.invoke("agent_accounts", { agentId: a, docker: true }),
        };
      }, FAKE_CLAUDE);
      const signedIn = (v: any, n: string) => v.accounts.find((x: any) => x.name === n).signedIn;
      expect(signedIn(after.host, "Work")).toBe(true);
      expect(signedIn(after.docker, "Work")).toBe(false);

      // And the footer follows the TASK's realm rather than the host's, which
      // is what makes "Sandbox in Docker" and the account name agree.
      await waitVisible('[data-testid="usage-chip"]');
      expect(await pillAccount()).toBe("Work");
    } finally {
      await removeTask(taskId);
      await clearAccounts(FAKE_CLAUDE);
      signOutAll(FAKE_CLAUDE);
      await dismissOverlays();
    }
  });

  it("removes a set without touching the login it shares", async () => {
    await openAgentsPage();
    // "Work" is the default by now (the case above made it one), so this is
    // also the removal that has to promote a survivor.
    await waitVisible(`[data-testid="account-chip-${AGENT}-Work"]`);
    await clickWhenVisible(`[data-testid="account-remove-${AGENT}-Work"]`);
    await waitGone(`[data-testid="account-chip-${AGENT}-Work"]`);
    const v = await accounts();
    expect(v.accounts.map((a: any) => a.name)).toEqual(["Personal", "Client"]);
    // Removing the default promotes the survivor rather than leaving none.
    // WHICH survivor is not the point and is not asserted; that there is one
    // is, because an agent with accounts and no default cannot spawn.
    expect(v.accounts.filter((a: any) => a.isDefault).length).toBe(1);
  });

  it("returns to a single login when the last set goes", async () => {
    await openAgentsPage();
    // Empty it from the UI, however many are left, rather than by name: the
    // count above this case has changed twice, and each time this one failed
    // for a reason that had nothing to do with what it tests.
    for (const name of ["Personal", "Client"]) {
      await clickWhenVisible(`[data-testid="account-remove-${AGENT}-${name}"]`);
      await waitGone(`[data-testid="account-chip-${AGENT}-${name}"]`);
    }
    expect((await accounts()).accounts).toEqual([]);
    // The header affordance comes back, so backing out fully is possible.
    await browser.waitUntil(async () => await browser.execute((a) =>
      (document.querySelector(`[data-testid="agent-accounts-${a}"]`)?.textContent ?? "")
        .includes("Second account"), AGENT),
      { timeoutMsg: "the dormant affordance never came back" });
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings?.());
    await dismissOverlays();
  });

  it("keeps the account list when another Settings section saves after it changed", async () => {
    // Last in the file on purpose: it clears the account list, and the cases
    // above build on the list the earlier ones left.
    //
    // Reported: the footer switcher vanished and the agent's account list was
    // gone from settings.json. General, Tasks, Sandbox and Docker save the
    // WHOLE settings object from a snapshot taken when the section mounted,
    // and that object carries the agent registry. An account added after the
    // snapshot was written back out of existence by the next save.
    await clearAccounts(AGENT);
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("general"));
    await waitVisible('[data-testid="general-browser-preset"]');
    // General has read its snapshot. Now an account arrives from elsewhere
    // (the footer panel, another window, the Agents section).
    await addAccounts(AGENT);
    expect((await accountsFor(AGENT)).accounts.map((a: any) => a.name)).toEqual(["Personal", "Work", "Client"]);

    // Save an unrelated field in General through its own UI.
    const picked = await browser.execute(() => {
      const sel = document.querySelector('[data-testid="general-browser-preset"]') as HTMLSelectElement;
      const opt = [...sel.options].find(o => o.value && o.value !== sel.value);
      if (!opt) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return opt.value;
    });
    expect(picked).toBeTruthy();
    await clickWhenVisible('[data-testid="general-browser-save"]');
    await browser.waitUntil(async () => await browser.execute(async () =>
      (await window.__termic!.ipc.settingsLoad()).preview_browser !== ""),
      { timeout: 5_000, timeoutMsg: "the General save never landed" });

    const after = await accountsFor(AGENT);
    expect(after.accounts.map((a: any) => a.name)).toEqual(["Personal", "Work", "Client"]);
    expect(after.accounts.find((a: any) => a.isDefault)?.name).toBe("Work");

    // Put the field back and leave the section.
    await browser.execute(async () => {
      const t = window.__termic!;
      const cur = await t.ipc.settingsLoad();
      await t.ipc.settingsSave({ ...cur, preview_browser: "" });
      t.useApp.getState().closeSettings();
    });
    await clearAccounts(AGENT);
  });
});

/** Open Settings -> Agents. Each case does this rather than relying on the
 *  previous one leaving it open, so one failure cannot cascade into three. */
/** Open Settings -> Agents with ONE agent's card showing.
 *
 *  The section renders a single card behind a tab strip and the selection is
 *  local component state, not the store, so the agent has to be CLICKED in the
 *  strip rather than set. Each case does this itself rather than relying on
 *  the previous one, so one failure cannot cascade. */
async function openAgentsPage(agent = AGENT): Promise<void> {
  await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
  await waitVisible(`[data-agent-id="${agent}"]`);
  // `el.click()` rather than a WebDriver click: the strip pill carries an
  // `onPointerDown` drag handler (agents are reorderable), which swallows the
  // pointer sequence so the selection never happens. A direct click fires
  // `onClick` alone. It also sidesteps the strip's horizontal scroll.
  await browser.execute((a) => {
    (document.querySelector(`[data-agent-id="${a}"]`) as HTMLElement | null)?.click();
  }, agent);
  // The CARD, never the accounts control. An agent with no measured login
  // store renders no accounts control at all, and that is a case this spec
  // asserts, so waiting for one here made the helper contradict its own test.
  await waitVisible(`[data-agent-card="${agent}"]`);
}

function accounts(): Promise<any> {
  return browser.execute(async (agent) =>
    window.__termic!.invoke("agent_accounts", { agentId: agent, docker: false }), AGENT);
}

/** Type into a CONTROLLED React input. `setValue` alone writes the DOM
 *  property behind React's value tracker, so the change event is swallowed. */
async function setInput(selector: string, value: string): Promise<void> {
  await browser.execute((sel, val) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    if (!el) throw new Error("no input at " + sel);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, value);
}
