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
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { visibleCliIds } from "@/lib/agents";
import { createQuickTask, importQuickWorktree, readNewTaskMode, writeNewTaskMode, type NewTaskMode } from "@/lib/quickTask";
import { taskImportableWorktrees, taskRestore, projectBranchContext, projectUpdate } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { DropdownItem, DropdownLabel, DropdownSeparator, DropdownSub, DropdownSubTrigger, DropdownSubContent } from "@/components/ui/Dropdown";
import { GitBranch, GitBranchPlus, Link2, TerminalSquare, SquareChevronRight, Settings2, FolderGit2, Flag, Check, ChevronRight, History } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BranchContext, ImportableWorktree, Project } from "@/lib/types";

/** Compact "10m" / "17h" / "2d" label for an archived-task timestamp.
 *  Unlike the tab strip's Resume entries (always seconds/minutes old), a
 *  task can sit archived for a long time, so this scales up through a
 *  short date instead of capping at hours. Terse on purpose: it sits
 *  inline before the row's title, one row per line. */
function relativeArchivedTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "now";
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
  const isMulti = (project?.type ?? "single") === "multi";
  // Non-git projects (issue #4) have no branches / worktrees — the only way
  // in is the main checkout (agent at the folder root). Force that mode and
  // drop the toggle.
  const isNonGit = !!project?.non_git;
  const visibleClis = visibleCliIds(agents.map(a => a.id), agents, detectedClis);

  // Worktrees the user made outside termic (`git worktree add`) that aren't
  // open as tasks yet (issue #92). Adopting one is a single click here — the
  // New Task dialog's import mode is the long way round, and nobody found it.
  // Only single-repo git projects: import can't compose a multi-repo task.
  // The menu is unmounted while closed, so this runs on open (a cheap
  // `git worktree list`, no working-tree scan) and never goes stale.
  const canImport = !isNonGit && !isMulti;
  const IMPORT_LIMIT = 3;
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

  // App-wide remembered mode (same key the New Task dialog uses). Non-git
  // can't worktree, so it's pinned to the main checkout.
  const [mode, setModeState] = useState<NewTaskMode>(() => (isNonGit ? "repo_root" : readNewTaskMode()));
  const setMode = (m: NewTaskMode) => { setModeState(m); writeNewTaskMode(m); };

  // Open the full New Task modal in the current mode. Fallback when there's
  // no inline host (dashboard) and the path for multi-repo worktrees, which
  // need per-member config the inline row can't provide. Don't persist the
  // mode for non-git projects: their mode is force-pinned to repo_root, so
  // writing it would clobber the user's real app-wide preference.
  const openAdvanced = () => {
    if (!isNonGit) writeNewTaskMode(mode);
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
      {isNonGit ? (
        <SectionHeader title="RUN IN FOLDER" hint="Launch the agent at the folder root (no git)." />
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
              <Link2 className="h-3.5 w-3.5 shrink-0" /> Main checkout
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
              <GitBranch className="h-3.5 w-3.5 shrink-0" /> Worktree
            </button>
          </div>
          <div className="px-0.5 pt-1 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
            {mode === "worktree"
              ? (isMulti
                  ? "Branch every member into its own working directory, run agents in parallel."
                  : "Isolated branch in its own working directory. Run agents in parallel without touching your main checkout.")
              : (isMulti
                  ? "Host directory with live links to each member's checkout."
                  : "No worktree. Runs in the repo's current branch. Edits land on your real files.")}
          </div>

          {/* Where the worktree gets cut from. Doubles as the disclosure: the
              quick path used to silently use the project default (detected as
              origin/main when the project was added) with nothing on screen
              saying so. Worktree mode only, since the main checkout has no
              base to branch from. The choice is per project, in projects.json,
              because each repo has its own convention. */}
          {mode === "worktree" && (
            <DropdownSub>
              <DropdownSubTrigger className="mt-1.5 w-full justify-between gap-2">
                <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  <GitBranchPlus className="h-3.5 w-3.5 shrink-0" />
                  Branch from
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[12px] text-[var(--color-fg)]">
                    {pinnedBase || "repo default"}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                </span>
              </DropdownSubTrigger>
              <DropdownSubContent className="max-w-[280px]">
                {choices.length === 0 && (
                  <DropdownItem disabled>
                    <span className="text-[12.5px] text-[var(--color-fg-faint)]">
                      No branches found.
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
                        current
                      </span>
                    )}
                  </DropdownItem>
                ))}
              </DropdownSubContent>
            </DropdownSub>
          )}
        </div>
      )}

      {agents.filter(a => visibleClis.has(a.id)).map(a => (
        <DropdownItem key={a.id} onSelect={() => pick(a.id)}>
          <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}>
            <CliIcon cli={a.icon_id} className="h-4 w-4" />
          </span>
          <span className="truncate">{a.display_name}</span>
        </DropdownItem>
      ))}

      {/* Plain login-shell variant. In main-checkout mode a shell has no
          session to resume, so we skip the name prompt and create at once
          (Rust auto-names to the branch). A worktree shell needs a name to
          derive its branch, so it goes through the inline prompt like agents. */}
      <DropdownItem onSelect={() => {
        if (mode === "worktree") { pick("shell"); return; }
        createQuickTask({ projectId, mode: "repo_root", cli: "shell", name: "" })
          // A silent failure reads as a dead menu item; surface it.
          .catch(err => useUI.getState().pushToast(String(err), "error"));
      }}>
        <TerminalSquare className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
        <span className="truncate">Terminal</span>
      </DropdownItem>

      {/* Custom command needs a name + a command, so it always opens the
          dialog (which now respects worktree vs main-checkout mode). */}
      <DropdownItem onSelect={() => {
        if (mode === "worktree" && isMulti) { openAdvanced(); return; }
        openCustomCommand(projectId, mode);
      }}>
        <SquareChevronRight className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate">Custom command</span>
          <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
            ssh, a dev server, a REPL, …
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
            <span className="truncate">Start a race…</span>
            <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
              One prompt, several agents, pick a winner.
            </span>
          </div>
        </DropdownItem>
      )}

      <DropdownSeparator />

      {isNonGit ? (
        // Keep the worktree option VISIBLE but disabled + explained rather
        // than silently absent, so the user knows why it's missing.
        <DropdownItem disabled>
          <GitBranchPlus className="h-4 w-4 text-[var(--color-fg-faint)]" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate">Worktrees unavailable</span>
            <span className="text-[11.5px] text-[var(--color-fg-faint)]">
              {isMulti
                ? "This multi-repo host is a plain folder, not a git repo."
                : "This folder isn't a git repo."} Point the project at a git
              repo (or git-init this folder) to enable worktrees.
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
            <span className="truncate">Advanced…</span>
            <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
              {mode === "worktree"
                ? "Base branch, sandbox, import…"
                : "More options and settings…"}
            </span>
          </div>
        </DropdownItem>
      )}
      {/* Existing worktrees, one click to adopt. Named by branch (Rust derives
          the task name + CLI), so there's nothing to fill in. Past the first
          few, hand off to the dialog's import mode — the only thing that ever
          sets the `importMode` seed. */}
      {importable.length > 0 && (
        <>
          <DropdownSeparator />
          <DropdownLabel>Existing worktrees</DropdownLabel>
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
                  {wt.branch || <span className="italic text-[var(--color-fg-dim)]">detached {wt.head}</span>}
                </div>
                <div className="truncate text-[11px] text-[var(--color-fg-faint)]">{wt.path}</div>
              </div>
            </DropdownItem>
          ))}
          {importable.length > IMPORT_LIMIT && (
            <DropdownItem onSelect={() => {
              requestAnimationFrame(() => openNewTask(projectId, { importMode: true }));
            }}>
              More…
            </DropdownItem>
          )}
        </>
      )}

      {/* Recently archived tasks for this project — a shortcut to
          HistoryView's restore (same task_restore IPC + setActiveTask)
          without leaving the sidebar. One row that opens the list, the same
          shape as "Branch from": resuming is an occasional errand, and it was
          costing the launcher several rows every time the project had history.
          "More…" hands off to the full page for anything past the limit. */}
      {archivedTasks.length > 0 && (
        <>
          <DropdownSeparator />
          <DropdownSub>
            <DropdownSubTrigger className="w-full justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <History className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
                <span className="truncate">Resume</span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
            </DropdownSubTrigger>
            <DropdownSubContent className="max-w-[320px]">
              {archivedTasks.map(t => {
                const iconId = resolveIconId(t.cli, agents);
                return (
                  <DropdownItem key={t.id} onSelect={async () => {
                    try {
                      const restored = await taskRestore(t.id);
                      await loadAll();
                      setActiveTask(restored.id);
                    } catch (err) {
                      // task_restore refuses a live same-name duplicate;
                      // silently doing nothing here reads as a dead button.
                      useUI.getState().pushToast(
                        typeof err === "string" ? err : "Restore failed", "error");
                    }
                  }} className="items-center">
                    <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
                      <CliIcon cli={iconId} className="h-4 w-4" />
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-faint)]">
                      {relativeArchivedTime(t.archived_at ?? t.created)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </DropdownItem>
                );
              })}
              {hasMoreArchived && (
                <DropdownItem onSelect={() => setView("history")}>
                  More…
                </DropdownItem>
              )}
            </DropdownSubContent>
          </DropdownSub>
        </>
      )}
    </>
  );
}
