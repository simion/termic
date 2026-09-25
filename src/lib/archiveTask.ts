// Archive-a-task flow, shared by the sidebar row menu and the unified
// bar button so the post-archive state refresh can't drift between them.
//
// Issue #24: the sidebar didn't update after archiving until an app reload.
// Cause: `task_archive` marks the task `archived` and SAVES it
// before its best-effort cleanup (git worktree remove / rmdir / branch -D /
// symlink unlink). Any of those steps failing makes the command reject —
// even though the archive itself already happened. The call sites awaited it
// inside a try/catch and let that rejection skip the `loadAll()` refetch, so
// the now-archived task lingered in the sidebar until the next reload.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { useArchivingTasks } from "@/store/archivingTasks";
import { taskArchive } from "@/lib/ipc";
import { i18n } from "@/lib/i18n";
import { openPrArchiveWarning } from "@/store/pr";
import type { ConfirmCheckbox } from "@/store/ui";
import type { Task } from "@/lib/types";
import { taskLabel } from "@/lib/taskLabel";

/** Archive `taskId`, then ALWAYS refresh the store — even if the IPC rejects on
 *  a best-effort cleanup error, because the task is already persisted as
 *  archived and the sidebar must reflect that immediately (issue #24). A
 *  cleanup failure is reported as a toast, never as a rejection (issue #246).
 *  The caller owns the confirm dialog and the "archiving" row state. */
export async function archiveAndRefresh(taskId: string, deleteBranch: boolean): Promise<void> {
  try {
    await taskArchive(taskId, deleteBranch);
  } catch (err) {
    // Cleanup warning (the archive flag is still persisted). Surface it for
    // debugging but don't let it strand the sidebar.
    console.error("archive cleanup reported errors:", err);
    // ...and tell the user, because nothing else will (GH #246). The archive
    // runs in the background now, so a worktree that failed to remove would
    // otherwise just vanish from the sidebar with the directory still on
    // disk and no sign anything went wrong. Read the name BEFORE loadAll
    // drops the task.
    const name = useApp.getState().tasks.find(t => t.id === taskId)?.name;
    useUI.getState().pushToast(
      name
        ? i18n.t("backend:archiveTask.cleanupFailedNamed", { name, error: String(err) })
        : i18n.t("backend:archiveTask.cleanupFailed", { error: String(err) }),
      "error",
      { ttlMs: 10000 },
    );
  }
  // The archived task's view is going away — deselect it if it was active
  // so the main pane falls back to the dashboard.
  if (useApp.getState().activeTaskId === taskId) {
    useApp.getState().setActiveTask(null);
  }
  await useApp.getState().loadAll();
}

/** The prompt copy for archiving `w`, split out so the three shapes an archive
 *  can take (main checkout, multi-repo composition, plain worktree) are
 *  readable side by side. Main-checkout entries get NO checkbox: nothing about
 *  them is a worktree branch, so there is no branch to offer deleting.
 *
 *  `deleteBranchDefault` is the Settings toggle. It seeds the checkbox rather
 *  than deciding anything: the dialog is still the answer for THIS archive, so
 *  a user who keeps branches by default can tick the box once without changing
 *  the setting, and one who deletes them by default does not have to re-tick it
 *  every time. */
function archivePrompt(w: Task, deleteBranchDefault: boolean): { message: string; confirmLabel: string; checkbox?: ConfirmCheckbox } {
  // Open-PR warning leads the copy (empty string for a task with no PR, or
  // one already merged/closed) so the user sees it before the worktree
  // removal details - archiving never touches the remote PR/MR.
  const prWarning = openPrArchiveWarning(w.id);
  if (w.is_main_checkout) {
    return {
      message: prWarning + i18n.t("backend:archiveTask.mainMessage"),
      confirmLabel: i18n.t("backend:archiveTask.mainConfirm"),
    };
  }
  if ((w.composition?.length ?? 0) > 0) {
    const members = (w.composition ?? []).filter(m => m.mode === "worktree").map(m => m.dir_name);
    return {
      message: prWarning + i18n.t("backend:archiveTask.compositionMessage", {
        members: members.join(", ") || i18n.t("backend:archiveTask.compositionNone"),
      }),
      confirmLabel: i18n.t("backend:archiveTask.compositionConfirm"),
      checkbox: { label: i18n.t("backend:archiveTask.deleteBranches"), defaultValue: deleteBranchDefault },
    };
  }
  return {
    message: prWarning + i18n.t("backend:archiveTask.worktreeMessage"),
    confirmLabel: i18n.t("backend:archiveTask.worktreeConfirm"),
    checkbox: { label: i18n.t("backend:archiveTask.deleteBranch"), branchName: w.branch || undefined, defaultValue: deleteBranchDefault },
  };
}

/** Confirm + archive a task. The ONLY archive entry point in the UI
 *  (sidebar row menu, unified bar button, command palette) so
 *  the copy, the delete-branch checkbox and the "Show this every time" opt-out
 *  can't drift between them. No-op if the user cancels. */
export async function confirmAndArchive(w: Task): Promise<void> {
  const ui = useUI.getState();
  const prefs = usePrefs.getState();
  // Name the task the way the UI the user clicked from names it (GH #260).
  const label = taskLabel(w, prefs.useBranchAsTaskName);
  const { message, confirmLabel, checkbox } = archivePrompt(w, prefs.archiveDeleteBranch);

  // Fast path: confirmation is off, so the Settings toggle IS the answer -
  // never for a main checkout, which has no worktree branch and never showed
  // the checkbox.
  if (!prefs.confirmBeforeArchiveTask) {
    const done = startArchive(w.id, !w.is_main_checkout && prefs.archiveDeleteBranch);
    // No dialog was shown, so the toast is the only feedback that anything
    // happened — and the only pointer back to where the task went. Pushed
    // BEFORE awaiting: the archive can take tens of seconds (script +
    // node_modules rmdir) and the confirmation belongs to the click.
    ui.pushToast(i18n.t("backend:archiveTask.archivedToast", { name: label }), "info", {
      ttlMs: 6000,
      action: { label: i18n.t("backend:archiveTask.history"), onClick: () => useApp.getState().setView("history") },
    });
    await done;
    return;
  }

  const ok = await ui.askConfirm({
    title: i18n.t("backend:archiveTask.confirmTitle", { name: label }),
    message,
    confirmLabel,
    // Not red: archiving is recoverable (History keeps the task, git keeps
    // the branch). The red button is reserved for the genuinely one-way
    // actions, e.g. History's "Empty archive" (issue #102).
    destructive: false,
    checkbox,
    dontAskAgain: true,
  });
  const res = typeof ok === "boolean" ? { confirmed: ok, checked: false, dontAskAgain: false } : ok;
  // Persist the opt-out only when the user actually went through with the
  // archive. ConfirmDialog reports the checkbox state at dismissal, so ticking
  // a box and then hitting Escape / Cancel still arrives as checked=true;
  // gating on `confirmed` stops a backed-out archive from silently disabling
  // every future confirmation (and arming a branch delete with it).
  if (res.confirmed && res.dontAskAgain) {
    prefs.setConfirmBeforeArchiveTask(false);
    // A main-checkout dialog has no checkbox, so its `checked` is a
    // meaningless false - leave the remembered branch choice alone.
    if (!w.is_main_checkout) prefs.setArchiveDeleteBranch(res.checked);
  }
  if (!res.confirmed) return;
  await startArchive(w.id, res.checked);
}

/** Start the archive and get out of the way (GH #246). Shared by the two
 *  confirmAndArchive paths (so they can't diverge on the refresh) and by the
 *  CLI's archive RPC, which gets the same sidebar treatment for free.
 *
 *  This used to raise `ui.setBusy`, a `fixed inset-0` click-blocker over the
 *  whole window, and hold it until `task_archive` AND the `loadAll` refetch
 *  had returned. That is the wrong blast radius for a per-task operation, and
 *  a long one: the archive script runs, then `git worktree remove`, then
 *  `fs::remove_dir_all` over a node_modules-sized tree. Agents in the other
 *  tasks keep working the whole time and the user could not see them, switch
 *  to one, or answer a permission prompt. Same fix as GH #242 at the other
 *  end of a task's life.
 *
 *  Everything the user can see now happens synchronously with the click: the
 *  task is deselected (its pane is going away, and its worktree is being
 *  deleted underneath it) and its sidebar row flips to the inert "Archiving…"
 *  spinner state until `loadAll` drops it. The returned promise settles when
 *  the archive does — for callers that care (specs, the CLI), NOT for the UI.
 *
 *  The returned promise never rejects: `archiveAndRefresh` turns a cleanup
 *  failure into a toast. */
export function startArchive(taskId: string, deleteBranch: boolean): Promise<void> {
  const archiving = useArchivingTasks.getState();
  // Double-fire guard. Without the modal overlay, the row's menu, the unified
  // bar button and the command palette are all still reachable while the
  // first archive is in flight.
  if (archiving.ids[taskId]) return Promise.resolve();
  archiving.begin(taskId);
  // Deselect NOW rather than after the IPC returns: the task's TaskView is in
  // front of the user with a worktree that is being removed under it.
  if (useApp.getState().activeTaskId === taskId) useApp.getState().setActiveTask(null);
  return archiveAndRefresh(taskId, deleteBranch).finally(() => {
    useArchivingTasks.getState().end(taskId);
  });
}
