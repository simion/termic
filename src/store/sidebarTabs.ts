// What the sidebar reads from `tabs`, held so a tab write it does not draw
// re-renders nothing (docs/performance.md bear trap 5).
//
// Three consumers. The first two have opposite rules, because they read
// opposite amounts:
//
// - The Sidebar BODY draws a handful of per-task booleans (rollup dots, the
//   filter bell's count, the broadcast count, the filter's matches). It gets
//   exactly those as `SidebarTaskFacts`, and has no `tabs` in scope at all,
//   so a new read has to be added here as a fact. It used to select the whole
//   `tabs` map, which re-rendered the whole sidebar, every row included, on
//   every `lastOutputAt` stamp of every streaming terminal.
//
// - A TaskRow draws nearly every field of its own tabs (titles, live titles,
//   badges, run controls). It gets its tabs array, but the previous one is
//   kept while the only change is a field it never draws. That is an
//   EXCLUSION list on purpose: a field missing from it costs an extra render,
//   never a stale one.
//
// - The STATUS SECTION, or the status chips while it is off, get the board
//   column's three raw facts per task, in a record of their own (see
//   StatusTabFacts for why it is not more body facts).
//
// Selector bodies are exported so `selectorFanout.test.ts` measures these,
// not a copy.

import { useMemo, useState } from "react";
import { useApp, EMPTY_TABS, type AppState } from "@/store/app";
import { taskFilterFacts, type TaskFilterFacts } from "@/lib/taskFilter";
import {
  taskDelegatedWork, taskNeedsAttention, taskWorkBadge, taskWorkDone,
  type WorkBadgeReason, type WorkStatePrefs,
} from "@/lib/taskWorkState";
import { boardTaskFacts, type BoardTaskFacts } from "@/lib/taskBoardState";
import { groupBadgeKinds } from "@/lib/taskGroups";
import type { Tab, TerminalTab } from "@/lib/types";

// ─── Sidebar body: per-task facts ───────────────────────────────────────

export interface SidebarTaskFacts extends TaskFilterFacts {
  /** A terminal tab is blocked on the user. No pref applies: the collapsed
   *  project and group rollup dots never took the attention switch. */
  readonly attention: boolean;
  /** A terminal tab settled. Raw: the Sidebar gates it on `settledHighlight`,
   *  so a pref flip never has to re-run this selector. */
  readonly done: boolean;
  /** A live main agent, i.e. something the project broadcast would reach. */
  readonly liveDefault: boolean;
}

/** Facts per LOADED task. No entry means the tabs were never loaded this
 *  session, which the filter treats differently from "loaded, none". */
export type SidebarTabFacts = Readonly<Record<string, SidebarTaskFacts>>;

export const EMPTY_SIDEBAR_FACTS: SidebarTabFacts = Object.freeze({});

// Both helpers apply their prefs; these make them report the raw fact.
const RAW = { settledHighlight: true, attentionIndicator: true } as const;

export function computeSidebarTaskFacts(tabs: Tab[]): SidebarTaskFacts {
  return Object.freeze({
    ...taskFilterFacts(tabs),
    attention: taskNeedsAttention(tabs, RAW),
    done: taskWorkDone(tabs, RAW),
    liveDefault: tabs.some(t => t.type === "terminal"
      && !!(t as TerminalTab).is_default && !(t as TerminalTab).paneId
      && !(t as TerminalTab).runTab && !!(t as TerminalTab).ptyId),
  });
}

function sameFacts(a: SidebarTaskFacts, b: SidebarTaskFacts): boolean {
  return a.notification === b.notification
    && a.attention === b.attention
    && a.done === b.done
    && a.liveDefault === b.liveDefault
    && sameFilterFacts(a, b);
}

/** The per-task cache both fact records share: returns the SAME record until
 *  some task's facts change, and the same per-task object for every task
 *  whose facts did not. Costs O(1) on a write that leaves `tabs` alone, and
 *  one task's recompute on a `patchTab`, which replaces only that task's
 *  array. */
function createFactsSelector<F>(
  compute: (tabs: Tab[]) => F,
  same: (a: F, b: F) => boolean,
  empty: Readonly<Record<string, F>>,
): (s: AppState) => Readonly<Record<string, F>> {
  let prevTabs: AppState["tabs"] | null = null;
  let prevFacts: Readonly<Record<string, F>> = empty;
  let prevCount = 0;
  return (s) => {
    const tabs = s.tabs;
    if (tabs === prevTabs) return prevFacts;
    const next: Record<string, F> = {};
    let count = 0;
    let changed = false;
    for (const id in tabs) {
      const list = tabs[id];
      if (!list) continue;
      count++;
      const old: F | undefined = prevFacts[id];
      let facts: F;
      if (old && prevTabs && prevTabs[id] === list) {
        facts = old;
      } else {
        const fresh = compute(list);
        facts = old && same(old, fresh) ? old : fresh;
      }
      if (facts !== old) changed = true;
      next[id] = facts;
    }
    prevTabs = tabs;
    if (!changed && count === prevCount) return prevFacts;
    prevCount = count;
    prevFacts = Object.freeze(next);
    return prevFacts;
  };
}

/** One per mounted Sidebar (the hover reveal mounts two). */
export function createSidebarFactsSelector(): (s: AppState) => SidebarTabFacts {
  return createFactsSelector(computeSidebarTaskFacts, sameFacts, EMPTY_SIDEBAR_FACTS);
}

export function useSidebarTabFacts(): SidebarTabFacts {
  const [select] = useState(createSidebarFactsSelector);
  return useApp(select);
}

// ─── Kanban filter bar: the free-text facts ─────────────────────────────

/** What the board's free text reads (titles and property values), and
 *  nothing else. Not the sidebar's record: that one also changes on every
 *  attention / done / live-agent flip, which would re-render the whole board
 *  while a filter is typed for no change in what matches. */
export type BoardFilterFacts = Readonly<Record<string, TaskFilterFacts>>;

export const EMPTY_BOARD_FILTER_FACTS: BoardFilterFacts = Object.freeze({});

function sameFilterFacts(a: TaskFilterFacts, b: TaskFilterFacts): boolean {
  return a.titles.length === b.titles.length
    && a.titles.every((t, i) => t === b.titles[i])
    && a.propValues.length === b.propValues.length
    && a.propValues.every((v, i) => v === b.propValues[i]);
}

/** `notification` is left out of the compare on purpose: the board never
 *  reads it, so it may be stale in this record. */
export function createBoardFilterFactsSelector(): (s: AppState) => BoardFilterFacts {
  return createFactsSelector(
    (tabs: Tab[]) => Object.freeze(taskFilterFacts(tabs)),
    sameFilterFacts,
    EMPTY_BOARD_FILTER_FACTS,
  );
}

// ─── Status section: the board column's facts ──────────────────────────

/** A record of its own, NOT more fields on SidebarTaskFacts: the body would
 *  then re-render on every idle -> working flip of every agent. Held by
 *  useTaskQuery (the board's columns and the status chips) and by the
 *  STATUS section through useStatusTabFacts; the chips and the section are
 *  never mounted together. `untouched` reads `lastInputAt`, which is why
 *  this cannot be derived per row from useRowTabs (it holds that field
 *  back). */
export type StatusTabFacts = Readonly<Record<string, BoardTaskFacts>>;

export const EMPTY_STATUS_FACTS: StatusTabFacts = Object.freeze({});

function sameBoardFacts(a: BoardTaskFacts, b: BoardTaskFacts): boolean {
  return a.attention === b.attention && a.working === b.working && a.untouched === b.untouched;
}

export function createStatusFactsSelector(): (s: AppState) => StatusTabFacts {
  return createFactsSelector(
    (tabs: Tab[]) => Object.freeze(boardTaskFacts(tabs)),
    sameBoardFacts,
    EMPTY_STATUS_FACTS,
  );
}

export function useStatusTabFacts(): StatusTabFacts {
  const [select] = useState(createStatusFactsSelector);
  return useApp(select);
}

/** A status row draws ONE badge, so it selects the badge itself: a value,
 *  stable by Object.is, where useRowTabs would hand it a new array on every
 *  live-title rewrite (about once a second per working agent). */
export const selectStatusRowBadge = (taskId: string, prefs: WorkStatePrefs) =>
  (s: AppState): WorkBadgeReason | null => taskWorkBadge(s.tabs[taskId] ?? EMPTY_TABS, prefs);

/** The badge's delegated-work report. The object is the tab's own, so its
 *  identity holds until that report is rewritten. */
export const selectStatusRowDelegated = (taskId: string, prefs: WorkStatePrefs) =>
  (s: AppState) => taskDelegatedWork(s.tabs[taskId] ?? EMPTY_TABS, prefs);

/** A folded group caption's marks, as one string (`groupBadgeKinds`, the
 *  tree's helper), so the caption re-renders when the SET of marks changes,
 *  not on every tab write. */
export const selectStatusGroupMarks = (memberIds: readonly string[], prefs: WorkStatePrefs, partialPref: boolean) =>
  (s: AppState): string =>
    groupBadgeKinds(memberIds.map(id => s.tabs[id] ?? EMPTY_TABS), prefs, partialPref).join(",");

/** Main-pane terminal tabs, the rows the tree (and an expanded status row)
 *  lists under a task: a number, so a collapsed status row draws its `(n)`
 *  without holding the tabs. */
export const selectStatusRowTabCount = (taskId: string) =>
  (s: AppState): number => {
    let n = 0;
    for (const t of s.tabs[taskId] ?? EMPTY_TABS) if (t.type === "terminal" && !t.paneId) n++;
    return n;
  };

/** The active tab is one of this task's child rows, which then carries the
 *  selection instead of the task's row (the tree's rule). */
export const selectStatusRowActiveChild = (taskId: string) =>
  (s: AppState): boolean => {
    if (s.activeTaskId !== taskId) return false;
    const tabId = s.activeTab[taskId];
    return (s.tabs[taskId] ?? EMPTY_TABS).some(t => t.id === tabId && t.type === "terminal" && !t.paneId);
  };

// ─── TaskRow: its own tabs, minus the fields it never draws ─────────────

/** Tab fields a PTY-driven path rewrites that no sidebar row draws: the idle
 *  heuristic's timestamps. `lastOutputAt` is the hot one, stamped up to twice
 *  a second per streaming terminal (bear trap 9's 500 ms window). */
export const ROW_HIDDEN_TAB_FIELDS: ReadonlySet<string> = new Set([
  "lastOutputAt", "lastInputAt", "firstOutputAt",
]);

/** Equal for drawing purposes: every field but the hidden ones is Object.is.
 *  An absent key and an `undefined` one read the same, as they render. */
export function tabRenderEqual(a: Tab, b: Tab): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k in ra) {
    if (!ROW_HIDDEN_TAB_FIELDS.has(k) && !Object.is(ra[k], rb[k])) return false;
  }
  for (const k in rb) {
    if (!(k in ra) && !ROW_HIDDEN_TAB_FIELDS.has(k) && rb[k] !== undefined) return false;
  }
  return true;
}

export function tabListRenderEqual(a: readonly Tab[], b: readonly Tab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!tabRenderEqual(a[i], b[i])) return false;
  }
  return true;
}

/** One per mounted row. Hands back the array it last returned while the new
 *  one differs only in hidden fields, so those tab objects carry stale
 *  timestamps: fine for drawing, and every row handler acts by tab id. */
export function createRowTabsSelector(taskId: string): (s: AppState) => Tab[] {
  let prev: Tab[] | null = null;
  return (s) => {
    const next = s.tabs[taskId] ?? EMPTY_TABS;
    if (prev && tabListRenderEqual(prev, next)) return prev;
    prev = next;
    return next;
  };
}

export function useRowTabs(taskId: string): Tab[] {
  const select = useMemo(() => createRowTabsSelector(taskId), [taskId]);
  return useApp(select);
}
