// A role as portable JSON (`termic_role: 1`), the paste-to-import check, and
// the "Ask an agent" prompt. Secrets are referenced by NAME, not id, so a role
// copied on one Mac pastes into another that has secrets of the same names.
// Pure: `t` resolves `manage.json.*` keys for the messages.

import type { Role, Rule, RuleEffect, RuleSet, SecretDef } from "@/lib/types";
import { API_HOST, GIT_HOST, ROLE_COLOURS, hostConflicts } from "./model";

type T = (key: string, opts?: Record<string, unknown>) => string;

export interface JsonRule { allow?: string; deny?: string; match: string; note?: string; off?: true }
export interface JsonSet { otherwise: RuleEffect; rules: JsonRule[] }
export interface RoleJson {
  termic_role: 1;
  name: string;
  colour: string;
  description: string;
  /** secret name -> host -> rules. `{}` binds the secret with no rule sets. */
  secrets: Record<string, Record<string, JsonSet>>;
}

/** A role without its id: what an import produces before it is added or
 *  written over an existing role. */
export type RoleDraft = Omit<Role, "id">;

export function roleToJson(role: Role, secrets: SecretDef[]): RoleJson {
  const out: RoleJson = { termic_role: 1, name: role.name, colour: role.colour, description: role.description, secrets: {} };
  for (const id of role.secrets) {
    const s = secrets.find(x => x.id === id);
    if (!s) continue;
    // ponytail: a set for a host the secret no longer has is invisible in the
    // editor and dead in the broker, so it is left out rather than exported
    // into a JSON that would then fail its own import.
    out.secrets[s.name] = Object.fromEntries(role.rule_sets
      .filter(rs => rs.secret === id && s.hosts.includes(rs.host))
      .map(rs => [rs.host, { otherwise: rs.fallback, rules: rs.rules.map(ruleToJson) }]));
  }
  return out;
}

const ruleToJson = (r: Rule): JsonRule => ({
  [r.effect]: r.methods.join(" "),
  match: r.pattern,
  ...(r.note ? { note: r.note } : {}),
  ...(r.disabled ? { off: true as const } : {}),
});

export const roleJsonText = (role: Role, secrets: SecretDef[]) => JSON.stringify(roleToJson(role, secrets), null, 2);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse and check a pasted role. `role` is set only when there are no
 *  errors. The checks mirror secrets.rs `validate` (one secret per host, two
 *  API keys on one env var, a rule needs a method and a pattern unless it is
 *  QUERY), plus the ones only a name-based import can fail: an unknown secret
 *  name, a host the secret is not sent to. */
export function parseRoleJson(text: string, secrets: SecretDef[], t: T): { role?: RoleDraft; errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) {
    return { errors: [t("manage.json.err.parse", { message: e instanceof Error ? e.message : String(e) })], warnings };
  }
  if (!isObj(j) || j.termic_role !== 1) return { errors: [t("manage.json.err.notRole")], warnings };

  const name = typeof j.name === "string" ? j.name.trim() : "";
  if (!name) errors.push(t("manage.json.err.name"));
  let colour: string = ROLE_COLOURS[0];
  if (typeof j.colour === "string" && (ROLE_COLOURS as string[]).includes(j.colour)) colour = j.colour;
  else if (j.colour !== undefined) warnings.push(t("manage.json.warn.colour", { colour: String(j.colour), fallback: colour }));
  const description = typeof j.description === "string" ? j.description : "";

  const ids: string[] = [], sets: RuleSet[] = [];
  const secretsIn = j.secrets ?? {};
  if (!isObj(secretsIn)) errors.push(t("manage.json.err.secrets"));
  else for (const [sname, hosts] of Object.entries(secretsIn)) {
    const s = secrets.find(x => x.name === sname);
    if (!s) {
      errors.push(t("manage.json.err.unknownSecret", { secret: sname, names: secrets.map(x => x.name).join(", ") || "-" }));
      continue;
    }
    ids.push(s.id);
    if (!isObj(hosts)) { errors.push(t("manage.json.err.hosts", { secret: sname })); continue; }
    for (const [host, set] of Object.entries(hosts)) {
      if (!s.hosts.includes(host)) { errors.push(t("manage.json.err.host", { secret: sname, host })); continue; }
      const parsed = parseSet(set);
      if (typeof parsed === "string") { errors.push(t(parsed, { secret: sname, host })); continue; }
      sets.push({ secret: s.id, host, ...parsed });
    }
    const left = s.hosts.filter(h => !(h in hosts));
    if (left.length) warnings.push(t("manage.json.warn.hostsLeft", { secret: sname, hosts: left.join(", ") }));
  }

  const dup = hostConflicts(ids, secrets);
  if (dup.length) errors.push(t("manage.json.err.conflict", { hosts: dup.join(", ") }));
  const envs = new Map<string, string>();
  for (const id of ids) {
    const s = secrets.find(x => x.id === id);
    if (s?.recipe !== "api_key" || !s.api) continue;
    for (const v of [s.api.env, s.api.base_url_env].filter(Boolean)) {
      const prev = envs.get(v.toUpperCase());
      if (prev) errors.push(t("manage.json.err.env", { a: prev, b: s.name, env: v }));
      else envs.set(v.toUpperCase(), s.name);
    }
  }

  if (errors.length) return { errors, warnings };
  return { role: { name, colour, description, secrets: ids, rule_sets: sets }, errors, warnings };
}

/** One host's set, or the locale key of what is wrong with it. */
function parseSet(set: unknown): Omit<RuleSet, "secret" | "host"> | string {
  if (!isObj(set)) return "manage.json.err.set";
  // a missing `otherwise` denies: the safe reading of a set that forgot it.
  const fallback = set.otherwise ?? "deny";
  if (fallback !== "allow" && fallback !== "deny") return "manage.json.err.otherwise";
  const list = set.rules ?? [];
  if (!Array.isArray(list)) return "manage.json.err.rules";
  const rules: Rule[] = [];
  for (const r of list) {
    if (!isObj(r)) return "manage.json.err.rule";
    const hasA = typeof r.allow === "string", hasD = typeof r.deny === "string";
    if (hasA === hasD) return "manage.json.err.effect";
    const methods = String(hasA ? r.allow : r.deny).split(/[,\s]+/).filter(Boolean);
    const pattern = typeof r.match === "string" ? r.match.trim() : "";
    if (!methods.length) return "manage.json.err.method";
    if (!pattern && !methods.every(m => m.toUpperCase() === "QUERY")) return "manage.json.err.match";
    rules.push({
      effect: hasA ? "allow" : "deny", methods, pattern,
      note: typeof r.note === "string" ? r.note : "",
      ...(r.off === true ? { disabled: true } : {}),
    });
  }
  return { rules, fallback };
}

export interface ImportLine { sign: "+" | "-" | "~" | "!"; text: string }

const READ_VERBS = new Set(["GET", "HEAD", "QUERY", "fetch"]);

/** The parts of a set worth a second look before importing: a write verb
 *  allowed on a catch-all pattern, or an allow fallback. A count alone would
 *  hide a pasted role that quietly opens everything. */
function broadAllows(rs: RuleSet): string[] {
  const out = rs.rules
    .filter(r => !r.disabled && r.effect === "allow" && r.methods.some(m => !READ_VERBS.has(m))
      && (r.pattern === "" || r.pattern === "*" || r.pattern === "*/*" || r.pattern.endsWith("**")))
    .map(r => `${r.methods.join(" ")} ${r.pattern || "*"}`);
  return out;
}

/** What an import adds, or, given `existing`, what it changes on that role.
 *  Short on purpose: one line per (secret, host) that differs. */
export function describeImport(draft: RoleDraft, secrets: SecretDef[], t: T, existing?: Role): ImportLine[] {
  const out: ImportLine[] = [];
  const nameOf = (id: string) => secrets.find(s => s.id === id)?.name ?? id;
  const summary = (rs: RuleSet) => {
    const o = { secret: nameOf(rs.secret), host: rs.host, count: rs.rules.length, otherwise: rs.fallback };
    return rs.rules.length === 1 ? t("manage.json.diff.set_one", o) : t("manage.json.diff.set_other", o);
  };
  if (existing) {
    if (existing.name !== draft.name) out.push({ sign: "~", text: t("manage.json.diff.name", { from: existing.name, to: draft.name }) });
    if (existing.colour !== draft.colour) out.push({ sign: "~", text: t("manage.json.diff.colour", { from: existing.colour, to: draft.colour }) });
    if (existing.description !== draft.description) out.push({ sign: "~", text: t("manage.json.diff.description") });
    for (const id of existing.secrets.filter(x => !draft.secrets.includes(x))) out.push({ sign: "-", text: t("manage.json.diff.dropSecret", { secret: nameOf(id) }) });
  }
  const before = existing?.secrets ?? [];
  for (const id of draft.secrets.filter(x => !before.includes(x))) {
    if (!draft.rule_sets.some(rs => rs.secret === id)) out.push({ sign: "+", text: t("manage.json.diff.secretDefault", { secret: nameOf(id) }) });
  }
  const key = (rs: RuleSet) => `${rs.secret}@${rs.host}`;
  const old = new Map((existing?.rule_sets ?? []).map(rs => [key(rs), rs]));
  for (const rs of draft.rule_sets) {
    const prev = old.get(key(rs));
    old.delete(key(rs));
    if (prev && sameSet(prev, rs)) continue;
    out.push({ sign: prev ? "~" : "+", text: summary(rs) });
    for (const what of broadAllows(rs)) out.push({ sign: "!", text: t("manage.json.diff.broad", { what }) });
    if (rs.fallback === "allow") out.push({ sign: "!", text: t("manage.json.diff.fallbackAllow") });
  }
  for (const rs of old.values()) {
    if (draft.secrets.includes(rs.secret)) out.push({ sign: "-", text: t("manage.json.diff.dropSet", { secret: nameOf(rs.secret), host: rs.host }) });
  }
  if (existing && !out.length) out.push({ sign: "~", text: t("manage.json.diff.same") });
  return out;
}

const sameSet = (a: RuleSet, b: RuleSet) => a.fallback === b.fallback && a.rules.length === b.rules.length
  && a.rules.every((r, i) => {
    const o = b.rules[i];
    return r.effect === o.effect && r.pattern === o.pattern && r.note === o.note && !!r.disabled === !!o.disabled && r.methods.join(" ") === o.methods.join(" ");
  });

/** The prompt "Ask an agent" copies. English on purpose: it is read by a
 *  model, and the format, verbs and host names it explains are English
 *  anyway. `example` is the role open in the editor, when there is one. */
export function agentPrompt(ask: string, secrets: SecretDef[], example?: Role): string {
  const kind = (s: SecretDef) => s.recipe === "github" ? "GitHub token" : s.api?.env ? `API key, $${s.api.env}` : "API key";
  return `Write a Termic role as JSON. Reply with only the JSON, no prose and no code fence.

What the role should allow: ${ask.trim() || "(not described)"}

Secrets I have (name, kind: hosts the real value is sent to):
${secrets.map(s => `- ${s.name}, ${kind(s)}: ${s.hosts.join(", ")}`).join("\n") || "- (none yet)"}

Format:
{ "termic_role": 1, "name": "...", "colour": "${ROLE_COLOURS.join("|")}", "description": "...",
  "secrets": { "<secret name>": { "<host>": { "otherwise": "allow"|"deny",
    "rules": [ { "allow"|"deny": "<verbs, space separated>", "match": "<pattern>", "note": "<optional>" } ] } } } }

How rules match:
- Refer to secrets by the names above. A role can hold only one secret per host.
- A secret listed with {} is bound with no rules. A host left out takes the role default (deny if any set says "otherwise": "deny").
- Each host's rules are checked top to bottom. The first match decides; "otherwise" decides the rest.
- HTTP hosts: verbs are GET, POST, PUT, PATCH, DELETE, HEAD, or *. "match" is a path: * is one segment, ** is any number of segments.
- ${API_HOST} also takes QUERY (GraphQL reads, match "*") and MUTATION (match the mutation name, like mergePullRequest; globs work).
- ${GIT_HOST} is git: verbs are fetch and push, "match" is owner/repo with globs (acme/*).
- An allow "*" never covers QUERY, MUTATION, fetch or push. A deny "*" covers everything.
- Every rule needs a verb and a match (only QUERY may leave match empty).
${example ? `\nExample, my current "${example.name}" role:\n${roleJsonText(example, secrets)}\n` : ""}`;
}
