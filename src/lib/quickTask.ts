// Quick task creation shared by the sidebar `+` menu inline row and the
// Custom command dialog. "Quick" = create straight from a name (and, for
// worktrees, an auto-generated branch) without the full New Task modal.
//
// The mode ("worktree" vs "repo_root" / main checkout) is remembered
// app-wide in one localStorage key — the SAME key the New Task dialog reads
// and writes, so the toggle, the dialog, and "Advanced…" all agree on the
// last choice.

import { taskCreate, taskOpenRepo } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { launchSetupTab } from "@/lib/runTabs";
import { slugify, branchify } from "@/lib/utils";
import type { Task } from "@/lib/types";

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

  let task: Task;
  if (mode === "repo_root") {
    // Main checkout: no worktree, open the agent/shell/custom in the repo's
    // live checkout (same IPC the "Run in repo" rows have always used).
    task = await taskOpenRepo(projectId, cli, trimmedName, command);
  } else {
    task = await taskCreate({
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
    });
  }

  await useApp.getState().loadAll();
  useApp.getState().setActiveTask(task.id);
  // Worktrees run their setup script in the background (unfocused) so the
  // main agent keeps focus. Main-checkout tasks have no per-task setup.
  if (mode === "worktree") launchSetupTab(task.id, { focus: false }).catch(() => {});
  return task;
}
