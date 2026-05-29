// Pure logic for the ⌘I context picker: recency-blended ranking and the
// @path insertion string. Kept framework-free and clock-free (callers pass
// `nowMs`) so it's deterministic and unit-testable.

import { fuzzyScore } from "@/lib/fuzzy";
import type { ContextFile } from "@/lib/ipc";

/** Recency half-life — a file modified this long ago gets half the boost of a
 *  just-modified one. Matches the pi-agent reference picker's 14-day model. */
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** Recency contributes at most this many points. Fuzzy matches score ~100-160,
 *  so this is roughly a quarter of a match's magnitude: enough to order
 *  similar matches by freshness, not enough to let a stale file leapfrog a
 *  clearly stronger name match. */
const RECENCY_WEIGHT = 30;
/** Flat bump for git-changed files so "what I'm working on" floats up. */
const CHANGED_BONUS = 15;

export interface RankedContextFile {
  path: string;
  is_dir: boolean;
  mtime_ms: number;
  score: number;
  /** Indexes into `path` that matched the query — for highlighting. */
  matches: number[];
}

/** 1.0 for a just-modified file, decaying by half every `RECENCY_HALF_LIFE_MS`.
 *  0 when mtime is missing/invalid so unstat-able files sink to the bottom. */
export function recencyScore(mtimeMs: number, nowMs: number): number {
  if (!mtimeMs || mtimeMs <= 0) return 0;
  const age = Math.max(0, nowMs - mtimeMs);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

/** Rank context files by fuzzy match (when a query is present) blended with
 *  recency and a git-changed bonus. Empty/whitespace query → every file is
 *  kept and ordered by recency (then changed, then path). */
export function rankContextFiles(
  files: ContextFile[],
  changed: Set<string>,
  query: string,
  nowMs: number,
): RankedContextFile[] {
  const hasQuery = query.trim().length > 0;
  const out: RankedContextFile[] = [];
  for (const f of files) {
    let base = 0;
    let matches: number[] = [];
    if (hasQuery) {
      const s = fuzzyScore(f.path, query);
      if (!s) continue; // non-matching files are dropped when filtering
      base = s.score;
      matches = s.matches;
    }
    const score =
      base + RECENCY_WEIGHT * recencyScore(f.mtime_ms, nowMs) + (changed.has(f.path) ? CHANGED_BONUS : 0);
    out.push({ path: f.path, is_dir: f.is_dir, mtime_ms: f.mtime_ms, score, matches });
  }
  out.sort(
    (a, b) => b.score - a.score || b.mtime_ms - a.mtime_ms || a.path.localeCompare(b.path),
  );
  return out;
}

/** Build the string written to the PTY on confirm. Each path becomes an
 *  `@path` token, directories get a trailing slash, spaces are backslash-
 *  escaped, tokens are space-joined with one trailing space so the user can
 *  keep typing. Empty selection → empty string. */
export function buildInsertion(items: { path: string; is_dir: boolean }[]): string {
  if (!items.length) return "";
  const tokens = items.map((it) => "@" + it.path.replace(/ /g, "\\ ") + (it.is_dir ? "/" : ""));
  return tokens.join(" ") + " ";
}
