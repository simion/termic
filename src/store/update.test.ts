import { describe, it, expect } from "vitest";

// Mock Tauri/store imports before importing the module.
import { vi } from "vitest";
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/store/app", () => ({ useApp: { getState: vi.fn(() => ({})), setState: vi.fn(), subscribe: vi.fn() } }));

import { cmpVersion, entryFor } from "@/store/update";
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
