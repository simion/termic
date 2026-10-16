// Sidebar task groups: the pure half. A group is founded when an agent in one
// task creates another through the CLI or MCP (Rust `apply_group_join`), and
// every member carries the same `TaskGroup` copy. Everything the sidebar needs
// to DRAW one lives here, so the rules are testable without a DOM.

import { ACCENTS, accentCss } from "@/lib/accents";
import type { Tab, Task, TaskGroup } from "@/lib/types";
import { taskDelegatedWork, taskWorkBadge, type WorkStatePrefs } from "@/lib/taskWorkState";

/** What colour a group without one draws its rail in. Same neutral an
 *  uncoloured project folder uses. */
export const GROUP_FALLBACK_COLOR = "var(--color-fg-faint)";

export const groupColorCss = (g: TaskGroup | undefined): string =>
  accentCss(g?.color) ?? GROUP_FALLBACK_COLOR;

/** Every live group, once each, in first-appearance order: what "Move to
 *  group" offers. A group exists while any live task carries it (the project
 *  folder rule), so a group of one is listed and drawn like any other. */
export function liveGroups(tasks: Task[]): TaskGroup[] {
  const seen = new Map<string, TaskGroup>();
  for (const t of tasks) {
    if (t.archived || !t.group || seen.has(t.group.id)) continue;
    // Prefer the lead's copy, the canonical one (see layoutTaskList).
    const lead = tasks.find(m => m.id === t.group!.id && m.group?.id === t.group!.id);
    seen.set(t.group.id, lead?.group ?? t.group);
  }
  return [...seen.values()];
}

/** The label a group shows: its own name, else its lead's CURRENT name (so
 *  renaming the orchestrator renames an unnamed group), else a generic word
 *  for a group whose lead record is gone. `t` is the caller component's
 *  sidebar-namespace translator (docs/i18n.md: a pure helper that renders for
 *  a component takes `t` as a parameter); without it the fallback stays the
 *  English source string, which is what the unit test pins. */
export function groupLabel(g: TaskGroup, tasks: Task[], t?: (k: string) => string): string {
  if (g.name?.trim()) return g.name.trim();
  const lead = tasks.find(task => task.id === g.id)?.name;
  if (lead) return lead;
  return t ? t("taskGroup.fallback") : "Task group";
}

/** A live member of the group called `name` in one project, to join through,
 *  or undefined when no such group exists there.
 *
 *  For a caller that names the group of an UNGROUPED task. A group's identity
 *  is its id, but a name is the only handle an agent has: one outside any
 *  task (an MCP client on another machine) creates two tasks and gives each
 *  the group name "Release prep", meaning one group. Founding a group per
 *  call made two groups with one name and two colours.
 *
 *  Matched on the label the sidebar SHOWS (`groupLabel`: the group's own
 *  name, else its lead's), trimmed and case-insensitive, and only within the
 *  project: a group never spans projects. The lead's copy is preferred so the
 *  join goes through the canonical record. */
export function groupMemberByName(tasks: Task[], projectId: string, name: string, exceptTaskId?: string): Task | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  const members = tasks.filter(t =>
    !t.archived && !!t.group && t.project_id === projectId && t.id !== exceptTaskId
    && groupLabel(t.group, tasks).trim().toLowerCase() === want);
  return members.find(t => t.id === t.group!.id) ?? members[0];
}

/** The order founding picks accents in. Not the palette's order: that one
 *  starts at red, and a red caption on a fresh group reads as an error.
 *  Calm hues first, red last. */
const FOUNDING_ORDER = ["blue", "teal", "purple", "green", "orange", "pink", "yellow", "red"];

/** Colour for a group being founded: the first accent (in FOUNDING_ORDER) no
 *  live group already wears, so two groups side by side never share one. Past
 *  eight live groups it cycles, which is the best a fixed palette can do. */
export function nextGroupColor(tasks: Task[]): string {
  const used = new Set<string>();
  const live = new Set<string>();
  for (const t of tasks) {
    if (t.archived || !t.group) continue;
    live.add(t.group.id);
    if (t.group.color) used.add(t.group.color);
  }
  const order = FOUNDING_ORDER.filter(k => ACCENTS.some(c => c.key === k));
  return order.find(k => !used.has(k)) ?? order[live.size % order.length];
}

/** Tasks whose group the sidebar does NOT draw: the only live member of
 *  their group in their project, while other members sit in another project.
 *
 *  Groups stay within one project now (Rust `apply_spawn_link`), but before
 *  that an agent spawning into another project put both tasks in one group,
 *  and the sidebar, split by project, drew it as two unrelated groups of one,
 *  both captioned with the lead's name. Those draw as plain rows linked by
 *  `spawned_by` instead, with no migration: the data is left as it was. */
export function crossProjectStrays(tasks: Task[]): Set<string> {
  const byGroup = new Map<string, Map<string, string[]>>();
  for (const t of tasks) {
    if (t.archived || !t.group) continue;
    let projects = byGroup.get(t.group.id);
    if (!projects) byGroup.set(t.group.id, (projects = new Map()));
    const ids = projects.get(t.project_id);
    if (ids) ids.push(t.id);
    else projects.set(t.project_id, [t.id]);
  }
  const out = new Set<string>();
  for (const projects of byGroup.values()) {
    if (projects.size < 2) continue;
    for (const ids of projects.values()) if (ids.length === 1) out.add(ids[0]);
  }
  return out;
}

export type TaskListSegment =
  | { kind: "task"; task: Task }
  | { kind: "group"; group: TaskGroup; tasks: Task[] };

/** One project's rows, with each group gathered into one contiguous block
 *  at its FIRST member's position (store order is display order otherwise,
 *  see Sidebar).
 *
 *  `groupIdOf` exists for the drag: the row being dragged wears whichever
 *  group the cursor is over, not the one on disk, so the block visibly grows
 *  and shrinks under it before the drop commits anything. */
export function layoutTaskList(
  taskList: Task[],
  groupFor: (t: Task) => TaskGroup | null = t => t.group ?? null,
): TaskListSegment[] {
  const out: TaskListSegment[] = [];
  const emitted = new Set<string>();
  for (const t of taskList) {
    const g = groupFor(t);
    if (!g) {
      out.push({ kind: "task", task: t });
      continue;
    }
    if (emitted.has(g.id)) continue;
    emitted.add(g.id);
    // The lead's copy speaks for the block when it is here: every member
    // carries the same one, but a drag override hands the dragged row the
    // TARGET's copy, so the first member's is not guaranteed canonical.
    const members = taskList.filter(m => groupFor(m)?.id === g.id);
    const lead = members.find(m => m.id === g.id);
    out.push({ kind: "group", group: (lead && groupFor(lead)) ?? g, tasks: members });
  }
  return out;
}

/** Display order, flattened: what a drop persists through `task_reorder` so
 *  the stored order matches what the user saw. */
export const flattenSegments = (segs: TaskListSegment[]): Task[] =>
  segs.flatMap(s => (s.kind === "task" ? [s.task] : s.tasks));

/** One mark a collapsed group's caption can carry, in the order drawn. */
export type GroupBadgeKind = "attention" | "done" | "partial" | "marked" | "working" | "delegated";
const GROUP_BADGE_ORDER: GroupBadgeKind[] = ["attention", "done", "partial", "marked", "working", "delegated"];

/** What a COLLAPSED group shows in place of its rows: one of each mark any
 *  member's row would draw, never just the most urgent, so "two finished and
 *  one needs you" survives the collapse.
 *
 *  Per member it is exactly the row's own rule (`taskWorkBadge`, then the
 *  partial-done override `TaskWorkBadge` applies), so the caption can never
 *  claim something the rows it hides would not. `partialPref` is the
 *  `partialDoneIndicator` pref, which that override honours. */
export function groupBadgeKinds(
  memberTabs: Tab[][],
  prefs: WorkStatePrefs,
  partialPref: boolean,
): GroupBadgeKind[] {
  const seen = new Set<GroupBadgeKind>();
  for (const tabs of memberTabs) {
    const reason = taskWorkBadge(tabs, prefs);
    if (!reason) continue;
    const partial = reason !== "attention" && partialPref && !!taskDelegatedWork(tabs, prefs)?.partial;
    seen.add(partial ? "partial" : reason);
  }
  return GROUP_BADGE_ORDER.filter(k => seen.has(k));
}
