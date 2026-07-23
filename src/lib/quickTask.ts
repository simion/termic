// Quick task creation shared by the sidebar `+` menu inline row and the
// Custom command dialog. "Quick" = create straight from a name (and, for
// worktrees, an auto-generated branch) without the full New Task modal.
//
// The mode ("worktree" vs "repo_root" / main checkout) is remembered
// app-wide in one localStorage key — the SAME key the New Task dialog reads
// and writes, so the toggle, the dialog, and "Advanced…" all agree on the
// last choice.

import { taskCreate, taskOpenRepo, taskImportWorktree } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { launchSetupTab } from "@/lib/runTabs";
import { withCreateLock } from "@/lib/createLock";
import { slugify, branchify } from "@/lib/utils";
import type { SandboxMode, Task } from "@/lib/types";

export type NewTaskMode = "worktree" | "repo_root";

const LS_LAST_MODE = "newTaskLastMode";

/** Read the app-wide remembered new-task mode. Defaults to "repo_root" (the
 *  main checkout) when nothing is stored: most people start in their main
 *  checkout and reach for worktrees later, so that's the gentler default. */
export function readNewTaskMode(): NewTaskMode {
  try {
    const v = localStorage.getItem(LS_LAST_MODE);
    return v === "worktree" ? "worktree" : "repo_root";
  } catch {
    return "repo_root";
  }
}

/** Persist the app-wide new-task mode. Shared with NewTaskDialog. */
export function writeNewTaskMode(mode: NewTaskMode) {
  try { localStorage.setItem(LS_LAST_MODE, mode); } catch {}
}

/** Auto-derive a worktree branch from the task name, matching the New Task
 *  dialog exactly: an already-qualified name (contains "/") is branchified
 *  as-is; otherwise `<branchPrefix>/<slug>` (a blank prefix yields a bare
 *  slug). This is what we seed the editable branch field with. */
export function derivedBranch(name: string, branchPrefix: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (trimmed.includes("/")) return branchify(trimmed);
  const prefix = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
  const slug = slugify(trimmed);
  return prefix ? `${prefix}/${slug}` : slug;
}

/** Bump an auto-derived branch past names already taken in the repo.
 *  `git branch --no-track` on an existing name either fails or silently
 *  checks out stale commits (issue #129). If the base ends in `-<n>` we
 *  bump that number; otherwise append `-2`, `-3`, ... until free. Shared
 *  by the New Task dialog and the CLI's new_task handler; only
 *  auto-filled defaults are adjusted, never a branch the user typed
 *  (empty `existing` short-circuits). */
export function uniqueBranch(base: string, existing: string[]): string {
  if (!base || existing.length === 0) return base;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  const m = base.match(/^(.*)-(\d+)$/);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** Map a sandbox mode string ("off" | "monitor" | "enforce" |
 *  "enforce-fs") onto task-create pins. Anything else (absent flag,
 *  unknown string) returns undefined: leave the pins unset so Rust
 *  applies the project seeds, exactly like the GUI's quick path.
 *  Shared by the CLI's new_task handler. */
export function sandboxPins(
  sandbox: unknown,
): { sandbox_enabled: boolean; sandbox_mode: SandboxMode } | undefined {
  if (sandbox === "off") return { sandbox_enabled: false, sandbox_mode: "off" };
  if (sandbox === "monitor" || sandbox === "enforce" || sandbox === "enforce-fs") {
    return { sandbox_enabled: true, sandbox_mode: sandbox };
  }
  return undefined;
}

/** Create a task in the given mode and focus it. Worktree tasks also fire
 *  their setup script as an unfocused background tab (same as the dialog).
 *  `command` is only meaningful for `cli === "custom"`. `branch` (worktree
 *  only) falls back to the Rust-side slug when blank. */
export async function createQuickTask(opts: {
  projectId: string;
  mode: NewTaskMode;
  cli: string;
  name: string;
  branch?: string;
  command?: string;
}): Promise<Task> {
  const { projectId, mode, cli, name } = opts;
  const trimmedName = name.trim();
  const command = opts.command?.trim() || undefined;

  // A worktree name that slugs to "" (all punctuation) is invalid: the branch
  // and the worktree dir derive from the slug, and an empty dir name is a
  // data-loss footgun on the Rust side. Reject early with a clear message.
  // (Main checkout uses the live repo dir, not a slug, so it's exempt.)
  if (mode === "worktree" && slugify(trimmedName) === "") {
    throw new Error("Task name must contain at least one letter or number.");
  }

  // Creates serialize behind the app-wide lock (createLock.ts): git
  // worktree add contends on the repo index, and task_create's orphan
  // cleanup makes interleaved same-name creates destructive.
  let task: Task;
  if (mode === "repo_root") {
    // Main checkout: no worktree, open the agent/shell/custom in the repo's
    // live checkout (same IPC the "Run in repo" rows have always used). The
    // quick path stays uncaged (no sandbox arg); the advanced dialog is where
    // you opt into one.
    task = await withCreateLock(() =>
      taskOpenRepo(projectId, cli, trimmedName, undefined, command),
    );
  } else {
    task = await withCreateLock(() =>
      taskCreate({
        id: crypto.randomUUID(),
        project_id: projectId,
        name: trimmedName,
        cli,
        base_branch: null,
        branch: opts.branch?.trim() || undefined,
        // Sandbox pins are left unset so Rust falls back to the project's
        // defaults (quick create doesn't expose the sandbox panel — that's
        // what "Advanced…" is for).
        custom_command: cli === "custom" ? (command ?? null) : undefined,
      }),
    );
  }

  await useApp.getState().loadAll();
  useApp.getState().setActiveTask(task.id);
  // Worktrees run their setup script in the background (unfocused) so the
  // main agent keeps focus. Main-checkout tasks have no per-task setup.
  if (mode === "worktree") launchSetupTab(task.id, { focus: false }).catch(() => {});
  return task;
}

/** Adopt an existing git worktree as a task and focus it, straight from the
 *  launcher menu (issue #92). Name and CLI are left unset so Rust derives
 *  them (branch name / dir basename, and the project's default CLI). No setup
 *  script: the worktree already exists and is presumed set up. */
export async function importQuickWorktree(projectId: string, path: string): Promise<Task> {
  // Import runs git worktree list/prune and the port math; serialize it
  // with every other create (createLock.ts).
  const task = await withCreateLock(() => taskImportWorktree(projectId, path));
  await useApp.getState().loadAll();
  useApp.getState().setActiveTask(task.id);
  return task;
}
