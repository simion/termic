// Shared dropdown body for project-level actions: "Open repo with <agent>"
// per registered agent + "New worktree". Used in the sidebar's project-row
// `+` icon, the sidebar's empty-project placeholder CTA, and the dashboard
// project card header. Centralizes the agent registry lookup + handler
// wiring so the menu's shape stays consistent everywhere.
//
// Wrap in a `<DropdownMenu>` at the call site; this component renders
// only the items (so the caller can also customize positioning).

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { workspaceOpenRepo } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { GitBranchPlus } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProjectActionsMenuItems({ projectId }: { projectId: string }) {
  const agents = useApp(s => s.agents);
  const setActive = useApp(s => s.setActiveWorkspace);
  const loadAll = useApp(s => s.loadAll);
  const openNewWorkspace = useUI(s => s.openNewWorkspace);

  return (
    <>
      {/* New worktree comes FIRST — it's the more common multi-agent
          workflow (parallel branched copies); Open repo is the rarer
          "I want to touch the actual checkout" case. Order signals
          recommended path. */}
      <DropdownItem onSelect={() => openNewWorkspace(projectId)}>
        <GitBranchPlus className="h-4 w-4 text-[var(--color-fg-dim)]" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate">New worktree</span>
          <span className="text-[11.5px] text-[var(--color-fg-faint)]">separate copy · own port</span>
          <span className="text-[11.5px] text-[var(--color-fg-faint)]">for parallel work</span>
        </div>
      </DropdownItem>
      <DropdownSeparator />
      {agents.map(a => (
        <DropdownItem key={a.id} onSelect={async () => {
          try {
            const w = await workspaceOpenRepo(projectId, a.id);
            await loadAll();
            setActive(w.id);
          } catch (err) {
            console.error("workspace_open_repo failed:", err);
          }
        }}>
          <span className={cn("shrink-0", CLI_BRAND_COLOR[a.id] || "text-[var(--color-fg-dim)]")}>
            <CliIcon cli={a.id} className="h-4 w-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate">Open repo · {a.display_name}</span>
            <span className="text-[11.5px] text-[var(--color-fg-faint)]">repo root</span>
          </div>
        </DropdownItem>
      ))}
    </>
  );
}
