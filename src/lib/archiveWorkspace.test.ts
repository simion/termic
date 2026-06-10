import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the vi.mock factories can reference them.
const h = vi.hoisted(() => ({
  workspaceArchive: vi.fn(),
  loadAll: vi.fn(),
  setActiveWorkspace: vi.fn(),
  state: { activeWorkspaceId: null as string | null },
}));

vi.mock("@/lib/ipc", () => ({ workspaceArchive: h.workspaceArchive }));
vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({
      activeWorkspaceId: h.state.activeWorkspaceId,
      setActiveWorkspace: h.setActiveWorkspace,
      loadAll: h.loadAll,
    }),
  },
}));

import { archiveAndRefresh } from "@/lib/archiveWorkspace";

beforeEach(() => {
  h.workspaceArchive.mockReset().mockResolvedValue(undefined);
  h.loadAll.mockReset().mockResolvedValue(undefined);
  h.setActiveWorkspace.mockReset();
  h.state.activeWorkspaceId = null;
});

describe("archiveAndRefresh (issue #24)", () => {
  it("archives then refreshes on success", async () => {
    await archiveAndRefresh("w1", false);
    expect(h.workspaceArchive).toHaveBeenCalledWith("w1", false);
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });

  it("STILL refreshes when archive rejects on a cleanup error", async () => {
    // The bug: a best-effort cleanup failure (e.g. `git worktree remove`)
    // rejects the IPC even though the workspace is already marked archived.
    // The refresh must run anyway, or the sidebar stays stale until reload.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.workspaceArchive.mockRejectedValue(new Error("worktree remove: locked"));

    await expect(archiveAndRefresh("w1", false)).resolves.toBeUndefined();
    expect(h.loadAll).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled(); // the cleanup warning is surfaced, not swallowed silently
    spy.mockRestore();
  });

  it("deselects the workspace when it was the active one", async () => {
    h.state.activeWorkspaceId = "w1";
    await archiveAndRefresh("w1", true);
    expect(h.setActiveWorkspace).toHaveBeenCalledWith(null);
    expect(h.workspaceArchive).toHaveBeenCalledWith("w1", true);
  });

  it("leaves an unrelated active workspace selected", async () => {
    h.state.activeWorkspaceId = "other";
    await archiveAndRefresh("w1", false);
    expect(h.setActiveWorkspace).not.toHaveBeenCalled();
    expect(h.loadAll).toHaveBeenCalledTimes(1);
  });
});
