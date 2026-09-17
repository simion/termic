// The two hand-written things on a task record, and every predicate the UI
// branches on to expose them. `taskPhase.ts` derives; this file renders and
// decides which control to draw, which is a different job and deliberately a
// different file.
//
// It exists because the surfaces that need these answers (the New Task dialog,
// the sidebar task menu, the command palette, the dashboard row) are all React
// components, and vitest here runs `src/**/*.test.ts` in a node environment:
// a predicate written inline in a `.tsx` is a predicate nothing can cover. So
// the rule lives here and the components call it.
//
// GOAL is text, not a state. It records what the task is FOR, it feeds no rule
// in `taskPhase`, and a task with a goal and no `started_at` is what the UI
// draws as Planned (see the header of src/lib/taskPhase.ts on why Planned is
// rendered rather than derived).
//
// PARKED is the one hand-set phase input, and it is allowed to be one because
// it has no live twin and clears itself: `markStarted` wipes `parked_at` on the
// next prompt into any terminal. Nothing here sets it; `useApp.setTaskParked`
// does, and the only thing this file owns is what the menu is called.

import type { Agent, Task } from "./types";
import { isTerminalCli } from "./agents";

/** Trim a typed note, collapsing a box holding only spaces to `""`.
 *
 *  MIRRORS `normalizeTaskNote` in src/store/app.ts and `normalize_task_note`
 *  in src-tauri/src/lib.rs, which is where `null` comes from. Those two are
 *  the write path and answer with `null`; this is the READ path and answers
 *  with `""`, because every caller here is asking "is there one" or rendering
 *  it. Keep the three in step: a goal of `"   "` must not make a row look
 *  planned while the store treats it as absent. */
export function noteText(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/** The task's goal as text, `""` when it has none. */
export function taskGoalText(task: Pick<Task, "goal">): string {
  return noteText(task.goal);
}

/** The park reason as text, `""` when there is none. Optional even on a
 *  parked task: parking without saying why is the common case. */
export function parkReasonText(task: Pick<Task, "park_reason">): string {
  return noteText(task.park_reason);
}

export function isParked(task: Pick<Task, "parked_at">): boolean {
  return !!task.parked_at;
}

/** One menu row, two labels, following the record. Park opens a dialog for
 *  the optional reason; unpark is immediate, because there is nothing to
 *  ask. */
export function parkMenuLabel(task: Pick<Task, "parked_at">): string {
  return isParked(task) ? "Unpark task" : "Park task";
}

/** Whether this cli has a prompt box at all.
 *
 *  The same test `NewTaskDialog`'s `canPrompt` makes, restated here because
 *  the sidebar and the palette need it too. A plain shell or a registry
 *  terminal (docker, ssh) has nothing to type a goal AT: delivering one would
 *  paste prose into a shell and press Return on it. */
export function cliCanPrompt(cli: string, agents?: Agent[]): boolean {
  // `agents` is threaded through rather than dropped: `isTerminalCli` defaults
  // it to the LIVE registry, and passing `undefined` hits that default, so a
  // caller that already has the list in hand (the sidebar row, which holds one
  // for its icons) spends no store read per menu.
  return cli !== "shell" && !isTerminalCli(cli, agents);
}

/** Show "Start with goal"?
 *
 *  Three conditions, and each rules out a real case: there has to BE a goal
 *  (nothing to send otherwise), nothing may have started yet (the row exists
 *  to start a planned task, and after `started_at` the agent is already the
 *  place to type), and the agent has to have a prompt box.
 *
 *  It goes away on its own, because delivering the goal ends in `markStarted`
 *  (see seedPromptWhenReady) and that stamps `started_at`. Nothing clears the
 *  goal: it stays as the record of what the task is for. */
export function canStartWithGoal(
  task: Pick<Task, "goal" | "started_at" | "cli">,
  agents?: Agent[],
): boolean {
  return !!taskGoalText(task) && !task.started_at && cliCanPrompt(task.cli, agents);
}

/** Which branch the New Task dialog's prompt box took. Returned so the
 *  decision is assertable without rendering the dialog. */
export type FirstMessageOutcome = "seeded" | "goal" | "none";

/** What Create does with the prompt box, in one place for all three create
 *  paths (worktree, repo-root, import).
 *
 *  Unchecked is the behaviour that always existed: the text is typed at the
 *  agent once it boots, which stamps `started_at` and makes the task In
 *  progress from birth. "Start later" is the point of the whole feature: it
 *  writes the same text down as the task's GOAL and sends nothing, so the
 *  task stays Todo with a record of what it is for. Everything else about
 *  create is unchanged either way, worktree and agent included.
 *
 *  A blank box does nothing on either branch. `seedPromptWhenReady` already
 *  no-ops on empty, and `setTaskGoal` would bail on an unchanged value, but
 *  answering "none" here keeps that a fact this file states rather than one
 *  two other modules happen to agree on. */
export function deliverFirstMessage(
  taskId: string,
  opts: { prompt: string; canPrompt: boolean; startLater: boolean },
  sinks: {
    seed: (taskId: string, prompt: string) => void;
    setGoal: (taskId: string, goal: string) => void;
  },
): FirstMessageOutcome {
  // No prompt box means the text was never offered, so there is nothing to
  // deliver and nothing to write down: the field is hidden under exactly this
  // condition, and so is the Start later checkbox beside it.
  if (!opts.canPrompt) return "none";
  const text = noteText(opts.prompt);
  if (!text) return "none";
  if (opts.startLater) {
    sinks.setGoal(taskId, text);
    return "goal";
  }
  sinks.seed(taskId, text);
  return "seeded";
}
