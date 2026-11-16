// Per-project task filter for the sidebar (GH #324): a bell that keeps only
// tasks with a notification, and a text match on the task name and its
// agent tabs' titles. Pure functions of store state, evaluated at render, so
// a CLI rename or a notification arriving shows or hides a row with no extra
// wiring.
//
// The filter reads a task's tabs through `TaskFilterFacts`, not the tabs
// themselves, so the sidebar can hold what it reads in a selector that stays
// put while an agent streams (src/store/sidebarTabs.ts, docs/performance.md
// bear trap 5).

import type { Agent, Tab, Task, TerminalTab } from "@/lib/types";
import { agentDisplayName } from "@/lib/agents";
import { aggregateTabsState } from "@/lib/cliAgentState";

export interface TaskFilter {
  /** Raw input value; matching trims it. */
  text: string;
  bell: boolean;
}

export function isFilterActive(f: TaskFilter | undefined): f is TaskFilter {
  return !!f && (f.bell || f.text.trim() !== "");
}

/** Same classification as the tray's numeral (computeTrayAttention):
 *  a task counts when its aggregate is "waiting" or "done". A task whose
 *  tabs were never loaded this session has no signal, so it never counts. */
export function taskHasNotification(tabs: Tab[] | undefined): boolean {
  const term = (tabs ?? []).filter((t): t is TerminalTab => t.type === "terminal");
  if (term.length === 0) return false;
  const st = aggregateTabsState(term);
  return st === "waiting" || st === "done";
}

/** Everything the filter reads from one task's LOADED tabs. A task whose
 *  tabs were never loaded this session has no facts at all (`undefined`),
 *  which is what sends the text match to its persisted tabs. */
export interface TaskFilterFacts {
  /** `taskHasNotification`, the bell's classification. */
  readonly notification: boolean;
  /** The STABLE titles of the task's terminal tabs: the user's rename, else
   *  the default title. `liveTitle` (the agent's OSC title) is deliberately
   *  left out: agents rewrite it every second ("thinking...", spinners), and
   *  matching on it would make rows flap in and out of the list. */
  readonly titles: readonly string[];
  /** Every value of the terminal tabs' properties (GH #358), so typing a
   *  ticket an agent set finds the task working on it. */
  readonly propValues: readonly string[];
}

export function taskFilterFacts(tabs: Tab[]): TaskFilterFacts {
  const term = tabs.filter((t): t is TerminalTab => t.type === "terminal");
  return {
    notification: taskHasNotification(tabs),
    titles: term.map(t => t.title),
    propValues: term.flatMap(t => (t.props ?? []).map(p => p.value)),
  };
}

/** Property values for the text match: the loaded tabs' when there are
 *  facts, else the persisted tabs' (they carry their properties). */
function propValues(task: Task, facts: TaskFilterFacts | undefined): readonly string[] {
  if (facts) return facts.propValues;
  return (task.persisted_tabs ?? []).flatMap(pt => (pt.props ?? []).map(p => p.value));
}

/** A task whose tabs are not loaded yet falls back to its persisted tabs,
 *  titled the way a restore would title them. */
function tabTitles(task: Task, facts: TaskFilterFacts | undefined, agents: Agent[]): readonly string[] {
  if (facts) return facts.titles;
  return (task.persisted_tabs ?? []).map(pt =>
    pt.custom_title && pt.title ? pt.title : agentDisplayName(pt.cli, agents));
}

export function taskMatchesText(task: Task, facts: TaskFilterFacts | undefined, agents: Agent[], text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  if (task.name.toLowerCase().includes(needle)) return true;
  if (tabTitles(task, facts, agents).some(t => t.toLowerCase().includes(needle))) return true;
  return propValues(task, facts).some(v => v.toLowerCase().includes(needle));
}

/** Tasks that pass `filter` (both parts AND). The active task always stays:
 *  opening a task clears its notification, and without the exemption the
 *  row the user just clicked would vanish from under the cursor. It drops
 *  out once another task is selected. A PINNED task (GH #458) always stays,
 *  until it is unpinned. */
export function filterTasks(
  list: Task[],
  filter: TaskFilter | undefined,
  facts: Readonly<Record<string, TaskFilterFacts | undefined>>,
  agents: Agent[],
  activeTaskId: string | null,
): Task[] {
  if (!isFilterActive(filter)) return list;
  return list.filter(t =>
    t.id === activeTaskId
    || !!t.pinned
    || ((!filter.bell || !!facts[t.id]?.notification)
      && taskMatchesText(t, facts[t.id], agents, filter.text)));
}
