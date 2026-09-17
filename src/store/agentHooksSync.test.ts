import { describe, it, expect, vi, beforeEach } from "vitest";

// The mechanism (`agent_hooks_sync`) shipped complete and correct two schema
// versions before anything called it, so every existing install stayed pinned
// at its original version while reporting `installed: true`. These tests pin
// the WIRING, which is the half that was missing.
const calls: string[] = [];
const agentHooksSync = vi.fn(async () => { calls.push("sync"); return ["claude"]; });
const agentHooksStatus = vi.fn(async (id: string) => {
  calls.push(`status:${id}`);
  return { agent_id: id, host: { installed: true }, docker: { installed: true } };
});

vi.mock("@/lib/ipc", () => ({
  // Every task activation stamps `last_opened_at` through these; a mock
  // missing them throws on property access, not on call.
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
  taskSetParked: vi.fn().mockResolvedValue(null),
  taskGitPhaseState: vi.fn().mockRejectedValue(new Error("not mocked")),
  agentHooksSync: (...a: unknown[]) => agentHooksSync(...(a as [])),
  agentHooksStatus: (id: string) => agentHooksStatus(id),
  ptyWrite: vi.fn(), ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]), tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));

const { useApp } = await import("@/store/app");

beforeEach(() => {
  calls.length = 0;
  agentHooksSync.mockClear();
  agentHooksStatus.mockClear();
  useApp.setState({ agents: [{ id: "claude", kind: "agent" }] as never });
});

describe("syncAgentHooks", () => {
  it("upgrades a stale install before reading its status", async () => {
    // Order is the whole contract. Reading first would cache the status of the
    // install we are about to replace, and `agentHooksInstalled` drives whether
    // the terminal title may still end a turn.
    await useApp.getState().syncAgentHooks();
    expect(calls[0]).toBe("sync");
    expect(calls).toContain("status:claude");
    expect(useApp.getState().agentHooksInstalled.claude).toBe(true);
  });

  it("still reports status when the sync itself is refused", async () => {
    // An unreadable config or `disableAllHooks` makes sync a no-op. That must
    // leave a correct status, just a stale one, rather than no status at all.
    agentHooksSync.mockRejectedValueOnce(new Error("disableAllHooks"));
    await useApp.getState().syncAgentHooks();
    expect(calls).toContain("status:claude");
    expect(useApp.getState().agentHooksInstalled.claude).toBe(true);
  });

  it("does not introduce hooks for an agent with none", async () => {
    // Sync may REPLACE a set, never install one: the recorded consent is
    // "hooks on for this agent". The backend enforces it; this pins that the
    // store reports the backend's answer rather than assuming success.
    agentHooksStatus.mockImplementationOnce(async (id: string) => {
      calls.push(`status:${id}`);
      return { agent_id: id, host: { installed: false }, docker: { installed: false } };
    });
    await useApp.getState().syncAgentHooks();
    expect(useApp.getState().agentHooksInstalled.claude).toBe(false);
  });
});
