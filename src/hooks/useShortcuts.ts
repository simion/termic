// Global keyboard shortcuts. The actual key combos are CONFIGURABLE — the
// source of truth for which command exists + its default combo lives in
// `src/lib/shortcuts.ts`, and the user's overrides live in the prefs store
// (`usePrefs().shortcuts`). This handler reads the resolved bindings live and
// dispatches the matching command. The default combos (for reference):
//   ⌘1..⌘9   → switch to the Nth tab in the active workspace
//   ⌘L       → focus the active workspace's terminal
//   ⌘[, ⌘]   → previous / next workspace (cycles AWAKE ones in sidebar order)
//   ⌥↑, ⌥↓   → previous / next VISIBLE sidebar row (workspace + expanded tabs)
//   ⌥⌘↑, ⌥⌘↓ → pane up/down (when horizontal split exists) or previous/next workspace
//   ⇧⌘A      → jump to the next agent waiting on you (done or blocked)
//   ⇧⌘[, ⇧⌘] → previous / next tab within the active workspace
//   ⌥⌘←, ⌥⌘→ → previous / next tab (arrow-key alt for ⇧⌘[/⇧⌘])
//   ⌘W       → close the active tab (or close split pane when focus is inside one)
//   ⌘D       → split focused pane right (rebindable: split-pane-right)
//   ⇧⌘D      → split focused pane below (rebindable: split-pane-below; shares binding with Git discard-file)
//   ⌘J       → cycle the bottom split: show+focus → focus (if open but unfocused) → hide+refocus agent
//   ⌘L       → focus the main agent (its terminal or editor) from any pane
//   ⌘T       → new tab · ⌘K → clear terminal · ⌘P → file finder
//   ⇧⌘F      → find in files · ⇧⌘B → broadcast · ⌘, → settings
//   Shortcuts cheat-sheet: icon-only, no keyboard binding
import { useEffect } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { requestCloseTab, requestClosePaneTab } from "@/lib/closeTab";
import { focusTerminalTab, focusMainTab, focusPaneTab } from "@/lib/tabFocus";
import { bindingMatches, eventKeyToken, IS_MAC, SHORTCUT_DEFS, type ShortcutId } from "@/lib/shortcuts";
import type { TerminalTab } from "@/lib/types";
import { findAdjacentPane, findLeaf, computeLeafBounds, getAllLeaves, treeHasDir } from "@/lib/splitTree";
import type { NavDir } from "@/lib/splitTree";

/**
 * Pick the next pane to focus in `dir`, preferring the most recently visited
 * pane (from paneHistory) that is a valid candidate in that direction.
 * This lets reverse navigation snap back to the pane the user came from.
 */
function navigatePane(
  state: { splitTree: Record<string, import("@/lib/types").SplitTree>; activePaneId: Record<string, string>; paneHistory: Record<string, string[]> },
  wsId: string,
  dir: NavDir,
): string | null {
  const tree = state.splitTree[wsId];
  if (!tree) return null;
  // Fall back to the main leaf when no active pane has been clicked yet.
  let curId = state.activePaneId[wsId] ?? "";
  if (!curId && tree.type === 'split') {
    const mainLeaf = getAllLeaves(tree).find(l => l.isMain);
    if (mainLeaf) curId = mainLeaf.id;
  }
  if (!curId) return null;

  const geometric = findAdjacentPane(tree, curId, dir);
  if (!geometric) return null;

  // If the most recently visited pane is a valid candidate in this direction,
  // prefer it so "go back" feels like retracing steps, not jumping to a stranger.
  const history = state.paneHistory[wsId] ?? [];
  const prev = history[0];
  if (prev && prev !== curId) {
    const all = computeLeafBounds(tree);
    const curr = all.get(curId);
    const pb = all.get(prev);
    if (curr && pb) {
      const EPS = 0.005;
      const pbCx = pb.x + pb.w / 2;
      const pbCy = pb.y + pb.h / 2;
      const qualifies =
        (dir === 'right' && pb.x >= curr.x + curr.w - EPS && pbCy >= curr.y - EPS && pbCy <= curr.y + curr.h + EPS) ||
        (dir === 'left'  && pb.x + pb.w <= curr.x + EPS    && pbCy >= curr.y - EPS && pbCy <= curr.y + curr.h + EPS) ||
        (dir === 'down'  && pb.y >= curr.y + curr.h - EPS  && pbCx >= curr.x - EPS && pbCx <= curr.x + curr.w + EPS) ||
        (dir === 'up'    && pb.y + pb.h <= curr.y + EPS    && pbCx >= curr.x - EPS && pbCx <= curr.x + curr.w + EPS);
      if (qualifies) return prev;
    }
  }

  return geometric;
}

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
      // Pane tabs live in the same array but must not appear in main-strip
      // navigation (⌘1..9, ⇧⌘[/], ⌥⌘←/→) — those shortcuts target the main pane.
      const tabs = (wsId ? state.tabs[wsId] || [] : []).filter(
        t => !(t as TerminalTab).paneId,
      );
      const activeTabId = wsId ? state.activeTab[wsId] : undefined;
      const inBottom = () => !!(document.activeElement as HTMLElement | null)?.closest?.("[data-bottom-split]");
      // Only true when focus is inside an EXTRA split-pane leaf (not the main pane).
      // The main pane also has data-split-leaf (for drag targeting) but it also has
      // data-main-content, so we exclude it here.
      const inSplitPane = () => {
        const el = (document.activeElement as HTMLElement | null)?.closest?.("[data-split-leaf]") as HTMLElement | null;
        return !!el && !el.hasAttribute("data-main-content");
      };
      // True only when focus is inside the main content area — prevents ⌘W from
      // firing when focus lands in the sidebar, file tree, right panel, etc.
      const inMainPane = () => !!(document.activeElement as HTMLElement | null)?.closest?.("[data-main-content]");

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
              // Exclude pane tabs from sidebar rows — they live in split panes.
              const terminalTabs = wsTabs.filter(
                t => t.type === "terminal" && !(t as TerminalTab).paneId,
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
            // Focus must follow an explicit keyboard tab switch — otherwise
            // the previous (now visibility:hidden) tab keeps DOM focus and
            // still receives keystrokes. Sync activePaneId too: ⌘N targets
            // the MAIN pane, and a stale pointer keeps it dimmed.
            if (t) {
              e.preventDefault();
              state.setActiveTabId(wsId, t.id);
              const tree = state.splitTree[wsId];
              const mainLeafId = tree ? getAllLeaves(tree).find(l => l.isMain)?.id : undefined;
              if (mainLeafId) state.setActivePaneId(wsId, mainLeafId);
              focusMainTab(t.id);
            }
          }
          return;
        }

        // ⌘L → jump focus to the MAIN agent, from anywhere. Scoped to the
        // main pane's active tab (its agent terminal, or the editor if a file
        // tab is active) via `focusMainTab` so it can't land on a right-split
        // pane, a bottom-split shell, or a TabBar pill. NO `isTyping` guard:
        // the whole point is to escape a terminal / editor / right / bottom
        // pane back to the agent, and those all read as "typing".
        case "focus-terminal": {
          if (!wsId) return;
          e.preventDefault();
          // Keep the store's active-pane pointer in step with the focus jump,
          // or the main pane stays dimmed / underline stays muted.
          const tree = state.splitTree[wsId];
          const mainLeafId = tree ? getAllLeaves(tree).find(l => l.isMain)?.id : undefined;
          if (mainLeafId) state.setActivePaneId(wsId, mainLeafId);
          focusMainTab(activeTabId);
          return;
        }

        // ⌥⌘↑ / ⌥⌘↓ → navigate panes up/down when a horizontal split exists;
        // otherwise cycle through workspaces (same role as ⌘[/⌘]).
        case "workspace-prev-arrow":
        case "workspace-next-arrow": {
          const _tree = wsId ? state.splitTree[wsId] : undefined;
          const hasHSplit = _tree ? treeHasDir(_tree, 'h') : false;
          if (wsId && hasHSplit) {
            e.preventDefault();
            const dir = cmd === "workspace-next-arrow" ? 'down' : 'up';
            const next = navigatePane(state, wsId, dir);
            if (next) {
              state.setActivePaneId(wsId, next);
              const leaf = findLeaf(state.splitTree[wsId]!, next);
              if (leaf?.isMain) focusMainTab(activeTabId);
              // focusPaneTab (not focusTerminalTab): the pane's visible tab can
              // be an editor — the terminal-only selector would drop focus.
              else if (leaf?.activeTabId) focusPaneTab(leaf.activeTabId);
              else {
                const el = document.querySelector(`[data-split-launcher][data-pane-id="${next}"]`) as HTMLElement | null;
                el?.focus();
              }
            }
            return;
          }
          // No horizontal split — navigate workspaces.
          const _ws = awakeWorkspaces();
          if (_ws.length <= 1) return;
          e.preventDefault();
          const _fwd = cmd === "workspace-next-arrow";
          const _idx = _ws.findIndex(w => w.id === wsId);
          const _next = _idx < 0
            ? (_fwd ? 0 : _ws.length - 1)
            : _fwd ? (_idx + 1) % _ws.length : (_idx - 1 + _ws.length) % _ws.length;
          state.setActiveWorkspace(_ws[_next].id);
          return;
        }

        // ⌥⌘← / ⌥⌘→ → navigate panes left/right when a vertical split exists; no-op otherwise.
        case "tab-prev-arrow":
        case "tab-next-arrow": {
          const _tree2 = wsId ? state.splitTree[wsId] : undefined;
          const hasVSplit = _tree2 ? treeHasDir(_tree2, 'v') : false;
          if (!wsId || !hasVSplit) return;
          e.preventDefault();
          const dir = cmd === "tab-next-arrow" ? 'right' : 'left';
          const next = navigatePane(state, wsId, dir);
          if (next) {
            state.setActivePaneId(wsId, next);
            const leaf = findLeaf(state.splitTree[wsId]!, next);
            if (leaf?.isMain) focusMainTab(activeTabId);
            // focusPaneTab: same editor-vs-terminal reasoning as above.
            else if (leaf?.activeTabId) focusPaneTab(leaf.activeTabId);
            else {
              const el = document.querySelector(`[data-split-launcher][data-pane-id="${next}"]`) as HTMLElement | null;
              el?.focus();
            }
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
          // Global tab cycle across ALL panes (Sublime-style): the order is
          // main-pane tabs, then each split pane's tabs in tree order. Going
          // next off a pane's last tab continues into the next pane; going
          // prev off a pane's first tab jumps to the previous pane's last tab.
          {
            const tree = state.splitTree[wsId];
            type Entry = { paneId: string | null; tabId: string }; // null = main pane
            const entries: Entry[] = [];
            let mainLeafId: string | null = null;
            if (tree) {
              for (const leaf of getAllLeaves(tree)) {
                if (leaf.isMain) {
                  mainLeafId = leaf.id;
                  for (const t of tabs) entries.push({ paneId: null, tabId: t.id });
                } else {
                  for (const id of (leaf.tabIds ?? [])) entries.push({ paneId: leaf.id, tabId: id });
                }
              }
            } else {
              for (const t of tabs) entries.push({ paneId: null, tabId: t.id });
            }
            if (entries.length <= 1) return;
            e.preventDefault();

            // Current position: DOM focus decides the pane; that pane's active
            // tab decides the entry. Falls back to the main active tab.
            let curIdx = -1;
            if (inSplitPane()) {
              const focusedEl = (document.activeElement as HTMLElement | null)
                ?.closest?.("[data-split-leaf]") as HTMLElement | null;
              const pid = focusedEl?.getAttribute("data-pane-id") ?? null;
              const leaf = pid && tree ? findLeaf(tree, pid) : null;
              const curTab = leaf?.activeTabId;
              if (pid && curTab) curIdx = entries.findIndex(en => en.paneId === pid && en.tabId === curTab);
            }
            if (curIdx < 0 && activeTabId) {
              curIdx = entries.findIndex(en => en.paneId === null && en.tabId === activeTabId);
            }
            const nextIdx = curIdx < 0
              ? 0
              : fwd ? (curIdx + 1) % entries.length : (curIdx - 1 + entries.length) % entries.length;
            const next = entries[nextIdx];

            // Focus follows the switch (terminal or editor) so ⌘W and further
            // ⇧⌘[/] keep targeting the pane we landed in.
            if (next.paneId === null) {
              state.setActiveTabId(wsId, next.tabId);
              if (mainLeafId) state.setActivePaneId(wsId, mainLeafId);
              focusMainTab(next.tabId);
            } else {
              state.setPaneActiveTab(wsId, next.paneId, next.tabId);
              state.setActivePaneId(wsId, next.paneId);
              focusPaneTab(next.tabId);
            }
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

        // ⇧⌘A → jump to the next agent that's waiting on you (issue #56).
        // "Waiting" = the same signal the sidebar highlights: a terminal tab
        // that's `done` (finished its turn) or `attention` (explicitly blocked
        // on input). Gated on `settledHighlight` so it's inert when that UI is
        // off. Activating a workspace clears its attention (setActiveWorkspace),
        // so pressing this repeatedly walks the whole waiting queue — no per-
        // item bookkeeping. Scans forward from the current workspace with
        // wraparound; lands on the specific waiting tab (attention over done).
        case "jump-next-waiting": {
          if (!usePrefs.getState().settledHighlight) return;
          const isWaiting = (w: { id: string }) =>
            (state.tabs[w.id] ?? []).some(
              t => t.type === "terminal" &&
                ((t as TerminalTab).unread?.reason === "attention" ||
                 (t as TerminalTab).workState === "done"),
            );
          const ws = awakeWorkspaces();
          if (!ws.some(isWaiting)) return;
          e.preventDefault();
          const start = ws.findIndex(w => w.id === wsId);
          // Order the scan to begin AFTER the current workspace, wrapping around.
          const ordered = start < 0 ? ws : [...ws.slice(start + 1), ...ws.slice(0, start + 1)];
          const target = ordered.find(isWaiting);
          if (!target) return;
          state.setActiveWorkspace(target.id);
          const tTabs = state.tabs[target.id] ?? [];
          const tab =
            tTabs.find(t => t.type === "terminal" && (t as TerminalTab).unread?.reason === "attention") ??
            tTabs.find(t => t.type === "terminal" && (t as TerminalTab).workState === "done");
          if (tab) state.setActiveTabId(target.id, tab.id);
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

        // ⌘D → split focused pane right; ⇧⌘D → split focused pane below.
        case "split-pane-right": {
          if (!wsId) return;
          e.preventDefault();
          state.splitPane(wsId, 'v');
          return;
        }
        case "split-pane-below": {
          if (!wsId) return;
          e.preventDefault();
          state.splitPane(wsId, 'h');
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
          } else if (inSplitPane()) {
            const focusedLeaf = (document.activeElement as HTMLElement | null)
              ?.closest?.("[data-split-leaf]") as HTMLElement | null;
            const paneId = focusedLeaf?.getAttribute("data-pane-id") ?? null;
            if (paneId) window.dispatchEvent(new CustomEvent("termic-pane-new-tab-menu", { detail: { wsId, paneId } }));
          } else {
            // Main pane: open the "+" tab menu.
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
          if (inSplitPane() && wsId) {
            // Always derive pane from DOM focus — activePaneId[wsId] is only updated
            // on mouse clicks and can be stale after keyboard navigation.
            const focusedEl = (document.activeElement as HTMLElement | null)
              ?.closest?.("[data-split-leaf]") as HTMLElement | null;
            const paneId = focusedEl?.getAttribute("data-pane-id") ?? null;
            if (paneId) {
              const tree = state.splitTree[wsId];
              const leaf = tree ? findLeaf(tree, paneId) : null;
              const activeTabIdInPane = leaf?.activeTabId ?? (leaf as any)?.tabId ?? null;
              if (activeTabIdInPane && leaf) {
                // Confirm-gated (dirty editor / live agent), same as the main
                // path. Only collapse the emptied pane if the close went through.
                const wasLastTab = (leaf.tabIds?.length ?? 1) <= 1;
                void requestClosePaneTab(wsId, paneId, activeTabIdInPane).then(closed => {
                  if (closed && wasLastTab) useApp.getState().closePane(wsId, paneId);
                });
              } else {
                state.closePane(wsId, paneId);
              }
              return;
            }
          }
          if (wsId && activeTabId && inMainPane()) { requestCloseTab(wsId, activeTabId); return; }
          // Focus outside every pane (file tree / sidebar): still close a
          // PREVIEW tab. Previews open from a single click in the tree, so
          // focus never enters the pane — without this, ⌘W right after
          // previewing a file is a silent no-op. Regular tabs keep the
          // inMainPane guard (⌘W from the sidebar must not eat real tabs).
          if (wsId) {
            // Prefer the pane the preview actually lives in: openPreviewTab
            // targets the focused split pane, tracked by activePaneId.
            const tree = state.splitTree[wsId];
            const paneId = state.activePaneId[wsId];
            const leaf = tree && paneId ? findLeaf(tree, paneId) : null;
            if (leaf && !leaf.isMain && leaf.activeTabId) {
              const paneTab = (state.tabs[wsId] ?? []).find(t => t.id === leaf.activeTabId);
              if (paneTab?.preview) {
                const wasLastTab = (leaf.tabIds?.length ?? 1) <= 1;
                void requestClosePaneTab(wsId, leaf.id, paneTab.id).then(closed => {
                  if (closed && wasLastTab) useApp.getState().closePane(wsId, leaf.id);
                });
                return;
              }
            }
            const mainTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
            if (mainTab?.preview) requestCloseTab(wsId, mainTab.id);
          }
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

