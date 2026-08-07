// Production RPC bridge for the `termic` CLI control socket.
//
// The Rust socket server (src-tauri/src/cli_server.rs) reaches UI-side
// orchestration by emitting `cli-rpc://request` with a correlation id;
// this module runs the handler against the SAME store + recipes the GUI
// uses and replies via the `cli_rpc_result` command (streaming handlers
// additionally emit `cli_rpc_progress` payloads along the way). It is
// NEW hardened code that only borrows the dev automation bridge's
// correlation-id pattern (automation.rs) - the debug bridge itself is
// never armed or reused here, and unlike it, this listener runs in
// RELEASE builds (the whole feature is dead otherwise).
//
// Only these typed handlers exist; there is no eval. An unknown method
// replies with an error, and the server ignores replies whose id is not
// waiting, so nothing can be injected into an in-flight request.
//
// Work-state no longer flows through here: src/lib/cliAgentState.ts
// PUSHES it down to the Rust cache instead (one less moving part, and
// `wait` works even while this webview is busy).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import {
  onPtyData,
  projectAdd,
  ptyAlive,
  projectGitBranches,
  projectRemove,
  settingsLoad,
  taskCreate,
  taskImportWorktree,
  taskOpenRepo,
  taskRename,
  taskSetYolo,
  tasksList,
} from "@/lib/ipc";
import { archiveAndRefresh } from "@/lib/archiveTask";
import { withCreateLock } from "@/lib/createLock";
import { markUnattendedSpawn } from "@/lib/unattendedSpawns";
import { reportCliPromptDelivery } from "@/lib/cliPromptReports";
import { deliverMessage } from "@/lib/agentSend";
import {
  agentDisplayName, cliSupportsResumeById, isTerminalCli, isTerminalEntry, visibleCliIds,
  workDoneCapable,
} from "@/lib/agents";
import { launchSetupTab } from "@/lib/runTabs";
import {
  derivedBranch,
  readNewTaskMode,
  sandboxPins,
  uniqueBranch,
  type NewTaskMode,
} from "@/lib/quickTask";
import { slugify } from "@/lib/utils";
import type { SandboxMode, Task, TerminalTab } from "@/lib/types";

interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
}

type Progress = (value: unknown) => void;
type Handler = (params: unknown, progress: Progress) => Promise<unknown> | unknown;

// Same rhythm as the proven recipes (agentRace / runPrompt): poll for
// the PTY, give the TUI a settle beat, re-read, then type. Wall-clock
// timers throughout - never rAF (occluded windows freeze rAF, and for
// the CLI this window is always backgrounded).
const SPAWN_DEADLINE_MS = 15_000;
const AGENT_SETTLE_MS = 6000;
const POLL_MS = 150;
/** How long the setup-output forwarder waits for the setup tab's PTY. */
const SETUP_PTY_DEADLINE_MS = 10_000;

const sleep = (ms: number) => new Promise<void>(r => { window.setTimeout(r, ms); });

function defaultAgentTab(taskId: string): TerminalTab | undefined {
  return (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.type === "terminal" && !!t.is_default,
  );
}

// ─────────────────────────── open ────────────────────────────────────

/** Select a task in the UI (window raise is done Rust-side). Loads the
 *  task set first if the store has not seen this id yet (a task created
 *  in another way since the last refresh). */
async function openTaskHandler(params: unknown): Promise<null> {
  const taskId = (params as { taskId?: unknown })?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("open_task requires a taskId");
  }
  const app = useApp.getState();
  if (!app.tasks.some(t => t.id === taskId)) {
    await app.loadAll();
  }
  const fresh = useApp.getState();
  if (!fresh.tasks.some(t => t.id === taskId)) {
    throw new Error("no such task");
  }
  fresh.setActiveTask(taskId);
  return null;
}

// ─────────────────────────── new ─────────────────────────────────────

interface NewTaskParams {
  name: string;
  projectId: string;
  agent?: string;
  /** "worktree" | "main"; absent = the GUI's remembered mode. */
  mode?: string;
  base?: string;
  /** Existing worktree to ADOPT instead of creating one (GH #169,
   *  `new --from`). Path already canonicalized and project-matched by
   *  the server; Rust still validates it is a worktree of this repo. */
  from?: string;
  /** Externally-started session id the agent resumes on first spawn
   *  (GH #169, `new --resume`). Valid with or without `from`; the server
   *  already gated it on the agent's `resume_id_args`. */
  resume?: string;
  sandbox?: string;
  yolo?: boolean;
  open?: boolean;
  prompt?: string;
  promptId?: string;
}

/** The main checkout stays uncaged unless explicitly opted in, and
 *  task_open_repo takes the allow-lists verbatim (no Rust-side seed
 *  fallback there), so mirror the New Task dialog's merge of global +
 *  project seeds. */
async function mainCheckoutSandbox(
  projectId: string,
  pins: { sandbox_enabled: boolean; sandbox_mode: SandboxMode },
): Promise<{ enabled: boolean; mode?: SandboxMode; rwPaths: string[]; allowedHosts: string[] }> {
  if (!pins.sandbox_enabled) return { enabled: false, rwPaths: [], allowedHosts: [] };
  const settings = await settingsLoad().catch(() => null);
  const proj = useApp.getState().projects.find(p => p.id === projectId);
  const rwPaths = [
    ...new Set([...(settings?.sandbox_default_rw_paths ?? []), ...(proj?.sandbox_rw_paths ?? [])]),
  ];
  const allowedHosts = [
    ...new Set([
      ...(settings?.sandbox_default_allowed_hosts ?? []),
      ...(proj?.sandbox_allowed_hosts ?? []),
    ]),
  ];
  return { enabled: true, mode: pins.sandbox_mode, rwPaths, allowedHosts };
}

/** Create the task (inside the app-wide create lock) the same way the
 *  GUI would: derived + auto-numbered branch for worktrees, the shared
 *  repo checkout for main mode. */
async function createTask(p: NewTaskParams, mode: NewTaskMode): Promise<Task> {
  const name = p.name.trim();
  const cli = typeof p.agent === "string" && p.agent ? p.agent : undefined;
  const pins = sandboxPins(p.sandbox);
  return withCreateLock(async () => {
    // Re-check inside the lock: a GUI create may have raced us here.
    // Read from DISK, not the store - the previous lock holder's
    // loadAll() runs after its lock section releases, so the store can
    // lag a create that already committed.
    const existing = await tasksList().catch(() => useApp.getState().tasks);
    const dup = existing.find(
      t => !t.archived && t.project_id === p.projectId && t.name.toLowerCase() === name.toLowerCase(),
    );
    if (dup) throw new Error(`task "${dup.name}" already exists in this project`);
    const resume = typeof p.resume === "string" && p.resume ? p.resume : undefined;
    if (mode === "repo_root") {
      const sandbox = pins ? await mainCheckoutSandbox(p.projectId, pins) : undefined;
      return taskOpenRepo(p.projectId, cli, name, sandbox, undefined, resume);
    }
    if (slugify(name) === "") {
      throw new Error("Task name must contain at least one letter or number.");
    }
    let branch = derivedBranch(name, usePrefs.getState().branchPrefix);
    // Auto-number past an existing branch, the dialog's behavior
    // (issue #129). Best-effort: on failure the Rust backstop still
    // turns a real collision into a clean error.
    try {
      branch = uniqueBranch(branch, await projectGitBranches(p.projectId));
    } catch {
      // non-git edge or transient git failure; keep the derived branch
    }
    return taskCreate({
      id: crypto.randomUUID(),
      project_id: p.projectId,
      name,
      cli,
      base_branch: typeof p.base === "string" && p.base.trim() ? p.base.trim() : null,
      branch,
      resume_session_id: resume,
      ...(pins ?? {}),
    });
  });
}

/** Rust's import refusals cross the string-only RPC error channel with the
 *  `cli_new:<code>:` sentinel (the sendErr pattern), so `--from` misuse
 *  comes back to the CLI as a typed conflict/bad_request instead of a
 *  generic Internal. The classification lives HERE and not in the Rust
 *  error strings themselves because the GUI shows those strings raw. */
function classifyCreateError(e: unknown): Error {
  const msg = String((e as Error)?.message ?? e);
  const code =
    /already (open as a task|exists)/.test(msg) ? "conflict"
    : /not a worktree of this repo|main checkout|does not exist|not a git repo/.test(msg)
      ? "bad_request"
      : null;
  return code ? new Error(`cli_new:${code}: ${msg}`) : e instanceof Error ? e : new Error(msg);
}

/** Adopt an existing worktree as the task (GH #169, `new --from`): no
 *  branch derivation, no file copy, no setup script. Rust owns ALL the
 *  duplicate checks (path, and name including the branch-derived default)
 *  and the name derivation; `resume` seeds the per-cli session id so the
 *  default tab's first spawn composes `resume_id_args` instead of minting
 *  a fresh session. */
async function importTask(p: NewTaskParams): Promise<Task> {
  const name = (p.name ?? "").trim();
  const cli = typeof p.agent === "string" && p.agent ? p.agent : undefined;
  const pins = sandboxPins(p.sandbox);
  return withCreateLock(async () => {
    // Same global+project seed merge the New Task dialog applies.
    const sandbox = pins ? await mainCheckoutSandbox(p.projectId, pins) : undefined;
    try {
      return await taskImportWorktree(
        p.projectId,
        p.from!,
        name || undefined,
        cli,
        sandbox,
        typeof p.resume === "string" && p.resume ? p.resume : undefined,
        p.yolo === true ? true : undefined,
      );
    } catch (e) {
      throw classifyCreateError(e);
    }
  });
}

/** Forward the setup tab's PTY output to the server as progress events
 *  until stopped. The setup tab spawns asynchronously after
 *  launchSetupTab, so this polls for its ptyId first. */
function streamSetupOutput(taskId: string, progress: Progress): () => void {
  let stopped = false;
  let unlisten: UnlistenFn | null = null;
  const decoder = new TextDecoder();
  const deadline = Date.now() + SETUP_PTY_DEADLINE_MS;
  const tick = () => {
    if (stopped) return;
    const tab = (useApp.getState().tabs[taskId] ?? []).find(
      (t): t is TerminalTab => t.type === "terminal" && t.runTab?.kind === "setup",
    );
    if (tab?.ptyId) {
      onPtyData(tab.ptyId, data => {
        if (!stopped) progress({ setupOutput: decoder.decode(data, { stream: true }) });
      })
        .then(u => {
          if (stopped) u();
          else unlisten = u;
        })
        .catch(() => {});
      return;
    }
    if (Date.now() < deadline) window.setTimeout(tick, POLL_MS);
  };
  tick();
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** The injection target: a specific tab when given (send --fresh /
 *  --resume respawn), the default agent tab otherwise; a restored set
 *  with no surviving default falls back to its first agent tab so the
 *  injection still lands somewhere real. */
function agentTabFor(taskId: string, tabId?: string): TerminalTab | undefined {
  if (!tabId) {
    return (
      defaultAgentTab(taskId)
      ?? (useApp.getState().tabs[taskId] ?? []).find(
        (t): t is TerminalTab => t.type === "terminal" && !t.runTab && !isTerminalCli(t.cli)
          && t.cli !== "shell" && t.cli !== "custom",
      )
    );
  }
  return (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.id === tabId && t.type === "terminal",
  );
}

/** Wait for the target agent tab to hold a live PTY ("spawn"). */
async function waitForAgentPty(taskId: string, tabId?: string): Promise<boolean> {
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (agentTabFor(taskId, tabId)?.ptyId) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** Inject the prompt with CONFIRMED delivery reporting. Unlike the
 *  race path's seedPromptWhenReady (which gives up silently), every
 *  exit reports to `cli_prompt_report`, because `new --wait` exit 0
 *  must mean delivered + settled (docs/plans/cli.md, Phase 1). Runs in
 *  the background AFTER the RPC returns; a webview reload kills it,
 *  which the server surfaces as "prompt never delivered". */
async function injectPromptTracked(
  taskId: string,
  prompt: string,
  promptId: string,
  spawned: boolean,
  tabId?: string,
): Promise<void> {
  const report = (ok: boolean, error?: string) => reportCliPromptDelivery(promptId, ok, error);
  if (!spawned) {
    await report(false, "the agent PTY never spawned");
    return;
  }
  // Settle beat so the prompt lands in the input box, not a splash
  // screen; then RE-READ the tab (it may have restarted onto a fresh
  // PTY during the settle - never type into a stale pty).
  await sleep(AGENT_SETTLE_MS);
  const tab = agentTabFor(taskId, tabId);
  if (!tab?.ptyId) {
    await report(false, "the agent tab lost its PTY before the prompt could be typed");
    return;
  }
  try {
    // Clear any STALE done/attention state first (a real keyboard Enter
    // clears these via term.onData; a direct PTY write does not), so the
    // wait's own-prompt settle logic can never trust a "done" that
    // predates this prompt.
    useApp.getState().patchTab(taskId, tab.id, { workState: "idle", unread: null });
    // Resolves only after text AND the submit CR are written.
    await deliverMessage(tab.ptyId, prompt);
    // pty_write silently no-ops on a dead id, so "the writes resolved"
    // is not "the agent received them": delivered means the SAME tab
    // still holds the SAME, still-live PTY after both writes.
    const still = agentTabFor(taskId, tabId);
    const samePty = still?.id === tab.id && still.ptyId === tab.ptyId;
    const alive = samePty && (await ptyAlive(tab.ptyId).catch(() => false));
    if (!alive) {
      await report(false, "the agent PTY exited while the prompt was being typed");
      return;
    }
    useApp.getState().patchTab(taskId, tab.id, { lastInputAt: Date.now() });
    await report(true);
  } catch (e) {
    await report(false, String((e as Error)?.message ?? e));
  }
}

/** The CLI's `termic new`: the GUI's create recipe end to end, plus
 *  setup-output streaming and tracked prompt injection. Returns at
 *  spawn; the server owns all waiting. */
async function newTaskHandler(raw: unknown, progress: Progress): Promise<{ taskId: string; spawned: boolean }> {
  const p = raw as NewTaskParams;
  if (typeof p?.projectId !== "string" || !p.projectId) throw new Error("new_task requires a projectId");
  const importing = typeof p.from === "string" && !!p.from;
  // Importing derives a missing name from the worktree's branch.
  if (!importing && (typeof p?.name !== "string" || !p.name.trim())) {
    throw new Error("new_task requires a name");
  }
  // Cold launch: the RPC ready-latch can beat loadAll, and an
  // unhydrated store would silently drop the project's sandbox seeds
  // from the merge below. Mirror openTaskHandler's guard.
  if (!useApp.getState().projects.some(pr => pr.id === p.projectId)) {
    await useApp.getState().loadAll();
  }
  // Same live-registry re-check the tab path does: the server gated
  // --resume on its own settings snapshot, and hydration can drift; a
  // seed the spawn would silently ignore must refuse instead.
  if (typeof p.resume === "string" && p.resume) {
    const effective = (typeof p.agent === "string" && p.agent)
      ? p.agent
      : useApp.getState().projects.find(pr => pr.id === p.projectId)?.default_cli ?? "";
    if (!cliSupportsResumeById(effective)) {
      throw new Error(
        `cli_new:unsupported: agent ${effective || "(project default)"} cannot resume a session by id`,
      );
    }
  }
  // Non-git projects cannot host worktrees; the GUI forces the main
  // checkout for them and so do we (the server already rejected an
  // EXPLICIT --worktree with a clear error).
  const nonGit = useApp.getState().projects.find(pr => pr.id === p.projectId)?.non_git === true;
  const mode: NewTaskMode = nonGit
    ? "repo_root"
    : p.mode === "worktree" ? "worktree" : p.mode === "main" ? "repo_root" : readNewTaskMode();

  const task = importing ? await importTask(p) : await createTask(p, mode);
  // Before anything mounts, so the first spawn composes the flags in.
  // (The import path carried yolo in the create payload itself.)
  if (!importing && p.yolo) await taskSetYolo(task.id, true).catch(() => {});
  if (typeof p.prompt === "string" && p.prompt) markUnattendedSpawn(task.id);

  await useApp.getState().loadAll();
  useApp.getState().mountTasks([task.id]);
  if (p.open) useApp.getState().setActiveTask(task.id);

  let stopSetupStream: (() => void) | null = null;
  if (!importing && mode === "worktree") {
    const launched = await launchSetupTab(task.id, { focus: false }).catch(() => false);
    if (launched) stopSetupStream = streamSetupOutput(task.id, progress);
  }

  const spawned = await waitForAgentPty(task.id);
  stopSetupStream?.();

  if (typeof p.prompt === "string" && p.prompt && typeof p.promptId === "string" && p.promptId) {
    // Deliberately NOT awaited: the RPC replies at spawn; delivery is
    // confirmed through cli_prompt_report, which the server waits on.
    void injectPromptTracked(task.id, p.prompt, p.promptId, spawned);
  }
  return { taskId: task.id, spawned };
}

// ─────────────────────────── send ────────────────────────────────────

interface SendPromptParams {
  taskId: string;
  prompt: string;
  promptId: string;
  resume?: boolean;
  fresh?: boolean;
  wait?: boolean;
  /** Explicit target (GH #138 part 2): a tab ID, already resolved from
   *  the user's `--tab` selector by the server's resolver. The store is
   *  re-checked here because it is ground truth and the server's cache
   *  can trail a just-closed tab. */
  tabId?: string;
  /** With tabId: the tab was created moments ago (`tab -p`) and its
   *  PTY may still be spawning, so a missing PTY means WAIT for it, not
   *  refuse. Never set for plain `send --tab`, where a dead target must
   *  be an error rather than a 20s stall into a lost prompt. */
  spawnPending?: boolean;
}

/** Typed domain failures cross the string-only RPC error channel with a
 *  sentinel prefix ("cli_send:<code>: <message>") the server maps back
 *  onto wire error codes (cli_server.rs parse_send_error). */
function sendErr(code: string, msg: string): Error {
  return new Error(`cli_send:${code}: ${msg}`);
}

/** The task's agent tabs: terminal tabs that actually host an agent CLI
 *  (not the shell, custom-command, registry-terminal, or run/setup
 *  variants the CLI cannot prompt). */
function sendableAgentTabs(taskId: string): TerminalTab[] {
  return (useApp.getState().tabs[taskId] ?? []).filter(
    (t): t is TerminalTab =>
      t.type === "terminal"
      && !t.runTab
      && t.cli !== "shell"
      && t.cli !== "custom"
      && !isTerminalCli(t.cli),
  );
}

/** Prompt a LIVE agent tab. Mid-turn (or behind a queued backlog):
 *  QUEUE, delivered by TerminalPane's drain when the turn ends
 *  (runPrompt.ts's rule); only capable agents queue, since without
 *  detection there is no "turn ended" edge to drain on and the prompt
 *  would sit forever. Idle: deliver now, tracked (injectPromptTracked's
 *  rules, minus the boot settle a fresh spawn needs). Shared by the
 *  default-target and `--tab` targeted paths. */
async function deliverOrQueue(
  p: SendPromptParams,
  tab: TerminalTab,
  capable: boolean,
): Promise<{ mode: string; capable: boolean }> {
  const ptyId = tab.ptyId;
  if (!ptyId) throw new Error("the agent tab lost its PTY before the prompt could be typed");
  const busy = capable && (tab.workState === "working" || (tab.queue?.length ?? 0) > 0);
  if (busy) {
    useApp.getState().enqueueAgentMessage(p.taskId, tab.id, p.prompt, 1, p.promptId);
    return { mode: "queued", capable };
  }
  useApp.getState().patchTab(p.taskId, tab.id, { workState: "idle", unread: null });
  await deliverMessage(ptyId, p.prompt);
  const still = agentTabFor(p.taskId, tab.id);
  const samePty = still?.id === tab.id && still.ptyId === ptyId;
  const alive = samePty && (await ptyAlive(ptyId).catch(() => false));
  if (!alive) {
    throw new Error("the agent PTY exited while the prompt was being typed");
  }
  useApp.getState().patchTab(p.taskId, tab.id, { lastInputAt: Date.now() });
  await reportCliPromptDelivery(p.promptId, true);
  return { mode: "delivered", capable };
}

/** The CLI's `termic send`: prompt the RUNNING agent (queue when it is
 *  mid-turn), or respawn one under --resume/--fresh. Delivery to a
 *  running agent is awaited HERE (mode "delivered" means it landed);
 *  queued and spawned deliveries confirm later via cli_prompt_report,
 *  which the server's --wait blocks on.
 *
 *  Exported for the targeted-send integration test (the newTabHandler
 *  rule): the `--tab` rules interact with the real store's tab set, so
 *  the test must drive the REAL handler, not a re-implementation. */
export async function sendPromptHandler(raw: unknown): Promise<{ mode: string; capable: boolean }> {
  const p = raw as SendPromptParams;
  if (typeof p?.taskId !== "string" || !p.taskId) throw new Error("send_prompt requires a taskId");
  if (typeof p?.prompt !== "string" || !p.prompt) throw new Error("send_prompt requires a prompt");
  if (typeof p?.promptId !== "string" || !p.promptId) throw new Error("send_prompt requires a promptId");
  const app = useApp.getState();
  if (!app.tasks.some(t => t.id === p.taskId)) await app.loadAll();
  const task = useApp.getState().tasks.find(t => t.id === p.taskId);
  if (!task) throw new Error("no such task");

  const agentTabs = sendableAgentTabs(p.taskId);

  // Explicit target: the id was resolved from a `--tab` selector by the
  // server, but the STORE decides what it is now. Three refusals, each
  // named: the tab is gone, it is not an agent tab (shell/terminal/run
  // tabs are write-only from the CLI by design), or its agent exited.
  if (typeof p.tabId === "string" && p.tabId) {
    if (p.resume || p.fresh) {
      throw sendErr("flags_useless", "--tab targets a tab that is already open; drop --resume/--fresh");
    }
    const targeted = agentTabs.find(t => t.id === p.tabId);
    if (!targeted) {
      const exists = (useApp.getState().tabs[p.taskId] ?? []).some(t => t.id === p.tabId);
      if (exists) {
        throw sendErr(
          "not_sendable",
          "that tab is not an agent tab; only agent tabs are reachable, the rest are write-only from the CLI",
        );
      }
      throw sendErr("unknown_tab", "that tab no longer exists; see `termic status` for the open tabs");
    }
    const capable = workDoneCapable(targeted.cli);
    if (!capable && p.wait) {
      throw sendErr(
        "not_capable",
        `agent "${targeted.cli}" has work-done detection disabled, so --wait has no settle signal. Resend without --wait.`,
      );
    }
    if (p.spawnPending) {
      // `tab -p`: the tab was created moments ago. ALWAYS the tracked
      // spawn route, even when the PTY won the race and is already up:
      // the agent behind it is still booting, and typing now would land
      // in the splash screen instead of the input box (the settle beat
      // injectPromptTracked exists for), i.e. the silently-dropped
      // prompt Phase 1 prevents. waitForAgentPty returns immediately on
      // a live PTY, and the mode is a deterministic "spawned" rather
      // than whichever side of the race this dispatch landed on.
      const spawned = await waitForAgentPty(p.taskId, targeted.id);
      void injectPromptTracked(p.taskId, p.prompt, p.promptId, spawned, targeted.id);
      return { mode: "spawned", capable };
    }
    if (!targeted.ptyId) {
      throw sendErr(
        "tab_not_live",
        "that tab's agent is not running; open a new tab with `termic tab`, or resend without --tab using --resume",
      );
    }
    return deliverOrQueue(p, targeted, capable);
  }

  const live = agentTabs.filter(t => !!t.ptyId);
  const target = live.find(t => t.is_default) ?? (live.length === 1 ? live[0] : undefined);
  if (live.length > 1 && !target) {
    throw sendErr(
      "ambiguous",
      "more than one agent is running in this task and none is the default; there is no unambiguous target",
    );
  }

  if (target?.ptyId) {
    if (p.resume || p.fresh) {
      throw sendErr("flags_useless", "an agent is already running in this task; drop --resume/--fresh");
    }
    const capable = workDoneCapable(target.cli);
    if (!capable && p.wait) {
      throw sendErr(
        "not_capable",
        `agent "${target.cli}" has work-done detection disabled, so --wait has no settle signal. Resend without --wait.`,
      );
    }
    return deliverOrQueue(p, target, capable);
  }

  // No running agent: --resume / --fresh are the outs.
  if (!p.resume && !p.fresh) {
    throw sendErr(
      "no_agent",
      "no agent is running in this task. Rerun with --resume to restore the last session, or --fresh to start a new agent without context.",
    );
  }
  // The cli whose capability gates --wait: the actual respawn target's
  // when an exited tab exists (its cli may differ from the persisted
  // default), the persisted default's otherwise.
  const exited = p.resume
    ? (agentTabs.find(t => t.is_default && !t.ptyId) ?? agentTabs.find(t => !t.ptyId))
    : undefined;
  const spawnCli =
    exited?.cli ?? (task.persisted_tabs ?? []).find(pt => pt.is_default)?.cli ?? task.cli;
  if (p.wait && !workDoneCapable(spawnCli)) {
    throw sendErr(
      "not_capable",
      `agent "${spawnCli}" has work-done detection disabled, so --wait has no settle signal. Resend without --wait.`,
    );
  }

  let tabId: string | undefined;
  if (p.fresh) {
    // A NEW secondary agent tab starts fresh by design (no resume
    // machinery touches it); unattended so a startup update menu can't
    // swallow the injection; focus:false so it never yanks the
    // keyboard from a user mid-typing. Restore the persisted set FIRST
    // (ensureDefaultTab): pre-adding alone would make syncDurableTabs
    // treat every unrestored secondary as closed-and-forgotten, wiping
    // their session ids from disk. "Fresh" is about the NEW agent's
    // context, not about discarding the task's other sessions.
    const s = useApp.getState();
    if ((task.persisted_tabs ?? []).length) {
      s.ensureDefaultTab(p.taskId, task.cli);
    }
    s.mountTasks([p.taskId]);
    const newTabId = crypto.randomUUID();
    s.addTab(
      p.taskId,
      {
        id: newTabId,
        type: "terminal",
        title: agentDisplayName(spawnCli),
        cli: spawnCli,
        unattended: true,
      },
      { focus: false },
    );
    tabId = newTabId;
  } else {
    // --resume: a prior session must exist, else --fresh is the answer.
    const hasSession =
      !!task.has_resumable_history
      || (task.persisted_tabs ?? []).some(pt => pt.session_id || pt.previous_session_id);
    if (!hasSession) {
      throw sendErr(
        "no_session",
        "this task has no agent session to resume; use --fresh to start a new agent without context",
      );
    }
    if (exited) {
      // The tab is open but its PTY died: programmatic Restart (the
      // exited banner's button). The respawn re-runs the tab's own
      // resume decision; unattended for the injection that follows.
      // Mount too: a STOPPED task keeps its tabs in the store with
      // ptyId cleared, but no TerminalPane is rendered to see the kick
      // until the task is mounted again.
      useApp.getState().mountTasks([p.taskId]);
      useApp.getState().patchTab(p.taskId, exited.id, {
        respawnKick: (exited.respawnKick ?? 0) + 1,
        unattended: true,
      });
      tabId = exited.id;
    } else {
      // No agent tabs at all (task closed, or its main tab X-ed): mark
      // unattended BEFORE hydrating (the new_task rule), then restore
      // or seed the default tab EXPLICITLY. TaskView's own
      // ensureDefaultTab effect only runs on mount, so a task that is
      // already mounted with zero agent tabs would otherwise dead-end
      // (the Sidebar wake path calls it explicitly for the same
      // reason).
      markUnattendedSpawn(p.taskId);
      useApp.getState().mountTasks([p.taskId]);
      useApp.getState().ensureDefaultTab(p.taskId, task.cli);
    }
  }

  const spawned = await waitForAgentPty(p.taskId, tabId);
  // Deliberately NOT awaited (the new_task rule): the RPC replies at
  // spawn; delivery confirms through cli_prompt_report.
  void injectPromptTracked(p.taskId, p.prompt, p.promptId, spawned, tabId);
  return { mode: "spawned", capable: workDoneCapable(spawnCli) };
}

// ─────────────────────────── archive ─────────────────────────────────

/** The GUI's archive flow minus its confirm dialog (the CLI confirms on
 *  its own tty). PTY kill already happened Rust-side. */
async function archiveTaskHandler(params: unknown): Promise<null> {
  const taskId = (params as { taskId?: unknown })?.taskId;
  if (typeof taskId !== "string" || !taskId) throw new Error("archive_task requires a taskId");
  const app = useApp.getState();
  if (!app.tasks.some(t => t.id === taskId)) await app.loadAll();
  if (!useApp.getState().tasks.some(t => t.id === taskId)) throw new Error("no such task");
  await archiveAndRefresh(taskId, false);
  return null;
}

// ─────────────────────────── projects ────────────────────────────────

async function projectAddHandler(params: unknown): Promise<{ projectId: string }> {
  const p = params as { path?: unknown; nonGit?: unknown };
  if (typeof p?.path !== "string" || !p.path) throw new Error("project_add requires a path");
  const project = await projectAdd(p.path, p.nonGit === true);
  await useApp.getState().loadAll();
  return { projectId: project.id };
}

async function projectRemoveHandler(params: unknown): Promise<null> {
  const projectId = (params as { projectId?: unknown })?.projectId;
  if (typeof projectId !== "string" || !projectId) throw new Error("project_remove requires a projectId");
  const app = useApp.getState();
  // The active task is about to be archived with its project.
  const active = app.tasks.find(t => t.id === app.activeTaskId);
  if (active?.project_id === projectId) app.setActiveTask(null);
  await projectRemove(projectId);
  await useApp.getState().loadAll();
  return null;
}

// ─────────────────────────── rename ──────────────────────────────────

/** Rename a task's label and refresh the store so the sidebar shows it
 *  immediately. Duplicate/empty validation lives in the Rust task_rename
 *  command (shared with the GUI flow); its error message propagates back
 *  over the RPC as-is. Serialized behind the create lock: task_rename's
 *  duplicate check is load-then-save, and a create landing inside that
 *  window could mint the same-name twin the check exists to refuse. */
async function renameTaskHandler(params: unknown): Promise<null> {
  const p = params as { taskId?: unknown; name?: unknown };
  const taskId = p?.taskId;
  const name = p?.name;
  if (typeof taskId !== "string" || !taskId) throw new Error("rename_task requires a taskId");
  if (typeof name !== "string" || !name.trim()) throw new Error("rename_task requires a name");
  await withCreateLock(async () => {
    await taskRename(taskId, name);
    await useApp.getState().loadAll();
  });
  return null;
}

// ─────────────────── registry view shared by tab + agents ────────────
//
// ONE definition of "can I open a tab with this?", so `termic agents` cannot
// advertise something `termic tab` then refuses. Both read the same cached
// registry + detection the "+" menu does; detection is a login-shell probe per
// agent, so re-running it per call would put hundreds of ms on a hot path.

interface RegistryEntry {
  id: string;
  kind: string;
  enabled: boolean;
  installed: boolean | null;
  usable: boolean;
}

function registryView(): RegistryEntry[] {
  const app = useApp.getState();
  const detected = app.detectedClis;
  const detectionRan = Object.keys(detected).length > 0;
  const usableAgents = visibleCliIds(app.agents.map(a => a.id), app.agents, detected);
  return app.agents.map(a => {
    const terminal = isTerminalEntry(a);
    const enabled = !a.disabled;
    // `null` means detection has not run, which is NOT "not installed" and
    // must not be rendered as a cross.
    const installed = !detectionRan || terminal ? null : (detected[a.id]?.found ?? null);
    return {
      id: a.id,
      kind: terminal ? "terminal" : "agent",
      enabled,
      installed,
      // Terminal entries have nothing to detect; agents defer to the same
      // visibleCliIds the "+" menu filters on.
      usable: terminal ? enabled : usableAgents.has(a.id),
    };
  });
}

/** Hydrate what `registryView` reads, for callers that can arrive before the
 *  app has finished booting.
 *
 *  BOTH maps matter, and they fail differently. An empty `agents` makes
 *  `termic agents` answer "No agents configured." with exit 0, a lie a script
 *  cannot tell from a genuinely empty registry. An empty `detectedClis` is
 *  worse for `tab`: `visibleCliIds` treats "detection has not run" as "assume
 *  everything is present" (agents.ts), so every enabled agent reports
 *  `usable: true, installed: null` and `--agent <uninstalled>` is ACCEPTED,
 *  failing later when the PTY dies on exec. `refreshClis` normally fires from
 *  App.tsx, but `termic tab` auto-launches the app and can win that race. */
async function ensureRegistryHydrated(): Promise<void> {
  const s = useApp.getState();
  await Promise.all([
    s.agents.length === 0 ? s.loadAll() : Promise.resolve(),
    // Best-effort: a detection failure must not take down the verb. Falling
    // back to the permissive view is the pre-existing behavior.
    Object.keys(s.detectedClis).length === 0
      ? s.refreshClis().catch(() => {})
      : Promise.resolve(),
  ]);
}

async function listAgentsHandler(): Promise<{ agents: RegistryEntry[] }> {
  await ensureRegistryHydrated();
  return { agents: registryView() };
}

// ─────────────────────────── new_tab (GH #138) ───────────────────────

interface NewTabParams {
  taskId: string;
  /** "agent" | "terminal" | "shell" | "default" */
  kind: string;
  /** Registry id, for the agent and terminal kinds. */
  id?: string;
  /** Externally-started session id the new tab's agent resumes (GH #169,
   *  `tab --resume`). Agent kind only. */
  resume?: string;
}

/**
 * Open a tab inside a running task: the "+" menu as an RPC.
 *
 * Validation is the part with no GUI equivalent. The menu simply HIDES a
 * disabled or uninstalled agent (visibleCliIds), but a CLI caller has no menu
 * to look at, so an unusable id has to come back as an error naming the ids
 * that would work, rather than a tab whose PTY dies on exec.
 *
 * Deliberately does NOT focus the new tab. A shell command should not yank the
 * user's view mid-work, the same reasoning that keeps `--headless` from
 * stealing a window; the GUI's "+" focuses because a human just clicked it.
 */
// Exported for the store-sequence test: the ordering rules below are
// invisible in this function's own code (they are properties of addTab /
// syncDurableTabs), so the test has to drive the REAL handler. A test that
// re-implements the sequence passes against a copy of the bug.
export async function newTabHandler(raw: unknown): Promise<{
  taskId: string; tabId: string; cli: string; title: string;
}> {
  const p = raw as NewTabParams;
  if (typeof p?.taskId !== "string" || !p.taskId) throw new Error("new_tab requires a taskId");
  const app0 = useApp.getState();
  if (!app0.tasks.some(t => t.id === p.taskId)) await app0.loadAll();
  // Same cold-launch race as `agents`, and it decides an ACCEPT/REJECT here
  // rather than a display value: without detection every enabled agent looks
  // usable, so an uninstalled --agent slips through and dies at exec.
  //
  // Skipped for `shell`, which validates nothing against the registry.
  // Hydration runs a login-shell PATH probe per agent, so doing it there
  // would race App.tsx's own refreshClis to no purpose.
  if (p.kind !== "shell") await ensureRegistryHydrated();
  const app = useApp.getState();
  const task = app.tasks.find(t => t.id === p.taskId);
  if (!task) throw new Error(`unknown task ${p.taskId}`);
  if (task.archived) throw new Error(`task ${task.name} is archived`);

  const registry = app.agents;
  let cli: string;
  // Extra tab fields a kind may need (a custom task's launch command).
  let extra: Record<string, unknown> = {};
  switch (p.kind) {
    case "shell":
      cli = "shell";
      break;
    case "default": {
      cli = task.cli;
      // A custom-command task's tab carries its launch command; without it
      // TerminalPane spawns a bare login shell that STILL gets task_id, i.e.
      // a caged terminal the user types into. That is the exact shape #32
      // removed, and the "+" menu cannot produce it because it never offers
      // `custom`.
      if (cli === "custom") {
        const cmd = (task as { custom_command?: string | null }).custom_command;
        if (!cmd) throw new Error("this task has no launch command to reuse; pass --agent or --shell");
        extra = { command: cmd };
        break;
      }
      // Validated like an explicit --agent: otherwise `termic tab <task>`
      // happily opens a disabled or uninstalled agent whose PTY dies on exec,
      // while `--agent <same id>` refuses it. One verb, two answers.
      //
      // The shell short-circuit is live, not defensive: shell TASKS exist
      // (NewTaskDialog's no-agent "Terminal" fallback persists cli="shell"),
      // and the registry has no shell entry, so validating it like an agent
      // would refuse every shell task's default tab as "not usable".
      if (cli !== "shell" && !registryView().some(e => e.id === cli && e.usable)) {
        throw new Error(
          `the task's agent is not usable: ${cli}. Enable or install it, or pass `
          + "--agent/--shell (see `termic agents`)",
        );
      }
      break;
    }
    case "agent": {
      if (!p.id) throw new Error("new_tab agent kind requires an id");
      const view = registryView();
      if (!view.some(e => e.id === p.id && e.kind === "agent" && e.usable)) {
        const known = registry.find(a => a.id === p.id);
        const why = !known ? "unknown agent"
          : known.disabled ? "agent is disabled in Settings"
          : isTerminalEntry(known) ? "that is a custom terminal, use --terminal"
          : "agent is not installed (not found on PATH)";
        const usable = view.filter(e => e.kind === "agent" && e.usable).map(e => e.id).sort();
        throw new Error(
          `${why}: ${p.id}. Available: ${usable.join(", ") || "none"} (see \`termic agents\`)`,
        );
      }
      cli = p.id;
      // The server already gated --resume on the registry's resume_id_args;
      // re-check against the LIVE registry (settings can drift between the
      // Rust snapshot and hydration) so a seed the spawn would silently
      // ignore comes back as an error instead of a fresh session.
      if (typeof p.resume === "string" && p.resume && !cliSupportsResumeById(cli)) {
        throw new Error(`agent ${cli} cannot resume a session by id`);
      }
      break;
    }
    case "terminal": {
      if (!p.id) throw new Error("new_tab terminal kind requires an id");
      const view = registryView();
      if (!view.some(e => e.id === p.id && e.kind === "terminal" && e.usable)) {
        const usable = view.filter(e => e.kind === "terminal" && e.usable).map(e => e.id).sort();
        throw new Error(
          `unknown or disabled custom terminal: ${p.id}. Available: ${usable.join(", ") || "none"} (see \`termic agents\`)`,
        );
      }
      cli = p.id;
      break;
    }
    default:
      throw new Error(`unknown tab kind: ${p.kind}`);
  }

  // A custom-command task's tab is titled with the TASK NAME, matching the
  // store's own restore and seed paths (app.ts); agentDisplayName("custom")
  // would render the generic "Command" instead and drift from the GUI.
  const title = cli === "shell" ? "Terminal"
    : cli === "custom" ? (task.name || "Command")
    : agentDisplayName(cli, registry);
  const tabId = crypto.randomUUID();
  const s = useApp.getState();
  // Mounting a STOPPED task (GH #119 evicts it from mountedTasks but keeps
  // its tabs) respawns every agent in it. Asking for one tab should not undo
  // an explicit "stop this task", so say what would happen instead of doing
  // it. `send --resume` takes the other choice deliberately; there the user
  // asked to talk to the agent, here they asked for a new tab.
  //
  // This MUST be read before the restore below. ensureDefaultTab REPOPULATES
  // tabs[taskId] from persisted_tabs, so a post-restore read cannot tell a
  // stopped task from one that was simply never opened this session, and
  // refuses both. Nothing is mounted until setActiveTask/mountTasks runs, so
  // that mistake refuses every task on a cold start, which is exactly the
  // path `termic tab` auto-launches into.
  const stopped = !s.mountedTasks.has(p.taskId) && (s.tabs[p.taskId]?.length ?? 0) > 0;
  if (stopped) {
    throw new Error(
      `task ${task.name} is stopped; open it in Termic (or \`termic open\`) before adding a tab, `
      + "so its other agents are not respawned as a side effect",
    );
  }
  // RESTORE THE PERSISTED SET FIRST, exactly as sendPromptHandler does.
  // addTab runs syncDurableTabs, which treats whatever is in the store as the
  // live set: on a task that has not been mounted this session (the CLI's
  // whole use case) that set is EMPTY, so pre-adding would rewrite
  // persisted_tabs to just the new tab and forget every secondary agent's
  // session id, permanently. It would also make the new tab the task's first
  // tab of its cli, i.e. is_default, hijacking what attach/logs/send resolve
  // to and handing it the main session's cwd-resume.
  //
  // Unconditional, like sendPromptHandler. ensureDefaultTab already no-ops
  // when live main tabs exist, so guarding on persisted_tabs.length buys
  // nothing and skips the SEED path, which is precisely what a task with an
  // empty durable set needs (main tab X-ed, or a legacy pre-persistence
  // record). Skipping it leaves the task holding only this new tab, and
  // TaskView's mount effect then early-returns because a main tab exists.
  s.ensureDefaultTab(p.taskId, task.cli);
  s.mountTasks([p.taskId]);
  // A --resume seed rides in as the tab's own sessionId: TerminalPane's
  // spawn then composes the agent's `resume_id_args` around it exactly as
  // it would for a uuid termic minted itself (agent kind only; the server
  // rejects the other kinds before the RPC).
  const seed = p.kind === "agent" && typeof p.resume === "string" && p.resume
    ? { sessionId: p.resume } : {};
  s.addTab(p.taskId, { id: tabId, type: "terminal", title, cli, ...seed, ...extra }, { focus: false });
  return { taskId: p.taskId, tabId, cli, title };
}

// ─────────────────────────── dispatch ────────────────────────────────

const handlers: Record<string, Handler> = {
  open_task: openTaskHandler,
  new_task: newTaskHandler,
  new_tab: newTabHandler,
  list_agents: listAgentsHandler,
  send_prompt: sendPromptHandler,
  archive_task: archiveTaskHandler,
  rename_task: renameTaskHandler,
  project_add: projectAddHandler,
  project_remove: projectRemoveHandler,
};

async function dispatch(req: RpcRequest): Promise<void> {
  const progress: Progress = value => {
    // Fire-and-forget, same as the result: a server that timed out and
    // dropped the id discards these harmlessly.
    invoke("cli_rpc_progress", { id: req.id, payload: JSON.stringify(value ?? null) }).catch(
      () => {},
    );
  };
  let payload: string;
  try {
    const handler = handlers[req.method];
    if (!handler) throw new Error(`unknown method "${req.method}"`);
    const value = await handler(req.params, progress);
    payload = JSON.stringify({ ok: true, value: value ?? null });
  } catch (e) {
    payload = JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) });
  }
  invoke("cli_rpc_result", { id: req.id, payload }).catch(() => {});
}

let started = false;

/** Register the control-socket RPC listener. Idempotent; safe to call on
 *  every mount. Returns an unlisten for teardown. The returned unlisten
 *  clears the latch, so a teardown-then-remount (or a re-run mount effect)
 *  re-registers instead of silently leaving the RPC channel dead. */
export function initCliRpc(): Promise<UnlistenFn> {
  if (started) return Promise.resolve(() => {});
  started = true;
  return listen<RpcRequest>("cli-rpc://request", ev => {
    void dispatch(ev.payload);
  })
    .then(unlisten => {
      // Tell the server the listener exists: RPCs wait on this latch,
      // because an event emitted before registration is dropped, not
      // queued (the cold-launch `termic new` case).
      invoke("cli_rpc_ready").catch(() => {});
      return () => {
        started = false;
        unlisten();
      };
    })
    .catch(err => {
      // A failed registration must not wedge the latch on forever.
      started = false;
      throw err;
    });
}
