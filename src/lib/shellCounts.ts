// Broker counts for a shell running a role, shared by its tab badge and its
// rc-file banner so one shell costs one poll. Polls only while something
// subscribed (callers pass null unless the shell is the visible, active tab)
// and the window is visible, 2s like the footer chip, and notifies only on a
// change (`sameCounts`), so a quiet shell writes nothing (bear trap 8).

import { useCallback, useSyncExternalStore } from "react";
import { brokerCounts } from "./ipc";
import { sameCounts } from "./secretsUi";
import type { BrokerCounts } from "./types";

const POLL_MS = 2000;

// a key's last counts outlive its subscribers, so coming back to the tab
// renders them at once instead of null, then the first tick (the banner is
// in-flow: a late one would refit the terminal a tick after the switch).
interface Poll { counts: BrokerCounts | null; subs: Set<() => void>; timer: number | null }
const polls = new Map<string, Poll>();

function tick(key: string) {
  const p = polls.get(key);
  if (!p || document.hidden) return;
  brokerCounts(key).then(c => {
    const cur = polls.get(key);
    if (!cur || sameCounts(cur.counts, c)) return;
    cur.counts = c;
    cur.subs.forEach(f => f());
  }).catch(() => {});
}

function subscribe(key: string, f: () => void) {
  let p = polls.get(key);
  if (!p) { p = { counts: null, subs: new Set(), timer: null }; polls.set(key, p); }
  if (p.timer === null) {
    p.timer = window.setInterval(() => tick(key), POLL_MS);
    queueMicrotask(() => tick(key));
  }
  p.subs.add(f);
  return () => {
    const cur = polls.get(key);
    if (!cur) return;
    cur.subs.delete(f);
    if (cur.subs.size === 0 && cur.timer !== null) { window.clearInterval(cur.timer); cur.timer = null; }
  };
}

const noop = () => () => {};
const none = () => null;

/** The shell's counts, or null while `key` is null / nothing arrived yet. */
export function useShellCounts(key: string | null): BrokerCounts | null {
  // stable per key, or every render would resubscribe and restart the poll.
  const sub = useCallback((f: () => void) => (key ? subscribe(key, f) : noop()), [key]);
  const get = useCallback(() => (key ? polls.get(key)?.counts ?? null : none()), [key]);
  return useSyncExternalStore(sub, get);
}
