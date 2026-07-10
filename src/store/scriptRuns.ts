// Per-(task, kind) lifecycle state for streaming Setup/Run scripts.
// Lives outside the app store because it churns line-by-line during a run
// (would re-render unrelated app store subscribers otherwise) and resets
// fully on next invocation — no persistence.

import { create } from "zustand";

export type RunStatus = "idle" | "running" | "done" | "error";

interface RunState {
  status: RunStatus;
  /** Tail of captured stdout+stderr — capped to MAX_LINES so a long-running
   *  dev server doesn't grow this unboundedly. */
  lines: string[];
  /** Exit code if status is "done" or "error". */
  exitCode: number | null;
  /** Wall-clock ms when the run started — used for "Running for 12s" labels. */
  startedAt: number | null;
}

type Key = string; // `${taskId}:${member}:${kind}` — member="" for host
const key = (taskId: string, kind: string, member: string = "") =>
  `${taskId}:${member}:${kind}`;
const MAX_LINES = 2000;
const EMPTY: RunState = Object.freeze({ status: "idle", lines: [], exitCode: null, startedAt: null }) as RunState;

interface Store {
  runs: Record<Key, RunState>;
  start: (taskId: string, kind: string, member?: string) => void;
  appendLine: (taskId: string, kind: string, line: string, member?: string) => void;
  finish: (taskId: string, kind: string, exitCode: number | null, success: boolean, member?: string) => void;
  reset:  (taskId: string, kind: string, member?: string) => void;
}

export const useScriptRuns = create<Store>(set => ({
  runs: {},
  start: (taskId, kind, member = "") => set(s => ({
    runs: { ...s.runs, [key(taskId, kind, member)]: { status: "running", lines: [], exitCode: null, startedAt: Date.now() } },
  })),
  appendLine: (taskId, kind, line, member = "") => set(s => {
    const k = key(taskId, kind, member);
    const cur = s.runs[k] ?? EMPTY;
    const next = cur.lines.length >= MAX_LINES
      ? [...cur.lines.slice(-MAX_LINES + 1), line]
      : [...cur.lines, line];
    return { runs: { ...s.runs, [k]: { ...cur, lines: next } } };
  }),
  finish: (taskId, kind, exitCode, success, member = "") => set(s => {
    const k = key(taskId, kind, member);
    const cur = s.runs[k] ?? EMPTY;
    return { runs: { ...s.runs, [k]: { ...cur, status: success ? "done" : "error", exitCode } } };
  }),
  reset: (taskId, kind, member = "") => set(s => {
    const k = key(taskId, kind, member);
    if (!s.runs[k]) return s;
    const { [k]: _, ...rest } = s.runs;
    return { runs: rest };
  }),
}));

/** Tight selector — returns the run state for a specific (task, member, kind),
 *  or the shared frozen EMPTY object when nothing has run yet. Stable
 *  identity for the empty case keeps React from re-rendering on unrelated
 *  key changes. `member` defaults to "" (host). */
export const useRunState = (taskId: string | undefined, kind: string, member: string = "") =>
  useScriptRuns(s => (taskId ? s.runs[key(taskId, kind, member)] : undefined) ?? EMPTY);
