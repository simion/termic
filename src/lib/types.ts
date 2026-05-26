// Mirrors the Serde structs in src-tauri/src/lib.rs. Keep in sync.

export type CLI = "claude" | "codex" | "agy" | "gemini";

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
  /** Extra POSIX-regex hostname allowlist entries appended to the
   *  per-CLI defaults the proxy enforces. Format mirrors tinyproxy. */
  sandbox_allowed_hosts?: string[];

  /** "single" (default) = one git repo, worktrees branched off it.
   *  "multi" = host repo for shared CLAUDE.md / AGENTS.md / .claude/
   *  + a list of member project ids. Workspaces under a multi project
   *  are worktrees of the host with each member worktree'd or
   *  symlinked inside named subdirs. */
  type?: "single" | "multi";
  /** Multi-repo members with their per-project script overrides.
   *  Each entry pins a member-project id + the scripts to run for
   *  that member when used INSIDE this multi-repo project. Empty
   *  scripts = skip. Only meaningful when `type == "multi"`. */
  members?: ProjectMember[];
}

/** Per-member entry on a multi-repo Project. The scripts are
 *  multi-repo-project-scoped, not member-project-scoped — different
 *  multi-repo projects can wire the same member to different
 *  commands. */
export interface ProjectMember {
  project_id: string;
  setup_script: string;
  run_script: string;
  archive_script: string;
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
  /** Per-member port (frozen at create). Exposed as $TERMIC_PORT
   *  when this member's script runs so siblings don't collide on
   *  the same listening port. 0 = legacy workspace created before
   *  per-member ports existed; falls back to the workspace's own. */
  port?: number;
  /** Per-member script overrides. Frozen at workspace creation from
   *  the member project's own defaults; empty = the member skips
   *  that script. */
  setup_script?: string;
  run_script?: string;
  archive_script?: string;
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
  /** User toggle: hide this agent from the CLI pickers (worktree popover,
   *  New Workspace, Review, the + tab menu). Settings → Agent CLIs still
   *  lists it so it can be re-enabled; existing workspaces bound to it
   *  keep working. Missing = false. */
  disabled?: boolean;
  /** Optional capabilities the app consumes when present. Missing = "not
   *  supported by this CLI" → the corresponding UI gracefully omits the
   *  feature rather than failing. */
  capabilities?: {
    /** Args appended when YOLO mode is on. Empty/missing → YOLO is a no-op. */
    yolo_args?: string[];
    /** Slash-style command sent to a live PTY to switch it INTO YOLO
     *  mid-session. Empty/missing → the YOLO toggle needs a respawn. */
    runtime_yolo_command?: string;
    /** Slash-style command sent to a live PTY to switch it back to the
     *  default approval mode (YOLO off). Empty/missing → respawn. */
    runtime_default_command?: string;
    /** Args appended after the worktree's first spawn (so the CLI resumes
     *  its own per-directory session). Empty/missing → no auto-resume. */
    resume_args?: string[];
  };
  /** Per-agent environment variables merged into the spawn env. Useful
   *  for things like `CLAUDE_CODE_NO_FLICKER=1` without wrapping the CLI
   *  in a shell script. UI parses `KEY=VAL` lines and round-trips them. */
  env?: Record<string, string>;
  /** Paths joined into every sandbox built for a workspace using this
   *  agent. Cannot be removed per-workspace — to drop one, edit the
   *  agent in Settings → Agents (affects every workspace using it).
   *  `$HOME` substitution happens at the Rust side. */
  sandbox_allowed_paths?: string[];
}

export interface Settings {
  repos_dir: string;
  welcomed: boolean;
  agents: Agent[];
  /** Global sandbox defaults. Merged with the per-project lists when
   *  a workspace is created with sandbox enabled; pre-filled into the
   *  Edit Sandbox dialog when the user enables the cage from scratch. */
  sandbox_default_rw_paths?: string[];
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

export interface ChangeGroup {
  name: string;
  branch: string;
  /** "host" | "worktree" | "repo_root" — drives the UI badge + the
   *  click-to-diff gate (repo_root files canonicalize outside the
   *  wrapper, so safe_workspace_path would reject them). */
  kind: "host" | "worktree" | "repo_root";
  path: string;
  files: ChangeFile[];
}

export interface Changes {
  files: ChangeFile[];
  count: number;
  /** Per-repo groupings. Single-repo workspaces have one entry. */
  groups?: ChangeGroup[];
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
  preview?: boolean;
  /** Default static label (cli name / file basename / "shell N").
   *  When `customTitle` is true this is what the user typed; otherwise
   *  it's the auto-derived fallback shown when the agent hasn't set a
   *  live title yet. */
  title: string;
  /** True iff the user manually renamed this tab (double-click flow).
   *  Locks `title` against overrides from PTY-driven `OSC 0/2` title
   *  changes — otherwise the agent's next "Action Required (...)" would
   *  steamroll the user's intent within a few seconds. */
  customTitle?: boolean;
  /** Last `OSC 0/2` title the running program emitted. Rendered in
   *  place of `title` for unrenamed tabs so users see what the agent
   *  is doing ("Action Required", "Ready", "thinking...") without
   *  parsing stdout. */
  liveTitle?: string;
  /** True when the program explicitly requested attention via
   *  `OSC 1337;RequestAttention=yes|fireworks`. Cleared when the tab
   *  becomes active. Renders as a small dot independent of unread. */
  needsAttention?: boolean;
  /** Triggered when the tab requires user attention (BEL, idle, exit,
   *  agent-emitted "done" or explicit "attention" — agent is blocked
   *  waiting for the user to approve/answer). */
  unread?: { reason: "bell" | "idle" | "exit" | "done" | "attention" } | null;
  /** Only meaningful for `edit` tabs: true when the editor buffer has
   *  unsaved changes. Drives the dirty-dot on the tab and the
   *  close-without-saving confirm. termic never auto-saves — this is
   *  cleared only by an explicit ⌘S. */
  dirty?: boolean;
}

export interface TerminalTab extends BaseTab {
  type: "terminal";
  /** Agent id (claude / gemini / codex / agy / custom) the tab runs —
   *  OR the sentinel `"shell"` for a plain login-shell tab spawned from
   *  the "+" → New terminal menu. */
  cli: string;
  /** Plain shell tabs (`cli: "shell"`) carry an explicit sandbox choice:
   *  `true` → spawn inside the workspace's seatbelt cage, `false` →
   *  uncaged. Agent tabs leave this unset — they always pass through
   *  the workspace sandbox (Rust gates on `sandbox_enabled`). */
  sandboxed?: boolean;
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
  /** iTerm2-style work-progress state. Authoritative signals: OSC 9;4
   *  (Claude progress), OSC 133;C/D (FinalTerm semantic prompts), OSC 0
   *  title classifier (gemini/codex). `working` → spinner; `done` →
   *  blue bullet; cleared on next user keystroke (NOT on tab view). */
  workState?: "idle" | "working" | "done";
  /** Optional 0..100 progress percentage from ConEmu OSC 9;4;1|2|4;<pct>.
   *  Null/undefined means "indeterminate" — render the spinner without
   *  a bar. Drives the slim progress strip on the tab pill. */
  workProgress?: number | null;
  /** ConEmu OSC 9;4 state kind. 1=normal 2=error 3=indeterminate 4=warning.
   *  Used to tint the progress bar (red for error, yellow for warning). */
  workProgressKind?: 1 | 2 | 3 | 4 | null;
}

export interface DiffTab extends BaseTab {
  type: "diff";
  path: string;
}

export interface EditTab extends BaseTab {
  type: "edit";
  path: string;
  /** Optional 1-based line + column to scroll to and select on (re)mount.
   *  Set when opening a tab via Find-in-Files; the EditorPane consumes it
   *  and clears it via `consumeReveal` so subsequent re-renders don't
   *  re-jump the cursor every time. */
  revealAt?: { line: number; col?: number };
}

export type Tab = TerminalTab | DiffTab | EditTab;

/** Mirror of `repo_config::RepoConfig` (src-tauri/src/repo_config.rs).
 *  Parsed from the repo-root `.termic.yaml` — committed, team-shared
 *  behavior config (scripts, preview, sandbox allow-lists), also read
 *  by the standalone `termic` CLI. */
export interface RepoConfig {
  version: number;
  scripts: { setup: string; run: string; archive: string; preview_url: string; files_to_copy: string[] };
  sandbox: {
    enabled_by_default: boolean;
    allowed_hosts: string[];
    allowed_paths: string[];
  };
}
