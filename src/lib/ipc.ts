// Thin Tauri IPC wrappers. Each function maps 1:1 to a #[tauri::command] in
// src-tauri/src/lib.rs. Keep arguments shaped exactly as the Rust signature
// expects (camelCase vs snake_case quirks handled here so call-sites stay clean).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Project, ProjectMember, Workspace, CreateWorkspaceArgs, CreateMultiArgs, Settings, DiscoveredRepo,
  CliInfo, ChangeFile, Changes, FileEntry, Agent, RepoConfig,
} from "./types";

// ───────────────────────────── projects ─────────────────────────────

export const projectsList   = () => invoke<Project[]>("projects_list");
export const projectAdd     = (rootPath: string) => invoke<Project>("project_add", { rootPath });
export const projectAddMulti = (rootPath: string, name: string, members: ProjectMember[]) =>
  invoke<Project>("project_add_multi", { rootPath, name, members });
export const projectSetMembers = (id: string, members: ProjectMember[]) =>
  invoke<void>("project_set_members", { id, members });
export const projectUpdate  = (p: Project) => invoke<void>("project_update", { p });
export const projectRemove  = (id: string) => invoke<void>("project_remove", { id });
export const projectReorder = (ids: string[]) => invoke<void>("project_reorder", { ids });
export const projectRename  = (id: string, name: string) => invoke<void>("project_rename", { id, name });

// ───────────────────────────── workspaces ─────────────────────────────

export const workspacesList    = () => invoke<Workspace[]>("workspaces_list");
export const workspaceCreate   = (args: CreateWorkspaceArgs) => invoke<Workspace>("workspace_create", { args });
export const workspaceCreateMulti = (args: CreateMultiArgs) => invoke<Workspace>("workspace_create_multi", { args });
export const workspaceOpenRepo = (projectId: string, cli?: string, name?: string, command?: string) =>
  invoke<Workspace>("workspace_open_repo", { projectId, cli, name, command });
export const workspaceArchive  = (id: string, deleteBranch?: boolean) => invoke<void>("workspace_archive", { id, deleteBranch });
export const workspaceDelete   = (id: string) => invoke<void>("workspace_delete", { id });
export const workspaceSetCli   = (id: string, cli: string) => invoke<void>("workspace_set_cli", { id, cli });
/** Update the workspace's sandbox config. The Rust side SIGKILLs every
 *  live PTY for this workspace so the next mount picks up the new
 *  profile; the returned number is the count that was terminated -
 *  use it to word the user-facing warning ("This will restart N agents").
 *  The frontend's PTY exit listener fires on each kill; existing
 *  TerminalPane already surfaces the Restart overlay on exit. */
export const workspaceListFilesForFinder = (id: string) =>
  invoke<string[]>("workspace_list_files_for_finder", { id });

// ───────────────────────────── find in files ─────────────────────────────

export interface GrepHit { path: string; line: number; col: number; preview: string }

/** Start a streaming `git grep` in the workspace. Results arrive via
 *  `grep-result://<searchId>` events (see `onGrepResult`) and a final
 *  `grep-done://<searchId>` (`onGrepDone`). The caller generates a fresh
 *  `searchId` per keystroke so we can ignore late events from cancelled
 *  searches; Rust auto-SIGKILLs any prior grep for the same workspace. */
export const workspaceGrepStart = (id: string, query: string, searchId: string) =>
  invoke<void>("workspace_grep_start", { id, query, searchId });

export const workspaceGrepCancel = (id: string) =>
  invoke<void>("workspace_grep_cancel", { id });

/** Rust batches hits (~30ms / 50-hit windows) before emitting to keep
 *  the WKWebView main thread from saturating on hot searches. Payload
 *  is `{ hits: GrepHit[] }`; the callback receives each batch as an array. */
export function onGrepResult(searchId: string, cb: (hits: GrepHit[]) => void): Promise<UnlistenFn> {
  return listen<{ hits: GrepHit[] }>(`grep-result://${searchId}`, ev => cb(ev.payload.hits));
}
export function onGrepDone(searchId: string, cb: (d: { truncated: boolean }) => void): Promise<UnlistenFn> {
  return listen<{ truncated: boolean }>(`grep-done://${searchId}`, ev => cb(ev.payload));
}

export const workspaceSetSandbox = (
  id: string,
  enabled: boolean,
  rwPaths: string[],
  allowedHosts: string[],
  /** SIGKILL live PTYs so they relaunch under the new profile.
   *  Pass false ONLY from the explicit "Save without restart" path —
   *  the running agent retains its OLD seatbelt permissions until it
   *  next respawns. The dialog warns the user about this. */
  killLive: boolean = true,
) => invoke<number>("workspace_set_sandbox", {
  id, enabled,
  rwPaths, allowedHosts,
  killLive,
});
/** Whether the OS supports the sandbox at all. Returns false on
 *  Linux / Windows (Seatbelt is macOS-only). Frontend uses this to
 *  grey out the cage toggle + show an "unavailable on your OS"
 *  banner instead of letting the user enable something that would
 *  crash agent spawn. */
export const sandboxAvailable = () => invoke<boolean>("sandbox_available");

/** Per-workspace deny counters surfaced in the TerminalPane footer
 *  chip. Currently only `network` (the proxy bumps it on every CONNECT
 *  / HTTP request that fails the host allowlist). Cheap to poll. */
export interface SandboxDenyCounts { network: number; path: number }
export const sandboxDenyCounts = (id: string) =>
  invoke<SandboxDenyCounts>("sandbox_deny_counts", { id });

/** Per-host breakdown for the "N blocked" footer chip popover.
 *  Sorted by most-recently-seen first. */
export interface DenyHost { host: string; count: number; last_seen_unix_ms: number }
export const sandboxRecentDeniedHosts = (id: string) =>
  invoke<DenyHost[]>("sandbox_recent_denied_hosts", { id });

/** Per-path filesystem deny breakdown. Parsed from macOS log stream
 *  in the background (one watcher per sandboxed workspace). */
export interface DenyPath { path: string; count: number; last_seen_unix_ms: number; last_pid: number; last_proc: string }
export const sandboxRecentDeniedPaths = (id: string) =>
  invoke<DenyPath[]>("sandbox_recent_denied_paths", { id });

/** Append a host to the workspace's allowed-hosts list AND respawn
 *  any live PTYs so the new profile takes effect. Returns the number
 *  of agents that were killed. Backs the "Allow" button next to each
 *  blocked host in the footer chip popover. */
export const workspaceSandboxAddAllowedHost = (id: string, host: string) =>
  invoke<number>("workspace_sandbox_add_allowed_host", { id, host });

/** Mirror for filesystem paths — append to allowed_rw_paths and
 *  respawn the agent. Backs the "Allow" button on path rows. */
export const workspaceSandboxAddAllowedPath = (id: string, path: string) =>
  invoke<number>("workspace_sandbox_add_allowed_path", { id, path });

/** Undo of add-allowed-path. Drops the entry from the workspace's
 *  sandbox_rw_paths list (matches both raw and $HOME-tokenized form). */
export const workspaceSandboxRemoveAllowedPath = (id: string, path: string) =>
  invoke<void>("workspace_sandbox_remove_allowed_path", { id, path });

/** "Allow for this repo" — append a host to the repo's committed
 *  `.termic.yaml` (shared with the team, read by the termic CLI).
 *  Comment-preserving; takes effect on the next agent restart.
 *  Counterpart to `workspaceSandboxAddAllowedHost`, which writes the
 *  personal, uncommitted "allow for me" overrides instead. */
export const repoConfigAddAllowedHost = (id: string, host: string) =>
  invoke<void>("repo_config_add_allowed_host", { id, host });

/** Mirror for filesystem paths — append to the repo's `.termic.yaml`. */
export const repoConfigAddAllowedPath = (id: string, path: string) =>
  invoke<void>("repo_config_add_allowed_path", { id, path });

/** Read a project's committed `.termic.yaml` (at its repo root).
 *  Resolves to null when the repo has no such file; rejects when it
 *  exists but is malformed. */
export const repoConfigLoad = (projectId: string) =>
  invoke<RepoConfig | null>("repo_config_load", { projectId });

/** Write a project's `.termic.yaml` (full re-serialize — does not
 *  preserve hand-written comments). Backs the Repository settings. */
export const repoConfigSave = (projectId: string, config: RepoConfig) =>
  invoke<void>("repo_config_save", { projectId, config });

/** Write a fresh `.termic.yaml` scaffold to a project's repo if it
 *  has none. Resolves true if a file was created. */
export const repoConfigScaffold = (projectId: string) =>
  invoke<boolean>("repo_config_scaffold", { projectId });

/** Newest-first list of macOS Sandbox denial lines from `log show` for
 *  the given workspace, last `minutes` minutes (default 10). Surfaces
 *  what got blocked when `npm install` etc. silently failed in a
 *  sandboxed workspace. */
export const workspaceRecentDenials = (id: string, minutes?: number) =>
  invoke<string[]>("workspace_recent_denials", { id, minutes });

/** One probe result from `workspace_test_sandbox`. */
export interface ProbeResult {
  host: string;
  expected: "allow" | "deny";
  ok: boolean;
  http_code: number | null;
  note: string;
}
/** End-to-end sandbox self-test: runs curls inside an ephemeral
 *  sandbox bundle of this workspace; one to an allowed host, one to a
 *  denied host. Returns both outcomes so the user can verify the cage
 *  is actually closed. */
/** Self-test the workspace's sandbox. Optional list args override
 *  the saved workspace config so the dialog can test PENDING edits
 *  (textarea contents) instead of last-saved state. Omit them to
 *  test what's on disk. */
export const workspaceTestSandbox = (
  id: string,
  candidate?: { rwPaths: string[]; allowedHosts: string[] },
) =>
  invoke<ProbeResult[]>("workspace_test_sandbox", {
    id,
    rwPaths: candidate?.rwPaths,
    allowedHosts: candidate?.allowedHosts,
  });

// Sandbox status is now returned synchronously by `ptySpawn` (see
// SpawnResult above). The old `sandbox-status://<id>` event was dropped
// because the listener-attach race could make the warning chip silently
// miss the only emission.
export const workspaceRename   = (id: string, name: string) => invoke<void>("workspace_rename", { id, name });
export const workspaceRecordSpawn = (id: string) => invoke<number>("workspace_record_spawn", { id });
export const workspaceSetHasHistory = (id: string, value: boolean) =>
  invoke<void>("workspace_set_has_history", { id, value });
export const workspaceSetAgentSessionId = (id: string, cli: string, uuid: string) =>
  invoke<void>("workspace_set_agent_session_id", { id, cli, uuid });
export const agentsDefaults = () => invoke<import("@/lib/types").Agent[]>("agents_defaults");
export const workspaceDiff     = (id: string) => invoke<string>("workspace_diff", { id });
export const workspaceSendDiffToMain = (id: string) =>
  invoke<{ tracked_files: number; untracked_files: number }>("workspace_send_diff_to_main", { id });
export const workspaceFileDiff = (id: string, path: string) => invoke<string>("workspace_file_diff", { id, path });
export const workspaceFileDiffSides = (id: string, path: string) =>
  invoke<{ original: string; modified: string }>("workspace_file_diff_sides", { id, path });
export const workspaceFileRead = (id: string, path: string) => invoke<string>("workspace_file_read", { id, path });
export const workspaceFileWrite = (id: string, path: string, content: string) =>
  invoke<void>("workspace_file_write", { id, path, content });
export const workspaceFiles    = (id: string) => invoke<string[]>("workspace_files", { id });
export const workspaceDirList  = (id: string, rel: string) => invoke<FileEntry[]>("workspace_dir_list", { id, rel });
export const workspaceChanges  = (id: string) => invoke<Changes>("workspace_changes", { id });
export const workspaceRunScript= (id: string, which: "setup" | "run" = "run") =>
  invoke<string>("workspace_run_script", { id, which });
/** Kick off a streaming run. Subscribe to:
 *    `script-output://<id>:<member>:<kind>`  (per-line stdout/stderr)
 *    `script-done://<id>:<member>:<kind>`    (completion)
 *  where `<member>` is empty for the host (single-repo + multi-host
 *  scripts) or the composition member's `dir_name`. */
export const workspaceRunScriptStream = (id: string, kind: "setup" | "run", member?: string) =>
  invoke<void>("workspace_run_script_stream", { id, kind, member: member ?? null });
export const workspaceStopScript = (id: string, kind: "setup" | "run", member?: string) =>
  invoke<void>("workspace_stop_script", { id, kind, member: member ?? null });

// ───────────────────────────── ptys ─────────────────────────────

export interface SpawnArgs {
  cwd: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  rows: number;
  cols: number;
  /** When set, Rust looks up the workspace and wraps the spawn in its
   *  sandbox (seatbelt + per-workspace tinyproxy) iff the workspace
   *  was created with sandbox_enabled. Omit for agent-less PTYs
   *  (e.g. AuxTerminal scratch shell) - those never get sandboxed. */
  workspace_id?: string;
  /** Agent ID for THIS tab. Can differ from the workspace's primary
   *  CLI (multi-CLI tabs). Drives which per-agent sandbox allowlist +
   *  host-pattern set the rendered SBPL profile uses. Defaults to the
   *  workspace's `cli` when omitted. */
  agent_id?: string;
}

/** Sandbox status returned alongside the PTY id - tells the caller
 *  whether the cage actually closed (vs. degraded to "filesystem-only,
 *  no network" because tinyproxy didn't start). Previously surfaced
 *  via a separate event that had a race window between Rust's emit
 *  and the frontend's listener attach. */
export interface SandboxStatus {
  active: boolean;
  proxy_active: boolean;
  warning: string;
}
export interface SpawnResult {
  id: string;
  sandbox: SandboxStatus;
}
export const ptySpawn  = (a: SpawnArgs) => invoke<SpawnResult>("pty_spawn", { args: a });
export const ptyWrite  = (ptyId: string, data: number[]) => invoke<void>("pty_write", { ptyId, data });
export const ptyResize = (ptyId: string, rows: number, cols: number) => invoke<void>("pty_resize", { ptyId, rows, cols });
export const ptyKill   = (ptyId: string) => invoke<void>("pty_kill", { ptyId });

/**
 * Listen for PTY output chunks. Rust emits a `PtyChunk { data: Vec<u8> }`
 * struct — NOT a bare byte array — so the payload is `{ data: number[] }`
 * and we have to peel `.data` off before constructing the Uint8Array.
 */
export function onPtyData(ptyId: string, cb: (data: Uint8Array) => void): Promise<UnlistenFn> {
  return listen<{ data: number[] }>(`pty://${ptyId}`, ev => cb(new Uint8Array(ev.payload.data)));
}
/** Listen for PTY exit. Rust emits `PtyExit { code: Option<i32> }`. */
export function onPtyExit(ptyId: string, cb: (code: number | null) => void): Promise<UnlistenFn> {
  return listen<{ code: number | null }>(`pty-exit://${ptyId}`, ev => cb(ev.payload.code));
}

// ───────────────────────────── settings & discovery ─────────────────────────────

export const settingsLoad  = () => invoke<Settings>("settings_load");
export const settingsSave  = (s: Settings) => invoke<void>("settings_save", { s });
export const agentsSave    = (agents: Agent[]) => invoke<void>("agents_save", { agents });
export const discoverRepos = (dir: string) => invoke<DiscoveredRepo[]>("discover_repos", { dir });
export const detectClis    = () => invoke<CliInfo[]>("detect_clis");
export const listMonospaceFonts = () => invoke<string[]>("list_monospace_fonts");

// ───────────────────────────── misc ─────────────────────────────

import {
  isPermissionGranted as notifIsGranted,
  requestPermission as notifRequest,
  sendNotification as notifSend,
  onAction as notifOnAction,
} from "@tauri-apps/plugin-notification";

// Cached permission state so we don't hit the IPC bridge on every notify.
let notifPermission: "granted" | "denied" | "default" | null = null;

/** Route target carried on a notification's `extra` payload so a click
 *  can jump straight to the originating (workspace, tab). */
export interface NotifyRoute { wsId: string; tabId: string; }

/** Register a handler for notification clicks. NOTE: tauri-plugin-notification
 *  fires `onAction` ONLY on mobile — the desktop (macOS/Win/Linux) backend has
 *  no click handler at all. So on macOS this never fires; click routing falls
 *  back entirely to the focus-edge heuristic in useAttentionNotifier (app
 *  activation on click). Kept for mobile/future-plugin support; harmless no-op
 *  on desktop. Receives the {wsId, tabId} we stamped into `extra` at send time. */
export async function onNotifyClick(cb: (route: NotifyRoute) => void): Promise<() => void> {
  try {
    const listener = await notifOnAction((n) => {
      const extra = (n as { extra?: Record<string, unknown> }).extra;
      const wsId = extra?.wsId, tabId = extra?.tabId;
      if (typeof wsId === "string" && typeof tabId === "string") cb({ wsId, tabId });
    });
    return () => { try { listener.unregister(); } catch {} };
  } catch {
    return () => {};
  }
}

/** Ask macOS for notification permission. Safe to call repeatedly — once
 *  granted/denied the OS won't re-prompt. Call from a sensible moment
 *  (e.g. when the user enables Desktop notifications in Settings) so the
 *  system dialog appears in context rather than mid-task. */
export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (notifPermission === "granted") return true;
    if (await notifIsGranted()) { notifPermission = "granted"; return true; }
    const res = await notifRequest();
    notifPermission = res;
    return res === "granted";
  } catch {
    return false;
  }
}

/** Post an OS notification via tauri-plugin-notification (NOT osascript —
 *  that attributes to "Script Editor" and is silently dropped on modern
 *  macOS). Requests permission on first use. No-op if denied. Pass `route`
 *  so a click jumps to the originating (workspace, tab) via onNotifyClick. */
export async function notify(title: string, body: string, route?: NotifyRoute): Promise<void> {
  try {
    if (!(await ensureNotifyPermission())) return;
    notifSend({ title, body, extra: route ? { wsId: route.wsId, tabId: route.tabId } : undefined });
  } catch {
    // Plugin unavailable (e.g. headless) — silently skip.
  }
}
export const openPath  = (path: string) => invoke<void>("open_path", { path });
export const homeDir   = () => invoke<string>("home_dir");
export const pathExists= (path: string) => invoke<boolean>("path_exists", { path });
export const logLine   = (msg: string) => invoke<void>("log_line", { msg });
/** Append a line to a named file in the OS temp dir. Used by the ptyDebug
 *  logger in TerminalPane when `localStorage.ptyDebug = "1"`. */
export const ptyDebugAppend = (file: string, line: string) =>
  invoke<void>("pty_debug_append", { file, line });

export type { ChangeFile };
