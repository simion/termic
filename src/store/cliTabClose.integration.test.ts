// @vitest-environment happy-dom
//
// `termic tab close` (GH #185) driven through the REAL `closeTabHandler`
// against the REAL store, for the reasons cliTab.integration.test.ts spells
// out: the rules that matter here are properties of `closeTab` and
// `syncDurableTabs`, not of the handler's own code.
//
// The sharp edge this file exists to hold: `closeTab` ends in
// `syncDurableTabs`, which treats whatever is in the store as the task's LIVE
// tab set. On a task that is not mounted that set is EMPTY, so letting the
// close run there would rewrite `persisted_tabs` down to the default tab and
// forget every secondary agent's session id, on disk, permanently. No GUI path
// can reach that (the × only exists on a mounted strip); the CLI can, which is
// why the refusal lives in the handler and is asserted here.
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
  detectClis: vi.fn().mockResolvedValue([]),
}));
// closeTab follows focus to the tab that takes over, so the default-tab
// cases reach focusMainTab as well as focusTerminalTab.
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { closeTabHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { Task, Tab } from "@/lib/types";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "ws1", project_id: "p1", name: "fix-auth", branch: "main",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false,
    persisted_tabs: [
      { id: "main", cli: "claude", title: "claude", is_default: true, session_id: "SESSION-A" },
      { id: "second", cli: "codex", title: "codex", session_id: "SESSION-B" },
    ],
    ...over,
  } as unknown as Task;
}

const term = (over: Record<string, unknown>) =>
  ({ type: "terminal", title: "claude", cli: "claude", ...over }) as unknown as Tab;

/** A MOUNTED task with both agents live in the strip: the state the GUI's ×
 *  is always in, and the only state `tab close` accepts. */
function seedMounted() {
  useApp.setState({
    tasks: [task()],
    tabs: {
      ws1: [
        term({ id: "main", cli: "claude", is_default: true, sessionId: "SESSION-A", ptyId: "pty-a" }),
        term({ id: "second", cli: "codex", title: "codex", sessionId: "SESSION-B", ptyId: "pty-b" }),
      ],
    },
    activeTab: { ws1: "main" },
    mountedTasks: new Set(["ws1"]),
    closedTabs: {},
    splitTree: {},
    activePaneId: {},
    paneHistory: {},
    agents: [],
  } as never);
  vi.mocked(ipc.taskSetTabs).mockClear();
  vi.mocked(ipc.ptyKill).mockClear();
}

const tabIds = (id = "ws1") => (useApp.getState().tabs[id] ?? []).map(t => t.id);
const durableIds = () =>
  (useApp.getState().tasks.find(t => t.id === "ws1")?.persisted_tabs ?? []).map(t => t.id);

describe("termic tab close: a secondary agent tab", () => {
  beforeEach(seedMounted);

  it("leaves the strip, kills its PTY, and takes nothing else with it", async () => {
    await expect(closeTabHandler({ taskId: "ws1", tabId: "second" })).resolves.toMatchObject({
      taskId: "ws1",
      tabId: "second",
      // Reported back because for a non-agent tab the store is the ONLY
      // side that knows a process was running (no PtyRole to resolve).
      killedPty: true,
    });
    expect(tabIds()).toEqual(["main"]);
    expect(ipc.ptyKill).toHaveBeenCalledWith("pty-b");
    // The task and its other agent are untouched. This is the whole
    // difference from `archive`, which takes every tab including the one an
    // orchestrator is driving from.
    expect(useApp.getState().mountedTasks.has("ws1")).toBe(true);
  });

  it("is forgotten from the durable set, so the task does not bring it back", async () => {
    await closeTabHandler({ taskId: "ws1", tabId: "second" });
    expect(durableIds()).toEqual(["main"]);
    expect(ipc.taskSetTabs).toHaveBeenCalled();
  });

  it("keeps its session id in closedTabs, the only place it survives", async () => {
    // syncDurableTabs is about to drop the record; without this snapshot the
    // conversation is unreachable forever, and the window's Resume menu (and
    // the CLI resume verb that pairs with this one) has nothing to offer.
    await closeTabHandler({ taskId: "ws1", tabId: "second" });
    const entries = useApp.getState().closedTabs.ws1 ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cli: "codex", sessionId: "SESSION-B" });
  });
});

describe("termic tab close: a shell tab", () => {
  beforeEach(() => {
    seedMounted();
    useApp.setState({
      tabs: {
        ws1: [
          ...(useApp.getState().tabs.ws1 ?? []),
          term({ id: "sh", cli: "shell", title: "Terminal", ptyId: "pty-sh" }),
        ],
      },
    } as never);
  });

  it("closes, which no other CLI verb can do to it", async () => {
    // The write-only rule keeps send/wait/attach/logs off shell tabs
    // because driving an uncaged terminal remotely is the risk. Closing
    // is not driving, and `termic tab --shell` can open one of these, so
    // refusing here would leave litter with no way to sweep it.
    await expect(closeTabHandler({ taskId: "ws1", tabId: "sh" })).resolves.toMatchObject({
      tabId: "sh",
      killedPty: true,
    });
    expect(tabIds()).toEqual(["main", "second"]);
    expect(ipc.ptyKill).toHaveBeenCalledWith("pty-sh");
  });

  it("leaves no Resume entry, because a shell has no session to resume", async () => {
    await closeTabHandler({ taskId: "ws1", tabId: "sh" });
    expect(useApp.getState().closedTabs.ws1 ?? []).toHaveLength(0);
  });

  it("reports killedPty false when its process had already exited", async () => {
    useApp.setState({
      tabs: {
        ws1: (useApp.getState().tabs.ws1 ?? []).map(t =>
          t.id === "sh" ? ({ ...t, ptyId: undefined } as never) : t,
        ),
      },
    } as never);
    await expect(closeTabHandler({ taskId: "ws1", tabId: "sh" })).resolves.toMatchObject({
      killedPty: false,
    });
  });
});

describe("termic tab close: the default tab", () => {
  beforeEach(seedMounted);

  it("closes but stays durable, so the task reopens it", async () => {
    // The server's --yes guard has already run by the time the handler sees
    // this. What the store does with it is the other half of the contract:
    // closing the default tab ends the agent FOR NOW, not for good.
    await closeTabHandler({ taskId: "ws1", tabId: "main" });
    expect(tabIds()).toEqual(["second"]);
    expect(durableIds()).toContain("main");
  });

  // "Reopens it" above means WAKES it: `ensureDefaultTab` restores from
  // `persisted_tabs` only for a task that owns no main tabs. This close left
  // `second` standing, so the task never sleeps and nothing ever wakes it —
  // the durable record stays perfect and unreachable, and "+" gives you a new
  // tab id on a new session. So the closed main tab is snapshotted too, under
  // its OWN id, and Resume re-attaches to the record already on disk.
  it("gets a Resume entry when the task is left awake, keyed to the same tab", async () => {
    await closeTabHandler({ taskId: "ws1", tabId: "main" });
    const entries = useApp.getState().closedTabs.ws1 ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tabId: "main", isDefault: true, sessionId: "SESSION-A" });

    useApp.getState().resumeClosedTab("ws1", entries[0].id);
    const back = (useApp.getState().tabs.ws1 ?? []).find(t => t.id === "main");
    expect(back).toMatchObject({ id: "main", is_default: true, sessionId: "SESSION-A" });
    // One durable record for that session, not two.
    expect(durableIds().filter(id => id === "main")).toHaveLength(1);
  });

  it("gets NO entry when closing it sleeps the task, which already resumes it", async () => {
    await closeTabHandler({ taskId: "ws1", tabId: "second" });
    useApp.setState({ closedTabs: {} } as never);
    await closeTabHandler({ taskId: "ws1", tabId: "main" });
    expect(tabIds()).toEqual([]);
    expect(durableIds()).toContain("main");
    // A second way back would just be a duplicate of the wake.
    expect(useApp.getState().closedTabs.ws1 ?? []).toHaveLength(0);
  });
});

describe("termic tab close: refusals", () => {
  beforeEach(seedMounted);

  it("refuses a task that is not open, WITHOUT touching the durable set", async () => {
    // The landmine. An unmounted task has an empty live set, so letting
    // closeTab run would rewrite persisted_tabs to just the default and lose
    // SESSION-B on disk.
    useApp.setState({ mountedTasks: new Set(), tabs: {} } as never);
    await expect(closeTabHandler({ taskId: "ws1", tabId: "second" })).rejects.toThrow(
      /cli_tab_close:task_stopped/,
    );
    expect(durableIds()).toEqual(["main", "second"]);
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
    expect(ipc.ptyKill).not.toHaveBeenCalled();
  });

  it("names an unknown tab as such, so the server can map it to not-found", async () => {
    // The resolver's cache can trail the store by a beat; a tab that closed
    // underneath us must not read as a server failure.
    await expect(closeTabHandler({ taskId: "ws1", tabId: "ghost" })).rejects.toThrow(
      /cli_tab_close:unknown_tab/,
    );
    expect(tabIds()).toEqual(["main", "second"]);
  });

  it("refuses a split-pane tab rather than running the wrong close", async () => {
    // Unreachable through the Rust resolver (both paths filter pane tabs) but
    // closeTab is the wrong action for one, and this is the seam where that
    // would stop being obvious.
    useApp.setState({
      tabs: {
        ws1: [
          ...(useApp.getState().tabs.ws1 ?? []),
          term({ id: "paned", cli: "claude", paneId: "leaf-1", ptyId: "pty-c" }),
        ],
      },
    } as never);
    await expect(closeTabHandler({ taskId: "ws1", tabId: "paned" })).rejects.toThrow(
      /cli_tab_close:not_closable/,
    );
    expect(tabIds()).toContain("paned");
    expect(ipc.ptyKill).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty tab id instead of guessing one", async () => {
    // There is no "the obvious tab" to close, and picking one would be the
    // destructive direction.
    await expect(closeTabHandler({ taskId: "ws1" })).rejects.toThrow(/requires a tabId/);
    await expect(closeTabHandler({ taskId: "ws1", tabId: "" })).rejects.toThrow(/requires a tabId/);
    await expect(closeTabHandler({ tabId: "second" })).rejects.toThrow(/requires a taskId/);
    expect(tabIds()).toEqual(["main", "second"]);
  });
});
