import { GitBranch, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

// One representative icon for a task's location, used everywhere a task's
// checkout kind is shown (sidebar rows, the UnifiedBar breadcrumb, Dashboard
// cards, History). Mirrors the New Task dialog's toggle iconography so the
// language is consistent app-wide:
//   - worktree      -> GitBranch  (an isolated branch checkout)
//   - main checkout -> Link2      (the repo's own live checkout)
// Native `title` gives a hover tooltip without the weight of a portal on every
// sidebar row. `className` styles the WRAPPER (add `self-center` inside a
// baseline-aligned row); `size` sizes the glyph.
export function TaskLocationIcon({
  isMainCheckout,
  className,
  size = "h-3.5 w-3.5",
}: {
  isMainCheckout: boolean | undefined;
  className?: string;
  size?: string;
}) {
  const Icon = isMainCheckout ? Link2 : GitBranch;
  const label = isMainCheckout ? "main checkout" : "worktree";
  // One neutral gray for both states, a touch more faded than the task title.
  // The glyph shape (link = main checkout, branch = worktree) carries the
  // distinction; the color is deliberately quiet.
  return (
    <span
      title={label}
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center text-[var(--color-loc)]", className)}
    >
      <Icon className={size} />
    </span>
  );
}
