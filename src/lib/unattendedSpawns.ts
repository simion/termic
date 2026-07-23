// Tasks whose NEXT default-tab seed must spawn unattended (a prompt will
// be injected with nobody at the keyboard, so the spawn has to compose
// UNATTENDED_SPAWN_ARGS or a startup update menu can swallow it - same
// mechanism as race cohorts, see ensureTabs in store/app.ts). The CLI's
// new_task handler marks the task before mounting; the seed consumes it.
//
// Dependency-free on purpose: both store/app.ts and lib/cliRpc.ts import
// this, and anything heavier would cycle.

const pending = new Set<string>();

export function markUnattendedSpawn(taskId: string): void {
  pending.add(taskId);
}

/** Check-and-consume: the default-tab seed runs once per fresh task. */
export function takeUnattendedSpawn(taskId: string): boolean {
  return pending.delete(taskId);
}
