// ⌘O global task finder — fuzzy-search active tasks across projects
// and switch immediately. Built for rapid keyboard-driven context switching
// without touching the mouse or disturbing the sidebar tree layout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Bell, GitPullRequest, Search, X } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import { usePrefs } from "@/store/prefs";
import { createStatusFactsSelector, EMPTY_STATUS_FACTS, type StatusTabFacts } from "@/store/sidebarTabs";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";
import { focusMainTab } from "@/lib/tabFocus";
import { groupOf } from "@/lib/projectGroups";
import { accentCss } from "@/lib/accents";
import { kbd } from "@/lib/platform";
import { eventCmd } from "@/lib/shortcuts";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import {
  BOARD_STATE_COLUMNS,
  boardColumnFromFacts,
  NO_TAB_FACTS,
  type BoardStateColumn,
} from "@/lib/taskBoardState";
import { COL_ACCENT, COL_LABEL } from "@/hooks/useTaskQuery";
import type { Project, Task } from "@/lib/types";
import type { WorkStatePrefs } from "@/lib/taskWorkState";

const MAX_RESULTS = 30;

export const STATUS_QUALIFIER_RE = /(?:^|\s)(?:status|is):(?:"([^"]+)"|'([^']+)'|([^\s]+))/i;

export interface FilterOption {
  key: string;
  column: BoardStateColumn | null;
  labelKey: string;
  accent?: string;
}

export const FILTER_OPTIONS: readonly FilterOption[] = [
  { key: "1", column: null, labelKey: "taskFinder.filterAll" },
  { key: "2", column: "working", labelKey: "taskFinder.filterWorking", accent: COL_ACCENT.working },
  { key: "3", column: "settled", labelKey: "taskFinder.filterSettled", accent: COL_ACCENT.settled },
  { key: "4", column: "attention", labelKey: "taskFinder.filterAttention", accent: COL_ACCENT.attention },
  { key: "5", column: "review", labelKey: "taskFinder.filterReview", accent: COL_ACCENT.review },
  { key: "6", column: "backlog", labelKey: "taskFinder.filterBacklog", accent: COL_ACCENT.backlog },
];

export function resolveStatusQualifier(
  raw: string,
  tc?: (key: string) => string,
): BoardStateColumn | null {
  const norm = raw.trim().toLowerCase().replace(/[-_]/g, " ");
  if (!norm) return null;

  if (norm === "working" || norm === "work" || norm === "running") return "working";
  if (norm === "review" || norm === "in review" || norm === "pr") return "review";
  if (norm === "attention" || norm === "needs attention" || norm === "blocked" || norm === "warn") return "attention";
  if (norm === "backlog" || norm === "not started" || norm === "todo" || norm === "untouched") return "backlog";
  if (norm === "settled" || norm === "done" || norm === "idle") return "settled";

  if (tc) {
    for (const col of BOARD_STATE_COLUMNS) {
      const loc = tc(COL_LABEL[col] || "").toLowerCase();
      if (loc && (norm === loc || norm === loc.replace(/[-_]/g, " "))) return col;
    }
  }
  return null;
}

function statusIcon(column: BoardStateColumn) {
  switch (column) {
    case "attention":
      return <Bell className="h-3 w-3 shrink-0" strokeWidth={2.5} />;
    case "working":
      return <Spinner size={10} />;
    case "review":
      return <GitPullRequest className="h-3 w-3 shrink-0" />;
    case "settled":
      return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />;
    case "backlog":
      return <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-current opacity-70" />;
    default:
      return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />;
  }
}

const selectNoStatusFacts = (): StatusTabFacts => EMPTY_STATUS_FACTS;

interface ScoredTask {
  task: Task;
  project?: Project;
  column: BoardStateColumn;
  statusLabel: string;
  score: number;
  nameMatches: number[];
  branchMatches: number[];
  projectMatches: number[];
  statusMatches: number[];
  isCurrent: boolean;
}

export function TaskFinderDialog() {
  const { t } = useTranslation("dialogs");
  const { t: tc } = useTranslation("chrome");
  const open = useUI(s => s.taskFinderOpen);
  const close = useUI(s => s.closeTaskFinder);
  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const recentTasks = useApp(s => s.recentTasks);
  const activeTaskId = useApp(s => s.activeTaskId);
  const agents = useApp(s => s.agents);
  const groupColors = useApp(s => s.groupColors);

  // Status facts subscription: active only while the finder dialog is open.
  const [selectStatusFacts] = useState(createStatusFactsSelector);
  const statusFacts = useApp(open ? selectStatusFacts : selectNoStatusFacts);
  const prByTask = usePr(useCallback(s => (open ? s.byTask : undefined), [open]));

  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<BoardStateColumn | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Reset query, status filter, and active selection whenever the finder opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setStatusFilter(null);
      setActiveIdx(0);
    }
  }, [open]);

  // Derive any status qualifier typed directly in the query (e.g. `is:review` or `status:working`).
  const queryQualifier = useMemo<BoardStateColumn | null>(() => {
    const m = query.match(STATUS_QUALIFIER_RE);
    if (!m) return null;
    const rawVal = m[1] || m[2] || m[3] || "";
    return resolveStatusQualifier(rawVal, tc);
  }, [query, tc]);

  // Unified effective status: a typed qualifier in the search box takes priority
  // so the displayed results and highlighted footer filter chip always agree.
  const activeStatus = queryQualifier ?? statusFilter;

  const selectStatusFilter = useCallback((col: BoardStateColumn | null) => {
    // If the selected filter is already active (via statusFilter or typed qualifier),
    // selecting it again toggles it off back to All.
    const isAlreadyActive = col !== null && activeStatus === col;
    const nextCol = isAlreadyActive || col === null ? null : col;

    if (STATUS_QUALIFIER_RE.test(query)) {
      setQuery(q => q.replace(STATUS_QUALIFIER_RE, " ").replace(/\s+/g, " ").trim());
    }
    setStatusFilter(nextCol);
    inputRef.current?.focus();
  }, [activeStatus, query]);

  const results = useMemo<ScoredTask[]>(() => {
    if (!open) return [];
    const unarchived = tasks.filter(t => !t.archived);
    if (!unarchived.length) return [];

    const projectMap = new Map(projects.map(p => [p.id, p]));
    const recents = recentTasks;

    // Recency bonus: decays linearly with position in recentTasks.
    const recencyBonus = (taskId: string) => {
      const idx = recents.indexOf(taskId);
      if (idx === -1) return 0;
      return Math.max(0, 10 - idx);
    };

    const trimmed = query.trim();

    // Parse optional status: / is: qualifier from query text or explicit statusFilter
    let filterColumn: BoardStateColumn | null = statusFilter;
    let q = trimmed;
    const qualifierMatch = q.match(STATUS_QUALIFIER_RE);
    if (qualifierMatch) {
      const rawVal = qualifierMatch[1] || qualifierMatch[2] || qualifierMatch[3] || "";
      const resolved = resolveStatusQualifier(rawVal, tc);
      if (resolved) {
        filterColumn = resolved;
        q = q.replace(qualifierMatch[0], " ").trim();
      }
    }

    if (!trimmed && !filterColumn) {
      // Empty query and no filter: order primarily by recency, with current task at top.
      const sorted = [...unarchived].sort((a, b) => {
        if (a.id === activeTaskId) return -1;
        if (b.id === activeTaskId) return 1;
        const aIdx = recents.indexOf(a.id);
        const bIdx = recents.indexOf(b.id);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return 0;
      });

      return sorted.slice(0, MAX_RESULTS).map(t => {
        const facts = statusFacts[t.id] ?? NO_TAB_FACTS;
        const pr = prByTask?.[t.id]?.lookup ?? null;
        const column = boardColumnFromFacts(t, facts, pr, workPrefs) as BoardStateColumn;
        const statusLabel = tc(COL_LABEL[column] || "board.colSettled");
        return {
          task: t,
          project: projectMap.get(t.project_id),
          column,
          statusLabel,
          score: 0,
          nameMatches: [],
          branchMatches: [],
          projectMatches: [],
          statusMatches: [],
          isCurrent: t.id === activeTaskId,
        };
      });
    }

    const scored: ScoredTask[] = [];

    for (const task of unarchived) {
      const facts = statusFacts[task.id] ?? NO_TAB_FACTS;
      const pr = prByTask?.[task.id]?.lookup ?? null;
      const column = boardColumnFromFacts(task, facts, pr, workPrefs) as BoardStateColumn;
      if (filterColumn && column !== filterColumn) continue;

      const statusLabel = tc(COL_LABEL[column] || "board.colSettled");
      const project = projectMap.get(task.project_id);
      const projName = project?.name ?? "";
      const branchName = task.branch || "";
      const isCurrent = task.id === activeTaskId;

      if (!q) {
        // Qualifier-only search (e.g. "status:working") with no remaining text
        scored.push({
          task,
          project,
          column,
          statusLabel,
          score: 10 + recencyBonus(task.id) + (isCurrent ? 2 : 0),
          nameMatches: [],
          branchMatches: [],
          projectMatches: [],
          statusMatches: [],
          isCurrent,
        });
        continue;
      }

      const nameMatch = fuzzyMatch(task.name, q);
      const branchMatch = branchName && branchName !== task.name ? fuzzyMatch(branchName, q) : null;
      const projMatch = projName ? fuzzyMatch(projName, q) : null;
      const labelMatch = fuzzyMatch(statusLabel, q);
      const statusMatch = labelMatch
        || (column === "backlog" ? fuzzyMatch("not started", q) : null)
        || fuzzyMatch(column, q);
      const combined = `${projName} ${task.name} ${statusLabel}`;
      const combinedMatch = fuzzyMatch(combined, q);

      if (!nameMatch && !branchMatch && !projMatch && !statusMatch && !combinedMatch) continue;

      let score = 0;
      if (nameMatch) score = Math.max(score, nameMatch.score * 1.5);
      if (branchMatch) score = Math.max(score, branchMatch.score * 1.2);
      if (projMatch) score = Math.max(score, projMatch.score);
      if (statusMatch) score = Math.max(score, statusMatch.score * 1.3);
      if (combinedMatch) score = Math.max(score, combinedMatch.score);

      score += recencyBonus(task.id);
      if (isCurrent) score += 2;

      scored.push({
        task,
        project,
        column,
        statusLabel,
        score,
        nameMatches: nameMatch ? nameMatch.matches : [],
        branchMatches: branchMatch ? branchMatch.matches : [],
        projectMatches: projMatch ? projMatch.matches : [],
        statusMatches: labelMatch ? labelMatch.matches : [],
        isCurrent,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [open, tasks, projects, recentTasks, activeTaskId, query, statusFilter, statusFacts, prByTask, workPrefs, tc]);

  // Keep active index clamped and reset when search query or filter changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [query, statusFilter]);

  useEffect(() => {
    if (activeIdx > results.length - 1) {
      setActiveIdx(Math.max(0, results.length - 1));
    }
  }, [results.length, activeIdx]);

  // Scroll active row into view on keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function pick(taskId: string) {
    close();
    const app = useApp.getState();
    app.setActiveTask(taskId);
    const activeTabId = app.activeTab[taskId];
    if (activeTabId) focusMainTab(activeTabId);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const isCmd = eventCmd(e.nativeEvent);
    if (isCmd && !e.shiftKey && !e.altKey) {
      const match = FILTER_OPTIONS.find(opt => e.key === opt.key || e.code === `Digit${opt.key}`);
      if (match) {
        e.preventDefault();
        e.stopPropagation();
        selectStatusFilter(match.column);
        return;
      }
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) pick(r.task.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="termic-backdrop fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          data-testid="task-finder"
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(e) => {
            if (returnFocusRef.current) {
              e.preventDefault();
              returnFocusRef.current.focus();
            }
          }}
          className="termic-pop fixed left-1/2 top-12 z-50 w-[min(760px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl outline-none"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">{t("taskFinder.srTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("taskFinder.srDesc")}</Dialog.Description>

          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              ref={inputRef}
              autoFocus
              data-testid="task-finder-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t("taskFinder.placeholder")}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
            {query !== "" && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t("taskFinder.clear")}
                onClick={() => setQuery("")}
                className="rounded p-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div ref={listRef} className="max-h-[70vh] overflow-y-auto py-1">
            {results.length === 0 && (
              <div className="px-3 py-6 text-center text-[13px] text-[var(--color-fg-faint)]">
                {query.trim() || activeStatus ? t("taskFinder.noMatching") : t("taskFinder.noTasks")}
              </div>
            )}
            {results.map((r, i) => {
              const grpName = r.project ? groupOf(r.project) : "";
              const grpColor = grpName ? groupColors[grpName] : undefined;
              const hasDiffBranch = r.task.branch && r.task.branch !== r.task.name;

              return (
                <button
                  key={r.task.id}
                  data-row={i}
                  data-active={r.isCurrent || undefined}
                  onClick={() => pick(r.task.id)}
                  onMouseMove={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors",
                    i === activeIdx
                      ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)]",
                  )}
                >
                  {/* Project badge with group color dot */}
                  {r.project && (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-muted)]">
                      {grpColor && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: accentCss(grpColor) }}
                        />
                      )}
                      <span className="max-w-[120px] truncate">
                        <Highlighted text={r.project.name} matches={r.projectMatches} />
                      </span>
                    </span>
                  )}

                  {/* Task kind / Location icon */}
                  <TaskLocationIcon isMainCheckout={r.task.is_main_checkout} size="h-3.5 w-3.5" />

                  {/* Task name */}
                  <span className="min-w-0 truncate font-medium text-[var(--color-fg)]">
                    <Highlighted text={r.task.name} matches={r.nameMatches} />
                  </span>

                  {/* Branch name if different from task name */}
                  {hasDiffBranch && (
                    <span className="max-w-[160px] truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">
                      <Highlighted text={r.task.branch} matches={r.branchMatches} />
                    </span>
                  )}

                  {/* Spacer */}
                  <span className="flex-1" />

                  {/* Status badge */}
                  <span
                    data-testid="task-finder-status"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] font-medium"
                    style={{ color: COL_ACCENT[r.column] || "var(--color-fg-muted)" }}
                  >
                    {statusIcon(r.column)}
                    <span>
                      <Highlighted text={r.statusLabel} matches={r.statusMatches} />
                    </span>
                  </span>

                  {/* Agent CLI icon */}
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(r.task.cli, agents)] || "text-[var(--color-fg-dim)]")}>
                    <CliIcon cli={resolveIconId(r.task.cli, agents)} className="h-3.5 w-3.5" />
                  </span>

                  {/* Current task pill */}
                  {r.isCurrent && (
                    <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                      {t("taskFinder.current")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] px-3 py-1.5 text-[11px] text-[var(--color-fg-faint)] select-none">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0">{t("taskFinder.count", { count: results.length })}</span>
              <span className="h-3 w-px shrink-0 bg-[var(--color-border-soft)]" />
              <div className="flex items-center gap-1 overflow-x-auto py-0.5">
                {FILTER_OPTIONS.map(({ key, column, labelKey, accent }) => {
                  const isActive = column === null ? activeStatus === null : activeStatus === column;
                  return (
                    <button
                      key={key}
                      type="button"
                      tabIndex={-1}
                      data-testid={`task-finder-filter-${column ?? "all"}`}
                      data-active={isActive || undefined}
                      onMouseDown={e => {
                        // Prevent button click from stealing DOM focus from the search input on Windows/Linux.
                        e.preventDefault();
                      }}
                      onClick={() => selectStatusFilter(column)}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] transition-colors",
                        isActive
                          ? "bg-[var(--color-bg-3)] font-medium text-[var(--color-fg)]"
                          : "text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg-dim)]",
                      )}
                      style={isActive && accent ? { color: accent } : undefined}
                    >
                      <kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[9.5px] font-mono leading-none">
                        {kbd(`⌘${key}`)}
                      </kbd>
                      <span>{t(labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <span className="flex shrink-0 items-center gap-2.5">
              <span><kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px]">↑↓</kbd> {t("taskFinder.navigate")}</span>
              <span><kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px]">↵</kbd> {t("taskFinder.switch")}</span>
              <span><kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px]">esc</kbd> {t("taskFinder.dismiss")}</span>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
