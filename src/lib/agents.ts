// Per-agent CLI knowledge, now driven by the editable agent registry in
// Settings → Agents (Settings.agents[] in the app store). Hard-coded
// fallbacks remain ONLY for the three built-ins so the app still works
// if the registry hasn't loaded yet (very first render before loadAll
// resolves) or if a user removed all agents.

import type { Agent, Workspace } from "@/lib/types";
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

/** Hard-coded fallback for the three built-ins. Used only when the
 *  registry doesn't have an entry for `cli` yet (pre-load) or when the
 *  registry is empty. The registry is the source of truth in steady state. */
const BUILTIN_FALLBACK: Record<string, Pick<Agent, "command" | "args"> & {
  capabilities: NonNullable<Agent["capabilities"]>;
}> = {
  claude: {
    command: "claude",
    // `--session-id <uuid>` (claude pre-2.2) / `--name <name>` (claude 2.2+):
    // give every spawn a stable name tied to the worktree so `--resume`
    // below can target THIS conversation deterministically instead of
    // grabbing the most-recent session in CWD (which can collide with
    // other claude invocations the user made outside termic).
    args: ["--name", "{workspace_slug}"],
    capabilities: {
      yolo_args: ["--dangerously-skip-permissions"],
      runtime_yolo_command: "",
      // Resume the named session deterministically. Beats `--continue`
      // because it's predictable across multiple parallel sessions.
      resume_args: ["--resume", "{workspace_slug}"],
    },
  },
  gemini: {
    command: "gemini", args: [],
    capabilities: {
      yolo_args: ["--yolo"],
      runtime_yolo_command: "/approval-mode {mode}",
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
};

function findAgent(cli: string): { command: string; args: string[]; caps: NonNullable<Agent["capabilities"]> } {
  const registry = useApp.getState().agents;
  const a = registry.find(a => a.id === cli);
  if (a) {
    return {
      command: a.command,
      args: [...a.args],
      caps: {
        yolo_args: a.capabilities?.yolo_args ?? [],
        runtime_yolo_command: a.capabilities?.runtime_yolo_command ?? "",
        resume_args: a.capabilities?.resume_args ?? [],
      },
    };
  }
  const fb = BUILTIN_FALLBACK[cli];
  if (fb) return { command: fb.command, args: [...fb.args], caps: fb.capabilities };
  // Unknown custom agent that's been deleted — best effort: use the cli id
  // as the command so the user at least sees "command not found" instead of
  // a silent black terminal.
  return { command: cli, args: [], caps: { yolo_args: [], runtime_yolo_command: "", resume_args: [] } };
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
  const tmpl = caps.runtime_yolo_command;
  if (!tmpl) return false;
  const cmd = tmpl.replaceAll("{mode}", yolo ? "yolo" : "default");
  const bytes = new TextEncoder().encode(cmd + "\r");
  try { await ptyWrite(ptyId, Array.from(bytes)); return true; } catch { return false; }
}

// Old single-CLI accessors kept around so older call sites don't break.
export const yoloArgsForCli   = (cli: string) => findAgent(cli).caps.yolo_args   ?? [];
export const resumeArgsForCli = (cli: string) => findAgent(cli).caps.resume_args ?? [];
