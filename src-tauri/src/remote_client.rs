//! The client side of the remote-control stream (docs/remote.md): THIS
//! Termic connected to other machines.
//!
//! - **Paired computers** (peers.rs): a WebSocket to their peer listener,
//!   sealed with the pair key. Their tasks show in the sidebar.
//! - **Servers** (`servers.json`): `ssh -T <host> termic-server bridge`,
//!   the system's ssh with the user's own config and keys; Termic stores
//!   no credential. A headless box whose `termic-server` daemon holds the
//!   agents, so they keep running while this laptop sleeps.
//!
//! Both speak the same messages (termic-remote), so the sidebar, the
//! remote task view and `--peer` treat them alike.
//!
//! One supervised **link** per machine keeps a connection up while the
//! machine is configured: reconnecting with a capped backoff, pinging so
//! the host's idle timeout never fires, failing pending calls at once when
//! the connection drops. The webview hears about changes through one event
//! (`remote://machines`), sent only when something changed.

use std::collections::HashMap;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command as ProcCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use termic_remote::conn::{self, MsgReader, MsgWriter};
use termic_remote::framed::{FramedReader, FramedWriter};
use termic_remote::wire::{self, ClientKind, ClientMsg, ServerMsg, TaskRow};
use termic_remote::ws;

use crate::dlog;

/// Ping cadence: well inside the host's 75 s idle timeout.
const PING_EVERY: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
/// Reconnect backoff, doubling from the first to the cap.
const BACKOFF_FIRST: Duration = Duration::from_secs(2);
const BACKOFF_CAP: Duration = Duration::from_secs(30);
/// How long a call over a link waits by default (a verb's own budget
/// overrides it).
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const SERVERS_FILE: &str = "servers.json";
/// Where "Install on server" puts the binary, and where the bridge is
/// looked for first. No sudo, nothing outside the user's home.
pub(crate) const SERVER_BIN: &str = "~/.termic/bin/termic-server";

// ───────────────────────────── machines ──────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MachineKind {
    Computer,
    Server,
}

/// A machine as the sidebar shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct MachineView {
    pub id: String,
    pub kind: MachineKind,
    pub name: String,
    /// "connecting" | "online" | "offline".
    pub state: String,
    /// Why it is offline, in one sentence a person can act on.
    pub error: Option<String>,
    pub version: Option<String>,
    /// What this machine may do there ("drive" | "reply").
    pub grant: Option<String>,
    pub caps: Vec<String>,
    pub tasks: Vec<TaskRow>,
    /// A server's ssh destination.
    pub ssh: Option<String>,
}

/// A server, as `servers.json` stores it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub(crate) struct ServerRecord {
    pub id: String,
    pub name: String,
    /// What `ssh` is given: `user@host`, a `~/.ssh/config` alias, `host:port`
    /// is not ssh syntax so a port goes in the config or as `-p` via alias.
    pub ssh: String,
    /// The remote command that starts the bridge. Default: the installed
    /// binary, falling back to one on PATH.
    pub command: Option<String>,
    pub added_at_ms: i64,
}


fn servers_path() -> Option<PathBuf> {
    crate::global_dir().ok().map(|d| d.join(SERVERS_FILE))
}

pub(crate) fn load_servers() -> Vec<ServerRecord> {
    servers_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_servers(list: &[ServerRecord]) -> Result<(), String> {
    let p = servers_path().ok_or("no data directory")?;
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// The remote command for a server: the installed binary if present, else
/// one on PATH. One `sh -c` line, so it works whatever the login shell is.
fn bridge_command(rec: &ServerRecord) -> String {
    rec.command.clone().unwrap_or_else(|| {
        format!(
            "if [ -x {SERVER_BIN} ]; then exec {SERVER_BIN} bridge; elif command -v termic-server >/dev/null 2>&1; then exec termic-server bridge; else echo 'termic-server is not installed' >&2; exit 127; fi"
        )
    })
}

// ───────────────────────────── a link ────────────────────────────────

#[derive(Clone)]
enum Endpoint {
    Peer { id: String },
    Server(ServerRecord),
}

struct LinkState {
    state: String,
    error: Option<String>,
    version: Option<String>,
    grant: Option<String>,
    caps: Vec<String>,
    tasks: Vec<TaskRow>,
    name: String,
}

pub(crate) type TermSink = Arc<dyn Fn(Value) + Send + Sync>;

struct Link {
    id: String,
    kind: MachineKind,
    endpoint: Mutex<Endpoint>,
    st: Mutex<LinkState>,
    /// Outbound messages; the connection's writer thread drains it.
    tx: Mutex<Option<mpsc::Sender<ClientMsg>>>,
    /// Calls and transcript requests waiting for their answer, by id.
    pending: Mutex<HashMap<String, mpsc::Sender<ServerMsg>>>,
    /// Where the open terminal's messages go (a Tauri channel).
    term: Mutex<Option<TermSink>>,
    stop: AtomicBool,
    /// Woken to stop, or to reconnect now.
    wake: (Mutex<bool>, Condvar),
    /// The running connection's ssh child, killed on stop.
    child: Mutex<Option<Child>>,
    /// The running connection's socket, shut down on stop.
    sock: Mutex<Option<TcpStream>>,
}

fn next_id() -> String {
    static N: AtomicU64 = AtomicU64::new(1);
    format!("r{}", N.fetch_add(1, Ordering::Relaxed))
}

impl Link {
    fn view(&self) -> MachineView {
        let st = self.st.lock().unwrap();
        let ssh = match &*self.endpoint.lock().unwrap() {
            Endpoint::Server(r) => Some(r.ssh.clone()),
            Endpoint::Peer { .. } => None,
        };
        MachineView {
            id: self.id.clone(),
            kind: self.kind,
            name: st.name.clone(),
            state: st.state.clone(),
            error: st.error.clone(),
            version: st.version.clone(),
            grant: st.grant.clone(),
            caps: st.caps.clone(),
            tasks: st.tasks.clone(),
            ssh,
        }
    }

    fn set_state(&self, state: &str, error: Option<String>) {
        {
            let mut st = self.st.lock().unwrap();
            if st.state == state && st.error == error {
                return;
            }
            st.state = state.into();
            st.error = error;
            if state != "online" {
                st.tasks.clear();
            }
        }
        changed();
    }

    fn send(&self, msg: ClientMsg) -> Result<(), String> {
        match self.tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(msg).map_err(|_| "the connection just closed".to_string()),
            None => Err(self.offline_reason()),
        }
    }

    fn offline_reason(&self) -> String {
        let st = self.st.lock().unwrap();
        st.error.clone().unwrap_or_else(|| format!("{} is not connected", st.name))
    }

    /// Send a request and wait for the answer with the same id.
    fn request(&self, id: &str, msg: ClientMsg, timeout: Duration) -> Result<ServerMsg, String> {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.to_string(), tx);
        if let Err(e) = self.send(msg) {
            self.pending.lock().unwrap().remove(id);
            return Err(e);
        }
        let r = rx.recv_timeout(timeout);
        self.pending.lock().unwrap().remove(id);
        r.map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => "no answer in time".to_string(),
            mpsc::RecvTimeoutError::Disconnected => "the connection closed before the answer".to_string(),
        })
    }

    /// Sleep for the backoff, or until stopped / woken.
    fn pause(&self, d: Duration) {
        let mut woke = self.wake.0.lock().unwrap();
        if !*woke && !self.stop.load(Ordering::SeqCst) {
            woke = self.wake.1.wait_timeout(woke, d).unwrap().0;
        }
        *woke = false;
    }

    fn halt(&self) {
        self.stop.store(true, Ordering::SeqCst);
        *self.wake.0.lock().unwrap() = true;
        self.wake.1.notify_all();
        if let Some(s) = self.sock.lock().unwrap().take() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// The links, by machine id.
fn links() -> &'static Mutex<HashMap<String, Arc<Link>>> {
    static L: OnceLock<Mutex<HashMap<String, Arc<Link>>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How the webview hears about changes. Set once by the app; unset in tests.
type Notify = Box<dyn Fn(Vec<MachineView>) + Send + Sync>;

fn notifier() -> &'static Mutex<Option<Notify>> {
    static N: OnceLock<Mutex<Option<Notify>>> = OnceLock::new();
    N.get_or_init(|| Mutex::new(None))
}

/// The last list sent, so an unchanged one is never sent again (the
/// webview's store must never be written with an unchanged value,
/// docs/performance.md bear trap 8).
fn last_sent() -> &'static Mutex<Vec<MachineView>> {
    static S: OnceLock<Mutex<Vec<MachineView>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

fn changed() {
    let list = machines();
    {
        let mut last = last_sent().lock().unwrap();
        if *last == list {
            return;
        }
        *last = list.clone();
    }
    if let Some(n) = notifier().lock().unwrap().as_ref() {
        n(list);
    }
}

pub(crate) fn machines() -> Vec<MachineView> {
    let mut v: Vec<MachineView> = links().lock().unwrap().values().map(|l| l.view()).collect();
    v.sort_by_key(|m| (m.kind as u8, m.name.to_lowercase()));
    v
}

fn link(id: &str) -> Result<Arc<Link>, String> {
    links().lock().unwrap().get(id).cloned().ok_or_else(|| "that machine is not connected to this one".to_string())
}

/// Stop and drop a machine's link (unpaired, server removed).
pub(crate) fn forget(id: &str) {
    let l = links().lock().unwrap().remove(id);
    if let Some(l) = l {
        l.halt();
        changed();
    }
}

/// Bring the links in line with what is configured: every paired computer
/// (while sharing is on, which is what makes pairs reachable at all) and
/// every server. Idempotent; called at start and whenever either changes.
pub(crate) fn supervise() {
    let mut want: Vec<(String, MachineKind, String, Endpoint)> = Vec::new();
    if let Some(node) = crate::peers::node() {
        if node.sharing_on() {
            for (id, name) in node.paired_computers() {
                want.push((id.clone(), MachineKind::Computer, name, Endpoint::Peer { id }));
            }
        }
    }
    for s in load_servers() {
        want.push((s.id.clone(), MachineKind::Server, s.name.clone(), Endpoint::Server(s)));
    }
    let mut map = links().lock().unwrap();
    let stale: Vec<String> = map.keys().filter(|id| !want.iter().any(|w| &w.0 == *id)).cloned().collect();
    for id in stale {
        if let Some(l) = map.remove(&id) {
            l.halt();
        }
    }
    for (id, kind, name, endpoint) in want {
        if let Some(l) = map.get(&id) {
            // A rename or an edited server takes effect on the next connect.
            l.st.lock().unwrap().name = name;
            *l.endpoint.lock().unwrap() = endpoint;
            continue;
        }
        let l = Arc::new(Link {
            id: id.clone(),
            kind,
            endpoint: Mutex::new(endpoint),
            st: Mutex::new(LinkState { state: "connecting".into(), error: None, version: None, grant: None, caps: Vec::new(), tasks: Vec::new(), name }),
            tx: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            term: Mutex::new(None),
            stop: AtomicBool::new(false),
            wake: (Mutex::new(false), Condvar::new()),
            child: Mutex::new(None),
            sock: Mutex::new(None),
        });
        map.insert(id, l.clone());
        std::thread::spawn(move || run_link(l));
    }
    drop(map);
    changed();
}

/// Reconnect every offline link now (the network changed, a peer was seen).
pub(crate) fn nudge() {
    for l in links().lock().unwrap().values() {
        *l.wake.0.lock().unwrap() = true;
        l.wake.1.notify_all();
    }
}

fn run_link(l: Arc<Link>) {
    let mut backoff = BACKOFF_FIRST;
    while !l.stop.load(Ordering::SeqCst) {
        let endpoint = l.endpoint.lock().unwrap().clone();
        // Read first: a guard in the argument would live through the call,
        // and set_state locks the same mutex.
        let last_error = l.st.lock().unwrap().error.clone();
        l.set_state("connecting", last_error);
        match connect(&l, &endpoint) {
            Ok((welcome, reader, writer)) => {
                backoff = BACKOFF_FIRST;
                if let ServerMsg::Welcome { version, grant, caps, name, .. } = welcome {
                    let mut st = l.st.lock().unwrap();
                    st.version = Some(version);
                    st.grant = grant;
                    st.caps = caps;
                    // A server names itself; a paired computer keeps the
                    // local name the user gave it.
                    if matches!(endpoint, Endpoint::Server(_)) && st.name.trim().is_empty() {
                        st.name = name;
                    }
                }
                l.set_state("online", None);
                session(&l, reader, writer);
                if l.stop.load(Ordering::SeqCst) {
                    return;
                }
                l.set_state("offline", Some("The connection dropped. Reconnecting.".into()));
            }
            Err(e) => {
                if l.stop.load(Ordering::SeqCst) {
                    return;
                }
                l.set_state("offline", Some(e));
            }
        }
        l.pause(backoff);
        backoff = (backoff * 2).min(BACKOFF_CAP);
    }
}

type Connection = (ServerMsg, MsgReader, MsgWriter);

fn connect(l: &Link, endpoint: &Endpoint) -> Result<Connection, String> {
    match endpoint {
        Endpoint::Peer { id } => {
            let node = crate::peers::node().ok_or("pairing is not running")?;
            let (c, sock) = connect_peer(&node, id, true)?;
            *l.sock.lock().unwrap() = Some(sock);
            Ok(c)
        }
        Endpoint::Server(rec) => {
            let (c, child) = connect_server(rec)?;
            *l.child.lock().unwrap() = Some(child);
            Ok(c)
        }
    }
}

/// A sealed WebSocket to a paired computer. Returns the socket too, so the
/// caller can cut it.
pub(crate) fn connect_peer(node: &crate::peers::Node, peer_id: &str, wants_tasks: bool) -> Result<(Connection, TcpStream), String> {
    let ep = node.peer_endpoint(peer_id)?;
    let mut last = String::from("no known address");
    for addr in ep.addrs.iter() {
        match connect_addr(*addr, &ep, wants_tasks) {
            Ok(c) => return Ok(c),
            Err(e) => last = e,
        }
    }
    // A machine that moved (a new DHCP lease) is not gone: ask the network.
    if let Some(addr) = node.rediscover_addr(peer_id) {
        if !ep.addrs.contains(&addr) {
            return connect_addr(addr, &ep, wants_tasks);
        }
    }
    Err(last)
}

fn connect_addr(addr: SocketAddr, ep: &crate::peers::PeerEndpoint, wants_tasks: bool) -> Result<(Connection, TcpStream), String> {
    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| format!("Could not reach {} ({e}). Check that it is awake and has sharing on.", ep.name))?;
    let _ = s.set_nodelay(true);
    let _ = s.set_read_timeout(Some(Duration::from_secs(90)));
    ws::client_handshake(&mut s, &addr.to_string(), crate::peers::STREAM_PATH).map_err(|e| {
        if e.to_string().contains("refused (403)") {
            format!("{} has sharing turned off.", ep.name)
        } else if e.to_string().contains("refused (404)") {
            format!("{} runs an older Termic without remote control. Update it.", ep.name)
        } else {
            format!("Could not reach {} ({e}).", ep.name)
        }
    })?;
    let kill = s.try_clone().map_err(|e| e.to_string())?;
    let (r, w) = ws::split_tcp(s, ws::End::Client).map_err(|e| e.to_string())?;
    let hello = ClientMsg::Hello {
        v: wire::VERSION,
        name: ep.self_name.clone(),
        kind: ClientKind::Computer,
        caps: if wants_tasks { vec![wire::caps::TASKS.to_string()] } else { Vec::new() },
        app_version: Some(env!("CARGO_PKG_VERSION").into()),
        grant: Some(ep.grant.clone()),
        port: ep.port,
    };
    let c = conn::client_handshake(Box::new(r), Box::new(w), &ep.peer_id, &ep.self_id, &ep.key, &hello).map_err(|e| {
        if e.kind() == io::ErrorKind::PermissionDenied {
            format!("{} no longer accepts this computer. It may have unpaired it: unpair here and pair again.", ep.name)
        } else {
            format!("Could not reach {} ({e}).", ep.name)
        }
    })?;
    Ok(((c.welcome, c.reader, c.writer), kill))
}

/// `ssh -T <host> <bridge>`: frames over the child's stdin/stdout. ssh's
/// own stderr is kept to explain a failure in plain words.
fn connect_server(rec: &ServerRecord) -> Result<(Connection, Child), String> {
    let mut child = ssh_command(&rec.ssh)
        .arg(bridge_command(rec))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ssh_missing(&e))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let mut writer = MsgWriter::plain(Box::new(FramedWriter(stdin)));
    let mut reader = MsgReader::plain(Box::new(FramedReader(stdout)));
    let name = crate::peers::node().map(|n| n.self_name()).unwrap_or_else(crate::peers::default_name);
    let hello = ClientMsg::Hello {
        v: wire::VERSION,
        name,
        kind: ClientKind::Computer,
        caps: vec![wire::caps::TASKS.to_string()],
        app_version: Some(env!("CARGO_PKG_VERSION").into()),
        grant: None,
        port: None,
    };
    let fail = |child: &mut Child, stderr: Option<std::process::ChildStderr>| -> String {
        let _ = child.kill();
        let status = child.wait().ok().and_then(|s| s.code());
        let mut err = String::new();
        if let Some(mut e) = stderr {
            let _ = io::Read::read_to_string(&mut e, &mut err);
        }
        explain_ssh(&rec.ssh, status, &err)
    };
    if writer.send(&hello).is_err() {
        return Err(fail(&mut child, stderr));
    }
    match reader.recv::<ServerMsg>() {
        Ok(Some(w @ ServerMsg::Welcome { .. })) => {
            // ssh's stderr is drained from here on so a chatty remote can
            // never fill the pipe and stall the connection.
            if let Some(mut e) = stderr {
                std::thread::spawn(move || {
                    let _ = io::copy(&mut e, &mut io::sink());
                });
            }
            Ok(((w, reader, writer), child))
        }
        _ => Err(fail(&mut child, stderr)),
    }
}

/// `ssh`, `ssh-keyscan` or `ssh-keygen`, with no console window flashing up
/// on Windows (a GUI app's child gets one by default; proc_ctl::hide_console).
fn tool(program: &str) -> ProcCommand {
    // Test seam, debug builds only: the e2e suite's stand-in for ssh
    // (e2e/fixtures/fake-ssh.sh), which serves one reserved host from a
    // real termic-server on this machine, so CI covers servers without a box.
    #[cfg(debug_assertions)]
    let program = match std::env::var("TERMIC_SSH_BIN") {
        Ok(p) if program == "ssh" && !p.is_empty() => p,
        _ => program.to_string(),
    };
    let mut c = ProcCommand::new(program);
    crate::proc_ctl::hide_console(&mut c);
    c
}

/// Why `ssh` could not even start, as one sentence with the fix. Windows
/// ships OpenSSH as an optional feature that may be off.
fn ssh_missing(e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        if cfg!(windows) {
            "ssh is not installed. Turn on OpenSSH Client in Windows Settings > System > Optional features, then try again.".into()
        } else {
            "ssh is not installed. Install OpenSSH, then try again.".into()
        }
    } else {
        format!("Could not run ssh ({e}).")
    }
}

pub(crate) fn ssh_command(dest: &str) -> ProcCommand {
    let mut c = tool("ssh");
    // BatchMode: never prompt (there is nobody at a terminal to answer);
    // a host key or a password problem fails fast with a message we turn
    // into a sentence. Keepalives notice a dead network within a minute.
    c.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", dest]);
    c
}

/// One sentence for an ssh failure, with what to do about it.
pub(crate) fn explain_ssh(dest: &str, status: Option<i32>, stderr: &str) -> String {
    let e = stderr.to_lowercase();
    if e.contains("host key verification failed") || e.contains("no matching host key") {
        format!("{dest}'s host key is not trusted yet. Run `ssh {dest}` once in a terminal and accept it, or use Trust in Settings.")
    } else if e.contains("remote host identification has changed") {
        format!("{dest}'s host key CHANGED since you last connected. This can mean someone is intercepting the connection. Check with whoever runs it before fixing ~/.ssh/known_hosts.")
    } else if e.contains("permission denied") {
        format!("{dest} refused your SSH key. Check that `ssh {dest}` works without a password (Termic uses your keys and ssh-agent, never a password).")
    } else if e.contains("could not resolve hostname") || e.contains("name or service not known") {
        format!("No machine called {dest} could be found. Check the name, or use its IP address.")
    } else if e.contains("connection refused") {
        format!("{dest} refused the connection. Is SSH (sshd) running there?")
    } else if e.contains("timed out") || e.contains("no route to host") || e.contains("network is unreachable") {
        format!("{dest} did not answer. Check that it is on and reachable from this network (or your VPN).")
    } else if status == Some(127) || e.contains("termic-server is not installed") || e.contains("not found") {
        format!("termic-server is not installed on {dest}. Use Install in Settings.")
    } else {
        let first = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("the connection closed");
        format!("Could not connect to {dest}: {first}")
    }
}

/// A connection's life: a writer thread draining the link's queue (and
/// pinging when idle), this thread reading and dispatching.
fn session(l: &Arc<Link>, mut reader: MsgReader, mut writer: MsgWriter) {
    let (tx, rx) = mpsc::channel::<ClientMsg>();
    *l.tx.lock().unwrap() = Some(tx);
    let writer_thread = std::thread::spawn(move || {
        loop {
            match rx.recv_timeout(PING_EVERY) {
                Ok(m) => {
                    if writer.send(&m).is_err() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if writer.send(&ClientMsg::Ping {}).is_err() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        writer.close(1000, "");
    });
    while let Ok(Some(m)) = reader.recv::<ServerMsg>() {
        dispatch(l, m);
    }
    l.tx.lock().unwrap().take();
    // Every waiting call fails now rather than at its timeout.
    l.pending.lock().unwrap().clear();
    if let Some(sink) = l.term.lock().unwrap().as_ref() {
        sink(serde_json::json!({ "t": "term_closed", "reason": "disconnected" }));
    }
    let _ = writer_thread.join();
    if let Some(mut c) = l.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    l.sock.lock().unwrap().take();
}

fn dispatch(l: &Link, m: ServerMsg) {
    match m {
        ServerMsg::Tasks { tasks } => {
            let differs = {
                let mut st = l.st.lock().unwrap();
                if st.tasks == tasks {
                    false
                } else {
                    st.tasks = tasks;
                    true
                }
            };
            if differs {
                changed();
                // A server's projects and tasks live in the desktop's store
                // (server_projects.rs): bring it up to date.
                if l.kind == MachineKind::Server {
                    crate::server_projects::sync_soon(&l.id);
                }
            }
        }
        ServerMsg::Reply { ref id, .. } | ServerMsg::Transcript { ref id, .. } | ServerMsg::Ack { ref id, .. } => {
            let tx = l.pending.lock().unwrap().remove(id);
            if let Some(tx) = tx {
                let _ = tx.send(m);
            }
        }
        ServerMsg::TermReset { .. } | ServerMsg::TermData { .. } | ServerMsg::TermResize { .. } | ServerMsg::TermClosed { .. } => {
            if let Some(sink) = l.term.lock().unwrap().as_ref() {
                sink(serde_json::to_value(&m).unwrap_or_default());
            }
        }
        ServerMsg::Error { message } => dlog(&format!("[remote] {}: {message}", l.id)),
        _ => {}
    }
}

// ───────────────────────────── API ───────────────────────────────────

/// Run a termic-proto Request on a machine (the sidebar's actions, and
/// `--peer` to a server). Returns the Reply as JSON.
pub(crate) fn call(machine: &str, mut req: Value, timeout: Option<Duration>) -> Result<Value, String> {
    let l = link(machine)?;
    let id = next_id();
    if let Some(o) = req.as_object_mut() {
        o.insert("id".into(), Value::String(id.clone()));
        o.remove("peer");
        o.remove("token");
    }
    let proto = Some(termic_proto::PROTOCOL_VERSION).filter(|_| l.kind == MachineKind::Computer);
    match l.request(&id, ClientMsg::Call { id: id.clone(), req, proto }, timeout.unwrap_or(CALL_TIMEOUT))? {
        ServerMsg::Reply { reply, .. } => Ok(reply),
        _ => Err("unexpected answer".into()),
    }
}

pub(crate) fn term_open(machine: &str, task: &str, tab: Option<String>, sink: TermSink) -> Result<(), String> {
    let l = link(machine)?;
    *l.term.lock().unwrap() = Some(sink);
    l.send(ClientMsg::TermOpen { task: task.into(), tab })
}

pub(crate) fn term_close(machine: &str) -> Result<(), String> {
    let l = link(machine)?;
    l.term.lock().unwrap().take();
    l.send(ClientMsg::TermClose {})
}

pub(crate) fn term_input(machine: &str, data: &str) -> Result<(), String> {
    link(machine)?.send(ClientMsg::TermInput { data: data.into() })
}

/// Size the open terminal's PTY: only to a host that offers it (`resize`,
/// a termic-server). Another host's PTY is sized by its own window; it
/// would ignore the message, and this does not send it.
pub(crate) fn term_size(machine: &str, cols: u16, rows: u16) -> Result<(), String> {
    let l = link(machine)?;
    if !l.st.lock().unwrap().caps.iter().any(|c| c == wire::caps::RESIZE) {
        return Ok(());
    }
    l.send(ClientMsg::TermSize { cols, rows })
}

/// The machine a `--peer` selector names among SERVERS (paired computers
/// are resolved by peers.rs first): its id, or None.
pub(crate) fn find_server(sel: &str) -> Option<String> {
    let sel = sel.trim().to_lowercase();
    load_servers().into_iter().find(|s| s.id == sel || s.name.to_lowercase() == sel || s.ssh.to_lowercase() == sel).map(|s| s.id)
}

// ───────────────────────────── servers ───────────────────────────────

pub(crate) fn add_server(ssh: &str, name: &str) -> Result<ServerRecord, String> {
    let ssh = ssh.trim();
    if ssh.is_empty() || ssh.starts_with('-') || ssh.contains(char::is_whitespace) {
        return Err("Enter the server as you would after `ssh`, for example alice@192.168.1.20 or a name from ~/.ssh/config.".into());
    }
    let mut list = load_servers();
    if list.iter().any(|s| s.ssh == ssh) {
        return Err(format!("{ssh} is already added."));
    }
    let name = {
        let n: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(60).collect();
        if n.is_empty() {
            ssh.rsplit('@').next().unwrap_or(ssh).to_string()
        } else {
            n
        }
    };
    let rec = ServerRecord {
        id: termic_remote::seal::random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect(),
        name,
        ssh: ssh.into(),
        command: None,
        added_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    list.push(rec.clone());
    save_servers(&list)?;
    supervise();
    Ok(rec)
}

pub(crate) fn remove_server(id: &str) -> Result<(), String> {
    let mut list = load_servers();
    let before = list.len();
    list.retain(|s| s.id != id);
    if list.len() == before {
        return Err("That server is not added.".into());
    }
    save_servers(&list)?;
    forget(id);
    supervise();
    Ok(())
}

pub(crate) fn rename_server(id: &str, name: &str) -> Result<(), String> {
    let mut list = load_servers();
    let s = list.iter_mut().find(|s| s.id == id).ok_or("That server is not added.")?;
    let n: String = name.trim().chars().take(60).collect();
    if n.is_empty() {
        return Err("A name is needed.".into());
    }
    s.name = n;
    save_servers(&list)?;
    supervise();
    Ok(())
}

// ───────────────────────────── app wiring ────────────────────────────

pub(crate) fn init(app: tauri::AppHandle) {
    use tauri::Emitter;
    *notifier().lock().unwrap() = Some(Box::new(move |list| {
        let _ = app.emit("remote://machines", list);
    }));
    std::thread::spawn(supervise);
}

#[tauri::command]
pub(crate) fn remote_machines() -> Vec<MachineView> {
    machines()
}

#[tauri::command]
pub(crate) async fn remote_call(machine: String, request: Value, timeout_ms: Option<u64>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || call(&machine, request, timeout_ms.map(Duration::from_millis)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn remote_term_open(machine: String, task: String, tab: Option<String>, on_event: tauri::ipc::Channel<Value>) -> Result<(), String> {
    term_open(&machine, &task, tab, Arc::new(move |v| {
        let _ = on_event.send(v);
    }))
}

#[tauri::command]
pub(crate) fn remote_term_close(machine: String) -> Result<(), String> {
    term_close(&machine)
}

/// The webview's project folder colours (localStorage `groupColors`), so
/// the rows this computer serves carry them (remote_server.rs).
#[tauri::command]
pub(crate) fn remote_set_folder_colors(colors: std::collections::HashMap<String, String>) {
    crate::remote_server::set_project_folder_colors(colors);
}

/// One window's sidebar folds (see remote_server.rs `Folds`).
#[tauri::command]
pub(crate) fn remote_set_sidebar_folds(window: tauri::Window, folds: crate::remote_server::Folds) {
    crate::remote_server::set_sidebar_folds(window.label(), folds);
}

#[tauri::command]
pub(crate) fn remote_term_size(machine: String, cols: u16, rows: u16) -> Result<(), String> {
    term_size(&machine, cols, rows)
}

#[tauri::command]
pub(crate) fn remote_term_input(machine: String, data: String) -> Result<(), String> {
    term_input(&machine, &data)
}

#[tauri::command]
pub(crate) fn remote_reconnect() {
    nudge();
}

#[tauri::command]
pub(crate) async fn server_add(ssh: String, name: String) -> Result<ServerRecord, String> {
    tauri::async_runtime::spawn_blocking(move || add_server(&ssh, &name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn server_remove(id: String) -> Result<(), String> {
    remove_server(&id)
}

#[tauri::command]
pub(crate) fn server_rename(id: String, name: String) -> Result<(), String> {
    rename_server(&id, &name)
}

#[tauri::command]
pub(crate) fn server_list() -> Vec<ServerRecord> {
    load_servers()
}

// ───────────────────────────── server setup ──────────────────────────

/// What the "Add a server" checklist learned about a host, before anything
/// is saved (a server is stored only once it connected).
#[derive(Debug, Clone, Serialize, Default)]
pub(crate) struct Probe {
    /// ssh reached the host and ran a command.
    pub reached: bool,
    /// One sentence when it did not (explain_ssh).
    pub error: Option<String>,
    /// "ok" | "unknown" (first connection) | "changed" (refuse).
    pub host_key: String,
    /// The host key fingerprint to show before trusting it.
    pub fingerprint: Option<String>,
    /// `uname -sm`: "Linux x86_64".
    pub system: Option<String>,
    /// The installed termic-server's version, if any.
    pub installed: Option<String>,
    /// ssh's own stderr, for "Show details".
    pub details: String,
    pub millis: u64,
}

/// The remote's view of itself in one ssh round trip.
const PROBE_SCRIPT: &str = "uname -sm; if [ -x ~/.termic/bin/termic-server ]; then ~/.termic/bin/termic-server version; elif command -v termic-server >/dev/null 2>&1; then termic-server version; else echo TERMIC_NOT_INSTALLED; fi";

pub(crate) fn probe(dest: &str) -> Probe {
    let started = std::time::Instant::now();
    let out = match ssh_command(dest).arg(PROBE_SCRIPT).stdin(Stdio::null()).output() {
        Ok(o) => o,
        Err(e) => return Probe { error: Some(ssh_missing(&e)), host_key: "unchecked".into(), ..Default::default() },
    };
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let mut p = Probe { details: stderr.clone(), millis: started.elapsed().as_millis() as u64, host_key: "ok".into(), ..Default::default() };
    let low = stderr.to_lowercase();
    if low.contains("remote host identification has changed") {
        p.host_key = "changed".into();
        p.error = Some(explain_ssh(dest, out.status.code(), &stderr));
        return p;
    }
    if low.contains("host key verification failed") || low.contains("no matching host key") {
        p.host_key = "unknown".into();
        p.fingerprint = fingerprint(dest);
        p.error = Some(format!("First connection to {dest}."));
        return p;
    }
    if !out.status.success() {
        p.error = Some(explain_ssh(dest, out.status.code(), &stderr));
        return p;
    }
    p.reached = true;
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    p.system = lines.next().map(str::to_string);
    p.installed = lines.next().filter(|l| *l != "TERMIC_NOT_INSTALLED").map(|l| l.trim_start_matches("termic-server").trim().to_string());
    p
}

/// The host key's SHA256 fingerprint, read with ssh-keyscan at the address
/// ssh itself resolves for `dest` (`ssh -G` applies the user's config).
fn fingerprint(dest: &str) -> Option<String> {
    let g = tool("ssh").args(["-G", "--", dest]).output().ok()?;
    let conf = String::from_utf8_lossy(&g.stdout);
    let get = |k: &str| conf.lines().find_map(|l| l.strip_prefix(&format!("{k} ")).map(|v| v.trim().to_string()));
    let host = get("hostname")?;
    let port = get("port").unwrap_or_else(|| "22".into());
    let scan = tool("ssh-keyscan").args(["-T", "5", "-p", &port, "--", &host]).stderr(Stdio::null()).output().ok()?;
    let mut keygen = tool("ssh-keygen").args(["-lf", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().ok()?;
    io::Write::write_all(keygen.stdin.as_mut()?, &scan.stdout).ok()?;
    drop(keygen.stdin.take());
    let out = keygen.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Prefer ED25519, the key modern sshd presents first.
    let pick = text.lines().find(|l| l.contains("ED25519")).or_else(|| text.lines().next())?;
    let mut parts = pick.split_whitespace();
    let _bits = parts.next();
    let fp = parts.next()?;
    let kind = pick.rsplit_once('(').map(|(_, k)| k.trim_end_matches(')')).unwrap_or("");
    Some(format!("{fp} ({kind})"))
}

/// Record a first-seen host key in the user's known_hosts, the way typing
/// "yes" at ssh's own prompt would (`accept-new` refuses a CHANGED key).
pub(crate) fn trust(dest: &str) -> Result<(), String> {
    let out = tool("ssh")
        .args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "--", dest, "true"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| ssh_missing(&e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(explain_ssh(dest, out.status.code(), &String::from_utf8_lossy(&out.stderr)))
    }
}

/// The Rust target triples a `uname -sm` can run, most portable first: a
/// static musl build has no glibc floor, so it is preferred.
fn triples_for(system: &str) -> Vec<&'static str> {
    let s = system.to_lowercase();
    let linux = s.starts_with("linux");
    let mac = s.starts_with("darwin");
    let arm = s.contains("aarch64") || s.contains("arm64");
    let x86 = s.contains("x86_64") || s.contains("amd64");
    match (linux, mac, arm, x86) {
        (true, _, false, true) => vec!["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"],
        (true, _, true, _) => vec!["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"],
        (_, true, true, _) => vec!["aarch64-apple-darwin"],
        (_, true, _, true) => vec!["x86_64-apple-darwin"],
        _ => Vec::new(),
    }
}

/// Where this Termic keeps termic-server builds: the app bundle's
/// resources, and (debug builds) `TERMIC_SERVER_BIN_DIR`.
fn binary_dirs(app: Option<&tauri::AppHandle>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(debug_assertions) {
        if let Ok(d) = std::env::var("TERMIC_SERVER_BIN_DIR") {
            if !d.trim().is_empty() {
                dirs.push(PathBuf::from(d));
            }
        }
    }
    if let Some(app) = app {
        use tauri::Manager;
        if let Ok(r) = app.path().resource_dir() {
            // tauri.conf.json bundles `resources/termic-server/*`, and a
            // bundle keeps that relative path under the resource dir.
            dirs.push(r.join("resources").join("termic-server"));
            dirs.push(r.join("termic-server"));
        }
    }
    dirs
}

fn find_binary(app: Option<&tauri::AppHandle>, system: &str) -> Option<PathBuf> {
    let dirs = binary_dirs(app);
    for triple in triples_for(system) {
        for d in &dirs {
            for name in [format!("termic-server-{triple}"), format!("{triple}/termic-server")] {
                let p = d.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Upload termic-server to `~/.termic/bin` over the same ssh: the file goes
/// through ssh's stdin into a temp name, is made executable, verified by
/// running it, and renamed into place, so a broken upload never replaces a
/// working binary. No sudo, nothing outside the user's home, no internet
/// needed on the box. Returns the installed version.
pub(crate) fn install(app: Option<&tauri::AppHandle>, dest: &str) -> Result<String, String> {
    let p = probe(dest);
    if !p.reached {
        return Err(p.error.unwrap_or_else(|| format!("Could not reach {dest}.")));
    }
    let system = p.system.clone().unwrap_or_default();
    let bin = find_binary(app, &system).ok_or_else(|| format!("This Termic has no termic-server build for {system}."))?;
    let file = std::fs::File::open(&bin).map_err(|e| format!("Could not read {} ({e})", bin.display()))?;
    let script = "set -e; mkdir -p ~/.termic/bin; chmod 700 ~/.termic; t=~/.termic/bin/.termic-server.upload.$$; cat > \"$t\"; chmod 755 \"$t\"; \"$t\" version >/dev/null; mv -f \"$t\" ~/.termic/bin/termic-server; ~/.termic/bin/termic-server version";
    let out = ssh_command(dest)
        .arg(script)
        .stdin(Stdio::from(file))
        .output()
        .map_err(|e| ssh_missing(&e))?;
    if !out.status.success() {
        return Err(explain_ssh(dest, out.status.code(), &String::from_utf8_lossy(&out.stderr)));
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().trim_start_matches("termic-server").trim().to_string();
    // A link waiting on this server reconnects now instead of at its backoff.
    nudge();
    Ok(v)
}

#[tauri::command]
pub(crate) async fn server_probe(ssh: String) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&ssh)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn server_trust(ssh: String) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || trust(&ssh).map(|_| probe(&ssh))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn server_install(app: tauri::AppHandle, ssh: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install(Some(&app), &ssh)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_failures_are_one_sentence_with_the_fix() {
        let cases = [
            ("Host key verification failed.", "not trusted yet"),
            ("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "CHANGED"),
            ("alice@box: Permission denied (publickey).", "refused your SSH key"),
            ("ssh: Could not resolve hostname nope: nodename nor servname provided", "could be found"),
            ("ssh: connect to host box port 22: Connection refused", "refused the connection"),
            ("ssh: connect to host box port 22: Operation timed out", "did not answer"),
            // Windows OpenSSH words two of them its own way.
            ("ssh: Could not resolve hostname nope: No such host is known.", "could be found"),
            ("ssh: connect to host box port 22: Connection timed out", "did not answer"),
        ];
        for (stderr, want) in cases {
            let s = explain_ssh("box", Some(255), stderr);
            assert!(s.contains(want), "{stderr} -> {s}");
            assert!(!s.contains('\u{2014}'), "no em dashes: {s}");
        }
        assert!(explain_ssh("box", Some(127), "sh: termic-server: not found").contains("not installed"));
    }

    #[test]
    fn a_missing_ssh_says_how_to_get_it() {
        let s = ssh_missing(&io::Error::from(io::ErrorKind::NotFound));
        assert!(s.contains("ssh is not installed"), "{s}");
        if cfg!(windows) {
            assert!(s.contains("Optional features"), "{s}");
        }
        assert!(ssh_missing(&io::Error::from(io::ErrorKind::PermissionDenied)).starts_with("Could not run ssh"));
    }

    /// A link to a server that cannot be reached goes offline with a
    /// sentence, and stays readable meanwhile (a lock held across
    /// set_state once froze every reader of the machine list).
    #[test]
    fn an_unreachable_server_goes_offline_without_blocking_readers() {
        let rec = ServerRecord { id: "x".into(), name: "nowhere".into(), ssh: "nobody@no-such-host.invalid".into(), command: None, added_at_ms: 0 };
        let l = Arc::new(Link {
            id: "x".into(),
            kind: MachineKind::Server,
            endpoint: Mutex::new(Endpoint::Server(rec)),
            st: Mutex::new(LinkState { state: "connecting".into(), error: None, version: None, grant: None, caps: Vec::new(), tasks: Vec::new(), name: "nowhere".into() }),
            tx: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            term: Mutex::new(None),
            stop: AtomicBool::new(false),
            wake: (Mutex::new(false), Condvar::new()),
            child: Mutex::new(None),
            sock: Mutex::new(None),
        });
        let runner = l.clone();
        std::thread::spawn(move || run_link(runner));
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            // Read on another thread: a reader that blocks must fail the
            // test, not hang it.
            let (tx, rx) = mpsc::channel();
            let reader = l.clone();
            std::thread::spawn(move || {
                let _ = tx.send(reader.view());
            });
            let v = rx.recv_timeout(Duration::from_secs(5)).expect("reading the machine list blocked");
            if v.state == "offline" {
                assert!(v.error.is_some_and(|e| e.contains("no-such-host.invalid")));
                break;
            }
            assert!(std::time::Instant::now() < deadline, "never went offline: {v:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
        l.halt();
    }

    #[test]
    fn a_static_build_is_preferred_and_unknown_systems_have_none() {
        assert_eq!(triples_for("Linux x86_64")[0], "x86_64-unknown-linux-musl");
        assert_eq!(triples_for("Linux aarch64")[0], "aarch64-unknown-linux-musl");
        assert_eq!(triples_for("Darwin arm64"), vec!["aarch64-apple-darwin"]);
        assert!(triples_for("FreeBSD amd64").is_empty());
    }

    /// The whole server path against a real box: probe, install (the same
    /// upload "Install on server" runs), connect over ssh, run a verb.
    /// `TERMIC_TEST_BOX=user@host TERMIC_SERVER_BIN_DIR=<dir with builds>
    /// cargo test real_box -- --ignored`
    #[test]
    #[ignore = "needs a real ssh box: TERMIC_TEST_BOX=user@host"]
    fn real_box_probe_install_connect() {
        let Ok(dest) = std::env::var("TERMIC_TEST_BOX") else { return };
        let p = probe(&dest);
        assert!(p.reached, "{:?} {}", p.error, p.details);
        let version = install(None, &dest).expect("install");
        assert_eq!(probe(&dest).installed.as_deref(), Some(version.as_str()));
        let rec = ServerRecord { id: "t".into(), name: "box".into(), ssh: dest.clone(), command: None, added_at_ms: 0 };
        let ((welcome, mut reader, mut writer), mut child) = connect_server(&rec).expect("connect");
        assert!(matches!(welcome, ServerMsg::Welcome { kind: wire::HostKind::Server, .. }), "{welcome:?}");
        writer.send(&ClientMsg::Call { id: "1".into(), req: serde_json::json!({ "id": "1", "cmd": "project_list" }), proto: None }).unwrap();
        let reply = loop {
            match reader.recv::<ServerMsg>().unwrap().expect("closed") {
                ServerMsg::Reply { reply, .. } => break reply,
                _ => continue,
            }
        };
        assert_eq!(reply["ok"], true, "{reply}");
        let _ = child.kill();
    }

    #[test]
    fn a_server_destination_cannot_smuggle_ssh_options() {
        assert!(add_server("-oProxyCommand=evil", "").is_err());
        assert!(add_server("alice@box and more", "").is_err());
        assert!(add_server("", "").is_err());
    }
}
