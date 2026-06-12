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
 *    {WORKSPACE_PATH}  → absolute path of the workspace dir (worktree path
 *                        for worktree workspaces, repo root otherwise) —
 *                        lets a custom terminal vary e.g. a `docker exec
 *                        -w` mount path per worktree (#27)
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
/** Split a free-form command string into argv tokens, honoring single /
 *  double quotes so a literal value with spaces stays one arg. Placeholders
 *  (`{WORKSPACE_NAME}`) are single unquoted tokens here and get expanded
 *  AFTER the split, so a placeholder whose value contains spaces is still a
 *  single argv element. Used for the per-workspace resume override. */
function tokenizeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  }
  return out;
}
function workspaceVars(ws: Workspace | undefined, sessionUuid?: string): Record<string, string> {
  const base: Record<string, string> = ws ? {
    WORKSPACE_SLUG: slugify(ws.name),
    WORKSPACE_NAME: ws.name,
    WORKSPACE_ID: ws.id,
    WORKSPACE_PATH: ws.path,
    BRANCH: ws.branch,
    PORT: String(ws.port),
    // Lowercase aliases — legacy, the original placeholder set.
    workspace_slug: slugify(ws.name),
    workspace_name: ws.name,
    workspace_id: ws.id,
    workspace_path: ws.path,
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

/** The canonical kind predicate for a registry entry. Missing `kind`
 *  means "agent" (entries predating #27). Every consumer should call
 *  this rather than re-inlining the `?? "agent"` defaulting. */
export function isTerminalEntry(a: Pick<Agent, "kind"> | undefined): boolean {
  return (a?.kind ?? "agent") === "terminal";
}

/** True when a tab's cli resolves to terminal-style SPAWN semantics: the
 *  plain-shell sentinel, the custom-command sentinel, or a registry entry
 *  with `kind: "terminal"` (a custom terminal, #27). These tabs never
 *  resume, never get YOLO args, and default unchecked in broadcast.
 *  NOTE this is not the work-done/queue gate — that's workDoneCapable,
 *  which deliberately KEEPS custom-command tabs on (a custom command may
 *  wrap a remote agent over ssh that emits real OSC signals). */
export function isTerminalCli(cli: string, agents: Agent[] = useApp.getState().agents): boolean {
  if (cli === "shell" || cli === "custom") return true;
  return isTerminalEntry(agents.find(x => x.id === cli));
}

/** Whether work-done detection runs for a terminal tab's cli. THE single
 *  gate — TerminalPane's state machine (OSC handlers, submit-window
 *  promotion, settled-detection interval) and the queue/right-split UIs
 *  all call this, so the rule can't drift between paths. Plain shells and
 *  terminal-kind entries never qualify; any agent whose registry entry
 *  has `work_done === false` is opted out. Unknown / custom clis default
 *  on. Defaults to the LIVE registry so a Settings toggle takes effect
 *  without a terminal remount. */
export function workDoneCapable(cli: string, agents: Agent[] = useApp.getState().agents): boolean {
  if (cli === "shell") return false;
  const a = agents.find(x => x.id === cli);
  if (isTerminalEntry(a)) return false;
  return a?.work_done !== false;
}

/** Single-quote a value for safe interpolation into a `sh -c` line, only
 *  when it contains characters the shell would split or interpret. Plain
 *  flag-ish tokens pass through untouched so the composed line stays
 *  readable in `ps` output. */
function shellQuote(v: string): string {
  if (v === "" || /[^A-Za-z0-9_\-./:=@%+,]/.test(v)) {
    return `'${v.replaceAll("'", `'\\''`)}'`;
  }
  return v;
}

/** Launch command line for a registry terminal entry (kind: "terminal").
 *  Command + args are joined into ONE string, placeholders expanded, and
 *  the result is handed to the user's login shell (`zsh -lc`, see
 *  loginShellArgs) — so unlike agent commands, shell quoting and pipes
 *  work here, and rc-file PATH/aliases apply. Expanded placeholder VALUES
 *  are shell-quoted automatically (a workspace path with a space must not
 *  word-split, and a name with `$`/`'` must not inject) — so users write
 *  bare `{workspace_path}`, not `"{workspace_path}"`. Empty command →
 *  undefined (plain login shell, same as a Terminal tab). */
export function terminalLaunchCommand(cli: string, ws?: Workspace): string | undefined {
  const { command, args } = findAgent(cli);
  const line = [command, ...args].join(" ").trim();
  if (!line) return undefined;
  const vars = Object.fromEntries(
    Object.entries(workspaceVars(ws)).map(([k, v]) => [k, shellQuote(v)]),
  );
  return expandArg(line, vars);
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

/** Per-tab resume decision. Pure — given the tab/workspace shape it picks
 *  exactly one resume strategy. Every agent tab (primary AND secondary)
 *  resumes now; the per-tab `storedUuid` is what makes that safe, so two
 *  agents in one workspace never share a session.
 *
 *    override    → user's verbatim resume block (primary tab only).
 *    resume-id   → `--resume {storedUuid}` (id-capable, uuid already minted).
 *    mint        → `--session-id {newUuid}` (id-capable, first spawn — caller
 *                  generates the uuid and persists it once the spawn survives).
 *    cwd-resume  → `resume_args` (`--continue` / `codex resume --last`).
 *                  Cwd-based resume can't address a specific past session, so
 *                  it's gated to the PRIMARY tab: secondary tabs of a
 *                  cwd-only CLI (codex) would otherwise all grab the same
 *                  latest session, so they start fresh instead.
 *    fresh       → no resume.
 */
export type ResumeDecision =
  | { kind: "override"; override: string }
  | { kind: "resume-id" }
  | { kind: "mint" }
  | { kind: "cwd-resume" }
  | { kind: "fresh" };

export function decideResume(opts: {
  /** Is this an agent tab at all (false for shell / custom — those are fresh). */
  isAgent: boolean;
  /** `cliSupportsIdSession(cli)` — claude / gemini true, codex / agy false. */
  idCapable: boolean;
  /** Primary = the auto-created default tab OR the first tab of its cli.
   *  Gates the override + cwd-resume paths (see above). */
  isPrimary: boolean;
  isRepoRoot: boolean;
  hasResumableHistory: boolean;
  /** This tab's own stored session uuid (TerminalTab.sessionId), if minted. */
  storedUuid?: string;
  /** Raw `ws.resume_override` (gated to the primary tab here). */
  resumeOverride?: string;
  /** A resume attempt for this tab just rapid-exited → skip the stored
   *  uuid / cwd-resume and start fresh on the immediate retry. */
  failedResume: boolean;
}): ResumeDecision {
  if (!opts.isAgent) return { kind: "fresh" };

  const override = opts.isPrimary ? opts.resumeOverride?.trim() : undefined;
  if (override) return { kind: "override", override };

  if (opts.idCapable) {
    // Legacy worktree main tab: a pre-per-tab-uuid workspace that already
    // has a `--continue` conversation but no minted uuid. Keep continuing
    // it (cwd-resume below) rather than minting a brand-new session that
    // would orphan the existing one. Brand-new worktrees (no history yet)
    // skip this and mint straight away — cleaner, and no `--continue`
    // ambiguity once a second agent session exists in the same cwd.
    const legacyWorktreeContinue =
      !opts.isRepoRoot && opts.isPrimary && opts.hasResumableHistory && !opts.storedUuid;
    if (!legacyWorktreeContinue) {
      if (opts.storedUuid && !opts.failedResume) return { kind: "resume-id" };
      return { kind: "mint" };
    }
  }

  // Cwd-based resume: worktree only (repo-root's shared cwd would lasso
  // unrelated sessions), primary tab only, and only when there's a real
  // session on disk and we're not retrying a just-failed resume.
  if (!opts.isRepoRoot && opts.isPrimary && opts.hasResumableHistory && !opts.failedResume) {
    return { kind: "cwd-resume" };
  }
  return { kind: "fresh" };
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
    /** Per-workspace verbatim resume override (e.g. `--resume {WORKSPACE_NAME}`).
     *  When non-empty it REPLACES both the id-based and cwd-based resume
     *  blocks — the caller is expected to have already suppressed the uuid
     *  mint / `opts.resume` so they don't double up. The agent owns the
     *  "session not found" case, so there's no fast-exit fallback. */
    resumeOverride?: string;
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
  const override = opts.resumeOverride?.trim();
  if (override) {
    // Override wins outright — verbatim resume block, placeholders expanded
    // by the composed.map below. Skips minting / --continue entirely.
    resumeBlock = tokenizeArgs(override);
  } else if (hasIdResume && opts.sessionUuid) {
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
 *  New Workspace, Review, the + tab menu). Terminal-kind entries are
 *  excluded up front — they belong to the "New terminal" section of the
 *  + menu (filtered by `disabled` only, no PATH detection: their command
 *  is a free-form shell line that `which` can't probe), never to the
 *  agent pickers. Then two filters, in order:
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
  const enabled = candidateIds.filter(id => {
    const a = agents.find(x => x.id === id);
    return !(a?.disabled ?? false) && !isTerminalEntry(a);
  });
  if (Object.keys(detected).length === 0) return new Set(enabled);
  const installed = enabled.filter(id => detected[id]?.found ?? true);
  return new Set(installed.length ? installed : enabled);
}
