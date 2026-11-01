import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "@/locales/en";
import type { Role, SecretDef } from "@/lib/types";
import type { ApiKeyProblem } from "./model";
import { API_KEY_PRESETS, ENV_GUARD_BUILTIN, apiKeyProblems, deliveredAs, deliveries, duplicateRole, loginTakeovers, baseUrlHost, hostConflicts, isOwned, ownedService, putRuleSet, roleDefaultEffect, roleFromTemplate, ruleBlocksFor, ruleSetFor, secretProblem, secretProblems, storedIn, toggleSecret } from "./model";

const secret = (id: string, hosts = ["api.github.com", "github.com", "uploads.github.com"]): SecretDef => ({
  id, name: id, kind: "generic", service: "gh:github.com", account: "alice", recipe: "github", hosts,
});
const role = (p: Partial<Role> = {}): Role => ({ id: "r", name: "R", colour: "blue", description: "", secrets: [], rule_sets: [], ...p });

// resolves a `manage.tpl.*` key against the real en tree, and fails loudly on
// a key that does not exist: template keys are built, so usedKeys.test.ts
// cannot see them (docs/i18n.md, "a registry's copy").
const t = (key: string) => {
  const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en.secrets);
  if (typeof v !== "string") throw new Error(`missing secrets:${key}`);
  return v;
};

describe("secrets model", () => {
  it("checks API key drafts the way secrets.rs validate does", () => {
    const { hosts, api } = API_KEY_PRESETS.openai;
    const p = (a: Partial<typeof api>, h = hosts, v = "sk-1") => apiKeyProblems(v, h, { ...api, ...a });
    expect(p({})).toEqual({});
    expect(apiKeyProblems("sk-1", API_KEY_PRESETS.anthropic.hosts, API_KEY_PRESETS.anthropic.api)).toEqual({});
    expect(p({}, hosts, "  ")).toEqual({ value: "value" });
    expect(p({ env: "1X" })).toEqual({ env: "env" });
    expect(p({ env: "" })).toEqual({ env: "env" });
    expect(p({ env: "https_proxy" })).toEqual({ env: "envReserved" });
    expect(p({ env: "GH_KEY" })).toEqual({ env: "envReserved" });
    expect(p({ header: "x-key: y" })).toEqual({ header: "header" });
    expect(p({ header: "Proxy-Authorization" })).toEqual({ header: "headerReserved" });
    expect(p({ scheme: "Bearer token" })).toEqual({ scheme: "scheme" });
    expect(p({ scheme: "" })).toEqual({});
    expect(p({ base_url: "" })).toEqual({ baseUrl: "baseUrlPair" });
    expect(p({ base_url_env: "" })).toEqual({ baseUrl: "baseUrlPair" });
    expect(p({ base_url: "http://api.openai.com" })).toEqual({ baseUrl: "baseUrlShape" });
    expect(p({}, ["api.other.example"])).toEqual({ baseUrl: "baseUrlHost" });
    expect(p({ base_url_env: "openai_api_key" })).toEqual({ baseUrlEnv: "baseUrlEnvSame" });
    expect(p({ base_url_env: "NODE_OPTIONS" })).toEqual({ baseUrlEnv: "envReserved" });
    expect(p({ base_url_env: "", base_url: "" })).toEqual({});
    // every problem at once, one per field, not just the first
    expect(apiKeyProblems("", [], { header: "host", scheme: "a b", env: "PATH", base_url_env: "9", base_url: "https://x.example" }))
      .toEqual({ value: "value", env: "envReserved", header: "headerReserved", scheme: "scheme", baseUrlEnv: "env", baseUrl: "baseUrlHost" });
  });

  it("has a message for every Add dialog problem", () => {
    // the dialog builds `manage.add.problem.<key>`, which usedKeys.test.ts cannot see
    const keys = ["name", "nameTaken", "keychain", "hosts", "token", "value", "env", "envReserved", "header", "headerReserved",
      "scheme", "baseUrlEnvSame", "baseUrlPair", "baseUrlShape", "baseUrlHost"] satisfies (ApiKeyProblem | "name" | "nameTaken" | "keychain" | "hosts" | "token")[];
    for (const k of keys) t(`manage.add.problem.${k}`);
  });

  it("turns delivery routes on the way recipe.rs Route::active does", () => {
    const on = (s: Parameters<typeof deliveries>[0]) => Object.fromEntries(deliveries(s).map(d => [d.route, d.on]));
    // github: gh on api.github.com, git on github.com, each on its own host
    expect(on({ recipe: "github", hosts: ["api.github.com", "github.com"] })).toEqual({ gh: true, git: true });
    expect(on({ recipe: "github", hosts: ["API.github.com"] })).toEqual({ gh: true, git: false });
    expect(on({ recipe: "github", hosts: ["github.com", "uploads.github.com"] })).toEqual({ gh: false, git: true });
    // api key: base URL needs the env var AND its host bound; env proxy any host
    const { hosts, api } = API_KEY_PRESETS.openai;
    expect(on({ recipe: "api_key", hosts, api })).toEqual({ baseUrl: true, envProxy: true });
    expect(on({ recipe: "api_key", hosts, api: { ...api, base_url_env: "" } })).toEqual({ baseUrl: false, envProxy: true });
    expect(on({ recipe: "api_key", hosts, api: { ...api, base_url: "not a url" } })).toEqual({ baseUrl: false, envProxy: true });
    expect(on({ recipe: "api_key", hosts: ["api.other.example"], api })).toEqual({ baseUrl: false, envProxy: true });
    expect(on({ recipe: "api_key", hosts: [], api })).toEqual({ baseUrl: false, envProxy: false });
    // a recipe from a newer Termic delivers nothing (recipe.rs INERT)
    expect(deliveries({ recipe: "future" as never, hosts })).toEqual([]);
  });

  it("says where a secret is stored", () => {
    const owned = (recipe: SecretDef["recipe"], kind: SecretDef["kind"]): SecretDef =>
      ({ ...secret("o"), service: ownedService("o"), account: "termic", recipe, kind });
    expect(storedIn(owned("github", "protected"))).toEqual({ by: "termic", store: "protected", what: "token" });
    expect(storedIn(owned("api_key", "protected"))).toEqual({ by: "termic", store: "protected", what: "key" });
    // a build without the protected keychain wrote it to the login keychain
    expect(storedIn(owned("api_key", "generic"))).toEqual({ by: "termic", store: "login", what: "key" });
    expect(storedIn(secret("a"))).toEqual({ by: "gh", account: "alice" });
    expect(storedIn({ ...secret("a"), service: "git.acme.com", account: "bob" })).toEqual({ by: "item", service: "git.acme.com", account: "bob" });
    // termic's account on someone else's service is not ours
    expect(storedIn({ ...secret("a"), account: "termic" })).toEqual({ by: "gh", account: "termic" });
  });

  it("flags an API key that would take over an agent's own login", () => {
    const anthropic: SecretDef = { ...secret("ak", ["api.anthropic.com"]), name: "anthropic", recipe: "api_key", api: API_KEY_PRESETS.anthropic.api };
    const openai: SecretDef = { ...secret("ok", ["api.openai.com"]), name: "openai", recipe: "api_key", api: API_KEY_PRESETS.openai.api };
    expect(loginTakeovers(role({ secrets: ["ak", "ok", "a"] }), [anthropic, openai, secret("a")]))
      .toEqual([{ agent: "Claude", env: "ANTHROPIC_API_KEY", secret: "anthropic" }]);
    // a GitHub secret never matches, whatever its fields say
    expect(loginTakeovers(role({ secrets: ["a"] }), [secret("a")])).toEqual([]);
    expect(loginTakeovers(role({ secrets: ["ok"] }), [openai])).toEqual([]);
  });

  it("only a GitHub secret's github.com block is git", () => {
    const key: SecretDef = { ...secret("k", ["github.com"]), recipe: "api_key", api: API_KEY_PRESETS.custom.api };
    expect(ruleBlocksFor(role({ secrets: ["a", "k"] }), [secret("a"), key]).filter(b => b.kind === "git").map(b => b.secret.id)).toEqual(["a"]);
  });

  it("flags two secrets reaching one host (secrets.rs validate)", () => {
    const s = [secret("a"), secret("b", ["github.com"]), secret("c", ["api.openai.com"])];
    expect(hostConflicts(["a", "b"], s)).toEqual(["github.com"]);
    expect(hostConflicts(["a", "c"], s)).toEqual([]);
  });

  it("drops a rule set that means nothing, keeps one that denies", () => {
    const r = role({ secrets: ["a"] });
    expect(putRuleSet(r, { secret: "a", host: "github.com", rules: [], fallback: "allow" }).rule_sets).toEqual([]);
    expect(putRuleSet(r, { secret: "a", host: "github.com", rules: [], fallback: "deny" }).rule_sets).toHaveLength(1);
  });

  it("a role with any deny fallback denies hosts that have no set, and keeps an explicit allow", () => {
    const deny = { secret: "a", host: "api.github.com", rules: [], fallback: "deny" as const };
    const r = role({ secrets: ["a"], rule_sets: [deny] });
    expect(roleDefaultEffect(r)).toBe("deny");
    expect(roleDefaultEffect(role())).toBe("allow");
    // a host added later shows (and is judged by) the role default.
    expect(ruleSetFor(r, "a", "uploads.github.com").fallback).toBe("deny");
    // an empty allow set is a real override here, not a no-op to drop...
    const open = putRuleSet(r, { secret: "a", host: "uploads.github.com", rules: [], fallback: "allow" });
    expect(open.rule_sets).toHaveLength(2);
    // ...and an empty deny set says what the default already says.
    expect(putRuleSet(r, { secret: "a", host: "uploads.github.com", rules: [], fallback: "deny" }).rule_sets).toEqual([deny]);
    // emptying the only deny set back to allow drops it: the role is
    // allow-by-default again, so it would mean nothing.
    expect(putRuleSet(open, { ...deny, fallback: "allow" }).rule_sets.map(x => x.host)).toEqual(["uploads.github.com"]);
  });

  it("Maintainer denies only the calls that mint access outliving the task", () => {
    const m = roleFromTemplate("maintainer", "m", secret("a"), [], t);
    expect(m.secrets).toEqual(["a"]);
    expect(m.rule_sets).toHaveLength(1);
    const api = m.rule_sets[0];
    expect([api.host, api.fallback]).toEqual(["api.github.com", "allow"]);
    expect(roleDefaultEffect(m)).toBe("allow");
    expect(api.rules.every(x => x.effect === "deny" && x.methods.length >= 1 && x.pattern.length > 1)).toBe(true);
    const lines = api.rules.flatMap(x => x.methods.map(m => `${m} ${x.pattern}`));
    for (const l of ["POST /repos/*/*/keys", "PATCH /repos/*/*/hooks/**", "POST /orgs/*/actions/runners/**", "PUT /orgs/*/memberships/*", "POST /user/ssh_signing_keys"]) {
      expect(lines).toContain(l);
    }
    // an API key secret gets no GitHub rules and is not bound by a template.
    const key = { ...secret("k", ["api.openai.com"]), recipe: "api_key" as const };
    expect(roleFromTemplate("reviewer", "x", key, [], t)).toMatchObject({ secrets: ["k"], rule_sets: [] });
  });

  it("unticking a secret drops its rules", () => {
    const r = role({ secrets: ["a"], rule_sets: [{ secret: "a", host: "github.com", rules: [], fallback: "deny" }] });
    expect(toggleSecret(r, "a", false)).toMatchObject({ secrets: [], rule_sets: [] });
  });

  it("shows a rule block for every host, custom ones included", () => {
    const blocks = ruleBlocksFor(role({ secrets: ["a"] }), [secret("a", ["api.github.com", "github.com", "uploads.github.com", "objects.example.io"])]);
    expect(blocks.map(b => [b.host, b.kind])).toEqual([
      ["api.github.com", "http"], ["github.com", "git"], ["uploads.github.com", "http"], ["objects.example.io", "http"],
    ]);
  });

  it("Reviewer reads GraphQL, denies merge and push", () => {
    const r = roleFromTemplate("reviewer", "x", secret("a"), ["blue"], t);
    expect(r.colour).toBe("purple");
    const api = r.rule_sets.find(s => s.host === "api.github.com")!;
    expect(api.fallback).toBe("deny");
    // without QUERY, gh pr view (POST /graphql) is denied by the fallback.
    expect(api.rules.some(x => x.effect === "allow" && x.methods.includes("QUERY"))).toBe(true);
    expect(api.rules.some(x => x.effect === "deny" && x.methods.includes("MUTATION") && x.pattern === "mergePullRequest")).toBe(true);
    const git = r.rule_sets.find(s => s.host === "github.com")!;
    expect(git.rules.map(x => [x.effect, x.methods[0]])).toEqual([["allow", "fetch"], ["deny", "push"]]);
    // a set per host: a host with no set would allow everything.
    expect(r.rule_sets.map(s => s.host)).toEqual(["api.github.com", "github.com", "uploads.github.com"]);
    const up = r.rule_sets.find(s => s.host === "uploads.github.com")!;
    expect(up.fallback).toBe("deny");
    expect(up.rules.map(x => [x.effect, x.methods.join(",")])).toEqual([["allow", "GET,HEAD"]]);
    const custom = roleFromTemplate("reviewer", "z", secret("a", ["api.github.com", "objects.example.io"]), [], t);
    expect(custom.rule_sets.map(s => [s.host, s.fallback])).toEqual([["api.github.com", "deny"], ["objects.example.io", "deny"]]);
    // every template key resolves (t throws otherwise).
    for (const tpl of ["empty", "maintainer"] as const) roleFromTemplate(tpl, "y", secret("a"), [], t);
  });

  it("validates the Add secret form", () => {
    const ok = { name: "gh-alice", service: "gh:github.com", account: "alice", hosts: ["github.com"] };
    expect(secretProblem(ok, [])).toBeNull();
    expect(secretProblem({ ...ok, account: " " }, [])).toBe("keychain");
    expect(secretProblem({ ...ok, hosts: [] }, [])).toBe("hosts");
    expect(secretProblem(ok, [secret("gh-alice")])).toBe("nameTaken");
    // per field, every problem at once
    expect(secretProblems({ name: " ", service: "", account: "x", hosts: [] }, [])).toEqual({ name: "name", keychain: "keychain", hosts: "hosts" });
    expect(secretProblems(ok, [])).toEqual({});
  });

  it("delivers only through the routes the broker turns on (recipe.rs Route::active)", () => {
    expect(deliveredAs(secret("a"))).toEqual([{ via: "gh" }, { via: "git" }]);
    expect(deliveredAs(secret("a", ["GitHub.com"]))).toEqual([{ via: "git" }]);
    expect(deliveredAs(secret("a", ["api.github.com", "uploads.github.com"]))).toEqual([{ via: "gh" }]);
    const { hosts, api } = API_KEY_PRESETS.openai;
    const key: SecretDef = { ...secret("k", hosts), recipe: "api_key", api };
    expect(deliveredAs(key)).toEqual([{ via: "baseUrl", env: "OPENAI_BASE_URL" }, { via: "proxy" }]);
    // no base URL env, or a base URL on a host the secret does not reach: proxy only
    expect(deliveredAs({ ...key, api: { ...api, base_url_env: "" } })).toEqual([{ via: "proxy" }]);
    expect(deliveredAs({ ...key, hosts: ["api.acme.com"] })).toEqual([{ via: "proxy" }]);
  });

  it("lists the same built-in kept-out names as env_guard.rs", () => {
    const src = readFileSync("src-tauri/src/env_guard.rs", "utf8");
    const block = /pub const BUILTIN: &\[&str\] = &\[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
    expect([...block.matchAll(/"([A-Z0-9_]+)"/g)].map(m => m[1])).toEqual(ENV_GUARD_BUILTIN);
  });
});

describe("duplicateRole", () => {
  const name = (n: string, i: number) => i === 1 ? `${n} copy` : `${n} copy ${i}`;
  const base: Role = { id: "a", name: "Reviewer", colour: "blue", description: "d", secrets: ["s"],
    rule_sets: [{ secret: "s", host: "h", fallback: "deny", rules: [{ effect: "allow", methods: ["GET"], pattern: "/**", note: "" }] }] };

  it("copies secrets and rules under a new id, name and colour", () => {
    const c = duplicateRole(base, "b", [base], name);
    expect(c).toMatchObject({ id: "b", name: "Reviewer copy", secrets: ["s"], rule_sets: base.rule_sets });
    expect(c.colour).not.toBe("blue");
    // a deep copy: editing the copy's rules leaves the original alone
    c.rule_sets[0].rules[0].pattern = "/x";
    expect(base.rule_sets[0].rules[0].pattern).toBe("/**");
  });

  it("never reuses a name", () => {
    const taken = [base, { ...base, id: "b", name: "Reviewer copy" }];
    expect(duplicateRole(base, "c", taken, name).name).toBe("Reviewer copy 2");
  });
});
