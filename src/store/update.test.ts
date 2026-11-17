import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock Tauri/store imports before importing the module.
import { vi } from "vitest";
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/store/app", () => ({ useApp: { getState: vi.fn(() => ({})), setState: vi.fn(), subscribe: vi.fn() } }));

import { check } from "@tauri-apps/plugin-updater";
import { cmpVersion, entryFor, useUpdate } from "@/store/update";
import type { ChangelogEntry } from "@/store/update";

// ── cmpVersion ────────────────────────────────────────────────────────

describe("cmpVersion", () => {
  it("returns 0 for equal versions", () => {
    expect(cmpVersion("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns positive when a has a newer patch", () => {
    expect(cmpVersion("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  it("returns negative when a has an older patch", () => {
    expect(cmpVersion("1.2.2", "1.2.3")).toBeLessThan(0);
  });

  it("returns positive when a has a newer minor", () => {
    expect(cmpVersion("1.3.0", "1.2.9")).toBeGreaterThan(0);
  });

  it("returns positive when a has a newer major", () => {
    expect(cmpVersion("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("treats missing segments as 0", () => {
    expect(cmpVersion("1.2", "1.2.0")).toBe(0);
  });

  it("handles rc/suffix by truncating at parseInt boundary", () => {
    // parseInt("3rc1", 10) → 3; so "1.0.3rc1" == "1.0.3"
    expect(cmpVersion("1.0.3rc1", "1.0.3")).toBe(0);
  });

  it("handles zero versions", () => {
    expect(cmpVersion("0.0.0", "0.0.0")).toBe(0);
  });

  it("handles large version numbers", () => {
    expect(cmpVersion("10.20.30", "9.99.99")).toBeGreaterThan(0);
  });
});

// ── entryFor ─────────────────────────────────────────────────────────

describe("entryFor", () => {
  const log: ChangelogEntry[] = [
    { version: "1.0.0", date: "2026-01-01", summary: "Initial release", notes: ["Initial release"] },
    { version: "1.1.0", date: "2026-02-01", summary: "New features", notes: ["New features"] },
    { version: "2.0.0", date: "2026-03-01", summary: "Breaking changes", notes: ["Breaking changes"] },
  ];

  it("finds an existing entry by version", () => {
    const entry = entryFor(log, "1.1.0");
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBe("New features");
    expect(entry!.notes).toEqual(["New features"]);
  });

  it("returns null for a version not in the changelog", () => {
    expect(entryFor(log, "9.9.9")).toBeNull();
  });

  it("returns null when changelog is null", () => {
    expect(entryFor(null, "1.0.0")).toBeNull();
  });

  it("matches exactly — no partial version matches", () => {
    // "1.0" should not match "1.0.0"
    expect(entryFor(log, "1.0")).toBeNull();
  });
});

// ── checkNow undismisses ──────────────────────────────────────────────

describe("checkNow", () => {
  // Reported: dismiss the update card, then "Check for updates" finds the
  // same version, toasts "Update available", and shows nothing. Both surfaces
  // hide on `update.version === dismissedVersion`, so the toast faded and left
  // no card, no pill and no way to install.
  //
  // Dismissing means "not now". Asking for a check is changing your mind.
  // This file runs in the node environment, which has no localStorage, and
  // the store's own accessors swallow that in a try/catch. A shim rather than
  // dropping the assertion: whether the cleared dismissal is PERSISTED is the
  // difference between the fix holding and the card hiding again on relaunch.
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    });
    vi.stubEnv("DEV", false);            // checkNow returns early in dev
    vi.stubEnv("VITE_BETA", "");         // ...and in a beta bundle
    localStorage.clear();
    useUpdate.setState({ update: null, dismissedVersion: "" });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("clears the dismissal when a check finds an update", async () => {
    useUpdate.setState({ dismissedVersion: "1.11.0" });
    vi.mocked(check).mockResolvedValue({ version: "1.11.0" } as never);

    const r = await useUpdate.getState().checkNow();

    expect(r).toBe("available");
    expect(useUpdate.getState().dismissedVersion).toBe("");
    // The thing the user actually wanted: the card's own condition passes.
    const s = useUpdate.getState();
    expect(s.update && s.update.version !== s.dismissedVersion).toBe(true);
  });

  it("keeps the dismissal when the check finds nothing", async () => {
    // A briefly unreachable manifest must not throw away a deliberate
    // dismissal, or the next background check re-shows the dismissed card.
    useUpdate.setState({ dismissedVersion: "1.11.0" });
    vi.mocked(check).mockResolvedValue(null as never);

    expect(await useUpdate.getState().checkNow()).toBe("uptodate");
    expect(useUpdate.getState().dismissedVersion).toBe("1.11.0");
  });

  it("bounds the manual check, so a hung network still reports", async () => {
    vi.mocked(check).mockResolvedValue(null as never);
    await useUpdate.getState().checkNow();
    expect(vi.mocked(check)).toHaveBeenLastCalledWith({ timeout: 10_000 });
  });

  it("keeps the dismissal when the check throws", async () => {
    useUpdate.setState({ dismissedVersion: "1.11.0" });
    vi.mocked(check).mockRejectedValue(new Error("offline"));

    expect(await useUpdate.getState().checkNow()).toBe("error");
    expect(useUpdate.getState().dismissedVersion).toBe("1.11.0");
  });

  it("persists the cleared dismissal, so a relaunch does not re-hide it", async () => {
    localStorage.setItem("updateDismissedVersion", "1.11.0");
    useUpdate.setState({ dismissedVersion: "1.11.0" });
    vi.mocked(check).mockResolvedValue({ version: "1.11.0" } as never);

    await useUpdate.getState().checkNow();
    expect(localStorage.getItem("updateDismissedVersion")).toBe("");
  });

  it("a NEWER version was never hidden by an older dismissal", async () => {
    // Why nobody who dismissed a card is stuck forever: the dismissal records
    // a VERSION, not a boolean, so the next release shows up on its own.
    useUpdate.setState({ dismissedVersion: "1.11.0" });
    vi.mocked(check).mockResolvedValue({ version: "1.11.1" } as never);

    await useUpdate.getState().checkNow();
    const s = useUpdate.getState();
    expect(s.update && s.update.version !== s.dismissedVersion).toBe(true);
  });
});
