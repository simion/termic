// Where each task's branch stands against the commit it was cut from, for
// the derived phase (src/lib/taskPhase.ts). Same shape as src/store/pr.ts,
// one deliberate difference: THIS POLLER ONLY TICKS WHILE THE DASHBOARD IS
// MOUNTED.
//
// Three facts make that the right scope rather than a shortcut:
//
//   1. The phase is only DRAWN on the dashboard. Nothing else in the app
//      renders it, so a value polled anywhere else is a value nobody reads.
//   2. The dashboard is only mounted while NO task is open (MainArea renders
//      it as the overlay when `activeTaskId` is null), so "dashboard mounted"
//      and "the user is not driving an agent" are the same condition.
//   3. `task_git_phase_state` shells out to git. On a large monorepo a status
//      walk is not free, and paying it for every task in the fleet while the
//      user is mid-turn with an agent would be the worst possible moment to
//      spend it.
//
// So the PR poller stays global (its badge is on the sidebar, which is always
// mounted, and it drives the merge lifecycle) and this one does not. Cost
// control inside a pass mirrors pr.ts: sequential, never a fan-out, capped,
// stalest first, behind a per-task floor.

import { create } from "zustand";
import type { Task, TaskGitState } from "@/lib/types";
import { taskGitPhaseState } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";

export interface TaskGitEntry {
  /** The last resolved state, or `null` when the lookup REJECTED. Both null
   *  and a missing entry read as "we do not know" in `taskPhase`, which is
   *  why a failure is recorded rather than left absent: an absent entry would
   *  be re-polled on every pass. */
  state: TaskGitState | null;
  /** True while a lookup is in flight. Nothing renders a spinner off this
   *  (the phase just keeps showing what it had); it is the re-entrancy guard
   *  and `pollableTasks`' skip. */
  loading: boolean;
  /** Wall-clock ms of the last completed attempt, success or failure. Drives
   *  the floor, so a task whose git lookup is broken is not retried six times
   *  a minute for the whole session. */
  fetchedAt: number;
}

const EMPTY: TaskGitEntry = Object.freeze({ state: null, loading: false, fetchedAt: 0 }) as TaskGitEntry;

/** Minimum ms between lookups for one task unless forced. */
const MIN_REFRESH_MS = 30_000;

/** Ceiling on `git` subprocesses started by one pass. Lower than the PR
 *  poller's 8: that one is bounded by how many open PRs you have, this one by
 *  how many tasks exist, which is the bigger number. */
const MAX_PER_PASS = 6;

/** How often a pass runs while the dashboard is mounted. */
const POLL_TICK_MS = 30_000;

/** Flat struct, so an explicit field compare rather than a JSON round trip.
 *  Exported for the test that pins the bail below. */
export function sameGitState(a: TaskGitState | null, b: TaskGitState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.own_commits === b.own_commits
    && a.dirty === b.dirty
    && a.ahead === b.ahead
    && a.merged_into_base === b.merged_into_base
    && a.base_known === b.base_known;
}

interface TaskGitStore {
  byTask: Record<string, TaskGitEntry>;
  /** Fetch one task's git state. Rate-limited per task unless `force`. */
  refresh: (taskId: string, force?: boolean) => Promise<void>;
}

export const useTaskGit = create<TaskGitStore>((set, get) => ({
  byTask: {},

  refresh: async (taskId, force = false) => {
    const cur = get().byTask[taskId] ?? EMPTY;
    if (cur.loading) return;
    if (!force && Date.now() - cur.fetchedAt < MIN_REFRESH_MS) return;
    set(s => ({ byTask: { ...s.byTask, [taskId]: { ...cur, loading: true } } }));
    try {
      const next = await taskGitPhaseState(taskId);
      set(s => {
        const prev = s.byTask[taskId]?.state ?? null;
        // Reuse the PREVIOUS object when nothing moved, so `state` keeps its
        // identity across a steady poll of an unchanged branch.
        //
        // Be honest about what that does and does not buy. `fetchedAt` has to
        // advance or the floor stops working, so a successful refresh always
        // writes `byTask` (twice, counting the `loading` flip above), and the
        // Dashboard subscribes to `byTask` and re-derives every phase either
        // way. What this gives is a stable reference for any consumer that
        // keys on `state` itself, and a cheap `===` for anyone comparing two
        // reads. A literal no-write would mean moving `loading` and
        // `fetchedAt` off the entry into module-level maps, i.e. a different
        // `byTask` shape from the one pr.ts has. The cost as it stands is two
        // writes per task per pass, at most 6 tasks, on a page that is the
        // only thing mounted. See docs/performance.md bear traps 8 and 11.
        const state = sameGitState(prev, next) ? prev : next;
        return { byTask: { ...s.byTask, [taskId]: { state, loading: false, fetchedAt: Date.now() } } };
      });
    } catch {
      // A rejection is an ANSWER, not a gap: archived and main-checkout tasks
      // are rejected by design, and a repo git cannot read is not going to
      // start working within the floor. Recording `state: null` WITH a
      // `fetchedAt` is what stops the next pass picking the same task up
      // again immediately. `taskPhase` reads null as "unknown" and falls
      // through, which is the same thing a task nobody has polled does.
      set(s => ({
        byTask: { ...s.byTask, [taskId]: { state: null, loading: false, fetchedAt: Date.now() } },
      }));
    }
  },
}));

// ─────────────────────── dashboard-scoped pass ───────────────────────

/** Tasks due a lookup, stalest first. Exported for tests. */
export function pollableTasks(): Task[] {
  const now = Date.now();
  const { byTask } = useTaskGit.getState();
  const prByTask = usePr.getState().byTask;
  const staleness = (id: string) => now - (byTask[id]?.fetchedAt ?? 0);
  return useApp.getState().tasks
    .filter(w => {
      // Archived is already Done by rule 1, and its worktree is gone.
      if (w.archived) return false;
      // A main-checkout task has no branch of its own cut from a base, so
      // there is nothing here to answer. `task_git_phase_state` rejects for
      // one anyway; skipping keeps the rejection out of the pass entirely.
      if (w.is_main_checkout) return false;
      // An OPEN or MERGED PR decides the phase on its own (rules 1 and 2 in
      // taskPhase), so git could only agree with it. DRAFT and CLOSED do not:
      // both sit at In progress, and `merged_into_base` has to be able to
      // beat them - a squash-merged branch whose PR was closed rather than
      // merged is exactly the case that would otherwise never reach Done.
      const prState = prByTask[w.id]?.lookup?.pr?.state;
      if (prState === "open" || prState === "merged") return false;
      if (byTask[w.id]?.loading) return false;
      return staleness(w.id) >= MIN_REFRESH_MS;
    })
    .sort((a, b) => staleness(b.id) - staleness(a.id))
    .slice(0, MAX_PER_PASS);
}

let pollTimer: number | null = null;
/** A pass is sequential and can outlive its tick on a slow repo; without this
 *  the next tick would start a second one alongside it. */
let passRunning = false;
/** Bumped by `stopDashboardGitPolling`, so a pass already walking its list
 *  can notice the dashboard went away and stop between two `git` calls
 *  rather than finishing six of them behind a task the user just opened.
 *  A generation rather than a boolean, so `taskGitPassNow` (which never
 *  starts the timer) is not treated as already-stopped. */
let pollEpoch = 0;

async function gitPass() {
  if (passRunning) return;
  passRunning = true;
  const epoch = pollEpoch;
  try {
    for (const w of pollableTasks()) {
      if (pollEpoch !== epoch) return;
      // Unforced: `pollableTasks` already applied the same floor, and leaving
      // it in play means a lookup that landed between the filter and here is
      // not repeated.
      await useTaskGit.getState().refresh(w.id);
    }
  } finally {
    passRunning = false;
  }
}

/**
 * Start the dashboard's git pass: one immediately, then every
 * POLL_TICK_MS. Idempotent, so a re-render that re-runs the effect does not
 * stack timers.
 *
 * The tick and the floor are both 30s, which makes the STEADY cadence for one
 * task nearer 60s: a task polled a few ms after one tick is a few ms short of
 * the floor on the next, so it lands on the one after. That is deliberate
 * rather than a bug to tune out. 30s is a floor, not a target, and what it is
 * really there for is the burst: leaving a task and coming back runs a pass
 * immediately, and without the floor every one of those returns would shell
 * out to git for the whole fleet again.
 */
export function startDashboardGitPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => { void gitPass(); }, POLL_TICK_MS);
  void gitPass();
}

/** Stop the pass. Idempotent. Also cuts short a pass that is mid-walk, so
 *  opening a task does not leave up to six `git` calls running behind it. */
export function stopDashboardGitPolling() {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
  pollEpoch++;
}

/** Test seam: run one pass immediately, whatever the dashboard is doing.
 *  Same role as `prStatusPassNow` - the real cadence is half a minute and the
 *  thing it drives has no button to press. */
export function taskGitPassNow(): Promise<void> {
  return gitPass();
}
