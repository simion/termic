// Thin Tauri IPC wrappers. Each function maps 1:1 to a #[tauri::command] in
// src-tauri/src/lib.rs. Keep arguments shaped exactly as the Rust signature
// expects (camelCase vs snake_case quirks handled here so call-sites stay clean).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Project, ProjectMember, Workspace, CreateWorkspaceArgs, CreateMultiArgs, Settings, DiscoveredRepo,
  ImportableWorktree, CliInfo, ChangeFile, Changes, GitStatus, FileEntry, Agent, RepoConfig,
  SandboxMode,
} from "./types";
import type { CustomThemeFile } from "./customTheme";
import {
  COMPLETION_SOUND_SUPPORTED,
  MACOS_DEFAULT_SOUND,
  completionSoundMacName,
  isCompletionSoundId,
  readCompletionSoundEnabled,
  readCompletionSoundId,
  type CompletionSoundId,
} from "./notificationSounds";

// ───────────────────────────── projects ─────────────────────────────

export const projectsList   = () => invoke<Project[]>("projects_list");
/** `nonGit` adds a plain folder (not a git repo) — issue #4. */
export const projectAdd     = (rootPath: string, nonGit?: boolean) => invoke<Project>("project_add", { rootPath, nonGit });
export const projectAddMulti = (rootPath: string, name: string, members: ProjectMember[], nonGit?: boolean) =>
  invoke<Project>("project_add_multi", { rootPath, name, members, nonGit });
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
/** List a project's git worktrees not yet open as workspaces (issue #5). */
export const workspaceImportableWorktrees = (projectId: string) =>
  invoke<ImportableWorktree[]>("workspace_importable_worktrees", { projectId });
/** Import an existing worktree as a workspace (issue #5). Sandbox args
 *  mirror workspace_create: when omitted, Rust falls back to the
 *  project default + merged default lists. */
export const workspaceImportWorktree = (
  projectId: string,
  path: string,
  name?: string,
  cli?: string,
  sandbox?: { enabled: boolean; mode?: SandboxMode; rwPaths: string[]; allowedHosts: string[] },
) =>
  invoke<Workspace>("workspace_import_worktree", {
    projectId, path, name, cli,
    sandboxEnabled: sandbox?.enabled,
    sandboxMode: sandbox?.mode,
    sandboxRwPaths: sandbox?.rwPaths,
    sandboxAllowedHosts: sandbox?.allowedHosts,
  });
export const workspaceArchive  = (id: string, deleteBranch?: boolean) => invoke<void>("workspace_archive", { id, deleteBranch });
export const workspaceRestore  = (id: string) => invoke<Workspace>("workspace_restore", { id });
export const workspaceDelete   = (id: string) => invoke<void>("workspace_delete", { id });
export const workspaceSetCli   = (id: string, cli: string) => invoke<void>("workspace_set_cli", { id, cli });
/** Update a custom-command workspace's launch command (multiline bash
 *  script). Only valid for cli==="custom" workspaces. Persists and
 *  returns the updated workspace; live PTYs keep running until the user
 *  restarts the agent tab. */
export const workspaceSetCustomCommand = (id: string, command: string) =>
  invoke<Workspace>("workspace_set_custom_command", { id, command });
/** Set or clear a workspace's resume-args override. An empty string clears
 *  it (back to default resume logic); otherwise the string is used verbatim
 *  (placeholders expanded) as the resume block on the next agent spawn.
 *  Returns the updated workspace; live PTYs keep running until restarted. */
export const workspaceSetResumeOverride = (id: string, command: string) =>
  invoke<Workspace>("workspace_set_resume_override", { id, command });
/** Persist the per-workspace YOLO flag. Applied to every agent launched
 *  in this workspace (next launch; live agents are flipped separately via
 *  the agent's runtime YOLO command where supported). */
export const workspaceSetYolo = (id: string, yolo: boolean) =>
  invoke<void>("workspace_set_yolo", { id, yolo });
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
  mode: SandboxMode,
  rwPaths: string[],
  allowedHosts: string[],
  /** SIGKILL live PTYs so they relaunch under the new profile.
   *  Pass false ONLY from the explicit "Save without restart" path —
   *  the running agent retains its OLD seatbelt permissions until it
   *  next respawns. The dialog warns the user about this. */
  killLive: boolean = true,
) => invoke<number>("workspace_set_sandbox", {
  id, mode,
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

// ── MONITORING activity: every observed file op + network request,
//    each with a `would_block` flag (= ENFORCING would have denied it).
//    Backs the two-tab (Aggregate / Detailed) activity popover. ──

/** Combined access totals (footer chip in MONITORING mode). */
export const sandboxAccessCounts = (id: string) =>
  invoke<SandboxDenyCounts>("sandbox_access_counts", { id });

/** Set the MONITORING recording filters. These gate RECORDING (not just
 *  display): excludeWs drops workspace-dir accesses; wbOnly records only
 *  would-block ones. Prunes already-recorded entries the filters exclude. */
export const sandboxSetMonitorFilters = (id: string, excludeWs: boolean, wbOnly: boolean) =>
  invoke<void>("sandbox_set_monitor_filters", { id, excludeWs, wbOnly });

/** One observed network request. `would_block` true = host not on the
 *  allowlist (would be 403'd under ENFORCING). */
export interface AccessHost {
  host: string; port: number; count: number;
  last_seen_unix_ms: number; would_block: boolean;
}
export const sandboxRecentAccessHosts = (id: string) =>
  invoke<AccessHost[]>("sandbox_recent_access_hosts", { id });

/** One observed filesystem access, keyed by (path, op). `op` is the
 *  seatbelt operation token (file-read-data, file-write-create, …) —
 *  the "mode" of access. `would_block` true = ENFORCING would deny it. */
export interface AccessPath {
  path: string; op: string; count: number;
  last_seen_unix_ms: number; last_pid: number; last_proc: string;
  would_block: boolean;
}
export const sandboxRecentAccessPaths = (id: string) =>
  invoke<AccessPath[]>("sandbox_recent_access_paths", { id });

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

/** "Allow · per agent" — append a path/host to the AGENT registry so
 *  every workspace running that CLI (across all projects) inherits it.
 *  Picked up at the next agent restart. */
export const agentSandboxAddAllowedPath = (agentId: string, path: string) =>
  invoke<void>("agent_sandbox_add_allowed_path", { agentId, path });
export const agentSandboxAddAllowedHost = (agentId: string, host: string) =>
  invoke<void>("agent_sandbox_add_allowed_host", { agentId, host });

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
export const repoConfigLoadAt = (path: string) =>
  invoke<RepoConfig | null>("repo_config_load_at", { path });

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
/** Replace the workspace's durable agent-tab list (metadata + order). Each
 *  tab's session uuid is preserved across the rewrite (matched by id) so a
 *  layout change never clobbers a minted session; a tab dropped from the
 *  list is forgotten (the X-closes-completely behavior). */
export const workspaceSetTabs = (id: string, tabs: import("@/lib/types").PersistedTab[]) =>
  invoke<void>("workspace_set_tabs", { id, tabs });
/** Pin (or clear, via "") the per-tab session uuid for one durable tab.
 *  Keyed by tab id so several agents in a workspace resume independently. */
export const workspaceSetTabSessionId = (id: string, tabId: string, uuid: string) =>
  invoke<void>("workspace_set_tab_session_id", { id, tabId, uuid });
/** Persist the JSON-encoded SplitTree for a workspace. Pass null to clear. */
export const workspaceSetSplitLayout = (id: string, layout: string | null) =>
  invoke<void>("workspace_set_split_layout", { id, layout });
export const agentsDefaults = () => invoke<import("@/lib/types").Agent[]>("agents_defaults");
/** Run a shell command in `cwd` via `sh -lc` and return trimmed stdout.
 *  Used by post_launch_capture to harvest the CLI's session ID after the
 *  agent creates its first session. */
export const runCaptureCommand = (cmd: string, cwd: string) =>
  invoke<string>("run_capture_command", { cmd, cwd });
export const workspaceDiff     = (id: string) => invoke<string>("workspace_diff", { id });
export const workspaceSendDiffToMain = (id: string) =>
  invoke<{ tracked_files: number; untracked_files: number }>("workspace_send_diff_to_main", { id });

// ───────────────────────────── spotlight ─────────────────────────────

export const workspaceSpotlightStart   = (id: string) => invoke<void>("workspace_spotlight_start",   { id });
export const workspaceSpotlightStop    = (id: string) => invoke<void>("workspace_spotlight_stop",    { id });
export const workspaceSpotlightResync  = (id: string) => invoke<void>("workspace_spotlight_resync",  { id });
export const workspaceSpotlightStatus  = ()           => invoke<Record<string, string>>("workspace_spotlight_status");

/** Copy a dropped file into TMPDIR (sandbox-readable) and return the staged
 *  path. Used when dropping a file onto a sandboxed agent terminal. */
export const terminalStageFile = (wsId: string, src: string) =>
  invoke<string>("terminal_stage_file", { wsId, src });
export const workspaceFileDiff = (id: string, path: string) => invoke<string>("workspace_file_diff", { id, path });
export const workspaceFileDiffSides = (id: string, path: string) =>
  invoke<{ original: string; modified: string; original_exists: boolean; modified_exists: boolean; fp: string }>(
    "workspace_file_diff_sides", { id, path },
  );
export const workspaceFileRead = (id: string, path: string) => invoke<string>("workspace_file_read", { id, path });
export const workspaceFileWrite = (id: string, path: string, content: string) =>
  invoke<void>("workspace_file_write", { id, path, content });
export const workspaceFiles    = (id: string) => invoke<string[]>("workspace_files", { id });
// `heal` restores any missing repo-root member symlink while listing the
// root — only worth doing at intentional moments (workspace launch, manual
// refresh), not on every agent-settle reload, so the caller opts in.
export const workspaceDirList  = (id: string, rel: string, heal = false) => invoke<FileEntry[]>("workspace_dir_list", { id, rel, heal });
/** Rename a file/dir in place (new bare name). Returns the new ws-relative path. */
export const workspacePathRename = (id: string, path: string, newName: string) =>
  invoke<string>("workspace_path_rename", { id, path, newName });
/** Permanently delete a file/dir (caller confirms first). */
export const workspacePathDelete = (id: string, path: string) =>
  invoke<void>("workspace_path_delete", { id, path });
/** Reveal a file/dir in the OS file manager ("Show in Finder"). */
export const workspaceRevealPath = (id: string, path: string) =>
  invoke<void>("workspace_reveal_path", { id, path });
export const workspaceChanges  = (id: string) => invoke<Changes>("workspace_changes", { id });
// Fork-style staging: staged/unstaged split per repo + stage/unstage/commit.
export const workspaceGitStatus = (id: string) => invoke<GitStatus>("workspace_git_status", { id });
export const workspaceStage   = (id: string, dirName: string, paths: string[]) =>
  invoke<void>("workspace_stage", { id, dirName, paths });
export const workspaceUnstage = (id: string, dirName: string, paths: string[]) =>
  invoke<void>("workspace_unstage", { id, dirName, paths });
export const workspaceCommit  = (id: string, dirName: string, subject: string, body: string, amend: boolean, push: boolean) =>
  invoke<void>("workspace_commit", { id, dirName, subject, body, amend, push });
export const workspaceDiscard = (id: string, dirName: string, paths: string[]) =>
  invoke<void>("workspace_discard", { id, dirName, paths });
export const workspaceRunScript= (id: string, which: "setup" | "run" = "run") =>
  invoke<string>("workspace_run_script", { id, which });
/** Kick off a streaming run. Subscribe to:
 *    `script-output://<id>:<topic-member>:<kind>`  (per-line stdout/stderr)
 *    `script-done://<id>:<topic-member>:<kind>`    (completion)
 *  where `<member>` is empty for the host (single-repo + multi-host
 *  scripts) or the composition member's `dir_name`, hex-encoded for the
 *  event topic because Tauri rejects dots and other punctuation. */
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

// The user's login shell ($SHELL, falling back to zsh/bash/fish/sh).
// See lib/loginShell.ts for the cached wrapper used by the terminals.
export const defaultShell = () => invoke<string>("default_shell");

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
/** Raw custom theme files from `~/.config/termic/themes/*.json`. Unvalidated —
 *  run each through customTheme.ts's sanitizeTheme before use. */
export const themesList = () => invoke<CustomThemeFile[]>("themes_list");
/** Ensure + return the custom themes directory (absolute path), for the
 *  picker's "Open themes folder" row. */
export const themesDir  = () => invoke<string>("themes_dir");
export const settingsSave  = (s: Settings) => invoke<void>("settings_save", { s });
export const agentsSave    = (agents: Agent[]) => invoke<void>("agents_save", { agents });
export const discoverRepos = (dir: string) => invoke<DiscoveredRepo[]>("discover_repos", { dir });
export const detectClis    = () => invoke<CliInfo[]>("detect_clis");
export const listMonospaceFonts = () => invoke<string[]>("list_monospace_fonts");
/** True when this debug instance is driven by the e2e automation bridge
 *  (TERMIC_AUTOMATION=1). Always false in release builds. */
export const automationArmed = () => invoke<boolean>("automation_armed");

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
export async function notify(
  title: string,
  body: string,
  route?: NotifyRoute,
  opts?: { sound?: boolean | string },
): Promise<void> {
  try {
    if (!(await ensureNotifyPermission())) return;
    // Play the completion sound DIRECTLY (afplay) rather than through the
    // notification's `sound` field: mac-notification-sys rides the deprecated
    // NSUserNotification API, which drops the banner sound on modern macOS.
    // The banner stays silent; the sound is decoupled and reliable.
    if (opts?.sound) void playCompletionSound(opts.sound, true);
    notifSend({ title, body, extra: route ? { wsId: route.wsId, tabId: route.tabId } : undefined });
  } catch {
    // Plugin unavailable (e.g. headless) — silently skip.
  }
}

/** Fire a sample notification with the given sound. Mirrors the shape of a
 *  real agent-finished notification (title "project · workspace", body
 *  "agent finished") so the preview shows exactly what users will get.
 *  Note: in dev the banner carries the Terminal icon — the notification
 *  plugin attributes unbundled dev binaries to com.apple.Terminal; release
 *  builds show the termic app icon. */
export async function previewCompletionSound(
  soundId?: CompletionSoundId,
  example?: { title?: string; body?: string },
): Promise<void> {
  try {
    // Play directly (afplay) so Preview works regardless of macOS
    // notification-sound settings. respectToggle=false: Preview always plays.
    await playCompletionSound(soundId ?? readCompletionSoundId(), false);
    // Still show a silent sample banner so the user sees the notification
    // shape, but only if notifications are permitted — never block the sound.
    if (await ensureNotifyPermission()) {
      notifSend({
        title: example?.title ?? "project · workspace",
        body: example?.body ?? "agent finished",
      });
    }
  } catch {
    // Plugin unavailable (e.g. headless) — silently skip.
  }
}

/** Resolve a completion sound and play it directly via afplay (Rust side).
 *  Decoupled from the notification banner because mac-notification-sys drops
 *  the banner sound on modern macOS. No-op off macOS / when the toggle gates
 *  it out / when nothing resolves. */
async function playCompletionSound(sound: boolean | string, respectToggle: boolean): Promise<void> {
  const name = await resolveCompletionSoundValue(sound, respectToggle);
  if (!name) return;
  try { await invoke<void>("play_completion_sound", { name }); } catch {}
}

// macOS resolves notification sounds by NAME via the Library/Sounds search
// path; it never finds our bundled Tauri resources (nested dir in release,
// no .app bundle in dev) and can't decode mp3 anyway. So custom sounds ship
// in the bundle as .caf and get copied into ~/Library/Sounds on first use,
// then referenced by their installed (extension-less) name.
let chooChooInstall: Promise<boolean> | null = null;
function ensureChooChooInstalled(): Promise<boolean> {
  chooChooInstall ??= invoke<void>("install_notification_sound", {
    resource: "resources/sounds/choo_choo.caf",
    fileName: "termic_choo_choo.caf",
  }).then(
    () => true,
    () => { chooChooInstall = null; return false; },  // retry on next use
  );
  return chooChooInstall;
}

async function resolveCompletionSoundValue(
  sound: boolean | string,
  respectToggle: boolean = true,
): Promise<string | undefined> {
  if (!sound) return undefined;
  // The catalog is macOS sound names — on Linux/Windows none resolve, so
  // send no sound key at all and let the platform default apply.
  if (!COMPLETION_SOUND_SUPPORTED) return undefined;
  if (respectToggle && !readCompletionSoundEnabled()) return undefined;
  const selected = typeof sound === "string" ? sound : readCompletionSoundId();
  if (!isCompletionSoundId(selected)) return selected; // explicit macOS name passed through
  // Bundled sound: must be copied into ~/Library/Sounds before its name
  // resolves; fall back to the stock default sound if that fails.
  if (selected === "choo_choo" && !(await ensureChooChooInstalled())) {
    return MACOS_DEFAULT_SOUND;
  }
  return completionSoundMacName(selected);
}

export const openPath  = (path: string) => invoke<void>("open_path", { path });
/** Reveal an absolute path in the OS file manager (select it on macOS/Windows,
 *  open its parent on Linux). For workspace-relative paths use workspaceRevealPath. */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const homeDir   = () => invoke<string>("home_dir");
export const pathExists= (path: string) => invoke<boolean>("path_exists", { path });
export const pathIsGitRepo = (path: string) => invoke<boolean>("path_is_git_repo", { path });
export const logLine   = (msg: string) => invoke<void>("log_line", { msg });
/** Append a line to a named file in the OS temp dir. Used by the ptyDebug
 *  logger in TerminalPane when `localStorage.ptyDebug = "1"`. */
export const ptyDebugAppend = (file: string, line: string) =>
  invoke<void>("pty_debug_append", { file, line });

export type { ChangeFile };
