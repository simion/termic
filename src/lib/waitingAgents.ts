// Shared "waiting agent" logic behind the ⇧⌘A shortcut (issue #56) and the
// top-bar jump pill. A workspace is "waiting" when any of its terminal tabs
// is blocked on the user (unread.reason === "attention") or has finished its
// turn (workState === "done") — the same signal the sidebar highlights. Both
// entry points share this so jump order + the pill's count can never drift.
// Gated on the `settledHighlight` pref, so the whole feature disappears when
// that UI is turned off.

import { useApp, type AppState } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import type { TerminalTab } from "@/lib/types";

/** Awake workspaces in sidebar order: not archived + opened at least once
 *  (≥1 tab). MUST mirror useShortcuts' awakeWorkspaces so the pill and the
 *  keyboard jump cycle in the same order the user sees. */
function awakeWorkspaces(s: AppState) {
  return s.projects.flatMap(p =>
    s.workspaces.filter(w =>
      w.project_id === p.id && !w.archived && (s.tabs[w.id]?.length ?? 0) > 0,
    ),
  );
}

function wsIsWaiting(s: AppState, wsId: string): boolean {
  return (s.tabs[wsId] ?? []).some(
    t => t.type === "terminal" &&
      ((t as TerminalTab).unread?.reason === "attention" ||
       (t as TerminalTab).workState === "done"),
  );
}

/** Number of awake workspaces with an agent waiting on the user. 0 when the
 *  settledHighlight pref is off. Cheap enough (O(tabs)) to run as a Zustand
 *  selector — it only re-renders the subscriber when the count changes. */
export function waitingCount(s: AppState): number {
  if (!usePrefs.getState().settledHighlight) return 0;
  let n = 0;
  for (const w of awakeWorkspaces(s)) if (wsIsWaiting(s, w.id)) n++;
  return n;
}

/** Activate the next waiting agent after the active workspace (wraparound),
 *  landing on its waiting tab (attention preferred over done). Activating a
 *  workspace clears its attention, so calling this repeatedly walks the whole
 *  waiting queue. Returns true if it jumped, false when nothing was waiting
 *  or the pref is off (callers use it to decide whether to swallow a key). */
export function jumpToNextWaiting(): boolean {
  if (!usePrefs.getState().settledHighlight) return false;
  const s = useApp.getState();
  const ws = awakeWorkspaces(s);
  if (!ws.some(w => wsIsWaiting(s, w.id))) return false;
  const start = ws.findIndex(w => w.id === s.activeWorkspaceId);
  // Scan begins AFTER the current workspace, wrapping around.
  const ordered = start < 0 ? ws : [...ws.slice(start + 1), ...ws.slice(0, start + 1)];
  const target = ordered.find(w => wsIsWaiting(s, w.id));
  if (!target) return false;
  s.setActiveWorkspace(target.id);
  const tTabs = s.tabs[target.id] ?? [];
  const tab =
    tTabs.find(t => t.type === "terminal" && (t as TerminalTab).unread?.reason === "attention") ??
    tTabs.find(t => t.type === "terminal" && (t as TerminalTab).workState === "done");
  if (tab) s.setActiveTabId(target.id, tab.id);
  return true;
}
