// Shared dropdown body for project-level "new task" actions. A [Worktree |
// Main checkout] toggle at the top picks the mode (remembered app-wide);
// below it, one list of agents + Terminal + Custom command creates a task in
// that mode, and "Advanced…" opens the full New Task modal. Used in the
// sidebar's project-row `+` icon, the sidebar's empty-project placeholder
// CTA, and the dashboard project card header.
//
// Wrap in a `<DropdownMenu>` at the call site; this component renders only
// the items (so the caller can also customize positioning).

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { projectSandboxDefault, projectYoloDefault, yoloForCreate } from "@/lib/projectSandboxDefault";
import { usePrefs } from "@/store/prefs";
import { SandboxIcon, DockerSandboxIcon, sandboxPickerLabelT } from "@/components/SandboxIcon";
import { selectionToFields } from "@/lib/types";
import { useUI } from "@/store/ui";
import { defaultCliFirst, visibleCliIds } from "@/lib/agents";
import { importQuickWorktree, readNewTaskMode, writeNewTaskMode, type NewTaskMode } from "@/lib/quickTask";
import { taskImportableWorktrees, taskRestore, projectBranchContext, projectUpdate } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { DropdownItem, DropdownSeparator, DropdownSub, DropdownSubTrigger, DropdownSubContent } from "@/components/ui/Dropdown";
import { GitBranch, GitBranchPlus, Link2, TerminalSquare, SquareChevronRight, Settings2, FolderGit2, Flag, Check, ChevronRight, History, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Agent, BranchContext, ImportableWorktree, Project } from "@/lib/types";

/** One row of the agent list: a registry entry, or the synthetic Terminal
 *  (cli = "shell") entry, which has no registry record of its own. */
type LauncherRow = Pick<Agent, "id" | "display_name"> & Partial<Pick<Agent, "icon_id">>;

/** Compact "10m" / "17h" / "2d" label for an archived-task timestamp.
 *  Unlike the tab strip's Resume entries (always seconds/minutes old), a
 *  task can sit archived for a long time, so this scales up through a
 *  short date instead of capping at hours. Terse on purpose: it sits
 *  inline before the row's title, one row per line. */
function relativeArchivedTime(iso: string, now: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return now;
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}

/** Small section header: uppercase label + one-line explanation. Used for
 *  the non-git "RUN IN FOLDER" case, where there's no worktree/main choice
 *  to make. Not a dropdown menu item — pure visual, doesn't trap focus. */
function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-2 pb-1 pt-1.5">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">{title}</div>
      <div className="text-[11.5px] leading-snug text-[var(--color-fg-dim)]">{hint}</div>
    </div>
  );
}

/** `onPick`: when provided, picking an agent/shell hands (cli, mode) back to
 *  the caller instead of creating immediately — the sidebar uses this to show
 *  an inline name (+ branch, for worktrees) prompt before create. Without it
 *  (e.g. the dashboard) picks fall back to the full New Task modal. */
export function ProjectActionsMenuItems({ projectId, onPick }: {
  projectId: string;
  onPick?: (cli: string, mode: NewTaskMode) => void;
}) {
  const { t } = useTranslation("sidebar");
  // Sandbox mode names live in the chrome namespace (SandboxIcon's table).
  const { t: tChrome } = useTranslation("chrome");
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const openNewTask = useUI(s => s.openNewTask);
  const openRace = useUI(s => s.openRace);
  const openCustomCommand = useUI(s => s.openCustomCommand);
  const setActiveTask = useApp(s => s.setActiveTask);
  const loadAll = useApp(s => s.loadAll);
  const setView = useApp(s => s.setView);
  const tasks = useApp(s => s.tasks);
  // Recently archived tasks for THIS project, most-recent first — same
  // sort HistoryView uses, scoped to one project so the launcher menu can
  // offer a one-click shortcut back into a recent one instead of making the
  // user leave to the full History page. They live in a SUBMENU (like "Branch
  // from"): the top level is a launcher and every extra row there pushes the
  // agents further from the cursor, so the list can be longer once it costs
  // one row. "More…" still covers anything past the limit.
  const RESUME_LIMIT = 5;
  const archivedAll = useMemo(
    () => tasks
      .filter(t => t.project_id === projectId && t.archived)
      .sort((a, b) => (b.archived_at ?? b.created).localeCompare(a.archived_at ?? a.created)),
    [tasks, projectId],
  );
  const archivedTasks = archivedAll.slice(0, RESUME_LIMIT);
  const hasMoreArchived = archivedAll.length > RESUME_LIMIT;
  const project = useApp(s => s.projects.find(p => p.id === projectId));
  // One resolver shared with the settings picker and the create path, so the
  // row cannot claim a cage the created task does not get.
  const sandboxDefault = projectSandboxDefault(project);
  // Whether an AGENT created from this menu starts in YOLO (quickYolo in
  // quickTask.ts applies it). A shell / terminal pick never gets it, which the
  // note's wording ("agents") already covers.
  const appDefaultYolo = usePrefs(s => s.defaultYolo);
  const yoloDefault = yoloForCreate(projectYoloDefault(project, appDefaultYolo), sandboxDefault, true);
  const isMulti = (project?.type ?? "single") === "multi";
  // Non-git projects (issue #4) have no branches / worktrees — the only way
  // in is the main checkout (agent at the folder root). Force that mode and
  // drop the toggle.
  const isNonGit = !!project?.non_git;
  // "No git here" and "no worktrees here" are the same thing for ONE repo and
  // not for a multi-repo project: its members are their own git repos and get
  // their own worktrees, while the plain-folder host just becomes the wrapper
  // dir (`task_create_multi` builds it and symlinks the shared CLAUDE.md /
  // .claude in). What a non-git host really loses is the host-level "Branch
  // from" pin below, which needs host branches; that one stays on `isNonGit`.
  const canWorktree = !isNonGit || isMulti;
  const visibleClis = visibleCliIds(agents.map(a => a.id), agents, detectedClis);
  // The launcher rows: every offered agent plus Terminal, with THIS project's
  // default CLI hoisted to the top. It is the pick behind most opens of this
  // menu, and pinning it to the first row means it stays put when the agent
  // registry is reordered in Settings. Terminal takes part: a repo whose
  // default is a plain shell gets the same treatment.
  const SHELL_ROW: LauncherRow = { id: "shell", display_name: t("projectActions.terminal") };
  const launcherRows = defaultCliFirst(
    [...agents.filter(a => visibleClis.has(a.id)), SHELL_ROW],
    project?.default_cli,
  );

  // Worktrees the user made outside termic (`git worktree add`) that aren't
  // open as tasks yet (issue #92). Adopting one is a single click here — the
  // New Task dialog's import mode is the long way round, and nobody found it.
  // Only single-repo git projects: import can't compose a multi-repo task.
  // The menu is unmounted while closed, so this runs on open (a cheap
  // `git worktree list`, no working-tree scan) and never goes stale.
  const canImport = !isNonGit && !isMulti;
  // Same reasoning as RESUME_LIMIT above: behind a submenu this costs ONE row
  // in the launcher however many worktrees are listed, so the list can be as
  // long as the Resume one. It was 3 while every entry pushed the agents
  // further from the cursor.
  const IMPORT_LIMIT = 5;
  const [importable, setImportable] = useState<ImportableWorktree[]>([]);
  useEffect(() => {
    if (!canImport) return;
    let cancelled = false;
    taskImportableWorktrees(projectId)
      .then(list => { if (!cancelled) setImportable(list.filter(wt => !wt.locked)); })
      .catch(err => console.error("task_importable_worktrees failed:", err));
    return () => { cancelled = true; };
  }, [canImport, projectId]);

  // Branch context for the "Branch from" row: which branch the main checkout
  // is on right now, plus the refs offered as pins. Loaded on menu open (the
  // menu is unmounted while closed, so it can't go stale) for every git
  // project, not just worktree mode — flipping the toggle should reveal the
  // row already filled in, not blank for a frame.
  const [branches, setBranches] = useState<BranchContext | null>(null);
  useEffect(() => {
    if (isNonGit) return;
    let cancelled = false;
    projectBranchContext(projectId)
      .then(ctx => { if (!cancelled) setBranches(ctx); })
      .catch(err => console.error("project_branch_context failed:", err));
    return () => { cancelled = true; };
  }, [isNonGit, projectId]);

  // The pinned base IS what a worktree task branches from — no second mode.
  // Mirrors `task_base_branch` in Rust, which is the source of truth.
  const head = branches?.head ?? null;
  const pinnedBase = project?.base_branch ?? "";

  // ONE flat list, the pinned entry included and checked. An earlier cut
  // promoted the pin into its own "Project default" row and filtered it out of
  // the list, which meant two places to look for one thing. Local branches
  // first (that's where you actually live), then remote-tracking, each in the
  // order git returned them. The pin is force-included even if the ref has
  // since been deleted, so the checkmark always has a home.
  const choices = useMemo(() => {
    const all = branches ? [...branches.local, ...branches.remote] : [];
    if (pinnedBase && !all.includes(pinnedBase)) all.unshift(pinnedBase);
    return all;
  }, [branches, pinnedBase]);

  const applyBase = (patch: Partial<Project>) => {
    if (!project) return;
    projectUpdate({ ...project, ...patch })
      .then(() => loadAll())
      .catch(err => console.error("project_update failed:", err));
  };

  // App-wide remembered mode (same key the New Task dialog uses). A project
  // that can't worktree is pinned to the main checkout.
  const [mode, setModeState] = useState<NewTaskMode>(() => (canWorktree ? readNewTaskMode() : "repo_root"));
  const setMode = (m: NewTaskMode) => { setModeState(m); writeNewTaskMode(m); };

  // Open the full New Task modal in the current mode. Fallback when there's
  // no inline host (dashboard) and the path for multi-repo worktrees, which
  // need per-member config the inline row can't provide. Don't persist the
  // mode for a project that can't worktree: its mode is force-pinned to
  // repo_root, so writing it would clobber the user's real app-wide
  // preference.
  const openAdvanced = () => {
    if (canWorktree) writeNewTaskMode(mode);
    requestAnimationFrame(() => openNewTask(projectId));
  };

  // Pick an agent / shell in the current mode: inline when the host supports
  // it, else the modal. Multi-repo worktrees always go to the modal.
  const pick = (cli: string) => {
    if (mode === "worktree" && isMulti) { openAdvanced(); return; }
    if (onPick) { onPick(cli, mode); return; }
    openAdvanced();
  };

  return (
    <>
      {!canWorktree ? (
        <SectionHeader title={t("projectActions.runInFolder")} hint={t("projectActions.runInFolderHint")} />
      ) : (
        <div className="px-2 pb-1.5 pt-1.5">
          {/* Mode toggle. Main checkout comes first and is the default: most
              people start in their main checkout and reach for worktrees
              later. Both halves share the width evenly (flex-1) so the tabs
              are equal, and both use the same active color. Plain buttons (not
              menu items) so clicking one flips the mode without closing the
              dropdown. */}
          <div className="flex w-full items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            <button
              type="button"
              onClick={() => setMode("repo_root")}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 text-[12.5px] whitespace-nowrap transition-colors",
                mode === "repo_root"
                  ? "bg-[var(--color-accent-deep)] text-white"
                  : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
              )}
            >
              <Link2 className="h-3.5 w-3.5 shrink-0" /> {t("projectActions.mainCheckout")}
            </button>
            <button
              type="button"
              onClick={() => setMode("worktree")}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 text-[12.5px] whitespace-nowrap transition-colors",
                mode === "worktree"
                  ? "bg-[var(--color-accent-deep)] text-white"
                  : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
              )}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" /> {t("projectActions.worktree")}
            </button>
          </div>
          <div className="px-0.5 pt-1 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
            {mode === "worktree"
              ? (isMulti
                  ? t("projectActions.worktreeDescMulti")
                  : t("projectActions.worktreeDescSingle"))
              : (isMulti
                  ? t("projectActions.mainDescMulti")
                  : t("projectActions.mainDescSingle"))}
          </div>

          {/* What cage this project's new tasks get, stated where the task is
              actually created. The quick path applies the project default
              silently otherwise, and on the main checkout that means a cage
              over your REAL files with nothing on screen having said so. The
              mode's own icon is used, so this row and the sandbox picker are
              recognisably the same thing. Hidden when the default is "off":
              uncaged is the baseline, and a row saying so on every menu open
              is noise. */}
          {sandboxDefault !== "off" && (
            <div
              data-testid="quick-create-sandbox-note"
              data-sandbox-default={sandboxDefault}
              className="mt-1 flex items-center gap-1.5 px-0.5 text-[11.5px] leading-snug text-[var(--color-fg-dim)]"
            >
              {sandboxDefault === "docker"
                ? <DockerSandboxIcon className="h-3 w-3 shrink-0" />
                : <SandboxIcon mode={selectionToFields(sandboxDefault).mode} className="h-3 w-3 shrink-0" />}
              <span>
                {t("projectActions.sandboxedNote")}{" "}
                <span className="text-[var(--color-fg)]">
                  {sandboxDefault === "docker" ? "Docker" : sandboxPickerLabelT(selectionToFields(sandboxDefault).mode, tChrome)}
                </span>
              </span>
            </div>
          )}

          {/* Same disclosure for YOLO, for the same reason: the quick path has
              no checkbox to show the default in, so without this line it
              would switch approvals off with nothing on screen saying so.
              Red Zap, the sidebar row's own mark. Hidden when off (the
              baseline) and when the cage above already turns YOLO on. */}
          {yoloDefault && (
            <div
              data-testid="quick-create-yolo-note"
              className="mt-1 flex items-center gap-1.5 px-0.5 text-[11.5px] leading-snug text-[var(--color-fg-dim)]"
            >
              <Zap className="h-3 w-3 shrink-0 text-[var(--color-err)]" fill="currentColor" />
              <span>
                YOLO: <span className="text-[var(--color-fg)]">agents skip their permission prompts</span>
              </span>
            </div>
          )}

          {/* Where the worktree gets cut from. Doubles as the disclosure: the
              quick path used to silently use the project default (detected as
              origin/main when the project was added) with nothing on screen
              saying so. Worktree mode only, since the main checkout has no
              base to branch from. The choice is per project, in projects.json,
              because each repo has its own convention. A plain-folder multi
              host has no branches of its own to pin (its members carry their
              own), so it gets the toggle above but not this row. */}
          {mode === "worktree" && !isNonGit && (
            <DropdownSub>
              <DropdownSubTrigger className="mt-1.5 w-full justify-between gap-2">
                <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  <GitBranchPlus className="h-3.5 w-3.5 shrink-0" />
                  {t("projectActions.branchFrom")}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[12px] text-[var(--color-fg)]">
                    {pinnedBase || t("projectActions.repoDefault")}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                </span>
              </DropdownSubTrigger>
              <DropdownSubContent className="max-w-[280px]">
                {choices.length === 0 && (
                  <DropdownItem disabled>
                    <span className="text-[12.5px] text-[var(--color-fg-faint)]">
                      {t("projectActions.noBranches")}
                    </span>
                  </DropdownItem>
                )}
                {/* Pick a branch, it's remembered as this project's base. That's
                    the whole model: one list, one action. `preventDefault`
                    keeps the menu open, since picking a base is a setup step
                    and the user still has to pick an agent after. */}
                {choices.map(b => (
                  <DropdownItem
                    key={b}
                    onSelect={e => { e.preventDefault(); applyBase({ base_branch: b }); }}
                  >
                    <Check className={cn("h-4 w-4 shrink-0", b === pinnedBase ? "opacity-100" : "opacity-0")} />
                    <span className="truncate font-mono text-[12.5px]">{b}</span>
                    {/* Whichever ref the main checkout is on. A hint, not a
                        mode: it's still just a pin, so the base can't change
                        under you when you switch branches. */}
                    {b === head && (
                      <span className="ml-auto shrink-0 pl-2 text-[11px] text-[var(--color-fg-faint)]">
                        {t("projectActions.currentTag")}
                      </span>
                    )}
                  </DropdownItem>
                ))}
              </DropdownSubContent>
            </DropdownSub>
          )}
        </div>
      )}

      {/* Terminal (the plain login shell) is one of these rows, not a
          special case appended at the end: it goes through the same inline
          name prompt as an agent in both modes, so a Main-checkout shell
          gets a real name instead of whatever Rust auto-assigns. */}
      {launcherRows.map(a => (
        // data-launcher-cli: the rows all render the same shape, so e2e needs
        // a handle that survives a display-name change (and says which id a
        // row actually launches).
        <DropdownItem key={a.id} data-launcher-cli={a.id} onSelect={() => pick(a.id)}>
          {a.id === "shell" ? (
            <TerminalSquare className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
          ) : (
            <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(a.id, agents)] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={resolveIconId(a.id, agents)} className="h-4 w-4" />
            </span>
          )}
          <span className="truncate">{a.display_name}</span>
          {/* Says WHY this row is first, so the order doesn't read as random
              once someone reorders their agents in Settings. */}
          {a.id === project?.default_cli && (
            <span className="ml-auto shrink-0 pl-2 text-[11px] text-[var(--color-fg-faint)]">
              {t("projectActions.defaultTag")}
            </span>
          )}
        </DropdownItem>
      ))}

      {/* Custom command needs a name + a command, so it always opens the
          dialog (which now respects worktree vs main-checkout mode). */}
      <DropdownItem onSelect={() => {
        if (mode === "worktree" && isMulti) { openAdvanced(); return; }
        openCustomCommand(projectId, mode);
      }}>
        <SquareChevronRight className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{t("projectActions.customCommand")}</span>
          <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
            {t("projectActions.customCommandHint")}
          </span>
        </div>
      </DropdownItem>

      {/* Agent Race: one prompt, several agents, each in its own worktree.
          Single-repo git projects only (needs worktree isolation); multi-repo
          is a later slice. Defers a frame like openAdvanced so the dropdown's
          focus teardown doesn't steal the dialog's autofocus. */}
      {!isNonGit && !isMulti && (
        <DropdownItem onSelect={() => requestAnimationFrame(() => openRace(projectId))}>
          <Flag className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{t("projectActions.startRace")}</span>
            <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
              {t("projectActions.startRaceHint")}
            </span>
          </div>
        </DropdownItem>
      )}

      <DropdownSeparator />

      {!canWorktree ? (
        // Keep the worktree option VISIBLE but disabled + explained rather
        // than silently absent, so the user knows why it's missing.
        <DropdownItem disabled>
          <GitBranchPlus className="h-4 w-4 text-[var(--color-fg-faint)]" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{t("projectActions.worktreesUnavailable")}</span>
            <span className="text-[11.5px] text-[var(--color-fg-faint)]">
              {t("projectActions.worktreesUnavailableHint")}
            </span>
          </div>
        </DropdownItem>
      ) : (
        // Defer one frame: this fires inside a Radix DropdownMenu close, whose
        // focus-teardown runs AFTER onSelect. Opening the dialog synchronously
        // lets that teardown steal focus from the autofocused input. rAF lets
        // the menu settle (openAdvanced wraps the rAF).
        <DropdownItem onSelect={openAdvanced}>
          <Settings2 className="h-4 w-4 text-[var(--color-fg-dim)]" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{t("projectActions.advanced")}</span>
            <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
              {mode === "worktree"
                ? t("projectActions.advancedWorktreeHint")
                : t("projectActions.advancedMainHint")}
            </span>
          </div>
        </DropdownItem>
      )}
      {/* Import and Resume are one group: two errands that reach for something
          that ALREADY exists, each behind one row. Both self-hide when they
          have nothing to offer, so the separator belongs to whichever of them
          renders rather than to either one of them. */}
      {(importable.length > 0 || archivedTasks.length > 0) && <DropdownSeparator />}

      {/* Existing worktrees, one click to adopt. Named by branch (Rust derives
          the task name + CLI), so there's nothing to fill in. Past the first
          few, hand off to the dialog's import mode — the only thing that ever
          sets the `importMode` seed.
          A SUBMENU, like Resume beside it: as a flat section this spent a
          label plus a row per worktree at the top level, pushing the agents
          (the thing the menu is for) down the list on exactly the projects
          that have the most worktrees. */}
      {importable.length > 0 && (
        <DropdownSub>
          <DropdownSubTrigger data-testid="import-worktree-sub" className="w-full justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <FolderGit2 className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
              <span className="truncate">{t("projectActions.importWorktree")}</span>
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          </DropdownSubTrigger>
          <DropdownSubContent className="max-w-[320px]">
            {importable.slice(0, IMPORT_LIMIT).map(wt => (
              <DropdownItem key={wt.path} onSelect={() => {
                // Failures must be visible: this one-click path has no dialog
                // to show them, and a silent no-op reads as a broken button
                // (e.g. the derived-name collision error, GH #169 review).
                importQuickWorktree(projectId, wt.path)
                  .catch(err => useUI.getState().pushToast(String(err), "error"));
              }}>
                <FolderGit2 className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {wt.branch || <span className="italic text-[var(--color-fg-dim)]">{t("projectActions.detached", { head: wt.head })}</span>}
                  </div>
                  <div className="truncate text-[11px] text-[var(--color-fg-faint)]">{wt.path}</div>
                </div>
              </DropdownItem>
            ))}
            {importable.length > IMPORT_LIMIT && (
              <DropdownItem onSelect={() => {
                requestAnimationFrame(() => openNewTask(projectId, { importMode: true }));
              }}>
                {t("projectActions.more")}
              </DropdownItem>
            )}
          </DropdownSubContent>
        </DropdownSub>
      )}

      {/* Recently archived tasks for this project — a shortcut to
          HistoryView's restore (same task_restore IPC + setActiveTask)
          without leaving the sidebar. One row that opens the list, the same
          shape as "Branch from": resuming is an occasional errand, and it was
          costing the launcher several rows every time the project had history.
          "More…" hands off to the full page for anything past the limit. */}
      {archivedTasks.length > 0 && (
          <DropdownSub>
            <DropdownSubTrigger data-testid="resume-sub" className="w-full justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <History className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
                <span className="truncate">{t("projectActions.resume")}</span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
            </DropdownSubTrigger>
            <DropdownSubContent className="max-w-[320px]">
              {archivedTasks.map(task => {
                const iconId = resolveIconId(task.cli, agents);
                return (
                  <DropdownItem key={task.id} onSelect={async () => {
                    try {
                      const restored = await taskRestore(task.id);
                      await loadAll();
                      setActiveTask(restored.id);
                    } catch (err) {
                      // task_restore refuses a live same-name duplicate;
                      // silently doing nothing here reads as a dead button.
                      useUI.getState().pushToast(
                        typeof err === "string" ? err : t("restoreFailed"), "error");
                    }
                  }} className="items-center">
                    <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
                      <CliIcon cli={iconId} className="h-4 w-4" />
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-faint)]">
                      {relativeArchivedTime(task.archived_at ?? task.created, t("projectActions.archivedNow"))}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{task.name}</span>
                  </DropdownItem>
                );
              })}
              {hasMoreArchived && (
                <DropdownItem onSelect={() => setView("history")}>
                  {t("projectActions.more")}
                </DropdownItem>
              )}
            </DropdownSubContent>
          </DropdownSub>
      )}
    </>
  );
}
