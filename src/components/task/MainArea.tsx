// Renders every task the user has visited this session, keeping all
// of them mounted with display toggles. This is critical:
//
//   * Each TaskView owns xterm.js instances + live PTYs.
//   * Unmounting kills the PTY → agent process dies → session lost.
//   * So we keep them mounted; only the active one is displayed.
//
// Hidden tasks MUST be `display: none`, not `visibility: hidden`: xterm's
// renderer only pauses for zero-geometry hosts (its IntersectionObserver
// keys on geometry, not visibility), so a visibility-hidden terminal whose
// agent TUI keeps redrawing (spinners, prompt cursors) still runs WebGL
// draws + compositor work for every mounted task, around the clock. That
// pinned the GPU (~90% busy) and burned ~0.5 core of webview CPU even
// with the app "idle". Same pattern as the collapsed bottom split in
// TaskView. display:none also blurs the hidden pane's textarea, which
// pauses xterm's cursor-blink loop for free.
//
// First-time activation lazily appends the task to the mounted set
// (handled in `setActiveTask`). Archived tasks are excluded so
// their PTYs are freed.

import { useMemo } from "react";
import { useApp, useActiveTask } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePendingTask } from "@/store/pendingTasks";
import { Dashboard } from "@/components/views/Dashboard";
import { HistoryView } from "@/components/views/History";
import { BoardView } from "@/components/views/BoardView";
import { ScheduledView } from "@/components/views/Scheduled";
import { TodosView } from "@/components/views/TodosView";
import { TaskView } from "@/components/task/TaskView";
import { CreatingTaskPane } from "@/components/task/CreatingTaskPane";
import { RemoteTaskOverlay, ServerCloseDialog } from "@/components/remote/RemoteTaskView";

export function MainArea() {
  const task = useActiveTask();
  const activeTaskId = useApp(s => s.activeTaskId);
  // A task mid-creation has an activeTaskId (set the moment the New Task
  // dialog submits) but no entry in `tasks` yet — `task` above is null for
  // that case exactly like "nothing selected" is, so this is the only way
  // to tell the two apart. See CreatingTaskPane / GH #242.
  const pending = usePendingTask(!task ? activeTaskId : null);
  const view = useApp(s => s.view.page);
  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const mounted = useApp(s => s.mountedTasks);
  // Windowless mode (window closed to the menu bar / `--headless` CLI launch):
  // the ACTIVE pane loses its display exemption too, so every mounted terminal
  // sits at zero geometry and xterm's renderers pause. Hiding the window alone
  // does not do this — a hidden window still reports full layout, so the WebGL
  // draws would keep running for a window nobody can see. See
  // src/lib/windowlessMode.ts.
  const windowless = useUI(s => s.windowless);

  // Settings is rendered as an overlay at the App level (see App.tsx) — we
  // don't render it from here, so MainArea + all its TaskViews stay
  // mounted underneath and PTYs survive entering/leaving settings.

  // Build the list of tasks to render: every visited (mounted) one
  // that still exists and isn't archived. The active one is displayed; the
  // rest stay mounted but `display: none` (renderers paused, no paint).
  const mountedList = tasks.filter(w => mounted.has(w.id) && !w.archived);
  const activeId = task?.id ?? null;

  // No active task → show the Dashboard (the real home screen: logo,
  // Add project / Discover repos / Settings, project list) as the OVERLAY,
  // unless the user explicitly navigated to History. The hidden mounted
  // tasks still render underneath so their PTYs survive.
  const overlay =
    view === "history" && !task ? <HistoryView /> :
    view === "board" && !task ? <BoardView /> :
    view === "scheduled" && !task ? <ScheduledView /> :
    view === "todos" && !task ? <TodosView /> :
    pending ? <CreatingTaskPane id={pending.id} /> :
    !task ? <Dashboard /> :
    null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {mountedList.map(w => (
        <div
          key={w.id}
          // Every visited task stays mounted (see the note above), so tab
          // strips / pane chrome exist many times over in the DOM. This scopes
          // a query to one task — the only way e2e can aim at what's visible.
          data-task-id={w.id}
          className="absolute inset-0 flex min-h-0 flex-col"
          style={{
            // undefined → the className's `flex` applies; only hidden tasks
            // get an inline display override. In windowless mode nothing is
            // displayed, including the active task.
            display: w.id === activeId && !windowless ? undefined : "none",
            zIndex:  w.id === activeId ? 1 : 0,
          }}
        >
          {/* A server project's task too: its terminals run on the box
              (pty_spawn routes them there), drawn by the same view. */}
          <TaskView task={w} />
        </div>
      ))}
      {overlay && (
        <div className="absolute inset-0 z-10 bg-[var(--color-bg)]">
          {overlay}
        </div>
      )}
      {/* A task on another machine, over everything local (which stays
          mounted underneath, PTYs alive). */}
      <RemoteTaskOverlay />
      <ServerCloseDialog />
    </div>
  );
}
