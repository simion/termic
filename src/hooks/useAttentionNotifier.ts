// Fires a macOS notification when a tab earns the unread state, but only for
// tabs that aren't currently active (don't ping the screen the user is on).
//
// Click-to-route: macOS osascript notifications don't expose a click callback,
// so we use a focus-edge heuristic — when the window regains focus within
// ROUTE_WINDOW_MS of a notification we just fired, jump to that (task,
// tab). False positives are bounded: cmd-tabbing back without clicking the
// notification also routes, but only if there's a pending unread tab from the
// last few seconds. In practice that matches user intent (the unread tab IS
// what they came back to look at).

import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { notify, onNotifyClick } from "@/lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TerminalTab } from "@/lib/types";

const DEBOUNCE_MS = 8000;
const ROUTE_WINDOW_MS = 15_000;

interface PendingRoute { taskId: string; tabId: string; firedAt: number; }

export function useAttentionNotifier() {
  const lastFiredRef = useRef<Record<string, number>>({});
  // Most-recent (taskId, tabId) we sent a notification about — consumed
  // by the focus listener below.
  const lastRouteRef = useRef<PendingRoute | null>(null);

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
          if (!t.unread) continue;
          const wasUnread = prevTabs.find(p => p.id === t.id)?.unread;
          if (wasUnread) continue;
          // Suppress notifications for ANY tab in the focused task —
          // even hidden tabs within it. The user explicitly asked for "never
          // watch and notify for work done" while focused on a task.
          if (state.activeTaskId === taskId) continue;
          const key = `${taskId}:${t.id}`;
          const now = Date.now();
          if ((lastFiredRef.current[key] || 0) + DEBOUNCE_MS > now) continue;
          lastFiredRef.current[key] = now;
          const w = state.tasks.find(w => w.id === taskId);
          const proj = w ? state.projects.find(p => p.id === w.project_id) : undefined;
          const reason =
            t.unread.reason === "bell" ? "wants input"
            : t.unread.reason === "exit" ? "exited"
            : t.unread.reason === "done" ? "finished"
            : t.unread.reason === "attention" ? "needs your input"
            : "is idle";
          // Title = "project · task". The terminal/cli name was
          // noise — the body already says what happened.
          const title = proj?.name
            ? `${proj.name} · ${w?.name || "task"}`
            : (w?.name || "task");
          notify(
            title,
            `agent ${reason}`,
            { taskId, tabId: t.id },
            { sound: t.unread.reason === "done" },
          ).catch(() => {});
          lastRouteRef.current = { taskId, tabId: t.id, firedAt: now };
        }
      }
    });
    return unsub;
  }, []);

  // Direct click router: the notification plugin fires onAction when the
  // user clicks a banner, carrying the {taskId, tabId} we stamped into its
  // extra payload. This is the reliable path — it works even when the app
  // window was already foregrounded (the focus-edge heuristic below only
  // fires on a background→foreground transition, so it misses clicks while
  // termic is already visible on another task). Brings the window
  // forward and routes to the originating tab.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await onNotifyClick(({ taskId, tabId }) => {
        const state = useApp.getState();
        const task = state.tasks.find(w => w.id === taskId);
        if (!task) return;
        const t = (state.tabs[taskId] || []).find(x => x.id === tabId);
        if (!t) return;
        state.setActiveTask(taskId);
        state.setActiveTabId(taskId, tabId);
        try { getCurrentWindow().setFocus(); } catch {}
      });
    })();
    return () => { try { unlisten?.(); } catch {} };
  }, []);

  // Focus-driven router: when the window regains focus shortly after a
  // notification fire, set the active task + tab.
  //
  // Two route sources fed in:
  //   1. lastRouteRef — set when markAttention transitions a tab to
  //      unread (BEL, attention, exit, idle-heuristic). Local to this
  //      hook.
  //   2. useUI().notifyRoute — set imperatively when ANY component
  //      forwards an OS notification (e.g. TerminalPane's OSC 9 / 777
  //      handler). Lives in the store so OSC 9 banners — which we
  //      don't route through markAttention — still get the
  //      click-through behavior.
  //
  // Picking the winner: whichever was fired more recently. Once
  // consumed, both are cleared. Stale routes (older than
  // ROUTE_WINDOW_MS) are dropped silently.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          const ui = useUI.getState();
          const notifyRoute = ui.notifyRoute;       // OSC 9 / 777 — agent-authored notify
          const attnRoute = lastRouteRef.current;   // markAttention transition
          const state = useApp.getState();
          const now = Date.now();
          // Try the more recent route first, then fall back. Routes
          // get vetted differently:
          //   - OSC route: agent explicitly asked for a notification,
          //     route as long as the tab still exists. The notify is
          //     the user's reason for refocusing.
          //   - Attention route: only route if the unread is STILL
          //     standing. If the user already addressed it (e.g. came
          //     back via a different path and cleared it), don't yank
          //     them to a tab they're done with — a plain cmd-Tab back
          //     within 15 s should NOT trigger this.
          const tryRoute = (route: typeof attnRoute, kind: "osc" | "attn"): boolean => {
            if (!route) return false;
            if (now - route.firedAt > ROUTE_WINDOW_MS) return false;
            const task = state.tasks.find(w => w.id === route.taskId);
            if (!task) return false;
            const t = (state.tabs[route.taskId] || []).find(x => x.id === route.tabId);
            if (!t) return false;
            if (kind === "attn" && !t.unread) return false;
            state.setActiveTask(route.taskId);
            state.setActiveTabId(route.taskId, route.tabId);
            return true;
          };
          // Pick by recency.
          const oscIsNewer =
            notifyRoute && (!attnRoute || notifyRoute.firedAt >= attnRoute.firedAt);
          const routed = oscIsNewer
            ? (tryRoute(notifyRoute, "osc") || tryRoute(attnRoute, "attn"))
            : (tryRoute(attnRoute, "attn") || tryRoute(notifyRoute, "osc"));
          void routed;
          // Clear both regardless: either we consumed them or they're
          // stale. A fresh notification within the next window will
          // re-seed.
          lastRouteRef.current = null;
          ui.setNotifyRoute(null);
        });
      } catch (e) {
        console.warn("notification focus router setup failed:", e);
      }
    })();
    return () => { try { unlisten?.(); } catch {} };
  }, []);
}
