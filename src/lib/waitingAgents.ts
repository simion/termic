// Shared "waiting agent" logic behind the ⇧⌘A shortcut (issue #56) and the
// top-bar jump pill. A task is "waiting" when any of its terminal tabs
// is blocked on the user (unread.reason === "attention") or has finished its
// turn (workState === "done") — the same signal the sidebar highlights. Both
// entry points share this so jump order + the pill's count can never drift.
// Gated on the `settledHighlight` pref, so the whole feature disappears when
// that UI is turned off.

import { useApp, type AppState } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import type { TerminalTab } from "@/lib/types";

/** Awake tasks in sidebar order: not archived + opened at least once
 *  (≥1 tab). MUST mirror useShortcuts' awakeTasks so the pill and the
 *  keyboard jump cycle in the same order the user sees. */
function awakeTasks(s: AppState) {
  return s.projects.flatMap(p =>
    s.tasks.filter(w =>
      w.project_id === p.id && !w.archived && (s.tabs[w.id]?.length ?? 0) > 0,
    ),
  );
}

function taskIsWaiting(s: AppState, taskId: string): boolean {
  return (s.tabs[taskId] ?? []).some(
    t => t.type === "terminal" &&
      ((t as TerminalTab).unread?.reason === "attention" ||
       (t as TerminalTab).workState === "done"),
  );
}

/** Number of awake tasks with an agent waiting on the user. 0 when the
 *  settledHighlight pref is off. Cheap enough (O(tabs)) to run as a Zustand
 *  selector — it only re-renders the subscriber when the count changes. */
export function waitingCount(s: AppState): number {
  if (!usePrefs.getState().settledHighlight) return 0;
  let n = 0;
  for (const w of awakeTasks(s)) if (taskIsWaiting(s, w.id)) n++;
  return n;
}

/** Activate the next waiting agent after the active task (wraparound),
 *  landing on its waiting tab (attention preferred over done). Activating a
 *  task clears its attention, so calling this repeatedly walks the whole
 *  waiting queue. Returns true if it jumped, false when nothing was waiting
 *  or the pref is off (callers use it to decide whether to swallow a key). */
export function jumpToNextWaiting(): boolean {
  if (!usePrefs.getState().settledHighlight) return false;
  const s = useApp.getState();
  const task = awakeTasks(s);
  if (!task.some(w => taskIsWaiting(s, w.id))) return false;
  const start = task.findIndex(w => w.id === s.activeTaskId);
  // Scan begins AFTER the current task, wrapping around.
  const ordered = start < 0 ? task : [...task.slice(start + 1), ...task.slice(0, start + 1)];
  const target = ordered.find(w => taskIsWaiting(s, w.id));
  if (!target) return false;
  s.setActiveTask(target.id);
  const tTabs = s.tabs[target.id] ?? [];
  const tab =
    tTabs.find(t => t.type === "terminal" && (t as TerminalTab).unread?.reason === "attention") ??
    tTabs.find(t => t.type === "terminal" && (t as TerminalTab).workState === "done");
  if (tab) s.setActiveTabId(target.id, tab.id);
  return true;
}
