// When an unread mark is worth an OS banner, as a pure function of the tab
// before and after.
//
// Extracted from `useAttentionNotifier` for one reason: the rule got a second
// clause (GH #276) and the hook it lives in cannot be unit-tested at all in
// this project (vitest runs in `node`, there is no testing-library, and the
// hook subscribes to a live store inside `useEffect`). A rule nobody can test
// is where the first version of this went wrong.
//
// The rule, and why each half exists:
//
//   1. Only a RISING edge fires. An agent re-asserting an unread mark it
//      already holds is not new information. This half has always been here.
//
//   2. A `repeat` mark is never news, and it does not consume the edge either.
//      A long turn produces several dones: the premature one is taken back
//      when the agent goes back to work, and the real ending sets it again.
//      Both are right for the sidebar dot; only the first is news. `repeat`
//      says which is which (see `Tab.unread.repeat`).
//
//      The "does not consume the edge" half is the subtle one and it is a
//      genuine improvement over a plain truthiness check. A suppressed repeat
//      done leaves `unread` SET, so a real needs-you arriving afterwards would
//      have found `prev.unread` truthy and been swallowed as "not an edge" -
//      the agent asking for permission, silently. Newsworthiness, not
//      truthiness, is what the edge is measured on.

import type { Tab } from "@/lib/types";
import { i18n } from "@/lib/i18n";

type UnreadLike = { unread?: { repeat?: boolean } | null } | undefined;

/** Does this tab currently hold an unread mark that is NEWS (not a repeat)? */
export function isNewsworthyUnread(t: UnreadLike): boolean {
  const u = t?.unread;
  // `!== true` rather than `=== undefined`: a record written before this flag
  // existed, or by a path that does not set it, is news. Going quiet is the
  // failure that gets reported as "termic stopped telling me"; going loud is
  // the one this flag exists to bound, and it is bounded elsewhere too (the
  // producer's per-turn latch, and the notifier's debounce).
  return !!u && u.repeat !== true;
}

/** Should the transition from `prev` to `next` raise an OS notification?
 *  Focus gating, the per-tab debounce and the user's pref are the caller's
 *  job - this is only the "is it news" half. */
export function shouldNotifyUnread(next: UnreadLike, prev: UnreadLike): boolean {
  return isNewsworthyUnread(next) && !isNewsworthyUnread(prev);
}

/** The wording shown in the banner body for each reason. Kept next to the rule
 *  above so the two cannot drift, and exported so a test can assert every
 *  reason has a phrase (a missing one used to fall through to "is idle", which
 *  reads as nothing happening). Values are backend-locale KEYS, resolved at
 *  display time so a language switch applies to the next banner. */
export const UNREAD_PHRASE: Record<NonNullable<Tab["unread"]>["reason"], string> = {
  bell: "phraseBell",
  exit: "phraseExit",
  done: "phraseDone",
  attention: "phraseAttention",
  idle: "phraseIdle",
};

/** Resolve one UNREAD_PHRASE key to its localized wording. */
export function unreadPhrase(reason: NonNullable<Tab["unread"]>["reason"]): string {
  return i18n.t(`backend:attentionNotify.${UNREAD_PHRASE[reason]}`);
}
