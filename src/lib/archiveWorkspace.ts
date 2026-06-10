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
import { workspaceArchive } from "@/lib/ipc";

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
