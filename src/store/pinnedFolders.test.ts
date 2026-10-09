// Pinned-folder store: insertion order, remap-on-rename, and the two rules
// that keep the map honest — nothing but project liveness may prune it, and
// a no-op action must not churn subscribers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePinnedFolders } from "./pinnedFolders";
import { scoped } from "@/lib/profileScope";

const PROJECT = "p1";
const OTHER = "p2";

// Map-backed stub: Node's own experimental `localStorage` global is unusable
// without `--localstorage-file` (same reasoning as fileViewed.test.ts). The
// store's module-level load() runs before this with no global at all, which
// its try/catch already treats as empty.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  usePinnedFolders.setState({ byProject: {}, sectionCollapsed: false });
});

const pins = (projectId: string) => usePinnedFolders.getState().byProject[projectId];
const stored = () => JSON.parse(localStorage.getItem(scoped("pinnedFolders")) || "{}");

describe("pin / unpin / toggle", () => {
  it("pins in insertion order", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(PROJECT, "src/components");
    expect(pins(PROJECT)).toEqual(["dist", "src/components"]);
  });

  it("ignores a duplicate pin (no churn)", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    const before = usePinnedFolders.getState().byProject;
    usePinnedFolders.getState().pin(PROJECT, "dist");
    expect(usePinnedFolders.getState().byProject).toBe(before);
  });

  it("unpins and keeps the rest in order", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(PROJECT, "src");
    usePinnedFolders.getState().pin(PROJECT, "docs");
    usePinnedFolders.getState().unpin(PROJECT, "src");
    expect(pins(PROJECT)).toEqual(["dist", "docs"]);
  });

  it("toggles", () => {
    usePinnedFolders.getState().toggle(PROJECT, "dist");
    expect(pins(PROJECT)).toEqual(["dist"]);
    usePinnedFolders.getState().toggle(PROJECT, "dist");
    expect(pins(PROJECT)).toEqual([]);
  });

  it("keeps projects independent", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(OTHER, "src");
    expect(pins(PROJECT)).toEqual(["dist"]);
    expect(pins(OTHER)).toEqual(["src"]);
  });

  it("writes through to localStorage in the profile-scoped key", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(PROJECT, "src");
    expect(stored()).toEqual({ [PROJECT]: ["dist", "src"] });
  });
});

describe("remap", () => {
  it("follows a rename in place, keeping order", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(PROJECT, "src");
    usePinnedFolders.getState().remap(PROJECT, "src", "source");
    expect(pins(PROJECT)).toEqual(["dist", "source"]);
  });

  it("rewrites every pin beneath the renamed folder", () => {
    usePinnedFolders.getState().pin(PROJECT, "src/components");
    usePinnedFolders.getState().pin(PROJECT, "src/lib");
    usePinnedFolders.getState().pin(PROJECT, "docs");
    usePinnedFolders.getState().remap(PROJECT, "src", "source");
    expect(pins(PROJECT)).toEqual(["source/components", "source/lib", "docs"]);
  });

  it("leaves unrelated pins untouched", () => {
    usePinnedFolders.getState().pin(PROJECT, "src");
    usePinnedFolders.getState().pin(PROJECT, "srcutils");
    usePinnedFolders.getState().remap(PROJECT, "src", "source");
    expect(pins(PROJECT)).toEqual(["source", "srcutils"]);
  });

  it("dedupes when the new name is already pinned", () => {
    // Renaming `a` onto pinned `b` leaves ONE b — not a stale `a` plus `b`.
    usePinnedFolders.getState().pin(PROJECT, "a");
    usePinnedFolders.getState().pin(PROJECT, "b");
    usePinnedFolders.getState().remap(PROJECT, "a", "b");
    expect(pins(PROJECT)).toEqual(["b"]);
  });

  it("is a no-op for an unpinned path (no churn, no write)", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    const before = usePinnedFolders.getState().byProject;
    usePinnedFolders.getState().remap(PROJECT, "src", "source");
    expect(usePinnedFolders.getState().byProject).toBe(before);
    expect(stored()).toEqual({ [PROJECT]: ["dist"] });
  });
});

describe("prune", () => {
  it("drops a project that no longer exists", () => {
    usePinnedFolders.getState().pin(OTHER, "src");
    usePinnedFolders.getState().prune(new Set([PROJECT]));
    expect(pins(OTHER)).toBeUndefined();
  });

  it("keeps every pin of a live project, whatever the tree shows", () => {
    // Project liveness is the only thing prune may consult: a folder missing
    // from one task's worktree (branch difference, build not run yet) must
    // not cost the pin.
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(PROJECT, "build/gone-in-this-branch");
    usePinnedFolders.getState().prune(new Set([PROJECT]));
    expect(pins(PROJECT)).toEqual(["dist", "build/gone-in-this-branch"]);
  });

  it("writes through when it drops a project", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    usePinnedFolders.getState().pin(OTHER, "src");
    usePinnedFolders.getState().prune(new Set([PROJECT]));
    expect(stored()).toEqual({ [PROJECT]: ["dist"] });
  });

  it("is a no-op when every project is still live", () => {
    usePinnedFolders.getState().pin(PROJECT, "dist");
    const before = usePinnedFolders.getState().byProject;
    usePinnedFolders.getState().prune(new Set([PROJECT]));
    // Same object identity: a no-op prune must not churn subscribers on
    // every loadAll (see performance.md bear trap 8).
    expect(usePinnedFolders.getState().byProject).toBe(before);
  });
});

describe("sectionCollapsed", () => {
  it("defaults to expanded", () => {
    expect(usePinnedFolders.getState().sectionCollapsed).toBe(false);
  });

  it("flips and writes through to its bare (machine-level) key", () => {
    usePinnedFolders.getState().setSectionCollapsed(true);
    expect(usePinnedFolders.getState().sectionCollapsed).toBe(true);
    expect(localStorage.getItem("pinnedSectionCollapsed")).toBe("1");
    usePinnedFolders.getState().setSectionCollapsed(false);
    expect(localStorage.getItem("pinnedSectionCollapsed")).toBe("0");
  });

  it("is a no-op when the value does not change", () => {
    usePinnedFolders.getState().setSectionCollapsed(false);
    expect(localStorage.getItem("pinnedSectionCollapsed")).toBeNull();
  });
});
