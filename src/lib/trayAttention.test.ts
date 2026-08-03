// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";

// Same mock shape as cliAgentState.test.ts: computeTrayAttention pulls in
// computeAgentStates, which pulls in useApp (ipc/tabFocus/agents).
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
  workDoneCapable: vi.fn((cli: string) => cli !== "shell"),
  isTerminalCli: vi.fn(() => false),
}));

import { computeTrayAttention, initTrayAttention } from "@/lib/trayAttention";
import { useApp } from "@/store/app";
import { invoke } from "@tauri-apps/api/core";
import type { Project, Tab, Task, TerminalTab } from "@/lib/types";

const invokeMock = vi.mocked(invoke);

function term(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: crypto.randomUUID(),
    type: "terminal",
    cli: "claude",
    title: "t",
    ...overrides,
  } as TerminalTab;
}

function task(id: string, name: string, project_id: string, archived = false): Task {
  return { id, name, project_id, archived } as Task;
}

function project(id: string, name: string): Project {
  return { id, name } as Project;
}

function seed(tasks: Task[], projects: Project[], tabs: Record<string, Tab[]>) {
  useApp.setState({ tasks, projects, tabs });
  return computeTrayAttention();
}

describe("computeTrayAttention", () => {
  beforeEach(() => useApp.setState({ tasks: [], projects: [], tabs: {} }));

  it("includes only waiting and done tasks, excluding idle/working/inactive", () => {
    const items = seed(
      [
        task("w", "waiting-task", "p1"),
        task("d", "done-task", "p1"),
        task("i", "idle-task", "p1"),
        task("g", "working-task", "p1"),
        task("n", "inactive-task", "p1"),
      ],
      [project("p1", "Proj One")],
      {
        w: [term({ unread: { reason: "attention" } })],
        d: [term({ workState: "done" })],
        i: [term({ workState: "idle" })],
        g: [term({ workState: "working" })],
        n: [],
      },
    );
    expect(items.map(i => i.task_name).sort()).toEqual(["done-task", "waiting-task"]);
    expect(items.find(i => i.task_name === "waiting-task")?.state).toBe("waiting");
    expect(items.find(i => i.task_name === "done-task")?.state).toBe("done");
  });

  it("skips archived tasks and tasks whose project can't be resolved", () => {
    const items = seed(
      [
        task("gone", "archived-task", "p1", true),
        task("orphan", "orphan-task", "missing"),
        task("live", "live-task", "p1"),
      ],
      [project("p1", "Proj One")],
      {
        gone: [term({ workState: "done" })],
        orphan: [term({ workState: "done" })],
        live: [term({ workState: "done" })],
      },
    );
    expect(items.map(i => i.task_name)).toEqual(["live-task"]);
  });

  it("sorts by project name, then attention-before-done, then task name", () => {
    const items = seed(
      [
        task("b1", "bravo-done", "pb"),
        task("a1", "alpha-waiting", "pa"),
        task("a2", "alpha-done", "pa"),
      ],
      [project("pa", "Alpha"), project("pb", "Bravo")],
      {
        b1: [term({ workState: "done" })],
        a1: [term({ unread: { reason: "attention" } })],
        a2: [term({ workState: "done" })],
      },
    );
    expect(items.map(i => `${i.project_name}:${i.task_name}`)).toEqual([
      "Alpha:alpha-waiting",
      "Alpha:alpha-done",
      "Bravo:bravo-done",
    ]);
  });

  it("breaks ties within the same project+state by task name", () => {
    const items = seed(
      [
        task("z", "zulu-done", "p1"),
        task("a", "alpha-done", "p1"),
      ],
      [project("p1", "Proj One")],
      {
        z: [term({ workState: "done" })],
        a: [term({ workState: "done" })],
      },
    );
    expect(items.map(i => i.task_name)).toEqual(["alpha-done", "zulu-done"]);
  });
});

describe("initTrayAttention", () => {
  // A stop() left uncalled after a failing assertion would strand the
  // module-level `started` latch (lib/trayAttention.ts) true forever,
  // silently no-op-ing every later test's initTrayAttention() call — so
  // this runs unconditionally, not as the last line of each test body.
  let stop: () => void = () => {};

  beforeEach(() => {
    useApp.setState({ tasks: [], projects: [], tabs: {} });
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    stop = () => {};
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("debounces bursts of store changes into a single push", async () => {
    stop = initTrayAttention();
    invokeMock.mockClear(); // drop the synchronous boot push

    useApp.setState({
      tasks: [task("a", "a", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    useApp.setState({
      tasks: [task("a", "a", "p1"), task("b", "b", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })], b: [term({ unread: { reason: "attention" } })] },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("skips a push when the computed item list is unchanged", async () => {
    useApp.setState({
      tasks: [task("a", "a", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    stop = initTrayAttention();
    invokeMock.mockClear();

    // A store change that doesn't affect computeTrayAttention's output
    // (same task/tab shape) must not trigger a second invoke.
    useApp.setState({
      tasks: [task("a", "a", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resets lastSent on a failed push so the next change retries instead of staying suppressed", async () => {
    invokeMock.mockRejectedValueOnce(new Error("ipc down"));
    useApp.setState({
      tasks: [task("a", "a", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    stop = initTrayAttention(); // boot push fires synchronously and rejects
    await vi.advanceTimersByTimeAsync(0); // let the rejection's .catch settle
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);

    // Same effective items as the failed push (the extra task is archived,
    // so it's filtered out) — if lastSent weren't reset on failure, this
    // would look "unchanged" and get silently swallowed instead of retried.
    useApp.setState({
      tasks: [task("a", "a", "p1"), task("z", "z", "p1", true)],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels a pending debounced push", async () => {
    stop = initTrayAttention();
    invokeMock.mockClear();

    useApp.setState({
      tasks: [task("a", "a", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    stop();
    stop = () => {};
    await vi.advanceTimersByTimeAsync(150);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("re-pushes on a system light/dark appearance change even with an unchanged item list", async () => {
    // happy-dom's matchMedia returns a fresh MediaQueryList on every call
    // (real browsers reuse one per query), so the source's own
    // window.matchMedia(...) call and this test's would otherwise dispatch
    // on two unrelated objects. Stub it to hand out a single shared one.
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = true;
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);

    useApp.setState({
      tasks: [task("a", "a", "p1")],
      projects: [project("p1", "P1")],
      tabs: { a: [term({ workState: "done" })] },
    });
    stop = initTrayAttention();
    await vi.advanceTimersByTimeAsync(150);
    invokeMock.mockClear();

    media.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(150);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
