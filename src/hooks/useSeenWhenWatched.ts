// Looking at a tab counts as having seen its badge.
//
// `markAttention` marks unconditionally, focused tab included, and the badge
// then cleared only on a keystroke in that terminal or on activating the task
// again. So the common case left it stuck: the tab you are already on earns a
// badge while you are in another app, you come back, and because the tab never
// CHANGED nothing cleared it. Clicking away and back was the only way out,
// which is a strange thing to have to do to a badge that exists to tell you
// about the pane filling your screen.
//
// The rule was borrowed from iTerm2, where a bell marks a tab you may not be
// looking at. Termic puts the same mark on the tab that IS in front of you,
// where it answers a question nobody asked.
//
// Presence is the window being focused, not merely open. `isUserWatching` only
// excludes the windowless case (closed to the menu bar), so a Termic sitting
// behind someone's browser still counts as watched there. That is right for
// deciding whether to BADGE (you were away, you should be told) and wrong for
// deciding whether you have SEEN it, which is what this asks.
//
// One mark is exempt: ATTENTION. An agent blocked on a question is still
// blocked while you read it, so seeing it is not answering it, and its bell
// stays until you do (`unreadClearsOnSight`). A done dot on the same tab still
// clears on sight.

import { useEffect } from "react";
import { isTabOnScreenIn, useApp } from "@/store/app";
import { unreadClearsOnSight } from "@/lib/taskWorkState";
import { useUI } from "@/store/ui";
import type { AppState } from "@/store/app";

/** The badged tab that is on screen, as a stable string key
 *  (`taskId:tabId`) or "" for none. A primitive so the Zustand selector cannot
 *  churn: returning an object here would re-run every subscriber on each store
 *  write, which is the fanout trap this codebase measures for. */
export function watchedBadgedTab(s: AppState): string {
  const taskId = s.activeTaskId;
  if (!taskId) return "";
  const tabs = s.tabs[taskId] || [];
  // `unread` OR a done work state: they are separate fields feeding separate
  // badges, and a tab can hold either without the other (a keystroke clears
  // unread and leaves the dot). An attention bell alone is not a target: sight
  // does not clear it, and naming it would park the target on that tab.
  const t = tabs.find(t =>
    (unreadClearsOnSight(t.unread) || (t.type === "terminal" && (t.workState === "done" || !!t.delegatedWork?.partial))
      || (t.type === "scratch" && t.unseen))
    && isTabOnScreenIn(s, taskId, t.id));
  return t ? `${taskId}:${t.id}` : "";
}

/** Clears the badge on the tab the user is demonstrably looking at.
 *
 *  Instant, with no delay. This was a three second dwell, reasoning that
 *  focusing a window is not the same as reading the pane, so a cmd-tab THROUGH
 *  Termic should not eat a badge nobody saw. Instant is the better call: the
 *  badge sits on the tab filling the screen, so focusing the window IS showing
 *  it to you, and a dot that lingers while you are demonstrably looking at it
 *  reads as stuck rather than informative. A badge on any OTHER tab or task is
 *  untouched, which is where the signal actually matters. */
export function useSeenWhenWatched() {
  const target = useApp(watchedBadgedTab);
  // One source of truth, shared with `isUserWatchingIn`. A second copy of
  // "is the window focused" in this hook would drift from the one that decides
  // whether a badge is created at all, and the two disagreeing is precisely
  // how a badge gets created and instantly cleared.
  // Read SEPARATELY from the app-store target, not folded into it: a selector
  // over `useApp` does not re-run when `useUI` changes, so a target that
  // baked in focus would still say "nobody is looking" after the user came
  // back, and the badge would never clear.
  const present = useUI(s => s.windowFocused && !s.windowless);

  useEffect(() => {
    if (!target || !present) return;
    const [taskId, tabId] = target.split(":");
    const app = useApp.getState();
    // BOTH, because the two badges have different sources and clearing one
    // leaves the other on screen. The bell reads `unread.reason`, the blue done
    // dot reads `workState === "done"` (Sidebar's hasAttention vs hasDone, and
    // TabBar's showBell vs showDone). Clearing only `unread` left a finished
    // agent's dot up after the user came back, with clicking the sidebar item
    // (the one path that also writes the work state) the only way to shift it.
    const tab = (app.tabs[taskId] ?? []).find(t => t.id === tabId);
    if (unreadClearsOnSight(tab?.unread)) app.clearAttention(taskId, tabId);
    if (tab?.type === "terminal" && tab.workState === "done") {
      app.setWorkState(taskId, tabId, "idle", "seen: on screen in a focused window");
    }
    // Partially done: the news that some delegated work came back is read
    // now. The delegated state itself stays, since the rest still runs.
    if (tab?.type === "terminal" && tab.delegatedWork?.partial) {
      app.patchTab(taskId, tabId, { delegatedWork: { ...tab.delegatedWork, partial: false } });
    }
    // A pad an agent wrote while you were away: on screen now, so seen.
    if (tab?.type === "scratch" && tab.unseen) app.patchTab(taskId, tabId, { unseen: false });
    // No cleanup: nothing is scheduled. Clearing makes `target` empty, so this
    // re-runs once and returns at the guard.
  }, [target, present]);
}
