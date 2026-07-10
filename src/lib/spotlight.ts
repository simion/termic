// Spotlight helpers shared between the sidebar dropdown and the right-panel
// Spotlight tab. Keeps the "start + run handoff" logic in one place.

import { useApp } from "@/store/app";
import { taskSpotlightStart, taskSpotlightStop, ptyKill } from "@/lib/ipc";
import { launchRunTabs, runTabsOf } from "@/lib/runTabs";

/** Start spotlight on `newTaskId`. The root run follows the spotlight: if any
 *  run in the same project was going, every other task's run is stopped
 *  and the run is relaunched on the new target, which now spawns at the repo
 *  root. Stopped tabs stay in place (exit overlay); they run in their own
 *  worktree if replayed.
 *  Throws if the spotlight start itself fails (caller surfaces the message);
 *  the run handoff never throws. */
export async function startSpotlight(projectId: string, newTaskId: string): Promise<void> {
  const st = useApp.getState();
  const prevTaskId = st.spotlightTaskId[projectId];
  if (prevTaskId === newTaskId) return;

  const otherTabs = st.tasks
    .filter(w => w.project_id === projectId && w.id !== newTaskId)
    .flatMap(w => runTabsOf(w.id));
  const ownTabs = runTabsOf(newTaskId);
  const wasRunning = [...otherTabs, ...ownTabs].some(t => !!t.ptyId);

  await taskSpotlightStart(newTaskId);
  // The store normally learns about the switch via spotlight://status
  // events; set it optimistically so the relaunched run's spawn-time cwd
  // check (TerminalPane) already sees the new target.
  useApp.getState().setSpotlight(projectId, newTaskId);

  for (const t of otherTabs) {
    if (t.ptyId) ptyKill(t.ptyId).catch(() => {});
  }
  if (wasRunning) {
    // launchRunTabs restarts the new target's existing Run tab (remount =
    // kill old PTY + respawn, now at the repo root) or creates one.
    launchRunTabs(newTaskId).catch(err =>
      console.error("spotlight run handoff failed:", err));
  }
}

/** Stop spotlight for `taskId`. The root run serves the spotlighted changes,
 *  so it stops with the spotlight; the Run tab stays (exit overlay) and a
 *  replay simply runs in the task's own worktree again. */
export async function stopSpotlight(taskId: string): Promise<void> {
  for (const t of runTabsOf(taskId)) {
    if (t.ptyId) ptyKill(t.ptyId).catch(() => {});
  }
  await taskSpotlightStop(taskId);
}
