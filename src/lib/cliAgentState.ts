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
import { collectTaskProps, type CollectedProp } from "@/lib/tabProps";
import { useRemote, type MachineView } from "@/lib/remote";

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
  /** The task's collected tab properties (GH #358), the view the sidebar
   *  row shows: `list` and `status` report it from here. */
  props: CollectedProp[];
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
  /** The tab's own properties (GH #358), in the order they were set. */
  props: { key: string; value: string }[];
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
    props: (t.props ?? []).map(p => ({ key: p.key, value: p.value })),
  };
}

type AppState = ReturnType<typeof useApp.getState>;

/** One state for a task's terminal tabs: working wins, then a tab blocked
 *  on the user (attention), then a finished turn (done), else idle. Shared
 *  with the sidebar's notification filter (lib/taskFilter.ts) so the
 *  per-project bell count always adds up to the tray's numeral. */
export function aggregateTabsState(term: TerminalTab[]): "working" | "waiting" | "done" | "idle" {
  if (term.some(t => t.workState === "working")) return "working";
  if (term.some(t => t.unread?.reason === "attention")) return "waiting";
  if (term.some(t => t.workState === "done")) return "done";
  return "idle";
}

/** Aggregate one state per LIVE task, matching the sidebar's own signal
 *  (lib/waitingAgents.ts): working wins, then a tab blocked on the user
 *  (attention), then a finished turn (done), else idle. A task with no
 *  terminal tabs reports "inactive" rather than being omitted, so the
 *  CLI can say "no agent open" instead of "unknown". */
export function computeAgentStates(s: AppState = useApp.getState(), machines: MachineView[] = useRemote.getState().machines): Record<string, TaskAgentState> {
  const states: Record<string, TaskAgentState> = {};
  for (const task of s.tasks) {
    if (task.archived) continue;
    // A server project's task whose tabs this desktop has not opened (a
    // fresh start, another desktop's agent): the box's reading of its
    // agent, as its sidebar row shows it. Once opened, its tabs read state
    // like local ones, below.
    const server = s.projects.find(p => p.id === task.project_id)?.server;
    const hasLivePty = (s.tabs[task.id] ?? []).some(t => t.type === "terminal" && !!(t as TerminalTab).ptyId);
    if (server && !hasLivePty) {
      const remote = machines.find(m => m.id === server)?.tasks.find(t => t.id === task.id)?.state;
      const state = remote === "working" || remote === "waiting" || remote === "done" || remote === "idle" ? remote : "inactive";
      const live = state !== "inactive";
      states[task.id] = { state, tabs: live ? 1 : 0, queued: 0, capable: live, tab_states: [], hydrated: true, props: [] };
      continue;
    }
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
        props: [],
      };
      continue;
    }
    const state = aggregateTabsState(term);
    const queued = term.reduce((n, t) => n + (t.queue?.length ?? 0), 0);
    const capable = term.some(t => workDoneCapable(t.cli, s.agents));
    const tab_states = term.filter(t => !t.paneId).map(t => computeTabState(t, s.agents));
    states[task.id] = {
      state, tabs: term.length, queued, capable, tab_states, hydrated: true,
      props: collectTaskProps(term),
    };
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

  // Only what computeAgentStates reads. Every other store write (a sidebar
  // drag, a pref, a selection) used to arm the timer and rebuild the whole
  // payload just to find it unchanged.
  const unsub = useApp.subscribe((s, prev) => {
    if (s.tabs === prev.tabs && s.tasks === prev.tasks && s.agents === prev.agents) return;
    schedule();
  });
  // A server task's state moves on the box.
  const unsubRemote = useRemote.subscribe((s, prev) => { if (s.machines !== prev.machines) schedule(); });
  const interval = window.setInterval(() => push(true), REFRESH_EVERY_MS);
  // Boot snapshot, but only once the store has hydrated: a reload's
  // pre-loadAll push would wipe the cache with an empty map under an
  // in-flight wait. An empty store pushes via loadAll's store change
  // (or the interval, for a genuinely task-less app).
  if (useApp.getState().tasks.length > 0) push(true);

  return () => {
    started = false;
    unsub();
    unsubRemote();
    window.clearInterval(interval);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
