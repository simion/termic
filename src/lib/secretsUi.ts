// Pure helpers behind the task-side Secrets surfaces (New Task role section,
// footer chip + popover, sidebar key). No React, no store: the components
// pass `t` in so a language switch re-renders them (docs/i18n.md).

import { roleColourVar } from "@/components/settings/secretsSettings/model";
import {
  resolveRole,
  type Agent, type BrokerBlocked, type BrokerCounts, type Project, type Role, type Rule,
  type RuleSet, type SecretDef,
} from "./types";

/** The CSS colour for a role. Shares the literal var map with Settings:
 *  Tailwind only keeps @theme vars it sees spelled out, so a built-up
 *  `var(--color-role-${c})` string painted nothing. */
export const roleColour = (c: string | undefined | null) => roleColourVar(c ?? undefined);

/** Where a new task's role comes from when it picks nothing: the project's
 *  default, then the agent's. Mirrors the tail of `resolveRole`. */
export function roleDefault(
  project: Pick<Project, "default_role"> | null | undefined,
  agent: Pick<Agent, "default_role"> | null | undefined,
): { id: string; source: "project" | "agent" } | null {
  // "" on the project is an explicit No secrets and stops the chain, like
  // resolveRole's `??`.
  if (project?.default_role != null) return project.default_role ? { id: project.default_role, source: "project" } : null;
  if (agent?.default_role) return { id: agent.default_role, source: "agent" };
  return null;
}

/** What to store as `Task.role` for a dialog's pick: null (inherit) when the
 *  pick IS the inherited default, so a later change to the project default
 *  still reaches the task. */
export function roleToStore(pick: string, def: { id: string } | null): string | null {
  if (def && pick === def.id) return null;
  if (!def && pick === "") return null;
  return pick;
}

/** The role this task WOULD run with if its Keychain were blocked: what the
 *  uncaged notice (M6) talks about. */
export function configuredRole(
  task: { role?: string | null; cli?: string } | null | undefined,
  project: Pick<Project, "default_role"> | null | undefined,
  agent: Pick<Agent, "default_role"> | null | undefined,
  roles: Role[] | undefined,
): Role | null {
  if (!task) return null;
  return resolveRole(
    { ...task, sandbox_mode: "enforce-fs", sandbox_block_keychain: true, docker_sandbox_enabled: false },
    project, agent, roles,
  );
}

/** One line per (secret, host) rule set: the rules' notes when they have
 *  them, else `allow GET, HEAD /**`, then the fallback. */
export function ruleSummary(sets: RuleSet[], t: (k: string) => string): string[] {
  return sets.map(rs => {
    const parts = rs.rules.filter(r => !r.disabled).map(r =>
      r.note.trim() || `${t(r.effect === "allow" ? "secrets:task.ruleAllow" : "secrets:task.ruleDeny")} ${r.methods.join(", ")} ${r.pattern}`.trim());
    parts.push(t(rs.fallback === "allow" ? "secrets:task.ruleElseAllow" : "secrets:task.ruleElseDeny"));
    return `${rs.host}: ${parts.join("; ")}`;
  });
}

/** What the agent's environment will carry for a role: names and shapes
 *  only, never a value. Mirrors what broker::start puts in `env` for the
 *  GitHub recipe (the only one in v1). */
export function brokerEnvPreview(secrets: SecretDef[]): { line: string; note: "placeholder" | "socket" | null }[] {
  if (!secrets.some(s => s.recipe === "github")) return [];
  const gitHost = secrets.flatMap(s => s.hosts).find(h => h === "github.com") ?? "github.com";
  return [
    { line: "GH_TOKEN=termic_ph_…", note: "placeholder" },
    { line: "GH_CONFIG_DIR=<task>/gh", note: "socket" },
    { line: `git: http.https://${gitHost}/.sslCAInfo=<task CA>`, note: null },
  ];
}

/** The allow rule the popover's Allow button saves for a blocked request,
 *  or null when the row must not offer one. GraphQL blocks arrive as method
 *  `MUTATION` with the mutation name as the path (plan 3.3), so the same
 *  shape covers both.
 *
 *  The method and path are what the AGENT sent, and the pattern is a glob:
 *  a request to `/repos/acme/**` saved verbatim would turn one click into a
 *  wildcard grant. So the query string is dropped, and anything carrying a
 *  `*`, or a method that is not one plain token, gets no Allow at all. */
export function allowRuleFor(b: Pick<BrokerBlocked, "method" | "path">): Rule | null {
  const path = b.path.split("?")[0];
  if (!path || path.includes("*") || !/^[A-Za-z]+$/.test(b.method)) return null;
  return { effect: "allow", methods: [b.method], pattern: path, note: "" };
}

/** The `secrets` namespace key naming a Suspicious event's kind, shared by
 *  the footer popover and the Activity tab so neither shows the raw enum. */
export function suspiciousKey(kind: string): string {
  return kind === "placeholder_unbound_host" ? "task.suspPlaceholder"
    : kind === "keychain_denied" ? "task.suspKeychain"
    : kind === "wrong_peer" ? "task.suspPeer" : "task.suspOther";
}

export const sameCounts = (a: BrokerCounts | null, b: BrokerCounts) =>
  !!a && a.blocked === b.blocked && a.suspicious === b.suspicious && a.no_secret === b.no_secret
  && a.used === b.used && a.paused === b.paused && a.live === b.live
  && a.roles.length === b.roles.length && a.roles.every((r, i) => r === b.roles[i]);
