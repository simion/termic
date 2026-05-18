// Fires a macOS notification when a tab earns the unread state, but only for
// tabs that aren't currently active (don't ping the screen the user is on).
//
// Click-to-route: macOS osascript notifications don't expose a click callback,
// so we use a focus-edge heuristic — when the window regains focus within
// ROUTE_WINDOW_MS of a notification we just fired, jump to that (workspace,
// tab). False positives are bounded: cmd-tabbing back without clicking the
// notification also routes, but only if there's a pending unread tab from the
// last few seconds. In practice that matches user intent (the unread tab IS
// what they came back to look at).

import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { notify } from "@/lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DEBOUNCE_MS = 8000;
const ROUTE_WINDOW_MS = 15_000;

interface PendingRoute { wsId: string; tabId: string; firedAt: number; }

export function useAttentionNotifier() {
  const lastFiredRef = useRef<Record<string, number>>({});
  // Most-recent (wsId, tabId) we sent a notification about — consumed
  // by the focus listener below.
  const lastRouteRef = useRef<PendingRoute | null>(null);

  useEffect(() => {
    const unsub = useApp.subscribe((state, prev) => {
      // Gate every notification on the user's pref. We still update unread
      // dots in the sidebar — only the OS notification is opt-in.
      if (!usePrefs.getState().desktopNotifications) return;
      const wsIds = Object.keys(state.tabs);
      for (const wsId of wsIds) {
        const tabs = state.tabs[wsId] || [];
        const prevTabs = prev.tabs[wsId] || [];
        for (const t of tabs) {
          if (!t.unread) continue;
          const wasUnread = prevTabs.find(p => p.id === t.id)?.unread;
          if (wasUnread) continue;
          // Suppress notifications for ANY tab in the focused workspace —
          // even hidden tabs within it. The user explicitly asked for "never
          // watch and notify for work done" while focused on a workspace.
          if (state.activeWorkspaceId === wsId) continue;
          const key = `${wsId}:${t.id}`;
          const now = Date.now();
          if ((lastFiredRef.current[key] || 0) + DEBOUNCE_MS > now) continue;
          lastFiredRef.current[key] = now;
          const w = state.workspaces.find(w => w.id === wsId);
          const reason =
            t.unread.reason === "bell" ? "wants input"
            : t.unread.reason === "exit" ? "exited"
            : t.unread.reason === "done" ? "finished"
            : "is idle";
          notify(`${w?.name || "workspace"} · ${t.type === "terminal" ? t.cli : t.type}`, `agent ${reason}`).catch(() => {});
          lastRouteRef.current = { wsId, tabId: t.id, firedAt: now };
        }
      }
    });
    return unsub;
  }, []);

  // Focus-driven router: when the window regains focus shortly after a
  // notification fire, set the active workspace + tab.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          const route = lastRouteRef.current;
          if (!route) return;
          if (Date.now() - route.firedAt > ROUTE_WINDOW_MS) {
            lastRouteRef.current = null;
            return;
          }
          // Only route if the unread is still standing; if the user
          // already addressed it, don't yank them away from whatever
          // they're now looking at.
          const state = useApp.getState();
          const ws = state.workspaces.find(w => w.id === route.wsId);
          if (!ws) { lastRouteRef.current = null; return; }
          const t = (state.tabs[route.wsId] || []).find(x => x.id === route.tabId);
          if (!t || !t.unread) { lastRouteRef.current = null; return; }
          state.setActiveWorkspace(route.wsId);
          state.setActiveTabId(route.wsId, route.tabId);
          lastRouteRef.current = null;
        });
      } catch (e) {
        console.warn("notification focus router setup failed:", e);
      }
    })();
    return () => { try { unlisten?.(); } catch {} };
  }, []);
}
