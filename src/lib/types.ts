// Mirrors the Serde structs in src-tauri/src/lib.rs. Keep in sync.

export type CLI = "claude" | "gemini" | "codex";

export interface Project {
  id: string;
  name: string;
  root_path: string;
  workspaces_path: string;
  base_branch: string;
  remote: string;
  preview_url: string;
  files_to_copy: string[];
  setup_script: string;
  run_script: string;
  archive_script: string;
  default_cli: string;
  created: string;
  /** When true, the "New workspace" dialog pre-checks its sandbox toggle.
   *  Existing workspaces aren't re-evaluated - their sandbox pin is
   *  captured at creation and immutable thereafter. */
  default_sandbox?: boolean;
  /** Extra writable subpaths added to the seatbelt profile, on top of
   *  the workspace path + agent config dirs + TMPDIR baked into the
   *  default. `$HOME` and `$WORKSPACE` are substituted at render time. */
  sandbox_rw_paths?: string[];
  /** Extra deny carve-outs on top of the secret-default list
   *  (~/.ssh, ~/.aws, ~/.gnupg, ~/.netrc, ~/.kube, Keychains, …). */
  sandbox_deny_paths?: string[];
  /** Extra POSIX-regex hostname allowlist entries appended to the
   *  per-CLI defaults the proxy enforces. Format mirrors tinyproxy. */
  sandbox_allowed_hosts?: string[];

  /** "single" (default) = one git repo, worktrees branched off it.
   *  "multi" = host repo for shared CLAUDE.md / AGENTS.md / .claude/
   *  + a list of member project ids. Workspaces under a multi project
   *  are worktrees of the host with each member worktree'd or
   *  symlinked inside named subdirs. */
  type?: "single" | "multi";
  /** Member project ids — references rows already in projects.json.
   *  Only meaningful when `type == "multi"`. */
  members?: string[];
}

export type MemberMode = "worktree" | "repo_root";

/** One entry in a multi-repo workspace's composition. Frozen at
 *  workspace creation; the wrapper dir IS the host's worktree and
 *  member entries live at `<wrapper>/<dir_name>`. */
export interface WorkspaceMember {
  project_id: string;
  dir_name: string;
  mode: MemberMode;
  branch: string;
  path: string;
}

export interface Workspace {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  base_branch: string;
  path: string;
  cli: string;
  port: number;
  created: string;
  archived: boolean;
  /** True when this workspace points at the project's main repo checkout
   *  (no git worktree). The UI shows a distinct icon and archive only
   *  removes the entry — the repo on disk is untouched. */
  is_repo_root?: boolean;
  /** Total agent spawns ever recorded for this worktree. Historical
   *  metric only — resume gating uses `has_resumable_history` now. */
  spawn_count?: number;
  /** Persisted: true iff a spawn has survived past the rapid-exit
   *  failure window (~2s). Drives the `--continue`/`--resume` gate so
   *  worktrees with no real conversation don't waste spawns on a
   *  doomed resume attempt. Flipped false on a confirmed failure. */
  has_resumable_history?: boolean;
  /** PINNED at creation. Driven by NewWorkspaceDialog (defaulting to
   *  the project's `default_sandbox`). There is no setter - to flip
   *  it, archive the workspace and recreate. The UI shows a lock
   *  badge on sandboxed rows. */
  sandbox_enabled?: boolean;
  /** Frozen-at-creation copies of the sandbox lists. The dialog seeds
   *  these from the project's defaults, the user adds/removes before
   *  Create, and from then on the workspace owns them. Editing the
   *  project's defaults later WILL NOT reach back into existing
   *  workspaces - matches the immutability promise of sandbox_enabled. */
  sandbox_rw_paths?: string[];
  sandbox_deny_paths?: string[];
  sandbox_allowed_hosts?: string[];
  /** Multi-repo composition. Empty for single-repo workspaces. */
  composition?: WorkspaceMember[];
}

/** Per-member input for `workspace_create_multi`. */
export interface CreateMultiMember {
  project_id: string;
  dir_name?: string;
  mode: MemberMode;
  branch?: string;
  base_branch?: string;
}

export interface CreateMultiArgs {
  project_id: string;
  name: string;
  cli?: string;
  branch?: string;
  base_branch?: string;
  members: CreateMultiMember[];
  id?: string;
  sandbox_enabled?: boolean;
  sandbox_rw_paths?: string[];
  sandbox_deny_paths?: string[];
  sandbox_allowed_hosts?: string[];
}

export interface CreateWorkspaceArgs {
  project_id: string;
  name: string;
  cli?: string;
  base_branch?: string | null;
  branch?: string | null;
  /** Pre-generated workspace UUID. Pass this if you want to subscribe to
   *  `setup-output://<id>` / `setup-done://<id>` events BEFORE invoking — the
   *  alternative (using server-generated ID returned from the call) has a
   *  guaranteed race for empty setup scripts. */
  id?: string;
  /** Sandbox pin captured at creation. When undefined the Rust side
   *  falls back to the project's `default_sandbox`. The pin is
   *  permanent - flip via archive + recreate, never via mutation. */
  sandbox_enabled?: boolean;
  /** Per-workspace sandbox lists. The dialog seeds from the project's
   *  defaults, the user edits, the final shape lands here. Unset =
   *  Rust falls back to the project's defaults verbatim. */
  sandbox_rw_paths?: string[];
  sandbox_deny_paths?: string[];
  sandbox_allowed_hosts?: string[];
}

export interface Agent {
  /** Stable key referenced by Workspace.cli. */
  id: string;
  display_name: string;
  /** Binary or shell command to spawn. Independent of `id` so renames don't
   *  invalidate existing workspaces. */
  command: string;
  args: string[];
  /** Icon identifier. Either a brand id ("claude" / "gemini" / "codex") or
   *  a generic key prefixed with "lucide:" (e.g. "lucide:terminal"). */
  icon_id: string;
  /** Hex color string for the icon tint. */
  color: string;
  /** Built-in (the original 3) — user can edit fields but not remove. */
  builtin: boolean;
  /** Optional capabilities the app consumes when present. Missing = "not
   *  supported by this CLI" → the corresponding UI gracefully omits the
   *  feature rather than failing. */
  capabilities?: {
    /** Args appended when YOLO mode is on. Empty/missing → YOLO is a no-op. */
    yolo_args?: string[];
    /** Slash-style command sent to a live PTY to enable YOLO mid-session. */
    runtime_yolo_command?: string;
    /** Args appended after the worktree's first spawn (so the CLI resumes
     *  its own per-directory session). Empty/missing → no auto-resume. */
    resume_args?: string[];
  };
}

export interface Settings {
  repos_dir: string;
  welcomed: boolean;
  agents: Agent[];
  /** Global sandbox defaults. Merged with the per-project lists when
   *  a workspace is created with sandbox enabled; pre-filled into the
   *  Edit Sandbox dialog when the user enables the cage from scratch. */
  sandbox_default_rw_paths?: string[];
  sandbox_default_deny_paths?: string[];
  sandbox_default_allowed_hosts?: string[];
}

export interface DiscoveredRepo {
  path: string;
  name: string;
  already_added: boolean;
}

export interface CliInfo {
  name: string;
  found: boolean;
  path: string;
  version: string;
}

export interface ChangeFile {
  path: string;
  status: string;
}

export interface Changes {
  files: ChangeFile[];
  count: number;
}

export interface FileEntry {
  name: string;
  is_dir: boolean;
}

// ───────────────────────────── tab model (frontend only) ─────────────────────────────

export type TabType = "terminal" | "diff" | "edit";

export interface BaseTab {
  id: string;
  type: TabType;
  title: string;
  /** Triggered when the tab requires user attention (BEL, idle, exit). */
  unread?: { reason: "bell" | "idle" | "exit" } | null;
}

export interface TerminalTab extends BaseTab {
  type: "terminal";
  cli: string;
  ptyId?: string;
  /** Wall-clock timestamps used for the idle heuristic. */
  lastInputAt?: number | null;
  lastOutputAt?: number | null;
  /** True for the auto-created default tab when entering a workspace.
   *  Drives the resume-on-spawn decision: default tab resumes the agent's
   *  prior conversation (if any), user-added tabs always start fresh
   *  (otherwise multi-tab parallelism collapses into "every new tab tries
   *  to resume the same session"). */
  is_default?: boolean;
}

export interface DiffTab extends BaseTab {
  type: "diff";
  path: string;
}

export interface EditTab extends BaseTab {
  type: "edit";
  path: string;
}

export type Tab = TerminalTab | DiffTab | EditTab;
