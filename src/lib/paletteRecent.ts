// Recently-run commands for the ⇧⌘P palette.
//
// Kept OUT of the component (and out of the app store) so the expiry rule can
// be unit-tested against an injected clock instead of a real one: "clears after
// an hour" is untestable if the only clock is Date.now() inside a render.
// localStorage-backed directly, same as the palette's sibling component-local
// prefs (DiffPane's view mode) — nothing else reads it.
//
// The point is the reopen case: run a command, hit ⇧⌘P again a minute later,
// and the thing you just did is the first row. An hour on, the palette is back
// to its normal order rather than showing you what you were doing before lunch.

const LS_KEY = "commandPaletteRecent";

/** Entries older than this are dropped on the next read or write. */
export const RECENT_TTL_MS = 60 * 60 * 1000;

/** How many recents the section shows. Small on purpose: the section sits above
 *  everything else and pushes the real list down, so it earns its height only
 *  while it is short. */
export const RECENT_MAX = 3;

export interface RecentEntry {
  id: string;
  /** Epoch ms of the most recent run. */
  at: number;
}

/** Parse + prune. Tolerates absent, corrupt, or hand-edited storage by
 *  returning [] — a broken recents list must never stop the palette opening. */
export function parseRecents(raw: string | null, now: number): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentEntry[] = [];
  for (const e of data) {
    if (!e || typeof e !== "object") continue;
    const { id, at } = e as Partial<RecentEntry>;
    if (typeof id !== "string" || !id) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    // Expired, or stamped in the future by a clock change — drop both. A
    // future timestamp would otherwise pin a row to the top for over an hour.
    if (now - at >= RECENT_TTL_MS || at > now) continue;
    out.push({ id, at });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, RECENT_MAX);
}

/** Fold a newly-run command into the list: most recent first, one row per id
 *  (re-running something moves it up rather than adding a duplicate). */
export function withRecorded(prev: RecentEntry[], id: string, now: number): RecentEntry[] {
  const next = prev.filter(e => e.id !== id && now - e.at < RECENT_TTL_MS && e.at <= now);
  next.unshift({ id, at: now });
  return next.slice(0, RECENT_MAX);
}

/** Ids to show, newest first, restricted to commands that still exist.
 *  A task-scoped command (Stop task, Copy branch) is absent whenever no task is
 *  active, and a stale id must not render a dead row. */
export function recentIds(entries: RecentEntry[], available: ReadonlySet<string>): string[] {
  return entries.filter(e => available.has(e.id)).map(e => e.id);
}

export function readRecents(now = Date.now()): RecentEntry[] {
  try {
    return parseRecents(localStorage.getItem(LS_KEY), now);
  } catch {
    return [];
  }
}

export function recordRecent(id: string, now = Date.now()): void {
  try {
    const next = withRecorded(parseRecents(localStorage.getItem(LS_KEY), now), id, now);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota. Recents are a convenience; never break the palette.
  }
}

// The Change-theme list keeps its own two bits, with no expiry: the themes
// you last committed (pinned above the list, which can run to hundreds with
// the imports) and the dark / light / all toggle.
const LS_THEME_RECENT = "commandPaletteThemeRecent";
const LS_THEME_FILTER = "commandPaletteThemeFilter";
export type SchemeFilter = "all" | "dark" | "light";

export function readThemeRecents(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LS_THEME_RECENT) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function recordThemeRecent(id: string): void {
  try {
    const next = [id, ...readThemeRecents().filter(x => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(LS_THEME_RECENT, JSON.stringify(next));
  } catch {}
}

/** null until the user touches the toggle. */
export function readSchemeFilter(): SchemeFilter | null {
  try {
    const v = localStorage.getItem(LS_THEME_FILTER);
    return v === "all" || v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

export function writeSchemeFilter(f: SchemeFilter): void {
  try { localStorage.setItem(LS_THEME_FILTER, f); } catch {}
}
