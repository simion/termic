import { describe, expect, it } from "vitest";
import en from "@/locales/en";
import type { Role, Rule, RuleSet, SecretDef, SimpleCfg } from "@/lib/types";
import { duplicateRole, putRuleSet, ruleSetFor, toggleSecret } from "./model";
import { CAPS, GUARD, SIMPLE_V, STARTERS, applySimple, compile, compileVersion, kindOf, roleFromStarter, scopeRepos, simpleState, starterCfg, type CapId } from "./simpleRole";

const gh: SecretDef = {
  id: "gh", name: "gh-alice", kind: "generic", service: "gh:github.com", account: "alice", recipe: "github",
  hosts: ["api.github.com", "github.com", "uploads.github.com"],
};
const key: SecretDef = {
  id: "ant", name: "anthropic", kind: "protected", service: "termic:ant", account: "termic", recipe: "api_key",
  hosts: ["api.anthropic.com"], api: { header: "x-api-key", scheme: "", env: "ANTHROPIC_API_KEY", base_url_env: "", base_url: "" },
};
const cfg = (p: Partial<SimpleCfg> = {}): SimpleCfg => ({ v: SIMPLE_V, scope: "", fallback: "deny", guard: true, caps: [], other: {}, ...p });
const empty = (p: Partial<Role> = {}): Role => ({ id: "r", name: "R", colour: "blue", description: "", secrets: [], rule_sets: [], ...p });
const on = (sets: RuleSet[], host: string) => sets.find(s => s.host === host)!;
const lines = (set: RuleSet) => set.rules.map(r => `${r.effect} ${r.methods.join(",")} ${r.pattern}`);
// resolves a note key against the real en tree, and fails on a missing one:
// the keys are built, so usedKeys.test.ts cannot see them.
const note = (k: string) => {
  const v = k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], en.secrets);
  if (typeof v !== "string") throw new Error(`missing secrets:${k}`);
  return v;
};
/** rules.rs's walk for a plain HTTP request: first enabled match, else the
 *  fallback. `*` one segment, `**` any number (zero included). */
const glob = (p: string, s: string): boolean => {
  const seg = (a: string, b: string) => new RegExp(`^${a.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`, "i").test(b);
  const go = (ps: string[], ss: string[]): boolean => !ps.length ? !ss.length
    : ps[0] === "**" ? ss.some((_, i) => go(ps.slice(1), ss.slice(i))) || go(ps.slice(1), [])
    : !!ss.length && seg(ps[0], ss[0]) && go(ps.slice(1), ss.slice(1));
  return go(p.replace(/^\/+/, "").split("/"), s.replace(/^\/+/, "").split("/"));
};
/** `path` is the mutation name for MUTATION. ALLOW `*` never covers a
 *  pseudo-verb, DENY `*` does (rules.rs `rule_matches`). */
const judge = (set: RuleSet, method: string, path: string) => {
  const pseudo = ["QUERY", "MUTATION", "fetch", "push"].includes(method);
  return set.rules.find(r => !r.disabled && r.methods.some(m => m === method || (m === "*" && (r.effect === "deny" || !pseudo)))
    && glob(r.pattern, path))?.effect ?? set.fallback;
};
const popover = (pattern: string): Rule => ({ effect: "allow", methods: ["POST"], pattern, note: "" });
/** What secrets.rs allow_on_role does: the rule goes first in its set. */
const allowOnRole = (role: Role, host: string, rule: Rule): Role => ({
  ...role, rule_sets: role.rule_sets.map(s => s.secret === "gh" && s.host === host ? { ...s, rules: [rule, ...s.rules] } : s),
});

describe("simple roles: compile", () => {
  it("reads repo scope as acme/*, acme/widget, or every repo", () => {
    expect(scopeRepos("")).toBe("*/*");
    expect(scopeRepos("  acme ")).toBe("acme/*");
    expect(scopeRepos("acme/widget")).toBe("acme/widget");
    expect(scopeRepos("/acme/")).toBe("acme/*");
  });

  it("guardrail denies come first on the API, on every repo whatever the scope", () => {
    const api = on(compile(cfg({ scope: "acme", caps: ["read", "comment"] }), gh), "api.github.com");
    expect(api.rules.slice(0, GUARD.length).every(r => r.effect === "deny")).toBe(true);
    expect(lines(api)).toContain("deny POST /repos/*/*/keys");
    expect(lines(api)).toContain("allow POST /repos/acme/*/issues/*/comments");
    expect(api.rules.slice(GUARD.length).every(r => r.effect === "allow")).toBe(true);
    const off = on(compile(cfg({ guard: false, caps: ["read"] }), gh), "api.github.com");
    expect(lines(off)).toEqual(["allow GET,HEAD /**", "allow QUERY *"]);
    // the guardrail is API-only.
    expect(on(compile(cfg({ caps: ["push"] }), gh), "github.com").rules.every(r => r.effect === "allow")).toBe(true);
  });

  it("approving a deployment or a fork run is guarded, and Re-run CI never grants it", () => {
    const gates = ["/repos/acme/widget/actions/runs/7/pending_deployments", "/repos/acme/widget/actions/runs/7/approve"];
    // every capability ticked, anything not listed allowed: the guardrail
    // must still be what decides.
    const all = CAPS.map(c => c.id);
    for (const path of gates) {
      expect(judge(on(compile(cfg({ caps: all, fallback: "allow" }), gh), "api.github.com"), "POST", path)).toBe("deny");
      // guard off, fallback deny: nothing a checkbox wrote matches.
      expect(judge(on(compile(cfg({ guard: false, caps: all }), gh), "api.github.com"), "POST", path)).toBe("deny");
    }
    // the calls Re-run CI is for still pass, guard on.
    const ci = on(compile(cfg({ caps: ["actions"] }), gh), "api.github.com");
    for (const path of ["/repos/acme/widget/actions/runs/7/rerun", "/repos/acme/widget/actions/runs/7/rerun-failed-jobs",
      "/repos/acme/widget/actions/runs/7/cancel", "/repos/acme/widget/actions/jobs/9/rerun", "/repos/acme/widget/actions/workflows/ci.yml/dispatches"]) {
      expect(judge(ci, "POST", path)).toBe("allow");
    }
  });

  it("the GraphQL approval and environment-protection writes are guarded too", () => {
    const all = CAPS.map(c => c.id);
    const open = on(compile(cfg({ caps: all, fallback: "allow" }), gh), "api.github.com");
    for (const [method, target] of [
      ["MUTATION", "approveDeployments"], ["MUTATION", "updateEnvironment"], ["MUTATION", "deleteEnvironment"],
      ["PUT", "/repos/acme/widget/environments/production"], ["DELETE", "/repos/acme/widget/environments/production"],
      ["POST", "/repos/acme/widget/environments/production/deployment_protection_rules"],
      ["DELETE", "/repos/acme/widget/environments/production/deployment_protection_rules/3"],
      ["POST", "/repos/acme/widget/environments/production/deployment-branch-policies"],
      ["PUT", "/repos/acme/widget/environments/production/deployment-branch-policies/4"],
      // v2: branch protection, rulesets, review dismissal
      ["PUT", "/repos/acme/widget/branches/main/protection"],
      ["DELETE", "/repos/acme/widget/branches/main/protection/required_pull_request_reviews"],
      ["POST", "/repos/acme/widget/branches/main/protection/enforce_admins"],
      ["PUT", "/repos/acme/widget/rulesets/5"], ["DELETE", "/repos/acme/widget/rulesets/5"], ["POST", "/orgs/acme/rulesets"],
      ["PUT", "/repos/acme/widget/pulls/3/reviews/8/dismissals"],
      ["MUTATION", "updateBranchProtectionRule"], ["MUTATION", "deleteBranchProtectionRule"], ["MUTATION", "createBranchProtectionRule"],
      ["MUTATION", "updateRepositoryRuleset"], ["MUTATION", "deleteRepositoryRuleset"], ["MUTATION", "createRepositoryRuleset"],
      ["MUTATION", "dismissPullRequestReview"],
      // the id forms of the same routes
      ["PUT", "/repositories/123/branches/main/protection"], ["POST", "/repositories/123/hooks"],
      ["PUT", "/repositories/123/collaborators/bob"], ["POST", "/organizations/9/invitations"],
      ["PUT", "/teams/7/memberships/bob"], ["PUT", "/teams/7/repos/acme/widget"],
      // GraphQL grants
      ["MUTATION", "updateTeamsRepository"], ["MUTATION", "inviteEnterpriseAdmin"],
      ["MUTATION", "updateEnterpriseDefaultRepositoryPermissionSetting"], ["MUTATION", "addEnterpriseOrganizationMember"],
      ["MUTATION", "createIpAllowListEntry"], ["MUTATION", "updateIpAllowListEnabledSetting"],
      ["MUTATION", "updateOrganizationAllowPrivateRepositoryForkingSetting"],
    ]) {
      expect(judge(open, method, target), `${method} ${target}`).toBe("deny");
      // and with the guard off, nothing a checkbox wrote allows it.
      expect(judge(on(compile(cfg({ guard: false, caps: all }), gh), "api.github.com"), method, target), `${method} ${target}`).toBe("deny");
    }
    // reading an environment is still a read.
    expect(judge(open, "GET", "/repos/acme/widget/environments/production")).toBe("allow");
    expect(judge(open, "GET", "/repositories/123/pulls?page=2")).toBe("allow");
    // the name globs leave ordinary writes alone
    for (const m of ["addComment", "mergePullRequest", "createPullRequest", "updateIssue"]) expect(judge(open, "MUTATION", m), m).toBe("allow");
  });

  it("a cfg with no version compiles with the v1 tables, and a save stamps the current one", () => {
    expect(compileVersion(undefined)).toBe(compileVersion(1));
    expect(compileVersion(undefined).guard).not.toBe(GUARD);
    expect(compileVersion(SIMPLE_V).guard).toBe(GUARD);
    const c = cfg({ caps: ["read", "comment"], v: undefined });
    expect(compile(c, gh)).toEqual(compile({ ...c, v: 1 }, gh));
    const r = applySimple(empty({ secrets: ["gh"] }), gh, c);
    expect(r.simple!.gh.v).toBe(SIMPLE_V);
    // an unversioned cfg on a role saved with v1's rules reads them as
    // compiled, not extras, though v2's guard has more.
    const v1 = { ...r, rule_sets: compile(c, gh), simple: { gh: c } };
    expect(simpleState(v1, gh)).toMatchObject({ custom: false, extras: [] });
    expect(on(compile(c, gh), "api.github.com").rules.length).toBeLessThan(on(r.rule_sets, "api.github.com").rules.length);
  });

  it("each capability writes its own rules, scoped where a path names the repo", () => {
    const only = (id: CapId, host: string) => lines(on(compile(cfg({ guard: false, caps: [id], scope: "acme/widget" }), gh), host));
    expect(only("read", "github.com")).toEqual(["allow fetch acme/widget"]);
    expect(only("read", "uploads.github.com")).toEqual(["allow GET,HEAD /**"]);
    expect(only("push", "github.com")).toEqual(["allow push acme/widget"]);
    expect(only("push", "api.github.com")).toEqual([]);
    expect(only("comment", "api.github.com")).toContain("allow MUTATION addComment");
    expect(only("prs", "api.github.com")).toContain("allow POST /repos/acme/widget/pulls");
    expect(only("issues", "api.github.com")).toContain("allow MUTATION updateIssue");
    // exactly what gh run rerun / cancel and gh workflow run send.
    expect(only("actions", "api.github.com")).toEqual([
      "allow POST /repos/acme/widget/actions/runs/*/rerun",
      "allow POST /repos/acme/widget/actions/runs/*/rerun-failed-jobs",
      "allow POST /repos/acme/widget/actions/runs/*/cancel",
      "allow POST /repos/acme/widget/actions/jobs/*/rerun",
      "allow POST /repos/acme/widget/actions/workflows/*/dispatches",
    ]);
    expect(only("merge", "api.github.com")).toContain("allow MUTATION mergePullRequest");
    expect(only("release", "uploads.github.com")).toEqual(["allow POST /repos/acme/widget/releases/*/assets"]);
    // every rule the compile writes passes secrets.rs validate: a method, and
    // a pattern unless QUERY.
    for (const c of CAPS) {
      for (const set of compile(cfg({ caps: [c.id] }), gh)) {
        for (const r of set.rules) {
          expect(r.methods.length).toBeGreaterThan(0);
          expect(r.methods.every(m => m.length > 0)).toBe(true);
          expect(r.pattern.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every set takes the cfg's fallback; with no git cap, git is just the fallback", () => {
    const sets = compile(cfg({ fallback: "allow", caps: ["comment"] }), gh);
    expect(sets.map(s => [s.host, s.fallback])).toEqual([["api.github.com", "allow"], ["github.com", "allow"], ["uploads.github.com", "allow"]]);
    expect(on(compile(cfg(), gh), "github.com")).toEqual({ secret: "gh", host: "github.com", fallback: "deny", rules: [] });
  });

  it("levels: any request, reads only, or refused, for API keys and extra GitHub hosts", () => {
    expect(compile(cfg(), key)).toEqual([{ secret: "ant", host: "api.anthropic.com", fallback: "allow", rules: [] }]);
    const read = compile(cfg({ other: { "api.anthropic.com": "read" } }), key)[0];
    expect([read.fallback, ...lines(read)]).toEqual(["deny", "allow GET,HEAD /**"]);
    expect(compile(cfg({ other: { "api.anthropic.com": "deny" } }), key)[0]).toMatchObject({ fallback: "deny", rules: [] });
    // an extra host on a GitHub secret reads when the role reads, else refuses.
    const wide = { ...gh, hosts: [...gh.hosts, "objects.example.io"] };
    expect(kindOf(wide, "objects.example.io")).toBe("other");
    expect(on(compile(cfg({ caps: ["read"] }), wide), "objects.example.io").fallback).toBe("deny");
    expect(lines(on(compile(cfg({ caps: ["read"] }), wide), "objects.example.io"))).toEqual(["allow GET,HEAD /**"]);
    expect(on(compile(cfg(), wide), "objects.example.io")).toMatchObject({ fallback: "deny", rules: [] });
    expect(on(compile(cfg({ other: { "objects.example.io": "all" } }), wide), "objects.example.io").fallback).toBe("allow");
  });

  it("notes come from the locale and resolve", () => {
    for (const c of CAPS) for (const set of compile(cfg({ caps: [c.id], other: {} }), { ...gh, hosts: [...gh.hosts, "x.example.io"] }, note)) {
      for (const r of set.rules) expect(r.note.length).toBeGreaterThan(0);
    }
  });
});

describe("simple roles: extras and custom", () => {
  const reviewer = () => roleFromStarter("reviewer", { id: "r", name: "Reviewer", description: "", secrets: ["gh"] }, [gh], [], note);

  it("a fresh Simple save reads back as not custom, with no extras", () => {
    const r = reviewer();
    expect(r.simple).toEqual({ gh: starterCfg("reviewer", gh) });
    expect(simpleState(r, gh)).toMatchObject({ custom: false, extras: [] });
    // and again after a checkbox change.
    const r2 = applySimple(r, gh, { ...r.simple!.gh, caps: ["read", "comment", "push"] }, note);
    expect(simpleState(r2, gh)).toMatchObject({ custom: false, extras: [] });
    expect(lines(on(r2.rule_sets, "github.com"))).toEqual(["allow fetch */*", "allow push */*"]);
  });

  it("a prepended popover allow is an extra, survives a checkbox change, and lands below the guardrail", () => {
    const r = allowOnRole(reviewer(), "api.github.com", popover("/repos/acme/widget/issues/412/labels"));
    expect(on(r.rule_sets, "api.github.com").rules[0].pattern).toBe("/repos/acme/widget/issues/412/labels");
    const st = simpleState(r, gh);
    expect(st.custom).toBe(false);
    expect(st.extras).toEqual([{ host: "api.github.com", index: 0, rule: popover("/repos/acme/widget/issues/412/labels") }]);

    const saved = applySimple(r, gh, { ...r.simple!.gh, caps: ["read"] }, note);
    const api = on(saved.rule_sets, "api.github.com");
    // guardrail first, then the extra, then the capability rules.
    expect(api.rules.slice(0, GUARD.length).every(x => x.effect === "deny")).toBe(true);
    expect(api.rules[GUARD.length]).toEqual(popover("/repos/acme/widget/issues/412/labels"));
    expect(lines(api).slice(GUARD.length + 1)).toEqual(["allow GET,HEAD /**", "allow QUERY *"]);
    expect(simpleState(saved, gh)).toMatchObject({ custom: false, extras: [{ host: "api.github.com", index: GUARD.length }] });
  });

  it("a hand edit in Rules makes the secret custom", () => {
    const r = reviewer();
    const api = ruleSetFor(r, "gh", "api.github.com");
    // a compiled rule turned off, a fallback flipped, a reorder, a deny added.
    const variants: RuleSet[] = [
      { ...api, rules: api.rules.map((x, i) => i === 0 ? { ...x, disabled: true } : x) },
      { ...api, fallback: "allow" },
      { ...api, rules: [...api.rules.slice(1), api.rules[0]].reverse() },
      { ...api, rules: [...api.rules, { effect: "deny", methods: ["GET"], pattern: "/x", note: "" }] },
      { ...api, rules: api.rules.map((x, i) => i === GUARD.length ? { ...x, pattern: "/repos/acme/**" } : x) },
    ];
    for (const v of variants) expect(simpleState(putRuleSet(r, v), gh).custom).toBe(true);
    // a note edit is not a rule change.
    expect(simpleState(putRuleSet(r, { ...api, rules: api.rules.map(x => ({ ...x, note: "mine" })) }), gh).custom).toBe(false);
    // no cfg at all (an import, or a secret ticked in the matrix) is custom.
    expect(simpleState({ ...r, simple: undefined }, gh).custom).toBe(true);
  });

  it("Reset keeps the allow extras and drops the hand edits", () => {
    const r = allowOnRole(reviewer(), "api.github.com", popover("/repos/acme/widget/pulls/1/labels"));
    const api = ruleSetFor(r, "gh", "api.github.com");
    const hand = putRuleSet(r, { ...api, fallback: "allow", rules: [...api.rules, { effect: "deny", methods: ["GET"], pattern: "/x", note: "" }] });
    expect(simpleState(hand, gh).custom).toBe(true);
    const reset = applySimple(hand, gh, hand.simple!.gh, note);
    expect(simpleState(reset, gh)).toMatchObject({ custom: false, extras: [{ index: GUARD.length }] });
    expect(on(reset.rule_sets, "api.github.com").fallback).toBe("deny");
  });

  it("an empty set dropped by a Rules edit still reads as what it compiled to", () => {
    const r = roleFromStarter("model", { id: "m", name: "M", description: "", secrets: ["ant"] }, [key], [], note);
    expect(simpleState(r, key).custom).toBe(false);
    expect(simpleState({ ...r, rule_sets: [] }, key).custom).toBe(false);
  });
});

describe("simple roles: starters", () => {
  const make = (id: (typeof STARTERS)[number]["id"], secrets = ["gh", "ant"]) =>
    roleFromStarter(id, { id: "x", name: "X", description: "d", secrets }, [gh, key], ["blue"], note);

  it("Read only reads and refuses the rest; API keys stay open", () => {
    const r = make("readonly");
    expect(r.colour).toBe("purple");  // the next unused colour
    expect(lines(on(r.rule_sets, "github.com"))).toEqual(["allow fetch */*"]);
    expect(on(r.rule_sets, "github.com").fallback).toBe("deny");
    expect(on(r.rule_sets, "api.anthropic.com")).toMatchObject({ fallback: "allow", rules: [] });
  });

  it("Reviewer can comment but not push; Contributor can push, not merge", () => {
    const rev = make("reviewer");
    expect(lines(on(rev.rule_sets, "api.github.com"))).toContain("allow MUTATION addPullRequestReview");
    expect(lines(on(rev.rule_sets, "github.com"))).not.toContain("allow push */*");
    const c = make("contributor");
    expect(lines(on(c.rule_sets, "github.com"))).toContain("allow push */*");
    expect(lines(on(c.rule_sets, "api.github.com"))).not.toContain("allow MUTATION mergePullRequest");
  });

  it("Maintainer allows anything not listed, guardrail on", () => {
    const m = make("maintainer");
    expect(m.rule_sets.filter(s => s.secret === "gh").every(s => s.fallback === "allow")).toBe(true);
    expect(lines(on(m.rule_sets, "api.github.com"))).toContain("deny POST /user/ssh_signing_keys");
  });

  it("Model access opens API keys and refuses GitHub; Start empty refuses everything", () => {
    const m = make("model");
    expect(m.rule_sets.filter(s => s.secret === "gh").every(s => s.fallback === "deny" && s.rules.every(r => r.effect === "deny"))).toBe(true);
    expect(on(m.rule_sets, "api.anthropic.com").fallback).toBe("allow");
    const e = make("empty");
    expect(e.rule_sets.every(s => s.fallback === "deny" && s.rules.every(r => r.effect === "deny"))).toBe(true);
    // no secrets: just a name.
    expect(make("reviewer", [])).toMatchObject({ secrets: [], rule_sets: [], simple: {} });
  });
});

describe("simple roles: copy", () => {
  it("every built key the views render resolves (usedKeys.test.ts sees literals only)", () => {
    for (const c of CAPS) for (const k of ["label", "how"]) note(`manage.simple.cap.${c.id}.${k}`);
    for (const c of CAPS) note(`manage.starter.short.${c.id}`);
    for (const st of STARTERS) for (const k of ["title", "desc"]) note(`manage.starter.${st.id}.${k}`);
    for (const l of ["all", "read", "deny"]) { note(`manage.simple.level.${l}`); note(`manage.simple.keyPlain.${l}`); }
  });
});

describe("simple roles: role plumbing", () => {
  it("duplicating copies the checkbox state; unticking a secret drops it", () => {
    const r = roleFromStarter("reviewer", { id: "r", name: "R", description: "", secrets: ["gh"] }, [gh], [], note);
    const copy = duplicateRole(r, "r2", [r], n => `${n} copy`);
    expect(copy.simple).toEqual(r.simple);
    expect(copy.simple).not.toBe(r.simple);
    expect(toggleSecret(r, "gh", false).simple).toEqual({});
    expect(empty().simple).toBeUndefined();
  });
});
