// Spotlight helpers shared between the sidebar dropdown and the right-panel
// Spotlight tab. Keeps the "start + run handoff" logic in one place.

import { useApp } from "@/store/app";
import { useScriptRuns } from "@/store/scriptRuns";
import { workspaceSpotlightStart, workspaceRunScriptStream } from "@/lib/ipc";

/** Host run-state key for a workspace (member = "", kind = "run"). */
const runKey = (wsId: string) => `${wsId}::run`;

/** Start spotlight on `newWsId`. If a DIFFERENT workspace in the same project
 *  was spotlighted and had its run going, hand the run off: Rust stops the old
 *  one during the switch, and we (re)start it on the new target — which now
 *  executes at the repo root. Throws if the spotlight start itself fails
 *  (caller surfaces the message); the run handoff never throws. */
export async function startSpotlight(projectId: string, newWsId: string): Promise<void> {
  const prevWsId = useApp.getState().spotlightWsId[projectId];
  const prevRunActive = !!prevWsId
    && prevWsId !== newWsId
    && useScriptRuns.getState().runs[runKey(prevWsId)]?.status === "running";

  await workspaceSpotlightStart(newWsId);

  if (prevRunActive) {
    // Optimistically mark running so the UI shows Stop immediately; the
    // streamed output + exit then flow into this same (ws, run) slot.
    useScriptRuns.getState().start(newWsId, "run", "");
    workspaceRunScriptStream(newWsId, "run").catch(err =>
      console.error("spotlight run handoff failed:", err));
  }
}
