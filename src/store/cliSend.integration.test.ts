// @vitest-environment happy-dom
//
// `termic send --tab` (GH #138 part 2) driven through the REAL
// `sendPromptHandler` against the REAL store (the cliTab rule: the
// targeting decisions read the store's live tab set, so a test that
// re-implements the selection tests a copy). The Rust side resolves the
// selector to a TAB ID; everything here receives ids, and the store is
// ground truth for what that id is NOW.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyAlive: vi.fn().mockResolvedValue(true),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/agentSend", () => ({ deliverMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cliPromptReports", () => ({ reportCliPromptDelivery: vi.fn().mockResolvedValue(undefined) }));

import { sendPromptHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import { deliverMessage } from "@/lib/agentSend";
import { reportCliPromptDelivery } from "@/lib/cliPromptReports";
import { takeUnattendedSpawn } from "@/lib/unattendedSpawns";
import type { Task, Tab } from "@/lib/types";

const AGENTS = [
  { id: "claude", name: "Claude Code", disabled: false },
  { id: "codex", name: "Codex", disabled: false },
];

function term(over: Record<string, unknown> = {}): Tab {
  return {
    id: "t-default", type: "terminal", cli: "claude", title: "claude",
    is_default: true, ptyId: "pty-1",
    ...over,
  } as unknown as Tab;
}

function seed(tabs: Tab[]) {
  useApp.setState({
    tasks: [{
      id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude",
      archived: false, persisted_tabs: [],
    } as unknown as Task],
    tabs: { ws1: tabs },
    mountedTasks: new Set(["ws1"]),
    agents: AGENTS,
    detectedClis: {},
  } as never);
}

const send = (over: Record<string, unknown> = {}) =>
  sendPromptHandler({
    taskId: "ws1", prompt: "run tests", promptId: "pid-1", ...over,
  });

describe("send --tab: explicit target (GH #138 part 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed([
      term(),
      term({ id: "t-second", cli: "codex", title: "codex", is_default: false, ptyId: "pty-2" }),
    ]);
  });

  it("delivers to the TARGETED tab, not the default", async () => {
    const r = await send({ tabId: "t-second" });
    expect(r.mode).toBe("delivered");
    // The delivery typed into the second tab's PTY: targeting a tab and
    // silently prompting the default would be the worst failure shape.
    expect(deliverMessage).toHaveBeenCalledWith("pty-2", "run tests");
    expect(reportCliPromptDelivery).toHaveBeenCalledWith("pid-1", true);
  });

  it("queues on the targeted tab when IT is busy, keyed by its own state", async () => {
    seed([
      term(),  // default is idle: must not matter
      term({
        id: "t-second", cli: "codex", is_default: false, ptyId: "pty-2",
        workState: "working",
      }),
    ]);
    const r = await send({ tabId: "t-second" });
    expect(r.mode).toBe("queued");
    const q = (useApp.getState().tabs.ws1 as never[]).find(
      (t: never) => (t as { id: string }).id === "t-second",
    ) as unknown as { queue?: unknown[] };
    expect(q.queue?.length).toBe(1);
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  // An agent whose own loop stopped with subagents / shells still running
  // (delegated, or partially done) takes the prompt now instead of queueing it
  // until every one of them has finished.
  it("delivers to an agent stalled on delegated work instead of queueing", async () => {
    seed([
      term(),
      term({
        id: "t-second", cli: "codex", is_default: false, ptyId: "pty-2",
        workState: "working", delegatedIdle: true,
      }),
    ]);
    const r = await send({ tabId: "t-second" });
    expect(r.mode).toBe("delivered");
    expect(deliverMessage).toHaveBeenCalledWith("pty-2", "run tests");
  });

  it("queues on an IDLE agent while the user has a draft in its prompt", async () => {
    // Typing now would land inside the user's unsubmitted text, and Enter
    // would send both as one message.
    seed([
      term(),
      term({ id: "t-second", cli: "codex", is_default: false, ptyId: "pty-2", composing: true }),
    ]);
    const r = await send({ tabId: "t-second" });
    expect(r.mode).toBe("queued");
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it("still queues on a delegated agent that has gone back to work", async () => {
    // delegatedWork alone stays on the tab while the model works again; only
    // the idle mark says the loop has stopped.
    seed([
      term(),
      term({
        id: "t-second", cli: "codex", is_default: false, ptyId: "pty-2",
        workState: "working", delegatedIdle: false,
        delegatedWork: { label: "subagent", count: 1, ids: ["a"] },
      }),
    ]);
    const r = await send({ tabId: "t-second" });
    expect(r.mode).toBe("queued");
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it("refuses a vanished tab id with the unknown_tab sentinel", async () => {
    // The server resolved from its cache; the tab closed meanwhile. The
    // store is ground truth and the error must be the coded sentinel so
    // Rust maps it to NotFound instead of Internal.
    await expect(send({ tabId: "t-gone" })).rejects.toThrow(/^cli_send:unknown_tab:/);
  });

  it("refuses shell and run tabs with not_sendable", async () => {
    seed([
      term(),
      term({ id: "t-shell", cli: "shell", is_default: false, ptyId: "pty-3" }),
      term({
        id: "t-run", cli: "shell", is_default: false, ptyId: "pty-5",
        runTab: { kind: "run", member: "dev" },
      }),
    ]);
    await expect(send({ tabId: "t-shell" })).rejects.toThrow(/^cli_send:not_sendable:/);
    await expect(send({ tabId: "t-run" })).rejects.toThrow(/^cli_send:not_sendable:/);
  });

  it("refuses a dead target instead of stalling into a lost prompt", async () => {
    seed([term(), term({ id: "t-dead", cli: "codex", is_default: false, ptyId: undefined })]);
    await expect(send({ tabId: "t-dead" })).rejects.toThrow(/^cli_send:tab_not_live:/);
  });

  it("spawn-pending takes the tracked route even when the PTY won the race", async () => {
    // tab -p's dispatch can lose the race to TerminalPane's spawn. A
    // live PTY does NOT mean a ready agent: typing immediately would
    // land in the boot splash and skip the settle beat, so the mode
    // must be a deterministic "spawned" (tracked injection), never a
    // race-dependent "delivered".
    seed([term(), term({ id: "t-won", cli: "codex", is_default: false, ptyId: "pty-8" })]);
    const r = await send({ tabId: "t-won", spawnPending: true });
    expect(r.mode).toBe("spawned");
    // Delivery is the tracked injector's job (settle beat first); the
    // immediate-typing path must not have run.
    expect(deliverMessage).not.toHaveBeenCalled();
  });

  it("spawn-pending waits for the racing PTY instead of refusing (tab -p)", async () => {
    // The tab was created moments ago; TerminalPane has not spawned its
    // PTY yet. The handler must return "spawned" and hand delivery to
    // the tracked injector rather than erroring on the missing PTY.
    seed([term(), term({ id: "t-new", cli: "codex", is_default: false, ptyId: undefined })]);
    const pending = send({ tabId: "t-new", spawnPending: true });
    // The PTY arrives while the handler polls.
    useApp.setState(s => ({
      tabs: {
        ws1: (s.tabs.ws1 ?? []).map(t =>
          t.id === "t-new" ? { ...t, ptyId: "pty-9" } : t,
        ),
      },
    } as never));
    const r = await pending;
    expect(r.mode).toBe("spawned");
  });

  it("refuses --resume/--fresh alongside a target", async () => {
    await expect(send({ tabId: "t-second", resume: true })).rejects.toThrow(
      /^cli_send:flags_useless:/,
    );
  });

  it("refuses --wait on an incapable targeted agent", async () => {
    seed([term(), term({ id: "t-nod", cli: "nodone", is_default: false, ptyId: "pty-4" })]);
    useApp.setState({
      agents: [...AGENTS, { id: "nodone", name: "NoDone", disabled: false, work_done: false }],
    } as never);
    await expect(send({ tabId: "t-nod", wait: true })).rejects.toThrow(/^cli_send:not_capable:/);
  });

  it("prefers a live preferredTabId over is_default and returns the delivered tabId", async () => {
    const r = await send({ preferredTabId: "t-second" });
    expect(r).toEqual({ mode: "delivered", capable: true, tabId: "t-second" });
    expect(deliverMessage).toHaveBeenCalledWith("pty-2", "run tests");
  });

  it("delivers to split-pane tabs via tabId or preferredTabId", async () => {
    seed([
      term(),
      term({ id: "t-pane", paneId: "leaf-2", cli: "codex", is_default: false, ptyId: "pty-pane" }),
    ]);
    const r1 = await send({ tabId: "t-pane" });
    expect(r1).toEqual({ mode: "delivered", capable: true, tabId: "t-pane" });
    expect(deliverMessage).toHaveBeenLastCalledWith("pty-pane", "run tests");

    const r2 = await send({ preferredTabId: "t-pane" });
    expect(r2).toEqual({ mode: "delivered", capable: true, tabId: "t-pane" });
  });

  it("falls back to is_default when preferredTabId is dead or closed", async () => {
    seed([
      term(),
      term({ id: "t-dead", cli: "codex", is_default: false, ptyId: undefined }),
    ]);
    const r = await send({ preferredTabId: "t-dead" });
    expect(r).toEqual({ mode: "delivered", capable: true, tabId: "t-default" });
    expect(deliverMessage).toHaveBeenCalledWith("pty-1", "run tests");
  });

  it("falls back to the default strip tab when an initiating split-pane preferredTabId exited", async () => {
    seed([
      term(),
      term({ id: "t-pane", paneId: "leaf-2", cli: "codex", is_default: false, ptyId: undefined }),
    ]);
    const r = await send({ preferredTabId: "t-pane" });
    expect(r).toEqual({ mode: "delivered", capable: true, tabId: "t-default" });
    expect(deliverMessage).toHaveBeenCalledWith("pty-1", "run tests");
  });

  it("excludes persisted split-pane tabs on resume and restores the default strip tab instead", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({
        tasks: [{
          id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude",
          archived: false, has_resumable_history: true,
          persisted_tabs: [
            { id: "t-pane", pane_leaf_id: "leaf-2", cli: "codex", is_default: false, session_id: "S-PANE" },
            { id: "orig-default", cli: "claude", is_default: true, session_id: "S-DEF" },
          ],
        } as unknown as Task],
        tabs: {
          ws1: [term({ id: "sh-1", cli: "shell", is_default: false, ptyId: "pty-sh" })],
        },
        mountedTasks: new Set(["ws1"]),
        agents: AGENTS,
        detectedClis: {},
      } as never);

      const pending = send({ resume: true, preferredTabId: "t-pane", promptId: "pid-pane-resume-fallback" });
      expect(takeUnattendedSpawn("ws1")).toBe(false);
      const tabs = useApp.getState().tabs.ws1 ?? [];
      expect(tabs.some(t => t.id === "t-pane")).toBe(false);
      const restored = tabs.find(t => t.id === "orig-default");
      expect(restored).toBeDefined();
      expect((restored as { cli?: string }).cli).toBe("claude");
      expect((restored as { sessionId?: string }).sessionId).toBe("S-DEF");

      useApp.setState(s => ({
        tabs: {
          ws1: (s.tabs.ws1 ?? []).map(t =>
            t.id === "orig-default"
              ? { ...t, ptyId: "pty-def", firstOutputAt: Date.now(), lastOutputAt: Date.now(), agentReadyAt: Date.now() }
              : t,
          ),
        },
      } as never));
      await vi.advanceTimersByTimeAsync(150);

      const res = await pending;
      expect(res.tabId).toBe("orig-default");

      await vi.advanceTimersByTimeAsync(6000);
      expect(deliverMessage).toHaveBeenCalledWith("pty-def", "run tests", { verifyEcho: false });
      expect(deliverMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never misroutes preferredTabId onto a sibling whose title matches the stale id", async () => {
    seed([
      term(),
      term({ id: "t-other", cli: "codex", title: "stale-id", is_default: false, ptyId: "pty-2" }),
    ]);
    const r = await send({ preferredTabId: "stale-id" });
    expect(r).toEqual({ mode: "delivered", capable: true, tabId: "t-default" });
    expect(deliverMessage).toHaveBeenCalledWith("pty-1", "run tests");
  });

  it("locks onto the ensured tabId so a sibling taking default during spawn never receives delivery", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({
        tasks: [{
          id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude",
          archived: false, has_resumable_history: true,
          persisted_tabs: [
            { id: "t-restored", cli: "claude", is_default: true, session_id: "S-1" },
          ],
        } as unknown as Task],
        tabs: {},
        mountedTasks: new Set(),
        agents: AGENTS,
        detectedClis: {},
      } as never);

      const pending = send({ resume: true, promptId: "pid-locked" });
      // While waitForAgentPty / waitForAgentReady runs, flip default to a live sibling
      // and leave t-restored alive (non-default) then close it before readiness settles.
      useApp.setState(s => ({
        tabs: {
          ws1: [
            ...(s.tabs.ws1 ?? []).map(t =>
              t.id === "t-restored" ? { ...t, is_default: false, ptyId: "pty-restored" } : t,
            ),
            term({ id: "t-sibling", cli: "codex", is_default: true, ptyId: "pty-sib" }),
          ],
        },
      } as never));
      // Advance waitForAgentPty poll tick, then close t-restored during readiness.
      await vi.advanceTimersByTimeAsync(150);
      useApp.setState(s => ({
        tabs: { ws1: (s.tabs.ws1 ?? []).filter(t => t.id !== "t-restored") },
      } as never));

      const res = await pending;
      expect(res.tabId).toBe("t-restored");

      await vi.advanceTimersByTimeAsync(6000);
      expect(deliverMessage).not.toHaveBeenCalled();
      expect(reportCliPromptDelivery).toHaveBeenCalledWith(
        "pid-locked",
        false,
        expect.stringContaining("lost its PTY"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a persisted default agent tab with its original id, settings, and single default on a non-agent strip", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({
        tasks: [{
          id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude",
          archived: false, has_resumable_history: true,
          persisted_tabs: [{
            id: "orig-default",
            cli: "codex",
            is_default: true,
            session_id: "S-ORIG",
            agent_args: ["--model", "o3"],
          }],
        } as unknown as Task],
        tabs: {
          ws1: [
            { id: "ed-1", type: "editor", filePath: "/tmp/a.ts", title: "a.ts", content: "", dirty: false } as unknown as Tab,
            term({ id: "sh-1", cli: "shell", is_default: false, ptyId: "pty-sh" }),
          ],
        },
        mountedTasks: new Set(["ws1"]),
        agents: AGENTS,
        detectedClis: {},
      } as never);

      const pending = send({ resume: true, promptId: "pid-persisted-non-agent-strip" });
      expect(takeUnattendedSpawn("ws1")).toBe(false);
      const restored = (useApp.getState().tabs.ws1 ?? []).find(t => t.id === "orig-default");
      expect(restored).toBeDefined();
      expect((restored as { cli?: string }).cli).toBe("codex");
      expect((restored as { is_default?: boolean }).is_default).toBe(true);
      expect((restored as { sessionId?: string }).sessionId).toBe("S-ORIG");
      expect((restored as { agentArgs?: string[] }).agentArgs).toEqual(["--model", "o3"]);

      const persistedDefaults = (useApp.getState().tasks[0].persisted_tabs ?? []).filter(pt => pt.is_default);
      expect(persistedDefaults).toHaveLength(1);
      expect(persistedDefaults[0].id).toBe("orig-default");

      // A concurrent agent opens during PTY startup; delivery must stay on orig-default.
      useApp.setState(s => ({
        tabs: {
          ws1: [
            ...(s.tabs.ws1 ?? []),
            term({
              id: "t-concurrent", cli: "claude", is_default: false, ptyId: "pty-conc",
              firstOutputAt: Date.now(), lastOutputAt: Date.now(), agentReadyAt: Date.now(),
            }),
          ],
        },
      } as never));
      await vi.advanceTimersByTimeAsync(150);

      useApp.setState(s => ({
        tabs: {
          ws1: (s.tabs.ws1 ?? []).map(t =>
            t.id === "orig-default"
              ? { ...t, ptyId: "pty-intended", firstOutputAt: Date.now(), lastOutputAt: Date.now(), agentReadyAt: Date.now() }
              : t,
          ),
        },
      } as never));
      await vi.advanceTimersByTimeAsync(150);

      const res = await pending;
      expect(res.tabId).toBe("orig-default");

      await vi.advanceTimersByTimeAsync(6000);
      expect(deliverMessage).toHaveBeenCalledWith("pty-intended", "run tests", { verifyEcho: false });
      expect(deliverMessage).not.toHaveBeenCalledWith("pty-conc", expect.anything(), expect.anything());
      expect(deliverMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a secondary persisted agent with its own cli and session rather than seeding another cli", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({
        tasks: [{
          id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude",
          archived: false, has_resumable_history: true,
          agent_session_ids: { claude: "S-CLAUDE-LEG" },
          persisted_tabs: [{
            id: "sec-codex",
            cli: "codex",
            is_default: false,
            session_id: "S-SEC-CODEX",
          }],
        } as unknown as Task],
        tabs: {
          ws1: [term({ id: "sh-1", cli: "shell", is_default: false, ptyId: "pty-sh" })],
        },
        mountedTasks: new Set(["ws1"]),
        agents: AGENTS,
        detectedClis: {},
      } as never);

      const pending = send({ resume: true, promptId: "pid-secondary-persisted" });
      const tabs = useApp.getState().tabs.ws1 ?? [];
      const restored = tabs.find(t => t.id === "sec-codex");
      expect(restored).toBeDefined();
      expect((restored as { cli?: string }).cli).toBe("codex");
      expect((restored as { sessionId?: string }).sessionId).toBe("S-SEC-CODEX");
      expect(tabs.some(t => (t as { cli?: string }).cli === "claude")).toBe(false);

      useApp.setState(s => ({
        tabs: {
          ws1: (s.tabs.ws1 ?? []).map(t =>
            t.id === "sec-codex"
              ? { ...t, ptyId: "pty-sec", firstOutputAt: Date.now(), lastOutputAt: Date.now(), agentReadyAt: Date.now() }
              : t,
          ),
        },
      } as never));
      await vi.advanceTimersByTimeAsync(150);

      const res = await pending;
      expect(res.tabId).toBe("sec-codex");

      await vi.advanceTimersByTimeAsync(6000);
      expect(deliverMessage).toHaveBeenCalledWith("pty-sec", "run tests", { verifyEcho: false });
      expect(deliverMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds an explicit agent tab on a non-agent strip instead of racing a concurrent agent", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({
        tasks: [{
          id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude",
          archived: false, has_resumable_history: true,
          persisted_tabs: [],
        } as unknown as Task],
        tabs: {
          ws1: [
            { id: "ed-1", type: "editor", filePath: "/tmp/a.ts", title: "a.ts", content: "", dirty: false } as unknown as Tab,
            term({ id: "sh-1", cli: "shell", is_default: false, ptyId: "pty-sh" }),
          ],
        },
        mountedTasks: new Set(["ws1"]),
        agents: AGENTS,
        detectedClis: {},
      } as never);

      const pending = send({ resume: true, promptId: "pid-non-agent-strip" });
      expect(takeUnattendedSpawn("ws1")).toBe(false);
      const created = (useApp.getState().tabs.ws1 ?? []).find(
        t => t.type === "terminal" && t.cli === "claude",
      );
      expect(created?.id).toBeTruthy();

      // A concurrent sibling agent tab spawns while our intended tab still has no PTY.
      useApp.setState(s => ({
        tabs: {
          ws1: [
            ...(s.tabs.ws1 ?? []),
            term({ id: "t-concurrent", cli: "codex", is_default: true, ptyId: "pty-conc" }),
          ],
        },
      } as never));
      await vi.advanceTimersByTimeAsync(150);

      // Now our locked agent tab gets its PTY; delivery MUST go to it, not t-concurrent.
      useApp.setState(s => ({
        tabs: {
          ws1: (s.tabs.ws1 ?? []).map(t =>
            t.id === created!.id
              ? { ...t, ptyId: "pty-intended", firstOutputAt: Date.now(), lastOutputAt: Date.now(), agentReadyAt: Date.now() }
              : t,
          ),
        },
      } as never));
      await vi.advanceTimersByTimeAsync(150);

      const res = await pending;
      expect(res.tabId).toBe(created!.id);

      await vi.advanceTimersByTimeAsync(6000);
      expect(deliverMessage).toHaveBeenCalledWith("pty-intended", "run tests", { verifyEcho: false });
      expect(deliverMessage).not.toHaveBeenCalledWith("pty-conc", expect.anything(), expect.anything());
      expect(deliverMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
