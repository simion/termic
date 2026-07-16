// @vitest-environment happy-dom
//
// Agent Race Slice 1: proves the deterministic orchestration with the REAL
// race store, REAL useApp.mountTasks, and REAL startRace (only ipc /
// runTabs / agentSend are mocked, since those hit the OS). Covers: the cohort
// store (start / latestRace / end / prune), mountTasks unioning without
// stealing focus, startRace creating one worktree per racer with distinct
// branches + recording the cohort, and the poll -> settle -> inject timing
// that seeds the shared prompt into each agent once its PTY is up.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({ taskCreate: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/runTabs", () => ({ launchSetupTab: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/agentSend", () => ({ sendMessageToPty: vi.fn() }));

import { useApp } from "@/store/app";
import { useRace, latestRace } from "@/store/race";
import { startRace } from "@/lib/agentRace";
import { taskCreate } from "@/lib/ipc";
import { sendMessageToPty } from "@/lib/agentSend";
import type { TerminalTab } from "@/lib/types";

const createCalls = () => (taskCreate as unknown as { mock: { calls: any[][] } }).mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useRace.setState({ races: {} });
  useApp.setState({
    tabs: {}, activeTab: {}, activeTaskId: null,
    mountedTasks: new Set(), tasks: [], projects: [], agents: [],
    // Reload after create is a no-op here; the test seeds tabs by hand to
    // stand in for TerminalPane's real PTY spawn.
    loadAll: async () => {},
  });
});

describe("race cohort store", () => {
  it("records a cohort, latestRace picks the newest, end removes it", () => {
    useRace.getState().start({ id: "r1", prompt: "a", taskIds: ["t1", "t2"], createdAt: 100 });
    useRace.getState().start({ id: "r2", prompt: "b", taskIds: ["t3"], createdAt: 200 });
    expect(latestRace(useRace.getState().races)?.id).toBe("r2");
    useRace.getState().end("r2");
    expect("r2" in useRace.getState().races).toBe(false);
    expect(latestRace(useRace.getState().races)?.id).toBe("r1");
  });

  it("persists to localStorage so a race survives restart", () => {
    useRace.getState().start({ id: "r1", prompt: "a", taskIds: ["t1"], createdAt: 100 });
    expect(JSON.parse(localStorage.getItem("agentRaces")!).r1.taskIds).toEqual(["t1"]);
  });

  it("prune drops dead task ids and removes fully-dead races", () => {
    useRace.getState().start({ id: "r1", prompt: "a", taskIds: ["t1", "t2"], createdAt: 100 });
    useRace.getState().start({ id: "r2", prompt: "b", taskIds: ["t3"], createdAt: 200 });
    useRace.getState().prune(new Set(["t1"]));
    expect(useRace.getState().races.r1.taskIds).toEqual(["t1"]);
    expect("r2" in useRace.getState().races).toBe(false);
  });
});

describe("mountTasks", () => {
  it("unions ids into mountedTasks without changing the active task", () => {
    useApp.setState({ activeTaskId: "x", mountedTasks: new Set(["x"]) });
    useApp.getState().mountTasks(["a", "b", "x"]);
    expect(useApp.getState().mountedTasks).toEqual(new Set(["x", "a", "b"]));
    expect(useApp.getState().activeTaskId).toBe("x");
  });
});

describe("startRace", () => {
  it("creates one worktree per racer with distinct branches + records the cohort", async () => {
    const ids = await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "claude", n: 2 }, { cli: "codex", n: 1 }],
      prompt: "refactor the parser",
    });

    expect(ids).toHaveLength(3);
    expect(taskCreate).toHaveBeenCalledTimes(3);

    const branches = createCalls().map(c => c[0].branch as string);
    expect(new Set(branches).size).toBe(3);
    expect(branches.every(b => b.startsWith("race/"))).toBe(true);

    const names = createCalls().map(c => c[0].name as string);
    expect(names).toEqual(["Claude #1", "Claude #2", "Codex #1"]);

    const race = latestRace(useRace.getState().races)!;
    expect(race.taskIds).toEqual(ids);
    expect(race.prompt).toBe("refactor the parser");
    expect(useApp.getState().activeTaskId).toBe(ids[0]);
    for (const id of ids) expect(useApp.getState().mountedTasks.has(id)).toBe(true);
  });

  it("seeds the shared prompt into each agent once its PTY is up, after the settle", async () => {
    vi.useFakeTimers();
    try {
      const ids = await startRace({
        projectId: "p1",
        racers: [{ cli: "claude", n: 1 }, { cli: "claude", n: 2 }],
        prompt: "do the thing",
      });

      // Stand in for TerminalPane: seed each task's default agent tab + a PTY.
      for (const id of ids) {
        useApp.setState(s => ({
          tabs: { ...s.tabs, [id]: [{
            id: `tab-${id}`, type: "terminal", cli: "claude",
            is_default: true, ptyId: `pty-${id}`, title: "Claude",
          } as TerminalTab] },
        }));
      }

      // Poll picks up the PTY but the settle hasn't elapsed yet.
      await vi.advanceTimersByTimeAsync(300);
      expect(sendMessageToPty).not.toHaveBeenCalled();

      // Settle elapses -> the same prompt lands in every racer, lastInputAt
      // stamped so work-done detection re-arms (as runPrompt does).
      await vi.advanceTimersByTimeAsync(6000);
      expect(sendMessageToPty).toHaveBeenCalledTimes(2);
      for (const id of ids) {
        expect(sendMessageToPty).toHaveBeenCalledWith(`pty-${id}`, "do the thing");
        expect((useApp.getState().tabs[id][0] as TerminalTab).lastInputAt).toBeGreaterThan(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
