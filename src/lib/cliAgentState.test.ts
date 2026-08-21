// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// Mocks must be declared before the module under test is imported.
// cliAgentState pulls in the tauri core API and useApp (via @/store/app),
// which pulls in ipc/tabFocus/agents. Stub them all so the aggregation
// logic can be tested in the node/happy-dom env.
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
  // The real rule's shape: shells never qualify, `work_done: false`
  // registry entries opt out, unknown clis default on.
  workDoneCapable: vi.fn((cli: string) => cli !== "shell" && cli !== "nodone"),
  // Custom terminal entries (#27), keyed by a fixed test id.
  isTerminalCli: vi.fn((cli: string) => cli === "myterm"),
}));

import { computeAgentStates } from "@/lib/cliAgentState";
import { useApp } from "@/store/app";
import type { Tab, Task, TerminalTab } from "@/lib/types";

function term(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: crypto.randomUUID(),
    type: "terminal",
    cli: "claude",
    title: "t",
    ...overrides,
  } as TerminalTab;
}

function task(id: string, archived = false): Task {
  return { id, name: id, project_id: "p1", archived } as Task;
}

/** Seed the store with one task per entry and aggregate. */
function statesFor(tabs: Record<string, Tab[]>) {
  useApp.setState({
    tasks: Object.keys(tabs).map(id => task(id)),
    tabs,
  });
  return computeAgentStates();
}

describe("computeAgentStates aggregation", () => {
  beforeEach(() => useApp.setState({ tasks: [], tabs: {} }));

  it("follows the sidebar precedence: working > attention > done > idle", () => {
    const s = statesFor({
      working: [term({ workState: "done" }), term({ workState: "working" })],
      waiting: [term({ workState: "done" }), term({ unread: { reason: "attention" } })],
      done: [term({ workState: "idle" }), term({ workState: "done" })],
      idle: [term({ workState: "idle" })],
    });
    expect(s.working.state).toBe("working");
    expect(s.waiting.state).toBe("waiting");
    expect(s.done.state).toBe("done");
    expect(s.idle.state).toBe("idle");
  });

  it("reports 'inactive' with 0 tabs when a task has no live terminal tabs", () => {
    const s = statesFor({ dormant: [] });
    expect(s.dormant).toEqual({
      state: "inactive", tabs: 0, queued: 0, capable: false, tab_states: [], hydrated: true,
    });
  });

  it("marks a task the UI has never loaded as unhydrated, not as empty", () => {
    // A task nobody has opened this session has no tabs in the store,
    // which is not the same as having none. Reporting it as loaded made
    // `termic status` say a task with durable tabs had zero, and call
    // it inactive, on no evidence at all.
    useApp.setState({ tasks: [task("never-opened")], tabs: {} });
    const s = computeAgentStates();
    expect(s["never-opened"].hydrated).toBe(false);
    // Loaded-and-empty is still a real answer, and says so.
    useApp.setState({ tasks: [task("emptied")], tabs: { emptied: [] } });
    expect(computeAgentStates().emptied.hydrated).toBe(true);
  });

  it("counts only terminal tabs and reports the count", () => {
    const editor = { id: "e", type: "editor" } as unknown as Tab;
    const s = statesFor({ mixed: [term({ workState: "idle" }), editor, term({ workState: "idle" })] });
    expect(s.mixed.tabs).toBe(2);
  });

  it("sums queued messages across tabs (quiescence needs 0)", () => {
    const q = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: String(i), text: "x", repeat: 1, remaining: 1 }));
    const s = statesFor({
      busy: [term({ workState: "done", queue: q(2) }), term({ queue: q(1) })],
      clear: [term({ workState: "done" })],
    });
    expect(s.busy.queued).toBe(3);
    expect(s.clear.queued).toBe(0);
  });

  it("counts CLI-tracked queue items in the same aggregate", () => {
    // The server's queued-send liveness detector reads entry.queued; a
    // solo CLI prompt (promptId item) must count there, or an idle
    // agent holding exactly our prompt would trip the vanished-queue
    // detector into a false exit 9.
    const s = statesFor({
      t: [term({
        queue: [{ id: "q1", text: "from cli", repeat: 1, remaining: 1, promptId: "p1" }],
      })],
    });
    expect(s.t.queued).toBe(1);
  });

  it("marks capability from the registry rule (any capable tab counts)", () => {
    const s = statesFor({
      capable: [term({ cli: "shell" }), term({ cli: "claude" })],
      incapable: [term({ cli: "shell" }), term({ cli: "nodone" })],
    });
    expect(s.capable.capable).toBe(true);
    expect(s.incapable.capable).toBe(false);
  });

  it("skips archived tasks entirely", () => {
    useApp.setState({
      tasks: [task("live"), task("gone", true)],
      tabs: { live: [term()], gone: [term()] },
    });
    const s = computeAgentStates();
    expect(Object.keys(s)).toEqual(["live"]);
  });
});

describe("per-tab snapshot (tab_states, GH #138 part 2)", () => {
  beforeEach(() => useApp.setState({ tasks: [], tabs: {} }));

  it("lists strip tabs in display order and excludes pane-split leaves", () => {
    // Pane leaves live in the same array but are not on the strip
    // (TabBar filters them); listing them would shift `--tab <n>` off
    // what the user sees in `status`.
    const s = statesFor({
      t: [
        term({ id: "a", cli: "claude" }),
        term({ id: "pane", paneId: "leaf1" }),
        term({ id: "b", cli: "shell" }),
      ],
    });
    expect(s.t.tab_states.map(t => t.id)).toEqual(["a", "b"]);
    // The aggregate count still includes every terminal tab (compat).
    expect(s.t.tabs).toBe(3);
  });

  it("maps kinds: agent, shell, custom terminal, run", () => {
    const s = statesFor({
      t: [
        term({ cli: "claude" }),
        term({ cli: "shell" }),
        term({ cli: "myterm" }),
        term({ cli: "shell", runTab: { kind: "run", member: "dev" } as never }),
      ],
    });
    expect(s.t.tab_states.map(t => t.kind)).toEqual(["agent", "shell", "terminal", "run"]);
  });

  it("reports per-tab state only where a settle signal exists", () => {
    const s = statesFor({
      t: [
        term({ cli: "claude", workState: "working" }),
        term({ cli: "claude", unread: { reason: "attention" } }),
        term({ cli: "claude", workState: "done" }),
        term({ cli: "claude" }),
        term({ cli: "shell", workState: "working" }),
        term({ cli: "nodone", workState: "working" }),
      ],
    });
    const states = s.t.tab_states.map(t => t.state);
    // A shell or opted-out agent has NO settle signal: its state must be
    // null (unknown), never a value `wait --tab` would block on.
    expect(states).toEqual(["working", "waiting", "done", "idle", null, null]);
    expect(s.t.tab_states.map(t => t.capable)).toEqual(
      [true, true, true, true, false, false],
    );
  });

  it("carries id, per-tab queue, liveness and defaultness for resolution", () => {
    const q = [{ id: "q1", text: "x", repeat: 1, remaining: 1 }];
    const s = statesFor({
      t: [
        term({ id: "main", is_default: true, ptyId: "pty-1", queue: q, title: "fixing auth" }),
        term({ id: "second", title: "" , cli: "codex" }),
      ],
    });
    expect(s.t.tab_states[0]).toMatchObject({
      id: "main", is_default: true, live: true, queued: 1, title: "fixing auth",
    });
    // No PTY, no queue, and an empty title falls back to the cli id
    // rather than pushing an unselectable empty string.
    expect(s.t.tab_states[1]).toMatchObject({
      id: "second", is_default: false, live: false, queued: 0, title: "codex",
    });
  });
});
