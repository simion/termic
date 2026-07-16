// Agent Race cohort store. A "race" is N tasks (each its own worktree + agent)
// spawned from ONE shared prompt, so the user can watch several agents attempt
// the same work in parallel and later pick a winner. This store is the
// cohort's first-class record: which tasks belong to which race, and the
// prompt that seeded them. Slice 1 uses it only to drive the RaceBoard strip;
// the later compare / cherry-pick slices read the same cohort, so it must NOT
// be inferred from task names.
//
// Persisted to localStorage so a race survives restart (its tasks are real
// worktrees that persist too). Frontend-only. Pure store with no app/ui
// imports, so nothing here can form an import cycle. NOT responsible for
// spawning tasks or injecting the prompt (that orchestration lives in
// lib/agentRace.ts).

import { create } from "zustand";

const LS_RACES = "agentRaces";

export interface Race {
  id: string;
  /** The shared prompt's first line, shown as the board's label. */
  prompt: string;
  /** The cohort: one task id per raced agent, in launch order. */
  taskIds: string[];
  createdAt: number;
}

type RaceMap = Record<string, Race>;

function load(): RaceMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_RACES) ?? "null");
    if (!parsed || typeof parsed !== "object") return {};
    const out: RaceMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const r = v as Partial<Race>;
      if (r && typeof r.id === "string" && Array.isArray(r.taskIds)) {
        out[k] = {
          id: r.id,
          prompt: String(r.prompt ?? ""),
          taskIds: r.taskIds.filter((t): t is string => typeof t === "string"),
          createdAt: Number(r.createdAt) || 0,
        };
      }
    }
    return out;
  } catch { return {}; }
}

function persist(map: RaceMap) {
  try { localStorage.setItem(LS_RACES, JSON.stringify(map)); } catch {}
}

interface RaceState {
  races: RaceMap;
  start: (race: Race) => void;
  end: (id: string) => void;
  /** Drop races whose tasks are all gone (archived / deleted), and prune dead
   *  task ids out of races that still have at least one live member. */
  prune: (liveIds: Set<string>) => void;
}

export const useRace = create<RaceState>((set) => ({
  races: load(),
  start: (race) => set(s => {
    const races = { ...s.races, [race.id]: race };
    persist(races);
    return { races };
  }),
  end: (id) => set(s => {
    if (!(id in s.races)) return s;
    const { [id]: _gone, ...rest } = s.races; void _gone;
    persist(rest);
    return { races: rest };
  }),
  prune: (liveIds) => set(s => {
    let changed = false;
    const next: RaceMap = {};
    for (const [id, r] of Object.entries(s.races)) {
      const live = r.taskIds.filter(t => liveIds.has(t));
      if (live.length === 0) { changed = true; continue; }
      if (live.length !== r.taskIds.length) { changed = true; next[id] = { ...r, taskIds: live }; }
      else next[id] = r;
    }
    if (!changed) return s;
    persist(next);
    return { races: next };
  }),
}));

/** The most-recent race, or null. The board shows one race at a time
 *  (Slice 1); this picks it. Dead-task filtering is the caller's job. */
export function latestRace(races: RaceMap): Race | null {
  let best: Race | null = null;
  for (const r of Object.values(races)) if (!best || r.createdAt > best.createdAt) best = r;
  return best;
}
