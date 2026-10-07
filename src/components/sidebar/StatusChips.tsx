// The sidebar's status chips (docs/ui.md "The sidebar's status chips"): how
// many tasks need you, are working, and are in review, under the filter bar.
// A chip is a shortcut into the query, not a second filter: clicking it
// toggles `status:<column>` in the sidebar's query text, so the bar shows
// what it did and the tree is still the only list of tasks. Drawn only while
// the opt-in STATUS section is off: with it on, the section lists the same
// buckets and the chips would say it twice.
//
// Counts are PER TASK, from the board's own column precedence, so a chip's
// number is exactly what clicking it leaves in the tree.
//
// Rendering discipline (bear traps 5 and 8): its own component, reading the
// three raw facts per task from useStatusTabFacts (never `tabs`), with the PR
// snapshot read non-reactively behind a small usePr trigger, the way
// BoardView does it. An output stamp or a live title re-renders nothing here,
// and the Sidebar body does not re-render when a count moves.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bell, GitPullRequest } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import { useUI } from "@/store/ui";
import { useStatusTabFacts } from "@/store/sidebarTabs";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { boardClauseState, parseBoardQuery, toggleBoardClause } from "@/lib/boardFilter";
import { STATUS_CHIPS, statusCounts, type StatusChip } from "@/lib/sidebarStatus";
import type { WorkStatePrefs } from "@/lib/taskWorkState";
import { cn } from "@/lib/utils";

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
  working: <span className="text-[var(--color-fg-faint)]"><Spinner size={11} /></span>,
  review: <GitPullRequest className="h-3 w-3 text-[var(--color-pr-open)]" />,
};

export const StatusChips = memo(function StatusChips() {
  const { t } = useTranslation("sidebar");
  const projects = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const facts = useStatusTabFacts();
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );
  // Re-render trigger for PR polls: an open -> merged transition moves a
  // task out of In review. Same key as BoardView's.
  const prKey = usePr(s => Object.values(s.byTask).map(e => e.lookup?.pr?.state ?? "?").join("|"));
  const counts = useMemo(
    () => statusCounts(projects, tasks, facts, usePr.getState().byTask, workPrefs),
    // prKey stands in for the snapshot read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, tasks, facts, workPrefs, prKey],
  );
  const text = useUI(s => s.sidebarQuery);
  const setText = useUI(s => s.setSidebarQuery);
  const query = useMemo(() => parseBoardQuery(text), [text]);

  // An empty chip is hidden, unless the query holds it: it is how that
  // clause comes back out.
  const shown = STATUS_CHIPS.filter(c => counts[c] > 0 || boardClauseState(query, "status", c) !== null);
  if (shown.length === 0) return null;
  return (
    <div data-testid="status-chips" className="flex shrink-0 flex-wrap gap-1 px-2 pt-1.5">
      {shown.map(c => {
        const on = boardClauseState(query, "status", c) === "include";
        return (
          <Tip key={c} content={t(on ? "statusChips.tipActive" : "statusChips.tip", { status: c })} side="bottom">
            <button
              type="button"
              data-status-chip={c}
              aria-pressed={on}
              onClick={() => setText(toggleBoardClause(useUI.getState().sidebarQuery, "status", c))}
              className={cn(
                "flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[11.5px] tabular-nums transition-colors",
                on
                  ? "border-[var(--color-accent)] text-[var(--color-fg)]"
                  : "border-[var(--color-border-soft)] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
              )}
              style={on ? { backgroundColor: "color-mix(in srgb, var(--color-accent) 14%, transparent)" } : undefined}
            >
              {ICON[c]}
              <span data-testid="status-chip-count">{counts[c]}</span>
              <span className="text-[11px]">{chipLabel(c, t)}</span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
});
