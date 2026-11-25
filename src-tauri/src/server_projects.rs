// Server projects as ordinary desktop projects (docs/remote.md, Servers,
// stage 1). A server's projects and tasks are mirrored into the desktop's own
// store, tagged `Project.server`, so the normal sidebar and task view draw
// them and the desktop's order, pins, groups and names apply. The box stays
// the authority on what EXISTS (a project registered, a worktree made or
// removed); the desktop owns everything about how it is organised.
//
// Ids are the box's own, so a repeat sync updates the same records. A task
// that left the box is marked archived (it stays in History), never deleted.

use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::profiles::ProfileId;
use crate::{Project, Task};

fn app() -> &'static Mutex<Option<tauri::AppHandle>> {
    static A: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(None))
}

pub(crate) fn init(handle: tauri::AppHandle) {
    {
        use tauri::Emitter;
        let h = handle.clone();
        crate::remote_client::set_pty_sink(Box::new(move |pid, e| match e {
            crate::remote_client::PtyEvent::Data(data) => {
                crate::server_pty_output(&h, pid, &data);
                let _ = h.emit(&format!("pty://{pid}"), crate::PtyChunk { data });
            }
            crate::remote_client::PtyEvent::Exit(reason) => {
                crate::server_pty_gone(&h, pid);
                let restarted = reason == termic_remote::wire::PTY_RESTARTED;
                // A refusal or a dropped link reads in the pane before it ends.
                if reason != "exited" && !restarted {
                    let _ = h.emit(&format!("pty://{pid}"), crate::PtyChunk { data: format!("\r\n[{reason}]\r\n").into_bytes() });
                }
                let _ = h.emit(&format!("pty-exit://{pid}"), crate::PtyExit { code: None, restarted });
            }
        }));
    }
    *app().lock().unwrap() = Some(handle);
    refresh_paths();
}

pub(crate) fn app_handle() -> Option<tauri::AppHandle> {
    app().lock().unwrap().clone()
}

/// Folders that live on a server, longest first: each server project's
/// root and each of its tasks' worktrees, with the server's id. `git_bytes`
/// (lib.rs) runs git there through termic-server's `exec`.
/// Every project's and task's folder with where it lives (None: this
/// computer), longest first. LOCAL ones are in it too: a box path can be
/// spelled exactly like a local one (`/home/alice/src/api` on a Linux
/// desktop and its box, a box project at `~`), and the most specific
/// folder decides, so a local project is never sent to a box.
fn paths() -> &'static std::sync::RwLock<Vec<(String, Option<String>)>> {
    static P: OnceLock<std::sync::RwLock<Vec<(String, Option<String>)>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

pub(crate) fn refresh_paths() {
    let projects = crate::load_projects_all();
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    for p in &projects {
        out.push((p.root_path.clone(), p.server.clone()));
    }
    for t in crate::load_tasks_all() {
        if let Some(p) = projects.iter().find(|p| p.id == t.project_id) {
            if !t.path.is_empty() {
                out.push((t.path.clone(), p.server.clone()));
            }
        }
    }
    out.retain(|(p, _)| !p.is_empty());
    out.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    *paths().write().unwrap() = out;
}

/// The server a folder lives on: the most specific project or task folder
/// holding it, when that one is a server's.
pub(crate) fn server_for_path(dir: &std::path::Path) -> Option<String> {
    let dir = dir.to_string_lossy();
    route(&paths().read().unwrap(), &dir)
}

fn route(table: &[(String, Option<String>)], dir: &str) -> Option<String> {
    table.iter().find(|(p, _)| dir == p.as_str() || dir.starts_with(&format!("{p}/"))).and_then(|(_, s)| s.clone())
}

/// Run a program in a server folder through termic-server's `exec`:
/// (exit code, stdout, stderr).
pub(crate) fn exec_on(server: &str, cwd: &std::path::Path, argv: &[&str], env: &[(&str, &str)]) -> Result<(i32, Vec<u8>, String), String> {
    exec_with_stdin(server, cwd, argv, env, None)
}

/// `exec_on` with bytes for the program's stdin (a file write).
pub(crate) fn exec_with_stdin(server: &str, cwd: &std::path::Path, argv: &[&str], env: &[(&str, &str)], stdin: Option<&[u8]>) -> Result<(i32, Vec<u8>, String), String> {
    let mut req = json!({
        "cmd": "exec",
        "cwd": cwd.to_string_lossy(),
        "argv": argv,
        "env": env.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
    });
    if let Some(b) = stdin {
        req["stdin"] = Value::String(termic_remote::b64(b));
    }
    let d = data(crate::remote_client::call(server, req, Some(std::time::Duration::from_secs(130)))?, "exec")?;
    let out = termic_remote::unb64(d.get("stdout").and_then(Value::as_str).unwrap_or_default()).unwrap_or_default();
    Ok((d.get("code").and_then(Value::as_i64).unwrap_or(-1) as i32, out, s(&d, "stderr")))
}

/// Every window reloads its store (`store://reload`, src/App.tsx).
/// Emit to every window (remote_server.rs: a phone looked at a task).
pub(crate) fn emit_all<S: serde::Serialize + Clone>(topic: &str, payload: S) {
    use tauri::Emitter;
    if let Some(a) = app().lock().unwrap().as_ref() {
        let _ = a.emit(topic, payload);
    }
}

fn reload_windows() {
    use tauri::Emitter;
    if let Some(a) = app().lock().unwrap().as_ref() {
        let _ = a.emit("store://reload", ());
    }
}

/// One sync at a time per server; a change during one runs it again after.
fn busy() -> &'static Mutex<std::collections::HashMap<String, bool>> {
    static B: OnceLock<Mutex<std::collections::HashMap<String, bool>>> = OnceLock::new();
    B.get_or_init(Default::default)
}

/// Sync a server's projects and tasks into the store, off the caller's thread.
/// How long a server's projects may go without a resync while connected.
const STALE: std::time::Duration = std::time::Duration::from_secs(60);

/// Resync if the last one is older than STALE (remote_client.rs, on pong).
pub(crate) fn sync_if_stale(server: &str) {
    static LAST: OnceLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> = OnceLock::new();
    let now = std::time::Instant::now();
    {
        let mut m = LAST.get_or_init(Default::default).lock().unwrap();
        if m.get(server).is_some_and(|t| now.duration_since(*t) < STALE) {
            return;
        }
        m.insert(server.to_string(), now);
    }
    sync_soon(server);
}

pub(crate) fn sync_soon(server: &str) {
    {
        let mut b = busy().lock().unwrap();
        match b.get_mut(server) {
            Some(again) => {
                *again = true;
                return;
            }
            None => {
                b.insert(server.to_string(), false);
            }
        }
    }
    let server = server.to_string();
    std::thread::spawn(move || loop {
        match sync(&server) {
            Ok(true) => {
                refresh_paths();
                reload_windows();
            }
            Ok(false) => {}
            Err(e) => crate::dlog(&format!("[server-projects] {server}: {e}")),
        }
        let mut b = busy().lock().unwrap();
        if b.get(&server).copied() == Some(true) {
            b.insert(server.clone(), false);
            continue;
        }
        b.remove(&server);
        break;
    });
}

/// The window label of the profile a server belongs to (where its projects
/// live), for the sidebar to list it only there.
pub(crate) fn profile_label(server: &str) -> String {
    profile_for(server, &crate::load_projects_all()).window_label()
}

/// The profile a server's projects live in: the one whose window added it,
/// else where earlier syncs put them, else the root profile.
fn profile_for(server: &str, projects: &[Project]) -> ProfileId {
    // The profile whose window added it.
    if let Some(id) = crate::remote_client::load_servers().into_iter()
        .find(|r| r.id == server)
        .and_then(|r| r.profile)
        .and_then(|label| ProfileId::from_window_label(&label))
    {
        return id;
    }
    if let Some(p) = projects.iter().find(|p| p.server.as_deref() == Some(server)) {
        return p.profile.clone();
    }
    let reg = crate::profile_registry();
    let ids = reg.ids();
    if ids.contains(&ProfileId::Root) {
        ProfileId::Root
    } else {
        ids.into_iter().next().unwrap_or(ProfileId::Root)
    }
}

fn data(reply: Value, what: &str) -> Result<Value, String> {
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!("{what}: {}", reply.pointer("/error/message").and_then(Value::as_str).unwrap_or("no answer")));
    }
    Ok(reply.get("data").cloned().unwrap_or(Value::Null))
}

/// Mirror one server. Ok(true) when the store changed.
fn sync(server: &str) -> Result<bool, String> {
    let boxed_projects = data(crate::remote_client::call(server, json!({"cmd": "project_list"}), None)?, "project_list")?;
    let boxed_tasks = data(crate::remote_client::call(server, json!({"cmd": "list"}), None)?, "list")?;
    let box_projects: Vec<Value> = boxed_projects.get("projects").and_then(Value::as_array).cloned().unwrap_or_default();
    let box_tasks: Vec<Value> = boxed_tasks.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut projects = crate::load_projects_all();
    let tasks = crate::load_tasks_all();
    let (projects_changed, changed_tasks) = mirror(server, &box_projects, &box_tasks, &mut projects, &tasks);
    if projects_changed {
        crate::save_projects(&projects).map_err(|e| e.to_string())?;
    }
    for t in &changed_tasks {
        crate::save_task(t).map_err(|e| e.to_string())?;
    }
    synced().lock().unwrap().insert(server.to_string());
    // The agents' hooks on the box (once a run), from a folder exec may use.
    if let Some(root) = box_projects.iter().find_map(|p| p.get("root_path").and_then(Value::as_str).filter(|r| !r.is_empty())) {
        crate::agent_hooks::sync_server(server, std::path::Path::new(root));
    }
    Ok(projects_changed || !changed_tasks.is_empty())
}

/// A server was removed: drop its mirrored projects and their task records
/// from this machine's store. Nothing on the box is touched.
pub(crate) fn forget_server(server: &str) {
    let mut projects = crate::load_projects_all();
    let gone: std::collections::HashSet<String> = projects.iter().filter(|p| p.server.as_deref() == Some(server)).map(|p| p.id.clone()).collect();
    if gone.is_empty() {
        return;
    }
    projects.retain(|p| !gone.contains(&p.id));
    if let Err(e) = crate::save_projects(&projects) {
        crate::dlog(&format!("[server-projects] forget {server}: {e}"));
        return;
    }
    for t in crate::load_tasks_all().into_iter().filter(|t| gone.contains(&t.project_id)) {
        let _ = crate::delete_task_file(&t.id);
    }
    refresh_paths();
    reload_windows();
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A task's organisation as every desktop on a box shares it (the box keeps
/// it opaque, task_put `org`): its name, pin, order and group.
pub(crate) fn org_of(t: &Task) -> Value {
    json!({ "name": t.name, "pinned": t.pinned, "order": t.order, "group": t.group })
}

fn apply_org(t: &mut Task, org: &Value) {
    if let Some(n) = org.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()) {
        t.name = n.to_string();
    }
    t.pinned = org.get("pinned").and_then(Value::as_bool).unwrap_or(false);
    t.order = org.get("order").and_then(Value::as_u64).map(|v| v as u32);
    t.group = org.get("group").cloned().and_then(|g| serde_json::from_value(g).ok());
}

/// The organisation last sent to (or taken from) the box, per task, with
/// when it was written: a save that changed none of it sends nothing, one
/// the mirror made from the box's record is not sent straight back, and a
/// box record older than it (a resync already under way when this desktop
/// wrote) does not undo it.
fn pushed() -> &'static Mutex<std::collections::HashMap<String, (Value, i64)>> {
    static P: OnceLock<Mutex<std::collections::HashMap<String, (Value, i64)>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Record `org` as written at `at`; returns that time.
fn note_pushed(task: &str, org: Value, at: i64) -> i64 {
    pushed().lock().unwrap().insert(task.to_string(), (org, at));
    at
}

/// The box's record for a task, when it is newer than what this desktop
/// last wrote or took for it (last write wins). A desktop that knows
/// nothing of the task yet takes the box's.
fn newer_box_org<'a>(task: &str, bt: &'a Value) -> Option<&'a Value> {
    let org = bt.get("org").filter(|o| o.is_object())?;
    let at = org.get("at").and_then(Value::as_i64).unwrap_or(0);
    match pushed().lock().unwrap().get(task) {
        Some((_, mine)) if at <= *mine => None,
        _ => Some(org),
    }
}

/// Every write of a task record (lib.rs `save_task`): a server task whose
/// organisation changed has it sent to its box, off the caller's thread,
/// so the other desktops there file it the same way. Last write wins.
pub(crate) fn push_org_if_changed(t: &Task) {
    if t.archived {
        return;
    }
    let Some(server) = server_for_path(std::path::Path::new(&t.path)) else { return };
    // Not before this run's first sync of that box: what this desktop holds
    // then may be older than what another desktop wrote there meanwhile,
    // and stamping it "now" would overwrite theirs.
    if !synced().lock().unwrap().contains(&server) {
        return;
    }
    let org = org_of(t);
    {
        let m = pushed().lock().unwrap();
        if m.get(&t.id).is_some_and(|(o, _)| *o == org) {
            return;
        }
    }
    let t = t.clone();
    std::thread::spawn(move || {
        if let Err(e) = put_task(&server, &t) {
            // Forget it was sent, so the next save of the task sends it again.
            pushed().lock().unwrap().remove(&t.id);
            crate::dlog(&format!("[server-projects] {server}: could not share {}'s organisation: {e}", t.name));
        }
    });
}

/// Servers mirrored at least once this run (`push_org_if_changed`).
fn synced() -> &'static Mutex<std::collections::HashSet<String>> {
    static S: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// The pure part of a sync: what to change in `projects` (in place) and
/// which task records to write. Returns (projects changed, tasks to save).
fn mirror(server: &str, box_projects: &[Value], box_tasks: &[Value], projects: &mut Vec<Project>, tasks: &[Task]) -> (bool, Vec<Task>) {
    let profile = profile_for(server, projects);
    let mut projects_changed = false;
    for bp in box_projects {
        let (id, name, root) = (s(bp, "id"), s(bp, "name"), s(bp, "root_path"));
        let non_git = bp.get("non_git").and_then(|v| v.as_bool()).unwrap_or(false);
        if id.is_empty() {
            continue;
        }
        match projects.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                // The box decides where it is; the desktop keeps its name.
                if p.root_path != root || p.server.as_deref() != Some(server) || p.non_git != non_git {
                    p.root_path = root;
                    p.server = Some(server.to_string());
                    p.non_git = non_git;
                    projects_changed = true;
                }
            }
            None => {
                projects.push(Project {
                    id,
                    name,
                    root_path: root,
                    server: Some(server.to_string()),
                    default_cli: s(bp, "default_agent"),
                    profile: profile.clone(),
                    non_git,
                    ..Default::default()
                });
                projects_changed = true;
            }
        }
    }
    // A project the box no longer has goes (its tasks are archived below:
    // so this server's project ids are taken before it goes).
    let mine: std::collections::HashSet<String> = projects.iter().filter(|p| p.server.as_deref() == Some(server)).map(|p| p.id.clone()).collect();
    let on_box: std::collections::HashSet<String> = box_projects.iter().map(|p| s(p, "id")).collect();
    let before = projects.len();
    projects.retain(|p| p.server.as_deref() != Some(server) || on_box.contains(&p.id));
    projects_changed |= projects.len() != before;

    // A box task names its project by the BOX's name for it; the desktop may
    // call it something else (a rename in Settings), so it is matched by the
    // box's id, which the mirrored project keeps.
    let project_of = |name: &str| box_projects.iter().find(|bp| s(bp, "name") == name).map(|bp| s(bp, "id"))
        .filter(|id| projects.iter().any(|p| p.id == *id && p.server.as_deref() == Some(server)));
    let mut out: Vec<Task> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for bt in box_tasks {
        let id = s(bt, "id");
        let Some(project_id) = project_of(&s(bt, "project")) else { continue };
        seen.insert(id.clone());
        match tasks.iter().find(|t| t.id == id) {
            Some(t) => {
                let mut n = t.clone();
                n.path = s(bt, "path");
                n.branch = s(bt, "branch");
                n.project_id = project_id;
                n.archived = false;
                // What a desktop last filed it as on the box wins (another
                // desktop may have renamed, pinned or grouped it). A box
                // record without one leaves the desktop's own.
                if let Some(org) = newer_box_org(&n.id, bt) {
                    apply_org(&mut n, org);
                    note_pushed(&n.id, org_of(&n), org.get("at").and_then(Value::as_i64).unwrap_or(0));
                }
                if n.path != t.path || n.branch != t.branch || n.project_id != t.project_id || t.archived || org_of(&n) != org_of(t) {
                    out.push(n);
                }
            }
            None => {
                let mut n = Task {
                id,
                name: s(bt, "name"),
                project_id,
                path: s(bt, "path"),
                branch: s(bt, "branch"),
                base_branch: s(bt, "base_branch"),
                cli: s(bt, "agent"),
                created: s(bt, "created"),
                is_main_checkout: bt.get("is_main_checkout").and_then(Value::as_bool).unwrap_or(false),
                profile: profile.clone(),
                ..Default::default()
                };
                if let Some(org) = newer_box_org(&n.id, bt) {
                    apply_org(&mut n, org);
                    note_pushed(&n.id, org_of(&n), org.get("at").and_then(Value::as_i64).unwrap_or(0));
                }
                out.push(n);
            }
        }
    }
    // Tasks of this server's projects that left the box: archived, kept.
    for t in tasks {
        if !t.archived && mine.contains(&t.project_id) && !seen.contains(&t.id) {
            let mut n = t.clone();
            n.archived = true;
            out.push(n);
        }
    }
    (projects_changed, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bp(id: &str, name: &str, root: &str) -> Value {
        json!({"id": id, "name": name, "root_path": root, "default_agent": "claude"})
    }
    fn bt(id: &str, project: &str, path: &str) -> Value {
        json!({"id": id, "name": id, "project": project, "path": path, "branch": id, "base_branch": "main", "agent": "claude", "created": "2026-11-20T10:00:00Z", "is_main_checkout": false})
    }

    #[test]
    fn mirrors_projects_and_tasks_keeping_what_the_desktop_owns() {
        let mut projects = vec![];
        let (pc, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[bt("t1", "bot", "/home/u/.termic-server/worktrees/bot/t1")], &mut projects, &[]);
        assert!(pc);
        assert_eq!(projects[0].server.as_deref(), Some("box"));
        assert_eq!((out[0].id.as_str(), out[0].project_id.as_str()), ("t1", "p1"));

        // The desktop renamed and pinned it; a resync keeps both.
        let mut kept = out[0].clone();
        kept.name = "my name".into();
        kept.pinned = true;
        let (pc, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[bt("t1", "bot", "/home/u/.termic-server/worktrees/bot/t1")], &mut projects, &[kept.clone()]);
        assert!(!pc, "nothing changed");
        assert!(out.is_empty(), "an unchanged task is not rewritten");

        // It left the box: archived, not deleted.
        let (_, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[], &mut projects, &[kept]);
        assert_eq!(out.len(), 1);
        assert!(out[0].archived && out[0].name == "my name" && out[0].pinned);
    }

    #[test]
    fn the_boxs_organisation_wins_and_a_box_without_one_keeps_the_desktops() {
        let mut projects = vec![];
        let path = "/home/u/.termic-server/worktrees/bot/t1";
        let (_, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[bt("t1", "bot", path)], &mut projects, &[]);
        let mine = out[0].clone();
        // Another desktop renamed, pinned and grouped it on the box.
        let mut theirs = bt("t1", "bot", path);
        theirs["org"] = json!({"name": "their name", "pinned": true, "order": 3, "group": {"id": "g1", "color": "teal"}, "at": now_ms() + 1});
        let (_, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[theirs.clone()], &mut projects, &[mine.clone()]);
        assert_eq!(out.len(), 1);
        let t = &out[0];
        assert_eq!((t.name.as_str(), t.pinned, t.order), ("their name", true, Some(3)));
        assert_eq!(t.group.as_ref().map(|g| g.id.as_str()), Some("g1"));
        // Applied once: the same record again changes nothing, and nothing
        // is queued to go back (the push cache holds what came in).
        let (_, again) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[theirs], &mut projects, &[t.clone()]);
        assert!(again.is_empty());
        assert_eq!(pushed().lock().unwrap().get("t1").map(|(o, _)| o.clone()), Some(org_of(t)));
        // This desktop writes after that; a resync still carrying the box's
        // older record does not undo it.
        let mut mine = t.clone();
        mine.pinned = false;
        note_pushed("t1", org_of(&mine), now_ms() + 10_000);
        let mut stale = bt("t1", "bot", path);
        stale["org"] = json!({"name": "their name", "pinned": true, "order": 3, "group": {"id": "g1", "color": "teal"}, "at": 1});
        let (_, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[stale], &mut projects, &[mine]);
        assert!(out.is_empty(), "an older box record does not overwrite a newer local write");
    }

    #[test]
    fn a_renamed_project_keeps_its_tasks_and_a_removed_one_archives_them() {
        let mut projects = vec![];
        let path = "/home/u/.termic-server/worktrees/bot/t1";
        let (_, out) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[bt("t1", "bot", path)], &mut projects, &[]);
        // Renamed in Settings here; the box still calls it "bot".
        projects[0].name = "My bot".into();
        let (_, again) = mirror("box", &[bp("p1", "bot", "/home/u/bot")], &[bt("t1", "bot", path)], &mut projects, &out);
        assert!(again.iter().all(|t| !t.archived), "a rename here archived the task");
        // Removed on the box: the project goes and its task is archived.
        let (pc, gone) = mirror("box", &[], &[], &mut projects, &out);
        assert!(pc && projects.is_empty());
        assert_eq!(gone.len(), 1);
        assert!(gone[0].archived);
    }

    #[test]
    fn the_most_specific_folder_routes_and_a_local_one_never_goes_to_a_box() {
        let table = vec![
            ("/home/alice/src/api".to_string(), None),
            ("/home/alice".to_string(), Some("box".to_string())),
        ];
        assert_eq!(route(&table, "/home/alice/src/api/lib"), None, "the local project wins");
        assert_eq!(route(&table, "/home/alice/other"), Some("box".into()));
        assert_eq!(route(&table, "/home/alicex"), None);
    }

    #[test]
    fn another_servers_and_local_projects_are_left_alone() {
        let mut projects = vec![
            Project { id: "local".into(), name: "app".into(), root_path: "/Users/u/app".into(), ..Default::default() },
            Project { id: "other".into(), name: "x".into(), server: Some("other-box".into()), ..Default::default() },
        ];
        let (_, _) = mirror("box", &[], &[], &mut projects, &[]);
        assert_eq!(projects.len(), 2);
    }
}

/// The repos under `dir` on a server, for its Add project: the same
/// list `discover_repos` makes for this machine's repos folder. A repo is a
/// folder holding `.git`, up to three levels down; `~` is the box's home.
/// `already_added` names the ones this desktop already has from that
/// server. Nothing is dismissed: that list is this machine's.
#[tauri::command]
pub(crate) async fn server_discover_repos(server: String, dir: String) -> Result<Vec<crate::DiscoveredRepo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = r#"d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/${d#??}";; esac
[ -d "$d" ] || { echo "no such folder: $d" >&2; exit 3; }
find "$d" -mindepth 1 -maxdepth 3 -name node_modules -prune -o -name .git -print 2>/dev/null | sed 's#/\.git$##' | sort"#;
        let (code, out, err) = exec_on(&server, std::path::Path::new("/"), &["/bin/sh", "-c", script, "sh", dir.trim()], &[])?;
        if code != 0 {
            return Err(if err.trim().is_empty() { format!("could not read {dir} on the server") } else { err.trim().to_string() });
        }
        let added: std::collections::HashSet<String> = crate::load_projects_all()
            .into_iter()
            .filter(|p| p.server.as_deref() == Some(server.as_str()))
            .map(|p| p.root_path)
            .collect();
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|path| crate::DiscoveredRepo {
                name: path.rsplit('/').next().unwrap_or(path).to_string(),
                already_added: added.contains(path),
                dismissed: false,
                path: path.to_string(),
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A server's repos folder (servers.json), or "" when it has none.
#[tauri::command]
pub(crate) fn server_repos_dir(server: String) -> String {
    crate::remote_client::load_servers().into_iter().find(|r| r.id == server).and_then(|r| r.repos_dir).unwrap_or_default()
}

#[tauri::command]
pub(crate) fn server_set_repos_dir(server: String, dir: String) -> Result<(), String> {
    crate::remote_client::set_server_repos_dir(&server, &dir)
}

/// Which of `programs` a server project's box can run: each looked up on
/// its login shell's PATH (the TaskHost `which`,
/// docs/remote.md, Servers). The desktop's own agent registry decides
/// what to offer; the box only says what is installed there.
#[tauri::command]
pub(crate) async fn server_which(project_id: String, programs: Vec<String>) -> Result<Vec<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::load_projects_all().into_iter().find(|p| p.id == project_id).ok_or("no such project")?;
        let server = p.server.clone().ok_or("not a server project")?;
        let script = "for p; do command -v \"$p\" >/dev/null 2>&1 && echo 1 || echo 0; done";
        let mut argv: Vec<&str> = vec!["/bin/sh", "-lc", script, "sh"];
        argv.extend(programs.iter().map(String::as_str));
        let (_, out, _) = exec_on(&server, std::path::Path::new(&p.root_path), &argv, &[])?;
        let lines: Vec<bool> = String::from_utf8_lossy(&out).lines().map(|l| l.trim() == "1").collect();
        Ok(programs.iter().enumerate().map(|(i, _)| lines.get(i).copied().unwrap_or(false)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A folder on `server` this desktop made before any task there names it
/// (a project's worktrees folder, ahead of its first task), so `git_bytes`
/// routes it to the box.
pub(crate) fn note_server_path(dir: &std::path::Path, server: &str) {
    let d = dir.to_string_lossy().to_string();
    let mut p = paths().write().unwrap();
    if !p.iter().any(|(x, _)| *x == d) {
        p.push((d, Some(server.to_string())));
        p.sort_by_key(|(x, _)| std::cmp::Reverse(x.len()));
    }
}

/// Record a task the desktop made on its server (termic-server `task_put`).
pub(crate) fn put_task(server: &str, t: &Task) -> Result<(), String> {
    let at = note_pushed(&t.id, org_of(t), now_ms());
    let mut org = org_of(t);
    org["at"] = json!(at);
    let req = json!({
        "cmd": "task_put",
        "task": t.id,
        "name": t.name,
        "project": t.project_id,
        "path": t.path,
        "branch": t.branch,
        "base_branch": t.base_branch,
        "agent": t.cli,
        "is_main_checkout": t.is_main_checkout,
        "org": org,
    });
    data(crate::remote_client::call(server, req, Some(std::time::Duration::from_secs(30)))?, "new").map(|_| ())
}
