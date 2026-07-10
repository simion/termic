import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { taskRestore } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { cn } from "@/lib/utils";
import { ChevronRight, Search } from "lucide-react";
import type { Task } from "@/lib/types";

function groupLabel(iso: string): string {
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7)  return `${diffDays} days ago`;
  if (diffDays < 14) return "Last week";
  if (diffDays < 21) return "2 weeks ago";
  if (diffDays < 28) return "3 weeks ago";
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso));
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(d);
}

export function HistoryView() {
  const projects  = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const agents    = useApp(s => s.agents);
  const loadAll   = useApp(s => s.loadAll);
  const setActive = useApp(s => s.setActiveTask);

  useEffect(() => { void loadAll(); }, []);

  const [query, setQuery]       = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());

  const archived = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...tasks.filter(w => {
      if (!w.archived) return false;
      if (!q) return true;
      const p = projects.find(x => x.id === w.project_id);
      return (
        w.name.toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q) ||
        (p?.name ?? "").toLowerCase().includes(q)
      );
    })].sort((a, b) => (b.archived_at ?? b.created).localeCompare(a.archived_at ?? a.created));
  }, [tasks, projects, query]);

  const groups = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const w of archived) {
      const key = groupLabel(w.archived_at ?? w.created);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(w);
    }
    return [...map.entries()];
  }, [archived]);

  async function restore(id: string) {
    setRestoring(prev => new Set(prev).add(id));
    try {
      const task = await taskRestore(id);
      await loadAll();
      setActive(task.id);
    } catch (err) {
      useUI.getState().pushToast(typeof err === "string" ? err : "Restore failed", "error");
    } finally {
      setRestoring(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Search bar */}
      <div className="shrink-0 flex items-center gap-2.5 border-b border-[var(--color-border-soft)] px-6 py-3 text-[var(--color-fg-faint)]">
        <Search className="h-4 w-4 shrink-0" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter tasks..."
          className="flex-1 bg-transparent text-[13.5px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] outline-none"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="mx-auto max-w-3xl">
          {archived.length === 0 ? (
            <p className="py-8 text-[13.5px] text-[var(--color-fg-dim)]">
              {query ? "No tasks match your filter." : "No archived tasks."}
            </p>
          ) : groups.map(([label, task]) => (
            <div key={label} className="mb-2">
              <div className="flex items-baseline gap-2 px-3 py-2">
                <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{label}</span>
                <span className="text-[12px] text-[var(--color-fg-faint)]">{task.length}</span>
              </div>
              {task.map(w => {
                const proj        = projects.find(x => x.id === w.project_id);
                const isRestoring = restoring.has(w.id);
                const isHovered   = hoveredId === w.id && !isRestoring;
                const iconId      = resolveIconId(w.cli, agents);
                return (
                  <div
                    key={w.id}
                    onMouseEnter={() => setHoveredId(w.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] select-none",
                      isRestoring ? "opacity-50" : "",
                      isHovered ? "bg-[var(--color-hover)]" : "",
                    )}
                  >
                    {/* CLI icon */}
                    <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-faint)]")}>
                      <CliIcon cli={iconId} className="h-4 w-4" />
                    </span>

                    {/* Project name */}
                    <span className="w-[130px] shrink-0 truncate text-[var(--color-fg-dim)]">
                      {proj?.name ?? "Unknown"}
                    </span>

                    {/* Separator */}
                    <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />

                    {/* Task name */}
                    <span className="min-w-0 truncate font-medium text-[var(--color-fg)]">
                      {w.name}
                    </span>

                    {/* Location icon + branch */}
                    <TaskLocationIcon isMainCheckout={w.is_main_checkout} size="h-3 w-3" />
                    {!w.is_main_checkout && w.branch ? (
                      <span className="min-w-0 truncate text-[var(--color-fg-faint)]">· {w.branch}</span>
                    ) : null}

                    {/* Right: date + restore button */}
                    <div className="ml-auto shrink-0 pl-6 flex items-center gap-3">
                      {isRestoring ? (
                        <span className="text-[12.5px] text-[var(--color-fg-dim)]">Restoring…</span>
                      ) : (
                        <>
                          <span className="text-[12.5px] tabular-nums text-[var(--color-fg-faint)]">
                            {fmtDate(w.archived_at ?? w.created)}
                          </span>
                          {isHovered && (
                            <button
                              onClick={() => restore(w.id)}
                              className="text-[12.5px] font-medium text-[var(--color-accent)] hover:underline"
                            >
                              Restore →
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
