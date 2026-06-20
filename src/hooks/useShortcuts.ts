// Global keyboard shortcuts. The actual key combos are CONFIGURABLE — the
// source of truth for which command exists + its default combo lives in
// `src/lib/shortcuts.ts`, and the user's overrides live in the prefs store
// (`usePrefs().shortcuts`). This handler reads the resolved bindings live and
// dispatches the matching command. The default combos (for reference):
//   ⌘1..⌘9   → switch to the Nth tab in the active workspace
//   ⌘L       → focus the active workspace's terminal
//   ⌘[, ⌘]   → previous / next workspace (cycles AWAKE ones in sidebar order)
//   ⌥↑, ⌥↓   → previous / next VISIBLE sidebar row (workspace + expanded tabs)
//   ⌥⌘↑, ⌥⌘↓ → previous / next workspace (skip expanded tabs)
//   ⇧⌘[, ⇧⌘] → previous / next tab within the active workspace
//   ⌥⌘←, ⌥⌘→ → previous / next tab (arrow-key alt for ⇧⌘[/⇧⌘])
//   ⌘W       → close the active tab
//   ⌘D       → open a new right-split terminal in the active workspace
//   ⇧⌘D      → open a new bottom-split terminal in the active workspace
//   ⌘J       → toggle the bottom split: show + focus it, or hide + refocus agent
//   ⌘T       → new tab · ⌘K → clear terminal · ⌘P → file finder
//   ⇧⌘F      → find in files · ⇧⌘B → broadcast · ⌘, → settings
import { useEffect } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { requestCloseTab } from "@/lib/closeTab";
import { focusTerminalTab } from "@/lib/tabFocus";
import { bindingMatches, IS_MAC, SHORTCUT_DEFS, type ShortcutId } from "@/lib/shortcuts";
import type { TerminalTab } from "@/lib/types";

export function useShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // macOS: inside a focused terminal, Ctrl is the terminal's OWN modifier
      // (readline / TUI editor bindings: ^P ^W ^K ^T ^A ^E ^R …). The app folds
      // Cmd≡Ctrl so its shortcuts fire cross-platform, but that fold would
      // swallow every Ctrl combo before the PTY ever sees it. When only Ctrl
      // (not Cmd) is down and a terminal has focus, bail so the keystroke
      // reaches the shell/editor. App shortcuts still work via Cmd. (issue #10)
      if (IS_MAC && e.ctrlKey && !e.metaKey && inTermFocused()) return;

      const binds = usePrefs.getState().shortcuts;
      // First binding (in registry order) whose combo the event satisfies.
      // Exact modifier matching makes commands mutually exclusive unless the
      // user has created a conflict (the settings page warns about those);
      // first-match-wins resolves a conflict deterministically.
      let cmd: ShortcutId | null = null;
      for (const def of SHORTCUT_DEFS) {
        if (bindingMatches(e, binds[def.id])) { cmd = def.id; break; }
      }
      if (!cmd) return;

      const state = useApp.getState();
      const wsId = state.activeWorkspaceId;
      // Right-panel tabs live in the same array but must not appear in
      // main-strip navigation (⌘1..9, ⇧⌘[/], ⌥⌘←/→) — those shortcuts
      // target the left agent strip only.
      const tabs = (wsId ? state.tabs[wsId] || [] : []).filter(
        t => t.panel !== "right",
      );
      const activeTabId = wsId ? state.activeTab[wsId] : undefined;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;
      const inBottom = () => !!(document.activeElement as HTMLElement | null)?.closest?.("[data-bottom-split]");
      const inRight  = () => !!(document.activeElement as HTMLElement | null)?.closest?.("[data-right-split]");

      // Workspace nav cycles only AWAKE workspaces — ones the user has opened
      // at least once + still has tabs in. Order MUST match the sidebar's
      // visual grouping (project → its workspaces → next project …) or the
      // jumps feel random. Computed lazily; only some commands need it.
      const awakeWorkspaces = () => state.projects.flatMap(p =>
        state.workspaces.filter(w =>
          w.project_id === p.id && !w.archived && (state.tabs[w.id]?.length ?? 0) > 0,
        ),
      );

      switch (cmd) {
        // ⌥↑ / ⌥↓ → previous / next VISIBLE sidebar row. Walks the same flat
        // list the user sees: each workspace, plus its terminal tabs when the
        // workspace is expanded. Selecting a tab also activates its workspace.
        case "sidebar-prev":
        case "sidebar-next": {
          type Row = { wsId: string; tabId?: string };
          const rows: Row[] = [];
          for (const p of state.projects) {
            for (const w of state.workspaces) {
              if (w.project_id !== p.id || w.archived) continue;
              rows.push({ wsId: w.id });
              const wsTabs = state.tabs[w.id] ?? [];
              // Exclude right-panel tabs from sidebar rows — they live in the
              // right split and are not navigable via sidebar-prev/next.
              const terminalTabs = wsTabs.filter(
                t => t.type === "terminal" && !(t as TerminalTab).panel,
              );
              const explicit = state.collapsedWorkspaces[w.id];
              const collapsed = explicit ?? (terminalTabs.length <= 1);
              if (!collapsed) {
                for (const t of terminalTabs) rows.push({ wsId: w.id, tabId: t.id });
              }
            }
          }
          if (rows.length <= 1) return;
          e.preventDefault();
          const activeTab = wsId ? state.activeTab[wsId] : undefined;
          let idx = rows.findIndex(r => r.wsId === wsId && r.tabId === activeTab);
          if (idx < 0) idx = rows.findIndex(r => r.wsId === wsId && !r.tabId);
          const dir = cmd === "sidebar-next" ? 1 : -1;
          const nextIdx = idx < 0
            ? (dir > 0 ? 0 : rows.length - 1)
            : (idx + dir + rows.length) % rows.length;
          const target = rows[nextIdx];
          state.setActiveWorkspace(target.wsId);
          if (target.tabId) state.setActiveTabId(target.wsId, target.tabId);
          return;
        }

        // ⌘N → global project picker. Fires from anywhere (no active
        // workspace needed) so you can start a new workspace without first
        // selecting one. No `isTyping` guard, same as the file finder.
        case "new-workspace-quick":
          e.preventDefault();
          useUI.getState().openProjectPicker();
          return;

        // ⌘K → toggle the command palette (open, or close if already open).
        // MUST fire from anywhere, including while focused in a terminal (the
        // app is terminal-centric), so no `isTyping` guard. This is why
        // ⌘K-clear moved to ⌘⇧K.
        case "command-palette": {
          e.preventDefault();
          const ui = useUI.getState();
          if (ui.commandPaletteOpen) ui.closeCommandPalette();
          else ui.openCommandPalette();
          return;
        }

        // ⌘B / ⌥⌘B → collapse the left sidebar / hide the right panel.
        case "toggle-left-sidebar":
          e.preventDefault();
          state.toggleCompactSidebar();
          return;
        case "toggle-right-sidebar":
          e.preventDefault();
          state.toggleRightPanel();
          return;

        // ⌘, → open settings (macOS convention).
        case "open-settings":
          e.preventDefault();
          state.openSettings();
          return;

        // ⌘/ → open the read-only shortcuts cheat-sheet modal (issue #7).
        // It has its own search + an Edit button that jumps to Settings →
        // Shortcuts for rebinding.
        case "open-shortcuts":
          e.preventDefault();
          useUI.getState().openShortcutsHelp();
          return;

        // ⌘P → file finder. NO `isTyping` guard — xterm's hidden textarea
        // always reports as typing, and we want it to fire from the terminal
        // too. Scoped to having an active workspace.
        case "file-finder":
          if (!wsId) return;
          e.preventDefault();
          useUI.getState().openFileFinder(wsId);
          return;

        // ⇧⌘F → find-in-files. Same no-`isTyping` rationale as the finder.
        case "find-in-files":
          if (!wsId) return;
          e.preventDefault();
          useUI.getState().openFindInFiles(wsId);
          return;

        // ⌘1..⌘9 → switch to Nth tab in the active workspace. Indexes the
        // full tab list so position matches the TabBar.
        case "jump-to-tab": {
          if (wsId && tabs.length > 0) {
            const n = Number(e.key) - 1;
            const t = tabs[n];
            if (t) { e.preventDefault(); state.setActiveTabId(wsId, t.id); }
          }
          return;
        }

        // ⌘L → focus the active terminal. The one command WITH an isTyping
        // guard: it must not steal focus while the user types in a form field.
        case "focus-terminal": {
          if (!wsId || isTyping) return;
          e.preventDefault();
          const el = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
          el?.focus();
          return;
        }

        // ⌥⌘↑ / ⌥⌘↓ → previous / next AWAKE workspace (arrow-key alt for ⌘[/]).
        case "workspace-prev-arrow":
        case "workspace-next-arrow": {
          const ws = awakeWorkspaces();
          if (ws.length <= 1) return;
          e.preventDefault();
          const fwd = cmd === "workspace-next-arrow";
          const idx = ws.findIndex(w => w.id === wsId);
          const nextIdx = idx < 0
            ? (fwd ? 0 : ws.length - 1)
            : fwd ? (idx + 1) % ws.length : (idx - 1 + ws.length) % ws.length;
          state.setActiveWorkspace(ws[nextIdx].id);
          return;
        }

        // ⌥⌘← / ⌥⌘→ → previous / next tab within the active workspace.
        case "tab-prev-arrow":
        case "tab-next-arrow": {
          if (wsId && tabs.length > 1) {
            e.preventDefault();
            const fwd = cmd === "tab-next-arrow";
            const idx = tabs.findIndex(t => t.id === activeTabId);
            const nextIdx = fwd ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
            state.setActiveTabId(wsId, tabs[nextIdx].id);
          }
          return;
        }

        // ⇧⌘[ / ⇧⌘] → tab nav within active workspace. Focus-aware: when the
        // bottom-split shell owns focus, cycles the BOTTOM tabs instead.
        case "tab-prev":
        case "tab-next": {
          if (!wsId) return;
          const fwd = cmd === "tab-next";
          if (inBottom()) {
            const bottomTabs = state.bottomTabs[wsId] || [];
            if (bottomTabs.length > 1) {
              e.preventDefault();
              const idx = bottomTabs.findIndex(t => t.id === state.activeBottomTab[wsId]);
              const nextIdx = idx < 0
                ? (fwd ? 0 : bottomTabs.length - 1)
                : fwd ? (idx + 1) % bottomTabs.length : (idx - 1 + bottomTabs.length) % bottomTabs.length;
              const nextId = bottomTabs[nextIdx].id;
              state.setActiveBottomTab(wsId, nextId);
              // AuxTerminal deliberately doesn't grab focus when it becomes
              // active (so opening the split / switching workspaces doesn't
              // steal focus from the agent). An explicit keyboard tab-switch
              // SHOULD move focus, so focus the newly-active shell once the
              // re-render makes it visible.
              focusTerminalTab(nextId);
            }
            return;
          }
          if (tabs.length > 1) {
            e.preventDefault();
            const idx = tabs.findIndex(t => t.id === activeTabId);
            const nextIdx = fwd ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
            state.setActiveTabId(wsId, tabs[nextIdx].id);
          }
          return;
        }

        // ⌘[ / ⌘] → workspace nav across AWAKE workspaces.
        case "workspace-prev":
        case "workspace-next": {
          const ws = awakeWorkspaces();
          if (ws.length <= 1) return;
          e.preventDefault();
          const fwd = cmd === "workspace-next";
          const idx = ws.findIndex(w => w.id === wsId);
          const nextIdx = idx < 0
            ? (fwd ? 0 : ws.length - 1)
            : fwd ? (idx + 1) % ws.length : (idx - 1 + ws.length) % ws.length;
          state.setActiveWorkspace(ws[nextIdx].id);
          return;
        }

        // ⇧⌘D → new bottom-split terminal tab. Opens the split first if
        // closed. NO `isTyping` guard (xterm's hidden textarea).
        case "new-split-terminal": {
          if (!wsId) return;
          e.preventDefault();
          const splitOpen = !!state.terminalSplit[wsId];
          const hasTabs = (state.bottomTabs[wsId]?.length ?? 0) > 0;
          if (!splitOpen) state.toggleTerminalSplit(wsId);
          // addBottomTab focuses the new shell itself; otherwise focus the one
          // that's already active (it may need a few frames to mount).
          if (!hasTabs) state.addBottomTab(wsId);
          else focusTerminalTab(state.activeBottomTab[wsId]);
          return;
        }

        // ⌘J → toggle the bottom-split terminal, VS Code-style (issue #45).
        // The whole show/hide + focus dance lives in the store so the command
        // palette can share it. NO `isTyping` guard — must fire from inside any
        // terminal (xterm's hidden textarea) and the editor (CodeMirror).
        case "toggle-terminal":
          if (!wsId) return;
          e.preventDefault();
          state.toggleBottomTerminal(wsId);
          return;

        // ⌘D → open right split (if closed) or focus the active right terminal.
        case "new-right-split-terminal": {
          if (!wsId) return;
          e.preventDefault();
          const splitOpen = !!state.rightSplit[wsId];
          const hasRightTabs = (state.tabs[wsId] ?? []).some(
            t => t.type === "terminal" && (t as TerminalTab).panel === "right",
          );
          if (!splitOpen) state.toggleRightSplit(wsId);
          // On first open, ensureDefaultRightTabs runs via WorkspaceView's
          // useEffect. If there are no persisted right tabs, add a fresh shell.
          if (!hasRightTabs && splitOpen) state.addRightTab(wsId);
          const tryFocus = (tries = 20) => {
            const split = document.querySelector("[data-right-split]");
            const active = split?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
            if (active) { active.focus(); return; }
            if (tries > 0) setTimeout(() => tryFocus(tries - 1), 25);
          };
          tryFocus();
          return;
        }

        // ⇧⌘B → open the Broadcast dialog for the active workspace.
        case "broadcast":
          if (!wsId) return;
          e.preventDefault();
          useUI.getState().openBroadcast(wsId);
          return;

        // ⌘T → new tab, behaviour depends on which pane has focus. NO
        // `isTyping` guard (xterm's hidden textarea).
        case "new-tab": {
          if (!wsId) return;
          e.preventDefault();
          if (inBottom()) {
            state.addBottomTab(wsId);
          } else if (inRight()) {
            window.dispatchEvent(new CustomEvent("termic-new-right-tab-menu", { detail: { wsId } }));
          } else {
            // Main pane: open the "+" tab menu so the user can pick an agent
            // with the keyboard. The active workspace's TabBar listens.
            window.dispatchEvent(new CustomEvent("termic-new-tab-menu", { detail: { wsId } }));
          }
          return;
        }

        // ⌘K → clear the focused terminal. Only acts when a terminal owns
        // focus; otherwise let the keystroke pass through.
        case "clear-terminal":
          if (inTermFocused()) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("termic-clear-focused"));
          }
          return;

        // ⌘W → close the active tab. ALWAYS preventDefault so the OS doesn't
        // read it as "close window" and quit. Focus-aware for the bottom
        // and right splits. NO `isTyping` guard (xterm's hidden textarea).
        case "close-tab": {
          e.preventDefault();
          if (inBottom() && wsId) {
            const bottomId = state.activeBottomTab[wsId];
            if (bottomId) state.closeBottomTab(wsId, bottomId);
            return;
          }
          if (inRight() && wsId) {
            const rightId = state.activeRightTab[wsId];
            if (rightId) state.closeRightTab(wsId, rightId);
            return;
          }
          // requestCloseTab confirms first if it's a dirty edit tab.
          if (wsId && activeTabId) requestCloseTab(wsId, activeTabId);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function inTermFocused() {
  return !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
}
