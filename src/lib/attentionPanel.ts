// The needs-you panel (GH #468): the shape the main window sends it, and
// the pure part of choosing what to list, so it is testable without a store.
import type { TerminalTab } from "@/lib/types";
import { aggregateTabsState } from "@/lib/cliAgentState";

/** One task waiting on the user, as the panel lists it. */
export interface WaitingTask { taskId: string; name: string; project: string }

/** The tasks waiting on the user (the sidebar's "needs you" rule), in the
 *  order given. Archived tasks never count. */
export function waitingTasks(
  tasks: Array<{ id: string; name: string; project_id: string; archived?: boolean }>,
  tabs: Record<string, Array<{ type: string }>>,
  projectName: (id: string) => string,
): WaitingTask[] {
  return tasks
    .filter(t => !t.archived)
    .filter(t => aggregateTabsState((tabs[t.id] ?? []).filter((x): x is TerminalTab => x.type === "terminal")) === "waiting")
    .map(t => ({ taskId: t.id, name: t.name, project: projectName(t.project_id) }));
}

export const sameList = (a: WaitingTask[], b: WaitingTask[]) =>
  a.length === b.length && a.every((x, i) => x.taskId === b[i].taskId && x.name === b[i].name);
