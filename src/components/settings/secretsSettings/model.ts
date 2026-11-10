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

/** One way an agent reaches a secret, for the "Delivered as" chips. */
export type Delivery = { via: "gh" } | { via: "git" } | { via: "baseUrl"; env: string } | { via: "proxy" };

/** The routes a secret is delivered through, only those that are on
 *  (`deliveries`, which mirrors recipe.rs). */
export function deliveredAs(s: Pick<SecretDef, "recipe" | "hosts" | "api">): Delivery[] {
  return deliveries(s).filter(d => d.on).map(({ route }): Delivery =>
    route === "baseUrl" ? { via: "baseUrl", env: s.api?.base_url_env ?? "" } : route === "envProxy" ? { via: "proxy" } : { via: route });
}

/** Env var names kept out of agents whatever their value looks like
 *  (env_guard.rs `BUILTIN`; model.test.ts pins the two together). */
export const ENV_GUARD_BUILTIN = [
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "GITLAB_TOKEN", "GL_TOKEN",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS",
  "NPM_TOKEN", "HF_TOKEN", "DOCKER_PASSWORD",
];

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

/** Env vars an API key may not claim. Mirrors secrets.rs `env_reserved`. */
const ENV_RESERVED = new Set([
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS",
]);
const ENV_RESERVED_PREFIX = ["DYLD_", "LD_", "TERMIC_", "GIT_", "GH_", "SANDBOX"];
/** Headers the broker never rewrites. Mirrors secrets.rs `header_reserved`. */
const HEADER_RESERVED = new Set(["host", "content-length", "transfer-encoding", "connection", "proxy-connection", "keep-alive",
  "upgrade", "te", "trailer", "proxy-authorization", "expect"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const envProblem = (v: string): "env" | "envReserved" | null => {
  if (!ENV_NAME.test(v)) return "env";
  const u = v.toUpperCase();
  return ENV_RESERVED.has(u) || ENV_RESERVED_PREFIX.some(p => u.startsWith(p)) ? "envReserved" : null;
};

export type ApiKeyField = "value" | "env" | "header" | "scheme" | "baseUrlEnv" | "baseUrl";
export type ApiKeyProblem = "value" | "env" | "envReserved" | "header" | "headerReserved" | "scheme"
  | "baseUrlEnvSame" | "baseUrlPair" | "baseUrlShape" | "baseUrlHost";

/** Every problem with an API key draft, keyed by the field it belongs to.
 *  Mirrors secrets.rs `validate_api_key`; the Rust side re-checks on save,
 *  this is for the message next to the field before the round trip. */
export function apiKeyProblems(value: string, hosts: string[], a: ApiKeyCfg): Partial<Record<ApiKeyField, ApiKeyProblem>> {
  const out: Partial<Record<ApiKeyField, ApiKeyProblem>> = {};
  if (!value.trim()) out.value = "value";
  const env = envProblem(a.env);
  if (env) out.env = env;
  if (!HEADER_TOKEN.test(a.header)) out.header = "header";
  else if (HEADER_RESERVED.has(a.header.toLowerCase())) out.header = "headerReserved";
  if (a.scheme && !HEADER_TOKEN.test(a.scheme)) out.scheme = "scheme";
  if (a.base_url_env) {
    const b = envProblem(a.base_url_env);
    if (b) out.baseUrlEnv = b;
    else if (a.base_url_env.toUpperCase() === a.env.toUpperCase()) out.baseUrlEnv = "baseUrlEnvSame";
  }
  const hasEnv = a.base_url_env !== "", hasUrl = a.base_url.trim() !== "";
  if (hasEnv !== hasUrl) out.baseUrl = "baseUrlPair";
  else if (hasUrl) {
    const h = baseUrlHost(a.base_url);
    if (!h) out.baseUrl = "baseUrlShape";
    else if (!hosts.some(x => x.toLowerCase() === h)) out.baseUrl = "baseUrlHost";
  }
  return out;
}

/** One broker delivery (broker/recipe.rs `Delivery`). */
export type DeliveryRoute = "gh" | "git" | "baseUrl" | "envProxy";

/** The delivery routes of a secret's recipe, each on or off from its hosts
 *  and fields. Mirrors `Route::active` over the GITHUB and API_KEY specs in
 *  src-tauri/src/broker/recipe.rs: a route added or re-conditioned there
 *  changes here too, or the Add dialog promises a delivery that never
 *  happens. */
export function deliveries(s: Pick<SecretDef, "recipe" | "hosts" | "api">): { route: DeliveryRoute; on: boolean }[] {
  const bound = (h: string) => s.hosts.some(x => x.toLowerCase() === h);
  switch (s.recipe) {
    case "github": return [{ route: "gh", on: bound(API_HOST) }, { route: "git", on: bound(GIT_HOST) }];
    case "api_key": {
      const h = s.api?.base_url_env ? baseUrlHost(s.api.base_url) : null;
      return [{ route: "baseUrl", on: !!h && bound(h) }, { route: "envProxy", on: s.hosts.length > 0 }];
    }
    default: return [];
  }
}

/** What a rule block's requests are: plain HTTP, the GitHub API (HTTP plus
 *  GraphQL QUERY / MUTATION), or git (fetch / push). */
export type BlockKind = "http" | "api" | "git";

/** The (secret, host) rule blocks the editor shows for a role, one per host
 *  of each of its secrets. Every host gets one: a (secret, host) with no rule
 *  set allows everything, so a host without a block would be an unrestricted
 *  policy nobody can see. For a GitHub secret github.com carries git and
 *  api.github.com GraphQL; every other host is HTTP. */
export function ruleBlocksFor(role: Role, secrets: SecretDef[]): { secret: SecretDef; host: string; kind: BlockKind }[] {
  const out: { secret: SecretDef; host: string; kind: BlockKind }[] = [];
  for (const id of role.secrets) {
    const s = secrets.find(x => x.id === id);
    if (!s) continue;
    for (const host of s.hosts) {
      const gh = s.recipe === "github";
      out.push({ secret: s, host, kind: gh && host === GIT_HOST ? "git" : gh && host === API_HOST ? "api" : "http" });
    }
  }
  return out;
}

export const HTTP_VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** The verb picker's groups for a block kind. `*` (every HTTP verb) is
 *  offered on its own for every kind but git. */
export function verbGroups(kind: BlockKind): { label: "http" | "graphql" | "git"; verbs: string[] }[] {
  if (kind === "git") return [{ label: "git", verbs: ["fetch", "push"] }];
  const http = { label: "http" as const, verbs: HTTP_VERBS };
  return kind === "api" ? [http, { label: "graphql", verbs: ["QUERY", "MUTATION"] }] : [http];
}

/** A verb typed into the picker, normalised (upper case, but git's fetch and
 *  push stay lower, as rules.rs spells them), or null when it is not a verb.
 *  Letters, digits, `-`, `.`, `_`: every real method, and a subset of the
 *  HTTP token rules.rs accepts. `*` is not typed: it has its own button. */
export function normaliseVerb(v: string): string | null {
  const t = v.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(t)) return null;
  return /^(fetch|push)$/i.test(t) ? t.toLowerCase() : t.toUpperCase();
}

/** Toggle one verb in a rule's methods. `*` and the named verbs exclude each
 *  other (`*` already covers every HTTP verb), and the last verb cannot be
 *  toggled off: a rule with no method matches nothing and secrets.rs refuses
 *  it. */
export function toggleVerb(methods: string[], verb: string): string[] {
  if (verb === "*") return methods.includes("*") ? methods : ["*"];
  const rest = methods.filter(m => m !== "*");
  const next = rest.includes(verb) ? rest.filter(m => m !== verb) : [...rest, verb];
  return next.length ? next : methods;
}

/** How broad a rule's pattern is, smallest first: `**` count, then `*`
 *  count, then a SHORTER literal prefix (the text before the first `*`,
 *  leading `/` ignored). An empty pattern (a QUERY rule) counts as `**`. */
function breadth(r: Rule): [number, number, number] {
  const p = r.pattern.trim().replace(/^\/+/, "") || "**";
  const dbl = p.split("**").length - 1;
  const single = p.replaceAll("**", "").split("*").length - 1;
  const star = p.indexOf("*");
  return [dbl, single, -(star < 0 ? p.length : star)];
}

/** "Sort by specificity": the new order of `rules`, as indices into it. Most
 *  specific pattern first (see `breadth`), deny before allow on a tie, else
 *  the old order. Disabled rules stay where they are; the enabled ones are
 *  sorted into the remaining slots. */
export function specificityOrder(rules: Rule[]): number[] {
  const key = (i: number) => [...breadth(rules[i]), rules[i].effect === "deny" ? 0 : 1];
  const sorted = rules.map((_, i) => i).filter(i => !rules[i].disabled).sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let j = 0; j < ka.length; j++) if (ka[j] !== kb[j]) return ka[j] - kb[j];
    return a - b;
  });
  let k = 0;
  return rules.map((r, i) => r.disabled ? i : sorted[k++]);
}

/** Split a tester line into the command's method and target: `GET /x`,
 *  `MUTATION addComment`, `push acme/widget`, `QUERY`. */
export function splitRequest(q: string): { method: string; target: string } {
  const t = q.trim();
  const sp = t.search(/\s/);
  return sp < 0 ? { method: t, target: "" } : { method: t.slice(0, sp), target: t.slice(sp).trim() };
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

/** Toggle a secret on a role. Dropping it also drops its rule sets and its
 *  checkbox state, so a re-added secret starts clean instead of with rules
 *  nobody can see. */
export function toggleSecret(role: Role, secretId: string, on: boolean): Role {
  if (on) return role.secrets.includes(secretId) ? role : { ...role, secrets: [...role.secrets, secretId] };
  const { [secretId]: _, ...simple } = role.simple ?? {};
  return {
    ...role,
    secrets: role.secrets.filter(s => s !== secretId),
    rule_sets: role.rule_sets.filter(r => r.secret !== secretId),
    ...(role.simple ? { simple } : {}),
  };
}

/** A copy of `role` under a new id: same secrets, rules, checkbox state and
 *  description, the next unused colour, and a name no other role has. */
export function duplicateRole(role: Role, id: string, roles: Role[], copyName: (name: string, n: number) => string): Role {
  const taken = new Set(roles.map(r => r.name));
  let n = 1;
  let name = copyName(role.name, n);
  while (taken.has(name)) name = copyName(role.name, ++n);
  const used = roles.map(r => r.colour);
  const colour = ROLE_COLOURS.find(c => !used.includes(c)) ?? role.colour;
  return { ...structuredClone(role), id, name, colour };
}

/** Live (non-archived) tasks per role id, by each task's own role (every
 *  agent of a task runs it). Tasks with no role land under "". */
export function tasksByRole(tasks: Task[], roles: Role[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.archived) continue;
    const role = resolveRole(t, roles);
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

/** Validation for the Add secret form, every problem keyed by its field. */
export function secretProblems(s: Pick<SecretDef, "name" | "service" | "account" | "hosts">, existing: SecretDef[]): {
  name?: "name" | "nameTaken"; keychain?: "keychain"; hosts?: "hosts";
} {
  const out: ReturnType<typeof secretProblems> = {};
  if (!s.name.trim()) out.name = "name";
  else if (existing.some(e => e.name === s.name.trim())) out.name = "nameTaken";
  if (!s.service.trim() || !s.account.trim()) out.keychain = "keychain";
  if (s.hosts.length === 0) out.hosts = "hosts";
  return out;
}

/** The first of `secretProblems`, or null. */
export function secretProblem(s: Pick<SecretDef, "name" | "service" | "account" | "hosts">, existing: SecretDef[]): "name" | "nameTaken" | "keychain" | "hosts" | null {
  const p = secretProblems(s, existing);
  return p.name ?? p.keychain ?? p.hosts ?? null;
}
