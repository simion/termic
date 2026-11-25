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
    /// "connecting" | "online" | "offline" | "disconnected" (switched off).
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
    /// The window label of the profile it belongs to: only that window's
    /// sidebar lists it ("main" for the root profile).
    pub profile: String,
    /// A server's newer termic-server, installed and waiting for a restart.
    pub update: Option<String>,
    /// That update is one this desktop needs: the server restarts onto it
    /// by itself once no agent is mid-turn. Otherwise it is the user's
    /// call (Restart now), and the old build keeps working meanwhile.
    pub update_required: bool,
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
    /// The window (profile) it was added in: its projects go to that
    /// profile (server_projects.rs). None for a server added before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Where the box keeps its repos, for Add project to discover them in
    /// (server_projects.rs server_discover_repos): the server's own
    /// repos_dir, as Settings > General holds this machine's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repos_dir: Option<String>,
}


/// Set (or clear, with an empty string) a server's repos folder.
pub(crate) fn set_server_repos_dir(id: &str, dir: &str) -> Result<(), String> {
    let mut list = load_servers();
    let rec = list.iter_mut().find(|r| r.id == id).ok_or("no such server")?;
    let dir = dir.trim();
    rec.repos_dir = (!dir.is_empty()).then(|| dir.to_string());
    save_servers(&list)
}

fn servers_path() -> Option<PathBuf> {
    crate::global_dir().ok().map(|d| d.join(SERVERS_FILE))
}

/// The profile each paired computer belongs to: the window it was paired
/// from, by machine id. A server keeps its own in servers.json.
const PROFILES_FILE: &str = "machine-profiles.json";

fn profiles_path() -> Option<PathBuf> {
    crate::global_dir().ok().map(|d| d.join(PROFILES_FILE))
}

fn load_machine_profiles() -> HashMap<String, String> {
    profiles_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Record the profile (window label) a paired computer belongs to.
pub(crate) fn set_machine_profile(id: &str, label: &str) -> Result<(), String> {
    let mut m = load_machine_profiles();
    m.insert(id.to_string(), label.to_string());
    let p = profiles_path().ok_or("no data directory")?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    supervise();
    Ok(())
}

/// The window label of the profile a machine belongs to. A server: the
/// profile its projects live in. A paired computer: the window it was
/// paired from; one paired before that was recorded belongs to the root.
fn machine_profile(id: &str, endpoint: &Endpoint) -> String {
    match endpoint {
        Endpoint::Server(_) => crate::server_projects::profile_label(id),
        Endpoint::Peer { .. } => load_machine_profiles().remove(id).unwrap_or_else(|| "main".into()),
    }
}

/// Machines switched off in the sidebar (Disconnect): their row stays, no
/// link runs until switched back on. Ids of servers and paired computers.
const OFF_FILE: &str = "remote-off.json";

fn off_path() -> Option<PathBuf> {
    crate::global_dir().ok().map(|d| d.join(OFF_FILE))
}

pub(crate) fn load_off() -> std::collections::HashSet<String> {
    off_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Switch a machine's link on or off, remembered across restarts.
pub(crate) fn set_connected(id: &str, on: bool) -> Result<(), String> {
    let mut off = load_off();
    if on { off.remove(id); } else { off.insert(id.to_string()); }
    let p = off_path().ok_or("no data directory")?;
    let mut list: Vec<&String> = off.iter().collect();
    list.sort();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    // Flip just this machine's link, now. Not supervise(): it asks pairing
    // for the paired list, which can wait seconds behind a connect that is
    // rediscovering an address, and the switch would lag that long.
    let mut map = links().lock().unwrap();
    if let Some(old) = map.get(id).cloned() {
        if (old.st.lock().unwrap().state == "disconnected") != on {
            return Ok(());
        }
        old.halt();
        let name = old.st.lock().unwrap().name.clone();
        let endpoint = old.endpoint.lock().unwrap().clone();
        map.insert(id.to_string(), new_link(id.to_string(), old.kind, name, endpoint, !on));
    }
    drop(map);
    changed();
    Ok(())
}

/// A server's name for display, by its id (the id itself if unknown).
pub(crate) fn server_name(id: &str) -> String {
    load_servers().into_iter().find(|r| r.id == id).map(|r| r.name).unwrap_or_else(|| id.to_string())
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
        posix(&format!(
            "if [ -x {SERVER_BIN} ]; then exec {SERVER_BIN} bridge; elif command -v termic-server >/dev/null 2>&1; then exec termic-server bridge; else echo 'termic-server is not installed' >&2; exit 127; fi"
        ))
    })
}

/// A POSIX script as the command ssh hands the box's LOGIN shell: run by
/// `sh -c`, since that shell may be fish or csh, which read `if [ ]; then`
/// and `t=~/x` as errors. Single quotes, with `'` as `'\''`, read the same
/// in sh, bash, zsh, fish and csh.
pub(crate) fn posix(script: &str) -> String {
    format!("sh -c '{}'", script.replace('\'', "'\\''"))
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
    /// The window label of the profile it belongs to ("main" for the root).
    profile: String,
    /// A server's newer build, installed and waiting for a restart with
    /// agents running (auto_upgrade).
    update: Option<String>,
    /// The installed update is one this desktop needs (the running server
    /// is older than compat::REQUIRES_SERVER): restart onto it by itself.
    update_required: bool,
    /// The bundled build an upgrade was tried for: once per app run.
    upgrade_tried: Option<String>,
    /// A restart onto `update` was sent; cleared by the next connection.
    restarting: bool,
    /// This connection's first `tasks` snapshot arrived. Until it does,
    /// `tasks` is empty for want of news, not for want of agents, and a
    /// restart then would land mid-turn.
    tasks_seen: bool,
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
            profile: st.profile.clone(),
            update: st.update.clone(),
            update_required: st.update_required,
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
                st.tasks_seen = false;
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
    // A phone's rows for a server project's tasks come from these
    // (remote_server.rs): wake its state loop now rather than on its timer.
    crate::cli_server::global_agent_cache().nudge();
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
    let off = load_off();
    let mut map = links().lock().unwrap();
    let stale: Vec<String> = map.keys().filter(|id| !want.iter().any(|w| &w.0 == *id)).cloned().collect();
    for id in stale {
        if let Some(l) = map.remove(&id) {
            l.halt();
        }
    }
    for (id, kind, name, endpoint) in want {
        // Switched off: a row with no link behind it ("disconnected").
        let is_off = off.contains(&id);
        if let Some(l) = map.get(&id) {
            let was_off = l.st.lock().unwrap().state == "disconnected";
            if was_off == is_off {
                // A rename or an edited server takes effect on the next connect.
                {
                    let mut st = l.st.lock().unwrap();
                    st.name = name;
                    st.profile = machine_profile(&id, &endpoint);
                }
                *l.endpoint.lock().unwrap() = endpoint;
                continue;
            }
            if let Some(l) = map.remove(&id) {
                l.halt();
            }
        }
        map.insert(id.clone(), new_link(id, kind, name, endpoint, is_off));
    }
    drop(map);
    changed();
}

/// A link for a machine: running (its thread started) or switched off (a
/// row with nothing behind it).
fn new_link(id: String, kind: MachineKind, name: String, endpoint: Endpoint, off: bool) -> Arc<Link> {
    let profile = machine_profile(&id, &endpoint);
    let l = Arc::new(Link {
        id,
        kind,
        endpoint: Mutex::new(endpoint),
        st: Mutex::new(LinkState { state: if off { "disconnected" } else { "connecting" }.into(), error: None, version: None, grant: None, caps: Vec::new(), tasks: Vec::new(), name, profile, update: None, update_required: false, upgrade_tried: None, restarting: false, tasks_seen: false }),
        tx: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        term: Mutex::new(None),
        stop: AtomicBool::new(false),
        wake: (Mutex::new(false), Condvar::new()),
        child: Mutex::new(None),
        sock: Mutex::new(None),
    });
    if !off {
        let run = l.clone();
        std::thread::spawn(move || run_link(run));
    }
    l
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
                    st.restarting = false;
                    st.grant = grant;
                    st.caps = caps;
                    // A server names itself; a paired computer keeps the
                    // local name the user gave it.
                    if matches!(endpoint, Endpoint::Server(_)) && st.name.trim().is_empty() {
                        st.name = name;
                    }
                }
                if let Endpoint::Server(rec) = &endpoint {
                    auto_upgrade(&l, rec);
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

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Why this desktop (at `ours`) cannot work with the host it reached, as
/// one sentence with the fix, or None when it can (termic_remote::compat:
/// a minimum per side, not a 1:1 match). A paired computer is checked both
/// ways. A server older than this desktop needs is not refused here: it is
/// upgraded (auto_upgrade). A server newer than this desktop is never
/// downgraded; when it needs a newer desktop, the desktop updates.
fn incompatible(peer: bool, name: &str, version: &str, needs: Option<&str>, ours: &str) -> Option<String> {
    use termic_remote::compat::{at_least, REQUIRES_DESKTOP};
    if let Some(n) = needs.filter(|n| !at_least(ours, n)) {
        let what = if peer { format!("{name} runs Termic {version}") } else { format!("termic-server on {name} is {version}") };
        return Some(format!("{what}, which needs Termic {n} or later here. Update Termic on this computer (it runs {ours})."));
    }
    if peer && !at_least(version, REQUIRES_DESKTOP) {
        return Some(format!("{name} runs Termic {version}, and this Termic needs {REQUIRES_DESKTOP} or later there. Update Termic on {name}."));
    }
    None
}

fn connect(l: &Link, endpoint: &Endpoint) -> Result<Connection, String> {
    match endpoint {
        Endpoint::Peer { id } => {
            let node = crate::peers::node().ok_or("pairing is not running")?;
            let (c, sock) = connect_peer(&node, id, true)?;
            if let ServerMsg::Welcome { name, version, needs, .. } = &c.0 {
                if let Some(why) = incompatible(true, name, version, needs.as_deref(), APP_VERSION) {
                    let _ = sock.shutdown(std::net::Shutdown::Both);
                    return Err(why);
                }
            }
            *l.sock.lock().unwrap() = Some(sock);
            Ok(c)
        }
        Endpoint::Server(rec) => {
            let (c, mut child) = connect_server(rec)?;
            if let ServerMsg::Welcome { name, version, needs, .. } = &c.0 {
                if let Some(why) = incompatible(false, name, version, needs.as_deref(), APP_VERSION) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(why);
                }
            }
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
    // The first address that answers goes first: a Mac also advertises
    // virtual bridges (OrbStack, VPNs) nobody else can reach, and trying
    // them in turn cost a full CONNECT_TIMEOUT each before the LAN address.
    let mut order = ep.addrs.clone();
    if let Some(first) = first_reachable(&ep.addrs) {
        order.retain(|a| *a != first);
        order.insert(0, first);
    }
    for addr in order.iter() {
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

/// The first of `addrs` to accept a TCP connection, all tried at once.
fn first_reachable(addrs: &[SocketAddr]) -> Option<SocketAddr> {
    if addrs.len() < 2 {
        return addrs.first().copied();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    for a in addrs.iter().copied() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            if TcpStream::connect_timeout(&a, CONNECT_TIMEOUT).is_ok() {
                let _ = tx.send(a);
            }
        });
    }
    drop(tx);
    rx.recv_timeout(CONNECT_TIMEOUT + Duration::from_millis(500)).ok()
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
        // The machine is the host part: "alice@" is who to log in as.
        let host = dest.rsplit('@').next().unwrap_or(dest);
        format!("No machine called {host} could be found. Check the name, or use its IP address.")
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
    reattach_ptys(l);
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
    // A box that keeps PTYs (`pty_keep`) still runs them: the next
    // connection attaches (reattach_ptys). An older one hung them up.
    if !l.st.lock().unwrap().caps.iter().any(|c| c == wire::caps::PTY_KEEP) {
        let gone: Vec<String> = ptys().lock().unwrap().iter().filter(|(_, p)| p.machine == l.id).map(|(id, _)| id.clone()).collect();
        for pid in gone {
            pty_event(&pid, PtyEvent::Exit("disconnected".into()));
        }
    }
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
            let (differs, first) = {
                let mut st = l.st.lock().unwrap();
                let first = !std::mem::replace(&mut st.tasks_seen, true);
                if st.tasks == tasks {
                    (false, first)
                } else {
                    st.tasks = tasks;
                    (true, first)
                }
            };
            if first && !differs {
                restart_when_settled(l);
            }
            if differs {
                restart_when_settled(l);
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
        ServerMsg::PtyData { pid, data, at } => {
            let Some(bytes) = termic_remote::unb64(&data) else { return };
            // A backlog (`at` set) is for the handles still waiting for one;
            // live output for every handle on the claim.
            let targets: Vec<String> = {
                let mut map = ptys().lock().unwrap();
                map.iter_mut()
                    .filter(|(_, p)| p.machine == l.id && p.remote == pid && (at.is_none() || p.wants_backlog))
                    .map(|(id, p)| {
                        p.seen = at.unwrap_or(p.seen) + bytes.len() as u64;
                        if at.is_some() {
                            p.wants_backlog = false;
                        }
                        id.clone()
                    })
                    .collect()
            };
            if !bytes.is_empty() {
                for local in targets {
                    pty_event(&local, PtyEvent::Data(bytes.clone()));
                }
            }
        }
        ServerMsg::PtyExit { pid, reason } => {
            for local in local_ids(&l.id, &pid) {
                pty_event(&local, PtyEvent::Exit(reason.clone()));
            }
        }
        ServerMsg::Error { message } => dlog(&format!("[remote] {}: {message}", l.id)),
        // The keepalive's answer: a project added on the box some other way
        // (the CLI there) changes no task row, so resync now and then.
        ServerMsg::Pong {} if l.kind == MachineKind::Server => crate::server_projects::sync_if_stale(&l.id),
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
    // Adding or removing a project changes no task row, so the box's task
    // list (what triggers a resync) does not move: resync after it here.
    let projects_changed = l.kind == MachineKind::Server
        && req.get("cmd").and_then(Value::as_str).is_some_and(|c| c.starts_with("project_"));
    let answer = l.request(&id, ClientMsg::Call { id: id.clone(), req, proto }, timeout.unwrap_or(CALL_TIMEOUT))?;
    if projects_changed {
        crate::server_projects::sync_soon(machine);
    }
    match answer {
        ServerMsg::Reply { reply, .. } => Ok(reply),
        _ => Err("unexpected answer".into()),
    }
}

pub(crate) fn term_open(machine: &str, task: &str, tab: Option<String>, sink: TermSink) -> Result<(), String> {
    let l = link(machine)?;
    *l.term.lock().unwrap() = Some(sink);
    l.send(ClientMsg::TermOpen { task: task.into(), tab })
}

// ─────────────── extra PTYs on a server (shells, scripts) ───────────────

pub(crate) enum PtyEvent {
    Data(Vec<u8>),
    Exit(String),
}

type PtySink = Box<dyn Fn(&str, PtyEvent) + Send + Sync>;

/// A server PTY, by the desktop's pty id. Output is held until the pane
/// says it listens (`pty_attached`), as lib.rs does for a local PTY:
/// a fast link could otherwise deliver the first prompt to nobody.
struct RemotePty {
    machine: String,
    /// Its id on the box: the stable claim (`<task>:agent`, `<task>:<tab>`)
    /// that a second open attaches to. This desktop's own id (the map key,
    /// the `pty://` event name) is unique per spawn: a handle on the claim.
    /// Several handles may share one claim for a moment (the webview's kill
    /// of an old spawn races its respawn, a cancelled spawn); the box's PTY
    /// ends only when the last handle is killed.
    remote: String,
    /// The backlog of the next attach is for this handle (a fresh one, or
    /// every one after a reconnect); live output goes to all of them.
    wants_backlog: bool,
    attached: bool,
    held: Vec<u8>,
    exit: Option<String>,
    /// Bytes of its output received so far: what a reattach skips.
    seen: u64,
    /// (cols, rows) last asked for, to size it again on a reattach.
    size: (u16, u16),
}

/// Held output kept per unattached PTY, at most.
const HELD_MAX: usize = 1 << 20;

fn ptys() -> &'static Mutex<HashMap<String, RemotePty>> {
    static P: OnceLock<Mutex<HashMap<String, RemotePty>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn pty_sink() -> &'static OnceLock<PtySink> {
    static S: OnceLock<PtySink> = OnceLock::new();
    &S
}

/// Where a server PTY's output and exit go (lib.rs: the `pty://` events).
pub(crate) fn set_pty_sink(f: PtySink) {
    let _ = pty_sink().set(f);
}

fn emit_pty(pid: &str, e: PtyEvent) {
    if let Some(f) = pty_sink().get() {
        f(pid, e);
    }
}

fn pty_event(pid: &str, e: PtyEvent) {
    let mut map = ptys().lock().unwrap();
    let Some(p) = map.get_mut(pid) else { return };
    if !p.attached {
        match e {
            PtyEvent::Data(d) => {
                if p.held.len() + d.len() <= HELD_MAX {
                    p.held.extend_from_slice(&d);
                }
            }
            PtyEvent::Exit(r) => p.exit = Some(r),
        }
        return;
    }
    if matches!(e, PtyEvent::Exit(_)) {
        map.remove(pid);
    }
    drop(map);
    emit_pty(pid, e);
}

/// The pane listens now: deliver what was held. True if `pid` is a server PTY.
pub(crate) fn pty_attached(pid: &str) -> bool {
    let (held, exit) = {
        let mut map = ptys().lock().unwrap();
        let Some(p) = map.get_mut(pid) else { return false };
        p.attached = true;
        let out = (std::mem::take(&mut p.held), p.exit.take());
        if out.1.is_some() {
            map.remove(pid);
        }
        out
    };
    if !held.is_empty() {
        emit_pty(pid, PtyEvent::Data(held));
    }
    if let Some(r) = exit {
        emit_pty(pid, PtyEvent::Exit(r));
    }
    true
}

/// This desktop's handles on the PTY a box knows as `remote`.
fn local_ids(machine: &str, remote: &str) -> Vec<String> {
    ptys().lock().unwrap().iter().filter(|(_, p)| p.machine == machine && p.remote == remote).map(|(id, _)| id.clone()).collect()
}

/// Start a program on a PTY on a server, `argv` empty for its login shell,
/// as `remote` there and `pid` here (a handle). An open of a claim that is
/// already running on the box attaches to it instead of starting a second
/// process; a second handle here asks the box for the backlog again, which
/// only it draws.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pty_open(machine: &str, pid: &str, remote: &str, cwd: &str, argv: Vec<String>, env: Vec<(String, String)>, cols: u16, rows: u16) -> Result<(), String> {
    let l = link(machine)?;
    if !l.st.lock().unwrap().caps.iter().any(|c| c == wire::caps::PTY) {
        return Err(format!("{} runs an older termic-server without terminals: update it from Settings, Servers", server_name(machine)));
    }
    let shared = {
        let mut map = ptys().lock().unwrap();
        let shared = map.values().any(|p| p.machine == machine && p.remote == remote && p.exit.is_none());
        map.insert(pid.to_string(), RemotePty { machine: machine.to_string(), remote: remote.to_string(), wants_backlog: true, attached: false, held: Vec::new(), exit: None, seen: 0, size: (cols, rows) });
        shared
    };
    // Shared: attach only (`seen` 0, the whole ring), never a second start.
    let seen = if shared { Some(0) } else { None };
    l.send(ClientMsg::PtyOpen { pid: remote.into(), cwd: cwd.into(), argv, env, cols, rows, seen }).inspect_err(|_| {
        ptys().lock().unwrap().remove(pid);
    })
}

/// A new connection to a box: attach again to the PTYs this desktop had
/// open there, once per claim, asking only for the output its handles have
/// not seen. A box that keeps none (older, or restarted) answers with
/// `pty_exit`.
fn reattach_ptys(l: &Link) {
    let keeps = l.st.lock().unwrap().caps.iter().any(|c| c == wire::caps::PTY_KEEP);
    // Terminals closed here while the box was away: end them there now,
    // unless one was opened again under the same claim meanwhile.
    let killed = pending_kills().lock().unwrap().remove(&l.id).unwrap_or_default();
    for remote in killed {
        if !ptys().lock().unwrap().values().any(|p| p.machine == l.id && p.remote == remote && p.exit.is_none()) {
            let _ = l.send(ClientMsg::PtyKill { pid: remote });
        }
    }
    let mut claims: Vec<(String, u64, (u16, u16))> = Vec::new();
    {
        let mut map = ptys().lock().unwrap();
        for p in map.values_mut().filter(|p| p.machine == l.id && p.exit.is_none()) {
            p.wants_backlog = true;
            match claims.iter_mut().find(|(r, _, _)| *r == p.remote) {
                Some(c) => c.1 = c.1.min(p.seen),
                None => claims.push((p.remote.clone(), p.seen, p.size)),
            }
        }
    }
    for (remote, seen, (cols, rows)) in claims {
        let sent = keeps && l.send(ClientMsg::PtyOpen { pid: remote.clone(), cwd: String::new(), argv: Vec::new(), env: Vec::new(), cols, rows, seen: Some(seen) }).is_ok();
        if !sent {
            for pid in local_ids(&l.id, &remote) {
                pty_event(&pid, PtyEvent::Exit("disconnected".into()));
            }
        }
    }
}

/// The server a desktop pty id runs on, if it is a server PTY.
pub(crate) fn pty_machine(pid: &str) -> Option<String> {
    ptys().lock().unwrap().get(pid).map(|p| p.machine.clone())
}

fn remote_of(pid: &str) -> Option<(String, String)> {
    ptys().lock().unwrap().get(pid).map(|p| (p.machine.clone(), p.remote.clone()))
}

pub(crate) fn pty_input(pid: &str, data: &[u8]) -> Result<(), String> {
    let Some((machine, remote)) = remote_of(pid) else { return Ok(()) };
    link(&machine)?.send(ClientMsg::PtyInput { pid: remote, data: termic_remote::b64(data) })
}

pub(crate) fn pty_resize(pid: &str, cols: u16, rows: u16) -> Result<(), String> {
    let Some((machine, remote)) = remote_of(pid) else { return Ok(()) };
    if let Some(p) = ptys().lock().unwrap().get_mut(pid) {
        p.size = (cols, rows);
    }
    link(&machine)?.send(ClientMsg::PtyResize { pid: remote, cols, rows })
}

/// How long the box's PTY outlives its last handle's kill, for a spawn under
/// the same claim to attach instead. A terminal pane's spawn effect kills and
/// respawns on a re-run (a rename re-runs it): without this, that re-run
/// would end a server agent the user never asked to stop.
const KILL_GRACE: Duration = Duration::from_millis(1500);

/// Drop a handle; the box's PTY ends with the last one. A kill that races a
/// respawn (the webview does not await it) or a cancelled spawn leaves the
/// other handle, and with it the running process, alone; a spawn under the
/// same claim within `KILL_GRACE` of the last kill attaches to it.
pub(crate) fn pty_kill(pid: &str) -> Result<(), String> {
    let Some((machine, remote)) = remote_of(pid) else { return Ok(()) };
    let still_held = |map: &HashMap<String, RemotePty>| map.values().any(|p| p.machine == machine && p.remote == remote);
    {
        let mut map = ptys().lock().unwrap();
        map.remove(pid);
        if still_held(&map) {
            return Ok(());
        }
    }
    std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        if ptys().lock().unwrap().values().any(|p| p.machine == machine && p.remote == remote) {
            return;
        }
        // Offline: the box's PTY would run on with nobody left who knows it.
        // The next connection sends the kill (reattach_ptys).
        if link(&machine).and_then(|l| l.send(ClientMsg::PtyKill { pid: remote.clone() })).is_err() {
            pending_kills().lock().unwrap().entry(machine).or_default().insert(remote);
        }
    });
    Ok(())
}

/// Kills that could not reach their box (it was offline), by machine, sent
/// when it is back.
fn pending_kills() -> &'static Mutex<HashMap<String, std::collections::HashSet<String>>> {
    static K: std::sync::OnceLock<Mutex<HashMap<String, std::collections::HashSet<String>>>> = std::sync::OnceLock::new();
    K.get_or_init(Default::default)
}

/// A message that answers by id (a transcript, keys or an interrupt with an
/// id): its answer, or why there was none.
pub(crate) fn ask(machine: &str, id: &str, msg: ClientMsg, timeout: Duration) -> Result<ServerMsg, String> {
    link(machine)?.request(id, msg, timeout)
}

/// A fresh correlation id for `ask`.
pub(crate) fn fresh_id() -> String {
    next_id()
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

#[cfg(test)]
pub(crate) fn add_server(ssh: &str, name: &str) -> Result<ServerRecord, String> {
    add_server_in(ssh, name, None)
}

/// `add_server`, remembering the window (profile) it was added from.
pub(crate) fn add_server_in(ssh: &str, name: &str, profile: Option<String>) -> Result<ServerRecord, String> {
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
        profile,
        repos_dir: None,
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
    // Its projects and their task records leave this machine's store too
    // (the box keeps its worktrees; adding the server back mirrors them).
    crate::server_projects::forget_server(id);
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

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub(crate) fn init(app: tauri::AppHandle) {
    use tauri::Emitter;
    let _ = APP.set(app.clone());
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
pub(crate) async fn remote_set_connected(machine: String, on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_connected(&machine, on)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn remote_reconnect() {
    nudge();
}

#[tauri::command]
pub(crate) async fn server_add(window: tauri::Window, ssh: String, name: String) -> Result<ServerRecord, String> {
    let profile = Some(window.label().to_string());
    tauri::async_runtime::spawn_blocking(move || add_server_in(&ssh, &name, profile)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn server_remove(id: String) -> Result<(), String> {
    // Off the main thread: on a server project this is an ssh round trip.
    tauri::async_runtime::spawn_blocking(move || {
    remove_server(&id)
}).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn server_rename(id: String, name: String) -> Result<(), String> {
    // Off the main thread: on a server project this is an ssh round trip.
    tauri::async_runtime::spawn_blocking(move || {
    rename_server(&id, &name)
}).await.map_err(|e| e.to_string())?
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
    let out = match ssh_command(dest).arg(posix(PROBE_SCRIPT)).stdin(Stdio::null()).output() {
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
/// "yes" at ssh's own prompt would, but only the key the user was shown.
/// The fingerprint came from a separate scan; a connection that offered a
/// different key (another type, or someone in the middle of this one
/// connection only) must not be trusted under it. So ssh records the key
/// into a throwaway file first, its fingerprint is compared with `shown`,
/// and only then is that entry added to the real known_hosts.
pub(crate) fn trust(dest: &str, shown: Option<&str>) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("termic-trust-{}-{}", std::process::id(), next_id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let scratch = dir.join("known_hosts");
    let result = (|| {
        let out = tool("ssh")
            .args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8"])
            .arg("-o").arg(format!("UserKnownHostsFile={}", scratch.display()))
            .args(["-o", "GlobalKnownHostsFile=/dev/null", "--", dest, "true"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| ssh_missing(&e))?;
        if !out.status.success() {
            return Err(explain_ssh(dest, out.status.code(), &String::from_utf8_lossy(&out.stderr)));
        }
        let entry = std::fs::read_to_string(&scratch).map_err(|e| format!("could not read the server's key ({e})"))?;
        if let Some(shown) = shown {
            let fp = tool("ssh-keygen").arg("-lf").arg(&scratch).output().map_err(|e| e.to_string())?;
            let fp = String::from_utf8_lossy(&fp.stdout);
            let want = shown.split_whitespace().next().unwrap_or(shown);
            if !fp.split_whitespace().any(|w| w == want) {
                return Err(format!("{dest} offered a different key than the one shown ({want}). Not trusted: check it from the server's own console."));
            }
        }
        let home = dirs::home_dir().ok_or("no home directory")?;
        let ssh_dir = home.join(".ssh");
        std::fs::create_dir_all(&ssh_dir).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(ssh_dir.join("known_hosts")).map_err(|e| e.to_string())?;
        io::Write::write_all(&mut f, entry.as_bytes()).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
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
                // Alone: a test that names its builds gets exactly those,
                // never whatever a local release build left in resources.
                return vec![PathBuf::from(d)];
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

/// The version of the builds this Termic carries
/// (scripts/build-termic-server.mjs writes it next to them). None when it
/// carries none, or builds from before versions were written.
fn bundled_version(app: Option<&tauri::AppHandle>) -> Option<String> {
    binary_dirs(app).iter().find_map(|d| std::fs::read_to_string(d.join("termic-server-version.txt")).ok()).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

#[derive(Debug, PartialEq)]
enum Upgrade {
    /// Already the carried build, or newer than it (another desktop on a
    /// newer Termic put it there): never downgraded.
    None,
    /// Older than the carried build but still works with this desktop:
    /// installed quietly, restarted when the user chooses.
    Optional,
    /// Older than this desktop needs (compat::REQUIRES_SERVER), or a
    /// version it cannot read: installed, then restarted by itself once no
    /// agent is mid-turn.
    Required,
}

/// What to do about a server running `have` when this desktop carries
/// `want` and needs at least `floor`. Versions compare by
/// `major.minor.patch`; the same core with a different build hash is a
/// different build of the same release (a dev build), replaced quietly.
fn upgrade_plan(have: &str, want: &str, floor: &str) -> Upgrade {
    use termic_remote::compat::{at_least, core};
    if have == want {
        return Upgrade::None;
    }
    if !at_least(have, floor) {
        return Upgrade::Required;
    }
    match (core(have), core(want)) {
        (Some(h), Some(w)) if h > w => Upgrade::None,
        _ => Upgrade::Optional,
    }
}

/// On connecting to a server: bring its termic-server up to the build this
/// app carries when it is older (upgrade_plan), never down. The new build
/// is copied over ssh (the running daemon keeps going on the old file).
/// One this desktop needs restarts the daemon by itself once no agent is
/// mid-turn (restart_when_settled); any other waits for the user's Restart
/// now, or the server's next restart. A server started with its own
/// command is the user's to manage.
fn auto_upgrade(l: &Arc<Link>, rec: &ServerRecord) {
    if rec.command.is_some() {
        return;
    }
    let Some(want) = bundled_version(APP.get()) else { return };
    let required = {
        let mut st = l.st.lock().unwrap();
        let plan = upgrade_plan(st.version.as_deref().unwrap_or(""), &want, termic_remote::compat::REQUIRES_SERVER);
        if plan == Upgrade::None {
            st.update = None;
            st.update_required = false;
            return;
        }
        if st.update.as_deref() == Some(want.as_str()) || st.upgrade_tried.as_deref() == Some(want.as_str()) {
            return;
        }
        st.upgrade_tried = Some(want.clone());
        plan == Upgrade::Required
    };
    let (l, dest) = (l.clone(), rec.ssh.clone());
    // Off the link's thread: the session starts at once, the upload beside it.
    std::thread::spawn(move || {
        match install(APP.get(), &dest) {
            Ok(v) if v == want => {}
            Ok(v) => {
                eprintln!("[remote] {dest}: installed termic-server {v}, expected {want}");
                return;
            }
            Err(e) => {
                eprintln!("[remote] {dest}: could not upgrade termic-server: {e}");
                return;
            }
        }
        {
            let mut st = l.st.lock().unwrap();
            st.update = Some(want);
            st.update_required = required;
        }
        changed();
        restart_when_settled(&l);
    });
}

/// With a required update installed, restart the server onto it as soon
/// as no agent is mid-turn (working, or waiting on a question): the agents
/// come back in their sessions, so a settled one loses nothing. Called
/// after the install and on every change to the server's task rows.
fn restart_when_settled(l: &Link) {
    {
        let mut st = l.st.lock().unwrap();
        if st.update.is_none() || !st.update_required || st.restarting || !st.tasks_seen || st.tasks.iter().any(|t| t.state == "working" || t.state == "waiting") {
            return;
        }
        st.restarting = true;
    }
    let id = l.id.clone();
    std::thread::spawn(move || {
        if let Err(e) = restart_server(&id) {
            eprintln!("[remote] {id}: could not restart termic-server: {e}");
            if let Ok(l) = link(&id) {
                l.st.lock().unwrap().restarting = false;
            }
        }
    });
}

/// Restart a server's daemon onto the installed build: `quit`, which stops
/// its agents noting them for the next daemon to resume. A daemon from
/// before `quit` existed refuses it (unknown or unsupported): it is stopped over the
/// same ssh the install used instead (`termic-server stop`), and the next
/// connection's `bridge` starts the new binary. That one-time migration
/// cannot resume its agents (the old daemon records none); they resume when
/// their tasks are opened, as after any desktop restart.
pub(crate) fn restart_server(id: &str) -> Result<(), String> {
    let r = call(id, serde_json::json!({ "cmd": "quit", "commit": true }), None)?;
    if r.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let msg = r.pointer("/error/message").and_then(Value::as_str).unwrap_or_default().to_string();
    // Older daemons say so either way: serde's "unknown variant", or a
    // catch-all Unsupported reply.
    let unsupported = r.pointer("/error/code").and_then(Value::as_str) == Some("unsupported");
    if !unsupported && !msg.contains("unknown variant") {
        return Err(msg);
    }
    let dest = match &*link(id)?.endpoint.lock().unwrap() {
        Endpoint::Server(rec) if rec.command.is_none() => rec.ssh.clone(),
        _ => return Err(msg),
    };
    let out = ssh_command(&dest).arg(posix("~/.termic/bin/termic-server stop")).output().map_err(|e| ssh_missing(&e))?;
    if !out.status.success() {
        return Err(format!("could not stop the old termic-server: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    // The link notices the daemon gone and reconnects through `bridge`.
    if let Ok(l) = link(id) {
        if let Some(mut c) = l.child.lock().unwrap().take() {
            let _ = c.kill();
        }
    }
    Ok(())
}

/// Restart now, from a server's row: `restart_server` off the IPC thread.
#[tauri::command]
pub(crate) async fn server_restart(machine: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || restart_server(&machine)).await.map_err(|e| e.to_string())?
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
        .arg(posix(script))
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
pub(crate) async fn server_trust(ssh: String, fingerprint: Option<String>) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || trust(&ssh, fingerprint.as_deref()).map(|_| probe(&ssh))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn server_install(app: tauri::AppHandle, ssh: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install(Some(&app), &ssh)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_address_that_answers_wins_over_one_that_does_not() {
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let good = open.local_addr().unwrap();
        // 10.255.255.1 is routable and silent: a connect there waits it out.
        let dead: std::net::SocketAddr = "10.255.255.1:9".parse().unwrap();
        let t0 = std::time::Instant::now();
        assert_eq!(super::first_reachable(&[dead, good]), Some(good));
        assert!(t0.elapsed() < super::CONNECT_TIMEOUT, "it waited for the dead address");
    }


    #[test]
    fn a_posix_script_survives_any_login_shell_quoting() {
        let script = "echo 'a b'; t=~/x";
        let wrapped = super::posix(script);
        assert_eq!(wrapped, "sh -c 'echo '\\''a b'\\''; t=~/x'");
        // What sh makes of it is the script itself (no /bin/sh on Windows,
        // where the string above is still what goes to the box).
        #[cfg(unix)]
        let out = std::process::Command::new("/bin/sh").args(["-c", &format!("printf %s {}", &wrapped[6..])]).output().unwrap();
        #[cfg(unix)]
        assert_eq!(String::from_utf8(out.stdout).unwrap(), script);
    }
    use super::*;

    #[test]
    fn a_server_is_upgraded_only_when_older_and_restarted_only_when_needed() {
        let floor = "1.25.0";
        let want = "1.27.0+bbb";
        assert_eq!(upgrade_plan(want, want, floor), Upgrade::None);
        // Newer than the carried build: another desktop's; never downgraded.
        assert_eq!(upgrade_plan("1.28.0+ccc", want, floor), Upgrade::None);
        // Older but still works: quiet.
        assert_eq!(upgrade_plan("1.25.0+aaa", want, floor), Upgrade::Optional);
        assert_eq!(upgrade_plan("1.26.3", want, floor), Upgrade::Optional);
        // Same release, another build (dev): quiet.
        assert_eq!(upgrade_plan("1.27.0+aaa", want, floor), Upgrade::Optional);
        // Below the floor, or unreadable: required.
        assert_eq!(upgrade_plan("1.24.9+aaa", want, floor), Upgrade::Required);
        assert_eq!(upgrade_plan("0-old", want, floor), Upgrade::Required);
        assert_eq!(upgrade_plan("", want, floor), Upgrade::Required);
    }

    #[test]
    fn versions_that_cannot_work_together_say_which_side_to_update() {
        // A host needing a newer desktop: update this one.
        let e = incompatible(true, "Laptop", "1.30.0", Some("1.29.0"), "1.28.0").unwrap();
        assert!(e.contains("Update Termic on this computer") && e.contains("1.29.0"), "{e}");
        let e = incompatible(false, "box", "1.30.0+x", Some("1.29.0"), "1.28.0").unwrap();
        assert!(e.starts_with("termic-server on box is 1.30.0+x"), "{e}");
        // A paired computer older than this desktop needs: update that one.
        let old = "0.0.1";
        let e = incompatible(true, "Laptop", old, None, "9.0.0").unwrap();
        assert!(e.contains("Update Termic on Laptop"), "{e}");
        // An old server is upgraded, not refused.
        assert_eq!(incompatible(false, "box", old, None, "9.0.0"), None);
        assert_eq!(incompatible(true, "Laptop", APP_VERSION, Some(APP_VERSION), APP_VERSION), None);
    }

    #[test]
    fn this_build_works_with_itself() {
        use termic_remote::compat::{at_least, REQUIRES_DESKTOP, REQUIRES_SERVER};
        assert!(at_least(APP_VERSION, REQUIRES_SERVER), "REQUIRES_SERVER {REQUIRES_SERVER} is above this app's {APP_VERSION}");
        assert!(at_least(APP_VERSION, REQUIRES_DESKTOP), "REQUIRES_DESKTOP {REQUIRES_DESKTOP} is above this app's {APP_VERSION}");
    }

    #[test]
    fn a_server_pty_holds_its_output_until_the_pane_listens() {
        static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
        set_pty_sink(Box::new(|pid, e| {
            SEEN.lock().unwrap().push(match e {
                PtyEvent::Data(d) => format!("{pid} data {}", String::from_utf8_lossy(&d)),
                PtyEvent::Exit(r) => format!("{pid} exit {r}"),
            });
        }));
        let mine = |p: &str| SEEN.lock().unwrap().iter().filter(|l| l.starts_with(p)).cloned().collect::<Vec<_>>();
        ptys().lock().unwrap().insert("held-1".into(), RemotePty { machine: "m".into(), remote: "r".into(), wants_backlog: false, attached: false, held: Vec::new(), exit: None, seen: 0, size: (80, 24) });
        pty_event("held-1", PtyEvent::Data(b"$ ".to_vec()));
        pty_event("held-1", PtyEvent::Data(b"hi".to_vec()));
        pty_event("held-1", PtyEvent::Exit("exited".into()));
        assert!(mine("held-1").is_empty(), "nothing goes out before the pane listens");
        assert!(pty_attached("held-1"));
        assert_eq!(mine("held-1"), ["held-1 data $ hi", "held-1 exit exited"]);
        assert!(pty_machine("held-1").is_none(), "an exited PTY is forgotten");
        // Attached: output flows straight through.
        ptys().lock().unwrap().insert("live-1".into(), RemotePty { machine: "m".into(), remote: "r".into(), wants_backlog: false, attached: true, held: Vec::new(), exit: None, seen: 0, size: (80, 24) });
        pty_event("live-1", PtyEvent::Data(b"x".to_vec()));
        assert_eq!(mine("live-1"), ["live-1 data x"]);
        assert!(!pty_attached("not-a-server-pty"));
    }

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
        // The machine is the host, not the login: "alice@" is left out.
        let s = explain_ssh("alice@nope.example", Some(255), "ssh: Could not resolve hostname nope.example: x");
        assert!(s.contains("No machine called nope.example ") && !s.contains("alice@"), "{s}");
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
        let rec = ServerRecord { id: "x".into(), name: "nowhere".into(), ssh: "nobody@no-such-host.invalid".into(), command: None, added_at_ms: 0, profile: None, repos_dir: None };
        let l = Arc::new(Link {
            id: "x".into(),
            kind: MachineKind::Server,
            endpoint: Mutex::new(Endpoint::Server(rec)),
            st: Mutex::new(LinkState { state: "connecting".into(), error: None, version: None, grant: None, caps: Vec::new(), tasks: Vec::new(), name: "nowhere".into(), profile: "main".into(), update: None, update_required: false, upgrade_tried: None, restarting: false, tasks_seen: false }),
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
        let rec = ServerRecord { id: "t".into(), name: "box".into(), ssh: dest.clone(), command: None, added_at_ms: 0, profile: None, repos_dir: None };
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
