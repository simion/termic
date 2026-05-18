// Thin Tauri IPC wrappers. Each function maps 1:1 to a #[tauri::command] in
// src-tauri/src/lib.rs. Keep arguments shaped exactly as the Rust signature
// expects (camelCase vs snake_case quirks handled here so call-sites stay clean).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Project, Workspace, CreateWorkspaceArgs, Settings, DiscoveredRepo,
  CliInfo, ChangeFile, Changes, FileEntry, Agent,
} from "./types";

// ───────────────────────────── projects ─────────────────────────────

export const projectsList   = () => invoke<Project[]>("projects_list");
export const projectAdd     = (rootPath: string) => invoke<Project>("project_add", { rootPath });
export const projectUpdate  = (p: Project) => invoke<void>("project_update", { p });
export const projectRemove  = (id: string) => invoke<void>("project_remove", { id });
export const projectRename  = (id: string, name: string) => invoke<void>("project_rename", { id, name });

// ───────────────────────────── workspaces ─────────────────────────────

export const workspacesList    = () => invoke<Workspace[]>("workspaces_list");
export const workspaceCreate   = (args: CreateWorkspaceArgs) => invoke<Workspace>("workspace_create", { args });
export const workspaceOpenRepo = (projectId: string, cli?: string) =>
  invoke<Workspace>("workspace_open_repo", { projectId, cli });
export const workspaceArchive  = (id: string) => invoke<void>("workspace_archive", { id });
export const workspaceDelete   = (id: string) => invoke<void>("workspace_delete", { id });
export const workspaceSetCli   = (id: string, cli: string) => invoke<void>("workspace_set_cli", { id, cli });
/** Update the workspace's sandbox config. The Rust side SIGKILLs every
 *  live PTY for this workspace so the next mount picks up the new
 *  profile; the returned number is the count that was terminated -
 *  use it to word the user-facing warning ("This will restart N agents").
 *  The frontend's PTY exit listener fires on each kill; existing
 *  TerminalPane already surfaces the Restart overlay on exit. */
export const workspaceSetSandbox = (
  id: string,
  enabled: boolean,
  rwPaths: string[],
  denyPaths: string[],
  allowedHosts: string[],
) => invoke<number>("workspace_set_sandbox", {
  id, enabled,
  rwPaths, denyPaths, allowedHosts,
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
export interface DenyPath { path: string; count: number; last_seen_unix_ms: number }
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
  candidate?: { rwPaths: string[]; denyPaths: string[]; allowedHosts: string[] },
) =>
  invoke<ProbeResult[]>("workspace_test_sandbox", {
    id,
    rwPaths: candidate?.rwPaths,
    denyPaths: candidate?.denyPaths,
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
export const agentsDefaults = () => invoke<import("@/lib/types").Agent[]>("agents_defaults");
export const workspaceDiff     = (id: string) => invoke<string>("workspace_diff", { id });
export const workspaceSendDiffToMain = (id: string) =>
  invoke<{ tracked_files: number; untracked_files: number }>("workspace_send_diff_to_main", { id });
export const workspaceFileDiff = (id: string, path: string) => invoke<string>("workspace_file_diff", { id, path });
export const workspaceFileRead = (id: string, path: string) => invoke<string>("workspace_file_read", { id, path });
export const workspaceFiles    = (id: string) => invoke<string[]>("workspace_files", { id });
export const workspaceDirList  = (id: string, rel: string) => invoke<FileEntry[]>("workspace_dir_list", { id, rel });
export const workspaceChanges  = (id: string) => invoke<Changes>("workspace_changes", { id });
export const workspaceRunScript= (id: string, which: "setup" | "run" = "run") =>
  invoke<string>("workspace_run_script", { id, which });
/** Kick off a streaming run; subscribe to `script-output://<id>:<kind>` for
 *  per-line stdout/stderr and `script-done://<id>:<kind>` for completion. */
export const workspaceRunScriptStream = (id: string, kind: "setup" | "run") =>
  invoke<void>("workspace_run_script_stream", { id, kind });
export const workspaceStopScript = (id: string, kind: "setup" | "run") =>
  invoke<void>("workspace_stop_script", { id, kind });

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

export const notify    = (title: string, body: string) => invoke<void>("notify", { title, body });
export const openPath  = (path: string) => invoke<void>("open_path", { path });
export const homeDir   = () => invoke<string>("home_dir");
export const pathExists= (path: string) => invoke<boolean>("path_exists", { path });
export const logLine   = (msg: string) => invoke<void>("log_line", { msg });

export type { ChangeFile };
