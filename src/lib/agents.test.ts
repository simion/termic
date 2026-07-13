import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri and IPC before importing the module under test. The real
// implementations talk to the Tauri backend which doesn't exist in tests.
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  projectsList: vi.fn(),
  taskList: vi.fn(),
}));

// useApp is used inside findAgent() to read the agent registry. In unit
// tests we control what the registry contains via this mock.
const mockAgents: import("@/lib/types").Agent[] = [];
vi.mock("@/store/app", () => ({
  useApp: {
    getState: () => ({ agents: mockAgents }),
  },
}));

vi.mock("@/lib/utils", () => ({
  slugify: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
}));

import { spawnArgsForCli, visibleCliIds, cliSupportsIdSession, agentDisplayName, decideResume, isTerminalCli, workDoneCapable, terminalLaunchCommand, classifyAgentTitle, compileSignals, BUILTIN_TITLE_SIGNALS } from "@/lib/agents";
import type { Agent, CliInfo } from "@/lib/types";

// ── spawnArgsForCli ───────────────────────────────────────────────────

describe("spawnArgsForCli", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("returns empty args for a fresh claude spawn (no resume, no yolo)", () => {
    const args = spawnArgsForCli("claude", { yolo: false, resume: false });
    expect(args).toEqual([]);
  });

  it("appends yolo_args when yolo:true", () => {
    const args = spawnArgsForCli("claude", { yolo: true, resume: false });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("appends resume_args (cwd-based) when resume:true and no sessionUuid", () => {
    const args = spawnArgsForCli("claude", { yolo: false, resume: true });
    expect(args).toContain("--continue");
  });

  it("uses session_id_args on first id-based spawn (sessionUuid, not known)", () => {
    const args = spawnArgsForCli("claude", {
      yolo: false,
      resume: false,
      sessionUuid: "abc-123",
      resumeKnown: false,
    });
    expect(args).toContain("--session-id");
    expect(args).toContain("abc-123");
  });

  it("uses resume_id_args on subsequent id-based spawn (sessionUuid, known)", () => {
    const args = spawnArgsForCli("claude", {
      yolo: false,
      resume: false,
      sessionUuid: "abc-123",
      resumeKnown: true,
    });
    expect(args).toContain("--resume");
    expect(args).toContain("abc-123");
  });

  it("includes name_args on every primary-tab spawn (mint and resume)", () => {
    const fakeTask = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420 } as any;
    // Mint (first id-based spawn): name is present.
    const first = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true,
      sessionUuid: "abc-123", resumeKnown: false,
      task: fakeTask,
    });
    expect(first).toContain("--name");
    expect(first).toContain("improve-tests");

    // Resume (subsequent id-based spawn): name is STILL present — claude
    // should show the task name in its prompt header on resume too.
    const second = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true,
      sessionUuid: "abc-123", resumeKnown: true,
      task: fakeTask,
    });
    expect(second).toContain("--name");
    expect(second).toContain("improve-tests");
  });

  it("omits name_args for secondary (+) tabs", () => {
    const fakeTask = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420 } as any;
    // Secondary tabs (isPrimary falsy) start fresh and never carry --name.
    const args = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: false,
      sessionUuid: "abc-123", resumeKnown: false,
      task: fakeTask,
    });
    expect(args).not.toContain("--name");
  });

  it("expands {UUID} placeholder in args", () => {
    const args = spawnArgsForCli("claude", {
      yolo: false, resume: false,
      sessionUuid: "my-uuid-777", resumeKnown: false,
    });
    expect(args).toContain("my-uuid-777");
    expect(args).not.toContain("{UUID}");
  });

  it("codex yolo args contain the bypass flag", () => {
    const args = spawnArgsForCli("codex", { yolo: true, resume: false });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("falls back gracefully for unknown cli", () => {
    const args = spawnArgsForCli("totally-unknown-agent", { yolo: false, resume: false });
    expect(Array.isArray(args)).toBe(true);
    expect(args.length).toBe(0);
  });

  it("uses registry agent over built-in fallback when present", () => {
    mockAgents.push({
      id: "claude",
      command: "my-claude-wrapper",
      display_name: "My Claude",
      args: ["--profile", "custom"],
      capabilities: {
        yolo_args: ["--yes"],
        runtime_yolo_command: "",
        resume_args: [],
        session_id_args: [],
        resume_id_args: [],
        name_args: [],
      },
    } as unknown as Agent);
    const args = spawnArgsForCli("claude", { yolo: true, resume: false });
    expect(args).toContain("--profile");
    expect(args).toContain("--yes");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

// ── decideResume (issue #23: per-tab resume) ──────────────────────────

describe("decideResume", () => {
  // Sensible defaults: a primary, id-capable agent tab in a worktree with
  // no history and no stored uuid. Each test overrides what it exercises.
  const d = (o: Partial<Parameters<typeof decideResume>[0]> = {}) =>
    decideResume({
      isAgent: true,
      idCapable: true,
      isPrimary: true,
      isRepoRoot: false,
      hasResumableHistory: false,
      failedResume: false,
      ...o,
    });

  it("shell / non-agent tabs never resume", () => {
    expect(d({ isAgent: false }).kind).toBe("fresh");
  });

  it("primary tab with a resume override uses it", () => {
    const r = d({ resumeOverride: "--resume {WORKSPACE_NAME}" });
    expect(r).toEqual({ kind: "override", override: "--resume {WORKSPACE_NAME}" });
  });

  it("ignores the override on secondary tabs (falls through to mint)", () => {
    expect(d({ isPrimary: false, resumeOverride: "--resume foo" }).kind).toBe("mint");
  });

  it("blank override is not treated as an override", () => {
    // No history, no uuid → mint (override is whitespace-only).
    expect(d({ resumeOverride: "   " }).kind).toBe("mint");
  });

  // id-capable: per-tab uuid, repo-root AND worktree.
  it("id-capable with a stored uuid resumes by id (repo-root)", () => {
    expect(d({ isRepoRoot: true, storedUuid: "u1" }).kind).toBe("resume-id");
  });

  it("id-capable with a stored uuid resumes by id (worktree too)", () => {
    expect(d({ isRepoRoot: false, storedUuid: "u1" }).kind).toBe("resume-id");
  });

  it("id-capable with no uuid mints a fresh session (repo-root)", () => {
    expect(d({ isRepoRoot: true }).kind).toBe("mint");
  });

  it("id-capable mints fresh on a new worktree (no history)", () => {
    expect(d({ isRepoRoot: false, hasResumableHistory: false }).kind).toBe("mint");
  });

  it("a failed resume forces a fresh mint, skipping the stale uuid", () => {
    expect(d({ isRepoRoot: true, storedUuid: "u1", failedResume: true }).kind).toBe("mint");
  });

  it("secondary id-capable tab mints its OWN session (independent resume)", () => {
    // Two claude tabs: the secondary doesn't share the primary's session.
    expect(d({ isPrimary: false, storedUuid: undefined }).kind).toBe("mint");
    expect(d({ isPrimary: false, storedUuid: "u2" }).kind).toBe("resume-id");
  });

  // Legacy worktree main tab: had a --continue conversation before per-tab
  // uuids existed → preserve it rather than orphaning it with a fresh mint.
  it("legacy worktree primary (history, no uuid) keeps cwd --continue", () => {
    expect(d({ isRepoRoot: false, isPrimary: true, hasResumableHistory: true, storedUuid: undefined }).kind)
      .toBe("cwd-resume");
  });

  it("legacy-continue does NOT apply to secondary id-capable tabs (they mint)", () => {
    expect(d({ isRepoRoot: false, isPrimary: false, hasResumableHistory: true }).kind).toBe("mint");
  });

  // cwd-only agents (codex): primary resumes, secondary starts fresh.
  it("cwd-only agent resumes on the primary worktree tab with history", () => {
    expect(d({ idCapable: false, isPrimary: true, hasResumableHistory: true }).kind).toBe("cwd-resume");
  });

  it("cwd-only secondary tab starts fresh (can't address a past session)", () => {
    expect(d({ idCapable: false, isPrimary: false, hasResumableHistory: true }).kind).toBe("fresh");
  });

  it("cwd-only agent in repo-root never resumes (shared cwd lasso)", () => {
    expect(d({ idCapable: false, isRepoRoot: true, isPrimary: true, hasResumableHistory: true }).kind)
      .toBe("fresh");
  });

  it("cwd-only worktree primary with no history starts fresh", () => {
    expect(d({ idCapable: false, isPrimary: true, hasResumableHistory: false }).kind).toBe("fresh");
  });

  it("cwd-resume is suppressed right after a failed resume", () => {
    expect(d({ idCapable: false, isPrimary: true, hasResumableHistory: true, failedResume: true }).kind)
      .toBe("fresh");
  });
});

// ── visibleCliIds ─────────────────────────────────────────────────────

describe("visibleCliIds", () => {
  const makeAgent = (id: string, disabled = false): Agent =>
    ({ id, disabled, command: id, display_name: id, args: [] }) as unknown as Agent;

  it("returns all candidates when detected map is empty (pre-detection)", () => {
    const agents = [makeAgent("claude"), makeAgent("opencode")];
    const result = visibleCliIds(["claude", "opencode"], agents, {});
    expect(result).toEqual(new Set(["claude", "opencode"]));
  });

  it("hides disabled agents regardless of detection", () => {
    const agents = [makeAgent("claude", true), makeAgent("opencode")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: true, path: "/usr/local/bin/claude", version: "1.0" },
      opencode: { name: "opencode", found: true, path: "/usr/local/bin/opencode", version: "1.0" },
    };
    const result = visibleCliIds(["claude", "opencode"], agents, detected);
    expect(result.has("claude")).toBe(false);
    expect(result.has("opencode")).toBe(true);
  });

  it("hides uninstalled agents when detection resolves", () => {
    const agents = [makeAgent("claude"), makeAgent("opencode")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: true, path: "/usr/local/bin/claude", version: "1.0" },
      opencode: { name: "opencode", found: false, path: "", version: "" },
    };
    const result = visibleCliIds(["claude", "opencode"], agents, detected);
    expect(result.has("opencode")).toBe(false);
    expect(result.has("claude")).toBe(true);
  });

  it("falls back to full enabled set if filtering would empty the picker", () => {
    // All agents not-found: rather than empty picker, show all enabled ones.
    const agents = [makeAgent("claude"), makeAgent("opencode")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: false, path: "", version: "" },
      opencode: { name: "opencode", found: false, path: "", version: "" },
    };
    const result = visibleCliIds(["claude", "opencode"], agents, detected);
    expect(result.size).toBeGreaterThan(0);
  });

  it("agents not in detected map default to visible", () => {
    const agents = [makeAgent("claude"), makeAgent("custom-agent")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: true, path: "/usr/local/bin/claude", version: "1.0" },
      // custom-agent is absent → defaults to visible
    };
    const result = visibleCliIds(["claude", "custom-agent"], agents, detected);
    expect(result.has("custom-agent")).toBe(true);
  });

  it("excludes terminal-kind entries (they belong to the New terminal section)", () => {
    const agents = [makeAgent("claude"), { ...makeAgent("devcontainer"), kind: "terminal" } as Agent];
    const result = visibleCliIds(["claude", "devcontainer"], agents, {});
    expect(result.has("devcontainer")).toBe(false);
    expect(result.has("claude")).toBe(true);
  });
});

// ── custom terminals (#27) ────────────────────────────────────────────

describe("custom terminals", () => {
  beforeEach(() => { mockAgents.length = 0; });

  const termEntry = (over: Partial<Agent> = {}): Agent => ({
    id: "devcontainer", display_name: "devcontainer", command: "docker",
    args: ["exec", "-it", "-w", "{WORKSPACE_PATH}", "mybox", "zsh"],
    icon_id: "lucide:terminal", color: "#9aa0a6", builtin: false,
    kind: "terminal", ...over,
  } as Agent);
  const fakeTask = {
    id: "ws1", name: "Improve Tests", branch: "main", port: 1420,
    path: "/repos/proj/.worktrees/improve-tests",
  } as any;

  it("isTerminalCli: shell/custom sentinels and terminal-kind entries are terminals", () => {
    mockAgents.push(termEntry());
    expect(isTerminalCli("shell", mockAgents)).toBe(true);
    expect(isTerminalCli("custom", mockAgents)).toBe(true);
    expect(isTerminalCli("devcontainer", mockAgents)).toBe(true);
    expect(isTerminalCli("claude", mockAgents)).toBe(false);
  });

  it("workDoneCapable: terminal-kind entries never qualify, even with work_done true", () => {
    mockAgents.push(termEntry({ work_done: true }));
    expect(workDoneCapable("devcontainer", mockAgents)).toBe(false);
  });

  it("terminalLaunchCommand joins command + args and expands placeholders", () => {
    mockAgents.push(termEntry());
    expect(terminalLaunchCommand("devcontainer", fakeTask)).toBe(
      "docker exec -it -w /repos/proj/.worktrees/improve-tests mybox zsh",
    );
  });

  it("terminalLaunchCommand returns undefined for an empty command (plain shell)", () => {
    mockAgents.push(termEntry({ command: "", args: [] }));
    expect(terminalLaunchCommand("devcontainer", fakeTask)).toBeUndefined();
  });

  it("terminalLaunchCommand shell-quotes expanded values with spaces or metachars", () => {
    mockAgents.push(termEntry());
    const task = { ...fakeTask, path: "/Users/x/My Projects/repo" };
    expect(terminalLaunchCommand("devcontainer", task)).toBe(
      "docker exec -it -w '/Users/x/My Projects/repo' mybox zsh",
    );
    // A name with a single quote must not break out of the quoting.
    mockAgents.length = 0;
    mockAgents.push(termEntry({ args: ["{WORKSPACE_NAME}"] }));
    const taskQuote = { ...fakeTask, name: "it's a test" };
    expect(terminalLaunchCommand("devcontainer", taskQuote)).toBe(
      `docker 'it'\\''s a test'`,
    );
  });
});

// ── cliSupportsIdSession ──────────────────────────────────────────────

describe("cliSupportsIdSession", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("claude supports id sessions (built-in fallback)", () => {
    expect(cliSupportsIdSession("claude")).toBe(true);
  });

  it("codex does NOT support id sessions (no session_id_args in fallback)", () => {
    expect(cliSupportsIdSession("codex")).toBe(false);
  });

  it("unknown agent does NOT support id sessions", () => {
    expect(cliSupportsIdSession("some-random-cli")).toBe(false);
  });
});

// ── agentDisplayName ──────────────────────────────────────────────────

describe("agentDisplayName", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("returns display_name from registry when agent is present", () => {
    mockAgents.push({
      id: "my-agent", display_name: "My Agent", command: "myagent",
      args: [], icon_id: "lucide:star", color: "#000", builtin: false,
    });
    expect(agentDisplayName("my-agent")).toBe("My Agent");
  });

  it("returns built-in name for known CLIs when registry is empty", () => {
    const cases: [string, string][] = [
      ["claude", "Claude"], ["codex", "Codex"],
      ["agy", "Antigravity"], ["shell", "Terminal"], ["custom", "Command"],
    ];
    for (const [cli, name] of cases) {
      expect(agentDisplayName(cli, [])).toBe(name);
    }
  });

  it("returns the id for an unknown CLI not in registry", () => {
    expect(agentDisplayName("unknown-cli", [])).toBe("unknown-cli");
  });
});

// ── classifyAgentTitle (issue #68) ────────────────────────────────────

const sigAgent = (id: string, signals: NonNullable<Agent["capabilities"]>["signals"]): Agent => ({
  id, display_name: id, command: id, args: [],
  icon_id: "lucide:bot", color: "#888", builtin: false,
  capabilities: { signals },
} as Agent);

describe("classifyAgentTitle", () => {
  it("keeps the built-in claude classifier when no signals are set", () => {
    expect(classifyAgentTitle("claude", "✳ Ready", [])).toBe("idle");
    expect(classifyAgentTitle("claude", "⠋ thinking", [])).toBe("busy");
    expect(classifyAgentTitle("claude", "   ", [])).toBe(null);
  });

  it("keeps the built-in codex classifier when no signals are set", () => {
    expect(classifyAgentTitle("codex", "Action Required", [])).toBe("attention");
    expect(classifyAgentTitle("codex", "Ready", [])).toBe("idle");
    expect(classifyAgentTitle("codex", "Working", [])).toBe("busy");
  });

  it("registry signals drive a custom agent's classification", () => {
    const a = sigAgent("mycli", { busy: ["WORKING"], idle: ["✓ done"], attention: ["NEEDS INPUT"] });
    expect(classifyAgentTitle("mycli", "WORKING on it", [a])).toBe("busy");
    expect(classifyAgentTitle("mycli", "✓ done", [a])).toBe("idle");
    expect(classifyAgentTitle("mycli", "NEEDS INPUT", [a])).toBe("attention");
    expect(classifyAgentTitle("mycli", "nothing matches", [a])).toBe(null);
  });

  it("applies precedence attention > busy > idle when several patterns match", () => {
    const all = sigAgent("mycli", { busy: ["X"], idle: ["X"], attention: ["X"] });
    expect(classifyAgentTitle("mycli", "X", [all])).toBe("attention");
    const bi = sigAgent("mycli", { busy: ["Y"], idle: ["Y"] });
    expect(classifyAgentTitle("mycli", "Y", [bi])).toBe("busy");
  });

  it("lets registry signals override the built-in claude/codex heuristics", () => {
    const a = sigAgent("claude", { idle: ["FINISHED"] });
    expect(classifyAgentTitle("claude", "✳ Ready", [a])).toBe(null);
    expect(classifyAgentTitle("claude", "FINISHED", [a])).toBe("idle");
  });

  it("skips an invalid regex instead of throwing", () => {
    const a = sigAgent("mycli", { busy: ["(unclosed"], idle: ["ok"] });
    expect(() => classifyAgentTitle("mycli", "ok", [a])).not.toThrow();
    expect(classifyAgentTitle("mycli", "ok", [a])).toBe("idle");
    expect(classifyAgentTitle("mycli", "(unclosed", [a])).toBe(null);
  });

  it("falls back to built-in when signals are all empty; unknown cli is null", () => {
    const a = sigAgent("mycli", { busy: [], idle: [], attention: [] });
    expect(classifyAgentTitle("mycli", "anything", [a])).toBe(null);
    expect(classifyAgentTitle("unknown", "anything", [])).toBe(null);
  });
});

describe("BUILTIN_TITLE_SIGNALS", () => {
  // Settings shows these as the placeholder for an empty field, so a user can
  // copy them out and tweak one line. If pasting them back in changed the
  // agent's behaviour, the placeholder would be a lie. Watch claude's busy
  // pattern especially: user signals run busy BEFORE idle, so an unqualified
  // "leading non-alphanumeric" busy test would swallow claude's own ✳ done
  // glyph, and every finished turn would read as still working.
  for (const cli of ["claude", "codex"]) {
    it(`pasting ${cli}'s placeholders back in classifies identically`, () => {
      const pasted = sigAgent(cli, BUILTIN_TITLE_SIGNALS[cli]);
      const titles = [
        "✳ Ready", "⠋ thinking", "⠐ ⠂ Task", "Ready", "Working", "Thinking",
        "Action Required", "Waiting for approval", "plain title", "",
      ];
      for (const t of titles) {
        expect(classifyAgentTitle(cli, t, [pasted])).toBe(classifyAgentTitle(cli, t, []));
      }
    });
  }
});

// ── compileSignals ────────────────────────────────────────────────────

describe("compileSignals", () => {
  it("reuses the compiled regex for a repeated source", () => {
    // The title path recompiles once per spinner frame without this.
    const [a] = compileSignals(["^Working"]);
    const [b] = compileSignals(["^Working"]);
    expect(a).toBe(b);
  });

  it("drops invalid sources and empty strings, keeping the rest", () => {
    expect(compileSignals(["(unclosed", "", "ok"]).map(r => r.source)).toEqual(["ok"]);
    expect(compileSignals(undefined)).toEqual([]);
  });

  it("returns stateless regexes — a match does not consume the next call", () => {
    // A cached /g regex would carry lastIndex across terminals. These aren't
    // global, so the same instance must keep matching.
    const [re] = compileSignals(["done"]);
    expect(re.test("done")).toBe(true);
    expect(re.test("done")).toBe(true);
  });
});
