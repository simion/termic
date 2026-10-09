// Pinned ("marked") folders in the right-panel file tree. The user marks the
// folders they keep diving into (a dist/ release dir, a hot source dir) and
// the tree grows a chip bar over it: one click expands the path, scrolls to
// the folder and ring-highlights it (the same reveal the editor breadcrumb
// uses, which already handles dirs).
//
// Scope is the PROJECT, not the task: tasks are git worktrees of the same
// project, and the task-root-relative path of "the folder I care about" is
// stable across worktrees. Mark once in any task, every task of the project
// gets the chip. The stored value is the rel path, never an absolute one.
//
// Rename / delete policy:
// - Renaming a folder REMAPS its pin (and every pin beneath it) in place, so
//   the chip follows the folder.
// - Deleting a folder KEEPS the pin on purpose: the common delete is a build
//   output dir that comes straight back, and a chip pointing at a missing dir
//   reveal-no-ops silently, exactly like revealing a deleted file from an
//   editor breadcrumb.
//
// Pins are keyed by project id, so the localStorage key is PROFILE-SCOPED
// (project ids are not disjoint across profiles — see lib/profileScope.ts).
// Entries die only with their project: prune() runs from app.loadAll, the
// same housekeeping pass that prunes fileViewed by task liveness.

import { create } from "zustand";
import { scoped } from "@/lib/profileScope";

const LS = scoped("pinnedFolders");
const LS_SECTION = "pinnedSectionCollapsed";

/** Ref-stable default for `byProject[projectId]` selectors, so a project with
 *  no pins doesn't hand subscribers a fresh array on every store read. */
export const EMPTY_PINS: readonly string[] = Object.freeze([]);

/** projectId → pinned task-root-relative paths, in pin (insertion) order. */
type ByProject = Record<string, string[]>;

function load(): ByProject {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function save(byProject: ByProject) {
  try {
    localStorage.setItem(LS, JSON.stringify(byProject));
  } catch {}
}

function loadSectionCollapsed(): boolean {
  try { return localStorage.getItem(LS_SECTION) === "1"; } catch { return false; }
}

interface PinnedFoldersState {
  byProject: ByProject;
  /** The tree's Pinned section folded to its header row. Machine-level UI
   *  state (not profile data), so a bare localStorage key. */
  sectionCollapsed: boolean;
  setSectionCollapsed: (v: boolean) => void;
  pin: (projectId: string, rel: string) => void;
  unpin: (projectId: string, rel: string) => void;
  toggle: (projectId: string, rel: string) => void;
  /** Follow a folder rename: replace the exact pin and rewrite every pin
   *  beneath it (`oldRel/…` → `newRel/…`), keeping order. Renaming onto a
   *  path that is already pinned dedupes to one pin. */
  remap: (projectId: string, oldRel: string, newRel: string) => void;
  /** Drop whole project maps for projects that no longer exist. Project
   *  liveness is the only thing prune may consult — the same rule as
   *  fileViewed's task-liveness-only prune (GH #248). */
  prune: (liveProjectIds: Set<string>) => void;
}

export const usePinnedFolders = create<PinnedFoldersState>((set) => ({
  byProject: load(),
  sectionCollapsed: loadSectionCollapsed(),

  setSectionCollapsed: (v) =>
    set((s) => {
      if (s.sectionCollapsed === v) return s;
      try { localStorage.setItem(LS_SECTION, v ? "1" : "0"); } catch {}
      return { sectionCollapsed: v };
    }),

  pin: (projectId, rel) =>
    set((s) => {
      const cur = s.byProject[projectId];
      if (cur?.includes(rel)) return s;
      const byProject = { ...s.byProject, [projectId]: [...(cur ?? []), rel] };
      save(byProject);
      return { byProject };
    }),

  unpin: (projectId, rel) =>
    set((s) => {
      const cur = s.byProject[projectId];
      if (!cur?.includes(rel)) return s;
      // Removing a project's LAST pin drops its entry outright: an empty
      // array in the record (and in localStorage) is a leak that would grow
      // one key per project the user ever pinned anything in.
      const next = cur.filter(p => p !== rel);
      const byProject = { ...s.byProject };
      if (next.length) byProject[projectId] = next;
      else delete byProject[projectId];
      save(byProject);
      return { byProject };
    }),

  toggle: (projectId, rel) =>
    set((s) => {
      const cur = s.byProject[projectId] ?? [];
      const next = cur.includes(rel) ? cur.filter(p => p !== rel) : [...cur, rel];
      const byProject = { ...s.byProject };
      if (next.length) byProject[projectId] = next;
      else delete byProject[projectId];
      save(byProject);
      return { byProject };
    }),

  remap: (projectId, oldRel, newRel) =>
    set((s) => {
      const cur = s.byProject[projectId];
      if (!cur) return s;
      const oldPrefix = `${oldRel}/`;
      const next = cur.map(p =>
        p === oldRel ? newRel : p.startsWith(oldPrefix) ? `${newRel}/${p.slice(oldPrefix.length)}` : p,
      );
      // Renaming onto an already-pinned path would leave two identical pins;
      // Set iteration preserves order, so dedupe keeps the first.
      const deduped = [...new Set(next)];
      // Nothing actually mapped (rename of an unpinned folder), or the map is
      // content-identical: keep the old array ref so subscribers don't churn.
      // The length check matters: [a, b] with a renamed onto b dedupes to
      // [b], which matches cur position-by-position but is SHORTER — falling
      // for it would drop the remap and keep the stale `a` pin.
      if (deduped.length === cur.length && deduped.every((p, i) => p === cur[i])) return s;
      const byProject = { ...s.byProject, [projectId]: deduped };
      save(byProject);
      return { byProject };
    }),

  prune: (liveProjectIds) =>
    set((s) => {
      const dead = Object.keys(s.byProject).filter(id => !liveProjectIds.has(id));
      if (dead.length === 0) return s;
      const byProject = { ...s.byProject };
      for (const id of dead) delete byProject[id];
      save(byProject);
      return { byProject };
    }),
}));
