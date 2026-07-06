// Spotlight helpers shared between the sidebar dropdown and the right-panel
// Spotlight tab. Keeps the "start + run handoff" logic in one place.

import { useApp } from "@/store/app";
import { workspaceSpotlightStart, workspaceSpotlightStop, ptyKill } from "@/lib/ipc";
import { launchRunTabs, runTabsOf } from "@/lib/runTabs";

/** Start spotlight on `newWsId`. The root run follows the spotlight: if any
 *  run in the same project was going, every other workspace's run is stopped
 *  and the run is relaunched on the new target, which now spawns at the repo
 *  root. Stopped tabs stay in place (exit overlay); they run in their own
 *  worktree if replayed.
 *  Throws if the spotlight start itself fails (caller surfaces the message);
 *  the run handoff never throws. */
export async function startSpotlight(projectId: string, newWsId: string): Promise<void> {
  const st = useApp.getState();
  const prevWsId = st.spotlightWsId[projectId];
  if (prevWsId === newWsId) return;

  const otherTabs = st.workspaces
    .filter(w => w.project_id === projectId && w.id !== newWsId)
    .flatMap(w => runTabsOf(w.id));
  const ownTabs = runTabsOf(newWsId);
  const wasRunning = [...otherTabs, ...ownTabs].some(t => !!t.ptyId);

  await workspaceSpotlightStart(newWsId);
  // The store normally learns about the switch via spotlight://status
  // events; set it optimistically so the relaunched run's spawn-time cwd
  // check (TerminalPane) already sees the new target.
  useApp.getState().setSpotlight(projectId, newWsId);

  for (const t of otherTabs) {
    if (t.ptyId) ptyKill(t.ptyId).catch(() => {});
  }
  if (wasRunning) {
    // launchRunTabs restarts the new target's existing Run tab (remount =
    // kill old PTY + respawn, now at the repo root) or creates one.
    launchRunTabs(newWsId).catch(err =>
      console.error("spotlight run handoff failed:", err));
  }
}

/** Stop spotlight for `wsId`. The root run serves the spotlighted changes,
 *  so it stops with the spotlight; the Run tab stays (exit overlay) and a
 *  replay simply runs in the workspace's own worktree again. */
export async function stopSpotlight(wsId: string): Promise<void> {
  for (const t of runTabsOf(wsId)) {
    if (t.ptyId) ptyKill(t.ptyId).catch(() => {});
  }
  await workspaceSpotlightStop(wsId);
}
