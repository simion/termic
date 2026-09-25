// Creating, restoring and discarding scratchpad tabs (GH #244).
//
// A pad is an unsaved buffer that happens to survive restarts, scoped to ONE
// task. The buffer and its index record live under `<data_dir>/scratch/<taskId>/`
// (Rust side), never inside the worktree.
//
// This module owns everything about a pad EXCEPT the buffer itself, which
// EditorPane reads/writes directly (see its `scratch` branch), and the close
// prompt, which lives in lib/closeTab.ts with every other close.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import type { ScratchTab } from "@/lib/types";
import { SCRATCH_UNTITLED } from "@/lib/scratchTitle";

/** The pads already open in `taskId`'s strip, by scratch id. */
function openScratchIds(taskId: string): Set<string> {
  return new Set(
    (useApp.getState().tabs[taskId] ?? [])
      .filter((t): t is ScratchTab => t.type === "scratch")
      .map(t => t.scratchId),
  );
}

export function scratchTab(rec: { id: string; title?: string; syntax?: string }): ScratchTab {
  return {
    id: crypto.randomUUID(),
    type: "scratch",
    scratchId: rec.id,
    title: rec.title || SCRATCH_UNTITLED,
    // Dirty for its whole life: nothing has been saved anywhere the user
    // chose, and the dot on the pill is the honest signal for that. Only
    // promotion (⌘S) ends it, by turning this into an `edit` tab.
    dirty: true,
    ...(rec.syntax ? { syntax: rec.syntax } : {}),
    // NEVER `preview: true`. openPreviewTab recycles the first tab carrying
    // that flag, and recycling a pad would silently retarget it at a file.
  };
}

/** New empty pad in `taskId`, focused. The record is created eagerly (an
 *  empty buffer write) so a crash before the first keystroke still leaves a
 *  pad rather than a tab pointing at nothing. */
export async function newScratchTab(taskId: string): Promise<string> {
  const scratchId = crypto.randomUUID();
  const tab = scratchTab({ id: scratchId });
  useApp.getState().addTab(taskId, tab);
  try {
    await ipc.scratchWrite(taskId, scratchId, "");
  } catch (e) {
    useUI.getState().pushToast(i18n.t("backend:scratchTabs.createFailed", { error: String(e) }), "error");
  }
  return tab.id;
}

/** Tasks with a restore in flight — see the guard below. */
const restoring = new Set<string>();

/** Bring back the task's pads on first entry into it (quit → relaunch →
 *  every pad still there, untouched). Idempotent: a pad already open in the
 *  strip is skipped, so a second call can't double a tab.
 *
 *  Restored unfocused and in index order, behind whatever agent tab the
 *  restore path just seeded: reopening a task should land the user on their
 *  agent, not on a note. */
export async function restoreScratchTabs(taskId: string): Promise<void> {
  // Two restores in flight for one task would both see an empty strip while
  // the other's `scratchList` is still resolving, and each would add every
  // pad. The idempotence check below is not enough on its own because it runs
  // AFTER an await.
  if (restoring.has(taskId)) return;
  restoring.add(taskId);
  try {
    await restoreScratchTabsInner(taskId);
  } finally {
    restoring.delete(taskId);
  }
}

async function restoreScratchTabsInner(taskId: string): Promise<void> {
  let recs: ipc.ScratchRecord[];
  try {
    recs = await ipc.scratchList(taskId);
  } catch {
    // A pad that fails to list is not worth a toast on every task open; the
    // buffers are still on disk and the next launch tries again.
    return;
  }
  const open = openScratchIds(taskId);
  for (const rec of recs) {
    if (open.has(rec.id)) continue;
    useApp.getState().addTab(taskId, scratchTab(rec), { focus: false });
  }
}

/** Delete a pad for good (the close prompt's Discard). The tab is closed by
 *  the caller — this is only the on-disk half. */
export async function discardScratchPad(taskId: string, scratchId: string): Promise<void> {
  try {
    await ipc.scratchDelete(taskId, scratchId);
  } catch (e) {
    useUI.getState().pushToast(i18n.t("backend:scratchTabs.deleteFailed", { error: String(e) }), "error");
  }
}
