// Settings -> Secrets, pasted values: pick a preset, paste
// a key or a GitHub token, replace it, and check what is saved. The e2e
// build keeps Termic-owned Keychain items in memory (broker/keychain.rs) and
// reports the protected keychain as available, so every pasted value lands
// as kind "protected", nothing here touches a real keychain, and the probe
// of a stored value really reads it back.
//
// The broker's spawn-side delivery (base URL, env proxy) is covered by
// broker/tests.rs; this spec is the dialog (its inline field errors and the
// "What happens" panel's routes), the saved shape, and the Keychain
// lifecycle the UI drives.

import {
  clickPresent, requireTermicApi, setInputValue, snap, textOf, waitForAppShell, waitForText, waitGone, waitVisible,
} from "../helpers";

const KEY = "sk-e2e-not-a-real-key-0123456789";
const KEY2 = "sk-e2e-rotated-key-9876543210";
const TOKEN = "github_pat_e2e_not_a_real_token_0123456789";

const dialogWith = (text: string) => browser.execute((t) =>
  [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent?.includes(t))?.textContent ?? null, text);

/** Click a button by its exact label inside the dialog whose text has `text`. */
const clickInDialog = (text: string, label: string) => browser.execute((t, l) => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find(x => x.textContent?.includes(t))!;
  ([...d.querySelectorAll("button")].find(b => b.textContent?.trim() === l) as HTMLElement).click();
}, text, label);

const storedCell = (name: string) => browser.execute((n) =>
  (document.querySelector(`[data-secret-row="${n}"] [data-col="stored"]`) as HTMLElement | null)?.innerText.trim() ?? null, name);

const settingsLoad = () => browser.execute(() => window.__termic!.invoke("settings_load"));

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

const inputValue = (sel: string) =>
  browser.execute((s) => (document.querySelector(s) as HTMLInputElement | null)?.value ?? null, sel);

const probe = async (id: string): Promise<{ status: string }> =>
  await browser.execute(async (i) => await window.__termic!.invoke("secret_probe", { id: i }), id) as { status: string };

async function rowStatus(name: string): Promise<string> {
  let st = "";
  await browser.waitUntil(async () => {
    st = await browser.execute((n) =>
      document.querySelector(`[data-secret-row="${n}"] [data-status]`)?.getAttribute("data-status") ?? "", name);
    return !!st && st !== "checking";
  }, { timeout: 10_000, timeoutMsg: `${name} was never probed` });
  return st;
}

/** The "What happens" panel's routes, `{ route: on }`. */
const routes = () => browser.execute(() => Object.fromEntries(
  [...document.querySelectorAll('[data-testid="add-secret-preview"] [data-route]')]
    .map(e => [e.getAttribute("data-route"), e.getAttribute("data-on") === "true"])));

async function waitRoutes(want: Record<string, boolean>) {
  await browser.waitUntil(async () => JSON.stringify(await routes()) === JSON.stringify(want),
    { timeout: 5_000, timeoutMsg: `routes never became ${JSON.stringify(want)}: ${JSON.stringify(await routes())}` });
}

const routeText = (r: string) => textOf(`[data-testid="add-secret-preview"] [data-route="${r}"]`);

/** Wait for a field's inline error to read `text`. */
async function waitFieldError(field: string, text: string) {
  const sel = `[data-testid="add-secret-error-${field}"]`;
  await browser.waitUntil(async () => (await textOf(sel)) === text,
    { timeout: 5_000, timeoutMsg: `${field} never said "${text}" (last: "${await textOf(sel)}")` });
}

async function openAdd() {
  await clickPresent('[data-testid="secrets-add"]');
  await waitVisible('[data-testid="add-secret-dialog"]');
}

describe("settings: API key secrets", () => {
  let original: any;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    original = await settingsLoad();
    await browser.execute(async (s) => {
      await window.__termic!.invoke("settings_save", { s: { ...s, secrets: [], roles: [] } });
    }, original);
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("secrets"));
    await waitForText("No secrets yet.");
  });

  after(async () => {
    await browser.execute(async (s) => {
      const t = window.__termic!;
      await t.invoke("settings_save", { s });
      t.useApp.getState().closeSettings();
    }, original);
  });

  it("fills the OpenAI preset and refuses it without a key", async () => {
    await openAdd();
    await setSelect('[data-testid="add-secret-preset"]', "openai");
    await waitVisible('[data-testid="add-secret-value"]');
    expect(await inputValue('[data-testid="add-secret-env"]')).toBe("OPENAI_API_KEY");
    expect(await inputValue('[data-testid="add-secret-header"]')).toBe("authorization");
    expect(await inputValue('[data-testid="add-secret-scheme"]')).toBe("Bearer");
    expect(await inputValue('[data-testid="add-secret-base-url-env"]')).toBe("OPENAI_BASE_URL");
    expect(await inputValue('[data-testid="add-secret-base-url"]')).toBe("https://api.openai.com/v1");
    expect(await inputValue('[data-testid="add-secret-name"]')).toBe("openai");
    const hosts = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="add-secret-hosts"] [data-host]')].map(e => e.getAttribute("data-host")));
    expect(hosts).toEqual(["api.openai.com"]);
    // the GitHub-only fields are gone
    expect(await inputValue('[data-testid="add-secret-service"]')).toBeNull();
    expect(await browser.execute(() => !!document.querySelector('[data-testid="add-secret-source"]'))).toBe(false);
    // this build has the protected keychain, so the dialog says so and the
    // unsigned-build notice stays off the tab.
    await waitForText("Saved to the protected Keychain. Never synced.");
    expect(await browser.execute(() => !!document.querySelector('[data-testid="secrets-unsigned"]'))).toBe(false);
    // the preset turns both deliveries on: its base URL's host is its host
    await waitRoutes({ baseUrl: true, envProxy: true });
    expect(await textOf('[data-testid="add-secret-stand-in"]')).toBe("OPENAI_API_KEY=termic_ph_…");
    expect(await routeText("baseUrl")).toContain("$OPENAI_BASE_URL · local endpoint");
    expect(await routeText("baseUrl")).toContain("authorization: Bearer real value");
    expect(await routeText("envProxy")).toContain("curl, Python and Node. Not Go on macOS.");
    // nothing typed yet, so no field complains before a submit
    expect(await browser.execute(() => document.querySelectorAll('[data-testid^="add-secret-error-"]').length)).toBe(0);
    // OpenAI's key is not one an agent signs in with
    expect(await browser.execute(() => !!document.querySelector('[data-testid="add-secret-login-takeover"]'))).toBe(false);
    await snap("secrets-b-add-openai-preview.png");

    await clickPresent('[data-testid="add-secret-submit"]');
    await waitFieldError("value", "Paste the key.");
    expect((await settingsLoad()).secrets ?? []).toEqual([]);
  });

  it("stores the key in the Keychain, never in settings", async () => {
    await setInputValue('[data-testid="add-secret-value"]', KEY);
    // the value field never echoes the key as text
    expect(await browser.execute(() => (document.querySelector('[data-testid="add-secret-value"]') as HTMLInputElement).type)).toBe("password");
    await snap("secrets-b5-add-api-key.png");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets?.length === 1, "the API key secret never saved");
    const saved = (await settingsLoad()).secrets[0];
    expect(saved).toMatchObject({
      name: "openai", recipe: "api_key", kind: "protected", service: `termic:${saved.id}`, account: "termic",
      hosts: ["api.openai.com"],
      api: { header: "authorization", scheme: "Bearer", env: "OPENAI_API_KEY", base_url_env: "OPENAI_BASE_URL", base_url: "https://api.openai.com/v1" },
    });
    expect(JSON.stringify(await settingsLoad())).not.toContain(KEY);
    // the probe reads the stored item back; unused in a role, so the table
    // says unused rather than readable.
    expect(await rowStatus("openai")).toBe("unused");
    expect((await probe(saved.id)).status).toBe("readable");
    // the Stored in column names Termic's protected store
    expect(await storedCell("openai")).toBe("Termic · protected\npasted key");
  });

  it("shows how an API key is delivered", async () => {
    await clickPresent('[data-secret-row="openai"]');
    await waitVisible('[data-testid="secret-expanded"]');
    await waitForText("Only Termic can read it.");
    // Test access's tip: the item is Termic's, so no macOS prompt
    const tips = () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="secret-expanded"] [aria-label]')].map(e => e.getAttribute("aria-label")!));
    expect(await tips()).toContain("Reads the item once. No prompt: Termic stored it.");
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="secret-stored-box"]')?.getAttribute("data-stored"))).toBe("protected");
    // the Always Allow advice is for items Termic does not own
    expect(await browser.execute(() => document.body.innerText.includes("choose Always Allow"))).toBe(false);
    expect((await tips()).some(t => t.includes("choose Always Allow"))).toBe(false);
    // the agent holds a stand-in in the key's env var; the real key goes
    // into the header
    await waitForText("$OPENAI_API_KEY = termic_ph_…");
    await waitForText("$OPENAI_BASE_URL → local Termic endpoint");
    await waitForText("authorization: Bearer …");
    await snap("secrets-b5-expanded-api-key.png");
    // the table's Delivered column: the base URL endpoint (its URL's host is
    // one of the secret's) and the task proxy
    const delivered = await browser.execute(() =>
      [...document.querySelectorAll('[data-secret-row="openai"] [data-delivered]')].map(e => [e.getAttribute("data-delivered"), e.textContent]));
    expect(delivered).toEqual([["baseUrl", "$OPENAI_BASE_URL · endpoint"], ["proxy", "HTTPS_PROXY"]]);
    // a long env var wraps inside its column instead of running into Hosts
    // (34px over before the fix, seen in the first screenshot pass).
    const overflow = await browser.execute(() => {
      const el = document.querySelector('[data-secret-row="openai"] [data-col="delivered"]') as HTMLElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBe(0);
  });

  it("replaces the stored key in place", async () => {
    const before = (await settingsLoad()).secrets.find((s: any) => s.name === "openai");
    await clickPresent('[data-testid="secret-replace"]');
    await waitVisible('[data-testid="replace-secret-dialog"]');
    expect(await dialogWith("Replace openai's key")).toContain("Revoke the old key with its provider once this one works.");
    // nothing to replace with yet
    expect(await browser.execute(() =>
      (document.querySelector('[data-testid="replace-secret-submit"]') as HTMLButtonElement).disabled)).toBe(true);
    await setInputValue('[data-testid="replace-secret-value"]', KEY2);
    expect(await browser.execute(() => (document.querySelector('[data-testid="replace-secret-value"]') as HTMLInputElement).type)).toBe("password");
    await snap("secrets-c4-replace-key.png");
    await clickInDialog("Replace openai's key", "Replace");
    await browser.waitUntil(async () => (await dialogWith("Replace openai's key")) === null,
      { timeout: 10_000, timeoutMsg: "the replace dialog never closed" });
    // same secret, same kind, same store; the new value reads back
    const after = (await settingsLoad()).secrets.find((s: any) => s.name === "openai");
    expect(after).toEqual(before);
    expect((await probe(after.id)).status).toBe("readable");
    expect(JSON.stringify(await settingsLoad())).not.toContain(KEY2);
  });

  it("checks a custom key's fields as you type and flips its routes", async () => {
    await openAdd();
    await setSelect('[data-testid="add-secret-preset"]', "custom");
    await waitVisible('[data-testid="add-secret-value"]');
    // a custom key opens its delivery fields: they are all it has
    expect(await browser.execute(() => (document.querySelector('[data-testid="add-secret-delivery"]') as HTMLDetailsElement).open)).toBe(true);
    await setInputValue('[data-testid="add-secret-value"]', KEY);
    await setInputValue('[data-testid="add-secret-name"]', "acme-api");
    // no hosts: nothing can be delivered
    await waitRoutes({ baseUrl: false, envProxy: false });
    expect(await routeText("envProxy")).toContain("Add a host to turn on.");
    expect(await routeText("baseUrl")).toContain("Go and Rust tools need this one: set a base URL.");
    // before any submit: the error shows as you type and clears once the name is good
    await setInputValue('[data-testid="add-secret-env"]', "1ACME");
    await waitFieldError("env", "Name the env var, like OPENAI_API_KEY.");
    await setInputValue('[data-testid="add-secret-env"]', "HTTPS_PROXY");
    await waitFieldError("env", "Termic sets HTTPS_PROXY itself. Pick another name.");
    await setInputValue('[data-testid="add-secret-header"]', "proxy-authorization");
    await waitFieldError("header", "\"proxy-authorization\" can't carry a secret.");
    // both at once: every field says its own problem, not just the first (hosts
    // is empty too, but untouched and not yet submitted, so it stays quiet)
    expect(await browser.execute(() => document.querySelectorAll('[data-testid^="add-secret-error-"]').length)).toBe(2);
    await snap("secrets-b-add-inline-errors.png");
    await clickPresent('[data-testid="add-secret-submit"]');
    expect((await settingsLoad()).secrets.length).toBe(1);
    await setInputValue('[data-testid="add-secret-env"]', "ACME_TOKEN");
    await setInputValue('[data-testid="add-secret-header"]', "authorization");
    await waitGone('[data-testid="add-secret-error-env"]');
    await waitGone('[data-testid="add-secret-error-header"]');
    expect(await textOf('[data-testid="add-secret-stand-in"]')).toBe("ACME_TOKEN=termic_ph_…");

    await clickPresent('[data-testid="add-secret-submit"]');
    await waitFieldError("hosts", "Add at least one host.");
    await setInputValue('[data-testid="add-secret-hosts-input"]', "api.acme.com");
    await clickPresent('[data-testid="add-secret-hosts-add"]');
    await waitVisible('[data-testid="add-secret-hosts"] [data-host="api.acme.com"]');
    await waitGone('[data-testid="add-secret-error-hosts"]');
    await waitRoutes({ baseUrl: false, envProxy: true });

    // a base URL env var alone, then a URL on a host the secret is not bound to
    await setInputValue('[data-testid="add-secret-base-url-env"]', "ACME_BASE_URL");
    await waitFieldError("baseUrl", "Fill in both base URL fields, or leave both empty.");
    await setInputValue('[data-testid="add-secret-base-url"]', "https://other.acme.com/v2");
    await waitFieldError("baseUrl", "other.acme.com isn't one of the hosts.");
    await waitRoutes({ baseUrl: false, envProxy: true });
    expect(await routeText("baseUrl")).toContain("Add other.acme.com to the hosts to turn on.");
    await snap("secrets-b-add-routes-off.png");
    // on a bound host the endpoint turns on, named by its var
    await setInputValue('[data-testid="add-secret-base-url"]', "https://api.acme.com/v2");
    await waitGone('[data-testid="add-secret-error-baseUrl"]');
    await waitRoutes({ baseUrl: true, envProxy: true });
    expect(await routeText("baseUrl")).toContain("$ACME_BASE_URL · local endpoint");
    await snap("secrets-b-add-routes-on.png");
    await setInputValue('[data-testid="add-secret-base-url-env"]', "");
    await setInputValue('[data-testid="add-secret-base-url"]', "");
    await waitRoutes({ baseUrl: false, envProxy: true });

    // a host the front end lets through but secrets.rs refuses: the save
    // fails with Rust's reason, and nothing lands in settings.
    await setInputValue('[data-testid="add-secret-hosts-input"]', "bad_host");
    await clickPresent('[data-testid="add-secret-hosts-add"]');
    await waitVisible('[data-testid="add-secret-hosts"] [data-host="bad_host"]');
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitForText("Couldn't save, so your last change was not kept");
    await waitForText("\"bad_host\" is not a host name like api.github.com");
    await waitSaved(s => s.secrets.length === 1, "the refused secret must not be saved");
    // the toast outlives the case on an occluded window and would sit in
    // every later snap.
    await browser.execute(() => window.__termic!.useUI.setState({ toasts: [] }));
    // fixed, it goes through (the failed save's stored item was cleaned up,
    // and the retry stores it again under the same id)
    await clickPresent('[data-testid="add-secret-hosts"] [data-host="bad_host"] button');
    await waitGone('[data-testid="add-secret-hosts"] [data-host="bad_host"]');
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets.length === 2, "the custom key never saved");
    const acme = (await settingsLoad()).secrets.find((s: any) => s.name === "acme-api");
    expect(acme.api).toMatchObject({ env: "ACME_TOKEN", header: "authorization", base_url_env: "", base_url: "" });
    expect(acme.hosts).toEqual(["api.acme.com"]);
    expect((await probe(acme.id)).status).toBe("readable");
  });

  it("adds a pasted GitHub token as a Termic-owned secret", async () => {
    await openAdd();
    // GitHub is the default kind; its source is picked from gh's accounts,
    // which differ per machine, so pick it explicitly.
    await clickPresent('[data-testid="add-secret-source-paste"]');
    await waitVisible('[data-testid="add-secret-value"]');
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="add-secret-source-paste"]')?.getAttribute("aria-pressed"))).toBe("true");
    expect(await inputValue('[data-testid="add-secret-name"]')).toBe("gh-token");
    // the gh login's fields belong to the other source
    expect(await inputValue('[data-testid="add-secret-service"]')).toBeNull();
    await waitForText("Create a fine-grained token");
    await waitForText("Saved to the protected Keychain. Never synced.");
    await waitRoutes({ gh: true, git: true });
    expect(await textOf('[data-testid="add-secret-stand-in"]')).toBe("GH_TOKEN=termic_ph_…");
    expect(await routeText("gh")).toContain("Authorization: token real value");
    expect(await textOf('[data-testid="add-secret-acts-as"]')).toBe("On GitHub, calls show up as whoever owns the token.");
    const hosts = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="add-secret-hosts"] [data-host]')].map(e => e.getAttribute("data-host")));
    expect(hosts).toEqual(["api.github.com", "github.com", "uploads.github.com"]);

    await clickPresent('[data-testid="add-secret-submit"]');
    await waitFieldError("value", "Paste the token.");
    expect((await settingsLoad()).secrets.some((s: any) => s.name === "gh-token")).toBe(false);

    await setInputValue('[data-testid="add-secret-value"]', TOKEN);
    await snap("secrets-c3-add-github-paste.png");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets.some((x: any) => x.name === "gh-token"), "the pasted GitHub token never saved");
    const saved = (await settingsLoad()).secrets.find((s: any) => s.name === "gh-token");
    expect(saved).toMatchObject({
      recipe: "github", kind: "protected", service: `termic:${saved.id}`, account: "termic",
      hosts: ["api.github.com", "github.com", "uploads.github.com"],
    });
    expect(JSON.stringify(await settingsLoad())).not.toContain(TOKEN);
    expect((await probe(saved.id)).status).toBe("readable");
    expect(await storedCell("gh-token")).toBe("Termic · protected\npasted token");

    await clickPresent('[data-secret-row="gh-token"]');
    await waitForText("Only Termic can read it.");
    await waitForText("Replace token…");
    // five buttons in one row: Remove ran 23px past the panel
    // before the row wrapped (first screenshot pass).
    const past = await browser.execute(() => {
      const panel = document.querySelector('[data-testid="secret-expanded"]')!.getBoundingClientRect();
      return document.querySelector('[data-testid="secret-remove"]')!.getBoundingClientRect().right - panel.right;
    });
    expect(past).toBeLessThanOrEqual(0);
    await snap("secrets-c4-expanded-github-owned.png");
  });

  it("warns that a removed GitHub token stays valid on GitHub", async () => {
    await clickPresent('[data-testid="secret-remove"]');
    await browser.waitUntil(async () => (await dialogWith("Remove gh-token?")) !== null,
      { timeout: 10_000, timeoutMsg: "the remove confirm never opened" });
    const msg = await dialogWith("Remove gh-token?");
    expect(msg).toContain("Termic deletes the stored token. There's no other copy.");
    expect(msg).toContain("Running agents keep their stand-in until they restart.");
    expect(msg).toContain("The token stays valid on GitHub until you revoke it there.");
    await snap("secrets-c4-remove-github-owned.png");
    await clickInDialog("Remove gh-token?", "Remove");
    await waitSaved(s => !s.secrets.some((x: any) => x.name === "gh-token"), "the GitHub secret was not removed");
  });

  it("deletes the stored key when the secret is removed", async () => {
    const before = (await settingsLoad()).secrets.find((s: any) => s.name === "openai");
    // the row is still open from the delivery case; a click would close it.
    if (!await browser.execute(() => !!document.querySelector('[data-testid="secret-expanded"]'))) {
      await clickPresent('[data-secret-row="openai"]');
    }
    await waitVisible('[data-testid="secret-expanded"]');
    await clickPresent('[data-testid="secret-remove"]');
    await browser.waitUntil(() => browser.execute(() =>
      [...document.querySelectorAll('[role="dialog"]')].some(d => d.textContent?.includes("Termic deletes the stored key. There's no other copy."))),
    { timeout: 10_000, timeoutMsg: "the owned-secret remove confirm never opened" });
    // an API key has no GitHub to revoke it on
    expect(await dialogWith("Remove openai?")).not.toContain("stays valid on GitHub");
    await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find(x => x.textContent?.includes("Remove openai?"))!;
      ([...d.querySelectorAll("button")].find(b => b.textContent?.trim() === "Remove") as HTMLElement).click();
    });
    await waitSaved(s => !s.secrets.some((x: any) => x.name === "openai"), "the secret was not removed");
    // put the definition back by hand: its item is gone, so it reads missing.
    await browser.waitUntil(async () => {
      await browser.execute(async (def) => {
        const t = window.__termic!;
        const s = await t.invoke("settings_load") as any;
        if (!s.secrets.some((x: any) => x.id === def.id)) await t.invoke("settings_save", { s: { ...s, secrets: [...s.secrets, def] } });
      }, before);
      return (await probe(before.id)).status === "missing";
    }, { timeout: 10_000, timeoutMsg: "the removed secret's Keychain item was not deleted" });
  });

  it("adds an existing Keychain item as a GitHub secret", async () => {
    await openAdd();
    await clickPresent('[data-testid="add-secret-source-item"]');
    await waitVisible('[data-testid="add-secret-service"]');
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="add-secret-source-item"]')?.getAttribute("aria-pressed"))).toBe("true");
    // not Termic's to store, so no Saved to line and no value field
    expect(await browser.execute(() => !!document.querySelector('[data-testid="add-secret-saved-to"]'))).toBe(false);
    expect(await inputValue('[data-testid="add-secret-value"]')).toBeNull();
    await waitForText("macOS asks once: choose Always Allow.");
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitFieldError("item", "Keychain service and account are both required.");
    await waitFieldError("name", "Give it a name.");

    await setInputValue('[data-testid="add-secret-service"]', "acme-ci-token");
    await setInputValue('[data-testid="add-secret-keychain-account"]', "ci-bot");
    await setInputValue('[data-testid="add-secret-name"]', "acme-ci");
    await waitGone('[data-testid="add-secret-error-item"]');
    await waitGone('[data-testid="add-secret-error-name"]');
    // the default hosts turn both on; without api.github.com gh has no route
    await waitRoutes({ gh: true, git: true });
    await clickPresent('[data-testid="add-secret-hosts"] [data-host="api.github.com"] button');
    await waitRoutes({ gh: false, git: true });
    expect(await routeText("gh")).toContain("Add api.github.com to turn on.");
    await snap("secrets-b-add-keychain-item.png");

    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets.some((x: any) => x.name === "acme-ci"), "the Keychain item secret never saved");
    const saved = (await settingsLoad()).secrets.find((s: any) => s.name === "acme-ci");
    expect(saved).toMatchObject({
      recipe: "github", kind: "generic", service: "acme-ci-token", account: "ci-bot",
      hosts: ["github.com", "uploads.github.com"],
    });
  });

  it("warns when a role's key would replace Claude's own login", async () => {
    await openAdd();
    await setSelect('[data-testid="add-secret-preset"]', "anthropic");
    await waitVisible('[data-testid="add-secret-value"]');
    // the dialog says it before the role editor does
    expect(await textOf('[data-testid="add-secret-login-takeover"]')).toBe(
      "Claude tasks on a role with this key sign in with it instead of /login.");
    await setInputValue('[data-testid="add-secret-value"]', KEY);
    await clickPresent('[data-testid="add-secret-submit"]');
    await waitSaved(s => s.secrets.some((x: any) => x.name === "anthropic"), "the Anthropic key never saved");

    await clickPresent('[data-secrets-tab="roles"]');
    await clickPresent('[data-testid="roles-new"]');
    await clickPresent('[data-starter="empty"]');
    // a role with no secrets yet: the cases below tick them in the matrix.
    await browser.execute(() => {
      for (const b of document.querySelectorAll<HTMLElement>('[data-new-role-secret][aria-checked="true"]')) b.click();
    });
    await waitGone('[data-new-role-secret][aria-checked="true"]');
    await clickPresent('[data-testid="new-role-create"]');
    await waitSaved(s => s.roles?.length === 1, "the role never saved");
    const role = (await settingsLoad()).roles[0].name;
    await waitVisible('[data-testid="role-editor"]');
    const warnings = () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="role-login-takeover"]')].map(e => e.textContent?.trim()));

    // a key on another env var is not Claude's business
    await clickPresent(`[data-role-secret="${role}/acme-api"]`);
    await waitSaved(s => s.roles[0].secrets.length === 1, "acme-api never joined the role");
    expect(await warnings()).toEqual([]);

    await clickPresent(`[data-role-secret="${role}/anthropic"]`);
    await browser.waitUntil(async () => (await warnings()).length === 1, { timeout: 10_000, timeoutMsg: "no login warning" });
    expect((await warnings())[0]).toBe(
      "Claude reads ANTHROPIC_API_KEY for its own login. On a Claude task with this role, Claude signs in with anthropic instead of /login, and its own requests go through this role's rules.");
    // a checked box paints the accent fill. Assert the paint, not aria-checked:
    // transition-colors froze both boxes on their unchecked colours
    // (docs/gotchas.md "transition-colors freezes a themed border-color").
    // Waits out the 150ms transition; the frozen case never settles.
    const fills = () => browser.execute((r) => ["acme-api", "anthropic"].map(n => {
      const el = document.querySelector(`[data-role-secret="${r}/${n}"]`) as HTMLElement;
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--color-accent-deep)";
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(el).backgroundColor === want;
    }), role);
    await browser.waitUntil(async () => (await fills()).every(Boolean),
      { timeout: 3_000, timeoutMsg: `checked boxes never painted the accent fill: ${JSON.stringify(await fills())}` });
    await snap("secrets-b5-login-takeover.png");

    await clickPresent(`[data-role-secret="${role}/anthropic"]`);
    await browser.waitUntil(async () => (await warnings()).length === 0, { timeout: 10_000, timeoutMsg: "the warning outlived the secret" });
  });
});
