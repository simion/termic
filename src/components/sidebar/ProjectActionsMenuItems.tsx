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
import { taskImportableWorktrees, taskRestore } from "@/lib/ipc";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { GitBranch, GitBranchPlus, Link2, TerminalSquare, SquareChevronRight, Settings2, FolderGit2, Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ImportableWorktree } from "@/lib/types";

/** Coarse relative label for an archived-task timestamp. Unlike the tab
 *  strip's Resume entries (always seconds/minutes old), a task can sit
 *  archived for a long time, so this scales from minutes up through a
 *  short date instead of capping at hours. */
function relativeArchivedTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
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
  // user leave to the full History page. Keep the Resume list short (a couple
  // of most-recent) so the menu stays a launcher, not a history list; "More…"
  // covers the rest.
  const RESUME_LIMIT = 2;
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
          .catch(err => console.error("quick terminal failed:", err));
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
              importQuickWorktree(projectId, wt.path)
                .catch(err => console.error("task_import_worktree failed:", err));
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
          without leaving the sidebar. "More…" hands off to the full page
          for anything past the first few. */}
      {archivedTasks.length > 0 && (
        <>
          <DropdownSeparator />
          <DropdownLabel>Resume</DropdownLabel>
          {archivedTasks.map(t => {
            const iconId = resolveIconId(t.cli, agents);
            return (
              <DropdownItem key={t.id} onSelect={async () => {
                try {
                  const restored = await taskRestore(t.id);
                  await loadAll();
                  setActiveTask(restored.id);
                } catch (err) {
                  console.error("task_restore failed:", err);
                }
              }}>
                <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
                  <CliIcon cli={iconId} className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{t.name}</div>
                  <div className="text-[11px] text-[var(--color-fg-faint)]">{relativeArchivedTime(t.archived_at ?? t.created)}</div>
                </div>
              </DropdownItem>
            );
          })}
          {hasMoreArchived && (
            <DropdownItem onSelect={() => setView("history")}>
              More…
            </DropdownItem>
          )}
        </>
      )}
    </>
  );
}
