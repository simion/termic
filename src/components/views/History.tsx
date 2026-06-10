// History: archived workspaces. Read-only list for now.

import { useApp } from "@/store/app";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { cn } from "@/lib/utils";

export function HistoryView() {
  const projects = useApp(s => s.projects);
  const workspaces = useApp(s => s.workspaces);
  const agents = useApp(s => s.agents);
  const archived = workspaces.filter(w => w.archived);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-[15px] font-medium mb-4">
          History <span className="text-[var(--color-fg-faint)]">({archived.length})</span>
        </h1>
        {archived.length === 0 ? (
          <p className="text-[14px] text-[var(--color-fg-dim)]">No archived workspaces.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {archived.map(w => {
              const p = projects.find(x => x.id === w.project_id);
              return (
                <div key={w.id} className="flex items-center gap-3 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-2.5 opacity-70">
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(w.cli, agents)] || "text-[var(--color-fg-dim)]")}>
                    <CliIcon cli={resolveIconId(w.cli, agents)} className="h-4 w-4" />
                  </span>
                  <span className="font-medium text-[13px]">{w.name}</span>
                  <span className="text-[13.5px] text-[var(--color-fg-faint)]">in {p?.name}</span>
                  <span className="ml-auto text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">archived</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
