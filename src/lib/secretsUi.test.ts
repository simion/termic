import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/ipc", () => ({ settingsLoad: vi.fn().mockResolvedValue({ agents: [] }) }));
import { allowRuleFor, configuredRole, roleDefault, roleToStore, ruleSummary, brokerEnvPreview } from "@/lib/secretsUi";
import { tasksByRole } from "@/components/settings/secretsSettings/model";
import { useSecrets } from "@/store/secrets";
import type { Role, Task } from "@/lib/types";

const reviewer: Role = {
  id: "rev", name: "Reviewer", colour: "purple", description: "", secrets: ["gh"],
  rule_sets: [{ secret: "gh", host: "api.github.com", fallback: "deny", rules: [
    { effect: "allow", methods: ["GET", "HEAD"], pattern: "/**", note: "" },
    { effect: "deny", methods: ["MUTATION"], pattern: "mergePullRequest", note: "no merge" },
  ] }],
};
const t = (k: string) => k.split(".").pop()!;

describe("secretsUi", () => {
  it("default: project wins, explicit project No secrets stops the chain", () => {
    expect(roleDefault({ default_role: "rev" }, { default_role: "x" })).toEqual({ id: "rev", source: "project" });
    expect(roleDefault({ default_role: null }, { default_role: "x" })).toEqual({ id: "x", source: "agent" });
    expect(roleDefault({ default_role: "" }, { default_role: "x" })).toBeNull();
  });

  it("stores null when the pick is the inherited default", () => {
    expect(roleToStore("rev", { id: "rev" })).toBeNull();
    expect(roleToStore("", { id: "rev" })).toBe("");
    expect(roleToStore("", null)).toBeNull();
    expect(roleToStore("rev", null)).toBe("rev");
  });

  it("configured role ignores the sandbox; the real one needs the block", () => {
    const task = { role: "rev", cli: "claude", sandbox_mode: "off" as const };
    expect(configuredRole(task, null, null, [reviewer])?.id).toBe("rev");
    expect(tasksByRole([
      { ...task, id: "a", project_id: "p", archived: false } as Task,
      { ...task, id: "b", project_id: "p", archived: false, sandbox_mode: "enforce", sandbox_block_keychain: true } as Task,
    ], [], [], [reviewer]).get("rev")?.length).toBe(1);
  });

  it("summarises rules, notes first", () => {
    expect(ruleSummary(reviewer.rule_sets, t)).toEqual(["api.github.com: ruleAllow GET, HEAD /**; no merge; ruleElseDeny"]);
  });

  it("leaves a disabled rule out of the summary", () => {
    const sets = reviewer.rule_sets.map(rs => ({ ...rs, rules: rs.rules.map((r, i) => i === 0 ? { ...r, disabled: true } : r) }));
    expect(ruleSummary(sets, t)).toEqual(["api.github.com: no merge; ruleElseDeny"]);
  });

  it("allow rule mirrors the blocked request, GraphQL included", () => {
    expect(allowRuleFor({ method: "MUTATION", path: "mergePullRequest" }))
      .toEqual({ effect: "allow", methods: ["MUTATION"], pattern: "mergePullRequest", note: "" });
  });

  it("allow drops the query string", () => {
    expect(allowRuleFor({ method: "PUT", path: "/repos/acme/widget/pulls/412/merge?x=1" })?.pattern)
      .toBe("/repos/acme/widget/pulls/412/merge");
  });

  it("never offers Allow for an agent-sent wildcard or odd method", () => {
    expect(allowRuleFor({ method: "GET", path: "/repos/acme/**" })).toBeNull();
    expect(allowRuleFor({ method: "GET", path: "/repos/*/widget" })).toBeNull();
    expect(allowRuleFor({ method: "*", path: "/user" })).toBeNull();
    expect(allowRuleFor({ method: "GET POST", path: "/user" })).toBeNull();
    expect(allowRuleFor({ method: "GET", path: "?q=1" })).toBeNull();
  });

  it("env preview only for a github secret", () => {
    expect(brokerEnvPreview([])).toEqual([]);
    expect(brokerEnvPreview([{ id: "gh", name: "gh", kind: "generic", service: "gh:github.com", account: "alice", recipe: "github", hosts: ["github.com"] }])[0].line)
      .toBe("GH_TOKEN=termic_ph_…");
  });

  it("setSuspicious bails on an unchanged value", () => {
    const before = useSecrets.getState().suspicious;
    useSecrets.getState().setSuspicious("t1", false);
    expect(useSecrets.getState().suspicious).toBe(before);
    useSecrets.getState().setSuspicious("t1", true);
    const on = useSecrets.getState().suspicious;
    useSecrets.getState().setSuspicious("t1", true);
    expect(useSecrets.getState().suspicious).toBe(on);
  });
});
