// Left sidebar: traffic-light spacer, toggle, primary nav, projects tree, footer.
// Two layout flavors: full (220px) vs compact (56px, icon-only with tooltips).

import { useEffect, useRef, useState } from "react";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { LayoutGrid, History, RefreshCw, FolderPlus, Settings, Plus, Archive, Layers, Moon, Cog, GitBranchPlus, FolderGit2, ChevronRight, ChevronDown, Check, Bell, Bug, Mail, Shield, X } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu } from "@/components/ui/Dropdown";
import { ProjectActionsMenuItems } from "./ProjectActionsMenuItems";
import { UpdateCard } from "./UpdateCard";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { agentDisplayName } from "@/lib/agents";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import { requestCloseTab } from "@/lib/closeTab";
import { workspaceRename, projectRename, workspaceArchive, workspaceOpenRepo, openPath, projectReorder } from "@/lib/ipc";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import type { Workspace, TerminalTab } from "@/lib/types";

export function Sidebar() {
  const compact = useApp(s => s.compactSidebar);
  const openSettings = useApp(s => s.openSettings);
  const projects = useApp(s => s.projects);
  const sidebarWidth = useApp(s => s.sidebarWidth);
  const setSidebarWidth = useApp(s => s.setSidebarWidth);
  const workspaces = useApp(s => s.workspaces);
  const activeWs = useApp(s => s.activeWorkspaceId);
  const setActive = useApp(s => s.setActiveWorkspace);
  const setView = useApp(s => s.setView);
  const currentView = useApp(s => s.view.page);
  const tabs = useApp(s => s.tabs);
  const loadAll = useApp(s => s.loadAll);
  const openNewProject = useUI(s => s.openNewProject);
  const openNewWorkspace = useUI(s => s.openNewWorkspace);
  const collapsedProjects = useApp(s => s.collapsedProjects);
  const setProjectCollapsed = useApp(s => s.setProjectCollapsed);
  // (agents subscription lives inside ProjectActionsMenuItems now —
  // Sidebar itself doesn't need the registry.)

  // If the user disabled the settled highlight (Settings → General),
  // every isUnread() call returns false — the icon stays in its calm
  // state regardless of agent activity.
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const isUnread = (wsId: string) =>
    settledHighlight &&
    (tabs[wsId] || []).some(t => t.type === "terminal" && t.unread);

  /** Build a mailto: URL with prefilled subject + body and hand it to
   *  the OS's default mail handler via `open_path` (the same Rust
   *  command the Open button uses for preview URLs — it shells out to
   *  macOS `open`, which DTRT for mailto: too). */
  const openMailto = (to: string, subject: string, body: string) => {
    const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    openPath(url).catch(() => {});
  };
  /** True if ANY tab in the workspace just transitioned to settled/idle
   *  (work-done signal — agent stopped producing output, waiting on
   *  user). Gated on the same `settledHighlight` pref so the check
   *  disappears entirely when the user disables the work-done UI. */
  const isWorkDone = (wsId: string) =>
    settledHighlight &&
    (tabs[wsId] || []).some(t =>
      // `idle` (old stdout-cadence heuristic) ships too many false
      // positives — only honor the sender-driven `done` now.
      t.type === "terminal" && t.unread?.reason === "done",
    );
  // Distinct from work-done: the agent is explicitly blocked on the
  // user (Gemini ✋ Action Required, Codex Waiting, OSC 1337
  // RequestAttention). Different sidebar icon (bell vs check).
  const needsAttention = (wsId: string) =>
    settledHighlight &&
    (tabs[wsId] || []).some(t =>
      t.type === "terminal" && t.unread?.reason === "attention",
    );
  const isLoaded = (wsId: string) =>
    (tabs[wsId] || []).some(t => t.type === "terminal" && t.ptyId);

  // Inline rename state for PROJECTS only. Workspace rename is managed
  // inside WorkspaceRow so it can co-exist with per-tab rename state.
  const [renaming, setRenaming] = useState<{ kind: "proj"; id: string; value: string } | null>(null);
  // Project whose `+` dropdown is currently open. Used to keep the row
  // visually "hovered" (bg + Cog visible) while the menu is open;
  // otherwise the menu trigger looks like it un-selected its parent.
  const [menuOpenProjectId, setMenuOpenProjectId] = useState<string | null>(null);
  // Drag-to-reorder PROJECTS. Pointer-event based (WKWebView's HTML5
  // DnD is unreliable in Tauri). The row physically moves during the
  // drag — we mutate the live `projects` order in the app store on
  // every pointermove, so the item being dragged actually shifts
  // past siblings instead of just showing a drop-target ring.
  //
  // CRITICAL: pointermove + pointerup listeners go on `document`,
  // NOT the per-row React element. When the array reorders mid-drag,
  // React detaches + reattaches the moved DOM node, which kills any
  // pointer capture held on it — subsequent moves fire on whatever
  // element sits under the cursor, and per-row handlers bail because
  // they check `armed.id !== p.id`. Document-level listeners survive
  // every reorder.
  //
  // Flow:
  //   onPointerDown (per-row) → arm dragArmed.current + add document
  //     pointermove/pointerup listeners
  //   document pointermove past 4px → enter dragging
  //   document pointermove while dragging → hit-test, splice store
  //   document pointerup → IPC project_reorder + clean up listeners
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  const dragArmed = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);
  const dragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);

  // Tear-down helper, used by both pointerup and pointercancel.
  const endDrag = (commit: boolean) => {
    const ls = dragListenersRef.current;
    if (ls) {
      document.removeEventListener("pointermove", ls.move);
      document.removeEventListener("pointerup", ls.up);
      document.removeEventListener("pointercancel", ls.up);
      dragListenersRef.current = null;
    }
    const wasStarted = dragArmed.current?.started ?? false;
    dragArmed.current = null;
    setDragProjectId(null);
    if (commit && wasStarted) {
      const finalIds = useApp.getState().projects.map(x => x.id);
      projectReorder(finalIds).catch(() => { void useApp.getState().loadAll(); });
    }
  };

  // Single shared pointermove handler — keyed off armed.id (the
  // dragged project) rather than any per-row closure. Survives the
  // dragged element being reparented during reorder.
  const onDragPointerMove = (e: PointerEvent) => {
    const armed = dragArmed.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return;
      armed.started = true;
      setDragProjectId(armed.id);
    }
    const dragId = armed.id;
    const all = useApp.getState().projects;
    const fromIdx = all.findIndex(x => x.id === dragId);
    if (fromIdx === -1) return;
    const others = Array.from(
      document.querySelectorAll<HTMLElement>('[data-project-id]'),
    ).filter(el => el.dataset.projectId !== dragId);
    let beforeId: string | null = null;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (e.clientY < (r.top + r.bottom) / 2) {
        beforeId = el.dataset.projectId ?? null;
        break;
      }
    }
    const nextIds = all.map(x => x.id).filter(id => id !== dragId);
    const insertAt = beforeId
      ? nextIds.findIndex(id => id === beforeId)
      : nextIds.length;
    const targetIdx = insertAt === -1 ? nextIds.length : insertAt;
    if (targetIdx === fromIdx) return;
    nextIds.splice(targetIdx, 0, dragId);
    useApp.setState(s => ({
      projects: nextIds.map(id => s.projects.find(x => x.id === id)!).filter(Boolean),
    }));
  };

  async function commitRename() {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      await projectRename(id, trimmed);
      await loadAll();
    } catch (e) { console.error("rename failed", e); }
  }

  const asideRef = useRef<HTMLElement>(null);

  return (
    <aside ref={asideRef} className="relative flex h-full flex-col overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      {/* Primary nav: Dashboard / History (no top chrome — that's the unified bar's job now) */}
      <nav className={cn("flex flex-col gap-0.5", compact ? "p-1.5 pt-2" : "p-2 pt-3")}>
        <NavItem icon={<LayoutGrid className={iconSize(compact)} />} label="Dashboard"
          active={currentView === "dashboard" && !activeWs} compact={compact}
          onClick={() => setView("dashboard")}
        />
        <NavItem icon={<History className={iconSize(compact)} />} label="History"
          active={currentView === "history" && !activeWs} compact={compact}
          onClick={() => setView("history")}
        />
      </nav>

      {/* Projects section */}
      <div className={cn(compact ? "px-1.5 py-1.5" : "px-2 py-2")}>
        <div className={cn(
          "flex items-center justify-between text-[12px] uppercase tracking-wider text-[var(--color-fg-dim)]",
          compact ? "flex-col gap-1.5 py-1" : "px-2 py-1",
        )}>
          {!compact && <span>Projects</span>}
          <div className={cn("flex gap-0.5", compact && "flex-col")}>
            <Tip content="Refresh"><Button size="icon" variant="icon" onClick={() => loadAll()}>
              <RefreshCw className={iconSize(compact)} /></Button></Tip>
            <Tip content="Add project"><Button size="icon" variant="icon" onClick={openNewProject}>
              <FolderPlus className={iconSize(compact)} /></Button></Tip>
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          {projects.map(p => {
            const wsList = workspaces.filter(w => w.project_id === p.id && !w.archived);
            // Empty projects default to collapsed (no point pinning a blank
            // expanded row). User overrides stick: explicit true / false
            // wins; undefined falls back to emptiness-based default.
            const explicit = collapsedProjects[p.id];
            const collapsed = explicit !== undefined ? explicit : wsList.length === 0;
            return (
              <div
                key={p.id}
                className="rounded-md"
              >
                <Tip content={compact ? p.name : ""}>
                  <div
                    // data-project-id lives on the HEADER (not the
                    // wrapper) because the wrapper includes all the
                    // nested workspace rows — its bounding rect can
                    // be 6× the header's height, putting the midpoint
                    // far below the visible row. Hit-testing against
                    // headers means the cursor only has to traverse
                    // a single header's height to trigger a swap,
                    // matching what the user sees.
                    data-project-id={p.id}
                    // Project header is the drag handle. Pointer-down
                    // arms it (doesn't commit to "we're dragging" yet);
                    // a pointer-move past the threshold flips into
                    // dragging mode. Plain click → collapse toggle
                    // still fires because pointerup before threshold
                    // hits the click path normally.
                    onPointerDown={(e) => {
                      if (compact) return;
                      if (e.button !== 0) return;
                      const target = e.target as HTMLElement;
                      if (target.closest('button, input, a, [data-no-drag]')) return;
                      dragArmed.current = { id: p.id, x: e.clientX, y: e.clientY, started: false };
                      // Attach document-level listeners so drag
                      // tracking survives the dragged DOM node being
                      // reparented mid-drag (React reorders kill
                      // element-level pointer capture).
                      const onUp = (ev: PointerEvent) => {
                        const armed = dragArmed.current;
                        const wasStarted = armed?.started ?? false;
                        endDrag(true);
                        // Plain click (no drag past threshold) →
                        // toggle collapse, matching the original
                        // header onClick behavior we replaced.
                        if (armed && !wasStarted && ev.target instanceof Node) {
                          // Only fire collapse if pointerup is still
                          // over the same project header — same as a
                          // real click would behave.
                          const header = (ev.target as HTMLElement).closest('[data-project-id]') as HTMLElement | null;
                          if (header?.dataset.projectId === p.id) {
                            setProjectCollapsed(p.id, !collapsed);
                          }
                        }
                      };
                      dragListenersRef.current = { move: onDragPointerMove, up: onUp };
                      document.addEventListener("pointermove", onDragPointerMove);
                      document.addEventListener("pointerup", onUp);
                      document.addEventListener("pointercancel", onUp);
                    }}
                    className={cn(
                      "group flex items-center justify-between rounded-md text-[12px] font-semibold uppercase tracking-[0.06em] hover:bg-[var(--color-hover)] cursor-pointer transition-colors",
                      wsList.length === 0 ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg)]",
                      menuOpenProjectId === p.id && "bg-[var(--color-hover)]",
                      compact ? "px-0 py-1 justify-center" : "pl-2 pr-0 py-1.5",
                      dragProjectId === p.id && "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
                    )}
                  >
                    {compact ? (
                      // Compact mode: chevron alone, rotates 90° when expanded
                      // so the user can still tell the project's state at
                      // a glance even without the workspaces row underneath.
                      collapsed
                        ? <ChevronRight className="h-4 w-4 text-[var(--color-fg-dim)]" />
                        : <ChevronDown  className="h-4 w-4 text-[var(--color-fg-dim)]" />
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center gap-1.5">
                          {collapsed
                            ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                            : <ChevronDown  className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                          }
                          {/* Multi-repo projects get a Layers icon next
                              to their name so they're visually
                              distinguishable from regular single-repo
                              projects. The icon uses the accent color
                              so it pops at the typography weight
                              everything else in the row sits at. */}
                          {(p.type ?? "single") === "multi" && (
                            <Tip content="Multi-repo project">
                              <Layers className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
                            </Tip>
                          )}
                          {renaming && renaming.kind === "proj" && renaming.id === p.id ? (
                            <input
                              autoFocus
                              value={renaming.value}
                              onChange={e => setRenaming({ ...renaming, value: e.target.value })}
                              onBlur={commitRename}
                              onKeyDown={e => {
                                if (e.key === "Enter") commitRename();
                                else if (e.key === "Escape") setRenaming(null);
                              }}
                              onClick={e => e.stopPropagation()}
                              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                              className="rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13.5px] outline-none w-full"
                            />
                          ) : (
                            <span className="truncate">{p.name}</span>
                          )}
                        </div>
                        {/* Trio of project-row actions revealed on hover.
                            Settings + Open-repo-as-workspace are hover-only
                            so the row stays clean; New-workspace stays
                            visible because it's the headline action. */}
                        <div className="flex items-center gap-0.5">
                          <Tip content="Project settings">
                            <button
                              className={cn(
                                "rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] transition-opacity",
                                // Stay visible while the `+` dropdown is
                                // open (otherwise the gear vanishes the
                                // moment the user opens the menu).
                                menuOpenProjectId === p.id
                                  ? "opacity-100"
                                  : "opacity-0 group-hover:opacity-100",
                              )}
                              onClick={(e) => { e.stopPropagation(); useApp.getState().openSettings("repositories", p.id); }}
                            ><Cog className="h-4 w-4" /></button>
                          </Tip>
                          {/* Single `+` trigger → instant dropdown with the
                              two project-level actions. Replaces the two
                              separate icons (FolderGit2 + GitBranchPlus) we
                              used to show side by side — less visual noise
                              on the row, clearer affordance (the universal
                              "+" = "create / open something here"). */}
                          <DropdownRoot
                            onOpenChange={(o) => setMenuOpenProjectId(o ? p.id : null)}
                          >
                            <Tip content="New workspace for this project">
                              <DropdownTrigger asChild>
                                <button
                                  onClick={e => e.stopPropagation()}
                                  className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] data-[state=open]:bg-[var(--color-bg-3)] data-[state=open]:text-[var(--color-fg)]"
                                ><Plus className="h-4 w-4" /></button>
                              </DropdownTrigger>
                            </Tip>
                            <DropdownMenu align="end" sideOffset={4} className="max-w-[220px]">
                              <ProjectActionsMenuItems projectId={p.id} />
                            </DropdownMenu>
                          </DropdownRoot>
                        </div>
                      </>
                    )}
                  </div>
                </Tip>

                {/* Empty expanded project — single placeholder CTA that
                    opens the SAME dropdown as the row's `+` icon (one
                    "Open repo with <agent>" per registered agent plus a
                    New worktree action). One affordance instead of two
                    cramped side-by-side buttons that had to ellipsis at
                    narrow widths. */}
                {!collapsed && wsList.length === 0 && !compact && (
                  <div
                    className="ml-5 mr-1 mb-1 mt-0.5"
                    onClick={e => e.stopPropagation()}
                  >
                    <DropdownRoot>
                      <DropdownTrigger asChild>
                        <button
                          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] bg-transparent px-2 py-2 text-[12.5px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] data-[state=open]:border-[var(--color-accent-soft)] data-[state=open]:text-[var(--color-fg)]"
                        >
                          <Plus className="h-3.5 w-3.5 shrink-0" />
                          <span>Get started</span>
                        </button>
                      </DropdownTrigger>
                      <DropdownMenu align="start" sideOffset={4} className="max-w-[220px]">
                        <ProjectActionsMenuItems projectId={p.id} />
                      </DropdownMenu>
                    </DropdownRoot>
                  </div>
                )}

                {!collapsed && [...wsList].sort((a, b) => Number(!!b.is_repo_root) - Number(!!a.is_repo_root)).map(w => (
                  <WorkspaceRow key={w.id} w={w} compact={compact} />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom group — pinned to the sidebar's base by a SINGLE
          `mt-auto`. The update card (when present) sits flush above the
          footer with no gap; two `mt-auto` siblings would split the
          slack and leave the card floating mid-sidebar. The card
          renders nothing in compact mode (the unified-bar pill covers
          that) or when there's no pending update / unseen release. */}
      <div className="mt-auto">
        <UpdateCard />

        {/* Footer */}
        <div className={cn(
          "flex border-t border-[var(--color-border-soft)] p-2 gap-1",
          compact ? "flex-col items-center" : "items-center",
        )}>
          {/* Left cluster (full mode): support — bug + contact. mailto:
              opens the user's default mail client; only the recipient +
              subject differ so triage can sort incoming mail by intent.
              Compact mode is flex-col, so left/right ordering collapses
              into a simple top/bottom stack. */}
          <Tip content="Report a bug">
            <Button size="icon" variant="icon" onClick={() =>
              openMailto("bugs@termic.dev", "Termic bug report", "What happened:\n\n\nSteps to reproduce:\n\n\nTermic version: ")
            }>
              <Bug className={iconSize(compact)} />
            </Button>
          </Tip>
          <Tip content="Contact">
            <Button size="icon" variant="icon" onClick={() =>
              openMailto("contact@termic.dev", "Hello from Termic", "")
            }>
              <Mail className={iconSize(compact)} />
            </Button>
          </Tip>
          {/* Right cluster: Add project, then Settings rightmost.
              Settings sits at the absolute edge so the gear is exactly
              where users reflexively reach for it (same position as
              macOS preferences in most apps). +project sits just inside
              it. ml-auto on the first right-cluster item pushes both. */}
          <Tip content="Add project"><Button size="icon" variant="icon" className={compact ? undefined : "ml-auto"} onClick={openNewProject}>
            <FolderPlus className={iconSize(compact)} />
          </Button></Tip>
          <Tip content="Settings (⌘,)"><Button size="icon" variant="icon" onClick={() => openSettings()}>
            <Settings className={iconSize(compact)} />
          </Button></Tip>
        </div>
      </div>

      {/* Drag handle on the sidebar's right edge — disabled in compact mode
          (compact has a fixed 56px width that's the whole point of the mode). */}
      {!compact && (
        <ResizeHandle
          direction="x"
          className="right-0"
          onDrag={(dx) => {
            // Read the CURRENTLY RENDERED width via DOM measurement, not
            // the stored preferred — when the window is narrow the clamp
            // in App.tsx caps the visual width below preferred, and
            // dragging from the preferred would feel disconnected.
            // Measuring from the actual element keeps the drag responsive.
            // The user's new value becomes the preferred (their ceiling
            // until the next manual drag).
            const cur = asideRef.current?.getBoundingClientRect().width
              ?? useApp.getState().sidebarWidth;
            const next = Math.round(Math.max(160, Math.min(800, cur + dx)));
            useApp.getState().setSidebarWidth(next);
          }}
        />
      )}
    </aside>
  );
}

/** Tailwind size class for sidebar icons, beefier in compact mode where the
 *  56px column has the budget for it (and the icons need to be readable
 *  without text labels). */
function iconSize(compact: boolean) {
  // Bumped one step in both modes. h-4 (16px) felt undersized next to
  // 14px body text; h-[18px] reads as deliberate without taking over.
  // Compact mode jumps to h-6 (24px) — icon-only mode benefits more from
  // the size since there's no label crutch.
  return compact ? "h-6 w-6" : "h-[18px] w-[18px]";
}

// Tiny status badge reused on both the workspace header (aggregated, when
// collapsed) and on each tab child row.
function TabBadge({ reason }: { reason: "attention" | "done" }) {
  return reason === "attention" ? (
    <span className="shrink-0 text-[var(--color-warn)]" title="Agent needs your input">
      <Bell className="h-3 w-3" strokeWidth={2.5} />
    </span>
  ) : (
    <span className="shrink-0 text-[var(--color-ok)]" title="Agent finished a turn">
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </span>
  );
}

// ─── WorkspaceRow ────────────────────────────────────────────────────────────
// Extracted component so each workspace subscribes only to its own tab state
// (isolated re-renders). Handles expand/collapse, ws rename, tab rename, and
// shows all terminal tabs as indented children.

function WorkspaceRow({ w, compact }: { w: Workspace; compact: boolean }) {
  const tabs = useWorkspaceTabs(w.id);
  const activeTabId = useActiveTabId(w.id);
  const activeWsId = useApp(s => s.activeWorkspaceId);
  const setActive = useApp(s => s.setActiveWorkspace);
  const setActiveTabId = useApp(s => s.setActiveTabId);
  const loadAll = useApp(s => s.loadAll);
  const terminalTabCount = useApp(s => (s.tabs[w.id] ?? []).filter(t => t.type === "terminal").length);
  const collapsed = useApp(s => s.collapsedWorkspaces[w.id] ?? (terminalTabCount <= 1));
  const setWorkspaceCollapsed = useApp(s => s.setWorkspaceCollapsed);
  const addTab = useApp(s => s.addTab);
  const registry = useApp(s => s.agents);
  const renameTab = useApp(s => s.renameTab);
  const clearTabCustomTitle = useApp(s => s.clearTabCustomTitle);
  const settledHighlight = usePrefs(s => s.settledHighlight);

  const isActive = activeWsId === w.id;
  const terminalTabs = tabs.filter((t): t is TerminalTab => t.type === "terminal");
  const isLoaded = terminalTabs.some(t => t.ptyId);

  // Workspace rename
  const [wsRenaming, setWsRenaming] = useState<string | null>(null);
  // Tab rename — per-tab id + draft value
  const [tabRenaming, setTabRenaming] = useState<{ id: string; value: string } | null>(null);

  // Auto-expand 1→2+; auto-collapse back to 0.
  const prevCountRef = useRef(terminalTabCount);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = terminalTabCount;
    if (prev <= 1 && terminalTabCount >= 2) {
      setWorkspaceCollapsed(w.id, false);
    } else if (prev > 0 && terminalTabCount === 0) {
      setWorkspaceCollapsed(w.id, true);
    }
  }, [terminalTabCount, w.id, setWorkspaceCollapsed]);

  // Aggregated attention/done status shown on the row header when collapsed.
  const hasAttention = settledHighlight && tabs.some(t => t.unread?.reason === "attention");
  const hasDone = settledHighlight && !hasAttention && tabs.some(t => t.unread?.reason === "done");

  async function commitWsRename() {
    if (wsRenaming === null) return;
    const trimmed = wsRenaming.trim();
    setWsRenaming(null);
    // Empty → reset to the branch name (clears any custom label).
    const next = trimmed || w.branch;
    if (next === w.name) return;
    try { await workspaceRename(w.id, next); await loadAll(); }
    catch (e) { console.error("rename failed", e); }
  }

  function commitTabRename() {
    if (!tabRenaming) return;
    const trimmed = tabRenaming.value.trim();
    if (trimmed) renameTab(w.id, tabRenaming.id, trimmed);
    else clearTabCustomTitle(w.id, tabRenaming.id);
    setTabRenaming(null);
  }

  // Compact mode: render a minimal icon-only row (no tree, no children).
  if (compact) {
    return (
      <Tip content={w.name} side="right">
        <div
          onClick={() => setActive(w.id)}
          className={cn(
            "mx-auto flex h-8 w-8 items-center justify-center rounded-md cursor-pointer transition-colors",
            isActive
              ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
              : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            !isLoaded && "opacity-60",
          )}
        >
          <CliIcon cli={w.cli} className="h-4 w-4" />
        </div>
      </Tip>
    );
  }

  return (
    <div className="mb-px">
      {/* Workspace header row */}
      <div
        onClick={() => {
          setActive(w.id);
          if (terminalTabs.length === 0) {
            // No terminals yet — launch the default agent; stays collapsed (1 terminal = collapsed by default).
            const cli = w.cli || "claude";
            addTab(w.id, { id: crypto.randomUUID(), type: "terminal", title: agentDisplayName(cli, registry), cli });
          } else {
            if (activeTabId) setActiveTabId(w.id, activeTabId);
            if (isActive) setWorkspaceCollapsed(w.id, !collapsed);
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (wsRenaming === null) setWsRenaming(w.name);
        }}
        className={cn(
          "group/wsrow ml-3 flex items-center gap-1 rounded-md px-1 py-1 text-[13px] cursor-pointer select-none transition-colors",
          isActive && collapsed
            ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
            : isActive
            ? "text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
            : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
          !isLoaded && "opacity-60",
        )}
      >
        {terminalTabs.length === 0
          ? <Moon className="shrink-0 h-3.5 w-3.5 mx-0.5 text-[var(--color-fg-faint)] opacity-40" />
          : <button
              onClick={(e) => { e.stopPropagation(); setWorkspaceCollapsed(w.id, !collapsed); }}
              className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)] transition-colors"
              data-no-drag
            >
              {collapsed
                ? <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                : <ChevronDown  className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
              }
            </button>
        }

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {wsRenaming !== null ? (
            <input
              autoFocus
              value={wsRenaming}
              onChange={e => setWsRenaming(e.target.value)}
              onBlur={commitWsRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitWsRename();
                else if (e.key === "Escape") setWsRenaming(null);
                e.stopPropagation();
              }}
              onClick={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className="min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-[3px] text-[13px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]"
            />
          ) : w.is_repo_root && w.name === w.branch ? (
            <span className="-ml-1 shrink-0 rounded px-1 py-px text-[10.5px] font-semibold uppercase tracking-wide bg-[var(--color-bg-3)] text-[var(--color-fg-dim)]">
              REPO ROOT
            </span>
          ) : (
            <>
              <span className="min-w-0 truncate font-medium">{w.name}</span>
              {w.is_repo_root && (
                <span className="shrink-0 rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide bg-[var(--color-bg-3)] text-[var(--color-fg-faint)]">
                  REPO
                </span>
              )}
            </>
          )}
          {/* Terminal count — only shown when >1 */}
          {!wsRenaming && terminalTabs.length > 1 && (
            <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">
              ({terminalTabs.length})
            </span>
          )}
        </div>

        {collapsed && hasAttention && <TabBadge reason="attention" />}
        {collapsed && hasDone      && <TabBadge reason="done" />}

        {/* Archive — before shield so shield stays pinned at the far right.
            Always in DOM (opacity-only toggle) so shield position never shifts.
            Plain title avoids Radix portal repaints that flicker in WKWebView. */}
        <button
          data-no-drag
          title="Archive workspace"
          onClick={async (e) => {
            e.stopPropagation();
            if (wsRenaming !== null) return;
            const ok = await useUI.getState().askConfirm({
              title: `Archive "${w.name}"?`,
              message: w.is_repo_root
                ? "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched — you can re-open it any time. Any agent running here will be terminated."
                : (w.composition?.length ?? 0) > 0
                ? `Branches stay in git — you can recreate the workspace later. This removes: the host worktree + every member worktree (${w.composition!.filter(m => m.mode === "worktree").map(m => m.dir_name).join(", ") || "none"}), plus any member symlinks to live checkouts. Any running agent will be terminated.`
                : "The branch stays in git — you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory and terminates any running agent. Can't be undone from inside Termic.",
              confirmLabel: "Archive",
              destructive: true,
              checkbox: w.is_repo_root ? undefined : (w.composition?.length ?? 0) > 0
                ? { label: "Delete the git branches", defaultValue: false }
                : { label: "Delete the git branch:", branchName: w.branch || undefined, defaultValue: false },
            });
            const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
            const deleteBranch = typeof ok === "boolean" ? false : ok.checked;
            if (!confirmed) return;
            const { setBusy } = useUI.getState();
            setBusy(`Archiving "${w.name}"…`);
            try {
              await workspaceArchive(w.id, deleteBranch);
              if (isActive) setActive(null);
              await loadAll();
            } catch (err) { console.error(err); }
            finally { setBusy(null); }
          }}
          className={cn(
            "shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 group-hover/wsrow:opacity-100 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-err)]",
            wsRenaming !== null ? "pointer-events-none" : "group-hover/wsrow:pointer-events-auto pointer-events-none",
          )}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>

        {/* Shield — always rightmost so its position is stable regardless of archive visibility */}
        <Tip content={w.sandbox_enabled ? "Sandbox settings" : "Enable sandbox"} side="bottom">
          <button
            data-no-drag
            onClick={(e) => { e.stopPropagation(); useUI.getState().openSandbox(w.id); }}
            className={cn(
              "shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)] transition-colors",
              w.sandbox_enabled ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)]",
            )}
          >
            <Shield className="h-3.5 w-3.5" fill={w.sandbox_enabled ? "currentColor" : "none"} />
          </button>
        </Tip>
      </div>

      {/* Tab children — terminal tabs only; edit/diff are transient file views */}
      {!collapsed && terminalTabs.map(tab => {
        const isTabActive = isActive && tab.id === activeTabId;
        const title = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
        const showBell  = settledHighlight && tab.unread?.reason === "attention";
        const showCheck = settledHighlight && tab.unread?.reason === "done";
        const isTabRenaming = tabRenaming?.id === tab.id;

        return (
          <div
            key={tab.id}
            onClick={() => { setActive(w.id); setActiveTabId(w.id, tab.id); }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!isTabRenaming) setTabRenaming({ id: tab.id, value: title });
            }}
            className={cn(
              "group/tab ml-8 flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] cursor-pointer select-none transition-colors",
              isTabActive
                ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            {/* Status overrides the brand icon when there's something to report */}
            {showBell ? <TabBadge reason="attention" /> : showCheck ? <TabBadge reason="done" /> : (
              <span className={cn("shrink-0", CLI_BRAND_COLOR[tab.cli] || "text-[var(--color-fg-dim)]")}>
                <CliIcon cli={tab.cli} className="h-3.5 w-3.5" />
              </span>
            )}

            {isTabRenaming ? (
              <input
                autoFocus
                value={tabRenaming!.value}
                onChange={e => setTabRenaming(r => r ? { ...r, value: e.target.value } : r)}
                onBlur={commitTabRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitTabRename(); }
                  else if (e.key === "Escape") { e.preventDefault(); setTabRenaming(null); }
                  e.stopPropagation();
                }}
                onClick={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className="min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-[3px] text-[12.5px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            )}
            <button
              title="Close tab"
              onClick={(e) => { e.stopPropagation(); requestCloseTab(w.id, tab.id); }}
              className="shrink-0 rounded p-0.5 opacity-0 group-hover/tab:opacity-100 pointer-events-none group-hover/tab:pointer-events-auto text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function NavItem({ icon, label, active, compact, onClick }: {
  icon: React.ReactNode; label: string; active?: boolean; compact: boolean; onClick: () => void;
}) {
  // In compact mode we use a fixed-size square button (h-9 w-9) centered in
  // the column (mx-auto) so every left-rail icon sits at the exact same x —
  // otherwise NavItem's `w-full` paints a wider highlight that visually shifts
  // it left of the project/workspace icons below it.
  // font-medium (500) gives the sidebar labels enough weight to read crisp
  // against the bg without looking shouty.
  const btn = (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center rounded-md text-[13px] font-medium",
        compact
          ? "mx-auto h-9 w-9 justify-center"
          : "gap-2 px-2.5 py-1.5",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--color-hover)]",
      )}
    >
      {icon}
      {!compact && <span>{label}</span>}
    </button>
  );
  return compact ? <Tip content={label}>{btn}</Tip> : btn;
}
