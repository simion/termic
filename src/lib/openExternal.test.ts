// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
vi.mock("@/lib/ipc", () => ({ openFileExternal: vi.fn() }));

import { openInDefaultApp } from "@/lib/openExternal";
import { openFileExternal } from "@/lib/ipc";
import { useUI } from "@/store/ui";

const mocked = openFileExternal as unknown as ReturnType<typeof vi.fn>;
const toasts = () => useUI.getState().toasts;

describe("openInDefaultApp", () => {
  beforeEach(() => {
    mocked.mockReset();
    useUI.setState({ toasts: [] });
  });

  it("stays silent when the default app took the file", async () => {
    // The app coming to the front is the feedback; a toast on top of it is
    // noise on the common path.
    mocked.mockResolvedValue("opened");
    await openInDefaultApp("/w/model.blend", "model.blend");
    expect(mocked).toHaveBeenCalledWith("/w/model.blend");
    expect(toasts()).toHaveLength(0);
  });

  it("explains the file-manager fallback when nothing claims the file", async () => {
    // Otherwise a Finder window just appears with no reason given.
    mocked.mockResolvedValue("revealed");
    await openInDefaultApp("/w/model.blend", "model.blend");
    const [toast] = toasts();
    expect(toast.kind).toBe("info");
    expect(toast.msg).toContain("model.blend");
  });

  it("reports a failure instead of swallowing it", async () => {
    // Both the open AND the reveal failed: without this the double-click is
    // indistinguishable from the dead gesture #147 set out to fix.
    mocked.mockRejectedValue("xdg-open: not found");
    await openInDefaultApp("/w/model.blend", "model.blend");
    const [toast] = toasts();
    expect(toast.kind).toBe("error");
    expect(toast.msg).toContain("model.blend");
    expect(toast.msg).toContain("xdg-open: not found");
  });

  it("never rejects, so a click handler can fire and forget", async () => {
    mocked.mockRejectedValue(new Error("boom"));
    await expect(openInDefaultApp("/w/a.txt", "a.txt")).resolves.toBeUndefined();
  });
});
