// Todos view state: the filters, and how they turn into forge lists and rows.
// The lists themselves are fetched and cached by src/store/forgeLists.ts,
// shared with the New Task and Review PR dialogs. Does NOT write to useApp
// (bear traps 5 and 8).

import { create } from "zustand";
import { useApp } from "@/store/app";
import { forgeListKey, refreshForgeLists, type ForgeListEntry, type ForgeListQuery } from "@/store/forgeLists";
import { scoped } from "@/lib/profileScope";
import type { ForgeIssue, ForgePr, Project } from "@/lib/types";

export type TodoItem =
  | {
      id: string;
      kind: "issue";
      projectId: string;
      projectName: string;
      issue: ForgeIssue;
      action: "assigned" | "mentioned" | "open";
    }
  | {
      id: string;
      kind: "pr";
      projectId: string;
      projectName: string;
      pr: ForgePr;
      action: "review_requested" | "authored" | "open";
    };

export type KindFilter = "all" | "issues" | "prs";
export type ScopeFilter = "all" | "for_me" | "review" | "open";

export interface TodosState {
  /** The projects the view is narrowed to; empty is every project. Persisted,
   *  and read through `pickedProjects`, never directly: it can still name a
   *  project that has since been removed. */
  selectedProjectIds: string[];
  kindFilter: KindFilter;
  scopeFilter: ScopeFilter;
  searchQuery: string;

  setSelectedProjectIds: (ids: string[]) => void;
  setKindFilter: (kind: KindFilter) => void;
  setScopeFilter: (scope: ScopeFilter) => void;
  setSearchQuery: (query: string) => void;
  /** Fetch the lists the current filters read that are missing or past the
   *  TTL, in one batch (one GraphQL query per GitHub host). `force`
   *  (Refresh) fetches them all. */
  fetchVisibleTodos: (force?: boolean) => Promise<void>;
}

const LS_TODOS_PROJECTS = scoped("todosProjects");

/** Stored JSON back to a project id list. Anything malformed reads as every
 *  project: a filter that cannot be read must not hide the whole inbox. */
export function parseTodosProjects(raw: string | null): string[] {
  if (!raw) return [];
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(doc)) return [];
  return [...new Set(doc.filter((id): id is string => typeof id === "string" && id !== ""))];
}

function persistProjects(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(LS_TODOS_PROJECTS, JSON.stringify(ids));
    else localStorage.removeItem(LS_TODOS_PROJECTS);
  } catch { /* private mode */ }
}

/** The git projects the selection still names, in sidebar order. Empty means
 *  every project, and so does a selection naming none that exist.
 *
 *  Derived on every read and never written back. The saved ids are only
 *  checked against the project list here, because a launch reads the list
 *  AFTER this store: pruning on a write would see no projects yet and wipe
 *  the saved selection. */
export function pickedProjects(projects: Project[], selected: string[]): Project[] {
  if (!selected.length) return [];
  const ids = new Set(selected);
  return projects.filter((p) => !p.non_git && ids.has(p.id));
}

/** The git projects the view covers: the picked ones, or all of them. */
export function coveredProjects(projects: Project[], selected: string[]): Project[] {
  const picked = pickedProjects(projects, selected);
  return picked.length ? picked : projects.filter((p) => !p.non_git);
}

/** The forge lists a filter combination reads, per project. One table for
 *  the fetch and for the rows, so the two cannot ask for different things.
 *  No limit is given, so each is the IPC's default and the same query the
 *  dialogs make. */
export function todoQueries(projects: Project[], kind: KindFilter, scope: ScopeFilter): ForgeListQuery[] {
  const issues = kind !== "prs";
  const prs = kind !== "issues";
  const out: ForgeListQuery[] = [];
  for (const { id: projectId } of projects) {
    if (scope === "for_me") {
      if (issues) out.push({ projectId, kind: "issues", scope: "assigned" });
      if (prs) out.push({ projectId, kind: "prs", scope: "review" }, { projectId, kind: "prs", scope: "mine" });
    } else if (scope === "review") {
      if (prs) out.push({ projectId, kind: "prs", scope: "review" });
    } else {
      if (issues) out.push({ projectId, kind: "issues", scope: "all" }, { projectId, kind: "issues", scope: "assigned" });
      if (prs) {
        out.push(
          { projectId, kind: "prs", scope: "open" },
          { projectId, kind: "prs", scope: "review" },
          { projectId, kind: "prs", scope: "mine" },
        );
      }
    }
  }
  return out;
}

/** Which role wins when two lists carry the same issue or PR. */
const ACTION_WEIGHT: Record<TodoItem["action"], number> = {
  assigned: 5,
  review_requested: 4,
  authored: 3,
  mentioned: 2,
  open: 1,
};

export interface TodoRows {
  items: TodoItem[];
  errors: Array<{ key: string; message: string }>;
  /** A list the rows depend on has not answered yet. */
  pending: boolean;
}

/** The rows `queries` hold right now, one per issue or PR, named after the
 *  project as it is called NOW (a list fetched before a rename still reads
 *  right), plus the failures to explain. */
export function todoRows(
  queries: ForgeListQuery[],
  entries: Record<string, ForgeListEntry>,
  projects: Project[],
): TodoRows {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const byId = new Map<string, TodoItem>();
  const errors: TodoRows["errors"] = [];
  let pending = false;
  const add = (item: TodoItem) => {
    const prev = byId.get(item.id);
    if (!prev || ACTION_WEIGHT[item.action] > ACTION_WEIGHT[prev.action]) byId.set(item.id, item);
  };
  for (const q of queries) {
    const key = forgeListKey(q);
    const e = entries[key];
    if (!e || e.status === "loading") pending = true;
    if (!e) continue;
    if ((e.status === "error" || e.status === "unsupported") && e.errorMessage) {
      errors.push({ key, message: e.errorMessage });
    }
    if (!e.ok) continue;
    const projectId = q.projectId;
    const projectName = names.get(projectId) ?? "";
    if (q.kind === "issues" && "issues" in e.ok) {
      const action = q.scope === "assigned" ? "assigned" : q.scope === "mentions" ? "mentioned" : "open";
      for (const issue of e.ok.issues) {
        add({ id: `${projectId}:issue:${issue.number}`, kind: "issue", projectId, projectName, issue, action });
      }
    } else if (q.kind === "prs" && "prs" in e.ok) {
      const action = q.scope === "review" ? "review_requested" : q.scope === "mine" ? "authored" : "open";
      for (const pr of e.ok.prs) {
        add({ id: `${projectId}:pr:${pr.number}`, kind: "pr", projectId, projectName, pr, action });
      }
    }
  }
  return { items: Array.from(byId.values()), errors, pending };
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

// The setters only set: the view fetches whenever the lists its filters read
// change, which covers a filter change and a project list that arrives late.
export const useTodos = create<TodosState>((set, get) => ({
  selectedProjectIds: (() => {
    try { return parseTodosProjects(localStorage.getItem(LS_TODOS_PROJECTS)); } catch { return []; }
  })(),
  kindFilter: "all",
  scopeFilter: "for_me",
  searchQuery: "",

  setSelectedProjectIds: (ids) => {
    if (sameIds(get().selectedProjectIds, ids)) return;
    set({ selectedProjectIds: ids });
    persistProjects(ids);
  },

  setKindFilter: (kind) => {
    if (get().kindFilter === kind) return;
    set({ kindFilter: kind });
  },

  setScopeFilter: (scope) => {
    if (get().scopeFilter === scope) return;
    set({ scopeFilter: scope });
  },

  setSearchQuery: (query) => {
    if (get().searchQuery === query) return;
    set({ searchQuery: query });
  },

  fetchVisibleTodos: async (force = false) => {
    const { selectedProjectIds, kindFilter, scopeFilter } = get();
    const projects = coveredProjects(useApp.getState().projects, selectedProjectIds);
    await refreshForgeLists(todoQueries(projects, kindFilter, scopeFilter), force);
  },
}));
