// Idle build-folder cleanup, the frontend half (Rust: src-tauri/src/build_dirs.rs,
// rules in docs/data-model.md "Idle build-folder cleanup").
//
// Two jobs: stamp a task's last_active_at when it is opened (at most hourly,
// and never through a store setter: the stamp is for the next cleanup pass,
// nothing renders it), and run the cleanup shortly after launch and every 6
// hours. Opening a task whose folders were freed re-runs its setup script, or
// says so once when there is none.

import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { idleBuildDirsFree, taskMarkActive } from "@/lib/ipc";
import { launchSetupTab } from "@/lib/runTabs";
import { formatBytes } from "@/lib/utils";

const STAMP_EVERY_MS = 60 * 60_000;
const FIRST_RUN_MS = 2 * 60_000;
const RUN_EVERY_MS = 6 * 60 * 60_000;

/** In-session stamps, so the hourly throttle holds without writing the store. */
const stamped = new Map<string, number>();
/** Tasks this session freed: the store's record predates the marker. */
const freedNow = new Set<string>();
/** Tasks whose marker this session already handed back. */
const restored = new Set<string>();

/** Runs on every activation (see the subscription in init). Cheap when
 *  throttled: one Map lookup. */
export function noteTaskActive(id: string): void {
  const task = useApp.getState().tasks.find(t => t.id === id);
  if (!task || task.archived) return;
  const pending = freedNow.has(id) || (!!task.artifacts_freed_at && !restored.has(id));
  const now = Date.now();
  const last = Math.max(stamped.get(id) ?? 0, Date.parse(task.last_active_at ?? "") || 0);
  if (!pending && now - last < STAMP_EVERY_MS) return;
  stamped.set(id, now);
  freedNow.delete(id);
  restored.add(id);
  // Off the activation path: nothing here may delay the switch itself.
  void Promise.resolve()
    .then(() => taskMarkActive(id))
    .then(freedAt => { if (freedAt) void restore(id, freedAt); })
    .catch(() => {});
}

async function restore(id: string, freedAt: string): Promise<void> {
  const st = useApp.getState();
  const task = st.tasks.find(t => t.id === id);
  if (!task) return;
  st.ensureDefaultTab(id, task.cli || "claude");
  if (await launchSetupTab(id, { focus: false })) return;
  const date = new Date(freedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  useUI.getState().pushToast(i18n.t("backend:buildDirs.restoreToast", { name: task.name, date }), "info", { ttlMs: 12_000 });
}

/** One cleanup pass. Exposed for e2e; the timer is the real caller. */
export async function runIdleBuildDirCleanup(): Promise<{ tasks: string[]; bytes: number } | null> {
  const p = usePrefs.getState();
  if (!p.freeIdleBuildDirs) return null;
  const active = useApp.getState().activeTaskId;
  const report = await idleBuildDirsFree(p.freeIdleBuildDirsDays, active ? [active] : []);
  if (report.tasks.length > 0) {
    for (const id of report.tasks) { freedNow.add(id); restored.delete(id); }
    useUI.getState().pushToast(
      i18n.t("backend:buildDirs.freedToast", { size: formatBytes(report.bytes), count: report.tasks.length }),
      "success",
    );
  }
  return report;
}

let started = false;

/** Start the schedule. Idempotent; called from App once loadAll resolved. */
export function initIdleBuildDirCleanup(): void {
  if (started) return;
  started = true;
  // A subscription rather than a call inside setActiveTask, so the app store
  // does not import this module (and through it prefs and runTabs).
  useApp.subscribe((s, prev) => {
    if (s.activeTaskId && s.activeTaskId !== prev.activeTaskId) noteTaskActive(s.activeTaskId);
  });
  const id = useApp.getState().activeTaskId;
  if (id) noteTaskActive(id);
  // No timer in the e2e binary: a stray "Freed" toast from a stale fixture
  // task would land in whatever spec is running. The spec runs a pass itself.
  if (import.meta.env.VITE_E2E) return;
  const run = () => { void runIdleBuildDirCleanup().catch(() => {}); };
  window.setTimeout(run, FIRST_RUN_MS);
  window.setInterval(run, RUN_EVERY_MS);
}
