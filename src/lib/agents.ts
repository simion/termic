// Per-agent CLI knowledge, now driven by the editable agent registry in
// Settings → Agents (Settings.agents[] in the app store). Hard-coded
// fallbacks remain ONLY for the four built-ins so the app still works
// if the registry hasn't loaded yet (very first render before loadAll
// resolves) or if a user removed all agents.

import type { Agent, Task, CliInfo } from "@/lib/types";
import { useApp } from "@/store/app";
import { ptyWrite } from "@/lib/ipc";
import { slugify } from "@/lib/utils";

/** Variables that can be referenced in any agent arg via `{name}` placeholders.
 *  Lets the user write things like `--name {WORKSPACE_SLUG}` in Settings →
 *  Agents and have it expand per-worktree at spawn time. Supported keys
 *  (case-insensitive — `{UUID}` and `{uuid}` both work):
 *    {UUID}            → termic-minted agent session uuid (only present
 *                        when buildArgs was given a sessionUuid)
 *    {WORKSPACE_SLUG}  → slugified task name (e.g. "improve-tests")
 *    {WORKSPACE_NAME}  → raw task name
 *    {WORKSPACE_ID}    → task's own uuid
 *    {WORKSPACE_PATH}  → absolute path of the task dir (worktree path
 *                        for worktree tasks, repo root otherwise) —
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
 *  single argv element. Used for the per-task resume override. */
function tokenizeArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  }
  return out;
}
function taskVars(task: Task | undefined, sessionUuid?: string): Record<string, string> {
  const base: Record<string, string> = task ? {
    WORKSPACE_SLUG: slugify(task.name),
    WORKSPACE_NAME: task.name,
    WORKSPACE_ID: task.id,
    WORKSPACE_PATH: task.path,
    BRANCH: task.branch,
    PORT: String(task.port),
    // Lowercase aliases. `task_*` is the new preferred set; `workspace_*` is
    // kept as a read alias so templates saved before the workspace->task rename
    // (users may have `--resume {workspace_name}` in resume_override / name_args)
    // still expand instead of leaking the literal token to the CLI.
    task_slug: slugify(task.name),
    task_name: task.name,
    task_id: task.id,
    task_path: task.path,
    workspace_slug: slugify(task.name),
    workspace_name: task.name,
    workspace_id: task.id,
    workspace_path: task.path,
    branch: task.branch,
    port: String(task.port),
  } : {};
  if (sessionUuid) {
    base.UUID = sessionUuid;
    base.uuid = sessionUuid;
  }
  return base;
}

/** True iff the agent supports termic-minted deterministic sessions
 *  (both session_id_args + resume_id_args configured — e.g. claude). */
export function cliSupportsIdSession(cli: string): boolean {
  const { caps } = findAgent(cli);
  return (caps.session_id_args?.length ?? 0) > 0
      && (caps.resume_id_args?.length ?? 0) > 0;
}

/** True iff the agent uses post-exit capture for its session ID:
 *  has resume_id_args but NO session_id_args (opencode). First spawn
 *  is fresh; on exit, post_launch_capture runs and stores the ID so
 *  subsequent spawns use resume_id_args to resume that specific session. */
export function cliSupportsCaptureResume(cli: string): boolean {
  const { caps } = findAgent(cli);
  return (caps.session_id_args?.length ?? 0) === 0
      && (caps.resume_id_args?.length ?? 0) > 0;
}

/** Post-launch capture config for a CLI, or undefined if not configured. */
export function postLaunchCaptureForCli(cli: string): Agent["post_launch_capture"] {
  const registry = useApp.getState().agents;
  const a = registry.find(x => x.id === cli);
  if (a) return a.post_launch_capture;
  return BUILTIN_FALLBACK[cli]?.post_launch_capture;
}

/** Hard-coded fallback for the built-ins. Used only when the registry
 *  doesn't have an entry for `cli` yet (pre-load) or when the registry
 *  is empty. The registry is the source of truth in steady state. */
const BUILTIN_FALLBACK: Record<string, Pick<Agent, "command" | "args" | "post_launch_capture"> & {
  capabilities: NonNullable<Agent["capabilities"]>;
}> = {
  claude: {
    command: "claude", args: [],
    capabilities: {
      yolo_args: ["--dangerously-skip-permissions"],
      runtime_yolo_command: "",
      // Legacy: takes most-recent session in CWD. Still seeded so
      // tasks created before id-based resume keep working — but
      // the id-based path (session_id_args + resume_id_args) wins
      // whenever a uuid is stored on the task.
      resume_args: ["--continue"],
      // Termic-owned deterministic sessions. First spawn mints a
      // uuid via --session-id; subsequent spawns --resume that uuid.
      // Lets repo-root tasks auto-resume without grabbing
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
  opencode: {
    command: "opencode", args: [],
    capabilities: {
      // opencode creates sessions lazily (only after the first message),
      // so termic can't mint or pass a UUID at spawn time. Instead:
      //   - worktrees: `--continue` resumes the most-recent CWD session
      //     (safe because each worktree has its own directory).
      //   - after first message: post_launch_capture fires, captures the
      //     session ID from `opencode session list`, stores it on the tab.
      //   - subsequent spawns: `--session <captured-id>` via resume_id_args.
      resume_args: ["--continue"],
      resume_id_args: ["--session", "{UUID}"],
      yolo_args: [],
      runtime_yolo_command: "",
    },
    post_launch_capture: {
      // Run on first PTY exit when no session ID is stored yet. stdout
      // (trimmed) becomes the tab's resume session ID for subsequent spawns.
      command: "opencode session list | grep -m1 '^ses_' | cut -d' ' -f1",
    },
  },
};

/** Helper to get an agent's display name by its id. Consulting the registry first,
 *  then falling back to built-in names and finally returning the id itself. */
/** Display label for a terminal tab: a user-set custom title wins, then the
 *  live (OSC-driven) title, then the static title. Shared by the tab strip,
 *  message queue, broadcast, and the prompt destination picker. */
export function tabLabel(t: { customTitle?: boolean; title: string; liveTitle?: string | null }): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

export function agentDisplayName(cli: string, agents: Agent[] = useApp.getState().agents): string {
  const a = agents.find(x => x.id === cli);
  if (a) return a.display_name;
  // Fallback for built-ins if the registry is not yet loaded or empty
  switch (cli) {
    case "claude": return "Claude";
    case "codex":  return "Codex";
    case "agy":      return "Antigravity";
    case "opencode": return "opencode";
    case "shell":    return "Terminal";
    case "custom":   return "Command";
    default:         return cli;
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

/** Compiled per pattern source, forever. classifyAgentTitle runs on every OSC
 *  0/2 title change, and an agent repaints its title once per spinner frame —
 *  so an uncached compile is a `new RegExp` burst per frame per terminal. The
 *  key space is bounded by what a user types into Settings. `null` caches a
 *  pattern that doesn't compile, so a bad one isn't retried every frame. */
const signalCache = new Map<string, RegExp | null>();

/** Compile regex sources, skipping any that fail to compile. A user's bad
 *  pattern must never throw inside the terminal title/data path, so this is
 *  parse-at-the-boundary: invalid sources are dropped, valid ones kept. */
export function compileSignals(sources: string[] | undefined): RegExp[] {
  if (!sources?.length) return [];
  const out: RegExp[] = [];
  for (const src of sources) {
    if (!src) continue;
    let re = signalCache.get(src);
    if (re === undefined) {
      try { re = new RegExp(src); } catch { re = null; /* invalid pattern */ }
      signalCache.set(src, re);
    }
    if (re) out.push(re);
  }
  return out;
}

export type WorkState = "busy" | "idle" | "attention";

export type SignalPatterns = { busy?: string[]; idle?: string[]; attention?: string[] };

/** The built-in title heuristics for the two CLIs that have them, expressed as
 *  the same regex sources a user would type. Two jobs: they ARE the classifier
 *  below (no second copy to drift), and Settings shows them as the placeholder
 *  for an empty field, so what runs today is visible and copyable rather than
 *  buried in this file.
 *
 *  Written to survive being copied verbatim into the fields, which is the whole
 *  point of a placeholder: claude's busy pattern excludes ✳ so it can't win the
 *  busy-before-idle precedence against claude's own done glyph. The old inline
 *  code got away with an unqualified "leading non-alphanumeric" busy test only
 *  because it checked idle first. */
export const BUILTIN_TITLE_SIGNALS: Record<string, Required<SignalPatterns>> = {
  claude: {
    attention: [],
    // Any leading glyph that isn't the ✳ brand mark is a spinner frame. We've
    // seen Braille (U+2800..U+28FF) and combinations like "⠐ ⠂".
    busy: ["^\\s*[^A-Za-z0-9\\s✳]"],
    idle: ["^\\s*✳"],
  },
  codex: {
    attention: ["\\b(Waiting|Action Required)\\b"],
    busy: ["\\b(Working|Thinking)\\b", "^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]"],
    idle: ["\\bReady\\b"],
  },
};

/** Classify a terminal title into a work-done state for `cli`. The agent's
 *  user-configured `signals` drive it when set; otherwise the built-in
 *  heuristics above do, and an agent with neither returns null (its state
 *  comes from OSC signals, or from the fallback heuristics in TerminalPane).
 *
 *  Precedence is attention > busy > idle, mirroring the OSC handler priority.
 *  A busy title that is wrong self-corrects on the next title or on byte-quiet;
 *  a missed busy means a premature done, which is the worse failure.
 *
 *  Pure and total — never throws on a bad user pattern (see compileSignals).
 *  Registry-driven replacement for TerminalPane's old inline classifier (#68). */
export function classifyAgentTitle(
  cli: string,
  title: string,
  agents: Agent[] = useApp.getState().agents,
): WorkState | null {
  const t = title.trim();
  if (!t) return null;
  const user = agents.find(a => a.id === cli)?.capabilities?.signals;
  const sig = user && (user.busy?.length || user.idle?.length || user.attention?.length)
    ? user
    : BUILTIN_TITLE_SIGNALS[cli];
  if (!sig) return null;
  if (compileSignals(sig.attention).some(re => re.test(t))) return "attention";
  if (compileSignals(sig.busy).some(re => re.test(t))) return "busy";
  if (compileSignals(sig.idle).some(re => re.test(t))) return "idle";
  return null;
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
 *  are shell-quoted automatically (a task path with a space must not
 *  word-split, and a name with `$`/`'` must not inject) — so users write
 *  bare `{task_path}`, not `"{task_path}"`. Empty command →
 *  undefined (plain login shell, same as a Terminal tab). */
export function terminalLaunchCommand(cli: string, task?: Task): string | undefined {
  const { command, args } = findAgent(cli);
  const line = [command, ...args].join(" ").trim();
  if (!line) return undefined;
  const vars = Object.fromEntries(
    Object.entries(taskVars(task)).map(([k, v]) => [k, shellQuote(v)]),
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

/** Per-tab resume decision. Pure — given the tab/task shape it picks
 *  exactly one resume strategy. Every agent tab (primary AND secondary)
 *  resumes now; the per-tab `storedUuid` is what makes that safe, so two
 *  agents in one task never share a session.
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
  /** `cliSupportsIdSession(cli)` — true when the agent has both session_id_args and resume_id_args. */
  idCapable: boolean;
  /** `cliSupportsCaptureResume(cli)` — opencode true. Has resume_id_args but
   *  no session_id_args: first spawn is fresh, subsequent spawns (after
   *  post_launch_capture stores the ID) use resume_id_args. */
  captureCapable?: boolean;
  /** Primary = the auto-created default tab OR the first tab of its cli.
   *  Gates the override + cwd-resume paths (see above). */
  isPrimary: boolean;
  isRepoRoot: boolean;
  hasResumableHistory: boolean;
  /** This tab's own stored session uuid (TerminalTab.sessionId), if minted. */
  storedUuid?: string;
  /** Raw `task.resume_override` (gated to the primary tab here). */
  resumeOverride?: string;
  /** A resume attempt for this tab just rapid-exited → skip the stored
   *  uuid / cwd-resume and start fresh on the immediate retry. */
  failedResume: boolean;
}): ResumeDecision {
  if (!opts.isAgent) return { kind: "fresh" };

  const override = opts.isPrimary ? opts.resumeOverride?.trim() : undefined;
  if (override) return { kind: "override", override };

  if (opts.idCapable) {
    // Legacy worktree main tab: a pre-per-tab-uuid task that already
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
 *  the task shape (worktree vs repo-root) — the caller decides
 *  which mode applies and passes the right inputs:
 *
 *    A. id-based resume (REPO-ROOT id-capable CLIs):
 *       The shared cwd would let `--continue` lasso external sessions,
 *       so termic owns a UUID per (task, cli) pair.
 *       - `sessionUuid` provided AND `resumeKnown` → `resume_id_args`
 *         (subsequent spawn).
 *       - `sessionUuid` provided AND NOT `resumeKnown` → `session_id_args`
 *         (first spawn — mint + tell the agent to use this id).
 *
 *    B. cwd-based resume (WORKTREE tasks):
 *       Each worktree has its own directory, so the agent's most-recent
 *       CWD session IS this task's session — `--continue` / equivalent
 *       just works.
 *       - `opts.resume` true → append `resume_args`.
 *
 *    C. name_args (claude `--name`):
 *       - Appended on every primary-tab spawn (worktree or repo-root,
 *         mint or resume) so the task name is always visible.
 *       - Skipped for secondary "+" tabs (`isPrimary=false`) and
 *         no-task spawns (`task` absent).
 *
 *    D. always-applied:
 *       - `yolo_args` appended LAST so a subcommand-style resume
 *         (`codex resume --last <yolo>`) attaches its global flag to
 *         the subcommand instead of the root binary.
 */
/** Extra args composed into UNATTENDED spawns only (a prompt will be
 *  injected with no human at the keyboard, e.g. run-prompt "new agent"):
 *  suppress startup update checks so a blocking "Update available!" menu
 *  can't swallow the injected prompt (codex's preselects "Update now", so
 *  the injected Enter would launch a curl|sh self-update). Attended spawns
 *  deliberately keep the CLI's normal startup behavior: asking about
 *  updates is fine when someone is watching. */
export const UNATTENDED_SPAWN_ARGS: Record<string, string[]> = {
  // Official config key (verified live on codex 0.144.1); `-c` is a global
  // flag, so it composes with the `resume --last` subcommand placed after.
  codex: ["-c", "check_for_update_on_startup=false"],
  // xAI's documented flag for scripted/automated launches.
  grok: ["--no-auto-update"],
};

export function spawnArgsForCli(
  cli: string,
  opts: {
    yolo: boolean;
    resume: boolean;
    task?: Task;
    /** True for the auto-created default tab; false for user-added "+" tabs.
     *  Gates name_args — secondary tabs start fresh and shouldn't get --name. */
    isPrimary?: boolean;
    /** Termic-minted uuid for this (task, cli) pair. Presence
     *  switches the resume path from (B) to (A). */
    sessionUuid?: string;
    /** True iff the uuid was already used in a prior spawn (so the
     *  agent has a session file for it). False = first spawn, mint it. */
    resumeKnown?: boolean;
    /** Per-task verbatim resume override (e.g. `--resume {WORKSPACE_NAME}`).
     *  When non-empty it REPLACES both the id-based and cwd-based resume
     *  blocks — the caller is expected to have already suppressed the uuid
     *  mint / `opts.resume` so they don't double up. The agent owns the
     *  "session not found" case, so there's no fast-exit fallback. */
    resumeOverride?: string;
    /** True when a prompt will be injected without a human at the keyboard.
     *  Composes UNATTENDED_SPAWN_ARGS so startup update menus can't
     *  swallow the injection. */
    unattended?: boolean;
  },
): string[] {
  const { args, caps } = findAgent(cli);
  const vars = taskVars(opts.task, opts.sessionUuid);

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
    // Before the resume block: codex's resume is a subcommand, and these
    // are root-binary globals.
    ...(opts.unattended ? (UNATTENDED_SPAWN_ARGS[cli] ?? []) : []),
    ...resumeBlock,
    // name_args on every primary-tab spawn (worktree or repo-root, mint or
    // resume) so claude always shows the task name. Skipped for
    // secondary "+" tabs (isPrimary=false) and no-task spawns.
    ...(opts.isPrimary && opts.task ? (caps.name_args ?? []) : []),
    ...(opts.yolo ? (caps.yolo_args ?? []) : []),
  ];
  return composed.map(a => expandArg(a, vars));
}

/** Send the live YOLO toggle command if the agent supports it. Today only
 *  Some agents support a live toggle command; others need a respawn. */
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
 *  New Task, Review, the + tab menu). Terminal-kind entries are
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
