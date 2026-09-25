import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { taskRestore, taskDelete } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { cn } from "@/lib/utils";
import { ChevronRight, Search, Trash2 } from "lucide-react";
import type { Task } from "@/lib/types";

function groupLabel(iso: string, t: TFunction): string {
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (diffDays === 0) return t("history.today");
  if (diffDays === 1) return t("history.yesterday");
  if (diffDays < 7)  return t("history.daysAgo", { count: diffDays });
  if (diffDays < 14) return t("history.lastWeek");
  if (diffDays < 21) return t("history.weeksAgo", { count: 2 });
  if (diffDays < 28) return t("history.weeksAgo", { count: 3 });
  // Dates follow the UI language, not the OS locale: a Chinese UI over an
  // English macOS still reads 三月, matching every other string on the page.
  return new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(iso));
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short", day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(d);
}

export function HistoryView() {
  const { t } = useTranslation("chrome");
  const projects  = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const agents    = useApp(s => s.agents);
  const loadAll   = useApp(s => s.loadAll);
  const setActive = useApp(s => s.setActiveTask);

  useEffect(() => { void loadAll(); }, []);

  const [query, setQuery]       = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [emptying, setEmptying]   = useState(false);

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
      const key = groupLabel(w.archived_at ?? w.created, t);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(w);
    }
    return [...map.entries()];
  }, [archived, t]); // t: group labels re-translate on a live language switch

  // Everything archived, filter ignored: "Empty archive" is about the archive,
  // not about what the search box happens to be showing. The confirmation
  // names the real count so the two can never disagree.
  const archivedAll = useMemo(() => tasks.filter(w => w.archived), [tasks]);

  // Hard-delete every archived task. Each one is already archived, so its
  // worktree is gone and this only wipes the record (task_delete re-runs the
  // archive path harmlessly, then removes the json). Sequential because the
  // deletes all rewrite the same tasks dir; one failure is counted and
  // reported at the end rather than aborting the rest, so a single stuck
  // record can't leave the archive half-emptied with no explanation.
  async function emptyArchive() {
    const doomed = useApp.getState().tasks.filter(w => w.archived);
    if (doomed.length === 0) return;
    const ok = await useUI.getState().askConfirm({
      title: t("history.confirmTitle"),
      message: doomed.length === 1
        ? t("history.confirmMessageOne", { count: doomed.length })
        : t("history.confirmMessageMany", { count: doomed.length }),
      confirmLabel: t("history.confirmLabel"),
      destructive: true,
    });
    if (!ok) return;
    setEmptying(true);
    let failed = 0;
    for (const w of doomed) {
      try { await taskDelete(w.id); } catch (err) { failed++; console.error("task_delete failed:", err); }
    }
    await loadAll();
    setEmptying(false);
    if (failed > 0) {
      useUI.getState().pushToast(t("history.deleteFailed", { failed, total: doomed.length }), "error");
    } else {
      useUI.getState().pushToast(t("history.emptied", { count: doomed.length }), "success");
    }
  }

  async function restore(id: string) {
    setRestoring(prev => new Set(prev).add(id));
    try {
      const task = await taskRestore(id);
      await loadAll();
      setActive(task.id);
    } catch (err) {
      useUI.getState().pushToast(typeof err === "string" ? err : t("restoreFailed"), "error");
    } finally {
      setRestoring(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" data-testid="history-root">
      {/* Search bar */}
      <div className="shrink-0 flex items-center gap-2.5 border-b border-[var(--color-border-soft)] px-6 py-3 text-[var(--color-fg-faint)]">
        <Search className="h-4 w-4 shrink-0" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("history.filterPlaceholder")}
          className="flex-1 bg-transparent text-[13.5px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] outline-none"
        />
        {/* Permanent delete, so it sits here as a plain quiet control rather
            than on every row: the archive is the recycle bin, and emptying it
            is one deliberate act. Hidden entirely when there's nothing to
            empty, so the page never offers a no-op destructive button. */}
        {archivedAll.length > 0 && (
          <button
            type="button"
            onClick={emptyArchive}
            disabled={emptying}
            title={t("history.emptyArchiveTip")}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors",
              emptying
                ? "text-[var(--color-fg-faint)]"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-err)]",
            )}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            {emptying ? t("history.emptying") : t("history.emptyArchive")}
          </button>
        )}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4" data-testid="history-list">
        <div className="mx-auto max-w-3xl">
          {archived.length === 0 ? (
            <p className="py-8 text-[13.5px] text-[var(--color-fg-dim)]">
              {query ? t("history.noMatch") : t("history.noArchived")}
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
                    data-history-row={w.id}
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
                      {proj?.name ?? t("history.unknownProject")}
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
                        <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("history.restoring")}</span>
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
                              {t("history.restore")}
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
