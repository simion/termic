import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri and IPC before importing the module under test. The real
// implementations talk to the Tauri backend which doesn't exist in tests.
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  projectsList: vi.fn(),
  workspaceList: vi.fn(),
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

import { spawnArgsForCli, visibleCliIds, cliSupportsIdSession, agentDisplayName } from "@/lib/agents";
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
    const fakeWs = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420 } as any;
    // Mint (first id-based spawn): name is present.
    const first = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true,
      sessionUuid: "abc-123", resumeKnown: false,
      ws: fakeWs,
    });
    expect(first).toContain("--name");
    expect(first).toContain("improve-tests");

    // Resume (subsequent id-based spawn): name is STILL present — claude
    // should show the workspace name in its prompt header on resume too.
    const second = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true,
      sessionUuid: "abc-123", resumeKnown: true,
      ws: fakeWs,
    });
    expect(second).toContain("--name");
    expect(second).toContain("improve-tests");
  });

  it("omits name_args for secondary (+) tabs", () => {
    const fakeWs = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420 } as any;
    // Secondary tabs (isPrimary falsy) start fresh and never carry --name.
    const args = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: false,
      sessionUuid: "abc-123", resumeKnown: false,
      ws: fakeWs,
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

// ── visibleCliIds ─────────────────────────────────────────────────────

describe("visibleCliIds", () => {
  const makeAgent = (id: string, disabled = false): Agent =>
    ({ id, disabled, command: id, display_name: id, args: [] }) as unknown as Agent;

  it("returns all candidates when detected map is empty (pre-detection)", () => {
    const agents = [makeAgent("claude"), makeAgent("gemini")];
    const result = visibleCliIds(["claude", "gemini"], agents, {});
    expect(result).toEqual(new Set(["claude", "gemini"]));
  });

  it("hides disabled agents regardless of detection", () => {
    const agents = [makeAgent("claude", true), makeAgent("gemini")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: true, path: "/usr/local/bin/claude", version: "1.0" },
      gemini: { name: "gemini", found: true, path: "/usr/local/bin/gemini", version: "1.0" },
    };
    const result = visibleCliIds(["claude", "gemini"], agents, detected);
    expect(result.has("claude")).toBe(false);
    expect(result.has("gemini")).toBe(true);
  });

  it("hides uninstalled agents when detection resolves", () => {
    const agents = [makeAgent("claude"), makeAgent("gemini")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: true, path: "/usr/local/bin/claude", version: "1.0" },
      gemini: { name: "gemini", found: false, path: "", version: "" },
    };
    const result = visibleCliIds(["claude", "gemini"], agents, detected);
    expect(result.has("gemini")).toBe(false);
    expect(result.has("claude")).toBe(true);
  });

  it("falls back to full enabled set if filtering would empty the picker", () => {
    // All agents not-found: rather than empty picker, show all enabled ones.
    const agents = [makeAgent("claude"), makeAgent("gemini")];
    const detected: Record<string, CliInfo> = {
      claude: { name: "claude", found: false, path: "", version: "" },
      gemini: { name: "gemini", found: false, path: "", version: "" },
    };
    const result = visibleCliIds(["claude", "gemini"], agents, detected);
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
});

// ── cliSupportsIdSession ──────────────────────────────────────────────

describe("cliSupportsIdSession", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("claude supports id sessions (built-in fallback)", () => {
    expect(cliSupportsIdSession("claude")).toBe(true);
  });

  it("gemini supports id sessions (built-in fallback)", () => {
    expect(cliSupportsIdSession("gemini")).toBe(true);
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
      ["claude", "Claude"], ["gemini", "Gemini"], ["codex", "Codex"],
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
