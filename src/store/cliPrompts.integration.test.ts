// @vitest-environment happy-dom
//
// `termic prompts` / `-P` (Phase 4) driven through the REAL
// `listPromptsHandler` against the REAL prompt library store. The Rust
// server resolves selectors against exactly this handler's output, so
// what these tests pin is the RPC contract's data source: overrides
// applied, deleted builtins absent, disabled prompts present with the
// flag, bodies riding along. A test that fabricated the list would pass
// against a copy of any drift.
//
// localStorage rule (see prefs.test.ts): never touch the global one;
// the store hydrates from a Map-backed fake per test via
// vi.resetModules() + dynamic import, because prompts.ts reads
// localStorage once at module load.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Every task activation stamps `last_opened_at` through these; a mock missing
// them throws on property access, not on call.
vi.mock("@/lib/ipc", () => ({
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
  taskSetParked: vi.fn().mockResolvedValue(null),
  taskGitPhaseState: vi.fn().mockRejectedValue(new Error("not mocked")),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

async function fresh() {
  const [{ listPromptsHandler }, { usePromptLibrary }] = await Promise.all([
    import("@/lib/cliRpc"),
    import("@/store/prompts"),
  ]);
  return { listPromptsHandler, usePromptLibrary };
}

describe("cli list_prompts (Phase 4)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns the builtin library with ids, flags and bodies", async () => {
    const { listPromptsHandler } = await fresh();
    const { prompts } = listPromptsHandler();
    const review = prompts.find(p => p.id === "builtin:review");
    expect(review).toBeDefined();
    expect(review!.builtin).toBe(true);
    expect(review!.enabled).toBe(true);
    expect(review!.modified).toBe(false);
    // Bodies ride along: the server substitutes them for -P without a
    // second round-trip.
    expect(review!.body.length).toBeGreaterThan(0);
    // Every entry carries the full shape the Rust resolver deserializes.
    for (const p of prompts) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.title).toBe("string");
      expect(typeof p.body).toBe("string");
      expect(typeof p.builtin).toBe("boolean");
      expect(typeof p.enabled).toBe("boolean");
      expect(typeof p.modified).toBe("boolean");
    }
    // The list path asks for bodies:false and gets empty strings in a
    // stable shape (the field never disappears; Rust requires it).
    const slim = listPromptsHandler({ bodies: false }).prompts;
    expect(slim.length).toBe(prompts.length);
    expect(slim.every(p => p.body === "")).toBe(true);
    expect(slim.find(p => p.id === "builtin:review")!.title).toBe(review!.title);
  });

  it("reflects live overrides, and unedited builtins keep the shipped text", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    const shippedCommit = listPromptsHandler().prompts.find(p => p.id === "builtin:commit")!.body;
    usePromptLibrary.getState().updatePrompt("builtin:review", {
      title: "My Review", body: "Custom body.",
    });
    const { prompts } = listPromptsHandler();
    const review = prompts.find(p => p.id === "builtin:review")!;
    // The override is what -P delivers, under the SAME stable id.
    expect(review.title).toBe("My Review");
    expect(review.body).toBe("Custom body.");
    expect(review.modified).toBe(true);
    // A sibling builtin still tracks the shipped default.
    expect(prompts.find(p => p.id === "builtin:commit")!.body).toBe(shippedCommit);
  });

  it("omits deleted builtins and flags disabled ones without hiding them", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    usePromptLibrary.getState().deletePrompt("builtin:commit");
    usePromptLibrary.getState().toggleEnabled("builtin:review");
    const { prompts } = listPromptsHandler();
    // Deleted builtins do not exist (selectors must not resolve them).
    expect(prompts.some(p => p.id === "builtin:commit")).toBe(false);
    // Disabled = hidden from the dropdown, not dead: still listed, still
    // fireable by explicit selector server-side.
    const review = prompts.find(p => p.id === "builtin:review")!;
    expect(review.enabled).toBe(false);
  });

  it("lists custom prompts under their UUID ids", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    const id = usePromptLibrary.getState().addPrompt({ title: "Ship it", body: "Ship the diff." });
    const custom = listPromptsHandler().prompts.find(p => p.id === id)!;
    expect(custom.builtin).toBe(false);
    expect(custom.title).toBe("Ship it");
    expect(custom.body).toBe("Ship the diff.");
  });
});
