// "Mark as viewed" state for the Git panel's changed-file rows (GH issue
// #42). GitHub-style: each changed file gets a checkbox you tick once you've
// finished reviewing it, so attention naturally falls on the files you
// haven't looked at yet.
//
// Persisted to localStorage (survives restarts, unlike the transient
// review-comments store) and keyed by workspace, then by the
// workspace-relative file path (the same prefixed path a diff tab uses, so
// it's unique across multi-repo members).
//
// The stored value is the file's content fingerprint (GitFile.fp,
// `mtime:len`) at the moment it was marked. A file counts as "viewed" only
// when its CURRENT fingerprint still equals the stored one — so the instant
// the agent touches the file again, the fingerprint moves and the mark
// clears itself. No watcher needed: every git-status refetch carries a fresh
// fp, so isViewed() re-evaluates on its own.

import { create } from "zustand";

const LS = "fileViewed";

/** wsId → (workspace-relative path → fingerprint when marked viewed). */
type ByWs = Record<string, Record<string, string>>;

function load(): ByWs {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function save(byWs: ByWs) {
  try {
    localStorage.setItem(LS, JSON.stringify(byWs));
  } catch {}
}

interface FileViewedState {
  byWs: ByWs;
  /** Tick / untick a file. Ticking stashes its current fingerprint. */
  toggle: (wsId: string, path: string, fp: string) => void;
  /** Drop entries for paths that no longer have changes (committed /
   *  discarded), keeping localStorage from growing without bound. */
  prune: (wsId: string, validPaths: Set<string>) => void;
}

export const useFileViewed = create<FileViewedState>((set) => ({
  byWs: load(),

  toggle: (wsId, path, fp) =>
    set((s) => {
      const cur = { ...(s.byWs[wsId] ?? {}) };
      if (cur[path] === fp) delete cur[path];
      else cur[path] = fp;
      const byWs = { ...s.byWs, [wsId]: cur };
      save(byWs);
      return { byWs };
    }),

  prune: (wsId, validPaths) =>
    set((s) => {
      const cur = s.byWs[wsId];
      if (!cur) return s;
      const next: Record<string, string> = {};
      let changed = false;
      for (const [p, fp] of Object.entries(cur)) {
        if (validPaths.has(p)) next[p] = fp;
        else changed = true;
      }
      if (!changed) return s;
      const byWs = { ...s.byWs, [wsId]: next };
      save(byWs);
      return { byWs };
    }),
}));

/** Subscribe to whether a specific file is currently marked viewed. A file
 *  is viewed only when its stashed fingerprint still matches `fp`, so an
 *  agent edit (fp moves) auto-clears the mark. */
export function useIsViewed(wsId: string, path: string, fp: string): boolean {
  return useFileViewed((s) => s.byWs[wsId]?.[path] === fp && fp !== "");
}
