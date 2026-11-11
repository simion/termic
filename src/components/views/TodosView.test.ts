// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    openPath: vi.fn().mockResolvedValue(undefined),
    projectForgeIssues: vi.fn(),
    projectForgePrs: vi.fn(),
    // The view fetches through the batch; it answers each list the way its
    // single call would, so a test can still hold one list back.
    projectForgeLists: vi.fn(),
  };
});

import { TodosView } from "./TodosView";
import { useApp } from "@/store/app";
import { useTodos } from "@/store/todos";
import { clearForgeLists, forgeListKey, useForgeLists, type ForgeListQuery } from "@/store/forgeLists";
import { useUI } from "@/store/ui";
import * as ipc from "@/lib/ipc";
import type { ForgeIssue, ForgePr, IssueLookup, PrPickList, Project } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issue = (number: number, title: string, over: Partial<ForgeIssue> = {}): ForgeIssue => ({
  provider: "github", number, title, url: "", body: "", author: "alice", comments: 0, labels: [],
  updated_at: "2026-10-24T10:00:00Z", ...over,
});
const pr = (number: number, title: string, over: Partial<ForgePr> = {}): ForgePr => ({
  provider: "github", number, title, url: "", body: "", author: "bob", head_ref: "feat",
  cross_repository: false, draft: false, updated_at: "2026-10-24T11:00:00Z", ...over,
});
const issuesOk = (issues: ForgeIssue[]): IssueLookup => ({ provider: "github", remote_url: "", status: "ok", message: "", issues });
const prsOk = (prs: ForgePr[]): PrPickList => ({ provider: "github", remote_url: "", status: "ok", message: "", prs });

/** Put a fresh answer in the shared lists, as a fetch that just landed would. */
function seed(query: ForgeListQuery, ok: IssueLookup | PrPickList, over: { status?: "ok" | "loading"; fetchedAt?: number } = {}) {
  const key = forgeListKey(query);
  useForgeLists.setState((s) => ({
    entries: {
      ...s.entries,
      [key]: { query, status: over.status ?? "ok", ok, okAt: 1, fetchedAt: over.fetchedAt ?? Date.now() },
    },
  }));
}

describe("TodosView component", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    // Lists nobody seeded answer empty, so the mount's fetch settles.
    vi.mocked(ipc.projectForgeIssues).mockResolvedValue(issuesOk([]));
    vi.mocked(ipc.projectForgePrs).mockResolvedValue(prsOk([]));
    vi.mocked(ipc.projectForgeLists).mockImplementation(async (qs) => Promise.all(qs.map((q) =>
      q.kind === "issues"
        ? ipc.projectForgeIssues(q.projectId, q.limit, q.scope as never)
        : ipc.projectForgePrs(q.projectId, { scope: q.scope as never, limit: q.limit }))));
    container = document.createElement("div");
    document.body.appendChild(container);

    localStorage.clear();
    clearForgeLists();
    useTodos.setState({
      selectedProjectIds: [],
      kindFilter: "all",
      scopeFilter: "for_me",
      searchQuery: "",
    });
    useApp.setState({
      projects: [
        { id: "p1", name: "Backend API", non_git: false } as Project,
        { id: "p2", name: "Frontend Web", non_git: false } as Project,
      ],
    });
  });

  async function render(): Promise<Root> {
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TodosView));
      await new Promise((r) => setTimeout(r, 10));
    });
    return root;
  }

  it("renders view title, project filter, and kind/scope pills", async () => {
    const root = await render();
    expect(container.querySelector('[data-testid="todos-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="todos-project-filter"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="todos-refresh-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="todos-kind-all"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="todos-scope-for_me"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("displays issue rows with action badges and labels, and starts a task from one", async () => {
    seed(
      { projectId: "p1", kind: "issues", scope: "assigned" },
      issuesOk([issue(101, "Fix memory leak in buffer pool", {
        url: "https://github.com/acme/backend/issues/101", body: "Leaking memory during streaming",
        comments: 3, labels: ["bug", "p0"],
      })]),
    );
    const openNewTaskSpy = vi.spyOn(useUI.getState(), "openNewTask");
    const root = await render();

    expect(container.textContent).toContain("Fix memory leak in buffer pool");
    expect(container.textContent).toContain("#101");
    expect(container.textContent).toContain("Backend API");
    expect(container.textContent).toContain("by alice");
    expect(container.textContent).toContain("bug");

    const startBtn = container.querySelector('[data-testid="todos-start-task"]') as HTMLButtonElement;
    await act(async () => startBtn.click());
    expect(openNewTaskSpy).toHaveBeenCalledWith("p1", expect.objectContaining({
      mode: "worktree",
      issue: expect.objectContaining({ number: 101, body: "Leaking memory during streaming" }),
    }));
    await act(async () => root.unmount());
  });

  it("displays PR rows with the draft badge, and handles review and the browser link", async () => {
    seed(
      { projectId: "p1", kind: "prs", scope: "review" },
      prsOk([pr(55, "Add telemetry metrics", { url: "https://github.com/acme/backend/pull/55", draft: true })]),
    );
    const openReviewPrSpy = vi.spyOn(useUI.getState(), "openReviewPr");
    const root = await render();

    expect(container.textContent).toContain("Add telemetry metrics");
    expect(container.textContent).toContain("!55");
    expect(container.textContent).toContain("draft");
    expect(container.textContent).toContain("by bob");

    await act(async () => (container.querySelector('[data-testid="todos-start-task"]') as HTMLButtonElement).click());
    expect(openReviewPrSpy).toHaveBeenCalledWith("p1", { number: 55, url: "https://github.com/acme/backend/pull/55" });

    await act(async () => (container.querySelector('[data-testid="todos-open-browser"]') as HTMLButtonElement).click());
    expect(ipc.openPath).toHaveBeenCalledWith("https://github.com/acme/backend/pull/55");
    await act(async () => root.unmount());
  });

  it("says Loading, not No items, while the lists are on their way, then the empty state", async () => {
    let answer!: (v: IssueLookup) => void;
    vi.mocked(ipc.projectForgeIssues).mockReturnValue(new Promise<IssueLookup>((r) => { answer = r; }));
    useTodos.setState({ kindFilter: "issues" });
    const root = await render();

    expect(container.querySelector('[data-testid="todos-loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No items found");
    const refresh = container.querySelector('[data-testid="todos-refresh-button"]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);

    await act(async () => {
      answer(issuesOk([]));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.querySelector('[data-testid="todos-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="todos-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("No items found");
    expect(refresh.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("keeps the rows it has on screen while a stale list is re-fetched", async () => {
    let answer!: (v: IssueLookup) => void;
    vi.mocked(ipc.projectForgeIssues).mockReturnValue(new Promise<IssueLookup>((r) => { answer = r; }));
    useTodos.setState({ kindFilter: "issues" });
    // As the launch snapshot restores it: an old answer, past the TTL.
    seed({ projectId: "p1", kind: "issues", scope: "assigned" }, issuesOk([issue(7, "Remembered issue")]), { fetchedAt: 1 });
    const root = await render();

    expect(ipc.projectForgeIssues).toHaveBeenCalledWith("p1", 50, "assigned");
    expect(container.textContent).toContain("Remembered issue");
    expect(container.querySelector('[data-testid="todos-loading"]')).toBeNull();

    await act(async () => {
      answer(issuesOk([issue(7, "Remembered issue"), issue(8, "New issue")]));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.textContent).toContain("New issue");
    await act(async () => root.unmount());
  });

  it("renders the empty state when every list answers empty", async () => {
    const root = await render();
    expect(container.querySelector('[data-testid="todos-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="todos-empty"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("matches issue reference numbers with leading # or !", async () => {
    useTodos.setState({ searchQuery: "#101" });
    seed({ projectId: "p1", kind: "issues", scope: "assigned" }, issuesOk([issue(101, "Memory leak")]));
    const root = await render();
    expect(container.querySelector('[data-testid="todos-row"]')).not.toBeNull();
    expect(container.textContent).toContain("Memory leak");
    await act(async () => root.unmount());
  });

  it("preserves the 'assigned' badge over a generic 'open' when two lists carry one issue", async () => {
    useTodos.setState({ scopeFilter: "all" });
    seed({ projectId: "p1", kind: "issues", scope: "all" }, issuesOk([issue(13, "Report daily budget", { provider: "gitlab" })]));
    seed({ projectId: "p1", kind: "issues", scope: "assigned" }, issuesOk([issue(13, "Report daily budget", { provider: "gitlab" })]));
    const root = await render();

    const rows = container.querySelectorAll('[data-testid="todos-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("assigned");
    await act(async () => root.unmount());
  });

  it("renders the sticky footer with total count, breakdown, metrics and project count", async () => {
    useTodos.setState({ scopeFilter: "all" });
    seed({ projectId: "p1", kind: "issues", scope: "assigned" }, issuesOk([issue(1, "Task 1")]));
    seed({ projectId: "p2", kind: "prs", scope: "review" }, prsOk([pr(2, "PR 2")]));
    const root = await render();

    const footer = container.querySelector('[data-testid="todos-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain("2 items");
    expect(footer?.textContent).toContain("1 issue, 1 PR");
    expect(footer?.textContent).toContain("1 assigned");
    expect(footer?.textContent).toContain("1 review");
    expect(footer?.textContent).toContain("2 projects");
    await act(async () => root.unmount());
  });

  describe("project picker", () => {
    beforeEach(() => {
      useApp.setState({
        projects: [
          { id: "p1", name: "Backend API", non_git: false } as Project,
          { id: "p2", name: "Frontend Web", non_git: false } as Project,
          { id: "p3", name: "Infra", non_git: false } as Project,
        ],
      });
      useTodos.setState({ kindFilter: "issues" });
      for (const [id, name, n] of [["p1", "Backend API", 1], ["p2", "Frontend Web", 2], ["p3", "Infra", 3]] as const) {
        seed({ projectId: id, kind: "issues", scope: "assigned" }, issuesOk([issue(n, `Issue ${n} in ${name}`)]));
      }
    });

    const rowTitles = () =>
      Array.from(container.querySelectorAll('[data-testid="todos-row"]'), (r) => r.textContent ?? "");
    const triggerText = () => container.querySelector('[data-testid="todos-project-filter"]')?.textContent ?? "";

    it("shows only the rows of the picked projects, and names them on the trigger", async () => {
      useTodos.setState({ selectedProjectIds: ["p1", "p3"] });
      const root = await render();

      const rows = rowTitles();
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.includes("Issue 1 in Backend API"))).toBe(true);
      expect(rows.some((r) => r.includes("Issue 3 in Infra"))).toBe(true);
      expect(rows.some((r) => r.includes("Frontend Web"))).toBe(false);
      expect(triggerText()).toContain("2 projects");

      await act(async () => useTodos.getState().setSelectedProjectIds(["p2"]));
      expect(rowTitles()).toHaveLength(1);
      expect(triggerText()).toContain("Frontend Web");

      await act(async () => useTodos.getState().setSelectedProjectIds([]));
      expect(rowTitles()).toHaveLength(3);
      expect(triggerText()).toContain("All projects");

      await act(async () => root.unmount());
    });

    it("narrows to one project from a row's project chip", async () => {
      useTodos.setState({ selectedProjectIds: ["p1", "p2"] });
      const root = await render();

      const chip = Array.from(container.querySelectorAll('[data-testid="todos-row"] button')).find(
        (b) => b.getAttribute("title") === "Frontend Web"
      ) as HTMLButtonElement;
      await act(async () => chip.click());

      expect(useTodos.getState().selectedProjectIds).toEqual(["p2"]);
      expect(rowTitles()).toHaveLength(1);

      await act(async () => root.unmount());
    });

    it("falls back to every project when the picked ones were removed, without forgetting the pick", async () => {
      useTodos.setState({ selectedProjectIds: ["removed-project-id"] });
      const root = await render();

      expect(rowTitles()).toHaveLength(3);
      expect(triggerText()).toContain("All projects");
      // Derived, not written back: the saved pick stays as it was.
      expect(useTodos.getState().selectedProjectIds).toEqual(["removed-project-id"]);

      await act(async () => root.unmount());
    });

    it("keeps the saved pick through a render before the project list has loaded", async () => {
      useApp.setState({ projects: [] });
      useTodos.setState({ selectedProjectIds: ["p3"] });
      const root = await render();

      expect(useTodos.getState().selectedProjectIds).toEqual(["p3"]);

      await act(async () => {
        useApp.setState({
          projects: [
            { id: "p1", name: "Backend API", non_git: false } as Project,
            { id: "p3", name: "Infra", non_git: false } as Project,
          ],
        });
      });
      expect(triggerText()).toContain("Infra");
      expect(rowTitles()).toEqual([expect.stringContaining("Issue 3 in Infra")]);

      await act(async () => root.unmount());
    });

    it("ticks projects in the open menu one click at a time, and All clears them", async () => {
      const root = await render();
      const trigger = container.querySelector('[data-testid="todos-project-filter"]') as HTMLButtonElement;
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
      });

      const option = (id: string) =>
        document.querySelector(`[data-testid="todos-project-option"][data-project-id="${id}"]`) as HTMLElement;
      expect(option("p1")).not.toBeNull();
      expect(option("p1").getAttribute("role")).toBe("menuitemcheckbox");
      expect(option("p1").getAttribute("aria-checked")).toBe("false");

      await act(async () => option("p1").click());
      expect(useTodos.getState().selectedProjectIds).toEqual(["p1"]);
      // Still open after the tick, and the row reports the new state.
      expect(option("p1")).not.toBeNull();
      expect(option("p1").getAttribute("aria-checked")).toBe("true");

      await act(async () => option("p3").click());
      expect(useTodos.getState().selectedProjectIds).toEqual(["p1", "p3"]);

      await act(async () => option("p1").click());
      expect(useTodos.getState().selectedProjectIds).toEqual(["p3"]);
      expect(JSON.parse(localStorage.getItem("todosProjects") ?? "null")).toEqual(["p3"]);

      const all = document.querySelector('[data-testid="todos-project-all"]') as HTMLElement;
      await act(async () => all.click());
      expect(useTodos.getState().selectedProjectIds).toEqual([]);
      expect(localStorage.getItem("todosProjects")).toBeNull();

      await act(async () => root.unmount());
    });
  });
});
