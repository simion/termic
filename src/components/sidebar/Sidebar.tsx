// Left sidebar: traffic-light spacer, toggle, primary nav, projects tree, footer.
// Two layout flavors: full (220px) vs compact (56px, icon-only with tooltips).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp, useWorkspaceTabs, useActiveTabId } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { LayoutGrid, History, FolderPlus, Settings, Plus, Archive, Layers, Moon, Cog, MoreVertical, GitBranchPlus, FolderGit2, ChevronRight, ChevronDown, Bell, Bug, Mail, Shield, Zap, X, Pencil, Copy, ChevronsDownUp, ChevronsUpDown, Check, AudioWaveform, Radio, SquareChevronRight, Loader2 } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator, DropdownLabel } from "@/components/ui/Dropdown";
import { ProjectActionsMenuItems } from "./ProjectActionsMenuItems";
import { UpdateCard } from "./UpdateCard";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import { requestCloseTab } from "@/lib/closeTab";
import { workspaceRename, projectRename, workspaceOpenRepo, openPath, projectReorder, workspaceSpotlightStop, workspaceSetYolo } from "@/lib/ipc";
import { archiveAndRefresh } from "@/lib/archiveWorkspace";
import { startSpotlight } from "@/lib/spotlight";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import type { Workspace, TerminalTab } from "@/lib/types";
import { effectiveSandboxMode } from "@/lib/types";

/** Pick a default name for a freshly-created repo-root workspace.
 *  Format: "<agent>-N" where N is the next unused index for that CLI
 *  among the project's existing repo-root rows. "shell" → "terminal".
 *  The user can edit before pressing Enter. */
function defaultRepoRootName(cli: string, wsList: Workspace[]): string {
  const slug = cli === "shell" ? "terminal" : cli.toLowerCase();
  const prefix = `${slug}-`;
  const used = new Set<number>();
  for (const w of wsList) {
    if (!w.is_repo_root) continue;
    if (w.name === slug) { used.add(1); continue; }
    if (!w.name.startsWith(prefix)) continue;
    const tail = w.name.slice(prefix.length);
    const n = Number(tail);
    if (Number.isInteger(n) && n > 0) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `${slug}-${n}`;
}

// `compact` is normally read from the store, but the Arc-style hover reveal
// (App.tsx) renders TWO instances at once: the 56px icon rail (`compact`)
// plus a full-width overlay (`compact={false}`) that slides in on hover. The
// optional prop lets that overlay force full mode regardless of the store.
export function Sidebar({ compact: compactProp }: { compact?: boolean } = {}) {
  const compactStore = useApp(s => s.compactSidebar);
  const compact = compactProp ?? compactStore;
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
  const setAllWorkspacesCollapsed = useApp(s => s.setAllWorkspacesCollapsed);
  // (agents subscription lives inside ProjectActionsMenuItems now —
  // Sidebar itself doesn't need the registry.)

  // If the user disabled the settled highlight (Settings → General),
  // every isUnread() call returns false — the icon stays in its calm
  // state regardless of agent activity.
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workspaceExpandMode = usePrefs(s => s.workspaceExpandMode);
  const setWorkspaceExpandMode = usePrefs(s => s.setWorkspaceExpandMode);
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
  /** Open a prefilled "New issue" on the public GitHub tracker. Same
   *  query-string shape as openMailto so both support buttons route through
   *  one builder. */
  const openIssue = (title: string, body: string) => {
    const url = `https://github.com/simion/termic/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    openPath(url).catch(() => {});
  };
  /** True if ANY tab in the workspace just transitioned to settled/idle
   *  (work-done signal — agent stopped producing output, waiting on
   *  user). Gated on the same `settledHighlight` pref so the check
   *  disappears entirely when the user disables the work-done UI. */
  const isWorkDone = (wsId: string) =>
    settledHighlight &&
    (tabs[wsId] || []).some(t =>
      // Authoritative per-tab work state (driven by OSC 9;4 / 133 / 9
      // / title in TerminalPane). Replaces the old `unread.reason="done"`
      // edge — see the workState state machine.
      t.type === "terminal" && t.workState === "done",
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
  // Inline name-prompt state for repo-root workspace creation. When the
  // user picks an agent from the project's `+` menu, we stash the choice
  // here and render a focused input row under the project — Enter creates
  // the workspace with the typed name, Esc cancels. This is the
  // low-friction alternative to a modal dialog.
  const [pendingRepoRoot, setPendingRepoRoot] =
    useState<{ projectId: string; cli: string; value: string } | null>(null);
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
  // translateY applied to the dragged header so it follows the cursor (the
  // smooth feel, same as the prompt library); the list still reorders live.
  const [dragTy, setDragTy] = useState(0);
  const dragArmed = useRef<
    { id: string; x: number; y: number; started: boolean; grabOffsetY: number; appliedTy: number; pointerY: number } | null
  >(null);
  const dragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);

  // translateY that keeps the dragged header under the cursor, self-correcting
  // against the live layout after each reorder (reads the header's real rect
  // minus the transform already applied to recover its untranslated slot).
  const computeProjectTy = (clientY: number): number => {
    const armed = dragArmed.current;
    const el = armed && document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(armed.id)}"]`);
    if (!armed || !el) return 0;
    const layoutTop = el.getBoundingClientRect().top - armed.appliedTy;
    const ty = (clientY - armed.grabOffsetY) - layoutTop;
    armed.appliedTy = ty;
    return ty;
  };

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
    setDragTy(0);
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
    // Follow the cursor every move (before the reorder hit-test, which has
    // early returns), so the header tracks smoothly even when no swap happens.
    armed.pointerY = e.clientY;
    setDragTy(computeProjectTy(e.clientY));
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

  // After a live reorder re-renders the list, the dragged header sits in a new
  // slot — re-derive its transform from the new layout BEFORE paint so it
  // doesn't jump for a frame.
  useLayoutEffect(() => {
    if (dragArmed.current?.started) setDragTy(computeProjectTy(dragArmed.current.pointerY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

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
      <div className={cn("flex-1 overflow-y-auto min-h-0", compact ? "px-1.5 py-1.5" : "px-2 py-2")}>
        <div className={cn(
          "flex items-center justify-between text-[12px] uppercase tracking-wider text-[var(--color-fg-dim)]",
          compact ? "flex-col gap-1.5 py-1" : "px-2 py-1",
        )}>
          {!compact && <span>Projects</span>}
          <div className={cn("flex gap-0.5", compact && "flex-col")}>
            <DropdownRoot>
              <Tip content="Agents: expand / collapse / behavior">
                <DropdownTrigger asChild>
                  <Button size="icon" variant="icon">
                    <ChevronsUpDown className={iconSize(compact)} />
                  </Button>
                </DropdownTrigger>
              </Tip>
              <DropdownMenu align="end" sideOffset={4} className="w-[280px]">
                <DropdownItem onSelect={() => setAllWorkspacesCollapsed(false)}>
                  <ChevronsUpDown className="h-4 w-4 text-[var(--color-fg-dim)]" />
                  <span>Expand all agents</span>
                </DropdownItem>
                <DropdownItem onSelect={() => setAllWorkspacesCollapsed(true)}>
                  <ChevronsDownUp className="h-4 w-4 text-[var(--color-fg-dim)]" />
                  <span>Collapse all agents</span>
                </DropdownItem>
                <DropdownSeparator />
                <DropdownLabel>Default expand behavior</DropdownLabel>
                {([
                  ["chevron", "Chevron only", "Only the chevron toggles."],
                  ["click",   "Click name",   "Active row toggles; auto-expands at 2+."],
                  ["always",  "Auto open",    "Start expanded; chevron still collapses."],
                ] as const).map(([id, label, hint]) => {
                  const isActive = workspaceExpandMode === id;
                  return (
                    <DropdownItem
                      key={id}
                      onSelect={() => setWorkspaceExpandMode(id)}
                      className={isActive
                        ? "bg-[var(--color-sel)] data-[highlighted]:bg-[var(--color-sel)]"
                        : undefined}
                    >
                      {isActive
                        ? <Check className="h-4 w-4 text-[var(--color-accent)]" />
                        : <span className="h-4 w-4 shrink-0" />}
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className={isActive ? "text-[var(--color-accent)] font-medium" : undefined}>{label}</span>
                        <span className="text-[11px] leading-snug text-[var(--color-fg-dim)]">{hint}</span>
                      </div>
                    </DropdownItem>
                  );
                })}
              </DropdownMenu>
            </DropdownRoot>
            <Tip content="Add project (repo)"><Button size="icon" variant="icon" onClick={openNewProject}>
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
            // Compact + collapsed: surface aggregated activity on the
            // project monogram so a collapsed project still signals that
            // something underneath wants attention (attention > done).
            const projAttention = compact && collapsed && wsList.some(w => needsAttention(w.id));
            const projDone = compact && collapsed && !projAttention && wsList.some(w => isWorkDone(w.id));
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
                    style={dragProjectId === p.id ? { transform: `translateY(${dragTy}px)`, position: "relative", zIndex: 20 } : undefined}
                    // Compact mode has no drag-to-reorder (the pointer
                    // handler below bails), so a plain click handles the
                    // collapse toggle the monogram represents.
                    onClick={compact ? () => setProjectCollapsed(p.id, !collapsed) : undefined}
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
                      dragArmed.current = {
                        id: p.id, x: e.clientX, y: e.clientY, started: false,
                        grabOffsetY: e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top,
                        appliedTy: 0, pointerY: e.clientY,
                      };
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
                      "group flex items-center justify-between rounded-md text-[12px] font-semibold uppercase tracking-[0.06em] cursor-pointer transition-colors",
                      // Full mode highlights the whole row on hover; compact
                      // mode hovers the centered monogram tile instead.
                      !compact && "hover:bg-[var(--color-hover)]",
                      wsList.length === 0 ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg)]",
                      menuOpenProjectId === p.id && "bg-[var(--color-hover)]",
                      compact ? "px-0 py-0.5 justify-center" : "pl-2 pr-0 py-1.5",
                      dragProjectId === p.id && "bg-[var(--color-accent)]/15 text-[var(--color-accent)] shadow-lg",
                    )}
                  >
                    {compact ? (
                      // Compact mode: a project monogram tile (initials) —
                      // distinguishable at a glance, unlike a stack of
                      // identical chevrons. Dimmed when collapsed; carries
                      // an aggregated activity dot so collapsed projects
                      // still signal work underneath.
                      <div
                        className={cn(
                          "relative mx-auto flex h-8 w-8 items-center justify-center rounded-md text-[10.5px] font-semibold leading-none transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                          collapsed ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg-dim)]",
                        )}
                      >
                        {projectMonogram(p.name)}
                        {(projAttention || projDone) && (
                          <span
                            className="absolute -right-0.5 -top-0.5 block h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-1)]"
                            style={{ backgroundColor: projAttention ? "var(--color-warn)" : "var(--color-info, #4aa3ff)" }}
                          />
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center gap-1.5">
                          {collapsed
                            ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                            : <ChevronDown  className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                          }
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
                          {/* Multi-repo marker sits AFTER the name so
                              project names stay vertically aligned
                              regardless of type (no snake-indent). */}
                          {(p.type ?? "single") === "multi" && (
                            <Tip content="Multi-repo project">
                              <Layers className="h-3 w-3 shrink-0 text-[var(--color-accent)]" />
                            </Tip>
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
                              <ProjectActionsMenuItems
                                projectId={p.id}
                                onPickRepoCli={(cli) => {
                                  // The inline name prompt only renders under an
                                  // expanded project, so expand first or the row
                                  // would be invisible on a collapsed one.
                                  setProjectCollapsed(p.id, false);
                                  setPendingRepoRoot({
                                    projectId: p.id,
                                    cli,
                                    value: defaultRepoRootName(cli, wsList),
                                  });
                                }}
                              />
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
                {!collapsed && wsList.length === 0 && !compact && pendingRepoRoot?.projectId !== p.id && (
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
                        <ProjectActionsMenuItems
                                projectId={p.id}
                                onPickRepoCli={(cli) => {
                                  // The inline name prompt only renders under an
                                  // expanded project, so expand first or the row
                                  // would be invisible on a collapsed one.
                                  setProjectCollapsed(p.id, false);
                                  setPendingRepoRoot({
                                    projectId: p.id,
                                    cli,
                                    value: defaultRepoRootName(cli, wsList),
                                  });
                                }}
                              />
                      </DropdownMenu>
                    </DropdownRoot>
                  </div>
                )}

                {!collapsed && [...wsList].sort((a, b) => Number(!!b.is_repo_root) - Number(!!a.is_repo_root)).map(w => (
                  <WorkspaceRow key={w.id} w={w} compact={compact} />
                ))}
                {/* Inline name prompt renders at the BOTTOM — that's
                    where a newly-created repo-root workspace lands in
                    the sort order, so the row physically appears in
                    the spot it'll occupy after Enter. */}
                {!collapsed && pendingRepoRoot?.projectId === p.id && (
                  <PendingRepoRootRow
                    value={pendingRepoRoot.value}
                    onChange={(v) => setPendingRepoRoot(prev => prev && { ...prev, value: v })}
                    onCancel={() => setPendingRepoRoot(null)}
                    onCommit={async () => {
                      const name = pendingRepoRoot.value.trim();
                      if (!name) { setPendingRepoRoot(null); return; }
                      try {
                        const w = await workspaceOpenRepo(p.id, pendingRepoRoot.cli, name);
                        await loadAll();
                        setActive(w.id);
                      } catch (err) {
                        console.error("workspace_open_repo failed:", err);
                      } finally {
                        setPendingRepoRoot(null);
                      }
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* UpdateCard floats absolutely at the bottom-left of the sidebar,
          stacked above project rows and the footer so it remains visible
          regardless of scroll position. Renders nothing in compact mode
          or when there's no pending update / unseen release. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[var(--bottom-bar-h)] z-20">
        <div className="pointer-events-auto">
          <UpdateCard />
        </div>
      </div>

      <div>
        {/* Footer */}
        <div className={cn(
          "flex border-t border-[var(--color-border-soft)] gap-1",
          // --bottom-bar-h (expanded) is the shared height for every bottom
          // bar. Compact mode stays a vertical icon stack with its own padding.
          compact ? "flex-col items-center p-2" : "items-center h-[var(--bottom-bar-h)] px-2",
        )}>
          {/* Left cluster (full mode): support — bug + contact. The bug
              button opens a prefilled GitHub issue (public tracker, better
              than email for triage + dedupe); Contact stays a mailto: that
              opens the user's default mail client. Compact mode is
              flex-col, so left/right ordering collapses into a top/bottom
              stack. */}
          <Tip content="Report a bug">
            <Button size="icon" variant="icon" onClick={() =>
              openIssue("Bug: ", "What happened:\n\n\nSteps to reproduce:\n\n\nTermic version: ")
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
/** Two-character monogram for the compact-rail project tile — just the
 *  first two letters of the name (`termic` → TE, `my-app` → MY). The
 *  tooltip still carries the full name. */
function projectMonogram(name: string): string {
  const cleaned = name.trim();
  return cleaned ? cleaned.slice(0, 2).toUpperCase() : "?";
}

function iconSize(compact: boolean) {
  // Bumped one step in both modes. h-4 (16px) felt undersized next to
  // 14px body text; h-[18px] reads as deliberate without taking over.
  // Compact mode jumps to h-6 (24px) — icon-only mode benefits more from
  // the size since there's no label crutch.
  return compact ? "h-6 w-6" : "h-[18px] w-[18px]";
}

// Tiny status badge reused on both the workspace header (aggregated, when
// collapsed) and on each tab child row.
//   done      → solid blue bullet (work finished, untouched until input)
//   attention → orange bell (agent explicitly blocked on user)
// The "working" spinner is opt-in (Settings → General → Work-in-progress
// indicator) and OFF by default — it can misfire on noisy TUIs (Claude
// Code's continuous redraws, Codex's status counter). The internal
// workState=="working" is always tracked so the done detector fires on
// busy→idle transitions; this badge just surfaces it when enabled.
function TabBadge({ reason }: { reason: "attention" | "done" | "working" }) {
  if (reason === "working") {
    return (
      <span className="shrink-0 text-[var(--color-fg-faint)]" title="Agent working" aria-label="Working">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (reason === "attention") {
    return (
      <span className="shrink-0 text-[var(--color-warn)]" title="Agent needs your input">
        <Bell className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  // done — solid blue bullet, iTerm2-style. Uses --color-info if defined,
  // falls back to a literal blue. h-3.5 visually matches the bell + spinner.
  return (
    <span
      className="shrink-0 flex items-center justify-center"
      title="Agent finished a turn"
      aria-label="Work done"
    >
      <span
        className="block h-2 w-2 rounded-full"
        style={{ backgroundColor: "var(--color-info, #4aa3ff)" }}
      />
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
  const setActiveRightTab = useApp(s => s.setActiveRightTab);
  const activeRightTabId = useApp(s => s.activeRightTab[w.id]);
  const activePane = useApp(s => s.activePane[w.id] ?? "main");
  const loadAll = useApp(s => s.loadAll);
  const terminalTabCount = useApp(s => (s.tabs[w.id] ?? []).filter(t => t.type === "terminal").length);
  const agents = useApp(s => s.agents);
  const expandMode = usePrefs(s => s.workspaceExpandMode);
  // Default collapsed state varies with the user's chosen expand mode.
  // The user can still override per-row via the chevron — once they
  // explicitly toggle, `collapsedWorkspaces[w.id]` holds and the mode
  // default is ignored for that workspace.
  //   chevron → start collapsed; row click never toggles.
  //   click   → legacy behavior: collapsed when ≤1 tab, auto-expanded at 2+.
  //   always  → start expanded; chevron-collapsed sticks.
  const defaultCollapsed =
    expandMode === "always"  ? false :
    expandMode === "chevron" ? true  :
    /* click */                terminalTabCount <= 1;
  const collapsed = useApp(s => s.collapsedWorkspaces[w.id] ?? defaultCollapsed);
  const setWorkspaceCollapsed = useApp(s => s.setWorkspaceCollapsed);
  const setWorkspaceYolo = useApp(s => s.setWorkspaceYolo);
  const ensureDefaultTab = useApp(s => s.ensureDefaultTab);
  const renameTab = useApp(s => s.renameTab);
  const clearTabCustomTitle = useApp(s => s.clearTabCustomTitle);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);

  const project = useApp(s => s.projects.find(p => p.id === w.project_id) ?? null);
  const spotlightWsId = useApp(s => s.spotlightWsId[w.project_id] ?? null);
  const isSpotlighted = spotlightWsId === w.id;
  // Spotlight is worktree-only: non-repo-root, single-repo, git, spotlight_enabled.
  const spotlightAvailable = !w.is_repo_root && !!project?.spotlight_enabled && project?.type !== "multi" && !project?.non_git;

  const isActive = activeWsId === w.id;
  // Include right-panel tabs — they're treated like any other agent tab in the sidebar.
  // Click routing below distinguishes main vs right via tab.panel.
  const terminalTabs = tabs.filter((t): t is TerminalTab => t.type === "terminal");
  const isLoaded = terminalTabs.some(t => t.ptyId);
  // The sidebar only renders terminal tabs as child rows; edit/diff tabs
  // are transient file views with no row. When the active tab is one of
  // those (or there's no active tab), no child row carries the selection,
  // so the workspace HEADER must show it instead — otherwise an open file
  // or git diff leaves the workspace looking inactive in the tree.
  const activeTabIsTerminalChild = terminalTabs.some(
    t => t.id === activeTabId || t.id === activeRightTabId,
  );

  // Workspace rename
  const [wsRenaming, setWsRenaming] = useState<string | null>(null);
  const wsRenameInputRef = useRef<HTMLInputElement | null>(null);
  // Radix DropdownMenu closes AFTER onSelect fires and asynchronously
  // restores focus; autoFocus on the freshly-mounted input loses the race.
  // Re-focus on the next two frames to land after Radix's restore tick.
  useEffect(() => {
    if (wsRenaming === null) return;
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = wsRenameInputRef.current;
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, [wsRenaming !== null]);
  // Tab rename — per-tab id + draft value
  const [tabRenaming, setTabRenaming] = useState<{ id: string; value: string } | null>(null);

  // Auto-expand rules per mode:
  //   "click"  — auto-expand 1→2+ (legacy behavior).
  //   "always" — on wake (0→1+), clear any prior chevron-collapse so
  //              the mode default (expanded) wins again. Users who
  //              collapse a workspace and then put it to sleep
  //              shouldn't return to a still-collapsed row when they
  //              wake the agent — that contradicts "Auto open".
  //   "chevron"— never auto-expand (the whole point: predictability).
  // Auto-collapse on going to 0 stays in all modes — an empty
  // workspace has nothing to expand.
  const prevCountRef = useRef(terminalTabCount);
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = terminalTabCount;
    if (expandMode === "click" && prev <= 1 && terminalTabCount >= 2) {
      setWorkspaceCollapsed(w.id, false);
    } else if (expandMode === "always" && prev === 0 && terminalTabCount > 0) {
      setWorkspaceCollapsed(w.id, false);
    } else if (prev > 0 && terminalTabCount === 0) {
      setWorkspaceCollapsed(w.id, true);
    }
  }, [terminalTabCount, w.id, setWorkspaceCollapsed, expandMode]);

  // Aggregated work status shown on the row header when collapsed.
  // Priority: attention > done. ("working" intentionally not surfaced.)
  const hasAttention = settledHighlight && tabs.some(t => t.unread?.reason === "attention");
  const hasDone = settledHighlight && !hasAttention
    && tabs.some(t => t.type === "terminal" && t.workState === "done");
  // Working aggregate is independent of settledHighlight (it's its own
  // opt-in pref) but yields to attention/done — a finished or blocked agent
  // is more actionable than one still chugging.
  const hasWorking = workingIndicator && !hasAttention && !hasDone
    && tabs.some(t => t.type === "terminal" && t.workState === "working");

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
            "relative mx-auto flex h-8 w-8 items-center justify-center rounded-md cursor-pointer transition-colors",
            isActive
              ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
              : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            !isLoaded && "opacity-60",
          )}
        >
          <CliIcon cli={w.cli} className="h-4 w-4" />
          {/* Activity dot in the corner — the compact rail has no room
              for the full bell/check badge, so color carries meaning:
              warm = needs you, blue = work done. The ring lifts it off
              the icon regardless of the tile's background. */}
          {(hasAttention || hasDone) ? (
            <span
              className="absolute -right-0.5 -top-0.5 block h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-1)]"
              style={{ backgroundColor: hasAttention ? "var(--color-warn)" : "var(--color-info, #4aa3ff)" }}
            />
          ) : hasWorking ? (
            // No room for a full spinner on the rail; a faint pulsing dot
            // carries "still working" without competing with the bold
            // attention/done colors.
            <span className="absolute -right-0.5 -top-0.5 block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--color-fg-faint)] ring-2 ring-[var(--color-bg-1)]" />
          ) : null}
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
            // No terminals yet — wake the workspace through the store's
            // restore/seed path. MUST be ensureDefaultTab, not an inline
            // addTab: the durable agent tabs (persisted_tabs) are keyed by
            // tab id, so minting a fresh id here would orphan every stored
            // session and break auto-resume (it also no-ops ensureDefaultTab
            // in WorkspaceView, which mounts after this click).
            ensureDefaultTab(w.id, w.cli || "claude");
          } else {
            if (activeTabId) setActiveTabId(w.id, activeTabId);
            // Only the "click" mode treats a row click on the already
            // active workspace as a collapse toggle. The other modes
            // require the explicit chevron, which removed the "random
            // expand" feel users complained about.
            if (isActive && expandMode === "click") setWorkspaceCollapsed(w.id, !collapsed);
          }
        }}
        className={cn(
          "group/wsrow ml-3 flex items-center gap-1 rounded-md px-1 py-1 text-[13px] cursor-pointer select-none transition-colors",
          // Strong selection on the header when active AND no child row
          // carries it: collapsed (children hidden) OR the active tab is an
          // edit/diff view (no row). Expanded with an active terminal tab
          // delegates the highlight to that child row instead.
          isActive && (collapsed || !activeTabIsTerminalChild)
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
              ref={wsRenameInputRef}
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
          {/* Spotlight active indicator: just the animated wave icon.
              No branch text — avoids any truncation of the workspace name. */}
          {!wsRenaming && isSpotlighted ? (
            <Tip content={`Spotlight: changes are synced with ${project?.base_branch?.replace(/^[^/]+\//, "") ?? "main"}`} delay={0}>
              <AudioWaveform className="termic-spotlight-wave h-3 w-3 shrink-0 text-[var(--color-accent)]" />
            </Tip>
          ) : (
            /* Terminal count — only shown when >1. Was fg-faint which
               vanished on warm-dark surfaces; bump to fg-dim + tabular
               nums so the digit stays legible at small sizes. */
            !wsRenaming && terminalTabs.length > 1 && (
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--color-fg-dim)]">
                ({terminalTabs.length})
              </span>
            )
          )}
        </div>

        {/* Trailing slot: status badge by default, single kebab (⋮)
            menu dropdown on hover. Replaces the prior archive + shield
            pair — a single icon hosts Sandbox + Archive in a Radix
            DropdownMenu. Instant hover swap (no 2s delay): the kebab is
            unobtrusive enough that revealing it immediately doesn't
            crowd the row. The badge only renders when collapsed
            (expanded rows put per-tab badges on their children). */}
        <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          {collapsed && (hasAttention || hasDone || hasWorking) && (
            <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/wsrow:opacity-0">
              {hasAttention ? <TabBadge reason="attention" /> : hasDone ? <TabBadge reason="done" /> : <TabBadge reason="working" />}
            </span>
          )}
          <DropdownRoot>
            <Tip content="Workspace menu">
            <DropdownTrigger asChild>
              <button
                data-no-drag
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded hover:bg-[var(--color-bg-3)]",
                  // A persistent badge (sandbox on OR dangerous YOLO) keeps
                  // the button visible; unless the collapsed attention/done
                  // badge is active — it lives in the same slot and the
                  // status icon would cover it.
                  (w.sandbox_enabled || (!!w.yolo && effectiveSandboxMode(w) !== "enforce")) && !(collapsed && (hasAttention || hasDone || hasWorking))
                    ? "opacity-100 pointer-events-auto"
                    : "opacity-0 group-hover/wsrow:opacity-100 pointer-events-none group-hover/wsrow:pointer-events-auto",
                  wsRenaming !== null && "pointer-events-none",
                )}
              >
                {/* Idle badge, hidden on row hover so the cog shows through.
                    Precedence: dangerous YOLO (red, no cage) → Enforcing
                    (green shield) → Monitoring (amber eye). */}
                {/* Outlined when no agent is launched here, filled once one
                    is running (terminalTabCount > 0). */}
                {(!!w.yolo && effectiveSandboxMode(w) !== "enforce") ? (
                  <Zap
                    className="absolute h-3.5 w-3.5 text-[var(--color-err)] transition-opacity group-hover/wsrow:opacity-0"
                    fill={terminalTabs.length > 0 ? "currentColor" : "none"}
                  />
                ) : effectiveSandboxMode(w) === "monitor" ? (
                  <Shield className="absolute h-3.5 w-3.5 text-[var(--color-warn)] transition-opacity group-hover/wsrow:opacity-0" />
                ) : w.sandbox_enabled ? (
                  <Shield
                    className="absolute h-3.5 w-3.5 text-[var(--color-ok)] transition-opacity group-hover/wsrow:opacity-0"
                    fill={terminalTabs.length > 0 ? "currentColor" : "none"}
                  />
                ) : null}
                {/* Kebab: always visible on hover (badge or not). A
                    "⋮" menu affordance, distinct from the project-level
                    Settings cog above so the two don't read as the same
                    action. */}
                <MoreVertical
                  className={cn(
                    "h-3.5 w-3.5 text-[var(--color-fg-faint)] transition-opacity",
                    (w.sandbox_enabled || (!!w.yolo && effectiveSandboxMode(w) !== "enforce")) && "opacity-0 group-hover/wsrow:opacity-100",
                  )}
                />
              </button>
            </DropdownTrigger>
            </Tip>
            <DropdownMenu
              align="end"
              // Don't return focus to the trigger on close — the user
              // walks away from the cog after picking an item; leaving
              // the trigger highlighted with a focus ring is just noise.
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {spotlightAvailable && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={async () => {
                    if (isSpotlighted) {
                      try { await workspaceSpotlightStop(w.id); }
                      catch (e) { useUI.getState().pushToast(String(e), "error"); }
                    } else {
                      try {
                        await startSpotlight(w.project_id, w.id);
                        setActive(w.id);
                      } catch (e) { useUI.getState().pushToast(String(e), "error"); }
                    }
                  }}
                >
                  <AudioWaveform className={cn("h-4 w-4", isSpotlighted && "text-[var(--color-accent)]")} />
                  <span>{isSpotlighted ? "Stop spotlight" : "Start spotlight"}</span>
                </DropdownItem>
              )}
              <DropdownItem
                // items-center + no top-nudge: these rows are single-line
                // so the default two-line layout offsets the icon visually.
                className="items-center [&>svg]:mt-0"
                onSelect={() => useUI.getState().openSandbox(w.id)}
              >
                <Shield
                  className={cn(
                    "h-4 w-4",
                    effectiveSandboxMode(w) === "enforce" && "text-[var(--color-ok)]",
                    effectiveSandboxMode(w) === "monitor" && "text-[var(--color-warn)]",
                  )}
                  fill={effectiveSandboxMode(w) === "enforce" ? "currentColor" : "none"}
                />
                <span>{effectiveSandboxMode(w) === "enforce" ? "Enforcing" : effectiveSandboxMode(w) === "monitor" ? "Monitoring" : "Sandbox settings"}</span>
              </DropdownItem>
              {/* Per-workspace YOLO toggle. Disabled (auto-on) under
                  Enforcing — the seatbelt is the boundary there. Red when
                  on without a cage (dangerous). */}
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                disabled={effectiveSandboxMode(w) === "enforce"}
                onSelect={() => {
                  if (effectiveSandboxMode(w) === "enforce") return;
                  const next = !w.yolo;
                  setWorkspaceYolo(w.id, next);
                  void workspaceSetYolo(w.id, next);
                }}
              >
                <Zap
                  className={cn(
                    "h-4 w-4 text-[var(--color-fg-faint)]",
                    (!!w.yolo && effectiveSandboxMode(w) !== "enforce") && "text-[var(--color-err)]",
                    effectiveSandboxMode(w) === "enforce" && "text-[var(--color-ok)]",
                  )}
                  fill={(effectiveSandboxMode(w) === "enforce" || !!w.yolo) ? "currentColor" : "none"}
                />
                <span>
                  {effectiveSandboxMode(w) === "enforce"
                    ? "YOLO: auto-on (Enforcing)"
                    : w.yolo ? "YOLO: on" : "YOLO: off"}
                </span>
              </DropdownItem>
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={() => setWsRenaming(w.name)}
              >
                <Pencil className="h-4 w-4" />
                <span>Rename</span>
              </DropdownItem>
              {/* Custom-command workspaces carry an editable launch
                  script (agent / shell workspaces resolve their command
                  from the registry, so there's nothing to edit). */}
              {w.cli === "custom" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openEditCommand(w.id)}
                >
                  <SquareChevronRight className="h-4 w-4" />
                  <span>Edit command</span>
                </DropdownItem>
              )}
              {/* Resume override: only for agent workspaces (shell / custom
                  tabs don't resume an agent session). Lets a workspace
                  resume a named session instead of termic's auto-managed
                  uuid, e.g. `--resume {WORKSPACE_NAME}`. */}
              {w.cli !== "custom" && w.cli !== "shell" && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openResumeOverride(w.id)}
                >
                  <History className={cn("h-4 w-4", w.resume_override && "text-[var(--color-accent)]")} />
                  <span>{w.resume_override ? "Resume args override: on" : "Resume args override"}</span>
                </DropdownItem>
              )}
              {w.branch && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => {
                    navigator.clipboard.writeText(w.branch).then(
                      () => useUI.getState().pushToast(`Copied "${w.branch}"`, "success"),
                      () => useUI.getState().pushToast("Couldn't copy branch name", "error"),
                    );
                  }}
                >
                  <Copy className="h-4 w-4" />
                  <span>Copy branch name</span>
                </DropdownItem>
              )}
              {/* Duplicate: only for worktree workspaces (the repo-root
                  entry IS the project's checkout, can't be branched
                  off cleanly). Pre-fills the New worktree dialog with
                  the source branch as the `base` so the new worktree
                  branches off this one's current tip. */}
              {!w.is_repo_root && w.branch && (
                <DropdownItem
                  className="items-center [&>svg]:mt-0"
                  onSelect={() => useUI.getState().openNewWorkspace(w.project_id, { baseBranch: w.branch })}
                >
                  <GitBranchPlus className="h-4 w-4" />
                  <span>Duplicate worktree</span>
                </DropdownItem>
              )}
              <DropdownSeparator />
              <DropdownItem
                className="items-center [&>svg]:mt-0"
                onSelect={async () => {
                  if (wsRenaming !== null) return;
                  const ok = await useUI.getState().askConfirm({
                    title: `Archive "${w.name}"?`,
                    message: w.is_repo_root
                      ? "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched, so you can re-open it any time. Any agent running here will be terminated."
                      : (w.composition?.length ?? 0) > 0
                      ? `Branches stay in git, so you can recreate the workspace later. This removes: the host worktree + every member worktree (${w.composition!.filter(m => m.mode === "worktree").map(m => m.dir_name).join(", ") || "none"}), plus any member symlinks to live checkouts. Any running agent will be terminated.`
                      : "The branch stays in git, so you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory and terminates any running agent. Can't be undone from inside Termic.",
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
                  try { await archiveAndRefresh(w.id, deleteBranch); }
                  finally { setBusy(null); }
                }}
              >
                <Archive className="h-4 w-4" />
                <span>Archive workspace</span>
              </DropdownItem>
            </DropdownMenu>
          </DropdownRoot>
        </span>
      </div>

      {/* Tab children — terminal tabs only; edit/diff are transient file views */}
      {!collapsed && terminalTabs.map(tab => {
        const isRight = !!tab.panel;
        // A tab is the active one in its pane; but only the FOCUSED pane's
        // active tab reads as fully active (terracotta). The other pane's
        // active tab gets a muted highlight, so exactly one tab is "hot".
        const isActiveInPane = isRight ? tab.id === activeRightTabId : tab.id === activeTabId;
        const isFocusedPane = activePane === (isRight ? "right" : "main");
        const isTabActive = isActive && isActiveInPane;
        const isTabHot = isTabActive && isFocusedPane;
        const title = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
        const showBell    = settledHighlight && tab.unread?.reason === "attention";
        const showDone    = settledHighlight && !showBell && tab.workState === "done";
        const showWorking = workingIndicator && !showBell && !showDone && tab.workState === "working";
        const isTabRenaming = tabRenaming?.id === tab.id;

        return (
          <div
            key={tab.id}
            onClick={() => {
              setActive(w.id);
              if (isRight) setActiveRightTab(w.id, tab.id);
              else setActiveTabId(w.id, tab.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!isTabRenaming) setTabRenaming({ id: tab.id, value: title });
            }}
            className={cn(
              "group/tab ml-8 flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] cursor-pointer select-none transition-colors",
              isTabHot
                ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                : isTabActive
                  ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            {/* Brand icon stays at the start; the work-state badge moves
                to the end of the row (after the title) per iTerm2's
                tab-bullet placement. */}
            <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(tab.cli, agents)] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={resolveIconId(tab.cli, agents)} className="h-3.5 w-3.5" />
            </span>

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
                // No `py-*`: the parent row already has py-[3px]; doubling
                // pads the input up to a taller row than the static span
                // (the row jumped a few px when entering rename mode).
                // `leading-tight` keeps the text vertically centred against
                // the surrounding non-renaming rows.
                className="min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-0 leading-tight text-[12.5px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{title}</span>
            )}
            {/* Trailing slot — status badge by default. Close × only
                appears when hovering the badge itself, not the whole
                row — row hover keeps the badge visible. */}
            <span className="group/badge relative flex h-4 w-4 shrink-0 items-center justify-center">
              {(showBell || showDone || showWorking) && (
                <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/badge:opacity-0">
                  {showBell ? <TabBadge reason="attention" /> : showDone ? <TabBadge reason="done" /> : <TabBadge reason="working" />}
                </span>
              )}
              <button
                title="Close tab"
                onClick={(e) => { e.stopPropagation(); requestCloseTab(w.id, tab.id); }}
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
                  (showBell || showDone || showWorking)
                    // Badge visible: X only on badge-slot hover
                    ? "opacity-0 group-hover/badge:opacity-100 pointer-events-none group-hover/badge:pointer-events-auto"
                    // No badge: X on row hover (original behaviour)
                    : "opacity-0 group-hover/tab:opacity-100 pointer-events-none group-hover/tab:pointer-events-auto",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
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

/** Inline name-prompt row rendered above the workspace list while the
 *  user is creating a new repo-root workspace. Mirrors the geometry of
 *  the rename input (py-[3px], no border, accent ring) so the row
 *  doesn't jump vertically when the input mounts. Auto-focused +
 *  pre-selected so the user can hit Enter to accept the default
 *  ("claude-1") or just start typing to replace. */
function PendingRepoRootRow({ value, onChange, onCommit, onCancel }: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Two-frame focus matches the Radix dropdown close timing — same
    // workaround used by the workspace rename input. autoFocus alone
    // races the menu's focus restoration.
    let cancelled = false;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = ref.current;
        if (el) { el.focus(); el.select(); }
      });
      if (cancelled) cancelAnimationFrame(r2);
    });
    return () => { cancelled = true; cancelAnimationFrame(r1); };
  }, []);
  return (
    <div className="ml-3 mr-1 flex items-center gap-1 rounded-md px-1 py-1">
      <ChevronRight className="h-3.5 w-3.5 shrink-0 mx-0.5 text-[var(--color-fg-faint)]" />
      <input
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          e.stopPropagation();
        }}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="min-w-0 flex-1 rounded border-0 bg-[var(--color-bg-2)] px-1 py-[3px] text-[13px] text-[var(--color-fg)] outline-none ring-1 ring-inset ring-[var(--color-accent)]"
      />
    </div>
  );
}
