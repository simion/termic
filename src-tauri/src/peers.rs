//! LAN pairing (docs/peers.md): Termic on two machines of one network
//! finding each other, pairing with a code both people confirm, and then
//! letting an agent on one drive (or report back to) the agents on the other.
//!
//! The pieces, in the order a request meets them:
//!
//! - **Discovery** is `mdns.rs` (`_termic._tcp`). It only finds; nothing it
//!   says is trusted, and pairing works without it (pair by address).
//! - **The peer listener** is one TCP port on every interface, bound only
//!   while LAN sharing is on (Settings > Agent access). Its surface:
//!   `hello` (what the advertisement already says), the three pairing steps,
//!   and two SEALED endpoints, `call` and `unpair`. An unpaired machine gets
//!   the first four and nothing else: it can ask to pair, which puts a dialog
//!   in front of a person, and it can never run a verb.
//! - **Pairing** is X25519 with a committed nonce (`peer_crypto.rs`), ending
//!   in a per-pair 256-bit key both apps store and nobody types.
//! - **Calls** are the CLI's own `Request`, sealed with that key
//!   (ChaCha20-Poly1305, one key per direction, a timestamp and a request id
//!   against replay), dispatched through `cli_server::dispatch_authenticated`
//!   exactly like the socket and MCP do. A peer is a third presentation of
//!   the same verbs, never a second implementation.
//! - **The grant** decides what a paired machine may do HERE: reply into a
//!   task that contacted it, or drive agents. Each side sets its own.
//!
//! Agents never hold a peer credential. `termic --peer <name> <verb>` and
//! MCP `peer_call` both reach THIS app, which forwards; the key stays here.
//!
//! Threads: the accept loop and one thread per connection, as in
//! mcp_server.rs; one discovery thread in mdns.rs. Every wait is a blocking
//! read, a channel or a condvar with a deadline (CLAUDE.md, no sleep-polls).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use termic_proto as proto;
use termic_proto::{Command, ErrorCode, Reply, ReplyData, Request, StreamEvent};

use crate::cli_server::{CliHost, EventSink};
use crate::peer_crypto as pc;
use crate::{dlog, mdns};

/// The peer protocol (this file's wire), separate from the CLI protocol it
/// carries. Two machines on different peer protocols cannot pair at all;
/// two on different CLI protocols can pair but not call each other.
pub(crate) const PV: u32 = 2;
const PREFIX: &str = "/termic-peer/v1";
pub(crate) const PEERS_FILE: &str = "peers.json";

/// Where the listener's port is picked from: below every platform's dynamic
/// range (Hyper-V reserves blocks inside it on Windows, docs/windows.md) and
/// clear of the MCP range just under it.
const AUTO_PORTS: std::ops::RangeInclusive<u16> = 23620..=23719;
/// How many of those "pair by address" tries when no port is given. Every
/// instance on a machine takes the first free one, so the first few cover
/// a release, a beta and a dev build side by side.
const ADDRESS_PROBE_PORTS: u16 = 6;

/// A pairing that nobody finished is gone after this.
/// How long pairing mode stays open: long enough to walk to the other
/// computer and type the code.
const PAIR_MODE_TTL: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 300 });
/// Between an incoming start and its confirm.
const INCOMING_TTL: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 30 });
/// Wrong codes before pairing mode closes and the person has to reopen it
/// (with a new code). See `pc::CODE_DIGITS` for the odds.
const MAX_WRONG_CODES: u8 = 3;
/// A sealed message older or newer than this is refused (clock skew
/// between two machines' NTP is seconds; five minutes is generous).
const FRESH_WINDOW_MS: i64 = 300_000;
/// Seen on the network this recently = online.
const ONLINE_WINDOW: Duration = Duration::from_secs(180);
/// After someone declines a request from an address, further requests from
/// it are refused for this long, so a neighbour cannot keep a dialog up.
/// After a wrong code, that address waits this long before the next try.
const WRONG_CODE_COOLDOWN: Duration = Duration::from_millis(if cfg!(test) { 0 } else { 2000 });
/// How soon one address may ask to pair again: a click that went through
/// already put the code on the other screen, so a second one is noise, and
/// a script cannot make another machine's screen flash codes.
const REQUEST_COOLDOWN: Duration = Duration::from_millis(if cfg!(any(test, feature = "e2e")) { 0 } else { 5000 });
/// Tasks per peer that may be replied into (oldest dropped first).
const MAX_CONTACTS: usize = 200;

const MAX_BODY: usize = 4 * 1024 * 1024;
/// A reply carries `task_diff --full` and log tails: generous, but bounded.
const MAX_RESPONSE: u64 = 64 * 1024 * 1024;
const MAX_HEAD: u64 = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(if cfg!(test) { 500 } else { 3000 });
/// A quick call's reply budget. Long ones (waits, archive) get their own.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// The slowest verb a peer can run: archive scripts, a big worktree add.
const SLOW_CALL_TIMEOUT: Duration = Duration::from_secs(330);
const HEARTBEAT_EVERY: Duration = Duration::from_millis(if cfg!(test) { 50 } else { 10_000 });

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// An Instant from the past, as wall-clock milliseconds.
fn instant_ms(t: Instant) -> i64 {
    now_ms() - t.elapsed().as_millis() as i64
}

/// Longest note a paired machine keeps, in characters.
const NOTE_MAX: usize = 200;

// ───────────────────────────── grant ─────────────────────────────────

/// What a paired machine may do on THIS one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Grant {
    /// Send a prompt to a task here that has itself contacted that machine:
    /// the worker reporting back to its orchestrator, and nothing else.
    #[default]
    Reply,
    /// Every verb an MCP client has, minus the few in `DRIVE_DENIED`. This
    /// is running code here: the peer can start an agent with any prompt.
    Drive,
}

impl Grant {
    pub(crate) fn parse(s: &str) -> Option<Grant> {
        match s.trim().to_ascii_lowercase().as_str() {
            "reply" => Some(Grant::Reply),
            "drive" => Some(Grant::Drive),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Grant::Reply => "reply",
            Grant::Drive => "drive",
        }
    }
}

/// Why a verb is refused to a peer even with Drive. Quitting kills every
/// agent here; attach is a live stream with no place on a request/reply
/// hop; adding or removing projects reaches outside the folders the user
/// already chose to give agents; and a peer may not pair, unpair or rename
/// on this machine's behalf, nor chain a call on to a third machine.
fn drive_denied(cmd: &Command) -> Option<&'static str> {
    Some(match cmd {
        Command::Quit { .. } => "quit",
        Command::Attach { .. } => "attach",
        Command::ProjectAdd { .. } => "project add",
        Command::ProjectRemove { .. } => "project remove",
        Command::PeerList => "peer list",
        Command::PeerPair { .. } => "peer pair",
        Command::PeerUnpair { .. } => "peer unpair",
        Command::PeerRename { .. } => "peer rename",
        Command::Hello | Command::Raise | Command::OpenUrl { .. } => "this verb",
        _ => return None,
    })
}

/// May a peer holding `grant` run `cmd` here? `contacts` are the tasks
/// here that have called that peer. Err is the sentence the caller sees.
fn permitted(
    grant: Grant,
    cmd: &Command,
    contacts: &[String],
    host: &dyn CliHost,
    us: &str,
) -> Result<(), String> {
    match grant {
        Grant::Drive => match drive_denied(cmd) {
            Some(verb) => Err(format!("{us} does not let a paired machine run {verb}")),
            None => Ok(()),
        },
        Grant::Reply => {
            let refused = || {
                format!(
                    "{us} only lets this machine reply to its tasks that contacted it \
                     (send, naming the task id from the message you are answering). \
                     To do more, the person at {us} changes what this machine may do \
                     in Settings > Agent access."
                )
            };
            let Command::Send { task: Some(task), project, resume, fresh, .. } = cmd else {
                return Err(refused());
            };
            // A reply goes to the agent that asked for it. Starting one
            // (`fresh`) or bringing back a session (`resume`) in a task whose
            // agent has gone is more than replying.
            if *resume || *fresh {
                return Err(format!(
                    "{us} only lets this machine reply to a running agent, not start or resume one"
                ));
            }
            let (projects, tasks) = host.projects_tasks();
            let t = crate::cli_server::resolve_by_name(&projects, &tasks, task, project.as_deref())
                .map_err(|e| e.message)?;
            if contacts.iter().any(|c| c == &t.id) {
                Ok(())
            } else {
                Err(refused())
            }
        }
    }
}

/// A report back is delivered at once. A `send` from a paired machine into
/// a task here that sent that machine work (`contacts`) is the answer that
/// task is waiting for, so it skips the agent's queue (`now`) instead of
/// waiting for its current turn to end; the orchestrator often sits in a
/// long turn of its own, watching for exactly this. New work going the
/// other way, into a task that never contacted the sender, still queues, so
/// it never interrupts an agent mid-turn. Set here rather than asked of the
/// sending agent, which does not know (or forgets) which kind it is.
fn report_back_now(cmd: Command, contacts: &[String], host: &dyn CliHost) -> Command {
    let mut cmd = cmd;
    if let Command::Send { task: Some(task), project, now, resume, fresh, .. } = &mut cmd {
        if !*now && !*resume && !*fresh {
            let (projects, tasks) = host.projects_tasks();
            if let Ok(t) = crate::cli_server::resolve_by_name(&projects, &tasks, task, project.as_deref()) {
                if contacts.iter().any(|c| c == &t.id) {
                    *now = true;
                }
            }
        }
    }
    cmd
}

/// What a request from another machine must not carry. Each names the
/// CALLER's machine (its working directory, its own task) and would be
/// misread here: a `cwd` resolved against this disk, a parent task id that
/// happens to exist here. Stripped through the wire shape so a field added
/// to a verb later is covered by its name, not by a match arm someone has
/// to remember.
fn sanitize(cmd: &Command) -> Command {
    let Ok(mut v) = serde_json::to_value(cmd) else { return cmd.clone() };
    if let Some(o) = v.as_object_mut() {
        for k in ["cwd", "parent_task", "caller_task"] {
            o.remove(k);
        }
    }
    serde_json::from_value(v).unwrap_or_else(|_| cmd.clone())
}

/// Does the CLI read this verb's reply as a stream? Those, and only those,
/// get heartbeats while the peer works: a heartbeat line in front of a
/// single-reply verb's answer would be read AS the answer.
fn streamed(cmd: &Command) -> bool {
    match cmd {
        Command::New { .. } | Command::Wait { .. } | Command::Send { .. } | Command::PeerPair { .. } => true,
        Command::Tab { prompt, prompt_ref, .. } => prompt.is_some() || prompt_ref.is_some(),
        _ => false,
    }
}

/// How long to wait for a peer's answer to `cmd`, after its own wait cap.
fn call_budget(cmd: &Command) -> Duration {
    let wait_ms = match cmd {
        Command::Wait { timeout_ms, .. } => Some(timeout_ms.unwrap_or(crate::mcp_server::MCP_WAIT_CAP_MS)),
        Command::New { wait: true, timeout_ms, .. }
        | Command::Send { wait: true, timeout_ms, .. }
        | Command::Tab { wait: true, timeout_ms, .. } => {
            Some(timeout_ms.unwrap_or(crate::mcp_server::MCP_WAIT_CAP_MS))
        }
        _ => None,
    };
    match (wait_ms, cmd) {
        (Some(ms), _) => {
            Duration::from_millis(ms.min(crate::mcp_server::MCP_WAIT_CAP_MS)) + SLOW_CALL_TIMEOUT
        }
        (None, Command::Archive { .. } | Command::New { .. } | Command::ScheduleDelete { .. }) => {
            SLOW_CALL_TIMEOUT
        }
        _ => CALL_TIMEOUT,
    }
}

// ───────────────────────────── store ─────────────────────────────────

/// `peers.json`: this machine's identity and every pair. 0600 like the
/// token files (on Windows, the per-user data dir's ACL): it holds keys.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Store {
    /// This instance's id: random, stable, the thing pairs are keyed on.
    id: String,
    /// The name other machines see. Empty: the computer's own name.
    name: String,
    /// The listener's last port, preferred on the next bind so a peer's
    /// remembered address keeps working across restarts.
    port: u16,
    peers: Vec<PeerRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PeerRecord {
    id: String,
    /// The name it gives itself (kept current from discovery and calls).
    name: String,
    /// The local name the user gave it, if any.
    alias: Option<String>,
    /// The pair key, hex. Never leaves this file and this process.
    key: String,
    grant: Grant,
    their_grant: Option<Grant>,
    paired_at_ms: i64,
    last_seen_ms: Option<i64>,
    addr: Option<String>,
    port: u16,
    version: Option<String>,
    proto: Option<u32>,
    revoked_by_peer: bool,
    /// Tasks here that have called this peer: the ones it may reply into.
    contacts: Vec<String>,
    /// What the user says this machine is for ("the Windows laptop: builds
    /// and installer tests"). Local, like the alias; agents read it in
    /// peer list and the MCP instructions so a prompt need not repeat it.
    note: String,
}

impl PeerRecord {
    fn display_name(&self) -> String {
        self.alias.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| self.name.clone())
    }
    fn key(&self) -> Option<[u8; 32]> {
        pc::key_from_hex(&self.key)
    }
    fn socket(&self) -> Option<SocketAddr> {
        let ip: IpAddr = self.addr.as_deref()?.parse().ok()?;
        (self.port != 0).then(|| SocketAddr::new(ip, self.port))
    }
}

fn load_store(dir: &Path) -> Store {
    let path = dir.join(PEERS_FILE);
    let mut s: Store = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            // Kept aside rather than overwritten: it holds every pair key,
            // and a person may want to know why their pairs vanished.
            dlog(&format!("[peers] {PEERS_FILE} unreadable ({e}); starting over"));
            let _ = std::fs::rename(&path, dir.join(format!("{PEERS_FILE}.unreadable")));
            Store::default()
        }),
        Err(_) => Store::default(),
    };
    if s.id.len() != 32 || !s.id.bytes().all(|b| b.is_ascii_hexdigit()) {
        s.id = pc::random_hex::<16>();
        let _ = save_store(dir, &s);
    }
    s
}

fn save_store(dir: &Path, s: &Store) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(s).map_err(std::io::Error::other)?;
    // Written beside and renamed over, so a crash mid-write never leaves a
    // truncated file that would read as "no pairs at all".
    let tmp = dir.join(format!("{PEERS_FILE}.tmp"));
    crate::cli_server::write_token_file(&tmp, &text)?;
    std::fs::rename(&tmp, dir.join(PEERS_FILE))
}

/// The computer's own name, which a fresh install proposes. macOS's
/// ComputerName is the one people recognise ("Alice's MacBook Pro"); the
/// hostname is the fallback everywhere.
pub(crate) fn default_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return name;
        }
    }
    #[cfg(windows)]
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length, and gethostname
        // NUL-terminates within it (or truncates, which the scan handles).
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]);
            let name = name.trim().trim_end_matches(".local").to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "Termic".to_string()
}

/// A name as other machines will see it: one line, bounded.
fn clean_name(s: &str) -> String {
    let one_line: String = s.chars().filter(|c| !c.is_control()).collect();
    one_line.trim().chars().take(60).collect()
}

// ───────────────────────────── views ─────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PeerView {
    pub id: String,
    pub name: String,
    pub advertised_name: String,
    pub alias: Option<String>,
    pub online: bool,
    pub last_seen_ms: Option<i64>,
    pub address: Option<String>,
    pub version: Option<String>,
    pub proto: Option<u32>,
    pub proto_ok: bool,
    pub grant: Grant,
    pub their_grant: Option<Grant>,
    pub revoked_by_peer: bool,
    pub paired_at_ms: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct NearbyView {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub version: String,
    pub proto: u32,
    pub proto_ok: bool,
    /// In pairing mode right now: showing a code, ready to be paired with.
    pub pairing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Direction {
    /// The person here typed the other machine's code.
    Outgoing,
    /// This machine was in pairing mode and the other typed its code.
    Incoming,
}

/// A pairing that just completed, for the dialog on each machine (where the
/// person says what the other machine is for).
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PairingView {
    pub direction: Direction,
    pub peer_id: String,
    pub peer_name: String,
    pub replaces_existing: bool,
}

/// This machine in pairing mode: the code it shows and until when.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PairModeView {
    pub code: String,
    pub expires_at_ms: i64,
    /// Wrong codes typed so far; the mode closes at `MAX_WRONG_CODES`.
    pub wrong_codes: u8,
    /// The machine whose person clicked Pair on this one, which opened the
    /// mode (`/pair/request`). None when it was opened here by hand.
    pub requested_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PeerStatus {
    pub enabled: bool,
    pub self_id: String,
    pub self_name: String,
    pub default_name: String,
    pub port: Option<u16>,
    pub addresses: Vec<String>,
    pub discovery_error: Option<String>,
    /// The OS refuses discovery's sends (macOS Local Network privacy).
    pub network_blocked: bool,
    pub bind_error: Option<String>,
    pub platform: &'static str,
    pub peers: Vec<PeerView>,
    pub nearby: Vec<NearbyView>,
    /// Open while this machine shows a pairing code.
    pub pair_mode: Option<PairModeView>,
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Where the UI hears about changes. A trait so tests run without Tauri.
pub(crate) trait PeerUi: Send + Sync {
    /// The pair list, the nearby list or this machine's state changed.
    fn changed(&self);
    /// A pairing completed (the global dialog asks what the machine is for).
    fn pairing(&self, view: &PairingView);
}

// ───────────────────────────── pairing ───────────────────────────────

/// Who this machine is, as the pairing messages carry it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Who {
    id: String,
    name: String,
    version: String,
    proto: u32,
    pv: u32,
    port: u16,
}

struct PairMode {
    code: String,
    until: Instant,
    expires_at_ms: i64,
    wrong_codes: u8,
    requested_by: Option<String>,
}

/// An incoming pairing between start and confirm: the key the code would
/// give, if the other side typed the right one. One at a time.
struct Incoming {
    id: String,
    peer: Who,
    ip: IpAddr,
    key: [u8; 32],
    until: Instant,
}

// ───────────────────────────── node ──────────────────────────────────

/// One machine's pairing state: the store, the live pairings, and (while
/// LAN sharing is on) the listener and discovery. One per app; tests build
/// as many as they need.
pub(crate) struct Node {
    dir: PathBuf,
    host: Arc<dyn CliHost>,
    ui: Arc<dyn PeerUi>,
    /// The LAN sharing setting, re-read per request (the mcp discipline: a
    /// switch-off applies to connections racing the unbind).
    enabled: Box<dyn Fn() -> bool + Send + Sync>,
    version: String,
    store: Mutex<Store>,
    pair_mode: Mutex<Option<PairMode>>,
    incoming: Mutex<Option<Incoming>>,
    /// address -> refused until (after a wrong code).
    cooldown: Mutex<HashMap<IpAddr, Instant>>,
    /// Per source address: when it may ask to pair again (`/pair/request`).
    request_cooldown: Mutex<HashMap<IpAddr, Instant>>,
    /// Request ids seen inside the freshness window: a replayed call is
    /// refused even with a valid seal.
    replay: Mutex<HashMap<String, i64>>,
    failures: Mutex<u32>,
    runtime: Mutex<Option<Runtime>>,
    bind_error: Mutex<Option<String>>,
    discovery_error: Mutex<Option<String>>,
    /// Tests: what discovery would have seen, without multicast.
    #[cfg(test)]
    fake_sightings: Mutex<Vec<mdns::Sighting>>,
}

struct Runtime {
    port: u16,
    /// What the listener is bound to: every interface, or loopback in tests.
    addr: IpAddr,
    shutdown: Arc<AtomicBool>,
    discovery: Option<mdns::Discovery>,
}

impl Node {
    pub(crate) fn new(
        dir: PathBuf,
        host: Arc<dyn CliHost>,
        ui: Arc<dyn PeerUi>,
        enabled: Box<dyn Fn() -> bool + Send + Sync>,
        version: String,
    ) -> Arc<Node> {
        let store = load_store(&dir);
        Arc::new(Node {
            dir,
            host,
            ui,
            enabled,
            version,
            store: Mutex::new(store),
            pair_mode: Mutex::new(None),
            incoming: Mutex::new(None),
            cooldown: Mutex::new(HashMap::new()),
            request_cooldown: Mutex::new(HashMap::new()),
            replay: Mutex::new(HashMap::new()),
            failures: Mutex::new(0),
            runtime: Mutex::new(None),
            bind_error: Mutex::new(None),
            discovery_error: Mutex::new(None),
            #[cfg(test)]
            fake_sightings: Mutex::new(Vec::new()),
        })
    }

    pub(crate) fn self_id(&self) -> String {
        self.store.lock().unwrap().id.clone()
    }

    pub(crate) fn self_name(&self) -> String {
        let n = self.store.lock().unwrap().name.clone();
        if n.trim().is_empty() {
            default_name()
        } else {
            n
        }
    }

    fn who(&self) -> Who {
        Who {
            id: self.self_id(),
            name: self.self_name(),
            version: self.version.clone(),
            proto: proto::PROTOCOL_VERSION,
            pv: PV,
            port: self.port().unwrap_or(0),
        }
    }

    pub(crate) fn port(&self) -> Option<u16> {
        self.runtime.lock().unwrap().as_ref().map(|r| r.port)
    }

    fn save(&self, s: &Store) {
        if let Err(e) = save_store(&self.dir, s) {
            dlog(&format!("[peers] could not save {PEERS_FILE}: {e}"));
        }
    }

    fn sightings(&self) -> Vec<mdns::Sighting> {
        #[cfg(test)]
        {
            let fake = self.fake_sightings.lock().unwrap().clone();
            if !fake.is_empty() {
                return fake;
            }
        }
        self.runtime
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|r| r.discovery.as_ref().map(|d| d.sightings()))
            .unwrap_or_default()
    }

    // ── lifecycle ────────────────────────────────────────────────────

    /// Bind the listener and start discovery. Idempotent.
    pub(crate) fn start(self: &Arc<Self>) {
        // Test seam (DEBUG BUILDS ONLY, like TERMIC_DATA_DIR): the e2e suite
        // turns sharing on, and on the LAN that would raise macOS's Local
        // Network prompt on a contributor's machine and the Windows firewall
        // prompt on a CI runner, for a run that only ever talks to itself.
        // Loopback, no multicast. Dead in release, where a leaked variable
        // must never quietly make sharing unreachable.
        if cfg!(debug_assertions) && std::env::var("TERMIC_PEER_LOOPBACK").is_ok_and(|v| v == "1") {
            return self.start_on(IpAddr::from([127, 0, 0, 1]), false);
        }
        self.start_on(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), true);
    }

    fn start_on(self: &Arc<Self>, addr: IpAddr, discover: bool) {
        let mut rt = self.runtime.lock().unwrap();
        if rt.is_some() {
            return;
        }
        let preferred = self.store.lock().unwrap().port;
        let listener = match bind(addr, preferred) {
            Ok(l) => l,
            Err(e) => {
                dlog(&format!("[peers] bind failed: {e}"));
                *self.bind_error.lock().unwrap() = Some(e);
                return;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        *self.bind_error.lock().unwrap() = None;
        {
            let mut s = self.store.lock().unwrap();
            if s.port != port {
                s.port = port;
                self.save(&s);
            }
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let me = self.clone();
        let sd = shutdown.clone();
        std::thread::spawn(move || serve(listener, me, sd));
        let discovery = if discover {
            let ui = self.ui.clone();
            let advert = self.advert(port);
            mdns::ask_local_network_access();
            match mdns::Discovery::start(advert, Arc::new(move || ui.changed())) {
                Ok(d) => {
                    *self.discovery_error.lock().unwrap() = None;
                    Some(d)
                }
                Err(e) => {
                    dlog(&format!("[peers] discovery unavailable: {e}"));
                    *self.discovery_error.lock().unwrap() = Some(e);
                    None
                }
            }
        } else {
            None
        };
        dlog(&format!("[peers] listening on port {port}"));
        *rt = Some(Runtime { port, addr, shutdown, discovery });
        drop(rt);
        self.ui.changed();
    }

    fn advert(&self, port: u16) -> mdns::Advert {
        mdns::Advert {
            id: self.self_id(),
            name: self.self_name(),
            version: self.version.clone(),
            proto: proto::PROTOCOL_VERSION,
            pv: PV,
            port,
            pairing: self.pair_mode.lock().unwrap().as_ref().is_some_and(|m| m.until > Instant::now()),
        }
    }

    /// Say what we are again, now: pairing mode opened or closed.
    fn readvertise(&self) {
        if let Some(rt) = self.runtime.lock().unwrap().as_ref() {
            if let Some(d) = rt.discovery.as_ref() {
                d.update_advert(self.advert(rt.port));
            }
        }
    }

    /// Unbind, say goodbye on the network, and end every live pairing.
    pub(crate) fn stop(&self) {
        let rt = self.runtime.lock().unwrap().take();
        if let Some(rt) = rt {
            rt.shutdown.store(true, Ordering::SeqCst);
            // accept() has no shutdown; a bounded self-connect unblocks it.
            let poke = SocketAddr::from(([127, 0, 0, 1], rt.port));
            let _ = TcpStream::connect_timeout(&poke, Duration::from_millis(500));
            if let Some(d) = rt.discovery {
                d.stop();
            }
            dlog("[peers] stopped");
        }
        *self.pair_mode.lock().unwrap() = None;
        *self.incoming.lock().unwrap() = None;
        self.ui.changed();
    }

    // ── status and local edits ───────────────────────────────────────

    pub(crate) fn status(&self) -> PeerStatus {
        let pair_mode = self.pair_mode_view();
        let sightings = self.sightings();
        let s = self.store.lock().unwrap().clone();
        let peers = s.peers.iter().map(|p| peer_view(p, &sightings)).collect();
        let paired: Vec<&str> = s.peers.iter().map(|p| p.id.as_str()).collect();
        let nearby = sightings
            .iter()
            .filter(|x| x.id != s.id && !paired.contains(&x.id.as_str()) && x.pv == PV)
            .map(|x| NearbyView {
                id: x.id.clone(),
                name: x.name.clone(),
                address: x.addr.to_string(),
                port: x.port,
                version: x.version.clone(),
                proto: x.proto,
                proto_ok: x.proto == proto::PROTOCOL_VERSION,
                pairing: x.pairing,
            })
            .collect();
        let bound = self.runtime.lock().unwrap().as_ref().map(|r| (r.addr, r.port));
        let port = bound.map(|(_, p)| p);
        let addresses = match bound {
            // Bound to one address (loopback, under test): that is the answer.
            Some((a, p)) if !a.is_unspecified() => vec![SocketAddr::new(a, p).to_string()],
            Some((_, p)) => crate::mcp_server::lan_ip().map(|ip| vec![SocketAddr::new(ip, p).to_string()]).unwrap_or_default(),
            None => Vec::new(),
        };
        PeerStatus {
            enabled: (self.enabled)(),
            self_id: s.id.clone(),
            self_name: if s.name.trim().is_empty() { default_name() } else { s.name.clone() },
            default_name: default_name(),
            port,
            addresses,
            discovery_error: self.discovery_error.lock().unwrap().clone(),
            bind_error: self.bind_error.lock().unwrap().clone(),
            network_blocked: self.runtime.lock().unwrap().as_ref()
                .and_then(|r| r.discovery.as_ref().map(|d| d.blocked()))
                .unwrap_or(false),
            platform: platform(),
            peers,
            nearby,
            pair_mode,
        }
    }

    pub(crate) fn set_name(&self, name: &str) {
        let name = clean_name(name);
        {
            let mut s = self.store.lock().unwrap();
            // The default is stored as "" so a renamed computer is followed.
            s.name = if name == default_name() { String::new() } else { name };
            self.save(&s);
        }
        self.readvertise();
        self.ui.changed();
    }

    /// The pair a selector names: its id, an id prefix of 6+ characters,
    /// its local name or the name it gives itself (case-insensitive).
    fn find(&self, sel: &str) -> Result<PeerRecord, String> {
        let s = self.store.lock().unwrap();
        find_in(&s.peers, sel).cloned()
    }

    pub(crate) fn rename(&self, sel: &str, name: &str) -> Result<PeerView, String> {
        let id = self.find(sel)?.id;
        let view = {
            let mut s = self.store.lock().unwrap();
            let p = s.peers.iter_mut().find(|p| p.id == id).ok_or("that pair is gone")?;
            let name = clean_name(name);
            p.alias = (!name.is_empty() && name != p.name).then_some(name);
            let view = peer_view(p, &[]);
            self.save(&s);
            view
        };
        self.ui.changed();
        Ok(view)
    }

    /// What this machine is for, in the user's words. Trimmed, one line,
    /// capped so it stays a note in every agent's context and not a prompt.
    pub(crate) fn set_note(&self, sel: &str, note: &str) -> Result<(), String> {
        let id = self.find(sel)?.id;
        let note: String = note.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NOTE_MAX).collect();
        {
            let mut s = self.store.lock().unwrap();
            if let Some(p) = s.peers.iter_mut().find(|p| p.id == id) {
                p.note = note;
            }
            self.save(&s);
        }
        self.ui.changed();
        Ok(())
    }

    /// The paired machines and their notes, for the MCP server's
    /// instructions: an agent learns what each machine is for without
    /// calling anything. Empty when nothing is paired.
    pub(crate) fn instructions(&self) -> String {
        let s = self.store.lock().unwrap();
        if s.peers.is_empty() {
            return String::new();
        }
        let mut out = String::from("\n\nPaired machines (reach one with a tool's peer argument, or peer_call):");
        for p in &s.peers {
            out.push_str("\n- ");
            out.push_str(&p.display_name());
            if !p.note.is_empty() {
                out.push_str(": ");
                out.push_str(&p.note);
            }
        }
        out
    }

    pub(crate) fn set_grant(&self, sel: &str, grant: Grant) -> Result<(), String> {
        let id = self.find(sel)?.id;
        {
            let mut s = self.store.lock().unwrap();
            if let Some(p) = s.peers.iter_mut().find(|p| p.id == id) {
                p.grant = grant;
            }
            self.save(&s);
        }
        self.ui.changed();
        Ok(())
    }

    /// Forget a pair here at once, then tell the other machine (best
    /// effort: an offline peer keeps a dead key that no longer opens
    /// anything here, and learns on its next call).
    pub(crate) fn unpair(&self, sel: &str) -> Result<PeerView, String> {
        let rec = self.find(sel)?;
        {
            let mut s = self.store.lock().unwrap();
            s.peers.retain(|p| p.id != rec.id);
            self.save(&s);
        }
        self.ui.changed();
        if let (Some(key), Some(addr)) = (rec.key(), self.address_of(&rec)) {
            let me = self.self_id();
            let body = Sealed::new(serde_json::json!({}), None);
            let path = format!("{PREFIX}/unpair");
            let env = pc::seal(&key, &path, &me, &rec.id, &body.to_bytes());
            match http(addr, "POST", &path, &serde_json::to_vec(&env).unwrap_or_default(), Duration::from_secs(5)) {
                Ok((200, _)) => {}
                Ok((status, _)) => dlog(&format!("[peers] unpair notice refused ({status})")),
                Err(e) => dlog(&format!("[peers] unpair notice not delivered: {e}")),
            }
        }
        Ok(peer_view(&rec, &[]))
    }

    pub(crate) fn refresh(&self) {
        if let Some(rt) = self.runtime.lock().unwrap().as_ref() {
            if let Some(d) = rt.discovery.as_ref() {
                d.query_now();
            }
        }
    }

    /// The freshest address for a pair: discovery's when it has one, the
    /// stored one otherwise.
    fn address_of(&self, rec: &PeerRecord) -> Option<SocketAddr> {
        self.sightings()
            .into_iter()
            .find(|x| x.id == rec.id)
            .map(|x| SocketAddr::new(x.addr, x.port))
            .or_else(|| rec.socket())
    }

    /// Learned something about a peer from an authenticated exchange or a
    /// sighting: keep the record current. Written to disk only when a field
    /// a person would miss changed, or the last write is old, so a chatty
    /// peer does not mean a file write per call.
    fn touch(&self, id: &str, ip: Option<IpAddr>, port: Option<u16>, their_grant: Option<Grant>) {
        let mut s = self.store.lock().unwrap();
        let Some(p) = s.peers.iter_mut().find(|p| p.id == id) else { return };
        let now = now_ms();
        let mut dirty = p.last_seen_ms.is_none_or(|t| now - t > 300_000);
        p.last_seen_ms = Some(now);
        if let Some(ip) = ip {
            let ip = ip.to_string();
            if p.addr.as_deref() != Some(&ip) {
                p.addr = Some(ip);
                dirty = true;
            }
        }
        if let Some(port) = port.filter(|p| *p != 0) {
            if p.port != port {
                p.port = port;
                dirty = true;
            }
        }
        if their_grant.is_some() && p.their_grant != their_grant {
            p.their_grant = their_grant;
            dirty = true;
        }
        if p.revoked_by_peer {
            p.revoked_by_peer = false;
            dirty = true;
        }
        if dirty {
            self.save(&s);
            drop(s);
            self.ui.changed();
        }
    }

    // ── pairing mode (the machine that shows the code) ───────────────

    /// Show a fresh code and tell the network this machine is ready to be
    /// paired with, for `PAIR_MODE_TTL`. Reopening gives a new code. Only
    /// a machine in pairing mode answers a pairing request at all, so the
    /// person here opening it is the consent, and the code that only this
    /// screen shows is the proof the other side's person can see it.
    pub(crate) fn open_pair_mode(self: &Arc<Self>) -> Result<PairModeView, String> {
        self.open_pair_mode_for(None)
    }

    fn open_pair_mode_for(self: &Arc<Self>, requested_by: Option<String>) -> Result<PairModeView, String> {
        if self.port().is_none() {
            return Err("Turn on sharing on this network first (Settings > Agent access).".into());
        }
        let code = pc::new_code();
        let until = Instant::now() + PAIR_MODE_TTL;
        *self.pair_mode.lock().unwrap() = Some(PairMode {
            code: code.clone(),
            until,
            expires_at_ms: now_ms() + PAIR_MODE_TTL.as_millis() as i64,
            wrong_codes: 0,
            requested_by,
        });
        self.readvertise();
        self.ui.changed();
        // Close it at its deadline even when nobody looks: the advert must
        // stop saying "ready to pair". One timer per opening, not a poll; a
        // reopened mode carries another code, so a stale timer does nothing.
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(PAIR_MODE_TTL);
            let mut m = me.pair_mode.lock().unwrap();
            if m.as_ref().is_some_and(|m| m.code == code && m.until == until) {
                *m = None;
                drop(m);
                me.readvertise();
                me.ui.changed();
            }
        });
        Ok(self.pair_mode_view().expect("just opened"))
    }

    pub(crate) fn close_pair_mode(&self) {
        let was = self.pair_mode.lock().unwrap().take().is_some();
        *self.incoming.lock().unwrap() = None;
        if was {
            self.readvertise();
            self.ui.changed();
        }
    }

    fn pair_mode_view(&self) -> Option<PairModeView> {
        let m = self.pair_mode.lock().unwrap();
        m.as_ref().filter(|m| m.until > Instant::now()).map(|m| PairModeView {
            code: m.code.clone(),
            expires_at_ms: m.expires_at_ms,
            wrong_codes: m.wrong_codes,
            requested_by: m.requested_by.clone(),
        })
    }

    fn wrong_code(&self, src: IpAddr) {
        self.cooldown.lock().unwrap().insert(src, Instant::now() + WRONG_CODE_COOLDOWN);
        let closed = {
            let mut m = self.pair_mode.lock().unwrap();
            match m.as_mut() {
                Some(mode) => {
                    mode.wrong_codes += 1;
                    if mode.wrong_codes >= MAX_WRONG_CODES {
                        *m = None;
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if closed {
            dlog("[peers] pairing mode closed after too many wrong codes");
            self.readvertise();
        }
        self.ui.changed();
    }

    // ── pairing: the machine in pairing mode (B) ─────────────────────

    /// Step 0: the person at another machine clicked Pair on this one. Open
    /// pairing mode here, naming who asked, so this screen shows the code
    /// they now have to type there. That is the whole consent: the code
    /// exists only on this screen, so pairing still needs someone who can
    /// read it, and a wrong one counts toward `MAX_WRONG_CODES` as before.
    /// Unauthenticated by nature (nothing is shared yet), so it is limited:
    /// once per `REQUEST_COOLDOWN` per address, and an open mode is reused,
    /// never replaced, so a second asker cannot swap the code under the
    /// first one's person.
    fn on_pair_request(self: &Arc<Self>, body: &[u8], src: IpAddr) -> (u16, Vec<u8>) {
        #[derive(Deserialize)]
        struct Ask {
            from: Who,
        }
        let Ok(req) = serde_json::from_slice::<Ask>(body) else { return (400, Vec::new()) };
        if req.from.pv != PV {
            return json(409, &serde_json::json!({ "error": "peer protocol mismatch", "pv": PV }));
        }
        if req.from.id == self.self_id() || req.from.id.len() != 32 {
            return (400, Vec::new());
        }
        let now = Instant::now();
        {
            let mut cd = self.request_cooldown.lock().unwrap();
            cd.retain(|_, until| *until > now);
            if cd.contains_key(&src) {
                return (429, Vec::new());
            }
            cd.insert(src, now + REQUEST_COOLDOWN);
        }
        let name = clean_name(&req.from.name);
        let open = self.pair_mode_view();
        let view = match open {
            Some(v) => v,
            None => match self.open_pair_mode_for(Some(name.clone())) {
                Ok(v) => v,
                Err(_) => return (503, Vec::new()),
            },
        };
        dlog(&format!("[peers] {name} asked to pair; showing the code"));
        json(200, &serde_json::json!({ "to": self.who(), "expires_at_ms": view.expires_at_ms }))
    }

    /// Step 1: the other side's SPAKE2 message, answered with ours. Nothing
    /// tells either side yet whether the codes matched; the confirm does.
    fn on_pair_start(&self, body: &[u8], src: IpAddr) -> (u16, Vec<u8>) {
        #[derive(Deserialize)]
        struct Start {
            from: Who,
            msg: String,
        }
        let Ok(req) = serde_json::from_slice::<Start>(body) else { return (400, Vec::new()) };
        if req.from.pv != PV {
            return json(409, &serde_json::json!({ "error": "peer protocol mismatch", "pv": PV }));
        }
        let Some(msg_a) = pc::unb64(&req.msg) else { return (400, Vec::new()) };
        let me = self.self_id();
        if req.from.id == me || req.from.id.len() != 32 {
            return (400, Vec::new());
        }
        let now = Instant::now();
        {
            let mut cd = self.cooldown.lock().unwrap();
            cd.retain(|_, until| *until > now);
            if cd.contains_key(&src) {
                return (429, Vec::new());
            }
        }
        let Some(code) = self.pair_mode_view().map(|m| m.code) else {
            return json(403, &serde_json::json!({ "error": "not_pairing" }));
        };
        let mut inc = self.incoming.lock().unwrap();
        if inc.as_ref().is_some_and(|i| i.until > now) {
            return (429, Vec::new());
        }
        let (b, msg_b) = pc::Pake::start_b(&code, &req.from.id, &me);
        let Some(secret) = b.finish(&msg_a) else { return (400, Vec::new()) };
        let id = pc::random_hex::<8>();
        *inc = Some(Incoming {
            id: id.clone(),
            key: pc::pair_key(&secret, &req.from.id, &me),
            peer: req.from,
            ip: src,
            until: now + INCOMING_TTL,
        });
        drop(inc);
        json(200, &serde_json::json!({ "to": self.who(), "pairing": id, "msg": pc::b64(&msg_b) }))
    }

    /// Step 2: the other side's first message under the key. It opens only
    /// if both typed-and-shown codes were the same, which is the check.
    fn on_pair_confirm(&self, body: &[u8], src: IpAddr) -> (u16, Vec<u8>) {
        #[derive(Deserialize)]
        struct Confirm {
            pairing: String,
            env: pc::Envelope,
        }
        let Ok(req) = serde_json::from_slice::<Confirm>(body) else { return (400, Vec::new()) };
        let me = self.self_id();
        let path = format!("{PREFIX}/pair/confirm");
        let inc = {
            let mut slot = self.incoming.lock().unwrap();
            match slot.as_ref() {
                Some(i) if i.id == req.pairing && i.ip == src && i.peer.id == req.env.from && i.until > Instant::now() => {
                    slot.take().expect("matched above")
                }
                _ => return (404, Vec::new()),
            }
        };
        let Some(msg) = pc::open(&inc.key, &path, &me, &req.env).and_then(|p| Sealed::parse(&p)) else {
            self.wrong_code(src);
            return json(403, &serde_json::json!({ "error": "wrong_code" }));
        };
        if self.pair_mode_view().is_none() {
            // Closed here while the other side was typing.
            return json(403, &serde_json::json!({ "error": "not_pairing" }));
        }
        if (now_ms() - msg.ts).abs() > FRESH_WINDOW_MS {
            // A pair whose clocks disagree would have every call refused
            // (open_sealed), so do not make one. The sealed answer carries
            // this clock, for the other side to say by how much.
            dlog(&format!("[peers] {} asked to pair with a clock off by {} s; refused", clean_name(&inc.peer.name), (msg.ts - now_ms()) / 1000));
            self.close_pair_mode();
            let (_, body) = self.seal_reply(&inc.key, &path, &inc.peer.id, &msg.rid, serde_json::json!({}));
            return (409, body);
        }
        let their_grant = msg.body.get("grant").and_then(|v| v.as_str()).and_then(Grant::parse).unwrap_or_default();
        let replaces_existing = self.store.lock().unwrap().peers.iter().any(|p| p.id == inc.peer.id);
        self.persist_pair(new_record(&inc.peer, inc.ip, &inc.key, their_grant));
        self.close_pair_mode();
        self.ui.pairing(&PairingView {
            direction: Direction::Incoming,
            peer_id: inc.peer.id.clone(),
            peer_name: clean_name(&inc.peer.name),
            replaces_existing,
        });
        self.seal_reply(&inc.key, &path, &inc.peer.id, &msg.rid, serde_json::json!({ "grant": Grant::Drive }))
    }

    fn persist_pair(&self, rec: PeerRecord) {
        {
            let mut s = self.store.lock().unwrap();
            // A re-pair replaces the old key; the local name, the note and
            // the reply contacts are the person's, and survive it.
            let old = s.peers.iter().position(|p| p.id == rec.id).map(|i| s.peers.remove(i));
            let mut rec = rec;
            if let Some(old) = old {
                rec.alias = old.alias;
                rec.contacts = old.contacts;
                rec.note = old.note;
            }
            s.peers.push(rec);
            self.save(&s);
        }
        self.ui.changed();
    }

    fn seal_reply(&self, key: &[u8; 32], path: &str, to: &str, rid: &str, body: serde_json::Value) -> (u16, Vec<u8>) {
        let me = self.self_id();
        let msg = Sealed::new(body, None).with_rid(rid);
        let env = pc::seal(key, path, &me, to, &msg.to_bytes());
        json(200, &env)
    }

    // ── pairing: the machine whose person types the code (A) ─────────

    /// Ask a machine to show a pairing code (`/pair/request`): the first
    /// half of "click Pair, type the code the other screen shows". Returns
    /// its name, for "Type the code shown on <name>".
    pub(crate) fn request_pair(&self, target: &str) -> Result<String, String> {
        if self.port().is_none() {
            return Err("Turn on sharing on this network first (Settings > Agent access).".into());
        }
        let target = target.trim();
        if target.is_empty() {
            return Err("Name the machine to pair with.".into());
        }
        let candidates = self.pair_candidates(target)?;
        let (addr, hello) = probe(&candidates)?;
        let me = self.who();
        if hello.id == me.id {
            return Err("That address is this machine.".into());
        }
        if hello.pv != PV {
            return Err(format!(
                "{} runs a Termic that pairs differently (version {}). Update both to the same version.",
                hello.name, hello.version
            ));
        }
        let body = serde_json::json!({ "from": me }).to_string();
        let (status, _) = http(addr, "POST", &format!("{PREFIX}/pair/request"), body.as_bytes(), CALL_TIMEOUT)
            .map_err(|e| unreachable_msg(&hello.name, &e))?;
        match status {
            200 => Ok(clean_name(&hello.name)),
            404 => Err(format!("{} runs an older Termic. Update it, or open pairing mode there by hand.", hello.name)),
            429 => Err(format!("Asked {} a moment ago. Its code is on its screen.", hello.name)),
            503 => Err(format!("{} has sharing turned off.", hello.name)),
            s => Err(format!("{} refused the request ({s}).", hello.name)),
        }
    }

    /// Pair with a machine in sight (its id or name) or at an address, using
    /// the code its screen shows in pairing mode. Blocking: two short
    /// requests. Both sides let the other drive (Settings narrows it).
    pub(crate) fn pair(self: &Arc<Self>, target: &str, code: &str) -> Result<PairingView, String> {
        if self.port().is_none() {
            return Err("Turn on sharing on this network first (Settings > Agent access).".into());
        }
        let target = target.trim();
        if target.is_empty() {
            return Err("Name the machine to pair with.".into());
        }
        let Some(code) = pc::normalize_code(code) else {
            return Err(format!("The code is the {} digits the other computer shows in pairing mode.", pc::CODE_DIGITS));
        };
        let candidates = self.pair_candidates(target)?;
        let (addr, hello) = probe(&candidates)?;
        let me = self.who();
        if hello.id == me.id {
            return Err("That address is this machine.".into());
        }
        if hello.pv != PV {
            return Err(format!(
                "{} runs a Termic that pairs differently (version {}). Update both to the same version.",
                hello.name, hello.version
            ));
        }
        let not_pairing = || {
            format!(
                "{0} is no longer showing a code. Click Pair again to get a new one.",
                hello.name
            )
        };
        let (a, msg_a) = pc::Pake::start_a(&code, &me.id, &hello.id);
        let start = serde_json::json!({ "from": me, "msg": pc::b64(&msg_a) });
        let (status, body) = http(addr, "POST", &format!("{PREFIX}/pair/start"), start.to_string().as_bytes(), CALL_TIMEOUT)
            .map_err(|e| unreachable_msg(&hello.name, &e))?;
        match status {
            200 => {}
            403 => return Err(not_pairing()),
            429 => return Err(format!("{} is busy with another pairing, or a wrong code was just typed. Try again in a moment.", hello.name)),
            409 => return Err(format!("{} runs a Termic that pairs differently. Update both.", hello.name)),
            s => return Err(format!("{} refused the request ({s}).", hello.name)),
        }
        #[derive(Deserialize)]
        struct Started {
            to: Who,
            pairing: String,
            msg: String,
        }
        let started: Started = serde_json::from_slice(&body).map_err(|_| "The other machine answered with something unexpected.".to_string())?;
        if started.to.id != hello.id {
            return Err("The other machine changed identity mid-pairing; stopped.".into());
        }
        let secret = pc::unb64(&started.msg)
            .and_then(|m| a.finish(&m))
            .ok_or("The other machine sent an unusable answer.")?;
        let key = pc::pair_key(&secret, &me.id, &started.to.id);
        let path = format!("{PREFIX}/pair/confirm");
        let msg = Sealed::new(serde_json::json!({ "grant": Grant::Drive }), None);
        let rid = msg.rid.clone();
        let env = pc::seal(&key, &path, &me.id, &started.to.id, &msg.to_bytes());
        let body = serde_json::json!({ "pairing": started.pairing, "env": env }).to_string();
        let (status, reply) = http(addr, "POST", &path, body.as_bytes(), CALL_TIMEOUT).map_err(|e| unreachable_msg(&hello.name, &e))?;
        if status == 403 {
            let why = serde_json::from_slice::<serde_json::Value>(&reply).ok();
            if why.as_ref().and_then(|v| v["error"].as_str()) == Some("wrong_code") {
                return Err(format!("That is not the code {} shows. Check it and try again.", hello.name));
            }
            return Err(not_pairing());
        }
        let opened = || {
            serde_json::from_slice::<pc::Envelope>(&reply)
                .ok()
                .filter(|e| e.from == started.to.id)
                .and_then(|e| pc::open(&key, &path, &me.id, &e))
                .and_then(|p| Sealed::parse(&p))
                .filter(|m| m.rid == rid)
        };
        if status == 409 {
            if let Some(m) = opened() {
                return Err(format!(
                    "{}. Paired machines must agree within 5 minutes. Turn on automatic time and check the time zone on both, then pair again.",
                    clock_skew(&hello.name, m.ts - now_ms())
                ));
            }
        }
        if status != 200 {
            return Err(format!("{} refused the pairing ({status}).", hello.name));
        }
        let their_grant = opened()
            .map(|m| m.body.get("grant").and_then(|v| v.as_str()).and_then(Grant::parse).unwrap_or_default())
            .ok_or("The other machine's answer did not check out, so nothing was paired.")?;
        let replaces_existing = self.store.lock().unwrap().peers.iter().any(|p| p.id == started.to.id);
        let mut peer = started.to;
        peer.port = addr.port();
        self.persist_pair(new_record(&peer, addr.ip(), &key, their_grant));
        let view = PairingView {
            direction: Direction::Outgoing,
            peer_id: peer.id.clone(),
            peer_name: clean_name(&peer.name),
            replaces_existing,
        };
        self.ui.pairing(&view);
        Ok(view)
    }

    /// Where `target` might be: a sighting's address, or the address typed.
    fn pair_candidates(&self, target: &str) -> Result<Vec<SocketAddr>, String> {
        let sightings = self.sightings();
        let lower = target.to_lowercase();
        if let Some(s) = sightings.iter().find(|s| s.id == target) {
            return Ok(vec![SocketAddr::new(s.addr, s.port)]);
        }
        let by_name: Vec<_> = sightings.iter().filter(|s| s.name.to_lowercase() == lower).collect();
        if by_name.len() > 1 {
            return Err(format!("More than one machine is called {target}; pair by its id or address."));
        }
        if let Some(s) = by_name.first() {
            return Ok(vec![SocketAddr::new(s.addr, s.port)]);
        }
        if let Ok(sa) = target.parse::<SocketAddr>() {
            return Ok(vec![sa]);
        }
        if let Ok(ip) = target.parse::<IpAddr>() {
            let first = *AUTO_PORTS.start();
            return Ok((first..first + ADDRESS_PROBE_PORTS).map(|p| SocketAddr::new(ip, p)).collect());
        }
        Err(format!(
            "No machine called {target} is in sight. Check that it has sharing turned on, or pair by its address (for example 192.168.1.20)."
        ))
    }

    // ── calls ────────────────────────────────────────────────────────

    fn on_call(&self, body: &[u8], src: IpAddr) -> (u16, Vec<u8>) {
        let path = format!("{PREFIX}/call");
        let (rec, msg) = match self.open_sealed(&path, body) {
            Ok(x) => x,
            Err(Some(rec)) => return self.clock_answer(&rec, &path),
            Err(None) => return self.refuse(),
        };
        self.backoff_reset();
        let their_grant = msg.grant;
        self.touch(&rec.id, Some(src), msg.port, their_grant);

        let us = self.self_name();
        let call: Option<CallBody> = serde_json::from_value(msg.body.clone()).ok();
        let reply = match call {
            None => Reply::err("peer", ErrorCode::BadRequest, "malformed call"),
            Some(c) if c.proto != proto::PROTOCOL_VERSION => Reply::err(
                &c.request.id,
                ErrorCode::Unsupported,
                format!(
                    "{us} runs Termic {} (CLI protocol {}) and the calling machine speaks protocol {}. \
                     Update the older one so both run the same version.",
                    self.version,
                    proto::PROTOCOL_VERSION,
                    c.proto
                ),
            ),
            Some(c) => {
                let cmd = localize_signature(sanitize(&c.request.cmd), &rec);
                match permitted(rec.grant, &cmd, &rec.contacts, self.host.as_ref(), &us) {
                    Err(why) => Reply::err(&c.request.id, ErrorCode::Auth, why),
                    Ok(()) => {
                        let mut cmd = report_back_now(cmd, &rec.contacts, self.host.as_ref());
                        crate::mcp_server::clamp_wait(&mut cmd);
                        let req = Request {
                            id: c.request.id.clone(),
                            token: None,
                            profile: c.request.profile.clone(),
                            peer: None,
                            from_task: None,
                            cmd,
                        };
                        // Marked as a paired computer's: whatever it does in a
                        // profile, that profile's window comes on screen.
                        crate::cli_server::with_peer_origin(|| {
                            crate::cli_server::dispatch_authenticated(&req, self.host.as_ref(), &mut crate::mcp_server::NoopSink)
                        })
                    }
                }
            }
        };
        let grant = self.find(&rec.id).map(|r| r.grant).unwrap_or(rec.grant);
        let out = Sealed::new(serde_json::json!({ "reply": reply }), Some(grant)).with_rid(&msg.rid);
        let key = rec.key().expect("opened with it");
        json(200, &pc::seal(&key, &path, &self.self_id(), &rec.id, &out.to_bytes()))
    }

    fn on_unpair(&self, body: &[u8]) -> (u16, Vec<u8>) {
        let path = format!("{PREFIX}/unpair");
        let Ok((rec, msg)) = self.open_sealed(&path, body) else { return self.refuse() };
        {
            let mut s = self.store.lock().unwrap();
            s.peers.retain(|p| p.id != rec.id);
            self.save(&s);
        }
        dlog(&format!("[peers] {} unpaired from this machine", rec.display_name()));
        self.ui.changed();
        let out = Sealed::new(serde_json::json!({}), None).with_rid(&msg.rid);
        let key = rec.key().expect("opened with it");
        json(200, &pc::seal(&key, &path, &self.self_id(), &rec.id, &out.to_bytes()))
    }

    /// Open a sealed request: a known sender, a valid seal, fresh, unseen.
    /// Err(None) for an unknown sender, a bad seal or a replay, answered with
    /// the one bare 401. Err(Some) is the paired machine itself with a
    /// timestamp outside the window: a clock that is off, not a revoked pair.
    fn open_sealed(&self, path: &str, body: &[u8]) -> Result<(PeerRecord, Sealed), Option<Box<PeerRecord>>> {
        let env: pc::Envelope = serde_json::from_slice(body).map_err(|_| None)?;
        let rec = {
            let s = self.store.lock().unwrap();
            s.peers.iter().find(|p| p.id == env.from).cloned().ok_or(None)?
        };
        let plain = pc::open(&rec.key().ok_or(None)?, path, &self.self_id(), &env).ok_or(None)?;
        let msg = Sealed::parse(&plain).ok_or(None)?;
        let now = now_ms();
        if (now - msg.ts).abs() > FRESH_WINDOW_MS {
            return Err(Some(Box::new(rec)));
        }
        let mut seen = self.replay.lock().unwrap();
        seen.retain(|_, ts| (now - *ts).abs() <= FRESH_WINDOW_MS);
        if seen.insert(format!("{}:{}", rec.id, msg.rid), msg.ts).is_some() {
            return Err(None);
        }
        Ok((rec, msg))
    }

    /// The paired machine's call was sealed correctly but stamped outside the
    /// window: answer 409 with this clock (the sealed ts), so it can say the
    /// clocks disagree instead of marking the pair revoked. Nothing runs.
    fn clock_answer(&self, rec: &PeerRecord, path: &str) -> (u16, Vec<u8>) {
        let key = rec.key().expect("opened with it");
        let out = Sealed::new(serde_json::json!({}), None);
        let (_, body) = json(200, &pc::seal(&key, path, &self.self_id(), &rec.id, &out.to_bytes()));
        (409, body)
    }

    /// The one refusal: a bare 401 after a growing delay, identical for an
    /// unknown sender, a bad seal, a stale or a replayed message.
    fn refuse(&self) -> (u16, Vec<u8>) {
        let n = {
            let mut f = self.failures.lock().unwrap();
            *f = f.saturating_add(1);
            *f
        };
        let step = if cfg!(test) { 2 } else { 100 };
        std::thread::sleep(Duration::from_millis((step * n as u64).min(if cfg!(test) { 20 } else { 2000 })));
        (401, Vec::new())
    }

    fn backoff_reset(&self) {
        *self.failures.lock().unwrap() = 0;
    }

    /// Run `req` on the paired machine it names. The local half of `--peer`
    /// and MCP `peer_call`: everything the other machine sees is sealed with
    /// the pair key, which never leaves this process.
    pub(crate) fn forward(&self, req: &Request, sink: &mut dyn EventSink) -> Reply {
        let sel = req.peer.as_deref().unwrap_or("");
        if matches!(req.cmd, Command::PeerList | Command::PeerPair { .. } | Command::PeerUnpair { .. } | Command::PeerRename { .. }) {
            return Reply::err(&req.id, ErrorCode::BadRequest, "the peer verbs act on this machine; drop --peer");
        }
        if matches!(req.cmd, Command::Attach { .. }) {
            return Reply::err(&req.id, ErrorCode::Unsupported, "attach does not reach across machines");
        }
        if !(self.enabled)() || self.port().is_none() {
            return Reply::err(
                &req.id,
                ErrorCode::Unsupported,
                "Sharing on this network is off on this machine (Settings > Agent access), so it cannot reach paired machines.",
            );
        }
        let rec = match self.find(sel) {
            Ok(r) => r,
            Err(msg) => return Reply::err(&req.id, ErrorCode::NotFound, msg),
        };
        let Some(key) = rec.key() else {
            return Reply::err(&req.id, ErrorCode::Internal, "the stored key for that machine is damaged; pair again");
        };
        if let Some(task) = req.from_task.as_deref().filter(|t| !t.trim().is_empty()) {
            self.remember_contact(&rec.id, task);
        }
        let name = rec.display_name();
        let me = self.self_id();
        let path = format!("{PREFIX}/call");
        let cmd = sanitize(&req.cmd);
        let budget = call_budget(&cmd);
        let streaming = streamed(&cmd);
        let inner = Request {
            id: req.id.clone(),
            token: None,
            profile: req.profile.clone(),
            peer: None,
            from_task: None,
            cmd,
        };
        let body = CallBody { proto: proto::PROTOCOL_VERSION, request: inner };
        let msg = Sealed::new(serde_json::to_value(&body).unwrap_or_default(), Some(rec.grant))
            .with_port(self.port());
        let rid = msg.rid.clone();
        let env = pc::seal(&key, &path, &me, &rec.id, &msg.to_bytes());
        let payload = serde_json::to_vec(&env).unwrap_or_default();

        let first = self.address_of(&rec);
        let mut used = first;
        let result = match first {
            Some(addr) => self.call_with_heartbeat(addr, &path, payload.clone(), budget, streaming, &req.id, sink),
            None => Err(HttpError::Connect("no known address".into())),
        };
        // A machine that moved (a new DHCP lease, the other Wi-Fi) is not
        // gone: ask the network once, and retry where it answers now.
        let result = match result {
            Err(HttpError::Connect(_)) => match self.rediscover(&rec.id) {
                Some(addr) if Some(addr) != first => {
                    used = Some(addr);
                    self.call_with_heartbeat(addr, &path, payload, budget, streaming, &req.id, sink)
                }
                _ => result,
            },
            other => other,
        };
        let (status, bytes) = match result {
            Ok(x) => x,
            Err(e) => {
                return Reply::err(&req.id, ErrorCode::PeerUnreachable, unreachable_msg(&name, &e.to_string()));
            }
        };
        if status == 409 {
            let their_ts = serde_json::from_slice::<pc::Envelope>(&bytes)
                .ok()
                .filter(|e| e.from == rec.id)
                .and_then(|e| pc::open(&key, &path, &me, &e))
                .and_then(|p| Sealed::parse(&p))
                .map(|m| m.ts);
            if let Some(ts) = their_ts {
                return Reply::err(&req.id, ErrorCode::Conflict, clock_skew_msg(&name, ts - now_ms()));
            }
        }
        if status == 401 {
            self.mark_revoked(&rec.id);
            return Reply::err(
                &req.id,
                ErrorCode::Auth,
                format!("{name} no longer accepts this machine. It may have unpaired it: unpair here and pair again."),
            );
        }
        if status != 200 {
            return Reply::err(&req.id, ErrorCode::Internal, format!("{name} answered {status}"));
        }
        let opened = serde_json::from_slice::<pc::Envelope>(&bytes)
            .ok()
            .filter(|e| e.from == rec.id)
            .and_then(|e| pc::open(&key, &path, &me, &e))
            .and_then(|p| Sealed::parse(&p))
            .filter(|m| m.rid == rid);
        let Some(answer) = opened else {
            return Reply::err(&req.id, ErrorCode::Internal, format!("{name}'s answer did not check out"));
        };
        // The address that ANSWERED, which after a retry is not the first.
        self.touch(&rec.id, used.map(|a| a.ip()), used.map(|a| a.port()), answer.grant);
        match answer.body.get("reply").cloned().map(serde_json::from_value::<Reply>) {
            Some(Ok(mut reply)) => {
                reply.id = req.id.clone();
                reply
            }
            _ => Reply::err(&req.id, ErrorCode::Internal, format!("{name} sent an answer this version cannot read")),
        }
    }

    /// The HTTP exchange, on its own thread when the CLI reads a stream, so
    /// this one can keep the CLI's connection alive with heartbeats while
    /// the other machine works (its socket gives up after 30 silent seconds).
    #[allow(clippy::too_many_arguments)]
    fn call_with_heartbeat(
        &self,
        addr: SocketAddr,
        path: &str,
        payload: Vec<u8>,
        budget: Duration,
        streaming: bool,
        req_id: &str,
        sink: &mut dyn EventSink,
    ) -> Result<(u16, Vec<u8>), HttpError> {
        if !streaming {
            return http_raw(addr, "POST", path, &payload, budget);
        }
        let (tx, rx) = mpsc::channel();
        let path = path.to_string();
        std::thread::spawn(move || {
            let _ = tx.send(http_raw(addr, "POST", &path, &payload, budget));
        });
        loop {
            match rx.recv_timeout(HEARTBEAT_EVERY) {
                Ok(r) => return r,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // A client that hung up stops being told; the call itself
                    // runs to completion on the other machine either way.
                    let _ = sink.emit(&StreamEvent::heartbeat(req_id));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HttpError::Io("the call thread ended without an answer".into()))
                }
            }
        }
    }

    fn rediscover(&self, id: &str) -> Option<SocketAddr> {
        let since = Instant::now();
        let rt = self.runtime.lock().unwrap();
        let d = rt.as_ref()?.discovery.as_ref()?;
        d.query_now();
        d.wait_for(id, since, Duration::from_secs(2)).map(|s| SocketAddr::new(s.addr, s.port))
    }

    fn remember_contact(&self, peer: &str, task: &str) {
        let mut s = self.store.lock().unwrap();
        let Some(p) = s.peers.iter_mut().find(|p| p.id == peer) else { return };
        if p.contacts.iter().any(|c| c == task) {
            return;
        }
        p.contacts.push(task.to_string());
        if p.contacts.len() > MAX_CONTACTS {
            let extra = p.contacts.len() - MAX_CONTACTS;
            p.contacts.drain(..extra);
        }
        self.save(&s);
    }

    fn mark_revoked(&self, id: &str) {
        let mut s = self.store.lock().unwrap();
        if let Some(p) = s.peers.iter_mut().find(|p| p.id == id) {
            if !p.revoked_by_peer {
                p.revoked_by_peer = true;
                self.save(&s);
                drop(s);
                self.ui.changed();
            }
        }
    }

    // ── the CLI / MCP verbs ──────────────────────────────────────────

    pub(crate) fn list_data(&self) -> proto::PeersData {
        let st = self.status();
        proto::PeersData {
            this: proto::PeerSelf {
                id: st.self_id,
                name: st.self_name,
                sharing: st.enabled && st.port.is_some(),
                addresses: st.addresses,
            },
            peers: st.peers.iter().map(peer_info).collect(),
            nearby: st
                .nearby
                .iter()
                .map(|n| proto::NearbyInfo {
                    id: n.id.clone(),
                    name: n.name.clone(),
                    address: SocketAddr::new(n.address.parse().unwrap_or(IpAddr::from([0, 0, 0, 0])), n.port).to_string(),
                    version: n.version.clone(),
                    compatible: n.proto_ok,
                    pairing: n.pairing,
                })
                .collect(),
        }
    }
}

/// The verbs `cli_server` dispatches to (`peer list` and friends). The
/// pairing verb waits for the people, heartbeating the CLI meanwhile.
pub(crate) fn handle_verb(node: &Arc<Node>, req: &Request, _sink: &mut dyn EventSink) -> Reply {
    let id = req.id.as_str();
    match &req.cmd {
        Command::PeerList => Reply::ok(id, ReplyData::Peers(node.list_data())),
        Command::PeerRename { target, name } => match node.rename(target, name) {
            Ok(_) => Reply::ok(id, ReplyData::Peers(node.list_data())),
            Err(e) => Reply::err(id, ErrorCode::NotFound, e),
        },
        Command::PeerUnpair { target } => match node.unpair(target) {
            Ok(_) => Reply::ok(id, ReplyData::Peers(node.list_data())),
            Err(e) => Reply::err(id, ErrorCode::NotFound, e),
        },
        Command::PeerPair { target, code } => match node.pair(target, code) {
            Ok(done) => match node.find(&done.peer_id) {
                Ok(r) => Reply::ok(
                    id,
                    ReplyData::PeerPair(proto::PeerPairData { peer: peer_info(&peer_view(&r, &node.sightings())) }),
                ),
                Err(e) => Reply::err(id, ErrorCode::Internal, e),
            },
            Err(e) => Reply::err(id, ErrorCode::Auth, e),
        },
        _ => Reply::err(id, ErrorCode::BadRequest, "not a peer verb"),
    }
}

/// A new pair, as either side stores it: this side lets the other drive
/// (pairing means working together; Settings narrows it to Reply only).
/// Calls must be stamped within FRESH_WINDOW_MS of the receiver's clock;
/// pairing has no such check, so a pair with a wrong clock pairs fine and
/// then has every call refused.
fn clock_skew(name: &str, skew_ms: i64) -> String {
    let mins = skew_ms.abs() / 60_000;
    let (h, m) = (mins / 60, mins % 60);
    let amount = if h > 0 { format!("{h} h {m} min") } else { format!("{m} min") };
    let dir = if skew_ms > 0 { "ahead of" } else { "behind" };
    format!("{name}'s clock is {amount} {dir} this machine's")
}

fn clock_skew_msg(name: &str, skew_ms: i64) -> String {
    format!(
        "{}, so it refuses every call (the two must agree within 5 minutes). \
         Turn on automatic time and check the time zone on both machines.",
        clock_skew(name, skew_ms)
    )
}

fn new_record(peer: &Who, ip: IpAddr, key: &[u8; 32], their_grant: Grant) -> PeerRecord {
    PeerRecord {
        id: peer.id.clone(),
        name: clean_name(&peer.name),
        alias: None,
        key: pc::key_to_hex(key),
        grant: Grant::Drive,
        their_grant: Some(their_grant),
        paired_at_ms: now_ms(),
        last_seen_ms: Some(now_ms()),
        addr: Some(ip.to_string()),
        port: peer.port,
        version: Some(peer.version.clone()),
        proto: Some(peer.proto),
        revoked_by_peer: false,
        contacts: Vec::new(),
        note: String::new(),
    }
}

fn find_in<'a>(peers: &'a [PeerRecord], sel: &str) -> Result<&'a PeerRecord, String> {
    let sel = sel.trim();
    if sel.is_empty() {
        return Err("name the paired machine".into());
    }
    if let Some(p) = peers.iter().find(|p| p.id == sel) {
        return Ok(p);
    }
    let lower = sel.to_lowercase();
    let hits: Vec<&PeerRecord> = peers
        .iter()
        .filter(|p| {
            p.alias.as_deref().is_some_and(|a| a.to_lowercase() == lower)
                || p.name.to_lowercase() == lower
                || (sel.len() >= 6 && p.id.starts_with(&lower))
        })
        .collect();
    match hits.as_slice() {
        [one] => Ok(one),
        [] if peers.is_empty() => Err(format!(
            "no paired machine called {sel}: this machine is not paired with any (Settings > Agent access, or `termic peer pair`)"
        )),
        [] => Err(format!(
            "no paired machine called {sel} (paired: {})",
            peers.iter().map(|p| p.display_name()).collect::<Vec<_>>().join(", ")
        )),
        _ => Err(format!("more than one paired machine matches {sel}; use its id (`termic peer list`)")),
    }
}

fn peer_view(p: &PeerRecord, sightings: &[mdns::Sighting]) -> PeerView {
    let seen = sightings.iter().find(|s| s.id == p.id);
    let last_seen_ms = match (seen.map(|s| instant_ms(s.seen)), p.last_seen_ms) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    let online = seen.is_some_and(|s| s.seen.elapsed() < ONLINE_WINDOW)
        || last_seen_ms.is_some_and(|t| now_ms() - t < ONLINE_WINDOW.as_millis() as i64);
    let proto = seen.map(|s| s.proto).or(p.proto);
    PeerView {
        id: p.id.clone(),
        name: p.display_name(),
        advertised_name: seen.map(|s| s.name.clone()).unwrap_or_else(|| p.name.clone()),
        alias: p.alias.clone(),
        online,
        last_seen_ms,
        address: seen
            .map(|s| SocketAddr::new(s.addr, s.port).to_string())
            .or_else(|| p.socket().map(|a| a.to_string())),
        version: seen.map(|s| s.version.clone()).or_else(|| p.version.clone()),
        proto,
        proto_ok: proto.is_none_or(|v| v == proto::PROTOCOL_VERSION),
        grant: p.grant,
        their_grant: p.their_grant,
        revoked_by_peer: p.revoked_by_peer,
        paired_at_ms: p.paired_at_ms,
        note: p.note.clone(),
    }
}

fn peer_info(v: &PeerView) -> proto::PeerInfo {
    proto::PeerInfo {
        id: v.id.clone(),
        name: v.name.clone(),
        advertised_name: v.advertised_name.clone(),
        online: v.online,
        last_seen: v.last_seen_ms.and_then(chrono::DateTime::from_timestamp_millis).map(|t| t.to_rfc3339()),
        address: v.address.clone(),
        version: v.version.clone(),
        grant: v.grant.as_str().to_string(),
        their_grant: v.their_grant.map(|g| g.as_str().to_string()),
        revoked_by_peer: v.revoked_by_peer,
        note: (!v.note.is_empty()).then(|| v.note.clone()),
    }
}

fn unreachable_msg(name: &str, err: &str) -> String {
    format!(
        "Could not reach {name} ({err}). Check that it is awake, on this network, and has sharing turned on."
    )
}

// ───────────────────────────── sealed messages ───────────────────────

/// The plaintext inside every envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sealed {
    /// Sender's clock, ms. Outside the freshness window = refused.
    ts: i64,
    /// Random request id: a request's reply echoes it, and a replayed
    /// request is caught by it.
    rid: String,
    /// What the SENDER lets the receiver do on the sender's machine, so each
    /// side's "lets you" stays current without a message of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant: Option<Grant>,
    /// The sender's listener port, so an address change is learned in-band.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    body: serde_json::Value,
}

impl Sealed {
    fn new(body: serde_json::Value, grant: Option<Grant>) -> Sealed {
        Sealed { ts: now_ms(), rid: pc::random_hex::<{ pc::NONCE_LEN }>(), grant, port: None, body }
    }
    fn with_rid(mut self, rid: &str) -> Sealed {
        self.rid = rid.to_string();
        self
    }
    fn with_port(mut self, port: Option<u16>) -> Sealed {
        self.port = port;
        self
    }
    fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
    fn parse(b: &[u8]) -> Option<Sealed> {
        serde_json::from_slice(b).ok()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CallBody {
    /// The caller's CLI protocol. Both machines must match: a verb's fields
    /// grow between versions, and a field the other side does not know is
    /// dropped silently, which is the wrong thing to do to someone's agent.
    proto: u32,
    request: Request,
}

// ───────────────────────────── http ──────────────────────────────────

fn bind(addr: IpAddr, preferred: u16) -> Result<TcpListener, String> {
    // Tests take a port the OS hands out, never the shipped range: a
    // developer's own Termic sharing on *:23620 answered for a stopped test
    // machine's 127.0.0.1:23620, and "the peer is off" came back "refused".
    #[cfg(test)]
    if preferred == 0 {
        return TcpListener::bind((addr, 0)).map_err(|e| e.to_string());
    }
    if preferred != 0 {
        if let Ok(l) = TcpListener::bind((addr, preferred)) {
            return Ok(l);
        }
    }
    AUTO_PORTS
        .into_iter()
        .find_map(|p| TcpListener::bind((addr, p)).ok())
        .ok_or_else(|| {
            format!(
                "Could not open a network port for sharing (tried {}-{}). Another program may be using them.",
                AUTO_PORTS.start(),
                AUTO_PORTS.end()
            )
        })
}

fn serve(listener: TcpListener, node: Arc<Node>, shutdown: Arc<AtomicBool>) {
    let live = Arc::new(AtomicUsize::new(0));
    let mut failures = 0u32;
    for stream in listener.incoming() {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let stream = match stream {
            Ok(s) => {
                failures = 0;
                s
            }
            Err(e) => {
                failures += 1;
                if failures > 64 {
                    dlog(&format!("[peers] giving up after {failures} accept errors: {e}"));
                    break;
                }
                // Error path only (EMFILE and friends), never steady state.
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        if live.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            live.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
            let _ = respond(stream, 503, b"");
            continue;
        }
        let node = node.clone();
        let live = live.clone();
        let sd = shutdown.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(stream, &node, &sd);
            live.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

struct HttpReq {
    method: String,
    path: String,
    has_origin: bool,
    body: Vec<u8>,
}

/// One request, read with the same pre-auth caps as the MCP endpoint: a
/// bounded head, a body grown from bytes that arrive rather than from a
/// declared length, and a read timeout.
fn read_request(stream: &TcpStream) -> std::io::Result<Result<HttpReq, u16>> {
    let mut head = BufReader::new(stream.try_clone()?).take(MAX_HEAD);
    let mut line = String::new();
    head.read_line(&mut line)?;
    if !line.ends_with('\n') && head.limit() == 0 {
        return Ok(Err(431));
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    let mut len = 0usize;
    let mut has_origin = false;
    loop {
        let mut h = String::new();
        head.read_line(&mut h)?;
        if !h.ends_with('\n') && head.limit() == 0 {
            return Ok(Err(431));
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            match k.as_str() {
                "content-length" => match v.trim().parse() {
                    Ok(n) => len = n,
                    Err(_) => return Ok(Err(411)),
                },
                "transfer-encoding" => return Ok(Err(411)),
                "origin" => has_origin = true,
                _ => {}
            }
        }
    }
    if len > MAX_BODY {
        return Ok(Err(413));
    }
    let mut body = Vec::new();
    head.into_inner().take(len as u64).read_to_end(&mut body)?;
    if body.len() != len {
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "short body"));
    }
    Ok(Ok(HttpReq { method, path, has_origin, body }))
}

fn handle_conn(stream: TcpStream, node: &Arc<Node>, shutdown: &AtomicBool) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let src = stream.peer_addr().map(|a| canonical_ip(a.ip())).unwrap_or(IpAddr::from([0, 0, 0, 0]));
    let req = match read_request(&stream)? {
        Ok(r) => r,
        Err(status) => return respond(stream, status, b""),
    };
    // A browser page on any machine of this network can POST here. It always
    // sends Origin, so anything carrying one is refused before it can so much
    // as open a pairing dialog. Nothing here emits a CORS header.
    if req.has_origin {
        return respond(stream, 403, b"");
    }
    // Off means off for connections already open, not only for new ones.
    if shutdown.load(Ordering::SeqCst) || !(node.enabled)() {
        return respond(stream, 403, b"");
    }
    let (status, body) = route(node, &req, src);
    respond(stream, status, &body)
}

/// An IPv4 peer reached over a dual-stack socket arrives as ::ffff:a.b.c.d;
/// compare and store the plain v4 form.
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

fn route(node: &Arc<Node>, req: &HttpReq, src: IpAddr) -> (u16, Vec<u8>) {
    let Some(rest) = req.path.strip_prefix(PREFIX) else { return (404, Vec::new()) };
    match (req.method.as_str(), rest) {
        ("GET", "/hello") => json(200, &node.who()),
        ("POST", "/pair/request") => node.on_pair_request(&req.body, src),
        ("POST", "/pair/start") => node.on_pair_start(&req.body, src),
        ("POST", "/pair/confirm") => node.on_pair_confirm(&req.body, src),
        ("POST", "/call") => node.on_call(&req.body, src),
        ("POST", "/unpair") => node.on_unpair(&req.body),
        (_, "/hello" | "/pair/request" | "/pair/start" | "/pair/confirm" | "/call" | "/unpair") => (405, Vec::new()),
        _ => (404, Vec::new()),
    }
}

/// A prompt from a paired machine names it the way IT knows itself: its
/// agent signs `peer:<its own name>` (MCP_INSTRUCTIONS), say
/// `peer:DESKTOP-DO50EUS`. Here the person gave it a name of their own
/// ("windows laptop"), the one their agents and Settings use, so the
/// signature is rewritten to it on arrival. Only the sender's own name, only
/// after `peer:`, bare or quoted; the rest of the prompt is untouched, and
/// replying works either way since a selector finds a pair by both names.
fn localize_signature(cmd: Command, rec: &PeerRecord) -> Command {
    let Some(alias) = rec.alias.as_deref().map(str::trim).filter(|a| !a.is_empty() && *a != rec.name) else {
        return cmd;
    };
    let fix = |text: &str| -> String {
        let mut out = text.to_string();
        for (from, to) in [
            (format!("peer:\"{}\"", rec.name), format!("peer:\"{alias}\"")),
            (format!("peer:{}", rec.name), format!("peer:{alias}")),
        ] {
            out = replace_loosely(&out, &from, &to);
        }
        out
    };
    let mut cmd = cmd;
    match &mut cmd {
        Command::Send { prompt, .. } => *prompt = fix(prompt),
        Command::New { prompt: Some(p), .. } => *p = fix(p),
        _ => {}
    }
    cmd
}

/// One character as the loose match sees it: case folded, and typographic
/// quotes as their plain forms. A Mac calls itself `Simion’s MacBook Pro`
/// with a curly apostrophe, and an agent retyping that name in its
/// signature writes a straight one, so an exact match missed it and the
/// report arrived under the old name.
fn loose(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{02BC}' | '`' => '\'',
        '\u{201C}' | '\u{201D}' => '"',
        c => c.to_lowercase().next().unwrap_or(c),
    }
}

/// `text` with every occurrence of `from` replaced, matched character by
/// character through `loose` (case and quote style ignored).
fn replace_loosely(text: &str, from: &str, to: &str) -> String {
    let needle: Vec<char> = from.chars().map(loose).collect();
    if needle.is_empty() {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if i + needle.len() <= chars.len()
            && chars[i..i + needle.len()].iter().zip(&needle).all(|(c, n)| loose(*c) == *n)
        {
            out.push_str(to);
            i += needle.len();
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn json<T: Serialize>(status: u16, v: &T) -> (u16, Vec<u8>) {
    (status, serde_json::to_vec(v).unwrap_or_default())
}

fn respond(mut stream: TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

#[derive(Debug)]
enum HttpError {
    /// Nothing answered: the one case worth asking discovery about.
    Connect(String),
    Io(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Connect(e) | HttpError::Io(e) => f.write_str(e),
        }
    }
}

fn http(addr: SocketAddr, method: &str, path: &str, body: &[u8], budget: Duration) -> Result<(u16, Vec<u8>), String> {
    http_raw(addr, method, path, body, budget).map_err(|e| e.to_string())
}

/// A minimal HTTP/1.1 client for the peer wire: one request per
/// connection, Content-Length both ways, everything bounded.
fn http_raw(addr: SocketAddr, method: &str, path: &str, body: &[u8], budget: Duration) -> Result<(u16, Vec<u8>), HttpError> {
    let mut s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| HttpError::Connect(e.to_string()))?;
    let _ = s.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = s.set_read_timeout(Some(budget));
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let io = |e: std::io::Error| HttpError::Io(e.to_string());
    s.write_all(head.as_bytes()).map_err(io)?;
    s.write_all(body).map_err(io)?;
    s.flush().map_err(io)?;
    let mut r = BufReader::new(s);
    let mut status_line = String::new();
    r.read_line(&mut status_line).map_err(io)?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| HttpError::Io("not an HTTP answer".into()))?;
    let mut len: Option<u64> = None;
    loop {
        let mut h = String::new();
        r.read_line(&mut h).map_err(io)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok();
            }
        }
    }
    let mut out = Vec::new();
    let cap = len.unwrap_or(MAX_RESPONSE).min(MAX_RESPONSE);
    r.take(cap).read_to_end(&mut out).map_err(io)?;
    Ok((status, out))
}

/// The first candidate address that answers `hello` as a Termic.
fn probe(candidates: &[SocketAddr]) -> Result<(SocketAddr, Who), String> {
    let mut last = String::from("nothing answered");
    for addr in candidates {
        match http(*addr, "GET", &format!("{PREFIX}/hello"), b"", Duration::from_secs(5)) {
            Ok((200, body)) => match serde_json::from_slice::<Who>(&body) {
                Ok(who) if who.id.len() == 32 => return Ok((*addr, who)),
                _ => last = format!("{addr} is not a Termic"),
            },
            Ok((403, _)) => last = format!("{addr} has sharing turned off"),
            Ok((s, _)) => last = format!("{addr} answered {s}"),
            Err(e) => last = e,
        }
    }
    Err(format!(
        "No Termic answered there ({last}). Check the address, and that the other machine has sharing turned on."
    ))
}

// ───────────────────────────── app wiring ────────────────────────────

struct TauriUi(tauri::AppHandle);

impl PeerUi for TauriUi {
    fn changed(&self) {
        use tauri::Emitter;
        let _ = self.0.emit("peer://changed", ());
    }
    fn pairing(&self, view: &PairingView) {
        use tauri::Emitter;
        let _ = self.0.emit("peer://pairing", view);
    }
}

fn node_slot() -> &'static Mutex<Option<Arc<Node>>> {
    static NODE: OnceLock<Mutex<Option<Arc<Node>>>> = OnceLock::new();
    NODE.get_or_init(|| Mutex::new(None))
}

/// The app's node, created on first use. Exists whether or not sharing is
/// on: the pair list, renames and unpairing work with the listener off.
pub(crate) fn node() -> Option<Arc<Node>> {
    node_slot().lock().unwrap().clone()
}

fn ensure_node(app: &tauri::AppHandle) -> Option<Arc<Node>> {
    let mut slot = node_slot().lock().unwrap();
    if slot.is_none() {
        let dir = crate::global_dir().ok()?;
        let host: Arc<dyn CliHost> = Arc::new(crate::cli_server::tauri_host(app.clone(), String::new()));
        *slot = Some(Node::new(
            dir,
            host,
            Arc::new(TauriUi(app.clone())),
            Box::new(|| crate::load_settings_inner().lan_sharing_enabled),
            app.package_info().version.to_string(),
        ));
    }
    slot.clone()
}

/// Setup hook: create the node, and bind if the setting is on.
pub(crate) fn start_if_enabled(app: tauri::AppHandle) {
    let on = crate::load_settings_inner().lan_sharing_enabled;
    // Off the main thread: binding is quick, but discovery joins multicast
    // groups on every interface, and a slow network stack is not a reason
    // for the window to wait.
    std::thread::spawn(move || apply_enabled(app, on));
}

/// The one switch, idempotent both ways (settings_save calls it on every save).
pub(crate) fn apply_enabled(app: tauri::AppHandle, on: bool) {
    let Some(node) = ensure_node(&app) else { return };
    match (on, node.port().is_some()) {
        (true, false) => node.start(),
        (false, true) => node.stop(),
        _ => {}
    }
}

// ── Tauri commands ───────────────────────────────────────────────────

fn need(app: &tauri::AppHandle) -> Result<Arc<Node>, String> {
    ensure_node(app).ok_or_else(|| "no data directory".to_string())
}

#[tauri::command]
pub(crate) fn peer_status(app: tauri::AppHandle) -> Result<PeerStatus, String> {
    Ok(need(&app)?.status())
}

#[tauri::command]
pub(crate) fn peer_set_name(app: tauri::AppHandle, name: String) -> Result<(), String> {
    need(&app)?.set_name(&name);
    Ok(())
}

#[tauri::command]
pub(crate) async fn peer_pair(app: tauri::AppHandle, target: String, code: String) -> Result<PairingView, String> {
    let node = need(&app)?;
    tauri::async_runtime::spawn_blocking(move || node.pair(&target, &code)).await.map_err(|e| e.to_string())?
}

/// Ask another machine to show a pairing code. Returns its name.
#[tauri::command]
pub(crate) async fn peer_pair_request(app: tauri::AppHandle, target: String) -> Result<String, String> {
    let node = need(&app)?;
    tauri::async_runtime::spawn_blocking(move || node.request_pair(&target)).await.map_err(|e| e.to_string())?
}

/// Open (fresh code) or close pairing mode.
#[tauri::command]
pub(crate) fn peer_pair_mode(app: tauri::AppHandle, open: bool) -> Result<Option<PairModeView>, String> {
    let node = need(&app)?;
    if open {
        node.open_pair_mode().map(Some)
    } else {
        node.close_pair_mode();
        Ok(None)
    }
}

#[tauri::command]
pub(crate) fn peer_rename(app: tauri::AppHandle, peer: String, name: String) -> Result<(), String> {
    need(&app)?.rename(&peer, &name).map(|_| ())
}

#[tauri::command]
pub(crate) fn peer_set_note(app: tauri::AppHandle, peer: String, note: String) -> Result<(), String> {
    need(&app)?.set_note(&peer, &note)
}

#[tauri::command]
pub(crate) fn peer_set_grant(app: tauri::AppHandle, peer: String, grant: String) -> Result<(), String> {
    let grant = Grant::parse(&grant).ok_or("unknown grant")?;
    need(&app)?.set_grant(&peer, grant)
}

#[tauri::command]
pub(crate) async fn peer_unpair(app: tauri::AppHandle, peer: String) -> Result<(), String> {
    let node = need(&app)?;
    tauri::async_runtime::spawn_blocking(move || node.unpair(&peer).map(|_| ())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn peer_refresh(app: tauri::AppHandle) -> Result<(), String> {
    need(&app)?.refresh();
    Ok(())
}

// ───────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_server::test_support::StubHost;

    #[derive(Default)]
    struct RecUi {
        pairings: Mutex<Vec<PairingView>>,
        changes: AtomicUsize,
    }
    impl PeerUi for RecUi {
        fn changed(&self) {
            self.changes.fetch_add(1, Ordering::SeqCst);
        }
        fn pairing(&self, view: &PairingView) {
            self.pairings.lock().unwrap().push(view.clone());
        }
    }

    struct Machine {
        node: Arc<Node>,
        ui: Arc<RecUi>,
        host: Arc<StubHost>,
        _dir: tempfile::TempDir,
    }

    fn machine(name: &str) -> Machine {
        machine_with(name, Arc::new(StubHost::default()))
    }

    fn machine_with(name: &str, host: Arc<StubHost>) -> Machine {
        let dir = tempfile::tempdir().unwrap();
        let ui = Arc::new(RecUi::default());
        let node = Node::new(dir.path().to_path_buf(), host.clone(), ui.clone(), Box::new(|| true), "9.9.9".into());
        node.set_name(name);
        node.start_on(IpAddr::from([127, 0, 0, 1]), false);
        assert!(node.port().is_some(), "{:?}", node.bind_error.lock().unwrap());
        Machine { node, ui, host, _dir: dir }
    }

    fn addr(m: &Machine) -> String {
        format!("127.0.0.1:{}", m.node.port().unwrap())
    }

    /// B opens pairing mode, A types its code. Both sides then let each
    /// other drive; the grants are narrowed after, as a person would in
    /// Settings, and the next call tells each side what the other allows.
    fn pair(a: &Machine, b: &Machine, grant_a: Grant, grant_b: Grant) -> PairingView {
        let code = b.node.open_pair_mode().unwrap().code;
        let done = a.node.pair(&addr(b), &code).unwrap();
        assert_eq!(done.direction, Direction::Outgoing);
        assert!(b.node.find(&a.node.self_id()).is_ok(), "B stored the pair before answering");
        a.node.set_grant(&b.node.self_id(), grant_a).unwrap();
        b.node.set_grant(&a.node.self_id(), grant_b).unwrap();
        done
    }

    fn call(a: &Machine, peer: &str, cmd: Command, from_task: Option<&str>) -> Reply {
        let req = Request {
            id: "r1".into(),
            token: None,
            profile: None,
            peer: Some(peer.into()),
            from_task: from_task.map(str::to_string),
            cmd,
        };
        a.node.forward(&req, &mut crate::mcp_server::NoopSink)
    }

    #[test]
    fn a_prompt_from_a_pair_is_signed_with_the_name_given_here() {
        let mut rec = new_record(
            &Who { id: "a".repeat(32), name: "DESKTOP-DO50EUS".into(), version: "1".into(), proto: 1, pv: PV, port: 1 },
            IpAddr::from([127, 0, 0, 1]),
            &[0u8; 32],
            Grant::Drive,
        );
        let send = |p: &str| Command::Send {
            task: Some("t".into()), project: None, prompt: p.into(), prompt_ref: None, resume: false,
            fresh: false, wait: false, timeout_ms: None, tab: None, now: false, cwd: None,
        };
        let text = |c: Command| match c { Command::Send { prompt, .. } => prompt, _ => unreachable!() };
        // No alias: untouched.
        let p = "[message from agent:claude task:x id:1 peer:DESKTOP-DO50EUS] hi";
        assert_eq!(text(localize_signature(send(p), &rec)), p);
        rec.alias = Some("windows laptop".into());
        assert_eq!(
            text(localize_signature(send("[message from agent:claude peer:desktop-do50eus id:1] done -- peer:\"DESKTOP-DO50EUS\""), &rec)),
            "[message from agent:claude peer:windows laptop id:1] done -- peer:\"windows laptop\""
        );
        // Quote style does not matter: the name it gives itself has a curly
        // apostrophe, the agent retyped a straight one.
        rec.name = "Simion\u{2019}s MacBook Pro (2)".into();
        rec.alias = Some("orchestrator".into());
        assert_eq!(
            text(localize_signature(send("[message from agent:claude peer:Simion's MacBook Pro (2)] done"), &rec)),
            "[message from agent:claude peer:orchestrator] done"
        );
        rec.name = "DESKTOP-DO50EUS".into();
        rec.alias = Some("windows laptop".into());
        // Only after `peer:`: the name elsewhere in the text stays.
        assert_eq!(text(localize_signature(send("built on DESKTOP-DO50EUS"), &rec)), "built on DESKTOP-DO50EUS");
    }

    #[test]
    fn clicking_pair_makes_the_other_machine_show_the_code() {
        let (a, b) = (machine("Studio"), machine("Laptop"));
        assert!(b.node.pair_mode_view().is_none());
        // A's person clicks Pair on B: B opens pairing mode on its own and
        // says who asked, so its screen can show the code for A to type.
        assert_eq!(a.node.request_pair(&addr(&b)).unwrap(), "Laptop");
        let shown = b.node.pair_mode_view().expect("B shows a code");
        assert_eq!(shown.requested_by.as_deref(), Some("Studio"));
        // A second ask does not swap the code under the first person.
        a.node.request_pair(&addr(&b)).unwrap();
        assert_eq!(b.node.pair_mode_view().unwrap().code, shown.code);
        // A types it, and they are paired.
        a.node.pair(&addr(&b), &shown.code).unwrap();
        assert!(b.node.find("Studio").is_ok());
    }

    #[test]
    fn two_machines_pair_and_both_hold_the_same_key() {
        let (a, b) = (machine("Studio"), machine("Laptop"));
        let code = b.node.open_pair_mode().unwrap().code;
        a.node.pair(&addr(&b), &code).unwrap();
        let ra = a.node.find("Laptop").unwrap();
        let rb = b.node.find("Studio").unwrap();
        assert_eq!(ra.key, rb.key);
        assert_eq!(ra.key.len(), 64);
        // Pairing means working together: each lets the other drive, and
        // learned that the other does.
        assert_eq!((ra.grant, ra.their_grant), (Grant::Drive, Some(Grant::Drive)));
        assert_eq!((rb.grant, rb.their_grant), (Grant::Drive, Some(Grant::Drive)));
        // Both dialogs hear about it, each from its own side.
        assert_eq!(a.ui.pairings.lock().unwrap().last().unwrap().direction, Direction::Outgoing);
        let on_b = b.ui.pairings.lock().unwrap().last().unwrap().clone();
        assert_eq!((on_b.direction, on_b.peer_name.as_str()), (Direction::Incoming, "Studio"));
        // Pairing mode closed on success: the code is spent.
        assert!(b.node.status().pair_mode.is_none());
        // And persisted it, owner-only.
        let path = a._dir.path().join(PEERS_FILE);
        let on_disk: Store = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk.peers.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0);
        }
    }

    #[test]
    fn a_machine_not_in_pairing_mode_pairs_with_nobody() {
        let (a, b) = (machine("A"), machine("B"));
        let err = a.node.pair(&addr(&b), "1234").unwrap_err();
        assert!(err.contains("no longer showing a code"), "{err}");
        assert!(a.node.find("B").is_err() && b.node.find("A").is_err());
        assert!(b.ui.pairings.lock().unwrap().is_empty(), "nothing appears on B's screen");
    }

    #[test]
    fn a_wrong_code_pairs_nobody_and_three_close_pairing_mode() {
        let (a, b) = (machine("A"), machine("B"));
        let code = b.node.open_pair_mode().unwrap().code;
        let wrong = if code == "0000" { "0001" } else { "0000" };
        let err = a.node.pair(&addr(&b), wrong).unwrap_err();
        assert!(err.contains("not the code"), "{err}");
        assert!(a.node.find("B").is_err() && b.node.find("A").is_err());
        assert_eq!(b.node.status().pair_mode.unwrap().wrong_codes, 1);
        // The right code still works after a typo.
        a.node.pair(&addr(&b), &code).unwrap();
        assert!(b.node.find("A").is_ok());

        // Three wrong codes and the mode closes, so a guesser gets three
        // tries per time a person opens it.
        let (c, d) = (machine("C"), machine("D"));
        let code = d.node.open_pair_mode().unwrap().code;
        let wrongs: Vec<String> = (0..10_000).map(|n| format!("{n:04}")).filter(|w| *w != code).take(3).collect();
        for w in &wrongs {
            assert!(c.node.pair(&addr(&d), w).unwrap_err().contains("not the code"));
        }
        assert!(d.node.status().pair_mode.is_none(), "closed after three wrong codes");
        let err = c.node.pair(&addr(&d), &code).unwrap_err();
        assert!(err.contains("no longer showing a code"), "the old code is dead: {err}");
    }

    #[test]
    fn a_code_is_four_digits_before_anything_is_sent() {
        let (a, b) = (machine("A"), machine("B"));
        b.node.open_pair_mode().unwrap();
        for bad in ["", "123", "12345", "12a4"] {
            let err = a.node.pair(&addr(&b), bad).unwrap_err();
            assert!(err.contains("4 digits"), "{bad}: {err}");
        }
        assert_eq!(b.node.status().pair_mode.unwrap().wrong_codes, 0, "a malformed code is not a guess");
    }

    #[test]
    fn pairing_mode_expires_and_reopening_gives_a_new_code() {
        let b = machine("B");
        let first = b.node.open_pair_mode().unwrap().code;
        let mut codes = std::collections::HashSet::new();
        codes.insert(first);
        for _ in 0..5 {
            codes.insert(b.node.open_pair_mode().unwrap().code);
        }
        assert!(codes.len() > 1, "reopening draws a fresh code");
        assert!(b.node.advert(1).pairing, "the advert says ready to pair");
        let deadline = Instant::now() + PAIR_MODE_TTL + Duration::from_secs(3);
        while b.node.status().pair_mode.is_some() || b.node.advert(1).pairing {
            assert!(Instant::now() < deadline, "pairing mode never expired");
            std::thread::sleep(Duration::from_millis(50));
        }
        b.node.close_pair_mode();
        assert!(!b.node.advert(1).pairing);
    }

    #[test]
    fn one_incoming_pairing_at_a_time() {
        let b = machine("B");
        b.node.open_pair_mode().unwrap();
        let target: SocketAddr = addr(&b).parse().unwrap();
        let start = |id: &str| {
            let (_, msg) = pc::Pake::start_a("1234", id, &b.node.self_id());
            let body = serde_json::json!({ "from": { "id": id, "name": "x", "pv": PV }, "msg": pc::b64(&msg) });
            http(target, "POST", &format!("{PREFIX}/pair/start"), body.to_string().as_bytes(), Duration::from_secs(5)).unwrap().0
        };
        assert_eq!(start(&"a".repeat(32)), 200);
        assert_eq!(start(&"c".repeat(32)), 429, "the second waits its turn");
    }

    #[test]
    fn a_drive_peer_runs_verbs_and_a_reply_peer_only_answers_its_contacts() {
        let (a, b) = (machine("Mac"), machine("Win"));
        // Mac lets Win only reply; Win lets Mac drive.
        pair(&a, &b, Grant::Reply, Grant::Drive);

        // Mac drives Win: list goes through to Win's dispatch.
        let r = call(&a, "Win", Command::List { project: None, quiet: false }, Some("t-mac-1"));
        assert!(r.ok, "{r:?}");
        assert!(matches!(r.data, Some(ReplyData::List(_))));

        // Win may not list Mac's tasks: reply only.
        let r = call(&b, "Mac", Command::List { project: None, quiet: false }, None);
        assert_eq!(r.error.unwrap().code, ErrorCode::Auth);

        // Even Drive may not quit the other machine.
        let r = call(&a, "Win", Command::Quit { commit: true }, None);
        assert_eq!(r.error.as_ref().unwrap().code, ErrorCode::Auth, "{r:?}");
        assert_eq!(*b.host.quit_calls.lock().unwrap(), 0);

        // Nor reach the peer verbs there, or chain to a third machine.
        let r = call(&a, "Win", Command::PeerList, None);
        assert_eq!(r.error.unwrap().code, ErrorCode::BadRequest);
    }

    #[test]
    fn a_report_back_skips_the_queue_and_new_work_does_not() {
        let host = StubHost::default();
        let (projects, tasks) = host.projects_tasks();
        let qualified = |t: &crate::Task| format!("{}/{}", projects.iter().find(|p| p.id == t.project_id).unwrap().name, t.name);
        let (asked, other) = (&tasks[0], &tasks[1]);
        let send = |task: String, now: bool| Command::Send {
            task: Some(task), project: None, prompt: "done".into(), prompt_ref: None, resume: false,
            fresh: false, wait: false, timeout_ms: None, tab: None, now, cwd: None,
        };
        let now_of = |c: Command| match c { Command::Send { now, .. } => now, _ => unreachable!() };
        let contacts = vec![asked.id.clone()];
        // Into the task that sent this machine work: delivered at once.
        assert!(now_of(report_back_now(send(qualified(asked), false), &contacts, &host)));
        // Into any other task: new work, so it queues.
        assert!(!now_of(report_back_now(send(qualified(other), false), &contacts, &host)));
        // An explicit now is kept either way.
        assert!(now_of(report_back_now(send(qualified(other), true), &contacts, &host)));
    }

    #[test]
    fn a_reply_peer_reaches_a_task_that_contacted_it_and_no_other() {
        let host = StubHost::default();
        let t1 = host.tasks.iter().find(|t| t.name == "solo").map(|t| t.id.clone());
        let (a, b) = (machine_with("Mac", Arc::new(host)), machine("Win"));
        pair(&a, &b, Grant::Reply, Grant::Drive);
        let Some(t1) = t1 else {
            // The stub's fixture tasks are what this test addresses; if they
            // are renamed this needs the new name, not a silent pass.
            panic!("StubHost fixture changed: pick a task name unique to one project");
        };
        let send = |task: &str| Command::Send {
            task: Some(task.into()),
            project: None,
            prompt: "done".into(),
            prompt_ref: None,
            resume: false,
            fresh: false,
            wait: false,
            timeout_ms: None,
            tab: None,
            now: false,
            cwd: None,
        };
        // Before t1 ever called Win, Win cannot prompt it.
        let r = call(&b, "Mac", send(&t1), None);
        assert_eq!(r.error.unwrap().code, ErrorCode::Auth);
        // t1 calls Win (the orchestrator handing out work)...
        let _ = call(&a, "Win", Command::List { project: None, quiet: false }, Some(&t1));
        // ...and now Win's reply into t1 is let through to dispatch. The stub
        // has no webview, so the send itself fails there, but past the grant.
        let r = call(&b, "Mac", send(&t1), None);
        assert_ne!(r.error.map(|e| e.code), Some(ErrorCode::Auth));
        // A reply, not a restart: no fresh agent, no resumed session.
        let mut restart = send(&t1);
        if let Command::Send { fresh, .. } = &mut restart {
            *fresh = true;
        }
        let r = call(&b, "Mac", restart, None);
        assert_eq!(r.error.map(|e| e.code), Some(ErrorCode::Auth));
    }

    #[test]
    fn calls_carry_no_caller_paths_to_the_other_machine() {
        let cmd = Command::Status { task: None, project: None, cwd: Some("/Users/alice/repo".into()) };
        let Command::Status { cwd, .. } = sanitize(&cmd) else { unreachable!() };
        assert_eq!(cwd, None);
        let cmd = Command::Group {
            task: None,
            project: None,
            name: None,
            color: None,
            cwd: Some("/Users/u".into()),
            caller_task: Some("t1".into()),
            join: None,
            leave: false,
        };
        let Command::Group { cwd, caller_task, .. } = sanitize(&cmd) else { unreachable!() };
        assert_eq!((cwd, caller_task), (None, None));
    }

    #[test]
    fn unpair_revokes_on_both_sides() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        a.node.unpair("B").unwrap();
        assert!(a.node.find("B").is_err());
        assert!(b.node.find("A").is_err(), "the notice reached B");
        // B's next call is refused, not quietly served.
        let r = call(&b, "A", Command::List { project: None, quiet: false }, None);
        assert!(r.error.is_some());
    }

    #[test]
    fn an_offline_unpair_leaves_the_peer_refused_and_told() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        // B is "offline" when A unpairs: A forgets, B never hears.
        b.node.stop();
        a.node.unpair("B").unwrap();
        b.node.start_on(IpAddr::from([127, 0, 0, 1]), false);
        let r = call(&b, "A", Command::List { project: None, quiet: false }, None);
        assert_eq!(r.error.unwrap().code, ErrorCode::Auth);
        assert!(b.node.find("A").unwrap().revoked_by_peer, "B shows it is no longer paired there");
    }

    #[test]
    fn unpaired_and_forged_callers_get_the_same_bare_401() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let target: SocketAddr = addr(&b).parse().unwrap();
        let path = format!("{PREFIX}/call");
        // Not JSON, an unknown sender, a sealed message under the wrong key.
        let stranger = pc::seal(&[1u8; 32], &path, &"f".repeat(32), &b.node.self_id(), b"{}");
        let wrong_key = pc::seal(&[1u8; 32], &path, &a.node.self_id(), &b.node.self_id(), b"{}");
        for body in [b"nonsense".to_vec(), serde_json::to_vec(&stranger).unwrap(), serde_json::to_vec(&wrong_key).unwrap()] {
            let (status, out) = http(target, "POST", &path, &body, Duration::from_secs(5)).unwrap();
            assert_eq!((status, out.len()), (401, 0));
        }
    }

    #[test]
    fn a_replayed_call_is_refused() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let key = a.node.find("B").unwrap().key().unwrap();
        let path = format!("{PREFIX}/call");
        let req = Request {
            id: "r".into(),
            token: None,
            profile: None,
            peer: None,
            from_task: None,
            cmd: Command::List { project: None, quiet: false },
        };
        let msg = Sealed::new(serde_json::to_value(CallBody { proto: proto::PROTOCOL_VERSION, request: req }).unwrap(), None);
        let env = pc::seal(&key, &path, &a.node.self_id(), &b.node.self_id(), &msg.to_bytes());
        let body = serde_json::to_vec(&env).unwrap();
        let target: SocketAddr = addr(&b).parse().unwrap();
        assert_eq!(http(target, "POST", &path, &body, Duration::from_secs(5)).unwrap().0, 200);
        assert_eq!(http(target, "POST", &path, &body, Duration::from_secs(5)).unwrap().0, 401, "same bytes twice");

        // And a stale one, sealed correctly but ten minutes old.
        let mut old = Sealed::new(msg.body.clone(), None);
        old.ts -= 600_000;
        let env = pc::seal(&key, &path, &a.node.self_id(), &b.node.self_id(), &old.to_bytes());
        let (status, out) = http(target, "POST", &path, &serde_json::to_vec(&env).unwrap(), Duration::from_secs(5)).unwrap();
        assert_eq!(status, 409, "the paired machine with a wrong clock is told so, not refused as a stranger");
        let e: pc::Envelope = serde_json::from_slice(&out).unwrap();
        let theirs = Sealed::parse(&pc::open(&key, &path, &a.node.self_id(), &e).unwrap()).unwrap();
        assert!((theirs.ts - now_ms()).abs() < 5_000, "the answer carries B's clock");

        // The same stale message from an unpaired key is still the bare 401.
        let env = pc::seal(&[7u8; 32], &path, &a.node.self_id(), &b.node.self_id(), &old.to_bytes());
        let (status, out) = http(target, "POST", &path, &serde_json::to_vec(&env).unwrap(), Duration::from_secs(5)).unwrap();
        assert_eq!((status, out.len()), (401, 0));
    }

    #[test]
    fn a_pairing_from_a_clock_hours_off_is_refused_and_stores_nothing() {
        let (a, b) = (machine("A"), machine("B"));
        let code = b.node.open_pair_mode().unwrap().code;
        let target: SocketAddr = addr(&b).parse().unwrap();
        let (me, them) = (a.node.who(), b.node.self_id());
        let (pake, msg_a) = pc::Pake::start_a(&code, &me.id, &them);
        let start = serde_json::json!({ "from": me, "msg": pc::b64(&msg_a) });
        let (status, body) = http(target, "POST", &format!("{PREFIX}/pair/start"), start.to_string().as_bytes(), Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        let started: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let secret = pake.finish(&pc::unb64(started["msg"].as_str().unwrap()).unwrap()).unwrap();
        let key = pc::pair_key(&secret, &me.id, &them);
        let path = format!("{PREFIX}/pair/confirm");
        // The right code, from a machine whose clock is 8 hours ahead.
        let mut msg = Sealed::new(serde_json::json!({ "grant": Grant::Drive }), None);
        msg.ts += 8 * 3_600_000;
        let env = pc::seal(&key, &path, &me.id, &them, &msg.to_bytes());
        let confirm = serde_json::json!({ "pairing": started["pairing"], "env": env });
        let (status, out) = http(target, "POST", &path, confirm.to_string().as_bytes(), Duration::from_secs(5)).unwrap();
        assert_eq!(status, 409);
        let e: pc::Envelope = serde_json::from_slice(&out).unwrap();
        let theirs = Sealed::parse(&pc::open(&key, &path, &me.id, &e).unwrap()).unwrap();
        assert_eq!(theirs.rid, msg.rid);
        assert!((theirs.ts - now_ms()).abs() < 5_000, "the answer carries B's clock");
        assert!(b.node.find(&me.id).is_err(), "B stored no pair");
        assert!(b.node.pair_mode_view().is_none(), "B closed pairing mode");
        assert!(b.ui.pairings.lock().unwrap().is_empty());
    }

    #[test]
    fn clock_skew_is_worded_with_its_size_and_direction() {
        assert_eq!(
            clock_skew_msg("win", 477 * 60_000 + 30_000),
            "win's clock is 7 h 57 min ahead of this machine's, so it refuses every call (the two must agree within 5 minutes). Turn on automatic time and check the time zone on both machines."
        );
        assert!(clock_skew_msg("win", -6 * 60_000).contains("6 min behind"));
    }

    #[test]
    fn a_browser_cannot_open_a_pairing_dialog() {
        let b = machine("B");
        let mut s = TcpStream::connect(addr(&b)).unwrap();
        b.node.open_pair_mode().unwrap();
        let body = r#"{"from":{"id":"ffffffffffffffffffffffffffffffff","name":"x","pv":2},"msg":"AAAA"}"#;
        write!(
            s,
            "POST {PREFIX}/pair/start HTTP/1.1\r\nHost: x\r\nOrigin: http://evil.example.io\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 403"), "{out}");
        assert!(b.node.incoming.lock().unwrap().is_none(), "the request never reached pairing");
    }

    #[test]
    fn sharing_off_refuses_everything_and_hello_says_nothing_extra() {
        let b = machine("B");
        let target: SocketAddr = addr(&b).parse().unwrap();
        let (status, body) = http(target, "GET", &format!("{PREFIX}/hello"), b"", Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        let who: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let mut keys: Vec<_> = who.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["id", "name", "port", "proto", "pv", "version"]);

        let off = {
            let dir = tempfile::tempdir().unwrap();
            let node = Node::new(dir.path().into(), Arc::new(StubHost::default()), Arc::new(RecUi::default()), Box::new(|| false), "1".into());
            node.start_on(IpAddr::from([127, 0, 0, 1]), false);
            (node, dir)
        };
        let target = SocketAddr::from(([127, 0, 0, 1], off.0.port().unwrap()));
        assert_eq!(http(target, "GET", &format!("{PREFIX}/hello"), b"", Duration::from_secs(5)).unwrap().0, 403);
    }

    #[test]
    fn rename_is_local_and_a_selector_finds_by_alias_name_or_id() {
        let (a, b) = (machine("Mac"), machine("Win"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let id = b.node.self_id();
        a.node.rename("Win", "Gaming laptop").unwrap();
        assert_eq!(a.node.find("gaming laptop").unwrap().id, id);
        assert_eq!(a.node.find("Win").unwrap().id, id, "its own name still works");
        assert_eq!(a.node.find(&id[..8]).unwrap().id, id);
        assert!(a.node.find(&id[..3]).is_err(), "too short a prefix is not a selector");
        // Back to its own name.
        a.node.rename(&id, "").unwrap();
        assert_eq!(a.node.find(&id).unwrap().alias, None);
        // The other side never heard of it.
        assert_eq!(b.node.find("Mac").unwrap().alias, None);
    }

    #[test]
    fn a_note_is_local_one_line_capped_and_reaches_the_instructions() {
        let (a, b) = (machine("Mac"), machine("Win"));
        assert_eq!(a.node.instructions(), "", "nothing paired, nothing said");
        pair(&a, &b, Grant::Drive, Grant::Drive);
        a.node.set_note("Win", "  Windows builds\n and   installer tests ").unwrap();
        assert_eq!(a.node.find("Win").unwrap().note, "Windows builds and installer tests");
        let text = a.node.instructions();
        assert!(text.contains("Paired machines"), "{text}");
        assert!(text.contains("\n- Win: Windows builds and installer tests"), "{text}");
        // It goes out in peer list, and the other side never heard of it.
        assert_eq!(a.node.list_data().peers[0].note.as_deref(), Some("Windows builds and installer tests"));
        assert_eq!(b.node.find("Mac").unwrap().note, "");
        a.node.set_note("Win", &"x".repeat(500)).unwrap();
        assert_eq!(a.node.find("Win").unwrap().note.chars().count(), NOTE_MAX);
        // Cleared, it is gone from peer list rather than an empty string.
        a.node.set_note("Win", "   ").unwrap();
        assert_eq!(a.node.list_data().peers[0].note, None);
    }

    #[test]
    fn calling_a_machine_that_is_off_is_peer_unreachable() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        b.node.stop();
        let r = call(&a, "B", Command::List { project: None, quiet: false }, None);
        assert_eq!(r.error.unwrap().code, ErrorCode::PeerUnreachable);
    }

    #[test]
    fn a_protocol_mismatch_is_named_not_mis_run() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let key = a.node.find("B").unwrap().key().unwrap();
        let path = format!("{PREFIX}/call");
        let req = Request { id: "r".into(), token: None, profile: None, peer: None, from_task: None, cmd: Command::PeerList };
        let msg = Sealed::new(serde_json::to_value(CallBody { proto: 1, request: req }).unwrap(), None);
        let env = pc::seal(&key, &path, &a.node.self_id(), &b.node.self_id(), &msg.to_bytes());
        let target: SocketAddr = addr(&b).parse().unwrap();
        let (status, body) = http(target, "POST", &path, &serde_json::to_vec(&env).unwrap(), Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        let env: pc::Envelope = serde_json::from_slice(&body).unwrap();
        let plain = Sealed::parse(&pc::open(&key, &path, &a.node.self_id(), &env).unwrap()).unwrap();
        let reply: Reply = serde_json::from_value(plain.body["reply"].clone()).unwrap();
        let err = reply.error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("protocol"), "{}", err.message);
    }

    #[test]
    fn streamed_verbs_heartbeat_while_the_peer_works() {
        struct Count(usize);
        impl EventSink for Count {
            fn emit(&mut self, ev: &StreamEvent) -> std::io::Result<()> {
                assert_eq!(ev.event, "heartbeat");
                self.0 += 1;
                Ok(())
            }
        }
        // A "peer" that holds the answer for a while.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let _ = read_request(&s);
            std::thread::sleep(Duration::from_millis(300));
            let _ = respond(s, 200, b"{}");
        });
        let node = machine("A").node;
        let mut sink = Count(0);
        let r = node.call_with_heartbeat(target, "/x", b"{}".to_vec(), Duration::from_secs(5), true, "r", &mut sink);
        assert_eq!(r.unwrap().0, 200);
        assert!(sink.0 >= 2, "heartbeats: {}", sink.0);
        assert!(streamed(&Command::Wait { task: None, project: None, timeout_ms: None, tab: None, cwd: None }));
        assert!(!streamed(&Command::List { project: None, quiet: false }));
    }

    #[test]
    fn a_corrupt_store_is_set_aside_not_silently_reused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PEERS_FILE), "{ not json").unwrap();
        let s = load_store(dir.path());
        assert_eq!(s.id.len(), 32);
        assert!(dir.path().join(format!("{PEERS_FILE}.unreadable")).exists());
        // The id is stable across loads.
        assert_eq!(load_store(dir.path()).id, s.id);
    }

    #[test]
    fn names_are_one_bounded_line() {
        assert_eq!(clean_name("  Alice's\nMac  "), "Alice'sMac");
        assert_eq!(clean_name(&"x".repeat(100)).chars().count(), 60);
    }
}
