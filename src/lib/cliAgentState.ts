// Per-task agent state, aggregated and PUSHED down to the Rust cache
// (cli_server.rs cli_agent_states) so the CLI's `list`/`status` read a
// cache instead of a webview round-trip and `wait` blocks on flips
// (docs/plans/cli.md, Phase 1). The webview is the only writer.
//
// Push discipline:
// - Full snapshot every time, never deltas: a webview reload must not
//   leave the cache describing tabs that no longer exist.
// - Debounced on a WALL-CLOCK timer (never rAF: occluded windows freeze
//   rAF, and for the CLI the window is always backgrounded).
// - Re-pushed every 20s even when unchanged, as the cache's freshness
//   signal: the server treats a cache older than 120s as "the UI
//   stopped reporting" and fails waits instead of trusting a frozen
//   snapshot.

import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/store/app";
import { workDoneCapable } from "@/lib/agents";
import type { TerminalTab } from "@/lib/types";

export interface TaskAgentState {
  /** "working" | "waiting" | "done" | "idle" | "inactive". */
  state: string;
  tabs: number;
  /** Messages still queued to the task's agents (ralph loop). The
   *  server's quiescence check requires 0: settle alone races `send`'s
   *  queueing. */
  queued: number;
  /** Any tab has work-done detection; without it `wait` is refused
   *  (no settle signal exists). */
  capable: boolean;
}

type AppState = ReturnType<typeof useApp.getState>;

/** Aggregate one state per LIVE task, matching the sidebar's own signal
 *  (lib/waitingAgents.ts): working wins, then a tab blocked on the user
 *  (attention), then a finished turn (done), else idle. A task with no
 *  terminal tabs reports "inactive" rather than being omitted, so the
 *  CLI can say "no agent open" instead of "unknown". */
export function computeAgentStates(s: AppState = useApp.getState()): Record<string, TaskAgentState> {
  const states: Record<string, TaskAgentState> = {};
  for (const task of s.tasks) {
    if (task.archived) continue;
    const term = (s.tabs[task.id] ?? []).filter(
      (t): t is TerminalTab => t.type === "terminal",
    );
    if (term.length === 0) {
      states[task.id] = { state: "inactive", tabs: 0, queued: 0, capable: false };
      continue;
    }
    let state = "idle";
    if (term.some(t => t.workState === "working")) state = "working";
    else if (term.some(t => t.unread?.reason === "attention")) state = "waiting";
    else if (term.some(t => t.workState === "done")) state = "done";
    const queued = term.reduce((n, t) => n + (t.queue?.length ?? 0), 0);
    const capable = term.some(t => workDoneCapable(t.cli, s.agents));
    states[task.id] = { state, tabs: term.length, queued, capable };
  }
  return states;
}

/** Trailing-edge debounce: the store changes on every PTY output chunk
 *  (lastOutputAt patches), so the aggregate is recomputed at most once
 *  per this window. */
const PUSH_DEBOUNCE_MS = 80;
/** Unchanged-state re-push cadence (the freshness heartbeat). Must stay
 *  well under the server's 120s staleness cutoff. */
const REFRESH_EVERY_MS = 20_000;

let started = false;

/** Start pushing agent-state snapshots to Rust. Idempotent; returns a
 *  stop function that clears the latch so a remount re-registers. */
export function initAgentStatePush(): () => void {
  if (started) return () => {};
  started = true;
  let lastSent = "";
  let timer: number | undefined;

  const push = (force: boolean) => {
    const states = computeAgentStates();
    const body = JSON.stringify(states);
    if (!force && body === lastSent) return;
    lastSent = body;
    invoke("cli_agent_states", { states }).catch(() => {
      // A failed push must not suppress the retry on the next change.
      lastSent = "";
    });
  };
  const schedule = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      push(false);
    }, PUSH_DEBOUNCE_MS);
  };

  const unsub = useApp.subscribe(schedule);
  const interval = window.setInterval(() => push(true), REFRESH_EVERY_MS);
  // Boot snapshot, but only once the store has hydrated: a reload's
  // pre-loadAll push would wipe the cache with an empty map under an
  // in-flight wait. An empty store pushes via loadAll's store change
  // (or the interval, for a genuinely task-less app).
  if (useApp.getState().tasks.length > 0) push(true);

  return () => {
    started = false;
    unsub();
    window.clearInterval(interval);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
