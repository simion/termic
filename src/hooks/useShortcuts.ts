// Global keyboard shortcuts:
//   ⌘1..⌘9   → jump to the Nth active workspace
//   ⌘L       → focus the active workspace's terminal
//   ⌘[, ⌘]   → previous / next tab within the active workspace
//   ⌘W       → close the active tab
//   ⌘T       → open a new bottom-split terminal in the active workspace
//             (opens the split if it's not already open)
//   ⇧⌘[, ⇧⌘] → previous / next workspace (cycles non-archived workspaces in
//             sidebar order)
import { useEffect } from "react";
import { useApp } from "@/store/app";

export function useShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;

      const state = useApp.getState();
      const wsId = state.activeWorkspaceId;
      const tabs = wsId ? state.tabs[wsId] || [] : [];
      const activeTabId = wsId ? state.activeTab[wsId] : undefined;

      // ⌘, → open settings (macOS convention).
      if (e.key === ",") {
        e.preventDefault();
        state.openSettings();
        return;
      }

      // ⌘1..⌘9 → jump to Nth workspace
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        const w = state.workspaces.filter(w => !w.archived)[n];
        if (w) { e.preventDefault(); state.setActiveWorkspace(w.id); }
        return;
      }

      if (e.key.toLowerCase() === "l" && wsId) {
        if (isTyping) return;
        e.preventDefault();
        // Focus the active terminal via the xterm DOM (no global ref needed).
        const el = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
        el?.focus();
        return;
      }

      // ⌘[ / ⌘]   → main tabs nav (no shift).
      // ⇧⌘[ / ⇧⌘] → workspace nav across the sidebar (shift held). Cycles
      //              the same non-archived workspace list that ⌘1..9 uses.
      if (e.key === "[" || e.key === "]") {
        if (e.shiftKey) {
          const visible = state.workspaces.filter(w => !w.archived);
          if (visible.length <= 1) return;
          e.preventDefault();
          const idx = visible.findIndex(w => w.id === wsId);
          // If nothing is active yet, ] jumps to first, [ jumps to last.
          const nextIdx = idx < 0
            ? (e.key === "]" ? 0 : visible.length - 1)
            : e.key === "]"
              ? (idx + 1) % visible.length
              : (idx - 1 + visible.length) % visible.length;
          state.setActiveWorkspace(visible[nextIdx].id);
          return;
        }
        if (wsId && tabs.length > 1) {
          e.preventDefault();
          const idx = tabs.findIndex(t => t.id === activeTabId);
          const nextIdx = e.key === "]"
            ? (idx + 1) % tabs.length
            : (idx - 1 + tabs.length) % tabs.length;
          state.setActiveTabId(wsId, tabs[nextIdx].id);
        }
        return;
      }

      // ⌘T → new bottom-split terminal tab. Opens the split first if closed.
      if (e.key.toLowerCase() === "t" && wsId) {
        if (isTyping) return;
        e.preventDefault();
        if (!state.terminalSplit[wsId]) state.toggleTerminalSplit(wsId);
        state.addBottomTab(wsId);  // sets it active too
        return;
      }

      if (e.key.toLowerCase() === "w") {
        if (isTyping) return;
        // ALWAYS preventDefault when we're in a workspace, even if
        // there's nothing to close. Otherwise Tauri/the webview
        // interprets ⌘W as "close window" (the OS default) and the
        // app dies — surprising when the user was just trying to
        // close the active terminal tab.
        if (wsId) {
          e.preventDefault();
          if (activeTabId) state.closeTab(wsId, activeTabId);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
