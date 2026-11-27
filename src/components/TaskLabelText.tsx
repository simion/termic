// A task's label as a sidebar row draws it: whatever `taskLabel` picks, with a
// branch's leading path (`feature/`) faint, so the part that differs between
// rows is the part that reads (`taskLabelParts`). Shared by the tree's rows and
// the status section's, which must name a task the same way.

import { cn } from "@/lib/utils";
import { taskLabelParts, type TaskLike } from "@/lib/taskLabel";

export function TaskLabelText({ task, useBranch, leafOnly = false, title, className }: {
  task: TaskLike;
  /** The `useBranchAsTaskName` pref, passed down rather than subscribed per
   *  row. */
  useBranch: boolean;
  /** Drop the prefix and draw the leaf alone: the status section's rows,
   *  which also carry the project name and have no room for both. Squeezed
   *  there, the prefix was cut to a different length on every row ("fea…",
   *  "featu…"), which read as noise. The caller puts the whole label in
   *  `title`. */
  leafOnly?: boolean;
  title?: string;
  /** Weight and font for the whole label (a branch row is mono). */
  className?: string;
}) {
  const { prefix, leaf } = taskLabelParts(task, useBranch);
  if (!prefix || leafOnly) {
    return (
      <span
        data-testid="task-label"
        data-dropped-prefix={leafOnly && prefix ? prefix : undefined}
        title={title}
        className={cn("min-w-0 truncate", className)}
      >
        {leaf}
      </span>
    );
  }
  return (
    <span data-testid="task-label" title={title} className={cn("flex min-w-0 truncate", className)}>
      {/* Squeezed, the prefix takes ALL of the shortfall and shrinks to
          nothing before the leaf loses a character, since the leaf is the
          part that tells two rows apart. The leaf does not shrink at all,
          only caps at the label's width (so a leaf longer than the whole row
          still truncates). Weighting the shrink instead (shrink-[1000] on the
          prefix) is not enough: flex still hands the leaf a sliver, and a
          leaf 0.02px short already paints its ellipsis (measured in
          sidebar-status.e2e.ts). */}
      {/* The path gives way, its trailing slash does not: cut to nothing
          the path left a bare first letter glued to the leaf, so
          `george/desktop-x` read `gdesktop-x`. Squeezed it is `g…/desktop-x`. */}
      <span
        data-testid="task-label-prefix"
        className="flex min-w-0 font-normal text-[var(--color-fg-faint)]"
      >
        <span className="min-w-0 truncate">{prefix.slice(0, -1)}</span>
        <span data-testid="task-label-slash" className="shrink-0">/</span>
      </span>
      <span className="max-w-full shrink-0 truncate">{leaf}</span>
    </span>
  );
}
