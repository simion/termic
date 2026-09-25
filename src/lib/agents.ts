// Per-agent CLI knowledge, now driven by the editable agent registry in
// Settings → Agents (Settings.agents[] in the app store). Hard-coded
// fallbacks remain ONLY for the four built-ins so the app still works
// if the registry hasn't loaded yet (very first render before loadAll
// resolves) or if a user removed all agents.

import { i18n } from "@/lib/i18n";
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

/** The agent can resume a SPECIFIC session by id (`resume_id_args`
 *  non-empty, regardless of whether it can also mint one): the gate for
 *  attaching an externally-started session to a task or tab (GH #169,
 *  `--resume <SESSION_ID>`). Mirrors AgentMeta.id_resume on the Rust
 *  side; keep the two predicates in step. */
export function cliSupportsResumeById(cli: string): boolean {
  const { caps } = findAgent(cli);
  return (caps.resume_id_args?.length ?? 0) > 0;
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
      // claude's own session picker (GH #311). Mirrors the Rust default.
      resume_picker_args: ["--resume"],
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
      // Right for a worktree (its cwd is its own), wrong for the repo root,
      // where several tasks share one cwd and "most recent" is somebody
      // else's conversation.
      resume_args: ["resume", "--last"],
      // So repo-root tasks resume by id instead. There is no `session_id_args`
      // pair because codex cannot be TOLD an id at launch (no `--session-id` on
      // the TUI; `resume <fresh-uuid>` errors rather than minting), which makes
      // this the capture shape opencode uses: `cliSupportsCaptureResume` is
      // true, and the id arrives from termic's own SessionStart hook rather
      // than from a post-exit shell command.
      resume_id_args: ["resume", "{UUID}"],
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
  // pi (pi.dev). Mirrors the Rust seeded default in lib.rs; the two tables must
  // agree, since this one is what runs before the registry has loaded.
  // `--session-id` MINTS when the id is unknown and RESUMES when it is known,
  // so both arg lists are identical on purpose. Verified on a live 0.84.3.
  pi: {
    command: "pi", args: [],
    capabilities: {
      yolo_args: [],
      runtime_yolo_command: "",
      resume_args: ["--continue"],
      session_id_args: ["--session-id", "{UUID}"],
      resume_id_args: ["--session-id", "{UUID}"],
      name_args: ["--name", "{WORKSPACE_SLUG}"],
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
  // Muse Code (Meta). Mirrors the Rust seeded default in lib.rs; the two
  // tables must agree, since this one is what runs before the registry loads.
  // The empty id-resume pair is deliberate and measured: `muse resume <uuid>`
  // exists, but `--session-id` is an `exec` (headless) flag that the TUI
  // rejects outright, so nothing can mint a termic-owned session for an
  // interactive spawn. Do not "fix" this into claude's two-flag shape.
  muse: {
    command: "muse", args: [],
    capabilities: {
      // One flag drops approval, muse's own sandbox, and the trust prompt.
      yolo_args: ["--yolo"],
      runtime_yolo_command: "",
      // Subcommand form, like codex. Composes with globals on either side,
      // verified: `muse --yolo resume --last` resumed with history intact.
      // Right for a worktree; in the repo root "last" is another task's
      // session, which is what the captured id below is for.
      resume_args: ["resume", "--last"],
      // No `session_id_args` pair: muse cannot be handed an id at launch, so
      // this is the CAPTURE shape (`cliSupportsCaptureResume`), same as
      // opencode. The id comes off disk, not from the agent.
      resume_id_args: ["resume", "{UUID}"],
    },
    post_launch_capture: {
      command: 'ls -td "${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions"/*/*/*/*/ 2>/dev/null | head -1 | sed "s:/*$::;s:.*/::"',
    },
  },
  // Devin (Cognition). Mirrors the Rust seeded default in lib.rs; the two
  // tables must agree, since this one is what runs before the registry loads.
  // Session ids are devin-minted slugs, so this is the capture shape opencode
  // uses: the id arrives from termic's SessionStart hook, and the `devin list`
  // capture is the backstop when hooks are not installed.
  devin: {
    command: "devin", args: [],
    capabilities: {
      yolo_args: ["--permission-mode", "dangerous"],
      runtime_yolo_command: "",
      // `--continue` takes the most-recent session in this cwd: right for a
      // worktree, wrong for the repo root where tasks share a cwd. The id
      // below is what disambiguates there.
      resume_args: ["--continue"],
      resume_id_args: ["--resume", "{UUID}"],
    },
    post_launch_capture: {
      // `devin list --format csv` prints a header row then this cwd's
      // sessions newest-first, and is not trust-gated (a bare `devin list`
      // is an interactive picker).
      command: "devin list --format csv 2>/dev/null | tail -n +2 | head -1 | cut -d, -f1",
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
    case "devin":    return "devin";
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

export type SignalPatterns = {
  busy?: string[];
  idle?: string[];
  attention?: string[];
  pending?: string[];
};

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
    // Claude's title CANNOT report needs-you: it paints the idle glyph while
    // blocked on a permission prompt, a question or plan approval (measured
    // repeatedly). An attention pattern here would have to match the idle glyph
    // itself, which would then fire on every completed turn. Left empty on
    // purpose; the hook is the only honest source for that state.
    attention: [],
    // Any leading glyph that is not the brand mark is a spinner frame. Kept as
    // a catch-all rather than a glyph list because the alphabet is not stable:
    // Braille (U+2800..U+28FF) and the circle family (◐◑◒◓) have both shipped.
    busy: ["^\\s*[^A-Za-z0-9\\s✳]"],
    idle: ["^\\s*✳"],
    // Claude paints the idle glyph the moment its own turn ends, including when
    // it has backgrounded work still running. Measured: the title went idle
    // 49.6s before a 55s job finished, and its own `Stop` fired three times
    // with a populated `background_tasks` before the real one. These are the
    // words on screen while that is true, and they are the FALLBACK for what
    // the Stop hook now reads out of the payload directly.
    pending: [
      "Waiting for \\d+ background agents? to finish",
      "\\d+ shells?(, \\d+ monitors?)? still running",
    ],
  },
  codex: {
    // Captured shape: "[ ! ] Action Required | <thread title> | proj",
    // alternating with "[ . ] …" (it blinks).
    //
    // ANCHORED AT THE START, and that is the whole point. Codex 0.154.0 renames
    // the thread mid-turn and renders the generated name through the same
    // `activity` title item, so the title now carries MODEL-WRITTEN PROSE:
    //
    //   ⠧ Create out.txt with hello | proj        busy, thread title
    //   ⠼ Explain Action Required | proj          busy, and those two words
    //
    // An unanchored `\bAction Required\b` matched that second one, and since
    // attention is tested BEFORE busy the spinner could never win it back: one
    // question about approvals or CI badged the tab needs-you for the rest of
    // the session while the agent worked. Genuine attention always leads the
    // title, behind the blink; the prose never does, because the activity item
    // precedes it.
    //
    // The bracket stays OPTIONAL rather than required (grok demands its `⚠`).
    // Older builds were measured emitting the bare words and nothing here has
    // re-measured them, so narrowing further would drop a form on reasoning
    // alone. Residual, accepted: a thread title that BEGINS "Action Required"
    // still matches. Codex's own attention hook is the authoritative source
    // for this agent either way (see docs/agent-hooks.md).
    attention: ["^\\s*(?:\\[\\s*[!.]\\s*\\]\\s*)?Action Required\\b"],
    // Braille as a RANGE, not the ten-frame list this used to spell out: a
    // spinner alphabet is not a stable contract, and a missed busy is the worse
    // failure because it ends the turn early.
    busy: ["^\\s*[\\u2800-\\u28FF]", "\\b(Working|Thinking)\\b"],
    // Codex 0.142.5 puts NO status word in its idle title: it is the cwd
    // basename alone ("proj"). `Ready` is kept for older builds that did. The
    // general form is "first non-space character is not a spinner frame";
    // busy and attention are both evaluated first, so this cannot steal them.
    idle: ["\\bReady\\b", "^\\s*[^\\s\\u2800-\\u28FF]"],
    pending: [],
  },
  grok: {
    // Two DIFFERENT blocked titles, both measured, and only one looks blocked:
    //   tool prompt:   "⚠ Action Required - ⠋ - Count 1-30… - grok"
    //   plan approval: "⠹ - Running: Plan: Exit - <plan title> - grok", which
    //                  FREEZES on one spinner frame (observed at 217s) and is
    //                  otherwise indistinguishable from working.
    // The second is why `Running: Plan: Exit` is an attention pattern: without
    // it a plan awaiting approval reads as busy forever.
    attention: ["⚠\\s*Action Required", "Running:\\s*Plan:\\s*Exit"],
    // NOTE the trap: grok's busy title says "Waiting for response…", meaning
    // waiting on the MODEL. Reusing codex's `\bWaiting\b` here would badge
    // needs-you on every single turn.
    busy: ["^\\s*[\\u2800-\\u28FF]"],
    // Idle is the session summary plus " - grok", or just "grok" at rest.
    idle: ["^\\s*[^\\s\\u2800-\\u28FF⚠]"],
    pending: [],
  },
  muse: {
    // Captured off a live Muse Code 1.0.2 PTY: OSC 0 is "⠻ musetest"
    // while the model runs and "musetest" (the workspace dir basename, bare)
    // when idle. Same braille-spinner-prefix shape codex and grok emit, so
    // the same two patterns cover it.
    busy: ["^\\s*[\\u2800-\\u28FF]"],
    idle: ["^\\s*[^\\s\\u2800-\\u28FF]"],
    // NOT measured, and left empty rather than guessed. Triggering muse's
    // approval prompt needs a real tool call, which needs a Meta account; the
    // offline `--provider echo` that every other fact here came from never
    // calls a tool. Patterns written from reasoning are exactly what c35d297
    // had to replace across every agent, so this waits for a real capture.
    attention: [],
    pending: [],
  },
  // ── Agents whose titles carry NO state ──────────────────────────────
  // Listed explicitly, with empty patterns, so the next person does not spend
  // an afternoon writing regexes for a title that never changes. All three were
  // captured over full runs:
  //   agy      emits no OSC 0 at all. Not "a static title": nothing.
  //   opencode "OpenCode", then the session summary. No state, ever.
  //   pi       "π - proj", set once at boot and never updated.
  //   devin    "devin: <dir>" → "devin: <prompt>" → "devin: <generated
  //            title>" (measured on a live 3000.10.21 turn): the title moves
  //            but carries no working/attention marker a pattern could catch.
  // Work state for these comes from their hooks; there is nothing to fall back
  // to, which is exactly why they were wired first.
  agy: { attention: [], busy: [], idle: [], pending: [] },
  opencode: { attention: [], busy: [], idle: [], pending: [] },
  pi: { attention: [], busy: [], idle: [], pending: [] },
  devin: { attention: [], busy: [], idle: [], pending: [] },
};

/** How many rows up from the bottom of the viewport `pending` patterns are
 *  tested. Claude's live status line sits just above its input box, with the
 *  mode footer under it; 8 rows covers that block on every layout we've
 *  recorded without reaching into conversation history.
 *
 *  A whole-viewport search would be wrong, not merely slower: "Waiting for 1
 *  background agent to finish" was still on screen 120s after that agent
 *  finished in one recording. Matching it there would pin the tab to busy
 *  until the 10-minute ceiling. */
export const PENDING_TAIL_ROWS = 8;

/** How long a fired `done` outranks a fresh busy signal from the agent.
 *
 *  Claude oscillates between its idle glyph and a spinner for a few frames
 *  right after a response, so a "back to working" inside this window is that
 *  flicker and gets ignored (otherwise every turn ends in a second done badge).
 *  Past it, a busy signal is the agent genuinely working, and our done was
 *  wrong: a long multi-stage turn that one of the heuristics cut short.
 *
 *  It must stay a WINDOW rather than the flat "agent signals can never undo a
 *  done" rule it replaced. Under that rule a premature done was unrecoverable:
 *  the spinner stayed off for the rest of the turn no matter how loudly the
 *  agent kept working, the turn's one done token was already spent so the real
 *  completion fired nothing, and the only way out was clicking the tab. 8s is
 *  comfortably past the observed oscillation (1-3s) and well under a stage of
 *  real work. Shared by the store's transition gate and the pane's
 *  one-done-per-submit token so the two can't disagree about which it is. */
export const STICKY_DONE_MS = 8_000;

/** How long after a needs-you a SECOND needs-you counts as the same prompt
 *  being reported twice rather than the agent asking again.
 *
 *  One permission prompt marks attention twice, measured: termic's own hook
 *  fires the instant claude blocks, and claude's `OSC 9` ("Claude needs your
 *  permission") arrives a further 6.0s behind it. Both are correct; only the
 *  first is news, and the second must not raise a banner for a prompt the user
 *  has already been shown (GH #276).
 *
 *  It has to be a WINDOW rather than "an attention mark is already held", which
 *  was the first shape and had a hole worth remembering: a permission prompt is
 *  answered with a BARE KEY (`y`), and only Enter clears the mark, so a
 *  state-only test called the next genuine needs-you a repeat of one the user
 *  had already dealt with and went silent on it. 10s covers the observed echo
 *  with room; a genuine re-ask inside it can only happen with the user at the
 *  keyboard, where the focus gate suppresses the banner anyway. */
export const ATTENTION_ECHO_MS = 10_000;

/** True when the agent's own UI says it has work outstanding, so a "done" now
 *  would be a lie. `rows` is the visible buffer, top to bottom; only the last
 *  PENDING_TAIL_ROWS are considered.
 *
 *  Pure and total (see compileSignals) — a user's bad pattern must never throw
 *  on the path that decides whether to fire done. */
/** The built-in table an agent's behaviour should come from.
 *
 *  A duplicated agent inherits NOTHING today. Every per-agent table here is
 *  keyed by agent id, so a clone of claude made to hold a second login gets no
 *  title patterns, no notification filter and no pending-work patterns, and
 *  then behaves visibly worse than the agent it is a copy of. Measured on a
 *  real session, same body, ninety seconds apart:
 *
 *    notify-drop   cli=claude       body="Claude is waiting for your input"
 *    notify-badge  cli=next-claude  body="Claude is waiting for your input"
 *
 *  Claude's 60s idle nag, correctly ignored for claude and rung as needs-you
 *  for its own duplicate. With no title patterns either, that clone had no
 *  sender signal at all, so every fallback demotion badged `attention` rather
 *  than `done` and turns ended on the settled-hash heuristic.
 *
 *  `extends` already records what a clone was copied from and was cosmetic,
 *  shown in the Settings card header. Walking it is the whole fix. A user's own
 *  `capabilities.signals` still wins, and is still looked up by the agent's
 *  REAL id: inheritance is for the built-in defaults, not for their overrides.
 *
 *  Depth-capped rather than cycle-detected, because ids are user-editable and
 *  a chain that points at itself must terminate, not hang. */
const EXTENDS_MAX_DEPTH = 8;

/** Per-agent footnote appended to the "YOLO args" hint (GH #274).
 *
 *  The shipped default is not always ACCEPTED: an agent CLI can carry its own
 *  policy layer that outranks the flag Termic passes, and the failure lands as
 *  a startup error in the terminal with nothing pointing back at the field
 *  that caused it. Keyed by the BUILT-IN BASE id (`builtinBaseId` walks
 *  `extends`) so a clone of codex gets the same note.
 *
 *  No em dashes: this is user-visible copy (see CLAUDE.md ## Copy rules). */
/** Values are backend:agentUsage KEYS, resolved by `yoloArgsNote` at render
 *  so a language switch applies; the quoted CLI error and flags stay verbatim
 *  in every language because they are what the user matches against. */
export const YOLO_ARGS_NOTES: Record<string, string> = {
  codex: "yoloCodex",
};

/** The caveat text for a base CLI, localized. Undefined when it has none. */
export function yoloArgsNote(cli: string): string | undefined {
  const key = YOLO_ARGS_NOTES[cli];
  return key ? i18n.t(`backend:agentUsage.${key}`) : undefined;
}

export function builtinBaseId(cli: string, agents: Agent[]): string {
  let id = cli;
  for (let i = 0; i < EXTENDS_MAX_DEPTH; i++) {
    if (BUILTIN_TITLE_SIGNALS[id] || BUILTIN_NOTIFY_IGNORE[id] || BUILTIN_NOTIFY_ATTENTION[id]) {
      return id;
    }
    const next = agents.find(a => a.id === id)?.extends;
    if (!next || next === id) break;
    id = next;
  }
  return id;
}

export function hasPendingWork(
  cli: string,
  rows: string[],
  agents: Agent[] = useApp.getState().agents,
): boolean {
  const user = resolveAgent(agents, cli)?.capabilities?.signals?.pending;
  const src = user?.length ? user : BUILTIN_TITLE_SIGNALS[builtinBaseId(cli, agents)]?.pending;
  if (!src?.length) return false;
  const res = compileSignals(src);
  if (!res.length) return false;
  const tail = rows.slice(-PENDING_TAIL_ROWS);
  return tail.some(r => {
    const line = r.trim();
    return line ? res.some(re => re.test(line)) : false;
  });
}

/** OSC 9 / OSC 777 bodies that are NOT worth a badge. Everything else an agent
 *  puts in a notification is treated as "it wants you", which is what asking
 *  the terminal to notify means.
 *
 *  Claude sends exactly two, distinguishable by body and by a fixed delay
 *  after its title goes idle:
 *    "Claude needs your permission"      6.0s   — really blocked on you
 *    "Claude is waiting for your input"  60.0s  — you have just been idle a
 *                                                 minute; its turn ended long
 *                                                 ago and we already said so.
 *  Badging the second would ring a bell a minute after every turn you did not
 *  immediately reply to. */
/** Built-in patterns matched against a line of OUTPUT, not the title.
 *
 *  Deliberately separate from `BUILTIN_TITLE_SIGNALS`: claude's `^\s*✳`
 *  describes a title and would be nonsense against stdout, which is why the
 *  output scanner refuses to fall back to that table.
 *
 *  agy is the reason this exists. Measured against Antigravity CLI 1.1.24, with
 *  the pty given a window size (without one it never finishes booting, and two
 *  earlier probes wrongly concluded it emits nothing): at a live permission
 *  prompt agy writes NO title, NO OSC of any kind, and NO bell. Its screen is
 *  the only place the state appears, so it is the only place to read it. Its
 *  hooks cover working and done; this is the missing third state, and the
 *  hybrid the maintainer asked for.
 *
 *  Two patterns because agy's prompt renders as a block and either line can be
 *  the one that survives a redraw:
 *
 *      Requesting permission for:
 *         echo hello-from-agy
 *      Do you want to proceed?
 *      > 1. Yes ... 4. No
 */
export const BUILTIN_OUTPUT_SIGNALS: Record<string, Partial<SignalPatterns>> = {
  agy: { attention: ["Requesting permission for:", "Do you want to proceed\\?"] },
};

export const BUILTIN_NOTIFY_IGNORE: Record<string, string[]> = {
  claude: ["is waiting for your input"],
  // grok announces every finished turn over OSC 9, ~180ms after its Stop hook:
  // `Turn complete in 3.5s. · <session title>` (measured in the work-state
  // log). That is a done, not a request, and the unmatched body rang the
  // needs-you bell on every grok turn. Anchored, so a body that merely
  // mentions a turn is still read.
  grok: ["^Turn complete\\b"],
  // devin's own end-of-turn OSC 9/777 (`Devin finished`), same shape, same
  // bell.
  devin: ["^Devin finished$"],
  // muse's own end-of-turn OSC 9, `<workspace> — done (18s)`, 10 to 20s after
  // its Stop hook (measured in the work-state log). Anchored on the tail, since
  // the head is the workspace name.
  muse: ["\\u2014 done \\(\\d+s\\)$"],
};

/** Built-in ALLOW-LIST of notification bodies, per agent. When an agent has
 *  one, only a body matching it raises attention and everything else is
 *  chatter. This is the safe direction for an agent that notifies about things
 *  OTHER than needing you, and claude is exactly that agent.
 *
 *  A deny-list cannot work here. Read out of claude 2.1.251, it notifies with
 *  eleven `notificationType`s, and only five mean needs-you:
 *
 *    needs you   `${label} needs your input`              agent_needs_input
 *                `Claude needs your permission to use X`  permission_prompt
 *                `${name} needs permission for X`         worker_permission_prompt
 *                `Claude Code needs your input`           elicitation_dialog
 *                `Claude Code needs your approval ...`    plan approval
 *    does not    `${label} finished` / `${label} failed`  agent_completed
 *                `Claude is waiting for your input`       idle_prompt
 *                `Claude Code login successful`           auth_success
 *                `Claude is done using your computer`     computer_use_exit
 *                `MCP server "X" confirmed ... complete`  elicitation_complete
 *                `Elicitation response for ...: decline`  elicitation_response
 *
 *  termic spoofs `TERM_PROGRAM=iTerm.app`, so claude picks its iTerm2 channel
 *  and sends ALL of those as OSC 9. Filtering only `idle_prompt` meant a
 *  finished turn rang the needs-you bell: `agent_completed` fires on a band
 *  change and not for an interrupted or self-driving turn, which is why it read
 *  as a random bell on some completions rather than a reliable wrong badge.
 *
 *  Every needs-you body contains "needs your" or "needs permission"; not one of
 *  the other six does. Matching on that is why a notification type claude adds
 *  LATER is silent by default instead of ringing, which is how this arrived. */
export const BUILTIN_NOTIFY_ATTENTION: Record<string, string[]> = {
  claude: ["needs your", "needs permission"],
};

/** Agents whose notifications are ANNOUNCEMENTS, never requests for the user.
 *
 *  Not an allow-list with no entries: an empty list falls through to "anything
 *  counts", which is the default for an agent nobody has measured and is the
 *  right default. This is the opposite claim, and it has to be made explicitly.
 *
 *  codex is here because its `OSC 9` carries its ENTIRE final assistant message
 *  at the end of every turn. Four consecutive bodies off a real session, all of
 *  them prose ("Done. Quick SEO pass landed: ...", "Read /etc/hosts
 *  successfully...", "I'm here. What do you want me to do next?"), and none of
 *  them a request for anything. Treating those as needs-you put a bell on the
 *  end of every codex turn.
 *
 *  And it never uses `OSC 9` for the state that WOULD deserve one: driving a
 *  live codex to a permission prompt produced 80 `OSC 0` titles, one `OSC 10`,
 *  one `OSC 11` and zero `OSC 9`. Its needs-you is the `Action Required` title
 *  plus the `PermissionRequest` hook, both of which termic already reads.
 *
 *  WHY THIS ONLY APPEARED WITH HOOKS, since that is the confusing part: the
 *  body was always chatter, but `notifyAttention` drops a notification that
 *  arrives while the tab still reads `working`, and without hooks the title
 *  kept it there. A hook `133;D` lands ~50ms AHEAD of the `OSC 9` (measured off
 *  the same turn), so the tab is already `done` when the notification arrives
 *  and the guard that used to swallow it no longer applies. Wiring codex hooks
 *  is what exposed it. */
export const NOTIFY_NEVER_ATTENTION: string[] = ["codex"];

/** Whether a notification body should raise attention. Defaults to `true` for
 *  unknown agents and unknown bodies: an agent that explicitly asked the
 *  terminal to notify has said what it means. */
export function notificationWantsAttention(
  cli: string,
  body: string,
  agents: Agent[] = useApp.getState().agents,
): boolean {
  const text = body.trim();
  if (!text) return false;
  // A non-empty `attention` list is an ALLOW-LIST: the agent has been told
  // what needs-you looks like, so anything else it notifies about is chatter.
  // This is the only tuning knob for notification bodies — the ignore list
  // below is per-built-in and not user-editable, so without allow-list
  // semantics an agent that spams notifications would have no way to opt out.
  const attn = compileSignals(resolveAgent(agents, cli)?.capabilities?.signals?.attention);
  if (attn.length) return attn.some(re => re.test(text));
  const base = builtinBaseId(cli, agents);
  // Measured to be announcements rather than requests. Checked AFTER the user's
  // own list so they can still teach termic otherwise for their own build, and
  // before the built-in lists because for these agents there is nothing a body
  // could say that would make it a needs-you.
  if (NOTIFY_NEVER_ATTENTION.includes(base)) return false;
  // Built-in allow-list, when the agent has one. Checked before the ignore
  // list so a body has to look like a request for the user, rather than merely
  // avoiding the handful of phrases we thought to exclude.
  const builtinAttn = compileSignals(BUILTIN_NOTIFY_ATTENTION[base]);
  if (builtinAttn.length && !builtinAttn.some(re => re.test(text))) return false;
  return !compileSignals(BUILTIN_NOTIFY_IGNORE[base]).some(re => re.test(text));
}

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
  const user = resolveAgent(agents, cli)?.capabilities?.signals;
  const builtin = BUILTIN_TITLE_SIGNALS[builtinBaseId(cli, agents)];
  if (!user && !builtin) return null;

  // PER-FIELD fallback, matching what hasPendingWork already does for
  // `pending`. Setting one field used to swap out the whole built-in set, so
  // an agent whose busy pattern you narrowed silently lost its idle pattern
  // too — and since `goIdle` only fires on a busy→idle title transition, the
  // fast done signal just stopped, quietly, with nothing in the UI saying so.
  //
  // Deliberately REPLACE per field rather than UNION the two. Union would make
  // it impossible to narrow a built-in: claude's busy pattern is a catch-all
  // ("any leading glyph that is not ✳"), so a user swapping it for a strict
  // spinner whitelist needs their pattern to WIN, not to be or-ed with the
  // catch-all it was written to escape. Narrowing is the main reason to touch
  // these fields at all.
  //
  // Cost of the choice: "no patterns at all for this field" is no longer
  // expressible by emptying it, because empty now means "inherit". A field
  // that must match nothing needs an unmatchable pattern such as `(?!)`.
  const pick = (k: keyof Required<SignalPatterns>): string[] =>
    (user?.[k]?.length ? user[k] : builtin?.[k]) ?? [];

  if (compileSignals(pick("attention")).some(re => re.test(t))) return "attention";
  if (compileSignals(pick("busy")).some(re => re.test(t))) return "busy";
  if (compileSignals(pick("idle")).some(re => re.test(t))) return "idle";
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

/** An agent resolved against what it EXTENDS: every field it left empty comes
 *  from its parent, live, at read time.
 *
 *  A clone used to be a full copy of the parent, taken once. That is a snapshot
 *  that rots: when a vendor renames a flag the built-in entry moves with the
 *  app and every clone keeps the old value forever, with no way for the user to
 *  tell which of its fields they actually chose. It had already happened here,
 *  a clone carrying the parent's literal `$HOME/.claude` sandbox paths while
 *  its own config lived elsewhere, so the cage denied it its own login.
 *
 *  EMPTY MEANS INHERIT, the rule `classifyAgentTitle` already uses per field,
 *  applied to the whole record rather than inventing a second convention. Its
 *  documented cost applies here too: "no value at all" stops being expressible
 *  by clearing a field, because clearing is how you ask for the parent's.
 *
 *  `id`, `display_name` and `extends` are the clone's own identity and are
 *  never inherited. Depth-capped because ids are user-editable and a chain that
 *  points at itself has to terminate. */
export function resolveAgent(agents: Agent[], cli: string): Agent | undefined {
  const own = agents.find(a => a.id === cli);
  if (!own) return undefined;
  const out: Agent = { ...own, capabilities: { ...(own.capabilities ?? {}) } };
  let next = own.extends;
  for (let i = 0; i < 8 && next && next !== out.id; i++) {
    const parent: Agent | undefined = agents.find(a => a.id === next);
    if (!parent) break;
    if (!out.command?.trim()) out.command = parent.command;
    if (!out.args?.length) out.args = parent.args;
    if (!out.icon_id?.trim()) out.icon_id = parent.icon_id;
    if (!out.color?.trim()) out.color = parent.color;
    if (!Object.keys(out.env ?? {}).length) out.env = parent.env;
    if (!Object.keys(out.docker_env ?? {}).length) out.docker_env = parent.docker_env;
    if (!out.sandbox_allowed_paths?.length) out.sandbox_allowed_paths = parent.sandbox_allowed_paths;
    if (!out.sandbox_allowed_hosts?.length) out.sandbox_allowed_hosts = parent.sandbox_allowed_hosts;
    if (!out.post_launch_capture) out.post_launch_capture = parent.post_launch_capture;
    // Per-LIST, not wholesale: overriding `yolo_args` alone must not silently
    // freeze the resume flags, which is the same freeze one level down.
    const pc = parent.capabilities ?? {};
    const oc = out.capabilities ?? {};
    out.capabilities = {
      ...oc,
      yolo_args: oc.yolo_args?.length ? oc.yolo_args : pc.yolo_args,
      runtime_yolo_command: oc.runtime_yolo_command || pc.runtime_yolo_command,
      runtime_default_command: oc.runtime_default_command || pc.runtime_default_command,
      resume_args: oc.resume_args?.length ? oc.resume_args : pc.resume_args,
      session_id_args: oc.session_id_args?.length ? oc.session_id_args : pc.session_id_args,
      resume_id_args: oc.resume_id_args?.length ? oc.resume_id_args : pc.resume_id_args,
      resume_picker_args: oc.resume_picker_args?.length ? oc.resume_picker_args : pc.resume_picker_args,
      name_args: oc.name_args?.length ? oc.name_args : pc.name_args,
      signals: {
        busy: oc.signals?.busy?.length ? oc.signals.busy : pc.signals?.busy,
        idle: oc.signals?.idle?.length ? oc.signals.idle : pc.signals?.idle,
        attention: oc.signals?.attention?.length ? oc.signals.attention : pc.signals?.attention,
        pending: oc.signals?.pending?.length ? oc.signals.pending : pc.signals?.pending,
      },
    };
    next = parent.extends;
  }
  return out;
}

/** Field names this agent OVERRIDES. Empty for one that inherits everything,
 *  and always empty for a non-clone, which owns its values rather than
 *  overriding anything. Drives the "reset to inherited" affordance. */
export function agentOverrides(agents: Agent[], cli: string): string[] {
  const a = agents.find(x => x.id === cli);
  if (!a?.extends) return [];
  const c = a.capabilities ?? {};
  const s = c.signals ?? {};
  const on: Array<[string, boolean]> = [
    ["command", !!a.command?.trim()],
    ["args", !!a.args?.length],
    ["icon_id", !!a.icon_id?.trim()],
    ["color", !!a.color?.trim()],
    ["env", !!Object.keys(a.env ?? {}).length],
    ["docker_env", !!Object.keys(a.docker_env ?? {}).length],
    ["sandbox_allowed_paths", !!a.sandbox_allowed_paths?.length],
    ["sandbox_allowed_hosts", !!a.sandbox_allowed_hosts?.length],
    ["post_launch_capture", !!a.post_launch_capture],
    ["capabilities", !!(c.yolo_args?.length || c.runtime_yolo_command || c.runtime_default_command
      || c.resume_args?.length || c.session_id_args?.length || c.resume_id_args?.length
      || c.resume_picker_args?.length
      || c.name_args?.length || s.busy?.length || s.idle?.length || s.attention?.length
      || s.pending?.length)],
  ];
  return on.filter(([, v]) => v).map(([k]) => k);
}

function findAgent(cli: string): {
  command: string; args: string[];
  caps: NonNullable<Agent["capabilities"]>;
  env: Record<string, string>;
} {
  const registry = useApp.getState().agents;
  // Resolved, so a clone that left a field empty gets its parent's CURRENT
  // value rather than a copy frozen when it was created.
  const a = resolveAgent(registry, cli);
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
        resume_picker_args: a.capabilities?.resume_picker_args ?? [],
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
 *    override    → user's verbatim resume block (primary tab of the task's
 *                  OWN agent only — the string is written in one CLI's
 *                  spelling, so handing it to a different agent is a
 *                  guaranteed argv error, see `runsTaskAgent`).
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
  /** `tab.cli === task.cli` — this tab runs the task's OWN agent rather than
   *  a second agent added from the "+" menu.
   *
   *  Only that agent may use `resumeOverride`. `isPrimary` alone does not
   *  say it: it means "first tab of THIS cli", so the first codex tab added
   *  to a claude task is primary-for-codex and was handed claude's override
   *  verbatim. `--resume <name>` is claude's spelling; codex's is
   *  `resume <name>`, so the spawn died on `unexpected argument '--resume'`
   *  before it drew a frame, on every retry. `spawnArgsForCli` already gates
   *  `task.agent_args` on the same equality for the same reason. */
  runsTaskAgent: boolean;
  isRepoRoot: boolean;
  hasResumableHistory: boolean;
  /** This tab's own stored session uuid (TerminalTab.sessionId), if minted. */
  storedUuid?: string;
  /** Raw `task.resume_override` (gated to the task's own primary agent tab). */
  resumeOverride?: string;
  /** A resume attempt for this tab just rapid-exited → skip the stored
   *  uuid / cwd-resume and start fresh on the immediate retry. */
  failedResume: boolean;
}): ResumeDecision {
  if (!opts.isAgent) return { kind: "fresh" };

  const override = opts.isPrimary && opts.runsTaskAgent
    ? opts.resumeOverride?.trim()
    : undefined;
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

/** What a spawn actually DID about resuming, which is not the same question
 *  `decideResume` answers.
 *
 *  Capture-resume agents (codex, opencode) never reach `decideResume`'s
 *  id branch: that needs `session_id_args` AND `resume_id_args`, and these
 *  have only the second. Their resume is composed separately, from the uuid
 *  termic's own SessionStart hook captured, and handed to the spawn as a
 *  resume override. Two guards downstream were written against
 *  `decideResume`'s verdict alone and so could not see it:
 *
 *  - the spawn was not counted as a resume at all, so a fast exit never
 *    reached the resume-failure recovery, and
 *  - the recovery's "this stored id no longer resolves, clear it" branch was
 *    gated on `kind === "resume-id"`, a verdict codex cannot produce.
 *
 *  Measured against codex 0.153.4: a second Codex on the same thread exits
 *  rc=1 in 405-512 ms with "thread <id> already has an active writer", well
 *  inside RESUME_FAILURE_MS. So the exit IS the signal, and it was being
 *  dropped. */
export interface SpawnResumeShape {
  /** The spawn asked the agent to resume something, so a fast exit is a
   *  resume failure rather than an ordinary crash. A user-typed
   *  `resumeOverride` is deliberately NOT counted: they asked for that
   *  specific thing, and silently retrying fresh would ignore them. */
  isResume: boolean;
  /** It resumed a SPECIFIC stored session id. A failure then says something
   *  about that id, which is the only case where dropping it is the fix. */
  usedStoredSessionId: boolean;
}

export function spawnResumeShape(opts: {
  decision: ResumeDecision;
  /** The composed `resume <uuid>` for a capture-resume agent, when one was
   *  built (i.e. a uuid is stored and the last attempt did not just fail). */
  captureResumeOverride?: string;
}): SpawnResumeShape {
  const captured = !!opts.captureResumeOverride;
  const kind = opts.decision.kind;
  return {
    isResume: captured || kind === "cwd-resume" || kind === "resume-id",
    usedStoredSessionId: captured || kind === "resume-id",
  };
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
 *       - Skipped for secondary "+" tabs (`isPrimary=false`), no-task
 *         spawns (`task` absent), the agent's session picker (it would name
 *         whichever session is picked, a sibling's included), and whenever
 *         `resumeOverride` is set
 *         (renaming on every relaunch would reassign the session's
 *         display name out from under the override's `--resume` target).
 *
 *    D. always-applied:
 *       - `yolo_args` appended LAST so a subcommand-style resume
 *         (`codex resume --last <yolo>`) attaches its global flag to
 *         the subcommand instead of the root binary.
 */
/** Agents whose `name_args` may ONLY go on a spawn that CREATES a session.
 *
 *  copilot 1.0.86 refuses the name on every resume, and exits 1 before its
 *  TUI draws, which termic reads as "resume failed" and answers with a fresh
 *  session (measured, both shapes):
 *
 *    --session-id <existing> --name x
 *      error: option '--name' cannot be used with option '--session-id <id>'
 *      when it resolves to an existing or remote session or task.
 *    --continue --name x
 *      error: the argument '--continue' cannot be used with '--name <name>'
 *
 *  claude is NOT here: it takes `--name` with `--resume`, and relies on it
 *  to keep the task name on a session resumed across relaunches. Keyed by
 *  the built-in base, so a clone of copilot inherits the rule. */
export const NAME_ONLY_ON_NEW_SESSION = new Set(["copilot"]);

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
  // Not an update menu: muse's first-run TRUST PICKER, which every worktree
  // task meets because muse keys trust by DIRECTORY, not by repo (measured:
  // a `git worktree add` off an already-trusted repo prompts again, where
  // claude's repo-keyed picker does not). It is the one startup dialog that
  // `deliverMessage`'s echo guard cannot cover, because the damage is done by
  // the TEXT and not by the submit the guard withholds: in muse's picker `n`
  // selects `Quit` and a space CONFIRMS it, so "rename the button" exits the
  // agent partway through being typed, with no Enter involved. Measured both
  // ways on a live 1.0.2 ("hello world" and "add a test" survive; "rename the
  // button" and a bare `n`+space do not).
  //
  // `--trust-workspace` is the flag muse ships for this and it trusts for THIS
  // RUN ONLY, which is what makes it safe here: verified that the same
  // directory prompts again on the next spawn without the flag, so an
  // unattended launch cannot leave a workspace permanently trusted behind the
  // user's back. Attended spawns are untouched and still show the picker.
  muse: ["--trust-workspace"],
  // Same trust picker as muse's: devin asks "Do you trust the authors of
  // this directory?" in an untrusted cwd and the picker eats the injected
  // prompt's keystrokes. `--respect-workspace-trust false` is run-scoped
  // (the same dir prompts again without it), so it cannot permanently trust
  // a directory behind the user's back. Measured on a live 3000.10.21.
  devin: ["--respect-workspace-trust", "false"],
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
    /** Open the agent's own session picker instead of any resume block
     *  (GH #311): the args from `resumePickerArgsForCli`. The caller passes it
     *  only on the spawn right after a stored id failed to resume, and
     *  suppresses the mint and `opts.resume` for it. */
    picker?: string[];
    /** True when a prompt will be injected without a human at the keyboard.
     *  Composes UNATTENDED_SPAWN_ARGS so startup update menus can't
     *  swallow the injection. */
    unattended?: boolean;
  },
): string[] {
  const { args, caps } = findAgent(cli);
  const vars = taskVars(opts.task, opts.sessionUuid);
  const nameOnlyOnNew = NAME_ONLY_ON_NEW_SESSION.has(
    builtinBaseId(cli, useApp.getState().agents),
  );

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
  } else if (opts.picker?.length) {
    // The agent's picker replaces the resume block, WITHOUT name_args
    // (below). The picker lists every session in the cwd, a main checkout's
    // sibling tasks included, and claude applies `--name` to whichever one is
    // picked: a wrong pick renamed the sibling's conversation to this task,
    // which then read as this task's in every later picker. A right pick
    // gets the name back on the next relaunch, which resumes it by id.
    resumeBlock = opts.picker;
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
    // CLI-created task parameters belong to the default agent only. Keep
    // them ahead of every termic-managed runtime block, while still after
    // Settings defaults so the task can select its own model or reasoning.
    ...(opts.isPrimary && opts.task?.cli === cli ? (opts.task.agent_args ?? []) : []),
    // Before the resume block: codex's resume is a subcommand, and these
    // are root-binary globals.
    ...(opts.unattended ? (UNATTENDED_SPAWN_ARGS[cli] ?? []) : []),
    ...resumeBlock,
    // name_args on every primary-tab spawn (worktree or repo-root, mint or
    // resume) so claude always shows the task name. Skipped for
    // secondary "+" tabs (isPrimary=false), no-task spawns, and whenever a
    // resumeOverride is active: renaming the session on every relaunch
    // reassigns its display name out from under the override's target, so
    // the next `--resume <name>` no longer matches (breaks after 1 relaunch).
    //
    // For an agent that only names a NEW session (NAME_ONLY_ON_NEW_SESSION),
    // only the spawn that creates one: the id mint, or no resume at all.
    ...(opts.isPrimary && opts.task && !override && !opts.picker?.length
        && (!nameOnlyOnNew || isFirstIdSpawn || resumeBlock.length === 0)
      ? (caps.name_args ?? []) : []),
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
/** The registry's resume-by-id args with `{UUID}` already expanded to the
 *  given session id. The capture-resume spawn path composes these instead
 *  of hardcoding one agent's flag, so any agent declaring `resume_id_args`
 *  resumes with ITS OWN spelling (GH #169 review). */
export const resumeIdArgsForCli = (cli: string, sessionId: string) =>
  (findAgent(cli).caps.resume_id_args ?? []).map(a => a.replaceAll("{UUID}", sessionId));
/** The registry's args for the agent's OWN session picker (GH #311), empty
 *  when it has none. Opened in place of a fresh session when a stored id
 *  fails to resume, so the user continues where they meant to and termic
 *  reads no agent's session files: the chosen id comes back over the hooks. */
export const resumePickerArgsForCli = (cli: string) =>
  findAgent(cli).caps.resume_picker_args ?? [];

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
/** Reorder a launcher's CLI list so the project's default comes first.
 *  The agent registry's order is a global preference ("which agents do I
 *  care about"); which one a given repo starts with is a per-project one,
 *  and in a launcher the per-project answer wins. Keeps the rest in
 *  registry order, and leaves the list alone when the default is empty or
 *  names something the list doesn't offer. */
export function defaultCliFirst<T extends { id: string }>(
  list: readonly T[],
  defaultCli: string | undefined,
): T[] {
  const head = defaultCli ? list.find(a => a.id === defaultCli) : undefined;
  if (!head) return [...list];
  return [head, ...list.filter(a => a.id !== head.id)];
}

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
