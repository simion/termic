//! LAN pairing (docs/peers.md): Termic on two machines of one network
//! finding each other, pairing with a code both people confirm, and then
//! letting an agent on one drive (or report back to) the agents on the other.
//!
//! The pieces, in the order a request meets them:
//!
//! - **Discovery** is `mdns.rs` (`_termic._tcp`). It only finds; nothing it
//!   says is trusted, and pairing works without it (pair by address).
//! - **The peer listener** is one TCP port on every interface, bound only
//!   while LAN sharing is on (Settings > Remote control). Its surface:
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

/// Whether a Termic at `version` works with this one as a paired computer:
/// at least termic_remote::compat::REQUIRES_DESKTOP, not the same release
/// (most releases change nothing on the wire). A machine whose version is
/// unknown or unreadable falls back to the old rule, the same CLI
/// protocol. The other machine applies its own floor to this one.
pub(crate) fn peer_compatible(version: Option<&str>, proto: Option<u32>) -> bool {
    match version.filter(|v| termic_remote::compat::core(v).is_some()) {
        Some(v) => termic_remote::compat::at_least(v, termic_remote::compat::REQUIRES_DESKTOP),
        None => proto.is_none_or(|p| p == proto::PROTOCOL_VERSION),
    }
}
const PREFIX: &str = "/termic-peer/v1";
/// The remote-control stream (remote_server.rs, docs/remote.md).
pub(crate) const STREAM_PATH: &str = "/termic-peer/v1/stream";
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
    pub(crate) fn as_str(self) -> &'static str {
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
                     in Settings > Remote control."
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
    /// Phones paired by scanning this machine's QR code (docs/remote.md).
    /// A phone is a remote control of THIS machine: it never runs anything
    /// itself and is never driven, so it has a key and nothing else.
    phones: Vec<PhoneRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PhoneRecord {
    /// The id the phone generated for itself (32 hex).
    id: String,
    /// What the phone calls itself ("Alice's iPhone"), from its hello.
    name: String,
    /// The pair key the QR code carried, hex. Never leaves this file.
    key: String,
    paired_at_ms: i64,
    last_seen_ms: Option<i64>,
    addr: Option<String>,
    /// Where to push to it while it is away (push.rs). Set by the phone.
    push: Option<PushTarget>,
}

/// A phone's push token and the service it belongs to ("ios" = APNs,
/// "android" = FCM).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct PushTarget {
    pub platform: String,
    pub token: String,
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

/// A phone paired with this machine.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PhoneView {
    pub id: String,
    pub name: String,
    pub paired_at_ms: i64,
    pub last_seen_ms: Option<i64>,
    /// Has a live connection right now.
    pub connected: bool,
}

/// The QR code this machine shows while a phone may pair: one key, used
/// once, gone after `PAIR_MODE_TTL`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PhonePairingView {
    /// `termic-remote://pair?...`: what the QR encodes. Carries the key;
    /// shown only as the code, never as text.
    pub link: String,
    /// The QR code, as an SVG document.
    pub svg: String,
    pub expires_at_ms: i64,
    /// Where the phone will try to reach this machine, in order.
    pub addresses: Vec<String>,
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
    pub phones: Vec<PhoneView>,
    /// Open while this machine shows a phone pairing QR code.
    pub phone_pairing: Option<PhonePairingView>,
    /// Ids of computers with a live stream to this machine right now.
    pub connected: Vec<String>,
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
    /// A phone scanned the QR code and is now paired.
    fn phone_paired(&self, _id: &str, _name: &str) {}
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
    /// The phone pairing on offer: the key the QR code carries.
    phone_pairing: Mutex<Option<PhonePairing>>,
    /// Live stream connections, so unpairing a device or turning sharing
    /// off cuts it at once instead of at its next request.
    live: Mutex<Vec<LiveConn>>,
    live_seq: std::sync::atomic::AtomicU64,
    bind_error: Mutex<Option<String>>,
    discovery_error: Mutex<Option<String>>,
    /// Tests: what discovery would have seen, without multicast.
    #[cfg(test)]
    fake_sightings: Mutex<Vec<mdns::Sighting>>,
}

/// Where and how to reach a paired computer's stream (remote_client.rs).
pub(crate) struct PeerEndpoint {
    pub peer_id: String,
    pub name: String,
    /// Freshest first: discovery's sighting, then the stored address.
    pub addrs: Vec<SocketAddr>,
    pub key: [u8; 32],
    pub self_id: String,
    pub self_name: String,
    /// What this machine lets the other do here (sent in the hello).
    pub grant: String,
    pub port: Option<u16>,
}

struct PhonePairing {
    key: [u8; 32],
    until: Instant,
    expires_at_ms: i64,
    addresses: Vec<String>,
}

struct LiveConn {
    seq: u64,
    client_id: String,
    stream: TcpStream,
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
            phone_pairing: Mutex::new(None),
            live: Mutex::new(Vec::new()),
            live_seq: std::sync::atomic::AtomicU64::new(1),
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
        self.debug_offer_phone_pairing();
    }

    /// Test seam (DEBUG BUILDS ONLY, like TERMIC_DATA_DIR): with
    /// `TERMIC_DEBUG_PHONE_PAIRING=<file>`, keep a phone pairing on offer
    /// and write its link to that file, renewed whenever one is used or
    /// expires. This is how a phone app test (a simulator with no camera,
    /// nobody at the desk) pairs with a dev instance. Dead in release: a
    /// leaked variable must never leave a pairing key lying in a file.
    fn debug_offer_phone_pairing(self: &Arc<Self>) {
        if !cfg!(debug_assertions) {
            return;
        }
        let Ok(path) = std::env::var("TERMIC_DEBUG_PHONE_PAIRING") else { return };
        if path.trim().is_empty() {
            return;
        }
        match self.start_phone_pairing() {
            Ok(v) => {
                let _ = std::fs::write(&path, format!("{}\n", v.link));
                dlog("[peers] debug: phone pairing link written");
            }
            Err(e) => dlog(&format!("[peers] debug: no phone pairing ({e})")),
        }
    }

    fn advert(&self, port: u16) -> mdns::Advert {
        // Termic, Termic Beta and a dev build on one Mac are separate machines
        // to pair with, under one computer name: all but the release say which
        // they are, or the pair list shows the same name twice and a user
        // pairs with the wrong one.
        let name = match FLAVOR.get().copied().flatten() {
            Some(f) => format!("{} ({f})", self.self_name()),
            None => self.self_name(),
        };
        mdns::Advert {
            id: self.self_id(),
            name,
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
        *self.phone_pairing.lock().unwrap() = None;
        self.cut_all();
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
                proto_ok: peer_compatible(Some(&x.version), Some(x.proto)),
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
            phones: s.phones.iter().map(|p| self.phone_view(p)).collect(),
            phone_pairing: self.phone_pairing_view(),
            connected: self.connected_ids(),
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
        self.cut(&rec.id);
        crate::remote_client::forget(&rec.id);
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
            return Err("Turn on sharing on this network first (Settings > Remote control).".into());
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
            return Err("Turn on sharing on this network first (Settings > Remote control).".into());
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
            return Err("Turn on sharing on this network first (Settings > Remote control).".into());
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

    fn on_unpair(&self, body: &[u8]) -> (u16, Vec<u8>) {
        let path = format!("{PREFIX}/unpair");
        let Ok((rec, msg)) = self.open_sealed(&path, body) else { return self.refuse() };
        {
            let mut s = self.store.lock().unwrap();
            s.peers.retain(|p| p.id != rec.id);
            self.save(&s);
        }
        dlog(&format!("[peers] {} unpaired from this machine", rec.display_name()));
        self.cut(&rec.id);
        crate::remote_client::forget(&rec.id);
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
    pub(crate) fn forward(self: &Arc<Self>, req: &Request, sink: &mut dyn EventSink) -> Reply {
        let sel = req.peer.as_deref().unwrap_or("");
        if matches!(req.cmd, Command::PeerList | Command::PeerPair { .. } | Command::PeerUnpair { .. } | Command::PeerRename { .. }) {
            return Reply::err(&req.id, ErrorCode::BadRequest, "the peer verbs act on this machine; drop --peer");
        }
        if matches!(req.cmd, Command::Attach { .. }) {
            return Reply::err(&req.id, ErrorCode::Unsupported, "attach does not reach across machines");
        }
        // A server (remote_client.rs, reached over ssh) when no paired
        // computer answers to the name. It needs no sharing: ssh goes out.
        if self.find(sel).is_err() {
            if let Some(server) = crate::remote_client::find_server(sel) {
                return forward_to_server(&server, req, sink);
            }
        }
        if !(self.enabled)() || self.port().is_none() {
            return Reply::err(
                &req.id,
                ErrorCode::Unsupported,
                "Sharing on this network is off on this machine (Settings > Remote control), so it cannot reach paired machines.",
            );
        }
        let rec = match self.find(sel) {
            Ok(r) => r,
            Err(msg) => return Reply::err(&req.id, ErrorCode::NotFound, msg),
        };
        if rec.key().is_none() {
            return Reply::err(&req.id, ErrorCode::Internal, "the stored key for that machine is damaged; pair again");
        }
        if let Some(task) = req.from_task.as_deref().filter(|t| !t.trim().is_empty()) {
            self.remember_contact(&rec.id, task);
        }
        let name = rec.display_name();
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
        // Over the stream (docs/remote.md): one short connection per call,
        // sealed with the pair key exactly as the sidebar's link is, on its
        // own thread so this one can heartbeat the CLI meanwhile.
        let (tx, rx) = mpsc::channel();
        let peer_id = rec.id.clone();
        let node = self.clone();
        std::thread::spawn(move || {
            let _ = tx.send(call_over_stream(&node, &peer_id, inner, budget));
        });
        let result = await_with_heartbeat(rx, streaming, &req.id, sink)
            .unwrap_or_else(|| Err(StreamCallError::Unreachable("the call thread ended without an answer".into())));
        match result {
            Ok(mut reply) => {
                reply.id = req.id.clone();
                reply
            }
            Err(StreamCallError::Revoked) => {
                self.mark_revoked(&rec.id);
                Reply::err(
                    &req.id,
                    ErrorCode::Auth,
                    format!("{name} no longer accepts this machine. It may have unpaired it: unpair here and pair again."),
                )
            }
            Err(StreamCallError::Unreachable(e)) => Reply::err(&req.id, ErrorCode::PeerUnreachable, unreachable_msg(&name, &e)),
            Err(StreamCallError::Other(e)) => Reply::err(&req.id, ErrorCode::Internal, format!("{name}: {e}")),
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

    // ── the stream (remote_server.rs) and phones ─────────────────────

    /// Sharing is on and the listener is bound: pairs are reachable.
    pub(crate) fn sharing_on(&self) -> bool {
        (self.enabled)() && self.port().is_some()
    }

    /// Every paired computer: (id, the name it has here).
    pub(crate) fn paired_computers(&self) -> Vec<(String, String)> {
        self.store.lock().unwrap().peers.iter().map(|p| (p.id.clone(), p.display_name())).collect()
    }

    /// What the client side needs to open a stream to a paired computer.
    pub(crate) fn peer_endpoint(&self, id: &str) -> Result<PeerEndpoint, String> {
        let rec = self.by_id(id).ok_or("that computer is no longer paired")?;
        let key = rec.key().ok_or("the stored key for that machine is damaged; pair again")?;
        let mut addrs = Vec::new();
        if let Some(a) = self.address_of(&rec) {
            addrs.push(a);
        }
        if let Some(a) = rec.socket() {
            if !addrs.contains(&a) {
                addrs.push(a);
            }
        }
        Ok(PeerEndpoint {
            peer_id: rec.id.clone(),
            name: rec.display_name(),
            addrs,
            key,
            self_id: self.self_id(),
            self_name: self.self_name(),
            grant: rec.grant.as_str().to_string(),
            port: self.port(),
        })
    }

    /// Ask discovery where a pair is now (it moved), waiting up to 2 s.
    pub(crate) fn rediscover_addr(&self, id: &str) -> Option<SocketAddr> {
        self.rediscover(id)
    }

    /// This node as an Arc, for the debug seam that needs to schedule work
    /// from a `&self` method. The app's own node; None in tests.
    fn arc(&self) -> Option<Arc<Node>> {
        node().filter(|n| std::ptr::eq(Arc::as_ptr(n), self))
    }

    /// A paired computer by its exact id (never by name: a connecting
    /// client is identified by the id it proved a key for).
    fn by_id(&self, id: &str) -> Option<PeerRecord> {
        self.store.lock().unwrap().peers.iter().find(|p| p.id == id).cloned()
    }

    pub(crate) fn host(&self) -> Arc<dyn CliHost> {
        self.host.clone()
    }

    /// Offer a phone pairing: a fresh 256-bit key in a QR code, good for
    /// one phone within `PAIR_MODE_TTL`. The camera is the secure channel
    /// (docs/remote.md, "Pairing a phone"): whoever can see this screen
    /// can pair, exactly like reading a code off it, and nothing else can.
    /// Reopening replaces the key, so an old photo of the code is useless.
    pub(crate) fn start_phone_pairing(self: &Arc<Self>) -> Result<PhonePairingView, String> {
        let Some(port) = self.port() else {
            return Err("Turn on sharing on this network first (Settings > Remote control).".into());
        };
        let bound = self.runtime.lock().unwrap().as_ref().map(|r| r.addr);
        let addresses: Vec<String> = match bound {
            Some(a) if !a.is_unspecified() => vec![SocketAddr::new(a, port).to_string()],
            _ => mdns::reachable_addrs().into_iter().map(|ip| SocketAddr::new(IpAddr::V4(ip), port).to_string()).collect(),
        };
        if addresses.is_empty() {
            return Err("This computer has no network address a phone could reach. Connect it to Wi-Fi or a VPN first.".into());
        }
        let key = pc::random_bytes::<32>();
        let until = Instant::now() + PAIR_MODE_TTL;
        *self.phone_pairing.lock().unwrap() = Some(PhonePairing {
            key,
            until,
            expires_at_ms: now_ms() + PAIR_MODE_TTL.as_millis() as i64,
            addresses,
        });
        self.ui.changed();
        // Closed at its deadline even when nobody looks; a reopened pairing
        // has another key, so a stale timer does nothing.
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(PAIR_MODE_TTL);
            let mut p = me.phone_pairing.lock().unwrap();
            if p.as_ref().is_some_and(|p| p.key == key) {
                *p = None;
                drop(p);
                me.ui.changed();
                me.debug_offer_phone_pairing();
            }
        });
        self.phone_pairing_view().ok_or_else(|| "pairing closed".into())
    }

    pub(crate) fn cancel_phone_pairing(&self) {
        if self.phone_pairing.lock().unwrap().take().is_some() {
            self.ui.changed();
        }
    }

    fn phone_pairing_view(&self) -> Option<PhonePairingView> {
        let p = self.phone_pairing.lock().unwrap();
        let p = p.as_ref().filter(|p| p.until > Instant::now())?;
        let link = phone_link(&p.addresses, &self.self_id(), &self.self_name(), &p.key);
        Some(PhonePairingView { svg: qr_svg(&link), link, expires_at_ms: p.expires_at_ms, addresses: p.addresses.clone() })
    }

    fn phone_view(&self, p: &PhoneRecord) -> PhoneView {
        PhoneView {
            id: p.id.clone(),
            name: p.name.clone(),
            paired_at_ms: p.paired_at_ms,
            last_seen_ms: p.last_seen_ms,
            connected: self.live.lock().unwrap().iter().any(|l| l.client_id == p.id),
        }
    }

    fn connected_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.live.lock().unwrap().iter().map(|l| l.client_id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Forget a phone: its key is deleted and its live connection cut now.
    pub(crate) fn unpair_phone(&self, id: &str) -> Result<(), String> {
        let found = {
            let mut s = self.store.lock().unwrap();
            let before = s.phones.len();
            s.phones.retain(|p| p.id != id);
            let found = s.phones.len() != before;
            if found {
                self.save(&s);
            }
            found
        };
        if !found {
            return Err("That phone is not paired.".into());
        }
        self.cut(id);
        self.ui.changed();
        Ok(())
    }

    /// Keep (or, with `None`, drop) the push token a paired phone sent.
    pub(crate) fn set_phone_push(&self, id: &str, target: Option<PushTarget>) {
        let mut s = self.store.lock().unwrap();
        let Some(p) = s.phones.iter_mut().find(|p| p.id == id) else { return };
        if p.push == target {
            return;
        }
        p.push = target;
        self.save(&s);
    }

    /// The push targets of paired phones that are not connected now: a
    /// phone looking at the app already sees the change.
    pub(crate) fn away_push_targets(&self) -> Vec<PushTarget> {
        let live = self.connected_ids();
        let s = self.store.lock().unwrap();
        s.phones.iter().filter(|p| !live.contains(&p.id)).filter_map(|p| p.push.clone()).collect()
    }

    pub(crate) fn rename_phone(&self, id: &str, name: &str) -> Result<(), String> {
        {
            let mut s = self.store.lock().unwrap();
            let p = s.phones.iter_mut().find(|p| p.id == id).ok_or("That phone is not paired.")?;
            p.name = clean_name(name);
            self.save(&s);
        }
        self.ui.changed();
        Ok(())
    }

    /// The keys a connecting client may hold: a paired computer's or
    /// phone's own key, or, for an id this machine does not know yet, the
    /// key of the phone pairing on offer. Never both: a known id cannot
    /// use the pending key.
    pub(crate) fn stream_keys(&self, client_id: &str) -> Vec<[u8; 32]> {
        if !(self.enabled)() {
            return Vec::new();
        }
        {
            let s = self.store.lock().unwrap();
            if let Some(p) = s.peers.iter().find(|p| p.id == client_id) {
                return p.key().into_iter().collect();
            }
            if let Some(p) = s.phones.iter().find(|p| p.id == client_id) {
                // A known phone may also be re-pairing with a fresh code
                // (it forgot this computer, or was reinstalled keeping its
                // id): its own key first, then the pending one.
                let mut keys: Vec<[u8; 32]> = pc::key_from_hex(&p.key).into_iter().collect();
                if let Some(pending) = self.phone_pairing.lock().unwrap().as_ref().filter(|x| x.until > Instant::now()) {
                    keys.push(pending.key);
                }
                return keys;
            }
        }
        if client_id == self.self_id() {
            return Vec::new();
        }
        self.phone_pairing
            .lock()
            .unwrap()
            .as_ref()
            .filter(|p| p.until > Instant::now())
            .map(|p| vec![p.key])
            .unwrap_or_default()
    }

    /// A client proved a key (its hello opened). Decide who it is and what
    /// it may do; None refuses it. A phone opening under the pending key
    /// is paired now, and the pending key is spent.
    pub(crate) fn stream_authorized(
        &self,
        client_id: &str,
        key_index: usize,
        hello: &termic_remote::wire::ClientMsg,
        src: IpAddr,
    ) -> Option<crate::remote_server::StreamClient> {
        use termic_remote::wire::{ClientKind, ClientMsg};
        let ClientMsg::Hello { name, kind, grant, port, caps, app_version, .. } = hello else { return None };
        let wants_tasks = caps.iter().any(|c| c == termic_remote::wire::caps::TASKS);
        self.backoff_reset();
        if let Some(rec) = self.by_id(client_id) {
            if *kind != ClientKind::Computer {
                return None;
            }
            self.touch(&rec.id, Some(src), *port, grant.as_deref().and_then(Grant::parse));
            return Some(crate::remote_server::StreamClient { id: rec.id.clone(), name: rec.display_name(), kind: ClientKind::Computer, grant: rec.grant, wants_tasks, version: app_version.clone() });
        }
        let known_phone = {
            let mut s = self.store.lock().unwrap();
            let hit = s.phones.iter_mut().find(|p| p.id == client_id).map(|p| {
                p.last_seen_ms = Some(now_ms());
                p.addr = Some(src.to_string());
                p.name.clone()
            });
            if hit.is_some() {
                self.save(&s);
            }
            hit
        };
        if let Some(name) = known_phone.filter(|_| key_index == 0) {
            if *kind != ClientKind::Phone {
                return None;
            }
            self.ui.changed();
            return Some(crate::remote_server::StreamClient { id: client_id.into(), name, kind: ClientKind::Phone, grant: Grant::Drive, wants_tasks, version: None });
        }
        // A new phone, which can only have opened under the pending key.
        if *kind != ClientKind::Phone {
            return None;
        }
        let pending = self.phone_pairing.lock().unwrap().take().filter(|p| p.until > Instant::now())?;
        let name = {
            let n = clean_name(name);
            if n.is_empty() { "Phone".to_string() } else { n }
        };
        {
            let mut s = self.store.lock().unwrap();
            s.phones.retain(|p| p.id != client_id);
            s.phones.push(PhoneRecord {
                id: client_id.into(),
                name: name.clone(),
                key: pc::key_to_hex(&pending.key),
                paired_at_ms: now_ms(),
                last_seen_ms: Some(now_ms()),
                addr: Some(src.to_string()),
                // A fresh pairing: the phone sends its token again on connect.
                push: None,
            });
            self.save(&s);
        }
        dlog(&format!("[peers] phone {name} paired"));
        self.ui.changed();
        self.ui.phone_paired(client_id, &name);
        if let Some(me) = self.arc() {
            me.debug_offer_phone_pairing();
        }
        Some(crate::remote_server::StreamClient { id: client_id.into(), name, kind: ClientKind::Phone, grant: Grant::Drive, wants_tasks, version: None })
    }

    /// A handshake failed: the same growing delay as a refused call.
    pub(crate) fn stream_refused(&self) {
        let _ = self.refuse();
    }

    pub(crate) fn register_live(&self, client_id: &str, stream: TcpStream) -> u64 {
        let seq = self.live_seq.fetch_add(1, Ordering::SeqCst);
        self.live.lock().unwrap().push(LiveConn { seq, client_id: client_id.into(), stream });
        self.ui.changed();
        seq
    }

    pub(crate) fn unregister_live(&self, seq: u64) {
        self.live.lock().unwrap().retain(|l| l.seq != seq);
        self.ui.changed();
    }

    /// End every live connection of one client. Its reader sees the socket
    /// close and the session winds down (taps released, threads joined).
    fn cut(&self, client_id: &str) {
        for l in self.live.lock().unwrap().iter().filter(|l| l.client_id == client_id) {
            let _ = l.stream.shutdown(std::net::Shutdown::Both);
        }
    }

    fn cut_all(&self) {
        for l in self.live.lock().unwrap().iter() {
            let _ = l.stream.shutdown(std::net::Shutdown::Both);
        }
    }

    /// One verb from a stream client, under its grant: what `/call` did for
    /// a paired computer (its grant, its reply contacts, the signature
    /// rewrite, the protocol check), and Drive for a phone.
    pub(crate) fn run_stream_call(&self, client: &crate::remote_server::StreamClient, req: Request, proto_v: Option<u32>) -> Reply {
        use termic_remote::wire::ClientKind;
        let us = self.self_name();
        let cmd = sanitize(&req.cmd);
        let cmd = match client.kind {
            ClientKind::Computer => {
                if !peer_compatible(client.version.as_deref(), proto_v) {
                    let theirs = match (client.version.as_deref(), proto_v) {
                        (Some(v), _) => format!("Termic {v}"),
                        (None, Some(p)) => format!("an older Termic (CLI protocol {p})"),
                        (None, None) => "an older Termic".into(),
                    };
                    return Reply::err(
                        &req.id,
                        ErrorCode::Unsupported,
                        format!(
                            "{us} runs Termic {} and needs {} or later on the calling machine, which runs {theirs}. \
                             Update Termic there.",
                            self.version,
                            termic_remote::compat::REQUIRES_DESKTOP,
                        ),
                    );
                }
                // Re-read: the grant and the contacts can change while a
                // connection stays open.
                let Some(rec) = self.by_id(&client.id) else {
                    return Reply::err(&req.id, ErrorCode::Auth, format!("{us} no longer has this machine paired"));
                };
                let cmd = localize_signature(cmd, &rec);
                if let Err(why) = permitted(rec.grant, &cmd, &rec.contacts, self.host.as_ref(), &us) {
                    return Reply::err(&req.id, ErrorCode::Auth, why);
                }
                report_back_now(cmd, &rec.contacts, self.host.as_ref())
            }
            _ => {
                if let Some(verb) = drive_denied(&cmd) {
                    return Reply::err(&req.id, ErrorCode::Auth, format!("{us} does not let a phone run {verb}"));
                }
                cmd
            }
        };
        let mut cmd = cmd;
        crate::mcp_server::clamp_wait(&mut cmd);
        let inner = Request { id: req.id.clone(), token: None, profile: req.profile.clone(), peer: None, from_task: None, cmd };
        crate::cli_server::with_peer_origin(|| {
            crate::cli_server::dispatch_authenticated(&inner, self.host.as_ref(), &mut crate::mcp_server::NoopSink)
        })
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

/// Why a call over the stream did not produce a reply.
#[derive(Debug)]
enum StreamCallError {
    /// The other machine refused this one's key: it unpaired us.
    Revoked,
    /// Nothing answered, or the connection dropped.
    Unreachable(String),
    Other(String),
}

/// Wait for a call's answer on `rx`, heartbeating the CLI meanwhile when
/// it reads this verb as a stream (its socket gives up after 30 silent
/// seconds). A client that hung up stops being told; the call itself runs
/// to completion on the other machine either way.
fn await_with_heartbeat<T>(rx: mpsc::Receiver<T>, streaming: bool, req_id: &str, sink: &mut dyn EventSink) -> Option<T> {
    loop {
        match rx.recv_timeout(HEARTBEAT_EVERY) {
            Ok(r) => return Some(r),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if streaming {
                    let _ = sink.emit(&StreamEvent::heartbeat(req_id));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// `--peer <server>`: the verb runs on a headless box over its link.
fn forward_to_server(server: &str, req: &Request, sink: &mut dyn EventSink) -> Reply {
    let cmd = sanitize(&req.cmd);
    let budget = call_budget(&cmd);
    let streaming = streamed(&cmd);
    let inner = Request { id: req.id.clone(), token: None, profile: None, peer: None, from_task: None, cmd };
    let Ok(value) = serde_json::to_value(&inner) else {
        return Reply::err(&req.id, ErrorCode::Internal, "could not encode the request");
    };
    let (tx, rx) = mpsc::channel();
    let server_id = server.to_string();
    std::thread::spawn(move || {
        let _ = tx.send(crate::remote_client::call(&server_id, value, Some(budget)));
    });
    let result = await_with_heartbeat(rx, streaming, &req.id, sink).unwrap_or_else(|| Err("the call thread ended without an answer".into()));
    match result.and_then(|v| serde_json::from_value::<Reply>(v).map_err(|e| e.to_string())) {
        Ok(mut reply) => {
            reply.id = req.id.clone();
            reply
        }
        Err(e) => Reply::err(&req.id, ErrorCode::PeerUnreachable, e),
    }
}

/// One verb on a paired computer over a fresh stream connection.
fn call_over_stream(node: &Node, peer_id: &str, req: Request, budget: Duration) -> Result<Reply, StreamCallError> {
    use termic_remote::wire::{ClientMsg, ServerMsg};
    let ((_, mut reader, mut writer), sock) = crate::remote_client::connect_peer(node, peer_id, false).map_err(|e| {
        if e.contains("no longer accepts") {
            StreamCallError::Revoked
        } else {
            StreamCallError::Unreachable(e)
        }
    })?;
    let _ = sock.set_read_timeout(Some(budget));
    let id = req.id.clone();
    let req = serde_json::to_value(&req).map_err(|e| StreamCallError::Other(e.to_string()))?;
    writer
        .send(&ClientMsg::Call { id: id.clone(), req, proto: Some(proto::PROTOCOL_VERSION) })
        .map_err(|e| StreamCallError::Unreachable(e.to_string()))?;
    let out = loop {
        match reader.recv::<ServerMsg>() {
            Ok(Some(ServerMsg::Reply { id: rid, reply })) if rid == id => {
                break serde_json::from_value::<Reply>(reply)
                    .map_err(|_| StreamCallError::Other("sent an answer this version cannot read".into()));
            }
            Ok(Some(_)) => continue,
            Ok(None) => break Err(StreamCallError::Unreachable("the connection closed before the answer".into())),
            Err(e) => break Err(StreamCallError::Unreachable(e.to_string())),
        }
    };
    writer.close(1000, "");
    let _ = sock.shutdown(std::net::Shutdown::Both);
    out
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
        Command::PeerPair { target, code: None } => match node.request_pair(target) {
            Ok(name) => Reply::ok(
                id,
                ReplyData::PeerCodeShown(proto::PeerCodeShownData {
                    next: format!(
                        "{name} now shows a 4-digit code for {} min. Ask the user to read it off that screen, \
                         then pair again with target \"{}\" and that code.",
                        PAIR_MODE_TTL.as_secs() / 60,
                        target.trim()
                    ),
                    name,
                }),
            ),
            Err(e) => Reply::err(id, ErrorCode::Auth, e),
        },
        Command::PeerPair { target, code: Some(code) } => match node.pair(target, code) {
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
            "no paired machine called {sel}: this machine is not paired with any (Settings > Remote control, or `termic peer pair`)"
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
        proto_ok: peer_compatible(seen.map(|s| s.version.as_str()).or(p.version.as_deref()), proto),
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

/// The phone pairing link the QR code encodes. Read by the phone app;
/// additive like the stream: unknown
/// parameters are ignored there.
///
/// `v` link version, `h` addresses to try in order (comma-separated
/// host:port), `id` this machine's id, `m` its name, `k` the 256-bit key
/// (base64url).
fn phone_link(addresses: &[String], id: &str, name: &str, key: &[u8; 32]) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    format!(
        "termic-remote://pair?v=1&h={}&id={id}&m={}&k={}",
        utf8_percent_encode(&addresses.join(","), NON_ALPHANUMERIC),
        utf8_percent_encode(name, NON_ALPHANUMERIC),
        termic_remote::b64url(key),
    )
}

/// The link as a QR code, an SVG document the Settings panel draws inline.
fn qr_svg(link: &str) -> String {
    use qrcode::render::svg;
    match qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::M) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(240, 240)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
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
    fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
    fn parse(b: &[u8]) -> Option<Sealed> {
        serde_json::from_slice(b).ok()
    }
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
    /// `Sec-WebSocket-Key` of an upgrade request (the stream).
    ws_key: Option<String>,
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
    let mut ws_key = None;
    let mut upgrade = false;
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
                "upgrade" => upgrade = v.trim().eq_ignore_ascii_case("websocket"),
                "sec-websocket-key" => ws_key = Some(v.trim().to_string()),
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
    let ws_key = ws_key.filter(|_| upgrade);
    Ok(Ok(HttpReq { method, path, has_origin, ws_key, body }))
}

fn handle_conn(stream: TcpStream, node: &Arc<Node>, shutdown: &AtomicBool) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let src = stream.peer_addr().map(|a| canonical_ip(a.ip())).unwrap_or(IpAddr::from([0, 0, 0, 0]));
    let req = match read_request(&stream)? {
        Ok(r) => r,
        Err(status) => return respond(stream, status, b""),
    };
    // The stream (remote_server.rs): a WebSocket. A phone's WebSocket sends
    // an Origin header of its own (React Native's does), so Origin cannot
    // gate this one path; nothing on it is reachable without the sealed
    // handshake, which a web page cannot complete without a pair key.
    if req.path == STREAM_PATH {
        if shutdown.load(Ordering::SeqCst) || !(node.enabled)() {
            return respond(stream, 403, b"");
        }
        let Some(key) = req.ws_key.clone().filter(|_| req.method == "GET") else {
            return respond(stream, 400, b"");
        };
        crate::remote_server::serve(stream, &key, node.clone(), src);
        return Ok(());
    }
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
        ("POST", "/unpair") => node.on_unpair(&req.body),
        (_, "/hello" | "/pair/request" | "/pair/start" | "/pair/confirm" | "/unpair") => (405, Vec::new()),
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
        // Pairs or sharing changed: keep the sidebar's links in line. On its
        // own thread: this can be called with peers.rs state just released,
        // and supervise reads it again.
        std::thread::spawn(crate::remote_client::supervise);
    }
    fn pairing(&self, view: &PairingView) {
        use tauri::Emitter;
        let _ = self.0.emit("peer://pairing", view);
    }
    fn phone_paired(&self, id: &str, name: &str) {
        use tauri::Emitter;
        let _ = self.0.emit("peer://phone-paired", serde_json::json!({ "id": id, "name": name }));
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

/// "Beta" (its own bundle identifier) or "Dev" (a debug build, which shares
/// the release's identifier); None for the release.
static FLAVOR: std::sync::OnceLock<Option<&'static str>> = std::sync::OnceLock::new();

fn ensure_node(app: &tauri::AppHandle) -> Option<Arc<Node>> {
    let _ = FLAVOR.set(if app.config().identifier.ends_with(".beta") {
        Some("Beta")
    } else if cfg!(debug_assertions) {
        Some("Dev")
    } else {
        None
    });
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
pub(crate) async fn peer_pair(app: tauri::AppHandle, window: tauri::Window, target: String, code: String) -> Result<PairingView, String> {
    let node = need(&app)?;
    let view = tauri::async_runtime::spawn_blocking(move || node.pair(&target, &code)).await.map_err(|e| e.to_string())??;
    // It belongs to the profile whose window paired it.
    let _ = crate::remote_client::set_machine_profile(&view.peer_id, window.label());
    Ok(view)
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

/// Show a QR code a phone scans to pair (docs/remote.md).
#[tauri::command]
pub(crate) fn phone_pair_start(app: tauri::AppHandle) -> Result<PhonePairingView, String> {
    need(&app)?.start_phone_pairing()
}

#[tauri::command]
pub(crate) fn phone_pair_cancel(app: tauri::AppHandle) -> Result<(), String> {
    need(&app)?.cancel_phone_pairing();
    Ok(())
}

#[tauri::command]
pub(crate) fn phone_unpair(app: tauri::AppHandle, id: String) -> Result<(), String> {
    need(&app)?.unpair_phone(&id)
}

#[tauri::command]
pub(crate) fn phone_rename(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    need(&app)?.rename_phone(&id, &name)
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
        phones: Mutex<Vec<String>>,
        changes: AtomicUsize,
    }
    impl PeerUi for RecUi {
        fn changed(&self) {
            self.changes.fetch_add(1, Ordering::SeqCst);
        }
        fn pairing(&self, view: &PairingView) {
            self.pairings.lock().unwrap().push(view.clone());
        }
        fn phone_paired(&self, id: &str, _name: &str) {
            self.phones.lock().unwrap().push(id.to_string());
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

    // ── the stream (remote_server.rs) ────────────────────────────────

    use termic_remote::conn::{self as rconn, Connected};
    use termic_remote::wire::{self as rwire, ClientKind, ClientMsg, ServerMsg};

    /// Open a stream to `m` as `client_id` holding `key`.
    fn stream_as(m: &Machine, client_id: &str, key: &[u8; 32], kind: ClientKind, caps: &[&str]) -> std::io::Result<Connected> {
        stream_as_version(m, client_id, key, kind, caps, None)
    }

    fn stream_as_version(m: &Machine, client_id: &str, key: &[u8; 32], kind: ClientKind, caps: &[&str], app_version: Option<&str>) -> std::io::Result<Connected> {
        let target = addr(m);
        let mut s = TcpStream::connect(&target)?;
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        termic_remote::ws::client_handshake(&mut s, &target, STREAM_PATH)?;
        let (r, w) = termic_remote::ws::split_tcp(s, termic_remote::ws::End::Client)?;
        let hello = ClientMsg::Hello {
            v: rwire::VERSION,
            name: "client".into(),
            kind,
            caps: caps.iter().map(|c| c.to_string()).collect(),
            app_version: app_version.map(String::from),
            grant: None,
            port: None,
        };
        rconn::client_handshake(Box::new(r), Box::new(w), &m.node.self_id(), client_id, key, &hello)
    }

    /// The next message that is not a task snapshot.
    fn next_non_tasks(c: &mut Connected) -> ServerMsg {
        loop {
            match c.reader.recv::<ServerMsg>().unwrap().expect("connection closed") {
                ServerMsg::Tasks { .. } => continue,
                m => return m,
            }
        }
    }

    #[test]
    fn unknown_and_wrong_key_clients_are_refused_alike() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let stranger = "f".repeat(32);
        assert!(stream_as(&b, &stranger, &[1u8; 32], ClientKind::Computer, &[]).is_err());
        assert!(stream_as(&b, &a.node.self_id(), &[1u8; 32], ClientKind::Computer, &[]).is_err());
        let key = a.node.find("B").unwrap().key().unwrap();
        assert!(stream_as(&b, &a.node.self_id(), &key, ClientKind::Computer, &[]).is_ok());
        // A paired computer's key cannot pose as a phone.
        assert!(stream_as(&b, &a.node.self_id(), &key, ClientKind::Phone, &[]).is_err());
    }

    /// A recorded connection replayed byte for byte opens nothing: the host
    /// picks a fresh salt every time, so the old hello no longer opens.
    #[test]
    fn a_replayed_connection_is_refused() {
        use termic_remote::seal;
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let key = a.node.find("B").unwrap().key().unwrap();
        let (me, them) = (a.node.self_id(), b.node.self_id());
        let client_salt = [7u8; 16];
        let mut first = client_salt.to_vec();
        first.extend_from_slice(&termic_remote::id_to_bytes(&me).unwrap());
        let hello = ClientMsg::Hello { v: 1, name: "A".into(), kind: ClientKind::Computer, caps: vec![], app_version: None, grant: None, port: None };
        let mut recorded: Option<Vec<u8>> = None;
        for round in 0..2 {
            let target = addr(&b);
            let mut s = TcpStream::connect(&target).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            termic_remote::ws::client_handshake(&mut s, &target, STREAM_PATH).unwrap();
            let (mut r, mut w) = termic_remote::ws::split_tcp(s, termic_remote::ws::End::Client).unwrap();
            use termic_remote::{FrameRead, FrameWrite};
            let host_salt: [u8; 16] = r.recv().unwrap().unwrap().try_into().unwrap();
            let sealed = recorded.clone().unwrap_or_else(|| {
                let (mut sealer, _) = seal::session(&key, &host_salt, &client_salt, &them, &me, seal::Role::Client);
                sealer.seal(&hello.to_bytes())
            });
            w.send(&first).unwrap();
            w.send(&sealed).unwrap();
            let answer = r.recv();
            if round == 0 {
                assert!(matches!(answer, Ok(Some(_))), "the original connection is welcomed");
                recorded = Some(sealed);
            } else {
                assert!(matches!(answer, Ok(None) | Err(_)), "the replay is refused");
                assert_eq!(r.close_code, Some(rconn::CLOSE_UNAUTHENTICATED));
            }
        }
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
    fn an_agent_pairs_end_to_end_asking_the_user_only_for_the_code() {
        let (a, b) = (machine("A"), machine("B"));
        let verb = |code: Option<String>| {
            let req = Request {
                id: "r".into(),
                token: None,
                profile: None,
                peer: None,
                from_task: None,
                cmd: Command::PeerPair { target: addr(&b), code },
            };
            handle_verb(&a.node, &req, &mut crate::mcp_server::NoopSink)
        };
        // No code: B shows one, and the reply tells the agent to ask for it.
        match verb(None).data {
            Some(ReplyData::PeerCodeShown(c)) => {
                assert_eq!(c.name, "B");
                assert!(c.next.contains("Ask the user"), "{}", c.next);
            }
            other => panic!("expected the code to be shown, got {other:?}"),
        }
        assert!(a.node.find(&b.node.self_id()).is_err(), "asking pairs nothing");
        // The user reads the code off B's screen; the agent sends it.
        let code = b.node.pair_mode_view().expect("B shows a code").code;
        assert!(matches!(verb(Some(code)).data, Some(ReplyData::PeerPair(_))));
        assert!(a.node.find(&b.node.self_id()).is_ok());
        assert!(b.node.find(&a.node.self_id()).is_ok());
    }

    #[test]
    fn clock_skew_is_worded_with_its_size_and_direction() {
        assert_eq!(clock_skew("win", 477 * 60_000 + 30_000), "win's clock is 7 h 57 min ahead of this machine's");
        assert!(clock_skew("win", -6 * 60_000).contains("6 min behind"));
    }

    #[test]
    fn a_reply_peer_gets_no_tasks_and_no_terminal_over_the_stream() {
        let (a, b) = (machine("Mac"), machine("Win"));
        pair(&a, &b, Grant::Drive, Grant::Reply); // Win lets Mac only reply
        let key = a.node.find("Win").unwrap().key().unwrap();
        let mut c = stream_as(&b, &a.node.self_id(), &key, ClientKind::Computer, &["tasks"]).unwrap();
        let ServerMsg::Welcome { caps, grant, .. } = c.welcome.clone() else { panic!() };
        assert_eq!(grant.as_deref(), Some("reply"));
        assert_eq!(caps, vec!["call".to_string()]);
        c.writer.send(&ClientMsg::TermOpen { task: "solo".into(), tab: None }).unwrap();
        assert!(matches!(next_non_tasks(&mut c), ServerMsg::Error { .. }));
        // And a Drive peer gets everything.
        let key = b.node.find("Mac").unwrap().key().unwrap();
        let c = stream_as(&a, &b.node.self_id(), &key, ClientKind::Computer, &[]).unwrap();
        let ServerMsg::Welcome { caps, .. } = c.welcome else { panic!() };
        for cap in ["call", "tasks", "terminal", "keys", "transcript"] {
            assert!(caps.iter().any(|c| c == cap), "missing {cap}: {caps:?}");
        }
    }

    #[test]
    fn a_phone_pairs_once_with_the_qr_key_and_unpairing_cuts_it() {
        let b = machine("Mac");
        let view = b.node.start_phone_pairing().unwrap();
        assert!(view.link.starts_with("termic-remote://pair?v=1&h="), "{}", view.link);
        assert!(view.svg.starts_with("<?xml") || view.svg.starts_with("<svg"), "an SVG");
        let k = view.link.split("&k=").nth(1).unwrap();
        let key: [u8; 32] = termic_remote::unb64url(k).unwrap().try_into().unwrap();
        let phone = "a1".repeat(16);
        let mut c = stream_as(&b, &phone, &key, ClientKind::Phone, &["tasks"]).unwrap();
        assert_eq!(b.node.status().phones.len(), 1);
        assert!(b.node.status().phone_pairing.is_none(), "the key is spent");
        assert_eq!(b.ui.phones.lock().unwrap().len(), 1, "the desktop was told");
        // A second phone with the same (spent) key gets nothing.
        assert!(stream_as(&b, &"b2".repeat(16), &key, ClientKind::Phone, &[]).is_err());
        // The paired phone reconnects with its key any time.
        drop(c.writer);
        let mut c2 = stream_as(&b, &phone, &key, ClientKind::Phone, &[]).unwrap();
        c2.writer.send(&ClientMsg::Ping {}).unwrap();
        assert_eq!(next_non_tasks(&mut c2), ServerMsg::Pong {});
        // Unpair: the live connection ends at once.
        b.node.unpair_phone(&phone).unwrap();
        let end = loop {
            match c2.reader.recv::<ServerMsg>() {
                Ok(Some(_)) => continue,
                other => break other,
            }
        };
        assert!(matches!(end, Ok(None) | Err(_)), "{end:?}");
        assert!(stream_as(&b, &phone, &key, ClientKind::Phone, &[]).is_err());
        let _ = c.reader.recv::<ServerMsg>();
    }

    /// A client that goes away is let go: its session ends and it no longer
    /// counts as connected (it once leaked, the writer waiting forever).
    #[test]
    fn a_closed_connection_is_no_longer_connected() {
        let b = machine("Mac");
        let v = b.node.start_phone_pairing().unwrap();
        let key: [u8; 32] = termic_remote::unb64url(v.link.split("&k=").nth(1).unwrap()).unwrap().try_into().unwrap();
        let id = "f6".repeat(16);
        let mut c = stream_as(&b, &id, &key, ClientKind::Phone, &[]).unwrap();
        assert_eq!(b.node.status().connected, vec![id.clone()]);
        c.writer.close(1000, "");
        drop(c);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !b.node.status().connected.is_empty() {
            assert!(Instant::now() < deadline, "still counted as connected");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!b.node.status().phones[0].connected);
    }


    /// A phone that forgot this computer scans a fresh code with the same
    /// id: it re-pairs, the old key stops working, and the code is spent.
    #[test]
    fn a_known_phone_re_pairs_with_a_fresh_code() {
        let b = machine("Mac");
        let key_of = |v: PhonePairingView| -> [u8; 32] { termic_remote::unb64url(v.link.split("&k=").nth(1).unwrap()).unwrap().try_into().unwrap() };
        let id = "a7".repeat(16);
        let old = key_of(b.node.start_phone_pairing().unwrap());
        drop(stream_as(&b, &id, &old, ClientKind::Phone, &[]).unwrap());
        let fresh = key_of(b.node.start_phone_pairing().unwrap());
        drop(stream_as(&b, &id, &fresh, ClientKind::Phone, &[]).unwrap());
        assert_eq!(b.node.status().phones.len(), 1, "one record, replaced");
        assert!(b.node.status().phone_pairing.is_none(), "the code is spent");
        assert!(stream_as(&b, &id, &old, ClientKind::Phone, &[]).is_err(), "the old key no longer works");
        assert!(stream_as(&b, &id, &fresh, ClientKind::Phone, &[]).is_ok());
        assert_eq!(b.ui.phones.lock().unwrap().len(), 2, "the desktop was told both times");
    }

    #[test]
    fn turning_sharing_off_cuts_live_streams() {
        let b = machine("Mac");
        let key: [u8; 32] = {
            let v = b.node.start_phone_pairing().unwrap();
            termic_remote::unb64url(v.link.split("&k=").nth(1).unwrap()).unwrap().try_into().unwrap()
        };
        let mut c = stream_as(&b, &"c3".repeat(16), &key, ClientKind::Phone, &[]).unwrap();
        b.node.stop();
        let end = loop {
            match c.reader.recv::<ServerMsg>() {
                Ok(Some(_)) => continue,
                other => break other,
            }
        };
        assert!(matches!(end, Ok(None) | Err(_)));
    }

    #[test]
    fn a_phone_sees_tasks_runs_verbs_and_watches_a_terminal() {
        let host = Arc::new(StubHost::default());
        host.role_ptys.lock().unwrap().insert(("w3".into(), "agent".into()), "pty-1".into());
        host.pty_rings.lock().unwrap().insert("pty-1".into(), (b"hello from the agent".to_vec(), false));
        let b = machine_with("Mac", host.clone());
        let v = b.node.start_phone_pairing().unwrap();
        let key: [u8; 32] = termic_remote::unb64url(v.link.split("&k=").nth(1).unwrap()).unwrap().try_into().unwrap();
        let mut c = stream_as(&b, &"d4".repeat(16), &key, ClientKind::Phone, &["tasks"]).unwrap();
        // A snapshot of every live task arrives unasked.
        let tasks = loop {
            if let ServerMsg::Tasks { tasks } = c.reader.recv::<ServerMsg>().unwrap().unwrap() {
                break tasks;
            }
        };
        let mut names: Vec<_> = tasks.iter().map(|t| format!("{}/{}", t.project, t.name)).collect();
        names.sort();
        assert_eq!(names, ["api/fix-auth", "web/fix-auth", "web/solo"]);
        // A verb runs through the same dispatch as the CLI.
        let req = serde_json::json!({ "id": "x", "cmd": "list", "project": null, "quiet": true });
        c.writer.send(&ClientMsg::Call { id: "c1".into(), req, proto: None }).unwrap();
        match next_non_tasks(&mut c) {
            ServerMsg::Reply { id, reply } => {
                assert_eq!(id, "c1");
                assert_eq!(reply["ok"], true, "{reply}");
            }
            m => panic!("{m:?}"),
        }
        // The phone may not quit the desktop.
        let req = serde_json::json!({ "id": "x", "cmd": "quit", "commit": true });
        c.writer.send(&ClientMsg::Call { id: "c2".into(), req, proto: None }).unwrap();
        match next_non_tasks(&mut c) {
            ServerMsg::Reply { reply, .. } => assert_eq!(reply["ok"], false),
            m => panic!("{m:?}"),
        }
        // The terminal: the backlog first, then live output, then input.
        c.writer.send(&ClientMsg::TermOpen { task: "solo".into(), tab: None }).unwrap();
        match next_non_tasks(&mut c) {
            ServerMsg::TermReset { task, cols, rows, data, .. } => {
                assert_eq!(task, "w3");
                assert_eq!((cols, rows), (80, 24));
                assert_eq!(termic_remote::unb64(&data).unwrap(), b"hello from the agent");
            }
            m => panic!("{m:?}"),
        }
        let tap = host.taps.lock().unwrap().get("pty-1").unwrap()[0].clone();
        tap.send(crate::PtyTapMsg::Data(b"more".to_vec())).unwrap();
        match next_non_tasks(&mut c) {
            ServerMsg::TermData { data } => assert_eq!(termic_remote::unb64(&data).unwrap(), b"more"),
            m => panic!("{m:?}"),
        }
        c.writer.send(&ClientMsg::TermInput { data: termic_remote::b64(b"\r") }).unwrap();
        c.writer.send(&ClientMsg::Keys { task: "solo".into(), tab: None, data: termic_remote::b64(b"\x1b"), id: None, question: None }).unwrap();
        c.writer.send(&ClientMsg::Ping {}).unwrap();
        assert_eq!(next_non_tasks(&mut c), ServerMsg::Pong {});
        let inputs = host.pty_inputs.lock().unwrap().clone();
        assert_eq!(inputs, vec![("pty-1".to_string(), b"\r".to_vec()), ("pty-1".to_string(), b"\x1b".to_vec())]);
        // The agent exits: the phone is told.
        tap.send(crate::PtyTapMsg::Detach("exited".into())).unwrap();
        assert_eq!(next_non_tasks(&mut c), ServerMsg::TermClosed { reason: "exited".into() });
        // The phone never resized the PTY.
        assert!(host.resizes.lock().unwrap().is_empty());
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

    /// An answer carries the question it answers; the desktop types it only
    /// while that question is still on the agent's screen.
    #[test]
    fn answers_are_bound_to_the_question_on_screen() {
        let host = Arc::new(StubHost::default());
        host.role_ptys.lock().unwrap().insert(("w3".into(), "agent".into()), "pty-1".into());
        let screen = "Bash command\r\n  npm test\r\nDo you want to proceed?\r\n\u{276f} 1. Yes\r\n  2. No\r\n";
        host.pty_rings.lock().unwrap().insert("pty-1".into(), (screen.as_bytes().to_vec(), false));
        let b = machine_with("Mac", host.clone());
        let v = b.node.start_phone_pairing().unwrap();
        let key: [u8; 32] = termic_remote::unb64url(v.link.split("&k=").nth(1).unwrap()).unwrap().try_into().unwrap();
        let mut c = stream_as(&b, &"e5".repeat(16), &key, ClientKind::Phone, &[]).unwrap();
        let lines = termic_remote::screen::render(screen.as_bytes(), 24, 80);
        let q = termic_remote::screen::question(&lines).expect("the stub screen holds a question");
        let yes = q.options[0].keys.clone();
        // A stale id is refused and nothing is typed.
        c.writer.send(&ClientMsg::Keys { task: "solo".into(), tab: None, data: yes.clone(), id: Some("k1".into()), question: Some("old".into()) }).unwrap();
        assert_eq!(next_non_tasks(&mut c), ServerMsg::Ack { id: "k1".into(), ok: false, message: Some("stale".into()) });
        assert!(host.pty_inputs.lock().unwrap().is_empty());
        // The live id is typed.
        c.writer.send(&ClientMsg::Keys { task: "solo".into(), tab: None, data: yes, id: Some("k2".into()), question: Some(q.id.clone()) }).unwrap();
        assert_eq!(next_non_tasks(&mut c), ServerMsg::Ack { id: "k2".into(), ok: true, message: None });
        assert_eq!(host.pty_inputs.lock().unwrap().as_slice(), &[("pty-1".to_string(), b"\r".to_vec())]);
        // Interrupt picks the agent's own key (claude: Esc).
        c.writer.send(&ClientMsg::Interrupt { task: "solo".into(), tab: None, id: Some("i1".into()) }).unwrap();
        assert_eq!(next_non_tasks(&mut c), ServerMsg::Ack { id: "i1".into(), ok: true, message: None });
        assert_eq!(host.pty_inputs.lock().unwrap().last().unwrap().1, b"\x1b".to_vec());
        // ...and tells the window, which never saw that key: without this the
        // stopped turn read "working" until the next prompt. Answers do not.
        let told = host.remote_interrupts.lock().unwrap().clone();
        assert_eq!(told.len(), 1);
        assert_eq!(told[0].1, "pty-1");
    }

    #[test]
    fn a_protocol_mismatch_is_named_not_mis_run() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let key = a.node.find("B").unwrap().key().unwrap();
        let mut c = stream_as(&b, &a.node.self_id(), &key, ClientKind::Computer, &[]).unwrap();
        let req = serde_json::json!({ "id": "x", "cmd": "list", "project": null, "quiet": true });
        c.writer.send(&ClientMsg::Call { id: "c".into(), req, proto: Some(1) }).unwrap();
        let ServerMsg::Reply { reply, .. } = next_non_tasks(&mut c) else { panic!() };
        let reply: Reply = serde_json::from_value(reply).unwrap();
        let err = reply.error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("protocol"), "{}", err.message);
    }

    #[test]
    fn a_paired_computer_is_judged_by_its_version_floor_not_an_exact_match() {
        let (a, b) = (machine("A"), machine("B"));
        pair(&a, &b, Grant::Drive, Grant::Drive);
        let key = a.node.find("B").unwrap().key().unwrap();
        let req = serde_json::json!({ "id": "x", "cmd": "list", "project": null, "quiet": true });
        let call = |version: &str, proto: u32| {
            let mut c = stream_as_version(&b, &a.node.self_id(), &key, ClientKind::Computer, &[], Some(version)).unwrap();
            c.writer.send(&ClientMsg::Call { id: "c".into(), req: req.clone(), proto: Some(proto) }).unwrap();
            let ServerMsg::Reply { reply, .. } = next_non_tasks(&mut c) else { panic!() };
            serde_json::from_value::<Reply>(reply).unwrap()
        };
        // At the floor, on an older CLI protocol: still served.
        let r = call(termic_remote::compat::REQUIRES_DESKTOP, proto::PROTOCOL_VERSION - 1);
        assert!(r.ok, "{:?}", r.error);
        // Below it: refused, naming both versions.
        let r = call("0.0.1", proto::PROTOCOL_VERSION);
        let err = r.error.unwrap();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("0.0.1") && err.message.contains(termic_remote::compat::REQUIRES_DESKTOP), "{}", err.message);
        assert!(peer_compatible(Some("1.99.0"), Some(1)));
        assert!(!peer_compatible(Some("0.0.1"), Some(proto::PROTOCOL_VERSION)));
        assert!(peer_compatible(None, Some(proto::PROTOCOL_VERSION)));
        assert!(!peer_compatible(Some("dev"), Some(1)));
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
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let _ = tx.send(42);
        });
        let mut sink = Count(0);
        assert_eq!(await_with_heartbeat(rx, true, "r", &mut sink), Some(42));
        assert!(sink.0 >= 2, "heartbeats: {}", sink.0);
        // A single-reply verb gets none: a heartbeat would be read as its answer.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let _ = tx.send(1);
        });
        let mut sink = Count(0);
        assert_eq!(await_with_heartbeat(rx, false, "r", &mut sink), Some(1));
        assert_eq!(sink.0, 0);
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
