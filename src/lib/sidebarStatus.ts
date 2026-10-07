// The sidebar's status section: which tasks it lists, under which bucket, in
// which order (docs/ui.md "The sidebar's status section").
//
// A bucket IS a board column. Every task's bucket comes from
// boardColumnFromFacts, the precedence the Kanban board uses, so the two
// surfaces cannot disagree; a bucket that looks wrong here is a change to
// taskBoardState.ts, and the board moves with it. Nothing is stored.
//
// Pure and store-free on purpose (the pr store's import chain touches the DOM
// at module scope): the caller passes the PR snapshot in as plain data.

import type { Project, Task, TaskGroup } from "./types";
import { visualProjectOrder } from "./projectGroups";
import { crossProjectStrays, layoutTaskList } from "./taskGroups";
import {
  boardColumnFromFacts,
  type BoardPrInfo,
  type BoardStateColumn,
  type BoardTaskFacts,
} from "./taskBoardState";
import type { WorkStatePrefs } from "./taskWorkState";

/** Display order: attention first, because it is the reason the section
 *  exists, then the lifecycle. Archived is not a bucket: it lives in History
 *  and on the board. */
export const STATUS_BUCKETS = ["attention", "working", "review", "settled", "backlog"] as const satisfies readonly BoardStateColumn[];
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/** The two buckets that show a count and nothing else until opened: Settled
 *  is the largest and least urgent, and Not started is session-scoped (after
 *  a relaunch every unopened task sits there), so both are mostly noise. */
const COUNT_ONLY: ReadonlySet<StatusBucket> = new Set(["settled", "backlog"]);

export function statusBucketCollapsedByDefault(bucket: StatusBucket): boolean {
  return COUNT_ONLY.has(bucket);
}

/** Only the buckets the user has toggled are stored; the rest follow
 *  statusBucketCollapsedByDefault. */
export type StatusBucketCollapsed = Readonly<Partial<Record<StatusBucket, boolean>>>;

export function isStatusBucketCollapsed(bucket: StatusBucket, overrides: StatusBucketCollapsed): boolean {
  return overrides[bucket] ?? statusBucketCollapsedByDefault(bucket);
}

/** Parsed defensively because it comes back from localStorage: anything that
 *  is not a known bucket with a boolean is dropped, so a hand-edited or
 *  future value falls back to the default instead of rendering nonsense. */
export function parseStatusBucketCollapsed(raw: string | null | undefined): StatusBucketCollapsed {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Partial<Record<StatusBucket, boolean>> = {};
  for (const b of STATUS_BUCKETS) {
    const v = (parsed as Record<string, unknown>)[b];
    if (typeof v === "boolean") out[b] = v;
  }
  return out;
}

/** A set of ids kept as `{ [id]: true }`, for the section's own fold state:
 *  rows expanded to their agent tabs (`StatusTaskExpanded`) and group
 *  captions folded (`StatusGroupCollapsed`). Its own maps, never the tree's
 *  collapse state, so folding something here never folds the tree. Parsed
 *  defensively from localStorage: only `true` values survive. */
export type IdFlags = Readonly<Record<string, true>>;
export type StatusTaskExpanded = IdFlags;
export type StatusGroupCollapsed = IdFlags;

export function parseIdFlags(raw: string | null | undefined): IdFlags {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (v === true) out[k] = true;
  return out;
}

/** The next map after a toggle, or the SAME map when nothing changes (so the
 *  setter can bail). Ids no longer in `liveIds` are dropped on the way, so
 *  archived tasks and dissolved groups do not pile up in localStorage. */
export function nextIdFlags(
  cur: IdFlags, id: string, on: boolean, liveIds: readonly string[],
): IdFlags {
  const live = new Set(liveIds);
  const stale = Object.keys(cur).some(k => !live.has(k));
  if (!!cur[id] === on && !stale) return cur;
  const next: Record<string, true> = {};
  for (const k of Object.keys(cur)) if (live.has(k) && k !== id) next[k] = true;
  if (on) next[id] = true;
  return next;
}

/** A task whose tabs never loaded this session: no evidence of anything, the
 *  same reading the board gives `EMPTY_TABS`. */
const UNLOADED: BoardTaskFacts = Object.freeze({ attention: false, working: false, untouched: true });

/** One thing a bucket draws: a loose task, or a task group with its members
 *  (the tree's own grouping, in its own colour). */
export type StatusItem =
  | { kind: "task"; task: Task }
  | { kind: "group"; group: TaskGroup; tasks: Task[] };

export interface StatusBucketGroup {
  bucket: StatusBucket;
  items: StatusItem[];
  /** Task rows, group members included: what the bucket's count says. */
  count: number;
}

/** The section's contents: non-empty buckets in display order, each holding
 *  its items in TREE order: the sidebar's visual project order (which the
 *  keyboard walks too), then each project's rows as the tree lays them out.
 *  An item never shuffles inside its bucket; it moves only when its bucket
 *  changes.
 *
 *  A task group stays ONE unit, as it is in the tree: drawn whole, in the
 *  bucket of its most urgent member (display order is urgency order). Every
 *  member keeps its own badge, so the row that put the group there says so.
 *  This is a layout rule over the board's buckets, not a state: each task's
 *  own bucket is still boardColumnFromFacts, unchanged. Cross-project
 *  batches (a spawn tree via `spawned_by`) are the same rule one level up,
 *  and not built yet.
 *
 *  Walks projects rather than tasks, so a task whose project is not in this
 *  profile's list is skipped exactly as the tree skips it. */
export function statusBuckets(
  projects: Project[],
  tasks: Task[],
  facts: Readonly<Record<string, BoardTaskFacts>>,
  prByTask: Readonly<Record<string, { lookup: BoardPrInfo | null } | undefined>>,
  prefs: WorkStatePrefs,
): StatusBucketGroup[] {
  const byProject = new Map<string, Task[]>();
  for (const w of tasks) {
    if (w.archived) continue;
    const list = byProject.get(w.project_id);
    if (list) list.push(w);
    else byProject.set(w.project_id, [w]);
  }
  // The tree's own layout: the same strays it draws as plain rows (a legacy
  // cross-project group), and the same grouping for everything else.
  const strays = crossProjectStrays(tasks);
  const groupFor = (t: Task) => (strays.has(t.id) ? null : t.group ?? null);
  const bucketOf = (w: Task): StatusBucket | null => {
    const column = boardColumnFromFacts(w, facts[w.id] ?? UNLOADED, prByTask[w.id]?.lookup ?? null, prefs);
    // Unreachable (archived tasks were skipped above), but the type allows
    // it, and dropping a task is better than inventing a bucket for it.
    return column === "archived" ? null : column;
  };
  const rank = (b: StatusBucket) => STATUS_BUCKETS.indexOf(b);
  const buckets = new Map<StatusBucket, { items: StatusItem[]; count: number }>(
    STATUS_BUCKETS.map(b => [b, { items: [], count: 0 }]));
  const place = (bucket: StatusBucket, item: StatusItem, rows: number) => {
    const into = buckets.get(bucket)!;
    into.items.push(item);
    into.count += rows;
  };
  for (const p of visualProjectOrder(projects)) {
    for (const seg of layoutTaskList(byProject.get(p.id) ?? [], groupFor)) {
      if (seg.kind === "task") {
        const b = bucketOf(seg.task);
        if (b) place(b, { kind: "task", task: seg.task }, 1);
        continue;
      }
      let most: StatusBucket | null = null;
      for (const w of seg.tasks) {
        const b = bucketOf(w);
        if (b && (most === null || rank(b) < rank(most))) most = b;
      }
      if (most) place(most, { kind: "group", group: seg.group, tasks: seg.tasks }, seg.tasks.length);
    }
  }
  return STATUS_BUCKETS
    .map(bucket => ({ bucket, ...buckets.get(bucket)! }))
    .filter(g => g.items.length > 0);
}

/** Every task an item draws, in order. */
export function statusItemTasks(item: StatusItem): Task[] {
  return item.kind === "task" ? [item.task] : item.tasks;
}
