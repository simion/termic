// Renders every task the user has visited this session, keeping all
// of them mounted with visibility toggles. This is critical:
//
//   * Each TaskView owns xterm.js instances + live PTYs.
//   * Unmounting kills the PTY → agent process dies → session lost.
//   * So we keep them mounted; only the active one is `visibility: visible`.
//
// First-time activation lazily appends the task to the mounted set
// (handled in `setActiveTask`). Archived tasks are excluded so
// their PTYs are freed.

import { useApp, useActiveTask } from "@/store/app";
import { Dashboard } from "@/components/views/Dashboard";
import { HistoryView } from "@/components/views/History";
import { TaskView } from "@/components/task/TaskView";

export function MainArea() {
  const task = useActiveTask();
  const view = useApp(s => s.view.page);
  const tasks = useApp(s => s.tasks);
  const mounted = useApp(s => s.mountedTasks);

  // Settings is rendered as an overlay at the App level (see App.tsx) — we
  // don't render it from here, so MainArea + all its TaskViews stay
  // mounted underneath and PTYs survive entering/leaving settings.

  // Build the list of tasks to render: every visited (mounted) one
  // that still exists and isn't archived. The active one is visible; the
  // rest are stacked underneath with `visibility: hidden`.
  const mountedList = tasks.filter(w => mounted.has(w.id) && !w.archived);
  const activeId = task?.id ?? null;

  // No active task → show the Dashboard (the real home screen: logo,
  // Add project / Discover repos / Settings, project list) as the OVERLAY,
  // unless the user explicitly navigated to History. The hidden mounted
  // tasks still render underneath so their PTYs survive.
  const overlay =
    view === "history" && !task ? <HistoryView /> :
    !task ? <Dashboard /> :
    null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {mountedList.map(w => (
        <div
          key={w.id}
          className="absolute inset-0 flex min-h-0 flex-col"
          style={{
            visibility: w.id === activeId ? "visible" : "hidden",
            zIndex:    w.id === activeId ? 1 : 0,
          }}
        >
          <TaskView task={w} />
        </div>
      ))}
      {overlay && (
        <div className="absolute inset-0 z-10 bg-[var(--color-bg)]">
          {overlay}
        </div>
      )}
    </div>
  );
}
