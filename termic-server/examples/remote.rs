//! Drive a real termic-server over real ssh, the way the desktop does.
//!
//!   cargo run -p termic-server --example remote -- run     user@box
//!   cargo run -p termic-server --example remote -- check   user@box
//!   cargo run -p termic-server --example remote -- cleanup user@box
//!
//! `run` creates ~/termic-remote-test on the box (a git repo), adds it as a
//! project, starts a task running the login shell, sends it a command and
//! a long one, then drops the ssh session. `check` reconnects and finds the
//! long command finishing in the same terminal. `cleanup` archives the
//! task, removes the project and the repo, and stops the daemon.

use std::collections::VecDeque;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use termic_remote::conn::{MsgReader, MsgWriter};
use termic_remote::framed::{FramedReader, FramedWriter};
use termic_remote::wire::{ClientKind, ClientMsg, ServerMsg};

const BRIDGE: &str = "if [ -x ~/.termic/bin/termic-server ]; then exec ~/.termic/bin/termic-server bridge; elif command -v termic-server >/dev/null 2>&1; then exec termic-server bridge; else echo 'termic-server is not installed' >&2; exit 127; fi";
const TASK: &str = "remote-e2e";

struct Client {
    w: MsgWriter,
    rx: mpsc::Receiver<ServerMsg>,
    seen: VecDeque<ServerMsg>,
    n: u64,
    child: Child,
}

impl Client {
    fn connect(dest: &str) -> Client {
        let mut child = Command::new("ssh")
            .args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", dest, BRIDGE])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("ssh");
        let mut w = MsgWriter::plain(Box::new(FramedWriter(child.stdin.take().unwrap())));
        let mut r = MsgReader::plain(Box::new(FramedReader(child.stdout.take().unwrap())));
        w.send(&ClientMsg::Hello { v: 1, name: "remote example".into(), kind: ClientKind::Computer, caps: vec!["tasks".into()], app_version: None, grant: None, port: None }).unwrap();
        let welcome = r.recv::<ServerMsg>().unwrap().expect("no welcome");
        println!("< {}", serde_json::to_string(&welcome).unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(Some(m)) = r.recv::<ServerMsg>() {
                if tx.send(m).is_err() {
                    break;
                }
            }
        });
        Client { w, rx, seen: VecDeque::new(), n: 0, child }
    }

    fn wait_for<R>(&mut self, what: &str, secs: u64, mut f: impl FnMut(&ServerMsg) -> Option<R>) -> R {
        if let Some(i) = self.seen.iter().position(|m| f(m).is_some()) {
            let m = self.seen.remove(i).unwrap();
            return f(&m).unwrap();
        }
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            match self.rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(m) => {
                    if let ServerMsg::Tasks { tasks } = &m {
                        let s: Vec<String> = tasks.iter().map(|t| format!("{}={}", t.name, t.state)).collect();
                        println!("< tasks [{}]", s.join(", "));
                    }
                    if let Some(r) = f(&m) {
                        return r;
                    }
                    self.seen.push_back(m);
                }
                Err(_) => panic!("timed out waiting for {what}"),
            }
        }
    }

    fn call(&mut self, req: Value) -> Value {
        self.n += 1;
        let id = format!("c{}", self.n);
        let mut req = req;
        req["id"] = json!(id);
        println!("> {req}");
        self.w.send(&ClientMsg::Call { id: id.clone(), req, proto: None }).unwrap();
        let r = self.wait_for("reply", 120, |m| match m {
            ServerMsg::Reply { id: rid, reply } if *rid == id => Some(reply.clone()),
            _ => None,
        });
        let text = r.to_string();
        println!("< {}", text.chars().take(300).collect::<String>());
        r
    }

    fn term_until(&mut self, needle: &str, secs: u64) -> String {
        let mut acc = String::new();
        self.wait_for(needle, secs, |m| {
            let data = match m {
                ServerMsg::TermReset { data, .. } | ServerMsg::TermData { data } => data,
                _ => return None,
            };
            acc.push_str(&String::from_utf8_lossy(&termic_remote::unb64(data).unwrap()));
            acc.contains(needle).then(|| acc.clone())
        })
    }

    fn close(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn ssh(dest: &str, cmd: &str) -> String {
    let out = Command::new("ssh").args(["-T", "-o", "BatchMode=yes", "--", dest, cmd]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (step, dest) = (args.get(1).map(String::as_str).unwrap_or(""), args.get(2).cloned().unwrap_or_default());
    match step {
        "run" => {
            ssh(&dest, "set -e; rm -rf ~/termic-remote-test; mkdir -p ~/termic-remote-test; cd ~/termic-remote-test; git init -q -b main; git config user.email e2e@termic.dev; git config user.name e2e; echo hi > README; git add .; git commit -qm init");
            let mut c = Client::connect(&dest);
            let home = ssh(&dest, "echo $HOME").trim().to_string();
            let r = c.call(json!({"cmd":"project_add","path": format!("{home}/termic-remote-test")}));
            assert_eq!(r["ok"], json!(true));
            let r = c.call(json!({"cmd":"agents"}));
            assert_eq!(r["ok"], json!(true));
            let r = c.call(json!({"cmd":"new","name":TASK,"agent":"shell","project":"termic-remote-test"}));
            assert_eq!(r["ok"], json!(true), "{r}");
            c.w.send(&ClientMsg::TermOpen { task: TASK.into(), tab: None }).unwrap();
            c.wait_for("term_reset", 20, |m| matches!(m, ServerMsg::TermReset { .. }).then_some(()));
            let r = c.call(json!({"cmd":"wait","task":TASK,"timeout_ms":20000}));
            assert_eq!(r["ok"], json!(true));
            let r = c.call(json!({"cmd":"send","task":TASK,"prompt":"echo hi-from-$(uname -s); git branch --show-current"}));
            assert_eq!(r["ok"], json!(true), "{r}");
            let out = c.term_until("hi-from-Linux", 20);
            assert!(out.contains(TASK), "the shell runs in the task's worktree on its branch");
            println!("terminal saw: hi-from-Linux and branch {TASK}");
            let r = c.call(json!({"cmd":"send","task":TASK,"prompt":"sleep 20; echo still-alive-after-ssh"}));
            assert_eq!(r["ok"], json!(true));
            c.wait_for("working", 20, |m| match m {
                ServerMsg::Tasks { tasks } => tasks.iter().any(|t| t.name == TASK && t.state == "working").then_some(()),
                _ => None,
            });
            c.close();
            println!("ssh session dropped with the task working");
        }
        "check" => {
            let mut c = Client::connect(&dest);
            c.w.send(&ClientMsg::TermOpen { task: TASK.into(), tab: None }).unwrap();
            let out = c.term_until("still-alive-after-ssh\r\n", 60);
            assert!(out.contains("hi-from-Linux"), "the backlog kept the earlier output");
            println!("reconnected: the command started before the drop finished in the same terminal");
            let r = c.call(json!({"cmd":"status","task":TASK}));
            assert_eq!(r["ok"], json!(true));
            c.close();
        }
        "cleanup" => {
            let mut c = Client::connect(&dest);
            let r = c.call(json!({"cmd":"archive","task":TASK}));
            println!("archive ok: {}", r["ok"]);
            let r = c.call(json!({"cmd":"project_remove","name":"termic-remote-test"}));
            println!("project_remove ok: {}", r["ok"]);
            c.close();
            println!("{}", ssh(&dest, "~/.termic/bin/termic-server stop; rm -rf ~/termic-remote-test; ls ~/.termic-server/worktrees/* 2>/dev/null | wc -l"));
        }
        _ => eprintln!("usage: remote <run|check|cleanup> <ssh destination>"),
    }
}
