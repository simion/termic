// Global keyboard shortcuts. The actual key combos are CONFIGURABLE — the
// source of truth for which command exists + its default combo lives in
// `src/lib/shortcuts.ts`, and the user's overrides live in the prefs store
// (`usePrefs().shortcuts`). This handler reads the resolved bindings live and
// dispatches the matching command. The default combos (for reference):
//   ⌘1..⌘9   → switch to the Nth tab in the active task
//   ⌘L       → focus the active task's terminal
//   ⌘[, ⌘]   → previous / next task (cycles AWAKE ones in sidebar order)
//   ⌥↑, ⌥↓   → previous / next VISIBLE sidebar row (task + expanded tabs)
//   ⌥⌘↑, ⌥⌘↓ → pane up/down (when horizontal split exists) or previous/next task
//   ⇧⌘A      → jump to the next agent waiting on you (done or blocked)
//   ⇧⌘[, ⇧⌘] → previous / next tab within the active task
//   ⌥⌘←, ⌥⌘→ → previous / next tab (arrow-key alt for ⇧⌘[/⇧⌘])
//   ⌘W       → close the active tab (or close split pane when focus is inside one)
//   ⌘D       → split focused pane right (rebindable: split-pane-right)
//   ⇧⌘D      → split focused pane below (rebindable: split-pane-below; shares binding with Git discard-file)
//   ⌘J       → cycle the bottom split: show+focus → focus (if open but unfocused) → hide+refocus agent
//   ⌘L       → focus the main agent (its terminal or editor) from any pane
//   ⌘T       → new tab · ⌘K → clear terminal · ⌘P → file finder
//   ⇧⌘F      → find in files · ⇧⌘B → broadcast · ⌘, → settings
//   ⇧⌘P      → command palette · ⌥⌘P → prompt palette
//   Shortcuts cheat-sheet: icon-only, no keyboard binding
import { useEffect } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs, APPEARANCE_DEFAULTS } from "@/store/prefs";
import { requestCloseTab, requestClosePaneTab } from "@/lib/closeTab";
import { focusTerminalTab, focusMainTab, focusPaneTab } from "@/lib/tabFocus";
import { jumpToNextWaiting } from "@/lib/waitingAgents";
import { bindingMatches, eventKeyToken, IS_MAC, SHORTCUT_DEFS, type ShortcutId } from "@/lib/shortcuts";
import { visualProjectOrder } from "@/lib/projectGroups";
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
  taskId: string,
  dir: NavDir,
): string | null {
  const tree = state.splitTree[taskId];
  if (!tree) return null;
  // Fall back to the main leaf when no active pane has been clicked yet.
  let curId = state.activePaneId[taskId] ?? "";
  if (!curId && tree.type === 'split') {
    const mainLeaf = getAllLeaves(tree).find(l => l.isMain);
    if (mainLeaf) curId = mainLeaf.id;
  }
  if (!curId) return null;

  const geometric = findAdjacentPane(tree, curId, dir);
  if (!geometric) return null;

  // If the most recently visited pane is a valid candidate in this direction,
  // prefer it so "go back" feels like retracing steps, not jumping to a stranger.
  const history = state.paneHistory[taskId] ?? [];
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
      const taskId = state.activeTaskId;
      // Pane tabs live in the same array but must not appear in main-strip
      // navigation (⌘1..9, ⇧⌘[/], ⌥⌘←/→) — those shortcuts target the main pane.
      const tabs = (taskId ? state.tabs[taskId] || [] : []).filter(
        t => !(t as TerminalTab).paneId,
      );
      const activeTabId = taskId ? state.activeTab[taskId] : undefined;
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

      // Task nav cycles only AWAKE tasks — ones the user has opened
      // at least once + still has tabs in. Order MUST match the sidebar's
      // visual grouping (group folder → its projects; project → its
      // tasks → next project …) or the jumps feel random. Computed
      // lazily; only some commands need it.
      const awakeTasks = () => visualProjectOrder(state.projects).flatMap(p =>
        state.tasks.filter(w =>
          w.project_id === p.id && !w.archived && (state.tabs[w.id]?.length ?? 0) > 0,
        ),
      );

      switch (cmd) {
        // ⌥↑ / ⌥↓ → previous / next VISIBLE sidebar row. Walks the same flat
        // list the user sees: each task, plus its terminal tabs when the
        // task is expanded. Selecting a tab also activates its task.
        case "sidebar-prev":
        case "sidebar-next": {
          type Row = { taskId: string; tabId?: string };
          const rows: Row[] = [];
          for (const p of visualProjectOrder(state.projects)) {
            for (const w of state.tasks) {
              if (w.project_id !== p.id || w.archived) continue;
              rows.push({ taskId: w.id });
              const taskTabs = state.tabs[w.id] ?? [];
              // Exclude pane tabs from sidebar rows — they live in split panes.
              const terminalTabs = taskTabs.filter(
                t => t.type === "terminal" && !(t as TerminalTab).paneId,
              );
              const explicit = state.collapsedTasks[w.id];
              const collapsed = explicit ?? (terminalTabs.length <= 1);
              if (!collapsed) {
                for (const t of terminalTabs) rows.push({ taskId: w.id, tabId: t.id });
              }
            }
          }
          if (rows.length <= 1) return;
          e.preventDefault();
          const activeTab = taskId ? state.activeTab[taskId] : undefined;
          let idx = rows.findIndex(r => r.taskId === taskId && r.tabId === activeTab);
          if (idx < 0) idx = rows.findIndex(r => r.taskId === taskId && !r.tabId);
          const dir = cmd === "sidebar-next" ? 1 : -1;
          const nextIdx = idx < 0
            ? (dir > 0 ? 0 : rows.length - 1)
            : (idx + dir + rows.length) % rows.length;
          const target = rows[nextIdx];
          state.setActiveTask(target.taskId);
          if (target.tabId) state.setActiveTabId(target.taskId, target.tabId);
          return;
        }

        // ⌘N → global project picker. Fires from anywhere (no active
        // task needed) so you can start a new task without first
        // selecting one. No `isTyping` guard, same as the file finder.
        case "new-task-quick":
          e.preventDefault();
          useUI.getState().openProjectPicker();
          return;

        // ⇧⌘P → toggle the command palette (open, or close if already open),
        // the VS Code / Sublime convention. MUST fire from anywhere, including
        // while focused in a terminal (the app is terminal-centric), so no
        // `isTyping` guard. ⌘K is the terminal-clear, as in any terminal.
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
        // too. Scoped to having an active task.
        case "file-finder":
          if (!taskId) return;
          e.preventDefault();
          useUI.getState().openFileFinder(taskId);
          return;

        // ⇧⌘F → find-in-files. Same no-`isTyping` rationale as the finder.
        case "find-in-files":
          if (!taskId) return;
          e.preventDefault();
          useUI.getState().openFindInFiles(taskId);
          return;

        // ⌘1..⌘9 → switch to Nth tab in the active task. Indexes the
        // full tab list so position matches the TabBar.
        case "jump-to-tab": {
          if (taskId && tabs.length > 0) {
            const n = Number(e.key) - 1;
            const t = tabs[n];
            // Focus must follow an explicit keyboard tab switch — otherwise
            // the previous (now visibility:hidden) tab keeps DOM focus and
            // still receives keystrokes. Sync activePaneId too: ⌘N targets
            // the MAIN pane, and a stale pointer keeps it dimmed.
            if (t) {
              e.preventDefault();
              state.setActiveTabId(taskId, t.id);
              const tree = state.splitTree[taskId];
              const mainLeafId = tree ? getAllLeaves(tree).find(l => l.isMain)?.id : undefined;
              if (mainLeafId) state.setActivePaneId(taskId, mainLeafId);
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
          if (!taskId) return;
          e.preventDefault();
          // Keep the store's active-pane pointer in step with the focus jump,
          // or the main pane stays dimmed / underline stays muted.
          const tree = state.splitTree[taskId];
          const mainLeafId = tree ? getAllLeaves(tree).find(l => l.isMain)?.id : undefined;
          if (mainLeafId) state.setActivePaneId(taskId, mainLeafId);
          focusMainTab(activeTabId);
          return;
        }

        // ⌥⌘↑ / ⌥⌘↓ → navigate panes up/down when a horizontal split exists;
        // otherwise cycle through tasks (same role as ⌘[/⌘]).
        case "task-prev-arrow":
        case "task-next-arrow": {
          const _tree = taskId ? state.splitTree[taskId] : undefined;
          const hasHSplit = _tree ? treeHasDir(_tree, 'h') : false;
          if (taskId && hasHSplit) {
            e.preventDefault();
            const dir = cmd === "task-next-arrow" ? 'down' : 'up';
            const next = navigatePane(state, taskId, dir);
            if (next) {
              state.setActivePaneId(taskId, next);
              const leaf = findLeaf(state.splitTree[taskId]!, next);
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
          // No horizontal split — navigate tasks.
          const _ws = awakeTasks();
          if (_ws.length <= 1) return;
          e.preventDefault();
          const _fwd = cmd === "task-next-arrow";
          const _idx = _ws.findIndex(w => w.id === taskId);
          const _next = _idx < 0
            ? (_fwd ? 0 : _ws.length - 1)
            : _fwd ? (_idx + 1) % _ws.length : (_idx - 1 + _ws.length) % _ws.length;
          state.setActiveTask(_ws[_next].id);
          return;
        }

        // ⌥⌘← / ⌥⌘→ → navigate panes left/right when a vertical split exists; no-op otherwise.
        case "tab-prev-arrow":
        case "tab-next-arrow": {
          const _tree2 = taskId ? state.splitTree[taskId] : undefined;
          const hasVSplit = _tree2 ? treeHasDir(_tree2, 'v') : false;
          if (!taskId || !hasVSplit) return;
          e.preventDefault();
          const dir = cmd === "tab-next-arrow" ? 'right' : 'left';
          const next = navigatePane(state, taskId, dir);
          if (next) {
            state.setActivePaneId(taskId, next);
            const leaf = findLeaf(state.splitTree[taskId]!, next);
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

        // ⇧⌘[ / ⇧⌘] → tab nav within active task. Focus-aware: when the
        // bottom-split shell owns focus, cycles the BOTTOM tabs instead.
        case "tab-prev":
        case "tab-next": {
          if (!taskId) return;
          const fwd = cmd === "tab-next";
          if (inBottom()) {
            const bottomTabs = state.bottomTabs[taskId] || [];
            if (bottomTabs.length > 1) {
              e.preventDefault();
              const idx = bottomTabs.findIndex(t => t.id === state.activeBottomTab[taskId]);
              const nextIdx = idx < 0
                ? (fwd ? 0 : bottomTabs.length - 1)
                : fwd ? (idx + 1) % bottomTabs.length : (idx - 1 + bottomTabs.length) % bottomTabs.length;
              const nextId = bottomTabs[nextIdx].id;
              state.setActiveBottomTab(taskId, nextId);
              // AuxTerminal deliberately doesn't grab focus when it becomes
              // active (so opening the split / switching tasks doesn't
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
            const tree = state.splitTree[taskId];
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
              state.setActiveTabId(taskId, next.tabId);
              if (mainLeafId) state.setActivePaneId(taskId, mainLeafId);
              focusMainTab(next.tabId);
            } else {
              state.setPaneActiveTab(taskId, next.paneId, next.tabId);
              state.setActivePaneId(taskId, next.paneId);
              focusPaneTab(next.tabId);
            }
          }
          return;
        }

        // ⌘[ / ⌘] → task nav across AWAKE tasks.
        case "task-prev":
        case "task-next": {
          const task = awakeTasks();
          if (task.length <= 1) return;
          e.preventDefault();
          const fwd = cmd === "task-next";
          const idx = task.findIndex(w => w.id === taskId);
          const nextIdx = idx < 0
            ? (fwd ? 0 : task.length - 1)
            : fwd ? (idx + 1) % task.length : (idx - 1 + task.length) % task.length;
          state.setActiveTask(task[nextIdx].id);
          return;
        }

        // ⇧⌘A → jump to the next agent that's waiting on you (issue #56).
        // Logic (order, "waiting" definition, queue-walk) is shared with the
        // top-bar jump pill in `@/lib/waitingAgents`. Only swallow the chord
        // when it actually jumped — otherwise let ⇧⌘A fall through.
        case "jump-next-waiting": {
          if (jumpToNextWaiting()) e.preventDefault();
          return;
        }

        // ⌘J → toggle the bottom-split terminal, VS Code-style (issue #45).
        // The whole show/hide + focus dance lives in the store so the command
        // palette can share it. NO `isTyping` guard — must fire from inside any
        // terminal (xterm's hidden textarea) and the editor (CodeMirror).
        case "toggle-terminal":
          if (!taskId) return;
          e.preventDefault();
          state.toggleBottomTerminal(taskId);
          return;

        // ⌘D → split focused pane right; ⇧⌘D → split focused pane below.
        case "split-pane-right": {
          if (!taskId) return;
          e.preventDefault();
          state.splitPane(taskId, 'v');
          return;
        }
        case "split-pane-below": {
          if (!taskId) return;
          e.preventDefault();
          state.splitPane(taskId, 'h');
          return;
        }

        // ⇧⌘B → open the Broadcast dialog for the active task.
        case "broadcast":
          if (!taskId) return;
          e.preventDefault();
          useUI.getState().openBroadcast(taskId);
          return;

        // ⌘= / ⌘- / ⌘0 → whole-app zoom, like a browser. Fire from
        // anywhere (including a focused terminal — these use Cmd, so the
        // Ctrl-in-terminal guard doesn't apply) and preventDefault so the
        // keystroke never leaks to the shell.
        case "zoom-in":
          e.preventDefault();
          usePrefs.getState().nudgeUiScale(1);
          return;
        case "zoom-out":
          e.preventDefault();
          usePrefs.getState().nudgeUiScale(-1);
          return;
        case "zoom-reset":
          e.preventDefault();
          usePrefs.getState().setUiScale(APPEARANCE_DEFAULTS.uiScale);
          return;

        // ⌥⌘P → toggle the prompt palette. Same no-`isTyping` rationale as
        // ⇧⌘P's command palette.
        case "prompt-palette": {
          e.preventDefault();
          const ui = useUI.getState();
          if (ui.promptPaletteOpen) ui.closePromptPalette();
          else ui.openPromptPalette();
          return;
        }

        // ⌘T → new tab, behaviour depends on which pane has focus. NO
        // `isTyping` guard (xterm's hidden textarea).
        case "new-tab": {
          if (!taskId) return;
          e.preventDefault();
          if (inBottom()) {
            state.addBottomTab(taskId);
          } else if (inSplitPane()) {
            const focusedLeaf = (document.activeElement as HTMLElement | null)
              ?.closest?.("[data-split-leaf]") as HTMLElement | null;
            const paneId = focusedLeaf?.getAttribute("data-pane-id") ?? null;
            if (paneId) window.dispatchEvent(new CustomEvent("termic-pane-new-tab-menu", { detail: { taskId, paneId } }));
          } else {
            // Main pane: open the "+" tab menu.
            window.dispatchEvent(new CustomEvent("termic-new-tab-menu", { detail: { taskId } }));
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
          if (inBottom() && taskId) {
            const bottomId = state.activeBottomTab[taskId];
            if (bottomId) state.closeBottomTab(taskId, bottomId);
            return;
          }
          if (inSplitPane() && taskId) {
            // Always derive pane from DOM focus — activePaneId[taskId] is only updated
            // on mouse clicks and can be stale after keyboard navigation.
            const focusedEl = (document.activeElement as HTMLElement | null)
              ?.closest?.("[data-split-leaf]") as HTMLElement | null;
            const paneId = focusedEl?.getAttribute("data-pane-id") ?? null;
            if (paneId) {
              const tree = state.splitTree[taskId];
              const leaf = tree ? findLeaf(tree, paneId) : null;
              const activeTabIdInPane = leaf?.activeTabId ?? (leaf as any)?.tabId ?? null;
              if (activeTabIdInPane && leaf) {
                // Confirm-gated (dirty editor / live agent), same as the main
                // path. Only collapse the emptied pane if the close went through.
                const wasLastTab = (leaf.tabIds?.length ?? 1) <= 1;
                void requestClosePaneTab(taskId, paneId, activeTabIdInPane).then(closed => {
                  if (closed && wasLastTab) useApp.getState().closePane(taskId, paneId);
                });
              } else {
                state.closePane(taskId, paneId);
              }
              return;
            }
          }
          if (taskId && activeTabId && inMainPane()) { requestCloseTab(taskId, activeTabId); return; }
          // Focus outside every pane (file tree / sidebar): still close a
          // PREVIEW tab. Previews open from a single click in the tree, so
          // focus never enters the pane — without this, ⌘W right after
          // previewing a file is a silent no-op. Regular tabs keep the
          // inMainPane guard (⌘W from the sidebar must not eat real tabs).
          if (taskId) {
            // Prefer the pane the preview actually lives in: openPreviewTab
            // targets the focused split pane, tracked by activePaneId.
            const tree = state.splitTree[taskId];
            const paneId = state.activePaneId[taskId];
            const leaf = tree && paneId ? findLeaf(tree, paneId) : null;
            if (leaf && !leaf.isMain && leaf.activeTabId) {
              const paneTab = (state.tabs[taskId] ?? []).find(t => t.id === leaf.activeTabId);
              if (paneTab?.preview) {
                const wasLastTab = (leaf.tabIds?.length ?? 1) <= 1;
                void requestClosePaneTab(taskId, leaf.id, paneTab.id).then(closed => {
                  if (closed && wasLastTab) useApp.getState().closePane(taskId, leaf.id);
                });
                return;
              }
            }
            const mainTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
            if (mainTab?.preview) requestCloseTab(taskId, mainTab.id);
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

