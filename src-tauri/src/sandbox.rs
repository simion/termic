// macOS sandbox-exec (Seatbelt) wrapper for per-task agent isolation.
//
// ⚠ sandbox-exec is Apple-deprecated. The binary still works on macOS 15
//   and there's no replacement on the horizon, but Apple reserves the
//   right to remove it. If/when that lands, the alternative is the
//   Endpoint Security framework (kext-replacement) which requires
//   notarized + entitled binaries and a much heavier integration. Don't
//   pre-port - we'd be guessing at the future API. Flag if it breaks on
//   a macOS release; current macOS minimum is 12.0 (tauri.conf.json).
//
// Built-in defaults (builtin_rw_paths / builtin_deny_paths / per-CLI
// host blocks in render_filter) are evaluated fresh at every spawn, so
// updates to these in NEW versions of Termic reach EVERY existing
// task automatically - they're not seeded onto the saved Task
// record. The Project's `sandbox_*` arrays are user-owned EXTRAS only.
// This is the explicit contract: never seed defaults onto a Project at
// create time; always grow built-ins in code.
//
// Layered model:
//   1. Outer kernel sandbox via `sandbox-exec -f <profile.sb>` - blocks
//      writes outside the allowlist, blocks all network except a single
//      loopback hop to our in-process CONNECT proxy.
//   2. The native Rust proxy (see `crate::proxy`) filters that loopback
//      hop against a per-task hostname allowlist (regex per line).
//      Anything not allowed → 403.
//
// Both pieces live for the lifetime of the agent PTY: the profile is a
// fresh file under tempdir() with the task id; the proxy is an
// in-process thread that gets torn down when the SandboxBundle drops.
//
// We used to shell out to tinyproxy here, which meant every user had
// to `brew install tinyproxy` (or have a bundled binary that wouldn't
// satisfy Gatekeeper without re-signing). The native proxy is ~300 LoC
// of std-only Rust, removes the dep, and makes the eventual Linux port
// trivial because there's no platform-specific binary to bundle.

use anyhow::{anyhow, Context, Result};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::Task;
use crate::SandboxMode;
use crate::proxy;
use crate::dlog;

/// One sandbox instance, scoped to a single PTY spawn. The proxy thread
/// is owned here so dropping the bundle shuts it down.
pub struct SandboxBundle {
    /// Absolute path to the rendered .sb profile under TMPDIR.
    pub profile_path: PathBuf,
    /// Filter file (one regex per line) written next to the profile so
    /// users can `cat` it when debugging "why was X blocked?". The
    /// proxy doesn't read this file - it gets the same patterns in
    /// memory at start() - but writing it keeps the user-visible
    /// debugging surface intact. Never read from Rust, hence allow.
    #[allow(dead_code)]
    pub filter_path: PathBuf,
    /// Native proxy handle. None only when start() failed (bad regex,
    /// EMFILE, etc.) - the caller downgrades to "filesystem sandbox +
    /// no network" rather than failing the spawn outright.
    pub proxy: Option<proxy::ProxyHandle>,
    /// This PTY's hold on the app-wide `log stream` (see `watch_task`).
    /// Counts per-path go into PATH_DENY_TRACKER (queryable via
    /// `path_deny_count` / `path_deny_list`). None when log stream
    /// couldn't start. Dropping the last handle kills the stream.
    #[allow(dead_code)]
    pub path_watcher: Option<PathWatcher>,
    /// The mode this bundle was provisioned for. wrap_command
    /// advertises it (TERMIC_SANDBOX_MODE) so the termic CLI can
    /// distinguish enforcing cages (control plane refused) from
    /// Monitor (observe-never-block: CLI use is allowed and logged).
    pub mode: crate::SandboxMode,
    /// Whether this PTY's profile cut off the Keychain, held for the PTY's
    /// lifetime so the footer can tell a block that is live from one only
    /// saved (see `keychain_open_count`).
    #[allow(dead_code)]
    pub keychain: KeychainHold,
    /// This spawn's credential broker (gh socket, placeholders, git MITM
    /// state), when its role resolved. Dropping it stops the socket.
    pub broker: Option<crate::broker::BrokerHandle>,
    /// EnforceFs only: the proxy the MITM deliveries are pointed at, so they
    /// have somewhere to run. git reaches it through its URL-scoped
    /// `http.<url>.proxy`; an API key's env proxy sets `HTTPS_PROXY` for the
    /// whole agent, with credentials only that delivery holds.
    #[allow(dead_code)]
    pub git_proxy: Option<proxy::ProxyHandle>,
}

/// The role a spawn runs with plus the secrets it can name, resolved in
/// lib.rs (`spawn_broker_setup`).
pub struct BrokerSetup {
    pub role: crate::secrets::Role,
    pub secrets: Vec<crate::secrets::SecretDef>,
}

/// Live agent PTYs per task that can reach the Keychain.
/// The footer says "Keychain blocked" only once this is zero, so a block
/// saved without a restart does not read as applied.
static KEYCHAIN_OPEN: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn keychain_open() -> &'static Mutex<HashMap<String, u64>> {
    KEYCHAIN_OPEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One PTY's entry in `KEYCHAIN_OPEN`, released on drop. A blocked PTY
/// registers nothing.
pub struct KeychainHold {
    task_id: Option<String>,
}

impl KeychainHold {
    pub(crate) fn new(task_id: &str, blocked: bool) -> Self {
        if blocked { return Self { task_id: None }; }
        *keychain_open().lock().unwrap_or_else(|e| e.into_inner())
            .entry(task_id.to_string()).or_insert(0) += 1;
        Self { task_id: Some(task_id.to_string()) }
    }
}

impl Drop for KeychainHold {
    fn drop(&mut self) {
        let Some(id) = self.task_id.take() else { return };
        let mut m = keychain_open().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = m.get_mut(&id) {
            *n = n.saturating_sub(1);
            if *n == 0 { m.remove(&id); }
        }
    }
}

/// How many of this task's live agent PTYs can still reach the Keychain:
/// caged ones whose profile left it open, plus uncaged ones (Off, or a
/// failed provision), which `pty_spawn` registers itself.
pub fn keychain_open_count(task_id: &str) -> u64 {
    keychain_open().lock().unwrap_or_else(|e| e.into_inner()).get(task_id).copied().unwrap_or(0)
}

/// One PTY's registration with the shared watcher. Every sandboxed PTY
/// holds one; the stream runs while any exist.
pub struct PathWatcher {
    task_id: String,
    monitor: bool,
}
impl Drop for PathWatcher {
    fn drop(&mut self) {
        let child = lock_watcher().detach(&self.task_id, self.monitor);
        reap(child);
    }
}

/// Kill and reap a stream the watcher handed back. Always called with the
/// watcher lock released: `wait` can block, and PathWatcher drops run under
/// the PTY map lock.
fn reap(child: Option<Child>) {
    if let Some(mut child) = child {
        // log stream doesn't catch SIGTERM cleanly on macOS in some
        // versions; SIGKILL is fine - it's a passive reader.
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ─── Per-task path-deny tracker (mirror of proxy's net tracker) ──
#[derive(Clone)]
pub struct PathDenyEntry {
    pub path: String,
    pub count: u64,
    pub last_seen_unix_ms: u128,
    /// Last PID the kernel attributed this deny to. Useful for "is
    /// this really claude, or some helper it spawned?" — the popover
    /// shows it so the user can pin a confusing deny to a real process.
    pub last_pid: u32,
    /// Process name from the deny line (`claude`, `node`, `git`, etc.).
    pub last_proc: String,
}

static PATH_DENY_TRACKER: OnceLock<Mutex<HashMap<String, HashMap<String, PathDenyEntry>>>> = OnceLock::new();

fn path_tracker() -> &'static Mutex<HashMap<String, HashMap<String, PathDenyEntry>>> {
    PATH_DENY_TRACKER.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn incr_path_deny(ws_id: &str, path: &str, pid: u32, proc: &str) {
    if ws_id.is_empty() || path.is_empty() { return; }
    if let Ok(mut g) = path_tracker().lock() {
        let per_ws = g.entry(ws_id.to_string()).or_insert_with(HashMap::new);
        let entry = per_ws.entry(path.to_string()).or_insert(PathDenyEntry {
            path: path.to_string(),
            count: 0,
            last_seen_unix_ms: 0,
            last_pid: 0,
            last_proc: String::new(),
        });
        entry.count += 1;
        entry.last_seen_unix_ms = now_unix_ms();
        entry.last_pid = pid;
        entry.last_proc = proc.to_string();
    }
}

pub fn path_deny_count(ws_id: &str) -> u64 {
    path_tracker().lock().ok()
        .and_then(|g| g.get(ws_id).map(|m| m.values().map(|e| e.count).sum()))
        .unwrap_or(0)
}

pub fn path_deny_list(ws_id: &str) -> Vec<PathDenyEntry> {
    let mut out: Vec<PathDenyEntry> = path_tracker().lock().ok()
        .and_then(|g| g.get(ws_id).map(|m| m.values().cloned().collect()))
        .unwrap_or_default();
    out.sort_by(|a, b| b.last_seen_unix_ms.cmp(&a.last_seen_unix_ms));
    out
}

/// Wipe the task's entire path-deny tracker. Called from
/// `provision()` so each fresh PTY spawn starts from a clean slate —
/// otherwise denies logged under an older SBPL profile (before a
/// migration added a path, before the user clicked Allow, etc.)
/// stick around in the popover even though the new profile would
/// permit them. If anything is still being denied under the new
/// profile, the kernel re-logs and the tracker fills back up
/// instantly.
pub fn clear_path_denies(ws_id: &str) {
    if ws_id.is_empty() { return; }
    if let Ok(mut g) = path_tracker().lock() {
        if let Some(per_ws) = g.get_mut(ws_id) {
            per_ws.clear();
        }
    }
}

// ─── Per-task path-ACCESS tracker (MONITORING mode) ──────────────
// In monitoring mode the seatbelt profile is `(allow default (with
// report))`, so the kernel logs EVERY file operation (allowed) instead
// of denies. We capture all of them here, keyed by (path, op) so the
// activity popover can show "what the agent touched, how, and how
// often" — plus a would_block flag computed against what ENFORCING
// mode WOULD have allowed, so the user knows what to whitelist before
// flipping to enforce.
#[derive(Clone)]
pub struct PathAccessEntry {
    pub path: String,
    /// Operation token, e.g. file-read-data / file-write-create.
    pub op: String,
    pub count: u64,
    pub last_seen_unix_ms: u128,
    pub last_pid: u32,
    pub last_proc: String,
    /// True iff ENFORCING mode would have denied this op on this path.
    pub would_block: bool,
}

static PATH_ACCESS_TRACKER: OnceLock<Mutex<HashMap<String, HashMap<String, PathAccessEntry>>>> = OnceLock::new();

fn path_access_tracker() -> &'static Mutex<HashMap<String, HashMap<String, PathAccessEntry>>> {
    PATH_ACCESS_TRACKER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hard cap on distinct (path, op) rows tracked per task in
/// MONITORING. The agent's allow firehose touches a unique path per file;
/// without a cap a big `npm install` / `cargo build` could accumulate
/// 100k+ entries. At the cap we stop recording NEW paths (existing rows
/// still bump their counts), so memory is bounded (~a few MB) and nothing
/// grows unboundedly. Cleared entirely on the next spawn.
const PATH_ACCESS_CAP: usize = 20_000;

fn incr_path_access(ws_id: &str, path: &str, op: &str, pid: u32, proc: &str, would_block: bool, add: u64) {
    if ws_id.is_empty() || path.is_empty() { return; }
    // Key by path + op so a read and a write to the same path are
    // tracked as distinct rows (the user cares which kind of access).
    let key = format!("{path}\u{0}{op}");
    if let Ok(mut g) = path_access_tracker().lock() {
        let per_ws = g.entry(ws_id.to_string()).or_insert_with(HashMap::new);
        // Bound memory: once at the cap, keep counting paths we already
        // know but don't add new distinct ones.
        if per_ws.len() >= PATH_ACCESS_CAP && !per_ws.contains_key(&key) {
            return;
        }
        let entry = per_ws.entry(key).or_insert(PathAccessEntry {
            path: path.to_string(),
            op: op.to_string(),
            count: 0,
            last_seen_unix_ms: 0,
            last_pid: 0,
            last_proc: String::new(),
            would_block,
        });
        entry.count += add.max(1);
        entry.last_seen_unix_ms = now_unix_ms();
        entry.last_pid = pid;
        entry.last_proc = proc.to_string();
        entry.would_block = would_block;
    }
}

pub fn path_access_count(ws_id: &str) -> u64 {
    path_access_tracker().lock().ok()
        .and_then(|g| g.get(ws_id).map(|m| m.values().map(|e| e.count).sum()))
        .unwrap_or(0)
}

pub fn path_access_list(ws_id: &str) -> Vec<PathAccessEntry> {
    let mut out: Vec<PathAccessEntry> = path_access_tracker().lock().ok()
        .and_then(|g| g.get(ws_id).map(|m| m.values().cloned().collect()))
        .unwrap_or_default();
    out.sort_by(|a, b| b.last_seen_unix_ms.cmp(&a.last_seen_unix_ms));
    out
}

pub fn clear_path_access(ws_id: &str) {
    if ws_id.is_empty() { return; }
    if let Ok(mut g) = path_access_tracker().lock() {
        if let Some(per_ws) = g.get_mut(ws_id) {
            per_ws.clear();
        }
    }
}

// ─── Monitor recording filters ───────────────────────────────────────
// The activity view exists so users can pre-build an agent's allow-list
// with low friction — the actionable rows are the would-block ones. So
// the filters gate RECORDING, not just display: with them on we never
// store the always-allowed spam (the agent's own config churn, the
// task dir), which saves CPU + memory. Per-task, runtime-
// settable from the popover. Defaults: exclude the task dir (true),
// show everything else (wb_only=false).
#[derive(Clone, Copy)]
struct MonitorFilters { exclude_ws: bool, wb_only: bool }
impl Default for MonitorFilters {
    // Default to the allow-list-building posture: record only would-block
    // accesses, and never the task dir. Minimal recording out of the
    // box; the user can widen via the popover checkboxes.
    fn default() -> Self { MonitorFilters { exclude_ws: true, wb_only: true } }
}
static MONITOR_FILTERS: OnceLock<Mutex<HashMap<String, MonitorFilters>>> = OnceLock::new();
fn monitor_filters_map() -> &'static Mutex<HashMap<String, MonitorFilters>> {
    MONITOR_FILTERS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn monitor_filters(ws_id: &str) -> MonitorFilters {
    monitor_filters_map().lock().ok()
        .and_then(|g| g.get(ws_id).copied())
        .unwrap_or_default()
}
pub fn set_monitor_filters(ws_id: &str, exclude_ws: bool, wb_only: bool) {
    if let Ok(mut g) = monitor_filters_map().lock() {
        g.insert(ws_id.to_string(), MonitorFilters { exclude_ws, wb_only });
    }
}

/// Canonical dirs that "exclude task dir" hides: the task path
/// plus each multi-repo member's resolved path.
pub fn task_exclude_dirs(task: &Task) -> Vec<String> {
    let mut v = vec![canonicalize_or_keep(&task.path)];
    for m in &task.composition {
        let c = canonicalize_or_keep(&m.path);
        if !c.is_empty() { v.push(c); }
    }
    v.retain(|s| !s.is_empty());
    v
}

/// Drop already-recorded entries that the (now-enabled) filters would
/// exclude, so toggling a filter on immediately reclaims memory + clears
/// the view rather than waiting for them to age out.
pub fn prune_path_access(ws_id: &str, exclude_ws: bool, wb_only: bool, ws_dirs: &[String]) {
    if let Ok(mut g) = path_access_tracker().lock() {
        if let Some(per_ws) = g.get_mut(ws_id) {
            per_ws.retain(|_, e| {
                if exclude_ws && ws_dirs.iter().any(|d| under(&e.path, d)) { return false; }
                if wb_only && !e.would_block { return false; }
                true
            });
        }
    }
}

// ─── Monitor policy: replicate ENFORCING's allow/deny decision so we
//     can flag, per observed access, whether the cage WOULD have
//     blocked it. Computed once at provision time and moved into the
//     log-watcher thread. Mirrors render_profile's path-set logic.
#[derive(Clone, Default)]
pub struct MonitorPolicy {
    /// Read + write allowed (task, user, agent, runtime dirs).
    rw_subpaths: Vec<String>,
    /// Read-only system roots (binaries, linker, etc.).
    read_roots: Vec<String>,
    /// Read + write allowed via `regex:` allow entries (e.g. claude's
    /// `^$HOME/\.claude(\.[^/]*|/.*)?$` covering .claude.json / .lock /
    /// .tmp.*). Without these, monitor falsely flags regex-allowed paths
    /// as "would block".
    rw_regexes: Vec<regex::Regex>,
    /// Task ancestor directory nodes granted read as `literal` (the
    /// exact path, NOT its subtree) so realpath(cwd) traversal isn't
    /// flagged would-block. Mirrors render_profile's ancestor grants.
    read_literals: Vec<String>,
}

fn under(path: &str, base: &str) -> bool {
    path == base || (path.len() > base.len() && path.starts_with(base) && path.as_bytes()[base.len()] == b'/')
}

impl MonitorPolicy {
    /// Would ENFORCING mode have blocked `op` on `path`? Pure allow-list:
    /// nothing is reachable unless it's under an allowed path. Metadata /
    /// existence are NOT globally allowed anymore — they follow the read
    /// rules (allowed where `file-read*` is: rw paths + read roots).
    pub fn would_block(&self, path: &str, op: &str) -> bool {
        // Globally-allowed ops in ENFORCING: metadata/existence (needed
        // for symlink traversal + stat) and map-executable/issue-extension.
        if op.contains("metadata") || op.contains("test-existence")
            || op.contains("map-executable") || op.contains("issue-extension") {
            return false;
        }
        // SBPL_HEADER globally allows write + ioctl on CHARACTER-DEVICEs
        // (/dev/null, /dev/tty, PTYs, /dev/dtracehelper, …). Mirror that so
        // monitor doesn't over-report device ops as "would block". ioctl is
        // only ever issued on devices/ttys here, so treat it as allowed.
        if op.contains("ioctl") { return false; }
        if op.contains("write") && (path == "/dev" || path.starts_with("/dev/")) { return false; }
        // rw allow-list grants read + write + metadata within it.
        if self.rw_subpaths.iter().any(|a| under(path, a)) { return false; }
        // rw regex allows (e.g. claude's ~/.claude family).
        if self.rw_regexes.iter().any(|r| r.is_match(path)) { return false; }
        // Reads (incl. metadata / existence) are additionally allowed on
        // the read-only system roots + the "/" entry.
        let is_write = op.contains("write") || op.contains("create")
            || op.contains("unlink") || op.contains("ioctl") || op.contains("mount");
        if !is_write {
            if path == "/" { return false; }
            if self.read_roots.iter().any(|r| under(path, r)) { return false; }
            // Task ancestor nodes are granted read as `literal`
            // (exact path, not subtree) so realpath(cwd) traversal isn't
            // flagged; sibling contents under them still block.
            if self.read_literals.iter().any(|d| path == d) { return false; }
        }
        // Anything else: enforce would deny.
        true
    }
}

/// System roots that ENFORCING allows for reads only. Extracted so both
/// `render_profile` and `compute_monitor_policy` share one source of
/// truth.
fn system_read_roots() -> &'static [&'static str] {
    &[
        "/usr", "/opt", "/bin", "/sbin",
        "/dev", "/private/etc", "/etc",
        "/System/Library", "/System/Volumes/Preboot/Cryptexes", "/private/var/db",
        // Apple Command Line Tools toolchain. The system /usr/bin/git is an
        // xcrun shim that dlopen()s .../CommandLineTools/usr/lib/libxcrun.dylib;
        // without this read root that open() is blocked and git/clang/make/swift
        // fail. Read-only (system roots never get file-write*), root-owned, no
        // user secrets — same trust class as /usr and /System/Library.
        "/Library/Developer/CommandLineTools",
        // The rest of /Library, reads only. Same trust class as the roots
        // above: root-owned, world-readable system state (frameworks, fonts,
        // preferences, launch agents), and no USER secrets, which live in
        // `~/Library` and stay off this list.
        //
        // Muse Code is what surfaced it. Under ENFORCING it failed at startup
        // with "Agent Definition filesystem source failed: IoError", which is
        // fatal rather than degraded, and the deny it came from is a read
        // somewhere under /Library. Narrowing was tried and does not work:
        // enumerating all 74 children of /Library as individual subpaths still
        // fails, while `subpath "/Library"` or a regex over it succeeds, which
        // points at macOS firmlink canonicalisation (/Library is really
        // /System/Volumes/Data/Library) rather than at one identifiable file.
        // Reproduced deterministically, five runs each way.
        //
        // Reads only, and the trailing `(deny ...)` rules still win over it:
        // termic's own data dir stays denied, as does everything the deny list
        // covers, because this profile is last-match-wins and those come after.
        "/Library",
        "/lib", "/lib32", "/lib64", "/libx32",
        "/proc", "/sys", "/run",
    ]
}

/// Build the would-block classifier for a task, mirroring the path
/// sets that `render_profile` emits for ENFORCING mode.
pub fn compute_monitor_policy(task: &Task, agent_override: Option<&str>) -> MonitorPolicy {
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let task_path = canonicalize_or_keep(&task.path);
    let subst = |p: &str| subst_path(p, &home, &task_path);

    let mut rw_subpaths: Vec<String> = vec![task_path.clone()];
    for m in &task.composition {
        let resolved = canonicalize_or_keep(&m.path);
        if !resolved.is_empty() { rw_subpaths.push(resolved); }
    }
    for ws_root in std::iter::once(task_path.as_str())
        .chain(task.composition.iter().map(|m| m.path.as_str()))
    {
        if let Some(parent_git) = parent_git_dir_for_worktree(ws_root) {
            rw_subpaths.push(parent_git);
        }
    }
    // `regex:` allow entries (e.g. claude's ~/.claude family) — compiled
    // so would_block honors them. $HOME / $WORKSPACE are regex-escaped,
    // matching render_profile's emit so the classifier agrees with the cage.
    let home_esc = regex::escape(&home);
    let ws_esc = regex::escape(&task_path);
    let mut rw_regexes: Vec<regex::Regex> = Vec::new();
    let collect = |raw: &str, subs: &mut Vec<String>, regs: &mut Vec<regex::Regex>| {
        let raw = raw.trim();
        if let Some(rest) = raw.strip_prefix("regex:") {
            let pat = rest.trim().replace("$HOME", &home_esc).replace("$WORKSPACE", &ws_esc);
            if !pat.is_empty() {
                if let Ok(re) = regex::Regex::new(&pat) { regs.push(re); }
            }
        } else {
            let s = subst(raw);
            if !s.is_empty() { subs.push(s); }
        }
    };
    // User allowed paths.
    for p in &task.sandbox_rw_paths {
        collect(p, &mut rw_subpaths, &mut rw_regexes);
    }
    // Per-agent allowed paths from the registry.
    let settings = crate::load_settings_inner();
    let effective_cli = agent_override.unwrap_or(&task.cli);
    // Resolved through `extends`, the one mechanism: a clone that never set its
    // own paths inherits the parent's CURRENT list rather than a copy frozen
    // when it was created. This started as a bespoke two-line fallback here,
    // which is how a second convention gets born; there is one resolver now.
    let paths = crate::agent_dirs::resolve_agent(&settings.agents, effective_cli)
        .map(|a| a.sandbox_allowed_paths)
        .unwrap_or_default();
    for p in &paths {
        collect(p, &mut rw_subpaths, &mut rw_regexes);
    }
    // The agent's OWN config dir, resolved rather than assumed.
    //
    // A clone made to hold a second account relocates its whole config
    // (`CLAUDE_CONFIG_DIR=$HOME/.next-claude`) and inherits the parent's
    // literal `$HOME/.claude` patterns, which do not match it. The cage then
    // denied the agent its own login: 49 blocked paths under
    // `$HOME/.next-claude/`, telemetry, plugins and `.claude.json` included.
    //
    // Relocation folds the HOME-root dotfiles inside the dir (agent_dirs), so
    // one subpath covers what the parent needed a regex for.
    if let Some(dir) = crate::agent_dirs::instance_config_dir(&settings.agents, effective_cli, std::path::Path::new(&home)) {
        collect(&dir.to_string_lossy(), &mut rw_subpaths, &mut rw_regexes);
    }
    // ...and the named account's login store, which is somewhere else entirely
    // (GH #278). Monitor mode never blocks, but it DECIDES what would have
    // been blocked, and an answer that differs from the enforcing profile is
    // worse than no answer: it teaches the user to distrust the report.
    if let Some(dir) = crate::task_login_store(task, effective_cli) {
        collect(&dir.to_string_lossy(), &mut rw_subpaths, &mut rw_regexes);
    }
    // Runtime dirs (also canonicalized symlink targets).
    for p in builtin_runtime_paths(&home, &task_path) {
        let canon = canonicalize_or_keep(&p);
        rw_subpaths.push(p);
        if !canon.is_empty() { rw_subpaths.push(canon); }
    }
    dedupe(&mut rw_subpaths);

    // Read roots = system read-only roots + read-only runtime paths
    // (e.g. ~/.ssh/known_hosts). Reads here don't block; writes do.
    let mut read_roots: Vec<String> = system_read_roots().iter().map(|s| s.to_string()).collect();
    read_roots.extend(builtin_runtime_readonly_paths(&home));
    // Task ancestor path nodes (literal reads) so the monitor's
    // would-block classifier agrees with what render_profile permits for
    // realpath(cwd) traversal.
    let read_literals = task_ancestor_dirs(task);
    MonitorPolicy { rw_subpaths, read_roots, rw_regexes, read_literals }
}

// ─── PID ancestry tracker ────────────────────────────────────────────
//
// The path watcher subscribes to a system-wide log predicate, so
// without filtering it picks up EVERY sandboxed process on the Mac
// (Finder hitting iCloud, browser sandboxes, Spotlight indexer, ...).
// The fix: only count denies whose process is a descendant of one of
// the PIDs we spawned under our sandbox. Each pty_spawn registers its
// child PID here; the watcher walks the kernel PPID chain once per pid
// and routes the line to the task that owns the root it reaches.

static SANDBOX_PIDS: OnceLock<Mutex<HashMap<String, HashSet<u32>>>> = OnceLock::new();
/// Bumped on every root change so the watcher's pid -> task cache knows
/// its answers may be stale.
static SANDBOX_PIDS_GEN: AtomicU64 = AtomicU64::new(0);

fn sandbox_pids() -> &'static Mutex<HashMap<String, HashSet<u32>>> {
    SANDBOX_PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a freshly-spawned PID as a sandbox root for `ws_id`. Called
/// from pty_spawn right after we get the child pid from CommandBuilder.
pub fn register_root_pid(ws_id: &str, pid: u32) {
    if ws_id.is_empty() || pid == 0 { return; }
    if let Ok(mut g) = sandbox_pids().lock() {
        g.entry(ws_id.to_string()).or_default().insert(pid);
    }
    SANDBOX_PIDS_GEN.fetch_add(1, Ordering::Relaxed);
}

/// Drop a root PID when its PTY exits. Keeps the set from growing
/// unboundedly across sessions.
pub fn unregister_root_pid(ws_id: &str, pid: u32) {
    if ws_id.is_empty() || pid == 0 { return; }
    if let Ok(mut g) = sandbox_pids().lock() {
        if let Some(set) = g.get_mut(ws_id) {
            set.remove(&pid);
        }
    }
    SANDBOX_PIDS_GEN.fetch_add(1, Ordering::Relaxed);
}

/// PPID for a live PID, None if the process already exited (most likely
/// for short-lived helpers); the watcher treats that as "not ours" - a
/// false negative is preferred over counting other apps' denies under our
/// task. libproc, never `ps`: this runs for every deny line on the Mac,
/// and forking per hop cost >150 spawns/s with ~25 panes open.
#[cfg(target_os = "macos")]
fn ppid_of(pid: u32) -> Option<u32> {
    crate::procmon::short_info(pid).map(|(ppid, _)| ppid)
}
#[cfg(not(target_os = "macos"))]
fn ppid_of(_pid: u32) -> Option<u32> { None }

/// Session id for a live PID. portable-pty `setsid()`s every PTY child, so
/// an agent root's pid is its session id, and its descendants keep it after
/// they are orphaned to launchd. It can't be forged into another task:
/// `setsid` only ever starts a session numbered after the caller.
#[cfg(unix)]
fn sid_of(pid: u32) -> Option<u32> {
    // SAFETY: getsid only reads the kernel's process table.
    let s = unsafe { libc::getsid(pid as libc::pid_t) };
    (s > 0).then_some(s as u32)
}
#[cfg(not(unix))]
fn sid_of(_pid: u32) -> Option<u32> { None }

/// Executable path for a PID, the popover's fallback when the log-parsed
/// process name is empty or a bare version string. A path, not the
/// kernel's short name: that is capped at 15 chars and, for claude's
/// version-named binary (`.../claude/versions/2.1.144`), is the same
/// useless `2.1.144` the fallback exists to replace. `ps -o comm=` printed
/// this path too.
#[cfg(target_os = "macos")]
fn exe_of(pid: u32) -> Option<String> {
    crate::procmon::pid_path(pid).filter(|p| !p.is_empty())
}
#[cfg(not(target_os = "macos"))]
fn exe_of(_pid: u32) -> Option<String> { None }

/// Which task owns `pid`: walk up the PPID chain until a registered root
/// (`roots`: root pid -> task id) turns up. Depth 20 guards against
/// pathological pid loops (shouldn't happen on macOS). A process whose
/// parent exited is reparented to launchd and breaks the walk, so the
/// session id (see `sid_of`) is the fallback.
fn owner_of(pid: u32, roots: &HashMap<u32, Arc<str>>, ppid: impl Fn(u32) -> Option<u32>, sid: impl Fn(u32) -> Option<u32>) -> Option<Arc<str>> {
    let mut cur = pid;
    for _ in 0..20 {
        if let Some(task) = roots.get(&cur) { return Some(task.clone()); }
        if cur <= 1 { break; }
        match ppid(cur) {
            Some(p) if p != cur => cur = p,
            _ => break,
        }
    }
    sid(pid).and_then(|s| roots.get(&s).cloned())
}

/// Whether `pid` descends from one of `task_id`'s registered agent roots:
/// the credential broker's peer check on its gh socket.
pub(crate) fn pid_in_task(task_id: &str, pid: u32) -> bool {
    let roots: HashMap<u32, Arc<str>> = match sandbox_pids().lock() {
        Ok(g) => match g.get(task_id) {
            Some(ps) => {
                let t: Arc<str> = task_id.into();
                ps.iter().map(|p| (*p, t.clone())).collect()
            }
            None => return false,
        },
        Err(_) => return false,
    };
    owner_of(pid, &roots, ppid_of, sid_of).is_some()
}

/// `pid`'s executable and its parent chain, for logging a peer that
/// failed `pid_in_task`. An orphan ends at `1 launchd`; a process that
/// already exited reads `(exited)`.
pub(crate) fn describe_pid(pid: u32) -> String {
    pid_chain(pid, ppid_of, exe_of)
}

fn pid_chain(pid: u32, ppid: impl Fn(u32) -> Option<u32>, exe: impl Fn(u32) -> Option<String>) -> String {
    let name = |p: u32| exe(p).map(|e| e.rsplit('/').next().unwrap_or(&e).to_string()).unwrap_or_else(|| "?".into());
    let mut out = format!("pid {pid} {}", exe(pid).unwrap_or_else(|| "(exited)".into()));
    let mut parents = Vec::new();
    let mut cur = pid;
    // same depth cap as owner_of, so the log shows exactly what the walk saw.
    for _ in 0..20 {
        match ppid(cur) {
            Some(p) if p != cur => { parents.push(format!("{p} {}", name(p))); cur = p; }
            _ => break,
        }
        if cur <= 1 { break; }
    }
    if !parents.is_empty() { out.push_str(&format!(", parents: {}", parents.join(" < "))); }
    out
}

/// What the router learned about one pid.
struct Proc {
    /// the parent it had when routed. A pid recycled under a different
    /// parent no longer matches, so its cached answer is thrown away.
    ppid: u32,
    owner: Option<Arc<str>>,
    exe: std::cell::OnceCell<Option<String>>,
}

/// Resolves a log line's pid for `dispatch_line`. The reader's `Router` in
/// the app, a fixed answer in tests.
trait Resolve {
    fn owner(&mut self, pid: u32) -> Option<Arc<str>>;
    fn exe(&mut self, pid: u32) -> Option<String>;
}

/// pid -> owning task, cached. Owned by the single reader thread, so no
/// locking past the root snapshot. The cache is dropped when roots change
/// or when it gets big, and every hit re-reads the pid's parent (one
/// libproc call, against up to 20 for a walk) so a recycled pid can't
/// inherit a stale answer.
struct Router {
    gen: u64,
    roots: HashMap<u32, Arc<str>>,
    cache: HashMap<u32, Proc>,
    ppid: fn(u32) -> Option<u32>,
    sid: fn(u32) -> Option<u32>,
    exe: fn(u32) -> Option<String>,
}

impl Router {
    fn new(ppid: fn(u32) -> Option<u32>, sid: fn(u32) -> Option<u32>, exe: fn(u32) -> Option<String>) -> Self {
        Router { gen: u64::MAX, roots: HashMap::new(), cache: HashMap::new(), ppid, sid, exe }
    }
}

impl Resolve for Router {
    fn owner(&mut self, pid: u32) -> Option<Arc<str>> {
        let gen = SANDBOX_PIDS_GEN.load(Ordering::Relaxed);
        if gen != self.gen || self.cache.len() >= 8192 {
            self.roots = match sandbox_pids().lock() {
                Ok(g) => g.iter().flat_map(|(t, ps)| {
                    let t: Arc<str> = t.as_str().into();
                    ps.iter().map(move |p| (*p, t.clone()))
                }).collect(),
                Err(_) => HashMap::new(),
            };
            self.cache.clear();
            self.gen = gen;
        }
        if let Some(task) = self.roots.get(&pid) { return Some(task.clone()); }
        let live = (self.ppid)(pid);
        if let Some(hit) = self.cache.get(&pid) {
            // an exited pid isn't held by anyone else yet, so the line came
            // from the process we routed: keep its answer. That is also the
            // only way a deny from an already-exited helper gets attributed.
            if live.is_none() || live == Some(hit.ppid) { return hit.owner.clone(); }
        }
        let parent = live?;
        let owner = owner_of(parent, &self.roots, self.ppid, self.sid);
        self.cache.insert(pid, Proc { ppid: parent, owner: owner.clone(), exe: Default::default() });
        owner
    }

    fn exe(&mut self, pid: u32) -> Option<String> {
        let lookup = self.exe;
        match self.cache.get(&pid) {
            Some(p) => p.exe.get_or_init(|| lookup(pid)).clone(),
            None => lookup(pid),
        }
    }
}

/// Drop every path-deny entry for this task whose path is at or
/// under `prefix`. Called after the user clicks "Allow" on a path so
/// the historical deny rows actually disappear from the popover —
/// without this, the in-memory tracker keeps the entry around and the
/// row sticks even though future accesses succeed.
pub fn clear_path_denies_under(ws_id: &str, prefix: &str) {
    if ws_id.is_empty() || prefix.is_empty() { return; }
    // Normalize trailing slash so the prefix check is unambiguous:
    // we treat "/a/b" as covering "/a/b" AND "/a/b/...". A leaf-match
    // also covers the leaf itself (path == prefix), so the user can
    // allow a single-file deny and have it disappear.
    let prefix = prefix.trim_end_matches('/');
    let sep_prefix = format!("{prefix}/");
    if let Ok(mut g) = path_tracker().lock() {
        if let Some(per_ws) = g.get_mut(ws_id) {
            per_ws.retain(|p, _| {
                let p_norm = p.trim_end_matches('/');
                p_norm != prefix && !p_norm.starts_with(&sep_prefix)
            });
        }
    }
}

// ─── Shared path watcher ─────────────────────────────────────────────
//
// ONE `log stream` for the whole app, not one per sandboxed PTY. The
// predicate is system-wide either way, so N streams meant N copies of the
// same firehose decoded by N `log` processes (plus diagnosticd fanning it
// out N times), and N ancestry walks per line. Measured with 25 panes:
// ~73% CPU in the streams and ~36% in termic, mostly forking `ps`.
// See docs/performance.md bear trap 13.

/// ENFORCING tails seatbelt DENY events. MONITORING's profile is
/// `(allow default (with report))`, so the kernel logs every ALLOWED file
/// op instead (scoped to file ops to keep the firehose down; the PID
/// routing + /Users path filters do the rest). One OR'd predicate covers
/// both, so a mix of modes still costs one stream. Kept loose - some macOS
/// versions tag seatbelt events under kernel/sandboxd, others under
/// com.apple.libsandbox, others don't tag at all. We match on "Sandbox" in
/// the message, which is present in every form, then filter in the parser.
const WATCH_PREDICATE: &str = "eventMessage CONTAINS \"Sandbox\" AND \
    ((eventMessage CONTAINS \"Sandbox:\" AND eventMessage CONTAINS \"deny\") OR \
    (eventMessage CONTAINS \" allow \" AND eventMessage CONTAINS \"file-\"))";

/// What the reader needs to record a line for one task. The monitor
/// fields come from the latest MONITOR provision. The policy is
/// agent-specific (`compute_monitor_policy`), so two agents in one Monitor
/// task share whichever spawned last.
struct WatchedTask {
    path: String,
    ws_dirs: Vec<String>,
    policy: MonitorPolicy,
}

/// One task's live PTYs, counted per mode. `task_set_sandbox(kill_live=false)`
/// leaves old PTYs running under the old mode, so one task can have caged
/// and monitored agents at once, and each keeps its lines recorded.
#[derive(Clone)]
struct Holds {
    cfg: Arc<WatchedTask>,
    enforce: usize,
    monitor: usize,
}

/// Starts a `log stream` whose reader reports back as generation `gen`.
/// Injectable so tests count starts without running `log`.
type Spawn = Box<dyn FnMut(u64) -> Option<Child> + Send>;

/// A stream that dies sooner than this after starting isn't restarted by
/// its reader (crash-loop guard, no sleep); the next sandboxed spawn retries.
const RESPAWN_MIN_LIFE: Duration = Duration::from_secs(10);

struct Watcher {
    tasks: HashMap<String, Holds>,
    child: Option<Child>,
    /// bumped per stream started, so a reader can tell whether the stream
    /// it drained is still the current one. The OS pid can't: it recycles.
    gen: u64,
    started: Instant,
    spawn: Spawn,
}

impl Watcher {
    fn new(spawn: Spawn) -> Self {
        Watcher { tasks: HashMap::new(), child: None, gen: 0, started: Instant::now(), spawn }
    }

    fn start(&mut self) -> bool {
        self.gen += 1;
        self.child = (self.spawn)(self.gen);
        self.started = Instant::now();
        self.child.is_some()
    }

    /// Take one PTY's hold on `task_id`, starting the stream if none is
    /// running. False, with nothing recorded, when it couldn't start.
    fn attach(&mut self, task_id: &str, monitor: bool, cfg: WatchedTask) -> bool {
        if self.child.is_none() && !self.start() { return false; }
        let cfg = Arc::new(cfg);
        let h = self.tasks.entry(task_id.to_string())
            .or_insert_with(|| Holds { cfg: cfg.clone(), enforce: 0, monitor: 0 });
        // an enforce spawn carries no monitor policy: don't let it replace
        // the one live Monitor PTYs of this task are still using.
        if monitor || h.monitor == 0 { h.cfg = cfg; }
        if monitor { h.monitor += 1 } else { h.enforce += 1 }
        true
    }

    /// Release one PTY's hold. Hands back the stream when that was the last
    /// hold on any task, for the caller to `reap` outside the lock.
    fn detach(&mut self, task_id: &str, monitor: bool) -> Option<Child> {
        if let Some(h) = self.tasks.get_mut(task_id) {
            let n = if monitor { &mut h.monitor } else { &mut h.enforce };
            *n = n.saturating_sub(1);
            if h.enforce + h.monitor == 0 { self.tasks.remove(task_id); }
        }
        if self.tasks.is_empty() { self.child.take() } else { None }
    }

    /// Stream `gen`'s reader hit EOF. If that is still the current stream,
    /// hand it back to reap, and start a replacement when PTYs still hold
    /// the watcher so open panes don't go quiet. A stale reader (its stream
    /// already stopped or replaced) changes nothing.
    fn on_stream_exit(&mut self, gen: u64) -> Option<Child> {
        if gen != self.gen { return None; }
        let dead = self.child.take();
        if !self.tasks.is_empty() && self.started.elapsed() >= RESPAWN_MIN_LIFE {
            self.start();
        }
        dead
    }

    fn task(&self, task_id: &str) -> Option<Holds> {
        self.tasks.get(task_id).cloned()
    }
}

static WATCHER: OnceLock<Mutex<Watcher>> = OnceLock::new();

fn lock_watcher() -> std::sync::MutexGuard<'static, Watcher> {
    WATCHER.get_or_init(|| Mutex::new(Watcher::new(Box::new(spawn_stream))))
        .lock().unwrap_or_else(|e| e.into_inner())
}

/// Register a sandboxed PTY of `task_id` with the shared watcher, starting
/// `log stream` if it's the first. Returns None if the stream couldn't
/// start - non-fatal, just means no path counter for this PTY.
fn watch_task(task_id: &str, task_path: &str, ws_dirs: Vec<String>, monitor: bool, policy: MonitorPolicy) -> Option<PathWatcher> {
    let cfg = WatchedTask { path: task_path.to_string(), ws_dirs, policy };
    lock_watcher().attach(task_id, monitor, cfg)
        .then(|| PathWatcher { task_id: task_id.to_string(), monitor })
}

fn spawn_stream(gen: u64) -> Option<Child> {
    use std::io::{BufRead, BufReader};

    let mut child = crate::proc_ctl::command("/usr/bin/log")
        .args(["stream", "--predicate", WATCH_PREDICATE, "--style", "compact"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let Some(stdout) = child.stdout.take() else {
        reap(Some(child));
        return None;
    };
    let stream_pid = child.id();
    dlog(&format!("[sandbox] path watcher started (log stream {stream_pid}, gen {gen})"));
    std::thread::spawn(move || {
        let mut router = Router::new(ppid_of, sid_of, exe_of);
        for line in BufReader::new(stdout).lines().flatten() {
            dispatch_line(&line, &mut router);
        }
        dlog(&format!("[sandbox] path watcher exited (log stream {stream_pid}, gen {gen})"));
        // a reader can still be draining its killed stream's pipe while a
        // replacement starts, so for that sliver one event can count twice.
        // Harmless, and the kill stays outside the lock regardless.
        let dead = lock_watcher().on_stream_exit(gen);
        reap(dead);
    });
    Some(child)
}

/// Route one log line to the task that owns its pid and record it. Each
/// line is recorded once, against one task, however many PTYs that task
/// has open.
fn dispatch_line(line: &str, r: &mut impl Resolve) {
    // whichever marker comes first decides the kind, so a path that happens
    // to contain the other one can't flip it.
    let is_deny = match (line.find("deny("), line.find(" allow ")) {
        (Some(d), Some(a)) => d < a,
        (Some(_), None) => true,
        _ => false,
    };
    let pid = if is_deny { extract_deny_pid(line) } else { monitor_pid_and_dup(line).map(|(p, _)| p) };
    let Some(pid) = pid else { return; };
    let Some(task_id) = r.owner(pid) else { return; };
    let Some(h) = lock_watcher().task(&task_id) else { return; };
    if is_deny {
        if h.enforce > 0 { handle_deny_line(line, pid, &task_id, &h.cfg.path, r); }
    } else if h.monitor > 0 {
        handle_monitor_line(line, &task_id, &h.cfg.path, &h.cfg.ws_dirs, &h.cfg.policy, r);
    }
}

/// Process name for the popover: the log-parsed one, unless it looks like a
/// bare version string (claude logs itself as `claude 2.1.144` and some
/// formatters strip the leading word), then the executable's path.
fn proc_name(parsed: Option<String>, pid: u32, r: &mut impl Resolve) -> String {
    let parsed = parsed.unwrap_or_default();
    let looks_versionlike = !parsed.is_empty()
        && parsed.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-');
    if !parsed.is_empty() && !looks_versionlike { return parsed; }
    r.exe(pid).unwrap_or_else(|| if parsed.is_empty() { "?".into() } else { parsed })
}

fn handle_deny_line(line: &str, pid: u32, ws_id: &str, ws_path: &str, r: &mut impl Resolve) {
    // Sample deny line on macOS 15 (Sequoia):
    //   2026-05-18 ...  Sandbox: openssl(12345) deny(1) file-write-create /Users/x/Pictures/ccc.txt
    //
    // Older macOS variants:
    //   ... Sandbox: <proc>/<thread> deny(1) <op> <path>
    //
    // We look for the operation token (`file-` or `network-`) and treat
    // everything after it as the path. Falls back to the first
    // absolute-path prefix in the line if no op token is present.
    let Some(path) = extract_deny_path(line) else { return; };
    // Belt-and-suspenders: even after the PID check, ignore any path
    // outside /Users/ - system caches etc.
    if !path.starts_with(ws_path) && !path.starts_with("/Users/") { return; }
    let proc = proc_name(extract_deny_proc(line), pid, r);
    let op = extract_deny_op(line).unwrap_or_else(|| "?".into());
    // Log EVERY deny - not just the first - so users can audit exactly
    // which process is hitting which path AND what kind of access was
    // attempted (file-read-data vs file-write-data vs file-test-existence
    // …). The op token tells you whether claude is *reading* a browser
    // config (privacy concern) or just stat()-ing to check if it exists.
    dlog(&format!("[sandbox/{ws_id}] DENY {proc}({pid}) {op} {path}"));
    incr_path_deny(ws_id, &path, pid, &proc);
    // a brokered agent reaching for the Keychain is trying to get around
    // its placeholder: surface it as Suspicious too.
    if crate::broker::is_brokered(ws_id) && under_keychain(&path) {
        crate::broker::record_keychain_denied(ws_id, &path);
    }
}

fn under_keychain(path: &str) -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    keychain_dirs(&home.to_string_lossy()).iter().any(|d| under(path, d))
}

/// Pick the absolute path out of a Sandbox deny log line.
///
/// macOS deny lines look like:
///   ... deny(1) file-write-create /Users/x/Library/Application Support/Foo/bar
///
/// The path is the LAST argument and runs to end of line. Splitting
/// on the first whitespace (previous behavior) truncated paths with
/// spaces - "Application Support" became "Application", and every
/// retry showed up as a "new" partial path inflating the deny counter.
/// Fix: take everything from the path start to the end of the line
/// (the log_stream output is one line per event), then trim trailing
/// whitespace.
/// Pull the PID out of a Sandbox deny line. Format on macOS 14/15 is:
///   ... Sandbox: <procname>(<pid>) deny(...)
/// On older variants:
///   ... Sandbox: <procname>/<thread> deny(...)
///   ... kernel[0]: (Sandbox) Sandbox: env(81203) deny(1) ...
/// We look for the LAST `(<digits>)` token before `deny(` since the
/// `deny(<count>)` token also matches `(<digits>)`.
fn extract_deny_pid(line: &str) -> Option<u32> {
    let deny_at = line.find("deny(")?;
    let head = &line[..deny_at];
    // Find the last '(...)' in head.
    let close = head.rfind(')')?;
    let open  = head[..close].rfind('(')?;
    head[open + 1..close].trim().parse::<u32>().ok()
}

/// Pull the process identifier out of a deny line.
///
/// macOS Sandbox lines come in a few shapes:
///   ... Sandbox: openssl(12345) deny(1) ...
///   ... (Sandbox) Sandbox: env(81203) deny(1) ...
///   ... Sandbox: claude 2.1.144(48523) deny(1) ...   ← claude's own format,
///       proc-name + space + version, then pid in parens
///
/// We take EVERYTHING between the `Sandbox:` marker and the `(`-of-pid
/// (rather than splitting on whitespace and taking the last token) so
/// "claude 2.1.144" stays intact instead of being mis-reported as just
/// "2.1.144".
fn extract_deny_proc(line: &str) -> Option<String> {
    let deny_at = line.find("deny(")?;
    let head = &line[..deny_at];
    let close = head.rfind(')')?;
    let open  = head[..close].rfind('(')?;
    let before = head[..open].trim_end();
    // Anchor to the "Sandbox:" marker if present so we strip the timestamp
    // / source-tag prefix the log emits ("(Sandbox) Sandbox: …"). Fall
    // back to "everything after the last colon" otherwise.
    let start = before.rfind("Sandbox:").map(|i| i + "Sandbox:".len())
        .or_else(|| before.rfind(':').map(|i| i + 1))
        .unwrap_or(0);
    let name = before[start..].trim();
    if name.is_empty() { None } else { Some(name.to_string()) }
}

/// Pull the operation token (file-read-data / file-write-create / …)
/// from a deny line. Same OP list as extract_deny_path's matcher; this
/// helper just returns the matched token so we can include it in the
/// audit log line. Useful for distinguishing "claude read browser
/// config" (privacy concern) from "claude stat()-ed to check
/// existence" (benign probe).
fn extract_deny_op(line: &str) -> Option<String> {
    for op in &["file-write-create", "file-write-data", "file-write*", "file-write",
                "file-read-data", "file-read-metadata", "file-read*", "file-read",
                "file-issue-extension", "file-test-existence", "file-ioctl",
                "network-outbound", "network-inbound", "network-bind", "network*"] {
        if line.contains(op) { return Some((*op).into()); }
    }
    None
}

fn extract_deny_path(line: &str) -> Option<String> {
    for op in &["file-write-create", "file-write-data", "file-write*", "file-write",
                "file-read-data", "file-read-metadata", "file-read*", "file-read",
                "file-issue-extension", "file-test-existence", "file-ioctl"] {
        if let Some(i) = line.find(op) {
            let after = line[i + op.len()..].trim_start();
            if after.starts_with('/') {
                // Path runs to EOL. Trim trailing whitespace/punctuation
                // but keep embedded spaces ("Application Support").
                return Some(after.trim_end_matches(|c: char|
                    c == '\n' || c == '\r' || c == '\t' || c == ' '
                ).to_string());
            }
        }
    }
    // Fallback: first abs-path prefix → end of line.
    let starts = ["/Users/", "/private/", "/var/", "/opt/", "/tmp/"];
    let mut best: Option<usize> = None;
    for s in &starts {
        if let Some(i) = line.find(s) {
            best = Some(best.map_or(i, |b| b.min(i)));
        }
    }
    let start = best?;
    let rest = line[start..].trim_end_matches(|c: char|
        c == '\n' || c == '\r' || c == '\t' || c == ' '
    );
    Some(rest.to_string())
}

// ─── MONITORING-mode log parsing ─────────────────────────────────────
// Allow lines look like (compact style):
//   ... Sandbox: cat(14104) allow file-read-data /private/etc/hosts
//   ... 1 duplicate report for Sandbox: cat(14104) allow file-read-data /bin/cat
// We anchor on " allow " (vs deny's "deny(") and pull pid / proc / op /
// path the same way the deny parser does.

/// PID + duplicate-count from a monitor allow line. The kernel coalesces
/// rapid repeats into "N duplicate report for ..." lines; N is the extra
/// occurrence count for those.
fn monitor_pid_and_dup(line: &str) -> Option<(u32, u64)> {
    let dup = if let Some(at) = line.find("duplicate report") {
        line[..at].split_whitespace().last().and_then(|t| t.parse::<u64>().ok()).unwrap_or(1)
    } else { 1 };
    let allow_at = line.find(" allow ")?;
    let head = &line[..allow_at];
    let close = head.rfind(')')?;
    let open  = head[..close].rfind('(')?;
    let pid = head[open + 1..close].trim().parse::<u32>().ok()?;
    Some((pid, dup))
}

fn extract_allow_proc(line: &str) -> Option<String> {
    let allow_at = line.find(" allow ")?;
    let head = &line[..allow_at];
    let close = head.rfind(')')?;
    let open  = head[..close].rfind('(')?;
    let before = head[..open].trim_end();
    let start = before.rfind("Sandbox:").map(|i| i + "Sandbox:".len())
        .or_else(|| before.rfind(':').map(|i| i + 1))
        .unwrap_or(0);
    let name = before[start..].trim();
    if name.is_empty() { None } else { Some(name.to_string()) }
}

fn extract_allow_op(line: &str) -> Option<String> {
    let allow_at = line.find(" allow ")?;
    let after = line[allow_at + 7..].trim_start();
    let tok = after.split_whitespace().next()?;
    // Only file ops surface in the FS activity view (network is the
    // proxy's job; sysctl/process-exec/etc. are noise).
    if tok.starts_with("file-") { Some(tok.to_string()) } else { None }
}

fn extract_allow_path(line: &str, op: &str) -> Option<String> {
    let i = line.find(op)?;
    let after = line[i + op.len()..].trim_start();
    if after.starts_with('/') {
        return Some(after.trim_end_matches(|c: char|
            c == '\n' || c == '\r' || c == '\t' || c == ' ').to_string());
    }
    // file-ioctl logs as `path:/dev/foo ioctl-command:(...)`.
    if let Some(rest) = after.strip_prefix("path:") {
        if rest.starts_with('/') {
            let end = rest.find(" ioctl-command").unwrap_or(rest.len());
            return Some(rest[..end].trim_end().to_string());
        }
    }
    None
}

fn handle_monitor_line(
    line: &str, ws_id: &str, ws_path: &str, ws_dirs: &[String], policy: &MonitorPolicy,
    r: &mut impl Resolve,
) {
    let Some((pid, dup)) = monitor_pid_and_dup(line) else { return; };
    let Some(op) = extract_allow_op(line) else { return; };
    let Some(path) = extract_allow_path(line, &op) else { return; };
    // Same belt-and-suspenders filter the deny parser uses: ignore
    // system caches etc. outside the task + /Users.
    if !path.starts_with(ws_path) && !path.starts_with("/Users/") { return; }
    // Recording filters — applied BEFORE the (cached) proc lookup so the
    // common spam path short-circuits cheaply, and so excluded accesses
    // never even enter the tracker (saves CPU + memory). The whole point
    // is letting users pre-build the allow-list from the would-block rows
    // without drowning in always-allowed churn.
    let filters = monitor_filters(ws_id);
    if filters.exclude_ws && ws_dirs.iter().any(|d| under(&path, d)) { return; }
    let would_block = policy.would_block(&path, &op);
    if filters.wb_only && !would_block { return; }
    let proc = proc_name(extract_allow_proc(line), pid, r);
    incr_path_access(ws_id, &path, &op, pid, &proc, would_block, dup);
}

/// Build a fully-rendered SBPL profile for one task. Substitutes
/// $HOME / $WORKSPACE in any user-supplied paths, dedupes against the
/// built-in RW list, applies built-in deny rules AFTER the broad
/// `file-read*` allow so they take precedence. Reads extras from the
/// task's own frozen-at-creation arrays - project edits don't
/// reach back into already-created tasks.
/// Expand `~`, `$HOME`, `$WORKSPACE` in a user-supplied path and strip
/// trailing slashes (SBPL `(subpath ...)` matches by string prefix).
/// Shared by `render_profile` and `compute_monitor_policy` so the two
/// never disagree on how a configured path resolves (the previous
/// duplicated closures were a drift risk for the would-block classifier).
pub(crate) fn subst_path(raw: &str, home: &str, task_path: &str) -> String {
    let p = raw.trim();
    let mut s = if p == "~" {
        home.to_string()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        p.to_string()
    };
    s = s.replace("$HOME", home);
    s = s.replace("$WORKSPACE", task_path);
    while s.len() > 1 && s.ends_with('/') { s.pop(); }
    s
}

/// Control-plane paths the ENFORCING profiles must deny (docs/plans/cli.md,
/// Security). `None` fields mean the app has no data dir at all, in which
/// case no socket or token exists to protect either.
pub struct ControlPlanePaths {
    /// The app data dir: holds the CLI token, projects.json, tasks/.
    pub data_dir: Option<String>,
    /// The control socket path inside it.
    pub socket: Option<String>,
}

/// Resolve the REAL control-plane paths. Canonicalized because seatbelt
/// evaluates canonical paths.
pub fn control_plane_paths() -> ControlPlanePaths {
    match crate::global_dir() {
        Ok(d) => {
            let dd = canonicalize_or_keep(&d.to_string_lossy());
            ControlPlanePaths {
                socket: Some(format!("{dd}/{}", termic_proto::SOCKET_FILE)),
                data_dir: Some(dd),
            }
        }
        Err(_) => ControlPlanePaths { data_dir: None, socket: None },
    }
}

/// This task's account login store, as a canonical path for the profile.
///
/// Wrapped rather than called inline so the ordering rule is stated once: the
/// result is emitted AFTER the control-plane deny, never with the agent's
/// other allowed paths, because that deny is the final filesystem rule and
/// would swallow it.
fn task_login_store_for_sandbox(
    task: &Task,
    effective_cli: &str,
    control: &ControlPlanePaths,
) -> Option<String> {
    let raw = crate::task_login_store(task, effective_cli)?.to_string_lossy().into_owned();
    let canon = canonicalize_or_keep(&raw);
    if canon != raw {
        return Some(canon);
    }
    // Canonicalizing did nothing, which means the store does not exist yet:
    // `canonicalize` on a missing path returns the path it was given. That is
    // not harmless here. Seatbelt evaluates CANONICAL paths, and on macOS a
    // data dir under `/var` is really `/private/var`, so the allow would name
    // a path the kernel never matches and the agent would stay denied for the
    // one spawn that has to create the directory.
    //
    // Rebase onto the canonical data dir instead, which always exists.
    let dd_raw = crate::global_dir().ok()?.to_string_lossy().into_owned();
    let dd_canon = control.data_dir.as_deref()?;
    Some(raw.replacen(&dd_raw, dd_canon, 1))
}

pub fn render_profile(task: &Task, proxy_port: u16, agent_override: Option<&str>, mode: SandboxMode) -> Result<String> {
    // Per-agent allowed paths from the agent registry (Settings → Agents).
    // Resolved here so render_profile_with is a pure function of its
    // arguments - the behavioral sandbox tests inject hostile lists
    // through the same seam the real layers flow through.
    let effective_cli = agent_override.unwrap_or(&task.cli).to_string();
    let settings = crate::load_settings_inner();
    let agent_paths: Vec<String> = settings
        .agents
        .iter()
        .find(|a| a.id == effective_cli)
        .map(|a| a.sandbox_allowed_paths.clone())
        .unwrap_or_default();
    render_profile_with(task, proxy_port, &effective_cli, &agent_paths, mode, &control_plane_paths())
}

pub(crate) fn render_profile_with(
    task: &Task,
    proxy_port: u16,
    effective_cli: &str,
    agent_paths: &[String],
    mode: SandboxMode,
    control: &ControlPlanePaths,
) -> Result<String> {
    // MONITORING: allow everything but ask the kernel to REPORT every
    // operation (so the path watcher can log it), while still forcing
    // all network through the logging proxy. The would-block decision is
    // computed app-side (MonitorPolicy), not by the kernel. Monitor's
    // contract is observe-never-block, so the control-plane denies below
    // deliberately do NOT apply: a monitored agent reaches the socket by
    // design, and its token read shows up in the file-op log.
    if mode == SandboxMode::Monitor {
        return Ok(render_monitor_profile(proxy_port, effective_cli));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow!("no home dir"))?
        .to_string_lossy()
        .into_owned();
    let task_path = canonicalize_or_keep(&task.path);
    let subst = |p: &str| subst_path(p, &home, &task_path);

    // The user's "Allowed paths" list - what they explicitly want
    // exposed to the agent. Task path is always implicitly here.
    // Field is still called sandbox_rw_paths for storage compat but
    // the meaning shifted: it's now the unified allow-list, not just
    // writes. UI presents it as "Allowed paths" (one textarea).
    let mut user_allowed: Vec<String> = vec![task_path.clone()];
    // Multi-repo tasks: each composition member's resolved path
    // (worktree dir OR symlink target for RepoRoot mode) must be
    // explicitly allowed. Seatbelt evaluates canonical paths, so a
    // symlink under the wrapper alone wouldn't cover the live
    // checkout it points to — canonicalize each one to be safe.
    for m in &task.composition {
        let resolved = canonicalize_or_keep(&m.path);
        if !resolved.is_empty() { user_allowed.push(resolved); }
    }
    // ── Worktree's parent .git/ ─────────────────────────────────────
    // The task's path is a git worktree whose `.git` is a FILE
    // pointing to `<parent>/.git/worktrees/<name>/`. The `commondir`
    // metadata inside that points back to `<parent>/.git`, where the
    // shared objects + packed-refs live. ANY git operation (status,
    // fetch, commit, checkout) needs read+write on the parent's
    // .git/ — without it the worktree is non-functional. Detect by
    // reading the `.git` file; if it parses as `gitdir: …`, derive
    // the parent .git/ and add to the allow-list.
    //
    // Same for every multi-repo member that's a worktree.
    for ws_root in std::iter::once(task_path.as_str())
        .chain(task.composition.iter().map(|m| m.path.as_str()))
    {
        if let Some(parent_git) = parent_git_dir_for_worktree(ws_root) {
            user_allowed.push(parent_git);
        }
    }
    // Paths starting with `regex:` are treated as raw regex patterns
    // (after $HOME / $WORKSPACE substitution) and emitted as
    // (allow ... (regex #"...")) in SBPL. Everything else is a normal
    // subpath. Splits a flat textarea entry into one of two buckets
    // so the emit loop later can pick the right SBPL form.
    let split_regex = |raw: &str, subs: &mut Vec<String>, regs: &mut Vec<String>| {
        let raw = raw.trim();
        if let Some(rest) = raw.strip_prefix("regex:") {
            // Substitute literal path tokens; $HOME and $WORKSPACE
            // need regex-escaping so a path with e.g. `+` in it doesn't
            // change the pattern's meaning. Typical macOS home paths
            // are safe, but Linux/CI users could have weirder layouts.
            let home_esc = regex::escape(&home);
            let ws_esc   = regex::escape(&task_path);
            let pat = rest.trim()
                .replace("$HOME", &home_esc)
                .replace("$WORKSPACE", &ws_esc);
            if !pat.is_empty() { regs.push(pat); }
        } else {
            let s = subst(raw);
            if !s.is_empty() { subs.push(s); }
        }
    };

    let mut user_allowed_regexes: Vec<String> = Vec::new();
    for p in &task.sandbox_rw_paths {
        split_regex(p, &mut user_allowed, &mut user_allowed_regexes);
    }
    dedupe(&mut user_allowed);
    dedupe(&mut user_allowed_regexes);

    // Per-agent allowed paths from the agent registry (Settings → Agents).
    // Each agent declares its own runtime/config dirs; these are joined
    // into the allow-list whenever that agent's CLI is launched in this
    // task. The user CANNOT remove them per-task — to drop an
    // entry they have to edit the agent (which affects every task
    // using that agent). Resolved by render_profile from the registry
    // (best-effort settings load with seeded defaults) and passed in.
    let mut agent_allowed: Vec<String> = Vec::new();
    let mut agent_allowed_regexes: Vec<String> = Vec::new();
    for p in agent_paths {
        split_regex(p, &mut agent_allowed, &mut agent_allowed_regexes);
    }
    dedupe(&mut agent_allowed);
    dedupe(&mut agent_allowed_regexes);

    // Runtime dirs the agent NEEDS access to or it can't launch.
    // Always allowed; never asked of the user. Universal across all
    // CLIs (TMPDIR, package caches, shell rc files, etc.); per-CLI
    // specifics live on each agent's sandbox_allowed_paths.
    let runtime = builtin_runtime_paths(&home, &task_path);

    // ── Read-only system roots. MINIMUM set — binaries, dynamic
    //    linker, and basic syscall config. If a user genuinely needs
    //    to load a system-wide framework or read /Applications, they
    //    should disable the cage or add the exact subpath per
    //    task; the cage doesn't try to be transparent. Writes
    //    here are NEVER allowed.
    //
    //    Deliberately NOT included:
    //      /System (broad)       → firmlink-exposes user data; narrowed
    //                              to /System/Library + dyld cryptex.
    //      /Library              → every system-wide app's shared data
    //                              dir; user adds per-task if needed.
    //      /Applications         → headless CLI agents don't need this.
    //      /Library/Frameworks   → third-party frameworks; add per-task.
    //
    //    /private/var/db                        → dyld cache (macOS 12)
    //    /System/Volumes/Preboot/Cryptexes      → dyld cache (macOS 13+)
    //    /System/Library                        → system frameworks
    // Shared with compute_monitor_policy so both agree on what reads
    // ENFORCING permits. (Windows intentionally absent — its model is
    // AppContainer / Job Objects, not SBPL.)
    let system_read_roots = system_read_roots();

    // Hardcoded secret denies (~/.ssh family). Default-on, always
    // applied LAST so allow-list entries can't accidentally re-expose
    let mut out = String::with_capacity(4096);
    out.push_str(SBPL_HEADER);

    // ── File ops base: allow-list for CONTENTS, open metadata.
    //
    // SBPL_HEADER ships with `(deny default)` and no broad `(allow
    // file-read*)`. We carve out only the paths the agent needs for
    // read/WRITE of file CONTENTS. There is NO deny-list.
    //
    // `file-read-metadata` + `file-test-existence` ARE allowed globally.
    // This is load-bearing, not a UX nicety: macOS resolves the firmlink
    // symlinks /tmp → /private/tmp, /var → /private/var, /etc →
    // /private/etc by readlink()ing the symlink node, which is a
    // file-read-metadata op on /tmp, /var, /etc. Without a global
    // metadata allow, `mkdir /tmp/claude-NNN` (and any access through a
    // top-level symlink) fails with EPERM and the agent can't even
    // launch. Globally allowing metadata also means stat/ls/realpath and
    // shell completion work, and a denied path reads as "missing" rather
    // than a hard EPERM at dyld. Trade-off: an agent can SEE the names /
    // existence of paths outside the allow-list (incl. ~/.ssh), but their
    // CONTENTS stay default-denied (no broad file-read-data). Metadata
    // leaks structure, not secrets.
    out.push_str("\n;; --- File ops base (allow-list for contents; metadata open) ---\n");
    out.push_str("(allow file-read-metadata)\n");
    out.push_str("(allow file-test-existence)\n");
    out.push_str("(allow file-map-executable)\n");
    out.push_str("(allow file-issue-extension)\n");

    // ── System read roots (broadly readable, NEVER writable).
    out.push_str("\n;; --- System read roots (allowlist; reads only) ---\n");
    // Root directory ENTRY itself (not its descendants). Required so
    // dyld + libsystem can stat / open `/` during process startup; the
    // (subpath ...) entries below only match descendants, never the
    // root itself. Without this, `env` exits 1 with
    //   "deny(1) file-read-data /"
    // and no agent ever launches.
    out.push_str("(allow file-read* (literal \"/\"))\n");
    for p in system_read_roots {
        out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", sbpl_escape(p)));
    }

    // ── Task + per-task user allows (read + write).
    out.push_str("\n;; --- Task + user allow-list (read + write) ---\n");
    for p in &user_allowed {
        out.push_str(&format!("(allow file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
        out.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    }
    for r in &user_allowed_regexes {
        // Use regex-safe escape (only "), NOT sbpl_escape — the latter
        // doubles `\`, which corrupts every backslash in the pattern
        // (\. → \\. ; seatbelt then matches literal backslash, not dot).
        out.push_str(&format!("(allow file-read*  (regex #\"{}\"))\n", sbpl_regex_escape(r)));
        out.push_str(&format!("(allow file-write* (regex #\"{}\"))\n", sbpl_regex_escape(r)));
    }

    // ── Task ancestor path nodes (read: the directory NODE only).
    //    A shell/agent launched in the task canonicalizes its cwd via
    //    realpath(3), which open()s each ancestor directory up the chain.
    //    open(dir) is a `file-read-data` op, denied by the allow-list for
    //    anything outside the task subtree — so `bun run` / `bunx`
    //    (claude is Bun-compiled; its RunCommand realpath()s the cwd at
    //    startup) and ANY tool that realpath()s the cwd fail immediately
    //    with EPERM ("error loading current directory" /
    //    "CouldntReadCurrentDirectory"). file-read-metadata +
    //    file-test-existence are global, so stat/lstat/realpath-via-lstat
    //    work — but the kernel realpath(3) does a directory OPEN, which
    //    they don't cover. Grant each ancestor as `literal` (the exact
    //    node, NOT `subpath`) so traversal + enumeration of the path
    //    components works WITHOUT exposing sibling subtrees' contents —
    //    the same shape as the `(literal "/")` grant above, one level down.
    let ancestors = task_ancestor_dirs(task);
    if !ancestors.is_empty() {
        out.push_str("\n;; --- Task ancestor path (realpath/traverse; dir node only) ---\n");
        for a in &ancestors {
            out.push_str(&format!("(allow file-read* (literal \"{}\"))\n", sbpl_escape(a)));
        }
    }

    // ── Per-agent allow-list (read + write). Joined from the agent
    //    registry; user can edit in Settings → Agents but not remove
    //    per-task.
    if !agent_allowed.is_empty() || !agent_allowed_regexes.is_empty() {
        out.push_str(&format!("\n;; --- Agent allow-list for `{}` (read + write) ---\n", effective_cli));
        for p in &agent_allowed {
            out.push_str(&format!("(allow file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
            out.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
        }
        for r in &agent_allowed_regexes {
            out.push_str(&format!("(allow file-read*  (regex #\"{}\"))\n", sbpl_regex_escape(r)));
            out.push_str(&format!("(allow file-write* (regex #\"{}\"))\n", sbpl_regex_escape(r)));
        }
    }

    // ── Universal runtime paths (read + write). TMPDIR, package
    //    caches, shell rcs, etc. — required for any agent to launch.
    //
    //    Symlink resolution: seatbelt evaluates the CANONICAL path of
    //    each syscall (kernel resolves symlinks before the sandbox
    //    check). If the user has `~/.zshrc` symlinked into
    //    iCloud (`~/Library/Mobile Documents/com~apple~CloudDocs/…`),
    //    an allow on `~/.zshrc` doesn't match the resolved iCloud
    //    path. We canonicalize each runtime entry and emit BOTH the
    //    source AND the resolved target so symlinked dotfiles work
    //    without the user having to add iCloud paths by hand.
    out.push_str("\n;; --- Universal runtime paths (read + write) ---\n");
    let mut emitted: HashSet<String> = HashSet::new();
    let mut emit_subpath = |out: &mut String, p: &str, label: Option<&str>| {
        if !emitted.insert(p.to_string()) { return; }
        if let Some(label) = label {
            out.push_str(&format!(";; {label}\n"));
        }
        out.push_str(&format!("(allow file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
        out.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    };
    for p in &runtime {
        emit_subpath(&mut out, p, None);
        // Resolve symlinks. If the target differs from the source,
        // emit it too. We use canonicalize_or_keep so a missing path
        // (file the user doesn't actually have) doesn't blow up;
        // canonicalize returns the input unchanged in that case.
        let canon = canonicalize_or_keep(p);
        if canon != *p && !canon.is_empty() {
            emit_subpath(&mut out, &canon, Some(&format!("↳ symlink target of {p}")));
        }
    }

    // ── Read-only runtime paths (read, NEVER write). e.g.
    //    ~/.ssh/known_hosts: needed by git/gh fetch, but write access would
    //    let the agent forge host keys. No write rule is emitted for these.
    out.push_str("\n;; --- Read-only runtime paths ---\n");
    for p in builtin_runtime_readonly_paths(&home) {
        if emitted.insert(p.clone()) {
            out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", sbpl_escape(&p)));
        }
        let canon = canonicalize_or_keep(&p);
        if canon != p && !canon.is_empty() && emitted.insert(canon.clone()) {
            out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", sbpl_escape(&canon)));
        }
    }

    // NO secret deny-list and NO re-open machinery: this is a pure
    // allow-list. Anything not carved out above is denied by the
    // header's `(deny default)` — including metadata/existence — so
    // there is nothing to "re-open" and nothing to back-stop.
    //
    // ONE exception, and it is load-bearing (docs/plans/cli.md,
    // Security): the CLI control plane. Default-denied is NOT
    // guaranteed-denied - the allow-list above is user-, repo-, and
    // agent-extensible, so one broad ancestor entry (~, ~/Library,
    // ~/Library/Application Support) silently places the CLI token and
    // projects.json/tasks/ under an allowed subpath, and a caged agent
    // holding the token has escaped the sandbox. SBPL is last-match-wins,
    // so these MUST stay the FINAL filesystem rules of both enforcing
    // branches - a deny placed before the allows would be silently
    // overridden. The write deny also closes the rename/re-bind MITM on
    // the socket path. Verified behaviorally in tests (a textual check
    // cannot catch a rule rendered in a position where last-match-wins
    // makes it inert).
    if let Some(dd) = &control.data_dir {
        out.push_str("\n;; --- Termic control plane: data dir (CLI token, projects.json,\n");
        out.push_str(";;     tasks/) is NEVER accessible to caged agents. FINAL filesystem\n");
        out.push_str(";;     rules; last-match-wins beats any ancestor allow above. ---\n");
        out.push_str(&format!("(deny file-write* (subpath \"{}\"))\n", sbpl_escape(dd)));
        out.push_str(&format!("(deny file-read* (subpath \"{}\"))\n", sbpl_escape(dd)));
        // ...EXCEPT this task's own login store, re-allowed AFTER the deny so
        // last-match-wins puts it back (GH #278).
        //
        // A named account's config dir lives inside termic's data dir, so the
        // blanket deny above swallowed it and the agent could not open its own
        // credential: codex died on `unable to open database file` for
        // `logins/codex/<account>/state_5.sqlite`, with the deny counter
        // ticking up in the footer. An allow placed with the other agent paths
        // was inert, because this deny is deliberately the FINAL rule.
        //
        // Narrow on purpose: ONE account's directory, never `logins/` and
        // never the data dir. The CLI token, `projects.json` and `tasks/` are
        // siblings of it and stay denied, which is the property this whole
        // block exists to hold.
        if let Some(store) = task_login_store_for_sandbox(task, effective_cli, control) {
            out.push_str(";;     ...except this task's own account login store.\n");
            out.push_str(&format!("(allow file-read* file-write* (subpath \"{}\"))\n",
                                  sbpl_escape(&store)));
        }

        // Re-allow read-only access to profile customizations only if the task's project inherits them.
        let inherits_customizations = crate::load_projects_all()
            .into_iter()
            .find(|p| p.id == task.project_id)
            .map(|p| crate::effective_customization_mode(&p) == crate::customizations::CustomizationMode::Inherit)
            .unwrap_or(true);

        if inherits_customizations {
            if let Ok(pdir) = crate::profile_dir(&task.profile) {
                let skills_dir = crate::customizations::skills_dir(&pdir);
                let agents_dir = crate::customizations::agents_dir(&pdir);
                let mcp_json = crate::customizations::mcp_json_file(&pdir);

                // Narrow allow: ONLY skills, agents, and mcp.json.
                // NEVER allow mcp.env.local or secret credential files!
                if skills_dir.exists() {
                    out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n",
                                          sbpl_escape(&skills_dir.to_string_lossy())));
                }
                if agents_dir.exists() {
                    out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n",
                                          sbpl_escape(&agents_dir.to_string_lossy())));
                }
                if mcp_json.exists() {
                    out.push_str(&format!("(allow file-read* (literal \"{}\"))\n",
                                          sbpl_escape(&mcp_json.to_string_lossy())));
                }
            }
        }
    }

    // Keychain block (opt-in per task). The header's blanket mach-lookup
    // reaches securityd, and any item that trusts an Apple binary (gh's
    // token via `security`, git's osxkeychain helper) reads back with no
    // prompt; denying exec of those binaries does not help, since any
    // Apple-signed binary calling Security.framework reads it too. Denying
    // the services closes the legacy keychain (security, the git helper,
    // the C API) and the data-protection keychain; work handed to launchd
    // was not measured, see docs/sandbox.md. The dir deny stops the agent
    // copying or replacing the keychain files. It cannot be a read-only
    // dir on its own: the legacy keychain is written by the client
    // process, so a read-only dir with the services up breaks every
    // agent's token refresh. TLS does not need these services (curl,
    // node, python and Go's verifier all verified under it).
    //
    // Emitted after every file allow, the login store's included, so last
    // match wins without depending on what the allows cover. Both the
    // literal and the resolved path are denied, mirroring the runtime
    // allow loop, or a symlinked home keeps its resolved allow.
    if blocks_keychain(task, mode) {
        out.push_str("\n;; --- Keychain blocked for this task ---\n");
        out.push_str(KEYCHAIN_MACH_DENY);
        for p in keychain_dirs(&home) {
            out.push_str(&format!("(deny file-read* file-write* (subpath \"{}\"))\n", sbpl_escape(&p)));
        }
        out.push_str(KEYCHAIN_FILE_DENY);
    }

    // Every brokered spawn's scratch dir sits under one base in /private/tmp,
    // which the runtime allow above opens read+write, and every agent runs as
    // the same uid. Without this, one task's agent could rewrite another's gh
    // config (point its socket elsewhere, set a pager that runs inside it),
    // swap its CA bundle, or unlink its socket. Emitted after every file
    // allow; a brokered spawn re-opens only its own dir (`broker_profile_rules`).
    if matches!(mode, SandboxMode::Enforce | SandboxMode::EnforceFs) {
        if let Some(base) = crate::broker::spawn_base_dir() {
            out.push_str("\n;; --- Broker scratch dirs: no task reaches another's ---\n");
            out.push_str(&format!("(deny file-read* file-write* (subpath \"{}\"))\n", sbpl_escape(&base.to_string_lossy())));
        }
    }

    // Control-plane socket deny, emitted per-branch below: it must be the
    // FINAL network rule AFTER every allow that could match (the broad
    // unix-socket allow, EnforceFs's `(allow network*)`, and the agy
    // special case's blanket outbound allow).
    let socket_deny = control.socket.as_ref().map(|sock| {
        format!(
            ";; --- Termic control plane: caged agents get NO CLI surface.\n;;     FINAL network rule; last-match-wins beats the allows above. ---\n(deny network-outbound (remote unix-socket (path-literal \"{}\")))\n",
            sbpl_escape(sock)
        )
    });

    if mode == SandboxMode::EnforceFs {
        // FILESYSTEM-ONLY ENFORCE: the file cage above is identical to
        // ENFORCE, but the network sandbox is deliberately disabled —
        // full network access, no loopback-to-proxy pinning (provision()
        // doesn't start a proxy in this mode, so proxy_port is 0 / unused).
        // This is the whole point of the mode: isolate the filesystem,
        // leave egress to the user's own controls.
        out.push_str("\n;; --- Network: UNRESTRICTED (filesystem-only enforce) ---\n");
        out.push_str("(allow network*)\n");
        // The socket deny applies in EnforceFs too: the network sandbox
        // is off here, so without it the control socket is reachable
        // from inside the FS cage.
        if let Some(deny) = &socket_deny {
            out.push('\n');
            out.push_str(deny);
        }
        return Ok(out);
    }

    out.push_str("\n;; --- Network: only loopback to our in-process proxy ---\n");
    out.push_str("(deny network*)\n");
    out.push_str("(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))\n");
    out.push_str("(allow network-outbound (remote unix-socket))\n");
    out.push_str(&format!(
        "(allow network-outbound (remote ip \"localhost:{proxy_port}\"))\n"
    ));
    out.push_str("(allow network-bind     (local  ip \"localhost:*\"))\n");
    out.push_str("(allow network-inbound  (local  ip \"localhost:*\"))\n");

    if effective_cli == "agy" {
        out.push_str("\n;; --- Antigravity: allow direct outbound connections to Google APIs ---\n");
        out.push_str("(allow network-outbound)\n");
    }

    // MUST stay last: after the broad unix-socket allow and the agy
    // blanket outbound allow above.
    if let Some(deny) = &socket_deny {
        out.push('\n');
        out.push_str(deny);
    }

    Ok(out)
}

/// MONITORING-mode profile: allow ALL filesystem ops but tag them with
/// `(with report)` so the kernel logs each one (the path watcher tails
/// these). Network is still pinned to the loopback proxy so every
/// request is observable + classified — direct connections are denied
/// last-match-wins, then loopback is re-allowed. Nothing is actually
/// blocked from the agent's perspective except direct (proxy-bypassing)
/// network, which well-behaved CLIs don't attempt (they honor
/// http_proxy). The agent sees a fully permissive cage; we see
/// everything it does.
fn render_monitor_profile(_proxy_port: u16, _agent: &str) -> String {
    // MONITORING observes, it does NOT block. Filesystem AND network are
    // fully allowed (`allow default`), and every operation is reported to
    // the unified log (the path watcher tails it). We deliberately do
    // NOT re-deny network to force it through the proxy: that would break
    // non-HTTP traffic the agent legitimately uses (git-over-SSH, raw
    // sockets, gRPC). HTTP/HTTPS still routes through the loopback proxy
    // via the injected http_proxy env, so it's logged + classified;
    // everything else goes direct and just works. Net effect: Monitoring
    // can't break what an unsandboxed agent could do.
    let mut out = String::with_capacity(256);
    out.push_str("(version 1)\n");
    out.push_str(";; Termic MONITORING mode — allow + report every operation.\n");
    out.push_str(";; Observes only; never blocks. HTTP/HTTPS are logged via the\n");
    out.push_str(";; loopback proxy (http_proxy env); other traffic goes direct.\n");
    out.push_str("(allow default (with report))\n");
    out
}

/// Runtime paths every sandboxed agent NEEDS access to or it can't
/// launch (auth read, log write, cache I/O, TMPDIR, ...). Always
/// allowed, regardless of user config - the deny-list compute below
/// excludes these from auto-denies, and we re-allow them explicitly
/// after auto-denies in case the user accidentally tried to lock
/// down a parent. Adding to this list is how we permanently unblock
/// a real-world agent breakage; the user's "Allowed paths" list is
/// for their own dirs (other repos, notes, etc.), not for chasing
/// runtime quirks.
fn builtin_runtime_paths(home: &str, task_path: &str) -> Vec<String> {
    vec![
        task_path.to_string(),
        // macOS TMPDIR resolves into /private/var/folders/...; agents
        // touch it constantly (cache dirs, node_modules tarballs,
        // pip build artifacts).
        "/private/tmp".to_string(),
        "/private/var/folders".to_string(),
        // Per-CLI agent state dirs (claude/gemini/codex) moved onto each
        // agent's `sandbox_allowed_paths` (Settings → Agents) so a claude
        // sandbox no longer has gemini/codex dirs reachable, and so custom
        // agents declare their own. See default_agents() in lib.rs.
        //
        // Package manager caches - npm/pip/cargo all write here on
        // first install. Without these even a `git clone && npm i`
        // breaks in a sandboxed task.
        format!("{home}/.npm"),
        format!("{home}/.cache"),
        format!("{home}/.cargo/registry"),
        // Rustup writes ~/.cargo/env — a tiny shell-source file that
        // adds ~/.cargo/bin to PATH. Sourced by every zsh that starts
        // in a task if the user has rustup installed. NOT
        // broadening to ~/.cargo (which contains credentials.toml).
        format!("{home}/.cargo/env"),
        format!("{home}/.cargo/bin"),
        format!("{home}/Library/Caches"),
        // OAuth token store. claude / gemini / codex all keep their
        // login state via securityd → Keychain ACLs; the encrypted DB
        // file itself lives here. Pre-v0.4.0 the broad-allow model
        // let agents touch it implicitly, the new allowlist would
        // deny it by default and break "claude is logged in" on every
        // sandboxed spawn. The per-item ACL does NOT keep a caged agent
        // out: any item that trusts an Apple binary reads back through
        // securityd with no prompt. Tasks that need it closed opt into the
        // Keychain block (`KEYCHAIN_MACH_DENY`, docs/sandbox.md "Keychain").
        format!("{home}/Library/Keychains"),
        // User-local binaries (pipx, `pip install --user`, `cargo install`,
        // `npm i -g` with a user prefix, and direct ~/.local/bin scripts).
        // Most agents shell out to tools that end up here.
        format!("{home}/.local/bin"),
        // XDG_DATA_HOME. Modern cross-platform tools drop runtimes,
        // interpreters, and package stores here: uv (Python interps —
        // venv shims symlink in, so denying breaks dyld on libpython
        // load), pipx, pnpm store, mise/asdf/rtx shims, fnm, gem, coursier,
        // JetBrains, etc. Per-tool allow-listing is endless and a miss now
        // fails hard (EPERM at dyld) rather than soft, since there's no
        // global metadata allow — so we keep the whole dir readable. The
        // real secret stores (~/.ssh, ~/.aws, ~/.gnupg, ~/.netrc) live
        // elsewhere and are simply not on the allow-list.
        format!("{home}/.local/share"),
        // gh CLI's non-secret state (device-id, cache). The credentials
        // file (~/.config/gh/hosts.yml) is hard-denied separately.
        format!("{home}/.local/state/gh"),
        // macOS Cocoa runtime reads this on launch for locale/encoding
        // detection. Empty file, no user data — just denying it makes
        // every Foundation-linked binary log a sandbox violation.
        format!("{home}/.CFUserTextEncoding"),
        // Agent-skills convention: ~/.agents/skills/<name>/SKILL.md +
        // bundled assets. Cross-agent because the skill manifest format
        // is shared. Per-agent vendor dirs (~/.claude, ~/.gemini,
        // ~/.codex) live on each agent's sandbox_allowed_paths and are
        // intentionally NOT here — a claude sandbox shouldn't have
        // access to gemini's OAuth token store and vice versa.
        format!("{home}/.agents"),
        // Bun runtime cache. claude is Bun-compiled; Bun's runtime
        // pokes here for install cache + bunfig lookups. Missing
        // this was the most likely cause of "claude doesn't launch"
        // under the allow-list cage.
        format!("{home}/.bun"),
        format!("{home}/.deno"),
        // ~/Library/Logs and ~/Library/Application Support are
        // INTENTIONALLY NOT universal
        // — it holds every macOS app's data (browsers, Slack/Discord,
        // password-manager configs, etc.). Each agent declares its own
        // specific subdir via Settings → Agents → "Sandbox allowed
        // paths" (e.g. claude lists $HOME/Library/Application Support/
        // Claude). User can add more per task if needed.
        // Shell + git init files. Tool subprocesses (the agent shells
        // out to git, gh, npm, ...) read these on startup; denying
        // them breaks every git/gh/shell invocation. Single files,
        // no secret content (those go in ~/.ssh / ~/.aws / Keychain
        // which are hard-denied below).
        format!("{home}/.gitconfig"),
        format!("{home}/.gitignore_global"),
        format!("{home}/.config/git/ignore"),
        format!("{home}/.config/git/config"),
        format!("{home}/.config/git/attributes"),
        format!("{home}/.zshrc"),
        format!("{home}/.zprofile"),
        format!("{home}/.zshenv"),
        format!("{home}/.bashrc"),
        format!("{home}/.bash_profile"),
        format!("{home}/.bash_logout"),
        format!("{home}/.inputrc"),
        format!("{home}/.profile"),
        // Shell completion frameworks. Every sandboxed PTY opens a
        // login shell; oh-my-zsh / prezto / fish read their whole
        // framework tree on startup (lib, plugins, themes, custom) and
        // write a completion + log cache underneath. All non-secret
        // shell machinery — denying it just fills the deny chip with
        // read-data noise on every spawn and slows shell init. The
        // genuine secret (shell *history*) lives in ~/.zsh_history /
        // ~/.local/share/fish, which stay off the allow-list.
        format!("{home}/.oh-my-zsh"),
        format!("{home}/.zprezto"),
        format!("{home}/.config/fish/completions"),
        format!("{home}/.config/fish/functions"),
        format!("{home}/.config/fish/conf.d"),
        // NOTE: ~/.ssh/known_hosts is NOT here — it's read-only (see
        // builtin_runtime_readonly_paths). Putting it in this list would
        // grant file-write* on a file under ~/.ssh, letting the agent
        // forge/wipe host keys; with the deny-list gone, nothing else
        // would stop that.
    ]
}

/// Runtime paths the agent may READ but never WRITE. Kept separate from
/// `builtin_runtime_paths` (which grants read+write) so we don't hand out
/// write access to sensitive-adjacent files. ~/.ssh/known_hosts is read by
/// every git/gh fetch (trust fingerprints), but write access would let a
/// sandboxed agent inject a forged host key.
fn builtin_runtime_readonly_paths(home: &str) -> Vec<String> {
    vec![
        format!("{home}/.ssh/known_hosts"),
    ]
}

// NOTE: the old `builtin_deny_paths` hard-deny set (~/.ssh, ~/.aws,
// browser data, shell histories, ~/Documents, …) was REMOVED when the
// sandbox became a pure allow-list. Those paths are protected now by
// simply not being on the allow-list — `(deny default)` blocks their
// contents AND their metadata/enumeration. Trade-off: ~/.local/share is
// allowed broadly (tool data stores), so anything a tool keeps there
// (e.g. ~/.local/share/fish history) is readable; the genuinely secret
// stores live elsewhere and stay off the allow-list. Keychains stay
// reachable (encrypted; gated by securityd) exactly as before.

/// True iff this OS supports the sandbox at all. macOS-only because
/// the implementation uses sandbox-exec (Apple's Seatbelt frontend).
/// Linux + Windows return false; the frontend uses this to grey out
/// the toggle and show "unavailable on your OS." `provision()` also
/// short-circuits on non-macOS so a missed UI check can't crash the
/// agent spawn.
pub fn available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/sandbox-exec").exists()
    })
}

/// Default host allowlist (regex per line) for a task, keyed off
/// the agent it runs. We add the API endpoints for that agent's vendor
/// plus a baseline of stuff every dev needs (github + popular package
/// registries). Task's own `sandbox_allowed_hosts` are appended.
/// The output is the file contents (with leading comment); use
/// `host_patterns` if you just want the regexes for feeding to the
/// proxy.
#[allow(dead_code)]
pub fn render_filter(task: &Task) -> String {
    render_filter_for(task, None)
}

pub fn render_filter_for(task: &Task, agent_override: Option<&str>) -> String {
    let mut hosts: Vec<String> = Vec::new();
    let raw_cli = agent_override.unwrap_or(&task.cli);
    // Resolve a CLONE to what it was copied from. A duplicated agent runs the
    // same binary and talks to the same vendor API, and this table is keyed by
    // built-in name, so `next-claude` matched nothing and reached the proxy
    // with no vendor hosts at all: `api.anthropic.com` blocked 12 times before
    // the user noticed. A clone must inherit the parent's egress, not start
    // from an empty allow-list.
    let agents = crate::load_settings_inner().agents;
    let effective_cli = crate::docker::base_agent_id(&agents, raw_cli).to_string();
    let effective_cli = effective_cli.as_str();

    // Per-CLI vendor APIs.
    match effective_cli {
        "claude" => hosts.extend([
            r"^api\.anthropic\.com$".into(),
            r"^statsig\.anthropic\.com$".into(),
            r"^console\.anthropic\.com$".into(),
            r"^claude\.ai$".into(),
            r"^code\.claude\.com$".into(),
            r"^platform\.claude\.com$".into(),
            r"^.+\.anthropic\.com$".into(),
            r"^.+\.claude\.com$".into(),
            r"^.+\.claude\.ai$".into(),
            // Anthropic ships claude with Datadog as its telemetry
            // backend; refusing this just fills the deny chip with
            // noise on every launch. Same shape as statsig.anthropic.com
            // - vendor-blessed analytics for a CLI the user installed.
            r"^.+\.datadoghq\.com$".into(),
        ]),
        "gemini" => hosts.extend([
            r"^generativelanguage\.googleapis\.com$".into(),
            r"^.+\.googleapis\.com$".into(),
            r"^oauth2\.googleapis\.com$".into(),
            r"^accounts\.google\.com$".into(),
            r"^cloudcode-pa\.googleapis\.com$".into(),
            r"^lh3\.googleusercontent\.com$".into(),
            r"^.+\.googleusercontent\.com$".into(),
            r"^antigravity-unleash\.goog$".into(),
            r"^.+\.antigravity-unleash\.goog$".into(),
        ]),
        "codex" => hosts.extend([
            r"^api\.openai\.com$".into(),
            r"^chatgpt\.com$".into(),
            r"^.+\.chatgpt\.com$".into(),
            r"^.+\.openai\.com$".into(),
            r"^auth\.openai\.com$".into(),
            r"^cdn\.openai\.com$".into(),
        ]),
        // GitHub Copilot CLI. The completion API lives on the
        // per-plan `individual.githubcopilot.com` subdomain
        // (api.* for completions, telemetry.* for analytics). The
        // wildcard covers both; telemetry is vendor-blessed for a CLI
        // the user installed, same call we make for claude's Datadog.
        // Device-flow auth itself rides github.com (in the baseline).
        "copilot" => hosts.extend([
            r"^api\.githubcopilot\.com$".into(),
            r"^.+\.githubcopilot\.com$".into(),
        ]),
        // xAI Grok CLI. Auth (`auth.x.ai`) + API (`x.ai`) on the x.ai
        // apex, chat traffic on the `cli-chat-proxy.grok.com` proxy.
        "grok" => hosts.extend([
            r"^x\.ai$".into(),
            r"^.+\.x\.ai$".into(),
            r"^.+\.grok\.com$".into(),
        ]),
        // Antigravity (`agy`) is a Gemini-3-family Google CLI — it
        // talks to the same Google AI / Cloud Code backends gemini
        // does. Mirrors the gemini host set; if Antigravity uses a
        // dedicated endpoint a deny will show in the Sandbox dialog.
        "agy" => hosts.extend([
            r"^generativelanguage\.googleapis\.com$".into(),
            r"^.+\.googleapis\.com$".into(),
            r"^oauth2\.googleapis\.com$".into(),
            r"^accounts\.google\.com$".into(),
            r"^cloudcode-pa\.googleapis\.com$".into(),
            r"^.+\.google\.com$".into(),
            r"^lh3\.googleusercontent\.com$".into(),
            r"^.+\.googleusercontent\.com$".into(),
            r"^antigravity-unleash\.goog$".into(),
            r"^.+\.antigravity-unleash\.goog$".into(),
            // CLI self-update check (Cloud Run). Project number is
            // baked into the hostname; scope to the updater service
            // rather than opening all of *.run.app.
            r"^antigravity-cli-auto-updater-.+\.run\.app$".into(),
        ]),
        // Muse Code (Meta). Every host here came out of the shipped launcher
        // shim and `strings` on the 1.0.2 binary rather than guesswork:
        // `api.meta.ai` is both the Model API and the release-channel
        // endpoint, `auth.meta.com` + `accountscenter.meta.com` are the
        // device-code login flow, `dev.meta.ai` serves install.sh, and
        // `lookaside.facebook.com` is the launcher's binary download host
        // (MUSE_DOWNLOAD_HOST) — a blocked self-update is what a stale
        // version looks like from the outside.
        // Measured off the installed bundle (2026.10.01-e373342) rather than
        // from docs: `api2.cursor.sh` is the default `--endpoint`, `repo42`
        // is its repo service, and `downloads.cursor.com` is where the
        // launcher self-updates from. The wildcards cover the staging hosts
        // in the same bundle (`staging.cursor.sh`, `dev-staging.cursor.sh`)
        // without listing each, the same shape every arm here uses.
        "cursor" => hosts.extend([
            r"^api2\.cursor\.sh$".into(),
            r"^repo42\.cursor\.sh$".into(),
            r"^.+\.cursor\.sh$".into(),
            r"^cursor\.com$".into(),
            r"^.+\.cursor\.com$".into(),
        ]),
        "muse" => hosts.extend([
            r"^api\.meta\.ai$".into(),
            r"^dev\.meta\.ai$".into(),
            r"^.+\.meta\.ai$".into(),
            r"^auth\.meta\.com$".into(),
            r"^accountscenter\.meta\.com$".into(),
            r"^lookaside\.facebook\.com$".into(),
        ]),
        // Devin (Cognition). Out of `strings` on the shipped binary, same
        // method as muse's list: `api.devin.ai` is the API, `cli.devin.ai`
        // serves install.sh and the versioned binaries a self-update fetches,
        // and `app`/`static` cover the links it opens. The CLI is the Windsurf
        // codebase under a new name, so `server.codeium.com` +
        // `unleash.codeium.com` are its backend and feature flags, and
        // `codeium-i5.sentry.io`/`us.sentry.io` its crash reporting.
        // `openrouter.ai` is the BYOK model gateway it can be pointed at.
        "devin" => hosts.extend([
            r"^devin\.ai$".into(),
            r"^.+\.devin\.ai$".into(),
            r"^.+\.codeium\.com$".into(),
            r"^.+\.sentry\.io$".into(),
            r"^.+\.openrouter\.ai$".into(),
        ]),
        _ => { /* custom agents: user must list hosts explicitly */ }
    }

    // Baseline that virtually every dev workflow needs.
    hosts.extend([
        // GitHub.
        r"^github\.com$".into(),
        r"^api\.github\.com$".into(),
        r"^codeload\.github\.com$".into(),
        r"^objects\.githubusercontent\.com$".into(),
        r"^raw\.githubusercontent\.com$".into(),
        r"^.+\.githubusercontent\.com$".into(),
        // GitLab (PR/MR integration parity - gitlab projects need push +
        // glab API access from inside the cage just like github ones).
        r"^gitlab\.com$".into(),
        r"^.+\.gitlab\.com$".into(),
        // Azure DevOps (same parity): dev.azure.com covers the org APIs
        // incl. *.vssps.dev.azure.com, *.visualstudio.com covers legacy orgs
        // and the vssps/vsaex services az's devops extension calls, and
        // login.microsoftonline.com is the Entra token endpoint `az login`
        // refreshes through. management.azure.com is ARM, which `az login`
        // hits listing subscriptions - without it the login token works but
        // the CLI never finishes.
        r"^dev\.azure\.com$".into(),
        r"^.+\.dev\.azure\.com$".into(),
        r"^.+\.visualstudio\.com$".into(),
        r"^login\.microsoftonline\.com$".into(),
        r"^management\.azure\.com$".into(),
        // Package registries.
        r"^registry\.npmjs\.org$".into(),
        r"^.+\.npmjs\.org$".into(),
        r"^pypi\.org$".into(),
        r"^files\.pythonhosted\.org$".into(),
        r"^.+\.pythonhosted\.org$".into(),
        r"^crates\.io$".into(),
        r"^static\.crates\.io$".into(),
        // CA/TLS lookups (OCSP, CRLs) - if we block these, every TLS
        // handshake the agent makes takes 5s waiting for validation
        // to time out.
        r"^.+\.letsencrypt\.org$".into(),
        r"^.+\.digicert\.com$".into(),
        r"^.+\.amazontrust\.com$".into(),
    ]);

    // Task-specific extras layered on top (seeded from project
    // at create time, frozen onto the task from then on). Users
    // type these as wildcards (`*.example.com`, `bitbucket.org`)
    // because regex is friction for a config screen - we translate to
    // anchored regex here so the proxy's matcher (which is regex-only)
    // sees a uniform format.
    hosts.extend(task.sandbox_allowed_hosts.iter().map(|w| wildcard_to_regex(w)));

    // Per-agent allowed hosts from the registry (Settings → Agents),
    // the network counterpart to the agent's sandbox_allowed_paths.
    // "Allow · per agent" persists here so every task running this
    // CLI inherits the host without re-clicking.
    let settings = crate::load_settings_inner();
    if let Some(a) = settings.agents.iter().find(|a| a.id == effective_cli) {
        hosts.extend(a.sandbox_allowed_hosts.iter().map(|w| wildcard_to_regex(w)));
    }

    dedupe(&mut hosts);
    let mut out = String::from("# Generated by termic sandbox for task ");
    out.push_str(&task.id);
    out.push('\n');
    for h in &hosts {
        out.push_str(h);
        out.push('\n');
    }
    out
}

/// Extract just the host regex patterns from a task's allowlist.
/// Same default set as `render_filter` (which keeps the on-disk debug
/// file), minus the comment header - this is what we feed to the
/// in-process proxy at start time.
#[allow(dead_code)]
pub fn host_patterns(task: &Task) -> Vec<String> {
    host_patterns_for(task, None)
}

pub fn host_patterns_for(task: &Task, agent_override: Option<&str>) -> Vec<String> {
    render_filter_for(task, agent_override)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_string())
        .collect()
}

/// Provision the full sandbox bundle for one PTY spawn:
///   - Render + write the seatbelt profile.
///   - Render + write the host allowlist (for user debugging only).
///   - Start the in-process CONNECT proxy on a free loopback port.
///
/// Profile/filter files live in tempdir under predictable names so the
/// user can inspect them when something denies surprisingly.
///
/// `broker` is the spawn's resolved Secrets role. It only takes effect when
/// this profile also blocks the Keychain (an agent that can read the
/// Keychain can read the real token itself); otherwise the spawn is exactly
/// what it would be without one.
pub fn provision(task: &Task, agent_override: Option<&str>, mode: SandboxMode, broker: Option<BrokerSetup>) -> Result<SandboxBundle> {
    let monitor = mode == SandboxMode::Monitor;
    // Hard-fail early on platforms where Seatbelt doesn't exist.
    // The frontend should be gating on sandbox_available(), but
    // defense in depth - missing this check would crash the agent
    // spawn with a "sandbox-exec: command not found" later.
    if !available() {
        return Err(anyhow!(
            "sandbox unavailable on this OS (requires macOS sandbox-exec)"
        ));
    }
    // Fresh start for the popover trackers. Each PTY spawn re-renders
    // the SBPL profile + restarts the proxy with potentially different
    // allowlists; carrying historical denies forward would falsely
    // surface paths/hosts that are now permitted (the rendered profile
    // is the truth, the tracker is just a heuristic for "what was the
    // last thing claude tried to reach"). If something is *still*
    // blocked, the kernel + proxy will refill the trackers within
    // milliseconds of the agent retrying.
    clear_path_denies(&task.id);
    clear_path_access(&task.id);
    crate::proxy::clear_network_denies(&task.id);
    crate::proxy::clear_network_access(&task.id);
    crate::broker::clear_events(&task.id);
    let tmp = std::env::temp_dir();
    let profile_path = tmp.join(format!("termic-sandbox-{}.sb", task.id));
    let filter_path  = tmp.join(format!("termic-proxy-{}.filter", task.id));

    // Filter file is purely for the user's `cat` benefit now; the proxy
    // gets its patterns from memory below. Best-effort write.
    let _ = fs::write(&filter_path, render_filter_for(task, agent_override));

    let patterns = host_patterns_for(task, agent_override);
    dlog(&format!("[sandbox/{}] provisioning ({}), {} host patterns",
        task.id, if monitor { "monitor" } else { "enforce" }, patterns.len()));
    let policy = if monitor { compute_monitor_policy(task, agent_override) } else { MonitorPolicy::default() };
    let ws_dirs = if monitor { task_exclude_dirs(task) } else { Vec::new() };
    let path_watcher = watch_task(&task.id, &canonicalize_or_keep(&task.path), ws_dirs, monitor, policy);
    if path_watcher.is_some() {
        dlog(&format!("[sandbox/{}] path {} watcher attached", task.id, if monitor { "access" } else { "deny" }));
    }
    // EnforceFs disables the network sandbox entirely: no proxy, no
    // hostname allow-list, no http_proxy injection (wrap_command only
    // injects it when `proxy` is Some). The seatbelt profile allows all
    // network directly. Every other mode runs the filtering/logging proxy.
    let broker = broker.filter(|_| blocks_keychain(task, mode));
    let host_patterns = patterns.clone();
    let proxy = if mode == SandboxMode::EnforceFs {
        dlog(&format!("[sandbox/{}] network sandbox OFF (enforce-fs); no proxy", task.id));
        None
    } else {
        match proxy::start(patterns, task.id.clone(), monitor) {
            Ok(p) => {
                dlog(&format!("[sandbox/{}] proxy up on port {}", task.id, p.port));
                Some(p)
            }
            Err(e) => {
                dlog(&format!("[sandbox/{}] proxy failed to start: {e}", task.id));
                None
            }
        }
    };
    let port = proxy.as_ref().map(|p| p.port).unwrap_or(0);

    // EnforceFs has no proxy, and a MITM delivery (git) needs one: start an
    // allow-all one that only those tools are pointed at, and only when the
    // role turns such a delivery on.
    let git_proxy = match &broker {
        Some(b) if mode == SandboxMode::EnforceFs && crate::broker::role_wants_mitm(&b.role, &b.secrets) => {
            proxy::start(vec!["^.*$".into()], task.id.clone(), false)
                .map_err(|e| dlog(&format!("[sandbox/{}] git proxy failed to start: {e}", task.id)))
                .ok()
        }
        _ => None,
    };
    let broker = broker.and_then(|b| start_broker(task, mode, &b, host_patterns, proxy.as_ref().or(git_proxy.as_ref())));

    let mut profile = render_profile(task, port, agent_override, mode)?;
    if let Some(b) = &broker { profile.push_str(&broker_profile_rules(b)); }
    fs::write(&profile_path, &profile)
        .with_context(|| format!("write {}", profile_path.display()))?;
    dlog(&format!("[sandbox/{}] profile written: {}", task.id, profile_path.display()));

    let keychain = KeychainHold::new(&task.id, blocks_keychain(task, mode));
    Ok(SandboxBundle { profile_path, filter_path, proxy, path_watcher, mode, keychain, broker, git_proxy })
}

/// Start the spawn's broker and hook it into the proxy git uses. A failure
/// costs the agent its secrets, never the spawn: it gets no placeholder, so
/// nothing is exposed.
fn start_broker(task: &Task, mode: SandboxMode, b: &BrokerSetup, host_patterns: Vec<String>, proxy: Option<&proxy::ProxyHandle>) -> Option<crate::broker::BrokerHandle> {
    let started = crate::broker::new_spawn_dir().and_then(|dir| crate::broker::start(crate::broker::StartArgs {
        task_id: &task.id,
        role: &b.role,
        secrets: &b.secrets,
        task_allows: &task.secret_allows,
        host_patterns: if mode == SandboxMode::EnforceFs { Vec::new() } else { host_patterns },
        allow_all_hosts: mode == SandboxMode::EnforceFs,
        proxy_port: proxy.map(|p| p.port),
        dir,
    }, task.profile.clone()));
    match started {
        Ok(h) => {
            if let Some(p) = proxy { p.attach_broker(h.mitm_ctx()); }
            dlog(&format!("[sandbox/{}] broker up: role {} socket={:?} base_url_port={:?}", task.id, b.role.name, h.socket_path, h.base_url_port));
            Some(h)
        }
        Err(e) => {
            dlog(&format!("[sandbox/{}] broker failed to start, no secrets for this spawn: {e}", task.id));
            None
        }
    }
}

/// Seatbelt rules for a brokered spawn, appended after the rest of the
/// profile (so after the base-dir deny): read on its scratch dir (CA pem,
/// bundle, the socket's dir), rw only on gh's config dir, outbound to its gh
/// socket and to its base-URL endpoint's loopback port. The socket and CA
/// files stay read-only, so the agent cannot unlink or swap them. None of
/// these is the control-plane socket, so the control plane's final deny
/// still holds.
fn broker_profile_rules(b: &crate::broker::BrokerHandle) -> String {
    let mut out = String::from("\n;; --- Credential broker: this spawn's scratch dir, gh socket, base-URL port ---\n");
    for p in &b.ro_paths {
        out.push_str(&format!("(allow file-read* (subpath \"{}\"))\n", sbpl_escape(p)));
    }
    for p in &b.rw_paths {
        out.push_str(&format!("(allow file-read* file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    }
    if let Some(sock) = &b.socket_path {
        out.push_str(&format!("(allow network-outbound (remote unix-socket (path-literal \"{}\")))\n", sbpl_escape(&sock.to_string_lossy())));
    }
    if let Some(port) = b.base_url_port {
        out.push_str(&format!("(allow network-outbound (remote ip \"localhost:{port}\"))\n"));
    }
    out
}

/// Wrap an agent command with `sandbox-exec -f <profile> env <vars>
/// <cmd> <args...>`. Returns the new (cmd, args) the PTY should spawn.
/// HTTP[S]_PROXY env is injected so HTTPS traffic actually goes through
/// our in-process proxy rather than being blocked by the kernel sandbox.
pub fn wrap_command(
    bundle: &SandboxBundle,
    original_cmd: &str,
    original_args: &[String],
) -> (String, Vec<String>) {
    let mut new_args: Vec<String> = Vec::new();
    new_args.push("-f".into());
    new_args.push(bundle.profile_path.to_string_lossy().into_owned());
    new_args.push("env".into());
    // a brokered spawn must not inherit a real token from Termic's own env
    // (`env -u` has to come before the assignments).
    if let Some(b) = &bundle.broker {
        for k in &b.strip_env {
            new_args.push("-u".into());
            new_args.push(k.clone());
        }
    }
    // Self-identifying env so agents (and tools they spawn) can map
    // EPERM filesystem errors and 403 X-Termic-Sandbox responses back
    // to "I'm in a Termic cage" instead of guessing macOS TCC. Most
    // useful when the user pastes their task's CLAUDE.md /
    // AGENTS.md a note like:
    //   "If $TERMIC_SANDBOX=1 and you hit EPERM on a write, the path
    //    isn't on the task's writable list. Tell the user to
    //    add it via the Sandbox dialog or disable the cage."
    new_args.push("TERMIC_SANDBOX=1".into());
    // Which cage: the termic CLI refuses the control plane only for
    // ENFORCING modes. Monitor's contract is observe-never-block
    // (docs/plans/cli.md): a monitored agent reaches the socket by
    // design, its token read and CLI use just show up in the log.
    new_args.push(format!(
        "TERMIC_SANDBOX_MODE={}",
        match bundle.mode {
            crate::SandboxMode::Off => "off",
            crate::SandboxMode::Monitor => "monitor",
            crate::SandboxMode::Enforce => "enforce",
            crate::SandboxMode::EnforceFs => "enforce-fs",
        }
    ));
    new_args.push("TERMIC_SANDBOX_HELP=Filesystem EPERM on paths outside the task = blocked by Termic sandbox, not by macOS TCC. Network 403 with header `X-Termic-Sandbox: blocked-by-allowlist` = same cause. Fix: open the Sandbox dialog (shield icon on the task) and add the path/host, or disable the cage.".into());
    if let Some(proxy) = &bundle.proxy {
        let url = format!("http://127.0.0.1:{}", proxy.port);
        new_args.push(format!("http_proxy={url}"));
        new_args.push(format!("https_proxy={url}"));
        new_args.push(format!("HTTP_PROXY={url}"));
        new_args.push(format!("HTTPS_PROXY={url}"));
        new_args.push("no_proxy=localhost,127.0.0.1,::1".into());
        new_args.push("NO_PROXY=localhost,127.0.0.1,::1".into());
        // Node `--use-env-proxy` only exists in v24+. Setting it via
        // NODE_OPTIONS on Node 20/22 (LTS) crashes the agent CLI at
        // launch with "node: bad option" - exactly the kind of EPERM-
        // shaped spawn failure we were chasing. If/when v24 LTS lands
        // and is the norm, we can re-add it; until then routing of
        // node-internal fetch() traffic is the agent CLI's problem
        // (they typically use the http_proxy env above via undici).
    }
    if let Some(b) = &bundle.broker {
        new_args.extend(b.env.iter().map(|(k, v)| format!("{k}={v}")));
    }
    new_args.push(original_cmd.into());
    new_args.extend(original_args.iter().cloned());
    ("sandbox-exec".into(), new_args)
}

/// Query macOS `log` for recent sandbox denials touching a task.
/// Filters by:
///   - subsystem/sender: sandboxd / kernel (where Seatbelt logs land)
///   - last N minutes
///   - eventMessage containing the task path (so users only see
///     denials caused by their own agent, not noise from other apps)
/// Returns lines in newest-first order. Empty Vec on any failure -
/// debugging shouldn't itself fail.
pub fn recent_denials(task_path: &str, minutes: u32) -> Vec<String> {
    let predicate = format!(
        "(sender == \"kernel\" OR sender == \"sandboxd\") AND eventMessage CONTAINS \"deny\" AND eventMessage CONTAINS \"{}\"",
        // The path goes inside a quoted literal in the predicate; we
        // escape both backslashes and embedded double-quotes
        // defensively. macOS paths don't contain quotes in practice
        // but it costs nothing to be safe.
        task_path.replace('\\', "\\\\").replace('"', "\\\""),
    );
    let last_arg = format!("{}m", minutes);
    let out = crate::proc_ctl::command("log")
        .args(["show", "--predicate", &predicate, "--last", &last_arg, "--style", "compact"])
        .output();
    let Ok(out) = out else { return Vec::new(); };
    if !out.status.success() { return Vec::new(); }
    let text = String::from_utf8_lossy(&out.stdout);
    // `log show` prints a banner header and a "Filtering the log data
    // using ..." preamble that we don't want. Keep only lines that
    // mention "deny" - that filter is the actual data row.
    let mut lines: Vec<String> = text
        .lines()
        .filter(|l| l.contains("deny"))
        .map(|l| l.to_string())
        .collect();
    lines.reverse();        // newest first
    lines.truncate(50);     // cap to keep the IPC payload tiny
    lines
}

// ─── helpers ─────────────────────────────────────────────────────────

const SBPL_HEADER: &str = r#";; termic sandbox profile - generated; do not edit.
(version 1)
(deny default)

;; Process + IPC essentials (Node, Python, git, shells need these).
(allow process-exec)
(allow process-fork)
(allow signal (target self))
;; Bun's TUI / Ink rendering hangs without these. Bun uses libuv,
;; which queries its own task info during the event loop init for
;; the TTY-watching subsystem. Without process-info*, the loop
;; never reaches the React-Ink first render and claude shows just
;; a cursor in the upper-left forever.
(allow process-info* (target self))
;; Some runtimes (Bun, V8) JIT or load executable code via mmap.
;; Without file-map-executable the runtime works for most paths
;; but TUI / hot-paths fall over.
(allow file-map-executable)
;; Child process control - signal own children, send SIGWINCH on
;; resize, etc. Required for shells that exec sub-tools.
(allow signal (target children))
;; Mach task-port access for IPC with our own children + for libuv
;; thread-pool management. Restricted to self to keep the cage
;; meaningful (can't grab other apps' task ports).
(allow mach-priv-task-port)
(allow sysctl-read)
(allow sysctl*)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow iokit-open)
(allow system-socket)

;; Filesystem: ALLOWLIST. The header intentionally does NOT broadly
;; allow file-read*; render_profile emits per-path (allow file-read*
;; (subpath "...")) entries for the task, agent, runtime, and
;; system roots. `(deny default)` at the very top is the actual
;; default for everything not listed.

;; Character devices the runtime expects to read/write/ioctl on. The
;; permissive vnode-type rule covers /dev/null, /dev/tty, the PTY
;; pair (/dev/ttys0NN, /dev/ptmx), /dev/random, /dev/urandom, etc.
;; Without file-ioctl on character devices, Node's tty.setRawMode()
;; throws EPERM at agent startup ("setRawMode EPERM" from
;; node:tty:81) and every interactive Node CLI (gemini, claude in
;; raw mode, etc.) fails to launch.
(allow file-write-data (vnode-type CHARACTER-DEVICE))
(allow file-ioctl      (vnode-type CHARACTER-DEVICE))
"#;

/// The Keychain services a blocked task cannot reach, from
/// `launchctl print gui/$UID` / `system` on macOS 26: every secd endpoint
/// (`com.apple.securityd*`: the data-protection keychain on `.xpc`, the
/// system keychain, CKKS / SOS sync), the keychain agents and sync helpers,
/// and CryptoTokenKit (`com.apple.ctkd*`), which serves smart-card and
/// token identities as keychain items. Keychain prompts stop because the
/// security agents are unreachable. authd stays reachable, so this does not
/// stop other password prompts.
///
/// SecurityServer is deliberately NOT here. Secure Transport needs it to
/// parse any server cert, so denying it broke system curl and Apple git
/// against every host ("Couldn't understand the server certificate
/// format"). The legacy login keychain is read by the client process, so
/// the `~/Library/Keychains` dir deny is what keeps it out: with
/// SecurityServer reachable and the dir denied, the login keychain drops
/// off the search list and `security`, ctypes and git's helper all find
/// nothing (measured, see docs/sandbox.md).
const KEYCHAIN_MACH_DENY: &str = r#"(deny mach-lookup
  (global-name-prefix "com.apple.securityd")
  (global-name-prefix "com.apple.security.agent")
  (global-name "com.apple.security.keychain")
  (global-name "com.apple.security.KeychainStasher")
  (global-name "com.apple.security.octagon")
  (global-name "com.apple.security.escrow")
  (global-name "com.apple.security.kcsharing")
  (global-name "com.apple.security.cloudkeychainproxy")
  (global-name-prefix "com.apple.ctkd"))
"#;

/// Every keychain file outside the system's own, wherever it lives. With
/// SecurityServer reachable, an unlocked keychain the cage can read (one
/// made with `security create-keychain <path>`, kept outside
/// `~/Library/Keychains`) would be decrypted for the agent; measured
/// leaking without this rule and not with it.
///
/// The extension matches in any case (APFS is case-insensitive, so
/// `x.KEYCHAIN-DB` is as real as `x.keychain-db`). Only the two dirs that
/// hold the roots and the System keychain are exempt, not all of `/System`,
/// whose `/System/Volumes/Data` is another path to every home dir. A
/// keychain saved under a non-keychain name is not caught here: name
/// matching is all a profile rendered without enumerating the user's
/// keychains can do. Hard links out of `~/Library/Keychains` need no rule
/// of their own: the dir deny already refuses `ln` (measured).
const KEYCHAIN_FILE_DENY: &str = r#"(deny file-read* file-write*
  (require-all
    (regex #"\.[kK][eE][yY][cC][hH][aA][iI][nN](-[dD][bB])?$")
    (require-not (subpath "/System/Library/Keychains"))
    (require-not (subpath "/Library/Keychains"))))
"#;

/// Whether this profile cuts off the Keychain. The renderer emits the block
/// under it and `provision` registers the PTY's hold from it, so the footer
/// cannot disagree with the profile. Monitor never blocks.
pub(crate) fn blocks_keychain(task: &Task, mode: crate::SandboxMode) -> bool {
    task.sandbox_block_keychain
        && matches!(mode, crate::SandboxMode::Enforce | crate::SandboxMode::EnforceFs)
}

/// `$HOME/Library/Keychains` and, when it differs, its resolved form. The
/// runtime allow loop emits both, so the deny has to as well.
pub(crate) fn keychain_dirs(home: &str) -> Vec<String> {
    let lit = format!("{}/Library/Keychains", home.trim_end_matches('/'));
    let canon = canonicalize_or_keep(&lit);
    if canon != lit && !canon.is_empty() { vec![lit, canon] } else { vec![lit] }
}

/// Enumerate top-level entries under $HOME and return the absolute
/// paths of those NOT covered by `user_allowed` and NOT covered by
/// `runtime`. The result is the auto-deny set the cage emits to
/// give the user "allow-list" semantics without restricting writes
/// at the SBPL level (which hangs Bun runtimes).
///
/// "Covered" means: either path == entry, OR path starts with
/// entry+"/". So if user_allowed contains `~/Work/myproject`, the
/// `~/Work` entry is NOT excluded - we still deny it - and the
/// caller re-allows the specific subpath after the deny rule.
#[allow(dead_code)]
fn compute_home_denies(home: &str, user_allowed: &[String], runtime: &[String]) -> Vec<String> {
    let home_path = std::path::Path::new(home);
    let entries = match fs::read_dir(home_path) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    // Pre-compute prefixes from allow-list + runtime. A user_allowed
    // entry covers its own dir or a parent IF that parent IS the
    // entry. We use exact-match for that decision (not prefix) so
    // ~/Work containing ~/Work/myproject still gets denied at the
    // parent level and re-allowed at the child level.
    let covered: HashSet<String> = user_allowed.iter()
        .chain(runtime.iter())
        .cloned()
        .collect();

    let mut denies: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip the . and .. (read_dir doesn't return them on macOS but be defensive)
        if name == "." || name == ".." { continue; }
        let full = format!("{home}/{name}");

        // If this entry IS exactly in covered, skip (covered = allowed).
        if covered.contains(&full) { continue; }

        // If anything in covered LIVES INSIDE this entry (e.g. covered
        // has ~/Work/myproject and entry is ~/Work), we STILL deny
        // the parent - the caller re-allows the child after, which
        // takes precedence due to SBPL last-match-wins ordering.

        // If this entry is INSIDE a covered prefix (e.g. covered has
        // ~/Library/Caches and entry is ~/Library), do NOT auto-deny:
        // the user/runtime want access to a child, and denying the
        // parent would mask the re-allow we emit AFTER, which would
        // work via SBPL precedence BUT also blocks intermediate
        // operations (directory listing of ~/Library itself). Safer
        // to leave the parent open and let the runtime/user
        // re-allows handle specifics.
        let is_ancestor_of_covered = covered.iter().any(|c| {
            c.starts_with(&full) && c.as_bytes().get(full.len()) == Some(&b'/')
        });
        if is_ancestor_of_covered { continue; }

        denies.push(full);
    }
    denies.sort();
    denies
}

/// Resolve symlinks so the SBPL rules match what the kernel sees.
/// Seatbelt evaluates the *canonical* path; a worktree symlinked
/// somewhere else would otherwise fail writes through the symlink.
pub(crate) fn canonicalize_or_keep(p: &str) -> String {
    crate::canon_str(p)
}

/// If `task_root` is a git worktree (its `.git` is a regular file
/// with `gitdir: <path>`), return the parent repo's `.git/` directory
/// so the cage can allow reads+writes against it. Returns None when
/// the task is the parent checkout itself (is_main_checkout) or not
/// a git working tree at all.
///
/// Logic:
///   1. Read `<task_root>/.git`.
///   2. Expect `gitdir: <abs path to /<parent>/.git/worktrees/<name>>`.
///   3. Walk up to `<parent>/.git` (i.e. trim `/worktrees/<name>` suffix).
///   4. Canonicalize and return.
pub(crate) fn parent_git_dir_for_worktree(task_root: &str) -> Option<String> {
    let dot_git = std::path::Path::new(task_root).join(".git");
    // For a regular checkout (is_main_checkout), `.git` is a directory and
    // we don't need to widen — the task allow already covers it
    // via the task path subpath. We only act for the file-form.
    let meta = fs::metadata(&dot_git).ok()?;
    if !meta.is_file() { return None; }
    let contents = fs::read_to_string(&dot_git).ok()?;
    let line = contents.lines().find(|l| l.starts_with("gitdir:"))?;
    let raw_gitdir = line.trim_start_matches("gitdir:").trim();
    // gitdir may be relative to the worktree root; resolve.
    let gitdir_abs = if std::path::Path::new(raw_gitdir).is_absolute() {
        raw_gitdir.to_string()
    } else {
        std::path::Path::new(task_root).join(raw_gitdir).to_string_lossy().into_owned()
    };
    // The gitdir path lands on `<parent>/.git/worktrees/<name>`. We
    // want `<parent>/.git`. Trim the last two path components only if
    // the second-to-last is literally "worktrees" — otherwise we'd
    // truncate non-worktree gitdirs (rare but possible for submodule
    // configurations).
    let p = std::path::Path::new(&gitdir_abs);
    let parent_worktrees = p.parent()?;
    if parent_worktrees.file_name()?.to_string_lossy() != "worktrees" { return None; }
    let parent_git = parent_worktrees.parent()?;
    Some(canonicalize_or_keep(&parent_git.to_string_lossy()))
}

fn dedupe(v: &mut Vec<String>) {
    let mut seen: HashSet<String> = HashSet::new();
    v.retain(|s| seen.insert(s.clone()));
}

/// Strict ancestor directories of `path` — its parent, grandparent, … up
/// to (but NOT including) the filesystem root `/`. Returned deepest-first.
///
/// Used to grant `(allow file-read* (literal …))` on each: a shell/agent
/// launched in the task canonicalizes its cwd with realpath(3), which
/// must open() every ancestor directory to resolve the path. open(dir) is a
/// `file-read-data` op the allow-list denies outside the task subtree,
/// so without these grants `bun run` / `bunx` — and anything else that
/// realpath()s the cwd — fail at startup with EPERM. `/` is granted
/// separately (literal) and is this loop's terminator.
fn ancestor_dirs(path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = std::path::Path::new(path);
    while let Some(parent) = cur.parent() {
        if parent.as_os_str().is_empty() || parent == std::path::Path::new("/") {
            break;
        }
        out.push(parent.to_string_lossy().into_owned());
        cur = parent;
    }
    out
}

/// Every task root's (and multi-repo member's) ancestor directory
/// chain, canonicalized + deduped — the set granted `literal` read so cwd
/// canonicalization (realpath) works without exposing sibling subtrees.
/// Shared by `render_profile` (enforcement) and `compute_monitor_policy`
/// (the would-block classifier) so the two never disagree.
fn task_ancestor_dirs(task: &Task) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for root in std::iter::once(canonicalize_or_keep(&task.path))
        .chain(task.composition.iter().map(|m| canonicalize_or_keep(&m.path)))
    {
        if root.is_empty() { continue; }
        out.extend(ancestor_dirs(&root));
    }
    dedupe(&mut out);
    out
}

/// Convert a wildcard host pattern into an anchored regex string the
/// proxy's matcher can use. Convention is the simplest possible:
///
///   * `*` matches any sequence of characters (zero or more).
///   * Everything else is a literal (regex metas are escaped).
///   * The whole hostname must match (anchored both ends).
///
/// Examples:
///   `*.example.com`  →  `^.*\.example\.com$`   (api.example.com ✓, example.com ✗)
///   `example.com`    →  `^example\.com$`        (exact match)
///   `*example*`      →  `^.*example.*$`          (substring match)
///
/// If the user explicitly types something starting with `^`, they're
/// asking for raw regex - pass through untouched. Keeps a power-user
/// escape hatch without forcing regex on the common case.
fn wildcard_to_regex(pattern: &str) -> String {
    let p = pattern.trim();
    if p.starts_with('^') { return p.to_string(); }
    let mut out = String::with_capacity(p.len() + 4);
    out.push('^');
    for ch in p.chars() {
        match ch {
            '*' => out.push_str(".*"),
            // Regex metacharacters that need escaping in the literal
            // portion. `.` is the most important (every hostname has
            // dots), the rest are defensive.
            '.' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' | '$' | '/' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('$');
    out
}

fn sbpl_escape(s: &str) -> String {
    // SBPL strings don't allow embedded quotes/backslashes in practice;
    // the rendered path comes from canonicalize() so it's a normal
    // POSIX path. Defensive escape just in case.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// SBPL `(regex #"...")` patterns are verbatim — backslashes are part of
/// the regex metalanguage and MUST be preserved (e.g. `\.` = literal dot).
/// Only `"` needs escaping to keep the literal closing-quote intact.
/// Calling sbpl_escape here doubles every `\` and corrupts the pattern.
fn sbpl_regex_escape(s: &str) -> String {
    s.replace('"', "\\\"")
}

#[cfg(test)]
mod mode_env_tests {
    use super::*;

    fn bundle(mode: crate::SandboxMode) -> SandboxBundle {
        SandboxBundle {
            profile_path: "/tmp/x.sb".into(),
            filter_path: "/tmp/x.filter".into(),
            proxy: None,
            path_watcher: None,
            mode,
            keychain: KeychainHold { task_id: None },
            broker: None,
            git_proxy: None,
        }
    }

    #[test]
    fn wrap_command_pins_the_mode_strings_the_cli_matches() {
        // termic-cli's cage_refused exempts exactly "monitor"; a rename
        // here would fail closed (Monitor loses CLI access) with no
        // other test noticing. These strings are wire-ish API.
        for (mode, expect) in [
            (crate::SandboxMode::Monitor, "TERMIC_SANDBOX_MODE=monitor"),
            (crate::SandboxMode::Enforce, "TERMIC_SANDBOX_MODE=enforce"),
            (crate::SandboxMode::EnforceFs, "TERMIC_SANDBOX_MODE=enforce-fs"),
        ] {
            let (cmd, args) = wrap_command(&bundle(mode), "claude", &["--foo".into()]);
            assert_eq!(cmd, "sandbox-exec");
            assert!(args.iter().any(|a| a == expect), "{mode:?}: {args:?}");
            assert!(args.iter().any(|a| a == "TERMIC_SANDBOX=1"));
        }
    }

    #[test]
    #[cfg(unix)]
    fn brokered_spawn_strips_real_tokens_and_gets_placeholders() {
        let mut b = bundle(crate::SandboxMode::Enforce);
        let (_, plain) = wrap_command(&b, "claude", &[]);
        assert!(!plain.iter().any(|a| a == "-u" || a.starts_with("GH_TOKEN=")), "{plain:?}");

        b.broker = Some(crate::broker::test_handle("t-wrap", Some(1234)));
        let (_, args) = wrap_command(&b, "claude", &["--foo".into()]);
        let env_at = args.iter().position(|a| a == "env").unwrap();
        // `env -u` options before any assignment
        assert_eq!(&args[env_at + 1..env_at + 9], &["-u", "GH_TOKEN", "-u", "GITHUB_TOKEN", "-u", "GH_ENTERPRISE_TOKEN", "-u", "GITHUB_ENTERPRISE_TOKEN"]);
        let ph = args.iter().find_map(|a| a.strip_prefix("GH_TOKEN=")).unwrap();
        assert!(ph.starts_with("termic_ph_"));
        assert!(args.iter().any(|a| a.starts_with("GIT_CONFIG_COUNT=")));
        assert_eq!(&args[args.len() - 2..], &["claude", "--foo"]);
    }

    #[test]
    #[cfg(unix)]
    fn profile_allows_the_socket_only_when_brokered() {
        let h = crate::broker::test_handle("t-prof", None);
        let rules = broker_profile_rules(&h);
        let sock = h.socket_path.as_ref().unwrap().to_string_lossy().into_owned();
        assert!(rules.contains(&format!("(allow network-outbound (remote unix-socket (path-literal \"{sock}\")))")), "{rules}");
        assert!(rules.contains(&format!("(allow file-read* file-write* (subpath \"{}\"))", h.rw_paths[0])), "{rules}");
        // the rendered profile itself never mentions the broker: provision
        // appends these rules only when a broker started.
        let task = crate::Task {
            id: "t-prof".into(),
            path: std::env::temp_dir().to_string_lossy().into_owned(),
            sandbox_block_keychain: true,
            ..Default::default()
        };
        let p = render_profile_with(&task, 8080, "claude", &[], crate::SandboxMode::Enforce, &ControlPlanePaths { data_dir: None, socket: None }).unwrap();
        assert!(!p.contains("Credential broker") && !p.contains(&sock));
    }
}

#[cfg(test)]
mod profile_dump {
    //! Render the real seatbelt profile for one agent to a file, so a cage
    //! problem can be reproduced by hand instead of guessed at.
    //!
    //! This is how the muse `/Library` denial was found, and it is the fastest
    //! loop there is for "agent X fails under ENFORCING": dump the profile,
    //! run the agent under `sandbox-exec -f` with it, and watch
    //! `log stream --predicate 'eventMessage CONTAINS "Sandbox:" AND
    //! eventMessage CONTAINS "deny"'` in another shell. Note the system log
    //! DEDUPES violations, so each run usually reveals one new path: expect to
    //! iterate rather than get the whole list at once.
    //!
    //! ```sh
    //! DUMP_AGENT=muse DUMP_PATH=/path/to/worktree DUMP_OUT=/tmp/a.sb \
    //!   cargo test --lib profile_dump -- --ignored --nocapture
    //! cd /path/to/worktree && sandbox-exec -f /tmp/a.sb <agent binary>
    //! ```
    #[test]
    #[ignore = "diagnostic helper, run explicitly with DUMP_* set"]
    fn dump() {
        let agent = std::env::var("DUMP_AGENT").unwrap_or_else(|_| "claude".into());
        let path = std::env::var("DUMP_PATH").expect("DUMP_PATH=<a real directory>");
        let out = std::env::var("DUMP_OUT").expect("DUMP_OUT=<file to write>");
        let mut task = crate::Task::default();
        task.id = "dump".into();
        task.path = path;
        task.cli = agent.clone();
        task.sandbox_enabled = true;
        let profile = super::render_profile(&task, 8080, Some(&agent),
                                            crate::SandboxMode::Enforce).unwrap();
        std::fs::write(&out, profile).unwrap();
        eprintln!("wrote {out}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── MONITORING allow-line parsing (mirrors the spike output) ──────

    const ALLOW_LINE: &str =
        "2026-06-07 20:39:36.008 Df kernel[0:19eeb8] (Sandbox) Sandbox: cat(14104) allow file-read-data /private/etc/hosts";
    const DUP_LINE: &str =
        "2026-06-07 20:39:36.008 Df kernel[0:19eeb8] (Sandbox) 3 duplicate report for Sandbox: cat(14104) allow file-read-data /bin/cat";
    const IOCTL_LINE: &str =
        "2026-06-07 20:39:36.008 Df kernel[0] (Sandbox) Sandbox: node(900) allow file-ioctl path:/dev/dtracehelper ioctl-command:(_IO \"h\" 4)";

    #[test]
    fn monitor_parses_pid_op_path() {
        assert_eq!(monitor_pid_and_dup(ALLOW_LINE), Some((14104, 1)));
        assert_eq!(extract_allow_op(ALLOW_LINE).as_deref(), Some("file-read-data"));
        assert_eq!(extract_allow_proc(ALLOW_LINE).as_deref(), Some("cat"));
        let op = extract_allow_op(ALLOW_LINE).unwrap();
        assert_eq!(extract_allow_path(ALLOW_LINE, &op).as_deref(), Some("/private/etc/hosts"));
    }

    #[test]
    fn monitor_counts_duplicate_reports() {
        // "3 duplicate report for ..." → add 3 occurrences, pid still parsed.
        assert_eq!(monitor_pid_and_dup(DUP_LINE), Some((14104, 3)));
    }

    #[test]
    fn monitor_parses_ioctl_path_prefix() {
        let op = extract_allow_op(IOCTL_LINE).unwrap();
        assert_eq!(op, "file-ioctl");
        assert_eq!(extract_allow_path(IOCTL_LINE, &op).as_deref(), Some("/dev/dtracehelper"));
    }

    #[test]
    fn monitor_ignores_non_file_ops() {
        let line = "... (Sandbox) Sandbox: cat(1) allow sysctl-read kern.bootargs";
        assert_eq!(extract_allow_op(line), None);
    }

    // ── MonitorPolicy.would_block ─────────────────────────────────────

    #[test]
    fn would_block_classifies_pure_allowlist() {
        let policy = MonitorPolicy {
            rw_subpaths: vec!["/Users/x/proj".into()],
            read_roots: vec!["/usr".into()],
            rw_regexes: vec![regex::Regex::new(r"^/Users/x/\.claude(\.[^/]*|/.*)?$").unwrap()],
            read_literals: vec![],
        };
        // regex allow (claude family): reads + writes never block.
        assert!(!policy.would_block("/Users/x/.claude.json", "file-read-data"));
        assert!(!policy.would_block("/Users/x/.claude.json.lock", "file-write-create"));
        assert!(policy.would_block("/Users/x/.clauderc-other", "file-read-data"));
        // Inside the task: never blocked (read or write).
        assert!(!policy.would_block("/Users/x/proj/src/main.rs", "file-write-create"));
        assert!(!policy.would_block("/Users/x/proj/src/main.rs", "file-read-data"));
        // System root: reads allowed, writes denied.
        assert!(!policy.would_block("/usr/lib/foo", "file-read-data"));
        assert!(policy.would_block("/usr/lib/foo", "file-write-data"));
        // Outside everything: content reads + writes denied.
        assert!(policy.would_block("/Users/x/other/secret", "file-read-data"));
        assert!(policy.would_block("/Users/x/.ssh/id_rsa", "file-read-data"));
        // Metadata + existence are globally allowed in ENFORCING (needed
        // for symlink traversal + stat), so they never count as would-block.
        assert!(!policy.would_block("/Users/x/other/secret", "file-read-metadata"));
        assert!(!policy.would_block("/Users/x/.ssh", "file-test-existence"));
        assert!(!policy.would_block("/tmp", "file-read-metadata"));
    }

    // ── ancestor path grants (realpath cwd traversal) ─────────────────

    #[test]
    fn ancestor_dirs_walks_up_to_but_not_root() {
        assert_eq!(
            ancestor_dirs("/Users/x/termic/task/proj"),
            vec![
                "/Users/x/termic/task".to_string(),
                "/Users/x/termic".to_string(),
                "/Users/x".to_string(),
                "/Users".to_string(),
            ]
        );
        // Directly under root: nothing (root "/" is granted separately).
        assert!(ancestor_dirs("/proj").is_empty());
        assert!(ancestor_dirs("/").is_empty());
    }

    #[test]
    fn task_ancestor_dirs_strict_ancestors_only() {
        use crate::Task;
        let task = Task { path: "/Users/x/task/a".into(), ..Default::default() };
        let anc = task_ancestor_dirs(&task);
        assert!(anc.contains(&"/Users/x/task".to_string()));
        assert!(anc.contains(&"/Users/x".to_string()));
        assert!(anc.contains(&"/Users".to_string()));
        // Never the task dir itself, and never the root.
        assert!(!anc.contains(&"/Users/x/task/a".to_string()));
        assert!(!anc.contains(&"/".to_string()));
    }

    #[test]
    fn would_block_allows_ancestor_node_read_not_subtree() {
        let policy = MonitorPolicy {
            rw_subpaths: vec!["/Users/x/task/proj".into()],
            read_roots: vec![],
            rw_regexes: vec![],
            read_literals: vec!["/Users/x".into(), "/Users/x/task".into()],
        };
        // The ancestor directory NODE is readable (realpath traversal).
        assert!(!policy.would_block("/Users/x", "file-read-data"));
        assert!(!policy.would_block("/Users/x/task", "file-read-data"));
        // But NOT a sibling subtree under an ancestor.
        assert!(policy.would_block("/Users/x/other/secret", "file-read-data"));
        // Writes to an ancestor node still block (literal grants read only).
        assert!(policy.would_block("/Users/x", "file-write-create"));
    }

    // ── wildcard_to_regex ─────────────────────────────────────────────

    #[test]
    fn wildcard_exact_domain() {
        assert_eq!(wildcard_to_regex("example.com"), r"^example\.com$");
    }

    #[test]
    fn wildcard_star_subdomain() {
        assert_eq!(wildcard_to_regex("*.example.com"), r"^.*\.example\.com$");
    }

    #[test]
    fn wildcard_trailing_star() {
        assert_eq!(wildcard_to_regex("example*"), r"^example.*$");
    }

    #[test]
    fn wildcard_multiple_stars() {
        assert_eq!(wildcard_to_regex("*example*"), r"^.*example.*$");
    }

    #[test]
    fn wildcard_passthrough_raw_regex() {
        // A pattern already starting with ^ passes through unchanged.
        let raw = r"^api\.anthropic\.com$";
        assert_eq!(wildcard_to_regex(raw), raw);
    }

    #[test]
    fn wildcard_escapes_special_chars() {
        // + ? ( ) are escaped; . is escaped; | is escaped
        assert_eq!(wildcard_to_regex("foo+bar.baz?qux"), r"^foo\+bar\.baz\?qux$");
    }

    #[test]
    fn wildcard_trims_whitespace() {
        assert_eq!(wildcard_to_regex("  example.com  "), r"^example\.com$");
    }

    // ── extract_deny_pid ─────────────────────────────────────────────

    #[test]
    fn deny_pid_standard_format() {
        let line = "2026-05-18 12:00:00 kernel Sandbox: openssl(12345) deny(1) file-read-data /etc/passwd";
        assert_eq!(extract_deny_pid(line), Some(12345));
    }

    #[test]
    fn deny_pid_claude_version_format() {
        // claude logs itself as "claude 2.1.144(48523) deny(1) ..."
        let line = "... Sandbox: claude 2.1.144(48523) deny(1) file-read-data /Users/x/.ssh/id_rsa";
        assert_eq!(extract_deny_pid(line), Some(48523));
    }

    #[test]
    fn deny_pid_kernel_prefix() {
        let line = "... kernel[0]: (Sandbox) Sandbox: env(81203) deny(1) file-write-create /tmp/x";
        assert_eq!(extract_deny_pid(line), Some(81203));
    }

    #[test]
    fn deny_pid_none_when_no_deny() {
        let line = "just a normal log line with no deny keyword";
        assert_eq!(extract_deny_pid(line), None);
    }

    // ── extract_deny_proc ────────────────────────────────────────────

    #[test]
    fn deny_proc_simple() {
        let line = "... Sandbox: openssl(12345) deny(1) file-read-data /etc/passwd";
        assert_eq!(extract_deny_proc(line), Some("openssl".into()));
    }

    #[test]
    fn deny_proc_with_version_in_name() {
        // Claude's own format: proc name includes a version string
        let line = "... Sandbox: claude 2.1.144(48523) deny(1) file-read-data /Users/x/.ssh/id_rsa";
        assert_eq!(extract_deny_proc(line), Some("claude 2.1.144".into()));
    }

    #[test]
    fn deny_proc_none_when_no_deny() {
        let line = "this line has no deny token";
        assert_eq!(extract_deny_proc(line), None);
    }

    // ── extract_deny_path ────────────────────────────────────────────

    #[test]
    fn deny_path_file_read_data() {
        let line = "... Sandbox: curl(999) deny(1) file-read-data /Users/alice/.aws/credentials";
        assert_eq!(
            extract_deny_path(line),
            Some("/Users/alice/.aws/credentials".into())
        );
    }

    #[test]
    fn deny_path_file_write_create() {
        let line = "... deny(1) file-write-create /Users/x/Pictures/photo.jpg";
        assert_eq!(
            extract_deny_path(line),
            Some("/Users/x/Pictures/photo.jpg".into())
        );
    }

    #[test]
    fn deny_path_space_in_path() {
        // Paths with spaces (Application Support) must be captured to EOL.
        let line = "... deny(1) file-read-data /Users/x/Library/Application Support/Chrome/cookies";
        assert_eq!(
            extract_deny_path(line),
            Some("/Users/x/Library/Application Support/Chrome/cookies".into())
        );
    }

    #[test]
    fn deny_path_fallback_users_prefix() {
        // Line without a known op token — fallback to first /Users/ prefix.
        let line = "... deny(1) unknown-op /Users/bob/secret.txt";
        assert_eq!(
            extract_deny_path(line),
            Some("/Users/bob/secret.txt".into())
        );
    }

    #[test]
    fn deny_path_none_when_no_path() {
        let line = "... Sandbox: curl(999) deny(1) network-outbound some-host 443";
        // network-outbound is not in the path matcher; should return None
        // unless there's a fallback /Users/ etc. path.
        let result = extract_deny_path(line);
        // No absolute path prefix matching our starters → None.
        assert_eq!(result, None);
    }

    // ── extract_deny_op ──────────────────────────────────────────────

    #[test]
    fn deny_op_file_read_data() {
        let line = "... deny(1) file-read-data /Users/x/.ssh/id_rsa";
        assert_eq!(extract_deny_op(line), Some("file-read-data".into()));
    }

    #[test]
    fn deny_op_file_write_create() {
        let line = "... deny(1) file-write-create /tmp/foo";
        assert_eq!(extract_deny_op(line), Some("file-write-create".into()));
    }

    #[test]
    fn deny_op_network_outbound() {
        let line = "... deny(1) network-outbound api.example.com 443";
        assert_eq!(extract_deny_op(line), Some("network-outbound".into()));
    }

    #[test]
    fn deny_op_none_when_no_op() {
        let line = "... deny(1) some-other-thing /path";
        assert_eq!(extract_deny_op(line), None);
    }

    // ── pure allow-list: no deny-list ─────────────────────────────────

    #[test]
    fn runtime_paths_include_xdg_data_home() {
        let home = "/Users/test";
        let rt = builtin_runtime_paths(home, "/Users/test/task");
        // XDG_DATA_HOME is allowed broadly so the many tool data stores
        // under it (uv/pnpm/pipx/gem/…) work without per-tool allow-clicks.
        assert!(rt.contains(&format!("{home}/.local/share")));
        // Real secret stores are NOT runtime paths.
        assert!(!rt.contains(&format!("{home}/.ssh")));
        assert!(!rt.contains(&format!("{home}/.aws")));
    }

    // ── sbpl_escape ───────────────────────────────────────────────────

    #[test]
    fn sbpl_escape_noop_on_plain_path() {
        assert_eq!(sbpl_escape("/usr/local/bin"), "/usr/local/bin");
    }

    #[test]
    fn sbpl_escape_doubles_backslash() {
        assert_eq!(sbpl_escape("/path\\to"), "/path\\\\to");
    }

    #[test]
    fn sbpl_escape_escapes_double_quote() {
        assert_eq!(sbpl_escape("/path/with\"quote"), "/path/with\\\"quote");
    }

    #[test]
    fn sbpl_escape_both_backslash_and_quote() {
        // input: /a\"b  → output: /a\\\"b
        assert_eq!(sbpl_escape("/a\\\"b"), "/a\\\\\\\"b");
    }

    // ── sbpl_regex_escape ─────────────────────────────────────────────

    #[test]
    fn sbpl_regex_escape_preserves_backslash_dot() {
        // Regex metachar `\.` must survive — only `"` is escaped.
        assert_eq!(sbpl_regex_escape(r"^api\.anthropic\.com$"), r"^api\.anthropic\.com$");
    }

    #[test]
    fn sbpl_regex_escape_escapes_double_quote() {
        assert_eq!(sbpl_regex_escape("^foo\"bar$"), "^foo\\\"bar$");
    }

    #[test]
    fn sbpl_regex_escape_noop_on_plain_pattern() {
        assert_eq!(sbpl_regex_escape(r"^example\.com$"), r"^example\.com$");
    }

    // ── builtin_runtime_paths ─────────────────────────────────────────

    #[cfg(unix)] // unix paths / tools; the Windows behaviour differs by design
    #[test]
    fn the_login_store_allow_survives_the_control_plane_deny() {
        // ORDER, not presence. The control-plane deny covers the whole termic
        // data dir and is deliberately the FINAL filesystem rule, so an allow
        // for the account's store placed with the agent's other paths was
        // rendered and then silently overridden: codex died on `unable to open
        // database file` for `logins/codex/<account>/state_5.sqlite` while the
        // profile visibly contained an allow for it.
        //
        // A textual "contains" check cannot catch that, so this asserts the
        // POSITION: the allow must come after both denies.
        // Inside the scratch data dir, because this reads that dir TWICE (once
        // through `control_plane_paths`, once through `login_store_dir`) and
        // other tests swap it under us. Without the lock the two reads can see
        // different roots and the subpath assertion below fails at random,
        // which is exactly how this showed up: one failure in a full run,
        // green on every rerun.
        crate::test_support::with_scratch_data_dir(|_| {
        let mut task = crate::Task::default();
        task.id = "t".into();
        task.path = "/tmp".into();
        task.cli = "codex".into();
        task.sandbox_enabled = true;
        task.accounts.insert("codex".into(), "Work".into());

        let control = control_plane_paths();
        let p = render_profile_with(&task, 1, "codex", &[], crate::SandboxMode::Enforce, &control).unwrap();
        let dd = control.data_dir.clone().expect("a data dir");
        // Rebased onto the CANONICAL data dir, exactly as the profile does:
        // the store does not exist in this test, and on macOS a `/var` data
        // dir is really `/private/var`, which is the form seatbelt matches.
        let raw = crate::login_store_dir("codex", Some("Work"), crate::LoginRealm::Host)
            .unwrap().to_string_lossy().into_owned();
        let dd_raw = crate::global_dir().unwrap().to_string_lossy().into_owned();
        let store = raw.replacen(&dd_raw, &dd, 1);
        assert!(store.starts_with(&dd), "rebasing failed: {store} vs {dd}");

        let allow_at = p.find(&format!(r#"(allow file-read* file-write* (subpath "{store}"))"#))
            .expect("the account's login store must be allowed");
        let deny_at = p.rfind(&format!(r#"(deny file-read* (subpath "{dd}"))"#))
            .expect("the data dir must still be denied");
        assert!(allow_at > deny_at,
            "the allow must come AFTER the deny or last-match-wins makes it inert");

        // ...and the deny it re-opens a hole in is still doing its job. The
        // CLI token is a sibling of `logins/`, and a caged agent holding it
        // has escaped the sandbox.
        assert!(!p.contains(&format!(r#"(allow file-read* file-write* (subpath "{dd}"))"#)),
            "the data dir itself must never be re-allowed");
        assert!(store.starts_with(&dd),
            "the allow must be a NARROW subpath of the denied dir\n  store: {store}\n  denied: {dd}");
        assert!(store.ends_with("/logins/codex/work"), "one account only: {store}");
        });
    }

    #[test]
    fn library_is_a_read_root_but_never_writable() {
        // Muse Code fails to START under ENFORCING without it: its own error
        // ("Agent Definition filesystem source failed: IoError") is fatal, not
        // a degraded feature. /Library is root-owned system state in the same
        // trust class as /usr and /System/Library, which are already here.
        assert!(system_read_roots().contains(&"/Library"));
        // READS only. The list is rendered as file-read* and nothing in it may
        // ever gain file-write*: /Library holds launch agents, and a writable
        // one is persistence on the user's machine.
        let mut task = crate::Task::default();
        task.id = "t".into();
        task.path = "/tmp".into();
        task.sandbox_enabled = true;
        let p = render_profile_with(&task, 1, "claude", &[], crate::SandboxMode::Enforce,
                                    &control_plane_paths()).unwrap();
        assert!(p.contains(r#"(allow file-read* (subpath "/Library"))"#), "{p}");
        assert!(!p.contains(r#"(allow file-write* (subpath "/Library"))"#), "{p}");
    }

    #[test]
    fn builtin_runtime_paths_contains_task() {
        let paths = builtin_runtime_paths("/Users/test", "/Users/test/projects/myapp");
        assert!(paths.contains(&"/Users/test/projects/myapp".to_string()));
    }

    #[test]
    fn builtin_runtime_paths_contains_npm_cache() {
        let paths = builtin_runtime_paths("/Users/test", "/tmp/task");
        assert!(paths.contains(&"/Users/test/.npm".to_string()));
    }

    #[test]
    fn builtin_runtime_paths_contains_private_tmp() {
        let paths = builtin_runtime_paths("/Users/test", "/tmp/task");
        assert!(paths.contains(&"/private/tmp".to_string()));
    }

    #[test]
    fn builtin_runtime_paths_contains_local_bin() {
        let paths = builtin_runtime_paths("/Users/test", "/tmp/task");
        assert!(paths.contains(&"/Users/test/.local/bin".to_string()));
    }

    // ── clear_path_denies_under ───────────────────────────────────────

    #[test]
    fn clear_path_denies_removes_exact_prefix() {
        let task = "test-clear-exact";
        incr_path_deny(task, "/home/user/secrets", 1, "proc");
        clear_path_denies_under(task, "/home/user/secrets");
        assert_eq!(path_deny_count(task), 0);
    }

    #[test]
    fn clear_path_denies_removes_children() {
        let task = "test-clear-children";
        incr_path_deny(task, "/home/user/dir/file.txt", 1, "proc");
        incr_path_deny(task, "/home/user/dir/sub/other.txt", 1, "proc");
        clear_path_denies_under(task, "/home/user/dir");
        assert_eq!(path_deny_count(task), 0);
    }

    #[test]
    fn clear_path_denies_preserves_sibling() {
        let task = "test-clear-sibling";
        incr_path_deny(task, "/home/user/keep/file.txt", 1, "proc");
        incr_path_deny(task, "/home/user/remove/file.txt", 1, "proc");
        clear_path_denies_under(task, "/home/user/remove");
        assert_eq!(path_deny_count(task), 1);
    }

    #[test]
    fn clear_path_denies_noop_on_empty_prefix() {
        let task = "test-clear-empty-prefix";
        incr_path_deny(task, "/some/path", 1, "proc");
        let before = path_deny_count(task);
        clear_path_denies_under(task, "");
        assert_eq!(path_deny_count(task), before);
        // cleanup
        clear_path_denies_under(task, "/some/path");
    }

    // ── render_filter_for ─────────────────────────────────────────────

    /// A duplicated agent talks to the same vendor API as what it was copied
    /// from. Keyed on the raw id, `next-claude` matched no arm of the vendor
    /// table and reached the proxy with an EMPTY allow-list: the maintainer's
    /// activity panel showed api.anthropic.com blocked 12 times.
    #[test]
    fn a_cloned_agent_inherits_its_parents_vendor_hosts() {
        use crate::Task;
        let task = Task { cli: "claude".into(), ..Default::default() };
        let parent = render_filter_for(&task, None);
        assert!(parent.contains(r"api\.anthropic\.com"), "parent baseline");

        // The clone, resolved through `extends` the way every other per-agent
        // table now does.
        let clone = render_filter_for(&task, Some("next-claude"));
        // Without a registry entry there is nothing to resolve, so this is the
        // honest floor: an unknown id inherits nothing and is NOT silently
        // given claude's egress.
        assert!(!clone.contains(r"api\.anthropic\.com"),
                "an id that extends nothing must not inherit by accident");
    }

    #[test]
    fn render_filter_claude_contains_anthropic() {
        use crate::Task;
        let task = Task { cli: "claude".into(), ..Default::default() };
        let filter = render_filter_for(&task, None);
        assert!(filter.contains("anthropic"), "claude filter must include anthropic entries");
    }

    #[test]
    fn render_filter_gemini_contains_googleapis() {
        use crate::Task;
        let task = Task { cli: "gemini".into(), ..Default::default() };
        let filter = render_filter_for(&task, None);
        assert!(filter.contains("googleapis"), "gemini filter must include googleapis");
    }

    #[test]
    fn render_filter_codex_contains_openai() {
        use crate::Task;
        let task = Task { cli: "codex".into(), ..Default::default() };
        let filter = render_filter_for(&task, None);
        assert!(filter.contains("openai"), "codex filter must include openai");
    }

    #[test]
    fn render_filter_agent_override_wins_over_task_cli() {
        use crate::Task;
        let task = Task { cli: "codex".into(), ..Default::default() };
        let filter = render_filter_for(&task, Some("gemini"));
        assert!(filter.contains("googleapis"), "override to gemini must add googleapis");
        assert!(!filter.contains("openai"), "override must drop codex openai entries");
    }

    #[test]
    fn render_filter_includes_common_hosts() {
        use crate::Task;
        let task = Task { cli: "claude".into(), ..Default::default() };
        let filter = render_filter_for(&task, None);
        assert!(filter.contains("github"), "filter must include github");
        assert!(filter.contains("npmjs"), "filter must include npmjs");
    }

    #[test]
    fn render_filter_custom_allowed_hosts_included() {
        use crate::Task;
        let task = Task {
            cli: "claude".into(),
            sandbox_allowed_hosts: vec!["my-custom-api.example.com".into()],
            ..Default::default()
        };
        let filter = render_filter_for(&task, None);
        assert!(filter.contains("my-custom-api"), "custom allowed hosts must be in filter");
    }

    #[test]
    fn render_filter_unknown_cli_has_common_hosts_only() {
        use crate::Task;
        let task = Task { cli: "custom".into(), ..Default::default() };
        let filter = render_filter_for(&task, None);
        assert!(!filter.contains("anthropic"), "custom cli must not add anthropic");
        assert!(!filter.contains("openai"), "custom cli must not add openai");
        assert!(filter.contains("github"), "common hosts still present");
    }

    #[test]
    fn render_filter_dot_in_host_is_regex_escaped() {
        use crate::Task;
        let task = Task { cli: "claude".into(), ..Default::default() };
        let filter = render_filter_for(&task, None);
        // Dots in hostnames must be regex-escaped as \. not bare .
        assert!(filter.contains(r"anthropic\.com"),
            "dots in hostnames must be regex-escaped as \\.");
    }

    #[test]
    fn enforce_fs_allows_all_network_and_keeps_fs_cage() {
        use crate::{Task, SandboxMode};
        let task = Task { cli: "claude".into(), ..Default::default() };
        // proxy_port is irrelevant in EnforceFs (no proxy runs); pass 0.
        let profile = render_profile(&task, 0, None, SandboxMode::EnforceFs).unwrap();
        // Network sandbox is OFF: full allow, and NONE of the proxy-pinning.
        assert!(profile.contains("(allow network*)"),
            "enforce-fs must allow all network");
        assert!(!profile.contains("(deny network*)"),
            "enforce-fs must NOT deny network");
        assert!(!profile.contains("localhost:0"),
            "enforce-fs must not pin to a loopback proxy");
        // Filesystem cage is still the real deny-by-default allow-list.
        assert!(profile.contains("(deny default)") || profile.contains(SBPL_HEADER.trim()),
            "enforce-fs must keep the deny-by-default filesystem header");
        assert!(profile.contains("file-write*"),
            "enforce-fs must still emit the file write allow-list");
    }

    #[test]
    fn enforce_still_denies_network() {
        use crate::{Task, SandboxMode};
        let task = Task { cli: "claude".into(), ..Default::default() };
        let profile = render_profile(&task, 12345, None, SandboxMode::Enforce).unwrap();
        // Regression guard: full Enforce must remain the network cage.
        assert!(profile.contains("(deny network*)"),
            "enforce must keep denying network");
        assert!(profile.contains("localhost:12345"),
            "enforce must pin outbound to the loopback proxy port");
        assert!(!profile.contains("\n(allow network*)"),
            "enforce must NOT blanket-allow network");
    }

    // ─── Control-plane containment (BEHAVIORAL) ──────────────────────────
    //
    // docs/plans/cli.md, Testing: a textual profile check cannot catch a
    // deny rendered where last-match-wins makes it inert, nor an allow-
    // listed ANCESTOR re-exposing a path whose literal never appears in
    // the list. So these run REAL `sandbox-exec` and observe the outcome.
    // Only ABSENCE is asserted textually (the token secret never appears);
    // reachability is proven by running connect()/open() in the cage.

    use crate::{SandboxMode, Task};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// macOS + sandbox-exec + the toolchain-free binaries the in-cage
    /// probes need. Deliberately NOT /usr/bin/python3 or /usr/bin/git:
    /// those are xcrun shims that dlopen the Xcode/CLT toolchain, which
    /// the FS cage blocks (the whole point). `/bin/cat` reads a file,
    /// `/usr/bin/nc -U` connects a unix socket; both are plain Mach-O.
    fn cage_available() -> bool {
        available()
            && Path::new("/bin/cat").exists()
            && Path::new("/usr/bin/nc").exists()
    }

    /// A hostile fixture: a canonical temp tree standing in for `~/Library`,
    /// with the app data dir (token, socket, projects.json) nested inside
    /// it, plus a sibling file to serve as the positive control.
    struct Fixture {
        tmp: tempfile::TempDir,
        ancestor: String,      // the ~/Library stand-in we allow-list
        data_dir: String,      // <ancestor>/Application Support/termic
        token_path: String,
        socket_path: String,
        control_file: String,  // <ancestor>/allowed.txt (readable proof)
        control_socket: String, // a peer socket, NOT the control plane
        secret: String,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        // Canonicalize: seatbelt evaluates canonical paths, and macOS
        // TMPDIR is /var/folders -> /private/var/folders. Everything below
        // must therefore be canonical to match, and the allow-list entries
        // must be too (subst_path does not canonicalize user paths).
        let root = tmp.path().canonicalize().unwrap();
        // Short nesting: the macOS TMPDIR prefix is already ~55 chars and
        // the socket path must stay under the 104-byte sun_path limit. The
        // containment property only needs data_dir nested UNDER the
        // allow-listed ancestor; `lib`/`d` stand in for the real
        // `~/Library` / `Application Support/termic` layout.
        let ancestor = root.join("lib");
        let data_dir = ancestor.join("d");
        std::fs::create_dir_all(&data_dir).unwrap();
        let secret = "S3CRET-cli-token-do-not-leak".to_string();
        let token_path = data_dir.join(termic_proto::TOKEN_FILE);
        std::fs::write(&token_path, &secret).unwrap();
        let control_file = ancestor.join("allowed.txt");
        std::fs::write(&control_file, "readable proof").unwrap();
        // A live control-plane socket + an unrelated peer socket.
        let socket_path = data_dir.join(termic_proto::SOCKET_FILE);
        let _sock = termic_proto::local::bind(&socket_path).unwrap();
        let control_socket = root.join("peer.sock");
        let _peer = termic_proto::local::bind(&control_socket).unwrap();
        // Leak the listeners for the test's lifetime (dropping would unlink
        // the socket files). The TempDir cleans everything on drop.
        std::mem::forget(_sock);
        std::mem::forget(_peer);
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        Fixture {
            tmp,
            ancestor: s(ancestor),
            data_dir: s(data_dir.clone()),
            token_path: s(token_path),
            socket_path: s(socket_path),
            control_file: s(control_file),
            control_socket: s(control_socket),
            secret,
        }
    }

    /// Render a hostile ENFORCING profile: `~/Library` is allow-listed
    /// through BOTH render_profile seams at once - the task list (where
    /// live_sandbox_lists deposits the global, task, project.json and
    /// .termic.yaml layers, all concatenated) and the agent-registry list
    /// (agent_sandbox_add_allowed_path). That covers every one of the four
    /// unioned extension layers the spec names. Writes the profile to a
    /// temp .sb and returns its path.
    fn hostile_profile(fx: &Fixture, mode: SandboxMode) -> PathBuf {
        let task = Task {
            cli: "claude".into(),
            path: format!("{}/worktree", fx.ancestor),
            base_branch: "main".into(),
            // The task allow-list layer (global + task + project layers all
            // land here at spawn) allow-lists the ancestor as a subpath.
            sandbox_rw_paths: vec![fx.ancestor.clone()],
            ..Default::default()
        };
        // The agent-registry layer ALSO allow-lists it, as a subpath and a
        // broad regex, exercising both emit forms.
        let agent_paths = vec![
            fx.ancestor.clone(),
            format!("regex:^{}(/.*)?$", regex::escape(&fx.ancestor)),
        ];
        let control = ControlPlanePaths {
            data_dir: Some(fx.data_dir.clone()),
            socket: Some(fx.socket_path.clone()),
        };
        // A valid loopback proxy port: Enforce emits (remote ip
        // "localhost:<port>"), which sandbox-exec rejects if it is 0.
        // EnforceFs ignores the port (no proxy).
        let profile =
            render_profile_with(&task, 51999, "claude", &agent_paths, mode, &control).unwrap();
        // Sanity: the ancestor really is allow-listed (so a pass proves the
        // deny won, not that the path was simply never granted).
        assert!(
            profile.contains(&format!("(subpath \"{}\")", fx.ancestor)),
            "fixture must allow-list the ancestor"
        );
        // Write the profile INSIDE this fixture's own TempDir, never a
        // shared temp_dir()/<pid>-<mode>.sb: each test builds its own
        // Fixture, so a per-fixture path can't be create/truncate/deleted
        // out from under a parallel libtest thread (that race could make a
        // security test spuriously report a containment breach). The
        // TempDir cleans it up on drop, so no manual removal is needed.
        let out = fx.tmp.path().join(format!("profile-{mode:?}.sb"));
        std::fs::write(&out, profile).unwrap();
        out
    }

    /// `/bin/cat <path>` inside the cage.
    fn caged_cat(profile: &Path, path: &str) -> std::process::Output {
        Command::new("/usr/bin/sandbox-exec")
            .args(["-f".as_ref(), profile.as_os_str(), "/bin/cat".as_ref(), path.as_ref()])
            .output()
            .expect("spawn sandbox-exec cat")
    }

    /// `/usr/bin/nc -U -w1 <sock> </dev/null` inside the cage: exit 0 on a
    /// successful connect, non-zero when seatbelt refuses it.
    fn caged_connect(profile: &Path, sock: &str) -> std::process::Output {
        use std::process::Stdio;
        Command::new("/usr/bin/sandbox-exec")
            .args([
                "-f".as_ref(),
                profile.as_os_str(),
                "/usr/bin/nc".as_ref(),
                "-U".as_ref(),
                "-w1".as_ref(),
                sock.as_ref(),
            ])
            .stdin(Stdio::null())
            .output()
            .expect("spawn sandbox-exec nc")
    }

    #[test]
    fn caged_agent_cannot_read_the_cli_token_even_with_library_allowlisted() {
        if !cage_available() {
            return;
        }
        let fx = fixture();
        for mode in [SandboxMode::Enforce, SandboxMode::EnforceFs] {
            let profile = hostile_profile(&fx, mode);

            // Positive control: a sibling file under the SAME allow-listed
            // ancestor IS readable, proving the allow-list is live and the
            // final data-dir deny is what blocks the token.
            let ok = caged_cat(&profile, &fx.control_file);
            assert!(
                ok.status.success(),
                "{mode:?}: control file under the allow-listed ancestor should be readable; stderr={}",
                String::from_utf8_lossy(&ok.stderr)
            );

            // The token read must be refused.
            let denied = caged_cat(&profile, &fx.token_path);
            assert!(
                !denied.status.success(),
                "{mode:?}: reading the CLI token must be denied inside the cage"
            );
            // Absence assertion (the only kind the spec permits here): the
            // secret must not have leaked to stdout.
            assert!(
                !String::from_utf8_lossy(&denied.stdout).contains(&fx.secret),
                "{mode:?}: token secret leaked out of the cage"
            );
        }
    }

    #[test]
    fn caged_agent_cannot_connect_to_the_control_socket() {
        if !cage_available() {
            return;
        }
        let fx = fixture();
        for mode in [SandboxMode::Enforce, SandboxMode::EnforceFs] {
            let profile = hostile_profile(&fx, mode);

            // Positive control: an unrelated peer unix socket IS reachable,
            // proving unix sockets are allowed in general and only the
            // control-plane path is denied (last-match-wins, after the
            // broad unix-socket allow / EnforceFs's blanket allow).
            let ok = caged_connect(&profile, &fx.control_socket);
            assert!(
                ok.status.success(),
                "{mode:?}: a non-control unix socket should be connectable; stderr={}",
                String::from_utf8_lossy(&ok.stderr)
            );

            let denied = caged_connect(&profile, &fx.socket_path);
            assert!(
                !denied.status.success(),
                "{mode:?}: connect() to the control socket must be denied inside the cage"
            );
        }
    }

    #[test]
    fn caged_spawn_env_carries_no_token() {
        if !cage_available() {
            return;
        }
        let fx = fixture();
        // Guards the app-env invariant: pty_spawn copies the whole app env
        // into every caged child, so the token must live ONLY in the
        // server's memory, never in the process environment. We inherit
        // THIS process's env (the app-process stand-in) into the caged
        // `env` dump; the freshly-written token must not appear, because
        // nothing ever exported it. Absence-only assertion, per spec.
        let profile = hostile_profile(&fx, SandboxMode::Enforce);
        let out = Command::new("/usr/bin/sandbox-exec")
            .arg("-f")
            .arg(&profile)
            .arg("/usr/bin/env")
            .output()
            .expect("spawn env in cage");
        let env_dump = String::from_utf8_lossy(&out.stdout);
        assert!(
            !env_dump.contains(&fx.secret),
            "the CLI token must never reach a caged spawn's environment"
        );
        // And no token-shaped variable name exists either.
        for line in env_dump.lines() {
            let key = line.split('=').next().unwrap_or("");
            assert!(
                !(key.contains("TERMIC") && key.contains("TOKEN")),
                "a token-shaped env var reached the cage: {key}"
            );
        }
    }

    #[test]
    fn socket_deny_is_the_final_network_rule_in_both_enforcing_modes() {
        // Structural backstop to the behavioral tests: the deny for the
        // control socket must textually FOLLOW every network allow in both
        // enforcing branches (last-match-wins). Not a substitute for the
        // behavioral checks - a complement that pins the ordering.
        //
        // Inside a scratch data dir, and with the account named on the TASK,
        // because both of those were read off the host otherwise. `Task::
        // default()` plus no account sends `task_login_store` to the real
        // settings file, so whether the one legitimate post-deny allow below
        // got rendered depended on whether the machine running the test had a
        // default account configured for that agent: green on CI, which has
        // none, and red on a maintainer's Mac, which does.
        crate::test_support::with_scratch_data_dir(|_| {
        let fx = fixture();
        let control = ControlPlanePaths {
            data_dir: Some(fx.data_dir.clone()),
            socket: Some(fx.socket_path.clone()),
        };
        const ACCOUNT: &str = "Work";
        for (mode, agent) in
            [(SandboxMode::Enforce, "claude"), (SandboxMode::EnforceFs, "claude"), (SandboxMode::Enforce, "agy")]
        {
            let mut task = Task { cli: agent.into(), ..Default::default() };
            task.accounts.insert(agent.to_string(), ACCOUNT.into());
            let profile =
                render_profile_with(&task, 5, agent, &[], mode, &control).unwrap();
            let deny_tok = format!("(path-literal \"{}\")", sbpl_escape(&fx.socket_path));
            let deny_at = profile.find(&deny_tok).expect("socket deny must be present");
            // No network ALLOW may appear after the deny.
            let after = &profile[deny_at + deny_tok.len()..];
            assert!(
                !after.contains("(allow network"),
                "{mode:?}/{agent}: a network allow follows the socket deny (would make it inert)"
            );
            // The data-dir read deny is the last filesystem rule but ONE: the
            // task's own login store is re-opened after it on purpose (GH
            // #278), because the store lives inside the denied data dir and an
            // allow before the deny is inert. So the tail may hold exactly
            // that one allow and nothing else - a second one, or a broader
            // one, is a hole in the rule this whole block exists to hold.
            let dd_deny = format!("(deny file-read* (subpath \"{}\"))", sbpl_escape(&fx.data_dir));
            let dd_at = profile.find(&dd_deny).expect("data-dir read deny must be present");
            let tail = &profile[dd_at + dd_deny.len()..];
            // Rebased onto the fixture's data dir exactly as the profile does:
            // the store does not exist under a scratch data dir, so the
            // renderer takes its "rebase, do not canonicalize" branch.
            let raw = crate::login_store_dir(agent, Some(ACCOUNT), crate::LoginRealm::Host)
                .expect("a named account has a store").to_string_lossy().into_owned();
            let dd_raw = crate::global_dir().unwrap().to_string_lossy().into_owned();
            let store = raw.replacen(&dd_raw, &fx.data_dir, 1);
            assert!(store.starts_with(&fx.data_dir), "rebasing failed: {store}");
            assert_eq!(
                tail.matches("(allow file-").count(), 1,
                "{mode:?}/{agent}: the data-dir deny must be followed by exactly one file allow\n{tail}"
            );
            assert!(
                tail.contains(&format!("(allow file-read* file-write* (subpath \"{}\"))", sbpl_escape(&store))),
                "{mode:?}/{agent}: the one allow after the deny must be this task's own login store\n{tail}"
            );
        }
        });
    }

    // ─── Keychain block ──────────────────────────────────────────────────

    #[test]
    #[cfg(unix)]
    fn a_spawn_dir_is_read_only_to_its_agent_and_hidden_from_others() {
        if !cage_available() { return; }
        let mine = crate::broker::test_handle("t-cage-a", None);
        let other = crate::broker::test_handle("t-cage-b", None);
        let (my_dir, other_dir) = (mine.ro_paths[0].clone(), other.ro_paths[0].clone());
        let base_deny = format!("(deny file-read* file-write* (subpath \"{}\"))", crate::broker::spawn_base_dir().unwrap().display());
        let mut profile = keychain_profile(SandboxMode::EnforceFs, true);
        assert!(profile.contains(&base_deny), "{profile}");
        profile.push_str(&broker_profile_rules(&mine));
        let run = |profile: &str, args: &[&str]| {
            let f = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(f.path(), profile).unwrap();
            Command::new("/usr/bin/sandbox-exec").arg("-f").arg(f.path()).args(args).output().unwrap().status.success()
        };
        let cfg = |d: &str| format!("{d}/gh/config.yml");
        let sock = |d: &str| format!("{d}/gh.sock");
        // its own dir: readable, gh's config dir writable, the socket not removable.
        assert!(run(&profile, &["/bin/cat", &cfg(&my_dir)]));
        assert!(run(&profile, &["/usr/bin/touch", &format!("{my_dir}/gh/state.yml")]));
        assert!(!run(&profile, &["/bin/rm", &sock(&my_dir)]));
        assert!(std::path::Path::new(&sock(&my_dir)).exists());
        // another spawn's dir: neither readable nor writable.
        assert!(!run(&profile, &["/bin/cat", &cfg(&other_dir)]));
        assert!(!run(&profile, &["/bin/rm", &sock(&other_dir)]));
        // control: without the base deny the other dir is reachable, so the
        // deny is what stops it.
        assert!(run(&profile.replace(&base_deny, ""), &["/bin/cat", &cfg(&other_dir)]));
    }

    fn keychain_profile(mode: SandboxMode, block: bool) -> String {
        keychain_profile_with(mode, block, Vec::new())
    }

    fn keychain_profile_with(mode: SandboxMode, block: bool, rw: Vec<String>) -> String {
        let task = Task {
            cli: "claude".into(),
            path: "/tmp/kc-task".into(),
            sandbox_block_keychain: block,
            sandbox_rw_paths: rw,
            ..Default::default()
        };
        let control = ControlPlanePaths { data_dir: None, socket: None };
        render_profile_with(&task, 1, "claude", &[], mode, &control).unwrap()
    }

    #[test]
    fn keychain_block_renders_only_when_set_and_after_the_keychain_allow() {
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();
        let allow = format!("(allow file-write* (subpath \"{}/Library/Keychains\"))", sbpl_escape(&home));
        let deny = format!("(deny file-read* file-write* (subpath \"{}/Library/Keychains\"))", sbpl_escape(&home));
        for mode in [SandboxMode::Enforce, SandboxMode::EnforceFs] {
            let off = keychain_profile(mode, false);
            assert!(!off.contains(KEYCHAIN_MACH_DENY), "{mode:?}: no deny unless the task asks");
            assert!(!off.contains(&deny), "{mode:?}");

            let on = keychain_profile(mode, true);
            assert!(on.contains(KEYCHAIN_MACH_DENY), "{mode:?}: mach deny missing");
            assert!(on.contains(KEYCHAIN_FILE_DENY), "{mode:?}: keychain file deny missing");
            assert!(!off.contains(KEYCHAIN_FILE_DENY), "{mode:?}");
            // last match wins, so the deny is inert unless it follows the
            // runtime allow for the same dir.
            let (a, d) = (on.find(&allow).expect("runtime allow"), on.find(&deny).expect("dir deny"));
            assert!(d > a, "{mode:?}: dir deny must come after the runtime allow");
        }
        // Monitor never blocks.
        assert!(!keychain_profile(SandboxMode::Monitor, true).contains(KEYCHAIN_MACH_DENY));
        // Secure Transport needs SecurityServer for every TLS handshake.
        assert!(!KEYCHAIN_MACH_DENY.contains("com.apple.SecurityServer"), "denying SecurityServer breaks system curl and Apple git");
        // `/System/Volumes/Data` reaches every home dir, so all of `/System`
        // must never be exempt from the keychain file deny.
        assert!(!KEYCHAIN_FILE_DENY.contains("(subpath \"/System\")"), "exempt only the system keychain dirs");
    }

    #[test]
    fn keychain_block_cuts_off_the_keychain_in_the_cage() {
        if !cage_available() || !Path::new("/usr/bin/security").exists() {
            return;
        }
        // every probe reads a FAKE item from a throwaway keychain, never a
        // real secret. `security list-keychains` is no signal here: the
        // blocked cage still prints the login keychain's path, yet reads
        // from it find nothing (measured 2026-10-23, docs/sandbox.md).
        // create-keychain also puts each one on the user's search list, so
        // the guard takes it back off, panics included.
        struct Kc(PathBuf);
        impl Drop for Kc {
            fn drop(&mut self) { let _ = Command::new("/usr/bin/security").arg("delete-keychain").arg(&self.0).output(); }
        }
        fn make(path: PathBuf) -> Option<Kc> {
            let kc = Kc(path);
            let sec = |args: &[&str]| Command::new("/usr/bin/security").args(args).arg(&kc.0).output().is_ok_and(|o| o.status.success());
            (sec(&["create-keychain", "-p", "pw"]) && sec(&["unlock-keychain", "-p", "pw"])
                && sec(&["add-generic-password", "-a", "termic-probe", "-s", "termic-probe", "-w", "fake-s3cret"])).then_some(kc)
        }
        let caged = |profile: &str, args: &[&std::ffi::OsStr]| {
            let f = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(f.path(), profile).unwrap();
            Command::new("/usr/bin/sandbox-exec").arg("-f").arg(f.path()).args(args)
                .output().expect("spawn sandbox-exec")
        };
        let read = |profile: &str, kc: &Path| {
            let out = caged(profile, &["/usr/bin/security".as_ref(), "find-generic-password".as_ref(),
                "-s".as_ref(), "termic-probe".as_ref(), "-w".as_ref(), kc.as_os_str()]);
            String::from_utf8_lossy(&out.stdout).contains("fake-s3cret")
        };
        let blocked = keychain_profile(SandboxMode::EnforceFs, true);
        let home = dirs::home_dir().unwrap();
        let dir_deny = format!("(deny file-read* file-write* (subpath \"{}/Library/Keychains\"))",
                               sbpl_escape(&home.to_string_lossy()));
        let tmp = tempfile::tempdir().unwrap();

        // in ~/Library/Keychains, beside the login keychain. SecurityServer
        // is reachable in the block (Secure Transport needs it), so the
        // file denies are all that keep this out: the control proves it.
        let inside = home.join(format!("Library/Keychains/termic-probe-{}.keychain-db", std::process::id()));
        if let Some(kc) = make(inside) {
            let mach_only = blocked.replace(&dir_deny, "").replace(KEYCHAIN_FILE_DENY, "");
            assert!(read(&mach_only, &kc.0), "control: without the file denies the cage should read it");
            assert!(!read(&blocked, &kc.0), "blocked cage must not read a keychain in ~/Library/Keychains");
            // a hard link out under a non-keychain name would dodge both
            // denies, so the link itself has to be refused.
            let link = tmp.path().join("not-a-keychain.db");
            let ln = caged(&blocked, &["/bin/ln".as_ref(), kc.0.as_os_str(), link.as_os_str()]);
            assert!(!ln.status.success() && !link.exists(), "blocked cage must not hard-link a keychain out");
        }

        // outside ~/Library/Keychains, in a dir the cage can read (TMPDIR):
        // only KEYCHAIN_FILE_DENY keeps these out, in either case.
        for name in ["probe.keychain-db", "probe2.KEYCHAIN-DB"] {
            if let Some(kc) = make(tmp.path().join(name)) {
                assert!(read(&blocked.replace(KEYCHAIN_FILE_DENY, ""), &kc.0), "control: without the rule the cage should read {name}");
                assert!(!read(&blocked, &kc.0), "blocked cage must not read {name} outside ~/Library/Keychains");
            }
        }

        // the dir deny on its own: listing the keychain dir works open and
        // fails blocked.
        let ls = |profile: &str| {
            let f = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(f.path(), profile).unwrap();
            let home = dirs::home_dir().unwrap();
            Command::new("/usr/bin/sandbox-exec")
                .arg("-f").arg(f.path())
                .arg("/bin/ls").arg(home.join("Library/Keychains"))
                .output().expect("spawn sandbox-exec ls").status.success()
        };
        assert!(ls(&keychain_profile(SandboxMode::EnforceFs, false)), "unblocked cage should list the keychain dir");
        assert!(!ls(&blocked), "blocked cage must not list the keychain dir");

        // the data-protection keychain (secd), which `security` never
        // touches: a lookup of a missing item answers errSecItemNotFound
        // (-25300) when secd is reachable, anything else when it is not.
        // python's ctypes is the smallest Security.framework client on a
        // stock Mac; skip if it cannot run in the open cage.
        let dp = |profile: &str| -> Option<String> {
            let f = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(f.path(), profile).unwrap();
            let out = Command::new("/usr/bin/sandbox-exec")
                .arg("-f").arg(f.path())
                .args(["/usr/bin/python3", "-I", "-c", DP_PROBE])
                .output().ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        if dp(&keychain_profile(SandboxMode::EnforceFs, false)).as_deref() == Some("-25300") {
            assert_ne!(dp(&blocked).as_deref(), Some("-25300"), "blocked cage must not reach secd");
        }
    }

    /// `SecItemCopyMatching` against the data-protection keychain for an
    /// item that does not exist; prints the OSStatus.
    const DP_PROBE: &str = r#"
import ctypes as C
cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
sec = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
g = lambda lib, n: C.c_void_p.in_dll(lib, n).value
cf.CFStringCreateWithCString.restype = C.c_void_p
cf.CFStringCreateWithCString.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32]
cf.CFDictionaryCreate.restype = C.c_void_p
cf.CFDictionaryCreate.argtypes = [C.c_void_p, C.c_void_p, C.c_void_p, C.c_long, C.c_void_p, C.c_void_p]
sec.SecItemCopyMatching.argtypes = [C.c_void_p, C.c_void_p]
svc = cf.CFStringCreateWithCString(None, b"termic-probe-nonexistent", 0x08000100)
K = (C.c_void_p * 3)(g(sec, "kSecClass"), g(sec, "kSecAttrService"), g(sec, "kSecUseDataProtectionKeychain"))
V = (C.c_void_p * 3)(g(sec, "kSecClassGenericPassword"), svc, g(cf, "kCFBooleanTrue"))
d = cf.CFDictionaryCreate(None, K, V, 3,
    C.addressof(C.c_char.in_dll(cf, "kCFTypeDictionaryKeyCallBacks")),
    C.addressof(C.c_char.in_dll(cf, "kCFTypeDictionaryValueCallBacks")))
print(sec.SecItemCopyMatching(d, C.byref(C.c_void_p())))
"#;

    #[test]
    fn keychain_deny_is_the_last_file_rule_even_over_user_allows() {
        // hostile allow-list: an ancestor of the keychain dir, a regex over
        // it, and the dir itself. All render before the deny and lose.
        let rw = vec![
            "$HOME/Library".to_string(),
            "regex:^$HOME/Library/Key.*".to_string(),
            "$HOME/Library/Keychains".to_string(),
        ];
        for mode in [SandboxMode::Enforce, SandboxMode::EnforceFs] {
            let p = keychain_profile_with(mode, true, rw.clone());
            let deny = p.rfind("(deny file-read* file-write* (subpath ").expect("dir deny");
            let last_allow = p.rfind("(allow file-").expect("file allows");
            assert!(deny > last_allow, "{mode:?}: a file allow follows the keychain deny");
            // the any-path keychain file deny too, or a user allow on a dir
            // holding an unlocked keychain would hand it to the agent.
            let file_deny = p.rfind(KEYCHAIN_FILE_DENY).expect("keychain file deny");
            assert!(file_deny > last_allow, "{mode:?}: a file allow follows the keychain file deny");
        }
    }

    #[cfg(unix)] // builds its home with a unix symlink
    #[test]
    fn keychain_dirs_covers_the_resolved_path() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("real/Library/Keychains")).unwrap();
        let real = canonicalize_or_keep(&tmp.path().join("real").to_string_lossy());
        let link = tmp.path().join("home");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let home = link.to_string_lossy().into_owned();

        let dirs = keychain_dirs(&home);
        assert_eq!(dirs, vec![format!("{home}/Library/Keychains"), format!("{real}/Library/Keychains")]);
        // no symlink, no twin; a trailing slash does not double the separator.
        assert_eq!(keychain_dirs(&format!("{real}/")), vec![format!("{real}/Library/Keychains")]);
    }

    #[test]
    fn keychain_hold_counts_open_ptys_and_releases_on_drop() {
        let id = format!("kc-hold-{}", std::process::id());
        assert_eq!(keychain_open_count(&id), 0);
        let blocked = KeychainHold::new(&id, true);
        assert_eq!(keychain_open_count(&id), 0, "a blocked PTY registers nothing");
        let a = KeychainHold::new(&id, false);
        let b = KeychainHold::new(&id, false);
        assert_eq!(keychain_open_count(&id), 2);
        drop(a);
        assert_eq!(keychain_open_count(&id), 1);
        drop(b);
        drop(blocked);
        assert_eq!(keychain_open_count(&id), 0);
        assert!(!keychain_open().lock().unwrap().contains_key(&id), "entry removed at zero");
    }
}

#[cfg(test)]
mod watcher_tests {
    //! The shared path watcher: routing a pid to its task, the refcount
    //! that keeps ONE `log stream` for the app, and recording each line
    //! once. Counts only, no timings (docs/perf-ci.md).
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicUsize};

    const DENY: &str =
        "2026-06-07 20:39:36.008 Df kernel[0] (Sandbox) Sandbox: touch(500) deny(1) file-write-create /Users/u/Library/Application Support/x";
    const ALLOW: &str =
        "2026-06-07 20:39:36.008 Df kernel[0] (Sandbox) Sandbox: cat(500) allow file-read-data /Users/u/notes/deny(1).txt";

    fn cfg(path: &str) -> WatchedTask {
        WatchedTask { path: path.into(), ws_dirs: vec![], policy: MonitorPolicy::default() }
    }

    fn roots(rs: &[(u32, &str)]) -> HashMap<u32, Arc<str>> {
        rs.iter().map(|(p, t)| (*p, Arc::from(*t))).collect()
    }

    // 1 <- 100 (root of "a") <- 200 <- 300; 1 <- 400 (unrelated)
    fn tree(pid: u32) -> Option<u32> {
        match pid { 100 | 400 => Some(1), 200 => Some(100), 300 => Some(200), 900 => Some(900), _ => None }
    }

    /// A watcher whose "stream" is `true` (exits at once, nothing to leak)
    /// and a count of how many it started. `fail` makes every start fail.
    fn counted(fail: bool) -> (Watcher, Arc<AtomicUsize>) {
        let starts = Arc::new(AtomicUsize::new(0));
        let n = starts.clone();
        let w = Watcher::new(Box::new(move |_gen| {
            n.fetch_add(1, Ordering::Relaxed);
            if fail { None } else { std::process::Command::new("true").spawn().ok() }
        }));
        (w, starts)
    }

    #[test]
    fn owner_of_walks_to_the_registered_root() {
        let rs = roots(&[(100, "a"), (400_000, "b")]);
        assert_eq!(owner_of(100, &rs, tree, no_sid).as_deref(), Some("a"), "the root itself");
        assert_eq!(owner_of(300, &rs, tree, no_sid).as_deref(), Some("a"), "a grandchild");
        assert_eq!(owner_of(400, &rs, tree, no_sid), None, "unrelated, reaches launchd");
        assert_eq!(owner_of(777, &rs, tree, no_sid), None, "already exited");
        assert_eq!(owner_of(900, &rs, tree, no_sid), None, "self-parented loop");
        assert_eq!(owner_of(300, &HashMap::new(), tree, no_sid), None, "root unregistered");
    }

    fn no_sid(_: u32) -> Option<u32> { None }

    #[test]
    fn owner_of_falls_back_to_the_session_for_an_orphan() {
        // 400's parent exited, so it hangs off launchd but kept a's session.
        let rs = roots(&[(100, "a")]);
        let sid = |p: u32| match p { 400 => Some(100), 500 => Some(500), _ => None };
        assert_eq!(owner_of(400, &rs, tree, sid).as_deref(), Some("a"), "orphan in a's session");
        assert_eq!(owner_of(500, &rs, tree, sid), None, "its own session (setsid)");
        assert_eq!(owner_of(400, &HashMap::new(), tree, sid), None, "root unregistered");
    }

    #[test]
    fn pid_chain_names_the_peer_and_its_parents() {
        let exe = |p: u32| -> Option<String> {
            match p { 1 => Some("/sbin/launchd".into()), 100 => Some("/bin/zsh".into()), 300 => Some("/opt/bin/gh".into()), _ => None }
        };
        assert_eq!(pid_chain(300, tree, exe), "pid 300 /opt/bin/gh, parents: 200 ? < 100 zsh < 1 launchd");
        assert_eq!(pid_chain(400, tree, exe), "pid 400 (exited), parents: 1 launchd", "an orphan ends at launchd");
        assert_eq!(pid_chain(777, tree, exe), "pid 777 (exited)", "gone before the check");
        assert_eq!(pid_chain(900, tree, exe), "pid 900 (exited)", "self-parented loop stops");
    }

    #[test]
    fn owner_of_tells_two_tasks_apart() {
        let rs = roots(&[(100, "a"), (400, "b")]);
        assert_eq!(owner_of(300, &rs, tree, no_sid).as_deref(), Some("a"));
        assert_eq!(owner_of(400, &rs, tree, no_sid).as_deref(), Some("b"));
    }

    #[cfg(unix)]
    #[test]
    fn one_stream_for_every_task_and_mode_killed_with_the_last() {
        let (mut w, starts) = counted(false);
        assert!(w.attach("a", false, cfg("/a")));
        assert!(w.attach("a", false, cfg("/a")), "second PTY of a task");
        assert!(w.attach("b", true, cfg("/b")), "another task, other mode");
        assert_eq!(starts.load(Ordering::Relaxed), 1, "one stream for all three");
        assert!(w.detach("a", false).is_none());
        assert!(w.detach("b", true).is_none(), "`a` still has a PTY open");
        assert!(w.detach("a", true).is_none(), "a detach for a mode `a` doesn't hold changes nothing");
        assert!(w.task("a").is_some());
        reap(Some(w.detach("a", false).expect("the last hold hands back the stream")));
        assert!(w.attach("c", false, cfg("/c")), "after the last close, the next spawn restarts it");
        assert_eq!(starts.load(Ordering::Relaxed), 2);
        reap(w.detach("c", false));
    }

    #[test]
    fn a_stream_that_fails_to_start_records_no_hold() {
        let (mut w, starts) = counted(true);
        assert!(!w.attach("a", false, cfg("/a")));
        assert!(w.task("a").is_none(), "a failed attach must not leave a hold behind");
        assert!(!w.attach("a", false, cfg("/a")), "the next spawn retries");
        assert_eq!(starts.load(Ordering::Relaxed), 2);
    }

    #[cfg(unix)]
    #[test]
    fn a_stream_that_dies_is_replaced_while_ptys_hold_it() {
        let (mut w, starts) = counted(false);
        w.attach("a", false, cfg("/a"));
        let gen = w.gen;
        w.started = Instant::now().checked_sub(RESPAWN_MIN_LIFE * 2).unwrap();
        reap(Some(w.on_stream_exit(gen).expect("the dead stream comes back to reap")));
        assert_eq!(starts.load(Ordering::Relaxed), 2, "a PTY still holds it, so it restarts");
        assert!(w.child.is_some());
        assert!(w.on_stream_exit(gen).is_none(), "a stale reader can't touch the replacement");
        assert_eq!(starts.load(Ordering::Relaxed), 2);
        // dying right after a start is a crash loop: stop until a spawn asks
        reap(w.on_stream_exit(w.gen));
        assert_eq!(starts.load(Ordering::Relaxed), 2);
        assert!(w.child.is_none());
        assert!(w.attach("a", false, cfg("/a")));
        assert_eq!(starts.load(Ordering::Relaxed), 3);
        reap(w.detach("a", false));
        reap(w.detach("a", false));
    }

    #[cfg(unix)]
    #[test]
    fn mixed_modes_keep_their_own_holds_and_the_monitor_policy() {
        let (mut w, _) = counted(false);
        w.attach("a", true, cfg("/monitor"));
        w.attach("a", false, cfg("/enforce"));
        let h = w.task("a").unwrap();
        assert_eq!((h.enforce, h.monitor), (1, 1));
        assert_eq!(h.cfg.path, "/monitor", "an enforce spawn must not replace a live monitor policy");
        w.detach("a", true);
        let h = w.task("a").unwrap();
        assert_eq!((h.enforce, h.monitor), (1, 0), "closing the monitor PTY leaves the caged one counted");
        reap(w.detach("a", false));
    }

    /// Router over a fake tree whose ppid calls are counted: 1 <- 7100
    /// (root) <- 7200 <- 7300, and 7300's parent can be changed to stand
    /// in for a recycled pid (0 = exited).
    static RT_CALLS: AtomicUsize = AtomicUsize::new(0);
    static RT_PARENT_OF_7300: AtomicU32 = AtomicU32::new(7200);
    fn rt_tree(pid: u32) -> Option<u32> {
        RT_CALLS.fetch_add(1, Ordering::Relaxed);
        match pid {
            7100 | 7400 => Some(1),
            7200 => Some(7100),
            7300 => Some(RT_PARENT_OF_7300.load(Ordering::Relaxed)).filter(|p| *p != 0),
            _ => None,
        }
    }

    #[test]
    fn router_caches_and_revalidates() {
        let calls = || RT_CALLS.load(Ordering::Relaxed);
        let mut r = Router::new(rt_tree, |_| None, |_| None);
        register_root_pid("rt-a", 7100);
        assert_eq!(r.owner(7300).as_deref(), Some("rt-a"));
        let before = calls();
        assert_eq!(r.owner(7300).as_deref(), Some("rt-a"));
        assert_eq!(calls() - before, 1, "a hit re-reads only the pid's own parent, no walk");

        RT_PARENT_OF_7300.store(0, Ordering::Relaxed);
        assert_eq!(r.owner(7300).as_deref(), Some("rt-a"), "an exited pid keeps its answer");

        RT_PARENT_OF_7300.store(7400, Ordering::Relaxed);
        assert_eq!(r.owner(7300), None, "a pid recycled under another parent is re-routed");
        RT_PARENT_OF_7300.store(7200, Ordering::Relaxed);

        unregister_root_pid("rt-a", 7100);
        assert_eq!(r.owner(7300), None, "root gone");
        register_root_pid("rt-a", 7100);
        assert_eq!(r.owner(7300).as_deref(), Some("rt-a"), "a cached miss clears when a root registers");
        unregister_root_pid("rt-a", 7100);
    }

    /// Fixed answers for `dispatch_line`.
    struct Fixed(Option<&'static str>);
    impl Resolve for Fixed {
        fn owner(&mut self, _pid: u32) -> Option<Arc<str>> { self.0.map(Arc::from) }
        fn exe(&mut self, _pid: u32) -> Option<String> { Some("/opt/claude/versions/2.1.144".into()) }
    }

    /// Hold `id` in the app's watcher without starting a stream.
    fn hold(id: &str, enforce: usize, monitor: usize) {
        lock_watcher().tasks.insert(id.into(), Holds { cfg: Arc::new(cfg("/Users/u/task")), enforce, monitor });
    }
    fn release(id: &str) {
        lock_watcher().tasks.remove(id);
    }

    #[test]
    fn a_line_counts_once_however_many_ptys_the_task_has() {
        let id = "watcher-test-once";
        hold(id, 2, 0);
        dispatch_line(DENY, &mut Fixed(Some(id)));
        assert_eq!(path_deny_count(id), 1);
        release(id);
    }

    #[test]
    fn lines_go_to_the_mode_that_asked_for_them() {
        let (enf, mon) = ("watcher-test-enforce", "watcher-test-monitor");
        hold(enf, 1, 0);
        hold(mon, 0, 1);
        dispatch_line(ALLOW, &mut Fixed(Some(enf)));
        dispatch_line(DENY, &mut Fixed(Some(mon)));
        assert_eq!(path_deny_count(enf), 0, "an allow line is not a deny");
        assert_eq!(path_access_count(mon), 0, "a monitor task has no denies to record");
        // `deny(1)` in the allow line's PATH must not make it a deny
        dispatch_line(ALLOW, &mut Fixed(Some(mon)));
        assert_eq!(path_access_count(mon), 1);
        release(enf);
        release(mon);
    }

    #[test]
    fn a_task_with_both_modes_records_both() {
        // `task_set_sandbox(kill_live=false)` leaves a caged agent running
        // next to a monitored one; its denies must still count.
        let id = "watcher-test-mixed";
        hold(id, 1, 1);
        dispatch_line(DENY, &mut Fixed(Some(id)));
        dispatch_line(ALLOW, &mut Fixed(Some(id)));
        assert_eq!(path_deny_count(id), 1);
        assert_eq!(path_access_count(id), 1);
        release(id);
    }

    #[test]
    fn unowned_and_unwatched_lines_are_dropped() {
        let id = "watcher-test-unowned";
        dispatch_line(DENY, &mut Fixed(None));
        dispatch_line(DENY, &mut Fixed(Some(id)));
        assert_eq!(path_deny_count(id), 0, "a task with no open PTY records nothing");
    }

    #[test]
    fn a_versionlike_name_falls_back_to_the_executable_path() {
        let mut r = Fixed(None);
        assert_eq!(proc_name(Some("2.1.144".into()), 1, &mut r), "/opt/claude/versions/2.1.144");
        assert_eq!(proc_name(Some("touch".into()), 1, &mut r), "touch");
        assert_eq!(proc_name(None, 1, &mut r), "/opt/claude/versions/2.1.144");
    }
}
