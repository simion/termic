import { i18n } from "@/lib/i18n";
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

import { resumeIdArgsForCli, resumePickerArgsForCli, cliSupportsCaptureResume, postLaunchCaptureForCli, spawnArgsForCli, defaultCliFirst, visibleCliIds, cliSupportsIdSession, cliSupportsResumeById, agentDisplayName, decideResume, spawnResumeShape, isTerminalCli, workDoneCapable, terminalLaunchCommand, classifyAgentTitle, compileSignals, BUILTIN_TITLE_SIGNALS, BUILTIN_OUTPUT_SIGNALS, builtinBaseId, YOLO_ARGS_NOTES, yoloArgsNote, resolveAgent, agentOverrides, hasPendingWork, notificationWantsAttention, PENDING_TAIL_ROWS } from "@/lib/agents";
import type { Agent, CliInfo } from "@/lib/types";
import type { ResumeDecision } from "@/lib/agents";

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

  // copilot refuses `--name` on any resume and exits 1, which termic read as
  // "resume failed" and answered with a fresh session every relaunch.
  it("names a copilot session only when it is created, never on a resume", () => {
    mockAgents.push({
      id: "copilot", display_name: "copilot", command: "copilot", args: [], builtin: true,
      capabilities: {
        yolo_args: [], runtime_yolo_command: "",
        resume_args: ["--continue"],
        session_id_args: ["--session-id", "{UUID}"],
        resume_id_args: ["--session-id", "{UUID}"],
        name_args: ["--name", "{WORKSPACE_SLUG}"],
      },
    } as any);
    const fakeTask = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420 } as any;
    const base = { yolo: false, isPrimary: true, task: fakeTask };
    // The mint: a brand-new session, so the name goes on.
    expect(spawnArgsForCli("copilot", { ...base, resume: false, sessionUuid: "u1", resumeKnown: false }))
      .toEqual(["--session-id", "u1", "--name", "improve-tests"]);
    // Resuming that id: no name, or copilot refuses to start.
    expect(spawnArgsForCli("copilot", { ...base, resume: false, sessionUuid: "u1", resumeKnown: true }))
      .toEqual(["--session-id", "u1"]);
    // The worktree resume: same refusal with --continue.
    expect(spawnArgsForCli("copilot", { ...base, resume: true })).toEqual(["--continue"]);
    // A fresh worktree spawn with nothing to resume is a new session.
    expect(spawnArgsForCli("copilot", { ...base, resume: false })).toEqual(["--name", "improve-tests"]);
  });

  it("omits name_args when a resumeOverride is active", () => {
    const fakeTask = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420 } as any;
    // A verbatim --resume override targets the session by name; renaming it
    // via --name on every relaunch would break the next override's lookup.
    const args = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true,
      task: fakeTask, resumeOverride: "--resume {WORKSPACE_NAME}",
    });
    expect(args).not.toContain("--name");
    expect(args).toContain("--resume");
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

  it("unattended codex spawns suppress the update check, before the resume subcommand", () => {
    const args = spawnArgsForCli("codex", { yolo: false, resume: true, unattended: true });
    const flag = args.indexOf("-c");
    expect(args[flag + 1]).toBe("check_for_update_on_startup=false");
    // `-c` is a root-binary global; it must precede `resume --last`.
    expect(flag).toBeLessThan(args.indexOf("resume"));
  });

  it("attended spawns keep the CLI's normal update behavior", () => {
    expect(spawnArgsForCli("codex", { yolo: false, resume: false })).not.toContain("-c");
    expect(spawnArgsForCli("grok", { yolo: false, resume: false })).not.toContain("--no-auto-update");
  });

  it("unattended grok spawns pass --no-auto-update", () => {
    expect(spawnArgsForCli("grok", { yolo: false, resume: false, unattended: true }))
      .toContain("--no-auto-update");
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

  it("places task args after Settings defaults and before runtime args", () => {
    mockAgents.push({
      id: "codex",
      command: "codex",
      display_name: "Codex",
      args: ["--model", "default"],
      capabilities: {
        yolo_args: ["--dangerous"],
        runtime_yolo_command: "",
        resume_args: ["resume", "--last"],
      },
    } as unknown as Agent);
    const task = {
      id: "t1", cli: "codex", name: "Worker", branch: "worker", port: 18100,
      agent_args: ["--effort", "low", "--model", "worker"],
    } as unknown as import("@/lib/types").Task;

    expect(spawnArgsForCli("codex", {
      yolo: true, resume: true, isPrimary: true, task,
    })).toEqual([
      "--model", "default",
      "--effort", "low", "--model", "worker",
      "resume", "--last",
      "--dangerous",
    ]);
  });

  it("does not leak task args into secondary or different-agent tabs", () => {
    const task = {
      id: "t1", cli: "codex", name: "Worker", branch: "worker", port: 18100,
      agent_args: ["--model", "worker"],
    } as unknown as import("@/lib/types").Task;

    expect(spawnArgsForCli("codex", {
      yolo: false, resume: false, isPrimary: false, task,
    })).not.toContain("worker");
    expect(spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true, task,
    })).not.toContain("--model");
  });
});

// ── spawnResumeShape (GH #291: codex "already has an active writer") ──
//
// Two guards in TerminalPane used to read `decideResume`'s verdict directly,
// and a capture-resume agent's resume is not in that verdict: codex and
// opencode have `resume_id_args` but no `session_id_args`, so
// `cliSupportsIdSession` is false and `decideResume` can NEVER return
// "resume-id" for them. Their `codex resume <uuid>` is composed separately
// from the uuid the SessionStart hook captured.
//
// Reproduced against codex 0.153.4: a second Codex on the same thread exits
// rc=1 in 405-512 ms with "thread <id> already has an active writer", well
// inside RESUME_FAILURE_MS (2000). The exit was the signal and both guards
// dropped it, so the tab silently started a fresh session on every spawn and
// never said why, which is what made clicking R look like it did nothing.
describe("spawnResumeShape", () => {
  const shape = (kind: ResumeDecision["kind"], captureResumeOverride?: string) =>
    spawnResumeShape({
      decision: kind === "override"
        ? { kind, override: "--resume x" }
        : { kind } as ResumeDecision,
      captureResumeOverride,
    });

  it("counts a capture-resume spawn as a resume, whatever decideResume said", () => {
    // THE regression. A codex tab whose worktree has no `has_resumable_history`
    // still resumes by its stored uuid, and decideResume calls that "fresh".
    // `lastSpawnWasResumeRef` was false, so the fast-exit recovery never ran.
    expect(shape("fresh", "resume abc").isResume).toBe(true);
    expect(shape("cwd-resume", "resume abc").isResume).toBe(true);
  });

  it("knows a capture-resume spawn used a STORED id", () => {
    // The other half: the "that id did not resolve, drop it and say so"
    // branch was gated on kind === "resume-id", which codex cannot produce.
    expect(shape("fresh", "resume abc").usedStoredSessionId).toBe(true);
    expect(shape("resume-id").usedStoredSessionId).toBe(true);
  });

  it("still treats the id-capable agents exactly as before", () => {
    expect(shape("resume-id")).toEqual({ isResume: true, usedStoredSessionId: true });
    expect(shape("cwd-resume")).toEqual({ isResume: true, usedStoredSessionId: false });
    expect(shape("mint")).toEqual({ isResume: false, usedStoredSessionId: false });
    expect(shape("fresh")).toEqual({ isResume: false, usedStoredSessionId: false });
  });

  it("leaves a user-typed resume override alone", () => {
    // They asked for that specific thing. Retrying fresh behind their back
    // would ignore them, so an override is not a resume for this purpose.
    expect(shape("override")).toEqual({ isResume: false, usedStoredSessionId: false });
  });

  it("a cwd-resume failure does not drop a stored id it never used", () => {
    // `codex resume --last` addresses no id, so there is nothing to clear:
    // clearing would throw away a pointer the failure said nothing about.
    expect(shape("cwd-resume").usedStoredSessionId).toBe(false);
  });

  it("is inert once the previous resume already failed", () => {
    // TerminalPane stops composing captureResumeOverride after a failed
    // resume, so the retry is a fresh spawn and must not be read as one more
    // resume attempt — that is what stops the respawn loop.
    expect(shape("fresh", undefined)).toEqual({ isResume: false, usedStoredSessionId: false });
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
      runsTaskAgent: true,
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

  // A "+" tab running a DIFFERENT agent is still the first tab of its own
  // cli, so `isPrimary` is true for it. The task's override belongs to the
  // task's own agent and is written in that agent's flag spelling: claude's
  // `--resume <name>` handed to codex is `unexpected argument '--resume'`,
  // and the tab died on argv before it drew a frame, on every retry.
  it("ignores the override on a tab running a DIFFERENT agent than the task", () => {
    // Worktree with history: codex's own correct answer is `resume --last`.
    expect(d({
      idCapable: false, runsTaskAgent: false, hasResumableHistory: true,
      resumeOverride: "--resume {WORKSPACE_NAME}",
    }).kind).toBe("cwd-resume");
  });

  it("a second agent with no history of its own starts fresh, not overridden", () => {
    expect(d({
      idCapable: false, runsTaskAgent: false, hasResumableHistory: false,
      resumeOverride: "--resume {WORKSPACE_NAME}",
    }).kind).toBe("fresh");
  });

  it("an id-capable second agent mints its own session instead of overriding", () => {
    expect(d({ runsTaskAgent: false, resumeOverride: "--resume foo" }).kind).toBe("mint");
    expect(d({ runsTaskAgent: false, storedUuid: "u2", resumeOverride: "--resume foo" }).kind)
      .toBe("resume-id");
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

// pi (pi.dev) resume, both task shapes. Verified against a live pi 0.84.3
// before these were written, because the flag contract is unusual:
// `--session-id` MINTS when the id is unknown and RESUMES when it is known, so
// the mint and resume arg lists are identical on purpose.
//
// The main-checkout case is the one that needed proving. pi scopes sessions per
// DIRECTORY, so two repo-root tasks share a session directory; measured, two
// ids in one cwd stay separate (one answered "alpha", the other "bravo") while
// `--continue` in that same cwd returned the most recent, i.e. the wrong task's
// conversation. That is exactly why repo-root goes id-based and never cwd-based.
describe("pi resume", () => {
  beforeEach(() => { mockAgents.length = 0; });
  const args = (o: Parameters<typeof spawnArgsForCli>[1]) => spawnArgsForCli("pi", o);
  const d = (o: Partial<Parameters<typeof decideResume>[0]> = {}) =>
    decideResume({
      isAgent: true, idCapable: true, isPrimary: true, runsTaskAgent: true,
      isRepoRoot: false, hasResumableHistory: false, failedResume: false, ...o,
    });

  it("mints with --session-id on a first spawn", () => {
    const a = args({ yolo: false, resume: false, sessionUuid: "u-1", resumeKnown: false });
    expect(a).toEqual(expect.arrayContaining(["--session-id", "u-1"]));
  });

  it("resumes with the SAME flag, because --session-id creates if missing", () => {
    const a = args({ yolo: false, resume: false, sessionUuid: "u-1", resumeKnown: true });
    expect(a).toEqual(expect.arrayContaining(["--session-id", "u-1"]));
    // Not claude's second flag: pi has no --resume <id> that takes an argument.
    expect(a).not.toContain("--resume");
  });

  it("two repo-root tasks get DIFFERENT ids, which is what keeps them apart", () => {
    const one = args({ yolo: false, resume: false, sessionUuid: "u-1", resumeKnown: true });
    const two = args({ yolo: false, resume: false, sessionUuid: "u-2", resumeKnown: true });
    expect(one).toContain("u-1");
    expect(two).toContain("u-2");
  });

  it("falls back to --continue for a legacy worktree task with no minted id", () => {
    expect(args({ yolo: false, resume: true })).toContain("--continue");
  });

  it("is id-capable, so repo-root tasks never take the cwd-resume path", () => {
    expect(cliSupportsIdSession("pi")).toBe(true);
    expect(d({ idCapable: true, isRepoRoot: true, isPrimary: true, hasResumableHistory: true }).kind)
      .toBe("mint");
    expect(d({ idCapable: true, isRepoRoot: true, isPrimary: true, storedUuid: "u-1" }).kind)
      .toBe("resume-id");
  });

  it("keeps a pre-uuid worktree task on --continue rather than orphaning it", () => {
    expect(d({ idCapable: true, isRepoRoot: false, isPrimary: true, hasResumableHistory: true }).kind)
      .toBe("cwd-resume");
  });
});

// GH #276 follow-up, reported from a real session: with codex hooks installed,
// EVERY codex turn ended with a needs-you bell.
//
// codex puts its whole final assistant message on `OSC 9`. termic reads an
// `OSC 9` as "the agent is asking for you", so every completion became a
// request. The bodies below are transcribed from a captured
// `termic-workstate.log` with the paths placeholdered; their shape is the
// point, which is that they are ordinary prose with nothing to answer.
describe("codex notifications are announcements, not requests", () => {
  beforeEach(() => { mockAgents.length = 0; });

  const bodies = [
    "Done. Quick SEO pass landed: - Added `/sitemap.xml -> /sitemap-index.xml` redirect in [public/_redirects](/Users/u/proj/public/_redirects)",
    "Tried `sudo -n true`. It failed with: ```text zsh:1: operation not permitted: sudo ``` So this session cannot run permission-escalating commands.",
    "Read `/etc/hosts` successfully from outside the repo. Exit code: `0`",
    "I am here. What do you want me to do next?",
  ];

  it("never raises attention, whatever the body says", () => {
    for (const b of bodies) {
      expect(notificationWantsAttention("codex", b)).toBe(false);
    }
    // Including a body that happens to contain claude's allow-list wording:
    // the claim is about the AGENT, not about phrasing.
    expect(notificationWantsAttention("codex", "codex needs your permission")).toBe(false);
  });

  it("leaves every other agent alone", () => {
    // claude keeps its allow-list: a real permission prompt still badges, and
    // its 60s idle nag still does not.
    expect(notificationWantsAttention("claude", "Claude needs your permission")).toBe(true);
    expect(notificationWantsAttention("claude", "Claude is waiting for your input")).toBe(false);
    // An agent nobody has measured still defaults to trusting what it says.
    expect(notificationWantsAttention("some-custom-cli", "anything at all")).toBe(true);
  });

  it("still lets a user teach termic otherwise for their own build", () => {
    // The per-agent `attention` list is the documented tuning knob and is
    // checked FIRST, so this is not a decision taken away from them.
    mockAgents.push({
      id: "codex", display_name: "codex", command: "codex", args: [],
      capabilities: { attention: [], signals: { attention: ["ACTION NEEDED"] } },
    } as unknown as Agent);
    expect(notificationWantsAttention("codex", "ACTION NEEDED: approve this")).toBe(true);
    expect(notificationWantsAttention("codex", "Done. landed.")).toBe(false);
  });

  it("applies to a CLONE of codex, not just the id", () => {
    // A duplicated agent runs the same binary and notifies the same way.
    mockAgents.push(
      { id: "codex", display_name: "codex", command: "codex", args: [] } as unknown as Agent,
      { id: "work-codex", display_name: "work codex", command: "codex", args: [], extends: "codex" } as unknown as Agent,
    );
    expect(notificationWantsAttention("work-codex", "Done. landed.")).toBe(false);
  });
});

// Repo-root resume for codex. Several tasks share one cwd there, so
// `resume --last` hands the second task the first one's conversation; that is
// what the id-based path exists to stop.
//
// codex is the CAPTURE shape, not the mint shape, and the difference is
// measured rather than assumed: its TUI has no `--session-id`, and
// `codex resume <fresh-uuid>` answers "no rollout found for thread id" instead
// of creating it the way pi's flag does. The id therefore has to come back FROM
// the agent, which it does over termic's own SessionStart hook.
describe("codex resume", () => {
  beforeEach(() => { mockAgents.length = 0; });
  const args = (o: Parameters<typeof spawnArgsForCli>[1]) => spawnArgsForCli("codex", o);

  it("is capture-capable, not mint-capable", () => {
    expect(cliSupportsIdSession("codex")).toBe(false);
    expect(cliSupportsCaptureResume("codex")).toBe(true);
    expect(cliSupportsResumeById("codex")).toBe(true);
  });

  it("still resumes by cwd for a worktree, where that is the right answer", () => {
    expect(args({ yolo: false, resume: true })).toEqual(["resume", "--last"]);
  });

  it("resumes a SPECIFIC session once one has been reported", () => {
    expect(resumeIdArgsForCli("codex", "01a06adc-eeb5-77a0-b603-d7b670dd11e7"))
      .toEqual(["resume", "01a06adc-eeb5-77a0-b603-d7b670dd11e7"]);
  });

  it("never passes a uuid at MINT time, because codex would reject it", () => {
    // `resume <unknown-uuid>` exits with "no rollout found for thread id", so a
    // spawn that invented one would fail every time instead of starting fresh.
    expect(args({ yolo: false, resume: false, sessionUuid: "u-1", resumeKnown: false }))
      .toEqual([]);
  });

  it("composes with yolo in the order codex accepts", () => {
    expect(args({ yolo: true, resume: true }))
      .toEqual(["resume", "--last", "--dangerously-bypass-approvals-and-sandbox"]);
  });
});

// Muse Code (Meta), GH #275. Every fact below came off a live Muse Code 1.0.2
// driven through its offline `--provider echo`, so none of it needed a Meta
// account. The interesting one is that muse is deliberately NOT id-capable:
// `muse resume <session-uuid>` exists, but the only flag that would MINT an id
// (`--session-id`) belongs to `muse exec`, and the TUI rejects it outright
// ("invalid TUI options: unexpected argument '--session-id' found"). So a muse
// task resumes by cwd like codex, with codex's repo-root caveat.
describe("muse resume", () => {
  beforeEach(() => { mockAgents.length = 0; });
  const args = (o: Parameters<typeof spawnArgsForCli>[1]) => spawnArgsForCli("muse", o);

  it("resumes with the `resume --last` subcommand, not a flag", () => {
    expect(args({ yolo: false, resume: true })).toEqual(["resume", "--last"]);
  });

  it("emits `resume --last --yolo`, the order muse was verified to accept", () => {
    // spawnArgsForCli puts yolo_args AFTER the resume block, so the real
    // command line has --yolo trailing a subcommand. Checked against the live
    // binary rather than assumed: it resumed the prior session with history
    // AND showed YOLO in its footer.
    expect(args({ yolo: true, resume: true })).toEqual(["resume", "--last", "--yolo"]);
  });

  it("passes only --yolo on a fresh spawn", () => {
    expect(args({ yolo: true, resume: false })).toEqual(["--yolo"]);
  });

  it("spawns bare when neither resume nor yolo is asked for", () => {
    expect(args({ yolo: false, resume: false })).toEqual([]);
  });

  it("ignores a sessionUuid entirely, because the TUI cannot be given one", () => {
    // A uuid on the task must not leak into the command line as some
    // half-supported flag: muse would reject the whole invocation.
    expect(cliSupportsIdSession("muse")).toBe(false);
    // muse CAN resume a specific session; it just cannot be handed the id at
    // launch, so it is the capture shape (opencode's), not the mint shape.
    expect(cliSupportsResumeById("muse")).toBe(true);
    expect(cliSupportsCaptureResume("muse")).toBe(true);
    expect(args({ yolo: false, resume: true, sessionUuid: "u-1", resumeKnown: true }))
      .toEqual(["resume", "--last"]);
    expect(args({ yolo: false, resume: false, sessionUuid: "u-1", resumeKnown: false }))
      .toEqual([]);
  });

  it("adds --trust-workspace ONLY on an unattended spawn, before the subcommand", () => {
    // muse keys trust by directory, so every worktree task meets its trust
    // picker, and `n` in that picker selects Quit with a space confirming it:
    // "rename the button" kills the agent while it is still being TYPED, which
    // is upstream of the echo guard that withholds the submit. The flag trusts
    // for this run only (verified: the same dir prompts again next spawn), so
    // an attended launch still gets the picker and answers it itself.
    expect(args({ yolo: false, resume: false, unattended: true }))
      .toEqual(["--trust-workspace"]);
    expect(args({ yolo: false, resume: true, unattended: true }))
      .toEqual(["--trust-workspace", "resume", "--last"]);
    expect(args({ yolo: false, resume: true, unattended: false }))
      .toEqual(["resume", "--last"]);
  });

  it("captures its session id, because it cannot be handed one", () => {
    // The opposite of what this asserted at first. muse rejects `--session-id`
    // on the TUI, so termic cannot mint an id for it; but muse writes its own
    // under `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<uuid>/`, and
    // `muse resume <uuid>` replays that conversation (verified on a live 1.0.2
    // through `--provider echo`: it printed "resumed session <uuid>" and
    // redrew the prior turns). So the id is read back off disk, exactly the
    // way opencode's is.
    const cap = postLaunchCaptureForCli("muse");
    expect(cap?.command).toContain("muse/sessions");
    expect(cap?.command).toContain("XDG_DATA_HOME");
    expect(resumeIdArgsForCli("muse", "01a06b54-a9a0-71d3-bc65-b555ff3699c0"))
      .toEqual(["resume", "01a06b54-a9a0-71d3-bc65-b555ff3699c0"]);
  });
});

// Devin (Cognition). Every fact below was measured on a live 3000.10.21:
// `-r <slug>` resumed a session and answered a question only that session's
// history could answer, `-r <bogus>` failed fast with "No session found
// matching", and `devin list --format csv` prints this cwd's sessions
// newest-first without touching the trust gate.
describe("devin resume", () => {
  beforeEach(() => { mockAgents.length = 0; });
  const args = (o: Parameters<typeof spawnArgsForCli>[1]) => spawnArgsForCli("devin", o);

  it("resumes by cwd with --continue", () => {
    expect(args({ yolo: false, resume: true })).toEqual(["--continue"]);
  });

  it("emits --permission-mode dangerous as its yolo flag, after the resume", () => {
    expect(args({ yolo: true, resume: true }))
      .toEqual(["--continue", "--permission-mode", "dangerous"]);
    expect(args({ yolo: true, resume: false })).toEqual(["--permission-mode", "dangerous"]);
  });

  it("is the capture shape: no id can be minted, a slug can be resumed", () => {
    expect(cliSupportsIdSession("devin")).toBe(false);
    expect(cliSupportsResumeById("devin")).toBe(true);
    expect(cliSupportsCaptureResume("devin")).toBe(true);
    // A stored id must not leak into the plain spawn line as a half-supported
    // flag; it only ever reaches the agent through resume_id_args.
    expect(args({ yolo: false, resume: true, sessionUuid: "s-1", resumeKnown: true }))
      .toEqual(["--continue"]);
  });

  it("resumes a stored slug verbatim through resume_id_args", () => {
    // Session ids are devin's own slugs, and `--resume` takes them as-is:
    // the {UUID} placeholder name is historical, the substitution is a
    // plain string.
    expect(resumeIdArgsForCli("devin", "brassy-polish"))
      .toEqual(["--resume", "brassy-polish"]);
  });

  it("adds --respect-workspace-trust false ONLY on an unattended spawn", () => {
    // Same reason as muse's --trust-workspace: devin's trust picker eats the
    // injected prompt's keystrokes, and the flag is run-scoped so it cannot
    // permanently trust a directory behind the user's back.
    expect(args({ yolo: false, resume: false, unattended: true }))
      .toEqual(["--respect-workspace-trust", "false"]);
    expect(args({ yolo: false, resume: true, unattended: true }))
      .toEqual(["--respect-workspace-trust", "false", "--continue"]);
    expect(args({ yolo: false, resume: true, unattended: false }))
      .toEqual(["--continue"]);
  });

  it("captures its session slug off `devin list`", () => {
    // The backstop for when hooks are not installed: csv output is a header
    // row then sessions newest-first, so row 2 column 1 is the slug. A bare
    // `devin list` is an interactive picker, which is why the capture does
    // not use it.
    const cap = postLaunchCaptureForCli("devin");
    expect(cap?.command).toContain("devin list --format csv");
    expect(cap?.command).toContain("cut -d, -f1");
  });
});

// ── defaultCliFirst ───────────────────────────────────────────────────

describe("defaultCliFirst", () => {
  const rows = [{ id: "claude" }, { id: "codex" }, { id: "gemini" }, { id: "shell" }];

  it("hoists the project default and keeps the rest in registry order", () => {
    expect(defaultCliFirst(rows, "gemini").map(r => r.id))
      .toEqual(["gemini", "claude", "codex", "shell"]);
  });

  it("treats the plain shell like any other row", () => {
    expect(defaultCliFirst(rows, "shell").map(r => r.id))
      .toEqual(["shell", "claude", "codex", "gemini"]);
  });

  it("leaves an already-first default alone", () => {
    expect(defaultCliFirst(rows, "claude").map(r => r.id))
      .toEqual(["claude", "codex", "gemini", "shell"]);
  });

  it("leaves the order alone for an empty or unknown default", () => {
    // A default naming a removed / renamed agent must not silently promote
    // some OTHER row into the first slot, which is where the picker's answer
    // to \"what does this project use\" comes from.
    expect(defaultCliFirst(rows, "").map(r => r.id)).toEqual(rows.map(r => r.id));
    expect(defaultCliFirst(rows, undefined).map(r => r.id)).toEqual(rows.map(r => r.id));
    expect(defaultCliFirst(rows, "next-claude").map(r => r.id)).toEqual(rows.map(r => r.id));
  });

  it("does not mutate the input list", () => {
    const input = [...rows];
    defaultCliFirst(input, "gemini");
    expect(input.map(r => r.id)).toEqual(["claude", "codex", "gemini", "shell"]);
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

// ── cliSupportsResumeById (GH #169 `--resume <SESSION_ID>` gate) ──────

describe("cliSupportsResumeById", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("claude can resume by id (resume_id_args in the fallback)", () => {
    expect(cliSupportsResumeById("claude")).toBe(true);
  });

  it("opencode can resume by id WITHOUT being id-session capable", () => {
    // The capture-resume class: resume_id_args but no session_id_args.
    // The by-id gate must be wider than cliSupportsIdSession or attaching
    // an external opencode session would be refused despite working.
    expect(cliSupportsResumeById("opencode")).toBe(true);
    expect(cliSupportsIdSession("opencode")).toBe(false);
  });

  it("codex resumes by id, but cannot be handed one at launch", () => {
    // This used to assert codex was cwd-resume ONLY, which was true until its
    // repo-root case was fixed: several tasks share the repo root's cwd, so
    // `resume --last` there is another task's conversation.
    //
    // It is still not MINT-capable, and that half is the measured one:
    // codex's TUI has no `--session-id`, and `codex resume <fresh-uuid>` answers
    // "no rollout found for thread id" rather than creating it. So it resumes a
    // specific session only once the agent has reported which one it is.
    expect(cliSupportsResumeById("codex")).toBe(true);
    expect(cliSupportsIdSession("codex")).toBe(false);
  });

  it("a registry entry gains the capability by declaring resume_id_args", () => {
    // Platform-agnostic by design: no agent names anywhere in the gate.
    mockAgents.push({
      id: "future", display_name: "Future", command: "future", args: [],
      icon_id: "lucide:star", color: "#000", builtin: false,
      capabilities: { resume_id_args: ["--attach", "{UUID}"] },
    } as unknown as import("@/lib/types").Agent);
    expect(cliSupportsResumeById("future")).toBe(true);
  });
});

// ── external session attach (GH #169): seeded uuid composes a resume ──

describe("attaching an externally-started session", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("a seeded tab sessionId resolves to resume-id, not mint", () => {
    const d = decideResume({
      isAgent: true, idCapable: true, isPrimary: true, runsTaskAgent: true,
      isRepoRoot: false,
      // Import seeds has_resumable_history=true alongside the id; the
      // stored uuid must win over the legacy cwd-continue path.
      hasResumableHistory: true,
      storedUuid: "ext-session-uuid", failedResume: false,
    });
    expect(d).toEqual({ kind: "resume-id" });
  });

  it("composes --resume <id> and KEEPS --name (unlike resume_override)", () => {
    const task = { id: "w1", name: "poll linear", branch: "b", port: 1 } as never;
    const args = spawnArgsForCli("claude", {
      yolo: false, resume: false, task, isPrimary: true,
      sessionUuid: "ext-session-uuid", resumeKnown: true,
    });
    expect(args).toEqual(["--resume", "ext-session-uuid", "--name", "poll-linear"]);
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

  // Claude's spinner alphabet is not fixed: Braille frames, "⠐ ⠂" pairs and the
  // circle family (◐◑◒◓) have all been seen in the wild. The busy pattern is a
  // catch-all ("any leading glyph that is not the ✳ brand mark") precisely so a
  // new frame does not need a code change. These cases pin that promise for the
  // circle frames specifically, so a future tightening of the pattern to an
  // explicit glyph list cannot silently drop them and make a working agent read
  // as idle.
  it("treats circle spinner frames as busy for claude", () => {
    for (const t of ["◐", "◑", "◒", "◓"]) {
      expect(classifyAgentTitle("claude", t, [])).toBe("busy");
      expect(classifyAgentTitle("claude", `${t} Working`, [])).toBe("busy");
      expect(classifyAgentTitle("claude", `${t} Thinking… (5s · esc to interrupt)`, [])).toBe("busy");
      expect(classifyAgentTitle("claude", `  ${t} indented`, [])).toBe("busy");
    }
    // Still idle when claude's own done glyph leads, even though ✳ is also
    // non-alphanumeric. This is the precedence the busy pattern's ✳ exclusion
    // exists to protect.
    expect(classifyAgentTitle("claude", "✳ Ready", [])).toBe("idle");
  });

  // Codex 0.142.5 puts NO status word in its title: it is the cwd basename,
  // with a Braille spinner frame prepended while working. Measured off a real
  // PTY capture (scratchpad/agent-hooks-measurements.md). The old built-in only
  // had `\bReady\b` for idle, so the idle title classified as null; null does
  // not update TerminalPane's `senderStateRef`, so one spinner frame latched it
  // to "busy" for the whole PTY session and every demoter (byte-quiet,
  // scrollback-stable, the 90s ceiling) is gated on `!senderBusy`. A Codex tab
  // went "working" on its first turn and never came back.
  it("classifies codex's wordless idle title as idle, not null", () => {
    expect(classifyAgentTitle("codex", "proj", [])).toBe("idle");
    expect(classifyAgentTitle("codex", "some-worktree-name", [])).toBe("idle");
    // The exact ten frames observed in the capture, plus the wider Braille
    // block the pattern now covers so a new frame cannot read as idle.
    for (const f of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠿", "⢿"]) {
      expect(classifyAgentTitle("codex", `${f} proj`, [])).toBe("busy");
    }
    // Older builds that DO carry a status word keep working.
    expect(classifyAgentTitle("codex", "Ready", [])).toBe("idle");
    expect(classifyAgentTitle("codex", "Working", [])).toBe("busy");
    // Precedence: attention and busy still outrank the catch-all idle.
    expect(classifyAgentTitle("codex", "Action Required", [])).toBe("attention");
    expect(classifyAgentTitle("codex", "[ ! ] Action Required | proj", [])).toBe("attention");
    // A bare "Waiting" is deliberately NOT attention any more. grok's BUSY
    // title reads "Waiting for response…", meaning waiting on the model, and a
    // bare-word pattern is exactly the sort of thing that gets copied between
    // agents and then badges needs-you on every turn.
    expect(classifyAgentTitle("codex", "Waiting for response…", [])).not.toBe("attention");
    expect(classifyAgentTitle("codex", "Thinking about proj", [])).toBe("busy");
    expect(classifyAgentTitle("codex", "   ", [])).toBe(null);
  });

  // ── agy's needs-you comes from the SCREEN, because nothing else exists ─
  //
  // Measured against Antigravity CLI 1.1.24 at a live permission prompt, with
  // the pty given a window size (two earlier probes without one never got agy
  // past its splash and wrongly reported that it emits nothing at all): no
  // title, no OSC of any kind, no bell. Hooks cover its working and done; the
  // screen is the only place the third state appears.
  describe("BUILTIN_OUTPUT_SIGNALS", () => {
    const lines = [
      "Requesting permission for:",
      "   echo hello-from-agy",
      "Do you want to proceed?",
      "> 1. Yes",
    ];
    const attn = () => compileSignals(BUILTIN_OUTPUT_SIGNALS.agy?.attention);

    it("matches agy's real permission prompt", () => {
      const hits = lines.filter(l => attn().some(re => re.test(l)));
      expect(hits).toContain("Requesting permission for:");
      expect(hits).toContain("Do you want to proceed?");
    });

    it("does not fire on ordinary output", () => {
      // The cost of a screen pattern is a false bell on innocent text, so the
      // wording has to be specific to the prompt.
      for (const l of [
        "Generating...",
        "echo hello-from-agy",
        "Tip: View and review artifacts with /artifact.",
        "I will now request the permission I need",
      ]) {
        expect(attn().some(re => re.test(l))).toBe(false);
      }
    });

    it("is OUTPUT-only, and never reuses a title pattern", () => {
      // claude's `^\s*✳` describes a title and is nonsense against stdout,
      // which is why the scanner refuses to fall back to the title table.
      expect(BUILTIN_OUTPUT_SIGNALS.claude).toBeUndefined();
      expect(BUILTIN_OUTPUT_SIGNALS.agy?.busy).toBeUndefined();
      expect(BUILTIN_OUTPUT_SIGNALS.agy?.idle).toBeUndefined();
    });
  });

  // ── True inheritance: a clone stores overrides, not a copy ──────────
  describe("resolveAgent", () => {
    const parent = {
      id: "claude", display_name: "Claude", command: "claude", args: ["--v2"],
      icon_id: "claude", color: "#c96", env: { A: "1" }, docker_env: {},
      sandbox_allowed_paths: ["$HOME/.claude"], sandbox_allowed_hosts: ["api.x"],
      capabilities: { yolo_args: ["--yolo"], resume_args: ["--continue"],
                      signals: { busy: ["^b"], idle: ["^i"], attention: [], pending: [] } },
    } as unknown as Parameters<typeof resolveAgent>[0][number];

    const sparse = { id: "c2", display_name: "second account", extends: "claude",
                     command: "", args: [], icon_id: "", color: "" } as unknown as typeof parent;

    it("fills every empty field from the parent, live", () => {
      const r = resolveAgent([parent, sparse], "c2")!;
      // The point of the change: a vendor renaming a flag moves the parent and
      // the clone moves with it, instead of keeping a copy taken at creation.
      expect(r.args).toEqual(["--v2"]);
      expect(r.command).toBe("claude");
      expect(r.sandbox_allowed_paths).toEqual(["$HOME/.claude"]);
      expect(r.capabilities?.yolo_args).toEqual(["--yolo"]);
      // Identity is the clone's own and is never inherited.
      expect(r.id).toBe("c2");
      expect(r.display_name).toBe("second account");
    });

    it("keeps what the clone actually overrode", () => {
      const over = { ...sparse, args: ["--mine"] } as typeof parent;
      const r = resolveAgent([parent, over], "c2")!;
      expect(r.args).toEqual(["--mine"]);
      // And everything it did NOT override still tracks the parent.
      expect(r.command).toBe("claude");
      expect(r.capabilities?.resume_args).toEqual(["--continue"]);
    });

    it("merges capabilities per list, not wholesale", () => {
      // Overriding one flag list must not freeze the others: that is the same
      // rot the whole change removes, one level down.
      const over = { ...sparse,
        capabilities: { yolo_args: ["--danger"] } } as unknown as typeof parent;
      const r = resolveAgent([parent, over], "c2")!;
      expect(r.capabilities?.yolo_args).toEqual(["--danger"]);
      expect(r.capabilities?.resume_args).toEqual(["--continue"]);
      expect(r.capabilities?.signals?.busy).toEqual(["^b"]);
    });

    it("walks a chain and survives a cycle", () => {
      const mid = { id: "mid", display_name: "m", extends: "claude" } as unknown as typeof parent;
      const leaf = { id: "leaf", display_name: "l", extends: "mid" } as unknown as typeof parent;
      expect(resolveAgent([parent, mid, leaf], "leaf")!.command).toBe("claude");
      const loop = { id: "loop", display_name: "x", extends: "loop" } as unknown as typeof parent;
      expect(resolveAgent([loop], "loop")!.id).toBe("loop");
    });

    it("reports which fields are overrides, for the reset affordance", () => {
      expect(agentOverrides([parent, sparse], "c2")).toEqual([]);
      const over = { ...sparse, args: ["--mine"], color: "#fff" } as typeof parent;
      expect(agentOverrides([parent, over], "c2").sort()).toEqual(["args", "color"]);
      // A non-clone owns its values; it overrides nothing.
      expect(agentOverrides([parent], "claude")).toEqual([]);
    });
  });

  // ── A duplicated agent inherits its base's behaviour ────────────────
  //
  // Reported live. The user cloned claude to hold a second login, and the
  // clone behaved visibly worse than the agent it was copied from, because
  // every per-agent table here is keyed by id. Captured from the real session,
  // same body, ninety seconds apart:
  //
  //   notify-drop   cli=claude       body="Claude is waiting for your input"
  //   notify-badge  cli=next-claude  body="Claude is waiting for your input"
  describe("a cloned agent inherits through `extends`", () => {
    const agents = [
      { id: "claude", display_name: "claude", command: "claude", args: [] },
      // What Settings writes on duplicate, including a renamed id.
      { id: "next-claude", display_name: "next claude", command: "claude", args: [], extends: "claude" },
      // Two hops, to prove the walk is not single-step.
      { id: "next-claude-work", display_name: "w", command: "claude", args: [], extends: "next-claude" },
      { id: "orphan", display_name: "o", command: "whatever", args: [] },
      // A chain that points at itself must terminate, not hang: ids are
      // user-editable, so this is reachable by typing.
      { id: "loopy", display_name: "l", command: "x", args: [], extends: "loopy" },
    ] as unknown as NonNullable<Parameters<typeof classifyAgentTitle>[2]>;

    it("resolves a clone, and a clone of a clone, to the base", () => {
      expect(builtinBaseId("next-claude", agents)).toBe("claude");
      expect(builtinBaseId("next-claude-work", agents)).toBe("claude");
      expect(builtinBaseId("claude", agents)).toBe("claude");
    });

    it("leaves an agent that extends nothing alone, and terminates on a cycle", () => {
      expect(builtinBaseId("orphan", agents)).toBe("orphan");
      expect(builtinBaseId("loopy", agents)).toBe("loopy");
      expect(builtinBaseId("never-heard-of-it", agents)).toBe("never-heard-of-it");
    });

    it("ignores claude's idle nag on the clone, exactly as on claude", () => {
      // THE reported bug: this returned true for the clone and rang the bell.
      const nag = "Claude is waiting for your input";
      expect(notificationWantsAttention("claude", nag, agents)).toBe(false);
      expect(notificationWantsAttention("next-claude", nag, agents)).toBe(false);
      // And the allow-list is inherited too, so a real request still rings.
      expect(notificationWantsAttention("next-claude", "Claude needs your permission to use Bash", agents))
        .toBe(true);
    });

    it("classifies the clone's titles, which it previously could not read at all", () => {
      // With no patterns the clone had NO sender signal, so every fallback
      // demotion badged `attention` instead of `done` and turns ended on the
      // settled-hash heuristic.
      expect(classifyAgentTitle("next-claude", "✳ Claude Code", agents)).toBe("idle");
      expect(classifyAgentTitle("next-claude", "◐ Claude Code", agents)).toBe("busy");
      expect(classifyAgentTitle("next-claude", "✳ Claude Code", [])).toBeNull();
    });

    it("inherits pending-work patterns", () => {
      const rows = ["✻ Waiting for 3 background agents to finish"];
      expect(hasPendingWork("next-claude", rows, agents)).toBe(true);
      expect(hasPendingWork("orphan", rows, agents)).toBe(false);
    });

    it("lets the user's own signals win over the inherited ones", () => {
      // Inheritance supplies DEFAULTS. An override is still looked up by the
      // agent's real id, or tuning a clone would be impossible.
      const tuned = [
        ...(agents as unknown as Array<Record<string, unknown>>),
        { id: "tuned", display_name: "t", command: "claude", args: [], extends: "claude",
          capabilities: { signals: { idle: ["^DONE$"] } } },
      ] as unknown as NonNullable<Parameters<typeof classifyAgentTitle>[2]>;
      expect(classifyAgentTitle("tuned", "DONE", tuned)).toBe("idle");
      // The fields they did NOT override still come from the base.
      expect(classifyAgentTitle("tuned", "◐ Claude Code", tuned)).toBe("busy");
    });
  });

  // ── Real notification bodies, read out of claude 2.1.251 ────────────
  //
  // Every string below is one claude actually constructs, with its
  // `notificationType` named. The bug these pin: termic spoofs iTerm2, so
  // claude sends ALL of them as OSC 9, and filtering only the idle nag meant a
  // FINISHED turn rang the needs-you bell.
  describe("claude notification bodies", () => {
    const wants = (body: string) => notificationWantsAttention("claude", body, []);

    it("raises attention for every body that means needs-you", () => {
      // agent_needs_input, both forms
      expect(wants("template config to db needs your input")).toBe(true);
      expect(wants("template config to db needs your input: which branch?")).toBe(true);
      // permission_prompt
      expect(wants("Claude needs your permission to use Bash")).toBe(true);
      // worker_permission_prompt: says "needs permission", NOT "needs your"
      expect(wants("subagent needs permission for Edit")).toBe(true);
      // elicitation_dialog
      expect(wants("Claude Code needs your input")).toBe(true);
      // plan approval, captured live off a PTY
      expect(wants("Claude Code needs your approval for the plan")).toBe(true);
    });

    it("stays silent for a COMPLETION, which is the reported false bell", () => {
      // agent_completed: `${label} finished` / `${label} failed`. The user saw
      // this on a task that had plainly finished ("Crunched for 2m 36s").
      expect(wants("template config to db finished")).toBe(false);
      expect(wants("template config to db failed")).toBe(false);
    });

    it("stays silent for the other bodies claude sends", () => {
      expect(wants("Claude is waiting for your input")).toBe(false);      // idle_prompt
      expect(wants("Claude Code login successful")).toBe(false);          // auth_success
      expect(wants("Claude is done using your computer")).toBe(false);    // computer_use_exit
      expect(wants('MCP server "x" confirmed elicitation accept complete')).toBe(false);
      expect(wants('Elicitation response for server "x": decline')).toBe(false);
    });

    it("is silent by default for a body claude has not shipped yet", () => {
      // The whole point of the allow-list. A deny-list would badge this, which
      // is exactly how `agent_completed` started ringing in the first place.
      expect(wants("some future notification claude adds")).toBe(false);
    });

    it("leaves an agent with no allow-list permissive", () => {
      // An agent nobody has measured keeps "a notification means the agent
      // wants you", which is what asking the terminal to notify means.
      //
      // This used to use codex as the example, and codex is now the ONE agent
      // that is measured the other way: its OSC 9 carries the whole final
      // assistant message at the end of every turn and it never uses OSC 9 for
      // a permission prompt at all (see NOTIFY_NEVER_ATTENTION). Swapped for an
      // agent that genuinely has no entry rather than deleted, because the
      // permissive default is still the rule and still needs a test.
      expect(notificationWantsAttention("grok", "anything at all", [])).toBe(true);
      expect(notificationWantsAttention("some-future-cli", "anything at all", [])).toBe(true);
    });

    it("still lets a user's own attention list win", () => {
      // A user teaching termic their agent's wording must outrank the built-in
      // allow-list, or a custom claude wrapper could never be tuned.
      const agents = [{
        id: "claude", name: "claude", command: "claude", args: [],
        capabilities: { signals: { attention: ["ping me"] } },
      }] as unknown as NonNullable<Parameters<typeof notificationWantsAttention>[2]>;
      expect(notificationWantsAttention("claude", "ping me", agents)).toBe(true);
      expect(notificationWantsAttention("claude", "needs your input", agents)).toBe(false);
    });
  });

  // ── Real titles, captured from live agents ──────────────────────────
  //
  // Every string below was recorded off a real PTY while the agent worked, so
  // this block is the difference between a pattern that was reasoned about and
  // one that was measured. If a vendor changes their title, this is where it
  // should fail.
  describe("captured titles classify correctly", () => {
    const cases: Array<[string, string, string | null]> = [
      // claude: brand mark idle, any other leading glyph busy. Two spinner
      // families have shipped, which is why busy is a catch-all.
      ["claude", "✳ Claude Code", "idle"],
      ["claude", "✳ Background shell commands", "idle"],
      ["claude", "◐ Claude Code", "busy"],
      ["claude", "◑ Subtract function for calc.py", "busy"],
      ["claude", "⠋ thinking", "busy"],

      // codex: cwd basename when idle, Braille frame when working, and a
      // BLINKING attention title that alternates ! and .
      ["codex", "proj", "idle"],
      ["codex", "⠙ proj", "busy"],
      ["codex", "⠏ proj", "busy"],
      ["codex", "[ ! ] Action Required | proj", "attention"],
      ["codex", "[ . ] Action Required | proj", "attention"],

      // 0.154.0 renames the thread mid-turn and renders the generated name
      // through the same `activity` item, so the title carries model-written
      // prose after the leading state. The attention words appearing INSIDE
      // that prose must not win: the agent is working, and the spinner says so.
      ["codex", "⠧ Create out.txt with hello | proj", "busy"],
      ["codex", "Create out.txt with hello | proj", "idle"],
      ["codex", "⠼ Explain Action Required | proj", "busy"],
      ["codex", "Explain Action Required | proj", "idle"],
      // The real prompt still leads, behind the blink, with the prose trailing.
      ["codex", "[ ! ] Action Required | Create out.txt with hello | proj", "attention"],
      ["codex", "[ . ] Action Required | Create out.txt with hello | proj", "attention"],
      // Transient, emitted while the rename itself is in flight.
      ["codex", "⠋ renaming... ⠋ | proj", "busy"],

      // grok: the important one. Its two blocked states look nothing alike.
      ["grok", "grok", "idle"],
      ["grok", "Exact One Word Pong Reply Request - grok", "idle"],
      ["grok", "⠴ - Waiting for response… - grok", "busy"],
      ["grok", "⠼ - Thinking - grok", "busy"],
      ["grok", "⠙ - Writing file… - grok", "busy"],
      // Blocked on a tool prompt: leads with the warning sign.
      ["grok", "⚠ Action Required - ⠋ - Count 1-30 with 1s sleeps… - grok", "attention"],
      // Blocked on PLAN approval: no warning sign, and the spinner FREEZES.
      // Observed stuck on one frame for 217 seconds. Without this pattern a
      // plan awaiting approval reads as busy forever.
      ["grok", "⠹ - Running: Plan: Exit - Plan Adding Subtract Function to calc.py - grok", "attention"],

      // muse: braille spinner prefix while the model runs, bare workspace
      // basename when idle. Both captured off a live PTY (OSC 0).
      ["muse", "musetest", "idle"],
      ["muse", "⠋ musetest", "busy"],
      ["muse", "⠹ musetest", "busy"],

      // Agents whose titles carry no state at all.
      ["agy", "anything at all", null],
      ["opencode", "OpenCode", null],
      ["opencode", "OC | Creating out.txt with hi", null],
      ["pi", "π - proj", null],
    ];
    for (const [cli, title, want] of cases) {
      it(`${cli}: ${JSON.stringify(title)} -> ${want}`, () => {
        expect(classifyAgentTitle(cli, title, [])).toBe(want);
      });
    }

    it("never reads grok's 'Waiting for response' as needs-you", () => {
      // It means waiting on the MODEL. This is the single most tempting wrong
      // pattern in the whole table, because codex's older builds really did
      // use a bare "Waiting" for the opposite meaning.
      const busy = "⠴ - Waiting for response… - grok";
      expect(classifyAgentTitle("grok", busy, [])).toBe("busy");
      expect(classifyAgentTitle("grok", busy, [])).not.toBe("attention");
    });

    it("claude has no attention pattern, on purpose", () => {
      // Its title shows the IDLE glyph while blocked, so any pattern that
      // caught that state would also fire on every completed turn. Measured
      // three ways (permission prompt, AskUserQuestion, plan approval).
      expect(BUILTIN_TITLE_SIGNALS.claude.attention).toEqual([]);
      expect(classifyAgentTitle("claude", "✳ Create out.txt file", [])).toBe("idle");
    });
  });

  // Per-field fallback. Setting one field used to replace the WHOLE built-in
  // set, which is a quiet footgun: narrowing claude's busy pattern also deleted
  // its `^\s*✳` idle pattern, and because goIdle only fires on a busy→idle
  // title transition, the fast done signal stopped with nothing saying so.
  // `hasPendingWork` already resolved `pending` per field; these lock the other
  // three to the same rule.
  describe("per-field fallback to the built-ins", () => {
    const withSignals = (signals: NonNullable<Agent["capabilities"]>["signals"]) =>
      [sigAgent("claude", signals)];

    it("a custom busy pattern keeps the built-in idle pattern", () => {
      const a = withSignals({ busy: ["^\\s*[\\u2800-\\u28FF◐◑◒◓]"] });
      expect(classifyAgentTitle("claude", "⠋ thinking", a)).toBe("busy");
      expect(classifyAgentTitle("claude", "◐ Working", a)).toBe("busy");
      // The regression: this used to fall through to null.
      expect(classifyAgentTitle("claude", "✳ Ready", a)).toBe("idle");
    });

    it("a custom idle pattern keeps the built-in busy pattern", () => {
      const a = withSignals({ idle: ["^DONE$"] });
      expect(classifyAgentTitle("claude", "DONE", a)).toBe("idle");
      expect(classifyAgentTitle("claude", "⠋ thinking", a)).toBe("busy");
    });

    it("a custom field REPLACES rather than unions the built-in", () => {
      // The whole point of narrowing: claude's built-in busy is a catch-all, so
      // a strict whitelist must WIN over it or narrowing is impossible.
      const a = withSignals({ busy: ["^\\s*[◐◑]"] });
      expect(classifyAgentTitle("claude", "◐ Working", a)).toBe("busy");
      // Would be "busy" under the built-in catch-all; the whitelist excludes it.
      expect(classifyAgentTitle("claude", "~/repo", a)).toBe(null);
      expect(classifyAgentTitle("claude", "[main] build", a)).toBe(null);
    });

    it("an unmatchable pattern is how you opt a field out entirely", () => {
      // Empty now means "inherit", so opting out needs an explicit never-match.
      const a = withSignals({ busy: ["(?!)"] });
      expect(classifyAgentTitle("claude", "⠋ thinking", a)).toBe(null);
      expect(classifyAgentTitle("claude", "✳ Ready", a)).toBe("idle");
    });

    it("attention still outranks busy when only attention is customised", () => {
      const a = withSignals({ attention: ["NEEDS YOU"] });
      expect(classifyAgentTitle("claude", "NEEDS YOU", a)).toBe("attention");
      expect(classifyAgentTitle("claude", "⠋ thinking", a)).toBe("busy");
      expect(classifyAgentTitle("claude", "✳ Ready", a)).toBe("idle");
    });

    it("an agent with no built-ins and one custom field still works", () => {
      const a = [sigAgent("mycli", { busy: ["WORKING"] })];
      expect(classifyAgentTitle("mycli", "WORKING", a)).toBe("busy");
      expect(classifyAgentTitle("mycli", "anything else", a)).toBe(null);
    });
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
  it("keeps muse's attention list empty until someone captures the real title", () => {
    // muse's busy/idle titles were measured; its approval-prompt title was
    // not, because triggering one needs a real tool call and so a Meta
    // account. A guessed pattern here is worse than none: it would fire on
    // ordinary turns and badge needs-you forever. c35d297 exists because two
    // agents shipped reasoned-not-measured patterns.
    expect(BUILTIN_TITLE_SIGNALS.muse.attention).toEqual([]);
    expect(BUILTIN_TITLE_SIGNALS.muse.pending).toEqual([]);
    // But it is NOT one of the signal-silent agents: these two are real.
    expect(BUILTIN_TITLE_SIGNALS.muse.busy.length).toBeGreaterThan(0);
    expect(BUILTIN_TITLE_SIGNALS.muse.idle.length).toBeGreaterThan(0);
  });

  for (const cli of ["claude", "codex", "muse"]) {
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

// ── Pending-work detection ────────────────────────────────────────────
//
// Rows below are transcribed from real recordings of claude backgrounding
// subagents (see docs/gotchas.md). The failure they encode: claude's turn
// genuinely ends while the work continues, so the title goes to the idle glyph
// and every byte-stream signal says "finished". One recording showed a done
// badge held for 617s while three subagents ran.

/** The live block at the bottom of claude's screen while subagents run. */
const PENDING_TAIL = [
  "✻ Churned for 56s · 3 shells, 1 monitor still running",
  "",
  "────────────────────────────────────  signal-subagents",
  "❯ check on them",
  "────────────────────────────────────",
  "▶▶ auto mode on · 3 shells, 1 monitor · ← 1 agent · ↓ to manage",
];

/** Same block once everything has landed. Note `← 1 agent` survives here: it
 *  is a persistent hint, not a pending-work count, and was measured present
 *  while the agent was fully idle. A pattern keying on it would never clear. */
const IDLE_TAIL = [
  "✻ Brewed for 2s",
  "",
  "────────────────────────────────────  signal-subagents",
  "❯ ",
  "────────────────────────────────────",
  "▶▶ auto mode on (shift+tab to cycle) · ← 1 agent",
];

describe("hasPendingWork", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("matches the live status line while subagents run", () => {
    expect(hasPendingWork("claude", PENDING_TAIL)).toBe(true);
  });

  it("does not match once the work has landed", () => {
    expect(hasPendingWork("claude", IDLE_TAIL)).toBe(false);
  });

  it("matches both singular and plural agent counts", () => {
    for (const n of [1, 2, 3]) {
      const line = `✻ Waiting for ${n} background agent${n === 1 ? "" : "s"} to finish`;
      expect(hasPendingWork("claude", [line])).toBe(true);
    }
  });

  it("ignores a stale copy sitting in scrollback", () => {
    // The whole reason the check is positional: this exact line was still on
    // screen 120s after that agent finished. Matching anywhere in the viewport
    // would pin the tab to working until the 10-minute ceiling.
    const rows = [
      "✻ Waiting for 1 background agent to finish",
      ...Array.from({ length: PENDING_TAIL_ROWS }, (_, i) => `⏺ later output ${i}`),
    ];
    expect(hasPendingWork("claude", rows)).toBe(false);
  });

  it("still matches when the line sits at the very edge of the window", () => {
    const rows = [
      "⏺ old output",
      "✻ Waiting for 2 background agents to finish",
      ...Array.from({ length: PENDING_TAIL_ROWS - 1 }, (_, i) => `⏺ newer ${i}`),
    ];
    expect(hasPendingWork("claude", rows)).toBe(true);
  });

  it("is off for agents with no pending patterns", () => {
    expect(hasPendingWork("codex", PENDING_TAIL)).toBe(false);
    expect(hasPendingWork("unknown-cli", PENDING_TAIL)).toBe(false);
  });

  it("lets an agent override the built-ins", () => {
    mockAgents.push(sigAgent("claude", { pending: ["\\bstill crunching\\b"] }));
    expect(hasPendingWork("claude", ["waiting: still crunching"])).toBe(true);
    // Overridden, so the built-in phrasing no longer counts.
    expect(hasPendingWork("claude", PENDING_TAIL)).toBe(false);
  });

  it("never throws on an invalid user pattern", () => {
    mockAgents.push(sigAgent("claude", { pending: ["(unclosed"] }));
    expect(() => hasPendingWork("claude", PENDING_TAIL)).not.toThrow();
    expect(hasPendingWork("claude", PENDING_TAIL)).toBe(false);
  });

  it("ignores blank rows", () => {
    expect(hasPendingWork("claude", ["", "   ", ""])).toBe(false);
  });
});

describe("notificationWantsAttention", () => {
  beforeEach(() => { mockAgents.length = 0; });

  it("badges a real block on the user", () => {
    // Measured 6.0s after the title went idle, on both question prompts and a
    // real Bash approval.
    expect(notificationWantsAttention("claude", "Claude needs your permission")).toBe(true);
  });

  it("ignores the 60s idle nag", () => {
    // Fires after any turn you don't reply to within a minute. Badging it
    // would ring a bell for work already reported done.
    expect(notificationWantsAttention("claude", "Claude is waiting for your input")).toBe(false);
  });

  it("defaults to badging an unknown AGENT's bodies", () => {
    // No allow-list for it, so a notification still means "the agent wants
    // you", which is what asking the terminal to notify means.
    expect(notificationWantsAttention("some-cli", "build broke")).toBe(true);
  });

  it("no longer badges an unknown body from claude", () => {
    // This assertion used to expect `true`, and that WAS the bug. claude
    // notifies about eleven different things and only five of them want the
    // user; badging by default meant `agent_completed` ("<task> finished")
    // rang the needs-you bell on a turn that had just succeeded. claude has a
    // built-in allow-list now, so silence is the default for anything that
    // does not ask for the user. See BUILTIN_NOTIFY_ATTENTION.
    expect(notificationWantsAttention("claude", "something new claude says")).toBe(false);
  });

  it("ignores an empty body", () => {
    expect(notificationWantsAttention("claude", "   ")).toBe(false);
  });

  it("treats a configured attention list as an allow-list", () => {
    mockAgents.push(sigAgent("claude", { attention: ["waiting for your input"] }));
    // Named → badged, even though the built-in ignore list drops it.
    expect(notificationWantsAttention("claude", "Claude is waiting for your input")).toBe(true);
    // Not named → dropped, even though an unconfigured agent would badge it.
    // This is the only knob for notification bodies (the ignore list is
    // built-in and not user-editable), so it has to be able to say "no".
    expect(notificationWantsAttention("claude", "Claude needs your permission")).toBe(false);
  });
});

// GH #274. codex 0.15x merges a MANAGED requirements layer (/etc/codex/
// requirements.toml, macOS MDM preferences, or the org attached to a work
// ChatGPT account) and treats a forbidden `sandbox_mode` as a hard startup
// error, not a downgrade: `--dangerously-bypass-approvals-and-sandbox` then
// kills the spawn with a message that names Codex config, never the Termic
// field that passed the flag. The note is what closes that gap, so what is
// worth pinning is that it REACHES the field, including on a clone.
describe("YOLO_ARGS_NOTES", () => {
  const agents = [
    { id: "codex", display_name: "codex", command: "codex", args: [] },
    { id: "work-codex", display_name: "work codex", command: "codex", args: [], extends: "codex" },
    { id: "claude", display_name: "claude", command: "claude", args: [] },
  ] as unknown as NonNullable<Parameters<typeof classifyAgentTitle>[2]>;

  it("reaches codex and every clone of it", () => {
    expect(yoloArgsNote(builtinBaseId("codex", agents))).toBeTruthy();
    expect(yoloArgsNote(builtinBaseId("work-codex", agents)))
      .toBe(yoloArgsNote("codex"));
  });

  it("leaves agents with no caveat without one", () => {
    expect(YOLO_ARGS_NOTES[builtinBaseId("claude", agents)]).toBeUndefined();
    expect(YOLO_ARGS_NOTES[builtinBaseId("never-heard-of-it", agents)]).toBeUndefined();
  });

  it("names the error the user actually sees, and the flags that replace it", () => {
    // The note is only findable by someone pasting Codex's own wording into
    // a search, so the substring it quotes has to stay verbatim.
    expect(yoloArgsNote("codex")).toContain("requirements do not allow sandbox_mode");
    expect(yoloArgsNote("codex")).toContain("-a never -s workspace-write");
  });

  it("is free of em dashes, like all user-visible copy", () => {
    for (const lng of ["en", "zh-CN"]) {
      void i18n.changeLanguage(lng);
      expect(yoloArgsNote("codex")).not.toContain("—");
    }
    void i18n.changeLanguage("en");
  });
});

// ── the agent's own session picker (GH #311) ──────────────────────────

describe("resume picker", () => {
  beforeEach(() => { mockAgents.length = 0; });
  const task = { id: "ws1", name: "Improve Tests", branch: "main", port: 1420, cli: "claude" } as any;

  it("claude opens its picker with --resume and no id (measured on 2.1.278)", () => {
    // Built-in fallback table: no registry entry at all.
    expect(resumePickerArgsForCli("claude")).toEqual(["--resume"]);
  });

  it("the picker replaces every resume block, and names nothing", () => {
    // claude applies --name to the session PICKED, which in a main checkout
    // can be a sibling task's: it was renamed to this task and then read as
    // this task's in every later picker.
    const args = spawnArgsForCli("claude", {
      yolo: false, resume: false, isPrimary: true, task, picker: ["--resume"],
    });
    expect(args).toEqual(["--resume"]);
    expect(args.join(" ")).not.toMatch(/--session-id|--continue/);
  });

  it("an agent with no picker offers none, so the fresh fallback stays", () => {
    mockAgents.push({
      id: "codex", display_name: "codex", command: "codex", args: [], builtin: true,
      capabilities: { yolo_args: [], runtime_yolo_command: "", resume_args: ["resume", "--last"],
        session_id_args: [], resume_id_args: ["resume", "{UUID}"], name_args: [] },
    } as any);
    expect(resumePickerArgsForCli("codex")).toEqual([]);
  });

  it("a clone inherits its parent's picker, and can set its own", () => {
    mockAgents.push(
      { id: "claude", display_name: "claude", command: "claude", args: [], builtin: true,
        capabilities: { yolo_args: [], runtime_yolo_command: "", resume_args: ["--continue"],
          session_id_args: ["--session-id", "{UUID}"], resume_id_args: ["--resume", "{UUID}"],
          resume_picker_args: ["--resume"], name_args: [] } } as any,
      { id: "claude-work", display_name: "claude-work", command: "claude", args: [], builtin: false,
        extends: "claude", capabilities: {} } as any,
      { id: "claude-own", display_name: "claude-own", command: "claude", args: [], builtin: false,
        extends: "claude", capabilities: { resume_picker_args: ["--resume", "--all"] } } as any,
    );
    expect(resumePickerArgsForCli("claude-work")).toEqual(["--resume"]);
    expect(resumePickerArgsForCli("claude-own")).toEqual(["--resume", "--all"]);
  });
});
