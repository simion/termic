// Pure helpers behind Settings -> Secrets. No React, no IPC: the screens and
// the task-side surfaces can share these, and model.test.ts pins them.

import type { Agent, ApiKeyCfg, Project, Role, RoleColour, Rule, RuleEffect, RuleSet, SecretDef, Task } from "@/lib/types";
import { resolveRole } from "@/lib/types";

export const ROLE_COLOURS: RoleColour[] = ["blue", "purple", "teal", "amber", "pink"];

/** CSS colour for a role's swatch. Unknown names fall back to blue rather
 *  than painting nothing: the colour is identity, not meaning. */
export function roleColourVar(c: string | undefined): string {
  return ROLE_VARS[c as RoleColour] ?? ROLE_VARS.blue;
}
// spelled out in full, never built from the name: Tailwind v4 only emits an
// @theme variable whose literal name it finds in the source, and a template
// string left every swatch unpainted (the vars were not in the built CSS).
const ROLE_VARS: Record<RoleColour, string> = {
  blue: "var(--color-role-blue)",
  purple: "var(--color-role-purple)",
  teal: "var(--color-role-teal)",
  amber: "var(--color-role-amber)",
  pink: "var(--color-role-pink)",
};

/** The hosts the GitHub recipe defaults to (secrets.rs Recipe::default_hosts). */
export const GITHUB_HOSTS = ["api.github.com", "github.com", "uploads.github.com"];
/** The REST/GraphQL API (gh) and git smart HTTP hosts. */
export const API_HOST = "api.github.com";
export const GIT_HOST = "github.com";

/** "gh, git" - what a secret is delivered as, derived from its recipe. */
export function deliveredAs(s: SecretDef): string[] {
  switch (s.recipe) {
    case "github": return ["gh", "git"];
    case "api_key": return [s.api?.env ? `$${s.api.env}` : "env"];
    default: return [s.recipe];
  }
}

/** Keychain service + account of an item Termic writes itself (secrets.rs
 *  `owned_service`, `OWNED_ACCOUNT`). */
export const ownedService = (id: string) => `termic:${id}`;
export const OWNED_ACCOUNT = "termic";
export const isOwned = (s: Pick<SecretDef, "id" | "service" | "account">) =>
  s.service === ownedService(s.id) && s.account === OWNED_ACCOUNT;

/** Where a secret's value lives, for the "Stored in" column and the
 *  expanded row. `what` picks token vs key copy. */
export type StoredIn =
  | { by: "termic"; store: "protected" | "login"; what: "token" | "key" }
  | { by: "gh"; account: string }
  | { by: "item"; service: string; account: string };
export function storedIn(s: Pick<SecretDef, "id" | "service" | "account" | "kind" | "recipe">): StoredIn {
  if (isOwned(s)) return { by: "termic", store: s.kind === "protected" ? "protected" : "login", what: s.recipe === "github" ? "token" : "key" };
  if (s.service.startsWith("gh:")) return { by: "gh", account: s.account };
  return { by: "item", service: s.service, account: s.account };
}

/** The Add dialog's kinds. API key presets are data: same recipe, different
 *  defaults, all editable. */
export type SecretPreset = "github" | "openai" | "anthropic" | "custom";
export const API_KEY_PRESETS: Record<Exclude<SecretPreset, "github">, { name: string; hosts: string[]; api: ApiKeyCfg }> = {
  openai: {
    name: "openai", hosts: ["api.openai.com"],
    api: { header: "authorization", scheme: "Bearer", env: "OPENAI_API_KEY", base_url_env: "OPENAI_BASE_URL", base_url: "https://api.openai.com/v1" },
  },
  anthropic: {
    name: "anthropic", hosts: ["api.anthropic.com"],
    api: { header: "x-api-key", scheme: "", env: "ANTHROPIC_API_KEY", base_url_env: "ANTHROPIC_BASE_URL", base_url: "https://api.anthropic.com" },
  },
  custom: {
    name: "", hosts: [],
    api: { header: "authorization", scheme: "Bearer", env: "", base_url_env: "", base_url: "" },
  },
};

/** Env vars an agent CLI reads for its OWN login. A role secret that sets
 *  one takes over that agent's login on any task running with the role:
 *  the agent signs in with the brokered key instead of /login, and its own
 *  model requests go through the role's rules. Allowed, but the role editor
 *  says so. Claude Code documents ANTHROPIC_API_KEY ahead of /login. */
// ponytail: Claude only. Add Codex (OPENAI_API_KEY) or Gemini once their
// precedence over a stored login is checked, not assumed.
export const AGENT_LOGIN_ENV: { agent: string; env: string }[] = [
  { agent: "Claude", env: "ANTHROPIC_API_KEY" },
];

/** The agent logins a role's API key secrets would take over. */
export function loginTakeovers(role: Role, secrets: SecretDef[]): { agent: string; env: string; secret: string }[] {
  const out: { agent: string; env: string; secret: string }[] = [];
  for (const id of role.secrets) {
    const s = secrets.find(x => x.id === id);
    if (s?.recipe !== "api_key" || !s.api) continue;
    for (const a of AGENT_LOGIN_ENV) {
      if (s.api.env.toUpperCase() === a.env) out.push({ ...a, secret: s.name });
    }
  }
  return out;
}

/** The host of an `https://host[/path]` base URL. Mirrors secrets.rs
 *  `base_url_host`. */
export function baseUrlHost(url: string): string | null {
  const m = /^https:\/\/([A-Za-z0-9.-]+)(\/|$)/.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/** First problem with an API key draft, or null. The Rust side re-checks
 *  everything on save; this is for an inline message before the round trip. */
export function apiKeyProblem(value: string, hosts: string[], a: ApiKeyCfg): "value" | "env" | "header" | "baseUrl" | null {
  if (!value.trim()) return "value";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.env)) return "env";
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(a.header)) return "header";
  const hasEnv = a.base_url_env.trim() !== "", hasUrl = a.base_url.trim() !== "";
  if (hasEnv !== hasUrl) return "baseUrl";
  if (hasUrl) {
    const h = baseUrlHost(a.base_url);
    if (!h || !hosts.some(x => x.toLowerCase() === h)) return "baseUrl";
  }
  return null;
}

/** The (secret, host) rule blocks the editor shows for a role, one per host
 *  of each of its secrets. Every host gets one: a (secret, host) with no rule
 *  set allows everything, so a host without a block would be an unrestricted
 *  policy nobody can see. github.com carries git; every other host is HTTP. */
export function ruleBlocksFor(role: Role, secrets: SecretDef[]): { secret: SecretDef; host: string; kind: "http" | "git" }[] {
  const out: { secret: SecretDef; host: string; kind: "http" | "git" }[] = [];
  for (const id of role.secrets) {
    const s = secrets.find(x => x.id === id);
    if (!s) continue;
    for (const host of s.hosts) out.push({ secret: s, host, kind: s.recipe === "github" && host === GIT_HOST ? "git" : "http" });
  }
  return out;
}

/** Hosts reached by two of a role's secrets. Mirrors secrets.rs `validate`:
 *  the broker could not tell which value to send. */
export function hostConflicts(secretIds: string[], secrets: SecretDef[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of secretIds) {
    for (const h of secrets.find(s => s.id === id)?.hosts ?? []) {
      if (seen.has(h)) dup.add(h);
      seen.add(h);
    }
  }
  return [...dup];
}

/** What a (secret, host) with no rule set gets. A role is deny-by-default
 *  once any of its sets falls back to deny, so a host added later (or one
 *  whose set was dropped) is not silently wide open. Mirrors rules.rs. */
export function roleDefaultEffect(role: Pick<Role, "rule_sets">): RuleEffect {
  return role.rule_sets.some(s => s.fallback === "deny") ? "deny" : "allow";
}

/** Write one rule set into a role. A set with no rules whose fallback is
 *  what the rest of the role would give it anyway means the same as no set,
 *  so it is dropped rather than stored. */
export function putRuleSet(role: Role, set: RuleSet): Role {
  const rest = role.rule_sets.filter(r => !(r.secret === set.secret && r.host === set.host));
  const empty = set.rules.length === 0 && set.fallback === roleDefaultEffect({ rule_sets: rest });
  return { ...role, rule_sets: empty ? rest : [...rest, set] };
}

export function ruleSetFor(role: Role, secret: string, host: string): RuleSet {
  return role.rule_sets.find(r => r.secret === secret && r.host === host)
    ?? { secret, host, rules: [], fallback: roleDefaultEffect(role) };
}

/** Toggle a secret on a role. Dropping it also drops its rule sets, so a
 *  re-added secret starts clean instead of with rules nobody can see. */
export function toggleSecret(role: Role, secretId: string, on: boolean): Role {
  if (on) return role.secrets.includes(secretId) ? role : { ...role, secrets: [...role.secrets, secretId] };
  return {
    ...role,
    secrets: role.secrets.filter(s => s !== secretId),
    rule_sets: role.rule_sets.filter(r => r.secret !== secretId),
  };
}

const r = (effect: RuleEffect, methods: string[], pattern: string, note: string): Rule => ({ effect, methods, pattern, note });

/** Starting points for New role. Rules are per (secret, host), so a template
 *  needs a secret to hang them on; without one it is just a name. */
export type RoleTemplate = "empty" | "reviewer" | "maintainer";

/** A copy of `role` under a new id: same secrets, rules and description,
 *  the next unused colour, and a name no other role has. */
export function duplicateRole(role: Role, id: string, roles: Role[], copyName: (name: string, n: number) => string): Role {
  const taken = new Set(roles.map(r => r.name));
  let n = 1;
  let name = copyName(role.name, n);
  while (taken.has(name)) name = copyName(role.name, ++n);
  const used = roles.map(r => r.colour);
  const colour = ROLE_COLOURS.find(c => !used.includes(c)) ?? role.colour;
  return { ...structuredClone(role), id, name, colour };
}

/** `t` resolves `manage.tpl.*` keys: names and rule notes are DATA, minted in
 *  the user's language at creation and never re-resolved (docs/i18n.md). */
export function roleFromTemplate(tpl: RoleTemplate, id: string, secret: SecretDef | undefined, usedColours: string[], t: (key: string) => string): Role {
  const colour = ROLE_COLOURS.find(c => !usedColours.includes(c)) ?? ROLE_COLOURS[usedColours.length % ROLE_COLOURS.length];
  const base: Role = {
    id, name: t(`manage.tpl.${tpl}.name`), colour, description: t(`manage.tpl.${tpl}.desc`),
    secrets: secret && tpl !== "empty" ? [secret.id] : [], rule_sets: [],
  };
  if (!secret || secret.recipe !== "github") return base;
  if (tpl === "maintainer") {
    // everything a maintainer does, minus the common REST calls that mint
    // access which outlives the task: keys, collaborators, org members,
    // webhooks (and their config), runners. Those would let an agent keep its
    // reach after the placeholder is gone. A denylist is never complete (the
    // description says so); a role that must be airtight starts from Reviewer.
    // `**` also matches zero segments, so `hooks/**` covers `hooks` itself.
    const mint = t("manage.tpl.note.mintsAccess");
    const w = ["POST", "PUT", "PATCH"];
    base.rule_sets = [{
      secret: secret.id, host: API_HOST, fallback: "allow", rules: [
        r("deny", ["POST"], "/repos/*/*/keys", mint),
        r("deny", ["PUT"], "/repos/*/*/collaborators/*", mint),
        r("deny", w, "/repos/*/*/hooks/**", mint),
        r("deny", w, "/orgs/*/hooks/**", mint),
        r("deny", ["POST"], "/repos/*/*/actions/runners/**", mint),
        r("deny", ["POST"], "/orgs/*/actions/runners/**", mint),
        r("deny", ["POST"], "/enterprises/*/actions/runners/**", mint),
        r("deny", ["POST"], "/orgs/*/invitations", mint),
        r("deny", ["PUT"], "/orgs/*/memberships/*", mint),
        r("deny", ["PUT"], "/orgs/*/teams/*/memberships/*", mint),
        r("deny", ["PUT"], "/orgs/*/teams/*/repos/**", mint),
        r("deny", ["POST"], "/user/keys", mint),
        r("deny", ["POST"], "/user/gpg_keys", mint),
        r("deny", ["POST"], "/user/ssh_signing_keys", mint),
      ],
    }];
    return base;
  }
  if (tpl !== "reviewer") return base;
  // gh reads through POST /graphql (gh pr view, gh pr list), so QUERY must be
  // allowed or a "read only" role cannot read. Writes are named mutations:
  // allow the two a reviewer needs, deny the rest by the fallback.
  const api: RuleSet = {
    secret: secret.id, host: API_HOST, fallback: "deny", rules: [
      r("allow", ["GET", "HEAD"], "/**", t("manage.tpl.note.readAll")),
      r("allow", ["QUERY"], "*", t("manage.tpl.note.graphqlRead")),
      r("allow", ["MUTATION"], "addPullRequestReview", t("manage.tpl.note.review")),
      r("allow", ["MUTATION"], "addComment", t("manage.tpl.note.comment")),
      r("allow", ["POST"], "/repos/*/*/pulls/*/reviews", t("manage.tpl.note.restReview")),
      r("allow", ["POST"], "/repos/*/*/issues/*/comments", t("manage.tpl.note.restComment")),
      r("deny", ["MUTATION"], "mergePullRequest", t("manage.tpl.note.merge")),
    ],
  };
  const git: RuleSet = {
    secret: secret.id, host: GIT_HOST, fallback: "deny", rules: [
      r("allow", ["fetch"], "*", t("manage.tpl.note.fetch")),
      r("deny", ["push"], "*", t("manage.tpl.note.push")),
    ],
  };
  // every other host (uploads.github.com by default, or anything the user
  // added) gets a set too: no set means allow everything, which would leave
  // release-asset uploads open on a "read only" role.
  const other = (host: string): RuleSet => ({
    secret: secret.id, host, fallback: "deny", rules: [
      r("allow", ["GET", "HEAD"], "/**", t("manage.tpl.note.downloadOnly")),
    ],
  });
  base.rule_sets = secret.hosts.map(h => h === API_HOST ? api : h === GIT_HOST ? git : other(h));
  return base;
}

/** Live (non-archived) tasks per role id. Tasks with no role land under "".
 *  ponytail: resolves through the task's primary agent (`task.cli`); a second
 *  agent with a different default role is not counted. The footer chip shows
 *  what is actually running (BrokerCounts.roles); add per-tab resolution here
 *  if multi-agent tasks with mixed defaults turn out to be common. */
export function tasksByRole(tasks: Task[], projects: Project[], agents: Agent[], roles: Role[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.archived) continue;
    const role = resolveRole(t, projects.find(p => p.id === t.project_id), agents.find(a => a.id === t.cli), roles);
    const k = role?.id ?? "";
    const list = out.get(k);
    if (list) list.push(t); else out.set(k, [t]);
  }
  return out;
}

/** Who defaults to a role: "agent claude", "project acme/widget". */
export function defaultsFor(roleId: string, projects: Project[], agents: Agent[]): { agents: string[]; projects: string[] } {
  return {
    agents: agents.filter(a => a.default_role === roleId).map(a => a.display_name || a.id),
    projects: projects.filter(p => p.default_role === roleId).map(p => p.name),
  };
}

/** Validation for the Add secret form. Returns the first problem's key. */
export function secretProblem(s: Pick<SecretDef, "name" | "service" | "account" | "hosts">, existing: SecretDef[]): "name" | "nameTaken" | "keychain" | "hosts" | null {
  if (!s.name.trim()) return "name";
  if (existing.some(e => e.name === s.name.trim())) return "nameTaken";
  if (!s.service.trim() || !s.account.trim()) return "keychain";
  if (s.hosts.length === 0) return "hosts";
  return null;
}
