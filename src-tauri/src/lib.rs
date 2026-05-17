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
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

// ───────────────────────────── data model ─────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Project {
    pub id: String,
    pub name: String,
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
}

// ───────────────────────────── paths ─────────────────────────────

fn data_dir() -> Result<PathBuf> {
    let p = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("no data dir"))?
        .join("termic");
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
    let p = dirs::home_dir().ok_or_else(|| anyhow!("no home"))?.join("termic/workspaces");
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
}

#[derive(Default)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<String, PtySlot>>>,
}

#[derive(Clone, Serialize)]
struct PtyChunk { data: Vec<u8> }

#[derive(Clone, Serialize)]
struct PtyExit { code: Option<i32> }

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
}
fn default_rows() -> u16 { 40 }
fn default_cols() -> u16 { 120 }

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    args: SpawnArgs,
) -> Result<String, String> {
    let pty = NativePtySystem::default();
    let pair = pty
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&args.cmd);
    for a in &args.args {
        cmd.arg(a);
    }
    cmd.cwd(&args.cwd);
    // Inherit ALL parent env first — agents need ANTHROPIC_API_KEY,
    // GEMINI_API_KEY, OPENAI_API_KEY, HTTPS_PROXY, etc. The user's per-spawn
    // `env` overlay then takes precedence for known keys like TERMIC_*.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    for (k, v) in &args.env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    drop(pair.slave);

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
                Err(_) => break,
            }
        }
    });

    // Waiter thread owns the Child outright. wait() blocks until the process
    // exits; if pty_kill SIGKILLs it, wait() returns naturally — no mutex
    // contention with the kill path.
    let app_w = app.clone();
    let id_w = id.clone();
    let state_w = state.inner.clone();
    thread::spawn(move || {
        let status = child.wait().ok();
        let code = status.and_then(|s| i32::try_from(s.exit_code()).ok());
        let _ = app_w.emit(&format!("pty-exit://{}", id_w), PtyExit { code });
        let mut map = state_w.lock();
        map.remove(&id_w);
    });

    state.inner.lock().insert(
        id.clone(),
        PtySlot { writer, master, child_pid },
    );

    Ok(id)
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
    };
    list.push(p.clone());
    save_projects(&list).map_err(|e| e.to_string())?;
    Ok(p)
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
            if let Err(e) = workspace_archive_sync(w.id.clone()) {
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
fn workspace_open_repo(project_id: String) -> Result<Workspace, String> {
    if let Some(existing) = load_workspaces().into_iter()
        .find(|w| w.project_id == project_id && w.is_repo_root && !w.archived) {
        return Ok(existing);
    }
    let proj = load_projects().into_iter().find(|p| p.id == project_id)
        .ok_or("project not found")?;
    let repo = PathBuf::from(&proj.root_path);
    // Current branch (or "HEAD" if detached). Stripped of trailing newline.
    let branch = git(&["symbolic-ref", "--quiet", "--short", "HEAD"], &repo)
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let port = 18100 + (load_workspaces().len() as u16);
    let ws = Workspace {
        id: Uuid::new_v4().to_string(),
        project_id: proj.id.clone(),
        // Just the project name — the frontend appends a "REPO" badge so the
        // visual differentiation comes from chrome, not the name itself.
        name: proj.name.clone(),
        branch: branch.clone(),
        base_branch: branch,
        path: proj.root_path.clone(),
        cli: proj.default_cli.clone(),
        port,
        created: chrono::Utc::now().to_rfc3339(),
        archived: false,
        is_repo_root: true,
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

    // Copy files_to_copy (glob patterns relative to repo root).
    for pat in &proj.files_to_copy {
        copy_matching(&repo, &wt_path, pat);
    }

    // Allocate port (18100 + index).
    let port = 18100 + (load_workspaces().len() as u16);

    let cli = args.cli.unwrap_or_else(|| proj.default_cli.clone());
    // Use the client-supplied ID if present so the frontend can listen on
    // `setup-{output,done}://<id>` BEFORE invoking — eliminates the
    // empty-script race that made the "Running setup script…" spinner hang.
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
    };
    save_workspace(&ws).map_err(|e| e.to_string())?;

    // Run setup script in a background thread so the IPC handler returns
    // immediately and the UI doesn't freeze. Errors are surfaced via a
    // notification rather than failing workspace creation.
    if !proj.setup_script.trim().is_empty() {
        // Stream stdout+stderr to the frontend so the New Workspace dialog
        // can show live progress. Frontend listens on:
        //   setup-output://<ws.id>  (per-line)
        //   setup-done://<ws.id>    (final exit code)
        run_script_streaming(
            proj.setup_script.clone(),
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
    if !["claude", "gemini", "codex"].contains(&cli.as_str()) {
        return Err(format!("unknown cli: {cli}"));
    }
    let mut list = load_workspaces();
    let w = list.iter_mut().find(|w| w.id == id).ok_or("no such ws")?;
    w.cli = cli;
    save_workspace(w).map_err(|e| e.to_string())?;
    Ok(w.clone())
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
async fn workspace_archive(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || workspace_archive_sync(id))
        .await
        .map_err(|e| e.to_string())?
}

fn workspace_archive_sync(id: String) -> Result<(), String> {
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

    if let Some(p) = &proj {
        if !p.archive_script.trim().is_empty() {
            let _ = run_script(&p.archive_script, Path::new(&w.path), w.port, &w.name);
        }
    }

    let mut errs = Vec::new();
    // Repo-root workspaces are NOT git worktrees — skip the worktree/rmdir
    // dance entirely. Archiving one just removes it from our list; the actual
    // repo on disk stays intact.
    if w.is_repo_root {
        w.archived = true;
        save_workspace(w).map_err(|e| e.to_string())?;
        delete_workspace_file(&id).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if let Some(p) = &proj {
        if let Err(e) = git(&["worktree", "remove", "--force", &w.path], Path::new(&p.root_path)) {
            errs.push(format!("worktree remove: {e}"));
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
        let _ = workspace_archive_sync(id2.clone());
        delete_workspace_file(&id2).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn workspace_run_script(id: String, which: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no such ws")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("no proj")?;
    let script = match which.as_str() {
        "setup" => p.setup_script,
        "run" => p.run_script,
        "archive" => p.archive_script,
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
pub struct ChangedFile {
    pub status: String, // "M", "A", "D", "??", "R", etc.
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceChanges {
    pub count: usize,
    pub files: Vec<ChangedFile>,
}

#[tauri::command]
fn workspace_changes(id: String) -> Result<WorkspaceChanges, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let out = git(&["status", "--porcelain"], Path::new(&w.path))
        .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for line in out.lines() {
        if line.len() < 4 { continue; }
        // porcelain v1: "XY path"
        let status = line[..2].trim().to_string();
        let path = line[3..].to_string();
        files.push(ChangedFile { status, path });
    }
    Ok(WorkspaceChanges { count: files.len(), files })
}

#[tauri::command]
fn workspace_file_read(id: String, path: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let abs = PathBuf::from(&w.path).join(&path);
    // Refuse binary or huge files for now — viewer is text-only.
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 {
        return Err(format!("file too large to preview ({} bytes)", meta.len()));
    }
    fs::read_to_string(&abs).map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
fn workspace_file_diff(id: String, path: String) -> Result<String, String> {
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let wt = PathBuf::from(&w.path);
    // Diff vs HEAD (working tree + index). For tracked files this catches
    // both staged and unstaged changes; for untracked files git returns
    // nothing and we synthesize an "all-added" view from the file content.
    let tracked_diff = git(&["--no-pager", "diff", "HEAD", "--", &path], &wt)
        .unwrap_or_default();
    if !tracked_diff.trim().is_empty() {
        return Ok(tracked_diff);
    }
    // Maybe it's untracked — synthesize a "new file" diff.
    let abs = wt.join(&path);
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
    if rel.split('/').any(|s| s == "..") {
        return Err("invalid path".into());
    }
    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no ws")?;
    let base = PathBuf::from(&w.path);
    let target = if rel.is_empty() { base.clone() } else { base.join(&rel) };
    // Belt and suspenders: canonicalize and verify the target stays under the
    // workspace root so a crafted rel-path can't escape via symlinks.
    let canon_base = fs::canonicalize(&base).map_err(|e| e.to_string())?;
    let canon_target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_base) {
        return Err("path escapes workspace".into());
    }
    let mut out = Vec::new();
    let rd = fs::read_dir(&canon_target).map_err(|e| e.to_string())?;
    for e in rd.flatten() {
        let name = match e.file_name().into_string() { Ok(s) => s, Err(_) => continue };
        // file_type avoids the extra stat that metadata would do, and handles
        // symlinks correctly (a symlink-to-dir is reported as symlink, not dir).
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
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

fn copy_matching(repo: &Path, dst: &Path, pat: &str) {
    // Very simple glob: '*' wildcard in the basename only.
    let pat_path = repo.join(pat);
    if pat_path.exists() {
        let rel_dst = dst.join(pat);
        if let Some(parent) = rel_dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(&pat_path, &rel_dst);
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
                    if let Some(p) = dst_path.parent() {
                        let _ = fs::create_dir_all(p);
                    }
                    let _ = fs::copy(e.path(), &dst_path);
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
fn workspace_run_script_stream(id: String, kind: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let w = load_workspaces().into_iter().find(|w| w.id == id).ok_or("no such ws")?;
    let p = load_projects().into_iter().find(|p| p.id == w.project_id).ok_or("no proj")?;
    let script = match kind.as_str() {
        "setup" => p.setup_script,
        "run"   => p.run_script,
        other   => return Err(format!("unknown script kind: {other}")),
    };
    let map_key = format!("{id}:{kind}");

    // Empty script → no-op but emit done so the UI doesn't spin forever.
    if script.trim().is_empty() {
        let _ = app.emit(&format!("script-done://{map_key}"),
            serde_json::json!({ "code": 0, "success": true }));
        return Ok(());
    }

    // Kill any prior instance for (ws, kind) — sends SIGTERM to the whole
    // process group so children (npm → node, cargo → rustc, etc.) die too.
    if let Some(prev) = running_scripts_remove(&map_key) {
        unsafe { libc::kill(-prev, libc::SIGTERM); }
    }

    let cwd  = std::path::PathBuf::from(&w.path);
    let port = w.port;
    let name = w.name.clone();
    let id_o = id.clone();
    let kind_o = kind.clone();
    let app_o = app.clone();

    thread::spawn(move || {
        // `process_group(0)` puts the child in its own group so we can kill
        // the whole tree later via `kill(-pgid, SIGTERM)`.
        let spawn_res = Command::new("bash")
            .arg("-lc").arg(&script)
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
            .process_group(0)
            .spawn();
        let mut child = match spawn_res {
            Ok(c) => c,
            Err(e) => {
                let _ = app_o.emit(&format!("script-output://{id_o}:{kind_o}"),
                    serde_json::json!({ "line": format!("[spawn error] {e}") }));
                let _ = app_o.emit(&format!("script-done://{id_o}:{kind_o}"),
                    serde_json::json!({ "code": serde_json::Value::Null, "success": false }));
                return;
            }
        };
        let pid = child.id() as i32;
        running_scripts_insert(format!("{id_o}:{kind_o}"), pid);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let emit_ch = format!("script-output://{id_o}:{kind_o}");
        let app1 = app_o.clone(); let ch1 = emit_ch.clone();
        let t_out = stdout.map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                let _ = app1.emit(&ch1, serde_json::json!({ "line": line }));
            }
        }));
        let app2 = app_o.clone(); let ch2 = emit_ch.clone();
        let t_err = stderr.map(|s| thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(|r| r.ok()) {
                let _ = app2.emit(&ch2, serde_json::json!({ "line": line }));
            }
        }));
        let status = child.wait();
        if let Some(t) = t_out { let _ = t.join(); }
        if let Some(t) = t_err { let _ = t.join(); }
        running_scripts_remove(&format!("{id_o}:{kind_o}"));
        let code = status.as_ref().ok().and_then(|s| s.code());
        let success = status.map(|s| s.success()).unwrap_or(false);
        let _ = app_o.emit(&format!("script-done://{id_o}:{kind_o}"),
            serde_json::json!({ "code": code, "success": success }));
    });
    Ok(())
}

/// SIGTERM the process group for (ws_id, kind). No-op if nothing's running.
/// Caller should still wait for the matching `script-done` event before
/// updating UI state — kill is async from the child's perspective.
#[tauri::command]
fn workspace_stop_script(id: String, kind: String) -> Result<(), String> {
    let map_key = format!("{id}:{kind}");
    if let Some(pid) = running_scripts_remove(&map_key) {
        unsafe { libc::kill(-pid, libc::SIGTERM); }
    }
    Ok(())
}

// ───────────────────────────── notify ─────────────────────────────

#[tauri::command]
fn log_line(msg: String) {
    use std::io::Write;
    let p = std::env::temp_dir().join("termic-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "[{}] {}", chrono::Utc::now().format("%H:%M:%S%.3f"), msg);
    }
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
    /// Optional per-agent capabilities. ALL fields are optional — when missing,
    /// the corresponding UI gracefully omits the feature rather than failing.
    /// Lets CLIs drift independently of app code: if Anthropic renames
    /// `--dangerously-skip-permissions`, the user edits this here and ships on.
    #[serde(default)]
    pub capabilities: AgentCapabilities,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentCapabilities {
    /// Args appended when YOLO mode is on. Empty → YOLO is a no-op for this agent.
    pub yolo_args: Vec<String>,
    /// Slash-style command sent to a live PTY to enable/disable YOLO mid-session.
    /// `{mode}` is replaced with "yolo" or "default". Empty → no runtime toggle.
    pub runtime_yolo_command: String,
}

fn default_agents() -> Vec<Agent> {
    vec![
        Agent {
            id: "claude".into(),
            display_name: "claude".into(),
            command: "claude".into(),
            args: vec![],
            icon_id: "claude".into(),
            color: "#d97757".into(),
            builtin: true,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--dangerously-skip-permissions".into()],
                runtime_yolo_command: String::new(), // claude has no runtime toggle
            },
        },
        Agent {
            id: "gemini".into(),
            display_name: "gemini".into(),
            command: "gemini".into(),
            args: vec![],
            icon_id: "gemini".into(),
            color: "#4c8bf5".into(),
            builtin: true,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--yolo".into()],
                runtime_yolo_command: "/approval-mode {mode}".into(),
            },
        },
        Agent {
            id: "codex".into(),
            display_name: "codex".into(),
            command: "codex".into(),
            args: vec![],
            icon_id: "codex".into(),
            color: "#16a34a".into(),
            builtin: true,
            capabilities: AgentCapabilities {
                yolo_args: vec!["--dangerously-bypass-approvals-and-sandbox".into()],
                runtime_yolo_command: String::new(),
            },
        },
    ]
}

fn settings_file() -> Result<PathBuf> {
    Ok(data_dir()?.join("settings.json"))
}

fn load_settings_inner() -> Settings {
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
    s
}

fn seeded_defaults() -> Settings {
    Settings { agents: default_agents(), ..Settings::default() }
}

#[tauri::command]
fn settings_load() -> Settings { load_settings_inner() }

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

/// Probe the user's PATH for each supported agent CLI. Used by the welcome
/// wizard so the user can see at a glance whether they need to install one.
#[tauri::command]
fn detect_clis() -> Vec<CliInfo> {
    ["claude", "gemini", "codex"].iter().map(|name| {
        let which = Command::new("/usr/bin/env")
            .args(["sh", "-lc", &format!("command -v {}", name)])
            .output();
        let (found, path) = match which {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                (!p.is_empty(), p)
            }
            _ => (false, String::new()),
        };
        // Best-effort version probe — short timeout would be nicer but most
        // CLIs return quickly. If they don't, we just leave version empty.
        let version = if found {
            Command::new("/usr/bin/env")
                .args(["sh", "-lc", &format!("{} --version 2>/dev/null | head -n1", name)])
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        } else { String::new() };
        CliInfo { name: (*name).into(), found, path, version }
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
        .manage(PtyManager::default())
        .setup(|app| {
            // Window is created hidden (tauri.conf.json: visible=false). We
            // position it on the cursor's monitor BEFORE showing it, so macOS
            // never sees a window on the primary Space and never triggers a
            // Space switch that would yank the user away from their
            // fullscreen app on another display.
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = position_on_cursor_monitor(&win);
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects_list, project_add, project_update, project_remove,
            workspaces_list, workspace_create, workspace_open_repo, workspace_archive, workspace_set_cli,
            workspace_delete, workspace_run_script, workspace_run_script_stream, workspace_stop_script,
            workspace_diff, workspace_files,
            workspace_changes, workspace_file_diff, workspace_file_read, workspace_dir_list,
            workspace_rename, project_rename,
            pty_spawn, pty_write, pty_resize, pty_kill,
            notify, open_path, home_dir, path_exists, log_line,
            settings_load, settings_save, agents_save, discover_repos, detect_clis,
            list_monospace_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

    let win_size = win.outer_size()?;
    let p = target.position();
    let s = target.size();
    let x = p.x + (s.width as i32 - win_size.width as i32) / 2;
    let y = p.y + (s.height as i32 - win_size.height as i32) / 2;
    win.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}
