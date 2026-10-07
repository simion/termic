// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

// Same stubs as taskFilter.test.ts: free text goes through taskFilter, which
// reaches the app store through cliAgentState, which drags in tauri and ipc.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn() }));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli === "claude" ? "Claude Code" : cli),
  workDoneCapable: vi.fn(() => true),
  isTerminalCli: vi.fn(() => false),
}));

import {
  boardClauseState,
  boardQueryUses,
  cycleBoardClause,
  dropBoardClauses,
  setBoardClause,
  boardSuggestions,
  boardTaskMatches,
  isBoardQueryActive,
  parseBoardQuery,
  toggleBoardClause,
  type BoardMatchCtx,
} from "@/lib/boardFilter";
import type { PrLookup, Project, Task } from "@/lib/types";

function task(extra: Partial<Task> = {}): Task {
  return {
    id: "t1", project_id: "p1", name: "Fix login", branch: "fix/login", base_branch: "main",
    cli: "claude", archived: false, created: "2026-09-01T00:00:00Z", ...extra,
  } as Task;
}
const project = (extra: Partial<Project> = {}) => ({ id: "p1", name: "acme-web", ...extra } as Project);
const lookup = (state: string, checks = "none"): PrLookup =>
  ({ status: "ok", pr: { state, checks } } as unknown as PrLookup);

function ctx(extra: Partial<BoardMatchCtx> = {}): BoardMatchCtx {
  return { project: project(), column: "settled", pr: null, changed: null, facts: undefined, agents: [], ...extra };
}
const matches = (q: string, t = task(), c = ctx()) => boardTaskMatches(t, c, parseBoardQuery(q));

describe("parseBoardQuery", () => {
  it("a key named after an Object.prototype member is unknown, not a rule", () => {
    const q = parseBoardQuery("constructor:x");
    expect(q.clauses).toEqual([]);
    expect(q.unknownKeys).toEqual(["constructor"]);
    expect(matches("constructor:x")).toBe(false);
    expect(matches("-constructor:x")).toBe(true);
    expect(boardSuggestions("constructor:", () => ["a"])).toEqual([]);
    expect(setBoardClause("constructor:x", "project", "a", "include")).toBe("constructor:x project:a");
  });

  it("splits free text, qualifiers, negation, commas and quotes", () => {
    const q = parseBoardQuery(`login -bug project:"my repo",acme -agent:codex`);
    expect(q.terms).toEqual([{ text: "login", negated: false }, { text: "bug", negated: true }]);
    expect(q.clauses).toEqual([
      { key: "project", values: ["my repo", "acme"], negated: false },
      { key: "agent", values: ["codex"], negated: true },
    ]);
  });

  it("folds aliases and is case-insensitive on keys and values", () => {
    expect(parseBoardQuery("REPO:Acme column:Working").clauses).toEqual([
      { key: "project", values: ["acme"], negated: false },
      { key: "status", values: ["working"], negated: false },
    ]);
  });

  it("a qualifier with no value yet filters nothing", () => {
    const q = parseBoardQuery("project: agent:claude,");
    expect(q.clauses).toEqual([{ key: "agent", values: ["claude"], negated: false }]);
    expect(q.terms).toEqual([]);
  });

  it("an unknown key is free text, and is reported", () => {
    const q = parseBoardQuery("foo:bar");
    expect(q.unknownKeys).toEqual(["foo"]);
    expect(q.terms).toEqual([{ text: "foo:bar", negated: false }]);
  });

  it("a lone dash and blank input are not filters", () => {
    expect(isBoardQueryActive(parseBoardQuery("   "))).toBe(false);
    expect(isBoardQueryActive(parseBoardQuery("-"))).toBe(false);
  });

  it("a negation on its way to a key filters nothing until committed", () => {
    for (const partial of ["-a", "-ag", "-agent", "x -p"]) {
      expect(parseBoardQuery(partial).terms.filter(t => t.negated)).toEqual([]);
    }
    // A trailing space, or a word no key starts with, commits it as text.
    expect(parseBoardQuery("-a ").terms).toEqual([{ text: "a", negated: true }]);
    expect(parseBoardQuery("-zzz").terms).toEqual([{ text: "zzz", negated: true }]);
    // Not the last token: the user moved on, it is text.
    expect(parseBoardQuery("-pro foo").terms[0]).toEqual({ text: "pro", negated: true });
  });

  it("an unterminated quote runs to the end", () => {
    expect(parseBoardQuery(`project:"my re`).clauses[0].values).toEqual(["my re"]);
  });

  it("boardQueryUses names the keys a query reads", () => {
    const q = parseBoardQuery("checks:failing has:changes");
    expect(boardQueryUses(q, "checks")).toBe(true);
    expect(boardQueryUses(q, "has", "changes")).toBe(true);
    expect(boardQueryUses(q, "has", "pr")).toBe(false);
    expect(boardQueryUses(q, "pr")).toBe(false);
  });
});

describe("boardTaskMatches", () => {
  it("free text: every word must hit name or branch, negation excludes", () => {
    expect(matches("login")).toBe(true);
    expect(matches("fix LOGIN")).toBe(true);
    expect(matches("login signup")).toBe(false);
    expect(matches("-login")).toBe(false);
    expect(matches("fix/log")).toBe(true); // branch
  });

  it("free text reaches tab titles and properties through the sidebar's matcher", () => {
    const facts = { notification: false, titles: ["Reviewer"], propValues: ["ACME-42"] };
    expect(matches("reviewer", task(), ctx({ facts }))).toBe(true);
    expect(matches("acme-42", task(), ctx({ facts }))).toBe(true);
  });

  it("project: is exact on the name, and matches multi-repo members", () => {
    expect(matches("project:acme-web")).toBe(true);
    expect(matches("project:acme")).toBe(false);
    const multi = task({ composition: [{ dir_name: "api" } as never] });
    expect(matches("repo:api", multi)).toBe(true);
  });

  it("comma ORs within a clause, clauses AND", () => {
    expect(matches("agent:codex,claude")).toBe(true);
    expect(matches("agent:claude project:other")).toBe(false);
  });

  it("agent: takes the id or the display name", () => {
    expect(matches("agent:claude")).toBe(true);
    expect(matches(`agent:"claude code"`)).toBe(true);
    expect(matches("-agent:claude")).toBe(false);
  });

  it("a negated multi-value clause excludes a card matching any one of its values", () => {
    const q = "-status:settled,archived";
    expect(matches(q, task({ archived: true }), ctx({ column: "archived" }))).toBe(false);
    expect(matches(q, task(), ctx({ column: "settled" }))).toBe(false);
    expect(matches(q, task(), ctx({ column: "working" }))).toBe(true);
  });

  it("group:, status:, branch:, base:", () => {
    const c = ctx({ project: project({ group: "Work" }), column: "working" });
    expect(matches("group:work", task(), c)).toBe(true);
    // groupOf's normalization: an untrimmed label is the same sidebar group.
    expect(matches("group:work", task(), ctx({ project: project({ group: " work " }) }))).toBe(true);
    expect(matches("group:work", task(), ctx({ project: project() }))).toBe(false);
    expect(matches("status:working", task(), c)).toBe(true);
    expect(matches("-status:working", task(), c)).toBe(false);
    expect(matches("branch:login")).toBe(true);
    expect(matches("base:main")).toBe(true);
    expect(matches("base:develop")).toBe(false);
  });

  it("pr: uses the live state, an unpolled identity reads open, none without one", () => {
    expect(matches("pr:none")).toBe(true);
    expect(matches("no:pr")).toBe(true);
    const withPr = task({ pr_number: 7 });
    expect(matches("pr:open", withPr)).toBe(true);
    expect(matches("has:pr", withPr)).toBe(true);
    expect(matches("pr:merged", withPr, ctx({ pr: lookup("merged") }))).toBe(true);
    expect(matches("pr:open", withPr, ctx({ pr: lookup("merged") }))).toBe(false);
  });

  it("pr: an archived task is never polled, so its state is unknown, not open", () => {
    const old = task({ pr_number: 7, archived: true });
    expect(matches("pr:open", old)).toBe(false);
    expect(matches("pr:merged", old)).toBe(false);
    expect(matches("pr:none", old)).toBe(false);
    expect(matches("has:pr", old)).toBe(true);
    // A lookup that is there (polled before it was archived) still counts.
    expect(matches("pr:merged", old, ctx({ pr: lookup("merged") }))).toBe(true);
  });

  it("pr: ignores a main checkout's identity, like the review column", () => {
    const main = task({ is_main_checkout: true, pr_url: "https://github.com/acme/web/pull/7" });
    expect(matches("pr:open", main)).toBe(false);
    expect(matches("has:pr", main)).toBe(false);
    expect(matches("pr:none", main)).toBe(true);
  });

  it("checks: reads the poll", () => {
    expect(matches("checks:failing", task(), ctx({ pr: lookup("open", "failing") }))).toBe(true);
    expect(matches("checks:failing")).toBe(false);
  });

  it("has:changes and no:changes both refuse an unmeasured task", () => {
    expect(matches("has:changes")).toBe(false);
    expect(matches("no:changes")).toBe(false);
    expect(matches("has:changes", task(), ctx({ changed: true }))).toBe(true);
    expect(matches("no:changes", task(), ctx({ changed: false }))).toBe(true);
  });

  it("has: and no: with an unknown value match nothing, not everything", () => {
    expect(matches("no:prs")).toBe(false);
    expect(matches("has:prs")).toBe(false);
    expect(matches("no:change", task(), ctx({ changed: false }))).toBe(false);
  });

  it("is: flags", () => {
    expect(matches("is:worktree")).toBe(true);
    expect(matches("is:main", task({ is_main_checkout: true }))).toBe(true);
    expect(matches("is:yolo", task({ yolo: true }))).toBe(true);
    expect(matches("is:docker", task({ docker_sandbox_enabled: true }))).toBe(true);
    expect(matches("is:sandboxed", task({ sandbox_mode: "enforce" }))).toBe(true);
    expect(matches("is:sandboxed", task({ sandbox_mode: "enforce", docker_sandbox_enabled: true }))).toBe(false);
    expect(matches("is:archived", task({ archived: true }))).toBe(true);
    expect(matches("is:bogus")).toBe(false);
  });
});

describe("toggleBoardClause", () => {
  it("appends, quoting a value with spaces", () => {
    expect(toggleBoardClause("login", "project", "my repo")).toBe(`login project:"my repo"`);
    expect(toggleBoardClause("", "agent", "claude")).toBe("agent:claude");
  });

  it("removes a value already in a positive clause, keeping its siblings", () => {
    expect(toggleBoardClause("agent:claude x", "agent", "claude")).toBe("x");
    expect(toggleBoardClause("agent:claude,codex", "agent", "Claude")).toBe("agent:codex");
    expect(toggleBoardClause(`repo:"my repo"`, "project", "my repo")).toBe("");
  });

  it("turns an exclusion into an inclusion rather than holding both", () => {
    expect(toggleBoardClause("-agent:claude", "agent", "claude")).toBe("agent:claude");
  });

  it("keeps the case of the values it does not touch", () => {
    expect(toggleBoardClause("project:Acme,Other", "project", "other")).toBe("project:Acme");
  });
});

describe("setBoardClause / cycleBoardClause", () => {
  const state = (text: string, key: "project" | "agent", v: string) =>
    boardClauseState(parseBoardQuery(text), key, v);

  it("merges into an existing token of the same key and sign", () => {
    expect(setBoardClause("x project:a", "project", "b", "include")).toBe("x project:a,b");
    expect(setBoardClause("project:a", "project", "b", "exclude")).toBe("project:a -project:b");
    expect(setBoardClause("-project:a", "project", "b", "exclude")).toBe("-project:a,b");
  });

  it("moves a value between signs and removes it cleanly", () => {
    expect(setBoardClause("project:a,b", "project", "a", "exclude")).toBe("project:b -project:a");
    expect(setBoardClause("project:a,b -project:c", "project", "c", null)).toBe("project:a,b");
  });

  it("completes a dangling key instead of leaving it behind", () => {
    expect(setBoardClause("login project:", "project", "a", "include")).toBe("login project:a");
  });

  it("follows aliases", () => {
    expect(setBoardClause("repo:a", "project", "a", null)).toBe("");
  });

  it("cycles off -> include -> exclude -> off", () => {
    let q = "";
    q = cycleBoardClause(q, "agent", "claude");
    expect(state(q, "agent", "claude")).toBe("include");
    q = cycleBoardClause(q, "agent", "claude");
    expect(state(q, "agent", "claude")).toBe("exclude");
    expect(q).toBe("-agent:claude");
    q = cycleBoardClause(q, "agent", "claude");
    expect(q).toBe("");
  });
});

describe("review round 2 edges", () => {
  it("boardQueryUses folds the value's case", () => {
    expect(boardQueryUses(parseBoardQuery("has:changes"), "has", "Changes")).toBe(true);
  });

  it("an alias prefix is a pending negation too", () => {
    expect(isBoardQueryActive(parseBoardQuery("-re"))).toBe(false);
    expect(isBoardQueryActive(parseBoardQuery("-col"))).toBe(false);
    // Committed with a space, it is text again.
    expect(parseBoardQuery("-re ").terms).toEqual([{ text: "re", negated: true }]);
  });

  it("a chip click drops a trailing pending negation instead of committing it", () => {
    expect(setBoardClause("-ag", "agent", "x", "include")).toBe("agent:x");
    expect(setBoardClause("login -re", "project", "a", "include")).toBe("login project:a");
    // Already committed as text: kept.
    expect(setBoardClause("-ag ", "agent", "x", "include")).toBe("-ag agent:x");
  });

  it("a URL or a path is not reported as an unknown filter, and repeats report once", () => {
    expect(parseBoardQuery("https://acme.com/pr/1").unknownKeys).toEqual([]);
    expect(parseBoardQuery("C:\\work").unknownKeys).toEqual([]);
    expect(parseBoardQuery("foo:a foo:b").unknownKeys).toEqual(["foo"]);
  });
});

describe("boardSuggestions", () => {
  const values = (k: string) => (k === "project" ? ["acme-web", "acme api", "other"] : []);

  it("offers qualifier keys for a bare prefix, keeping a negation", () => {
    // An exact key is still offered, first, so Enter completes it.
    expect(boardSuggestions("pr", values).map(s => s.label)).toEqual(["pr:", "project:"]);
    expect(boardSuggestions("is", values).map(s => s.label)).toEqual(["is:"]);
    // Aliases complete too.
    expect(boardSuggestions("rep", values).map(s => s.label)).toEqual(["repo:"]);
    expect(boardSuggestions("x -st", values).map(s => s.next)).toEqual(["x -status:"]);
  });

  it("offers values for a key, fuzzy-ranked, quoting where needed", () => {
    const s = boardSuggestions("project:acme", values);
    expect(s.map(x => x.label)).toEqual(expect.arrayContaining(["acme-web", "acme api"]));
    expect(s.find(x => x.label === "acme api")!.next).toBe(`project:"acme api" `);
  });

  it("keeps a value typed in full, first, so Enter does not swap it", () => {
    const vals = (k: string) => (k === "project" ? ["acme-web", "acme"] : []);
    const s = boardSuggestions("project:acme", vals);
    expect(s[0].label).toBe("acme");
    expect(s[0].next).toBe("project:acme ");
    expect(boardSuggestions("project:ACME", vals)[0].label).toBe("acme");
  });

  it("completes after a comma and skips values already picked", () => {
    const s = boardSuggestions("project:other,", values);
    expect(s.map(x => x.label)).toEqual(["acme-web", "acme api"]);
    expect(s[0].next).toBe("project:other,acme-web ");
  });

  it("uses the enum for closed keys", () => {
    expect(boardSuggestions("is:y", values).map(s => s.label)).toEqual(["yolo"]);
  });

  it("nothing after a space or for an unknown key", () => {
    expect(boardSuggestions("project:acme ", values)).toEqual([]);
    expect(boardSuggestions("foo:b", values)).toEqual([]);
  });
});

describe("dropBoardClauses (the status chips' counts)", () => {
  // Four tasks, two projects; the chips count a column under the REST of the
  // query, which must equal what `<rest> status:<column>` lists.
  const cols: Record<string, BoardMatchCtx["column"]> = { a: "attention", w: "working", w2: "working", r: "review" };
  const tasks = Object.keys(cols).map(id => task({ id, project_id: id === "w2" ? "p2" : "p1" }));
  const ctxOf = (t: Task) => ctx({ column: cols[t.id], project: project({ id: t.project_id, name: t.project_id }) });
  const list = (q: string) => tasks.filter(t => boardTaskMatches(t, ctxOf(t), parseBoardQuery(q))).map(t => t.id);

  it.each([
    ["", ""],
    ["project:p1", "project:p1"],
    ["status:attention", ""],
    ["project:p1 status:review,working", "project:p1"],
    ["-status:working w", "w"],
  ])("under %j a chip counts what `<rest> status:<column>` lists", (text, restText) => {
    const rest = dropBoardClauses(parseBoardQuery(text), "status");
    for (const c of ["attention", "working", "review"] as const) {
      const counted = tasks.filter(t => ctxOf(t).column === c && boardTaskMatches(t, ctxOf(t), rest)).map(t => t.id);
      expect(counted).toEqual(list(`${restText} status:${c}`.trim()));
    }
  });

  it("keeps every other clause and the free text", () => {
    const q = dropBoardClauses(parseBoardQuery("login project:p1 -status:working"), "status");
    expect(q.clauses.map(c => c.key)).toEqual(["project"]);
    expect(q.terms.map(t => t.text)).toEqual(["login"]);
  });
});
