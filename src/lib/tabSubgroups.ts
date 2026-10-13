// Tab subgroups inside one task: the pure half (docs/ui.md "Tab subgroups").
//
// A subgroup gathers some of a task's sidebar child rows (main-pane terminal
// tabs) under a collapsible caption. There is no list of subgroups anywhere:
// every member tab carries an identical `TabSubgroup` copy (the `Task.group`
// precedent), and a subgroup exists while one tab carries it.
//
// The invariant everything here keeps: among a task's main-strip terminal
// tabs, each subgroup's members form ONE contiguous run, after the pinned
// head block, and a pinned tab is never a member. The sidebar draws a block
// at the run's position and the tab strip needs no grouping of its own,
// because the order already agrees. `reorderTab` itself never touches
// membership; the drops that can break a run (the sidebar row drag, the tab
// strip drag) settle it through `gatherSubgroupRuns` / `stripMembership`.

import { pickFoundingColor, groupBadgeKinds, type GroupBadgeKind } from "@/lib/taskGroups";
import type { Tab, TabSubgroup, TerminalTab } from "@/lib/types";
import type { WorkStatePrefs } from "@/lib/taskWorkState";

/** A sidebar child row: a main-pane terminal tab. */
export const isStripRow = (t: Tab): t is TerminalTab =>
  t.type === "terminal" && !(t as TerminalTab).paneId;

/** The subgroup a tab counts as being in. A pinned tab never does, whatever
 *  a bad write left on it. */
export const memberOf = (t: Tab): TabSubgroup | null =>
  isStripRow(t) && !t.pinned ? t.subgroup ?? null : null;

export const sameSubgroup = (a: TabSubgroup | null | undefined, b: TabSubgroup | null | undefined): boolean =>
  (a ?? null) === (b ?? null)
  || (!!a && !!b && a.id === b.id && a.name === b.name && (a.color ?? null) === (b.color ?? null));

/** `t` with `subgroup` set, or with the key REMOVED for null: absent is the
 *  only "ungrouped" state (docs/data-model.md), never `subgroup: undefined`
 *  lingering as a key. Joining also unpins, because a pinned tab is never a
 *  member. */
export function withSubgroup<T extends Tab>(t: T, g: TabSubgroup | null): T {
  const { subgroup: _s, ...rest } = t as T & { subgroup?: TabSubgroup };
  void _s;
  if (!g) return rest as T;
  const { pinned: _p, ...unpinned } = rest as T & { pinned?: boolean };
  void _p;
  return { ...unpinned, subgroup: g } as T;
}

export type TabRowSegment<T> =
  | { kind: "tab"; tab: T }
  | { kind: "subgroup"; subgroup: TabSubgroup; tabs: T[] };

/** The sidebar rows of one task, each subgroup gathered into one block at
 *  its FIRST member's position. The first member's copy speaks for the block
 *  (members disagreeing after a bad write: the next rename rewrites all).
 *
 *  `subgroupFor` exists for the drag: the lifted row wears the subgroup the
 *  cursor is over, not the one in the store, so the block grows and shrinks
 *  under it before the drop commits anything (the `layoutTaskList` twin). */
export function layoutTabRows<T extends Tab>(
  rows: readonly T[],
  subgroupFor: (t: T) => TabSubgroup | null = memberOf,
): TabRowSegment<T>[] {
  const out: TabRowSegment<T>[] = [];
  const emitted = new Set<string>();
  for (const t of rows) {
    const g = subgroupFor(t);
    if (!g) { out.push({ kind: "tab", tab: t }); continue; }
    if (emitted.has(g.id)) continue;
    emitted.add(g.id);
    out.push({ kind: "subgroup", subgroup: g, tabs: rows.filter(m => subgroupFor(m)?.id === g.id) });
  }
  return out;
}

/** Every subgroup a task's tabs carry, once each, in first-appearance order,
 *  as its first member's copy: what "Move to subgroup" offers. */
export function taskSubgroups(tabs: readonly Tab[]): TabSubgroup[] {
  const seen = new Map<string, TabSubgroup>();
  for (const t of tabs) {
    const g = memberOf(t);
    if (g && !seen.has(g.id)) seen.set(g.id, g);
  }
  return [...seen.values()];
}

/** `all` with each subgroup's main-strip members gathered into one run at its
 *  first member's position. Only the strip rows' slots are rewritten, so a
 *  hidden edit/diff tab or a split-pane tab between them keeps its index.
 *  Returns `all` itself when every run is already contiguous, so a caller can
 *  bail on identity (performance bear trap 8). */
export function gatherSubgroupRuns<T extends Tab>(all: T[]): T[] {
  const rows = all.filter(isStripRow) as T[];
  const order: T[] = [];
  const emitted = new Set<string>();
  for (const t of rows) {
    const g = memberOf(t);
    if (!g) { order.push(t); continue; }
    if (emitted.has(g.id)) continue;
    emitted.add(g.id);
    for (const m of rows) if (memberOf(m)?.id === g.id) order.push(m);
  }
  if (order.every((t, i) => t === rows[i])) return all;
  let k = 0;
  return all.map(t => (isStripRow(t) ? order[k++] : t));
}

/** Where `tabId` lands when it joins `g` (null: leaves its subgroup), and with
 *  which copy. The menu's rule:
 *  - joining places the tab right after the subgroup's last member;
 *  - leaving places it right after the run it left, so the run stays whole;
 *  - a lone member leaving, or a tab founding `g` (no other member yet),
 *    stays where it is, except that a pinned tab is unpinned and so moves to
 *    the first slot after the pinned block, and a member of another run
 *    first steps out past that run.
 *  Returns `all` itself when nothing changes. */
export function reseatForSubgroup<T extends Tab>(all: T[], tabId: string, g: TabSubgroup | null): T[] {
  const idx = all.findIndex(t => t.id === tabId);
  if (idx < 0) return all;
  const tab = all[idx];
  if (!isStripRow(tab)) return all;
  const cur = memberOf(tab);
  if (g && cur?.id === g.id) {
    // Same subgroup: only refresh a disagreeing copy, in place.
    return sameSubgroup(tab.subgroup, g) ? all : all.map(t => (t.id === tabId ? withSubgroup(t, g) : t));
  }
  if (!g && !cur) {
    // Nothing to leave. A stray copy on a pinned tab is still cleaned up.
    return tab.subgroup ? all.map(t => (t.id === tabId ? withSubgroup(t, null) : t)) : all;
  }
  const moved = withSubgroup(tab, g);
  const without = all.filter(t => t.id !== tabId);
  const lastIndexOf = (id: string) => {
    let at = -1;
    without.forEach((t, i) => { if (memberOf(t)?.id === id) at = i; });
    return at;
  };
  let at = -1;
  if (g) {
    const end = lastIndexOf(g.id);
    if (end >= 0) at = end + 1;
  }
  if (at < 0 && cur) {
    // Leaving (or founding from inside another run): step past the old run.
    const end = lastIndexOf(cur.id);
    if (end >= 0) at = end + 1;
  }
  if (at < 0 && tab.pinned && g) {
    // Unpinned by joining: first slot after the main strip's pinned block.
    // Every main-strip pill can be pinned (an edit or diff tab too), so the
    // block ends after the last pinned tab of ANY type outside a split pane.
    let pinEnd = 0;
    without.forEach((t, i) => { if (!t.paneId && t.pinned) pinEnd = i + 1; });
    at = pinEnd;
  }
  if (at < 0) return all.map(t => (t.id === tabId ? moved : t));
  return [...without.slice(0, at), moved, ...without.slice(at)];
}

/** The tab strip's drop rule: position decides membership (docs/ui.md "Tab
 *  subgroups"). `rows` are the main strip's terminal tabs AFTER the drop.
 *  - landing between two members of one subgroup joins it;
 *  - a member still touching its own run (or alone in it) stays;
 *  - a member dropped away from its run leaves;
 *  - a loose tab at the edge of a run stays loose: only "between two members"
 *    joins, so dragging past a block never sweeps a tab into it.
 *  A pinned tab is never a member. */
export function stripMembership(rows: readonly Tab[], tabId: string): TabSubgroup | null {
  const i = rows.findIndex(t => t.id === tabId);
  if (i < 0) return null;
  const tab = rows[i];
  if (!isStripRow(tab) || tab.pinned) return null;
  const prev = i > 0 ? memberOf(rows[i - 1]) : null;
  const next = i + 1 < rows.length ? memberOf(rows[i + 1]) : null;
  if (prev && next && prev.id === next.id) return prev;
  const cur = memberOf(tab);
  if (!cur) return null;
  if (prev?.id === cur.id || next?.id === cur.id) return cur;
  const others = rows.some(t => t.id !== tabId && memberOf(t)?.id === cur.id);
  return others ? null : cur;
}

/** One of each work mark the given (hidden) members' rows would draw: what a
 *  collapsed subgroup's caption carries. Each tab is asked on its own, the
 *  row's own rule, through the task-group helper. */
export const subgroupBadgeKinds = (
  members: readonly Tab[],
  prefs: WorkStatePrefs,
  partialPref: boolean,
): GroupBadgeKind[] => groupBadgeKinds(members.map(t => [t]), prefs, partialPref);

/** Colour for a subgroup being founded in this task: the first accent no
 *  subgroup of the task already wears (task groups' founding order). */
export function nextSubgroupColor(tabs: readonly Tab[]): string {
  const live = taskSubgroups(tabs);
  return pickFoundingColor(new Set(live.flatMap(g => (g.color ? [g.color] : []))), live.length);
}

/** Every subgroup id the given tab lists carry: what `loadAll` keeps the
 *  fold state for. */
export function subgroupIdsIn(lists: Iterable<readonly { subgroup?: TabSubgroup }[] | undefined>): Set<string> {
  const out = new Set<string>();
  for (const list of lists) for (const t of list ?? []) if (t.subgroup) out.add(t.subgroup.id);
  return out;
}
