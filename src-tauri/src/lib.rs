// Termic — parallel-agent orchestrator with embedded terminals.
//
// Model:
//   Project   — a git repo on disk. User adds repos by picking their root dir.
//   Task — a git worktree branched from `base_branch`. Each task
//               has its own folder + an embedded terminal running the chosen
//               agent CLI (claude / gemini / codex).
//
// Terminal: PTYs are managed in `PtyManager`. The frontend (xterm.js) and
// backend communicate via Tauri events:
//   FE → BE: pty_spawn(task_id, cli, cwd) -> pty_id
//   FE → BE: pty_write(pty_id, data)
//   FE → BE: pty_resize(pty_id, rows, cols)
//   FE → BE: pty_kill(pty_id)
//   BE → FE: emits "pty://<id>"  with payload = Vec<u8>   (output chunks)
//   BE → FE: emits "pty-exit://<id>" with payload = exit code (i32 or null)

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
extern crate libc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

mod sandbox;
mod proxy;
mod repo_config;
mod shell_env;
mod automation;
use sandbox::SandboxBundle;

// ───────────────────────────── data model ─────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Filesystem path to the project's git repo. For
    /// `ProjectType::Single` this is the only repo in play. For
    /// `ProjectType::Multi` it's the HOST repo — the one that owns
    /// the shared CLAUDE.md / AGENTS.md / .claude/ and acts as the
    /// task wrapper when a multi-repo task is created.
    pub root_path: String,
    /// Root dir under which this project's worktree tasks are created
    /// (`<worktrees_base>/<slug>`). `alias = "workspaces_path"` reads
    /// projects.json written before the workspace->task rename; without it
    /// the field loads empty and new worktrees get a relative path.
    #[serde(alias = "workspaces_path")]
    pub tasks_path: String,
    pub base_branch: String,
    pub remote: String,
    pub preview_url: String,
    pub files_to_copy: Vec<String>,
    pub setup_script: String,
    pub run_script: String,
    pub archive_script: String,
    pub default_cli: String,
    pub created: String,

    // ── Sandbox config (configured per project, enabled per task) ──
    /// Whether new tasks in this project default to sandboxed. The
    /// "New task" dialog pre-checks its sandbox toggle when true.
    /// The per-task pin is captured at create time; flipping this
    /// later only affects FUTURE tasks.
    #[serde(default)]
    pub default_sandbox: bool,
    /// Default sandbox MODE for new tasks (additive over
    /// `default_sandbox`). When `None`, falls back to
    /// `default_sandbox` (true → Enforce). Lets a project default new
    /// tasks to Monitoring.
    #[serde(default)]
    pub default_sandbox_mode: Option<SandboxMode>,
    /// Extra writable subpaths beyond the bake-in defaults (task
    /// path, agent config dirs, /private/tmp). Absolute paths; `$HOME`
    /// and `$WORKSPACE` are substituted at render time. List, not a
    /// single string — keeps the SBPL output one rule per line.
    #[serde(default)]
    pub sandbox_rw_paths: Vec<String>,
    /// Extra allowed-host regexes for the per-task network proxy,
    /// beyond the per-CLI defaults. One POSIX/Rust regex per line,
    /// matched against the request hostname.
    #[serde(default)]
    pub sandbox_allowed_hosts: Vec<String>,

    /// Project type. Defaults to Single for back-compat with all the
    /// `projects.json` rows written before multi-repo shipped.
    #[serde(default, rename = "type")]
    pub project_type: ProjectType,
    /// Multi-repo members. Each entry pins a reference to another
    /// Project + the scripts to run for that member when used in
    /// THIS multi-repo project. Scripts default-empty; when empty
    /// they're treated as "skip". The member project's OWN scripts
    /// (settable in its own Repository settings) are inherited as
    /// the editor's placeholder, not the runtime value — multi-repo
    /// projects opt into different commands than the standalone use
    /// of the same repo. Empty / ignored when `project_type == Single`.
    #[serde(default, deserialize_with = "deserialize_members")]
    pub members: Vec<ProjectMember>,

    /// Whether Spotlight is enabled for this project. Disabled by default —
    /// all spotlight code paths are gated on this flag so the feature is
    /// an explicit opt-in and won't affect existing projects.
    #[serde(default)]
    pub spotlight_enabled: bool,

    /// True when `root_path` is NOT a git repo — e.g. a parent folder
    /// that contains several independent git repos (issue #4). Such a
    /// project can only spawn repo-root tasks (the agent runs at
    /// the folder, no worktree / branch / diff). Defaults false so every
    /// existing project + the `Default` impl stay git-backed.
    #[serde(default)]
    pub non_git: bool,

    /// UI-only sidebar group label. Projects sharing the same non-empty
    /// value render under one collapsible folder header in the project
    /// list. Purely presentational — no effect on paths, git, or
    /// workspaces. `None` / empty = ungrouped (renders at the top level).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProjectMember {
    /// Canonical path to the member repo (or plain folder). This is the
    /// member's identity within a multi-repo project — unique per project.
    /// Members are self-contained: they no longer reference a registered
    /// Project, so adding one never spawns a standalone sidebar project.
    pub root_path: String,
    /// Display name + default dir name inside the task wrapper.
    pub name: String,
    /// True when `root_path` is a plain folder (no git). Such a member
    /// can only mount repo-root (a live symlink) — no worktree / branch.
    pub non_git: bool,
    /// Base ref worktree members branch from. Empty = the repo's default.
    pub base_branch: String,
    pub setup_script: String,
    pub run_script: String,
    pub archive_script: String,
    /// Sandbox lists unioned into the task's frozen sandbox at create.
    #[serde(default)]
    pub sandbox_rw_paths: Vec<String>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Vec<String>,
    /// LEGACY: pre-inline members referenced a Project by id. Retained so
    /// projects.json written before this change still loads; migrated to
    /// the inline fields above on first load (see migrate_legacy_members),
    /// then dropped from disk on the next save.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub project_id: String,
}

// Backwards-compatible deserializer: accepts both the legacy
// Vec<String> shape (member ids only) and the new Vec<ProjectMember>
// shape, so projects.json written before scripts shipped still loads.
fn deserialize_members<'de, D>(d: D) -> Result<Vec<ProjectMember>, D::Error>
where D: serde::Deserializer<'de> {
    use serde::de::{Visitor, SeqAccess};
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Vec<ProjectMember>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("array of member ids or ProjectMember objects")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            #[derive(Deserialize)]
            #[serde(untagged)]
            enum Item { Id(String), Full(ProjectMember) }
            let mut out = Vec::new();
            while let Some(item) = seq.next_element::<Item>()? {
                out.push(match item {
                    Item::Id(id)  => ProjectMember { project_id: id, ..Default::default() },
                    Item::Full(m) => m,
                });
            }
            Ok(out)
        }
    }
    d.deserialize_seq(V)
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectType {
    #[default]
    Single,
    Multi,
}

/// Sandbox enforcement level for a task's agent PTY. The third
/// value (`Monitor`) is additive — `Off` and `Enforce` keep their exact
/// prior behavior; legacy records that only have the `sandbox_enabled`
/// bool map to `Off`/`Enforce` via `Task::effective_sandbox_mode`.
///   Off       — no cage (full filesystem + network).
///   Monitor   — allow everything but LOG every file op + network request.
///   Enforce   — the real cage (seatbelt deny-by-default + host allowlist).
///   EnforceFs — the filesystem cage WITHOUT the network cage: same
///               seatbelt deny-by-default file allow-list as `Enforce`,
///               but network is fully unrestricted and NO proxy runs.
///               For users who want write/read isolation but unfettered
///               outbound (their own egress controls, VPN, non-HTTP
///               traffic, etc.). `Enforce` is intentionally left untouched.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SandboxMode {
    #[default]
    Off,
    Monitor,
    Enforce,
    /// Serialized as "enforce-fs" (kebab) so the JSON value reads as a
    /// distinct mode rather than a run-together "enforcefs".
    #[serde(rename = "enforce-fs")]
    EnforceFs,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub name: String,        // user-facing label, e.g. "Montreal"
    pub branch: String,      // e.g. "montreal"
    pub base_branch: String, // e.g. "master"
    pub path: String,        // worktree absolute path
    pub cli: String,         // claude / gemini / codex
    pub port: u16,
    pub created: String,
    pub archived: bool,
    /// RFC3339 timestamp written the moment `task_archive` marks this
    /// task archived. Used by the History view to order most-recently-
    /// archived first. `None` on tasks archived before this field existed.
    #[serde(default)]
    pub archived_at: Option<String>,
    /// True when this task points at the project's main repo checkout
    /// (no git worktree created). Used by the "open repo directly" feature:
    /// archive skips `git worktree remove`, and the UI shows a distinct icon.
    /// `alias = "is_repo_root"` reads pre-Task-rename metadata files (the
    /// field was `is_repo_root` before the workspace->task rename). The
    /// Phase 0 migration rewrites survivors to the new name; this alias
    /// backstops anything the migration missed.
    #[serde(default, alias = "is_repo_root")]
    pub is_main_checkout: bool,
    /// Total number of times an agent has been spawned for this task
    /// across all sessions (persisted via `task_record_spawn`).
    /// Historical signal — kept for analytics / debug. Resume gating
    /// uses `has_resumable_history` below, not this.
    #[serde(default)]
    pub spawn_count: u32,
    /// True iff at least one agent spawn for this worktree has survived
    /// past the "settle" threshold (~2s) — i.e. there's plausibly a
    /// resumable session on disk. Persisted, drives the resume-flag
    /// gating on subsequent spawns.
    ///
    /// Flipped TRUE by `task_set_has_history(id, true)` once a spawn
    /// has been running long enough that it's almost certainly past
    /// any "no conversation found to continue" rapid-exit failure.
    /// Flipped FALSE when a resume-attempt spawn exits within the
    /// failure threshold (we now KNOW there's no usable history) so
    /// the next spawn doesn't waste a roundtrip retrying.
    #[serde(default)]
    pub has_resumable_history: bool,
    /// Per-CLI session UUIDs we own. Lazily minted on first spawn for
    /// an id-capable CLI (e.g. claude). Reused on every subsequent
    /// spawn via the agent's `resume_id_args`. Keyed by agent id.
    /// Survives termic restarts; lets
    /// repo-root tasks auto-resume without cross-pollinating with
    /// the user's external sessions in the same cwd.
    #[serde(default)]
    pub agent_session_ids: std::collections::HashMap<String, String>,
    /// PINNED at task creation. The sandbox decision can't change
    /// afterwards — otherwise an agent could talk the user into
    /// loosening its own cage. To run the same project unsandboxed,
    /// archive and recreate with the toggle off (or vice versa).
    #[serde(default)]
    pub sandbox_enabled: bool,
    /// Sandbox enforcement level. Additive third state on top of the
    /// legacy `sandbox_enabled` bool. `None` on records written before
    /// monitoring shipped — `effective_sandbox_mode()` derives the mode
    /// from `sandbox_enabled` in that case. Written on every create /
    /// edit going forward; `sandbox_enabled` is kept in sync (= mode !=
    /// Off) so all the existing "is there a cage" checks still work.
    #[serde(default)]
    pub sandbox_mode: Option<SandboxMode>,
    /// Per-task YOLO (auto-approve / bypass-permissions) flag.
    /// Applied to EVERY agent launched in this task. Only meaningful
    /// when the task is NOT enforce-sandboxed — under Enforcing the
    /// seatbelt is the boundary and YOLO is auto-on regardless. Replaces
    /// the old global YOLO toggle so the choice is saved per task.
    #[serde(default)]
    pub yolo: bool,
    /// Frozen-at-creation copies of the sandbox lists. Seeded from the
    /// project's defaults in `task_create`, but the task owns
    /// them from then on - editing the project later doesn't reach back
    /// into existing tasks. Spawning reads THESE, never the
    /// project's arrays.
    #[serde(default)]
    pub sandbox_rw_paths: Vec<String>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Vec<String>,
    /// Multi-repo composition. Empty for single-repo tasks (the
    /// usual case — `path` already points at the worktree of the one
    /// project this task belongs to). For tasks created
    /// under a `ProjectType::Multi` project this lists the host repo
    /// + every member with its resolved on-disk path. The PTY spawn
    /// + sandbox profile generator iterate this list when populated.
    #[serde(default)]
    pub composition: Vec<TaskMember>,
    /// Pre-set launch command for `cli == "custom"` repo-root tasks.
    /// The default tab runs this through a login shell instead of an
    /// agent binary (e.g. `ssh box`, `npm run dev`, `python`). None for
    /// every agent / shell task. Persisted so the command re-runs
    /// on every respawn / app restart.
    #[serde(default)]
    pub custom_command: Option<String>,
    /// Per-task override for the agent's resume arguments. When set
    /// (non-empty), the spawn uses THIS verbatim (with `{WORKSPACE_NAME}`
    /// / `{WORKSPACE_SLUG}` / etc. placeholders expanded) as the resume
    /// block instead of termic's id-based (`--session-id`/`--resume <uuid>`)
    /// or cwd-based (`--continue`) logic. Lets a repo-root task resume
    /// a named session, e.g. `--resume {WORKSPACE_NAME}`. The agent owns the
    /// "session not found" case (claude shows its resume picker), so no
    /// fast-exit fallback fires for this path. None = default behavior.
    #[serde(default)]
    pub resume_override: Option<String>,
    /// Durable agent tabs for this task, in display order. Written
    /// whenever the in-memory tab set changes (add / close / reorder /
    /// rename) via `task_set_tabs`. On the NEXT app launch the
    /// frontend restores this whole set (every agent tab, not just the
    /// primary) and each id-capable tab resumes its own `session_id`.
    /// Shell / scratch terminals are intentionally NOT persisted here
    /// (they have no session to resume). Closing a tab with its X removes
    /// it from this list (forget); quitting the app leaves it intact
    /// (restore) — that asymmetry is the whole point.
    #[serde(default)]
    pub persisted_tabs: Vec<PersistedTab>,
    /// Durable agent tabs in the right split. Analogous to `persisted_tabs`
    /// but scoped to the right-panel split. Same quit-restore / X-forget
    /// semantics. Shell tabs are excluded (no session to resume).
    #[serde(default)]
    pub right_split_tabs: Vec<PersistedTab>,
    /// JSON-encoded SplitTree for the active tab's pane layout.
    /// Persisted so relaunch can restore the split configuration.
    #[serde(default)]
    pub split_layout: Option<String>,
}

/// One durable agent tab. `session_id` is termic's own per-tab session
/// uuid for id-capable agents (claude / gemini) — distinct per tab so a
/// task can run several agents side by side and resume each one
/// independently. None for cwd-resume agents (codex) and tabs that have
/// not yet minted a session.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct PersistedTab {
    pub id: String,
    pub cli: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub custom_title: bool,
    #[serde(default)]
    pub is_default: bool,
    /// Launch command for `cli == "custom"` tabs (re-run on restore).
    #[serde(default)]
    pub command: Option<String>,
    /// Per-tab termic-owned session uuid. Owned solely by
    /// `task_set_tab_session_id`; `task_set_tabs` PRESERVES it
    /// across rewrites (matched by tab id) so a metadata update never
    /// clobbers a freshly minted session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Leaf ID of the split pane this tab belongs to (None for main panel tabs).
    #[serde(default)]
    pub pane_leaf_id: Option<String>,
    /// Run pop-out tab marker (GH #54): Some(member_dir) when this tab hosts
    /// the run script ("" = host project). Restores the RunPane in its pane.
    #[serde(default)]
    pub run_member: Option<String>,
}

/// Frontend payload for `task_set_tabs`. `session_id` is only honored
/// when there is NO existing record for the tab id (the migration / first
/// write case) — otherwise the stored uuid wins, so the two writers
/// (`set_tabs` for layout, `set_tab_session_id` for the uuid) can't clobber
/// a minted session by racing.
#[derive(Clone, Debug, Deserialize)]
pub struct PersistedTabInput {
    pub id: String,
    pub cli: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub custom_title: bool,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub pane_leaf_id: Option<String>,
    #[serde(default)]
    pub run_member: Option<String>,
}

impl Task {
    /// Resolve the effective sandbox mode, bridging the legacy
    /// `sandbox_enabled` bool for records written before monitoring
    /// shipped. `sandbox_mode` wins when present.
    pub fn effective_sandbox_mode(&self) -> SandboxMode {
        self.sandbox_mode.unwrap_or(
            if self.sandbox_enabled { SandboxMode::Enforce } else { SandboxMode::Off }
        )
    }
}

/// One entry in a multi-repo task's composition. The host repo
/// itself is the first member (its `path` is the task wrapper
/// dir, which IS a git worktree of the host); subsequent entries are
/// the user-picked member repos worktree'd or symlinked inside it.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TaskMember {
    /// LEGACY: references Project.id for tasks created before members
    /// went inline. New tasks leave this empty and use `repo_path`.
    /// Kept so archive / sandbox code can still resolve old compositions.
    #[serde(default)]
    pub project_id: String,
    /// Canonical path to the member's SOURCE repo (or folder). Frozen at
    /// create so archive can `git worktree remove` against it without
    /// resolving a Project. Empty on legacy records — fall back to
    /// `project_id` there.
    #[serde(default)]
    pub repo_path: String,
    /// Display name shown in the file tree / sidebar. Defaults to
    /// the member's name; member dirs are created under this name
    /// inside the wrapper (`<wrapper>/<dir_name>`).
    pub dir_name: String,
    /// Worktree branched off `base_branch`, or a plain symlink to
    /// the project's `root_path` (live, no isolation).
    pub mode: MemberMode,
    /// Branch the worktree was cut from. RepoRoot mode leaves empty.
    pub branch: String,
    /// Resolved on-disk path. Worktree mode = the worktree dir;
    /// RepoRoot mode = the project's `root_path`. Frozen here so the
    /// sandbox profile + file-tree code don't need to re-resolve.
    pub path: String,
    /// Per-member port. Frozen at create. Exposed as $TERMIC_PORT
    /// when this member's setup/run script fires so two members
    /// running `PORT=$TERMIC_PORT npm run dev` in the same task
    /// don't collide on the same listening port. Zero = legacy
    /// task created before per-member ports existed; the
    /// runner falls back to the task's own port in that case.
    #[serde(default)]
    pub port: u16,
    /// Per-member script overrides. Frozen at creation from the
    /// member project's own defaults; user can tweak in the New
    /// task dialog. Run with `cwd = member.path`. Empty = the
    /// member skips that script (so e.g. a docs repo can have no
    /// setup / no run). Host's own scripts (project.setup_script /
    /// run_script / archive_script) cover the wrapper's host worktree.
    pub setup_script: String,
    pub run_script: String,
    pub archive_script: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemberMode {
    #[default]
    Worktree,
    RepoRoot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateTaskArgs {
    pub project_id: String,
    pub name: String,
    pub cli: Option<String>,
    pub base_branch: Option<String>,
    /// Explicit branch name. If omitted, defaults to `slugify(name)`.
    pub branch: Option<String>,
    /// Optional client-supplied task ID. Lets the frontend subscribe
    /// to `setup-output://<id>` + `setup-done://<id>` BEFORE invoking
    /// create — without this, the empty-script branch race-emits done
    /// before the listener attaches and the dialog hangs forever.
    /// Defaults to a server-side UUID for backwards-compat.
    #[serde(default)]
    pub id: Option<String>,
    /// Sandbox the agent for this task. PINNED at creation —
    /// `sandbox_enabled` is copied straight onto the saved Task
    /// and never gets a setter. If unset, the per-project default
    /// (`Project.default_sandbox`) wins.
    #[serde(default)]
    pub sandbox_enabled: Option<bool>,
    /// Sandbox MODE pin (off / monitor / enforce). Additive over
    /// `sandbox_enabled`; when present it wins. Unset → derive from
    /// `sandbox_enabled` / project default.
    #[serde(default)]
    pub sandbox_mode: Option<SandboxMode>,
    /// Optional overrides for the per-task sandbox lists. The
    /// dialog seeds them from the project's defaults, lets the user
    /// add/remove, then sends the final shape here. Unset → fall
    /// back to the project's default arrays.
    #[serde(default)]
    pub sandbox_rw_paths: Option<Vec<String>>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Option<Vec<String>>,
    /// Pre-set launch command for a `cli == "custom"` worktree task. The
    /// default tab runs this through a login shell instead of an agent
    /// binary (e.g. `npm run dev`, `ssh box`). None for agent / shell tasks.
    /// Mirrors the repo-root custom-command path in `task_open_repo`.
    #[serde(default)]
    pub custom_command: Option<String>,
}

// ───────────────────────────── paths ─────────────────────────────

/// Top-level directory name for all of termic's on-disk data —
/// `<data_local_dir>/<APP_DIR>/` (projects, settings, task
/// metadata) and `~/<APP_DIR>/` (worktrees, auto-created host repos).
/// Debug builds (`tauri dev`) use a separate `termic_dev` tree so
/// day-to-day development can't read or clobber the release app's
/// data; release builds (`tauri build`) use `termic`. Note the
/// frontend's localStorage prefs are already dev/prod-separate on
/// their own (different webview origin: localhost vs asset protocol).
const APP_DIR: &str = if cfg!(debug_assertions) { "termic_dev" } else { "termic" };

fn data_dir() -> Result<PathBuf> {
    // Test/automation seam (DEBUG BUILDS ONLY): an explicit
    // TERMIC_DATA_DIR wins over the platform default, so a driven
    // instance (see automation.rs) runs against a scratch profile and
    // can't touch the real one. Also handy for parallel dev instances.
    // Deliberately dead in release: a leaked env var must never silently
    // relocate the real profile and make the user's tasks "vanish".
    let p = match std::env::var("TERMIC_DATA_DIR") {
        Ok(d) if cfg!(debug_assertions) && !d.trim().is_empty() => PathBuf::from(d),
        _ => dirs::data_local_dir()
            .ok_or_else(|| anyhow!("no data dir"))?
            .join(APP_DIR),
    };
    fs::create_dir_all(&p)?;
    Ok(p)
}

fn projects_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("projects.json"))
}
fn tasks_dir() -> Result<PathBuf> {
    let p = data_dir()?.join("tasks");
    fs::create_dir_all(&p)?;
    Ok(p)
}
fn worktrees_base() -> Result<PathBuf> {
    let p = dirs::home_dir().ok_or_else(|| anyhow!("no home"))?.join(APP_DIR).join("tasks");
    fs::create_dir_all(&p)?;
    Ok(p)
}

// ───────────────────────────── projects IO ─────────────────────────────

fn load_projects() -> Vec<Project> {
    let f = match projects_file() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut list: Vec<Project> = match fs::read_to_string(&f) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    // One-time migration: members used to reference a Project by id.
    // Resolve those into the self-contained inline shape so adding a
    // member never leaves a standalone project behind. Persist only when
    // something actually changed (load_projects runs on nearly every IPC).
    let mut dirty = migrate_legacy_members(&mut list);
    dirty |= repoint_task_bases(&mut list);
    if dirty {
        let _ = save_projects(&list);
    }
    list
}

/// Repoint each project's worktree base from the pre-rename `~/APP_DIR/workspaces/`
/// root to `~/APP_DIR/tasks/`, so NEW worktrees land under `tasks/` going forward.
/// Existing task worktrees keep their own stored `path` (never moved, so CWD-resume
/// stays intact) — this only changes where the NEXT worktree for a project gets
/// created. Boundary-safe prefix match (trailing separator) so a custom location
/// outside our root is left alone. Idempotent: once repointed, the prefix no longer
/// matches. Runs on every load (cheap), self-healing pre-rename profiles without a
/// schema bump. Returns true if anything changed.
fn repoint_task_bases(list: &mut [Project]) -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    let sep = std::path::MAIN_SEPARATOR;
    let old_root = format!("{}{sep}", home.join(APP_DIR).join("workspaces").to_string_lossy());
    let new_root = format!("{}{sep}", home.join(APP_DIR).join("tasks").to_string_lossy());
    let mut changed = false;
    for p in list.iter_mut() {
        if let Some(rest) = p.tasks_path.strip_prefix(&old_root) {
            p.tasks_path = format!("{new_root}{rest}");
            changed = true;
        }
    }
    changed
}

/// Migrate pre-inline multi-repo members (which referenced a Project by
/// `project_id`) into the inline `ProjectMember` shape by copying the
/// referenced project's path / name / git status / base / sandbox lists.
/// Dangling references are dropped. Returns true if anything changed.
fn migrate_legacy_members(list: &mut [Project]) -> bool {
    use std::collections::HashMap;
    // Snapshot id → resolvable fields up front (we mutate members below).
    let lookup: HashMap<String, (String, String, bool, String, Vec<String>, Vec<String>)> = list
        .iter()
        .map(|p| {
            (p.id.clone(), (
                p.root_path.clone(), p.name.clone(), p.non_git,
                p.base_branch.clone(), p.sandbox_rw_paths.clone(), p.sandbox_allowed_hosts.clone(),
            ))
        })
        .collect();
    let mut changed = false;
    for p in list.iter_mut() {
        if p.project_type != ProjectType::Multi { continue; }
        let mut migrated = Vec::with_capacity(p.members.len());
        for mut m in std::mem::take(&mut p.members) {
            // Already inline (root_path set) — keep as-is.
            if !m.root_path.is_empty() {
                migrated.push(m);
                continue;
            }
            if m.project_id.is_empty() { changed = true; continue; }
            match lookup.get(&m.project_id) {
                Some((rp, name, non_git, base, rw, hosts)) => {
                    m.root_path = rp.clone();
                    m.name = name.clone();
                    m.non_git = *non_git;
                    if m.base_branch.is_empty() { m.base_branch = base.clone(); }
                    if m.sandbox_rw_paths.is_empty() { m.sandbox_rw_paths = rw.clone(); }
                    if m.sandbox_allowed_hosts.is_empty() { m.sandbox_allowed_hosts = hosts.clone(); }
                    m.project_id = String::new();
                    changed = true;
                    migrated.push(m);
                }
                // Dangling reference — drop the broken member.
                None => { changed = true; }
            }
        }
        p.members = migrated;
    }
    changed
}

/// Expand a leading `~/` to the user's home dir; otherwise return as-is.
fn expand_tilde(path: &str) -> String {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed.to_string()
    }
}

/// Normalize an inbound inline member: expand + canonicalize its path,
/// detect git, fill name / base_branch defaults. The frontend may send a
/// bare path; Rust is the source of truth for the stored fields.
fn normalize_member(mut m: ProjectMember) -> Result<ProjectMember, String> {
    let expanded = expand_tilde(&m.root_path);
    if expanded.is_empty() { return Err("member path is required".into()); }
    let pb = PathBuf::from(&expanded);
    if !pb.exists() { return Err(format!("{} does not exist", expanded)); }
    if !pb.is_dir() { return Err(format!("{} is not a directory", expanded)); }
    let canon = fs::canonicalize(&pb).map_err(|e| e.to_string())?;
    let is_git = git(&["rev-parse", "--git-dir"], &canon).is_ok();
    m.non_git = !is_git;
    m.root_path = canon.to_string_lossy().into_owned();
    if m.name.trim().is_empty() {
        m.name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string();
    }
    if is_git && m.base_branch.trim().is_empty() {
        let base = detect_base_branch(&canon).unwrap_or_else(|_| "main".into());
        let remote = detect_default_remote(&canon);
        m.base_branch = format!("{remote}/{base}");
    }
    m.project_id = String::new();
    Ok(m)
}
fn save_projects(list: &[Project]) -> Result<()> {
    fs::write(projects_file()?, serde_json::to_string_pretty(list)?)?;
    Ok(())
}

fn load_tasks() -> Vec<Task> {
    let dir = match tasks_dir() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            if let Ok(s) = fs::read_to_string(entry.path()) {
                if let Ok(w) = serde_json::from_str::<Task>(&s) {
                    out.push(w);
                }
            }
        }
    }
    out.sort_by(|a, b| a.created.cmp(&b.created));
    out
}
fn save_task(w: &Task) -> Result<()> {
    let f = tasks_dir()?.join(format!("{}.json", w.id));
    fs::write(&f, serde_json::to_string_pretty(w)?)?;
    Ok(())
}
fn delete_task_file(id: &str) -> Result<()> {
    let f = tasks_dir()?.join(format!("{id}.json"));
    let _ = fs::remove_file(f);
    Ok(())
}

// ──────────────── Phase 0: workspaces -> tasks migration ────────────────
//
// One-time on-disk migration for the workspace->task rename. Runs once at
// startup (see `run()`), BEFORE any task load, gated by
// `settings.schema_version`. See docs/plans/workspace-to-task-rename.md.
//
// METADATA-ONLY: it renames the metadata dir workspaces/ -> tasks/ and the
// `is_repo_root` field to `is_main_checkout`. It does NOT touch worktree
// directories or the `path` field, because CWD-resume agents (Claude Code's
// `--continue`) resume by working directory and moving a worktree would orphan
// its session history. New worktrees land under ~/APP_DIR/tasks/ going forward;
// pre-existing ones stay under ~/APP_DIR/workspaces/ and age out lazily.
//
// Guarantees (stage -> verify -> single-pointer-flip):
//   1. No data loss: the old copy is never deleted until the new one is
//      written AND verified.
//   2. Atomic metadata commit: build `tasks.tmp/`, validate, then one
//      `rename(tasks.tmp -> tasks)` syscall. Readers see all-old or all-new.
//   3. Crash-safe / resumable: `schema_version` is written LAST and every
//      step is idempotent, so an interrupted run rolls forward next launch.
//   4. Clean by construction: broken records never enter `tasks.tmp/`, so the
//      committed set has zero corrupt entries (prune-on-corruption).

fn migration_log_file() -> Option<PathBuf> {
    data_dir().ok().map(|d| d.join("tasks-migration.log"))
}

fn log_migration(msg: &str) {
    dlog(&format!("[migrate] {msg}"));
    if let Some(f) = migration_log_file() {
        use std::io::Write;
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(f) {
            let _ = writeln!(file, "{msg}");
        }
    }
}

fn log_prune(path: &Path, reason: &str) {
    log_migration(&format!("PRUNED {} :: {reason}", path.display()));
}

/// Seconds since the epoch, for the backup dir name. `None` if the clock is
/// before 1970 (never in practice) — the caller then skips the backup.
fn migration_timestamp() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Recursively copy a directory tree, preserving symlinks (worktrees can hold
/// symlinked node_modules etc.). Used for the pre-migration backup and the
/// cross-volume (EXDEV) fallback when `fs::rename` can't move the worktree
/// root in one syscall.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_symlink() {
            let target = fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to)?;
            #[cfg(not(unix))]
            { let _ = target; let _ = fs::copy(&from, &to)?; }
        } else if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Write `schema_version = TASKS_SCHEMA_VERSION` into settings.json directly
/// (the migration's commit marker). Written LAST so a crash before this leaves
/// the guard un-bumped and the migration re-runs cleanly.
fn stamp_schema_version() {
    let mut s = settings_load();
    s.schema_version = TASKS_SCHEMA_VERSION;
    if let Ok(f) = settings_file() {
        if let Ok(txt) = serde_json::to_string_pretty(&s) {
            let _ = fs::write(f, txt);
        }
    }
}

/// Exclusive migration lock, released on drop. Guards against two concurrent
/// launches migrating the same data dir at once (the app is single-instance in
/// practice, but nothing enforces it — a double-click or a stray second dev
/// instance could race and, without this, corrupt the staging/commit).
struct MigrationLock(PathBuf);
impl Drop for MigrationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Try to acquire the migration lock. Returns None if another process holds a
/// FRESH lock (skip this launch; the holder will finish). A stale lock (older
/// than 5 min, i.e. a crashed prior run) is stolen so migration can't wedge
/// forever.
fn acquire_migration_lock(data: &Path) -> Option<MigrationLock> {
    let lock = data.join("tasks-migration.lock");
    if let Ok(meta) = fs::metadata(&lock) {
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .map(|age| age > std::time::Duration::from_secs(300))
            .unwrap_or(true); // unreadable mtime -> treat as stale
        if stale {
            let _ = fs::remove_file(&lock);
        }
    }
    match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
        Ok(_) => Some(MigrationLock(lock)),
        Err(_) => None, // someone else holds a fresh lock
    }
}

fn migrate_workspaces_to_tasks() {
    // Best-effort throughout: a migration failure must NEVER stop the app from
    // starting. Worst case the old layout stays in place and we retry next
    // launch (the guard is the committed schema_version, written last).
    let data = match data_dir() { Ok(p) => p, Err(_) => return };

    // GUARD: already migrated?
    if settings_load().schema_version >= TASKS_SCHEMA_VERSION {
        return;
    }

    // LOCK: refuse to run two migrations against the same data dir at once.
    // Released automatically on every return path (Drop).
    let _lock = match acquire_migration_lock(&data) {
        Some(l) => l,
        None => {
            log_migration("another migration is in progress (lock held); skipping this launch");
            return;
        }
    };
    // Re-check the guard now that we hold the lock: the process that held it may
    // have just committed the migration while we waited to acquire.
    if settings_load().schema_version >= TASKS_SCHEMA_VERSION {
        return;
    }

    // NOTE: compute raw paths (not via tasks_dir(), which would create the dir
    // and defeat the "does tasks/ exist yet" checks below).
    let old_meta = data.join("workspaces");
    let new_meta = data.join("tasks");
    let tmp_meta = data.join("tasks.tmp");

    // Fresh install (or already-migrated profile with no old metadata): just
    // stamp the version and move on.
    if !old_meta.exists() {
        stamp_schema_version();
        return;
    }

    log_migration(&format!(
        "starting workspaces->tasks migration (schema {} -> {})",
        settings_load().schema_version, TASKS_SCHEMA_VERSION
    ));

    // 1. BACKUP metadata + settings + projects (cheap safety net).
    if let Some(ts) = migration_timestamp() {
        let backup = data.join("backups").join(format!("pre-tasks-{ts}"));
        let _ = fs::create_dir_all(&backup);
        if copy_dir_all(&old_meta, &backup.join("workspaces")).is_ok() {
            for f in ["settings.json", "projects.json"] {
                let src = data.join(f);
                if src.exists() { let _ = fs::copy(&src, backup.join(f)); }
            }
            log_migration(&format!("backup written to {}", backup.display()));
        } else {
            log_migration("backup copy failed; continuing (old layout stays intact until commit)");
        }
    }

    // 2. CLASSIFY: build tasks.tmp/ from survivors only.
    //
    // METADATA-ONLY migration. We rename the metadata dir workspaces/ -> tasks/
    // and rewrite the `is_repo_root` field to `is_main_checkout`, but we
    // DELIBERATELY DO NOT move worktree directories or rewrite `path`.
    // CWD-resume agents (Claude Code's `--continue`, etc.) resume the most
    // recent session BY WORKING DIRECTORY, so relocating a worktree would
    // silently orphan its history. Existing worktrees stay put under
    // ~/APP_DIR/workspaces/...; NEW worktrees are created under ~/APP_DIR/tasks/
    // (see worktrees_base). The two roots coexist and the old one empties out
    // naturally as the user archives and recreates tasks. The metadata dir is
    // NOT a working directory and is never passed to an agent, so renaming it
    // is safe.
    let _ = fs::remove_dir_all(&tmp_meta); // discard any half-built staging
    if let Err(e) = fs::create_dir_all(&tmp_meta) {
        log_migration(&format!("cannot create staging dir ({e}); aborting"));
        return;
    }

    let mut kept = 0u32;
    let mut pruned = 0u32;
    if let Ok(rd) = fs::read_dir(&old_meta) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
            let raw = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => { pruned += 1; log_prune(&path, "unreadable"); continue; }
            };
            let task: Task = match serde_json::from_str(&raw) {
                Ok(t) => t,
                Err(e) => { pruned += 1; log_prune(&path, &format!("unparseable: {e}")); continue; }
            };

            // NON-DESTRUCTIVE: every task we can READ is migrated, full stop.
            // We deliberately do NOT drop a task just because its worktree dir
            // is missing at migration time — that dir could be on an unmounted
            // external volume, a network mount, or otherwise temporarily
            // unreachable, and losing a valid task record over a transient
            // condition is exactly what we must not do. A genuinely orphaned
            // task (worktree deleted for real) simply shows up in the list and
            // the user can archive it; that's a far better failure mode than a
            // workspace silently vanishing. Only unreadable / unparseable files
            // are pruned above, and those are preserved in the pre-migration
            // backup regardless. `path` is left untouched throughout.

            // Survivor: re-serialize (renames is_repo_root -> is_main_checkout).
            let out = tmp_meta.join(format!("{}.json", task.id));
            match serde_json::to_string_pretty(&task) {
                Ok(s) if fs::write(&out, &s).is_ok() => { kept += 1; }
                _ => { pruned += 1; log_prune(&path, "write to staging failed"); }
            }
        }
    }

    // 4. VALIDATE every file in staging parses back into a Task.
    let mut valid = true;
    if let Ok(rd) = fs::read_dir(&tmp_meta) {
        for e in rd.flatten() {
            if let Ok(s) = fs::read_to_string(e.path()) {
                if serde_json::from_str::<Task>(&s).is_err() { valid = false; break; }
            }
        }
    }
    if !valid {
        log_migration("staging validation FAILED; aborting (old metadata intact)");
        let _ = fs::remove_dir_all(&tmp_meta);
        return;
    }

    // 5. COMMIT: single rename tasks.tmp -> tasks (the one flip point).
    if new_meta.exists() {
        // Only possible after a crash between a prior commit and old-meta
        // delete; the fresh staging supersedes it.
        let _ = fs::remove_dir_all(&new_meta);
    }
    if let Err(e) = fs::rename(&tmp_meta, &new_meta) {
        log_migration(&format!("commit rename failed ({e}); aborting (old metadata intact)"));
        let _ = fs::remove_dir_all(&tmp_meta);
        return;
    }

    // 6. CLEANUP: drop old metadata, stamp schema_version LAST.
    let _ = fs::remove_dir_all(&old_meta);
    stamp_schema_version();
    log_migration(&format!("migration committed: {kept} task(s) kept, {pruned} pruned"));
}

// ───────────────────────────── git ─────────────────────────────

fn git(args: &[&str], cwd: &Path) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    // Run with the user's login-shell environment, same as the PTY (see
    // pty_spawn). A GUI-launched .app gets a bare launchd PATH; without this,
    // git hooks (pre-commit, etc.) can't find node/bun/python/etc. and exported
    // vars (direnv, tokens) the user's rc sets are missing — so a commit that
    // works in the embedded terminal would fail from the Git panel. The
    // resolved env is cached (OnceLock), so this is cheap per call.
    cmd.env("PATH", shell_env::resolved_path());
    for (k, v) in shell_env::login_env() {
        cmd.env(k, v);
    }
    let out = cmd.output().with_context(|| format!("git {:?}", args))?;
    if !out.status.success() {
        return Err(anyhow!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Best-effort, time-bounded fetch of a single base ref before a new task
/// branch is cut from it, so the branch starts from the latest remote commit
/// instead of whatever the local `origin/*` happened to point at at the last
/// manual fetch (GH #79). `base_full` is like "origin/develop": the leading
/// path segment is the remote, the rest is the ref. A base with no remote
/// prefix (a purely local branch) is left alone.
///
/// This is NEVER fatal: auth failure, offline, or a dead/prompting remote just
/// logs and returns, and create proceeds off the existing local ref (today's
/// behavior). It is also hard-bounded — a hung transfer or credential prompt
/// can't wedge task creation:
///   - `GIT_TERMINAL_PROMPT=0` + batch-mode SSH with a short connect timeout
///     make a credential-less remote fail fast instead of blocking on a prompt.
///   - a wall-clock deadline SIGKILLs the child on expiry.
/// Callers run on a `spawn_blocking` thread (see `task_create`), so the network
/// wait never touches the UI thread.
fn git_fetch_base(repo: &Path, base_full: &str) {
    // Split "remote/ref". No '/' → a local branch, nothing to fetch. Verify
    // the first segment is a configured remote so a local branch that merely
    // contains a slash (e.g. "feature/x") isn't mistaken for "<remote>/x".
    let Some((remote, refname)) = base_full.split_once('/') else { return };
    if remote.is_empty() || refname.is_empty() {
        return;
    }
    let remotes = git(&["remote"], repo).unwrap_or_default();
    if !remotes.lines().any(|r| r.trim() == remote) {
        return;
    }

    let mut cmd = Command::new("git");
    // Single-ref, no-tags fetch: updates refs/remotes/<remote>/<ref> via the
    // remote's configured fetch refspec and nothing else — fast, no need to
    // pull every ref.
    cmd.args(["fetch", "--no-tags", remote, refname]).current_dir(repo);
    // Same login-shell env as git() so credential helpers / SSH config resolve
    // from a GUI-launched .app (bare launchd PATH otherwise).
    cmd.env("PATH", shell_env::resolved_path());
    for (k, v) in shell_env::login_env() {
        cmd.env(k, v);
    }
    // Fail fast rather than block on a credential/passphrase prompt or a dead
    // host. The deadline below is the hard ceiling on top of these.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=10");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("git_fetch_base: spawn fetch {remote}/{refname}: {e}");
            return;
        }
    };

    // Poll to a hard deadline; SIGKILL on expiry. 15s covers a normal
    // single-ref fetch on a slow link; ConnectTimeout=10 already caps the
    // common dead-host case well under this.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    // Non-fatal: branch off the local ref as before.
                    eprintln!("git_fetch_base: fetch {remote}/{refname} exited unsuccessfully ({status}); using local ref");
                }
                return;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!("git_fetch_base: fetch {remote}/{refname} timed out; using local ref");
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                eprintln!("git_fetch_base: wait fetch {remote}/{refname}: {e}");
                return;
            }
        }
    }
}

fn detect_base_branch(repo: &Path) -> Result<String> {
    for b in &["main", "master", "develop"] {
        if git(&["rev-parse", "--verify", b], repo).is_ok() {
            return Ok((*b).to_string());
        }
    }
    Err(anyhow!("no main/master/develop branch in {}", repo.display()))
}

fn detect_default_remote(repo: &Path) -> String {
    git(&["remote"], repo)
        .ok()
        .and_then(|s| s.lines().next().map(str::to_string))
        .unwrap_or_else(|| "origin".into())
}

// ───────────────────────────── PTY manager ─────────────────────────────

struct PtySlot {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    // Raw OS pid so we can SIGKILL without contending with the waiter thread
    // (which holds the Child for the duration of wait()). Holding a shared
    // Mutex<Child> here would deadlock pty_kill against the waiter.
    child_pid: Option<u32>,
    /// Sandbox bundle for this PTY, if the task was sandbox-enabled.
    /// Dropping the bundle shuts down the in-process proxy thread; we
    /// let TMPDIR expire for the profile / filter files (they're tiny
    /// and useful for post-mortem). `None` for unsandboxed PTYs.
    /// Held purely so its Drop fires when the slot is dropped - never
    /// read directly, hence the allow.
    #[allow(dead_code)]
    sandbox: Option<SandboxBundle>,
    /// Task this PTY belongs to, copied from `SpawnArgs.task_id`.
    /// Lets `task_set_sandbox` SIGKILL all PTYs of a task whose
    /// sandbox config was just edited so the next mount picks up the new
    /// profile. `None` for non-task PTYs (none today; future-proof).
    task_id: Option<String>,
}

#[derive(Default)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<String, PtySlot>>>,
}

#[derive(Clone, Serialize)]
struct PtyChunk { data: Vec<u8> }

#[derive(Clone, Serialize)]
struct PtyExit { code: Option<i32> }

/// Truth about how the agent actually got spawned - not just whether
/// the task WANTED to be sandboxed but whether the cage actually
/// closed. Returned synchronously as part of `pty_spawn`'s value so
/// the frontend can't miss it (the earlier event-based variant had a
/// race window between the emit and the frontend's listener attach).
#[derive(Clone, Serialize)]
pub struct SandboxStatus {
    /// True iff the spawn went through sandbox-exec. False for an
    /// unsandboxed task AND for the degraded case where
    /// provisioning failed (we proceed unsandboxed rather than crash).
    active: bool,
    /// True iff the network proxy started. Implies network allowlisting works.
    /// False with `active: true` means filesystem sandbox + full
    /// network deny - the agent has no internet at all. That's the
    /// silent-failure case worth surfacing.
    proxy_active: bool,
    /// Human-readable note when something degraded. Empty in the
    /// happy path.
    warning: String,
}

/// Return shape of `pty_spawn`. Pairs the PTY id with the realized
/// sandbox state so the frontend gets both atomically.
#[derive(Clone, Serialize)]
pub struct SpawnResult {
    id: String,
    sandbox: SandboxStatus,
}

#[derive(Deserialize)]
pub struct SpawnArgs {
    pub cwd: String,
    pub cmd: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_cols")]
    pub cols: u16,
    /// When present, the frontend is asking us to wrap the spawn in
    /// the task's sandbox (seatbelt + per-task network proxy).
    /// We look up the task, refuse to sandbox if its
    /// `sandbox_enabled` is false, and proceed unsandboxed if the
    /// task can't be found (e.g. transient race). The PTY id
    /// returned is the same shape either way.
    #[serde(default)]
    pub task_id: Option<String>,
    /// The agent ID being spawned in *this* tab. May differ from
    /// `task.cli` because a task can host multiple tabs
    /// running different agents (e.g. a claude task with a gemini
    /// tab open). Drives which agent's `sandbox_allowed_paths` +
    /// per-CLI host allowlist get baked into the freshly-provisioned
    /// SBPL profile. Falls back to `task.cli` when absent.
    #[serde(default)]
    pub agent_id: Option<String>,
}
fn default_rows() -> u16 { 40 }
fn default_cols() -> u16 { 120 }

/// `.termic.yaml` always lives at — and is read from — the project's
/// `root_path` (the user's main checkout), never a per-task
/// worktree. That keeps one source of truth: a Repository-settings
/// edit, a footer "Allow", and the spawn-time read all hit the same
/// file. It is also OUTSIDE the per-task sandbox, so a caged
/// agent cannot edit the config the sandbox reads.
fn repo_config_for(proj: &Project) -> repo_config::RepoConfig {
    repo_config::load_or_default(Path::new(&proj.root_path))
}

/// Compute the live sandbox allow-lists for a task at spawn time.
/// Unions four layers:
///   1. global Settings defaults,
///   2. the task's own pinned arrays (Sandbox dialog),
///   3. each contributing project's personal "allow for me" overrides
///      from `projects.json`,
///   4. each contributing project's committed `.termic.yaml` sandbox
///      block — re-read fresh on every spawn.
fn live_sandbox_lists(task: &Task) -> (Vec<String>, Vec<String>) {
    let globals = load_settings_inner();
    let projects = load_projects();
    let mut rw = globals.sandbox_default_rw_paths.clone();
    let mut hosts = globals.sandbox_default_allowed_hosts.clone();
    // The task's own pinned arrays — the Sandbox dialog's
    // per-task personal layer.
    rw.extend(task.sandbox_rw_paths.iter().cloned());
    hosts.extend(task.sandbox_allowed_hosts.iter().cloned());

    // Repos contributing to this task.
    if task.composition.is_empty() {
        // Single-repo: the project's committed `.termic.yaml` sandbox block
        // (re-read live) + its personal projects.json overrides.
        if let Some(p) = projects.iter().find(|p| p.id == task.project_id) {
            let cfg = repo_config_for(p);
            rw.extend(cfg.sandbox.allowed_paths);
            hosts.extend(cfg.sandbox.allowed_hosts);
            rw.extend(p.sandbox_rw_paths.iter().cloned());
            hosts.extend(p.sandbox_allowed_hosts.iter().cloned());
        }
    } else {
        // Multi-repo: each member's committed `.termic.yaml` sandbox block,
        // re-read live from its source repo. (Member sandbox lists from the
        // multi-repo project were frozen into the task's pinned arrays
        // at create, so they're already covered above.)
        for m in &task.composition {
            let rp = member_repo_path(m);
            if rp.is_empty() { continue; }
            let cfg = repo_config::load_or_default(Path::new(&rp));
            rw.extend(cfg.sandbox.allowed_paths);
            hosts.extend(cfg.sandbox.allowed_hosts);
        }
    }
    (dedup_strings(rw), dedup_strings(hosts))
}

fn dedup_strings(v: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    v.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

/// Effective (setup, run, archive) scripts for a single-repo project.
/// The project's personal override in `projects.json` wins when
/// non-empty; otherwise the repo's committed `.termic.yaml`. This
/// fallback also keeps legacy projects (scripts in `projects.json`,
/// no `.termic.yaml`) working unchanged.
fn effective_scripts(proj: &Project) -> (String, String, String) {
    let cfg = repo_config_for(proj);
    let pick = |ovr: &str, repo: String| {
        if ovr.trim().is_empty() { repo } else { ovr.to_string() }
    };
    (
        pick(&proj.setup_script, cfg.scripts.setup),
        pick(&proj.run_script, cfg.scripts.run),
        pick(&proj.archive_script, cfg.scripts.archive),
    )
}

/// Effective script for a multi-repo composition member: the frozen per-member
/// override (`m.setup_script` / `run_script` / `archive_script`) when non-empty,
/// otherwise the member's OWN committed `.termic.yaml` value. Mirrors
/// `effective_scripts` (host) and the frontend run-target resolver, so a member
/// whose scripts live in `.termic.yaml` (rather than a manual override) still
/// runs its setup / archive in a multi-repo task.
fn member_effective_script(
    m: &TaskMember,
    pick: impl Fn(&repo_config::RepoScripts) -> String,
    override_val: &str,
) -> String {
    if !override_val.trim().is_empty() {
        return override_val.to_string();
    }
    let repo = if m.repo_path.is_empty() { &m.path } else { &m.repo_path };
    pick(&repo_config::load_or_default(Path::new(repo)).scripts)
}

/// Effective `files_to_copy` globs — the project's `projects.json`
/// override wins when non-empty, otherwise the repo's committed
/// `.termic.yaml` list. Same override rule as `effective_scripts`.
fn effective_files_to_copy(proj: &Project) -> Vec<String> {
    if !proj.files_to_copy.is_empty() {
        return proj.files_to_copy.clone();
    }
    repo_config_for(proj).scripts.files_to_copy
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    args: SpawnArgs,
) -> Result<SpawnResult, String> {
    let pty = NativePtySystem::default();
    let pair = pty
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // ── Sandbox wrap, if applicable ────────────────────────────────
    // If the task is flagged sandbox_enabled, provision a fresh
    // seatbelt profile + network proxy and rewrite (cmd, args) to go through
    // `sandbox-exec`. The bundle gets parked on the PtySlot so its
    // Drop impl SIGKILLs the proxy when the PTY closes.
    let (effective_cmd, effective_args, sandbox_bundle) = match args
        .task_id
        .as_deref()
        .and_then(|wid| load_tasks().into_iter().find(|w| w.id == wid))
        .filter(|w| w.effective_sandbox_mode() != SandboxMode::Off)
        // Re-render the allow-lists each spawn so committed
        // `.termic.yaml` edits are picked up live, unioned with the
        // personal (task/project/global) layers. See
        // `live_sandbox_lists` / repo_config.rs.
        .map(|mut task| {
            let (rw, hosts) = live_sandbox_lists(&task);
            task.sandbox_rw_paths = rw;
            task.sandbox_allowed_hosts = hosts;
            task
        })
    {
        Some(task) => match sandbox::provision(&task, args.agent_id.as_deref(), task.effective_sandbox_mode()) {
            Ok(bundle) => {
                let port = bundle.proxy.as_ref().map(|p| p.port).unwrap_or(0);
                let effective_cli = args.agent_id.as_deref().unwrap_or(&task.cli);
                dlog(&format!(
                    "[pty_spawn] sandbox={:?} task={} cli={} proxy_port={} profile={}",
                    task.effective_sandbox_mode(), task.id, effective_cli, port, bundle.profile_path.display(),
                ));
                let (c, a) = sandbox::wrap_command(&bundle, &args.cmd, &args.args);
                dlog(&format!("[pty_spawn] wrapped: {c} {a:?}"));
                (c, a, Some(bundle))
            }
            Err(e) => {
                dlog(&format!("[pty_spawn] sandbox provision failed, spawning unsandboxed: {e}"));
                (args.cmd.clone(), args.args.clone(), None)
            }
        },
        None => {
            dlog(&format!("[pty_spawn] sandbox=OFF cmd={} args={:?}", args.cmd, args.args));
            (args.cmd.clone(), args.args.clone(), None)
        },
    };

    let mut cmd = CommandBuilder::new(&effective_cmd);
    for a in &effective_args {
        cmd.arg(a);
    }
    cmd.cwd(&args.cwd);
    // Inherit ALL parent env first — agents need ANTHROPIC_API_KEY,
    // GEMINI_API_KEY, OPENAI_API_KEY, HTTPS_PROXY, etc. The user's per-spawn
    // `env` overlay then takes precedence for known keys like TERMIC_*.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    // Override the inherited PATH with the login-shell-resolved one.
    // GUI-launched .app bundles get a bare PATH from launchd; without
    // this, `claude` / `codex` / `gemini` installed in ~/.local/bin,
    // ~/.bun/bin, /opt/homebrew/bin, or under nvm aren't found. See
    // shell_env.rs.
    cmd.env("PATH", shell_env::resolved_path());
    // Inject the rest of the user's login-shell environment (EDITOR, VISUAL,
    // LANG, GPG_TTY, ...) — but ONLY for UNSANDBOXED spawns. The sandboxed
    // agent is the threat model (CLAUDE.md), and this rc delta can carry
    // exported secrets (cloud creds, GITHUB_TOKEN, etc.); the seatbelt/proxy
    // don't filter env, so handing them in would let a compromised agent
    // read and exfiltrate them via an allow-listed host. Sandboxed agents
    // still get the resolved PATH above (so the CLI resolves) — just not the
    // secret-bearing delta. Unsandboxed (scratch terminal, shell/custom
    // tabs, or sandbox=off agents) the CLI is exec'd directly, so without
    // this it would miss $EDITOR etc. (#17). The per-spawn overlay below
    // still wins, so explicit overrides hold.
    if sandbox_bundle.is_none() {
        for (k, v) in shell_env::login_env() {
            cmd.env(k, v);
        }
    }
    for (k, v) in &args.env {
        cmd.env(k, v);
    }
    // Multi-repo: expose sibling ports so the agent (or anything the
    // user runs in this PTY) can `curl localhost:$TERMIC_PORT_API`
    // without hardcoding. Same scheme as the script-stream spawn.
    if let Some(wid) = args.task_id.as_deref() {
        if let Some(task) = load_tasks().into_iter().find(|w| w.id == wid) {
            for (i, m) in task.composition.iter().enumerate() {
                let p = if m.port == 0 { task.port.saturating_add(i as u16 + 1) } else { m.port };
                let sanitized: String = m.dir_name.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                    .collect();
                cmd.env(format!("TERMIC_PORT_{sanitized}"), p.to_string());
            }
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Claim iTerm2 compatibility so agents that gate "fancy" OSC
    // emission on a known host (Claude Code's OSC 9 / OSC 9;4
    // progress, OSC 133 shell-integration, OSC 1337 attention)
    // actually emit those signals. Without this they default to
    // "dumb terminal" silence and our work-done detection in
    // TerminalPane.tsx never receives the busy/idle edges. We DO
    // implement the relevant subset (OSC 9, OSC 9;4, OSC 133, OSC
    // 1337) — see TerminalPane's registerOscHandler calls — so the
    // claim is honest. Version string is high enough to clear common
    // feature-gate checks in agents that look for "iTerm2 ≥ 3.x".
    cmd.env("TERM_PROGRAM", "iTerm.app");
    cmd.env("TERM_PROGRAM_VERSION", "3.5.0");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        let s = e.to_string();
        dlog(&format!("[pty_spawn] spawn_command FAILED: {s}"));
        s
    })?;
    dlog(&format!("[pty_spawn] spawn_command OK pid={:?}", child.process_id()));
    let child_pid = child.process_id();
    drop(pair.slave);

    // Register the PID with the sandbox's PID-ancestry tracker. The
    // path watcher uses this to filter system-wide deny noise: only
    // denies whose PID (or some ancestor) is in this set get counted
    // against this task.
    if let (Some(pid), Some(wid)) = (child_pid, args.task_id.as_deref()) {
        sandbox::register_root_pid(wid, pid);
    }

    let id = Uuid::new_v4().to_string();
    let master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    // Reader → shared buffer → flusher → Tauri event.
    //
    // Emitting one event per 4 KB read is the naive path but catastrophic for
    // bulk output (e.g. `cat large.txt`): 6 MB produces ~1 500 events, each
    // serialising bytes as a JSON number array (~4× overhead = 24 MB of JSON).
    // The flusher coalesces those into ~8-16 events at 60 fps, cutting IPC
    // load by ~100× for large writes while adding ≤8 ms latency to interactive
    // responses (imperceptible in practice).
    let pty_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let reader_done: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));

    // Reader thread: drain PTY bytes into the shared buffer.
    let buf_r = pty_buf.clone();
    let done_r = reader_done.clone();
    let app_final = app.clone();
    let id_final = id.clone();
    let id_r = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf_r.lock().extend_from_slice(&buf[..n]);
                }
            }
        }
        // Emit any bytes the flusher hasn't picked up yet, then signal done
        // so the waiter can fire pty-exit after all output is on the wire.
        let remaining = std::mem::take(&mut *buf_r.lock());
        if !remaining.is_empty() {
            let _ = app_final.emit(&format!("pty://{}", id_final), PtyChunk { data: remaining });
        }
        done_r.store(true, Ordering::Release);
    });

    // Flusher thread: drain the shared buffer and emit at most every 8 ms.
    let buf_f = pty_buf.clone();
    let done_f = reader_done.clone();
    let app_f = app.clone();
    thread::spawn(move || {
        let interval = Duration::from_millis(8);
        loop {
            thread::sleep(interval);
            let data = std::mem::take(&mut *buf_f.lock());
            if !data.is_empty() {
                let _ = app_f.emit(&format!("pty://{}", id_r), PtyChunk { data });
            }
            if done_f.load(Ordering::Acquire) {
                break;
            }
        }
    });

    // Waiter thread owns the Child outright. wait() blocks until the process
    // exits; if pty_kill SIGKILLs it, wait() returns naturally — no mutex
    // contention with the kill path.
    let app_w = app.clone();
    let id_w = id.clone();
    let state_w = state.inner.clone();
    let ws_for_waiter = args.task_id.clone();
    let pid_for_waiter = child_pid;
    let done_w = reader_done.clone();
    thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.and_then(|s| i32::try_from(s.exit_code()).ok());
        dlog(&format!("[pty/{id_w}] child exited code={code:?}"));
        // Wait for the reader to drain and emit all remaining PTY output
        // before firing pty-exit. Without this the frontend could process
        // exit before the last bytes arrive and tear down the listener.
        while !done_w.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(1));
        }
        let _ = app_w.emit(&format!("pty-exit://{}", id_w), PtyExit { code });
        // Drop this PID from the sandbox's PID set so the path watcher
        // stops counting denies from anything that happened to inherit
        // this PID after exit (rare but possible on macOS).
        if let (Some(pid), Some(task)) = (pid_for_waiter, ws_for_waiter.as_deref()) {
            sandbox::unregister_root_pid(task, pid);
        }
        let mut map = state_w.lock();
        map.remove(&id_w);
    });

    // Build the truth about how this PTY actually got sandboxed and
    // RETURN it alongside the id - no event, no race. The previous
    // event-based path had a window between `app.emit(...)` and the
    // frontend's listener attach (the listener only registers after
    // `ptySpawn` resolves with the id), so under load the warning
    // chip could silently never appear. Returning the value
    // synchronously makes that window impossible to hit.
    let status = match &sandbox_bundle {
        None => SandboxStatus { active: false, proxy_active: false, warning: String::new() },
        Some(b) => SandboxStatus {
            active: true,
            proxy_active: b.proxy.is_some(),
            warning: if b.proxy.is_none() {
                // Headline silent-failure case: bad regex in the
                // task's allowlist, EMFILE, or some other proxy
                // startup error - all degrade sandboxed-with-network
                // to sandboxed-no-network.
                "Network proxy didn't start - this task has NO network. \
                 Check the Sandbox dialog for a malformed allowlist regex.".into()
            } else {
                String::new()
            },
        },
    };

    state.inner.lock().insert(
        id.clone(),
        PtySlot {
            writer,
            master,
            child_pid,
            sandbox: sandbox_bundle,
            task_id: args.task_id.clone(),
        },
    );

    // `app` was only ever used to emit the now-removed sandbox-status
    // event; keep the parameter binding alive for tauri's handler
    // signature but mark it unused.
    let _ = app;
    Ok(SpawnResult { id, sandbox: status })
}

#[tauri::command]
fn pty_write(state: State<'_, PtyManager>, pty_id: String, data: Vec<u8>) -> Result<(), String> {
    let mut map = state.inner.lock();
    if let Some(slot) = map.get_mut(&pty_id) {
        slot.writer.write_all(&data).map_err(|e| e.to_string())?;
        slot.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(
    state: State<'_, PtyManager>,
    pty_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = state.inner.lock();
    if let Some(slot) = map.get(&pty_id) {
        slot.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<'_, PtyManager>, pty_id: String) -> Result<(), String> {
    let slot = state.inner.lock().remove(&pty_id);
    if let Some(slot) = slot {
        // SIGKILL the child by raw pid (avoids deadlock with the waiter
        // thread that has the Child handle pinned in wait()).
        if let Some(pid) = slot.child_pid {
            // SAFETY: kill(2) is async-signal-safe and the pid is an i32.
            unsafe { libc::kill(pid as i32, libc::SIGKILL); }
        }
        drop(slot.writer);
        drop(slot.master);
    }
    Ok(())
}

// ───────────────────────────── project commands ─────────────────────────────

#[tauri::command]
fn projects_list() -> Vec<Project> { load_projects() }

#[tauri::command]
fn project_add(root_path: String, non_git: Option<bool>) -> Result<Project, String> {
    // Trim whitespace + expand a leading `~` — users paste paths with
    // both routinely. The naive `pb.join(".git").exists()` check we used
    // to do here missed: worktrees (`.git` is a FILE not a dir),
    // bare repos (no `.git` at all), and paths with a stray newline.
    // `git -C <path> rev-parse --git-dir` is the canonical "am I in a
    // git repo?" question and handles all three cases.
    let non_git = non_git.unwrap_or(false);
    let trimmed = root_path.trim();
    let expanded: String = if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir().map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string())
    } else { trimmed.to_string() };
    let pb = PathBuf::from(&expanded);
    if !pb.exists() {
        return Err(format!("{} does not exist", expanded));
    }
    // Non-git projects (issue #4) skip the repo check entirely — they're
    // a plain folder grouping several repos, and the only tasks they
    // spawn run an agent at the folder root (no worktree). A directory is
    // the only requirement.
    if non_git {
        if !pb.is_dir() {
            return Err(format!("{} is not a directory", expanded));
        }
    } else if git(&["rev-parse", "--git-dir"], &pb).is_err() {
        return Err(format!("{} is not a git repo. Confirm adding it as a plain folder.", expanded));
    }
    let mut list = load_projects();
    let canon = fs::canonicalize(&pb).map_err(|e| e.to_string())?;
    if list.iter().any(|p| p.root_path == canon.to_string_lossy()) {
        return Err("project already added".into());
    }
    let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string();
    // Non-git folders have no branches / remotes — leave those empty.
    let base = if non_git { String::new() } else { detect_base_branch(&canon).unwrap_or_else(|_| "main".into()) };
    let remote = if non_git { String::new() } else { detect_default_remote(&canon) };
    let ws_path = worktrees_base().map_err(|e| e.to_string())?
        .join(&name).to_string_lossy().into_owned();
    let p = Project {
        id: Uuid::new_v4().to_string(),
        name,
        root_path: canon.to_string_lossy().into_owned(),
        tasks_path: ws_path,
        // Non-git folders have no remote-tracking base ref; leave it
        // empty so nothing downstream tries to branch off "/".
        base_branch: if non_git { String::new() } else { format!("{remote}/{base}") },
        remote,
        preview_url: String::new(),
        // Seeded with the patterns 99% of repos benefit from. The user can
        // tune these in Settings → Repositories → Files to copy.
        //   .env*         — local secrets git ignores. Without these the
        //                   worktree won't run anything that hits an API.
        //   .venv         — Python venv. Copying saves ~30-60s of pip install
        //                   on each new worktree. Caveat: venvs bake the
        //                   absolute path into `bin/activate`; users with
        //                   broken activate scripts can drop this.
        //   node_modules  — npm deps. Saves multi-minute npm install. Caveat:
        //                   can be 500MB+; users with mono-repos may want to
        //                   strip this and run `npm ci` in the setup script.
        // Non-git folders copy nothing — there's no worktree to seed.
        files_to_copy: if non_git { Vec::new() } else { vec![
            ".env*".into(),
            ".venv".into(),
            "node_modules".into(),
        ] },
        setup_script: String::new(),
        run_script: String::new(),
        archive_script: String::new(),
        default_cli: "claude".into(),
        created: chrono::Utc::now().to_rfc3339(),
        // Sandbox defaults: OFF for new projects. Users opt in via
        // Settings → Repositories. When ON, the built-in RW/deny/host
        // sets in sandbox.rs already cover the common cases; the per-
        // project Vec fields are for project-specific extras.
        default_sandbox: false,
        default_sandbox_mode: None,
        sandbox_rw_paths: Vec::new(),
        sandbox_allowed_hosts: Vec::new(),
        // Default to single-repo. project_add_multi is the entry
        // point for multi-repo projects (it sets type + members).
        project_type: ProjectType::Single,
        members: Vec::new(),
        spotlight_enabled: false,
        non_git,
        // New projects start ungrouped; grouping is a sidebar action.
        group: None,
    };
    list.push(p.clone());
    save_projects(&list).map_err(|e| e.to_string())?;
    Ok(p)
}

/// Create a multi-repo project. `root_path` is the HOST repo — the
/// git repo that owns shared CLAUDE.md / AGENTS.md / .claude/skills.
/// It can be:
///   - An existing path to a real git repo (most common: the user
///     points at a knowledge repo they cloned from GitHub).
///   - Empty — Termic auto-creates `~/termic/projects/<slug>/`,
///     `git init`s it, and uses that as the host. Gives the user a
///     usable multi-repo project even when they don't have a
///     knowledge repo prepared. They can `git remote add` + push it
///     to GitHub later.
/// `name` is required (drives the host directory name in the
/// auto-create case + the project's display label). `member_ids`
/// reference already-added Termic projects.
#[tauri::command]
fn project_add_multi(root_path: String, name: String, members: Vec<ProjectMember>, non_git: Option<bool>) -> Result<Project, String> {
    let non_git = non_git.unwrap_or(false);
    let trimmed_path = root_path.trim();
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("project name is required".into());
    }
    let slug = slugify(trimmed_name);
    if slug.is_empty() {
        return Err("project name must contain at least one alphanumeric character".into());
    }

    // Resolve the host path. Two branches:
    //   - user-supplied: expand ~, require existing git repo (same
    //     validation as project_add) — unless non_git, where any
    //     existing directory is accepted (issue #4 + multi-repo).
    //   - empty: Termic auto-creates ~/termic/projects/<slug>/. For a
    //     git host it git-init's + seeds a CLAUDE.md commit; for a
    //     non-git host it just mkdir's + drops a CLAUDE.md. Refuse if
    //     it already exists (avoid clobbering a previous attempt).
    let pb: PathBuf = if trimmed_path.is_empty() {
        let projects_root = dirs::home_dir()
            .ok_or_else(|| "no home dir".to_string())?
            .join(APP_DIR).join("projects");
        fs::create_dir_all(&projects_root).map_err(|e| e.to_string())?;
        let target = projects_root.join(&slug);
        if target.exists() {
            return Err(format!(
                "{} already exists — pick a different name or remove the directory first",
                target.display()
            ));
        }
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        // Seed a stub CLAUDE.md so the host has shared knowledge the
        // agent loads. Gives the user an obvious place to start writing.
        let claude_md = format!(
            "# {}\n\nShared knowledge for the {} multi-repo project.\nThis file is loaded by every task under it.\n",
            trimmed_name, trimmed_name,
        );
        fs::write(target.join("CLAUDE.md"), claude_md).map_err(|e| e.to_string())?;
        if !non_git {
            // git init + an initial commit so worktrees can branch off
            // something. A bare init has no HEAD ref, which breaks
            // `git worktree add -b <branch>` later.
            git(&["init", "-q"], &target).map_err(|e| format!("git init failed: {e}"))?;
            let _ = git(&["symbolic-ref", "HEAD", "refs/heads/main"], &target);
            // Allow commits without configured user.* for the initial
            // bootstrap commit; -c sets the value just for this command.
            git(
                &["-c", "user.email=termic@local", "-c", "user.name=Termic",
                  "add", "CLAUDE.md"],
                &target,
            ).ok();
            git(
                &["-c", "user.email=termic@local", "-c", "user.name=Termic",
                  "commit", "-q", "-m", "init: termic multi-repo host"],
                &target,
            ).map_err(|e| format!("git commit failed: {e}"))?;
        }
        target
    } else {
        let expanded: String = if let Some(rest) = trimmed_path.strip_prefix("~/") {
            dirs::home_dir().map(|h| h.join(rest).to_string_lossy().into_owned())
                .unwrap_or_else(|| trimmed_path.to_string())
        } else { trimmed_path.to_string() };
        let pb = PathBuf::from(&expanded);
        if !pb.exists() {
            // Target dir doesn't exist yet: create it on submit instead of
            // erroring. Mirrors the empty-path auto-create — mkdir, and for
            // a git host, git init + seed a CLAUDE.md + an initial commit
            // so worktrees can branch off a real HEAD later.
            fs::create_dir_all(&pb).map_err(|e| format!("create {expanded} failed: {e}"))?;
            let claude = pb.join("CLAUDE.md");
            if !claude.exists() {
                let body = format!(
                    "# {}\n\nShared knowledge for the {} multi-repo project.\nThis file is loaded by every task under it.\n",
                    trimmed_name, trimmed_name,
                );
                fs::write(&claude, body).map_err(|e| e.to_string())?;
            }
            if !non_git {
                git(&["init", "-q"], &pb).map_err(|e| format!("git init failed: {e}"))?;
                let _ = git(&["symbolic-ref", "HEAD", "refs/heads/main"], &pb);
                git(&["-c", "user.email=termic@local", "-c", "user.name=Termic",
                      "add", "CLAUDE.md"], &pb).ok();
                git(&["-c", "user.email=termic@local", "-c", "user.name=Termic",
                      "commit", "-q", "-m", "init: termic multi-repo host"], &pb)
                    .map_err(|e| format!("git commit failed: {e}"))?;
            }
            pb
        } else {
            if non_git {
                if !pb.is_dir() {
                    return Err(format!("{} is not a directory", expanded));
                }
            } else if git(&["rev-parse", "--git-dir"], &pb).is_err() {
                return Err(format!("{} is not a git repo. Confirm using it as a plain folder host.", expanded));
            }
            pb
        }
    };

    let mut list = load_projects();
    let canon = fs::canonicalize(&pb).map_err(|e| e.to_string())?;
    if list.iter().any(|p| p.root_path == canon.to_string_lossy()) {
        return Err("a project at this path is already added".into());
    }

    // Normalize each inline member (canonicalize path, detect git, fill
    // defaults) and dedup by path. Members are self-contained — nothing is
    // registered as a standalone project.
    let host_path = canon.to_string_lossy().into_owned();
    let mut seen: HashSet<String> = HashSet::new();
    let members: Vec<ProjectMember> = members
        .into_iter()
        .map(normalize_member)
        .collect::<Result<Vec<_>, _>>()?;
    for m in &members {
        if m.root_path == host_path {
            return Err("a multi-repo project can't list its own host as a member".into());
        }
        if !seen.insert(m.root_path.clone()) {
            return Err(format!("duplicate member: {}", m.root_path));
        }
    }

    let base = if non_git { String::new() } else { detect_base_branch(&canon).unwrap_or_else(|_| "main".into()) };
    let remote = if non_git { String::new() } else { detect_default_remote(&canon) };
    let ws_path = worktrees_base().map_err(|e| e.to_string())?
        .join(&slug).to_string_lossy().into_owned();
    let name = trimmed_name.to_string();
    let p = Project {
        id: Uuid::new_v4().to_string(),
        name,
        root_path: canon.to_string_lossy().into_owned(),
        tasks_path: ws_path,
        base_branch: if non_git { String::new() } else { format!("{remote}/{base}") },
        remote,
        preview_url: String::new(),
        // No file-copy defaults for multi-repo: each member already has
        // its own copy list; the host repo is for docs/skills, not code.
        files_to_copy: Vec::new(),
        setup_script: String::new(),
        run_script: String::new(),
        archive_script: String::new(),
        default_cli: "claude".into(),
        created: chrono::Utc::now().to_rfc3339(),
        default_sandbox: false,
        default_sandbox_mode: None,
        sandbox_rw_paths: Vec::new(),
        sandbox_allowed_hosts: Vec::new(),
        project_type: ProjectType::Multi,
        members,
        spotlight_enabled: false,
        non_git,
        group: None,
    };
    list.push(p.clone());
    save_projects(&list).map_err(|e| e.to_string())?;
    Ok(p)
}

/// Edit a multi-repo project's member list (with per-member scripts)
/// post-create. Errors for single-repo projects.
#[tauri::command]
fn project_set_members(id: String, members: Vec<ProjectMember>) -> Result<(), String> {
    let mut list = load_projects();
    let host = match list.iter().find(|p| p.id == id) {
        Some(p) => p.clone(),
        None => return Err("no such project".into()),
    };
    if host.project_type != ProjectType::Multi {
        return Err("only multi-repo projects have a members list".into());
    }
    // Normalize inbound inline members + dedup by path. No project lookup —
    // members are self-contained.
    let mut seen: HashSet<String> = HashSet::new();
    let members: Vec<ProjectMember> = members
        .into_iter()
        .map(normalize_member)
        .collect::<Result<Vec<_>, _>>()?;
    for m in &members {
        if m.root_path == host.root_path {
            return Err("a multi-repo project can't list its own host as a member".into());
        }
        if !seen.insert(m.root_path.clone()) {
            return Err(format!("duplicate member: {}", m.root_path));
        }
    }
    let p = list.iter_mut().find(|p| p.id == id).unwrap();
    p.members = members;
    save_projects(&list).map_err(|e| e.to_string())
}

/// Reorder the projects list to match the supplied id sequence.
/// Any projects in storage not in `ids` get appended (preserves their
/// existing relative order) so a partial reorder request can't lose
/// data. Unknown ids are skipped. The disk order IS the render order
/// (`projects_list` returns them as-is), so this is sufficient — no
/// per-project sort_key field needed.
#[tauri::command]
fn project_reorder(ids: Vec<String>) -> Result<(), String> {
    let mut list = load_projects();
    let mut out: Vec<Project> = Vec::with_capacity(list.len());
    let mut taken: HashSet<String> = HashSet::new();
    for id in &ids {
        if let Some(idx) = list.iter().position(|p| &p.id == id) {
            out.push(list.remove(idx));
            taken.insert(id.clone());
        }
    }
    // Anything not named in `ids` gets appended in its original order.
    for p in list {
        if !taken.contains(&p.id) { out.push(p); }
    }
    save_projects(&out).map_err(|e| e.to_string())
}

/// Set / clear the UI-only sidebar group label on a batch of projects in
/// ONE atomic projects.json write. Group rename / dissolve touch every
/// member — doing this per-project from the frontend could fail halfway
/// and leave a group half-renamed on disk, and full `project_update`s
/// would clobber concurrent edits to unrelated fields.
#[tauri::command]
fn project_set_group(ids: Vec<String>, group: Option<String>) -> Result<(), String> {
    let group = group.and_then(|g| {
        let t = g.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let mut list = load_projects();
    for p in list.iter_mut() {
        if ids.contains(&p.id) {
            p.group = group.clone();
        }
    }
    save_projects(&list).map_err(|e| e.to_string())
}

#[tauri::command]
fn project_update(p: Project) -> Result<(), String> {
    let mut list = load_projects();
    if let Some(slot) = list.iter_mut().find(|x| x.id == p.id) {
        *slot = p;
        save_projects(&list).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("project not found".into())
    }
}

/// Remove a project AND archive every task under it (kills running
/// scripts, removes git worktrees, wipes the worktree dirs). Off-thread —
/// can take seconds on big repos. Tasks' JSON files are also deleted
/// so the entry disappears from disk entirely; the user's actual git repo
/// at `root_path` is NOT touched (we never own that directory).
#[tauri::command]
async fn project_remove(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tasks: Vec<Task> = load_tasks()
            .into_iter().filter(|w| w.project_id == id).collect();
        for w in tasks {
            // task_archive_sync handles SIGTERMing scripts, running the
            // archive script, removing the worktree, and saving archived=true.
            // Errors per-task are logged but don't abort — we want a
            // best-effort full cleanup even if one worktree is borked.
            if let Err(e) = task_archive_sync(w.id.clone(), false) {
                eprintln!("project_remove: archive {} failed: {}", w.id, e);
            }
            // Hard-delete the JSON so it doesn't linger as a ghost archived
            // entry pointing at a non-existent project.
            let _ = delete_task_file(&w.id);
        }
        let mut list = load_projects();
        list.retain(|p| p.id != id);
        save_projects(&list).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

// ───────────────────────────── task commands ─────────────────────────────

#[tauri::command]
fn tasks_list() -> Vec<Task> { load_tasks() }

/// Open the project's main repo checkout as a task (no git worktree).
/// Idempotent: if one already exists for this project (and isn't archived),
/// returns it; otherwise seeds a new one pointing at `project.root_path`.
/// Branch is read from `git symbolic-ref` so the UI shows whichever branch
/// the user has checked out in the actual repo.
#[tauri::command]
fn task_open_repo(
    project_id: String,
    cli: Option<String>,
    name: Option<String>,
    command: Option<String>,
    sandbox_enabled: Option<bool>,
    sandbox_mode: Option<SandboxMode>,
    sandbox_rw_paths: Option<Vec<String>>,
    sandbox_allowed_hosts: Option<Vec<String>>,
) -> Result<Task, String> {
    let proj = load_projects().into_iter().find(|p| p.id == project_id)
        .ok_or("project not found")?;
    // CLI is now explicit — frontend's "+ Open repo with <agent>" passes the
    // chosen agent id. Falls back to project default for older call sites.
    let cli = cli.unwrap_or_else(|| proj.default_cli.clone());
    let repo = PathBuf::from(&proj.root_path);
    // ALWAYS re-read current HEAD so a stale cached `branch` doesn't lie
    // (user may have `git checkout`'d a different branch outside termic
    // since the task was first opened). Non-git folders (issue #4)
    // have no branch — leave it empty, the sidebar just shows the name.
    let branch = if proj.non_git {
        String::new()
    } else {
        git(&["symbolic-ref", "--quiet", "--short", "HEAD"], &repo)
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "HEAD".to_string())
    };
    let port = 18100 + (load_tasks().len() as u16);

    // Multi-repo project opened in REPO mode: drop a symlink for
    // each member into the host's working dir so the agent at the
    // host root can navigate into them. Symlinks point at each
    // member's live checkout (no worktree — REPO mode is the
    // "everything live, no isolation" variant). Composition gets
    // frozen on the task so sandbox + archive treat the symlinks
    // as the task's responsibility. The host's .gitignore is
    // updated with a managed block so the new dirs don't show up as
    // untracked changes.
    let mut composition: Vec<TaskMember> = Vec::new();
    if proj.project_type == ProjectType::Multi {
        let host_dir = Path::new(&proj.root_path);
        let mut dir_names: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // Per-member port counter — same scheme as worktree-mode
        // multi-repo: task.port + i + 1 so members can run
        // PORT=$TERMIC_PORT npm run dev without colliding.
        let mut next_member_port = port + 1;
        for pm in &proj.members {
            let dir_name = pm.name.clone();
            if dir_name.is_empty() || dir_name.contains('/') { continue; }
            if !seen.insert(dir_name.clone()) { continue; }
            let target = host_dir.join(&dir_name);
            // If the link already exists from a previous open-repo,
            // leave it alone; if a real file/dir collides, skip with
            // a warning rather than clobbering user content.
            if target.symlink_metadata().is_ok() {
                let link_target = fs::read_link(&target).ok();
                if link_target.map(|p| p.to_string_lossy().into_owned()) != Some(pm.root_path.clone()) {
                    eprintln!("task_open_repo: {} exists and isn't our symlink; skipping {}", target.display(), pm.name);
                    continue;
                }
            } else if let Err(e) = std::os::unix::fs::symlink(&pm.root_path, &target) {
                eprintln!("task_open_repo: symlink {} failed: {e}", pm.name);
                continue;
            }
            let member_port = next_member_port;
            next_member_port = next_member_port.saturating_add(1);
            composition.push(TaskMember {
                project_id: String::new(),
                repo_path: pm.root_path.clone(),
                dir_name: dir_name.clone(),
                mode: MemberMode::RepoRoot,
                branch: String::new(),
                path: pm.root_path.clone(),
                port: member_port,
                // Scripts come from the inline member's per-project entry,
                // which may differ from the repo's standalone scripts.
                setup_script:   pm.setup_script.clone(),
                run_script:     pm.run_script.clone(),
                archive_script: pm.archive_script.clone(),
            });
            dir_names.push(dir_name);
        }
        // Don't error on gitignore write — host might be read-only or
        // the user might prefer to track these. Non-fatal.
        let _ = ensure_multirepo_gitignore(host_dir, &dir_names);
    }

    let ws_name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        // Branch is the natural fallback for a git repo; non-git folders
        // have no branch, so fall back to the project name there.
        .unwrap_or_else(|| if branch.is_empty() { proj.name.clone() } else { branch.clone() });
    // Only "custom" tasks carry a launch command; agent/shell
    // tasks resolve their command from the registry at spawn.
    let custom_command = if cli == "custom" {
        command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty())
    } else {
        None
    };
    // Sandbox: the main checkout stays UNCAGED unless the advanced New Task
    // dialog explicitly opts in. Unlike task_create we deliberately do NOT
    // fall back to the project default here, so the quick "work on my real
    // files" path (and legacy callers, which pass nothing) is never surprised
    // by a cage at first launch. When the dialog does opt in, the seatbelt +
    // proxy cage the main checkout identically to a worktree.
    let sandbox_mode = sandbox_mode
        .or_else(|| sandbox_enabled.and_then(|e| e.then_some(SandboxMode::Enforce)))
        .unwrap_or(SandboxMode::Off);
    let sandbox_enabled = sandbox_mode != SandboxMode::Off;
    let sandbox_rw_paths = sandbox_rw_paths.unwrap_or_default();
    let sandbox_allowed_hosts = sandbox_allowed_hosts.unwrap_or_default();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        project_id: proj.id.clone(),
        // Caller-supplied name (preferred — the sidebar prompts for one
        // so multiple repo-root sessions don't collide). Falls back to
        // the branch name; the "REPO ROOT" chip in the sidebar shows
        // iff name == branch, so legacy callers still see the chip.
        name: ws_name,
        branch: branch.clone(),
        base_branch: branch,
        path: proj.root_path.clone(),
        cli,
        port,
        created: chrono::Utc::now().to_rfc3339(),
        archived: false,
        is_main_checkout: true,
        spawn_count: 0,
        has_resumable_history: false,
        agent_session_ids: std::collections::HashMap::new(),
        // Off by default (see the resolution above); the advanced dialog can
        // opt a main-checkout task into a cage at create, and the shield
        // button still changes it later. Seatbelt + proxy work identically
        // against the main checkout as against a worktree.
        sandbox_enabled,
        sandbox_mode: Some(sandbox_mode),
        yolo: false,
        sandbox_rw_paths,
        sandbox_allowed_hosts,
        composition,
        custom_command,
        resume_override: None,
        persisted_tabs: Vec::new(),
        right_split_tabs: Vec::new(),
                split_layout: None,
        archived_at: None,
    };
    save_task(&task).map_err(|e| e.to_string())?;
    Ok(task)
}

// ───────────────────────── import existing worktree (issue #5) ─────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct ImportableWorktree {
    /// Absolute path git reports for the worktree.
    pub path: String,
    /// Short branch name, or empty for a detached HEAD.
    pub branch: String,
    /// Abbreviated HEAD commit (for display only).
    pub head: String,
    /// git has the worktree locked (e.g. on a removed external drive).
    pub locked: bool,
}

/// Canonicalize for set-membership comparison, falling back to the raw
/// string when the path can't be resolved (e.g. it was deleted).
fn canon_str(p: &str) -> String {
    fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
}

/// List the git worktrees of a project's repo that aren't yet tracked as
/// termic tasks (issue #5). Excludes the main checkout (that's the
/// "Run in repo" path), bare entries, and any worktree already imported.
/// Empty for non-git projects.
#[tauri::command]
fn task_importable_worktrees(project_id: String) -> Result<Vec<ImportableWorktree>, String> {
    let proj = load_projects().into_iter().find(|p| p.id == project_id)
        .ok_or("project not found")?;
    if proj.non_git { return Ok(Vec::new()); }
    let repo = PathBuf::from(&proj.root_path);
    // Drop stale registrations so we don't offer worktrees the user
    // already removed by hand.
    let _ = git(&["worktree", "prune"], &repo);
    let listed = git(&["worktree", "list", "--porcelain"], &repo).map_err(|e| e.to_string())?;

    let main_canon = canon_str(&proj.root_path);
    let existing: HashSet<String> = load_tasks().iter()
        .filter(|w| w.project_id == proj.id)
        .map(|w| canon_str(&w.path))
        .collect();

    let mut out = Vec::new();
    // Porcelain blocks are separated by a blank line. Each starts with
    // `worktree <path>` and may carry `HEAD`, `branch`, `detached`,
    // `bare`, `locked` lines.
    for block in listed.split("\n\n") {
        let mut path: Option<String> = None;
        let mut head = String::new();
        let mut branch = String::new();
        let mut bare = false;
        let mut locked = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.chars().take(8).collect();
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            } else if line == "bare" {
                bare = true;
            } else if line.starts_with("locked") {
                locked = true;
            }
        }
        let Some(path) = path else { continue };
        if bare { continue; }
        let canon = canon_str(&path);
        // Skip the main checkout + anything already imported.
        if canon == main_canon || existing.contains(&canon) { continue; }
        out.push(ImportableWorktree { path, branch, head, locked });
    }
    Ok(out)
}

/// Import an existing git worktree as a termic task (issue #5).
/// Unlike `task_create` this does NOT run `git worktree add` /
/// copy files / run setup — the worktree already exists on disk. We
/// just register a Task pointing at it. Archiving one later runs
/// the normal `git worktree remove` path (it IS a real worktree).
#[tauri::command]
fn task_import_worktree(
    project_id: String, path: String, name: Option<String>, cli: Option<String>,
    sandbox_enabled: Option<bool>,
    sandbox_mode: Option<SandboxMode>,
    sandbox_rw_paths: Option<Vec<String>>,
    sandbox_allowed_hosts: Option<Vec<String>>,
) -> Result<Task, String> {
    let proj = load_projects().into_iter().find(|p| p.id == project_id)
        .ok_or("project not found")?;
    if proj.non_git { return Err("project is not a git repo".into()); }
    let repo = PathBuf::from(&proj.root_path);
    let wt = PathBuf::from(path.trim());
    if !wt.exists() { return Err(format!("{} does not exist", wt.display())); }
    let _ = git(&["worktree", "prune"], &repo);

    // Confirm the path is genuinely a registered worktree of THIS repo —
    // never let the user point at an arbitrary directory.
    let listed = git(&["worktree", "list", "--porcelain"], &repo).map_err(|e| e.to_string())?;
    let wt_canon = canon_str(&wt.to_string_lossy());
    let registered = listed.lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(|p| canon_str(p) == wt_canon);
    if !registered {
        return Err("that path is not a worktree of this repo".into());
    }
    // The main checkout is reachable via "Run in repo", not import.
    if wt_canon == canon_str(&proj.root_path) {
        return Err("that's the repo's main checkout — use \"Run in repo\" instead".into());
    }
    if load_tasks().iter().any(|w| canon_str(&w.path) == wt_canon) {
        return Err("this worktree is already open as a task".into());
    }

    let branch = git(&["symbolic-ref", "--quiet", "--short", "HEAD"], &wt)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let cli = cli.unwrap_or_else(|| proj.default_cli.clone());
    let port = 18100 + (load_tasks().len() as u16);
    let ws_name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| if branch.is_empty() {
            wt.file_name().and_then(|s| s.to_str()).unwrap_or("worktree").to_string()
        } else { branch.clone() });

    // Sandbox: honor the dialog's explicit choice when provided, else
    // fall back to the project default + the merged default lists (same
    // shape as task_create).
    let globals = load_settings_inner();
    let merge = |g: &[String], p: &[String]| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for v in g.iter().chain(p.iter()) {
            if seen.insert(v.clone()) { out.push(v.clone()); }
        }
        out
    };
    let sandbox_enabled = sandbox_enabled.unwrap_or(
        proj.default_sandbox || repo_config_for(&proj).sandbox.enabled_by_default,
    );
    let sandbox_mode = sandbox_mode.or(proj.default_sandbox_mode)
        .unwrap_or(if sandbox_enabled { SandboxMode::Enforce } else { SandboxMode::Off });
    let sandbox_enabled = sandbox_mode != SandboxMode::Off;
    let sandbox_rw_paths = sandbox_rw_paths
        .unwrap_or_else(|| merge(&globals.sandbox_default_rw_paths, &proj.sandbox_rw_paths));
    let sandbox_allowed_hosts = sandbox_allowed_hosts
        .unwrap_or_else(|| merge(&globals.sandbox_default_allowed_hosts, &proj.sandbox_allowed_hosts));

    let task = Task {
        id: Uuid::new_v4().to_string(),
        project_id: proj.id.clone(),
        name: ws_name,
        branch: branch.clone(),
        // We don't know the original base ref; the branch itself is a
        // sane stand-in (only used to seed "branch from" + display).
        base_branch: branch,
        path: wt_canon,
        cli,
        port,
        created: chrono::Utc::now().to_rfc3339(),
        archived: false,
        // A real worktree — NOT repo-root, so archive removes it properly.
        is_main_checkout: false,
        spawn_count: 0,
        has_resumable_history: false,
        agent_session_ids: std::collections::HashMap::new(),
        sandbox_enabled,
        sandbox_mode: Some(sandbox_mode),
        yolo: false,
        sandbox_rw_paths,
        sandbox_allowed_hosts,
        composition: Vec::new(),
        custom_command: None,
        resume_override: None,
        persisted_tabs: Vec::new(),
        right_split_tabs: Vec::new(),
                split_layout: None,
        archived_at: None,
    };
    save_task(&task).map_err(|e| e.to_string())?;
    Ok(task)
}

/// Create a new task (git worktree + file copy + optional streaming
/// setup script). MUST stay off the IPC handler thread — `git worktree add`
/// + the `files_to_copy` glob copy can take 1-2s on a chunky repo and that
/// blocks the WKWebView event loop in dev, freezing the UI right before the
/// progress modal opens (the user's exact complaint). See the
/// "Long-running IPC discipline" section in CLAUDE.md.
#[tauri::command]
async fn task_create(args: CreateTaskArgs) -> Result<Task, String> {
    tauri::async_runtime::spawn_blocking(move || task_create_sync(args))
        .await
        .map_err(|e| e.to_string())?
}

fn task_create_sync(args: CreateTaskArgs) -> Result<Task, String> {
    let projects = load_projects();
    let proj = projects.iter().find(|p| p.id == args.project_id)
        .ok_or("project not found")?.clone();
    let repo = PathBuf::from(&proj.root_path);

    let slug = slugify(&args.name);
    // CRITICAL guard: a name that is all punctuation/whitespace slugifies to
    // "". `wt_root.join("")` == `wt_root`, which `.exists()` reports true, so
    // the orphan-cleanup `remove_dir_all` below would delete the ENTIRE tasks
    // root (every other worktree in the project). Never let an empty slug
    // reach the worktree path math. The frontend also validates, but this is
    // the last line of defense for any caller.
    if slug.is_empty() {
        return Err("Task name must contain at least one letter or number.".into());
    }
    let branch = args.branch
        .as_ref()
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .map(|b| b.to_string())
        .unwrap_or_else(|| slug.clone());

    // Determine "branch new from" — strip the remote prefix if needed for create.
    let base_full = args.base_branch.unwrap_or_else(|| proj.base_branch.clone());
    // git can branch off "origin/master" directly

    let wt_root = PathBuf::from(&proj.tasks_path);
    fs::create_dir_all(&wt_root).map_err(|e| e.to_string())?;
    let wt_path = wt_root.join(&slug);

    // Clean stale worktree metadata (refs to dirs the user removed manually,
    // or leftovers from a previous failed create) so `git worktree add` has
    // a clean slate.
    let _ = git(&["worktree", "prune"], &repo);

    if wt_path.exists() {
        // Is this an actively-registered worktree, or an orphan directory
        // from a prior failed create? If orphan, nuke it and continue.
        let listed = git(&["worktree", "list", "--porcelain"], &repo).unwrap_or_default();
        let path_str = wt_path.to_string_lossy();
        let registered = listed.lines().any(|l| {
            l.strip_prefix("worktree ").map(|p| p == path_str).unwrap_or(false)
        });
        if registered {
            return Err(format!(
                "a worktree already lives at {} — pick a different name.",
                wt_path.display()
            ));
        }
        fs::remove_dir_all(&wt_path).map_err(|e|
            format!("orphan directory at {} couldn't be removed: {}", wt_path.display(), e))?;
    }

    // Reuse existing branch if present, else create new from base. If the
    // branch is already checked out in another worktree (often the main
    // checkout), git refuses — fall back to checking out the branch
    // detached so the new worktree still works.
    //
    // `--no-track` is critical: creating a new branch directly from a
    // remote-tracking base (e.g. "origin/main") would otherwise set
    // the new branch's upstream to origin/main. Later, when the user
    // deletes the worktree branch with `git branch -D`, git's tooling
    // sometimes offers / prompts to also delete the upstream — wiping
    // a shared remote branch. Decoupling tracking up-front avoids
    // that footgun. We create the branch in two steps so the
    // `--no-track` flag applies cleanly (worktree add -b doesn't
    // surface a `--no-track` of its own).
    // git-crypt detection: if the source repo has `.git/git-crypt/`,
    // a normal worktree-add's checkout will fail because the smudge
    // filter looks for the key under the new per-worktree gitdir
    // (which doesn't exist there). Two-step: --no-checkout, symlink
    // the key dir from the common gitdir into the new worktree's
    // gitdir, then `git checkout -- .` re-runs the smudge with the
    // key now reachable.
    let common_gitdir = git(&["rev-parse", "--git-common-dir"], &repo)
        .ok()
        .map(|s| s.trim().to_string())
        .map(|s| {
            let p = PathBuf::from(&s);
            if p.is_absolute() { p } else { repo.join(p) }
        });
    let has_git_crypt = common_gitdir
        .as_ref()
        .map(|p| p.join("git-crypt").exists())
        .unwrap_or(false);

    let branch_exists = git(&["rev-parse", "--verify", &branch], &repo).is_ok();
    let wt_arg = wt_path.to_str().unwrap();
    let add_args: Vec<&str> = if has_git_crypt {
        // Skip checkout; we'll run it manually after symlinking the
        // git-crypt key dir into the per-worktree gitdir below.
        vec!["worktree", "add", "--no-checkout", wt_arg, &branch]
    } else {
        vec!["worktree", "add", wt_arg, &branch]
    };
    let add_result = if branch_exists {
        git(&add_args, &repo)
    } else {
        // Refresh the remote-tracking base ref first so the new branch is cut
        // from the latest remote commit, not a stale local origin/* (GH #79).
        // Best-effort and time-bounded — see git_fetch_base.
        if fetch_before_create_enabled() {
            git_fetch_base(&repo, &base_full);
        }
        match git(&["branch", "--no-track", &branch, &base_full], &repo) {
            Ok(_) => git(&add_args, &repo),
            Err(e) => Err(e),
        }
    };
    if let Err(e) = add_result {
        if e.to_string().contains("already used by worktree") {
            return Err(format!(
                "branch '{}' is already checked out elsewhere. Pick a different task name.",
                branch
            ));
        }
        return Err(e.to_string());
    }

    // git-crypt: bridge the key dir from the common .git into the new
    // worktree's per-worktree gitdir, then run a full checkout so the
    // smudge filter has the key available. The symlink is critical
    // because git-crypt's smudge looks under $GIT_DIR/git-crypt — for
    // a worktree, $GIT_DIR is the per-worktree dir, not the common
    // one. If anything here fails, we leave the half-checked-out
    // worktree in place and bubble up a useful error.
    if has_git_crypt {
        // Per-worktree gitdir = <common>/worktrees/<slug>. Resolve via
        // `git -C <new-worktree> rev-parse --git-dir` to be robust.
        let wt_gitdir_raw = git(&["rev-parse", "--git-dir"], &wt_path)
            .map_err(|e| format!("git-crypt setup: couldn't resolve worktree gitdir: {e}"))?;
        let wt_gitdir = {
            let p = PathBuf::from(wt_gitdir_raw.trim());
            if p.is_absolute() { p } else { wt_path.join(p) }
        };
        let key_target = common_gitdir.as_ref().unwrap().join("git-crypt");
        let key_link = wt_gitdir.join("git-crypt");
        if !key_link.exists() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(&key_target, &key_link)
                .map_err(|e| format!("git-crypt setup: symlink {} → {} failed: {e}",
                    key_link.display(), key_target.display()))?;
        }
        // Populate the worktree. `--no-checkout` left the index empty
        // (and the working tree empty too), so `checkout -- .` has
        // nothing to match. `reset --hard HEAD` is the canonical way
        // to fill index + working tree from HEAD; the smudge filter
        // runs during the working-tree write and can now find the
        // git-crypt key via the symlink. Safe here because the
        // worktree is brand new — there's nothing to overwrite.
        git(&["reset", "--hard", "HEAD"], &wt_path)
            .map_err(|e| format!("git-crypt setup: post-symlink checkout failed: {e}"))?;
    }

    // Copy files_to_copy (glob patterns relative to repo root) —
    // the repo's `.termic.yaml` list merged with the project override.
    for pat in &effective_files_to_copy(&proj) {
        copy_matching(&repo, &wt_path, pat);
    }

    // Allocate port (18100 + index).
    let port = 18100 + (load_tasks().len() as u16);

    let cli = args.cli.unwrap_or_else(|| proj.default_cli.clone());
    // Only "custom" tasks carry a pre-set launch command; agent/shell tasks
    // resolve their command from the registry at spawn. Mirrors task_open_repo.
    let custom_command = if cli == "custom" {
        args.custom_command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty())
    } else {
        None
    };
    // Use the client-supplied ID if present so the frontend can listen on
    // `setup-{output,done}://<id>` BEFORE invoking — eliminates the
    // empty-script race that made the "Running setup script…" spinner hang.
    // Resolve sandbox pin: explicit arg wins; otherwise project default.
    // This is the ONLY place sandbox_enabled gets written. No setter
    // anywhere - by design.
    // `.termic.yaml`'s committed `sandbox.enabled_by_default` is a
    // team-shared default; the project's local `default_sandbox`
    // (projects.json) is the personal one. Either flips it on.
    let sandbox_enabled = args.sandbox_enabled.unwrap_or(
        proj.default_sandbox || repo_config_for(&proj).sandbox.enabled_by_default,
    );
    let sandbox_mode = args.sandbox_mode.or(proj.default_sandbox_mode)
        .unwrap_or(if sandbox_enabled { SandboxMode::Enforce } else { SandboxMode::Off });
    let sandbox_enabled = sandbox_mode != SandboxMode::Off;
    // Sandbox lists are frozen at creation. The dialog seeds them
    // from the project's defaults (the user may have added/removed
    // before clicking Create); whatever it sends is what we store.
    // If the dialog sends None we fall back to the project's
    // defaults verbatim - same effective outcome.
    // Task inherits the union of GLOBAL defaults (Settings →
    // General) and the PROJECT's per-repo defaults. The dialog
    // already merges these for the user, so when args.x is Some we
    // honor it verbatim; when it's None (older callers / non-UI
    // entry points) we still get the merged set.
    let globals = load_settings_inner();
    let merge = |g: &[String], p: &[String]| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for v in g.iter().chain(p.iter()) {
            if seen.insert(v.clone()) { out.push(v.clone()); }
        }
        out
    };
    let sandbox_rw_paths = args.sandbox_rw_paths
        .unwrap_or_else(|| merge(&globals.sandbox_default_rw_paths, &proj.sandbox_rw_paths));
    let sandbox_allowed_hosts = args.sandbox_allowed_hosts
        .unwrap_or_else(|| merge(&globals.sandbox_default_allowed_hosts, &proj.sandbox_allowed_hosts));
    let task = Task {
        id: args.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        project_id: proj.id.clone(),
        name: args.name,
        branch,
        base_branch: base_full,
        path: wt_path.to_string_lossy().into_owned(),
        cli,
        port,
        created: chrono::Utc::now().to_rfc3339(),
        archived: false,
        is_main_checkout: false,
        spawn_count: 0,
        has_resumable_history: false,
        agent_session_ids: std::collections::HashMap::new(),
        sandbox_enabled,
        sandbox_mode: Some(sandbox_mode),
        yolo: false,
        sandbox_rw_paths,
        sandbox_allowed_hosts,
        // Single-project tasks leave composition empty. Multi-
        // repo task creation runs through a separate code path
        // (task_create_multi) that populates this and re-uses
        // the same Task + sandbox plumbing.
        composition: Vec::new(),
        // Set only for `cli == "custom"` worktree tasks (quick "Custom
        // command" in worktree mode); None for agent / shell worktrees.
        custom_command,
        resume_override: None,
        persisted_tabs: Vec::new(),
        right_split_tabs: Vec::new(),
                split_layout: None,
        archived_at: None,
    };
    save_task(&task).map_err(|e| e.to_string())?;

    // Setup no longer runs here. It used to fire in a background thread and
    // stream to the New Task dialog via setup-output/setup-done, which the
    // dialog blocked on before opening the task. Now the dialog opens the
    // task immediately and the FRONTEND launches setup as an unfocused
    // background tab (launchSetupTab in runTabs.ts), reusing the same
    // task_run_script_stream PTY path the "Run setup" menu action uses.
    // This also means the agent gets keyboard focus right away instead of
    // setup.

    Ok(task)
}

// ───────────────────────── multi-repo task ─────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateMultiArgs {
    pub project_id: String,
    pub name: String,
    pub cli: Option<String>,
    /// Branch to create on the HOST repo (the multi-repo project's
    /// own repo, where CLAUDE.md / AGENTS.md / .claude/ live).
    pub branch: Option<String>,
    /// Base ref to branch from on the host. Default = host's
    /// `base_branch`.
    pub base_branch: Option<String>,
    /// Per-member spec, frozen onto the Task.composition.
    pub members: Vec<CreateMultiMember>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub sandbox_enabled: Option<bool>,
    #[serde(default)]
    pub sandbox_mode: Option<SandboxMode>,
    #[serde(default)]
    pub sandbox_rw_paths: Option<Vec<String>>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateMultiMember {
    /// Canonical path of the host member this per-task spec applies
    /// to — matches an entry in `Project.members[].root_path`.
    pub root_path: String,
    /// Dir name inside the wrapper. Defaults to the member's `name` —
    /// pinned at create time so renames don't break the task layout.
    pub dir_name: Option<String>,
    pub mode: MemberMode,
    /// Worktree mode only. Defaults to `branch` from CreateMultiArgs
    /// (i.e. all members branch off the same name).
    pub branch: Option<String>,
    /// Worktree mode only. Defaults to the member's `base_branch`.
    pub base_branch: Option<String>,
}

/// Create a task under a multi-repo project. Builds:
///   - the host worktree at `<tasks>/<host-slug>/<wsname>/`,
///   - each member worktree'd or symlinked into a named subdir,
///   - a Termic-managed `.gitignore` block in the host worktree
///     pinning the member dir names so they're not auto-staged.
///
/// All operations are best-effort cleanup on error: a failed member
/// rolls back what's been created so far before returning.
#[tauri::command]
async fn task_create_multi(app: AppHandle, args: CreateMultiArgs) -> Result<Task, String> {
    tauri::async_runtime::spawn_blocking(move || task_create_multi_sync(app, args))
        .await
        .map_err(|e| e.to_string())?
}

fn task_create_multi_sync(app: AppHandle, args: CreateMultiArgs) -> Result<Task, String> {
    let projects = load_projects();
    let host = projects.iter().find(|p| p.id == args.project_id)
        .ok_or("host project not found")?.clone();
    if host.project_type != ProjectType::Multi {
        return Err("task_create_multi requires a multi-repo project".into());
    }

    let slug = slugify(&args.name);
    // Same empty-slug guard as task_create_sync: an all-punctuation name
    // slugs to "" and `tasks_root.join("")` == `tasks_root`. Multi errors on
    // the `wrapper.exists()` check rather than deleting, but reject it up
    // front for a clear message instead of "a task already exists at <root>".
    if slug.is_empty() {
        return Err("Task name must contain at least one letter or number.".into());
    }
    let branch = args.branch
        .as_ref().map(|b| b.trim()).filter(|b| !b.is_empty())
        .map(|b| b.to_string()).unwrap_or_else(|| slug.clone());
    let base_branch = args.base_branch
        .as_ref().map(|b| b.trim()).filter(|b| !b.is_empty())
        .map(|b| b.to_string()).unwrap_or_else(|| host.base_branch.clone());
    // Read the pre-create fetch toggle once (GH #79); reused for host + members.
    let do_fetch = fetch_before_create_enabled();

    // Validate members + freeze dir names. dir_name collisions inside
    // the wrapper are a hard error — they'd silently overwrite. Each
    // per-task spec resolves to an inline host member by path.
    let mut frozen: Vec<(ProjectMember, CreateMultiMember, String)> = Vec::new();
    let mut seen_dirs: HashSet<String> = HashSet::new();
    for m in &args.members {
        let hm = host.members.iter().find(|hm| hm.root_path == m.root_path)
            .ok_or_else(|| format!("member not found: {}", m.root_path))?.clone();
        let dir_name = m.dir_name.clone().unwrap_or_else(|| hm.name.clone());
        // Reject path separators, empty, and the `.`/`..` traversal names.
        // `wrapper.join("..")` would escape the wrapper; today that self-
        // defends (the parent exists + is non-empty, so symlink/worktree-add
        // fail and roll back), but reject it up front as defense-in-depth so
        // no archive/teardown path can ever operate on `..`.
        if dir_name.contains('/') || dir_name.is_empty() || dir_name == "." || dir_name == ".." {
            return Err(format!("invalid member dir name: {dir_name:?}"));
        }
        if !seen_dirs.insert(dir_name.clone()) {
            return Err(format!("duplicate member dir name: {dir_name}"));
        }
        frozen.push((hm, m.clone(), dir_name));
    }

    // Wrapper dir = `<tasks_root>/<host-slug>/<wsname>/`. The
    // host's existing tasks_path already encodes that pattern.
    let wrapper = PathBuf::from(&host.tasks_path).join(&slug);
    if wrapper.exists() {
        return Err(format!("a task already exists at {}", wrapper.display()));
    }

    // Ensure the parent dir exists; git worktree add will create the
    // wrapper itself.
    if let Some(parent) = wrapper.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let host_repo = PathBuf::from(&host.root_path);
    if host.non_git {
        // Non-git host (issue #4): there's no worktree to add. Make the
        // wrapper dir ourselves, then symlink the host's shared knowledge
        // files (CLAUDE.md / AGENTS.md / .claude / …) into it so the
        // agent running at the wrapper loads them, exactly as it would
        // from a git host worktree. Members get worktree'd / symlinked
        // into the wrapper below, same as the git path.
        fs::create_dir_all(&wrapper).map_err(|e| format!("create wrapper dir failed: {e}"))?;
        for shared in &["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".gemini", ".codex"] {
            let src = host_repo.join(shared);
            if src.exists() {
                let dst = wrapper.join(shared);
                if !dst.exists() {
                    let _ = std::os::unix::fs::symlink(&src, &dst);
                }
            }
        }
    } else {
        // Create the host worktree first. Branch reuse logic mirrors the
        // single-repo create: if branch exists locally, just check out;
        // else create from base.
        // --no-track when creating from a remote ref so the new branch
        // isn't tied to origin/main as its upstream. See the single-repo
        // create site for the rationale.
        let branch_exists = git(&["rev-parse", "--verify", &branch], &host_repo).is_ok();
        let create_result = if branch_exists {
            git(&["worktree", "add", wrapper.to_str().unwrap(), &branch], &host_repo)
        } else {
            // Refresh the base ref before cutting the host branch (GH #79).
            if do_fetch {
                git_fetch_base(&host_repo, &base_branch);
            }
            match git(&["branch", "--no-track", &branch, &base_branch], &host_repo) {
                Ok(_) => git(&["worktree", "add", wrapper.to_str().unwrap(), &branch], &host_repo),
                Err(e) => Err(e),
            }
        };
        if let Err(e) = create_result {
            return Err(format!("host worktree add failed: {e}"));
        }
    }

    // Helper that tears down everything we've created so far on
    // failure. Order: members first (so the host worktree git still
    // knows about them), then the host. Best-effort.
    let rollback = |members_done: &[(ProjectMember, CreateMultiMember, String, MemberMode, String)]| {
        for (mp, _, _, mode, path) in members_done {
            match mode {
                MemberMode::RepoRoot => {
                    let _ = fs::remove_file(path);
                }
                MemberMode::Worktree => {
                    let _ = git(&["worktree", "remove", "--force", path], Path::new(&mp.root_path));
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
        // Non-git host has no host worktree to unregister — just drop the dir.
        if !host.non_git {
            let _ = git(&["worktree", "remove", "--force", wrapper.to_str().unwrap()], &host_repo);
        }
        let _ = fs::remove_dir_all(&wrapper);
    };

    // Now create each member. members_done accumulates so rollback
    // can unwind a partial composition.
    let mut composition: Vec<TaskMember> = Vec::new();
    let mut done: Vec<(ProjectMember, CreateMultiMember, String, MemberMode, String)> = Vec::new();
    // Per-member port counter — each member gets task.port+i+1
    // so two members running PORT=$TERMIC_PORT npm run dev don't
    // collide. We bumped 'port' below already by load_tasks().len()
    // for the task itself; members live in the gap above it.
    let ws_port = 18100 + (load_tasks().len() as u16);
    let mut next_member_port = ws_port + 1;
    for (mp, spec, dir_name) in frozen.into_iter() {
        let member_port = next_member_port;
        next_member_port = next_member_port.saturating_add(1);
        let target = wrapper.join(&dir_name);
        match spec.mode {
            MemberMode::RepoRoot => {
                if let Err(e) = std::os::unix::fs::symlink(&mp.root_path, &target) {
                    rollback(&done);
                    return Err(format!("symlink {dir_name}: {e}"));
                }
                // Scripts come from the inline member's own per-project
                // spec (the multi-repo project's member entry), the
                // "different commands per multi-repo project" model.
                composition.push(TaskMember {
                    project_id: String::new(),
                    repo_path: mp.root_path.clone(),
                    dir_name: dir_name.clone(),
                    mode: MemberMode::RepoRoot,
                    branch: String::new(),
                    path: mp.root_path.clone(),
                    port: member_port,
                    setup_script:   mp.setup_script.clone(),
                    run_script:     mp.run_script.clone(),
                    archive_script: mp.archive_script.clone(),
                });
                done.push((mp.clone(), spec, dir_name, MemberMode::RepoRoot, target.to_string_lossy().into_owned()));
            }
            MemberMode::Worktree => {
                let mbranch = spec.branch.clone()
                    .map(|b| b.trim().to_string()).filter(|b| !b.is_empty())
                    .unwrap_or_else(|| branch.clone());
                let mbase = spec.base_branch.clone()
                    .map(|b| b.trim().to_string()).filter(|b| !b.is_empty())
                    .unwrap_or_else(|| mp.base_branch.clone());
                let mrepo = PathBuf::from(&mp.root_path);
                // --no-track when creating from origin/* base — see
                // single-repo create site for the rationale (deleting
                // the worktree's branch later shouldn't risk wiping
                // the remote upstream).
                let mexists = git(&["rev-parse", "--verify", &mbranch], &mrepo).is_ok();
                let mres = if mexists {
                    git(&["worktree", "add", target.to_str().unwrap(), &mbranch], &mrepo)
                } else {
                    // Refresh this member's base ref before cutting its branch,
                    // honoring the member's own remote/base (GH #79).
                    if do_fetch {
                        git_fetch_base(&mrepo, &mbase);
                    }
                    match git(&["branch", "--no-track", &mbranch, &mbase], &mrepo) {
                        Ok(_) => git(&["worktree", "add", target.to_str().unwrap(), &mbranch], &mrepo),
                        Err(e) => Err(e),
                    }
                };
                if let Err(e) = mres {
                    rollback(&done);
                    return Err(format!("member {dir_name} worktree add failed: {e}"));
                }
                composition.push(TaskMember {
                    project_id: String::new(),
                    repo_path: mp.root_path.clone(),
                    dir_name: dir_name.clone(),
                    mode: MemberMode::Worktree,
                    branch: mbranch,
                    path: target.to_string_lossy().into_owned(),
                    port: member_port,
                    setup_script:   mp.setup_script.clone(),
                    run_script:     mp.run_script.clone(),
                    archive_script: mp.archive_script.clone(),
                });
                done.push((mp.clone(), spec, dir_name, MemberMode::Worktree, target.to_string_lossy().into_owned()));
            }
        }
    }

    // Manage the wrapper's .gitignore so the host repo doesn't try
    // to track the member dirs. Leading-slash entries anchor to the
    // wrapper root only. Skipped for a non-git host — the wrapper isn't
    // a git repo, so there's nothing to ignore (and no commit to make).
    let dir_names: Vec<String> = composition.iter().map(|m| m.dir_name.clone()).collect();
    if !host.non_git {
        if let Err(e) = ensure_multirepo_gitignore(&wrapper, &dir_names) {
            eprintln!("multi-repo gitignore write failed (non-fatal): {e}");
        }
    }

    // Auto-commit the wrapper's bookkeeping files (CLAUDE.md /
    // AGENTS.md / .gitignore / agent dirs) so they don't show up as
    // ?? noise in the Changes view. The user is here to work on
    // member code, not stare at config files Termic itself dropped.
    // Best-effort — non-fatal if `git add` finds nothing to add or
    // the commit fails (e.g. no user.email globally configured;
    // -c overrides handle that path).
    // Non-git host wrapper is not a git repo — nothing to commit.
    if !host.non_git {
        let bookkeeping = ["CLAUDE.md", "AGENTS.md", ".gitignore", ".claude", ".gemini", ".codex"];
        let mut to_add: Vec<&str> = Vec::new();
        for f in &bookkeeping {
            if wrapper.join(f).exists() { to_add.push(*f); }
        }
        if !to_add.is_empty() {
            let mut add_args: Vec<&str> = vec!["add", "--"];
            add_args.extend(&to_add);
            let _ = git(&add_args, &wrapper);
            let _ = git(
                &["-c", "user.email=termic@local", "-c", "user.name=Termic",
                  "commit", "-q", "-m", "termic: task bookkeeping"],
                &wrapper,
            );
        }
    }

    // Sandbox: same union/merge logic as single-repo create, but the
    // base set unions across every member project too.
    let globals = load_settings_inner();
    let sandbox_enabled = args.sandbox_enabled.unwrap_or(host.default_sandbox);
    let sandbox_mode = args.sandbox_mode.or(host.default_sandbox_mode)
        .unwrap_or(if sandbox_enabled { SandboxMode::Enforce } else { SandboxMode::Off });
    let sandbox_enabled = sandbox_mode != SandboxMode::Off;
    let mut base_rw: Vec<String> = Vec::new();
    let mut base_hosts: Vec<String> = Vec::new();
    let extend_unique = |target: &mut Vec<String>, src: &[String]| {
        for v in src {
            if !target.contains(v) { target.push(v.clone()); }
        }
    };
    extend_unique(&mut base_rw,    &globals.sandbox_default_rw_paths);
    extend_unique(&mut base_hosts, &globals.sandbox_default_allowed_hosts);
    extend_unique(&mut base_rw,    &host.sandbox_rw_paths);
    extend_unique(&mut base_hosts, &host.sandbox_allowed_hosts);
    // Union each member's own sandbox lists (carried inline on the member).
    for hm in &host.members {
        extend_unique(&mut base_rw,    &hm.sandbox_rw_paths);
        extend_unique(&mut base_hosts, &hm.sandbox_allowed_hosts);
    }
    let sandbox_rw_paths    = args.sandbox_rw_paths.unwrap_or(base_rw);
    let sandbox_allowed_hosts = args.sandbox_allowed_hosts.unwrap_or(base_hosts);

    let cli = args.cli.unwrap_or_else(|| host.default_cli.clone());
    let port = 18100 + (load_tasks().len() as u16);
    let task = Task {
        id: args.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        project_id: host.id.clone(),
        name: args.name,
        branch,
        base_branch,
        path: wrapper.to_string_lossy().into_owned(),
        cli,
        port,
        created: chrono::Utc::now().to_rfc3339(),
        archived: false,
        is_main_checkout: false,
        spawn_count: 0,
        has_resumable_history: false,
        agent_session_ids: std::collections::HashMap::new(),
        sandbox_enabled,
        sandbox_mode: Some(sandbox_mode),
        yolo: false,
        sandbox_rw_paths,
        sandbox_allowed_hosts,
        composition,
        custom_command: None,
        resume_override: None,
        persisted_tabs: Vec::new(),
        right_split_tabs: Vec::new(),
                split_layout: None,
        archived_at: None,
    };
    save_task(&task).map_err(|e| e.to_string())?;

    // Streamed setup: host's project.setup_script (cwd=wrapper)
    // first, then each member's setup_script (cwd=member.path) in
    // declared order. All lines emit on setup-output://<wsId> with
    // a `[name] ` prefix so the dialog UI can render them inline
    // without us inventing a multi-channel event topic. setup-done
    // fires once with the aggregate success at the very end.
    // Multi-repo: ONLY members have scripts. The host is a wrapper
    // dir for CLAUDE.md / AGENTS.md / .claude/, never something the
    // user wants to "run" — so we don't even peek at host.setup_script
    // here. (Single-repo task_create_sync handles its own.)
    // Tuple shape: (dir_name, script, cwd, port). Per-member port
    // so setup scripts that listen (rare but possible — e.g. setup
    // boots a docker compose stack on $TERMIC_PORT) don't collide
    // across siblings. Legacy tasks (port == 0) get the same
    // task.port + i + 1 scheme retroactively.
    let member_setups: Vec<(String, String, std::path::PathBuf, u16)> = task.composition.iter()
        .enumerate()
        .filter_map(|(idx, m)| {
            // Per-member override wins; otherwise fall back to the member's
            // committed `.termic.yaml` setup, mirroring the run-script
            // resolution (resolveRunTargets). Without this, a member whose
            // scripts live in `.termic.yaml` (not a manual override) silently
            // skipped setup in a multi-repo task.
            let script = member_effective_script(m, |s| s.setup.clone(), &m.setup_script);
            if script.trim().is_empty() { None } else {
                let p = if m.port == 0 { task.port.saturating_add(idx as u16 + 1) } else { m.port };
                Some((m.dir_name.clone(), script, std::path::PathBuf::from(&m.path), p))
            }
        })
        .collect();
    // Sibling port discovery for setup scripts (same scheme as
    // task_run_script_stream). TERMIC_PORT_<DIR> for every
    // member so a setup script that needs to know e.g. the API's
    // port can read it.
    let sibling_ports: Vec<(String, u16)> = task.composition.iter().enumerate()
        .map(|(i, m)| {
            let p = if m.port == 0 { task.port.saturating_add(i as u16 + 1) } else { m.port };
            let sanitized: String = m.dir_name.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                .collect();
            (format!("TERMIC_PORT_{sanitized}"), p)
        })
        .collect();
    if member_setups.is_empty() {
        let _ = app.emit(&format!("setup-done://{}", task.id),
            serde_json::json!({ "code": 0, "success": true }));
    } else {
        let app2 = app.clone();
        let ws_id = task.id.clone();
        let name = task.name.clone();
        thread::spawn(move || {
            let run_one = |label: &str, script: &str, cwd: &Path, port: u16| -> bool {
                use std::io::{BufRead, BufReader};
                use std::process::Stdio;
                let _ = app2.emit(&format!("setup-output://{}", ws_id),
                    serde_json::json!({ "line": format!("[{label}] $ {script}") }));
                let mut cmd = Command::new("bash");
                cmd.arg("-lc").arg(script).current_dir(cwd)
                    // Real login-shell env so setup finds bun/nvm/etc. and
                    // sees the user's $EDITOR; `bash -l` alone misses what the
                    // user set in their actual shell (fish/zsh rc) (#16, #17).
                    .env("PATH", shell_env::resolved_path())
                    .env("TERMIC_PORT", port.to_string())
                    .env("TERMIC_WORKSPACE_NAME", &name)
                    .env("TERMIC_TASK", &name)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
                for (k, v) in shell_env::login_env() {
                    cmd.env(k, v);
                }
                for (k, v) in &sibling_ports {
                    cmd.env(k, v.to_string());
                }
                let spawn_res = cmd.spawn();
                let mut child = match spawn_res {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = app2.emit(&format!("setup-output://{}", ws_id),
                            serde_json::json!({ "line": format!("[{label}] spawn error: {e}") }));
                        return false;
                    }
                };
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let app_o = app2.clone(); let id_o = ws_id.clone(); let l_o = label.to_string();
                let t_out = stdout.map(|s| thread::spawn(move || {
                    for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                        let _ = app_o.emit(&format!("setup-output://{id_o}"),
                            serde_json::json!({ "line": format!("[{l_o}] {line}") }));
                    }
                }));
                let app_e = app2.clone(); let id_e = ws_id.clone(); let l_e = label.to_string();
                let t_err = stderr.map(|s| thread::spawn(move || {
                    for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                        let _ = app_e.emit(&format!("setup-output://{id_e}"),
                            serde_json::json!({ "line": format!("[{l_e}] {line}") }));
                    }
                }));
                let status = child.wait();
                if let Some(t) = t_out { let _ = t.join(); }
                if let Some(t) = t_err { let _ = t.join(); }
                status.map(|s| s.success()).unwrap_or(false)
            };

            let mut ok = true;
            for (label, script, cwd, port) in &member_setups {
                if !ok { break; }
                if !run_one(label, script, cwd, *port) { ok = false; }
            }
            let _ = app2.emit(&format!("setup-done://{}", ws_id),
                serde_json::json!({ "code": if ok { 0 } else { 1 }, "success": ok }));
        });
    }

    Ok(task)
}

/// Rewrite (or insert) a fenced Termic-managed block at the bottom of
/// `<wrapper>/.gitignore` so the host repo ignores each member dir.
/// Leading-`/` form anchors each entry to the wrapper root, so a
/// nested `backend/` inside `.claude/skills/backend/` stays tracked.
/// User content outside the fence is preserved untouched.
fn ensure_multirepo_gitignore(wrapper: &Path, member_dirs: &[String]) -> std::io::Result<()> {
    const BEGIN: &str = "# ── termic: multi-repo member dirs (managed) ──";
    const END:   &str = "# ── /termic ──";
    let path = wrapper.join(".gitignore");
    let prior = fs::read_to_string(&path).unwrap_or_default();
    // Strip any existing managed block first (idempotent on re-runs).
    let stripped: String = {
        let mut out: Vec<&str> = Vec::new();
        let mut skip = false;
        for line in prior.lines() {
            if line.trim() == BEGIN { skip = true; continue; }
            if line.trim() == END   { skip = false; continue; }
            if !skip { out.push(line); }
        }
        let mut s = out.join("\n");
        // Trim trailing blank lines so we don't accumulate them.
        while s.ends_with('\n') { s.pop(); }
        s
    };
    let mut next = stripped;
    if !next.is_empty() { next.push('\n'); next.push('\n'); }
    next.push_str(BEGIN); next.push('\n');
    for d in member_dirs {
        next.push('/');
        next.push_str(d);
        next.push('\n');
    }
    next.push_str(END); next.push('\n');
    fs::write(&path, next)
}

#[tauri::command]
fn task_rename(id: String, name: String) -> Result<Task, String> {
    let new_name = name.trim();
    if new_name.is_empty() {
        return Err("name cannot be empty".into());
    }
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.name = new_name.to_string();
    save_task(w).map_err(|e| e.to_string())?;
    Ok(w.clone())
}

#[tauri::command]
fn project_rename(id: String, name: String) -> Result<Project, String> {
    let new_name = name.trim();
    if new_name.is_empty() {
        return Err("name cannot be empty".into());
    }
    let mut list = load_projects();
    let p = list.iter_mut().find(|p| p.id == id).ok_or("no such project")?;
    p.name = new_name.to_string();
    save_projects(&list).map_err(|e| e.to_string())?;
    Ok(list.into_iter().find(|p| p.id == id).unwrap())
}

#[tauri::command]
fn task_set_cli(id: String, cli: String) -> Result<Task, String> {
    if !["claude", "codex", "agy", "grok", "copilot", "opencode"].contains(&cli.as_str()) {
        return Err(format!("unknown cli: {cli}"));
    }
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.cli = cli;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(w.clone())
}

/// Update the launch command of a custom-command task. Only valid
/// for `cli == "custom"` tasks — agent / shell tasks resolve
/// their command from the registry at spawn and have no editable command.
/// Persisted so the new command re-runs on every respawn / app restart;
/// any live PTY keeps running until the user restarts the agent tab.
#[tauri::command]
fn task_set_custom_command(id: String, command: String) -> Result<Task, String> {
    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return Err("command is empty".into());
    }
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    if w.cli != "custom" {
        return Err("not a custom-command task".into());
    }
    w.custom_command = Some(cmd);
    save_task(w).map_err(|e| e.to_string())?;
    Ok(w.clone())
}

/// Set (or clear) a task's resume-args override. An empty / whitespace
/// command clears the override (back to termic's default resume logic);
/// otherwise the trimmed string is persisted and used verbatim as the
/// resume block on the next agent spawn. Returns the updated task.
#[tauri::command]
fn task_set_resume_override(id: String, command: String) -> Result<Task, String> {
    let cmd = command.trim().to_string();
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.resume_override = if cmd.is_empty() { None } else { Some(cmd) };
    save_task(w).map_err(|e| e.to_string())?;
    Ok(w.clone())
}

/// Replace a task's durable agent-tab list (metadata + order). The
/// per-tab `session_id` is PRESERVED across the rewrite by matching tab
/// ids against the existing record, so a layout change (rename, reorder,
/// add, close) never wipes a minted session. A tab id absent from `tabs`
/// is dropped entirely — that's how closing a tab with its X forgets the
/// agent. Idempotent: rewriting the identical list is a cheap no-op (no
/// disk write).
#[tauri::command]
fn task_set_tabs(id: String, tabs: Vec<PersistedTabInput>) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    // Carry forward each surviving tab's session uuid by id.
    let prior: std::collections::HashMap<String, Option<String>> = w
        .persisted_tabs
        .iter()
        .map(|t| (t.id.clone(), t.session_id.clone()))
        .collect();
    let next: Vec<PersistedTab> = tabs
        .into_iter()
        .map(|t| PersistedTab {
            // Stored uuid wins; only fall back to the payload's session_id
            // for a tab we've never seen (migrating a legacy per-cli uuid
            // onto the default tab on its first persist).
            session_id: prior.get(&t.id).cloned().flatten().or(t.session_id),
            id: t.id,
            cli: t.cli,
            title: t.title,
            custom_title: t.custom_title,
            is_default: t.is_default,
            command: t.command,
            pane_leaf_id: t.pane_leaf_id,
            run_member: t.run_member,
        })
        .collect();
    // No-op when nothing actually changed (compare the serialized shape;
    // session_id lives outside the input so equal metadata + preserved
    // uuids means an identical record).
    let same = next.len() == w.persisted_tabs.len()
        && next.iter().zip(w.persisted_tabs.iter()).all(|(a, b)| {
            a.id == b.id
                && a.cli == b.cli
                && a.title == b.title
                && a.custom_title == b.custom_title
                && a.is_default == b.is_default
                && a.command == b.command
                && a.session_id == b.session_id
                && a.pane_leaf_id == b.pane_leaf_id
                && a.run_member == b.run_member
        });
    if same {
        return Ok(());
    }
    w.persisted_tabs = next;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pin (or clear) the termic-owned session uuid for a single durable tab.
/// Mirrors `task_set_agent_session_id` but keyed by TAB id, so two
/// agent tabs in the same task resume independently. Called after a
/// freshly minted spawn survives the rapid-exit window; an empty uuid
/// clears the slot (the stored session no longer resolves). No-op if the
/// tab is not (yet) persisted or the value is unchanged.
#[tauri::command]
fn task_set_tab_session_id(id: String, tab_id: String, uuid: String) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    let tab = match w.persisted_tabs.iter_mut().find(|t| t.id == tab_id) {
        Some(t) => t,
        // The tab isn't in the durable set yet (set_tabs lands right after
        // a mint on a brand-new tab). Not an error — the eventual set_tabs
        // call records it and a later mint re-pins. Swallow quietly.
        None => return Ok(()),
    };
    let next = if uuid.is_empty() { None } else { Some(uuid) };
    if tab.session_id == next {
        return Ok(());
    }
    tab.session_id = next;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist the JSON-encoded SplitTree for a task so the split layout
/// can be restored on the next relaunch. Pass `None` to clear (no splits).
#[tauri::command]
fn task_set_split_layout(id: String, layout: Option<String>) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    if w.split_layout == layout {
        return Ok(());
    }
    w.split_layout = layout;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Mirror of `task_set_tabs` for the right-split panel. Rewrites
/// `right_split_tabs` with the same merge semantics (stored session_ids
/// carry forward by tab id so a layout rewrite never wipes a minted uuid).
#[tauri::command]
fn task_set_right_tabs(id: String, tabs: Vec<PersistedTabInput>) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    let prior: std::collections::HashMap<String, Option<String>> = w
        .right_split_tabs
        .iter()
        .map(|t| (t.id.clone(), t.session_id.clone()))
        .collect();
    let next: Vec<PersistedTab> = tabs
        .into_iter()
        .map(|t| PersistedTab {
            session_id: prior.get(&t.id).cloned().flatten().or(t.session_id),
            id: t.id,
            cli: t.cli,
            title: t.title,
            custom_title: t.custom_title,
            is_default: t.is_default,
            command: t.command,
            pane_leaf_id: None,
            run_member: None,
        })
        .collect();
    let same = next.len() == w.right_split_tabs.len()
        && next.iter().zip(w.right_split_tabs.iter()).all(|(a, b)| {
            a.id == b.id
                && a.cli == b.cli
                && a.title == b.title
                && a.custom_title == b.custom_title
                && a.is_default == b.is_default
                && a.command == b.command
                && a.session_id == b.session_id
        });
    if same {
        return Ok(());
    }
    w.right_split_tabs = next;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Mirror of `task_set_tab_session_id` for right-split tabs.
#[tauri::command]
fn task_set_right_tab_session_id(id: String, tab_id: String, uuid: String) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    let tab = match w.right_split_tabs.iter_mut().find(|t| t.id == tab_id) {
        Some(t) => t,
        None => return Ok(()),
    };
    let next = if uuid.is_empty() { None } else { Some(uuid) };
    if tab.session_id == next {
        return Ok(());
    }
    tab.session_id = next;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Newest-first list of macOS Sandbox denials touching the task
/// in the last `minutes` minutes. Used by the TaskSandboxDialog
/// to surface why `npm install` or whatever silently failed. Returns
/// an empty list on any error - debugging itself shouldn't fail.
///
/// MUST be async + spawn_blocking: `log show` reads the unified log
/// store which on a busy Mac can take 5-30 SECONDS to scan. Running
/// this on the IPC handler thread froze the whole window (the WKWebView
/// event loop runs on the same thread in dev) - this is exactly the
/// "make heavy IO async" rule from CLAUDE.md.
/// Whether the OS supports the sandbox at all. Frontend uses this to
/// grey out the cage toggle on Linux / Windows builds and show an
/// "unavailable on your OS" message instead of letting the user enable
/// something that would later crash the agent spawn.
#[tauri::command]
fn sandbox_available() -> bool { sandbox::available() }

/// Per-task deny counters surfaced in the TerminalPane footer
/// chip. Currently network-only (the proxy bumps it on every CONNECT/
/// HTTP request that fails the host allowlist). Filesystem deny
/// counting would need `log show` polling which is too expensive for
/// the cadence the footer wants. Cheap IPC; safe to poll every 2s.
#[derive(Clone, Serialize)]
struct SandboxDenyCounts {
    network: u64,
    path: u64,
}

#[tauri::command]
fn sandbox_deny_counts(id: String) -> SandboxDenyCounts {
    SandboxDenyCounts {
        network: proxy::network_deny_count(&id),
        path:    sandbox::path_deny_count(&id),
    }
}

/// Detailed per-host breakdown of network denies for a task.
/// Backs the popover that opens when the user clicks the "N blocked"
/// chip in the footer. Sorted by most-recently-seen first.
#[derive(Clone, Serialize)]
struct DenyHost {
    host: String,
    count: u64,
    last_seen_unix_ms: f64,
}
#[tauri::command]
fn sandbox_recent_denied_hosts(id: String) -> Vec<DenyHost> {
    proxy::network_deny_list(&id).into_iter().map(|e| DenyHost {
        host: e.host,
        count: e.count,
        // Cap as f64 for JSON safety (Tauri's serde-json round-trips
        // u128 as a string; f64 fits 53 bits which covers timestamps
        // far past the heat death of the sun).
        last_seen_unix_ms: e.last_seen_unix_ms as f64,
    }).collect()
}

#[derive(Clone, Serialize)]
struct DenyPath {
    path: String,
    count: u64,
    last_seen_unix_ms: f64,
    /// Last PID / process name observed denying this path. Surfaced on
    /// the popover row so a user investigating a surprising deny
    /// (Opera/Vivaldi/Chromium under claude, etc.) can pin it to a
    /// specific process without having to `ps -p <pid>` themselves.
    last_pid: u32,
    last_proc: String,
}
#[tauri::command]
fn sandbox_recent_denied_paths(id: String) -> Vec<DenyPath> {
    sandbox::path_deny_list(&id).into_iter().map(|e| DenyPath {
        path: e.path,
        count: e.count,
        last_seen_unix_ms: e.last_seen_unix_ms as f64,
        last_pid: e.last_pid,
        last_proc: e.last_proc,
    }).collect()
}

// ─── MONITORING activity (allow-everything-but-log mode) ──────────────
// Parallel to the deny counters/lists above, but these surface EVERY
// observed file op + network request (not just blocked ones), each with
// a `would_block` flag = "ENFORCING mode would have denied this." Backs
// the two-tab (Aggregate / Detailed) activity popover.

/// Set the MONITORING recording filters for a task (from the
/// activity popover's checkboxes). These gate RECORDING, not just display:
/// `exclude_task` drops accesses inside the task dir, `wb_only` records
/// only would-block accesses. Prunes already-recorded entries that the
/// newly-enabled filters exclude so the change is immediate + reclaims RAM.
///
/// The param is named `exclude_task` (not `exclude_ws`) so Tauri's
/// snake_case→camelCase mapping produces the `excludeTask` key the frontend
/// actually sends (ipc.ts). A stale `exclude_ws` here silently failed to
/// deserialize, so the checkbox never reached the backend.
#[tauri::command]
fn sandbox_set_monitor_filters(id: String, exclude_task: bool, wb_only: bool) -> Result<(), String> {
    let dirs = load_tasks().into_iter().find(|w| w.id == id)
        .map(|w| sandbox::task_exclude_dirs(&w))
        .unwrap_or_default();
    sandbox::set_monitor_filters(&id, exclude_task, wb_only);
    sandbox::prune_path_access(&id, exclude_task, wb_only, &dirs);
    Ok(())
}

/// Combined access totals for the footer chip in MONITORING mode.
#[tauri::command]
fn sandbox_access_counts(id: String) -> SandboxDenyCounts {
    SandboxDenyCounts {
        network: proxy::network_access_count(&id),
        path:    sandbox::path_access_count(&id),
    }
}

#[derive(Clone, Serialize)]
struct AccessHost {
    host: String,
    port: u16,
    count: u64,
    last_seen_unix_ms: f64,
    would_block: bool,
}
#[tauri::command]
fn sandbox_recent_access_hosts(id: String) -> Vec<AccessHost> {
    proxy::network_access_list(&id).into_iter().map(|e| AccessHost {
        host: e.host,
        port: e.port,
        count: e.count,
        last_seen_unix_ms: e.last_seen_unix_ms as f64,
        would_block: e.would_block,
    }).collect()
}

#[derive(Clone, Serialize)]
struct AccessPath {
    path: String,
    op: String,
    count: u64,
    last_seen_unix_ms: f64,
    last_pid: u32,
    last_proc: String,
    would_block: bool,
}
#[tauri::command]
fn sandbox_recent_access_paths(id: String) -> Vec<AccessPath> {
    sandbox::path_access_list(&id).into_iter().map(|e| AccessPath {
        path: e.path,
        op: e.op,
        count: e.count,
        last_seen_unix_ms: e.last_seen_unix_ms as f64,
        last_pid: e.last_pid,
        last_proc: e.last_proc,
        would_block: e.would_block,
    }).collect()
}

// ── Per-AGENT allow (scope: "per agent") ──────────────────────────────
// Writes to the agent registry (settings.json) so EVERY task
// running this agent, across all projects, inherits the path/host. The
// least-repetitive scope: the same CLI probes the same dirs/hosts
// everywhere. Picked up live at the next spawn (render_profile /
// render_filter read the agent registry each time). No PTY kill.

#[tauri::command]
fn agent_sandbox_add_allowed_path(agent_id: String, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() { return Err("empty path".into()); }
    // Tokenize the leading $HOME for portability, matching how the agent
    // registry's built-in paths are stored ($HOME/Library/...).
    let stored = tokenize_home_prefix(&path);
    let mut s = load_settings_inner();
    let a = s.agents.iter_mut().find(|a| a.id == agent_id).ok_or("no such agent")?;
    if !a.sandbox_allowed_paths.iter().any(|p| p == &stored) {
        a.sandbox_allowed_paths.push(stored);
    }
    let f = settings_file().map_err(|e| e.to_string())?;
    fs::write(f, serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn agent_sandbox_add_allowed_host(agent_id: String, host: String) -> Result<(), String> {
    let host = host.trim().to_string();
    if host.is_empty() { return Err("empty host".into()); }
    let mut s = load_settings_inner();
    let a = s.agents.iter_mut().find(|a| a.id == agent_id).ok_or("no such agent")?;
    if !a.sandbox_allowed_hosts.iter().any(|h| h == &host) {
        a.sandbox_allowed_hosts.push(host);
    }
    let f = settings_file().map_err(|e| e.to_string())?;
    fs::write(f, serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append a host to the task's `sandbox_allowed_hosts` list and
/// save. Does NOT kill the live PTY — adding to the allowlist is
/// strictly more permissive than what the running agent already has,
/// so leaving the existing process on its older (narrower) profile is
/// safe; the new entry takes effect on the next agent start. Backs the
/// "Allow" button next to each blocked host in the footer popover.
#[tauri::command]
fn task_sandbox_add_allowed_host(
    _state: State<'_, PtyManager>, id: String, host: String,
) -> Result<usize, String> {
    let host = host.trim().to_string();
    if host.is_empty() { return Err("empty host".into()); }
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    if !w.sandbox_allowed_hosts.iter().any(|h| h == &host) {
        w.sandbox_allowed_hosts.push(host.clone());
    }
    let project_id = w.project_id.clone();
    save_task(w).map_err(|e| e.to_string())?;
    // Lift into the project's sandbox defaults too, so future
    // tasks under the same project inherit. The agent probes
    // the same hosts in every task it runs; saving per-project
    // means the user doesn't have to re-click Allow on each new
    // task they create. Sibling tasks that already exist
    // are NOT retroactively patched (would surprise the user) —
    // they'll still hit the deny once and click Allow themselves.
    let mut projects = load_projects();
    if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
        if !p.sandbox_allowed_hosts.iter().any(|h| h == &host) {
            p.sandbox_allowed_hosts.push(host);
            let _ = save_projects(&projects);
        }
    }
    Ok(0)
}

/// Mirror of `task_sandbox_add_allowed_host` but for filesystem
/// paths. Append to `sandbox_rw_paths`, save. No SIGKILL — same
/// reasoning: the new entry is purely additive, the running agent's
/// old profile is narrower, change takes effect on next start.
#[tauri::command]
fn task_sandbox_add_allowed_path(
    _state: State<'_, PtyManager>, id: String, path: String,
) -> Result<usize, String> {
    let path = path.trim().to_string();
    if path.is_empty() { return Err("empty path".into()); }
    // Replace the literal $HOME prefix with the $HOME token so the
    // stored entry stays portable + readable (we substitute at spawn
    // anyway). Only the LEADING prefix — `/Users/simion/Pictures` is
    // the user's home; embedded `/Users/...` elsewhere is left alone.
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    // Tokenized form for persistence ($HOME/...). Already-tokenized input
    // passes through unchanged (no literal home prefix to match).
    let stored = tokenize_home_prefix(&path);
    // Absolute form for the deny-tracker prune (the tracker stores
    // absolute paths from the kernel deny log). The frontend may have
    // sent either form depending on whether the click was on a
    // shortened or raw display.
    let absolute = if !home.is_empty() && (path == "$HOME" || path.starts_with("$HOME/")) {
        path.replacen("$HOME", &home, 1)
    } else {
        path
    };
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    if !w.sandbox_rw_paths.iter().any(|p| p == &stored) {
        w.sandbox_rw_paths.push(stored.clone());
    }
    let project_id = w.project_id.clone();
    save_task(w).map_err(|e| e.to_string())?;
    // Lift to project defaults too so future tasks inherit.
    // See task_sandbox_add_allowed_host for rationale.
    let mut projects = load_projects();
    if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
        if !p.sandbox_rw_paths.iter().any(|p| p == &stored) {
            p.sandbox_rw_paths.push(stored);
            let _ = save_projects(&projects);
        }
    }
    // Prune historical deny entries under this prefix so the popover
    // row vanishes after click. Without this the in-memory tracker
    // keeps the entry around and the user thinks the click did nothing.
    sandbox::clear_path_denies_under(&id, &absolute);
    Ok(0)
}

/// Undo of `task_sandbox_add_allowed_path`. Removes the path from
/// BOTH the task's `sandbox_rw_paths` AND the project defaults —
/// symmetric with the add, which lifts the entry into the project so
/// future tasks inherit it. Without the project removal, Undo would
/// leave the project-level copy behind and future tasks would still
/// inherit the "reverted" allow. Used by the toast's Undo button.
/// Idempotent — removing a path that isn't in either list is a no-op.
#[tauri::command]
fn task_sandbox_remove_allowed_path(
    _state: State<'_, PtyManager>, id: String, path: String,
) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() { return Ok(()); }
    // Match both raw and $HOME-tokenized forms (the stored entry was
    // tokenized at add-time, but the caller may pass either).
    let tokenized = tokenize_home_prefix(&path);
    let matches = |p: &String| p != &path && p != &tokenized;
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.sandbox_rw_paths.retain(matches);
    let project_id = w.project_id.clone();
    save_task(w).map_err(|e| e.to_string())?;
    // Mirror the add's project-lift: drop the entry from the project
    // defaults too so the Undo is a true revert.
    let mut projects = load_projects();
    if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
        let before = p.sandbox_rw_paths.len();
        p.sandbox_rw_paths.retain(matches);
        if p.sandbox_rw_paths.len() != before { let _ = save_projects(&projects); }
    }
    Ok(())
}

// ───────────────── repo-root `.termic.yaml` config ─────────────────
//
// The "Allow for this repo" destination. Where `task_sandbox_add_*`
// (above) writes the personal, uncommitted "allow for me" overrides
// into `projects.json`, these write the committed, team-shared
// `.termic.yaml` at the repo root. Both feed `live_sandbox_lists`.

/// Tokenize a leading `$HOME` prefix so the stored `.termic.yaml`
/// entry stays portable. Mirrors `task_sandbox_add_allowed_path`.
fn tokenize_home_prefix(path: &str) -> String {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !home.is_empty() && (path == home || path.starts_with(&format!("{home}/"))) {
        path.replacen(&home, "$HOME", 1)
    } else {
        path.to_string()
    }
}

/// Read a project's committed `.termic.yaml` (at its `root_path`).
/// `Ok(None)` when the repo has no such file; `Err` when it exists but
/// is malformed. Keyed by project — backs the Repository settings.
#[tauri::command]
fn repo_config_load(project_id: String) -> Result<Option<repo_config::RepoConfig>, String> {
    let p = load_projects()
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("no such project")?;
    repo_config::load(Path::new(&p.root_path)).map_err(|e| e.to_string())
}

/// Load a repo's `.termic.yaml` directly by path — used for inline
/// multi-repo members, which aren't registered as projects (so there's no
/// id to resolve). Returns None when the file is absent.
#[tauri::command]
fn repo_config_load_at(path: String) -> Result<Option<repo_config::RepoConfig>, String> {
    let expanded = expand_tilde(&path);
    if expanded.is_empty() { return Ok(None); }
    repo_config::load(Path::new(&expanded)).map_err(|e| e.to_string())
}

/// Write a project's `.termic.yaml` (full re-serialize — see
/// `repo_config::save`). Backs the Repository settings' Scripts tab.
#[tauri::command]
fn repo_config_save(project_id: String, config: repo_config::RepoConfig) -> Result<(), String> {
    let p = load_projects()
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("no such project")?;
    repo_config::save(Path::new(&p.root_path), &config).map_err(|e| e.to_string())
}

/// Write a fresh `.termic.yaml` scaffold to a project's repo if it has
/// none. Returns true if a file was created.
#[tauri::command]
fn repo_config_scaffold(project_id: String) -> Result<bool, String> {
    let p = load_projects()
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or("no such project")?;
    repo_config::scaffold(Path::new(&p.root_path)).map_err(|e| e.to_string())
}

/// "Allow for this repo" — append a host to the repo's committed
/// `.termic.yaml`. Comment-preserving; no SIGKILL (purely additive,
/// takes effect on the next user-initiated spawn).
#[tauri::command]
fn repo_config_add_allowed_host(id: String, host: String) -> Result<(), String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("empty host".into());
    }
    let proj = task_project(&id)?;
    repo_config::add_allowed(Path::new(&proj.root_path), repo_config::AllowKind::Host, &host)
        .map_err(|e| e.to_string())
}

/// Resolve a task id to its owning Project (for repo_config writes
/// keyed at the project's `root_path`).
fn task_project(ws_id: &str) -> Result<Project, String> {
    let task = load_tasks()
        .into_iter()
        .find(|w| w.id == ws_id)
        .ok_or("no such task")?;
    load_projects()
        .into_iter()
        .find(|p| p.id == task.project_id)
        .ok_or_else(|| "no such project".into())
}

/// "Allow for this repo" — append a path to the repo's committed
/// `.termic.yaml`. The leading `$HOME` is tokenized for portability.
#[tauri::command]
fn repo_config_add_allowed_path(id: String, path: String) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("empty path".into());
    }
    let stored = tokenize_home_prefix(path);
    let proj = task_project(&id)?;
    repo_config::add_allowed(Path::new(&proj.root_path), repo_config::AllowKind::Path, &stored)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn task_recent_denials(id: String, minutes: Option<u32>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || -> Vec<String> {
        let Some(task) = load_tasks().into_iter().find(|w| w.id == id) else {
            return Vec::new();
        };
        sandbox::recent_denials(&task.path, minutes.unwrap_or(10))
    })
    .await
    .unwrap_or_default()
}


/// Update a task's sandbox config and SIGKILL any live PTYs of
/// that task so the next mount picks up the new profile. Returns
/// the count of PTYs that were terminated so the frontend can word the
/// confirmation accurately ("This will restart 2 agents").
///
/// The kill is the security-critical bit: changing the sandbox while
/// the agent kept running would mean we have a process holding the
/// OLD profile's permissions, which is the exact thing the sandbox is
/// supposed to enforce against. SIGKILL is cleaner than SIGTERM here -
/// we don't want the agent to handle the signal and do anything fancy
/// before exiting; we want it gone.
#[tauri::command]
fn task_set_sandbox(
    state: State<'_, PtyManager>,
    id: String,
    mode: SandboxMode,
    rw_paths: Vec<String>,
    allowed_hosts: Vec<String>,
    kill_live: bool,
) -> Result<usize, String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.sandbox_mode = Some(mode);
    // Keep the legacy bool in sync so every existing "is there a cage"
    // check (footer, YOLO/Zap, pty_spawn) keeps working.
    w.sandbox_enabled = mode != SandboxMode::Off;
    w.sandbox_rw_paths = rw_paths;
    w.sandbox_allowed_hosts = allowed_hosts;
    save_task(w).map_err(|e| e.to_string())?;

    // `kill_live=false` is an INFORMED escape hatch: the user explicitly
    // chose "Save without restart" knowing the running agent keeps the
    // OLD profile. The dialog warns them; this is not a default.
    if !kill_live {
        return Ok(0);
    }

    // Find + SIGKILL every live PTY belonging to this task. We
    // hold the manager lock only long enough to collect (id, pid)
    // pairs - kill(2) outside the lock so a slow signal can't stall
    // unrelated PTY ops.
    let victims: Vec<(String, Option<u32>)> = {
        let map = state.inner.lock();
        map.iter()
            .filter(|(_, slot)| slot.task_id.as_deref() == Some(&id))
            .map(|(pty_id, slot)| (pty_id.clone(), slot.child_pid))
            .collect()
    };
    let count = victims.len();
    for (pty_id, pid) in victims {
        if let Some(p) = pid {
            unsafe { libc::kill(p as i32, libc::SIGKILL); }
        }
        // The waiter thread cleans up the slot after wait() returns;
        // we don't preemptively remove the entry here to avoid a
        // race with the per-PTY emit thread.
        let _ = pty_id;
    }
    Ok(count)
}

/// Set the per-task YOLO flag and persist. No PTY kill — it only
/// affects how the NEXT agent is launched (the frontend separately
/// flips a live agent via its runtime YOLO command when supported).
#[tauri::command]
fn task_set_yolo(id: String, yolo: bool) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.yolo = yolo;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Increment + persist the task's `spawn_count`. Historical metric
/// only — resume gating now uses `has_resumable_history` instead.
#[tauri::command]
fn task_record_spawn(id: String) -> Result<u32, String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    w.spawn_count = w.spawn_count.saturating_add(1);
    save_task(w).map_err(|e| e.to_string())?;
    Ok(w.spawn_count)
}

/// Set the persisted `has_resumable_history` flag for a task.
/// Frontend calls this:
///   - TRUE when a spawn has been alive past the rapid-failure window
///     (~2s) — meaning the agent didn't immediately bail with "no
///     conversation to continue", so a real session likely exists.
///   - FALSE when a resume-attempt spawn exits within the failure
///     window — we now know the resume path is broken for this worktree
///     and shouldn't re-try.
#[tauri::command]
fn task_set_has_history(id: String, value: bool) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    if w.has_resumable_history == value { return Ok(()); }
    w.has_resumable_history = value;
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pin a termic-owned session UUID for a (task, agent CLI) pair.
/// Called by the frontend after the first spawn for an id-capable CLI
/// (claude, gemini) has survived past the rapid-failure window — at
/// that point the agent has materialized a session file for that uuid,
/// so every subsequent spawn can resume it. Idempotent: re-setting the
/// same uuid is a cheap no-op (no disk write).
#[tauri::command]
fn task_set_agent_session_id(id: String, cli: String, uuid: String) -> Result<(), String> {
    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such task")?;
    // Empty uuid = clear the slot. Used when a resume attempt died fast,
    // signalling the stored uuid no longer resolves to a live session
    // (agent log rotated out, user ran `claude --delete-session`, ...).
    // Next spawn will mint a fresh one.
    if uuid.is_empty() {
        if w.agent_session_ids.remove(&cli).is_none() { return Ok(()); }
    } else {
        if w.agent_session_ids.get(&cli).map(|v| v.as_str()) == Some(uuid.as_str()) {
            return Ok(());
        }
        w.agent_session_ids.insert(cli, uuid);
    }
    save_task(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Archive a task: stop scripts, run the archive script, remove the
/// worktree, mark archived in our JSON.
///
/// CRITICAL: this MUST run off the Tauri IPC thread. `fs::remove_dir_all`
/// on a worktree containing a sizeable `.venv` / `node_modules` (50k+
/// inodes) hammers APFS metadata and freezes the whole process — and in
/// the prior synchronous version, that froze the entire Mac through the
/// blocked main webview event loop. `spawn_blocking` parks the work on a
/// background thread so the UI keeps painting and the OS stays responsive.
#[tauri::command]
async fn task_archive(id: String, delete_branch: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || task_archive_sync(id, delete_branch.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove `dir` only when it holds no VISIBLE entries. This is a NON-recursive
/// `rmdir` (`fs::remove_dir`), never `remove_dir_all` — a stray visible file
/// or subdirectory aborts it, so we can never nuke real content. Hidden files
/// (`.DS_Store` and similar OS cruft) are the one exception: they'd otherwise
/// keep an "empty" dir alive forever, so we delete those individual files
/// (files only — a hidden *directory* like `.git` still aborts) and then rmdir.
/// Returns true iff the directory was removed.
fn remove_dir_if_empty_ignoring_hidden(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    let mut hidden_files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        // Treat an unreadable file_type as a directory (conservative: abort).
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(true);
        if hidden && !is_dir {
            hidden_files.push(entry.path());
        } else {
            return false; // a visible entry, or a hidden dir → not empty
        }
    }
    for f in &hidden_files { let _ = fs::remove_file(f); }
    fs::remove_dir(dir).is_ok()
}

/// After a worktree directory is archived (removed), prune any now-empty
/// ancestor directories: the `<project-slug>` folder, then the legacy
/// `~/APP_DIR/workspaces/` (or new `~/APP_DIR/tasks/`) root, so the old
/// `workspaces/` tree disappears once its last task is archived. Bounded and
/// safe: only strict descendants of the `~/APP_DIR` worktree home are touched
/// (never the home itself, which also holds `projects/`, nor anything outside
/// it such as an imported worktree), and each step is the empty-only rmdir
/// above, so it stops the moment a directory still has content.
fn prune_empty_worktree_ancestors(worktree_path: &Path) {
    let Some(home) = dirs::home_dir() else { return };
    let app_home = home.join(APP_DIR);
    let mut cur = worktree_path.parent();
    while let Some(d) = cur {
        if d == app_home || !d.starts_with(&app_home) { break; }
        if !remove_dir_if_empty_ignoring_hidden(d) { break; }
        cur = d.parent();
    }
}

fn task_archive_sync(id: String, delete_branch: bool) -> Result<(), String> {
    // Stop spotlight for this task before tearing down — otherwise the
    // polling thread will keep trying to sync a worktree that no longer exists.
    spotlight_stop_for_ws(&id);

    let mut list = load_tasks();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("task not found")?;
    let proj = load_projects().into_iter().find(|p| p.id == w.project_id);

    // Kill any running setup/run scripts for this task BEFORE doing
    // anything else — otherwise dev servers (npm run dev, runserver, etc.)
    // keep listening on their port long after the worktree is gone, which
    // the user just hit. We SIGTERM the process group, same as Stop.
    {
        let keys: Vec<String> = {
            let g = RUNNING_SCRIPTS.lock().unwrap();
            g.as_ref().map(|m| m.keys()
                .filter(|k| k.starts_with(&format!("{id}:")))
                .cloned().collect()).unwrap_or_default()
        };
        for k in keys {
            if let Some(pid) = running_scripts_remove(&k) {
                unsafe { libc::kill(-pid, libc::SIGTERM); }
            }
        }
    }

    // Multi-repo tasks: only members have scripts (host is a
    // wrapper, not a thing you run). Members archive in REVERSE
    // declared order — stack teardown convention (last started,
    // first stopped). Single-repo tasks: host's project
    // archive_script fires (covers `npm run cleanup` etc).
    if !w.composition.is_empty() {
        for m in w.composition.iter().rev() {
            // Per-member override, else the member's committed `.termic.yaml`
            // archive (same resolution as setup/run) so a member configured
            // via `.termic.yaml` still tears down.
            let script = member_effective_script(m, |s| s.archive.clone(), &m.archive_script);
            if !script.trim().is_empty() && Path::new(&m.path).exists() {
                let _ = run_script(&script, Path::new(&m.path), w.port, &w.name);
            }
        }
    } else if let Some(p) = &proj {
        let archive = effective_scripts(p).2;
        if !archive.trim().is_empty() {
            let _ = run_script(&archive, Path::new(&w.path), w.port, &w.name);
        }
    }

    let mut errs = Vec::new();
    // Repo-root tasks are NOT git worktrees — skip the worktree/rmdir
    // dance entirely. Archiving one just removes it from our list; the actual
    // repo on disk stays intact.
    if w.is_main_checkout {
        // Multi-repo project opened in REPO mode: task_open_repo
        // dropped member symlinks into the host dir. Clean them up
        // on archive so a re-open doesn't trip the "already exists,
        // not our symlink" guard. We only remove entries that are
        // STILL symlinks pointing where we expect — a user who
        // replaced the link with real content keeps their work.
        //
        // CRITICAL: every repo-root task on the same multi-repo
        // project SHARES this host checkout (w.path == proj.root_path),
        // and therefore the very same member symlinks. If another live
        // (non-archived) repo-root task still points at this host,
        // those links are its file tree — archiving THIS one must not
        // yank them out from under it. Only unlink a member when no
        // surviving sibling on the same host still lists it. (Excludes
        // self by id; w.archived isn't set yet, so we'd otherwise match
        // ourselves.) Without this, archiving one DPF repo-root session
        // silently emptied another's repo list (no command ever ran).
        let sibling_links: HashSet<String> = load_tasks().into_iter()
            .filter(|o| o.id != w.id && !o.archived && o.path == w.path)
            .flat_map(|o| o.composition.into_iter()
                .filter(|cm| cm.mode == MemberMode::RepoRoot)
                .map(|cm| cm.dir_name))
            .collect();
        for m in &w.composition {
            if m.mode != MemberMode::RepoRoot { continue; }
            if sibling_links.contains(&m.dir_name) { continue; }
            let link = Path::new(&w.path).join(&m.dir_name);
            let Ok(meta) = link.symlink_metadata() else { continue; };
            if !meta.file_type().is_symlink() { continue; }
            let target = fs::read_link(&link).ok().map(|p| p.to_string_lossy().into_owned());
            if target.as_deref() != Some(m.path.as_str()) { continue; }
            if let Err(e) = fs::remove_file(&link) {
                errs.push(format!("rm symlink {}: {e}", m.dir_name));
            }
        }
        w.archived = true;
        w.archived_at = Some(chrono::Utc::now().to_rfc3339());
        save_task(w).map_err(|e| e.to_string())?;
        if !errs.is_empty() { return Err(errs.join("; ")); }
        return Ok(());
    }

    // Multi-repo tasks tear down each member first, then the
    // host worktree. Members in RepoRoot mode are symlinks — unlink
    // them, NEVER touch the linked checkout. Errors per-member are
    // recorded but don't abort the loop (best-effort cleanup).
    if !w.composition.is_empty() {
        let all_projects = load_projects();
        for m in &w.composition {
            match m.mode {
                MemberMode::RepoRoot => {
                    // <wrapper>/<dir_name> is a symlink to the live
                    // repo. Removing the symlink is just removing the
                    // dir entry; readlink/exists succeed without
                    // following it. fs::remove_file works for
                    // symlinks on Unix.
                    let link = Path::new(&w.path).join(&m.dir_name);
                    if link.symlink_metadata().is_ok() {
                        if let Err(e) = fs::remove_file(&link) {
                            errs.push(format!("rm symlink {}: {e}", m.dir_name));
                        }
                    }
                }
                MemberMode::Worktree => {
                    // Source repo to run `git worktree remove` against. New
                    // records carry it inline (repo_path); legacy ones fall
                    // back to resolving the old project_id reference.
                    let repo_path = if !m.repo_path.is_empty() {
                        Some(m.repo_path.clone())
                    } else {
                        all_projects.iter().find(|p| p.id == m.project_id).map(|mp| mp.root_path.clone())
                    };
                    if let Some(repo_path) = repo_path {
                        if let Err(e) = git(&["worktree", "remove", "--force", &m.path], Path::new(&repo_path)) {
                            errs.push(format!("worktree remove {}: {e}", m.dir_name));
                        }
                        if delete_branch && !m.branch.is_empty() {
                            if let Err(e) = git(&["branch", "-D", &m.branch], Path::new(&repo_path)) {
                                errs.push(format!("branch delete {}: {e}", m.dir_name));
                            }
                        }
                    }
                    if Path::new(&m.path).exists() {
                        if let Err(e) = fs::remove_dir_all(&m.path) {
                            errs.push(format!("rm member dir {}: {e}", m.dir_name));
                        }
                    }
                }
            }
        }
    }

    // Non-git host (issue #4): the wrapper is a plain dir we mkdir'd, not
    // a git worktree, so skip the git teardown — `fs::remove_dir_all`
    // below cleans it up. (Member worktrees were already removed above.)
    if let Some(p) = &proj {
        if !p.non_git {
            if let Err(e) = git(&["worktree", "remove", "--force", &w.path], Path::new(&p.root_path)) {
                errs.push(format!("worktree remove: {e}"));
            }
            if delete_branch && !w.branch.is_empty() {
                if let Err(e) = git(&["branch", "-D", &w.branch], Path::new(&p.root_path)) {
                    errs.push(format!("branch delete failed: {e}"));
                }
            }
        }
    }
    if Path::new(&w.path).exists() {
        if let Err(e) = fs::remove_dir_all(&w.path) {
            errs.push(format!("rm worktree dir: {e}"));
        }
    }
    // Tidy up now-empty ancestors (the project folder, then the legacy
    // `workspaces/` root once its last task is gone). Best-effort, empty-only.
    prune_empty_worktree_ancestors(Path::new(&w.path));

    w.archived = true;
    w.archived_at = Some(chrono::Utc::now().to_rfc3339());
    save_task(w).map_err(|e| e.to_string())?;
    if errs.is_empty() { Ok(()) } else { Err(errs.join("; ")) }
}

#[tauri::command]
async fn task_delete(id: String) -> Result<(), String> {
    // Hard delete: archive (off-thread) then wipe the json. Same async
    // discipline as task_archive — see its doc comment for why.
    let id2 = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = task_archive_sync(id2.clone(), false);
        delete_task_file(&id2).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn task_restore(app: AppHandle, id: String) -> Result<Task, String> {
    tauri::async_runtime::spawn_blocking(move || task_restore_sync(app, id))
        .await
        .map_err(|e| e.to_string())?
}

fn task_restore_sync(app: AppHandle, id: String) -> Result<Task, String> {
    let mut list = load_tasks();
    let idx = list.iter().position(|w| w.id == id).ok_or("task not found")?;
    if !list[idx].archived {
        return Err("task is not archived".into());
    }

    let proj = load_projects().into_iter()
        .find(|p| p.id == list[idx].project_id)
        .ok_or("project not found")?;

    // Repo-root tasks have no dedicated worktree to recreate — the task
    // IS the main checkout. Just unarchive the record and return.
    if list[idx].is_main_checkout {
        list[idx].archived = false;
        list[idx].archived_at = None;
        save_task(&list[idx]).map_err(|e| e.to_string())?;
        return Ok(list[idx].clone());
    }

    let wt_path = PathBuf::from(&list[idx].path);
    let repo = PathBuf::from(&proj.root_path);

    if list[idx].composition.is_empty() {
        // ── Single-repo task ──────────────────────────────────────────
        if !proj.non_git {
            let _ = git(&["worktree", "prune"], &repo);

            // Guard: path already claimed by a live worktree.
            if wt_path.exists() {
                let listed = git(&["worktree", "list", "--porcelain"], &repo)
                    .unwrap_or_default();
                let path_str = wt_path.to_string_lossy();
                let registered = listed.lines()
                    .any(|l| l.strip_prefix("worktree ").map(|p| p == path_str).unwrap_or(false));
                if registered {
                    return Err(format!("a worktree already lives at {}", wt_path.display()));
                }
                // Orphan directory — remove before adding the worktree.
                fs::remove_dir_all(&wt_path)
                    .map_err(|e| format!("orphan dir at {}: {e}", wt_path.display()))?;
            }

            let branch = list[idx].branch.clone();
            let base_branch = list[idx].base_branch.clone();

            // git-crypt detection (mirrors task_create_sync).
            let common_gitdir = git(&["rev-parse", "--git-common-dir"], &repo)
                .ok()
                .map(|s| s.trim().to_string())
                .map(|s| {
                    let p = PathBuf::from(&s);
                    if p.is_absolute() { p } else { repo.join(p) }
                });
            let has_git_crypt = common_gitdir.as_ref()
                .map(|p| p.join("git-crypt").exists())
                .unwrap_or(false);

            let wt_arg = wt_path.to_str().unwrap();
            let add_flags: &[&str] = if has_git_crypt {
                &["worktree", "add", "--no-checkout"]
            } else {
                &["worktree", "add"]
            };
            let mut add_args: Vec<&str> = add_flags.to_vec();
            add_args.push(wt_arg);
            add_args.push(&branch);

            let branch_exists = git(&["rev-parse", "--verify", &branch], &repo).is_ok();
            if branch_exists {
                git(&add_args, &repo).map_err(|e| e.to_string())?;
            } else {
                // Branch was deleted at archive time — recreate from base.
                git(&["branch", "--no-track", &branch, &base_branch], &repo)
                    .map_err(|e| format!("recreate branch '{branch}' from '{base_branch}': {e}"))?;
                git(&add_args, &repo).map_err(|e| e.to_string())?;
            }

            // git-crypt: bridge the key dir into the new worktree's gitdir.
            if has_git_crypt {
                let wt_gitdir_raw = git(&["rev-parse", "--git-dir"], &wt_path)
                    .map_err(|e| format!("git-crypt setup: resolve gitdir: {e}"))?;
                let wt_gitdir = {
                    let p = PathBuf::from(wt_gitdir_raw.trim());
                    if p.is_absolute() { p } else { wt_path.join(p) }
                };
                let key_target = common_gitdir.as_ref().unwrap().join("git-crypt");
                let key_link  = wt_gitdir.join("git-crypt");
                if !key_link.exists() {
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&key_target, &key_link)
                        .map_err(|e| format!("git-crypt setup: symlink: {e}"))?;
                }
                git(&["reset", "--hard", "HEAD"], &wt_path)
                    .map_err(|e| format!("git-crypt setup: post-symlink checkout: {e}"))?;
            }

            // Copy files_to_copy globs (same as creation).
            for pat in &effective_files_to_copy(&proj) {
                copy_matching(&repo, &wt_path, pat);
            }
        } else {
            // Non-git project: just recreate the folder.
            fs::create_dir_all(&wt_path).map_err(|e| e.to_string())?;
        }
    } else {
        // ── Multi-repo task ───────────────────────────────────────────
        let _ = git(&["worktree", "prune"], &repo);

        if wt_path.exists() {
            return Err(format!("task wrapper already exists at {}", wt_path.display()));
        }

        // Recreate host worktree.
        if proj.non_git {
            fs::create_dir_all(&wt_path)
                .map_err(|e| format!("create wrapper dir: {e}"))?;
            for shared in &["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".gemini", ".codex"] {
                let src = repo.join(shared);
                if src.exists() {
                    let dst = wt_path.join(shared);
                    if !dst.exists() {
                        let _ = std::os::unix::fs::symlink(&src, &dst);
                    }
                }
            }
        } else {
            let host_branch = list[idx].branch.clone();
            let host_base   = list[idx].base_branch.clone();
            let branch_exists = git(&["rev-parse", "--verify", &host_branch], &repo).is_ok();
            if branch_exists {
                git(&["worktree", "add", wt_path.to_str().unwrap(), &host_branch], &repo)
                    .map_err(|e| format!("host worktree add: {e}"))?;
            } else {
                git(&["branch", "--no-track", &host_branch, &host_base], &repo)
                    .map_err(|e| format!("recreate host branch: {e}"))?;
                git(&["worktree", "add", wt_path.to_str().unwrap(), &host_branch], &repo)
                    .map_err(|e| format!("host worktree add: {e}"))?;
            }
        }

        // Recreate each member (best-effort — errors don't abort the restore).
        let all_projects = load_projects();
        let composition = list[idx].composition.clone();
        let base_branch = list[idx].base_branch.clone();
        for m in &composition {
            match m.mode {
                MemberMode::RepoRoot => {
                    // Recreate symlink: <wrapper>/<dir_name> → m.path
                    let link = wt_path.join(&m.dir_name);
                    if !link.exists() {
                        let _ = std::os::unix::fs::symlink(&m.path, &link);
                    }
                }
                MemberMode::Worktree => {
                    let member_repo = if !m.repo_path.is_empty() {
                        Some(m.repo_path.clone())
                    } else {
                        all_projects.iter()
                            .find(|p| p.id == m.project_id)
                            .map(|mp| mp.root_path.clone())
                    };
                    if let Some(mr) = member_repo {
                        let mr_path = PathBuf::from(&mr);
                        let _ = git(&["worktree", "prune"], &mr_path);
                        let branch_exists = git(&["rev-parse", "--verify", &m.branch], &mr_path).is_ok();
                        if !branch_exists {
                            let _ = git(&["branch", "--no-track", &m.branch, &base_branch], &mr_path);
                        }
                        let _ = git(&["worktree", "add", &m.path, &m.branch], &mr_path);
                    }
                }
            }
        }
    }

    // Unarchive and persist.
    list[idx].archived = false;
    save_task(&list[idx]).map_err(|e| e.to_string())?;
    let task = list[idx].clone();

    // Run setup script(s) fire-and-forget, same as creation.
    if task.composition.is_empty() {
        let (setup, _, _) = effective_scripts(&proj);
        if !setup.trim().is_empty() {
            run_script_streaming(setup, wt_path, task.port, task.name.clone(), app, task.id.clone());
        }
    } else {
        for m in &task.composition {
            if !m.setup_script.trim().is_empty() {
                run_script_streaming(
                    m.setup_script.clone(),
                    PathBuf::from(&m.path),
                    if m.port > 0 { m.port } else { task.port },
                    task.name.clone(),
                    app.clone(),
                    task.id.clone(),
                );
            }
        }
    }

    Ok(task)
}

#[tauri::command]
fn task_run_script(id: String, which: String) -> Result<String, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no such task")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("no proj")?;
    let (setup, run, archive) = effective_scripts(&p);
    let script = match which.as_str() {
        "setup" => setup,
        "run" => run,
        "archive" => archive,
        _ => return Err("unknown script".into()),
    };
    if script.trim().is_empty() {
        return Err("script empty".into());
    }
    run_script(&script, Path::new(&w.path), w.port, &w.name).map_err(|e| e.to_string())
}

#[tauri::command]
fn task_diff(id: String) -> Result<String, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("no proj")?;
    let repo = PathBuf::from(&p.root_path);
    let base = w.base_branch.clone();
    let wt = PathBuf::from(&w.path);
    let log = git(&["--no-pager", "log", "--oneline", &format!("{base}..HEAD")], &wt).unwrap_or_default();
    let stat = git(&["--no-pager", "diff", "--stat", &format!("{base}..HEAD")], &wt).unwrap_or_default();
    let diff = git(&["--no-pager", "diff", &format!("{base}..HEAD")], &wt).unwrap_or_default();
    let _ = repo;
    Ok(format!("=== commits ===\n{log}\n\n=== stat ===\n{stat}\n\n=== diff ===\n{diff}"))
}

#[derive(Clone, Debug, Serialize)]
pub struct SendDiffResult {
    pub tracked_files: usize,
    pub untracked_files: usize,
}

/// Bring a worktree's diff (committed + staged + unstaged + untracked)
/// into the project's main checkout as uncommitted changes. Lets the user
/// review/merge from their main repo without opening Fork inside the
/// worktree path. Hard-blocks if the main checkout is dirty — refusing
/// to mix is safer than trying to merge two sets of uncommitted work.
///
/// Mechanics:
///   1. tracked: `git diff --binary <base>` in the worktree, piped through
///      `git apply --3way --whitespace=nowarn` in the main checkout.
///      `--binary` keeps binary blobs intact; `--3way` falls back to a
///      three-way merge on lines that drifted in main.
///   2. untracked: enumerated via `git ls-files --others --exclude-standard`
///      in the worktree, copied byte-for-byte into the main checkout.
///      We honor .gitignore (that's what --exclude-standard does) so
///      build artifacts / .venv / node_modules don't get dragged in.
///
/// Skips tasks where `is_main_checkout` is true — those ARE the main
/// checkout, there's nothing to send.
#[tauri::command]
async fn task_send_diff_to_main(id: String) -> Result<SendDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SendDiffResult, String> {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no such task")?;
        let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("project missing")?;
        if w.is_main_checkout {
            return Err("This task IS the main checkout — nothing to send.".into());
        }
        let worktree = PathBuf::from(&w.path);
        let main = PathBuf::from(&p.root_path);
        if !main.is_dir() {
            return Err(format!("Project main checkout missing: {}", main.display()));
        }

        // Refuse to write into a dirty main checkout. Mixing two
        // half-finished change sets is the kind of thing the user
        // recovers from with `git stash` + tears. Surface this clearly
        // so they can stash/commit on their side first.
        let main_status = git(&["status", "--porcelain"], &main).map_err(|e| e.to_string())?;
        if !main_status.trim().is_empty() {
            return Err("Main checkout has uncommitted changes. Commit or stash there first, then retry.".into());
        }

        // ── tracked diff (committed + staged + unstaged vs base) ──
        // `git diff <base>` in a worktree returns the cumulative delta
        // between base and the working tree — exactly the union of
        // commits + staged + unstaged. --binary preserves binary blobs.
        let base = w.base_branch.clone();
        let patch_out = std::process::Command::new("git")
            .args(["--no-pager", "diff", "--binary", &base])
            .current_dir(&worktree)
            .output()
            .map_err(|e| format!("git diff failed to start: {e}"))?;
        if !patch_out.status.success() {
            return Err(format!(
                "git diff failed: {}",
                String::from_utf8_lossy(&patch_out.stderr)
            ));
        }
        let patch_bytes = patch_out.stdout;

        let mut tracked_files = 0usize;
        if !patch_bytes.is_empty() {
            // Count file headers in the patch (`diff --git a/x b/y`) so
            // the UI can report something concrete to the user.
            tracked_files = patch_bytes
                .windows(11)
                .filter(|w| w.starts_with(b"diff --git "))
                .count();

            use std::io::Write;
            let mut child = std::process::Command::new("git")
                .args(["apply", "--3way", "--whitespace=nowarn", "-"])
                .current_dir(&main)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("git apply failed to start: {e}"))?;
            {
                let stdin = child.stdin.as_mut().ok_or("apply: no stdin")?;
                stdin.write_all(&patch_bytes).map_err(|e| format!("apply: write: {e}"))?;
            }
            let out = child.wait_with_output().map_err(|e| format!("apply: wait: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "git apply failed in {}: {}",
                    main.display(),
                    String::from_utf8_lossy(&out.stderr)
                ));
            }
        }

        // ── untracked files (honoring .gitignore) ──
        // ls-files --others returns paths relative to the worktree
        // root. --exclude-standard applies repo + global + per-dir
        // gitignore so we don't drag in node_modules / .venv / etc.
        let untracked = git(
            &["ls-files", "--others", "--exclude-standard", "-z"],
            &worktree,
        )
        .map_err(|e| e.to_string())?;
        let mut untracked_files = 0usize;
        for rel in untracked.split('\0').filter(|s| !s.is_empty()) {
            // Defensive: ls-files should never emit `..` or absolute
            // paths here, but a malicious .gitignore + symlink trick
            // could in theory. Reuse the existing safety helper.
            let src = safe_task_path(&worktree, rel)
                .map_err(|e| format!("untracked path rejected: {e}"))?;
            let dst = main.join(rel);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            fs::copy(&src, &dst).map_err(|e| format!("copy {}: {e}", rel))?;
            untracked_files += 1;
        }

        Ok(SendDiffResult { tracked_files, untracked_files })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Debug, Serialize)]
pub struct ChangedFile {
    pub status: String, // "M", "A", "D", "??", "R", etc.
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ChangeGroup {
    /// Display name for the section header. Host = the project name;
    /// member = its `dir_name`.
    pub name: String,
    /// Current branch (live `git branch --show-current`). Useful for
    /// the per-member visibility ask — composition's frozen branch is
    /// only the create-time value; this catches the agent checking
    /// out something else inside the worktree.
    pub branch: String,
    /// "host" | "worktree" | "repo_root". The UI uses this to flag
    /// repo_root (live) groups + to disable click-to-diff for them
    /// (their files live outside the wrapper subtree, so the
    /// safe_task_path check would reject them).
    pub kind: String,
    /// Absolute path to the group's root on disk (wrapper for host,
    /// member subdir for member groups). Frontend only uses this for
    /// "Open in Finder" affordances.
    pub path: String,
    /// File paths are prefixed with `<dir_name>/` for member groups
    /// so they resolve under the wrapper root unchanged (clickable
    /// for worktree-mode members because the canonical path stays
    /// inside the wrapper subtree). Host group's paths stay
    /// unprefixed.
    pub files: Vec<ChangedFile>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct TaskChanges {
    /// Total file count across all groups. UI badge.
    pub count: usize,
    /// Flat list of host-only files. Kept for back-compat with any
    /// caller / UI bit that pre-dates the multi-repo split. New code
    /// should iterate `groups` instead.
    pub files: Vec<ChangedFile>,
    /// Per-repo groups. Single-repo tasks have one entry (host
    /// only); multi-repo tasks have one per composition member +
    /// the host. Empty for repo-root tasks (the user's living
    /// repo — surfacing its uncommitted changes here would be noise).
    pub groups: Vec<ChangeGroup>,
}

#[tauri::command]
fn task_changes(id: String) -> Result<TaskChanges, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;

    // Parse `git status --porcelain` into our ChangedFile shape.
    let parse = |out: &str| -> Vec<ChangedFile> {
        let mut files = Vec::new();
        for line in out.lines() {
            if line.len() < 4 { continue; }
            let status = line[..2].trim().to_string();
            let path = line[3..].to_string();
            files.push(ChangedFile { status, path });
        }
        files
    };
    let head = |p: &Path| -> String {
        git(&["branch", "--show-current"], p)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };

    // Host group: always present. Run git status at the task
    // path itself (= wrapper for multi, = worktree for single).
    // -uall lists files inside brand-new untracked dirs individually
    // (without it git collapses them to a single "dir/" entry).
    let host_out = git(&["status", "--porcelain", "-uall"], Path::new(&w.path))
        .map_err(|e| e.to_string())?;
    let host_files = parse(&host_out);
    let host_name = load_projects().into_iter()
        .find(|p| p.id == w.project_id)
        .map(|p| p.name)
        .unwrap_or_else(|| w.name.clone());
    let host_group = ChangeGroup {
        name: host_name,
        branch: head(Path::new(&w.path)),
        kind: "host".to_string(),
        path: w.path.clone(),
        files: host_files.clone(),
    };

    // Member groups: only for multi-repo tasks. For each member,
    // run git status in its dir (worktree mode → real worktree;
    // repo_root → symlinked live checkout) and prefix file paths
    // with `<dir_name>/` so they resolve correctly from the wrapper.
    let mut groups = vec![host_group];
    for m in &w.composition {
        // For worktree-mode, member.path is the wrapper-subdir
        // worktree. For repo_root, it's the live checkout (symlink
        // target). Both have a valid .git so `git status` just works.
        let member_path = Path::new(&m.path);
        if !member_path.exists() { continue; }
        let member_out = git(&["status", "--porcelain", "-uall"], member_path)
            .unwrap_or_default();
        let mut member_files = parse(&member_out);
        for f in &mut member_files {
            f.path = format!("{}/{}", m.dir_name, f.path);
        }
        let kind = match m.mode {
            MemberMode::Worktree => "worktree",
            MemberMode::RepoRoot => "repo_root",
        }.to_string();
        groups.push(ChangeGroup {
            name: m.dir_name.clone(),
            branch: head(member_path),
            kind,
            path: m.path.clone(),
            files: member_files,
        });
    }

    let count: usize = groups.iter().map(|g| g.files.len()).sum();
    Ok(TaskChanges { count, files: host_files, groups })
}

// ─────────────────────────── git staging ───────────────────────────
//
// Fork-style staged/unstaged split + stage / unstage / commit. Unlike
// `task_changes` (which collapses the two porcelain status columns
// into one and prefixes member paths with `<dir_name>/`), these keep the
// index column and the worktree column separate and return paths
// *relative to their own repo* — staging needs the repo-relative path and
// the repo's own cwd. The frontend re-prefixes with `dir_name` only when
// it opens a member diff.

#[derive(Clone, Debug, Serialize)]
pub struct GitFile {
    /// Single-character status for this side: index status for staged
    /// entries (M/A/D/R/C), worktree status for unstaged (M/D), or "?"
    /// for untracked.
    pub status: String,
    pub path: String,
    /// Cheap content fingerprint (`mtime_nanos:len`) of the working-tree
    /// file, empty when it can't be stat'd (e.g. a deletion). The frontend
    /// stashes this when a file is marked "viewed" so it can auto-clear the
    /// mark once the agent touches the file again (the fingerprint moves).
    #[serde(default)]
    pub fp: String,
}

/// Cheap working-tree fingerprint for change detection: modification time
/// (nanos since the epoch) plus byte length. Empty when the path can't be
/// stat'd (deleted file, permission error) — callers treat that as "no
/// fingerprint", never as a match.
fn file_fp(p: &Path) -> String {
    match std::fs::metadata(p) {
        Ok(m) => {
            let mt = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}:{}", mt, m.len())
        }
        Err(_) => String::new(),
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GitRepo {
    /// Display name: host = project name, member = its dir_name.
    pub name: String,
    pub branch: String,
    /// "host" | "worktree" | "repo_root".
    pub kind: String,
    /// "" for the host repo, the member's dir_name otherwise. Routes
    /// stage/unstage/commit to the right git cwd.
    pub dir_name: String,
    pub staged: Vec<GitFile>,
    pub unstaged: Vec<GitFile>,
    /// Unique changed-path count across both lists (a file that is both
    /// staged and unstaged counts once). Drives the sub-tab pill badge.
    pub changed: usize,
    /// `git log -1 --pretty=%B` for the repo, so the frontend can
    /// prefill the commit form when the user ticks Amend. Empty on an
    /// unborn branch (no commits yet).
    pub last_commit_message: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct GitStatus {
    pub repos: Vec<GitRepo>,
    /// Sum of every repo's `changed`. Drives the Git tab's total badge.
    pub total_changed: usize,
    /// Number of repos with at least one change. Drives the Git tab's
    /// repos badge (only shown when > 1).
    pub repos_changed: usize,
}

/// Split a `git status --porcelain` line into (optional staged, optional
/// unstaged) entries. Porcelain format is `XY <path>` where X is the
/// index column and Y the worktree column.
fn parse_porcelain_line(line: &str) -> (Option<GitFile>, Option<GitFile>) {
    if line.len() < 4 {
        return (None, None);
    }
    let x = &line[0..1];
    let y = &line[1..2];
    let raw = &line[3..];
    // Renames/copies render as "old -> new"; keep the new path (what's
    // on disk + what `git add` expects).
    let path = raw.rsplit(" -> ").next().unwrap_or(raw).to_string();

    // Untracked: both columns are "?". Treat as a single unstaged add.
    if x == "?" {
        return (None, Some(GitFile { status: "?".into(), path, fp: String::new() }));
    }

    let staged = if x != " " {
        Some(GitFile { status: x.into(), path: path.clone(), fp: String::new() })
    } else {
        None
    };
    let unstaged = if y != " " {
        Some(GitFile { status: y.into(), path, fp: String::new() })
    } else {
        None
    };
    (staged, unstaged)
}

#[tauri::command]
async fn task_git_status(id: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;

        let branch_of = |p: &Path| -> String {
            git(&["branch", "--show-current"], p).map(|s| s.trim().to_string()).unwrap_or_default()
        };
        let last_msg = |p: &Path| -> String {
            git(&["log", "-1", "--pretty=%B"], p).map(|s| s.trim_end().to_string()).unwrap_or_default()
        };
        let build = |name: String, dir_name: String, kind: &str, p: &Path| -> GitRepo {
            // -uall expands untracked DIRECTORIES into their individual files.
            // Without it git collapses a brand-new folder to a single
            // "docs/foo/" entry (trailing slash = directory), which the UI
            // then treats as a file: blank name in the tree, empty diff.
            let out = git(&["status", "--porcelain", "-uall"], p).unwrap_or_default();
            let mut staged = Vec::new();
            let mut unstaged = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for line in out.lines() {
                let (s, u) = parse_porcelain_line(line);
                // One stat per changed line (the set is small), reused for the
                // staged + unstaged halves of the same path.
                let rel = s.as_ref().or(u.as_ref()).map(|f| f.path.clone());
                let fp = rel.as_deref().map(|r| file_fp(&p.join(r))).unwrap_or_default();
                if let Some(mut f) = s { f.fp = fp.clone(); seen.insert(f.path.clone()); staged.push(f); }
                if let Some(mut f) = u { f.fp = fp;          seen.insert(f.path.clone()); unstaged.push(f); }
            }
            GitRepo {
                name, branch: branch_of(p), kind: kind.to_string(), dir_name,
                changed: seen.len(),
                last_commit_message: last_msg(p),
                staged, unstaged,
            }
        };

        let host_name = load_projects().into_iter()
            .find(|p| p.id == w.project_id)
            .map(|p| p.name)
            .unwrap_or_else(|| w.name.clone());
        let mut repos = vec![build(host_name, String::new(), "host", Path::new(&w.path))];

        for m in &w.composition {
            let member_path = Path::new(&m.path);
            if !member_path.exists() { continue; }
            let kind = match m.mode {
                MemberMode::Worktree => "worktree",
                MemberMode::RepoRoot => "repo_root",
            };
            repos.push(build(m.dir_name.clone(), m.dir_name.clone(), kind, member_path));
        }

        let total_changed = repos.iter().map(|r| r.changed).sum();
        let repos_changed = repos.iter().filter(|r| r.changed > 0).count();
        Ok(GitStatus { repos, total_changed, repos_changed })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve the git cwd for a stage/commit op: the host task path
/// when `dir_name` is empty, otherwise the matching composition member.
fn repo_cwd(w: &Task, dir_name: &str) -> Result<PathBuf, String> {
    if dir_name.is_empty() {
        return Ok(PathBuf::from(&w.path));
    }
    w.composition.iter()
        .find(|m| m.dir_name == dir_name)
        .map(|m| PathBuf::from(&m.path))
        .ok_or_else(|| format!("no member repo '{dir_name}'"))
}

#[tauri::command]
async fn task_stage(id: String, dir_name: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
        let cwd = repo_cwd(&w, &dir_name)?;
        if paths.is_empty() { return Ok(()); }
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git(&args, &cwd).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn task_unstage(id: String, dir_name: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
        let cwd = repo_cwd(&w, &dir_name)?;
        if paths.is_empty() { return Ok(()); }
        let mut args: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git(&args, &cwd).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn task_commit(
    id: String, dir_name: String, subject: String, body: String, amend: bool, push: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
        let cwd = repo_cwd(&w, &dir_name)?;

        let subject = subject.trim().to_string();
        if subject.is_empty() {
            return Err("commit subject is required".to_string());
        }
        let body = body.trim().to_string();

        let mut args: Vec<&str> = vec!["commit"];
        if amend { args.push("--amend"); }
        args.push("-m"); args.push(&subject);
        if !body.is_empty() { args.push("-m"); args.push(&body); }
        git(&args, &cwd).map_err(|e| e.to_string())?;

        if push {
            // Try a plain push first (upstream already set). If it fails
            // (most commonly: no upstream for a fresh worktree branch),
            // fall back to `-u <remote> <branch>` to set it.
            if git(&["push"], &cwd).is_err() {
                let remote = detect_default_remote(&cwd);
                let branch = git(&["branch", "--show-current"], &cwd)
                    .map_err(|e| e.to_string())?.trim().to_string();
                if branch.is_empty() {
                    return Err("cannot push: detached HEAD".to_string());
                }
                git(&["push", "-u", &remote, &branch], &cwd).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Discard working-tree changes for the given paths in a repo. Tracked
/// files are restored to HEAD (`git checkout HEAD -- <path>`, wiping both
/// staged and unstaged edits); untracked files are deleted from disk.
/// Destructive + irreversible — the frontend gates it behind a confirm.
#[tauri::command]
async fn task_discard(id: String, dir_name: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
        let cwd = repo_cwd(&w, &dir_name)?;
        for p in &paths {
            // `git ls-files --error-unmatch` exits non-zero for untracked
            // (and ignored) paths — use it to branch restore vs delete.
            let tracked = git(&["ls-files", "--error-unmatch", "--", p], &cwd).is_ok();
            if tracked {
                git(&["checkout", "HEAD", "--", p], &cwd).map_err(|e| e.to_string())?;
            } else {
                let abs = cwd.join(p);
                if abs.is_dir() { let _ = fs::remove_dir_all(&abs); }
                else { let _ = fs::remove_file(&abs); }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve a renderer-supplied path against a task root and verify the
/// result is contained within it. Rejects absolute paths and `..` segments
/// up front so attempts like `/etc/passwd` or `../../foo` fail loudly
/// instead of being silently joined. Canonicalizes both ends so a symlink
/// pointing outside the worktree also fails the contains check.
///
/// **MUST** be used for every renderer → filesystem read inside a task
/// (file_read, file_diff, future watchers). Without it, untrusted paths
/// from the webview could read arbitrary text files on disk.
/// Structural validation shared by every task-relative path resolver:
/// rejects absolute paths and literal `..` segments up front, before any
/// filesystem call. Attempts like `/etc/passwd` or `../../foo` fail loudly
/// instead of being silently joined.
fn reject_escaping_segments(rel: &str) -> Result<PathBuf, String> {
    let pb = Path::new(rel);
    if pb.is_absolute() {
        return Err(format!("absolute paths not allowed: {rel}"));
    }
    if pb.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("`..` segments not allowed: {rel}"));
    }
    Ok(pb.to_path_buf())
}

/// Resolve a renderer-supplied path against a workspace root and verify the
/// result is contained within it. Canonicalizes both ends so a symlink
/// pointing outside the worktree also fails the contains check.
///
/// **MUST** be used for every renderer → filesystem read inside a task
/// (file_read, file_diff, future watchers). Without it, untrusted paths
/// from the webview could read arbitrary text files on disk.
fn safe_task_path(ws_path: &Path, rel: &str) -> Result<PathBuf, String> {
    let pb = reject_escaping_segments(rel)?;
    let target = ws_path.join(&pb);
    let canon_base = fs::canonicalize(ws_path).map_err(|e| e.to_string())?;
    let canon_target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_base) {
        return Err(format!("path escapes task: {rel}"));
    }
    Ok(canon_target)
}

#[derive(Serialize)]
struct PathStat {
    exists: bool,
    is_dir: bool,
}

/// Does a task-relative path exist, and is it a directory? Used by the
/// markdown preview's link click handler before opening a tab or revealing
/// in the file manager, so a dead link shows a visible "not found" instead
/// of a blank/broken tab, and a directory link reveals instead of trying to
/// open as text.
///
/// `fs::canonicalize` errors on any path that doesn't exist, so a missing
/// target (the exact case this command exists to report) can't be
/// containment-checked the way `safe_task_path` does. This resolves the
/// containment check AND the final exists/is_dir answer from the SAME
/// canonicalized path in one pass — critically, the is_dir metadata call
/// below stats the canonical (symlink-resolved, already-verified) path, not
/// the original possibly-symlinked one, so a symlink swapped in between the
/// two calls can't smuggle an out-of-task answer past the check that
/// just ran (the TOCTOU pattern `read_capped_file` is careful to avoid).
/// When the target doesn't exist, walks up to the nearest EXISTING ancestor
/// and canonicalizes THAT instead — sufficient to catch a symlink escape (a
/// symlink has to actually exist to redirect anything), and the walk always
/// terminates at `ws_path` itself, which does exist.
fn check_task_path_existence(ws_path: &Path, rel: &str) -> Result<PathStat, String> {
    let pb = reject_escaping_segments(rel)?;
    let target = ws_path.join(&pb);
    let canon_base = fs::canonicalize(ws_path).map_err(|e| e.to_string())?;
    if let Ok(canon) = fs::canonicalize(&target) {
        if !canon.starts_with(&canon_base) {
            return Err(format!("path escapes task: {rel}"));
        }
        let is_dir = fs::metadata(&canon).map(|m| m.is_dir()).unwrap_or(false);
        return Ok(PathStat { exists: true, is_dir });
    }
    let mut probe: &Path = &target;
    loop {
        match probe.parent() {
            Some(p) if !p.as_os_str().is_empty() && p != probe => probe = p,
            _ => break, // exhausted ancestors without finding one that exists (shouldn't happen: ws_path itself always exists)
        }
        if probe.exists() {
            let canon = fs::canonicalize(probe).map_err(|e| e.to_string())?;
            if !canon.starts_with(&canon_base) {
                return Err(format!("path escapes task: {rel}"));
            }
            break;
        }
    }
    Ok(PathStat { exists: false, is_dir: false })
}

#[tauri::command]
fn task_path_stat(id: String, path: String) -> Result<PathStat, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    // Unlike a diff/read, "is this a directory" is a sensible question for a
    // path that's exactly a composition member's own root (e.g. a markdown
    // link's `..`/`/` resolves there per resolveTaskHref's member-floor
    // scoping) — allow it rather than erroring.
    let (cwd, rel) = resolve_task_git_path_ex(&w, &path, true)?;
    check_task_path_existence(&cwd, &rel)
}

/// Read `abs` capped at `cap` bytes, TOCTOU-safe: the size/type check runs
/// against an `fstat` on the already-OPEN handle (not a separate path-based
/// `metadata()` call), so a swap between the check and the read (symlink
/// retarget, truncate-and-replace) can't smuggle a larger or non-regular
/// file past the cap. `Read::take(cap + 1)` bounds the actual read
/// regardless of what fstat reported, so a file that grows mid-read past
/// the point fstat saw still gets capped rather than fully buffered.
fn read_capped_file(abs: &Path, cap: u64) -> Result<Vec<u8>, String> {
    let f = fs::File::open(abs).map_err(|e| format!("open failed: {e}"))?;
    let meta = f.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("not a file: {}", abs.display()));
    }
    if meta.len() > cap {
        return Err(format!("file too large to preview ({} bytes)", meta.len()));
    }
    let mut buf = Vec::with_capacity((meta.len() as usize).min(cap as usize));
    f.take(cap + 1).read_to_end(&mut buf).map_err(|e| format!("read failed: {e}"))?;
    if buf.len() as u64 > cap {
        return Err(format!("file too large to preview (>{cap} bytes)"));
    }
    Ok(buf)
}

#[tauri::command]
fn task_file_read(id: String, path: String) -> Result<String, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    // Member-aware: a `<dir_name>/…` path resolves inside that member's repo
    // (which may live outside the wrapper for repo_root members), matching
    // the diff/finder/grep path scheme.
    let (cwd, rel) = resolve_task_git_path(&w, &path)?;
    let abs = safe_task_path(&cwd, &rel)?;
    // Refuse binary or huge files for now — viewer is text-only.
    let bytes = read_capped_file(&abs, 2_000_000)?;
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

/// Mime type by extension for images/PDFs the markdown preview or file-tree
/// preview pane may embed. Kept in sync by hand with `BINARY_LINK_RE` in
/// markdownPaths.ts (the frontend link handler's "editor can't render this,
/// reveal it in the file manager instead" list) — that list is broader (adds
/// archives/media), this one is the subset the base64 channel accepts.
/// Unknown extensions are rejected here so this stays a preview channel, not
/// a generic binary read wider than the preview needs. SVG is safe in this
/// context: the preview only ever renders it via `<img src="data:...">`,
/// where embedded scripts never execute.
fn preview_mime_for_ext(p: &Path) -> Option<&'static str> {
    match p.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

/// Result of `task_file_read_base64`. `unchanged` short-circuits the
/// common case (an agent settle re-validating every image in every mounted
/// preview): when the caller's `known_fp` still matches the file's current
/// `mtime:len` fingerprint, `mime`/`data` are omitted entirely — the
/// frontend keeps its cached bytes instead of paying for a full read +
/// base64 encode of an unchanged multi-MB image. `fp` is always populated
/// (even on a fresh read) so the frontend has something to send next time.
#[derive(Serialize)]
struct Base64Read {
    unchanged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    fp: String,
}

/// Same member-aware resolution + worktree containment as `task_file_read`,
/// plus an image/PDF extension whitelist and a 20 MB cap. Split from the
/// `#[tauri::command]` wrapper (mirroring `task_file_diff_sides_for_task`)
/// so tests can exercise it with an in-memory `Task` instead of
/// `load_tasks()`.
fn task_file_read_base64_for_task(w: &Task, path: &str, known_fp: Option<&str>) -> Result<Base64Read, String> {
    use base64::Engine as _;
    let (cwd, rel) = resolve_task_git_path(w, path)?;
    let abs = safe_task_path(&cwd, &rel)?;
    let mime = preview_mime_for_ext(&abs).ok_or_else(|| format!("not previewable: {path}"))?;
    // Cheap pre-read stat: if it matches what the caller already has
    // cached, skip the read + base64 encode entirely. Only bother when
    // there's a known_fp to compare against — a first load (no cache
    // yet) has nothing to match, so skip this stat rather than pay for
    // one that can never short-circuit anything. An empty current fp
    // means the file is missing/unreadable — always fall through to the
    // real read below so its error path (not a silent "unchanged") fires.
    if let Some(known) = known_fp {
        let current_fp = file_fp(&abs);
        if !current_fp.is_empty() && known == current_fp {
            return Ok(Base64Read { unchanged: true, mime: None, data: None, fp: current_fp });
        }
    }
    let bytes = read_capped_file(&abs, 20_000_000)?;
    // Re-stat AFTER the read so `fp` is correlated with the bytes just
    // returned (not the pre-read snapshot, which a concurrent write
    // could have already invalidated).
    let fp = file_fp(&abs);
    Ok(Base64Read {
        unchanged: false,
        mime: Some(mime.to_string()),
        data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        fp,
    })
}

/// Read a task image or PDF as base64 for the markdown preview / file-tree
/// preview pane, or confirm it's unchanged since `known_fp` (see
/// `Base64Read`). Async + spawn_blocking because a multi-MB read IS the
/// heavy-IO case the IPC discipline targets (unlike the 2 MB-capped text
/// read above).
#[tauri::command]
async fn task_file_read_base64(id: String, path: String, known_fp: Option<String>) -> Result<Base64Read, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
        task_file_read_base64_for_task(&w, &path, known_fp.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read an allowlisted preview file (image/PDF) as raw bytes + mime, reusing
/// the SAME member-aware resolution, worktree containment, extension
/// allowlist, and 20 MB cap as `task_file_read_base64_for_task` — just
/// without the base64 encode. Split from the `load_tasks()` lookup (mirroring
/// `task_file_read_base64_for_task`) so tests can exercise it with an
/// in-memory `Task`.
fn read_preview_file_for_task(w: &Task, path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (cwd, rel) = resolve_task_git_path(w, path)?;
    let abs = safe_task_path(&cwd, &rel)?;
    let mime = preview_mime_for_ext(&abs).ok_or_else(|| format!("not previewable: {path}"))?;
    let bytes = read_capped_file(&abs, 20_000_000)?;
    Ok((bytes, mime))
}

/// `read_preview_file_for_task` for the `taskpdf:` URI-scheme handler, which
/// only has the task id from the URL. Backs `taskpdf_response` below.
fn read_preview_file(id: &str, path: &str) -> Result<(Vec<u8>, &'static str), String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    read_preview_file_for_task(&w, path)
}

/// Build the HTTP response for a `taskpdf://localhost/<enc id>/<enc path>`
/// request (the `?v=` cache-buster is ignored here — it only forces WKWebView
/// to re-fetch after an agent-settle rewrite). WKWebView renders a PDF served
/// as a real `application/pdf` resource natively; a `data:` URL renders blank,
/// which is why the file-tree preview streams PDFs through this scheme instead
/// of the base64 channel. All the same containment/allowlist/cap checks apply
/// via `read_preview_file`; a rejected path becomes a 404, not an open channel.
fn taskpdf_response(uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    use percent_encoding::percent_decode_str;
    use tauri::http::{Response, StatusCode};
    let empty = |code: StatusCode| Response::builder().status(code).body(Vec::new()).unwrap();
    // `<id>` and `<path>` are each encodeURIComponent'd on the frontend, so
    // the path segment never contains a literal '/', and this split is exact.
    let Some((id_enc, path_enc)) = uri_path.trim_start_matches('/').split_once('/') else {
        return empty(StatusCode::BAD_REQUEST);
    };
    let id = percent_decode_str(id_enc).decode_utf8_lossy().into_owned();
    let path = percent_decode_str(path_enc).decode_utf8_lossy().into_owned();
    match read_preview_file(&id, &path) {
        Ok((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            // Read-only preview; never let the webview serve a stale copy after
            // the `?v=` buster changes (agent rewrote the file on disk).
            .header("Cache-Control", "no-store")
            .body(bytes)
            .unwrap(),
        Err(_) => empty(StatusCode::NOT_FOUND),
    }
}

/// Overwrite a task file with new contents (editor save). The
/// path is constrained to the worktree by `safe_task_path`, same
/// as the read side. Synchronous to mirror `task_file_read` — a
/// single text file (capped at 2 MB on read) is not the heavy-IO case
/// the spawn_blocking discipline targets.
#[tauri::command]
fn task_file_write(id: String, path: String, content: String) -> Result<(), String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    let (cwd, rel) = resolve_task_git_path(&w, &path)?;
    let abs = safe_task_path(&cwd, &rel)?;
    fs::write(&abs, content).map_err(|e| format!("write failed: {e}"))
}

/// Rename a file or directory in the task (file-tree context menu).
/// `new_name` is a bare name (no path separators) — the entry stays in its
/// current directory. Member-aware + constrained to the worktree via
/// `safe_task_path`. Returns the new task-relative path so the
/// caller can update an open tab / re-select the row.
#[tauri::command]
fn task_path_rename(id: String, path: String, new_name: String) -> Result<String, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    let trimmed = new_name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed == "." || trimmed == ".." {
        return Err(format!("invalid name: {new_name:?}"));
    }
    let (cwd, rel) = resolve_task_git_path(&w, &path)?;
    let abs = safe_task_path(&cwd, &rel)?;
    let parent = abs.parent().ok_or("no parent directory")?;
    let dest = parent.join(trimmed);
    if dest.exists() {
        return Err(format!("\"{trimmed}\" already exists here"));
    }
    fs::rename(&abs, &dest).map_err(|e| format!("rename failed: {e}"))?;
    // Rebuild the task-relative path: swap the last segment of the
    // INBOUND `path` (which keeps any `<member>/` prefix) for the new name.
    let new_rel = match path.rsplit_once('/') {
        Some((head, _)) => format!("{head}/{trimmed}"),
        None => trimmed.to_string(),
    };
    Ok(new_rel)
}

/// Delete a file or directory in the task (file-tree context menu).
/// Permanent (no trash) — the caller confirms first. Directories delete
/// recursively. Member-aware + worktree-constrained.
#[tauri::command]
fn task_path_delete(id: String, path: String) -> Result<(), String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    let (cwd, rel) = resolve_task_git_path(&w, &path)?;
    let abs = safe_task_path(&cwd, &rel)?;
    let meta = fs::symlink_metadata(&abs).map_err(|e| format!("stat failed: {e}"))?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(&abs).map_err(|e| format!("delete failed: {e}"))
    } else {
        fs::remove_file(&abs).map_err(|e| format!("delete failed: {e}"))
    }
}

/// Reveal a task entry in the OS file manager ("Show in Finder").
/// Resolves the absolute path server-side (member-aware) so the frontend
/// doesn't have to reconstruct paths for members that live outside the
/// wrapper. macOS selects the item; Windows selects it; Linux opens the
/// containing folder (no portable "select" verb).
#[tauri::command]
fn task_reveal_path(id: String, path: String) -> Result<(), String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    // Revealing a directory (including a composition member's own root) is
    // meaningful here, unlike for a diff/read — allow the bare-member-root case.
    let (cwd, rel) = resolve_task_git_path_ex(&w, &path, true)?;
    let abs = safe_task_path(&cwd, &rel)?;
    let target = abs.to_string_lossy().into_owned();
    let (program, args) = reveal_command(std::env::consts::OS, &target);
    Command::new(program).args(&args).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// argv to reveal `target` in the OS file manager, selecting it where the
/// platform supports it. Split out for the same testability reason as
/// `open_command`.
fn reveal_command(os: &str, target: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec!["-R".to_string(), target.to_string()]),
        // explorer /select,<path> opens the folder with the item highlighted.
        "windows" => ("explorer", vec![format!("/select,{target}")]),
        // No portable freedesktop "select" verb — open the containing dir.
        _ => {
            let dir = Path::new(target).parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| target.to_string());
            ("xdg-open", vec![dir])
        }
    }
}

/// Return the (original, modified) sides of a tracked file so a
/// language-aware diff viewer can render them side-by-side with
/// syntax highlighting. Original = `git show HEAD:<path>` (empty
/// for untracked); modified = current on-disk content (empty if
/// deleted in the worktree).
#[derive(Serialize)]
struct FileDiffSides {
    original: String,
    modified: String,
    /// Whether each side actually exists (and is readable as UTF-8): the
    /// content strings are "" both for a MISSING side and for an EMPTY
    /// file, so the frontend's one-sided detection needs these to avoid
    /// misclassifying a truncated-to-empty file as "new or deleted".
    original_exists: bool,
    modified_exists: bool,
    /// Working-tree fingerprint (`mtime_nanos:len`) of the modified file,
    /// empty for a deletion. Lets the diff pane's "Viewed" toggle anchor to
    /// the same fingerprint the Git panel rows use (store/fileViewed.ts).
    #[serde(default)]
    fp: String,
}

/// Resolve a task-relative path to (member cwd, path relative to that
/// cwd), member-aware: a `<dir_name>/…` path resolves inside that member's
/// own repo (which may live outside the wrapper for repo_root members). A
/// path equal to exactly `dir_name` (no remainder) is the member's OWN
/// root — diff/read callers reject that (a diff/read needs a file, not a
/// directory); `allow_bare_member_root` lets a caller that's fine with a
/// directory (stat, reveal-in-file-manager) opt in instead.
fn resolve_task_git_path_ex(w: &Task, path: &str, allow_bare_member_root: bool) -> Result<(PathBuf, String), String> {
    if let Some((member, remainder)) = w.composition.iter().find_map(|m| {
        if path == m.dir_name {
            Some((m, ""))
        } else if let Some(rest) = path.strip_prefix(&format!("{}/", m.dir_name)) {
            Some((m, rest))
        } else {
            None
        }
    }) {
        if remainder.is_empty() && !allow_bare_member_root {
            return Err(format!("diff path must point to a file inside member '{}': {path}", member.dir_name));
        }
        return Ok((PathBuf::from(&member.path), remainder.to_string()));
    }
    Ok((PathBuf::from(&w.path), path.to_string()))
}

fn resolve_task_git_path(w: &Task, path: &str) -> Result<(PathBuf, String), String> {
    resolve_task_git_path_ex(w, path, false)
}

fn task_file_diff_sides_for_task(w: &Task, path: &str) -> Result<FileDiffSides, String> {
    let (cwd, rel_path) = resolve_task_git_path(w, path)?;
    // `git show` fails for a path not in HEAD (untracked/added file);
    // read_to_string fails for non-UTF8. Either way the side is
    // unrenderable → exists=false, content "".
    let original = git(&["--no-pager", "show", &format!("HEAD:{rel_path}")], &cwd).ok();
    let modified_path = safe_task_path(&cwd, &rel_path).ok();
    let modified = match &modified_path {
        Some(p) if p.exists() => fs::read_to_string(p).ok(),
        _ => None,
    };
    let fp = modified_path.as_deref().map(file_fp).unwrap_or_default();
    Ok(FileDiffSides {
        original_exists: original.is_some(),
        modified_exists: modified.is_some(),
        original: original.unwrap_or_default(),
        modified: modified.unwrap_or_default(),
        fp,
    })
}

fn task_file_diff_for_task(w: &Task, path: &str) -> Result<String, String> {
    let (cwd, rel_path) = resolve_task_git_path(w, path)?;
    // Tracked diff is safe because the path is forwarded to `git -C cwd diff`
    // which already constrains paths to the working tree. The untracked
    // fallback below DOES read straight from disk, so for THAT branch we
    // safe-resolve before reading.
    let tracked_diff = git(&["--no-pager", "diff", "HEAD", "--", &rel_path], &cwd)
        .unwrap_or_default();
    if !tracked_diff.trim().is_empty() {
        return Ok(tracked_diff);
    }
    // Maybe it's untracked — synthesize a "new file" diff.
    let abs = match safe_task_path(&cwd, &rel_path) {
        Ok(p) => p,
        Err(_) => return Ok(String::new()),
    };
    if abs.exists() {
        if let Ok(content) = fs::read_to_string(&abs) {
            let mut out = String::new();
            out.push_str(&format!("diff --git a/{p} b/{p}\n", p = path));
            out.push_str(&format!("new file\n--- /dev/null\n+++ b/{p}\n", p = path));
            let lines: Vec<&str> = content.lines().collect();
            out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
            for ln in &lines {
                out.push('+');
                out.push_str(ln);
                out.push('\n');
            }
            return Ok(out);
        }
    }
    Ok(String::new())
}

#[tauri::command]
fn task_file_diff_sides(id: String, path: String) -> Result<FileDiffSides, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    task_file_diff_sides_for_task(&w, &path)
}

#[tauri::command]
fn task_file_diff(id: String, path: String) -> Result<String, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    task_file_diff_for_task(&w, &path)
}

#[tauri::command]
fn task_files(id: String) -> Result<Vec<String>, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&w.path) {
        for e in rd.flatten() {
            if let Some(n) = e.file_name().to_str() {
                out.push(n.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[derive(Clone, Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Compile the effective file-tree exclude globs for one repo: the user's
/// personal (global Settings) list ∪ that repo's committed `.termic.yaml`
/// `exclude`. Invalid patterns are skipped; a trailing `/` is stripped so
/// `build/` matches the `build` entry. Shared by the file tree and the ⌘P
/// finder so "hidden files" means the same thing in both.
fn compile_exclude_patterns(repo_path: &str) -> Vec<glob::Pattern> {
    let mut raw = load_settings_inner().file_tree_exclude;
    // OS filesystem junk nobody browses: always hidden, like `.git`. Baked in
    // here (not the settings default) so it applies to existing installs too.
    raw.push(".DS_Store".to_string());
    if !repo_path.is_empty() {
        raw.extend(repo_config::load_or_default(Path::new(repo_path)).exclude);
    }
    raw.iter()
        .filter_map(|s| {
            let t = s.trim().trim_end_matches('/');
            if t.is_empty() { None } else { glob::Pattern::new(t).ok() }
        })
        .collect()
}

/// Source repo path for a composition member: inline `repo_path` on new
/// records, or the legacy `project_id` reference resolved against
/// projects.json for tasks created before members went inline.
fn member_repo_path(m: &TaskMember) -> String {
    if !m.repo_path.is_empty() { return m.repo_path.clone(); }
    load_projects().into_iter().find(|p| p.id == m.project_id)
        .map(|p| p.root_path).unwrap_or_default()
}

/// True if a repo-local path is hidden by the exclude globs: a match on ANY
/// path segment (so `node_modules` / `*.pyc` hide at any depth, including the
/// flat finder list) OR on the whole repo-local path (so `docs/build` works).
fn path_is_excluded(patterns: &[glob::Pattern], repo_local_path: &str) -> bool {
    if patterns.is_empty() {
        return false;
    }
    repo_local_path
        .split('/')
        .any(|seg| patterns.iter().any(|p| p.matches(seg)))
        || patterns.iter().any(|p| p.matches(repo_local_path))
}

/// List entries inside a directory, relative to the task root. `rel`
/// of "" returns the task's top level. Refuses to traverse outside the
/// task (no `..` segments allowed). Returns `is_dir` directly so the UI
/// doesn't have to guess by extension. Async + spawn_blocking: it reads
/// settings/projects/.termic.yaml off the IPC/WebView thread.
#[tauri::command]
async fn task_dir_list(id: String, rel: String, heal: bool) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || task_dir_list_sync(id, rel, heal))
        .await
        .map_err(|e| e.to_string())?
}

fn task_dir_list_sync(id: String, rel: String, heal: bool) -> Result<Vec<FileEntry>, String> {
    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
    let base = PathBuf::from(&w.path);
    // Multi-repo: when the relative path enters a composition member
    // (e.g. "pydpf" or "pydpf/src"), resolve under that member's real
    // path instead of going through safe_task_path — which would
    // canonicalize the symlink-to-real-checkout and reject as "escapes
    // task". The member is a first-class browseable subtree.
    // Which composition member (if any) owns the directory being listed, plus
    // the path RELATIVE TO THAT member's root — used both to resolve the dir
    // and to scope/evaluate the member's excludes member-locally.
    let member_hit: Option<(&TaskMember, String)> = if rel.is_empty() {
        None
    } else {
        w.composition.iter().find_map(|m| {
            if rel == m.dir_name {
                Some((m, String::new()))
            } else if let Some(rest) = rel.strip_prefix(&format!("{}/", m.dir_name)) {
                Some((m, rest.to_string()))
            } else {
                None
            }
        })
    };
    let canon_target = if rel.is_empty() {
        fs::canonicalize(&base).map_err(|e| e.to_string())?
    } else if let Some((member, remainder)) = &member_hit {
        let mp = PathBuf::from(&member.path);
        if remainder.is_empty() {
            fs::canonicalize(&mp).map_err(|e| e.to_string())?
        } else {
            safe_task_path(&mp, remainder)?
        }
    } else {
        safe_task_path(&base, &rel)?
    };
    // The repo that owns this directory + the path relative to its root.
    let (owner_repo_path, local_rel): (String, &str) = match &member_hit {
        Some((m, remainder)) => (member_repo_path(m), remainder.as_str()),
        None => (
            load_projects().into_iter().find(|p| p.id == w.project_id)
                .map(|p| p.root_path).unwrap_or_default(),
            rel.as_str(),
        ),
    };
    // Excludes: personal (global Settings) ∪ ONLY the owning repo's committed
    // `.termic.yaml`. A member repo's patterns must not hide sibling/host files.
    let exclude_patterns = compile_exclude_patterns(&owner_repo_path);

    let mut out = Vec::new();
    let rd = fs::read_dir(&canon_target).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = match e.file_name().into_string() { Ok(s) => s, Err(_) => continue };
        // Always hide .git — it's repo plumbing, never something the
        // user wants to browse in the file tree.
        if name == ".git" { continue; }
        // Member dirs at the root are first-class subtrees — never hide them
        // with the HOST repo's patterns (a host `dist`/`target` exclude must
        // not drop a member repo that happens to share the name).
        // Primary check: the frozen composition in the task JSON.
        // Fallback: any symlink at the task root is a member repo symlink
        // placed there by task_open_repo — protect it regardless of
        // whether the composition list is current (e.g. after a member rename).
        let is_symlink_at_root = rel.is_empty()
            && e.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        let is_member_dir = rel.is_empty() && (
            w.composition.iter().any(|m| m.dir_name == name)
            || is_symlink_at_root
        );
        if !is_member_dir {
            let local_path = if local_rel.is_empty() { name.clone() } else { format!("{local_rel}/{name}") };
            if path_is_excluded(&exclude_patterns, &local_path) { continue; }
        }
        // file_type() reports a symlink-to-dir as Symlink, not Dir, which would
        // make member symlinks (repo_root mode) render as files. DirEntry::
        // metadata() also DOES NOT traverse symlinks, so fall back to
        // std::fs::metadata(path) which DOES follow.
        let ft = e.file_type();
        let is_dir = match ft {
            Ok(t) if t.is_symlink() => fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false),
            Ok(t) => t.is_dir(),
            Err(_) => false,
        };
        out.push(FileEntry { name, is_dir });
    }
    // Self-heal missing repo-root member symlinks. They're git-ignored and
    // live in the (often live, for is_main_checkout tasks) host checkout,
    // so a stray `git clean -fdx` run there can wipe them while the frozen
    // composition stays intact — leaving the tree showing only the bare host
    // repo. Only the caller's intentional re-reads opt in (`heal`): task
    // launch and the manual refresh button, not every agent-settle reload.
    // Detection is then free: we already listed the root, so a member whose
    // dir_name is absent from `out` is the missing case, and a `symlink()`
    // write fires solely for it. Worktree members are real git worktrees, not
    // symlinks, so relinking can't recover them — left alone.
    if heal && rel.is_empty() && !w.composition.is_empty() {
        let present: HashSet<String> = out.iter().map(|e| e.name.clone()).collect();
        for m in &w.composition {
            if m.mode != MemberMode::RepoRoot { continue; }
            if m.dir_name.is_empty() || m.dir_name.contains('/') { continue; }
            if present.contains(&m.dir_name) { continue; }
            // Absent from the listing. Only relink when the slot is truly
            // empty (never clobber real user content sharing the name) and
            // the target repo still exists. Mirrors task_open_repo's guard.
            let target = base.join(&m.dir_name);
            if target.symlink_metadata().is_ok() { continue; }
            let src = member_repo_path(m);
            if src.is_empty() || !Path::new(&src).exists() { continue; }
            match std::os::unix::fs::symlink(&src, &target) {
                Ok(()) => out.push(FileEntry { name: m.dir_name.clone(), is_dir: true }),
                Err(e) => eprintln!("heal member link {} → {src} failed: {e}", target.display()),
            }
        }
    }
    // Directories first, then files; alphabetic within each group.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Flat list of every git-tracked + untracked-not-ignored file in the
/// task, used by the ⌘P file finder. Async + spawn_blocking because
/// `git ls-files` walks the whole tree and we don't want to freeze the IPC
/// thread on large repos. Re-fetched on every ⌘P open — good enough, no
/// caching layer.
#[tauri::command]
async fn task_list_files_for_finder(id: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no task")?;
        // List tracked + untracked files in a repo, prefixing each with
        // `prefix` (empty for the host; `<dir_name>/` for members) so member
        // paths resolve from the wrapper. `patterns` are that repo's exclude
        // globs (same ones the file tree uses) so a hidden path doesn't leak
        // back in via ⌘P. A repo that won't list just contributes nothing.
        let ls = |dir: &str, prefix: &str, patterns: &[glob::Pattern]| -> Vec<String> {
            match std::process::Command::new("git")
                .args(["ls-files", "--cached", "--others", "--exclude-standard"])
                .current_dir(dir)
                .output()
            {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter(|l| !l.is_empty())
                    .filter(|l| !path_is_excluded(patterns, l))
                    .map(|l| format!("{prefix}{l}"))
                    .collect(),
                _ => Vec::new(),
            }
        };
        // Host repo first, then each multi-repo member (serially). Each repo's
        // excludes are compiled once (its own + the personal global list).
        let host_repo_path = load_projects().into_iter().find(|p| p.id == w.project_id)
            .map(|p| p.root_path).unwrap_or_default();
        let mut files = ls(&w.path, "", &compile_exclude_patterns(&host_repo_path));
        for m in &w.composition {
            if Path::new(&m.path).exists() {
                let patterns = compile_exclude_patterns(&member_repo_path(m));
                files.extend(ls(&m.path, &format!("{}/", m.dir_name), &patterns));
            }
        }
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────────── helpers ─────────────────────────────

fn slugify(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Recursively copy a file or directory. `fs::copy` ONLY handles files, so
/// the previous implementation silently dropped directory patterns like
/// `.venv` and `node_modules` — the two patterns we ship as defaults.
fn copy_file_or_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = match fs::symlink_metadata(src) {
        Ok(m) => m,
        Err(e) => return Err(e),
    };
    let ft = meta.file_type();
    if ft.is_symlink() {
        // Preserve the symlink itself (don't follow). On non-Unix this is a
        // no-op since `std::os::unix::fs::symlink` isn't available.
        #[cfg(unix)]
        {
            if let Ok(target) = fs::read_link(src) {
                if let Some(parent) = dst.parent() { let _ = fs::create_dir_all(parent); }
                let _ = fs::remove_file(dst); // overwrite if present
                return std::os::unix::fs::symlink(target, dst);
            }
        }
        return Ok(());
    }
    if ft.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let child_src = entry.path();
            let child_dst = dst.join(entry.file_name());
            // Best-effort: log on failure but keep going so one bad file
            // (e.g. a broken symlink inside node_modules) doesn't abort
            // the whole copy.
            if let Err(e) = copy_file_or_dir(&child_src, &child_dst) {
                eprintln!("copy {} → {}: {e}", child_src.display(), child_dst.display());
            }
        }
        return Ok(());
    }
    if let Some(parent) = dst.parent() { fs::create_dir_all(parent)?; }
    fs::copy(src, dst).map(|_| ())
}

fn copy_matching(repo: &Path, dst: &Path, pat: &str) {
    // Very simple glob: '*' wildcard in the basename only.
    let pat_path = repo.join(pat);
    if pat_path.exists() {
        let rel_dst = dst.join(pat);
        // Handles both files AND directories now — previously `fs::copy`
        // here silently no-op'd on dirs, which made `.venv` / `node_modules`
        // defaults a lie.
        let _ = copy_file_or_dir(&pat_path, &rel_dst);
        return;
    }
    if pat.contains('*') {
        // Expand basename glob in pattern's parent dir
        let pp = PathBuf::from(pat);
        let parent_rel = pp.parent().unwrap_or_else(|| Path::new(""));
        let glob = pp.file_name().and_then(|s| s.to_str()).unwrap_or("*");
        let parent_abs = repo.join(parent_rel);
        if let Ok(rd) = fs::read_dir(&parent_abs) {
            for e in rd.flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if simple_glob_match(glob, &n) {
                    let dst_path = dst.join(parent_rel).join(&*n);
                    let _ = copy_file_or_dir(&e.path(), &dst_path);
                }
            }
        }
    }
}

fn simple_glob_match(pat: &str, s: &str) -> bool {
    // Supports leading/trailing '*' and one '*' in the middle.
    if pat == "*" { return true; }
    let parts: Vec<&str> = pat.split('*').collect();
    match parts.len() {
        1 => s == pat,
        2 => s.starts_with(parts[0]) && s.ends_with(parts[1]),
        _ => false,
    }
}

/// Setup / run / archive scripts run UNSANDBOXED, even for tasks
/// where `sandbox_enabled` is true. The agent itself is the threat
/// model - the user-authored scripts in `project.{setup,run,archive}_script`
/// are explicit user intent, and sandboxing them would break common
/// dev-loop moves (npm install, docker build, kubectl apply, etc.). The
/// aux/scratch terminal is in the same bucket; sandbox specifically
/// targets the agent PTY.
fn run_script(script: &str, cwd: &Path, port: u16, name: &str) -> Result<String> {
    // Same login-shell environment the PTY gets (see pty_spawn). `bash -l`
    // only sources bash's OWN profile, so a PATH/EDITOR/etc. the user set
    // in their real shell (fish/zsh rc) or a tool dir like ~/.bun/bin is
    // missing — GUI launch starts from a bare launchd env. Without this,
    // `bun`/`nvm`/etc. are "command not found" in setup/run scripts even
    // though they work in a terminal (#16), and `$EDITOR` is wrong (#17).
    let mut cmd = Command::new("bash");
    cmd.arg("-lc").arg(script).current_dir(cwd)
        .env("PATH", shell_env::resolved_path())
        .env("TERMIC_PORT", port.to_string())
        .env("TERMIC_WORKSPACE_NAME", name)
        .env("TERMIC_TASK", name);
    for (k, v) in shell_env::login_env() {
        cmd.env(k, v);
    }
    let out = cmd.output().with_context(|| "run script")?;
    let mut s = String::new();
    s.push_str(&String::from_utf8_lossy(&out.stdout));
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(anyhow!("script exit {}:\n{s}", out.status));
    }
    Ok(s)
}

/// Stream a script's stdout+stderr to the frontend as it runs, line by line.
/// Emits:
///   setup-output://<ws_id>  payload = { line: String }
///   setup-done://<ws_id>    payload = { code: Option<i32>, success: bool }
/// Used during task creation so the New Task dialog can show live
/// progress. Non-blocking from the caller's perspective: this spawns the
/// pump threads and returns immediately. Caller is responsible for keeping
/// `app` alive long enough (it's an Arc internally).
fn run_script_streaming(
    script: String,
    cwd: PathBuf,
    port: u16,
    name: String,
    app: AppHandle,
    ws_id: String,
) {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    thread::spawn(move || {
        let mut cmd = Command::new("bash");
        cmd.arg("-lc")
            .arg(&script)
            .current_dir(&cwd)
            // Real login-shell env so setup finds bun/nvm/etc. and sees the
            // user's $EDITOR; `bash -l` alone misses what the user set in
            // their actual shell (fish/zsh rc) (#16, #17).
            .env("PATH", shell_env::resolved_path())
            .env("TERMIC_PORT", port.to_string())
            .env("TERMIC_WORKSPACE_NAME", &name)
            .env("TERMIC_TASK", &name)
            // Match task_run_script_stream: hint line-buffered output
            // for the languages that honor env-var unbuffering. Native
            // binaries that block-buffer on pipe regardless will still
            // chunk; only a PTY would fix that universally.
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "UTF-8")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in shell_env::login_env() {
            cmd.env(k, v);
        }
        let spawn_res = cmd.spawn();
        let mut child = match spawn_res {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(&format!("setup-output://{ws_id}"),
                    serde_json::json!({ "line": format!("[spawn error] {e}") }));
                let _ = app.emit(&format!("setup-done://{ws_id}"),
                    serde_json::json!({ "code": serde_json::Value::Null, "success": false }));
                return;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let app_o = app.clone(); let id_o = ws_id.clone();
        let t_out = stdout.map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                let _ = app_o.emit(&format!("setup-output://{id_o}"),
                    serde_json::json!({ "line": line }));
            }
        }));
        let app_e = app.clone(); let id_e = ws_id.clone();
        let t_err = stderr.map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                let _ = app_e.emit(&format!("setup-output://{id_e}"),
                    serde_json::json!({ "line": line }));
            }
        }));
        let status = child.wait();
        // Drain reader threads so we don't emit "done" before the last lines.
        if let Some(t) = t_out { let _ = t.join(); }
        if let Some(t) = t_err { let _ = t.join(); }
        let code = status.as_ref().ok().and_then(|s| s.code());
        let success = status.map(|s| s.success()).unwrap_or(false);
        let _ = app.emit(&format!("setup-done://{ws_id}"),
            serde_json::json!({ "code": code, "success": success }));
    });
}

// ─────────────────────────── streaming run scripts ───────────────────────────

/// Tracks running script PIDs (process-group leaders) keyed by "ws_id:kind".
/// Lets `task_stop_script` find the right process group to SIGTERM. We
/// store i32 (PID) rather than `Child` because holding a `Child` would block
/// the waiter thread that calls `wait()`.
static RUNNING_SCRIPTS: std::sync::Mutex<Option<std::collections::HashMap<String, i32>>>
    = std::sync::Mutex::new(None);

fn running_scripts_insert(key: String, pid: i32) {
    let mut g = RUNNING_SCRIPTS.lock().unwrap();
    g.get_or_insert_with(std::collections::HashMap::new).insert(key, pid);
}
fn running_scripts_remove(key: &str) -> Option<i32> {
    let mut g = RUNNING_SCRIPTS.lock().unwrap();
    g.as_mut().and_then(|m| m.remove(key))
}

fn script_topic_member(member: &str) -> String {
    if member.is_empty() {
        String::new()
    } else {
        use std::fmt::Write;
        let mut out = String::with_capacity(member.len() * 2);
        for b in member.as_bytes() {
            let _ = write!(&mut out, "{:02x}", b);
        }
        out
    }
}

/// Called by a run's waiter thread when its child exits. Returns whether
/// this instance still owns the key and should emit `script-done`:
/// - entry == our pid → normal exit; remove it, emit.
/// - entry == some OTHER pid → a restart replaced us while we were dying;
///   leave the replacement's entry alone and do NOT emit (a stale done
///   would flip the UI to idle while the new instance is running).
/// - no entry → explicit stop already deregistered us; still emit so
///   listeners that didn't initiate the stop (e.g. another task's
///   panel) settle out of "running".
fn running_scripts_finish(key: &str, pid: i32) -> bool {
    let mut g = RUNNING_SCRIPTS.lock().unwrap();
    let Some(m) = g.as_mut() else { return true };
    match m.get(key) {
        Some(&p) if p == pid => { m.remove(key); true }
        Some(_) => false,
        None => true,
    }
}

// ─────────────────────────── spotlight ───────────────────────────

/// Per-project spotlight session. At most one task per project
/// can be spotlighted at a time. The key in SPOTLIGHT is project_id.
struct SpotlightState {
    ws_id: String,
    /// The ref the repo root was on before spotlight started — a branch
    /// name (e.g. "main") when attached, or a bare SHA when the repo root
    /// was already in detached HEAD. Restored verbatim on stop/revert.
    original_ref: String,
    /// Untracked files we copied into the repo root (worktree-relative
    /// paths). Tracked so we can remove them on stop/revert.
    applied_untracked: Vec<String>,
    /// Dropping this sender signals the polling thread to exit on its
    /// next wake-up — no explicit join needed.
    _stop_tx: std::sync::mpsc::SyncSender<()>,
}

static SPOTLIGHT: std::sync::Mutex<Option<HashMap<String, SpotlightState>>>
    = std::sync::Mutex::new(None);

fn spotlight_get(project_id: &str) -> Option<String> {
    let g = SPOTLIGHT.lock().unwrap();
    g.as_ref()?.get(project_id).map(|s| s.ws_id.clone())
}

fn spotlight_insert(project_id: String, state: SpotlightState) {
    let mut g = SPOTLIGHT.lock().unwrap();
    g.get_or_insert_with(HashMap::new).insert(project_id, state);
}

fn spotlight_remove(project_id: &str) -> Option<SpotlightState> {
    let mut g = SPOTLIGHT.lock().unwrap();
    g.as_mut()?.remove(project_id)
}

/// Update the applied_untracked list in the active session for a project.
fn spotlight_update_untracked(project_id: &str, untracked: Vec<String>) {
    let mut g = SPOTLIGHT.lock().unwrap();
    if let Some(m) = g.as_mut() {
        if let Some(s) = m.get_mut(project_id) {
            s.applied_untracked = untracked;
        }
    }
}

/// Compute a string that changes whenever the worktree's git state
/// changes (committed or uncommitted). Used by the polling thread to
/// detect when a re-sync is needed.
fn spotlight_state_hash(worktree: &Path) -> String {
    let head = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(worktree)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    format!("{head}||{status}")
}

/// Apply a worktree's full state into the repo root WITHOUT advancing any
/// branch. This is the core of spotlight:
///   1. Check out the worktree's HEAD commit as a DETACHED HEAD in the repo
///      root. Worktrees share the object DB, so the commit is reachable.
///      The repo root's branch (main/master) ref is never moved — so even
///      if the app crashes before revert, the user's branch is untouched.
///   2. Uncommitted diff (HEAD..) → applied as working-tree changes.
///   3. Untracked files → copied in (honoring .gitignore).
struct SpotlightApplyResult {
    applied_untracked: Vec<String>,
    /// File paths in the committed diff (base..worktree HEAD), for the log.
    committed_files: Vec<String>,
    /// File paths in the uncommitted diff (working tree vs HEAD).
    uncommitted_files: Vec<String>,
}

fn spotlight_apply(
    worktree: &Path,
    main: &Path,
    base: &str,
    _ws_name: &str,
) -> Result<SpotlightApplyResult, String> {
    use std::io::Write as _;

    // The worktree's HEAD commit — the committed state we check out at root.
    let wt_head = git(&["rev-parse", "HEAD"], worktree)
        .map_err(|e| format!("git rev-parse worktree HEAD: {e}"))?
        .trim()
        .to_string();

    // Names of files that differ vs the base branch (for the log only).
    let name_list = |args: &[&str], cwd: &Path| -> Vec<String> {
        std::process::Command::new("git").args(args).current_dir(cwd).output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout)
                .lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default()
    };
    let committed_files = name_list(
        &["--no-pager", "diff", "--name-only", &format!("{base}..HEAD")], worktree);

    // Uncommitted diff (staged + unstaged on top of HEAD) — binary-safe patch.
    let uncommitted = std::process::Command::new("git")
        .args(["--no-pager", "diff", "--binary", "HEAD"])
        .current_dir(worktree)
        .output()
        .map_err(|e| format!("git diff uncommitted: {e}"))?;
    if !uncommitted.status.success() {
        return Err(format!("git diff uncommitted failed: {}",
            String::from_utf8_lossy(&uncommitted.stderr)));
    }
    let has_uncommitted = !uncommitted.stdout.is_empty();
    let uncommitted_files = String::from_utf8_lossy(&uncommitted.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("diff --git "))
        .filter_map(|rest| rest.split(" b/").nth(1).map(|s| s.to_string()))
        .collect();

    // 1. Detached checkout of the worktree's commit. --force is safe: the
    //    caller guarantees the repo root is clean before the first apply,
    //    and re-syncs always revert to the original ref first.
    let out = std::process::Command::new("git")
        .args(["checkout", "--detach", "--force", &wt_head])
        .current_dir(main)
        .output()
        .map_err(|e| format!("git checkout --detach spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("git checkout --detach failed: {}",
            String::from_utf8_lossy(&out.stderr)));
    }

    // 2. Apply uncommitted diff as working-tree changes (not staged, no --3way:
    //    HEAD now matches the worktree's committed state so it applies cleanly).
    if has_uncommitted {
        let mut child = std::process::Command::new("git")
            .args(["apply", "--whitespace=nowarn", "-"])
            .current_dir(main)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("git apply uncommitted spawn: {e}"))?;
        {
            let stdin = child.stdin.as_mut().ok_or("apply uncommitted: no stdin")?;
            stdin.write_all(&uncommitted.stdout).map_err(|e| format!("apply uncommitted stdin: {e}"))?;
        }
        let out = child.wait_with_output().map_err(|e| format!("apply uncommitted wait: {e}"))?;
        if !out.status.success() {
            return Err(format!("git apply uncommitted failed: {}",
                String::from_utf8_lossy(&out.stderr)));
        }
    }

    // 3. Copy untracked files (honoring .gitignore).
    let untracked_raw = git(
        &["ls-files", "--others", "--exclude-standard", "-z"],
        worktree,
    ).map_err(|e| e.to_string())?;
    let mut applied_untracked = Vec::new();
    for rel in untracked_raw.split('\0').filter(|s| !s.is_empty()) {
        let src = safe_task_path(worktree, rel)
            .map_err(|e| format!("untracked path rejected: {e}"))?;
        let dst = main.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        fs::copy(&src, &dst).map_err(|e| format!("copy {rel}: {e}"))?;
        applied_untracked.push(rel.to_string());
    }

    Ok(SpotlightApplyResult {
        applied_untracked,
        committed_files,
        uncommitted_files,
    })
}

/// Revert the repo root to its pre-spotlight state: force-checkout the
/// original ref (re-attaching the branch / leaving detached HEAD as it was)
/// and remove any untracked files we copied in. Because spotlight never
/// moved a branch, this just moves HEAD back — no history is rewritten.
fn spotlight_revert(main: &Path, original_ref: &str, applied_untracked: &[String]) -> Result<(), String> {
    let out = std::process::Command::new("git")
        .args(["checkout", "--force", original_ref])
        .current_dir(main)
        .output()
        .map_err(|e| format!("git checkout spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("git checkout {original_ref} failed: {}",
            String::from_utf8_lossy(&out.stderr)));
    }
    for rel in applied_untracked {
        let path = main.join(rel);
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

/// SIGTERM a task's host run-script process group, if one is running.
/// The run script started while spotlighted executes at the repo root, so
/// when spotlight stops or switches away we must tear it down — otherwise a
/// stale dev server keeps serving the repo root after the sync target changed.
fn spotlight_kill_run(ws_id: &str) {
    // Host run scripts use map key "{ws_id}::run" (empty member component).
    let key = format!("{ws_id}::run");
    if let Some(pid) = running_scripts_remove(&key) {
        unsafe { libc::kill(-pid, libc::SIGTERM); }
    }
}

/// Stop spotlight for a task without requiring an AppHandle (called
/// from task_archive_sync). Caller emits the status event if needed.
fn spotlight_stop_for_ws(ws_id: &str) {
    let tasks = load_tasks();
    let Some(w) = tasks.iter().find(|w| w.id == ws_id) else { return };
    let projects = load_projects();
    let Some(p) = projects.iter().find(|p| p.id == w.project_id) else { return };
    let main = PathBuf::from(&p.root_path);
    if let Some(state) = spotlight_remove(&p.id) {
        spotlight_kill_run(&state.ws_id);
        let _ = spotlight_revert(&main, &state.original_ref, &state.applied_untracked);
    }
}

#[tauri::command]
fn task_spotlight_status() -> HashMap<String, String> {
    let g = SPOTLIGHT.lock().unwrap();
    match g.as_ref() {
        None => HashMap::new(),
        Some(m) => m.iter().map(|(pid, s)| (pid.clone(), s.ws_id.clone())).collect(),
    }
}


#[tauri::command]
async fn task_spotlight_start(id: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || spotlight_start_sync(id, app))
        .await
        .map_err(|e| e.to_string())?
}

fn spotlight_start_sync(ws_id: String, app: AppHandle) -> Result<(), String> {
    let w = load_tasks().into_iter().find(|w| w.id == ws_id)
        .ok_or("no such task")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id)
        .ok_or("project missing")?;

    if !p.spotlight_enabled {
        return Err("Spotlight is not enabled for this project. Enable it in Repository Settings.".into());
    }
    if w.is_main_checkout {
        return Err("This task IS the main checkout — nothing to spotlight.".into());
    }
    if p.project_type == ProjectType::Multi {
        return Err("Spotlight is not supported for multi-repo projects.".into());
    }

    let worktree    = PathBuf::from(&w.path);
    let main        = PathBuf::from(&p.root_path);
    let project_id  = p.id.clone();
    let base        = w.base_branch.clone();

    if !main.is_dir() {
        return Err(format!("Main checkout missing: {}", main.display()));
    }

    // If another task in this project is already spotlighted, revert main
    // first — otherwise the clean check below would always fail because main
    // has the previous spotlight's changes applied.
    if let Some(existing) = spotlight_remove(&project_id) {
        // Stop the previous task's repo-root run (it was serving the old
        // spotlight target) before reverting main + applying the new one.
        spotlight_kill_run(&existing.ws_id);
        spotlight_revert(&main, &existing.original_ref, &existing.applied_untracked)?;
        let _ = app.emit("spotlight://status", serde_json::json!({
            "project_id": &project_id,
            "ws_id": serde_json::Value::Null,
        }));
    }

    // Refuse to start from a detached HEAD. The repo root is normally on a
    // branch; detached almost always means a previous spotlight session was
    // left over by a hard crash (the app couldn't revert on the way out).
    // Spotlight also detaches HEAD while running, so we need a clean branch
    // to return to — refuse and tell the user to clean up first.
    let branch = git(&["symbolic-ref", "--quiet", "--short", "HEAD"], &main)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let Some(original_ref) = branch else {
        return Err("The repo root is in a detached HEAD (likely a leftover spotlight from a previous crash). Run `git checkout <your branch>` in the repo root, then retry.".into());
    };

    // Now check main is clean. Any remaining dirt is user-owned (not spotlight's).
    let main_status = git(&["status", "--porcelain"], &main).map_err(|e| e.to_string())?;
    if !main_status.trim().is_empty() {
        return Err("Main checkout has uncommitted changes. Commit or stash them first, then retry.".into());
    }

    // Initial apply.
    let r = spotlight_apply(&worktree, &main, &base, &w.name)?;
    let applied_untracked = r.applied_untracked.clone();

    // Polling thread: checks git state every 1.5s and re-syncs on change.
    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    {
        let poll_worktree    = worktree.clone();
        let poll_main        = main.clone();
        let poll_base        = base.clone();
        let poll_ws_name     = w.name.clone();
        let poll_orig        = original_ref.clone();
        let poll_project_id  = project_id.clone();
        let poll_ws_id       = ws_id.clone();
        let poll_app         = app.clone();

        thread::spawn(move || {
            let mut last_hash = spotlight_state_hash(&poll_worktree);
            loop {
                match stop_rx.recv_timeout(std::time::Duration::from_millis(1500)) {
                    Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }

                let current_hash = spotlight_state_hash(&poll_worktree);
                if current_hash == last_hash {
                    continue;
                }
                last_hash = current_hash;

                // Get the latest applied_untracked from the session so the
                // revert removes the right files even if a prior sync added new ones.
                let current_untracked = {
                    let g = SPOTLIGHT.lock().unwrap();
                    g.as_ref()
                        .and_then(|m| m.get(&poll_project_id))
                        .filter(|s| s.ws_id == poll_ws_id)
                        .map(|s| s.applied_untracked.clone())
                        .unwrap_or_default()
                };
                // If the session is gone (stopped while we were sleeping), exit.
                {
                    let g = SPOTLIGHT.lock().unwrap();
                    if g.as_ref().and_then(|m| m.get(&poll_project_id))
                        .map(|s| s.ws_id.as_str()) != Some(&poll_ws_id)
                    {
                        break;
                    }
                }

                if let Err(e) = spotlight_revert(&poll_main, &poll_orig, &current_untracked) {
                    let _ = poll_app.emit("spotlight://error", serde_json::json!({
                        "project_id": &poll_project_id,
                        "ws_id": &poll_ws_id,
                        "message": e,
                    }));
                    continue;
                }

                match spotlight_apply(&poll_worktree, &poll_main, &poll_base, &poll_ws_name) {
                    Ok(r) => {
                        spotlight_update_untracked(&poll_project_id, r.applied_untracked.clone());
                        let _ = poll_app.emit("spotlight://synced", serde_json::json!({
                            "project_id": &poll_project_id,
                            "ws_id": &poll_ws_id,
                            "committed_files":   r.committed_files,
                            "uncommitted_files": r.uncommitted_files,
                            "untracked_files":   r.applied_untracked,
                        }));
                    }
                    Err(e) => {
                        let _ = poll_app.emit("spotlight://error", serde_json::json!({
                            "project_id": &poll_project_id,
                            "ws_id": &poll_ws_id,
                            "message": e,
                        }));
                    }
                }
            }
        });
    }

    spotlight_insert(project_id.clone(), SpotlightState {
        ws_id: ws_id.clone(),
        original_ref,
        applied_untracked: r.applied_untracked,
        _stop_tx: stop_tx,
    });

    // Emit status FIRST so the frontend clears the log, THEN emit synced
    // so the initial sync detail arrives into the freshly-cleared log.
    let _ = app.emit("spotlight://status", serde_json::json!({
        "project_id": &project_id,
        "ws_id": &ws_id,
    }));
    let _ = app.emit("spotlight://synced", serde_json::json!({
        "project_id": &project_id,
        "ws_id": &ws_id,
        "committed_files":   r.committed_files,
        "uncommitted_files": r.uncommitted_files,
        "untracked_files":   &applied_untracked,
    }));

    Ok(())
}

#[tauri::command]
async fn task_spotlight_stop(id: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || spotlight_stop_sync(id, app))
        .await
        .map_err(|e| e.to_string())?
}

fn spotlight_stop_sync(ws_id: String, app: AppHandle) -> Result<(), String> {
    let w = load_tasks().into_iter().find(|w| w.id == ws_id)
        .ok_or("no such task")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id)
        .ok_or("project missing")?;
    let main = PathBuf::from(&p.root_path);

    if let Some(state) = spotlight_remove(&p.id) {
        // Stop the repo-root run, then signal the polling thread to exit
        // (dropping _stop_tx), then revert main.
        spotlight_kill_run(&state.ws_id);
        drop(state._stop_tx);
        spotlight_revert(&main, &state.original_ref, &state.applied_untracked)?;
    }

    let _ = app.emit("spotlight://status", serde_json::json!({
        "project_id": &p.id,
        "ws_id": serde_json::Value::Null,
    }));

    Ok(())
}

#[tauri::command]
async fn task_spotlight_resync(id: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = load_tasks().into_iter().find(|w| w.id == id)
            .ok_or("no such task")?;
        let p = load_projects().into_iter().find(|p| p.id == w.project_id)
            .ok_or("project missing")?;
        let worktree = PathBuf::from(&w.path);
        let main     = PathBuf::from(&p.root_path);

        let (original_ref, current_untracked) = {
            let g = SPOTLIGHT.lock().unwrap();
            let state = g.as_ref()
                .and_then(|m| m.get(&p.id))
                .ok_or("spotlight not active for this task")?;
            if state.ws_id != id {
                return Err("A different task is spotlighted for this project.".into());
            }
            (state.original_ref.clone(), state.applied_untracked.clone())
        };

        spotlight_revert(&main, &original_ref, &current_untracked)?;
        let r = spotlight_apply(&worktree, &main, &w.base_branch, &w.name)?;
        spotlight_update_untracked(&p.id, r.applied_untracked.clone());

        let _ = app.emit("spotlight://synced", serde_json::json!({
            "project_id": &p.id,
            "ws_id": &id,
            "committed_files":   r.committed_files,
            "uncommitted_files": r.uncommitted_files,
            "untracked_files":   r.applied_untracked,
        }));

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}


/// Kick off either the project's setup or run script for a task with
/// live stdout/stderr streaming. Emits:
///   script-output://<ws_id>:<kind>  { line: string }
///   script-done://<ws_id>:<kind>    { code, success }
/// If a previous instance is still running for the same (task, kind), it is
/// SIGTERM'd before the new one starts so users can't accidentally fork
/// multiple dev servers off the same project.
#[tauri::command]
// `member`: empty / unset = run the host script with cwd at the
// task path (single-repo behavior; for multi-repo tasks
// this is the host worktree). Non-empty = run a composition member's
// script with cwd inside that member's dir. The frontend resolves
// the member by its frozen `dir_name`.
fn task_run_script_stream(
    id: String,
    kind: String,
    member: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no such task")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("no proj")?;
    let member_dir = member.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);

    // Resolve target: empty member = host, otherwise the named
    // composition member. Each carries its own (script, cwd, port).
    // Per-member port avoids `PORT=$TERMIC_PORT npm run dev`
    // collisions when two members run in parallel. Members created
    // before per-member ports existed (port == 0) fall back to the
    // task's port.
    let (script, cwd, target_port) = match &member_dir {
        None => {
            let (setup, run, _) = effective_scripts(&p);
            let s = match kind.as_str() {
                "setup" => setup,
                "run"   => run,
                other   => return Err(format!("unknown script kind: {other}")),
            };
            (s, std::path::PathBuf::from(&w.path), w.port)
        }
        Some(dir) => {
            let idx = w.composition.iter().position(|m| &m.dir_name == dir)
                .ok_or_else(|| format!("no such member: {dir}"))?;
            let m = &w.composition[idx];
            let s = match kind.as_str() {
                "setup" => m.setup_script.clone(),
                "run"   => m.run_script.clone(),
                other   => return Err(format!("unknown script kind: {other}")),
            };
            // Legacy migration: tasks created before per-member
            // ports existed have m.port == 0. Falling back to
            // w.port would re-introduce the original collision. Use
            // the same scheme task_create_multi_sync uses now —
            // task.port + index + 1 — so existing tasks get
            // unique ports without needing to be recreated.
            let p = if m.port == 0 { w.port.saturating_add(idx as u16 + 1) } else { m.port };
            (s, std::path::PathBuf::from(&m.path), p)
        }
    };

    // Spotlight override: when this task is spotlighted and we're
    // running the "run" script (not setup, not a member), execute at the
    // main checkout so the server sees the synced files. Mirrors the
    // spawn-time cwd decision the Run TABS make in TerminalPane.
    let cwd = if kind == "run" && member_dir.is_none() {
        match spotlight_get(&p.id) {
            Some(active_id) if active_id == id => PathBuf::from(&p.root_path),
            _ => cwd,
        }
    } else {
        cwd
    };

    // Event-channel topic + RUNNING_SCRIPTS key include the member dir so
    // multiple members can run in parallel without colliding. The map key
    // keeps the raw dir_name; the Tauri event topic hex-encodes it because
    // event names reject dots and other punctuation. Host uses an empty
    // member component for back-compat.
    let map_member = member_dir.clone().unwrap_or_default();
    let topic_member = script_topic_member(&map_member);
    let map_key = format!("{id}:{map_member}:{kind}");
    let emit_done = format!("script-done://{id}:{topic_member}:{kind}");
    let emit_out  = format!("script-output://{id}:{topic_member}:{kind}");

    // Empty script → no-op but emit done so the UI doesn't spin forever.
    if script.trim().is_empty() {
        let _ = app.emit(&emit_done,
            serde_json::json!({ "code": 0, "success": true }));
        return Ok(());
    }

    let port = target_port;
    let name = w.name.clone();
    let map_key_o = map_key.clone();
    let emit_out_o = emit_out.clone();
    let emit_done_o = emit_done.clone();
    let app_o = app.clone();

    // Cross-member port discovery: every script gets a
    // TERMIC_PORT_<DIR> var for each composition member (including
    // itself) so service A can talk to service B without hardcoding
    // ports. <DIR> is the dir_name uppercased with non-alphanumerics
    // replaced by `_` (env var names must be `[A-Z_][A-Z0-9_]*`).
    let sibling_ports: Vec<(String, u16)> = w.composition.iter().enumerate()
        .map(|(i, m)| {
            let p = if m.port == 0 { w.port.saturating_add(i as u16 + 1) } else { m.port };
            let sanitized: String = m.dir_name.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                .collect();
            (format!("TERMIC_PORT_{sanitized}"), p)
        })
        .collect();

    thread::spawn(move || {
        // Kill any prior instance for (task, member, kind) — SIGTERM to the
        // whole process group so children die too — then wait (bounded) for
        // the group to actually die: spawning immediately would race the
        // dying server for the port and fail with EADDRINUSE. Deregistering
        // and re-registering on the same thread keeps the window where the
        // key maps to neither pid tiny; running_scripts_finish's pid check
        // covers the old waiter racing us.
        if let Some(prev) = running_scripts_remove(&map_key_o) {
            unsafe { libc::kill(-prev, libc::SIGTERM); }
            for _ in 0..50 {
                if unsafe { libc::kill(-prev, 0) } != 0 { break; }
                thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        // `process_group(0)` puts the child in its own group so we can kill
        // the whole tree later via `kill(-pgid, SIGTERM)`.
        let mut cmd = Command::new("bash");
        cmd.arg("-lc").arg(&script)
            .current_dir(&cwd)
            // Real login-shell env so the Run script finds bun/nvm/etc. and
            // sees the user's $EDITOR; `bash -l` alone misses what the user
            // set in their actual shell (fish/zsh rc) (#16, #17). The
            // login_env() loop below adds the non-PATH delta.
            .env("PATH", shell_env::resolved_path())
            .env("TERMIC_PORT", port.to_string())
            .env("TERMIC_WORKSPACE_NAME", &name)
            .env("TERMIC_TASK", &name)
            // Legacy aliases — keep scripts saved under the old name working
            // until users migrate their preview_url / scripts.
            .env("CONDUCTOR_PORT", port.to_string())
            .env("CONDUCTOR_WORKSPACE_NAME", &name)
            // Encourage line-buffered output. When stdout is a pipe (which
            // it is here), libc flips most programs to fully-buffered mode
            // so lines stall in the child until a 4-64KB block fills. The
            // only universal fix is to allocate a PTY; these env vars catch
            // the most common offender (Python) without that complexity.
            // Native binaries that ignore these will still block-buffer; in
            // that case the user's script must opt in (e.g. `stdbuf -oL`).
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "UTF-8")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        for (k, v) in shell_env::login_env() {
            cmd.env(k, v);
        }
        for (k, v) in &sibling_ports {
            cmd.env(k, v.to_string());
        }
        let spawn_res = cmd.spawn();
        let mut child = match spawn_res {
            Ok(c) => c,
            Err(e) => {
                let _ = app_o.emit(&emit_out_o,
                    serde_json::json!({ "line": format!("[spawn error] {e}") }));
                let _ = app_o.emit(&emit_done_o,
                    serde_json::json!({ "code": serde_json::Value::Null, "success": false }));
                return;
            }
        };
        let pid = child.id() as i32;
        running_scripts_insert(map_key_o.clone(), pid);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let app1 = app_o.clone(); let ch1 = emit_out_o.clone();
        let t_out = stdout.map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                let _ = app1.emit(&ch1, serde_json::json!({ "line": line }));
            }
        }));
        let app2 = app_o.clone(); let ch2 = emit_out_o.clone();
        let t_err = stderr.map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                let _ = app2.emit(&ch2, serde_json::json!({ "line": line }));
            }
        }));
        let status = child.wait();
        if let Some(t) = t_out { let _ = t.join(); }
        if let Some(t) = t_err { let _ = t.join(); }
        if running_scripts_finish(&map_key_o, pid) {
            let code = status.as_ref().ok().and_then(|s| s.code());
            let success = status.map(|s| s.success()).unwrap_or(false);
            let _ = app_o.emit(&emit_done_o,
                serde_json::json!({ "code": code, "success": success }));
        }
    });
    Ok(())
}

/// SIGTERM the process group for (ws_id, member, kind). No-op if
/// nothing's running. `member` is the composition member's dir_name
/// (empty / unset = host). Caller should still wait for the matching
/// `script-done` event before updating UI state — kill is async from
/// the child's perspective.
#[tauri::command]
fn task_stop_script(id: String, kind: String, member: Option<String>) -> Result<(), String> {
    let member_dir = member.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let map_key = format!("{id}:{}:{kind}", member_dir.unwrap_or_default());
    if let Some(pid) = running_scripts_remove(&map_key) {
        unsafe { libc::kill(-pid, libc::SIGTERM); }
    }
    Ok(())
}

// ───────────────────────────── find in files ─────────────────────────────

/// Per-task in-flight grep PID. Each new search SIGKILLs the
/// previous one for the same task so typing doesn't fan out into
/// dozens of zombie git-grep procs.
static RUNNING_GREPS: std::sync::Mutex<Option<std::collections::HashMap<String, i32>>>
    = std::sync::Mutex::new(None);

fn running_greps_swap(ws_id: &str, new_pid: Option<i32>) -> Option<i32> {
    let mut g = RUNNING_GREPS.lock().unwrap();
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    let prev = map.remove(ws_id);
    if let Some(pid) = new_pid { map.insert(ws_id.to_string(), pid); }
    prev
}

/// Streaming `git grep`. Emits one `grep-result://<search_id>` event per
/// match (`{ path, line, col, preview }`) and a final `grep-done://<search_id>`
/// (`{ truncated }`). Caps results to keep the renderer responsive — past
/// the cap the child is SIGKILLed and `truncated: true` is reported.
/// Re-entrant safety: any previous grep for the same task is killed
/// before this one starts (typing fires a new search per keystroke).
#[tauri::command]
fn task_grep_start(
    id: String,
    query: String,
    search_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let w = load_tasks().into_iter().find(|w| w.id == id).ok_or("no such task")?;
    let cwd = std::path::PathBuf::from(&w.path);
    // Search the host repo first, then each multi-repo member, serially.
    // Member result paths are prefixed with `<dir_name>/` so they resolve
    // from the wrapper (matching the diff / finder path scheme). Single-repo
    // tasks just have the one host entry.
    let mut repos: Vec<(std::path::PathBuf, String)> = vec![(cwd.clone(), String::new())];
    for m in &w.composition {
        let mp = std::path::PathBuf::from(&m.path);
        if mp.exists() { repos.push((mp, format!("{}/", m.dir_name))); }
    }
    let emit_done = format!("grep-done://{search_id}");
    let emit_out  = format!("grep-result://{search_id}");

    // Empty query → just emit done. UI shouldn't bother calling us, but
    // be defensive (debounce can race).
    if query.trim().is_empty() {
        let _ = app.emit(&emit_done, serde_json::json!({ "truncated": false }));
        return Ok(());
    }

    // SIGKILL any prior grep for this task. The frontend bumps
    // search_id each keystroke and ignores late events from stale ids,
    // but we still want to free the CPU cycles ASAP.
    if let Some(prev) = running_greps_swap(&id, None) {
        unsafe { libc::kill(-prev, libc::SIGKILL); }
    }

    let app_o = app.clone();
    let ws_id_o = id.clone();
    let search_id_o = search_id.clone();

    thread::spawn(move || {
        // git grep flags: -n line numbers, --column column, -I skip binary,
        // -F literal, -i case-insensitive, --untracked --exclude-standard
        // include new files but respect .gitignore. process_group(0) to kill
        // the tree. We run one child per repo, serially, sharing the result
        // cap + batch across all of them.
        const RESULT_CAP: usize = 500;
        const BATCH_MAX: usize = 50;
        const BATCH_MS: u128 = 30;
        let mut truncated = false;
        let mut superseded = false;
        let mut count = 0usize;
        let mut batch: Vec<serde_json::Value> = Vec::with_capacity(BATCH_MAX);
        let mut batch_started = std::time::Instant::now();
        let flush_batch = |app: &tauri::AppHandle, topic: &str, batch: &mut Vec<serde_json::Value>| {
            if batch.is_empty() { return; }
            let payload = serde_json::json!({ "hits": batch.clone() });
            let _ = app.emit(topic, payload);
            batch.clear();
        };

        let mut my_pid: Option<i32> = None;
        'repos: for (rcwd, prefix) in &repos {
            // Before each repo, bail if the slot changed: a newer search
            // (different pid) supersedes us, or a cancel cleared it (None).
            if let Some(prev) = my_pid {
                let cur = RUNNING_GREPS.lock().unwrap().as_ref()
                    .and_then(|m| m.get(&ws_id_o).copied());
                if cur != Some(prev) {
                    if cur.is_some() { superseded = true; }
                    break 'repos;
                }
            }
            let spawn = std::process::Command::new("git")
                .args([
                    "grep",
                    "-n", "--column", "-I", "-F", "-i",
                    "--untracked", "--exclude-standard",
                    "--no-color",
                    "-e", &query,
                ])
                .current_dir(rcwd)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn();
            let mut child = match spawn { Ok(c) => c, Err(_) => continue 'repos };
            let pid = child.id() as i32;
            my_pid = Some(pid);
            running_greps_swap(&ws_id_o, Some(pid));

            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().map_while(|r| r.ok()) {
                    // git grep -n --column output: "path:LINE:COL:preview"
                    let mut it = line.splitn(4, ':');
                    let path = it.next().unwrap_or("").to_string();
                    let line_no: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                    let col: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                    let preview = it.next().unwrap_or("").to_string();
                    if path.is_empty() || line_no == 0 { continue; }
                    if batch.is_empty() { batch_started = std::time::Instant::now(); }
                    batch.push(serde_json::json!({
                        // Prefix member paths so clicks resolve from the wrapper.
                        "path": format!("{prefix}{path}"),
                        "line": line_no,
                        "col": col,
                        "preview": preview,
                    }));
                    count += 1;
                    if batch.len() >= BATCH_MAX
                        || batch_started.elapsed().as_millis() >= BATCH_MS
                    {
                        flush_batch(&app_o, &emit_out, &mut batch);
                    }
                    if count >= RESULT_CAP {
                        truncated = true;
                        unsafe { libc::kill(-pid, libc::SIGKILL); }
                        break;
                    }
                }
                flush_batch(&app_o, &emit_out, &mut batch);
            }
            let _ = child.wait();
            if truncated { break 'repos; }
        }

        // Clear our slot if we still own it. If a newer search took it,
        // mark superseded so we don't emit a stale "done" over its results.
        {
            let mut g = RUNNING_GREPS.lock().unwrap();
            if let Some(map) = g.as_mut() {
                let cur = map.get(&ws_id_o).copied();
                if cur == my_pid && my_pid.is_some() { map.remove(&ws_id_o); }
                else if cur.is_some() { superseded = true; }
            }
        }
        if !superseded {
            let _ = app_o.emit(&emit_done, serde_json::json!({ "truncated": truncated }));
        }
        // search_id_o is only used in the topic strings above; reference it
        // here so the borrow checker doesn't complain about an unused move.
        drop(search_id_o);
    });
    Ok(())
}

/// Cancel an in-flight grep for the given task. The frontend calls
/// this on dialog close — typing-triggered cancellation happens
/// automatically in `task_grep_start` (the next search kills the
/// previous one for the same task).
#[tauri::command]
fn task_grep_cancel(id: String) -> Result<(), String> {
    if let Some(prev) = running_greps_swap(&id, None) {
        unsafe { libc::kill(-prev, libc::SIGKILL); }
    }
    Ok(())
}

// ───────────────────────────── notify ─────────────────────────────

#[tauri::command]
fn log_line(msg: String) { dlog(&msg); }

/// Append a single line to a per-PTY debug log in the OS temp dir.
/// Called from JS when `localStorage.ptyDebug = "1"` to record raw
/// terminal output + OSC signals + state transitions per agent session.
/// Safe to call at high frequency — just an append open + write + close.
#[tauri::command]
fn pty_debug_append(file: String, line: String) {
    use std::io::Write;
    // Restrict to temp dir only — no path traversal.
    let name = std::path::Path::new(&file)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "termic-pty-debug.log".into());
    let p = std::env::temp_dir().join(name);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", line);
    }
}

/// Stage a dropped file into TMPDIR so a sandboxed agent can read it.
///
/// Files dropped onto a terminal from `~/Desktop`, `~/Downloads`, etc. are
/// hard-denied by the seatbelt profile (see `builtin_deny_paths`), so the
/// agent can't open them by their original path. We copy the file into
/// `$TMPDIR/termic-attachments/<ws_id>/<uuid>-<name>` and hand back THAT path
/// — `$TMPDIR` is already in the sandbox's runtime allow set, so the agent
/// reads it with no profile change. The uuid prefix avoids collisions when the
/// same filename is dropped twice.
#[tauri::command]
fn terminal_stage_file(task_id: String, src: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let name = src_path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    // Sanitize task_id for a path component (it's a uuid, but be defensive).
    let safe_ws: String = task_id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let dir = std::env::temp_dir().join("termic-attachments").join(&safe_ws);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir staging: {e}"))?;
    let dest = dir.join(format!("{}-{}", Uuid::new_v4(), name));
    fs::copy(&src_path, &dest).map_err(|e| format!("copy to staging: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Rust-side log append. Mirror of `log_line` IPC but callable from
/// anywhere in the crate (proxy.rs / sandbox.rs / spawn paths).
/// Persistent file lets us debug post-mortem; eprintln stderr only
/// shows up if the user redirected the dev process to a logfile.
pub fn dlog(msg: &str) {
    use std::io::Write;
    let p = std::env::temp_dir().join("termic-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "[{}] {}", chrono::Utc::now().format("%H:%M:%S%.3f"), msg);
    }
    // Also echo to stderr so `npm run tauri:dev` foreground shows it.
    eprintln!("{msg}");
}

#[tauri::command]
fn home_dir() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The user's login shell (`$SHELL` with a zsh → bash → fish → sh
/// fallback). The frontend spawns scratch + custom-command terminals
/// through this instead of a hard-coded `zsh`, so machines without zsh
/// can still open a terminal (issue #13).
#[tauri::command]
fn default_shell() -> String {
    shell_env::login_shell()
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Does `path` resolve to a git repo? Same canonical check `project_add`
/// uses (`git rev-parse --git-dir`), so it handles worktrees (`.git` is a
/// FILE), bare repos, and stray-newline paths the naive `.git` dir check
/// misses. Used by the Add Project dialog to decide whether to surface the
/// "this is a plain folder" confirm after the user picks a directory —
/// replacing the old manual "Not a git repository" checkbox. Returns false
/// for a non-existent or non-directory path (the caller adds nothing then).
#[tauri::command]
fn path_is_git_repo(path: String) -> bool {
    let trimmed = path.trim();
    let expanded: String = if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir().map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string())
    } else { trimmed.to_string() };
    let pb = PathBuf::from(&expanded);
    if !pb.is_dir() { return false; }
    git(&["rev-parse", "--git-dir"], &pb).is_ok()
}

/// Copy a bundled notification sound into `~/Library/Sounds` so macOS can
/// resolve it by name. `NSUserNotification.soundName` only searches the
/// `Library/Sounds` directories plus the app bundle's Resources ROOT, and it
/// can't decode mp3 — Tauri resources land nested under
/// `Resources/resources/…` (dev mode has no .app bundle at all), so a name
/// like "choo_choo.mp3" never resolves and macOS silently falls back to the
/// default sound. Idempotent: skips the copy when the installed file already
/// matches by size (sounds only change wholesale on app updates).
#[tauri::command]
async fn install_notification_sound(app: AppHandle, resource: String, file_name: String) -> Result<(), String> {
    if cfg!(not(target_os = "macos")) {
        return Ok(());
    }
    if file_name.contains('/') || file_name.contains("..") {
        return Err("invalid sound file name".into());
    }
    use tauri::Manager;
    let src = app
        .path()
        .resolve(&resource, tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let dir = dirs::home_dir().ok_or("no home dir")?.join("Library/Sounds");
    let dst = dir.join(&file_name);
    if let (Ok(s), Ok(d)) = (fs::metadata(&src), fs::metadata(&dst)) {
        if s.len() == d.len() {
            return Ok(());
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn notify(title: String, body: String) {
    let script = format!(
        r#"display notification "{b}" with title "{t}" sound name "Glass""#,
        b = body.replace('"', "'"),
        t = title.replace('"', "'"),
    );
    let _ = Command::new("osascript").arg("-e").arg(&script).status();
}

/// Resolve a macOS sound NAME to a playable file, mirroring the OS's own
/// `Library/Sounds` search order (user → local → system). Names are
/// extension-less; system sounds are `.aiff`, our bundled Choo Choo is the
/// `.caf` installed by `install_notification_sound`.
#[cfg(target_os = "macos")]
fn resolve_completion_sound_path(name: &str) -> Option<std::path::PathBuf> {
    // The "macOS default" pseudo-name: approximate it with the user's
    // selected system alert sound (the closest queryable analog to the
    // default notification sound), falling back to a stock sound.
    if name.is_empty() || name == "NSUserNotificationDefaultSoundName" {
        if let Ok(out) = Command::new("defaults")
            .args(["read", "-g", "com.apple.sound.beep.sound"])
            .output()
        {
            let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !val.is_empty() {
                let p = std::path::PathBuf::from(&val);
                if p.is_absolute() && p.exists() {
                    return Some(p);
                }
                if let Some(found) = resolve_completion_sound_path(&val) {
                    return Some(found);
                }
            }
        }
        return resolve_completion_sound_path("Funk");
    }
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(h) = dirs::home_dir() {
        roots.push(h.join("Library/Sounds"));
    }
    roots.push(std::path::PathBuf::from("/Library/Sounds"));
    roots.push(std::path::PathBuf::from("/System/Library/Sounds"));
    const EXTS: [&str; 6] = ["aiff", "caf", "aif", "wav", "m4a", "mp3"];
    for root in roots {
        for ext in EXTS {
            let p = root.join(format!("{name}.{ext}"));
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Play a completion sound directly via `afplay`, decoupled from the
/// notification banner. `mac-notification-sys` (the desktop notification
/// backend) rides the deprecated NSUserNotification API, which on modern
/// macOS routinely drops the banner's sound — so we play it ourselves.
/// Spawns afplay on a detached thread that reaps the child, so the IPC call
/// returns immediately and never blocks the WKWebView event loop. macOS-only.
#[tauri::command]
async fn play_completion_sound(name: String) {
    #[cfg(target_os = "macos")]
    {
        if let Some(path) = resolve_completion_sound_path(&name) {
            std::thread::spawn(move || {
                let _ = Command::new("afplay").arg(&path).status();
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = name;
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let (program, args) = open_command(std::env::consts::OS, &path);
    Command::new(program).args(&args).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveal an ABSOLUTE path in the OS file manager, selecting it where the
/// platform supports it (macOS / Windows; Linux opens the containing dir).
/// Sibling of `open_path`: callers that already hold the absolute path use
/// this instead of `task_reveal_path` (which resolves a task-
/// relative path server-side). Cross-platform via `reveal_command`.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let (program, args) = reveal_command(std::env::consts::OS, &path);
    Command::new(program).args(&args).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// The argv for opening `target` (a URL or filesystem path) in the OS
/// default handler. Split out from the side-effecting spawn so the
/// per-platform dispatch is unit-testable. `os` is
/// `std::env::consts::OS`. Before this, `open_path` always invoked the
/// macOS-only `open`, so on Linux clicking a URL the agent printed in
/// the terminal did nothing (#14).
fn open_command(os: &str, target: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec![target.to_string()]),
        // `explorer.exe <target>` opens a URL/path in the default handler and
        // receives the arg directly (CreateProcess argv) — NOT a `cmd /C
        // start` shell that would re-parse it. The latter splits an agent URL
        // like `https://x/?a=1&b=2` on the unquoted `&`, truncating it or
        // executing the tail as a command. explorer's non-zero exit on
        // success is harmless: open_path only treats a SPAWN failure as Err.
        "windows" => ("explorer", vec![target.to_string()]),
        // Linux, the BSDs, etc. — the freedesktop launcher.
        _ => ("xdg-open", vec![target.to_string()]),
    }
}

// ───────────────────────────── settings / discovery ─────────────────────────────
//
// App-wide preferences live in `settings.json` next to `projects.json`. Today
// it only holds `repos_dir` (used to auto-suggest unadded repos in the Add
// Project dialog and to power the first-run wizard) and `welcomed` (so the
// wizard fires exactly once per install). Keep this struct additive — fields
// are serde(default) so old files keep parsing as we grow it.

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    /// Directory to scan for git repos when discovering. Empty = unset.
    pub repos_dir: String,
    /// True once the user has finished the welcome wizard.
    pub welcomed: bool,
    /// Registered agent CLIs (claude/gemini/codex defaults + user customs).
    /// Tasks reference these by `id`. Always seeded with the built-ins on
    /// first load so the app is usable out of the box.
    pub agents: Vec<Agent>,
    /// Global sandbox defaults. Merged with the per-project lists when a
    /// task gets created with sandbox enabled, and pre-filled into
    /// the sandbox dialog when the user enables the cage from scratch.
    /// Tasks still freeze a per-task copy at creation time —
    /// editing these later only affects NEW tasks.
    pub sandbox_default_rw_paths: Vec<String>,
    pub sandbox_default_allowed_hosts: Vec<String>,
    /// Personal (this-machine) glob patterns hidden from the "All files"
    /// tree across every project. Unioned with each project's committed
    /// `.termic.yaml` `exclude` list. `.git` is always hidden regardless.
    pub file_tree_exclude: Vec<String>,
    /// On-disk schema version. Gates one-time data migrations (see
    /// `migrate_workspaces_to_tasks`). 0 (default, absent in old files)
    /// means pre-Task-rename layout; bumped to `TASKS_SCHEMA_VERSION` once
    /// the workspaces->tasks migration has committed.
    #[serde(default)]
    pub schema_version: u32,
    /// When on (the default), a best-effort `git fetch` of the base ref runs
    /// before a new task's branch is cut, so it starts from the latest remote
    /// commit instead of a stale local `origin/*` (GH #79). `None` (absent in
    /// pre-#79 files) means on; users on flaky networks can set it `false` to
    /// opt out. See `git_fetch_base` — the fetch is always time-bounded and
    /// non-fatal regardless of this toggle.
    #[serde(default)]
    pub fetch_before_create: Option<bool>,
}

/// Whether the pre-create base fetch (GH #79) is enabled. Default-on: only an
/// explicit `Some(false)` in settings disables it.
fn fetch_before_create_enabled() -> bool {
    load_settings_inner().fetch_before_create != Some(false)
}

/// Current on-disk schema version. Bump when adding a migration and gate it
/// on `settings.schema_version < NEW_VALUE`.
const TASKS_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,                  // stable key referenced by Task.cli
    pub display_name: String,
    pub command: String,             // binary or shell command to spawn
    #[serde(default)]
    pub args: Vec<String>,
    /// Icon identifier consumed by the frontend. Either a brand id ("claude",
    /// "gemini", "codex") or a lucide name prefixed with "lucide:" (e.g.
    /// "lucide:terminal"). Frontend resolves; backend just stores the string.
    pub icon_id: String,
    /// Hex color string ("#d97757") for the icon tint in the UI.
    pub color: String,
    /// User-flagged built-in (the original 3). Built-ins can be edited but not
    /// removed. We use this both at seed-time and at delete-time as a guard.
    #[serde(default)]
    pub builtin: bool,
    /// User toggle: hide this agent from the CLI pickers (worktree
    /// popover, New Task, Review, the + tab menu). Settings →
    /// Agent CLIs still lists it so it can be re-enabled. Does NOT
    /// affect tasks already bound to this agent — they keep
    /// resolving it. `#[serde(default)]` → false for pre-agents files.
    #[serde(default)]
    pub disabled: bool,
    /// Optional per-agent capabilities. ALL fields are optional — when missing,
    /// the corresponding UI gracefully omits the feature rather than failing.
    /// Lets CLIs drift independently of app code: if Anthropic renames
    /// `--dangerously-skip-permissions`, the user edits this here and ships on.
    #[serde(default)]
    pub capabilities: AgentCapabilities,
    /// Per-agent environment variables. Merged into the inherited parent env
    /// at spawn time (after the parent env, so these win). Useful for things
    /// like `CLAUDE_CODE_NO_FLICKER=1` or pointing the CLI at a custom config
    /// dir without wrapping it in a shell script. Keys/values stored verbatim;
    /// the UI parses `KEY=VAL` lines and round-trips them through this map.
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Paths joined into the task sandbox allow-list whenever this
    /// agent's CLI is launched. The sandbox is allowlist-only (default-deny
    /// reads + writes outside this set); per-agent paths cover the dirs the
    /// CLI itself needs (its config / session / cache). Cannot be removed
    /// per-task — the task's own `sandbox_rw_paths` only ADDS
    /// to this set. `$HOME` substitution happens at sandbox provision time.
    #[serde(default)]
    pub sandbox_allowed_paths: Vec<String>,
    /// Allowed-host regexes/wildcards joined into the sandbox proxy
    /// allow-list whenever this agent's CLI runs — the per-agent
    /// network counterpart to `sandbox_allowed_paths`. Lets "Allow ·
    /// per agent" persist a host so every task using this agent
    /// (across all projects) can reach it. Wildcards (`*.x.com`) are
    /// translated to regex at render time, same as task hosts.
    #[serde(default)]
    pub sandbox_allowed_hosts: Vec<String>,
    /// Whether the work-done badge/bell is active for this agent.
    /// Defaults to true. Set to false for custom CLIs that emit signals
    /// in ways that cause too many false positives (e.g. continuous OSC
    /// output, unusual title patterns, never-quiet PTYs).
    #[serde(default = "default_true")]
    pub work_done: bool,
    /// ID of the agent this one was cloned from. Purely informational —
    /// surfaced in the UI as "extends: <name>" in the settings card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    /// "agent" (default) or "terminal". Terminal entries share the registry
    /// (same persistence, env, sandbox lists) but spawn with shell semantics:
    /// command + args are joined into one line and run through the user's
    /// login shell, and none of the agent machinery applies (no resume, no
    /// work-done detection, no message queue, broadcast default-unchecked).
    /// Issue #27: lets users add e.g. a devcontainer shell to the + menu's
    /// "New terminal" section. `#[serde(default)]` → "agent" for old files.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Shell command run on the first normal PTY exit when no session ID is
    /// stored yet. stdout (trimmed) is saved as the tab's resume session ID
    /// so subsequent spawns can use `resume_id_args` (e.g. `--session <id>`).
    /// Used for CLIs that create sessions lazily (e.g. opencode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_launch_capture: Option<PostLaunchCapture>,
}

fn default_true() -> bool { true }
fn default_kind() -> String { "agent".into() }

/// Shell command run on first PTY exit to capture the CLI's session ID.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PostLaunchCapture {
    pub command: String,
}

/// Per-agent work-done signal patterns (regex sources). Frontend-consumed:
/// the TS classifier tests them; Rust only round-trips them so they persist
/// in settings.json. Issue #68.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentSignals {
    pub busy: Vec<String>,
    pub idle: Vec<String>,
    pub attention: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentCapabilities {
    /// Args appended when YOLO mode is on. Empty → YOLO is a no-op for this agent.
    pub yolo_args: Vec<String>,
    /// Slash-style command sent to a live PTY to switch it INTO YOLO
    /// mid-session. Empty → the YOLO toggle needs a respawn instead.
    /// (A legacy `{mode}` placeholder is still substituted at send time
    /// for back-compat with the old single-field config.)
    pub runtime_yolo_command: String,
    /// Slash-style command sent to a live PTY to switch it back to the
    /// default approval mode (YOLO off). Empty → falls back to
    /// `runtime_yolo_command` (with `{mode}` → "default"), else respawn.
    pub runtime_default_command: String,
    /// Args appended on spawn AFTER the first one for a given worktree
    /// (gated by `Task.spawn_count > 0`). Lets the CLI resume its own
    /// per-directory history file. Empty → no auto-resume for this agent.
    #[serde(default)]
    pub resume_args: Vec<String>,
    /// FIRST-spawn args for an id-capable CLI (claude, gemini). Must
    /// contain `{UUID}` which expands to a freshly-minted uuid that the
    /// frontend then persists on the task. Subsequent spawns use
    /// `resume_id_args` with the same uuid. Empty → CLI doesn't support
    /// deterministic sessions; the legacy `resume_args` path is used.
    #[serde(default)]
    pub session_id_args: Vec<String>,
    /// Subsequent-spawn args for an id-capable CLI. Must contain
    /// `{UUID}` which expands to the previously-minted uuid.
    #[serde(default)]
    pub resume_id_args: Vec<String>,
    /// Always-applied args (every spawn). Useful for things like
    /// `--name {WORKSPACE_SLUG}` so claude's /resume picker shows
    /// termic's task name. Placeholders: {WORKSPACE_SLUG},
    /// {WORKSPACE_NAME}, {WORKSPACE_ID}, {BRANCH}, {PORT}.
    #[serde(default)]
    pub name_args: Vec<String>,
    /// Custom work-done signal patterns (regex sources), frontend-consumed:
    /// the TS classifier tests them against the agent's title (and stdout
    /// lines when `match_output`). Rust only persists them. Issue #68.
    #[serde(default)]
    pub signals: AgentSignals,
    /// Tier 3: also scan stdout lines against `signals`, not just the title.
    #[serde(default)]
    pub match_output: bool,
}

fn default_agents() -> Vec<Agent> {
    vec![
        Agent {
            id: "claude".into(),
            display_name: "claude".into(),
            command: "claude".into(),
            // No base args. The `--name {task_slug}` + `--resume {slug}`
            // scheme was reverted: claude either doesn't support `--name`
            // (silently ignored) or the named-session lookup drops users
            // into the interactive picker when no matching session exists
            // yet — both end up stuck on claude's "Resume session" prompt
            // instead of in a usable conversation.
            args: vec![],
            icon_id: "claude".into(),
            color: "#d97757".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--dangerously-skip-permissions".into()],
                runtime_yolo_command: String::new(),
                runtime_default_command: String::new(),
                // Legacy `--continue` fallback. Active only when this
                // task has no termic-owned uuid stored yet (old
                // tasks created before id-based resume landed).
                resume_args: vec!["--continue".into()],
                // Termic owns the session uuid → deterministic resume
                // that survives across restarts AND is safe inside the
                // repo root (won't grab the user's external sessions
                // sharing that cwd).
                // First (mint) spawn: `--session-id <uuid>` creates the
                // session with termic's id. Later spawns: `--resume <uuid>`
                // resumes that same id.
                session_id_args: vec!["--session-id".into(), "{UUID}".into()],
                resume_id_args:  vec!["--resume".into(),     "{UUID}".into()],
                // Surface termic's task name in claude's /resume
                // picker + prompt box + terminal title. Stamped on the mint
                // spawn only (gated to the first id spawn in spawnArgsForCli).
                name_args: vec!["--name".into(), "{WORKSPACE_SLUG}".into()],
                signals: AgentSignals::default(),
                match_output: false,
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                // Covers $HOME/.claude/, $HOME/.claude.json,
                // $HOME/.claude.lock, $HOME/.claude.json.lock, and
                // $HOME/.claude.json.tmp.<pid>.<hash> atomic-write
                // tempfiles in one shot. (subpath ...) in seatbelt
                // only matches `prefix/` boundary, so the sidecar
                // files needed a regex or an explicit literal each.
                "regex:^$HOME/\\.claude(\\.[^/]*|/.*)?$".into(),
                "$HOME/.config/claude".into(),
                "$HOME/.local/share/claude".into(),
                "$HOME/.local/state/claude".into(),
                "$HOME/Library/Application Support/Claude".into(),
                // ~/.agents (the skills convention) is universal — see
                // builtin_runtime_paths in sandbox.rs; not duplicated here.
            ],
            sandbox_allowed_hosts: vec![],
            work_done: true,
            extends: None,
            kind: "agent".into(),
            post_launch_capture: None,
        },
        Agent {
            id: "codex".into(),
            display_name: "codex".into(),
            command: "codex".into(),
            args: vec![],
            icon_id: "codex".into(),
            color: "#16a34a".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--dangerously-bypass-approvals-and-sandbox".into()],
                runtime_yolo_command: String::new(),
                runtime_default_command: String::new(),
                // codex uses a subcommand for resume: `codex resume --last`
                // (most-recent session in CWD). Composes correctly with
                // global flags placed before: `codex --yolo resume --last`.
                resume_args: vec!["resume".into(), "--last".into()],
                session_id_args: vec![],
                resume_id_args: vec![],
                name_args: vec![],
                signals: AgentSignals::default(),
                match_output: false,
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                "$HOME/.codex".into(),
                "$HOME/.config/codex".into(),
                "$HOME/.local/share/codex".into(),
                "$HOME/.local/state/codex".into(),
                "$HOME/Library/Application Support/Codex".into(),
            ],
            sandbox_allowed_hosts: vec![],
            work_done: true,
            extends: None,
            kind: "agent".into(),
            post_launch_capture: None,
        },
        Agent {
            // Google Antigravity CLI (`agy`), launched 2025-11-18 — a
            // Gemini-3-family agentic CLI. `id` is the binary name to
            // keep the id == command == detect-name invariant the rest
            // of the codebase relies on; `display_name` carries the
            // brand.
            id: "agy".into(),
            display_name: "Antigravity".into(),
            command: "agy".into(),
            args: vec![],
            icon_id: "agy".into(),
            color: "#8b5cf6".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                // From `agy --help` (Antigravity CLI 1.0.0):
                // `--dangerously-skip-permissions` auto-approves every
                // tool permission prompt — same shape as claude's flag.
                yolo_args: vec!["--dangerously-skip-permissions".into()],
                // No documented slash command for a live YOLO toggle.
                runtime_yolo_command: String::new(),
                runtime_default_command: String::new(),
                // `--continue` (`-c`) continues the most recent
                // conversation in CWD with no interactive picker.
                resume_args: vec!["--continue".into()],
                session_id_args: vec![],
                resume_id_args: vec![],
                name_args: vec![],
                signals: AgentSignals::default(),
                match_output: false,
            },
            env: std::collections::HashMap::new(),
            // Antigravity is a Gemini-family CLI and actually keeps its
            // per-project state under ~/.gemini (the `.antigravitycli/`
            // dir it drops in a repo just symlinks into
            // ~/.gemini/config/projects/…), so .gemini must be allowed
            // for it to work caged. The rest are conventional spots its
            // own config might land — additive + harmless if absent;
            // trim/extend in Settings → Agent CLIs once confirmed.
            sandbox_allowed_paths: vec![
                "$HOME/.gemini".into(),
                "$HOME/.antigravity".into(),
                "$HOME/.agy".into(),
                "$HOME/.config/antigravity".into(),
                "$HOME/.config/agy".into(),
                "$HOME/.local/share/antigravity".into(),
                "$HOME/.local/state/antigravity".into(),
                "$HOME/Library/Application Support/Antigravity".into(),
            ],
            sandbox_allowed_hosts: vec![],
            work_done: true,
            extends: None,
            kind: "agent".into(),
            post_launch_capture: None,
        },
        Agent {
            // GitHub Copilot CLI (`copilot`). Launched 2025; supports
            // --session-id for both minting and resuming sessions,
            // --name for labelling, --allow-all / --yolo for permissions,
            // and /yolo on|off for live approval-mode switching.
            id: "copilot".into(),
            display_name: "copilot".into(),
            command: "copilot".into(),
            args: vec![],
            icon_id: "copilot".into(),
            color: "#54aeff".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--allow-all".into()],
                // Live approval-mode toggle via slash commands.
                runtime_yolo_command: "/yolo on".into(),
                runtime_default_command: "/yolo off".into(),
                // Worktree fallback: resume most-recent CWD session.
                resume_args: vec!["--continue".into()],
                // Repo-root sessions: --session-id serves as both the
                // mint (new UUID) and the resume (same UUID) flag.
                session_id_args: vec!["--session-id".into(), "{UUID}".into()],
                resume_id_args:  vec!["--session-id".into(), "{UUID}".into()],
                name_args: vec!["--name".into(), "{WORKSPACE_SLUG}".into()],
                signals: AgentSignals::default(),
                match_output: false,
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                "$HOME/.copilot".into(),
                "$HOME/.config/copilot".into(),
                "$HOME/.local/share/copilot".into(),
                "$HOME/.local/state/copilot".into(),
                "$HOME/Library/Application Support/GitHub Copilot".into(),
            ],
            sandbox_allowed_hosts: vec![],
            work_done: true,
            extends: None,
            kind: "agent".into(),
            post_launch_capture: None,
        },
        Agent {
            // xAI's Grok Build TUI. Help text confirmed:
            //   --always-approve     auto-approves every tool call (yolo)
            //   -c, --continue       continue the most recent CWD session
            //   sessions / memory    state lives under ~/.grok by default
            id: "grok".into(),
            display_name: "grok".into(),
            command: "grok".into(),
            args: vec![],
            icon_id: "grok".into(),
            color: "#cbd5e1".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--always-approve".into()],
                // No documented slash command for a live YOLO toggle.
                runtime_yolo_command: String::new(),
                runtime_default_command: String::new(),
                resume_args: vec!["--continue".into()],
                session_id_args: vec![],
                resume_id_args: vec![],
                name_args: vec![],
                signals: AgentSignals::default(),
                match_output: false,
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                "$HOME/.grok".into(),
                "$HOME/.config/grok".into(),
                "$HOME/.local/share/grok".into(),
                "$HOME/.local/state/grok".into(),
                "$HOME/Library/Application Support/Grok".into(),
            ],
            sandbox_allowed_hosts: vec![],
            work_done: true,
            extends: None,
            kind: "agent".into(),
            post_launch_capture: None,
        },
        Agent {
            // opencode — SST's open-source agentic coding CLI. Sessions are
            // created lazily (only after the first user message), so termic
            // can't mint a UUID at spawn time. Resume strategy:
            //   - worktrees: `--continue` resumes the last CWD session
            //     (safe because each worktree has its own unique directory).
            //   - on first PTY exit: post_launch_capture runs
            //     `opencode session list | grep … | cut …`, stores the ID.
            //   - subsequent spawns: `--session <captured-id>` via resume_id_args.
            id: "opencode".into(),
            display_name: "opencode".into(),
            command: "opencode".into(),
            args: vec![],
            icon_id: "opencode".into(),
            color: "#cfcecd".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                yolo_args: vec![],
                runtime_yolo_command: String::new(),
                runtime_default_command: String::new(),
                resume_args: vec!["--continue".into()],
                session_id_args: vec![],
                resume_id_args: vec!["--session".into(), "{UUID}".into()],
                name_args: vec![],
                signals: AgentSignals::default(),
                match_output: false,
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                "$HOME/.config/opencode".into(),
                "$HOME/.local/share/opencode".into(),
                "$HOME/.local/state/opencode".into(),
                "$HOME/Library/Application Support/opencode".into(),
            ],
            sandbox_allowed_hosts: vec![],
            work_done: true,
            extends: None,
            kind: "agent".into(),
            post_launch_capture: Some(PostLaunchCapture {
                command: "opencode session list | grep -m1 '^ses_' | cut -d' ' -f1".into(),
            }),
        },
    ]
}

fn settings_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

pub(crate) fn load_settings_inner() -> Settings {
    let f = match settings_file() { Ok(p) => p, Err(_) => return seeded_defaults() };
    let mut s: Settings = match fs::read_to_string(&f) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    // Seed defaults if the agents list is empty (first launch OR pre-agents
    // upgrade). We also re-merge the 3 built-ins back in if the user removed
    // them — they're flagged `builtin: true` and meant to always be present.
    if s.agents.is_empty() {
        s.agents = default_agents();
    } else {
        for def in default_agents() {
            if !s.agents.iter().any(|a| a.id == def.id) {
                s.agents.push(def);
            }
        }
        // Re-sort so builtins appear in canonical default_agents() order.
        // Custom agents (not in the default list) sort to the end, stable
        // so their relative order among each other is preserved.
        let order: Vec<String> = default_agents().iter().map(|a| a.id.clone()).collect();
        s.agents.sort_by_key(|a| {
            order.iter().position(|id| id == &a.id).unwrap_or(usize::MAX)
        });
    }
    // Migration: backfill missing `sandbox_allowed_paths` entries on
    // BUILT-IN agents. We MERGE the shipped defaults into the stored
    // list (preserving user-added entries + ordering) rather than
    // replacing. This way each release that adds a new shipped path
    // (e.g. the v0.3.11 → 0.3.12 regex consolidation for claude's
    // sidecars) flows out to existing installs without the user
    // needing to click Reset.
    //
    // Trade-off: a user who DELIBERATELY removed a shipped path will
    // see it come back on the next launch. Acceptable because (a) the
    // shipped list is the minimum the CLI needs to function, removing
    // entries usually breaks the agent, and (b) it's a single line
    // to re-remove in Settings → Agents. Custom agents are left alone.
    let mut migrated = false;
    for def in default_agents() {
        if let Some(a) = s.agents.iter_mut().find(|a| a.id == def.id && a.builtin) {
            let existing: std::collections::HashSet<&String> =
                a.sandbox_allowed_paths.iter().collect();
            let missing: Vec<String> = def.sandbox_allowed_paths
                .iter()
                .filter(|p| !existing.contains(p))
                .cloned()
                .collect();
            drop(existing);
            if !missing.is_empty() {
                a.sandbox_allowed_paths.extend(missing);
                migrated = true;
            }
        }
    }
    // Migration: the runtime YOLO toggle used to be ONE `{mode}`-templated
    // command; it's now two explicit commands (switch-into-YOLO and
    // switch-to-default). Split any legacy `{mode}` value across both
    // fields so the Settings form shows them filled. Runs for built-in
    // AND custom agents — the split is behaviour-preserving either way
    // ({mode} is still substituted at send time, so un-migrated configs
    // also keep working).
    for a in s.agents.iter_mut() {
        let c = &mut a.capabilities;
        if c.runtime_default_command.is_empty() && c.runtime_yolo_command.contains("{mode}") {
            c.runtime_default_command = c.runtime_yolo_command.replace("{mode}", "default");
            c.runtime_yolo_command = c.runtime_yolo_command.replace("{mode}", "yolo");
            migrated = true;
        }
    }
    // Migration: id-based session resume (session_id_args / resume_id_args
    // / name_args). Settings files predating this release have the
    // fields default-deserialized to empty vecs; seed them from the
    // shipped defaults for the built-in agents that support id-resume
    // so existing users get the feature on next launch without having
    // to click Reset. Custom agents + agents the user has customized
    // are left alone (only acts when the destination field is empty).
    let defaults = default_agents();
    for a in s.agents.iter_mut().filter(|a| a.builtin) {
        let Some(def) = defaults.iter().find(|d| d.id == a.id) else { continue; };
        let c = &mut a.capabilities;
        let d = &def.capabilities;
        if c.session_id_args.is_empty() && !d.session_id_args.is_empty() {
            c.session_id_args = d.session_id_args.clone();
            migrated = true;
        }
        if c.resume_id_args.is_empty() && !d.resume_id_args.is_empty() {
            c.resume_id_args = d.resume_id_args.clone();
            migrated = true;
        }
        if c.name_args.is_empty() && !d.name_args.is_empty() {
            c.name_args = d.name_args.clone();
            migrated = true;
        }
    }
    // Persist the migration so jq / external tooling sees the fields,
    // and so subsequent loads don't re-do the same work. Best-effort:
    // a read-only filesystem or transient I/O error shouldn't fail the
    // load (in-memory state is still correct).
    if migrated {
        if let Ok(f) = settings_file() {
            if let Ok(serialized) = serde_json::to_string_pretty(&s) {
                let _ = fs::write(f, serialized);
            }
        }
    }
    s
}

fn seeded_defaults() -> Settings {
    Settings { agents: default_agents(), ..Settings::default() }
}

#[tauri::command]
fn settings_load() -> Settings { load_settings_inner() }

/// Expose the ship-time defaults for the agent registry. Used by the
/// Settings → Agents UI to show "modified" indicators and offer a
/// "Reset to defaults" affordance — without this, users who customized
/// any agent field on a prior release would never pick up improvements
/// to the default flags (e.g., when we updated claude's resume scheme
/// from `--continue` to `--resume <name>`).
#[tauri::command]
fn agents_defaults() -> Vec<Agent> { default_agents() }

/// Run a shell command in `cwd` via `sh -lc` and return trimmed stdout.
/// Used by post_launch_capture to harvest the CLI's session ID after exit.
#[tauri::command]
fn run_capture_command(cmd: String, cwd: String) -> Result<String, String> {
    let out = std::process::Command::new("sh")
        .args(["-lc", &cmd])
        .current_dir(&cwd)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
fn settings_save(s: Settings) -> Result<(), String> {
    let f = settings_file().map_err(|e| e.to_string())?;
    fs::write(f, serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Replace just the agents list, preserving the rest of settings (repos_dir,
/// welcomed, etc.). Used by the Settings → Agents page so the user can edit
/// CLI commands, args, and YOLO flags without us shipping a new release every
/// time an agent CLI changes a flag.
#[tauri::command]
fn agents_save(agents: Vec<Agent>) -> Result<(), String> {
    let mut s = load_settings_inner();
    // Defensive: ensure no two agents share an id (would break task.cli
    // lookups). If duplicates, keep the first occurrence.
    let mut seen = std::collections::HashSet::new();
    s.agents = agents.into_iter().filter(|a| seen.insert(a.id.clone())).collect();
    let f = settings_file().map_err(|e| e.to_string())?;
    fs::write(f, serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

// ───────────────────────────── custom themes ─────────────────────────────

/// One custom theme file from the themes config dir (see
/// `themes_dir_path`). `id` is the file stem (the frontend namespaces it
/// as `custom:<id>`); `ui` / `terminal` are passed through as raw JSON
/// maps — the frontend allowlist-validates keys and color values, so a
/// bad entry degrades per-key instead of failing the file. Unknown
/// top-level JSON fields are ignored (forward compat). Serialized
/// camelCase to match the on-disk file format.
///
/// The value type is `serde_json::Value`, not `String`: typing it as
/// String makes serde reject the WHOLE file on one non-string value
/// (`"bg": 123` silently discarded the file's valid keys too), which
/// contradicts the documented per-key degradation. Non-strings now reach
/// the frontend and its `isValidColor` typeof check drops them per-key.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomThemeFile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color_scheme: String,
    #[serde(default)]
    pub ui: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub terminal: HashMap<String, serde_json::Value>,
}

/// `$XDG_CONFIG_HOME/termic/themes`, defaulting to `~/.config/termic/themes`
/// — the same path shape on every platform (wezterm/starship convention;
/// on Windows `~` is the user profile dir). Themes are hand-authored,
/// stowable config, unlike the app-owned JSON in `data_dir()`, so they
/// live under `.config` and deliberately skip the `termic_dev` split
/// (dev builds should see your real themes; the files are inert and
/// validated, so they can't destabilize a dev run).
/// Seeded into an EMPTY themes dir so "Open themes folder" never drops the
/// user into a blank window with nothing to copy. Neither file ends in
/// `.json`, so `themes_list` skips both and no phantom theme shows up in
/// the picker.
const THEMES_README: &str = include_str!("../assets/themes/README.md");
const THEMES_EXAMPLE: &str = include_str!("../assets/themes/example.json.sample");

/// Best-effort seed. A write failure must never block listing themes, so
/// this logs and moves on. Only runs when the directory has no entries at
/// all: once the user puts anything here (a theme, or nothing but their own
/// notes) we never write again, and deleting the samples sticks.
fn seed_themes_dir(dir: &Path) {
    let empty = fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false);
    if !empty {
        return;
    }
    for (name, body) in [
        ("README.md", THEMES_README),
        ("example.json.sample", THEMES_EXAMPLE),
    ] {
        if let Err(e) = fs::write(dir.join(name), body) {
            eprintln!("[themes] could not seed {name}: {e}");
        }
    }
}

fn themes_dir_path() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .ok_or_else(|| anyhow!("no home"))?;
    let p = base.join("termic").join("themes");
    fs::create_dir_all(&p)?;
    seed_themes_dir(&p);
    Ok(p)
}

/// List every parseable custom theme file in the themes dir. A file
/// that fails to read or parse is skipped with a log line — one bad JSON
/// must never blank the theme picker. Sorted by file stem for stable order.
#[tauri::command]
async fn themes_list() -> Result<Vec<CustomThemeFile>, String> {
    let dir = themes_dir_path().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[themes] skipping {}: {e}", path.display());
                continue;
            }
        };
        match serde_json::from_str::<CustomThemeFile>(&raw) {
            Ok(mut theme) => {
                theme.id = stem.to_string();
                if theme.name.trim().is_empty() {
                    theme.name = stem.to_string();
                }
                out.push(theme);
            }
            Err(e) => eprintln!("[themes] skipping {}: {e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Ensure the themes directory exists and return its absolute path.
/// Backs the picker's "Open themes folder" row.
#[tauri::command]
async fn themes_dir() -> Result<String, String> {
    Ok(themes_dir_path()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned())
}

#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredRepo {
    pub path: String,
    pub name: String,
    /// True if this repo is already in projects.json (so the UI can render it
    /// disabled / labeled "added" instead of hiding it — less surprising).
    pub already_added: bool,
}

/// Best-effort "last activity" time for a repo, used to sort the discovery
/// list newest-first. The reflog (`.git/logs/HEAD`) is appended on every
/// commit / checkout / reset / merge, so its mtime tracks real activity;
/// fall back to the `.git` dir, then the repo dir. Just a stat per candidate,
/// no git subprocess, so the scan stays cheap even on a folder of many repos.
fn repo_activity_time(repo: &Path) -> std::time::SystemTime {
    let git = repo.join(".git");
    for cand in [git.join("logs").join("HEAD"), git.clone(), repo.to_path_buf()] {
        if let Ok(t) = fs::metadata(&cand).and_then(|m| m.modified()) {
            return t;
        }
    }
    std::time::SystemTime::UNIX_EPOCH
}

/// Walk up to two levels under `dir` and return any subdirectory that
/// contains a `.git` entry. A direct child that is itself a repo is taken
/// as-is (never descended into — avoids nested clones); a child that is NOT
/// a repo is treated as a grouping folder (e.g. `code/<category>/<repo>`)
/// and its children are scanned once more. Hidden dirs and `node_modules`
/// are skipped at both levels. Sorted by most recent activity (newest
/// first) so the repos you actually work in surface at the top.
#[tauri::command]
fn discover_repos(dir: String) -> Result<Vec<DiscoveredRepo>, String> {
    let root = PathBuf::from(shellexpand(&dir));
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let added: std::collections::HashSet<String> = load_projects()
        .into_iter()
        .map(|p| p.root_path)
        .collect();
    let mut out: Vec<(DiscoveredRepo, std::time::SystemTime)> = Vec::new();
    // Dedup by CANONICAL path: a repo can be reachable both directly and via a
    // grouping folder (e.g. a `code/all -> code` symlink, or the two-level
    // scan below re-finding a direct child), and canonicalize() collapses
    // those to one real path. Without this every such repo lists twice.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push_repo = |path: &PathBuf,
                     out: &mut Vec<(DiscoveredRepo, std::time::SystemTime)>,
                     seen: &mut std::collections::HashSet<String>| {
        let canon = fs::canonicalize(path).unwrap_or(path.clone());
        let path_str = canon.to_string_lossy().into_owned();
        if !seen.insert(path_str.clone()) { return; } // already discovered
        let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string();
        let already_added = added.contains(&path_str);
        let activity = repo_activity_time(&canon);
        out.push((DiscoveredRepo { path: path_str, name, already_added }, activity));
    };
    let skip = |p: &PathBuf| -> bool {
        match p.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.starts_with('.') || n == "node_modules",
            None => true,
        }
    };
    let rd = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() || skip(&path) { continue; }
        if path.join(".git").exists() {
            push_repo(&path, &mut out, &mut seen);
            continue;
        }
        // Grouping folder: scan its children for repos (one extra level).
        let Ok(rd2) = fs::read_dir(&path) else { continue };
        for e2 in rd2.flatten() {
            let p2 = e2.path();
            if !p2.is_dir() || skip(&p2) { continue; }
            if p2.join(".git").exists() {
                push_repo(&p2, &mut out, &mut seen);
            }
        }
    }
    // Most recent activity first; tie-break by name so the order is stable.
    out.sort_by(|a, b| b.1.cmp(&a.1)
        .then_with(|| a.0.name.to_lowercase().cmp(&b.0.name.to_lowercase())));
    Ok(out.into_iter().map(|(r, _)| r).collect())
}

/// Tilde expansion only — Tauri's dialog already returns absolute paths, but
/// the user might type "~/code" in the input.
fn shellexpand(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest).to_string_lossy().into_owned();
        }
    }
    s.to_string()
}

#[derive(Clone, Debug, Serialize)]
pub struct CliInfo {
    pub name: String,
    pub found: bool,
    pub path: String,
    pub version: String,
}

/// Enumerate every installed monospace font family on the system. Used by
/// the Appearance picker so the user sees all real options, not just our
/// curated probe list. Cached in-process via OnceLock.
///
/// CRITICAL: this MUST be `async` — Tauri runs sync commands on the main
/// thread, and font-kit's first enumeration loads every installed font face
/// to read its PANOSE/post tables, which can take several hundred ms to a
/// few seconds. Blocking the main thread freezes the whole UI. Async +
/// spawn_blocking moves the heavy work to a worker thread.
#[tauri::command]
async fn list_monospace_fonts() -> Vec<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    if let Some(v) = CACHE.get() { return v.clone(); }
    let computed = tauri::async_runtime::spawn_blocking(|| {
        use font_kit::source::SystemSource;
        let src = SystemSource::new();
        let families = src.all_families().unwrap_or_default();
        let mut out: Vec<String> = families.into_iter()
            // Probe one face per family — if the regular face is monospace,
            // the family qualifies. is_monospace() reads PANOSE/post table.
            .filter(|family| {
                src.select_family_by_name(family).ok()
                    .and_then(|handles| handles.fonts().first().cloned())
                    .and_then(|h| h.load().ok())
                    .map(|f| f.is_monospace())
                    .unwrap_or(false)
            })
            // Hide PostScript-style names (those starting with a dot like
            // ".AppleSystemUIFont") — they're internal to the OS.
            .filter(|n| !n.starts_with('.'))
            .collect();
        out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        out.dedup();
        out
    }).await.unwrap_or_default();
    // get_or_init would race with the spawn_blocking — set explicitly and
    // tolerate a tiny chance of double-compute (still correct, same result).
    let _ = CACHE.set(computed.clone());
    computed
}

/// Probe each registered agent's `command` to see whether it resolves.
/// Drives the install-status badge in Settings → Agent CLIs and the
/// "hide uninstalled" filtering of the CLI pickers. Registry-driven, so
/// custom agents (and renamed/absolute commands) are covered — not just
/// the built-ins. `CliInfo.name` is the agent `id` so the frontend can
/// match each result back to the registry.
///
/// Detection falls back to hard-coded common install locations when
/// `command -v` returns empty — covers two real cases:
///   1. The CLI is a shell function (`claude () { ... }`) so `command -v`
///      returns a function body, not a binary path.
///   2. termic launched from a stripped-PATH context (Finder / .app)
///      where /opt/homebrew/bin is missing.
///
/// async + spawn_blocking: spawns a `command -v` plus a version probe
/// per agent, and runs at startup — must stay off the IPC/WKWebView
/// thread (see the long-running-IPC discipline in CLAUDE.md).
#[tauri::command]
async fn detect_clis() -> Vec<CliInfo> {
    tauri::async_runtime::spawn_blocking(detect_clis_blocking)
        .await
        .unwrap_or_default()
}

fn detect_clis_blocking() -> Vec<CliInfo> {
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let agents = load_settings_inner().agents;
    // Probe agents concurrently — each agent costs a login-shell spawn
    // (`sh -lc`, which sources the user's profile and can take hundreds
    // of ms) plus a `--version` probe. Serially across 5+ agents that
    // ran 2-5s at startup, long enough that the first popover opened
    // before detection resolved and fell back to showing every agent.
    // One thread per agent collapses the wall-clock to a single probe.
    let handles: Vec<_> = agents.iter().map(|agent| {
        let id = agent.id.clone();
        let bin = agent.command.trim().to_string();
        let home = home.clone();
        thread::spawn(move || {
            let bin = bin.as_str();
            let mut found = false;
            let mut path = String::new();

            if bin.is_empty() {
                // No command configured — nothing to probe.
            } else if bin.starts_with('/') {
                // Absolute path (e.g. set via the welcome wizard's binary
                // picker) — just check existence, no PATH lookup.
                if Path::new(bin).exists() {
                    found = true;
                    path = bin.to_string();
                }
            } else {
                // PATH lookup via login shell — the common case.
                if let Ok(o) = Command::new("/usr/bin/env")
                    .args(["sh", "-lc", &format!("command -v {} 2>/dev/null", bin)])
                    .output()
                {
                    if o.status.success() {
                        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        // Reject shell-function body lookalikes.
                        if !p.is_empty() && (p.starts_with('/') || p.starts_with('~')) {
                            found = true;
                            path = p;
                        }
                    }
                }
                // Fallback: probe common macOS install locations directly.
                if !found {
                    for c in [
                        format!("{home}/.local/bin/{bin}"),
                        format!("/opt/homebrew/bin/{bin}"),
                        format!("/usr/local/bin/{bin}"),
                        format!("{home}/.bun/bin/{bin}"),
                        format!("{home}/.cargo/bin/{bin}"),
                    ] {
                        if Path::new(&c).exists() {
                            found = true;
                            path = c;
                            break;
                        }
                    }
                }
            }

            // Best-effort version probe. Use the resolved path when we have
            // it (avoids PATH ambiguity); fall back to the bare command.
            let version = if found {
                let cmd = if path.is_empty() { bin.to_string() } else { path.clone() };
                Command::new(&cmd)
                    .arg("--version")
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string())
                    .unwrap_or_default()
            } else { String::new() };

            CliInfo { name: id, found, path, version }
        })
    }).collect();

    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

// ───────────────────────────── bootstrap ─────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK 2.42+ defaults to its DMA-BUF renderer. It's the FAST path on
    // AMD/Intel (X11 and Wayland) and MUST stay on there: disabling it drops
    // the whole webview onto a slow copy/software compositing path and makes
    // the ENTIRE UI laggy, not just the terminal. The renderer only misbehaves
    // on the proprietary NVIDIA driver, and the right escape hatch differs by
    // session (tauri#9304/#9394, WebKit bug 262607, the webkit2gtk-nvidia-quirk
    // crate). So scope the workaround to NVIDIA proprietary ONLY:
    //   * NVIDIA proprietary + X11     → WEBKIT_DISABLE_DMABUF_RENDERER=1
    //   * NVIDIA proprietary + Wayland → __NV_DISABLE_EXPLICIT_SYNC=1 (keep DMA-BUF)
    // AMD / Intel / nouveau are left entirely untouched. An explicit user-set
    // value always wins. Done BEFORE any GTK/WebKit init.
    #[cfg(target_os = "linux")]
    {
        // The boot/primary GPU is NVIDIA. The boot-GPU gate matters on hybrid
        // laptops (Intel iGPU primary + NVIDIA dGPU for offload): the webview
        // renders on the iGPU there, so DMA-BUF is fine and must stay on.
        fn boot_gpu_is_nvidia() -> bool {
            let mut saw_nvidia = false;
            let Ok(cards) = std::fs::read_dir("/sys/class/drm") else { return false };
            for e in cards.flatten() {
                let name = e.file_name();
                let name = name.to_string_lossy();
                // card0, card1, ... - skip connectors like card0-DP-1.
                if !name.starts_with("card") || name.contains('-') { continue; }
                let dev = e.path().join("device");
                let is_nvidia = std::fs::read_to_string(dev.join("vendor"))
                    .map(|v| v.trim().eq_ignore_ascii_case("0x10de"))
                    .unwrap_or(false);
                saw_nvidia |= is_nvidia;
                // boot_vga=1 marks the primary GPU; its vendor is authoritative.
                if std::fs::read_to_string(dev.join("boot_vga"))
                    .map(|s| s.trim() == "1").unwrap_or(false)
                {
                    return is_nvidia;
                }
            }
            saw_nvidia
        }
        // nouveau registers no `nvidia` kernel module, so this isolates the
        // proprietary driver (the only one with the broken DMA-BUF path).
        let nvidia_proprietary =
            std::path::Path::new("/sys/module/nvidia").exists() && boot_gpu_is_nvidia();
        if nvidia_proprietary {
            let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
            let (var, val) = if wayland {
                ("__NV_DISABLE_EXPLICIT_SYNC", "1")
            } else {
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
            };
            if std::env::var_os(var).is_none() {
                std::env::set_var(var, val);
                dlog(&format!("[gpu] NVIDIA proprietary detected; set {var}={val} (wayland={wayland})"));
            }
        } else {
            dlog("[gpu] non-NVIDIA GPU (or nouveau/offload); keeping WebKitGTK DMA-BUF renderer on");
        }
    }
    tauri::Builder::default()
        // skip_initial_state("main"): we now create the main window
        // programmatically in `setup` (to pick the macOS traffic-light
        // inset per-OS), so we restore its saved bounds OURSELVES in a
        // deterministic order (restore → clamp-up → position → show)
        // instead of letting the plugin's on_window_ready hook race the
        // setup code. The plugin still SAVES bounds on move/resize/close.
        .plugin(tauri_plugin_window_state::Builder::default().skip_initial_state("main").build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // In-app self-update. Reads its endpoint + pubkey from
        // tauri.conf.json → plugins.updater. Frontend calls
        // `check()` / `downloadAndInstall()` via @tauri-apps/plugin-updater.
        // Update packages are ed25519-signed by CI; the public key
        // baked into the bundle verifies them before install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Needed by the frontend updater banner so it can `relaunch()`
        // after `downloadAndInstall()`. Kept separate from updater
        // because the process plugin also exposes exit/restart APIs we
        // may want for other purposes later (debug 'restart app' etc).
        .plugin(tauri_plugin_process::init())
        // Native PDF preview channel. WKWebView renders a PDF served as a real
        // `application/pdf` resource but shows blank for a `data:` URL, so the
        // file-tree preview pane points an `<embed>` at
        // `taskpdf://localhost/<enc id>/<enc path>?v=<rev>` and this handler
        // streams the bytes. It reuses `read_preview_file`, so the same
        // member-aware containment + extension allowlist + 20 MB cap as the
        // base64 read apply; a rejected path is a 404, not a generic file read.
        // spawn_blocking keeps the multi-MB read off the main thread.
        .register_asynchronous_uri_scheme_protocol("taskpdf", |_ctx, request, responder| {
            let uri_path = request.uri().path().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(taskpdf_response(&uri_path));
            });
        })
        .manage(PtyManager::default())
        .setup(|app| {
            // Resolve the user's login-shell PATH off the main thread
            // so the first PTY spawn doesn't wait on shell startup.
            shell_env::warm();
            // One-time on-disk migration for the workspace->task rename
            // (metadata-only: renames the metadata dir + is_repo_root field;
            // never moves worktrees). MUST run before any task load (task_list
            // et al.) so the frontend only ever sees the migrated `tasks/`
            // layout. Best-effort + gated by settings.schema_version, so it's a
            // cheap no-op on every launch after the first.
            migrate_workspaces_to_tasks();
            // The main window is created HERE (not in tauri.conf.json) so the
            // macOS traffic-light inset can be chosen per-OS. macOS Tahoe (26+)
            // stopped vertically centering the window controls in an overlay
            // title bar, so they need to sit ~8px lower than on earlier macOS.
            // Setting the inset through the builder means tao's own
            // re-apply-on-redraw keeps the lights positioned (a runtime objc
            // nudge gets clobbered on every draw, and Tauri exposes no public
            // runtime setter). Created hidden, then positioned on the cursor's
            // monitor BEFORE showing so macOS never sees the window on the
            // primary Space (which would yank the user off a fullscreen app on
            // another display).

            // Pre-Tahoe centers the lights at y=16. The Tahoe title-bar layout
            // renders them higher for the same inset, so they need to sit lower
            // (y=21, dialed in by eye). The layout follows the LINKED SDK: with
            // the CI release now built on the macos-26 runner (Tahoe SDK, see
            // release.yml), every build gets native Tahoe chrome on a Tahoe
            // machine, so the running-OS check (is_macos_tahoe) is the right
            // signal — y=21 on Tahoe, y=16 on the older chrome older OSes get.
            // Overridable at runtime via TERMIC_TRAFFIC_Y so the exact value can
            // be swept without a recompile (set it, relaunch the process, eyeball).
            #[cfg(target_os = "macos")]
            let traffic_y: f64 = std::env::var("TERMIC_TRAFFIC_Y")
                .ok()
                .and_then(|v| v.trim().parse::<f64>().ok())
                .unwrap_or_else(|| if is_macos_tahoe() { 21.0 } else { 16.0 });

            #[allow(unused_mut)]
            let mut builder = tauri::WebviewWindowBuilder::new(
                app.handle(), "main", tauri::WebviewUrl::default(),
            )
            .title("Termic")
            .inner_size(1500.0, 1000.0)
            .min_inner_size(900.0, 600.0)
            .visible(false);

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .traffic_light_position(tauri::LogicalPosition::new(16.0, traffic_y));
            }

            let win = builder.build()?;

            // Restore saved bounds ourselves (the plugin skips "main" via
            // skip_initial_state) so the ordering is deterministic. SIZE +
            // POSITION + MAXIMIZED — but NOT VISIBLE (restore_state would
            // `show()` the window immediately, defeating the
            // position-before-show dance below and risking a flash on the
            // wrong monitor) and NOT FULLSCREEN (would re-enter fullscreen on
            // whatever Space it was saved on — the exact yank we avoid).
            // MAXIMIZED is safe to restore: a zoomed window stays on the
            // current Space, so there's no Space-yank, and a user who quit
            // maximized expects to relaunch maximized.
            {
                use tauri_plugin_window_state::{StateFlags, WindowExt};
                let _ = win.restore_state(
                    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                );
            }

            // A restored-maximized ("zoomed") window already fills one
            // monitor: its inner_size never trips the minimum, and nudging it
            // to the cursor's monitor would un-zoom it. So the clamp-up and
            // cursor-monitor reposition below apply only to normally-sized
            // windows. position_on_cursor_monitor itself no-ops when the
            // restored position is already on the cursor's monitor, so it
            // cooperates with this restore.
            if !win.is_maximized().unwrap_or(false) {
                // tauri-plugin-window-state restores prior bounds verbatim — it
                // does NOT enforce minWidth / minHeight. If a previous session
                // saved a sub-minimum size (seen after some updates and after
                // first-launch races), the window comes back as a postage
                // stamp. Clamp UP here before showing. Physical pixels via
                // inner_size + scale_factor keeps the math correct on retina.
                if let (Ok(sz), scale) = (win.inner_size(), win.scale_factor().unwrap_or(1.0)) {
                    let logical_w = (sz.width  as f64) / scale;
                    let logical_h = (sz.height as f64) / scale;
                    const MIN_W: f64 = 900.0;
                    const MIN_H: f64 = 600.0;
                    if logical_w < MIN_W || logical_h < MIN_H {
                        // Snap back to a comfortable default instead of the
                        // bare min — a 900x600 box is still cramped for the
                        // app's 3-column layout. 1400x900 matches our intended
                        // launch size on fresh installs.
                        let _ = win.set_size(tauri::LogicalSize::new(1400.0_f64, 900.0));
                    }
                }
                let _ = position_on_cursor_monitor(&win);
            }
            let _ = win.show();

            // Dev-only automation bridge (no-op unless debug build AND
            // TERMIC_AUTOMATION=1) - lets an agent drive this instance
            // over localhost HTTP. See automation.rs.
            automation::start(app.handle().clone());
            let _ = win.set_focus();
            #[cfg(target_os = "macos")]
            {
                round_window_corners_for_tahoe(&win);
                // AppKit can rebuild the content view's backing layer on
                // fullscreen enter/exit and zoom transitions, dropping the
                // corner clip we just set. Re-apply on resize (which all those
                // transitions trigger). Cheap + idempotent, no-ops on
                // pre-Tahoe, and window-event callbacks run on the main thread
                // so the AppKit access stays valid.
                let win_for_corners = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(_) = event {
                        round_window_corners_for_tahoe(&win_for_corners);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects_list, project_add, project_add_multi, project_set_members, project_update, project_remove, project_reorder, project_set_group,
            tasks_list, task_create, task_create_multi, task_open_repo, task_importable_worktrees, task_import_worktree, task_archive, task_set_cli, task_set_custom_command, task_set_resume_override, task_set_sandbox, task_set_yolo,
            sandbox_available, sandbox_deny_counts, sandbox_recent_denied_hosts, sandbox_recent_denied_paths, sandbox_access_counts, sandbox_recent_access_hosts, sandbox_recent_access_paths, sandbox_set_monitor_filters, task_sandbox_add_allowed_host, task_sandbox_add_allowed_path, task_sandbox_remove_allowed_path, agent_sandbox_add_allowed_path, agent_sandbox_add_allowed_host, task_recent_denials,
            repo_config_load, repo_config_load_at, repo_config_save, repo_config_scaffold, repo_config_add_allowed_host, repo_config_add_allowed_path,

            task_restore, task_delete, task_run_script, task_run_script_stream, task_stop_script, task_record_spawn, task_set_has_history, task_set_agent_session_id,
            task_set_tabs, task_set_tab_session_id,
            task_set_split_layout,
            task_set_right_tabs, task_set_right_tab_session_id,
            task_grep_start, task_grep_cancel,
            task_spotlight_start, task_spotlight_stop, task_spotlight_resync, task_spotlight_status,
            task_diff, task_files, task_list_files_for_finder, task_send_diff_to_main,
            task_changes, task_git_status, task_stage, task_unstage, task_commit, task_discard,
            task_file_diff, task_file_diff_sides, task_file_read, task_file_read_base64, task_file_write, task_dir_list, task_path_stat,
            task_path_rename, task_path_delete, task_reveal_path,
            task_rename, project_rename,
            pty_spawn, pty_write, pty_resize, pty_kill,
            notify, open_path, reveal_path, home_dir, default_shell, path_exists, path_is_git_repo, log_line, pty_debug_append, terminal_stage_file, install_notification_sound, play_completion_sound,
            settings_load, settings_save, agents_save, agents_defaults, run_capture_command, discover_repos, detect_clis,
            automation::automation_result,
            automation::automation_armed,
            list_monospace_fonts,
            themes_list, themes_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // App-level teardown: when Tauri tears down (last window
            // closed on macOS doesn't fire this, but Cmd-Q does) make
            // sure we don't orphan any child we spawned. That means
            // both the streaming script process groups
            // (RUNNING_SCRIPTS) AND every live PTY (agent terminals,
            // bottom-split shells, etc.). SIGKILL because we're on
            // our way out the door — no time for graceful SIGTERMs.
            if matches!(event, tauri::RunEvent::Exit) {
                cleanup_children(app);
            }
        });
}

/// SIGKILL every child process we spawned (script process groups +
/// PTY children) so quitting the app doesn't leave dev servers or
/// agent processes running. Also reverts any active spotlight sessions
/// so main is left clean.
fn cleanup_children(app: &tauri::AppHandle) {
    use tauri::Manager;
    // 0. Spotlight sessions — revert main for every active session so the
    //    user's repo is left in a clean state after the app exits.
    //    Drop each session (which stops its polling thread) and revert.
    {
        let sessions: Vec<SpotlightState> = {
            let mut g = SPOTLIGHT.lock().unwrap();
            g.as_mut().map(|m| m.drain().map(|(_, v)| v).collect()).unwrap_or_default()
        };
        for state in sessions {
            let projects = load_projects();
            // Find the project that owns this session by matching ws_id.
            let tasks = load_tasks();
            if let Some(w) = tasks.iter().find(|w| w.id == state.ws_id) {
                if let Some(p) = projects.iter().find(|p| p.id == w.project_id) {
                    let main = PathBuf::from(&p.root_path);
                    let _ = spotlight_revert(&main, &state.original_ref, &state.applied_untracked);
                }
            }
        }
    }
    // 1. Script process groups (streaming Run/Setup invocations).
    //    Drain RUNNING_SCRIPTS and SIGKILL each pg leader. Use
    //    SIGKILL (not SIGTERM) because we're not waiting for the
    //    child to acknowledge.
    {
        let mut g = RUNNING_SCRIPTS.lock().unwrap();
        if let Some(map) = g.as_mut() {
            for (_, pid) in map.drain() {
                unsafe { libc::kill(-pid, libc::SIGKILL); }
            }
        }
    }
    // Per-task in-flight greps — same deal, SIGKILL the pg.
    {
        let mut g = RUNNING_GREPS.lock().unwrap();
        if let Some(map) = g.as_mut() {
            for (_, pid) in map.drain() {
                unsafe { libc::kill(-pid, libc::SIGKILL); }
            }
        }
    }
    // 2. PTY children (agent CLIs + scratch shells). PtyManager owns
    //    the registry; iterate every slot and SIGKILL its child pid.
    if let Some(mgr) = app.try_state::<PtyManager>() {
        let mut inner = mgr.inner.lock();
        for (_, slot) in inner.drain() {
            if let Some(pid) = slot.child_pid {
                unsafe { libc::kill(pid as i32, libc::SIGKILL); }
            }
        }
    }
}

/// True on macOS Tahoe (26) and later. Gates the Tahoe-specific window
/// chrome: the enlarged corner radius AND the lowered traffic-light inset
/// (Tahoe stopped vertically centering the window controls in an overlay
/// title bar). Earlier macOS returns false → classic chrome, untouched.
#[cfg(target_os = "macos")]
fn is_macos_tahoe() -> bool {
    // Cached: the OS version can't change while the app runs, and this is now
    // hit on every resize event (corner re-apply) as well as at startup.
    use std::sync::OnceLock;
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        // Detect via the Darwin KERNEL version (kern.osrelease), NOT
        // NSProcessInfo.operatingSystemVersion. The latter is compatibility-
        // CAPPED by the SDK the binary was linked against (the same mechanism
        // that made pre-Big-Sur apps report "10.16" instead of "11.0"). Our
        // release binary is built on the macos-14 CI runner against the macOS
        // 14 SDK, so on a real Tahoe machine NSProcessInfo reports ~14 and
        // every Tahoe-specific tweak (traffic-light inset, corner clip) silently
        // turns off in production while working fine in a locally-built dev
        // binary. kern.osrelease reports the true running kernel regardless of
        // link SDK. macOS 26 (Tahoe) ships the Darwin 25 kernel.
        darwin_major_version().map_or(false, |major| major >= 25)
    })
}

/// True macOS kernel major version from `kern.osrelease`, e.g. 25 on Tahoe.
/// Unlike NSProcessInfo / `kern.osproductversion`, this sysctl is not subject
/// to the SDK-linked product-version compatibility cap, so it stays accurate
/// in a binary built against an older SDK. Returns None if the sysctl fails.
#[cfg(target_os = "macos")]
fn darwin_major_version() -> Option<u32> {
    use std::ffi::CString;
    let name = CString::new("kern.osrelease").ok()?;
    // First call sizes the buffer, second fills it with a NUL-terminated
    // string like "25.5.0".
    let mut len: libc::size_t = 0;
    // SAFETY: standard two-call sysctlbyname; null value pointer just queries
    // the required length into `len`.
    if unsafe {
        libc::sysctlbyname(name.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0)
    } != 0
        || len == 0
    {
        return None;
    }
    let mut buf = vec![0u8; len];
    // SAFETY: `buf` is `len` bytes, matching the size reported above.
    if unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    let s = String::from_utf8_lossy(&buf);
    s.trim_end_matches('\0').split('.').next()?.parse::<u32>().ok()
}

/// Round the window's content layer to match macOS Tahoe's enlarged
/// window corner radius.
///
/// Tahoe (macOS 26) widened the system window corner radius to ~16pt for
/// plain title-bar windows (toolbar windows get 26pt; we have neither an
/// NSToolbar nor a title bar — our top chrome is HTML under an Overlay
/// title bar — so 16pt is the title-bar value). wry's WKWebView runs with
/// `drawsBackground = false` over our opaque window, and the app paints a
/// dark (`#0a0a0a`) background edge-to-edge with SQUARE layer corners.
/// Pre-Tahoe the system radius was small enough that the square corners
/// hid under the frame; Tahoe's larger radius leaves the square corners
/// poking out as black notches past the rounded window frame.
///
/// Fix: clip the content view's layer to a matching continuous ("squircle")
/// radius (TAHOE_CORNER_RADIUS) so the WKWebView sublayer is masked to the
/// same shape as the window frame. Gated to macOS 26+ so older systems keep
/// their classic corners untouched (they already clip cleanly).
///
/// Deliberately does NOT touch the private `_cornerMask` API — overriding
/// it is exactly what tanked Electron's performance on Tahoe (forces
/// WindowServer to recompute the window shadow on every paint).
#[cfg(target_os = "macos")]
fn round_window_corners_for_tahoe(win: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};

    // ~16pt is the nominal Tahoe title-bar radius (toolbar windows get 26,
    // we have no toolbar); 18 tracks the actual frame curve on-device a hair
    // better, so the clip lands flush instead of leaving a sliver.
    const TAHOE_CORNER_RADIUS: f64 = 18.0;

    if !is_macos_tahoe() {
        return;
    }

    let Ok(ns_window) = win.ns_window() else { return };
    let ns_window = ns_window as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }

    // SAFETY: setup and window-event callbacks both run on the main thread
    // (AppKit requirement). The pointer is the live NSWindow owned by tao;
    // and this re-fetches contentView + layer on every call, so a layer
    // AppKit rebuilt after a fullscreen/zoom transition gets re-clipped. We
    // only read its content view and set public CALayer properties (corner
    // radius / curve / masksToBounds), all of which are valid on any
    // thread-confined AppKit object accessed from the main thread.
    unsafe {
        // The content view is clipped to a rounded rect below, so the pixel
        // corners outside that clip are exposed. By default those corners
        // show the NSWindow background (white), producing a white notch in
        // the corner. Setting the window non-opaque with a clear background
        // makes those corner pixels transparent — the standard macOS pattern
        // for custom-shaped windows.
        let clear_color: *mut AnyObject = msg_send![class!(NSColor), clearColor];
        if !clear_color.is_null() {
            let _: () = msg_send![ns_window, setOpaque: Bool::new(false)];
            let _: () = msg_send![ns_window, setBackgroundColor: clear_color];
        }

        let content_view: *mut AnyObject = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }
        let _: () = msg_send![content_view, setWantsLayer: Bool::new(true)];
        let layer: *mut AnyObject = msg_send![content_view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: TAHOE_CORNER_RADIUS];
        let _: () = msg_send![layer, setMasksToBounds: Bool::new(true)];
        // CALayerCornerCurve `kCACornerCurveContinuous` is documented as the
        // NSString @"continuous"; build it directly so we don't have to link
        // the QuartzCore constant. Circular (the default) reads subtly wrong
        // against AppKit's continuous window corners.
        let curve: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: c"continuous".as_ptr()];
        if !curve.is_null() {
            let _: () = msg_send![layer, setCornerCurve: curve];
        }
    }
}

/// Center the window on whichever monitor the OS cursor is currently on.
/// Skips the nudge when the window is already on the cursor's monitor (so we
/// don't fight the window-state plugin's restore on subsequent launches).
fn position_on_cursor_monitor(win: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let cursor = win.cursor_position()?;
    let monitors = win.available_monitors()?;
    let on_monitor = monitors.iter().find(|m| {
        let pos = m.position();
        let size = m.size();
        let in_x = (cursor.x as i32) >= pos.x && (cursor.x as i32) < pos.x + size.width as i32;
        let in_y = (cursor.y as i32) >= pos.y && (cursor.y as i32) < pos.y + size.height as i32;
        in_x && in_y
    });
    let target = match on_monitor { Some(m) => m, None => return Ok(()) };

    // Skip if the window is already on the right monitor — don't override a
    // saved position that the user explicitly chose.
    if let Ok(cur_pos) = win.outer_position() {
        let p = target.position();
        let s = target.size();
        if cur_pos.x >= p.x && cur_pos.x < p.x + s.width as i32
            && cur_pos.y >= p.y && cur_pos.y < p.y + s.height as i32
        {
            return Ok(());
        }
    }

    // Clamp the window to the target monitor before positioning.
    // tauri-plugin-window-state may have restored a size that's
    // larger than the CURRENT monitor (saved on a 4K, now on a
    // laptop screen; saved fullscreen on a different display;
    // etc.). Without this clamp the previous "just center it"
    // code would happily place an oversized window so half of it
    // hangs off the edge - which the user reported as "huge size
    // doesn't even fit." Leave 10% margin (roughly the dock + menu
    // bar + a little breathing room).
    let mut win_size = win.outer_size()?;
    let p = target.position();
    let s = target.size();
    let max_w = ((s.width as f32) * 0.95) as u32;
    let max_h = ((s.height as f32) * 0.90) as u32;
    if win_size.width > max_w || win_size.height > max_h {
        let new_w = win_size.width.min(max_w);
        let new_h = win_size.height.min(max_h);
        let _ = win.set_size(tauri::PhysicalSize::new(new_w, new_h));
        win_size = win.outer_size()?;
    }

    let x = p.x + (s.width as i32 - win_size.width as i32) / 2;
    let y = p.y + (s.height as i32 - win_size.height as i32) / 2;
    win.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn mkrepo(base: &Path, rel: &str) {
        fs::create_dir_all(base.join(rel).join(".git")).unwrap();
    }
    fn discovered_names(dir: &Path) -> std::collections::HashSet<String> {
        discover_repos(dir.to_string_lossy().into_owned())
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect()
    }

    #[test]
    fn discover_repos_flat_layout() {
        let root = tempdir().unwrap();
        mkrepo(root.path(), "repo-a");
        mkrepo(root.path(), "repo-b");
        assert_eq!(discovered_names(root.path()), ["repo-a", "repo-b"].map(String::from).into());
    }

    #[test]
    fn discover_repos_two_level_grouping() {
        let root = tempdir().unwrap();
        mkrepo(root.path(), "work/repo-c");
        mkrepo(root.path(), "oss/repo-d");
        assert_eq!(discovered_names(root.path()), ["repo-c", "repo-d"].map(String::from).into());
    }

    #[test]
    fn discover_repos_mixed_top_repo_and_grouping() {
        let root = tempdir().unwrap();
        mkrepo(root.path(), "top-repo");
        mkrepo(root.path(), "work/nested-repo");
        assert_eq!(discovered_names(root.path()), ["top-repo", "nested-repo"].map(String::from).into());
    }

    #[test]
    fn discover_repos_nested_clone_not_descended() {
        // A repo child is taken as-is; its own subdirs (vendored clones) must
        // NOT be scanned as separate repos.
        let root = tempdir().unwrap();
        mkrepo(root.path(), "repo-a");
        mkrepo(root.path(), "repo-a/vendor/inner");
        assert_eq!(discovered_names(root.path()), ["repo-a"].map(String::from).into());
    }

    #[test]
    #[cfg(unix)]
    fn discover_repos_dedups_symlink_reachable_twice() {
        // A `self -> .` symlink makes the whole root reachable a second time as
        // a grouping folder (the real-world `~/r -> Work/Repos` case). Canonical
        // -path dedup must keep each repo once, not list it twice.
        let root = tempdir().unwrap();
        mkrepo(root.path(), "repo-a");
        mkrepo(root.path(), "repo-b");
        std::os::unix::fs::symlink(root.path(), root.path().join("all")).unwrap();
        let repos = discover_repos(root.path().to_string_lossy().into_owned()).unwrap();
        let names: Vec<_> = repos.iter().map(|r| r.name.clone()).collect();
        assert_eq!(repos.len(), 2, "each repo should appear once, got {names:?}");
    }

    #[test]
    fn discover_repos_skips_hidden_and_node_modules() {
        let root = tempdir().unwrap();
        mkrepo(root.path(), "work/real");
        mkrepo(root.path(), "work/node_modules/pkg");
        mkrepo(root.path(), "work/.cache/hidden");
        // A top-level hidden dir that is itself a repo is skipped too.
        mkrepo(root.path(), ".dotfiles");
        assert_eq!(discovered_names(root.path()), ["real"].map(String::from).into());
    }

    #[test]
    fn safe_task_path_allows_contained_files() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs/a.png"), b"x").unwrap();
        let p = safe_task_path(dir.path(), "docs/a.png").unwrap();
        assert!(p.ends_with("docs/a.png"));
    }

    #[test]
    fn safe_task_path_rejects_absolute_and_parent_segments() {
        let dir = tempdir().unwrap();
        assert!(safe_task_path(dir.path(), "/etc/passwd").is_err());
        assert!(safe_task_path(dir.path(), "../outside.txt").is_err());
        assert!(safe_task_path(dir.path(), "docs/../../outside.txt").is_err());
    }

    #[test]
    fn safe_task_path_rejects_symlink_escape() {
        // A symlink INSIDE the worktree pointing OUTSIDE must fail the
        // canonicalized containment check (the markdown preview reads
        // whatever path a hostile README references).
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"x").unwrap();
        let ws = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.png"), ws.path().join("link.png")).unwrap();
        assert!(safe_task_path(ws.path(), "link.png").is_err());
    }

    #[test]
    fn check_task_path_existence_reports_missing_for_nonexistent_contained_path() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        let stat = check_task_path_existence(dir.path(), "docs/missing.png").unwrap();
        assert!(!stat.exists);
        assert!(!stat.is_dir);
    }

    #[test]
    fn check_task_path_existence_handles_missing_parent_dirs_too() {
        // The whole ancestor chain (not just the leaf) can be missing —
        // the walk-up must reach ws_path itself, not just the immediate parent.
        let dir = tempdir().unwrap();
        let stat = check_task_path_existence(dir.path(), "a/b/c/missing.png").unwrap();
        assert!(!stat.exists);
    }

    #[test]
    fn check_task_path_existence_reports_existing_file_and_dir() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs/a.png"), b"x").unwrap();
        let file_stat = check_task_path_existence(dir.path(), "docs/a.png").unwrap();
        assert!(file_stat.exists);
        assert!(!file_stat.is_dir);
        let dir_stat = check_task_path_existence(dir.path(), "docs").unwrap();
        assert!(dir_stat.exists);
        assert!(dir_stat.is_dir);
    }

    #[test]
    fn check_task_path_existence_rejects_absolute_and_parent_segments() {
        let dir = tempdir().unwrap();
        assert!(check_task_path_existence(dir.path(), "/etc/passwd").is_err());
        assert!(check_task_path_existence(dir.path(), "../outside.txt").is_err());
        assert!(check_task_path_existence(dir.path(), "docs/../../outside.txt").is_err());
    }

    #[test]
    fn check_task_path_existence_rejects_symlink_escape_for_existing_file() {
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.png"), b"x").unwrap();
        let ws = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.png"), ws.path().join("link.png")).unwrap();
        assert!(check_task_path_existence(ws.path(), "link.png").is_err());
    }

    #[test]
    fn check_task_path_existence_rejects_symlink_escape_for_missing_leaf() {
        // A symlinked directory INSIDE the worktree pointing OUTSIDE must
        // still fail containment even though the LEAF file itself doesn't
        // exist — the escaping symlink is the existing ancestor the walk-up
        // finds and canonicalizes.
        let outside = tempdir().unwrap();
        let ws = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), ws.path().join("escape")).unwrap();
        assert!(check_task_path_existence(ws.path(), "escape/missing.png").is_err());
    }

    #[test]
    fn read_capped_file_reads_within_cap() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.bin");
        fs::write(&p, b"hello").unwrap();
        assert_eq!(read_capped_file(&p, 10).unwrap(), b"hello");
    }

    #[test]
    fn read_capped_file_rejects_over_cap() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.bin");
        fs::write(&p, vec![0u8; 100]).unwrap();
        assert!(read_capped_file(&p, 10).is_err());
    }

    #[test]
    fn read_capped_file_rejects_directory() {
        let dir = tempdir().unwrap();
        assert!(read_capped_file(dir.path(), 10).is_err());
    }

    #[test]
    fn preview_mime_for_ext_known_extensions() {
        assert_eq!(preview_mime_for_ext(Path::new("a/b.png")), Some("image/png"));
        assert_eq!(preview_mime_for_ext(Path::new("shot.JPG")), Some("image/jpeg"));
        assert_eq!(preview_mime_for_ext(Path::new("d.svg")), Some("image/svg+xml"));
        assert_eq!(preview_mime_for_ext(Path::new("p.avif")), Some("image/avif"));
        assert_eq!(preview_mime_for_ext(Path::new("doc.PDF")), Some("application/pdf"));
    }

    #[test]
    fn preview_mime_for_ext_rejects_non_previewable() {
        // The base64 read must not become a generic binary-file channel.
        assert_eq!(preview_mime_for_ext(Path::new("id_rsa")), None);
        assert_eq!(preview_mime_for_ext(Path::new("script.sh")), None);
        assert_eq!(preview_mime_for_ext(Path::new("noext")), None);
    }

    #[test]
    fn task_file_read_base64_for_task_roundtrips_root_file() {
        use base64::Engine as _;
        let dir = tempdir().unwrap();
        let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\nnot-a-real-png-but-that's-fine-here";
        fs::write(dir.path().join("shot.png"), png_bytes).unwrap();
        let task = Task { path: dir.path().to_string_lossy().into_owned(), ..Default::default() };

        let read = task_file_read_base64_for_task(&task, "shot.png", None).unwrap();
        assert!(!read.unchanged);
        assert_eq!(read.mime.as_deref(), Some("image/png"));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(read.data.unwrap()).unwrap(), png_bytes);
    }

    #[test]
    fn task_file_read_base64_for_task_resolves_member_path() {
        use base64::Engine as _;
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        let pdf_bytes: &[u8] = b"%PDF-1.4\nnot-a-real-pdf-but-that's-fine-here";
        fs::write(member.path().join("report.pdf"), pdf_bytes).unwrap();

        let task = Task {
            path: host.path().to_string_lossy().into_owned(),
            composition: vec![TaskMember {
                dir_name: "docs".into(),
                mode: MemberMode::RepoRoot,
                path: member.path().to_string_lossy().into_owned(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let read = task_file_read_base64_for_task(&task, "docs/report.pdf", None).unwrap();
        assert_eq!(read.mime.as_deref(), Some("application/pdf"));
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(read.data.unwrap()).unwrap(), pdf_bytes);
    }

    #[test]
    fn task_file_read_base64_for_task_short_circuits_on_matching_known_fp() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("shot.png"), b"hello").unwrap();
        let task = Task { path: dir.path().to_string_lossy().into_owned(), ..Default::default() };

        let first = task_file_read_base64_for_task(&task, "shot.png", None).unwrap();
        let second = task_file_read_base64_for_task(&task, "shot.png", Some(&first.fp)).unwrap();
        assert!(second.unchanged);
        assert!(second.mime.is_none());
        assert!(second.data.is_none());
    }

    #[test]
    fn task_file_read_base64_for_task_rejects_non_previewable_extension() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("notes.txt"), "hello").unwrap();
        let task = Task { path: dir.path().to_string_lossy().into_owned(), ..Default::default() };

        assert!(task_file_read_base64_for_task(&task, "notes.txt", None).is_err());
    }

    #[test]
    fn read_preview_file_for_task_roundtrips_pdf_bytes_and_mime() {
        let dir = tempdir().unwrap();
        let pdf_bytes: &[u8] = b"%PDF-1.4\nnot-a-real-pdf-but-that's-fine-here";
        fs::write(dir.path().join("report.pdf"), pdf_bytes).unwrap();
        let task = Task { path: dir.path().to_string_lossy().into_owned(), ..Default::default() };

        let (bytes, mime) = read_preview_file_for_task(&task, "report.pdf").unwrap();
        assert_eq!(bytes, pdf_bytes);
        assert_eq!(mime, "application/pdf");
    }

    #[test]
    fn read_preview_file_for_task_rejects_non_previewable_extension() {
        // The taskpdf: scheme must not become a generic binary-file channel.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("id_rsa"), "secret").unwrap();
        let task = Task { path: dir.path().to_string_lossy().into_owned(), ..Default::default() };

        assert!(read_preview_file_for_task(&task, "id_rsa").is_err());
    }

    #[test]
    fn taskpdf_response_400s_on_malformed_path() {
        // No "/<id>/<path>" split available -> Bad Request, not a panic.
        assert_eq!(taskpdf_response("/only-one-segment").status(), 400);
        assert_eq!(taskpdf_response("/").status(), 400);
    }

    #[test]
    fn taskpdf_response_404s_on_unknown_task() {
        // Unresolvable id (no such task) -> 404, never an open file read.
        assert_eq!(taskpdf_response("/no-such-task-id/report.pdf").status(), 404);
    }

    #[test]
    fn open_command_macos_uses_open() {
        assert_eq!(open_command("macos", "https://x.com"),
            ("open", vec!["https://x.com".to_string()]));
    }

    #[test]
    fn open_command_linux_uses_xdg_open() {
        // The #14 regression: Linux must not fall back to macOS `open`.
        assert_eq!(open_command("linux", "https://x.com"),
            ("xdg-open", vec!["https://x.com".to_string()]));
    }

    #[test]
    fn open_command_unknown_os_falls_back_to_xdg_open() {
        let (prog, _) = open_command("freebsd", "https://x.com");
        assert_eq!(prog, "xdg-open");
    }

    #[test]
    fn remove_dir_if_empty_removes_empty_and_hidden_only() {
        let root = tempdir().unwrap();

        // Truly empty → removed.
        let empty = root.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert!(remove_dir_if_empty_ignoring_hidden(&empty));
        assert!(!empty.exists());

        // Only a hidden file (.DS_Store) → hidden file deleted, dir removed.
        let hidden = root.path().join("hidden");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join(".DS_Store"), b"x").unwrap();
        assert!(remove_dir_if_empty_ignoring_hidden(&hidden));
        assert!(!hidden.exists());
    }

    #[test]
    fn remove_dir_if_empty_keeps_dirs_with_real_content() {
        let root = tempdir().unwrap();

        // A visible file → never removed (non-recursive, content preserved).
        let with_file = root.path().join("withfile");
        fs::create_dir(&with_file).unwrap();
        fs::write(with_file.join("keep.txt"), b"data").unwrap();
        assert!(!remove_dir_if_empty_ignoring_hidden(&with_file));
        assert!(with_file.join("keep.txt").exists());

        // A hidden *directory* (e.g. .git) → aborts, never recursed into.
        let with_hidden_dir = root.path().join("withhiddendir");
        fs::create_dir(&with_hidden_dir).unwrap();
        fs::create_dir(with_hidden_dir.join(".git")).unwrap();
        assert!(!remove_dir_if_empty_ignoring_hidden(&with_hidden_dir));
        assert!(with_hidden_dir.join(".git").exists());
    }

    #[test]
    fn open_command_windows_uses_explorer_no_shell() {
        // Must NOT route through `cmd /C start` — the target is passed as a
        // single argv to explorer so cmd metachars (& ^ %) can't be reparsed.
        let (prog, args) = open_command("windows", "https://x.com/?a=1&b=2");
        assert_eq!(prog, "explorer");
        assert_eq!(args, vec!["https://x.com/?a=1&b=2".to_string()]);
        assert_ne!(prog, "cmd", "no shell in the open path");
    }

    #[test]
    fn gitignore_inserts_managed_block_when_absent() {
        let dir = tempdir().unwrap();
        ensure_multirepo_gitignore(dir.path(), &["backend".into(), "frontend".into()]).unwrap();
        let s = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(s.contains("# ── termic: multi-repo member dirs (managed) ──"));
        assert!(s.contains("/backend"));
        assert!(s.contains("/frontend"));
        assert!(s.contains("# ── /termic ──"));
    }

    #[test]
    fn gitignore_preserves_user_content_outside_block() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "node_modules\n*.log\n").unwrap();
        ensure_multirepo_gitignore(dir.path(), &["backend".into()]).unwrap();
        let s = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(s.contains("node_modules"));
        assert!(s.contains("*.log"));
        assert!(s.contains("/backend"));
    }

    #[test]
    fn gitignore_rewrites_block_on_member_change() {
        let dir = tempdir().unwrap();
        ensure_multirepo_gitignore(dir.path(), &["a".into(), "b".into()]).unwrap();
        ensure_multirepo_gitignore(dir.path(), &["a".into(), "c".into()]).unwrap();
        let s = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(s.contains("/a"));
        assert!(!s.contains("/b"));   // old member removed
        assert!(s.contains("/c"));    // new member added
        // Only one managed block (no double-fenced output).
        assert_eq!(s.matches("# ── termic: multi-repo member dirs (managed) ──").count(), 1);
    }

    #[test]
    fn gitignore_preserves_user_content_across_rewrites() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "secrets.env\n").unwrap();
        ensure_multirepo_gitignore(dir.path(), &["x".into()]).unwrap();
        ensure_multirepo_gitignore(dir.path(), &["y".into()]).unwrap();
        let s = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(s.contains("secrets.env"));
        assert!(s.contains("/y"));
        assert!(!s.contains("/x"));
    }

    #[test]
    fn resolve_task_git_path_uses_host_repo_for_host_paths() {
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        let task = Task {
            path: host.path().to_string_lossy().into_owned(),
            composition: vec![TaskMember {
                dir_name: "frontend".into(),
                mode: MemberMode::Worktree,
                path: member.path().to_string_lossy().into_owned(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let (cwd, rel) = resolve_task_git_path(&task, "src/main.rs").unwrap();
        assert_eq!(cwd, host.path());
        assert_eq!(rel, "src/main.rs");
    }

    #[test]
    fn resolve_task_git_path_strips_member_prefix_for_member_paths() {
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        let task = Task {
            path: host.path().to_string_lossy().into_owned(),
            composition: vec![TaskMember {
                dir_name: "frontend".into(),
                mode: MemberMode::RepoRoot,
                path: member.path().to_string_lossy().into_owned(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let (cwd, rel) = resolve_task_git_path(&task, "frontend/src/App.tsx").unwrap();
        assert_eq!(cwd, member.path());
        assert_eq!(rel, "src/App.tsx");
    }

    fn task_with_member(dir_name: &str, host: &Path, member: &Path) -> Task {
        Task {
            path: host.to_string_lossy().into_owned(),
            composition: vec![TaskMember {
                dir_name: dir_name.into(),
                mode: MemberMode::RepoRoot,
                path: member.to_string_lossy().into_owned(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn resolve_task_git_path_rejects_bare_member_root_by_default() {
        // A diff/read needs a FILE inside the member, not the member's own
        // root directory — the default (used by diff/read/write commands)
        // keeps rejecting this.
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        let ws = task_with_member("frontend", host.path(), member.path());
        assert!(resolve_task_git_path(&ws, "frontend").is_err());
    }

    #[test]
    fn resolve_task_git_path_ex_allows_bare_member_root_when_opted_in() {
        // A markdown link's `..`/`/` can legitimately resolve to exactly a
        // member's own root (resolveTaskHref's member-floor scoping) —
        // task_path_stat/task_reveal_path need to answer for it
        // (is this a directory?) rather than erroring.
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        let ws = task_with_member("frontend", host.path(), member.path());
        let (cwd, rel) = resolve_task_git_path_ex(&ws, "frontend", true).unwrap();
        assert_eq!(cwd, member.path());
        assert_eq!(rel, "");
    }

    #[test]
    fn task_path_stat_reports_a_bare_member_root_as_an_existing_directory() {
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        let ws = task_with_member("frontend", host.path(), member.path());
        let (cwd, rel) = resolve_task_git_path_ex(&ws, "frontend", true).unwrap();
        let stat = check_task_path_existence(&cwd, &rel).unwrap();
        assert!(stat.exists);
        assert!(stat.is_dir);
    }

    #[test]
    fn member_repo_diff_helpers_use_member_cwd_not_host_repo() {
        let host = tempdir().unwrap();
        let member = tempdir().unwrap();
        git_init_with_commit(host.path());
        git_init_with_commit(member.path());

        fs::write(member.path().join("base.txt"), "member changed\n").unwrap();

        let task = Task {
            path: host.path().to_string_lossy().into_owned(),
            composition: vec![TaskMember {
                dir_name: "frontend".into(),
                mode: MemberMode::RepoRoot,
                path: member.path().to_string_lossy().into_owned(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let sides = task_file_diff_sides_for_task(&task, "frontend/base.txt").unwrap();
        assert!(sides.original.contains("base content"));
        assert!(sides.modified.contains("member changed"));

        let diff = task_file_diff_for_task(&task, "frontend/base.txt").unwrap();
        assert!(diff.contains("member changed"));
        assert!(diff.contains("diff --git a/base.txt b/base.txt"));
    }

    // ──────────────── spotlight git mechanics ────────────────

    /// Initialize a bare git repo at `path` with one commit so HEAD and
    /// base branch exist. Returns the committed file path.
    fn git_init_with_commit(path: &Path) -> PathBuf {
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(path).output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        run(&["init", "-b", "main"]);
        run(&["-c", "user.name=Test", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"]);
        let f = path.join("base.txt");
        fs::write(&f, "base content\n").unwrap();
        run(&["add", "."]);
        run(&["-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-m", "base"]);
        f
    }

    /// Add a real git worktree of `repo` at `wt` on a new branch `branch`.
    /// Worktrees share the object DB — exactly what spotlight's detached
    /// checkout relies on. Returns nothing; `wt` is checked out on `branch`.
    fn git_worktree_add(repo: &Path, wt: &Path, branch: &str) {
        let out = std::process::Command::new("git")
            .args(["worktree", "add", &wt.to_string_lossy(), "-b", branch])
            .current_dir(repo)
            .output().unwrap();
        assert!(out.status.success(), "worktree add failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn git_head(repo: &Path) -> String {
        String::from_utf8_lossy(
            &std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(repo)
                .output().unwrap().stdout,
        ).trim().to_string()
    }

    /// Resolve a ref (e.g. a branch name) to a SHA in `repo`.
    fn git_rev(repo: &Path, refname: &str) -> String {
        String::from_utf8_lossy(
            &std::process::Command::new("git")
                .args(["rev-parse", refname])
                .current_dir(repo)
                .output().unwrap().stdout,
        ).trim().to_string()
    }

    /// Current branch name, or empty when in detached HEAD.
    fn git_branch(repo: &Path) -> String {
        String::from_utf8_lossy(
            &std::process::Command::new("git")
                .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
                .current_dir(repo)
                .output().unwrap().stdout,
        ).trim().to_string()
    }

    fn git_is_clean(repo: &Path) -> bool {
        let out = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(repo)
            .output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().is_empty()
    }

    #[test]
    fn spotlight_apply_checks_out_worktree_commit_without_moving_branch() {
        let main_dir  = tempdir().unwrap();
        let wt_parent = tempdir().unwrap();
        let main      = main_dir.path();
        let wt        = wt_parent.path().join("wt");

        git_init_with_commit(main);
        let main_ref_before = git_rev(main, "main");
        git_worktree_add(main, &wt, "feature");

        // Commit a change on the worktree branch.
        fs::write(wt.join("feature.txt"), "new feature\n").unwrap();
        let run_wt = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(&wt).output().unwrap();
            assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        run_wt(&["add", "."]);
        run_wt(&["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "feature"]);
        let wt_head = git_head(&wt);

        let r = spotlight_apply(&wt, main, "main", "test-task").unwrap();
        assert!(!r.committed_files.is_empty(), "should have detected committed diff");
        assert!(r.applied_untracked.is_empty(), "no untracked files");

        // Repo root HEAD is now the worktree's commit (detached) ...
        assert_eq!(git_head(main), wt_head, "repo root checked out the worktree commit");
        assert_eq!(git_branch(main), "", "repo root is in detached HEAD");
        // ... but the `main` BRANCH ref never moved — the key safety property.
        assert_eq!(git_rev(main, "main"), main_ref_before, "main branch ref must not move");
        assert!(main.join("feature.txt").exists(), "feature file present at repo root");
    }

    #[test]
    fn spotlight_apply_uncommitted_lands_as_working_tree_changes() {
        let main_dir  = tempdir().unwrap();
        let wt_parent = tempdir().unwrap();
        let main      = main_dir.path();
        let wt        = wt_parent.path().join("wt");

        git_init_with_commit(main);
        let main_ref_before = git_rev(main, "main");
        git_worktree_add(main, &wt, "feature");

        // Unstaged change in worktree (no commit).
        fs::write(wt.join("base.txt"), "modified content\n").unwrap();

        let r = spotlight_apply(&wt, main, "main", "test-task").unwrap();
        assert!(r.committed_files.is_empty(), "no committed diff");
        assert!(!r.uncommitted_files.is_empty(), "should have uncommitted files");
        assert!(r.applied_untracked.is_empty());

        // main branch ref unchanged; working tree carries the change.
        assert_eq!(git_rev(main, "main"), main_ref_before, "main branch ref must not move");
        assert!(!git_is_clean(main), "repo root working tree should be dirty");
    }

    #[test]
    fn spotlight_apply_untracked_files_are_copied() {
        let main_dir  = tempdir().unwrap();
        let wt_parent = tempdir().unwrap();
        let main      = main_dir.path();
        let wt        = wt_parent.path().join("wt");

        git_init_with_commit(main);
        git_worktree_add(main, &wt, "feature");

        // Untracked file in worktree (not in .gitignore).
        fs::write(wt.join("env.local"), "SECRET=test\n").unwrap();

        let r = spotlight_apply(&wt, main, "main", "test-task").unwrap();
        assert_eq!(r.applied_untracked, vec!["env.local"]);
        assert!(main.join("env.local").exists(), "untracked file copied to repo root");
    }

    #[test]
    fn spotlight_revert_reattaches_branch_and_cleans() {
        let main_dir  = tempdir().unwrap();
        let wt_parent = tempdir().unwrap();
        let main      = main_dir.path();
        let wt        = wt_parent.path().join("wt");

        git_init_with_commit(main);
        let main_ref_before = git_rev(main, "main");
        git_worktree_add(main, &wt, "feature");

        // Committed change + untracked file in the worktree.
        fs::write(wt.join("tmp.txt"), "temp\n").unwrap();
        let run_wt = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&wt).output().unwrap();
        };
        run_wt(&["add", "."]);
        run_wt(&["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "tmp"]);
        fs::write(wt.join("untracked.txt"), "data\n").unwrap();

        let r = spotlight_apply(&wt, main, "main", "test-task").unwrap();
        assert!(main.join("tmp.txt").exists());
        assert!(main.join("untracked.txt").exists());
        assert_eq!(git_branch(main), "", "detached while spotlighted");

        // Revert back to the original branch ref ("main").
        spotlight_revert(main, "main", &r.applied_untracked).unwrap();

        assert_eq!(git_branch(main), "main", "branch re-attached after revert");
        assert_eq!(git_rev(main, "main"), main_ref_before, "main ref still at original");
        assert!(git_is_clean(main), "repo root clean after revert");
        assert!(!main.join("tmp.txt").exists(), "committed file gone");
        assert!(!main.join("untracked.txt").exists(), "untracked file removed");
    }

    #[test]
    fn spotlight_resync_reflects_new_commits() {
        let main_dir  = tempdir().unwrap();
        let wt_parent = tempdir().unwrap();
        let main      = main_dir.path();
        let wt        = wt_parent.path().join("wt");

        git_init_with_commit(main);
        let main_ref_before = git_rev(main, "main");
        git_worktree_add(main, &wt, "feature");

        let run_wt = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&wt).output().unwrap();
        };

        // First apply: one committed file.
        fs::write(wt.join("v1.txt"), "version 1\n").unwrap();
        run_wt(&["add", "."]);
        run_wt(&["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "v1"]);
        let r1 = spotlight_apply(&wt, main, "main", "task").unwrap();
        assert!(main.join("v1.txt").exists());

        // Worktree gets a second commit. Re-sync = revert then re-apply.
        fs::write(wt.join("v2.txt"), "version 2\n").unwrap();
        run_wt(&["add", "."]);
        run_wt(&["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "v2"]);

        spotlight_revert(main, "main", &r1.applied_untracked).unwrap();
        assert!(!main.join("v1.txt").exists(), "v1 removed on revert");

        let r2 = spotlight_apply(&wt, main, "main", "task").unwrap();
        assert!(main.join("v1.txt").exists(), "v1 re-applied");
        assert!(main.join("v2.txt").exists(), "v2 applied");
        assert!(r2.applied_untracked.is_empty(), "no untracked");
        // The branch ref STILL hasn't moved through all of this.
        assert_eq!(git_rev(main, "main"), main_ref_before, "main ref never moved");
        assert_eq!(git_head(main), git_head(&wt), "repo root HEAD == worktree HEAD");
    }
}
