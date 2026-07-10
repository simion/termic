import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the vi.mock factories can reference them.
const h = vi.hoisted(() => ({
  taskArchive: vi.fn(),
  loadAll: vi.fn(),
  setActiveTask: vi.fn(),
  state: { activeTaskId: null as string | null },
}));

vi.mock("@/lib/ipc", () => ({ taskArchive: h.taskArchive }));
vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({
      activeTaskId: h.state.activeTaskId,
      setActiveTask: h.setActiveTask,
      loadAll: h.loadAll,
    }),
  },
}));

import { archiveAndRefresh } from "@/lib/archiveTask";

beforeEach(() => {
  h.taskArchive.mockReset().mockResolvedValue(undefined);
  h.loadAll.mockReset().mockResolvedValue(undefined);
  h.setActiveTask.mockReset();
  h.state.activeTaskId = null;
});

describe("archiveAndRefresh (issue #24)", () => {
  it("archives then refreshes on success", async () => {
    await archiveAndRefresh("w1", false);
    expect(h.taskArchive).toHaveBeenCalledWith("w1", false);
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });

  it("STILL refreshes when archive rejects on a cleanup error", async () => {
    // The bug: a best-effort cleanup failure (e.g. `git worktree remove`)
    // rejects the IPC even though the task is already marked archived.
    // The refresh must run anyway, or the sidebar stays stale until reload.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.taskArchive.mockRejectedValue(new Error("worktree remove: locked"));

    await expect(archiveAndRefresh("w1", false)).resolves.toBeUndefined();
    expect(h.loadAll).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled(); // the cleanup warning is surfaced, not swallowed silently
    spy.mockRestore();
  });

  it("deselects the task when it was the active one", async () => {
    h.state.activeTaskId = "w1";
    await archiveAndRefresh("w1", true);
    expect(h.setActiveTask).toHaveBeenCalledWith(null);
    expect(h.taskArchive).toHaveBeenCalledWith("w1", true);
  });

  it("leaves an unrelated active task selected", async () => {
    h.state.activeTaskId = "other";
    await archiveAndRefresh("w1", false);
    expect(h.setActiveTask).not.toHaveBeenCalled();
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });
});
