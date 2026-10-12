// Global keyboard shortcuts. The actual key combos are CONFIGURABLE — the
// source of truth for which command exists + its default combo lives in
// `src/lib/shortcuts.ts`, and the user's overrides live in the prefs store
// (`usePrefs().shortcuts`). This handler reads the resolved bindings live and
// dispatches the matching command. The default combos (for reference):
//   ⌘1..⌘9   → switch to the Nth tab in the active task
//   ⌘L       → focus the active task's terminal
//   ⌘[, ⌘]   → previous / next task (cycles AWAKE ones in sidebar order);
//              in a folder listing with history, back / forward instead
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
//   ⌃⇥, ⌃⇧⇥ → walk the recently-used tabs (a GESTURE, not a binding: see
//              below; its modifier and key are recordable in Settings)
//   ⇧⇧       → search everywhere (double-Shift; it also has a chord, which
//              ships unbound)
//   Shortcuts cheat-sheet: icon-only, no keyboard binding
import { useEffect, useRef } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs, APPEARANCE_DEFAULTS } from "@/store/prefs";
import { useNavHistory } from "@/store/navHistory";
import { trackDoubleShift, NO_TAPS, type TapState } from "@/lib/doubleTap";
import { buildRing, end as endCtrlTab, endsGesture, IDLE, step as stepCtrlTab, type CtrlTabState } from "@/lib/ctrlTab";
import { currentPlace, livePlaces } from "@/lib/recentPlacesTracker";
import { useRecentPlaces, resumeRecording, suspendRecording } from "@/store/recentPlaces";
import { requestCloseTab, requestClosePaneTab } from "@/lib/closeTab";
import { shouldCloseProfileWindow } from "@/lib/profileScope";
import { windowCloseIfNotLast } from "@/lib/ipc";
import { useProfiles } from "@/store/profiles";
import { focusMainTab, focusPaneTab } from "@/lib/tabFocus";
import { jumpToNextWaiting } from "@/lib/waitingAgents";
import { newScratchTab } from "@/lib/scratchTabs";
import { dirHistoryTarget, goDirHistory } from "@/lib/dirTabs";
import {
  bindingMatches, eventCode, eventKeyToken, holdHeld, holdReleased, IS_MAC, SHORTCUT_DEFS,
  type HoldGesture, type ShortcutId,
} from "@/lib/shortcuts";
import { isTerminalCloseCombo } from "@/lib/terminalFind";
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
  // Double-tap state for the Shift gesture, in a ref so a re-render never
  // loses a half-finished tap.
  const doubleShift = useRef<TapState>(NO_TAPS);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // macOS: inside a focused terminal, Ctrl is the terminal's OWN modifier
      // (readline / TUI editor bindings: ^P ^W ^K ^T ^A ^E ^R …). The app folds
      // Cmd≡Ctrl so its shortcuts fire cross-platform, but that fold would
      // swallow every Ctrl combo before the PTY ever sees it. When only Ctrl
      // (not Cmd) is down and a terminal has focus, bail so the keystroke
      // reaches the shell/editor. App shortcuts still work via Cmd. (issue #10)
      if (IS_MAC && e.ctrlKey && !e.metaKey && inTermFocused()) return;

      // Double-Shift → Search Everywhere (GH #174), JetBrains' gesture. Not a
      // registry binding because the registry describes chords, and this is a
      // double tap of a modifier with nothing else in it. Files always, and
      // symbols where a checkout is armed — most people never turn code
      // intelligence on, so a symbols-only dialog would be a dead key for
      // them (see SearchEverywhereDialog).
      // Four modes, chosen in Settings -> Shortcuts: this is two taps of the
      // key that also starts every capital letter, so a fast typist can open a
      // dialog over what they are writing, and there is no other key to move
      // it to. Default is the LEFT Shift alone, which keeps the gesture while
      // dropping the hand most accidents come from.
      const dsMode = usePrefs.getState().doubleShiftMode;
      // "outside-terminal" skips the tracking entirely rather than firing and
      // closing: a terminal is where the typing is, and a gesture that costs a
      // dialog flash on every fast capital is the thing being turned off.
      const dsSkip = dsMode === "off"
        || (dsMode === "outside-terminal" && inTermFocused());
      if (!dsSkip) {
        const tap = trackDoubleShift(doubleShift.current, e.key, e.timeStamp || Date.now(), {
          repeat: e.repeat,
          otherModifier: e.metaKey || e.ctrlKey || e.altKey,
          location: e.location,
          leftOnly: dsMode === "left",
        });
        doubleShift.current = tap.state;
        if (tap.fired) {
          const id = useApp.getState().activeTaskId;
          if (id) {
            e.preventDefault();
            useUI.getState().openSearchEverywhere(id);
            return;
          }
        }
      }



      const binds = usePrefs.getState().shortcuts;
      // First binding (in registry order) whose combo the event satisfies.
      // Exact modifier matching makes commands mutually exclusive unless the
      // user has created a conflict (the settings page warns about those);
      // first-match-wins resolves a conflict deterministically.
      let cmd: ShortcutId | null = null;
      for (const def of SHORTCUT_DEFS) {
        if (bindingMatches(e, binds[def.id])) { cmd = def.id; break; }
      }
      // Off macOS, Ctrl+Shift+W is close-tab's second chord: the one that
      // works from inside a terminal, where plain Ctrl+W is the shell's. Only
      // when no binding claimed the chord, so a user's own Ctrl+Shift+W wins.
      if (!cmd && isTerminalCloseCombo(e, IS_MAC)) cmd = "close-tab";
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

        // ⌘O → global task finder. Quick search and switch tasks across projects.
        // Fires from anywhere, including inside a focused terminal.
        case "task-finder": {
          e.preventDefault();
          const ui = useUI.getState();
          if (ui.taskFinderOpen) ui.closeTaskFinder();
          else ui.openTaskFinder();
          return;
        }

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

        // ⌥⌘T → the theme list, or close it, same toggle as the palette.
        case "change-theme": {
          e.preventDefault();
          const ui = useUI.getState();
          if (ui.commandPaletteOpen) ui.closeCommandPalette();
          else ui.openCommandPalette("theme");
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

        // Search everywhere's chord: unbound by default (double-Shift is the
        // gesture), so this only fires once somebody records one. Reaches here
        // from a focused terminal through TerminalPane's PASS_TO_APP: on macOS
        // with Cmd, elsewhere only if the chord carries Shift or Alt.
        case "search-everywhere":
          if (!taskId) return;
          e.preventDefault();
          useUI.getState().openSearchEverywhere(taskId);
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
              // setActiveBottomTab moves focus into the newly-active shell.
              state.setActiveBottomTab(taskId, nextId);
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
        case "nav-back":
        case "nav-forward": {
          // Back and Forward. Two histories, one meaning, no fallback.
          //
          // This used to switch tasks, with the folder listing and then the
          // jump trail claiming the key conditionally on top of that: three
          // behaviours chosen by where focus happened to be, each with its own
          // escape hatch so it "never silently stole" the chord. All of that
          // machinery existed to protect task switching, which ⌥⌘↑ / ⌥⌘↓
          // already do (and do inside a split, which this never did). Removing
          // it removes the conditionals with it.
          //
          // The folder listing goes first because it is the more local
          // history and the one you can see; `dirHistoryTarget` is a pure
          // function over DOM-focus facts, so which listing may claim the key
          // stays unit-testable instead of inline here.
          if (!taskId) return;
          const forward = cmd === "nav-forward";
          const active = document.activeElement as HTMLElement | null;
          const splitEl = inSplitPane()
            ? (active?.closest?.("[data-split-leaf]") as HTMLElement | null)
            : null;
          const candidateId = dirHistoryTarget(state, taskId, {
            inBottom: inBottom(),
            splitPaneId: splitEl?.getAttribute("data-pane-id") ?? null,
            inMainPane: inMainPane(),
            noFocus: !active || active === document.body,
          });
          if (candidateId && goDirHistory(taskId, candidateId, forward ? 1 : -1)) {
            e.preventDefault();
            return;
          }
          // Then the jump trail. No pref check and no focus check: the trail
          // only has entries because somebody followed a symbol, and having
          // followed one, Back should work from wherever they ended up.
          const history = useNavHistory.getState();
          if (forward ? history.canForward() : history.canBack()) {
            e.preventDefault();
            void (async () => {
              const nav = await import("@/lib/lsp/navigate");
              await (forward ? nav.goForward(null) : nav.goBack(null));
            })();
          }
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

        case "create-pr":
          if (!taskId) return;
          e.preventDefault();
          useUI.getState().openCreatePr(taskId);
          return;

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

        // ⌥⌘N → new scratchpad in the active task (GH #244). Needs a task:
        // pads live in a task's strip, so with none active there is nowhere
        // to put one.
        case "new-scratchpad":
          if (!taskId) return;
          e.preventDefault();
          void newScratchTab(taskId);
          return;

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
            return;
          }
          // Nothing left in this window to close, so the window IS the
          // innermost thing: close the profile, the way the last tab takes a
          // browser window with it. Never the LAST window, which would be a
          // quit rather than a close (see `shouldCloseProfileWindow`).
          //
          // Rust owns the last-window check and closes through the ordinary
          // CloseRequested path, which is what destroys a non-root profile
          // window, clears `open_at_quit` so launch restore does not bring it
          // back, and rebuilds the tray. The rule here is only "is this window
          // empty enough for the shortcut to mean the window"; being wrong
          // about the WINDOW COUNT would mean quitting the app by accident,
          // and this store can be a moment stale after a sibling closes.
          if (shouldCloseProfileWindow({
            hasActiveTask: !!taskId,
            openWindows: useProfiles.getState().profiles.filter(p => p.open).length,
          })) {
            void windowCloseIfNotLast().catch(() => {});
          }
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useCtrlTabWalk();
}

/**
 * Recently used tabs: hold a modifier, tap a key to step back through the
 * tabs you were actually looking at; Shift steps the other way; releasing the
 * modifier lands. ⌃⇥ / ⌃⇧⇥ by default, and both halves are recordable in
 * Settings (`prefs.recentTabsGesture`, a HoldGesture: the held modifier, and
 * the tapped key by `KeyboardEvent.code`).
 *
 * Its own effect, and its own listeners, because it is not a chord and cannot
 * be one:
 *
 *  1. A `Binding` has no way to say "Ctrl but not Cmd" — `bindingMatches`
 *     folds the two — so this cannot live in SHORTCUT_DEFS. It is a
 *     GESTURE_SHORTCUTS entry instead.
 *  2. It needs keyup, which no other shortcut in the app does: the walk only
 *     lands when the held modifier comes up.
 *  3. It has to run BEFORE the Ctrl-in-a-terminal bail in `onKey` above, and
 *     before xterm. Both are achieved by being a separate listener in an
 *     EARLIER PHASE (window capture) rather than by ordering code inside
 *     `onKey` — xterm listens on its own textarea, so nothing registered on
 *     the bubble phase ever sees the key: its `cancel()` calls
 *     stopPropagation, not just preventDefault. The same phase is what keeps
 *     an Option hold out of the PTY: with Option as Meta, xterm would send
 *     the tapped key down as an ESC sequence.
 *
 * On taking a Ctrl chord away from the terminal at all (GH #10 gave Ctrl to
 * readline deliberately): with the default ⌃⇥ nothing observable is lost.
 * xterm's `evaluateKeyboardEvent` reads only `shiftKey` for Tab, so ⌃⇥ goes
 * down the PTY as a plain `\t` and ⌃⇧⇥ as a plain `ESC[Z` — byte-identical to
 * ⇥ and ⇧⇥, which still reach the shell untouched. The recorder refuses
 * Ctrl+letter and the keys that make a control character for exactly this
 * reason (those ARE readline's), and every other key something else needs
 * (holdGestureError, docs/shortcuts.md). It is still
 * switchable off in Settings, for anyone who wants that rule to have no
 * exceptions at all.
 *
 * A Cmd hold (macOS only): WebKit drops the keyup of a non-modifier key while
 * Cmd is held, so the tapped key's keyup may never arrive. Landing reads the
 * modifier's own release (`holdReleased`), which does.
 *
 * `useShortcuts` is called once (App.tsx), so this is the app-wide claim
 * gotchas.md prescribes — the warning there is about listeners in components
 * that stay MOUNTED PER TASK, where several instances answer "is this mine?"
 * yes at once.
 */
function useCtrlTabWalk() {
  // In a ref, like the double-Shift tracker: a re-render mid-gesture must not
  // drop a half-finished walk.
  const walk = useRef<CtrlTabState>(IDLE);
  // The gesture the walk in flight STARTED with. A config-sync pull that
  // rebinds it mid-walk must not change which release lands it.
  const held = useRef<HoldGesture | null>(null);

  useEffect(() => {
    const { onKeyDown, onKeyUp, onBlur } = recentTabsWalkHandlers(walk, held);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}

/** The walk's three listeners over its two refs, outside the hook so the
 *  key handling is testable without rendering anything. */
export function recentTabsWalkHandlers(
  walk: { current: CtrlTabState },
  held: { current: HoldGesture | null },
): { onKeyDown: (e: KeyboardEvent) => void; onKeyUp: (e: KeyboardEvent) => void; onBlur: () => void } {
  /** True when the key is not ours to take right now. */
  function standDown(): boolean {
    if (usePrefs.getState().ctrlTabMode === "off") return true;
    // Both halves are needed, and gotchas.md says why: the hand-rolled
    // Settings overlay traps and autofocuses nothing, so `activeElement`
    // never enters it and only the store flag sees it. Without this, the
    // first press of a walk would close Settings, because `setActiveTask`
    // replaces `view` rather than spreading it. It is also what lets the
    // Settings recorder record the gesture itself.
    if (useApp.getState().view.settingsOpen) return true;
    return !!(document.activeElement as HTMLElement | null)?.closest?.('[role="dialog"]');
  }

  /** Finish the walk: land properly on wherever it stopped. */
  function land() {
    const { commit, origin } = endCtrlTab(walk.current);
    walk.current = IDLE;
    held.current = null;
    if (commit) {
      const app = useApp.getState();
      // `setActiveTask` resets the DEPARTING tab's activity timestamps so
      // the idle heuristic needs a fresh input→output cycle. It derives
      // "departing" from `activeTaskId`, which the walk has already moved,
      // so do it here where both ends are known — and only for a real move
      // between tasks, or a walk that wrapped home would fire it for nothing.
      if (origin && origin.taskId !== commit.taskId) {
        const from = (app.tabs[origin.taskId] ?? []).find(t => t.id === origin.tabId);
        if (from?.type === "terminal") {
          app.patchTab(origin.taskId, origin.tabId, { lastInputAt: null, lastOutputAt: null });
        }
      }
      // The real setters, the same path a click takes, so the arrival
      // bookkeeping (badges cleared, project expanded, recents) happens
      // exactly once — for the place the user actually stopped on, never for
      // the ones they flashed past.
      app.setActiveTask(commit.taskId);
      app.setActiveTabId(commit.taskId, commit.tabId);
      // Recorded explicitly rather than left to the tracker: the pointers
      // ALREADY hold the destination by now, so there is no guarantee the
      // commit changes them and fires the subscription.
      useRecentPlaces.getState().push(commit);
      // Focus must follow a keyboard switch, or the tab that just left keeps
      // it and still receives keystrokes (panes stay mounted, so a hidden one
      // can still hold focus). Terminals re-focus themselves when their task
      // becomes active, but an EDITOR tab in another task does not, so this
      // is the only thing that lands focus in that case. Once per gesture,
      // not once per step, so the ordinary retry budget is right here.
      focusMainTab(commit.tabId);
    }
    // After the tracker's own pending flush, which must still see the walk
    // as in flight so it does not re-record what was just pushed.
    queueMicrotask(resumeRecording);
  }

  function onKeyDown(e: KeyboardEvent) {
    const state = walk.current;
    const g = held.current ?? usePrefs.getState().recentTabsGesture;
    const code = eventCode(e);
    // Exactly the one modifier: ⌥⌃⇥ is somebody else's chord.
    if (code === g.code && holdHeld(e, g.hold)) {
      if (!state.active && standDown()) return;
      // Claimed even when there is nowhere to go. The alternative is that
      // the key silently types into whatever agent has focus, depending on
      // state the user cannot see; a key that does nothing beats a key that
      // does something unwanted in a prompt. preventDefault is also what
      // keeps an Option + ` hold from starting a dead-key composition.
      e.preventDefault();
      e.stopPropagation();
      const next = stepCtrlTab(state, {
        shift: e.shiftKey,
        repeat: e.repeat,
        ring: () => buildRing(currentPlace(), livePlaces()),
      });
      // Only once a walk has actually begun. An auto-repeat as the first
      // keydown (the key was held while a dialog closed) leaves the walk
      // idle, and only a landing undoes these two, which needs a live walk:
      // the gesture would stay pinned and recording suspended for good.
      if (!state.active && next.state.active) { suspendRecording(); held.current = g; }
      walk.current = next.state;
      if (next.target) useApp.getState().previewPlace(next.target.taskId, next.target.tabId);
      return;
    }
    // A real keystroke ends the walk, and is NOT swallowed: the user meant
    // it for whatever is now on screen. Modifiers and auto-repeats do not
    // end it — Shift is how the walk reverses, and the held modifier
    // repeats for as long as it is down.
    if (state.active && endsGesture(e.key, e.repeat, code, g.code)) land();
  }

  function onKeyUp(e: KeyboardEvent) {
    if (!walk.current.active) return;
    const g = held.current ?? usePrefs.getState().recentTabsGesture;
    // xterm calls focus() on itself for any non-modifier keyup, which during
    // a walk would pull focus into a terminal that is on its way off screen.
    if (eventCode(e) === g.code) { e.preventDefault(); e.stopPropagation(); }
    // Off the modifier flag rather than the released key's name, as
    // modKeyClass does: the name misses a release that arrives while another
    // modifier is down, and misses synthetic sequences in tests.
    if (holdReleased(e, g.hold)) land();
  }

  // NON-capture, and that is load-bearing. `blur` does not bubble but it
  // DOES capture, so a capture listener would see every element blur — and
  // the walk causes them, by hiding the pane it is leaving. It would abort
  // on the first press. Same reasoning as modKeyClass.
  function onBlur() { if (walk.current.active) land(); }

  return { onKeyDown, onKeyUp, onBlur };
}

function inTermFocused() {
  return !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
}

