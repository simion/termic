// The Agent Race strip. While a race is live, a thin bar above the main area
// shows every racer, its live work-state dot, and click-to-focus. This is the
// "side by side" surface for Slice 1; the actual N-up diff / compare is a
// later slice. Returns null when no race is active, so it costs nothing in the
// common case.

import { useMemo } from "react";
import { useApp } from "@/store/app";
import { useRace, latestRace } from "@/store/race";
import { useUI } from "@/store/ui";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { cn } from "@/lib/utils";
import { Flag, X, Columns2, Loader2 } from "lucide-react";
import type { TerminalTab } from "@/lib/types";

export type WorkDot = "idle" | "working" | "done";

export function RaceBoard() {
  const races = useRace(s => s.races);
  const end = useRace(s => s.end);
  const agents = useApp(s => s.agents);
  const tasks = useApp(s => s.tasks);
  const tabs = useApp(s => s.tabs);
  const activeId = useApp(s => s.activeTaskId);
  const setActiveTask = useApp(s => s.setActiveTask);
  const openCompare = useUI(s => s.openRaceCompare);

  const race = useMemo(() => latestRace(races), [races]);

  const racers = useMemo(() => {
    if (!race) return [];
    return race.taskIds
      .map(id => tasks.find(t => t.id === id && !t.archived))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map(t => {
        const main = (tabs[t.id] ?? []).find(
          (x): x is TerminalTab => x.type === "terminal" && !!x.is_default,
        );
        return { task: t, state: (main?.workState ?? "idle") as WorkDot };
      });
  }, [race, tasks, tabs]);

  // The compare view only makes sense once every racer has actually finished -
  // an in-flight worktree's diff is a moving target. Needs the full cohort (a
  // 1-agent "race" has nothing to compare against).
  const canCompare = racers.length >= 2 && racers.every(r => r.state === "done");

  if (!race || racers.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-1.5">
      <Flag className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span
        className="hidden shrink-0 max-w-[28%] truncate text-[12px] text-[var(--color-fg-dim)] sm:inline"
        title={race.prompt}
      >
        {race.name || race.prompt}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {racers.map(({ task, state }) => {
          const iconId = resolveIconId(task.cli, agents);
          const isActive = task.id === activeId;
          return (
            <button
              key={task.id}
              onClick={() => setActiveTask(task.id)}
              title={task.name}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
                isActive
                  ? "border-[var(--color-accent-soft)] bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
              )}
            >
              <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId])}>
                <CliIcon cli={iconId} className="h-3.5 w-3.5" />
              </span>
              <span className="max-w-[120px] truncate">{task.name}</span>
              <StateDot state={state} />
            </button>
          );
        })}
      </div>
      <button
        onClick={() => canCompare && openCompare(race.id)}
        disabled={!canCompare}
        title={canCompare ? "Compare the racers' diffs side by side" : "Compare unlocks once every agent has finished"}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
          canCompare
            ? "border-[var(--color-accent-soft)] text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
            : "cursor-not-allowed border-[var(--color-border)] text-[var(--color-fg-faint)]",
        )}
      >
        <Columns2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Compare</span>
      </button>
      <button
        onClick={() => end(race.id)}
        title="Dismiss race"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-fg-faint)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// Per-racer status, in the sidebar TabBadge's visual vocabulary so the same
// state reads the same everywhere: Loader2 spinner while the agent works,
// solid --color-info bullet when done, faint dot when idle. Unlike the
// sidebar's opt-in working indicator (off by default, noisy-TUI misfires),
// the spinner here is always on: watching progress is the strip's job, and
// a misfire costs nothing when every racer is expected to be working anyway.
// Shared with RaceCompare's column headers.
export function StateDot({ state }: { state: WorkDot }) {
  if (state === "working") {
    return (
      <span className="shrink-0 text-[var(--color-fg-faint)]" title="Agent working" aria-label="Working">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (state === "done") {
    return (
      <span
        className="block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: "var(--color-info)" }}
        title="Agent finished a turn"
        aria-label="Work done"
      />
    );
  }
  return <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-fg-faint)]" title="Idle" />;
}
