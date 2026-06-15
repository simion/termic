// Dashboard: hero banner + action cards + per-project cards with inline
// workspace creation. Designed so the empty state and the populated state
// share the same shape — adding a project doesn't yank you somewhere else.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TermicBlockmark } from "@/icons/TermicLogo";

// Module-level flag: animate the hero logo ONCE per app launch, not every
// time the user navigates back to the dashboard from a workspace tab. The
// typewriter draw-in is charming on startup but turns into visual noise
// on the 20th dashboard visit. Set true on first import-evaluated mount;
// flipped false after the first render so subsequent Dashboard mounts in
// the same session render the logo statically.
let logoHasAnimated = false;
import { cn } from "@/lib/utils";
import {
  FolderPlus, Settings as SettingsIcon, Compass, Cog, Boxes, Plus,
} from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu } from "@/components/ui/Dropdown";
import { ProjectActionsMenuItems } from "@/components/sidebar/ProjectActionsMenuItems";

export function Dashboard() {
  const projects     = useApp(s => s.projects);
  const workspaces   = useApp(s => s.workspaces);
  const setActive    = useApp(s => s.setActiveWorkspace);
  const openSettings = useApp(s => s.openSettings);
  const loadAll      = useApp(s => s.loadAll);
  const agents       = useApp(s => s.agents);
  const openNewProject   = useUI(s => s.openNewProject);
  const openNewWorkspace = useUI(s => s.openNewWorkspace);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        {/* Hero */}
        <header className="mb-10 mt-6 flex flex-col items-center gap-4 text-center">
          {(() => {
            // Capture before render so this mount animates if it's first.
            const shouldAnimate = !logoHasAnimated;
            logoHasAnimated = true;
            return <TermicBlockmark cellSize={10} gap={2} animate={shouldAnimate} />;
          })()}
          <div className="text-[11.5px] uppercase tracking-[0.3em] text-[var(--color-fg-faint)]">
            Home for your CLI coding agents
          </div>
        </header>

        {/* Top-level actions */}
        <div className="mb-10 grid grid-cols-3 gap-3">
          <ActionCard
            icon={<FolderPlus className="h-5 w-5" />}
            label="Add project"
            hint="Pick a git repo on disk"
            onClick={openNewProject}
          />
          <ActionCard
            icon={<Compass className="h-5 w-5" />}
            label="Discover repos"
            hint="Scan your repos folder"
            onClick={openNewProject /* same dialog shows discovery */}
          />
          <ActionCard
            icon={<SettingsIcon className="h-5 w-5" />}
            label="Settings"
            hint="Fonts, agents, theme"
            onClick={() => openSettings()}
          />
        </div>

        {/* Projects */}
        {projects.length === 0 ? (
          <EmptyProjectsCard />
        ) : (
          <>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[14px] font-semibold">Projects</h2>
              <span className="text-[12px] text-[var(--color-fg-faint)]">{projects.length}</span>
            </div>
            <div className="flex flex-col gap-3">
              {projects.map(p => {
                const wsList = workspaces.filter(w => w.project_id === p.id && !w.archived);
                return (
                  <ProjectCard
                    key={p.id}
                    projectId={p.id}
                    name={p.name}
                    onSettings={() => openSettings("repositories", p.id)}
                  >
                    {wsList.length === 0 ? (
                      <div className="px-3 py-2 text-[12.5px] text-[var(--color-fg-faint)]">
                        Nothing here yet. Click <b>+</b> to start a new worktree or open the live <b>repo</b> checkout.
                      </div>
                    ) : (
                      <div className="flex flex-col">
                        {wsList.map(w => (
                          <button
                            key={w.id}
                            onClick={() => setActive(w.id)}
                            className="group flex items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-[var(--color-hover)]"
                          >
                            {/* Use the CLI brand icon for repo-checkout rows
                                too — matches the sidebar's unified rendering.
                                The REPO chip alone signals "live checkout". */}
                            <span className={cn(
                              "shrink-0",
                              CLI_BRAND_COLOR[resolveIconId(w.cli, agents)] || "text-[var(--color-fg-faint)]",
                            )}>
                              <CliIcon cli={resolveIconId(w.cli, agents)} className="h-4 w-4" />
                            </span>
                            {/* Hide the workspace name on repo rows — it's
                                always just the project name shown above. */}
                            {!w.is_repo_root && <span className="font-medium text-[13px]">{w.name}</span>}
                            {w.is_repo_root && (
                              <span className="rounded bg-[var(--color-bg-3)] px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">
                                repo
                              </span>
                            )}
                            <span className="text-[12.5px] text-[var(--color-fg-faint)]">on</span>
                            <span className="font-mono text-[12px] text-[var(--color-fg-dim)] truncate">{w.branch}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </ProjectCard>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ActionCard({ icon, label, hint, onClick }: {
  icon: React.ReactNode; label: string; hint: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-4 text-left transition-colors hover:border-[var(--color-accent-soft)]"
    >
      <span className="text-[var(--color-fg-dim)]">{icon}</span>
      <div>
        <div className="text-[13.5px] font-semibold">{label}</div>
        <div className="text-[12px] text-[var(--color-fg-faint)]">{hint}</div>
      </div>
    </button>
  );
}

function ProjectCard({ projectId, name, onSettings, children }: {
  projectId: string;
  name: string;
  onSettings: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold">{name}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title="Repo settings"
            onClick={onSettings}
            className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
          ><Cog className="h-4 w-4" /></button>
          {/* Shared per-agent "Open repo with X" + New worktree menu —
              same component the sidebar uses, so the option list stays
              identical everywhere. */}
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                title="New…"
                className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] data-[state=open]:bg-[var(--color-bg-3)] data-[state=open]:text-[var(--color-fg)]"
              ><Plus className="h-4 w-4" /></button>
            </DropdownTrigger>
            <DropdownMenu align="end" sideOffset={4} className="max-w-[220px]">
              <ProjectActionsMenuItems projectId={projectId} />
            </DropdownMenu>
          </DropdownRoot>
        </div>
      </header>
      {children}
    </div>
  );
}

function EmptyProjectsCard() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-1)] p-8 text-center">
      <Boxes className="h-8 w-8 text-[var(--color-fg-faint)]" />
      <div>
        <div className="text-[14px] font-semibold">No projects yet</div>
        <div className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">
          Add a git repo from disk to spawn agent workspaces in.
        </div>
      </div>
    </div>
  );
}
