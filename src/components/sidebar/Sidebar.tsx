// Left sidebar: traffic-light spacer, toggle, primary nav, projects tree, footer.
// Two layout flavors: full (220px) vs compact (56px, icon-only with tooltips).

import { useState } from "react";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { LayoutGrid, History, RefreshCw, FolderPlus, Settings, Plus, Archive, Moon, Cog, GitBranchPlus, FolderGit2, ChevronRight, ChevronDown } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import { workspaceRename, projectRename, workspaceArchive, workspaceOpenRepo } from "@/lib/ipc";
import { ResizeHandle } from "@/components/ui/ResizeHandle";

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
  const toggleProjectCollapsed = useApp(s => s.toggleProjectCollapsed);

  const isUnread = (wsId: string) =>
    (tabs[wsId] || []).some(t => t.type === "terminal" && t.unread);
  const isLoaded = (wsId: string) =>
    (tabs[wsId] || []).some(t => t.type === "terminal" && t.ptyId);

  // Inline rename state: `{ kind: "ws"|"proj", id }`. Only one at a time.
  const [renaming, setRenaming] = useState<{ kind: "ws" | "proj"; id: string; value: string } | null>(null);

  async function commitRename() {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    setRenaming(null);
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      if (kind === "ws") await workspaceRename(id, trimmed);
      else await projectRename(id, trimmed);
      await loadAll();
    } catch (e) { console.error("rename failed", e); }
  }

  return (
    <aside className="relative flex h-full flex-col overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
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
            const collapsed = !!collapsedProjects[p.id];
            return (
              <div key={p.id}>
                <Tip content={compact ? p.name : ""}>
                  <div
                    // Single-click toggles collapse. Double-click rename was
                    // removed — too easy to fire by accident while clicking
                    // fast to collapse/expand. Rename lives in
                    // Settings → Repositories instead.
                    onClick={() => toggleProjectCollapsed(p.id)}
                    className={cn(
                      "group flex items-center justify-between rounded-md text-[13.5px] font-semibold hover:bg-[var(--color-hover)] cursor-pointer",
                      compact ? "px-0 py-1 justify-center" : "px-2 py-1.5",
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
                          <Tip content="Repo settings">
                            <button
                              className="rounded p-1 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100 transition-opacity"
                              onClick={(e) => { e.stopPropagation(); useApp.getState().openSettings("repositories", p.id); }}
                            ><Cog className="h-4 w-4" /></button>
                          </Tip>
                          {/* Single `+` trigger → instant dropdown with the
                              two project-level actions. Replaces the two
                              separate icons (FolderGit2 + GitBranchPlus) we
                              used to show side by side — less visual noise
                              on the row, clearer affordance (the universal
                              "+" = "create / open something here"). */}
                          <DropdownRoot>
                            <Tip content="New…">
                              <DropdownTrigger asChild>
                                <button
                                  onClick={e => e.stopPropagation()}
                                  className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] data-[state=open]:bg-[var(--color-bg-3)] data-[state=open]:text-[var(--color-fg)]"
                                ><Plus className="h-4 w-4" /></button>
                              </DropdownTrigger>
                            </Tip>
                            <DropdownMenu align="end" sideOffset={4}>
                              <DropdownItem onSelect={async () => {
                                try { const w = await workspaceOpenRepo(p.id); await loadAll(); setActive(w.id); }
                                catch (err) { console.error(err); }
                              }}>
                                <FolderGit2 className="h-4 w-4 text-[var(--color-fg-dim)]" />
                                <div className="flex flex-col">
                                  <span>Open repo</span>
                                  <span className="text-[11.5px] text-[var(--color-fg-faint)]">work in the actual repo folder</span>
                                </div>
                              </DropdownItem>
                              <DropdownItem onSelect={() => openNewWorkspace(p.id)}>
                                <GitBranchPlus className="h-4 w-4 text-[var(--color-fg-dim)]" />
                                <div className="flex flex-col">
                                  <span>New worktree</span>
                                  <span className="text-[11.5px] text-[var(--color-fg-faint)]">separate copy + own port — run in parallel</span>
                                </div>
                              </DropdownItem>
                            </DropdownMenu>
                          </DropdownRoot>
                        </div>
                      </>
                    )}
                  </div>
                </Tip>

                {/* Repo workspaces (the project's live checkout, no worktree)
                    rendered first as a pinned row so they're visually separate
                    from per-branch worktree workspaces. Hidden entirely when
                    the project header is collapsed. */}
                {!collapsed && [...wsList].sort((a, b) => Number(!!b.is_repo_root) - Number(!!a.is_repo_root)).map(w => {
                  const isRenaming = renaming?.kind === "ws" && renaming.id === w.id;
                  const unread = isUnread(w.id);
                  const loaded = isLoaded(w.id);
                  const asleep = !loaded && !unread && activeWs !== w.id;
                  const isRepo = !!w.is_repo_root;
                  return (
                    <Tip key={w.id} content={compact ? `${w.name} · ${w.cli}${isRepo ? " (repo)" : ""}${asleep ? " · asleep" : ""}` : ""}>
                      <div
                        onDoubleClick={() => !compact && setRenaming({ kind: "ws", id: w.id, value: w.name })}
                        onClick={() => { if (!isRenaming) setActive(w.id); }}
                        className={cn(
                          "group relative flex w-full items-center gap-2 rounded-md text-[13px] truncate cursor-pointer",
                          compact ? "justify-center py-1.5 px-0" : "py-1.5 pl-5 pr-1.5",
                          unread ? "font-semibold text-[var(--color-fg)]" : "font-medium",
                          activeWs === w.id
                            ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                            : unread
                              ? "hover:bg-[var(--color-hover)]"
                              : asleep
                                ? "text-[var(--color-fg-faint)] opacity-70 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg-dim)] hover:opacity-100"
                                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                        )}
                      >
                        {unread && (
                          <span className={cn(
                            "absolute rounded-full bg-[var(--color-err)] shadow-[0_0_0_3px_rgba(239,83,80,0.25)]",
                            compact ? "right-1.5 top-1 h-1.5 w-1.5" : "left-1.5 h-1.5 w-1.5",
                          )} />
                        )}
                        {/* Both repo-checkout and worktree workspaces use the
                            CLI brand icon — the row's REPO chip is the only
                            visual cue you need to tell them apart. Keeping
                            the agent icon consistent makes scanning the
                            sidebar for "which agent is running where" easy. */}
                        <span className={cn(
                          "shrink-0",
                          unread ? "text-[var(--color-err)]" : (CLI_BRAND_COLOR[w.cli] || "text-[var(--color-fg-faint)]"),
                          asleep && "opacity-50",
                        )}>
                          <CliIcon cli={w.cli} className={iconSize(compact)} />
                        </span>
                        {!compact && (
                          isRenaming ? (
                            // Sized to fit the row (h-5, no extra py) so the row's
                            // vertical rhythm doesn't jump when editing.
                            <input
                              autoFocus
                              onFocus={e => e.target.select()}
                              value={renaming!.value}
                              onChange={e => setRenaming({ ...renaming!, value: e.target.value })}
                              onBlur={commitRename}
                              onKeyDown={e => {
                                if (e.key === "Enter") commitRename();
                                else if (e.key === "Escape") setRenaming(null);
                                e.stopPropagation();
                              }}
                              onClick={e => e.stopPropagation()}
                              className="h-5 min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0 text-[13px] leading-none outline-none"
                            />
                          ) : (
                            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                              {/* Repo-checkout workspace name is just a
                                  duplicate of the project name shown right
                                  above — render the REPO chip alone as the
                                  row's label instead. Worktrees still show
                                  their (distinct) branch-derived name. */}
                              {!isRepo && <span className="truncate">{w.name}</span>}
                              {/* Moon sits right after the name — reads as a
                                  state badge ("asleep") rather than a trailing
                                  control on the far right, which was visually
                                  ambiguous (toolbar? indicator?). */}
                              {asleep && (
                                <Tip content="Asleep — click the workspace to wake it">
                                  <span className="shrink-0 text-[var(--color-fg-faint)] opacity-60">
                                    <Moon className="h-3.5 w-3.5" />
                                  </span>
                                </Tip>
                              )}
                              {isRepo && (
                                <span className="rounded bg-[var(--color-bg-3)] px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)] shrink-0">
                                  repo
                                </span>
                              )}
                            </span>
                          )
                        )}
                        {!compact && !isRenaming && (
                          // Trailing actions only — moon moved next to the name.
                          <div className="ml-auto flex shrink-0 items-center gap-0.5">
                            <Tip content="Archive workspace">
                              <button
                                className="rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-err)] group-hover:opacity-100 transition-opacity"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (!confirm(`Archive workspace "${w.name}"? The worktree will be removed from git.`)) return;
                                  // Show a blocking overlay while the
                                  // archive runs — fs::remove_dir_all on a
                                  // .venv / node_modules takes seconds and
                                  // the user needs to know it's working.
                                  const { setBusy } = useUI.getState();
                                  setBusy(`Archiving "${w.name}"…`);
                                  try {
                                    await workspaceArchive(w.id);
                                    if (activeWs === w.id) setActive(null);
                                    await loadAll();
                                  } catch (err) { console.error(err); }
                                  finally { setBusy(null); }
                                }}
                              ><Archive className="h-4 w-4" /></button>
                            </Tip>
                          </div>
                        )}
                      </div>
                    </Tip>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className={cn(
        "mt-auto flex border-t border-[var(--color-border-soft)] p-2 gap-1",
        compact ? "flex-col items-center" : "justify-end",
      )}>
        <Tip content="Add project"><Button size="icon" variant="icon" onClick={openNewProject}>
          <FolderPlus className={iconSize(compact)} />
        </Button></Tip>
        <Tip content="Settings ⌘,"><Button size="icon" variant="icon" onClick={() => openSettings()}>
          <Settings className={iconSize(compact)} />
        </Button></Tip>
      </div>

      {/* Drag handle on the sidebar's right edge — disabled in compact mode
          (compact has a fixed 56px width that's the whole point of the mode). */}
      {!compact && (
        <ResizeHandle
          direction="x"
          className="right-0"
          onDrag={(dx) => {
            // Read CURRENT width from the store every frame. Using closure-
            // captured `sidebarWidth` froze it at drag-start and made the
            // bar snap back to "initial + 1px" after each move.
            const cur = useApp.getState().sidebarWidth;
            const next = Math.round(Math.max(160, Math.min(480, cur + dx)));
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
