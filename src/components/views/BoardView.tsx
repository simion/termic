// Kanban view (docs/ui.md "Kanban view", issue #318): a global kanban over
// every task, columns DERIVED from live state (see src/lib/taskBoardState.ts
// for the precedence). The terminal is the ground truth, so nothing here is a
// stored status and nothing a card shows can drift from the PTY.
//
// Layout follows the standard kanban skeleton (Multica's board, Trello,
// react-kanban-kit all agree): full-height columns of fixed width, each with
// its own surface one step above the page background, a header (dot + title +
// count badge) and an independently scrolling card stack. Swimlanes by agent
// are sub-dividers INSIDE a column, shown only when more than one agent has
// cards there; the same "only when it discriminates" rule hides project
// sub-headers on single-project columns.
//
// Rendering discipline (bear traps 5 and 8): the column assignment comes from
// ONE string-keyed selector (`selectBoardColumnKey`), so the view re-renders
// when a card changes column and only then; each card then subscribes to its
// own coarse tab slice (`selectTaskTabs`), the way Dashboard cards do. The
// view unmounts with the overlay, so idle cost is zero by construction.
//
// Drag discipline: hand-rolled pointer events, the same pattern as the
// sidebar's task reorder. Columns are derived, never stored, so a drop cannot
// SET a status; instead a cross-column drop is a COMMAND (the "drag as
// command" model, docs/ui.md "Kanban view"): reorder within the origin group
// (settle -> `task_reorder`, whose Rust contract is same-project ids),
// drop-to-archive (-> the shared `confirmAndArchive`, inheriting its confirm
// dialog and spinner), drop-on-Settled (-> `clearTaskWorkState`, the
// focus-clear write on every terminal tab) and drop-on-In-review (->
// CreatePrDialog, the same entry the command palette uses). Everything else
// snaps back without a write, and so does a command that would be a no-op
// (nothing to clear, main checkout): the matrix lives in
// boardDropCommand() in src/lib/taskBoardState.ts.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Check, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, X, Zap } from "lucide-react";
import { EMPTY_TABS, selectTaskTabs, useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import { useDiffStat } from "@/store/diffStat";
import { prBadgeAppearance } from "@/lib/prBadgeAppearance";
import { openPath } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { BoardFilterBar } from "@/components/views/BoardFilterBar";
import { COL_ACCENT, COL_LABEL, useBoardColumnMap, useTaskQuery } from "@/hooks/useTaskQuery";
import { toggleBoardClause, type BoardQualifier } from "@/lib/boardFilter";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { DockerSandboxIcon, SandboxIcon, sandboxModeText } from "@/components/SandboxIcon";
import { taskLabel } from "@/lib/taskLabel";
import { taskWorkBadge, type WorkStatePrefs } from "@/lib/taskWorkState";
import {
  BOARD_STATE_COLUMNS,
  boardCellGroups,
  boardColumnCanHide,
  boardDropCommand,
  boardLanes,
  mergeReorderedGroup,
  recentArchived,
  resolveBoardArchiveLimit,
  type BoardColumn,
  type BoardStateColumn,
} from "@/lib/taskBoardState";
import { agentDisplayName, isTerminalCli } from "@/lib/agents";
import { confirmAndArchive } from "@/lib/archiveTask";
import { taskReorder } from "@/lib/ipc";
import { forgeName } from "@/lib/forge";
import { effectiveSandboxMode, isSandboxEnforced } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Agent, MemberPrLookup, Project, Tab, Task, TaskDiffStat, TerminalTab } from "@/lib/types";
import type { TFunction } from "i18next";

/** Everything a card needs that is the SAME for every card, hoisted so N
 *  cards do not hold N subscriptions to the same slices (Dashboard's
 *  TaskRowContext pattern). */
interface CardContext {
  agents: Agent[];
  useBranchAsTaskName: boolean;
  workPrefs: WorkStatePrefs;
}

type DragTarget =
  | { kind: "archive" }
  | { kind: "settle" }
  | { kind: "createPr" }
  | { kind: "reorder" }
  | null;

interface DragSnapshot {
  taskId: string;
  x: number;
  y: number;
  grabDX: number;
  grabDY: number;
  width: number;
  target: DragTarget;
  // Which commands THIS card's drop could ever run, fixed at drag start so
  // the settled/review columns can advertise their hint for the whole drag.
  canSettle: boolean;
  canCreatePr: boolean;
}

/** The origin group's live reorder preview. Keyed by GROUP (project + lane +
 *  column), never by project alone: groups of one project share the
 *  projectId across every lane and column, and a preview applied there
 *  matched none of the ids — the other group's cards all vanished and its
 *  ring lit as a drop target the whole drag. */
interface ReorderPreview {
  projectId: string;
  lane: string;
  column: BoardStateColumn;
  ids: string[];
}

// Stable identities for the four targets (bear trap 8's shape, applied to
// props): setDrag writes a fresh snapshot per pointermove, and the memoized
// columns below only skip a render while every prop keeps its identity. One
// shared object per kind means a move that changes just the ghost's x/y
// leaves the dragTarget prop referentially untouched. A kind names exactly
// one column (settle only from Settled, createPr only from In review), so
// the kind is the whole identity.
const ARCHIVE_TARGET: DragTarget = { kind: "archive" };
const SETTLE_TARGET: DragTarget = { kind: "settle" };
const CREATE_PR_TARGET: DragTarget = { kind: "createPr" };
const REORDER_TARGET: DragTarget = { kind: "reorder" };

/** State and Archived columns: a 280px floor that never shrinks (so a
 *  narrow window scrolls), growing to share the free width, capped so one
 *  column on an ultrawide does not turn into a 1000px card. Inactive stays
 *  a fixed narrow rail: it holds names, not cards. `contain:inline-size`
 *  keeps a column's intrinsic width at that floor: the row is `w-max`,
 *  which sizes from each column's max-content, and a long nowrap card
 *  title would otherwise widen its own column past the rest. */
const COLUMN_SIZE = "min-w-[280px] max-w-[520px] flex-[1_0_280px] [contain:inline-size]";

/** Click-to-filter callback: toggles `key:value` in the query text. */
type OnFilter = (key: BoardQualifier, value: string) => void;

function ageLabel(created: string, t: TFunction): string {
  const mins = Math.max(1, Math.floor((Date.now() - new Date(created).getTime()) / 60000));
  if (mins < 60) return t("board.ageMinutes", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("board.ageHours", { count: hours });
  return t("board.ageDays", { count: Math.floor(hours / 24) });
}

export function BoardView() {
  const { t } = useTranslation("chrome");
  const tasks       = useApp(s => s.tasks);
  const projects    = useApp(s => s.projects);
  const agents      = useApp(s => s.agents);
  const setView     = useApp(s => s.setView);
  const settledHighlight  = usePrefs(s => s.settledHighlight);
  const workingIndicator  = usePrefs(s => s.workingIndicator);
  // attentionIndicator is optional in WorkStatePrefs (upstream split it out
  // of settledHighlight); reading it here keeps the board's attention column
  // under the same toggle that gates the bell everywhere else.
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const boardArchiveLimitMode = usePrefs(s => s.boardArchiveLimitMode);
  const boardArchiveLimitCustom = usePrefs(s => s.boardArchiveLimit);
  // Stable identities: ctx and projectAccent flow into every memoized card
  // and column below, and a fresh object here would defeat the memo on
  // every BoardView render (one per pointermove during a drag).
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );

  // The filter bar (docs/ui.md "Kanban view" > Filtering). The query
  // engine is useTaskQuery, shared with the sidebar's bar; it is called
  // below, once the task lists it matches over exist.
  const boardQuery = useUI(s => s.boardQuery);
  const setBoardQuery = useUI(s => s.setBoardQuery);
  const [menuOpen, setMenuOpen] = useState(false);

  // Re-render trigger for PR polls, nothing more. The pr store lives outside
  // useApp precisely so its 60s tick re-renders nobody by default; the board
  // opts back in because an open -> merged transition moves a card. The
  // value itself is unused: selectBoardColumnKey reads the snapshot, and
  // useSyncExternalStore re-reads it during the render this triggers.
  usePr(s => Object.values(s.byTask).map(e => e.lookup?.pr?.state ?? "?").join("|"));

  const columnOf = useBoardColumnMap(tasks, workPrefs, true);

  const projectOrder = useMemo(() => projects.map(p => p.id), [projects]);
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  // A task whose project is not in this profile's list is skipped, exactly as
  // every other surface skips it: the sidebar renders tasks BY WALKING
  // PROJECTS, so such a task is invisible there, while the board enumerates
  // tasks and so was the only place it appeared. It appeared badly, too, with
  // the group header falling back to printing the raw project UUID at the
  // user (reported from a screenshot: "5F117239-3B68-...", CSS-uppercased like
  // a project name). Agreeing with the sidebar is the fix; the header's
  // fallback below is now only a belt-and-braces label.
  const known = useCallback(
    (w: Task) => projectById.has(w.project_id),
    [projectById],
  );
  const allLiveTasks = useMemo(() => tasks.filter(w => !w.archived && known(w)), [tasks, known]);
  const allArchived = useMemo(() => tasks.filter(w => w.archived && known(w)), [tasks, known]);

  // The query applies here, where the data enters, so cells, counts and
  // drag groups derive from the filtered lists. STRUCTURE does not: which
  // columns and lanes exist comes from the unfiltered lists below, so typing
  // never reflows the board and a lane divider survives its own filter.
  // Archived filters too, BEFORE the cap, so a search can surface an old
  // archived task the cap would otherwise hide.
  const { query, filtering, matches: matchesQuery, sections: filterSections, valuesFor, projectAccent } = useTaskQuery({
    text: boardQuery, menuOpen, live: allLiveTasks, archived: allArchived, columnOf,
  });
  // useSameItems: a keystroke that matches the same cards keeps the same
  // array, so the memoized columns below skip the render.
  const liveTasks = useSameItems(useMemo(
    () => (filtering ? allLiveTasks.filter(matchesQuery) : allLiveTasks),
    [filtering, allLiveTasks, matchesQuery],
  ));
  // Lanes come from the profile's live tasks, not `tasks`: a lane kept alive
  // only by a task whose project left the profile (the `known` filter, the
  // same invisibility every other surface applies) once forced agent
  // dividers onto columns whose visible cards were one agent. Not from the
  // QUERY's result either: `agent:x` would leave one lane, drop the divider
  // that wrote it, and with it the click that takes it back out.
  const lanes = useMemo(() => boardLanes(allLiveTasks, agents), [allLiveTasks, agents]);
  // The full archived list feeds the badge and the empty state; the column
  // renders the capped, most-recent-first slice (Tasks > archive limit).
  const archivedAll = useSameItems(useMemo(
    () => (filtering ? allArchived.filter(matchesQuery) : allArchived),
    [filtering, allArchived, matchesQuery],
  ));
  const archivedTasks = useMemo(
    () => recentArchived(archivedAll, resolveBoardArchiveLimit(boardArchiveLimitMode, boardArchiveLimitCustom)),
    [archivedAll, boardArchiveLimitMode, boardArchiveLimitCustom],
  );
  /** Columns the user keeps on the board even when they are empty. A PREF,
   *  not view state: as component state the pin died with the unmount, so
   *  clicking a column open and then leaving Kanban and coming back lost it,
   *  which is what "it disappears again, quite random" was. */
  const pinnedCols = usePrefs(s => s.boardPinnedColumns);
  const setBoardPinnedColumns = usePrefs(s => s.setBoardPinnedColumns);
  const pinColumn = useCallback(
    (c: BoardStateColumn) => setBoardPinnedColumns(
      pinnedCols.includes(c) ? pinnedCols : [...pinnedCols, c],
    ),
    [pinnedCols, setBoardPinnedColumns],
  );
  const unpinColumn = useCallback(
    (c: BoardStateColumn) => setBoardPinnedColumns(pinnedCols.filter(x => x !== c)),
    [pinnedCols, setBoardPinnedColumns],
  );
  const colTasks = useMemo(() => {
    const cols: Record<BoardStateColumn, Task[]> = { backlog: [], attention: [], working: [], review: [], settled: [] };
    for (const w of liveTasks) {
      const c = columnOf.get(w.id);
      if (c && c !== "archived") cols[c].push(w);
    }
    return cols;
  }, [liveTasks, columnOf]);
  /** Per-column counts with NO query. Which columns are on the board is
   *  decided from these, so typing never folds a column into Inactive and
   *  reflows the board under the user mid-keystroke: a column the query
   *  emptied stays put and reads 0. */
  const unfilteredCounts = useMemo(() => {
    const n: Record<BoardStateColumn, number> = { backlog: 0, attention: 0, working: 0, review: 0, settled: 0 };
    for (const w of allLiveTasks) {
      const c = columnOf.get(w.id);
      if (c && c !== "archived") n[c]++;
    }
    return n;
  }, [allLiveTasks, columnOf]);

  const onFilter: OnFilter = useCallback(
    (key, value) => {
      const ui = useUI.getState();
      ui.setBoardQuery(toggleBoardClause(ui.boardQuery, key, value));
    },
    [],
  );

  // ── Drag: reorder within a same-project group, or drop-to-archive ─────
  //
  // The document-level listener pattern from the sidebar's task drag: the
  // listeners cannot live on the card because the pointer leaves it mid-drag.
  const [drag, setDrag] = useState<DragSnapshot | null>(null);
  const [preview, setPreview] = useState<ReorderPreview | null>(null);
  const previewRef = useRef<ReorderPreview | null>(null);
  const armedRef = useRef<{
    id: string; projectId: string; lane: string; column: BoardStateColumn;
    groupIds: string[]; x: number; y: number; started: boolean;
    grabDX: number; grabDY: number; width: number; target: DragTarget;
    canSettle: boolean; canCreatePr: boolean;
  } | null>(null);
  // A completed drop still fires a click on the card, which would activate
  // the task the user only meant to move. Same suppression pattern as the
  // sidebar's taskClickSuppressed.
  const clickSuppressed = useRef(false);

  const setPreviewBoth = useCallback((v: ReorderPreview | null) => {
    previewRef.current = v;
    setPreview(v);
  }, []);

  const onDragPointerMove = useCallback((e: PointerEvent) => {
    const armed = armedRef.current;
    if (!armed) return;
    if (!armed.started) {
      const dx = e.clientX - armed.x;
      const dy = e.clientY - armed.y;
      if (dx * dx + dy * dy < 16) return; // 4px threshold, same as the sidebar
      armed.started = true;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    let target: DragTarget = null;
    if (el?.closest("[data-board-archive]")) {
      target = ARCHIVE_TARGET;
    } else {
      const cell = el?.closest<HTMLElement>("[data-board-cell]");
      const laneEl = el?.closest<HTMLElement>("[data-board-lane]");
      const group = el?.closest<HTMLElement>("[data-board-project-group]");
      // Reorder only inside the ORIGIN group: `order` competes within one
      // project (task_reorder's contract), so a card dragged over another
      // project, lane or column has no meaningful drop and snaps back.
      if (cell && group
          && cell.dataset.column === armed.column
          && laneEl?.dataset.boardLane === armed.lane
          && group.dataset.boardProjectGroup === armed.projectId) {
        target = REORDER_TARGET;
        // First card whose midpoint is below the cursor wins; none = drop at
        // the end of the group. Midpoint rule identical to the sidebar's.
        let beforeId: string | null = null;
        for (const c of Array.from(group.querySelectorAll<HTMLElement>("[data-board-task-id]"))) {
          if (c.dataset.boardTaskId === armed.id) continue;
          const r = c.getBoundingClientRect();
          if (e.clientY < (r.top + r.bottom) / 2) { beforeId = c.dataset.boardTaskId!; break; }
        }
        const pv = previewRef.current;
        const base = pv && pv.projectId === armed.projectId
          && pv.lane === armed.lane && pv.column === armed.column
          ? pv.ids
          : armed.groupIds;
        const rest = base.filter(id => id !== armed.id);
        const insertAt = beforeId ? rest.indexOf(beforeId) : rest.length;
        const next = [...rest];
        next.splice(insertAt === -1 ? rest.length : insertAt, 0, armed.id);
        // No-op guard (bear trap 8): identical order writes nothing.
        if (next.some((id, i) => id !== base[i])) {
          setPreviewBoth({ projectId: armed.projectId, lane: armed.lane, column: armed.column, ids: next });
        }
      } else if (cell) {
        // Outside the origin group a drop on Settled / In review is a
        // command, not a status write (boardDropCommand for the matrix and
        // the gates). Everything else snaps back.
        const col = cell.dataset.column as BoardColumn | undefined;
        const w = useApp.getState().tasks.find(u => u.id === armed.id);
        if (col && w) {
          const cmd = boardDropCommand(
            armed.column, col, w,
            useApp.getState().tabs[armed.id] ?? EMPTY_TABS,
            useApp.getState().agentHooksInstalled,
          );
          if (cmd) {
            target = cmd.kind === "settle" ? SETTLE_TARGET
              : cmd.kind === "createPr" ? CREATE_PR_TARGET
              : ARCHIVE_TARGET; // unreachable: the archive element matched above
          }
        }
      }
    }
    armed.target = target;
    // Left the origin group: it is not a target ("everywhere else stays
    // quiet"), so its preview and ring go with the move. The ref guard keeps
    // this from writing state on every event while the pointer stays away.
    if (target?.kind !== "reorder" && previewRef.current) setPreviewBoth(null);
    setDrag({
      taskId: armed.id, x: e.clientX, y: e.clientY,
      grabDX: armed.grabDX, grabDY: armed.grabDY, width: armed.width, target,
      canSettle: armed.canSettle, canCreatePr: armed.canCreatePr,
    });
  }, [setPreviewBoth]);

  const onDragPointerUp = useCallback(() => {
    document.removeEventListener("pointermove", onDragPointerMove);
    document.removeEventListener("pointerup", onDragPointerUp);
    document.removeEventListener("pointercancel", onDragPointerUp);
    const armed = armedRef.current;
    armedRef.current = null;
    const pv = previewRef.current;
    setDrag(null);
    setPreviewBoth(null);
    if (!armed?.started) return;
    // Swallow the click that follows this pointerup (see the ref's comment).
    clickSuppressed.current = true;
    setTimeout(() => { clickSuppressed.current = false; }, 0);

    if (armed.target?.kind === "archive") {
      const w = useApp.getState().tasks.find(u => u.id === armed.id);
      // confirmAndArchive owns the dialog, the delete-branch checkbox, the
      // open-PR warning and the spinner; the board just hands the task over.
      if (w) void confirmAndArchive(w);
      return;
    }
    if (armed.target?.kind === "settle") {
      // "I've seen this": the focus-clear write on every terminal tab. The
      // attention/done badge goes, the derivation moves the card on its own;
      // a no-op was already filtered out by the matrix at drag time.
      useApp.getState().clearTaskWorkState(armed.id);
      return;
    }
    if (armed.target?.kind === "createPr") {
      // Same one-call entry as the command palette and the PR card. The
      // dialog seeds its title from the task, handles cancel, and reports
      // create errors inline; nothing here is board-specific.
      useUI.getState().openCreatePr(armed.id);
      return;
    }
    if (!pv || pv.projectId !== armed.projectId) return;

    // Merge the reordered group back into the project's full id list:
    // non-group tasks of the project (other columns, other lanes) keep their
    // relative positions, the group lands where its first member was.
    const all = useApp.getState().tasks;
    const projIds = all.filter(u => u.project_id === armed.projectId && !u.archived).map(u => u.id);
    // The preview was taken at drag start; a task archived, deleted or moved
    // project mid-drag leaves it naming ids the list no longer holds, and
    // writing it anyway once consumed store slots with dead ids (a live card
    // vanished from `tasks`, or `undefined` did and the next render threw).
    // Null is the cue to snap back; the board redraws from the store.
    const merged = mergeReorderedGroup(projIds, pv.ids);
    if (!merged) return;
    if (merged.every((id, i) => id === projIds[i])) return; // no-op, write nothing
    // Write the store once so board and sidebar agree immediately, then
    // persist through the same IPC the sidebar drag uses. Fall back to a
    // refetch if the write fails, same as the sidebar.
    const byId = new Map(all.map(u => [u.id, u]));
    const queue = [...merged];
    const next = all.map(u =>
      u.project_id === armed.projectId && !u.archived ? byId.get(queue.shift()!)! : u);
    useApp.setState({ tasks: next });
    taskReorder(merged).catch(() => { void useApp.getState().loadAll(); });
  }, [onDragPointerMove, setPreviewBoth]);

  const onCardPointerDown = useCallback((e: React.PointerEvent, w: Task, lane: string, column: BoardStateColumn) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Real controls (the PR badge is a button) and portaled menus/dialogs
    // never start a drag. Same bail-out set as the sidebar.
    if (target.closest('button, input, a, [data-no-drag], [role="menu"], [role="dialog"]')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // The group the card starts in, in RENDERED order (preview-aware would be
    // wrong: a drag always starts from the settled order).
    const groupIds = liveTasks
      .filter(u => u.project_id === w.project_id && u.cli === lane && columnOf.get(u.id) === column)
      .map(u => u.id);
    // Which commands this card's drop could run, computed once: the settled
    // and review columns advertise their drop hints for the whole drag only
    // when the command would not be a guaranteed no-op.
    const hooks = useApp.getState().agentHooksInstalled;
    armedRef.current = {
      id: w.id, projectId: w.project_id, lane, column, groupIds,
      x: e.clientX, y: e.clientY, started: false,
      grabDX: e.clientX - rect.left, grabDY: e.clientY - rect.top, width: rect.width,
      target: null,
      canSettle: column !== "settled"
        && boardDropCommand(column, "settled", w, useApp.getState().tabs[w.id] ?? EMPTY_TABS, hooks) != null,
      canCreatePr: column !== "review"
        && boardDropCommand(column, "review", w, useApp.getState().tabs[w.id] ?? EMPTY_TABS, hooks) != null,
    };
    document.addEventListener("pointermove", onDragPointerMove);
    document.addEventListener("pointerup", onDragPointerUp);
    document.addEventListener("pointercancel", onDragPointerUp);
  }, [liveTasks, columnOf, onDragPointerMove, onDragPointerUp]);

  const onCardClick = useCallback((w: Task) => {
    if (clickSuppressed.current) return;
    useApp.getState().setActiveTask(w.id);
  }, []);

  const dragTask = drag ? tasks.find(w => w.id === drag.taskId) : undefined;
  // An empty state column is hidden, so four columns of nothing stop pushing
  // the ones with cards off screen.
  //
  // Hiding one must not take its COMMAND with it. Settled and In review are
  // drop targets, not just displays (drop-on-Settled clears the work state,
  // drop-on-In-review opens the PR dialog), and they are emptiest exactly when
  // you want to drop into them. So the rail on the right carries each hidden
  // column's own `data-board-cell` + `data-column`, which is what the drop
  // handler reads: dropping on the strip runs the same command the column
  // would have. Revealing the columns on drag instead was the first shape and
  // it was worse, because the board reflows under the hand that is holding a
  // card, and the target does not exist until the drag has already started.
  //
  // Archived is never hidden: it is reached by muscle memory, and its drop is
  // the destructive one.
  const hiddenCols = useMemo(
    () => BOARD_STATE_COLUMNS.filter(c => unfilteredCounts[c] === 0 && !pinnedCols.includes(c)),
    [unfilteredCounts, pinnedCols],
  );
  const shownCols = useMemo(
    () => BOARD_STATE_COLUMNS.filter(c => !hiddenCols.includes(c)),
    [hiddenCols],
  );
  const boardEmpty = allLiveTasks.length === 0 && allArchived.length === 0;
  const ctx: CardContext = { agents, useBranchAsTaskName, workPrefs };

  return (
    <div className="flex h-full flex-col" data-testid="board-view">
      {boardEmpty ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <div className="text-[14px] font-semibold">{t("board.emptyTitle")}</div>
          <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("board.emptyBody")}</div>
        </div>
      ) : (
        <>
        <BoardFilterBar
          text={boardQuery}
          onTextChange={setBoardQuery}
          shown={liveTasks.length + archivedAll.length}
          total={allLiveTasks.length + allArchived.length}
          unknownKeys={query.unknownKeys}
          valuesFor={valuesFor}
          sections={filterSections}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
        />
        <div className="min-h-0 flex-1 overflow-x-auto">
          {/* w-max + min-w-full, LEFT aligned. w-max sizes the row to its
              columns' 280px floor, so a window too narrow for them all
              scrolls (justify-center + overflow would clip the left columns
              permanently). min-w-full stretches it to the pane when there is
              room, and the columns GROW into that room (COLUMN_SIZE). Fixed
              280px columns left a slab of empty board on the right of any
              wide window, and centering them (`mx-auto`, the first shape)
              floated two columns mid-window with nothing either side. A
              board reads from the left and ends at the right edge. */}
          <div className="flex h-full w-max min-w-full gap-3 p-3">
            {shownCols.map(col => (
              <BoardColumnView
                key={col}
                column={col}
                laneIds={lanes}
                cellTasks={colTasks[col]}
                projectOrder={projectOrder}
                projectById={projectById}
                projectAccent={projectAccent}
                ctx={ctx}
                preview={preview}
                dragTarget={drag?.target ?? null}
                dragSourceId={drag?.taskId ?? null}
                dragHint={col === "settled" ? !!drag?.canSettle : col === "review" ? !!drag?.canCreatePr : false}
                onHide={boardColumnCanHide(col, pinnedCols, unfilteredCounts[col]) ? unpinColumn : null}
                onFilter={onFilter}
                onCardPointerDown={onCardPointerDown}
                onCardClick={onCardClick}
              />
            ))}

            {/* Archived: one more kanban column, agent-agnostic (no lanes),
                read-only apart from being the drop-to-archive target. */}
            <section
              data-board-archive
              data-testid="board-archive"
              className={cn(
                "flex flex-col rounded-[10px] bg-[var(--color-bg-1)]", COLUMN_SIZE,
                drag?.target?.kind === "archive" && "ring-1 ring-inset ring-[var(--color-accent-soft)]",
              )}
            >
              <header className="flex shrink-0 items-center gap-2 px-2.5 pb-1 pt-2.5">
                <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--color-fg-faint)]" />
                <span className="text-[12.5px] font-semibold text-[var(--color-fg-dim)]">{t("board.colArchived")}</span>
                <span
                  data-testid="board-archive-count"
                  className="ml-auto rounded px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-faint)]"
                  style={archivedAll.length > 0 ? { backgroundColor: "var(--color-hover)" } : undefined}
                >
                  {archivedAll.length}
                </span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-2.5 pb-2.5">
                {drag && (
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] px-2 py-2 text-center text-[11.5px] text-[var(--color-fg-faint)]">
                    {t("board.archiveHint")}
                  </div>
                )}
                {archivedTasks.map(w => (
                  <ArchivedCard key={w.id} task={w} project={projectById.get(w.project_id)} ctx={ctx} />
                ))}
              </div>
              {archivedAll.length > 0 && (
                <button
                  onClick={() => setView("history")}
                  className="shrink-0 px-2.5 pb-2.5 pt-1 text-left text-[11.5px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
                >
                  {t("board.openHistory")}
                </button>
              )}
            </section>

            {/* Inactive columns: one ordinary column holding the ones with
                nothing in them, rather than a thin rail of vertical text (the
                first shape, and it read as a glitch). It has to say the
                columns still exist, because a board that silently drops
                "Working" reads as a bug, without costing the width the hiding
                just bought.

                Each row is still that column's own drop target, carrying the
                `data-board-cell` + `data-column` the drag handler reads, so
                hiding a column never takes its command with it: Settled
                clears the work state and In review opens the PR dialog, and
                both are emptiest exactly when you want to drop into them.

                Clicking a row PINS that column, and a pin is a setting that
                outlives the view (`prefs.boardPinnedColumns`). It was this
                component's state first, which meant leaving Kanban and coming
                back silently undid it. The pair of controls is the whole
                feature: this list decides what is always shown, and the X on
                an empty pinned column's header decides what goes back to
                being hidden when it empties. */}
            {hiddenCols.length > 0 && (
              <section
                data-testid="board-hidden-columns"
                className="flex w-[200px] shrink-0 flex-col rounded-[10px] bg-[var(--color-bg-1)]/60"
              >
                <header className="flex shrink-0 items-center gap-2 px-2.5 pb-1 pt-2.5">
                  <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--color-fg-faint)]" />
                  <span className="text-[12.5px] font-semibold text-[var(--color-fg-faint)]">
                    {t("board.colInactive")}
                  </span>
                  <span className="ml-auto rounded px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-faint)]">
                    {hiddenCols.length}
                  </span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
                  {hiddenCols.map(c => (
                    <button
                      key={c}
                      type="button"
                      data-board-hidden-column={c}
                      data-board-cell
                      data-column={c}
                      aria-label={t("board.showColumn", { name: t(COL_LABEL[c]) })}
                      onClick={() => pinColumn(c)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                        "text-[var(--color-fg-faint)] transition-colors",
                        "hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
                        // Lit while a drag could land HERE. Each row is its
                        // own column's target, so only the row whose column
                        // the hovered command belongs to lights, exactly the
                        // way the real columns scope themselves; the old
                        // kind-only check lit every row at once.
                        (c === "settled" && drag?.target?.kind === "settle")
                          || (c === "review" && drag?.target?.kind === "createPr")
                          ? "ring-1 ring-inset ring-[var(--color-accent-soft)]"
                          : undefined,
                      )}
                    >
                      <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--color-fg-faint)]" />
                      <span className="min-w-0 truncate">{t(COL_LABEL[c])}</span>
                      <span className="ml-auto tabular-nums opacity-60">0</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
        </>
      )}

      {/* Drag ghost: follows the pointer while the source card dims in place.
          The tilt + shadow say "lifted", the way every kanban shows it.
          pointer-events-none so elementFromPoint sees the columns beneath it;
          transform + shadow are compositor-only, so the ghost costs nothing
          to move. */}
      {drag && dragTask && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg bg-[var(--color-bg-2)] px-3 py-2 shadow-lg ring-1 ring-[var(--color-accent-soft)]"
          style={{
            left: drag.x - drag.grabDX,
            top: drag.y - drag.grabDY,
            width: drag.width,
            transform: "rotate(2deg) scale(1.02)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(dragTask.cli, agents)] || "text-[var(--color-fg-faint)]")}>
              <CliIcon cli={resolveIconId(dragTask.cli, agents)} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
              {taskLabel(dragTask, useBranchAsTaskName)}
            </span>
            {drag.target?.kind === "archive" && (
              <Archive className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
            )}
            {drag.target?.kind === "settle" && (
              <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
            )}
            {drag.target?.kind === "createPr" && (
              <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** `list`, or the previous render's array when it holds the same items in
 *  the same order. Element identity, not ids: a task edited in place is a
 *  new object and must reach the cards. */
function useSameItems<T>(list: T[]): T[] {
  const ref = useRef(list);
  const prev = ref.current;
  if (prev !== list && (prev.length !== list.length || prev.some((x, i) => x !== list[i]))) ref.current = list;
  return ref.current;
}

/** Split a column's tasks into lanes, in `laneIds` order, dropping empty
 *  lanes. */
function groupByLane(tasks: Task[], laneIds: string[]): { lane: string; tasks: Task[] }[] {
  return laneIds
    .map(lane => ({ lane, tasks: tasks.filter(w => w.cli === lane) }))
    .filter(g => g.tasks.length > 0);
}

// ─── Column ──────────────────────────────────────────────────────────────
//
// Every component below this line is memoized, which is what makes the drag
// affordable: setDrag writes a fresh snapshot per pointermove, and with all
// props identity-stable across a move that changes nothing but the ghost's
// x/y (singleton targets, memoized ctx, stable handlers), the per-move
// render stops at BoardView itself. Before the memo, a drag over a 50-card
// board reconciled every column, group and card at input frequency.

const BoardColumnView = memo(function BoardColumnView({ column, laneIds, cellTasks, projectOrder, projectById, projectAccent, ctx, preview, dragTarget, dragSourceId, dragHint, onHide, onFilter, onCardPointerDown, onCardClick }: {
  column: BoardStateColumn;
  laneIds: string[];
  /** The column's cards, straight from the memoized colTasks map. Split
   *  into lanes HERE so a skipped render does not rebuild the array. */
  cellTasks: Task[];
  projectOrder: string[];
  projectById: Map<string, Project>;
  projectAccent: (p: Project | undefined) => string | undefined;
  ctx: CardContext;
  preview: ReorderPreview | null;
  dragTarget: DragTarget;
  dragSourceId: string | null;
  /** True while a drag is in flight whose card could run THIS column's
   *  command (drop-on-Settled / drop-on-In-review); shows the dashed hint
   *  the whole drag, the way the Archived column advertises itself. */
  dragHint: boolean;
  /** Set only when this column is on the board BECAUSE it is pinned and has
   *  nothing in it. Null on a column holding tasks, so the button cannot put
   *  cards out of sight, and null on an unpinned one, which is not showing at
   *  all. `boardColumnCanHide` owns that rule. */
  onHide: ((c: BoardStateColumn) => void) | null;
  onFilter: OnFilter;
  onCardPointerDown: (e: React.PointerEvent, w: Task, lane: string, column: BoardStateColumn) => void;
  onCardClick: (w: Task) => void;
}) {
  const { t } = useTranslation("chrome");
  const tasksByLane = useMemo(() => groupByLane(cellTasks, laneIds), [cellTasks, laneIds]);
  const count = tasksByLane.reduce((n, g) => n + g.tasks.length, 0);
  const accent = COL_ACCENT[column];
  const isCommandTarget =
    (column === "settled" && dragTarget?.kind === "settle")
    || (column === "review" && dragTarget?.kind === "createPr");

  return (
    <section
      data-board-cell
      data-column={column}
      className={cn(
        "flex flex-col rounded-[10px] bg-[var(--color-bg-1)]", COLUMN_SIZE,
        isCommandTarget && "ring-1 ring-inset ring-[var(--color-accent-soft)]",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-2.5 pb-1 pt-2.5">
        <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ backgroundColor: accent }} />
        <span className="text-[12.5px] font-semibold text-[var(--color-fg-dim)]">{t(COL_LABEL[column])}</span>
        <span
          className="ml-auto rounded px-2 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-faint)]"
          style={count > 0 ? { backgroundColor: "var(--color-hover)" } : undefined}
        >
          {count}
        </span>
        {/* Undo the pin. Present only on an empty pinned column, so the
            button never removes a column with cards in it. No confirm: it
            puts the column back in the Inactive list, one click away. */}
        {onHide && (
          <button
            type="button"
            data-board-hide-column={column}
            aria-label={t("board.hideColumn", { name: t(COL_LABEL[column]) })}
            title={t("board.hideColumn", { name: t(COL_LABEL[column]) })}
            onClick={() => onHide(column)}
            className="-mr-1 shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-2.5 pb-2.5">
        {dragHint && (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] px-2 py-2 text-center text-[11.5px] text-[var(--color-fg-faint)]">
            {t(column === "settled" ? "board.settleHint" : "board.reviewHint")}
          </div>
        )}
        {tasksByLane.map(({ lane, tasks }) => (
          <div key={lane} data-board-lane={lane} className="flex flex-col gap-2">
            {/* Lane divider only when it discriminates: a column holding one
                agent's cards is not labelled with the obvious. Sticky so a
                long column keeps its grouping while scrolling. */}
            {laneIds.length > 1 && (
              <button
                type="button"
                data-board-lane-filter={lane}
                title={t("board.filterBy", { value: `agent:${lane}` })}
                onClick={() => onFilter("agent", lane)}
                className="sticky top-0 z-10 -mx-0.5 flex items-center gap-1.5 bg-[var(--color-bg-1)] px-0.5 py-1 text-left text-[11px] font-medium text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
              >
                <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(lane, ctx.agents)] || "text-[var(--color-fg-faint)]")}>
                  <CliIcon cli={resolveIconId(lane, ctx.agents)} className="h-3 w-3" />
                </span>
                <span className="truncate">{agentDisplayName(lane, ctx.agents)}</span>
              </button>
            )}
            <LaneGroups
              lane={lane}
              column={column}
              tasks={tasks}
              projectOrder={projectOrder}
              projectById={projectById}
              projectAccent={projectAccent}
              ctx={ctx}
              preview={preview}
              dragSourceId={dragSourceId}
              onFilter={onFilter}
              onCardPointerDown={onCardPointerDown}
              onCardClick={onCardClick}
            />
          </div>
        ))}
      </div>
    </section>
  );
});

// ─── Project groups inside one lane ──────────────────────────────────────

const LaneGroups = memo(function LaneGroups({ lane, column, tasks, projectOrder, projectById, projectAccent, ctx, preview, dragSourceId, onFilter, onCardPointerDown, onCardClick }: {
  lane: string;
  column: BoardStateColumn;
  tasks: Task[];
  projectOrder: string[];
  projectById: Map<string, Project>;
  projectAccent: (p: Project | undefined) => string | undefined;
  ctx: CardContext;
  preview: ReorderPreview | null;
  dragSourceId: string | null;
  onFilter: OnFilter;
  onCardPointerDown: (e: React.PointerEvent, w: Task, lane: string, column: BoardStateColumn) => void;
  onCardClick: (w: Task) => void;
}) {
  const { t } = useTranslation("chrome");
  const groups = boardCellGroups(tasks, projectOrder);
  return (
    <>
      {groups.map(g => {
        const project = projectById.get(g.projectId);
        // Only the ORIGIN group applies the preview: same project, same
        // lane, same column. A project-only match once applied it to every
        // other group of the project too, where none of the ids matched and
        // the group rendered zero cards under a lit drop ring.
        const ordered = preview !== null && preview.column === column
          && preview.lane === lane && preview.projectId === g.projectId
          ? preview.ids.map(id => g.tasks.find(w => w.id === id)).filter((w): w is Task => !!w)
          : g.tasks;
        return (
          <div key={g.projectId} data-board-project-group={g.projectId} className="flex flex-col">
            {/* Always on (GH #318 feedback): on a one-project board nothing
                else names the project, and the header is how a card from
                another project reads at a glance when one appears. */}
            {/* Clicking the name toggles `project:<name>` in the filter bar;
                the bar's text is what changes, so the syntax teaches itself. */}
            <button
              type="button"
              data-board-project-filter={g.projectId}
              disabled={!project}
              title={project ? t("board.filterBy", { value: `project:${project.name}` }) : undefined}
              onClick={() => project && onFilter("project", project.name)}
              className="flex items-center gap-1.5 px-1 pb-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-faint)] enabled:hover:text-[var(--color-fg)]"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: projectAccent(project) ?? "var(--color-fg-faint)" }}
              />
              {/* Never the id. A UUID is not a thing to show a person, and
                  BoardView filters out tasks whose project is missing, so this
                  only covers a project removed between the two reads. */}
              <span className="truncate">{project?.name ?? t("board.unknownProject")}</span>
            </button>
            {/* While the pointer holds cards over this group, the accent ring
                is the "this is where the drop lands" signal; everywhere else
                is not a target and stays quiet. */}
            <div
              className={cn(
                "flex flex-col gap-2 rounded-lg",
                dragSourceId != null && preview !== null
                  && preview.column === column
                  && preview.lane === lane
                  && preview.projectId === g.projectId
                  && "ring-1 ring-inset ring-[var(--color-accent-soft)]",
              )}
            >
              {ordered.map(w => (
                <BoardCard
                  key={w.id}
                  task={w}
                  ctx={ctx}
                  column={column}
                  lane={lane}
                  isDragSource={dragSourceId === w.id}
                  onCardPointerDown={onCardPointerDown}
                  onCardClick={onCardClick}
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
});

// ─── Cards ───────────────────────────────────────────────────────────────
// Each card subscribes to ONLY its own tab slice (selectTaskTabs), so a
// keystroke in one task re-renders one card, not the board.

const BoardCard = memo(function BoardCard({ task: w, ctx, column, lane, isDragSource, onCardPointerDown, onCardClick }: {
  task: Task;
  ctx: CardContext;
  column: BoardStateColumn;
  lane: string;
  isDragSource: boolean;
  onCardPointerDown: (e: React.PointerEvent, w: Task, lane: string, column: BoardStateColumn) => void;
  onCardClick: (w: Task) => void;
}) {
  const { t } = useTranslation("chrome");
  const tabs = useApp(selectTaskTabs(w.id));
  // Same helper, same precedence as the sidebar and the dashboard, so one
  // task can never wear two different badges on two surfaces.
  const badge = taskWorkBadge(tabs, ctx.workPrefs);
  const label = taskLabel(w, ctx.useBranchAsTaskName);
  // Agent sessions inside the task (the closest thing to subtasks): the
  // sidebar's counting pattern - main-pane terminal tabs whose cli is an
  // actual agent, not the shell/custom sentinel. The chips only render when
  // they discriminate: a single-session task is what the lane already says.
  const agentTabs = tabs.filter((t): t is TerminalTab =>
    t.type === "terminal" && !t.paneId && !isTerminalCli(t.cli, ctx.agents));
  const sessionCount = agentTabs.length;
  const primaryIcon = resolveIconId(w.cli, ctx.agents);
  const extraIcons = sessionCount > 1
    ? [...new Set(agentTabs.map(x => resolveIconId(x.cli, ctx.agents)))].filter(id => id !== primaryIcon)
    : [];
  // The card's left edge repeats its column's accent (softened, so a stack
  // reads as tint, not stripes). color-mix with a theme token: if a theme
  // drops the variable the invalid value is discarded and the default
  // border applies, same discipline as the dashboard's guide line.
  const edge = `color-mix(in srgb, ${COL_ACCENT[column]} 55%, transparent)`;

  return (
    <div
      data-board-task-id={w.id}
      role="button"
      tabIndex={0}
      onPointerDown={e => onCardPointerDown(e, w, lane, column)}
      onClick={() => onCardClick(w)}
      onKeyDown={ev => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onCardClick(w); }
      }}
      style={{ borderLeftColor: edge }}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2 text-left hover:shadow-sm",
        isDragSource && "border-dashed opacity-40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[primaryIcon] || "text-[var(--color-fg-faint)]")}>
          <CliIcon cli={primaryIcon} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
        <span className="shrink-0 tabular-nums text-[10.5px] text-[var(--color-fg-faint)]">{ageLabel(w.created, t)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px] leading-none text-[var(--color-fg-dim)]">
          {agentDisplayName(w.cli, ctx.agents)}
        </span>
        {extraIcons.length > 0 && (
          <span
            title={t("board.sessionCount", { count: sessionCount })}
            className="flex shrink-0 items-center gap-0.5"
          >
            {extraIcons.map(id => (
              <span key={id} className={cn(CLI_BRAND_COLOR[id] || "text-[var(--color-fg-faint)]")}>
                <CliIcon cli={id} className="h-3 w-3" />
              </span>
            ))}
            <span className="tabular-nums text-[10.5px] text-[var(--color-fg-faint)]">×{sessionCount}</span>
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{w.branch}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <TaskLocationIcon isMainCheckout={w.is_main_checkout} />
          <TaskSandboxBadge task={w} tabs={tabs} t={t} />
          {badge && <TaskWorkBadge reason={badge} />}
        </span>
      </div>
      {/* Third row: what this task has actually produced, and where it is up
          to on the forge. The board has the width a sidebar row does not, and
          these are the two questions you open a task to answer. It renders
          only when there is something to say, so a just-created task keeps
          the two-row card it had. */}
      <BoardCardFooter task={w} />
    </div>
  );
});

/** PR identity + change summary, the row that uses the board's extra width.
 *
 *  The PR is the full chip here rather than the sidebar's bare glyph: with
 *  room for the number, its state and its checks, the card answers "is this
 *  reviewable yet" without opening anything, and the whole chip is the link.
 *
 *  Colour comes from prBadgeAppearance, the same tested rule the sidebar
 *  uses, so the board cannot drift into its own palette. */
const BoardCardFooter = memo(function BoardCardFooter({ task: w }: { task: Task }) {
  const { t } = useTranslation("chrome");
  // Per-card subscriptions, deliberately: BoardView's own pr subscription
  // folds only `state` into its key, and widening that would re-render every
  // column whenever any task's check count moved.
  const pr = usePr(s => s.byTask[w.id]?.lookup?.pr ?? null);
  const members = usePr(s => s.byTask[w.id]?.members);
  const stat = useDiffStat(s => s.byTask[w.id]?.stat ?? null);
  const request = useDiffStat(s => s.request);

  // Ask for a measurement when this card mounts, and again whenever the card
  // re-renders past the staleness floor. `request` is a no-op on a fresh
  // answer, so this is not a poll: a board nobody has open measures nothing.
  // Multi-repo cards also ask for member PRs - the task lookup covers the
  // host worktree only, and `composition` holds members only, so without
  // this a board card would wait for someone to open the task's Git tab.
  // Unforced: the pr store's floor still caps it.
  useEffect(() => {
    request(w.id);
    if ((w.composition?.length ?? 0) > 0) void usePr.getState().refresh(w.id);
  });

  const url = pr?.url ?? w.pr_url ?? "";
  const num = pr?.number ?? w.pr_number ?? 0;
  const changed = (stat?.files_changed ?? 0) > 0;
  // Same "forge-backed only" rule as MemberPrRows in the Git tab: a member
  // whose remote resolved to nothing termic can query has no PR story to
  // tell, and an error/cli-missing row would read as "no PR".
  const memberRows = members?.filter(m => m.status === "ok") ?? [];
  if (!url && !changed && !memberRows.length) return null;

  const { color } = prBadgeAppearance(pr?.state ?? null, pr?.checks ?? null);
  const noun = pr?.provider === "gitlab" ? "MR" : "PR";
  const id = num ? `${noun === "MR" ? "!" : "#"}${num}` : noun;
  const forge = noun === "MR" ? "GitLab" : "GitHub";
  const PrIcon =
    pr?.state === "merged" ? GitMerge
    : pr?.state === "closed" ? GitPullRequestClosed
    : pr?.state === "draft" ? GitPullRequestDraft
    : GitPullRequest;
  const checkNote =
    pr?.checks === "failing" ? t("board.prChecksFailing")
    : pr?.checks === "pending" ? t("board.prChecksPending")
    : "";

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {(url || changed) && (
        // WRAPS, and every child can shrink. A 280px column cannot always hold
        // "#18495 - checks failing" and "+356 -21 12 files" on one line, and when
        // it could not, the row overflowed and gave the whole COLUMN a horizontal
        // scrollbar with the file counts clipped off the right edge. Shipped that
        // way in 1.11.2. Wrapping costs a second line on the widest cards and
        // nothing on the rest.
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {url && (
            <button
              type="button"
              data-no-drag
              data-testid="board-card-pr"
              data-pr-state={pr?.state ?? "unknown"}
              title={t("board.prOpenOn", { id, forge })}
              // stopPropagation, or the click also activates the task behind it.
              onClick={e => { e.stopPropagation(); openPath(url).catch(() => {}); }}
              onPointerDown={e => e.stopPropagation()}
              className="flex min-w-0 items-center gap-1 rounded px-1 py-px text-[10.5px] hover:bg-[var(--color-bg-3)]"
              style={{ color }}
            >
              <PrIcon className="h-3 w-3 shrink-0" />
              <span className="shrink-0 tabular-nums">{id}</span>
              {checkNote && <span className="truncate">· {checkNote}</span>}
            </button>
          )}
          {changed && <BoardChurn task={w} stat={stat!} />}
        </div>
      )}
      {/* Multi-repo members, one compact row each (monocode's workstream
          rows): member repo + branch on the left, its own PR chip on the
          right. Capped like the member list itself - the "+N more" line is
          the hint that the task fans out further than the card can say. */}
      {memberRows.slice(0, 3).map(m => <BoardMemberRow key={m.dir_name} m={m} />)}
      {memberRows.length > 3 && (
        <span className="text-[10.5px] text-[var(--color-fg-faint)]">
          {t("board.memberMore", { count: memberRows.length - 3 })}
        </span>
      )}
    </div>
  );
});

/** One non-host member's row on a board card: `repo · branch` plus the
 *  member's own PR chip (state colour + check note) when a lookup resolved
 *  one. A member whose forge answered "no PR" keeps the bare row - on a
 *  multi-repo task that IS the answer, not missing data. */
function BoardMemberRow({ m }: { m: MemberPrLookup }) {
  const { t } = useTranslation("chrome");
  const pr = m.pr;
  const { color } = prBadgeAppearance(pr?.state ?? null, pr?.checks ?? null);
  const noun = pr?.provider === "gitlab" ? "MR" : "PR";
  const id = pr ? `${noun === "MR" ? "!" : "#"}${pr.number}` : "";
  const PrIcon =
    pr?.state === "merged" ? GitMerge
    : pr?.state === "closed" ? GitPullRequestClosed
    : pr?.state === "draft" ? GitPullRequestDraft
    : GitPullRequest;
  const checkNote =
    pr?.checks === "failing" ? t("board.prChecksFailing")
    : pr?.checks === "pending" ? t("board.prChecksPending")
    : "";
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-testid="board-member-row">
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-fg-dim)]">
        {m.dir_name}
        {m.branch ? <span className="font-mono text-[var(--color-fg-faint)]"> · {m.branch}</span> : null}
      </span>
      {pr && (
        <button
          type="button"
          data-no-drag
          title={t("board.prOpenOn", { id, forge: forgeName(pr.provider) })}
          onClick={e => { e.stopPropagation(); openPath(pr.url).catch(() => {}); }}
          onPointerDown={e => e.stopPropagation()}
          className="flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10.5px] hover:bg-[var(--color-bg-3)]"
          style={{ color }}
        >
          <PrIcon className="h-3 w-3 shrink-0" />
          <span className="shrink-0 tabular-nums">{id}</span>
          {checkNote && <span className="truncate">· {checkNote}</span>}
        </button>
      )}
    </div>
  );
}

/** `+N -M · k files`, in the same tokens the compare view uses. */
function BoardChurn({ task: w, stat }: { task: Task; stat: TaskDiffStat }) {
  const { t } = useTranslation("chrome");
  const files = t("board.churnFiles", { count: stat.files_changed });
  const tip = [
    t("board.churnTip", {
      added: stat.insertions, removed: stat.deletions, files,
      base: w.base_branch || "the base",
    }),
    // Said out loud rather than hidden: those lines are counted by reading
    // the files, so a binary or an oversized one contributes none.
    stat.untracked > 0 ? t("board.churnTipUntracked", { count: stat.untracked }) : "",
  ].filter(Boolean).join(". ");
  return (
    <span
      data-testid="board-card-churn"
      title={tip}
      className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums text-[10.5px]"
    >
      {stat.insertions > 0 && <span style={{ color: "var(--color-ok)" }}>+{stat.insertions}</span>}
      {stat.deletions > 0 && <span style={{ color: "var(--color-err)" }}>-{stat.deletions}</span>}
      <span className="text-[var(--color-fg-faint)]">{files}</span>
    </span>
  );
}

/** The card's cage badge, the sidebar's precedence verbatim (Docker first -
 *  Docker tasks store `sandbox_mode: "off"` because the cages are mutually
 *  exclusive; then YOLO, only a warning OUTSIDE a cage since a cage
 *  auto-enables it; then the sandbox mode). Colors are live status, so
 *  `active` follows whether any terminal tab has actually spawned. */
function TaskSandboxBadge({ task: w, tabs, t }: {
  task: Task;
  tabs: Tab[];
  t: TFunction;
}) {
  const mode = effectiveSandboxMode(w);
  const active = tabs.some(x => x.type === "terminal" && !!x.ptyId);
  if (w.docker_sandbox_enabled) {
    return (
      <span title={t("unifiedBar.sbDockerTip")}>
        <DockerSandboxIcon active={active} className="h-3 w-3" />
      </span>
    );
  }
  // Only while something is actually RUNNING. YOLO is a statement about what
  // an agent may do to your machine right now; on a stopped task there is no
  // agent and nothing it can do, so the mark was describing a setting rather
  // than a risk. It used to render at 40% opacity instead, which reads as a
  // live warning that has been turned down rather than as "not running".
  //
  // Outline, not filled: a solid red zap on every YOLO row is the loudest
  // thing on the board, and it is the normal state for anyone who works this
  // way. The shape still says it; the fill was shouting it.
  if (!!w.yolo && !isSandboxEnforced(mode) && active) {
    return (
      <Zap
        data-testid="task-yolo-badge"
        className="h-3 w-3 shrink-0 text-[var(--color-err)]"
        fill="none"
      />
    );
  }
  if (mode !== "off") {
    return (
      <span title={sandboxModeText(mode, t).desc}>
        <SandboxIcon mode={mode} active={active} className="h-3 w-3" />
      </span>
    );
  }
  return null;
}

/** The archived column's card: read-only, single-row compact. Restore stays
 *  in History, so the card has no click action and the column footer links
 *  there instead. */
const ArchivedCard = memo(function ArchivedCard({ task: w, project, ctx }: {
  task: Task;
  project: Project | undefined;
  ctx: CardContext;
}) {
  return (
    <div
      data-board-task-id={w.id}
      className="flex items-center gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2 opacity-70"
    >
      <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(w.cli, ctx.agents)] || "text-[var(--color-fg-faint)]")}>
        <CliIcon cli={resolveIconId(w.cli, ctx.agents)} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{taskLabel(w, ctx.useBranchAsTaskName)}</span>
      {project && <span className="shrink-0 truncate text-[10.5px] text-[var(--color-fg-faint)]">{project.name}</span>}
    </div>
  );
});
