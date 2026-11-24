// Scheduled queue messages (GH #300): a queue item with a "send after" date.
//
// The pure half. It picks which queue item goes next, converts between the
// in-memory queue and the task file's `scheduled` field, and renders the
// dates. TerminalPane owns sending and the store owns persistence; neither
// should re-derive a rule that lives here.
//
// The model, in one place: a scheduled item is sent the first time its tab
// is live and idle on or after `notBefore`. Nothing fires on its own, so a
// chat nobody opens never sends, and a cold start with five overdue items
// sends nothing until their tabs mount.

import type { QueueItem, ScheduledMessage } from "@/lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const isScheduled = (q: QueueItem) => q.notBefore != null;
export const isDue = (q: QueueItem, now: number) => q.notBefore != null && q.notBefore <= now;

/** Index of the item the drain should send next, or -1.
 *
 *  - A scheduled item is eligible once due, whether or not the queue is
 *    active: the user armed it when they created it.
 *  - An ordinary item is eligible only while the queue is active, as before.
 *  - A future item is skipped over, so ordinary items behind it still drain.
 *  - `force` (the "Send now" button) takes the first due-or-ordinary item,
 *    and failing that the head itself: an explicit "now" beats the date. */
export function pickQueueItem(
  queue: QueueItem[] | undefined,
  opts: { queueActive: boolean; now: number; force?: boolean },
): number {
  const q = queue ?? [];
  const i = q.findIndex(item => isScheduled(item) ? isDue(item, opts.now) : (opts.queueActive || !!opts.force));
  if (i >= 0) return i;
  return opts.force && q.length ? 0 : -1;
}

/** Is the queue loop running, as far as anyone looking at the tab can tell?
 *
 *  NOT the stored `queueActive` flag on its own. That flag is only dropped by
 *  the drain, the next time the agent's turn ends and it finds nothing left,
 *  which is where the queue is marked done. So after the LAST message
 *  has gone it stays set for that whole turn, and for an agent idling on
 *  delegated work (its messages are flushed at once and no turn end is
 *  coming) it stays set indefinitely: the footer button sat lit over an
 *  empty queue. Running means active AND an ordinary message still waiting;
 *  a scheduled one for later never needed the loop. */
export const queueLoopRunning = (t: { queueActive?: boolean; queue?: QueueItem[] }) =>
  !!t.queueActive && !!t.queue?.some(q => !isScheduled(q));

/** Does the queue hold a scheduled item that is due? The ticker's filter. */
export const hasDueScheduled = (queue: QueueItem[] | undefined, now: number) =>
  !!queue?.some(q => isDue(q, now));

/** The queue's scheduled items in the task file's shape. Key order matches
 *  the Rust struct's serialization, so the store's JSON equality against a
 *  record read from disk holds. */
export function scheduledOf(queue: QueueItem[] | undefined): ScheduledMessage[] {
  return (queue ?? []).filter(isScheduled).map(q => ({
    id: q.id,
    text: q.text,
    not_before: q.notBefore!,
    created: q.created ?? 0,
  }));
}

/** Rebuild queue items from a persisted tab. Always one-shot. */
export function hydrateScheduled(items: ScheduledMessage[] | undefined): QueueItem[] {
  return (items ?? []).map(m => ({
    id: m.id,
    text: m.text,
    repeat: 1,
    remaining: 1,
    notBefore: m.not_before,
    created: m.created,
  }));
}

/** Local midnight `days` days after `now`'s date. Presets resolve to the
 *  start of a day because the promise is "on or after <date>": "in a week"
 *  created at 14:05 must still go out when the chat is opened at 09:00 that
 *  day. */
export function startOfDayIn(days: number, now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Parse an `<input type="date">` value (YYYY-MM-DD) as local midnight.
 *  `new Date("2026-09-24")` would be UTC midnight, a day early west of it. */
export function localDateValue(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** The `min`/`value` string for a date input: YYYY-MM-DD in local time. */
export function dateInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Wed, Sep 24" for the chip and the helper sentence. */
export function formatScheduleDate(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** How late a send was, for the toast, or null when it went out within the
 *  hour (not worth mentioning). */
export function lateBy(notBefore: number, now: number): string | null {
  const late = now - notBefore;
  if (late <= 60 * 60 * 1000) return null;
  if (late < DAY_MS) {
    const h = Math.floor(late / (60 * 60 * 1000));
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.floor(late / DAY_MS);
  return `${d} ${d === 1 ? "day" : "days"}`;
}
