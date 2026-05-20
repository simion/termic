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
import { visibleCliIds } from "@/lib/agents";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";

/** Small section header: uppercase label + one-line explanation.
 *  Used to collapse "same hint, three rows" patterns into a single
 *  intro above the action group. Not a dropdown menu item — pure
 *  visual, doesn't trap focus. */
function SectionHeader({ title, hint, tone = "dim" }: {
  title: string; hint: string; tone?: "dim" | "warn";
}) {
  return (
    <div className="px-2 pb-1 pt-1.5">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">{title}</div>
      <div className={cn(
        "text-[11.5px] leading-snug",
        tone === "warn" ? "text-[var(--color-warn)]" : "text-[var(--color-fg-dim)]",
      )}>{hint}</div>
    </div>
  );
}
import { GitBranchPlus } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProjectActionsMenuItems({ projectId }: { projectId: string }) {
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const setActive = useApp(s => s.setActiveWorkspace);
  const loadAll = useApp(s => s.loadAll);
  const openNewWorkspace = useUI(s => s.openNewWorkspace);
  // Multi-repo projects need different copy: "New worktree" means
  // branched copies of EVERY member, and "Open repo" means the host
  // dir with live symlinks to each member checkout — same actions,
  // very different mental model, hints should reflect that.
  const project = useApp(s => s.projects.find(p => p.id === projectId));
  const isMulti = (project?.type ?? "single") === "multi";
  // Hide disabled / not-installed agents from the Open-repo list.
  const visibleClis = visibleCliIds(agents.map(a => a.id), agents, detectedClis);

  return (
    <>
      {/* New worktree comes FIRST — it's the more common multi-agent
          workflow (parallel branched copies); Open repo is the rarer
          "I want to touch the actual checkout" case. Order signals
          recommended path. */}
      {/* Single-row action — hint stays inline with the button
          because there's only one variant (no per-agent duplication
          to dedupe). Mirrors the original single-repo layout. */}
      <DropdownItem onSelect={() => openNewWorkspace(projectId)}>
        <GitBranchPlus className="h-4 w-4 text-[var(--color-fg-dim)]" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate">New worktree</span>
          {isMulti ? (
            <>
              <span className="text-[11.5px] text-[var(--color-fg-faint)]">branched copy of every</span>
              <span className="text-[11.5px] text-[var(--color-fg-faint)]">member repo · isolated</span>
            </>
          ) : (
            <>
              <span className="text-[11.5px] text-[var(--color-fg-faint)]">separate copy · own port</span>
              <span className="text-[11.5px] text-[var(--color-fg-faint)]">for parallel work</span>
            </>
          )}
        </div>
      </DropdownItem>
      <DropdownSeparator />
      {/* Section header for Open repo — collapses the per-row hint
          repeat into one explanation above the agent list. */}
      <SectionHeader
        title="OPEN REPO"
        hint={isMulti
          ? "Host repo with live symlinks to every member. Edits land on the real checkouts."
          : "Attach an agent directly to the repo root."}
        tone={isMulti ? "warn" : "dim"}
      />
      {agents.filter(a => visibleClis.has(a.id)).map(a => (
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
          <span className="truncate">{a.display_name}</span>
        </DropdownItem>
      ))}
    </>
  );
}
