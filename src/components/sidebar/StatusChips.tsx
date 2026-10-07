// The sidebar's status chips (docs/ui.md "The sidebar's status chips"): how
// many tasks need you, are working, and are in review, under the filter bar.
// A chip is a shortcut into the query, not a second filter: clicking it
// toggles `status:<column>` in the sidebar's query text, so the bar shows
// what it did and the tree is still the only list of tasks. Drawn only while
// the opt-in STATUS section is off: with it on, the section lists the same
// buckets and the chips would say it twice.
//
// Counts are PER TASK, in the board's own column (useTaskQuery's column
// map, `boardColumnFromFacts`), under the rest of the sidebar's query: a
// chip reads how many of the tasks the bar lets through sit in its column,
// which is what clicking it leaves in the tree, plus the open task the tree
// always keeps. Turning one chip on does not zero the others.
//
// Rendering discipline (bear traps 5 and 8): its own memoized component, so
// a count moving re-renders the chips and not the Sidebar body. The columns
// come from per-task status facts (never `tabs`), so an output stamp or a
// live title re-renders nothing here.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bell, GitPullRequest } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { useTaskQuery } from "@/hooks/useTaskQuery";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { boardClauseState, toggleBoardClause } from "@/lib/boardFilter";
import type { BoardStateColumn } from "@/lib/taskBoardState";
import type { WorkStatePrefs } from "@/lib/taskWorkState";
import { cn } from "@/lib/utils";

/** The columns that get a chip, in display order: what needs you first, then
 *  what is in flight. Settled and Not started are the largest and least
 *  urgent; the board and the filter have them. */
const STATUS_CHIPS = ["attention", "working", "review"] as const satisfies readonly BoardStateColumn[];
type StatusChip = (typeof STATUS_CHIPS)[number];

/** Literal keys, so usedKeys.test.ts can see them. */
function chipLabel(chip: StatusChip, t: (k: string) => string): string {
  switch (chip) {
    case "attention": return t("statusChips.attention");
    case "working": return t("statusChips.working");
    case "review": return t("statusChips.review");
  }
}

const ICON: Record<StatusChip, React.ReactNode> = {
  attention: <Bell className="h-3 w-3 text-[var(--color-warn)]" strokeWidth={2.5} />,
  working: <span className="text-[var(--color-fg-faint)]"><Spinner size={10} /></span>,
  // the PR glyph in the theme's fg, not a PR-state colour: the column means
  // "has a PR", and green read as "checks passed"
  review: <GitPullRequest className="h-3 w-3 text-[var(--color-fg)]" />,
};

export const StatusChips = memo(function StatusChips() {
  const { t } = useTranslation("sidebar");
  const projects = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );
  const text = useUI(s => s.sidebarQuery);
  const setText = useUI(s => s.setSidebarQuery);
  // What the tree can list: unarchived, in a project of this profile.
  const live = useMemo(() => {
    const ids = new Set(projects.map(p => p.id));
    return tasks.filter(w => !w.archived && ids.has(w.project_id));
  }, [tasks, projects]);
  const { query, columnOf, columnCount } = useTaskQuery({ text, menuOpen: false, live, workPrefs, alwaysColumns: true });
  const counts = useMemo(
    () => Object.fromEntries(STATUS_CHIPS.map(c => [c, columnCount(c)])) as Record<StatusChip, number>,
    [columnCount],
  );
  // Whether a chip is drawn goes by the UNFILTERED column, so typing in the
  // bar never makes chips come and go: under a query a chip can read 0.
  const totals = useMemo(() => {
    const n: Record<string, number> = {};
    for (const c of columnOf.values()) n[c] = (n[c] ?? 0) + 1;
    return n;
  }, [columnOf]);

  // An empty chip is hidden, unless the query holds it: it is how that
  // clause comes back out.
  const shown = STATUS_CHIPS.filter(c => (totals[c] ?? 0) > 0 || boardClauseState(query, "status", c) !== null);
  if (shown.length === 0) return null;
  return (
    // One line at any sidebar width: a chip is its glyph and count, and its
    // name lives in the tooltip and the accessible label.
    <div data-testid="status-chips" className="flex min-w-0 flex-nowrap gap-1 overflow-hidden">
      {shown.map(c => {
        const on = boardClauseState(query, "status", c) === "include";
        return (
          <Tip key={c} content={t(on ? "statusChips.tipActive" : "statusChips.tip", { status: c, label: chipLabel(c, t) })} side="bottom">
            <button
              type="button"
              data-status-chip={c}
              aria-pressed={on}
              aria-label={`${chipLabel(c, t)} ${counts[c]}`}
              onClick={() => setText(toggleBoardClause(useUI.getState().sidebarQuery, "status", c))}
              className={cn(
                "flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11.5px] tabular-nums transition-colors",
                on
                  ? "border-[var(--color-accent)] text-[var(--color-fg)]"
                  : "border-[var(--color-border-soft)] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
              )}
              style={on ? { backgroundColor: "color-mix(in srgb, var(--color-accent) 14%, transparent)" } : undefined}
            >
              {ICON[c]}
              <span data-testid="status-chip-count">{counts[c]}</span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
});
