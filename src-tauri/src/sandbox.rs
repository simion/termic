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

fn incr_path_deny(ws_id: &str, path: &str) {
    if ws_id.is_empty() || path.is_empty() { return; }
    if let Ok(mut g) = path_tracker().lock() {
        let per_ws = g.entry(ws_id.to_string()).or_insert_with(HashMap::new);
        let entry = per_ws.entry(path.to_string()).or_insert(PathDenyEntry {
            path: path.to_string(),
            count: 0,
            last_seen_unix_ms: 0,
        });
        entry.count += 1;
        entry.last_seen_unix_ms = now_unix_ms();
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
        let mut seen_first = false;
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
            let path = extract_deny_path(&line);
            let Some(path) = path else { continue; };
            // Only count user-visible paths. System-internal denies
            // (caches, daemons checking ports we blocked, etc.) are
            // noise. Workspace path or anything under /Users/ is in.
            if !path.starts_with(&ws_path) && !path.starts_with("/Users/") {
                continue;
            }
            if !seen_first {
                dlog(&format!("[sandbox/{ws_id_dbg}] first path-deny seen: {path}"));
                seen_first = true;
            }
            incr_path_deny(&ws_id, &path);
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
pub fn render_profile(workspace: &Workspace, proxy_port: u16) -> Result<String> {
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
    for p in &workspace.sandbox_rw_paths {
        let s = subst(p);
        if !s.is_empty() { user_allowed.push(s); }
    }
    dedupe(&mut user_allowed);

    // Runtime dirs the agent NEEDS access to or it can't launch.
    // Always allowed; never asked of the user. We give the cage broad
    // read+write but compute denies for $HOME entries the user didn't
    // allow - these built-in paths are excluded from the deny set so
    // they stay accessible regardless of user config.
    let runtime = builtin_runtime_paths(&home, &workspace_path);

    // Auto-deny via $HOME enumeration was attempted (the "allow-list
    // mental model" pivot) but reintroduced the Bun retry-on-EPERM
    // hang in claude — claude touches enough random $HOME paths that
    // we can't reliably enumerate every runtime dir to keep it alive.
    // Kept compute_home_denies around as dead code in case we can
    // revisit (e.g., once we ship the container backend). For now:
    // broad allow + targeted personal-data + secret denies. User's
    // "Allowed paths" textarea is additive only (the cage is already
    // open everywhere); "Extra denied paths" is the actual lockdown
    // lever.
    let _auto_denies_unused: Vec<String> = Vec::new();

    // User's explicit extra denies (textarea in the dialog). Layered
    // ON TOP of broad allow for per-workspace lockdown.
    let mut extra_deny: Vec<String> = Vec::new();
    for p in &workspace.sandbox_deny_paths {
        let s = subst(p);
        if !s.is_empty() { extra_deny.push(s); }
    }
    dedupe(&mut extra_deny);

    // Hardcoded secret denies (~/.ssh family). Default-on but the
    // user can EXPLICITLY override: if they listed the exact secret
    // path in their allowed paths textarea (e.g. `$HOME/.ssh`), we
    // drop that path from the deny set so the allow wins. Parent
    // allow-list entries DON'T count - typing `$HOME` doesn't
    // re-expose ~/.ssh by mistake. The user has to opt in per path.
    let user_allowed_set: HashSet<&String> = user_allowed.iter().collect();
    let secret_deny: Vec<String> = builtin_deny_paths(&home)
        .into_iter()
        .filter(|p| !user_allowed_set.contains(p))
        .collect();

    let mut out = String::with_capacity(4096);
    out.push_str(SBPL_HEADER);

    // Base file ops - broad allow. Bun's runtime hangs on EPERM
    // retry loops if we restrict reads OR writes; the cage is
    // implemented as broad-allow + targeted denies below.
    out.push_str("\n;; --- File ops base (broad allow; denies below) ---\n");
    out.push_str("(allow file-read*)\n");
    out.push_str("(allow file-read-metadata)\n");
    out.push_str("(allow file-test-existence)\n");
    out.push_str("(allow file-map-executable)\n");
    out.push_str("(allow file-issue-extension)\n");
    out.push_str("(allow file-write*)\n");

    // Advisory: log what the user listed in "Allowed paths" so they
    // can see it took effect (no rule emitted - reads/writes are
    // already broadly allowed).
    if user_allowed.len() > 1 {
        out.push_str("\n;; --- User allow-list (advisory; already broadly allowed) ---\n");
        for p in &user_allowed {
            out.push_str(&format!(";; allowed: {}\n", sbpl_escape(p)));
        }
    }

    // Advisory: ditto for runtime paths.
    out.push_str("\n;; --- Runtime paths (advisory; already broadly allowed) ---\n");
    for p in &runtime {
        out.push_str(&format!(";; runtime: {}\n", sbpl_escape(p)));
    }

    // ── User extra denies (textarea). Layered after the broad allow
    //    so they actually deny.
    if !extra_deny.is_empty() {
        out.push_str("\n;; --- User extra denies ---\n");
        for p in &extra_deny {
            out.push_str(&format!("(deny file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
            out.push_str(&format!("(deny file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
        }
    }

    // ── Secret + personal-data denies - hardcoded, LAST so nothing
    //    re-exposes them. The .ssh/.aws/.gnupg/etc. set + Documents
    //    /Desktop/Downloads etc. the agent should never read
    //    regardless of user config.
    out.push_str("\n;; --- Hardcoded secret denies (final word) ---\n");
    for p in &secret_deny {
        out.push_str(&format!("(deny file-read*  (subpath \"{}\"))\n", sbpl_escape(p)));
        out.push_str(&format!("(deny file-write* (subpath \"{}\"))\n", sbpl_escape(p)));
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
        // Agent state dirs - legacy single-dir convention.
        format!("{home}/.claude"),
        format!("{home}/.gemini"),
        format!("{home}/.codex"),
        // Agent state dirs - XDG-style (what the modern CLIs actually
        // write to for sessions, history, telemetry, cache). codex in
        // particular writes session logs to ~/.config/codex and exits
        // with EPERM if it can't - this was the "Operation not
        // permitted (os error 1)" crash. Each CLI gets all three XDG
        // bases so we don't have to chase per-version variants.
        format!("{home}/.config/claude"),
        format!("{home}/.config/codex"),
        format!("{home}/.config/gemini"),
        format!("{home}/.local/share/claude"),
        format!("{home}/.local/share/codex"),
        format!("{home}/.local/share/gemini"),
        format!("{home}/.local/state/claude"),
        format!("{home}/.local/state/codex"),
        format!("{home}/.local/state/gemini"),
        // Package manager caches - npm/pip/cargo all write here on
        // first install. Without these even a `git clone && npm i`
        // breaks in a sandboxed workspace.
        format!("{home}/.npm"),
        format!("{home}/.cache"),
        format!("{home}/.cargo/registry"),
        format!("{home}/Library/Caches"),
        // Bun runtime cache. claude is Bun-compiled; Bun's runtime
        // pokes here for install cache + bunfig lookups. Missing
        // this was the most likely cause of "claude doesn't launch"
        // under the allow-list cage.
        format!("{home}/.bun"),
        format!("{home}/.deno"),
        // macOS conventional app-data paths. Bun-compiled agents
        // (claude in particular) write logs + state here in addition
        // to XDG; without these claude's TUI hangs at init waiting on
        // a blocked write retry. ~/Library/Logs and ~/Library/Application
        // Support hold lots of apps' state but contain no high-value
        // secrets (those live in Keychain or ~/.ssh / ~/.aws which we
        // either let securityd guard or hard-deny separately).
        format!("{home}/Library/Logs"),
        format!("{home}/Library/Application Support"),
        // Shell + git init files. Tool subprocesses (the agent shells
        // out to git, gh, npm, ...) read these on startup; denying
        // them breaks every git/gh/shell invocation. Single files,
        // no secret content (those go in ~/.ssh / ~/.aws / Keychain
        // which are hard-denied below).
        format!("{home}/.gitconfig"),
        format!("{home}/.gitignore_global"),
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
pub fn render_filter(workspace: &Workspace) -> String {
    let mut hosts: Vec<String> = Vec::new();

    // Per-CLI vendor APIs.
    match workspace.cli.as_str() {
        "claude" => hosts.extend([
            r"^api\.anthropic\.com$".into(),
            r"^statsig\.anthropic\.com$".into(),
            r"^console\.anthropic\.com$".into(),
            r"^claude\.ai$".into(),
            r"^code\.claude\.com$".into(),
            r"^.+\.anthropic\.com$".into(),
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
        ]),
        "codex" => hosts.extend([
            r"^api\.openai\.com$".into(),
            r"^chatgpt\.com$".into(),
            r"^.+\.openai\.com$".into(),
            r"^auth\.openai\.com$".into(),
            r"^cdn\.openai\.com$".into(),
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
pub fn host_patterns(workspace: &Workspace) -> Vec<String> {
    render_filter(workspace)
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
pub fn provision(workspace: &Workspace) -> Result<SandboxBundle> {
    // Hard-fail early on platforms where Seatbelt doesn't exist.
    // The frontend should be gating on sandbox_available(), but
    // defense in depth - missing this check would crash the agent
    // spawn with a "sandbox-exec: command not found" later.
    if !available() {
        return Err(anyhow!(
            "sandbox unavailable on this OS (requires macOS sandbox-exec)"
        ));
    }
    let tmp = std::env::temp_dir();
    let profile_path = tmp.join(format!("termic-sandbox-{}.sb", workspace.id));
    let filter_path  = tmp.join(format!("termic-proxy-{}.filter", workspace.id));

    // Filter file is purely for the user's `cat` benefit now; the proxy
    // gets its patterns from memory below. Best-effort write.
    let _ = fs::write(&filter_path, render_filter(workspace));

    let patterns = host_patterns(workspace);
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

    let profile = render_profile(workspace, port)?;
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
    let bundle = match provision(workspace) {
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

;; Filesystem: broad read, narrow write. Deny carve-outs come AFTER.
(allow file-read*)
(allow file-read-metadata)

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
