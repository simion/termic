// What a task's tabs add up to, for the one badge a row gets.
//
// Extracted from Sidebar.tsx so the dashboard draws the SAME badge from the
// SAME inputs. The two surfaces showing a task differently is the class of bug
// the `data-dashboard-task-id` hook was added for (see Dashboard.tsx), and
// there is no reason for a second copy of a three-line precedence rule.
//
// This is the agent's LIVE work state, not a lifecycle status: it answers
// "what is the machine doing right now", it is derived from tab state, and it
// dies with the process. Nothing here is persisted.

import type { Tab } from "./types";

/** The one badge a row draws, or null for "draw nothing".
 *
 *  Precedence: attention > done > working. A blocked agent is more actionable
 *  than a finished one, and both are more actionable than one still chugging.
 *  `cliAgentState.ts` ranks working ABOVE attention for the CLI wire; that
 *  divergence predates this helper and is deliberately not resolved here,
 *  because `TaskSummary.work_state` is a published contract. */
export type WorkBadgeReason = "attention" | "done" | "working" | "delegated";

export interface WorkStatePrefs {
  /** `settledHighlight` — gates the DONE bullet. It used to gate attention
   *  too; the bell has its own switch now, seeded from this one so nobody
   *  who had turned the work-done UI off gets bells back on upgrade. */
  settledHighlight: boolean;
  /** `workingIndicator` — every MID-TURN mark: the spinner, the
   *  background-work ring, and the partially-done dot. They are one family
   *  and one switch, because "show me when an agent is busy" is a single
   *  question and a user who answers no does not then want a ring instead.
   *
   *  Optional because the callers that ask purely about done (the sidebar's
   *  project and group rollup dots) would otherwise have to subscribe to a
   *  pref they do not use. Absent is treated as off, which is correct for
   *  those callers: they never draw a mid-turn mark. */
  workingIndicator?: boolean;
  /** `attentionIndicator` — the bell. Optional for the same reason, and
   *  absent is treated as ON: a caller that does not pass it is asking
   *  "is anything blocked on me", and silently answering no would hide the
   *  one mark that is about the user. */
  attentionIndicator?: boolean;
}

/** Does LOOKING at a tab answer its `unread` mark? Every mark but one.
 *
 *  An agent blocked on the user (a permission prompt, a question) is still
 *  blocked while you read it, so its bell ends when you ANSWER: a key you type
 *  in that terminal, Escape or Ctrl-C, or the agent's own hook ending the turn
 *  (docs/agent-states.md, state 7). Clearing it on sight, as the other marks
 *  are, made a question you had glanced at and left unanswered read as a
 *  finished turn: off the bell, and filed under Settled on the board and in the
 *  sidebar's status section, while the agent sat waiting. */
export function unreadClearsOnSight(unread: { reason: string } | null | undefined): boolean {
  return !!unread && unread.reason !== "attention";
}

/** The agent is explicitly blocked on the user (Gemini "Action Required",
 *  Codex "Waiting", OSC 1337 RequestAttention). */
export const taskNeedsAttention = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  (p.attentionIndicator ?? true)
  && tabs.some(t => t.type === "terminal" && t.unread?.reason === "attention");

/** Some tab just settled: the agent stopped producing output and is waiting.
 *  Distinct from attention — different badge, different urgency. */
export const taskWorkDone = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  p.settledHighlight
  && tabs.some(t => t.type === "terminal" && t.workState === "done");

/** An agent is mid-turn. */
export const taskWorking = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  !!p.workingIndicator
  && tabs.some(t => t.type === "terminal" && t.workState === "working");

/** A tab has work the agent DELEGATED and has not finished (a subagent, a
 *  shell it left running). See `lib/delegatedWork.ts`.
 *
 *  Gated on `settledHighlight` and not on `workingIndicator`, which is the
 *  spinner's own opt-in: this is not a spinner and it is not a claim that
 *  anything is being computed. It says the tab is not inert.
 *
 *  Reported here so the COLLAPSED sidebar row and the dashboard can draw it,
 *  which is the surface that matters: the tab strip only helps in the task you
 *  are already in, and a dev server left running is a thing you go looking
 *  for from outside. */
export const taskDelegated = (tabs: Tab[], p: WorkStatePrefs): boolean =>
  !!taskDelegatedWork(tabs, p);

/** The report itself, for the badge's tooltip and its `partial` flag. The
 *  first tab that has one speaks for the row, which is how every other
 *  aggregate here works. */
export function taskDelegatedWork(tabs: Tab[], p: WorkStatePrefs) {
  // The ring is a mid-turn mark, so it belongs to `workingIndicator`. It used
  // to hang off `settledHighlight`, which meant turning the spinner off left
  // a ring in its place: the same claim, quieter.
  if (!p.workingIndicator) return null;
  const t = tabs.find(t => t.type === "terminal" && !!t.delegatedWork);
  return (t && t.type === "terminal" ? t.delegatedWork : null) ?? null;
}

/** The whole precedence in one call: what this row should draw, or null.
 *
 *  Callers that need the individual flags (the sidebar logs all three to the
 *  work-state trace, and needs them separately to explain why nothing drew)
 *  use the predicates above; callers that just want a badge use this. */
export function taskWorkBadge(tabs: Tab[], p: WorkStatePrefs): WorkBadgeReason | null {
  if (taskNeedsAttention(tabs, p)) return "attention";
  if (taskWorkDone(tabs, p)) return "done";
  if (taskWorking(tabs, p)) return "working";
  // LAST, and it is the only rung that is not a work state: a tab with nothing
  // spinning and nothing to announce, that still has something running. It
  // draws in the slot the other three did not want.
  if (taskDelegated(tabs, p)) return "delegated";
  return null;
}
