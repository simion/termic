import { describe, it, expect, vi, beforeEach } from "vitest";

const ptyKill = vi.fn(async (_id: string) => {});
vi.mock("@/lib/ipc", () => ({
  repoConfigLoad: vi.fn(async () => null),
  repoConfigLoadAt: vi.fn(async () => null),
  ptyKill: (id: string) => ptyKill(id),
}));

// The slice of the app store `termic run` reads and drives.
const state = {
  tasks: [] as Array<Record<string, unknown>>,
  projects: [] as Array<Record<string, unknown>>,
  tabs: {} as Record<string, Array<Record<string, unknown>>>,
  mountedTasks: new Set<string>(),
  loadAll: vi.fn(async () => {}),
  ensureDefaultTab: vi.fn(),
  mountTasks: vi.fn((ids: string[]) => ids.forEach(id => state.mountedTasks.add(id))),
  addTabToActivePane: vi.fn((taskId: string, tab: Record<string, unknown>) => {
    (state.tabs[taskId] ??= []).push(tab);
  }),
};
vi.mock("@/store/app", () => ({ useApp: { getState: () => state } }));
vi.mock("@/store/ui", () => ({ useUI: { getState: () => ({ pushToast: vi.fn() }) } }));
// The project's named run commands (the Run button's dropdown).
let customCmds: Array<{ label: string; command: string; source: "personal" | "yaml" }> = [];
vi.mock("@/lib/runCommands", async (orig) => ({
  ...(await orig<typeof import("@/lib/runCommands")>()),
  resolveCustomCommands: async () => customCmds,
}));

import { runScriptRpc } from "@/lib/runTabs";

const runTab = (over: Record<string, unknown> = {}) => ({
  id: "run-1", type: "terminal", title: "Run", cli: "custom", command: "npm run dev",
  runTab: { member: "", previewUrl: null }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.tasks = [{ id: "t1", name: "fix-x", project_id: "p1", cli: "claude", path: "/w/fix-x" }];
  state.projects = [{ id: "p1", name: "web", run_script: "npm run dev", setup_script: "" }];
  state.tabs = { t1: [{ id: "agent", type: "terminal", cli: "claude" }] };
  state.mountedTasks = new Set(["t1"]);
  customCmds = [];
});

describe("runScriptRpc", () => {
  it("starts the run script in a new, unfocused Run tab", async () => {
    const r = await runScriptRpc({ taskId: "t1", which: "run", action: "start" });
    expect(state.addTabToActivePane).toHaveBeenCalledTimes(1);
    const [, tab, opts] = state.addTabToActivePane.mock.calls[0] as unknown as [string, Record<string, unknown>, unknown];
    expect(tab.command).toBe("npm run dev");
    expect(opts).toEqual({ focus: false });
    expect(r.targets).toEqual([
      { member: "", script: "npm run dev", tab_id: tab.id, running: true, outcome: "started" },
    ]);
  });

  // The dev server the user is looking at must survive an agent asking for it.
  it("leaves a running script alone", async () => {
    state.tabs.t1.push(runTab({ ptyId: "pty-9" }));
    const r = await runScriptRpc({ taskId: "t1", which: "run", action: "start" });
    expect(state.addTabToActivePane).not.toHaveBeenCalled();
    expect(r.targets[0]).toMatchObject({ tab_id: "run-1", running: true, outcome: "already_running" });
  });

  it("stops a running script and reports one that was not running", async () => {
    state.tabs.t1.push(runTab({ ptyId: "pty-9" }));
    const r = await runScriptRpc({ taskId: "t1", which: "run", action: "stop" });
    expect(ptyKill).toHaveBeenCalledWith("pty-9");
    expect(r.targets[0]).toMatchObject({ running: false, outcome: "stopped" });

    state.tabs.t1.pop();
    const again = await runScriptRpc({ taskId: "t1", which: "run", action: "stop" });
    expect(again.targets[0].outcome).toBe("not_running");
  });

  it("reports what is configured without starting anything", async () => {
    const r = await runScriptRpc({ taskId: "t1", which: "run", action: "status" });
    expect(r.targets).toEqual([{ member: "", script: "npm run dev", tab_id: null, running: false }]);
    expect(state.addTabToActivePane).not.toHaveBeenCalled();
    expect(state.mountTasks).not.toHaveBeenCalled();
  });

  // status answers "is there one?" with an empty list; start is told why not.
  it("refuses to start a script that is not configured, but status says so quietly", async () => {
    state.projects[0].run_script = "";
    expect((await runScriptRpc({ taskId: "t1", which: "run", action: "status" })).targets).toEqual([]);
    await expect(runScriptRpc({ taskId: "t1", which: "run", action: "start" }))
      .rejects.toThrow("fix-x has no run script configured");
    await expect(runScriptRpc({ taskId: "t1", which: "setup", action: "start" }))
      .rejects.toThrow("no setup script configured");
  });

  it("starts the setup script in the setup tab", async () => {
    state.projects[0].setup_script = "npm ci";
    const r = await runScriptRpc({ taskId: "t1", which: "setup", action: "start" });
    const [, tab] = state.addTabToActivePane.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(tab.command).toBe("npm ci");
    expect(tab.runTab).toMatchObject({ kind: "setup" });
    expect(r).toMatchObject({ which: "setup", targets: [{ script: "npm ci", outcome: "started" }] });
  });

  // Mounting a stopped task respawns every agent in it.
  it("refuses a stopped task instead of respawning its agents", async () => {
    state.mountedTasks = new Set();
    await expect(runScriptRpc({ taskId: "t1", which: "run", action: "start" })).rejects.toThrow("is stopped");
    expect(state.mountTasks).not.toHaveBeenCalled();
  });

  it("names the configured members when asked for one that has no script", async () => {
    await expect(runScriptRpc({ taskId: "t1", which: "run", action: "start", member: "api" }))
      .rejects.toThrow("no run script for member api (configured: (host))");
    await expect(runScriptRpc({ taskId: "t1", which: "setup", action: "start", member: "api" }))
      .rejects.toThrow("--member applies to the run script only");
  });

  it("refuses an archived task", async () => {
    state.tasks[0].archived = true;
    await expect(runScriptRpc({ taskId: "t1", which: "run", action: "status" })).rejects.toThrow("archived");
  });

  describe("a named run command (--script)", () => {
    beforeEach(() => {
      customCmds = [
        { label: "Storybook", command: "npm run storybook", source: "yaml" },
        { label: "", command: "npm run worker", source: "personal" },
      ];
    });

    it("starts it by label, case-insensitively, in its own Run tab", async () => {
      const r = await runScriptRpc({ taskId: "t1", which: "run", action: "start", script: "storybook" });
      const [, tab] = state.addTabToActivePane.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(tab.command).toBe("npm run storybook");
      expect(tab.runTab).toMatchObject({ member: "label:Storybook" });
      expect(r).toMatchObject({ which: "script", targets: [{ label: "Storybook", script: "npm run storybook", outcome: "started" }] });
    });

    it("finds one with no label by its command, and leaves a running one alone", async () => {
      state.tabs.t1.push(runTab({ id: "w-1", command: "npm run worker", runTab: { member: "cmd:npm run worker", previewUrl: null }, ptyId: "pty-w" }));
      const r = await runScriptRpc({ taskId: "t1", which: "run", action: "start", script: "npm run worker" });
      expect(state.addTabToActivePane).not.toHaveBeenCalled();
      expect(r.targets[0]).toMatchObject({ tab_id: "w-1", running: true, outcome: "already_running" });
      const stopped = await runScriptRpc({ taskId: "t1", which: "run", action: "stop", script: "npm run worker" });
      expect(ptyKill).toHaveBeenCalledWith("pty-w");
      expect(stopped.targets[0].outcome).toBe("stopped");
    });

    it("names what is configured when the label matches none", async () => {
      await expect(runScriptRpc({ taskId: "t1", which: "run", action: "start", script: "nope" }))
        .rejects.toThrow('no run command named "nope" (configured: Storybook, npm run worker)');
    });

    it("status lists the named commands beside the run script", async () => {
      const r = await runScriptRpc({ taskId: "t1", which: "run", action: "status" });
      expect(r.scripts).toEqual([
        { label: "Storybook", command: "npm run storybook", running: false, tab_id: null },
        { label: "npm run worker", command: "npm run worker", running: false, tab_id: null },
      ]);
    });

    it("with no run script, start points at the named commands", async () => {
      state.projects[0].run_script = "";
      await expect(runScriptRpc({ taskId: "t1", which: "run", action: "start" }))
        .rejects.toThrow("has named run commands: Storybook, npm run worker (pass one as --script)");
    });
  });
});
