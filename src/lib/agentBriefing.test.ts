import { describe, it, expect } from "vitest";
import { buildAgentBriefing, cliFallbackCommand } from "./agentBriefing";
import type { Task } from "./types";

const task = {
  id: "task-abc123",
  project_id: "proj-1",
  name: "review-auth",
  branch: "sim/review-auth",
  base_branch: "main",
  path: "/Users/x/.termic/worktrees/review-auth",
  cli: "codex",
  port: 4100,
  created: "2026-08-01T00:00:00Z",
  archived: false,
} as Task;

describe("cliFallbackCommand", () => {
  it("uses the bare command name when the link is on PATH", () => {
    expect(cliFallbackCommand({ path: "/Users/x/.local/bin/termic", name: "termic", on_path: true }))
      .toBe("termic");
  });

  it("uses the absolute path when the link is installed but off PATH", () => {
    // A bare name the login shell can't resolve would make the pasted block
    // silently fail for an agent outside Termic.
    expect(cliFallbackCommand({ path: "/usr/local/bin/termic-dev", name: "termic-dev", on_path: false }))
      .toBe("/usr/local/bin/termic-dev");
  });

  it("falls back to the build's command name when nothing is installed", () => {
    expect(cliFallbackCommand({ path: null, name: "termic-dev", on_path: false })).toBe("termic-dev");
  });

  it("survives the status call failing", () => {
    expect(cliFallbackCommand(null)).toBe("termic");
  });
});

describe("buildAgentBriefing", () => {
  const block = buildAgentBriefing({ task, projectName: "termic", cli: "termic" });
  const lines = block.split("\n");
  const cmd = lines.find(l => l.trimStart().startsWith("termic send"))!;

  it("is one block tagged with the task it is about", () => {
    // Pasted INSIDE someone else's prompt: the tag makes it one clearly
    // attributed unit, and two pasted briefings can never blur together.
    expect(lines[0]).toBe(
      '<termic-task id="task-abc123" name="review-auth" project="termic" agent="codex" path="/Users/x/.termic/worktrees/review-auth">',
    );
    expect(lines[lines.length - 1]).toBe("</termic-task>");
  });

  it("is short: the protocol lives in the CLI's own help", () => {
    // $TERMIC_CLI_HELP and `send --help` teach the rest; re-teaching it here
    // is what made an earlier draft 35 lines nobody read.
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("escapes a task name that would break out of its attribute", () => {
    const b = buildAgentBriefing({ task: { ...task, name: 'say "hi" & <go>' } as Task, projectName: "termic", cli: "termic" });
    expect(b.split("\n")[0]).toContain('name="say &quot;hi&quot; &amp; &lt;go>"');
  });

  it("addresses the task by id in the command, never by name", () => {
    expect(cmd).toContain("termic send task-abc123 -p ");
    expect(block).not.toContain("send review-auth");
  });

  it("threads the resolved command through both legs of the exchange", () => {
    // Outbound and the nested reply must both use a command that resolves;
    // an off-PATH install is an absolute path (see cliFallbackCommand).
    const b = buildAgentBriefing({ task, projectName: "termic", cli: "/usr/local/bin/termic-dev" });
    expect(b.match(/\/usr\/local\/bin\/termic-dev/g)).toHaveLength(2);
  });

  it("puts the sender's identity in DOUBLE quotes so the sender's shell fills it", () => {
    // `-p "... $TERMIC_TASK_ID ..."` is substituted by the SENDING agent's
    // shell, handing the receiver a literal address; single quotes would
    // block that. The inner reply is single-quoted so it nests unescaped.
    const arg = cmd.slice(cmd.indexOf(' -p "') + 4);
    expect(arg.startsWith('"')).toBe(true);
    expect(arg.endsWith('"')).toBe(true);
    expect(arg).toContain("-p '[message from ");
  });

  it("signs both directions with agent, task name and id", () => {
    // Outbound: the sender, filled in by its shell.
    expect(cmd).toContain('-p "[message from agent:<you> task:$TERMIC_TASK id:$TERMIC_TASK_ID]');
    expect(cmd).toMatch(/-- agent:<you> task:\$TERMIC_TASK id:\$TERMIC_TASK_ID"$/);
    // The reply: the receiving task, literally, as itself.
    const them = "agent:codex task:review-auth id:task-abc123";
    expect(cmd).toContain(`-p '[message from ${them}] done: <what you did> -- ${them}'`);
  });

  it("tells the reader to preserve the quoting and the variables", () => {
    // The reader is an agent that REWRITES this line to slot its prompt in;
    // flipping the quotes or inventing values breaks the reply silently.
    expect(block).toContain("Keep the outer double quotes and the $TERMIC_ variables as written");
  });

  it("never suggests --wait", () => {
    expect(block).not.toContain("--wait");
  });

  it("degrades to a readable attribute when the project name is unknown", () => {
    expect(buildAgentBriefing({ task, projectName: null, cli: "termic" }))
      .toContain('project="unknown project"');
  });

  it("makes no claim about a worktree, which a main-checkout task has none of", () => {
    expect(block).not.toMatch(/its own git worktree|working in its/);
  });
});

describe("buildAgentBriefing sandbox caveat", () => {
  const build = (t: Partial<Task>) =>
    buildAgentBriefing({ task: { ...task, ...t } as Task, projectName: "termic", cli: "termic" });

  it("warns that an enforcing task cannot reply at all", () => {
    // An enforcing cage denies the control-plane socket, so the report-back
    // half is unavailable to that agent; without this the reader wires up a
    // reply that never arrives.
    expect(build({ sandbox_mode: "enforce" })).toContain("sandboxed (enforcing)");
    expect(build({ sandbox_mode: "enforce-fs" })).toContain("sandboxed (enforcing)");
  });

  it("stays quiet for off and monitor, which do reach the CLI", () => {
    expect(build({ sandbox_mode: "off" })).not.toContain("sandboxed");
    expect(build({ sandbox_mode: "monitor" })).not.toContain("sandboxed");
    expect(build({})).not.toContain("sandboxed");
  });

  it("reads the legacy sandbox_enabled flag the same way", () => {
    expect(build({ sandbox_mode: undefined, sandbox_enabled: true })).toContain("sandboxed (enforcing)");
  });

  it("stays inside the tag, and costs nothing on a task it does not apply to", () => {
    const caged = build({ sandbox_mode: "enforce" }).split("\n");
    expect(caged[caged.length - 1]).toBe("</termic-task>");
    expect(build({ sandbox_mode: "off" }).split("\n").length).toBe(5);
  });
});

describe("buildRemoteAgentBriefing", () => {
  it("reaches the task and takes the reply through the peer link, by id", async () => {
    const { buildRemoteAgentBriefing } = await import("./agentBriefing");
    const b = buildRemoteAgentBriefing({
      task: { id: "task-9", name: "fix login", agent: "claude", project: "web" },
      machine: { id: "peer-b", name: "Studio" },
      us: "peer-a",
      cli: "termic",
    });
    expect(b).toContain('termic --peer peer-b send task-9 -p "');
    expect(b).toContain("termic --peer peer-a send $TERMIC_TASK_ID");
    expect(b).toContain('computer="Studio"');
    expect(b).not.toContain("path=");
  });
});
