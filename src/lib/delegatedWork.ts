// Work an agent has DELEGATED and not finished: a subagent it is waiting on, a
// shell it left running. The policy lives here, apart from `TerminalPane`, so
// the decision that matters can be tested without a terminal.
//
// The problem it solves, measured against claude 2.1.278 (docs/agent-hooks.md
// "Delegated work"): a `Stop` that reports outstanding work used to emit
// NOTHING, which on the wire is byte-for-byte what a model mid-token looks
// like. The tab then span until the 20-minute ceiling, which clears the
// spinner silently. Worse, the hold is per SESSION: one `sleep 900` left in
// the background held the `Stop` of every later turn too, including turns that
// had nothing to do with it.
//
// Why there is no way to classify a single `Stop`: a `Stop` only fires when the
// model loop has stopped, so a `shell` in the payload is always DETACHED (a
// foreground one produces no `Stop` at all, measured). But "detached" does not
// mean "abandoned": an agent that backgrounds a shell is re-invoked when it
// exits, by a synthetic `UserPromptSubmit` carrying `<task-notification>`. Two
// runs with identical payloads went opposite ways: one resumed 75s later, one
// never. So the verdict cannot come from the payload, and this module does not
// try. It asks a different question, below.

import { i18n } from "@/lib/i18n";

/** Wire labels. The hook sends one of these; anything else is dropped rather
 *  than shown, because the body is agent-controlled text that reaches the UI.
 *  KEEP IN SYNC with `DELEGATED_LABELS` in `agent_hooks.rs`. */
export const DELEGATED_LABELS = {
  subagent: { one: "subagent", many: "subagents", agentOwned: true },
  workflow: { one: "workflow", many: "workflows", agentOwned: true },
  teammate: { one: "teammate", many: "teammates", agentOwned: true },
  cloud_session: { one: "cloud session", many: "cloud sessions", agentOwned: true },
  mcp_task: { one: "MCP task", many: "MCP tasks", agentOwned: true },
  shell: { one: "shell", many: "shells", agentOwned: false },
  /** Generic: the agent says work is outstanding but not what kind (agy's
   *  `fullyIdle: false`). Treated as agent-owned, which is the safe side: it
   *  waits for the agent instead of announcing over it. */
  work: { one: "task", many: "tasks", agentOwned: true },
} as const;

export type DelegatedLabel = keyof typeof DELEGATED_LABELS;

export interface DelegatedWork {
  label: DelegatedLabel;
  /** How many entries of `label` the agent reported. At least 1. */
  count: number;
  /** Ids of everything outstanding, used ONLY to compare one turn's set
   *  against the last one's. Never displayed. */
  ids: string[];
  /** Some of what was outstanding has REPORTED BACK while the rest runs on.
   *  Set by the state machine on a `shrank` verdict, never by the wire, and
   *  never by `parseDelegatedBody`: the hook reports what is outstanding, not
   *  what that means. It is the one thing a user watching a three-subagent
   *  turn wants to see and no single `Stop` payload says. */
  partial?: boolean;
}

/** An id list longer than this is a payload we do not understand, so the body
 *  is dropped rather than half-read. Twenty outstanding tasks is already far
 *  past anything measured (the busiest real orchestrator turn had four). */
const MAX_IDS = 20;

/** How long a tab may sit in `delegated` on DETACHED work alone before termic
 *  calls the turn over and says so.
 *
 *  This is the one number here that is a judgement rather than a measurement,
 *  because the case it bounds is the one that cannot be decided: a detached
 *  shell that will re-invoke the agent in 80 seconds and one that will never
 *  come back produce the identical payload. So it is set from the COST of
 *  being wrong in each direction. Too short and an agent waiting on a build
 *  gets announced over, then resumes, which is one wrong bell. Too long and a
 *  `npm run dev` costs the user a turn they are never told ended.
 *
 *  Five minutes: comfortably past every measured round trip (the slowest was
 *  85s end to end), comfortably short of the 20-minute liveness ceiling that
 *  clears the spinner without telling anyone. Only applies to detached work;
 *  agent-owned work waits for the agent, which is the thing it is measured to
 *  do.
 *
 *  Not applied to a CARRIED set, which needs no timer at all: see
 *  `delegatedVerdict`. */
export const DELEGATED_DETACHED_GRACE_MS = 300_000;

/** Parse the body of a trusted `agent delegated: ...` OSC.
 *
 *  Strict, for the same reason `hookOscSessionId` is strict: this is an
 *  agent-controlled string that ends up on screen. Shape is
 *  `<count> <label> <id,id,...>`, with `-` for "no ids reported". */
export function parseDelegatedBody(rest: string): DelegatedWork | null {
  const m = /^(\d{1,3}) ([a-z_]{1,16})(?: ([A-Za-z0-9_,-]{1,400}))?$/.exec(rest.trim());
  if (!m) return null;
  const count = Number(m[1]);
  if (!count) return null;
  const label = m[2] as DelegatedLabel;
  if (!Object.prototype.hasOwnProperty.call(DELEGATED_LABELS, label)) return null;
  const raw = m[3] && m[3] !== "-" ? m[3].split(",").filter(Boolean) : [];
  if (raw.length > MAX_IDS) return null;
  return { label, count, ids: Array.from(new Set(raw)) };
}

/** True when the agent, not a detached process, owns the outstanding work.
 *  Agent-owned work is measured to come back on its own, so termic waits for
 *  it rather than putting a clock on it. */
export const isAgentOwned = (w: DelegatedWork): boolean =>
  DELEGATED_LABELS[w.label].agentOwned;

/** The question this module asks INSTEAD of "what kind of work is this".
 *
 *  Not "will it finish" (undecidable, see the header) but "did anything move".
 *  Three answers, and the difference between the middle one and the last is
 *  the whole design:
 *
 *  - `carried`: the outstanding set is UNCHANGED since this pty's last
 *    `Stop`. Nothing finished and nothing was added, so this turn neither
 *    produced nor is waiting on any of it: the turn ended and these are
 *    leftovers. The compounding bug in one rule. With `sleep 900` running, a
 *    later one-word turn reported the identical payload and was held forever;
 *    now it is done, with the shell shown as a decoration.
 *  - `shrank`: something the agent delegated has REPORTED BACK, and more is
 *    outstanding. The agent is mid-cycle and will be re-invoked again, so the
 *    turn is not over. Worth showing, not worth a bell.
 *  - `new`: work this turn delegated. Keep the turn open.
 *
 *  `carried` is EQUALITY, and the reason is measured. Three background tasks
 *  report back one at a time, and each `Stop` carries the remainder:
 *  `{a,b,c}` then `{b,c}` then `{c}` then empty. Every one of those is a
 *  SUBSET of the one before, so a subset test called the turn over after the
 *  first one returned and rang "done" with two still running. That is exactly
 *  what a subset test cannot tell apart: a set that shrank because work
 *  finished, and a set that never changed because nothing is happening.
 *
 *  `prev` is what the last `Stop` on this pty reported, or null for the first.
 *  A first report is always `new`: nothing has been seen to carry over. */
export function delegatedVerdict(
  prev: DelegatedWork | null | undefined,
  next: DelegatedWork,
  /** Did a HUMAN start the turn that just ended: a typed prompt, a queued
   *  message, a broadcast, anything that stamps `lastInputAt`. False when the
   *  turn was started by the agent being re-invoked by its own delegated work
   *  (a `<task-notification>` resume), which is not something anybody asked
   *  for and therefore cannot be a turn that ENDED. */
  humanAsked: boolean,
): "carried" | "shrank" | "new" {
  // Ids are how the comparison is made, so no ids means no comparison. An
  // agent that reports counts and not ids always looks `new`, which is the
  // conservative side: it waits rather than announcing.
  if (!next.ids.length || !prev?.ids.length) return "new";
  const before = new Set(prev.ids);
  if (!next.ids.every(id => before.has(id))) return "new";
  // Everything here was here before. Smaller means something landed.
  if (next.ids.length !== before.size) return "shrank";
  // Unchanged. Whether that is a finished turn depends entirely on who asked
  // for it, and this is the second thing a set comparison alone got wrong.
  // Measured, three background subagents deep: an agent re-invoked by a task
  // notification stopped TWICE, 1.5s apart, with a byte-identical set both
  // times, mid-orchestration. Nothing had moved and nothing was over. The
  // only thing separating that from a dev server left running across a real
  // prompt is that the second one is a turn a person asked for.
  return humanAsked ? "carried" : "new";
}

/** What the chip says. Singular and plural, because "1 subagents" in the UI is
 *  the kind of thing that survives to a screenshot. Pass the calling
 *  component's `t` (docs/i18n.md); without one it resolves through the global
 *  i18n at event time, which is what the log lines want anyway. */
export function delegatedChipText(
  w: DelegatedWork,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const resolve = t ?? ((key: string, opts?: Record<string, unknown>) => i18n.t(key, opts));
  return resolve(`chrome:delegatedChip.${w.label}_${w.count === 1 ? "one" : "other"}`, { count: w.count });
}

/** The whole sentence for a tooltip: what is outstanding, and whether
 *  anything has come back yet. Same optional-`t` rule as `delegatedChipText`. */
export function delegatedTitle(
  w: DelegatedWork,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const held = delegatedChipText(w, t);
  const resolve = t ?? ((key: string, opts?: Record<string, unknown>) => i18n.t(key, opts));
  return w.partial
    ? resolve("chrome:delegated.titlePartial", { held })
    : resolve("chrome:delegated.titleRunning", { held });
}
