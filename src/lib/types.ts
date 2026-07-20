// Mirrors the Serde structs in src-tauri/src/lib.rs. Keep in sync.

export type CLI = "claude" | "codex" | "agy" | "grok" | "opencode";

/** Sandbox enforcement level. Mirrors Rust's `SandboxMode` (serialized
 *  lowercase, except `enforce-fs` which is kebab). `off` = no cage;
 *  `monitor` = allow everything but log every file/network access;
 *  `enforce` = the real seatbelt cage (filesystem + network);
 *  `enforce-fs` = the filesystem cage only, network fully unrestricted
 *  (no proxy). */
export type SandboxMode = "off" | "monitor" | "enforce" | "enforce-fs";

/** Resolve a task's effective sandbox mode, bridging the legacy
 *  `sandbox_enabled` bool for records written before monitoring shipped.
 *  `sandbox_mode` wins when present. */
export function effectiveSandboxMode(
  task: { sandbox_mode?: SandboxMode; sandbox_enabled?: boolean } | null | undefined,
): SandboxMode {
  if (!task) return "off";
  if (task.sandbox_mode) return task.sandbox_mode;
  return task.sandbox_enabled ? "enforce" : "off";
}

/** True when the seatbelt FILESYSTEM cage is active (deny-by-default reads
 *  outside the allow-list). Covers both `enforce` and `enforce-fs` — they
 *  share the exact FS profile, so anything keyed off "the cage is the real
 *  boundary" (YOLO auto-on, drag-drop staging, etc.) must treat them alike.
 *  `enforce-fs` only differs in that the NETWORK sandbox is off. */
export function isSandboxEnforced(mode: SandboxMode): boolean {
  return mode === "enforce" || mode === "enforce-fs";
}

export interface Project {
  id: string;
  name: string;
  root_path: string;
  tasks_path: string;
  base_branch: string;
  remote: string;
  preview_url: string;
  files_to_copy: string[];
  setup_script: string;
  run_script: string;
  archive_script: string;
  default_cli: string;
  created: string;
  /** When true, the "New task" dialog pre-checks its sandbox toggle.
   *  Existing tasks aren't re-evaluated - their sandbox pin is
   *  captured at creation and immutable thereafter. */
  default_sandbox?: boolean;
  /** Default sandbox MODE for new tasks (off / monitor / enforce).
   *  Additive over `default_sandbox`; when undefined the dialog derives
   *  the default from `default_sandbox` (true → enforce). */
  default_sandbox_mode?: SandboxMode;
  /** Extra writable subpaths added to the seatbelt profile, on top of
   *  the task path + agent config dirs + TMPDIR baked into the
   *  default. `$HOME` and `$WORKSPACE` are substituted at render time. */
  sandbox_rw_paths?: string[];
  /** Extra POSIX-regex hostname allowlist entries appended to the
   *  per-CLI defaults the proxy enforces. Format mirrors tinyproxy. */
  sandbox_allowed_hosts?: string[];

  /** Whether Spotlight is enabled for this project. Disabled by default.
   *  All spotlight UI + commands are gated on this flag. */
  spotlight_enabled?: boolean;

  /** "single" (default) = one git repo, worktrees branched off it.
   *  "multi" = host repo for shared CLAUDE.md / AGENTS.md / .claude/
   *  + a list of member project ids. Tasks under a multi project
   *  are worktrees of the host with each member worktree'd or
   *  symlinked inside named subdirs. */
  type?: "single" | "multi";
  /** True when `root_path` is NOT a git repo — a plain folder that may
   *  group several independent repos (issue #4). Such a project only
   *  spawns repo-root tasks (agent runs at the folder; no worktree,
   *  branch, or diff). For `type === "multi"` it means the HOST is a
   *  plain folder. Missing/false = normal git-backed project. */
  non_git?: boolean;
  /** Multi-repo members with their per-project script overrides.
   *  Each entry pins a member-project id + the scripts to run for
   *  that member when used INSIDE this multi-repo project. Empty
   *  scripts = skip. Only meaningful when `type == "multi"`. */
  members?: ProjectMember[];
  /** UI-only sidebar group label. Projects sharing the same non-empty
   *  value render under one collapsible folder header in the project
   *  list. No effect on paths, git, or workspaces. Missing/empty =
   *  ungrouped. */
  group?: string;
}

/** Per-member entry on a multi-repo Project. Self-contained: a member is
 *  defined by its own `root_path`, not a reference to a registered Project,
 *  so adding one never leaves a standalone project in the sidebar. The
 *  scripts are multi-repo-project-scoped — different multi-repo projects
 *  can wire the same repo to different commands. `root_path` is the
 *  member's identity within a project (unique). */
export interface ProjectMember {
  root_path: string;
  name: string;
  non_git?: boolean;
  base_branch?: string;
  setup_script: string;
  run_script: string;
  archive_script: string;
  /** Sandbox lists unioned into the task sandbox at create. Only
   *  populated when a member is seeded from an existing project; not
   *  edited in the member dialogs. */
  sandbox_rw_paths?: string[];
  sandbox_allowed_hosts?: string[];
}

export type MemberMode = "worktree" | "repo_root";

/** One entry in a multi-repo task's composition. Frozen at
 *  task creation; the wrapper dir IS the host's worktree and
 *  member entries live at `<wrapper>/<dir_name>`. */
export interface TaskMember {
  /** Legacy reference (tasks created before members went inline).
   *  New records use `repo_path`. */
  project_id?: string;
  /** Source repo path, frozen at create (archive removes the worktree
   *  against it). Empty on legacy records. */
  repo_path?: string;
  dir_name: string;
  mode: MemberMode;
  branch: string;
  path: string;
  /** Per-member port (frozen at create). Exposed as $TERMIC_PORT
   *  when this member's script runs so siblings don't collide on
   *  the same listening port. 0 = legacy task created before
   *  per-member ports existed; falls back to the task's own. */
  port?: number;
  /** Per-member script overrides. Frozen at task creation from
   *  the member project's own defaults; empty = the member skips
   *  that script. */
  setup_script?: string;
  run_script?: string;
  archive_script?: string;
}

export interface Task {
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
  archived_at?: string;
  /** True when this task points at the project's main repo checkout
   *  (no git worktree). The UI shows a distinct icon and archive only
   *  removes the entry — the repo on disk is untouched. */
  is_main_checkout?: boolean;
  /** Total agent spawns ever recorded for this worktree. Historical
   *  metric only — resume gating uses `has_resumable_history` now. */
  spawn_count?: number;
  /** Persisted: true iff a spawn has survived past the rapid-exit
   *  failure window (~2s). Drives the `--continue`/`--resume` gate so
   *  worktrees with no real conversation don't waste spawns on a
   *  doomed resume attempt. Flipped false on a confirmed failure. */
  has_resumable_history?: boolean;
  /** Per-CLI session UUIDs we own. Lazily minted on first spawn for an
   *  id-capable CLI (e.g. claude). Reused on every subsequent spawn via
   *  `resume_id_args`. Keyed by agent id.
   *  Survives across termic restarts; lets us auto-resume in repo-root
   *  tasks too without cross-pollinating with the user's external
   *  sessions in the same cwd. */
  agent_session_ids?: Record<string, string>;
  /** PINNED at creation. Driven by NewTaskDialog (defaulting to
   *  the project's `default_sandbox`). There is no setter - to flip
   *  it, archive the task and recreate. The UI shows a lock
   *  badge on sandboxed rows. */
  sandbox_enabled?: boolean;
  /** Sandbox enforcement mode (off / monitor / enforce). Additive third
   *  state over `sandbox_enabled`; when undefined (records written before
   *  monitoring shipped) derive via `effectiveSandboxMode`. Unlike the
   *  original immutability promise, the mode IS editable post-create via
   *  the Sandbox dialog (a forced PTY restart applies it). */
  sandbox_mode?: SandboxMode;
  /** Per-task YOLO (auto-approve) flag, applied to every agent
   *  launched here. Only meaningful when NOT enforce-sandboxed (Enforcing
   *  auto-enables YOLO since the cage is the boundary). Replaces the old
   *  global toggle. */
  yolo?: boolean;
  /** Frozen-at-creation copies of the sandbox lists. The dialog seeds
   *  these from the project's defaults, the user adds/removes before
   *  Create, and from then on the task owns them. Editing the
   *  project's defaults later WILL NOT reach back into existing
   *  tasks - matches the immutability promise of sandbox_enabled. */
  sandbox_rw_paths?: string[];
  sandbox_allowed_hosts?: string[];
  /** Multi-repo composition. Empty for single-repo tasks. */
  composition?: TaskMember[];
  /** Pre-set launch command for `cli === "custom"` repo-root tasks.
   *  The default tab runs this through a login shell instead of an agent
   *  binary (e.g. `ssh box`, `npm run dev`). Null/undefined for every
   *  agent / shell task. */
  custom_command?: string | null;
  /** Per-task override for the agent's resume arguments. When set
   *  (non-empty), the spawn uses this verbatim (placeholders like
   *  `{WORKSPACE_NAME}` / `{WORKSPACE_SLUG}` expanded) as the resume block
   *  instead of termic's id-based (`--resume <uuid>`) or cwd-based
   *  (`--continue`) logic. Lets a repo-root task resume a named
   *  session, e.g. `--resume {WORKSPACE_NAME}`. Null/empty = default. */
  resume_override?: string | null;
  /** Durable agent tabs for this task, in display order. Rewritten by
   *  `taskSetTabs` on every tab add / close / reorder / rename, and
   *  read on app launch to restore the full agent-tab set (not just the
   *  primary). Each id-capable tab carries its own `session_id` so several
   *  agents in one task resume independently. Shell / scratch tabs are
   *  never listed here — they have no session to resume. Closing a tab with
   *  its X drops it from this list (forget); quitting the app leaves it
   *  intact (restore). */
  persisted_tabs?: PersistedTab[];
  /** JSON-encoded SplitTree for the active tab's pane layout. Restored on relaunch. */
  split_layout?: string | null;
}

/** One durable agent tab persisted on a task. Mirror of
 *  `PersistedTab` in src-tauri/src/lib.rs. */
export interface PersistedTab {
  id: string;
  cli: string;
  title?: string | null;
  custom_title?: boolean;
  is_default?: boolean;
  /** Launch command for `cli === "custom"` tabs (re-run on restore). */
  command?: string | null;
  /** termic-owned per-tab session uuid for id-capable agents
   *  (claude / gemini). Null for cwd-resume agents (codex) and tabs that
   *  have not minted a session yet. Owned by `taskSetTabSessionId`. */
  session_id?: string | null;
  /** The uuid a `--resume` attempt just fast-exited on, stashed here
   *  (instead of discarded) so it can be one-click recovered. Owned by
   *  `taskSetTabPreviousSessionId`. */
  previous_session_id?: string | null;
  /** Leaf ID of the split pane this tab belongs to (absent for main panel tabs). */
  pane_leaf_id?: string | null;
  /** Run pop-out tab marker (GH #54): the member dir ("" = host project)
   *  when this tab hosts the run script. Restores as a RunPane. */
  run_member?: string | null;
}

/** Per-member input for `task_create_multi`. `root_path` matches a
 *  member entry on the multi-repo project. */
export interface CreateMultiMember {
  root_path: string;
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
  sandbox_mode?: SandboxMode;
  sandbox_rw_paths?: string[];
  sandbox_allowed_hosts?: string[];
}

export interface CreateTaskArgs {
  project_id: string;
  name: string;
  cli?: string;
  base_branch?: string | null;
  branch?: string | null;
  /** Pre-generated task UUID. Pass this if you want to subscribe to
   *  `setup-output://<id>` / `setup-done://<id>` events BEFORE invoking — the
   *  alternative (using server-generated ID returned from the call) has a
   *  guaranteed race for empty setup scripts. */
  id?: string;
  /** Sandbox pin captured at creation. When undefined the Rust side
   *  falls back to the project's `default_sandbox`. The pin is
   *  permanent - flip via archive + recreate, never via mutation. */
  sandbox_enabled?: boolean;
  /** Sandbox mode pin (off / monitor / enforce). Additive over
   *  `sandbox_enabled`; when present it wins. */
  sandbox_mode?: SandboxMode;
  /** Per-task sandbox lists. The dialog seeds from the project's
   *  defaults, the user edits, the final shape lands here. Unset =
   *  Rust falls back to the project's defaults verbatim. */
  sandbox_rw_paths?: string[];
  sandbox_allowed_hosts?: string[];
  /** Pre-set launch command for a `cli === "custom"` worktree task (quick
   *  "Custom command" in worktree mode). The default tab runs this through a
   *  login shell instead of an agent binary. Null/undefined for agent/shell. */
  custom_command?: string | null;
}

export interface Agent {
  /** Stable key referenced by Task.cli. */
  id: string;
  display_name: string;
  /** Binary or shell command to spawn. Independent of `id` so renames don't
   *  invalidate existing tasks. */
  command: string;
  args: string[];
  /** Icon identifier. Either a brand id ("claude", "codex", "opencode", …) or
   *  a generic key prefixed with "lucide:" (e.g. "lucide:terminal"). */
  icon_id: string;
  /** Hex color string for the icon tint. */
  color: string;
  /** Built-in (the original 3) — user can edit fields but not remove. */
  builtin: boolean;
  /** User toggle: hide this agent from the CLI pickers (worktree popover,
   *  New Task, Review, the + tab menu). Settings → Agent CLIs still
   *  lists it so it can be re-enabled; existing tasks bound to it
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
    /** Args used on the FIRST spawn of an id-capable CLI to mint a
     *  termic-owned session. Must contain `{UUID}`, which expands to a
     *  freshly-minted uuid that's then persisted on the task.
     *  Empty/missing → CLI doesn't support deterministic sessions →
     *  fall back to legacy `resume_args` behavior. */
    session_id_args?: string[];
    /** Args used on every subsequent spawn of an id-capable CLI to
     *  resume the termic-owned session. Must contain `{UUID}`, which
     *  expands to the previously-minted uuid. */
    resume_id_args?: string[];
    /** Always-applied args (every spawn). Useful for things like
     *  `--name {WORKSPACE_SLUG}` so claude's /resume picker shows
     *  termic's task name. */
    name_args?: string[];
    /** Custom work-done signal patterns (regex sources) tested against the
     *  agent's OSC 0/2 title, in precedence attention > busy > idle. When any
     *  list is non-empty it drives classification for this agent; empty falls
     *  back to the built-in claude/codex heuristics. Lets a custom CLI teach
     *  termic what its own "done" / "working" / "needs you" title looks like. */
    signals?: {
      busy?: string[];
      idle?: string[];
      attention?: string[];
    };
    /** Tier 3: also scan stdout LINES against `signals`, not just the title.
     *  Off by default (the title path is cheaper and safer). Turn on for CLIs
     *  that print status to stdout and never set a title. */
    match_output?: boolean;
  };
  /** Per-agent environment variables merged into the spawn env. Useful
   *  for things like `CLAUDE_CODE_NO_FLICKER=1` without wrapping the CLI
   *  in a shell script. UI parses `KEY=VAL` lines and round-trips them. */
  env?: Record<string, string>;
  /** Paths joined into every sandbox built for a task using this
   *  agent. Cannot be removed per-task — to drop one, edit the
   *  agent in Settings → Agents (affects every task using it).
   *  `$HOME` substitution happens at the Rust side. */
  sandbox_allowed_paths?: string[];
  /** Per-agent allowed hosts (network counterpart to the paths above).
   *  "Allow · per agent" appends here so every task using this CLI
   *  inherits the host. */
  sandbox_allowed_hosts?: string[];
  /** Whether work-done detection is active for this agent. Defaults to
   *  true. Flip to false for custom CLIs that emit signals in ways that
   *  cause false positives — disables the entire state machine (no badge,
   *  no bell, no OS notification) for terminals running this agent. */
  work_done?: boolean;
  /** ID of the agent this one was cloned from. Purely informational,
   *  surfaced as "extends: <name>" in the Settings card header. */
  extends?: string;
  /** One-shot session-ID capture after the agent's first user interaction.
   *  For CLIs that create sessions lazily (e.g. opencode): on the first
   *  Enter keypress with no stored session ID, termic waits `delay_ms`,
   *  runs `command` in the task CWD on first PTY exit, and stores
   *  stdout as the tab's resume session ID for subsequent spawns. */
  post_launch_capture?: { command: string };
  /** "agent" (default) or "terminal". Terminal entries live in the same
   *  registry (env, sandbox lists, enable toggle all apply) but spawn with
   *  shell semantics: command + args joined into one line and run through
   *  the user's login shell. No agent machinery: no resume, no work-done
   *  detection, no message queue, broadcast default-unchecked. They appear
   *  under "New terminal" in the + tab menu instead of "New agent" (#27).
   *  Missing = "agent". */
  kind?: "agent" | "terminal";
}

export interface Settings {
  repos_dir: string;
  welcomed: boolean;
  agents: Agent[];
  /** Global sandbox defaults. Merged with the per-project lists when
   *  a task is created with sandbox enabled; pre-filled into the
   *  Edit Sandbox dialog when the user enables the cage from scratch. */
  sandbox_default_rw_paths?: string[];
  sandbox_default_allowed_hosts?: string[];
  /** Personal (this-machine) glob patterns hidden from the "All files"
   *  tree across every project. Unioned with each project's committed
   *  `.termic.yaml` `exclude`. `.git` is always hidden regardless. */
  file_tree_exclude?: string[];
  /** When on (the default), a best-effort `git fetch` of the base ref runs
   *  before a new task's branch is cut, so it starts from the latest remote
   *  commit instead of a stale local `origin/*` (GH #79). Absent = on; set
   *  false to opt out. The fetch is always time-bounded and non-fatal. */
  fetch_before_create?: boolean;
  /** Canonical repo paths hidden from the Add Project discovery list.
   *  Discovery still finds them; the picker filters them out until restored. */
  discovery_dismissed?: string[];
  /** Repo-root config dirs symlinked into each new worktree task (agent config
   *  like `.claude/` that is commonly gitignored, so a plain worktree checkout
   *  omits it). Pre-filled with the common agent dirs; an empty list disables
   *  the linking. Absent = the pre-filled defaults, not off. */
  worktree_symlink_paths?: string[];
}

export interface DiscoveredRepo {
  path: string;
  name: string;
  already_added: boolean;
  /** User hid this repo from discovery. Still returned so the picker can
   *  offer a restore; hidden from the main list by default. */
  dismissed: boolean;
}

/** A git worktree of a project's repo that isn't yet tracked as a
 *  termic task — offered for import (issue #5). */
export interface ImportableWorktree {
  path: string;
  /** Short branch name, or "" for a detached HEAD. */
  branch: string;
  /** Abbreviated HEAD commit, display only. */
  head: string;
  locked: boolean;
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
   *  wrapper, so safe_task_path would reject them). */
  kind: "host" | "worktree" | "repo_root";
  path: string;
  files: ChangeFile[];
}

export interface Changes {
  files: ChangeFile[];
  count: number;
  /** Per-repo groupings. Single-repo tasks have one entry. */
  groups?: ChangeGroup[];
}

// ── Fork-style staging (task_git_status) ──
// Unlike ChangeFile, these keep the index column and worktree column
// separate so the UI can render Staged vs Unstaged panes. Paths are
// relative to their own repo (the frontend re-prefixes member paths with
// `dir_name` only when opening a diff).
export interface GitFile {
  /** Single-char status for this side: M/A/D/R/C (staged), M/D
   *  (unstaged), or "?" (untracked). */
  status: string;
  path: string;
  /** Cheap working-tree fingerprint (`mtime_nanos:len`), empty for a
   *  deletion. Used to auto-clear a file's "viewed" mark once the agent
   *  touches it again. See store/fileViewed.ts. */
  fp: string;
}

export interface GitRepo {
  name: string;
  branch: string;
  kind: "host" | "worktree" | "repo_root";
  /** "" for the host repo, the member's dir_name otherwise. */
  dir_name: string;
  staged: GitFile[];
  unstaged: GitFile[];
  /** Unique changed-path count across both lists. */
  changed: number;
  /** `git log -1 --pretty=%B`, for Amend prefill. */
  last_commit_message: string;
  /** True when the file lists were capped at 5 000 entries. */
  truncated?: boolean;
}

export interface GitStatus {
  repos: GitRepo[];
  total_changed: number;
  repos_changed: number;
}

/** Result of a Git-tab branch switch. `stashed` = local work was parked and
 *  re-applied; `conflicted` = the re-apply hit conflicts (markers left in the
 *  tree, stash retained). */
export interface CheckoutResult {
  branch: string;
  stashed: boolean;
  conflicted: boolean;
}

/** How a Git-tab update brings the branch up to date. `pull` takes the
 *  branch's own upstream; `merge` / `rebase` take the task's base branch. */
export type UpdateMode = "pull" | "merge" | "rebase";

/** Result of a Git-tab update. `target` is what we updated FROM (the upstream
 *  for `pull`, the base branch otherwise). `stashed` = local work was
 *  auto-stashed; git re-applies it when the op concludes, so on `conflicted`
 *  it is still pending until the user finishes the merge or rebase. */
export interface UpdateResult {
  branch: string;
  target: string;
  stashed: boolean;
  /** The merge / rebase itself stopped on conflicts and is left in progress. */
  conflicted: boolean;
  /** The update landed, but re-applying the auto-stashed local changes hit
   *  conflicts. The stash is RETAINED - never report this as "restored". */
  stash_conflicted: boolean;
  up_to_date: boolean;
}

/** What the update menu can offer. `upstream` is empty until the branch has
 *  been pushed (task branches are cut with --no-track). `base` is empty when
 *  unresolvable, and equals `branch` for repo-root / adopted tasks whose
 *  original base ref isn't known - both mean "no merge or rebase to offer". */
export interface UpdateInfo {
  branch: string;
  upstream: string;
  base: string;
}

export interface FileEntry {
  name: string;
  is_dir: boolean;
}

// ───────────────────────── split-pane tree (frontend only) ──────────────────────────
// Re-exported from splitTree.ts so consumers only need one import.
export type { SplitDir, SplitNode, PaneLeaf, SplitTree } from "@/lib/splitTree";

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
  /** When set, this tab lives inside a split pane (leaf node id). Absent =
   *  main pane tab (shown in the task tab bar). Split-pane tabs are
   *  ephemeral — they are not persisted across launches. */
  paneId?: string;
}

export interface TerminalTab extends BaseTab {
  type: "terminal";
  /** Agent id (claude / gemini / codex / agy) the tab runs, OR the
   *  sentinel `"shell"` for a plain login-shell tab, OR `"custom"` for a
   *  task launched with a user-supplied command (see `command`). */
  cli: string;
  /** Launch command for `cli === "custom"` tabs — run through a login
   *  shell (`zsh -lc`). Seeded from the task's `custom_command`
   *  when the default tab is created. Unset for agent / shell tabs. */
  command?: string;
  /** Set on Run pop-out tabs (GH #54): the tab hosts the project/member run
   *  (or setup) script with pill controls (play / restart / stop). `member`
   *  is the composition dir name ("" = host project); `previewUrl` resolved
   *  at launch. kind "setup" tabs are one-shot and never persisted; "run"
   *  (default) tabs persist with their pane position. */
  runTab?: {
    member: string;
    kind?: "run" | "setup";
    previewUrl?: string | null;
    /** Restored-from-persistence marker: the tab comes back in its pane but
     *  does NOT auto-run the script — the user hits play. */
    idle?: boolean;
    /** Set when the script last exited non-zero (a manual Stop, code null,
     *  is NOT a failure). Cleared on restart. Drives the tab pill's red
     *  failed indicator. */
    failed?: boolean;
  };
  ptyId?: string;
  /** Wall-clock timestamps used for the idle heuristic. */
  lastInputAt?: number | null;
  lastOutputAt?: number | null;
  /** True for the auto-created default tab when entering a task.
   *  Drives the resume-on-spawn decision: default tab resumes the agent's
   *  prior conversation (if any), user-added tabs always start fresh
   *  (otherwise multi-tab parallelism collapses into "every new tab tries
   *  to resume the same session"). */
  is_default?: boolean;
  /** termic-owned session uuid for THIS tab (id-capable agents only:
   *  claude / gemini). Restored from the task's `persisted_tabs` on
   *  launch and minted on first spawn otherwise. Distinct per tab so two
   *  agents in one task resume independently — the primary tab is no
   *  longer the only resumable one. Cleared (undefined) when a resume
   *  attempt rapid-exits (the stored session no longer resolves — the old
   *  uuid moves to `previousSessionId` for recovery). */
  sessionId?: string;
  /** The uuid a `--resume` just fast-exited on, stashed instead of thrown
   *  away so the user can one-click recover it (a transient failure would
   *  otherwise lose the conversation permanently). Drives the recover
   *  banner in TerminalPane. Restored from `persisted_tabs` on launch. */
  previousSessionId?: string;
  /** iTerm2-style work-progress state. Authoritative signals: OSC 9;4
   *  (Claude progress), OSC 133;C/D (FinalTerm semantic prompts), OSC 0
   *  title classifier (gemini/codex). `working` → spinner; `done` →
   *  blue bullet; cleared on next user keystroke (NOT on tab view). */
  workState?: "idle" | "working" | "done";
  /** Set while a library prompt (target "new-agent") is waiting for this
   *  freshly spawned agent to come up before its prompt is injected. Drives
   *  the "starting agent" loader overlay in TerminalPane; cleared once the
   *  prompt is sent (or the spawn times out). The string is the prompt title,
   *  shown in the overlay. */
  promptPendingTitle?: string | null;
  /** True when this tab was created to receive an injected prompt with no
   *  human at the keyboard (run-prompt "new agent" today; agent races later).
   *  Spawns compose the CLI's unattended args (lib/agents UNATTENDED_SPAWN_ARGS)
   *  so a startup update menu can't swallow the injected prompt. Attended
   *  tabs keep the CLI's normal startup behavior. */
  unattended?: boolean;
  /** Optional 0..100 progress percentage from ConEmu OSC 9;4;1|2|4;<pct>.
   *  Null/undefined means "indeterminate" — render the spinner without
   *  a bar. Drives the slim progress strip on the tab pill. */
  workProgress?: number | null;
  /** ConEmu OSC 9;4 state kind. 1=normal 2=error 3=indeterminate 4=warning.
   *  Used to tint the progress bar (red for error, yellow for warning). */
  workProgressKind?: 1 | 2 | 3 | 4 | null;
  /** Wall-clock when the user last manually cleared workState via
   *  focus (clicking the tab / task). Setting workState to
   *  "working" inside the grace window after this timestamp is
   *  silenced so a stuck spinner the user just dismissed doesn't
   *  instantly re-arm. */
  workClearedAt?: number;
  /** Per-agent message queue (the "ralph loop"). The head item is sent
   *  next; on every work-done the next message is auto-submitted. Only
   *  meaningful for work-done-capable agent tabs. Edited via the message
   *  queue dialog; drained in TerminalPane. */
  queue?: QueueItem[];
  /** Whether the queue is actively draining. Reset on PTY (re)spawn so a
   *  manual Restart doesn't keep firing into a fresh process. */
  queueActive?: boolean;
  /** Bumped each time a message is added. The draining kick in TerminalPane
   *  watches this so adding a message to an idle agent sends immediately even
   *  when `queueActive` is already true (no false→true edge to rely on). */
  queueKick?: number;
  /** Bumped by the "Send now" button to drain the head message immediately,
   *  bypassing the work-done wait (and the queueKick effect's mid-turn guard).
   *  Watched by a dedicated TerminalPane effect that sends regardless of
   *  `workState` AND bypasses the queue send-interval throttle. */
  queueForceKick?: number;
}

/** One entry in a terminal tab's message queue. `repeat` is the total
 *  number of times to send `text` (each send waits for its own work-done);
 *  `remaining` counts down as it drains. A classic ralph loop is a single
 *  item with a high repeat. */
export interface QueueItem {
  id: string;
  text: string;
  repeat: number;
  remaining: number;
}

export interface DiffTab extends BaseTab {
  type: "diff";
  path: string;
  /** Which Git-panel pane the diff was opened from (GH #122):
   *  "staged" diffs HEAD→index, "unstaged" diffs index→worktree.
   *  Absent → HEAD→worktree (the full uncommitted delta). */
  scope?: "unstaged" | "staged";
}

/** The complete delta a task produced vs its base (`task_diff`). `diff` folds
 *  tracked changes plus new untracked files into one unified-diff string. */
export interface TaskDiffSummary {
  commits: string;
  diff: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  untracked: number;
}

export interface EditTab extends BaseTab {
  type: "edit";
  path: string;
  /** Optional 1-based line + column to scroll to and select on (re)mount.
   *  Set when opening a tab via Find-in-Files; the EditorPane consumes it
   *  and clears it via `consumeReveal` so subsequent re-renders don't
   *  re-jump the cursor every time. */
  revealAt?: { line: number; col?: number };
  /** Heading fragment (`file.md#heading` link target) to scroll the markdown
   *  preview to once it renders. Set when a preview link with a fragment
   *  opens another file; MarkdownPane consumes and clears it (like
   *  `revealAt`) so re-renders don't re-jump the scroll. */
  revealHeading?: string;
  /** View mode for markdown files (.md/.markdown/.mdx). "source" is the
   *  raw CodeMirror editor, "preview" the rendered HTML, "split" both
   *  side-by-side. Undefined → "source". Ignored for non-markdown files. */
  mdView?: "source" | "preview" | "split";
  /** Per-tab override: true unblocks remote (http/https) images in this
   *  document's markdown preview for the current session, without
   *  touching the global `loadRemoteImages` pref. Undefined falls back to
   *  the pref (see docs/sandbox.md, "Known gap: the webview is outside
   *  the cage", and MarkdownPreview.tsx). Session-only, like mdView. */
  remoteImagesUnblocked?: boolean;
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
  /** Glob patterns hidden from the "All files" tree (committed, team-shared).
   *  Unioned with the user's personal `Settings.file_tree_exclude`. */
  exclude: string[];
}
