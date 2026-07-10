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
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

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
    /// `log stream` child process tailing macOS unified log for
    /// seatbelt deny events touching this task's path. Counts
    /// per-path go into PATH_DENY_TRACKER (queryable via
    /// `path_deny_count` / `path_deny_list`). None when log stream
    /// couldn't start. Killed on Drop.
    #[allow(dead_code)]
    pub path_watcher: Option<PathWatcher>,
}

pub struct PathWatcher {
    child: Child,
}
impl Drop for PathWatcher {
    fn drop(&mut self) {
        // log stream doesn't catch SIGTERM cleanly on macOS in some
        // versions; SIGKILL is fine - it's a passive reader.
        let _ = self.child.kill();
        let _ = self.child.wait();
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
    if let Some(a) = settings.agents.iter().find(|a| a.id == effective_cli) {
        for p in &a.sandbox_allowed_paths {
            collect(p, &mut rw_subpaths, &mut rw_regexes);
        }
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

/// Drop every path-deny entry for this task whose path is at or
/// under `prefix`. Called after the user clicks "Allow" on a path so
/// the historical deny rows actually disappear from the popover —
/// without this, the in-memory tracker keeps the entry around and the
/// row sticks even though future accesses succeed.
// ─── PID ancestry tracker ────────────────────────────────────────────
//
// The path-deny watcher subscribes to a system-wide log predicate, so
// without filtering it picks up EVERY sandboxed process on the Mac
// (Finder hitting iCloud, browser sandboxes, Spotlight indexer, ...).
// The fix: only count denies whose process is a descendant of one of
// the PIDs we spawned under our sandbox. Each pty_spawn registers its
// child PID here; the watcher walks the kernel PPID chain for every
// deny and accepts only matches.

static SANDBOX_PIDS: OnceLock<Mutex<HashMap<String, HashSet<u32>>>> = OnceLock::new();

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
}

/// Read PPID for a live PID via `/bin/ps`. Returns None if the process
/// already exited (most likely for short-lived helpers); the watcher
/// treats that as "not ours" — false negative is preferred over false
/// positive (counting other apps' denies under our task).
fn ppid_of(pid: u32) -> Option<u32> {
    let out = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "ppid="])
        .output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u32>().ok()
}

/// Authoritative process name for a PID via `/bin/ps`. Used to back-fill
/// the popover's per-row "what tried to access this?" indicator when the
/// log-line parse turns up a weird/empty/version-only string. Returns
/// None if the process is already gone.
fn comm_of(pid: u32) -> Option<String> {
    let out = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Is `pid` (or any ancestor up to launchd) one of our registered
/// sandbox root PIDs for this task? Walks up to a depth of 20 to
/// guard against pathological pid loops (shouldn't happen on macOS).
pub fn is_our_sandboxed_pid(ws_id: &str, mut pid: u32) -> bool {
    if pid == 0 { return false; }
    let our_pids: HashSet<u32> = match sandbox_pids().lock() {
        Ok(g) => g.get(ws_id).cloned().unwrap_or_default(),
        Err(_) => return false,
    };
    if our_pids.is_empty() { return false; }
    for _ in 0..20 {
        if our_pids.contains(&pid) { return true; }
        if pid <= 1 { return false; }
        match ppid_of(pid) {
            Some(p) if p != pid => pid = p,
            _ => return false,
        }
    }
    false
}

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

/// Spawn `log stream` filtered to seatbelt denies for this task.
/// Parses stdout line-by-line, increments the per-path deny tracker.
/// Returns None if the child couldn't start - non-fatal, just means
/// no path counter for this task.
fn start_path_watcher(task_id: &str, task_path: &str, ws_dirs: Vec<String>, monitor: bool, policy: MonitorPolicy) -> Option<PathWatcher> {
    use std::io::{BufRead, BufReader};
    use std::thread;

    // ENFORCING: tail seatbelt DENY events. MONITORING: the profile is
    // `(allow default (with report))`, so the kernel logs every ALLOWED
    // file op instead — tail those (scoped to file ops to keep the
    // firehose down; the PID-ancestry + /Users path filters do the rest).
    // Predicate kept loose - some macOS versions tag seatbelt events
    // under kernel/sandboxd, others under com.apple.libsandbox, others
    // don't tag at all. We match on "Sandbox" in the message which is
    // present in every form, then filter further in the parser.
    let predicate = if monitor {
        "eventMessage CONTAINS \"Sandbox\" AND eventMessage CONTAINS \" allow \" AND eventMessage CONTAINS \"file-\""
    } else {
        "eventMessage CONTAINS \"Sandbox:\" AND eventMessage CONTAINS \"deny\""
    };
    let mut child = Command::new("/usr/bin/log")
        .args(["stream", "--predicate", predicate, "--style", "compact"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let ws_id = task_id.to_string();
    let ws_path = task_path.to_string();
    let ws_id_dbg = ws_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        // Per-pid caches. MONITORING's `(allow default (with report))` is a
        // system-wide firehose; without caching, every line would shell out
        // to /bin/ps up to 20× (ancestry) + once (comm). A pid's ancestry
        // and name are fixed for its lifetime, so we look them up once. (pid
        // reuse within a monitoring session is negligible.)
        let mut ours_cache: HashMap<u32, bool> = HashMap::new();
        let mut comm_cache: HashMap<u32, String> = HashMap::new();
        for line in reader.lines().flatten() {
            // MONITORING: parse ALLOW lines into the access tracker and
            // skip the deny parsing below entirely.
            if monitor {
                handle_monitor_line(&line, &ws_id, &ws_id_dbg, &ws_path, &ws_dirs, &policy, &mut ours_cache, &mut comm_cache);
                continue;
            }
            // Sample deny line on macOS 15 (Sequoia):
            //   2026-05-18 ...  Sandbox: openssl(12345) deny(1) file-write-create /Users/x/Pictures/ccc.txt
            //
            // Older macOS variants:
            //   ... Sandbox: <proc>/<thread> deny(1) <op> <path>
            //
            // We look for the operation token (`file-` or `network-`)
            // and treat everything after it as the path. Falls back to
            // the first absolute-path prefix in the line if no op token
            // is present.
            if !line.contains("deny") { continue; }
            // Reject false positives BEFORE path extraction. The log
            // predicate is system-wide ("Sandbox: ... deny") so we'd
            // otherwise pick up Finder, Spotlight, every other sandboxed
            // app on the Mac. Parse the PID and check PPID ancestry —
            // only denies from our spawned PTYs (or their descendants)
            // count.
            let pid = extract_deny_pid(&line);
            let Some(pid) = pid else { continue; };
            if !is_our_sandboxed_pid(&ws_id, pid) { continue; }
            let path = extract_deny_path(&line);
            let Some(path) = path else { continue; };
            // Belt-and-suspenders: even after the PID check, ignore
            // any path outside /Users/ — system caches etc.
            if !path.starts_with(&ws_path) && !path.starts_with("/Users/") {
                continue;
            }
            // Prefer the log-parsed proc name; if it looks like a bare
            // version string (claude logs itself as `claude 2.1.144`
            // and some formatters strip the leading word), fall back to
            // `ps -p X -o comm=` for the authoritative kernel name.
            let parsed = extract_deny_proc(&line).unwrap_or_default();
            let looks_versionlike = !parsed.is_empty()
                && parsed.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-');
            let proc = if parsed.is_empty() || looks_versionlike {
                comm_of(pid).unwrap_or_else(|| if parsed.is_empty() { "?".into() } else { parsed.clone() })
            } else {
                parsed
            };
            let op = extract_deny_op(&line).unwrap_or_else(|| "?".into());
            // Log EVERY deny — not just the first — so users can audit
            // exactly which process is hitting which path AND what kind
            // of access was attempted (file-read-data vs file-write-data
            // vs file-test-existence …). The op token tells you whether
            // claude is *reading* a browser config (privacy concern) or
            // just stat()-ing to check if it exists.
            dlog(&format!("[sandbox/{ws_id_dbg}] DENY {proc}({pid}) {op} {path}"));
            incr_path_deny(&ws_id, &path, pid, &proc);
        }
        dlog(&format!("[sandbox/{ws_id_dbg}] path-deny watcher exited"));
    });
    Some(PathWatcher { child })
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
    line: &str, ws_id: &str, ws_id_dbg: &str, ws_path: &str, ws_dirs: &[String], policy: &MonitorPolicy,
    ours_cache: &mut HashMap<u32, bool>,
    comm_cache: &mut HashMap<u32, String>,
) {
    let Some((pid, dup)) = monitor_pid_and_dup(line) else { return; };
    // Bound the caches: a long session spawning many short-lived pids
    // would otherwise grow them unboundedly. Clearing is cheap (rebuilt
    // lazily) and pids are small.
    if ours_cache.len() >= 8192 { ours_cache.clear(); }
    if comm_cache.len() >= 8192 { comm_cache.clear(); }
    // Cached ancestry check — avoids the up-to-20 /bin/ps spawns per line.
    let is_ours = *ours_cache.entry(pid).or_insert_with(|| is_our_sandboxed_pid(ws_id, pid));
    if !is_ours { return; }
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
    let parsed = extract_allow_proc(line).unwrap_or_default();
    let looks_versionlike = !parsed.is_empty()
        && parsed.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-');
    let proc = if parsed.is_empty() || looks_versionlike {
        // Cached comm lookup — avoids a /bin/ps spawn per line.
        let comm = comm_cache.entry(pid).or_insert_with(|| comm_of(pid).unwrap_or_default()).clone();
        if !comm.is_empty() { comm } else if !parsed.is_empty() { parsed } else { "?".into() }
    } else { parsed };
    let _ = ws_id_dbg;
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
fn subst_path(raw: &str, home: &str, task_path: &str) -> String {
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

pub fn render_profile(task: &Task, proxy_port: u16, agent_override: Option<&str>, mode: SandboxMode) -> Result<String> {
    // MONITORING: allow everything but ask the kernel to REPORT every
    // operation (so the path watcher can log it), while still forcing
    // all network through the logging proxy. The would-block decision is
    // computed app-side (MonitorPolicy), not by the kernel.
    if mode == SandboxMode::Monitor {
        return Ok(render_monitor_profile(proxy_port, agent_override.unwrap_or(&task.cli)));
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
    // using that agent). settings_load is best-effort: if the file is
    // missing or corrupt, the registry falls back to seeded defaults via
    // crate::load_settings_inner, which still returns the three built-ins.
    let mut agent_allowed: Vec<String> = Vec::new();
    let mut agent_allowed_regexes: Vec<String> = Vec::new();
    let settings = crate::load_settings_inner();
    // Use the tab-specific agent override if the caller passed one
    // (multi-CLI tasks); fall back to the task's primary CLI.
    let effective_cli = agent_override.unwrap_or(&task.cli);
    if let Some(a) = settings.agents.iter().find(|a| a.id == effective_cli) {
        for p in &a.sandbox_allowed_paths {
            split_regex(p, &mut agent_allowed, &mut agent_allowed_regexes);
        }
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

    if mode == SandboxMode::EnforceFs {
        // FILESYSTEM-ONLY ENFORCE: the file cage above is identical to
        // ENFORCE, but the network sandbox is deliberately disabled —
        // full network access, no loopback-to-proxy pinning (provision()
        // doesn't start a proxy in this mode, so proxy_port is 0 / unused).
        // This is the whole point of the mode: isolate the filesystem,
        // leave egress to the user's own controls.
        out.push_str("\n;; --- Network: UNRESTRICTED (filesystem-only enforce) ---\n");
        out.push_str("(allow network*)\n");
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

    let agent = agent_override.unwrap_or(&task.cli);
    if agent == "agy" {
        out.push_str("\n;; --- Antigravity: allow direct outbound connections to Google APIs ---\n");
        out.push_str("(allow network-outbound)\n");
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
        // sandboxed spawn. File contents are encrypted; access is
        // gated by macOS's per-item ACL via securityd regardless of
        // file-level reads.
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
    cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/sandbox-exec").exists()
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
    let effective_cli = agent_override.unwrap_or(&task.cli);

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
pub fn provision(task: &Task, agent_override: Option<&str>, mode: SandboxMode) -> Result<SandboxBundle> {
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
    let path_watcher = start_path_watcher(&task.id, &canonicalize_or_keep(&task.path), ws_dirs, monitor, policy);
    if path_watcher.is_some() {
        dlog(&format!("[sandbox/{}] path {} watcher started", task.id, if monitor { "access" } else { "deny" }));
    }
    // EnforceFs disables the network sandbox entirely: no proxy, no
    // hostname allow-list, no http_proxy injection (wrap_command only
    // injects it when `proxy` is Some). The seatbelt profile allows all
    // network directly. Every other mode runs the filtering/logging proxy.
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

    let profile = render_profile(task, port, agent_override, mode)?;
    fs::write(&profile_path, &profile)
        .with_context(|| format!("write {}", profile_path.display()))?;
    dlog(&format!("[sandbox/{}] profile written: {}", task.id, profile_path.display()));

    Ok(SandboxBundle { profile_path, filter_path, proxy, path_watcher })
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
    // Self-identifying env so agents (and tools they spawn) can map
    // EPERM filesystem errors and 403 X-Termic-Sandbox responses back
    // to "I'm in a Termic cage" instead of guessing macOS TCC. Most
    // useful when the user pastes their task's CLAUDE.md /
    // AGENTS.md a note like:
    //   "If $TERMIC_SANDBOX=1 and you hit EPERM on a write, the path
    //    isn't on the task's writable list. Tell the user to
    //    add it via the Sandbox dialog or disable the cage."
    new_args.push("TERMIC_SANDBOX=1".into());
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
    let out = Command::new("log")
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
fn canonicalize_or_keep(p: &str) -> String {
    fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string())
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
fn parent_git_dir_for_worktree(task_root: &str) -> Option<String> {
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
}
