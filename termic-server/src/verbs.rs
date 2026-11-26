//! `call`: termic-proto Requests in, Replies out, with the same shapes the
//! desktop's cli_server.rs answers, so `termic --peer <server>` and the
//! desktop's remote views need nothing server-specific.

use std::sync::Arc;
use std::time::{Duration, Instant};

use termic_proto::{
    self as proto, send_mode, ArchiveData, Command, DiffData, DiffStat, ErrorCode, ListData, LogsData, NewData, ProjectAddData, ProjectInfo, ProjectListData,
    ProjectRemoveData, RenameData, Reply, ReplyData, Request, SendData, StatusData, TabStatus, TaskStatus, TaskSummary, WaitData, WaitOutcome, WaitResult,
};

use crate::daemon::{self, fail, Daemon, Fail, AGENT_TAB, MAX_PROMPT};
use crate::state::{Project, TaskRec};
use crate::util;

/// `wait` and `--wait` never hold a call longer than this.
const WAIT_CAP: Duration = Duration::from_secs(300);
const MAX_NAME: usize = 200;

pub fn call(d: &Arc<Daemon>, req: Request) -> Reply {
    let id = req.id.clone();
    match handle(d, req) {
        Ok(data) => Reply::ok(&id, data),
        Err((code, msg)) => Reply::err(&id, code, msg),
    }
}

fn verb_name(c: &Command) -> String {
    serde_json::to_value(c).ok().and_then(|v| v.get("cmd").and_then(|s| s.as_str()).map(str::to_string)).unwrap_or_else(|| "this verb".into())
}

fn handle(d: &Arc<Daemon>, req: Request) -> Result<ReplyData, Fail> {
    match req.cmd {
        Command::Hello => Ok(ReplyData::Hello(proto::HelloData { app: "termic-server".into(), app_version: util::version(), protocol: proto::PROTOCOL_VERSION })),
        Command::List { project, quiet } => list(d, project.as_deref(), quiet),
        Command::Status { task, project, cwd } => {
            let t = resolve(d, task.as_deref(), project.as_deref(), cwd.as_deref())?;
            Ok(ReplyData::Status(StatusData { task: status(d, &t) }))
        }
        // The desktop creates a server task (its worktree over `exec`, then
        // `task_put`) and starts its agent: this host has no agent table.
        Command::New { .. } => Err(fail(ErrorCode::Unsupported, "tasks on a server are started by Termic on the desktop")),
        Command::Send { task, project, prompt, prompt_ref, resume, fresh, wait, timeout_ms, tab, now, cwd, caller_task: _ } => {
            if prompt_ref.is_some() {
                return Err(fail(ErrorCode::Unsupported, "termic-server has no prompt library; pass the prompt text"));
            }
            check_tab(tab.as_deref())?;
            let t = resolve(d, task.as_deref(), project.as_deref(), cwd.as_deref())?;
            // resume / fresh / now: the desktop starts agents and types at
            // once; a running agent is all this host can send to.
            let _ = (resume, fresh, now);
            send(d, &t, prompt, wait, timeout_ms)
        }
        Command::Wait { task, project, timeout_ms, tab, cwd } => {
            check_tab(tab.as_deref())?;
            let t = resolve(d, task.as_deref(), project.as_deref(), cwd.as_deref())?;
            let result = wait_settled(d, &t.id, timeout_ms);
            Ok(ReplyData::Wait(WaitData { task_id: t.id, result }))
        }
        Command::Archive { task, project } => {
            let t = resolve(d, Some(&task), project.as_deref(), None)?;
            let killed = d.archive(&t.id).map_err(|e| fail(ErrorCode::Internal, e))?;
            let project = d.st.lock().unwrap().project_name(&t.project_id);
            Ok(ReplyData::Archive(ArchiveData { task_id: t.id, name: t.name, project, killed_agents: killed }))
        }
        Command::Stop { task, project } => {
            let t = resolve(d, Some(&task), project.as_deref(), None)?;
            let stopped = d.stop_agent(&t.id);
            let project = d.st.lock().unwrap().project_name(&t.project_id);
            Ok(ReplyData::Stop(proto::StopData { task_id: t.id, name: t.name, project, stopped_agents: stopped }))
        }
        Command::Rename { task, project, name, cwd } => {
            let t = resolve(d, task.as_deref(), project.as_deref(), cwd.as_deref())?;
            rename(d, &t, &name)
        }
        // The desktop reads the transcript itself, through `exec`.
        Command::LastResult { .. } => Err(fail(ErrorCode::Unsupported, "Termic on the desktop reads a server task's result")),
        Command::Logs { task, project, shell, tab, last_bytes, cwd } => {
            if shell {
                return Err(fail(ErrorCode::Unsupported, "termic-server tasks have no aux terminal; omit --shell"));
            }
            check_tab(tab.as_deref())?;
            let t = resolve(d, task.as_deref(), project.as_deref(), cwd.as_deref())?;
            let pty = d.agent_pty(&t.id).ok_or_else(|| fail(ErrorCode::NotFound, format!("{} has no agent running", t.name)))?;
            let max = last_bytes.map(|b| b as usize).unwrap_or(crate::pty::RING_BYTES).min(crate::pty::RING_BYTES);
            let (bytes, truncated) = pty.tail(max);
            Ok(ReplyData::Logs(LogsData { task_id: t.id, source: "agent".into(), data: String::from_utf8_lossy(&bytes).to_string(), truncated }))
        }
        Command::Diff { task, project, full, cwd } => {
            let t = resolve(d, task.as_deref(), project.as_deref(), cwd.as_deref())?;
            diff(&t, full)
        }
        // The desktop's registry decides the agents; it checks one is on
        // the box with `exec` (server_projects.rs `server_which`).
        Command::Agents => Err(fail(ErrorCode::Unsupported, "agents on a server are chosen by Termic on the desktop")),
        Command::ProjectAdd { path, non_git, clone } => {
            if let Some(url) = clone {
                clone_into(&path, &url)?;
            }
            project_add(d, &path, non_git)
        }
        Command::ProjectList => {
            let st = d.st.lock().unwrap();
            let projects = st.projects.iter().map(|p| project_info(p, &st.tasks)).collect();
            Ok(ReplyData::ProjectList(ProjectListData { projects }))
        }
        Command::ProjectRemove { name } => project_remove(d, &name),
        Command::Exec { cwd, argv, env, stdin, timeout_ms } => exec(d, &cwd, &argv, &env, stdin.as_deref(), timeout_ms),
        Command::TaskPut { task, name, project, path, branch, base_branch, agent, is_main_checkout, org } => {
            task_put(d, TaskRec {
                id: task, name, project_id: project, path, branch, base_branch, agent,
                agent_args: Vec::new(),
                created: util::rfc3339(util::now_secs()),
                archived: false,
                is_main_checkout,
                org: org.unwrap_or(serde_json::Value::Null),
            })
        }
        // The desktop restarting this daemon onto the build it just
        // installed: preview counts the agents that would restart; commit
        // stops them (noted for the next daemon to resume), answers, and
        // exits. The desktop's reconnect starts the new binary.
        Command::Quit { commit } => {
            let (tasks_with_agents, working) = d.agent_counts();
            if commit {
                let d = d.clone();
                std::thread::spawn(move || {
                    // shortcut: a fixed beat for the reply to reach the bridge, no ack from the writer; fine for a one-off exit.
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    util::log("quit: stopping every agent to restart on the installed build");
                    d.stop_for_restart();
                    crate::exit_daemon(&d.dir);
                });
            }
            Ok(ReplyData::Quit(proto::QuitData { running: true, tasks_with_agents, live_agents: tasks_with_agents, working_tasks: Some(working), quitting: commit }))
        }
        other => Err(fail(ErrorCode::Unsupported, format!("termic-server does not support {} yet", verb_name(&other)))),
    }
}

/// Server tasks have exactly one tab, the agent.
fn check_tab(tab: Option<&str>) -> Result<(), Fail> {
    match tab {
        None | Some(AGENT_TAB) | Some("1") | Some("") => Ok(()),
        Some(t) => Err(fail(ErrorCode::NotFound, format!("no tab \"{t}\": termic-server tasks have one tab, \"agent\""))),
    }
}

// ───────────────────────────── lookup ────────────────────────────────

fn find_project<'a>(projects: &'a [Project], name: &str) -> Option<&'a Project> {
    projects.iter().find(|p| p.id == name).or_else(|| projects.iter().find(|p| p.name == name)).or_else(|| projects.iter().find(|p| p.name.eq_ignore_ascii_case(name)))
}

/// A live task by id or name (optionally within a project), or the task
/// whose directory holds `cwd`.
pub fn resolve(d: &Daemon, task: Option<&str>, project: Option<&str>, cwd: Option<&str>) -> Result<TaskRec, Fail> {
    let st = d.st.lock().unwrap();
    let pid = match project {
        Some(name) => Some(find_project(&st.projects, name).ok_or_else(|| fail(ErrorCode::NotFound, format!("no project named \"{name}\"")))?.id.clone()),
        None => None,
    };
    let live: Vec<&TaskRec> = st.tasks.iter().filter(|t| !t.archived && pid.as_ref().is_none_or(|p| &t.project_id == p)).collect();
    if let Some(name) = task.filter(|s| !s.is_empty()) {
        if let Some(t) = live.iter().find(|t| t.id == name) {
            return Ok((*t).clone());
        }
        let mut hits: Vec<&&TaskRec> = live.iter().filter(|t| t.name == name).collect();
        if hits.is_empty() {
            hits = live.iter().filter(|t| t.name.eq_ignore_ascii_case(name)).collect();
        }
        return match hits.len() {
            0 => Err(fail(ErrorCode::NotFound, format!("no task named \"{name}\""))),
            1 => Ok((*hits[0]).clone()),
            _ => Err(fail(ErrorCode::Ambiguous, format!("\"{name}\" matches tasks in more than one project; pass --project"))),
        };
    }
    if let Some(cwd) = cwd {
        if let Some(t) = live.iter().filter(|t| daemon::path_within(cwd, &t.path) && !t.is_main_checkout).max_by_key(|t| t.path.len()) {
            return Ok((*t).clone());
        }
    }
    Err(fail(ErrorCode::BadRequest, "name a task"))
}

fn summary(d: &Daemon, t: &TaskRec, with_diff: bool) -> TaskSummary {
    let project = d.st.lock().unwrap().project_name(&t.project_id);
    let alive = d.agent_pty(&t.id).is_some();
    let diff = if with_diff { daemon::diff_stat(t).map(|s| DiffStat { files_changed: s.files_changed, insertions: s.insertions, deletions: s.deletions, untracked: s.untracked }) } else { None };
    TaskSummary {
        id: t.id.clone(),
        name: t.name.clone(),
        project,
        agent: t.agent.clone(),
        agent_args: t.agent_args.clone(),
        branch: t.branch.clone(),
        base_branch: t.base_branch.clone(),
        path: t.path.clone(),
        is_main_checkout: t.is_main_checkout,
        created: t.created.clone(),
        work_state: Some(d.view_of(&t.id).state),
        open_tabs: Some(u32::from(alive)),
        diff,
        org: (!t.org.is_null()).then(|| t.org.clone()),
        ..Default::default()
    }
}

fn list(d: &Daemon, project: Option<&str>, quiet: bool) -> Result<ReplyData, Fail> {
    let (tasks, pid) = {
        let st = d.st.lock().unwrap();
        let pid = match project {
            Some(name) => Some(find_project(&st.projects, name).ok_or_else(|| fail(ErrorCode::NotFound, format!("no project named \"{name}\"")))?.id.clone()),
            None => None,
        };
        (st.tasks.clone(), pid)
    };
    let tasks = tasks.iter().filter(|t| !t.archived && pid.as_ref().is_none_or(|p| &t.project_id == p)).map(|t| summary(d, t, !quiet)).collect();
    Ok(ReplyData::List(ListData { tasks }))
}

fn status(d: &Daemon, t: &TaskRec) -> TaskStatus {
    let s = summary(d, t, true);
    let alive = d.agent_pty(&t.id).is_some();
    let state = s.work_state.clone();
    TaskStatus {
        dirty_files: s.diff.as_ref().map(|x| x.files_changed + x.untracked),
        summary: s,
        sandbox: "off".into(),
        sessions: 1,
        tabs: Some(vec![TabStatus {
            id: AGENT_TAB.into(),
            index: 1,
            kind: "agent".into(),
            agent: t.agent.clone(),
            title: t.agent.clone(),
            state,
            is_default: true,
            live: alive,
            ..Default::default()
        }]),
    }
}

// ───────────────────────────── send / wait ───────────────────────────

/// Type a prompt into the task's agent at once. Only a running one: the
/// desktop starts agents (resuming their session), so one that is not
/// running is started by opening the task in Termic.
fn send(d: &Arc<Daemon>, t: &TaskRec, prompt: String, wait: bool, timeout_ms: Option<u64>) -> Result<ReplyData, Fail> {
    if prompt.trim().is_empty() {
        return Err(fail(ErrorCode::BadRequest, "nothing to send: the prompt is empty"));
    }
    if prompt.len() > MAX_PROMPT {
        return Err(fail(ErrorCode::BadRequest, "the prompt is too long (256 KiB at most)"));
    }
    let pty = d.agent_pty(&t.id).ok_or_else(|| fail(ErrorCode::NotFound, format!("{}'s agent is not running; open the task in Termic to start it", t.name)))?;
    d.type_prompt(pty, prompt);
    let mode = send_mode::DELIVERED;
    let wait = wait.then(|| wait_settled(d, &t.id, timeout_ms));
    Ok(ReplyData::Send(SendData { task_id: t.id.clone(), mode: mode.into(), capable: true, wait }))
}

/// Block until the task's agent is settled with nothing queued, or the
/// timeout (capped at 5 minutes). Waits on the snapshot condvar; the
/// monitor bumps it on every state change.
pub fn wait_settled(d: &Daemon, task_id: &str, timeout_ms: Option<u64>) -> WaitResult {
    let budget = timeout_ms.map(Duration::from_millis).unwrap_or(WAIT_CAP).min(WAIT_CAP);
    let until = Instant::now() + budget;
    let mut seen = d.seq();
    loop {
        let state = d.view_of(task_id).state;
        let live = d.agent_pty(task_id);
        // The view lags a fresh prompt by one monitor pass; a pty that just
        // took input reads as working until the monitor catches up.
        let fresh_input = live.as_ref().is_some_and(|p| {
            let (exited, act, _, _) = p.activity();
            !exited && act.is_some_and(|t| t.elapsed() < d.quiet)
        });
        if !fresh_input {
            match state.as_str() {
                "done" | "idle" | "inactive" => return WaitResult { outcome: WaitOutcome::Done, state: Some(state), detail: None },
                "waiting" => return WaitResult { outcome: WaitOutcome::NeedsInput, state: Some(state), detail: None },
                _ => {}
            }
        }
        if Instant::now() >= until {
            return WaitResult { outcome: WaitOutcome::Timeout, state: Some(state), detail: None };
        }
        // Wake at the latest when a fresh input's quiet window closes.
        let step = (Instant::now() + d.quiet).min(until);
        seen = d.wait_seq(seen, Some(step), &|| false);
    }
}

// ───────────────────────────── the rest ──────────────────────────────

fn rename(d: &Arc<Daemon>, t: &TaskRec, name: &str) -> Result<ReplyData, Fail> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_NAME || name.chars().any(|c| c.is_control()) {
        return Err(fail(ErrorCode::BadRequest, "a task needs a name (at most 200 characters, no control characters)"));
    }
    let renamed = {
        let mut st = d.st.lock().unwrap();
        if st.tasks.iter().any(|x| !x.archived && x.id != t.id && x.project_id == t.project_id && x.name.eq_ignore_ascii_case(name)) {
            return Err(fail(ErrorCode::Conflict, format!("a task named \"{name}\" already exists")));
        }
        let x = st.tasks.iter_mut().find(|x| x.id == t.id).ok_or_else(|| fail(ErrorCode::NotFound, "the task is gone"))?;
        x.name = name.to_string();
        // The organisation's name too, or the next desktop sync would put
        // the old one back (last write wins).
        if let Some(o) = x.org.as_object_mut() {
            o.insert("name".into(), serde_json::Value::String(name.to_string()));
            // Newer than what any desktop holds, or none would take it.
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            o.insert("at".into(), serde_json::Value::from(now));
        }
        let x = x.clone();
        d.save(&st);
        x
    };
    d.bump();
    Ok(ReplyData::Rename(RenameData { task: summary(d, &renamed, false), old_name: t.name.clone() }))
}

/// The newest Claude transcript for a task's directory.
pub fn claude_transcript(t: &TaskRec) -> Option<std::path::PathBuf> {
    let dir = util::home().join(".claude").join("projects").join(termic_remote::transcript::claude_project_dir_name(&t.path));
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
        .map(|e| e.path())
}

fn diff(t: &TaskRec, full: bool) -> Result<ReplyData, Fail> {
    let s = daemon::diff_stat(t).ok_or_else(|| fail(ErrorCode::Internal, "git could not compute the diff"))?;
    let base = daemon::merge_base(t).unwrap_or_default();
    let commits = daemon::git(&t.path, &["log", "--oneline", &format!("{base}..HEAD")]).unwrap_or_default();
    let patch = if full { daemon::git(&t.path, &["diff", &base]).ok() } else { None };
    Ok(ReplyData::Diff(DiffData { task_id: t.id.clone(), files_changed: s.files_changed + s.untracked, insertions: s.insertions, deletions: s.deletions, untracked: s.untracked, commits, diff: patch }))
}

fn project_info(p: &Project, tasks: &[TaskRec]) -> ProjectInfo {
    ProjectInfo {
        id: p.id.clone(),
        name: p.name.clone(),
        root_path: p.path.clone(),
        tasks: tasks.iter().filter(|t| !t.archived && t.project_id == p.id).count() as u32,
        // The desktop's own default applies (its registry starts agents).
        default_agent: String::new(),
        // A server project is always one repo.
        project_type: "single".into(),
        members: Vec::new(),
        profile: None,
        server: None,
        non_git: p.non_git,
    }
}

/// `git clone <url> <path>` for `project_add --clone`: the path must be
/// inside the user's home and not exist yet; git runs under the login
/// shell's PATH and credentials, as exec does.
fn clone_into(path: &str, url: &str) -> Result<(), Fail> {
    let home = util::home();
    let dest = match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => std::path::PathBuf::from(path),
    };
    if !dest.is_absolute() || dest.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !dest.starts_with(&home) {
        return Err(fail(ErrorCode::BadRequest, format!("{path}: clone into a folder inside your home on the server")));
    }
    if dest.exists() {
        return Err(fail(ErrorCode::Conflict, format!("{path} already exists on the server")));
    }
    if url.starts_with('-') || url.trim().is_empty() {
        return Err(fail(ErrorCode::BadRequest, "not a git URL"));
    }
    let out = std::process::Command::new("/bin/sh")
        .args(["-lc", "exec git clone --quiet -- \"$0\" \"$1\"", url, &dest.to_string_lossy()])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| fail(ErrorCode::Internal, format!("could not run git: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(fail(ErrorCode::Internal, format!("git clone failed: {}", err.trim())));
    }
    Ok(())
}

fn project_add(d: &Arc<Daemon>, path: &str, non_git: bool) -> Result<ReplyData, Fail> {
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => util::home().join(rest),
        None if path == "~" => util::home(),
        None => std::path::PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err(fail(ErrorCode::BadRequest, format!("\"{path}\" is not an absolute path on the server")));
    }
    let canon = std::fs::canonicalize(&expanded).map_err(|e| fail(ErrorCode::NotFound, format!("{path}: {e}")))?;
    if !canon.is_dir() {
        return Err(fail(ErrorCode::BadRequest, format!("{path} is not a directory")));
    }
    let canon = canon.to_string_lossy().to_string();
    let (root, plain) = match daemon::git(&canon, &["rev-parse", "--show-toplevel"]) {
        Ok(top) => (top.trim().to_string(), false),
        Err(_) if non_git => (canon.clone(), true),
        Err(_) => return Err(fail(ErrorCode::BadRequest, format!("{canon} is not a git repository (pass --non-git to add it as a plain folder)"))),
    };
    let mut st = d.st.lock().unwrap();
    if let Some(p) = st.projects.iter().find(|p| p.path == root) {
        return Ok(ReplyData::ProjectAdd(ProjectAddData { project: project_info(p, &st.tasks) }));
    }
    let base = root.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("project").to_string();
    let mut name = base.clone();
    let mut n = 2;
    while st.projects.iter().any(|p| p.name.eq_ignore_ascii_case(&name)) {
        name = format!("{base}-{n}");
        n += 1;
    }
    let p = Project { id: util::uuid(), name, path: root, non_git: plain };
    st.projects.push(p.clone());
    d.save(&st);
    let info = project_info(&p, &st.tasks);
    drop(st);
    util::log(&format!("added project {} at {}", p.name, p.path));
    d.bump();
    Ok(ReplyData::ProjectAdd(ProjectAddData { project: info }))
}

fn project_remove(d: &Arc<Daemon>, name: &str) -> Result<ReplyData, Fail> {
    let (p, ids) = {
        let st = d.st.lock().unwrap();
        let p = find_project(&st.projects, name).cloned().ok_or_else(|| fail(ErrorCode::NotFound, format!("no project named \"{name}\"")))?;
        let ids: Vec<String> = st.tasks.iter().filter(|t| t.project_id == p.id && !t.archived).map(|t| t.id.clone()).collect();
        (p, ids)
    };
    for id in &ids {
        let _ = d.archive(id);
    }
    {
        let mut st = d.st.lock().unwrap();
        st.projects.retain(|x| x.id != p.id);
        st.tasks.retain(|t| t.project_id != p.id);
        d.save(&st);
    }
    d.bump();
    Ok(ReplyData::ProjectRemove(ProjectRemoveData { name: p.name, removed_tasks: ids.len() as u32 }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn last_assistant_text_skips_sidechains_and_tool_only_turns() {
        let j = [
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"final"}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":"sub"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
        ]
        .join("\n");
        assert_eq!(termic_remote::transcript::last_assistant_text(&j).as_deref(), Some("final"));
    }

}

/// Most `exec` returns: a git log or a file read, never a stream.
const EXEC_MAX_OUT: usize = 64 * 1024 * 1024;
const EXEC_DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// Whether `dir` is inside a registered project or one of this server's
/// worktrees: the only places `exec` runs (docs/remote.md, Servers).
/// A task the desktop made itself, recorded here as plain data (no agent
/// started): its folder must be one this box lets a desktop work in, and
/// its project one the box has. An existing record keeps its creation time.
fn task_put(d: &Arc<Daemon>, mut t: TaskRec) -> Result<ReplyData, Fail> {
    if !util::valid_task_id(&t.id) {
        return Err(fail(ErrorCode::BadRequest, "a task id is a uuid"));
    }
    if !exec_allowed(d, std::path::Path::new(&t.path)) {
        return Err(fail(ErrorCode::BadRequest, format!("{} is not inside a project or worktree on this server", t.path)));
    }
    {
        let mut st = d.st.lock().unwrap();
        if !st.projects.iter().any(|p| p.id == t.project_id) {
            return Err(fail(ErrorCode::NotFound, "no such project on this server"));
        }
        match st.tasks.iter_mut().find(|x| x.id == t.id) {
            Some(x) => {
                t.created = x.created.clone();
                if t.org.is_null() {
                    t.org = x.org.clone();
                }
                *x = t.clone();
            }
            None => st.tasks.push(t.clone()),
        }
        d.save(&st);
    }
    util::log(&format!("recorded task {}", t.name));
    d.refresh_diff(&t.id);
    d.poke();
    d.bump();
    Ok(ReplyData::New(NewData { task: summary(d, &t, false), wait: None }))
}

pub(crate) fn exec_allowed(d: &Daemon, dir: &std::path::Path) -> bool {
    let Ok(dir) = dir.canonicalize() else { return false };
    let mut roots: Vec<std::path::PathBuf> = d.st.lock().unwrap().projects.iter().map(|p| std::path::PathBuf::from(&p.path)).collect();
    roots.push(d.worktrees_dir());
    roots.into_iter().filter_map(|r| r.canonicalize().ok()).any(|r| dir.starts_with(r))
}

/// Run a program in a folder for the desktop (its git, its file reads), with
/// the login shell's PATH, a timeout, and capped output.
fn exec(d: &Arc<Daemon>, cwd: &str, argv: &[String], env: &[(String, String)], stdin: Option<&str>, timeout_ms: Option<u64>) -> Result<ReplyData, Fail> {
    use std::io::{Read, Write};
    use std::process::{Command as Proc, Stdio};
    if argv.is_empty() {
        return Err(fail(ErrorCode::BadRequest, "exec needs a program"));
    }
    let dir = std::path::PathBuf::from(cwd);
    if !exec_allowed(d, &dir) {
        return Err(fail(ErrorCode::BadRequest, format!("{cwd} is not inside a project or worktree on this server")));
    }
    let input = match stdin {
        Some(b) => Some(termic_remote::unb64(b).ok_or_else(|| fail(ErrorCode::BadRequest, "stdin is not base64"))?),
        None => None,
    };
    // `exec "$0" "$@"` under a login shell: the PATH the user's own shell has.
    let mut cmd = Proc::new("/bin/sh");
    cmd.arg("-lc").arg("exec \"$0\" \"$@\"").args(argv).current_dir(&dir);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| fail(ErrorCode::Internal, format!("could not start {}: {e}", argv[0])))?;
    if let (Some(bytes), Some(mut w)) = (input, child.stdin.take()) {
        std::thread::spawn(move || { let _ = w.write_all(&bytes); });
    }
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut o = Vec::new();
        let _ = (&mut out).take(EXEC_MAX_OUT as u64).read_to_end(&mut o);
        o
    });
    let ereader = std::thread::spawn(move || {
        let mut e = Vec::new();
        let _ = (&mut err).take(1024 * 1024).read_to_end(&mut e);
        e
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(EXEC_DEFAULT_TIMEOUT_MS));
    // Waited for on its own thread, not polled: a sleep loop here woke every
    // 5 ms for as long as a git or a tar ran.
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let _ = tx.send(child.wait()); });
    let status = match rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
        Ok(Ok(st)) => st,
        Ok(Err(e)) => return Err(fail(ErrorCode::Internal, format!("{}: {e}", argv[0]))),
        Err(_) => {
            // SAFETY: the pid of the child we spawned; the waiter reaps it.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            let _ = rx.recv();
            return Err(fail(ErrorCode::Internal, format!("{} did not finish in time", argv[0])));
        }
    };
    let stdout = reader.join().unwrap_or_default();
    let stderr = ereader.join().unwrap_or_default();
    Ok(ReplyData::Exec(termic_proto::ExecData {
        code: status.code().unwrap_or(-1),
        stdout: termic_remote::b64(&stdout),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }))
}
