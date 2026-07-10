// One-time localStorage migration for the workspace -> task rename (the JS
// half of Phase 0; the Rust half migrates on-disk metadata). Two persisted
// preference KEYS were renamed by value:
//
//   workspaceExpandMode          ->  taskExpandMode
//   collapsedWorkspaces          ->  collapsedTasks
//   newWorkspaceLastMode         ->  newTaskLastMode
//   newWorkspaceLastSandboxMode  ->  newTaskLastSandboxMode
//
// Everything else termic keeps in localStorage is keyed BY task UUID (e.g.
// terminalSplit: Record<taskId, bool>), and UUIDs never change across the
// rename (the safety anchor), so those records need no migration.
//
// Five bindable shortcut IDs were also renamed (workspace-* -> task-*). Those
// live INSIDE the `shortcutBindings` JSON blob keyed by shortcut ID, so a
// user who rebound one of them would silently lose the override (loadShortcuts
// merges by current ID). We remap the keys inside the blob below.
//
// This module runs as a SIDE-EFFECT import and MUST be imported before any
// store module (stores read these keys at init time). See main.tsx, where it
// is the very first import. Idempotent: it copies the old value across only
// when the new key is still absent, then drops the old key, so re-running (or
// running after a partial migration) is a no-op.

const RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["workspaceExpandMode", "taskExpandMode"],
  ["collapsedWorkspaces", "collapsedTasks"],
  ["newWorkspaceLastMode", "newTaskLastMode"],
  ["newWorkspaceLastSandboxMode", "newTaskLastSandboxMode"],
];

// Renamed shortcut IDs, remapped in place inside the `shortcutBindings` blob.
const SHORTCUT_ID_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["workspace-prev", "task-prev"],
  ["workspace-next", "task-next"],
  ["workspace-prev-arrow", "task-prev-arrow"],
  ["workspace-next-arrow", "task-next-arrow"],
  ["new-workspace-quick", "new-task-quick"],
];

try {
  for (const [oldKey, newKey] of RENAMES) {
    const oldVal = localStorage.getItem(oldKey);
    if (oldVal === null) continue; // nothing to migrate (fresh install / already done)
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldVal);
    }
    localStorage.removeItem(oldKey);
  }

  const rawBindings = localStorage.getItem("shortcutBindings");
  if (rawBindings) {
    const parsed = JSON.parse(rawBindings) as Record<string, unknown>;
    let changed = false;
    for (const [oldId, newId] of SHORTCUT_ID_RENAMES) {
      if (oldId in parsed) {
        // Old ID wins only if the new ID hasn't already been written.
        if (!(newId in parsed)) parsed[newId] = parsed[oldId];
        delete parsed[oldId];
        changed = true;
      }
    }
    if (changed) localStorage.setItem("shortcutBindings", JSON.stringify(parsed));
  }
} catch {
  // Storage unavailable / blob unparseable: prefs just fall back to their
  // defaults. Never fatal to boot.
}
