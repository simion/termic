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
import { isTerminalCli, workDoneCapable } from "@/lib/agents";
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
  /** The STRIP's terminal tabs in display order (GH #138 part 2): what
   *  `--tab` selectors resolve against and `status` lists. Pane-split
   *  leaves are excluded (they are inside a strip tab, not on the
   *  strip), matching TabBar's own filter. */
  tab_states: TabAgentState[];
  /** Whether the UI has this task's tabs in memory at all. False for a
   *  task nobody has opened this session: the counts above then describe
   *  nothing, and the server reports unknown rather than "no tabs". */
  hydrated: boolean;
}

/** One strip tab, as pushed to the Rust cache. Field names are the wire
 *  shape (snake_case where Rust reads them). */
export interface TabAgentState {
  /** Stable store id: the identity `--tab` selectors resolve to. */
  id: string;
  /** "agent" | "shell" | "terminal" (custom, #27) | "run" (script tabs). */
  kind: string;
  /** cli id ("claude", "shell", a custom terminal's id). */
  cli: string;
  /** Display title as the GUI renders it (agent-authored, mutable). */
  title: string;
  /** Per-tab work state; null when the tab has no settle signal (shell,
   *  custom terminal, work-done-incapable agent). */
  state: string | null;
  /** Prompts queued behind this tab's current turn. */
  queued: number;
  /** Work-done detection exists for this tab's cli. */
  capable: boolean;
  /** A PTY is live in this tab right now. */
  live: boolean;
  /** The tab send/wait/attach/logs target when `--tab` is absent. */
  is_default: boolean;
}

/** The wire shape for one strip tab. Exported for tests. */
export function computeTabState(t: TerminalTab, agents: AppState["agents"]): TabAgentState {
  const kind = t.runTab ? "run"
    : t.cli === "shell" ? "shell"
    : isTerminalCli(t.cli, agents) ? "terminal"
    : "agent";
  const capable = kind === "agent" && workDoneCapable(t.cli, agents);
  const state = !capable ? null
    : t.workState === "working" ? "working"
    : t.unread?.reason === "attention" ? "waiting"
    : t.workState === "done" ? "done"
    : "idle";
  return {
    id: t.id,
    kind,
    cli: t.cli,
    title: t.title || t.cli,
    state,
    queued: t.queue?.length ?? 0,
    capable,
    live: !!t.ptyId,
    is_default: !!t.is_default,
  };
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
    // undefined means the UI has never loaded this task's tabs (nobody
    // has opened it this session); an empty array means it was loaded and
    // has none. `hydrated` carries that difference to the CLI, which is
    // what keeps a count off a task nobody has opened (see the field's
    // docs on TaskAgentState).
    const loaded = s.tabs[task.id];
    const term = (loaded ?? []).filter(
      (t): t is TerminalTab => t.type === "terminal",
    );
    if (term.length === 0) {
      states[task.id] = {
        state: "inactive",
        tabs: 0,
        queued: 0,
        capable: false,
        tab_states: [],
        hydrated: loaded !== undefined,
      };
      continue;
    }
    let state = "idle";
    if (term.some(t => t.workState === "working")) state = "working";
    else if (term.some(t => t.unread?.reason === "attention")) state = "waiting";
    else if (term.some(t => t.workState === "done")) state = "done";
    const queued = term.reduce((n, t) => n + (t.queue?.length ?? 0), 0);
    const capable = term.some(t => workDoneCapable(t.cli, s.agents));
    const tab_states = term.filter(t => !t.paneId).map(t => computeTabState(t, s.agents));
    states[task.id] = { state, tabs: term.length, queued, capable, tab_states, hydrated: true };
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
