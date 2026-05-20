// Global keyboard shortcuts:
//   ⌘1..⌘9   → jump to the Nth active workspace
//   ⌘L       → focus the active workspace's terminal
//   ⌘[, ⌘]   → previous / next workspace (cycles non-archived in sidebar order)
//   ⌥⌘↑, ⌥⌘↓ → previous / next workspace (arrow-key alt for the brackets;
//             matches the up/down sidebar visual direction)
//   ⇧⌘[, ⇧⌘] → previous / next tab within the active workspace
//             (Safari / Chrome / iTerm convention — Shift + brackets = tabs)
//   ⌥⌘←, ⌥⌘→ → previous / next tab (arrow-key alt for ⇧⌘[/⇧⌘];
//             pairs with ⌥⌘↑/↓ — up/down = workspaces, left/right = tabs)
//   ⌘W       → close the active tab
//   ⇧⌘D      → open a new bottom-split terminal in the active workspace
//             (opens the split if it's not already open) — matches the
//             iTerm / Terminal.app convention for "horizontal split".
import { useEffect } from "react";
import { useApp } from "@/store/app";
import { requestCloseTab } from "@/lib/closeTab";

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

      // Workspace nav cycles only AWAKE workspaces — ones the user
      // has opened at least once + still has tabs in. The sleep
      // state (no tabs / no PTYs) is the same one closeTab arrives
      // at when the user X's out the last tab. Cycling through
      // asleep ones would silently respawn PTYs the user already
      // killed, which is surprising.
      const awakeWorkspaces = state.workspaces.filter(
        w => !w.archived && (state.tabs[w.id]?.length ?? 0) > 0,
      );

      // ⌥⌘↑ / ⌥⌘↓ → previous / next AWAKE workspace (arrow-key alt
      //              for ⌘[/⌘]). Picked Option+Cmd to avoid clashing
      //              with macOS' default Mission Control bindings on
      //              ⌃↑ / ⌃↓.
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (awakeWorkspaces.length <= 1) return;
        e.preventDefault();
        const idx = awakeWorkspaces.findIndex(w => w.id === wsId);
        const nextIdx = idx < 0
          ? (e.key === "ArrowDown" ? 0 : awakeWorkspaces.length - 1)
          : e.key === "ArrowDown"
            ? (idx + 1) % awakeWorkspaces.length
            : (idx - 1 + awakeWorkspaces.length) % awakeWorkspaces.length;
        state.setActiveWorkspace(awakeWorkspaces[nextIdx].id);
        return;
      }

      // ⌥⌘← / ⌥⌘→ → previous / next tab within the active workspace.
      //              Arrow-key alt for ⇧⌘[/⇧⌘] (matches Chrome's
      //              ⌥⌘←/→ tab switch). Pairs with ⌥⌘↑/↓ above:
      //              up/down = workspaces, left/right = tabs.
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (wsId && tabs.length > 1) {
          e.preventDefault();
          const idx = tabs.findIndex(t => t.id === activeTabId);
          const nextIdx = e.key === "ArrowRight"
            ? (idx + 1) % tabs.length
            : (idx - 1 + tabs.length) % tabs.length;
          state.setActiveTabId(wsId, tabs[nextIdx].id);
        }
        return;
      }

      // ⇧⌘[ / ⇧⌘] → tab nav within active workspace (Safari / Chrome /
      //              iTerm convention — Shift + brackets always = tabs).
      // ⌘[ / ⌘]   → workspace nav across AWAKE workspaces (no shift).
      if (e.key === "[" || e.key === "]") {
        if (e.shiftKey) {
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
        if (awakeWorkspaces.length <= 1) return;
        e.preventDefault();
        const idx = awakeWorkspaces.findIndex(w => w.id === wsId);
        const nextIdx = idx < 0
          ? (e.key === "]" ? 0 : awakeWorkspaces.length - 1)
          : e.key === "]"
            ? (idx + 1) % awakeWorkspaces.length
            : (idx - 1 + awakeWorkspaces.length) % awakeWorkspaces.length;
        state.setActiveWorkspace(awakeWorkspaces[nextIdx].id);
        return;
      }

      // ⇧⌘D → new bottom-split terminal tab. Opens the split first
      // if closed. Matches iTerm / Terminal.app's "horizontal split"
      // binding. ⌘T was a Tauri-window-new shortcut surprise — moved
      // off it so menu-bar items don't conflict.
      //
      // NO `isTyping` guard here: xterm uses a hidden TEXTAREA
      // (`.xterm-helper-textarea`) to capture input, so when the
      // terminal is focused isTyping is true and the shortcut
      // wouldn't fire. Shift+Cmd combos aren't valid typing
      // shortcuts anyway, so we skip the gate.
      if (e.shiftKey && e.key.toLowerCase() === "d" && wsId) {
        e.preventDefault();
        const splitOpen = !!state.terminalSplit[wsId];
        const hasTabs = (state.bottomTabs[wsId]?.length ?? 0) > 0;
        if (!splitOpen) state.toggleTerminalSplit(wsId);
        if (!hasTabs) state.addBottomTab(wsId);
        // Always move focus into the bottom split — that's the whole
        // point of the shortcut. Poll briefly because the freshly-
        // opened split / freshly-spawned shell needs a few frames
        // before its xterm helper-textarea is in the DOM.
        const tryFocus = (tries = 20) => {
          const split = document.querySelector("[data-bottom-split]");
          const active = split?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
          if (active) { active.focus(); return; }
          if (tries > 0) setTimeout(() => tryFocus(tries - 1), 25);
        };
        tryFocus();
        return;
      }

      // ⌘T → new bottom-split shell tab when focus is inside the
      // bottom split (mirrors macOS Terminal.app's "new tab" binding
      // for whichever pane has focus). NO `isTyping` guard for the
      // same reason as ⇧⌘D — xterm's hidden textarea always reports
      // as typing.
      if (e.key.toLowerCase() === "t" && !e.shiftKey && wsId) {
        const inBottom = !!(document.activeElement as HTMLElement | null)?.closest?.("[data-bottom-split]");
        if (inBottom) {
          e.preventDefault();
          state.addBottomTab(wsId);
          // Focus the newly-active shell — same poll dance as ⇧⌘D
          // because the xterm helper-textarea isn't in the DOM until
          // AuxTerminal's spawn effect commits.
          const tryFocus = (tries = 20) => {
            const split = document.querySelector("[data-bottom-split]");
            const el = split?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
            if (el) { el.focus(); return; }
            if (tries > 0) setTimeout(() => tryFocus(tries - 1), 25);
          };
          tryFocus();
          return;
        }
      }

      // ⌘K → clear the focused terminal (xterm `clear()`). Dispatched
      // as a window CustomEvent; each Terminal instance listens and
      // self-checks `document.activeElement` against its own host
      // before clearing. NO `isTyping` guard — same xterm hidden-
      // textarea reason as ⇧⌘D / ⌘T.
      if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        const inTerm = !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
        if (inTerm) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("termic-clear-focused"));
          return;
        }
      }

      if (e.key.toLowerCase() === "w" && !e.shiftKey) {
        // NO `isTyping` guard — xterm reports as typing because its
        // hidden textarea is always focused. We want ⌘W to close the
        // current tab even when the terminal owns focus, same as
        // clicking the X on the tab.
        // ALWAYS preventDefault so the OS doesn't interpret ⌘W as
        // "close window" and quit the app.
        e.preventDefault();
        // requestCloseTab confirms first if it's a dirty edit tab —
        // ⌘W must never silently discard unsaved changes.
        if (wsId && activeTabId) requestCloseTab(wsId, activeTabId);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
