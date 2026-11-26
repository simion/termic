import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

  it("signs both directions with agent, task name, id and optional tab", () => {
    // Outbound: the sender, filled in by its shell.
    expect(cmd).toContain('-p "[message from agent:<you> task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}]');
    expect(cmd).toContain('${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p ');
    expect(cmd).toMatch(/-- agent:<you> task:\$TERMIC_TASK id:\$TERMIC_TASK_ID\$\{TERMIC_TAB_ID:\+ tab:\$TERMIC_TAB_ID\}"$/);
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
    expect(b).toContain("termic --peer peer-a send $TERMIC_TASK_ID ${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }");
    expect(b).toContain('computer="Studio"');
    expect(b).not.toContain("path=");
  });

  it("keeps embedded report-back commands on one physical line across docs and briefings", () => {
    const localCmd = buildAgentBriefing({ task, projectName: "termic", cli: "termic" })
      .split("\n")
      .find(l => l.trim().startsWith("termic send "))!
      .trim();
    expect(localCmd).toContain("termic send $TERMIC_TASK_ID ${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p '");

    for (const rel of ["docs/cli-agent-instructions.md", "src-tauri/assets/skills/termic/SKILL.md"]) {
      const content = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
      const cmdBlocks = [...content.matchAll(/^(    "\$TERMIC_CLI"[^\n]*(?:\n    [^\n]+)*)/gm)]
        .map(m => m[1])
        .filter(b => b.includes("${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }"));
      expect(cmdBlocks.length, `${rel} should have CLI examples with TERMIC_TAB_ID`).toBeGreaterThanOrEqual(3);
      for (const block of cmdBlocks) {
        expect(block).not.toMatch(/send \$TERMIC_TASK_ID[^\n]*\n[^\n]*(?:--tab|-p)/);
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "expands briefing and docs shell snippets cleanly in /bin/sh with TERMIC_TAB_ID set and unset",
    () => {
      const runSnippet = (cmdLine: string, tabId?: string): string[] => {
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TERMIC_CLI: "termic",
          TERMIC_TASK: "parent-task",
          TERMIC_TASK_ID: "task-parent",
        };
        if (tabId !== undefined) env.TERMIC_TAB_ID = tabId;
        const script = `termic() { for a in "$@"; do printf '__ARG__%s\\n' "$a"; done; }\n${cmdLine}`;
        const out = execFileSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
        return out.split("__ARG__").slice(1).map(s => s.replace(/\n$/, ""));
      };

      const localCmd = buildAgentBriefing({ task, projectName: "termic", cli: "termic" })
        .split("\n")
        .find(l => l.trim().startsWith("termic send "))!
        .trim();
      const withTab = runSnippet(localCmd, "tab-7");
      expect(withTab.slice(0, 3)).toEqual(["send", "task-abc123", "-p"]);
      expect(withTab[3]).toContain("[message from agent:<you> task:parent-task id:task-parent tab:tab-7]");
      expect(withTab[3]).toContain("reply: termic send task-parent --tab tab-7 -p '");
      expect(withTab[3]).toContain("-- agent:<you> task:parent-task id:task-parent tab:tab-7");
      expect(withTab[3]).not.toContain("\n");

      const withoutTab = runSnippet(localCmd, undefined);
      expect(withoutTab[3]).toContain("[message from agent:<you> task:parent-task id:task-parent]");
      expect(withoutTab[3]).toContain("reply: termic send task-parent -p '");
      expect(withoutTab[3]).not.toContain("--tab");
      expect(withoutTab[3]).not.toContain("\n");

      const replyMatch = withTab[3].match(/reply: (termic send .* -p '.*') -- agent:/);
      expect(replyMatch).not.toBeNull();
      expect(runSnippet(replyMatch![1])).toEqual([
        "send",
        "task-parent",
        "--tab",
        "tab-7",
        "-p",
        "[message from agent:codex task:review-auth id:task-abc123] done: <what you did> -- agent:codex task:review-auth id:task-abc123",
      ]);

      for (const rel of ["docs/cli-agent-instructions.md", "src-tauri/assets/skills/termic/SKILL.md"]) {
        const content = fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
        const cmdBlocks = [...content.matchAll(/^(    "\$TERMIC_CLI"[^\n]*(?:\n    [^\n]+)*)/gm)]
          .map(m => m[1])
          .filter(b => b.includes("${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }"));
        for (const rawBlock of cmdBlocks) {
          const block = rawBlock.replace(/<model-id>/g, "gpt-5");
          const expanded = runSnippet(block, "tab-9");
          const promptArg = expanded[expanded.indexOf("-p") + 1];
          expect(promptArg).toContain("tab:tab-9");
          expect(promptArg).toContain("send task-parent --tab tab-9 -p");
          expect(promptArg).not.toMatch(/send task-parent[^\n]*\n[^\n]*--tab/);
          const noTabExpanded = runSnippet(block, undefined);
          const noTabPrompt = noTabExpanded[noTabExpanded.indexOf("-p") + 1];
          expect(noTabPrompt).toContain("send task-parent -p");
          expect(noTabPrompt).not.toContain("--tab");
        }
      }
    },
  );
});
