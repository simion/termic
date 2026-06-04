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
 *  Lets the user write things like `--name {WORKSPACE_SLUG}` in Settings →
 *  Agents and have it expand per-worktree at spawn time. Supported keys
 *  (case-insensitive — `{UUID}` and `{uuid}` both work):
 *    {UUID}            → termic-minted agent session uuid (only present
 *                        when buildArgs was given a sessionUuid)
 *    {WORKSPACE_SLUG}  → slugified workspace name (e.g. "improve-tests")
 *    {WORKSPACE_NAME}  → raw workspace name
 *    {WORKSPACE_ID}    → workspace's own uuid
 *    {BRANCH}          → git branch
 *    {PORT}            → assigned dev port
 *  Unknown placeholders pass through unchanged so weird arg shapes don't
 *  silently mangle. */
function expandArg(arg: string, vars: Record<string, string>): string {
  return arg.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => {
    const v = vars[k] ?? vars[k.toLowerCase()] ?? vars[k.toUpperCase()];
    return v ?? m;
  });
}
function workspaceVars(ws: Workspace | undefined, sessionUuid?: string): Record<string, string> {
  const base: Record<string, string> = ws ? {
    WORKSPACE_SLUG: slugify(ws.name),
    WORKSPACE_NAME: ws.name,
    WORKSPACE_ID: ws.id,
    BRANCH: ws.branch,
    PORT: String(ws.port),
    // Lowercase aliases — legacy, the original placeholder set.
    workspace_slug: slugify(ws.name),
    workspace_name: ws.name,
    workspace_id: ws.id,
    branch: ws.branch,
    port: String(ws.port),
  } : {};
  if (sessionUuid) {
    base.UUID = sessionUuid;
    base.uuid = sessionUuid;
  }
  return base;
}

/** True iff the agent supports termic-owned deterministic sessions
 *  (both session_id_args + resume_id_args configured). */
export function cliSupportsIdSession(cli: string): boolean {
  const { caps } = findAgent(cli);
  return (caps.session_id_args?.length ?? 0) > 0
      && (caps.resume_id_args?.length ?? 0) > 0;
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
      // Legacy: takes most-recent session in CWD. Still seeded so
      // workspaces created before id-based resume keep working — but
      // the id-based path (session_id_args + resume_id_args) wins
      // whenever a uuid is stored on the workspace.
      resume_args: ["--continue"],
      // Termic-owned deterministic sessions. First spawn mints a
      // uuid via --session-id; subsequent spawns --resume that uuid.
      // Lets repo-root workspaces auto-resume without grabbing
      // unrelated sessions from the same cwd.
      // First (mint) spawn uses --session-id to create the session with
      // termic's uuid; later spawns --resume that same uuid.
      session_id_args: ["--session-id", "{UUID}"],
      resume_id_args:  ["--resume",     "{UUID}"],
      // Display name surfaces in claude's prompt box, /resume picker, and
      // terminal title. Stamped on the mint spawn only (gated below).
      name_args: ["--name", "{WORKSPACE_SLUG}"],
    },
  },
  gemini: {
    command: "gemini", args: [],
    capabilities: {
      yolo_args: ["--yolo"],
      runtime_yolo_command: "/approval-mode yolo",
      runtime_default_command: "/approval-mode default",
      // Legacy fallback for workspaces without a stored uuid yet.
      resume_args: ["--resume", "latest"],
      session_id_args: ["--session-id", "{UUID}"],
      resume_id_args:  ["--resume",     "{UUID}"],
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
    case "custom": return "Command";
    default:       return cli;
  }
}

/** Whether work-done detection runs for a terminal tab's agent. Mirrors
 *  the runtime gate in TerminalPane (`tab.cli !== "shell" && (work_done ?? true)`):
 *  plain shells never qualify, and any agent whose registry entry has
 *  `work_done === false` is opted out. Unknown / custom clis default on. */
export function workDoneCapable(cli: string, agents: Agent[] = useApp.getState().agents): boolean {
  if (cli === "shell") return false;
  const a = agents.find(x => x.id === cli);
  return a?.work_done !== false;
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
        session_id_args: a.capabilities?.session_id_args ?? [],
        resume_id_args: a.capabilities?.resume_id_args ?? [],
        name_args: a.capabilities?.name_args ?? [],
      },
      env: { ...(a.env ?? {}) },
    };
  }
  const fb = BUILTIN_FALLBACK[cli];
  if (fb) return { command: fb.command, args: [...fb.args], caps: fb.capabilities, env: {} };
  // Unknown custom agent that's been deleted — best effort: use the cli id
  // as the command so the user at least sees "command not found" instead of
  // a silent black terminal.
  return { command: cli, args: [], caps: { yolo_args: [], runtime_yolo_command: "", resume_args: [], session_id_args: [], resume_id_args: [], name_args: [] }, env: {} };
}

/** Resolved spawn command for an agent. The command is whatever the user
 *  configured in Settings → Agents (lets people point at custom wrappers,
 *  pnpm scripts, etc. without code changes). */
export function spawnCommandForCli(cli: string): string {
  return findAgent(cli).command;
}

/** Compose the full args list for a spawn. Two resume modes, picked by
 *  the workspace shape (worktree vs repo-root) — the caller decides
 *  which mode applies and passes the right inputs:
 *
 *    A. id-based resume (REPO-ROOT id-capable CLIs):
 *       The shared cwd would let `--continue` lasso external sessions,
 *       so termic owns a UUID per (workspace, cli) pair.
 *       - `sessionUuid` provided AND `resumeKnown` → `resume_id_args`
 *         (subsequent spawn).
 *       - `sessionUuid` provided AND NOT `resumeKnown` → `session_id_args`
 *         (first spawn — mint + tell the agent to use this id).
 *
 *    B. cwd-based resume (WORKTREE workspaces):
 *       Each worktree has its own directory, so the agent's most-recent
 *       CWD session IS this workspace's session — `--continue` / equivalent
 *       just works.
 *       - `opts.resume` true → append `resume_args`.
 *
 *    C. name_args (claude `--name`):
 *       - Appended on every primary-tab spawn (worktree or repo-root,
 *         mint or resume) so the workspace name is always visible.
 *       - Skipped for secondary "+" tabs (`isPrimary=false`) and
 *         no-workspace spawns (`ws` absent).
 *
 *    D. always-applied:
 *       - `yolo_args` appended LAST so a subcommand-style resume
 *         (`codex resume --last <yolo>`) attaches its global flag to
 *         the subcommand instead of the root binary.
 */
export function spawnArgsForCli(
  cli: string,
  opts: {
    yolo: boolean;
    resume: boolean;
    ws?: Workspace;
    /** True for the auto-created default tab; false for user-added "+" tabs.
     *  Gates name_args — secondary tabs start fresh and shouldn't get --name. */
    isPrimary?: boolean;
    /** Termic-minted uuid for this (workspace, cli) pair. Presence
     *  switches the resume path from (B) to (A). */
    sessionUuid?: string;
    /** True iff the uuid was already used in a prior spawn (so the
     *  agent has a session file for it). False = first spawn, mint it. */
    resumeKnown?: boolean;
  },
): string[] {
  const { args, caps } = findAgent(cli);
  const vars = workspaceVars(opts.ws, opts.sessionUuid);

  const hasIdResume = (caps.session_id_args?.length ?? 0) > 0
                   && (caps.resume_id_args?.length ?? 0) > 0;
  let resumeBlock: string[] = [];
  // True ONLY on the spawn that mints the session (session_id_args:
  // sessionUuid present and not yet known to the agent). This is the
  // single spawn that carries name_args.
  let isFirstIdSpawn = false;
  if (hasIdResume && opts.sessionUuid) {
    if (opts.resumeKnown) {
      resumeBlock = caps.resume_id_args ?? [];
    } else {
      resumeBlock = caps.session_id_args ?? [];
      isFirstIdSpawn = true;
    }
  } else if (opts.resume) {
    resumeBlock = caps.resume_args ?? [];
  }

  const composed = [
    ...args,
    ...resumeBlock,
    // name_args on every primary-tab spawn (worktree or repo-root, mint or
    // resume) so claude always shows the workspace name. Skipped for
    // secondary "+" tabs (isPrimary=false) and no-workspace spawns.
    ...(opts.isPrimary && opts.ws ? (caps.name_args ?? []) : []),
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
