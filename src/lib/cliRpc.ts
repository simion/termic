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
  taskOpenRepo,
  taskSetYolo,
  tasksList,
} from "@/lib/ipc";
import { archiveAndRefresh } from "@/lib/archiveTask";
import { withCreateLock } from "@/lib/createLock";
import { markUnattendedSpawn } from "@/lib/unattendedSpawns";
import { deliverMessage } from "@/lib/agentSend";
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
    if (mode === "repo_root") {
      const sandbox = pins ? await mainCheckoutSandbox(p.projectId, pins) : undefined;
      return taskOpenRepo(p.projectId, cli, name, sandbox);
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
      ...(pins ?? {}),
    });
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

/** Wait for the default agent tab to hold a live PTY ("spawn"). */
async function waitForAgentPty(taskId: string): Promise<boolean> {
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (defaultAgentTab(taskId)?.ptyId) return true;
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
): Promise<void> {
  const report = (ok: boolean, error?: string) =>
    invoke("cli_prompt_report", { id: promptId, ok, error: error ?? null }).catch(() => {});
  if (!spawned) {
    await report(false, "the agent PTY never spawned");
    return;
  }
  // Settle beat so the prompt lands in the input box, not a splash
  // screen; then RE-READ the tab (it may have restarted onto a fresh
  // PTY during the settle - never type into a stale pty).
  await sleep(AGENT_SETTLE_MS);
  const tab = defaultAgentTab(taskId);
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
    const still = defaultAgentTab(taskId);
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
  if (typeof p?.name !== "string" || !p.name.trim()) throw new Error("new_task requires a name");
  // Cold launch: the RPC ready-latch can beat loadAll, and an
  // unhydrated store would silently drop the project's sandbox seeds
  // from the merge below. Mirror openTaskHandler's guard.
  if (!useApp.getState().projects.some(pr => pr.id === p.projectId)) {
    await useApp.getState().loadAll();
  }
  // Non-git projects cannot host worktrees; the GUI forces the main
  // checkout for them and so do we (the server already rejected an
  // EXPLICIT --worktree with a clear error).
  const nonGit = useApp.getState().projects.find(pr => pr.id === p.projectId)?.non_git === true;
  const mode: NewTaskMode = nonGit
    ? "repo_root"
    : p.mode === "worktree" ? "worktree" : p.mode === "main" ? "repo_root" : readNewTaskMode();

  const task = await createTask(p, mode);
  // Before anything mounts, so the first spawn composes the flags in.
  if (p.yolo) await taskSetYolo(task.id, true).catch(() => {});
  if (typeof p.prompt === "string" && p.prompt) markUnattendedSpawn(task.id);

  await useApp.getState().loadAll();
  useApp.getState().mountTasks([task.id]);
  if (p.open) useApp.getState().setActiveTask(task.id);

  let stopSetupStream: (() => void) | null = null;
  if (mode === "worktree") {
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

// ─────────────────────────── dispatch ────────────────────────────────

const handlers: Record<string, Handler> = {
  open_task: openTaskHandler,
  new_task: newTaskHandler,
  archive_task: archiveTaskHandler,
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
