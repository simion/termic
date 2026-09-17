// @vitest-environment happy-dom
//
// End-to-end check of the issue-#23 resume pipeline using the REAL store,
// the REAL decideResume, and the REAL spawnArgsForCli (only ipc / tabFocus
// are mocked). Proves the "restart make dev → main agent resumes" path that
// regressed: legacy agent_session_ids migrate onto the default tab, persist
// into persisted_tabs, and survive a simulated restart as a --resume spawn.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  // Every task activation stamps `last_opened_at` through these; a mock
  // missing them throws on property access, not on call.
  taskTouch: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskRecordSpawn: vi.fn().mockResolvedValue(1),
  taskMarkStarted: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z"),
  taskSetGoal: vi.fn().mockResolvedValue(undefined),
  taskSetParked: vi.fn().mockResolvedValue(null),
  taskGitPhaseState: vi.fn().mockRejectedValue(new Error("not mocked")),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));

import { useApp } from "@/store/app";
import { decideResume, spawnArgsForCli, cliSupportsIdSession } from "@/lib/agents";
import type { Task, TerminalTab } from "@/lib/types";

function makeTask(o: Partial<Task> = {}): Task {
  return {
    id: "ws1", project_id: "p1", name: "seo improvements", branch: "main",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false, ...o,
  } as Task;
}

// Mirror of TerminalPane's spawn wiring: tab + task → actual argv.
function argvFor(tab: TerminalTab, task: Task, isPrimary = true): string[] {
  const decision = decideResume({
    isAgent: true,
    idCapable: cliSupportsIdSession(tab.cli),
    isPrimary,
    runsTaskAgent: tab.cli === task.cli,
    isRepoRoot: !!task.is_main_checkout,
    hasResumableHistory: !!task.has_resumable_history,
    storedUuid: tab.sessionId,
    resumeOverride: task.resume_override ?? undefined,
    failedResume: false,
  });
  const sessionUuid =
    decision.kind === "mint" ? "MINTED-UUID"
    : decision.kind === "resume-id" ? tab.sessionId
    : undefined;
  return spawnArgsForCli(tab.cli, {
    yolo: false,
    resume: decision.kind === "cwd-resume",
    isPrimary,
    sessionUuid,
    resumeKnown: decision.kind === "resume-id",
    resumeOverride: decision.kind === "override" ? decision.override : undefined,
    task,
  });
}

const firstTab = (taskId = "ws1") => useApp.getState().tabs[taskId][0] as TerminalTab;

beforeEach(() => {
  useApp.setState({
    tabs: {}, activeTab: {}, activeTaskId: null,
    mountedTasks: new Set(), tasks: [], projects: [], agents: [],
  });
  vi.clearAllMocks();
});

describe("repo-root main agent resumes across a restart", () => {
  it("migrates a legacy agent_session_ids uuid → --resume on first open AND after restart", () => {
    const U = "1b02e805-5b4d-482c-927b-b62b9b1c68d8";
    useApp.setState({ tasks: [makeTask({ is_main_checkout: true, agent_session_ids: { claude: U } })] });

    // First open after upgrade: seed + migrate.
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const seeded = firstTab();
    expect(seeded.sessionId).toBe(U);
    expect(argvFor(seeded, useApp.getState().tasks[0])).toEqual(["--resume", U, "--name", "seo-improvements"]);

    // The migration was carried into persisted_tabs in memory...
    const persistedAfterSeed = useApp.getState().tasks[0].persisted_tabs!;
    expect(persistedAfterSeed[0].session_id).toBe(U);

    // Simulate "restart make dev": app reloads tasks from disk (here the
    // in-memory persisted_tabs we just wrote), tabs are empty again.
    const reloaded = makeTask({ is_main_checkout: true, agent_session_ids: { claude: U }, persisted_tabs: persistedAfterSeed });
    useApp.setState({ tasks: [reloaded], tabs: {}, activeTab: {} });

    // Reopen → RESTORE path → still resumes the same session.
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const restored = firstTab();
    expect(restored.sessionId).toBe(U);
    expect(restored.is_default).toBe(true);
    expect(argvFor(restored, useApp.getState().tasks[0])).toEqual(["--resume", U, "--name", "seo-improvements"]);
  });
});

describe("close tab + reopen task resumes (the reported bug)", () => {
  it("create agent → say something (mint) → close tab → reopen → --resume", () => {
    useApp.setState({ tasks: [makeTask({ is_main_checkout: true })] });

    // Open + first spawn mints a session; it survives → persisted per tab.
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tab = firstTab();
    const U = "sess-from-conversation";
    useApp.getState().setTabSessionId("ws1", tab.id, U);

    // User closes the tab (X). Closing must NOT forget the agent.
    useApp.getState().closeTab("ws1", tab.id);
    expect(useApp.getState().tabs["ws1"] ?? []).toHaveLength(0);
    const persisted = useApp.getState().tasks[0].persisted_tabs!;
    expect(persisted.find(t => t.id === tab.id)?.session_id).toBe(U);

    // Reopen the task (same app session, task woke from sleep).
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const reopened = firstTab();
    expect(reopened.id).toBe(tab.id);
    expect(reopened.sessionId).toBe(U);
    expect(argvFor(reopened, useApp.getState().tasks[0])).toEqual(["--resume", U, "--name", "seo-improvements"]);
  });

  it("forgetTab → reopen starts fresh (mint), NOT resume", () => {
    useApp.setState({ tasks: [makeTask({ is_main_checkout: true })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tab = firstTab();
    useApp.getState().setTabSessionId("ws1", tab.id, "doomed");

    useApp.getState().forgetTab("ws1", tab.id);

    useApp.getState().ensureDefaultTab("ws1", "claude");
    const fresh = firstTab();
    expect(fresh.sessionId).toBeUndefined();
    expect(argvFor(fresh, useApp.getState().tasks[0])[0]).toBe("--session-id"); // mint, not resume
  });
});

describe("worktree main agent resumes across a restart", () => {
  it("keeps --continue when there's history but no per-tab uuid (legacy worktree)", () => {
    useApp.setState({ tasks: [makeTask({ is_main_checkout: false, has_resumable_history: true, agent_session_ids: {} })] });

    useApp.getState().ensureDefaultTab("ws1", "claude");
    const seeded = firstTab();
    expect(seeded.sessionId).toBeUndefined();
    expect(argvFor(seeded, useApp.getState().tasks[0])).toContain("--continue");

    // Restart: restore the persisted (uuid-less) tab → still --continue.
    const persisted = useApp.getState().tasks[0].persisted_tabs!;
    const reloaded = makeTask({ is_main_checkout: false, has_resumable_history: true, persisted_tabs: persisted });
    useApp.setState({ tasks: [reloaded], tabs: {}, activeTab: {} });

    useApp.getState().ensureDefaultTab("ws1", "claude");
    expect(argvFor(firstTab(), useApp.getState().tasks[0])).toContain("--continue");
  });

  it("a freshly minted worktree session round-trips to --resume after restart", () => {
    useApp.setState({ tasks: [makeTask({ is_main_checkout: false, has_resumable_history: false })] });

    // No history, no uuid → mint a new session.
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const seeded = firstTab();
    expect(decideResume({
      isAgent: true, idCapable: true, isPrimary: true, runsTaskAgent: true,
      isRepoRoot: false,
      hasResumableHistory: false, storedUuid: seeded.sessionId, failedResume: false,
    }).kind).toBe("mint");

    // The spawn survives → TerminalPane persists the minted uuid per tab.
    const U = "minted-1234";
    useApp.getState().setTabSessionId("ws1", seeded.id, U);
    expect(firstTab().sessionId).toBe(U);

    // Restart → restore carries the uuid → resumes by id.
    const persisted = useApp.getState().tasks[0].persisted_tabs!;
    expect(persisted[0].session_id).toBe(U);
    const reloaded = makeTask({ is_main_checkout: false, persisted_tabs: persisted });
    useApp.setState({ tasks: [reloaded], tabs: {}, activeTab: {} });

    useApp.getState().ensureDefaultTab("ws1", "claude");
    expect(argvFor(firstTab(), useApp.getState().tasks[0])).toEqual(["--resume", U, "--name", "seo-improvements"]);
  });
});

describe("a fast-exit resume drops the dead uuid and starts fresh", () => {
  // There used to be a stash (`previousSessionId`) plus a "Resume it" banner
  // here. It outlived the failure it described: the pointer was persisted but
  // the "this is the one that just failed" flag was component state, so after
  // any relaunch the banner came back re-worded as "your previous session is
  // still available" and nothing ever cleared it. Termic losing the pointer
  // does not delete the transcript, and every id-resuming agent ships its own
  // picker, so the stash is gone and the failure is a one-shot toast.
  it("clears the uuid so the retry mints, and the mint round-trips", () => {
    const U = "1b02e805-5b4d-482c-927b-b62b9b1c68d8";
    useApp.setState({ tasks: [makeTask({ is_main_checkout: true })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tab = firstTab();

    // First spawn mints a session that survives.
    useApp.getState().setTabSessionId("ws1", tab.id, U);
    expect(firstTab().sessionId).toBe(U);

    // A later --resume fast-exits → TerminalPane clears the dead slot.
    useApp.getState().setTabSessionId("ws1", tab.id, "");
    expect(firstTab().sessionId).toBeUndefined();
    // With no uuid the decision is a fresh mint, not another doomed resume.
    expect(decideResume({
      isAgent: true, idCapable: true, isPrimary: true, runsTaskAgent: true,
      isRepoRoot: true,
      hasResumableHistory: true, storedUuid: firstTab().sessionId, failedResume: true,
    }).kind).toBe("mint");

    // The fallback mint takes the slot and round-trips through persistence.
    const NEW = "9f9f9f9f-0000-4000-8000-000000000000";
    useApp.getState().setTabSessionId("ws1", tab.id, NEW);
    const persisted = useApp.getState().tasks[0].persisted_tabs!;
    expect(persisted[0].session_id).toBe(NEW);

    const reloaded = makeTask({ is_main_checkout: true, persisted_tabs: persisted });
    useApp.setState({ tasks: [reloaded], tabs: {}, activeTab: {} });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    expect(firstTab().sessionId).toBe(NEW);
    expect(argvFor(firstTab(), useApp.getState().tasks[0])).toEqual(["--resume", NEW, "--name", "seo-improvements"]);
  });
});

// A task's resume override belongs to the task's OWN agent. A "+" tab running
// a different CLI is still the FIRST tab of that CLI, so `isPrimary` is true
// for it, and it was handed the override verbatim. The strings are not
// interchangeable: claude spells it `--resume <name>`, codex spells it
// `resume <name>`, and codex answers the first with
//
//   error: unexpected argument '--resume' found
//   tip: a similar argument exists: '--remote'
//
// i.e. the tab is dead before it draws a frame, and every Restart repeats it.
describe("a second agent ignores the task's resume override", () => {
  const OVERRIDE = "--resume {WORKSPACE_NAME}";

  /** The "+" menu's shape: a non-default tab, first of its own cli. */
  const plusTab = (cli: string): TerminalTab =>
    ({ id: `t-${cli}`, type: "terminal", cli, title: cli, is_default: false } as TerminalTab);

  it("codex added to an overridden claude task never sees claude's flag", () => {
    const task = makeTask({
      cli: "claude", is_main_checkout: false, has_resumable_history: true,
      resume_override: OVERRIDE,
    });
    const argv = argvFor(plusTab("codex"), task);
    expect(argv).not.toContain("--resume");
    // Codex's own worktree answer instead: its subcommand-form resume.
    expect(argv).toEqual(["resume", "--last"]);
  });

  it("the task's own agent still gets the override, expanded", () => {
    const task = makeTask({
      cli: "claude", is_main_checkout: false, has_resumable_history: true,
      resume_override: OVERRIDE,
    });
    // `--name` is deliberately absent under an override (renaming the session
    // on every relaunch moves the target the override points at).
    expect(argvFor(plusTab("claude"), task)).toEqual(["--resume", "seo improvements"]);
  });

  it("a second CLAUDE tab is not primary, so it mints rather than colliding", () => {
    const task = makeTask({ cli: "claude", resume_override: OVERRIDE });
    const argv = argvFor(plusTab("claude"), task, /* isPrimary */ false);
    expect(argv).toEqual(["--session-id", "MINTED-UUID"]);
  });
});
