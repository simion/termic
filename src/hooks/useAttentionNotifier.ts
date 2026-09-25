// Fires a macOS notification when a tab earns the unread state, but only for
// tabs that aren't currently active (don't ping the screen the user is on).
//
// Clicking a banner brings Termic forward and nothing else. It deliberately
// does NOT change the active task or tab: routing used to be driven by a
// focus-edge heuristic (any refocus within 15 s of a notification jumped to
// the tab it was about), which fired on plain cmd-Tabs and yanked people off
// whatever they were reading. Switching tasks is the user's call.

import { useEffect, useRef } from "react";
import { isUserWatching, useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { notify, onNotifyClick } from "@/lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TerminalTab } from "@/lib/types";
import { taskLabel } from "@/lib/taskLabel";
import { shouldNotifyUnread, UNREAD_PHRASE, unreadPhrase } from "@/lib/attentionNotify";
import { i18n } from "@/lib/i18n";

const DEBOUNCE_MS = 8000;

export function useAttentionNotifier() {
  const lastFiredRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const unsub = useApp.subscribe((state, prev) => {
      // Gate every notification on the user's pref. We still update unread
      // dots in the sidebar — only the OS notification is opt-in.
      const desktopNotifications = usePrefs.getState().desktopNotifications;
      if (!desktopNotifications) return;
      const taskIds = Object.keys(state.tabs);
      for (const taskId of taskIds) {
        const tabs = state.tabs[taskId] || [];
        const prevTabs = prev.tabs[taskId] || [];
        for (const t of tabs) {
          // Run/Setup tabs are managed dev-server surfaces, not agents.
          // Stopping one intentionally (including Spotlight handoff) should
          // never produce the generic "agent exited" OS notification.
          if (t.type === "terminal" && !!(t as TerminalTab).runTab) continue;
          // News, not truthiness. A `repeat` mark is the same turn's done
          // being re-asserted after the agent went back to work and took the
          // first one back, which is right for the sidebar dot and is not a
          // second thing to interrupt the user about (GH #276). It also must
          // not swallow the edge for a genuine needs-you that lands on top of
          // it - see lib/attentionNotify.ts for why that half matters.
          if (!shouldNotifyUnread(t, prevTabs.find(p => p.id === t.id))) continue;
          // Suppress notifications for ANY tab in the focused task —
          // even hidden tabs within it. The user explicitly asked for "never
          // watch and notify for work done" while focused on a task.
          // ...unless there is no window to be focused ON. A windowless
          // Termic is exactly when the notification is the ONLY way to learn
          // an agent finished, so suppressing it there is backwards. Shared
          // predicate so this cannot drift from fireDone / setWorkState.
          if (isUserWatching(taskId)) continue;
          const key = `${taskId}:${t.id}`;
          const now = Date.now();
          if ((lastFiredRef.current[key] || 0) + DEBOUNCE_MS > now) continue;
          lastFiredRef.current[key] = now;
          const w = state.tasks.find(w => w.id === taskId);
          const proj = w ? state.projects.find(p => p.id === w.project_id) : undefined;
          const reason = t.unread!.message?.trim() ? "" : unreadPhrase(t.unread!.reason);
          // Title = "project · task". The terminal/cli name was
          // noise — the body already says what happened.
          // The task half is whatever the sidebar calls it, so a banner
          // and the row it points at agree (GH #260).
          const wLabel = w ? taskLabel(w, usePrefs.getState().useBranchAsTaskName) : "";
          const taskFallback = i18n.t("backend:attentionNotify.taskFallback");
          const title = proj?.name
            ? `${proj.name} · ${wLabel || taskFallback}`
            : (wLabel || taskFallback);
          // The agent's own wording when it gave us one ("Claude needs your
          // permission" beats "agent needs your input"). Single path: the
          // terminal used to forward OSC 9 bodies itself AND mark unread,
          // which meant two banners for one event.
          notify(
            title,
            t.unread!.message?.trim() || (reason && i18n.t("backend:attentionNotify.agentBody", { phrase: reason })),
            { taskId, tabId: t.id },
            { sound: t.unread!.reason === "done" },
          ).catch(() => {});
        }
      }
    });
    return unsub;
  }, []);

  // Clicking a banner brings the window forward, full stop. The plugin still
  // hands us the {taskId, tabId} the notification was about, but we don't act
  // on it: an unread badge already marks where the work happened, and jumping
  // the user somewhere else (often mid-typing in another task) was the single
  // biggest source of "termic moved on its own" bugs.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await onNotifyClick(() => {
        try { getCurrentWindow().setFocus(); } catch {}
      });
    })();
    return () => { try { unlisten?.(); } catch {} };
  }, []);
}
