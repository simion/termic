// Per-agent CLI knowledge, now driven by the editable agent registry in
// Settings → Agents (Settings.agents[] in the app store). Hard-coded
// fallbacks remain ONLY for the four built-ins so the app still works
// if the registry hasn't loaded yet (very first render before loadAll
// resolves) or if a user removed all agents.

import type { Agent, Workspace, CliInfo } from "@/lib/types";
import { useApp } from "@/store/app";
import { ptyWrite } from "@/lib/ipc";
import { slugify } from "@/lib/utils";

/** Variables that can be referenced in any agent arg via `{name}` placeholders.
 *  Lets the user write things like `--name {workspace_slug}` in Settings →
 *  Agents and have it expand per-worktree at spawn time. Supported keys:
 *    {workspace_slug}  → slugified workspace name (e.g. "improve-tests")
 *    {workspace_name}  → raw workspace name
 *    {workspace_id}    → UUID
 *    {branch}          → git branch
 *    {port}            → assigned dev port
 *  Unknown placeholders pass through unchanged so weird arg shapes don't
 *  silently mangle. */
function expandArg(arg: string, vars: Record<string, string>): string {
  return arg.replace(/\{([a-zA-Z_]+)\}/g, (m, k) => vars[k] ?? m);
}
function workspaceVars(ws: Workspace | undefined): Record<string, string> {
  if (!ws) return {};
  return {
    workspace_slug: slugify(ws.name),
    workspace_name: ws.name,
    workspace_id: ws.id,
    branch: ws.branch,
    port: String(ws.port),
  };
}

/** Hard-coded fallback for the four built-ins. Used only when the
 *  registry doesn't have an entry for `cli` yet (pre-load) or when the
 *  registry is empty. The registry is the source of truth in steady state. */
const BUILTIN_FALLBACK: Record<string, Pick<Agent, "command" | "args"> & {
  capabilities: NonNullable<Agent["capabilities"]>;
}> = {
  claude: {
    command: "claude", args: [],
    capabilities: {
      yolo_args: ["--dangerously-skip-permissions"],
      runtime_yolo_command: "",
      // Reverted from `--resume {workspace_slug}` (named-session scheme):
      // claude was dropping into its interactive picker when the named
      // session didn't exist yet, leaving the user stuck. `--continue`
      // takes the most-recent session in CWD with no picker.
      resume_args: ["--continue"],
    },
  },
  gemini: {
    command: "gemini", args: [],
    capabilities: {
      yolo_args: ["--yolo"],
      runtime_yolo_command: "/approval-mode yolo",
      runtime_default_command: "/approval-mode default",
      // `gemini --resume latest` — most-recent session in CWD.
      resume_args: ["--resume", "latest"],
    },
  },
  codex: {
    command: "codex", args: [],
    capabilities: {
      yolo_args: ["--dangerously-bypass-approvals-and-sandbox"],
      runtime_yolo_command: "",
      // `codex resume --last` — subcommand form, picks most-recent session.
      resume_args: ["resume", "--last"],
    },
  },
  agy: {
    command: "agy", args: [],
    capabilities: {
      // Antigravity CLI 1.0 — mirrors claude: `--dangerously-skip-permissions`
      // auto-approves tool prompts; `--continue` resumes the latest session.
      yolo_args: ["--dangerously-skip-permissions"],
      runtime_yolo_command: "",
      resume_args: ["--continue"],
    },
  },
};

/** Helper to get an agent's display name by its id. Consulting the registry first,
 *  then falling back to built-in names and finally returning the id itself. */
export function agentDisplayName(cli: string, agents: Agent[] = useApp.getState().agents): string {
  const a = agents.find(x => x.id === cli);
  if (a) return a.display_name;
  // Fallback for built-ins if the registry is not yet loaded or empty
  switch (cli) {
    case "claude": return "Claude";
    case "gemini": return "Gemini";
    case "codex":  return "Codex";
    case "agy":    return "Antigravity";
    case "shell":  return "Terminal";
    default:       return cli;
  }
}

function findAgent(cli: string): {
  command: string; args: string[];
  caps: NonNullable<Agent["capabilities"]>;
  env: Record<string, string>;
} {
  const registry = useApp.getState().agents;
  const a = registry.find(a => a.id === cli);
  if (a) {
    return {
      command: a.command,
      args: [...a.args],
      caps: {
        yolo_args: a.capabilities?.yolo_args ?? [],
        runtime_yolo_command: a.capabilities?.runtime_yolo_command ?? "",
        runtime_default_command: a.capabilities?.runtime_default_command ?? "",
        resume_args: a.capabilities?.resume_args ?? [],
      },
      env: { ...(a.env ?? {}) },
    };
  }
  const fb = BUILTIN_FALLBACK[cli];
  if (fb) return { command: fb.command, args: [...fb.args], caps: fb.capabilities, env: {} };
  // Unknown custom agent that's been deleted — best effort: use the cli id
  // as the command so the user at least sees "command not found" instead of
  // a silent black terminal.
  return { command: cli, args: [], caps: { yolo_args: [], runtime_yolo_command: "", resume_args: [] }, env: {} };
}

/** Resolved spawn command for an agent. The command is whatever the user
 *  configured in Settings → Agents (lets people point at custom wrappers,
 *  pnpm scripts, etc. without code changes). */
export function spawnCommandForCli(cli: string): string {
  return findAgent(cli).command;
}

/** Compose the full args list for a spawn. Order: agent's base args,
 *  then yolo flags (if mode on + agent supports), then resume flags
 *  (if not first spawn for this worktree + agent supports). Any `{var}`
 *  placeholders in any arg are expanded against the workspace context
 *  (e.g. `--name {workspace_slug}` → `--name improve-tests`). */
export function spawnArgsForCli(
  cli: string,
  opts: { yolo: boolean; resume: boolean; ws?: Workspace },
): string[] {
  const { args, caps } = findAgent(cli);
  const vars = workspaceVars(opts.ws);
  // Order matters: resume_args FIRST, yolo_args LAST. Reason: codex's
  // resume is a subcommand (`codex resume --last`), and global flags like
  // `--dangerously-bypass-approvals-and-sandbox` must attach to the
  // subcommand (`codex resume --last --dangerously-bypass-approvals-and-sandbox`)
  // — putting them BEFORE the subcommand makes clap-style parsers reject
  // the flag as unknown. claude / gemini take all their flags at root
  // level, so the trailing-yolo position is harmless for them.
  const composed = [
    ...args,
    ...(opts.resume ? (caps.resume_args ?? []) : []),
    ...(opts.yolo ? (caps.yolo_args ?? []) : []),
  ];
  return composed.map(a => expandArg(a, vars));
}

/** Send the live YOLO toggle command if the agent supports it. Today only
 *  gemini does (`/approval-mode <mode>`); others need a respawn. */
export async function tryToggleYoloLive(cli: string, ptyId: string, yolo: boolean): Promise<boolean> {
  const { caps } = findAgent(cli);
  // Two explicit commands now (into-YOLO / back-to-default). A legacy
  // single-field config only has runtime_yolo_command (with a `{mode}`
  // placeholder) — fall back to it for the default direction so old
  // configs keep toggling. `{mode}` is still substituted either way.
  const tmpl = yolo
    ? caps.runtime_yolo_command
    : (caps.runtime_default_command || caps.runtime_yolo_command);
  if (!tmpl) return false;
  const cmd = tmpl.replaceAll("{mode}", yolo ? "yolo" : "default");
  const bytes = new TextEncoder().encode(cmd + "\r");
  try { await ptyWrite(ptyId, Array.from(bytes)); return true; } catch { return false; }
}

// Old single-CLI accessors kept around so older call sites don't break.
export const yoloArgsForCli   = (cli: string) => findAgent(cli).caps.yolo_args   ?? [];
export const resumeArgsForCli = (cli: string) => findAgent(cli).caps.resume_args ?? [];

/** Per-agent env block (from Settings → Agents). Merged into the spawn
 *  env in TerminalPane; agent-side values take precedence over the
 *  built-in TERMIC_* / COLORFGBG block so users can override anything. */
export const envForCli = (cli: string): Record<string, string> => findAgent(cli).env;

/** Which agent ids should appear in the CLI pickers (worktree popover,
 *  New Workspace, Review, the + tab menu). Two filters, in order:
 *
 *    1. User `disabled` toggle (Settings → Agent CLIs) — ALWAYS
 *       respected. Hiding a disabled agent is an explicit choice.
 *    2. PATH detection — drop agents detected as not-installed.
 *
 *  Detection is unreliable (shell-function CLIs, stripped GUI PATH at
 *  .app launch), so step 2 never strands the user: before detection
 *  resolves (`detected` empty), or when filtering would empty the
 *  picker, the detection step is skipped and the enabled set returned
 *  whole. An id absent from `detected` defaults to visible. */
export function visibleCliIds(
  candidateIds: readonly string[],
  agents: Agent[],
  detected: Record<string, CliInfo>,
): Set<string> {
  const enabled = candidateIds.filter(
    id => !(agents.find(a => a.id === id)?.disabled ?? false),
  );
  if (Object.keys(detected).length === 0) return new Set(enabled);
  const installed = enabled.filter(id => detected[id]?.found ?? true);
  return new Set(installed.length ? installed : enabled);
}
