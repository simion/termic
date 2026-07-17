// @vitest-environment happy-dom
//
// Agent Race Slice 1: proves the deterministic orchestration with the REAL
// race store, REAL useApp.mountTasks, and REAL startRace (only ipc /
// runTabs / agentSend are mocked, since those hit the OS). Covers: the cohort
// store (start / latestRace / end / prune), mountTasks unioning without
// stealing focus, startRace creating one worktree per racer with distinct
// branches + recording the cohort, and the poll -> settle -> inject timing
// that seeds the shared prompt into each agent once its PTY is up.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  taskCreate: vi.fn().mockResolvedValue(undefined),
  taskSetYolo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runTabs", () => ({ launchSetupTab: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/agentSend", () => ({ sendMessageToPty: vi.fn() }));

import { useApp } from "@/store/app";
import { useRace, latestRace, raceOf } from "@/store/race";
import { startRace, suggestRaceName } from "@/lib/agentRace";
import { taskCreate, taskSetYolo } from "@/lib/ipc";
import { sendMessageToPty } from "@/lib/agentSend";
import type { TerminalTab } from "@/lib/types";

const createCalls = () => (taskCreate as unknown as { mock: { calls: any[][] } }).mock.calls;

// Map-backed localStorage stub: Node's own experimental `localStorage`
// global shadows happy-dom's on some setups and is unusable without
// `--localstorage-file` (same issue documented in prefs.test.ts), so the
// real global can't be relied on here.
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
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", fakeLocalStorage());
  useRace.setState({ races: {} });
  useApp.setState({
    tabs: {}, activeTab: {}, activeTaskId: null,
    mountedTasks: new Set(), tasks: [], projects: [], agents: [],
    // Reload after create is a no-op here; the test seeds tabs by hand to
    // stand in for TerminalPane's real PTY spawn.
    loadAll: async () => {},
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

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

  // The board's picker: the strip shows only on the racers themselves, so a
  // race must not render over bystander tasks (same project or not).
  it("raceOf finds the race containing a task, null for bystanders", () => {
    useRace.getState().start({ id: "rA", prompt: "a", taskIds: ["a1", "a2"], createdAt: 100 });
    useRace.getState().start({ id: "rB", prompt: "b", taskIds: ["b1"], createdAt: 200 });

    expect(raceOf(useRace.getState().races, "a2")?.id).toBe("rA");
    expect(raceOf(useRace.getState().races, "b1")?.id).toBe("rB");
    expect(raceOf(useRace.getState().races, "bystander")).toBeNull();
    expect(raceOf(useRace.getState().races, null)).toBeNull();
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

  // A named race (the "name the branch/task yourself" follow-up): the slug
  // replaces the random middle branch segment, the raw name prefixes the task
  // names, and the race record carries it for the board label.
  it("uses the race name for branches, task names, and the cohort record", async () => {
    await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "codex", n: 1 }],
      prompt: "improve the SEO",
      name: "SEO pass",
    });

    const branches = createCalls().map(c => c[0].branch as string);
    expect(branches).toEqual(["race/seo-pass/claude-1", "race/seo-pass/codex-1"]);

    const names = createCalls().map(c => c[0].name as string);
    expect(names).toEqual(["SEO pass: Claude #1", "SEO pass: Codex #1"]);

    const race = latestRace(useRace.getState().races)!;
    expect(race.name).toBe("SEO pass");
    expect(race.prompt).toBe("improve the SEO");
  });

  // The dialog's Branch field: an explicit middle segment wins over the
  // name's slug for branches, while the name still prefixes task names.
  it("an explicit branch segment overrides the name slug for branches only", async () => {
    await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "codex", n: 1 }],
      prompt: "improve the SEO",
      name: "SEO pass",
      branch: "Seo Try 2",
    });

    const branches = createCalls().map(c => c[0].branch as string);
    expect(branches).toEqual(["race/seo-try-2/claude-1", "race/seo-try-2/codex-1"]);
    expect(createCalls().map(c => c[0].name)).toEqual(["SEO pass: Claude #1", "SEO pass: Codex #1"]);
    expect(latestRace(useRace.getState().races)!.name).toBe("SEO pass");
  });

  // Unattended racers stall on permission prompts, so the dialog offers a
  // sandbox pin (Enforce = YOLO auto-on at spawn, no task flag needed) and
  // the dangerous no-cage YOLO (task.yolo set before anything mounts).
  it("sandbox pins Enforce on every racer; yolo sets the task flag pre-mount", async () => {
    await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "codex", n: 1 }],
      prompt: "do the thing",
      sandbox: true,
    });
    for (const c of createCalls()) {
      expect(c[0].sandbox_enabled).toBe(true);
      expect(c[0].sandbox_mode).toBe("enforce");
    }
    expect(taskSetYolo).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const ids = await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "codex", n: 1 }],
      prompt: "do the thing",
      sandbox: false,
      yolo: true,
    });
    for (const c of createCalls()) {
      expect(c[0].sandbox_enabled).toBe(false);
      expect(c[0].sandbox_mode).toBe("off");
    }
    for (const id of ids) expect(taskSetYolo).toHaveBeenCalledWith(id, true);
  });

  it("treats a blank or unsluggable name as absent (random-id branches, bare task names)", async () => {
    await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "claude", n: 2 }],
      prompt: "do the thing",
      name: "  ??? ",
    });

    const branches = createCalls().map(c => c[0].branch as string);
    expect(branches[0]).toMatch(/^race\/[0-9a-f]{8}\/claude-1$/);
    expect(createCalls().map(c => c[0].name)).toEqual(["Claude #1", "Claude #2"]);
    expect(latestRace(useRace.getState().races)!.name).toBeUndefined();
  });

  it("reports 1-based progress before each sequential worktree create", async () => {
    const seen: Array<[number, number]> = [];
    await startRace({
      projectId: "p1",
      racers: [{ cli: "claude", n: 1 }, { cli: "claude", n: 2 }, { cli: "codex", n: 1 }],
      prompt: "do the thing",
      onProgress: (n, total) => {
        seen.push([n, total]);
        // "before": racer n's create hasn't happened yet when its tick fires.
        expect(createCalls().length).toBe(n - 1);
      },
    });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
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
