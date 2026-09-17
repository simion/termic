// @vitest-environment happy-dom
//
// The dashboard-scoped git pass: who it polls, in what order, how often, and
// what it does with a lookup that fails. The skip rules are the interesting
// half - every task it does NOT poll is a `git` subprocess not spawned, and
// the PR-state rules encode a real argument (see `pollableTasks`).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the modules under test are imported.
// Importing the store drags in app.ts AND pr.ts, so this is pr.test.ts's
// block plus the two commands this store owns.
vi.mock("@/lib/ipc", () => ({
  taskGitPhaseState: vi.fn(),
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
  taskSetParked: vi.fn().mockResolvedValue(null),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  detectForges: vi.fn().mockResolvedValue([]),
  taskPrStatus: vi.fn(),
  taskPrComments: vi.fn().mockResolvedValue([]),
  taskSetPrWatch: vi.fn().mockResolvedValue(undefined),
  taskSetPrCommentsSeen: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  notify: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));
vi.mock("@/lib/agents", () => ({
  agentDisplayName: vi.fn((cli: string) => cli),
  workDoneCapable: vi.fn(() => true),
}));
vi.mock("@/lib/archiveTask", () => ({
  archiveAndRefresh: vi.fn().mockResolvedValue(undefined),
  confirmAndArchive: vi.fn().mockResolvedValue(undefined),
}));

import { useTaskGit, pollableTasks, taskGitPassNow, sameGitState } from "@/store/taskGit";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import * as ipc from "@/lib/ipc";
import type { PrLookup, Task, TaskGitState } from "@/lib/types";

const MIN_REFRESH_MS = 30_000;

function makeGit(overrides: Partial<TaskGitState> = {}): TaskGitState {
  return {
    own_commits: 1,
    dirty: false,
    ahead: 0,
    merged_into_base: false,
    base_known: true,
    ...overrides,
  };
}

/** ws1..wsN, in order, each overridden from the matching entry. */
function seedTasks(...overrides: Partial<Task>[]) {
  useApp.setState({
    tasks: overrides.map((o, i) => ({
      id: `ws${i + 1}`, project_id: "p1", name: `Feat ${i + 1}`, branch: `feat-${i + 1}`,
      base_branch: "main", path: "/x", cli: "claude", port: 1, created: "", archived: false,
      ...o,
    } as Task)),
  });
}

function prLookup(state: "open" | "draft" | "closed" | "merged" | null): PrLookup {
  return {
    provider: "github",
    remote_url: "git@github.com:acme/widget.git",
    status: "ok",
    message: "",
    pr: state ? {
      provider: "github", number: 7, url: "https://github.com/acme/widget/pull/7",
      title: "Add thing", state, checks: "passing", review: "none", base: "main", head: "feat",
    } : null,
  };
}

/** Mark a task polled `agoMs` ago so the floor sees it as stale (or not). */
function polledAgo(id: string, agoMs: number, state: TaskGitState | null = null) {
  useTaskGit.setState(s => ({
    byTask: { ...s.byTask, [id]: { state, loading: false, fetchedAt: Date.now() - agoMs } },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useTaskGit.setState({ byTask: {} });
  usePr.setState({ byTask: {}, forges: null });
  useApp.setState({ tasks: [] });
});

describe("pollableTasks: who is skipped", () => {
  it("polls an ordinary worktree task with no PR", () => {
    seedTasks({});
    expect(pollableTasks().map(w => w.id)).toEqual(["ws1"]);
  });

  it("skips an archived task", () => {
    seedTasks({ archived: true });
    expect(pollableTasks()).toHaveLength(0);
  });

  it("skips a main-checkout task", () => {
    // It has no branch cut from a base, and the command rejects for one.
    seedTasks({ is_main_checkout: true });
    expect(pollableTasks()).toHaveLength(0);
  });

  it("skips a task whose PR is open", () => {
    seedTasks({});
    usePr.setState({ byTask: { ws1: { lookup: prLookup("open"), loading: false, fetchedAt: Date.now() } } });
    expect(pollableTasks()).toHaveLength(0);
  });

  it("skips a task whose PR is merged", () => {
    seedTasks({});
    usePr.setState({ byTask: { ws1: { lookup: prLookup("merged"), loading: false, fetchedAt: Date.now() } } });
    expect(pollableTasks()).toHaveLength(0);
  });

  it("STILL polls a task whose PR is a draft", () => {
    // A draft sits at In progress, and merged_into_base has to be able to
    // beat it: a draft PR whose branch was squash-merged is Done.
    seedTasks({});
    usePr.setState({ byTask: { ws1: { lookup: prLookup("draft"), loading: false, fetchedAt: Date.now() } } });
    expect(pollableTasks().map(w => w.id)).toEqual(["ws1"]);
  });

  it("STILL polls a task whose PR is closed", () => {
    // The common squash-merge-then-close shape on some forges. Without this
    // the task would never reach Done.
    seedTasks({});
    usePr.setState({ byTask: { ws1: { lookup: prLookup("closed"), loading: false, fetchedAt: Date.now() } } });
    expect(pollableTasks().map(w => w.id)).toEqual(["ws1"]);
  });

  it("polls a task whose PR lookup resolved to no PR at all", () => {
    seedTasks({});
    usePr.setState({ byTask: { ws1: { lookup: prLookup(null), loading: false, fetchedAt: Date.now() } } });
    expect(pollableTasks().map(w => w.id)).toEqual(["ws1"]);
  });

  it("does not re-poll a task whose lookup is still in flight", () => {
    seedTasks({});
    useTaskGit.setState({ byTask: { ws1: { state: null, loading: true, fetchedAt: 0 } } });
    expect(pollableTasks()).toHaveLength(0);
  });
});

describe("pollableTasks: the floor and the cap", () => {
  it("leaves a freshly polled task alone and picks it up once it goes stale", () => {
    seedTasks({});
    polledAgo("ws1", 5_000);
    expect(pollableTasks()).toHaveLength(0);

    polledAgo("ws1", MIN_REFRESH_MS + 1_000);
    expect(pollableTasks().map(w => w.id)).toEqual(["ws1"]);
  });

  it("caps one pass at 6 and takes the stalest first", async () => {
    seedTasks(...Array.from({ length: 20 }, () => ({})));
    // ws20 polled longest ago, ws1 most recently: the order must invert.
    useTaskGit.setState({
      byTask: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
        `ws${i + 1}`,
        { state: null, loading: false, fetchedAt: Date.now() - (MIN_REFRESH_MS + i * 1_000) },
      ])),
    });

    const due = pollableTasks();
    expect(due).toHaveLength(6);
    expect(due.map(w => w.id)).toEqual(["ws20", "ws19", "ws18", "ws17", "ws16", "ws15"]);

    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());
    await taskGitPassNow();
    // Sequential and capped: six subprocesses, not twenty at once.
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(6);
  });

  it("a never-polled task outranks one polled a minute ago", () => {
    seedTasks({}, {});
    polledAgo("ws1", 60_000);
    // ws2 has no entry at all, so its staleness is `now - 0`.
    expect(pollableTasks().map(w => w.id)).toEqual(["ws2", "ws1"]);
  });
});

describe("useTaskGit.refresh", () => {
  it("stores the state and rate-limits unforced refreshes", async () => {
    seedTasks({});
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit({ own_commits: 3 }));

    await useTaskGit.getState().refresh("ws1");
    expect(useTaskGit.getState().byTask.ws1.state?.own_commits).toBe(3);
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(1);

    // Inside the window an unforced refresh is a no-op...
    await useTaskGit.getState().refresh("ws1");
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(1);
    // ...but force goes through.
    await useTaskGit.getState().refresh("ws1", true);
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(2);
  });

  it("records a rejected lookup as null WITH a fetchedAt, and does not retry it inside the floor", async () => {
    seedTasks({});
    vi.mocked(ipc.taskGitPhaseState).mockRejectedValue(new Error("not a git repository"));

    await taskGitPassNow();
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(1);
    const entry = useTaskGit.getState().byTask.ws1;
    expect(entry.state).toBeNull();
    expect(entry.loading).toBe(false);
    expect(entry.fetchedAt).toBeGreaterThan(0);

    // The failure is what stops the bleeding: without the stamp this task
    // would be the stalest thing in the fleet on every single pass.
    expect(pollableTasks()).toHaveLength(0);
    await taskGitPassNow();
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous state object when the resolved one deep-equals it", async () => {
    // docs/performance.md bear trap 8, as near as this shape allows. A
    // literal zero-write is not available (fetchedAt has to advance or the
    // floor stops working), so what is pinned is the reference and the write
    // COUNT: an unchanged branch keeps the same `state` object and costs no
    // more subscriber notifications than the first fetch did. It does not
    // stop the Dashboard re-rendering; `byTask` is a new record either way.
    seedTasks({});
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());

    let first = 0;
    let unsub = useTaskGit.subscribe(() => { first++; });
    await useTaskGit.getState().refresh("ws1");
    unsub();
    const settled = useTaskGit.getState().byTask.ws1.state;
    expect(settled).not.toBeNull();

    // Same VALUES, a different object every time: exactly what an IPC reply
    // is, and the case a naive store would treat as a change.
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());
    let repeat = 0;
    unsub = useTaskGit.subscribe(() => { repeat++; });
    await useTaskGit.getState().refresh("ws1", true);
    await useTaskGit.getState().refresh("ws1", true);
    unsub();

    expect(useTaskGit.getState().byTask.ws1.state).toBe(settled);
    expect(repeat).toBe(first * 2);
  });

  it("does hand over a NEW object once something actually moved", async () => {
    seedTasks({});
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit({ dirty: false }));
    await useTaskGit.getState().refresh("ws1");
    const clean = useTaskGit.getState().byTask.ws1.state;

    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit({ dirty: true }));
    await useTaskGit.getState().refresh("ws1", true);

    expect(useTaskGit.getState().byTask.ws1.state).not.toBe(clean);
    expect(useTaskGit.getState().byTask.ws1.state?.dirty).toBe(true);
  });

  it("does not start a second lookup for a task already loading", async () => {
    seedTasks({});
    useTaskGit.setState({ byTask: { ws1: { state: null, loading: true, fetchedAt: 0 } } });

    await useTaskGit.getState().refresh("ws1", true);

    expect(ipc.taskGitPhaseState).not.toHaveBeenCalled();
  });
});

describe("sameGitState", () => {
  it("is true for two equal values and false on each field in turn", () => {
    const base = makeGit();
    expect(sameGitState(base, makeGit())).toBe(true);
    expect(sameGitState(base, makeGit({ own_commits: 2 }))).toBe(false);
    expect(sameGitState(base, makeGit({ dirty: true }))).toBe(false);
    expect(sameGitState(base, makeGit({ ahead: 1 }))).toBe(false);
    expect(sameGitState(base, makeGit({ merged_into_base: true }))).toBe(false);
    expect(sameGitState(base, makeGit({ base_known: false }))).toBe(false);
  });

  it("distinguishes ahead 0 from ahead null", () => {
    // Not pedantry: "nothing left to push" and "there is no remote branch"
    // land on different sides of the In review rule.
    expect(sameGitState(makeGit({ ahead: 0 }), makeGit({ ahead: null }))).toBe(false);
  });

  it("treats two nulls as the same and a null against a value as different", () => {
    expect(sameGitState(null, null)).toBe(true);
    expect(sameGitState(null, makeGit())).toBe(false);
    expect(sameGitState(makeGit(), null)).toBe(false);
  });
});

describe("taskGitPassNow", () => {
  it("polls every due task in one pass, sequentially", async () => {
    seedTasks({}, {}, {});
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());

    await taskGitPassNow();

    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(3);
    expect(Object.keys(useTaskGit.getState().byTask).sort()).toEqual(["ws1", "ws2", "ws3"]);
  });

  it("costs nothing on an empty store and does not wedge the next pass", async () => {
    // The launch shape: the dashboard mounts before `loadAll` resolves. The
    // Dashboard's effect gates on there being tasks for exactly this reason,
    // but the pass must also be harmless when it does run dry, and must leave
    // `passRunning` clear so the real first pass is not swallowed.
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());

    await taskGitPassNow();
    expect(ipc.taskGitPhaseState).not.toHaveBeenCalled();

    seedTasks({}, {});
    await taskGitPassNow();
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(2);
  });

  it("skips the tasks pollableTasks excluded, so a fleet of PRs costs nothing", async () => {
    seedTasks({}, { archived: true }, { is_main_checkout: true }, {});
    usePr.setState({
      byTask: { ws4: { lookup: prLookup("open"), loading: false, fetchedAt: Date.now() } },
    });
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());

    await taskGitPassNow();

    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(1);
    expect(ipc.taskGitPhaseState).toHaveBeenCalledWith("ws1");
  });

  it("does not run a second pass alongside one still walking its list", async () => {
    seedTasks({}, {});
    let release: (v: TaskGitState) => void = () => {};
    vi.mocked(ipc.taskGitPhaseState).mockImplementationOnce(
      () => new Promise<TaskGitState>(res => { release = res; }),
    );
    vi.mocked(ipc.taskGitPhaseState).mockResolvedValue(makeGit());

    const first = taskGitPassNow();
    // Second pass while the first is parked on ws1's lookup.
    await taskGitPassNow();
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(1);

    release(makeGit());
    await first;
    expect(ipc.taskGitPhaseState).toHaveBeenCalledTimes(2);
  });
});
