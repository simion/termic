// Termic — parallel-agent orchestrator with embedded terminals.
//
// Model:
//   Project   — a git repo on disk. User adds repos by picking their root dir.
//   Workspace — a git worktree branched from `base_branch`. Each workspace
//               has its own folder + an embedded terminal running the chosen
//               agent CLI (claude / gemini / codex).
//
// Terminal: PTYs are managed in `PtyManager`. The frontend (xterm.js) and
// backend communicate via Tauri events:
//   FE → BE: pty_spawn(workspace_id, cli, cwd) -> pty_id
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
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

mod sandbox;
mod proxy;
mod repo_config;
mod shell_env;
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
    /// workspace wrapper when a multi-repo workspace is created.
    pub root_path: String,
    pub workspaces_path: String,
    pub base_branch: String,
    pub remote: String,
    pub preview_url: String,
    pub files_to_copy: Vec<String>,
    pub setup_script: String,
    pub run_script: String,
    pub archive_script: String,
    pub default_cli: String,
    pub created: String,

    // ── Sandbox config (configured per project, enabled per workspace) ──
    /// Whether new workspaces in this project default to sandboxed. The
    /// "New workspace" dialog pre-checks its sandbox toggle when true.
    /// The per-workspace pin is captured at create time; flipping this
    /// later only affects FUTURE workspaces.
    #[serde(default)]
    pub default_sandbox: bool,
    /// Extra writable subpaths beyond the bake-in defaults (workspace
    /// path, agent config dirs, /private/tmp). Absolute paths; `$HOME`
    /// and `$WORKSPACE` are substituted at render time. List, not a
    /// single string — keeps the SBPL output one rule per line.
    #[serde(default)]
    pub sandbox_rw_paths: Vec<String>,
    /// Extra allowed-host regexes for the per-workspace network proxy,
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
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProjectMember {
    pub project_id: String,
    pub setup_script: String,
    pub run_script: String,
    pub archive_script: String,
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

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Workspace {
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
    /// True when this workspace points at the project's main repo checkout
    /// (no git worktree created). Used by the "open repo directly" feature:
    /// archive skips `git worktree remove`, and the UI shows a distinct icon.
    #[serde(default)]
    pub is_repo_root: bool,
    /// Total number of times an agent has been spawned for this workspace
    /// across all sessions (persisted via `workspace_record_spawn`).
    /// Historical signal — kept for analytics / debug. Resume gating
    /// uses `has_resumable_history` below, not this.
    #[serde(default)]
    pub spawn_count: u32,
    /// True iff at least one agent spawn for this worktree has survived
    /// past the "settle" threshold (~2s) — i.e. there's plausibly a
    /// resumable session on disk. Persisted, drives the resume-flag
    /// gating on subsequent spawns.
    ///
    /// Flipped TRUE by `workspace_set_has_history(id, true)` once a spawn
    /// has been running long enough that it's almost certainly past
    /// any "no conversation found to continue" rapid-exit failure.
    /// Flipped FALSE when a resume-attempt spawn exits within the
    /// failure threshold (we now KNOW there's no usable history) so
    /// the next spawn doesn't waste a roundtrip retrying.
    #[serde(default)]
    pub has_resumable_history: bool,
    /// PINNED at workspace creation. The sandbox decision can't change
    /// afterwards — otherwise an agent could talk the user into
    /// loosening its own cage. To run the same project unsandboxed,
    /// archive and recreate with the toggle off (or vice versa).
    #[serde(default)]
    pub sandbox_enabled: bool,
    /// Frozen-at-creation copies of the sandbox lists. Seeded from the
    /// project's defaults in `workspace_create`, but the workspace owns
    /// them from then on - editing the project later doesn't reach back
    /// into existing workspaces. Spawning reads THESE, never the
    /// project's arrays.
    #[serde(default)]
    pub sandbox_rw_paths: Vec<String>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Vec<String>,
    /// Multi-repo composition. Empty for single-repo workspaces (the
    /// usual case — `path` already points at the worktree of the one
    /// project this workspace belongs to). For workspaces created
    /// under a `ProjectType::Multi` project this lists the host repo
    /// + every member with its resolved on-disk path. The PTY spawn
    /// + sandbox profile generator iterate this list when populated.
    #[serde(default)]
    pub composition: Vec<WorkspaceMember>,
}

/// One entry in a multi-repo workspace's composition. The host repo
/// itself is the first member (its `path` is the workspace wrapper
/// dir, which IS a git worktree of the host); subsequent entries are
/// the user-picked member repos worktree'd or symlinked inside it.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WorkspaceMember {
    /// References Project.id. Resolves to the Project record for
    /// sandbox-list union + display.
    pub project_id: String,
    /// Display name shown in the file tree / sidebar. Defaults to
    /// the project's name; member dirs are created under this name
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
    /// running `PORT=$TERMIC_PORT npm run dev` in the same workspace
    /// don't collide on the same listening port. Zero = legacy
    /// workspace created before per-member ports existed; the
    /// runner falls back to the workspace's own port in that case.
    #[serde(default)]
    pub port: u16,
    /// Per-member script overrides. Frozen at creation from the
    /// member project's own defaults; user can tweak in the New
    /// workspace dialog. Run with `cwd = member.path`. Empty = the
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
pub struct CreateWorkspaceArgs {
    pub project_id: String,
    pub name: String,
    pub cli: Option<String>,
    pub base_branch: Option<String>,
    /// Explicit branch name. If omitted, defaults to `slugify(name)`.
    pub branch: Option<String>,
    /// Optional client-supplied workspace ID. Lets the frontend subscribe
    /// to `setup-output://<id>` + `setup-done://<id>` BEFORE invoking
    /// create — without this, the empty-script branch race-emits done
    /// before the listener attaches and the dialog hangs forever.
    /// Defaults to a server-side UUID for backwards-compat.
    #[serde(default)]
    pub id: Option<String>,
    /// Sandbox the agent for this workspace. PINNED at creation —
    /// `sandbox_enabled` is copied straight onto the saved Workspace
    /// and never gets a setter. If unset, the per-project default
    /// (`Project.default_sandbox`) wins.
    #[serde(default)]
    pub sandbox_enabled: Option<bool>,
    /// Optional overrides for the per-workspace sandbox lists. The
    /// dialog seeds them from the project's defaults, lets the user
    /// add/remove, then sends the final shape here. Unset → fall
    /// back to the project's default arrays.
    #[serde(default)]
    pub sandbox_rw_paths: Option<Vec<String>>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Option<Vec<String>>,
}

// ───────────────────────────── paths ─────────────────────────────

/// Top-level directory name for all of termic's on-disk data —
/// `<data_local_dir>/<APP_DIR>/` (projects, settings, workspace
/// metadata) and `~/<APP_DIR>/` (worktrees, auto-created host repos).
/// Debug builds (`tauri dev`) use a separate `termic_dev` tree so
/// day-to-day development can't read or clobber the release app's
/// data; release builds (`tauri build`) use `termic`. Note the
/// frontend's localStorage prefs are already dev/prod-separate on
/// their own (different webview origin: localhost vs asset protocol).
const APP_DIR: &str = if cfg!(debug_assertions) { "termic_dev" } else { "termic" };

fn data_dir() -> Result<PathBuf> {
    let p = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("no data dir"))?
        .join(APP_DIR);
    fs::create_dir_all(&p)?;
    Ok(p)
}

fn projects_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("projects.json"))
}
fn workspaces_dir() -> Result<PathBuf> {
    let p = data_dir()?.join("workspaces");
    fs::create_dir_all(&p)?;
    Ok(p)
}
fn worktrees_base() -> Result<PathBuf> {
    let p = dirs::home_dir().ok_or_else(|| anyhow!("no home"))?.join(APP_DIR).join("workspaces");
    fs::create_dir_all(&p)?;
    Ok(p)
}

// ───────────────────────────── projects IO ─────────────────────────────

fn load_projects() -> Vec<Project> {
    let f = match projects_file() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match fs::read_to_string(&f) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}
fn save_projects(list: &[Project]) -> Result<()> {
    fs::write(projects_file()?, serde_json::to_string_pretty(list)?)?;
    Ok(())
}

fn load_workspaces() -> Vec<Workspace> {
    let dir = match workspaces_dir() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            if let Ok(s) = fs::read_to_string(entry.path()) {
                if let Ok(w) = serde_json::from_str::<Workspace>(&s) {
                    out.push(w);
                }
            }
        }
    }
    out.sort_by(|a, b| a.created.cmp(&b.created));
    out
}
fn save_workspace(w: &Workspace) -> Result<()> {
    let f = workspaces_dir()?.join(format!("{}.json", w.id));
    fs::write(&f, serde_json::to_string_pretty(w)?)?;
    Ok(())
}
fn delete_workspace_file(id: &str) -> Result<()> {
    let f = workspaces_dir()?.join(format!("{id}.json"));
    let _ = fs::remove_file(f);
    Ok(())
}

// ───────────────────────────── git ─────────────────────────────

fn git(args: &[&str], cwd: &Path) -> Result<String> {
    let out = Command::new("git").args(args).current_dir(cwd).output()
        .with_context(|| format!("git {:?}", args))?;
    if !out.status.success() {
        return Err(anyhow!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
    /// Sandbox bundle for this PTY, if the workspace was sandbox-enabled.
    /// Dropping the bundle shuts down the in-process proxy thread; we
    /// let TMPDIR expire for the profile / filter files (they're tiny
    /// and useful for post-mortem). `None` for unsandboxed PTYs.
    /// Held purely so its Drop fires when the slot is dropped - never
    /// read directly, hence the allow.
    #[allow(dead_code)]
    sandbox: Option<SandboxBundle>,
    /// Workspace this PTY belongs to, copied from `SpawnArgs.workspace_id`.
    /// Lets `workspace_set_sandbox` SIGKILL all PTYs of a workspace whose
    /// sandbox config was just edited so the next mount picks up the new
    /// profile. `None` for non-workspace PTYs (none today; future-proof).
    workspace_id: Option<String>,
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
/// the workspace WANTED to be sandboxed but whether the cage actually
/// closed. Returned synchronously as part of `pty_spawn`'s value so
/// the frontend can't miss it (the earlier event-based variant had a
/// race window between the emit and the frontend's listener attach).
#[derive(Clone, Serialize)]
pub struct SandboxStatus {
    /// True iff the spawn went through sandbox-exec. False for an
    /// unsandboxed workspace AND for the degraded case where
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
    /// the workspace's sandbox (seatbelt + per-workspace network proxy).
    /// We look up the workspace, refuse to sandbox if its
    /// `sandbox_enabled` is false, and proceed unsandboxed if the
    /// workspace can't be found (e.g. transient race). The PTY id
    /// returned is the same shape either way.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// The agent ID being spawned in *this* tab. May differ from
    /// `workspace.cli` because a workspace can host multiple tabs
    /// running different agents (e.g. a claude workspace with a gemini
    /// tab open). Drives which agent's `sandbox_allowed_paths` +
    /// per-CLI host allowlist get baked into the freshly-provisioned
    /// SBPL profile. Falls back to `workspace.cli` when absent.
    #[serde(default)]
    pub agent_id: Option<String>,
}
fn default_rows() -> u16 { 40 }
fn default_cols() -> u16 { 120 }

/// `.termic.yaml` always lives at — and is read from — the project's
/// `root_path` (the user's main checkout), never a per-workspace
/// worktree. That keeps one source of truth: a Repository-settings
/// edit, a footer "Allow", and the spawn-time read all hit the same
/// file. It is also OUTSIDE the per-workspace sandbox, so a caged
/// agent cannot edit the config the sandbox reads.
fn repo_config_for(proj: &Project) -> repo_config::RepoConfig {
    repo_config::load_or_default(Path::new(&proj.root_path))
}

/// Compute the live sandbox allow-lists for a workspace at spawn time.
/// Unions four layers:
///   1. global Settings defaults,
///   2. the workspace's own pinned arrays (Sandbox dialog),
///   3. each contributing project's personal "allow for me" overrides
///      from `projects.json`,
///   4. each contributing project's committed `.termic.yaml` sandbox
///      block — re-read fresh on every spawn.
fn live_sandbox_lists(ws: &Workspace) -> (Vec<String>, Vec<String>) {
    let globals = load_settings_inner();
    let projects = load_projects();
    let mut rw = globals.sandbox_default_rw_paths.clone();
    let mut hosts = globals.sandbox_default_allowed_hosts.clone();
    // The workspace's own pinned arrays — the Sandbox dialog's
    // per-workspace personal layer.
    rw.extend(ws.sandbox_rw_paths.iter().cloned());
    hosts.extend(ws.sandbox_allowed_hosts.iter().cloned());

    // Projects contributing to this workspace: the lone one for a
    // single-project workspace, or every member of a multi-repo one.
    let pids: Vec<String> = if ws.composition.is_empty() {
        vec![ws.project_id.clone()]
    } else {
        ws.composition.iter().map(|m| m.project_id.clone()).collect()
    };
    for pid in pids {
        if let Some(p) = projects.iter().find(|p| p.id == pid) {
            let cfg = repo_config_for(p);
            rw.extend(cfg.sandbox.allowed_paths);
            hosts.extend(cfg.sandbox.allowed_hosts);
            rw.extend(p.sandbox_rw_paths.iter().cloned());
            hosts.extend(p.sandbox_allowed_hosts.iter().cloned());
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
    // If the workspace is flagged sandbox_enabled, provision a fresh
    // seatbelt profile + network proxy and rewrite (cmd, args) to go through
    // `sandbox-exec`. The bundle gets parked on the PtySlot so its
    // Drop impl SIGKILLs the proxy when the PTY closes.
    let (effective_cmd, effective_args, sandbox_bundle) = match args
        .workspace_id
        .as_deref()
        .and_then(|wid| load_workspaces().into_iter().find(|w| w.id == wid))
        .filter(|w| w.sandbox_enabled)
        // Re-render the allow-lists each spawn so committed
        // `.termic.yaml` edits are picked up live, unioned with the
        // personal (workspace/project/global) layers. See
        // `live_sandbox_lists` / repo_config.rs.
        .map(|mut ws| {
            let (rw, hosts) = live_sandbox_lists(&ws);
            ws.sandbox_rw_paths = rw;
            ws.sandbox_allowed_hosts = hosts;
            ws
        })
    {
        Some(ws) => match sandbox::provision(&ws, args.agent_id.as_deref()) {
            Ok(bundle) => {
                let port = bundle.proxy.as_ref().map(|p| p.port).unwrap_or(0);
                let effective_cli = args.agent_id.as_deref().unwrap_or(&ws.cli);
                dlog(&format!(
                    "[pty_spawn] sandbox=ON ws={} cli={} proxy_port={} profile={}",
                    ws.id, effective_cli, port, bundle.profile_path.display(),
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
    for (k, v) in &args.env {
        cmd.env(k, v);
    }
    // Multi-repo: expose sibling ports so the agent (or anything the
    // user runs in this PTY) can `curl localhost:$TERMIC_PORT_API`
    // without hardcoding. Same scheme as the script-stream spawn.
    if let Some(wid) = args.workspace_id.as_deref() {
        if let Some(ws) = load_workspaces().into_iter().find(|w| w.id == wid) {
            for (i, m) in ws.composition.iter().enumerate() {
                let p = if m.port == 0 { ws.port.saturating_add(i as u16 + 1) } else { m.port };
                let sanitized: String = m.dir_name.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                    .collect();
                cmd.env(format!("TERMIC_PORT_{sanitized}"), p.to_string());
            }
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

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
    // against this workspace.
    if let (Some(pid), Some(wid)) = (child_pid, args.workspace_id.as_deref()) {
        sandbox::register_root_pid(wid, pid);
    }

    let id = Uuid::new_v4().to_string();
    let master = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    // Reader thread → emits chunks as "pty://<id>"
    let app_r = app.clone();
    let id_r = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = PtyChunk { data: buf[..n].to_vec() };
                    let _ = app_r.emit(&format!("pty://{}", id_r), chunk);
                }
                Err(e) => {
                    dlog(&format!("[pty/{id_r}] read error: {e}"));
                    break;
                }
            }
        }
    });

    // Waiter thread owns the Child outright. wait() blocks until the process
    // exits; if pty_kill SIGKILLs it, wait() returns naturally — no mutex
    // contention with the kill path.
    let app_w = app.clone();
    let id_w = id.clone();
    let state_w = state.inner.clone();
    let ws_for_waiter = args.workspace_id.clone();
    let pid_for_waiter = child_pid;
    thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.and_then(|s| i32::try_from(s.exit_code()).ok());
        dlog(&format!("[pty/{id_w}] child exited code={code:?}"));
        let _ = app_w.emit(&format!("pty-exit://{}", id_w), PtyExit { code });
        // Drop this PID from the sandbox's PID set so the path watcher
        // stops counting denies from anything that happened to inherit
        // this PID after exit (rare but possible on macOS).
        if let (Some(pid), Some(ws)) = (pid_for_waiter, ws_for_waiter.as_deref()) {
            sandbox::unregister_root_pid(ws, pid);
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
                // workspace's allowlist, EMFILE, or some other proxy
                // startup error - all degrade sandboxed-with-network
                // to sandboxed-no-network.
                "Network proxy didn't start - this workspace has NO network. \
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
            workspace_id: args.workspace_id.clone(),
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
fn project_add(root_path: String) -> Result<Project, String> {
    // Trim whitespace + expand a leading `~` — users paste paths with
    // both routinely. The naive `pb.join(".git").exists()` check we used
    // to do here missed: worktrees (`.git` is a FILE not a dir),
    // bare repos (no `.git` at all), and paths with a stray newline.
    // `git -C <path> rev-parse --git-dir` is the canonical "am I in a
    // git repo?" question and handles all three cases.
    let trimmed = root_path.trim();
    let expanded: String = if let Some(rest) = trimmed.strip_prefix("~/") {
        dirs::home_dir().map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string())
    } else { trimmed.to_string() };
    let pb = PathBuf::from(&expanded);
    if !pb.exists() {
        return Err(format!("{} does not exist", expanded));
    }
    if git(&["rev-parse", "--git-dir"], &pb).is_err() {
        return Err(format!("{} is not a git repo", expanded));
    }
    let mut list = load_projects();
    let canon = fs::canonicalize(&pb).map_err(|e| e.to_string())?;
    if list.iter().any(|p| p.root_path == canon.to_string_lossy()) {
        return Err("project already added".into());
    }
    let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string();
    let base = detect_base_branch(&canon).unwrap_or_else(|_| "main".into());
    let remote = detect_default_remote(&canon);
    let ws_path = worktrees_base().map_err(|e| e.to_string())?
        .join(&name).to_string_lossy().into_owned();
    let p = Project {
        id: Uuid::new_v4().to_string(),
        name,
        root_path: canon.to_string_lossy().into_owned(),
        workspaces_path: ws_path,
        base_branch: format!("{remote}/{base}"),
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
        files_to_copy: vec![
            ".env*".into(),
            ".venv".into(),
            "node_modules".into(),
        ],
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
        sandbox_rw_paths: Vec::new(),
        sandbox_allowed_hosts: Vec::new(),
        // Default to single-repo. project_add_multi is the entry
        // point for multi-repo projects (it sets type + members).
        project_type: ProjectType::Single,
        members: Vec::new(),
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
fn project_add_multi(root_path: String, name: String, members: Vec<ProjectMember>) -> Result<Project, String> {
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
    //     validation as project_add).
    //   - empty: Termic auto-creates ~/termic/projects/<slug>/ and
    //     git-init's it. We pick the slug-derived path and refuse if
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
        // git init + an initial empty commit so worktrees can branch
        // off something. A bare init has no HEAD ref, which breaks
        // `git worktree add -b <branch>` later.
        git(&["init", "-q"], &target).map_err(|e| format!("git init failed: {e}"))?;
        // Configure a default branch name we can rely on.
        let _ = git(&["symbolic-ref", "HEAD", "refs/heads/main"], &target);
        // Seed a stub CLAUDE.md so the host has something to commit.
        // Also gives the user an obvious place to start writing.
        let claude_md = format!(
            "# {}\n\nShared knowledge for the {} multi-repo project.\nThis file is loaded by every workspace under it.\n",
            trimmed_name, trimmed_name,
        );
        fs::write(target.join("CLAUDE.md"), claude_md).map_err(|e| e.to_string())?;
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
        target
    } else {
        let expanded: String = if let Some(rest) = trimmed_path.strip_prefix("~/") {
            dirs::home_dir().map(|h| h.join(rest).to_string_lossy().into_owned())
                .unwrap_or_else(|| trimmed_path.to_string())
        } else { trimmed_path.to_string() };
        let pb = PathBuf::from(&expanded);
        if !pb.exists() {
            return Err(format!("{} does not exist", expanded));
        }
        if git(&["rev-parse", "--git-dir"], &pb).is_err() {
            return Err(format!("{} is not a git repo", expanded));
        }
        pb
    };

    let mut list = load_projects();
    let canon = fs::canonicalize(&pb).map_err(|e| e.to_string())?;
    if list.iter().any(|p| p.root_path == canon.to_string_lossy()) {
        return Err("a project at this path is already added".into());
    }

    // Validate member references — fail fast if any id is unknown.
    let mut seen: HashSet<String> = HashSet::new();
    for m in &members {
        if !seen.insert(m.project_id.clone()) {
            return Err(format!("duplicate member: {}", m.project_id));
        }
        if !list.iter().any(|p| p.id == m.project_id) {
            return Err(format!("unknown member project id: {}", m.project_id));
        }
    }

    let base = detect_base_branch(&canon).unwrap_or_else(|_| "main".into());
    let remote = detect_default_remote(&canon);
    let ws_path = worktrees_base().map_err(|e| e.to_string())?
        .join(&slug).to_string_lossy().into_owned();
    let name = trimmed_name.to_string();
    let p = Project {
        id: Uuid::new_v4().to_string(),
        name,
        root_path: canon.to_string_lossy().into_owned(),
        workspaces_path: ws_path,
        base_branch: format!("{remote}/{base}"),
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
        sandbox_rw_paths: Vec::new(),
        sandbox_allowed_hosts: Vec::new(),
        project_type: ProjectType::Multi,
        members,
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
    let host_exists = list.iter().any(|p| p.id == id);
    if !host_exists { return Err("no such project".into()); }
    let mut seen: HashSet<String> = HashSet::new();
    for m in &members {
        if m.project_id == id { return Err("a multi-repo project can't list itself as a member".into()); }
        if !seen.insert(m.project_id.clone()) { return Err(format!("duplicate member: {}", m.project_id)); }
        if !list.iter().any(|p| p.id == m.project_id) {
            return Err(format!("unknown member project id: {}", m.project_id));
        }
    }
    let p = list.iter_mut().find(|p| p.id == id).unwrap();
    if p.project_type != ProjectType::Multi {
        return Err("only multi-repo projects have a members list".into());
    }
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

/// Remove a project AND archive every workspace under it (kills running
/// scripts, removes git worktrees, wipes the worktree dirs). Off-thread —
/// can take seconds on big repos. Workspaces' JSON files are also deleted
/// so the entry disappears from disk entirely; the user's actual git repo
/// at `root_path` is NOT touched (we never own that directory).
#[tauri::command]
async fn project_remove(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspaces: Vec<Workspace> = load_workspaces()
            .into_iter().filter(|w| w.project_id == id).collect();
        for w in workspaces {
            // workspace_archive_sync handles SIGTERMing scripts, running the
            // archive script, removing the worktree, and saving archived=true.
            // Errors per-workspace are logged but don't abort — we want a
            // best-effort full cleanup even if one worktree is borked.
            if let Err(e) = workspace_archive_sync(w.id.clone(), false) {
                eprintln!("project_remove: archive {} failed: {}", w.id, e);
            }
            // Hard-delete the JSON so it doesn't linger as a ghost archived
            // entry pointing at a non-existent project.
            let _ = delete_workspace_file(&w.id);
        }
        let mut list = load_projects();
        list.retain(|p| p.id != id);
        save_projects(&list).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

// ───────────────────────────── workspace commands ─────────────────────────────

#[tauri::command]
fn workspaces_list() -> Vec<Workspace> { load_workspaces() }

/// Open the project's main repo checkout as a workspace (no git worktree).
/// Idempotent: if one already exists for this project (and isn't archived),
/// returns it; otherwise seeds a new one pointing at `project.root_path`.
/// Branch is read from `git symbolic-ref` so the UI shows whichever branch
/// the user has checked out in the actual repo.
#[tauri::command]
fn workspace_open_repo(project_id: String, cli: Option<String>) -> Result<Workspace, String> {
    let proj = load_projects().into_iter().find(|p| p.id == project_id)
        .ok_or("project not found")?;
    // CLI is now explicit — frontend's "+ Open repo with <agent>" passes the
    // chosen agent id. Falls back to project default for older call sites.
    let cli = cli.unwrap_or_else(|| proj.default_cli.clone());
    let repo = PathBuf::from(&proj.root_path);
    // ALWAYS re-read current HEAD so a stale cached `branch` doesn't lie
    // (user may have `git checkout`'d a different branch outside termic
    // since the workspace was first opened).
    let branch = git(&["symbolic-ref", "--quiet", "--short", "HEAD"], &repo)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let port = 18100 + (load_workspaces().len() as u16);

    // Multi-repo project opened in REPO mode: drop a symlink for
    // each member into the host's working dir so the agent at the
    // host root can navigate into them. Symlinks point at each
    // member's live checkout (no worktree — REPO mode is the
    // "everything live, no isolation" variant). Composition gets
    // frozen on the workspace so sandbox + archive treat the symlinks
    // as the workspace's responsibility. The host's .gitignore is
    // updated with a managed block so the new dirs don't show up as
    // untracked changes.
    let projects = load_projects();
    let mut composition: Vec<WorkspaceMember> = Vec::new();
    if proj.project_type == ProjectType::Multi {
        let host_dir = Path::new(&proj.root_path);
        let mut dir_names: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // Per-member port counter — same scheme as worktree-mode
        // multi-repo: workspace.port + i + 1 so members can run
        // PORT=$TERMIC_PORT npm run dev without colliding.
        let mut next_member_port = port + 1;
        for pm in &proj.members {
            let Some(mp) = projects.iter().find(|p| p.id == pm.project_id) else { continue; };
            let dir_name = mp.name.clone();
            if dir_name.is_empty() || dir_name.contains('/') { continue; }
            if !seen.insert(dir_name.clone()) { continue; }
            let target = host_dir.join(&dir_name);
            // If the link already exists from a previous open-repo,
            // leave it alone; if a real file/dir collides, skip with
            // a warning rather than clobbering user content.
            if target.symlink_metadata().is_ok() {
                let link_target = fs::read_link(&target).ok();
                if link_target.map(|p| p.to_string_lossy().into_owned()) != Some(mp.root_path.clone()) {
                    eprintln!("workspace_open_repo: {} exists and isn't our symlink; skipping {}", target.display(), mp.name);
                    continue;
                }
            } else if let Err(e) = std::os::unix::fs::symlink(&mp.root_path, &target) {
                eprintln!("workspace_open_repo: symlink {} failed: {e}", mp.name);
                continue;
            }
            let member_port = next_member_port;
            next_member_port = next_member_port.saturating_add(1);
            composition.push(WorkspaceMember {
                project_id: mp.id.clone(),
                dir_name: dir_name.clone(),
                mode: MemberMode::RepoRoot,
                branch: String::new(),
                path: mp.root_path.clone(),
                port: member_port,
                // Scripts come from the multi-repo project's per-
                // member entry, NOT from the member project's own
                // scripts. Multi-repo projects opt into different
                // commands than standalone single-repo workspaces.
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

    let ws = Workspace {
        id: Uuid::new_v4().to_string(),
        project_id: proj.id.clone(),
        // Branch name as default — frontend shows "REPO ROOT" chip when
        // name == branch, so this keeps the chip visible until the user
        // explicitly renames the workspace.
        name: branch.clone(),
        branch: branch.clone(),
        base_branch: branch,
        path: proj.root_path.clone(),
        cli,
        port,
        created: chrono::Utc::now().to_rfc3339(),
        archived: false,
        is_repo_root: true,
        spawn_count: 0,
        has_resumable_history: false,
        // Repo-root workspaces start unsandboxed - the user is
        // opting into one-off work in their main checkout, and a
        // surprise cage at first launch would obscure that. They
        // CAN turn the sandbox on later from the dialog (shield
        // button) - the seatbelt + proxy work identically against
        // the main checkout as against a worktree.
        sandbox_enabled: false,
        sandbox_rw_paths: Vec::new(),
        sandbox_allowed_hosts: Vec::new(),
        composition,
    };
    save_workspace(&ws).map_err(|e| e.to_string())?;
    Ok(ws)
}

/// Create a new workspace (git worktree + file copy + optional streaming
/// setup script). MUST stay off the IPC handler thread — `git worktree add`
/// + the `files_to_copy` glob copy can take 1-2s on a chunky repo and that
/// blocks the WKWebView event loop in dev, freezing the UI right before the
/// progress modal opens (the user's exact complaint). See the
/// "Long-running IPC discipline" section in CLAUDE.md.
#[tauri::command]
async fn workspace_create(app: AppHandle, args: CreateWorkspaceArgs) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_create_sync(app, args))
        .await
        .map_err(|e| e.to_string())?
}

fn workspace_create_sync(app: AppHandle, args: CreateWorkspaceArgs) -> Result<Workspace, String> {
    let projects = load_projects();
    let proj = projects.iter().find(|p| p.id == args.project_id)
        .ok_or("project not found")?.clone();
    let repo = PathBuf::from(&proj.root_path);

    let slug = slugify(&args.name);
    let branch = args.branch
        .as_ref()
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .map(|b| b.to_string())
        .unwrap_or_else(|| slug.clone());

    // Determine "branch new from" — strip the remote prefix if needed for create.
    let base_full = args.base_branch.unwrap_or_else(|| proj.base_branch.clone());
    // git can branch off "origin/master" directly

    let wt_root = PathBuf::from(&proj.workspaces_path);
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
    let branch_exists = git(&["rev-parse", "--verify", &branch], &repo).is_ok();
    let add_result = if branch_exists {
        git(&["worktree", "add", wt_path.to_str().unwrap(), &branch], &repo)
    } else {
        git(&["worktree", "add", "-b", &branch, wt_path.to_str().unwrap(), &base_full], &repo)
    };
    if let Err(e) = add_result {
        if e.to_string().contains("already used by worktree") {
            return Err(format!(
                "branch '{}' is already checked out elsewhere. Pick a different workspace name.",
                branch
            ));
        }
        return Err(e.to_string());
    }

    // Copy files_to_copy (glob patterns relative to repo root) —
    // the repo's `.termic.yaml` list merged with the project override.
    for pat in &effective_files_to_copy(&proj) {
        copy_matching(&repo, &wt_path, pat);
    }

    // Allocate port (18100 + index).
    let port = 18100 + (load_workspaces().len() as u16);

    let cli = args.cli.unwrap_or_else(|| proj.default_cli.clone());
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
    // Sandbox lists are frozen at creation. The dialog seeds them
    // from the project's defaults (the user may have added/removed
    // before clicking Create); whatever it sends is what we store.
    // If the dialog sends None we fall back to the project's
    // defaults verbatim - same effective outcome.
    // Workspace inherits the union of GLOBAL defaults (Settings →
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
    let ws = Workspace {
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
        is_repo_root: false,
        spawn_count: 0,
        has_resumable_history: false,
        sandbox_enabled,
        sandbox_rw_paths,
        sandbox_allowed_hosts,
        // Single-project workspaces leave composition empty. Multi-
        // repo workspace creation runs through a separate code path
        // (workspace_create_multi) that populates this and re-uses
        // the same Workspace + sandbox plumbing.
        composition: Vec::new(),
    };
    save_workspace(&ws).map_err(|e| e.to_string())?;

    // Run setup script in a background thread so the IPC handler returns
    // immediately and the UI doesn't freeze. Errors are surfaced via a
    // notification rather than failing workspace creation.
    let (setup_script, _, _) = effective_scripts(&proj);
    if !setup_script.trim().is_empty() {
        // Stream stdout+stderr to the frontend so the New Workspace dialog
        // can show live progress. Frontend listens on:
        //   setup-output://<ws.id>  (per-line)
        //   setup-done://<ws.id>    (final exit code)
        run_script_streaming(
            setup_script.clone(),
            wt_path.clone(),
            ws.port,
            ws.name.clone(),
            app,
            ws.id.clone(),
        );
    } else {
        // No setup script — emit `done` immediately so the dialog doesn't
        // sit waiting on an event that'll never fire.
        let _ = app.emit(&format!("setup-done://{}", ws.id),
            serde_json::json!({ "code": 0, "success": true }));
    }

    Ok(ws)
}

// ───────────────────────── multi-repo workspace ─────────────────────────

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
    /// Per-member spec, frozen onto the Workspace.composition.
    pub members: Vec<CreateMultiMember>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub sandbox_enabled: Option<bool>,
    #[serde(default)]
    pub sandbox_rw_paths: Option<Vec<String>>,
    #[serde(default)]
    pub sandbox_allowed_hosts: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateMultiMember {
    pub project_id: String,
    /// Dir name inside the wrapper. Defaults to the member project's
    /// `name` field — pinned at create time so renames don't break
    /// the workspace layout.
    pub dir_name: Option<String>,
    pub mode: MemberMode,
    /// Worktree mode only. Defaults to `branch` from CreateMultiArgs
    /// (i.e. all members branch off the same name).
    pub branch: Option<String>,
    /// Worktree mode only. Defaults to the member project's
    /// `base_branch`.
    pub base_branch: Option<String>,
}

/// Create a workspace under a multi-repo project. Builds:
///   - the host worktree at `<workspaces>/<host-slug>/<wsname>/`,
///   - each member worktree'd or symlinked into a named subdir,
///   - a Termic-managed `.gitignore` block in the host worktree
///     pinning the member dir names so they're not auto-staged.
///
/// All operations are best-effort cleanup on error: a failed member
/// rolls back what's been created so far before returning.
#[tauri::command]
async fn workspace_create_multi(app: AppHandle, args: CreateMultiArgs) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_create_multi_sync(app, args))
        .await
        .map_err(|e| e.to_string())?
}

fn workspace_create_multi_sync(app: AppHandle, args: CreateMultiArgs) -> Result<Workspace, String> {
    let projects = load_projects();
    let host = projects.iter().find(|p| p.id == args.project_id)
        .ok_or("host project not found")?.clone();
    if host.project_type != ProjectType::Multi {
        return Err("workspace_create_multi requires a multi-repo project".into());
    }

    let slug = slugify(&args.name);
    let branch = args.branch
        .as_ref().map(|b| b.trim()).filter(|b| !b.is_empty())
        .map(|b| b.to_string()).unwrap_or_else(|| slug.clone());
    let base_branch = args.base_branch
        .as_ref().map(|b| b.trim()).filter(|b| !b.is_empty())
        .map(|b| b.to_string()).unwrap_or_else(|| host.base_branch.clone());

    // Validate members + freeze dir names. dir_name collisions inside
    // the wrapper are a hard error — they'd silently overwrite.
    let mut frozen: Vec<(Project, CreateMultiMember, String)> = Vec::new();
    let mut seen_dirs: HashSet<String> = HashSet::new();
    for m in &args.members {
        let p = projects.iter().find(|p| p.id == m.project_id)
            .ok_or_else(|| format!("member project not found: {}", m.project_id))?.clone();
        let dir_name = m.dir_name.clone().unwrap_or_else(|| p.name.clone());
        if dir_name.contains('/') || dir_name.is_empty() {
            return Err(format!("invalid member dir name: {dir_name:?}"));
        }
        if !seen_dirs.insert(dir_name.clone()) {
            return Err(format!("duplicate member dir name: {dir_name}"));
        }
        frozen.push((p, m.clone(), dir_name));
    }

    // Wrapper dir = `<workspaces_root>/<host-slug>/<wsname>/`. The
    // host's existing workspaces_path already encodes that pattern.
    let wrapper = PathBuf::from(&host.workspaces_path).join(&slug);
    if wrapper.exists() {
        return Err(format!("a workspace already exists at {}", wrapper.display()));
    }

    // Ensure the parent dir exists; git worktree add will create the
    // wrapper itself.
    if let Some(parent) = wrapper.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let host_repo = PathBuf::from(&host.root_path);
    // Create the host worktree first. Branch reuse logic mirrors the
    // single-repo create: if branch exists locally, just check out;
    // else create from base.
    let branch_exists = git(&["rev-parse", "--verify", &branch], &host_repo).is_ok();
    let add_args: Vec<&str> = if branch_exists {
        vec!["worktree", "add", wrapper.to_str().unwrap(), &branch]
    } else {
        vec!["worktree", "add", "-b", &branch, wrapper.to_str().unwrap(), &base_branch]
    };
    if let Err(e) = git(&add_args, &host_repo) {
        return Err(format!("host worktree add failed: {e}"));
    }

    // Helper that tears down everything we've created so far on
    // failure. Order: members first (so the host worktree git still
    // knows about them), then the host. Best-effort.
    let rollback = |members_done: &[(Project, CreateMultiMember, String, MemberMode, String)]| {
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
        let _ = git(&["worktree", "remove", "--force", wrapper.to_str().unwrap()], &host_repo);
        let _ = fs::remove_dir_all(&wrapper);
    };

    // Now create each member. members_done accumulates so rollback
    // can unwind a partial composition.
    let mut composition: Vec<WorkspaceMember> = Vec::new();
    let mut done: Vec<(Project, CreateMultiMember, String, MemberMode, String)> = Vec::new();
    // Per-member port counter — each member gets workspace.port+i+1
    // so two members running PORT=$TERMIC_PORT npm run dev don't
    // collide. We bumped 'port' below already by load_workspaces().len()
    // for the workspace itself; members live in the gap above it.
    let ws_port = 18100 + (load_workspaces().len() as u16);
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
                // Scripts come from the MULTI-REPO PROJECT's
                // per-member spec (host.members[i]), not from the
                // member project's standalone scripts. This is the
                // "different commands per multi-repo project" model.
                let proj_scripts = host.members.iter()
                    .find(|pm| pm.project_id == mp.id);
                composition.push(WorkspaceMember {
                    project_id: mp.id.clone(),
                    dir_name: dir_name.clone(),
                    mode: MemberMode::RepoRoot,
                    branch: String::new(),
                    path: mp.root_path.clone(),
                    port: member_port,
                    setup_script:   proj_scripts.map(|s| s.setup_script.clone()).unwrap_or_default(),
                    run_script:     proj_scripts.map(|s| s.run_script.clone()).unwrap_or_default(),
                    archive_script: proj_scripts.map(|s| s.archive_script.clone()).unwrap_or_default(),
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
                let mexists = git(&["rev-parse", "--verify", &mbranch], &mrepo).is_ok();
                let margs: Vec<&str> = if mexists {
                    vec!["worktree", "add", target.to_str().unwrap(), &mbranch]
                } else {
                    vec!["worktree", "add", "-b", &mbranch, target.to_str().unwrap(), &mbase]
                };
                if let Err(e) = git(&margs, &mrepo) {
                    rollback(&done);
                    return Err(format!("member {dir_name} worktree add failed: {e}"));
                }
                let proj_scripts = host.members.iter()
                    .find(|pm| pm.project_id == mp.id);
                composition.push(WorkspaceMember {
                    project_id: mp.id.clone(),
                    dir_name: dir_name.clone(),
                    mode: MemberMode::Worktree,
                    branch: mbranch,
                    path: target.to_string_lossy().into_owned(),
                    port: member_port,
                    setup_script:   proj_scripts.map(|s| s.setup_script.clone()).unwrap_or_default(),
                    run_script:     proj_scripts.map(|s| s.run_script.clone()).unwrap_or_default(),
                    archive_script: proj_scripts.map(|s| s.archive_script.clone()).unwrap_or_default(),
                });
                done.push((mp.clone(), spec, dir_name, MemberMode::Worktree, target.to_string_lossy().into_owned()));
            }
        }
    }

    // Manage the wrapper's .gitignore so the host repo doesn't try
    // to track the member dirs. Leading-slash entries anchor to the
    // wrapper root only.
    let dir_names: Vec<String> = composition.iter().map(|m| m.dir_name.clone()).collect();
    if let Err(e) = ensure_multirepo_gitignore(&wrapper, &dir_names) {
        eprintln!("multi-repo gitignore write failed (non-fatal): {e}");
    }

    // Auto-commit the wrapper's bookkeeping files (CLAUDE.md /
    // AGENTS.md / .gitignore / agent dirs) so they don't show up as
    // ?? noise in the Changes view. The user is here to work on
    // member code, not stare at config files Termic itself dropped.
    // Best-effort — non-fatal if `git add` finds nothing to add or
    // the commit fails (e.g. no user.email globally configured;
    // -c overrides handle that path).
    {
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
                  "commit", "-q", "-m", "termic: workspace bookkeeping"],
                &wrapper,
            );
        }
    }

    // Sandbox: same union/merge logic as single-repo create, but the
    // base set unions across every member project too.
    let globals = load_settings_inner();
    let sandbox_enabled = args.sandbox_enabled.unwrap_or(host.default_sandbox);
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
    for m in &composition {
        if let Some(mp) = projects.iter().find(|p| p.id == m.project_id) {
            extend_unique(&mut base_rw,    &mp.sandbox_rw_paths);
            extend_unique(&mut base_hosts, &mp.sandbox_allowed_hosts);
        }
    }
    let sandbox_rw_paths    = args.sandbox_rw_paths.unwrap_or(base_rw);
    let sandbox_allowed_hosts = args.sandbox_allowed_hosts.unwrap_or(base_hosts);

    let cli = args.cli.unwrap_or_else(|| host.default_cli.clone());
    let port = 18100 + (load_workspaces().len() as u16);
    let ws = Workspace {
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
        is_repo_root: false,
        spawn_count: 0,
        has_resumable_history: false,
        sandbox_enabled,
        sandbox_rw_paths,
        sandbox_allowed_hosts,
        composition,
    };
    save_workspace(&ws).map_err(|e| e.to_string())?;

    // Streamed setup: host's project.setup_script (cwd=wrapper)
    // first, then each member's setup_script (cwd=member.path) in
    // declared order. All lines emit on setup-output://<wsId> with
    // a `[name] ` prefix so the dialog UI can render them inline
    // without us inventing a multi-channel event topic. setup-done
    // fires once with the aggregate success at the very end.
    // Multi-repo: ONLY members have scripts. The host is a wrapper
    // dir for CLAUDE.md / AGENTS.md / .claude/, never something the
    // user wants to "run" — so we don't even peek at host.setup_script
    // here. (Single-repo workspace_create_sync handles its own.)
    // Tuple shape: (dir_name, script, cwd, port). Per-member port
    // so setup scripts that listen (rare but possible — e.g. setup
    // boots a docker compose stack on $TERMIC_PORT) don't collide
    // across siblings. Legacy workspaces (port == 0) get the same
    // workspace.port + i + 1 scheme retroactively.
    let member_setups: Vec<(String, String, std::path::PathBuf, u16)> = ws.composition.iter()
        .enumerate()
        .filter_map(|(idx, m)| {
            let s = m.setup_script.trim();
            if s.is_empty() { None } else {
                let p = if m.port == 0 { ws.port.saturating_add(idx as u16 + 1) } else { m.port };
                Some((m.dir_name.clone(), m.setup_script.clone(), std::path::PathBuf::from(&m.path), p))
            }
        })
        .collect();
    // Sibling port discovery for setup scripts (same scheme as
    // workspace_run_script_stream). TERMIC_PORT_<DIR> for every
    // member so a setup script that needs to know e.g. the API's
    // port can read it.
    let sibling_ports: Vec<(String, u16)> = ws.composition.iter().enumerate()
        .map(|(i, m)| {
            let p = if m.port == 0 { ws.port.saturating_add(i as u16 + 1) } else { m.port };
            let sanitized: String = m.dir_name.chars()
                .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                .collect();
            (format!("TERMIC_PORT_{sanitized}"), p)
        })
        .collect();
    if member_setups.is_empty() {
        let _ = app.emit(&format!("setup-done://{}", ws.id),
            serde_json::json!({ "code": 0, "success": true }));
    } else {
        let app2 = app.clone();
        let ws_id = ws.id.clone();
        let name = ws.name.clone();
        thread::spawn(move || {
            let run_one = |label: &str, script: &str, cwd: &Path, port: u16| -> bool {
                use std::io::{BufRead, BufReader};
                use std::process::Stdio;
                let _ = app2.emit(&format!("setup-output://{}", ws_id),
                    serde_json::json!({ "line": format!("[{label}] $ {script}") }));
                let mut cmd = Command::new("bash");
                cmd.arg("-lc").arg(script).current_dir(cwd)
                    .env("TERMIC_PORT", port.to_string())
                    .env("TERMIC_WORKSPACE_NAME", &name)
                    .env("TERMIC_TASK", &name)
                    .stdout(Stdio::piped()).stderr(Stdio::piped());
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

    Ok(ws)
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
fn workspace_rename(id: String, name: String) -> Result<Workspace, String> {
    let new_name = name.trim();
    if new_name.is_empty() {
        return Err("name cannot be empty".into());
    }
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    w.name = new_name.to_string();
    save_workspace(w).map_err(|e| e.to_string())?;
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
fn workspace_set_cli(id: String, cli: String) -> Result<Workspace, String> {
    if !["claude", "gemini", "codex", "agy"].contains(&cli.as_str()) {
        return Err(format!("unknown cli: {cli}"));
    }
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    w.cli = cli;
    save_workspace(w).map_err(|e| e.to_string())?;
    Ok(w.clone())
}

/// Newest-first list of macOS Sandbox denials touching the workspace
/// in the last `minutes` minutes. Used by the WorkspaceSandboxDialog
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

/// Per-workspace deny counters surfaced in the TerminalPane footer
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

/// Detailed per-host breakdown of network denies for a workspace.
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

/// Append a host to the workspace's `sandbox_allowed_hosts` list and
/// save. Does NOT kill the live PTY — adding to the allowlist is
/// strictly more permissive than what the running agent already has,
/// so leaving the existing process on its older (narrower) profile is
/// safe; the new entry takes effect on the next agent start. Backs the
/// "Allow" button next to each blocked host in the footer popover.
#[tauri::command]
fn workspace_sandbox_add_allowed_host(
    _state: State<'_, PtyManager>, id: String, host: String,
) -> Result<usize, String> {
    let host = host.trim().to_string();
    if host.is_empty() { return Err("empty host".into()); }
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    if !w.sandbox_allowed_hosts.iter().any(|h| h == &host) {
        w.sandbox_allowed_hosts.push(host.clone());
    }
    let project_id = w.project_id.clone();
    save_workspace(w).map_err(|e| e.to_string())?;
    // Lift into the project's sandbox defaults too, so future
    // workspaces under the same project inherit. The agent probes
    // the same hosts in every workspace it runs; saving per-project
    // means the user doesn't have to re-click Allow on each new
    // workspace they create. Sibling workspaces that already exist
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

/// Mirror of `workspace_sandbox_add_allowed_host` but for filesystem
/// paths. Append to `sandbox_rw_paths`, save. No SIGKILL — same
/// reasoning: the new entry is purely additive, the running agent's
/// old profile is narrower, change takes effect on next start.
#[tauri::command]
fn workspace_sandbox_add_allowed_path(
    _state: State<'_, PtyManager>, id: String, path: String,
) -> Result<usize, String> {
    let path = path.trim().to_string();
    if path.is_empty() { return Err("empty path".into()); }
    // Replace the literal $HOME prefix with the $HOME token so the
    // stored entry stays portable + readable (we substitute at spawn
    // anyway). Only the LEADING prefix — `/Users/simion/Pictures` is
    // the user's home; embedded `/Users/...` elsewhere is left alone.
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    // Tokenized form for persistence ($HOME/...).
    let stored = if !home.is_empty() && (path == home || path.starts_with(&format!("{home}/"))) {
        path.replacen(&home, "$HOME", 1)
    } else if !home.is_empty() && (path == "$HOME" || path.starts_with("$HOME/")) {
        path.clone()
    } else {
        path.clone()
    };
    // Absolute form for the deny-tracker prune (the tracker stores
    // absolute paths from the kernel deny log). The frontend may have
    // sent either form depending on whether the click was on a
    // shortened or raw display.
    let absolute = if !home.is_empty() && (path == "$HOME" || path.starts_with("$HOME/")) {
        path.replacen("$HOME", &home, 1)
    } else {
        path
    };
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    if !w.sandbox_rw_paths.iter().any(|p| p == &stored) {
        w.sandbox_rw_paths.push(stored.clone());
    }
    let project_id = w.project_id.clone();
    save_workspace(w).map_err(|e| e.to_string())?;
    // Lift to project defaults too so future workspaces inherit.
    // See workspace_sandbox_add_allowed_host for rationale.
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

/// Undo of `workspace_sandbox_add_allowed_path`. Removes the path from
/// the workspace's `sandbox_rw_paths` list. Used by the toast's Undo
/// button after a click in the blocked-paths popover. Idempotent —
/// removing a path that isn't in the list is a no-op success.
#[tauri::command]
fn workspace_sandbox_remove_allowed_path(
    _state: State<'_, PtyManager>, id: String, path: String,
) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() { return Ok(()); }
    // Match both raw and $HOME-tokenized forms (the stored entry was
    // tokenized at add-time, but the caller may pass either).
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let tokenized = if !home.is_empty() && (path == home || path.starts_with(&format!("{home}/"))) {
        path.replacen(&home, "$HOME", 1)
    } else { path.clone() };
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    w.sandbox_rw_paths.retain(|p| p != &path && p != &tokenized);
    save_workspace(w).map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────────── repo-root `.termic.yaml` config ─────────────────
//
// The "Allow for this repo" destination. Where `workspace_sandbox_add_*`
// (above) writes the personal, uncommitted "allow for me" overrides
// into `projects.json`, these write the committed, team-shared
// `.termic.yaml` at the repo root. Both feed `live_sandbox_lists`.

/// Tokenize a leading `$HOME` prefix so the stored `.termic.yaml`
/// entry stays portable. Mirrors `workspace_sandbox_add_allowed_path`.
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
    let proj = workspace_project(&id)?;
    repo_config::add_allowed(Path::new(&proj.root_path), repo_config::AllowKind::Host, &host)
        .map_err(|e| e.to_string())
}

/// Resolve a workspace id to its owning Project (for repo_config writes
/// keyed at the project's `root_path`).
fn workspace_project(ws_id: &str) -> Result<Project, String> {
    let ws = load_workspaces()
        .into_iter()
        .find(|w| w.id == ws_id)
        .ok_or("no such ws")?;
    load_projects()
        .into_iter()
        .find(|p| p.id == ws.project_id)
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
    let proj = workspace_project(&id)?;
    repo_config::add_allowed(Path::new(&proj.root_path), repo_config::AllowKind::Path, &stored)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_recent_denials(id: String, minutes: Option<u32>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || -> Vec<String> {
        let Some(ws) = load_workspaces().into_iter().find(|w| w.id == id) else {
            return Vec::new();
        };
        sandbox::recent_denials(&ws.path, minutes.unwrap_or(10))
    })
    .await
    .unwrap_or_default()
}

/// Self-test the workspace's sandbox: provisions a fresh ephemeral
/// bundle from the CANDIDATE config the caller passes in (so the
/// dialog can test pending edits BEFORE the user commits to save),
/// runs two curls (one allowed, one denied), reports the outcome.
/// Async (provisioning starts the proxy thread + curl shells out) so
/// we don't block the IPC handler thread.
///
/// Optional list args default to the saved workspace's lists - the
/// caller can omit them when they want to test the on-disk config
/// (e.g. before opening the dialog at all). When provided, they
/// override the saved arrays, matching what the user is staring at
/// in the textareas right now.
#[tauri::command]
async fn workspace_test_sandbox(
    id: String,
    rw_paths: Option<Vec<String>>,
    allowed_hosts: Option<Vec<String>>,
) -> Result<Vec<sandbox::ProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<sandbox::ProbeResult>, String> {
        let mut ws = load_workspaces().into_iter().find(|w| w.id == id)
            .ok_or("no such workspace")?;
        // Overlay the candidate lists onto the in-memory copy ONLY.
        // We never save - the user's "Save & restart" button is the
        // only place workspace_set_sandbox gets called.
        if let Some(rw) = rw_paths { ws.sandbox_rw_paths = rw; }
        if let Some(hosts) = allowed_hosts { ws.sandbox_allowed_hosts = hosts; }
        // Force sandbox_enabled=true for the test even if the
        // candidate has it off - testing an off-sandbox is
        // meaningless and `run_self_test`'s provision call would
        // fail anyway. The actual ws.sandbox_enabled state on disk
        // is untouched.
        ws.sandbox_enabled = true;
        Ok(sandbox::run_self_test(&ws))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Update a workspace's sandbox config and SIGKILL any live PTYs of
/// that workspace so the next mount picks up the new profile. Returns
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
fn workspace_set_sandbox(
    state: State<'_, PtyManager>,
    id: String,
    enabled: bool,
    rw_paths: Vec<String>,
    allowed_hosts: Vec<String>,
) -> Result<usize, String> {
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    w.sandbox_enabled = enabled;
    w.sandbox_rw_paths = rw_paths;
    w.sandbox_allowed_hosts = allowed_hosts;
    save_workspace(w).map_err(|e| e.to_string())?;

    // Find + SIGKILL every live PTY belonging to this workspace. We
    // hold the manager lock only long enough to collect (id, pid)
    // pairs - kill(2) outside the lock so a slow signal can't stall
    // unrelated PTY ops.
    let victims: Vec<(String, Option<u32>)> = {
        let map = state.inner.lock();
        map.iter()
            .filter(|(_, slot)| slot.workspace_id.as_deref() == Some(&id))
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

/// Increment + persist the workspace's `spawn_count`. Historical metric
/// only — resume gating now uses `has_resumable_history` instead.
#[tauri::command]
fn workspace_record_spawn(id: String) -> Result<u32, String> {
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    w.spawn_count = w.spawn_count.saturating_add(1);
    save_workspace(w).map_err(|e| e.to_string())?;
    Ok(w.spawn_count)
}

/// Set the persisted `has_resumable_history` flag for a workspace.
/// Frontend calls this:
///   - TRUE when a spawn has been alive past the rapid-failure window
///     (~2s) — meaning the agent didn't immediately bail with "no
///     conversation to continue", so a real session likely exists.
///   - FALSE when a resume-attempt spawn exits within the failure
///     window — we now know the resume path is broken for this worktree
///     and shouldn't re-try.
#[tauri::command]
fn workspace_set_has_history(id: String, value: bool) -> Result<(), String> {
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    if w.has_resumable_history == value { return Ok(()); }
    w.has_resumable_history = value;
    save_workspace(w).map_err(|e| e.to_string())?;
    Ok(())
}

/// Archive a workspace: stop scripts, run the archive script, remove the
/// worktree, mark archived in our JSON.
///
/// CRITICAL: this MUST run off the Tauri IPC thread. `fs::remove_dir_all`
/// on a worktree containing a sizeable `.venv` / `node_modules` (50k+
/// inodes) hammers APFS metadata and freezes the whole process — and in
/// the prior synchronous version, that froze the entire Mac through the
/// blocked main webview event loop. `spawn_blocking` parks the work on a
/// background thread so the UI keeps painting and the OS stays responsive.
#[tauri::command]
async fn workspace_archive(id: String, delete_branch: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace_archive_sync(id, delete_branch.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

fn workspace_archive_sync(id: String, delete_branch: bool) -> Result<(), String> {
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("workspace not found")?;
    let proj = load_projects().into_iter().find(|p| p.id == w.project_id);

    // Kill any running setup/run scripts for this workspace BEFORE doing
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

    // Multi-repo workspaces: only members have scripts (host is a
    // wrapper, not a thing you run). Members archive in REVERSE
    // declared order — stack teardown convention (last started,
    // first stopped). Single-repo workspaces: host's project
    // archive_script fires (covers `npm run cleanup` etc).
    if !w.composition.is_empty() {
        for m in w.composition.iter().rev() {
            if !m.archive_script.trim().is_empty() && Path::new(&m.path).exists() {
                let _ = run_script(&m.archive_script, Path::new(&m.path), w.port, &w.name);
            }
        }
    } else if let Some(p) = &proj {
        let archive = effective_scripts(p).2;
        if !archive.trim().is_empty() {
            let _ = run_script(&archive, Path::new(&w.path), w.port, &w.name);
        }
    }

    let mut errs = Vec::new();
    // Repo-root workspaces are NOT git worktrees — skip the worktree/rmdir
    // dance entirely. Archiving one just removes it from our list; the actual
    // repo on disk stays intact.
    if w.is_repo_root {
        // Multi-repo project opened in REPO mode: workspace_open_repo
        // dropped member symlinks into the host dir. Clean them up
        // on archive so a re-open doesn't trip the "already exists,
        // not our symlink" guard. We only remove entries that are
        // STILL symlinks pointing where we expect — a user who
        // replaced the link with real content keeps their work.
        for m in &w.composition {
            if m.mode != MemberMode::RepoRoot { continue; }
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
        save_workspace(w).map_err(|e| e.to_string())?;
        delete_workspace_file(&id).map_err(|e| e.to_string())?;
        if !errs.is_empty() { return Err(errs.join("; ")); }
        return Ok(());
    }

    // Multi-repo workspaces tear down each member first, then the
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
                    if let Some(mp) = all_projects.iter().find(|p| p.id == m.project_id) {
                        if let Err(e) = git(&["worktree", "remove", "--force", &m.path], Path::new(&mp.root_path)) {
                            errs.push(format!("worktree remove {}: {e}", m.dir_name));
                        }
                        if delete_branch && !m.branch.is_empty() {
                            if let Err(e) = git(&["branch", "-D", &m.branch], Path::new(&mp.root_path)) {
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

    if let Some(p) = &proj {
        if let Err(e) = git(&["worktree", "remove", "--force", &w.path], Path::new(&p.root_path)) {
            errs.push(format!("worktree remove: {e}"));
        }
        if delete_branch && !w.branch.is_empty() {
            if let Err(e) = git(&["branch", "-D", &w.branch], Path::new(&p.root_path)) {
                errs.push(format!("branch delete failed: {e}"));
            }
        }
    }
    if Path::new(&w.path).exists() {
        if let Err(e) = fs::remove_dir_all(&w.path) {
            errs.push(format!("rm worktree dir: {e}"));
        }
    }

    w.archived = true;
    save_workspace(w).map_err(|e| e.to_string())?;
    if errs.is_empty() { Ok(()) } else { Err(errs.join("; ")) }
}

#[tauri::command]
async fn workspace_delete(id: String) -> Result<(), String> {
    // Hard delete: archive (off-thread) then wipe the json. Same async
    // discipline as workspace_archive — see its doc comment for why.
    let id2 = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = workspace_archive_sync(id2.clone(), false);
        delete_workspace_file(&id2).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn workspace_run_script(id: String, which: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no such ws")?;
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
fn workspace_diff(id: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
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
/// Skips workspaces where `is_repo_root` is true — those ARE the main
/// checkout, there's nothing to send.
#[tauri::command]
async fn workspace_send_diff_to_main(id: String) -> Result<SendDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SendDiffResult, String> {
        let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no such workspace")?;
        let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("project missing")?;
        if w.is_repo_root {
            return Err("This workspace IS the main checkout — nothing to send.".into());
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
            let src = safe_workspace_path(&worktree, rel)
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
    /// safe_workspace_path check would reject them).
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
pub struct WorkspaceChanges {
    /// Total file count across all groups. UI badge.
    pub count: usize,
    /// Flat list of host-only files. Kept for back-compat with any
    /// caller / UI bit that pre-dates the multi-repo split. New code
    /// should iterate `groups` instead.
    pub files: Vec<ChangedFile>,
    /// Per-repo groups. Single-repo workspaces have one entry (host
    /// only); multi-repo workspaces have one per composition member +
    /// the host. Empty for repo-root workspaces (the user's living
    /// repo — surfacing its uncommitted changes here would be noise).
    pub groups: Vec<ChangeGroup>,
}

#[tauri::command]
fn workspace_changes(id: String) -> Result<WorkspaceChanges, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;

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

    // Host group: always present. Run git status at the workspace
    // path itself (= wrapper for multi, = worktree for single).
    let host_out = git(&["status", "--porcelain"], Path::new(&w.path))
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

    // Member groups: only for multi-repo workspaces. For each member,
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
        let member_out = git(&["status", "--porcelain"], member_path)
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
    Ok(WorkspaceChanges { count, files: host_files, groups })
}

/// Resolve a renderer-supplied path against a workspace root and verify the
/// result is contained within it. Rejects absolute paths and `..` segments
/// up front so attempts like `/etc/passwd` or `../../foo` fail loudly
/// instead of being silently joined. Canonicalizes both ends so a symlink
/// pointing outside the worktree also fails the contains check.
///
/// **MUST** be used for every renderer → filesystem read inside a workspace
/// (file_read, file_diff, future watchers). Without it, untrusted paths
/// from the webview could read arbitrary text files on disk.
fn safe_workspace_path(ws_path: &Path, rel: &str) -> Result<PathBuf, String> {
    let pb = Path::new(rel);
    if pb.is_absolute() {
        return Err(format!("absolute paths not allowed: {rel}"));
    }
    if pb.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("`..` segments not allowed: {rel}"));
    }
    let target = ws_path.join(pb);
    let canon_base = fs::canonicalize(ws_path).map_err(|e| e.to_string())?;
    let canon_target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_base) {
        return Err(format!("path escapes workspace: {rel}"));
    }
    Ok(canon_target)
}

#[tauri::command]
fn workspace_file_read(id: String, path: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let abs = safe_workspace_path(Path::new(&w.path), &path)?;
    // Refuse binary or huge files for now — viewer is text-only.
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 {
        return Err(format!("file too large to preview ({} bytes)", meta.len()));
    }
    fs::read_to_string(&abs).map_err(|e| format!("read failed: {e}"))
}

/// Overwrite a workspace file with new contents (editor save). The
/// path is constrained to the worktree by `safe_workspace_path`, same
/// as the read side. Synchronous to mirror `workspace_file_read` — a
/// single text file (capped at 2 MB on read) is not the heavy-IO case
/// the spawn_blocking discipline targets.
#[tauri::command]
fn workspace_file_write(id: String, path: String, content: String) -> Result<(), String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let abs = safe_workspace_path(Path::new(&w.path), &path)?;
    fs::write(&abs, content).map_err(|e| format!("write failed: {e}"))
}

/// Return the (original, modified) sides of a tracked file so a
/// language-aware diff viewer can render them side-by-side with
/// syntax highlighting. Original = `git show HEAD:<path>` (empty
/// for untracked); modified = current on-disk content (empty if
/// deleted in the worktree).
#[derive(Serialize)]
struct FileDiffSides { original: String, modified: String }

#[tauri::command]
fn workspace_file_diff_sides(id: String, path: String) -> Result<FileDiffSides, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let wt = PathBuf::from(&w.path);
    let original = git(&["--no-pager", "show", &format!("HEAD:{path}")], &wt)
        .unwrap_or_default();
    let modified = match safe_workspace_path(&wt, &path) {
        Ok(p) if p.exists() => fs::read_to_string(&p).unwrap_or_default(),
        _ => String::new(),
    };
    Ok(FileDiffSides { original, modified })
}

#[tauri::command]
fn workspace_file_diff(id: String, path: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let wt = PathBuf::from(&w.path);
    // Tracked diff is safe because the path is forwarded to `git -C wt diff`
    // which already constrains paths to the working tree. The untracked
    // fallback below DOES read straight from disk, so for THAT branch we
    // safe-resolve before reading.
    let tracked_diff = git(&["--no-pager", "diff", "HEAD", "--", &path], &wt)
        .unwrap_or_default();
    if !tracked_diff.trim().is_empty() {
        return Ok(tracked_diff);
    }
    // Maybe it's untracked — synthesize a "new file" diff.
    let abs = match safe_workspace_path(&wt, &path) {
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
fn workspace_files(id: String) -> Result<Vec<String>, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
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

/// List entries inside a directory, relative to the workspace root. `rel`
/// of "" returns the workspace's top level. Refuses to traverse outside the
/// workspace (no `..` segments allowed). Returns `is_dir` directly so the UI
/// doesn't have to guess by extension.
#[tauri::command]
fn workspace_dir_list(id: String, rel: String) -> Result<Vec<FileEntry>, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let base = PathBuf::from(&w.path);
    // Multi-repo: when the relative path enters a composition member
    // (e.g. "pydpf" or "pydpf/src"), resolve under that member's real
    // path instead of going through safe_workspace_path — which would
    // canonicalize the symlink-to-real-checkout and reject as "escapes
    // workspace". The member is a first-class browseable subtree.
    let canon_target = if rel.is_empty() {
        fs::canonicalize(&base).map_err(|e| e.to_string())?
    } else if let Some((member, remainder)) = w.composition.iter().find_map(|m| {
        if rel == m.dir_name {
            Some((m, String::new()))
        } else if let Some(rest) = rel.strip_prefix(&format!("{}/", m.dir_name)) {
            Some((m, rest.to_string()))
        } else {
            None
        }
    }) {
        let mp = PathBuf::from(&member.path);
        if remainder.is_empty() {
            fs::canonicalize(&mp).map_err(|e| e.to_string())?
        } else {
            safe_workspace_path(&mp, &remainder)?
        }
    } else {
        safe_workspace_path(&base, &rel)?
    };
    let mut out = Vec::new();
    let rd = fs::read_dir(&canon_target).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = match e.file_name().into_string() { Ok(s) => s, Err(_) => continue };
        // Always hide .git — it's repo plumbing, never something the
        // user wants to browse in the file tree.
        if name == ".git" { continue; }
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
    // Directories first, then files; alphabetic within each group.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
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

/// Setup / run / archive scripts run UNSANDBOXED, even for workspaces
/// where `sandbox_enabled` is true. The agent itself is the threat
/// model - the user-authored scripts in `project.{setup,run,archive}_script`
/// are explicit user intent, and sandboxing them would break common
/// dev-loop moves (npm install, docker build, kubectl apply, etc.). The
/// aux/scratch terminal is in the same bucket; sandbox specifically
/// targets the agent PTY.
fn run_script(script: &str, cwd: &Path, port: u16, name: &str) -> Result<String> {
    let out = Command::new("bash")
        .arg("-lc")
        .arg(script)
        .current_dir(cwd)
        .env("TERMIC_PORT", port.to_string())
        .env("TERMIC_WORKSPACE_NAME", name)
        .env("TERMIC_TASK", name)
        .output()
        .with_context(|| "run script")?;
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
/// Used during workspace creation so the New Workspace dialog can show live
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
        let spawn_res = Command::new("bash")
            .arg("-lc")
            .arg(&script)
            .current_dir(&cwd)
            .env("TERMIC_PORT", port.to_string())
            .env("TERMIC_WORKSPACE_NAME", &name)
            .env("TERMIC_TASK", &name)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
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
/// Lets `workspace_stop_script` find the right process group to SIGTERM. We
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

/// Kick off either the project's setup or run script for a workspace with
/// live stdout/stderr streaming. Emits:
///   script-output://<ws_id>:<kind>  { line: string }
///   script-done://<ws_id>:<kind>    { code, success }
/// If a previous instance is still running for the same (ws, kind), it is
/// SIGTERM'd before the new one starts so users can't accidentally fork
/// multiple dev servers off the same project.
#[tauri::command]
// `member`: empty / unset = run the host script with cwd at the
// workspace path (single-repo behavior; for multi-repo workspaces
// this is the host worktree). Non-empty = run a composition member's
// script with cwd inside that member's dir. The frontend resolves
// the member by its frozen `dir_name`.
fn workspace_run_script_stream(
    id: String,
    kind: String,
    member: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no such ws")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("no proj")?;
    let member_dir = member.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);

    // Resolve target: empty member = host, otherwise the named
    // composition member. Each carries its own (script, cwd, port).
    // Per-member port avoids `PORT=$TERMIC_PORT npm run dev`
    // collisions when two members run in parallel. Members created
    // before per-member ports existed (port == 0) fall back to the
    // workspace's port.
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
            // Legacy migration: workspaces created before per-member
            // ports existed have m.port == 0. Falling back to
            // w.port would re-introduce the original collision. Use
            // the same scheme workspace_create_multi_sync uses now —
            // workspace.port + index + 1 — so existing workspaces get
            // unique ports without needing to be recreated.
            let p = if m.port == 0 { w.port.saturating_add(idx as u16 + 1) } else { m.port };
            (s, std::path::PathBuf::from(&m.path), p)
        }
    };

    // Event-channel topic + RUNNING_SCRIPTS key include the member
    // dir so multiple members can run in parallel without colliding.
    // Host uses an empty member component for back-compat.
    let topic_member = member_dir.clone().unwrap_or_default();
    let map_key = format!("{id}:{topic_member}:{kind}");
    let emit_done = format!("script-done://{id}:{topic_member}:{kind}");
    let emit_out  = format!("script-output://{id}:{topic_member}:{kind}");

    // Empty script → no-op but emit done so the UI doesn't spin forever.
    if script.trim().is_empty() {
        let _ = app.emit(&emit_done,
            serde_json::json!({ "code": 0, "success": true }));
        return Ok(());
    }

    // Kill any prior instance for (ws, member, kind) — sends SIGTERM
    // to the whole process group so children die too.
    if let Some(prev) = running_scripts_remove(&map_key) {
        unsafe { libc::kill(-prev, libc::SIGTERM); }
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
        // `process_group(0)` puts the child in its own group so we can kill
        // the whole tree later via `kill(-pgid, SIGTERM)`.
        let mut cmd = Command::new("bash");
        cmd.arg("-lc").arg(&script)
            .current_dir(&cwd)
            .env("TERMIC_PORT", port.to_string())
            .env("TERMIC_WORKSPACE_NAME", &name)
            .env("TERMIC_TASK", &name)
            // Legacy aliases — keep scripts saved under the old name working
            // until users migrate their preview_url / scripts.
            .env("CONDUCTOR_PORT", port.to_string())
            .env("CONDUCTOR_WORKSPACE_NAME", &name)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
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
        running_scripts_remove(&map_key_o);
        let code = status.as_ref().ok().and_then(|s| s.code());
        let success = status.map(|s| s.success()).unwrap_or(false);
        let _ = app_o.emit(&emit_done_o,
            serde_json::json!({ "code": code, "success": success }));
    });
    Ok(())
}

/// SIGTERM the process group for (ws_id, member, kind). No-op if
/// nothing's running. `member` is the composition member's dir_name
/// (empty / unset = host). Caller should still wait for the matching
/// `script-done` event before updating UI state — kill is async from
/// the child's perspective.
#[tauri::command]
fn workspace_stop_script(id: String, kind: String, member: Option<String>) -> Result<(), String> {
    let member_dir = member.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let map_key = format!("{id}:{}:{kind}", member_dir.unwrap_or_default());
    if let Some(pid) = running_scripts_remove(&map_key) {
        unsafe { libc::kill(-pid, libc::SIGTERM); }
    }
    Ok(())
}

// ───────────────────────────── notify ─────────────────────────────

#[tauri::command]
fn log_line(msg: String) { dlog(&msg); }

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

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
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

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    Command::new("open").arg(&path).status().map_err(|e| e.to_string())?;
    Ok(())
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
    /// Workspaces reference these by `id`. Always seeded with the built-ins on
    /// first load so the app is usable out of the box.
    pub agents: Vec<Agent>,
    /// Global sandbox defaults. Merged with the per-project lists when a
    /// workspace gets created with sandbox enabled, and pre-filled into
    /// the sandbox dialog when the user enables the cage from scratch.
    /// Workspaces still freeze a per-workspace copy at creation time —
    /// editing these later only affects NEW workspaces.
    pub sandbox_default_rw_paths: Vec<String>,
    pub sandbox_default_allowed_hosts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,                  // stable key referenced by Workspace.cli
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
    /// popover, New Workspace, Review, the + tab menu). Settings →
    /// Agent CLIs still lists it so it can be re-enabled. Does NOT
    /// affect workspaces already bound to this agent — they keep
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
    /// Paths joined into the workspace sandbox allow-list whenever this
    /// agent's CLI is launched. The sandbox is allowlist-only (default-deny
    /// reads + writes outside this set); per-agent paths cover the dirs the
    /// CLI itself needs (its config / session / cache). Cannot be removed
    /// per-workspace — the workspace's own `sandbox_rw_paths` only ADDS
    /// to this set. `$HOME` substitution happens at sandbox provision time.
    #[serde(default)]
    pub sandbox_allowed_paths: Vec<String>,
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
    /// (gated by `Workspace.spawn_count > 0`). Lets the CLI resume its own
    /// per-directory history file. Empty → no auto-resume for this agent.
    #[serde(default)]
    pub resume_args: Vec<String>,
}

fn default_agents() -> Vec<Agent> {
    vec![
        Agent {
            id: "claude".into(),
            display_name: "claude".into(),
            command: "claude".into(),
            // No base args. The `--name {workspace_slug}` + `--resume {slug}`
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
                // `--continue` picks up the most-recent session in CWD
                // without an interactive picker. Trade-off: if you've
                // run claude in this dir outside termic, it'll resume
                // *that* session — less deterministic than a named
                // scheme but doesn't dead-end.
                resume_args: vec!["--continue".into()],
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
        },
        Agent {
            id: "gemini".into(),
            display_name: "gemini".into(),
            command: "gemini".into(),
            args: vec![],
            icon_id: "gemini".into(),
            color: "#4c8bf5".into(),
            builtin: true,
            disabled: false,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--yolo".into()],
                // gemini's live approval-mode switch — one command per
                // direction (the form exposes both as separate fields).
                runtime_yolo_command: "/approval-mode yolo".into(),
                runtime_default_command: "/approval-mode default".into(),
                // gemini supports `--resume latest` to pick up the most
                // recent session in CWD. Less deterministic than claude's
                // named-session scheme but the best gemini offers today.
                resume_args: vec!["--resume".into(), "latest".into()],
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                "$HOME/.gemini".into(),
                "$HOME/.config/gemini".into(),
                "$HOME/.local/share/gemini".into(),
                "$HOME/.local/state/gemini".into(),
                "$HOME/Library/Application Support/Gemini".into(),
            ],
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
            },
            env: std::collections::HashMap::new(),
            sandbox_allowed_paths: vec![
                "$HOME/.codex".into(),
                "$HOME/.config/codex".into(),
                "$HOME/.local/share/codex".into(),
                "$HOME/.local/state/codex".into(),
                "$HOME/Library/Application Support/Codex".into(),
            ],
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
    // Defensive: ensure no two agents share an id (would break workspace.cli
    // lookups). If duplicates, keep the first occurrence.
    let mut seen = std::collections::HashSet::new();
    s.agents = agents.into_iter().filter(|a| seen.insert(a.id.clone())).collect();
    let f = settings_file().map_err(|e| e.to_string())?;
    fs::write(f, serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredRepo {
    pub path: String,
    pub name: String,
    /// True if this repo is already in projects.json (so the UI can render it
    /// disabled / labeled "added" instead of hiding it — less surprising).
    pub already_added: bool,
}

/// Walk one level under `dir` and return any subdirectory that contains a
/// `.git` entry. One level is intentional: most people keep their repos
/// directly under a single "code" dir, and recursing deeper would scan node
/// modules / nested clones for no reason.
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
    let mut out = Vec::new();
    let rd = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        if !path.join(".git").exists() { continue; }
        let canon = fs::canonicalize(&path).unwrap_or(path.clone());
        let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string();
        let path_str = canon.to_string_lossy().into_owned();
        let already_added = added.contains(&path_str);
        out.push(DiscoveredRepo { path: path_str, name, already_added });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
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
    agents.iter().map(|agent| {
        let bin = agent.command.trim();
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

        CliInfo { name: agent.id.clone(), found, path, version }
    }).collect()
}

// ───────────────────────────── bootstrap ─────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
        .manage(PtyManager::default())
        .setup(|app| {
            // Resolve the user's login-shell PATH off the main thread
            // so the first PTY spawn doesn't wait on shell startup.
            shell_env::warm();
            // Window is created hidden (tauri.conf.json: visible=false). We
            // position it on the cursor's monitor BEFORE showing it, so macOS
            // never sees a window on the primary Space and never triggers a
            // Space switch that would yank the user away from their
            // fullscreen app on another display.
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                // tauri-plugin-window-state restores prior bounds verbatim — it
                // does NOT enforce the minWidth / minHeight from tauri.conf.json.
                // If a previous session somehow saved a sub-minimum size (seen
                // after some updates and after first-launch races with the
                // shown=true → shown=false transition), the window comes back
                // as a postage stamp. Clamp UP here before showing so the user
                // never sees the tiny window. Doing it on physical pixels via
                // inner_size + scale_factor keeps the math correct on retina.
                if let (Ok(sz), scale) = (win.inner_size(), win.scale_factor().unwrap_or(1.0)) {
                    let logical_w = (sz.width  as f64) / scale;
                    let logical_h = (sz.height as f64) / scale;
                    const MIN_W: f64 = 900.0;
                    const MIN_H: f64 = 600.0;
                    if logical_w < MIN_W || logical_h < MIN_H {
                        // Snap back to a comfortable default instead of the bare
                        // min — a 900x600 box is still cramped for the app's
                        // 3-column layout. 1400x900 matches our intended launch
                        // size on fresh installs.
                        let _ = win.set_size(tauri::LogicalSize::new(1400.0_f64, 900.0));
                    }
                }
                let _ = position_on_cursor_monitor(&win);
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects_list, project_add, project_add_multi, project_set_members, project_update, project_remove, project_reorder,
            workspaces_list, workspace_create, workspace_create_multi, workspace_open_repo, workspace_archive, workspace_set_cli, workspace_set_sandbox,
            sandbox_available, sandbox_deny_counts, sandbox_recent_denied_hosts, sandbox_recent_denied_paths, workspace_sandbox_add_allowed_host, workspace_sandbox_add_allowed_path, workspace_sandbox_remove_allowed_path, workspace_recent_denials, workspace_test_sandbox,
            repo_config_load, repo_config_save, repo_config_scaffold, repo_config_add_allowed_host, repo_config_add_allowed_path,
            workspace_delete, workspace_run_script, workspace_run_script_stream, workspace_stop_script, workspace_record_spawn, workspace_set_has_history,
            workspace_diff, workspace_files, workspace_send_diff_to_main,
            workspace_changes, workspace_file_diff, workspace_file_diff_sides, workspace_file_read, workspace_file_write, workspace_dir_list,
            workspace_rename, project_rename,
            pty_spawn, pty_write, pty_resize, pty_kill,
            notify, open_path, home_dir, path_exists, log_line,
            settings_load, settings_save, agents_save, agents_defaults, discover_repos, detect_clis,
            list_monospace_fonts,
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
/// agent processes running.
fn cleanup_children(app: &tauri::AppHandle) {
    use tauri::Manager;
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
}
