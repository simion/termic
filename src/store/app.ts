// Single Zustand store. Mirrors the legacy `state` object but with React-shaped
// updates (immutable replacements, not in-place mutations).

import { create } from "zustand";
import type { Project, Workspace, Tab, TerminalTab } from "@/lib/types";
import * as ipc from "@/lib/ipc";

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
  /** Editable agent registry from settings.json. Loaded by `loadAll` so
   *  `spawnArgsForCli` can consult `agent.command + args + capabilities`
   *  instead of hard-coding by CLI string. Empty until first loadAll. */
  agents: import("@/lib/types").Agent[];

  // ── actions ──
  loadAll: () => Promise<void>;
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
  toggleProjectCollapsed: (projectId: string) => void;
  setTerminalSplitHeight: (wsId: string, px: number) => void;
  /** Returns the id of the new bottom tab. */
  addBottomTab: (wsId: string) => string;
  closeBottomTab: (wsId: string, tabId: string) => void;
  setActiveBottomTab: (wsId: string, tabId: string) => void;

  ensureDefaultTab: (wsId: string, cli: string) => void;
  addTab: (wsId: string, tab: Tab) => void;
  closeTab: (wsId: string, tabId: string) => void;
  setActiveTabId: (wsId: string, tabId: string) => void;
  patchTab: (wsId: string, tabId: string, patch: Partial<TerminalTab>) => void;
  renameTab: (wsId: string, tabId: string, title: string) => void;
  markAttention: (wsId: string, tabId: string, reason: "bell" | "idle" | "exit") => void;
  clearAttention: (wsId: string, tabId: string) => void;
}

const LS_COMPACT = "compactSidebar";
const LS_RPANEL  = "rightPanelHidden";
const LS_SPLIT   = "terminalSplit";       // Record<wsId, boolean>
const LS_SPLITH  = "terminalSplitHeight"; // Record<wsId, number>
const LS_SBW     = "sidebarWidth";
const LS_RPW     = "rightPanelWidth";
const LS_RFH     = "rightFooterHeight";
const LS_COLLAPSED_PROJ = "collapsedProjects"; // Record<projId, true>
const initialCollapsed = (() => { try { return JSON.parse(localStorage.getItem(LS_COLLAPSED_PROJ) || "{}"); } catch { return {}; } })();

const initialCompact = (() => { try { return localStorage.getItem(LS_COMPACT) === "1"; } catch { return false; } })();
const initialHidden  = (() => { try { return localStorage.getItem(LS_RPANEL)  === "1"; } catch { return false; } })();
const initialSplit   = (() => { try { return JSON.parse(localStorage.getItem(LS_SPLIT)  || "{}"); } catch { return {}; } })();
const initialSplitH  = (() => { try { return JSON.parse(localStorage.getItem(LS_SPLITH) || "{}"); } catch { return {}; } })();
const numOrDefault = (k: string, fallback: number) => {
  // Math.round on read too — protects against any older saved fractional
  // value sneaking through and re-blurring the layout on next launch.
  try { const v = Math.round(Number(localStorage.getItem(k))); return Number.isFinite(v) && v > 0 ? v : fallback; }
  catch { return fallback; }
};
const initialSBW = numOrDefault(LS_SBW, 220);
const initialRPW = numOrDefault(LS_RPW, 360);
const initialRFH = numOrDefault(LS_RFH, 260);

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
  bottomTabs: {},
  activeBottomTab: {},
  mountedWorkspaces: new Set<string>(),
  footerTerm: {},
  collapsedProjects: initialCollapsed as Record<string, boolean>,
  agents: [],

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
    set({
      activeWorkspaceId: id,
      view: { page: id ? "dashboard" : get().view.page },
      mountedWorkspaces: nextMounted,
    });
    if (id) {
      const tabs = get().tabs[id] || [];
      const activeId = get().activeTab[id];
      const active = tabs.find(x => x.id === activeId);
      if (active?.unread) get().clearAttention(id, active.id);
    }
  },

  setView: (page) => set({ view: { page }, activeWorkspaceId: null }),
  // Opening Settings does NOT clear `activeWorkspaceId` or change `view.page`
  // away from whatever the user was on — Settings renders as a fixed
  // z-40 overlay (App.tsx). Preserving the underlying state means closing
  // Settings drops the user back into the exact workspace + tab they were
  // in, terminals still running, no context lost.
  openSettings: (tab = "appearance", repoId) =>
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
  enableFooterTerm:  (wsId) => set(s => ({ footerTerm: { ...s.footerTerm, [wsId]: true } })),
  disableFooterTerm: (wsId) => set(s => {
    const { [wsId]: _, ...rest } = s.footerTerm; void _;
    return { footerTerm: rest };
  }),
  toggleProjectCollapsed: (projectId) => set(s => {
    const next = { ...s.collapsedProjects };
    if (next[projectId]) delete next[projectId]; else next[projectId] = true;
    try { localStorage.setItem(LS_COLLAPSED_PROJ, JSON.stringify(next)); } catch {}
    return { collapsedProjects: next };
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
    return id;
  },
  closeBottomTab: (wsId, tabId) => set(s => {
    const list = s.bottomTabs[wsId] || [];
    const idx = list.findIndex(t => t.id === tabId);
    if (idx < 0) return s;
    const next = list.filter(t => t.id !== tabId);
    let active = s.activeBottomTab[wsId];
    if (active === tabId) active = next[Math.max(0, idx - 1)]?.id || next[0]?.id || "";
    return {
      bottomTabs:      { ...s.bottomTabs, [wsId]: next },
      activeBottomTab: { ...s.activeBottomTab, [wsId]: active },
    };
  }),
  setActiveBottomTab: (wsId, tabId) => set(s => ({
    activeBottomTab: { ...s.activeBottomTab, [wsId]: tabId },
  })),

  ensureDefaultTab: (wsId, cli) => set(s => {
    const list = s.tabs[wsId] || [];
    if (list.length) return s;
    const tab: TerminalTab = { id: crypto.randomUUID(), type: "terminal", title: cli, cli };
    return {
      tabs: { ...s.tabs, [wsId]: [tab] },
      activeTab: { ...s.activeTab, [wsId]: tab.id },
    };
  }),

  addTab: (wsId, tab) => set(s => {
    const next = [...(s.tabs[wsId] || []), tab];
    return { tabs: { ...s.tabs, [wsId]: next }, activeTab: { ...s.activeTab, [wsId]: tab.id } };
  }),

  closeTab: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    const idx = list.findIndex(t => t.id === tabId);
    if (idx < 0) return s;
    const closing = list[idx];
    // Best-effort PTY kill; ignore failures (already-dead PTYs etc.).
    if (closing.type === "terminal" && closing.ptyId) ipc.ptyKill(closing.ptyId).catch(() => {});
    const next = list.filter(t => t.id !== tabId);
    let active = s.activeTab[wsId];
    if (active === tabId) active = next[Math.max(0, idx - 1)]?.id || next[0]?.id || "";
    return {
      tabs: { ...s.tabs, [wsId]: next },
      activeTab: { ...s.activeTab, [wsId]: active },
    };
  }),

  setActiveTabId: (wsId, tabId) => set(s => ({ activeTab: { ...s.activeTab, [wsId]: tabId } })),

  patchTab: (wsId, tabId, patch) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, ...patch } as Tab : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  renameTab: (wsId, tabId, title) => set(s => {
    const list = s.tabs[wsId] || [];
    const trimmed = title.trim();
    if (!trimmed) return s;
    const next = list.map(t => t.id === tabId ? { ...t, title: trimmed } : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  markAttention: (wsId, tabId, reason) => set(s => {
    // Never mark the tab the user is currently looking at — they can see
    // whatever just happened (idle / bell / exit) directly. Marking it would
    // produce a noisy sidebar dot on the active workspace and feed a
    // pointless OS notification through useAttentionNotifier.
    if (s.activeWorkspaceId === wsId && s.activeTab[wsId] === tabId) return s;
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, unread: { reason } } as Tab : t);
    return { tabs: { ...s.tabs, [wsId]: next } };
  }),

  clearAttention: (wsId, tabId) => set(s => {
    const list = s.tabs[wsId] || [];
    const next = list.map(t => t.id === tabId ? { ...t, unread: null } as Tab : t);
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
