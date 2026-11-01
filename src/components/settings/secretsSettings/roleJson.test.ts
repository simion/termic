import { describe, expect, it } from "vitest";
import en from "@/locales/en";
import type { Role, RuleSet, SecretDef } from "@/lib/types";
import { roleFromTemplate } from "./model";
import { agentPrompt, describeImport, parseRoleJson, roleJsonText, roleToJson } from "./roleJson";

const gh: SecretDef = {
  id: "s-gh", name: "gh-alice", kind: "generic", service: "gh:github.com", account: "alice", recipe: "github",
  hosts: ["api.github.com", "github.com", "uploads.github.com"],
};
const key = (id: string, name: string, env: string, hosts = ["api.anthropic.com"]): SecretDef => ({
  id, name, kind: "protected", service: `termic:${id}`, account: "termic", recipe: "api_key", hosts,
  api: { header: "x-api-key", scheme: "", env, base_url_env: "", base_url: "" },
});
const ant = key("s-ant", "anthropic", "ANTHROPIC_API_KEY");
const secrets = [gh, ant];

// returns the key itself, after checking it exists in the en tree: the error
// keys are picked by value in parseSet, so usedKeys.test.ts cannot see them.
const t = (k: string) => {
  const v = k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], en.secrets);
  if (typeof v !== "string") throw new Error(`missing secrets:${k}`);
  return k;
};
const enT = (k: string) => k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], en.secrets) as string;

const sorted = (sets: RuleSet[]) => [...sets].sort((a, b) => `${a.secret}@${a.host}`.localeCompare(`${b.secret}@${b.host}`));
const parse = (j: unknown) => parseRoleJson(typeof j === "string" ? j : JSON.stringify(j), secrets, t);
const base = { termic_role: 1, name: "R", colour: "teal", description: "" };

describe("role JSON", () => {
  it("round-trips: export then import gives the same secrets and rule sets", () => {
    const reviewer = roleFromTemplate("reviewer", "r1", gh, [], enT);
    const role: Role = {
      ...reviewer,
      secrets: [gh.id, ant.id],
      rule_sets: [
        ...reviewer.rule_sets.map((rs, i) => i === 0 ? { ...rs, rules: rs.rules.map((r, j) => j === 0 ? { ...r, disabled: true } : r) } : rs),
        { secret: ant.id, host: "api.anthropic.com", fallback: "deny", rules: [{ effect: "allow", methods: ["POST"], pattern: "/v1/messages", note: "" }] },
      ],
    };
    const back = parse(roleJsonText(role, secrets));
    expect(back.errors).toEqual([]);
    expect(back.warnings).toEqual([]);
    expect(back.role!.secrets).toEqual(role.secrets);
    expect(sorted(back.role!.rule_sets)).toEqual(sorted(role.rule_sets));
    expect(back.role).toMatchObject({ name: role.name, colour: role.colour, description: role.description });
    expect(describeImport(back.role!, secrets, t, role)).toEqual([{ sign: "~", text: "manage.json.diff.same" }]);
  });

  it("exports secrets by name, a bound secret with no sets as {}, and off rules", () => {
    const role: Role = { id: "r", name: "R", colour: "blue", description: "d", secrets: [ant.id, "gone"], rule_sets: [
      { secret: ant.id, host: "old.example.com", fallback: "deny", rules: [] },
    ] };
    expect(roleToJson(role, secrets)).toEqual({ termic_role: 1, name: "R", colour: "blue", description: "d", secrets: { anthropic: {} } });
    const r2: Role = { ...role, secrets: [ant.id], rule_sets: [{ secret: ant.id, host: "api.anthropic.com", fallback: "allow", rules: [
      { effect: "deny", methods: ["POST", "PUT"], pattern: "/v1/files/**", note: "", disabled: true },
    ] }] };
    expect(roleToJson(r2, secrets).secrets.anthropic["api.anthropic.com"].rules).toEqual([{ deny: "POST PUT", match: "/v1/files/**", off: true }]);
  });

  it("imports a {} secret with no sets, and warns about hosts left out", () => {
    const p = parse({ ...base, secrets: { "gh-alice": { "github.com": { otherwise: "deny", rules: [{ allow: "fetch", match: "acme/*" }] } }, anthropic: {} } });
    expect(p.errors).toEqual([]);
    expect(p.role!.secrets).toEqual([gh.id, ant.id]);
    expect(p.role!.rule_sets).toEqual([{ secret: gh.id, host: "github.com", fallback: "deny", rules: [{ effect: "allow", methods: ["fetch"], pattern: "acme/*", note: "" }] }]);
    expect(p.warnings).toEqual(["manage.json.warn.hostsLeft", "manage.json.warn.hostsLeft"]);
  });

  it("refuses what validate would, and what only a name-based import can get wrong", () => {
    const one = (j: unknown) => parse(j).errors;
    const set = (s: unknown) => one({ ...base, secrets: { "gh-alice": { "api.github.com": s } } });
    expect(one("{ nope")[0]).toBe("manage.json.err.parse");
    expect(one({ name: "x" })).toEqual(["manage.json.err.notRole"]);
    expect(one({ ...base, termic_role: 2 })).toEqual(["manage.json.err.notRole"]);
    expect(one({ ...base, name: "  " })).toEqual(["manage.json.err.name"]);
    expect(one({ ...base, secrets: [] })).toEqual(["manage.json.err.secrets"]);
    expect(one({ ...base, secrets: { "gh-bob": {} } })).toEqual(["manage.json.err.unknownSecret"]);
    expect(one({ ...base, secrets: { "gh-alice": [] } })).toEqual(["manage.json.err.hosts"]);
    expect(one({ ...base, secrets: { "gh-alice": { "api.acme.com": {} } } })).toEqual(["manage.json.err.host"]);
    expect(set("deny")).toEqual(["manage.json.err.set"]);
    expect(set({ otherwise: "maybe" })).toEqual(["manage.json.err.otherwise"]);
    expect(set({ rules: {} })).toEqual(["manage.json.err.rules"]);
    expect(set({ rules: ["GET"] })).toEqual(["manage.json.err.rule"]);
    expect(set({ rules: [{ match: "/**" }] })).toEqual(["manage.json.err.effect"]);
    expect(set({ rules: [{ allow: "GET", deny: "POST", match: "/**" }] })).toEqual(["manage.json.err.effect"]);
    expect(set({ rules: [{ allow: " ", match: "/**" }] })).toEqual(["manage.json.err.method"]);
    expect(set({ rules: [{ allow: "GET" }] })).toEqual(["manage.json.err.match"]);
    // only QUERY may leave match out.
    expect(set({ rules: [{ allow: "QUERY" }] })).toEqual([]);
  });

  it("refuses two secrets on one host, and two API keys on one env var", () => {
    const twin = key("s-ant2", "anthropic-2", "ANTHROPIC_API_KEY");
    const other = key("s-oai", "openai", "ANTHROPIC_API_KEY", ["api.openai.com"]);
    const all = [...secrets, twin, other];
    expect(parseRoleJson(JSON.stringify({ ...base, secrets: { anthropic: {}, "anthropic-2": {} } }), all, t).errors)
      .toEqual(["manage.json.err.conflict", "manage.json.err.env"]);
    expect(parseRoleJson(JSON.stringify({ ...base, secrets: { anthropic: {}, openai: {} } }), all, t).errors)
      .toEqual(["manage.json.err.env"]);
  });

  it("falls back on a bad colour with a warning, defaults a missing otherwise to deny", () => {
    const p = parse({ ...base, colour: "chartreuse", secrets: { anthropic: { "api.anthropic.com": {} } } });
    expect(p.errors).toEqual([]);
    expect(p.role!.colour).toBe("blue");
    expect(p.warnings).toEqual(["manage.json.warn.colour"]);
    expect(p.role!.rule_sets[0]).toEqual({ secret: ant.id, host: "api.anthropic.com", fallback: "deny", rules: [] });
  });

  it("describes an import as new, and as changes to an existing role", () => {
    const draft = parse({ ...base, secrets: { anthropic: {}, "gh-alice": { "github.com": { otherwise: "deny", rules: [{ allow: "fetch", match: "*" }] } } } }).role!;
    expect(describeImport(draft, secrets, t)).toEqual([
      { sign: "+", text: "manage.json.diff.secretDefault" },
      { sign: "+", text: "manage.json.diff.set_one" },
    ]);
    const existing: Role = { id: "r", name: "Old", colour: "teal", description: "", secrets: [gh.id], rule_sets: [
      { secret: gh.id, host: "github.com", fallback: "deny", rules: [] },
      { secret: gh.id, host: "api.github.com", fallback: "deny", rules: [] },
    ] };
    expect(describeImport(draft, secrets, t, existing)).toEqual([
      { sign: "~", text: "manage.json.diff.name" },
      { sign: "+", text: "manage.json.diff.secretDefault" },
      { sign: "~", text: "manage.json.diff.set_one" },
      { sign: "-", text: "manage.json.diff.dropSet" },
    ]);
  });

  it("builds a prompt with the format, the secrets by name and the example role", () => {
    const role = roleFromTemplate("reviewer", "r1", gh, [], enT);
    const p = agentPrompt("review PRs in acme", secrets, role);
    expect(p).toContain("review PRs in acme");
    expect(p).toContain("- gh-alice, GitHub token: api.github.com, github.com, uploads.github.com");
    expect(p).toContain("- anthropic, API key, $ANTHROPIC_API_KEY: api.anthropic.com");
    expect(p).toContain('"termic_role": 1');
    expect(p).toContain("first match decides");
    expect(p).toContain(roleJsonText(role, secrets));
    expect(p).not.toContain("—");
    expect(agentPrompt("", secrets)).not.toContain("Example");
  });
});
