// Single Zustand store. Mirrors the legacy `state` object but with React-shaped
// updates (immutable replacements, not in-place mutations).

import { create } from "zustand";
import type { Project, Workspace, Tab, TerminalTab, PersistedTab, SplitTree, PaneLeaf, SplitDir } from "@/lib/types";
import type { SplitNode as _SplitNode } from "@/lib/splitTree";
import {
  findLeaf, getAllLeaves, countLeaves, replaceNode, removeLeaf,
  updateLeafTabId, updateSplitRatio, findAdjacentPane, equalizeSplitsOnAxis,
} from "@/lib/splitTree";
import * as ipc from "@/lib/ipc";
import { focusTerminalTab, focusMainTab } from "@/lib/tabFocus";
import { agentDisplayName } from "@/lib/agents";

interface View {
  /** Underlying page — dashboard / history / empty. NOT "settings": Settings
   *  is a separate overlay flag (`settingsOpen`), so closing it returns to
   *  whatever this page was. */
  page: "dashboard" | "history" | "empty";
  /** True when the Settings overlay is up. The overlay renders on top of
   *  the main app layout (see App.tsx) so the active workspace, terminals,
   *  and panel state all stay intact while it's open. */
  settingsOpen?: boolean;
  /** When the Settings overlay is open, which section is selected. */
  settingsTab?: "general" | "appearance" | "agents" | "prompts" | "repositories" | "shortcuts";
  /** When viewing a repository's settings, which project id is active. */
  settingsRepoId?: string;
}

interface AppState {
  projects: Project[];
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** workspace id → tab list */
  tabs: Record<string, Tab[]>;
  /** workspace id → active tab id */
  activeTab: Record<string, string>;
  view: View;
  compactSidebar: boolean;
  rightPanelHidden: boolean;
  /** Sidebar width in px (full mode). Compact mode is a fixed 56px. */
  sidebarWidth: number;
  /** Right panel width in px. */
  rightPanelWidth: number;
  /** Right panel footer (Setup/Run/Terminal subtabs) height in px. */
  rightFooterHeight: number;
  /** Per-workspace: whether the main pane is split horizontally (agent on
   *  top, scratch shell on the bottom). Persisted in localStorage so it
   *  survives reloads. */
  terminalSplit: Record<string, boolean>;
  /** Per-workspace: pixel height of the bottom split terminal. */
  terminalSplitHeight: Record<string, number>;
  /** Per-workspace: bottom split collapsed = panel shrinks to just the
   *  tab strip; AuxTerminals stay mounted so shells keep running.
   *  Distinct from `terminalSplit=false`, which fully unmounts and
   *  kills the shells. Persisted. */
  terminalSplitCollapsed: Record<string, boolean>;
  /** Per-workspace: bottom-terminal tab IDs (each = its own scratch shell).
   *  Lives in memory only — like the main terminal tabs, PTYs die with the app. */
  bottomTabs: Record<string, { id: string; title: string; liveTitle?: string; autoFocus?: boolean }[]>;
  /** Per-workspace: id of the active bottom-terminal tab. */
  activeBottomTab: Record<string, string>;
  /** Per-workspace: the iTerm-like split-pane tree for the main content area.
   *  Absent = single pane (legacy/simple mode). A SplitNode at the root means
   *  at least two panes are showing. Session-only — not persisted. */
  splitTree: Record<string, SplitTree>;
  /** Per-workspace: id of the leaf pane node that has keyboard focus.
   *  Absent = main pane is active (no splits or main leaf focused). */
  activePaneId: Record<string, string>;
  /** Per-workspace: the pane that was focused just before the current one.
   *  Used to restore focus on close and to prefer the origin pane on
   *  reverse navigation. */
  /** Per-tab focus history stack (newest first, capped at 10).
   *  Used to restore focus to the last-used pane when the active one is closed. */
  paneHistory: Record<string, string[]>;
  /** Workspaces the user has activated this session. We keep them rendered
   *  (hidden) after switching away so terminals + PTYs stay alive. Cleared
   *  on app restart — survival is intentionally per-session. */
  mountedWorkspaces: Set<string>;
  /** Per-workspace: has the user explicitly opened a Terminal tab inside the
   *  right-panel footer? Default false — we don't auto-spawn the scratch
   *  shell. Flips true when the user clicks the "+terminal" icon. */
  footerTerm: Record<string, boolean>;
  /** Per-project collapse state in the sidebar. true = workspaces hidden.
   *  Persisted to localStorage so the user's tree shape survives launches. */
  collapsedProjects: Record<string, boolean>;
  collapsedWorkspaces: Record<string, boolean>;
  /** Editable agent registry from settings.json. Loaded by `loadAll` so
   *  `spawnArgsForCli` can consult `agent.command + args + capabilities`
   *  instead of hard-coding by CLI string. Empty until first loadAll. */
  agents: import("@/lib/types").Agent[];
  /** PATH-detection results keyed by agent id. Empty until `refreshClis`
   *  first resolves — an empty map means "show every agent" so the
   *  pickers are never stranded before/without detection. Drives the
   *  install badge in Settings and the hide-uninstalled picker filter. */
  detectedClis: Record<string, import("@/lib/types").CliInfo>;
  /** Per-project spotlight: project_id → ws_id of the currently spotlighted
   *  workspace, or absent if none. Updated by spotlight://status events and
   *  hydrated from the Rust side on app start. Session-only (not persisted). */
  spotlightWsId: Record<string, string>;
  /** Set or clear the spotlighted workspace for a project. */
  setSpotlight: (projectId: string, wsId: string | null) => void;

  // ── actions ──
  loadAll: () => Promise<void>;
  /** Re-probe each agent's command for installed-ness. Fired once at
   *  startup (App mount) and whenever Settings → Agent CLIs opens —
   *  deliberately NOT on every window focus. */
  refreshClis: () => Promise<void>;
  setActiveWorkspace: (id: string | null) => void;
  setView: (page: View["page"]) => void;
  openSettings: (tab?: View["settingsTab"], repoId?: string) => void;
  closeSettings: () => void;
  toggleCompactSidebar: () => void;
  toggleRightPanel: () => void;
  /** Request the "All files" tree reveal a path: un-hides the right panel and
   *  signals RightPanel/FileTree to switch to files, expand ancestors, scroll
   *  and highlight. `isDir` expands the path itself (folder breadcrumb segment);
   *  false reveals a file (expand its ancestors only). Transient one-shot. */
  revealFile: { wsId: string; path: string; isDir: boolean; nonce: number } | null;
  revealInTree: (wsId: string, path: string, isDir: boolean) => void;
  clearReveal: () => void;
  setSidebarWidth: (px: number) => void;
  setRightPanelWidth: (px: number) => void;
  setRightFooterHeight: (px: number) => void;
  toggleTerminalSplit: (wsId: string) => void;
  enableFooterTerm: (wsId: string) => void;
  disableFooterTerm: (wsId: string) => void;
  setProjectCollapsed:   (projectId: string, collapsed: boolean) => void;
  setWorkspaceCollapsed: (wsId: string,      collapsed: boolean) => void;
  /** Bulk set: flips every workspace's explicit collapsed state to the
   *  given value in one update (single localStorage write + render). */
  setAllWorkspacesCollapsed: (collapsed: boolean) => void;
  setTerminalSplitHeight: (wsId: string, px: number) => void;
  toggleTerminalSplitCollapsed: (wsId: string) => void;
  toggleBottomTerminal: (wsId: string) => void;
  /** Returns the id of the new bottom tab. `focus` (default true) marks the
   *  fresh shell to grab focus once it spawns; pass false for the auto-seed
   *  on split-open / launch-restore so it can't yank focus off the agent. */
  addBottomTab: (wsId: string, opts?: { focus?: boolean }) => string;
  closeBottomTab: (wsId: string, tabId: string) => void;
  setActiveBottomTab: (wsId: string, tabId: string) => void;
  /** Update a bottom-shell tab's live OSC 0/2 title (what the shell emits,
   *  e.g. the running command or cwd). Falls back to the base "shell N" when
   *  empty. Idempotent. */
  setBottomTabLiveTitle: (wsId: string, tabId: string, liveTitle: string) => void;
  /** Split the currently focused pane (or `paneId`) in the given direction.
   *  dir 'v' = add new pane to the right; 'h' = add new pane below.
   *  Returns the new leaf pane's id. */
  splitPane: (wsId: string, dir: SplitDir, paneId?: string) => string;
  /** Close a split pane (its sibling takes the freed space). Kills the pane's tab PTY. */
  closePane: (wsId: string, paneId: string) => void;
  /** Set which split-pane leaf has keyboard focus. */
  setActivePaneId: (wsId: string, paneId: string) => void;
  /** Adjust the ratio of a SplitNode (called from the resize handle). */
  setSplitRatio: (wsId: string, splitId: string, ratio: number) => void;
  /** Drag-to-rearrange: move source leaf to a drop zone adjacent to target. */
  movePaneTo: (wsId: string, sourcePaneId: string, targetPaneId: string, zone: 'left' | 'right' | 'top' | 'bottom') => void;
  /** Once the SplitLauncher in an empty leaf has chosen a cli, create the tab
   *  and wire it into the leaf. Returns the new tab id. */
  addPaneTab: (wsId: string, paneId: string, cli: string) => string;

  /** Restore the workspace's durable agent tabs from `persisted_tabs` if
   *  any (quit → reopen → everything back, each id-capable tab resuming its
   *  own session), else seed a single default tab. No-op once the workspace
   *  already has tabs in memory. */
  ensureDefaultTab: (wsId: string, cli: string) => void;
  /** Recompute the workspace's durable agent-tab list from the current
   *  in-memory tabs (drops shell / scratch tabs), mirror it onto the
   *  in-memory workspace, and persist to disk via `workspaceSetTabs`. Call
   *  after any add / close / reorder / rename so quit-restore stays accurate
   *  and an X-close is durably forgotten. */
  syncDurableTabs: (wsId: string) => void;
  /** Persist the active split-tree JSON for `wsId` to disk so the layout
   *  survives a relaunch. No-op when the layout hasn't changed. */
  saveSplitLayout: (wsId: string) => void;
  /** Explicit "close & forget": close the tab AND drop the agent from the
   *  durable set so it does NOT auto-resume on reopen. For secondary tabs
   *  plain closeTab already forgets; this exists for the one case closeTab
   *  deliberately keeps durable — the MAIN tab. */
  forgetTab: (wsId: string, tabId: string) => void;
  /** Pin (or clear, via "") a single tab's termic-owned session uuid:
   *  updates the in-memory tab AND its persisted_tabs entry, then persists
   *  to disk. Keyed by tab id so agents in one workspace resume
   *  independently. */
  setTabSessionId: (wsId: string, tabId: string, uuid: string) => void;
  /** Mirror a just-persisted custom launch command into the in-memory
   *  workspace AND any open custom-command tabs so the next PTY respawn
   *  runs the new script (the disk write alone doesn't refresh either). */
  setWorkspaceCustomCommand: (wsId: string, command: string) => void;
  /** Mirror a workspace's resume-args override into the store so the next
   *  PTY spawn in THIS session reads it (the disk write alone doesn't
   *  refresh the loaded workspace). Empty string clears it. */
  setWorkspaceResumeOverride: (wsId: string, command: string) => void;
  /** Optimistically set a workspace's YOLO flag in the store. The caller
   *  persists via ipc.workspaceSetYolo. */
  setWorkspaceYolo: (wsId: string, yolo: boolean) => void;
  addTab: (wsId: string, tab: Tab) => void;
  /** Move `tabId` to `toIndex` — its final position in the list AFTER the
   *  tab is pulled out (i.e. an index into the other tabs, 0..length-1).
   *  No-op if the order is unchanged. */
  reorderTab: (wsId: string, tabId: string, toIndex: number) => void;
  closeTab: (wsId: string, tabId: string) => void;
  setActiveTabId: (wsId: string, tabId: string) => void;
  persistTab: (wsId: string, tabId: string) => void;
  openPreviewTab: (wsId: string, data: { type: "edit" | "diff"; path: string; title: string; revealAt?: { line: number; col?: number } }) => void;
  /** Clear an edit tab's `revealAt` after EditorPane has consumed it,
   *  so a re-render doesn't re-jump the cursor. */
  consumeReveal: (wsId: string, tabId: string) => void;
  patchTab: (wsId: string, tabId: string, patch: Partial<Tab>) => void;
  /** Append a message to an agent tab's queue and wake the drain engine.
   *  Shared by the message-queue button and the prompt library so the
   *  queueKick-bump protocol (don't rely on a queueActive false->true edge)
   *  lives in exactly one place. No-op for non-terminal tabs. */
  enqueueAgentMessage: (wsId: string, tabId: string, text: string, repeat?: number) => void;
  /** Force the head queued message out immediately (the "Send now" button),
   *  even while the agent is mid-turn. Bumps `queueForceKick`, which a
   *  dedicated TerminalPane effect watches and drains without the mid-turn
   *  guard. No-op for non-terminal tabs or an empty/inactive queue. */
  forceAgentQueueSend: (wsId: string, tabId: string) => void;
  renameTab: (wsId: string, tabId: string, title: string) => void;
  clearTabCustomTitle: (wsId: string, tabId: string) => void;
  /** Update the tab's PTY-driven `OSC 0/2` title. No-op when the user
   *  has manually renamed the tab (`customTitle === true`). */
  setTabLiveTitle: (wsId: string, tabId: string, liveTitle: string) => void;
  markAttention: (wsId: string, tabId: string, reason: "bell" | "idle" | "exit" | "done" | "attention") => void;
  clearAttention: (wsId: string, tabId: string) => void;
  /** Per-tab work-progress state. Idempotent — writing the same value is
   *  a no-op so we don't churn React for every OSC 9;4 the agent emits. */
  setWorkState: (wsId: string, tabId: string, state: "idle" | "working" | "done") => void;
  /** ConEmu OSC 9;4 progress: pct 0..100 + kind (1 normal / 2 err /
   *  3 indeterminate / 4 warn). Null pct = indeterminate.
   *  Idempotent (no-op on equal values). */
  setWorkProgress: (wsId: string, tabId: string, pct: number | null, kind: 1 | 2 | 3 | 4) => void;
  /** Per-workspace "files on disk may have changed" tick. Bumped when an
   *  agent terminal settles (workState leaves "working"), the cheap stand-in
   *  for an FS watcher: the file tree, open editor tabs, and the Git panel
   *  re-read on the rising edge. Ephemeral (not persisted). */
  fsRevision: Record<string, number>;
  bumpFsRevision: (wsId: string) => void;
}

const LS_COMPACT = "compactSidebar";
const LS_RPANEL  = "rightPanelHidden";
const LS_SPLIT   = "terminalSplit";       // Record<wsId, boolean>
const LS_SPLITH  = "terminalSplitHeight"; // Record<wsId, number>
const LS_SPLITC  = "terminalSplitCollapsed"; // Record<wsId, boolean>
// Note: split tree (splitTree, activePaneId) is session-only, not persisted.
// Split pane layout always starts fresh; PTYs are ephemeral across launches.
const LS_SBW     = "sidebarWidth";
const LS_RPW     = "rightPanelWidth";
const LS_RFH     = "rightFooterHeight";
const LS_COLLAPSED_PROJ = "collapsedProjects"; // Record<projId, true>
const LS_COLLAPSED_WS   = "collapsedWorkspaces"; // Record<wsId, bool>
const initialCollapsed   = (() => { try { return JSON.parse(localStorage.getItem(LS_COLLAPSED_PROJ) || "{}"); } catch { return {}; } })();
const initialCollapsedWs = (() => { try { return JSON.parse(localStorage.getItem(LS_COLLAPSED_WS)   || "{}"); } catch { return {}; } })();

const initialCompact = (() => { try { return localStorage.getItem(LS_COMPACT) === "1"; } catch { return false; } })();
const initialHidden  = (() => { try { return localStorage.getItem(LS_RPANEL)  === "1"; } catch { return false; } })();
const initialSplit   = (() => { try { return JSON.parse(localStorage.getItem(LS_SPLIT)  || "{}"); } catch { return {}; } })();
const initialSplitH  = (() => { try { return JSON.parse(localStorage.getItem(LS_SPLITH) || "{}"); } catch { return {}; } })();
const initialSplitC  = (() => { try { return JSON.parse(localStorage.getItem(LS_SPLITC) || "{}"); } catch { return {}; } })();
const numOrDefault = (k: string, fallback: number) => {
  // Math.round on read too — protects against any older saved fractional
  // value sneaking through and re-blurring the layout on next launch.
  try { const v = Math.round(Number(localStorage.getItem(k))); return Number.isFinite(v) && v > 0 ? v : fallback; }
  catch { return fallback; }
};
const initialSBW = numOrDefault(LS_SBW, 280);
const initialRPW = numOrDefault(LS_RPW, 280);
const initialRFH = numOrDefault(LS_RFH, 260);

/** The durable subset of a workspace's tabs:
 *  - Main panel: agent and custom-command tabs only (no shell — no session to resume).
 *  - Split-pane tabs: all of them including shells (they re-spawn fresh on restore).
 *  Pane tabs carry `pane_leaf_id` so they restore into the correct leaf. */
function durablePersistedTabs(tabs: Tab[] | undefined): PersistedTab[] {
  return (tabs ?? [])
    .filter((t): t is TerminalTab =>
      t.type === "terminal" && (
        // Main panel: skip shell/scratch (no session to restore)
        (!(t as TerminalTab).paneId && (t as TerminalTab).cli !== "shell") ||
        // Split-pane tabs: all persist (shells re-spawn, agents resume)
        !!(t as TerminalTab).paneId
      ),
    )
    .map(t => ({
      id: t.id,
      cli: t.cli,
      title: t.customTitle ? t.title : null,
      custom_title: !!t.customTitle,
      is_default: !!t.is_default,
      command: t.command ?? null,
      session_id: t.sessionId ?? null,
      pane_leaf_id: t.paneId ?? null,
    }));
}


export const useApp = create<AppState>((set, get) => ({
  projects: [],
  workspaces: [],
  activeWorkspaceId: null,
  tabs: {},
  activeTab: {},
  fsRevision: {},
  view: { page: "dashboard" },
  compactSidebar: initialCompact,
  rightPanelHidden: initialHidden,
  sidebarWidth: initialSBW,
  rightPanelWidth: initialRPW,
  rightFooterHeight: initialRFH,
  terminalSplit: initialSplit,
  terminalSplitHeight: initialSplitH,
  terminalSplitCollapsed: initialSplitC,
  bottomTabs: {},
  activeBottomTab: {},
  splitTree: {},
  activePaneId: {},
  paneHistory: {},
  mountedWorkspaces: new Set<string>(),
  footerTerm: {},
  collapsedProjects:   initialCollapsed   as Record<string, boolean>,
  collapsedWorkspaces: initialCollapsedWs as Record<string, boolean>,
  agents: [],
  detectedClis: {},
  spotlightWsId: {},

  setSpotlight: (projectId, wsId) =>
    set(s => ({
      spotlightWsId: wsId
        ? { ...s.spotlightWsId, [projectId]: wsId }
        : Object.fromEntries(Object.entries(s.spotlightWsId).filter(([k]) => k !== projectId)),
    })),

  loadAll: async () => {
    // Pull projects + workspaces + settings (for the agent registry).
    // Agents drive spawn args via spawnArgsForCli, so this list must be
    // fresh whenever the user edits Settings → Agents and immediately
    // opens a new terminal.
    const [projects, workspaces, settings] = await Promise.all([
      ipc.projectsList(),
      ipc.workspacesList(),
      ipc.settingsLoad().catch(() => ({ agents: [] } as Partial<import("@/lib/types").Settings>)),
    ]);
    set({ projects, workspaces, agents: (settings.agents as import("@/lib/types").Agent[]) ?? [] });
  },

  refreshClis: async () => {
    try {
      const list = await ipc.detectClis();
      const map: Record<string, import("@/lib/types").CliInfo> = {};
      for (const c of list) map[c.name] = c;
      set({ detectedClis: map });
    } catch {
      // Keep prior results; an empty map just means "show all".
    }
  },

  setActiveWorkspace: (id) => {
    const prev = get().activeWorkspaceId;
    if (prev && prev !== id) {
      // Reset activity timestamps on the tab we're leaving so the idle
      // heuristic requires a fresh input→output cycle before firing.
      const prevTabs = get().tabs[prev] || [];
      const activeId = get().activeTab[prev];
      const t = prevTabs.find(x => x.id === activeId);
      if (t && t.type === "terminal") get().patchTab(prev, t.id, { lastInputAt: null, lastOutputAt: null });
    }
    // Track this workspace as "mounted for the session" so MainArea keeps
    // its WorkspaceView rendered (just hidden) when the user switches away.
    // This is what keeps PTYs alive across workspace switches.
    const nextMounted = id && !get().mountedWorkspaces.has(id)
      ? new Set([...get().mountedWorkspaces, id])
      : get().mountedWorkspaces;
    // Auto-expand the parent project in the sidebar so the activated
    // workspace is actually visible. Covers brand-new worktrees (the
    // create dialog calls setActive on success — if the project was
    // collapsed, the new row would be hidden) AND ⌘1..9 / ⇧⌘[/] nav
    // to a workspace under a collapsed project.
    let nextCollapsed = get().collapsedProjects;
    if (id) {
      const ws = get().workspaces.find(w => w.id === id);
      // Force the parent project expanded (explicit false) — covers the
      // case where it was either explicitly collapsed by the user OR
      // default-collapsed-because-empty after a worktree just got added.
      if (ws && nextCollapsed[ws.project_id] !== false) {
        nextCollapsed = { ...nextCollapsed, [ws.project_id]: false };
        try { localStorage.setItem(LS_COLLAPSED_PROJ, JSON.stringify(nextCollapsed)); } catch {}
      }
    }
    set({
      activeWorkspaceId: id,
      view: { page: id ? "dashboard" : get().view.page },
      mountedWorkspaces: nextMounted,
      collapsedProjects: nextCollapsed,
    });
    if (id) {
      // Mark the WHOLE workspace as read on activation. Previously we
      // only cleared the active tab's unread, but `isUnread(wsId)` in the
      // sidebar checks ANY tab — so the workspace icon stayed in its
      // unread color until the user manually visited each other tab.
      // Clicking the workspace = "I've seen this" → clear all.
      const tabs = get().tabs[id] || [];
      const activeId = get().activeTab[id];
      const now = Date.now();
      // Patch the active tab inline (clear workState + stamp
      // workClearedAt for the grace window) and clear unread on all
      // others via clearAttention. Doing the active-tab work via a
      // single set() avoids two cascading patches (the setWorkState
      // path doesn't stamp workClearedAt — only manual clears do).
      set(s => {
        const list = s.tabs[id] || [];
        const next = list.map(t => {
          if (t.type !== "terminal") return t;
          let nt = t;
          if (t.unread) {
            nt = { ...nt, unread: null };
          }
          if (t.id === activeId && (t.workState === "done" || t.workState === "working")) {
            nt = {
              ...nt,
              workState: "idle",
              workProgress: null,
              workProgressKind: null,
              workClearedAt: now,
            };
          }
          return nt;
        });
        return { tabs: { ...s.tabs, [id]: next } };
      });
    }
  },

  setView: (page) => set({ view: { page }, activeWorkspaceId: null }),
  // Opening Settings does NOT clear `activeWorkspaceId` or change `view.page`
  // away from whatever the user was on — Settings renders as a fixed
  // z-40 overlay (App.tsx). Preserving the underlying state means closing
  // Settings drops the user back into the exact workspace + tab they were
  // in, terminals still running, no context lost.
  openSettings: (tab = "general", repoId) =>
    set(s => ({ view: { ...s.view, settingsTab: tab, settingsRepoId: repoId, settingsOpen: true } as View })),
  closeSettings: () =>
    set(s => ({ view: { ...s.view, settingsOpen: false } as View })),

  toggleCompactSidebar: () => set(s => {
    const next = !s.compactSidebar;
    try { localStorage.setItem(LS_COMPACT, next ? "1" : "0"); } catch {}
    // Resize the sidebar column INSTANTLY — suppress the 220ms grid
    // transition (same `--cols-transition: none` trick the resize handle
    // uses) just for this toggle, then restore it on the next frame so the
    // right-panel show/hide keeps animating.
    try {
      const root = document.documentElement;
      root.style.setProperty("--cols-transition", "none");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => root.style.removeProperty("--cols-transition")),
      );
    } catch {}
    return { compactSidebar: next };
  }),
  toggleRightPanel: () => set(s => {
    const next = !s.rightPanelHidden;
    try { localStorage.setItem(LS_RPANEL, next ? "1" : "0"); } catch {}
    return { rightPanelHidden: next };
  }),
  revealFile: null,
  revealInTree: (wsId, path, isDir) => set(s => {
    if (s.rightPanelHidden) { try { localStorage.setItem(LS_RPANEL, "0"); } catch {} }
    return {
      rightPanelHidden: false,
      revealFile: { wsId, path, isDir, nonce: (s.revealFile?.nonce ?? 0) + 1 },
    };
  }),
  clearReveal: () => set({ revealFile: null }),

  // All three setters round to integer px — anywhere a fractional value
  // would land in a CSS dimension makes nested text render at sub-pixel
  // positions in WKWebView and look blurry.
  setSidebarWidth: (px) => {
    const v = Math.round(px);
    try { localStorage.setItem(LS_SBW, String(v)); } catch {}
    set({ sidebarWidth: v });
  },
  setRightPanelWidth: (px) => {
    const v = Math.round(px);
    try { localStorage.setItem(LS_RPW, String(v)); } catch {}
    set({ rightPanelWidth: v });
  },
  setRightFooterHeight: (px) => {
    const v = Math.round(px);
    try { localStorage.setItem(LS_RFH, String(v)); } catch {}
    set({ rightFooterHeight: v });
  },

  toggleTerminalSplit: (wsId) => set(s => {
    const next = { ...s.terminalSplit, [wsId]: !s.terminalSplit[wsId] };
    try { localStorage.setItem(LS_SPLIT, JSON.stringify(next)); } catch {}
    return { terminalSplit: next };
  }),
  setTerminalSplitHeight: (wsId, px) => set(s => {
    const next = { ...s.terminalSplitHeight, [wsId]: px };
    try { localStorage.setItem(LS_SPLITH, JSON.stringify(next)); } catch {}
    return { terminalSplitHeight: next };
  }),
  toggleTerminalSplitCollapsed: (wsId) => set(s => {
    const next = { ...s.terminalSplitCollapsed, [wsId]: !s.terminalSplitCollapsed[wsId] };
    try { localStorage.setItem(LS_SPLITC, JSON.stringify(next)); } catch {}
    return { terminalSplitCollapsed: next };
  }),
  // ⌘J / command palette: VS Code-style 3-state cycle on the bottom-split
  // terminal. "Visible" = split open AND not collapsed.
  //   hidden/collapsed        → show, expand, seed a shell if empty, focus it.
  //   visible but NOT focused → just move focus into it (don't hide — a first
  //                             ⌘J from the agent should land you in the panel).
  //   visible AND focused     → collapse (not full close, so shells + PTYs stay
  //                             mounted) and return focus to whichever pane was
  //                             active (right split or main), never <body>.
  toggleBottomTerminal: (wsId) => {
    const s = get();
    const splitOpen = !!s.terminalSplit[wsId];
    const isCollapsed = !!s.terminalSplitCollapsed[wsId];
    if (splitOpen && !isCollapsed) {
      // Focus lives in the DOM (xterm textarea), not the store — the bottom
      // split tags its container with `data-bottom-split`.
      const bottomFocused = !!document.activeElement?.closest("[data-bottom-split]");
      if (!bottomFocused) {
        focusTerminalTab(s.activeBottomTab[wsId]);
        return;
      }
      get().toggleTerminalSplitCollapsed(wsId);
      // Return focus to the active split pane or main pane.
      const tabKey = s.activeTab[wsId];
      const tree = tabKey ? s.splitTree[tabKey] : undefined;
      const activePaneId = tree ? s.activePaneId[tabKey!] : null;
      const activePaneLeaf = (activePaneId && tree) ? findLeaf(tree, activePaneId) : null;
      if (activePaneLeaf?.tabId) focusTerminalTab(activePaneLeaf.tabId);
      else focusMainTab(s.activeTab[wsId]);
      return;
    }
    if (!splitOpen) get().toggleTerminalSplit(wsId);
    if (isCollapsed) get().toggleTerminalSplitCollapsed(wsId);
    // addBottomTab focuses the new shell itself; WorkspaceView's seed effect
    // sees the non-empty list and won't double-add.
    if ((get().bottomTabs[wsId]?.length ?? 0) === 0) get().addBottomTab(wsId);
    else focusTerminalTab(get().activeBottomTab[wsId]);
  },
  enableFooterTerm:  (wsId) => set(s => ({ footerTerm: { ...s.footerTerm, [wsId]: true } })),
  disableFooterTerm: (wsId) => set(s => {
    const { [wsId]: _, ...rest } = s.footerTerm; void _;
    return { footerTerm: rest };
  }),
  // Explicit set so the sidebar can default empty projects to collapsed
  // without losing the user's manual override. Three states are encoded:
  //   undefined → "no preference" — sidebar's render decides based on
  //               whether the project has any workspaces (empty=collapsed).
  //   true      → user explicitly collapsed it (sticks even when populated).
  //   false     → user explicitly expanded it (sticks even when empty).
  setProjectCollapsed: (projectId, collapsed) => set(s => {
    const next = { ...s.collapsedProjects, [projectId]: collapsed };
    try { localStorage.setItem(LS_COLLAPSED_PROJ, JSON.stringify(next)); } catch {}
    return { collapsedProjects: next };
  }),
  setWorkspaceCollapsed: (wsId, collapsed) => set(s => {
    const next = { ...s.collapsedWorkspaces, [wsId]: collapsed };
    try { localStorage.setItem(LS_COLLAPSED_WS, JSON.stringify(next)); } catch {}
    return { collapsedWorkspaces: next };
  }),
  setAllWorkspacesCollapsed: (collapsed) => set(s => {
    // Build a fresh map covering every workspace so the default-by-mode
    // fallback in WorkspaceRow can't sneak back in for any of them. We
    // intentionally write entries for archived workspaces too: cheap,
    // and unifies behavior if one is later restored.
    const next: Record<string, boolean> = {};
    for (const w of s.workspaces) next[w.id] = collapsed;
    try { localStorage.setItem(LS_COLLAPSED_WS, JSON.stringify(next)); } catch {}
    return { collapsedWorkspaces: next };
  }),

  addBottomTab: (wsId, opts) => {
    const id = crypto.randomUUID();
    const focus = opts?.focus ?? true;
    set(s => {
      const list = s.bottomTabs[wsId] || [];
      const title = `shell ${list.length + 1}`;
      // `autoFocus` is read by AuxTerminal: it self-focuses once its PTY is
      // live (the external poll below fires too early on first open — the
      // xterm textarea isn't focusable yet during the heavy mount/fit).
      return {
        bottomTabs:      { ...s.bottomTabs, [wsId]: [...list, { id, title, autoFocus: focus }] },
        activeBottomTab: { ...s.activeBottomTab, [wsId]: id },
      };
    });
    // Move focus into the freshly-spawned shell so the user can type
    // straight away. Covers the bottom-strip "+", ⌘T and ⇧⌘D. The
    // AuxTerminal self-focus (via autoFocus) is the reliable path; this
    // best-effort poll just narrows the window before the PTY is up.
    if (focus) focusTerminalTab(id);
    return id;
  },
  closeBottomTab: (wsId, tabId) => {
    // Focus follows the close so the user keeps typing in the right
    // place. `focusId` is resolved inside the updater and applied
    // after, once React has the new active tab mounted+visible.
    let focusId = "";
    set(s => {
      const list = s.bottomTabs[wsId] || [];
      const idx = list.findIndex(t => t.id === tabId);
      if (idx < 0) return s;
      const next = list.filter(t => t.id !== tabId);
      const wasActive = s.activeBottomTab[wsId] === tabId;
      let active = s.activeBottomTab[wsId];
      if (wasActive) active = next[Math.max(0, idx - 1)]?.id || next[0]?.id || "";
      // Last shell closed → collapse the split entirely so the user
      // isn't left staring at an empty terminal pane.
      if (next.length === 0) {
        // No bottom shell survives → focus falls back to the main-area
        // active tab rather than to <body>.
        if (wasActive) focusId = s.activeTab[wsId] || "";
        // Persist the closed split too — otherwise localStorage keeps the
        // `true` that toggleTerminalSplit wrote on open, and the split (and
        // thus an auto-spawned shell) reappears on the next launch.
        const nextSplit = { ...s.terminalSplit, [wsId]: false };
        try { localStorage.setItem(LS_SPLIT, JSON.stringify(nextSplit)); } catch {}
        return {
          bottomTabs:      { ...s.bottomTabs, [wsId]: next },
          activeBottomTab: { ...s.activeBottomTab, [wsId]: "" },
          terminalSplit:   nextSplit,
        };
      }
      // Closed the focused shell → keep focus in the bottom split by
      // moving it to the shell that takes over (the previous one).
      if (wasActive) focusId = active;
      return {
        bottomTabs:      { ...s.bottomTabs, [wsId]: next },
        activeBottomTab: { ...s.activeBottomTab, [wsId]: active },
      };
    });
    if (focusId) focusTerminalTab(focusId);
  },
  setActiveBottomTab: (wsId, tabId) => set(s => ({
    activeBottomTab: { ...s.activeBottomTab, [wsId]: tabId },
  })),
  setBottomTabLiveTitle: (wsId, tabId, liveTitle) => set(s => {
    const list = s.bottomTabs[wsId];
    if (!list) return s;
    const trimmed = liveTitle.trim();
    let changed = false;
    const next = list.map(t => {
      if (t.id !== tabId || t.liveTitle === trimmed) return t;
      changed = true;
      return { ...t, liveTitle: trimmed };
    });
    return changed ? { bottomTabs: { ...s.bottomTabs, [wsId]: next } } : s;
  }),

  splitPane: (wsId, dir, paneIdArg) => {
    const s = get();
    const tabKey = s.activeTab[wsId];
    if (!tabKey) return "";
    // Determine target pane via DOM focus rather than the store's activePaneId,
    // which can be stale when the user clicked back to main without moving the
    // tracked active-pane pointer. If DOM focus is inside an extra split leaf,
    // target it; otherwise fall through to main (the !targetLeaf branch below).
    let activePaneId = paneIdArg;
    if (activePaneId === undefined) {
      const el = (document.activeElement as HTMLElement | null)
        ?.closest?.("[data-split-leaf]") as HTMLElement | null;
      if (el && !el.hasAttribute("data-main-content")) {
        activePaneId = el.getAttribute("data-pane-id") ?? undefined;
      }
    }
    const newLeafId = crypto.randomUUID();
    const newLeaf: PaneLeaf = { type: 'pane', id: newLeafId, tabId: null };

    let newTree: SplitTree;
    const currentTree = s.splitTree[tabKey];

    if (!currentTree) {
      // First split: main leaf is always root.a; new pane is root.b.
      const mainLeafId = crypto.randomUUID();
      const mainLeaf: PaneLeaf = { type: 'pane', id: mainLeafId, isMain: true, tabId: null };
      newTree = { type: 'split', id: crypto.randomUUID(), dir, ratio: 0.5, a: mainLeaf, b: newLeaf };
    } else {
      const targetLeaf = findLeaf(currentTree, activePaneId!);
      const rootSplit = currentTree as _SplitNode;

      if (!targetLeaf || targetLeaf.isMain) {
        // Focused on main: new pane goes in the requested direction relative to main.
        // Set root.dir = dir so "split right" (v) puts pane right of main, "split
        // below" (h) puts it below. Existing extras are folded into root.b using the
        // old direction so their internal layout is preserved.
        // When the direction CHANGES (e.g. had bottom-terminal, now split right), put
        // the new pane at position `a` (top/left of the new root.b) so it lands
        // directly adjacent to main rather than in the far corner.
        const innerDir = rootSplit.dir;
        const dirChanged = !!rootSplit.b && innerDir !== dir;
        newTree = {
          ...rootSplit,
          dir,
          b: rootSplit.b
            ? { type: 'split', id: crypto.randomUUID(), dir: innerDir, ratio: 0.5,
                a: dirChanged ? newLeaf : rootSplit.b,
                b: dirChanged ? rootSplit.b : newLeaf,
              }
            : newLeaf,
        };
      } else {
        // Focused on an extra pane: split that pane's space.
        newTree = replaceNode(currentTree, targetLeaf.id, {
          type: 'split', id: crypto.randomUUID(), dir, ratio: 0.5, a: targetLeaf, b: newLeaf,
        });
      }
      // Equalize all same-axis columns/rows so splits remain visually even.
      // Perpendicular subtrees count as 1 slot so mixed layouts aren't distorted.
      newTree = equalizeSplitsOnAxis(newTree, dir);
    }

    set(s2 => {
      const cur = s2.activePaneId[tabKey];
      const prevStack = s2.paneHistory[tabKey] ?? [];
      return {
        splitTree: { ...s2.splitTree, [tabKey]: newTree },
        activePaneId: { ...s2.activePaneId, [tabKey]: newLeafId },
        paneHistory: cur
          ? { ...s2.paneHistory, [tabKey]: [cur, ...prevStack.filter(id => id !== cur)].slice(0, 10) }
          : s2.paneHistory,
      };
    });

    const tryFocus = (tries = 30) => {
      const el = document.querySelector(`[data-split-launcher][data-pane-id="${newLeafId}"]`) as HTMLElement | null;
      if (el) { el.focus({ preventScroll: true }); return; }
      if (tries > 0) setTimeout(() => tryFocus(tries - 1), 20);
    };
    tryFocus();
    get().saveSplitLayout(wsId);
    return newLeafId;
  },

  closePane: (wsId, paneId) => {
    let focusOnMain = false;
    let focusTabId = "";
    const tabKey = get().activeTab[wsId];
    if (!tabKey) return;
    set(s => {
      const tree = s.splitTree[tabKey];
      if (!tree) return s;
      const leaf = findLeaf(tree, paneId);
      const tabId = leaf?.tabId ?? null;

      // Kill the tab's PTY if there is one.
      if (tabId) {
        const tab = (s.tabs[wsId] ?? []).find(t => t.id === tabId);
        if (tab?.type === 'terminal' && tab.ptyId) ipc.ptyKill(tab.ptyId).catch(() => {});
      }

      // removeLeaf collapses the parent split: the sibling takes the freed space.
      // Equalize BOTH axes so mixed v/h layouts stay even regardless of which
      // pane was closed (rootDir alone misses the perpendicular axis).
      const removedTree = removeLeaf(tree, paneId);
      const newTree = removedTree && removedTree.type === 'split'
        ? equalizeSplitsOnAxis(equalizeSplitsOnAxis(removedTree, 'v'), 'h')
        : removedTree;

      // Build a new tabs list without the closed pane's tab.
      const nextTabs = tabId
        ? (s.tabs[wsId] ?? []).filter(t => t.id !== tabId)
        : s.tabs[wsId] ?? [];

      const patch: Partial<AppState> = { tabs: { ...s.tabs, [wsId]: nextTabs } };

      if (!newTree || newTree.type === 'pane') {
        // Collapsed to 0 or 1 leaves → no more splits.
        const { [tabKey]: _t, ...treeRest } = s.splitTree; void _t;
        const { [tabKey]: _p, ...paneRest } = s.activePaneId; void _p;
        const { [tabKey]: _ph2, ...histRest } = s.paneHistory; void _ph2;
        patch.splitTree = treeRest;
        patch.activePaneId = paneRest;
        patch.paneHistory = histRest;
        focusOnMain = true;
      } else {
        const remaining = getAllLeaves(newTree);
        const remainingIds = new Set(remaining.map(l => l.id));
        // Walk history stack to find the most recently focused surviving pane.
        const history = s.paneHistory[tabKey] ?? [];
        const newActive =
          history.find(id => id !== paneId && remainingIds.has(id)) ||
          remaining.find(l => l.id !== paneId)?.id ||
          remaining[0].id;
        // Remove the closed pane from history; rest of the stack is preserved.
        const newHistory = history.filter(id => id !== paneId).slice(0, 10);
        patch.splitTree = { ...s.splitTree, [tabKey]: newTree };
        patch.activePaneId = { ...s.activePaneId, [tabKey]: newActive };
        patch.paneHistory = { ...s.paneHistory, [tabKey]: newHistory };
        const newActiveLeaf = remaining.find(l => l.id === newActive);
        if (newActiveLeaf?.tabId) focusTabId = newActiveLeaf.tabId;
        else focusOnMain = true;
      }
      return patch as any;
    });

    if (focusTabId) focusTerminalTab(focusTabId);
    else if (focusOnMain) focusMainTab(get().activeTab[wsId]);
    get().syncDurableTabs(wsId);
    get().saveSplitLayout(wsId);
  },

  setActivePaneId: (wsId, paneId) => set(s => {
    const tabKey = s.activeTab[wsId];
    if (!tabKey || s.activePaneId[tabKey] === paneId) return s;
    const cur = s.activePaneId[tabKey];
    if (!cur) return { activePaneId: { ...s.activePaneId, [tabKey]: paneId } };
    const prevStack = s.paneHistory[tabKey] ?? [];
    return {
      activePaneId: { ...s.activePaneId, [tabKey]: paneId },
      paneHistory: { ...s.paneHistory, [tabKey]: [cur, ...prevStack.filter(id => id !== cur)].slice(0, 10) },
    };
  }),

  setSplitRatio: (wsId, splitId, ratio) => set(s => {
    const tabKey = s.activeTab[wsId];
    const tree = tabKey ? s.splitTree[tabKey] : undefined;
    if (!tree || !tabKey) return s;
    return { splitTree: { ...s.splitTree, [tabKey]: updateSplitRatio(tree, splitId, ratio) } };
  }),

  movePaneTo: (wsId, sourcePaneId, targetPaneId, zone) => {
    set(s => {
      const tabKey = s.activeTab[wsId];
      const tree = tabKey ? s.splitTree[tabKey] : undefined;
      if (!tree || !tabKey) return s;
      const sourceLeaf = findLeaf(tree, sourcePaneId);
      if (!sourceLeaf) return s;

      // Remove source from tree.
      const treeWithout = removeLeaf(tree, sourcePaneId);
      if (!treeWithout) return s; // last pane — nothing to rearrange

      const targetInNew = findLeaf(treeWithout, targetPaneId);
      if (!targetInNew) return s;

      const dir: SplitDir = zone === 'left' || zone === 'right' ? 'v' : 'h';
      const aFirst = zone === 'left' || zone === 'top';

      // Main pane must always remain at root.a — using replaceNode would corrupt
      // the tree. Instead: change root.dir to match the drop zone (so "drop on
      // main's right zone" reorients to a vertical root), and insert source
      // adjacent to main within root.b.
      if (targetInNew.isMain) {
        if (treeWithout.type === 'pane') {
          // Only main remains (source was the only extra). Rebuild as a fresh
          // 2-pane split in the requested direction so the layout reorients.
          return { splitTree: { ...s.splitTree, [tabKey]: {
            type: 'split', id: crypto.randomUUID(), dir, ratio: 0.5,
            a: treeWithout, b: sourceLeaf,
          }}};
        }
        const rootSplit = treeWithout as _SplitNode;
        const newB: SplitTree = {
          type: 'split', id: crypto.randomUUID(), dir: rootSplit.dir, ratio: 0.5,
          a: sourceLeaf, b: rootSplit.b,
        };
        return { splitTree: { ...s.splitTree, [tabKey]: { ...rootSplit, dir, b: newB } } };
      }

      const newSplit: SplitTree = {
        type: 'split', id: crypto.randomUUID(), dir, ratio: 0.5,
        a: aFirst ? sourceLeaf : targetInNew,
        b: aFirst ? targetInNew : sourceLeaf,
      };
      const newTree = replaceNode(treeWithout, targetPaneId, newSplit);
      return { splitTree: { ...s.splitTree, [tabKey]: newTree } };
    });
    get().saveSplitLayout(wsId);
  },

  addPaneTab: (wsId, paneId, cli) => {
    const s = get();
    const tabId = crypto.randomUUID();
    const tab: TerminalTab = {
      id: tabId, type: 'terminal',
      title: cli === 'shell' ? 'shell' : agentDisplayName(cli, s.agents),
      cli,
      paneId,
    };
    set(s2 => {
      const tabKey2 = s2.activeTab[wsId];
      const tree = tabKey2 ? s2.splitTree[tabKey2] : undefined;
      const newTree = tree ? updateLeafTabId(tree, paneId, tabId) : tree;
      return {
        tabs: { ...s2.tabs, [wsId]: [...(s2.tabs[wsId] ?? []), tab] },
        ...(newTree && tabKey2 ? { splitTree: { ...s2.splitTree, [tabKey2]: newTree } } : {}),
        ...(tabKey2 ? { activePaneId: { ...s2.activePaneId, [tabKey2]: paneId } } : {}),
      };
    });
    focusTerminalTab(tabId);
    get().syncDurableTabs(wsId);
    get().saveSplitLayout(wsId);
    return tabId;
  },

  ensureDefaultTab: (wsId, cli) => {
    const s = get();
    // Already mounted (visited this session) → leave the live tabs alone.
    // Count only MAIN tabs — split-pane tabs live in the same array but should
    // not prevent seeding the main agent tab on first visit.
    const mainTabs = (s.tabs[wsId] || []).filter(t => !(t as TerminalTab).paneId);
    if (mainTabs.length) return;
    const ws = s.workspaces.find(w => w.id === wsId);
    const persisted = ws?.persisted_tabs ?? [];

    // Restore path: a prior session left a durable agent-tab set. Bring
    // back every tab (not just the primary), each with its own session id
    // so id-capable agents resume independently. This is the "quit the app,
    // reopen the workspace, everything is back" behavior.
    if (persisted.length) {
      // Separate main-panel tabs from split-pane tabs; each group is restored
      // differently (pane tabs get paneId set and link into the split tree).
      const persistedMain = persisted.filter(pt => !pt.pane_leaf_id);
      const persistedPane = persisted.filter(pt => !!pt.pane_leaf_id);

      // Repair corruption from older builds: a buggy close path could wipe
      // then re-seed the default tab, leaving SEVERAL entries all flagged
      // is_default (each a phantom "main agent"). Restoring all of them spawns
      // a pile of agents that collide on session ids. There is only ever ONE
      // main, so dedupe by id and DROP every is_default entry after the first
      // (real secondary agents are is_default:false and are kept).
      const seenIds = new Set<string>();
      let keptDefault = false;
      const clean = persistedMain.filter(pt => {
        if (seenIds.has(pt.id)) return false;
        seenIds.add(pt.id);
        if (pt.is_default) {
          if (keptDefault) return false; // extra phantom main → drop
          keptDefault = true;
        }
        return true;
      });
      const wasCorrupt = clean.length !== persistedMain.length;
      const restoredMain: TerminalTab[] = clean.map(pt => ({
        id: pt.id,
        type: "terminal" as const,
        cli: pt.cli,
        // Honor a user rename; otherwise re-derive the display name (the
        // agent's configured name may have changed since last launch).
        title: pt.custom_title && pt.title ? pt.title : agentDisplayName(pt.cli, s.agents),
        customTitle: !!pt.custom_title,
        is_default: !!pt.is_default,
        ...(pt.command ? { command: pt.command } : {}),
        ...(pt.session_id ? { sessionId: pt.session_id } : {}),
      }));
      const active = restoredMain.find(t => t.is_default) ?? restoredMain[0];

      // Restore the split tree and pane tabs if a layout was saved.
      let restoredTree: SplitTree | undefined;
      let restoredMainLeafId: string | undefined;
      const restoredPaneTabs: TerminalTab[] = [];
      if (ws?.split_layout) {
        try {
          restoredTree = JSON.parse(ws.split_layout) as SplitTree;
          restoredMainLeafId = getAllLeaves(restoredTree).find(l => (l as PaneLeaf).isMain)?.id;
          for (const pt of persistedPane) {
            restoredPaneTabs.push({
              id: pt.id, type: "terminal" as const,
              cli: pt.cli,
              title: pt.custom_title && pt.title ? pt.title : agentDisplayName(pt.cli, s.agents),
              customTitle: !!pt.custom_title,
              paneId: pt.pane_leaf_id!,
              ...(pt.command ? { command: pt.command } : {}),
              ...(pt.session_id ? { sessionId: pt.session_id } : {}),
            });
          }
        } catch {
          restoredTree = undefined;
        }
      }

      const allRestored = [...restoredMain, ...restoredPaneTabs];
      // When we repaired corruption, overwrite persisted_tabs DIRECTLY with
      // the cleaned set — can't go through syncDurableTabs, whose merge would
      // re-add the dropped phantom tabs as "closed-but-durable".
      const cleaned = wasCorrupt ? durablePersistedTabs(allRestored) : null;
      set(state => ({
        tabs: { ...state.tabs, [wsId]: allRestored },
        activeTab: { ...state.activeTab, [wsId]: active?.id ?? "" },
        ...(restoredTree && active
          ? { splitTree: { ...state.splitTree, [active.id]: restoredTree } }
          : {}),
        ...(restoredMainLeafId && active
          ? { activePaneId: { ...state.activePaneId, [active.id]: restoredMainLeafId } }
          : {}),
        ...(cleaned ? {
          workspaces: state.workspaces.map(w => w.id === wsId ? { ...w, persisted_tabs: cleaned } : w),
        } : {}),
      }));
      if (cleaned) ipc.workspaceSetTabs(wsId, cleaned).catch(() => {});
      return;
    }

    // Seed path: fresh workspace (or a legacy record from before tab
    // persistence) — create the single default agent tab. Custom-command
    // workspaces seed the launch command + workspace-name title.
    const isCustom = cli === "custom";
    const title = isCustom ? (ws?.name || "Command") : agentDisplayName(cli, s.agents);
    // Migrate a legacy per-cli session uuid onto the default tab so
    // repo-root workspaces created before per-tab uuids keep resuming the
    // same session. `syncDurableTabs` carries this into `persisted_tabs`
    // (the Rust merge honors a payload session_id on a tab's first write).
    const legacyUuid = ws?.agent_session_ids?.[cli];
    const tab: TerminalTab = {
      id: crypto.randomUUID(), type: "terminal", title, cli, is_default: true,
      ...(isCustom && ws?.custom_command ? { command: ws.custom_command } : {}),
      ...(legacyUuid ? { sessionId: legacyUuid } : {}),
    };
    set(state => ({
      tabs: { ...state.tabs, [wsId]: [tab] },
      activeTab: { ...state.activeTab, [wsId]: tab.id },
    }));
    get().syncDurableTabs(wsId);
  },

  syncDurableTabs: (wsId) => {
    const st = get();
    const ws = st.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const live = durablePersistedTabs(st.tabs[wsId]);
    // Merge rule = the close semantics (issue #23 decision):
    //   - Every OPEN agent tab is durable → quitting the app restores all.
    //   - A CLOSED (X-ed) MAIN tab stays durable: closing main is "end it
    //     for now"; it auto-resumes when the workspace wakes.
    //   - A CLOSED secondary tab is FORGOTTEN: X on a "+" agent tab is the
    //     way to get rid of it for good.
    // Open agents sort first in live order; a closed main keeps the tail.
    const liveIds = new Set(live.map(t => t.id));
    const prev = ws.persisted_tabs ?? [];
    const closed = prev.filter(p => !liveIds.has(p.id) && p.is_default);
    const next = [...live, ...closed];
    // Skip the work when nothing changed (avoids workspace-identity churn
    // that would re-render the sidebar, and a redundant disk write).
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    set(s => ({
      workspaces: s.workspaces.map(w => w.id === wsId ? { ...w, persisted_tabs: next } : w),
    }));
    ipc.workspaceSetTabs(wsId, next).catch(() => {});
  },

  saveSplitLayout: (wsId) => {
    const s = get();
    const tabKey = s.activeTab[wsId];
    const tree = tabKey ? s.splitTree[tabKey] : undefined;
    const ws = s.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const layout = tree ? JSON.stringify(tree) : null;
    if ((ws.split_layout ?? null) === layout) return;
    set(st => ({
      workspaces: st.workspaces.map(w => w.id === wsId ? { ...w, split_layout: layout } : w),
    }));
    ipc.workspaceSetSplitLayout(wsId, layout).catch(() => {});
  },

  forgetTab: (wsId, tabId) => {
    // Explicit "close & forget": drop the agent from the durable set so it
    // does NOT come back on reopen, then close it. Order matters — remove from
    // persisted BEFORE close's syncDurable* runs, so the merge can't re-add it.
    const tab = (get().tabs[wsId] ?? []).find(t => t.id === tabId);
    const isPaneTab = tab?.type === "terminal" && !!(tab as TerminalTab).paneId;
    const ws = get().workspaces.find(w => w.id === wsId);
    if (!isPaneTab && ws) {
      const next = (ws.persisted_tabs ?? []).filter(t => t.id !== tabId);
      set(s => ({ workspaces: s.workspaces.map(w => w.id === wsId ? { ...w, persisted_tabs: next } : w) }));
      ipc.workspaceSetTabs(wsId, next).catch(() => {});
    }
    get().closeTab(wsId, tabId);
  },

  setTabSessionId: (wsId, tabId, uuid) => {
    const val = uuid || undefined;
    set(s => {
      const list = s.tabs[wsId];
      const nextTabs = list
        ? list.map(t => (t.id === tabId && t.type === "terminal" ? { ...t, sessionId: val } as Tab : t))
        : list;
      const wsUpdate = {
        workspaces: s.workspaces.map(w => w.id !== wsId ? w : {
          ...w,
          persisted_tabs: (w.persisted_tabs ?? []).map(pt =>
            pt.id === tabId ? { ...pt, session_id: uuid || null } : pt,
          ),
        }),
      };
      return {
        ...(nextTabs ? { tabs: { ...s.tabs, [wsId]: nextTabs } } : {}),
        ...wsUpdate,
      };
    });
    ipc.workspaceSetTabSessionId(wsId, tabId, uuid).catch(() => {});
  },

  setWorkspaceYolo: (wsId, yolo) => set(s => ({
    workspaces: s.workspaces.map(w => w.id === wsId ? { ...w, yolo } : w),
  })),
  setWorkspaceCustomCommand: (wsId, command) => set(s => {
    const tabs = s.tabs[wsId];
    // Re-seed any custom-command tab so a future respawn re-runs the
    // edited script. The running PTY isn't restarted here — the user
    // restarts the agent tab to apply it live.
    const nextTabs = tabs
      ? tabs.map(t =>
          t.type === "terminal" && (t as TerminalTab).cli === "custom"
            ? { ...t, command } as Tab
            : t,
        )
      : tabs;
    return {
      workspaces: s.workspaces.map(w =>
        w.id === wsId ? { ...w, custom_command: command } : w,
      ),
      ...(nextTabs ? { tabs: { ...s.tabs, [wsId]: nextTabs } } : {}),
    };
  }),
  setWorkspaceResumeOverride: (wsId, command) => set(s => ({
    workspaces: s.workspaces.map(w =>
      w.id === wsId ? { ...w, resume_override: command.trim() || null } : w,
    ),
  })),

  addTab: (wsId, tab) => {
    set(s => {
      const next = [...(s.tabs[wsId] || []), tab];
      return { tabs: { ...s.tabs, [wsId]: next }, activeTab: { ...s.activeTab, [wsId]: tab.id } };
    });
    // Persist the new durable set (a `+` agent tab is restorable; a shell
    // tab is filtered out by syncDurableTabs).
    get().syncDurableTabs(wsId);
    // A new terminal tab grabs focus so the user can type immediately.
    // (edit/diff tabs manage their own focus — no terminal to target.)
    if (tab.type === "terminal") focusTerminalTab(tab.id);
  },

  reorderTab: (wsId, tabId, toIndex) => {
    let changed = false;
    set(s => {
      const list = s.tabs[wsId] || [];
      const from = list.findIndex(t => t.id === tabId);
      if (from < 0) return s;
      const without = list.filter(t => t.id !== tabId);
      const dest = Math.max(0, Math.min(toIndex, without.length));
      without.splice(dest, 0, list[from]);
      // Bail if the order is unchanged — avoids a needless render + the
      // tabs identity churn that would defeat tight selectors.
      if (without.every((t, i) => t.id === list[i].id)) return s;
      changed = true;
      return { tabs: { ...s.tabs, [wsId]: without } };
    });
    // Persist the new order so restore preserves it.
    if (changed) get().syncDurableTabs(wsId);
  },

  closeTab: (wsId, tabId) => {
   let focusId = "";
   set(s => {
    const list = s.tabs[wsId] || [];
    const idx = list.findIndex(t => t.id === tabId);
    if (idx < 0) return s;
    const closing = list[idx];
    // Best-effort PTY kill; ignore failures (already-dead PTYs etc.).
    if (closing.type === "terminal" && closing.ptyId) ipc.ptyKill(closing.ptyId).catch(() => {});
    const next = list.filter(t => t.id !== tabId);
    const wasActive = s.activeTab[wsId] === tabId;
    // Active-tab replacement considers only main tabs (no paneId).
    // Use mainIdx so "go to previous" is correct when pane tabs sit before the closing tab.
    const mainList = list.filter(t => !(t as TerminalTab).paneId);
    const mainIdx = mainList.findIndex(t => t.id === tabId);
    const mainNext = mainList.filter(t => t.id !== tabId);
    let active = s.activeTab[wsId];
    if (wasActive) active = mainNext[Math.max(0, mainIdx - 1)]?.id || mainNext[0]?.id || "";
    // Last main tab closed → put the workspace to sleep. Pane tabs
    // are managed separately and should not keep the workspace alive with an empty main pane.
    const isLast = mainNext.length === 0;
    // Closed the focused tab and another tab survives → focus follows
    // to the tab that takes over (the previous one), so ⌘W-ing through
    // tabs keeps keyboard focus in the main pane.
    if (wasActive && !isLast) focusId = active;
    // Clean up the closed tab's split state (keyed by tabId, not wsId).
    const { [tabId]: _st, ...splitTreeRest } = s.splitTree;   void _st;
    const { [tabId]: _ap, ...activePaneRest } = s.activePaneId; void _ap;
    const { [tabId]: _ph, ...paneHistoryRest } = s.paneHistory; void _ph;
    const update: Partial<typeof s> = {
      tabs: { ...s.tabs, [wsId]: next },
      activeTab: { ...s.activeTab, [wsId]: active },
      splitTree: _st ? splitTreeRest : s.splitTree,
      activePaneId: _ap ? activePaneRest : s.activePaneId,
      paneHistory: _ph ? paneHistoryRest : s.paneHistory,
    };
    if (isLast) {
      // Evict from mountedWorkspaces → WorkspaceView unmounts → xterm
      // disposes → PTY listener teardown. Without this, the empty
      // workspace view stays in the DOM forever holding dead refs.
      const mounted = new Set(s.mountedWorkspaces);
      mounted.delete(wsId);
      (update as any).mountedWorkspaces = mounted;
      if (s.activeWorkspaceId === wsId) {
        (update as any).activeWorkspaceId = null;
      }
    }
    return update as any;
   });
   // Re-sync the durable set: a closed SECONDARY tab is dropped (X = forget
   // it), while a closed MAIN tab stays durable and auto-resumes when the
   // workspace wakes — see the merge rule in syncDurableTabs. No-op if
   // nothing changed.
   get().syncDurableTabs(wsId);
   if (focusId) focusTerminalTab(focusId);
  },

  setActiveTabId: (wsId, tabId) => set(s => {
    // Looking at a tab = "I've seen this / I'm dealing with it now."
    // Clear EVERY status flag on focus:
    //   - unread (bell/attention/exit)
    //   - workState (done OR working) → idle
    // Clearing "working" on focus is the manual escape hatch for
    // stuck spinners: agents like Claude Code stream continuously
    // (thinking dots, elapsed counter), defeating every automatic
    // demoter — focusing the tab is now the user's "I see it, kill
    // the spinner" gesture. The next sender signal / submit will
    // re-arm working if work is actually still happening.
    const list = s.tabs[wsId] || [];
    const now = Date.now();
    const next = list.map(t => {
      if (t.id !== tabId) return t;
      // Terminal tabs carry workState — clear via a typed TerminalTab
      // patch. Edit/diff tabs only have `unread` to clear.
      if (t.type === "terminal") {
        const patch: Partial<TerminalTab> = {};
        if (t.unread) patch.unread = null;
        if (t.workState === "done" || t.workState === "working") {
          patch.workState = "idle";
          patch.workProgress = null;
          patch.workProgressKind = null;
          patch.workClearedAt = now;
        }
        return Object.keys(patch).length ? { ...t, ...patch } : t;
      }
      if (t.unread) {
        const patch: Partial<typeof t> = { unread: null };
        return { ...t, ...patch };
      }
      return t;
    });
    return {
      activeTab: { ...s.activeTab, [wsId]: tabId },
      tabs: { ...s.tabs, [wsId]: next },
    };
  }),

  patchTab: (wsId, tabId, patch) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => {
      if (t.id === tabId) {
        const updated = { ...t, ...patch } as Tab;
        if (patch.dirty === true) {
          updated.preview = false;
        }
        return updated;
      }
      return t;
    });
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  enqueueAgentMessage: (wsId, tabId, text, repeat = 1) => set(s => {
    const list = s.tabs[wsId] || [];
    const r = Math.max(1, Math.round(repeat) || 1);
    const next = list.map(t => {
      if (t.id !== tabId || t.type !== "terminal") return t;
      const item = { id: crypto.randomUUID(), text, repeat: r, remaining: r };
      return {
        ...t,
        queue: [...(t.queue ?? []), item],
        queueActive: true,
        queueKick: (t.queueKick ?? 0) + 1,
      } as Tab;
    });
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  forceAgentQueueSend: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => {
      if (t.id !== tabId || t.type !== "terminal" || !(t.queue?.length)) return t;
      // Re-activate in case the loop had stalled, then bump the force kick so
      // TerminalPane drains the head right now (ignoring the mid-turn guard).
      return {
        ...t,
        queueActive: true,
        queueForceKick: (t.queueForceKick ?? 0) + 1,
      } as Tab;
    });
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  persistTab: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, preview: false } as Tab : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  openPreviewTab: (wsId, data) => set(s => {
    // File/edit/diff tabs always open in the main pane.
    const list = s.tabs[wsId] || [];
    const mainList = list.filter(t => !(t as TerminalTab).paneId);
    const previewTab = mainList.find(t => t.preview);

    const setActive = (id: string): Partial<AppState> =>
      ({ activeTab: { ...s.activeTab, [wsId]: id } });

    const existing = mainList.find(t => t.type === data.type && (t as any).path === data.path);
    if (existing) {
      const next = data.revealAt && existing.type === "edit"
        ? list.map(t => t.id === existing.id ? { ...t, revealAt: data.revealAt } as Tab : t)
        : list;
      return { tabs: { ...s.tabs, [wsId]: next }, ...setActive(existing.id) };
    }

    if (previewTab) {
      const next = list.map(t => t.id === previewTab.id ? {
        ...t,
        type: data.type,
        path: data.path,
        title: data.title,
        liveTitle: undefined,
        customTitle: false,
        dirty: false,
        preview: true,
        ...(data.revealAt && data.type === "edit" ? { revealAt: data.revealAt } : {}),
      } as Tab : t);
      return { tabs: { ...s.tabs, [wsId]: next }, ...setActive(previewTab.id) };
    }

    const newTab: Tab = {
      id: crypto.randomUUID(),
      type: data.type,
      title: data.title,
      path: data.path,
      preview: true,
      ...(data.revealAt && data.type === "edit" ? { revealAt: data.revealAt } : {}),
    } as any;
    return { tabs: { ...s.tabs, [wsId]: [...list, newTab] }, ...setActive(newTab.id) };
  }),

  consumeReveal: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    if (!list.some(t => t.id === tabId && t.type === "edit" && (t as any).revealAt)) return s;
    const next = list.map(t => t.id === tabId && t.type === "edit"
      ? { ...t, revealAt: undefined } as Tab
      : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  renameTab: (wsId, tabId, title) => {
    set(s => {
      const list = s.tabs[wsId] || [];
      const trimmed = title.trim();
      if (!trimmed) return s;
      // Manual rename = locked title. Subsequent OSC 0/2 emissions
      // from the running program won't overwrite it (`customTitle` is
      // the gate the TabBar / setTabLiveTitle path checks).
      const next = list.map(t => t.id === tabId ? { ...t, title: trimmed, customTitle: true } as Tab : t);
      return { tabs: { ...s.tabs, [wsId]: next } };
    });
    get().syncDurableTabs(wsId);
  },

  clearTabCustomTitle: (wsId, tabId) => {
    set(s => {
      const list = s.tabs[wsId] || [];
      const next = list.map(t => t.id !== tabId ? t : { ...t, customTitle: false } as Tab);
      return { tabs: { ...s.tabs, [wsId]: next } };
    });
    get().syncDurableTabs(wsId);
  },

  setTabLiveTitle: (wsId, tabId, liveTitle) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => {
      if (t.id !== tabId) return t;
      // Locked tab: drop the agent's title entirely (user picked one).
      if (t.customTitle) return t;
      return { ...t, liveTitle } as Tab;
    });
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  markAttention: (wsId, tabId, reason) => set(s => {
    // Always mark — iTerm2 shows the bullet/bell even on the focused
    // tab so users have a clear "yes, this turn really finished"
    // confirmation. OS notification suppression for the focused
    // workspace lives in useAttentionNotifier (focus gating), not
    // here. Indicator clears on user input (term.onData) — never on
    // tab view.
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, unread: { reason } } as Tab : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  clearAttention: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, unread: null } as Tab : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  setWorkState: (wsId, tabId, state) => set(s => {
    const list = s.tabs[wsId] || [];
    const cur = list.find(t => t.id === tabId);
    if (!cur || cur.type !== "terminal") return s;
    // Sticky `done`: once we've marked the agent as finished, an
    // immediate "back to working" signal from the same turn is
    // noise (Claude oscillates ✳ ↔ spinner for a few frames right
    // after a response). The only paths out of "done" are:
    //   - user input (term.onData clears it to "idle")
    //   - tab/workspace focus (setActiveTabId clears it to "idle")
    // i.e. the user explicitly acknowledges the bullet. Agent signals
    // can't flip "done" → "working" by themselves.
    if (cur.workState === "done" && state === "working") return s;
    // A second "done" signal on an already-done tab is a no-op — skip
    // the focused-tab downgrade logic that would turn it into "idle" and
    // wipe the bullet. The only exits from "done" are user-driven
    // (keypress in term.onData, focus in setActiveWorkspace).
    if (cur.workState === "done" && state === "done") return s;
    // Focused tab gating:
    //   - "done" on the tab the user is actively looking at (active
    //     workspace AND active tab) → drop to "idle". They can see the
    //     agent finished; no badge needed on what's in front of them.
    //     The badge is for tabs the user has navigated AWAY from.
    //   - "working" on the focused tab → drop to "idle" ONLY within a
    //     short grace window after a manual clear (setActiveTabId /
    //     workspace activation). The grace stops a stuck spinner from
    //     instantly re-arming after the user clicked to dismiss it.
    //     OUTSIDE the grace window, working applies normally — so the
    //     spinner + progress bar show right after a fresh submit.
    let effective = state;
    const tKey = s.activeTab[wsId];
    const tree = tKey ? s.splitTree[tKey] : undefined;
    const activePaneLeaf = tree ? findLeaf(tree, s.activePaneId[tKey!]) : null;
    const isFocused = s.activeWorkspaceId === wsId &&
      (s.activeTab[wsId] === tabId || activePaneLeaf?.tabId === tabId);
    if (isFocused) {
      if (effective === "done") {
        effective = "idle";
      } else if (effective === "working") {
        const clearedAt = cur.workClearedAt ?? 0;
        const GRACE_MS = 5_000;
        if (clearedAt > 0 && Date.now() - clearedAt < GRACE_MS) {
          effective = "idle";
        }
      }
    }
    if ((cur.workState ?? "idle") === effective) return s;
    // Falling edge of "working" → the agent just finished a turn, so any
    // files it touched are now settled on disk. Bump fsRevision so the file
    // tree / open editors / Git panel re-read. This is our FS-watcher stand-in:
    // it fires once per turn, only when an agent was actually working.
    const settled = cur.workState === "working" && effective !== "working";
    const next = list.map(t => {
      if (t.id !== tabId) return t;
      // Leaving "working" → clear progress so the bar disappears on
      // done/idle. Entering "working" keeps any prior pct that just
      // came in via OSC 9;4 (set in the same parser turn).
      const patch: Partial<TerminalTab> = { workState: effective };
      if (effective !== "working") {
        patch.workProgress = null;
        patch.workProgressKind = null;
      }
      return { ...t, ...patch } as Tab;
    });
    return {
      tabs: { ...s.tabs, [wsId]: next },
      ...(settled
        ? { fsRevision: { ...s.fsRevision, [wsId]: (s.fsRevision[wsId] ?? 0) + 1 } }
        : null),
    };
  }),

  bumpFsRevision: (wsId) => set(s => ({
    fsRevision: { ...s.fsRevision, [wsId]: (s.fsRevision[wsId] ?? 0) + 1 },
  })),

  setWorkProgress: (wsId, tabId, pct, kind) => set(s => {
    const list = s.tabs[wsId] || [];
    const cur = list.find(t => t.id === tabId);
    if (!cur || cur.type !== "terminal") return s;
    const clamped = pct === null ? null : Math.max(0, Math.min(100, Math.round(pct)));
    if ((cur.workProgress ?? null) === clamped && (cur.workProgressKind ?? null) === kind) return s;
    const next = list.map(t => t.id === tabId
      ? { ...t, workProgress: clamped, workProgressKind: kind } as Tab
      : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),
}));

// Convenience selectors. CRITICAL: never create a new array/object literal
// inside the selector — Zustand 5 / React 19 will warn (or worse, loop) on
// non-cached snapshots. We use a shared EMPTY constant for the "no tabs" case.
const EMPTY_TABS: Tab[] = Object.freeze([]) as unknown as Tab[];

export const useActiveWorkspace = () => useApp(s => {
  const id = s.activeWorkspaceId;
  if (!id) return null;
  return s.workspaces.find(w => w.id === id) ?? null;
});
/** All tabs for a workspace (main pane + split panes). */
export const useWorkspaceTabs = (wsId: string | null | undefined) =>
  useApp(s => (wsId ? (s.tabs[wsId] ?? EMPTY_TABS) : EMPTY_TABS));
export const useActiveTabId = (wsId: string | null | undefined) =>
  useApp(s => (wsId ? s.activeTab[wsId] : undefined));
