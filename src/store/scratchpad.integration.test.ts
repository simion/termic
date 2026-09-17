// @vitest-environment happy-dom
//
// The scratchpad lifecycle (GH #244) end to end through the store: create,
// restore across a "relaunch", the three-way close, and promotion into a real
// file. These are the invariants the feature's rule depends on —
//
//   a pad is an unsaved buffer that happens to survive restarts
//
// — and each of them is a way to lose someone's note if it breaks.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  // Every task activation stamps `last_opened_at` through these; a mock
  // missing them throws on property access, not on call.
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
  taskSetParked: vi.fn().mockResolvedValue(null),
  taskGitPhaseState: vi.fn().mockRejectedValue(new Error("not mocked")),
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  scratchList: vi.fn().mockResolvedValue([]),
  scratchRead: vi.fn().mockResolvedValue(""),
  scratchWrite: vi.fn().mockResolvedValue(undefined),
  scratchSetMeta: vi.fn().mockResolvedValue(undefined),
  scratchDelete: vi.fn().mockResolvedValue(undefined),
  scratchPromote: vi.fn().mockResolvedValue(undefined),
  scratchPromoteTargetExists: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn(),
}));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
  isTerminalCli: vi.fn(() => false),
  STICKY_DONE_MS: 8_000,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { newScratchTab, restoreScratchTabs } from "@/lib/scratchTabs";
import { requestCloseTab, requestCloseTabs } from "@/lib/closeTab";
import type { ScratchTab } from "@/lib/types";

const TASK = "task-1";

function pads(): ScratchTab[] {
  return (useApp.getState().tabs[TASK] ?? []).filter((t): t is ScratchTab => t.type === "scratch");
}

/** Answer the next close prompt with `choice`, once it is on screen.
 *  `askScratchClose` defers by a macrotask (the Radix pointer-events fix), so
 *  poll rather than assuming it has opened yet. */
async function answerClosePrompt(choice: "save" | "discard" | "cancel") {
  for (let i = 0; i < 20 && !useUI.getState().scratchClose; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
  useUI.getState().resolveScratchClose(choice);
}

async function answerSavePrompt(saved: boolean) {
  for (let i = 0; i < 20 && !useUI.getState().scratchSave; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
  useUI.getState().resolveScratchSave(saved);
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ tabs: {}, activeTab: {}, tasks: [], closedTabs: {} });
  useUI.setState({ scratchClose: null, scratchSave: null, toasts: [] });
});

describe("creating a pad", () => {
  it("adds a focused, permanently-dirty tab and creates its record", async () => {
    await newScratchTab(TASK);
    const [pad] = pads();
    expect(pad).toBeTruthy();
    expect(pad.title).toBe("Untitled");
    // Dirty for its whole life: nothing has been saved anywhere the user
    // chose, so the dot on the pill has to be on from the first frame.
    expect(pad.dirty).toBe(true);
    // NEVER preview: openPreviewTab recycles the first tab carrying that
    // flag, and recycling a pad would silently retarget it at a file.
    expect(pad.preview).toBeFalsy();
    expect(useApp.getState().activeTab[TASK]).toBe(pad.id);
    // The record exists before the first keystroke, so a crash right after
    // creating leaves a pad rather than a tab pointing at nothing.
    expect(ipc.scratchWrite).toHaveBeenCalledWith(TASK, pad.scratchId, "");
  });

  it("keeps pads out of the durable agent-tab set", async () => {
    await newScratchTab(TASK);
    // persisted_tabs is agent-tabs-only by construction; a pad in there would
    // be restored as a terminal on the next launch.
    const persisted = vi.mocked(ipc.taskSetTabs).mock.calls.at(-1)?.[1] ?? [];
    expect(persisted).toEqual([]);
  });
});

describe("restoring pads", () => {
  it("brings back every record, unfocused, in index order", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValueOnce([
      { id: "a", title: "first note", order: 0, created_at: "t", updated_at: "t" },
      { id: "b", title: "second note", syntax: "json", order: 1, created_at: "t", updated_at: "t" },
    ]);
    await restoreScratchTabs(TASK);
    expect(pads().map(p => p.scratchId)).toEqual(["a", "b"]);
    expect(pads().map(p => p.title)).toEqual(["first note", "second note"]);
    // The manual syntax pick survives the relaunch: a pad has no extension
    // to re-derive it from, so the index is the only record of it.
    expect(pads()[1].syntax).toBe("json");
    // Reopening a task should land the user on their agent, not on a note.
    expect(useApp.getState().activeTab[TASK]).toBeUndefined();
  });

  it("is idempotent, so a remount cannot double a tab", async () => {
    vi.mocked(ipc.scratchList).mockResolvedValue([
      { id: "a", title: "note", order: 0, created_at: "t", updated_at: "t" },
    ]);
    await restoreScratchTabs(TASK);
    await restoreScratchTabs(TASK);
    expect(pads()).toHaveLength(1);
  });

  it("does not throw when the index cannot be read", async () => {
    vi.mocked(ipc.scratchList).mockRejectedValueOnce(new Error("nope"));
    await expect(restoreScratchTabs(TASK)).resolves.toBeUndefined();
    expect(pads()).toHaveLength(0);
  });
});

describe("closing a pad", () => {
  it("Discard deletes the pad and closes the tab", async () => {
    await newScratchTab(TASK);
    const pad = pads()[0];
    const closing = requestCloseTab(TASK, pad.id);
    await answerClosePrompt("discard");
    await closing;
    expect(ipc.scratchDelete).toHaveBeenCalledWith(TASK, pad.scratchId);
    expect(pads()).toHaveLength(0);
  });

  it("Cancel keeps both the tab and the pad", async () => {
    await newScratchTab(TASK);
    const pad = pads()[0];
    const closing = requestCloseTab(TASK, pad.id);
    await answerClosePrompt("cancel");
    await closing;
    expect(ipc.scratchDelete).not.toHaveBeenCalled();
    expect(pads()).toHaveLength(1);
  });

  it("Save… closes only if the promote actually goes through", async () => {
    await newScratchTab(TASK);
    const pad = pads()[0];
    // Backing out of the picker must leave the pad AND the tab alone, not
    // fall through to discarding it.
    const backedOut = requestCloseTab(TASK, pad.id);
    await answerClosePrompt("save");
    await answerSavePrompt(false);
    await backedOut;
    expect(ipc.scratchDelete).not.toHaveBeenCalled();
    expect(pads()).toHaveLength(1);

    const saved = requestCloseTab(TASK, pad.id);
    await answerClosePrompt("save");
    await answerSavePrompt(true);
    await saved;
    expect(useApp.getState().tabs[TASK] ?? []).toHaveLength(0);
    // Promotion is what removes the record; the close path must not ALSO
    // delete it (the file it just became would still be there, but a second
    // delete on a live pad id is how a save turns into a loss).
    expect(ipc.scratchDelete).not.toHaveBeenCalled();
  });

  it("a bulk close asks about EVERY pad, one prompt each", async () => {
    await newScratchTab(TASK);
    await newScratchTab(TASK);
    await newScratchTab(TASK);
    const [a, b, c] = pads();

    // One confirm click must never decide the fate of three notes, so each
    // pad gets its own three-way prompt. Cancel spares THAT pad; the rest of
    // the set still closes.
    const closing = requestCloseTabs(TASK, [a.id, b.id, c.id]);
    await answerClosePrompt("discard");
    await answerClosePrompt("cancel");
    await answerClosePrompt("discard");
    await closing;

    expect(pads().map(p => p.scratchId)).toEqual([b.scratchId]);
    expect(ipc.scratchDelete).toHaveBeenCalledWith(TASK, a.scratchId);
    expect(ipc.scratchDelete).toHaveBeenCalledWith(TASK, c.scratchId);
    // The spared one is still on disk.
    expect(ipc.scratchDelete).not.toHaveBeenCalledWith(TASK, b.scratchId);
  });

  it("a bulk close of pads alone skips the counting confirm", async () => {
    await newScratchTab(TASK);
    const [pad] = pads();
    // confirmBulkClose counts dirty FILES and live agents; pads are absent
    // from it because they are about to be asked about individually. A
    // "Close 1 tab?" modal in front of the pad's own prompt is two dialogs
    // for one decision.
    const closing = requestCloseTabs(TASK, [pad.id]);
    await answerClosePrompt("discard");
    await closing;
    expect(useUI.getState().confirm).toBeNull();
    expect(pads()).toHaveLength(0);
  });
});

describe("promoting a pad", () => {
  it("turns the tab into a clean edit tab in the same slot", async () => {
    await newScratchTab(TASK);
    const pad = pads()[0];
    useApp.getState().promoteScratchTab(TASK, pad.id, "docs/notes.md");
    const tab = (useApp.getState().tabs[TASK] ?? [])[0];
    expect(tab.type).toBe("edit");
    expect(tab.id).toBe(pad.id);            // same tab, same slot in the strip
    expect((tab as { path: string }).path).toBe("docs/notes.md");
    expect(tab.title).toBe("notes.md");
    // The one path in the app that ends a pad's permanent dirty state.
    expect(tab.dirty).toBe(false);
    // No pad leftovers on an EditTab: a stale `syntax` override would beat
    // the extension the user just chose in the save dialog.
    expect((tab as { scratchId?: string }).scratchId).toBeUndefined();
    expect((tab as { syntax?: string }).syntax).toBeUndefined();
  });

  it("keeps a manual rename, and refuses to touch a non-pad", async () => {
    await newScratchTab(TASK);
    const pad = pads()[0];
    useApp.getState().patchTab(TASK, pad.id, { title: "My note", customTitle: true });
    useApp.getState().promoteScratchTab(TASK, pad.id, "notes.md");
    expect((useApp.getState().tabs[TASK] ?? [])[0].title).toBe("My note");
    // Idempotent: a second call on the now-edit tab is a no-op rather than a
    // rewrite that would clobber the name.
    useApp.getState().promoteScratchTab(TASK, pad.id, "other.md");
    expect((useApp.getState().tabs[TASK] ?? [])[0]).toMatchObject({ path: "notes.md" });
  });
});
