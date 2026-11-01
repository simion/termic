// Settings -> Secrets: add a secret, build a role from the Reviewer
// template, edit its rules, and default an agent and a project to it. Asserts on the saved Settings, since
// that is what the broker reads at spawn.
//
// The broker's own commands (secret_probe, secrets_gh_accounts,
// broker_all_events) may not be wired in this binary yet, so the cases do not
// depend on them: the Add dialog's Keychain fields are filled by hand, and
// the status/activity assertions accept the "can't check" state.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../wdio.conf.js";
import {
  archiveTask, clickPresent, openTask, pointerDrag, pointerRelease, requireTermicApi, setInputValue, snap, waitForAgentReady,
  waitForAppShell, waitForText, waitGone, waitTaskUnmounted, waitVisible,
} from "../helpers";

const settingsLoad = () => browser.execute(() => window.__termic!.invoke("settings_load"));

/** Wait until the saved Settings satisfy `pred` (saves are async). */
async function waitSaved(pred: (s: any) => boolean, msg: string) {
  await browser.waitUntil(async () => pred(await settingsLoad()), { timeout: 10_000, timeoutMsg: msg });
}

/** Set a <select> the way React sees it. */
const setSelect = (sel: string, value: string) =>
  browser.execute((s, v) => {
    const el = document.querySelector(s) as HTMLSelectElement | null;
    if (!el) throw new Error("no select: " + s);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, value);

/** setInputValue, then Enter: the role editor commits on blur or Enter, and
 *  this window never takes focus, so a blur() may not fire a focusout. */
async function typeAndCommit(sel: string, value: string) {
  await setInputValue(sel, value);
  await browser.execute((s) => {
    document.querySelector(s)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, sel);
}

/** The fixture project's id, waiting for the store to have it. */
async function fixtureProjectId(): Promise<string> {
  let id = "";
  await browser.waitUntil(async () => {
    id = await browser.execute(() =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")?.id ?? "");
    return !!id;
  }, { timeout: 10_000, timeoutMsg: "fixture-repo never showed in the store" });
  return id;
}

/** Radix menus open on pointerdown, not click. */
async function openMenu(sel: string) {
  await browser.execute((s) => {
    const el = document.querySelector(s) as HTMLElement;
    const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.click();
  }, sel);
  await waitVisible("[role='menu']");
}

/** The Add dialog's "Keychain item" source, naming gh's own generic item, so
 *  the secret reads as a gh login without depending on the accounts gh has
 *  on the machine running the suite (the default source follows those). */
async function ghLoginSource() {
  await clickPresent('[data-testid="add-secret-source-item"]');
  await waitVisible('[data-testid="add-secret-service"]');
  await setInputValue('[data-testid="add-secret-service"]', "gh:github.com");
}

const secretsTab = (id: "secrets" | "roles" | "activity") => clickPresent(`[data-secrets-tab="${id}"]`);

/** Remount Settings -> Secrets on the Roles tab with `role` open. The page
 *  edits a copy of the settings seeded on mount, so after a spec writes
 *  settings directly this is what makes the page see it. */
async function reopenRoles(role: string) {
  await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
  await waitGone('[data-testid="secrets-section"]');
  await browser.execute(() => window.__termic!.useApp.getState().openSettings("secrets"));
  await secretsTab("roles");
  await clickPresent(`[data-role-row="${role}"]`);
  await waitVisible('[data-testid="role-editor"]');
}

describe("settings: secrets and roles", () => {
  let original: any;
  let projectId = "";
  let roleId = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await settingsLoad();
    projectId = await fixtureProjectId();
    // start from no secrets and no roles, whatever an earlier run left.
    await browser.execute(async (s) => {
      await window.__termic!.invoke("settings_save", { s: { ...s, secrets: [], roles: [] } });
    }, original);
  });

  after(async () => {
    await browser.execute(async (s, pid) => {
      const t = window.__termic!;
      await t.invoke("settings_save", { s });
      const p = t.useApp.getState().projects.find((x: any) => x.id === pid);
      if (p) await t.ipc.projectUpdate({ ...p, default_role: null });
      await t.useApp.getState().loadAll();
      t.useApp.getState().closeSettings();
    }, original, projectId);
  });

  it("opens on an empty Secrets tab", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("secrets"));
    await waitForText("No secrets yet.");
    // Env vars sits between Roles and Activity, and its list is not on this tab.
    expect(await browser.execute(() =>
      [...document.querySelectorAll("[data-secrets-tab]")].map(e => e.getAttribute("data-secrets-tab")))).toEqual(["secrets", "roles", "env", "activity"]);
    expect(await browser.execute(() => !!document.querySelector('[data-testid="secrets-kept-out"]'))).toBe(false);
    await snap("secrets-m1-empty.png");
  });

  it("refuses an Add secret with no Keychain account, then adds one", async () => {
    await clickPresent('[data-testid="secrets-add"]');
    await waitVisible('[data-testid="add-secret-dialog"]');
    await ghLoginSource();
    // an item Termic did not store, so no "Saved to" line
    expect(await browser.execute(() => !!document.querySelector('[data-testid="add-secret-saved-to"]'))).toBe(false);
    // the GitHub preset's three default hosts
    const hosts = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="add-secret-hosts"] [data-host]')].map(e => e.getAttribute("data-host")));
    expect(hosts).toEqual(["api.github.com", "github.com", "uploads.github.com"]);

    await setInputValue('[data-testid="add-secret-name"]', "gh-review");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitForText("Keychain service and account are both required.");
    expect((await settingsLoad()).secrets ?? []).toEqual([]);

    await setInputValue('[data-testid="add-secret-keychain-account"]', "ci-bot");
    await snap("secrets-m1-add-dialog.png");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets?.length === 1, "the secret never saved");
    const s = (await settingsLoad()).secrets[0];
    expect(s).toMatchObject({
      name: "gh-review", service: "gh:github.com", account: "ci-bot", kind: "generic", recipe: "github",
      hosts: ["api.github.com", "github.com", "uploads.github.com"],
    });
    await waitVisible('[data-secret-row="gh-review"]');
    // the probe runs once the save lands: probing the optimistic row raced
    // settings_save and stuck on "no such secret". The fixture account has
    // no Keychain item, so the real answer is missing, never an error.
    await browser.waitUntil(async () => {
      const st = await browser.execute(() =>
        document.querySelector('[data-secret-row="gh-review"] [data-status]')?.getAttribute("data-status"));
      return st && st !== "checking" ? st : false;
    }, { timeout: 10_000, timeoutMsg: "the new secret was never probed" });
    const st = await browser.execute(() =>
      document.querySelector('[data-secret-row="gh-review"] [data-status]')?.getAttribute("data-status"));
    expect(st).not.toBe("error");
  });

  it("refuses a second secret with the same name", async () => {
    await clickPresent('[data-testid="secrets-add"]');
    await waitVisible('[data-testid="add-secret-dialog"]');
    await ghLoginSource();
    await setInputValue('[data-testid="add-secret-keychain-account"]', "alice");
    await setInputValue('[data-testid="add-secret-name"]', "gh-review");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitForText("A secret with that name already exists.");
    // a different name goes through: gh-maintain, pinned to alice.
    await setInputValue('[data-testid="add-secret-name"]', "gh-maintain");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets?.length === 2, "the second secret never saved");
  });

  it("expands a row and edits its hosts", async () => {
    await clickPresent('[data-secret-row="gh-review"]');
    await waitVisible('[data-testid="secret-expanded"]');
    await waitForText("Pinned to ci-bot.");
    // a gh login is gh's item: the Stored in column says so, there is no
    // Replace (Termic does not own the value), and Test access's tip says it
    // reads gh's login without the macOS prompt.
    expect(await browser.execute(() =>
      (document.querySelector('[data-secret-row="gh-review"] [data-col="stored"]') as HTMLElement).innerText.trim())).toBe("gh login · ci-bot\nkept by gh");
    expect(await browser.execute(() => !!document.querySelector('[data-testid="secret-replace"]'))).toBe(false);
    expect(await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="secret-expanded"] [aria-label]')].some(e => e.getAttribute("aria-label")!.includes("the way gh does")))).toBe(true);
    // both GitHub routes are on: the secret reaches api.github.com and github.com
    expect(await browser.execute(() =>
      [...document.querySelectorAll('[data-secret-row="gh-review"] [data-delivered]')].map(e => e.textContent))).toEqual(["gh · socket", "git · proxy"]);
    await snap("secrets-m1-expanded.png");

    // drop uploads.github.com, then put it back through the add field.
    await clickPresent('[data-testid="secret-hosts"] [data-host="uploads.github.com"] button');
    await waitSaved(s => s.secrets.find((x: any) => x.name === "gh-review").hosts.length === 2, "host removal never saved");
    await setInputValue('[data-testid="secret-hosts-input"]', "uploads.github.com");
    await clickPresent('[data-testid="secret-hosts-add"]');
    await waitSaved(s => s.secrets.find((x: any) => x.name === "gh-review").hosts.includes("uploads.github.com"), "host add never saved");
    // without api.github.com the gh socket route is off, so its chip goes
    // (recipe.rs Route::active); putting the host back brings it back.
    const chips = () => browser.execute(() =>
      [...document.querySelectorAll('[data-secret-row="gh-review"] [data-delivered]')].map(e => e.getAttribute("data-delivered")));
    await clickPresent('[data-testid="secret-hosts"] [data-host="api.github.com"] button');
    await waitSaved(s => !s.secrets.find((x: any) => x.name === "gh-review").hosts.includes("api.github.com"), "api host removal never saved");
    expect(await chips()).toEqual(["git"]);
    await setInputValue('[data-testid="secret-hosts-input"]', "api.github.com");
    await clickPresent('[data-testid="secret-hosts-add"]');
    await waitSaved(s => s.secrets.find((x: any) => x.name === "gh-review").hosts.includes("api.github.com"), "api host add never saved");
    expect(await chips()).toEqual(["gh", "git"]);

    // Test access always lands on a status, readable or not.
    await clickPresent('[data-testid="secret-test"]');
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector('[data-secret-row="gh-review"] [data-status]')?.getAttribute("data-status") !== "checking"),
    { timeout: 10_000, timeoutMsg: "Test access never settled" });
  });

  it("renames a secret: a taken or empty name is refused, Esc cancels, Enter saves", async () => {
    const input = '[data-testid="secret-rename-input"]';
    const byName = (s: any, n: string) => s.secrets.find((x: any) => x.name === n);
    const before = byName(await settingsLoad(), "gh-maintain");
    const keyDown = (key: string) => browser.execute((s, k) => {
      document.querySelector(s)!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    }, input, key);

    // the pencil on the name cell opens the field on that row only
    await clickPresent('[data-secret-row="gh-maintain"] [data-testid="secret-rename"]');
    await waitVisible(`[data-secret-row="gh-maintain"] ${input}`);
    expect(await browser.execute((s) => (document.querySelector(s) as HTMLInputElement).value, input)).toBe("gh-maintain");

    // a name another secret has is refused in place, and nothing is saved
    await typeAndCommit(input, "gh-review");
    await waitForText("A secret with that name already exists.");
    await waitVisible(input);
    await snap("secrets-rename-taken.png");
    await typeAndCommit(input, "   ");
    await waitForText("Give it a name.");
    expect(byName(await settingsLoad(), "gh-maintain")).toEqual(before);

    // Esc drops the draft, and stops there: had it reached Settings' own
    // handler, the rail's Close button would ask for a second Esc.
    await setInputValue(input, "never-saved");
    await keyDown("Escape");
    await waitGone(input);
    await waitVisible('[data-secret-row="gh-maintain"]');
    expect(await browser.execute(() => document.querySelector('[data-testid="settings-rail"]')!.textContent!.includes("Esc again to close"))).toBe(false);
    expect(byName(await settingsLoad(), "never-saved")).toBeUndefined();

    // Enter saves: same id and Keychain item, only the label moves
    await clickPresent('[data-secret-row="gh-maintain"] [data-testid="secret-rename"]');
    await typeAndCommit(input, "gh-maintainer");
    await waitSaved(s => !!byName(s, "gh-maintainer"), "the rename never saved");
    expect(byName(await settingsLoad(), "gh-maintainer")).toEqual({ ...before, name: "gh-maintainer" });
    await waitGone(input);
    await waitVisible('[data-secret-row="gh-maintainer"]');

    // the expanded row's Rename button opens the same field; put the name back
    await clickPresent('[data-secret-row="gh-maintainer"]');
    await clickPresent('[data-testid="secret-rename-button"]');
    await waitVisible(`[data-secret-row="gh-maintainer"] ${input}`);
    await typeAndCommit(input, "gh-maintain");
    await waitSaved(s => !!byName(s, "gh-maintain"), "the rename back never saved");
    expect(byName(await settingsLoad(), "gh-maintain")).toEqual(before);
  });

  it("creates a Reviewer role whose rules read GraphQL and deny push", async () => {
    await secretsTab("roles");
    await waitForText("A role is the set of secrets an agent may use");
    await openMenu('[data-testid="roles-new"]');
    await clickPresent('[data-role-template="reviewer"]');
    await waitSaved(s => s.roles?.length === 1, "the role never saved");
    const role = (await settingsLoad()).roles[0];
    roleId = role.id;
    expect(role.name).toBe("Reviewer");
    const api = role.rule_sets.find((r: any) => r.host === "api.github.com");
    expect(api.fallback).toBe("deny");
    expect(api.rules.some((r: any) => r.methods.includes("QUERY") && r.effect === "allow")).toBe(true);
    // every host of the secret has a set, so none is silently open.
    expect(role.rule_sets.map((r: any) => r.host).sort()).toEqual(["api.github.com", "github.com", "uploads.github.com"]);
    const git = role.rule_sets.find((r: any) => r.host === "github.com");
    expect(git.rules.map((r: any) => `${r.effect} ${r.methods.join(",")}`)).toEqual(["allow fetch", "deny push"]);
    await waitVisible('[data-testid="role-editor"]');
    await snap("secrets-m2-reviewer.png");
  });

  it("edits the role: name, colour, and an added rule moved up", async () => {
    await typeAndCommit('[data-testid="role-name"]', "Reviewer bot");
    await clickPresent('[data-role-colour="teal"]');
    await waitSaved(s => s.roles[0].name === "Reviewer bot" && s.roles[0].colour === "teal",
      "rename + colour did not both save (the second edit must not undo the first)");
    // every swatch paints. The role tokens are @theme vars, and Tailwind drops
    // one whose literal name is not in the source: they all computed to
    // transparent once, with the selection ring the only thing on screen.
    const fills = await browser.execute(() =>
      [...document.querySelectorAll("[data-role-colour]")].map(e => getComputedStyle(e).backgroundColor));
    expect(fills.length).toBe(5);
    for (const f of fills) expect(f).not.toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);

    const before = (await settingsLoad()).roles[0].rule_sets.find((r: any) => r.host === "api.github.com").rules.length;
    await clickPresent('[data-testid="rules-api.github.com-add"]');
    const last = `[data-testid="rules-api.github.com"] [data-rule-index="${before}"]`;
    await waitVisible(last);
    await typeAndCommit(`${last} [data-field="pattern"]`, "/repos/*/*/labels");
    await clickPresent(`${last} [data-effect]`);  // allow -> deny
    await waitSaved(s => {
      const rules = s.roles[0].rule_sets.find((r: any) => r.host === "api.github.com").rules;
      return rules.length === before + 1 && rules[before].pattern === "/repos/*/*/labels" && rules[before].effect === "deny";
    }, "the new rule never saved");

    // drag it by its handle onto the top half of the row above: one save,
    // on release.
    const rulesOf = (s: any) => s.roles[0].rule_sets.find((r: any) => r.host === "api.github.com").rules;
    const above = `[data-testid="rules-api.github.com"] [data-rule-index="${before - 1}"]`;
    await pointerDrag(`${last} [data-rule-handle]`, above, { land: "top", hold: true });
    // mid-drag: the row it passed has stepped down to open the gap, and
    // nothing is saved until release.
    expect(await browser.execute((sel: string) => (document.querySelector(sel) as HTMLElement).style.transform, above))
      .toMatch(/translateY\([1-9]/);
    expect(rulesOf(await settingsLoad())[before].pattern).toBe("/repos/*/*/labels");
    await snap("secrets-rule-drag.png");
    // release where the cursor already is: the drop row has stepped aside,
    // so re-measuring it would move the cursor back down past it.
    await pointerRelease(`${last} [data-rule-handle]`);
    await waitSaved(s => rulesOf(s)[before - 1].pattern === "/repos/*/*/labels", "the drag never saved");
    expect(rulesOf(await settingsLoad()).length).toBe(before + 1);
    await waitGone('[data-testid="rules-api.github.com"] [data-rule-index][style*="translateY"]');

    // the handle also moves by keyboard, and focus follows the rule.
    const moved = `[data-testid="rules-api.github.com"] [data-rule-index="${before - 1}"] [data-rule-handle]`;
    await browser.execute((sel: string) => (document.querySelector(sel) as HTMLElement).focus(), moved);
    await browser.keys("ArrowDown");
    await waitSaved(s => rulesOf(s)[before].pattern === "/repos/*/*/labels", "arrow down never saved");
    await browser.waitUntil(async () => (await browser.execute(() =>
      document.activeElement?.closest("[data-rule-index]")?.getAttribute("data-rule-index"))) === String(before),
      { timeout: 3_000, timeoutMsg: "focus did not follow the moved rule" });

    // the fallback row flips like a rule does.
    await clickPresent('[data-testid="rules-github.com"] [data-rule-fallback] [data-effect]');
    await waitSaved(s => s.roles[0].rule_sets.find((r: any) => r.host === "github.com").fallback === "allow", "fallback never saved");
  });

  it("a drag with an uncommitted edit keeps the edit on its own rule", async () => {
    // the bug this guards: rows were keyed by index, so a pattern typed into
    // rule 0 and not yet committed stayed at index 0 through a drag and then
    // committed onto the rule that landed there.
    const block = '[data-testid="rules-api.github.com"]';
    const rulesOf = (s: any) => s.roles[0].rule_sets.find((r: any) => r.host === "api.github.com").rules;
    const [r0, r1] = rulesOf(await settingsLoad());
    await setInputValue(`${block} [data-rule-index="0"] [data-field="pattern"]`, "/e2e/draft");
    await pointerDrag(`${block} [data-rule-index="1"] [data-rule-handle]`, `${block} [data-rule-index="0"]`, { land: "top", hold: true });
    await pointerRelease(`${block} [data-rule-index="1"] [data-rule-handle]`);
    await waitSaved(s => rulesOf(s)[0].pattern === r1.pattern && rulesOf(s)[1].pattern === r0.pattern,
      "the drag never saved the swapped order");
    // the edited field moved with its rule: it is row 1 now, still holding
    // the draft, and committing it changes that rule only.
    expect(await browser.execute((sel: string) => (document.querySelector(sel) as HTMLInputElement).value,
      `${block} [data-rule-index="1"] [data-field="pattern"]`)).toBe("/e2e/draft");
    await typeAndCommit(`${block} [data-rule-index="1"] [data-field="pattern"]`, "/e2e/draft");
    await waitSaved(s => rulesOf(s)[1].pattern === "/e2e/draft", "the draft never committed");
    const after = rulesOf(await settingsLoad());
    expect(after[0]).toEqual(r1);
    expect(after[1].effect).toBe(r0.effect);
    // put rule 0 back as it was for the cases below.
    await typeAndCommit(`${block} [data-rule-index="1"] [data-field="pattern"]`, r0.pattern);
    await browser.execute((sel: string) => (document.querySelector(sel) as HTMLElement).focus(),
      `${block} [data-rule-index="1"] [data-rule-handle]`);
    await browser.keys("ArrowUp");
    await waitSaved(s => rulesOf(s)[0].pattern === r0.pattern && rulesOf(s)[1].pattern === r1.pattern, "the order never came back");
  });

  it("refuses an empty pattern instead of saving a match-all rule", async () => {
    // (an empty method list cannot be built: the verb picker keeps the last
    // verb on, which the picker case below checks.)
    const row = '[data-testid="rules-api.github.com"] [data-rule-index="0"]';
    const rule0 = (s: any) => s.roles[0].rule_sets.find((r: any) => r.host === "api.github.com").rules[0];
    const before = rule0(await settingsLoad());
    await typeAndCommit(`${row} [data-field="pattern"]`, "   ");
    // a refusal has nothing to wait for, so save something real after it:
    // saves run in order, so once this lands any earlier one would have too.
    await typeAndCommit(`${row} [data-field="note"]`, "e2e marker");
    await waitSaved(s => rule0(s).note === "e2e marker", "the marker note never saved");
    expect({ ...rule0(await settingsLoad()), note: before.note }).toEqual(before);
    expect(await browser.execute((sel: string) => (document.querySelector(sel) as HTMLInputElement).value,
      `${row} [data-field="pattern"]`)).toBe(before.pattern);
  });

  it("turns a rule off without losing it, and back on", async () => {
    const row = '[data-testid="rules-api.github.com"] [data-rule-index="0"]';
    const rule0 = (s: any) => s.roles[0].rule_sets.find((r: any) => r.host === "api.github.com").rules[0];
    const pattern = rule0(await settingsLoad()).pattern;
    await clickPresent(`${row} button[aria-label="Turn rule off (kept, but skipped)"]`);
    await waitSaved(s => rule0(s).disabled === true && rule0(s).pattern === pattern, "the rule never turned off");
    await waitVisible(`${row}[data-rule-disabled]`);
    await snap("secrets-rule-off.png");
    await clickPresent(`${row} button[aria-label="Turn rule on"]`);
    // on again: the flag is dropped, not stored as false.
    await waitSaved(s => !("disabled" in rule0(s)) || rule0(s).disabled === false, "the rule never turned back on");
    await waitGone(`${row}[data-rule-disabled]`);
  });

  // the uploads block starts as the Reviewer template left it: ALLOW GET,
  // HEAD /**, fallback deny. The three cases below build on each other.
  const uploads = '[data-testid="rules-uploads.github.com"]';
  const uploadRules = (s: any) => s.roles[0].rule_sets.find((r: any) => r.host === "uploads.github.com").rules;
  /** Radix dismisses on an Escape keydown at the document. */
  const closePicker = async () => {
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await waitGone('[data-testid="verb-picker"]');
  };
  const pickerVerbs = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="verb-picker"] [data-verb]')].map(e => e.getAttribute("data-verb")));

  it("picks a rule's verbs from the popover, a custom verb included", async () => {
    // each block offers the verbs its requests can have.
    await clickPresent('[data-testid="rules-github.com"] [data-rule-index="0"] [data-field="methods"]');
    await waitVisible('[data-testid="verb-picker"]');
    expect(await pickerVerbs()).toEqual(["fetch", "push"]);
    await closePicker();
    await clickPresent('[data-testid="rules-api.github.com"] [data-rule-index="0"] [data-field="methods"]');
    await waitVisible('[data-testid="verb-picker"]');
    expect(await pickerVerbs()).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "QUERY", "MUTATION", "*"]);
    await snap("secrets-verb-picker.png");
    await closePicker();

    const before = uploadRules(await settingsLoad()).length;
    await clickPresent('[data-testid="rules-uploads.github.com-add"]');
    const row = `${uploads} [data-rule-index="${before}"]`;
    await waitVisible(row);
    await typeAndCommit(`${row} [data-field="pattern"]`, "/repos/*/*/releases/*/assets");
    await waitSaved(s => uploadRules(s)[before]?.pattern === "/repos/*/*/releases/*/assets", "the new rule never saved");
    await clickPresent(`${row} [data-field="methods"]`);
    await waitVisible('[data-testid="verb-picker"]');
    // a plain HTTP host: no GraphQL or git verbs.
    expect(await pickerVerbs()).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "*"]);
    await clickPresent('[data-testid="verb-picker"] [data-verb="POST"]');
    await waitSaved(s => uploadRules(s)[before].methods.join() === "GET,POST", "POST never toggled on");
    await clickPresent('[data-testid="verb-picker"] [data-verb="GET"]');
    await waitSaved(s => uploadRules(s)[before].methods.join() === "POST", "GET never toggled off");
    // the last verb stays on: a rule with no method would match nothing.
    await clickPresent('[data-testid="verb-picker"] [data-verb="POST"]');
    // a verb that is not a token is refused in place, and nothing saves.
    await typeAndCommit('[data-testid="verb-custom"]', "G/T");
    await waitVisible('[data-testid="verb-custom"][aria-invalid="true"]');
    await typeAndCommit('[data-testid="verb-custom"]', "propfind");
    await waitSaved(s => uploadRules(s)[before].methods.join() === "POST,PROPFIND", "the custom verb never saved");
    await waitVisible('[data-testid="verb-picker"] [data-verb="PROPFIND"][aria-pressed="true"]');
    await snap("secrets-verb-custom.png");
    await closePicker();
    // the row's button shows the chosen verbs.
    expect(await browser.execute((s: string) => document.querySelector(s)!.textContent, `${row} [data-field="methods"]`)).toBe("POSTPROPFIND");
  });

  it("the request tester names the deciding rule, or the fallback", async () => {
    const secretId = (await settingsLoad()).secrets.find((x: any) => x.name === "gh-review").id;
    const verdict = () => browser.execute(() => {
      const v = document.querySelector('[data-testid="rule-tester-verdict"]');
      return { effect: v?.getAttribute("data-effect") ?? null, text: v?.textContent ?? "" };
    });
    const tryRequest = async (q: string, effect: string, hit: string) => {
      await setInputValue('[data-testid="rule-tester-input"]', q);
      await browser.waitUntil(async () => (await verdict()).effect === effect
        && await browser.execute((s: string) => !!document.querySelector(s), `${hit}[data-rule-hit]`),
      { timeout: 5_000, timeoutMsg: `${q}: never ${effect} by ${hit}` });
      // exactly one line lights up across every block.
      expect(await browser.execute(() => document.querySelectorAll("[data-rule-hit]").length)).toBe(1);
    };
    await setSelect('[data-testid="rule-tester-block"]', `${secretId}@uploads.github.com`);
    await tryRequest("GET /repos/acme/widget/releases/assets/1", "allow", `${uploads} [data-rule-index="0"]`);
    expect((await verdict()).text).toContain("by rule 1 on uploads.github.com (download, never upload)");
    await tryRequest("PROPFIND /repos/acme/widget/releases/9/assets", "allow", `${uploads} [data-rule-index="1"]`);
    await tryRequest("DELETE /repos/acme/widget", "deny", `${uploads} [data-rule-fallback]`);
    expect((await verdict()).text).toContain("falls to the block's last line");
    await snap("secrets-tester-fallback.png");
    // git: pseudo-verbs are judged as what they are.
    await setSelect('[data-testid="rule-tester-block"]', `${secretId}@github.com`);
    await tryRequest("push acme/widget", "deny", '[data-testid="rules-github.com"] [data-rule-index="1"]');
    await tryRequest("fetch acme/widget", "allow", '[data-testid="rules-github.com"] [data-rule-index="0"]');
    // a line that is not a request says why, and lights nothing.
    await setInputValue('[data-testid="rule-tester-input"]', "push");
    await browser.waitUntil(async () => (await verdict()).text.includes("owner/repo"),
      { timeout: 5_000, timeoutMsg: "a bare push never explained itself" });
    expect(await browser.execute(() => document.querySelectorAll("[data-rule-hit]").length)).toBe(0);
    await setSelect('[data-testid="rule-tester-block"]', `${secretId}@uploads.github.com`);
    await tryRequest("PROPFIND /repos/acme/widget/releases/9/assets", "allow", `${uploads} [data-rule-index="1"]`);
  });

  it("sorts a block by specificity, and the tester follows the move", async () => {
    const [broad, narrow] = uploadRules(await settingsLoad());
    expect(broad.pattern).toBe("/**");
    await clickPresent('[data-testid="rules-uploads.github.com-sort"]');
    await waitSaved(s => uploadRules(s)[0].pattern === narrow.pattern && uploadRules(s)[1].pattern === broad.pattern,
      "the sort never saved");
    expect(uploadRules(await settingsLoad())).toEqual([narrow, broad]);
    // the tester re-judges on the new order: the same request, now rule 1.
    await browser.waitUntil(() => browser.execute((s: string) => !!document.querySelector(s), `${uploads} [data-rule-index="0"][data-rule-hit]`),
      { timeout: 5_000, timeoutMsg: "the tester did not follow the sort" });
    await snap("secrets-sorted.png");
    // a rule that is off is not sorted, so one enabled rule leaves nothing to sort.
    await clickPresent(`${uploads} [data-rule-index="1"] button[aria-label="Turn rule off (kept, but skipped)"]`);
    await waitSaved(s => uploadRules(s)[1].disabled === true, "the off switch never saved");
    await waitVisible('[data-testid="rules-uploads.github.com-sort"][disabled]');
    await clickPresent(`${uploads} [data-rule-index="1"] button[aria-label="Turn rule on"]`);
    await waitSaved(s => !uploadRules(s)[1].disabled, "the rule never turned back on");
  });

  it("duplicates a role with its secrets and rules", async () => {
    const orig = (await settingsLoad()).roles[0];
    await clickPresent('[data-testid="role-duplicate"]');
    await waitSaved(s => s.roles.length === 2, "the copy never saved");
    const copy = (await settingsLoad()).roles[1];
    expect(copy.id).not.toBe(orig.id);
    expect(copy.name).toBe(`${orig.name} copy`);
    expect(copy.colour).not.toBe(orig.colour);
    expect(copy.secrets).toEqual(orig.secrets);
    expect(copy.rule_sets).toEqual(orig.rule_sets);
    // the copy is the one now open in the editor
    const copyName: string = copy.name;
    await browser.waitUntil(() => browser.execute((n: string) =>
      (document.querySelector('[data-testid="role-name"]') as HTMLInputElement | null)?.value === n, copyName),
    { timeout: 5_000, timeoutMsg: "the editor did not switch to the copy" });
    // a second copy of the original does not reuse the name
    await clickPresent(`[data-role-row="${orig.name}"]`);
    await clickPresent('[data-testid="role-duplicate"]');
    await waitSaved(s => s.roles.length === 3, "the second copy never saved");
    expect((await settingsLoad()).roles[2].name).toBe(`${orig.name} copy 2`);
    // put it back the way the next cases expect: one role.
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.invoke("settings_load") as any;
      await t.invoke("settings_save", { s: { ...s, roles: s.roles.slice(0, 1) } });
    });
    await waitSaved(s => s.roles.length === 1, "the copies were not cleaned up");
    await clickPresent(`[data-role-row="${orig.name}"]`);
  });

  it("refuses two secrets on one host in a role", async () => {
    await clickPresent('[data-role-secret="Reviewer bot/gh-maintain"]');
    await waitForText("A role can hold one secret per host.");
    const role = (await settingsLoad()).roles[0];
    expect(role.secrets.length).toBe(1);
    expect(await browser.execute(() =>
      document.querySelector('[data-role-secret="Reviewer bot/gh-maintain"]')?.getAttribute("aria-checked"))).toBe("false");
  });

  it("shows the role as JSON, with secrets by name", async () => {
    // the cases above wrote settings behind the page's back, and the page
    // edits a copy seeded on mount: remount it so a save here cannot write
    // the stale copy back.
    await reopenRoles((await settingsLoad()).roles[0].name);
    await clickPresent('[data-testid="role-json-open"]');
    await waitVisible('[data-testid="role-json-export"]');
    const j = JSON.parse(await browser.execute(() => document.querySelector('[data-testid="role-json-export"]')!.textContent!));
    const role = (await settingsLoad()).roles[0];
    expect(j).toMatchObject({ termic_role: 1, name: role.name, colour: role.colour });
    expect(Object.keys(j.secrets)).toEqual(["gh-review"]);
    const git = role.rule_sets.find((r: any) => r.host === "github.com");
    expect(j.secrets["gh-review"]["github.com"]).toEqual({
      otherwise: git.fallback,
      rules: git.rules.map((r: any) => ({ [r.effect]: r.methods.join(" "), match: r.pattern, ...(r.note ? { note: r.note } : {}) })),
    });
    await snap("secrets-role-json.png");
  });

  it("refuses invalid JSON, then replaces the role and keeps its id", async () => {
    const paste = '[data-testid="role-json-paste"]';
    const addDisabled = () => browser.execute(() => (document.querySelector('[data-testid="role-json-add"]') as HTMLButtonElement).disabled);
    await setInputValue(paste, "{ nope");
    await waitVisible('[data-testid="role-json-preview"] [data-import-error]');
    await waitForText("Not valid JSON");
    expect(await addDisabled()).toBe(true);
    // valid JSON, but naming a secret this Mac does not have.
    await setInputValue(paste, JSON.stringify({ termic_role: 1, name: "X", secrets: { "gh-bob": {} } }));
    await waitForText("No secret named gh-bob.");
    expect(await addDisabled()).toBe(true);
    await snap("secrets-role-json-invalid.png");

    const before = (await settingsLoad()).roles[0];
    const j = JSON.parse(await browser.execute(() => document.querySelector('[data-testid="role-json-export"]')!.textContent!));
    await setInputValue(paste, JSON.stringify({ ...j, description: "replaced from JSON" }));
    await waitVisible('[data-testid="role-json-preview"][data-valid]');
    await waitForText("Description changed");
    await clickPresent('[data-testid="role-json-replace"]');
    await waitSaved(s => s.roles.length === 1 && s.roles[0].description === "replaced from JSON", "the replace never saved");
    const after = (await settingsLoad()).roles[0];
    expect(after.id).toBe(before.id);
    expect(after.rule_sets.length).toBe(before.rule_sets.length);
    // back on the rules editor.
    await waitVisible('[data-testid="role-editor"]');
  });

  it("pastes a modified JSON from New role and adds it as a new role", async () => {
    const orig = (await settingsLoad()).roles[0];
    await clickPresent('[data-testid="role-json-open"]');
    await waitVisible('[data-testid="role-json-export"]');
    const j = JSON.parse(await browser.execute(() => document.querySelector('[data-testid="role-json-export"]')!.textContent!));
    await clickPresent('[data-testid="role-json-close"]');
    await waitVisible('[data-testid="role-editor"]');

    await openMenu('[data-testid="roles-new"]');
    await clickPresent('[data-role-template="json"]');
    await waitVisible('[data-testid="role-json"]');
    // the New role flow has nothing to export or replace.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="role-json-export"], [data-testid="role-json-replace"]'))).toBe(false);
    const api = j.secrets["gh-review"]["api.github.com"];
    const edited = { ...j, name: "Imported", colour: "pink", secrets: { "gh-review": { ...j.secrets["gh-review"],
      "api.github.com": { ...api, rules: api.rules.slice(1) } } } };
    await setInputValue('[data-testid="role-json-paste"]', JSON.stringify(edited));
    await waitVisible('[data-testid="role-json-preview"][data-valid]');
    // textContent, not innerText: the heading is an uppercase eyebrow.
    expect(await browser.execute(() => document.querySelector('[data-testid="role-json-preview"]')!.textContent))
      .toContain("Import preview · Imported");
    await snap("secrets-role-json-preview.png");
    await clickPresent('[data-testid="role-json-add"]');
    await waitSaved(s => s.roles.length === 2 && s.roles[1].name === "Imported", "the imported role never saved");
    const added = (await settingsLoad()).roles[1];
    expect(added.id).not.toBe(orig.id);
    expect(added.colour).toBe("pink");
    expect(added.secrets).toEqual(orig.secrets);
    const apiOf = (r: any) => r.rule_sets.find((x: any) => x.host === "api.github.com");
    expect(apiOf(added).rules).toEqual(apiOf(orig).rules.slice(1));
    // the new role is the one open in the editor.
    await browser.waitUntil(() => browser.execute(() =>
      (document.querySelector('[data-testid="role-name"]') as HTMLInputElement | null)?.value === "Imported"),
    { timeout: 5_000, timeoutMsg: "the editor did not switch to the imported role" });
    // back to one role for the cases below.
    await browser.execute(async () => {
      const t = window.__termic!;
      const s = await t.invoke("settings_load") as any;
      await t.invoke("settings_save", { s: { ...s, roles: s.roles.slice(0, 1) } });
    });
    await waitSaved(s => s.roles.length === 1, "the imported role was not cleaned up");
    await reopenRoles(orig.name);
  });

  it("defaults an agent to the role", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await clickPresent('[data-agent-id="fakeagent"]');
    const sel = '[data-testid="agent-default-role"][data-agent="fakeagent"]';
    // the role list loads per mount; wait for the option before picking it.
    await browser.waitUntil(() => browser.execute((s, id) =>
      !!document.querySelector(`${s} option[value="${id}"]`), sel, roleId),
    { timeout: 10_000, timeoutMsg: "the role never showed in the agent's picker" });
    await setSelect(sel, roleId);
    await waitSaved(s => s.agents.find((a: any) => a.id === "fakeagent")?.default_role === roleId, "agent default never saved");
  });

  it("defaults a project to the role", async () => {
    await browser.execute((id) => window.__termic!.useApp.getState().openSettings("repositories", id), projectId);
    await clickPresent('[data-repo-tab="secrets"]');
    await waitForText("New tasks default to");
    await clickPresent(`[data-role-card="${roleId}"]`);
    await browser.waitUntil(() => browser.execute((pid) =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.id === pid)?.default_role, projectId)
      .then(v => v === roleId),
    { timeout: 10_000, timeoutMsg: "project default never saved" });
    expect(await browser.execute((id) =>
      document.querySelector(`[data-role-card="${id}"]`)?.getAttribute("aria-checked"), roleId)).toBe("true");
    await snap("secrets-m3-project-default.png");

    // "No secrets" is an explicit "" that overrides the agent default; the
    // inherit card is null. The two used to save the same null.
    const savedDefault = () => browser.execute((pid) =>
      window.__termic!.useApp.getState().projects.find((p: any) => p.id === pid)?.default_role, projectId);
    await clickPresent('[data-role-card="none"]');
    await browser.waitUntil(() => savedDefault().then(v => v === ""),
      { timeout: 10_000, timeoutMsg: "No secrets never saved as an explicit \"\"" });
    expect(await browser.execute(() =>
      document.querySelector('[data-role-card="inherit"]')?.getAttribute("aria-checked"))).toBe("false");
    await clickPresent('[data-role-card="inherit"]');
    await browser.waitUntil(() => savedDefault().then(v => v == null),
      { timeout: 10_000, timeoutMsg: "inherit never saved as null" });
    await clickPresent(`[data-role-card="${roleId}"]`);
  });

  it("lists the defaults on the Roles matrix", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("secrets"));
    await secretsTab("roles");
    await waitForText("agent FakeAgent, project fixture-repo");
    await snap("secrets-m2-matrix.png");
  });

  it("jumps from a secret to its activity", async () => {
    await secretsTab("secrets");
    await clickPresent('[data-secret-row="gh-review"]');
    await clickPresent('[data-testid="secret-activity"]');
    await waitVisible('[data-testid="secrets-activity"]');
    await waitForText("Showing gh-review only.");
    await snap("secrets-activity.png");
  });

  it("removes a secret after confirming, and the role loses it", async () => {
    await secretsTab("secrets");
    await clickPresent('[data-secret-row="gh-review"]');
    await clickPresent('[data-testid="secret-remove"]');
    await browser.waitUntil(() => browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"]')].some(d => d.textContent?.includes("Remove gh-review?"))),
    { timeout: 10_000, timeoutMsg: "the remove confirm never opened" });
    await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find(x => x.textContent?.includes("Remove gh-review?"))!;
      ([...d.querySelectorAll("button")].find(b => b.textContent?.trim() === "Remove") as HTMLElement).click();
    });
    await waitSaved(s => s.secrets.length === 1 && s.roles[0].secrets.length === 0 && s.roles[0].rule_sets.length === 0,
      "the secret was not removed from settings and the role");
  });
});

// "Kept out of agents": env vars Termic's own environment holds that agent
// tabs do not inherit (env_guard.rs). wdio.conf.ts launches the app with a
// synthetic token in TERMIC_E2E_FAKE_PAT, which the value check detects.
describe("settings: env vars kept out of agents", () => {
  const PAT = "TERMIC_E2E_FAKE_PAT";
  const row = (name: string) => `[data-testid="kept-out-row-${name}"]`;
  const statusText = (name: string) => browser.execute((n) =>
    document.querySelector(`[data-testid="kept-out-status-${n}"]`)?.textContent ?? "", name);
  const passEnv = (s: any) => s.agents.find((a: any) => a.id === "fakeagent")?.pass_env ?? [];
  let original: any;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await settingsLoad();
    await browser.execute(async (s: any) => {
      const t = window.__termic!;
      const agents = s.agents.map((a: any) => ({ ...a, pass_env: [] }));
      await t.invoke("settings_save", { s: { ...s, env_guard: [], agents } });
      await t.useApp.getState().loadAll();
      t.useApp.getState().openSettings("secrets");
    }, original);
  });

  after(async () => {
    await browser.execute(async (s) => {
      const t = window.__termic!;
      await t.invoke("settings_save", { s });
      await t.useApp.getState().loadAll();
      t.useApp.getState().closeSettings();
    }, original);
  });

  it("lists a detected token by name only, on its own Env vars tab", async () => {
    await waitVisible('[data-testid="secrets-health"]');
    expect(await browser.execute(() => !!document.querySelector('[data-testid="secrets-kept-out"]'))).toBe(false);
    await clickPresent('[data-secrets-tab="env"]');
    await waitVisible(row(PAT));
    await waitForText("Agent tabs don't get these. Your own terminals still do.");
    const card = await browser.execute(() => document.querySelector('[data-testid="secrets-kept-out"]')!.textContent ?? "");
    expect(card).toContain("detected");
    expect(card).not.toContain("e2eFakeToken");
    expect(card).not.toContain("ghp_");
    expect(await statusText(PAT)).toBe("Hidden from caged agent tabs. Uncaged ones still get it.");
    // the heading's tip carries the built-in list
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="secrets-kept-out"] [aria-label*="Always watched"]')?.getAttribute("aria-label") ?? "")).toContain("GITLAB_TOKEN");
    await snap("secrets-kept-out.png");
  });

  it("switches a var to all agents and back", async () => {
    await clickPresent(`[data-testid="kept-out-scope-${PAT}"] [data-value="all"]`);
    await waitSaved(s => JSON.stringify(s.env_guard) === JSON.stringify([{ name: PAT, all: true }]), "the all-agents scope never saved");
    expect(await statusText(PAT)).toBe("Hidden from every agent tab.");
    await clickPresent(`[data-testid="kept-out-scope-${PAT}"] [data-value="caged"]`);
    // caged is a detected var's default, so no rule is left behind
    await waitSaved(s => (s.env_guard ?? []).length === 0, "the caged scope left a rule");
  });

  it("refuses a bad name, then adds one that defaults to all agents", async () => {
    await setInputValue('[data-testid="kept-out-add-input"]', "1BAD");
    await clickPresent('[data-testid="kept-out-add"]');
    await waitForText("Letters, digits and underscores only");
    expect((await settingsLoad() as any).env_guard ?? []).toEqual([]);
    await setInputValue('[data-testid="kept-out-add-input"]', "STRIPE_SECRET_KEY");
    await clickPresent('[data-testid="kept-out-add"]');
    await waitVisible(row("STRIPE_SECRET_KEY"));
    await waitSaved(s => JSON.stringify(s.env_guard) === JSON.stringify([{ name: "STRIPE_SECRET_KEY", all: true }]), "the added name never saved");
    expect(await statusText("STRIPE_SECRET_KEY")).toBe("Not set right now.");
    expect(await browser.execute(() => document.querySelector('[data-testid="kept-out-scope-STRIPE_SECRET_KEY"] [data-value="all"]')?.getAttribute("aria-pressed"))).toBe("true");
    await snap("secrets-kept-out-added.png");
  });

  it("removes an added name", async () => {
    await clickPresent('[data-testid="kept-out-remove-STRIPE_SECRET_KEY"]');
    await waitGone(row("STRIPE_SECRET_KEY"));
    await waitSaved(s => (s.env_guard ?? []).length === 0, "the removed name is still saved");
  });

  it("passes a var through to one agent, and takes it back", async () => {
    await clickPresent(`[data-testid="kept-out-pass-${PAT}"]`);
    await clickPresent(`[data-testid="kept-out-pass-${PAT}-fakeagent"]`);
    await waitSaved(s => passEnv(s).includes(PAT), "the pass-through never saved");
    // the fixture has ~20 agents: the list scrolls rather than running off the window
    const fits = await browser.execute((n) => {
      const r = document.querySelector(`[data-testid="kept-out-pass-list-${n}"]`)!.closest("[data-radix-popper-content-wrapper]")!.getBoundingClientRect();
      return r.bottom <= window.innerHeight;
    }, PAT);
    expect(fits).toBe(true);
    await browser.waitUntil(async () => (await statusText(PAT)).includes("FakeAgent gets the real value."),
      { timeout: 10_000, timeoutMsg: "the row never said it was passed" });
    await snap("secrets-kept-out-pass.png");
    await clickPresent(`[data-testid="kept-out-pass-${PAT}-fakeagent"]`);
    await waitSaved(s => !passEnv(s).includes(PAT), "the pass-through was never taken back");
    await browser.keys("Escape");
  });

  it("opens Add secret for a detected token", async () => {
    await clickPresent(`[data-testid="kept-out-add-secret-${PAT}"]`);
    await waitVisible('[data-testid="add-secret-dialog"]');
    await waitForText(`Paste the value of ${PAT} below.`);
    // the dialog opens over the Secrets tab, where the new secret would land
    await waitVisible('[data-testid="secrets-health"]');
    await browser.keys("Escape");
    await waitGone('[data-testid="add-secret-dialog"]');
  });

  it("toggles the pass-through from the agent's card", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("agents"));
    await clickPresent('[data-agent-id="fakeagent"]');
    await clickPresent('[data-testid="agent-fold-env-fakeagent"] > button');
    const toggle = `[data-testid="agent-inherited-toggle-fakeagent-${PAT}"]`;
    await waitVisible(toggle);
    await waitForText("kept out · caged only");
    await clickPresent(toggle);
    await waitSaved(s => passEnv(s).includes(PAT), "the card's pass-through never saved");
    await waitForText("Keep out");
    await browser.execute((s) => document.querySelector(s)!.scrollIntoView({ block: "center" }), '[data-testid="agent-inherited-env-fakeagent"]');
    await snap("agent-inherited-env.png");
    await clickPresent(toggle);
    await waitSaved(s => !passEnv(s).includes(PAT), "the card's keep-out never saved");
    // the card's link lands on the Env vars tab, where the list now lives
    await browser.execute(() => {
      const b = [...document.querySelectorAll('[data-testid="agent-inherited-env-fakeagent"] button')]
        .find(x => x.textContent?.trim() === "Edit the list in Secrets") as HTMLElement;
      b.click();
    });
    await waitVisible(row(PAT));
  });

  // What the SPAWNED agent received, read from the fixture agent's log
  // (terminal output is a WebGL canvas). The fixture logs "set" or nothing,
  // never the value. The task is uncaged, so only an all-agents rule applies.
  it("an uncaged agent loses an all-agents var, and gets it when passed through", async () => {
    const spawns = (taskId: string) => readFileSync(join(dataDir, "e2e-agent-login.log"), "utf8").trim().split("\n")
      .filter(l => l.startsWith(taskId + "\t"));
    const lastSpawn = (taskId: string) => spawns(taskId).length;
    const received = (taskId: string) => spawns(taskId).at(-1)?.split("\t").includes(`${PAT}=set`) ?? false;
    const setGuard = (all: boolean, pass: string[]) => browser.execute(async (n, a, p) => {
      const t = window.__termic!;
      await t.invoke("env_guard_save", { rules: a ? [{ name: n, all: true }] : [] });
      await t.invoke("agent_set_pass_env", { agentId: "fakeagent", names: p });
    }, PAT, all, pass);
    const spawn = async (taskId: string | null): Promise<string> => {
      if (taskId) {
        const before = lastSpawn(taskId);
        await browser.execute((id) => { const s = window.__termic!.useApp.getState(); s.stopTask(id); s.setActiveTask(null); }, taskId);
        await waitTaskUnmounted(taskId);
        await browser.execute((id) => window.__termic!.useApp.getState().setActiveTask(id), taskId);
        await browser.waitUntil(async () => lastSpawn(taskId) > before, { timeout: 30_000, timeoutMsg: "the agent never respawned" });
        return taskId;
      }
      const id = await openTask("kept-out env");
      await waitForAgentReady(id);
      return id;
    };
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    let taskId = "";
    try {
      // control: caged-only, so an uncaged agent still inherits it
      await setGuard(false, []);
      taskId = await spawn(null);
      expect(received(taskId)).toBe(true);
      await setGuard(true, []);
      await spawn(taskId);
      expect(received(taskId)).toBe(false);
      await setGuard(true, [PAT]);
      await spawn(taskId);
      expect(received(taskId)).toBe(true);
    } finally {
      await setGuard(false, []);
      if (taskId) await archiveTask(taskId);
    }
  });
});
