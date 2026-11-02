// The role editor's checkbox ("Simple") view: what a SimpleCfg compiles to,
// which saved rules it did not produce (extras, from popover allows), and the
// New role starters. Pure. The broker only ever reads the compiled rule_sets;
// `Role.simple` rides along so the UI can re-open the checkboxes.

import type { Role, RoleColour, Rule, RuleEffect, RuleSet, SecretDef, SimpleCfg } from "@/lib/types";
import { API_HOST, GIT_HOST, ROLE_COLOURS, ruleSetFor } from "./model";

export const UPLOADS_HOST = "uploads.github.com";

/** What a (secret, host) is to the compile: the GitHub API, git, release
 *  uploads, another host on a GitHub secret, or a host of an API key. */
export type HostKind = "api" | "git" | "up" | "other" | "key";
export type HostLevel = SimpleCfg["other"][string];
export const HOST_LEVELS: HostLevel[] = ["all", "read", "deny"];

export function kindOf(s: Pick<SecretDef, "recipe">, host: string): HostKind {
  if (s.recipe !== "github") return "key";
  return host === API_HOST ? "api" : host === GIT_HOST ? "git" : host === UPLOADS_HOST ? "up" : "other";
}

/** The owner/repo glob a repo scope stands for: "" every repo, "acme" every
 *  repo in acme, "acme/widget" that one. */
export function scopeRepos(scope: string): string {
  const t = scope.trim().replace(/\s+/g, "").replace(/^\/+|\/+$/g, "");
  return !t ? "*/*" : t.includes("/") ? t : `${t}/*`;
}

/** Calls that hand out access outliving the task (deploy keys, collaborators,
 *  webhooks, runners, org invites and memberships, SSH / GPG keys), or get
 *  past a review gate: approving a deployment to a protected environment (REST
 *  or GraphQL) or a fork PR's workflow run, and rewriting an environment's
 *  protections (its required reviewers, protection rules, branch policies),
 *  a branch's protection or a ruleset, or dismissing a blocking review.
 *  Denied on EVERY repo, not just the scoped ones: with "Anything not listed:
 *  Allow" a scoped guard would leave every other repo open. `**` also matches
 *  zero segments, so `hooks/**` covers `hooks` itself. */
const GUARD_V1: [string, string][] = [
  ["POST", "/repos/*/*/keys"],
  ["PUT", "/repos/*/*/collaborators/*"],
  ["POST PUT PATCH", "/repos/*/*/hooks/**"],
  ["POST PUT PATCH", "/orgs/*/hooks/**"],
  ["POST", "/repos/*/*/actions/runners/**"],
  ["POST", "/orgs/*/actions/runners/**"],
  ["POST", "/enterprises/*/actions/runners/**"],
  ["POST", "/orgs/*/invitations"],
  ["PUT", "/orgs/*/memberships/*"],
  ["PUT", "/orgs/*/teams/*/memberships/*"],
  ["PUT", "/orgs/*/teams/*/repos/**"],
  ["POST", "/user/keys"],
  ["POST", "/user/gpg_keys"],
  ["POST", "/user/ssh_signing_keys"],
  ["POST", "/repos/*/*/actions/runs/*/pending_deployments"],
  ["POST", "/repos/*/*/actions/runs/*/approve"],
  ["MUTATION", "approveDeployments"],
  ["PUT DELETE", "/repos/*/*/environments/**"],
  ["POST", "/repos/*/*/environments/*/deployment_protection_rules"],
  ["POST", "/repos/*/*/environments/*/deployment-branch-policies"],
  ["MUTATION", "updateEnvironment"],
  ["MUTATION", "deleteEnvironment"],
];
export const GUARD: [string, string][] = [
  ...GUARD_V1,
  // v2. `branches/**` also takes branch rename, the one branch write that is
  // not protection; a role that needs it turns the guardrail off.
  ["POST PUT PATCH DELETE", "/repos/*/*/branches/**"],
  ["POST PUT DELETE", "/repos/*/*/rulesets/**"],
  ["POST PUT DELETE", "/orgs/*/rulesets/**"],
  ["PUT", "/repos/*/*/pulls/*/reviews/*/dismissals"],
  ["MUTATION", "createBranchProtectionRule"],
  ["MUTATION", "updateBranchProtectionRule"],
  ["MUTATION", "deleteBranchProtectionRule"],
  ["MUTATION", "createRepositoryRuleset"],
  ["MUTATION", "updateRepositoryRuleset"],
  ["MUTATION", "deleteRepositoryRuleset"],
  ["MUTATION", "dismissPullRequestReview"],
  // GitHub also routes /repositories/{id}/... and /organizations/{id}/... to
  // the same endpoints, which every /repos/*/* and /orgs/* deny above would
  // miss. gh writes through the name forms only, so the id forms get no
  // writes at all; reads (Link headers use them) still pass.
  ["POST PUT PATCH DELETE", "/repositories/**"],
  ["POST PUT PATCH DELETE", "/organizations/**"],
];

/** [methods, pattern] allowed by a capability; `{R}` is the repo scope. */
type Spec = [string, string];
export type CapId = "read" | "comment" | "prs" | "push" | "issues" | "actions" | "merge" | "release";
/** One checkbox: the rules it adds per host kind. gh writes through GraphQL
 *  as often as REST, so a write lists both. A mutation carries no repo, so
 *  the scope cannot limit it (the editor warns). */
export const CAPS: { id: CapId; risk?: true; api?: Spec[]; git?: Spec[]; up?: Spec[] }[] = [
  { id: "read", api: [["GET HEAD", "/**"], ["QUERY", "*"]], git: [["fetch", "{R}"]], up: [["GET HEAD", "/**"]] },
  { id: "comment", api: [
    ["POST", "/repos/{R}/issues/*/comments"], ["POST", "/repos/{R}/pulls/*/reviews/**"], ["POST", "/repos/{R}/pulls/*/comments/**"],
    ["MUTATION", "addComment"], ["MUTATION", "addPullRequestReview"], ["MUTATION", "submitPullRequestReview"], ["MUTATION", "addPullRequestReviewThread"],
  ] },
  { id: "prs", api: [
    ["POST", "/repos/{R}/pulls"], ["PATCH", "/repos/{R}/pulls/*"], ["POST", "/repos/{R}/pulls/*/requested_reviewers"],
    ["MUTATION", "createPullRequest"], ["MUTATION", "updatePullRequest"], ["MUTATION", "requestReviews"],
  ] },
  { id: "push", git: [["push", "{R}"]] },
  { id: "issues", api: [
    ["POST", "/repos/{R}/issues"], ["PATCH", "/repos/{R}/issues/*"], ["POST PUT DELETE", "/repos/{R}/issues/*/labels/**"],
    ["MUTATION", "createIssue"], ["MUTATION", "updateIssue"], ["MUTATION", "addLabelsToLabelable"], ["MUTATION", "removeLabelsFromLabelable"],
  ] },
  // the exact calls gh run rerun (--failed, --job), gh run cancel and gh
  // workflow run send. A wider glob is a grant: `actions/**` covers repo
  // variables and runner tokens, `runs/**` approving deployments and fork runs.
  { id: "actions", api: [
    ["POST", "/repos/{R}/actions/runs/*/rerun"], ["POST", "/repos/{R}/actions/runs/*/rerun-failed-jobs"],
    ["POST", "/repos/{R}/actions/runs/*/cancel"], ["POST", "/repos/{R}/actions/jobs/*/rerun"],
    ["POST", "/repos/{R}/actions/workflows/*/dispatches"],
  ] },
  { id: "merge", risk: true, api: [
    ["PUT", "/repos/{R}/pulls/*/merge"], ["DELETE", "/repos/{R}/git/refs/heads/**"],
    ["MUTATION", "mergePullRequest"], ["MUTATION", "enablePullRequestAutoMerge"],
  ] },
  { id: "release", risk: true, api: [["POST", "/repos/{R}/releases"], ["PATCH", "/repos/{R}/releases/*"]], up: [["POST", "/repos/{R}/releases/*/assets"]] },
];

/** The compile tables a saved cfg was written against, by `SimpleCfg.v`. A cfg
 *  with no `v` predates the field and is v1. */
// When GUARD or CAPS change, keep the old tables under their version, add
// the new ones as the next and bump SIMPLE_V. v2 added branch protection,
// rulesets and review dismissal to the guard. Extras are
// judged against the compile of the cfg's OWN version, so rules an older
// release compiled read as compiled (not popover extras) and are dropped on
// the next recompile instead of kept as allows.
const TABLES: Record<number, { guard: typeof GUARD; caps: typeof CAPS }> = {
  1: { guard: GUARD_V1, caps: CAPS },
  2: { guard: GUARD, caps: CAPS },
};
export const SIMPLE_V = 2;
/** A version this build does not know (written by a newer one) compiles as
 *  the current tables; its rules likely read as custom, which is the safe side. */
export const compileVersion = (v: number | undefined) => TABLES[v ?? 1] ?? TABLES[SIMPLE_V];

/** A notes source: `manage.simple.*` keys, resolved once at save. Notes are
 *  stored data (docs/i18n.md), and never part of the match below. */
export type Note = (key: string) => string;

const mk = (effect: RuleEffect, methods: string, pattern: string, note: string): Rule => ({ effect, methods: methods.split(" "), pattern, note });

/** A host's level when the cfg has none: an API key sends anything, a GitHub
 *  secret's extra host reads when the role reads. */
export function levelOf(s: Pick<SecretDef, "recipe">, host: string, cfg: SimpleCfg): HostLevel {
  return cfg.other[host] ?? (kindOf(s, host) === "key" ? "all" : cfg.caps.includes("read") ? "read" : "deny");
}

/** The rule sets `cfg` stands for, one per host of `s`, in host order. Every
 *  rule has a method and a pattern, so secrets.rs `validate` accepts it. */
export function compile(cfg: SimpleCfg, s: SecretDef, note: Note = () => ""): RuleSet[] {
  const R = scopeRepos(cfg.scope);
  const { guard, caps } = compileVersion(cfg.v);
  return s.hosts.map(host => {
    const k = kindOf(s, host);
    if (k === "key" || k === "other") {
      const lv = levelOf(s, host, cfg);
      return { secret: s.id, host, fallback: lv === "all" ? "allow" : "deny",
        rules: lv === "read" ? [mk("allow", "GET HEAD", "/**", note("manage.simple.level.read"))] : [] };
    }
    const rules: Rule[] = [];
    if (k === "api" && cfg.guard) rules.push(...guard.map(([m, p]) => mk("deny", m, p, note("manage.simple.guardNote"))));
    for (const c of caps) {
      if (!cfg.caps.includes(c.id)) continue;
      for (const [m, p] of c[k] ?? []) rules.push(mk("allow", m, p.replaceAll("{R}", R), note(`manage.simple.cap.${c.id}.label`)));
    }
    return { secret: s.id, host, fallback: cfg.fallback, rules };
  });
}

const ruleKey = (r: Rule) => `${r.effect}|${r.methods.map(m => m.toUpperCase()).sort().join(",")}|${r.pattern.trim()}`;

/** Split a saved set against what the compile gives it: `extras` are the
 *  indices of saved rules the compile did not produce; `custom` when the
 *  compiled rules are not all there, in order and on, once extras are set
 *  aside, or the fallback differs. An extra DENY is custom too: popovers only
 *  ever add allows, so a deny the checkboxes did not write is a hand edit. */
export function splitSet(saved: RuleSet, compiled: RuleSet): { extras: number[]; custom: boolean } {
  const left = new Map<string, number>();
  for (const r of compiled.rules) left.set(ruleKey(r), (left.get(ruleKey(r)) ?? 0) + 1);
  const extras: number[] = [], mine: Rule[] = [];
  saved.rules.forEach((r, i) => {
    const n = left.get(ruleKey(r)) ?? 0;
    if (n > 0) { left.set(ruleKey(r), n - 1); mine.push(r); } else extras.push(i);
  });
  const custom = saved.fallback !== compiled.fallback
    || mine.length !== compiled.rules.length
    || mine.some((r, i) => !!r.disabled || ruleKey(r) !== ruleKey(compiled.rules[i]))
    || extras.some(i => saved.rules[i].effect === "deny");
  return { extras, custom };
}

export interface Extra { host: string; index: number; rule: Rule }

/** Whether `s` on `role` is still what its checkboxes say, and the saved
 *  rules on top of them. No cfg (imported, or added in the matrix) is custom. */
export function simpleState(role: Role, s: SecretDef): { cfg: SimpleCfg | undefined; custom: boolean; extras: Extra[] } {
  const cfg = role.simple?.[s.id];
  if (!cfg) return { cfg, custom: true, extras: [] };
  let custom = false;
  const extras: Extra[] = [];
  for (const c of compile(cfg, s)) {
    const saved = ruleSetFor(role, s.id, c.host);
    const sp = splitSet(saved, c);
    custom ||= sp.custom;
    extras.push(...sp.extras.map(index => ({ host: c.host, index, rule: saved.rules[index] })));
  }
  return { cfg, custom, extras };
}

/** Write `cfg` for `s`, at the current SIMPLE_V: its compiled sets replace the saved ones, with the
 *  saved allow extras kept, placed after the guardrail denies (so an extra
 *  can never undo the guardrail) and before the capability rules. Extras are
 *  judged against the cfg being replaced (else an unticked box's rules would
 *  read as extras and stay), or against `cfg` when there is none. Sets are
 *  stored even when empty: dropping one would hand it the role default, which
 *  the next set written can change. */
export function applySimple(role: Role, s: SecretDef, next: SimpleCfg, note: Note = () => ""): Role {
  const cfg = { ...next, v: SIMPLE_V };
  const prev = role.simple?.[s.id];
  const before = prev ? compile(prev, s) : [];
  const sets = compile(cfg, s, note).map(c => {
    const saved = ruleSetFor(role, s.id, c.host);
    const was = before.find(b => b.host === c.host) ?? c;
    // ponytail: an extra the new compile writes itself is dropped, not
    // doubled, so unticking that box later takes it too. Keep extras in the
    // cfg if that ever bites.
    const have = new Set(c.rules.map(ruleKey));
    const keep = splitSet(saved, was).extras.map(i => saved.rules[i]).filter(r => r.effect === "allow" && !have.has(ruleKey(r)));
    const g = c.rules.findIndex(r => r.effect !== "deny");
    const at = g < 0 ? c.rules.length : g;
    return { ...c, rules: [...c.rules.slice(0, at), ...keep, ...c.rules.slice(at)] };
  });
  return {
    ...role,
    simple: { ...role.simple, [s.id]: cfg },
    rule_sets: [...role.rule_sets.filter(r => r.secret !== s.id), ...sets],
  };
}

export type StarterId = "readonly" | "reviewer" | "contributor" | "maintainer" | "model" | "empty";
/** New role's cards. `keyOnly`: GitHub secrets start refused, API keys open.
 *  `empty`: everything refused. */
export const STARTERS: { id: StarterId; colour: RoleColour; caps: CapId[]; fallback?: RuleEffect; keyOnly?: true; empty?: true }[] = [
  { id: "readonly", colour: "blue", caps: ["read"] },
  { id: "reviewer", colour: "purple", caps: ["read", "comment"] },
  { id: "contributor", colour: "teal", caps: ["read", "comment", "prs", "push", "issues", "actions"] },
  { id: "maintainer", colour: "amber", caps: CAPS.map(c => c.id), fallback: "allow" },
  { id: "model", colour: "pink", caps: [], keyOnly: true },
  { id: "empty", colour: "blue", caps: [], empty: true },
];

export function starterCfg(id: StarterId, s: Pick<SecretDef, "recipe" | "hosts">): SimpleCfg {
  const st = STARTERS.find(x => x.id === id)!;
  if (s.recipe === "github") return { v: SIMPLE_V, scope: "", fallback: st.fallback ?? "deny", guard: true, caps: st.keyOnly ? [] : [...st.caps], other: {} };
  return { v: SIMPLE_V, scope: "", fallback: "deny", guard: true, caps: [], other: Object.fromEntries(s.hosts.map(h => [h, st.empty ? "deny" : "all"])) };
}

/** A role from a starter, every secret on checkboxes. */
export function roleFromStarter(id: StarterId, init: { id: string; name: string; description: string; secrets: string[] },
  secrets: SecretDef[], usedColours: string[], note: Note): Role {
  const st = STARTERS.find(x => x.id === id)!;
  const colour = ROLE_COLOURS.find(c => !usedColours.includes(c)) ?? st.colour;
  let role: Role = { ...init, colour, rule_sets: [], simple: {} };
  for (const sid of init.secrets) {
    const s = secrets.find(x => x.id === sid);
    if (s) role = applySimple(role, s, starterCfg(id, s), note);
  }
  return role;
}
