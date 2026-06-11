// Single Zustand store. Mirrors the legacy `state` object but with React-shaped
// updates (immutable replacements, not in-place mutations).

import { create } from "zustand";
import type { Project, Workspace, Tab, TerminalTab, PersistedTab } from "@/lib/types";
import * as ipc from "@/lib/ipc";
import { focusTerminalTab } from "@/lib/tabFocus";
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
  settingsTab?: "general" | "appearance" | "agents" | "repositories" | "shortcuts";
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
  bottomTabs: Record<string, { id: string; title: string }[]>;
  /** Per-workspace: id of the active bottom-terminal tab. */
  activeBottomTab: Record<string, string>;
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
  /** Returns the id of the new bottom tab. */
  addBottomTab: (wsId: string) => string;
  closeBottomTab: (wsId: string, tabId: string) => void;
  setActiveBottomTab: (wsId: string, tabId: string) => void;

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
}

const LS_COMPACT = "compactSidebar";
const LS_RPANEL  = "rightPanelHidden";
const LS_SPLIT   = "terminalSplit";       // Record<wsId, boolean>
const LS_SPLITH  = "terminalSplitHeight"; // Record<wsId, number>
const LS_SPLITC  = "terminalSplitCollapsed"; // Record<wsId, boolean>
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

/** The durable subset of a workspace's tabs, in display order: agent and
 *  custom-command tabs (these relaunch / resume), but NOT shell / scratch
 *  terminals (no session to resume). Maps onto the Rust `PersistedTab`. */
function durablePersistedTabs(tabs: Tab[] | undefined): PersistedTab[] {
  return (tabs ?? [])
    .filter((t): t is TerminalTab => t.type === "terminal" && (t as TerminalTab).cli !== "shell")
    .map(t => ({
      id: t.id,
      cli: t.cli,
      // Only carry a title when the user renamed it — otherwise the agent
      // display name is re-derived on restore (and may have changed).
      title: t.customTitle ? t.title : null,
      custom_title: !!t.customTitle,
      is_default: !!t.is_default,
      command: t.command ?? null,
      session_id: t.sessionId ?? null,
    }));
}

export const useApp = create<AppState>((set, get) => ({
  projects: [],
  workspaces: [],
  activeWorkspaceId: null,
  tabs: {},
  activeTab: {},
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
    return { compactSidebar: next };
  }),
  toggleRightPanel: () => set(s => {
    const next = !s.rightPanelHidden;
    try { localStorage.setItem(LS_RPANEL, next ? "1" : "0"); } catch {}
    return { rightPanelHidden: next };
  }),

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

  addBottomTab: (wsId) => {
    const id = crypto.randomUUID();
    set(s => {
      const list = s.bottomTabs[wsId] || [];
      const title = `shell ${list.length + 1}`;
      return {
        bottomTabs:      { ...s.bottomTabs, [wsId]: [...list, { id, title }] },
        activeBottomTab: { ...s.activeBottomTab, [wsId]: id },
      };
    });
    // Move focus into the freshly-spawned shell so the user can type
    // straight away. Covers the bottom-strip "+", ⌘T and ⇧⌘D.
    focusTerminalTab(id);
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
        return {
          bottomTabs:      { ...s.bottomTabs, [wsId]: next },
          activeBottomTab: { ...s.activeBottomTab, [wsId]: "" },
          terminalSplit:   { ...s.terminalSplit, [wsId]: false },
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

  ensureDefaultTab: (wsId, cli) => {
    const s = get();
    // Already mounted (visited this session) → leave the live tabs alone.
    if ((s.tabs[wsId] || []).length) return;
    const ws = s.workspaces.find(w => w.id === wsId);
    const persisted = ws?.persisted_tabs ?? [];

    // Restore path: a prior session left a durable agent-tab set. Bring
    // back every tab (not just the primary), each with its own session id
    // so id-capable agents resume independently. This is the "quit the app,
    // reopen the workspace, everything is back" behavior.
    if (persisted.length) {
      // Repair corruption from older builds: a buggy close path could wipe
      // then re-seed the default tab, leaving SEVERAL entries all flagged
      // is_default (each a phantom "main agent"). Restoring all of them spawns
      // a pile of agents that collide on session ids. There is only ever ONE
      // main, so dedupe by id and DROP every is_default entry after the first
      // (real secondary agents are is_default:false and are kept).
      const seenIds = new Set<string>();
      let keptDefault = false;
      const clean = persisted.filter(pt => {
        if (seenIds.has(pt.id)) return false;
        seenIds.add(pt.id);
        if (pt.is_default) {
          if (keptDefault) return false; // extra phantom main → drop
          keptDefault = true;
        }
        return true;
      });
      const wasCorrupt = clean.length !== persisted.length;
      const restored: TerminalTab[] = clean.map(pt => ({
        id: pt.id,
        type: "terminal",
        cli: pt.cli,
        // Honor a user rename; otherwise re-derive the display name (the
        // agent's configured name may have changed since last launch).
        title: pt.custom_title && pt.title ? pt.title : agentDisplayName(pt.cli, s.agents),
        customTitle: !!pt.custom_title,
        is_default: !!pt.is_default,
        ...(pt.command ? { command: pt.command } : {}),
        ...(pt.session_id ? { sessionId: pt.session_id } : {}),
      }));
      const active = restored.find(t => t.is_default) ?? restored[0];
      // When we repaired corruption, overwrite persisted_tabs DIRECTLY with
      // the cleaned set — can't go through syncDurableTabs, whose merge would
      // re-add the dropped phantom tabs as "closed-but-durable".
      const cleaned = wasCorrupt ? durablePersistedTabs(restored) : null;
      set(state => ({
        tabs: { ...state.tabs, [wsId]: restored },
        activeTab: { ...state.activeTab, [wsId]: active?.id ?? "" },
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

  forgetTab: (wsId, tabId) => {
    // Explicit "close & forget": drop the agent from the durable set so it
    // does NOT come back on reopen, then close it. Order matters — remove from
    // persisted BEFORE closeTab's syncDurableTabs runs, so the merge can't
    // re-add it.
    const ws = get().workspaces.find(w => w.id === wsId);
    if (ws) {
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
      return {
        ...(nextTabs ? { tabs: { ...s.tabs, [wsId]: nextTabs } } : {}),
        workspaces: s.workspaces.map(w => w.id !== wsId ? w : {
          ...w,
          persisted_tabs: (w.persisted_tabs ?? []).map(pt =>
            pt.id === tabId ? { ...pt, session_id: uuid || null } : pt,
          ),
        }),
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
    let active = s.activeTab[wsId];
    if (wasActive) active = next[Math.max(0, idx - 1)]?.id || next[0]?.id || "";
    // Last tab closed → put the workspace to sleep. activeWorkspaceId
    // clears so the dashboard takes over the main pane; the workspace
    // also drops out of mountedWorkspaces below so xterm.js + every
    // PTY for it tear down. Re-entering via the sidebar re-mounts
    // and ensureDefaultTab spawns a fresh agent tab.
    const isLast = next.length === 0;
    // Closed the focused tab and another tab survives → focus follows
    // to the tab that takes over (the previous one), so ⌘W-ing through
    // tabs keeps keyboard focus in the main pane.
    if (wasActive && !isLast) focusId = active;
    const update: Partial<typeof s> = {
      tabs: { ...s.tabs, [wsId]: next },
      activeTab: { ...s.activeTab, [wsId]: active },
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

  persistTab: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, preview: false } as Tab : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  openPreviewTab: (wsId, data) => set(s => {
    const list = s.tabs[wsId] || [];
    const existing = list.find(t => t.type === data.type && (t as any).path === data.path);
    if (existing) {
      // If a revealAt was requested (Find-in-Files click), refresh it on
      // the existing tab so EditorPane scrolls to the new line. Otherwise
      // leave the tab as-is.
      const next = data.revealAt && existing.type === "edit"
        ? list.map(t => t.id === existing.id ? { ...t, revealAt: data.revealAt } as Tab : t)
        : list;
      return {
        tabs: { ...s.tabs, [wsId]: next },
        activeTab: { ...s.activeTab, [wsId]: existing.id }
      };
    }

    const previewTab = list.find(t => t.preview);
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
      return {
        tabs: { ...s.tabs, [wsId]: next },
        activeTab: { ...s.activeTab, [wsId]: previewTab.id }
      };
    }

    const newTab: Tab = {
      id: crypto.randomUUID(),
      type: data.type,
      title: data.title,
      path: data.path,
      preview: true,
      ...(data.revealAt && data.type === "edit" ? { revealAt: data.revealAt } : {}),
    } as any;
    return {
      tabs: { ...s.tabs, [wsId]: [...list, newTab] },
      activeTab: { ...s.activeTab, [wsId]: newTab.id }
    };
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
    // Persist the renamed title so it survives restart.
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
    if (s.activeWorkspaceId === wsId && s.activeTab[wsId] === tabId) {
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
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

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
export const useWorkspaceTabs = (wsId: string | null | undefined) =>
  useApp(s => (wsId ? (s.tabs[wsId] ?? EMPTY_TABS) : EMPTY_TABS));
export const useActiveTabId = (wsId: string | null | undefined) =>
  useApp(s => (wsId ? s.activeTab[wsId] : undefined));
