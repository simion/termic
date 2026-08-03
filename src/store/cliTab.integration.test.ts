// @vitest-environment happy-dom
//
// `termic tab` (GH #138) driven through the REAL `newTabHandler` against the
// REAL store. Both matter:
//
//   - Real store, because the rules are properties of `addTab` /
//     `syncDurableTabs`, not of the handler's own code. `syncDurableTabs`
//     treats whatever is in the store as the task's LIVE tab set, so on a task
//     that has not been mounted this session (the CLI's whole use case) that
//     set is EMPTY and a pre-added tab rewrites `persisted_tabs` to just that
//     tab, forgetting every other agent's session id permanently, on disk.
//   - Real handler, because an earlier version of this file re-implemented the
//     handler's sequence in a local helper and therefore tested a COPY. It
//     passed while the shipped path refused every unmounted task (the restore
//     ran before the stopped check, so the check saw the tabs it had just
//     restored). A test that mirrors the code cannot catch the code.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  // PATH detection: claude present, codex absent. Drives the cold-launch
  // case below, where the handler must run this before validating --agent.
  detectClis: vi.fn().mockResolvedValue([
    { name: "claude", found: true, path: "/usr/bin/claude" },
    { name: "codex", found: false, path: null },
  ]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));
// The handler module pulls in the Tauri event API at import time.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { newTabHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { Task } from "@/lib/types";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "ws1", project_id: "p1", name: "fix-auth", branch: "main",
    base_branch: "main", path: "/x/ws1", cli: "claude", port: 1420,
    created: "2024-01-01", archived: false,
    // Two durable agents, each with its own session. The second is the one
    // a naive implementation loses.
    persisted_tabs: [
      { id: "main", cli: "claude", title: "claude", is_default: true, session_id: "SESSION-A" },
      { id: "second", cli: "codex", title: "codex", session_id: "SESSION-B" },
    ],
    ...over,
  } as unknown as Task;
}

/** An enabled+installed registry so kind validation passes. */
const AGENTS = [
  { id: "claude", name: "Claude Code", disabled: false },
  { id: "codex", name: "Codex", disabled: false },
];

/** Real `CliInfo` shape. Seeding bare strings here would still let the happy
 *  paths pass (both readers fall back with `?? true` / `?? null`), which means
 *  the suite would silently be testing "detection ran but every entry is
 *  garbage" rather than the case it names. */
const cliInfo = (name: string, found: boolean) => ({
  name, found, path: found ? `/usr/bin/${name}` : "", version: found ? "1.0.0" : "",
});

function seed(over: Partial<Task> = {}) {
  useApp.setState({
    tasks: [task(over)],
    tabs: {},
    mountedTasks: new Set(),
    agents: AGENTS,
    detectedClis: { claude: cliInfo("claude", true), codex: cliInfo("codex", true) },
  } as never);
}

// NOTE: live tabs carry `is_default` (snake_case), matching persisted_tabs.
// Asserting a camelCase `isDefault` silently reads undefined and passes.
const tabsOf = (id = "ws1") =>
  useApp.getState().tabs[id] as Array<{
    id: string; cli: string; sessionId?: string | null; session_id?: string | null;
    is_default?: boolean;
  }>;

describe("termic tab: opening a tab on an unmounted task", () => {
  beforeEach(() => seed());

  it("succeeds on a task the user has not opened this session", async () => {
    // The cold-start path, and the one `tab` auto-launches into: nothing is
    // mounted until setActiveTask/mountTasks runs, so a "stopped" check that
    // fires after the persisted set is restored refuses EVERY task.
    await expect(newTabHandler({ taskId: "ws1", kind: "shell" })).resolves.toMatchObject({
      taskId: "ws1",
      cli: "shell",
    });
  });

  it("keeps every persisted agent and its session id", async () => {
    await newTabHandler({ taskId: "ws1", kind: "agent", id: "claude" });

    const ids = tabsOf().map(t => t.id);
    expect(ids).toContain("main");
    expect(ids).toContain("second");
    // The session ids are the irreplaceable part: losing one means the agent
    // can never be resumed again.
    expect(tabsOf().find(t => t.id === "second")?.sessionId).toBe("SESSION-B");
  });

  it("does not make the new tab the task's default target", async () => {
    // `is_default` decides what attach/logs/send resolve to. If the persisted
    // set were dropped, the CLI's tab would be the first of its cli and would
    // silently inherit that role, plus the main session's cwd-resume.
    const { tabId } = await newTabHandler({ taskId: "ws1", kind: "agent", id: "claude" });
    const dflt = tabsOf().find(t => t.is_default);
    expect(dflt?.id).toBe("main");   // asserted positively: a missing flag must fail
    expect(dflt?.id).not.toBe(tabId);
  });

  it("a shell tab does not strand the task without an agent", async () => {
    // Shell tabs are not durable, so a naive pre-add leaves persisted_tabs
    // holding only the default and the task wakes with no agent at all.
    await newTabHandler({ taskId: "ws1", kind: "shell" });
    const clis = tabsOf().map(t => t.cli);
    expect(clis).toContain("claude");
    expect(clis).toContain("codex");
    expect(clis).toContain("shell");
  });
});

describe("termic tab: a task whose durable set is empty", () => {
  // The main tab X-ed out, or a legacy record from before tab persistence.
  // `sendPromptHandler` handles this state explicitly; `tab` must too, or the
  // seed never runs and the task is left with only the CLI's own tab.
  beforeEach(() => seed({ persisted_tabs: [] }));

  it("still seeds the task's agent alongside a shell tab", async () => {
    await newTabHandler({ taskId: "ws1", kind: "shell" });
    const clis = tabsOf().map(t => t.cli);
    expect(clis).toContain("shell");
    // Without the seed, TaskView's mount effect early-returns (a main tab now
    // exists) and the task is agentless with nothing left to seed it.
    expect(clis).toContain("claude");
  });

  it("leaves a default target for attach/logs/send", async () => {
    // A secondary agent differing from task.cli must not become is_default.
    await newTabHandler({ taskId: "ws1", kind: "agent", id: "codex" });
    const dflt = tabsOf().find(t => t.is_default);
    expect(dflt?.cli).toBe("claude");
  });
});

describe("termic tab: cold launch, before PATH detection has run", () => {
  // `termic tab` auto-launches the app, so it can beat App.tsx's refreshClis.
  // visibleCliIds treats an empty detection map as "assume everything is
  // present", which would ACCEPT an uninstalled agent and fail later at exec.
  beforeEach(() => {
    seed();
    useApp.setState({ detectedClis: {} } as never);
  });

  it("detects first, then refuses an agent that is not installed", async () => {
    await expect(
      newTabHandler({ taskId: "ws1", kind: "agent", id: "codex" }),
    ).rejects.toThrow(/not installed/);
  });

  it("still opens an agent that IS installed", async () => {
    await expect(
      newTabHandler({ taskId: "ws1", kind: "agent", id: "claude" }),
    ).resolves.toMatchObject({ cli: "claude" });
  });

  it("does not probe PATH for a shell tab, which validates nothing", async () => {
    // Detection spawns a login shell per agent. Paying that on the one kind
    // with nothing to validate would race App.tsx's refreshClis for no gain.
    vi.mocked(ipc.detectClis).mockClear();
    await newTabHandler({ taskId: "ws1", kind: "shell" });
    expect(ipc.detectClis).not.toHaveBeenCalled();
  });
});

describe("termic tab: a genuinely stopped task", () => {
  it("is refused rather than respawning every agent in it", async () => {
    // GH #119 evicts a stopped task from mountedTasks but KEEPS its live tabs.
    // That live set, not the restored one, is what marks it stopped.
    seed();
    useApp.setState({
      tabs: { ws1: [{ id: "main", type: "terminal", title: "claude", cli: "claude" }] },
      mountedTasks: new Set(),
    } as never);
    await expect(newTabHandler({ taskId: "ws1", kind: "shell" })).rejects.toThrow(/stopped/);
  });
});
