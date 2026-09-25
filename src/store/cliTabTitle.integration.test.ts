// @vitest-environment happy-dom
//
// `termic tab --title` and `termic tab --tab X --title Y` (GH #331), driven
// through the REAL handlers against the REAL store, the rule
// cliTab.integration.test.ts spells out: what matters here is what the
// store does with a title (the customTitle lock, the durable write, the
// reset), not the handler's own lines.
//
// The title check mirrors the server's `--tab` resolver: a title another
// strip tab already answers to, by its title OR its cli id, is refused,
// because the whole point of --title is a selector that is not ambiguous.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { newTabHandler, renameTabHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { PersistedTab, Task, TerminalTab } from "@/lib/types";

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

const AGENTS = [
  { id: "claude", display_name: "Claude Code", disabled: false, command: "claude", args: [] },
  { id: "codex", display_name: "Codex", disabled: false, command: "codex", args: [] },
];
const cliInfo = (name: string) => ({ name, found: true, path: `/usr/bin/${name}`, version: "1.0.0" });

/** Unmounted, like the CLI's usual target: new_tab restores the durable
 *  strip ([1] Claude Code / claude, [2] Codex / codex) before adding. */
function seed() {
  useApp.setState({
    tasks: [task()],
    tabs: {},
    mountedTasks: new Set(),
    agents: AGENTS,
    detectedClis: { claude: cliInfo("claude"), codex: cliInfo("codex") },
  } as never);
  vi.mocked(ipc.taskSetTabs).mockClear();
}

const strip = () => (useApp.getState().tabs.ws1 ?? []) as TerminalTab[];
const tab = (id: string) => strip().find(t => t.id === id)!;
const lastDurable = (): PersistedTab[] => {
  const calls = vi.mocked(ipc.taskSetTabs).mock.calls;
  return calls[calls.length - 1][1] as PersistedTab[];
};

describe("termic tab --title: opening a named tab", () => {
  beforeEach(seed);

  it("names the tab as a rename would: locked, trimmed, and durable", async () => {
    const r = await newTabHandler({ taskId: "ws1", kind: "agent", id: "claude", title: "  reviewer " });
    expect(r.title).toBe("reviewer");
    const t = tab(r.tabId);
    expect(t.title).toBe("reviewer");
    // customTitle is the lock the OSC title path checks; without it the
    // agent's first retitle would replace the name a script keys on.
    expect(t.customTitle).toBe(true);
    const entry = lastDurable().find(p => p.id === r.tabId)!;
    expect(entry).toMatchObject({ title: "reviewer", custom_title: true });
  });

  it("without a title opens exactly as before", async () => {
    const r = await newTabHandler({ taskId: "ws1", kind: "agent", id: "claude" });
    expect(r.title).toBe("Claude Code");
    expect(tab(r.tabId).customTitle).toBeFalsy();
  });

  it("refuses a title another tab already answers to, by title or by cli id", async () => {
    // Checked against the RESTORED strip: before the restore an unopened
    // task looks empty and every title would pass.
    for (const taken of ["Codex", "codex", "CLAUDE CODE", "claude"]) {
      seed();
      await expect(
        newTabHandler({ taskId: "ws1", kind: "shell", title: taken }),
      ).rejects.toThrow(/^cli_tab_title:conflict: tab \[\d\]/);
      // Nothing was added for a refused title.
      expect(strip().some(t => t.cli === "shell")).toBe(false);
    }
  });
});

describe("termic tab --tab X --title Y: renaming an open tab", () => {
  beforeEach(async () => {
    seed();
    // Opening one mounts the task, the state a rename needs.
    await newTabHandler({ taskId: "ws1", kind: "shell", title: "logs" });
    vi.mocked(ipc.taskSetTabs).mockClear();
  });
  const shellId = () => strip().find(t => t.cli === "shell")!.id;

  it("renames and locks the title", async () => {
    await expect(renameTabHandler({ taskId: "ws1", tabId: "second", title: " implementer " }))
      .resolves.toEqual({ title: "implementer" });
    expect(tab("second")).toMatchObject({ title: "implementer", customTitle: true });
    expect(lastDurable().find(p => p.id === "second")).toMatchObject({ title: "implementer", custom_title: true });
  });

  it("\"\" resets to the automatic title, and the old name stops being the tab's", async () => {
    await expect(renameTabHandler({ taskId: "ws1", tabId: shellId(), title: "" }))
      .resolves.toEqual({ title: "Terminal" });
    expect(tab(shellId())).toMatchObject({ title: "Terminal", customTitle: false });
    // A reset of a tab nobody renamed is a no-op, not an error.
    await expect(renameTabHandler({ taskId: "ws1", tabId: "second", title: "" }))
      .resolves.toEqual({ title: "Codex" });
  });

  it("refuses another tab's title or cli id, but not the tab's own", async () => {
    await expect(renameTabHandler({ taskId: "ws1", tabId: "second", title: "LOGS" }))
      .rejects.toThrow(/^cli_tab_title:conflict:/);
    await expect(renameTabHandler({ taskId: "ws1", tabId: shellId(), title: "claude" }))
      .rejects.toThrow(/^cli_tab_title:conflict:/);
    // Its own title or its own cli id is not a clash with anything.
    await expect(renameTabHandler({ taskId: "ws1", tabId: "second", title: "codex" }))
      .resolves.toEqual({ title: "codex" });
    await expect(renameTabHandler({ taskId: "ws1", tabId: shellId(), title: "Logs" }))
      .resolves.toEqual({ title: "Logs" });
  });

  it("renaming to the current title writes nothing", async () => {
    await renameTabHandler({ taskId: "ws1", tabId: "second", title: "impl" });
    vi.mocked(ipc.taskSetTabs).mockClear();
    await renameTabHandler({ taskId: "ws1", tabId: "second", title: "impl" });
    expect(ipc.taskSetTabs).not.toHaveBeenCalled();
  });

  it("answers a vanished tab or a stopped task with typed errors", async () => {
    await expect(renameTabHandler({ taskId: "ws1", tabId: "gone", title: "x" }))
      .rejects.toThrow(/^cli_tab_title:unknown_tab:/);
    useApp.setState({ mountedTasks: new Set() } as never);
    await expect(renameTabHandler({ taskId: "ws1", tabId: "second", title: "x" }))
      .rejects.toThrow(/^cli_tab_title:task_stopped:/);
  });
});
