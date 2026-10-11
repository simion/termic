// @vitest-environment happy-dom
//
// The schedule runner against the REAL store, with IPC replaced by a small
// in-memory "disk" so a pass, a create and a loadAll see one consistent
// world. What is pinned here is the fire path and the clock's discipline;
// what happens when a run ends is watcher.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const disk = vi.hoisted(() => ({ tasks: [] as import("@/lib/types").Task[], seq: 0 }));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

vi.mock("@/lib/ipc", () => ({
  tasksList: vi.fn(async () => clone(disk.tasks)),
  taskOpenRepo: vi.fn(async (
    projectId: string, cli: string, name: string,
    sandbox: { enabled: boolean; mode?: string; rwPaths: string[]; allowedHosts: string[] } | undefined,
    _cmd: unknown, _resume: unknown, _override: unknown, agentArgs: string[] | undefined, yolo: boolean | undefined,
  ) => {
    const t = {
      id: `run-${++disk.seq}`, project_id: projectId, name, cli, branch: "main", base_branch: "main",
      path: "/Users/u/web", port: 18100, created: "", archived: false, is_main_checkout: true,
      agent_args: agentArgs ?? [], yolo: !!yolo,
      sandbox_enabled: !!sandbox?.enabled, sandbox_mode: sandbox?.mode ?? "off",
      sandbox_rw_paths: sandbox?.rwPaths ?? [], sandbox_allowed_hosts: sandbox?.allowedHosts ?? [],
    };
    disk.tasks.push(t as never);
    return clone(t);
  }),
  taskSetSchedule: vi.fn(async (id: string, schedule: unknown) => {
    const t = disk.tasks.find(x => x.id === id)!;
    if (schedule) t.schedule = clone(schedule) as never; else delete t.schedule;
  }),
  taskSetAccount: vi.fn(async () => {}),
  taskLinkSpawn: vi.fn(async (child: string, parent: string) => {
    const c = disk.tasks.find(x => x.id === child)!;
    const p = disk.tasks.find(x => x.id === parent)!;
    c.spawned_by = parent;
    if (!p.group) p.group = { id: p.id };
    c.group = clone(p.group);
  }),
  taskGroupNew: vi.fn(async (id: string) => { disk.tasks.find(x => x.id === id)!.group = { id }; }),
  taskDelete: vi.fn(async (id: string) => { disk.tasks = disk.tasks.filter(x => x.id !== id); }),
  taskArchive: vi.fn(async (id: string) => { disk.tasks.find(x => x.id === id)!.archived = true; }),
  taskRename: vi.fn(async (id: string, name: string) => {
    if (disk.tasks.some(x => x.id !== id && !x.archived && x.name.toLowerCase() === name.toLowerCase())) {
      throw `a task named "${name}" already exists in this project`;
    }
    disk.tasks.find(x => x.id === id)!.name = name;
  }),
  scheduleDeleteReports: vi.fn(async () => []),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/agentDelivery", () => ({
  waitForAgentPty: vi.fn().mockResolvedValue(true),
  deliverPromptWhenReady: vi.fn().mockResolvedValue({ ok: true, tabId: "tab" }),
}));
// The store's tab actions focus the DOM through retry timers; left real, one
// fires after happy-dom is torn down ("document is not defined", CI only).
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn(), focusPaneTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import * as ipc from "@/lib/ipc";
import { deliverPromptWhenReady } from "@/lib/agentDelivery";
import { useApp } from "@/store/app";
import { usePromptLibrary } from "@/store/prompts";
import { useUI } from "@/store/ui";
import {
  __resetScheduleRunnerForTests, createSchedule, deleteSchedule, isRunInFlight, runScheduleNow,
  scheduleTickNow, updateSchedule,
} from "@/lib/schedules/runner";
import type { Task, TaskSchedule } from "@/lib/types";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const SLOT = at(2, 9); // Friday 2026-10-02 09:00, local
const settle = () => new Promise(r => setTimeout(r, 0));

function schedule(extra: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    enabled: true, name: "grafana check", slug: "grafana-check", prompt: "check the dashboards",
    cadence: { kind: "daily", time: "09:00" }, catch_up: false, keep_runs: 7, report_days: 30,
    last_slot: at(1, 9), history: [], ...extra,
  };
}

function seed(parent: Partial<Task> = {}, s: TaskSchedule | null = schedule()) {
  disk.seq = 0;
  disk.tasks = [{
    id: "parent", project_id: "p1", name: "grafana check", branch: "main", base_branch: "main",
    path: "/Users/u/web", cli: "claude", port: 18100, created: "", archived: false, is_main_checkout: true,
    ...(s ? { schedule: s } : {}), ...parent,
  } as Task];
  useApp.setState({
    tasks: clone(disk.tasks),
    projects: [{ id: "p1", name: "web", root_path: "/Users/u/web" } as never],
    agents: [{ id: "claude", name: "Claude Code" }, { id: "plain", name: "Plain", work_done: false }] as never,
    mountedTasks: new Set<string>(),
    tabs: {},
    loadAll: async () => { useApp.setState({ tasks: clone(disk.tasks) }); },
  } as never);
}

const stored = () => useApp.getState().tasks.find(t => t.id === "parent")!.schedule!;

beforeEach(() => {
  vi.clearAllMocks();
  __resetScheduleRunnerForTests();
  seed();
});

describe("an idle pass", () => {
  it("writes nothing to the store and calls nothing", async () => {
    let writes = 0;
    const unsub = useApp.subscribe(() => { writes++; });
    // Before today's slot, and long after it was acted on.
    expect(await scheduleTickNow(at(2, 8, 59))).toBe(0);
    useApp.getState().setTaskSchedule("parent", schedule({ last_slot: SLOT }));
    writes = 0;
    for (let i = 0; i < 100; i++) await scheduleTickNow(SLOT + i * 60_000);
    unsub();
    expect(writes).toBe(0);
    expect(ipc.taskSetSchedule).not.toHaveBeenCalled();
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
  });

  it("skips a disabled schedule and an archived parent", async () => {
    seed({}, schedule({ enabled: false }));
    expect(await scheduleTickNow(SLOT + 60_000)).toBe(0);
    seed({ archived: true });
    expect(await scheduleTickNow(SLOT + 60_000)).toBe(0);
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
  });
});

describe("a due slot", () => {
  it("records the slot BEFORE creating the run, then creates, links and mounts it", async () => {
    expect(await scheduleTickNow(SLOT + 60_000)).toBe(1);
    const setOrder = vi.mocked(ipc.taskSetSchedule).mock.invocationCallOrder[0];
    const createOrder = vi.mocked(ipc.taskOpenRepo).mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(createOrder);

    expect(ipc.taskOpenRepo).toHaveBeenCalledWith(
      "p1", "claude", "grafana check 2026-10-02 09:00",
      { enabled: false, rwPaths: [], allowedHosts: [] },
      undefined, undefined, undefined, [], false, undefined,
    );
    expect(ipc.taskLinkSpawn).toHaveBeenCalledWith("run-1", "parent", expect.any(String));
    expect(useApp.getState().mountedTasks.has("run-1")).toBe(true);
    expect(useApp.getState().activeTaskId).not.toBe("run-1");
    const s = stored();
    expect(s.last_slot).toBe(SLOT);
    expect(s.history).toEqual([{
      slot: SLOT, outcome: "running", run_task_id: "run-1",
      report: ".termic/schedules/grafana-check/2026-10-02_0900.md",
    }]);
    expect(isRunInFlight("run-1")).toBe(true);
  });

  it("types the prompt with the report instruction appended", async () => {
    await scheduleTickNow(SLOT + 60_000);
    await settle();
    const [runId, prompt] = vi.mocked(deliverPromptWhenReady).mock.calls[0];
    expect(runId).toBe("run-1");
    expect(prompt).toMatch(/^check the dashboards\n\n\[Termic scheduled run: grafana check\]/);
    expect(prompt).toContain(".termic/schedules/grafana-check/2026-10-02_0900.md");
  });

  it("creates the run with the parent's settings, account included", async () => {
    seed({
      cli: "claude", agent_args: ["--model", "opus"], yolo: true, sandbox_mode: "enforce",
      sandbox_rw_paths: ["/Users/u/cache"], sandbox_allowed_hosts: ["grafana.acme.com"],
      accounts: { claude: "work" },
    });
    await scheduleTickNow(SLOT + 60_000);
    expect(ipc.taskOpenRepo).toHaveBeenCalledWith(
      "p1", "claude", expect.any(String),
      { enabled: true, mode: "enforce", rwPaths: ["/Users/u/cache"], allowedHosts: ["grafana.acme.com"], blockKeychain: false },
      undefined, undefined, undefined, ["--model", "opus"], true, undefined,
    );
    expect(ipc.taskSetAccount).toHaveBeenCalledWith("run-1", "claude", "work");
  });

  it("acts on a slot once, even if the store's last_slot goes stale", async () => {
    await scheduleTickNow(SLOT + 60_000);
    // A lost task-file write followed by a loadAll would hand back the old
    // last_slot. The runner remembers what it did this session.
    useApp.getState().setTaskSchedule("parent", { ...stored(), last_slot: at(1, 9) });
    expect(await scheduleTickNow(SLOT + 120_000)).toBe(0);
    expect(ipc.taskOpenRepo).toHaveBeenCalledTimes(1);
  });

  it("skips the next slot while the previous run is still in flight", async () => {
    await scheduleTickNow(SLOT + 60_000);
    expect(await scheduleTickNow(at(3, 9, 1))).toBe(1);
    expect(ipc.taskOpenRepo).toHaveBeenCalledTimes(1);
    expect(stored().history.map(e => e.outcome)).toEqual(["running", "skipped"]);
    expect(stored().last_slot).toBe(at(3, 9));
  });

  it("records a missed slot without creating anything", async () => {
    expect(await scheduleTickNow(at(2, 12))).toBe(1);
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
    expect(stored().history).toEqual([{ slot: SLOT, outcome: "missed", count: 1 }]);
    expect(stored().last_slot).toBe(SLOT);
  });

  it("records earlier slots of a long sleep as one missed streak before firing today's", async () => {
    seed({}, schedule({ last_slot: at(1, 9) - 2 * 86_400_000 }));
    await scheduleTickNow(SLOT + 60_000);
    expect(stored().history.map(e => [e.outcome, e.count ?? null])).toEqual([["missed", 2], ["running", null]]);
  });
});

describe("refusals at fire time", () => {
  it("a parent switched to Docker after its schedule was made fails the slot and never runs locally", async () => {
    seed({ docker_sandbox_enabled: true });
    await scheduleTickNow(SLOT + 60_000);
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
    expect(stored().history).toEqual([expect.objectContaining({ slot: SLOT, outcome: "failed", error: "docker" })]);
    expect(stored().last_slot).toBe(SLOT);
  });

  it("an agent with no done signal is refused", async () => {
    seed({ cli: "plain" });
    await scheduleTickNow(SLOT + 60_000);
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
    expect(stored().history[0]).toMatchObject({ outcome: "failed", error: "agent" });
  });

  it("a deleted prompt-library entry fails the slot", async () => {
    seed({}, schedule({ prompt: undefined, prompt_id: "custom:gone" }));
    await scheduleTickNow(SLOT + 60_000);
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
    expect(stored().history[0]).toMatchObject({ outcome: "failed", error: "prompt" });
  });

  it("composes a library entry's body ahead of the typed text", async () => {
    const lib = usePromptLibrary.getState().prompts[0];
    seed({}, schedule({ prompt_id: lib.id, prompt: "and the alerts" }));
    await scheduleTickNow(SLOT + 60_000);
    await settle();
    const prompt = vi.mocked(deliverPromptWhenReady).mock.calls[0][1];
    expect(prompt.startsWith(`${lib.body.trimEnd()}\n\nand the alerts\n\n`)).toBe(true);
  });

  it("a failed create releases the overlap lock and records why", async () => {
    vi.mocked(ipc.taskOpenRepo).mockRejectedValueOnce(new Error("a task named \"x\" already exists"));
    await scheduleTickNow(SLOT + 60_000);
    expect(stored().history[0]).toMatchObject({ outcome: "failed", error: expect.stringContaining("already exists") });
    expect(await runScheduleNow("parent", SLOT + 120_000)).toMatchObject({ kind: "started" });
  });

  it("a prompt that never lands fails the run and releases the lock", async () => {
    vi.mocked(deliverPromptWhenReady).mockResolvedValueOnce({ ok: false, error: "the agent PTY never spawned" });
    await scheduleTickNow(SLOT + 60_000);
    await settle(); await settle();
    expect(stored().history[0]).toMatchObject({ outcome: "failed", run_task_id: "run-1", error: "the agent PTY never spawned" });
    expect(isRunInFlight("run-1")).toBe(false);
  });
});

describe("Run now", () => {
  it("runs outside the cadence without moving last_slot", async () => {
    const now = at(2, 14, 7);
    expect(await runScheduleNow("parent", now)).toEqual({ kind: "started", runId: "run-1" });
    expect(stored().last_slot).toBe(at(1, 9));
    expect(stored().history[0]).toMatchObject({ slot: now, outcome: "running", manual: true });
    expect(ipc.taskOpenRepo).toHaveBeenCalledWith(
      "p1", "claude", "grafana check 2026-10-02 14:07", expect.anything(),
      undefined, undefined, undefined, [], false, undefined,
    );
  });

  it("is refused while a run is in flight, and a double click starts one", async () => {
    const [a, b] = await Promise.all([runScheduleNow("parent", at(2, 14)), runScheduleNow("parent", at(2, 14))]);
    expect([a.kind, b.kind].sort()).toEqual(["busy", "started"]);
    expect(await runScheduleNow("parent", at(2, 15))).toEqual({ kind: "busy" });
    expect(ipc.taskOpenRepo).toHaveBeenCalledTimes(1);
  });

  it("names a second run in the same minute apart, and moves its report a minute on", async () => {
    await runScheduleNow("parent", at(2, 14));
    __resetScheduleRunnerForTests(); // as if the first had ended
    await runScheduleNow("parent", at(2, 14) + 5_000);
    expect(vi.mocked(ipc.taskOpenRepo).mock.calls.map(c => c[2])).toEqual([
      "grafana check 2026-10-02 14:00", "grafana check 2026-10-02 14:00 (2)",
    ]);
    expect(stored().history.map(e => e.report)).toEqual([
      ".termic/schedules/grafana-check/2026-10-02_1400.md",
      ".termic/schedules/grafana-check/2026-10-02_1401.md",
    ]);
  });
});

describe("creating, editing and deleting", () => {
  const input = {
    name: "Deps scan", prompt: "scan the deps", cadence: { kind: "weekly" as const, time: "08:00", weekday: 1 },
    catch_up: false, keep_runs: 7, report_days: 30,
  };
  const agent = { cli: "claude", agentArgs: [], yolo: false, sandbox: { enabled: false, rwPaths: [], allowedHosts: [] } };

  it("creates an unmounted parent that leads a collapsed group of its own", async () => {
    seed({}, null);
    const id = await createSchedule({ projectId: "p1", agent, input }, at(2, 10));
    expect(ipc.taskOpenRepo).toHaveBeenCalledWith(
      "p1", "claude", "Deps scan", agent.sandbox, undefined, undefined, undefined, [], false, undefined,
    );
    const parent = useApp.getState().tasks.find(t => t.id === id)!;
    expect(parent.schedule).toMatchObject({ name: "Deps scan", slug: "deps-scan", enabled: true, history: [] });
    // Monday 08:00 most recently passed, so nothing fires for it.
    expect(parent.schedule!.last_slot).toBe(new Date(2026, 8, 28, 8).getTime());
    expect(parent.group?.id).toBe(id);
    expect(useApp.getState().collapsedTaskGroups[id]).toBe(true);
    expect(useApp.getState().mountedTasks.has(id)).toBe(false);
  });

  it("makes an existing task the parent and leaves the group it is in alone", async () => {
    seed({ group: { id: "lead" } }, null);
    await createSchedule({ projectId: "p1", parentTaskId: "parent", input }, at(2, 10));
    expect(ipc.taskOpenRepo).not.toHaveBeenCalled();
    expect(ipc.taskGroupNew).not.toHaveBeenCalled();
    expect(stored().slug).toBe("deps-scan");
    // Expanded before, expanded after: only a group the schedule founds is
    // collapsed by it.
    expect(useApp.getState().collapsedTaskGroups.lead).toBeFalsy();
  });

  it("deletes the parent it created when the schedule is refused", async () => {
    seed({}, null);
    vi.mocked(ipc.taskSetSchedule).mockRejectedValueOnce("Scheduled runs do not support Docker yet.");
    await expect(createSchedule({ projectId: "p1", agent, input }, at(2, 10))).rejects.toMatch(/Docker/);
    // Archived without the scripts before the delete, so the project's archive
    // script never runs in the live checkout for a parent nobody kept.
    expect(ipc.taskArchive).toHaveBeenCalledWith("run-1", false, true);
    expect(vi.mocked(ipc.taskArchive).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(ipc.taskDelete).mock.invocationCallOrder[0]);
    expect(ipc.taskDelete).toHaveBeenCalledWith("run-1");
    expect(disk.tasks.map(t => t.id)).toEqual(["parent"]);
  });

  it("picks a folder no other schedule in the project owns", async () => {
    seed({ schedule: schedule({ slug: "deps-scan" }) });
    const id = await createSchedule({ projectId: "p1", agent, input }, at(2, 10));
    expect(useApp.getState().tasks.find(t => t.id === id)!.schedule!.slug).toBe("deps-scan-2");
  });

  it("restarts last_slot when the cadence changes or the schedule is turned back on", async () => {
    await updateSchedule("parent", { enabled: false }, at(2, 10));
    expect(stored()).toMatchObject({ enabled: false, last_slot: at(1, 9) });
    await updateSchedule("parent", { enabled: true }, at(5, 10));
    expect(stored()).toMatchObject({ enabled: true, last_slot: at(5, 9) });
    await updateSchedule("parent", { name: "renamed" }, at(6, 10));
    expect(stored()).toMatchObject({ name: "renamed", slug: "grafana-check", last_slot: at(5, 9) });
  });

  it("a rename renames the parent that still carries the schedule's name", async () => {
    await updateSchedule("parent", { name: "dashboards" }, at(2, 10));
    expect(ipc.taskRename).toHaveBeenCalledWith("parent", "dashboards");
    expect(useApp.getState().tasks.find(t => t.id === "parent")!.name).toBe("dashboards");
    expect(stored()).toMatchObject({ name: "dashboards", slug: "grafana-check" });
  });

  it("leaves a parent with a name of its own alone", async () => {
    seed({ name: "ops desk" });
    await updateSchedule("parent", { name: "dashboards" }, at(2, 10));
    expect(ipc.taskRename).not.toHaveBeenCalled();
    expect(stored().name).toBe("dashboards");
  });

  it("keeps the schedule's new name and says so when the task name is taken", async () => {
    disk.tasks.push({ ...disk.tasks[0], id: "other", name: "dashboards", schedule: undefined } as Task);
    useApp.setState({ tasks: clone(disk.tasks) } as never);
    const toast = vi.spyOn(useUI.getState(), "pushToast");
    await updateSchedule("parent", { name: "dashboards" }, at(2, 10));
    expect(stored().name).toBe("dashboards");
    expect(useApp.getState().tasks.find(t => t.id === "parent")!.name).toBe("grafana check");
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("already exists"), "error");
  });

  it("an unchanged edit writes nothing", async () => {
    await updateSchedule("parent", { name: "grafana check" }, at(2, 10));
    expect(ipc.taskSetSchedule).not.toHaveBeenCalled();
  });

  it("deletes a schedule, and its reports only when asked", async () => {
    await deleteSchedule("parent", false);
    expect(useApp.getState().tasks.find(t => t.id === "parent")!.schedule).toBeUndefined();
    expect(ipc.scheduleDeleteReports).not.toHaveBeenCalled();
    seed();
    await deleteSchedule("parent", true);
    expect(ipc.scheduleDeleteReports).toHaveBeenCalledWith("p1", "grafana-check");
  });

  it("archives parent and run tasks and deletes reports when archiveTasks is requested", async () => {
    const runTask: Task = {
      id: "run-1",
      project_id: "p1",
      name: "grafana check 2026-10-02 09:00",
      branch: "main",
      base_branch: "main",
      path: "/Users/u/web",
      cli: "claude",
      port: 18101,
      created: "",
      archived: false,
      is_main_checkout: true,
      spawned_by: "parent",
    } as Task;
    disk.tasks.push(runTask);
    const s = schedule({ history: [{ slot: SLOT, outcome: "fired", run_task_id: "run-1" }] });
    seed({}, s);
    disk.tasks.push(runTask);
    useApp.setState({ tasks: clone(disk.tasks) });

    await deleteSchedule("parent", { archiveTasks: true });

    expect(ipc.scheduleDeleteReports).toHaveBeenCalledWith("p1", "grafana-check");
    expect(ipc.taskArchive).toHaveBeenCalledWith("run-1", false, true);
    expect(ipc.taskArchive).toHaveBeenCalledWith("parent", false, true);
    expect(useApp.getState().tasks.find(t => t.id === "run-1")!.archived).toBe(true);
    expect(useApp.getState().tasks.find(t => t.id === "parent")!.archived).toBe(true);
    expect(useApp.getState().tasks.find(t => t.id === "parent")!.schedule).toBeUndefined();
  });
});
