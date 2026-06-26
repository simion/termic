import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { workspaceRestore } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";

function fmtArchived(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

export function HistoryView() {
  const projects  = useApp(s => s.projects);
  const workspaces = useApp(s => s.workspaces);
  const agents    = useApp(s => s.agents);
  const loadAll   = useApp(s => s.loadAll);
  const setActive = useApp(s => s.setActiveWorkspace);

  // Refresh the workspace list each time the History view is opened so
  // newly archived workspaces appear without requiring an app restart.
  useEffect(() => { void loadAll(); }, []);

  const archived = [...workspaces.filter(w => w.archived)].sort((a, b) => {
    const ta = a.archived_at ?? a.created;
    const tb = b.archived_at ?? b.created;
    return tb.localeCompare(ta);
  });

  const [restoring, setRestoring] = useState<Set<string>>(new Set());

  async function restore(id: string) {
    setRestoring(prev => new Set(prev).add(id));
    try {
      const ws = await workspaceRestore(id);
      await loadAll();
      setActive(ws.id);
    } catch (err) {
      useUI.getState().pushToast(
        typeof err === "string" ? err : "Restore failed",
        "error",
      );
    } finally {
      setRestoring(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

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
              const isRestoring = restoring.has(w.id);
              return (
                <div key={w.id} className={cn(
                  "flex items-center gap-3 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-2.5",
                  isRestoring ? "opacity-50" : "opacity-70 hover:opacity-100 transition-opacity",
                )}>
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(w.cli, agents)] || "text-[var(--color-fg-dim)]")}>
                    <CliIcon cli={resolveIconId(w.cli, agents)} className="h-4 w-4" />
                  </span>
                  <span className="font-medium text-[13px]">{w.name}</span>
                  <span className="text-[13.5px] text-[var(--color-fg-faint)]">in {p?.name}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <Tip content={(w.archived_at ?? w.created)}>
                      <span className="text-[12px] tabular-nums text-[var(--color-fg-faint)]">
                        {fmtArchived(w.archived_at ?? w.created)}
                      </span>
                    </Tip>
                    <Tip content="Restore workspace">
                      <button
                        disabled={isRestoring}
                        onClick={() => restore(w.id)}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:cursor-not-allowed transition-colors"
                      >
                        <RotateCcw className={cn("h-3.5 w-3.5", isRestoring && "animate-spin")} />
                        {isRestoring ? "Restoring…" : "Restore"}
                      </button>
                    </Tip>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
