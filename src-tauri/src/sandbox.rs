// macOS sandbox-exec (Seatbelt) wrapper for per-workspace agent isolation.
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
// workspace automatically - they're not seeded onto the saved Workspace
// record. The Project's `sandbox_*` arrays are user-owned EXTRAS only.
// This is the explicit contract: never seed defaults onto a Project at
// create time; always grow built-ins in code.
//
// Layered model:
//   1. Outer kernel sandbox via `sandbox-exec -f <profile.sb>` - blocks
//      writes outside the allowlist, blocks all network except a single
//      loopback hop to our in-process CONNECT proxy.
//   2. The native Rust proxy (see `crate::proxy`) filters that loopback
//      hop against a per-workspace hostname allowlist (regex per line).
//      Anything not allowed → 403.
//
// Both pieces live for the lifetime of the agent PTY: the profile is a
// fresh file under tempdir() with the workspace id; the proxy is an
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

use crate::Workspace;
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
    /// seatbelt deny events touching this workspace's path. Counts
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

// ─── Per-workspace path-deny tracker (mirror of proxy's net tracker) ──
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

/// Wipe the workspace's entire path-deny tracker. Called from
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

/// Drop every path-deny entry for this workspace whose path is at or
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
/// positive (counting other apps' denies under our workspace).
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
/// sandbox root PIDs for this workspace? Walks up to a depth of 20 to
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

/// Spawn `log stream` filtered to seatbelt denies for this workspace.
/// Parses stdout line-by-line, increments the per-path deny tracker.
/// Returns None if the child couldn't start - non-fatal, just means
/// no path counter for this workspace.
fn start_path_watcher(workspace_id: &str, workspace_path: &str) -> Option<PathWatcher> {
    use std::io::{BufRead, BufReader};
    use std::thread;

    // Predicate kept loose - some macOS versions tag seatbelt denies
    // under kernel/sandboxd, others under com.apple.libsandbox, others
    // don't tag at all. We match on "Sandbox:" in the message which is
    // present in every form, then filter further in the parser.
    let predicate = "eventMessage CONTAINS \"Sandbox:\" AND eventMessage CONTAINS \"deny\"";
    let mut child = Command::new("/usr/bin/log")
        .args(["stream", "--predicate", predicate, "--style", "compact"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let ws_id = workspace_id.to_string();
    let ws_path = workspace_path.to_string();
    let ws_id_dbg = ws_id.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
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

/// Build a fully-rendered SBPL profile for one workspace. Substitutes
/// $HOME / $WORKSPACE in any user-supplied paths, dedupes against the
/// built-in RW list, applies built-in deny rules AFTER the broad
/// `file-read*` allow so they take precedence. Reads extras from the
/// workspace's own frozen-at-creation arrays - project edits don't
/// reach back into already-created workspaces.
pub fn render_profile(workspace: &Workspace, proxy_port: u16, agent_override: Option<&str>) -> Result<String> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow!("no home dir"))?
        .to_string_lossy()
        .into_owned();
    let workspace_path = canonicalize_or_keep(&workspace.path);
    let subst = |p: &str| -> String {
        let p = p.trim();
        // Leading tilde expansion. ~/foo and ~ both reach the user's
        // home dir; ~user/foo (another user's home) is not supported
        // - too niche, treat as literal. Only the LEADING tilde is
        // touched so paths like `/somewhere/~bak` stay literal.
        let mut s = if p == "~" {
            home.clone()
        } else if let Some(rest) = p.strip_prefix("~/") {
            format!("{home}/{rest}")
        } else {
            p.to_string()
        };
        s = s.replace("$HOME", &home);
        s = s.replace("$WORKSPACE", &workspace_path);
        // Strip trailing slashes - SBPL's (subpath "...") matches by
        // string prefix, and "/Users/x/Downloads/" vs "/Users/x/Downloads"
        // produce different rule strings even though they resolve to
        // the same dir. Normalize to no-trailing-slash so users get
        // the same cage whether they typed it with or without.
        while s.len() > 1 && s.ends_with('/') {
            s.pop();
        }
        s
    };

    // The user's "Allowed paths" list - what they explicitly want
    // exposed to the agent. Workspace path is always implicitly here.
    // Field is still called sandbox_rw_paths for storage compat but
    // the meaning shifted: it's now the unified allow-list, not just
    // writes. UI presents it as "Allowed paths" (one textarea).
    let mut user_allowed: Vec<String> = vec![workspace_path.clone()];
    // Multi-repo workspaces: each composition member's resolved path
    // (worktree dir OR symlink target for RepoRoot mode) must be
    // explicitly allowed. Seatbelt evaluates canonical paths, so a
    // symlink under the wrapper alone wouldn't cover the live
    // checkout it points to — canonicalize each one to be safe.
    for m in &workspace.composition {
        let resolved = canonicalize_or_keep(&m.path);
        if !resolved.is_empty() { user_allowed.push(resolved); }
    }
    // ── Worktree's parent .git/ ─────────────────────────────────────
    // The workspace's path is a git worktree whose `.git` is a FILE
    // pointing to `<parent>/.git/worktrees/<name>/`. The `commondir`
    // metadata inside that points back to `<parent>/.git`, where the
    // shared objects + packed-refs live. ANY git operation (status,
    // fetch, commit, checkout) needs read+write on the parent's
    // .git/ — without it the worktree is non-functional. Detect by
    // reading the `.git` file; if it parses as `gitdir: …`, derive
    // the parent .git/ and add to the allow-list.
    //
    // Same for every multi-repo member that's a worktree.
    for ws_root in std::iter::once(workspace_path.as_str())
        .chain(workspace.composition.iter().map(|m| m.path.as_str()))
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
            let ws_esc   = regex::escape(&workspace_path);
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
    for p in &workspace.sandbox_rw_paths {
        split_regex(p, &mut user_allowed, &mut user_allowed_regexes);
    }
    dedupe(&mut user_allowed);
    dedupe(&mut user_allowed_regexes);

    // Per-agent allowed paths from the agent registry (Settings → Agents).
    // Each agent declares its own runtime/config dirs; these are joined
    // into the allow-list whenever that agent's CLI is launched in this
    // workspace. The user CANNOT remove them per-workspace — to drop an
    // entry they have to edit the agent (which affects every workspace
    // using that agent). settings_load is best-effort: if the file is
    // missing or corrupt, the registry falls back to seeded defaults via
    // crate::load_settings_inner, which still returns the three built-ins.
    let mut agent_allowed: Vec<String> = Vec::new();
    let mut agent_allowed_regexes: Vec<String> = Vec::new();
    let settings = crate::load_settings_inner();
    // Use the tab-specific agent override if the caller passed one
    // (multi-CLI workspaces); fall back to the workspace's primary CLI.
    let effective_cli = agent_override.unwrap_or(&workspace.cli);
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
    let runtime = builtin_runtime_paths(&home, &workspace_path);

    // ── Read-only system roots. MINIMUM set — binaries, dynamic
    //    linker, and basic syscall config. If a user genuinely needs
    //    to load a system-wide framework or read /Applications, they
    //    should disable the cage or add the exact subpath per
    //    workspace; the cage doesn't try to be transparent. Writes
    //    here are NEVER allowed.
    //
    //    Deliberately NOT included:
    //      /System (broad)       → firmlink-exposes user data; narrowed
    //                              to /System/Library + dyld cryptex.
    //      /Library              → every system-wide app's shared data
    //                              dir; user adds per-workspace if needed.
    //      /Applications         → headless CLI agents don't need this.
    //      /Library/Frameworks   → third-party frameworks; add per-ws.
    //
    //    /private/var/db                        → dyld cache (macOS 12)
    //    /System/Volumes/Preboot/Cryptexes      → dyld cache (macOS 13+)
    //    /System/Library                        → system frameworks
    let system_read_roots: &[&str] = &[
        // ── Binaries (macOS + Linux overlap) ──────────────────────────
        "/usr",
        "/opt",
        "/bin",
        "/sbin",
        // ── Devices + syscall config ──────────────────────────────────
        "/dev",
        "/private/etc",  // macOS: /etc is a symlink to /private/etc
        "/etc",          // Linux: /etc lives at the real path
        // ── Dynamic linker / loader ───────────────────────────────────
        // macOS dyld:
        "/System/Library",
        "/System/Volumes/Preboot/Cryptexes",  // macOS 13+ cryptex cache
        "/private/var/db",                    // macOS 12 dyld cache
        // Linux ld.so / glibc / musl:
        "/lib",
        "/lib32",
        "/lib64",
        "/libx32",
        // ── Linux runtime/state pseudo-filesystems ────────────────────
        // Required for `/proc/self/...`, `/sys/devices/...`,
        // `/run/systemd/resolve/...` etc. that tools read at startup.
        // No-op on macOS (paths don't exist); kept here so the same
        // constant is right when the Linux sandbox impl lands.
        "/proc",
        "/sys",
        "/run",
        // Windows is intentionally absent — its sandbox model is
        // AppContainer / Job Objects / integrity levels, not SBPL.
        // When that backend ships, it'll use its own allow-list.
    ];

    // Hardcoded secret denies (~/.ssh family). Default-on, always
    // applied LAST so allow-list entries can't accidentally re-expose
    // them. The user CAN explicitly override by listing the exact
    // secret path in their workspace allowed-paths list; parent
    // allow-list entries DON'T count — typing `$HOME` doesn't
    // re-expose ~/.ssh by mistake. Combined set of workspace + agent
    // allows is checked for the override.
    let all_allowed: HashSet<&String> = user_allowed.iter().chain(agent_allowed.iter()).collect();
    let secret_deny: Vec<String> = builtin_deny_paths(&home)
        .into_iter()
        .filter(|p| !all_allowed.contains(p))
        .collect();

    let mut out = String::with_capacity(4096);
    out.push_str(SBPL_HEADER);

    // ── File ops base: ALLOWLIST.
    //
    // SBPL_HEADER ships with `(deny default)` and no broad `(allow
    // file-read*)`. We then carve out only the paths the agent
    // actually needs. Reads and writes are both default-deny outside
    // the listed paths. Last-match-wins, so the secret denies at the
    // bottom override any allow-list entry under a sensitive parent.
    //
    // `file-read-metadata` + `file-test-existence` are broadly allowed
    // because `ls`, `stat`, `realpath`, and shell completion all rely
    // on them; denying makes paths look "missing" rather than denied,
    // which produces terrible UX without adding meaningful protection
    // (metadata leaks dir structure, not contents).
    out.push_str("\n;; --- File ops base (allowlist) ---\n");
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

    // ── Workspace + per-workspace user allows (read + write).
    out.push_str("\n;; --- Workspace + user allow-list (read + write) ---\n");
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

    // ── Per-agent allow-list (read + write). Joined from the agent
    //    registry; user can edit in Settings → Agents but not remove
    //    per-workspace.
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

    // ── Secret + personal-data denies — hardcoded, LAST so they
    //    win even when an allow-list entry would cover them. The
    //    .ssh/.aws/.gnupg/etc. set + Documents/Desktop/Downloads/
    //    Pictures/Music/Movies — never reachable regardless of
    //    allow-list config (unless the user typed the EXACT secret
    //    path into their workspace allow-list, in which case
    //    secret_deny excluded it above).
    out.push_str("\n;; --- Hardcoded secret denies (allowlist backstop) ---\n");
    for p in &secret_deny {
        out.push_str(&format!("(deny file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
        out.push_str(&format!("(deny file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
    }

    // ── Allow-list re-open under hard-deny parents. Same logic as
    //    before: clicking Allow on `$HOME/Library/Application
    //    Support/Arc/User Data` re-opens just that leaf so the rest
    //    of `.../Arc` (the deny parent) stays denied.
    let mut reopens: Vec<&String> = Vec::new();
    for u in user_allowed.iter().chain(agent_allowed.iter()) {
        for d in builtin_deny_paths(&home).iter() {
            if u.len() > d.len()
                && u.starts_with(d)
                && u.as_bytes().get(d.len()) == Some(&b'/')
            {
                reopens.push(u);
                break;
            }
        }
    }
    if !reopens.is_empty() {
        out.push_str("\n;; --- Allow-list re-opens (under hard-deny parents) ---\n");
        for u in &reopens {
            out.push_str(&format!("(allow file-read*  (subpath \"{}\"))\n", sbpl_escape(u)));
            out.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(u)));
        }
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

    let agent = agent_override.unwrap_or(&workspace.cli);
    if agent == "agy" {
        out.push_str("\n;; --- Antigravity: allow direct outbound connections to Google APIs ---\n");
        out.push_str("(allow network-outbound)\n");
    }

    Ok(out)
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
fn builtin_runtime_paths(home: &str, workspace_path: &str) -> Vec<String> {
    vec![
        workspace_path.to_string(),
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
        // breaks in a sandboxed workspace.
        format!("{home}/.npm"),
        format!("{home}/.cache"),
        format!("{home}/.cargo/registry"),
        // Rustup writes ~/.cargo/env — a tiny shell-source file that
        // adds ~/.cargo/bin to PATH. Sourced by every zsh that starts
        // in a workspace if the user has rustup installed. NOT
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
        // interpreters, and package stores here: uv (Python interps
        // — venv shims symlink in, so denying breaks dyld with
        // "file system sandbox blocked open()" on libpython load),
        // pipx, pnpm store, mise/asdf/rtx shims, fnm, JetBrains
        // configs, etc. Per-tool allowlisting is endless. On macOS
        // this dir is essentially unused by the OS, and the real
        // secret stores (~/.ssh, ~/.aws, ~/.gnupg, ~/.netrc,
        // ~/Library/Keychains) live elsewhere + are hard-denied.
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
        // Claude). User can add more per workspace if needed.
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
        // ssh known_hosts is read by every git/gh fetch. Not a secret
        // (just trust fingerprints); the secret keys are in ~/.ssh/
        // which stays hard-denied. We allow JUST the file, not the dir.
        format!("{home}/.ssh/known_hosts"),
    ]
}

/// Hard-deny set for secret material. These ALWAYS apply, even if the
/// user listed them in `sandbox_rw_paths` - last-write-wins in SBPL
/// means the deny rules below cancel any prior allow.
fn builtin_deny_paths(home: &str) -> Vec<String> {
    vec![
        // ── Credentials / secrets at rest (plaintext on disk) ──────
        format!("{home}/.ssh"),
        format!("{home}/.aws"),
        format!("{home}/.gnupg"),
        format!("{home}/.netrc"),
        format!("{home}/.docker/config.json"),
        format!("{home}/.kube"),
        format!("{home}/.config/gh/hosts.yml"),
        // ── Personal data the agent has NO business touching ───────
        // Writes were broadly allowed because the Bun TUI in claude
        // hangs when ANY write target EPERMs (months-long bisect
        // notes in render_profile above). Compensating: explicit
        // deny on the high-value targets the user actually cares
        // about. Both read AND write get blocked - "the agent can't
        // see my ~/Downloads, let alone overwrite it."
        format!("{home}/Documents"),
        format!("{home}/Desktop"),
        format!("{home}/Downloads"),
        format!("{home}/Movies"),
        format!("{home}/Pictures"),
        format!("{home}/Music"),
        // ── Communications app data (Mail, Messages, Calendars) ────
        format!("{home}/Library/Mail"),
        format!("{home}/Library/Messages"),
        format!("{home}/Library/Calendars"),
        format!("{home}/Library/Containers/com.apple.mail"),
        format!("{home}/Library/Containers/com.apple.iCal"),
        // ── Browser data (cookies, history, saved passwords) ───────
        format!("{home}/Library/Safari"),
        format!("{home}/Library/Cookies"),
        format!("{home}/Library/Application Support/Firefox"),
        format!("{home}/Library/Application Support/Google/Chrome"),
        format!("{home}/Library/Application Support/BraveSoftware"),
        format!("{home}/Library/Application Support/Arc"),
        // ── Shell histories often contain secrets (export X=y, etc) ─
        format!("{home}/.zsh_history"),
        format!("{home}/.bash_history"),
        format!("{home}/.local/share/fish"),
        // NOTE: ~/Library/Keychains is NOT in this list. The Keychain
        // DB is encrypted at rest; the gatekeeper is securityd over
        // Mach. Denying the file did nothing useful and broke claude's
        // OAuth read path. Real Keychain protection would require
        // denying mach-lookup on com.apple.securityd, which kills TLS.
    ]
}

/// True iff this OS supports the sandbox at all. macOS-only because
/// the implementation uses sandbox-exec (Apple's Seatbelt frontend).
/// Linux + Windows return false; the frontend uses this to grey out
/// the toggle and show "unavailable on your OS." `provision()` also
/// short-circuits on non-macOS so a missed UI check can't crash the
/// agent spawn.
pub fn available() -> bool {
    cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/sandbox-exec").exists()
}

/// Default host allowlist (regex per line) for a workspace, keyed off
/// the agent it runs. We add the API endpoints for that agent's vendor
/// plus a baseline of stuff every dev needs (github + popular package
/// registries). Workspace's own `sandbox_allowed_hosts` are appended.
/// The output is the file contents (with leading comment); use
/// `host_patterns` if you just want the regexes for feeding to the
/// proxy.
#[allow(dead_code)]
pub fn render_filter(workspace: &Workspace) -> String {
    render_filter_for(workspace, None)
}

pub fn render_filter_for(workspace: &Workspace, agent_override: Option<&str>) -> String {
    let mut hosts: Vec<String> = Vec::new();
    let effective_cli = agent_override.unwrap_or(&workspace.cli);

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

    // Workspace-specific extras layered on top (seeded from project
    // at create time, frozen onto the workspace from then on). Users
    // type these as wildcards (`*.example.com`, `bitbucket.org`)
    // because regex is friction for a config screen - we translate to
    // anchored regex here so the proxy's matcher (which is regex-only)
    // sees a uniform format.
    hosts.extend(workspace.sandbox_allowed_hosts.iter().map(|w| wildcard_to_regex(w)));

    dedupe(&mut hosts);
    let mut out = String::from("# Generated by termic sandbox for workspace ");
    out.push_str(&workspace.id);
    out.push('\n');
    for h in &hosts {
        out.push_str(h);
        out.push('\n');
    }
    out
}

/// Extract just the host regex patterns from a workspace's allowlist.
/// Same default set as `render_filter` (which keeps the on-disk debug
/// file), minus the comment header - this is what we feed to the
/// in-process proxy at start time.
#[allow(dead_code)]
pub fn host_patterns(workspace: &Workspace) -> Vec<String> {
    host_patterns_for(workspace, None)
}

pub fn host_patterns_for(workspace: &Workspace, agent_override: Option<&str>) -> Vec<String> {
    render_filter_for(workspace, agent_override)
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
pub fn provision(workspace: &Workspace, agent_override: Option<&str>) -> Result<SandboxBundle> {
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
    clear_path_denies(&workspace.id);
    crate::proxy::clear_network_denies(&workspace.id);
    let tmp = std::env::temp_dir();
    let profile_path = tmp.join(format!("termic-sandbox-{}.sb", workspace.id));
    let filter_path  = tmp.join(format!("termic-proxy-{}.filter", workspace.id));

    // Filter file is purely for the user's `cat` benefit now; the proxy
    // gets its patterns from memory below. Best-effort write.
    let _ = fs::write(&filter_path, render_filter_for(workspace, agent_override));

    let patterns = host_patterns_for(workspace, agent_override);
    dlog(&format!("[sandbox/{}] provisioning, {} host patterns", workspace.id, patterns.len()));
    let path_watcher = start_path_watcher(&workspace.id, &canonicalize_or_keep(&workspace.path));
    if path_watcher.is_some() {
        dlog(&format!("[sandbox/{}] path-deny watcher started", workspace.id));
    }
    let proxy = match proxy::start(patterns, workspace.id.clone()) {
        Ok(p) => {
            dlog(&format!("[sandbox/{}] proxy up on port {}", workspace.id, p.port));
            Some(p)
        }
        Err(e) => {
            dlog(&format!("[sandbox/{}] proxy failed to start: {e}", workspace.id));
            None
        }
    };
    let port = proxy.as_ref().map(|p| p.port).unwrap_or(0);

    let profile = render_profile(workspace, port, agent_override)?;
    fs::write(&profile_path, &profile)
        .with_context(|| format!("write {}", profile_path.display()))?;
    dlog(&format!("[sandbox/{}] profile written: {}", workspace.id, profile_path.display()));

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
    // useful when the user pastes their workspace's CLAUDE.md /
    // AGENTS.md a note like:
    //   "If $TERMIC_SANDBOX=1 and you hit EPERM on a write, the path
    //    isn't on the workspace's writable list. Tell the user to
    //    add it via the Sandbox dialog or disable the cage."
    new_args.push("TERMIC_SANDBOX=1".into());
    new_args.push("TERMIC_SANDBOX_HELP=Filesystem EPERM on paths outside the workspace = blocked by Termic sandbox, not by macOS TCC. Network 403 with header `X-Termic-Sandbox: blocked-by-allowlist` = same cause. Fix: open the Sandbox dialog (shield icon on the workspace) and add the path/host, or disable the cage.".into());
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

/// Result of one curl probe inside the workspace's sandbox.
#[derive(serde::Serialize, Clone)]
pub struct ProbeResult {
    pub host: String,
    pub expected: &'static str,   // "allow" | "deny"
    pub ok: bool,                 // did the actual outcome match `expected`?
    pub http_code: Option<u16>,
    pub note: String,             // human-readable summary
}

/// End-to-end self-test for a workspace's sandbox: runs `curl` inside
/// the cage against one host we expect to succeed (vendor API) and one
/// we expect to fail (a non-listed host). Confirms both the seatbelt
/// profile AND host allowlist are doing their jobs. Use from the
/// WorkspaceSandboxDialog "Test" button so users don't have to take
/// the cage on faith.
pub fn run_self_test(workspace: &Workspace) -> Vec<ProbeResult> {
    // Provision a fresh ephemeral bundle just for the test. We can't
    // reuse the live agent's bundle (race), and this way the user
    // can run the test even with no agent running. Bundle's Drop
    // tears down the proxy thread when this function returns.
    let bundle = match provision(workspace, None) {
        Ok(b) => b,
        Err(e) => return vec![
            ProbeResult {
                host: "—".into(), expected: "allow", ok: false,
                http_code: None, note: format!("could not provision sandbox: {e}"),
            },
        ],
    };

    // Pick an allowed host that's in the per-CLI baseline so the test
    // matches what the actual agent would experience. github.com is
    // in the baseline for every CLI.
    let allowed = "https://api.github.com";
    // A host that nothing in our baseline allows. example.com is a
    // standards-blessed reserved domain - safe to ping, won't match
    // any of our regexes.
    let denied  = "https://example.com";

    vec![
        probe(&bundle, allowed, "allow"),
        probe(&bundle, denied,  "deny"),
    ]
}

fn probe(bundle: &SandboxBundle, url: &str, expected: &'static str) -> ProbeResult {
    let proxy_url = bundle.proxy.as_ref().map(|p| format!("http://127.0.0.1:{}", p.port));
    // Run via sandbox-exec so the seatbelt + proxy combo is what we're
    // actually testing. 5s timeout - curl with a denied host should
    // hang on the proxy's 403 (instant) or get killed quickly anyway.
    let mut cmd = Command::new("sandbox-exec");
    cmd.arg("-f").arg(&bundle.profile_path).arg("env");
    if let Some(ref pu) = proxy_url {
        cmd.arg(format!("http_proxy={pu}"));
        cmd.arg(format!("https_proxy={pu}"));
        cmd.arg(format!("HTTP_PROXY={pu}"));
        cmd.arg(format!("HTTPS_PROXY={pu}"));
    }
    cmd.arg("curl")
        .arg("-sS")                       // silent except errors
        .arg("--max-time").arg("5")
        .arg("-o").arg("/dev/null")
        .arg("-w").arg("%{http_code}\n")
        .arg(url);

    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => return ProbeResult {
            host: url.into(), expected, ok: false, http_code: None,
            note: format!("spawn failed: {e}"),
        },
    };
    // curl writes "000" to %{http_code} when it never got any response
    // (connection refused / TLS handshake aborted / DNS denied). Treat
    // both a parse failure AND Some(0) as "no response" - earlier code
    // happily reported `Some(0)` as a "denied host got through" because
    // 0 parses fine but isn't a real HTTP code.
    let parsed: Option<u16> = String::from_utf8_lossy(&out.stdout)
        .trim().parse().ok();
    let code: Option<u16> = match parsed { Some(0) => None, x => x };
    let denied_by_proxy = code == Some(403);
    let succeeded = matches!(code, Some(200..=399));

    // curl's actual error text (Connection refused, Could not resolve,
    // TLS handshake failure, ...) - the most useful diagnostic when
    // the cage is misconfigured. -sS makes curl silent EXCEPT on
    // errors, which land here.
    let stderr_msg = String::from_utf8_lossy(&out.stderr)
        .trim().lines().last().unwrap_or("").to_string();
    let with_stderr = |base: String| -> String {
        if stderr_msg.is_empty() { base } else { format!("{base}  ⟵ {stderr_msg}") }
    };

    let (ok, note) = match expected {
        "allow" => {
            if succeeded { (true, format!("HTTP {} (OK)", code.unwrap_or(0))) }
            else {
                let what = code.map(|c| format!("HTTP {c}"))
                    .unwrap_or_else(|| "no response".into());
                (false, with_stderr(format!("{what} — expected 2xx/3xx")))
            }
        }
        _ /* deny */ => {
            if denied_by_proxy { (true, "HTTP 403 (proxy blocked, as expected)".into()) }
            // No response at all: kernel deny or proxy killed the
            // connection. Either way the host was blocked - this is
            // the success case for a deny probe, not a failure.
            else if code.is_none() {
                (true, "no response (blocked at proxy or kernel layer)".into())
            }
            else { (false, format!("HTTP {} — denied host got through! check allowlist", code.unwrap())) }
        }
    };
    ProbeResult { host: url.into(), expected, ok, http_code: code, note }
}

/// Query macOS `log` for recent sandbox denials touching a workspace.
/// Filters by:
///   - subsystem/sender: sandboxd / kernel (where Seatbelt logs land)
///   - last N minutes
///   - eventMessage containing the workspace path (so users only see
///     denials caused by their own agent, not noise from other apps)
/// Returns lines in newest-first order. Empty Vec on any failure -
/// debugging shouldn't itself fail.
pub fn recent_denials(workspace_path: &str, minutes: u32) -> Vec<String> {
    let predicate = format!(
        "(sender == \"kernel\" OR sender == \"sandboxd\") AND eventMessage CONTAINS \"deny\" AND eventMessage CONTAINS \"{}\"",
        // The path goes inside a quoted literal in the predicate; we
        // escape both backslashes and embedded double-quotes
        // defensively. macOS paths don't contain quotes in practice
        // but it costs nothing to be safe.
        workspace_path.replace('\\', "\\\\").replace('"', "\\\""),
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
;; (subpath "...")) entries for the workspace, agent, runtime, and
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

/// If `workspace_root` is a git worktree (its `.git` is a regular file
/// with `gitdir: <path>`), return the parent repo's `.git/` directory
/// so the cage can allow reads+writes against it. Returns None when
/// the workspace is the parent checkout itself (is_repo_root) or not
/// a git working tree at all.
///
/// Logic:
///   1. Read `<workspace_root>/.git`.
///   2. Expect `gitdir: <abs path to /<parent>/.git/worktrees/<name>>`.
///   3. Walk up to `<parent>/.git` (i.e. trim `/worktrees/<name>` suffix).
///   4. Canonicalize and return.
fn parent_git_dir_for_worktree(workspace_root: &str) -> Option<String> {
    let dot_git = std::path::Path::new(workspace_root).join(".git");
    // For a regular checkout (is_repo_root), `.git` is a directory and
    // we don't need to widen — the workspace allow already covers it
    // via the workspace path subpath. We only act for the file-form.
    let meta = fs::metadata(&dot_git).ok()?;
    if !meta.is_file() { return None; }
    let contents = fs::read_to_string(&dot_git).ok()?;
    let line = contents.lines().find(|l| l.starts_with("gitdir:"))?;
    let raw_gitdir = line.trim_start_matches("gitdir:").trim();
    // gitdir may be relative to the worktree root; resolve.
    let gitdir_abs = if std::path::Path::new(raw_gitdir).is_absolute() {
        raw_gitdir.to_string()
    } else {
        std::path::Path::new(workspace_root).join(raw_gitdir).to_string_lossy().into_owned()
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

    // ── builtin_deny_paths ───────────────────────────────────────────

    #[test]
    fn deny_paths_contain_ssh() {
        let home = "/Users/test";
        let paths = builtin_deny_paths(home);
        assert!(paths.contains(&format!("{home}/.ssh")));
    }

    #[test]
    fn deny_paths_contain_aws() {
        let home = "/Users/test";
        let paths = builtin_deny_paths(home);
        assert!(paths.contains(&format!("{home}/.aws")));
    }

    #[test]
    fn deny_paths_contain_browsers() {
        let home = "/Users/test";
        let paths = builtin_deny_paths(home);
        assert!(paths.contains(&format!("{home}/Library/Application Support/Google/Chrome")));
        assert!(paths.contains(&format!("{home}/Library/Application Support/Arc")));
    }

    #[test]
    fn deny_paths_no_keychains() {
        // Keychains is intentionally NOT denied (encrypted DB, securityd gate).
        let home = "/Users/test";
        let paths = builtin_deny_paths(home);
        assert!(!paths.contains(&format!("{home}/Library/Keychains")));
    }
}
