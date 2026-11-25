//! The daemon's shared core: persisted projects and tasks, the PTYs the
//! desktop opens here (a task's agent is its `<task>:agent` one), the
//! work-state monitor, and the actions verbs are built from.
//!
//! One monitor thread owns state transitions. It is woken by a PTY (output
//! after a quiet spell, exit) or an action, and otherwise sleeps on a
//! condvar until the next instant a state can change on its own (a working
//! agent's quiet deadline). Nothing runs on a timer while every agent is
//! settled. Clients wait on `seq`, bumped only when a snapshot changed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use termic_remote::screen;
use termic_remote::wire::{Diff, Question, RowGroup, TabRow, TaskRow};

use crate::detect;
use crate::pty::Pty;
use crate::state::{Project, State, TaskRec};
use crate::util;

/// Between a pasted prompt and the Enter that submits it: TUIs treat an
/// Enter inside the same read as part of the paste.
const SUBMIT_BEAT: Duration = Duration::from_millis(250);
/// How much of the ring the screen is rebuilt from.
const SCREEN_BYTES: usize = 128 * 1024;
pub const MAX_PROMPT: usize = 256 * 1024;


/// What a client sees of a task's agent, recomputed by the monitor.
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub state: String,
    pub since_ms: i64,
    pub activity: Option<String>,
    pub question: Option<Question>,
}

pub struct Daemon {
    pub dir: PathBuf,
    pub id: String,
    pub name: String,
    pub quiet: Duration,
    pub st: Mutex<State>,
    views: Mutex<HashMap<String, View>>,
    diffs: Mutex<HashMap<String, Diff>>,
    /// Bumped when anything a snapshot shows changed.
    seq: Mutex<u64>,
    seq_cv: Condvar,
    wake: Mutex<bool>,
    wake_cv: Condvar,
    /// `pty_open` PTYs by the client's id. The daemon owns them, so a
    /// shell or a script outlives the connection that opened it (a laptop
    /// asleep, a dropped network) and the next one attaches.
    pub ptys: Mutex<HashMap<String, Arc<crate::pty::Pty>>>,
    /// A `quit` is ending every PTY to restart onto a new build.
    pub restarting: std::sync::atomic::AtomicBool,
    /// Held across a `pty_open`'s look-up, spawn and insert, so two
    /// connections opening one claim at once start one process.
    pub opening: Mutex<()>,
}

pub type Fail = (termic_proto::ErrorCode, String);

pub fn fail(code: termic_proto::ErrorCode, msg: impl Into<String>) -> Fail {
    (code, msg.into())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Daemon {
    pub fn new(dir: PathBuf, st: State, quiet: Duration) -> Arc<Daemon> {
        Arc::new(Daemon {
            dir,
            id: st.server_id.clone(),
            name: util::hostname(),
            quiet,
            st: Mutex::new(st),
            views: Mutex::new(HashMap::new()),
            diffs: Mutex::new(HashMap::new()),
            seq: Mutex::new(0),
            seq_cv: Condvar::new(),
            wake: Mutex::new(false),
            wake_cv: Condvar::new(),
            ptys: Mutex::new(HashMap::new()),
            restarting: std::sync::atomic::AtomicBool::new(false),
            opening: Mutex::new(()),
        })
    }

    pub fn worktrees_dir(&self) -> PathBuf {
        self.dir.join("worktrees")
    }

    pub fn save(&self, st: &State) {
        if let Err(e) = st.save(&self.dir) {
            util::log(&format!("could not save state.json: {e}"));
        }
    }

    /// Wake the monitor.
    pub fn poke(&self) {
        *self.wake.lock().unwrap() = true;
        self.wake_cv.notify_all();
    }

    /// A snapshot-visible change: wake every client's state thread.
    pub fn bump(&self) {
        *self.seq.lock().unwrap() += 1;
        self.seq_cv.notify_all();
    }

    pub fn seq(&self) -> u64 {
        *self.seq.lock().unwrap()
    }

    /// Block until `seq` moves past `seen`, `stop()` holds, or `until`.
    pub fn wait_seq(&self, seen: u64, until: Option<Instant>, stop: &dyn Fn() -> bool) -> u64 {
        let mut g = self.seq.lock().unwrap();
        while *g == seen && !stop() {
            match until {
                Some(t) => {
                    let now = Instant::now();
                    if now >= t {
                        break;
                    }
                    g = self.seq_cv.wait_timeout(g, t - now).unwrap().0;
                }
                None => g = self.seq_cv.wait(g).unwrap(),
            }
        }
        *g
    }

    /// Wake every waiter without a change (a connection ending).
    pub fn nudge(&self) {
        let _g = self.seq.lock().unwrap();
        self.seq_cv.notify_all();
    }

    /// A task's agent: the PTY the desktop started for it (`<task>:agent`),
    /// while it runs. The desktop owns agents; this daemon never starts one.
    pub fn agent_pty(&self, task_id: &str) -> Option<Arc<Pty>> {
        self.ptys.lock().unwrap().get(&format!("{task_id}:agent")).filter(|p| !p.exited()).cloned()
    }

    pub fn view_of(&self, task_id: &str) -> View {
        let booting = self.agent_pty(task_id).is_some();
        self.views.lock().unwrap().get(task_id).cloned().unwrap_or_else(|| unseen(booting))
    }

    // ───────────────────────── agents ──────────────────────────

    /// Type a prompt into a task's agent, off the caller's thread.
    pub fn type_prompt(self: &Arc<Self>, pty: Arc<Pty>, text: String) {
        let d = self.clone();
        std::thread::spawn(move || d.deliver(&pty, text));
    }

    /// Type a prompt into an agent: bracketed paste when the program asked
    /// for it, then Enter after a beat.
    fn deliver(&self, p: &Pty, text: String) {
        p.mark_prompt();
        let r = if p.bracketed() {
            // A paste-end inside the text would let it type raw keys.
            let body = text.replace("\x1b[201~", "");
            p.input(format!("\x1b[200~{body}\x1b[201~").as_bytes())
        } else {
            p.input(text.replace("\r\n", "\r").replace('\n', "\r").as_bytes())
        };
        if r.is_ok() {
            std::thread::sleep(SUBMIT_BEAT);
            let _ = p.input(b"\r");
            p.mark_prompt();
        }
        self.poke();
    }

    /// The current work state of a task, computed now.
    /// `pty` is the task's agent terminal (`<task>:agent` in `ptys`).
    fn compute(&self, pty: Option<&Arc<Pty>>, now: Instant) -> (View, Option<Instant>) {
        let blank = |s: &str| View { state: s.into(), since_ms: 0, activity: None, question: None };
        let Some(pty) = pty else { return (blank("inactive"), None) };
        let (exited, act, out, inp) = pty.activity();
        let working = !exited && inp.is_some() && act.is_some_and(|t| now.saturating_duration_since(t) < self.quiet);
        let mut lines: Option<Vec<String>> = None;
        let mut screen_lines = || -> Vec<String> {
            lines
                .get_or_insert_with(|| {
                    let (tail, _) = pty.tail(SCREEN_BYTES);
                    let (rows, cols) = pty.size();
                    screen::render(&tail, rows, cols)
                })
                .clone()
        };
        let mut question = None;
        let mut asks = false;
        if !exited && !working {
            question = screen::question(&screen_lines());
            asks = question.is_some() || detect::shows_question(&screen_lines());
        }
        let (watched, seen) = pty.watched();
        let a = detect::Activity { exited, last_activity: act, last_output: out, last_input: inp, question: asks, watched, seen };
        let state = detect::work_state(&a, now, self.quiet);
        let activity = if state == "working" { screen::activity(&screen_lines()) } else { None };
        let deadline = if working { act.map(|t| t + self.quiet) } else { None };
        (View { state: state.into(), since_ms: 0, activity, question: if state == "waiting" { question } else { None } }, deadline)
    }

    /// The monitor: recompute every task's view when woken, publish
    /// changes. Runs for the daemon's life.
    pub fn monitor(self: Arc<Self>) {
        loop {
            let now = Instant::now();
            let ids: Vec<String> = self.st.lock().unwrap().tasks.iter().filter(|t| !t.archived).map(|t| t.id.clone()).collect();
            // The desktop starts a task's agent itself (`<task>:agent`, a
            // daemon-owned PTY): its state is read the same way, the floor
            // for when no desktop is attached (docs/remote.md, Servers).
            let desk = self.ptys.lock().unwrap().clone();
            let mut next: Option<Instant> = None;
            let mut soonest = |t: Instant| next = Some(next.map_or(t, |n: Instant| n.min(t)));
            let mut changed = false;
            let mut settled = Vec::new();
            let mut fresh: HashMap<String, View> = HashMap::new();
            {
                let old = self.views.lock().unwrap();
                for id in &ids {
                    let (mut v, deadline) = self.compute(desk.get(&format!("{id}:agent")), now);
                    if let Some(d) = deadline {
                        soonest(d);
                    }
                    match old.get(id) {
                        Some(o) if o.state == v.state => v.since_ms = o.since_ms,
                        prev => {
                            v.since_ms = now_ms();
                            if prev.is_some_and(|o| o.state == "working") {
                                settled.push(id.clone());
                            }
                        }
                    }
                    if old.get(id) != Some(&v) {
                        changed = true;
                    }
                    fresh.insert(id.clone(), v);
                }
                if old.len() != fresh.len() {
                    changed = true;
                }
            }
            *self.views.lock().unwrap() = fresh;
            // A task that just stopped working has new changes to show.
            for id in settled {
                self.refresh_diff(&id);
            }
            if changed {
                self.bump();
            }
            let mut w = self.wake.lock().unwrap();
            while !*w {
                match next {
                    Some(t) => {
                        let now = Instant::now();
                        if now >= t {
                            break;
                        }
                        w = self.wake_cv.wait_timeout(w, t - now).unwrap().0;
                    }
                    None => w = self.wake_cv.wait(w).unwrap(),
                }
            }
            *w = false;
        }
    }

    // ───────────────────────── git ─────────────────────────────

    pub fn refresh_diff(self: &Arc<Self>, task_id: &str) {
        let Some(t) = self.st.lock().unwrap().tasks.iter().find(|t| t.id == task_id).cloned() else { return };
        let d = self.clone();
        std::thread::spawn(move || {
            if let Some(s) = diff_stat(&t) {
                let row = Diff { files_changed: s.files_changed + s.untracked, insertions: s.insertions, deletions: s.deletions };
                let mut m = d.diffs.lock().unwrap();
                if m.get(&t.id) != Some(&row) {
                    m.insert(t.id.clone(), row);
                    drop(m);
                    d.bump();
                }
            }
        });
    }

    // ───────────────────────── snapshot ────────────────────────

    pub fn rows(&self) -> Vec<TaskRow> {
        let live: Vec<String> = self.ptys.lock().unwrap().iter()
            .filter(|(_, p)| !p.exited())
            .filter_map(|(c, _)| c.strip_suffix(":agent").map(str::to_string)).collect();
        let st = self.st.lock().unwrap();
        let views = self.views.lock().unwrap();
        let diffs = self.diffs.lock().unwrap();
        let mut rows: Vec<TaskRow> = st
            .tasks
            .iter()
            .filter(|t| !t.archived)
            .map(|t| {
                let v = views.get(&t.id).cloned().unwrap_or_else(|| unseen(live.contains(&t.id)));
                TaskRow {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    project: st.project_name(&t.project_id),
                    agent: t.agent.clone(),
                    branch: (!t.branch.is_empty()).then(|| t.branch.clone()),
                    state: v.state.clone(),
                    tabs: vec![TabRow { id: AGENT_TAB.into(), title: t.agent.clone(), agent: t.agent.clone(), state: v.state.clone(), is_default: true, kind: "agent".into(), live: Some(live.contains(&t.id)), viewable: None, props: Vec::new(), delegated: None }],
                    diff: diffs.get(&t.id).cloned(),
                    created: (!t.created.is_empty()).then(|| t.created.clone()),
                    is_main_checkout: t.is_main_checkout,
                    since_ms: (v.since_ms > 0).then_some(v.since_ms),
                    activity: v.activity,
                    question: v.question,
                    // How a desktop last filed it (task_put `org`): in the
                    // snapshot, so another desktop's pin or group is a change
                    // every connected desktop syncs. No folders or PRs here.
                    pinned: t.org.get("pinned").and_then(serde_json::Value::as_bool).unwrap_or(false),
                    order: t.org.get("order").and_then(serde_json::Value::as_u64).map(|o| o as u32),
                    group: t.org.get("group").and_then(|g| {
                        Some(RowGroup {
                            id: g.get("id")?.as_str()?.to_string(),
                            name: g.get("name").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
                            color: g.get("color").and_then(serde_json::Value::as_str).map(str::to_string),
                            collapsed: false,
                        })
                    }),
                    ..Default::default()
                }
            })
            .collect();
        rows.sort_by(|a, b| (&a.project, &a.name).cmp(&(&b.project, &b.name)));
        rows
    }

    /// The question on the agent's screen right now (for stale-answer checks).
    pub fn question_now(&self, task_id: &str) -> Option<Question> {
        let pty = self.agent_pty(task_id)?;
        let (tail, _) = pty.tail(SCREEN_BYTES);
        let (rows, cols) = pty.size();
        screen::question(&screen::render(&tail, rows, cols))
    }

    // ───────────────────────── tasks ───────────────────────────

    /// End a task's PTYs whose claim `which` accepts, closing the taps of
    /// whoever watches them with `why`. Returns how many were running.
    fn end_ptys(&self, task_id: &str, which: impl Fn(&str) -> bool, why: &str) -> u32 {
        let prefix = format!("{task_id}:");
        let ended: Vec<Arc<Pty>> = {
            let mut map = self.ptys.lock().unwrap();
            let ids: Vec<String> = map.keys().filter(|c| c.strip_prefix(&prefix).is_some_and(&which)).cloned().collect();
            ids.iter().filter_map(|c| map.remove(c)).collect()
        };
        let mut n = 0;
        for p in ended {
            if p.kill() {
                n += 1;
            }
            p.close_taps(why);
        }
        n
    }

    /// End a task's agent and keep the task: its worktree and session stay,
    /// and the desktop starts it again (resuming) when the task is opened.
    pub fn stop_agent(self: &Arc<Self>, task_id: &str) -> u32 {
        let stopped = self.end_ptys(task_id, |tab| tab == "agent", "stopped");
        util::log(&format!("stopped task {task_id} ({stopped} agent ended)"));
        self.poke();
        self.bump();
        stopped
    }

    /// End the task's terminals, remove the worktree (never the project's
    /// own checkout), mark the task archived. Returns terminals killed.
    pub fn archive(self: &Arc<Self>, task_id: &str) -> Result<u32, String> {
        let t = self.st.lock().unwrap().tasks.iter().find(|t| t.id == task_id).cloned().ok_or("no such task")?;
        let killed = self.end_ptys(task_id, |_| true, "archived");
        if !t.is_main_checkout && !t.path.is_empty() {
            let project = self.st.lock().unwrap().project(&t.project_id).cloned();
            remove_worktree(project.as_ref(), &t.path, &self.worktrees_dir());
        }
        {
            let mut st = self.st.lock().unwrap();
            if let Some(x) = st.tasks.iter_mut().find(|x| x.id == task_id) {
                x.archived = true;
            }
            self.save(&st);
        }
        self.diffs.lock().unwrap().remove(task_id);
        util::log(&format!("archived task {} ({killed} agent killed)", t.name));
        self.poke();
        self.bump();
        Ok(killed)
    }

    /// Hang up every terminal (daemon stop).
    pub fn hangup_all(&self) {
        for p in self.ptys.lock().unwrap().values() {
            p.hangup();
        }
    }

    /// (tasks with a running agent, of those the ones working).
    pub fn agent_counts(&self) -> (u32, u32) {
        let live: Vec<String> = self.ptys.lock().unwrap().iter()
            .filter(|(_, p)| !p.exited())
            .filter_map(|(c, _)| c.strip_suffix(":agent").map(str::to_string)).collect();
        let views = self.views.lock().unwrap();
        let working = live.iter().filter(|id| views.get(*id).is_some_and(|v| v.state == "working")).count();
        (live.len() as u32, working as u32)
    }

    /// End every terminal for a restart onto a new build, noting their
    /// claims so a desktop coming back starts them again (session.rs).
    pub fn stop_for_restart(&self) {
        self.restarting.store(true, std::sync::atomic::Ordering::SeqCst);
        let claims: Vec<String> = self.ptys.lock().unwrap().iter().filter(|(_, p)| !p.exited()).map(|(id, _)| id.clone()).collect();
        {
            let mut st = self.st.lock().unwrap();
            st.restarted_claims = claims;
            self.save(&st);
        }
        self.hangup_all();
    }
}

/// A task the monitor has not looked at yet: an agent just spawned is
/// booting (working), anything else has no agent.
fn unseen(booting: bool) -> View {
    View { state: if booting { "working" } else { "inactive" }.into(), since_ms: 0, activity: None, question: None }
}

/// The one agent tab a server task has.
pub const AGENT_TAB: &str = "agent";

pub fn path_within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

/// `git -C dir args...`, never prompting. Stdout on success, stderr's
/// first line on failure.
pub fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("git failed");
        Err(line.to_string())
    }
}

fn remove_worktree(project: Option<&Project>, path: &str, ours: &Path) {
    if let Some(p) = project {
        if git(&p.path, &["worktree", "remove", "--force", path]).is_ok() {
            return;
        }
    }
    // git refused (or the project is gone): delete it only if it is one of
    // our own worktrees, never an arbitrary path from a record.
    if Path::new(path).starts_with(ours) && Path::new(path).exists() {
        let _ = std::fs::remove_dir_all(path);
    }
    if let Some(p) = project {
        let _ = git(&p.path, &["worktree", "prune"]);
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Stat {
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
    pub untracked: u64,
}

/// The worktree's changes against where it branched from its base,
/// working tree included.
pub fn merge_base(t: &TaskRec) -> Option<String> {
    if t.base_branch.is_empty() {
        return git(&t.path, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_string());
    }
    git(&t.path, &["merge-base", &t.base_branch, "HEAD"]).ok().map(|s| s.trim().to_string())
}

pub fn diff_stat(t: &TaskRec) -> Option<Stat> {
    let base = merge_base(t)?;
    let num = git(&t.path, &["diff", "--numstat", &base]).ok()?;
    let mut s = Stat::default();
    for line in num.lines() {
        let mut it = line.split('\t');
        let (a, b) = (it.next().unwrap_or("0"), it.next().unwrap_or("0"));
        s.files_changed += 1;
        s.insertions += a.parse::<u64>().unwrap_or(0);
        s.deletions += b.parse::<u64>().unwrap_or(0);
    }
    s.untracked = git(&t.path, &["ls-files", "--others", "--exclude-standard"]).ok()?.lines().filter(|l| !l.is_empty()).count() as u64;
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_within_respects_component_boundaries() {
        assert!(path_within("/srv/api", "/srv/api"));
        assert!(path_within("/srv/api/src", "/srv/api/"));
        assert!(!path_within("/srv/api2", "/srv/api"));
    }
}
