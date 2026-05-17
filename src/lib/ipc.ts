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
}

export const ptySpawn  = (a: SpawnArgs) => invoke<string>("pty_spawn", { args: a });
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
