import { describe, expect, it } from "vitest";
import {
  STATUS_BUCKETS,
  isStatusBucketCollapsed,
  nextIdFlags,
  parseStatusBucketCollapsed,
  parseIdFlags,
  statusBucketCollapsedByDefault,
  statusBuckets,
  statusItemTasks,
} from "./sidebarStatus";
import type { BoardTaskFacts } from "./taskBoardState";
import type { WorkStatePrefs } from "./taskWorkState";
import type { Project, Task } from "./types";

const prefsOn: WorkStatePrefs = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };

function project(id: string, group?: string): Project {
  return { id, name: id, root_path: `/Users/u/${id}`, group } as Project;
}

function task(id: string, projectId: string, over: Partial<Task> = {}): Task {
  return {
    id, project_id: projectId, name: id, branch: id, base_branch: "main",
    path: `/Users/u/${projectId}/${id}`, cli: "claude", port: 0,
    created: "2026-09-01T00:00:00Z", archived: false, ...over,
  } as Task;
}

const F = {
  untouched: { attention: false, working: false, untouched: true },
  settled: { attention: false, working: false, untouched: false },
  working: { attention: false, working: true, untouched: false },
  attention: { attention: true, working: false, untouched: false },
} satisfies Record<string, BoardTaskFacts>;

const ids = (groups: ReturnType<typeof statusBuckets>) =>
  Object.fromEntries(groups.map(g => [g.bucket, g.items.flatMap(statusItemTasks).map(t => t.id)]));

describe("statusBuckets", () => {
  it("files each task under its board column, buckets in display order", () => {
    const projects = [project("web")];
    const tasks = [
      task("fresh", "web"),
      task("done", "web"),
      task("busy", "web"),
      task("blocked", "web"),
      task("pr", "web", { pr_url: "https://github.com/acme/web/pull/1" }),
    ];
    const facts = { fresh: F.untouched, done: F.settled, busy: F.working, blocked: F.attention, pr: F.settled };
    const groups = statusBuckets(projects, tasks, facts, { pr: { lookup: { pr: { state: "open" } } } }, prefsOn);

    expect(groups.map(g => g.bucket)).toEqual(["attention", "working", "review", "settled", "backlog"]);
    expect(ids(groups)).toEqual({
      attention: ["blocked"], working: ["busy"], review: ["pr"], settled: ["done"], backlog: ["fresh"],
    });
  });

  it("drops empty buckets, and returns nothing at all for no live tasks", () => {
    const projects = [project("web")];
    expect(statusBuckets(projects, [], {}, {}, prefsOn)).toEqual([]);
    const groups = statusBuckets(projects, [task("a", "web")], { a: F.attention }, {}, prefsOn);
    expect(groups.map(g => g.bucket)).toEqual(["attention"]);
  });

  it("keeps tree order: grouped projects pulled together, then each project's task order", () => {
    // Store order web, api, docs with web and docs in one folder: the tree
    // draws web, docs, api, and so must every bucket.
    const projects = [project("web", "front"), project("api"), project("docs", "front")];
    const tasks = [
      task("api-1", "api"), task("web-2", "web"), task("docs-1", "docs"), task("web-1", "web"),
    ];
    const facts = Object.fromEntries(tasks.map(t => [t.id, F.settled]));
    expect(ids(statusBuckets(projects, tasks, facts, {}, prefsOn)).settled)
      .toEqual(["web-2", "web-1", "docs-1", "api-1"]);
  });

  it("draws a task group the way the tree does: one block, at its first member", () => {
    // Store order a(G), b, c(G): the tree renders the group block where its
    // first member sits, so c comes up next to a, ahead of b.
    const g = { id: "a" };
    const tasks = [task("a", "web", { group: g }), task("b", "web"), task("c", "web", { group: g })];
    const facts = { a: F.settled, b: F.settled, c: F.settled };
    expect(ids(statusBuckets([project("web")], tasks, facts, {}, prefsOn)).settled).toEqual(["a", "c", "b"]);
  });

  it("keeps a task group whole, in the bucket of its most urgent member", () => {
    // One member blocked on the user, one never started, one settled: the
    // group goes under Needs attention as one unit, every member with it.
    const g = { id: "lead", color: "teal" };
    const tasks = [
      task("lead", "web", { group: g }), task("loose", "web"),
      task("worker", "web", { group: g }), task("idle", "web", { group: g }),
    ];
    const facts = { lead: F.settled, loose: F.settled, worker: F.attention, idle: F.untouched };
    const groups = statusBuckets([project("web")], tasks, facts, {}, prefsOn);
    expect(ids(groups)).toEqual({ attention: ["lead", "worker", "idle"], settled: ["loose"] });
    const attention = groups.find(x => x.bucket === "attention")!;
    expect(attention.items.map(i => i.kind)).toEqual(["group"]);
    expect(attention.items[0].kind === "group" && attention.items[0].group.id).toBe("lead");
  });

  it("counts task rows, group members included", () => {
    const g = { id: "a" };
    const tasks = [task("a", "web", { group: g }), task("b", "web", { group: g }), task("c", "web")];
    const facts = { a: F.working, b: F.settled, c: F.working };
    const working = statusBuckets([project("web")], tasks, facts, {}, prefsOn).find(x => x.bucket === "working")!;
    expect(working.items.length).toBe(2);
    expect(working.count).toBe(3);
  });

  it("draws a legacy cross-project group as plain rows, as the tree does", () => {
    // The same group id in two projects, one member each: the tree treats
    // both as strays (crossProjectStrays) and draws them loose.
    const g = { id: "x" };
    const tasks = [task("x", "web", { group: g }), task("y", "api", { group: g })];
    const facts = { x: F.settled, y: F.settled };
    const settled = statusBuckets([project("web"), project("api")], tasks, facts, {}, prefsOn)[0];
    expect(settled.items.map(i => i.kind)).toEqual(["task", "task"]);
  });

  it("skips archived tasks and tasks whose project is not in the list", () => {
    const tasks = [
      task("live", "web"),
      task("gone", "web", { archived: true }),
      task("orphan", "elsewhere"),
    ];
    const facts = { live: F.settled, gone: F.attention, orphan: F.attention };
    expect(ids(statusBuckets([project("web")], tasks, facts, {}, prefsOn))).toEqual({ settled: ["live"] });
  });

  it("a task whose tabs never loaded reads as Not started, as the board reads it", () => {
    expect(ids(statusBuckets([project("web")], [task("cold", "web")], {}, {}, prefsOn))).toEqual({ backlog: ["cold"] });
  });

  it("follows the PR: unfetched and draft are review, merged falls through", () => {
    const projects = [project("web")];
    const pr = { pr_url: "https://github.com/acme/web/pull/1" };
    const tasks = [task("unfetched", "web", pr), task("draft", "web", pr), task("merged", "web", pr)];
    const facts = { unfetched: F.settled, draft: F.settled, merged: F.settled };
    const prByTask = {
      draft: { lookup: { pr: { state: "draft" } } },
      merged: { lookup: { pr: { state: "merged" } } },
    };
    expect(ids(statusBuckets(projects, tasks, facts, prByTask, prefsOn)))
      .toEqual({ review: ["unfetched", "draft"], settled: ["merged"] });
  });

  it("is gated by the same prefs as the board", () => {
    const projects = [project("web")];
    const tasks = [task("busy", "web"), task("blocked", "web")];
    const facts = { busy: F.working, blocked: F.attention };
    const off: WorkStatePrefs = { settledHighlight: true, workingIndicator: false, attentionIndicator: false };
    expect(ids(statusBuckets(projects, tasks, facts, {}, off))).toEqual({ settled: ["busy", "blocked"] });
  });
});

describe("status bucket collapse", () => {
  it("lists the actionable buckets and folds the count-only ones by default", () => {
    expect(STATUS_BUCKETS.filter(statusBucketCollapsedByDefault)).toEqual(["settled", "backlog"]);
  });

  it("an override wins in both directions", () => {
    expect(isStatusBucketCollapsed("attention", { attention: true })).toBe(true);
    expect(isStatusBucketCollapsed("settled", { settled: false })).toBe(false);
    expect(isStatusBucketCollapsed("settled", { attention: true })).toBe(true);
  });

  it("parses localStorage defensively", () => {
    expect(parseStatusBucketCollapsed(null)).toEqual({});
    expect(parseStatusBucketCollapsed("not json")).toEqual({});
    expect(parseStatusBucketCollapsed("[1,2]")).toEqual({});
    expect(parseStatusBucketCollapsed("null")).toEqual({});
    // Unknown buckets (archived is not one) and non-booleans are dropped.
    expect(parseStatusBucketCollapsed('{"settled":false,"archived":true,"working":"yes","backlog":true}'))
      .toEqual({ settled: false, backlog: true });
  });
});

describe("the section's own fold state (rows expanded, groups folded)", () => {
  it("parses only true values from localStorage", () => {
    expect(parseIdFlags(null)).toEqual({});
    expect(parseIdFlags("nope")).toEqual({});
    expect(parseIdFlags('["a"]')).toEqual({});
    expect(parseIdFlags('{"a":true,"b":false,"c":1}')).toEqual({ a: true });
  });

  it("toggles, and hands back the SAME map when nothing changes", () => {
    const cur = { a: true } as const;
    expect(nextIdFlags(cur, "a", true, ["a", "b"])).toBe(cur);
    expect(nextIdFlags(cur, "b", false, ["a", "b"])).toBe(cur);
    expect(nextIdFlags(cur, "b", true, ["a", "b"])).toEqual({ a: true, b: true });
    expect(nextIdFlags(cur, "a", false, ["a", "b"])).toEqual({});
  });

  it("drops tasks that no longer exist on the way", () => {
    const cur = { gone: true, a: true } as const;
    // Even a no-op toggle writes, once, to prune the dead id.
    expect(nextIdFlags(cur, "a", true, ["a"])).toEqual({ a: true });
  });
});
