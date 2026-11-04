// Which new-task menu entries were used lately, so the menu can lead with
// those and fold the rest under "More". Two sources, merged: when a task
// with that cli was created (live or archived, so a launch from the New Task
// dialog, the CLI or MCP counts too), and a per-entry stamp written when the
// menu itself is used, which is the only record for entries that do not
// leave a cli on a task (Review a pull request) or that a person used
// without keeping the task.
//
// localStorage, not a pref: it is a usage log for one menu on one machine,
// nothing to sync or show in Settings.

import { scoped } from "@/lib/profileScope";


/** Where an entry of the new-task menu shows. auto: top level while used in
 *  the last 7 days, else under More. shown: always top level. pinned: always
 *  top level and first. more: always under More. */
export type LauncherVisibility = "auto" | "shown" | "pinned" | "more";
const LAUNCHER_VISIBILITIES: readonly LauncherVisibility[] = ["auto", "shown", "pinned", "more"];
// Pure, so the launcher test does not load the prefs store (which reads
// the DOM at import).
export function parseLauncherVisibility(raw: string): Record<string, LauncherVisibility> {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, LauncherVisibility> = {};
    for (const [k, x] of Object.entries(v)) {
      if (LAUNCHER_VISIBILITIES.includes(x as LauncherVisibility)) out[k] = x as LauncherVisibility;
    }
    return out;
  } catch {
    return {};
  }
}
/** The industry-standard agents: "Always shown" by default, so listed even
 *  when not installed and never folded into More. */
export const STANDARD_AGENTS: readonly string[] = ["claude", "codex", "agy"];

/** An entry's visibility: the user's choice (Settings > Agents, the
 *  `launcherVisibility` pref), else its default. Race defaults to More, the
 *  standard agents to Always shown, everything else to Auto. */
export function launcherVisibilityOf(
  id: string,
  overrides: Record<string, LauncherVisibility>,
): LauncherVisibility {
  return overrides[id] ?? (id === "race" ? "more" : STANDARD_AGENTS.includes(id) ? "shown" : "auto");
}

/** Pinned entries first (in their own order), then the rest. */
export function pinnedFirst(
  ids: readonly string[],
  overrides: Record<string, LauncherVisibility>,
): string[] {
  const pinned = ids.filter(id => launcherVisibilityOf(id, overrides) === "pinned");
  return [...pinned, ...ids.filter(id => !pinned.includes(id))];
}

/** Entries not used for this long fold under "More". */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

// Per profile: its task list is the other half of the signal.
const LS_LAUNCHER_LAST_USED = scoped("launcherLastUsed");

function readStamps(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_LAUNCHER_LAST_USED) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function recordLauncherUse(id: string, now = Date.now()): void {
  try {
    const s = readStamps();
    s[id] = now;
    localStorage.setItem(LS_LAUNCHER_LAST_USED, JSON.stringify(s));
  } catch { /* storage off: the task dates still count */ }
}

/** Newest creation per cli, cached per tasks array: the store replaces the
 *  array on every change, so an unchanged list is never rescanned, however
 *  often the menu opens. */
const byTasks = new WeakMap<readonly unknown[], Record<string, number>>();

function newestByCli(tasks: readonly { cli: string; created: string }[]): Record<string, number> {
  const hit = byTasks.get(tasks);
  if (hit) return hit;
  const out: Record<string, number> = {};
  for (const t of tasks) {
    const at = Date.parse(t.created);
    if (Number.isFinite(at) && at > (out[t.cli] ?? 0)) out[t.cli] = at;
  }
  byTasks.set(tasks, out);
  return out;
}

/** Last use per entry id, in epoch ms. */
export function launcherLastUsed(
  tasks: readonly { cli: string; created: string }[],
  stamps: Record<string, number> = readStamps(),
): Record<string, number> {
  const out: Record<string, number> = { ...stamps };
  for (const [cli, at] of Object.entries(newestByCli(tasks))) {
    if (at > (out[cli] ?? 0)) out[cli] = at;
  }
  return out;
}

/** Split `ids` (already in display order) into the menu's top level and its
 *  "More" submenu. `pinned` always stays on top (the project default);
 *  `folded` always goes to More (Race). With no history at all, nothing is
 *  recent, and folding everything would hide the menu from a new user, so
 *  only `folded` moves. A More holding a single entry is not worth a
 *  submenu, so that entry stays on top. */
export function splitLauncher(
  ids: readonly string[],
  lastUsed: Record<string, number>,
  { pinned, folded, now = Date.now() }: { pinned: ReadonlySet<string>; folded: ReadonlySet<string>; now?: number },
): { top: string[]; more: string[] } {
  const anyHistory = Object.values(lastUsed).some(t => t > 0);
  const recent = (id: string) => now - (lastUsed[id] ?? 0) < RECENT_MS;
  const top: string[] = [];
  const more: string[] = [];
  for (const id of ids) {
    if (folded.has(id)) more.push(id);
    else if (pinned.has(id) || !anyHistory || recent(id)) top.push(id);
    else more.push(id);
  }
  if (more.length === 1 && !folded.has(more[0])) return { top: [...ids], more: [] };
  return { top, more };
}
