//! End to end: the real binary, a temp HOME, a real git repo, a fake agent
//! in a real PTY, spoken to over the same framed protocol ssh carries.
#![cfg(unix)] // termic-server is unix only (see src/main.rs)

use std::collections::VecDeque;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use termic_remote::conn::{MsgReader, MsgWriter};
use termic_remote::framed::{FramedReader, FramedWriter};
use termic_remote::wire::{ClientKind, ClientMsg, HostKind, ServerMsg, TaskRow};

const BIN: &str = env!("CARGO_BIN_EXE_termic-server");
const T: Duration = Duration::from_secs(20);

const FAKE_AGENT: &str = r#"#!/bin/sh
printf 'fake agent ready\r\n> '
while IFS= read -r line; do
  case "$line" in
    *ask*) printf 'Do you want to proceed? (y/n) ' ;;
    *nap*) printf 'napping\r\n'; sleep 30; printf 'woke\r\n' ;;
    *) printf 'echo: %s\r\n' "$line"; sleep 0.3; printf 'finished\r\n> ' ;;
  esac
done
"#;

struct Env {
    root: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let root = std::env::temp_dir().join(format!("tse-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let e = Env { root };
        std::fs::create_dir_all(e.srv()).unwrap();
        let agent = e.root.join("fake-agent.sh");
        std::fs::write(&agent, FAKE_AGENT).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A repo with one commit.
        let repo = e.repo();
        std::fs::create_dir_all(&repo).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "e2e@termic.dev"], vec!["config", "user.name", "e2e"]] {
            assert!(Command::new("git").arg("-C").arg(&repo).args(args).status().unwrap().success());
        }
        std::fs::write(repo.join("README"), "hi\n").unwrap();
        assert!(Command::new("git").arg("-C").arg(&repo).args(["add", "."]).status().unwrap().success());
        assert!(Command::new("git").arg("-C").arg(&repo).args(["commit", "-qm", "init"]).status().unwrap().success());
        e
    }
    fn srv(&self) -> PathBuf {
        self.root.join("srv")
    }
    fn repo(&self) -> PathBuf {
        self.root.join("repo")
    }
    fn cmd(&self, arg: &str) -> Command {
        let mut c = Command::new(BIN);
        c.arg(arg)
            .env("HOME", self.root.join("home"))
            .env("TERMIC_SERVER_HOME", self.srv())
            .env("TERMIC_SERVER_QUIET_MS", "600")
            .env("SHELL", "/bin/sh");
        c
    }
    fn bridge(&self) -> (Client, Child) {
        let mut child = self.cmd("bridge").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let w = MsgWriter::plain(Box::new(FramedWriter(child.stdin.take().unwrap())));
        let r = MsgReader::plain(Box::new(FramedReader(child.stdout.take().unwrap())));
        (Client::start(r, w), child)
    }
    fn direct(&self) -> Client {
        let s = UnixStream::connect(self.srv().join("sock")).unwrap();
        let r = MsgReader::plain(Box::new(FramedReader(s.try_clone().unwrap())));
        let w = MsgWriter::plain(Box::new(FramedWriter(s)));
        Client::start(r, w)
    }
    fn stop(&self) {
        let out = self.cmd("stop").output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = self.cmd("stop").output();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Client {
    w: MsgWriter,
    rx: mpsc::Receiver<ServerMsg>,
    seen: VecDeque<ServerMsg>,
    n: u64,
    welcome: ServerMsg,
}

impl Client {
    fn start(mut r: MsgReader, mut w: MsgWriter) -> Client {
        w.send(&ClientMsg::Hello { v: 1, name: "e2e".into(), kind: ClientKind::Computer, caps: vec!["tasks".into()], app_version: None, grant: None, port: None }).unwrap();
        let welcome = r.recv::<ServerMsg>().unwrap().expect("welcome");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(Some(m)) = r.recv::<ServerMsg>() {
                if tx.send(m).is_err() {
                    break;
                }
            }
        });
        Client { w, rx, seen: VecDeque::new(), n: 0, welcome }
    }

    fn send(&mut self, m: &ClientMsg) {
        self.w.send(m).unwrap();
    }

    /// The first message (old or new) matching `f`, removed from the buffer.
    fn wait_for<R>(&mut self, what: &str, mut f: impl FnMut(&ServerMsg) -> Option<R>) -> R {
        if let Some(i) = self.seen.iter().position(|m| f(m).is_some()) {
            let m = self.seen.remove(i).unwrap();
            return f(&m).unwrap();
        }
        let until = Instant::now() + T;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(m) => {
                    if let Some(r) = f(&m) {
                        return r;
                    }
                    self.seen.push_back(m);
                }
                Err(_) => panic!("timed out waiting for {what}; buffered: {:?}", self.seen.iter().map(short).collect::<Vec<_>>()),
            }
        }
    }

    fn call(&mut self, req: Value) -> Value {
        self.n += 1;
        let id = format!("c{}", self.n);
        let mut req = req;
        req["id"] = json!(id);
        self.send(&ClientMsg::Call { id: id.clone(), req, proto: None });
        self.wait_for(&format!("reply {id}"), |m| match m {
            ServerMsg::Reply { id: rid, reply } if *rid == id => Some(reply.clone()),
            _ => None,
        })
    }

    fn ok(&mut self, req: Value) -> Value {
        let r = self.call(req.clone());
        assert_eq!(r["ok"], json!(true), "{req} -> {r}");
        r["data"].clone()
    }

    /// Wait for a tasks snapshot where `f` holds for the task named `name`.
    fn task_state(&mut self, name: &str, f: impl Fn(&TaskRow) -> bool) -> TaskRow {
        self.wait_for(&format!("task {name} in the wanted state"), |m| match m {
            ServerMsg::Tasks { tasks } => tasks.iter().find(|t| t.name == name && f(t)).cloned(),
            _ => None,
        })
    }

    /// Terminal output (resets and data) until `needle` shows up.
    fn term_until(&mut self, needle: &str) -> String {
        let mut acc = String::new();
        self.wait_for(&format!("terminal output {needle:?}"), |m| {
            let data = match m {
                ServerMsg::TermReset { data, .. } | ServerMsg::TermData { data } => data,
                _ => return None,
            };
            acc.push_str(&String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()));
            acc.contains(needle).then(|| acc.clone())
        })
    }
}

/// A task made the way the desktop makes one: its worktree (git, which the
/// desktop runs through `exec`), the record (`task_put`), then its agent
/// in a `<task>:agent` PTY. Returns the worktree.
fn desk_task(a: &mut Client, e: &Env, id: &str, name: &str, branch: &str) -> PathBuf {
    let project = a.ok(json!({"cmd":"project_list"}))["projects"][0]["id"].as_str().unwrap().to_string();
    let path = e.srv().join("worktrees").join("repo").join(branch);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(Command::new("git").arg("-C").arg(e.repo()).args(["worktree", "add", "-q", "-b", branch]).arg(&path).arg("main").status().unwrap().success());
    let path = path.canonicalize().unwrap();
    a.ok(json!({"cmd":"task_put","task": id,"name": name,"project": project,"path": path,"branch": branch,"base_branch":"main","agent":"fake"}));
    start_agent(a, e, id, &path);
    path
}

/// The desktop starting (or restarting) a task's agent.
fn start_agent(a: &mut Client, e: &Env, id: &str, path: &Path) {
    let agent = e.root.join("fake-agent.sh").display().to_string();
    a.send(&ClientMsg::PtyOpen { pid: format!("{id}:agent"), cwd: path.display().to_string(), argv: vec![agent], env: vec![], cols: 120, rows: 40, seen: None });
}

const ID1: &str = "11111111111111111111111111111111";
const ID2: &str = "22222222222222222222222222222222";

fn short(m: &ServerMsg) -> String {
    match m {
        ServerMsg::Tasks { tasks } => format!("TASKS[{}]", tasks.iter().map(|t| t.state.clone()).collect::<Vec<_>>().join(",")),
        ServerMsg::TermData { data } => format!("TERM[{}]", String::from_utf8_lossy(&termic_remote::unb64(data).unwrap_or_default())),
        _ => serde_json::to_string(m).unwrap().chars().take(60).collect(),
    }
}

fn wait_path_gone(p: &Path) {
    let until = Instant::now() + T;
    while p.exists() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!p.exists(), "{} still exists", p.display());
}

#[test]
fn a_task_runs_end_to_end_through_the_bridge() {
    let e = Env::new("main");
    let out = e.cmd("status").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("not running"));

    // The bridge starts the daemon on demand.
    let (mut a, mut bridge) = e.bridge();
    match &a.welcome {
        ServerMsg::Welcome { kind, caps, grant, id, .. } => {
            assert_eq!(*kind, HostKind::Server);
            assert_eq!(grant.as_deref(), Some("drive"));
            assert_eq!(id.len(), 32);
            for c in ["call", "tasks", "terminal", "keys", "transcript"] {
                assert!(caps.iter().any(|x| x == c), "{c} missing from {caps:?}");
            }
        }
        m => panic!("not a welcome: {m:?}"),
    }
    assert!(e.cmd("status").output().unwrap().status.success());
    a.wait_for("first (empty) snapshot", |m| matches!(m, ServerMsg::Tasks { tasks } if tasks.is_empty()).then_some(()));
    a.send(&ClientMsg::Ping {});
    a.wait_for("pong", |m| matches!(m, ServerMsg::Pong {}).then_some(()));

    // Projects.
    let p = a.ok(json!({"cmd":"project_add","path": e.repo()}));
    assert_eq!(p["project"]["name"], "repo");
    let again = a.ok(json!({"cmd":"project_add","path": e.repo()}));
    // exec: the desktop's git and file reads, only inside a project.
    let x = a.ok(json!({"cmd":"exec","cwd": e.repo(),"argv":["git","rev-parse","--is-inside-work-tree"]}));
    assert_eq!(x["code"], 0);
    assert_eq!(String::from_utf8(termic_remote::unb64(x["stdout"].as_str().unwrap()).unwrap()).unwrap().trim(), "true");
    let outside = a.call(json!({"cmd":"exec","cwd":"/","argv":["ls"]}));
    assert_eq!(outside["ok"], false, "exec ran outside every project: {outside}");
    let dotdot = a.call(json!({"cmd":"exec","cwd": format!("{}/..", e.repo().display()),"argv":["ls"]}));
    assert_eq!(dotdot["ok"], false, "a .. path escaped the project: {dotdot}");
    // pty_open: a shell in the project, several apart from the agent's.
    let repo = e.repo().canonicalize().unwrap();
    a.send(&ClientMsg::PtyOpen { pid: "sh1".into(), cwd: repo.display().to_string(), argv: vec![], env: vec![], cols: 90, rows: 20, seen: None });
    a.send(&ClientMsg::PtyInput { pid: "sh1".into(), data: termic_remote::b64(b"echo marker-$((40+2)); stty size\r") });
    let mut seen = String::new();
    a.wait_for("the shell's output", |m| match m {
        ServerMsg::PtyData { pid, data, .. } if pid == "sh1" => {
            seen.push_str(&String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()));
            (seen.contains("marker-42") && seen.contains("20 90")).then_some(())
        }
        _ => None,
    });
    // A kill reports no exit to its asker (it may reuse the id at once).
    a.send(&ClientMsg::PtyKill { pid: "sh1".into() });
    a.send(&ClientMsg::PtyOpen { pid: "sh2".into(), cwd: "/".into(), argv: vec!["ls".into()], env: vec![], cols: 80, rows: 24, seen: None });
    let why = a.wait_for("a refusal outside the project", |m| match m {
        ServerMsg::PtyExit { pid, reason } if pid == "sh2" => Some(reason.clone()),
        _ => None,
    });
    assert!(why.contains("not inside a project"), "{why}");
    assert_eq!(again["project"]["id"], p["project"]["id"], "adding twice is idempotent");
    // project_add --clone: how a repo gets onto a box. Only inside home, only
    // onto a path that does not exist yet.
    let cl = a.ok(json!({"cmd":"project_add","path":"~/cloned","clone": e.repo().display().to_string()}));
    assert_eq!(cl["project"]["name"], "cloned");
    let twice = a.call(json!({"cmd":"project_add","path":"~/cloned","clone": e.repo().display().to_string()}));
    assert_eq!(twice["ok"], false, "cloned over an existing folder: {twice}");
    let outside = a.call(json!({"cmd":"project_add","path":"/tmp/termic-clone-outside","clone": e.repo().display().to_string()}));
    assert_eq!(outside["ok"], false, "cloned outside home: {outside}");
    a.ok(json!({"cmd":"project_remove","name":"cloned"}));
    let bad = a.call(json!({"cmd":"project_add","path": e.root.join("home")}));
    assert_eq!(bad["ok"], json!(false), "a non-git dir needs non_git");
    assert_eq!(a.ok(json!({"cmd":"project_list"}))["projects"].as_array().unwrap().len(), 1);

    // A task: the desktop makes it (this host has no `new` and no agent
    // table) and starts its agent in a PTY here.
    let un = a.call(json!({"cmd":"new","name":"x","agent":"fake"}));
    assert_eq!(un["error"]["code"], "unsupported", "{un}");
    let path = desk_task(&mut a, &e, ID1, "Fix Login!", "fix-login");
    assert!(path.starts_with(e.srv().join("worktrees").canonicalize().unwrap()) && path.join("README").exists());

    // Booted and quiet: idle, never given anything.
    let row = a.task_state("Fix Login!", |t| t.state == "idle");
    assert_eq!(row.tabs.len(), 1);
    assert!(row.since_ms.is_some());

    // The terminal: backlog first, then live. "idle" is also what a task
    // reads before its agent has printed a byte, so wait for the agent's
    // banner to be in its output before asking for the backlog.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !a.ok(json!({"cmd":"logs","task":"Fix Login!"})).to_string().contains("fake agent ready") {
        assert!(std::time::Instant::now() < deadline, "the agent never printed its banner");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    a.send(&ClientMsg::TermOpen { task: "Fix Login!".into(), tab: None });
    let reset = a.wait_for("term_reset", |m| match m {
        ServerMsg::TermReset { data, cols, rows, .. } => Some((String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()).to_string(), *cols, *rows)),
        _ => None,
    });
    assert!(reset.0.contains("fake agent ready"), "{:?}", reset.0);
    assert_eq!((reset.1, reset.2), (120, 40));

    // A prompt: typed in, echoed, working, then finished. Its terminal is
    // open here, so the finish is already seen: idle, not an unread done.
    let s = a.ok(json!({"cmd":"send","task":"Fix Login!","prompt":"hello world"}));
    assert_eq!(s["mode"], "delivered");
    a.term_until("echo: hello world");
    a.task_state("Fix Login!", |t| t.state == "working");
    a.task_state("Fix Login!", |t| t.state == "idle");
    let w = a.ok(json!({"cmd":"wait","task":"Fix Login!","timeout_ms":10000}));
    assert_eq!(w["outcome"], "done");

    // Send then wait at once: the wait must cover the new turn.
    a.ok(json!({"cmd":"send","task":"Fix Login!","prompt":"second"}));
    let w = a.ok(json!({"cmd":"wait","task":"Fix Login!","timeout_ms":10000}));
    assert_eq!(w["outcome"], "done");
    let logs = a.ok(json!({"cmd":"logs","task":"Fix Login!"}));
    assert!(logs["data"].as_str().unwrap().contains("echo: second"));

    // A question: waiting, and wait reports it needs input.
    a.ok(json!({"cmd":"send","task":"Fix Login!","prompt":"please ask"}));
    a.task_state("Fix Login!", |t| t.state == "waiting");
    let w = a.ok(json!({"cmd":"wait","task":"Fix Login!","timeout_ms":10000}));
    assert_eq!(w["outcome"], "needs_input");
    // Answer with keys (acked), and the agent moves on.
    a.send(&ClientMsg::Keys { task: "Fix Login!".into(), tab: None, data: termic_remote::b64(b"yes\r"), id: Some("k1".into()), question: None });
    a.wait_for("ack k1", |m| matches!(m, ServerMsg::Ack { id, ok: true, .. } if id == "k1").then_some(()));
    a.term_until("echo: yes");
    a.task_state("Fix Login!", |t| t.state == "idle");
    a.send(&ClientMsg::TermOpen { task: "Fix Login!".into(), tab: None });
    // An answer bound to a question that is not on screen is refused.
    a.send(&ClientMsg::Keys { task: "Fix Login!".into(), tab: None, data: termic_remote::b64(b"1"), id: Some("k2".into()), question: Some("gone".into()) });
    a.wait_for("stale ack", |m| matches!(m, ServerMsg::Ack { id, ok: false, message } if id == "k2" && message.as_deref() == Some("stale")).then_some(()));

    // A second task, prompted once its agent is up.
    desk_task(&mut a, &e, ID2, "second", "second");
    let deadline = Instant::now() + T;
    while !a.ok(json!({"cmd":"logs","task":"second"})).to_string().contains("fake agent ready") {
        assert!(Instant::now() < deadline, "the second agent never printed its banner");
        std::thread::sleep(Duration::from_millis(50));
    }
    a.ok(json!({"cmd":"send","task":"second","prompt":"first job","wait":true,"timeout_ms":15000}));
    let logs = a.ok(json!({"cmd":"logs","task":"second"}));
    assert!(logs["data"].as_str().unwrap().contains("echo: first job"), "{}", logs["data"]);

    // Verbs: list, status, rename, agents, unsupported.
    let list = a.ok(json!({"cmd":"list"}));
    assert_eq!(list["tasks"].as_array().unwrap().len(), 2);
    assert!(list["tasks"].as_array().unwrap().iter().all(|t| t["work_state"].is_string()));
    let st = a.ok(json!({"cmd":"status","task":"second"}));
    assert_eq!(st["task"]["tabs"][0]["kind"], "agent");
    let r = a.ok(json!({"cmd":"rename","task":"second","name":"Second Task"}));
    assert_eq!(r["old_name"], "second");
    // The desktop's registry decides agents; it asks the box with `exec`.
    assert_eq!(a.call(json!({"cmd":"agents"}))["error"]["code"], "unsupported");
    let un = a.call(json!({"cmd":"apply","task":"second"}));
    assert_eq!(un["error"]["code"], "unsupported");
    let tr = {
        a.send(&ClientMsg::Transcript { id: "t1".into(), task: "Second Task".into() });
        a.wait_for("transcript", |m| match m {
            ServerMsg::Transcript { id, error, .. } if id == "t1" => Some(error.clone()),
            _ => None,
        })
    };
    assert_eq!(tr.as_deref(), Some("transcripts are available for Claude, Codex and Antigravity tasks"));

    // A second client sees the same tasks.
    let mut b = e.direct();
    b.wait_for("a snapshot with both tasks", |m| match m {
        ServerMsg::Tasks { tasks } => {
            let names: Vec<&str> = tasks.iter().map(|t| t.name.as_str()).collect();
            (names == ["Fix Login!", "Second Task"]).then_some(())
        }
        _ => None,
    });

    // ssh drops: the agent keeps running, a new connection finds it.
    let _ = bridge.kill();
    let _ = bridge.wait();
    drop(a);
    // Once the daemon has seen that connection end (and dropped its taps).
    let log = e.srv().join("daemon.log");
    let until = Instant::now() + T;
    while !std::fs::read_to_string(&log).unwrap_or_default().contains("client disconnected") {
        assert!(Instant::now() < until, "the daemon never noticed the dropped connection");
        std::thread::sleep(Duration::from_millis(50));
    }
    b.ok(json!({"cmd":"send","task":"Fix Login!","prompt":"while you were away"}));
    // Nobody has its terminal now (the desktop that opened it is gone): a
    // finish is an unread done until someone looks.
    b.task_state("Fix Login!", |t| t.state == "done");
    let (mut a2, mut bridge2) = e.bridge();
    a2.send(&ClientMsg::TermOpen { task: "Fix Login!".into(), tab: None });
    let back = a2.term_until("echo: while you were away");
    assert!(back.contains("echo: hello world"), "the backlog has the earlier turns");
    b.task_state("Fix Login!", |t| t.state == "idle");

    // Archive: agent killed, worktree gone, the open terminal closed.
    let ar = a2.ok(json!({"cmd":"archive","task":"Fix Login!"}));
    assert_eq!(ar["killed_agents"], 1);
    a2.wait_for("term_closed", |m| matches!(m, ServerMsg::TermClosed { reason } if reason == "archived").then_some(()));
    wait_path_gone(&path);
    b.wait_for("snapshot without the archived task", |m| match m {
        ServerMsg::Tasks { tasks } => (tasks.len() == 1 && tasks[0].name == "Second Task").then_some(()),
        _ => None,
    });

    // A daemon restart keeps the task as a record, its agent inactive.
    drop(b);
    let _ = bridge2.kill();
    let _ = bridge2.wait();
    drop(a2);
    e.stop();
    let (mut c, _bridge3) = e.bridge();
    c.task_state("Second Task", |t| t.state == "inactive");
    let no = c.call(json!({"cmd":"send","task":"Second Task","prompt":"hi"}));
    assert_eq!(no["ok"], json!(false));
    assert!(no["error"]["message"].as_str().unwrap().contains("open the task in Termic"), "{no}");
    // The desktop opening the task starts its agent again; then it answers.
    let second = e.srv().join("worktrees/repo/second").canonicalize().unwrap();
    start_agent(&mut c, &e, ID2, &second);
    let deadline = Instant::now() + T;
    while c.call(json!({"cmd":"logs","task":"Second Task"}))["data"]["data"].as_str().is_none_or(|d| !d.contains("fake agent ready")) {
        assert!(Instant::now() < deadline, "the restarted agent never printed its banner");
        std::thread::sleep(Duration::from_millis(50));
    }
    c.ok(json!({"cmd":"send","task":"Second Task","prompt":"back again","wait":true,"timeout_ms":15000}));
    let logs = c.ok(json!({"cmd":"logs","task":"Second Task"}));
    assert!(logs["data"].as_str().unwrap().contains("echo: back again"));

    // Removing the project archives what is left.
    let rm = c.ok(json!({"cmd":"project_remove","name":"repo"}));
    assert_eq!(rm["removed_tasks"], 1);
    c.wait_for("empty snapshot", |m| matches!(m, ServerMsg::Tasks { tasks } if tasks.is_empty()).then_some(()));
    e.stop();
}

#[test]
fn the_data_dir_and_socket_are_private() {
    let e = Env::new("perm");
    let (_c, _b) = e.bridge();
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(e.srv()), 0o700);
    assert_eq!(mode(e.srv().join("sock")), 0o600);
    assert_eq!(mode(e.srv().join("state.json")), 0o600);
    // A second daemon on the same dir steps aside rather than fighting.
    let st = e.cmd("daemon").status().unwrap();
    assert!(st.success());
    assert!(e.srv().join("sock").exists());
}

#[test]
fn a_client_that_does_not_say_hello_is_dropped() {
    let e = Env::new("nohello");
    let (_c, _b) = e.bridge();
    let s = UnixStream::connect(e.srv().join("sock")).unwrap();
    let mut r = MsgReader::plain(Box::new(FramedReader(s.try_clone().unwrap())));
    let mut w = MsgWriter::plain(Box::new(FramedWriter(s)));
    w.send(&ClientMsg::Ping {}).unwrap();
    assert!(r.recv::<ServerMsg>().unwrap().is_none(), "the connection closes without a welcome");
}

/// `interrupt` must reach what an agent runs: the key goes through the
/// tty, which turns Ctrl-C into SIGINT for the agent's foreground job, so
/// this also covers the daemon leaving its agents' signals alone.
#[test]
fn an_interrupt_reaches_the_agents_foreground_command() {
    let e = Env::new("intr");
    let (mut a, _b) = e.bridge();
    a.ok(json!({"cmd":"project_add","path": e.repo()}));
    desk_task(&mut a, &e, ID1, "napper", "napper");
    a.task_state("napper", |t| t.state == "idle");
    a.send(&ClientMsg::TermOpen { task: "napper".into(), tab: None });
    a.ok(json!({"cmd":"send","task":"napper","prompt":"nap"}));
    a.term_until("napping");
    let started = Instant::now();
    a.send(&ClientMsg::Interrupt { task: "napper".into(), tab: None, id: Some("i1".into()) });
    a.wait_for("ack i1", |m| matches!(m, ServerMsg::Ack { id, ok: true, .. } if id == "i1").then_some(()));
    // SIGINT ends the non-interactive sh and its sleep: the PTY closes.
    a.wait_for("term_closed", |m| matches!(m, ServerMsg::TermClosed { reason } if reason == "exited").then_some(()));
    assert!(started.elapsed() < Duration::from_secs(10), "the interrupt did not land");
    a.task_state("napper", |t| t.state == "inactive");
    // This host never starts an agent itself: the desktop does.
    a.send(&ClientMsg::TermOpen { task: "napper".into(), tab: None });
    let why = a.wait_for("term_closed for a stopped agent", |m| match m {
        ServerMsg::TermClosed { reason } => Some(reason.clone()),
        _ => None,
    });
    assert!(why.contains("open the task in Termic"), "{why}");
}

#[test]
fn quit_restarts_onto_the_installed_build_and_says_what_it_ended() {
    let e = Env::new("restart");
    let (mut a, mut ab) = e.bridge();
    a.ok(json!({"cmd":"project_add","path": e.repo()}));
    desk_task(&mut a, &e, ID1, "keeper", "keeper");
    desk_task(&mut a, &e, ID2, "stopped", "stopped");
    a.wait_for("both idle", |m| match m {
        ServerMsg::Tasks { tasks } => (tasks.iter().filter(|t| t.state == "idle").count() == 2).then_some(()),
        _ => None,
    });
    a.ok(json!({"cmd":"stop","task":"stopped"}));
    a.task_state("stopped", |t| t.state == "inactive");
    // Preview: counts the agents a restart would stop, and stops nothing.
    let p = a.ok(json!({"cmd":"quit"}));
    assert_eq!((p["tasks_with_agents"].clone(), p["quitting"].clone()), (json!(1), json!(false)), "{p}");
    let q = a.ok(json!({"cmd":"quit","commit":true}));
    assert_eq!(q["quitting"], json!(true));
    // Until the connection drops, nothing tells this desktop its running
    // agent exited: it would show it exited instead of starting it again.
    let keeper = format!("{ID1}:agent");
    let mut told = Vec::new();
    loop {
        match a.rx.recv_timeout(T) {
            Ok(ServerMsg::PtyExit { pid, reason }) => told.push((pid, reason)),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    assert!(!told.iter().any(|(p, _)| *p == keeper), "told the desktop {told:?}");
    // The daemon exits; the next bridge starts a new one.
    wait_path_gone(&e.srv().join("sock"));
    let _ = ab.wait();
    let (mut b, _bb) = e.bridge();
    // The desktop coming back to its PTYs: the running one is reported
    // restarted (it starts it again), the stopped one plainly ended. Once.
    let reason_of = |b: &mut Client, id: &str| {
        let pid = format!("{id}:agent");
        b.send(&ClientMsg::PtyOpen { pid: pid.clone(), cwd: String::new(), argv: vec![], env: vec![], cols: 80, rows: 24, seen: Some(0) });
        b.wait_for(&format!("exit of {pid}"), |m| match m {
            ServerMsg::PtyExit { pid: p, reason } if *p == pid => Some(reason.clone()),
            _ => None,
        })
    };
    assert_eq!(reason_of(&mut b, ID1), termic_remote::wire::PTY_RESTARTED);
    assert_ne!(reason_of(&mut b, ID2), termic_remote::wire::PTY_RESTARTED);
    assert_ne!(reason_of(&mut b, ID1), termic_remote::wire::PTY_RESTARTED, "told once");
    let st: Value = serde_json::from_slice(&std::fs::read(e.srv().join("state.json")).unwrap()).unwrap();
    assert!(st.get("restarted_claims").is_none(), "the list is consumed: {st}");
}

#[test]
fn a_shell_outlives_its_connection_and_the_next_one_attaches() {
    let e = Env::new("keep");
    let (mut a, mut bridge) = e.bridge();
    match &a.welcome {
        ServerMsg::Welcome { caps, .. } => assert!(caps.iter().any(|c| c == "pty_keep"), "{caps:?}"),
        m => panic!("not a welcome: {m:?}"),
    }
    a.ok(json!({"cmd":"project_add","path": e.repo()}));
    let repo = e.repo().canonicalize().unwrap();
    a.send(&ClientMsg::PtyOpen { pid: "keep1".into(), cwd: repo.display().to_string(), argv: vec![], env: vec![], cols: 80, rows: 24, seen: None });
    a.send(&ClientMsg::PtyInput { pid: "keep1".into(), data: termic_remote::b64(b"echo before-$((1+1))\r") });
    let mut got = 0u64;
    let mut text = String::new();
    a.wait_for("output before the drop", |m| match m {
        ServerMsg::PtyData { pid, data, at } if pid == "keep1" => {
            let b = termic_remote::unb64(data).unwrap();
            got = at.unwrap_or(got) + b.len() as u64;
            text.push_str(&String::from_utf8_lossy(&b));
            text.contains("before-2").then_some(())
        }
        _ => None,
    });
    // The laptop sleeps: the connection goes, the shell does not.
    let _ = bridge.kill();
    drop(a);
    let (mut b, _bridge2) = e.bridge();
    b.send(&ClientMsg::PtyOpen { pid: "keep1".into(), cwd: String::new(), argv: vec![], env: vec![], cols: 80, rows: 24, seen: Some(got) });
    // The backlog starts where this client left off: nothing seen twice.
    let backlog = b.wait_for("the attach backlog", |m| match m {
        ServerMsg::PtyData { pid, data, at: Some(at) } if pid == "keep1" => Some((*at, String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()).to_string())),
        _ => None,
    });
    assert_eq!(backlog.0, got);
    assert!(!backlog.1.contains("before-2"), "output seen before the drop was sent again: {:?}", backlog.1);
    // The same shell takes input.
    b.send(&ClientMsg::PtyInput { pid: "keep1".into(), data: termic_remote::b64(b"echo after-$((2+2))\r") });
    let mut after = String::new();
    b.wait_for("the same shell answers", |m| match m {
        ServerMsg::PtyData { pid, data, .. } if pid == "keep1" => {
            after.push_str(&String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()));
            after.contains("after-4").then_some(())
        }
        _ => None,
    });
    // Attaching to one that is gone never starts it again.
    b.send(&ClientMsg::PtyOpen { pid: "never".into(), cwd: repo.display().to_string(), argv: vec!["ls".into()], env: vec![], cols: 80, rows: 24, seen: Some(0) });
    let why = b.wait_for("a refusal to restart", |m| match m {
        ServerMsg::PtyExit { pid, reason } if pid == "never" => Some(reason.clone()),
        _ => None,
    });
    assert!(why.contains("ended"), "{why}");
    // Reusing an id right after a kill gets a new PTY, and no stale exit
    // from the old one ends it.
    b.send(&ClientMsg::PtyKill { pid: "keep1".into() });
    b.send(&ClientMsg::PtyOpen { pid: "keep1".into(), cwd: repo.display().to_string(), argv: vec![], env: vec![], cols: 80, rows: 24, seen: None });
    b.send(&ClientMsg::PtyInput { pid: "keep1".into(), data: termic_remote::b64(b"echo again-$((3+3))\r") });
    let mut again = String::new();
    b.wait_for("the reused id's new shell", |m| match m {
        ServerMsg::PtyExit { pid, reason } if pid == "keep1" => panic!("a stale exit ended the new PTY: {reason}"),
        ServerMsg::PtyData { pid, data, .. } if pid == "keep1" => {
            again.push_str(&String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()));
            again.contains("again-6").then_some(())
        }
        _ => None,
    });
    std::thread::sleep(std::time::Duration::from_secs(3)); // past the old PTY's kill grace, so a stale exit would have arrived
    b.send(&ClientMsg::PtyInput { pid: "keep1".into(), data: termic_remote::b64(b"echo still-$((4+4))\r") });
    b.wait_for("the new shell outlives the old one's kill", |m| match m {
        ServerMsg::PtyExit { pid, reason } if pid == "keep1" => panic!("a stale exit ended the new PTY: {reason}"),
        ServerMsg::PtyData { pid, data, .. } if pid == "keep1" => String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()).contains("still-8").then_some(()),
        _ => None,
    });
    e.stop();
}

#[test]
fn task_put_records_a_desktop_made_task_inside_the_fence_only() {
    let e = Env::new("put");
    let (mut a, _bridge) = e.bridge();
    let p = a.ok(json!({"cmd":"project_add","path": e.repo()}));
    let pid = p["project"]["id"].as_str().unwrap().to_string();
    let repo = e.repo().canonicalize().unwrap().display().to_string();
    let id = "0123456789abcdef0123456789abcdef";
    // A main-checkout task at the project's root: recorded, listed, no agent.
    let r = a.ok(json!({"cmd":"task_put","task": id,"name":"desk-made","project": pid,"path": repo,"branch":"main","agent":"claude","is_main_checkout": true}));
    assert_eq!(r["task"]["id"], id);
    let list = a.ok(json!({"cmd":"list"}));
    let t = list["tasks"].as_array().unwrap().iter().find(|t| t["id"] == id).expect("listed");
    assert_eq!(t["name"], "desk-made");
    assert_ne!(t["work_state"], "working", "task_put starts nothing");
    // Again with the same id: an update, not a second task.
    a.ok(json!({"cmd":"task_put","task": id,"name":"renamed","project": pid,"path": repo,"branch":"main","agent":"claude"}));
    let list = a.ok(json!({"cmd":"list"}));
    assert_eq!(list["tasks"].as_array().unwrap().iter().filter(|t| t["id"] == id).count(), 1);
    // Refused: a path outside every project and worktree, an unknown
    // project, an id that is not a uuid.
    for (bad, why) in [
        (json!({"cmd":"task_put","task": id,"name":"x","project": pid,"path":"/","branch":"main","agent":"claude"}), "outside"),
        (json!({"cmd":"task_put","task": id,"name":"x","project":"nope","path": repo,"branch":"main","agent":"claude"}), "project"),
        (json!({"cmd":"task_put","task":"../evil","name":"x","project": pid,"path": repo,"branch":"main","agent":"claude"}), "uuid"),
    ] {
        let r = a.call(bad);
        assert_eq!(r["ok"], false, "{why}: {r}");
    }
    e.stop();
}

/// The desktop types into its agent's PTY (`pty_input`, the keys of its
/// terminal), never through `send`: the box must still read the turn as
/// working, or a required upgrade restarts it mid-turn.
#[test]
fn a_turn_typed_by_the_desktop_reads_working() {
    let e = Env::new("typed");
    let (mut a, _b) = e.bridge();
    a.ok(json!({"cmd":"project_add","path": e.repo()}));
    desk_task(&mut a, &e, ID1, "typed", "typed");
    a.task_state("typed", |t| t.state == "idle");
    a.send(&ClientMsg::PtyInput { pid: format!("{ID1}:agent"), data: termic_remote::b64(b"nap\r") });
    a.task_state("typed", |t| t.state == "working");
}
