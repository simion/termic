//! Config sync: a user's termic setup carried between machines through a
//! private git repo they own. Phase 1 of docs/ideas/config-sync.md: manual
//! ("Sync now", and one pull when the app launches), no background timer and
//! no push on change.
//!
//! The split this module keeps:
//!
//! - **Rust owns git and the files.** One clone per machine at
//!   `global_dir()/sync/`, inside the data dir the Seatbelt profile denies to
//!   caged agents and outside every folder Docker mounts. Export writes each
//!   bound profile's projects, agents and settings into it; apply merges
//!   what a pull brought back into `projects.json` / `settings.json`.
//! - **The window owns localStorage.** Rust cannot read it, so every sync
//!   command takes a snapshot of the registry's "sync" keys from the window
//!   (src/lib/configSync.ts) and hands back the keys a pull changed, which the
//!   window writes and reloads without touching an unchanged one.
//!
//! The order of a sync is the design doc's, and it is load-bearing: export,
//! commit locally, fetch, rebase, apply, push. Committing BEFORE the rebase is
//! what turns "both machines edited the same field" into a git conflict
//! instead of a silent overwrite by whichever side exported last.
//!
//! Field classification lives here too (`PROJECT_SYNC` and friends): every
//! serialized field of `Project`, `ProjectMember`, `Settings` and `Agent` is
//! in exactly one list, and a test fails on a field in neither. A field only
//! ever crosses the wire if its name is in a SYNC list, in both directions:
//! export picks those keys, and apply ignores any other key a file carries,
//! so a hand-edited repo cannot inject `env` or `root_path`.

use crate::profiles::ProfileId;
use crate::{Agent, Project, ProjectMember, ProjectType, ScratchRecord, Settings};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

// ───────────────────────────── classification ─────────────────────────────
//
// JSON key names (as serde writes them), not Rust field names: `project_type`
// is "type" on disk. Every list is checked against a fully populated
// serialized instance by `classification_covers_every_field`.

/// Project fields that follow the user. See docs/ideas/config-sync.md, "What
/// syncs and what never does", for the rule: anything naming a path, a
/// binary, a port range, a hardware fact or a credential stays local.
pub(crate) const PROJECT_SYNC: &[&str] = &[
    "id", "name", "group", "base_branch", "preview_url", "files_to_copy",
    "setup_script", "run_script", "archive_script", "run_scripts", "default_cli",
    // Safety defaults: they sync, and any change to one is shown before or as
    // it applies (`SAFETY_PROJECT`).
    "default_sandbox", "default_sandbox_mode", "default_docker", "default_yolo",
    "sandbox_allowed_hosts", "extra_named_ports", "on_pr_merge",
    "watch_pr_comments", "watch_untrusted_comments",
    // Code-intel toggles and settings follow the design table. Which server
    // BINARY runs (`code_intel_servers` / `code_intel_commands`) does not.
    "code_intel_auto", "code_intel_languages", "code_intel_settings",
    "spotlight_enabled",
    // Kind of project, not a fact about this machine's folder: a plain-folder
    // project is plain everywhere, and the waiting-list rule depends on it.
    "type", "non_git", "members", "customization_mode",
];

// Read only by the classification test: export and apply need just SYNC.
#[allow(dead_code)]
pub(crate) const PROJECT_LOCAL: &[&str] = &[
    "root_path", "tasks_path",
    // A remote NAME in this clone, not a URL. The URL travels separately as
    // `remote_url` (see `project_doc`).
    "remote",
    "preview_browser", "sandbox_rw_paths", "docker_extra_mounts",
    "code_intel_servers", "code_intel_commands",
    // When THIS machine registered the project.
    "created",
    // Names a role, and roles are local (see SETTINGS_LOCAL).
    "default_role",
];

pub(crate) const MEMBER_SYNC: &[&str] = &[
    "name", "non_git", "base_branch", "setup_script", "run_script",
    "archive_script", "files_to_copy", "sandbox_allowed_hosts",
];

// Read only by the classification test: export and apply need just SYNC.
#[allow(dead_code)]
pub(crate) const MEMBER_LOCAL: &[&str] = &[
    "root_path", "sandbox_rw_paths",
    // Legacy pre-inline reference, migrated away on load and never written.
    "project_id",
];

pub(crate) const SETTINGS_SYNC: &[&str] = &[
    // Exported one file per agent, not inside settings.json.
    "agents",
    "sandbox_default_allowed_hosts", "docker_rebuild_frequency",
    "docker_rebuild_auto", "file_tree_exclude", "fetch_before_create",
    "close_action", "tray_enabled", "auto_install_hooks", "customizations_enabled",
    // Repo-relative names (`.claude`, `.mcp.json`), the same on every machine.
    "worktree_symlink_paths",
];

// Read only by the classification test: export and apply need just SYNC.
#[allow(dead_code)]
pub(crate) const SETTINGS_LOCAL: &[&str] = &[
    "repos_dir", "default_tasks_path", "preview_browser",
    "task_port_min", "task_port_max",
    "sandbox_default_rw_paths",
    // Docker: whether it is switched on follows whether Docker is installed
    // HERE, and every other entry names a host path or a home-relative dir.
    "docker_sandbox_enabled", "docker_agent_extra_dirs",
    "docker_agent_persist_enabled", "docker_default_extra_mounts",
    "docker_shared_config_dirs",
    "discovery_dismissed",
    // CLI and MCP install state, one-time migration markers.
    "cli_enabled", "cli_default_migrated", "hooks_auto_default_migrated",
    "cli_user_link_installed", "mcp_enabled", "mcp_bind_address", "mcp_port",
    // Opening this machine to its network is a decision about THIS machine
    // and THIS network; a synced `true` would switch sharing on somewhere
    // nobody chose to.
    "lan_sharing_enabled",
    "welcomed", "schema_version",
    // This module's own per-profile state.
    "sync",
    // Secrets point at Keychain items, which exist per machine (another Mac
    // may have a different gh login or none). Roles name secret ids, so a
    // role synced without its secrets would fail `secrets::validate` on
    // arrival and block every settings save there. Both stay local in v1;
    // syncing them is a later call, and would belong in the SAFETY lists.
    "secrets", "roles",
    // Names THIS machine's environment, which another Mac does not share.
    "env_guard",
];

pub(crate) const AGENT_SYNC: &[&str] = &[
    "id", "display_name", "command", "args", "icon_id", "color", "kind",
    "capabilities", "sandbox_allowed_hosts", "work_done", "extends",
    "post_launch_capture",
    // Account NAMES only. The login each one names lives in `logins/`, which
    // never syncs; on another machine the account shows as not signed in.
    "accounts", "default_account", "auto_switch_account",
];

// Read only by the classification test: export and apply need just SYNC.
#[allow(dead_code)]
pub(crate) const AGENT_LOCAL: &[&str] = &[
    // Never. These are where people put API keys.
    "env", "docker_env",
    // Names env vars THIS machine has (see env_guard in SETTINGS_LOCAL).
    "pass_env",
    // The login that already existed on THIS machine.
    "adopted_account",
    // Often hides a CLI that is not installed here.
    "disabled",
    "sandbox_allowed_paths",
    // Derived from this build's built-in list, not a user choice.
    "builtin",
    // Names a role, and roles are local (see SETTINGS_LOCAL).
    "default_role",
];

/// Project fields whose change is shown before or as it applies: they can
/// switch approvals off or a cage off on this machine.
pub(crate) const SAFETY_PROJECT: &[&str] =
    &["default_yolo", "default_sandbox", "default_sandbox_mode", "default_docker"];

/// The app-wide prefs with the same weight (src/lib/prefsRegistry.ts).
pub(crate) const SAFETY_PREFS: &[&str] =
    &["defaultYolo", "globalDefaultSandboxKind", "sandboxBypassPermissions", "sandboxAllowScope"];

/// Keys a project or member file carries for matching on another machine.
/// Written by export, never applied as fields.
const LOCATION_KEYS: &[&str] = &["remote_url", "subdir", "position"];

// ───────────────────────────── local state ─────────────────────────────

/// Per-profile sync state, kept in that profile's `settings.json` (field
/// `sync`, classified local). Absent from the file until the profile first
/// connects, so an install that never syncs keeps byte-identical settings.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct SyncLocal {
    /// Binds this profile to `profiles/<sync_id>/` in the repo. Chosen at
    /// first connect: a folder another machine made, or a new one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_id: Option<String>,
    /// Project ids (sync ids) this machine will not register: skipped from
    /// the waiting list, or removed here.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<String>,
    /// Removals made here whose tombstone has not reached the remote yet.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<Tombstone>,
    /// Tombstones the user answered Keep for, to be cleared on the remote.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub kept: Vec<String>,
    /// Sync id -> local project id, for a project that was already
    /// registered here under its own id when the same repo arrived from
    /// another machine. The local id never changes (tasks reference it); only
    /// the file it syncs through does.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub aliases: BTreeMap<String, String>,
    /// The user stopped syncing this profile (Disconnect while others stay
    /// connected). Every other unbound profile is uploaded on the next sync
    /// (`adopt_profiles`), so the answer has to be remembered or it would be
    /// undone at the next launch. Cleared when the profile connects again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub opted_out: bool,
}

impl SyncLocal {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// The id a local project syncs under.
    fn sync_id_of(&self, local_id: &str) -> String {
        self.aliases
            .iter()
            .find(|(_, l)| l.as_str() == local_id)
            .map(|(s, _)| s.clone())
            .unwrap_or_else(|| local_id.to_string())
    }

    /// The local project id a sync id refers to.
    fn local_id_of<'a>(&'a self, sync_id: &'a str) -> &'a str {
        self.aliases.get(sync_id).map(String::as_str).unwrap_or(sync_id)
    }
}

/// One entry of `removed.json`.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Tombstone {
    pub id: String,
    pub name: String,
    pub machine: String,
    pub at: String,
}

/// Machine-wide state beside the clone, never committed.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SyncState {
    pub last_sync_at: Option<String>,
    /// When a run last started, including one that failed. A failure leaves
    /// `last_sync_at` alone, so the focus pull gates on this too: otherwise an
    /// offline machine would fetch on every focus.
    pub last_pull_at: Option<String>,
    pub last_error: Option<String>,
    /// Repo paths a rebase stopped on. The rebase was aborted and local kept.
    pub conflicts: Vec<String>,
    /// Per conflicting path: "local" (keep this machine's) or "remote".
    pub choices: BTreeMap<String, String>,
    /// Safety-default changes a pull applied, until dismissed. Kept here, not
    /// only in the result, so a profile whose window was closed during the
    /// pull still sees them when it opens.
    pub notices: Vec<Change>,
    /// Repo folders this machine will not create a profile for: the profile
    /// that followed one was deleted here. Every other unbound folder becomes
    /// a local profile on the next sync, so without this a deleted profile
    /// would come straight back. Undone from Settings > Sync.
    pub ignored_folders: Vec<String>,
}

// ───────────────────────────── paths ─────────────────────────────

pub(crate) fn sync_dir() -> Result<PathBuf, String> {
    Ok(crate::global_dir().map_err(|e| e.to_string())?.join("sync"))
}

fn state_file() -> Result<PathBuf, String> {
    Ok(crate::global_dir().map_err(|e| e.to_string())?.join("sync-state.json"))
}

pub(crate) fn load_state() -> SyncState {
    state_file()
        .ok()
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(s: &SyncState) {
    if let Ok(f) = state_file() {
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = crate::write_atomic(&f, json.as_bytes());
        }
    }
}

fn is_connected(clone: &Path) -> bool {
    clone.join(".git").exists()
}

/// The localStorage namespace of a profile's window, mirroring
/// src/lib/profileScope.ts: the root profile's window is `main` and its keys
/// are bare; every other window is `profile-<slug>` and prefixes them.
pub(crate) fn profile_ns(id: &ProfileId) -> String {
    match id {
        ProfileId::Root => String::new(),
        ProfileId::Slug(s) => format!("profile-{s}:"),
    }
}

fn profile_display_name(id: &ProfileId) -> String {
    let reg = crate::profiles_registry();
    let slug = match id {
        ProfileId::Root => reg.root_slug.clone(),
        ProfileId::Slug(s) => Some(s.clone()),
    };
    slug.and_then(|s| reg.get(&s).map(|p| p.name.clone()))
        .unwrap_or_else(|| "Default".to_string())
}

/// The colour a profile is drawn in, as the registry stores it (an accent key
/// or a hex). `None` while profiles are dormant: there is no colour to carry.
fn profile_accent(id: &ProfileId) -> Option<String> {
    let reg = crate::profiles_registry();
    let slug = match id {
        ProfileId::Root => reg.root_slug.clone(),
        ProfileId::Slug(s) => Some(s.clone()),
    };
    slug.and_then(|s| reg.get(&s).map(|p| p.accent.clone()))
}

/// The folder name a profile gets when it is first uploaded: its SLUG, the
/// name its data already has on this machine's disk, de-duplicated against
/// the folders the repo holds. It was 12 random hex characters, which made
/// the repo unreadable and told nobody which profile `09a90dc7d04e` was.
///
/// Only a NAME for a new folder, never the identity: the binding stays in
/// `SyncLocal::sync_id`, because slugs are minted per machine (the same
/// profile can be `work` here and `nexttech` there) and the root profile may
/// have none.
pub(crate) fn new_folder_id(id: &ProfileId, taken: &BTreeSet<String>) -> String {
    let reg = crate::profiles_registry();
    let base = match id {
        ProfileId::Root => reg.root_slug.clone(),
        ProfileId::Slug(s) => Some(s.clone()),
    }
    .map(|s| safe_file_stem(&s))
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "default".to_string());
    if !taken.contains(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|c| !taken.contains(c)).unwrap()
}

/// Every profile with a sync id, with that id.
pub(crate) fn bound_profiles() -> Vec<(ProfileId, String)> {
    crate::profiles_registry()
        .ids()
        .into_iter()
        .filter_map(|id| {
            let sid = crate::load_settings_in(&id).sync.sync_id;
            sid.map(|s| (id, s))
        })
        .collect()
}

// ───────────────────────────── machine name ─────────────────────────────

/// A human name for this machine, for commit messages and "removed on X".
/// macOS: the Sharing name ("Alice's MacBook"), which is what the user calls
/// it; elsewhere the hostname. Read once.
pub(crate) fn machine_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            if let Ok(out) = crate::proc_ctl::command("scutil").args(["--get", "ComputerName"]).output() {
                let n = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if out.status.success() && !n.is_empty() {
                    return n;
                }
            }
        }
        #[cfg(windows)]
        {
            if let Ok(n) = std::env::var("COMPUTERNAME") {
                if !n.trim().is_empty() {
                    return n.trim().to_string();
                }
            }
        }
        #[cfg(unix)]
        {
            let mut buf = [0u8; 256];
            // SAFETY: gethostname writes at most buf.len() bytes into buf.
            let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
            if rc == 0 {
                let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                let n = String::from_utf8_lossy(&buf[..end]).trim().to_string();
                if !n.is_empty() {
                    return n;
                }
            }
        }
        "another machine".to_string()
    })
    .clone()
}

// ───────────────────────────── deterministic JSON ─────────────────────────────

/// Sort every object's keys, recursively. `serde_json` is built with
/// `preserve_order` here, so a `Value` keeps struct order (and a HashMap's
/// arbitrary order) unless something sorts it.
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for k in keys {
                out.insert(k.clone(), canonical(&m[k]));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The bytes a sync file holds: sorted keys, pretty-printed, trailing
/// newline. One changed field is then one changed line, which is what lets
/// git merge two machines' edits to different fields of one record.
pub(crate) fn file_bytes(v: &Value) -> Vec<u8> {
    let mut s = serde_json::to_string_pretty(&canonical(v)).unwrap_or_else(|_| "null".into());
    s.push('\n');
    s.into_bytes()
}

fn pick(v: &Value, keys: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(m) = v {
        for k in keys {
            if let Some(x) = m.get(*k) {
                out.insert((*k).to_string(), x.clone());
            }
        }
    }
    out
}

/// Where a project's repo is, in terms another machine can match.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RepoLoc {
    pub remote_url: Option<String>,
    /// The project's path below the repo root, `/`-separated. Empty at root.
    pub subdir: String,
}

pub(crate) fn project_doc(
    p: &Project,
    position: u64,
    loc: Option<&RepoLoc>,
    member_loc: &dyn Fn(&ProjectMember) -> Option<RepoLoc>,
) -> Value {
    let full = serde_json::to_value(p).unwrap_or(Value::Null);
    let mut doc = pick(&full, PROJECT_SYNC);
    let members: Vec<Value> = p
        .members
        .iter()
        .map(|m| {
            let mv = serde_json::to_value(m).unwrap_or(Value::Null);
            let mut md = pick(&mv, MEMBER_SYNC);
            if let Some(l) = member_loc(m) {
                put_loc(&mut md, &l);
            }
            Value::Object(md)
        })
        .collect();
    doc.insert("members".into(), Value::Array(members));
    doc.insert("position".into(), Value::from(position));
    if let Some(l) = loc {
        put_loc(&mut doc, l);
    }
    Value::Object(doc)
}

fn put_loc(m: &mut Map<String, Value>, l: &RepoLoc) {
    if let Some(u) = &l.remote_url {
        m.insert("remote_url".into(), Value::String(u.clone()));
    }
    if !l.subdir.is_empty() {
        m.insert("subdir".into(), Value::String(l.subdir.clone()));
    }
}

pub(crate) fn agent_doc(a: &Agent) -> Value {
    Value::Object(pick(&serde_json::to_value(a).unwrap_or(Value::Null), AGENT_SYNC))
}

pub(crate) fn settings_doc(s: &Settings) -> Value {
    let keys: Vec<&str> = SETTINGS_SYNC.iter().copied().filter(|k| *k != "agents").collect();
    Value::Object(pick(&serde_json::to_value(s).unwrap_or(Value::Null), &keys))
}

// ───────────────────────────── remote URLs ─────────────────────────────

/// One spelling per repo, so `git@host:o/r.git`, `ssh://git@host/o/r` and
/// `https://host/o/r` compare equal.
pub(crate) fn normalize_remote_url(url: &str) -> String {
    let u = url.trim();
    let has_scheme = u.contains("://");
    let mut rest = match u.find("://") {
        Some(i) => u[i + 3..].to_string(),
        None => u.to_string(),
    };
    // user@ (only before the first slash: a path can hold an @)
    if let Some(i) = rest.find('@') {
        if !rest[..i].contains('/') {
            rest = rest[i + 1..].to_string();
        }
    }
    if !has_scheme {
        // scp-like `host:owner/repo`
        if let Some(i) = rest.find(':') {
            if !rest[..i].contains('/') {
                rest = format!("{}/{}", &rest[..i], &rest[i + 1..]);
            }
        }
    }
    let s = rest.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s).trim_end_matches('/');
    match s.split_once('/') {
        Some((host, path)) => {
            // Drop a port: `host:22`.
            let host = match host.rsplit_once(':') {
                Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => h,
                _ => host,
            };
            format!("{}/{}", host.to_lowercase(), path)
        }
        None => s.to_lowercase(),
    }
}

/// The remote URL and repo-relative subdir of a checkout, if it is a git repo.
pub(crate) fn repo_location(path: &str, remote: &str) -> Option<RepoLoc> {
    let p = Path::new(path);
    if !p.is_dir() {
        return None;
    }
    let top = crate::git(&["rev-parse", "--show-toplevel"], p).ok()?;
    let top = PathBuf::from(top.trim());
    let canon = dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let top_c = dunce::canonicalize(&top).unwrap_or(top);
    let subdir = canon
        .strip_prefix(&top_c)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let remote = if remote.is_empty() { crate::detect_default_remote(p) } else { remote.to_string() };
    let url = crate::git(&["remote", "get-url", &remote], p)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some(RepoLoc { remote_url: url, subdir })
}

/// Every remote URL of a repo, with the remote's name.
fn repo_remotes(path: &Path) -> Vec<(String, String)> {
    let out = crate::git(&["remote", "-v"], path).unwrap_or_default();
    let mut seen = BTreeSet::new();
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let name = it.next()?;
            let url = it.next()?;
            seen.insert((name.to_string(), url.to_string())).then(|| (name.to_string(), url.to_string()))
        })
        .collect()
}

// ───────────────────────────── bounded git ─────────────────────────────

/// A network git op (clone, fetch, push), bounded the way `guarded_fetch` is:
/// no credential prompt, batch-mode SSH with a short connect timeout, and a
/// wall-clock deadline that kills the child's process group.
///
/// Unlike `guarded_fetch` it does not sleep-poll `try_wait` (docs/
/// performance.md, bear trap 9): a waiter thread blocks on `wait()` and the
/// caller blocks on a channel with a timeout, the pattern automation.rs and
/// agent_usage.rs already use.
pub(crate) fn git_bounded(args: &[&str], cwd: &Path, timeout: Duration) -> Result<String, String> {
    use std::io::Read;
    let desc = format!("git {}", args.first().copied().unwrap_or(""));
    let mut cmd = crate::git_command();
    // Defence in depth under `check_repo_url`: whatever the user's global
    // config allows, no network op here runs a command as its transport or
    // talks over an inherited descriptor. A later `-c` in `args` still wins.
    cmd.args(["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never"]);
    cmd.args(args).current_dir(cwd);
    let (path, inject) = crate::shell_env::spawn_env();
    cmd.env("PATH", path);
    for (k, v) in inject {
        cmd.env(k, v);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=10");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::proc_ctl::new_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("{desc}: {e}"))?;
    let pid = child.id() as i32;
    // Drain both pipes on their own threads: a chatty remote would otherwise
    // fill a pipe, block the child, and turn a real error into a timeout.
    let read = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out_h = child.stdout.take().map(|s| read(Box::new(s)));
    let err_h = child.stderr.take().map(|s| read(Box::new(s)));
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    let join = |h: Option<std::thread::JoinHandle<String>>| h.and_then(|h| h.join().ok()).unwrap_or_default();
    match rx.recv_timeout(timeout) {
        Ok(Ok(status)) => {
            let out = join(out_h);
            let err = join(err_h);
            if status.success() {
                Ok(out)
            } else {
                let e = err.trim();
                Err(if e.is_empty() { format!("{desc} failed ({status})") } else { format!("{desc} failed: {e}") })
            }
        }
        Ok(Err(e)) => Err(format!("{desc}: {e}")),
        Err(_) => {
            crate::proc_ctl::signal_group(pid, crate::proc_ctl::Sig::Kill);
            let _ = rx.recv();
            let err = join(err_h);
            let _ = join(out_h);
            let e = err.trim();
            Err(if e.is_empty() { format!("{desc} timed out") } else { format!("{desc} timed out: {e}") })
        }
    }
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const PUSH_TIMEOUT: Duration = Duration::from_secs(60);
const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// A local git op in the clone. Hooks and signing are off in the clone's own
/// config; passed again here so a hand-edited config cannot bring them back
/// and hang a commit on a pinentry prompt.
fn g(clone: &Path, args: &[&str]) -> Result<String, String> {
    let hooks = clone.join(".git").join("termic-no-hooks");
    let hooks = format!("core.hooksPath={}", hooks.to_string_lossy());
    let mut full: Vec<&str> = vec!["-c", &hooks, "-c", "commit.gpgsign=false", "-c", "core.editor=true"];
    full.extend_from_slice(args);
    crate::git(&full, clone).map_err(|e| format!("{e:#}"))
}

fn rev_parse(clone: &Path, rev: &str) -> Option<String> {
    g(clone, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn is_ancestor(clone: &Path, a: &str, b: &str) -> bool {
    g(clone, &["merge-base", "--is-ancestor", a, b]).is_ok()
}

/// The commit identity the clone commits as. Fixed and set in the clone's
/// own config, never inherited: a global personal address with GitHub's
/// "block command line pushes that expose my email" fails every push with
/// GH007, and nobody would see why.
const SYNC_USER: &str = "termic";
const SYNC_EMAIL: &str = "sync@termic.dev";

fn configure_clone(clone: &Path) -> Result<(), String> {
    let hooks = clone.join(".git").join("termic-no-hooks");
    let _ = fs::create_dir_all(&hooks);
    for (k, v) in [
        ("user.name", SYNC_USER.to_string()),
        ("user.email", SYNC_EMAIL.to_string()),
        ("commit.gpgsign", "false".to_string()),
        ("tag.gpgsign", "false".to_string()),
        ("core.hooksPath", hooks.to_string_lossy().into_owned()),
        // JSON line endings stay `\n` on Windows, or every file differs.
        ("core.autocrlf", "false".to_string()),
    ] {
        crate::git(&["config", k, &v], clone).map_err(|e| format!("{e:#}"))?;
    }
    Ok(())
}

/// The branch the clone tracks, checking one out when the clone has none.
///
/// A bare repo whose HEAD names a branch nobody pushed (the first push went to
/// `main`, the bare repo's HEAD says `master`) clones with nothing checked
/// out. An empty repo clones onto an unborn branch, which becomes `main`.
fn ensure_branch(clone: &Path) -> Result<String, String> {
    if let Ok(b) = g(clone, &["symbolic-ref", "--short", "HEAD"]) {
        let b = b.trim().to_string();
        if rev_parse(clone, "HEAD").is_some() {
            return Ok(b);
        }
    }
    let remotes = g(clone, &["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).unwrap_or_default();
    let branches: Vec<String> = remotes
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && *l != "origin/HEAD" && *l != "origin")
        .filter_map(|l| l.strip_prefix("origin/").map(str::to_string))
        .collect();
    let pick = ["main", "master"]
        .iter()
        .find(|b| branches.iter().any(|x| x == *b))
        .map(|b| b.to_string())
        .or_else(|| branches.first().cloned());
    match pick {
        Some(b) => {
            g(clone, &["checkout", "-B", &b, &format!("origin/{b}")])?;
            let _ = g(clone, &["branch", "--set-upstream-to", &format!("origin/{b}"), &b]);
            Ok(b)
        }
        None => {
            g(clone, &["symbolic-ref", "HEAD", "refs/heads/main"])?;
            Ok("main".into())
        }
    }
}

fn current_branch(clone: &Path) -> Result<String, String> {
    g(clone, &["symbolic-ref", "--short", "HEAD"]).map(|s| s.trim().to_string())
}

fn origin_url(clone: &Path) -> Option<String> {
    g(clone, &["remote", "get-url", "origin"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Paths changed between two commits (`a` None: every file in `b`).
fn changed_paths(clone: &Path, a: Option<&str>, b: &str) -> Result<Vec<String>, String> {
    let out = match a {
        Some(a) => g(clone, &["diff", "--name-only", "-z", a, b, "--"])?,
        None => g(clone, &["ls-tree", "-r", "--name-only", "-z", b])?,
    };
    Ok(out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

fn list_files(clone: &Path, rev: &str, prefix: &str) -> Vec<String> {
    g(clone, &["ls-tree", "-r", "--name-only", "-z", rev, "--", prefix])
        .map(|o| o.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

#[cfg(unix)]
fn read_git_file_mode(clone: &Path, rev: &str, path: &str) -> Option<u32> {
    let out = g(clone, &["ls-tree", rev, path]).ok()?;
    let line = out.lines().next()?;
    let mode_str = line.split_whitespace().next()?;
    u32::from_str_radix(mode_str, 8).ok()
}

/// Read many files at one rev with a single `git cat-file --batch`.
fn read_at(clone: &Path, rev: &str, paths: &[String]) -> HashMap<String, Option<Vec<u8>>> {
    use std::io::{Read, Write};
    let mut out = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    let mut cmd = crate::git_command();
    cmd.args(["cat-file", "--batch"]).current_dir(clone);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return out };
    let input: String = paths.iter().map(|p| format!("{rev}:{p}\n")).collect();
    let mut stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(s) = stdin.as_mut() {
            let _ = s.write_all(input.as_bytes());
        }
        drop(stdin);
    });
    let mut buf = Vec::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_end(&mut buf);
    }
    let _ = writer.join();
    let _ = child.wait();
    let mut i = 0usize;
    for p in paths {
        let Some(nl) = buf[i..].iter().position(|&b| b == b'\n') else { break };
        let header = String::from_utf8_lossy(&buf[i..i + nl]).into_owned();
        i += nl + 1;
        if header.ends_with(" missing") || header.ends_with(" ambiguous") {
            out.insert(p.clone(), None);
            continue;
        }
        let size: usize = header.rsplit(' ').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let end = (i + size).min(buf.len());
        out.insert(p.clone(), Some(buf[i..end].to_vec()));
        i = end + 1;
    }
    out
}

fn parse_obj(bytes: Option<&Vec<u8>>) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(bytes?).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

/// A file name for an agent id. Agent ids are slugs today; anything that
/// could leave the folder is hex-escaped rather than trusted.
fn safe_file_stem(id: &str) -> String {
    let ok = !id.is_empty() && id != "." && id != ".." && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if ok {
        id.to_string()
    } else {
        id.bytes().map(|b| format!("{b:02x}")).collect::<String>()
    }
}

// ───────────────────────────── changes ─────────────────────────────

/// One line of a preview or a sync report.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Change {
    /// "project" | "agent" | "settings" | "pref" | "theme" | "profile"
    pub kind: String,
    /// What it is about: a project or agent name, a pref key, a theme file.
    pub target: String,
    /// "update" | "add" | "remove" | "wait" | "upload" (a profile's only)
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<Value>,
    /// A YOLO or sandbox default. Shown highlighted, before or as it applies.
    pub safety: bool,
    /// The profile's sync id; `None` for machine-wide prefs and themes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct PrefChange {
    pub key: String,
    /// `None`: remove the key, which reads as the default.
    pub value: Option<String>,
}

/// The window's localStorage, sync keys only (src/lib/configSync.ts).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PrefsSnapshot {
    /// Keys every window shares (not `scoped()`), machine-wide.
    pub shared: BTreeMap<String, String>,
    /// Profile-scoped keys, by the profile's namespace (`profile_ns`).
    pub scoped: BTreeMap<String, BTreeMap<String, String>>,
}

/// Prefs a pull changed, for the window to write.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PrefsChanges {
    pub shared: Vec<PrefChange>,
    pub scoped: BTreeMap<String, Vec<PrefChange>>,
}

impl PrefsChanges {
    fn is_empty(&self) -> bool {
        self.shared.is_empty() && self.scoped.values().all(|v| v.is_empty())
    }
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct SyncRunResult {
    pub ok: bool,
    /// Nothing ran: not connected, no profile bound, the launch pull already
    /// happened in this process, or a focus pull that was not due.
    pub skipped: bool,
    pub pushed: bool,
    /// Namespaces of the profiles whose projects or settings changed.
    pub changed_profiles: Vec<String>,
    pub prefs: PrefsChanges,
    pub themes_changed: bool,
    pub scratchpad_changed: bool,
    pub customizations_changed: bool,
    #[serde(skip)]
    pub customization_affected_profiles: Vec<ProfileId>,
    pub changes: Vec<Change>,
    pub conflicts: Vec<String>,
    pub error: Option<String>,
    /// A profile was created here from the repo: every window's profile list
    /// and the tray menu are stale until told.
    pub profiles_changed: bool,
}

// ───────────────────────────── apply (pure parts) ─────────────────────────────

/// Keys whose value differs between two docs. Absent and `null` are equal.
/// `base` None (a first connect): every key `new` sets to something.
fn changed_keys(base: Option<&Map<String, Value>>, new: &Map<String, Value>) -> Vec<String> {
    let empty = Map::new();
    let base = base.unwrap_or(&empty);
    let mut keys: BTreeSet<&String> = base.keys().collect();
    keys.extend(new.keys());
    keys.into_iter()
        .filter(|k| base.get(*k).unwrap_or(&Value::Null) != new.get(*k).unwrap_or(&Value::Null))
        .cloned()
        .collect()
}

/// Write `keys` from `new` into `local` (absent in `new`: remove), limited to
/// `allowed`. The allow-list is what keeps a hand-edited file from setting a
/// local field like `env` or `root_path`.
fn patch_map(local: &mut Map<String, Value>, new: &Map<String, Value>, keys: &[String], allowed: &[&str]) {
    for k in keys {
        if !allowed.contains(&k.as_str()) || LOCATION_KEYS.contains(&k.as_str()) {
            continue;
        }
        match new.get(k) {
            Some(v) => {
                local.insert(k.clone(), v.clone());
            }
            None => {
                local.remove(k);
            }
        }
    }
}

fn field_changes(
    kind: &str,
    target: &str,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    keys: &[&str],
    safety: &[&str],
    profile: Option<&str>,
) -> Vec<Change> {
    keys.iter()
        .filter(|k| before.get(**k).unwrap_or(&Value::Null) != after.get(**k).unwrap_or(&Value::Null))
        .map(|k| Change {
            kind: kind.into(),
            target: target.into(),
            action: "update".into(),
            field: Some((*k).to_string()),
            from: Some(before.get(*k).cloned().unwrap_or(Value::Null)),
            to: Some(after.get(*k).cloned().unwrap_or(Value::Null)),
            safety: safety.contains(k),
            profile: profile.map(str::to_string),
        })
        .collect()
}

fn as_obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Members, three-way by name (a member's name is its folder inside the task
/// wrapper, unique per project). An upstream member with no local match is
/// resolved by remote URL; one that cannot be is left out and reported.
fn merge_members(
    local: &[ProjectMember],
    base: Option<&Vec<Value>>,
    new: &[Value],
    resolve: &dyn Fn(&Map<String, Value>) -> Option<String>,
) -> (Vec<ProjectMember>, Vec<String>) {
    let name_of = |v: &Value| v.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let base_by_name: HashMap<String, Map<String, Value>> = base
        .map(|b| b.iter().map(|v| (name_of(v), as_obj(v.clone()))).collect())
        .unwrap_or_default();
    let new_names: BTreeSet<String> = new.iter().map(name_of).collect();
    let mut out = Vec::new();
    let mut unresolved = Vec::new();
    for nv in new {
        let name = name_of(nv);
        let nm = as_obj(nv.clone());
        if let Some(lm) = local.iter().find(|m| m.name == name) {
            let mut lv = as_obj(serde_json::to_value(lm).unwrap_or(Value::Null));
            let keys = changed_keys(base_by_name.get(&name), &nm);
            patch_map(&mut lv, &nm, &keys, MEMBER_SYNC);
            if let Ok(m) = serde_json::from_value::<ProjectMember>(Value::Object(lv)) {
                out.push(m);
            }
            continue;
        }
        if base_by_name.contains_key(&name) {
            // Removed here since the last sync and still upstream: the local
            // removal stands, and the next export publishes it.
            continue;
        }
        match resolve(&nm) {
            Some(root) => {
                let mut mv = pick(&Value::Object(nm.clone()), MEMBER_SYNC);
                mv.insert("root_path".into(), Value::String(root));
                if let Ok(m) = serde_json::from_value::<ProjectMember>(Value::Object(mv)) {
                    out.push(m);
                }
            }
            None => unresolved.push(name),
        }
    }
    // Local members upstream never had: added here, kept. Ones upstream had
    // and dropped: removed there, removed here too.
    for lm in local {
        if new_names.contains(&lm.name) {
            continue;
        }
        if base_by_name.contains_key(&lm.name) {
            continue;
        }
        out.push(lm.clone());
    }
    (out, unresolved)
}

/// Apply one upstream project file to an already-registered project.
/// Returns the field changes made.
fn patch_project(
    p: &mut Project,
    base: Option<&Map<String, Value>>,
    new: &Map<String, Value>,
    resolve_member: &dyn Fn(&Map<String, Value>) -> Option<String>,
    profile: Option<&str>,
) -> Vec<Change> {
    let before = as_obj(serde_json::to_value(&*p).unwrap_or(Value::Null));
    let mut lv = before.clone();
    let keys = changed_keys(base, new);
    let plain: Vec<String> = keys.iter().filter(|k| k.as_str() != "members").cloned().collect();
    patch_map(&mut lv, new, &plain, PROJECT_SYNC);
    let profile_tag = p.profile.clone();
    let mut members_changed = false;
    if keys.iter().any(|k| k == "members") {
        let empty = Vec::new();
        let new_members = new.get("members").and_then(Value::as_array).unwrap_or(&empty);
        let base_members = base.and_then(|b| b.get("members")).and_then(Value::as_array);
        let (merged, _unresolved) = merge_members(&p.members, base_members, new_members, resolve_member);
        let mv = serde_json::to_value(&merged).unwrap_or(Value::Array(vec![]));
        members_changed = lv.get("members") != Some(&mv);
        lv.insert("members".into(), mv);
    }
    let Ok(mut next) = serde_json::from_value::<Project>(Value::Object(lv.clone())) else {
        return Vec::new();
    };
    next.profile = profile_tag;
    let after = as_obj(serde_json::to_value(&next).unwrap_or(Value::Null));
    let scalar: Vec<&str> = PROJECT_SYNC.iter().copied().filter(|k| *k != "members").collect();
    let mut changes = field_changes("project", &next.name, &before, &after, &scalar, SAFETY_PROJECT, profile);
    if members_changed {
        changes.push(Change {
            kind: "project".into(),
            target: next.name.clone(),
            action: "update".into(),
            field: Some("members".into()),
            profile: profile.map(str::to_string),
            ..Default::default()
        });
    }
    *p = next;
    changes
}

/// A new local Project from an upstream file and the folder it lives in here.
fn project_from_doc(doc: &Map<String, Value>, root: &Path, profile: &ProfileId, remote: &str) -> Option<Project> {
    let mut v = pick(&Value::Object(doc.clone()), PROJECT_SYNC);
    v.insert("members".into(), Value::Array(vec![]));
    let mut p: Project = serde_json::from_value(Value::Object(v)).ok()?;
    p.root_path = root.to_string_lossy().into_owned();
    p.remote = remote.to_string();
    p.created = chrono::Utc::now().to_rfc3339();
    p.profile = profile.clone();
    Some(p)
}

/// Prefs a file change brings, minus the ones the window already holds.
fn pref_changes(
    base: Option<&Map<String, Value>>,
    new: &Map<String, Value>,
    have: Option<&BTreeMap<String, String>>,
) -> Vec<PrefChange> {
    changed_keys(base, new)
        .into_iter()
        .filter_map(|k| {
            let value = new.get(&k).and_then(Value::as_str).map(str::to_string);
            if let Some(have) = have {
                if have.get(&k) == value.as_ref() {
                    return None;
                }
            }
            Some(PrefChange { key: k, value })
        })
        .collect()
}

fn prefs_doc(m: &BTreeMap<String, String>) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
}

// ───────────────────────────── export ─────────────────────────────

const README: &str = "# termic config sync\n\n\
This repo holds a termic setup, written by termic's Settings > Sync.\n\
termic rewrites these files on every sync, so an edit made here by hand\n\
can be overwritten.\n\n\
Never synced: agent environment variables (env and Docker env), paths,\n\
port ranges, logins and tokens. Those stay on each machine.\n";

fn read_tombstones(path: &Path) -> BTreeMap<String, Tombstone> {
    let m: BTreeMap<String, Tombstone> = fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    m.into_iter().map(|(id, mut t)| { t.id = id.clone(); (id, t) }).collect()
}

fn tombstones_doc(m: &BTreeMap<String, Tombstone>) -> Value {
    Value::Object(
        m.iter()
            .map(|(id, t)| {
                (
                    id.clone(),
                    serde_json::json!({ "at": t.at, "machine": t.machine, "name": t.name }),
                )
            })
            .collect(),
    )
}

/// Position numbers that change as few files as possible: a project keeps
/// the position its file already holds while that still sorts it after the
/// one before it. Removing a project then rewrites no other file, and moving
/// one rewrites only the files that had to move.
fn assign_positions(order: &[String], existing: &HashMap<String, u64>) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    let mut last: Option<u64> = None;
    for id in order {
        let next = match (existing.get(id), last) {
            (Some(&p), None) => p,
            (Some(&p), Some(l)) if p > l => p,
            (_, None) => 0,
            (_, Some(l)) => l + 1,
        };
        out.insert(id.clone(), next);
        last = Some(next);
    }
    out
}

/// Two machines spell one remote differently (`git@host:o/r` here, `https://
/// host/o/r` there). Keeping whichever spelling the file already has stops
/// each machine's export from rewriting the line the other one wrote, which
/// is churn on every sync and a conflict with any edit to the line beside it.
fn keep_spelling(mut l: RepoLoc, old: Option<RepoLoc>) -> RepoLoc {
    if let (Some(new), Some(old)) = (&l.remote_url, old.and_then(|o| o.remote_url)) {
        if normalize_remote_url(new) == normalize_remote_url(&old) {
            l.remote_url = Some(old);
        }
    }
    l
}

/// Lookup used by export for a project's and a member's location. Injected
/// so tests do not need real repos for every record.
pub(crate) type Locate<'a> = &'a dyn Fn(&str, &str) -> Option<RepoLoc>;

pub(crate) fn export_profile(
    clone: &Path,
    id: &ProfileId,
    sync_id: &str,
    prefs: Option<&BTreeMap<String, String>>,
    locate: Locate,
) -> Result<(), String> {
    let dir = clone.join("profiles").join(sync_id);
    let settings = crate::load_settings_in(id);
    let projects = crate::load_projects_in(id);
    let sl = &settings.sync;

    // Tombstones: the outbox first, then Keep answers.
    let removed_path = dir.join("removed.json");
    let mut tombs = read_tombstones(&removed_path);
    for t in &sl.removed {
        tombs.entry(t.id.clone()).or_insert_with(|| t.clone());
        let _ = fs::remove_file(dir.join("projects").join(format!("{}.json", safe_file_stem(&t.id))));
    }
    for k in &sl.kept {
        tombs.remove(k);
    }
    if !tombs.is_empty() || removed_path.exists() {
        write_if_changed(&removed_path, &file_bytes(&tombstones_doc(&tombs)))?;
    }

    // Projects.
    let pdir = dir.join("projects");
    let mut existing_pos = HashMap::new();
    let mut existing_doc: HashMap<String, Map<String, Value>> = HashMap::new();
    if let Ok(rd) = fs::read_dir(&pdir) {
        for e in rd.flatten() {
            let Some(stem) = e.path().file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            if let Some(m) = fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(as_obj) {
                if let Some(p) = m.get("position").and_then(Value::as_u64) {
                    existing_pos.insert(stem.clone(), p);
                }
                existing_doc.insert(stem, m);
            }
        }
    }
    let order: Vec<String> = projects.iter().map(|p| sl.sync_id_of(&p.id)).collect();
    let positions = assign_positions(&order, &existing_pos);
    for p in &projects {
        let sid = sl.sync_id_of(&p.id);
        if tombs.contains_key(&sid) && !sl.kept.contains(&sid) {
            // Removed on another machine and not answered yet: publishing it
            // again would be a Keep nobody chose.
            continue;
        }
        let old = existing_doc.get(&safe_file_stem(&sid));
        let old_loc = |m: &Map<String, Value>| RepoLoc {
            remote_url: m.get("remote_url").and_then(Value::as_str).map(str::to_string),
            subdir: m.get("subdir").and_then(Value::as_str).unwrap_or("").to_string(),
        };
        // The folder is gone or unreadable here: keep what the file said.
        let loc = locate(&p.root_path, &p.remote)
            .map(|l| keep_spelling(l, old.map(old_loc)))
            .or_else(|| old.map(old_loc));
        let old_members: HashMap<String, RepoLoc> = old
            .and_then(|m| m.get("members"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| Some((v.get("name")?.as_str()?.to_string(), old_loc(v.as_object()?))))
                    .collect()
            })
            .unwrap_or_default();
        let member_loc = |m: &ProjectMember| {
            if m.non_git {
                return None;
            }
            locate(&m.root_path, "").map(|l| keep_spelling(l, old_members.get(&m.name).cloned()))
        };
        let mut doc = project_doc(p, positions.get(&sid).copied().unwrap_or(0), loc.as_ref(), &member_loc);
        if let Value::Object(m) = &mut doc {
            m.insert("id".into(), Value::String(sid.clone()));
        }
        write_if_changed(&pdir.join(format!("{}.json", safe_file_stem(&sid))), &file_bytes(&doc))?;
    }

    // Agents: the tree is the last synced state, so a file whose agent is not
    // here any more was deleted here.
    let adir = dir.join("agents");
    let mut keep: BTreeSet<String> = BTreeSet::new();
    for a in &settings.agents {
        let stem = safe_file_stem(&a.id);
        write_if_changed(&adir.join(format!("{stem}.json")), &file_bytes(&agent_doc(a)))?;
        keep.insert(stem);
    }
    if let Ok(rd) = fs::read_dir(&adir) {
        for e in rd.flatten() {
            let stem = e.path().file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if !keep.contains(&stem) {
                let _ = fs::remove_file(e.path());
            }
        }
    }

    write_if_changed(&dir.join("settings.json"), &file_bytes(&settings_doc(&settings)))?;
    if let Some(p) = prefs {
        write_if_changed(&dir.join("prefs.json"), &file_bytes(&prefs_doc(p)))?;
    }
    // Name and colour: what another machine needs to create this profile
    // (`adopt_profiles`). Only a machine that HAS a name for it writes them.
    // An install with profiles dormant calls its one profile "Default", and
    // exporting that renamed the folder another machine had named "Personal"
    // on every sync, so here it only fills in a file that does not exist yet.
    let meta_path = dir.join("profile.json");
    match profile_accent(id) {
        Some(accent) => {
            let meta = serde_json::json!({ "name": profile_display_name(id), "accent": accent });
            write_if_changed(&meta_path, &file_bytes(&meta))?;
        }
        None if !meta_path.exists() => {
            write_if_changed(&meta_path, &file_bytes(&serde_json::json!({ "name": profile_display_name(id) })))?;
        }
        None => {}
    }
    export_profile_scratchpad(clone, id, sync_id)?;
    export_project_scratchpads(clone, id, sync_id, sl)?;
    let pdir = crate::profile_dir(id).map_err(|e| e.to_string())?;
    crate::customizations::export_customizations(clone, &pdir, sync_id)?;
    Ok(())
}

fn export_all(
    clone: &Path,
    bound: &[(ProfileId, String)],
    prefs: Option<&PrefsSnapshot>,
    locate: Locate,
) -> Result<(), String> {
    if bound.is_empty() {
        return Ok(());
    }
    let readme = clone.join("README.md");
    if !readme.exists() {
        write_if_changed(&readme, README.as_bytes())?;
    }
    if let Some(p) = prefs {
        write_if_changed(&clone.join("prefs.json"), &file_bytes(&prefs_doc(&p.shared)))?;
    }
    export_themes(clone)?;
    export_global_scratchpad(clone)?;
    for (id, sid) in bound {
        let scoped = prefs.and_then(|p| p.scoped.get(&profile_ns(id)));
        export_profile(clone, id, sid, scoped, locate)?;
    }
    Ok(())
}

fn local_themes_dir() -> Option<PathBuf> {
    crate::themes_dir_path().ok()
}

fn is_theme_file(name: &str) -> bool {
    name.ends_with(".json") && !name.contains('/') && !name.contains('\\') && name != ".json" && !name.starts_with('.')
}

fn export_themes(clone: &Path) -> Result<(), String> {
    let Some(src) = local_themes_dir() else { return Ok(()) };
    let dst = clone.join("themes");
    let mut local: BTreeSet<String> = BTreeSet::new();
    if let Ok(rd) = fs::read_dir(&src) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !is_theme_file(&name) || !e.path().is_file() {
                continue;
            }
            if let Ok(b) = fs::read(e.path()) {
                write_if_changed(&dst.join(&name), &b)?;
                local.insert(name);
            }
        }
    }
    if let Ok(rd) = fs::read_dir(&dst) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_theme_file(&name) && !local.contains(&name) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

fn collect_relative_files(root: &Path, current: &Path, out: &mut Vec<String>) {
    if let Ok(rd) = fs::read_dir(current) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&p) else {
                continue;
            };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                collect_relative_files(root, &p, out);
            } else if meta.is_file() {
                if let Ok(rel) = p.strip_prefix(root) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    out.push(rel_str);
                }
            }
        }
    }
}

fn clean_empty_dirs(dir: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let Ok(meta) = fs::symlink_metadata(&p) else {
                continue;
            };
            if meta.is_dir() && !meta.is_symlink() {
                clean_empty_dirs(&p);
                let _ = fs::remove_dir(&p);
            }
        }
    }
}

fn export_dir_mirror(src: &Path, dst: &Path) -> Result<(), String> {
    export_dir_mirror_except(src, dst, None)
}

fn export_dir_mirror_except(src: &Path, dst: &Path, except_prefix: Option<&str>) -> Result<(), String> {
    let is_except = |rel: &str| -> bool {
        if let Some(exc) = except_prefix {
            rel == exc || rel.starts_with(&format!("{exc}/"))
        } else {
            false
        }
    };

    let mut local_files = Vec::new();
    if src.exists() {
        collect_relative_files(src, src, &mut local_files);
    }
    let local_set: BTreeSet<String> = local_files.into_iter().collect();

    for rel in &local_set {
        if is_except(rel) {
            continue;
        }
        let src_file = src.join(rel);
        let dst_file = dst.join(rel);
        if let Ok(bytes) = fs::read(&src_file) {
            write_if_changed(&dst_file, &bytes)?;
        }
    }

    let mut clone_files = Vec::new();
    if dst.exists() {
        collect_relative_files(dst, dst, &mut clone_files);
    }
    for rel in clone_files {
        if is_except(&rel) {
            continue;
        }
        if !local_set.contains(&rel) {
            let dst_file = dst.join(&rel);
            let _ = fs::remove_file(&dst_file);
        }
    }
    clean_empty_dirs(dst);
    Ok(())
}

fn export_global_scratchpad(clone: &Path) -> Result<(), String> {
    let src = crate::profile_dir(&ProfileId::Root)
        .map_err(|e| e.to_string())?
        .join("scratch")
        .join("global");
    let dst = clone.join("scratch");
    export_dir_mirror(&src, &dst)?;
    clean_empty_dirs(&clone.join("scratch"));
    Ok(())
}

fn export_profile_scratchpad(clone: &Path, id: &ProfileId, sync_id: &str) -> Result<(), String> {
    let src = crate::profile_dir(id)
        .map_err(|e| e.to_string())?
        .join("scratch")
        .join("profile");
    let dst = clone.join("profiles").join(sync_id).join("scratch");
    export_dir_mirror_except(&src, &dst, Some("projects"))?;
    Ok(())
}

fn export_project_scratchpads(
    clone: &Path,
    id: &ProfileId,
    sync_id: &str,
    sl: &SyncLocal,
) -> Result<(), String> {
    let projects = crate::load_projects_in(id);
    let dst_parent = clone.join("profiles").join(sync_id).join("scratch").join("projects");
    let mut active_stems = BTreeSet::new();

    for p in &projects {
        let sid = sl.sync_id_of(&p.id);
        let stem = safe_file_stem(&sid);
        active_stems.insert(stem.clone());

        let local_src = crate::profile_dir(id)
            .map_err(|e| e.to_string())?
            .join("scratch")
            .join("projects")
            .join(&p.id);
        let dst = dst_parent.join(&stem);
        export_dir_mirror(&local_src, &dst)?;
    }

    if dst_parent.exists() {
        if let Ok(rd) = fs::read_dir(&dst_parent) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if e.path().is_dir() && !active_stems.contains(&name) {
                    let _ = fs::remove_dir_all(e.path());
                }
            }
        }
    }
    clean_empty_dirs(&clone.join("profiles").join(sync_id).join("scratch"));
    Ok(())
}

fn merge_scratch_index(local_path: &Path, incoming_bytes: &[u8]) -> Vec<u8> {
    let incoming: Vec<ScratchRecord> = serde_json::from_slice(incoming_bytes).unwrap_or_default();
    let local: Vec<ScratchRecord> = fs::read(local_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();

    if local.is_empty() {
        return incoming_bytes.to_vec();
    }
    if incoming.is_empty() {
        return serde_json::to_vec_pretty(&local).unwrap_or_else(|_| incoming_bytes.to_vec());
    }

    let dir = local_path.parent();
    let mut map: BTreeMap<String, ScratchRecord> = BTreeMap::new();
    for rec in incoming {
        map.insert(rec.id.clone(), rec);
    }
    for rec in local {
        let buf_exists = dir.map(|d| d.join(format!("{}.txt", rec.id)).exists()).unwrap_or(false);
        if buf_exists {
            if let Some(existing) = map.get_mut(&rec.id) {
                if rec.updated_at > existing.updated_at {
                    *existing = rec;
                }
            } else {
                map.insert(rec.id.clone(), rec);
            }
        }
    }
    let mut list: Vec<ScratchRecord> = map.into_values().collect();
    list.sort_by_key(|r| r.order);
    serde_json::to_vec_pretty(&list).unwrap_or_else(|_| incoming_bytes.to_vec())
}

fn commit_if_dirty(clone: &Path, machine: &str) -> Result<bool, String> {
    g(clone, &["add", "-A"])?;
    let clean = g(clone, &["diff", "--cached", "--quiet"]).is_ok();
    if clean {
        return Ok(false);
    }
    g(clone, &["commit", "-q", "-m", &format!("sync from {machine}")])?;
    Ok(true)
}

// ───────────────────────────── apply ─────────────────────────────

/// What an apply needs that is not in the repo: how to find a repo by URL
/// here. Injected for tests.
pub(crate) struct Finder<'a> {
    pub find_repo: &'a dyn Fn(&ProfileId, &str) -> Option<(PathBuf, String)>,
}

/// Find a repo whose remote matches `url`: first among this profile's own
/// projects (for an alias), then under its `repos_dir`.
fn default_find_repo(profile: &ProfileId, url: &str) -> Option<(PathBuf, String)> {
    let want = normalize_remote_url(url);
    let dir = crate::load_settings_in(profile).repos_dir;
    if dir.trim().is_empty() {
        return None;
    }
    let root = PathBuf::from(crate::expand_tilde(&dir));
    let found = crate::discover_repos_inner(&root, &Default::default(), &Default::default()).ok()?;
    for r in found {
        let path = PathBuf::from(&r.path);
        for (name, u) in repo_remotes(&path) {
            if normalize_remote_url(&u) == want {
                return Some((path, name));
            }
        }
    }
    None
}

/// The remote URL + subdir of each registered project, computed once per
/// apply and only when an unregistered upstream project needs it.
fn local_locations(projects: &[Project]) -> Vec<(String, Option<String>, String)> {
    projects
        .iter()
        .filter(|p| !p.non_git)
        .filter_map(|p| repo_location(&p.root_path, &p.remote).map(|l| (p.id.clone(), l.remote_url.map(|u| normalize_remote_url(&u)), l.subdir)))
        .collect()
}

/// One unit of input to `apply_paths`: a repo path, the rev its BASE content
/// is read from (None: a first connect, apply everything), and the rev of the
/// content to apply.
struct PathInput {
    path: String,
    base: Option<String>,
}

#[derive(Default)]
struct ApplyOutcome {
    changed_profiles: BTreeSet<String>,
    prefs: PrefsChanges,
    themes_changed: bool,
    customizations_changed: bool,
    customization_affected_profiles: BTreeSet<ProfileId>,
    scratchpad_changed: bool,
    changes: Vec<Change>,
    tray: Option<Option<bool>>,
    /// A profile was renamed or recoloured from the repo.
    profiles_changed: bool,
    error: Option<String>,
}

/// Merge what the repo holds at `new_rev` into local records, for the files
/// in `inputs`. Only fields that changed between each file's base and its
/// new version are written, so a local edit to a different field survives.
/// `dry_run`: compute the changes, write nothing (the first-connect preview).
fn apply_paths(
    clone: &Path,
    new_rev: &str,
    inputs: &[PathInput],
    bound: &[(ProfileId, String)],
    prefs: Option<&PrefsSnapshot>,
    finder: &Finder,
    dry_run: bool,
) -> ApplyOutcome {
    let mut out = ApplyOutcome::default();
    if inputs.is_empty() {
        return out;
    }
    let paths: Vec<String> = inputs.iter().map(|i| i.path.clone()).collect();
    let new_files = read_at(clone, new_rev, &paths);
    // Base reads, grouped by rev.
    let mut base_files: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    let mut by_rev: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for i in inputs {
        if let Some(r) = &i.base {
            by_rev.entry(r.clone()).or_default().push(i.path.clone());
        }
    }
    for (rev, ps) in by_rev {
        base_files.extend(read_at(clone, &rev, &ps));
    }
    let base_of = |p: &str| -> Option<Map<String, Value>> { parse_obj(base_files.get(p).and_then(|b| b.as_ref())) };
    let new_of = |p: &str| -> Option<Map<String, Value>> { parse_obj(new_files.get(p).and_then(|b| b.as_ref())) };

    // Machine-wide prefs.
    if inputs.iter().any(|i| i.path == "prefs.json") {
        let new = new_of("prefs.json").unwrap_or_default();
        let changes = pref_changes(base_of("prefs.json").as_ref(), &new, prefs.map(|p| &p.shared));
        for c in &changes {
            out.changes.push(pref_change_line(c, prefs.and_then(|p| p.shared.get(&c.key)), None));
        }
        out.prefs.shared = changes;
    }

    // Themes.
    for i in inputs.iter().filter(|i| i.path.starts_with("themes/")) {
        let name = &i.path["themes/".len()..];
        if !is_theme_file(name) {
            continue;
        }
        let Some(dir) = local_themes_dir() else { continue };
        let target = dir.join(name);
        match new_files.get(&i.path).and_then(|b| b.as_ref()) {
            Some(bytes) => {
                if fs::read(&target).ok().as_deref() != Some(bytes.as_slice()) {
                    out.changes.push(Change { kind: "theme".into(), target: name.into(), action: if target.exists() { "update" } else { "add" }.into(), ..Default::default() });
                    if !dry_run {
                        let _ = fs::create_dir_all(&dir);
                        let _ = fs::write(&target, bytes);
                    }
                    out.themes_changed = true;
                }
            }
            None => {
                if target.exists() {
                    out.changes.push(Change { kind: "theme".into(), target: name.into(), action: "remove".into(), ..Default::default() });
                    if !dry_run {
                        let _ = fs::remove_file(&target);
                    }
                    out.themes_changed = true;
                }
            }
        }
    }

    // Global scratchpad (flattened at repo root).
    for i in inputs.iter().filter(|i| i.path.starts_with("scratch/")) {
        let rel = &i.path["scratch/".len()..];
        if rel.is_empty() || rel.contains("..") {
            continue;
        }
        let Some(root) = crate::profile_dir(&ProfileId::Root).ok().map(|d| d.join("scratch").join("global")) else { continue };
        let target = root.join(rel);
        match new_files.get(&i.path).and_then(|b| b.as_ref()) {
            Some(bytes) => {
                let write_bytes = if rel == "index.json" {
                    merge_scratch_index(&target, bytes)
                } else {
                    bytes.clone()
                };
                if fs::read(&target).ok().as_deref() != Some(write_bytes.as_slice()) {
                    out.changes.push(Change {
                        kind: "scratchpad".into(),
                        target: format!("global:{rel}"),
                        action: if target.exists() { "update" } else { "add" }.into(),
                        ..Default::default()
                    });
                    if !dry_run {
                        if let Some(parent) = target.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let _ = fs::write(&target, &write_bytes);
                    }
                    out.scratchpad_changed = true;
                }
            }
            None => {
                if target.exists() {
                    out.changes.push(Change {
                        kind: "scratchpad".into(),
                        target: format!("global:{rel}"),
                        action: "remove".into(),
                        ..Default::default()
                    });
                    if !dry_run {
                        let _ = fs::remove_file(&target);
                    }
                    out.scratchpad_changed = true;
                }
            }
        }
    }

    // Per profile.
    for (pid, sid) in bound {
        let prefix = format!("profiles/{sid}/");
        let mine: Vec<&PathInput> = inputs.iter().filter(|i| i.path.starts_with(&prefix)).collect();
        if mine.is_empty() {
            continue;
        }
        let ns = profile_ns(pid);
        let mut settings = crate::load_settings_in(pid);
        let mut projects = crate::load_projects_in(pid);
        let settings_before = serde_json::to_value(&settings).ok();
        let projects_before = serde_json::to_value(&projects).ok();
        let tombs = parse_obj(read_at(clone, new_rev, &[format!("{prefix}removed.json")]).values().next().and_then(|b| b.as_ref()))
            .unwrap_or_default();
        let mut locations: Option<Vec<(String, Option<String>, String)>> = None;
        let mut position_touched = false;

        for i in &mine {
            let rel = &i.path[prefix.len()..];
            let base = base_of(&i.path);
            let new = new_of(&i.path);
            if rel == "profile.json" {
                // The profile's name and colour follow the repo like any
                // other field: only what changed upstream is written, so a
                // rename here that has not synced yet survives. A dormant
                // install has no registry entry to rename and is left alone.
                let Some(new) = new else { continue };
                let Some(slug) = (match pid {
                    ProfileId::Root => crate::profiles_registry().root_slug,
                    ProfileId::Slug(s) => Some(s.clone()),
                }) else { continue };
                let keys = changed_keys(base.as_ref(), &new);
                let want = |k: &str| {
                    keys.iter().any(|x| x == k).then(|| new.get(k).and_then(Value::as_str)).flatten()
                        .map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
                };
                let (name, accent) = (want("name"), want("accent"));
                let reg = crate::profiles_registry();
                let Some(cur) = reg.get(&slug) else { continue };
                let name = name.filter(|n| n != &cur.name);
                let accent = accent.filter(|a| a != &cur.accent);
                for (field, from, to) in [("name", &cur.name, &name), ("accent", &cur.accent, &accent)] {
                    if let Some(to) = to {
                        out.changes.push(Change {
                            kind: "profile".into(), target: cur.name.clone(), action: "update".into(),
                            field: Some(field.into()), from: Some(Value::String(from.clone())), to: Some(Value::String(to.clone())),
                            profile: Some(sid.clone()), ..Default::default()
                        });
                    }
                }
                if !dry_run && (name.is_some() || accent.is_some()) {
                    let _ = crate::with_registry(|_g, reg| {
                        if let Some(p) = reg.profiles.iter_mut().find(|p| p.slug == slug) {
                            if let Some(n) = &name { p.name = n.clone(); }
                            if let Some(a) = &accent { p.accent = a.clone(); }
                        }
                        Ok(())
                    });
                    out.profiles_changed = true;
                }
            } else if rel == "settings.json" {
                let Some(new) = new else { continue };
                let keys = changed_keys(base.as_ref(), &new);
                let before = as_obj(serde_json::to_value(&settings).unwrap_or(Value::Null));
                let mut lv = before.clone();
                let allowed: Vec<&str> = SETTINGS_SYNC.iter().copied().filter(|k| *k != "agents").collect();
                patch_map(&mut lv, &new, &keys, &allowed);
                if let Ok(next) = serde_json::from_value::<Settings>(Value::Object(lv)) {
                    let after = as_obj(serde_json::to_value(&next).unwrap_or(Value::Null));
                    out.changes.extend(field_changes("settings", "Settings", &before, &after, &allowed, &[], Some(sid)));
                    if settings.tray_enabled != next.tray_enabled && pid.is_root() {
                        out.tray = Some(next.tray_enabled);
                    }
                    settings = next;
                }
            } else if rel == "prefs.json" {
                let Some(new) = new else { continue };
                let have = prefs.and_then(|p| p.scoped.get(&ns));
                let changes = pref_changes(base.as_ref(), &new, have);
                for c in &changes {
                    out.changes.push(pref_change_line(c, have.and_then(|h| h.get(&c.key)), Some(sid)));
                }
                if !changes.is_empty() {
                    out.prefs.scoped.insert(ns.clone(), changes);
                }
            } else if let Some(stem) = rel.strip_prefix("agents/").and_then(|r| r.strip_suffix(".json")) {
                let id = new.as_ref().and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string)
                    .or_else(|| base.as_ref().and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| stem.to_string());
                apply_agent(&mut settings, &id, base.as_ref(), new.as_ref(), sid, &mut out.changes);
            } else if let Some(stem) = rel.strip_prefix("projects/").and_then(|r| r.strip_suffix(".json")) {
                let Some(new) = new else { continue };
                let sync_pid = new.get("id").and_then(Value::as_str).unwrap_or(stem).to_string();
                if base.as_ref().and_then(|b| b.get("position")) != new.get("position") {
                    position_touched = true;
                }
                let local_id = settings.sync.local_id_of(&sync_pid).to_string();
                let resolve_member = |m: &Map<String, Value>| -> Option<String> {
                    let url = m.get("remote_url").and_then(Value::as_str)?;
                    let (repo, _) = (finder.find_repo)(pid, url)?;
                    let sub = m.get("subdir").and_then(Value::as_str).unwrap_or("");
                    let path = if sub.is_empty() { repo } else { repo.join(sub) };
                    path.is_dir().then(|| path.to_string_lossy().into_owned())
                };
                if let Some(p) = projects.iter_mut().find(|p| p.id == local_id) {
                    out.changes.extend(patch_project(p, base.as_ref(), &new, &resolve_member, Some(sid)));
                    continue;
                }
                let name = new.get("name").and_then(Value::as_str).unwrap_or(stem).to_string();
                if settings.sync.skipped.contains(&sync_pid) || tombs.contains_key(&sync_pid) {
                    continue;
                }
                // Not registered here. Match by remote URL, else it waits.
                let non_git = new.get("non_git").and_then(Value::as_bool).unwrap_or(false);
                let url = new.get("remote_url").and_then(Value::as_str);
                let sub = new.get("subdir").and_then(Value::as_str).unwrap_or("").to_string();
                let mut placed = false;
                if let (false, Some(url)) = (non_git, url) {
                    let want = normalize_remote_url(url);
                    // 1. The same repo is already a project here under its own
                    //    id: alias it, never register a duplicate.
                    let locs = locations.get_or_insert_with(|| local_locations(&projects));
                    if let Some((lid, _, _)) = locs.iter().find(|(_, u, s)| u.as_deref() == Some(want.as_str()) && *s == sub) {
                        let lid = lid.clone();
                        settings.sync.aliases.insert(sync_pid.clone(), lid.clone());
                        if let Some(p) = projects.iter_mut().find(|p| p.id == lid) {
                            out.changes.extend(patch_project(p, None, &new, &resolve_member, Some(sid)));
                        }
                        placed = true;
                    } else if let Some((repo, remote)) = (finder.find_repo)(pid, url) {
                        // 2. A repo under repos_dir with the same remote.
                        let path = if sub.is_empty() { repo } else { repo.join(&sub) };
                        let canon = dunce::canonicalize(&path).ok();
                        let taken = canon.as_ref().map(|c| crate::project_path_taken(&projects, pid, &c.to_string_lossy())).unwrap_or(true);
                        if let (Some(c), false) = (canon, taken) {
                            if let Some(mut p) = project_from_doc(&new, &c, pid, &remote) {
                                let empty = Vec::new();
                                let nm = new.get("members").and_then(Value::as_array).unwrap_or(&empty);
                                let (members, _) = merge_members(&[], None, nm, &resolve_member);
                                if p.project_type == ProjectType::Multi {
                                    p.members = members;
                                }
                                out.changes.push(Change {
                                    kind: "project".into(), target: name.clone(), action: "add".into(),
                                    to: Some(Value::String(p.root_path.clone())), profile: Some(sid.clone()),
                                    safety: SAFETY_PROJECT.iter().any(|k| !matches!(new.get(*k), None | Some(Value::Null) | Some(Value::Bool(false)))),
                                    ..Default::default()
                                });
                                projects.push(p);
                                placed = true;
                            }
                        }
                    }
                }
                if !placed {
                    out.changes.push(Change { kind: "project".into(), target: name, action: "wait".into(), profile: Some(sid.clone()), ..Default::default() });
                }
            } else if let Some(after) = rel.strip_prefix("scratch/projects/") {
                let Some((sync_pid, file_rel)) = after.split_once('/') else { continue };
                if file_rel.is_empty() || file_rel.contains("..") {
                    continue;
                }
                let local_pid = settings.sync.local_id_of(sync_pid);
                let Some(root) = crate::profile_dir(pid).ok().map(|d| d.join("scratch").join("projects").join(local_pid)) else { continue };
                let target = root.join(file_rel);
                match new_files.get(&i.path).and_then(|b| b.as_ref()) {
                    Some(bytes) => {
                        let write_bytes = if file_rel == "index.json" {
                            merge_scratch_index(&target, bytes)
                        } else {
                            bytes.clone()
                        };
                        if fs::read(&target).ok().as_deref() != Some(write_bytes.as_slice()) {
                            out.changes.push(Change {
                                kind: "scratchpad".into(),
                                target: format!("project:{sync_pid}:{file_rel}"),
                                action: if target.exists() { "update" } else { "add" }.into(),
                                profile: Some(sid.clone()),
                                ..Default::default()
                            });
                            if !dry_run {
                                if let Some(parent) = target.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                let _ = fs::write(&target, &write_bytes);
                            }
                            out.scratchpad_changed = true;
                        }
                    }
                    None => {
                        if target.exists() {
                            out.changes.push(Change {
                                kind: "scratchpad".into(),
                                target: format!("project:{sync_pid}:{file_rel}"),
                                action: "remove".into(),
                                profile: Some(sid.clone()),
                                ..Default::default()
                            });
                            if !dry_run {
                                let _ = fs::remove_file(&target);
                            }
                            out.scratchpad_changed = true;
                        }
                    }
                }
            } else if let Some(cust_rel) = rel.strip_prefix("customizations/") {
                let p = std::path::Path::new(cust_rel);
                let is_valid_rel = p.is_relative() && p.components().all(|c| matches!(c, std::path::Component::Normal(_)));
                if is_valid_rel && !cust_rel.ends_with(".local") && !cust_rel.contains("secret") && !cust_rel.contains("token") {
                    if let Ok(pdir) = crate::profile_dir(pid) {
                        let base_cust = crate::customizations::customizations_dir(&pdir);
                        let target = base_cust.join(cust_rel);
                        // Check ancestor safety and ensure base_cust and target aren't symlinks
                        let base_cust_symlink = base_cust.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
                        let mut ancestor_safe = !base_cust_symlink;
                        let mut cur = base_cust.clone();
                        for comp in p.components() {
                            cur.push(comp);
                            if cur == target { break; }
                            if cur.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                                ancestor_safe = false;
                                break;
                            }
                        }
                        let target_is_symlink = target.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);

                        if ancestor_safe {
                            if target_is_symlink {
                                if !dry_run {
                                    if let Err(e) = crate::fs_link::remove_link(&target) {
                                        out.error = Some(format!("Failed to remove destination symlink {}: {e}", target.display()));
                                        return out;
                                    }
                                }
                            }
                            match new_files.get(&i.path).and_then(|b| b.as_ref()) {
                                Some(bytes) => {
                                    let bytes_changed = fs::read(&target).ok().as_deref() != Some(bytes.as_slice());
                                    #[cfg(unix)]
                                    let (mode_changed, want_mode) = {
                                        use std::os::unix::fs::PermissionsExt;
                                        let git_mode = read_git_file_mode(clone, new_rev, &i.path);
                                        let want_exec = git_mode.map(|m| (m & 0o111) != 0).unwrap_or(false);
                                        let target_exec = target.metadata().map(|m| (m.permissions().mode() & 0o111) != 0).unwrap_or(false);
                                        let mode_diff = target.exists() && want_exec != target_exec;
                                        (mode_diff, if want_exec { 0o755 } else { 0o644 })
                                    };
                                    #[cfg(not(unix))]
                                    let mode_changed = false;

                                    if bytes_changed || mode_changed {
                                        if !dry_run {
                                            if let Some(parent) = target.parent() {
                                                if let Err(e) = fs::create_dir_all(parent) {
                                                    out.error = Some(format!("Failed to create parent directory for {}: {e}", target.display()));
                                                    return out;
                                                }
                                            }
                                            if bytes_changed {
                                                if let Err(e) = fs::write(&target, bytes) {
                                                    out.error = Some(format!("Failed to write customization file {}: {e}", target.display()));
                                                    return out;
                                                }
                                            }
                                            #[cfg(unix)]
                                            {
                                                use std::os::unix::fs::PermissionsExt;
                                                if let Err(e) = fs::set_permissions(&target, fs::Permissions::from_mode(want_mode)) {
                                                    out.error = Some(format!("Failed to set permissions on {}: {e}", target.display()));
                                                    return out;
                                                }
                                            }
                                            out.changes.push(Change {
                                                kind: "customization".into(),
                                                target: cust_rel.into(),
                                                action: if target.exists() && !bytes_changed { "chmod" } else if target.exists() { "update" } else { "add" }.into(),
                                                profile: Some(sid.clone()),
                                                ..Default::default()
                                            });
                                            out.customizations_changed = true;
                                            out.customization_affected_profiles.insert(pid.clone());
                                        } else {
                                            out.changes.push(Change {
                                                kind: "customization".into(),
                                                target: cust_rel.into(),
                                                action: if target.exists() && !bytes_changed { "chmod" } else if target.exists() { "update" } else { "add" }.into(),
                                                profile: Some(sid.clone()),
                                                ..Default::default()
                                            });
                                            out.customizations_changed = true;
                                            out.customization_affected_profiles.insert(pid.clone());
                                        }
                                    }
                                }
                                None => {
                                    if target.exists() {
                                        out.changes.push(Change {
                                            kind: "customization".into(),
                                            target: cust_rel.into(),
                                            action: "remove".into(),
                                            profile: Some(sid.clone()),
                                            ..Default::default()
                                        });
                                        if !dry_run {
                                            if let Err(e) = fs::remove_file(&target) {
                                                out.error = Some(format!("Failed to remove customization file {}: {e}", target.display()));
                                                return out;
                                            }
                                            out.customizations_changed = true;
                                            out.customization_affected_profiles.insert(pid.clone());
                                        } else {
                                            out.customizations_changed = true;
                                            out.customization_affected_profiles.insert(pid.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if let Some(file_rel) = rel.strip_prefix("scratch/") {
                if file_rel.is_empty() || file_rel.contains("..") {
                    continue;
                }
                let Some(root) = crate::profile_dir(pid).ok().map(|d| d.join("scratch").join("profile")) else { continue };
                let target = root.join(file_rel);
                match new_files.get(&i.path).and_then(|b| b.as_ref()) {
                    Some(bytes) => {
                        let write_bytes = if file_rel == "index.json" {
                            merge_scratch_index(&target, bytes)
                        } else {
                            bytes.clone()
                        };
                        if fs::read(&target).ok().as_deref() != Some(write_bytes.as_slice()) {
                            out.changes.push(Change {
                                kind: "scratchpad".into(),
                                target: format!("profile:{file_rel}"),
                                action: if target.exists() { "update" } else { "add" }.into(),
                                profile: Some(sid.clone()),
                                ..Default::default()
                            });
                            if !dry_run {
                                if let Some(parent) = target.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                let _ = fs::write(&target, &write_bytes);
                            }
                            out.scratchpad_changed = true;
                        }
                    }
                    None => {
                        if target.exists() {
                            out.changes.push(Change {
                                kind: "scratchpad".into(),
                                target: format!("profile:{file_rel}"),
                                action: "remove".into(),
                                profile: Some(sid.clone()),
                                ..Default::default()
                            });
                            if !dry_run {
                                let _ = fs::remove_file(&target);
                            }
                            out.scratchpad_changed = true;
                        }
                    }
                }
            }
        }

        if position_touched {
            let order = read_positions(clone, new_rev, &prefix, &settings.sync);
            let index: HashMap<&str, usize> = projects.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
            let mut sorted = projects.clone();
            sorted.sort_by_key(|p| (order.get(&p.id).copied().unwrap_or(u64::MAX), index.get(p.id.as_str()).copied().unwrap_or(0)));
            if sorted.iter().map(|p| &p.id).ne(projects.iter().map(|p| &p.id)) {
                out.changes.push(Change { kind: "project".into(), target: "order".into(), action: "update".into(), profile: Some(sid.clone()), ..Default::default() });
                projects = sorted;
            }
        }

        let projects_changed = serde_json::to_value(&projects).ok() != projects_before;
        let settings_changed = serde_json::to_value(&settings).ok() != settings_before;
        let old_customizations_enabled = settings_before.as_ref()
            .and_then(|v| v.get("customizations_enabled")).and_then(|v| v.as_bool()).unwrap_or(true);
        if old_customizations_enabled != settings.customizations_enabled.unwrap_or(true) {
            out.customization_affected_profiles.insert(pid.clone());
            out.customizations_changed = true;
        }
        if projects_changed || settings_changed || out.customization_affected_profiles.contains(pid) {
            out.changed_profiles.insert(ns.clone());
        }
        if projects_changed {
            let old_projects: Vec<Project> = projects_before.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            for p in &projects {
                if let Some(old_p) = old_projects.iter().find(|op| op.id == p.id) {
                    if old_p.customization_mode != p.customization_mode {
                        out.customization_affected_profiles.insert(pid.clone());
                        out.customizations_changed = true;
                    }
                }
            }
        }
        if !dry_run {
            if projects_changed {
                let _ = crate::save_projects_in(pid, &projects);
            }
            if settings_changed {
                let _ = crate::save_settings_in(pid, &settings);
            }
        }
    }
    out
}

fn pref_change_line(c: &PrefChange, from: Option<&String>, profile: Option<&str>) -> Change {
    Change {
        kind: "pref".into(),
        target: c.key.clone(),
        action: "update".into(),
        from: Some(from.map(|s| Value::String(s.clone())).unwrap_or(Value::Null)),
        to: Some(c.value.clone().map(Value::String).unwrap_or(Value::Null)),
        safety: SAFETY_PREFS.contains(&c.key.as_str()),
        profile: profile.map(str::to_string),
        ..Default::default()
    }
}

/// Local project id -> synced position, read from every project file.
fn read_positions(clone: &Path, rev: &str, prefix: &str, sl: &SyncLocal) -> HashMap<String, u64> {
    let files = list_files(clone, rev, &format!("{prefix}projects/"));
    let read = read_at(clone, rev, &files);
    let mut out = HashMap::new();
    for (_, b) in read {
        if let Some(m) = parse_obj(b.as_ref()) {
            if let (Some(id), Some(pos)) = (m.get("id").and_then(Value::as_str), m.get("position").and_then(Value::as_u64)) {
                out.insert(sl.local_id_of(id).to_string(), pos);
            }
        }
    }
    out
}

fn apply_agent(
    settings: &mut Settings,
    id: &str,
    base: Option<&Map<String, Value>>,
    new: Option<&Map<String, Value>>,
    sid: &str,
    changes: &mut Vec<Change>,
) {
    let idx = settings.agents.iter().position(|a| a.id == id);
    match (new, idx) {
        (None, Some(i)) => {
            // Deleted upstream. Built-ins always exist; a custom one goes.
            if base.is_some() && !settings.agents[i].builtin {
                let a = settings.agents.remove(i);
                changes.push(Change { kind: "agent".into(), target: a.display_name, action: "remove".into(), profile: Some(sid.into()), ..Default::default() });
            }
        }
        (None, None) => {}
        (Some(new), Some(i)) => {
            let before = as_obj(serde_json::to_value(&settings.agents[i]).unwrap_or(Value::Null));
            let mut lv = before.clone();
            let keys = changed_keys(base, new);
            patch_map(&mut lv, new, &keys, AGENT_SYNC);
            if let Ok(next) = serde_json::from_value::<Agent>(Value::Object(lv)) {
                let after = as_obj(serde_json::to_value(&next).unwrap_or(Value::Null));
                changes.extend(field_changes("agent", &next.display_name, &before, &after, AGENT_SYNC, &[], Some(sid)));
                settings.agents[i] = next;
            }
        }
        (Some(new), None) => {
            let v = pick(&Value::Object(new.clone()), AGENT_SYNC);
            if let Ok(mut a) = serde_json::from_value::<Agent>(Value::Object(v)) {
                // A clone of a local agent needs that agent's sandbox paths to
                // run caged at all; they are local, so borrow them here.
                if let Some(base_id) = a.extends.clone() {
                    if let Some(b) = settings.agents.iter().find(|x| x.id == base_id) {
                        a.sandbox_allowed_paths = b.sandbox_allowed_paths.clone();
                    }
                }
                changes.push(Change { kind: "agent".into(), target: a.display_name.clone(), action: "add".into(), profile: Some(sid.into()), ..Default::default() });
                settings.agents.push(a);
            }
        }
    }
}

// ───────────────────────────── the loop ─────────────────────────────

/// Serializes every operation on the clone.
static SYNC_LOCK: parking_lot::Mutex<()> = parking_lot::const_mutex(());

/// Set once the launch pull has run in this process, by whichever profile
/// window got there first.
static LAUNCH_PULLED: AtomicBool = AtomicBool::new(false);

pub(crate) struct RunOpts<'a> {
    /// Create a local profile for every repo folder that has none, and upload
    /// every local profile that follows none (`adopt_profiles`). Off only for
    /// the run `bind` makes BEFORE it binds: the folder the user is about to
    /// pick must not be turned into a new profile first.
    pub adopt: bool,
    pub push: bool,
    pub machine: &'a str,
    pub prefs: Option<&'a PrefsSnapshot>,
    pub locate: Locate<'a>,
    pub finder: &'a Finder<'a>,
}

fn default_locate(path: &str, remote: &str) -> Option<RepoLoc> {
    repo_location(path, remote)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// How long after a pull (or a failed attempt) a focus pull waits.
const FOCUS_PULL_GAP_SECS: i64 = 5 * 60;

fn parsed_stamp(s: &Option<String>) -> Option<chrono::DateTime<chrono::Utc>> {
    let s = s.as_deref()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&chrono::Utc))
}

/// Whether a focus pull should fetch. The later of the last attempt and the
/// last success counts, and an outstanding conflict does not: another pull
/// would not settle it, and `run_core` does not refuse to start while one is
/// waiting. An unreadable stamp is ignored, so a bad value cannot block pulls
/// forever.
fn focus_pull_due(state: &SyncState, now: chrono::DateTime<chrono::Utc>) -> bool {
    if !state.conflicts.is_empty() {
        return false;
    }
    let last = [parsed_stamp(&state.last_pull_at), parsed_stamp(&state.last_sync_at)].into_iter().flatten().max();
    match last {
        None => true,
        Some(t) => now.signed_duration_since(t).num_seconds() >= FOCUS_PULL_GAP_SECS,
    }
}

/// Export, commit, fetch, rebase, apply, and (with `push`) push.
pub(crate) fn run_core(clone: &Path, opts: &RunOpts) -> SyncRunResult {
    let mut res = SyncRunResult::default();
    let mut state = load_state();
    let fail = |mut res: SyncRunResult, mut state: SyncState, e: String| {
        state.last_error = Some(e.clone());
        save_state(&state);
        res.error = Some(e);
        res
    };
    if !is_connected(clone) {
        res.skipped = true;
        return res;
    }
    // Before the fetch, and on the same `state` every exit path saves. A
    // failure does not move `last_sync_at` (`fail` leaves it), so without
    // this a focus pull would try again on every focus while offline.
    state.last_pull_at = Some(now());
    save_state(&state);
    let mut bound = bound_profiles();
    let branch = match current_branch(clone) {
        Ok(b) => b,
        Err(e) => return fail(res, state, e),
    };
    let upstream = format!("origin/{branch}");
    let old_up = rev_parse(clone, &upstream);

    if let Err(e) = export_all(clone, &bound, opts.prefs, opts.locate) {
        return fail(res, state, e);
    }
    if let Err(e) = commit_if_dirty(clone, opts.machine) {
        return fail(res, state, e);
    }

    let mut attempts = 0;
    let mut base_up = old_up;
    loop {
        attempts += 1;
        if let Err(e) = git_bounded(&["fetch", "--no-tags", "origin"], clone, FETCH_TIMEOUT) {
            return fail(res, state, e);
        }
        let new_up = rev_parse(clone, &upstream);
        // Integrate upstream.
        if let Some(nu) = &new_up {
            let head = rev_parse(clone, "HEAD");
            let integrated = match &head {
                None => g(clone, &["reset", "-q", "--hard", nu]).map(|_| ()),
                Some(h) if is_ancestor(clone, h, nu) => g(clone, &["merge", "-q", "--ff-only", nu]).map(|_| ()),
                Some(h) if is_ancestor(clone, nu, h) => Ok(()),
                Some(_) => match g(clone, &["rebase", "-q", nu]) {
                    Ok(_) => Ok(()),
                    Err(e) => {
                        let conflicts: Vec<String> = g(clone, &["diff", "--name-only", "--diff-filter=U"])
                            .unwrap_or_default()
                            .lines()
                            .map(str::to_string)
                            .filter(|s| !s.is_empty())
                            .collect();
                        let _ = g(clone, &["rebase", "--abort"]);
                        if conflicts.is_empty() {
                            Err(e)
                        } else {
                            state.choices.retain(|p, _| conflicts.contains(p));
                            state.conflicts = conflicts.clone();
                            state.last_error = None;
                            save_state(&state);
                            res.conflicts = conflicts;
                            return res;
                        }
                    }
                },
            };
            if let Err(e) = integrated {
                return fail(res, state, e);
            }
            // Apply what upstream brought since we last integrated it.
            if base_up.as_deref() != Some(nu.as_str()) {
                match changed_paths(clone, base_up.as_deref(), nu) {
                    Ok(paths) => {
                        let inputs: Vec<PathInput> = paths.into_iter().map(|p| PathInput { path: p, base: base_up.clone() }).collect();
                        let o = apply_paths(clone, "HEAD", &inputs, &bound, opts.prefs, opts.finder, false);
                        if let Some(e) = o.error {
                            return fail(res, state, e);
                        }
                        merge_outcome(&mut res, o);
                    }
                    Err(e) => return fail(res, state, e),
                }
            }
        }
        base_up = new_up.clone();

        // Profiles follow the repo both ways, now that HEAD holds everything
        // upstream has. Before the push, so a profile uploaded here goes out
        // in this same run.
        if opts.adopt && !bound.is_empty() {
            let adopted = adopt_profiles(clone, opts, &state, &bound);
            if let Some(err) = adopted.outcome.error {
                return fail(res, state, err);
            }
            if !adopted.bound.is_empty() {
                bound.extend(adopted.bound);
                res.profiles_changed |= adopted.created;
                merge_outcome(&mut res, adopted.outcome);
                if let Err(e) = export_all(clone, &bound, opts.prefs, opts.locate) {
                    return fail(res, state, e);
                }
                if let Err(e) = commit_if_dirty(clone, opts.machine) {
                    return fail(res, state, e);
                }
            }
        }

        if !opts.push || bound.is_empty() {
            break;
        }
        let head = rev_parse(clone, "HEAD");
        if head.is_none() || head == new_up {
            break; // nothing of ours to push
        }
        match git_bounded(&["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")], clone, PUSH_TIMEOUT) {
            Ok(_) => {
                res.pushed = true;
                let _ = g(clone, &["branch", "--set-upstream-to", &upstream, &branch]);
                let _ = git_bounded(&["fetch", "--no-tags", "origin"], clone, FETCH_TIMEOUT);
                clear_outboxes(&bound);
                break;
            }
            Err(e) => {
                let rejected = e.contains("rejected") || e.contains("non-fast-forward") || e.contains("fetch first");
                if rejected && attempts < 2 {
                    continue;
                }
                return fail(res, state, e);
            }
        }
    }
    record_notices(&mut state, &res.changes);
    state.conflicts.clear();
    state.choices.clear();
    state.last_error = None;
    state.last_sync_at = Some(now());
    save_state(&state);
    res.ok = true;
    res
}

fn merge_outcome(res: &mut SyncRunResult, o: ApplyOutcome) {
    for p in o.changed_profiles {
        if !res.changed_profiles.contains(&p) {
            res.changed_profiles.push(p);
        }
    }
    res.prefs.shared.extend(o.prefs.shared);
    for (ns, v) in o.prefs.scoped {
        res.prefs.scoped.entry(ns).or_default().extend(v);
    }
    res.themes_changed |= o.themes_changed;
    res.scratchpad_changed |= o.scratchpad_changed;
    res.customizations_changed |= o.customizations_changed;
    for pid in o.customization_affected_profiles {
        if !res.customization_affected_profiles.contains(&pid) {
            res.customization_affected_profiles.push(pid);
        }
    }
    res.profiles_changed |= o.profiles_changed;
    res.changes.extend(o.changes);
    if res.error.is_none() {
        res.error = o.error;
    }
}

/// Whether a change is announced and kept until dismissed: a YOLO or sandbox
/// default, or a custom agent deleted on another machine. The removal is
/// applied, not asked, because it deletes no files (unlike `project_remove`,
/// which archives tasks and worktrees), but tasks here that use the agent can
/// no longer start it, so it is never silent.
pub(crate) fn is_notice(c: &Change) -> bool {
    c.safety || (c.kind == "agent" && c.action == "remove")
}

fn record_notices(state: &mut SyncState, changes: &[Change]) {
    for c in changes.iter().filter(|c| is_notice(c)) {
        state.notices.retain(|n| !(n.kind == c.kind && n.target == c.target && n.field == c.field && n.profile == c.profile));
        state.notices.push(c.clone());
    }
}

/// Outbox entries reached the remote: drop them.
fn clear_outboxes(bound: &[(ProfileId, String)]) {
    for (id, _) in bound {
        let mut s = crate::load_settings_in(id);
        if s.sync.removed.is_empty() && s.sync.kept.is_empty() {
            continue;
        }
        s.sync.removed.clear();
        s.sync.kept.clear();
        let _ = crate::save_settings_in(id, &s);
    }
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
pub struct FolderView {
    pub sync_id: String,
    pub name: String,
    /// The profile's colour on the machine that last exported it.
    pub accent: Option<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ConnectInfo {
    pub url: String,
    pub empty: bool,
    pub folders: Vec<FolderView>,
}

fn list_folders(clone: &Path, rev: &str) -> Vec<FolderView> {
    let files = list_files(clone, rev, "profiles/");
    let names: Vec<String> = files.iter().filter(|f| f.ends_with("/profile.json")).cloned().collect();
    let read = read_at(clone, rev, &names);
    let mut out: Vec<FolderView> = names
        .iter()
        .filter_map(|f| {
            let sid = f.strip_prefix("profiles/")?.strip_suffix("/profile.json")?.to_string();
            let meta = parse_obj(read.get(f).and_then(|b| b.as_ref()));
            let field = |k: &str| meta.as_ref().and_then(|m| m.get(k).and_then(Value::as_str).map(str::to_string));
            let name = field("name").unwrap_or_else(|| sid.clone());
            Some(FolderView { sync_id: sid, name, accent: field("accent") })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.sync_id.cmp(&b.sync_id)));
    out
}

/// The prefix of `check_repo_url`'s refusal. SyncSection.tsx matches it to
/// show the zh-CN text, so it is pinned by a test.
pub(crate) const BAD_URL: &str = "Unsupported repo URL.";

/// The repo URL forms a sync remote can be. Anything else is refused before
/// git sees it: git reads `<helper>::<address>` as a remote helper (`ext::`
/// runs a command, `fd::` talks over a descriptor) and a leading `-` as an
/// option, and a pasted string can be either.
pub(crate) fn check_repo_url(url: &str) -> Result<(), String> {
    const SCHEMES: &[&str] = &["https://", "http://", "ssh://", "git://", "file://"];
    let ok = if url.starts_with('-') || url.chars().any(char::is_control) {
        false
    } else if let Some(s) = SCHEMES.iter().find(|s| url.starts_with(**s)) {
        let rest = &url[s.len()..];
        // `ssh://-oProxyCommand=..`: neither the user nor the host may read
        // as an option to ssh.
        let authority = rest.split('/').next().unwrap_or("");
        let host = authority.rsplit('@').next().unwrap_or("");
        !rest.is_empty() && !authority.starts_with('-') && !host.starts_with('-') && (*s == "file://" || !host.is_empty())
    } else {
        is_scp_like(url)
    };
    if ok {
        Ok(())
    } else {
        Err(format!("{BAD_URL} Use an https://, http://, ssh://, git:// or file:// URL, or user@host:path."))
    }
}

/// `user@host:path`, the form `git@github.com:acme/app.git` takes.
fn is_scp_like(url: &str) -> bool {
    let Some((user, rest)) = url.split_once('@') else { return false };
    let Some((host, path)) = rest.split_once(':') else { return false };
    let word = |w: &str, extra: &str| {
        !w.is_empty() && !w.starts_with('-') && w.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
    };
    word(user, "._-") && word(host, ".-") && !path.is_empty()
}

/// The clone's argv. `--` ends the options, so the URL and target are only
/// ever read as the repository and the directory.
fn clone_args<'a>(url: &'a str, target: &'a str) -> [&'a str; 6] {
    ["clone", "-q", "--no-tags", "--", url, target]
}

/// Clone the repo (or reuse this machine's clone of it) and describe it.
pub(crate) fn connect(clone: &Path, url: &str) -> Result<ConnectInfo, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Enter the repo URL.".into());
    }
    check_repo_url(url)?;
    if is_connected(clone) {
        let have = origin_url(clone).unwrap_or_default();
        if normalize_remote_url(&have) != normalize_remote_url(url) {
            return Err(format!("This machine already syncs with {have}. Disconnect it first."));
        }
        let _ = git_bounded(&["fetch", "--no-tags", "origin"], clone, FETCH_TIMEOUT);
    } else {
        let parent = clone.parent().ok_or("no data dir")?;
        let partial = parent.join("sync.partial");
        let _ = fs::remove_dir_all(&partial);
        let target = partial.to_string_lossy().into_owned();
        git_bounded(&clone_args(url, &target), parent, CLONE_TIMEOUT)?;
        configure_clone(&partial)?;
        fs::rename(&partial, clone).map_err(|e| format!("move clone: {e}"))?;
    }
    let branch = ensure_branch(clone)?;
    let up = rev_parse(clone, &format!("origin/{branch}"));
    let folders = up.as_deref().map(|r| list_folders(clone, r)).unwrap_or_default();
    let empty = up.is_none();
    Ok(ConnectInfo { url: url.to_string(), empty, folders })
}

/// All files a first connect applies for one profile folder, plus the
/// machine-wide ones when the machine is not synced yet.
fn first_connect_inputs(clone: &Path, rev: &str, sync_id: &str, machine_wide: bool) -> Vec<PathInput> {
    let mut paths = list_files(clone, rev, &format!("profiles/{sync_id}/"));
    if machine_wide {
        paths.extend(list_files(clone, rev, "themes/"));
        paths.push("prefs.json".into());
        paths.extend(list_files(clone, rev, "scratch/"));
    }
    paths.into_iter().map(|p| PathInput { path: p, base: None }).collect()
}

/// What binding this profile to `folder` would change here, without changing
/// anything. `folder` None: a new folder, which changes only machine-wide
/// prefs and themes (and those only on the first profile to connect).
pub(crate) fn preview(clone: &Path, id: &ProfileId, folder: Option<&str>, prefs: Option<&PrefsSnapshot>, finder: &Finder) -> Result<Vec<Change>, String> {
    let branch = current_branch(clone)?;
    let Some(up) = rev_parse(clone, &format!("origin/{branch}")) else { return Ok(Vec::new()) };
    let machine_wide = bound_profiles().is_empty();
    let sid = folder.unwrap_or("");
    let mut inputs = first_connect_inputs(clone, &up, sid, machine_wide);
    if folder.is_none() {
        inputs.retain(|i| !i.path.starts_with("profiles/"));
    }
    let bound = vec![(id.clone(), sid.to_string())];
    let mut changes = apply_paths(clone, &up, &inputs, &bound, prefs, finder, true).changes;
    // What connecting does to the OTHER profiles, said before it happens:
    // which folders become profiles here, and which local profiles go up. The
    // same rule the sync itself applies, with this profile counted as bound.
    let folders = list_folders(clone, &up);
    let mut locals = local_profiles();
    for l in &mut locals {
        if &l.id == id {
            l.sync_id = Some(folder.unwrap_or("\u{0}new").to_string());
        }
    }
    let plan = plan_adoption(&folders, &locals, &load_state().ignored_folders);
    let mut profile_lines: Vec<Change> = plan.create.iter().map(|f| profile_change(&f.name, "add", &f.sync_id)).collect();
    profile_lines.extend(plan.upload.iter().map(|p| profile_change(&profile_display_name(p), "upload", "")));
    profile_lines.extend(std::mem::take(&mut changes));
    Ok(profile_lines)
}

/// Bind a profile to a folder (or a new one) and run its first sync.
pub(crate) fn bind(clone: &Path, id: &ProfileId, folder: Option<String>, opts: &RunOpts) -> SyncRunResult {
    // Two profiles on one machine exporting into one folder would overwrite
    // each other on every sync.
    if let Some(f) = &folder {
        if bound_profiles().iter().any(|(p, s)| s == f && p != id) {
            return SyncRunResult { error: Some("Another profile on this machine already follows that folder.".into()), ..Default::default() };
        }
    }
    // Bring the clone up to date for whatever is already bound, without
    // pushing. Nothing bound: just the fetch and fast-forward.
    let pre = run_core(clone, &RunOpts { push: false, adopt: false, ..*opts });
    if pre.error.is_some() || !pre.conflicts.is_empty() {
        return pre;
    }
    let machine_wide = bound_profiles().is_empty();
    let sid = folder.clone().unwrap_or_else(|| new_folder_id(id, &folder_ids(clone)));
    let mut s = crate::load_settings_in(id);
    s.sync.sync_id = Some(sid.clone());
    s.sync.opted_out = false;
    if let Err(e) = crate::save_settings_in(id, &s) {
        return SyncRunResult { error: Some(e), ..Default::default() };
    }
    let mut first = ApplyOutcome::default();
    if let Ok(branch) = current_branch(clone) {
        if let Some(up) = rev_parse(clone, &format!("origin/{branch}")) {
            let mut inputs = first_connect_inputs(clone, &up, &sid, machine_wide);
            if folder.is_none() {
                inputs.retain(|i| !i.path.starts_with("profiles/"));
            }
            let bound = vec![(id.clone(), sid.clone())];
            first = apply_paths(clone, "HEAD", &inputs, &bound, opts.prefs, opts.finder, false);
            if let Some(e) = first.error {
                return SyncRunResult { error: Some(e), ..Default::default() };
            }
        }
    }
    // The window applies `first.prefs` after this returns; until it does,
    // its snapshot is stale for exactly those keys, so export the merged one.
    let merged = opts.prefs.map(|p| merged_snapshot(p, &first.prefs));
    let mut res = run_core(clone, &RunOpts { push: true, prefs: merged.as_ref(), ..*opts });
    let mut first_res = SyncRunResult::default();
    merge_outcome(&mut first_res, first);
    // First-connect changes go first in the report.
    first_res.changes.extend(std::mem::take(&mut res.changes));
    res.changes = first_res.changes;
    for p in first_res.changed_profiles {
        if !res.changed_profiles.contains(&p) {
            res.changed_profiles.push(p);
        }
    }
    let mut prefs = first_res.prefs;
    prefs.shared.extend(std::mem::take(&mut res.prefs.shared));
    for (ns, v) in std::mem::take(&mut res.prefs.scoped) {
        prefs.scoped.entry(ns).or_default().extend(v);
    }
    res.prefs = prefs;
    res.themes_changed |= first_res.themes_changed;
    res.scratchpad_changed |= first_res.scratchpad_changed;
    res.customizations_changed |= first_res.customizations_changed;
    for pid in first_res.customization_affected_profiles {
        if !res.customization_affected_profiles.contains(&pid) {
            res.customization_affected_profiles.push(pid);
        }
    }
    let mut state = load_state();
    record_notices(&mut state, &res.changes);
    save_state(&state);
    res
}

/// The snapshot with `changes` applied: what the window's storage will hold
/// once it writes them.
fn merged_snapshot(p: &PrefsSnapshot, changes: &PrefsChanges) -> PrefsSnapshot {
    let mut out = p.clone();
    let put = |m: &mut BTreeMap<String, String>, c: &PrefChange| match &c.value {
        Some(v) => {
            m.insert(c.key.clone(), v.clone());
        }
        None => {
            m.remove(&c.key);
        }
    };
    for c in &changes.shared {
        put(&mut out.shared, c);
    }
    for (ns, cs) in &changes.scoped {
        let m = out.scoped.entry(ns.clone()).or_default();
        for c in cs {
            put(m, c);
        }
    }
    out
}

/// Settle the files a rebase stopped on, once every one has a choice.
///
/// Rather than drive the rebase to completion (where `--ours` is upstream and
/// `--theirs` is local, an inversion that is easy to get wrong), this applies
/// upstream's changes to local records directly, then rebuilds the clone on
/// top of upstream: reset to it, export, commit, push. "Keep this machine's"
/// skips a file's upstream change; "take the other one" applies all of it.
pub(crate) fn resolve(clone: &Path, opts: &RunOpts) -> SyncRunResult {
    let mut res = SyncRunResult::default();
    let mut state = load_state();
    let bound = bound_profiles();
    let branch = match current_branch(clone) {
        Ok(b) => b,
        Err(e) => {
            res.error = Some(e);
            return res;
        }
    };
    if let Err(e) = git_bounded(&["fetch", "--no-tags", "origin"], clone, FETCH_TIMEOUT) {
        state.last_error = Some(e.clone());
        save_state(&state);
        res.error = Some(e);
        return res;
    }
    let upstream = format!("origin/{branch}");
    let Some(nu) = rev_parse(clone, &upstream) else {
        res.error = Some("the remote branch is gone".into());
        return res;
    };
    let head = rev_parse(clone, "HEAD").unwrap_or_default();
    let base = g(clone, &["merge-base", &head, &nu]).ok().map(|s| s.trim().to_string());
    let paths = changed_paths(clone, base.as_deref(), &nu).unwrap_or_default();
    let inputs: Vec<PathInput> = paths
        .into_iter()
        .filter_map(|p| match state.choices.get(&p).map(String::as_str) {
            Some("local") => None,
            // Against our own last export (HEAD), so every field that differs
            // from upstream is taken, removals included.
            Some("remote") => Some(PathInput { path: p, base: Some(head.clone()) }),
            _ => Some(PathInput { path: p, base: base.clone() }),
        })
        .collect();
    let o = apply_paths(clone, &nu, &inputs, &bound, opts.prefs, opts.finder, false);
    if let Some(e) = o.error {
        return SyncRunResult { error: Some(e), ..Default::default() };
    }
    let merged = opts.prefs.map(|p| merged_snapshot(p, &o.prefs));
    merge_outcome(&mut res, o);
    if let Err(e) = g(clone, &["reset", "-q", "--hard", &nu]) {
        res.error = Some(e);
        return res;
    }
    state.conflicts.clear();
    state.choices.clear();
    save_state(&state);
    let mut after = run_core(clone, &RunOpts { push: true, prefs: merged.as_ref(), ..*opts });
    let mut changes = std::mem::take(&mut res.changes);
    changes.extend(std::mem::take(&mut after.changes));
    after.changes = changes;
    for p in res.changed_profiles {
        if !after.changed_profiles.contains(&p) {
            after.changed_profiles.push(p);
        }
    }
    let mut prefs = res.prefs;
    prefs.shared.extend(std::mem::take(&mut after.prefs.shared));
    for (ns, v) in std::mem::take(&mut after.prefs.scoped) {
        prefs.scoped.entry(ns).or_default().extend(v);
    }
    after.prefs = prefs;
    after.themes_changed |= res.themes_changed;
    after.scratchpad_changed |= res.scratchpad_changed;
    after.customizations_changed |= res.customizations_changed;
    for pid in res.customization_affected_profiles {
        if !after.customization_affected_profiles.contains(&pid) {
            after.customization_affected_profiles.push(pid);
        }
    }
    let mut state = load_state();
    record_notices(&mut state, &after.changes);
    save_state(&state);
    after
}

/// Called by `project_remove`: a removal on a bound profile becomes a
/// tombstone on the next sync (never a delete on another machine), and the id
/// goes on this machine's Skip list so a Keep elsewhere does not bring it
/// back here.
pub(crate) fn note_project_removed(p: &Project, machine: &str) {
    let mut s = crate::load_settings_in(&p.profile);
    if s.sync.sync_id.is_none() {
        return;
    }
    let sid = s.sync.sync_id_of(&p.id);
    if !s.sync.removed.iter().any(|t| t.id == sid) {
        s.sync.removed.push(Tombstone { id: sid.clone(), name: p.name.clone(), machine: machine.to_string(), at: now() });
    }
    if !s.sync.skipped.contains(&sid) {
        s.sync.skipped.push(sid.clone());
    }
    s.sync.kept.retain(|k| k != &sid);
    s.sync.aliases.remove(&sid);
    let _ = crate::save_settings_in(&p.profile, &s);
}

// ───────────────────────────── profiles follow the repo ─────────────────────────────

/// Every profile folder the clone's HEAD holds.
fn folder_ids(clone: &Path) -> BTreeSet<String> {
    list_folders(clone, "HEAD").into_iter().map(|f| f.sync_id).collect()
}

/// A local profile as adoption sees it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LocalProfile {
    pub id: ProfileId,
    pub name: String,
    /// `None` for a root profile with no registry entry (profiles dormant).
    pub slug: Option<String>,
    pub sync_id: Option<String>,
    pub opted_out: bool,
}

/// What a sync does about profiles, decided without touching anything.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct AdoptPlan {
    /// Repo folders to create a local profile for.
    pub create: Vec<FolderView>,
    /// Local profiles to upload as a new folder.
    pub upload: Vec<ProfileId>,
    /// Repo folders left alone because an unlinked local profile has the same
    /// name: the user picks, in that profile's Settings > Sync.
    pub waiting: Vec<FolderView>,
}

/// The rule, pure so it can be tested on its own.
///
/// A folder nobody here follows becomes a profile; a profile that follows
/// nothing is uploaded. Two things are never guessed:
///   - a folder and an unlinked local profile that share a NAME (or the
///     folder is named after the profile's slug) are probably the same
///     profile, and possibly not. Merging two project lists on a guess is
///     hard to undo and creating a second "Work" is noise, so both wait;
///   - a folder ignored here (its profile was deleted on this machine) and a
///     profile that opted out stay as the user left them.
pub(crate) fn plan_adoption(folders: &[FolderView], locals: &[LocalProfile], ignored: &[String]) -> AdoptPlan {
    let bound: BTreeSet<&str> = locals.iter().filter_map(|l| l.sync_id.as_deref()).collect();
    let free: Vec<&FolderView> = folders
        .iter()
        .filter(|f| !bound.contains(f.sync_id.as_str()) && !ignored.contains(&f.sync_id))
        .collect();
    let unlinked: Vec<&LocalProfile> = locals.iter().filter(|l| l.sync_id.is_none()).collect();
    let same = |f: &FolderView, l: &LocalProfile| {
        f.name.trim().eq_ignore_ascii_case(l.name.trim()) || l.slug.as_deref() == Some(f.sync_id.as_str())
    };
    let mut plan = AdoptPlan::default();
    for f in &free {
        if unlinked.iter().any(|l| same(f, l)) {
            plan.waiting.push((*f).clone());
        } else {
            plan.create.push((*f).clone());
        }
    }
    for l in &unlinked {
        if !l.opted_out && !free.iter().any(|f| same(f, l)) {
            plan.upload.push(l.id.clone());
        }
    }
    plan
}

fn local_profiles() -> Vec<LocalProfile> {
    let reg = crate::profiles_registry();
    reg.ids()
        .into_iter()
        .map(|id| {
            let sync = crate::load_settings_in(&id).sync;
            let slug = match &id {
                ProfileId::Root => reg.root_slug.clone(),
                ProfileId::Slug(s) => Some(s.clone()),
            };
            LocalProfile { name: profile_display_name(&id), slug, sync_id: sync.sync_id, opted_out: sync.opted_out, id }
        })
        .collect()
}

#[derive(Default)]
struct Adopted {
    /// Newly bound profiles, created or uploaded.
    bound: Vec<(ProfileId, String)>,
    /// At least one local profile was created.
    created: bool,
    outcome: ApplyOutcome,
}

fn profile_change(name: &str, action: &str, sync_id: &str) -> Change {
    Change { kind: "profile".into(), target: name.to_string(), action: action.into(), profile: Some(sync_id.to_string()), ..Default::default() }
}

/// Make this machine's profiles and the repo's folders agree: create a local
/// profile for each folder `plan_adoption` says to, and bind each local
/// profile it says to upload to a new folder (the caller exports and commits).
///
/// Uploads happen only on a run that pushes. A new folder is named after the
/// profile's slug, so two machines can pick the same name; binding it on a
/// launch pull and leaving it unpushed for hours would widen the window in
/// which another machine does the same.
fn adopt_profiles(clone: &Path, opts: &RunOpts, state: &SyncState, bound: &[(ProfileId, String)]) -> Adopted {
    let mut out = Adopted::default();
    let folders = list_folders(clone, "HEAD");
    let plan = plan_adoption(&folders, &local_profiles(), &state.ignored_folders);

    for f in &plan.create {
        // Creating the FIRST profile turns the dormant install into one, and
        // it needs a name then: the folder it follows already carries the one
        // another machine gave it.
        let root_name = bound
            .iter()
            .find(|(p, _)| p.is_root())
            .and_then(|(_, sid)| folders.iter().find(|x| &x.sync_id == sid))
            .map(|x| x.name.clone())
            .filter(|n| !n.trim().is_empty() && !n.trim().eq_ignore_ascii_case(f.name.trim()))
            .unwrap_or_else(|| "Default".to_string());
        let accent = f.accent.clone().unwrap_or_else(|| "blue".to_string());
        let id = match crate::create_profile_data(&f.name, &accent, "", Some(&root_name), None) {
            Ok((_, id, _)) => id,
            // Left for the next sync, which tries again. One bad folder name
            // must not stop the others, or the sync itself.
            Err(_) => continue,
        };
        let mut s = crate::load_settings_in(&id);
        s.sync.sync_id = Some(f.sync_id.clone());
        if crate::save_settings_in(&id, &s).is_err() {
            continue;
        }
        let inputs = first_connect_inputs(clone, "HEAD", &f.sync_id, false);
        let one = vec![(id.clone(), f.sync_id.clone())];
        let o = apply_paths(clone, "HEAD", &inputs, &one, opts.prefs, opts.finder, false);
        if out.outcome.error.is_none() {
            out.outcome.error = o.error.clone();
        }
        out.outcome.changes.push(profile_change(&f.name, "add", &f.sync_id));
        out.outcome.changed_profiles.extend(o.changed_profiles);
        out.outcome.prefs.shared.extend(o.prefs.shared);
        for (ns, v) in o.prefs.scoped {
            out.outcome.prefs.scoped.entry(ns).or_default().extend(v);
        }
        out.outcome.themes_changed |= o.themes_changed;
        out.outcome.scratchpad_changed |= o.scratchpad_changed;
        out.outcome.customizations_changed |= o.customizations_changed;
        for pid in o.customization_affected_profiles {
            out.outcome.customization_affected_profiles.insert(pid);
        }
        // Its own profile.json is where the name it was just created with
        // came from: nothing to report as a rename.
        out.outcome.changes.extend(o.changes.into_iter().filter(|c| !(c.kind == "profile" && c.action == "update")));
        out.bound.push((id, f.sync_id.clone()));
        out.created = true;
    }

    if opts.push {
        let mut taken: BTreeSet<String> = folders.iter().map(|f| f.sync_id.clone()).collect();
        for id in &plan.upload {
            let sid = new_folder_id(id, &taken);
            let mut s = crate::load_settings_in(id);
            s.sync.sync_id = Some(sid.clone());
            if crate::save_settings_in(id, &s).is_err() {
                continue;
            }
            taken.insert(sid.clone());
            out.outcome.changes.push(profile_change(&profile_display_name(id), "upload", &sid));
            out.bound.push((id.clone(), sid));
        }
    }
    out
}

// ───────────────────────────── status ─────────────────────────────

#[derive(Clone, Debug, Serialize, Default)]
pub struct WaitingView {
    pub id: String,
    pub name: String,
    pub remote_url: Option<String>,
    pub subdir: String,
    pub non_git: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct RemovalView {
    pub id: String,
    pub name: String,
    pub machine: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ConflictView {
    pub path: String,
    pub label: String,
    pub choice: Option<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct BoundView {
    pub ns: String,
    pub sync_id: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct SyncStatus {
    pub connected: bool,
    pub repo_url: Option<String>,
    pub machine: String,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// This window's profile.
    pub ns: String,
    pub sync_id: Option<String>,
    pub folder_name: Option<String>,
    /// Every bound profile on this machine, for the prefs snapshot.
    pub bound: Vec<BoundView>,
    pub conflicts: Vec<ConflictView>,
    pub waiting: Vec<WaitingView>,
    pub skipped: Vec<WaitingView>,
    pub removals: Vec<RemovalView>,
    pub notices: Vec<Change>,
    /// This profile was told to stop syncing while the machine stays
    /// connected. It is the reason it is not uploaded like the others.
    pub opted_out: bool,
    /// For an unlinked profile: the repo folder with its name, the reason it
    /// was neither uploaded nor matched for it. Preselected in the picker.
    pub suggested_folder: Option<String>,
    /// Repo profiles this machine was told not to have (deleted here), with
    /// a way back.
    pub ignored: Vec<FolderView>,
}

pub(crate) fn status(clone: &Path, id: &ProfileId) -> SyncStatus {
    let state = load_state();
    let settings = crate::load_settings_in(id);
    let mut st = SyncStatus {
        connected: is_connected(clone),
        last_sync_at: state.last_sync_at.clone(),
        last_error: state.last_error.clone(),
        ns: profile_ns(id),
        sync_id: settings.sync.sync_id.clone(),
        ..Default::default()
    };
    if !st.connected {
        return st;
    }
    // Only once connected: on macOS the name is a process spawn, and status
    // runs at every launch whether or not sync is set up.
    st.machine = machine_name();
    st.repo_url = origin_url(clone);
    st.bound = bound_profiles().into_iter().map(|(p, s)| BoundView { ns: profile_ns(&p), sync_id: s }).collect();
    st.notices = state
        .notices
        .iter()
        .filter(|n| n.profile.is_none() || n.profile.as_deref() == settings.sync.sync_id.as_deref())
        .cloned()
        .collect();
    st.opted_out = settings.sync.opted_out;
    let folders = list_folders(clone, "HEAD");
    st.ignored = folders.iter().filter(|f| state.ignored_folders.contains(&f.sync_id)).cloned().collect();
    let Some(sid) = settings.sync.sync_id.clone() else {
        let locals = local_profiles();
        if let Some(me) = locals.iter().find(|l| &l.id == id) {
            let one = std::slice::from_ref(me);
            // Against this profile alone: which free folder is "the same".
            let bound_elsewhere: Vec<LocalProfile> = locals.iter().filter(|l| l.sync_id.is_some()).cloned().collect();
            let mut view = bound_elsewhere;
            view.extend_from_slice(one);
            st.suggested_folder = plan_adoption(&folders, &view, &state.ignored_folders).waiting.first().map(|f| f.sync_id.clone());
        }
        return st;
    };
    let dir = clone.join("profiles").join(&sid);
    st.folder_name = fs::read(dir.join("profile.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string));
    let projects = crate::load_projects_in(id);
    let local_ids: BTreeSet<String> = projects.iter().map(|p| p.id.clone()).collect();
    let tombs = read_tombstones(&dir.join("removed.json"));
    if let Ok(rd) = fs::read_dir(dir.join("projects")) {
        for e in rd.flatten() {
            let Some(m) = fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).map(as_obj) else { continue };
            let Some(pid) = m.get("id").and_then(Value::as_str).map(str::to_string) else { continue };
            if local_ids.contains(settings.sync.local_id_of(&pid)) || tombs.contains_key(&pid) {
                continue;
            }
            let v = WaitingView {
                id: pid.clone(),
                name: m.get("name").and_then(Value::as_str).unwrap_or(&pid).to_string(),
                remote_url: m.get("remote_url").and_then(Value::as_str).map(str::to_string),
                subdir: m.get("subdir").and_then(Value::as_str).unwrap_or("").to_string(),
                non_git: m.get("non_git").and_then(Value::as_bool).unwrap_or(false),
            };
            if settings.sync.skipped.contains(&pid) {
                st.skipped.push(v);
            } else {
                st.waiting.push(v);
            }
        }
    }
    st.waiting.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    st.skipped.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    for (tid, t) in &tombs {
        let lid = settings.sync.local_id_of(tid);
        if settings.sync.kept.contains(tid) {
            continue;
        }
        if let Some(p) = projects.iter().find(|p| p.id == lid) {
            st.removals.push(RemovalView { id: p.id.clone(), name: p.name.clone(), machine: t.machine.clone(), at: t.at.clone() });
        }
    }
    st.conflicts = state
        .conflicts
        .iter()
        .map(|p| ConflictView { path: p.clone(), label: conflict_label(p, &projects, &settings), choice: state.choices.get(p).cloned() })
        .collect();
    st
}

fn conflict_label(path: &str, projects: &[Project], settings: &Settings) -> String {
    if path == "prefs.json" || path.ends_with("/prefs.json") {
        return "Preferences".into();
    }
    if path.ends_with("/settings.json") {
        return "Settings".into();
    }
    if let Some(name) = path.strip_prefix("themes/") {
        return format!("Theme {name}");
    }
    if let Some(rel) = path.strip_prefix("scratch/") {
        return format!("Global scratchpad: {rel}");
    }
    if let Some(after) = path.split("/scratch/projects/").nth(1) {
        if let Some((sync_pid, file_rel)) = after.split_once('/') {
            let lid = settings.sync.local_id_of(sync_pid);
            let name = projects.iter().find(|p| p.id == lid).map(|p| p.name.as_str()).unwrap_or(sync_pid);
            return format!("Project scratchpad ({name}): {file_rel}");
        } else {
            return format!("Project scratchpad: {after}");
        }
    }
    if let Some(file_rel) = path.split("/scratch/").nth(1) {
        return format!("Profile scratchpad: {file_rel}");
    }
    let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or(path);
    if path.contains("/projects/") {
        let lid = settings.sync.local_id_of(stem);
        if let Some(p) = projects.iter().find(|p| p.id == lid) {
            return p.name.clone();
        }
    }
    if path.contains("/agents/") {
        if let Some(a) = settings.agents.iter().find(|a| safe_file_stem(&a.id) == stem) {
            return a.display_name.clone();
        }
    }
    path.to_string()
}

// ───────────────────────────── locate / skip / keep ─────────────────────────────

/// Register a waiting project at a folder the user picked.
pub(crate) fn locate(clone: &Path, id: &ProfileId, sync_pid: &str, path: &str) -> Result<(), String> {
    let mut settings = crate::load_settings_in(id);
    let sid = settings.sync.sync_id.clone().ok_or("This profile is not connected.")?;
    let file = clone.join("profiles").join(&sid).join("projects").join(format!("{}.json", safe_file_stem(sync_pid)));
    let doc = fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .map(as_obj)
        .ok_or("That project is not in the sync repo any more.")?;
    let expanded = crate::expand_tilde(path);
    let pb = PathBuf::from(&expanded);
    if !pb.is_dir() {
        return Err(format!("{expanded} is not a folder."));
    }
    let canon = dunce::canonicalize(&pb).map_err(|e| e.to_string())?;
    let non_git = doc.get("non_git").and_then(Value::as_bool).unwrap_or(false);
    if !non_git && crate::git(&["rev-parse", "--git-dir"], &canon).is_err() {
        return Err(format!("{} is not a git repo.", canon.display()));
    }
    let mut projects = crate::load_projects_in(id);
    let canon_s = canon.to_string_lossy().into_owned();
    if let Some(existing) = projects.iter().find(|p| p.root_path == canon_s) {
        // Already a project here: the two are the same project.
        settings.sync.aliases.insert(sync_pid.to_string(), existing.id.clone());
        return crate::save_settings_in(id, &settings);
    }
    let remote = if non_git { String::new() } else { crate::detect_default_remote(&canon) };
    let mut p = project_from_doc(&doc, &canon, id, &remote).ok_or("That project's file could not be read.")?;
    let finder = Finder { find_repo: &default_find_repo };
    let resolve_member = |m: &Map<String, Value>| -> Option<String> {
        let url = m.get("remote_url").and_then(Value::as_str)?;
        let (repo, _) = (finder.find_repo)(id, url)?;
        let sub = m.get("subdir").and_then(Value::as_str).unwrap_or("");
        let path = if sub.is_empty() { repo } else { repo.join(sub) };
        path.is_dir().then(|| path.to_string_lossy().into_owned())
    };
    if p.project_type == ProjectType::Multi {
        let empty = Vec::new();
        let nm = doc.get("members").and_then(Value::as_array).unwrap_or(&empty);
        p.members = merge_members(&[], None, nm, &resolve_member).0;
    }
    projects.push(p);
    crate::save_projects_in(id, &projects).map_err(|e| e.to_string())
}

pub(crate) fn set_skipped(id: &ProfileId, sync_pid: &str, skip: bool) -> Result<(), String> {
    let mut s = crate::load_settings_in(id);
    s.sync.skipped.retain(|x| x != sync_pid);
    if skip {
        s.sync.skipped.push(sync_pid.to_string());
    }
    crate::save_settings_in(id, &s)
}

/// Answer Keep to "removed on another machine": the tombstone is cleared and
/// the project published again on the next sync.
pub(crate) fn keep(id: &ProfileId, local_pid: &str) -> Result<(), String> {
    let mut s = crate::load_settings_in(id);
    let sid = s.sync.sync_id_of(local_pid);
    if !s.sync.kept.contains(&sid) {
        s.sync.kept.push(sid);
    }
    crate::save_settings_in(id, &s)
}

pub(crate) fn dismiss_notices(id: &ProfileId) {
    let sid = crate::load_settings_in(id).sync.sync_id;
    let mut state = load_state();
    state.notices.retain(|n| !(n.profile.is_none() || n.profile == sid));
    save_state(&state);
}

/// Unbind this profile. The clone goes when no profile is bound any more.
pub(crate) fn disconnect(clone: &Path, id: &ProfileId) -> Result<(), String> {
    let mut s = crate::load_settings_in(id);
    s.sync = SyncLocal::default();
    crate::save_settings_in(id, &s)?;
    if bound_profiles().is_empty() {
        // The machine no longer syncs at all, so there is nothing left to opt
        // out of. A later connect starts from every profile, as a first one
        // does; the ignored folders go with the state file.
        if clone.exists() {
            fs::remove_dir_all(clone).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(state_file()?);
        }
        for pid in crate::profiles_registry().ids() {
            let mut ps = crate::load_settings_in(&pid);
            if ps.sync.opted_out {
                ps.sync.opted_out = false;
                let _ = crate::save_settings_in(&pid, &ps);
            }
        }
    } else {
        // Others still sync, and every unlinked profile is uploaded on the
        // next run: this one was just told not to be, so remember it.
        s.sync.opted_out = true;
        crate::save_settings_in(id, &s)?;
    }
    Ok(())
}

/// Called before a profile's data is deleted: the folder it followed must not
/// become a new profile here on the next sync. Nothing is removed from the
/// repo, so every other machine keeps the profile.
pub(crate) fn note_profile_deleted(id: &ProfileId) {
    let Some(sid) = crate::load_settings_in(id).sync.sync_id else { return };
    let mut state = load_state();
    if !state.ignored_folders.contains(&sid) {
        state.ignored_folders.push(sid);
        save_state(&state);
    }
}

/// Undo an ignore: the folder becomes a profile here on the next sync.
pub(crate) fn restore_folder(sync_id: &str) {
    let mut state = load_state();
    let before = state.ignored_folders.len();
    state.ignored_folders.retain(|f| f != sync_id);
    if state.ignored_folders.len() != before {
        save_state(&state);
    }
}

// ───────────────────────────── commands ─────────────────────────────

fn opts<'a>(push: bool, machine: &'a str, prefs: Option<&'a PrefsSnapshot>, finder: &'a Finder<'a>) -> RunOpts<'a> {
    RunOpts { adopt: true, push, machine, prefs, locate: &default_locate, finder }
}

fn after_apply(app: &tauri::AppHandle, res: &SyncRunResult) {
    use tauri::Emitter;
    // The menu-bar item follows the root profile's tray setting live, the way
    // settings_save does it.
    if res.changes.iter().any(|c| c.kind == "settings" && c.field.as_deref() == Some("tray_enabled")) {
        let on = crate::tray_enabled();
        let _ = crate::set_tray_visible(app, on);
    }
    if res.profiles_changed {
        // What `profile_create` and `profile_update` do for a change made by
        // hand: this one came from the repo. Titles too, for a rename.
        {
            use tauri::Manager;
            let reg = crate::profiles_registry();
            for p in &reg.profiles {
                let id = reg.id_for(&p.slug);
                if id.is_root() {
                    continue;
                }
                if let Some(win) = app.get_webview_window(&id.window_label()) {
                    let _ = win.set_title(&format!("Termic - {}", p.name));
                }
            }
        }
        crate::forget_task_window(None);
        crate::rebuild_tray_menu(app);
        let _ = app.emit("termic://profiles-changed", ());
    }
    if res.customizations_changed || !res.customization_affected_profiles.is_empty() {
        let all_projects = crate::load_projects_all();
        let all_tasks = crate::load_tasks_all();
        for pid in &res.customization_affected_profiles {
            if let Ok(pdir) = crate::profile_dir(pid) {
                let _ = crate::customizations::ensure_builtin_skills(&pdir);
                for p in all_projects.iter().filter(|p| &p.profile == pid) {
                    for t in all_tasks.iter().filter(|t| !t.archived && t.project_id == p.id) {
                        let _ = crate::customizations::reconcile_customizations(&pdir, std::path::Path::new(&t.path), crate::effective_customization_mode(p), &t.cli);
                    }
                }
            }
        }
    }
    if !res.changed_profiles.is_empty() || res.themes_changed || res.scratchpad_changed || res.customizations_changed || !res.prefs.is_empty() || !res.changes.is_empty() {
        let _ = app.emit("termic://sync-changed", serde_json::json!({
            "profiles": res.changed_profiles,
            "themes": res.themes_changed,
            "scratchpad": res.scratchpad_changed,
            "customizations": res.customizations_changed,
        }));
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_status(window: tauri::Window) -> Result<SyncStatus, String> {
    let id = crate::window_profile(&window);
    blocking(move || {
        let clone = sync_dir()?;
        Ok(status(&clone, &id))
    })
    .await?
}

#[tauri::command]
pub async fn sync_connect(url: String) -> Result<ConnectInfo, String> {
    blocking(move || {
        let _g = SYNC_LOCK.lock();
        connect(&sync_dir()?, &url)
    })
    .await?
}

#[tauri::command]
pub async fn sync_preview(window: tauri::Window, folder: Option<String>, prefs: Option<PrefsSnapshot>) -> Result<Vec<Change>, String> {
    let id = crate::window_profile(&window);
    blocking(move || {
        let _g = SYNC_LOCK.lock();
        let finder = Finder { find_repo: &default_find_repo };
        preview(&sync_dir()?, &id, folder.as_deref(), prefs.as_ref(), &finder)
    })
    .await?
}

#[tauri::command]
pub async fn sync_bind(app: tauri::AppHandle, window: tauri::Window, folder: Option<String>, prefs: Option<PrefsSnapshot>) -> Result<SyncRunResult, String> {
    let id = crate::window_profile(&window);
    let res = blocking(move || {
        let _g = SYNC_LOCK.lock();
        let clone = sync_dir()?;
        if !is_connected(&clone) {
            return Err("Connect a repo first.".to_string());
        }
        let machine = machine_name();
        let finder = Finder { find_repo: &default_find_repo };
        Ok(bind(&clone, &id, folder, &opts(true, &machine, prefs.as_ref(), &finder)))
    })
    .await??;
    after_apply(&app, &res);
    Ok(res)
}

#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle, prefs: Option<PrefsSnapshot>) -> Result<SyncRunResult, String> {
    let res = blocking(move || {
        let _g = SYNC_LOCK.lock();
        let clone = sync_dir()?;
        let machine = machine_name();
        let finder = Finder { find_repo: &default_find_repo };
        Ok::<_, String>(run_core(&clone, &opts(true, &machine, prefs.as_ref(), &finder)))
    })
    .await??;
    after_apply(&app, &res);
    Ok(res)
}

/// The sync on launch: once per process, whichever window asks first. The
/// window calls it after first paint, so it never delays startup.
#[tauri::command]
pub async fn sync_launch_pull(app: tauri::AppHandle, prefs: Option<PrefsSnapshot>) -> Result<SyncRunResult, String> {
    if LAUNCH_PULLED.swap(true, Ordering::SeqCst) {
        return Ok(SyncRunResult { skipped: true, ..Default::default() });
    }
    let res = blocking(move || {
        let clone = sync_dir()?;
        if !is_connected(&clone) || bound_profiles().is_empty() {
            return Ok(SyncRunResult { skipped: true, ..Default::default() });
        }
        let _g = SYNC_LOCK.lock();
        let machine = machine_name();
        let finder = Finder { find_repo: &default_find_repo };
        Ok::<_, String>(run_core(&clone, &opts(true, &machine, prefs.as_ref(), &finder)))
    })
    .await??;
    after_apply(&app, &res);
    Ok(res)
}

/// A sync when a window regains focus. Not latched for the process
/// the way `sync_launch_pull` is: `focus_pull_due` decides, under `SYNC_LOCK`,
/// so every open window shares one answer. An outstanding conflict is returned
/// and not fetched over.
#[tauri::command]
pub async fn sync_focus_pull(app: tauri::AppHandle, prefs: Option<PrefsSnapshot>) -> Result<SyncRunResult, String> {
    let res = blocking(move || {
        let _g = SYNC_LOCK.lock();
        let clone = sync_dir()?;
        if !is_connected(&clone) || bound_profiles().is_empty() {
            return Ok(SyncRunResult { skipped: true, ..Default::default() });
        }
        let state = load_state();
        if !state.conflicts.is_empty() {
            return Ok(SyncRunResult { skipped: true, conflicts: state.conflicts.clone(), ..Default::default() });
        }
        if !focus_pull_due(&state, chrono::Utc::now()) {
            return Ok(SyncRunResult { skipped: true, ..Default::default() });
        }
        let machine = machine_name();
        let finder = Finder { find_repo: &default_find_repo };
        Ok::<_, String>(run_core(&clone, &opts(true, &machine, prefs.as_ref(), &finder)))
    })
    .await??;
    after_apply(&app, &res);
    Ok(res)
}

/// Record a choice for one conflicting file; once every file has one, settle
/// them and sync.
#[tauri::command]
pub async fn sync_resolve(app: tauri::AppHandle, path: String, choice: String, prefs: Option<PrefsSnapshot>) -> Result<SyncRunResult, String> {
    if choice != "local" && choice != "remote" {
        return Err("choice must be local or remote".into());
    }
    let res = blocking(move || {
        let _g = SYNC_LOCK.lock();
        let mut state = load_state();
        if !state.conflicts.contains(&path) {
            return Err("That file is not in conflict any more.".to_string());
        }
        state.choices.insert(path, choice);
        save_state(&state);
        if state.conflicts.iter().any(|p| !state.choices.contains_key(p)) {
            return Ok(SyncRunResult { ok: true, skipped: true, ..Default::default() });
        }
        let clone = sync_dir()?;
        let machine = machine_name();
        let finder = Finder { find_repo: &default_find_repo };
        Ok(resolve(&clone, &opts(true, &machine, prefs.as_ref(), &finder)))
    })
    .await??;
    after_apply(&app, &res);
    Ok(res)
}

#[tauri::command]
pub async fn sync_locate(window: tauri::Window, project_id: String, path: String) -> Result<(), String> {
    let id = crate::window_profile(&window);
    blocking(move || {
        let _g = SYNC_LOCK.lock();
        locate(&sync_dir()?, &id, &project_id, &path)
    })
    .await?
}

#[tauri::command]
pub async fn sync_skip(window: tauri::Window, project_id: String, skip: bool) -> Result<(), String> {
    let id = crate::window_profile(&window);
    blocking(move || set_skipped(&id, &project_id, skip)).await?
}

#[tauri::command]
pub async fn sync_keep(window: tauri::Window, project_id: String) -> Result<(), String> {
    let id = crate::window_profile(&window);
    blocking(move || keep(&id, &project_id)).await?
}

#[tauri::command]
pub async fn sync_dismiss_notices(window: tauri::Window) -> Result<(), String> {
    let id = crate::window_profile(&window);
    blocking(move || dismiss_notices(&id)).await
}

/// Bring back a repo profile that was deleted on this machine: it is created
/// again by the sync this runs.
#[tauri::command]
pub async fn sync_restore_folder(app: tauri::AppHandle, folder: String, prefs: Option<PrefsSnapshot>) -> Result<SyncRunResult, String> {
    let res = blocking(move || {
        let _g = SYNC_LOCK.lock();
        restore_folder(&folder);
        let clone = sync_dir()?;
        let machine = machine_name();
        let finder = Finder { find_repo: &default_find_repo };
        Ok::<_, String>(run_core(&clone, &opts(true, &machine, prefs.as_ref(), &finder)))
    })
    .await??;
    after_apply(&app, &res);
    Ok(res)
}

#[tauri::command]
pub async fn sync_disconnect(window: tauri::Window) -> Result<(), String> {
    let id = crate::window_profile(&window);
    blocking(move || {
        let _g = SYNC_LOCK.lock();
        disconnect(&sync_dir()?, &id)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentCapabilities, DockerRebuildFrequency, PostLaunchCapture, SandboxMode};

    fn keys_of<T: Serialize>(v: &T) -> BTreeSet<String> {
        as_obj(serde_json::to_value(v).unwrap()).keys().cloned().collect()
    }

    fn hm(k: &str, v: &str) -> HashMap<String, String> {
        HashMap::from([(k.to_string(), v.to_string())])
    }

    // Exhaustive struct literals, no `..Default::default()`: a field added to
    // any of these structs is a compile error here until it is populated, and
    // once populated, `assert_classified` fails until it is in a list. Every
    // Option is Some and every Vec non-empty so `skip_serializing_if` cannot
    // hide a key.
    fn full_member() -> ProjectMember {
        ProjectMember {
            root_path: "/Users/u/src/api".into(),
            name: "api".into(),
            non_git: false,
            base_branch: "origin/main".into(),
            setup_script: "s".into(),
            run_script: "r".into(),
            archive_script: "a".into(),
            files_to_copy: vec![".env".into()],
            sandbox_rw_paths: vec!["/Users/u/cache".into()],
            sandbox_allowed_hosts: vec!["acme.com".into()],
            project_id: "legacy".into(),
        }
    }

    fn full_project() -> Project {
        Project {
            default_role: None,
            id: "p1".into(),
            name: "app".into(),
            root_path: "/Users/u/src/app".into(),
            tasks_path: "/Users/u/tasks".into(),
            base_branch: "origin/main".into(),
            remote: "origin".into(),
            preview_url: "http://localhost:3000".into(),
            preview_browser: Some("firefox".into()),
            files_to_copy: vec![".env".into()],
            setup_script: "npm i".into(),
            run_script: "npm run dev".into(),
            archive_script: "true".into(),
            default_cli: "claude".into(),
            created: "2026-01-01T00:00:00Z".into(),
            default_sandbox: true,
            default_sandbox_mode: Some(SandboxMode::Monitor),
            default_docker: true,
            default_yolo: Some(true),
            docker_extra_mounts: vec!["/Users/u/x:/x".into()],
            sandbox_rw_paths: vec!["/Users/u/rw".into()],
            sandbox_allowed_hosts: vec!["acme.com".into()],
            project_type: ProjectType::Multi,
            members: vec![full_member()],
            spotlight_enabled: true,
            code_intel_auto: Some("main".into()),
            code_intel_languages: Some(vec!["rust".into()]),
            code_intel_settings: Some(HashMap::from([("rust".to_string(), serde_json::json!({"a": 1}))])),
            code_intel_servers: Some(hm("python", "ty")),
            code_intel_commands: Some(hm("python", "pylsp")),
            non_git: false,
            group: Some("work".into()),
            run_scripts: vec![crate::repo_config::RunCommand { label: "t".into(), command: "make".into() }],
            on_pr_merge: Some("ask".into()),
            watch_pr_comments: true,
            watch_untrusted_comments: true,
            extra_named_ports: vec!["DB_PORT".into()],
            customization_mode: crate::customizations::CustomizationMode::Inherit,
            profile: ProfileId::Root,
        }
    }

    fn full_agent() -> Agent {
        Agent {
            default_role: None,
            id: "my-agent".into(),
            display_name: "My agent".into(),
            command: "claude".into(),
            args: vec!["--x".into()],
            icon_id: "claude".into(),
            color: "#d97757".into(),
            builtin: false,
            disabled: true,
            capabilities: AgentCapabilities::default(),
            env: hm("API_KEY", "s3cret-token"),
            docker_env: hm("API_KEY", "s3cret-docker"),
            pass_env: vec!["GITHUB_TOKEN".into()],
            sandbox_allowed_paths: vec!["$HOME/.my".into()],
            sandbox_allowed_hosts: vec!["api.acme.com".into()],
            work_done: true,
            accounts: vec!["Work".into()],
            default_account: Some("Work".into()),
            auto_switch_account: true,
            adopted_account: Some("Work".into()),
            extends: Some("claude".into()),
            kind: "agent".into(),
            post_launch_capture: Some(PostLaunchCapture { command: "x".into() }),
        }
    }

    fn full_settings() -> Settings {
        Settings {
            customizations_enabled: Some(true),
            roles: Vec::new(),
            secrets: Vec::new(),
            env_guard: vec![crate::env_guard::Rule { name: "STRIPE_SECRET_KEY".into(), all: true }],
            repos_dir: "/Users/u/src".into(),
            welcomed: true,
            agents: vec![full_agent()],
            sandbox_default_rw_paths: vec!["/Users/u/rw".into()],
            sandbox_default_allowed_hosts: vec!["acme.com".into()],
            docker_sandbox_enabled: true,
            docker_rebuild_frequency: DockerRebuildFrequency::Weekly,
            docker_rebuild_auto: true,
            docker_agent_extra_dirs: HashMap::from([("claude".to_string(), vec![".x".to_string()])]),
            docker_agent_persist_enabled: HashMap::from([("claude".to_string(), true)]),
            docker_default_extra_mounts: vec!["/a:/b".into()],
            docker_shared_config_dirs: vec![".config/gh".into()],
            file_tree_exclude: vec!["dist".into()],
            task_port_min: 4000,
            task_port_max: 5000,
            schema_version: 1,
            fetch_before_create: Some(true),
            discovery_dismissed: vec!["/Users/u/old".into()],
            cli_enabled: true,
            cli_default_migrated: true,
            hooks_auto_default_migrated: true,
            cli_user_link_installed: true,
            mcp_enabled: true,
            mcp_bind_address: "0.0.0.0".into(),
            mcp_port: 8123,
            lan_sharing_enabled: true,
            close_action: Some("ask".into()),
            tray_enabled: Some(true),
            auto_install_hooks: true,
            worktree_symlink_paths: vec![".claude".into()],
            default_tasks_path: "~/termic/tasks".into(),
            preview_browser: "firefox".into(),
            sync: SyncLocal { sync_id: Some("abc".into()), ..Default::default() },
        }
    }

    fn assert_classified(what: &str, keys: &BTreeSet<String>, sync: &[&str], local: &[&str]) {
        let s: BTreeSet<&str> = sync.iter().copied().collect();
        let l: BTreeSet<&str> = local.iter().copied().collect();
        let both: Vec<&&str> = s.intersection(&l).collect();
        assert!(both.is_empty(), "{what}: in both SYNC and LOCAL: {both:?}");
        let unclassified: Vec<&String> = keys.iter().filter(|k| !s.contains(k.as_str()) && !l.contains(k.as_str())).collect();
        assert!(
            unclassified.is_empty(),
            "{what}: serialized fields in neither list. Add each to the SYNC or LOCAL list in config_sync.rs \
             (and say why if it is not obvious): {unclassified:?}"
        );
        let stale: Vec<&&str> = s.union(&l).filter(|k| !keys.contains(**k)).collect();
        assert!(stale.is_empty(), "{what}: listed but not a serialized field (renamed or removed?): {stale:?}");
    }

    #[test]
    fn focus_pull_waits_out_the_gap_and_a_conflict() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-08T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let mut state = SyncState::default();
        assert!(focus_pull_due(&state, now), "never pulled: due");

        state.last_pull_at = Some("2026-10-08T11:56:00Z".into());
        assert!(!focus_pull_due(&state, now), "four minutes is inside the gap");
        state.last_pull_at = Some("2026-10-08T11:55:00Z".into());
        assert!(focus_pull_due(&state, now), "five minutes is due");

        // A success newer than the attempt holds the gap, and the reverse.
        state.last_sync_at = Some("2026-10-08T11:58:00Z".into());
        assert!(!focus_pull_due(&state, now), "a newer success holds the gap");
        state.last_pull_at = Some("2026-10-08T11:59:00Z".into());
        state.last_sync_at = Some("2026-10-08T11:50:00Z".into());
        assert!(!focus_pull_due(&state, now), "a newer attempt holds the gap");

        state.last_pull_at = None;
        state.last_sync_at = None;
        state.conflicts.push("profiles/a/settings.json".into());
        assert!(!focus_pull_due(&state, now), "a waiting conflict is not pulled over");

        state.conflicts.clear();
        state.last_pull_at = Some("not a date".into());
        assert!(focus_pull_due(&state, now), "an unreadable stamp does not block");
        state.last_sync_at = Some("2026-10-08T11:58:00Z".into());
        assert!(!focus_pull_due(&state, now), "a bad attempt stamp still leaves the success in force");
    }

    #[test]
    fn classification_covers_every_field() {
        assert_classified("Project", &keys_of(&full_project()), PROJECT_SYNC, PROJECT_LOCAL);
        assert_classified("ProjectMember", &keys_of(&full_member()), MEMBER_SYNC, MEMBER_LOCAL);
        assert_classified("Settings", &keys_of(&full_settings()), SETTINGS_SYNC, SETTINGS_LOCAL);
        assert_classified("Agent", &keys_of(&full_agent()), AGENT_SYNC, AGENT_LOCAL);
        for k in SAFETY_PROJECT {
            assert!(PROJECT_SYNC.contains(k), "{k}: a safety default that does not sync cannot need a notice");
        }
    }

    #[test]
    fn env_and_docker_env_never_leave_the_machine() {
        let a = full_agent();
        let bytes = String::from_utf8(file_bytes(&agent_doc(&a))).unwrap();
        assert!(!bytes.contains("s3cret"), "{bytes}");
        assert!(!bytes.contains("\"env\"") && !bytes.contains("docker_env"), "{bytes}");
        let sbytes = String::from_utf8(file_bytes(&settings_doc(&full_settings()))).unwrap();
        assert!(!sbytes.contains("s3cret") && !sbytes.contains("\"agents\""), "{sbytes}");
        assert!(!sbytes.contains("/Users/u"), "no local path in settings.json: {sbytes}");
    }

    #[test]
    fn a_hand_edited_file_cannot_set_a_local_field() {
        let mut settings = Settings { agents: vec![full_agent()], ..Default::default() };
        let mut hostile = as_obj(agent_doc(&full_agent()));
        hostile.insert("env".into(), serde_json::json!({"EVIL": "1"}));
        hostile.insert("sandbox_allowed_paths".into(), serde_json::json!(["/"]));
        hostile.insert("display_name".into(), Value::String("Renamed".into()));
        let mut changes = Vec::new();
        apply_agent(&mut settings, "my-agent", None, Some(&hostile), "sid", &mut changes);
        let a = &settings.agents[0];
        assert_eq!(a.display_name, "Renamed");
        assert_eq!(a.env, hm("API_KEY", "s3cret-token"), "env must stay this machine's");
        assert_eq!(a.sandbox_allowed_paths, vec!["$HOME/.my".to_string()]);

        let mut p = full_project();
        let mut doc = as_obj(project_doc(&p, 0, None, &|_| None));
        doc.insert("root_path".into(), Value::String("/evil".into()));
        doc.insert("sandbox_rw_paths".into(), serde_json::json!(["/"]));
        patch_project(&mut p, None, &doc, &|_| None, None);
        assert_eq!(p.root_path, "/Users/u/src/app");
        assert_eq!(p.sandbox_rw_paths, vec!["/Users/u/rw".to_string()]);
    }

    #[test]
    fn export_is_deterministic() {
        // The same record built from HashMaps filled in opposite orders must
        // give byte-identical files: sorted keys, pretty-printed, newline.
        let mut a = full_project();
        let mut b = full_project();
        let mut m1 = HashMap::new();
        m1.insert("rust".to_string(), serde_json::json!({"z": 1, "a": 2}));
        m1.insert("python".to_string(), serde_json::json!({"b": 1}));
        let mut m2 = HashMap::new();
        m2.insert("python".to_string(), serde_json::json!({"b": 1}));
        m2.insert("rust".to_string(), serde_json::json!({"a": 2, "z": 1}));
        a.code_intel_settings = Some(m1);
        b.code_intel_settings = Some(m2);
        let loc = RepoLoc { remote_url: Some("https://git.acme.com/acme/app.git".into()), subdir: "packages/app".into() };
        let fa = file_bytes(&project_doc(&a, 3, Some(&loc), &|_| None));
        let fb = file_bytes(&project_doc(&b, 3, Some(&loc), &|_| None));
        assert_eq!(fa, fb);
        let text = String::from_utf8(fa).unwrap();
        assert!(text.ends_with("}\n"), "trailing newline");
        assert!(text.contains("\n  \"archive_script\""), "pretty-printed");
        // Top-level keys come out sorted.
        let top: Vec<&str> = text.lines().filter(|l| l.starts_with("  \"")).map(|l| l.trim().split('"').nth(1).unwrap()).collect();
        let mut sorted = top.clone();
        sorted.sort();
        assert_eq!(top, sorted);
        assert!(text.contains("\"remote_url\": \"https://git.acme.com/acme/app.git\""));
        assert!(text.contains("\"subdir\": \"packages/app\""));
        // Member paths stay local, member URLs travel.
        assert!(!text.contains("/Users/u"), "{text}");
    }

    #[test]
    fn a_pull_changes_only_the_fields_that_changed_upstream() {
        // Upstream renamed the project and turned YOLO on; this machine
        // changed the preview URL since the last sync. Both survive, and
        // nothing local moves.
        let mut p = full_project();
        let base = as_obj(project_doc(&p, 0, None, &|_| None));
        let mut new = base.clone();
        new.insert("name".into(), Value::String("App".into()));
        new.insert("default_yolo".into(), Value::Bool(false));
        p.preview_url = "http://localhost:4000".into();
        let changes = patch_project(&mut p, Some(&base), &new, &|_| None, Some("sid"));
        assert_eq!(p.name, "App");
        assert_eq!(p.default_yolo, Some(false));
        assert_eq!(p.preview_url, "http://localhost:4000", "a local edit to another field survives");
        assert_eq!(p.root_path, "/Users/u/src/app");
        assert_eq!(p.tasks_path, "/Users/u/tasks");
        assert_eq!(p.members[0].root_path, "/Users/u/src/api", "a member keeps its local path");
        let yolo = changes.iter().find(|c| c.field.as_deref() == Some("default_yolo")).expect("a change line");
        assert!(yolo.safety, "a YOLO default change is flagged");
        assert!(!changes.iter().find(|c| c.field.as_deref() == Some("name")).unwrap().safety);
    }

    #[test]
    fn members_merge_three_way_by_name() {
        let local = vec![
            ProjectMember { name: "api".into(), root_path: "/l/api".into(), run_script: "old".into(), ..Default::default() },
            ProjectMember { name: "added-here".into(), root_path: "/l/new".into(), ..Default::default() },
            ProjectMember { name: "gone-upstream".into(), root_path: "/l/gone".into(), ..Default::default() },
        ];
        let base = vec![
            serde_json::json!({"name": "api", "run_script": "old"}),
            serde_json::json!({"name": "gone-upstream"}),
        ];
        let new = vec![
            serde_json::json!({"name": "api", "run_script": "new", "root_path": "/evil"}),
            serde_json::json!({"name": "web", "remote_url": "https://git.acme.com/acme/web.git"}),
            serde_json::json!({"name": "docs", "remote_url": "https://git.acme.com/acme/docs.git"}),
        ];
        let resolve = |m: &Map<String, Value>| -> Option<String> {
            (m.get("name").and_then(Value::as_str) == Some("web")).then(|| "/l/web".to_string())
        };
        let (out, unresolved) = merge_members(&local, Some(&base), &new, &resolve);
        let names: Vec<&str> = out.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["api", "web", "added-here"]);
        assert_eq!(out[0].run_script, "new");
        assert_eq!(out[0].root_path, "/l/api");
        assert_eq!(out[1].root_path, "/l/web");
        assert_eq!(unresolved, vec!["docs".to_string()]);
    }

    #[test]
    fn positions_move_as_few_files_as_possible() {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let existing: HashMap<String, u64> = [("a", 0), ("b", 1), ("c", 2), ("d", 3)].iter().map(|(k, v)| (k.to_string(), *v)).collect();
        // Removing one rewrites nothing else.
        let p = assign_positions(&ids(&["a", "c", "d"]), &existing);
        assert_eq!((p["a"], p["c"], p["d"]), (0, 2, 3));
        // Moving the last to the front rewrites only what had to move.
        let p = assign_positions(&ids(&["d", "a", "b", "c"]), &existing);
        assert_eq!(p["d"], 3);
        assert!(p["a"] > 3 && p["b"] > p["a"] && p["c"] > p["b"]);
        // A new one goes after its predecessor.
        let p = assign_positions(&ids(&["a", "b", "new", "c", "d"]), &existing);
        assert_eq!(p["new"], 2);
        assert!(p["c"] > 2 && p["d"] > p["c"]);
    }

    #[test]
    fn remote_urls_compare_across_spellings() {
        let want = "git.acme.com/acme/app";
        for u in [
            "git@git.acme.com:acme/app.git",
            "ssh://git@git.acme.com/acme/app.git",
            "ssh://git@git.acme.com:22/acme/app",
            "https://git.acme.com/acme/app.git",
            "https://alice@GIT.ACME.COM/acme/app/",
        ] {
            assert_eq!(normalize_remote_url(u), want, "{u}");
        }
        assert_ne!(normalize_remote_url("https://git.acme.com/acme/App"), want, "the path keeps its case");
    }

    #[test]
    fn changed_keys_treats_absent_as_null() {
        let a = as_obj(serde_json::json!({"x": 1, "y": null}));
        let b = as_obj(serde_json::json!({"x": 1}));
        assert!(changed_keys(Some(&a), &b).is_empty());
        let c = as_obj(serde_json::json!({"x": 2, "z": true}));
        assert_eq!(changed_keys(Some(&a), &c), vec!["x".to_string(), "z".to_string()]);
        // A first connect applies only what the file sets.
        assert_eq!(changed_keys(None, &a), vec!["x".to_string()]);
    }

    #[test]
    fn a_repo_url_is_one_of_the_forms_a_remote_can_take() {
        for ok in [
            "https://github.com/acme/app.git",
            "http://git.acme.com/acme/app.git",
            "ssh://git@git.acme.com:2222/acme/app.git",
            "git://git.acme.com/acme/app.git",
            "file:///Users/alice/sync.git",
            "file:///C:/Users/alice/sync.git",
            "git@github.com:acme/app.git",
            "bob.smith.ext@git.internal.acme.com:acme/app.git",
        ] {
            assert_eq!(check_repo_url(ok), Ok(()), "{ok}");
        }
        for bad in [
            "ext::sh -c touch% /tmp/pwned",
            "ext::git-upload-pack /tmp/x",
            "fd::17",
            "fd::3,4/x",
            "-uhttps://github.com/acme/app.git",
            "--upload-pack=touch /tmp/pwned",
            "ssh://-oProxyCommand=touch%20pwned/x",
            "ssh://git@-oProxyCommand=x/acme/app.git",
            "file://-x",
            "https://",
            "ftp://git.acme.com/acme/app.git",
            "HTTPS://github.com/acme/app.git",
            "/Users/alice/sync.git",
            "../sync.git",
            "github.com:acme/app.git",
            "git@github.com",
            "git@:acme/app.git",
            "-git@github.com:acme/app.git",
            "git@-oProxyCommand=x:acme/app.git",
            "ext::sh@x:y",
            "https://github.com/acme/app.git\n--upload-pack=x",
        ] {
            let err = check_repo_url(bad).unwrap_err();
            assert!(err.starts_with(BAD_URL), "{bad}: {err}");
            assert!(!err.contains('\u{2014}'), "no em dash: {err}");
        }
    }

    #[test]
    fn the_settings_page_knows_the_bad_url_prefix() {
        let tsx = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/components/settings/SyncSection.tsx");
        let tsx = fs::read_to_string(tsx).unwrap();
        assert!(tsx.contains(&format!("const BAD_URL = \"{BAD_URL}\";")), "SyncSection.tsx no longer matches BAD_URL");
    }

    #[test]
    fn connect_refuses_a_bad_url_before_git_runs() {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path().join("sync");
        let err = connect(&clone, "  ext::sh -c touch% pwned  ").unwrap_err();
        assert!(err.starts_with(BAD_URL), "{err}");
        assert!(!dir.path().join("sync.partial").exists() && !clone.exists());
    }

    #[test]
    fn the_clone_url_follows_the_end_of_options() {
        let args = clone_args("https://github.com/acme/app.git", "/tmp/sync.partial");
        let dd = args.iter().position(|a| *a == "--").expect("a -- in the clone argv");
        assert_eq!(&args[dd + 1..], ["https://github.com/acme/app.git", "/tmp/sync.partial"]);
        assert!(args[..dd].iter().all(|a| a.starts_with('-') || *a == "clone"), "{args:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_network_op_runs_with_ext_off_whatever_the_config_says() {
        // A config that allows `ext::`, the way a user's global one might.
        let dir = tempfile::tempdir().unwrap();
        crate::git(&["init", "-q"], dir.path()).unwrap();
        crate::git(&["config", "protocol.ext.allow", "always"], dir.path()).unwrap();
        let mark = dir.path().join("ran");
        let url = format!("ext::sh -c touch% {}", mark.display());
        // The control: plain git honours that config and runs the command.
        let _ = crate::git(&["ls-remote", &url], dir.path());
        assert!(mark.exists(), "control: the config should let ext:: run");
        fs::remove_file(&mark).unwrap();
        assert!(git_bounded(&["ls-remote", &url], dir.path(), Duration::from_secs(20)).is_err());
        assert!(!mark.exists(), "git_bounded ran the ext:: transport");
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_network_op_is_killed_at_the_deadline() {
        // `ext::` runs a command as the transport; `sleep` never speaks the
        // protocol, so git waits on it until the deadline kills the group.
        let dir = tempfile::tempdir().unwrap();
        let t = std::time::Instant::now();
        let err = git_bounded(&["-c", "protocol.ext.allow=always", "ls-remote", "ext::sleep 30"], dir.path(), Duration::from_millis(800))
            .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(10), "took {:?}", t.elapsed());
    }

    #[test]
    fn the_clone_is_under_the_sandbox_deny() {
        crate::test_support::with_scratch_data_dir(|_| {
            let control = crate::sandbox::control_plane_paths();
            let denied = PathBuf::from(control.data_dir.expect("a data dir"));
            let clone = sync_dir().unwrap();
            let canon_parent = dunce::canonicalize(clone.parent().unwrap()).unwrap();
            assert!(canon_parent.join("sync").starts_with(&denied), "{} not under {}", clone.display(), denied.display());
        });
    }

    #[test]
    fn two_local_profiles_cannot_follow_one_folder() {
        crate::test_support::with_scratch_data_dir(|dir| {
            let profile = |slug: &str| crate::profiles::Profile {
                slug: slug.into(), name: slug.into(), accent: "#d97757".into(),
                order: 0, last_focused_at: None, open_at_quit: false,
            };
            let reg = crate::profiles::Registry { profiles: vec![profile("home"), profile("work")], root_slug: Some("home".into()) };
            crate::profiles::save_registry(dir, &reg).unwrap();
            let mut s = crate::load_settings_in(&ProfileId::Root);
            s.sync.sync_id = Some("shared-folder".into());
            crate::save_settings_in(&ProfileId::Root, &s).unwrap();
            let finder = Finder { find_repo: &|_, _| None };
            let opts = RunOpts { adopt: true, push: false, machine: "m", prefs: None, locate: &|_, _| None, finder: &finder };
            let work = ProfileId::Slug("work".into());
            let r = bind(&dir.join("sync"), &work, Some("shared-folder".into()), &opts);
            assert!(r.error.as_deref().is_some_and(|e| e.contains("already follows")), "{r:?}");
            assert_eq!(crate::load_settings_in(&work).sync.sync_id, None, "nothing was bound");
        });
    }

    #[test]
    fn an_agent_removed_elsewhere_is_applied_and_kept_as_a_notice() {
        let mut settings = Settings { agents: vec![full_agent()], ..Default::default() };
        let base = as_obj(agent_doc(&full_agent()));
        let mut changes = Vec::new();
        apply_agent(&mut settings, "my-agent", Some(&base), None, "sid", &mut changes);
        assert!(settings.agents.is_empty(), "applied, not asked");
        let mut state = SyncState::default();
        record_notices(&mut state, &changes);
        assert_eq!(state.notices.len(), 1);
        let n = &state.notices[0];
        assert_eq!((n.kind.as_str(), n.action.as_str(), n.target.as_str()), ("agent", "remove", "My agent"));
        assert_eq!(n.profile.as_deref(), Some("sid"));
        // A built-in is never removed, so it is never announced either.
        let mut builtin = full_agent();
        builtin.builtin = true;
        let mut settings = Settings { agents: vec![builtin], ..Default::default() };
        let mut changes = Vec::new();
        apply_agent(&mut settings, "my-agent", Some(&base), None, "sid", &mut changes);
        assert_eq!(settings.agents.len(), 1);
        assert!(changes.is_empty());
    }

    // ── the git loop, two machines, one bare repo ──

    struct Machine {
        data: tempfile::TempDir,
        xdg: tempfile::TempDir,
        name: &'static str,
    }

    impl Machine {
        fn new(name: &'static str) -> Self {
            Machine { data: tempfile::tempdir().unwrap(), xdg: tempfile::tempdir().unwrap(), name }
        }
        fn enter(&self) {
            // SAFETY: the caller holds DATA_DIR_LOCK for the whole test.
            unsafe {
                std::env::set_var("TERMIC_DATA_DIR", self.data.path());
                std::env::set_var("XDG_CONFIG_HOME", self.xdg.path());
            }
        }
        fn clone_dir(&self) -> PathBuf {
            self.enter();
            sync_dir().unwrap()
        }
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn make_repo(dir: &Path, url: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        sh(dir, &["init", "-q"]);
        sh(dir, &["remote", "add", "origin", url]);
        dunce::canonicalize(dir).unwrap()
    }

    fn find(p: &ProfileId, url: &str) -> Option<(PathBuf, String)> {
        default_find_repo(p, url)
    }

    fn run(m: &Machine, push: bool, prefs: Option<&PrefsSnapshot>) -> SyncRunResult {
        let clone = m.clone_dir();
        let finder = Finder { find_repo: &find };
        run_core(&clone, &RunOpts { adopt: true, push, machine: m.name, prefs, locate: &default_locate, finder: &finder })
    }

    fn settings_path(m: &Machine) -> PathBuf {
        m.data.path().join("settings.json")
    }

    fn with_settings(m: &Machine, f: impl FnOnce(&mut Settings)) {
        m.enter();
        let mut s = crate::load_settings_in(&ProfileId::Root);
        f(&mut s);
        crate::save_settings_in(&ProfileId::Root, &s).unwrap();
    }

    fn projects(m: &Machine) -> Vec<Project> {
        m.enter();
        crate::load_projects_in(&ProfileId::Root)
    }

    #[test]
    fn two_machines_sync_through_a_bare_repo() {
        let _lock = crate::test_support::DATA_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_data = std::env::var_os("TERMIC_DATA_DIR");
        let prev_xdg = std::env::var_os("XDG_CONFIG_HOME");
        let out = std::panic::catch_unwind(two_machines_body);
        // SAFETY: still under DATA_DIR_LOCK.
        unsafe {
            match prev_data { Some(v) => std::env::set_var("TERMIC_DATA_DIR", v), None => std::env::remove_var("TERMIC_DATA_DIR") }
            match prev_xdg { Some(v) => std::env::set_var("XDG_CONFIG_HOME", v), None => std::env::remove_var("XDG_CONFIG_HOME") }
        }
        if let Err(e) = out {
            std::panic::resume_unwind(e);
        }
    }

    fn two_machines_body() {
        let remote = tempfile::tempdir().unwrap();
        let bare = remote.path().join("config.git");
        sh(remote.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
        let url = format!("file://{}", bare.to_string_lossy());
        const APP_URL: &str = "https://git.acme.com/acme/app.git";

        // ── machine A: a project, a plain folder, a custom agent with a secret
        let a = Machine::new("machine-a");
        a.enter();
        let a_app = make_repo(&a.data.path().join("src/app"), APP_URL);
        let a_notes = a.data.path().join("notes");
        fs::create_dir_all(&a_notes).unwrap();
        let app = Project {
            id: "11111111-aaaa".into(), name: "app".into(), root_path: a_app.to_string_lossy().into(),
            remote: "origin".into(), base_branch: "origin/main".into(), default_cli: "claude".into(),
            sandbox_rw_paths: vec!["/Users/alice/secret-cache".into()], default_yolo: Some(false),
            ..Default::default()
        };
        let notes = Project {
            id: "22222222-bbbb".into(), name: "notes".into(), root_path: a_notes.to_string_lossy().into(),
            non_git: true, ..Default::default()
        };
        crate::save_projects_in(&ProfileId::Root, &[app.clone(), notes.clone()]).unwrap();
        with_settings(&a, |s| {
            let mut ag = full_agent();
            ag.disabled = false;
            s.agents.push(ag);
        });
        fs::create_dir_all(a.xdg.path().join("termic/themes")).unwrap();
        fs::write(a.xdg.path().join("termic/themes/mine.json"), "{\"id\":\"mine\"}\n").unwrap();
        let a_global_scratch = a.data.path().join("scratch/global");
        fs::create_dir_all(&a_global_scratch).unwrap();
        fs::write(a_global_scratch.join("global-idea.md"), "hello global\n").unwrap();
        let a_profile_scratch = a.data.path().join("scratch/profile");
        fs::create_dir_all(&a_profile_scratch).unwrap();
        fs::write(a_profile_scratch.join("profile-notes.md"), "hello profile\n").unwrap();
        let a_proj_scratch = a.data.path().join("scratch/projects").join(&app.id);
        fs::create_dir_all(&a_proj_scratch).unwrap();
        fs::write(a_proj_scratch.join("project-spec.md"), "hello project\n").unwrap();
        let a_prefs = PrefsSnapshot {
            shared: BTreeMap::from([("themeMode".into(), "dark".into()), ("defaultYolo".into(), "1".into())]),
            scoped: BTreeMap::from([(String::new(), BTreeMap::from([("promptLibrary".into(), "{\"customs\":[]}".into())]))]),
        };

        let info = connect(&a.clone_dir(), &url).unwrap();
        assert!(info.empty, "a fresh bare repo is empty");
        let finder = Finder { find_repo: &find };
        let opts = RunOpts { adopt: true, push: true, machine: a.name, prefs: Some(&a_prefs), locate: &default_locate, finder: &finder };
        let r = bind(&a.clone_dir(), &ProfileId::Root, None, &opts);
        assert!(r.ok && r.pushed, "{r:?}");
        a.enter();
        assert!(load_state().last_pull_at.is_some(), "a run stamps when it pulled, so a later focus can tell");

        // What reached the remote: no secret, no local path, a fixed identity.
        let grep = std::process::Command::new("git")
            .args(["--git-dir", bare.to_str().unwrap(), "grep", "-I", "-l", "s3cret", "HEAD"])
            .output().unwrap();
        assert!(grep.stdout.is_empty(), "a secret reached the repo: {}", String::from_utf8_lossy(&grep.stdout));
        let grep = std::process::Command::new("git")
            .args(["--git-dir", bare.to_str().unwrap(), "grep", "-I", "-l", "secret-cache", "HEAD"])
            .output().unwrap();
        assert!(grep.stdout.is_empty(), "a local path reached the repo");
        let log = sh(remote.path(), &["--git-dir", bare.to_str().unwrap(), "log", "-1", "--format=%s|%ae", "main"]);
        assert_eq!(log.trim(), format!("sync from machine-a|{SYNC_EMAIL}"));
        let a_sid = crate::load_settings_in(&ProfileId::Root).sync.sync_id.unwrap();
        let tree = sh(remote.path(), &["--git-dir", bare.to_str().unwrap(), "ls-tree", "-r", "--name-only", "main"]);
        assert!(tree.contains("scratch/global-idea.md"), "global scratchpad flattened at repo root: {tree}");
        assert!(tree.contains(&format!("profiles/{a_sid}/scratch/profile-notes.md")), "profile scratchpad synced: {tree}");
        assert!(tree.contains(&format!("profiles/{a_sid}/scratch/projects/{}/project-spec.md", app.id)), "project scratchpad synced: {tree}");

        // ── machine B: the same repo under repos_dir, different setup
        let b = Machine::new("machine-b");
        b.enter();
        let b_repos = b.data.path().join("repos");
        let b_app = make_repo(&b_repos.join("app"), "git@git.acme.com:acme/app.git");
        with_settings(&b, |s| s.repos_dir = b_repos.to_string_lossy().into());
        let b_prefs = PrefsSnapshot {
            shared: BTreeMap::from([("themeMode".into(), "light".into())]),
            scoped: BTreeMap::new(),
        };
        let info = connect(&b.clone_dir(), &url).unwrap();
        assert!(!info.empty);
        assert_eq!(info.folders.len(), 1);
        assert_eq!(info.folders[0].sync_id, a_sid);

        // The preview shows, and changes nothing.
        let finder = Finder { find_repo: &find };
        let pv = preview(&b.clone_dir(), &ProfileId::Root, Some(&a_sid), Some(&b_prefs), &finder).unwrap();
        assert!(pv.iter().any(|c| c.kind == "project" && c.target == "app" && c.action == "add"), "{pv:#?}");
        assert!(pv.iter().any(|c| c.kind == "project" && c.target == "notes" && c.action == "wait"));
        assert!(pv.iter().any(|c| c.kind == "pref" && c.target == "defaultYolo" && c.safety), "safety highlighted");
        assert!(projects(&b).is_empty(), "a preview writes nothing");

        let opts = RunOpts { adopt: true, push: true, machine: b.name, prefs: Some(&b_prefs), locate: &default_locate, finder: &finder };
        let r = bind(&b.clone_dir(), &ProfileId::Root, Some(a_sid.clone()), &opts);
        assert!(r.ok, "{r:?}");
        let bp = projects(&b);
        assert_eq!(bp.len(), 1, "app registered, notes waiting: {bp:?}");
        assert_eq!(bp[0].id, app.id);
        assert_eq!(bp[0].root_path, b_app.to_string_lossy());
        assert!(bp[0].sandbox_rw_paths.is_empty(), "local fields stay local");
        let st = status(&b.clone_dir(), &ProfileId::Root);
        assert_eq!(st.waiting.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["notes"]);
        let ag = crate::load_settings_in(&ProfileId::Root).agents.into_iter().find(|a| a.id == "my-agent").expect("agent pulled");
        assert!(ag.env.is_empty() && ag.docker_env.is_empty());
        assert!(r.prefs.shared.iter().any(|c| c.key == "themeMode" && c.value.as_deref() == Some("dark")));
        assert!(r.prefs.scoped.get("").is_some_and(|v| v.iter().any(|c| c.key == "promptLibrary")));
        assert!(b.xdg.path().join("termic/themes/mine.json").exists(), "themes follow");
        let b_global = b.data.path().join("scratch/global/global-idea.md");
        assert_eq!(fs::read_to_string(&b_global).unwrap(), "hello global\n");
        let b_prof = b.data.path().join("scratch/profile/profile-notes.md");
        assert_eq!(fs::read_to_string(&b_prof).unwrap(), "hello profile\n");
        let b_proj = b.data.path().join("scratch/projects").join(&app.id).join("project-spec.md");
        assert_eq!(fs::read_to_string(&b_proj).unwrap(), "hello project\n");
        assert!(r.scratchpad_changed, "scratchpad changed flag propagated");
        let b_after = merged_snapshot(&b_prefs, &r.prefs);

        // ── A renames and turns YOLO on; B changed a different field meanwhile
        a.enter();
        let mut ap = crate::load_projects_in(&ProfileId::Root);
        ap[0].name = "App".into();
        ap[0].default_yolo = Some(true);
        crate::save_projects_in(&ProfileId::Root, &ap).unwrap();
        assert!(run(&a, true, Some(&a_prefs)).pushed);
        b.enter();
        let mut bp = crate::load_projects_in(&ProfileId::Root);
        bp[0].preview_url = "http://localhost:4000".into();
        crate::save_projects_in(&ProfileId::Root, &bp).unwrap();
        let r = run(&b, true, Some(&b_after));
        assert!(r.ok && r.conflicts.is_empty(), "{r:?}");
        let bp = projects(&b);
        assert_eq!(bp[0].name, "App");
        assert_eq!(bp[0].default_yolo, Some(true));
        assert_eq!(bp[0].preview_url, "http://localhost:4000");
        assert!(r.changes.iter().any(|c| c.safety && c.field.as_deref() == Some("default_yolo")), "{:?}", r.changes);
        b.enter();
        assert!(load_state().notices.iter().any(|n| n.field.as_deref() == Some("default_yolo")), "the notice persists");
        // And A gets B's edit.
        assert!(r.pushed, "B pushed its edit: {r:?}");
        let ra = run(&a, true, Some(&a_prefs));
        assert!(ra.ok && ra.conflicts.is_empty(), "the remote's spelling is not churn: {ra:?}");
        assert_eq!(projects(&a)[0].preview_url, "http://localhost:4000");

        // ── a removal on A is a tombstone on B, never a delete
        a.enter();
        let p = crate::load_projects_in(&ProfileId::Root).into_iter().find(|p| p.id == app.id).unwrap();
        note_project_removed(&p, a.name);
        let rest: Vec<Project> = crate::load_projects_in(&ProfileId::Root).into_iter().filter(|p| p.id != app.id).collect();
        crate::save_projects_in(&ProfileId::Root, &rest).unwrap();
        assert!(run(&a, true, Some(&a_prefs)).pushed);
        a.enter();
        assert!(crate::load_settings_in(&ProfileId::Root).sync.removed.is_empty(), "outbox cleared after push");
        run(&b, true, Some(&b_after));
        assert_eq!(projects(&b).len(), 1, "B keeps its project until asked");
        let st = status(&b.clone_dir(), &ProfileId::Root);
        assert_eq!(st.removals.len(), 1);
        assert_eq!(st.removals[0].machine, "machine-a");
        // B answers Keep: the project is published again, and A does not get
        // it back because A put it on its Skip list.
        keep(&ProfileId::Root, &app.id).unwrap();
        run(&b, true, Some(&b_after));
        assert!(status(&b.clone_dir(), &ProfileId::Root).removals.is_empty());
        run(&a, true, Some(&a_prefs));
        assert!(projects(&a).iter().all(|p| p.id != app.id), "skipped on the removing machine");
        let st = status(&a.clone_dir(), &ProfileId::Root);
        assert!(st.waiting.iter().all(|w| w.id != app.id));
        assert!(st.skipped.iter().any(|w| w.id == app.id));

        // ── conflict: both change the same field; B takes the other one
        with_settings(&a, |s| s.close_action = Some("quit".into()));
        assert!(run(&a, true, Some(&a_prefs)).pushed);
        with_settings(&b, |s| s.close_action = Some("menubar".into()));
        let r = run(&b, true, Some(&b_after));
        assert_eq!(r.conflicts, vec![format!("profiles/{a_sid}/settings.json")], "{r:?}");
        assert_eq!(crate::load_settings_in(&ProfileId::Root).close_action.as_deref(), Some("menubar"), "local kept");
        b.enter();
        let mut state = load_state();
        state.choices.insert(r.conflicts[0].clone(), "remote".into());
        save_state(&state);
        let finder = Finder { find_repo: &find };
        let r = resolve(&b.clone_dir(), &RunOpts { adopt: true, push: true, machine: b.name, prefs: Some(&b_after), locate: &default_locate, finder: &finder });
        // Taking theirs leaves nothing of ours to push.
        assert!(r.ok && r.conflicts.is_empty() && !r.pushed, "{r:?}");
        assert_eq!(crate::load_settings_in(&ProfileId::Root).close_action.as_deref(), Some("quit"));
        assert!(load_state().conflicts.is_empty());

        // ── and again, B keeps its own
        with_settings(&a, |s| s.fetch_before_create = Some(false));
        assert!(run(&a, true, Some(&a_prefs)).pushed);
        with_settings(&b, |s| s.fetch_before_create = Some(true));
        let r = run(&b, true, Some(&b_after));
        assert_eq!(r.conflicts.len(), 1, "{r:?}");
        b.enter();
        let mut state = load_state();
        state.choices.insert(r.conflicts[0].clone(), "local".into());
        save_state(&state);
        let r = resolve(&b.clone_dir(), &RunOpts { adopt: true, push: true, machine: b.name, prefs: Some(&b_after), locate: &default_locate, finder: &finder });
        assert!(r.ok && r.pushed, "{r:?}");
        b.enter();
        assert_eq!(crate::load_settings_in(&ProfileId::Root).fetch_before_create, Some(true));
        run(&a, true, Some(&a_prefs));
        a.enter();
        assert_eq!(crate::load_settings_in(&ProfileId::Root).fetch_before_create, Some(true), "A gets B's choice");
        assert_eq!(crate::load_settings_in(&ProfileId::Root).close_action.as_deref(), Some("quit"));
        let _ = settings_path(&a);
    }

    // ── profiles follow the repo ──

    fn folder(id: &str, name: &str) -> FolderView {
        FolderView { sync_id: id.into(), name: name.into(), accent: None }
    }

    fn local(slug: &str, name: &str, sync_id: Option<&str>) -> LocalProfile {
        LocalProfile {
            id: ProfileId::Slug(slug.into()), name: name.into(), slug: Some(slug.into()),
            sync_id: sync_id.map(str::to_string), opted_out: false,
        }
    }

    #[test]
    fn a_folder_nobody_follows_is_created_and_an_unlinked_profile_is_uploaded() {
        let folders = [folder("personal", "Personal"), folder("work", "Work")];
        let locals = [local("personal", "Personal", Some("personal")), local("side", "Side", None)];
        let plan = plan_adoption(&folders, &locals, &[]);
        assert_eq!(plan.create, vec![folder("work", "Work")]);
        assert_eq!(plan.upload, vec![ProfileId::Slug("side".into())]);
        assert!(plan.waiting.is_empty());
    }

    #[test]
    fn a_shared_name_is_never_matched_or_duplicated_by_a_guess() {
        // By display name, whatever the case, and by the folder being named
        // after the local slug: either way it is "probably the same profile",
        // and probably is not enough to merge two project lists on.
        for (f, l) in [
            (folder("abc123", "work"), local("job", "Work", None)),
            (folder("work", "Client stuff"), local("work", "Work", None)),
        ] {
            let plan = plan_adoption(std::slice::from_ref(&f), &[local("me", "Me", Some("me")), l], &[]);
            assert!(plan.create.is_empty(), "created a second profile for {f:?}");
            assert!(plan.upload.is_empty(), "uploaded a second folder beside {f:?}");
            assert_eq!(plan.waiting, vec![f]);
        }
    }

    #[test]
    fn an_ignored_folder_and_an_opted_out_profile_stay_as_they_were_left() {
        let folders = [folder("me", "Me"), folder("work", "Work")];
        let mut off = local("side", "Side", None);
        off.opted_out = true;
        let plan = plan_adoption(&folders, &[local("me", "Me", Some("me")), off], &["work".to_string()]);
        assert_eq!(plan, AdoptPlan::default());
        // An ignored folder does not make a new local profile of that name
        // wait either: it is not on offer here, so the new one goes up.
        let plan = plan_adoption(&folders, &[local("me", "Me", Some("me")), local("work", "Work", None)], &["work".to_string()]);
        assert_eq!(plan.upload, vec![ProfileId::Slug("work".into())]);
    }

    /// Run `body` with the data dir free to be pointed at one Machine after
    /// another, and put the environment back whatever it does.
    fn with_machines(body: fn()) {
        let _lock = crate::test_support::DATA_DIR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_data = std::env::var_os("TERMIC_DATA_DIR");
        let prev_xdg = std::env::var_os("XDG_CONFIG_HOME");
        let out = std::panic::catch_unwind(body);
        // SAFETY: still under DATA_DIR_LOCK.
        unsafe {
            match prev_data { Some(v) => std::env::set_var("TERMIC_DATA_DIR", v), None => std::env::remove_var("TERMIC_DATA_DIR") }
            match prev_xdg { Some(v) => std::env::set_var("XDG_CONFIG_HOME", v), None => std::env::remove_var("XDG_CONFIG_HOME") }
        }
        if let Err(e) = out {
            std::panic::resume_unwind(e);
        }
    }

    fn bind_in(m: &Machine, id: &ProfileId, folder: Option<&str>) -> SyncRunResult {
        let clone = m.clone_dir();
        let finder = Finder { find_repo: &find };
        bind(&clone, id, folder.map(str::to_string), &RunOpts { adopt: true, push: true, machine: m.name, prefs: None, locate: &default_locate, finder: &finder })
    }

    fn slugs(m: &Machine) -> Vec<String> {
        m.enter();
        let mut v: Vec<String> = crate::profiles_registry().profiles.iter().map(|p| p.slug.clone()).collect();
        v.sort();
        v
    }

    fn sync_id_of(m: &Machine, id: &ProfileId) -> Option<String> {
        m.enter();
        crate::load_settings_in(id).sync.sync_id
    }

    /// The one branch the bare repo holds. Not `HEAD`: a bare repo's HEAD
    /// names git's configured default branch, which is `master` on a CI
    /// runner while the sync pushes `main`, so `HEAD:` resolved to nothing
    /// there and to the right commit on a laptop.
    fn pushed_branch(bare: &Path) -> String {
        sh(bare, &["for-each-ref", "--format=%(refname)", "refs/heads"]).lines().next().expect("something was pushed").to_string()
    }

    fn repo_folders(bare: &Path) -> Vec<String> {
        let tree = format!("{}:profiles", pushed_branch(bare));
        let mut v: Vec<String> = sh(bare, &["ls-tree", "--name-only", &tree]).lines().map(str::to_string).collect();
        v.sort();
        v
    }

    #[test]
    fn profiles_follow_the_repo_both_ways() {
        with_machines(profiles_follow_body);
    }

    fn profiles_follow_body() {
        let remote = tempfile::tempdir().unwrap();
        let bare = remote.path().join("config.git");
        sh(remote.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
        let url = format!("file://{}", bare.to_string_lossy());
        let work = ProfileId::Slug("work".into());

        // ── machine A: two profiles, "Personal" owning the root, and "Work"
        // with a project of its own.
        let a = Machine::new("machine-a");
        a.enter();
        crate::create_profile_data("Work", "orange", "", Some("Personal"), Some("teal")).unwrap();
        let a_notes = a.data.path().join("work-notes");
        fs::create_dir_all(&a_notes).unwrap();
        crate::save_projects_in(&work, &[Project {
            id: "33333333-cccc".into(), name: "work-notes".into(), root_path: a_notes.to_string_lossy().into(),
            non_git: true, profile: work.clone(), ..Default::default()
        }]).unwrap();
        with_settings(&a, |s| s.close_action = Some("hide".into()));

        // Connecting ONE profile uploads the other too, each under its slug.
        connect(&a.clone_dir(), &url).unwrap();
        let r = bind_in(&a, &ProfileId::Root, None);
        assert!(r.ok && r.pushed, "{r:?}");
        assert_eq!(repo_folders(&bare), ["personal", "work"], "folders are named after the slugs");
        assert_eq!(sync_id_of(&a, &ProfileId::Root).as_deref(), Some("personal"));
        assert_eq!(sync_id_of(&a, &work).as_deref(), Some("work"));
        assert!(r.changes.iter().any(|c| c.kind == "profile" && c.action == "upload" && c.target == "Work"), "{:?}", r.changes);
        // Uploading creates no local profile, so no window has anything to learn.
        assert!(!r.profiles_changed);
        let blob = format!("{}:profiles/work/profile.json", pushed_branch(&bare));
        let meta: Value = serde_json::from_str(&sh(&bare, &["show", &blob])).unwrap();
        assert_eq!(meta, serde_json::json!({ "accent": "orange", "name": "Work" }));

        // ── machine B: a plain install, no profiles at all. It follows
        // "personal", and the other folder becomes a profile of its own.
        let b = Machine::new("machine-b");
        b.enter();
        let info = connect(&b.clone_dir(), &url).unwrap();
        assert_eq!(info.folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Personal", "Work"]);
        let finder = Finder { find_repo: &find };
        let planned = preview(&b.clone_dir(), &ProfileId::Root, Some("personal"), None, &finder).unwrap();
        assert!(
            planned.iter().any(|c| c.kind == "profile" && c.action == "add" && c.target == "Work"),
            "the preview says a profile will be created before it is: {planned:?}"
        );
        assert_eq!(slugs(&b), Vec::<String>::new(), "a preview creates nothing");

        let r = bind_in(&b, &ProfileId::Root, Some("personal"));
        assert!(r.ok, "{r:?}");
        assert!(r.profiles_changed, "the windows have to be told a profile appeared");
        assert_eq!(slugs(&b), ["personal", "work"], "the root took the name its folder carries");
        b.enter();
        let reg = crate::profiles_registry();
        assert_eq!(reg.root_slug.as_deref(), Some("personal"));
        assert_eq!(reg.get("work").map(|p| (p.name.as_str(), p.accent.as_str())), Some(("Work", "orange")));
        assert_eq!(sync_id_of(&b, &work).as_deref(), Some("work"));
        assert_eq!(crate::load_settings_in(&ProfileId::Root).close_action.as_deref(), Some("hide"), "the picked folder applied");
        // Its project has no folder here, so it waits, in the NEW profile.
        let st = status(&b.clone_dir(), &work);
        assert_eq!(st.waiting.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), ["work-notes"]);
        assert_eq!(repo_folders(&bare), ["personal", "work"], "nothing was duplicated in the repo");

        // A profile made by hand on a syncing machine starts unlinked: it used
        // to copy the root's binding with the rest of its settings.
        b.enter();
        crate::create_profile_data("Side", "blue", "", None, None).unwrap();
        let side = ProfileId::Slug("side".into());
        assert_eq!(sync_id_of(&b, &side), None);
        // A launch pull (no push) leaves it alone; the next real sync sends it.
        assert!(run(&b, false, None).ok);
        assert_eq!(sync_id_of(&b, &side), None, "a pull does not name a folder it cannot push");
        let r = run(&b, true, None);
        assert!(r.ok && r.pushed, "{r:?}");
        assert_eq!(sync_id_of(&b, &side).as_deref(), Some("side"));
        assert_eq!(repo_folders(&bare), ["personal", "side", "work"]);

        // ...and arrives on A at ITS next pull, created.
        let r = run(&a, false, None);
        assert!(r.ok && r.profiles_changed, "{r:?}");
        assert_eq!(slugs(&a), ["personal", "side", "work"]);

        // ── a rename travels, and the folder does not move with it.
        a.enter();
        crate::with_registry(|_g, reg| {
            let p = reg.profiles.iter_mut().find(|p| p.slug == "work").unwrap();
            p.name = "Client".into();
            p.accent = "#ff8800".into();
            Ok(())
        }).unwrap();
        assert!(run(&a, true, None).pushed);
        let r = run(&b, true, None);
        assert!(r.ok && r.profiles_changed, "{r:?}");
        assert!(
            r.changes.iter().any(|c| c.kind == "profile" && c.action == "update" && c.field.as_deref() == Some("name")),
            "{:?}", r.changes
        );
        b.enter();
        let reg = crate::profiles_registry();
        assert_eq!(reg.get("work").map(|p| (p.name.as_str(), p.accent.as_str())), Some(("Client", "#ff8800")));
        assert_eq!(repo_folders(&bare), ["personal", "side", "work"], "a rename is not a new folder");
        // B's own export of the same profile does not put the old name back.
        assert!(!run(&b, true, None).pushed, "B had nothing of its own to send after taking the rename");

        // ── deleting sticks. B deletes Work: gone here, kept in the repo.
        b.enter();
        note_profile_deleted(&work);
        let mut reg = crate::profiles_registry();
        crate::delete_profile_data(b.data.path(), &mut reg, &work, "work", false).unwrap();
        let r = run(&b, true, None);
        assert!(r.ok && !r.profiles_changed, "{r:?}");
        assert_eq!(slugs(&b), ["personal", "side"], "the deleted profile came back");
        assert_eq!(repo_folders(&bare), ["personal", "side", "work"], "a local delete removed it for everyone");
        let st = status(&b.clone_dir(), &ProfileId::Root);
        assert_eq!(st.ignored.iter().map(|f| f.sync_id.as_str()).collect::<Vec<_>>(), ["work"]);
        // Until it is asked for again.
        b.enter();
        restore_folder("work");
        let r = run(&b, true, None);
        assert!(r.ok && r.profiles_changed, "{r:?}");
        // Created afresh from the folder, so its slug comes from the name the
        // folder carries NOW. The folder it follows is still `work`.
        assert_eq!(slugs(&b), ["client", "personal", "side"]);
        let client = ProfileId::Slug("client".into());
        assert_eq!(sync_id_of(&b, &client).as_deref(), Some("work"));
        assert!(status(&b.clone_dir(), &ProfileId::Root).ignored.is_empty());

        // ── opting out sticks. B stops syncing Side: it stays local, is not
        // re-linked, and is not uploaded again under a second name.
        b.enter();
        disconnect(&b.clone_dir(), &side).unwrap();
        assert!(is_connected(&b.clone_dir()), "other profiles still sync, so the clone stays");
        let r = run(&b, true, None);
        assert!(r.ok, "{r:?}");
        assert_eq!(sync_id_of(&b, &side), None);
        assert_eq!(repo_folders(&bare), ["personal", "side", "work"]);
        assert_eq!(slugs(&b), ["client", "personal", "side"], "its own folder was not turned into a second profile");
        let st = status(&b.clone_dir(), &side);
        assert!(st.opted_out);
        assert_eq!(st.suggested_folder.as_deref(), Some("side"), "the picker offers the folder it left");
        // Connecting it again is the user's call, and clears the answer.
        let r = bind_in(&b, &side, Some("side"));
        assert!(r.ok, "{r:?}");
        assert_eq!(sync_id_of(&b, &side).as_deref(), Some("side"));
        b.enter();
        assert!(!crate::load_settings_in(&side).sync.opted_out);

        // ── a shared name is not guessed at. A makes "Docs" and uploads it;
        // B already has its own unlinked "Docs".
        a.enter();
        crate::create_profile_data("Docs", "blue", "", None, None).unwrap();
        assert!(run(&a, true, None).pushed);
        assert_eq!(repo_folders(&bare), ["docs", "personal", "side", "work"]);
        b.enter();
        crate::create_profile_data("Docs", "blue", "", None, None).unwrap();
        let docs = ProfileId::Slug("docs".into());
        let r = run(&b, true, None);
        assert!(r.ok && !r.profiles_changed, "{r:?}");
        assert_eq!(sync_id_of(&b, &docs), None, "linked on a guess");
        assert_eq!(slugs(&b), ["client", "docs", "personal", "side"], "a second Docs was created");
        assert_eq!(repo_folders(&bare), ["docs", "personal", "side", "work"], "a second folder was uploaded");
        assert_eq!(status(&b.clone_dir(), &docs).suggested_folder.as_deref(), Some("docs"));

        // ── the last disconnect ends it: clone gone, nothing left opted out.
        b.enter();
        disconnect(&b.clone_dir(), &side).unwrap();
        for id in [ProfileId::Root, client.clone(), side.clone()] {
            disconnect(&b.clone_dir(), &id).unwrap();
        }
        assert!(!b.clone_dir().exists());
        b.enter();
        for id in crate::profiles_registry().ids() {
            assert!(crate::load_settings_in(&id).sync.is_empty(), "{id} kept sync state after the machine disconnected");
        }
    }

    #[test]
    fn a_new_folder_is_named_after_the_slug() {
        with_machines(|| {
            let m = Machine::new("machine-n");
            m.enter();
            // Dormant: no slug to name it after.
            let none = BTreeSet::new();
            assert_eq!(new_folder_id(&ProfileId::Root, &none), "default");
            crate::create_profile_data("Work Stuff", "orange", "", Some("Personal"), None).unwrap();
            assert_eq!(new_folder_id(&ProfileId::Root, &none), "personal");
            let work = ProfileId::Slug("work-stuff".into());
            assert_eq!(new_folder_id(&work, &none), "work-stuff");
            // Taken in the repo (another machine's profile of that slug).
            let taken: BTreeSet<String> = ["work-stuff".to_string(), "work-stuff-2".to_string()].into();
            assert_eq!(new_folder_id(&work, &taken), "work-stuff-3");
        });
    }

    #[test]
    fn export_dir_mirror_skips_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src");
        let dst = temp.path().join("dst");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::create_dir_all(&outside).unwrap();

        fs::write(src.join("normal.txt"), "hello").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("secret.txt"), src.join("symlink_file.txt")).unwrap();
            std::os::unix::fs::symlink(&outside, src.join("symlink_dir")).unwrap();
        }

        export_dir_mirror(&src, &dst).unwrap();

        assert!(dst.join("normal.txt").exists());
        assert_eq!(fs::read_to_string(dst.join("normal.txt")).unwrap(), "hello");
        assert!(!dst.join("symlink_file.txt").exists());
        assert!(!dst.join("symlink_dir").exists());
        assert!(!dst.join("symlink_dir").join("secret.txt").exists());
    }
}
