// The sidebar's STATUS section, above PROJECTS (docs/ui.md "The sidebar's
// status section"): the Kanban board's attention half, compressed and always
// on screen. It is a COPY: every task keeps its one home in the project tree,
// and this lists the actionable subset of the same tasks again.
//
// Buckets are the board's columns, from the board's own precedence
// (src/lib/sidebarStatus.ts over boardColumnFromFacts). Nothing is stored.
//
// Rendering discipline (bear traps 5 and 8):
// - The section reads three raw facts per task from a record of its own
//   (useStatusTabFacts), never `tabs`, so an output stamp or a live title
//   re-renders nothing here. The PR snapshot is read non-reactively; a tiny
//   usePr subscription is the re-render trigger, the way BoardView does it.
// - Each row selects its own badge as a VALUE and its own active flag as a
//   boolean, so a task switch re-renders two rows and a working agent's title
//   churn re-renders none.
//
// Identity: a row carries `data-status-task-id` and NONE of the tree's
// `data-sidebar-task-*` attributes, and its badges use their own testids. The
// task drag, SpawnLinksOverlay and the e2e helpers all assume one
// `[data-sidebar-task-id]` per task. Rows are mouse-only: keyboard navigation
// walks the tree's project order, which this section shares but does not own.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Activity, Bell, ChevronDown, ChevronRight, GitPullRequest, Minus, Moon, Plus } from "lucide-react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import {
  selectRollupMarks, selectStatusRowActiveChild, selectStatusRowBadge, selectStatusRowDelegated,
  selectStatusRowTabCount,
  useRowTabs, useStatusTabFacts,
} from "@/store/sidebarTabs";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { TaskPrBadge } from "@/components/TaskPrBadge";
import { TaskLabelText } from "@/components/TaskLabelText";
import { Spinner } from "@/components/ui/Spinner";
import { RollupMarks, WorkMarkList } from "./RollupMarks";
import { cn } from "@/lib/utils";
import { taskLabel, taskLabelParts } from "@/lib/taskLabel";
import { isStatusBucketCollapsed, STATUS_MARK_COLOR, statusBuckets, type StatusBucket } from "@/lib/sidebarStatus";
import { groupColorCss, groupLabel } from "@/lib/taskGroups";
import { formatTerminalTitle } from "@/lib/terminalTitle";
import { taskDelegatedWork, taskWorkBadge } from "@/lib/taskWorkState";
import type { WorkStatePrefs } from "@/lib/taskWorkState";
import type { Agent, Task, TaskGroup, TerminalTab } from "@/lib/types";

/** Literal keys, so usedKeys.test.ts can see them. The board's own labels:
 *  a bucket and its column must not be called two different things. */
function bucketLabel(bucket: StatusBucket, t: TFunction<"sidebar">): string {
  switch (bucket) {
    case "attention": return t("chrome:board.colAttention");
    case "working": return t("chrome:board.colWorking");
    case "review": return t("chrome:board.colReview");
    case "settled": return t("chrome:board.colSettled");
    case "backlog": return t("chrome:board.colBacklog");
  }
}

/** The mark before a bucket's label: the glyph its rows draw, in the colour
 *  the status chips give it (STATUS_MARK_COLOR, one map for both), so each
 *  header reads as a legend for the rows under it and the buckets tell apart
 *  before a word is read. The Working ring is still: a header that spins
 *  forever would say what every row under it already says, on every frame.
 *  Decorative, since the label names the bucket. */
function StatusBucketMark({ bucket }: { bucket: StatusBucket }) {
  return (
    <span
      data-testid="status-bucket-mark"
      data-bucket={bucket}
      aria-hidden
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      style={{ color: STATUS_MARK_COLOR[bucket] }}
    >
      {bucket === "attention" ? <Bell className="h-3 w-3" strokeWidth={2.5} />
        : bucket === "working" ? <Spinner size={12} still />
        : bucket === "review" ? <GitPullRequest className="h-3 w-3" />
        : bucket === "settled" ? <span className="block h-2 w-2 rounded-full bg-current" />
        : <Moon className="h-3 w-3" />}
    </span>
  );
}

/** `matchIds`: the sidebar filter bar's result, or null while it is empty.
 *  The section lists only those tasks, so a filter means the same thing
 *  here as in the tree below. */
export function StatusSection({ matchIds = null }: { matchIds?: ReadonlySet<string> | null }) {
  const { t } = useTranslation("sidebar");
  const projects = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const agents = useApp(s => s.agents);
  const facts = useStatusTabFacts();
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const bucketCollapsed = usePrefs(s => s.statusBucketCollapsed);
  const setBucketCollapsed = usePrefs(s => s.setStatusBucketCollapsed);
  const statusSectionCollapsed = usePrefs(s => s.statusSectionCollapsed);
  const setStatusSectionCollapsed = usePrefs(s => s.setStatusSectionCollapsed);
  const isCollapsed = matchIds ? false : statusSectionCollapsed;
  // The board's pref set, so the same toggles fill the same buckets. Stable
  // identity: it keys every row's badge selector.
  const workPrefs: WorkStatePrefs = useMemo(
    () => ({ settledHighlight, workingIndicator, attentionIndicator }),
    [settledHighlight, workingIndicator, attentionIndicator],
  );

  // Re-render trigger for PR polls, nothing more: the pr store lives outside
  // useApp so its 60s tick re-renders nobody by default, and an open ->
  // merged transition moves a task out of In review. Same key as BoardView.
  const prKey = usePr(s => Object.values(s.byTask).map(e => e.lookup?.pr?.state ?? "?").join("|"));

  const listed = useMemo(
    () => (matchIds ? tasks.filter(w => matchIds.has(w.id)) : tasks),
    [tasks, matchIds],
  );
  const groups = useMemo(
    () => statusBuckets(projects, listed, facts, usePr.getState().byTask, workPrefs),
    // prKey stands in for the snapshot read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, listed, facts, workPrefs, prKey],
  );
  const totalStatusCount = useMemo(() => groups.reduce((acc, g) => acc + g.count, 0), [groups]);
  const statusTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const g of groups) {
      for (const item of g.items) {
        if (item.kind === "task") ids.push(item.task.id);
        else for (const t of item.tasks) ids.push(t.id);
      }
    }
    return ids.join(",");
  }, [groups]);
  const projectName = useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects]);

  return (
    <div data-testid="status-section" className="mb-1">
      <div
        role="button"
        tabIndex={0}
        data-testid="status-section-header"
        aria-expanded={!isCollapsed}
        title={isCollapsed ? t("expandStatusSection") : t("collapseStatusSection")}
        onClick={() => setStatusSectionCollapsed(!statusSectionCollapsed)}
        onKeyDown={ev => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            setStatusSectionCollapsed(!statusSectionCollapsed);
          }
        }}
        className={cn(
          // The same bar as PROJECTS (Sidebar.tsx projects-section-header):
          // one fill, no border, 12px caps in the icon buttons' colour.
          "group mb-0.5 flex h-8 cursor-pointer select-none items-center justify-between rounded-md bg-[var(--color-bg-2)] pl-2 pr-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Activity className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("statusHeader")}</span>
          {totalStatusCount > 0 && (
            <span
              data-testid="status-section-total-count"
              className="ml-0.5 rounded-full bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-fg-dim)] group-hover:text-[var(--color-fg)]"
            >
              {totalStatusCount}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[var(--color-fg-faint)] group-hover:text-[var(--color-fg-dim)]">
          {isCollapsed && statusTaskIds.length > 0 && (
            <RollupMarks ids={statusTaskIds} testId="status-section-marks" />
          )}
          {isCollapsed ? (
            <span
              data-testid="status-section-expand-indicator"
              // A 28px slot, the PROJECTS bar's icon-button size, so the
              // two bars' right edges line up.
              className="flex h-7 w-7 items-center justify-center rounded text-[var(--color-accent)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            </span>
          ) : (
            <span
              data-testid="status-section-collapse-indicator"
              className="flex h-7 w-7 items-center justify-center rounded"
            >
              <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
            </span>
          )}
        </div>
      </div>
      {!isCollapsed && groups.map(g => {
        const open = !isStatusBucketCollapsed(g.bucket, bucketCollapsed);
        const count = g.count;
        const countLabel = count === 1
          ? t("statusBucketCount_one", { count })
          : t("statusBucketCount_other", { count });
        return (
          <div key={g.bucket} data-status-bucket={g.bucket} className="flex flex-col">
            <button
              type="button"
              data-testid="status-bucket-header"
              aria-expanded={open}
              onClick={() => setBucketCollapsed(g.bucket, open)}
              className="ml-1 flex h-[var(--task-row-h)] items-center gap-1 rounded-md px-1 text-[12.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] transition-colors"
            >
              {open
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
              <StatusBucketMark bucket={g.bucket} />
              <span className="min-w-0 truncate font-medium">{bucketLabel(g.bucket, t)}</span>
              {/* Tinted with the bucket's colour, the text left neutral: an
                  amber or blue digit on the light theme's cream is too faint
                  to read, a tint behind a dim one is not. */}
              <span
                data-testid="status-bucket-count"
                title={countLabel}
                aria-label={countLabel}
                className="ml-auto min-w-[18px] rounded-full px-1.5 text-center text-[11px] leading-[16px] tabular-nums text-[var(--color-fg-dim)]"
                style={{ backgroundColor: `color-mix(in srgb, ${STATUS_MARK_COLOR[g.bucket]} 16%, transparent)` }}
              >
                {count}
              </span>
            </button>
            {open && g.items.map(item => item.kind === "task" ? (
              <StatusTaskRow
                key={item.task.id}
                task={item.task}
                projectName={projectName.get(item.task.project_id) ?? ""}
                agents={agents}
                useBranchAsTaskName={useBranchAsTaskName}
                workPrefs={workPrefs}
              />
            ) : (
              <StatusGroupBlock
                key={`group:${item.group.id}`}
                group={item.group}
                label={groupLabel(item.group, tasks, t)}
                projectName={projectName.get(item.tasks[0]?.project_id ?? "") ?? ""}
                tasks={item.tasks}
                workPrefs={workPrefs}
                renderRow={w => (
                  <StatusTaskRow
                    key={w.id}
                    task={w}
                    projectName=""
                    agents={agents}
                    useBranchAsTaskName={useBranchAsTaskName}
                    workPrefs={workPrefs}
                  />
                )}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** A task group, drawn the way the tree draws one: a caption in the group's
 *  colour and its members behind a rail of the same colour, at the same
 *  offsets as TaskGroupBlock, and it folds the same way: chevron, member
 *  count, the members' marks on the caption while folded, and the active
 *  task's row kept in view. The project name moves to the caption, since a
 *  group lives in one project.
 *
 *  Its OWN component and its own fold state (`statusGroupCollapsed`), never
 *  the tree's: TaskGroupBlock carries the tree's drag, rename and menu, and
 *  its `data-task-group-id` is what the task drag hit-tests, so a second one
 *  per group would be a second drop target. This carries
 *  `data-status-group-id`, and folding it never folds the tree. */
function StatusGroupBlock({ group, label, projectName, tasks, workPrefs, renderRow }: {
  group: TaskGroup;
  label: string;
  projectName: string;
  tasks: Task[];
  workPrefs: WorkStatePrefs;
  renderRow: (w: Task) => React.ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const color = groupColorCss(group);
  const collapsed = usePrefs(s => !!s.statusGroupCollapsed[group.id]);
  const setCollapsed = usePrefs(s => s.setStatusGroupCollapsed);
  // A string, so a task switch outside this group re-renders nothing here.
  const activeMember = useApp(s => (tasks.some(w => w.id === s.activeTaskId) ? s.activeTaskId : null));
  const toggle = () => {
    const live = useApp.getState().tasks;
    setCollapsed(group.id, !collapsed,
      [...new Set(live.filter(x => !x.archived && x.group).map(x => x.group!.id))]);
  };
  // Folded, the tree keeps the task you are on in view rather than hiding it
  // behind the caption.
  const shown = collapsed ? tasks.filter(w => w.id === activeMember) : tasks;
  return (
    <div data-status-group-id={group.id} className="flex flex-col">
      <div
        data-testid="status-group-caption"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggle}
        onKeyDown={ev => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
        }}
        className="ml-3 flex h-[var(--task-row-h)] cursor-pointer select-none items-center gap-1 rounded-md px-1 text-[13px] font-medium transition-colors hover:bg-[var(--color-hover)]"
        style={{ color }}
      >
        {/* Where a row's chevron sits, as the tree's caption does it. */}
        <span
          data-testid="status-group-toggle"
          aria-label={collapsed ? t("taskGroup.expand") : t("taskGroup.collapse")}
          title={collapsed ? t("taskGroup.expand") : t("taskGroup.collapse")}
          className="shrink-0 rounded p-0.5"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 shrink truncate">{label}</span>
          {projectName && (
            <span className="min-w-0 shrink-[2] truncate text-[11.5px] font-normal text-[var(--color-fg-faint)]">{projectName}</span>
          )}
        </div>
        {collapsed
          ? <StatusGroupMarks memberIds={tasks.map(w => w.id)} count={tasks.length} workPrefs={workPrefs} />
          : <span data-testid="status-group-count" className="ml-auto shrink-0 pr-1 text-[11px] font-normal tabular-nums text-[var(--color-fg-faint)]">{tasks.length}</span>}
      </div>
      {shown.length > 0 && (
        <div data-status-group-rail className="ml-6 border-l-2" style={{ borderColor: color }}>
          <div className="-ml-1.5">{shown.map(renderRow)}</div>
        </div>
      )}
    </div>
  );
}

/** A folded caption's marks: one of each that a member's row would draw
 *  (`groupBadgeKinds`, the tree's own helper), then the count. Mounted only
 *  while folded, and subscribed through a joined string, so the caption
 *  re-renders when the SET of marks changes, not on every tab write. */
function StatusGroupMarks({ memberIds, count, workPrefs }: {
  memberIds: string[];
  count: number;
  workPrefs: WorkStatePrefs;
}) {
  const partialPref = usePrefs(s => s.partialDoneIndicator);
  const ids = memberIds.join(",");
  const select = useMemo(
    () => selectRollupMarks(ids.split(","), workPrefs, partialPref),
    [ids, workPrefs, partialPref],
  );
  const key = useApp(select);
  return (
    <span data-testid="status-group-marks" data-kinds={key} className="ml-auto flex shrink-0 items-center gap-1 pr-1">
      {key && <WorkMarkList kinds={key} badgeTestId="status-work-badge" />}
      <span data-testid="status-group-count" className="ml-0.5 shrink-0 text-[11px] font-normal tabular-nums text-[var(--color-fg-faint)]">{count}</span>
    </span>
  );
}

/** A lighter row than the tree's TaskRow: no drag, no rename, no run
 *  controls, no menu. It does expand to its agent tabs the way the tree's
 *  row does (chevron, `(n)`, one child row per main-pane terminal tab with
 *  that tab's own agent and badge), because a task running claude AND codex
 *  is two things, and one glyph on the row said only one of them. TaskRow is
 *  NOT reused: its rename and auto-expand effects would run twice per task,
 *  and every auto-expand would be a second whole-state write. */
const StatusTaskRow = memo(function StatusTaskRow({ task: w, projectName, agents, useBranchAsTaskName, workPrefs }: {
  task: Task;
  projectName: string;
  agents: Agent[];
  useBranchAsTaskName: boolean;
  workPrefs: WorkStatePrefs;
}) {
  const { t } = useTranslation("sidebar");
  const setActive = useApp(s => s.setActiveTask);
  const isActive = useApp(s => s.activeTaskId === w.id);
  const selectBadge = useMemo(() => selectStatusRowBadge(w.id, workPrefs), [w.id, workPrefs]);
  const selectDelegated = useMemo(() => selectStatusRowDelegated(w.id, workPrefs), [w.id, workPrefs]);
  const selectCount = useMemo(() => selectStatusRowTabCount(w.id), [w.id]);
  const selectActiveChild = useMemo(() => selectStatusRowActiveChild(w.id), [w.id]);
  const badge = useApp(selectBadge);
  const delegated = useApp(selectDelegated);
  const tabCount = useApp(selectCount);
  const activeChild = useApp(selectActiveChild);
  const expanded = usePrefs(s => !!s.statusTaskExpanded[w.id]);
  const setExpanded = usePrefs(s => s.setStatusTaskExpanded);
  const open = expanded && tabCount > 0;
  const label = taskLabel(w, useBranchAsTaskName);
  const labelIsBranch = label !== w.name;
  const droppedPrefix = taskLabelParts(w, useBranchAsTaskName).prefix !== "";
  const toggle = () => setExpanded(w.id, !expanded,
    useApp.getState().tasks.filter(x => !x.archived).map(x => x.id));

  return (
    <div data-status-task-row={w.id} className="flex flex-col">
      {/* A div with a button role, not a <button>: the chevron and the PR
          chip are buttons, and a button inside a button is invalid content
          WebKit reparents. Same reason as the tree's row. */}
      <div
        data-status-task-id={w.id}
        data-active={(isActive && (!open || !activeChild)) || undefined}
        role="button"
        tabIndex={0}
        onClick={() => setActive(w.id)}
        onKeyDown={ev => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setActive(w.id); }
        }}
        className={cn(
          "ml-3 flex h-[var(--task-row-h)] cursor-pointer select-none items-center gap-1 rounded-md px-1 text-[13px] transition-colors",
          // The tree's rule: the selection sits on the task's row unless an
          // expanded child row (its active tab) carries it.
          isActive && (!open || !activeChild)
            ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
            : isActive
              ? "text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
              : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
        )}
      >
        {tabCount === 0
          // No terminals this session: the tree's dormant mark, nothing to expand.
          ? <Moon className="mx-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)] opacity-40" />
          : (
            <button
              type="button"
              data-testid="status-task-toggle"
              aria-expanded={open}
              onClick={e => { e.stopPropagation(); toggle(); }}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--color-bg-3)]"
            >
              {open
                ? <ChevronDown className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                : <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />}
            </button>
          )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* The leaf alone: this row also names the project, and a
              squeezed prefix came out a different length on every row. The
              whole branch is in the tooltip, and in the tree below. */}
          <TaskLabelText
            task={w}
            useBranch={useBranchAsTaskName}
            leafOnly
            title={[
              droppedPrefix ? label : null,
              labelIsBranch ? t("taskNameTitle", { name: w.name }) : null,
            ].filter(Boolean).join("\n") || undefined}
            className={cn("shrink font-medium", labelIsBranch && "font-mono text-[12px]")}
          />
          {/* Which project, since a bucket mixes them. Faint and shrinks
              first: the task's own name is what the row is for. A group
              member has it on its caption instead. */}
          {projectName && (
            <span className="min-w-0 shrink-[2] truncate text-[11.5px] text-[var(--color-fg-faint)]">{projectName}</span>
          )}
          {/* The tree's terminal count, from two up. */}
          {tabCount > 1 && (
            <span data-testid="status-task-count" className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--color-fg-dim)]">
              ({tabCount})
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 pl-1">
          <TaskPrBadge task={w} testId="status-pr-badge" />
          {/* Expanded, the children carry the badges, as in the tree. */}
          <span className="flex h-[18px] w-[18px] items-center justify-center">
            {!open && badge && <TaskWorkBadge reason={badge} delegated={delegated} testId="status-work-badge" />}
          </span>
        </span>
      </div>
      {open && <StatusTaskTabs taskId={w.id} agents={agents} workPrefs={workPrefs} />}
    </div>
  );
});

/** An expanded status row's children: one per main-pane terminal tab, with
 *  the tab's own agent, title and badge, the way the tree lists them.
 *  Mounted only while expanded, which is the one place this section holds a
 *  task's tabs (titles are drawn here); the timestamps stay held back by
 *  useRowTabs, as for the tree's rows. */
function StatusTaskTabs({ taskId, agents, workPrefs }: {
  taskId: string;
  agents: Agent[];
  workPrefs: WorkStatePrefs;
}) {
  const tabs = useRowTabs(taskId);
  const isActive = useApp(s => s.activeTaskId === taskId);
  const activeTabId = useApp(s => s.activeTab[taskId]);
  const setActive = useApp(s => s.setActiveTask);
  const setActiveTabId = useApp(s => s.setActiveTabId);
  const terminalTabs = tabs.filter((t): t is TerminalTab => t.type === "terminal" && !t.paneId);
  return (
    <>
      {terminalTabs.map(tab => {
        const hot = isActive && tab.id === activeTabId;
        const reason = taskWorkBadge([tab], workPrefs);
        const raw = tab.customTitle ? tab.title : (tab.liveTitle || tab.title);
        const icon = resolveIconId(tab.cli, agents);
        // The tree's rule: the brand glyph always goes, the spinner whenever
        // Termic draws its own working badge.
        const title = tab.customTitle ? raw : formatTerminalTitle(raw, icon, !!workPrefs.workingIndicator);
        return (
          <div
            key={tab.id}
            data-status-tab-id={tab.id}
            data-cli={tab.cli}
            data-active={hot || undefined}
            role="button"
            tabIndex={0}
            // Tab first, as in the tree's tab rows (see there).
            onClick={() => { setActiveTabId(taskId, tab.id); setActive(taskId); }}
            onKeyDown={ev => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault(); setActiveTabId(taskId, tab.id); setActive(taskId);
              }
            }}
            className={cn(
              "ml-8 flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] transition-colors",
              hot
                ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            <span className={cn("shrink-0", CLI_BRAND_COLOR[icon] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={icon} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
              {reason && (
                <TaskWorkBadge reason={reason} delegated={taskDelegatedWork([tab], workPrefs)} testId="status-work-badge" />
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
