// Dashboard: hero banner + action cards + a Recent row + per-project cards
// grouped into the same folders the sidebar shows. Designed so the empty state
// and the populated state share the same shape — adding a project doesn't yank
// you somewhere else.

import { useEffect, useMemo } from "react";
import { useApp, selectTaskTabs } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import { useTaskGit, startDashboardGitPolling, stopDashboardGitPolling } from "@/store/taskGit";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import { TaskPrBadge } from "@/components/TaskPrBadge";
import { GroupActionsMenuItems } from "@/components/sidebar/GroupActionsMenuItems";
import { taskLabel } from "@/lib/taskLabel";
import { taskWorkBadge } from "@/lib/taskWorkState";
import { taskGoalText, parkReasonText } from "@/lib/taskNotes";
import { TaskPhaseGlyph } from "@/components/TaskPhaseGlyph";
import {
  taskPhase, taskAgeLabel, phaseCounts, PHASE_ORDER, PHASE_LABEL, PHASE_EMPTY_LABEL,
} from "@/lib/taskPhase";
import type { TaskPhase } from "@/lib/taskPhase";
import { groupOf, projectSections, sortSectionsActiveFirst } from "@/lib/projectGroups";
import { accentCss } from "@/lib/accents";
import { projectSetGroup } from "@/lib/ipc";
import { TermicBlockmark } from "@/icons/TermicLogo";
import type { Agent, Project, Task } from "@/lib/types";
import type { WorkStatePrefs } from "@/lib/taskWorkState";

/** Everything a task row needs that is the SAME for every row, passed down
 *  instead of subscribed to N times. */
interface TaskRowContext {
  agents: Agent[];
  useBranchAsTaskName: boolean;
  workPrefs: WorkStatePrefs;
}

/** A task plus its derived phase, computed ONCE per task at the Dashboard
 *  level (see the memo in `Dashboard`) and carried down to the row. */
interface PhasedTask {
  task: Task;
  phase: TaskPhase;
}

// Module-level, not per row: `Intl.DateTimeFormat` is expensive to construct
// and the age tooltip wants the same format on every row anyway.
const AGE_TITLE_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Shared frozen empty list, so a project with no rows hands its card the
 *  SAME reference every render instead of a fresh `[]`. */
const EMPTY_ROWS: readonly PhasedTask[] = Object.freeze([]);

// Module-level flag: animate the hero logo ONCE per app launch, not every
// time the user navigates back to the dashboard from a task tab. The
// typewriter draw-in is charming on startup but turns into visual noise
// on the 20th dashboard visit. Set true on first import-evaluated mount;
// flipped false after the first render so subsequent Dashboard mounts in
// the same session render the logo statically.
let logoHasAnimated = false;
import { cn } from "@/lib/utils";
import {
  FolderPlus, Settings as SettingsIcon, Compass, Cog, Boxes, Plus, Folder,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu } from "@/components/ui/Dropdown";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/ContextMenu";
import { ProjectActionsMenuItems } from "@/components/sidebar/ProjectActionsMenuItems";

export function Dashboard() {
  const projects     = useApp(s => s.projects);
  const tasks        = useApp(s => s.tasks);
  const setActive    = useApp(s => s.setActiveTask);
  const openSettings = useApp(s => s.openSettings);
  const loadAll      = useApp(s => s.loadAll);
  const recentTasks  = useApp(s => s.recentTasks);
  const collapsedGroups   = useApp(s => s.collapsedGroups);
  const setGroupCollapsed = useApp(s => s.setGroupCollapsed);
  const groupColors       = useApp(s => s.groupColors);
  const setGroupColor     = useApp(s => s.setGroupColor);
  const openNewProject   = useUI(s => s.openNewProject);
  const agents = useApp(s => s.agents);
  const dashboardPhase    = useUI(s => s.dashboardPhase);
  const setDashboardPhase = useUI(s => s.setDashboardPhase);
  // ONE subscription EACH to the two live stores the phase reads, for the
  // whole page. Every row needs a phase and the phase needs both, but a hook
  // per row would put N subscribers on stores that re-publish `byTask` on
  // every poll tick. Subscribing once here costs one re-render of a page that
  // is only mounted while no task is open (docs/performance.md bear traps 5
  // and 8). Note what is NOT subscribed to here: the whole `tabs` record,
  // which changes on every keystroke in every task. The rows read their own
  // slice through `selectTaskTabs`.
  const prByTask  = usePr(s => s.byTask);
  const gitByTask = useTaskGit(s => s.byTask);
  // Prefs and the agent registry are hoisted rather than read per row: they
  // are stable references shared by every task, and this component already
  // re-renders on any `tasks` change, so a subscription per row would buy no
  // isolation and cost one more subscriber per task in the fleet. The one
  // thing that DOES stay per row is `selectTaskTabs`, which is the selector
  // that actually differs between rows.
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const settledHighlight    = usePrefs(s => s.settledHighlight);
  const workingIndicator    = usePrefs(s => s.workingIndicator);
  const rowCtx: TaskRowContext = { agents, useBranchAsTaskName, workPrefs: { settledHighlight, workingIndicator } };

  // The git half of the phase is polled ONLY while this page is mounted, which
  // is only while no task is open. The phase is drawn nowhere else, and
  // `task_git_phase_state` shells out to git: running it behind an agent the
  // user is driving would be the worst moment to spend it. See the header of
  // src/store/taskGit.ts.
  //
  // Gated on there being tasks at all, the same gate `initPrStatusPoller` has
  // and for the same reason: on LAUNCH this page mounts before `loadAll`
  // resolves, so starting here would run the immediate pass over an empty
  // store and then wait a full tick. Every git-derived phase would read In
  // progress for the first 30 seconds of every launch. The dep is the boolean,
  // not `tasks`, so adding a second task does not restart the timer.
  const hasTasks = tasks.length > 0;
  useEffect(() => {
    if (!hasTasks) return;
    startDashboardGitPolling();
    return () => stopDashboardGitPolling();
  }, [hasTasks]);

  const hasActiveTask = (projId: string) =>
    tasks.some(w => w.project_id === projId && !w.archived);

  // Counts are over every non-archived task and are deliberately NOT keyed on
  // the selected phase: the numbers on the pills describe the fleet, not the
  // current view, so they must not move when you click one.
  //
  // The git lookup yields `undefined` (nothing has polled this task) and
  // `null` (its lookup failed), and BOTH mean "we do not know": `taskPhase`
  // falls through on either, the same way it does for an unresolved PR.
  const counts = useMemo(
    () => phaseCounts(
      tasks.filter(w => !w.archived),
      id => prByTask[id]?.lookup?.pr ?? null,
      id => gitByTask[id]?.state,
    ),
    [tasks, prByTask, gitByTask],
  );
  const taskCount = tasks.reduce((n, w) => (w.archived ? n : n + 1), 0);

  // One pass over `tasks` IN STORE ORDER (see DashboardProjectCard's comment
  // on why order matters), bucketed by project and carrying each task's
  // phase. Two things need this above the card level: hiding a whole group
  // whose members all filtered out, and knowing that the filter matched
  // nothing at all. Computing it per card would answer neither.
  const visibleByProject = useMemo(() => {
    const byProject = new Map<string, PhasedTask[]>();
    for (const w of tasks) {
      if (w.archived) continue;
      const phase = taskPhase(w, prByTask[w.id]?.lookup?.pr ?? null, gitByTask[w.id]?.state);
      if (dashboardPhase !== null && phase !== dashboardPhase) continue;
      const list = byProject.get(w.project_id);
      if (list) list.push({ task: w, phase });
      else byProject.set(w.project_id, [{ task: w, phase }]);
    }
    return byProject;
  }, [tasks, prByTask, gitByTask, dashboardPhase]);

  const filtered = dashboardPhase !== null;
  const nothingMatches = filtered && visibleByProject.size === 0;

  // Section FIRST, then sort the sections — never the other way round. A group
  // is anchored at its first member's index, so sorting projects first both
  // moves the folder and reorders it internally, and the sidebar (which does
  // not sort at all) ends up showing a different list. See
  // `sortSectionsActiveFirst` for the worked case.
  const sections = sortSectionsActiveFirst(projectSections(projects), hasActiveTask);

  // Recent is a way BACK IN, so it only lists tasks that are still open. The
  // store prunes archived and deleted ids on every loadAll; this guards the
  // window between a task disappearing and that running.
  const recent = recentTasks
    .map(id => tasks.find(w => w.id === id))
    .filter((w): w is Task => !!w && !w.archived);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        {/* Hero */}
        <header className="mb-10 mt-6 flex flex-col items-center gap-4 text-center">
          {(() => {
            // Capture before render so this mount animates if it's first.
            const shouldAnimate = !logoHasAnimated;
            logoHasAnimated = true;
            return <TermicBlockmark cellSize={10} gap={2} animate={shouldAnimate} />;
          })()}
          <div className="text-[11.5px] uppercase tracking-[0.3em] text-[var(--color-fg-faint)]">
            Home for your CLI coding agents
          </div>
        </header>

        {/* Top-level actions */}
        <div className="mb-10 grid grid-cols-3 gap-3">
          <ActionCard
            icon={<FolderPlus className="h-5 w-5" />}
            label="Add project"
            hint="Pick a git repo on disk"
            onClick={openNewProject}
          />
          <ActionCard
            icon={<Compass className="h-5 w-5" />}
            label="Discover repos"
            hint="Scan your repos folder"
            onClick={openNewProject /* same dialog shows discovery */}
          />
          <ActionCard
            icon={<SettingsIcon className="h-5 w-5" />}
            label="Settings"
            hint="Fonts, agents, theme"
            onClick={() => openSettings()}
          />
        </div>

        {/* Recent — hidden entirely when empty, so a fresh install sees the
            page it always saw and the empty state stays the biggest thing on
            the screen. */}
        {recent.length > 0 && (
          <div className="mb-8" data-testid="dashboard-recents">
            <h2 className="mb-3 text-[14px] font-semibold">Recent</h2>
            <div className="flex flex-wrap gap-2">
              {recent.map(w => (
                <RecentChip
                  key={w.id}
                  task={w}
                  ctx={rowCtx}
                  projectName={projects.find(p => p.id === w.project_id)?.name}
                  onOpen={() => setActive(w.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Phase filter — hidden until there is at least one task, so a fresh
            install sees exactly the page it sees today. It stays while a
            filter is selected even if that empties the fleet: archiving the
            last task would otherwise take the row away and leave "Nothing in
            progress" on screen with nothing to click to clear it. */}
        {(taskCount > 0 || filtered) && (
          <PhaseFilterRow
            selected={dashboardPhase}
            counts={counts}
            total={taskCount}
            onPick={setDashboardPhase}
          />
        )}

        {/* Projects */}
        {projects.length === 0 ? (
          <EmptyProjectsCard onClick={openNewProject} />
        ) : (
          <>
            {/* The count is the number of PROJECTS, which a task filter does
                not change: the header still names how many projects exist,
                and only the cards below it thin out. */}
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[14px] font-semibold">Projects</h2>
              <span className="text-[12px] text-[var(--color-fg-faint)]">{projects.length}</span>
            </div>
            <div className="flex flex-col gap-3">
              {nothingMatches ? (
                <div
                  data-testid="dashboard-phase-empty"
                  className="rounded-lg border border-dashed border-[var(--color-border-soft)] px-3 py-4 text-center text-[12.5px] text-[var(--color-fg-faint)]"
                >
                  {PHASE_EMPTY_LABEL[dashboardPhase]}
                </div>
              ) : sections.map(sec => sec.kind === "loose" ? (
                // A card with nothing left after filtering is dropped rather
                // than shown empty: a filter that leaves a page of empty
                // cards has not filtered anything.
                (!filtered || visibleByProject.has(sec.p.id)) && (
                  <DashboardProjectCard
                    key={sec.p.id}
                    project={sec.p}
                    rows={visibleByProject.get(sec.p.id) ?? EMPTY_ROWS}
                    filtered={filtered}
                    ctx={rowCtx}
                    onSettings={() => openSettings("repositories", sec.p.id)}
                  />
                )
              ) : (
                // Same rule one level up: a folder whose every member card
                // went away takes its header and guide line with it.
                (!filtered || sec.members.some(p => visibleByProject.has(p.id))) && (
                  <GroupSection
                    key={`group:${sec.name}`}
                    name={sec.name}
                    members={sec.members}
                    visibleByProject={visibleByProject}
                    filtered={filtered}
                    ctx={rowCtx}
                    collapsed={!!collapsedGroups[sec.name]}
                    accent={accentCss(groupColors[sec.name])}
                    onToggle={() => setGroupCollapsed(sec.name, !collapsedGroups[sec.name])}
                    onSetColor={key => setGroupColor(sec.name, key)}
                    onUngroup={async () => {
                      const ids = useApp.getState().projects
                        .filter(p => groupOf(p) === sec.name).map(p => p.id);
                      try { await projectSetGroup(ids, null); } catch (e) { console.error("ungroup failed", e); }
                      void loadAll();
                    }}
                    onSettings={id => openSettings("repositories", id)}
                  />
                )
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Group folder ───────────────────────────────────────────────────────
// The sidebar's folder, restated as a card-list section: same Folder glyph,
// ALL-CAPS name, member count and accent, and the SAME `collapsedGroups`
// state, so collapsing a folder in either view collapses it in both.
//
// Rename and drag-and-drop stay sidebar-only. Both are inline edits on a row
// the sidebar owns, and a second way to do them here would be two sources of
// truth for one gesture — hence `GroupActionsMenuItems` without `onRename`.
function GroupSection({
  name, members, visibleByProject, filtered, ctx, collapsed, accent, onToggle, onSetColor, onUngroup, onSettings,
}: {
  name: string;
  members: Project[];
  visibleByProject: Map<string, PhasedTask[]>;
  filtered: boolean;
  ctx: TaskRowContext;
  collapsed: boolean;
  accent: string | undefined;
  onToggle: () => void;
  onSetColor: (key: string | null) => void;
  onUngroup: () => void;
  onSettings: (projectId: string) => void;
}) {
  return (
    <div data-dashboard-group={name}>
      <ContextMenuRoot>
        <ContextMenuTrigger className="contents">
          <div
            data-dashboard-group-header={name}
            role="button"
            tabIndex={0}
            aria-expanded={!collapsed}
            onClick={onToggle}
            onKeyDown={ev => {
              if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onToggle(); }
            }}
            // Inline colour deliberately beats the hover class — a coloured
            // folder stays its colour under the cursor, same as the sidebar.
            style={accent ? { color: accent } : undefined}
            className="mb-2 flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-faint)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            {collapsed
              ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
              : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
            {/* No own colour class when accented — inherits the header's
                currentColor so glyph + name match. */}
            <Folder className={cn("h-3.5 w-3.5 shrink-0", !accent && "text-[var(--color-fg-faint)]")} />
            <span className="truncate">{name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[11px] text-[var(--color-fg-faint)]">
              {members.length}
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <GroupActionsMenuItems
            name={name}
            accent={accent}
            onSetColor={onSetColor}
            onUngroup={onUngroup}
          />
        </ContextMenuContent>
      </ContextMenuRoot>
      {!collapsed && (
        <div
          // Tint the guide line toward the group's accent so a long member
          // list stays attributable mid-scroll. If color-mix is unavailable
          // the invalid value is dropped and the class's border colour applies.
          style={accent ? { borderColor: `color-mix(in srgb, ${accent} 45%, transparent)` } : undefined}
          className="ml-[7px] flex flex-col gap-3 border-l border-[var(--color-border-soft)] pl-3"
        >
          {members.map(p => (!filtered || visibleByProject.has(p.id)) && (
            <DashboardProjectCard
              key={p.id}
              project={p}
              rows={visibleByProject.get(p.id) ?? EMPTY_ROWS}
              filtered={filtered}
              ctx={ctx}
              onSettings={() => onSettings(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// `rows` arrives already filtered and already carrying each task's phase (see
// the `visibleByProject` memo). `filtered` says whether a phase is selected,
// which is the difference between "this project has no tasks" (show the
// placeholder) and "none of its tasks match the filter" (the parent already
// dropped the card, so this never renders empty).
function DashboardProjectCard({ project, rows, filtered, ctx, onSettings }: {
  project: Project;
  rows: readonly PhasedTask[];
  filtered: boolean;
  ctx: TaskRowContext;
  onSettings: () => void;
}) {
  return (
    <ProjectCard projectId={project.id} name={project.name} onSettings={onSettings}>
      {rows.length === 0 && !filtered ? (
        <div className="px-3 py-2 text-[12.5px] text-[var(--color-fg-faint)]">
          Nothing here yet. Click <b>+</b> to start a new worktree or open the <b>main checkout</b>.
        </div>
      ) : (
        <div className="flex flex-col">
          {/* Same as the sidebar: store order, which Rust sorts
              on the manual drag `order` then `created`. Sorting
              by `created` here would ignore a sidebar reorder
              and show the two views a different list. */}
          {rows.map(r => <DashboardTaskRow key={r.task.id} task={r.task} phase={r.phase} ctx={ctx} />)}
        </div>
      )}
    </ProjectCard>
  );
}

// ─── Task row ───────────────────────────────────────────────────────────
// Its own component so each row subscribes to only its own tab state
// (`selectTaskTabs`), the way the sidebar's TaskRow does. Selecting the whole
// `tabs` record here would re-run this list on every keystroke in every task.
// The phase arrives as a PROP, not from a `usePr` hook here. The card above
// already holds the one PR subscription for the page, and the rows re-render
// with it anyway, so a per-row subscription would buy no isolation and add one
// subscriber per task to a store that republishes on every poll.
//
// The phase IS drawn on the row, as one monochrome glyph, and the first
// version of this feature got that wrong. It drew nothing, reasoning from
// #292 that anything beside the PR chip repeats it. What that actually
// produced was a board where Todo, In progress and Parked were invisible and
// the other two were legible only because the chip happened to be there:
// three treatments in one column, and no answer at all on most rows.
//
// #292's objection was narrower than "do not draw it". Its status square was
// COLOURED, in the chip's own vocabulary, so purple meant "merged" on one and
// "In review" on the other and the two could contradict each other. Neither
// half of that is true here. Colour stays the chip's, and the phase is
// DERIVED from the PR state, so a merged PR is Done and the two marks cannot
// disagree. See src/components/TaskPhaseGlyph.tsx.
//
// The goal is the row's other ladder signal, drawn in the age's register:
// faint, uncoloured, one line, with the full text in its tooltip.
//
// - The GOAL is what makes a planned task look planned, which is the only
//   thing separating it on screen from a task nobody has touched. It stays on
//   the row after the task starts, because it stays on the record.
// - PARKED reads as a faint word and DIMS the row, which is what a stopped
//   task already looks like, so it adds nothing new to the page's vocabulary.
//   It keys on the PHASE, not on `parked_at`, so a row can never say Parked
//   while the Parked pill would not list it: Done outranks Parked, and a
//   parked task whose PR merged is finished. The reason, when there is one,
//   goes in the tooltip rather than on screen.
function DashboardTaskRow({ task: w, phase, ctx }: { task: Task; phase: TaskPhase; ctx: TaskRowContext }) {
  const setActive = useApp(s => s.setActiveTask);
  const tabs      = useApp(selectTaskTabs(w.id));
  const { agents, useBranchAsTaskName } = ctx;

  // Same helper, same precedence as the sidebar (attention > done > working),
  // so one task can never wear two different badges on two surfaces.
  const badge = taskWorkBadge(tabs, ctx.workPrefs);
  // Recomputed at render, which is enough: this page is remounted on every
  // visit and the label's finest bucket is a whole day.
  const age = taskAgeLabel(w.last_opened_at);
  // Both read straight off the record the row was already handed. No hook,
  // no store read: a row that subscribed to anything new here would widen the
  // fan-out this component's whole shape exists to keep narrow (bear trap 5,
  // and src/store/selectorFanout.test.ts counts it).
  const goal = taskGoalText(w);
  const parked = phase === "parked";
  const parkReason = parked ? parkReasonText(w) : "";

  return (
    // A div with a button role, not a <button>: the PR chip is itself a button
    // (it opens the forge), and a button inside a button is invalid content
    // that WebKit reparents. The sidebar's task row is a div for the same
    // reason. Keyboard parity is explicit, the way the group header does it.
    <div
      // Lets the e2e suite read this list's order and
      // assert it against the sidebar's — the two
      // silently diverged once already.
      data-dashboard-task-id={w.id}
      data-dashboard-task-project-id={w.project_id}
      data-task-phase={phase}
      role="button"
      tabIndex={0}
      onClick={() => setActive(w.id)}
      onKeyDown={ev => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setActive(w.id); }
      }}
      // Dim the task name to match the sidebar's task rows
      // (fg-dim by default, fg on hover); the "on" / branch
      // keep their own explicit colors.
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
        // Dimmed, not coloured. The same `opacity-60` the sidebar puts on a
        // task with no live PTY, so "put down" and "not running" look alike,
        // which they are.
        parked && "opacity-60",
      )}
    >
      {/* Use the CLI brand icon for main-checkout rows
          too — matches the sidebar's unified rendering.
          The location chip signals main checkout vs
          worktree. */}
      <span className={cn(
        "shrink-0",
        CLI_BRAND_COLOR[resolveIconId(w.cli, agents)] || "text-[var(--color-fg-faint)]",
      )}>
        <CliIcon cli={resolveIconId(w.cli, agents)} className="h-4 w-4" />
      </span>
      {/* Branch-labelled tasks (GH #260) drop the
          "on <branch>" clause: it would just repeat
          the label sitting next to it. */}
      {taskLabel(w, useBranchAsTaskName) === w.branch ? (
        <span className="min-w-0 shrink truncate font-mono text-[12.5px] font-medium">{w.branch}</span>
      ) : (
        <>
          <span className="min-w-0 shrink truncate font-medium text-[13px]" title={taskLabel(w, useBranchAsTaskName) === w.name ? undefined : `Task name: ${w.name}`}>{taskLabel(w, useBranchAsTaskName)}</span>
          <span className="shrink-0 text-[12.5px] text-[var(--color-fg-faint)]">on</span>
          <span className="min-w-0 shrink font-mono text-[12px] text-[var(--color-fg-dim)] truncate">{w.branch}</span>
        </>
      )}
      <TaskLocationIcon isMainCheckout={w.is_main_checkout} className="self-center" />
      {/* The goal, in the age's register: faint, uncoloured, one line. `flex-1`
          (basis 0) rather than `shrink`, so it takes only what the name and
          branch leave and is the first thing to give under pressure. Two
          shrinking items with natural bases split the deficit in proportion to
          their length, which is how a long goal would crush the task name (the
          same trap the Git Compare bar records in docs/ui.md). Full text in the
          tooltip, since one line of a goal is often half a sentence. */}
      {goal && (
        <span
          data-testid="task-goal"
          className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--color-fg-faint)]"
          title={goal}
        >{goal}</span>
      )}
      {/* Live signals, right-aligned so a row with none is unchanged. Both
          are read-only here: the PR chip renders what the poller already
          resolved and never kicks a fetch of its own. */}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
        {/* Age leads the right cluster: it is the quietest thing here and
            the two badges are the ones you scan for. Uncoloured for the same
            reason the filter pills are, the PR chip owns colour on this page.
            The name spans are `min-w-0 shrink truncate`, so this fixed-width
            cluster takes its width from the name, never the other way round. */}
        {age && w.last_opened_at && (
          <span
            data-testid="task-age"
            className="shrink-0 text-[11.5px] tabular-nums text-[var(--color-fg-faint)]"
            title={`Last opened ${AGE_TITLE_FMT.format(new Date(w.last_opened_at))}`}
          >{age}</span>
        )}
        {/* Every row, every phase, one shape. Sits between the age and the
            badges so it lands in the same column whether or not the row has a
            PR chip, which is the whole point: three of the five phases used to
            be invisible here and the other two were legible only because the
            chip happened to be there.

            Monochrome. Colour stays the PR chip's, so the two marks cannot be
            confused for one vocabulary (PR #292), and the phase still reads
            for someone who cannot tell the chip's green from its purple.

            A park reason rides in its tooltip, which is where it went when the
            row stopped spelling "Parked" out in words. */}
        <TaskPhaseGlyph phase={phase} note={parkReason || undefined} />
        <TaskPrBadge task={w} />
        {badge && <TaskWorkBadge reason={badge} />}
      </span>
    </div>
  );
}

// ─── Phase filter ───────────────────────────────────────────────────────
// One row of pills over the project list. Shaped like `RecentChip` so the two
// rows above the projects read as one family.
//
// DELIBERATELY UNCOLOURED. The PR chip owns green / purple / red on this page,
// and a coloured phase pill sitting a few pixels from it invites the reader to
// match two colour vocabularies that mean different things. That collision is
// what sank the first attempt (PR #292): a status you could colour turned into
// a second, hand-maintained signal competing with the live one.
//
// No `transition-colors` either, on the selected state or anywhere on these
// pills: WKWebView does not repaint a themed `border-color` through a colour
// transition, so a selected pill would move its text and background and leave
// its border on the unselected colour. The hover rules are plain class swaps
// for the same reason.
function PhaseFilterRow({ selected, counts, total, onPick }: {
  selected: TaskPhase | null;
  counts: Record<TaskPhase, number>;
  total: number;
  onPick: (phase: TaskPhase | null) => void;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-center gap-2" data-testid="dashboard-phase-filter">
      <PhasePill
        phase="all"
        label="All"
        count={total}
        selected={selected === null}
        onClick={() => onPick(null)}
      />
      {/* ALL FIVE, always, in lifecycle order (Parked last, after Done: it is
          not a stage of the life the first four spell out, it is a task
          stepping out of the line), so the vocabulary stays put between visits
          and the row reads left to right as a task's life.
          Todo used to be conditional, on the theory that every GUI-created
          task was In progress within a second of existing and a permanent
          "Todo 0" would be a word the user learns to ignore. That premise is
          gone: a task is Todo until somebody actually prompts it, which makes
          it the state every new task sits in, and a pill that comes and goes
          is worse than a zero. */}
      {PHASE_ORDER.map(p => (
        <PhasePill
          key={p}
          phase={p}
          label={PHASE_LABEL[p]}
          count={counts[p]}
          selected={selected === p}
          // Clicking the selected pill again clears the filter: the pill
          // you just pressed is the obvious place to press to undo it.
          onClick={() => onPick(selected === p ? null : p)}
        />
      ))}
    </div>
  );
}

function PhasePill({ phase, label, count, selected, onClick }: {
  phase: TaskPhase | "all";
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      data-phase={phase}
      data-count={count}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px]",
        selected
          ? "border-[var(--color-accent-soft)] bg-[var(--color-bg-2)] text-[var(--color-fg)]"
          : "border-[var(--color-border-soft)] bg-[var(--color-bg-1)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]",
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-[var(--color-fg-faint)]">{count}</span>
    </button>
  );
}

// A recently visited task, as a chip. Terse on purpose: this row is a way back
// into what you were just doing, and anything wider than the name plus its
// project would push the projects list off the first screen. That is why it
// carries no age label and is not filtered by the phase pills: these eight are
// where you just were, which is a different question from what state the fleet
// is in.
function RecentChip({ task: w, ctx, projectName, onOpen }: {
  task: Task; ctx: TaskRowContext; projectName: string | undefined; onOpen: () => void;
}) {
  const tabs = useApp(selectTaskTabs(w.id));
  const { agents, useBranchAsTaskName } = ctx;
  const badge = taskWorkBadge(tabs, ctx.workPrefs);
  return (
    <button
      data-dashboard-recent-task-id={w.id}
      onClick={onOpen}
      title={projectName ? `${projectName} · ${w.branch}` : w.branch}
      className="flex max-w-[220px] items-center gap-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
    >
      <span className={cn(
        "shrink-0",
        CLI_BRAND_COLOR[resolveIconId(w.cli, agents)] || "text-[var(--color-fg-faint)]",
      )}>
        <CliIcon cli={resolveIconId(w.cli, agents)} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 truncate font-medium">{taskLabel(w, useBranchAsTaskName)}</span>
      {badge && <TaskWorkBadge reason={badge} />}
    </button>
  );
}

function ActionCard({ icon, label, hint, onClick }: {
  icon: React.ReactNode; label: string; hint: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-4 text-left transition-colors hover:border-[var(--color-accent-soft)]"
    >
      <span className="text-[var(--color-fg-dim)]">{icon}</span>
      <div>
        <div className="text-[13.5px] font-semibold">{label}</div>
        <div className="text-[12px] text-[var(--color-fg-faint)]">{hint}</div>
      </div>
    </button>
  );
}

function ProjectCard({ projectId, name, onSettings, children }: {
  projectId: string;
  name: string;
  onSettings: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]" data-dashboard-project-id={projectId}>
      <header className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold">{name}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title="Project settings"
            onClick={onSettings}
            className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
          ><Cog className="h-4 w-4" /></button>
          {/* Shared per-agent "Open repo with X" + New worktree menu —
              same component the sidebar uses, so the option list stays
              identical everywhere. */}
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                title="New task"
                className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] data-[state=open]:bg-[var(--color-bg-3)] data-[state=open]:text-[var(--color-fg)]"
              ><Plus className="h-4 w-4" /></button>
            </DropdownTrigger>
            <DropdownMenu align="end" sideOffset={4} className="w-[276px]">
              <ProjectActionsMenuItems projectId={projectId} />
            </DropdownMenu>
          </DropdownRoot>
        </div>
      </header>
      {children}
    </div>
  );
}

// The empty state is the biggest thing on a new user's screen and reads as
// actionable, so it IS actionable: same `openNewProject` the "Add project"
// card and both sidebar "+" buttons call.
function EmptyProjectsCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      data-testid="empty-projects-card"
      onClick={onClick}
      className="flex w-full flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-1)] p-8 text-center transition-colors hover:border-[var(--color-accent-soft)] hover:bg-[var(--color-bg-2)]"
    >
      <Boxes className="h-8 w-8 text-[var(--color-fg-faint)]" />
      <div>
        <div className="text-[14px] font-semibold">No projects yet</div>
        <div className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">
          Add a git repo from disk to spawn agent tasks in.
        </div>
      </div>
    </button>
  );
}
