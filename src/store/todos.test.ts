import { describe, it, expect, vi, beforeEach } from "vitest";
import { coveredProjects, parseTodosProjects, pickedProjects, todoQueries, todoRows, useTodos } from "./todos";
import { clearForgeLists, forgeListKey, type ForgeListEntry, type ForgeListQuery } from "./forgeLists";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { ForgeIssue, ForgePr, IssueLookup, PrPickList, Project } from "@/lib/types";

vi.mock("@/lib/ipc", () => ({
  projectForgeIssues: vi.fn(),
  projectForgePrs: vi.fn(),
  projectForgeLists: vi.fn(),
}));

// node vitest has no localStorage. Installed before the store module runs, so
// its init-time read of the saved project filter sees this stub too.
const stored = vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return map;
});

const okIssues = { provider: "github", remote_url: "", status: "ok", message: "", issues: [] } as unknown as IssueLookup;
const okPrs = { provider: "github", remote_url: "", status: "ok", message: "", prs: [] } as unknown as PrPickList;

const issue = (number: number, title = `Issue ${number}`): ForgeIssue => ({
  provider: "github", number, title, url: "", body: "", author: "alice", comments: 0, labels: [],
  updated_at: "2026-10-24T10:00:00Z",
});
const pr = (number: number): ForgePr => ({
  provider: "github", number, title: `PR ${number}`, url: "", body: "", author: "bob",
  head_ref: "feat", cross_repository: false, draft: false, updated_at: "2026-10-24T11:00:00Z",
});
const okEntry = (query: ForgeListQuery, ok: IssueLookup | PrPickList): ForgeListEntry =>
  ({ query, status: "ok", ok, okAt: 1, fetchedAt: Date.now() });

describe("todos store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The batch answers each list the way its single call would, so the
    // assertions below can name the list they expect.
    vi.mocked(ipc.projectForgeLists).mockImplementation(async (qs) => Promise.all(qs.map((q) =>
      q.kind === "issues"
        ? ipc.projectForgeIssues(q.projectId, q.limit, q.scope as never)
        : ipc.projectForgePrs(q.projectId, { scope: q.scope as never, limit: q.limit }))));
    stored.clear();
    clearForgeLists();
    useTodos.setState({
      selectedProjectIds: [],
      kindFilter: "all",
      scopeFilter: "for_me",
      searchQuery: "",
    });
  });

  it("skips non-git projects", async () => {
    useApp.setState({ projects: [{ id: "p-nongit", name: "Plain Folder", non_git: true } as Project] });
    await useTodos.getState().fetchVisibleTodos();
    expect(ipc.projectForgeIssues).not.toHaveBeenCalled();
    expect(ipc.projectForgePrs).not.toHaveBeenCalled();
  });

  it("fetches assigned issues and review/mine PRs for 'For me', at the dialogs' limits", async () => {
    useApp.setState({ projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project] });
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
    vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);

    await useTodos.getState().fetchVisibleTodos();

    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "assigned");
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "review", limit: 30 });
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "mine", limit: 30 });
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(1);
    expect(ipc.projectForgePrs).toHaveBeenCalledTimes(2);
  });

  it("asks for every list the view reads in one batch call", async () => {
    useApp.setState({ projects: ["p1", "p2", "p3"].map((id) => ({ id, name: id, non_git: false } as Project)) });
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
    vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);

    await useTodos.getState().fetchVisibleTodos();

    expect(ipc.projectForgeLists).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.projectForgeLists).mock.calls[0][0]).toHaveLength(9);
  });

  it("keeps the last rows of a list whose batch failed", async () => {
    useApp.setState({ projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project] });
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue({ ...okIssues, issues: [issue(1)] });
    vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);
    await useTodos.getState().fetchVisibleTodos();

    vi.mocked(ipc.projectForgeLists).mockRejectedValueOnce(new Error("ipc down"));
    await useTodos.getState().fetchVisibleTodos(true);

    const queries = todoQueries(useApp.getState().projects, "all", "for_me");
    const { items, errors } = todoRows(queries, (await import("./forgeLists")).useForgeLists.getState().entries, useApp.getState().projects);
    expect(items.map((i) => i.id)).toEqual(["p1:issue:1"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("fetches nothing again within the TTL, and everything on Refresh", async () => {
    useApp.setState({ projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project] });
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
    vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);

    await useTodos.getState().fetchVisibleTodos();
    await useTodos.getState().fetchVisibleTodos();
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(1);

    await useTodos.getState().fetchVisibleTodos(true);
    expect(ipc.projectForgeIssues).toHaveBeenCalledTimes(2);
    expect(ipc.projectForgePrs).toHaveBeenCalledTimes(4);
  });

  it("queues both broad and user queries when scope is 'all'", async () => {
    useApp.setState({ projects: [{ id: "p1", name: "Repo 1", non_git: false } as Project] });
    useTodos.setState({ scopeFilter: "all", kindFilter: "all" });
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
    vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);

    await useTodos.getState().fetchVisibleTodos(true);

    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "all");
    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "assigned");
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "open", limit: 30 });
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "review", limit: 30 });
    expect(ipc.projectForgePrs).toHaveBeenCalledWith("p1", { scope: "mine", limit: 30 });
  });

  it("reads only PR lists for 'Review requested', and nothing at all with Issues picked", () => {
    const p = [{ id: "p1", name: "Repo 1", non_git: false } as Project];
    expect(todoQueries(p, "all", "review").map(forgeListKey)).toEqual(["p1:prs:review:30"]);
    expect(todoQueries(p, "issues", "review")).toEqual([]);
    expect(todoQueries(p, "issues", "for_me").map(forgeListKey)).toEqual(["p1:issues:assigned:50"]);
  });

  describe("rows", () => {
    const projects = [{ id: "p1", name: "Renamed Repo", non_git: false } as Project];

    it("gives each issue or PR one row, carrying its most specific role and the project's current name", () => {
      const queries = todoQueries(projects, "all", "all");
      const entries = {
        [forgeListKey(queries[0])]: okEntry(queries[0], { ...okIssues, issues: [issue(13), issue(14)] }),
        [forgeListKey(queries[1])]: okEntry(queries[1], { ...okIssues, issues: [issue(13)] }),
        [forgeListKey(queries[2])]: okEntry(queries[2], { ...okPrs, prs: [pr(5)] }),
        [forgeListKey(queries[4])]: okEntry(queries[4], { ...okPrs, prs: [pr(5)] }),
      };
      const { items, pending } = todoRows(queries, entries, projects);

      const byId = Object.fromEntries(items.map((i) => [i.id, i]));
      expect(Object.keys(byId).sort()).toEqual(["p1:issue:13", "p1:issue:14", "p1:pr:5"]);
      expect(byId["p1:issue:13"].action).toBe("assigned");
      expect(byId["p1:issue:14"].action).toBe("open");
      expect(byId["p1:pr:5"].action).toBe("authored");
      expect(byId["p1:pr:5"].projectName).toBe("Renamed Repo");
      // The review list never answered.
      expect(pending).toBe(true);
    });

    it("keeps a failed list's last rows and explains the failure", () => {
      const [q] = todoQueries(projects, "issues", "for_me");
      const entries = {
        [forgeListKey(q)]: {
          ...okEntry(q, { ...okIssues, issues: [issue(99)] }),
          status: "error" as const,
          errorMessage: "Network unreachable",
        },
      };
      const { items, errors, pending } = todoRows([q], entries, projects);
      expect(items.map((i) => i.id)).toEqual(["p1:issue:99"]);
      expect(errors).toEqual([{ key: forgeListKey(q), message: "Network unreachable" }]);
      expect(pending).toBe(false);
    });

    it("is pending while a list is loading, even with rows from before", () => {
      const [q] = todoQueries(projects, "issues", "for_me");
      const entries = { [forgeListKey(q)]: { ...okEntry(q, { ...okIssues, issues: [issue(1)] }), status: "loading" as const } };
      const { items, pending } = todoRows([q], entries, projects);
      expect(items).toHaveLength(1);
      expect(pending).toBe(true);
    });
  });

  describe("project selection", () => {
    const projects = [
      { id: "p1", name: "Repo 1", non_git: false } as Project,
      { id: "p2", name: "Repo 2", non_git: false } as Project,
      { id: "p3", name: "Repo 3", non_git: false } as Project,
      { id: "p-plain", name: "Plain Folder", non_git: true } as Project,
    ];

    it("fetches only the picked projects", async () => {
      useApp.setState({ projects });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
      vi.mocked(ipc.projectForgePrs).mockResolvedValue(okPrs);
      useTodos.setState({ selectedProjectIds: ["p1", "p3"], kindFilter: "issues" });

      await useTodos.getState().fetchVisibleTodos(true);

      const fetched = vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0]).sort();
      expect(fetched).toEqual(["p1", "p3"]);
    });

    it("fetches every git project when nothing is picked", async () => {
      useApp.setState({ projects });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
      useTodos.setState({ kindFilter: "issues" });

      await useTodos.getState().fetchVisibleTodos(true);

      const fetched = vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0]).sort();
      expect(fetched).toEqual(["p1", "p2", "p3"]);
    });

    it("fetches only the newly picked project when one is added to a cached selection", async () => {
      useApp.setState({ projects });
      vi.mocked(ipc.projectForgeIssues).mockResolvedValue(okIssues);
      useTodos.setState({ kindFilter: "issues", selectedProjectIds: ["p1"] });
      await useTodos.getState().fetchVisibleTodos();
      vi.mocked(ipc.projectForgeIssues).mockClear();

      useTodos.getState().setSelectedProjectIds(["p1", "p2"]);
      await useTodos.getState().fetchVisibleTodos();

      expect(vi.mocked(ipc.projectForgeIssues).mock.calls.map((c) => c[0])).toEqual(["p2"]);
    });

    it("treats a selection naming only removed projects as every project", () => {
      expect(pickedProjects(projects, ["gone"])).toEqual([]);
      expect(coveredProjects(projects, ["gone"]).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
      // A removed id beside a live one narrows to the live one.
      expect(coveredProjects(projects, ["gone", "p2"]).map((p) => p.id)).toEqual(["p2"]);
      // A non-git project cannot be picked, even by a stored id.
      expect(pickedProjects(projects, ["p-plain"])).toEqual([]);
    });

    it("persists the selection and clears the key for every project", () => {
      useTodos.getState().setSelectedProjectIds(["p2", "p1"]);
      expect(JSON.parse(stored.get("todosProjects") ?? "null")).toEqual(["p2", "p1"]);

      useTodos.getState().setSelectedProjectIds([]);
      expect(stored.has("todosProjects")).toBe(false);
    });

    it("does not write an unchanged selection", () => {
      useTodos.getState().setSelectedProjectIds(["p1"]);
      const before = useTodos.getState();
      const listener = vi.fn();
      const unsub = useTodos.subscribe(listener);
      useTodos.getState().setSelectedProjectIds(["p1"]);
      unsub();
      expect(listener).not.toHaveBeenCalled();
      expect(useTodos.getState()).toBe(before);
    });

    it("reads the saved selection back on a fresh load", async () => {
      useTodos.getState().setSelectedProjectIds(["p3", "p1"]);
      vi.resetModules();
      const fresh = await import("./todos");
      expect(fresh.useTodos.getState().selectedProjectIds).toEqual(["p3", "p1"]);
    });

    it("parses malformed stored values as every project", () => {
      expect(parseTodosProjects(null)).toEqual([]);
      expect(parseTodosProjects("")).toEqual([]);
      expect(parseTodosProjects("{not json")).toEqual([]);
      expect(parseTodosProjects('{"p1":true}')).toEqual([]);
      expect(parseTodosProjects('"p1"')).toEqual([]);
      expect(parseTodosProjects('["p1", 7, null, "", "p2", "p1"]')).toEqual(["p1", "p2"]);
    });
  });
});
