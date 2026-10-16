// The marks a FOLDED container carries for the task rows it hides: one of each
// that a member's row would draw (`groupBadgeKinds`), in its fixed order
// (attention, done, partial, working, delegated). Never just the most urgent:
// "two finished and one needs you" is the point. Four containers fold tasks
// away and all four draw this list: a task group in the tree (TaskGroupBlock)
// and in the status section, and a project and a project folder in the tree.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { selectRollupMarks } from "@/store/sidebarTabs";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";

/** The marks themselves, from a `groupBadgeKinds` key. `badgeTestId` keeps a
 *  container's badges apart from the rows' own `work-badge` (see the note in
 *  TaskWorkBadge.tsx). */
export function WorkMarkList({ kinds, badgeTestId }: { kinds: string; badgeTestId?: string }) {
  const { t } = useTranslation("sidebar");
  return (
    <>
      {kinds.split(",").map(k => k === "partial" ? (
        // TaskWorkBadge's partial mark needs a report to title it; a container
        // stands for several, so it draws the same outlined dot directly.
        <span key={k} title={t("taskGroup.delegatedPartialTip")} aria-label={t("taskGroup.delegatedPartialAria")} className="flex items-center justify-center">
          <span className="block h-2 w-2 rounded-full border-[1.5px]" style={{ borderColor: "var(--color-info)" }} />
        </span>
      ) : (
        <TaskWorkBadge key={k} reason={k as "attention" | "done" | "marked" | "working" | "delegated"} testId={badgeTestId} />
      ))}
    </>
  );
}

/** A collapsed project's or folder's marks. Subscribed through one joined
 *  string (`selectRollupMarks`), so the header re-renders when the SET of
 *  marks changes and never on a tab write that moves none (a live title, an
 *  output stamp). `ids` arrives joined too, so the Sidebar body re-rendering
 *  passes the memo. Mount it only while the container is folded: expanded,
 *  the rows carry their own badges, and an unmounted header costs no
 *  selector run at all. Draws nothing when no hidden row has a mark. */
export const RollupMarks = memo(function RollupMarks({ ids, testId }: {
  /** Member task ids, comma-joined. */
  ids: string;
  testId: string;
}) {
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const partialPref = usePrefs(s => s.partialDoneIndicator);
  const select = useMemo(
    () => selectRollupMarks(
      ids ? ids.split(",") : [],
      { settledHighlight, workingIndicator, attentionIndicator },
      partialPref,
    ),
    [ids, settledHighlight, workingIndicator, attentionIndicator, partialPref],
  );
  const kinds = useApp(select);
  if (!kinds) return null;
  return (
    <span data-testid={testId} data-kinds={kinds} className="flex shrink-0 items-center gap-1">
      <WorkMarkList kinds={kinds} badgeTestId="rollup-work-badge" />
    </span>
  );
});
