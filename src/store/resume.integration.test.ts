// @vitest-environment happy-dom
//
// End-to-end check of the issue-#23 resume pipeline using the REAL store,
// the REAL decideResume, and the REAL spawnArgsForCli (only ipc / tabFocus
// are mocked). Proves the "restart make dev → main agent resumes" path that
// regressed: legacy agent_session_ids migrate onto the default tab, persist
// into persisted_tabs, and survive a simulated restart as a --resume spawn.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
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
      isAgent: true, idCapable: true, isPrimary: true, isRepoRoot: false,
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

describe("a fast-exit resume preserves the session and can recover it", () => {
  it("stashes the uuid to previous, survives a restart, and recover resumes it", () => {
    const U = "1b02e805-5b4d-482c-927b-b62b9b1c68d8";
    useApp.setState({ tasks: [makeTask({ is_main_checkout: true })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tab = firstTab();

    // First spawn mints a session that survives.
    useApp.getState().setTabSessionId("ws1", tab.id, U);
    expect(firstTab().sessionId).toBe(U);

    // A later --resume fast-exits → TerminalPane stashes then clears (the fix).
    useApp.getState().setTabPreviousSessionId("ws1", tab.id, U);
    useApp.getState().setTabSessionId("ws1", tab.id, "");
    expect(firstTab().sessionId).toBeUndefined();
    expect(firstTab().previousSessionId).toBe(U);

    // The fallback fresh mint replaces the live slot; previous stays.
    const NEW = "9f9f9f9f-0000-4000-8000-000000000000";
    useApp.getState().setTabSessionId("ws1", tab.id, NEW);
    expect(firstTab().sessionId).toBe(NEW);
    expect(firstTab().previousSessionId).toBe(U);

    // Both ids round-trip into persisted_tabs.
    const persisted = useApp.getState().tasks[0].persisted_tabs!;
    expect(persisted[0].session_id).toBe(NEW);
    expect(persisted[0].previous_session_id).toBe(U);

    // Simulate a restart: reload from disk, tabs empty again.
    const reloaded = makeTask({ is_main_checkout: true, persisted_tabs: persisted });
    useApp.setState({ tasks: [reloaded], tabs: {}, activeTab: {} });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const restored = firstTab();
    expect(restored.sessionId).toBe(NEW);
    // The recovery pointer survived the restart — this is the whole point.
    expect(restored.previousSessionId).toBe(U);

    // Recover: promote previous back to live, and SWAP the fallback session
    // into the stash rather than dropping it (the user may have been working
    // in it since the failed resume — discarding its uuid would be the very
    // loss this feature exists to prevent).
    useApp.getState().setTabSessionId("ws1", restored.id, U);
    useApp.getState().setTabPreviousSessionId("ws1", restored.id, NEW);
    expect(firstTab().sessionId).toBe(U);
    expect(firstTab().previousSessionId).toBe(NEW);
    // decideResume now resumes the recovered session by id.
    expect(argvFor(firstTab(), useApp.getState().tasks[0])).toEqual(["--resume", U, "--name", "seo-improvements"]);

    // And the swap is reversible: switching back resumes the fallback session.
    useApp.getState().setTabSessionId("ws1", restored.id, NEW);
    useApp.getState().setTabPreviousSessionId("ws1", restored.id, U);
    expect(argvFor(firstTab(), useApp.getState().tasks[0])).toEqual(["--resume", NEW, "--name", "seo-improvements"]);
  });

  it("dismiss clears the previous pointer and leaves the live session alone", () => {
    const U = "old-uuid", NEW = "new-uuid";
    useApp.setState({ tasks: [makeTask({ is_main_checkout: true })] });
    useApp.getState().ensureDefaultTab("ws1", "claude");
    const tab = firstTab();
    useApp.getState().setTabSessionId("ws1", tab.id, NEW);
    useApp.getState().setTabPreviousSessionId("ws1", tab.id, U);
    expect(firstTab().previousSessionId).toBe(U);

    useApp.getState().setTabPreviousSessionId("ws1", tab.id, "");
    expect(firstTab().previousSessionId).toBeUndefined();
    expect(firstTab().sessionId).toBe(NEW);
  });
});
