import { cn } from "@/lib/utils";

/** A task row's branch, placed by the `taskBranchName` pref. On the name's
 *  line it never shrinks below its text up to 60% of the row; "right"
 *  pushes itself to the row's end inside the name column so the PR numbers
 *  keep one right edge. */
export function TaskBranchText({ branch, placement }: { branch: string; placement: "inline" | "right" | "below" }) {
  return (
    <span
      data-testid="task-branch"
      data-placement={placement}
      data-branch={branch}
      title={branch}
      className={cn(
        // fg-faint, a step under the name, so the branch reads as metadata.
        "min-w-0 truncate font-mono text-[11px] text-[var(--color-fg-faint)]",
        // Never shrinks, capped at 60% so the name keeps 40%. A shared shrink
        // turned "main" into "m…" beside a long name; a 45% cap cut a long
        // branch off with room to spare.
        placement !== "below" && "max-w-[60%] shrink-0",
        placement === "right" && "ml-auto pl-2",
        placement === "below" && "leading-tight",
      )}
    >{placement === "inline" ? `· ${branch}` : branch}</span>
  );
}
