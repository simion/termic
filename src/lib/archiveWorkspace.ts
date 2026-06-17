// Archive-a-workspace flow, shared by the sidebar row menu and the unified
// bar button so the post-archive state refresh can't drift between them.
//
// Issue #24: the sidebar didn't update after archiving until an app reload.
// Cause: `workspace_archive` marks the workspace `archived` and SAVES it
// before its best-effort cleanup (git worktree remove / rmdir / branch -D /
// symlink unlink). Any of those steps failing makes the command reject —
// even though the archive itself already happened. The call sites awaited it
// inside a try/catch and let that rejection skip the `loadAll()` refetch, so
// the now-archived workspace lingered in the sidebar until the next reload.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { workspaceArchive } from "@/lib/ipc";
import type { Workspace } from "@/lib/types";

/** Archive `wsId`, then ALWAYS refresh the store — even if the IPC rejects on
 *  a best-effort cleanup error, because the workspace is already persisted as
 *  archived and the sidebar must reflect that immediately (issue #24). The
 *  caller owns the confirm dialog + busy overlay. */
export async function archiveAndRefresh(wsId: string, deleteBranch: boolean): Promise<void> {
  try {
    await workspaceArchive(wsId, deleteBranch);
  } catch (err) {
    // Cleanup warning (the archive flag is still persisted). Surface it for
    // debugging but don't let it strand the sidebar.
    console.error("archive cleanup reported errors:", err);
  }
  // The archived workspace's view is going away — deselect it if it was active
  // so the main pane falls back to the dashboard.
  if (useApp.getState().activeWorkspaceId === wsId) {
    useApp.getState().setActiveWorkspace(null);
  }
  await useApp.getState().loadAll();
}

/** Confirm + archive a workspace, with the SAME prompt copy + delete-branch
 *  checkbox the sidebar row's "Archive" menu item uses, plus the busy overlay.
 *  Shared so the command palette's "Archive <name>" can't drift from the
 *  sidebar. No-op if the user cancels. */
export async function confirmAndArchive(w: Workspace): Promise<void> {
  const ui = useUI.getState();
  const memberWorktrees = (w.composition ?? []).filter(m => m.mode === "worktree");
  const ok = await ui.askConfirm({
    title: `Archive "${w.name}"?`,
    message: w.is_repo_root
      ? "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched, so you can re-open it any time. Any agent running here will be terminated."
      : (w.composition?.length ?? 0) > 0
      ? `Branches stay in git, so you can recreate the workspace later. This removes: the host worktree + every member worktree (${memberWorktrees.map(m => m.dir_name).join(", ") || "none"}), plus any member symlinks to live checkouts. Any running agent will be terminated.`
      : "The branch stays in git, so you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory and terminates any running agent. Can't be undone from inside Termic.",
    confirmLabel: "Archive",
    destructive: true,
    checkbox: w.is_repo_root ? undefined : (w.composition?.length ?? 0) > 0
      ? { label: "Delete the git branches", defaultValue: false }
      : { label: "Delete the git branch:", branchName: w.branch || undefined, defaultValue: false },
  });
  const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
  const deleteBranch = typeof ok === "boolean" ? false : ok.checked;
  if (!confirmed) return;
  ui.setBusy(`Archiving "${w.name}"…`);
  try { await archiveAndRefresh(w.id, deleteBranch); }
  finally { ui.setBusy(null); }
}
