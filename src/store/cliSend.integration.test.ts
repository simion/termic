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
});
