import { RotateCcw, AlertTriangle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Non-blocking "process exited" banner that sits at the TOP of a terminal
// pane (just under the tab bar) as an IN-FLOW strip — it pushes the xterm
// down rather than overlaying it, so no terminal output is ever covered and
// the dead xterm stays fully interactive (the user can select + copy its
// scrollback, e.g. an error message). Render it as the first flex child of
// a `flex-col` pane. Shared by the agent pane (TerminalPane) and the aux
// shell (AuxTerminal) so the two can't drift.
export function TerminalExitedBanner({ label, actionLabel, onAction, icon: Icon = RotateCcw, tone = "warning", className }: {
  /** e.g. "codex exited." */
  label: string;
  /** e.g. "Restart codex" / "New shell". */
  actionLabel: string;
  onAction: () => void;
  /** Action button glyph. Defaults to a restart arrow. */
  icon?: LucideIcon;
  /** Run tabs use a muted state; agent exits stay warning-tinted. */
  tone?: "warning" | "muted";
  className?: string;
}) {
  const muted = tone === "muted";
  return (
    <div
      // Background via inline style: Tailwind arbitrary values with nested
      // color-mix(...) commas don't reliably compile, which left the orange
      // strip invisible. Inline guarantees it renders.
      style={{
        background: muted
          ? "color-mix(in srgb, var(--color-fg) 5%, var(--color-bg-1))"
          : "color-mix(in srgb, var(--color-warn) 16%, var(--color-bg-1))",
      }}
      className={cn(
        // Warn-tinted for dead agents; muted for managed Run/Setup tabs.
        // In-flow + shrink-0 so it pushes the terminal down.
        "flex shrink-0 items-center justify-between gap-3 px-3 py-1.5",
        className,
      )}
    >
      <span className={cn(
        "flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium",
        muted ? "text-[var(--color-fg-dim)]" : "text-[var(--color-warn)]",
      )}>
        {!muted && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
      </span>
      <button
        type="button"
        onClick={onAction}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md border bg-[var(--color-bg-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-fg)]",
          muted
            ? "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)]"
            : "border-[var(--color-warn)]/50 hover:border-[var(--color-warn)] hover:bg-[var(--color-warn)]/10",
        )}
      >
        <Icon className="h-3.5 w-3.5" /> {actionLabel}
      </button>
    </div>
  );
}
