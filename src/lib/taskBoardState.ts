// Board view: which column a task's card sits in, and which swimlanes exist.
//
// The third consumer of taskWorkState.ts (after Sidebar and Dashboard),
// documented in docs/ui.md "Board view". The columns are DERIVED, never stored: the
// terminal is the ground truth, so a card can never drift from what the agent
// is actually doing (no `status` field on Task, by design).
//
// Kept pure and hook-free so the precedence matrix is unit-testable without
// mounting the board, and so BoardView stays a thin renderer over this file.

import type { Agent, Tab, Task } from "./types";
import {
  taskNeedsAttention,
  taskWorking,
  type WorkStatePrefs,
} from "./taskWorkState";

/** The columns, in display order: the kanban lifecycle, attention pinned to
 *  the front. "archived" is rendered separately (it ignores swimlanes) but is
 *  part of the same derivation so the override-everything rule lives in
 *  exactly one place. */
export type BoardColumn = "backlog" | "attention" | "working" | "review" | "settled" | "archived";

export const BOARD_STATE_COLUMNS = ["backlog", "attention", "working", "review", "settled"] as const;
export type BoardStateColumn = (typeof BOARD_STATE_COLUMNS)[number];

/** The slice of the live PR snapshot the review column needs. Matches
 *  `PrLookup` in types.ts structurally so callers can pass the `usePr` entry's
 *  lookup straight in without this module importing the store. */
export interface BoardPrInfo {
  pr: { state: string | null } | null;
}

/** No terminal tab holds ANY work evidence this session: `workState` was
 *  never classified (the state machine skips the idle write on a fresh
 *  spawn's idle-glyph title, so undefined means "no turn has ever run"),
 *  and the user never submitted input (`lastInputAt` null). A tab the user
 *  watched finishing downgrades done -> an explicit "idle" WRITE, which is
 *  evidence and keeps the task out of here.
 *
 *  Session-scoped by design: these fields die with the process, so a task
 *  that worked in a previous app session and has not been visited since
 *  shows as backlog until it is opened. That is the same honesty as the
 *  done badge, which also does not survive a restart; persisting a
 *  "has worked" flag would be a stored status, which the board rules out. */
export function taskUntouched(tabs: Tab[]): boolean {
  return !tabs.some(t => t.type === "terminal" && (t.workState != null || t.lastInputAt != null));
}

/** What the column derivation reads from a task's tabs, RAW: no pref applied.
 *  Split out so a caller that must not hold `tabs` (the sidebar's status
 *  section, which would otherwise re-render on every timestamp) can cache
 *  three booleans per task and still go through the one precedence below. */
export interface BoardTaskFacts {
  readonly attention: boolean;
  readonly working: boolean;
  readonly untouched: boolean;
}

// Both helpers apply their prefs; these make them report the raw fact. The
// gates are re-applied in boardColumnFromFacts, against the caller's prefs.
const RAW_PREFS: WorkStatePrefs = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };

export function boardTaskFacts(tabs: Tab[]): BoardTaskFacts {
  return {
    attention: taskNeedsAttention(tabs, RAW_PREFS),
    working: taskWorking(tabs, RAW_PREFS),
    untouched: taskUntouched(tabs),
  };
}

/** Which column a task belongs in. Precedence, top wins:
 *
 *    archived          -> archived        (overrides everything)
 *    needs attention   -> attention       (agent blocked on the user)
 *    working           -> working         (agent mid-turn)
 *    PR open or draft  -> review          (main checkouts never poll PRs)
 *    no work evidence  -> backlog         (spawned, nobody asked anything)
 *    everything else   -> settled         (a turn finished, or a stale one)
 *
 *  A merged or closed PR falls THROUGH (to backlog or settled): the review
 *  column answers "waiting on a reviewer", and a merged PR is not. An
 *  unfetched PR (lookup null) counts as review while its identity is
 *  persisted — the poller will resolve it shortly, and a card that flickers
 *  settled -> review on every board open is worse than a briefly optimistic
 *  column. */
export function taskBoardColumn(
  task: Task,
  tabs: Tab[],
  pr: BoardPrInfo | null | undefined,
  prefs: WorkStatePrefs,
): BoardColumn {
  return boardColumnFromFacts(task, boardTaskFacts(tabs), pr, prefs);
}

/** The precedence itself, over pre-computed facts. The board reaches it
 *  through taskBoardColumn and the sidebar's status section directly; there
 *  is no second copy. The pref gates match taskNeedsAttention (attention
 *  absent = on) and taskWorking (working absent = off). */
export function boardColumnFromFacts(
  task: Task,
  facts: BoardTaskFacts,
  pr: BoardPrInfo | null | undefined,
  prefs: WorkStatePrefs,
): BoardColumn {
  if (task.archived) return "archived";
  if ((prefs.attentionIndicator ?? true) && facts.attention) return "attention";
  if (!!prefs.workingIndicator && facts.working) return "working";
  // Same gate as `pollableTasks` in store/pr.ts: identity persisted on the
  // task, and never for a main checkout (nothing polls those, so a stale
  // pr_url there would pin the card in review forever).
  if (!task.is_main_checkout && (task.pr_url || task.pr_number != null)) {
    const state = pr?.pr?.state ?? null;
    if (state === null || state === "open" || state === "draft") return "review";
  }
  if (facts.untouched) return "backlog";
  return "settled";
}

/** The Archived column's render list, most recent first. History and the
 *  sidebar's Resume submenu sort the same way (`archived_at ?? created`,
 *  latest wins); the board adds a cap because the column renders every card
 *  at full height with no virtualization, and a few hundred archived tasks
 *  would cost the board its open time. The badge keeps the full count, so
 *  the cap bounds the DOM, never the truth. */
export function recentArchived(tasks: Task[], limit: number): Task[] {
  return tasks
    .filter(w => w.archived)
    .sort((a, b) => (b.archived_at ?? b.created).localeCompare(a.archived_at ?? a.created))
    // Infinity (the "unlimited" mode) must read as "everything", so the
    // non-finite branch passes tasks.length — slice(0, 0) here once rendered
    // an empty Archived column under a badge showing the full count.
    .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : tasks.length);
}

export type BoardArchiveLimitMode = "default" | "unlimited" | "custom";
export const BOARD_ARCHIVE_LIMIT_DEFAULT = 25;

/** Storage strings are untyped; anything unknown reads as the default
 *  (same contract as `parseLanguagePref` for the language pref). */
export function parseBoardArchiveLimitMode(v: string): BoardArchiveLimitMode {
  return v === "unlimited" || v === "custom" ? v : "default";
}

/** The Archived column's effective cap: the factory default, everything
 *  (Infinity passes straight through `recentArchived`'s slice), or the
 *  number the user typed, taken as-is. Not a clamp: the custom value has
 *  no bounds by design. recentArchived makes nonsense well-defined
 *  (anything below one renders nothing) without ever second-guessing a
 *  number the user actually entered. */
export function resolveBoardArchiveLimit(mode: BoardArchiveLimitMode, custom: number): number {
  if (mode === "unlimited") return Number.POSITIVE_INFINITY;
  if (mode === "custom") return Number.isFinite(custom) ? custom : 0;
  return BOARD_ARCHIVE_LIMIT_DEFAULT;
}

// ── Drop commands ("drag as command") ────────────────────────────────────
//
// Columns are derived and never stored, so a drag onto a column cannot SET a
// status. What a drop can do is perform the real action that column stands
// for; the derivation then moves the card on its own. The guard below is the
// SAME one the focus clear in store/app.ts uses - moved here so board and
// focus share one implementation and this module stays store-free (the caller
// passes `agentHooksInstalled` as plain data).

/** Can a user gesture (focus, or the board's drop-on-Settled) clear a
 *  "working" state? Only for agents whose state is READ from their terminal:
 *  for an agent that reports its own state via hooks the spinner is live
 *  truth, and clearing it destroyed state nothing put back for the rest of
 *  the turn. */
export function visitMayClearWorking(hooksInstalled: Record<string, boolean>, cli: string | undefined): boolean {
  return !(cli && hooksInstalled[cli] === true);
}

/** Does this task hold anything a "mark settled" drop would clear? Attention
 *  counts: `unread` is what the attention column derives from, so clearing it
 *  is what lets the card fall through to Settled. */
export function taskHasClearableWork(tabs: Tab[], hooksInstalled: Record<string, boolean>): boolean {
  return tabs.some(t => t.type === "terminal"
    && (t.unread != null
        || t.workState === "done"
        || (t.workState === "working" && visitMayClearWorking(hooksInstalled, t.cli))));
}

export type BoardDropCommand =
  | { kind: "archive" }
  | { kind: "settle" }
  | { kind: "createPr" };

/** What a drop of `task` (sitting in `source`) onto `target` means. Null =
 *  not a drop target, the card snaps back. Cross-column drops only: a drop
 *  inside the origin group is a reorder the caller resolves first, so
 *  settled->settled and review->review never read as commands.
 *
 *  - archived -> archive, through the shared confirmAndArchive flow
 *  - settled  -> the focus-clear write on every terminal tab ("I've seen
 *    this"), only when there is something to clear
 *  - review   -> open CreatePrDialog, gated the same way the review column
 *    itself is: a main checkout never polls a PR, so a created one could
 *    never move the card out of here again */
export function boardDropCommand(
  source: BoardColumn,
  target: BoardColumn,
  task: Task,
  tabs: Tab[],
  hooksInstalled: Record<string, boolean>,
): BoardDropCommand | null {
  if (target === "archived") return { kind: "archive" };
  if (target === source) return null;
  if (target === "settled") {
    return taskHasClearableWork(tabs, hooksInstalled) ? { kind: "settle" } : null;
  }
  if (target === "review") {
    return task.is_main_checkout ? null : { kind: "createPr" };
  }
  return null;
}

/** Swimlane order: the agent registry's order first (built-ins lead, and a
 *  user who reordered their agents sees the same order here), then any cli id
 *  the registry does not know (a task outliving a deleted custom agent),
 *  alphabetical. Only lanes with at least one live task exist at all — an
 *  empty swimlane is height spent on nothing. */
export function boardLanes(tasks: Task[], agents: Agent[]): string[] {
  const present = new Set(tasks.filter(t => !t.archived).map(t => t.cli));
  const known = agents.map(a => a.id).filter(id => present.has(id));
  const unknown = [...present].filter(id => !agents.some(a => a.id === id)).sort();
  return [...known, ...unknown];
}

/** Stable ordering inside one cell: cards are grouped by project (project
 *  array order), and within a project they keep the store's task order —
 *  the same order the sidebar shows, which Rust sorts on the manual drag
 *  `order` then `created`. Reordering inside a group is the ONLY reorder the
 *  board allows, because `task_reorder`'s contract is same-project ids. */
export function boardCellGroups(cellTasks: Task[], projectOrder: string[]): { projectId: string; tasks: Task[] }[] {
  const byProject = new Map<string, Task[]>();
  for (const t of cellTasks) {
    const list = byProject.get(t.project_id);
    if (list) list.push(t);
    else byProject.set(t.project_id, [t]);
  }
  return [...byProject.entries()]
    .map(([projectId, tasks]) => ({ projectId, tasks }))
    .sort((a, b) => {
      const ai = projectOrder.indexOf(a.projectId);
      const bi = projectOrder.indexOf(b.projectId);
      // Unknown project (deleted mid-session): sink to the bottom, keep
      // relative order stable.
      return (ai === -1 ? projectOrder.length : ai) - (bi === -1 ? projectOrder.length : bi);
    });
}

/** Merge the drag preview's order for one same-project group back into the
 *  project's full id list: non-group tasks keep their relative positions and
 *  the group lands where its first member sat — the shape the board's drop
 *  handler and the sidebar drag both write through `task_reorder`.
 *
 *  Returns null when the preview has gone stale against `projIds`: any id
 *  the task list no longer holds (archived, deleted or moved project while
 *  the drag was in flight), or a group with no members left. Writing a stale
 *  merge anyway once consumed store slots with dead ids — a live card
 *  vanished from `tasks`, or `undefined` itself did and the next render
 *  threw on it. Null is the caller's cue to snap back. */
export function mergeReorderedGroup(projIds: string[], previewIds: string[]): string[] | null {
  const live = new Set(projIds);
  if (!previewIds.every(id => live.has(id))) return null;
  const groupSet = new Set(previewIds);
  const merged: string[] = [];
  let inserted = false;
  for (const id of projIds) {
    if (groupSet.has(id)) {
      if (!inserted) { merged.push(...previewIds); inserted = true; }
      continue;
    }
    merged.push(id);
  }
  // Every group member gone mid-drag: nothing left to place the preview at.
  return inserted ? merged : null;
}

/** Columns the user has chosen to keep on the board even when they are empty.
 *
 *  A pin used to be component state ("show me that one now"), which meant it
 *  died the moment BoardView unmounted: click a column open in the Inactive
 *  list, switch away from Kanban and back, and it was gone again. Reported as
 *  "quite random", which is what a lifetime you cannot see looks like. It is a
 *  SETTING now, so the question it answers is "which columns do I always want
 *  on this board", not "which one am I looking at right now".
 *
 *  Parsed defensively because it comes back from localStorage, where anything
 *  can be: a hand-edited value, a column id from a future version, a duplicate
 *  written by a older build. Unknown ids are dropped rather than rendered as
 *  an empty column nothing can ever fill, and the result is always in board
 *  order so a pin cannot reorder the board. */
export function parseBoardPinnedColumns(raw: string | null | undefined): BoardStateColumn[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const wanted = new Set(parsed.filter((c): c is string => typeof c === "string"));
  // Filtering the canonical list, rather than the input, gives dedupe and
  // board order for free.
  return BOARD_STATE_COLUMNS.filter(c => wanted.has(c));
}

/** Whether a shown column offers a "hide this" button.
 *
 *  Only a PINNED and EMPTY column does. A column with tasks in it is on screen
 *  because it has work, not because of the pin, so hiding it would drop cards
 *  out of sight: that is the one thing the board must not do. An unpinned
 *  empty column cannot be showing at all (it would be in the Inactive list),
 *  so the button would be unreachable anyway; the check is written out because
 *  the two conditions mean different things and only one of them is obvious. */
export function boardColumnCanHide(
  column: BoardStateColumn,
  pinned: readonly BoardStateColumn[],
  taskCount: number,
): boolean {
  return taskCount === 0 && pinned.includes(column);
}
